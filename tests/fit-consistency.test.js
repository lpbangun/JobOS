import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { all, one, openStore, run as dbRun, save } from '../src/db.js';
import { importNormalized, importText, syncJob } from '../src/jobs.js';
import { selectedJobContext } from '../src/domain-tools.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import { createSearch, recommendResearchForJobs, runSavedSearch } from '../src/discovery.js';
import { runAction } from '../src/scheduler/actions.js';
import { createResumeRevision } from '../src/resumes.js';
import { addAnswer, inspectApplicationQuestions } from '../src/answers.js';
import { approveArtifact, createArtifact } from '../src/artifacts.js';
import { buildFormSnapshot, persistFormSnapshot } from '../src/forms.js';
import { DOM_ADAPTER_MANIFEST } from '../src/form-browser.js';
import { buildTuiModel } from '../src/tui-model.js';
import { defaultTuiState, renderTui } from '../src/tui.js';
import {
  FIT_CONTRACT,
  FIT_DIMENSION_WEIGHTS,
  compareFitDecisions,
  deserializeFitScore,
  finalizeFitScore,
  qualifiesForHighFit,
  score
} from '../src/scoring.js';

const FIXED_AT = '2026-07-22T12:00:00.000Z';
const evalRoot = path.join(process.cwd(), 'tests', 'eval');

function ref(kind, id, field) {
  return { kind, id, ...(field ? { field } : {}) };
}

function scored(score, weight, evidenceRefs = [ref('profile_preference', 'profile-test', 'targetRoleFamilies'), ref('job_field', 'job-test', 'title')]) {
  return { status: 'scored', score, weight, reason: 'Compared explicit candidate and job evidence.', evidenceRefs };
}

function unknown(weight, evidenceRefs = []) {
  return { status: 'unknown', score: null, weight, reason: 'Required evidence is missing.', evidenceRefs };
}

function dimensions(values = {}) {
  return {
    roleFit: scored(values.roleFit ?? 80, 28),
    domainFit: scored(values.domainFit ?? 80, 18),
    seniority: scored(values.seniority ?? 80, 14),
    locationWorkModel: scored(values.locationWorkModel ?? 80, 12),
    compensation: scored(values.compensation ?? 80, 8),
    missionInterest: scored(values.missionInterest ?? 80, 14),
    networkAccess: scored(values.networkAccess ?? 80, 6, [ref('research_run', 'run-1'), ref('relationship_edge', 'edge-1')]),
    ...(values.overrides || {})
  };
}

function finalized(overrides = {}) {
  return finalizeFitScore({
    jobId: 'job-test',
    profileId: 'profile-test',
    mode: 'deterministic-degraded',
    dimensions: dimensions(),
    constraints: [],
    postingRisks: [],
    reasoning: 'Fixture reasoning.',
    generatedAt: FIXED_AT,
    ...overrides
  });
}

function preferences(overrides = {}) {
  return {
    targetRoleFamilies: ['Curriculum Product Manager', 'Product Manager'],
    industries: ['education technology', 'EdTech'],
    locations: ['Remote US'],
    salary: { min: 120000, max: 180000, currency: 'USD' },
    dealbreakers: [],
    skills: ['product management', 'educator research', 'analytics'],
    missionKeywords: ['learning', 'education'],
    values: ['access', 'evidence'],
    workModel: 'remote',
    ...overrides
  };
}

