import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import initSqlJs from 'sql.js';
import YAML from 'yaml';

import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import {
  listContactPoints,
  projectContactConfidenceV2,
  upsertContactPoint,
  verifyObservationContacts,
} from '../src/research/contacts.js';
import { saveSourceObservation } from '../src/research/sources.js';
import {
  classifyStakeholder,
  draftOutreach,
  markOutreachSent,
} from '../src/outreach.js';
import {
  listOutreachOutcomes,
  recordOutreachOutcome,
  summarizeOutreachOutcomes,
} from '../src/outreach-outcomes.js';
import { weekly } from '../src/analytics.js';
import { callDomainTool } from '../src/domain-tools.js';

const FIXED_NOW = '2026-07-23T12:00:00.000Z';
const FRESH_AT = '2026-07-10T12:00:00.000Z';
const STALE_AT = '2026-02-01T12:00:00.000Z';
const require = createRequire(import.meta.url);

function fakeOutreachLlmServer(payloads) {
  const requests = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise(done => server.close(done)),
  })));
}

function providerEnvironment(baseUrl) {
  return {
    JOBOS_LLM_PROVIDER: 'openai',
    JOBOS_LLM_MODEL: 'w05-fixture',
    JOBOS_LLM_API_KEY: 'test-key',
    JOBOS_LLM_BASE_URL: baseUrl,
  };
}

function setProviderEnvironment(values) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

function workspaceText(root) {
  if (!existsSync(root)) return '';
  return readdirSync(root, { withFileTypes: true })
    .map(entry => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? workspaceText(target) : readFileSync(target, 'utf8');
    })
    .join('\n');
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w05-'));
  const s = await openStore({ workspace: root });
  const profile = createProfile(s, 'W05 Candidate').profile;
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, '# Staff Product Manager\nCompany: Evidence Labs\n\nLead product discovery and activation work.\n');
  const job = importText(s, { profileId: profile.id, filePath: jobFile }).job;
  run(s, 'UPDATE companies SET website=?,domain=?,facts_json=? WHERE id=?', [
    'https://evidence.example',
    'evidence.example',
    JSON.stringify([{ claim: 'Evidence Labs publishes source-backed workflow research', title: 'Research', url: 'https://evidence.example/research', confidence: 'high' }]),
    job.company_id,
  ]);
  const proof = addProof(s, profile.id, 'Led a source-backed workflow launch that reduced review time by 30%.', 'Portfolio evidence');
  return { root, s, profile, job, proof };
}

function insertObservation(s, { id, companyId, jobId, url, fetchedAt, sourceType = 'page_fetch', email = '', name = 'Casey Contact' }) {
  const observation = {
    id,
    companyId,
    jobId,
    url,
    canonicalUrl: url,
    title: 'Contact source',
    snippet: email ? `Contact ${email}` : 'Contact source',
    sourceType,
    provider: sourceType,
    query: '',
    metadata: email ? { emails: [email], emailContexts: [{ email, name, context: 'Team contact', generic: false }] } : {},
    fetchedAt,
    contentHash: `hash-${id}`,
  };
  saveSourceObservation(s, observation);
  return observation;
}

function insertStakeholder(s, job, { id, name, role }) {
  const at = FIXED_NOW;
  run(s, `INSERT INTO stakeholders (id,job_id,company_id,name,role,links_json,summary,outreach_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    id,
    job.id,
    job.company_id,
    name,
    role,
    JSON.stringify([`https://evidence.example/team/${id}`]),
    `${name} is listed by Evidence Labs as ${role}.`,
    'not_contacted',
    at,
    at,
  ]);
  save(s);
  return id;
}

async function draftAndSend(s, fixtureData, stakeholderId, channel = 'email') {
  const draft = await draftOutreach(s, {
    jobId: fixtureData.job.id,
    profileId: fixtureData.profile.id,
    stakeholderId,
    goal: 'informational',
  });
  const sent = markOutreachSent(s, { artifactId: draft.id, channel });
  run(s, 'UPDATE outreach_threads SET sent_at=?,updated_at=? WHERE id=?', ['2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z', sent.id]);
  save(s);
  sent.sentAt = '2026-07-19T12:00:00.000Z';
  return { draft, sent };
}

test('W05-CONTACT-01/02/03/04 confidence separates ownership, domain, verification, freshness, catch-all, and gates', async () => {
  const f = await fixture();
  const unrelated = insertObservation(f.s, {
    id: 'src_unrelated',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://unrelated.example/directory',
    fetchedAt: FRESH_AT,
    sourceType: 'page_fetch',
    email: 'casey@unrelated.example',
  });
  await verifyObservationContacts(f.s, {
    runId: 'run_unrelated',
    jobId: f.job.id,
    observationIds: [unrelated.id],
    env: {
      JOBOS_DNS_FIXTURE_JSON: JSON.stringify({
        'unrelated.example': { mx: [{ exchange: 'mx.unrelated.example', priority: 10 }], ns: ['ns.unrelated.example'], txt: [['v=spf1 -all']], dmarc: [['v=DMARC1; p=reject']] },
      }),
      JOBOS_SMTP_PROBE: 'true',
      JOBOS_SMTP_FIXTURE_JSON: JSON.stringify({ 'casey@unrelated.example': 'smtp_accepts_rcpt' }),
    },
  });
  const unrelatedContact = listContactPoints(f.s, { companyId: f.job.company_id, nowDate: new Date(FIXED_NOW) })
    .find(contact => contact.value === 'casey@unrelated.example');
  assert.ok(unrelatedContact);
  assert.equal(unrelatedContact.contactConfidence.schema, 'jobos.contact-confidence.v1');
  assert.equal(unrelatedContact.contactConfidence.model, 'ContactConfidenceV2');
  assert.equal(unrelatedContact.contactConfidence.signals.publicObservation.observations[0].ownership, 'unrelated_domain');
  assert.equal(unrelatedContact.contactConfidence.signals.companyDomain.matchState, 'mismatch');
  assert.ok(!['A', 'B'].includes(unrelatedContact.evidenceTier));
  assert.equal(unrelatedContact.contactConfidence.signals.smtp.state, 'accepted');
  assert.equal(unrelatedContact.contactConfidence.usable, false);

  const stale = insertObservation(f.s, {
    id: 'src_stale',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://evidence.example/team',
    fetchedAt: STALE_AT,
    sourceType: 'page_fetch',
    email: 'stale@evidence.example',
  });
  const staleContact = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    type: 'email',
    value: 'stale@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [stale.id],
    checks: { exactPublic: true, sourceUrl: stale.url },
    humanApproved: true,
  }, FRESH_AT);
  const staleProjection = projectContactConfidenceV2(f.s, staleContact, { nowDate: new Date(FIXED_NOW) });
  assert.equal(staleProjection.signals.freshness.state, 'stale');
  assert.equal(staleProjection.usable, false);
  assert.notEqual(staleProjection.evidenceTier, 'A');
  assert.match(staleProjection.warnings.join(' '), /stale/i);

  const exactFresh = insertObservation(f.s, {
    id: 'src_exact_fresh_catch_all',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://evidence.example/team',
    fetchedAt: FRESH_AT,
    sourceType: 'page_fetch',
    email: 'exact@evidence.example',
  });
  const exactFreshContact = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    type: 'email',
    value: 'exact@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [exactFresh.id],
    checks: {
      exactPublic: true,
      sourceUrl: exactFresh.url,
      catchAll: { status: 'detected', method: 'fixture', evidence: 'domain accepts fixture sentinel' },
    },
    humanApproved: true,
  }, FRESH_AT);
  const exactFreshProjection = projectContactConfidenceV2(f.s, exactFreshContact, { nowDate: new Date(FIXED_NOW) });
  assert.equal(exactFreshProjection.evidenceTier, 'A');
  assert.equal(exactFreshProjection.signals.catchAll.state, 'detected');
  assert.equal(exactFreshProjection.usable, true);
  assert.match(exactFreshProjection.warnings.join(' '), /catch-all/i);

  const generated = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    type: 'email',
    value: 'generated@evidence.example',
    evidenceTier: 'C',
    verificationStatus: 'pattern_candidate',
    confidence: 'medium',
    sourceObservationIds: [stale.id],
    checks: {
      generated: true,
      pattern: 'first.last',
      supportCount: 2,
      dns: { status: 'mx_present', checks: { syntax: true, mxPresent: true, nsPresent: true, spfPresent: true, dmarcPresent: true } },
      smtp: { status: 'smtp_accepts_rcpt', fixture: true },
      catchAll: { status: 'detected', method: 'fixture', evidence: 'domain accepts fixture sentinel' },
    },
    humanApproved: true,
  }, FRESH_AT);
  const rawChecks = one(f.s, 'SELECT checks_json FROM contact_points WHERE id=?', [generated.id]).checks_json;
  const generatedProjection = projectContactConfidenceV2(f.s, generated, { nowDate: new Date(FIXED_NOW) });
  assert.equal(generatedProjection.signals.catchAll.state, 'detected');
  assert.equal(generatedProjection.signals.smtp.state, 'accepted');
  assert.equal(generatedProjection.evidenceTier, 'D');
  assert.equal(generatedProjection.usable, false);
  assert.equal(one(f.s, 'SELECT checks_json FROM contact_points WHERE id=?', [generated.id]).checks_json, rawChecks, 'derived projection must not rewrite raw checks');

  const suppressed = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    type: 'email',
    value: 'blocked@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [],
    checks: {},
    humanApproved: true,
    doNotUse: true,
  }, FRESH_AT);
  const suppressedProjection = projectContactConfidenceV2(f.s, suppressed, { nowDate: new Date(FIXED_NOW) });
  assert.equal(suppressedProjection.doNotUse, true);
  assert.equal(suppressedProjection.usable, false);
  assert.match(suppressedProjection.usabilityReason, /suppressed/i);
});

