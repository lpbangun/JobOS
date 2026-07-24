import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, guardedWrite, one, openStore, recordAudit, run } from '../src/db.js';
import { updateJobStatus } from '../src/jobs.js';
import { recordOutreachOutcome } from '../src/outreach-outcomes.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const NOW = new Date('2026-07-25T12:00:00.000Z');
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const OBSERVATION_SCHEMA = 'jobos.career-memory-observation.v1';
const PROPOSAL_INPUT_SCHEMA = 'jobos.memory-proposal-input.v1';

async function proposalApi() {
  return import('../src/career-memory-proposals.js');
}

async function observationApi() {
  return import('../src/career-memory-observations.js');
}

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-phase3-'));
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

function countRows(store) {
  return Object.fromEntries([
    'career_memory_proposals',
    'career_memory_proposal_evidence',
    'career_memory_proposal_transitions',
    'career_memory_projection_revisions',
    'audit_log',
  ].map(table => [table, one(store, `SELECT COUNT(*) AS count FROM ${table}`).count]));
}

function searchProposal(evidence, overrides = {}) {
  return {
    schema: PROPOSAL_INPUT_SCHEMA,
    domain: 'search',
    scope: 'search',
    ruleType: 'role_family',
    value: { polarity: 'prefer', value: 'product manager', match: 'exact' },
    rationale: 'Repeated direct job feedback supports this visible preference.',
    evidence: evidence.map(observation => ({
      observationSchema: observation.observationSchema || OBSERVATION_SCHEMA,
      observationId: observation.id,
      polarity: observation.polarity || 'support',
    })),
    referenceId: 'proposal-search-default',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function transitionArgs(proposalId, action, referenceId, overrides = {}) {
  return {
    profileId: 'alpha',
    proposalId,
    action,
    reason: action === 'accept' ? '' : `${action} reviewed`,
    referenceId,
    actor: 'user',
    source: 'cli',
    nowDate: NOW,
    ...overrides,
  };
}

async function seedSearchObservations(store, {
  count = 3,
  profileId = 'alpha',
  polarity = 'prefer',
  startDay = 20,
  referencePrefix = 'search-observation',
} = {}) {
  const api = await observationApi();
  const base = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND status=? ORDER BY id LIMIT 1', [profileId, 'saved']);
  const observations = [];
  for (let index = 0; index < count; index += 1) {
    let job = base;
    if (index > 0) {
      const jobId = `job_phase3_${profileId}_${referencePrefix}_${index}`.replace(/[^a-zA-Z0-9_]/g, '_');
      job = guardedWrite(store, () => cloneRow(store, 'jobs', base, {
        id: jobId,
        url: `jobos:test:${jobId}`,
        status: 'new',
        created_at: `2026-07-${String(startDay + index).padStart(2, '0')}T08:00:00.000Z`,
        updated_at: `2026-07-${String(startDay + index).padStart(2, '0')}T08:00:00.000Z`,
      }));
      updateJobStatus(store, job.id, 'saved');
    }
    observations.push(api.recordJobFeedback(store, {
      profileId,
      jobId: job.id,
      input: {
        schema: 'jobos.job-feedback-input.v1',
        decision: 'save',
        reasonCodes: ['role_fit'],
        signals: [{ field: 'role_family', polarity, value: job.title, match: 'exact' }],
        publicExplanation: '',
        privateNote: index === 0 ? 'never proposal evidence' : '',
        referenceId: `${referencePrefix}-${profileId}-${index}`,
        occurredAt: `2026-07-${String(startDay + index).padStart(2, '0')}T10:00:00.000Z`,
      },
      actor: 'user',
      source: 'cli',
    }));
  }
  return observations;
}

async function seedUpstreamOutreachObservations(store, {
  count = 4,
  referencePrefix,
  occurredDates,
} = {}) {
  const observations = await observationApi();
  const baseJob = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const baseThread = one(store, "SELECT * FROM outreach_threads WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const evidence = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = `${referencePrefix}_${index}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const jobId = `job_phase3_upstream_${suffix}`;
    const threadId = `thread_phase3_upstream_${suffix}`;
    const occurredDate = occurredDates[index];
    guardedWrite(store, () => {
      cloneRow(store, 'jobs', baseJob, {
        id: jobId,
        profile_id: 'alpha',
        title: 'Product Manager',
        url: `jobos:test:${jobId}`,
        created_at: `${occurredDate}T08:00:00.000Z`,
        updated_at: `${occurredDate}T08:00:00.000Z`,
      });
      cloneRow(store, 'outreach_threads', baseThread, {
        id: threadId,
        job_id: jobId,
        profile_id: 'alpha',
        channel: 'email',
        sent_at: `${occurredDate}T08:30:00.000Z`,
        created_at: `${occurredDate}T08:00:00.000Z`,
        updated_at: `${occurredDate}T08:30:00.000Z`,
      });
    });
    const outcome = recordOutreachOutcome(store, {
      threadId,
      profileId: 'alpha',
      type: 'reply_positive',
      occurredAt: `${occurredDate}T10:00:00.000Z`,
      actor: 'user',
      source: 'cli',
      referenceId: `${referencePrefix}-${index}`,
    }, { includeNotes: false });
    const adapted = observations.listMemoryObservations(store, {
      profileId: 'alpha',
      sinceDays: null,
      nowDate: NOW,
    }).observations.find(item => item.id === outcome.id);
    evidence.push({ ...adapted, observationSchema: 'jobos.outreach-outcome.v1' });
  }
  return evidence;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function seedArtifactObservations(store, {
  scope = 'resume',
  count = 3,
  referencePrefix = 'artifact-tone',
  ruleType = 'tone',
  value = { value: 'concise' },
  occurredDates = null,
} = {}) {
  const api = await observationApi();
  const base = one(store, "SELECT * FROM artifacts WHERE profile_id='alpha' AND approval_status='approved' ORDER BY id LIMIT 1");
  const observations = [];
  for (let index = 0; index < count; index += 1) {
    const artifactId = `artifact_phase3_${scope}_${referencePrefix}_${index}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const content = `# ${scope} exemplar ${index}\nConcise evidence ${index}.\n`;
    const occurredDate = occurredDates?.[index] || `2026-07-${String(20 + index).padStart(2, '0')}`;
    const seeded = guardedWrite(store, () => {
      const artifact = cloneRow(store, 'artifacts', base, {
        id: artifactId,
        job_id: null,
        type: scope,
        path: `phase3/${artifactId}.md`,
        title: `${scope} ${index}`,
        content,
        series_key: `${scope}:phase3:${referencePrefix}:${index}`,
        revision: 1,
        supersedes_artifact_id: null,
        content_hash: sha256(content),
        approval_status: 'approved',
        created_at: `${occurredDate}T09:00:00.000Z`,
        reviewed_at: `${occurredDate}T09:30:00.000Z`,
        reviewed_by: 'cli',
        review_note: '',
      });
      const auditEvent = recordAudit(store, 'artifact.approved', 'artifact', artifact.id, { artifactId: artifact.id, profileId: 'alpha' });
      const observation = api.appendMemoryObservation(store, {
        profileId: 'alpha',
        eventType: 'artifact_approved',
        sourceSchema: 'jobos.artifact-feedback-input.v1',
        sourceEntity: {
          type: 'artifact',
          id: artifact.id,
          versionId: auditEvent.id,
          revision: 1,
          contentHash: artifact.content_hash,
        },
        occurredAt: `${occurredDate}T10:00:00.000Z`,
        actor: 'user',
        source: 'cli',
        reasonCodes: [ruleType === 'tone' ? 'tone' : 'positioning'],
        signals: [{ ruleType, value }],
        publicExplanation: '',
        privateNote: '',
        payload: { decision: 'approve' },
        referenceId: `${referencePrefix}-${index}`,
      });
      return { artifact, observation };
    });
    observations.push({ ...seeded.observation, artifact: seeded.artifact });
  }
  return observations;
}

function writingProposal(scope, evidence, referenceId, overrides = {}) {
  return {
    schema: PROPOSAL_INPUT_SCHEMA,
    domain: 'writing',
    scope,
    ruleType: 'tone',
    value: { value: 'concise' },
    rationale: 'Repeated direct artifact feedback supports concise writing.',
    evidence: evidence.map(observation => ({
      observationSchema: OBSERVATION_SCHEMA,
      observationId: observation.id,
      polarity: 'support',
    })),
    referenceId,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

async function createEligibleSearch(store, suffix = 'default') {
  const api = await proposalApi();
  const evidence = await seedSearchObservations(store, { referencePrefix: `eligible-${suffix}` });
  const proposal = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: `proposal-${suffix}` }));
  return { api, evidence, proposal };
}

test('W08-PROPOSAL-01 creates exact cited immutable proposal plus initial inactive transition', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store);
  const proposal = api.createMemoryProposal(store, searchProposal(evidence));
  assert.equal(proposal.schema, 'jobos.career-memory-proposal.v1');
  assert.equal(proposal.profileId, 'alpha');
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.active, false);
  assert.equal(proposal.confidenceMilli, 950);
  assert.equal(proposal.confidenceBand, 'high');
  assert.equal(proposal.conflictState, 'none');
  assert.equal(proposal.evidence.length, 3);
  assert.equal(proposal.evidence.every(item => item.weight === 2 && /^[a-f0-9]{64}$/.test(item.evidenceHash)), true);
  assert.deepEqual(proposal.transitions.map(item => [item.sequence, item.fromStatus, item.toStatus]), [[1, null, 'proposed']]);
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', asOf: NOW }).rules, []);
  store.db.close();
});

