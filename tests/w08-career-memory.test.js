import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import initSqlJs from 'sql.js';

import { all, one, openStore, run } from '../src/db.js';

const require = createRequire(import.meta.url);
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const W08_TABLES = Object.freeze([
  'career_memory_observations',
  'career_memory_proposals',
  'career_memory_proposal_evidence',
  'career_memory_proposal_transitions',
  'career_memory_projection_revisions',
  'career_memory_projection_sources',
]);
const W08_INDEXES = Object.freeze([
  'career_memory_observations_one_successor_idx',
  'career_memory_observations_profile_time_idx',
  'career_memory_observations_source_idx',
  'career_memory_proposals_profile_rule_idx',
  'career_memory_proposals_profile_fresh_idx',
  'career_memory_proposal_evidence_source_idx',
  'career_memory_transitions_resolve_idx',
  'career_memory_projection_current_idx',
]);
const W08_COLUMNS = Object.freeze({
  career_memory_observations: ['id', 'profile_id', 'schema_version', 'event_type', 'source_schema', 'source_entity_type', 'source_entity_id', 'source_version_id', 'source_revision', 'source_content_hash', 'occurred_at', 'recorded_at', 'actor', 'source', 'reason_codes_json', 'signal_json', 'public_explanation', 'private_note', 'payload_json', 'reference_id', 'supersedes_observation_id', 'undoes_observation_id', 'correction_reason', 'observation_hash'],
  career_memory_proposals: ['id', 'profile_id', 'schema_version', 'domain', 'scope', 'rule_type', 'value_json', 'rule_key', 'conflict_key', 'rationale', 'confidence_milli', 'confidence_band', 'conflict_state', 'evidence_hash', 'evidence_fresh_until', 'created_at', 'actor', 'source', 'proposal_hash'],
  career_memory_proposal_evidence: ['proposal_id', 'profile_id', 'position', 'observation_schema', 'observation_id', 'source_entity_type', 'source_entity_id', 'source_version_id', 'occurred_at', 'polarity', 'weight', 'evidence_hash'],
  career_memory_proposal_transitions: ['id', 'proposal_id', 'profile_id', 'sequence', 'from_status', 'to_status', 'reason', 'reference_id', 'replacement_proposal_id', 'undoes_transition_id', 'actor', 'source', 'occurred_at', 'transition_hash'],
  career_memory_projection_revisions: ['id', 'profile_id', 'projection_type', 'revision', 'schema_version', 'as_of', 'source_state_hash', 'content_hash', 'document_json', 'created_at'],
  career_memory_projection_sources: ['projection_id', 'profile_id', 'position', 'source_kind', 'source_id', 'source_version_id', 'source_hash'],
});
const W08_CHECKS = Object.freeze({
  career_memory_observations: [
    'CHECK(schema_version=1)',
    "CHECK(event_typeIN('job_saved','job_skipped','job_applied','artifact_approved','artifact_rejected','artifact_edited'))",
    "CHECK(source_entity_typeIN('job','application','artifact'))",
    'CHECK(source_revisionISNULLORsource_revision>0)',
    "CHECK(sourceIN('cli','tui'))",
    "CHECK(supersedes_observation_idISNULLORcorrection_reason!='')",
  ],
  career_memory_proposals: [
    "CHECK(domainIN('search','writing'))",
    "CHECK(scopeIN('search','resume','cover_letter','outreach','interview_prep','writing_global'))",
    'CHECK(confidence_milliBETWEEN0AND1000)',
    "CHECK(confidence_bandIN('low','medium','high'))",
    "CHECK(conflict_stateIN('none','present'))",
    "CHECK(sourceIN('cli','tui','mcp','acp','deterministic'))",
    "CHECK((domain='search'ANDscope='search')OR(domain='writing'ANDscope!='search'))",
    "CHECK(NOT(rule_type='approved_exemplar'ANDscope='writing_global'))",
  ],
  career_memory_proposal_evidence: [
    'CHECK(position>=0)',
    "CHECK(polarityIN('support','conflict'))",
    'CHECK(weightIN(1,2))',
  ],
  career_memory_proposal_transitions: [
    'CHECK(sequence>0)',
    "CHECK(from_statusISNULLORfrom_statusIN('proposed','accepted','rejected','superseded','revoked'))",
    "CHECK(to_statusIN('proposed','accepted','rejected','superseded','revoked'))",
    "CHECK(sourceIN('cli','tui','mcp','acp','deterministic'))",
    "CHECK((sequence=1ANDfrom_statusISNULLANDto_status='proposed')ORsequence>1)",
  ],
  career_memory_projection_revisions: [
    "CHECK(projection_typeIN('career_brief','voice_positioning_guide'))",
    'CHECK(revision>0)',
    'CHECK(schema_version=1)',
  ],
  career_memory_projection_sources: [
    'CHECK(position>=0)',
    "CHECK(source_kindIN('profile_field','proof_point','saved_search','accepted_rule','observation','artifact_revision'))",
  ],
});

function fixtureWorkspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-schema14-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.jobos');
  mkdirSync(state, { recursive: true });
  const databasePath = path.join(state, 'jobos.sqlite');
  copyFileSync(FIXTURE, databasePath);
  return { root, databasePath };
}

function canonicalSnapshot(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalSnapshot(value[key])}`).join(',')}}`;
}

function snapshotHash(rows) {
  return crypto.createHash('sha256').update(canonicalSnapshot(rows)).digest('hex');
}

async function rawSchema14Snapshot(databasePath) {
  const SQL = await initSqlJs({
    locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  const db = new SQL.Database(readFileSync(databasePath));
  try {
    const names = [];
    const tableStatement = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    try {
      while (tableStatement.step()) names.push(String(tableStatement.getAsObject().name));
    } finally {
      tableStatement.free();
    }
    const tables = {};
    for (const name of names.filter(value => value !== 'meta')) {
      const statement = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`);
      const rows = [];
      try {
        while (statement.step()) rows.push(statement.getAsObject());
      } finally {
        statement.free();
      }
      tables[name] = { count: rows.length, hash: snapshotHash(rows) };
    }
    const meta = {};
    const metaStatement = db.prepare('SELECT key,value FROM meta ORDER BY key');
    try {
      while (metaStatement.step()) {
        const row = metaStatement.getAsObject();
        meta[String(row.key)] = String(row.value);
      }
    } finally {
      metaStatement.free();
    }
    return { names, tables, meta };
  } finally {
    db.close();
  }
}

function openStoreSnapshot(store, tableNames) {
  const tables = {};
  for (const name of tableNames.filter(value => value !== 'meta')) {
    const rows = all(store, `SELECT * FROM "${name}" ORDER BY rowid`);
    tables[name] = { count: rows.length, hash: snapshotHash(rows) };
  }
  const meta = Object.fromEntries(all(store, 'SELECT key,value FROM meta ORDER BY key').map(row => [row.key, String(row.value)]));
  return { tables, meta };
}

function assertSchema14FixtureFacts(store) {
  const profiles = all(store, 'SELECT id,preferences_json FROM profiles ORDER BY id');
  assert.deepEqual(profiles.map(profile => profile.id), ['alpha', 'beta']);
  assert.notEqual(profiles[0].preferences_json, profiles[1].preferences_json);
  for (const profileId of ['alpha', 'beta']) {
    const proofCounts = one(store, `SELECT
      SUM(status='active' AND verification_status='verified') AS active_verified,
      SUM(status='retired') AS retired,
      SUM(source='resume_import' AND verification_status='unverified') AS unverified_imported
      FROM proof_points WHERE profile_id=?`, [profileId]);
    assert.deepEqual(proofCounts, { active_verified: 1, retired: 1, unverified_imported: 1 });
    assert.deepEqual(
      all(store, 'SELECT status,COUNT(*) AS count FROM jobs WHERE profile_id=? GROUP BY status ORDER BY status', [profileId]),
      [{ status: 'archived', count: 1 }, { status: 'saved', count: 1 }],
    );
  }

  const revisionSeries = all(store, `SELECT series_key,COUNT(*) AS revisions,MAX(revision) AS latest_revision
    FROM artifacts GROUP BY series_key HAVING COUNT(*)=2 AND MAX(revision)=2`);
  assert.equal(revisionSeries.length, 1);
  assert.equal(one(store, 'SELECT approval_status FROM artifacts WHERE series_key=? AND revision=2', [revisionSeries[0].series_key])?.approval_status, 'approved');
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM artifacts WHERE approval_status='rejected'")?.count, 1);

  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM outreach_threads')?.count, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM outreach_outcomes')?.count, 2);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM outreach_outcomes WHERE supersedes_outcome_id IS NOT NULL')?.count, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM application_packets')?.count, 1);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM application_receipts WHERE type='user_attestation'")?.count, 1);
  assert.ok(one(store, 'SELECT COUNT(*) AS count FROM status_changes')?.count >= 3);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM tasks WHERE action_kind='application_next_action' AND status='open'")?.count, 1);

  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM interview_stories')?.count, 1);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM interview_story_revisions WHERE state='verified'")?.count, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM interview_debriefs')?.count, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM interview_debrief_revisions')?.count, 2);
  const currentDebrief = one(store, `SELECT revision,supersedes_revision_id
    FROM interview_debrief_revisions ORDER BY revision DESC LIMIT 1`);
  assert.equal(currentDebrief.revision, 2);
  assert.ok(currentDebrief.supersedes_revision_id);
}

function withoutMigrationMeta(meta) {
  const copy = { ...meta };
  delete copy.schema_version;
  delete copy.store_revision;
  return copy;
}

function w08Rows(store) {
  return Object.fromEntries(W08_TABLES.map(name => [name, all(store, `SELECT * FROM ${name} ORDER BY rowid`)]));
}

function insertObservation(store, {
  id,
  profileId,
  referenceId,
  supersedesObservationId = null,
  correctionReason = '',
}) {
  run(store, `INSERT INTO career_memory_observations (
    id,profile_id,event_type,source_schema,source_entity_type,source_entity_id,
    source_version_id,occurred_at,recorded_at,actor,source,reference_id,
    supersedes_observation_id,correction_reason,observation_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id,
    profileId,
    'job_saved',
    'jobos.job-feedback-input.v1',
    'job',
    `job-${profileId}`,
    `version-${id}`,
    '2026-07-24T12:00:00.000Z',
    '2026-07-24T12:00:00.000Z',
    'fixture-user',
    'cli',
    referenceId,
    supersedesObservationId,
    correctionReason,
    `hash-${id}`,
  ]);
}

function insertProposal(store, { id, profileId }) {
  run(store, `INSERT INTO career_memory_proposals (
    id,profile_id,domain,scope,rule_type,value_json,rule_key,conflict_key,
    rationale,confidence_milli,confidence_band,conflict_state,evidence_hash,
    evidence_fresh_until,created_at,actor,source,proposal_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id,
    profileId,
    'search',
    'search',
    'role_family',
    '{"match":"exact","polarity":"prefer","value":"product"}',
    `rule-${id}`,
    `conflict-${id}`,
    'Fixture proposal.',
    800,
    'medium',
    'none',
    `evidence-${id}`,
    '2027-01-20T12:00:00.000Z',
    '2026-07-24T12:00:00.000Z',
    'fixture-user',
    'cli',
    `proposal-${id}`,
  ]);
}

test('W08-CONTRACT-01 freezes schemas, enums, canonical bytes, IDs, and input normalizers', async () => {
  const contract = await import('../src/career-memory-contract.js');
  assert.deepEqual(contract.CAREER_MEMORY_SCHEMAS, {
    observation: 'jobos.career-memory-observation.v1',
    observationList: 'jobos.career-memory-observation-list.v1',
    proposal: 'jobos.career-memory-proposal.v1',
    proposalList: 'jobos.career-memory-proposal-list.v1',
    transition: 'jobos.career-memory-transition.v1',
    activeRules: 'jobos.career-memory-active-rules.v1',
    careerBrief: 'jobos.career-brief.v1',
    voicePositioningGuide: 'jobos.voice-positioning-guide.v1',
    retrieval: 'jobos.career-memory-retrieval.v1',
    validation: 'jobos.career-memory-validation.v1',
    jobFeedbackInput: 'jobos.job-feedback-input.v1',
    artifactFeedbackInput: 'jobos.artifact-feedback-input.v1',
    memoryProposalInput: 'jobos.memory-proposal-input.v1',
  });
  assert.deepEqual(contract.MEMORY_EVENT_TYPES, ['job_saved', 'job_skipped', 'job_applied', 'artifact_approved', 'artifact_rejected', 'artifact_edited']);
  assert.deepEqual(contract.JOB_REASON_CODES, ['role_fit', 'seniority_fit', 'company_stage', 'industry', 'mission', 'location', 'work_model', 'compensation', 'skills_match', 'timing', 'trust_signal', 'red_flag', 'other']);
  assert.deepEqual(contract.ARTIFACT_REASON_CODES, ['tone', 'length', 'opening', 'closing', 'structure', 'vocabulary', 'specificity', 'evidence_selection', 'positioning', 'unsupported_claim', 'factual_error', 'formatting', 'other']);
  assert.deepEqual(contract.MEMORY_DOMAINS, ['search', 'writing']);
  assert.deepEqual(contract.MEMORY_SCOPES, ['search', 'resume', 'cover_letter', 'outreach', 'interview_prep', 'writing_global']);
  assert.deepEqual(contract.SEARCH_RULE_TYPES, ['role_family', 'seniority', 'company_stage', 'industry', 'mission', 'location', 'work_model', 'compensation', 'skill', 'timing', 'trust_risk']);
  assert.deepEqual(contract.WRITING_RULE_TYPES, ['tone', 'length', 'opening', 'closing', 'avoid_term', 'avoid_claim', 'positioning_priority', 'approved_exemplar']);
  assert.deepEqual(contract.MEMORY_STATUSES, ['proposed', 'accepted', 'rejected', 'superseded', 'revoked']);
  assert.deepEqual(contract.CONFIDENCE_BANDS, ['low', 'medium', 'high']);
  assert.deepEqual(contract.CONFLICT_STATES, ['none', 'present']);

  const canonical = '{"a":[true,{"a":null,"b":"x"}],"z":2}';
  assert.equal(contract.canonicalJson({ z: 2, a: [true, { b: 'x', a: null }] }), canonical);
  assert.equal(contract.canonicalHash({ z: 2, a: [true, { b: 'x', a: null }] }), 'a056619549ae7bd32da7753603a6f65f0b30ba0fc4cea71d35272412d9b03936');
  assert.throws(() => contract.canonicalJson({ value: undefined }), error => error?.code === 'memory_undefined_rejected');
  assert.throws(() => contract.canonicalJson(Array(1)), error => error?.code === 'memory_undefined_rejected');
  assert.equal(contract.normalizeRfc3339('2026-07-24T12:00:00+00:00'), '2026-07-24T12:00:00.000Z');
  assert.equal(contract.normalizeRfc3339('2026-07-24T00:30:00+02:00'), '2026-07-23T22:30:00.000Z');
  assert.throws(() => contract.normalizeRfc3339('2026-07-24'), error => error?.code === 'memory_timestamp_invalid');
  assert.throws(() => contract.normalizeRfc3339('2026-02-30T12:00:00Z'), error => error?.code === 'memory_timestamp_invalid');

  assert.equal(contract.memoryObservationId({ profileId: 'alpha', sourceSchema: 'jobos.job-feedback-input.v1', sourceEntityType: 'job', sourceEntityId: 'job-1', sourceVersionId: 'audit-1', eventType: 'job_saved', referenceId: 'ref-1' }), 'memory_observation_cef38198062d');
  assert.equal(contract.memoryProposalId({ profileId: 'alpha', domain: 'search', scope: 'search', ruleType: 'role_family', ruleKey: 'rule-hash', evidenceHash: 'evidence-hash', createdAt: '2026-07-24T12:00:00.000Z' }), 'memory_proposal_db624983947a');
  assert.equal(contract.memoryTransitionId({ proposalId: 'proposal-1', sequence: 2, toStatus: 'accepted', referenceId: 'ref-2' }), 'memory_transition_ce54cda119cb');
  assert.equal(contract.memoryProjectionId({ profileId: 'alpha', projectionType: 'career_brief', revision: 3, sourceStateHash: 'state-hash' }), 'memory_projection_088cc06b892e');

  const jobFeedback = contract.normalizeJobFeedbackInput({
    schema: 'jobos.job-feedback-input.v1',
    decision: 'save',
    reasonCodes: ['other', 'role_fit'],
    signals: [{ field: 'role_family', polarity: 'prefer', value: '  Product   Manager ', match: 'token' }],
    publicExplanation: 'Explicit user explanation.',
    privateNote: 'SQLite only.',
    referenceId: ' fixture-job-feedback ',
    occurredAt: '2026-07-24T12:00:00+00:00',
  });
  assert.deepEqual(jobFeedback.reasonCodes, ['role_fit', 'other']);
  assert.deepEqual(jobFeedback.signals, [{ field: 'role_family', polarity: 'prefer', value: 'product manager', match: 'token' }]);
  assert.equal(jobFeedback.referenceId, 'fixture-job-feedback');
  assert.equal(jobFeedback.occurredAt, '2026-07-24T12:00:00.000Z');
  assert.equal(jobFeedback.privateNote, 'SQLite only.');
  assert.throws(() => contract.normalizeJobFeedbackInput({ ...jobFeedback, unexpected: true }), error => error?.code === 'memory_unknown_key');
  assert.throws(() => contract.normalizeJobFeedbackInput({ ...jobFeedback, reasonCodes: ['other'], publicExplanation: '' }), error => error?.code === 'memory_other_explanation_required');
  assert.throws(() => contract.normalizeJobFeedbackInput({ ...jobFeedback, reasonCodes: ['role_fit', 'role_fit'] }), error => error?.code === 'memory_reason_duplicate');

  const artifactFeedback = contract.normalizeArtifactFeedbackInput({
    schema: 'jobos.artifact-feedback-input.v1',
    reasonCodes: ['tone'],
    signals: [{ ruleType: 'tone', value: { value: 'concise' } }],
    publicExplanation: '',
    privateNote: '',
    referenceId: 'fixture-artifact-feedback',
  }, { decision: 'approve' });
  assert.deepEqual(artifactFeedback.signals, [{ ruleType: 'tone', value: { value: 'concise' } }]);

  const proposalInput = contract.normalizeMemoryProposalInput({
    schema: 'jobos.memory-proposal-input.v1',
    domain: 'writing',
    scope: 'resume',
    ruleType: 'length',
    value: { minWords: 30, maxWords: 120 },
    rationale: 'Visible non-causal rationale.',
    evidence: [{ observationSchema: 'jobos.career-memory-observation.v1', observationId: 'observation-1', polarity: 'support' }],
    referenceId: 'fixture-proposal',
    createdAt: '2026-07-24T12:00:00Z',
  });
  assert.deepEqual(proposalInput.value, { minWords: 30, maxWords: 120 });
  assert.equal(proposalInput.createdAt, '2026-07-24T12:00:00.000Z');
  assert.throws(() => contract.normalizeMemoryProposalInput({ ...proposalInput, status: 'accepted' }), error => error?.code === 'memory_unknown_key');
  assert.throws(() => contract.normalizeMemoryProposalInput({ ...proposalInput, evidence: [proposalInput.evidence[0], proposalInput.evidence[0]] }), error => error?.code === 'memory_evidence_duplicate');
});

test('W08-MIGRATE-01 migrates the immutable schema-14 fixture additively', async t => {
  const { root, databasePath } = fixtureWorkspace(t);
  const before = await rawSchema14Snapshot(databasePath);
  assert.equal(before.meta.schema_version, '14');
  assert.deepEqual(before.names.filter(name => name.startsWith('career_memory_')), []);

  const store = await openStore({ workspace: root });
  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'")?.value, '15');
  assert.equal(one(store, 'PRAGMA foreign_keys')?.foreign_keys, 1);
  assert.deepEqual(all(store, 'PRAGMA foreign_key_check'), []);
  assertSchema14FixtureFacts(store);
  assert.deepEqual(W08_TABLES.filter(name => !one(store, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name])), []);
  assert.deepEqual(W08_INDEXES.filter(name => !one(store, "SELECT name FROM sqlite_master WHERE type='index' AND name=?", [name])), []);
  for (const [table, columns] of Object.entries(W08_COLUMNS)) {
    assert.deepEqual(all(store, `PRAGMA table_info(${table})`).map(row => row.name), columns, table);
    assert.equal(all(store, `SELECT * FROM ${table}`).length, 0, table);
    const definition = one(store, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])?.sql.replace(/\s+/g, '');
    for (const check of W08_CHECKS[table]) assert.ok(definition.includes(check), `${table} missing ${check}`);
  }

  const after = openStoreSnapshot(store, before.names);
  assert.deepEqual(after.tables, before.tables);
  assert.deepEqual(withoutMigrationMeta(after.meta), withoutMigrationMeta(before.meta));
  store.db.close();
});

test('W08-MIGRATE-02 schema-15 reopen is byte-stable and side-effect free', async t => {
  const { root, databasePath } = fixtureWorkspace(t);
  const first = await openStore({ workspace: root });
  const firstRows = w08Rows(first);
  const firstAudits = all(first, 'SELECT * FROM audit_log ORDER BY id');
  first.db.close();
  const firstBytes = crypto.createHash('sha256').update(readFileSync(databasePath)).digest('hex');

  const second = await openStore({ workspace: root });
  assert.deepEqual(w08Rows(second), firstRows);
  assert.deepEqual(all(second, 'SELECT * FROM audit_log ORDER BY id'), firstAudits);
  assert.equal(existsSync(path.join(root, 'jobos-workspace', 'profiles', 'alpha', 'career-memory')), false);
  assert.equal(existsSync(path.join(root, 'jobos-workspace', 'profiles', 'beta', 'career-memory')), false);
  second.db.close();
  const secondBytes = crypto.createHash('sha256').update(readFileSync(databasePath)).digest('hex');
  assert.equal(secondBytes, firstBytes);
});

test('W08-ISO-01 observation correction ownership is composite and profile-safe', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  insertObservation(store, { id: 'memory-observation-alpha', profileId: 'alpha', referenceId: 'alpha-reference' });
  assert.throws(() => insertObservation(store, {
    id: 'memory-observation-beta-successor',
    profileId: 'beta',
    referenceId: 'beta-reference',
    supersedesObservationId: 'memory-observation-alpha',
    correctionReason: 'Cross-profile fixture attempt.',
  }), /FOREIGN KEY constraint failed/);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations')?.count, 1);
  store.db.close();
});

test('W08-ISO-02 proposal evidence ownership rejects cross-profile references before a row exists', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  insertProposal(store, { id: 'memory-proposal-alpha', profileId: 'alpha' });
  assert.throws(() => run(store, `INSERT INTO career_memory_proposal_evidence (
    proposal_id,profile_id,position,observation_schema,observation_id,
    source_entity_type,source_entity_id,source_version_id,occurred_at,
    polarity,weight,evidence_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'memory-proposal-alpha',
    'beta',
    0,
    'jobos.career-memory-observation.v1',
    'observation-beta',
    'job',
    'job-beta',
    'version-beta',
    '2026-07-24T12:00:00.000Z',
    'support',
    2,
    'evidence-beta',
  ]), /FOREIGN KEY constraint failed/);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposal_evidence')?.count, 0);
  store.db.close();
});

test('W08-ISO-03 transition and projection source ownership use composite foreign keys', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  insertProposal(store, { id: 'memory-proposal-alpha', profileId: 'alpha' });
  insertProposal(store, { id: 'memory-proposal-beta', profileId: 'beta' });
  assert.throws(() => run(store, `INSERT INTO career_memory_proposal_transitions (
    id,proposal_id,profile_id,sequence,from_status,to_status,reason,reference_id,
    replacement_proposal_id,actor,source,occurred_at,transition_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'transition-cross-profile',
    'memory-proposal-alpha',
    'alpha',
    1,
    null,
    'proposed',
    '',
    'transition-reference',
    'memory-proposal-beta',
    'fixture-user',
    'cli',
    '2026-07-24T12:00:00.000Z',
    'transition-hash',
  ]), /FOREIGN KEY constraint failed/);

  run(store, `INSERT INTO career_memory_projection_revisions (
    id,profile_id,projection_type,revision,as_of,source_state_hash,
    content_hash,document_json,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`, [
    'projection-alpha',
    'alpha',
    'career_brief',
    1,
    '2026-07-24T12:00:00.000Z',
    'state-alpha',
    'content-alpha',
    '{}',
    '2026-07-24T12:00:00.000Z',
  ]);
  assert.throws(() => run(store, `INSERT INTO career_memory_projection_sources (
    projection_id,profile_id,position,source_kind,source_id,source_version_id,source_hash
  ) VALUES (?,?,?,?,?,?,?)`, [
    'projection-alpha',
    'beta',
    0,
    'profile_field',
    'beta',
    '/preferences',
    'source-hash',
  ]), /FOREIGN KEY constraint failed/);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposal_transitions')?.count, 0);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_projection_sources')?.count, 0);
  store.db.close();
});
