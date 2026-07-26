import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';
import { updateJobStatus } from '../src/jobs.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const NOW = new Date('2026-07-25T12:00:00.000Z');
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const OBSERVATION_SCHEMA = 'jobos.career-memory-observation.v1';

async function retrievalApi() {
  return import('../src/career-memory-retrieval.js');
}

async function observationApi() {
  return import('../src/career-memory-observations.js');
}

async function proposalApi() {
  return import('../src/career-memory-proposals.js');
}

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-phase4b-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cloneRow(store, table, source, changes) {
  const row = { ...source, ...changes };
  const columns = Object.keys(row);
  run(store, `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
  return one(store, `SELECT * FROM ${table} WHERE id=?`, [row.id]);
}

function writeCounts(store) {
  return Object.fromEntries([
    'career_memory_observations',
    'career_memory_proposals',
    'career_memory_proposal_evidence',
    'career_memory_proposal_transitions',
    'career_memory_projection_revisions',
    'audit_log',
  ].map(table => [table, one(store, `SELECT COUNT(*) AS count FROM ${table}`).count]));
}

const RULE_FIELDS = Object.freeze([
  ['role_family', 'product manager 🙂'],
  ['seniority', 'product manager 🙂'],
  ['company_stage', 'series b'],
  ['industry', 'software'],
  ['location', 'remote'],
  ['work_model', 'remote'],
]);

async function seedAcceptedSearchRules(store, { count = 2, profileId = 'alpha' } = {}) {
  const observations = await observationApi();
  const proposals = await proposalApi();
  const base = one(store, 'SELECT * FROM jobs WHERE profile_id=? ORDER BY id LIMIT 1', [profileId]);
  const evidence = [];
  for (let index = 0; index < 3; index += 1) {
    const jobId = `job_phase4b_${profileId}_${index}`;
    guardedWrite(store, () => cloneRow(store, 'jobs', base, {
      id: jobId,
      profile_id: profileId,
      title: 'Product Manager 🙂',
      location: 'Remote',
      work_model: 'remote',
      source_native_json: JSON.stringify({ companyStage: 'Series B', industry: 'Software' }),
      url: `jobos:test:${jobId}`,
      status: 'new',
      created_at: `2026-07-${20 + index}T08:00:00.000Z`,
      updated_at: `2026-07-${20 + index}T08:00:00.000Z`,
    }));
    updateJobStatus(store, jobId, 'saved');
    evidence.push(observations.recordJobFeedback(store, {
      profileId,
      jobId,
      input: {
        schema: 'jobos.job-feedback-input.v1',
        decision: 'save',
        reasonCodes: ['role_fit', 'seniority_fit', 'company_stage', 'industry', 'location'],
        signals: RULE_FIELDS.map(([field, value]) => ({ field, polarity: 'prefer', value, match: 'exact' })),
        publicExplanation: index === 0 ? 'Résumé guidance 🙂 remains public.' : '',
        privateNote: index === 0 ? 'PRIVATE_SENTINEL_NEVER_RETRIEVED' : '',
        referenceId: `phase4b-feedback-${profileId}-${index}`,
        occurredAt: `2026-07-${20 + index}T10:00:00.000Z`,
      },
      actor: 'user',
      source: 'cli',
    }));
  }
  const accepted = [];
  for (let index = 0; index < count; index += 1) {
    const [ruleType, value] = RULE_FIELDS[index];
    const proposal = proposals.createMemoryProposal(store, {
      schema: 'jobos.memory-proposal-input.v1',
      domain: 'search',
      scope: 'search',
      ruleType,
      value: { polarity: 'prefer', value, match: 'exact' },
      rationale: 'Repeated structured job feedback supports this public-field guidance.',
      evidence: evidence.map(item => ({
        observationSchema: OBSERVATION_SCHEMA,
        observationId: item.id,
        polarity: 'support',
      })),
      referenceId: `phase4b-proposal-${profileId}-${ruleType}`,
      createdAt: CREATED_AT,
    });
    proposals.transitionMemoryProposal(store, {
      profileId,
      proposalId: proposal.id,
      action: 'accept',
      reason: '',
      referenceId: `phase4b-accept-${profileId}-${ruleType}`,
      actor: 'user',
      source: 'cli',
      nowDate: NOW,
    });
    accepted.push(proposal.id);
  }
  return { accepted, evidence, jobId: `job_phase4b_${profileId}_0` };
}

function assertTypedError(fn, code) {
  assert.throws(fn, error => error?.type === 'validation' && error?.code === code);
}

test('W08-RETRIEVAL-01 freezes packet keys, defaults, scopes, ownership, and prerequisites', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const seeded = await seedAcceptedSearchRules(store);
  const packet = api.retrieveCareerMemory(store, {
    profileId: 'alpha',
    consumer: 'discovery',
    jobId: seeded.jobId,
    asOf: NOW,
  });

  assert.deepEqual(Object.keys(packet), [
    'schema', 'profileId', 'consumer', 'jobId', 'artifactType', 'asOf', 'budgets',
    'rules', 'observations', 'citations', 'exclusions', 'policy', 'externalSideEffects',
  ]);
  assert.equal(packet.schema, 'jobos.career-memory-retrieval.v1');
  assert.deepEqual(packet.budgets, {
    maxRules: 8,
    maxObservations: 8,
    lookbackDays: 180,
    maxUtf8Bytes: 4000,
    usedUtf8Bytes: packet.budgets.usedUtf8Bytes,
  });
  assert.deepEqual(packet.rules.map(rule => rule.id), seeded.accepted);
  assert.ok(packet.rules.every(rule => rule.domain === 'search' && rule.scope === 'search'));
  assert.ok(packet.observations.every(item => item.profileId === 'alpha' && item.current));
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_SENTINEL_NEVER_RETRIEVED/);
  assert.equal(packet.externalSideEffects, 'none');

  assertTypedError(() => api.retrieveCareerMemory(store, { profileId: 'beta', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW }), 'memory_job_unknown');
  assertTypedError(() => api.retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', asOf: NOW }), 'memory_job_required');
  assertTypedError(() => api.retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'tailoring', artifactType: 'outreach', asOf: NOW }), 'memory_artifact_type_invalid');
  assertTypedError(() => api.retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'outreach', artifactType: 'resume', asOf: NOW }), 'memory_artifact_type_unexpected');
});

test('W08-RETRIEVAL-02 filters before budget and orders rules and observations deterministically', async t => {
  const api = await retrievalApi();
  const proposals = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const seeded = await seedAcceptedSearchRules(store, { count: 4 });

  const first = api.retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW });
  assert.deepEqual(first.rules.map(rule => rule.ruleType), ['role_family', 'seniority', 'company_stage', 'industry']);
  assert.deepEqual(first.observations.map(item => item.occurredAt), [...first.observations.map(item => item.occurredAt)].sort().reverse());
  assert.equal(first.observations.some(item => !item.current), false);

  proposals.transitionMemoryProposal(store, {
    profileId: 'alpha',
    proposalId: seeded.accepted[1],
    action: 'revoke',
    reason: 'No longer applicable',
    referenceId: 'phase4b-revoke-seniority',
    actor: 'user',
    source: 'cli',
    nowDate: NOW,
  });
  const second = api.retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW });
  assert.equal(second.rules.some(rule => rule.id === seeded.accepted[1]), false);
  assert.deepEqual(second.rules.map(rule => rule.ruleType), ['role_family', 'company_stage', 'industry']);
});

test('W08-RETRIEVAL-03 enforces whole-item count and UTF-8 byte budgets with exact drops', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const seeded = await seedAcceptedSearchRules(store, { count: 2 });
  const oneRule = api.retrieveCareerMemory(store, {
    profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW,
    budgets: { maxRules: 1, maxObservations: 0, lookbackDays: 180, maxUtf8Bytes: 4000 },
  });
  const exactBytes = Buffer.byteLength(JSON.stringify(oneRule.rules[0]), 'utf8');
  assert.ok(exactBytes > JSON.stringify(oneRule.rules[0]).length);

  const exact = api.retrieveCareerMemory(store, {
    profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW,
    budgets: { maxRules: 1, maxObservations: 0, lookbackDays: 180, maxUtf8Bytes: exactBytes },
  });
  assert.equal(exact.rules.length, 1);
  assert.equal(exact.budgets.usedUtf8Bytes, exactBytes);
  assert.deepEqual(exact.exclusions.budget, { rules: 1, observations: 3 });

  const short = api.retrieveCareerMemory(store, {
    profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW,
    budgets: { maxRules: 1, maxObservations: 0, lookbackDays: 180, maxUtf8Bytes: exactBytes - 1 },
  });
  assert.deepEqual(short.rules, []);
  assert.deepEqual(short.observations, []);
  assert.deepEqual(short.exclusions.budget, { rules: 2, observations: 3 });
  assertTypedError(() => api.retrieveCareerMemory(store, {
    profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW,
    budgets: { maxRules: 9 },
  }), 'memory_budgets_invalid');
});

test('W08-RETRIEVAL-04 deduplicates canonical citations in first-use order', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const seeded = await seedAcceptedSearchRules(store, { count: 2 });
  const packet = api.retrieveCareerMemory(store, {
    profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobId, asOf: NOW,
  });

  assert.equal(packet.citations.length, 3);
  assert.deepEqual(packet.citations, packet.rules[0].citations);
  assert.deepEqual(packet.rules[1].citations, packet.rules[0].citations);
  assert.equal(new Set(packet.citations.map(item => `${item.schema}\0${item.id}\0${item.versionId}`)).size, packet.citations.length);
  assert.deepEqual(Object.keys(packet.citations[0]), ['schema', 'id', 'versionId']);
});

test('W08-RETRIEVAL-05 is write-free, cache-free, profile-isolated, and zero-rule compatible', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const before = writeCounts(store);
  const first = api.retrieveCareerMemory(store, {
    profileId: 'beta', consumer: 'outreach', asOf: NOW,
  });
  const second = api.retrieveCareerMemory(store, {
    profileId: 'beta', consumer: 'outreach', asOf: NOW,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.rules, []);
  assert.deepEqual(first.citations, []);
  assert.deepEqual(writeCounts(store), before);
});

test('W08-RANK-01 matches only canonical public job fields and clamps accepted guidance', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const seeded = await seedAcceptedSearchRules(store, { count: 6 });
  const guidance = api.evaluateSearchGuidance(store, { profileId: 'alpha', jobId: seeded.jobId, asOf: NOW });

  assert.deepEqual(Object.keys(guidance), ['schema', 'adjustment', 'matchedRuleIds', 'citations', 'explanation']);
  assert.equal(guidance.schema, 'jobos.career-memory-search-guidance.v1');
  assert.equal(guidance.adjustment, 10);
  assert.deepEqual(guidance.matchedRuleIds, seeded.accepted);
  assert.equal(guidance.explanation, 'accepted guidance; fit score unchanged');
});

test('W08-RANK-02 no-match guidance is deterministic, write-free, and never changes fit persistence', async t => {
  const api = await retrievalApi();
  const store = await openStore({ workspace: workspace(t) });
  const target = one(store, "SELECT * FROM jobs WHERE profile_id='beta' ORDER BY id LIMIT 1");
  const beforeWrites = writeCounts(store);
  const beforeFit = all(store, 'SELECT id,fit_score,score_json,high_fit FROM jobs ORDER BY id');
  const guidance = api.evaluateSearchGuidance(store, { profileId: 'beta', jobId: target.id, asOf: NOW });

  assert.deepEqual(guidance, {
    schema: 'jobos.career-memory-search-guidance.v1',
    adjustment: 0,
    matchedRuleIds: [],
    citations: [],
    explanation: 'accepted guidance; fit score unchanged',
  });
  assert.deepEqual(all(store, 'SELECT id,fit_score,score_json,high_fit FROM jobs ORDER BY id'), beforeFit);
  assert.deepEqual(writeCounts(store), beforeWrites);
});

test('W08-RANK-03 validates writing bounds, variants, avoid rules, proofs, and exemplar noncopy without generation', async () => {
  const api = await retrievalApi();
  const packet = {
    schema: 'jobos.career-memory-retrieval.v1',
    profileId: 'alpha',
    consumer: 'tailoring',
    jobId: 'job-1',
    artifactType: 'resume',
    asOf: NOW.toISOString(),
    budgets: { maxRules: 12, maxObservations: 6, lookbackDays: 365, maxUtf8Bytes: 6000, usedUtf8Bytes: 0 },
    rules: [
      { id: 'length-rule', domain: 'writing', scope: 'resume', ruleType: 'length', value: { minWords: 4, maxWords: 6 }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'opening-rule', domain: 'writing', scope: 'resume', ruleType: 'opening', value: { value: 'proof_first' }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'closing-rule', domain: 'writing', scope: 'resume', ruleType: 'closing', value: { value: 'gratitude' }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'term-rule', domain: 'writing', scope: 'resume', ruleType: 'avoid_term', value: { terms: ['synergy'] }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'claim-rule', domain: 'writing', scope: 'resume', ruleType: 'avoid_claim', value: { claimPattern: 'doubled revenue', reasonCode: 'unsupported' }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'proof-rule', domain: 'writing', scope: 'resume', ruleType: 'positioning_priority', value: { theme: 'delivery', proofPointIds: ['proof-allowed'] }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
      { id: 'exemplar-rule', domain: 'writing', scope: 'resume', ruleType: 'approved_exemplar', value: { artifactId: 'artifact-1', revision: 2, contentHash: 'content-hash', startLine: 1, endLine: 2, excerptHash: 'copied-hash' }, acceptedAt: CREATED_AT, evidenceFreshUntil: '2027-01-01T00:00:00.000Z', citations: [] },
    ],
    observations: [], citations: [], exclusions: { rules: [], observations: { superseded: 0, outsideLookback: 0, privateNotes: 0, irrelevant: 0, protected: 0 }, budget: { rules: 0, observations: 0 } },
    policy: { acceptedGuidanceOnly: true, currentObservationsOnly: true, privateNotes: 'excluded', protectedSensitiveData: 'excluded', facts: 'canonical_sources_only' },
    externalSideEffects: 'none',
  };
  const valid = api.validateWritingGuidance({
    text: 'Delivered verified outcomes with evidence.',
    openingVariant: 'proof_first',
    closingVariant: 'gratitude',
    proofPointIds: ['proof-allowed'],
    claims: [],
    exemplarExcerptHashes: [],
  }, packet);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, []);

  const invalid = api.validateWritingGuidance({
    text: 'Synergy doubled revenue.',
    openingVariant: 'direct',
    closingVariant: 'none',
    proofPointIds: ['proof-invented'],
    claims: ['doubled revenue'],
    exemplarExcerptHashes: ['copied-hash'],
  }, packet);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors.map(error => error.code), [
    'memory_writing_length_invalid',
    'memory_writing_opening_invalid',
    'memory_writing_closing_invalid',
    'memory_writing_avoid_term',
    'memory_writing_avoid_claim',
    'memory_writing_proof_not_allowed',
    'memory_writing_exemplar_copied',
  ]);
  assert.equal(invalid.generated, undefined);
  assertTypedError(() => api.validateWritingGuidance({ text: 'facts' }, { ...packet, schema: 'wrong' }), 'memory_retrieval_packet_invalid');
});