test('W08-PROPOSAL-02 exact create replay is write-free and conflicting reference reuse rejects', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { referencePrefix: 'replay' });
  const input = searchProposal(evidence, { referenceId: 'proposal-replay' });
  const first = api.createMemoryProposal(store, input);
  const after = countRows(store);
  const replay = api.createMemoryProposal(store, input);
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(countRows(store), after);
  assert.throws(() => api.createMemoryProposal(store, { ...input, rationale: 'Changed rationale.' }), error => error.code === 'memory_reference_conflict');
  assert.deepEqual(countRows(store), after);
  store.db.close();
});

test('W08-PROPOSAL-02 omitted server time still replays exactly and duplicate content cannot reserve a new reference', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { referencePrefix: 'replay-server-time' });
  const { createdAt: _createdAt, ...input } = searchProposal(evidence, { referenceId: 'proposal-replay-server-time' });
  const first = api.createMemoryProposal(store, input);
  const after = countRows(store);
  await new Promise(resolve => setTimeout(resolve, 5));
  const replay = api.createMemoryProposal(store, input);
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(countRows(store), after);
  assert.throws(() => api.createMemoryProposal(store, {
    ...input,
    referenceId: 'proposal-duplicate-new-reference',
    createdAt: first.createdAt,
  }), error => error.code === 'memory_reference_conflict');
  assert.deepEqual(countRows(store), after);
  store.db.close();
});