test('W05 finding 1/2 controlled domains, tier freshness, and pattern support use only qualifying evidence', async () => {
  const f = await fixture();
  run(f.s, 'UPDATE companies SET identity_sources_json=? WHERE id=?', [
    JSON.stringify([{ url: 'https://linkedin.com/company/evidence-labs' }]),
    f.job.company_id,
  ]);
  const linkedIn = insertObservation(f.s, {
    id: 'src_identity_linkedin',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://linkedin.com/company/evidence-labs',
    fetchedAt: FRESH_AT,
    email: 'person@linkedin.com',
    name: 'Person LinkedIn',
  });
  const companyPage = insertObservation(f.s, {
    id: 'src_identity_company',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://evidence.example/team/person',
    fetchedAt: FRESH_AT,
    email: 'person@evidence.example',
    name: 'Person Evidence',
  });
  await verifyObservationContacts(f.s, {
    runId: 'run_identity_domains',
    jobId: f.job.id,
    observationIds: [linkedIn.id, companyPage.id],
    env: {
      JOBOS_DNS_FIXTURE_JSON: JSON.stringify({
        'linkedin.com': {},
        'evidence.example': { mx: [{ exchange: 'mx.evidence.example', priority: 10 }], ns: ['ns.evidence.example'] },
      }),
      JOBOS_SMTP_PROBE: '',
    },
  });
  const linkedInRaw = one(f.s, "SELECT * FROM contact_points WHERE normalized_value='person@linkedin.com'");
  const companyRaw = one(f.s, "SELECT * FROM contact_points WHERE normalized_value='person@evidence.example'");
  assert.equal(linkedInRaw.evidence_tier, 'D');
  assert.equal(companyRaw.evidence_tier, 'A');
  const linkedInProjection = projectContactConfidenceV2(f.s, {
    id: linkedInRaw.id,
    personId: linkedInRaw.person_id,
    stakeholderId: linkedInRaw.stakeholder_id,
    companyId: linkedInRaw.company_id,
    type: linkedInRaw.type,
    value: linkedInRaw.value,
    evidenceTier: linkedInRaw.evidence_tier,
    verificationStatus: linkedInRaw.verification_status,
    sourceObservationIds: JSON.parse(linkedInRaw.source_observation_ids_json),
    checks: JSON.parse(linkedInRaw.checks_json),
    humanApproved: true,
    doNotUse: false,
  }, { nowDate: new Date(FIXED_NOW) });
  assert.deepEqual(linkedInProjection.signals.companyDomain.expectedDomains, ['evidence.example']);
  assert.equal(linkedInProjection.signals.companyDomain.matchState, 'mismatch');
  assert.ok(!['A', 'B', 'C'].includes(linkedInProjection.evidenceTier));

  const staleCompany = insertObservation(f.s, {
    id: 'src_tier_a_stale',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://evidence.example/team/stale',
    fetchedAt: STALE_AT,
    email: 'stale.a@evidence.example',
    name: 'Stale Alpha',
  });
  const unrelatedFresh = insertObservation(f.s, {
    id: 'src_tier_unrelated_fresh',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://directory.example/fresh',
    fetchedAt: FRESH_AT,
    sourceType: 'web_search',
    email: 'someone@directory.example',
    name: 'Fresh Directory',
  });
  const staleA = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    type: 'email',
    value: 'stale.a@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [staleCompany.id, unrelatedFresh.id],
    checks: { exactPublic: true },
    humanApproved: true,
  }, FRESH_AT);
  const staleAProjection = projectContactConfidenceV2(f.s, staleA, { nowDate: new Date(FIXED_NOW) });
  assert.equal(staleAProjection.evidenceTier, 'D');
  assert.equal(staleAProjection.signals.freshness.state, 'stale');
  assert.equal(staleAProjection.signals.freshness.sourceObservationId, staleCompany.id);
  assert.equal(staleAProjection.usable, false);

  const staleThirdParty = insertObservation(f.s, {
    id: 'src_tier_b_stale',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://credible-directory.example/casey',
    fetchedAt: STALE_AT,
    sourceType: 'web_search',
    email: 'casey@evidence.example',
    name: 'Casey Contact',
  });
  const stakeholderB = insertStakeholder(f.s, f.job, { id: 'stakeholder_stale_b', name: 'Casey Contact', role: 'Product Manager' });
  const staleB = upsertContactPoint(f.s, {
    companyId: f.job.company_id,
    stakeholderId: stakeholderB,
    type: 'email',
    value: 'casey@evidence.example',
    evidenceTier: 'B',
    verificationStatus: 'exact_public',
    confidence: 'medium',
    sourceObservationIds: [staleThirdParty.id, unrelatedFresh.id],
    checks: { exactPublic: true },
    humanApproved: true,
  }, FRESH_AT);
  const staleBProjection = projectContactConfidenceV2(f.s, staleB, { nowDate: new Date(FIXED_NOW) });
  assert.equal(staleBProjection.evidenceTier, 'D');
  assert.equal(staleBProjection.signals.freshness.state, 'stale');
  assert.equal(staleBProjection.signals.freshness.sourceObservationId, staleThirdParty.id);

  const addPattern = ({ id: patternId, pattern, sourceIds, supportCount = 2 }) => {
    const existing = one(f.s, 'SELECT id FROM email_patterns WHERE company_id=? AND domain=? AND pattern=?', [
      f.job.company_id,
      'evidence.example',
      pattern,
    ]);
    if (existing) {
      run(f.s, 'UPDATE email_patterns SET support_count=?,support_sources_json=?,confidence=?,updated_at=? WHERE id=?', [
        supportCount,
        JSON.stringify(sourceIds),
        'high',
        FRESH_AT,
        existing.id,
      ]);
      return;
    }
    run(f.s, 'INSERT INTO email_patterns VALUES (?,?,?,?,?,?,?,?,?)', [
      patternId,
      f.job.company_id,
      'evidence.example',
      pattern,
      supportCount,
      JSON.stringify(sourceIds),
      'high',
      FRESH_AT,
      FRESH_AT,
    ]);
  };
  const generatedProjection = ({ id: contactId, pattern, sourceIds }) => projectContactConfidenceV2(f.s, upsertContactPoint(f.s, {
    id: contactId,
    companyId: f.job.company_id,
    type: 'email',
    value: `${contactId}@evidence.example`,
    evidenceTier: 'C',
    verificationStatus: 'pattern_candidate',
    confidence: 'medium',
    sourceObservationIds: sourceIds,
    checks: { generated: true, pattern, supportCount: 2 },
    humanApproved: true,
  }, FRESH_AT), { nowDate: new Date(FIXED_NOW) });

  addPattern({ id: 'pattern_fake', pattern: 'first.last', sourceIds: ['missing_1', 'missing_2'] });
  const fakeSupport = generatedProjection({ id: 'generated_fake', pattern: 'first.last', sourceIds: ['missing_1', 'missing_2'] });
  assert.equal(fakeSupport.evidenceTier, 'D');
  assert.equal(fakeSupport.signals.pattern.distinctSourceObservations, 0);

  const duplicateOne = insertObservation(f.s, {
    id: 'src_pattern_duplicate_1', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/duplicate-1', fetchedAt: FRESH_AT, email: 'alice_alpha@evidence.example', name: 'Alice Alpha',
  });
  const duplicateTwo = insertObservation(f.s, {
    id: 'src_pattern_duplicate_2', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/duplicate-2', fetchedAt: FRESH_AT, email: 'alice_alpha@evidence.example', name: 'Alice Alpha',
  });
  addPattern({ id: 'pattern_duplicate', pattern: 'first_last', sourceIds: [duplicateOne.id, duplicateTwo.id] });
  const duplicateSupport = generatedProjection({ id: 'generated_duplicate', pattern: 'first_last', sourceIds: [duplicateOne.id, duplicateTwo.id] });
  assert.equal(duplicateSupport.evidenceTier, 'D');
  assert.equal(duplicateSupport.signals.pattern.distinctExamples, 1);

  const otherProfile = createProfile(f.s, 'Pattern Other').profile;
  const otherJobFile = path.join(f.root, 'pattern-other-job.md');
  writeFileSync(otherJobFile, '# Product Manager\nCompany: Other Pattern Co\n');
  const otherJob = importText(f.s, { profileId: otherProfile.id, filePath: otherJobFile }).job;
  const crossOne = insertObservation(f.s, {
    id: 'src_pattern_cross_1', companyId: otherJob.company_id, jobId: otherJob.id,
    url: 'https://evidence.example/team/cross-1', fetchedAt: FRESH_AT, email: 'aalpha@evidence.example', name: 'Alice Alpha',
  });
  const crossTwo = insertObservation(f.s, {
    id: 'src_pattern_cross_2', companyId: otherJob.company_id, jobId: otherJob.id,
    url: 'https://evidence.example/team/cross-2', fetchedAt: FRESH_AT, email: 'bbeta@evidence.example', name: 'Bruno Beta',
  });
  addPattern({ id: 'pattern_cross', pattern: 'flast', sourceIds: [crossOne.id, crossTwo.id] });
  assert.equal(generatedProjection({ id: 'generated_cross', pattern: 'flast', sourceIds: [crossOne.id, crossTwo.id] }).evidenceTier, 'D');

  const unrelatedOne = insertObservation(f.s, {
    id: 'src_pattern_unrelated_1', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://directory.example/unrelated-1', fetchedAt: FRESH_AT, sourceType: 'web_search', email: 'alicea@other.example', name: 'Alice Alpha',
  });
  const unrelatedTwo = insertObservation(f.s, {
    id: 'src_pattern_unrelated_2', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://directory.example/unrelated-2', fetchedAt: FRESH_AT, sourceType: 'web_search', email: 'brunob@other.example', name: 'Bruno Beta',
  });
  addPattern({ id: 'pattern_unrelated', pattern: 'firstl', sourceIds: [unrelatedOne.id, unrelatedTwo.id] });
  assert.equal(generatedProjection({ id: 'generated_unrelated', pattern: 'firstl', sourceIds: [unrelatedOne.id, unrelatedTwo.id] }).evidenceTier, 'D');

  const staleOne = insertObservation(f.s, {
    id: 'src_pattern_stale_1', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/stale-1', fetchedAt: STALE_AT, email: 'alicealpha@evidence.example', name: 'Alice Alpha',
  });
  const staleTwo = insertObservation(f.s, {
    id: 'src_pattern_stale_2', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/stale-2', fetchedAt: STALE_AT, email: 'brunobeta@evidence.example', name: 'Bruno Beta',
  });
  addPattern({ id: 'pattern_stale', pattern: 'firstlast', sourceIds: [staleOne.id, staleTwo.id] });
  const stalePattern = generatedProjection({ id: 'generated_stale', pattern: 'firstlast', sourceIds: [staleOne.id, staleTwo.id] });
  assert.equal(stalePattern.evidenceTier, 'D');
  assert.equal(stalePattern.signals.freshness.state, 'stale');

  const goodOne = insertObservation(f.s, {
    id: 'src_pattern_good_1', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/good-1', fetchedAt: FRESH_AT, email: 'alice@evidence.example', name: 'Alice Alpha',
  });
  const goodTwo = insertObservation(f.s, {
    id: 'src_pattern_good_2', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/good-2', fetchedAt: FRESH_AT, email: 'bruno@evidence.example', name: 'Bruno Beta',
  });
  addPattern({ id: 'pattern_good', pattern: 'first', sourceIds: [goodOne.id, goodTwo.id] });
  const goodPattern = generatedProjection({ id: 'generated_good', pattern: 'first', sourceIds: [goodOne.id, goodTwo.id] });
  assert.equal(goodPattern.evidenceTier, 'C', JSON.stringify(goodPattern.signals.pattern));
  assert.equal(goodPattern.signals.pattern.distinctExamples, 2);
  assert.equal(goodPattern.signals.pattern.distinctSourceObservations, 2);
  assert.ok([goodOne.id, goodTwo.id].includes(goodPattern.signals.freshness.sourceObservationId));
});

