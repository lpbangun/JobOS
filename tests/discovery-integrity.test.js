import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createDiscoveryBudget, DiscoveryLimitError, isBlockedIp, safeGet } from '../src/discovery/http.js';
import { ashby, careerPage, greenhouse, lever, matchesFilters, portfolio } from '../src/discovery/adapters.js';
import { classifyLiveness } from '../src/discovery/liveness.js';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'discovery-integrity');
const loadJson = name => JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8'));
const loadText = name => readFileSync(path.join(fixtureRoot, name), 'utf8');

function makeHeaders(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: key => normalized.get(String(key).toLowerCase()) ?? null };
}

function makeResponse(entry) {
  const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? '');
  return {
    status: Number(entry.status),
    ok: entry.ok ?? (Number(entry.status) >= 200 && Number(entry.status) < 300),
    headers: makeHeaders(entry.headers),
    async text() { return body; },
    async json() { return JSON.parse(body || 'null'); }
  };
}

function makeFetchQueue(entries, thrown = null) {
  const queue = entries.map(entry => ({ ...entry }));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (thrown) throw Object.assign(new Error(thrown.message), { name: thrown.name });
    if (!queue.length) throw new Error(`Unexpected fetch after ${calls.length - 1} queued response(s)`);
    return makeResponse(queue.shift());
  };
  return { fetch, calls, queue };
}

function makeClock(startMs = Date.parse('2026-07-22T00:00:00.000Z')) {
  let value = Number(startMs);
  const sleeps = [];
  return {
    now: () => value,
    sleep: async ms => { sleeps.push(ms); value += ms; },
    sleeps,
    advance: ms => { value += ms; }
  };
}

function makeLookup(hosts = {}) {
  const calls = [];
  const lookup = async hostname => {
    calls.push(hostname);
    const addresses = hosts[hostname] || ['8.8.8.8'];
    return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { lookup, calls };
}

function httpHarness(fixture, options = {}) {
  const clock = makeClock(options.nowMs ?? fixture.clock?.nowMs);
  const queue = makeFetchQueue(options.responses || fixture.responses || [], options.fetchThrows || fixture.fetchThrows || null);
  const dns = makeLookup(options.lookup || fixture.lookup || {});
  const budget = options.budget || createDiscoveryBudget({
    maxRequests: options.maxRequests ?? fixture.budget?.maxRequests ?? 90,
    totalTimeoutMs: options.totalTimeoutMs ?? 60_000,
    now: clock.now
  });
  const invoke = (url = fixture.url, extra = {}) => safeGet(url, {}, {
    fetch: queue.fetch,
    lookup: dns.lookup,
    sleep: clock.sleep,
    now: clock.now,
    budget,
    delayMs: 0,
    requestTimeoutMs: 10_000,
    ...extra
  });
  return { ...clock, ...queue, lookup: dns.lookup, lookupCalls: dns.calls, budget, invoke };
}

async function capturedError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject');
}

test('W03-HTTP-01 retries 429 and 503 within the shared request and time budgets', async () => {
  for (const name of ['retry-429-then-200.json', 'retry-503-then-200.json', 'retry-429-x2-then-200.json']) {
    const fixture = loadJson(name);
    const h = httpHarness(fixture);
    const result = await h.invoke();
    assert.equal(result.status, 200, name);
    assert.equal(h.calls.length, fixture.responses.length, name);
    assert.equal(result.attempts, fixture.responses.length, name);
    assert.equal(h.budget.snapshot().requests, fixture.responses.length, name);
    assert.equal(h.lookupCalls.length, fixture.responses.length, `${name}: DNS is revalidated per attempt`);
  }

  const exhausted = loadJson('retry-429-x3-fail.json');
  const h = httpHarness(exhausted);
  const error = await capturedError(h.invoke);
  assert.equal(h.calls.length, 3);
  assert.equal(h.budget.snapshot().requests, 3);
  assert.equal(error.code, 'http_error');
  assert.equal(error.details.status, 429);
  assert.equal(error.details.attempts, 3);
});

