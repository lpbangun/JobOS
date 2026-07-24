import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, guardedWrite, one, openStore, recordAudit, run } from '../src/db.js';
import { updateJobStatus } from '../src/jobs.js';
import { retireProof } from '../src/profiles.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const NOW = new Date('2026-07-25T12:00:00.000Z');
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const OBSERVATION_SCHEMA = 'jobos.career-memory-observation.v1';
const PROPOSAL_INPUT_SCHEMA = 'jobos.memory-proposal-input.v1';
const BRIEF_KEYS = [
  'schema', 'version', 'profileId', 'revision', 'asOf', 'sourceStateHash',
  'identity', 'canonicalTargets', 'searchStrategy', 'proofInventory',
  'activeGuidance', 'recentContext', 'citations', 'policy',
];
const VOICE_KEYS = [
  'schema', 'version', 'profileId', 'revision', 'asOf', 'sourceStateHash',
  'baseline', 'global', 'artifactTypes', 'positioningHierarchy',
  'approvedExemplars', 'activeRuleIds', 'citations', 'policy',
];
const ARTIFACT_TYPES = ['resume', 'cover_letter', 'outreach', 'interview_prep'];

async function projectionApi() {
  return import('../src/career-memory-projections.js');
}

async function proposalApi() {
  return import('../src/career-memory-proposals.js');
}

async function observationApi() {
  return import('../src/career-memory-observations.js');
}

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-phase4a-'));
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

