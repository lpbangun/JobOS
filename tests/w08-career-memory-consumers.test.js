import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';

import { guardedWrite, one, openStore, recordAudit, run } from '../src/db.js';
import { score } from '../src/scoring.js';
import { runDaily } from '../src/workflows.js';
import { tailor } from '../src/tailoring.js';
import { tailorResume } from '../src/resume-tailoring.js';
import { draftOutreach } from '../src/outreach.js';
import { prepInterview } from '../src/interview.js';
import { appendMemoryObservation, recordJobFeedback } from '../src/career-memory-observations.js';
import { createMemoryProposal, transitionMemoryProposal } from '../src/career-memory-proposals.js';
import { updateJobStatus } from '../src/jobs.js';
import { preflightResumeArtifact } from '../src/artifacts.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-consumers-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const AT = new Date('2026-07-25T12:00:00.000Z');

function fakeLlm(payload) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => server.close(done)),
  })));
}

function setLlm(baseUrl) {
  const values = { JOBOS_LLM_PROVIDER: 'openai', JOBOS_LLM_MODEL: 'consumer-fixture', JOBOS_LLM_API_KEY: 'test-key', JOBOS_LLM_BASE_URL: baseUrl, JOBOS_AGENT: '' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

function cloneArtifact(store, source, changes) {
  const row = { ...source, ...changes };
  const columns = Object.keys(row);
  run(store, `INSERT INTO artifacts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
  return row;
}

function acceptWritingRule(store, { scope, ruleType, value, suffix }) {
  const source = one(store, "SELECT * FROM artifacts WHERE profile_id='alpha' AND approval_status='approved' ORDER BY id LIMIT 1");
  const evidence = [];
  for (let index = 0; index < 3; index += 1) {
    evidence.push(guardedWrite(store, () => {
      const artifact = cloneArtifact(store, source, {
        id: `artifact_consumer_${suffix}_${index}`,
        job_id: null,
        type: scope === 'writing_global' ? 'cover_letter' : scope,
        path: `consumer/${suffix}-${index}.md`,
        title: `Consumer ${suffix} ${index}`,
        content: `# Public style sample ${index}\nGrounded concise sample.\n`,
        series_key: `consumer:${suffix}:${index}`,
        revision: 1,
        supersedes_artifact_id: null,
        reviewed_at: AT.toISOString(),
        reviewed_by: 'cli',
        review_note: 'PRIVATE_REVIEW_NOTE_MUST_NOT_LEAK',
        created_at: AT.toISOString(),
      });
      const auditEvent = recordAudit(store, 'artifact.approved', 'artifact', artifact.id, { artifactId: artifact.id, profileId: 'alpha' });
      return appendMemoryObservation(store, {
        profileId: 'alpha', eventType: 'artifact_approved', sourceSchema: 'jobos.artifact-feedback-input.v1',
        sourceEntity: { type: 'artifact', id: artifact.id, versionId: auditEvent.id, revision: 1, contentHash: artifact.content_hash },
        occurredAt: `2026-07-${20 + index}T12:00:00.000Z`, actor: 'user', source: 'cli', reasonCodes: [ruleType === 'positioning_priority' ? 'positioning' : ruleType === 'avoid_claim' ? 'unsupported_claim' : ruleType === 'avoid_term' ? 'vocabulary' : ruleType],
        signals: [{ ruleType, value }], publicExplanation: '', privateNote: 'PRIVATE_NOTE_MUST_NOT_LEAK', payload: { decision: 'approve' }, referenceId: `obs-${suffix}-${index}`,
      });
    }));
  }
  const proposal = createMemoryProposal(store, {
    schema: 'jobos.memory-proposal-input.v1', domain: 'writing', scope, ruleType, value,
    rationale: 'Repeated direct feedback supports deterministic consumer guidance.',
    evidence: evidence.map(item => ({ observationSchema: 'jobos.career-memory-observation.v1', observationId: item.id, polarity: 'support' })),
    referenceId: `proposal-${suffix}`, createdAt: AT.toISOString(),
  });
  transitionMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id, action: 'accept', reason: '', referenceId: `accept-${suffix}`, actor: 'user', source: 'cli', nowDate: AT });
  return proposal;
}

