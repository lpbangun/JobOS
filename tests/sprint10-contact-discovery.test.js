import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { approveContact, createOutreachPlan, discoverContacts, promoteStakeholder, suppressContact } from '../src/research/contacts.js';
import { importNetworkCsv, mapReachableNetwork } from '../src/research/network.js';
import { draftOutreach } from '../src/outreach.js';
import net from 'node:net';

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

function fakeDnsResolver() {
  return {
    async resolveMx(domain) {
      if (domain !== 'acme.test') throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return [{ exchange: 'mx.acme.test', priority: 10 }];
    },
    async resolveTxt(domain) {
      if (domain === '_dmarc.acme.test') return [['v=DMARC1; p=none']];
      if (domain === 'acme.test') return [['v=spf1 include:_spf.acme.test ~all']];
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    },
    async resolveNs(domain) {
      if (domain !== 'acme.test') throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return ['ns1.acme.test'];
    }
  };
}

function fakeLookupImpl() {
  return async (host, options) => {
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
    return [{ address: '8.8.8.8', family: 4 }];
  };
}

function fakePageFetch(calls) {
  return async rawUrl => {
    calls.push(String(rawUrl));
    const url = new URL(rawUrl);
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
    if (url.pathname === '/orgs/acme-learning/members') {
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

test('contact discovery extracts public emails, infers patterns, records LinkedIn URLs, and approves contacts', async () => {
  const search = await fakeSearchServer([
    { title: 'Acme Learning Team', url: 'https://acme.test/team', snippet: 'Jane Doe Head of People and Maya Chen Head of Product at Acme Learning.' },
    { title: 'Maya Chen — Head of Product at Acme Learning', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product at Acme Learning.' }
  ]);
  try {
    const { root, s, job } = await createFixtureStore();
    const fetchCalls = [];
    const result = await discoverContacts(s, {
      jobId: job.id,
      fetchImpl: fakePageFetch(fetchCalls),
      lookupImpl: fakeLookupImpl(),
      resolver: fakeDnsResolver(),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'true', JOBOS_SMTP_FIXTURE_JSON: JSON.stringify({ 'jane.doe@acme.test': 'smtp_accepts_rcpt', 'acme.test': 'smtp_inconclusive' }), JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4' }
    });
    assert.ok(result.contactCount >= 5);
    assert.ok(fetchCalls.every(url => !url.includes('linkedin.com')), `LinkedIn should not be fetched: ${fetchCalls.join(', ')}`);
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

test('research contacts CLI returns parseable JSON and writes contact worksheet', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-contacts-cli-'));
  const pageServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [
        { title: 'Acme Learning Team', url: `http://127.0.0.1:${pageServer.address().port}/team`, snippet: 'Jane Doe Head of People at Acme Learning jane.doe@acme.test.' },
        { title: 'Maya Chen — Head of Product at Acme Learning', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product at Acme Learning.' }
      ] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Acme Learning Team</title></head><body><h2>Jane Doe</h2><p>Head of People <a href="mailto:jane.doe@acme.test">Email</a></p><h2>John Smith</h2><p>Product Lead john.smith@acme.test</p><h2>Maya Chen</h2><p>Head of Product</p></body></html>');
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_SEARCH_BASE_URL: `http://127.0.0.1:${pageServer.address().port}/search`,
    JOBOS_SMTP_PROBE: 'false',
    JOBOS_ALLOW_PRIVATE_HOSTS: 'true',
    JOBOS_DNS_FIXTURE_JSON: JSON.stringify({ 'acme.test': { mx: [{ exchange: 'mx.acme.test', priority: 10 }], txt: [['v=spf1 ~all']], dmarc: [['v=DMARC1; p=none']], ns: ['ns1.acme.test'] } }),
    JOBOS_RESEARCH_PAGE_LIMIT: '4',
    JOBOS_LLM_PROVIDER: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: ''
  };
  const runCli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${args.join(' ')}\n${stdout}\n${stderr}`)));
  });
  try {
    await runCli(['init', '--json']);
    const profile = await runCli(['profile', 'create', 'PM EdTech', '--json']);
    const jobFile = path.join(root, 'job.md');
    writeFileSync(jobFile, 'Title: Product Manager\nCompany: Acme Learning\nLocation: Remote\n\nAcme Learning needs a PM.');
    const job = await runCli(['jobs', 'import-text', '--profile', profile.id, '--file', jobFile, '--json']);
    const store = await openStore({ workspace: root });
    run(store, 'UPDATE companies SET website=? WHERE id=(SELECT company_id FROM jobs WHERE id=?)', [`http://127.0.0.1:${pageServer.address().port}`, job.id]);
    save(store);
    const result = await runCli(['research', 'contacts', '--job', job.id, '--json']);
    assert.equal(result.jobId, job.id);
    assert.ok(result.contactCount >= 3);
    assert.ok(result.contacts.some(c => c.value === 'jane.doe@acme.test'));
    assert.ok(result.contacts.some(c => c.type === 'profile_url'));
    assert.match(readFileSync(path.join(root, 'jobos-workspace', result.path), 'utf8'), /Contact research/);
  } finally {
    await new Promise(resolve => pageServer.close(resolve));
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
    const result = await discoverContacts(s, {
      jobId: job.id,
      fetchImpl: fakePageFetch([]),
      lookupImpl: fakeLookupImpl(),
      resolver: fakeDnsResolver(),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'false', JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4', JOBOS_ALLOW_PRIVATE_HOSTS: 'true' }
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
    const { s, job } = await createFixtureStore();
    const result = await discoverContacts(s, {
      jobId: job.id,
      fetchImpl: fakePageFetch([]),
      lookupImpl: fakeLookupImpl(),
      resolver: fakeDnsResolver(),
      env: {
        ...process.env,
        JOBOS_SMTP_PROBE: 'false',
        JOBOS_SEARCH_BASE_URL: search.baseUrl,
        JOBOS_RESEARCH_PAGE_LIMIT: '2',
        JOBOS_RESEARCH_ADAPTERS: 'github,gdelt,wayback',
        JOBOS_GITHUB_API_URL: adapters.baseUrl,
        JOBOS_GDELT_DOC_URL: `${adapters.baseUrl}/gdelt`,
        JOBOS_WAYBACK_CDX_URL: `${adapters.baseUrl}/cdx`,
        JOBOS_ALLOW_PRIVATE_HOSTS: 'true'
      }
    });
    assert.ok(result.warnings.length === 0, result.warnings.join('\n'));
    const providers = all(s, 'SELECT DISTINCT provider FROM source_observations WHERE job_id=?', [job.id]).map(row => row.provider);
    assert.ok(providers.includes('github'));
    assert.ok(providers.includes('gdelt'));
    assert.ok(providers.includes('wayback'));
    assert.ok(adapters.requests.includes('/orgs/acme-learning/members'));
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
    { title: 'Maya Chen', url: 'https://www.linkedin.com/in/maya-chen', snippet: 'Maya Chen is Head of Product.' }
  ]);
  try {
    const { s, profile, job } = await createFixtureStore();
    const result = await discoverContacts(s, {
      jobId: job.id,
      fetchImpl: fakePageFetch([]),
      lookupImpl: fakeLookupImpl(),
      resolver: fakeDnsResolver(),
      env: { ...process.env, JOBOS_SMTP_PROBE: 'false', JOBOS_SEARCH_BASE_URL: search.baseUrl, JOBOS_RESEARCH_PAGE_LIMIT: '4', JOBOS_ALLOW_PRIVATE_HOSTS: 'true' }
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
    assert.match(plan.note, /human-gated/);
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