function countProjectionState(store) {
  return {
    revisions: one(store, 'SELECT COUNT(*) AS count FROM career_memory_projection_revisions').count,
    sources: one(store, 'SELECT COUNT(*) AS count FROM career_memory_projection_sources').count,
    audits: one(store, 'SELECT COUNT(*) AS count FROM audit_log').count,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function seedSearchObservations(store, {
  count = 3,
  profileId = 'alpha',
  polarity = 'prefer',
  referencePrefix = 'phase4-search',
  privateNote = '',
} = {}) {
  const observations = await observationApi();
  const base = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND status=? ORDER BY id LIMIT 1', [profileId, 'saved']);
  const output = [];
  for (let index = 0; index < count; index += 1) {
    let job = base;
    if (index > 0) {
      const jobId = `job_phase4_${profileId}_${referencePrefix}_${index}`.replace(/[^a-zA-Z0-9_]/g, '_');
      job = guardedWrite(store, () => cloneRow(store, 'jobs', base, {
        id: jobId,
        url: `jobos:test:${jobId}`,
        status: 'new',
        created_at: `2026-07-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
        updated_at: `2026-07-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
      }));
      updateJobStatus(store, job.id, 'saved');
    }
    output.push(observations.recordJobFeedback(store, {
      profileId,
      jobId: job.id,
      input: {
        schema: 'jobos.job-feedback-input.v1',
        decision: 'save',
        reasonCodes: ['role_fit'],
        signals: [{ field: 'role_family', polarity, value: job.title, match: 'exact' }],
        publicExplanation: '',
        privateNote: index === 0 ? privateNote : '',
        referenceId: `${referencePrefix}-${index}`,
        occurredAt: `2026-07-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`,
      },
      actor: 'user',
      source: 'cli',
    }));
  }
  return output;
}

function searchProposalInput(evidence, referenceId) {
  return {
    schema: PROPOSAL_INPUT_SCHEMA,
    domain: 'search',
    scope: 'search',
    ruleType: 'role_family',
    value: { polarity: 'prefer', value: 'product manager', match: 'exact' },
    rationale: 'Repeated direct job feedback supports this visible preference.',
    evidence: evidence.map(item => ({ observationSchema: OBSERVATION_SCHEMA, observationId: item.id, polarity: 'support' })),
    referenceId,
    createdAt: CREATED_AT,
  };
}

function transitionArgs(proposalId, action, referenceId) {
  return {
    profileId: 'alpha', proposalId, action,
    reason: action === 'accept' ? '' : `${action} projection fixture`,
    referenceId, actor: 'user', source: 'cli', nowDate: NOW,
  };
}

async function acceptSearchRule(store, suffix = 'brief') {
  const proposals = await proposalApi();
  const evidence = await seedSearchObservations(store, { referencePrefix: `accepted-search-${suffix}` });
  const proposal = proposals.createMemoryProposal(store, searchProposalInput(evidence, `proposal-search-${suffix}`));
  proposals.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', `accept-search-${suffix}`));
  return { proposals, evidence, proposal };
}

async function seedArtifactObservations(store, {
  scope,
  ruleType = 'tone',
  value = { value: 'concise' },
  count = 3,
  referencePrefix,
} = {}) {
  const observations = await observationApi();
  const base = one(store, "SELECT * FROM artifacts WHERE profile_id='alpha' AND approval_status='approved' ORDER BY id LIMIT 1");
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const artifactId = `artifact_phase4_${scope}_${referencePrefix}_${index}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const content = `# ${scope} ${referencePrefix} ${index}\nConcise canonical sample ${index}.\n`;
    const seeded = guardedWrite(store, () => {
      const artifact = cloneRow(store, 'artifacts', base, {
        id: artifactId,
        job_id: null,
        type: scope,
        path: `phase4/${artifactId}.md`,
        title: `${scope} ${referencePrefix} ${index}`,
        content,
        series_key: `${scope}:phase4:${referencePrefix}:${index}`,
        revision: 1,
        supersedes_artifact_id: null,
        content_hash: sha256(content),
        approval_status: 'approved',
        created_at: `2026-07-${String(10 + index).padStart(2, '0')}T09:00:00.000Z`,
        reviewed_at: `2026-07-${String(10 + index).padStart(2, '0')}T09:30:00.000Z`,
        reviewed_by: 'cli',
        review_note: 'PRIVATE_ARTIFACT_REVIEW',
      });
      const auditEvent = recordAudit(store, 'artifact.approved', 'artifact', artifact.id, { artifactId: artifact.id, profileId: 'alpha' });
      const observation = observations.appendMemoryObservation(store, {
        profileId: 'alpha',
        eventType: 'artifact_approved',
        sourceSchema: 'jobos.artifact-feedback-input.v1',
        sourceEntity: {
          type: 'artifact', id: artifact.id, versionId: auditEvent.id,
          revision: 1, contentHash: artifact.content_hash,
        },
        occurredAt: `2026-07-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`,
        actor: 'user', source: 'cli', reasonCodes: [ruleType === 'tone' ? 'tone' : 'positioning'],
        signals: [{ ruleType, value }], publicExplanation: '', privateNote: '',
        payload: { decision: 'approve' }, referenceId: `${referencePrefix}-${index}`,
      });
      return { artifact, observation };
    });
    const mirror = path.join(store.p.ws, seeded.artifact.path);
    mkdirSync(path.dirname(mirror), { recursive: true });
    writeFileSync(mirror, seeded.artifact.content);
    output.push(seeded);
  }
  return output;
}

function writingProposalInput(scope, ruleType, value, seeded, referenceId) {
  return {
    schema: PROPOSAL_INPUT_SCHEMA,
    domain: 'writing', scope, ruleType, value,
    rationale: 'Repeated direct artifact feedback supports this visible writing guidance.',
    evidence: seeded.map(item => ({ observationSchema: OBSERVATION_SCHEMA, observationId: item.observation.id, polarity: 'support' })),
    referenceId, createdAt: CREATED_AT,
  };
}

async function acceptWritingRule(store, {
  scope,
  ruleType = 'tone',
  value = { value: 'concise' },
  count = 3,
  suffix,
} = {}) {
  const proposals = await proposalApi();
  const seeded = await seedArtifactObservations(store, { scope, ruleType, value, count, referencePrefix: suffix });
  const proposal = proposals.createMemoryProposal(store, writingProposalInput(scope, ruleType, value, seeded, `proposal-${suffix}`));
  proposals.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', `accept-${suffix}`));
  return { proposals, seeded, proposal };
}

async function acceptGlobalTone(store, suffix = 'global') {
  await acceptWritingRule(store, { scope: 'cover_letter', suffix: `${suffix}-cover` });
  await acceptWritingRule(store, { scope: 'outreach', suffix: `${suffix}-outreach` });
  return acceptWritingRule(store, { scope: 'writing_global', suffix: `${suffix}-rule` });
}

function addProjectionFixtures(store) {
  return guardedWrite(store, () => {
    const profile = one(store, "SELECT * FROM profiles WHERE id='alpha'");
    const preferences = JSON.parse(profile.preferences_json);
    preferences.targetRoleFamilies = ['Product Management'];
    preferences.locations = ['Remote'];
    preferences.communicationStyle = 'concise, warm, evidence-grounded';
    preferences.searchStrategy = 'focused';
    preferences.automationPolicy = { apiKey: 'TOP_SECRET_API_KEY', cookie: 'TOP_SECRET_COOKIE' };
    run(store, 'UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [JSON.stringify(preferences), '2026-07-24T11:00:00.000Z', 'alpha']);
    run(store, `INSERT INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`, [
      'search_phase4_safe', 'Reviewed Product Search', 'alpha', 'local',
      JSON.stringify({ query: 'product', apiKey: 'TOP_SECRET_SEARCH_CONFIG' }), 78,
      '2026-07-24T11:00:00.000Z', '2026-07-24T11:00:00.000Z',
    ]);
  });
}

function mirrorPath(store, profileId, file) {
  return path.join(store.p.profiles, profileId, 'memory', file);
}

test('W08-BRIEF-01 pure brief is exact, deterministic, bounded, cited, and fact-safe', async t => {
  const api = await projectionApi();
  const store = await openStore({ workspace: workspace(t) });
  addProjectionFixtures(store);
  const active = await acceptSearchRule(store, 'brief-pure');
  await seedSearchObservations(store, { count: 13, referencePrefix: 'brief-recent', privateNote: 'TOP_SECRET_PRIVATE_NOTE' });
  const baseProof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  for (let index = 0; index < 26; index += 1) {
    cloneRow(store, 'proof_points', baseProof, {
      id: `proof_phase4_${String(index).padStart(2, '0')}`,
      summary: `Canonical proof summary ${index}`,
      evidence: `TOP_SECRET_EVIDENCE_${index}`,
      updated_at: `2026-07-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`,
      created_at: `2026-06-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`,
    });
  }
  const before = countProjectionState(store);
  const first = api.buildCareerBrief(store, { profileId: 'alpha', asOf: NOW });
  const second = api.buildCareerBrief(store, { profileId: 'alpha', asOf: NOW });
  assert.deepEqual(Object.keys(first), BRIEF_KEYS);
  assert.deepEqual(second, first);
  assert.deepEqual(countProjectionState(store), before);
  assert.equal(first.schema, 'jobos.career-brief.v1');
  assert.equal(first.revision, null);
  assert.equal(first.asOf, NOW.toISOString());
  assert.match(first.sourceStateHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.identity, { profileId: 'alpha', name: 'Alpha' });
  assert.deepEqual(first.canonicalTargets.targetRoleFamilies, ['Product Management']);
  assert.equal(first.searchStrategy.savedSearches[0].configHash.length, 64);
  assert.equal(Object.hasOwn(first.searchStrategy.savedSearches[0], 'config'), false);
  assert.equal(first.proofInventory.length, 24);
  assert.equal(first.activeGuidance.length, 1);
  assert.equal(first.activeGuidance[0].ruleId, active.proposal.id);
  assert.equal(first.recentContext.length, 12);
  assert.equal(first.citations.every(item => Object.keys(item).join(',') === 'sourceKind,sourceId,sourceVersionId,sourceHash'), true);
  assert.deepEqual(first.policy, {
    canonicalStore: 'sqlite', facts: 'canonical_sources_only', guidance: 'accepted_active_only',
    causalAttribution: false, externalSideEffects: 'none', modelFineTuning: false,
  });
  const serialized = JSON.stringify(first);
  for (const forbidden of ['TOP_SECRET', 'PRIVATE_ARTIFACT_REVIEW', 'Invented Employer']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(existsSync(mirrorPath(store, 'alpha', 'career-brief.yaml')), false);
  store.db.close();
});

test('W08-BRIEF-02 refresh is atomic, append-only, idempotent, mirrored, and historical', async t => {
  const api = await projectionApi();
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  addProjectionFixtures(store);
  const before = countProjectionState(store);
  const first = api.refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: NOW, actor: 'user', source: 'cli',
  });
  assert.equal(first.revision, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_projection_revisions').count, 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_projection_sources').count, first.citations.length);
  assert.equal(countProjectionState(store).audits, before.audits + 1);
  const yamlFile = mirrorPath(store, 'alpha', 'career-brief.yaml');
  const markdownFile = mirrorPath(store, 'alpha', 'career-brief.md');
  const yamlBefore = readFileSync(yamlFile, 'utf8');
  const markdownBefore = readFileSync(markdownFile, 'utf8');
  assert.doesNotMatch(yamlBefore, /(^|\n)\s*[&*][A-Za-z0-9_-]+/);
  const afterFirst = countProjectionState(store);
  const replay = api.refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: NOW, actor: 'user', source: 'cli',
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(countProjectionState(store), afterFirst);
  assert.equal(readFileSync(yamlFile, 'utf8'), yamlBefore);
  assert.equal(readFileSync(markdownFile, 'utf8'), markdownBefore);

  guardedWrite(store, () => {
    const profile = one(store, "SELECT * FROM profiles WHERE id='alpha'");
    const preferences = JSON.parse(profile.preferences_json);
    preferences.locations = ['Remote', 'Boston'];
    run(store, 'UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [JSON.stringify(preferences), '2026-07-25T11:00:00.000Z', 'alpha']);
  });
  const changed = api.refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'career_brief', asOf: NOW, actor: 'user', source: 'cli',
  });
  assert.equal(changed.revision, 2);
  assert.notEqual(changed.sourceStateHash, first.sourceStateHash);
  assert.deepEqual(api.getCareerBrief(store, { profileId: 'alpha', revision: 1 }), first);
  assert.deepEqual(JSON.parse(one(store, `SELECT document_json FROM career_memory_projection_revisions
    WHERE profile_id='alpha' AND projection_type='career_brief' AND revision=1`).document_json), first);
  store.db.close();
  const reopened = await openStore({ workspace: root });
  assert.deepEqual(api.getCareerBrief(reopened, { profileId: 'alpha', revision: 1 }), first);
  assert.deepEqual(api.getCareerBrief(reopened, { profileId: 'alpha', revision: 2 }), changed);
  assert.equal(readFileSync(mirrorPath(reopened, 'alpha', 'career-brief.yaml'), 'utf8'), readFileSync(yamlFile, 'utf8'));
  reopened.db.close();
});