test('W05-CONTACT-02 catch-all detection is fixture-driven and independent from SMTP and DNS', async () => {
  const f = await fixture();
  const first = insertObservation(f.s, {
    id: 'src_pattern_1', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/a', fetchedAt: FRESH_AT, email: 'alice.alpha@evidence.example', name: 'Alice Alpha',
  });
  const second = insertObservation(f.s, {
    id: 'src_pattern_2', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/b', fetchedAt: FRESH_AT, email: 'bruno.beta@evidence.example', name: 'Bruno Beta',
  });
  insertStakeholder(f.s, f.job, { id: 'stakeholder_generated', name: 'Chris Candidate', role: 'Product Manager' });
  await verifyObservationContacts(f.s, {
    runId: 'run_pattern',
    jobId: f.job.id,
    observationIds: [first.id, second.id],
    env: {
      JOBOS_DNS_FIXTURE_JSON: JSON.stringify({
        'evidence.example': { mx: [{ exchange: 'mx.evidence.example', priority: 10 }], ns: ['ns.evidence.example'], txt: [['v=spf1 -all']], dmarc: [['v=DMARC1; p=reject']] },
      }),
      JOBOS_SMTP_PROBE: 'true',
      JOBOS_SMTP_FIXTURE_JSON: JSON.stringify({ 'evidence.example': 'smtp_accepts_rcpt' }),
      JOBOS_CATCH_ALL_FIXTURE_JSON: JSON.stringify({ 'evidence.example': { status: 'detected', evidence: 'fixture sentinel accepted' } }),
    },
  });
  const patternContacts = listContactPoints(f.s, { companyId: f.job.company_id, nowDate: new Date(FIXED_NOW) });
  const generated = patternContacts.find(contact => contact.checks.generated);
  assert.ok(generated);
  assert.equal(generated.contactConfidence.signals.dns.mx, 'present');
  assert.equal(generated.contactConfidence.signals.smtp.state, 'not_enabled');
  assert.equal(generated.contactConfidence.signals.catchAll.state, 'detected');
  assert.equal(generated.evidenceTier, 'D');
  assert.equal(generated.contactConfidence.usable, false);
});