test('W08-PROPOSAL-03 deterministic derive dry-run writes nothing and persisted derivation is stable', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  await seedSearchObservations(store, { referencePrefix: 'derive' });
  const before = countRows(store);
  const first = api.deriveMemoryProposals(store, { profileId: 'alpha', asOf: NOW, dryRun: true });
  const second = api.deriveMemoryProposals(store, { profileId: 'alpha', asOf: NOW, dryRun: true });
  assert.deepEqual(second, first);
  assert.equal(first.proposals.some(item => item.ruleType === 'role_family'), true);
  assert.deepEqual(countRows(store), before);
  const persisted = api.deriveMemoryProposals(store, { profileId: 'alpha', asOf: NOW, dryRun: false });
  assert.equal(persisted.proposals.length, first.proposals.length);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposals').count, persisted.proposals.length);
  store.db.close();
});

test('W08-PROPOSAL-04 list/get filters and history ordering are deterministic and profile-safe', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const { proposal } = await createEligibleSearch(store, 'list');
  const listed = api.listMemoryProposals(store, { profileId: 'alpha', statuses: ['proposed'], domain: 'search', scope: 'search' });
  assert.equal(listed.schema, 'jobos.career-memory-proposal-list.v1');
  assert.deepEqual(listed.proposals.map(item => item.id), [proposal.id]);
  assert.deepEqual(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id }).transitions.map(item => item.sequence), [1]);
  assert.throws(() => api.getMemoryProposal(store, { profileId: 'beta', proposalId: proposal.id }), error => error.code === 'memory_proposal_unknown');
  store.db.close();
});

test('W08-PROPOSAL-05 upstream outcome evidence is association-only and weight one', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const upstream = observations.listMemoryObservations(store, { profileId: 'alpha', sinceDays: null, nowDate: NOW })
    .observations.find(item => item.source === 'w05_adapter');
  const base = searchProposal([{ ...upstream, observationSchema: 'jobos.outreach-outcome.v1' }], {
    referenceId: 'upstream-association',
    rationale: 'Observed outreach response.',
  });
  assert.throws(() => api.createMemoryProposal(store, base), error => error.code === 'memory_causal_rationale_required');
  const proposal = api.createMemoryProposal(store, { ...base, rationale: 'Observed association, not cause.' });
  assert.equal(proposal.evidence[0].weight, 1);
  assert.equal(proposal.gates.ordinaryEvidence, false);
  store.db.close();
});

test('W08-PROPOSAL-06 freezes low/medium/high confidence band boundaries', async t => {
  const api = await proposalApi();
  const lowStore = await openStore({ workspace: workspace(t) });
  const lowSupport = await seedSearchObservations(lowStore, { count: 1, referencePrefix: 'confidence-low-support' });
  const lowConflict = await seedSearchObservations(lowStore, { count: 1, polarity: 'avoid', referencePrefix: 'confidence-low-conflict' });
  const low = api.createMemoryProposal(lowStore, searchProposal([
    ...lowSupport,
    { ...lowConflict[0], polarity: 'conflict' },
  ], { referenceId: 'proposal-confidence-low' }));
  assert.equal(low.confidenceMilli, 500);
  assert.equal(low.confidenceBand, 'low');
  lowStore.db.close();

  const highStore = await openStore({ workspace: workspace(t) });
  const highSupport = await seedSearchObservations(highStore, { count: 9, startDay: 10, referencePrefix: 'confidence-high-support' });
  const highConflict = await seedSearchObservations(highStore, { count: 1, polarity: 'avoid', referencePrefix: 'confidence-high-conflict' });
  const high = api.createMemoryProposal(highStore, searchProposal([
    ...highSupport,
    { ...highConflict[0], polarity: 'conflict' },
  ], { referenceId: 'proposal-confidence-high' }));
  assert.equal(high.confidenceMilli, 900);
  assert.equal(high.confidenceBand, 'high');
  highStore.db.close();
});