test('W08-BRIEF-03 current get is write-free, profile-safe, and immediately reflects revocation', async t => {
  const api = await projectionApi();
  const store = await openStore({ workspace: workspace(t) });
  const { proposals, proposal } = await acceptSearchRule(store, 'brief-revoke');
  const before = countProjectionState(store);
  const active = api.getCareerBrief(store, { profileId: 'alpha', asOf: NOW, refresh: false });
  assert.deepEqual(active.activeGuidance.map(item => item.ruleId), [proposal.id]);
  assert.deepEqual(countProjectionState(store), before);
  proposals.transitionMemoryProposal(store, transitionArgs(proposal.id, 'revoke', 'revoke-brief-rule'));
  const revoked = api.getCareerBrief(store, { profileId: 'alpha', asOf: NOW, refresh: false });
  assert.deepEqual(revoked.activeGuidance, []);
  assert.notEqual(revoked.sourceStateHash, active.sourceStateHash);
  assert.deepEqual(countProjectionState(store), {
    ...before,
    audits: countProjectionState(store).audits,
  });
  assert.equal(api.getCareerBrief(store, { profileId: 'beta', asOf: NOW }).profileId, 'beta');
  assert.throws(() => api.getCareerBrief(store, { profileId: 'missing', asOf: NOW }), error => error.code === 'memory_projection_profile_unknown');
  store.db.close();
});

