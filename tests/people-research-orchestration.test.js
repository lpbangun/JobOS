import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile, setNetworkIntent } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { resolvePerson } from '../src/research/people.js';
import { importNetworkCsv, mapReachableNetwork } from '../src/research/network.js';
import { createResearchRun, executeResearchRun, getResearchRun, requestCancelResearchRun, resumeResearchRun } from '../src/research/runs.js';
import { registerAdapter } from '../src/research/adapters/index.js';
import { xaiAdapter } from '../src/research/adapters/xai.js';
import { callDomainTool } from '../src/domain-tools.js';
import { runPursuit } from '../src/workflows.js';
import { networkAccessFromEvidence } from '../src/scoring.js';
import { recommendResearch } from '../src/tracking.js';

const fixtureCsv = path.resolve('tests/fixtures/linkedin-connections.csv');

async function fixture({ intent = true, job = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-people-accept-'));
  const s = await openStore({ workspace: root });
  const profile = createProfile(s, 'People Research Acceptance').profile;
  if (intent) {
    setNetworkIntent(s, {
      profileId: profile.id,
      intent: {
        version: 1,
        targetCompanies: ['Northstar Media'],
        targetRoles: ['Product Manager'],
        preferredPersonas: ['recruiter', 'alumni'],
        comfortableRelationshipTypes: ['school', 'employer'],
        exclusions: ['do-not-contact'],
        allowedSources: { publicWeb: true, linkedinImport: true, xai: false }
      },
      affiliations: [{ type: 'school', organization: 'Example University', role_or_program: 'MBA', status: 'confirmed' }]
    });
  }
  let importedJob = null;
  if (job) {
    const file = path.join(root, 'job.md');
    writeFileSync(file, 'Title: Product Manager\nCompany: Northstar Media\nLocation: Remote\n\nBuild evidence-backed products and partnerships.');
    importedJob = importText(s, { profileId: profile.id, filePath: file }).job;
  }
  return { root, s, profile, job: importedJob, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function testObservation(context, suffix = 'one') {
  const url = `https://evidence.example/${context.runId}/${suffix}`;
  return {
    id: `src_${context.runId}_${suffix}`,
    companyId: context.companyId || null,
    jobId: context.jobId || null,
    url,
    canonicalUrl: url,
    title: `Evidence ${suffix}`,
    snippet: `Public evidence for Person ${suffix}`,
    sourceType: 'web_search',
    provider: 'acceptance-fixture',
    query: 'acceptance',
    trust: 'public',
    fetchedAt: new Date().toISOString(),
    contentHash: `hash_${suffix}`,
    metadata: {}
  };
}

function adapterResult(overrides = {}) {
  return {
    observations: [], personHints: [], warnings: [],
    usage: { queries: 0, sourceChars: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, paidToolCalls: 0, estimatedUsd: 0 },
    ...overrides
  };
}

test('migration preserves IDs while backfilling canonical people, contacts, stakeholders, and edges', async () => {
  const f = await fixture({ job: true });
  try {
    const at = new Date().toISOString();
    run(f.s, `INSERT INTO person_candidates (id,job_id,name,role,relevance,confidence,source_observation_ids_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['candidate_legacy', f.job.id, 'Alex Rivera', 'Recruiter', 'legacy', 'medium', '[]', 'candidate', at, at]);
    run(f.s, `INSERT INTO stakeholders (id,job_id,name,role,links_json,summary,outreach_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['stakeholder_legacy', f.job.id, 'Alex Rivera', 'Recruiter', '[]', 'legacy', 'not_contacted', at, at]);
    run(f.s, `INSERT INTO contact_points (id,person_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['contact_legacy', 'candidate_legacy', 'email', 'alex@example.test', 'alex@example.test', 'U', 'user_imported', 'medium', '[]', '{}', 0, 0, at, at]);
    run(f.s, `INSERT INTO contact_points (id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['contact_generic', 'generic_inbox', 'careers@example.test', 'careers@example.test', 'A', 'exact_public', 'high', '[]', '{}', 0, 0, at, at]);
    run(f.s, `INSERT INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)`, ['edge_legacy', 'profile', f.profile.id, 'candidate', 'candidate_legacy', 'direct_connection', '[]', 'high', at]);
    run(f.s, `INSERT INTO outreach_plans (id,job_id,profile_id,stakeholder_id,contact_point_id,goal,channel,path_strength,recommended,reasoning_json,warnings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['plan_legacy', f.job.id, f.profile.id, 'stakeholder_legacy', 'contact_legacy', 'informational', 'email', 'direct', 1, '{}', '[]', at]);
    run(f.s, `DELETE FROM meta WHERE key='people_backfill_version'`);
    save(f.s);
    f.s.db.close();

    const reopened = await openStore({ workspace: f.root });
    const candidate = one(reopened, 'SELECT * FROM person_candidates WHERE id=?', ['candidate_legacy']);
    assert.ok(candidate.person_id);
    assert.equal(one(reopened, 'SELECT id FROM contact_points WHERE id=? AND person_id=?', ['contact_legacy', candidate.person_id]).id, 'contact_legacy');
    assert.equal(one(reopened, 'SELECT person_id FROM contact_points WHERE id=?', ['contact_generic']).person_id, null);
    assert.equal(one(reopened, 'SELECT person_id FROM stakeholders WHERE id=?', ['stakeholder_legacy']).person_id, candidate.person_id);
    assert.deepEqual(one(reopened, 'SELECT from_type,from_id,to_type,to_id FROM relationship_edges WHERE id=?', ['edge_legacy']), {
      from_type: 'profile', from_id: f.profile.id, to_type: 'person', to_id: candidate.person_id
    });
    assert.equal(one(reopened, 'SELECT contact_point_id FROM outreach_plans WHERE id=?', ['plan_legacy']).contact_point_id, 'contact_legacy');
    reopened.db.close();
  } finally { f.cleanup(); }
});

test('identity resolution uses canonical URL then exact email and never same-name alone', async () => {
  const f = await fixture();
  try {
    const first = resolvePerson(f.s, { name: 'Sam Lee', profileUrl: 'https://www.linkedin.com/in/sam-lee/', sourceRecordId: 'first' });
    const byUrl = resolvePerson(f.s, { name: 'Different Label', profileUrl: 'https://linkedin.com/in/sam-lee', sourceRecordId: 'second' });
    assert.equal(byUrl.person.id, first.person.id);
    run(f.s, `INSERT INTO contact_points (id,person_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['contact_identity', first.person.id, 'email', 'sam@example.test', 'sam@example.test', 'U', 'user_imported', 'medium', '[]', '{}', 0, 0, new Date().toISOString(), new Date().toISOString()]);
    const byEmail = resolvePerson(f.s, { name: 'Another Label', email: 'SAM@EXAMPLE.TEST', sourceRecordId: 'third' });
    assert.equal(byEmail.person.id, first.person.id);
    const sameName = resolvePerson(f.s, { name: 'Sam Lee', sourceRecordId: 'name-only-is-distinct' });
    assert.notEqual(sameName.person.id, first.person.id);
  } finally { f.cleanup(); }
});

test('profile intent requires explicit confirmation, replaces affiliations, and writes the exact profile map path', async () => {
  const f = await fixture({ intent: false });
  try {
    assert.throws(() => createResearchRun(f.s, { profileId: f.profile.id, scope: 'profile', sources: ['local_network'] }), /completed network intent/);
    assert.throws(() => setNetworkIntent(f.s, { profileId: f.profile.id, intent: { version: 1, preferredPersonas: ['unknown'] } }), /Invalid persona/);
    setNetworkIntent(f.s, {
      profileId: f.profile.id,
      intent: { version: 1, targetCompanies: ['Northstar Media'], targetRoles: ['PM'], preferredPersonas: ['alumni'], allowedSources: { publicWeb: true } },
      affiliations: [{ type: 'school', organization: 'Old School', status: 'confirmed' }]
    });
    setNetworkIntent(f.s, {
      profileId: f.profile.id,
      intent: { version: 1, targetCompanies: ['Northstar Media'], targetRoles: ['PM'], preferredPersonas: ['recruiter'], allowedSources: { publicWeb: true } },
      affiliations: [{ type: 'employer', organization: 'New Employer', status: 'confirmed' }]
    });
    assert.deepEqual(all(f.s, 'SELECT type,organization FROM profile_affiliations WHERE profile_id=?', [f.profile.id]), [{ type: 'employer', organization: 'New Employer' }]);
    const runId = createResearchRun(f.s, { profileId: f.profile.id, scope: 'profile', sources: ['local_network'] });
    const result = await executeResearchRun(f.s, runId);
    assert.equal(result.status, 'succeeded');
    assert.ok(readFileSync(path.join(f.s.p.profiles, f.profile.id, 'network-map.yaml'), 'utf8').includes(`profileId: ${f.profile.id}`));
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM applications').count, 0);
    assert.equal(one(f.s, "SELECT COUNT(*) AS count FROM audit_log WHERE external_side_effect!='none'").count, 0);
  } finally { f.cleanup(); }
});

test('LinkedIn connection import is privacy-safe, warning-bearing, idempotent, and unapproved at tier U', async () => {
  const f = await fixture();
  try {
    const first = importNetworkCsv(f.s, { filePath: fixtureCsv, profileId: f.profile.id, format: 'auto' });
    const second = importNetworkCsv(f.s, { filePath: fixtureCsv, profileId: f.profile.id, format: 'linkedin' });
    assert.equal(first.count, 2);
    assert.equal(second.count, 2);
    assert.ok(first.warnings.length >= 2);
    assert.equal(one(f.s, "SELECT COUNT(*) AS count FROM relationship_edges WHERE from_id=? AND edge_type='direct_connection'", [f.profile.id]).count, 2);
    const importedContacts = all(f.s, "SELECT evidence_tier,human_approved FROM contact_points WHERE verification_status='user_imported'");
    assert.ok(importedContacts.length >= 4);
    assert.ok(importedContacts.every(row => row.evidence_tier === 'U' && row.human_approved === 0));
    const audit = one(f.s, "SELECT payload_json FROM audit_log WHERE action='network.imported' ORDER BY created_at DESC LIMIT 1");
    assert.equal(audit.payload_json.includes('bob.direct@example.com'), false);
    assert.equal(audit.payload_json.includes('First Name'), false);
    assert.ok(JSON.parse(audit.payload_json).fileHash);
  } finally { f.cleanup(); }
});

test('all four scopes validate ownership and persist durable workspace mirrors without external effects', async () => {
  const f = await fixture({ job: true });
  try {
    const person = resolvePerson(f.s, { name: 'Casey Morgan', profileUrl: 'https://example.test/casey', sourceRecordId: 'casey' }).person;
    const alternate = createProfile(f.s, 'Other Profile').profile;
    assert.throws(() => createResearchRun(f.s, { profileId: alternate.id, scope: 'job', jobId: f.job.id, sources: ['local_network'] }), /does not belong/);
    assert.throws(() => createResearchRun(f.s, { profileId: f.profile.id, scope: 'target', sources: ['local_network'] }), /requires company/);
    assert.throws(() => createResearchRun(f.s, { profileId: f.profile.id, scope: 'person', person: { name: 'Bad', profileUrl: 'ftp://bad' }, sources: ['local_network'] }), /HTTP\(S\)/);
    const requests = [
      { scope: 'profile' },
      { scope: 'target', company: 'Northstar Media', role: 'Product Manager' },
      { scope: 'job', jobId: f.job.id },
      { scope: 'person', personId: person.id }
    ];
    for (const request of requests) {
      const runId = createResearchRun(f.s, { profileId: f.profile.id, sources: ['local_network'], ...request });
      const result = await executeResearchRun(f.s, runId);
      assert.equal(result.status, 'succeeded');
      assert.ok(readFileSync(path.join(f.s.p.ws, result.path), 'utf8').includes(`runId: ${runId}`));
    }
    assert.equal(one(f.s, "SELECT COUNT(*) AS count FROM audit_log WHERE external_side_effect!='none'").count, 0);
  } finally { f.cleanup(); }
});

test('adapter isolation yields partial success and budget caps limit resolved candidates', async () => {
  const f = await fixture();
  const successName = `accept-success-${Date.now()}`;
  const failureName = `accept-failure-${Date.now()}`;
  registerAdapter({ name: successName, async run({ context }) {
    const observations = [testObservation(context, 'a'), testObservation(context, 'b'), testObservation(context, 'c')];
    return adapterResult({ observations, personHints: observations.map((observation, index) => ({
      name: `Candidate ${index}`, profileUrl: `https://profiles.example/${context.runId}/${index}`,
      source: successName, sourceObservationIds: [observation.id], confidence: 'medium'
    })), usage: { ...adapterResult().usage, queries: 1, sourceChars: 300 } });
  }});
  registerAdapter({ name: failureName, async run() { const error = new Error('temporary fixture outage'); error.retryable = true; throw error; } });
  try {
    const runId = createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'Northstar Media', role: 'PM',
      sources: [successName, failureName], budget: { maxCandidates: 1 }
    });
    const result = await executeResearchRun(f.s, runId);
    assert.equal(result.status, 'partial');
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM person_candidates WHERE research_run_id=?', [runId]).count, 1);
    assert.ok(result.warnings.some(warning => warning.includes(failureName)));
    assert.equal(getResearchRun(f.s, runId).usage.queries, 1);
  } finally { f.cleanup(); }
});

test('retryable runs resume from checkpoint, fresh observations are cached, and cancellation becomes terminal', async () => {
  const f = await fixture();
  const retryName = `accept-retry-${Date.now()}`;
  let attempts = 0;
  registerAdapter({ name: retryName, async run({ context }) {
    attempts++;
    if (attempts === 1) { const error = new Error('temporary network failure'); error.retryable = true; throw error; }
    const observation = testObservation(context, 'retry');
    return adapterResult({ observations: [observation], personHints: [{ name: 'Retry Person', profileUrl: `https://profiles.example/${context.runId}/retry`, source: retryName, sourceObservationIds: [observation.id] }] });
  }});
  const cacheName = `accept-cache-${Date.now()}`;
  let cacheCalls = 0;
  registerAdapter({ name: cacheName, async run({ context }) {
    cacheCalls++;
    const observation = testObservation(context, 'cache');
    return adapterResult({ observations: [observation], personHints: [{ name: 'Cache Person', profileUrl: 'https://profiles.example/cache-person', source: cacheName, sourceObservationIds: [observation.id] }] });
  }});
  const cancelName = `accept-cancel-${Date.now()}`;
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  registerAdapter({ name: cancelName, async run() {
    entered();
    await new Promise(resolve => { release = resolve; });
    return adapterResult();
  }});
  try {
    const retryId = createResearchRun(f.s, { profileId: f.profile.id, scope: 'target', company: 'Retry Co', sources: [retryName] });
    assert.equal((await executeResearchRun(f.s, retryId)).status, 'paused_retryable');
    assert.equal((await resumeResearchRun(f.s, retryId)).status, 'succeeded');
    assert.equal(attempts, 2);

    const request = { profileId: f.profile.id, scope: 'target', company: 'Cache Co', role: 'PM', sources: [cacheName] };
    const firstId = createResearchRun(f.s, request);
    assert.equal((await executeResearchRun(f.s, firstId)).status, 'succeeded');
    const secondId = createResearchRun(f.s, request);
    const cached = await executeResearchRun(f.s, secondId);
    assert.equal(cached.status, 'succeeded');
    assert.equal(cacheCalls, 1);
    assert.ok(cached.warnings.some(warning => warning.includes('cache_reused')));

    const cancelId = createResearchRun(f.s, { profileId: f.profile.id, scope: 'target', company: 'Cancel Co', sources: [cancelName] });
    const executing = executeResearchRun(f.s, cancelId);
    await enteredPromise;
    assert.equal(requestCancelResearchRun(f.s, cancelId).status, 'cancel_requested');
    release();
    assert.equal((await executing).status, 'cancelled');
    await assert.rejects(() => resumeResearchRun(f.s, cancelId), /Only 'paused_retryable'/);
  } finally { f.cleanup(); }
});

test('xAI is triple-gated and drops uncited claims while preserving cited X evidence and usage', async () => {
  const context = { runId: 'xai_acceptance', companyName: 'Northstar', networkIntent: { allowedSources: { xai: true } } };
  const budget = { maxCostUsd: null, maxPaidToolCalls: 2, maxModelCalls: 2 };
  let calls = 0;
  const disabled = await xaiAdapter.run({ context, plan: { queries: [] }, budget, env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.match(disabled.warnings.join('\n'), /not set to 1/);
  const uncited = await xaiAdapter.run({
    context, plan: { queries: ['people'] }, budget,
    env: { JOBOS_XAI_ENABLED: '1', XAI_API_KEY: 'secret' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ citations: [], usage: { input_tokens: 10, output_tokens: 5 }, output: [] }) })
  });
  assert.equal(uncited.observations.length, 0);
  assert.match(uncited.warnings.join('\n'), /no citations/);
  const evidenceUrl = 'https://x.com/example/status/123';
  const cited = await xaiAdapter.run({
    context, plan: { queries: ['people'] }, budget,
    env: { JOBOS_XAI_ENABLED: '1', XAI_API_KEY: 'secret', JOBOS_MODEL_PRICING_JSON: JSON.stringify({ 'grok-4.5': { inputPerMillionUsd: 1, outputPerMillionUsd: 2, xSearchCallUsd: 0.01 } }) },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer secret');
      return { ok: true, json: async () => ({
        citations: [evidenceUrl], usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          { type: 'x_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [
            { name: 'Cited Person', evidenceUrls: [evidenceUrl], relevance: 'Public X evidence', affiliations: [] },
            { name: 'Uncited Person', evidenceUrls: ['https://x.com/example/status/999'], relevance: 'Unsupported', affiliations: [] }
          ] }) }] }
        ]
      }) };
    }
  });
  assert.equal(cited.observations.length, 1);
  assert.equal(cited.personHints.length, 1);
  assert.equal(cited.usage.paidToolCalls, 1);
  assert.ok(cited.usage.estimatedUsd > 0);
  assert.equal(JSON.stringify(cited).includes('secret'), false);
});