async function fixture(t, { jobFile = 'jobs/good-fit-curriculum-pm.md', profileFile = null, prefs = preferences(), proofRows = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w04-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = await openStore({ workspace: root });
  const profilePreferences = profileFile ? JSON.parse(readFileSync(path.join(evalRoot, profileFile), 'utf8')) : prefs;
  dbRun(s, 'INSERT INTO profiles (id,name,preferences_json,resume_text,created_at,updated_at) VALUES (?,?,?,?,?,?)', [
    'profile-test', 'PM EdTech', JSON.stringify(profilePreferences), '', FIXED_AT, FIXED_AT
  ]);
  if (proofRows) {
    const proofs = [
      ['proof-research', 'Led educator discovery and user research for a learning product.', ['educator', 'research', 'user research', 'learning']],
      ['proof-launch', 'Led cross-functional product launches with design and engineering.', ['product management', 'cross-functional', 'design', 'engineering']],
      ['proof-analytics', 'Used adoption analytics dashboards to improve learning workflows.', ['analytics', 'adoption', 'learning']]
    ];
    for (const [id, summary, skills] of proofs) dbRun(s, `INSERT INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,status,verification_status,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, 'profile-test', summary, 'verified fixture', JSON.stringify(skills), '[]', 'manual', '{}', 'active', 'verified', FIXED_AT, FIXED_AT
    ]);
  }
  const imported = importText(s, { profileId: 'profile-test', filePath: path.join(evalRoot, jobFile) }).job;
  setLiveness(s, imported.id, 'uncertain');
  save(s);
  return { s, root, job: one(s, 'SELECT * FROM jobs WHERE id=?', [imported.id]) };
}

function setLiveness(s, jobId, status) {
  const value = {
    version: 1,
    jobId,
    status,
    checkedAt: FIXED_AT,
    requestedUrl: '',
    finalUrl: '',
    httpStatus: status === 'active' ? 200 : null,
    reasonCodes: [status === 'active' ? 'listed_in_current_listing' : status === 'expired' ? 'http_404' : 'manual_or_unchecked'],
    evidence: [],
    source: status === 'active' ? 'greenhouse' : 'manual',
    freshUntil: '2026-07-23T12:00:00.000Z'
  };
  dbRun(s, 'UPDATE jobs SET liveness_status=?,liveness_checked_at=?,liveness_json=? WHERE id=?', [status, FIXED_AT, JSON.stringify(value), jobId]);
}

const scoreOpts = { now: () => Date.parse(FIXED_AT) };

function weightedOverall(fit) {
  const known = Object.values(fit.dimensions).filter(value => value.status !== 'unknown');
  return Math.round(known.reduce((sum, value) => sum + value.score * value.weight, 0) / known.reduce((sum, value) => sum + value.weight, 0));
}

function cliScore(root, jobId) {
  const result = spawnSync(process.execPath, ['src/cli.js', 'score', jobId, '--profile', 'profile-test', '--json'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JOBOS_HOME: root,
      JOBOS_LLM_PROVIDER: '',
      JOBOS_LLM_MODEL: '',
      JOBOS_LLM_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OLLAMA_API_KEY: ''
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function createPacketFor(f) {
  const proofId = 'proof-research';
  const resumeDocument = {
    schemaVersion: 1,
    identity: { name: 'PM EdTech', email: 'pm@example.test', phone: '+1 555 555 0100', location: 'Remote', links: [], verificationStatus: 'verified' },
    summary: { id: 'summary-w04', text: 'Product manager with educator research evidence.', proofPointIds: [proofId], verificationStatus: 'verified' },
    experience: [{
      id: 'experience-w04', employer: 'Learning Co', title: 'Product Manager', location: 'Remote', startDate: '2021-01', endDate: null,
      dateSource: { startText: '2021-01', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified',
      bullets: [{ id: 'bullet-w04', text: 'Led educator discovery and user research for a learning product.', proofPointIds: [proofId], verificationStatus: 'verified' }]
    }],
    education: [{ id: 'education-w04', institution: 'State University', degree: 'BS', field: 'Education', location: '', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill-w04', name: 'Product management', category: 'Product', verificationStatus: 'verified' }],
    credentials: [], projects: [], additionalSections: []
  };
  const revision = createResumeRevision(f.s, { profileId: 'profile-test', document: resumeDocument, sourceText: JSON.stringify(resumeDocument), verificationStatus: 'verified' });
  const resume = createArtifact(f.s, {
    jobId: f.job.id,
    profileId: 'profile-test',
    type: 'resume',
    path: path.join('jobs', f.job.id, 'artifacts', 'tailored-resume.md'),
    title: 'Tailored resume',
    content: '# Resume\n\nLed educator discovery and user research for a learning product.',
    evidence: [{ proofPointId: proofId }],
    warnings: [],
    series: { kind: 'resume' },
    mutate: (store, created) => dbRun(store, 'INSERT INTO artifact_resume_documents (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json) VALUES (?,?,?,?,?,?,?,?)', [
      created.id,
      1,
      revision.id,
      JSON.stringify(resumeDocument),
      JSON.stringify({ schemaVersion: 1, summary: { importantRequirementCount: 1, supportedImportantCount: 1, coverageRatio: 1, matchedRequirementIds: [], partiallySupportedRequirementIds: [], omittedSupportedRequirementIds: [], unsupportedRequirementIds: [] } }),
      JSON.stringify({ valid: true, schemaVersion: 1, blockers: [], warnings: [] }),
      JSON.stringify({ templateId: 'jobos-classic', templateVersion: 1, sectionOrder: ['summary', 'experience', 'skills', 'education'], density: 'standard', pageSize: 'letter', pageLimit: 2 }),
      JSON.stringify({ format: 'markdown', status: 'not_requested', blockers: [], warnings: [] })
    ])
  });
  approveArtifact(f.s, resume.id, { reviewedBy: 'cli', note: 'W04 persistence fixture.' });
  for (const question of inspectApplicationQuestions(f.s, { jobId: f.job.id, profileId: 'profile-test' }).questions) {
    addAnswer(f.s, {
      profileId: 'profile-test',
      category: question.category,
      question: question.question,
      answer: question.category === 'work_authorization' ? 'Authorized to work in the United States.' : 'Verified fixture answer.',
      sensitivity: question.category === 'work_authorization' ? 'restricted' : 'personal',
      reuseScope: question.category === 'work_authorization' ? 'never_auto_fill' : 'global',
      verificationStatus: 'verified',
      sourceRef: `job:${f.job.id}`
    });
  }
  addAnswer(f.s, {
    profileId: 'profile-test',
    category: 'motivation',
    question: 'Why this role?',
    answer: 'The role matches verified educator research and product management evidence.',
    sensitivity: 'public',
    reuseScope: 'global',
    verificationStatus: 'verified',
    sourceRef: `job:${f.job.id}`
  });
  const applicationUrl = 'https://apply.example.test/job';
  persistFormSnapshot(f.s, buildFormSnapshot({
    snapshotId: 'form-snapshot-w04',
    jobId: f.job.id,
    profileId: 'profile-test',
    capturedAt: FIXED_AT,
    requestedUrl: applicationUrl,
    finalUrl: applicationUrl,
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frame: { url: applicationUrl, name: '', title: '', ordinal: 0 }, formKey: 'application', candidateCount: 1, score: 3 },
    fields: [{
      frame: { url: applicationUrl, ordinal: 0 },
      locator: { strategy: 'name', value: 'why', ordinal: 0 },
      prompt: 'Why this role?',
      control: 'textarea',
      required: true,
      classification: { category: 'motivation', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' }
    }],
    warnings: []
  }));
  const { createApplicationPacket, showApplicationPacket } = await import('../src/packets.js');
  const packet = createApplicationPacket(f.s, { jobId: f.job.id, profileId: 'profile-test', createdBy: 'cli' });
  return showApplicationPacket(f.s, packet.id);
}

function assertCanonicalWeights(fit) {
  assert.deepEqual(Object.fromEntries(Object.entries(fit.dimensions).map(([key, value]) => [key, value.weight])), FIT_DIMENSION_WEIGHTS);
  assert.equal(Object.values(FIT_DIMENSION_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
}

test('W04-MATH-01 derives the same overall from the same finalized dimensions in every scoring mode', () => {
  const results = ['deterministic-degraded', 'llm', 'agent'].map(mode => finalized({ mode }));
  assert.deepEqual(results.map(result => result.overall), [80, 80, 80]);
  assert.deepEqual(results.map(result => result.baseOverall), [80, 80, 80]);
  results.forEach(assertCanonicalWeights);
});

test('W04-MATH-02 ignores provider overall weights confidence liveness and network proposals', async t => {
  const f = await fixture(t);
  const proposalDimensions = dimensions({ roleFit: 90, domainFit: 70, seniority: 80, locationWorkModel: 75, compensation: 60, missionInterest: 85, networkAccess: 100 });
  for (const value of Object.values(proposalDimensions)) {
    value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: f.job.id } : item);
  }
  const result = await score(f.s, f.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'fixture', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'fixture', baseUrl: 'local' }, json: {
      overall: 1,
      confidence: 'high',
      liveness: 'expired',
      dimensions: Object.fromEntries(Object.entries(proposalDimensions).map(([key, value]) => [key, { ...value, weight: 99 }])),
      constraints: [], postingRisks: [], reasoning: 'Provider dimensions only.'
    } })
  });
  assert.equal(result.overall, weightedOverall(result));
  assert.equal(result.confidence, 'medium');
  assert.equal(result.dimensions.networkAccess.status, 'unknown');
  assert.equal(result.dimensions.networkAccess.score, null);
  assert.equal(result.postingLiveness.status, 'uncertain');
  assert.equal(result.dimensions.liveness, undefined);
  assertCanonicalWeights(result);
});

test('W04-MATH-03 recomputes overall after the local network evidence override', async t => {
  const f = await fixture(t);
  const providerDimensions = dimensions({ roleFit: 50, domainFit: 50, seniority: 50, locationWorkModel: 50, compensation: 50, missionInterest: 50, networkAccess: 100 });
  for (const value of Object.values(providerDimensions)) {
    value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: f.job.id } : item);
  }
  const providerOpts = {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'network-recompute', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'network-recompute', baseUrl: 'local' }, json: {
      dimensions: providerDimensions, constraints: [], postingRisks: [], reasoning: 'Controlled provider dimensions.'
    } })
  };
  const first = await score(f.s, f.job.id, 'profile-test', providerOpts);
  const at = FIXED_AT;
  dbRun(f.s, `INSERT INTO research_runs (id,profile_id,scope,job_id,status,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, ['run-direct', 'profile-test', 'job', f.job.id, 'succeeded', at, at, at]);
  dbRun(f.s, `INSERT INTO person_candidates (id,job_id,name,relevance,confidence,status,created_at,updated_at,person_id,research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, ['candidate-direct', f.job.id, 'Direct Person', 'fixture', 'high', 'candidate', at, at, 'person-direct', 'run-direct']);
  dbRun(f.s, 'INSERT INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)', ['edge-direct', 'profile', 'profile-test', 'person', 'person-direct', 'direct_connection', '[{"label":"source-backed fixture"}]', 'high', at]);
  const second = await score(f.s, f.job.id, 'profile-test', providerOpts);
  assert.equal(first.dimensions.networkAccess.status, 'unknown');
  assert.equal(second.dimensions.networkAccess.status, 'scored');
  assert.equal(second.dimensions.networkAccess.score, 90);
  assert.deepEqual(second.dimensions.networkAccess.evidenceRefs.map(item => item.kind), ['research_run', 'relationship_edge']);
  assert.equal(second.overall, weightedOverall(second));
  assert.notEqual(second.overall, first.overall);
});

test('W04-PROVIDER-01 falls back completely on malformed missing or unsupported provider evidence', async t => {
  const scenarios = [
    { name: 'missing dimension', mutate: raw => { delete raw.dimensions.domainFit; } },
    { name: 'invalid score', mutate: raw => { raw.dimensions.roleFit.score = 101; } },
    { name: 'unsupported evidence', mutate: raw => { raw.dimensions.roleFit.evidenceRefs.push(ref('proof_point', 'unknown-proof')); } },
    { name: 'protected field', mutate: raw => { raw.overall = 99; } },
    { name: 'invalid constraint', mutate: raw => { raw.constraints = [{ kind: 'dealbreaker', status: 'confirmed', dimension: 'compensation', reason: 'No cited inputs.' }]; } }
  ];
  for (const scenario of scenarios) {
    const f = await fixture(t);
    const raw = { dimensions: dimensions(), constraints: [], postingRisks: [], reasoning: 'Provider proposal.' };
    for (const value of Object.values(raw.dimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: f.job.id } : item);
    scenario.mutate(raw);
    const result = await score(f.s, f.job.id, 'profile-test', {
      ...scoreOpts,
      providerConfig: { configured: true, provider: 'openai', model: scenario.name, baseUrl: 'local' },
      generateScore: async () => ({ ok: true, config: { provider: 'openai', model: scenario.name, baseUrl: 'local' }, json: raw })
    });
    assert.equal(result.mode, 'deterministic-degraded', scenario.name);
    assert.equal(result.provider, null, scenario.name);
    assert.equal(result.providerError?.type, 'malformed_provider_output', scenario.name);
    assert.equal(Object.values(result.dimensions).some(value => value.reason === 'Provider proposal.'), false, scenario.name);
  }

  const missingJobEvidence = await fixture(t);
  dbRun(missingJobEvidence.s, "UPDATE jobs SET compensation='',compensation_json='{}' WHERE id=?", [missingJobEvidence.job.id]);
  const unknownProposal = { dimensions: dimensions(), constraints: [], postingRisks: [], reasoning: 'Provider leaves missing compensation unknown.' };
  for (const value of Object.values(unknownProposal.dimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: missingJobEvidence.job.id } : item);
  unknownProposal.dimensions.compensation = {
    status: 'unknown',
    score: null,
    weight: 8,
    reason: 'Compensation cannot be scored without posting compensation.',
    evidenceRefs: [ref('profile_preference', 'profile-test', 'salary'), ref('job_field', missingJobEvidence.job.id, 'compensation')]
  };
  const acceptedUnknown = await score(missingJobEvidence.s, missingJobEvidence.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'unknown-explanation', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'unknown-explanation', baseUrl: 'local' }, json: unknownProposal })
  });
  assert.equal(acceptedUnknown.mode, 'llm');
  assert.equal(acceptedUnknown.dimensions.compensation.status, 'unknown');

  const scoredMissingJob = structuredClone(unknownProposal);
  scoredMissingJob.dimensions.compensation = {
    status: 'scored',
    score: 90,
    weight: 8,
    reason: 'Provider attempted to score missing posting compensation.',
    evidenceRefs: [ref('profile_preference', 'profile-test', 'salary'), ref('job_field', missingJobEvidence.job.id, 'compensation')]
  };
  const rejectedMissingJob = await score(missingJobEvidence.s, missingJobEvidence.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'missing-job-evidence', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'missing-job-evidence', baseUrl: 'local' }, json: scoredMissingJob })
  });
  assert.equal(rejectedMissingJob.mode, 'deterministic-degraded');
  assert.equal(rejectedMissingJob.providerError?.type, 'malformed_provider_output');
  assert.equal(rejectedMissingJob.dimensions.compensation.status, 'unknown');

  const missingCandidateEvidence = await fixture(t, { prefs: preferences({ salary: {} }) });
  const scoredMissingCandidate = { dimensions: dimensions(), constraints: [], postingRisks: [], reasoning: 'Provider attempted to score missing candidate salary.' };
  for (const value of Object.values(scoredMissingCandidate.dimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: missingCandidateEvidence.job.id } : item);
  scoredMissingCandidate.dimensions.compensation.evidenceRefs = [
    ref('profile_preference', 'profile-test', 'salary'),
    ref('job_field', missingCandidateEvidence.job.id, 'compensation')
  ];
  const rejectedMissingCandidate = await score(missingCandidateEvidence.s, missingCandidateEvidence.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'missing-candidate-evidence', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'missing-candidate-evidence', baseUrl: 'local' }, json: scoredMissingCandidate })
  });
  assert.equal(rejectedMissingCandidate.mode, 'deterministic-degraded');
  assert.equal(rejectedMissingCandidate.providerError?.type, 'malformed_provider_output');
  assert.equal(rejectedMissingCandidate.dimensions.compensation.status, 'unknown');

  const emptyDescription = await fixture(t);
  dbRun(emptyDescription.s, "UPDATE jobs SET description='' WHERE id=?", [emptyDescription.job.id]);
  const observedWithoutEvidence = { dimensions: dimensions(), constraints: [], postingRisks: [{
    code: 'provider_empty_description_risk',
    status: 'observed',
    reason: 'Provider attempted to observe a risk in an empty description.',
    evidenceRefs: [ref('job_field', emptyDescription.job.id, 'description')]
  }], reasoning: 'Provider posting-risk proposal.' };
  for (const value of Object.values(observedWithoutEvidence.dimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: emptyDescription.job.id } : item);
  const rejectedRisk = await score(emptyDescription.s, emptyDescription.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'empty-risk-evidence', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'empty-risk-evidence', baseUrl: 'local' }, json: observedWithoutEvidence })
  });
  assert.equal(rejectedRisk.mode, 'deterministic-degraded');
  assert.equal(rejectedRisk.providerError?.type, 'malformed_provider_output');
  assert.equal(rejectedRisk.postingRisks.some(value => value.code === 'provider_empty_description_risk'), false);

  const deal = await fixture(t, { jobFile: 'jobs/dealbreaker-equity-only.md', profileFile: 'profiles/no-equity-only.json' });
  const dealDimensions = dimensions({ roleFit: 90, domainFit: 90, seniority: 90, locationWorkModel: 90, compensation: 90, missionInterest: 90 });
  for (const value of Object.values(dealDimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: deal.job.id } : item);
  const dealResult = await score(deal.s, deal.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'dealbreaker', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'dealbreaker', baseUrl: 'local' }, json: { dimensions: dealDimensions, constraints: [], postingRisks: [], reasoning: 'High provider dimensions.' } })
  });
  assert.equal(dealResult.mode, 'llm');
  assert.equal(dealResult.overall, 0);
  assert.ok(dealResult.constraints.some(value => value.kind === 'dealbreaker' && value.status === 'confirmed'));

  const inferred = await fixture(t);
  const inferredDimensions = dimensions();
  for (const value of Object.values(inferredDimensions)) value.evidenceRefs = value.evidenceRefs.map(item => item.kind === 'job_field' ? { ...item, id: inferred.job.id } : item);
  const inferredResult = await score(inferred.s, inferred.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'inferred-constraint', baseUrl: 'local' },
    generateScore: async () => ({ ok: true, config: { provider: 'openai', model: 'inferred-constraint', baseUrl: 'local' }, json: {
      dimensions: inferredDimensions,
      constraints: [{
        id: 'provider-confirmed', kind: 'contradiction', dimension: 'compensation', status: 'confirmed',
        preferenceRef: ref('profile_preference', 'profile-test', 'salary'),
        jobEvidenceRefs: [ref('job_field', inferred.job.id, 'description')],
        reason: 'Provider inferred a conflict.'
      }],
      postingRisks: [], reasoning: 'Provider constraint proposal.'
    } })
  });
  assert.equal(inferredResult.mode, 'llm');
  assert.equal(inferredResult.constraints.find(value => value.id === 'provider-confirmed').status, 'possible');
});

test('W04-PROVIDER-02 falls back on provider transport failure but surfaces mediated agent execution errors', async t => {
  const transport = await fixture(t);
  const fallback = await score(transport.s, transport.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'openai', model: 'transport', baseUrl: 'local' },
    generateScore: async () => { throw Object.assign(new Error('connection reset'), { type: 'transport_error', code: 'ECONNRESET' }); }
  });
  assert.equal(fallback.mode, 'deterministic-degraded');
  assert.equal(fallback.providerError.type, 'transport_error');
  assert.doesNotMatch(JSON.stringify(fallback.providerError), /api[_ -]?key|authorization/i);

  const mediated = await fixture(t);
  await assert.rejects(() => score(mediated.s, mediated.job.id, 'profile-test', {
    ...scoreOpts,
    providerConfig: { configured: true, provider: 'agent', model: 'mediated', baseUrl: 'local' },
    generateScore: async () => { throw Object.assign(new Error('agent execution failed'), { type: 'agent_error' }); }
  }), error => error.type === 'agent_error');
  assert.equal(one(mediated.s, 'SELECT score_json FROM jobs WHERE id=?', [mediated.job.id]).score_json, null);
});

test('W04-ROUND-01 rounds once after normalization and persists the identical integer or null everywhere', async t => {
  const d = dimensions({ roleFit: 81, domainFit: 72, seniority: 67, locationWorkModel: 88, compensation: 74, missionInterest: 63, networkAccess: 91 });
  const expected = Math.round(Object.values(d).reduce((sum, value) => sum + value.score * value.weight, 0) / 100);
  const pure = finalized({ dimensions: d });
  assert.equal(pure.overall, expected);
  const f = await fixture(t);
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const row = one(f.s, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [f.job.id]);
  const persisted = JSON.parse(row.score_json);
  const audit = JSON.parse(one(f.s, "SELECT payload_json FROM audit_log WHERE action='job.scored' AND entity_id=? ORDER BY created_at DESC LIMIT 1", [f.job.id]).payload_json);
  assert.equal(row.fit_score, result.overall);
  assert.equal(persisted.overall, result.overall);
  assert.equal(audit.overall, result.overall);
  assert.equal(audit.contract, FIT_CONTRACT);
});

test('W04-UNKNOWN-01 represents missing compensation location and network evidence as unknown null', async t => {
  const f = await fixture(t, { jobFile: 'jobs/unknown-compensation-location.md' });
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  for (const key of ['locationWorkModel', 'compensation', 'networkAccess']) {
    assert.equal(result.dimensions[key].status, 'unknown', key);
    assert.equal(result.dimensions[key].score, null, key);
  }
});

test('W04-UNKNOWN-02 withholds overall and high fit when core or weighted evidence is insufficient', () => {
  const missingCore = finalized({ dimensions: dimensions({ overrides: { roleFit: unknown(28) } }) });
  const tooLittle = finalized({ dimensions: dimensions({ overrides: { domainFit: unknown(18), locationWorkModel: unknown(12), compensation: unknown(8), missionInterest: unknown(14), networkAccess: unknown(6) } }) });
  for (const fit of [missingCore, tooLittle]) {
    assert.equal(fit.overall, null);
    assert.equal(fit.scoreStatus, 'insufficient_evidence');
    assert.equal(qualifiesForHighFit(fit, 0), false);
  }
});

test('W04-UNKNOWN-03 keeps a provisional numeric score review required below high fit coverage', () => {
  const fit = finalized({ dimensions: dimensions({ overrides: { compensation: unknown(8), networkAccess: unknown(6) } }) });
  assert.equal(typeof fit.overall, 'number');
  assert.equal(fit.evidenceCoverage, 86);
  assert.equal(fit.scoreStatus, 'scored');
  assert.equal(qualifiesForHighFit(fit, fit.overall), true);
  const below = finalized({ dimensions: dimensions({ overrides: { locationWorkModel: unknown(12), compensation: unknown(8) } }) });
  assert.equal(typeof below.overall, 'number');
  assert.equal(below.evidenceCoverage, 80);
  assert.equal(below.scoreStatus, 'review_required');
  assert.equal(qualifiesForHighFit(below, 0), false);
});

test('W04-DEAL-01 sets overall zero for a confirmed explicit dealbreaker with both evidence sides cited', () => {
  const constraint = {
    id: 'deal-equity', kind: 'dealbreaker', dimension: 'compensation', status: 'confirmed',
    preferenceRef: ref('profile_preference', 'profile-test', 'dealbreakers'),
    jobEvidenceRefs: [ref('job_field', 'job-test', 'compensation')], reason: 'Explicit equity-only dealbreaker conflicts with direct compensation evidence.'
  };
  assert.throws(() => finalized({ constraints: [{ ...constraint, preferenceRef: null }] }), /preference reference/i);
  assert.throws(() => finalized({ constraints: [{ ...constraint, jobEvidenceRefs: [] }] }), /job evidence/i);
  const fit = finalized({ constraints: [constraint] });
  assert.equal(fit.baseOverall, 80);
  assert.equal(fit.overall, 0);
  assert.equal(fit.scoreStatus, 'review_required');
  assert.deepEqual(fit.constraints[0].preferenceRef, constraint.preferenceRef);
  assert.deepEqual(fit.constraints[0].jobEvidenceRefs, constraint.jobEvidenceRefs);
  assert.equal(qualifiesForHighFit(fit, 0), false);
  const insufficient = finalized({ dimensions: dimensions({ overrides: { roleFit: unknown(28) } }), constraints: [constraint] });
  assert.equal(insufficient.baseOverall, null);
  assert.equal(insufficient.overall, 0);
  assert.equal(insufficient.scoreStatus, 'review_required');
  assert.equal(qualifiesForHighFit(insufficient, 0), false);
});

test('W04-CONTRA-01 caps a confirmed material contradiction at 59 and requires review', () => {
  const fit = finalized({ constraints: [{
    id: 'contra-onsite', kind: 'contradiction', dimension: 'locationWorkModel', status: 'confirmed',
    preferenceRef: ref('profile_preference', 'profile-test', 'workModel'),
    jobEvidenceRefs: [ref('job_field', 'job-test', 'work_model')], reason: 'Remote-only preference conflicts with an on-site requirement.'
  }] });
  assert.equal(fit.baseOverall, 80);
  assert.equal(fit.overall, 59);
  assert.equal(fit.scoreStatus, 'review_required');
});

test('W04-DEAL-02 keeps ambiguous legacy dealbreakers review-only while structured cases remain deterministic', async t => {
  const negated = await fixture(t, { prefs: preferences({ dealbreakers: ['no travel'] }) });
  dbRun(negated.s, "UPDATE jobs SET description='No travel required. This role supports educators and learning products.' WHERE id=?", [negated.job.id]);
  const negatedFit = await score(negated.s, negated.job.id, 'profile-test', scoreOpts);
  const negatedConstraint = negatedFit.constraints.find(value => value.kind === 'dealbreaker');
  assert.equal(negatedConstraint.status, 'unknown');
  assert.notEqual(negatedFit.overall, 0);
  assert.equal(negatedFit.scoreStatus, 'review_required');

  const absent = await fixture(t, { prefs: preferences({ dealbreakers: ['must use a purple laptop'] }) });
  const absentFit = await score(absent.s, absent.job.id, 'profile-test', scoreOpts);
  const absentConstraint = absentFit.constraints.find(value => value.kind === 'dealbreaker');
  assert.equal(absentConstraint.status, 'unknown');
  assert.equal(absentFit.scoreStatus, 'review_required');

  const equity = await fixture(t, { jobFile: 'jobs/dealbreaker-equity-only.md', profileFile: 'profiles/no-equity-only.json' });
  const equityFit = await score(equity.s, equity.job.id, 'profile-test', scoreOpts);
  assert.equal(equityFit.constraints.find(value => value.kind === 'dealbreaker').status, 'confirmed');
  assert.equal(equityFit.overall, 0);

  const onsite = await fixture(t, { jobFile: 'jobs/contradiction-onsite-remote.md', profileFile: 'profiles/remote-only.json' });
  const onsiteFit = await score(onsite.s, onsite.job.id, 'profile-test', scoreOpts);
  assert.equal(onsiteFit.constraints.find(value => value.kind === 'contradiction').status, 'confirmed');
  assert.equal(onsiteFit.overall, 59);
});

test('W04-PRECEDENCE-01 orders liveness dealbreakers contradictions unknowns and numeric fit without mixing them', () => {
  const scoredFit = finalized({ dimensions: dimensions({ roleFit: 70 }) });
  const reviewFit = finalized({ dimensions: dimensions({ overrides: { locationWorkModel: unknown(12), compensation: unknown(8) } }) });
  const contradiction = finalized({ constraints: [{ id: 'c', kind: 'contradiction', dimension: 'locationWorkModel', status: 'confirmed', preferenceRef: ref('profile_preference', 'profile-test', 'workModel'), jobEvidenceRefs: [ref('job_field', 'job-test', 'work_model')], reason: 'Conflict.' }] });
  const dealbreaker = finalized({ constraints: [{ id: 'd', kind: 'dealbreaker', dimension: 'compensation', status: 'confirmed', preferenceRef: ref('profile_preference', 'profile-test', 'dealbreakers'), jobEvidenceRefs: [ref('job_field', 'job-test', 'compensation')], reason: 'Conflict.' }] });
  const rows = [
    { jobId: 'expired', fit: scoredFit, postingLiveness: { status: 'expired' } },
    { jobId: 'deal', fit: dealbreaker, postingLiveness: { status: 'active' } },
    { jobId: 'contra', fit: contradiction, postingLiveness: { status: 'active' } },
    { jobId: 'unknown', fit: reviewFit, postingLiveness: { status: 'active' } },
    { jobId: 'scored', fit: scoredFit, postingLiveness: { status: 'active' } }
  ].sort(compareFitDecisions);
  assert.deepEqual(rows.map(row => row.jobId), ['scored', 'unknown', 'contra', 'deal', 'expired']);
  assert.equal(rows[0].fit.overall, scoredFit.overall);
  assert.equal(rows.at(-1).fit.overall, scoredFit.overall, 'expired liveness never rewrites fit');
});

test('W04-EVIDENCE-01 requires valid candidate and job evidence references for every scored dimension reason', () => {
  assert.throws(() => finalized({ dimensions: dimensions({ overrides: { roleFit: scored(80, 28, [ref('job_field', 'job-test', 'title')]) } }) }), /candidate evidence/i);
  assert.throws(() => finalized({ dimensions: dimensions({ overrides: { seniority: scored(80, 14, [ref('profile_preference', 'profile-test', 'targetRoleFamilies')]) } }) }), /job evidence/i);
  assert.throws(() => finalized({ dimensions: dimensions({ overrides: { roleFit: scored(80, 28, [ref('profile_preference', 'profile-test', 'targetRoleFamilies'), ref('invented', 'bad')]) } }) }), /evidence reference/i);
});

test('W04-EVIDENCE-02 cites exactly the non-empty deterministic preference inputs', async t => {
  const emptyPreferences = {
    targetRoleFamilies: [],
    industries: [],
    locations: [],
    salary: {},
    dealbreakers: [],
    skills: [],
    missionKeywords: [],
    values: [],
    workModel: ''
  };
  const cases = [
    { name: 'skills-only', prefs: { skills: ['product management'] }, expected: { roleFit: ['skills'] } },
    { name: 'mission-keywords-only', prefs: { missionKeywords: ['learning'] }, expected: { domainFit: ['missionKeywords'], missionInterest: ['missionKeywords'] } },
    { name: 'values-only', prefs: { values: ['access'] }, expected: { missionInterest: ['values'] } },
    { name: 'industries-only', prefs: { industries: ['education technology'] }, expected: { domainFit: ['industries'], missionInterest: ['industries'] } }
  ];
  for (const item of cases) {
    const f = await fixture(t, { prefs: { ...emptyPreferences, ...item.prefs }, proofRows: false });
    const fit = await score(f.s, f.job.id, 'profile-test', scoreOpts);
    for (const [dimension, expectedFields] of Object.entries(item.expected)) {
      assert.equal(fit.dimensions[dimension].status, 'scored', `${item.name}:${dimension}`);
      const actualFields = fit.dimensions[dimension].evidenceRefs
        .filter(value => value.kind === 'profile_preference')
        .map(value => value.field)
        .sort();
      assert.deepEqual(actualFields, expectedFields, `${item.name}:${dimension}`);
    }
  }
});

test('W04-PROOF-01 credits active verified transferable proof in dimensions without a hidden boost', async t => {
  const withProof = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md' });
  const supported = await score(withProof.s, withProof.job.id, 'profile-test', scoreOpts);
  const withoutProof = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md', proofRows: false });
  const unsupported = await score(withoutProof.s, withoutProof.job.id, 'profile-test', scoreOpts);
  assert.ok(supported.dimensions.roleFit.score > unsupported.dimensions.roleFit.score || supported.dimensions.domainFit.score > unsupported.dimensions.domainFit.score);
  const refs = Object.values(supported.dimensions).flatMap(value => value.evidenceRefs);
  assert.ok(refs.some(item => item.kind === 'proof_point' && item.id === 'proof-research'));
  assert.equal(supported.overall, weightedOverall(supported));
  assert.equal(supported.baseOverall, weightedOverall(supported), 'proof affects visible dimensions only');
});

test('W04-PROOF-02 excludes retired superseded unverified and unknown proof references', async t => {
  const f = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md', proofRows: false });
  for (const [id, status, verification] of [['retired-proof', 'retired', 'verified'], ['superseded-proof', 'retired', 'verified'], ['unverified-proof', 'active', 'unverified']]) {
    dbRun(f.s, `INSERT INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,status,verification_status,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, 'profile-test', 'Led educator research and analytics.', 'fixture', '["educator research","analytics"]', '[]', 'manual', '{}', status, verification, FIXED_AT, FIXED_AT]);
  }
  dbRun(f.s, `INSERT INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,status,verification_status,supersedes_proof_point_id,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['replacement-proof', 'profile-test', 'Unrelated verified replacement evidence.', 'fixture', '["unrelated"]', '[]', 'manual', '{}', 'active', 'verified', 'superseded-proof', FIXED_AT, FIXED_AT]);
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const baselineFixture = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md', proofRows: false });
  const baseline = await score(baselineFixture.s, baselineFixture.job.id, 'profile-test', scoreOpts);
  const refs = Object.values(result.dimensions).flatMap(value => value.evidenceRefs);
  assert.equal(refs.some(item => ['retired-proof', 'superseded-proof', 'unverified-proof', 'unknown-proof'].includes(item.id)), false);
  assert.equal(result.dimensions.roleFit.score, baseline.dimensions.roleFit.score);
  assert.equal(result.dimensions.domainFit.score, baseline.dimensions.domainFit.score);
});

test('W04-PERSIST-01 keeps fit score JSON database audit workspace readiness packet and domain output consistent', async t => {
  const f = await fixture(t);
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const row = one(f.s, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [f.job.id]);
  const stored = JSON.parse(row.score_json);
  const audit = JSON.parse(one(f.s, "SELECT payload_json FROM audit_log WHERE action='job.scored' AND entity_id=? ORDER BY created_at DESC LIMIT 1", [f.job.id]).payload_json);
  const workspace = readFileSync(path.join(f.s.p.jobs, f.job.id, 'job.yaml'), 'utf8');
  const readiness = compileApplicationReadiness(f.s, { jobId: f.job.id, profileId: 'profile-test' });
  const domain = selectedJobContext(f.s, f.job.id, 'profile-test');
  const packet = await createPacketFor(f);
  assert.equal(result.contract, FIT_CONTRACT);
  assert.equal(stored.contract, FIT_CONTRACT);
  assert.equal(row.fit_score, result.overall);
  assert.equal(audit.contract, FIT_CONTRACT);
  assert.equal(audit.overall, result.overall);
  assert.match(workspace, new RegExp(`fitScore: ${result.overall}`));
  assert.match(workspace, new RegExp(`contract: ${FIT_CONTRACT.replaceAll('.', '\\.')}`));
  assert.equal(readiness.materials.score.contract, FIT_CONTRACT);
  assert.equal(readiness.materials.score.overall, result.overall);
  assert.equal(domain.fit.contract, FIT_CONTRACT);
  assert.equal(domain.fit.overall, result.overall);
  assert.equal(Object.hasOwn(packet, 'fit'), false);
  assert.equal(Object.hasOwn(packet.materials, 'score'), false);
});

test('W04-LEGACY-01 reads unversioned scores without silent rewrite and excludes them from new high fit decisions', async t => {
  const f = await fixture(t);
  const legacy = { overall: 99, confidence: 'high', mode: 'llm', dimensions: {} };
  dbRun(f.s, 'UPDATE jobs SET fit_score=99,score_json=?,high_fit=0 WHERE id=?', [JSON.stringify(legacy), f.job.id]);
  save(f.s);
  const before = one(f.s, 'SELECT score_json FROM jobs WHERE id=?', [f.job.id]).score_json;
  const fit = deserializeFitScore(legacy, { persistedOverall: 99, jobId: f.job.id, profileId: 'profile-test' });
  syncJob(f.s, f.job.id);
  const after = one(f.s, 'SELECT score_json FROM jobs WHERE id=?', [f.job.id]).score_json;
  assert.equal(fit.contract, 'legacy_unversioned');
  assert.ok(fit.warnings.some(item => item.code === 'legacy_fit_contract'));
  assert.equal(qualifiesForHighFit(fit, 70), false);
  assert.equal(after, before);
});

test('W04-QUALIFY-01 applies one qualification helper to saved search scheduler and research recommendations', async t => {
  const f = await fixture(t);
  const eligible = finalized();
  const review = finalized({ dimensions: dimensions({ overrides: { locationWorkModel: unknown(12), compensation: unknown(8) } }) });
  const blocked = finalized({ constraints: [{ id: 'd', kind: 'dealbreaker', dimension: 'compensation', status: 'confirmed', preferenceRef: ref('profile_preference', 'profile-test', 'dealbreakers'), jobEvidenceRefs: [ref('job_field', 'job-test', 'compensation')], reason: 'Conflict.' }] });
  const legacy = { overall: 100, scoreStatus: 'scored' };
  assert.equal(qualifiesForHighFit(eligible, eligible.overall), true);
  assert.equal(qualifiesForHighFit(eligible, eligible.overall + 1), false);
  assert.equal(qualifiesForHighFit(review, 0), false);
  assert.equal(qualifiesForHighFit(blocked, 0), false);
  assert.equal(qualifiesForHighFit(legacy, 0), false);

  const search = createSearch(f.s, { name: 'w04-qualification', profileId: 'profile-test', adapter: 'greenhouse', config: { company: 'fixture' }, minFit: 70 });
  const fitByTitle = { Eligible: eligible, Review: review, Blocked: blocked, Legacy: legacy };
  const jobs = Object.keys(fitByTitle).map((title, index) => ({
    version: 1, title, company: 'Qualification Co', location: 'Remote', url: `https://example.test/${index}`, source: 'greenhouse', sourceId: `qual-${index}`,
    description: `${title} product manager`, postedDate: '2026-07-22T00:00:00.000Z',
    compensation: { text: '$140k', min: 140000, max: 140000, currency: 'USD', interval: 'year' },
    workModel: 'remote', employmentTypes: ['full_time'], department: '', sourceNativeFields: {}
  }));
  await runSavedSearch(f.s, search.id, {
    adapter: { fetchJobs: async () => jobs },
    checkLiveness: async job => ({ version: 1, jobId: job.sourceId, status: 'active', checkedAt: FIXED_AT, requestedUrl: job.url, finalUrl: job.url, httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [], source: 'greenhouse', freshUntil: '2026-07-23T12:00:00.000Z' }),
    scoreJob: async (store, jobId) => {
      const row = one(store, 'SELECT title FROM jobs WHERE id=?', [jobId]);
      const fit = { ...fitByTitle[row.title], jobId, profileId: 'profile-test', postingLiveness: { contract: 'jobos.posting-liveness.v1', jobId, status: 'active', checkedAt: FIXED_AT, reasonCodes: ['listed_in_current_listing'], source: 'greenhouse' } };
      dbRun(store, 'UPDATE jobs SET fit_score=?,score_json=? WHERE id=?', [fit.overall ?? null, JSON.stringify(fit.contract ? { ...fit, postingLiveness: undefined } : fit), jobId]);
      return fit;
    },
    now: () => Date.parse(FIXED_AT)
  });
  const qualificationRows = all(f.s, "SELECT title,high_fit FROM jobs WHERE company='Qualification Co' ORDER BY title");
  assert.deepEqual(Object.fromEntries(qualificationRows.map(row => [row.title, Boolean(row.high_fit)])), { Blocked: false, Eligible: true, Legacy: false, Review: false });
  const recommendations = recommendResearchForJobs(f.s, { profileId: 'profile-test', limit: 10 });
  assert.deepEqual(recommendations.filter(item => item.company === 'Qualification Co').map(item => item.title), ['Eligible']);
  const brief = await runAction(f.s, { actionId: 'morning_priority_brief', profileId: 'profile-test' }, { nowDate: new Date(FIXED_AT) });
  const briefText = readFileSync(path.join(f.s.p.ws, brief.outputs.briefs[0].path), 'utf8');
  assert.match(briefText, /Eligible at Qualification Co/);
  assert.doesNotMatch(briefText, /(Review|Blocked|Legacy) at Qualification Co/);
});

