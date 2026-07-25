import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';
import { dedupeJobs, updateJobStatus } from '../src/jobs.js';
import { createApplicationPacket, attestApplicationSubmitted } from '../src/packets.js';
import { seedW02Workspace } from './fixtures/w02-seed.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-producers-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function feedback(decision, referenceId) {
  return {
    schema: 'jobos.job-feedback-input.v1',
    decision,
    reasonCodes: ['role_fit'],
    signals: [],
    publicExplanation: '',
    privateNote: 'SQLite-only private note',
    referenceId,
    occurredAt: '2026-07-25T12:00:00.000Z',
  };
}

const MUTATION_TABLES = [
  'jobs', 'applications', 'application_receipts', 'status_changes', 'tasks',
  'audit_log', 'career_memory_observations',
];

function mirrorSnapshot(root) {
  const workspaceRoot = path.join(root, 'jobos-workspace');
  const entries = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else entries[path.relative(workspaceRoot, absolute)] = readFileSync(absolute, 'utf8');
    }
  }
  if (statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) visit(workspaceRoot);
  return entries;
}

function mutationSnapshot(store, root) {
  return {
    tables: Object.fromEntries(MUTATION_TABLES.map(table => [table, all(store, `SELECT * FROM ${table} ORDER BY rowid`)])),
    mirrors: mirrorSnapshot(root),
  };
}

function assertZeroDelta(store, root, before) {
  assert.deepEqual(mutationSnapshot(store, root), before);
}

function assertCode(fn, code) {
  assert.throws(fn, error => error?.code === code);
}

