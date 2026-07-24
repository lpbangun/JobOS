import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import initSqlJs from 'sql.js';
import YAML from 'yaml';

import { all, one, openStore, save } from '../src/db.js';
import { getArtifact } from '../src/artifacts.js';
import * as interview from '../src/interview.js';
import { retireProof, supersedeProof } from '../src/profiles.js';
import { id as deterministicId } from '../src/utils.js';
import { rescheduleApplicationNextAction } from '../src/lifecycle.js';
import { commandRegistry } from '../src/cli.js';
import { callDomainTool, DOMAIN_TOOLS, DomainToolError } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';

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
const INTERVIEW_COMMAND_NAMES = Object.freeze([
  'interview stories create',
  'interview stories edit',
  'interview stories verify',
  'interview stories retire',
  'interview stories list',
  'interview stories show',
  'interview questions add',
  'interview questions list',
  'interview prep',
  'interview debrief record',
  'interview debrief correct',
  'interview debriefs',
  'interview observations',
]);
const INTERVIEW_DOMAIN_TOOL_NAMES = Object.freeze([
  'list_interview_stories',
  'get_interview_story',
  'draft_interview_story',
  'verify_interview_story',
  'retire_interview_story',
  'add_interview_question_source',
  'interview_prep',
  'record_interview_debrief',
  'correct_interview_debrief',
  'list_interview_debriefs',
  'list_interview_observations',
]);
const MCP_INTERVIEW_TOOL_NAMES = Object.freeze([
  'list_interview_stories',
  'get_interview_story',
  'draft_interview_story',
  'interview_prep',
  'list_interview_debriefs',
  'list_interview_observations',
]);
const MCP_DENIED_INTERVIEW_TOOL_NAMES = Object.freeze([
  'verify_interview_story',
  'retire_interview_story',
  'add_interview_question_source',
  'record_interview_debrief',
  'correct_interview_debrief',
]);

function runW07Cli(root, args) {
  return spawnSync(process.execPath, [
    'src/cli.js',
    ...args,
    '--workspace',
    root,
    ...(args.includes('--json') ? [] : ['--json']),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JOBOS_LLM_PROVIDER: '',
      JOBOS_LLM_MODEL: '',
      JOBOS_LLM_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OLLAMA_API_KEY: '',
    },
    encoding: 'utf8',
  });
}