test('W04-GOLD-01 preserves labeled direct adjacent secondary and wrong track rank order', async t => {
  const cases = JSON.parse(readFileSync(path.join(evalRoot, 'scoring-cases.json'), 'utf8')).filter(item => ['direct', 'adjacent', 'secondary', 'wrong-track'].includes(item.rankGroup));
  const results = [];
  for (const item of cases) {
    const f = await fixture(t, { jobFile: item.file, profileFile: item.profile });
    results.push({ item, fit: await score(f.s, f.job.id, 'profile-test', scoreOpts) });
  }
  const best = group => Math.max(...results.filter(result => result.item.rankGroup === group).map(result => result.fit.overall));
  const worst = group => Math.min(...results.filter(result => result.item.rankGroup === group).map(result => result.fit.overall));
  for (const { item, fit } of results) {
    assert.equal(fit.scoreStatus, item.expectedDecision, item.label);
    for (const key of item.requiredKnownDimensions) assert.equal(fit.dimensions[key].status, 'scored', `${item.label}:${key}`);
  }
  assert.ok(worst('direct') > best('adjacent'));
  assert.ok(worst('adjacent') > best('secondary'));
  assert.ok(worst('secondary') > best('wrong-track'));
});

test('W04-GOLD-02 ranks verified transferability above unsupported adjacency and below direct fit', async t => {
  const directFixture = await fixture(t, { jobFile: 'jobs/good-fit-curriculum-pm.md' });
  const direct = await score(directFixture.s, directFixture.job.id, 'profile-test', scoreOpts);
  const supportedFixture = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md' });
  const supported = await score(supportedFixture.s, supportedFixture.job.id, 'profile-test', scoreOpts);
  const unsupportedFixture = await fixture(t, { jobFile: 'jobs/transferable-edtech-operations.md', proofRows: false });
  const unsupported = await score(unsupportedFixture.s, unsupportedFixture.job.id, 'profile-test', scoreOpts);
  assert.ok(direct.overall > supported.overall, `${direct.overall} > ${supported.overall}`);
  assert.ok(supported.overall > unsupported.overall, `${supported.overall} > ${unsupported.overall}`);
});

