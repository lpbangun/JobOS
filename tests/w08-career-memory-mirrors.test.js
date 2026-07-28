import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';
import { recordJobFeedback, syncMemoryObservations } from '../src/career-memory-observations.js';
import { refreshMemoryProjection } from '../src/career-memory-projections.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const AS_OF = new Date('2026-07-25T12:00:00.000Z');
const PRIVATE_SENTINEL = 'PRIVATE_MIRROR_SENTINEL_DO_NOT_EXPORT';
const ALIAS_TOKEN = /(^|\n)\s*[&*][A-Za-z0-9_-]+/;

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-mirrors-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function memoryPath(root, file) {
  return path.join(root, 'jobos-workspace', 'profiles', 'alpha', 'memory', file);
}

function bytes(file) {
  return readFileSync(file, 'utf8');
}

function seedPrivateObservation(store) {
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' AND status='saved' ORDER BY id LIMIT 1");
  return recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: job.id,
    input: {
      schema: 'jobos.job-feedback-input.v1',
      decision: 'save',
      reasonCodes: ['role_fit'],
      signals: [],
      publicExplanation: '',
      privateNote: PRIVATE_SENTINEL,
      referenceId: 'w08-mirror-private-observation',
      occurredAt: '2026-07-24T10:00:00.000Z',
    },
    actor: 'user',
    source: 'cli',
  });
}

test('W08-MIRROR-01 observation mirror is deterministic, attributable, alias-free, and private-note-free', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const observation = seedPrivateObservation(store);
  const file = memoryPath(root, 'observations.yaml');
  assert.equal(existsSync(file), true);
  const first = bytes(file);
  const document = YAML.parse(first);
  assert.equal(document.schema, 'jobos.career-memory-observation-list.v1');
  assert.equal(document.profileId, 'alpha');
  assert.equal(document.policy.canonicalStore, 'sqlite');
  assert.equal(document.policy.externalSideEffects, 'none');
  const mirrored = document.history.find(item => item.id === observation.id);
  assert.ok(mirrored, 'exact observation ID is source-readable');
  assert.deepEqual(mirrored.reasonCodes, ['role_fit']);
  assert.equal(mirrored.sourceEntity.id, observation.sourceEntity.id);
  assert.equal(mirrored.sourceEntity.versionId, observation.sourceEntity.versionId);
  assert.equal(mirrored.hasPrivateNote, true);
  assert.equal(first.includes(PRIVATE_SENTINEL), false);
  assert.equal(first.includes('privateNote:'), false);
  assert.doesNotMatch(first, ALIAS_TOKEN);
  syncMemoryObservations(store, 'alpha');
  assert.equal(bytes(file), first);
  store.db.close();
});

test('W08-MIRROR-02 persisted brief and guide mirrors are byte-stable, source-readable, and current-only', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  seedPrivateObservation(store);
  const brief = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  const guide = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'voice_positioning_guide', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  const files = [
    'career-brief.yaml',
    'career-brief.md',
    'voice-positioning-guide.yaml',
    'voice-positioning-guide.md',
  ].map(file => memoryPath(root, file));
  const before = Object.fromEntries(files.map(file => [file, bytes(file)]));
  assert.equal(YAML.parse(before[files[0]]).sourceStateHash, brief.sourceStateHash);
  assert.equal(YAML.parse(before[files[2]]).sourceStateHash, guide.sourceStateHash);
  assert.match(before[files[1]], new RegExp(`Revision: ${brief.revision}`));
  assert.match(before[files[3]], new RegExp(`Revision: ${guide.revision}`));
  for (const content of Object.values(before)) {
    assert.equal(content.includes(PRIVATE_SENTINEL), false);
    assert.doesNotMatch(content, ALIAS_TOKEN);
  }
  const briefReplay = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  const guideReplay = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'voice_positioning_guide', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  assert.deepEqual(briefReplay, brief);
  assert.deepEqual(guideReplay, guide);
  assert.deepEqual(Object.fromEntries(files.map(file => [file, bytes(file)])), before);
  store.db.close();
});

test('W08-MIRROR-03 regeneration comes from SQLite and keeps historical revisions out of current mirrors', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const first = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  guardedWrite(store, () => {
    const profile = one(store, "SELECT preferences_json FROM profiles WHERE id='alpha'");
    const preferences = JSON.parse(profile.preferences_json);
    preferences.locations = ['Remote', 'Boston'];
    run(store, 'UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [
      JSON.stringify(preferences), '2026-07-25T11:00:00.000Z', 'alpha',
    ]);
  });
  const second = refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: AS_OF, actor: 'user', source: 'cli',
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(second.sourceStateHash, first.sourceStateHash);
  const currentYaml = bytes(memoryPath(root, 'career-brief.yaml'));
  const currentMarkdown = bytes(memoryPath(root, 'career-brief.md'));
  assert.equal(YAML.parse(currentYaml).revision, 2);
  assert.match(currentMarkdown, /Revision: 2/);
  assert.doesNotMatch(currentMarkdown, /Revision: 1/);
  const revisions = all(store, `SELECT revision,document_json FROM career_memory_projection_revisions
    WHERE profile_id='alpha' AND projection_type='career_brief' ORDER BY revision`);
  assert.deepEqual(revisions.map(item => item.revision), [1, 2]);
  assert.equal(JSON.parse(revisions[0].document_json).sourceStateHash, first.sourceStateHash);
  assert.equal(JSON.parse(revisions[1].document_json).sourceStateHash, second.sourceStateHash);
  store.db.close();
});