test('W08-PROPOSAL-06 confidence uses weighted conflicts, half-up milli, cap, and bands', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const support = await seedSearchObservations(store, { referencePrefix: 'confidence-support' });
  const conflict = await seedSearchObservations(store, { count: 1, polarity: 'avoid', referencePrefix: 'confidence-conflict' });
  const proposal = api.createMemoryProposal(store, searchProposal([
    ...support,
    { ...conflict[0], polarity: 'conflict' },
  ], { referenceId: 'proposal-confidence' }));
  assert.equal(proposal.confidenceMilli, 750);
  assert.equal(proposal.confidenceBand, 'medium');
  assert.equal(proposal.conflictState, 'present');
  store.db.close();
});

test('W08-PROPOSAL-07 corrected source invalidates proposal evidence without mutating history', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const { evidence, proposal } = await createEligibleSearch(store, 'corrected');
  observations.correctMemoryObservation(store, {
    profileId: 'alpha',
    observationId: evidence[0].id,
    replacement: {
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'avoid', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: '',
    },
    reason: 'Correct polarity.',
    referenceId: 'proposal-source-correction',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T13:00:00.000Z',
  });
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-corrected')), error => error.code === 'memory_evidence_not_current');
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id }).status, 'proposed');
  store.db.close();
});

test('W08-PROPOSAL-08 approved exemplar is exact single-source, scoped, explicit, and confidence 500', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const [source] = await seedArtifactObservations(store, { scope: 'resume', count: 1, referencePrefix: 'exemplar' });
  const firstLine = source.artifact.content.split(/\r?\n/)[0];
  const input = writingProposal('resume', [source], 'proposal-exemplar', {
    ruleType: 'approved_exemplar',
    value: {
      artifactId: source.artifact.id,
      revision: 1,
      contentHash: source.artifact.content_hash,
      startLine: 1,
      endLine: 1,
      excerptHash: sha256(firstLine),
    },
    rationale: 'Explicit human-selected style exemplar.',
  });
  const proposal = api.createMemoryProposal(store, input);
  assert.equal(proposal.confidenceMilli, 500);
  assert.equal(proposal.gates.label, 'explicit_exemplar_exception');
  const accepted = api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-exemplar'));
  assert.equal(accepted.toStatus, 'accepted');
  assert.throws(() => api.createMemoryProposal(store, { ...input, scope: 'writing_global', referenceId: 'bad-global-exemplar' }), error => error.code === 'memory_domain_scope_invalid');
  store.db.close();
});

test('W08-PROPOSAL-08 deterministic derivation never proposes or persists approved exemplars', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const [source] = await seedArtifactObservations(store, { scope: 'resume', count: 1, referencePrefix: 'derive-exemplar' });
  const firstLine = source.artifact.content.split(/\r?\n/)[0];
  const exemplarValue = {
    artifactId: source.artifact.id,
    revision: 1,
    contentHash: source.artifact.content_hash,
    startLine: 1,
    endLine: 1,
    excerptHash: sha256(firstLine),
  };
  guardedWrite(store, () => observations.appendMemoryObservation(store, {
    profileId: 'alpha',
    eventType: 'artifact_approved',
    sourceSchema: 'jobos.artifact-feedback-input.v1',
    sourceEntity: source.sourceEntity,
    occurredAt: '2026-07-23T11:00:00.000Z',
    actor: 'user',
    source: 'cli',
    reasonCodes: ['evidence_selection'],
    signals: [{ ruleType: 'approved_exemplar', value: exemplarValue }],
    publicExplanation: '',
    privateNote: '',
    payload: { decision: 'approve' },
    referenceId: 'derive-exemplar-signal',
  }));
  const dryRun = api.deriveMemoryProposals(store, { profileId: 'alpha', asOf: NOW, dryRun: true });
  assert.equal(dryRun.proposals.some(item => item.ruleType === 'approved_exemplar'), false);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposals').count, 0);
  const persisted = api.deriveMemoryProposals(store, { profileId: 'alpha', asOf: NOW, dryRun: false });
  assert.equal(persisted.proposals.some(item => item.ruleType === 'approved_exemplar'), false);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM career_memory_proposals WHERE rule_type='approved_exemplar'").count, 0);
  store.db.close();
});

test('W08-GATE-01 ordinary single-sample evidence remains proposed and cannot be accepted', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { count: 1, referencePrefix: 'single' });
  const proposal = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'proposal-single' }));
  assert.equal(proposal.gates.ordinaryEvidence, false);
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-single')), error => error.code === 'memory_evidence_insufficient');
  store.db.close();
});

test('W08-GATE-01 exact ordinary boundary accepts three supports across two roots, two dates, and weight four+', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { count: 2, referencePrefix: 'ordinary-boundary' });
  const repeatedJob = one(store, 'SELECT * FROM jobs WHERE id=?', [evidence[0].sourceEntity.id]);
  evidence.push(observations.recordJobFeedback(store, {
    profileId: 'alpha',
    jobId: repeatedJob.id,
    input: {
      schema: 'jobos.job-feedback-input.v1',
      decision: 'save',
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: repeatedJob.title, match: 'exact' }],
      publicExplanation: '',
      privateNote: '',
      referenceId: 'ordinary-boundary-repeat',
      occurredAt: '2026-07-22T10:00:00.000Z',
    },
    actor: 'user',
    source: 'cli',
  }));
  const proposal = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'proposal-ordinary-boundary' }));
  assert.equal(proposal.gates.supportCount, 3);
  assert.equal(proposal.gates.sourceRootCount, 2);
  assert.equal(proposal.gates.supportWeight, 6);
  assert.equal(proposal.gates.ordinaryEvidence, true);
  assert.equal(api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-ordinary-boundary')).toStatus, 'accepted');
  store.db.close();
});

