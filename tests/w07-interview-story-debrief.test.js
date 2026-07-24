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