test('W03-HTTP-02 honors safe Retry-After values and never retries early after an excessive delay', async () => {
  for (const [name, expectedSleep] of [
    ['retry-after-delta-safe.json', 2000],
    ['retry-after-imf-date-safe.json', 3000]
  ]) {
    const fixture = loadJson(name);
    const h = httpHarness(fixture);
    const result = await h.invoke();
    assert.equal(result.status, 200);
    assert.deepEqual(h.sleeps, [expectedSleep]);
    assert.equal(h.calls.length, 2);
  }

  for (const name of ['retry-after-excessive-delta.json', 'retry-after-excessive-date.json']) {
    const fixture = loadJson(name);
    const h = httpHarness(fixture);
    const error = await capturedError(h.invoke);
    assert.equal(error.code, 'retry_after_exceeds_limit');
    assert.ok(error.details.parsedDelayMs > 10_000);
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.calls.length, 1);
  }

  const insufficient = loadJson('retry-after-exceeds-remaining-budget.json');
  const h = httpHarness(insufficient, { totalTimeoutMs: 500 });
  const error = await capturedError(h.invoke);
  assert.equal(error.code, 'time_limit');
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.calls.length, 1);
});

test('W03-HTTP-03 falls back deterministically for invalid or past Retry-After values', async () => {
  const invalid = loadJson('retry-after-invalid.json');
  for (const header of invalid.invalidHeaders) {
    const responses = invalid.responses.map((entry, index) => index === 0
      ? { ...entry, headers: { ...entry.headers, 'retry-after': header } }
      : entry);
    const h = httpHarness(invalid, { responses });
    assert.equal((await h.invoke()).status, 200, header);
    assert.deepEqual(h.sleeps, [250], header);
  }

  const past = loadJson('retry-after-past.json');
  const pastHarness = httpHarness(past);
  assert.equal((await pastHarness.invoke()).status, 200);
  assert.deepEqual(pastHarness.sleeps, [250]);

  const twice = loadJson('retry-after-fallback-two-retries.json');
  const twiceHarness = httpHarness(twice);
  assert.equal((await twiceHarness.invoke()).status, 200);
  assert.deepEqual(twiceHarness.sleeps, [250, 500]);
});

test('W03-HTTP-04 never retries non-retryable HTTP statuses', async () => {
  const fixture = loadJson('non-retryable-statuses.json');
  for (const status of fixture.statuses) {
    const responses = fixture.template.map((entry, index) => ({
      ...entry,
      status: index === 0 ? status : entry.status,
      ok: index === 0 ? false : entry.ok
    }));
    const h = httpHarness(fixture, { responses });
    const error = await capturedError(h.invoke);
    assert.equal(h.calls.length, 1, String(status));
    assert.equal(h.queue.length, 1, String(status));
    assert.deepEqual(h.sleeps, [], String(status));
    assert.equal(error.code, 'http_error');
    assert.equal(error.retryable, false);
    assert.equal(error.details.status, status);
  }
});

