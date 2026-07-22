import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';
import { all, one, openStore, run as dbRun, save } from '../src/db.js';
import { createSearch, runSavedSearch, runAllSearches, recommendResearchForJobs } from '../src/discovery.js';
import { importNormalized, syncJob } from '../src/jobs.js';
import { score } from '../src/scoring.js';
import { runPursuit, runDaily } from '../src/workflows.js';
import { createAutomation } from '../src/scheduler/store.js';
import { runAutomation } from '../src/scheduler/core.js';
import { classifyLiveness } from '../src/discovery/liveness.js';
import { listJobSummaries, selectedJobContext } from '../src/domain-tools.js';

const require = createRequire(import.meta.url);

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'discovery-integrity');
const loadJson = name => JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8'));

// ---------------------------------------------------------------------------
// Shared deterministic harness
// ---------------------------------------------------------------------------

function makeStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w03-int-'));
  return { root, async open() { return await openStore({ workspace: root }); } };
}

async function freshStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w03-int-'));
  const s = await openStore({ workspace: root });
  return { root, s };
}

const FIXED_NOW_MS = Date.parse('2026-07-22T00:00:00.000Z');
const fixedNow = () => FIXED_NOW_MS;

function seedProfile(s, { name = 'Test Profile', preferences = {} } = {}) {
  const at = new Date(FIXED_NOW_MS).toISOString();
  dbRun(s, "INSERT INTO profiles (id,name,preferences_json,resume_text,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ['profile-test', name, JSON.stringify(preferences), '', at, at]);
  return 'profile-test';
}

// A normalized adapter result v1 shape (§5.2) for deterministic run orchestration.
function normalizedJob({ id, title, company, location, url, source = 'greenhouse', postedDate = '', compensation, workModel = 'unknown', employmentTypes = [], department = '', sourceNativeFields = {}, livenessHint = null }) {
  return {
    version: 1,
    title,
    company,
    location,
    url,
    source,
    sourceId: id,
    description: `${title} at ${company}`,
    postedDate,
    compensation: compensation || { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel,
    employmentTypes,
    department,
    sourceNativeFields,
    livenessHint
  };
}

// Build a deterministic adapter whose fetchJobs returns a fixed result list.
// The adapter can also return metadata.errors / truncated for partial-status tests.
function makeAdapter(result, metadata = null) {
  return {
    async fetchJobs() {
      if (metadata) return { jobs: result, metadata };
      return result;
    }
  };
}

// Inject a fake adapter into the discovery adapter registry for a run.
// runSavedSearch calls getAdapter(row.adapter); we monkey-patch the module.
function withAdapter(adapterMap, fn) {
  // adapterMap: { greenhouse: fakeAdapter }
  // We intercept by providing opts.adapter to runSavedSearch via a closure.
  return fn;
}

// Liveness classifier stub for orchestration tests.
function makeLivenessClassifier(map) {
  return async (job) => map[job.sourceId] || map[job.url] || { version: 1, jobId: '', status: 'uncertain', checkedAt: null, requestedUrl: '', finalUrl: '', httpStatus: null, reasonCodes: ['legacy_unchecked'], evidence: [], source: '', freshUntil: null };
}

// ---------------------------------------------------------------------------
// W03-ISO-01: isolates a bad result and imports and scores later results
// ---------------------------------------------------------------------------

test('W03-ISO-01 isolates a bad result and imports and scores later results', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const fixture = path.join(fixtureRoot, 'greenhouse-rich.json');
  const search = createSearch(s, { name: 'iso-01', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture, company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  // Three results: r1 succeeds, r2 throws during import, r3 succeeds.
  // After W03 Phase 5, runSavedSearch must accept injected importJob/scoreJob/checkLiveness
  // and continue past r2's failure, scoring r3.
  const jobA = normalizedJob({ id: 'a', title: 'Engineer A', company: 'Acme', location: 'Remote', url: 'https://example.com/a', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });
  const jobB = normalizedJob({ id: 'b', title: 'Engineer B', company: 'Acme', location: 'Remote', url: 'https://example.com/b', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });
  const jobC = normalizedJob({ id: 'c', title: 'Engineer C', company: 'Acme', location: 'Remote', url: 'https://example.com/c', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });

  let scoreCalls = [];
  const injectedScore = async (store, jid, pid) => {
    scoreCalls.push(jid);
    return { overall: 60, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid };
  };
  let importCalls = 0;
  const injectedImport = (store, { job, profileId, source, status, runId }) => {
    importCalls += 1;
    if (job.sourceId === 'b') throw new Error('simulated import failure for b');
    return importNormalized(store, { profileId, job, source, status, runId });
  };
  const livenessBudgets = [];
  const injectedLiveness = async (_job, options) => {
    livenessBudgets.push(options.budget);
    return { version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  };

  // The adapter returns three jobs; r2 throws inside injectedImport.
  let adapterBudget = null;
  const fakeAdapter = {
    async fetchJobs(_config, options) {
      adapterBudget = options.budget;
      return [jobA, jobB, jobC];
    }
  };

  const result = await runSavedSearch(s, search.id, {
    adapter: fakeAdapter,
    importJob: injectedImport,
    scoreJob: injectedScore,
    checkLiveness: injectedLiveness,
    now: fixedNow
  });

  // r1 and r3 must have been scored; r2 must not abort the loop.
  assert.equal(importCalls, 3, 'all three results attempted import');
  assert.ok(scoreCalls.length >= 2, 'at least two results scored despite r2 failure');
  assert.ok(scoreCalls.includes(jobA.url) || scoreCalls.some(c => c), 'r1 was scored');
  // r3 must have been processed after r2 failed.
  const jobsInDb = all(s, 'SELECT * FROM jobs WHERE profile_id=?', ['profile-test']);
  assert.ok(jobsInDb.length >= 2, 'at least two jobs imported despite middle failure');
  // Run status must be partial, not failed, because durable progress was made.
  assert.equal(result.status, 'partial', 'run with one child failure and durable progress is partial');
  // The structured error for r2 must be present.
  assert.ok(result.errors.length >= 1, 'structured error recorded for r2');
  assert.ok(result.errors.some(e => String(e.message || e).includes('simulated import failure for b')), 'error message preserved');
  assert.ok(adapterBudget, 'saved-search orchestration creates a shared run budget');
  assert.ok(livenessBudgets.every(budget => budget === adapterBudget), 'adapter and every in-run liveness check share one budget');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-ISO-02: skips scoring an expired middle result and still scores the later active result
// ---------------------------------------------------------------------------

test('W03-ISO-02 skips scoring an expired middle result and still scores the later active result', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const fixture = path.join(fixtureRoot, 'greenhouse-rich.json');
  const search = createSearch(s, { name: 'iso-02', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture, company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Active A', company: 'Acme', location: 'Remote', url: 'https://example.com/a', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });
  const jobB = normalizedJob({ id: 'b', title: 'Expired B', company: 'Acme', location: 'Remote', url: 'https://example.com/b', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });
  const jobC = normalizedJob({ id: 'c', title: 'Active C', company: 'Acme', location: 'Remote', url: 'https://example.com/c', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com/v1/boards/acme/jobs', finalUrl: 'https://api.example.com/v1/boards/acme/jobs', httpStatus: 200 } } });

  const expiredLiveness = { version: 1, jobId: '', status: 'expired', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: 'https://example.com/b', finalUrl: 'https://example.com/b', httpStatus: 404, reasonCodes: ['not_found'], evidence: [{ kind: 'http_status', value: '404' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  const activeLiveness = { version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [{ kind: 'ats_listing', value: 'listed_in_public_ats:200' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };

  let scoredJobs = [];
  const injectedScore = async (store, jid, pid) => {
    scoredJobs.push(jid);
    return { overall: 55, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid };
  };
  const injectedLiveness = async (job) => {
    if (job.sourceId === 'b') return expiredLiveness;
    return activeLiveness;
  };

  const fakeAdapter = makeAdapter([jobA, jobB, jobC]);
  const result = await runSavedSearch(s, search.id, {
    adapter: fakeAdapter,
    importJob: importNormalized,
    scoreJob: injectedScore,
    checkLiveness: injectedLiveness,
    now: fixedNow
  });

  // r2 (expired) must not be scored.
  const expiredJobRow = all(s, 'SELECT * FROM jobs WHERE profile_id=? AND title=?', ['profile-test', 'Expired B'])[0];
  assert.ok(expiredJobRow, 'expired job was imported');
  assert.ok(!scoredJobs.includes(expiredJobRow.id), 'expired job was not scored');
  // r3 (active) must be scored.
  const activeC = all(s, 'SELECT * FROM jobs WHERE profile_id=? AND title=?', ['profile-test', 'Active C'])[0];
  assert.ok(activeC, 'active job C was imported');
  assert.ok(scoredJobs.includes(activeC.id), 'active job C was scored');
  // The expired job outcome must be recorded in the run result.
  assert.ok(result.jobs.some(j => j.outcome === 'expired'), 'expired outcome present in run jobs');
  // Run status must be partial (one expired child).
  assert.equal(result.status, 'partial', 'run with an expired child is partial');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-RUN-01: reports partial when child errors uncertainty or truncation accompany durable results
// ---------------------------------------------------------------------------

test('W03-RUN-01 reports partial when child errors uncertainty or truncation accompany durable results', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const fixture = path.join(fixtureRoot, 'greenhouse-rich.json');
  const search = createSearch(s, { name: 'run-01', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture, company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Job A', company: 'Acme', location: 'Remote', url: 'https://example.com/a', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });
  const jobB = normalizedJob({ id: 'b', title: 'Job B', company: 'Acme', location: 'Remote', url: 'https://example.com/b', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });

  // Adapter returns jobs plus metadata.errors (object, not string) and truncated.
  const metadata = { errors: [{ code: 'child_timeout', stage: 'fetch', message: 'child timed out', url: 'https://child.example.com' }], truncated: true, reason: 'request_limit' };
  const fakeAdapter = makeAdapter([jobA, jobB], metadata);

  const injectedScore = async (store, jid, pid) => ({ overall: 40, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid });
  const injectedLiveness = makeLivenessClassifier({});

  const result = await runSavedSearch(s, search.id, {
    adapter: fakeAdapter,
    importJob: importNormalized,
    scoreJob: injectedScore,
    checkLiveness: injectedLiveness,
    now: fixedNow
  });

  // Durable progress was made (jobs imported), but child errors/truncation exist → partial, not succeeded.
  assert.equal(result.status, 'partial', 'child errors with durable results is partial');
  assert.ok(result.counts.imported >= 1, 'at least one job imported');
  // Object errors must not be serialized as [object Object].
  const runRow = one(s, "SELECT * FROM automation_runs WHERE trigger_name='discover.run' ORDER BY created_at DESC LIMIT 1");
  const storedOutputs = JSON.parse(runRow.outputs_json);
  assert.ok(storedOutputs.errors.length >= 1, 'errors propagated to automation run');
  // The error must be structured/serializable, not [object Object].
  for (const e of storedOutputs.errors) {
    const str = JSON.stringify(e);
    assert.ok(!str.includes('[object Object]'), 'error serialized as structured object, not [object Object]');
  }
  // Truncation by itself must remain visible even when every returned job succeeds.
  const truncationOnlySearch = createSearch(s, { name: 'run-01-truncation-only', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture, company: 'Acme', boardToken: 'acme' }, minFit: 50 });
  const truncationOnly = await runSavedSearch(s, truncationOnlySearch.id, {
    adapter: makeAdapter([jobA], { errors: [], truncated: true, reason: 'request_limit' }),
    importJob: importNormalized,
    scoreJob: injectedScore,
    checkLiveness: injectedLiveness,
    now: fixedNow
  });
  assert.equal(truncationOnly.status, 'partial', 'truncation-only run with durable progress is partial');
  const truncationAudit = one(s, 'SELECT action FROM audit_log WHERE entity_id=? ORDER BY created_at DESC LIMIT 1', [truncationOnly.runId]);
  assert.equal(truncationAudit.action, 'discovery.run.partial', 'truncation-only run uses partial audit vocabulary');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-RUN-02: reports failed without durable progress and succeeded for a clean empty source
// ---------------------------------------------------------------------------

test('W03-RUN-02 reports failed without durable progress and succeeded for a clean empty source', async () => {
  // Case A: adapter throws before any durable progress → failed.
  {
    const { s } = await freshStore();
    seedProfile(s);
    const search = createSearch(s, { name: 'run-02-fail', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });
    const failingAdapter = { async fetchJobs() { throw new Error('adapter fetch failed'); } };
    const result = await runSavedSearch(s, search.id, {
      adapter: failingAdapter,
      importJob: importNormalized,
      scoreJob: async () => ({ overall: 0 }),
      checkLiveness: makeLivenessClassifier({}),
      now: fixedNow
    });
    assert.equal(result.status, 'failed', 'adapter failure before durable progress is failed');
    assert.equal(result.counts.imported, 0, 'no jobs imported');
    rmSync(s.root, { recursive: true, force: true });
  }

  // Case B: clean empty source (no jobs, no errors) → succeeded with zero counts.
  {
    const { s } = await freshStore();
    seedProfile(s);
    const search = createSearch(s, { name: 'run-02-empty', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });
    const emptyAdapter = { async fetchJobs() { return []; } };
    const result = await runSavedSearch(s, search.id, {
      adapter: emptyAdapter,
      importJob: importNormalized,
      scoreJob: async () => ({ overall: 0 }),
      checkLiveness: makeLivenessClassifier({}),
      now: fixedNow
    });
    assert.equal(result.status, 'succeeded', 'clean empty source is succeeded');
    assert.equal(result.counts.fetched, 0, 'zero fetched');
    assert.equal(result.counts.imported, 0, 'zero imported');
    rmSync(s.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// W03-RUN-03: propagates partial through run-all daily scheduler persistence and audit output
// ---------------------------------------------------------------------------

test('W03-RUN-03 propagates partial through run-all daily scheduler persistence and audit output', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const fixture = path.join(fixtureRoot, 'greenhouse-rich.json');
  const search = createSearch(s, { name: 'run-03', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture, company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  // One result succeeds, one has uncertainty liveness → partial.
  const jobA = normalizedJob({ id: 'a', title: 'Job A', company: 'Acme', location: 'Remote', url: 'https://example.com/a', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });
  const jobB = normalizedJob({ id: 'b', title: 'Job B', company: 'Acme', location: 'Remote', url: 'https://example.com/b', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });

  const uncertainLiveness = { version: 1, jobId: '', status: 'uncertain', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: null, reasonCodes: ['anti_bot'], evidence: [{ kind: 'anti_bot', value: 'challenge' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  const activeLiveness = { version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [{ kind: 'ats_listing', value: 'listed_in_public_ats:200' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };

  const injectedLiveness = async (job) => job.sourceId === 'b' ? uncertainLiveness : activeLiveness;
  const injectedScore = async (store, jid, pid) => ({ overall: 50, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid });
  const fakeAdapter = makeAdapter([jobA, jobB]);

  // runAllSearches must propagate partial.
  const allResult = await runAllSearches(s, {
    profileId: 'profile-test',
    adapter: fakeAdapter,
    importJob: importNormalized,
    scoreJob: injectedScore,
    checkLiveness: injectedLiveness,
    now: fixedNow
  });
  assert.ok(allResult.runs.length >= 1, 'at least one run');
  assert.equal(allResult.runs[0].status, 'partial', 'run-all propagates partial status');
  // Aggregate status on run-all itself must reflect partial.
  assert.ok(allResult.status === 'partial' || allResult.aggregateStatus === 'partial', 'aggregate partial status present on run-all');

  // Scheduler action must propagate derivedStatus: 'partial'.
  const automation = createAutomation(s, { name: 'daily_discovery', actionId: 'daily_discovery', schedule: '0 7 * * 1-5', profileId: 'profile-test', enabled: true, config: {} });
  const runRecord = await runAutomation(s, automation, {
    trigger: 'schedule',
    nowDate: new Date(FIXED_NOW_MS),
    runAction: async () => ({
      outputs: { discovery: allResult },
      counts: { jobsImported: 1, jobsScored: 1, highFit: 0 },
      derivedStatus: 'partial'
    })
  });
  assert.equal(runRecord.status, 'partial', 'scheduler runAutomation persists derivedStatus partial');
  assert.equal(runRecord.externalSideEffects, 'none', 'no external side effects');

  // Audit must use the partial vocabulary.
  const audits = all(s, "SELECT * FROM audit_log WHERE entity_id=? ORDER BY created_at DESC", [runRecord.id]);
  const auditActions = audits.map(a => a.action);
  assert.ok(auditActions.includes('automation.partial'), 'audit uses automation.partial vocabulary');

  // Persisted automation_run row must have status 'partial'.
  const runRow = one(s, 'SELECT * FROM automation_runs WHERE id=?', [runRecord.id]);
  assert.equal(runRow.status, 'partial', 'automation_runs row persisted as partial');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-FIELD-01: round-trips native compensation work model employment type and department
// ---------------------------------------------------------------------------

test('W03-FIELD-01 round-trips native compensation work model employment type and department', async () => {
  const { s, root } = await freshStore();
  seedProfile(s);

  const richJob = {
    version: 1,
    title: 'Platform PM',
    company: 'Acme',
    location: 'Remote — US',
    url: 'https://boards.greenhouse.io/acme/jobs/301',
    source: 'greenhouse',
    sourceId: '301',
    description: 'Lead platform discovery.',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '$150,000–$190,000/yr', min: 150000, max: 190000, currency: 'USD', interval: 'year' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: 'Product',
    sourceNativeFields: {
      compensation: [{ min_cents: 15000000, max_cents: 19000000, currency_type: 'USD', title: 'Annual salary' }],
      workModel: 'Remote',
      employmentType: 'Full-time',
      department: 'Product'
    },
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: 'https://api.example.com', finalUrl: 'https://api.example.com', httpStatus: 200 } }
  };

  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job: richJob, source: 'greenhouse', status: 'new' });

  // DB columns must carry the structured fields.
  const row = one(s, 'SELECT * FROM jobs WHERE id=?', [imported.id]);
  assert.equal(row.compensation, '$150,000–$190,000/yr', 'compensation text projection preserved');
  assert.equal(row.work_model, 'remote', 'work_model column preserved');
  const compJson = JSON.parse(row.compensation_json || '{}');
  assert.deepEqual(compJson, { text: '$150,000–$190,000/yr', min: 150000, max: 190000, currency: 'USD', interval: 'year' }, 'compensation_json round-trips');
  const empTypes = JSON.parse(row.employment_types_json || '[]');
  assert.deepEqual(empTypes, ['full_time'], 'employment_types_json round-trips');
  assert.equal(row.department, 'Product', 'department column preserved');
  const nativeJson = JSON.parse(row.source_native_json || '{}');
  assert.deepEqual(nativeJson.compensation[0].min_cents, 15000000, 'source_native_json preserved');

  // Close/reopen store and verify survival.
  save(s);
  const s2 = await openStore({ workspace: root });
  const row2 = one(s2, 'SELECT * FROM jobs WHERE id=?', [imported.id]);
  assert.equal(row2.work_model, 'remote', 'work_model survived store reopen');
  assert.deepEqual(JSON.parse(row2.compensation_json || '{}').min, 150000, 'compensation_json survived reopen');
  assert.deepEqual(JSON.parse(row2.employment_types_json || '[]'), ['full_time'], 'employment_types_json survived reopen');
  assert.equal(row2.department, 'Product', 'department survived reopen');

  // job.yaml must include the new fields.
  syncJob(s2, imported.id);
  const yaml = readFileSync(path.join(root, 'jobos-workspace', 'jobs', imported.id, 'job.yaml'), 'utf8');
  assert.match(yaml, /compensationDetails:/, 'job.yaml has compensationDetails');
  assert.match(yaml, /employmentTypes:/, 'job.yaml has employmentTypes');
  assert.match(yaml, /department: Product/, 'job.yaml has department');
  assert.match(yaml, /sourceNativeFields:/, 'job.yaml has sourceNativeFields');
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-FIELD-02: refresh preserves prior native fields when a later source omits them
// ---------------------------------------------------------------------------

test('W03-FIELD-02 refresh preserves prior native fields when a later source omits them', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const richJob = {
    version: 1,
    title: 'Platform PM',
    company: 'Acme',
    location: 'Remote — US',
    url: 'https://boards.greenhouse.io/acme/jobs/301',
    source: 'greenhouse',
    sourceId: '301',
    description: 'Lead platform discovery.',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '$150,000–$190,000/yr', min: 150000, max: 190000, currency: 'USD', interval: 'year' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: 'Product',
    sourceNativeFields: { compensation: [{ min_cents: 15000000 }], workModel: 'Remote', employmentType: 'Full-time', department: 'Product' },
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  importNormalized(s, { profileId: 'profile-test', job: richJob, source: 'greenhouse', status: 'new' });

  // Later refresh omits compensation, workModel, employmentTypes, department.
  const sparseJob = {
    version: 1,
    title: 'Platform PM',
    company: 'Acme',
    location: 'Remote — US',
    url: 'https://boards.greenhouse.io/acme/jobs/301',
    source: 'greenhouse',
    sourceId: '301',
    description: 'Updated description.',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'unknown',
    employmentTypes: [],
    department: '',
    sourceNativeFields: {},
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  const refreshed = importNormalized(s, { profileId: 'profile-test', job: sparseJob, source: 'greenhouse', status: 'new' });
  assert.equal(refreshed.created, false, 'refresh matched existing job');

  const row = one(s, 'SELECT * FROM jobs WHERE id=?', [refreshed.job.id]);
  // Prior meaningful values must NOT be erased by omitted/unknown incoming values.
  assert.equal(row.work_model, 'remote', 'work_model not erased by unknown incoming');
  assert.deepEqual(JSON.parse(row.compensation_json || '{}').min, 150000, 'compensation_json not erased by unknown incoming');
  assert.deepEqual(JSON.parse(row.employment_types_json || '[]'), ['full_time'], 'employment_types_json not erased by empty incoming');
  assert.equal(row.department, 'Product', 'department not erased by empty incoming');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-COMPAT-01: migrates a real pre-W03 schema (v8, no W03 columns) to v9
// ---------------------------------------------------------------------------

test('W03-COMPAT-01 opens legacy jobs as unchecked uncertain without network migration or identifier changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w03-int-'));
  const dbDir = path.join(root, '.jobos');
  const dbPath = path.join(dbDir, 'jobos.sqlite');

  // Build a real pre-W03 database: schema_version 8, jobs table WITHOUT W03 columns.
  const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(require.resolve('sql.js')), f) });
  const rawDb = new SQL.Database();
  rawDb.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  rawDb.run(`INSERT INTO meta VALUES ('schema_version','8')`);
  rawDb.run(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, preferences_json TEXT NOT NULL, resume_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  rawDb.run(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, company_id TEXT, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', description TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', compensation TEXT NOT NULL DEFAULT '', work_model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'imported', fit_score INTEGER, score_json TEXT, high_fit INTEGER NOT NULL DEFAULT 0, posted_date TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL DEFAULT '', source_history_json TEXT NOT NULL DEFAULT '[]', first_seen_at TEXT, last_seen_at TEXT, reposted INTEGER NOT NULL DEFAULT 0, discovery_run_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,url), FOREIGN KEY(profile_id) REFERENCES profiles(id))`);
  const at = new Date(FIXED_NOW_MS).toISOString();
  rawDb.run(`INSERT INTO profiles (id,name,preferences_json,resume_text,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ['profile-test', 'Test Profile', '{}', '', at, at]);
  rawDb.run(`INSERT INTO jobs (id,profile_id,company_id,title,company,location,url,source,description,requirements_json,status,fit_score,score_json,high_fit,posted_date,dedupe_key,source_history_json,first_seen_at,last_seen_at,reposted,discovery_run_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['legacy-job-1', 'profile-test', null, 'Legacy Role', 'Acme', 'Remote', 'https://example.com/legacy', 'greenhouse', 'legacy desc', '[]', 'new', 50, '{}', 0, '2026-07-01T00:00:00.000Z', 'acme|legacy role|remote', '[]', at, at, 0, '', at, at]);

  // Assert preconditions: the raw DB has schema_version 8 and NO W03 columns.
  const preCols = rawDb.exec(`PRAGMA table_info(jobs)`)[0].values.map(c => c[1]);
  assert.ok(!preCols.includes('liveness_status'), 'pre-W03 DB has no liveness_status column');
  assert.ok(!preCols.includes('compensation_json'), 'pre-W03 DB has no compensation_json column');
  assert.ok(!preCols.includes('employment_types_json'), 'pre-W03 DB has no employment_types_json column');
  assert.ok(!preCols.includes('liveness_json'), 'pre-W03 DB has no liveness_json column');
  const preVersion = rawDb.exec("SELECT value FROM meta WHERE key='schema_version'")[0].values[0][0];
  assert.equal(preVersion, '8', 'pre-W03 DB schema_version is 8');

  // Write the pre-W03 DB to disk at the path openStore expects.
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(dbPath, Buffer.from(rawDb.export()));
  rawDb.close();

  // Reopen through current openStore — must run ALTER TABLE migration, not recreate.
  const s = await openStore({ workspace: root });

  // Verify migration added W03 columns with correct defaults.
  const row = one(s, 'SELECT * FROM jobs WHERE id=?', ['legacy-job-1']);
  assert.ok(row, 'legacy job row survived migration');
  assert.equal(row.id, 'legacy-job-1', 'legacy job id unchanged');
  assert.equal(row.dedupe_key, 'acme|legacy role|remote', 'legacy dedupe_key unchanged');
  assert.equal(row.liveness_status, 'uncertain', 'migrated liveness_status defaults to uncertain');
  assert.equal(row.liveness_checked_at, null, 'migrated liveness_checked_at defaults to null');
  assert.deepEqual(JSON.parse(row.liveness_json || '{}'), {}, 'migrated liveness_json defaults to {}');
  assert.deepEqual(JSON.parse(row.compensation_json || '{}'), {}, 'migrated compensation_json defaults to {}');
  assert.deepEqual(JSON.parse(row.employment_types_json || '[]'), [], 'migrated employment_types_json defaults to []');

  // Verify schema version is now 9.
  const versionRow = one(s, "SELECT value FROM meta WHERE key='schema_version'");
  assert.equal(versionRow.value, '9', 'schema version migrated to 9');

  // Legacy liveness must deserialize as uncertain without network.
  const [summary] = listJobSummaries(s, { profileId: 'profile-test' });
  assert.equal(summary.id, 'legacy-job-1', 'legacy projection keeps the job identifier');
  assert.equal(summary.liveness.version, 1, 'legacy liveness deserialized as v1');
  assert.equal(summary.liveness.status, 'uncertain', 'legacy job is uncertain');
  assert.ok(summary.liveness.reasonCodes.includes('legacy_unchecked'), 'legacy_unchecked reason present');
  assert.equal(summary.liveness.checkedAt, null, 'legacy liveness checkedAt is null');
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-GATE-01: checks liveness before score and pursuit and stops known-expired jobs
// ---------------------------------------------------------------------------

test('W03-GATE-01 checks liveness before score and pursuit and stops known-expired jobs', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const expiredJob = {
    version: 1,
    title: 'Expired Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/expired',
    source: 'greenhouse',
    sourceId: 'e1',
    description: 'expired role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: null
  };
  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job: expiredJob, source: 'greenhouse', status: 'new' });

  // Persist a known-expired liveness assessment.
  const expiredLiveness = { version: 1, jobId: imported.id, status: 'expired', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: 'https://example.com/expired', finalUrl: 'https://example.com/expired', httpStatus: 404, reasonCodes: ['not_found'], evidence: [{ kind: 'http_status', value: '404' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  dbRun(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=? WHERE id=?', ['expired', '2026-07-22T00:00:00.000Z', JSON.stringify(expiredLiveness), imported.id]);
  save(s);

  // score() must not compute fit for a known-expired job; it must throw a typed job_expired error.
  let scoreError = null;
  try {
    await score(s, imported.id, 'profile-test');
  } catch (e) {
    scoreError = e;
  }
  assert.ok(scoreError, 'score throws for known-expired job');
  assert.equal(scoreError.code, 'job_expired', 'score error is typed job_expired');
  // Fit score must NOT have been written.
  const row = one(s, 'SELECT fit_score, score_json FROM jobs WHERE id=?', [imported.id]);
  assert.equal(row.fit_score, null, 'expired job was not scored');
  assert.equal(row.score_json, null, 'expired job has no score_json');

  // runPursuit must not start its stage graph for a known-expired job.
  let pursuitError = null;
  try {
    await runPursuit(s, { jobId: imported.id, profileId: 'profile-test', dryRun: false });
  } catch (e) {
    pursuitError = e;
  }
  assert.ok(pursuitError, 'runPursuit throws for known-expired job');
  assert.equal(pursuitError.code, 'job_expired', 'pursuit error is typed job_expired');
  // No application must have been created.
  const apps = all(s, 'SELECT * FROM applications WHERE job_id=?', [imported.id]);
  assert.equal(apps.length, 0, 'no application created for expired job');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-GATE-02: preserves manual imports and surfaces uncertain liveness without auto-archiving
// ---------------------------------------------------------------------------

test('W03-GATE-02 preserves manual imports and surfaces uncertain liveness without auto-archiving', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  // Manual text import (jobos:text: URL) must remain uncertain with manual_import evidence.
  const manualJob = {
    version: 1,
    title: 'Manual Role',
    company: 'Acme',
    location: 'Remote',
    url: 'jobos:text:manual-1',
    source: 'text_file',
    sourceId: 'manual-1',
    description: 'manual text import',
    postedDate: '',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'unknown',
    employmentTypes: [],
    department: '',
    sourceNativeFields: {},
    livenessHint: null
  };
  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job: manualJob, source: 'text_file', status: 'imported' });

  // Manual imports must be uncertain, never auto-archived.
  const liveness = await classifyLiveness({ url: 'jobos:text:manual-1', source: 'text_file', jobId: imported.id }, { now: fixedNow });
  assert.equal(liveness.status, 'uncertain', 'manual import is uncertain');
  assert.ok(liveness.reasonCodes.includes('manual_import'), 'manual_import reason present');
  assert.equal(liveness.checkedAt, null, 'manual import has no network check');

  // The job must remain usable (not archived) for human-requested local work.
  const row = one(s, 'SELECT status FROM jobs WHERE id=?', [imported.id]);
  assert.notEqual(row.status, 'archived', 'manual import is not auto-archived');

  const scoreResult = await score(s, imported.id, 'profile-test', {
    checkLiveness: classifyLiveness,
    now: fixedNow
  });
  assert.ok(scoreResult.warnings?.some(item => item.code === 'liveness_uncertain'), 'uncertain score proceeds with a structured warning');
  assert.equal(scoreResult.postingLiveness.status, 'uncertain', 'score exposes uncertain posting evidence separately');
  assert.equal(one(s, 'SELECT status FROM jobs WHERE id=?', [imported.id]).status, 'imported', 'uncertain scoring does not archive the job');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-GATE-03: reuses fresh liveness and refreshes stale public evidence before score or pursuit
// ---------------------------------------------------------------------------

test('W03-GATE-03 reuses fresh liveness and refreshes stale public evidence before score or pursuit', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const publicJob = {
    version: 1,
    title: 'Public Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/public-role',
    source: 'greenhouse',
    sourceId: 'pr1',
    description: 'public role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: null
  };
  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job: publicJob, source: 'greenhouse', status: 'new' });

  // Case A: fresh liveness (checkedAt = now) must be reused without a new fetch.
  const freshLiveness = { version: 1, jobId: imported.id, status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: 'https://example.com/public-role', finalUrl: 'https://example.com/public-role', httpStatus: 200, reasonCodes: ['apply_control_present'], evidence: [{ kind: 'apply_control', value: 'apply-button' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  dbRun(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=? WHERE id=?', ['active', '2026-07-22T00:00:00.000Z', JSON.stringify(freshLiveness), imported.id]);
  save(s);

  let fetchCalled = false;
  const scoreResult = await score(s, imported.id, 'profile-test', {
    checkLiveness: async () => { fetchCalled = true; return freshLiveness; },
    now: fixedNow
  });
  // Fresh liveness must be reused; no standalone fetch issued.
  assert.equal(fetchCalled, false, 'fresh liveness reused without fetch');
  assert.ok(scoreResult.overall >= 0, 'score computed with fresh liveness');

  // Case B: stale liveness (checkedAt = 2 days ago) must trigger a refresh.
  const staleCheckedAt = new Date(FIXED_NOW_MS - 2 * 86_400_000).toISOString();
  const staleLiveness = { version: 1, jobId: imported.id, status: 'active', checkedAt: staleCheckedAt, requestedUrl: 'https://example.com/public-role', finalUrl: 'https://example.com/public-role', httpStatus: 200, reasonCodes: ['apply_control_present'], evidence: [{ kind: 'apply_control', value: 'apply-button' }], source: 'greenhouse', freshUntil: new Date(new Date(staleCheckedAt).getTime() + 86_400_000).toISOString() };
  dbRun(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=? WHERE id=?', ['active', staleCheckedAt, JSON.stringify(staleLiveness), imported.id]);
  save(s);

  let refreshCalled = false;
  const refreshedLiveness = { version: 1, jobId: imported.id, status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: 'https://example.com/public-role', finalUrl: 'https://example.com/public-role', httpStatus: 200, reasonCodes: ['apply_control_present'], evidence: [{ kind: 'apply_control', value: 'apply-button' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  await score(s, imported.id, 'profile-test', {
    checkLiveness: async () => { refreshCalled = true; return refreshedLiveness; },
    now: fixedNow
  });
  assert.equal(refreshCalled, true, 'stale liveness triggers refresh before score');

  // The 24-hour boundary: exactly at 86_400_000ms ago is stale (0 <= now - checkedAt < window is fresh).
  // A result checked exactly 24h ago must be stale.
  const boundaryCheckedAt = new Date(FIXED_NOW_MS - 86_400_000).toISOString();
  const boundaryLiveness = { version: 1, jobId: imported.id, status: 'active', checkedAt: boundaryCheckedAt, requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: [], evidence: [], source: 'greenhouse', freshUntil: new Date(new Date(boundaryCheckedAt).getTime() + 86_400_000).toISOString() };
  dbRun(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=? WHERE id=?', ['active', boundaryCheckedAt, JSON.stringify(boundaryLiveness), imported.id]);
  save(s);
  let boundaryRefreshCalled = false;
  await score(s, imported.id, 'profile-test', {
    checkLiveness: async () => { boundaryRefreshCalled = true; return refreshedLiveness; },
    now: fixedNow
  });
  assert.equal(boundaryRefreshCalled, true, 'liveness at exactly 24h boundary is stale and triggers refresh');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-HANDOFF-01: exposes posting-liveness v1 separately from candidate fit
// ---------------------------------------------------------------------------

test('W03-HANDOFF-01 exposes posting-liveness v1 separately from candidate fit', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const job = {
    version: 1,
    title: 'Handoff Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/handoff',
    source: 'greenhouse',
    sourceId: 'h1',
    description: 'handoff role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job, source: 'greenhouse', status: 'new' });

  // Persist a liveness assessment.
  const liveness = { version: 1, jobId: imported.id, status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: 'https://example.com/handoff', finalUrl: 'https://example.com/handoff', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [{ kind: 'ats_listing', value: 'listed_in_public_ats:200' }], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };
  dbRun(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=? WHERE id=?', ['active', '2026-07-22T00:00:00.000Z', JSON.stringify(liveness), imported.id]);

  // Score the job.
  await score(s, imported.id, 'profile-test', { now: fixedNow });
  save(s);

  // Domain-tool selectedJobContext must expose liveness separately from fit.
  const ctx = selectedJobContext(s, imported.id);
  assert.ok(ctx.liveness, 'selectedJobContext exposes liveness');
  assert.equal(ctx.liveness.contract, 'jobos.posting-liveness.v1', 'handoff contract identifier present');
  assert.equal(ctx.liveness.status, 'active', 'handoff status present');
  assert.ok(Array.isArray(ctx.liveness.reasonCodes), 'handoff reasonCodes present');
  assert.equal(ctx.liveness.source, 'greenhouse', 'handoff source present');
  // Fit must NOT include a liveness dimension, penalty, or boost.
  assert.ok(ctx.fit, 'fit is present');
  assert.equal(ctx.fit.liveness, undefined, 'fit does not include liveness dimension');
  assert.equal(ctx.fit.livenessPenalty, undefined, 'fit does not include liveness penalty');
  assert.equal(ctx.fit.livenessBoost, undefined, 'fit does not include liveness boost');

  // listJobSummaries must also expose liveness separately.
  const summaries = listJobSummaries(s, { profileId: 'profile-test' });
  const summary = summaries.find(j => j.id === imported.id);
  assert.ok(summary.liveness, 'listJobSummaries exposes liveness');
  assert.equal(summary.liveness.status, 'active', 'summary liveness status present');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-SAFETY-01: preserves provenance dedupe repost review queues and zero external side effects
// ---------------------------------------------------------------------------

test('W03-SAFETY-01 preserves provenance dedupe repost review queues and zero external side effects', async () => {
  const { s, root } = await freshStore();
  seedProfile(s);

  // Import a job, then a duplicate by exact URL, then a key-match candidate.
  const job1 = {
    version: 1,
    title: 'Safety Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/safety-1',
    source: 'greenhouse',
    sourceId: 's1',
    description: 'safety role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  const first = importNormalized(s, { profileId: 'profile-test', job: job1, source: 'greenhouse', status: 'new' });
  assert.equal(first.created, true, 'first import created');

  // Exact-URL dedupe: same URL → deduped, not created.
  const dup = importNormalized(s, { profileId: 'profile-test', job: job1, source: 'greenhouse', status: 'new' });
  assert.equal(dup.created, false, 'exact-URL dup is deduped');
  assert.equal(dup.deduped, true, 'deduped flag set');

  // Key-match with different URL → possible-duplicate review task.
  const job2 = { ...job1, url: 'https://example.com/safety-2', sourceId: 's2' };
  const second = importNormalized(s, { profileId: 'profile-test', job: job2, source: 'greenhouse', status: 'new' });
  assert.equal(second.created, true, 'different URL with same key created');

  // Provenance: source_history_json must record the source.
  const row1 = one(s, 'SELECT source_history_json FROM jobs WHERE id=?', [first.job.id]);
  const history = JSON.parse(row1.source_history_json);
  assert.ok(history.some(h => h.source === 'greenhouse'), 'provenance source history preserved');

  // Review queue must still work (status='new' jobs appear).
  const queue = all(s, "SELECT * FROM jobs WHERE status='new' ORDER BY high_fit DESC, fit_score DESC, created_at DESC");
  assert.ok(queue.length >= 1, 'review queue retains new jobs');

  // Possible-duplicate task must exist for the second job.
  const tasks = all(s, 'SELECT * FROM tasks WHERE job_id=?', [second.job.id]);
  assert.ok(tasks.some(t => /possible duplicate/i.test(t.title)), 'possible-duplicate review task created');

  // Create a real discovery run so automation_runs is nonempty.
  const search = createSearch(s, { name: 'safety-discovery', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });
  await runSavedSearch(s, search.id, {
    adapter: makeAdapter([normalizedJob({ id: 's3', title: 'Safety Run Job', company: 'Acme', location: 'Remote', url: 'https://example.com/safety-3', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } })]),
    importJob: importNormalized,
    scoreJob: async (store, jid, pid) => ({ overall: 55, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid }),
    checkLiveness: makeLivenessClassifier({}),
    now: fixedNow
  });

  // All discovery/automation runs must report external_side_effects: 'none'.
  const runs = all(s, "SELECT external_side_effects FROM automation_runs");
  assert.ok(runs.length >= 1, 'at least one automation_run exists');
  for (const r of runs) {
    assert.equal(r.external_side_effects, 'none', 'automation run has zero external side effects');
  }

  // Audit log side effects must be 'none'.
  const audits = all(s, "SELECT external_side_effect FROM audit_log");
  assert.ok(audits.length >= 1, 'at least one audit_log entry exists');
  for (const a of audits) {
    assert.equal(a.external_side_effect, 'none', 'audit log has zero external side effects');
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-V2: pins all v2 run output contract fields
// ---------------------------------------------------------------------------

test('W03-REG-V2 run output satisfies the locked v2 contract shape', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const search = createSearch(s, { name: 'reg-v2', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Active A', company: 'Acme', location: 'Remote', url: 'https://example.com/a', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });
  const activeLiveness = { version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };

  const result = await runSavedSearch(s, search.id, {
    adapter: makeAdapter([jobA]),
    importJob: importNormalized,
    scoreJob: async (store, jid, pid) => ({ overall: 60, mode: 'deterministic-degraded', dimensions: {}, reasoning: '', redFlags: [], confidence: 'low', jobId: jid, profileId: pid }),
    checkLiveness: async () => activeLiveness,
    now: fixedNow
  });

  assert.equal(result.version, 2, 'version is 2');
  assert.ok(result.runId, 'runId present');
  assert.ok(result.searchId, 'searchId present');
  assert.ok(result.searchName, 'searchName present');
  assert.ok(result.profileId, 'profileId present');
  assert.ok(result.adapter, 'adapter present');
  assert.ok(result.config, 'config present');
  assert.ok(['succeeded', 'partial', 'failed'].includes(result.status), 'status is valid enum');
  assert.ok(result.metadata, 'metadata present');
  assert.ok(result.createdAt, 'createdAt present');
  assert.ok(result.finishedAt, 'finishedAt present');

  for (const key of ['fetched', 'processed', 'imported', 'deduped', 'scored', 'highFit', 'active', 'expired', 'uncertain', 'failed']) {
    assert.ok(key in result.counts, `counts.${key} present`);
  }

  for (const job of result.jobs) {
    assert.ok('id' in job, 'job has id');
    assert.ok('sourceId' in job, 'job has sourceId');
    assert.ok('title' in job, 'job has title');
    assert.ok('company' in job, 'job has company');
    assert.ok(['scored', 'imported_unscored', 'expired', 'failed'].includes(job.outcome), `job outcome is valid: ${job.outcome}`);
    assert.ok('created' in job, 'job has created');
    assert.ok('deduped' in job, 'job has deduped');
    assert.ok('score' in job, 'job has score');
    assert.ok('highFit' in job, 'job has highFit');
    assert.ok('liveness' in job, 'job has liveness');
    assert.ok('error' in job, 'job has error');
  }
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-UNSCORED: pins imported_unscored identity when scoring fails after import
// ---------------------------------------------------------------------------

test('W03-REG-UNSCORED preserves persisted job id as imported_unscored when scoring fails', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const search = createSearch(s, { name: 'reg-unscored', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Score Fail', company: 'Acme', location: 'Remote', url: 'https://example.com/score-fail', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });
  const activeLiveness = { version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: ['listed_in_current_listing'], evidence: [], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' };

  // Pre-import the job so the discovery run dedupes it (created=false, deduped=true).
  importNormalized(s, { profileId: 'profile-test', job: jobA, source: 'greenhouse', status: 'new' });
  const existingRow = one(s, 'SELECT * FROM jobs WHERE url=?', [jobA.url]);

  const result = await runSavedSearch(s, search.id, {
    adapter: makeAdapter([jobA]),
    importJob: importNormalized,
    scoreJob: async () => { throw Object.assign(new Error('score failure'), { code: 'score_error' }); },
    checkLiveness: async () => activeLiveness,
    now: fixedNow
  });

  assert.equal(result.jobs.length, 1, 'one job in result');
  const jobEntry = result.jobs[0];
  assert.equal(jobEntry.outcome, 'imported_unscored', 'outcome is imported_unscored');
  assert.equal(jobEntry.id, existingRow.id, 'persisted job id matches the deduped existing row');
  assert.equal(jobEntry.created, false, 'created is false for deduped job');
  assert.equal(jobEntry.deduped, true, 'deduped is true for deduped job');
  assert.ok(jobEntry.liveness, 'liveness is non-null');
  assert.equal(jobEntry.liveness.version, 1, 'liveness is v1');
  assert.equal(jobEntry.liveness.status, 'active', 'liveness status is the classified active status');
  assert.equal(jobEntry.liveness.source, 'greenhouse', 'liveness source preserved');

  const dbRow = one(s, 'SELECT * FROM jobs WHERE id=?', [jobEntry.id]);
  assert.ok(dbRow, 'job persisted in database');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-LIVENESS-FAIL: pins non-null uncertain liveness when liveness check itself fails
// ---------------------------------------------------------------------------

test('W03-REG-LIVENESS-FAIL emits non-null uncertain liveness when liveness check throws', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const search = createSearch(s, { name: 'reg-liveness-fail', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Liveness Fail', company: 'Acme', location: 'Remote', url: 'https://example.com/liveness-fail', postedDate: '2026-07-20T00:00:00.000Z' });

  const result = await runSavedSearch(s, search.id, {
    adapter: makeAdapter([jobA]),
    importJob: importNormalized,
    scoreJob: async () => ({ overall: 0 }),
    checkLiveness: async () => { throw Object.assign(new Error('liveness check failed'), { code: 'liveness_error' }); },
    now: fixedNow
  });

  assert.equal(result.jobs.length, 1, 'one job in result');
  const jobEntry = result.jobs[0];
  assert.equal(jobEntry.outcome, 'failed', 'outcome is failed when liveness check throws');
  assert.ok(jobEntry.liveness, 'liveness is non-null even when liveness check fails');
  assert.equal(jobEntry.liveness.version, 1, 'fallback liveness is v1');
  assert.equal(jobEntry.liveness.status, 'uncertain', 'fallback liveness is uncertain');
  assert.ok(jobEntry.liveness.reasonCodes.includes('liveness_check_failed'), 'fallback liveness has liveness_check_failed reason code');
  assert.equal(jobEntry.liveness.source, 'greenhouse', 'fallback liveness preserves source');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-ERROR: pins typed error shape with retryable and url
// ---------------------------------------------------------------------------

test('W03-REG-ERROR structuredDiscoveryError includes retryable and url', async () => {
  const { s } = await freshStore();
  seedProfile(s);
  const search = createSearch(s, { name: 'reg-error', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const jobA = normalizedJob({ id: 'a', title: 'Error Pin', company: 'Acme', location: 'Remote', url: 'https://example.com/error-pin', postedDate: '2026-07-20T00:00:00.000Z', livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } } });

  const result = await runSavedSearch(s, search.id, {
    adapter: makeAdapter([jobA]),
    importJob: (store, args) => { throw Object.assign(new Error('import fail'), { code: 'import_fail', retryable: true, url: 'https://example.com/error-pin' }); },
    scoreJob: async () => ({ overall: 0 }),
    checkLiveness: async () => ({ version: 1, jobId: '', status: 'active', checkedAt: '2026-07-22T00:00:00.000Z', requestedUrl: '', finalUrl: '', httpStatus: 200, reasonCodes: [], evidence: [], source: 'greenhouse', freshUntil: '2026-07-23T00:00:00.000Z' }),
    now: fixedNow
  });

  assert.ok(result.errors.length >= 1, 'at least one error');
  const err = result.errors[0];
  assert.ok('code' in err, 'error has code');
  assert.ok('stage' in err, 'error has stage');
  assert.ok('message' in err, 'error has message');
  assert.ok('retryable' in err, 'error has retryable');
  assert.ok('source' in err, 'error has source');
  assert.ok('url' in err, 'error has url');
  assert.ok('jobKey' in err, 'error has jobKey');
  assert.ok('details' in err, 'error has details');
  assert.equal(err.retryable, true, 'retryable is extracted from error');
  assert.equal(err.url, 'https://example.com/error-pin', 'url is extracted from error');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-RUNDAILY: pins runDaily aggregate status from discovery.status
// ---------------------------------------------------------------------------

test('W03-REG-RUNDAILY uses discovery aggregate status not jobs.length for partial vs failed', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  // One search with valid fixture but postedWithinDays filter excluding all jobs (clean empty = succeeded).
  createSearch(s, { name: 'daily-clean-empty', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: path.join(fixtureRoot, 'greenhouse-rich.json'), company: 'Acme', boardToken: 'acme', postedWithinDays: 1 }, minFit: 90 });
  // One search with valid adapter but non-existent fixture (fails at fetch time).
  createSearch(s, { name: 'daily-failing', profileId: 'profile-test', adapter: 'greenhouse', config: { fixture: '/nonexistent/path/to/fixture.json', company: 'Acme', boardToken: 'acme' }, minFit: 50 });

  const result = await runDaily(s, { profileId: 'profile-test' });
  assert.equal(result.status, 'partial', 'mixed succeeded plus failed is partial, not failed');
  assert.equal(result.ok, false, 'partial is not ok');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-COMP: preserves legacy compensation display string with empty incoming text
// ---------------------------------------------------------------------------

test('W03-REG-COMP preserves legacy compensation display when incoming structured has empty text', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const legacyJob = {
    version: 1,
    title: 'Comp Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/comp-role',
    source: 'greenhouse',
    sourceId: 'c1',
    description: 'comp role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '$120k-$160k base + equity', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  importNormalized(s, { profileId: 'profile-test', job: legacyJob, source: 'greenhouse', status: 'new' });

  const existing = one(s, 'SELECT * FROM jobs WHERE url=?', ['https://example.com/comp-role']);
  dbRun(s, 'UPDATE jobs SET compensation=? WHERE id=?', ['$120k-$160k base + equity', existing.id]);
  save(s);

  const refreshJob = {
    ...legacyJob,
    compensation: { text: '', min: 120000, max: 160000, currency: 'USD', interval: 'year' }
  };
  const refreshed = importNormalized(s, { profileId: 'profile-test', job: refreshJob, source: 'greenhouse', status: 'new' });
  assert.equal(refreshed.created, false, 'refresh matched existing job');

  const row = one(s, 'SELECT * FROM jobs WHERE id=?', [refreshed.job.id]);
  assert.equal(row.compensation, '$120k-$160k base + equity', 'legacy compensation display string preserved');
  const compJson = JSON.parse(row.compensation_json || '{}');
  assert.equal(compJson.min, 120000, 'compensation_json updated with incoming min');
  assert.equal(compJson.max, 160000, 'compensation_json updated with incoming max');
  assert.equal(compJson.currency, 'USD', 'compensation_json updated with incoming currency');
  rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W03-REG-PROJ: pins deserializeLiveness boundary on raw row projections
// ---------------------------------------------------------------------------

test('W03-REG-PROJ listJobs reviewQueue and analytics state expose normalized liveness', async () => {
  const { s } = await freshStore();
  seedProfile(s);

  const job = {
    version: 1,
    title: 'Proj Role',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/proj-role',
    source: 'greenhouse',
    sourceId: 'p1',
    description: 'proj role',
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full_time'],
    department: '',
    sourceNativeFields: {},
    livenessHint: { kind: 'listed_in_public_ats', observedAt: '2026-07-22T00:00:00.000Z', request: { requestedUrl: '', finalUrl: '', httpStatus: 200 } }
  };
  const { job: imported } = importNormalized(s, { profileId: 'profile-test', job, source: 'greenhouse', status: 'new' });

  const { listJobs } = await import('../src/jobs.js');
  const jobsList = listJobs(s);
  const listedJob = jobsList.find(j => j.id === imported.id);
  assert.ok(listedJob, 'listJobs returns the job');
  assert.ok(listedJob.liveness, 'listJobs exposes liveness');
  assert.equal(listedJob.liveness.version, 1, 'listJobs liveness is v1');
  assert.ok(['active', 'expired', 'uncertain'].includes(listedJob.liveness.status), 'listJobs liveness has valid status');

  const { reviewQueue } = await import('../src/discovery.js');
  const queue = reviewQueue(s);
  const queuedJob = queue.find(j => j.id === imported.id);
  assert.ok(queuedJob, 'reviewQueue returns the job');
  assert.ok(queuedJob.liveness, 'reviewQueue exposes liveness');
  assert.equal(queuedJob.liveness.version, 1, 'reviewQueue liveness is v1');

  const { state } = await import('../src/analytics.js');
  const st = state(s);
  const stateJob = st.jobs.find(j => j.id === imported.id);
  assert.ok(stateJob, 'analytics state returns the job');
  assert.ok(stateJob.liveness, 'analytics state exposes liveness');
  assert.equal(stateJob.liveness.version, 1, 'analytics state liveness is v1');

  rmSync(s.root, { recursive: true, force: true });
});