test('W08-GATE-01 upstream-only evidence obeys the exact four ordinary thresholds without a direct-support gate', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const oneDate = await seedUpstreamOutreachObservations(store, {
    referencePrefix: 'upstream-one-date',
    occurredDates: ['2026-07-20', '2026-07-20', '2026-07-20', '2026-07-20'],
  });
  const near = api.createMemoryProposal(store, searchProposal(oneDate, {
    referenceId: 'proposal-upstream-one-date',
    rationale: 'Observed association, not cause.',
  }));
  assert.deepEqual({
    supportCount: near.gates.supportCount,
    directSupportCount: near.gates.directSupportCount,
    supportWeight: near.gates.supportWeight,
    sourceRootCount: near.gates.sourceRootCount,
    distinctDateCount: near.gates.distinctDateCount,
    ordinaryEvidence: near.gates.ordinaryEvidence,
  }, {
    supportCount: 4,
    directSupportCount: 0,
    supportWeight: 4,
    sourceRootCount: 4,
    distinctDateCount: 1,
    ordinaryEvidence: false,
  });
  assert.throws(
    () => api.transitionMemoryProposal(store, transitionArgs(near.id, 'accept', 'accept-upstream-one-date')),
    error => error.code === 'memory_evidence_insufficient',
  );

  const exact = await seedUpstreamOutreachObservations(store, {
    referencePrefix: 'upstream-exact',
    occurredDates: ['2026-07-20', '2026-07-20', '2026-07-21', '2026-07-21'],
  });
  const eligible = api.createMemoryProposal(store, searchProposal(exact, {
    referenceId: 'proposal-upstream-exact',
    rationale: 'Observed association, not cause.',
  }));
  assert.deepEqual({
    supportCount: eligible.gates.supportCount,
    directSupportCount: eligible.gates.directSupportCount,
    supportWeight: eligible.gates.supportWeight,
    sourceRootCount: eligible.gates.sourceRootCount,
    distinctDateCount: eligible.gates.distinctDateCount,
    ordinaryEvidence: eligible.gates.ordinaryEvidence,
  }, {
    supportCount: 4,
    directSupportCount: 0,
    supportWeight: 4,
    sourceRootCount: 4,
    distinctDateCount: 2,
    ordinaryEvidence: true,
  });
  assert.equal(api.transitionMemoryProposal(store, transitionArgs(eligible.id, 'accept', 'accept-upstream-exact')).toStatus, 'accepted');
  store.db.close();
});

test('W08-GATE-02 same-scope contradictory current evidence blocks acceptance', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const support = await seedSearchObservations(store, { referencePrefix: 'gate-conflict-support' });
  const conflict = await seedSearchObservations(store, { count: 1, polarity: 'avoid', referencePrefix: 'gate-conflict' });
  const proposal = api.createMemoryProposal(store, searchProposal([...support, { ...conflict[0], polarity: 'conflict' }], { referenceId: 'proposal-gate-conflict' }));
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-conflict')), error => error.code === 'memory_conflict_present');
  store.db.close();
});