test('W04-GOLD-03 ranks contradiction and dealbreaker cases by decision precedence before numeric score', async t => {
  const cases = JSON.parse(readFileSync(path.join(evalRoot, 'scoring-cases.json'), 'utf8'));
  const contradictionCase = cases.find(item => item.label === 'contradiction-onsite-remote');
  const dealCase = cases.find(item => item.label === 'dealbreaker-equity-only');
  const contradictionFixture = await fixture(t, { jobFile: contradictionCase.file, profileFile: contradictionCase.profile });
  const contradiction = await score(contradictionFixture.s, contradictionFixture.job.id, 'profile-test', scoreOpts);
  const dealFixture = await fixture(t, { jobFile: dealCase.file, profileFile: dealCase.profile });
  const deal = await score(dealFixture.s, dealFixture.job.id, 'profile-test', scoreOpts);
  const scoredFit = finalized({ dimensions: dimensions({ roleFit: 95, domainFit: 95, seniority: 95, locationWorkModel: 95, compensation: 95, missionInterest: 95, networkAccess: 95 }) });
  assert.equal(contradiction.overall, Math.min(contradiction.baseOverall, 59));
  assert.equal(deal.overall, 0);
  assert.ok(deal.baseOverall > 0);
  assert.equal(contradiction.scoreStatus, contradictionCase.expectedDecision);
  assert.equal(deal.scoreStatus, dealCase.expectedDecision);
  assert.equal(qualifiesForHighFit(contradiction, 0), false);
  assert.equal(qualifiesForHighFit(deal, 0), false);
  const ordered = [
    { jobId: 'deal', fit: deal, postingLiveness: { status: 'active' } },
    { jobId: 'contra', fit: contradiction, postingLiveness: { status: 'active' } },
    { jobId: 'scored', fit: scoredFit, postingLiveness: { status: 'active' } }
  ].sort(compareFitDecisions);
  assert.deepEqual(ordered.map(item => item.jobId), ['scored', 'contra', 'deal']);
});

