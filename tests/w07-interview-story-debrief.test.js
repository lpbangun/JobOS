import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import YAML from 'yaml';

import { all, one, openStore, save } from '../src/db.js';
import * as interview from '../src/interview.js';
import { retireProof, supersedeProof } from '../src/profiles.js';
import { id as deterministicId } from '../src/utils.js';

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

const STORY_TABLES = Object.freeze([
  'interview_stories',
  'interview_story_revisions',
  'interview_story_field_evidence',
]);

function storyRows(store, table) {
  return table === 'interview_story_field_evidence'
    ? all(store, `SELECT * FROM interview_story_field_evidence
      ORDER BY revision_id,field_name,position,proof_point_id`)
    : stableRows(store, table);
}

function storyMirrorPath(root, profileId = 'profile_w07_alpha') {
  return path.join(root, 'jobos-workspace', 'profiles', profileId, 'interviews', 'stories.yaml');
}

function storyCounts(store) {
  return counts(store, [...STORY_TABLES, 'audit_log']);
}

function userFieldProvenance(source = 'cli') {
  return Object.fromEntries(interview.INTERVIEW_STORY_CONTENT_FIELDS.map(field => [
    field,
    { origin: 'user', actor: 'user', source, sourceRef: null },
  ]));
}

function storyInput(overrides = {}) {
  const proofPointId = overrides.proofPointId || 'proof_w07_active';
  const input = {
    profileId: 'profile_w07_alpha',
    title: 'Leading a platform launch',
    situation: 'The platform launch had a fixed deadline and fragmented ownership.',
    task: 'I owned delivery alignment and the adoption target.',
    action: 'I established milestones, resolved dependencies, and led weekly risk reviews.',
    result: 'The platform launched on schedule and adoption grew by 30%.',
    reflection: 'I learned to surface dependency risk before committing to dates.',
    competencyTags: ['leadership', 'delivery'],
    audienceTags: ['hiring_manager'],
    fieldProvenance: userFieldProvenance(),
    confirmedFields: [],
    fieldEvidence: Object.fromEntries(interview.INTERVIEW_STORY_FACTUAL_FIELDS.map(field => [
      field,
      [proofPointId],
    ])),
    actor: 'user',
    source: 'cli',
    ...overrides,
  };
  delete input.proofPointId;
  return input;
}

function assertRejectedWithoutStoryDelta(store, root, action, expectedCode, blockerCode = null) {
  const beforeCounts = storyCounts(store);
  const mirror = storyMirrorPath(root);
  const beforeMirror = existsSync(mirror) ? readFileSync(mirror) : null;
  assert.throws(
    action,
    error => error instanceof interview.InterviewError
      && error.code === expectedCode
      && (!blockerCode || error.details.blockers.some(blocker => blocker.code === blockerCode)),
  );
  assert.deepEqual(storyCounts(store), beforeCounts);
  assert.deepEqual(existsSync(mirror) ? readFileSync(mirror) : null, beforeMirror);
}

test('W07-STORY-01 creates one canonical draft with field snapshots and rejects ownership mismatches without side effects', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const created = interview.createInterviewStory(store, storyInput());

  assert.equal(created.schema, interview.INTERVIEW_STORY_SCHEMA);
  assert.match(created.id, /^interview_story_[a-f0-9]{12}$/);
  assert.equal(created.profileId, 'profile_w07_alpha');
  assert.equal(created.currentRevision.revision, 1);
  assert.equal(created.currentRevision.state, 'draft_needs_verification');
  assert.equal(created.currentRevision.changeKind, 'create');
  assert.equal(created.activeVerifiedRevision, null);
  assert.equal(created.eligibility, 'draft_only');
  assert.deepEqual(created.staleProofPointIds, []);
  assert.deepEqual(storyCounts(store), {
    interview_stories: 1,
    interview_story_revisions: 1,
    interview_story_field_evidence: 4,
    audit_log: 1,
  });

  const evidence = all(store, `SELECT * FROM interview_story_field_evidence
    WHERE story_id=? ORDER BY field_name,position,proof_point_id`, [created.id]);
  assert.deepEqual(evidence.map(row => row.field_name), ['action', 'result', 'situation', 'task']);
  for (const row of evidence) {
    const snapshot = JSON.parse(row.proof_snapshot_json);
    assert.deepEqual(snapshot, {
      id: 'proof_w07_active',
      summary: 'Led a verified platform launch',
      evidence: 'Launched on schedule with 30% adoption growth.',
      skills: ['leadership', 'delivery'],
      metrics: ['30% adoption growth'],
      source: 'manual',
      status: 'active',
      verificationStatus: 'verified',
      sourceResumeEntryId: null,
      supersedesProofPointId: null,
      updatedAt: '2026-07-20T12:00:00.000Z',
    });
  }

  const mirror = YAML.parse(readFileSync(storyMirrorPath(root), 'utf8'));
  assert.equal(mirror.schema, interview.INTERVIEW_STORY_LIST_SCHEMA);
  assert.equal(mirror.version, 1);
  assert.equal(mirror.policy.appendOnlyRevisions, true);
  assert.equal(mirror.profileId, 'profile_w07_alpha');
  assert.equal(mirror.stories[0].id, created.id);
  assert.equal(mirror.stories[0].currentRevision.id, created.currentRevision.id);
  assert.equal(mirror.stories[0].history.length, 1);
  assert.deepEqual(mirror.stories[0].history[0].fieldEvidence.situation.map(item => item.proofPointId), ['proof_w07_active']);

  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.createInterviewStory(store, storyInput({
      proofPointId: 'proof_w07_beta_active',
    })),
    'interview_proof_point_profile_mismatch',
  );
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.editInterviewStory(store, {
      storyId: created.id,
      ...storyInput({
        profileId: 'profile_w07_beta',
        proofPointId: 'proof_w07_beta_active',
      }),
    }),
    'interview_story_profile_mismatch',
  );
});