test('W08-VOICE-01 guide applies separate active global rules and scoped overrides deterministically', async t => {
  const api = await projectionApi();
  const store = await openStore({ workspace: workspace(t) });
  const global = await acceptGlobalTone(store, 'voice-global');
  const scoped = await acceptWritingRule(store, { scope: 'resume', value: { value: 'warm' }, suffix: 'voice-resume-warm' });
  const before = countProjectionState(store);
  const guide = api.buildVoicePositioningGuide(store, { profileId: 'alpha', asOf: NOW });
  assert.deepEqual(Object.keys(guide), VOICE_KEYS);
  assert.deepEqual(Object.keys(guide.artifactTypes), ARTIFACT_TYPES);
  assert.equal(guide.schema, 'jobos.voice-positioning-guide.v1');
  assert.equal(guide.global.tone.value, 'concise');
  assert.deepEqual(guide.global.tone.ruleIds, [global.proposal.id]);
  assert.equal(guide.artifactTypes.resume.tone.value, 'warm');
  assert.deepEqual(guide.artifactTypes.resume.tone.ruleIds, [scoped.proposal.id]);
  assert.equal(guide.artifactTypes.interview_prep.tone.value, 'concise');
  assert.deepEqual(guide.artifactTypes.interview_prep.tone.ruleIds, [global.proposal.id]);
  assert.deepEqual(guide.artifactTypes.resume.scopedRuleIds, [scoped.proposal.id]);
  assert.deepEqual(guide.artifactTypes.interview_prep.scopedRuleIds, []);
  assert.deepEqual(guide.policy, {
    selectionAndFramingOnly: true,
    proofsAreFactAuthority: true,
    copyExemplarVerbatim: false,
    externalSideEffects: 'none',
  });
  assert.equal(guide.activeRuleIds.includes(global.proposal.id), true);
  assert.deepEqual(countProjectionState(store), before);
  store.db.close();
});