test('MCP mediation denies agent approval and dry-run pursuit exposes people research without side effects', async () => {
  const f = await fixture({ job: true });
  try {
    importNetworkCsv(f.s, { filePath: fixtureCsv, profileId: f.profile.id, format: 'linkedin' });
    const contact = one(f.s, "SELECT id FROM contact_points WHERE verification_status='user_imported' LIMIT 1");
    await assert.rejects(() => callDomainTool(f.s, 'approve_contact', { contactId: contact.id }, { source: 'mcp' }), /human confirmation/i);
    const pursuit = await runPursuit(f.s, { jobId: f.job.id, profileId: f.profile.id, dryRun: true });
    assert.ok(pursuit.stages.some(result => result.stage === 'people-research'));
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM applications').count, 0);
    assert.equal(one(f.s, "SELECT COUNT(*) AS count FROM audit_log WHERE external_side_effect!='none'").count, 0);
  } finally { f.cleanup(); }
});

test('integrated alumni flow ranks a source-backed direct path and keeps all actions human-gated', async () => {
  const f = await fixture({ intent: false });
  const adapterName = `accept-alumni-${Date.now()}`;
  try {
    setNetworkIntent(f.s, {
      profileId: f.profile.id,
      intent: {
        version: 1,
        targetCompanies: ['Northstar Media'],
        targetRoles: ['Public Relations Lead'],
        preferredPersonas: ['alumni'],
        comfortableRelationshipTypes: ['school'],
        exclusions: [],
        allowedSources: { publicWeb: true, linkedinImport: true, xai: false }
      },
      affiliations: [{ type: 'school', organization: 'Example University', role_or_program: 'Graduate School', status: 'confirmed' }]
    });
    importNetworkCsv(f.s, { filePath: fixtureCsv, profileId: f.profile.id, format: 'linkedin' });
    const alice = one(f.s, "SELECT p.id,p.primary_profile_url FROM people p WHERE p.normalized_name='alice alumni'");
    assert.ok(alice?.id);
    const jobFile = path.join(f.root, 'pr-job.md');
    writeFileSync(jobFile, 'Title: Public Relations Lead\nCompany: Northstar Media\nLocation: Remote\n\nLead public relations, media strategy, and executive communications.');
    const job = importText(f.s, { profileId: f.profile.id, filePath: jobFile }).job;
    registerAdapter({
      name: adapterName,
      async run({ context }) {
        const observation = testObservation(context, 'alice-alumni');
        observation.title = 'Alice Alumni — PR Director at Northstar Media';
        observation.snippet = 'Public biography lists Example University and Northstar Media communications leadership.';
        return adapterResult({
          observations: [observation],
          personHints: [{
            name: 'Alice Alumni',
            profileUrl: alice.primary_profile_url,
            company: 'Northstar Media',
            role: 'PR Director',
            relevance: 'Alumnus and target-company communications leader.',
            affiliations: [{ type: 'school', organization: 'Example University', role: 'Graduate School' }],
            source: adapterName,
            sourceObservationIds: [observation.id],
            confidence: 'high'
          }]
        });
      }
    });
    const runId = createResearchRun(f.s, {
      profileId: f.profile.id,
      scope: 'job',
      jobId: job.id,
      sources: [adapterName]
    });
    const result = await executeResearchRun(f.s, runId);
    assert.equal(result.status, 'succeeded');
    const candidate = one(f.s, 'SELECT person_id,source_observation_ids_json FROM person_candidates WHERE research_run_id=?', [runId]);
    assert.equal(candidate.person_id, alice.id);
    assert.ok(JSON.parse(candidate.source_observation_ids_json).length > 0);
    const network = mapReachableNetwork(f.s, { jobId: job.id });
    assert.equal(network.paths[0].edge.toId, alice.id);
    assert.equal(network.paths[0].pathStrength, 'direct user-provided connection');
    assert.match(network.paths[0].evidence.map(item => item.label).join('\n'), /Alice Alumni/);
    assert.ok(all(f.s, 'SELECT human_approved FROM contact_points').every(row => row.human_approved === 0));
    assert.ok(readFileSync(path.join(f.s.p.ws, result.path), 'utf8').includes(runId));
    assert.ok(readFileSync(path.join(f.s.p.ws, network.yamlPath), 'utf8').includes('direct user-provided connection'));
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM applications').count, 0);
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM outreach_plans').count, 0);
    assert.equal(one(f.s, "SELECT COUNT(*) AS count FROM audit_log WHERE external_side_effect!='none'").count, 0);
  } finally { f.cleanup(); }
});