function cliJson(root, args) {
  const result = runW07Cli(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function writeJsonFixture(root, name, value) {
  const file = path.join(root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
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

test('W07-MIGRATE-01 schema 13 migrates through schema 15 without rewriting protected truth', async t => {
  const before = await rawFixtureSnapshot();
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });

  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'").value, '15');
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

test('W07-MIGRATE-02 schema 15 is byte and count stable after close and reopen', async t => {
  const root = workspaceFromFixture(t);
  const databasePath = path.join(root, '.jobos', 'jobos.sqlite');
  const first = await openStore({ workspace: root });
  const firstRows = Object.fromEntries(PROTECTED_TABLES.map(table => [table, stableRows(first, table)]));
  const firstCounts = counts(first, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']);
  first.db.close();
  const firstBytes = readFileSync(databasePath);

  const reopened = await openStore({ workspace: root });
  assert.equal(one(reopened, "SELECT value FROM meta WHERE key='schema_version'").value, '15');
  assert.deepEqual(counts(reopened, [...PROTECTED_TABLES, ...W07_TABLES, 'audit_log']), firstCounts);
  for (const table of PROTECTED_TABLES) {
    assert.deepEqual(stableRows(reopened, table), firstRows[table], `${table} changed on reopen`);
  }
  reopened.db.close();
  assert.deepEqual(readFileSync(databasePath), firstBytes, 'schema-15 reopen must not rewrite the SQLite file');
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

function packQuestionMirrorPath(root, jobId = 'job_w07_alpha') {
  return path.join(root, 'jobos-workspace', 'jobs', jobId, 'interviews', 'questions.yaml');
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

test('W07-PACK-01 deterministic audience questions preserve sources and expose exact coverage provenance', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const sourced = interview.createInterviewQuestionSource(store, questionInput({
    questionText: 'Tell me about a time you led delivery through a fixed deadline.',
  }));
  const eligible = createVerifiedStory(store, {
    title: 'Eligible pack story',
  });
  const draft = interview.createInterviewStory(store, storyInput({
    title: 'Draft pack story',
  }));
  const retired = createVerifiedStory(store, {
    title: 'Retired pack story',
  });
  interview.retireInterviewStory(store, {
    profileId: retired.profileId,
    storyId: retired.id,
    reason: 'Not representative for current interviews.',
    actor: 'user',
    source: 'cli',
  });
  const stale = createVerifiedStory(store, {
    proofPointId: 'proof_w07_superseding',
    title: 'Stale pack story',
  });
  supersedeProof(store, 'proof_w07_superseding', {
    summary: 'Corrected migration evidence for pack matching',
    evidence: 'Corrected evidence supports 18 migrations.',
    skills: ['migration'],
    metrics: ['18 migrations'],
  });

  const expectedTemplates = {
    recruiter: ['recruiter.motivation', 'recruiter.scope'],
    hiring_manager: ['manager.ownership', 'manager.tradeoff'],
    peer_panel: ['panel.collaboration', 'panel.conflict'],
    executive: ['executive.strategy', 'executive.influence'],
    unknown: ['unknown.impact', 'unknown.learning'],
  };
  const templateTexts = new Set();
  for (const [audience, expectedIds] of Object.entries(expectedTemplates)) {
    const first = interview.questionsForInterview(store, {
      applicationId: 'application_w07_alpha',
      stage: 'interview',
      audience,
    });
    const second = interview.questionsForInterview(store, {
      applicationId: 'application_w07_alpha',
      stage: 'interview',
      audience,
    });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(first.audience, audience);
    assert.deepEqual(
      first.questions.filter(question => question.templateId).map(question => question.id),
      expectedIds,
    );
    for (const question of first.questions.filter(question => question.templateId)) {
      assert.equal(question.origin, 'inferred');
      assert.equal(question.source, null);
      assert.equal(question.stage, 'interview');
      assert.equal(question.audience, audience);
      templateTexts.add(question.text);
    }
  }
  assert.equal(templateTexts.size, 10);

  const questions = interview.questionsForInterview(store, {
    applicationId: 'application_w07_alpha',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
  });
  assert.equal(questions.questions[0].id, sourced.id);
  assert.equal(questions.questions[0].origin, 'sourced');
  assert.deepEqual(questions.questions[0].source, {
    questionSourceId: sourced.id,
    rootSourceId: sourced.rootSourceId,
    sourceKind: 'recruiter_provided',
    sourceRef: 'recruiter-email-42',
    actor: 'candidate',
    source: 'cli',
    createdAt: sourced.createdAt,
  });
  assert.ok(questions.questions.slice(1).every(question => question.origin === 'inferred'));
  assert.ok(questions.questions.slice(1).every(question => question.source === null));

  const firstPack = interview.buildInterviewPack(store, {
    applicationId: 'application_w07_alpha',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
  });
  const secondPack = interview.buildInterviewPack(store, {
    applicationId: 'application_w07_alpha',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
  });
  assert.equal(JSON.stringify(secondPack), JSON.stringify(firstPack));
  assert.equal(firstPack.schema, interview.INTERVIEW_PACK_SCHEMA);
  assert.equal(firstPack.deterministic, true);
  assert.equal(firstPack.profileId, 'profile_w07_alpha');
  assert.equal(firstPack.jobId, 'job_w07_alpha');
  assert.equal(firstPack.applicationId, 'application_w07_alpha');
  assert.equal(firstPack.stage, 'hiring-manager');
  assert.equal(firstPack.audience, 'hiring_manager');
  assert.equal(firstPack.coveredCount + firstPack.gapCount, firstPack.items.length);
  assert.deepEqual(
    Object.fromEntries(firstPack.excludedStories.map(item => [item.storyId, item.reason])),
    {
      [draft.id]: 'draft_only',
      [retired.id]: 'retired',
      [stale.id]: 'proof_stale',
    },
  );
  const covered = firstPack.items.find(item => item.questionId === sourced.id);
  assert.equal(covered.coverageStatus, 'covered');
  assert.equal(covered.storyId, eligible.id);
  assert.equal(covered.storyRevisionId, eligible.activeVerifiedRevision.id);
  assert.equal(covered.storySnapshot.id, eligible.id);
  assert.equal(covered.storySnapshot.revision.id, eligible.activeVerifiedRevision.id);
  assert.equal(covered.storySnapshot.revision.state, 'verified');
  assert.deepEqual(
    covered.proofSnapshots.map(snapshot => snapshot.id),
    ['proof_w07_active'],
  );
  assert.ok(covered.matchScore >= 3);
  assert.ok(covered.matchReasons.codes.length > 0);
  assert.equal(covered.questionOrigin, 'sourced');
  assert.deepEqual(covered.questionSource, questions.questions[0].source);
  assert.ok(firstPack.items.some(item => item.coverageStatus === 'gap'));
  assert.ok(firstPack.items.filter(item => item.coverageStatus === 'gap')
    .every(item => item.storyId === null
      && item.storyRevisionId === null
      && item.matchReasons.gapReason));
  assert.ok(firstPack.warnings.some(warning => warning.code === 'excluded_story'
    && warning.storyId === stale.id
    && warning.staleProofPointIds.includes('proof_w07_superseding')));
  assert.ok(firstPack.warnings.some(warning => warning.code === 'excluded_proof'));

  const projected = YAML.parse(readFileSync(packQuestionMirrorPath(root), 'utf8'));
  assert.equal(projected.schema, interview.INTERVIEW_QUESTION_SCHEMA);
  assert.equal(projected.version, 1);
  assert.equal(projected.jobId, 'job_w07_alpha');
  assert.equal(projected.policy.canonicalStore, 'sqlite');
  assert.equal(projected.policy.currentOnly, true);
  assert.equal(projected.policy.stableKey, 'id');
  assert.deepEqual(projected.questions.map(question => question.id), [sourced.id]);
  assert.ok(projected.questions.every(question => question.current));
  assert.ok(projected.questions.every(question => !('origin' in question)));
  const mirrorBytes = readFileSync(packQuestionMirrorPath(root));
  const replay = interview.createInterviewQuestionSource(store, questionInput({
    questionText: 'Tell me about a time you led delivery through a fixed deadline.',
  }));
  assert.equal(replay.idempotent, true);
  assert.deepEqual(readFileSync(packQuestionMirrorPath(root)), mirrorBytes);
  const listedBeforeReopen = interview.listInterviewQuestionSources(store, {
    profileId: 'profile_w07_alpha',
    jobId: 'job_w07_alpha',
  });
  save(store);
  store.db.close();
  const reopened = await openStore({ workspace: root });
  const listedAfterReopen = interview.listInterviewQuestionSources(reopened, {
    profileId: 'profile_w07_alpha',
    jobId: 'job_w07_alpha',
  });
  assert.deepEqual(listedAfterReopen, listedBeforeReopen);
  assert.deepEqual(
    YAML.parse(readFileSync(packQuestionMirrorPath(root), 'utf8')),
    projected,
  );
  assert.deepEqual(readFileSync(packQuestionMirrorPath(root)), mirrorBytes);
});

test('W07-REUSE-01 persisted packs reuse one canonical verified revision across applications', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  addSecondAlphaApplication(store);
  const story = createVerifiedStory(store, {
    title: 'Reusable delivery story',
  });
  const storyCount = one(store, 'SELECT COUNT(*) AS count FROM interview_stories').count;
  const prior = getArtifact(store, 'artifact_w07_interview_1');
  const priorContent = prior.content;

  const first = await interview.prepInterview(
    store,
    'application_w07_alpha',
    'hiring-manager',
    { audience: 'hiring_manager' },
  );
  const second = await interview.prepInterview(
    store,
    'application_w07_alpha_second',
    'hiring-manager',
    { audience: 'hiring_manager' },
  );
  for (const result of [first, second]) {
    assert.equal(result.type, 'interview_prep');
    assert.equal(result.approvalStatus, 'draft_needs_human_review');
    assert.equal(result.stage, 'hiring-manager');
    assert.equal(result.pack.schema, interview.INTERVIEW_PACK_SCHEMA);
    assert.equal(result.pack.artifactId, result.id);
    assert.equal(result.pack.artifactRevision, result.revision);
    assert.equal(result.pack.deterministic, true);
    assert.ok(result.path.endsWith('/artifacts/interview-prep-hiring-manager.md'));
    assert.match(result.content, /STAR story/);
    assert.match(result.content, /Questions to ask the interviewer/);
    assert.match(result.content, /did not contact the company/);
    assert.match(result.content, /proof_/);
    assert.match(result.content, /Role-specific|Likely interview questions/);
    assert.match(result.content, /\[(?:sourced|inferred)\]/);
    assert.match(result.content, new RegExp(story.id));
    assert.match(result.content, new RegExp(story.activeVerifiedRevision.id));
    assert.match(result.content, /Match reasons:/);
    assert.match(result.content, /Coverage gaps/);
    assert.deepEqual(result.evidence, result.pack.items);
  }
  assert.equal(first.seriesKey, 'interview_prep:application_w07_alpha:hiring-manager');
  assert.equal(first.revision, 3);
  assert.equal(second.seriesKey, 'interview_prep:application_w07_alpha_second:hiring-manager');
  assert.equal(second.revision, 1);
  assert.equal(getArtifact(store, 'artifact_w07_interview_1').content, priorContent);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM interview_stories').count, storyCount);

  const firstRows = all(store, `SELECT * FROM interview_pack_items
    WHERE artifact_id=? ORDER BY position`, [first.id]);
  const secondRows = all(store, `SELECT * FROM interview_pack_items
    WHERE artifact_id=? ORDER BY position`, [second.id]);
  const firstStoryRows = firstRows.filter(row => row.story_id === story.id);
  const secondStoryRows = secondRows.filter(row => row.story_id === story.id);
  assert.ok(firstStoryRows.length > 0);
  assert.ok(secondStoryRows.length > 0);
  assert.ok([...firstStoryRows, ...secondStoryRows]
    .every(row => row.story_revision_id === story.activeVerifiedRevision.id));
  for (const [result, rows] of [[first, firstRows], [second, secondRows]]) {
    assert.equal(rows.length, result.pack.items.length);
    assert.deepEqual(rows.map(row => row.question_id), result.pack.items.map(item => item.questionId));
    assert.deepEqual(
      rows.map(row => JSON.parse(row.match_reasons_json)),
      result.pack.items.map(item => item.matchReasons),
    );
    assert.deepEqual(
      rows.map(row => JSON.parse(row.alternative_matches_json)),
      result.pack.items.map(item => item.alternativeMatches),
    );
  }
});

test('W07-PREP-COMPAT-01 positional legacy prep keeps contracts and pack persistence is atomic', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const result = await interview.prepInterview(
    store,
    'application_w07_alpha',
    'hiring-manager',
  );
  assert.equal(result.applicationId, 'application_w07_alpha');
  assert.equal(result.jobId, 'job_w07_alpha');
  assert.equal(result.profileId, 'profile_w07_alpha');
  assert.equal(result.stage, 'hiring-manager');
  assert.equal(result.pack.audience, 'hiring_manager');
  assert.equal(result.type, 'interview_prep');
  assert.equal(result.path, 'jobs/job_w07_alpha/artifacts/interview-prep-hiring-manager.md');
  assert.equal(result.seriesKey, 'interview_prep:application_w07_alpha:hiring-manager');
  assert.equal(result.revision, 3);
  assert.equal(result.approvalStatus, 'draft_needs_human_review');
  assert.match(result.content, /STAR story/);
  assert.match(result.content, /Questions to ask the interviewer/);
  assert.match(result.content, /did not contact the company/);
  assert.match(result.content, /proof_/);
  assert.match(result.content, /Role-specific|Likely interview questions/);
  assert.match(result.content, /\[inferred\]/);
  assert.match(result.content, /Coverage gaps/);
  assert.match(result.content, /Excluded proof warning/);
  assert.ok(result.pack.items.every(item => item.coverageStatus === 'gap'));
  assert.ok(result.pack.items.every(item => item.storyId === null));
  assert.ok(result.pack.warnings.some(warning => warning.code === 'proof_not_interview_story'));
  assert.deepEqual(
    all(store, `SELECT coverage_status,story_id,story_revision_id FROM interview_pack_items
      WHERE artifact_id=? ORDER BY position`, [result.id]),
    result.pack.items.map(item => ({
      coverage_status: item.coverageStatus,
      story_id: null,
      story_revision_id: null,
    })),
  );
  assert.equal(getArtifact(store, 'artifact_w07_interview_2').revision, 2);

  const artifactMirror = path.join(root, 'jobos-workspace', result.path);
  const state = () => ({
    artifacts: all(store, 'SELECT * FROM artifacts ORDER BY id'),
    packItems: all(store, 'SELECT * FROM interview_pack_items ORDER BY artifact_id,position'),
    audit: all(store, 'SELECT * FROM audit_log ORDER BY id'),
    artifactMirror: readFileSync(artifactMirror),
    questionMirror: existsSync(packQuestionMirrorPath(root))
      ? readFileSync(packQuestionMirrorPath(root))
      : null,
    jobMirror: optionalBytes(jobMirrorPath(root)),
    applicationMirror: optionalBytes(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml')),
  });
  store.db.run(`CREATE TRIGGER fail_interview_pack_insert
    BEFORE INSERT ON interview_pack_items
    BEGIN SELECT RAISE(ABORT, 'induced pack mutation failure'); END`);
  save(store);
  const beforeFailure = state();
  await assert.rejects(
    () => interview.prepInterview(store, 'application_w07_alpha', 'hiring-manager'),
    /induced pack mutation failure/,
  );
  assert.deepEqual(state(), beforeFailure);
  assert.deepEqual(optionalBytes(jobMirrorPath(root)), beforeFailure.jobMirror);
  assert.deepEqual(
    optionalBytes(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml')),
    beforeFailure.applicationMirror,
  );
});

test('W07-PREP-COMPAT-02 omitted stage and options preserve interview defaults', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const result = await interview.prepInterview(store, 'application_w07_alpha');

  assert.equal(result.stage, 'interview');
  assert.equal(result.audience, 'unknown');
  assert.equal(result.pack.stage, 'interview');
  assert.equal(result.pack.audience, 'unknown');
  assert.equal(result.path, 'jobs/job_w07_alpha/artifacts/interview-prep-interview.md');
  assert.equal(result.seriesKey, 'interview_prep:application_w07_alpha:interview');
  assert.equal(result.revision, 1);
  assert.equal(result.approvalStatus, 'draft_needs_human_review');
  assert.match(result.content, /STAR story/);
  assert.match(result.content, /Questions to ask the interviewer/);
  assert.match(result.content, /did not contact the company/);
  assert.match(result.content, /proof_/);
  assert.match(result.content, /Role-specific|Likely interview questions/);

  const packRows = all(store, `SELECT * FROM interview_pack_items
    WHERE artifact_id=? ORDER BY position`, [result.id]);
  assert.equal(packRows.length, result.pack.items.length);
  assert.ok(packRows.length > 0);
  assert.deepEqual(
    packRows.map(row => row.question_id),
    result.pack.items.map(item => item.questionId),
  );
  assert.ok(packRows.every(row => row.interview_stage === 'interview'));
  assert.ok(packRows.every(row => row.audience === 'unknown'));
});

test('W07-PREP-MIRROR-01 prep-only persistence refreshes links/counts mirrors after pack commit', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  assert.equal(all(store, 'SELECT id FROM interview_debriefs').length, 0);

  const prep = await interview.prepInterview(
    store,
    'application_w07_alpha',
    'hiring-manager',
    { audience: 'hiring_manager' },
  );
  const expectedKeys = [
    'coveredCount',
    'currentW06Action',
    'gapCount',
    'latestDebriefId',
    'latestDebriefRevision',
    'latestPrepArtifactId',
  ];
  const jobMirror = YAML.parse(readFileSync(jobMirrorPath(root), 'utf8'));
  const applicationMirror = YAML.parse(readFileSync(
    jobMirrorPath(root, 'job_w07_alpha', 'application.yaml'),
    'utf8',
  ));
  for (const mirror of [jobMirror, applicationMirror]) {
    assert.deepEqual(Object.keys(mirror.interview).sort(), expectedKeys);
    assert.equal(mirror.interview.latestPrepArtifactId, prep.id);
    assert.equal(mirror.interview.coveredCount, prep.pack.coveredCount);
    assert.equal(mirror.interview.gapCount, prep.pack.gapCount);
    assert.equal(mirror.interview.latestDebriefId, null);
    assert.equal(mirror.interview.latestDebriefRevision, null);
    assert.doesNotMatch(JSON.stringify(mirror.interview), /STAR story|Private debrief|evidence|warnings/i);
  }
});

const DEBRIEF_TABLES = Object.freeze([
  'interview_debriefs',
  'interview_debrief_revisions',
]);
const DEBRIEF_PROVENANCE_FIELDS = Object.freeze([
  'observedQuestions',
  'observedOutcome',
  'proofGaps',
  'storyUses',
  'notes',
]);

function debriefMirrorPath(root, jobId = 'job_w07_alpha') {
  return path.join(root, 'jobos-workspace', 'jobs', jobId, 'interviews', 'debriefs.yaml');
}

function observationMirrorPath(root, profileId = 'profile_w07_alpha') {
  return path.join(root, 'jobos-workspace', 'profiles', profileId, 'interviews', 'observations.yaml');
}

function jobMirrorPath(root, jobId = 'job_w07_alpha', file = 'job.yaml') {
  return path.join(root, 'jobos-workspace', 'jobs', jobId, file);
}

function optionalBytes(file) {
  return existsSync(file) ? readFileSync(file) : null;
}

function debriefState(store, root) {
  return {
    debriefs: all(store, 'SELECT * FROM interview_debriefs ORDER BY id'),
    revisions: all(store, 'SELECT * FROM interview_debrief_revisions ORDER BY debrief_id,revision,id'),
    tasks: all(store, 'SELECT * FROM tasks ORDER BY id'),
    audit: all(store, 'SELECT * FROM audit_log ORDER BY id'),
    debriefMirror: optionalBytes(debriefMirrorPath(root)),
    observationMirror: optionalBytes(observationMirrorPath(root)),
    jobMirror: optionalBytes(jobMirrorPath(root)),
    applicationMirror: optionalBytes(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml')),
  };
}

function debriefFieldProvenance(source = 'cli') {
  return Object.fromEntries(DEBRIEF_PROVENANCE_FIELDS.map(field => [
    field,
    {
      origin: 'user',
      actor: 'candidate',
      source,
      sourceRef: null,
    },
  ]));
}

function debriefInput(story, overrides = {}) {
  const profileId = overrides.profileId || 'profile_w07_alpha';
  const referenceId = overrides.referenceId === undefined
    ? 'interview-debrief-alpha-01'
    : overrides.referenceId;
  const debriefId = deterministicId('interview_debrief', `${profileId}:${referenceId}`);
  const questionId = `debrief.${debriefId}.1.0`;
  return {
    profileId,
    jobId: 'job_w07_alpha',
    applicationId: 'application_w07_alpha',
    interviewStage: 'hiring-manager',
    audience: 'hiring_manager',
    referenceId,
    occurredAt: '2026-07-22T16:30:00Z',
    actor: 'candidate',
    source: 'cli',
    observedQuestions: [{
      text: 'How did you align fragmented owners around the launch deadline?',
      askedByAudience: 'hiring_manager',
      source: 'user_observed',
    }],
    observedOutcome: {
      type: 'advanced',
      note: 'The interviewer described the next panel stage.',
    },
    proofGaps: [{
      id: 'gap.metric-specificity',
      type: 'weak_metric',
      text: 'The adoption metric needed a clearer measurement window.',
      questionId,
      storyId: story.id,
      proofPointId: 'proof_w07_active',
    }],
    storyUses: [{
      storyId: story.id,
      storyRevisionId: story.activeVerifiedRevision.id,
      questionId,
      adaptationNote: 'Shortened the situation and expanded the dependency tradeoff.',
    }],
    notes: 'Private debrief note: revisit the measurement window before the panel.',
    fieldProvenance: debriefFieldProvenance(),
    ...overrides,
  };
}

function correctionInput(story, recorded, overrides = {}) {
  const revision = Number(overrides.targetRevision || recorded.currentRevision.revision);
  const questionId = `debrief.${recorded.id}.${revision + 1}.0`;
  const input = debriefInput(story, {
    debriefId: recorded.id,
    referenceId: recorded.referenceId,
    targetRevision: revision,
    reason: 'Corrected the observed outcome after reviewing contemporaneous notes.',
    occurredAt: '2026-07-22T16:45:00Z',
    observedQuestions: [{
      text: 'How did you align fragmented owners around the launch deadline?',
      askedByAudience: 'hiring_manager',
      source: 'user_observed',
    }],
    observedOutcome: {
      type: 'no_change',
      note: 'The interviewer said the team would finish the remaining interviews first.',
    },
    proofGaps: [{
      id: 'gap.metric-specificity',
      type: 'weak_metric',
      text: 'The adoption metric needed a clearer measurement window.',
      questionId,
      storyId: story.id,
      proofPointId: 'proof_w07_active',
    }],
    storyUses: [{
      storyId: story.id,
      storyRevisionId: story.activeVerifiedRevision.id,
      questionId,
      adaptationNote: 'Shortened the situation and expanded the dependency tradeoff.',
    }],
    notes: 'Private corrected debrief note: no next stage was promised.',
    ...overrides,
  });
  delete input.debriefId;
  delete input.targetRevision;
  return {
    ...input,
    debriefId: recorded.id,
    targetRevision: revision,
    reason: overrides.reason || 'Corrected the observed outcome after reviewing contemporaneous notes.',
  };
}

function assertRejectedWithoutDebriefDelta(store, root, action, expectedCode) {
  const before = debriefState(store, root);
  assert.throws(
    action,
    error => error instanceof interview.InterviewError && error.code === expectedCode,
  );
  assert.deepEqual(debriefState(store, root), before);
}

test('W07-DEBRIEF-01 records one owned attributed revision and emits the exact W06 handoff', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store);
  const input = debriefInput(story);
  const expectedDebriefId = deterministicId(
    'interview_debrief',
    'profile_w07_alpha:interview-debrief-alpha-01',
  );
  const expectedQuestionId = `debrief.${expectedDebriefId}.1.0`;
  const recorded = interview.recordInterviewDebrief(store, input);

  assert.equal(recorded.schema, interview.INTERVIEW_DEBRIEF_SCHEMA);
  assert.equal(recorded.version, 1);
  assert.equal(recorded.id, expectedDebriefId);
  assert.equal(recorded.profileId, 'profile_w07_alpha');
  assert.equal(recorded.jobId, 'job_w07_alpha');
  assert.equal(recorded.applicationId, 'application_w07_alpha');
  assert.equal(recorded.interviewStage, 'hiring-manager');
  assert.equal(recorded.audience, 'hiring_manager');
  assert.equal(recorded.referenceId, input.referenceId);
  assert.equal(recorded.idempotent, false);
  assert.equal(recorded.exactReplay, false);
  assert.equal(recorded.currentRevision.revision, 1);
  assert.equal(recorded.currentRevision.current, true);
  assert.deepEqual(recorded.currentRevision.observedQuestions, [{
    id: expectedQuestionId,
    text: input.observedQuestions[0].text,
    askedByAudience: 'hiring_manager',
    source: 'user_observed',
  }]);
  assert.deepEqual(recorded.currentRevision.observedOutcome, input.observedOutcome);
  assert.deepEqual(recorded.currentRevision.proofGaps, input.proofGaps);
  assert.deepEqual(recorded.currentRevision.storyUses, input.storyUses);
  assert.equal(recorded.currentRevision.notes, input.notes);
  assert.deepEqual(recorded.currentRevision.fieldProvenance, input.fieldProvenance);
  assert.deepEqual(recorded.lifecycleTrigger, {
    schema: 'jobos.lifecycle-event-input.v1',
    profileId: 'profile_w07_alpha',
    applicationId: 'application_w07_alpha',
    eventId: expectedDebriefId,
    eventType: 'interview_debrief_recorded',
    occurredAt: '2026-07-22T16:30:00.000Z',
    stage: 'interview',
  });
  assert.equal(recorded.action.actionCode, 'follow-up-after-interview');
  assert.equal(recorded.action.sourceEvent.id, expectedDebriefId);
  assert.equal(recorded.action.sourceEvent.type, 'interview_debrief_recorded');
  assert.equal(all(store, `SELECT * FROM tasks
    WHERE application_id=? AND status='open' AND action_code='follow-up-after-interview'`, [
    input.applicationId,
  ]).length, 1);

  const row = one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=?', [
    expectedDebriefId,
  ]);
  assert.equal(row.revision, 1);
  assert.equal(row.profile_id, 'profile_w07_alpha');
  assert.deepEqual(JSON.parse(row.observed_questions_json), recorded.currentRevision.observedQuestions);
  assert.deepEqual(JSON.parse(row.proof_gaps_json), recorded.currentRevision.proofGaps);
  assert.deepEqual(JSON.parse(row.story_uses_json), recorded.currentRevision.storyUses);
});

test('W07-DEBRIEF-02 rejects invalid ownership, provenance, shapes, links, duplicates, and reference conflicts with zero delta', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store, { title: 'Primary debrief story' });
  const otherStory = createVerifiedStory(store, { title: 'Other debrief story' });
  const betaStory = createVerifiedStory(store, {
    profileId: 'profile_w07_beta',
    proofPointId: 'proof_w07_beta_active',
    title: 'Cross-profile debrief story',
  });
  addSecondAlphaApplication(store);
  const valid = debriefInput(story);
  const questionId = valid.proofGaps[0].questionId;

  for (const [input, code] of [
    [{ ...valid, profileId: 'profile_w07_beta' }, 'interview_job_profile_mismatch'],
    [{ ...valid, jobId: 'job_w07_beta' }, 'interview_job_profile_mismatch'],
    [{
      ...valid,
      jobId: 'job_w07_alpha_second',
      applicationId: 'application_w07_alpha',
    }, 'interview_application_job_mismatch'],
    [{
      ...valid,
      storyUses: [{
        ...valid.storyUses[0],
        storyRevisionId: otherStory.activeVerifiedRevision.id,
      }],
    }, 'interview_story_revision_mismatch'],
    [{
      ...valid,
      proofGaps: [{
        ...valid.proofGaps[0],
        proofPointId: 'proof_w07_beta_active',
      }],
    }, 'interview_proof_point_profile_mismatch'],
    [{ ...valid, occurredAt: '2026-07-22' }, 'interview_occurred_at_invalid'],
    [{ ...valid, occurredAt: '2999-01-01T00:00:00Z' }, 'interview_debrief_occurred_at_future'],
    [{ ...valid, source: 'mcp' }, 'interview_debrief_source_untrusted'],
    [{ ...valid, fieldProvenance: undefined }, 'interview_debrief_field_provenance_invalid'],
    [{
      ...valid,
      fieldProvenance: {
        ...valid.fieldProvenance,
        notes: { ...valid.fieldProvenance.notes, origin: 'agent' },
      },
    }, 'interview_debrief_field_provenance_invalid'],
    [{
      ...valid,
      observedOutcome: { type: 'maybe', note: '' },
    }, 'interview_observed_outcome_type_invalid'],
    [{ ...valid, observedQuestions: {} }, 'interview_observed_questions_shape_invalid'],
    [{
      ...valid,
      observedQuestions: [valid.observedQuestions[0], { ...valid.observedQuestions[0] }],
    }, 'interview_observed_question_duplicate'],
    [{
      ...valid,
      proofGaps: [valid.proofGaps[0], { ...valid.proofGaps[0] }],
    }, 'interview_proof_gap_duplicate'],
    [{
      ...valid,
      storyUses: [valid.storyUses[0], { ...valid.storyUses[0] }],
    }, 'interview_story_use_duplicate'],
    [{
      ...valid,
      storyUses: [{ ...valid.storyUses[0], questionId: `${questionId}.unknown` }],
    }, 'interview_debrief_question_link_invalid'],
    [{
      ...valid,
      proofGaps: [{
        ...valid.proofGaps[0],
        storyId: betaStory.id,
      }],
    }, 'interview_story_profile_mismatch'],
  ]) {
    assertRejectedWithoutDebriefDelta(
      store,
      root,
      () => interview.recordInterviewDebrief(store, input),
      code,
    );
  }

  const recorded = interview.recordInterviewDebrief(store, valid);
  assert.equal(recorded.idempotent, false);
  assertRejectedWithoutDebriefDelta(
    store,
    root,
    () => interview.recordInterviewDebrief(store, {
      ...valid,
      notes: 'Conflicting content for the same external reference.',
    }),
    'interview_debrief_reference_conflict',
  );
});