test('W07-STORY-02 blocks unsupported, stale, non-latest, and untrusted verification targets without side effects', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });

  const verifyBlocked = (draft, blockerCode) => assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: draft.profileId,
      storyId: draft.id,
      revision: draft.currentRevision.revision,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_story_verification_blocked',
    blockerCode,
  );

  verifyBlocked(interview.createInterviewStory(store, storyInput({
    title: '',
  })), 'required_field_empty');

  verifyBlocked(interview.createInterviewStory(store, storyInput({
    title: 'Missing result evidence',
    fieldEvidence: {
      ...storyInput().fieldEvidence,
      result: [],
    },
  })), 'factual_field_evidence_missing');

  const agentProvenance = userFieldProvenance();
  agentProvenance.action = { origin: 'agent', actor: 'interview-agent', source: 'mcp', sourceRef: null };
  verifyBlocked(interview.createInterviewStory(store, storyInput({
    title: 'Agent-authored action',
    fieldProvenance: agentProvenance,
  })), 'human_confirmation_missing');
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.createInterviewStory(store, storyInput({
      title: 'Agent-claimed confirmation',
      fieldProvenance: agentProvenance,
      confirmedFields: ['action'],
      actor: 'interview-agent',
      source: 'mcp',
    })),
    'interview_story_confirmation_source_untrusted',
  );

  const proofCases = [
    ['proof_w07_unverified', 'Unverified proof', 'proof_unverified'],
    ['proof_w07_retired', 'Retired proof', 'proof_retired'],
    ['proof_w07_superseded_old', 'Superseded proof', 'proof_superseded'],
  ];
  for (const [proofPointId, title, blockerCode] of proofCases) {
    verifyBlocked(interview.createInterviewStory(store, storyInput({
      proofPointId,
      title,
    })), blockerCode);
  }

  store.db.run("UPDATE proof_points SET verification_status='rejected' WHERE id='proof_w07_unverified'");
  save(store);
  verifyBlocked(interview.createInterviewStory(store, storyInput({
    proofPointId: 'proof_w07_unverified',
    title: 'Rejected proof',
  })), 'proof_rejected');

  store.db.run("UPDATE proof_points SET status='needs_verification',verification_status='verified' WHERE id='proof_w07_unverified'");
  save(store);
  verifyBlocked(interview.createInterviewStory(store, storyInput({
    proofPointId: 'proof_w07_unverified',
    title: 'Non-active proof',
  })), 'proof_not_active');

  const firstDraft = interview.createInterviewStory(store, storyInput({
    title: 'Stale draft target',
  }));
  const latestDraft = interview.editInterviewStory(store, {
    storyId: firstDraft.id,
    ...storyInput({ title: 'Latest draft target' }),
  });
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: firstDraft.profileId,
      storyId: firstDraft.id,
      revision: 1,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_story_revision_not_latest',
  );
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: latestDraft.profileId,
      storyId: latestDraft.id,
      revision: latestDraft.currentRevision.revision,
      confirmedFields: [],
      actor: 'agent',
      source: 'mcp',
    }),
    'interview_story_verification_source_untrusted',
  );
});

test('W07-STORY-03 verification appends a human-confirmed revision and preserves the draft and snapshots', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const fieldProvenance = userFieldProvenance();
  fieldProvenance.action = { origin: 'agent', actor: 'draft-agent', source: 'mcp', sourceRef: 'draft-7' };
  const draft = interview.createInterviewStory(store, storyInput({
    title: 'Verified platform launch',
    fieldProvenance,
  }));
  const verified = interview.verifyInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    revision: 1,
    confirmedFields: ['action'],
    actor: 'user',
    source: 'cli',
  });

  assert.equal(verified.currentRevision.revision, 2);
  assert.equal(verified.currentRevision.state, 'verified');
  assert.equal(verified.currentRevision.changeKind, 'verify');
  assert.equal(verified.currentRevision.supersedesRevisionId, draft.currentRevision.id);
  assert.deepEqual(verified.currentRevision.confirmedFields, ['action']);
  assert.equal(verified.activeVerifiedRevision.id, verified.currentRevision.id);
  assert.equal(verified.eligibility, 'eligible');
  assert.deepEqual(verified.verificationBlockers, []);

  const shown = interview.getInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    includeHistory: true,
  });
  assert.deepEqual(shown.history.map(revision => [revision.revision, revision.state]), [
    [1, 'draft_needs_verification'],
    [2, 'verified'],
  ]);
  assert.equal(shown.history[0].contentHash, shown.history[1].contentHash);
  assert.deepEqual(shown.history[0].fieldEvidence, shown.history[1].fieldEvidence);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM interview_story_field_evidence WHERE story_id=?', [draft.id]).count, 8);

  const mirror = YAML.parse(readFileSync(storyMirrorPath(root), 'utf8'));
  assert.equal(mirror.stories[0].activeVerifiedRevision.id, verified.currentRevision.id);
  assert.equal(mirror.stories[0].eligibility, 'eligible');
  assert.deepEqual(mirror.stories[0].history.map(revision => revision.state), ['draft_needs_verification', 'verified']);
});

test('W07-STORY-04 edit appends a new draft while the prior verified revision remains active and eligible', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const draft = interview.createInterviewStory(store, storyInput());
  const verified = interview.verifyInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    revision: 1,
    confirmedFields: [],
    actor: 'user',
    source: 'tui',
  });
  const edited = interview.editInterviewStory(store, {
    storyId: draft.id,
    ...storyInput({
      title: 'Leading a platform launch after reflection',
      reflection: 'I now surface dependency risk and name decision owners before committing.',
    }),
  });

  assert.equal(edited.currentRevision.revision, 3);
  assert.equal(edited.currentRevision.state, 'draft_needs_verification');
  assert.equal(edited.currentRevision.changeKind, 'edit');
  assert.equal(edited.currentRevision.supersedesRevisionId, verified.currentRevision.id);
  assert.equal(edited.activeVerifiedRevision.id, verified.currentRevision.id);
  assert.equal(edited.activeVerifiedRevision.revision, 2);
  assert.equal(edited.eligibility, 'eligible');
  assert.deepEqual(edited.history.map(revision => revision.state), [
    'draft_needs_verification',
    'verified',
    'draft_needs_verification',
  ]);
  assert.equal(interview.listInterviewStories(store, {
    profileId: draft.profileId,
  }).stories[0].activeVerifiedRevisionId, verified.currentRevision.id);
});

