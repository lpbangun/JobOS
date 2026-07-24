import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { all, one, openStore } from '../src/db.js';
import * as interview from '../src/interview.js';

const require = createRequire(import.meta.url);
const fixturePath = path.resolve('tests/fixtures/w07-schema13.sqlite');
const W07_TABLES = Object.freeze([
  'interview_debrief_revisions',
  'interview_debriefs',
  'interview_pack_items',
  'interview_question_sources',
  'interview_stories',
  'interview_story_field_evidence',
  'interview_story_revisions',
]);
const PROTECTED_TABLES = Object.freeze([
  'profiles',
  'proof_points',
  'jobs',
  'applications',
  'status_changes',
  'artifacts',
  'application_packets',
  'application_receipts',
  'outreach_outcomes',
  'tasks',
]);
const REQUIRED_INDEXES = Object.freeze([
  'interview_debriefs_profile_reference_idx',
  'interview_question_sources_one_correction_idx',
  'interview_question_sources_reference_chain_idx',
  'interview_question_sources_root_reference_idx',
]);

function workspaceFromFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w07-schema13-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(fixturePath, path.join(root, '.jobos', 'jobos.sqlite'));
  return root;
}

async function rawFixtureSnapshot() {
  const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
  const db = new SQL.Database(readFileSync(fixturePath));
  try {
    const snapshot = {};
    for (const table of PROTECTED_TABLES) {
      const statement = db.prepare(`SELECT * FROM ${table} ORDER BY id`);
      const rows = [];
      try {
        while (statement.step()) rows.push(statement.getAsObject());
      } finally {
        statement.free();
      }
      snapshot[table] = rows;
    }
    return snapshot;
  } finally {
    db.close();
  }
}

function stableRows(store, table) {
  return all(store, `SELECT * FROM ${table} ORDER BY id`);
}

function tableSql(store, table) {
  return one(store, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])?.sql || '';
}

function counts(store, tables) {
  return Object.fromEntries(tables.map(table => [
    table,
    Number(one(store, `SELECT COUNT(*) AS count FROM ${table}`).count),
  ]));
}

function foreignKeys(store, table) {
  return all(store, `PRAGMA foreign_key_list(${table})`)
    .map(row => `${row.table}:${row.from}->${row.to}`)
    .sort();
}

test('W07-MIGRATE-01 schema 13 migrates to schema 14 without rewriting protected truth', async t => {
  const before = await rawFixtureSnapshot();
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });

  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'").value, '14');
  assert.deepEqual(
    all(store, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'interview_%' ORDER BY name").map(row => row.name),
    W07_TABLES,
  );
  assert.deepEqual(
    all(store, `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${REQUIRED_INDEXES.map(() => '?').join(',')}) ORDER BY name`, REQUIRED_INDEXES).map(row => row.name),
    REQUIRED_INDEXES,
  );
  assert.deepEqual(all(store, 'PRAGMA foreign_key_check'), []);

  for (const table of PROTECTED_TABLES) {
    assert.deepEqual(stableRows(store, table), before[table], `${table} rows must remain byte-stable`);
  }
  assert.deepEqual(counts(store, W07_TABLES), Object.fromEntries(W07_TABLES.map(table => [table, 0])));

  const revisionSql = tableSql(store, 'interview_story_revisions');
  assert.match(revisionSql, /UNIQUE\s*\(story_id,\s*revision\)/i);
  assert.match(revisionSql, /UNIQUE\s*\(id,\s*story_id,\s*profile_id\)/i);
  assert.match(revisionSql, /CHECK\s*\(state IN \('draft_needs_verification',\s*'verified',\s*'retired'\)\)/i);
  assert.match(revisionSql, /CHECK\s*\(change_kind IN \('create',\s*'edit',\s*'verify',\s*'retire'\)\)/i);

  const evidenceSql = tableSql(store, 'interview_story_field_evidence');
  assert.match(evidenceSql, /PRIMARY KEY\s*\(revision_id,\s*field_name,\s*proof_point_id\)/i);
  assert.match(evidenceSql, /CHECK\s*\(field_name IN \('situation',\s*'task',\s*'action',\s*'result'\)\)/i);
  assert.ok(foreignKeys(store, 'interview_story_field_evidence').includes('interview_story_revisions:revision_id->id'));
  assert.ok(foreignKeys(store, 'interview_story_field_evidence').includes('proof_points:proof_point_id->id'));

  const questionSql = tableSql(store, 'interview_question_sources');
  assert.match(questionSql, /CHECK\s*\(source_kind IN \('user_provided',\s*'recruiter_provided',\s*'interviewer_provided'\)\)/i);

  const packSql = tableSql(store, 'interview_pack_items');
  assert.match(packSql, /CHECK\s*\(question_origin IN \('sourced',\s*'inferred'\)\)/i);
  assert.match(packSql, /CHECK\s*\(coverage_status IN \('covered',\s*'gap'\)\)/i);
  assert.match(packSql, /coverage_status='covered'.*story_id IS NOT NULL.*story_revision_id IS NOT NULL/is);
  assert.match(packSql, /coverage_status='gap'.*story_id IS NULL.*story_revision_id IS NULL/is);
  assert.ok(foreignKeys(store, 'interview_pack_items').includes('interview_story_revisions:story_revision_id->id'));

  const debriefSql = tableSql(store, 'interview_debriefs');
  assert.match(debriefSql, /UNIQUE\s*\(id,\s*profile_id\)/i);
  const debriefRevisionSql = tableSql(store, 'interview_debrief_revisions');
  assert.match(debriefRevisionSql, /UNIQUE\s*\(debrief_id,\s*revision\)/i);
  assert.match(debriefRevisionSql, /UNIQUE\s*\(id,\s*debrief_id,\s*profile_id\)/i);
  assert.ok(foreignKeys(store, 'interview_debrief_revisions').includes('interview_debriefs:debrief_id->id'));
});