test('W07-DEBRIEF-03 exact replay is write-free and correction is append-only, branchless, and preserves manual W06 scheduling', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store);
  addSecondAlphaApplication(store);
  const input = debriefInput(story);
  const recorded = interview.recordInterviewDebrief(store, input);
  const revisionOne = one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=? AND revision=1', [
    recorded.id,
  ]);
  const beforeReplay = debriefState(store, root);
  await new Promise(resolve => setTimeout(resolve, 8));
  const replay = interview.recordInterviewDebrief(store, input);
  assert.equal(replay.id, recorded.id);
  assert.equal(replay.currentRevision.id, recorded.currentRevision.id);
  assert.equal(replay.action.id, recorded.action.id);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.exactReplay, true);
  assert.deepEqual(debriefState(store, root), beforeReplay);

  const manual = rescheduleApplicationNextAction(store, {
    taskId: recorded.action.id,
    profileId: recorded.profileId,
    dueAt: '2026-08-05T09:30:00Z',
    reason: 'The interviewer requested a later follow-up.',
    actor: 'candidate',
    source: 'cli',
    nowDate: new Date('2026-07-23T09:00:00.000Z'),
  });
  assert.equal(manual.scheduleSource, 'manual');
  await new Promise(resolve => setTimeout(resolve, 8));
  const correction = correctionInput(story, recorded);
  const corrected = interview.correctInterviewDebrief(store, correction);
  assert.equal(corrected.id, recorded.id);
  assert.equal(corrected.currentRevision.revision, 2);
  assert.equal(corrected.currentRevision.supersedesRevisionId, recorded.currentRevision.id);
  assert.equal(corrected.currentRevision.correctionReason, correction.reason);
  assert.equal(corrected.currentRevision.current, true);
  assert.equal(corrected.history[0].current, false);
  assert.equal(corrected.action.id, recorded.action.id);
  assert.equal(corrected.action.scheduleSource, 'manual');
  assert.equal(corrected.action.dueAt, '2026-08-05T09:30:00.000Z');
  assert.equal(corrected.action.manualRescheduleReason, 'The interviewer requested a later follow-up.');
  assert.deepEqual(
    one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=? AND revision=1', [
      recorded.id,
    ]),
    revisionOne,
  );
  assert.equal(all(store, `SELECT * FROM tasks
    WHERE application_id=? AND status='open' AND action_code='follow-up-after-interview'`, [
    recorded.applicationId,
  ]).length, 1);

  const beforeCorrectionReplay = debriefState(store, root);
  await new Promise(resolve => setTimeout(resolve, 8));
  const correctionReplay = interview.correctInterviewDebrief(store, correction);
  assert.equal(correctionReplay.idempotent, true);
  assert.equal(correctionReplay.exactReplay, true);
  assert.equal(correctionReplay.currentRevision.id, corrected.currentRevision.id);
  assert.deepEqual(debriefState(store, root), beforeCorrectionReplay);

  assertRejectedWithoutDebriefDelta(
    store,
    root,
    () => interview.correctInterviewDebrief(store, {
      ...correction,
      notes: 'A branched correction must not be accepted.',
    }),
    'interview_debrief_revision_not_current',
  );
  assertRejectedWithoutDebriefDelta(
    store,
    root,
    () => interview.correctInterviewDebrief(store, {
      ...correction,
      proofGaps: [{
        ...correction.proofGaps[0],
        proofPointId: 'proof_w07_beta_active',
      }],
    }),
    'interview_proof_point_profile_mismatch',
  );
  assertRejectedWithoutDebriefDelta(
    store,
    root,
    () => interview.correctInterviewDebrief(store, {
      ...correction,
      profileId: 'profile_w07_beta',
    }),
    'interview_debrief_profile_mismatch',
  );
  for (const override of [
    { interviewStage: 'onsite' },
    { audience: 'peer_panel' },
    {
      jobId: 'job_w07_alpha_second',
      applicationId: 'application_w07_alpha_second',
    },
  ]) {
    assertRejectedWithoutDebriefDelta(
      store,
      root,
      () => interview.correctInterviewDebrief(store, { ...correction, ...override }),
      'interview_debrief_ownership_mismatch',
    );
  }
  const thirdInput = correctionInput(story, corrected, {
    targetRevision: 2,
    reason: 'Added the final panel scheduling detail from the same notes.',
    occurredAt: '2026-07-22T16:50:00Z',
    observedOutcome: {
      type: 'advanced',
      note: 'The coordinator later confirmed the panel scheduling step.',
    },
    notes: 'Private revision three note: panel scheduling was later confirmed.',
  });
  const revisionThree = interview.correctInterviewDebrief(store, thirdInput);
  assert.equal(revisionThree.currentRevision.revision, 3);
  assert.equal(revisionThree.currentRevision.supersedesRevisionId, corrected.currentRevision.id);
  const beforeIntermediateReplay = debriefState(store, root);
  await new Promise(resolve => setTimeout(resolve, 8));
  const intermediateReplay = interview.correctInterviewDebrief(store, correction);
  assert.equal(intermediateReplay.idempotent, true);
  assert.equal(intermediateReplay.exactReplay, true);
  assert.equal(intermediateReplay.currentRevision.id, revisionThree.currentRevision.id);
  assert.equal(intermediateReplay.currentRevision.revision, 3);
  assert.deepEqual(debriefState(store, root), beforeIntermediateReplay);
  assertRejectedWithoutDebriefDelta(
    store,
    root,
    () => interview.correctInterviewDebrief(store, {
      ...correction,
      notes: 'A stale conflicting branch after revision three.',
    }),
    'interview_debrief_revision_not_current',
  );
});