test('W08-VOICE-02 positioning hierarchy is accepted-rule ordered and proof eligibility is live', async t => {
  const api = await projectionApi();
  const store = await openStore({ workspace: workspace(t) });
  const proof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  const accepted = await acceptWritingRule(store, {
    scope: 'resume', ruleType: 'positioning_priority',
    value: { theme: 'customer research', proofPointIds: [proof.id] }, suffix: 'voice-positioning',
  });
  const before = api.buildVoicePositioningGuide(store, { profileId: 'alpha', asOf: NOW });
  assert.equal(before.positioningHierarchy[0].ruleId, accepted.proposal.id);
  assert.deepEqual(before.positioningHierarchy[0].proofPointIds, [proof.id]);
  retireProof(store, proof.id, 'Projection eligibility regression.');
  const after = api.buildVoicePositioningGuide(store, { profileId: 'alpha', asOf: NOW });
  assert.equal(after.activeRuleIds.includes(accepted.proposal.id), false);
  assert.equal(JSON.stringify(after.positioningHierarchy).includes(proof.id), false);
  assert.notEqual(after.sourceStateHash, before.sourceStateHash);
  store.db.close();
});

test('W08-VOICE-03 approved exemplar resolves exact canonical range and disappears when artifact becomes ineligible', async t => {
  const api = await projectionApi();
  const proposals = await proposalApi();
  const store = await openStore({ workspace: workspace(t) });
  const [seeded] = await seedArtifactObservations(store, { scope: 'resume', count: 1, referencePrefix: 'voice-exemplar' });
  const lines = seeded.artifact.content.split(/\r?\n/);
  const snippet = lines.slice(0, 2).join('\n');
  const value = {
    artifactId: seeded.artifact.id, revision: 1, contentHash: seeded.artifact.content_hash,
    startLine: 1, endLine: 2, excerptHash: sha256(snippet),
  };
  const proposal = proposals.createMemoryProposal(store, writingProposalInput('resume', 'approved_exemplar', value, [seeded], 'proposal-voice-exemplar'));
  proposals.transitionMemoryProposal(store, transitionArgs(proposal.id, 'accept', 'accept-voice-exemplar'));
  const guide = api.buildVoicePositioningGuide(store, { profileId: 'alpha', asOf: NOW, artifactType: 'resume' });
  assert.equal(guide.approvedExemplars.length, 1);
  assert.deepEqual(guide.approvedExemplars[0], {
    ruleId: proposal.id, artifactType: 'resume', artifactId: seeded.artifact.id, revision: 1,
    contentHash: seeded.artifact.content_hash, startLine: 1, endLine: 2,
    excerptHash: sha256(snippet), snippet,
  });
  assert.equal(guide.policy.copyExemplarVerbatim, false);
  guardedWrite(store, () => run(store, `UPDATE artifacts
    SET approval_status='rejected',reviewed_at=?,reviewed_by='cli',review_note=?
    WHERE id=?`, ['2026-07-25T11:00:00.000Z', 'No longer canonical.', seeded.artifact.id]));
  const after = api.buildVoicePositioningGuide(store, { profileId: 'alpha', asOf: NOW, artifactType: 'resume' });
  assert.deepEqual(after.approvedExemplars, []);
  assert.equal(after.activeRuleIds.includes(proposal.id), false);
  store.db.close();
});