test('network access scoring uses deterministic fresh and stale evidence bands without response claims', async () => {
  const scenarios = [
    { kind: 'direct', fresh: true, score: 90 },
    { kind: 'direct', fresh: false, score: 80 },
    { kind: 'mutual', fresh: true, score: 80 },
    { kind: 'mutual', fresh: false, score: 70 },
    { kind: 'approved', fresh: true, score: 70 },
    { kind: 'approved', fresh: false, score: 60 },
    { kind: 'generic', fresh: true, score: 60 },
    { kind: 'generic', fresh: false, score: 50 },
    { kind: 'none', fresh: true, score: 50 }
  ];
  const observedBands = new Set();
  for (const scenario of scenarios) {
    const f = await fixture({ job: true });
    try {
      if (scenario.kind !== 'none') {
        const at = new Date().toISOString();
        const finishedAt = scenario.fresh ? at : new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const runId = `research_score_${scenario.kind}_${scenario.fresh ? 'fresh' : 'stale'}`;
        const person = resolvePerson(f.s, {
          name: `Score ${scenario.kind}`,
          profileUrl: `https://profiles.example/score-${scenario.kind}-${scenario.fresh}`,
          sourceRecordId: runId
        }).person;
        run(f.s, `INSERT INTO research_runs (id,profile_id,scope,job_id,status,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [runId, f.profile.id, 'job', f.job.id, 'succeeded', finishedAt, at, at]);
        run(f.s, `INSERT INTO person_candidates (id,job_id,name,relevance,confidence,status,created_at,updated_at,person_id,research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [`candidate_${runId}`, f.job.id, person.name, 'score fixture', 'high', 'candidate', at, at, person.id, runId]);
        if (scenario.kind === 'direct' || scenario.kind === 'mutual') {
          run(f.s, 'INSERT INTO relationship_edges VALUES (?,?,?,?,?,?,?,?,?)', [
            `edge_${runId}`, 'profile', f.profile.id, 'person', person.id,
            scenario.kind === 'direct' ? 'direct_connection' : 'shared_school',
            JSON.stringify([{ label: `${scenario.kind} fixture` }]), 'high', at
          ]);
        }
        if (scenario.kind === 'approved') {
          run(f.s, `INSERT INTO contact_points (id,person_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [`contact_${runId}`, person.id, 'email', `${scenario.kind}@example.test`, `${scenario.kind}@example.test`, 'A', 'exact_public', 'high', '[]', '{}', 1, 0, at, at]);
        }
      }
      const result = networkAccessFromEvidence(f.s, { jobId: f.job.id, profileId: f.profile.id });
      assert.equal(result.score, scenario.score, `${scenario.kind}/${scenario.fresh ? 'fresh' : 'stale'}: ${result.reason}`);
      assert.doesNotMatch(result.reason, /response|reply|probabil/i);
      observedBands.add(result.score);
    } finally { f.cleanup(); }
  }
  assert.deepEqual([...observedBands].sort((a, b) => a - b), [50, 60, 70, 80, 90]);
});

test('research deadline becomes a terminal partial checkpoint instead of an orphan timeout', async () => {
  const f = await fixture();
  const adapterName = `accept-deadline-${Date.now()}`;
  let entered = false;
  registerAdapter({
    name: adapterName,
    async run({ signal }) {
      entered = true;
      if (!signal.aborted) await new Promise(resolve => {
        const hold = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(hold);
          resolve();
        }, { once: true });
      });
      return adapterResult();
    }
  });
  try {
    const runId = createResearchRun(f.s, {
      profileId: f.profile.id,
      scope: 'target',
      company: 'Slow Research Co',
      sources: [adapterName],
      budget: { maxDurationMs: 1000 }
    });
    const result = await executeResearchRun(f.s, runId);
    assert.equal(entered, true);
    assert.equal(result.status, 'partial');
    assert.ok(result.warnings.some(warning => warning.includes('maxDurationMs')));
    const persisted = getResearchRun(f.s, runId);
    assert.equal(persisted.status, 'partial');
    assert.ok(persisted.finishedAt);
    assert.ok(readFileSync(path.join(f.s.p.ws, result.path), 'utf8').includes('status: partial'));
  } finally { f.cleanup(); }
});

test('run creation enforces all three xAI preflight gates before source work', async () => {
  const f = await fixture();
  const oldEnabled = process.env.JOBOS_XAI_ENABLED;
  const oldKey = process.env.XAI_API_KEY;
  const restore = (key, value) => value === undefined ? delete process.env[key] : process.env[key] = value;
  try {
    process.env.JOBOS_XAI_ENABLED = '1';
    process.env.XAI_API_KEY = 'acceptance-secret';
    assert.throws(() => createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'xAI Co', sources: ['xai']
    }), error => error.code === 'xai_preflight_failed');
    setNetworkIntent(f.s, {
      profileId: f.profile.id,
      intent: {
        version: 1,
        targetCompanies: ['xAI Co'],
        targetRoles: ['PR'],
        preferredPersonas: ['alumni'],
        allowedSources: { publicWeb: true, linkedinImport: false, xai: true }
      }
    });
    delete process.env.JOBOS_XAI_ENABLED;
    assert.throws(() => createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'xAI Co', sources: ['xai']
    }), error => error.code === 'xai_preflight_failed');
    process.env.JOBOS_XAI_ENABLED = '1';
    delete process.env.XAI_API_KEY;
    assert.throws(() => createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'xAI Co', sources: ['xai']
    }), error => error.code === 'xai_preflight_failed');
    process.env.XAI_API_KEY = 'acceptance-secret';
    const runId = createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'xAI Co', sources: ['xai']
    });
    assert.equal(getResearchRun(f.s, runId).status, 'queued');
    assert.equal(one(f.s, 'SELECT COUNT(*) AS count FROM source_observations').count, 0);
  } finally {
    restore('JOBOS_XAI_ENABLED', oldEnabled);
    restore('XAI_API_KEY', oldKey);
    f.cleanup();
  }
});

test('non-job observations remain null-job and application status recommendations target the right scope', async () => {
  const f = await fixture({ job: true });
  const adapterName = `accept-null-job-${Date.now()}`;
  registerAdapter({
    name: adapterName,
    async run({ context }) {
      const observation = testObservation(context, 'target-null-job');
      return adapterResult({ observations: [observation] });
    }
  });
  try {
    const runId = createResearchRun(f.s, {
      profileId: f.profile.id, scope: 'target', company: 'Northstar Media', sources: [adapterName]
    });
    await executeResearchRun(f.s, runId);
    const observation = one(f.s, 'SELECT job_id FROM source_observations WHERE id=?', [`src_${runId}_target-null-job`]);
    assert.equal(observation.job_id, null);
    for (const status of ['saved', 'researching', 'materials-ready', 'applied', 'interview']) {
      const recommendation = recommendResearch(f.s, { jobId: f.job.id, profileId: f.profile.id, status });
      assert.match(recommendation.nextAction, new RegExp(`--scope job --job ${f.job.id}`));
    }
    const recruiterWithoutIdentity = recommendResearch(f.s, { jobId: f.job.id, profileId: f.profile.id, status: 'recruiter-screen' });
    assert.match(recruiterWithoutIdentity.nextAction, /--scope job/);
    const recruiter = resolvePerson(f.s, { name: 'Known Recruiter', profileUrl: 'https://profiles.example/recruiter', sourceRecordId: 'known-recruiter' }).person;
    const at = new Date().toISOString();
    run(f.s, `INSERT INTO stakeholders (id,job_id,name,role,links_json,summary,outreach_status,created_at,updated_at,person_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['stakeholder_known_recruiter', f.job.id, recruiter.name, 'Technical Recruiter', '[]', 'known recruiter', 'not_contacted', at, at, recruiter.id]);
    const recruiterRecommendation = recommendResearch(f.s, { jobId: f.job.id, profileId: f.profile.id, status: 'recruiter-screen' });
    assert.match(recruiterRecommendation.nextAction, new RegExp(`--scope person --person ${recruiter.id}`));
    for (const status of ['offer', 'rejected', 'withdrawn', 'ghosted']) {
      assert.equal(recommendResearch(f.s, { jobId: f.job.id, profileId: f.profile.id, status }), null);
    }
  } finally { f.cleanup(); }
});