test('W03-HTTP-05 preserves credential DNS SSRF redirect timeout and request-budget controls across retries', async () => {
  const credentialed = loadJson('credentialed-url.case.json');
  const credentialHarness = httpHarness(credentialed);
  const credentialError = await capturedError(credentialHarness.invoke);
  assert.match(credentialError.message, /credentials/i);
  assert.equal(credentialHarness.calls.length, 0);

  const retry = loadJson('retry-429-then-200.json');
  const retryHarness = httpHarness(retry);
  await retryHarness.invoke();
  assert.equal(retryHarness.lookupCalls.length, 2);

  const privateRedirect = loadJson('redirect-private.json');
  const redirectHarness = httpHarness(privateRedirect);
  const redirectError = await capturedError(redirectHarness.invoke);
  assert.match(redirectError.message, /public host|non-public/i);
  assert.equal(redirectHarness.calls.length, 1);

  const publicRedirect = loadJson('redirect-public.json');
  const publicRedirectHarness = httpHarness(publicRedirect);
  const publicRedirectResult = await publicRedirectHarness.invoke();
  assert.equal(publicRedirectResult.finalUrl, 'https://careers.example.org/jobs/99');
  assert.equal(publicRedirectHarness.calls.length, 2);

  const blocked = loadJson('dns-blocked.json');
  const blockedHarness = httpHarness(blocked);
  const blockedError = await capturedError(blockedHarness.invoke);
  assert.match(blockedError.message, /non-public/i);
  assert.equal(blockedHarness.calls.length, 0);

  const timeout = loadJson('timeout.case.json');
  const timeoutHarness = httpHarness(timeout);
  await capturedError(timeoutHarness.invoke);
  assert.equal(timeoutHarness.calls.length, 1);
  assert.deepEqual(timeoutHarness.sleeps, []);

  const redirectLoop = httpHarness({
    url: 'https://example.com/jobs/1',
    responses: Array.from({ length: 7 }, (_, index) => ({
      status: 302,
      headers: { location: `https://example.com/jobs/${index + 2}` },
      body: '',
      ok: false
    }))
  });
  const loopError = await capturedError(redirectLoop.invoke);
  assert.equal(loopError.code, 'too_many_redirects');
  assert.equal(redirectLoop.calls.length, 6);

  const limitedFixture = loadJson('request-limit-queue.json');
  const limited = httpHarness(limitedFixture, { maxRequests: 2 });
  await limited.invoke();
  await limited.invoke();
  const limitError = await capturedError(limited.invoke);
  assert.equal(limitError.code, 'request_limit');
  assert.ok(limitError instanceof DiscoveryLimitError);
  assert.equal(limited.calls.length, 2);
});

test('W03-FILTER-01 applies deterministic recency filtering and rejects unknown dates only when requested', () => {
  const fixture = loadJson('jobs-dated-mixed.json');
  const now = () => fixture.clock.nowMs;
  assert.deepEqual(
    fixture.jobs.filter(job => matchesFilters(job, { postedWithinDays: 7 }, { now })).map(job => job.id),
    ['inside']
  );
  assert.deepEqual(
    fixture.jobs.filter(job => matchesFilters(job, {}, { now })).map(job => job.id),
    fixture.jobs.map(job => job.id)
  );
  assert.equal(matchesFilters({ ...fixture.jobs[0], postedDate: '2010-01-01T00:00:00Z' }, { postedWithinDays: 5000 }, { now }), false);
  assert.equal(matchesFilters(fixture.jobs[0], { postedWithinDays: 0 }, { now }), true);
});

test('W03-FILTER-02 combines remote and employment-type filters with existing keyword and location filters', () => {
  const fixture = loadJson('jobs-remote-types.json');
  const jobs = fixture.jobs;
  assert.ok(jobs.filter(job => matchesFilters(job, { remoteOnly: true })).every(job => job.workModel === 'remote'));
  assert.ok(jobs.filter(job => matchesFilters(job, { employmentTypes: ['full_time'] })).every(job => job.employmentTypes.includes('full_time')));
  assert.deepEqual(
    jobs.filter(job => matchesFilters(job, { employmentTypes: ['contract', 'internship'] })).map(job => job.id).sort(),
    ['rm-ct', 'rm-int'].sort()
  );
  assert.deepEqual(
    jobs.filter(job => matchesFilters(job, {
      keywords: ['product'],
      location: 'Remote',
      remoteOnly: true,
      employmentTypes: ['full_time']
    })).map(job => job.id),
    ['rm-ft']
  );
  assert.deepEqual(
    jobs.filter(job => matchesFilters(job, { keywords: ['product'], location: 'Remote' })).map(job => job.id),
    jobs.filter(job => /product/i.test(`${job.title} ${job.company} ${job.location} ${job.description}`) && /remote/i.test(job.location)).map(job => job.id)
  );
});