test('W07-STORY-05 retirement preserves history and W01 proof retirement or supersession makes verified stories stale without row mutation', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const draft = interview.createInterviewStory(store, storyInput({ title: 'Story to retire' }));
  interview.verifyInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    revision: 1,
    confirmedFields: [],
    actor: 'user',
    source: 'cli',
  });
  const retired = interview.retireInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    reason: 'No longer representative of current scope',
    actor: 'user',
    source: 'cli',
  });
  assert.equal(retired.currentRevision.revision, 3);
  assert.equal(retired.currentRevision.state, 'retired');
  assert.equal(retired.currentRevision.changeKind, 'retire');
  assert.equal(retired.currentRevision.changeReason, 'No longer representative of current scope');
  assert.equal(retired.activeVerifiedRevision, null);
  assert.equal(retired.eligibility, 'retired');
  assert.deepEqual(retired.history.map(revision => revision.state), [
    'draft_needs_verification',
    'verified',
    'retired',
  ]);

  const retirementDraft = interview.createInterviewStory(store, storyInput({ title: 'Proof retirement story' }));
  interview.verifyInterviewStory(store, {
    profileId: retirementDraft.profileId,
    storyId: retirementDraft.id,
    revision: 1,
    confirmedFields: [],
    actor: 'user',
    source: 'cli',
  });
  const beforeRetirement = Object.fromEntries(STORY_TABLES.map(table => [table, storyRows(store, table)]));
  retireProof(store, 'proof_w07_active', 'Evidence no longer current');
  const proofStale = interview.getInterviewStory(store, {
    profileId: retirementDraft.profileId,
    storyId: retirementDraft.id,
    includeHistory: true,
  });
  assert.equal(proofStale.eligibility, 'proof_stale');
  assert.deepEqual(proofStale.staleProofPointIds, ['proof_w07_active']);
  assert.ok(proofStale.verificationBlockers.some(blocker => blocker.code === 'proof_retired'));
  for (const table of STORY_TABLES) assert.deepEqual(storyRows(store, table), beforeRetirement[table]);

  const supersessionDraft = interview.createInterviewStory(store, storyInput({
    proofPointId: 'proof_w07_superseding',
    title: 'Proof supersession story',
  }));
  interview.verifyInterviewStory(store, {
    profileId: supersessionDraft.profileId,
    storyId: supersessionDraft.id,
    revision: 1,
    confirmedFields: [],
    actor: 'user',
    source: 'cli',
  });
  const beforeSupersession = Object.fromEntries(STORY_TABLES.map(table => [table, storyRows(store, table)]));
  const replacement = supersedeProof(store, 'proof_w07_superseding', {
    summary: 'Corrected customer migration result',
    evidence: 'Corrected evidence supports 15 customer migrations.',
    skills: ['customer migration'],
    metrics: ['15 customer migrations'],
  });
  assert.equal(replacement.supersedes_proof_point_id, 'proof_w07_superseding');
  const superseded = interview.getInterviewStory(store, {
    profileId: supersessionDraft.profileId,
    storyId: supersessionDraft.id,
    includeHistory: true,
  });
  assert.equal(superseded.eligibility, 'proof_stale');
  assert.deepEqual(superseded.staleProofPointIds, ['proof_w07_superseding']);
  assert.ok(superseded.verificationBlockers.some(blocker => blocker.code === 'proof_superseded'));
  for (const table of STORY_TABLES) assert.deepEqual(storyRows(store, table), beforeSupersession[table]);
});

test('W07-STORY-06 normalizes trusted sources and covers retirement and compact projection branches', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const created = interview.createInterviewStory(store, storyInput({
    title: 'Source normalization story',
    source: ' CLI ',
    fieldProvenance: undefined,
  }));
  assert.equal(created.currentRevision.source, 'cli');
  assert.deepEqual(
    Object.values(created.currentRevision.fieldProvenance).map(value => value.source),
    ['cli', 'cli', 'cli', 'cli', 'cli', 'cli'],
  );

  const edited = interview.editInterviewStory(store, {
    storyId: created.id,
    ...storyInput({
      title: 'Source normalization story',
      source: 'cli',
      fieldProvenance: undefined,
    }),
  });
  assert.equal(edited.currentRevision.source, 'cli');
  assert.deepEqual(
    Object.values(edited.currentRevision.fieldProvenance).map(value => value.source),
    ['cli', 'cli', 'cli', 'cli', 'cli', 'cli'],
  );
  assert.equal(edited.currentRevision.contentHash, created.currentRevision.contentHash);
  assert.notEqual(edited.currentRevision.id, created.currentRevision.id);

  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.retireInterviewStory(store, {
      profileId: created.profileId,
      storyId: created.id,
      reason: 'Agent cannot retire a story',
      actor: 'agent',
      source: 'mcp',
    }),
    'interview_story_retirement_source_untrusted',
  );
  const retired = interview.retireInterviewStory(store, {
    profileId: created.profileId,
    storyId: created.id,
    reason: 'Draft is no longer useful',
    actor: 'user',
    source: ' TUI ',
  });
  assert.equal(retired.currentRevision.revision, 3);
  assert.equal(retired.currentRevision.state, 'retired');
  assert.equal(retired.currentRevision.source, 'tui');
  assert.equal(retired.activeVerifiedRevision, null);
  assert.equal(retired.eligibility, 'retired');

  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.editInterviewStory(store, {
      storyId: created.id,
      ...storyInput({ title: 'Cannot revive a retired story' }),
    }),
    'interview_story_retired',
  );
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: created.profileId,
      storyId: created.id,
      revision: 2,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_story_revision_not_latest',
  );
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: created.profileId,
      storyId: created.id,
      revision: 3,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_story_revision_not_draft',
  );

  const withoutHistory = interview.getInterviewStory(store, {
    profileId: created.profileId,
    storyId: created.id,
  });
  assert.equal(Object.hasOwn(withoutHistory, 'history'), false);
  const listed = interview.listInterviewStories(store, {
    profileId: created.profileId,
    includeHistory: true,
  });
  assert.equal(listed.stories[0].history.length, 3);
  assert.deepEqual(listed.stories[0].history.map(revision => revision.revision), [1, 2, 3]);
  assert.equal(Object.hasOwn(listed.stories[0].history[0], 'title'), false);
  assert.equal(Object.hasOwn(listed.stories[0].history[0], 'fieldEvidence'), false);
  assert.deepEqual(listed.stories[0].history[0].competencyTags, ['leadership', 'delivery']);
});