test('W05-CONTACT-04 genuine schema-9 contact migrates without fabricated component evidence or network activity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w05-legacy-'));
  const dbDir = path.join(root, '.jobos');
  mkdirSync(dbDir, { recursive: true });
  const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
  const db = new SQL.Database();
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT INTO meta VALUES ('schema_version','9')");
  db.run(`CREATE TABLE contact_points (id TEXT PRIMARY KEY, person_id TEXT, stakeholder_id TEXT, company_id TEXT, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, evidence_tier TEXT NOT NULL, verification_status TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '{}', human_approved INTEGER NOT NULL DEFAULT 0, do_not_use INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin_research_run_id TEXT NOT NULL DEFAULT '')`);
  db.run(`INSERT INTO contact_points VALUES ('legacy_contact',NULL,NULL,'legacy_company','email','legacy@legacy.example','legacy@legacy.example','A','exact_public','high','[]','{}',1,0,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z','')`);
  writeFileSync(path.join(dbDir, 'jobos.sqlite'), Buffer.from(db.export()));
  db.close();

  const s = await openStore({ workspace: root });
  assert.equal(one(s, "SELECT value FROM meta WHERE key='schema_version'").value, '12');
  const raw = one(s, "SELECT * FROM contact_points WHERE id='legacy_contact'");
  const projection = projectContactConfidenceV2(s, {
    id: raw.id,
    personId: null,
    stakeholderId: null,
    companyId: raw.company_id,
    type: raw.type,
    value: raw.value,
    normalizedValue: raw.normalized_value,
    evidenceTier: raw.evidence_tier,
    verificationStatus: raw.verification_status,
    confidence: raw.confidence,
    sourceObservationIds: [],
    checks: {},
    humanApproved: true,
    doNotUse: false,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }, { nowDate: new Date(FIXED_NOW) });
  assert.equal(projection.signals.publicObservation.state, 'unknown');
  assert.equal(projection.signals.pattern.supportState, 'unknown');
  assert.equal(projection.signals.catchAll.state, 'unknown');
  assert.equal(projection.signals.freshness.state, 'unknown');
  assert.ok(!['A', 'B', 'C'].includes(projection.evidenceTier));
  assert.equal(raw.evidence_tier, 'A', 'migration must preserve the raw historical tier');
  assert.ok(all(s, "PRAGMA table_info(outreach_outcomes)").some(column => column.name === 'supersedes_outcome_id'));
});

test('W05 schema 12 composes over a persisted W02 schema-10 workspace', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w05-w02-migration-'));
  const w02 = await openStore({ workspace: root });
  assert.ok(one(w02, "SELECT name FROM sqlite_master WHERE type='table' AND name='form_submission_attempts'"));
  run(w02, 'DROP TABLE outreach_outcomes');
  run(w02, "UPDATE meta SET value='10' WHERE key='schema_version'");
  save(w02);
  w02.db.close();

  const composed = await openStore({ workspace: root });
  assert.equal(one(composed, "SELECT value FROM meta WHERE key='schema_version'").value, '12');
  assert.ok(one(composed, "SELECT name FROM sqlite_master WHERE type='table' AND name='form_submission_attempts'"));
  assert.ok(one(composed, "SELECT name FROM sqlite_master WHERE type='table' AND name='outreach_outcomes'"));
  assert.deepEqual(all(composed, 'PRAGMA foreign_key_check'), []);
});

test('W05-OUTREACH-01/02 role strategies produce materially distinct evidence-grounded review-only drafts', async () => {
  const f = await fixture();
  const roles = [
    ['stakeholder_recruiter', 'Riley Recruiter', 'Senior Technical Recruiter', 'recruiter_talent'],
    ['stakeholder_manager', 'Morgan Manager', 'Director of Product', 'hiring_manager'],
    ['stakeholder_peer', 'Parker Peer', 'Product Manager', 'functional_peer'],
    ['stakeholder_exec', 'Evan Executive', 'Founder and CEO', 'executive_founder'],
    ['stakeholder_unknown', 'Uma Unknown', 'Community Member', 'unknown'],
  ];
  const previousProvider = process.env.JOBOS_LLM_PROVIDER;
  process.env.JOBOS_LLM_PROVIDER = '';
  try {
    const drafts = [];
    for (const [id, name, role, expectedClass] of roles) {
      insertStakeholder(f.s, f.job, { id, name, role });
      assert.equal(classifyStakeholder({ role }), expectedClass);
      const draft = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId: id, goal: 'informational' });
      assert.equal(draft.stakeholderClass, expectedClass);
      assert.equal(draft.approvalStatus, 'draft_needs_human_review');
      assert.match(draft.content, /Draft only - not sent/);
      assert.match(draft.content, new RegExp(`Stakeholder class / strategy / selected path:\\*\\* ${expectedClass}`));
      assert.doesNotMatch(draft.content, /will send|sent on your behalf/i);
      drafts.push(draft);
    }
    const messages = drafts.map(draft => draft.content.match(/## Draft message\n([\s\S]*?)\n\n## Evidence used/)?.[1]);
    assert.equal(new Set(messages).size, roles.length);
    assert.match(messages[0], /team need|hiring process|fit/i);
    assert.match(messages[1], /team problem|role-specific|priorit/i);
    assert.match(messages[2], /workflow|team learning/i);
    assert.match(messages[3], /mission|problem/i);
    assert.match(messages[4], /informational|verify/i);
    assert.ok(drafts[4].warnings.some(warning => /verify.*relevance/i.test(warning)));
    for (const draft of drafts) {
      assert.match(draft.content, /reduced review time by 30%/);
      assert.doesNotMatch(draft.content, /invented|guaranteed reply|reply probability/i);
    }
  } finally {
    if (previousProvider === undefined) delete process.env.JOBOS_LLM_PROVIDER;
    else process.env.JOBOS_LLM_PROVIDER = previousProvider;
  }
});

test('W05 finding 5 role abbreviation classification uses real JavaScript word boundaries', () => {
  for (const role of ['HR', 'Senior HR business partner']) {
    assert.equal(classifyStakeholder({ role }), 'recruiter_talent');
  }
  for (const abbreviation of ['CEO', 'CTO', 'CPO', 'COO', 'VP']) {
    assert.equal(classifyStakeholder({ role: abbreviation }), 'executive_founder');
    assert.equal(classifyStakeholder({ role: `Acting ${abbreviation} for the platform team` }), 'executive_founder');
  }
  assert.equal(classifyStakeholder({ role: 'ceontology researcher' }), 'functional_peer');
  assert.equal(classifyStakeholder({ role: 'svpish community member' }), 'unknown');
});