test('W03-LIVE-01 classifies current ATS listings and explicit apply controls as active', async () => {
  const atsFixture = loadJson('liveness-active-ats-listing.json');
  const atsFetch = makeFetchQueue([]);
  const ats = await classifyLiveness(atsFixture.input, { fetch: atsFetch.fetch, now: () => atsFixture.clock.nowMs });
  assert.equal(ats.status, 'active');
  assert.equal(ats.version, 1);
  assert.equal(ats.jobId, atsFixture.input.jobId);
  assert.ok(ats.evidence.some(item => item.kind === 'ats_listing'));
  assert.equal(atsFetch.calls.length, 0);
  assert.equal(ats.freshUntil, '2026-07-23T00:00:00.000Z');

  const applyHtml = loadText('liveness-active-apply.html');
  const applyFetch = makeFetchQueue([{ status: 200, body: applyHtml, ok: true }]);
  const clock = makeClock();
  const active = await classifyLiveness({ jobId: 'apply-job', source: 'career-page', url: 'https://example.com/jobs/99' }, {
    fetch: applyFetch.fetch,
    lookup: makeLookup().lookup,
    sleep: clock.sleep,
    now: clock.now,
    delayMs: 0
  });
  assert.equal(active.status, 'active');
  assert.ok(active.evidence.some(item => item.kind === 'apply_control'));
  assert.equal(applyFetch.calls.length, 1);
  const falsePositive = makeFetchQueue([{ status: 200, body: loadText('liveness-active-unfilled.html'), ok: true }]);
  const stillActive = await classifyLiveness({ jobId: 'unfilled', source: 'career-page', url: 'https://example.com/jobs/unfilled' }, {
    fetch: falsePositive.fetch,
    lookup: makeLookup().lookup,
    sleep: clock.sleep,
    now: clock.now,
    delayMs: 0
  });
  assert.equal(stillActive.status, 'active');
  assert.ok(stillActive.evidence.some(item => item.kind === 'apply_control'));

});

test('W03-LIVE-02 classifies closure status text and redirects away from a direct posting as expired', async () => {
  const clock = makeClock();
  for (const status of [404, 410]) {
    const queue = makeFetchQueue([{ status, body: status === 404 ? 'Not Found' : 'Gone', ok: false }]);
    const result = await classifyLiveness({ jobId: `job-${status}`, source: 'career-page', url: `https://example.com/jobs/${status}` }, {
      fetch: queue.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
    });
    assert.equal(result.status, 'expired');
    assert.ok(result.evidence.some(item => item.kind === 'http_status' && item.value === String(status)));
  }

  const closure = makeFetchQueue([{ status: 200, body: loadText('liveness-expired-closure-text.html'), ok: true }]);
  const closed = await classifyLiveness({ jobId: 'closed', source: 'career-page', url: 'https://example.com/jobs/closed' }, {
    fetch: closure.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
  });
  assert.equal(closed.status, 'expired');
  assert.ok(closed.evidence.some(item => item.kind === 'closure_text'));

  const redirectFixture = loadJson('liveness-expired-redirect-away.json');
  const redirected = makeFetchQueue(redirectFixture.responses);
  const redirectResult = await classifyLiveness(redirectFixture.input, {
    fetch: redirected.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
  });
  assert.equal(redirectResult.status, 'expired');
  assert.ok(redirectResult.evidence.some(item => item.kind === 'redirect'));
  assert.notEqual(redirectResult.requestedUrl, redirectResult.finalUrl);
});