test('W07-STORY-07 classifies supersession only from an authoritative successor row', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  store.db.run(`UPDATE proof_points
    SET retirement_reason='manually superseded wording without replacement'
    WHERE id='proof_w07_retired'`);
  save(store);
  assert.equal(
    one(store, 'SELECT COUNT(*) AS count FROM proof_points WHERE supersedes_proof_point_id=?', ['proof_w07_retired']).count,
    0,
  );
  const draft = interview.createInterviewStory(store, storyInput({
    proofPointId: 'proof_w07_retired',
    title: 'Manually retired proof story',
  }));
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: draft.profileId,
      storyId: draft.id,
      revision: 1,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_story_verification_blocked',
    'proof_retired',
  );
});

test('W07-STORY-08 verification revalidates current proof ownership before blockers or writes', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const draft = interview.createInterviewStory(store, storyInput({
    title: 'Proof ownership tamper story',
  }));
  store.db.run("UPDATE proof_points SET profile_id='profile_w07_beta' WHERE id='proof_w07_active'");
  save(store);
  assertRejectedWithoutStoryDelta(
    store,
    root,
    () => interview.verifyInterviewStory(store, {
      profileId: draft.profileId,
      storyId: draft.id,
      revision: 1,
      confirmedFields: [],
      actor: 'user',
      source: 'cli',
    }),
    'interview_proof_point_profile_mismatch',
  );
});

const QUESTION_TABLES = Object.freeze(['interview_question_sources', 'audit_log']);

function questionMirrorPath(root, profileId = 'profile_w07_alpha') {
  return path.join(root, 'jobos-workspace', 'profiles', profileId, 'interviews', 'question-sources.yaml');
}

function questionRows(store) {
  return all(store, `SELECT * FROM interview_question_sources
    ORDER BY profile_id,source_ref,created_at,id`);
}

function questionState(store, root, profileId = 'profile_w07_alpha') {
  const mirror = questionMirrorPath(root, profileId);
  const auditMirror = path.join(root, 'jobos-workspace', 'audit.log.jsonl');
  return {
    counts: counts(store, QUESTION_TABLES),
    rows: questionRows(store),
    mirror: existsSync(mirror) ? readFileSync(mirror) : null,
    auditMirror: existsSync(auditMirror) ? readFileSync(auditMirror) : null,
  };
}

function questionInput(overrides = {}) {
  return {
    profileId: 'profile_w07_alpha',
    jobId: 'job_w07_alpha',
    applicationId: 'application_w07_alpha',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
    questionText: 'Tell me about a time you led a complex delivery.',
    sourceKind: 'recruiter_provided',
    sourceRef: 'recruiter-email-42',
    actor: 'candidate',
    source: 'cli',
    ...overrides,
  };
}