test('W05 finding 3 plans and contacts are target-bound before provider invocation or persistence', async () => {
  const f = await fixture();
  const stakeholderA = insertStakeholder(f.s, f.job, { id: 'stakeholder_bound_a', name: 'Alex Alpha', role: 'Product Manager' });
  const stakeholderB = insertStakeholder(f.s, f.job, { id: 'stakeholder_bound_b', name: 'Blair Beta', role: 'Product Manager' });
  const sourceA = insertObservation(f.s, {
    id: 'src_bound_a', companyId: f.job.company_id, jobId: f.job.id,
    url: 'https://evidence.example/team/alex', fetchedAt: FRESH_AT, email: 'alex@evidence.example', name: 'Alex Alpha',
  });
  const contactA = upsertContactPoint(f.s, {
    id: 'contact_bound_a',
    companyId: f.job.company_id,
    stakeholderId: stakeholderA,
    type: 'email',
    value: 'alex@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [sourceA.id],
    checks: { exactPublic: true },
    humanApproved: true,
  }, FRESH_AT);

  const otherProfile = createProfile(f.s, 'Bound Other').profile;
  const otherJobFile = path.join(f.root, 'bound-other-job.md');
  writeFileSync(otherJobFile, '# Product Manager\nCompany: Bound Other Co\n');
  const otherJob = importText(f.s, { profileId: otherProfile.id, filePath: otherJobFile }).job;
  run(f.s, 'UPDATE companies SET website=?,domain=? WHERE id=?', ['https://bound-other.example', 'bound-other.example', otherJob.company_id]);
  const otherStakeholder = insertStakeholder(f.s, otherJob, { id: 'stakeholder_bound_other', name: 'Olive Other', role: 'Product Manager' });
  const otherSource = insertObservation(f.s, {
    id: 'src_bound_other', companyId: otherJob.company_id, jobId: otherJob.id,
    url: 'https://bound-other.example/team/olive', fetchedAt: FRESH_AT, email: 'olive@bound-other.example', name: 'Olive Other',
  });
  const otherContact = upsertContactPoint(f.s, {
    id: 'contact_bound_other',
    companyId: otherJob.company_id,
    stakeholderId: otherStakeholder,
    type: 'email',
    value: 'olive@bound-other.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [otherSource.id],
    checks: { exactPublic: true },
    humanApproved: true,
  }, FRESH_AT);

  const insertPlan = ({ id: planId, jobId, profileId, stakeholderId, contactId }) => run(f.s,
    'INSERT INTO outreach_plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [planId, jobId, profileId, stakeholderId, contactId, 'informational', 'email', 'high', 1, '{}', '[]', FRESH_AT]);
  insertPlan({ id: 'plan_cross_profile', jobId: f.job.id, profileId: otherProfile.id, stakeholderId: stakeholderA, contactId: contactA.id });
  insertPlan({ id: 'plan_cross_job', jobId: otherJob.id, profileId: otherProfile.id, stakeholderId: otherStakeholder, contactId: otherContact.id });
  insertPlan({ id: 'plan_valid_bound', jobId: f.job.id, profileId: f.profile.id, stakeholderId: stakeholderA, contactId: contactA.id });

  const provider = await fakeOutreachLlmServer([{
    strategyClass: 'functional_peer',
    evidence: [{ id: `job:${f.job.id}` }],
  }]);
  const restore = setProviderEnvironment(providerEnvironment(provider.baseUrl));
  try {
    const before = {
      artifacts: all(f.s, 'SELECT id FROM artifacts').length,
      threads: all(f.s, 'SELECT id FROM outreach_threads').length,
    };
    const unchanged = () => {
      assert.equal(all(f.s, 'SELECT id FROM artifacts').length, before.artifacts);
      assert.equal(all(f.s, 'SELECT id FROM outreach_threads').length, before.threads);
    };
    await assert.rejects(() => draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId: stakeholderA,
      goal: 'informational',
      planId: 'plan_cross_profile',
    }), /plan.*profile|profile.*plan/i);
    unchanged();
    await assert.rejects(() => draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId: stakeholderA,
      goal: 'informational',
      planId: 'plan_cross_job',
    }), /plan.*job|job.*plan/i);
    unchanged();
    await assert.rejects(() => draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId: stakeholderA,
      contactId: otherContact.id,
    }), /company/i);
    unchanged();
    await assert.rejects(() => draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId: stakeholderB,
      contactId: contactA.id,
    }), /stakeholder|person/i);
    unchanged();
    assert.equal(provider.requests.length, 0);

    const valid = await draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId: stakeholderA,
      goal: 'informational',
      planId: 'plan_valid_bound',
      contactId: contactA.id,
    });
    assert.equal(valid.approvalStatus, 'draft_needs_human_review');
    assert.equal(valid.mode, 'llm-selection');
    assert.equal(provider.requests.length, 1);
    assert.equal(all(f.s, 'SELECT id FROM artifacts').length, before.artifacts + 1);
    assert.equal(all(f.s, 'SELECT id FROM outreach_threads').length, before.threads + 1);
    assert.equal(one(f.s, 'SELECT contact_point_id FROM outreach_threads WHERE id=?', [valid.threadId]).contact_point_id, contactA.id);
  } finally {
    restore();
    await provider.close();
  }
});

test('W05 post-correction 1 rejects generic company inboxes for person-targeted drafts before side effects', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_generic_target', name: 'Gina Generic', role: 'Product Manager' });
  const observation = insertObservation(f.s, {
    id: 'src_generic_company',
    companyId: f.job.company_id,
    jobId: f.job.id,
    url: 'https://evidence.example/contact',
    fetchedAt: FRESH_AT,
    email: 'careers@evidence.example',
    name: '',
  });
  const generic = upsertContactPoint(f.s, {
    id: 'contact_generic_company',
    companyId: f.job.company_id,
    type: 'generic_inbox',
    value: 'careers@evidence.example',
    evidenceTier: 'A',
    verificationStatus: 'exact_public',
    confidence: 'high',
    sourceObservationIds: [observation.id],
    checks: { exactPublic: true },
    humanApproved: true,
  }, FRESH_AT);
  assert.equal(projectContactConfidenceV2(f.s, generic, { nowDate: new Date(FIXED_NOW) }).usable, true);

  const provider = await fakeOutreachLlmServer([{
    strategyClass: 'functional_peer',
    evidence: [{ id: `job:${f.job.id}` }],
  }]);
  const restore = setProviderEnvironment(providerEnvironment(provider.baseUrl));
  try {
    const before = {
      artifacts: all(f.s, 'SELECT id FROM artifacts').length,
      threads: all(f.s, 'SELECT id FROM outreach_threads').length,
    };
    await assert.rejects(() => draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId,
      contactId: generic.id,
    }), /generic company inbox.*person-targeted/i);
    assert.equal(provider.requests.length, 0);
    assert.equal(all(f.s, 'SELECT id FROM artifacts').length, before.artifacts);
    assert.equal(all(f.s, 'SELECT id FROM outreach_threads').length, before.threads);
  } finally {
    restore();
    await provider.close();
  }
});