test('W07-MIGRATE-02 schema 14 migration is byte and count stable after close and reopen', async t => {
  const root = workspaceFromFixture(t);
  const databasePath = path.join(root, '.jobos', 'jobos.sqlite');
  const first = await openStore({ workspace: root });
  const firstRows = Object.fromEntries(PROTECTED_TABLES.map(table => [table, stableRows(first, table)]));
  const firstCounts = counts(first, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']);
  first.db.close();
  const firstBytes = readFileSync(databasePath);

  const reopened = await openStore({ workspace: root });
  assert.equal(one(reopened, "SELECT value FROM meta WHERE key='schema_version'").value, '14');
  assert.deepEqual(counts(reopened, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']), firstCounts);
  for (const table of PROTECTED_TABLES) {
    assert.deepEqual(stableRows(reopened, table), firstRows[table], `${table} changed on reopen`);
  }
  reopened.db.close();
  assert.deepEqual(readFileSync(databasePath), firstBytes, 'schema-14 reopen must not rewrite the SQLite file');
});

test('W07-ISO-01 migration does not infer stories and ownership resolution is read-only', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const before = counts(store, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']);
  assert.deepEqual(counts(store, W07_TABLES), Object.fromEntries(W07_TABLES.map(table => [table, 0])));

  assert.equal(interview.INTERVIEW_STORY_SCHEMA, 'jobos.interview-story.v1');
  assert.equal(interview.INTERVIEW_STORY_LIST_SCHEMA, 'jobos.interview-story-list.v1');
  assert.equal(interview.INTERVIEW_QUESTION_SCHEMA, 'jobos.interview-question.v1');
  assert.equal(interview.INTERVIEW_PACK_SCHEMA, 'jobos.interview-pack.v1');
  assert.equal(interview.INTERVIEW_DEBRIEF_SCHEMA, 'jobos.interview-debrief.v1');
  assert.equal(interview.INTERVIEW_DEBRIEF_LIST_SCHEMA, 'jobos.interview-debrief-list.v1');
  assert.equal(interview.INTERVIEW_OBSERVATION_SCHEMA, 'jobos.interview-observation.v1');
  assert.equal(interview.INTERVIEW_OBSERVATION_LIST_SCHEMA, 'jobos.interview-observation-list.v1');
  assert.deepEqual(interview.INTERVIEW_AUDIENCES, ['recruiter', 'hiring_manager', 'peer_panel', 'executive', 'unknown']);
  assert.deepEqual(interview.INTERVIEW_STAGES, ['recruiter-screen', 'interview', 'hiring-manager', 'onsite', 'final', 'offer']);

  assert.throws(
    () => interview.resolveInterviewOwnership(store, {
      profileId: 'profile_w07_alpha',
      jobId: 'job_w07_beta',
      applicationId: 'application_w07_beta',
      proofPointIds: ['proof_w07_beta_active'],
    }),
    error => error instanceof interview.InterviewError
      && error.type === 'validation'
      && error.code === 'interview_job_profile_mismatch',
  );
  const owned = interview.resolveInterviewOwnership(store, {
    profileId: 'profile_w07_alpha',
    jobId: 'job_w07_alpha',
    applicationId: 'application_w07_alpha',
    proofPointIds: ['proof_w07_active'],
  });
  assert.equal(owned.profile.id, 'profile_w07_alpha');
  assert.equal(owned.job.id, 'job_w07_alpha');
  assert.equal(owned.application.id, 'application_w07_alpha');
  assert.deepEqual(owned.proofPoints.map(row => row.id), ['proof_w07_active']);

  assert.equal(interview.requireInterviewText('  value  ', 'title'), 'value');
  assert.equal(interview.normalizeInterviewTimestamp('2026-07-20T12:00:00Z', 'occurredAt'), '2026-07-20T12:00:00.000Z');
  assert.equal(interview.normalizeInterviewEnum(' HIRING_MANAGER ', 'audience', interview.INTERVIEW_AUDIENCES), 'hiring_manager');
  assert.deepEqual(interview.normalizeInterviewJson('{"items":[]}', 'payload', 'object'), { items: [] });
  assert.throws(
    () => interview.normalizeInterviewJson('[]', 'payload', 'object'),
    error => error instanceof interview.InterviewError && error.code === 'interview_payload_shape_invalid',
  );
  assert.deepEqual(counts(store, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']), before);
});