test('W07-DEBRIEF-04 exposes deterministic current/history W08-safe projections and links/counts-only mirrors', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store);
  const prep = await interview.prepInterview(
    store,
    'application_w07_alpha',
    'hiring-manager',
    { audience: 'hiring_manager' },
  );
  const recorded = interview.recordInterviewDebrief(store, debriefInput(story));
  const corrected = interview.correctInterviewDebrief(
    store,
    correctionInput(story, recorded),
  );

  const shown = interview.getInterviewDebrief(store, {
    profileId: recorded.profileId,
    debriefId: recorded.id,
    includeHistory: true,
  });
  const { idempotent: correctedIdempotent, exactReplay: correctedReplay, ...correctedProjection } = corrected;
  assert.equal(correctedIdempotent, false);
  assert.equal(correctedReplay, false);
  assert.deepEqual(shown, correctedProjection);
  const listed = interview.listInterviewDebriefs(store, {
    profileId: recorded.profileId,
    applicationId: recorded.applicationId,
    includeHistory: true,
  });
  assert.equal(listed.schema, interview.INTERVIEW_DEBRIEF_LIST_SCHEMA);
  assert.equal(listed.version, 1);
  assert.equal(listed.profileId, recorded.profileId);
  assert.equal(listed.applicationId, recorded.applicationId);
  assert.deepEqual(listed.debriefs, [shown]);
  assert.equal(listed.debriefs[0].history.length, 2);
  assert.equal(listed.debriefs[0].history[0].current, false);
  assert.equal(listed.debriefs[0].history[1].current, true);

  const nowDate = new Date('2026-07-24T12:00:00.000Z');
  const observations = interview.listInterviewObservations(store, {
    profileId: recorded.profileId,
    sinceDays: 30,
    nowDate,
  });
  assert.equal(observations.schema, interview.INTERVIEW_OBSERVATION_LIST_SCHEMA);
  assert.equal(observations.observationSchema, interview.INTERVIEW_OBSERVATION_SCHEMA);
  assert.equal(observations.profileId, recorded.profileId);
  assert.deepEqual(observations.period, {
    start: '2026-06-24T12:00:00.000Z',
    end: '2026-07-24T12:00:00.000Z',
  });
  assert.deepEqual(observations.observations.map(item => item.id), [
    `${recorded.id}:1`,
    `${recorded.id}:2`,
  ]);
  assert.deepEqual(observations.observations.map(item => item.current), [false, true]);
  assert.ok(observations.observations.every(item => item.interpretation
    === 'attributed_observation_only_no_preference_or_causal_claim'));
  assert.ok(observations.observations.every(item => item.externalSideEffects === 'none'));
  assert.deepEqual(observations.observations[1].sourceEntity, {
    type: 'interview_debrief',
    id: recorded.id,
    versionId: corrected.currentRevision.id,
    revision: 2,
    supersedesVersionId: recorded.currentRevision.id,
  });
  const forbiddenObservationKeys = new Set([
    'preference',
    'recommendation',
    'confidence',
    'causality',
    'guidance',
    'activation',
    'inferredReason',
    'notes',
  ]);
  for (const observation of observations.observations) {
    for (const key of Object.keys(observation)) {
      assert.equal(forbiddenObservationKeys.has(key), false, `W08-safe observation leaked ${key}`);
    }
  }
  const excluded = interview.listInterviewObservations(store, {
    profileId: recorded.profileId,
    sinceDays: 1,
    nowDate,
  });
  assert.deepEqual(excluded.period, {
    start: '2026-07-23T12:00:00.000Z',
    end: '2026-07-24T12:00:00.000Z',
  });
  assert.deepEqual(excluded.observations, []);
  for (const sinceDays of [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => interview.listInterviewObservations(store, {
        profileId: recorded.profileId,
        sinceDays,
        nowDate,
      }),
      error => error instanceof interview.InterviewError
        && error.code === 'interview_observation_since_invalid',
    );
  }
  assert.throws(
    () => interview.listInterviewObservations(store, {
      profileId: recorded.profileId,
      sinceDays: 1,
      nowDate: new Date('invalid'),
    }),
    error => error instanceof interview.InterviewError
      && error.code === 'interview_observation_now_invalid',
  );
  assert.throws(
    () => interview.getInterviewDebrief(store, {
      profileId: 'profile_w07_beta',
      debriefId: recorded.id,
    }),
    error => error instanceof interview.InterviewError
      && error.code === 'interview_debrief_profile_mismatch',
  );
  assert.throws(
    () => interview.listInterviewDebriefs(store, {
      profileId: 'profile_w07_beta',
      applicationId: recorded.applicationId,
    }),
    error => error instanceof interview.InterviewError
      && error.code === 'interview_job_profile_mismatch',
  );

  const debriefMirror = YAML.parse(readFileSync(debriefMirrorPath(root), 'utf8'));
  assert.equal(debriefMirror.schema, interview.INTERVIEW_DEBRIEF_LIST_SCHEMA);
  assert.equal(debriefMirror.policy.canonicalStore, 'sqlite');
  assert.equal(debriefMirror.policy.appendOnlyRevisions, true);
  assert.deepEqual(debriefMirror.debriefs, listed.debriefs);
  const observationMirror = YAML.parse(readFileSync(observationMirrorPath(root), 'utf8'));
  assert.equal(observationMirror.schema, interview.INTERVIEW_OBSERVATION_LIST_SCHEMA);
  assert.equal(observationMirror.policy.interpretation, 'attributed_observations_only');
  assert.deepEqual(observationMirror.observations, observations.observations);

  const jobMirror = YAML.parse(readFileSync(jobMirrorPath(root), 'utf8'));
  const applicationMirror = YAML.parse(readFileSync(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml'), 'utf8'));
  for (const mirror of [jobMirror, applicationMirror]) {
    assert.equal(mirror.interview.latestPrepArtifactId, prep.id);
    assert.equal(mirror.interview.coveredCount, prep.pack.coveredCount);
    assert.equal(mirror.interview.gapCount, prep.pack.gapCount);
    assert.equal(mirror.interview.latestDebriefId, recorded.id);
    assert.equal(mirror.interview.latestDebriefRevision, 2);
    assert.equal(mirror.interview.currentW06Action.id, recorded.action.id);
    assert.doesNotMatch(JSON.stringify(mirror.interview), /Private (?:corrected )?debrief note/);
  }

  const debriefBytes = readFileSync(debriefMirrorPath(root));
  const observationBytes = readFileSync(observationMirrorPath(root));
  const jobBytes = readFileSync(jobMirrorPath(root));
  const applicationBytes = readFileSync(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml'));
  const replay = interview.correctInterviewDebrief(store, correctionInput(story, recorded));
  assert.equal(replay.exactReplay, true);
  assert.deepEqual(readFileSync(debriefMirrorPath(root)), debriefBytes);
  assert.deepEqual(readFileSync(observationMirrorPath(root)), observationBytes);
  assert.deepEqual(readFileSync(jobMirrorPath(root)), jobBytes);
  assert.deepEqual(
    readFileSync(jobMirrorPath(root, 'job_w07_alpha', 'application.yaml')),
    applicationBytes,
  );
  const beforeReopen = {
    shown,
    listed,
    observations,
    debriefBytes,
    observationBytes,
  };
  save(store);
  store.db.close();
  const reopened = await openStore({ workspace: root });
  assert.deepEqual(interview.getInterviewDebrief(reopened, {
    profileId: recorded.profileId,
    debriefId: recorded.id,
    includeHistory: true,
  }), beforeReopen.shown);
  assert.deepEqual(interview.listInterviewDebriefs(reopened, {
    profileId: recorded.profileId,
    applicationId: recorded.applicationId,
    includeHistory: true,
  }), beforeReopen.listed);
  assert.deepEqual(interview.listInterviewObservations(reopened, {
    profileId: recorded.profileId,
    sinceDays: 30,
    nowDate,
  }), beforeReopen.observations);
  assert.deepEqual(readFileSync(debriefMirrorPath(root)), beforeReopen.debriefBytes);
  assert.deepEqual(readFileSync(observationMirrorPath(root)), beforeReopen.observationBytes);
});

test('W07-DEBRIEF-05 empty references never imply replay identity', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const story = createVerifiedStory(store);
  const input = debriefInput(story, {
    referenceId: '',
    proofGaps: [{
      id: 'gap.metric-specificity',
      type: 'weak_metric',
      text: 'The adoption metric needed a clearer measurement window.',
      questionId: null,
      storyId: story.id,
      proofPointId: 'proof_w07_active',
    }],
    storyUses: [{
      storyId: story.id,
      storyRevisionId: story.activeVerifiedRevision.id,
      questionId: null,
      adaptationNote: 'Shortened the situation and expanded the dependency tradeoff.',
    }],
  });
  const first = interview.recordInterviewDebrief(store, input);
  await new Promise(resolve => setTimeout(resolve, 8));
  const second = interview.recordInterviewDebrief(store, input);
  assert.notEqual(second.id, first.id);
  assert.equal(first.referenceId, '');
  assert.equal(second.referenceId, '');
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, false);
  assert.deepEqual(
    all(store, `SELECT id,reference_id FROM interview_debriefs
      WHERE profile_id=? ORDER BY created_at,id`, [first.profileId]),
    [
      { id: first.id, reference_id: '' },
      { id: second.id, reference_id: '' },
    ],
  );
});