test('W05 finding 4 provider prose or unsafe references trigger whole deterministic fallback', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_provider', name: 'Rory Recruiter', role: 'Recruiter' });
  const provider = await fakeOutreachLlmServer([
    {
      subject: 'Invented result',
      message: 'Hi Rory, I increased unsupported revenue by 900 percent and guaranteed a launch result.',
      strategyClass: 'recruiter_talent',
      evidence: [{ id: f.proof.id }],
    },
    {
      subject: 'Wrong role',
      message: 'Hi Rory, please critique the product roadmap as a functional peer and demand a referral.',
      strategyClass: 'functional_peer',
      evidence: [{ id: `job:${f.job.id}` }],
    },
    {
      subject: 'Already sent',
      message: 'JobOS sent this message already and will send a follow-up tomorrow.',
      strategyClass: 'recruiter_talent',
      evidence: [{ id: `job:${f.job.id}` }],
    },
    {
      subject: 'Mixed references',
      message: 'A provider-authored message that cites both known and unknown material.',
      strategyClass: 'recruiter_talent',
      evidence: [{ id: `job:${f.job.id}` }, { id: 'proof_unknown' }],
    },
    {
      strategyClass: 'recruiter_talent',
      evidence: [{ id: `job:${f.job.id}` }, { id: f.proof.id }],
    },
  ]);
  const restore = setProviderEnvironment(providerEnvironment(provider.baseUrl));
  try {
    const unsupportedClaim = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId, goal: 'claim' });
    assert.equal(unsupportedClaim.mode, 'deterministic-degraded');
    assert.doesNotMatch(unsupportedClaim.content, /unsupported revenue|900 percent|guaranteed a launch/i);
    assert.match(unsupportedClaim.warnings.join(' '), /rejected.*deterministic fallback/i);

    const wrongRole = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId, goal: 'wrong-role' });
    assert.equal(wrongRole.mode, 'deterministic-degraded');
    assert.doesNotMatch(wrongRole.content, /critique the product roadmap|demand a referral/i);

    const sendImplication = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId, goal: 'send-implication' });
    assert.equal(sendImplication.mode, 'deterministic-degraded');
    assert.doesNotMatch(sendImplication.content, /JobOS sent this message|will send a follow-up/i);

    const mixedReferences = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId, goal: 'mixed-reference' });
    assert.equal(mixedReferences.mode, 'deterministic-degraded');
    assert.doesNotMatch(mixedReferences.content, /provider-authored message/i);
    assert.ok(mixedReferences.evidence.some(item => item.id === `job:${f.job.id}`));
    assert.ok(mixedReferences.evidence.every(item => item.id !== 'proof_unknown'));

    const validSelection = await draftOutreach(f.s, { jobId: f.job.id, profileId: f.profile.id, stakeholderId, goal: 'valid-selection' });
    assert.equal(validSelection.mode, 'llm-selection');
    assert.equal(validSelection.approvalStatus, 'draft_needs_human_review');
    assert.match(validSelection.content, /reduced review time by 30%/);
    assert.doesNotMatch(validSelection.content, /will send|sent on your behalf|unsupported revenue|critique the product roadmap/i);
    assert.deepEqual(validSelection.evidence.map(item => item.id).sort(), [f.proof.id, `job:${f.job.id}`].sort());
    assert.equal(provider.requests.length, 5);
  } finally {
    restore();
    await provider.close();
  }
});

test('W05 post-correction 4 provider rejection values never cross persistence or returned-output boundaries', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_provider_secret', name: 'Sage Secret', role: 'Recruiter' });
  const secrets = [
    'SECRET_EVIDENCE_TOKEN_9f5f0d',
    'https://provider.invalid/private?token=SECRET_URL_TOKEN_7a81',
    'SECRET_STRATEGY_TOKEN_4c22',
    'SECRET_SUBJECT_TOKEN_18ab',
    'SECRET_MESSAGE_TOKEN_f021',
  ];
  const provider = await fakeOutreachLlmServer([{
    strategyClass: secrets[2],
    subject: secrets[3],
    message: secrets[4],
    evidence: [
      { id: `job:${f.job.id}` },
      { id: secrets[0] },
      { sourceUrl: secrets[1] },
    ],
  }]);
  const restore = setProviderEnvironment(providerEnvironment(provider.baseUrl));
  try {
    const draft = await draftOutreach(f.s, {
      jobId: f.job.id,
      profileId: f.profile.id,
      stakeholderId,
      goal: 'secret-containment',
    });
    assert.equal(draft.mode, 'deterministic-degraded');
    const rejectionWarnings = draft.warnings.filter(warning => /provider outreach selection was rejected/i.test(warning));
    assert.equal(rejectionWarnings.length, 1);
    assert.ok(rejectionWarnings[0].length <= 120);

    const returned = JSON.stringify(draft);
    const sqlite = Buffer.from(f.s.db.export());
    const workspace = workspaceText(path.join(f.root, 'jobos-workspace'));
    for (const secret of secrets) {
      assert.doesNotMatch(returned, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(sqlite.includes(Buffer.from(secret)), false);
      assert.doesNotMatch(workspace, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    restore();
    await provider.close();
  }
});

test('W05-OUTCOME-01/02 outcomes are explicit, append-only, idempotent, correctable, note-safe, and profile-scoped', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_outcome', name: 'Owen Outcome', role: 'Technical Recruiter' });
  const { sent } = await draftAndSend(f.s, f, stakeholderId);
  const first = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T10:00:00.000Z',
    note: 'Private local note',
    referenceId: 'mailbox:event:1',
    actor: 'user',
    source: 'cli',
  });
  assert.equal(first.idempotent, false);
  const replay = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T10:00:00.000Z',
    note: 'Private local note',
    referenceId: 'mailbox:event:1',
    actor: 'user',
    source: 'cli',
  });
  assert.equal(replay.id, first.id);
  assert.equal(replay.idempotent, true);
  assert.equal(all(f.s, 'SELECT * FROM outreach_outcomes').length, 1);

  const correction = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'declined',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'mailbox:event:1:correction',
    supersedesOutcomeId: first.id,
    correctionReason: 'Initial label was wrong',
    actor: 'user',
    source: 'cli',
  });
  assert.equal(correction.supersedesOutcomeId, first.id);
  assert.equal(all(f.s, 'SELECT * FROM outreach_outcomes').length, 2);
  const correctionAuditCount = all(f.s, "SELECT id FROM audit_log WHERE action='outreach.outcome.corrected'").length;
  const correctionReplay = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'declined',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'mailbox:event:1:correction',
    supersedesOutcomeId: first.id,
    correctionReason: 'Initial label was wrong',
    actor: 'user',
    source: 'cli',
  });
  assert.equal(correctionReplay.id, correction.id);
  assert.equal(correctionReplay.idempotent, true);
  assert.equal(all(f.s, 'SELECT * FROM outreach_outcomes').length, 2);
  assert.equal(all(f.s, "SELECT id FROM audit_log WHERE action='outreach.outcome.corrected'").length, correctionAuditCount);
  assert.throws(() => recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'reply_negative',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'mailbox:event:1:competing-correction',
    supersedesOutcomeId: first.id,
    correctionReason: 'Competing label',
  }), error => error?.code === 'outreach_outcome_already_superseded');
  assert.equal(all(f.s, 'SELECT * FROM outreach_outcomes').length, 2);
  assert.equal(all(f.s, "SELECT id FROM audit_log WHERE action='outreach.outcome.corrected'").length, correctionAuditCount);
  const history = listOutreachOutcomes(f.s, { profileId: f.profile.id, includeNotes: true });
  assert.equal(history.outcomes.length, 2);
  assert.equal(history.outcomes.find(row => row.id === first.id).supersededById, correction.id);
  assert.equal(history.outcomes.find(row => row.id === first.id).note, 'Private local note');

  assert.throws(() => recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'no_response',
    occurredAt: '2026-07-21T10:00:00.000Z',
    referenceId: 'missing-window',
  }), error => error?.code === 'outreach_outcome_window_required');

  const otherProfile = createProfile(f.s, 'Other Candidate').profile;
  assert.deepEqual(listOutreachOutcomes(f.s, { profileId: otherProfile.id }).outcomes, []);
  assert.throws(() => recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: otherProfile.id,
    type: 'declined',
    occurredAt: '2026-07-21T10:00:00.000Z',
    referenceId: 'cross-profile',
  }), error => error?.code === 'outreach_outcome_profile_mismatch');

  const auditPayload = all(f.s, "SELECT payload_json FROM audit_log WHERE action='outreach.outcome.recorded'").map(row => row.payload_json).join('\n');
  assert.doesNotMatch(auditPayload, /Private local note/);
  const mirror = YAML.parse(readFileSync(path.join(f.root, 'jobos-workspace', 'profiles', f.profile.id, 'outreach', 'outcomes.yaml'), 'utf8'));
  assert.equal(mirror.schema, 'jobos.outreach-outcome.v1');
  assert.equal(mirror.outcomes.length, 2);
});