async function newJob(t, suffix) {
  const store = await openStore({ workspace: workspace(t) });
  t.after(() => store.db.close());
  const base = one(store, 'SELECT * FROM jobs WHERE profile_id=? ORDER BY id LIMIT 1', ['alpha']);
  const row = { ...base, id: `job_w08_producer_${suffix}`, status: 'new', url: `jobos:test:${suffix}` };
  const columns = Object.keys(row);
  guardedWrite(store, () => run(store, `INSERT INTO jobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column])));
  return { store, job: one(store, 'SELECT * FROM jobs WHERE id=?', [row.id]) };
}

test('W08 producers: save and skip atomically append canonical job feedback observations', async t => {
  const saved = await newJob(t, 'saved');
  const savedResult = updateJobStatus(saved.store, saved.job.id, 'saved', {
    actor: 'user',
    source: 'cli',
    memoryFeedback: feedback('save', 'save-producer-reference'),
  });
  assert.equal(savedResult.status, 'saved');
  const savedAudit = one(saved.store, "SELECT * FROM audit_log WHERE action='job.status_changed' AND entity_id=? ORDER BY rowid DESC LIMIT 1", [saved.job.id]);
  const savedObservation = one(saved.store, 'SELECT * FROM career_memory_observations WHERE profile_id=? AND reference_id=?', ['alpha', 'save-producer-reference']);
  assert.equal(savedObservation.event_type, 'job_saved');
  assert.equal(savedObservation.source_version_id, savedAudit.id);
  assert.equal(savedObservation.private_note, 'SQLite-only private note');

  const skipped = await newJob(t, 'skipped');
  const skippedResult = updateJobStatus(skipped.store, skipped.job.id, 'archived', {
    actor: 'user',
    source: 'cli',
    memoryFeedback: feedback('skip', 'skip-producer-reference'),
  });
  assert.equal(skippedResult.status, 'archived');
  const skippedObservation = one(skipped.store, 'SELECT * FROM career_memory_observations WHERE profile_id=? AND reference_id=?', ['alpha', 'skip-producer-reference']);
  assert.equal(skippedObservation.event_type, 'job_skipped');
  assert.equal(all(skipped.store, 'SELECT * FROM career_memory_observations WHERE source_entity_id=?', [skipped.job.id]).length, 1);
});

test('W08 producers: application attestation records and replays receipt-backed feedback', async t => {
  const fixture = await seedW02Workspace(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const input = feedback('apply', 'apply-producer-reference');
  const first = attestApplicationSubmitted(fixture.store, {
    packetId: packet.id, submittedAt: input.occurredAt, source: 'cli', memoryFeedback: input,
  });
  assert.equal(first.observation.eventType, 'job_applied');
  assert.equal(first.observation.sourceEntity.versionId, first.receiptId);
  assert.equal(one(fixture.store, 'SELECT status FROM applications WHERE id=?', [fixture.application.id]).status, 'applied');
  const beforeReplay = mutationSnapshot(fixture.store, fixture.root);
  const replay = attestApplicationSubmitted(fixture.store, {
    packetId: packet.id, submittedAt: input.occurredAt, source: 'cli', memoryFeedback: input,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.observation.id, first.observation.id);
  assertZeroDelta(fixture.store, fixture.root, beforeReplay);
});

test('W08 producers: exact save replay returns the same observation with zero deltas and conflict rejects', async t => {
  const { store, job } = await newJob(t, 'saved-replay');
  const root = store.p.root;
  const input = feedback('save', 'save-replay-reference');
  const first = updateJobStatus(store, job.id, 'saved', { actor: 'user', source: 'cli', memoryFeedback: input });
  const observation = one(store, 'SELECT * FROM career_memory_observations WHERE reference_id=?', [input.referenceId]);
  assert.equal(first.observation.id, observation.id);

  const beforeReplay = mutationSnapshot(store, root);
  const replay = updateJobStatus(store, job.id, 'saved', { actor: 'user', source: 'cli', memoryFeedback: input });
  assert.equal(replay.observation.id, observation.id);
  assert.equal(replay.observation.idempotent, true);
  assertZeroDelta(store, root, beforeReplay);

  const conflict = { ...input, privateNote: 'conflicting private note' };
  assertCode(() => updateJobStatus(store, job.id, 'saved', { actor: 'user', source: 'cli', memoryFeedback: conflict }), 'memory_reference_conflict');
  assertZeroDelta(store, root, beforeReplay);
});

test('W08 producers: archived skip replay is idempotent and conflicting feedback has zero deltas', async t => {
  const { store, job } = await newJob(t, 'archived-replay');
  const root = store.p.root;
  const input = feedback('skip', 'skip-replay-reference');
  const first = updateJobStatus(store, job.id, 'archived', { actor: 'user', source: 'cli', memoryFeedback: input });
  const beforeReplay = mutationSnapshot(store, root);
  const replay = updateJobStatus(store, job.id, 'archived', { actor: 'user', source: 'cli', memoryFeedback: input });
  assert.equal(replay.observation.id, first.observation.id);
  assert.equal(replay.observation.idempotent, true);
  assertZeroDelta(store, root, beforeReplay);

  assertCode(() => updateJobStatus(store, job.id, 'archived', {
    actor: 'user', source: 'cli', memoryFeedback: { ...input, reasonCodes: ['location'] },
  }), 'memory_reference_conflict');
  assertZeroDelta(store, root, beforeReplay);
});

test('W08 producers: dedupe archival cannot synthesize feedback or mutate on a later skip attempt', async t => {
  const { store, job } = await newJob(t, 'dedupe-archival');
  const primary = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND id<>? ORDER BY created_at,id LIMIT 1', [job.profile_id, job.id]);
  guardedWrite(store, () => run(store, 'UPDATE jobs SET dedupe_key=? WHERE id=?', [primary.dedupe_key, job.id]));
  dedupeJobs(store, { apply: true });
  assert.equal(one(store, 'SELECT status FROM jobs WHERE id=?', [job.id]).status, 'archived');
  const before = mutationSnapshot(store, store.p.root);
  assertCode(() => updateJobStatus(store, job.id, 'archived', {
    actor: 'user', source: 'cli', memoryFeedback: feedback('skip', 'dedupe-skip-reference'),
  }), 'memory_source_state_invalid');
  assertZeroDelta(store, store.p.root, before);
});

test('W08 producers: application feedback conflict rejects with zero receipt lifecycle memory audit or mirror deltas', async t => {
  const fixture = await seedW02Workspace(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const input = feedback('apply', 'apply-conflict-reference');
  const first = attestApplicationSubmitted(fixture.store, {
    packetId: packet.id, submittedAt: input.occurredAt, source: 'cli', memoryFeedback: input,
  });
  const beforeConflict = mutationSnapshot(fixture.store, fixture.root);
  assertCode(() => attestApplicationSubmitted(fixture.store, {
    packetId: packet.id,
    submittedAt: input.occurredAt,
    source: 'cli',
    memoryFeedback: { ...input, publicExplanation: 'conflicting feedback' },
  }), 'memory_reference_conflict');
  assert.equal(one(fixture.store, 'SELECT id FROM career_memory_observations WHERE reference_id=?', [input.referenceId]).id, first.observation.id);
  assertZeroDelta(fixture.store, fixture.root, beforeConflict);
});

test('W08 producers: malformed and foreign job signals reject with explicit zero deltas', async t => {
  const { store, job } = await newJob(t, 'invalid-signals');
  const root = store.p.root;
  for (const [signal, code] of [
    [{ field: 'unknown', polarity: 'prefer', value: 'x', match: 'exact' }, 'memory_enum_invalid'],
    [{ field: 'role_family', polarity: 'prefer', value: 'foreign role', match: 'exact' }, 'memory_signal_source_mismatch'],
  ]) {
    const before = mutationSnapshot(store, root);
    assertCode(() => updateJobStatus(store, job.id, 'saved', {
      source: 'cli',
      memoryFeedback: { ...feedback('save', `invalid-${code}`), signals: [signal] },
    }), code);
    assertZeroDelta(store, root, before);
  }
});