function addSecondAlphaApplication(store) {
  const createdAt = '2026-07-21T12:00:00.000Z';
  store.db.run(`INSERT INTO jobs
    (id,profile_id,title,company,url,description,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [
    'job_w07_alpha_second',
    'profile_w07_alpha',
    'Second Alpha Role',
    'Alpha Company',
    'https://alpha.example/jobs/second-role',
    'A second role used only for ownership-boundary tests.',
    createdAt,
    createdAt,
  ]);
  store.db.run(`INSERT INTO applications
    (id,job_id,profile_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`, [
    'application_w07_alpha_second',
    'job_w07_alpha_second',
    'profile_w07_alpha',
    'interview',
    createdAt,
    createdAt,
  ]);
  save(store);
}

function assertRejectedWithoutQuestionDelta(store, root, action, expectedCode) {
  const before = questionState(store, root);
  assert.throws(
    action,
    error => error instanceof interview.InterviewError && error.code === expectedCode,
  );
  assert.deepEqual(questionState(store, root), before);
}

function createVerifiedStory(store, overrides = {}) {
  const draft = interview.createInterviewStory(store, storyInput(overrides));
  return interview.verifyInterviewStory(store, {
    profileId: draft.profileId,
    storyId: draft.id,
    revision: draft.currentRevision.revision,
    confirmedFields: [],
    actor: 'user',
    source: 'cli',
  });
}

test('W07-QUESTION-01 trusted CLI/TUI question roots use deterministic identity and owned projections', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const cliInput = questionInput({ source: ' CLI ' });
  const created = interview.createInterviewQuestionSource(store, cliInput);
  const expectedId = deterministicId(
    'interview_question',
    'profile_w07_alpha|hiring-manager|recruiter_provided|recruiter-email-42',
  );

  assert.equal(created.schema, interview.INTERVIEW_QUESTION_SCHEMA);
  assert.equal(created.version, 1);
  assert.equal(created.id, expectedId);
  assert.equal(created.rootSourceId, expectedId);
  assert.equal(created.profileId, 'profile_w07_alpha');
  assert.equal(created.jobId, 'job_w07_alpha');
  assert.equal(created.applicationId, 'application_w07_alpha');
  assert.equal(created.stage, 'hiring-manager');
  assert.equal(created.audience, 'hiring_manager');
  assert.equal(created.questionText, cliInput.questionText);
  assert.equal(created.normalizedText, 'tell me about a time you led a complex delivery');
  assert.equal(created.sourceKind, 'recruiter_provided');
  assert.equal(created.sourceRef, 'recruiter-email-42');
  assert.equal(created.actor, 'candidate');
  assert.equal(created.source, 'cli');
  assert.equal(created.supersedesSourceId, null);
  assert.equal(created.supersededBySourceId, null);
  assert.equal(created.correctionReason, '');
  assert.equal(created.current, true);
  assert.equal(created.idempotent, false);

  const tui = interview.createInterviewQuestionSource(store, questionInput({
    stage: 'onsite',
    audience: '',
    questionText: 'How do you resolve conflict with peers?',
    sourceKind: 'interviewer_provided',
    sourceRef: 'panel-agenda-7',
    source: ' TUI ',
  }));
  assert.equal(tui.id, deterministicId(
    'interview_question',
    'profile_w07_alpha|onsite|interviewer_provided|panel-agenda-7',
  ));
  assert.equal(tui.audience, 'peer_panel');
  assert.equal(tui.source, 'tui');

  const listed = interview.listInterviewQuestionSources(store, {
    profileId: 'profile_w07_alpha',
  });
  assert.equal(listed.schema, interview.INTERVIEW_QUESTION_SCHEMA);
  assert.equal(listed.version, 1);
  assert.equal(listed.profileId, 'profile_w07_alpha');
  assert.deepEqual(listed.sources.map(item => item.id), [expectedId, tui.id]);
  assert.deepEqual(listed.currentSources.map(item => item.id), [expectedId, tui.id]);

  const mirror = YAML.parse(readFileSync(questionMirrorPath(root), 'utf8'));
  assert.equal(mirror.schema, interview.INTERVIEW_QUESTION_SCHEMA);
  assert.equal(mirror.version, 1);
  assert.equal(mirror.profileId, 'profile_w07_alpha');
  assert.equal(mirror.policy.appendOnly, true);
  assert.equal(mirror.policy.currentResolution, 'unique_chain_tip');
  assert.deepEqual(mirror.sources, listed.sources);
  assert.deepEqual(mirror.currentSources, listed.currentSources);
});

test('W07-QUESTION-02 exact root replay is side-effect free and corrections append a branchless current tip', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const input = questionInput();
  const original = interview.createInterviewQuestionSource(store, input);
  const afterRoot = questionState(store, root);

  const replay = interview.createInterviewQuestionSource(store, input);
  assert.equal(replay.id, original.id);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.current, true);
  assert.deepEqual(questionState(store, root), afterRoot);

  const corrected = interview.createInterviewQuestionSource(store, {
    ...input,
    questionText: 'Tell me about a time you led a complex cross-team delivery.',
    supersedesSourceId: original.id,
    correctionReason: 'Clarified that the example should be cross-team.',
  });
  assert.notEqual(corrected.id, original.id);
  assert.equal(corrected.rootSourceId, original.id);
  assert.equal(corrected.supersedesSourceId, original.id);
  assert.equal(corrected.current, true);
  assert.equal(corrected.idempotent, false);
  assert.equal(questionRows(store).length, 2);

  const listed = interview.listInterviewQuestionSources(store, {
    profileId: input.profileId,
    applicationId: input.applicationId,
    stage: input.stage,
  });
  assert.deepEqual(listed.sources.map(item => ({
    id: item.id,
    supersedesSourceId: item.supersedesSourceId,
    supersededBySourceId: item.supersededBySourceId,
    current: item.current,
    rootSourceId: item.rootSourceId,
  })), [
    {
      id: original.id,
      supersedesSourceId: null,
      supersededBySourceId: corrected.id,
      current: false,
      rootSourceId: original.id,
    },
    {
      id: corrected.id,
      supersedesSourceId: original.id,
      supersededBySourceId: null,
      current: true,
      rootSourceId: original.id,
    },
  ]);
  assert.deepEqual(listed.currentSources.map(item => item.id), [corrected.id]);

  const afterCorrection = questionState(store, root);
  const rootReplay = interview.createInterviewQuestionSource(store, input);
  assert.equal(rootReplay.id, original.id);
  assert.equal(rootReplay.idempotent, true);
  assert.equal(rootReplay.current, false);
  assert.equal(rootReplay.supersededBySourceId, corrected.id);
  assert.deepEqual(questionState(store, root), afterCorrection);

  assertRejectedWithoutQuestionDelta(
    store,
    root,
    () => interview.createInterviewQuestionSource(store, {
      ...input,
      questionText: 'A competing correction.',
      supersedesSourceId: original.id,
      correctionReason: 'Would create a branch.',
    }),
    'interview_question_supersedes_not_current',
  );
});

test('W07-QUESTION-03 source references are profile-scoped and same-profile conflicts are exact', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const alphaInput = questionInput({ sourceRef: 'shared-recruiter-ref' });
  const alpha = interview.createInterviewQuestionSource(store, alphaInput);
  const betaInput = questionInput({
    profileId: 'profile_w07_beta',
    jobId: 'job_w07_beta',
    applicationId: 'application_w07_beta',
    sourceRef: 'shared-recruiter-ref',
    questionText: 'What customer migration did you lead?',
    actor: 'beta-candidate',
    source: 'tui',
  });
  const beta = interview.createInterviewQuestionSource(store, betaInput);

  assert.notEqual(beta.id, alpha.id);
  assert.equal(beta.profileId, 'profile_w07_beta');
  assert.equal(beta.sourceRef, alpha.sourceRef);
  assert.equal(
    interview.createInterviewQuestionSource(store, betaInput).idempotent,
    true,
  );
  assert.equal(
    one(store, `SELECT COUNT(*) AS count FROM interview_question_sources
      WHERE source_ref='shared-recruiter-ref'`).count,
    2,
  );

  assertRejectedWithoutQuestionDelta(
    store,
    root,
    () => interview.createInterviewQuestionSource(store, {
      ...alphaInput,
      stage: 'onsite',
      audience: 'peer_panel',
      questionText: 'A distinct root trying to reuse the same profile reference.',
    }),
    'interview_question_reference_conflict',
  );
  assertRejectedWithoutQuestionDelta(
    store,
    root,
    () => interview.createInterviewQuestionSource(store, {
      ...alphaInput,
      questionText: 'A conflicting replay payload.',
    }),
    'interview_question_reference_conflict',
  );
});

test('W07-QUESTION-04 trust, ownership, source lineage, stage, and shape reject before side effects', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const original = interview.createInterviewQuestionSource(store, questionInput());

  const failures = [
    [questionInput({ source: 'mcp' }), 'interview_question_source_untrusted'],
    [questionInput({
      applicationId: 'application_w07_beta',
    }), 'interview_application_profile_mismatch'],
    [questionInput({
      jobId: 'job_w07_beta',
    }), 'interview_job_profile_mismatch'],
    [questionInput({
      profileId: 'profile_w07_beta',
      jobId: 'job_w07_beta',
      applicationId: 'application_w07_beta',
      supersedesSourceId: original.id,
      questionText: 'Cross-profile correction.',
      correctionReason: 'Invalid ownership.',
      source: 'tui',
    }), 'interview_question_supersedes_mismatch'],
    [questionInput({ stage: 'phone-chat' }), 'interview_stage_invalid'],
    [questionInput({ audience: 'board' }), 'interview_audience_invalid'],
    [questionInput({ questionText: '   ' }), 'interview_question_text_required'],
    [questionInput({ sourceKind: 'agent_inferred' }), 'interview_source_kind_invalid'],
    [questionInput({
      sourceKind: 'interviewer_provided',
      sourceRef: '',
    }), 'interview_source_ref_required'],
  ];
  for (const [input, code] of failures) {
    assertRejectedWithoutQuestionDelta(
      store,
      root,
      () => interview.createInterviewQuestionSource(store, input),
      code,
    );
  }
});

test('W07-MATCH-01 only persisted eligible verified stories participate and exclusions are explicit', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const eligible = createVerifiedStory(store, {
    title: 'Eligible delivery story',
  });
  const draft = interview.createInterviewStory(store, storyInput({
    title: 'Draft-only story',
  }));
  const retired = createVerifiedStory(store, {
    title: 'Retired story',
  });
  interview.retireInterviewStory(store, {
    profileId: retired.profileId,
    storyId: retired.id,
    reason: 'No longer representative.',
    actor: 'user',
    source: 'cli',
  });
  const stale = createVerifiedStory(store, {
    proofPointId: 'proof_w07_superseding',
    title: 'Proof-stale story',
  });
  supersedeProof(store, 'proof_w07_superseding', {
    summary: 'Corrected migration proof for matcher',
    evidence: 'Corrected evidence supports 16 migrations.',
    skills: ['migration'],
    metrics: ['16 migrations'],
  });

  const matched = interview.matchStoriesToQuestions(store, {
    profileId: 'profile_w07_alpha',
    questions: [{
      id: 'question.quantum',
      text: 'Explain quantum compiler design.',
      audience: 'executive',
    }],
    maxStories: 3,
  });
  assert.equal(matched.deterministic, true);
  assert.deepEqual(matched.eligibleStories.map(item => item.storyId), [eligible.id]);
  assert.deepEqual(
    Object.fromEntries(matched.excludedStories.map(item => [item.storyId, item.reason])),
    {
      [draft.id]: 'draft_only',
      [retired.id]: 'retired',
      [stale.id]: 'proof_stale',
    },
  );
  assert.deepEqual(
    matched.excludedStories.find(item => item.storyId === stale.id).staleProofPointIds,
    ['proof_w07_superseding'],
  );
  assert.equal(matched.questions[0].coverageStatus, 'gap');
  assert.equal(matched.questions[0].gapReason, 'insufficient_overlap');
  assert.equal(matched.questions[0].selectedStory, null);
  assert.deepEqual(matched.questions[0].matches, []);
});

test('W07-MATCH-02 frozen weighted scoring exposes exact token components and reasons', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store, {
    title: 'Platform launch',
    situation: 'Platform launch.',
    task: 'Delivery.',
    action: 'Led launch.',
    result: 'Platform.',
    reflection: 'Learning.',
    competencyTags: ['leadership', 'delivery'],
    audienceTags: ['hiring_manager'],
  });

  const matched = interview.matchStoriesToQuestions(store, {
    profileId: story.profileId,
    questions: [{
      id: 'question.leadership',
      text: 'How did you lead delivery on a platform launch?',
      audience: 'hiring_manager',
    }],
    maxStories: 3,
  });
  const question = matched.questions[0];
  const candidate = question.selectedStory;
  assert.deepEqual(question.questionTokens, [
    'delivery',
    'did',
    'how',
    'launch',
    'leadership',
    'platform',
  ]);
  assert.equal(question.coverageStatus, 'covered');
  assert.equal(question.gapReason, null);
  assert.equal(candidate.storyId, story.id);
  assert.equal(candidate.storyRevisionId, story.activeVerifiedRevision.id);
  assert.equal(candidate.score, 16);
  assert.deepEqual(candidate.scoreComponents, {
    competencyTagOverlap: {
      tokens: ['delivery', 'leadership'],
      count: 2,
      cappedCount: 2,
      weight: 4,
      score: 8,
    },
    linkedProofSkillOverlap: {
      tokens: ['delivery', 'leadership'],
      count: 2,
      cappedCount: 2,
      weight: 2,
      score: 4,
    },
    otherStoryTokenOverlap: {
      tokens: ['launch', 'platform'],
      count: 2,
      cappedCount: 2,
      weight: 1,
      score: 2,
    },
    audienceTagMatch: {
      matched: true,
      score: 2,
    },
  });
  assert.deepEqual(candidate.reasons, [
    'competency_tag_overlap',
    'linked_proof_skill_overlap',
    'other_story_token_overlap',
    'audience_tag_match',
  ]);
});

test('W07-MATCH-03 ties use story/revision identity and maxStories bounds canonical alternatives', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const stories = [
    createVerifiedStory(store, {
      title: 'Tie story alpha',
      situation: 'A neutral situation.',
      task: 'A neutral task.',
      action: 'A neutral action.',
      result: 'A neutral result.',
      reflection: 'A neutral reflection.',
      competencyTags: ['collaboration'],
      audienceTags: [],
    }),
    createVerifiedStory(store, {
      title: 'Tie story beta',
      situation: 'A neutral situation.',
      task: 'A neutral task.',
      action: 'A neutral action.',
      result: 'A neutral result.',
      reflection: 'A neutral reflection.',
      competencyTags: ['collaboration'],
      audienceTags: [],
    }),
    createVerifiedStory(store, {
      title: 'Tie story gamma',
      situation: 'A neutral situation.',
      task: 'A neutral task.',
      action: 'A neutral action.',
      result: 'A neutral result.',
      reflection: 'A neutral reflection.',
      competencyTags: ['collaboration'],
      audienceTags: [],
    }),
  ];
  const expected = stories
    .map(story => [story.id, story.activeVerifiedRevision.id])
    .sort(([storyA, revisionA], [storyB, revisionB]) => (
      storyA.localeCompare(storyB) || revisionA.localeCompare(revisionB)
    ));

  const matched = interview.matchStoriesToQuestions(store, {
    profileId: 'profile_w07_alpha',
    questions: [{
      id: 'question.tie',
      text: 'Describe collaboration.',
      audience: 'unknown',
    }],
    maxStories: 2,
  });
  const question = matched.questions[0];
  assert.equal(question.candidateCount, 3);
  assert.equal(question.matches.length, 2);
  assert.deepEqual(
    question.matches.map(item => [item.storyId, item.storyRevisionId]),
    expected.slice(0, 2),
  );
  assert.equal(question.selectedStory.storyId, expected[0][0]);
  assert.deepEqual(question.alternativeStories.map(item => item.storyId), [expected[1][0]]);
  assert.ok(question.matches.every(item => item.score === 4));
});

test('W07-MATCH-04 synonyms are static and repeated matching is byte-stable and read-only', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  createVerifiedStory(store, {
    title: 'Leadership example',
    situation: 'Teams were disconnected.',
    task: 'Alignment was needed.',
    action: 'Coordinated decisions.',
    result: 'Teams aligned.',
    reflection: 'Clear ownership helps.',
    competencyTags: ['leadership'],
    audienceTags: [],
  });
  const input = {
    profileId: 'profile_w07_alpha',
    questions: [
      {
        id: 'question.static-synonym',
        text: 'How have you led teams?',
        audience: 'unknown',
      },
      {
        id: 'question.not-a-synonym',
        text: 'How have you spearheaded teams alignment decisions?',
        audience: 'unknown',
      },
    ],
    maxStories: 3,
  };
  const before = {
    tables: counts(store, [...W07_TABLES, 'audit_log']),
    storyMirror: readFileSync(storyMirrorPath(root)),
  };
  const first = interview.matchStoriesToQuestions(store, input);
  const second = interview.matchStoriesToQuestions(store, input);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(first.questions[0].questionTokens, ['have', 'how', 'leadership', 'teams']);
  assert.ok(!first.questions[0].questionTokens.includes('led'));
  assert.ok(first.questions[1].questionTokens.includes('spearheaded'));
  assert.equal(first.questions[0].selectedStory.scoreComponents.competencyTagOverlap.score, 4);
  assert.equal(first.questions[1].selectedStory.scoreComponents.competencyTagOverlap.score, 0);
  assert.deepEqual(counts(store, [...W07_TABLES, 'audit_log']), before.tables);
  assert.deepEqual(readFileSync(storyMirrorPath(root)), before.storyMirror);
});

test('W07-QUESTION-05 refless user roots use normalized text identity across distinct applications', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  addSecondAlphaApplication(store);
  const firstInput = questionInput({
    questionText: 'What did you learn?',
    sourceKind: 'user_provided',
    sourceRef: '',
  });
  const secondInput = questionInput({
    jobId: 'job_w07_alpha_second',
    applicationId: 'application_w07_alpha_second',
    questionText: 'How did you adapt?',
    sourceKind: 'user_provided',
    sourceRef: '',
  });

  const first = interview.createInterviewQuestionSource(store, firstInput);
  const second = interview.createInterviewQuestionSource(store, secondInput);
  assert.equal(first.id, deterministicId(
    'interview_question',
    'profile_w07_alpha|hiring-manager|user_provided|what did you learn',
  ));
  assert.equal(second.id, deterministicId(
    'interview_question',
    'profile_w07_alpha|hiring-manager|user_provided|how did you adapt',
  ));
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.applicationId, second.applicationId);
  assert.equal(first.sourceRef, '');
  assert.equal(second.sourceRef, '');

  const beforeReplay = questionState(store, root);
  const replay = interview.createInterviewQuestionSource(store, firstInput);
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(questionState(store, root), beforeReplay);
  assert.deepEqual(
    interview.listInterviewQuestionSources(store, {
      profileId: 'profile_w07_alpha',
    }).currentSources.map(source => source.id).sort(),
    [first.id, second.id].sort(),
  );
});

test('W07-QUESTION-06 multilevel correction replay is idempotent, branchless, and mirror-stable after reopen', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const input = questionInput({ sourceRef: 'multilevel-correction-ref' });
  const original = interview.createInterviewQuestionSource(store, input);
  const correctionOneInput = {
    ...input,
    questionText: 'Tell me about a time you led a complex cross-team delivery.',
    supersedesSourceId: original.id,
    correctionReason: 'Clarified cross-team scope.',
  };
  const correctionOne = interview.createInterviewQuestionSource(store, correctionOneInput);
  const correctionTwoInput = {
    ...input,
    questionText: 'Tell me about a time you led a complex cross-team delivery under a fixed deadline.',
    supersedesSourceId: correctionOne.id,
    correctionReason: 'Added the fixed-deadline constraint.',
  };
  const correctionTwo = interview.createInterviewQuestionSource(store, correctionTwoInput);
  assert.deepEqual(
    questionRows(store).map(row => [row.id, row.supersedes_source_id || null]),
    [
      [original.id, null],
      [correctionOne.id, original.id],
      [correctionTwo.id, correctionOne.id],
    ],
  );

  const afterChain = questionState(store, root);
  const replayOne = interview.createInterviewQuestionSource(store, correctionOneInput);
  const replayTwo = interview.createInterviewQuestionSource(store, correctionTwoInput);
  assert.equal(replayOne.id, correctionOne.id);
  assert.equal(replayOne.idempotent, true);
  assert.equal(replayOne.current, false);
  assert.equal(replayTwo.id, correctionTwo.id);
  assert.equal(replayTwo.idempotent, true);
  assert.equal(replayTwo.current, true);
  assert.deepEqual(questionState(store, root), afterChain);

  for (const branch of [
    {
      ...input,
      questionText: 'Competing correction from the root.',
      supersedesSourceId: original.id,
      correctionReason: 'Would branch from the root.',
    },
    {
      ...input,
      questionText: 'Competing correction from correction one.',
      supersedesSourceId: correctionOne.id,
      correctionReason: 'Would branch from correction one.',
    },
  ]) {
    assertRejectedWithoutQuestionDelta(
      store,
      root,
      () => interview.createInterviewQuestionSource(store, branch),
      'interview_question_supersedes_not_current',
    );
  }

  const listed = interview.listInterviewQuestionSources(store, {
    profileId: input.profileId,
    applicationId: input.applicationId,
    stage: input.stage,
  });
  assert.deepEqual(listed.currentSources.map(source => source.id), [correctionTwo.id]);
  const mirrorPath = questionMirrorPath(root);
  const mirror = YAML.parse(readFileSync(mirrorPath, 'utf8'));
  assert.deepEqual({
    schema: mirror.schema,
    version: mirror.version,
    profileId: mirror.profileId,
    sources: mirror.sources,
    currentSources: mirror.currentSources,
  }, listed);
  const mirrorBytes = readFileSync(mirrorPath);

  save(store);
  store.db.close();
  const reopened = await openStore({ workspace: root });
  const reopenedList = interview.listInterviewQuestionSources(reopened, {
    profileId: input.profileId,
    applicationId: input.applicationId,
    stage: input.stage,
  });
  assert.deepEqual(reopenedList, listed);
  assert.deepEqual(readFileSync(mirrorPath), mirrorBytes);
});

test('W07-QUESTION-07 refless corrections and same-profile application/job mismatches are zero-delta', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const reflessInput = questionInput({
    questionText: 'What did you learn from the launch?',
    sourceKind: 'user_provided',
    sourceRef: '',
  });
  const refless = interview.createInterviewQuestionSource(store, reflessInput);
  assertRejectedWithoutQuestionDelta(
    store,
    root,
    () => interview.createInterviewQuestionSource(store, {
      ...reflessInput,
      questionText: 'What did you learn from the platform launch?',
      supersedesSourceId: refless.id,
      correctionReason: 'Clarified the launch.',
    }),
    'interview_question_correction_reference_required',
  );

  addSecondAlphaApplication(store);
  assertRejectedWithoutQuestionDelta(
    store,
    root,
    () => interview.createInterviewQuestionSource(store, questionInput({
      jobId: 'job_w07_alpha',
      applicationId: 'application_w07_alpha_second',
      sourceRef: 'same-profile-job-mismatch',
    })),
    'interview_application_job_mismatch',
  );
});

test('W07-MATCH-05 invalid limits, no-story gaps, and empty questions are deterministic and read-only', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const input = {
    profileId: 'profile_w07_alpha',
    questions: [{
      id: 'question.no-stories',
      text: 'Describe a difficult decision.',
      audience: 'executive',
    }],
  };
  const state = () => ({
    counts: counts(store, [...W07_TABLES, 'audit_log']),
    questionMirror: existsSync(questionMirrorPath(root))
      ? readFileSync(questionMirrorPath(root))
      : null,
    storyMirror: existsSync(storyMirrorPath(root))
      ? readFileSync(storyMirrorPath(root))
      : null,
  });
  const before = state();
  for (const maxStories of [0, -1, 1.5, 'not-a-number', null, Infinity]) {
    assert.throws(
      () => interview.matchStoriesToQuestions(store, { ...input, maxStories }),
      error => error instanceof interview.InterviewError
        && error.code === 'interview_max_stories_invalid',
    );
    assert.deepEqual(state(), before);
  }

  const noStories = interview.matchStoriesToQuestions(store, {
    ...input,
    maxStories: 3,
  });
  assert.deepEqual(noStories.eligibleStories, []);
  assert.deepEqual(noStories.excludedStories, []);
  assert.equal(noStories.questions[0].coverageStatus, 'gap');
  assert.equal(noStories.questions[0].gapReason, 'no_verified_story');
  assert.equal(noStories.questions[0].candidateCount, 0);
  assert.deepEqual(noStories.questions[0].candidates, []);

  const emptyInput = {
    profileId: 'profile_w07_alpha',
    questions: [],
    maxStories: 3,
  };
  const emptyFirst = interview.matchStoriesToQuestions(store, emptyInput);
  const emptySecond = interview.matchStoriesToQuestions(store, emptyInput);
  assert.equal(JSON.stringify(emptySecond), JSON.stringify(emptyFirst));
  assert.deepEqual(emptyFirst.questions, []);
  assert.deepEqual(emptyFirst.eligibleStories, []);
  assert.deepEqual(emptyFirst.excludedStories, []);
  assert.deepEqual(state(), before);
});