test('W05 finding 6 rejects outcomes without a coherent human-sent boundary, chronology, or channel', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_outcome_guard', name: 'Grace Guard', role: 'Recruiter' });
  const draft = await draftOutreach(f.s, {
    jobId: f.job.id,
    profileId: f.profile.id,
    stakeholderId,
    goal: 'outcome-guard',
  });
  const outcomesMirror = path.join(f.root, 'jobos-workspace', 'profiles', f.profile.id, 'outreach', 'outcomes.yaml');
  const mutationCounts = () => ({
    outcomes: all(f.s, 'SELECT id FROM outreach_outcomes').length,
    audits: all(f.s, "SELECT id FROM audit_log WHERE action LIKE 'outreach.outcome.%'").length,
    mirror: existsSync(outcomesMirror),
  });
  const initial = mutationCounts();
  assert.throws(() => recordOutreachOutcome(f.s, {
    threadId: draft.threadId,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'unsent-outcome',
  }), error => error?.code === 'outreach_outcome_thread_unsent');
  assert.deepEqual(mutationCounts(), initial);

  const sent = markOutreachSent(f.s, { artifactId: draft.id, channel: 'email' });
  run(f.s, 'UPDATE outreach_threads SET sent_at=?,updated_at=? WHERE id=?', ['2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z', sent.id]);
  const invalidInputs = [
    {
      expectedCode: 'outreach_outcome_before_send',
      input: { type: 'reply_positive', occurredAt: '2026-07-18T12:00:00.000Z', referenceId: 'before-send' },
    },
    {
      expectedCode: 'outreach_outcome_future',
      input: { type: 'meeting_booked', occurredAt: '2999-01-01T00:00:00.000Z', referenceId: 'future-outcome' },
    },
    {
      expectedCode: 'outreach_outcome_window_future',
      input: {
        type: 'no_response',
        occurredAt: '2026-07-20T00:00:00.000Z',
        windowEndAt: '2999-01-02T00:00:00.000Z',
        referenceId: 'future-window',
      },
    },
    {
      expectedCode: 'outreach_outcome_channel_mismatch',
      input: { type: 'reply_neutral', occurredAt: '2026-07-20T00:00:00.000Z', channel: 'linkedin', referenceId: 'wrong-channel' },
    },
  ];
  for (const { input, expectedCode } of invalidInputs) {
    assert.throws(() => recordOutreachOutcome(f.s, {
      threadId: sent.id,
      profileId: f.profile.id,
      ...input,
    }), error => error?.code === expectedCode);
  }
  assert.deepEqual(mutationCounts(), initial);

  const reply = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T10:00:00.000Z',
    channel: 'email',
    referenceId: 'guard-valid-reply',
  });
  const meeting = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'meeting_booked',
    occurredAt: '2026-07-21T10:00:00.000Z',
    referenceId: 'guard-valid-meeting',
  });
  const noResponse = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'no_response',
    occurredAt: '2026-07-20T00:00:00.000Z',
    windowEndAt: '2026-07-22T00:00:00.000Z',
    referenceId: 'guard-valid-no-response',
  });
  assert.equal(reply.channel, 'email');
  assert.equal(meeting.channel, 'email');
  assert.equal(noResponse.channel, 'email');
  const replay = recordOutreachOutcome(f.s, {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'no_response',
    occurredAt: '2026-07-20T00:00:00.000Z',
    windowEndAt: '2026-07-22T00:00:00.000Z',
    referenceId: 'guard-valid-no-response',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(all(f.s, 'SELECT id FROM outreach_outcomes').length, 3);
});

test('W05 post-correction 2 freezes human-sent timestamp and channel across mark-sent replays', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_sent_freeze', name: 'Faye Frozen', role: 'Recruiter' });
  const draft = await draftOutreach(f.s, {
    jobId: f.job.id,
    profileId: f.profile.id,
    stakeholderId,
    goal: 'sent-freeze',
  });
  const first = markOutreachSent(f.s, { artifactId: draft.id, channel: 'email', notes: 'Original human-send note' });
  assert.equal(first.idempotent, false);
  const original = one(f.s, 'SELECT sent_at,channel,status,notes,updated_at FROM outreach_threads WHERE id=?', [first.id]);
  const outcome = recordOutreachOutcome(f.s, {
    threadId: first.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: first.sentAt,
    referenceId: 'sent-freeze-outcome',
  });
  const summaryNow = new Date(Date.parse(first.sentAt) + 1000);
  const beforeReplay = summarizeOutreachOutcomes(f.s, {
    profileId: f.profile.id,
    sinceDays: 30,
    nowDate: summaryNow,
  });
  assert.equal(beforeReplay.rates.anyReply.numerator, 1);
  assert.equal(beforeReplay.rates.anyReply.denominator, 1);

  const replay = markOutreachSent(f.s, { artifactId: draft.id, channel: 'email', notes: 'Ignored replay note' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.sentAt, first.sentAt);
  assert.deepEqual(one(f.s, 'SELECT sent_at,channel,status,notes,updated_at FROM outreach_threads WHERE id=?', [first.id]), original);
  assert.equal(all(f.s, "SELECT id FROM audit_log WHERE action='outreach.mark_sent.recorded'").length, 1);
  const afterReplay = summarizeOutreachOutcomes(f.s, {
    profileId: f.profile.id,
    sinceDays: 30,
    nowDate: summaryNow,
  });
  assert.equal(afterReplay.rates.anyReply.numerator, 1);
  assert.equal(afterReplay.rates.anyReply.denominator, 1);
  assert.equal(afterReplay.counts.reply_positive, 1);
  assert.equal(outcome.threadId, first.id);

  assert.throws(() => markOutreachSent(f.s, {
    artifactId: draft.id,
    channel: 'linkedin',
  }), error => error?.code === 'outreach_sent_channel_mismatch');
  assert.deepEqual(one(f.s, 'SELECT sent_at,channel,status,notes,updated_at FROM outreach_threads WHERE id=?', [first.id]), original);
  assert.equal(all(f.s, "SELECT id FROM audit_log WHERE action='outreach.mark_sent.recorded'").length, 1);
});

test('W05-REVIEW-01 weekly review reports observed counts, denominators, period, missing outcomes, and insufficient-data language', async () => {
  const f = await fixture();
  const recruiter = insertStakeholder(f.s, f.job, { id: 'stakeholder_review_r', name: 'Reese Recruiter', role: 'Recruiter' });
  const peer = insertStakeholder(f.s, f.job, { id: 'stakeholder_review_p', name: 'Pat Peer', role: 'Product Manager' });
  const recruiterThread = await draftAndSend(f.s, f, recruiter, 'email');
  const peerThread = await draftAndSend(f.s, f, peer, 'linkedin');
  assert.equal(one(f.s, 'SELECT sent_at FROM outreach_threads WHERE id=?', [recruiterThread.sent.id]).sent_at, '2026-07-19T12:00:00.000Z');
  recordOutreachOutcome(f.s, {
    threadId: recruiterThread.sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T09:00:00.000Z',
    referenceId: 'review-reply',
  });
  recordOutreachOutcome(f.s, {
    threadId: recruiterThread.sent.id,
    profileId: f.profile.id,
    type: 'meeting_booked',
    occurredAt: '2026-07-21T09:00:00.000Z',
    referenceId: 'review-meeting',
  });
  const summary = summarizeOutreachOutcomes(f.s, {
    profileId: f.profile.id,
    sinceDays: 30,
    nowDate: new Date(FIXED_NOW),
    minimumSampleSize: 5,
  });
  assert.equal(summary.schema, 'jobos.outreach-outcome-summary.v1');
  assert.equal(summary.period.start, '2026-06-23T12:00:00.000Z');
  assert.equal(summary.denominators.sentThreads, 2);
  assert.equal(summary.denominators.observedThreads, 1);
  assert.equal(summary.denominators.missingOutcomeThreads, 1);
  assert.equal(summary.counts.reply_positive, 1);
  assert.equal(summary.counts.meeting_booked, 1);
  assert.equal(summary.rates.replyPositive.denominator, 2);
  assert.equal(summary.insufficientData, true);
  assert.match(summary.sampleLabel, /observed|sample|insufficient/i);
  assert.equal(summary.handoff.consumerPolicy, 'observations_only_no_next_action_or_learning');
  assert.doesNotMatch(JSON.stringify(summary), /reply probability|causal lift|likely to reply/i);
  assert.match(summary.interpretation, /do not establish.*caused/i);

  const review = weekly(f.s, f.profile.id, { recordRun: false, nowDate: new Date(FIXED_NOW) });
  assert.equal(review.metrics.outreachOutcomes.schema, 'jobos.outreach-outcome-summary.v1');
  assert.match(review.content, /Observed outreach outcomes/);
  assert.match(review.content, /denominator/i);
  assert.match(review.content, /insufficient data|small sample/i);
  assert.doesNotMatch(review.content, /reply probability|causal lift|likely to reply/i);
  assert.match(review.content, /do not establish.*caused/i);
  assert.ok(peerThread.sent.id);
});