test('W08-GATE-02 uncited ambient conflicts stay out of immutable citations and revalidate live', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const support = await seedSearchObservations(store, { referencePrefix: 'ambient-support' });
  const [conflict] = await seedSearchObservations(store, { count: 1, polarity: 'avoid', referencePrefix: 'ambient-conflict' });
  const input = searchProposal(support, { referenceId: 'proposal-ambient-conflict' });
  const proposal = api.createMemoryProposal(store, input);
  assert.equal(proposal.conflictState, 'present');
  assert.deepEqual(proposal.evidence.map(item => item.observationId), support.map(item => item.id).sort());
  assert.deepEqual(
    all(store, 'SELECT observation_id FROM career_memory_proposal_evidence WHERE proposal_id=? ORDER BY position', [proposal.id])
      .map(item => item.observation_id),
    support.map(item => item.id).sort(),
  );
  const before = countRows(store);
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-ambient-conflict')), error => error.code === 'memory_conflict_present');
  assert.deepEqual(countRows(store), before);

  observations.correctMemoryObservation(store, {
    profileId: 'alpha',
    observationId: conflict.id,
    replacement: {
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: '',
    },
    reason: 'Correct ambient polarity.',
    referenceId: 'ambient-conflict-correction',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T13:00:00.000Z',
  });
  const afterCorrection = countRows(store);
  const replay = api.createMemoryProposal(store, input);
  assert.equal(replay.id, proposal.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(countRows(store), afterCorrection);
  assert.equal(api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-ambient-corrected')).toStatus, 'accepted');

  const [laterConflict] = await seedSearchObservations(store, {
    count: 1,
    polarity: 'avoid',
    referencePrefix: 'ambient-later-conflict',
  });
  const blocked = api.resolveActiveMemoryRules(store, { profileId: 'alpha', domain: 'search', scope: 'search', asOf: NOW });
  assert.deepEqual(blocked.rules, []);
  assert.equal(blocked.excluded.some(item => item.proposalId === proposal.id && item.reason === 'conflict_present'), true);
  observations.correctMemoryObservation(store, {
    profileId: 'alpha',
    observationId: laterConflict.id,
    replacement: {
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' }],
      publicExplanation: '',
      privateNote: '',
    },
    reason: 'Correct later ambient polarity.',
    referenceId: 'ambient-later-conflict-correction',
    actor: 'user',
    source: 'cli',
    occurredAt: '2026-07-24T14:00:00.000Z',
  });
  const restored = api.resolveActiveMemoryRules(store, { profileId: 'alpha', domain: 'search', scope: 'search', asOf: NOW });
  assert.deepEqual(restored.rules.map(item => item.id), [proposal.id]);
  store.db.close();
});

test('W08-GATE-03 stale evidence cannot create or reactivate guidance', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { count: 1, startDay: 1, referencePrefix: 'stale' });
  const stale = searchProposal(evidence, { referenceId: 'proposal-stale', createdAt: '2027-02-01T12:00:00.000Z' });
  assert.throws(() => api.createMemoryProposal(store, stale), error => error.code === 'memory_evidence_stale');
  store.db.close();
});

test('W08-GATE-03 artifact evidence remains fresh for 365 days while job evidence expires at 180', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const [source] = await seedArtifactObservations(store, {
    scope: 'resume',
    count: 1,
    referencePrefix: 'fresh-artifact',
    occurredDates: ['2026-01-10'],
  });
  const firstLine = source.artifact.content.split(/\r?\n/)[0];
  const proposal = api.createMemoryProposal(store, writingProposal('resume', [source], 'proposal-fresh-artifact', {
    ruleType: 'approved_exemplar',
    value: {
      artifactId: source.artifact.id,
      revision: 1,
      contentHash: source.artifact.content_hash,
      startLine: 1,
      endLine: 1,
      excerptHash: sha256(firstLine),
    },
    rationale: 'Explicit human-selected style exemplar.',
  }));
  assert.equal(proposal.evidenceFreshUntil, '2027-01-10T10:00:00.000Z');
  store.db.close();
});

test('W08-GATE-04 protected and sensitive proposal targets or rationale reject before writes', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { referencePrefix: 'protected' });
  const before = countRows(store);
  assert.throws(() => api.createMemoryProposal(store, searchProposal(evidence, {
    referenceId: 'proposal-protected',
    value: { polarity: 'prefer', value: 'women product managers', match: 'token' },
    rationale: 'Prefer candidates based on gender.',
  })), error => error.code === 'memory_protected_target');
  assert.deepEqual(countRows(store), before);
  store.db.close();
});

test('W08-GATE-04 unknown or agent-attested native observations have weight zero and reject before proposal writes', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const [source] = await seedSearchObservations(store, { count: 1, referencePrefix: 'ineligible-actor-source' });
  const sourceRow = one(store, 'SELECT * FROM career_memory_observations WHERE id=?', [source.id]);
  const ineligible = guardedWrite(store, () => cloneRow(store, 'career_memory_observations', sourceRow, {
    id: 'memory_observation_ineligible_actor',
    actor: 'system',
    reference_id: 'ineligible-actor-observation',
    observation_hash: sha256('ineligible-actor-observation'),
  }));
  const before = countRows(store);
  assert.throws(() => api.createMemoryProposal(store, searchProposal([{ id: ineligible.id }], {
    referenceId: 'proposal-ineligible-actor',
  })), error => error.code === 'memory_evidence_ineligible');
  assert.deepEqual(countRows(store), before);
  store.db.close();
});

test('W08-GATE-05 cross-profile evidence rejects with zero proposal deltas', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const alpha = await seedSearchObservations(store, { count: 2, referencePrefix: 'cross-alpha' });
  const beta = await seedSearchObservations(store, { count: 1, profileId: 'beta', referencePrefix: 'cross-beta' });
  const before = countRows(store);
  assert.throws(() => api.createMemoryProposal(store, searchProposal([...alpha, ...beta], { referenceId: 'proposal-cross-profile' })), error => error.code === 'memory_evidence_profile_mismatch');
  assert.deepEqual(countRows(store), before);
  store.db.close();
});

