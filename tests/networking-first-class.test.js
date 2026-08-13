import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, one, openStore, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { callDomainTool } from '../src/domain-tools.js';
import { findPersonByEmail } from '../src/research/people.js';
import { syncSourceObservations } from '../src/research/sources.js';
import { createResearchRun, executeResearchRun } from '../src/research/runs.js';

async function fixture(prefix = 'jobos-network-first-class-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const store = await openStore({ workspace: root });
  return { root, store };
}

function addPersonWithEmail(store, { personId = 'person_ada', email = 'Ada@Example.test' } = {}) {
  const at = '2026-08-01T00:00:00.000Z';
  run(store, `INSERT INTO people (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [personId, 'Ada Lovelace', 'ada lovelace', 'https://example.test/ada', '[]', 'high', at, at]);
  run(store, `INSERT INTO contact_points
    (id,person_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['contact_ada', personId, 'email', email, email.toLowerCase(), 'U', 'user_imported', 'medium', '[]', '{}', 1, 0, at, at]);
  run(store, `INSERT INTO relationship_edges
    (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, ['edge_ada', 'profile', 'profile_test', 'person', personId, 'shared_school', '[{"label":"shared school"}]', 'medium', at]);
}

function cli(root, args) {
  const result = spawnSync(process.execPath, ['src/cli.js', ...args, '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, JOBOS_HOME: root, JOBOS_SEARCH_PROVIDER: 'none' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('exact normalized email lookup works in CLI and domain tool while agent output stays redacted', async () => {
  const { root, store } = await fixture();
  addPersonWithEmail(store);
  save(store);

  const index = one(store, "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_contact_points_email_normalized'");
  assert.match(index.sql, /normalized_value/i);
  assert.match(index.sql, /generic_inbox/i);

  const safe = findPersonByEmail(store, '  ADA@example.TEST  ');
  assert.equal(safe.person.id, 'person_ada');
  assert.deepEqual(safe.contactSummary, { count: 1, types: ['email'], tiers: { U: 1 } });
  assert.equal(JSON.stringify(safe).includes('Ada@Example.test'), false);
  assert.equal(safe.edges[0].edgeType, 'shared_school');

  const agent = await callDomainTool(store, 'find_person', { email: 'ada@example.test' }, { source: 'mcp' });
  assert.equal(agent.person.id, 'person_ada');
  assert.equal(agent.contacts, undefined);
  assert.doesNotMatch(JSON.stringify(agent), /ada@example\.test/i);

  const found = cli(root, ['people', 'find', '--email', 'ADA@example.test']);
  assert.equal(found.person.id, 'person_ada');
  assert.equal(found.contacts[0].value, 'Ada@Example.test');
  const shown = cli(root, ['contacts', 'show', '--email', 'ada@example.test']);
  assert.equal(shown.contacts[0].normalizedValue, 'ada@example.test');
});

test('people research creates or resolves a person from email through CLI-shaped domain input', async () => {
  const { root, store } = await fixture();
  const profile = createProfile(store, 'Email Researcher').profile;
  const result = await callDomainTool(store, 'start_people_research', {
    profileId: profile.id,
    scope: 'person',
    email: 'grace.hopper@example.test',
    sources: []
  }, { source: 'mcp' });
  assert.ok(['succeeded', 'partial'].includes(result.status), JSON.stringify(result));
  const contact = one(store, "SELECT * FROM contact_points WHERE normalized_value='grace.hopper@example.test'");
  assert.ok(contact?.person_id);
  assert.equal(contact.evidence_tier, 'D');
  assert.equal(contact.human_approved, 0);
  assert.equal(one(store, 'SELECT person_id FROM research_runs WHERE id=?', [result.runId]).person_id, contact.person_id);
  const mirror = readFileSync(path.join(root, 'jobos-workspace', 'research', 'runs', `${result.runId}.yaml`), 'utf8');
  assert.doesNotMatch(mirror, /grace\.hopper@example\.test/i);
});

test('Exa people observations stage sourced candidates and untrusted contact points without leaking mirrors', async () => {
  const { root, store } = await fixture();
  const profile = createProfile(store, 'Exa Researcher').profile;
  const jobFile = path.join(root, 'job.txt');
  writeFileSync(jobFile, 'Title: Platform Engineer\nCompany: Acme\nLocation: Remote\n\nBuild reliable distributed systems.');
  const { job } = importText(store, { profileId: profile.id, filePath: jobFile });
  const oldKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = 'test-exa-key';
  try {
    const runId = createResearchRun(store, {
      profileId: profile.id,
      scope: 'job',
      jobId: job.id,
      sources: ['exa_people']
    });
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.exa.ai/search');
      assert.equal(options.headers['x-api-key'], 'test-exa-key');
      const body = JSON.parse(options.body);
      assert.equal(body.category, 'people');
      return new Response(JSON.stringify({
        results: [{
          id: 'exa-result-ada',
          title: 'Ada Lovelace - Platform Engineering Director',
          url: 'https://profiles.example.test/ada-lovelace',
          text: 'Ada Lovelace can be reached at ada.lovelace@acme.test for professional inquiries.'
        }],
        entities: [{
          id: 'exa-person-ada',
          type: 'person',
          version: 1,
          properties: { name: 'Ada Lovelace', workHistory: [{ title: 'Platform Engineering Director', company: { name: 'Acme' }, dates: { from: '2024', to: null } }] }
        }],
        costDollars: { total: 0.01 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await executeResearchRun(store, runId, {
      fetchImpl,
      env: {
        EXA_API_KEY: 'test-exa-key',
        JOBOS_DNS_FIXTURE_JSON: JSON.stringify({ 'acme.test': { mx: [{ exchange: 'mx.acme.test', priority: 10 }] } }),
        JOBOS_SMTP_PROBE: ''
      }
    });
    assert.ok(calls > 0);
    assert.ok(['succeeded', 'partial'].includes(result.status), JSON.stringify(result));
    const observation = one(store, "SELECT * FROM source_observations WHERE provider='exa-people'");
    assert.ok(observation);
    const candidate = one(store, 'SELECT * FROM person_candidates WHERE research_run_id=?', [runId]);
    assert.equal(candidate.name, 'Ada Lovelace');
    assert.ok(JSON.parse(candidate.source_observation_ids_json).includes(observation.id));
    const contact = one(store, "SELECT * FROM contact_points WHERE normalized_value='ada.lovelace@acme.test'");
    assert.ok(contact?.person_id);
    assert.equal(contact.human_approved, 0);
    assert.equal(contact.evidence_tier, 'D');
    assert.ok(JSON.parse(contact.source_observation_ids_json).includes(observation.id));
    const contactsMirror = readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'research', 'contacts.yaml'), 'utf8');
    syncSourceObservations(store, job.id);
    const sourcesMirror = readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'research', 'source-observations.yaml'), 'utf8');
    assert.doesNotMatch(contactsMirror, /ada\.lovelace@acme\.test/i);
    assert.doesNotMatch(sourcesMirror, /ada\.lovelace@acme\.test/i);
    assert.match(contactsMirror, /valuesRedacted: true/);
  } finally {
    if (oldKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = oldKey;
  }
});

test('Exa people source fails preflight honestly without EXA_API_KEY', async () => {
  const { store } = await fixture();
  const profile = createProfile(store, 'No Exa Key').profile;
  const oldKey = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    assert.throws(() => createResearchRun(store, {
      profileId: profile.id,
      scope: 'person',
      email: 'person@example.test',
      sources: ['exa_people']
    }), error => error.code === 'exa_people_preflight_failed' && /EXA_API_KEY/.test(error.message));
  } finally {
    if (oldKey !== undefined) process.env.EXA_API_KEY = oldKey;
  }
});