function acceptSearchRule(store, job, { polarity, field, value, suffix }) {
  const observations = [];
  for (let index = 0; index < 3; index += 1) {
    const row = { ...job, id: `job_consumer_${suffix}_${index}`, url: `jobos:test:${suffix}:${index}`, description: `${job.description}\n${value}`, status: 'new', dedupe_key: `consumer-${suffix}-${index}` };
    const columns = Object.keys(row);
    guardedWrite(store, () => run(store, `INSERT INTO jobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column])));
    updateJobStatus(store, row.id, 'saved');
    observations.push(recordJobFeedback(store, {
      profileId: 'alpha', jobId: row.id,
      input: { schema: 'jobos.job-feedback-input.v1', decision: 'save', reasonCodes: ['role_fit'], signals: [{ field, polarity, value, match: 'token' }], publicExplanation: '', privateNote: 'PRIVATE_SEARCH_NOTE', referenceId: `search-obs-${suffix}-${index}`, occurredAt: `2026-07-${20 + index}T12:00:00.000Z` },
      actor: 'user', source: 'cli',
    }));
  }
  const proposal = createMemoryProposal(store, {
    schema: 'jobos.memory-proposal-input.v1', domain: 'search', scope: 'search', ruleType: field,
    value: { polarity, value, match: 'token' }, rationale: 'Repeated direct search feedback supports guidance.',
    evidence: observations.map(item => ({ observationSchema: 'jobos.career-memory-observation.v1', observationId: item.id, polarity: 'support' })),
    referenceId: `search-proposal-${suffix}`, createdAt: AT.toISOString(),
  });
  transitionMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id, action: 'accept', reason: '', referenceId: `search-accept-${suffix}`, actor: 'user', source: 'cli', nowDate: AT });
  return proposal;
}

test('W08-CONSUMERS-01 scoring returns retrieval guidance without changing persisted fit semantics', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const result = await score(store, job.id, 'alpha');
  assert.deepEqual(result.memoryGuidance, {
    schema: 'jobos.career-memory-search-guidance.v1',
    adjustment: 0,
    matchedRuleIds: [],
    citations: [],
    explanation: 'accepted guidance; fit score unchanged',
  });
});

test('W08-CONSUMERS-02 daily discovery exposes active guidance and guided score', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const seedJob = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const proposal = acceptSearchRule(store, seedJob, { polarity: 'prefer', field: 'mission', value: 'prefermarker', suffix: 'daily' });
  const preferredFixture = path.join(root, 'daily-preferred.json');
  const baselineFixture = path.join(root, 'daily-baseline.json');
  writeFileSync(preferredFixture, JSON.stringify({ jobs: [{ id: 1, title: 'Product Manager', absolute_url: 'https://example.test/preferred', location: { name: 'Remote' }, content: 'Lead product launches prefermarker.' }] }));
  writeFileSync(baselineFixture, JSON.stringify({ jobs: [{ id: 2, title: 'Product Manager', absolute_url: 'https://example.test/baseline', location: { name: 'Remote' }, content: 'Lead product launches.' }] }));
  run(store, 'INSERT INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['consumer-daily-z', 'Consumer daily Z', 'alpha', 'greenhouse', JSON.stringify({ fixture: preferredFixture, company: 'Zeta Co' }), 0, AT.toISOString(), AT.toISOString()]);
  run(store, 'INSERT INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['consumer-daily-a', 'Consumer daily A', 'alpha', 'greenhouse', JSON.stringify({ fixture: baselineFixture, company: 'Alpha Co' }), 0, AT.toISOString(), AT.toISOString()]);
  const result = await runDaily(store, { profileId: 'alpha' });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].company, 'Zeta Co');
  assert.equal(result.jobs[0].memoryGuidance.adjustment, 2);
  assert.equal(result.jobs[0].guidedScore, Math.min(100, result.jobs[0].score + 2));
  assert.equal(result.jobs[0].score, result.jobs[1].score);

  transitionMemoryProposal(store, { profileId: 'alpha', proposalId: proposal.id, action: 'revoke', reason: 'Restore baseline ordering.', referenceId: 'revoke-daily', actor: 'user', source: 'cli', nowDate: AT });
  const restored = await runDaily(store, { profileId: 'alpha' });
  assert.deepEqual(restored.jobs.map(job => job.company), ['Alpha Co', 'Zeta Co']);
  assert.ok(restored.jobs.every(job => job.memoryGuidance.adjustment === 0 && job.guidedScore === Number(job.score || 0)));
});

test('W08-CONSUMERS-02B zero-rule discovery preserves score fields and existing company order', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  for (const company of ['Zeta Co', 'Alpha Co']) {
    const fixture = path.join(root, `${company}.json`);
    writeFileSync(fixture, JSON.stringify({ jobs: [{ id: company, title: 'Product Manager', absolute_url: `https://example.test/${company}`, location: { name: 'Remote' }, content: 'Lead product launches.' }] }));
    run(store, 'INSERT INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [`zero-${company}`, company, 'alpha', 'greenhouse', JSON.stringify({ fixture, company }), 0, AT.toISOString(), AT.toISOString()]);
  }
  const result = await runDaily(store, { profileId: 'alpha' });
  assert.deepEqual(result.jobs.map(job => job.company), ['Alpha Co', 'Zeta Co']);
  assert.ok(result.jobs.every(job => job.memoryGuidance.adjustment === 0 && job.guidedScore === Number(job.score || 0)));
});

test('W08-CONSUMERS-03 cover tailoring actively renders accepted writing guidance without private notes', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const proof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'tone', value: { value: 'warm' }, suffix: 'cover-tone' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'length', value: { minWords: 120, maxWords: 300 }, suffix: 'cover-length' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'opening', value: { value: 'proof_first' }, suffix: 'cover-opening' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'closing', value: { value: 'gratitude' }, suffix: 'cover-closing' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'avoid_term', value: { terms: ['synergy'] }, suffix: 'cover-term' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'avoid_claim', value: { claimPattern: 'doubled revenue', reasonCode: 'unsupported' }, suffix: 'cover-claim' });
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'positioning_priority', value: { theme: 'delivery', proofPointIds: [proof.id] }, suffix: 'cover-proof' });
  const result = await tailor(store, job.id, 'alpha', 'cover');
  assert.match(result.content, /Career-memory tone:\*\* warm/);
  assert.match(result.content, /Career-memory template:\*\* warm_letter/);
  assert.match(result.content, /Opening variant:\*\* proof_first/);
  assert.match(result.content, /Closing variant:\*\* gratitude/);
  assert.match(result.content, /## Warm letter — why this role and evidence/);
  assert.match(result.content, new RegExp(`Dear hiring team,\\n\\n${proof.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.content, /Thank you for considering this evidence-grounded draft\.\n\n## Evidence warnings/);
  assert.ok(result.content.trim().split(/\s+/u).length >= 120);
  assert.doesNotMatch(result.content, /synergy|doubled revenue/i);
  const memoryEvidence = result.evidence.find(item => item.careerMemoryRuleIds);
  assert.ok(memoryEvidence.careerMemoryRuleIds.length >= 7);
  assert.ok(memoryEvidence.careerMemoryCitations.length > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:NOTE|REVIEW_NOTE)/);

  const provider = await fakeLlm({ requirementProofMap: [{ requirement: 'Product', proofPointId: proof.id, bullet: proof.summary }], coverLetter: 'Provider prose is not persisted.', warnings: [] });
  const restore = setLlm(provider.baseUrl);
  try {
    const llmResult = await tailor(store, job.id, 'alpha', 'cover');
    assert.match(llmResult.content, /## Warm letter — why this role and evidence/);
    assert.match(llmResult.content, new RegExp(`Dear hiring team,\\n\\n${proof.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(llmResult.content, /Thank you for considering this evidence-grounded draft\.\n\n## Evidence warnings/);
    assert.doesNotMatch(llmResult.content, /Provider prose is not persisted/);
  } finally {
    restore();
    await provider.close();
  }
});

test('W08-CONSUMERS-03B resume invalid LLM output is discarded and persisted metadata matches deterministic fallback', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const proof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  acceptWritingRule(store, { scope: 'resume', ruleType: 'tone', value: { value: 'direct' }, suffix: 'resume-tone' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'length', value: { minWords: 50, maxWords: 1000 }, suffix: 'resume-length' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'opening', value: { value: 'proof_first' }, suffix: 'resume-opening' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'closing', value: { value: 'none' }, suffix: 'resume-closing' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'avoid_term', value: { terms: ['synergy'] }, suffix: 'resume-term' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'avoid_claim', value: { claimPattern: 'invented empire', reasonCode: 'unsupported' }, suffix: 'resume-claim' });
  acceptWritingRule(store, { scope: 'resume', ruleType: 'positioning_priority', value: { theme: 'delivery', proofPointIds: [proof.id] }, suffix: 'resume-proof' });
  const provider = await fakeLlm({ summary: { text: 'Invented unsupported empire growth', proofPointIds: [proof.id] }, bullets: [], selectedSkillIds: ['invented-skill'], warnings: [] });
  const restore = setLlm(provider.baseUrl);
  try {
    const result = await tailorResume(store, { jobId: job.id, profileId: 'alpha' });
    assert.equal(result.mode, 'deterministic');
    assert.match(result.content, /Career-memory tone:\*\* direct/);
    assert.match(result.content, /Opening variant:\*\* proof_first/);
    assert.match(result.content, /Closing variant:\*\* none/);
    assert.match(result.content, /## Direct resume — evidence first/);
    assert.match(result.content, new RegExp(`Evidence-led opening: ${proof.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(result.content, /Guided closing:/);
    assert.doesNotMatch(result.content, /Invented unsupported empire growth|invented-skill/i);
    const selected = [...new Set([...(result.document.summary?.proofPointIds || []), ...result.document.experience.flatMap(entry => entry.bullets.flatMap(bullet => bullet.proofPointIds || [])), ...result.document.projects.flatMap(entry => entry.bullets.flatMap(bullet => bullet.proofPointIds || []))])];
    const persisted = one(store, 'SELECT * FROM artifact_resume_documents WHERE artifact_id=?', [result.id]);
    assert.deepEqual(JSON.parse(persisted.document_json), result.document);
    assert.deepEqual(JSON.parse(persisted.coverage_json), result.coverage);
    assert.deepEqual(JSON.parse(persisted.validation_json), result.validation);
    assert.deepEqual(result.evidence.filter(item => item.proofPointId).map(item => item.proofPointId), selected);
    assert.equal(preflightResumeArtifact(store, result.id).validation.valid, result.validation.valid);
    assert.doesNotMatch(JSON.stringify(provider.requests), /PRIVATE_(?:NOTE|REVIEW_NOTE)/);
  } finally {
    restore();
    await provider.close();
  }
});

test('W08-CONSUMERS-04 outreach and interview prep actively render tone guidance', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT jobs.* FROM jobs JOIN stakeholders ON stakeholders.job_id=jobs.id WHERE jobs.profile_id='alpha' ORDER BY jobs.id LIMIT 1");
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'tone', value: { value: 'formal' }, suffix: 'outreach-tone' });
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'length', value: { minWords: 50, maxWords: 500 }, suffix: 'outreach-length' });
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'opening', value: { value: 'direct' }, suffix: 'outreach-opening' });
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'closing', value: { value: 'call_to_action' }, suffix: 'outreach-closing' });
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'avoid_term', value: { terms: ['synergy'] }, suffix: 'outreach-term' });
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'avoid_claim', value: { claimPattern: 'guaranteed reply', reasonCode: 'unsupported' }, suffix: 'outreach-claim' });
  const stakeholder = one(store, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY id LIMIT 1', [job.id]);
  const provider = await fakeLlm({ strategyClass: 'unknown', evidence: [{ id: 'unsupported-private-reference' }], message: 'guaranteed reply' });
  const restore = setLlm(provider.baseUrl);
  let outreach;
  try {
    outreach = await draftOutreach(store, { jobId: job.id, profileId: 'alpha', stakeholderId: stakeholder.id, goal: 'informational' });
  } finally {
    restore();
    await provider.close();
  }
  assert.equal(outreach.mode, 'deterministic-degraded');
  assert.match(outreach.content, /Career-memory tone: formal/);
  assert.match(outreach.content, /opening: direct; closing: call_to_action/);
  assert.match(outreach.content, /Dear [^,]+,/);
  assert.match(outreach.content, /Would a brief conversation be useful\?\nalpha/i);
  assert.doesNotMatch(outreach.content, /synergy|guaranteed reply|unsupported-private-reference/i);
  assert.doesNotMatch(JSON.stringify(provider.requests), /PRIVATE_(?:NOTE|REVIEW_NOTE)/);

  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'tone', value: { value: 'analytical' }, suffix: 'interview-tone' });
  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'opening', value: { value: 'context_first' }, suffix: 'interview-opening' });
  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'closing', value: { value: 'gratitude' }, suffix: 'interview-closing' });
  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'avoid_term', value: { terms: ['synergy'] }, suffix: 'interview-term' });
  const application = one(store, "SELECT * FROM applications WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const interview = await prepInterview(store, application.id);
  assert.match(interview.content, /Career-memory tone:\*\* analytical/);
  assert.match(interview.content, /Opening variant:\*\* context_first/);
  assert.match(interview.content, /Closing variant:\*\* gratitude/);
  assert.match(interview.content, /## Evidence matrix approach/);
  assert.match(interview.content, /Start by connecting each response to the role and company context\./);
  assert.match(interview.content, /End by thanking the interviewer for the conversation\.\n$/);
  assert.doesNotMatch(interview.content, /synergy|PRIVATE_(?:NOTE|REVIEW_NOTE)/i);
});

test('W08-CONSUMERS-05 active word and avoid rules reject output instead of being omitted', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const proof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  acceptWritingRule(store, { scope: 'cover_letter', ruleType: 'length', value: { minWords: 1, maxWords: 10 }, suffix: 'cover-tight-max' });
  const provider = await fakeLlm({ requirementProofMap: [{ requirement: 'Product', proofPointId: proof.id, bullet: proof.summary }], warnings: [] });
  const restore = setLlm(provider.baseUrl);
  try {
    await assert.rejects(
      tailor(store, job.id, 'alpha', 'cover'),
      error => error.code === 'memory_writing_fallback_invalid' && error.details.some(item => item.code === 'memory_writing_length_invalid'),
    );
    assert.equal(provider.requests.length, 1, 'the invalid provider result must be validated before deterministic fallback is rejected');
  } finally {
    restore();
    await provider.close();
  }
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM artifacts WHERE job_id=? AND type='cover_letter'", [job.id]).count, 0);

  acceptWritingRule(store, { scope: 'outreach', ruleType: 'length', value: { minWords: 1200, maxWords: 1200 }, suffix: 'outreach-large-min' });
  const outreachJob = one(store, "SELECT jobs.* FROM jobs JOIN stakeholders ON stakeholders.job_id=jobs.id WHERE jobs.profile_id='alpha' ORDER BY jobs.id LIMIT 1");
  const stakeholder = one(store, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY id LIMIT 1', [outreachJob.id]);
  await assert.rejects(
    draftOutreach(store, { jobId: outreachJob.id, profileId: 'alpha', stakeholderId: stakeholder.id, goal: 'informational' }),
    error => error.code === 'memory_writing_fallback_invalid' && error.details.some(item => item.code === 'memory_writing_length_invalid'),
  );
});

test('W08-CONSUMERS-06 avoid and proof-positioning violations remain active validation failures', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  acceptWritingRule(store, { scope: 'resume', ruleType: 'avoid_term', value: { terms: ['experience'] }, suffix: 'resume-required-term' });
  await assert.rejects(
    tailorResume(store, { jobId: job.id, profileId: 'alpha' }),
    error => error.code === 'memory_writing_fallback_invalid' && error.details.some(item => item.code === 'memory_writing_avoid_term'),
  );

  const sourceProof = one(store, "SELECT * FROM proof_points WHERE profile_id='alpha' AND status='active' AND verification_status='verified' ORDER BY id LIMIT 1");
  const alternateProof = { ...sourceProof, id: 'proof-not-in-pack', summary: 'Alternate verified proof that is not used by the frozen interview story.' };
  const columns = Object.keys(alternateProof);
  guardedWrite(store, () => run(store, `INSERT INTO proof_points (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => alternateProof[column])));
  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'positioning_priority', value: { theme: 'restricted', proofPointIds: [alternateProof.id] }, suffix: 'interview-proof-restriction' });
  const application = one(store, "SELECT * FROM applications WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  await assert.rejects(
    prepInterview(store, application.id),
    error => error.code === 'memory_writing_fallback_invalid' && error.details.some(item => item.code === 'memory_writing_proof_not_allowed'),
  );
});

test('W08-CONSUMERS-07 outreach opening none has no greeting and passes structural validation', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT jobs.* FROM jobs JOIN stakeholders ON stakeholders.job_id=jobs.id WHERE jobs.profile_id='alpha' ORDER BY jobs.id LIMIT 1");
  const stakeholder = one(store, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY id LIMIT 1', [job.id]);
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'opening', value: { value: 'none' }, suffix: 'outreach-opening-none' });

  const result = await draftOutreach(store, { jobId: job.id, profileId: 'alpha', stakeholderId: stakeholder.id, goal: 'informational' });
  const message = result.content.match(/## Draft message\n([\s\S]*?)\n\n## Evidence used/)?.[1] || '';
  assert.match(message, /^(?:I hope your week is going well\. )?I am exploring /);
  assert.doesNotMatch(message, /^(?:Hi|Hello|Dear)\b/);
});