test('W07-DEBRIEF-PACK-01 current same-profile observations feed later compatible packs deterministically', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  addSecondAlphaApplication(store);
  const story = createVerifiedStory(store, { title: 'Debrief feedback pack story' });
  const explicitText = 'How did you align fragmented owners around the launch deadline?';
  const explicit = interview.createInterviewQuestionSource(store, questionInput({
    jobId: 'job_w07_alpha_second',
    applicationId: 'application_w07_alpha_second',
    questionText: explicitText,
    sourceRef: 'later-application-explicit-question',
  }));

  const original = interview.recordInterviewDebrief(store, debriefInput(story, {
    referenceId: 'debrief-pack-primary',
    observedQuestions: [
      {
        text: explicitText,
        askedByAudience: 'hiring_manager',
        source: 'user_observed',
      },
      {
        text: 'Which launch tradeoff did you choose and why?',
        askedByAudience: 'hiring_manager',
        source: 'user_observed',
      },
    ],
  }));
  const corrected = interview.correctInterviewDebrief(store, correctionInput(story, original, {
    observedQuestions: [
      {
        text: explicitText,
        askedByAudience: 'hiring_manager',
        source: 'user_observed',
      },
      {
        text: 'How did you recover when the launch dependency failed?',
        askedByAudience: 'hiring_manager',
        source: 'user_observed',
      },
    ],
    proofGaps: [],
    storyUses: [],
  }));

  const wildcardSpecs = [
    {
      referenceId: 'debrief-pack-wildcard-a',
      text: 'What context would help an interviewer understand the result?',
    },
    {
      referenceId: 'debrief-pack-wildcard-b',
      text: 'What follow-up detail should be ready for any interviewer?',
    },
  ].map(spec => ({
    ...spec,
    debriefId: deterministicId(
      'interview_debrief',
      `profile_w07_alpha:${spec.referenceId}`,
    ),
  }));
  const wildcardDebriefs = new Map();
  for (const spec of [...wildcardSpecs].sort((left, right) => (
    right.debriefId.localeCompare(left.debriefId)
  ))) {
    const recorded = interview.recordInterviewDebrief(store, debriefInput(story, {
      referenceId: spec.referenceId,
      occurredAt: '2026-07-21T12:00:00Z',
      observedQuestions: [{
        text: spec.text,
        askedByAudience: 'unknown',
        source: 'user_observed',
      }],
      proofGaps: [],
      storyUses: [],
    }));
    wildcardDebriefs.set(recorded.id, recorded);
  }
  const recruiterDebrief = interview.recordInterviewDebrief(store, debriefInput(story, {
    referenceId: 'debrief-pack-recruiter',
    occurredAt: '2026-07-20T12:00:00Z',
    audience: 'recruiter',
    observedQuestions: [{
      text: 'Why are you interested in this role now?',
      askedByAudience: 'recruiter',
      source: 'user_observed',
    }],
    proofGaps: [],
    storyUses: [],
  }));
  const betaStory = createVerifiedStory(store, {
    profileId: 'profile_w07_beta',
    proofPointId: 'proof_w07_beta_active',
    title: 'Unrelated profile pack story',
  });
  const betaDebrief = interview.recordInterviewDebrief(store, debriefInput(betaStory, {
    profileId: 'profile_w07_beta',
    jobId: 'job_w07_beta',
    applicationId: 'application_w07_beta',
    referenceId: 'debrief-pack-beta',
    occurredAt: '2026-07-19T12:00:00Z',
    observedQuestions: [{
      text: 'This other profile question must never leak.',
      askedByAudience: 'hiring_manager',
      source: 'user_observed',
    }],
    proofGaps: [],
    storyUses: [],
  }));

  const beforeAssembly = debriefState(store, root);
  const hiringPack = interview.buildInterviewPack(store, {
    applicationId: 'application_w07_alpha_second',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
  });
  const unknownPack = interview.buildInterviewPack(store, {
    applicationId: 'application_w07_alpha_second',
    stage: 'interview',
    audience: 'unknown',
  });
  const executivePack = interview.buildInterviewPack(store, {
    applicationId: 'application_w07_alpha_second',
    stage: 'final',
    audience: 'executive',
  });
  assert.deepEqual(debriefState(store, root), beforeAssembly);

  assert.equal(hiringPack.questions[0].id, explicit.id);
  assert.equal(hiringPack.questions[0].origin, 'sourced');
  const hiringDebriefQuestions = hiringPack.questions.filter(question => (
    question.source?.sourceKind === 'debrief_observed'
  ));
  const orderedWildcardIds = [...wildcardDebriefs.keys()].sort();
  assert.deepEqual(hiringDebriefQuestions.map(question => question.id), [
    ...orderedWildcardIds.map(debriefId => `debrief.${debriefId}.1.0`),
    `debrief.${original.id}.2.1`,
  ]);
  assert.ok(hiringDebriefQuestions.every(question => (
    question.origin === 'sourced'
    && question.stage === 'hiring-manager'
    && question.audience === 'hiring_manager'
  )));
  const correctedQuestion = hiringDebriefQuestions.at(-1);
  assert.deepEqual(correctedQuestion.source, {
    sourceKind: 'debrief_observed',
    debriefId: original.id,
    debriefRevisionId: corrected.currentRevision.id,
    debriefRevision: 2,
    questionIndex: 1,
    profileId: original.profileId,
    jobId: original.jobId,
    applicationId: original.applicationId,
    interviewStage: original.interviewStage,
    debriefAudience: original.audience,
    askedByAudience: 'hiring_manager',
    occurredAt: corrected.currentRevision.occurredAt,
    recordedAt: corrected.currentRevision.recordedAt,
    actor: corrected.currentRevision.actor,
    source: corrected.currentRevision.source,
  });
  const hiringIds = new Set(hiringPack.questions.map(question => question.id));
  assert.equal(hiringIds.has(`debrief.${original.id}.1.0`), false);
  assert.equal(hiringIds.has(`debrief.${original.id}.1.1`), false);
  assert.equal(hiringIds.has(`debrief.${original.id}.2.0`), false);
  assert.equal(hiringIds.has(`debrief.${recruiterDebrief.id}.1.0`), false);
  assert.equal(hiringIds.has(`debrief.${betaDebrief.id}.1.0`), false);
  const firstInferredIndex = hiringPack.questions.findIndex(question => question.origin === 'inferred');
  assert.ok(firstInferredIndex > hiringDebriefQuestions.length);
  assert.ok(hiringPack.questions.slice(0, firstInferredIndex)
    .every(question => question.origin === 'sourced'));

  const unknownDebriefQuestions = unknownPack.questions.filter(question => (
    question.source?.sourceKind === 'debrief_observed'
  ));
  assert.deepEqual(unknownDebriefQuestions.map(question => question.id), [
    `debrief.${recruiterDebrief.id}.1.0`,
    ...orderedWildcardIds.map(debriefId => `debrief.${debriefId}.1.0`),
    `debrief.${original.id}.2.0`,
    `debrief.${original.id}.2.1`,
  ]);
  assert.equal(unknownDebriefQuestions.some(question => (
    question.source.debriefId === betaDebrief.id
  )), false);

  const executiveDebriefQuestions = executivePack.questions.filter(question => (
    question.source?.sourceKind === 'debrief_observed'
  ));
  assert.deepEqual(
    executiveDebriefQuestions.map(question => question.id),
    orderedWildcardIds.map(debriefId => `debrief.${debriefId}.1.0`),
  );

  save(store);
  store.db.close();
  const reopened = await openStore({ workspace: root });
  assert.deepEqual(interview.buildInterviewPack(reopened, {
    applicationId: 'application_w07_alpha_second',
    stage: 'hiring-manager',
    audience: 'hiring_manager',
  }), hiringPack);
  assert.deepEqual(interview.buildInterviewPack(reopened, {
    applicationId: 'application_w07_alpha_second',
    stage: 'interview',
    audience: 'unknown',
  }), unknownPack);
  assert.deepEqual(interview.buildInterviewPack(reopened, {
    applicationId: 'application_w07_alpha_second',
    stage: 'final',
    audience: 'executive',
  }), executivePack);
});