test('W05 finding 7 summaries use one explicit sent-thread cohort for all counts and rates', async () => {
  const f = await fixture();
  const stakeholderId = insertStakeholder(f.s, f.job, { id: 'stakeholder_cohort', name: 'Cory Cohort', role: 'Recruiter' });
  const cohortThread = await draftAndSend(f.s, f, stakeholderId, 'email');
  const original = recordOutreachOutcome(f.s, {
    threadId: cohortThread.sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'cohort-original',
  });
  recordOutreachOutcome(f.s, {
    threadId: cohortThread.sent.id,
    profileId: f.profile.id,
    type: 'meeting_booked',
    occurredAt: '2026-07-21T10:00:00.000Z',
    referenceId: 'cohort-meeting',
  });
  recordOutreachOutcome(f.s, {
    threadId: cohortThread.sent.id,
    profileId: f.profile.id,
    type: 'declined',
    occurredAt: '2026-07-20T10:00:00.000Z',
    referenceId: 'cohort-correction',
    supersedesOutcomeId: original.id,
    correctionReason: 'Corrected reply label',
  });

  const oldThread = await draftAndSend(f.s, f, stakeholderId, 'email');
  run(f.s, 'UPDATE outreach_threads SET sent_at=?,updated_at=? WHERE id=?', ['2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', oldThread.sent.id]);
  recordOutreachOutcome(f.s, {
    threadId: oldThread.sent.id,
    profileId: f.profile.id,
    type: 'reply_positive',
    occurredAt: '2026-07-20T12:00:00.000Z',
    referenceId: 'outside-cohort-outcome',
  });

  const unsent = await draftOutreach(f.s, {
    jobId: f.job.id,
    profileId: f.profile.id,
    stakeholderId,
    goal: 'historical-unsent',
  });
  run(f.s, `INSERT INTO outreach_outcomes
    (id,thread_id,profile_id,job_id,stakeholder_id,contact_point_id,role_class,contact_tier,contact_path,channel,outcome_type,occurred_at,window_end_at,recorded_at,note,actor,source,reference_id,supersedes_outcome_id,correction_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'outcome_historical_unsent',
    unsent.threadId,
    f.profile.id,
    f.job.id,
    stakeholderId,
    null,
    'recruiter_talent',
    '',
    'unknown',
    'email',
    'reply_positive',
    '2026-07-20T12:00:00.000Z',
    null,
    '2026-07-20T12:00:00.000Z',
    '',
    'legacy',
    'legacy_import',
    'historical-unsent',
    null,
    '',
  ]);

  const summary = summarizeOutreachOutcomes(f.s, {
    profileId: f.profile.id,
    sinceDays: 30,
    nowDate: new Date(FIXED_NOW),
    minimumSampleSize: 5,
  });
  assert.equal(summary.cohort.definition, 'threads human-recorded as sent during the observation period');
  assert.equal(summary.denominators.sentThreads, 1);
  assert.equal(summary.denominators.observedThreads, 1);
  assert.equal(summary.denominators.observedOutcomeRecords, 2);
  assert.equal(summary.counts.reply_positive, 0);
  assert.equal(summary.counts.declined, 1);
  assert.equal(summary.counts.meeting_booked, 1);
  assert.equal(summary.rates.anyReply.numerator, 0);
  assert.equal(summary.rates.anyReply.denominator, 1);
  assert.equal(summary.rates.meetingBooked.numerator, 1);
  assert.equal(summary.rates.meetingBooked.denominator, 1);
  assert.equal(summary.rates.meetingBooked.percent, 100);
  assert.equal(summary.rates.meetingBooked.label, '1 of 1 sent-thread cohort member(s) had a booked meeting observed in this sample.');
  for (const rate of Object.values(summary.rates)) {
    assert.ok(rate.percent == null || (rate.percent >= 0 && rate.percent <= 100));
  }
  assert.equal(summary.byChannel.reduce((count, group) => count + group.observationDenominator, 0), 2);

  const emptyProfile = createProfile(f.s, 'Empty Cohort').profile;
  const empty = summarizeOutreachOutcomes(f.s, {
    profileId: emptyProfile.id,
    sinceDays: 30,
    nowDate: new Date(FIXED_NOW),
  });
  assert.equal(empty.denominators.sentThreads, 0);
  for (const rate of Object.values(empty.rates)) assert.equal(rate.percent, null);
});

test('W05 outcome CLI JSON and domain tools expose deterministic profile-scoped contracts', async () => {
  const f = await fixture();
  const stakeholder = insertStakeholder(f.s, f.job, { id: 'stakeholder_cli', name: 'Cleo CLI', role: 'Recruiter' });
  const { sent } = await draftAndSend(f.s, f, stakeholder, 'email');
  save(f.s);
  f.s.db.close();
  const env = { ...process.env, JOBOS_HOME: f.root, JOBOS_LLM_PROVIDER: '', JOBOS_SMTP_PROBE: '' };
  const recorded = spawnSync(process.execPath, [
    'src/cli.js', 'outreach', 'outcome', 'record', '--workspace', f.root,
    '--thread', sent.id, '--profile', f.profile.id, '--type', 'no_response',
    '--occurred-at', '2026-07-20T00:00:00.000Z', '--window-end', '2026-07-22T00:00:00.000Z',
    '--reference', 'cli:no-response:1', '--note', 'local only', '--json',
  ], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stderr);
  const recordJson = JSON.parse(recorded.stdout);
  assert.equal(recordJson.schema, 'jobos.outreach-outcome.v1');
  assert.equal(recordJson.outcomeType, 'no_response');
  assert.equal(recordJson.windowEndAt, '2026-07-22T00:00:00.000Z');

  const listed = spawnSync(process.execPath, [
    'src/cli.js', 'outreach', 'outcomes', '--workspace', f.root, '--profile', f.profile.id, '--json',
  ], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const listJson = JSON.parse(listed.stdout);
  assert.equal(listJson.schema, 'jobos.outreach-outcome-list.v1');
  assert.equal(listJson.outcomes.length, 1);
  assert.equal(listJson.outcomes[0].note, 'local only');

  const reopened = await openStore({ workspace: f.root });
  const toolList = await callDomainTool(reopened, 'list_outreach_outcomes', { profileId: f.profile.id }, { actor: 'agent' });
  assert.equal(toolList.outcomes.length, 1);
  assert.equal('note' in toolList.outcomes[0], false, 'domain-tool projection must not expose private notes');
  const replay = await callDomainTool(reopened, 'record_outreach_outcome', {
    threadId: sent.id,
    profileId: f.profile.id,
    type: 'no_response',
    occurredAt: '2026-07-20T00:00:00.000Z',
    windowEndAt: '2026-07-22T00:00:00.000Z',
    referenceId: 'cli:no-response:1',
  }, { actor: 'agent' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.note, undefined);
});