test('W04-LIVE-01 consumes jobos posting liveness v1 as a sibling of fit', async t => {
  const f = await fixture(t);
  setLiveness(f.s, f.job.id, 'active');
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const stored = JSON.parse(one(f.s, 'SELECT score_json FROM jobs WHERE id=?', [f.job.id]).score_json);
  assert.deepEqual(Object.keys(result.postingLiveness).sort(), ['checkedAt', 'contract', 'jobId', 'reasonCodes', 'source', 'status']);
  assert.equal(result.postingLiveness.contract, 'jobos.posting-liveness.v1');
  assert.equal(result.postingLiveness.jobId, f.job.id);
  assert.equal(result.postingLiveness.status, 'active');
  assert.ok(Array.isArray(result.postingLiveness.reasonCodes));
  assert.equal(stored.contract, FIT_CONTRACT);
  assert.equal(stored.postingLiveness, undefined);
  assert.equal(stored.dimensions.liveness, undefined);
});

test('W04-LIVE-02 keeps identical candidate fit for active and uncertain posting evidence', async t => {
  const f = await fixture(t);
  setLiveness(f.s, f.job.id, 'active');
  const active = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  setLiveness(f.s, f.job.id, 'uncertain');
  const uncertain = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  assert.equal(active.overall, uncertain.overall);
  assert.equal(active.baseOverall, uncertain.baseOverall);
  assert.deepEqual(active.dimensions, uncertain.dimensions);
  assert.equal(active.postingLiveness.status, 'active');
  assert.equal(uncertain.postingLiveness.status, 'uncertain');
});