test('W07-CLI-01 exact registry and subprocess routes preserve usage, ownership, provenance, and history contracts', async t => {
  assert.deepEqual(
    commandRegistry.filter(command => command.name.startsWith('interview ')).map(command => command.name),
    INTERVIEW_COMMAND_NAMES,
  );
  const root = workspaceFromFixture(t);
  const missingFile = runW07Cli(root, [
    'interview', 'stories', 'create', '--profile', 'profile_w07_alpha',
  ]);
  assert.equal(missingFile.status, 2);
  assert.deepEqual(JSON.parse(missingFile.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: 'Missing --file <story.json>',
    },
  });
  const invalidFile = path.join(root, 'invalid-story.json');
  writeFileSync(invalidFile, '{"title":');
  const invalidJson = runW07Cli(root, [
    'interview', 'stories', 'create', '--profile', 'profile_w07_alpha',
    '--file', invalidFile,
  ]);
  assert.equal(invalidJson.status, 2);
  assert.deepEqual(JSON.parse(invalidJson.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: `Invalid JSON file ${invalidFile}: Unexpected end of JSON input`,
    },
  });

  const storyFile = writeJsonFixture(root, 'story.json', storyInput({
    profileId: 'profile_w07_beta',
    storyId: 'spoofed-story',
    source: 'acp',
  }));
  const created = cliJson(root, [
    'interview', 'stories', 'create', '--profile', 'profile_w07_alpha',
    '--file', storyFile,
  ]);
  assert.equal(created.profileId, 'profile_w07_alpha');
  assert.equal(created.currentRevision.actor, 'user');
  assert.equal(created.currentRevision.source, 'cli');
  assert.equal(created.currentRevision.revision, 1);

  const shown = cliJson(root, [
    'interview', 'stories', 'show', created.id, '--profile', 'profile_w07_alpha',
  ]);
  const { history: createdHistory, ...createdWithoutHistory } = created;
  assert.equal(createdHistory.length, 1);
  assert.deepEqual(shown, createdWithoutHistory);
  const verified = cliJson(root, [
    'interview', 'stories', 'verify', created.id, '--profile', 'profile_w07_alpha',
    '--revision', '1', '--confirm-fields', interview.INTERVIEW_STORY_CONTENT_FIELDS.join(','),
  ]);
  assert.equal(verified.currentRevision.revision, 2);
  assert.equal(verified.currentRevision.state, 'verified');
  assert.equal(verified.currentRevision.actor, 'user');
  assert.equal(verified.currentRevision.source, 'cli');

  const editFile = writeJsonFixture(root, 'story-edit.json', storyInput({
    profileId: 'profile_w07_beta',
    storyId: 'spoofed-story',
    title: 'Leading a platform launch under a fixed deadline',
    source: 'mcp',
  }));
  const edited = cliJson(root, [
    'interview', 'stories', 'edit', created.id, '--profile', 'profile_w07_alpha',
    '--file', editFile,
  ]);
  assert.equal(edited.currentRevision.revision, 3);
  assert.equal(edited.currentRevision.source, 'cli');
  assert.equal(edited.activeVerifiedRevision.revision, 2);
  const historical = cliJson(root, [
    'interview', 'stories', 'show', created.id, '--profile', 'profile_w07_alpha',
    '--revision', '2',
  ]);
  assert.equal(historical.storyId, created.id);
  assert.equal(historical.revision, 2);
  assert.equal(historical.state, 'verified');
  const stories = cliJson(root, [
    'interview', 'stories', 'list', '--profile', 'profile_w07_alpha', '--history',
  ]);
  assert.deepEqual(stories.stories[0].history.map(revision => revision.revision), [1, 2, 3]);

  const questionFile = writeJsonFixture(root, 'question.json', questionInput({
    profileId: 'profile_w07_beta',
    jobId: 'job_w07_beta',
    applicationId: 'application_w07_beta',
    source: 'acp',
  }));
  const question = cliJson(root, [
    'interview', 'questions', 'add', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--file', questionFile,
  ]);
  assert.equal(question.profileId, 'profile_w07_alpha');
  assert.equal(question.jobId, 'job_w07_alpha');
  assert.equal(question.applicationId, 'application_w07_alpha');
  assert.equal(question.actor, 'candidate');
  assert.equal(question.source, 'cli');
  const questions = cliJson(root, [
    'interview', 'questions', 'list', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--stage', 'hiring-manager',
    '--audience', 'hiring_manager',
  ]);
  assert.deepEqual(questions.currentSources.map(source => source.id), [question.id]);

  const prep = cliJson(root, [
    'interview', 'prep', '--application', 'application_w07_alpha',
    '--stage', 'hiring-manager', '--audience', 'executive',
  ]);
  assert.equal(prep.pack.audience, 'executive');
  const recordFile = writeJsonFixture(root, 'debrief.json', {
    ...debriefInput(verified),
    profileId: 'profile_w07_beta',
    jobId: 'job_w07_beta',
    applicationId: 'application_w07_beta',
    debriefId: 'spoofed-debrief',
    source: 'mcp',
  });
  const recorded = cliJson(root, [
    'interview', 'debrief', 'record', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--file', recordFile,
  ]);
  assert.equal(recorded.profileId, 'profile_w07_alpha');
  assert.equal(recorded.jobId, 'job_w07_alpha');
  assert.equal(recorded.applicationId, 'application_w07_alpha');
  assert.equal(recorded.currentRevision.actor, 'candidate');
  assert.equal(recorded.currentRevision.source, 'cli');

  const correctFile = writeJsonFixture(root, 'debrief-correction.json', {
    ...correctionInput(verified, recorded),
    profileId: 'profile_w07_beta',
    jobId: 'job_w07_beta',
    applicationId: 'application_w07_beta',
    debriefId: 'spoofed-debrief',
    targetRevision: 99,
    reason: 'Spoofed file reason.',
    source: 'acp',
  });
  const corrected = cliJson(root, [
    'interview', 'debrief', 'correct', recorded.id, '--profile', 'profile_w07_alpha',
    '--file', correctFile, '--reason', 'Corrected from direct human review.',
  ]);
  assert.equal(corrected.currentRevision.revision, 2);
  assert.equal(corrected.currentRevision.correctionReason, 'Corrected from direct human review.');
  assert.equal(corrected.currentRevision.source, 'cli');
  const debriefs = cliJson(root, [
    'interview', 'debriefs', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--history',
  ]);
  assert.equal(debriefs.debriefs[0].history.length, 2);
  const observations = cliJson(root, [
    'interview', 'observations', '--profile', 'profile_w07_alpha', '--since', '30',
  ]);
  assert.equal(observations.observations.length, 2);
  assert.ok(observations.observations.every(observation => !Object.hasOwn(observation, 'notes')));
  assert.doesNotMatch(JSON.stringify(observations), /Private (?:corrected )?debrief note/);

  const retired = cliJson(root, [
    'interview', 'stories', 'retire', created.id, '--profile', 'profile_w07_alpha',
    '--reason', 'No longer representative.',
  ]);
  assert.equal(retired.currentRevision.state, 'retired');
  assert.equal(retired.currentRevision.actor, 'user');
  assert.equal(retired.currentRevision.source, 'cli');

  const mismatch = runW07Cli(root, [
    'interview', 'stories', 'show', created.id, '--profile', 'profile_w07_beta',
  ]);
  assert.equal(mismatch.status, 1);
  assert.deepEqual(JSON.parse(mismatch.stderr), {
    ok: false,
    error: {
      code: 'interview_story_profile_mismatch',
      type: 'validation',
      message: `Interview story ${created.id} belongs to profile profile_w07_alpha, not profile_w07_beta.`,
      details: {},
    },
  });
  const nonsumericSince = runW07Cli(root, [
    'interview', 'observations', '--profile', 'profile_w07_alpha', '--since', 'nope',
  ]);
  assert.equal(nonsumericSince.status, 2);
  assert.deepEqual(JSON.parse(nonsumericSince.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: 'Invalid --since: nope',
    },
  });
  const zeroSince = runW07Cli(root, [
    'interview', 'observations', '--profile', 'profile_w07_alpha', '--since', '0',
  ]);
  assert.equal(zeroSince.status, 2);
  assert.deepEqual(JSON.parse(zeroSince.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: 'Invalid --since: 0',
    },
  });
});