test('W03-LIVE-03 classifies anti-bot rate-limit timeout and ambiguous pages as uncertain', async () => {
  const clock = makeClock();
  for (const name of [
    'liveness-uncertain-captcha.html',
    'liveness-uncertain-anti-bot.html',
    'liveness-uncertain-antibot-with-filled-language.html'
  ]) {
    const queue = makeFetchQueue([{ status: 200, body: loadText(name), ok: true }]);
    const result = await classifyLiveness({ jobId: name, source: 'career-page', url: `https://example.com/jobs/${name}` }, {
      fetch: queue.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
    });
    assert.equal(result.status, 'uncertain', name);
    assert.ok(result.evidence.some(item => item.kind === 'anti_bot'), name);
  }

  for (const status of [401, 403, 429, 503]) {
    const responses = Array.from({ length: status === 429 || status === 503 ? 3 : 1 }, () => ({ status, body: '', ok: false }));
    const queue = makeFetchQueue(responses);
    const result = await classifyLiveness({ jobId: `status-${status}`, source: 'career-page', url: `https://example.com/jobs/${status}` }, {
      fetch: queue.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
    });
    assert.equal(result.status, 'uncertain');
  }

  const timeout = makeFetchQueue([], { name: 'AbortError', message: 'The operation was aborted' });
  const timed = await classifyLiveness({ jobId: 'timeout', source: 'career-page', url: 'https://example.com/jobs/timeout' }, {
    fetch: timeout.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
  });
  assert.equal(timed.status, 'uncertain');
  assert.ok(timed.evidence.some(item => item.kind === 'transport_error'));

  const ambiguous = makeFetchQueue([{ status: 200, body: loadText('liveness-uncertain-generic-200.html'), ok: true }]);
  const generic = await classifyLiveness({ jobId: 'generic', source: 'career-page', url: 'https://example.com/jobs/generic' }, {
    fetch: ambiguous.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
  });
  assert.equal(generic.status, 'uncertain');
  const conflict = makeFetchQueue([{ status: 200, body: loadText('liveness-uncertain-conflict.html'), ok: true }]);
  const conflicted = await classifyLiveness({ jobId: 'conflict', source: 'career-page', url: 'https://example.com/jobs/conflict' }, {
    fetch: conflict.fetch, lookup: makeLookup().lookup, sleep: clock.sleep, now: clock.now, delayMs: 0
  });
  assert.equal(conflicted.status, 'uncertain');
  assert.ok(conflicted.evidence.some(item => item.kind === 'closure_text'));
  assert.ok(conflicted.evidence.some(item => item.kind === 'apply_control'));
  assert.ok(conflicted.reasonCodes.includes('conflicting_evidence'));

});

test('W03 Phase 2 normalizes source-native decision fields at every existing adapter boundary', async () => {
  const now = () => Date.parse('2026-07-22T00:00:00.000Z');
  const fixture = name => path.join(fixtureRoot, name);
  const [greenhouseJob] = await greenhouse.fetchJobs({ fixture: fixture('greenhouse-rich.json'), boardToken: 'acme', company: 'Acme' }, { now });
  assert.deepEqual(greenhouseJob.compensation, { text: '', min: 150000, max: 190000, currency: 'USD', interval: 'year' });
  assert.equal(greenhouseJob.workModel, 'remote');
  assert.deepEqual(greenhouseJob.employmentTypes, ['full_time']);
  assert.equal(greenhouseJob.department, 'Product');
  assert.equal(greenhouseJob.sourceNativeFields.compensation[0].min_cents, 15000000);
  assert.equal(greenhouseJob.livenessHint.kind, 'listed_in_public_ats');

  const [leverJob] = await lever.fetchJobs({ fixture: fixture('lever-rich.json'), company: 'acme' }, { now });
  assert.deepEqual(leverJob.compensation, { text: '', min: 160000, max: 200000, currency: 'USD', interval: 'year' });
  assert.equal(leverJob.workModel, 'hybrid');
  assert.deepEqual(leverJob.employmentTypes, ['full_time']);
  assert.equal(leverJob.department, 'Growth');

  const [ashbyJob] = await ashby.fetchJobs({ fixture: fixture('ashby-rich.json'), handle: 'acme' }, { now });
  assert.deepEqual(ashbyJob.compensation, { text: '', min: 90, max: 120, currency: 'USD', interval: 'hour' });
  assert.equal(ashbyJob.workModel, 'onsite');
  assert.deepEqual(ashbyJob.employmentTypes, ['contract']);
  assert.equal(ashbyJob.department, 'Operations');

  const [careerJob] = await careerPage.fetchJobs({ fixture: fixture('career-page-rich.html'), url: 'https://careers.example.com/jobs' }, { now });
  assert.deepEqual(careerJob.compensation, { text: '', min: 145000, max: 185000, currency: 'USD', interval: 'year' });
  assert.equal(careerJob.workModel, 'remote');
  assert.deepEqual(careerJob.employmentTypes, ['full_time']);
  assert.equal(careerJob.department, 'Research');
  assert.equal(careerJob.sourceNativeFields.compensation.value.unitText, 'YEAR');
  assert.equal(careerJob.livenessHint.kind, 'listed_on_career_page');
});

