import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import initSqlJs from 'sql.js';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';

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

  const resumeTone = { domain: 'writing', scope: 'resume', ruleType: 'tone', value: { value: 'concise' } };
  const coverLetterTone = { ...resumeTone, scope: 'cover_letter' };
  assert.equal(contract.memoryConflictKey(resumeTone), contract.memoryConflictKey(coverLetterTone));
  assert.notEqual(contract.memoryRuleKey(resumeTone), contract.memoryRuleKey(coverLetterTone));

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
  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'")?.value, '16');
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

  const after = openStoreSnapshot(store, before.names.filter(name => name !== 'automations'));
  const { automations: _seededDefaults, ...stableBeforeTables } = before.tables;
  assert.deepEqual(after.tables, stableBeforeTables);
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

const PHASE2_NOW = new Date('2026-07-25T12:00:00.000Z');

async function observationApi() {
  return import('../src/career-memory-observations.js');
}

function alphaSavedJob(store) {
  return one(store, "SELECT * FROM jobs WHERE profile_id='alpha' AND status='saved'");
}

function alphaArchivedJob(store) {
  return one(store, "SELECT * FROM jobs WHERE profile_id='alpha' AND status='archived'");
}

function jobFeedback(overrides = {}) {
  return {
    schema: 'jobos.job-feedback-input.v1',
    decision: 'save',
    reasonCodes: ['role_fit'],
    signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
    publicExplanation: '',
    privateNote: '',
    referenceId: 'w08-job-feedback-reference',
    occurredAt: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

function phase2Counts(store) {
  return {
    observations: one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count,
    audit: one(store, 'SELECT COUNT(*) AS count FROM audit_log').count,
    jobs: one(store, 'SELECT COUNT(*) AS count FROM jobs').count,
    applications: one(store, 'SELECT COUNT(*) AS count FROM applications').count,
    statusChanges: one(store, 'SELECT COUNT(*) AS count FROM status_changes').count,
    artifacts: one(store, 'SELECT COUNT(*) AS count FROM artifacts').count,
    tasks: one(store, 'SELECT COUNT(*) AS count FROM tasks').count,
  };
}

function protectedRows(store) {
  return Object.fromEntries([
    'profiles',
    'proof_points',
    'jobs',
    'applications',
    'status_changes',
    'application_receipts',
    'artifacts',
    'outreach_outcomes',
    'interview_debriefs',
    'interview_debrief_revisions',
    'tasks',
  ].map(table => [table, all(store, `SELECT * FROM ${table} ORDER BY rowid`)]));
}

function memoryMirror(root, profileId = 'alpha') {
  return path.join(root, 'jobos-workspace', 'profiles', profileId, 'memory', 'observations.yaml');
}

function approvedArtifactSource(store) {
  const artifact = one(store, `SELECT * FROM artifacts
    WHERE profile_id='alpha' AND type='interview_prep' AND revision=2 AND approval_status='approved'`);
  const event = one(store, `SELECT * FROM audit_log
    WHERE action='artifact.approved' AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [artifact.id]);
  return { artifact, event };
}

test('W08-OBS-01 records attributable current job feedback without mutating canonical state', async t => {
  const api = await observationApi();
  assert.equal(typeof api.queueMemorySync, 'function');
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const job = alphaSavedJob(store);
  const protectedBefore = protectedRows(store);
  const result = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: job.id,
    input: jobFeedback(),
    actor: 'user',
    source: 'cli',
  });
  assert.equal(result.schema, 'jobos.career-memory-observation.v1');
  assert.equal(result.eventType, 'job_saved');
  assert.deepEqual(result.reasonCodes, ['role_fit']);
  assert.deepEqual(result.signals, [{ field: 'role_family', polarity: 'prefer', value: 'product manager', match: 'exact' }]);
  assert.deepEqual(result.sourceEntity, {
    type: 'job',
    id: job.id,
    versionId: one(store, `SELECT id FROM audit_log WHERE action='job.status_changed' AND entity_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1`, [job.id]).id,
    revision: null,
    contentHash: result.sourceEntity.contentHash,
  });
  assert.match(result.sourceEntity.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.current, true);
  assert.equal(result.interpretation, 'attributed_observation_only_no_preference_or_causal_claim');
  assert.equal(result.externalSideEffects, 'none');
  const application = one(store, `SELECT * FROM applications WHERE profile_id='alpha' AND job_id=?`, [job.id]);
  const receipt = one(store, `SELECT * FROM application_receipts WHERE application_id=?
    ORDER BY CASE type WHEN 'user_attestation' THEN 0 WHEN 'adapter_receipt' THEN 1 ELSE 2 END,
    recorded_at DESC,id DESC LIMIT 1`, [application.id]);
  const applied = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: job.id,
    input: jobFeedback({
      decision: 'apply',
      signals: [],
      referenceId: 'w08-applied-feedback-reference',
    }),
    actor: 'user',
    source: 'cli',
  });
  assert.equal(applied.eventType, 'job_applied');
  assert.deepEqual(applied.sourceEntity, {
    type: 'application',
    id: application.id,
    versionId: receipt.id,
    revision: null,
    contentHash: receipt.receipt_hash,
  });
  assert.deepEqual(Object.keys(result), [
    'schema',
    'id',
    'profileId',
    'eventType',
    'occurredAt',
    'recordedAt',
    'actor',
    'source',
    'sourceEntity',
    'reasonCodes',
    'signals',
    'publicExplanation',
    'hasPrivateNote',
    'current',
    'supersedesObservationId',
    'payload',
    'interpretation',
    'externalSideEffects',
  ]);
  assert.deepEqual(protectedRows(store), protectedBefore);
  assert.equal(one(store, `SELECT action FROM audit_log ORDER BY rowid DESC LIMIT 1`).action, 'career_memory.observation_recorded');
  assert.ok(existsSync(memoryMirror(root)));
  assert.equal(existsSync(path.join(root, 'jobos-workspace', 'profiles', 'alpha', 'career', 'memory.yaml')), false);
  store.db.close();
});

test('W08-OBS-02 exact job feedback replay is idempotent and conflicting reuse has zero deltas', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const args = {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback(),
    actor: 'user',
    source: 'cli',
  };
  const first = api.recordJobFeedback(store, args);
  const afterFirst = phase2Counts(store);
  const mirrorAfterFirst = readFileSync(memoryMirror(root));
  const databaseAfterFirst = readFileSync(path.join(root, '.jobos', 'jobos.sqlite'));
  const revisionAfterFirst = one(store, "SELECT value FROM meta WHERE key='store_revision'").value;
  const replay = api.recordJobFeedback(store, args);
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(phase2Counts(store), afterFirst);
  assert.deepEqual(readFileSync(memoryMirror(root)), mirrorAfterFirst);
  assert.deepEqual(readFileSync(path.join(root, '.jobos', 'jobos.sqlite')), databaseAfterFirst);
  assert.equal(one(store, "SELECT value FROM meta WHERE key='store_revision'").value, revisionAfterFirst);
  assert.throws(() => api.recordJobFeedback(store, {
    ...args,
    input: jobFeedback({ privateNote: 'different payload' }),
  }), error => error?.code === 'memory_reference_conflict');
  assert.deepEqual(phase2Counts(store), afterFirst);
  assert.deepEqual(readFileSync(memoryMirror(root)), mirrorAfterFirst);
  assert.deepEqual(readFileSync(path.join(root, '.jobos', 'jobos.sqlite')), databaseAfterFirst);
  assert.equal(one(store, "SELECT value FROM meta WHERE key='store_revision'").value, revisionAfterFirst);
  store.db.close();
});

test('W08-OBS-03 rejects cross-profile, stale-state, protected, unmatched, sparse, and unattributed job signals', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const before = phase2Counts(store);
  const saved = alphaSavedJob(store);
  const archived = alphaArchivedJob(store);
  const attempts = [
    () => api.recordJobFeedback(store, { profileId: 'beta', jobId: saved.id, input: jobFeedback(), actor: 'user', source: 'cli' }),
    () => api.recordJobFeedback(store, { profileId: 'alpha', jobId: archived.id, input: jobFeedback(), actor: 'user', source: 'cli' }),
    () => api.recordJobFeedback(store, {
      profileId: 'alpha',
      jobId: saved.id,
      input: jobFeedback({ signals: [{ field: 'work_authorization', polarity: 'avoid', value: 'visa' }] }),
      actor: 'user',
      source: 'cli',
    }),
    () => api.recordJobFeedback(store, {
      profileId: 'alpha',
      jobId: saved.id,
      input: jobFeedback({ signals: [{ field: 'role_family', polarity: 'avoid', value: 'nursing', match: 'exact' }] }),
      actor: 'user',
      source: 'cli',
    }),
    () => api.recordJobFeedback(store, {
      profileId: 'alpha',
      jobId: saved.id,
      input: jobFeedback({ reasonCodes: Array(1) }),
      actor: 'user',
      source: 'cli',
    }),
    () => api.recordJobFeedback(store, { profileId: 'alpha', jobId: saved.id, input: jobFeedback(), actor: 'unknown', source: 'cli' }),
  ];
  const codes = [
    'memory_profile_source_mismatch',
    'memory_source_state_invalid',
    'memory_enum_invalid',
    'memory_signal_source_mismatch',
    'memory_undefined_rejected',
    'memory_actor_invalid',
  ];
  attempts.forEach((attempt, index) => assert.throws(attempt, error => error?.code === codes[index]));
  assert.deepEqual(phase2Counts(store), before);
  assert.equal(existsSync(memoryMirror(root)), false);
  store.db.close();
});

test('W08-OBS-04 appendMemoryObservation stores exact current artifact feedback source versions', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const { artifact, event } = approvedArtifactSource(store);
  const result = guardedWrite(store, () => api.appendMemoryObservation(store, {
    profileId: 'alpha',
    eventType: 'artifact_approved',
    sourceSchema: 'jobos.artifact-feedback-input.v1',
    sourceEntity: {
      type: 'artifact',
      id: artifact.id,
      versionId: event.id,
      revision: artifact.revision,
      contentHash: artifact.content_hash,
    },
    occurredAt: '2026-07-24T12:10:00.000Z',
    actor: 'user',
    source: 'cli',
    reasonCodes: ['tone'],
    signals: [{ ruleType: 'tone', value: { value: 'concise' } }],
    publicExplanation: '',
    privateNote: '',
    payload: { decision: 'approve' },
    referenceId: 'w08-artifact-feedback-reference',
  }));
  assert.equal(result.eventType, 'artifact_approved');
  assert.equal(result.sourceEntity.id, artifact.id);
  assert.equal(result.sourceEntity.versionId, event.id);
  assert.equal(result.sourceEntity.revision, 2);
  assert.equal(result.sourceEntity.contentHash, artifact.content_hash);
  assert.deepEqual(result.signals, [{ ruleType: 'tone', value: { value: 'concise' } }]);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 1);
  store.db.close();
});

test('W08-OBS-05 listMemoryObservations applies stable time, type, order, current, and exclusion semantics', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const job = alphaSavedJob(store);
  api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: job.id,
    input: jobFeedback({ referenceId: 'older-feedback', occurredAt: '2026-07-20T12:00:00.000Z' }),
    actor: 'user',
    source: 'cli',
  });
  api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: job.id,
    input: jobFeedback({ referenceId: 'newer-feedback', occurredAt: '2026-07-25T10:00:00.000Z' }),
    actor: 'user',
    source: 'cli',
  });
  const listed = api.listMemoryObservations(store, {
    profileId: 'alpha',
    types: ['job_saved'],
    sinceDays: 2,
    includeHistory: false,
    nowDate: PHASE2_NOW,
  });
  assert.equal(listed.schema, 'jobos.career-memory-observation-list.v1');
  assert.equal(listed.observationSchema, 'jobos.career-memory-observation.v1');
  assert.deepEqual(listed.period, {
    start: '2026-07-23T12:00:00.000Z',
    end: '2026-07-25T12:00:00.000Z',
    sinceDays: 2,
  });
  assert.deepEqual(listed.filters, { types: ['job_saved'], currentOnly: true });
  assert.equal(listed.observations.length, 1);
  assert.equal(one(store, 'SELECT reference_id FROM career_memory_observations WHERE id=?', [listed.observations[0].id]).reference_id, 'newer-feedback');
  assert.deepEqual(Object.keys(listed), [
    'schema', 'observationSchema', 'profileId', 'period', 'filters', 'observations', 'excluded',
  ]);
  assert.deepEqual(Object.keys(listed.observations[0]), [
    'schema',
    'id',
    'profileId',
    'eventType',
    'occurredAt',
    'recordedAt',
    'actor',
    'source',
    'sourceEntity',
    'reasonCodes',
    'signals',
    'publicExplanation',
    'hasPrivateNote',
    'current',
    'supersedesObservationId',
    'payload',
    'interpretation',
    'externalSideEffects',
  ]);
  assert.equal(listed.excluded.outsidePeriod >= 1, true);
  assert.deepEqual([...listed.observations].map(item => item.id), [...listed.observations]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)
      || right.recordedAt.localeCompare(left.recordedAt)
      || left.id.localeCompare(right.id)).map(item => item.id));
  store.db.close();
});

test('W08-OBS-06 private notes require trusted get and never leak through normal lists or mirrors', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const secret = 'private note should remain in sqlite';
  const recorded = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback({ privateNote: secret }),
    actor: 'user',
    source: 'cli',
  });
  const normal = api.listMemoryObservations(store, { profileId: 'alpha', sinceDays: null, nowDate: PHASE2_NOW });
  const normalRow = normal.observations.find(item => item.id === recorded.id);
  assert.equal(Object.hasOwn(normalRow, 'privateNote'), false);
  assert.equal(normal.excluded.privateNotes >= 1, true);
  assert.equal(Object.hasOwn(api.getMemoryObservation(store, { profileId: 'alpha', observationId: recorded.id }), 'privateNote'), false);
  assert.equal(api.getMemoryObservation(store, {
    profileId: 'alpha',
    observationId: recorded.id,
    includePrivateNote: true,
  }).privateNote, secret);
  const mirrorText = readFileSync(memoryMirror(root), 'utf8');
  assert.equal(mirrorText.includes(secret), false);
  assert.equal(mirrorText.includes('&'), false);
  assert.equal(mirrorText.includes('*'), false);
  store.db.close();
});

test('W08-OBS-07 failed native writes leave observation, audit, mirror, and protected-state deltas at zero', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const { artifact, event } = approvedArtifactSource(store);
  const beforeCounts = phase2Counts(store);
  const beforeProtected = protectedRows(store);
  const appendInput = {
    profileId: 'alpha',
    eventType: 'artifact_approved',
    sourceSchema: 'jobos.artifact-feedback-input.v1',
    sourceEntity: {
      type: 'artifact',
      id: artifact.id,
      versionId: event.id,
      revision: 2,
      contentHash: artifact.content_hash,
    },
    occurredAt: '2026-07-24T12:10:00.000Z',
    actor: 'user',
    source: 'cli',
    reasonCodes: ['tone'],
    signals: [{ ruleType: 'tone', value: { value: 'concise' } }],
    publicExplanation: '',
    privateNote: '',
    payload: { decision: 'approve' },
    referenceId: 'failed-artifact-feedback',
  };
  assert.throws(() => guardedWrite(store, () => api.appendMemoryObservation(store, {
    ...appendInput,
    profileId: 'beta',
  })), error => error?.code === 'memory_profile_source_mismatch');
  assert.throws(() => guardedWrite(store, () => api.appendMemoryObservation(store, {
    ...appendInput,
    sourceEntity: { ...appendInput.sourceEntity, versionId: 'audit_wrong_source_version' },
  })), error => error?.code === 'memory_source_version_stale');
  assert.deepEqual(phase2Counts(store), beforeCounts);
  assert.deepEqual(protectedRows(store), beforeProtected);
  assert.equal(existsSync(memoryMirror(root, 'alpha')), false);
  assert.equal(existsSync(memoryMirror(root, 'beta')), false);
  store.db.close();
});

test('W08-OBS-08 reopen and exact replay preserve deterministic IDs, mirror bytes, and W01-W07 state', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  let store = await openStore({ workspace: root });
  const protectedBefore = protectedRows(store);
  const args = {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback({ referenceId: 'deterministic-reopen' }),
    actor: 'user',
    source: 'cli',
  };
  const first = api.recordJobFeedback(store, args);
  const firstMirror = readFileSync(memoryMirror(root));
  store.db.close();
  store = await openStore({ workspace: root });
  const replay = api.recordJobFeedback(store, args);
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(readFileSync(memoryMirror(root)), firstMirror);
  assert.deepEqual(protectedRows(store), protectedBefore);
  store.db.close();
});

test('W08-CORRECT-01 correction appends one successor and resolves current versus history deterministically', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const rootObservation = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback({ privateNote: 'original private note' }),
    actor: 'user',
    source: 'cli',
  });
  const correctionArgs = {
    profileId: 'alpha',
    observationId: rootObservation.id,
    replacement: {
      reasonCodes: ['role_fit', 'skills_match'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: 'corrected private note',
    },
    reason: 'Corrected the recorded reasons.',
    referenceId: 'w08-correction-reference',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T13:00:00.000Z',
  };
  const corrected = api.correctMemoryObservation(store, correctionArgs);
  assert.equal(corrected.supersedesObservationId, rootObservation.id);
  assert.equal(one(store, 'SELECT correction_reason FROM career_memory_observations WHERE id=?', [corrected.id]).correction_reason, 'Corrected the recorded reasons.');
  const databaseAfterCorrection = readFileSync(path.join(root, '.jobos', 'jobos.sqlite'));
  const revisionAfterCorrection = one(store, "SELECT value FROM meta WHERE key='store_revision'").value;
  const correctionReplay = api.correctMemoryObservation(store, correctionArgs);
  assert.equal(correctionReplay.id, corrected.id);
  assert.equal(correctionReplay.idempotent, true);
  assert.deepEqual(readFileSync(path.join(root, '.jobos', 'jobos.sqlite')), databaseAfterCorrection);
  assert.equal(one(store, "SELECT value FROM meta WHERE key='store_revision'").value, revisionAfterCorrection);
  const current = api.listMemoryObservations(store, { profileId: 'alpha', types: ['job_saved'], sinceDays: null, nowDate: PHASE2_NOW });
  assert.deepEqual(current.observations.map(item => item.id), [corrected.id]);
  assert.equal(current.excluded.superseded >= 1, true);
  const history = api.listMemoryObservations(store, {
    profileId: 'alpha',
    types: ['job_saved'],
    sinceDays: null,
    includeHistory: true,
    nowDate: PHASE2_NOW,
  });
  assert.deepEqual(new Set(history.observations.map(item => item.id)), new Set([rootObservation.id, corrected.id]));
  assert.equal(api.getMemoryObservation(store, { profileId: 'alpha', observationId: rootObservation.id }).current, false);
  store.db.close();
});

test('W08-CORRECT-02 stale and non-current corrections plus conflicting references are zero-write failures', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const rootObservation = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback(),
    actor: 'user',
    source: 'cli',
  });
  const correctionArgs = {
    profileId: 'alpha',
    observationId: rootObservation.id,
    replacement: {
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: '',
    },
    reason: 'First correction.',
    referenceId: 'first-correction-reference',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T13:00:00.000Z',
  };
  const correction = api.correctMemoryObservation(store, correctionArgs);
  const after = phase2Counts(store);
  assert.throws(() => api.correctMemoryObservation(store, {
    ...correctionArgs,
    referenceId: 'second-correction-reference',
  }), error => error?.code === 'memory_observation_not_current');
  assert.throws(() => api.correctMemoryObservation(store, {
    ...correctionArgs,
    observationId: correction.id,
    reason: 'Conflicting replay.',
  }), error => error?.code === 'memory_reference_conflict');
  assert.deepEqual(phase2Counts(store), after);
  store.db.close();
});

test('W08-CORRECT-03 undo appends a restoration and exact replay is idempotent', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const rootObservation = api.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: alphaSavedJob(store).id,
    input: jobFeedback(),
    actor: 'user',
    source: 'cli',
  });
  const correction = api.correctMemoryObservation(store, {
    profileId: 'alpha',
    observationId: rootObservation.id,
    replacement: {
      reasonCodes: ['skills_match'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: 'discard this correction note',
    },
    reason: 'Correct reasons.',
    referenceId: 'correction-before-undo',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T13:00:00.000Z',
  });
  const args = {
    profileId: 'alpha',
    observationId: correction.id,
    reason: 'Undo the correction.',
    referenceId: 'undo-correction-reference',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T14:00:00.000Z',
  };
  const restored = api.undoMemoryObservation(store, args);
  assert.equal(restored.supersedesObservationId, correction.id);
  assert.equal(one(store, 'SELECT undoes_observation_id FROM career_memory_observations WHERE id=?', [restored.id]).undoes_observation_id, correction.id);
  assert.deepEqual(restored.reasonCodes, rootObservation.reasonCodes);
  assert.deepEqual(restored.signals, rootObservation.signals);
  assert.equal(api.getMemoryObservation(store, {
    profileId: 'alpha',
    observationId: restored.id,
    includePrivateNote: true,
  }).privateNote, '');
  const after = phase2Counts(store);
  const databaseAfterUndo = readFileSync(path.join(root, '.jobos', 'jobos.sqlite'));
  const revisionAfterUndo = one(store, "SELECT value FROM meta WHERE key='store_revision'").value;
  const replay = api.undoMemoryObservation(store, args);
  assert.equal(replay.id, restored.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(phase2Counts(store), after);
  assert.deepEqual(readFileSync(path.join(root, '.jobos', 'jobos.sqlite')), databaseAfterUndo);
  assert.equal(one(store, "SELECT value FROM meta WHERE key='store_revision'").value, revisionAfterUndo);
  store.db.close();
});

test('W08-ADAPTER-01 W05 adapter preserves source versions and current/history without row copies or private notes', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const current = api.listMemoryObservations(store, { profileId: 'alpha', sinceDays: null, nowDate: PHASE2_NOW });
  const currentW05 = current.observations.filter(item => item.source === 'w05_adapter');
  const history = api.listMemoryObservations(store, {
    profileId: 'alpha',
    sinceDays: null,
    includeHistory: true,
    nowDate: PHASE2_NOW,
  });
  const historyW05 = history.observations.filter(item => item.source === 'w05_adapter');
  assert.equal(currentW05.length, 1);
  assert.equal(historyW05.length, 2);
  assert.equal(currentW05[0].eventType, 'reply_positive');
  assert.equal(historyW05.some(item => item.eventType === 'reply_neutral' && item.current === false), true);
  assert.equal(historyW05.every(item => item.sourceEntity.type === 'outreach_thread'), true);
  assert.equal(historyW05.every(item => /^[a-f0-9]{64}$/.test(item.sourceEntity.contentHash)), true);
  assert.equal(historyW05.some(item => JSON.stringify(item).includes('private')), false);
  const beforeWindowChange = historyW05[0];
  const changedWindowEndAt = '2026-08-31T12:00:00.000Z';
  run(store, 'UPDATE outreach_outcomes SET window_end_at=? WHERE id=?', [changedWindowEndAt, beforeWindowChange.id]);
  const afterWindowChange = api.listMemoryObservations(store, {
    profileId: 'alpha',
    sinceDays: null,
    includeHistory: true,
    nowDate: PHASE2_NOW,
  }).observations.find(item => item.id === beforeWindowChange.id);
  assert.equal(afterWindowChange.payload.windowEndAt, changedWindowEndAt);
  assert.notEqual(afterWindowChange.sourceEntity.contentHash, beforeWindowChange.sourceEntity.contentHash);
  assert.deepEqual({
    ...afterWindowChange,
    sourceEntity: {
      ...afterWindowChange.sourceEntity,
      contentHash: beforeWindowChange.sourceEntity.contentHash,
    },
    payload: {
      ...afterWindowChange.payload,
      windowEndAt: beforeWindowChange.payload.windowEndAt,
    },
  }, beforeWindowChange);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 0);
  store.db.close();
});

test('W08-ADAPTER-02 W06 adapter preserves application status and receipt attribution without duplicating W07 debriefs', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const listed = api.listMemoryObservations(store, {
    profileId: 'alpha',
    sinceDays: null,
    includeHistory: true,
    nowDate: PHASE2_NOW,
  });
  const w06 = listed.observations.filter(item => item.source === 'w06_adapter');
  const w07 = listed.observations.filter(item => item.source === 'w07_adapter');
  assert.equal(w06.some(item => item.eventType === 'application_status_changed'), true);
  assert.equal(w06.some(item => ['submission_attested', 'configured_submission_confirmed', 'receipt_confirmed'].includes(item.eventType)), true);
  assert.equal(w07.filter(item => item.eventType === 'interview_debrief_recorded').length, 2);
  assert.equal(w06.every(item => item.sourceEntity.type === 'application'), true);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 0);
  store.db.close();
});

test('W08-ADAPTER-03 W07 adapter keeps exact revision identity, current semantics, bounded payload, and no notes', async t => {
  const api = await observationApi();
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const current = api.listMemoryObservations(store, { profileId: 'alpha', sinceDays: null, nowDate: PHASE2_NOW });
  const currentW07 = current.observations.filter(item => item.source === 'w07_adapter');
  const history = api.listMemoryObservations(store, {
    profileId: 'alpha',
    sinceDays: null,
    includeHistory: true,
    nowDate: PHASE2_NOW,
  });
  const historyW07 = history.observations.filter(item => item.source === 'w07_adapter');
  assert.equal(currentW07.length, 1);
  assert.equal(historyW07.length, 2);
  assert.equal(currentW07[0].sourceEntity.revision, 2);
  assert.match(currentW07[0].sourceEntity.versionId, /^interview_debrief_revision_/);
  assert.deepEqual(Object.keys(currentW07[0].payload).sort(), [
    'applicationId',
    'audience',
    'interviewStage',
    'jobId',
    'observedQuestions',
    'outcome',
    'proofGaps',
    'storyUses',
  ]);
  assert.equal(historyW07.some(item => item.current === false), true);
  const original = historyW07.find(item => item.sourceEntity.revision === 1);
  assert.equal(currentW07[0].supersedesObservationId, original.id);
  assert.equal(historyW07.some(item => JSON.stringify(item).includes('Corrected after reviewing')), false);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 0);
  store.db.close();
});