test('W07-DOMAIN-01 exact tools route through interview APIs with explicit trusted and mediated attribution', async t => {
  assert.deepEqual(
    DOMAIN_TOOLS.filter(tool => tool.name.includes('interview')).map(tool => tool.name),
    INTERVIEW_DOMAIN_TOOL_NAMES,
  );
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const drafted = await callDomainTool(store, 'draft_interview_story', storyInput({
    actor: 'user',
    source: 'cli',
  }), { source: 'mcp' });
  assert.equal(drafted.currentRevision.actor, 'mcp');
  assert.equal(drafted.currentRevision.source, 'mcp');
  assert.ok(Object.values(drafted.currentRevision.fieldProvenance).every(entry =>
    entry.origin === 'agent' && entry.actor === 'mcp' && entry.source === 'mcp'));
  const listedDrafts = await callDomainTool(store, 'list_interview_stories', {
    profileId: 'profile_w07_alpha',
    includeHistory: true,
  }, { source: 'acp' });
  assert.deepEqual(listedDrafts.stories.map(story => story.id), [drafted.id]);
  const fetched = await callDomainTool(store, 'get_interview_story', {
    profileId: 'profile_w07_alpha',
    storyId: drafted.id,
    includeHistory: true,
  }, { source: 'mcp' });
  assert.equal(fetched.id, drafted.id);
  const verified = await callDomainTool(store, 'verify_interview_story', {
    profileId: 'profile_w07_alpha',
    storyId: drafted.id,
    revision: 1,
    confirmedFields: interview.INTERVIEW_STORY_CONTENT_FIELDS,
    actor: 'user',
  }, { source: 'cli' });
  assert.equal(verified.currentRevision.state, 'verified');
  assert.equal(verified.currentRevision.source, 'cli');

  const question = await callDomainTool(store, 'add_interview_question_source', questionInput({
    source: 'mcp',
  }), { source: 'cli' });
  assert.equal(question.source, 'cli');
  const prep = await callDomainTool(store, 'interview_prep', {
    applicationId: 'application_w07_alpha',
    stage: 'hiring-manager',
    audience: 'executive',
  }, { source: 'mcp' });
  assert.equal(prep.pack.audience, 'executive');
  const recorded = await callDomainTool(store, 'record_interview_debrief', debriefInput(verified, {
    source: 'mcp',
  }), { source: 'cli' });
  assert.equal(recorded.currentRevision.source, 'cli');
  const corrected = await callDomainTool(store, 'correct_interview_debrief', correctionInput(
    verified,
    recorded,
    { source: 'acp' },
  ), { source: 'cli' });
  assert.equal(corrected.currentRevision.source, 'cli');
  const debriefs = await callDomainTool(store, 'list_interview_debriefs', {
    profileId: 'profile_w07_alpha',
    applicationId: 'application_w07_alpha',
    includeHistory: true,
  }, { source: 'acp' });
  assert.equal(debriefs.debriefs[0].history.length, 2);
  const observations = await callDomainTool(store, 'list_interview_observations', {
    profileId: 'profile_w07_alpha',
    sinceDays: 30,
  }, { source: 'mcp' });
  assert.equal(observations.observations.length, 2);
  assert.ok(observations.observations.every(observation => !Object.hasOwn(observation, 'notes')));
  const retired = await callDomainTool(store, 'retire_interview_story', {
    profileId: 'profile_w07_alpha',
    storyId: drafted.id,
    reason: 'Replaced by a stronger example.',
    actor: 'user',
  }, { source: 'tui' });
  assert.equal(retired.currentRevision.state, 'retired');
  assert.equal(retired.currentRevision.source, 'tui');
});

