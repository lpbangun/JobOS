import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';
import { updateJobStatus } from '../src/jobs.js';
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
  const replay = attestApplicationSubmitted(fixture.store, {
    packetId: packet.id, submittedAt: input.occurredAt, source: 'cli', memoryFeedback: input,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.observation.id, first.observation.id);
});