test('W08-GATE-06 outcome-only evidence requires explicit non-causal wording and cannot bypass thresholds', async t => {
  const api = await proposalApi();
  const observations = await observationApi();
  const store = await openStore({ workspace: workspace(t) });
  const upstream = observations.listMemoryObservations(store, { profileId: 'alpha', sinceDays: null, includeHistory: false, nowDate: NOW })
    .observations.filter(item => item.source === 'w05_adapter' || item.source === 'w06_adapter').slice(0, 3)
    .map(item => ({ ...item, observationSchema: item.source === 'w05_adapter' ? 'jobos.outreach-outcome.v1' : 'jobos.lifecycle-observation.v1' }));
  const proposal = api.createMemoryProposal(store, searchProposal(upstream, {
    referenceId: 'proposal-outcomes',
    rationale: 'Observed association, not cause.',
  }));
  assert.equal(proposal.evidence.every(item => item.weight === 1), true);
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-outcomes')), error => ['memory_evidence_insufficient', 'memory_evidence_roots_insufficient'].includes(error.code));
  store.db.close();
});

test('W08-GATE-07 retired positioning proof deactivates an accepted rule without deleting history', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const proof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' LIMIT 1");
  const value = { theme: 'product leadership', proofPointIds: [proof.id] };
  const evidence = await seedArtifactObservations(store, { scope: 'resume', referencePrefix: 'positioning', ruleType: 'positioning_priority', value });
  const proposal = api.createMemoryProposal(store, writingProposal('resume', evidence, 'proposal-positioning', {
    ruleType: 'positioning_priority',
    value,
  }));
  api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-positioning'));
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', scope: 'resume', asOf: NOW }).rules.map(item => item.id), [proposal.id]);
  run(store, "UPDATE proof_points SET status='retired',retired_at=?,retirement_reason=? WHERE id=?", [NOW.toISOString(), 'No longer active.', proof.id]);
  const resolved = api.resolveActiveMemoryRules(store, { profileId: 'alpha', scope: 'resume', asOf: NOW });
  assert.deepEqual(resolved.rules, []);
  assert.equal(resolved.excluded.some(item => item.proposalId === proposal.id && item.reason === 'proof_ineligible'), true);
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id }).status, 'accepted');
  store.db.close();
});

test('W08-TRANSITION-01 trusted acceptance is append-only, idempotent, scoped, and active', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const { api, proposal } = await createEligibleSearch(store, 'accept');
  const args = transitionArgs(proposal.id, 'accept', 'accept-reference');
  const accepted = api.transitionMemoryProposal(store, args);
  assert.equal(accepted.schema, 'jobos.career-memory-transition.v1');
  assert.equal(accepted.toStatus, 'accepted');
  const after = countRows(store);
  const replay = api.transitionMemoryProposal(store, args);
  assert.equal(replay.id, accepted.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(countRows(store), after);
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', domain: 'search', scope: 'search', asOf: NOW }).rules.map(item => item.id), [proposal.id]);
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'beta', asOf: NOW }).rules, []);
  store.db.close();
});

test('W08-TRANSITION-01 omitted server time does not break exact transition replay', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const { api, proposal } = await createEligibleSearch(store, 'accept-server-time');
  const { nowDate: _nowDate, ...args } = transitionArgs(proposal.id, 'accept', 'accept-server-time');
  const accepted = api.transitionMemoryProposal(store, args);
  const after = countRows(store);
  await new Promise(resolve => setTimeout(resolve, 5));
  const replay = api.transitionMemoryProposal(store, args);
  assert.equal(replay.id, accepted.id);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(countRows(store), after);
  store.db.close();
});

test('W08-TRANSITION-02 rejection requires reason and exact undo restores proposed append-only', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const { api, proposal } = await createEligibleSearch(store, 'reject');
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'reject', 'reject-no-reason', { reason: '' })), error => error.code === 'memory_transition_reason_required');
  const rejected = api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'reject', 'reject-reference'));
  const undone = api.undoMemoryTransition(store, {
    profileId: 'alpha',
    transitionId: rejected.id,
    reason: 'Reconsider proposal.',
    referenceId: 'undo-rejection',
    actor: 'user',
    source: 'tui',
    nowDate: NOW,
  });
  assert.equal(undone.toStatus, 'proposed');
  assert.deepEqual(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id }).transitions.map(item => item.toStatus), ['proposed', 'rejected', 'proposed']);
  store.db.close();
});

test('W08-TRANSITION-03 same-scope acceptance supersedes only the active matching conflict tuple', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { referencePrefix: 'supersede' });
  const first = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'proposal-first', rationale: 'First repeated preference.' }));
  api.transitionMemoryProposal(store, transitionArgs(first.id, 'accept', 'accept-first'));
  const second = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'proposal-second', rationale: 'Refined repeated preference.', createdAt: '2026-07-24T13:00:00.000Z' }));
  api.transitionMemoryProposal(store, transitionArgs(second.id, 'accept', 'accept-second'));
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: first.id }).status, 'superseded');
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: second.id }).status, 'accepted');
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', scope: 'search', asOf: NOW }).rules.map(item => item.id), [second.id]);
  store.db.close();
});