test('W04-LIVE-03 presents expired as unavailable without rewriting a prior fit score', async t => {
  const f = await fixture(t);
  setLiveness(f.s, f.job.id, 'active');
  await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const before = one(f.s, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [f.job.id]);
  setLiveness(f.s, f.job.id, 'expired');
  await assert.rejects(() => score(f.s, f.job.id, 'profile-test', scoreOpts), error => error.code === 'job_expired');
  const after = one(f.s, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [f.job.id]);
  assert.deepEqual(after, before);
  assert.equal(selectedJobContext(f.s, f.job.id, 'profile-test').postingLiveness.status, 'expired');
});

test('W04-LIVE-04 renders fit and posting status separately in CLI domain TUI and workspace views', async t => {
  const f = await fixture(t);
  dbRun(f.s, "UPDATE jobs SET description=description || '\n\nTraining fee required before onboarding.' WHERE id=?", [f.job.id]);
  save(f.s);
  const result = await score(f.s, f.job.id, 'profile-test', scoreOpts);
  const cli = cliScore(f.root, f.job.id);
  const context = selectedJobContext(f.s, f.job.id, 'profile-test');
  assert.equal(cli.contract, FIT_CONTRACT);
  assert.equal(cli.postingLiveness.contract, 'jobos.posting-liveness.v1');
  assert.equal(context.fit.contract, FIT_CONTRACT);
  assert.equal(context.postingLiveness.contract, 'jobos.posting-liveness.v1');
  assert.equal(context.liveness, undefined);
  const model = buildTuiModel(f.s, { profileId: 'profile-test', selectedJobId: f.job.id, at: FIXED_AT });
  const state = { ...defaultTuiState(), selectedJobId: f.job.id };
  const rendered = renderTui(model, state, { width: 140, height: 54, color: false });
  assert.match(rendered, new RegExp(`FIT ${result.overall}/100`));
  assert.match(rendered, /networkAccess: unknown/);
  assert.match(rendered, /CANDIDATE CONSTRAINTS/);
  assert.match(rendered, /POSTING STATUS \/ LEGITIMACY/);
  assert.match(rendered, /training fee/i);
  const workspace = readFileSync(path.join(f.s.p.jobs, f.job.id, 'job.yaml'), 'utf8');
  assert.match(workspace, /fit:\n\s+contract: jobos\.fit-score\.v1/);
  assert.match(workspace, /postingLiveness:\n\s+contract: jobos\.posting-liveness\.v1/);
  assert.doesNotMatch(JSON.stringify(JSON.parse(one(f.s, 'SELECT score_json FROM jobs WHERE id=?', [f.job.id]).score_json)), /postingLiveness/);
});