test('W03-HTTP-05 portfolio routing preserves shared request-limit identity and hard-stops without soft child errors', async () => {
  const rootHtml = '<a href="https://company.example.org">Example Co</a>';
  const companyHtml = '<a href="https://jobs.lever.co/example">Open roles</a>';
  const queue = makeFetchQueue([
    { status: 200, body: rootHtml, ok: true },
    { status: 200, body: companyHtml, ok: true }
  ]);
  const clock = makeClock();
  const budget = createDiscoveryBudget({ maxRequests: 2, totalTimeoutMs: 60_000, now: clock.now });
  const result = await portfolio.fetchJobs({ url: 'https://portfolio.example.com', maxCompanies: 30 }, {
    fetch: queue.fetch,
    lookup: makeLookup().lookup,
    sleep: clock.sleep,
    now: clock.now,
    budget,
    delayMs: 0
  });
  assert.equal(queue.calls.length, 2);
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.reason, 'request_limit');
  assert.deepEqual(result.metadata.errors, []);
});

// ---------------------------------------------------------------------------
// W03-REG-BUDGET: createDiscoveryBudget clamps direct/persisted config to hard maxima
// ---------------------------------------------------------------------------

test('W03-REG-BUDGET clamps over-limit config values to 90 requests and 60000ms', () => {
  const overBudget = createDiscoveryBudget({ maxRequests: 1_000_000, totalTimeoutMs: 3_600_000 });
  const snap = overBudget.snapshot();
  assert.equal(snap.maxRequests, 90, 'maxRequests clamped to 90');
  assert.ok(snap.remainingMs <= 60_000, 'totalTimeoutMs clamped to 60000');
});

// ---------------------------------------------------------------------------
// W03-REG-TESTNET1: isBlockedIp rejects 192.0.2.0/24 consistently with other doc ranges
// ---------------------------------------------------------------------------

test('W03-REG-TESTNET1 isBlockedIp rejects 192.0.2.0/24 (TEST-NET-1)', () => {
  assert.ok(isBlockedIp('192.0.2.0'), 'TEST-NET-1 start blocked');
  assert.ok(isBlockedIp('192.0.2.1'), 'TEST-NET-1 host blocked');
  assert.ok(isBlockedIp('192.0.2.255'), 'TEST-NET-1 end blocked');
  // Previously blocked ranges must remain blocked.
  assert.ok(isBlockedIp('198.51.100.1'), 'TEST-NET-2 still blocked');
  assert.ok(isBlockedIp('203.0.113.1'), 'TEST-NET-3 still blocked');
  // Non-reserved public IPs must NOT be blocked.
  assert.ok(!isBlockedIp('8.8.8.8'), 'public DNS not blocked');
  assert.ok(!isBlockedIp('1.2.3.4'), 'public IP not blocked');
});