test('W08-TRANSITION-04 revoke removes effect and undo revalidates then restores until TTL expiry', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const { api, proposal } = await createEligibleSearch(store, 'revoke');
  api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-revoke'));
  const revoked = api.transitionMemoryProposal(store, transitionArgs(proposal.id, 'revoke', 'revoke-reference'));
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', asOf: NOW }).rules, []);
  api.undoMemoryTransition(store, {
    profileId: 'alpha', transitionId: revoked.id, reason: 'Restore reviewed preference.', referenceId: 'undo-revoke', actor: 'user', source: 'cli', nowDate: NOW,
  });
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', asOf: NOW }).rules.map(item => item.id), [proposal.id]);
  assert.deepEqual(api.resolveActiveMemoryRules(store, { profileId: 'alpha', asOf: new Date('2027-02-01T12:00:00.000Z') }).rules, []);
  store.db.close();
});

test('W08-TRANSITION-05 undo supersession atomically restores predecessor and rejects stale reuse', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const evidence = await seedSearchObservations(store, { referencePrefix: 'undo-super' });
  const first = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'undo-super-first' }));
  api.transitionMemoryProposal(store, transitionArgs(first.id, 'accept', 'undo-super-accept-first'));
  const second = api.createMemoryProposal(store, searchProposal(evidence, { referenceId: 'undo-super-second', rationale: 'Replacement.', createdAt: '2026-07-24T13:00:00.000Z' }));
  api.transitionMemoryProposal(store, transitionArgs(second.id, 'accept', 'undo-super-accept-second'));
  const superseded = api.getMemoryProposal(store, { profileId: 'alpha', proposalId: first.id }).transitions.at(-1);
  api.undoMemoryTransition(store, {
    profileId: 'alpha', transitionId: superseded.id, reason: 'Restore predecessor.', referenceId: 'undo-supersession', actor: 'user', source: 'cli', nowDate: NOW,
  });
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: first.id }).status, 'accepted');
  assert.equal(api.getMemoryProposal(store, { profileId: 'alpha', proposalId: second.id }).status, 'revoked');
  assert.throws(() => api.undoMemoryTransition(store, {
    profileId: 'alpha', transitionId: superseded.id, reason: 'Stale retry different reference.', referenceId: 'undo-supersession-stale', actor: 'user', source: 'cli', nowDate: NOW,
  }), error => error.code === 'memory_transition_not_current');
  store.db.close();
});

test('W08-TRANSITION-06 global promotion needs two scopes, preserves scoped rules, enforces trust, and detects active invariant violations', async t => {
  const api = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const resumeEvidence = await seedArtifactObservations(store, { scope: 'resume', referencePrefix: 'global-resume' });
  const coverEvidence = await seedArtifactObservations(store, { scope: 'cover_letter', referencePrefix: 'global-cover' });
  const resume = api.createMemoryProposal(store, writingProposal('resume', resumeEvidence, 'proposal-global-resume'));
  const cover = api.createMemoryProposal(store, writingProposal('cover_letter', coverEvidence, 'proposal-global-cover'));
  api.transitionMemoryProposal(store, transitionArgs(resume.id, 'accept', 'accept-global-resume'));
  const global = api.createMemoryProposal(store, writingProposal('writing_global', resumeEvidence, 'proposal-global'));
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(global.id, 'accept', 'accept-global-early')), error => error.code === 'memory_global_promotion_insufficient');
  api.transitionMemoryProposal(store, transitionArgs(cover.id, 'accept', 'accept-global-cover'));
  assert.throws(() => api.transitionMemoryProposal(store, transitionArgs(global.id, 'accept', 'accept-global-agent', { actor: 'mcp', source: 'mcp' })), error => error.code === 'memory_transition_source_untrusted');
  api.transitionMemoryProposal(store, transitionArgs(global.id, 'accept', 'accept-global'));
  const active = api.resolveActiveMemoryRules(store, { profileId: 'alpha', domain: 'writing', asOf: NOW });
  assert.deepEqual(new Set(active.rules.map(item => item.scope)), new Set(['resume', 'cover_letter', 'writing_global']));
  const duplicate = api.createMemoryProposal(store, writingProposal('resume', resumeEvidence, 'proposal-global-resume-duplicate', {
    rationale: 'Duplicate current guidance injected to exercise fail-closed resolution.',
    createdAt: '2026-07-24T14:00:00.000Z',
  }));
  run(store, `INSERT INTO career_memory_proposal_transitions
    (id,proposal_id,profile_id,sequence,from_status,to_status,reason,reference_id,replacement_proposal_id,undoes_transition_id,actor,source,occurred_at,transition_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'memory_transition_invariant', duplicate.id, 'alpha', 2, 'proposed', 'accepted', '', 'forced-invariant', null, null, 'user', 'cli', NOW.toISOString(), sha256('forced'),
  ]);
  const invariant = api.resolveActiveMemoryRules(store, { profileId: 'alpha', domain: 'writing', asOf: NOW });
  assert.deepEqual(invariant.invariantViolations, [{
    profileId: 'alpha',
    scope: 'resume',
    conflictKey: resume.conflictKey,
    proposalIds: [duplicate.id, resume.id].sort(),
  }]);
  assert.deepEqual(new Set(invariant.rules.map(item => item.scope)), new Set(['cover_letter', 'writing_global']));
  store.db.close();
});
