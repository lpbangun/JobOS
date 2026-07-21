import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { approveContact, createOutreachPlan, listContactPoints, listEmailPatterns, listPersonCandidates, promoteStakeholder, suppressContact } from '../src/research/contacts.js';
import { importNetworkCsv, mapReachableNetwork } from '../src/research/network.js';
import { draftOutreach } from '../src/outreach.js';
import { createResearchRun, executeResearchRun } from '../src/research/runs.js';

function fakeSearchServer(baseResults) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(url.searchParams.get('q') || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: baseResults }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}/search`,
    requests,
    close: () => new Promise(done => server.close(done))
  })));
}


function fakePageFetch(calls) {
  return async (rawUrl, options) => {
    calls.push(String(rawUrl));
    const url = new URL(rawUrl);
    if (url.hostname === '127.0.0.1') return fetch(rawUrl, options);
    const body = url.pathname.includes('team') || url.pathname === '/'
      ? `<!doctype html><html><head><title>Acme Learning Team</title></head><body>
          <section>
            <h2>Jane Doe</h2><p>Head of People — <a href="mailto:jane.doe@acme.test">jane.doe@acme.test</a></p>
            <h2>John Smith</h2><p>Product Lead — john.smith@acme.test</p>
            <h2>Maya Chen</h2><p>Head of Product</p>
            <p>For recruiting logistics, contact careers@acme.test.</p>
          </section>
        </body></html>`
      : '<html><head><title>Acme Learning</title></head><body>Acme Learning public page.</body></html>';
    return {
      ok: true,
      status: 200,
      url: rawUrl,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => body
    };
  };
}

function fakeAdapterServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/orgs/acmelearning/members') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ login: 'mayachen', html_url: 'https://github.com/mayachen' }]));
      return;
    }
    if (url.pathname === '/gdelt') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ articles: [{ title: 'Acme Learning launches product', url: 'https://news.example/acme', domain: 'news.example', seendate: '20260709T000000Z' }] }));
      return;
    }
    if (url.pathname === '/cdx') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([['urlkey', 'timestamp', 'original'], ['test', '20240101000000', 'https://acme.test/team']]));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(done => server.close(done))
  })));
}

function createFixtureStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-contacts-'));
  return openStore({ workspace: root }).then(s => {
    const profile = createProfile(s, 'PM EdTech').profile;
    const jobFile = path.join(root, 'job.md');
    writeFileSync(jobFile, 'Title: Product Manager\nCompany: Acme Learning\nLocation: Remote\n\nAcme Learning needs a PM for educator discovery.');
    const job = importText(s, { profileId: profile.id, filePath: jobFile }).job;
    run(s, 'UPDATE companies SET website=? WHERE id=?', ['https://acme.test', job.company_id]);
    save(s);
    return { root, s, profile, job };
  });
}

async function runContactResearch(s, { profile, job, fetchImpl, env, sources = ['public_web'] }) {
  const runId = createResearchRun(s, {
    profileId: profile.id,
    scope: 'job',
    jobId: job.id,
    depth: 'standard',
    sources
  });
  const runtimeEnv = {
    ...env,
    JOBOS_ALLOW_PRIVATE_HOSTS: 'true',
    JOBOS_DNS_FIXTURE_JSON: JSON.stringify({
      'acme.test': {
        mx: [{ exchange: 'mx.acme.test', priority: 10 }],
        txt: [['v=spf1 include:_spf.acme.test ~all']],
        ns: ['ns1.acme.test']
      }
    })
  };
  const result = await executeResearchRun(s, runId, { fetchImpl, env: runtimeEnv });
  return {
    ...result,
    path: path.join('jobs', job.id, 'research', 'contacts.md'),
    contacts: listContactPoints(s, { jobId: job.id }),
    personCandidates: listPersonCandidates(s, { jobId: job.id }),
    emailPatterns: listEmailPatterns(s, { companyId: job.company_id })
  };
}

test('contact discovery extracts public emails, infers patterns, records LinkedIn URLs, and approves contacts', async () => {
  const search = await fakeSearchServer([
    { title: 'Acme Learning Team', url: 'https://acme.test/team', snippet: 'Jane Doe Head of People and Maya Chen Head of Product at Acme Learning.' },
    { title: 'Maya Chen — Head of Product at Acme Learning', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product at Acme Learning.' }
  ]);
  try {
    const { root, s, profile: owner, job } = await createFixtureStore();
    const fetchCalls = [];
    const result = await runContactResearch(s, {
      profile: owner,
      job,
      fetchImpl: fakePageFetch(fetchCalls),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'true', JOBOS_SMTP_FIXTURE_JSON: JSON.stringify({ 'jane.doe@acme.test': 'smtp_accepts_rcpt', 'acme.test': 'smtp_inconclusive' }), JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4' }
    });
    assert.ok(result.contacts.length >= 5);
    assert.ok(fetchCalls.every(raw => !new URL(raw).hostname.endsWith('linkedin.com')), `LinkedIn should not be fetched: ${fetchCalls.join(', ')}`);
    const contacts = result.contacts;
    const jane = contacts.find(c => c.normalizedValue === 'jane.doe@acme.test');
    const generic = contacts.find(c => c.normalizedValue === 'careers@acme.test');
    const mayaCandidate = contacts.find(c => c.normalizedValue === 'maya.chen@acme.test');
    const profile = contacts.find(c => c.type === 'profile_url' && c.value.includes('linkedin.com/in/maya-chen'));
    assert.equal(jane.evidenceTier, 'A');
    assert.equal(jane.verificationStatus, 'exact_public');
    assert.equal(jane.checks.smtp.status, 'smtp_accepts_rcpt');
    assert.equal(jane.humanApproved, false);
    assert.equal(generic.type, 'generic_inbox');
    assert.equal(mayaCandidate.evidenceTier, 'C');
    assert.equal(mayaCandidate.verificationStatus, 'pattern_candidate');
    assert.equal(mayaCandidate.checks.generated, true);
    assert.equal(profile.evidenceTier, 'E');
    assert.equal(profile.checks.fetched, false);
    const pattern = result.emailPatterns.find(p => p.domain === 'acme.test' && p.pattern === 'first.last');
    assert.ok(pattern);
    assert.equal(pattern.supportCount, 2);
    const approved = approveContact(s, { contactId: mayaCandidate.id });
    assert.equal(approved.humanApproved, true);
    const maya = result.personCandidates.find(c => c.name === 'Maya Chen');
    assert.ok(maya);
    const promoted = promoteStakeholder(s, { candidateId: maya.id });
    assert.equal(promoted.name, 'Maya Chen');
    assert.ok(one(s, 'SELECT id FROM stakeholders WHERE id=?', [promoted.id]));
    const worksheet = readFileSync(path.join(root, 'jobos-workspace', result.path), 'utf8');
    assert.match(worksheet, /maya\.chen@acme\.test/);
    assert.match(worksheet, /Tier: C/);
    assert.match(worksheet, /JobOS created a local contact worksheet only/);
    assert.ok(all(s, 'SELECT id FROM source_observations WHERE job_id=?', [job.id]).length >= 2);
    assert.ok(one(s, 'SELECT id FROM audit_log WHERE action=?', ['research.contact.approved']));
  } finally {
    await search.close();
  }
});


test('network CSV import creates a local path ladder for a job', async () => {
  const { root, s, job } = await createFixtureStore();
  const csv = path.join(root, 'network.csv');
  writeFileSync(csv, 'from_type,from_id,to_type,to_id,edge_type,confidence,evidence\nprofile,user,company,Acme Learning,shared_school,high,Shared alumni group\n');
  const imported = importNetworkCsv(s, { filePath: csv });
  assert.equal(imported.count, 1);
  const mapped = mapReachableNetwork(s, { jobId: job.id });
  assert.equal(mapped.jobId, job.id);
  assert.ok(mapped.paths.some(p => p.pathStrength.includes('shared employer') || p.pathStrength.includes('shared investor') || p.pathStrength.includes('direct')));
  const content = readFileSync(path.join(root, 'jobos-workspace', mapped.path), 'utf8');
  assert.match(content, /Contact path ladder/);
  assert.match(content, /Shared alumni group/);
  assert.match(content, /did not access private accounts/);
});

test('outreach draft blocks unapproved and suppressed explicit email contacts', async () => {
  const search = await fakeSearchServer([
    { title: 'Acme Learning Team', url: 'https://acme.test/team', snippet: 'Jane Doe Head of People and Maya Chen Head of Product at Acme Learning.' },
    { title: 'Maya Chen — Head of Product at Acme Learning', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product at Acme Learning.' }
  ]);
  try {
    const { s, profile, job } = await createFixtureStore();
    const result = await runContactResearch(s, {
      profile,
      job,
      fetchImpl: fakePageFetch([]),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'false', JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4' }
    });
    const maya = result.personCandidates.find(c => c.name === 'Maya Chen');
    const promoted = promoteStakeholder(s, { candidateId: maya.id });
    const mayaContact = result.contacts.find(c => c.normalizedValue === 'maya.chen@acme.test');
    await assert.rejects(
      () => draftOutreach(s, { jobId: job.id, profileId: profile.id, stakeholderId: promoted.id, contactId: mayaContact.id }),
      /not human-approved/
    );
    approveContact(s, { contactId: mayaContact.id });
    const draft = await draftOutreach(s, { jobId: job.id, profileId: profile.id, stakeholderId: promoted.id, contactId: mayaContact.id });
    assert.match(draft.id, /^artifact_/);
    assert.ok(draft.warnings.some(w => /pattern candidate/.test(w)));
    suppressContact(s, { contactId: mayaContact.id, reason: 'test suppression' });
    await assert.rejects(
      () => draftOutreach(s, { jobId: job.id, profileId: profile.id, stakeholderId: promoted.id, contactId: mayaContact.id }),
      /suppressed/
    );
  } finally {
    await search.close();
  }
});

test('configured public adapters create reusable source observations', async () => {
  const search = await fakeSearchServer([
    { title: 'Acme Learning GitHub org', url: 'https://github.com/acme-learning', snippet: 'Acme Learning public engineering org.' }
  ]);
  const adapters = await fakeAdapterServer();
  try {
    const { s, profile, job } = await createFixtureStore();
    const result = await runContactResearch(s, {
      profile,
      job,
      sources: ['public_web', 'github', 'gdelt', 'wayback'],
      fetchImpl: fakePageFetch([]),
      env: {
        ...process.env,
        JOBOS_SMTP_PROBE: 'false',
        JOBOS_SEARCH_BASE_URL: search.baseUrl,
        JOBOS_RESEARCH_PAGE_LIMIT: '2',
        JOBOS_GITHUB_API_URL: adapters.baseUrl,
        JOBOS_GDELT_DOC_URL: `${adapters.baseUrl}/gdelt`,
        JOBOS_WAYBACK_CDX_URL: `${adapters.baseUrl}/cdx`
      }
    });
    assert.ok(result.warnings.every(warning => !/adapter failed|HTTP 404/.test(warning)), result.warnings.join('\n'));
    const providers = all(s, 'SELECT DISTINCT provider FROM source_observations WHERE job_id=?', [job.id]).map(row => row.provider);
    assert.ok(providers.includes('github'));
    assert.ok(providers.includes('gdelt'));
    assert.ok(providers.includes('wayback'));
    assert.ok(adapters.requests.includes('/orgs/acmelearning/members'));
    assert.ok(adapters.requests.includes('/gdelt'));
    assert.ok(adapters.requests.includes('/cdx'));
  } finally {
    await search.close();
    await adapters.close();
  }
});

test('createOutreachPlan ranks an approved pattern candidate, persists a plan, and emits an audit row', async () => {
  const search = await fakeSearchServer([
    { title: 'Acme Learning Team', url: 'https://acme.test/team', snippet: 'Jane Doe Head of People and Maya Chen Head of Product at Acme Learning.' },
    { title: 'Maya Chen', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product at Acme Learning.' }
  ]);
  try {
    const { s, profile, job } = await createFixtureStore();
    const result = await runContactResearch(s, {
      profile,
      job,
      fetchImpl: fakePageFetch([]),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'false', JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4' }
    });
    const mayaContact = result.contacts.find(c => c.normalizedValue === 'maya.chen@acme.test');
    assert.ok(mayaContact, 'expected a maya.chen pattern candidate');
    const approved = approveContact(s, { contactId: mayaContact.id });
    assert.equal(approved.humanApproved, true);
    const mayaCandidate = result.personCandidates.find(c => c.name === 'Maya Chen');
    assert.ok(mayaCandidate, 'expected a Maya Chen person candidate');
    const stakeholder = promoteStakeholder(s, { candidateId: mayaCandidate.id });
    const plan = createOutreachPlan(s, { jobId: job.id, profileId: profile.id, stakeholderId: stakeholder.id, goal: 'informational' });
    assert.match(plan.id, /^plan_/);
    assert.equal(plan.jobId, job.id);
    assert.equal(plan.profileId, profile.id);
    assert.equal(plan.stakeholderId, stakeholder.id);
    assert.equal(plan.contactPointId, mayaContact.id);
    assert.equal(plan.recommended, true);
    assert.ok(['email', 'manual_review', 'generic_inbox'].includes(plan.channel));
    assert.ok(one(s, 'SELECT id FROM outreach_plans WHERE id=?', [plan.id]));
    assert.ok(one(s, 'SELECT id FROM audit_log WHERE action=? AND entity_id=?', ['outreach.plan.created', plan.id]));
    assert.match(plan.note, /did not send/);
    assert.throws(() => createOutreachPlan(s, { jobId: 'job_does_not_exist', profileId: profile.id }), /Unknown job/);
  } finally {
    await search.close();
  }
});

test('createOutreachPlan returns no_safe_path when no contacts are available', async () => {
  const { s, profile, job } = await createFixtureStore();
  const plan = createOutreachPlan(s, { jobId: job.id, profileId: profile.id });
  assert.equal(plan.recommended, false);
  assert.equal(plan.channel, 'no_safe_path');
  assert.equal(plan.pathStrength, 'blocked');
  assert.equal(plan.contactPointId, null);
  assert.ok(one(s, 'SELECT id FROM outreach_plans WHERE id=?', [plan.id]));
});

test('resolveHostIsPublic rejects private/loopback/link-local addresses and allows public ones', async () => {
  const { resolveHostIsPublic } = await import('../src/research/sources.js');
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1']) {
    const result = await resolveHostIsPublic(ip);
    assert.equal(result.ok, false, `expected ${ip} to be blocked, got ${JSON.stringify(result)}`);
  }
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  assert.equal((await resolveHostIsPublic('example.com', { lookupImpl: publicLookup })).ok, true);
  const privateLookup = async () => [{ address: '192.168.1.1', family: 4 }];
  assert.equal((await resolveHostIsPublic('example.com', { lookupImpl: privateLookup })).ok, false);
  const allowed = await resolveHostIsPublic('127.0.0.1', { env: { JOBOS_ALLOW_PRIVATE_HOSTS: 'true' } });
  assert.equal(allowed.ok, true);
});