test('W07-POLICY-01 MCP and ACP catalogs and runtime independently enforce direct human interview input', async t => {
  assert.deepEqual(
    mcpToolNames().filter(name => name.includes('interview')),
    MCP_INTERVIEW_TOOL_NAMES,
  );
  for (const name of MCP_DENIED_INTERVIEW_TOOL_NAMES) {
    assert.equal(mcpToolNames().includes(name), false, `${name} must not be advertised`);
  }
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const before = counts(store, [...W07_TABLES, 'audit_log']);
  const message = 'Interview verification, retirement, sourced questions, and debrief recording or correction require trusted CLI or TUI human input.';
  for (const source of ['mcp', 'acp']) {
    for (const name of MCP_DENIED_INTERVIEW_TOOL_NAMES) {
      await assert.rejects(
        callDomainTool(store, name, {}, { source }),
        error => error instanceof DomainToolError
          && error.code === 'human_interview_input_required'
          && error.message === message
          && error.details.tool === name
          && error.details.source === source
          && error.details.status === null
          && error.details.externalSideEffect === 'none',
      );
    }
  }
  assert.deepEqual(counts(store, [...W07_TABLES, 'audit_log']), before);
});

test('W07-MIRROR-01 routed writes regenerate stable mirrors and routed failures have zero persistent delta', async t => {
  const root = workspaceFromFixture(t);
  const storyFile = writeJsonFixture(root, 'mirror-story.json', storyInput());
  const created = cliJson(root, [
    'interview', 'stories', 'create', '--profile', 'profile_w07_alpha',
    '--file', storyFile,
  ]);
  const verified = cliJson(root, [
    'interview', 'stories', 'verify', created.id, '--profile', 'profile_w07_alpha',
    '--revision', '1', '--confirm-fields', interview.INTERVIEW_STORY_CONTENT_FIELDS.join(','),
  ]);
  const questionFile = writeJsonFixture(root, 'mirror-question.json', questionInput());
  cliJson(root, [
    'interview', 'questions', 'add', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--file', questionFile,
  ]);
  const recordFile = writeJsonFixture(root, 'mirror-debrief.json', debriefInput(verified));
  const recorded = cliJson(root, [
    'interview', 'debrief', 'record', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--file', recordFile,
  ]);
  const correctionFile = writeJsonFixture(root, 'mirror-correction.json', correctionInput(verified, recorded));
  cliJson(root, [
    'interview', 'debrief', 'correct', recorded.id, '--profile', 'profile_w07_alpha',
    '--file', correctionFile, '--reason', correctionInput(verified, recorded).reason,
  ]);
  const mirrors = [
    storyMirrorPath(root),
    questionMirrorPath(root),
    debriefMirrorPath(root),
    observationMirrorPath(root),
  ];
  const beforeBytes = new Map(mirrors.map(file => [file, readFileSync(file)]));
  const beforeStore = await openStore({ workspace: root });
  const beforeCounts = counts(beforeStore, [...W07_TABLES, 'audit_log']);
  beforeStore.db.close();

  const rejected = runW07Cli(root, [
    'interview', 'debrief', 'correct', recorded.id, '--profile', 'profile_w07_beta',
    '--file', correctionFile, '--reason', 'Cross-profile write must fail.',
  ]);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'interview_debrief_profile_mismatch');
  cliJson(root, [
    'interview', 'stories', 'list', '--profile', 'profile_w07_alpha', '--history',
  ]);
  cliJson(root, [
    'interview', 'debriefs', '--profile', 'profile_w07_alpha',
    '--application', 'application_w07_alpha', '--history',
  ]);

  const reopened = await openStore({ workspace: root });
  assert.deepEqual(counts(reopened, [...W07_TABLES, 'audit_log']), beforeCounts);
  reopened.db.close();
  for (const [file, bytes] of beforeBytes) assert.deepEqual(readFileSync(file), bytes);
});