test('W08-VOICE-04 conflicts fail closed and refresh/get/mirrors remain deterministic and profile-safe', async t => {
  const api = await projectionApi();
  const store = await openStore({ workspace: workspace(t) });
  const warm = await acceptWritingRule(store, { scope: 'resume', value: { value: 'warm' }, suffix: 'voice-conflict-warm' });
  const direct = await acceptWritingRule(store, { scope: 'resume', value: { value: 'direct' }, suffix: 'voice-conflict-direct' });
  const conflicted = api.buildVoicePositioningGuide(store, { profileId: 'alpha', artifactType: 'resume', asOf: NOW });
  assert.equal(conflicted.artifactTypes.resume.tone, null);
  assert.deepEqual(conflicted.artifactTypes.resume.warnings, [{
    field: 'tone', reason: 'conflicting_active_rules', ruleIds: [direct.proposal.id, warm.proposal.id].sort(),
  }]);
  const first = api.refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'voice_positioning_guide', asOf: NOW, actor: 'user', source: 'cli',
  });
  const state = countProjectionState(store);
  const replay = api.refreshMemoryProjection(store, {
    profileId: 'alpha', projectionType: 'voice_positioning_guide', asOf: NOW, actor: 'user', source: 'cli',
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(countProjectionState(store), state);
  assert.deepEqual(api.getVoicePositioningGuide(store, { profileId: 'alpha', revision: 1 }), first);
  const view = api.getVoicePositioningGuide(store, { profileId: 'alpha', revision: 1, artifactType: 'resume' });
  assert.deepEqual(Object.keys(view.artifactTypes), ['resume']);
  const yaml = readFileSync(mirrorPath(store, 'alpha', 'voice-positioning-guide.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /(^|\n)\s*[&*][A-Za-z0-9_-]+/);
  assert.equal(yaml.includes('PRIVATE_ARTIFACT_REVIEW'), false);
  assert.equal(api.getVoicePositioningGuide(store, { profileId: 'beta', asOf: NOW }).profileId, 'beta');
  assert.throws(
    () => api.getVoicePositioningGuide(store, { profileId: 'beta', revision: 1 }),
    error => error.code === 'memory_projection_revision_unknown',
  );
  store.db.close();
});