test('W08-CONSUMERS-08 outreach context-first opening is materially rendered and validated', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT jobs.* FROM jobs JOIN stakeholders ON stakeholders.job_id=jobs.id WHERE jobs.profile_id='alpha' ORDER BY jobs.id LIMIT 1");
  const stakeholder = one(store, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY id LIMIT 1', [job.id]);
  acceptWritingRule(store, { scope: 'outreach', ruleType: 'opening', value: { value: 'context_first' }, suffix: 'outreach-opening-context' });

  const result = await draftOutreach(store, { jobId: job.id, profileId: 'alpha', stakeholderId: stakeholder.id, goal: 'informational' });
  const message = result.content.match(/## Draft message\n([\s\S]*?)\n\n## Evidence used/)?.[1] || '';
  assert.ok(message.startsWith(`Regarding the ${job.title} role at ${job.company},\n\nHi `));
});

test('W08-CONSUMERS-09 interview opening none validates only the opening slot, not later body prose', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const application = one(store, "SELECT * FROM applications WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  acceptWritingRule(store, { scope: 'interview_prep', ruleType: 'opening', value: { value: 'none' }, suffix: 'interview-opening-none' });
  run(store, 'UPDATE jobs SET title=? WHERE id=?', ['Start with the public role context', application.job_id]);

  const result = await prepInterview(store, application.id);
  assert.match(result.content, /Role: Start with the public role context/);
  assert.doesNotMatch(result.content, /Start with the highest-priority verified interview evidence\.|Start by connecting each response to the role and company context\.|Start with the strongest verified proof snapshot\./);
});

test('W08-CONSUMERS-10 analytical, direct, and narrative outreach tones alter message prose', async t => {
  const expected = {
    analytical: 'I am assessing the evidence in three parts: role context, verified proof, and a focused question.',
    direct: 'I will be direct: my question is about source-backed fit and the team’s current need.',
    narrative: 'The thread connecting my interest is the role context, one verified proof, and a question about the team’s work.',
  };
  const messages = [];
  for (const [tone, marker] of Object.entries(expected)) {
    await t.test(tone, async subtest => {
      const store = await openStore({ workspace: workspace(subtest) });
      const job = one(store, "SELECT jobs.* FROM jobs JOIN stakeholders ON stakeholders.job_id=jobs.id WHERE jobs.profile_id='alpha' ORDER BY jobs.id LIMIT 1");
      const stakeholder = one(store, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY id LIMIT 1', [job.id]);
      acceptWritingRule(store, { scope: 'outreach', ruleType: 'tone', value: { value: tone }, suffix: `outreach-tone-${tone}` });
      const result = await draftOutreach(store, { jobId: job.id, profileId: 'alpha', stakeholderId: stakeholder.id, goal: 'informational' });
      const message = result.content.match(/## Draft message\n([\s\S]*?)\n\n## Evidence used/)?.[1] || '';
      assert.ok(message.includes(marker));
      messages.push(message);
    });
  }
  assert.equal(new Set(messages).size, 3);
});
