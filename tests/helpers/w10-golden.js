import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addAnswer } from '../../src/answers.js';
import { approveArtifact, createArtifact } from '../../src/artifacts.js';
import { recordJobFeedback, syncMemoryObservations } from '../../src/career-memory-observations.js';
import { refreshMemoryProjection } from '../../src/career-memory-projections.js';
import { createMemoryProposal, transitionMemoryProposal, undoMemoryTransition } from '../../src/career-memory-proposals.js';
import { retrieveCareerMemory } from '../../src/career-memory-retrieval.js';
import { callDomainTool } from '../../src/domain-tools.js';
import { all, one, openStore, run, save } from '../../src/db.js';
import { createSearch, runAllSearches } from '../../src/discovery.js';
import { buildFormSnapshot, persistFormSnapshot } from '../../src/forms.js';
import { DOM_ADAPTER_MANIFEST } from '../../src/form-browser.js';
import { validateFormFillAuthorization } from '../../src/form-actions.js';
import { validateFormSubmissionAuthorization } from '../../src/form-submission.js';
import { importNormalized, importText, updateJobStatus } from '../../src/jobs.js';
import { attestApplicationSubmitted, createApplicationPacket, showApplicationPacket } from '../../src/packets.js';
import { addProof, createProfile } from '../../src/profiles.js';
import { compileApplicationReadiness } from '../../src/readiness.js';
import { projectContactConfidenceV2, upsertContactPoint } from '../../src/research/contacts.js';
import { saveSourceObservation } from '../../src/research/sources.js';
import { score } from '../../src/scoring.js';
import { appCreate } from '../../src/tracking.js';
import { createCompleteResumeFixture } from '../fixtures/resume.js';

export const W10_AS_OF = '2026-07-22T12:00:00.000Z';
const W10_FRESH_UNTIL = '2026-07-23T12:00:00.000Z';
const W10_CONTACT_NOW = '2026-07-22T12:00:00.000Z';
const W10_CONTACT_FRESH = '2026-07-10T12:00:00.000Z';
const W10_CONTACT_STALE = '2026-02-01T12:00:00.000Z';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function loadW10Manifest(root = path.resolve('tests/fixtures/w10')) {
  const manifestPath = path.join(root, 'manifest.json');
  if (!readable(manifestPath)) throw new Error('W10 fixture missing: manifest');
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function loadW10Fixture(family, root = path.resolve('tests/fixtures/w10')) {
  const manifest = loadW10Manifest(root);
  const entry = manifest.fixtures?.find(candidate => candidate.family === family);
  if (!entry) throw new Error(`W10 fixture missing: ${family}`);
  const fixturePath = path.join(root, entry.file);
  if (!readable(fixturePath)) throw new Error(`W10 fixture missing: ${family}`);
  return { entry, fixture: JSON.parse(readFileSync(fixturePath, 'utf8')) };
}

function readable(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

async function withFixedClock(fn) {
  const RealDate = globalThis.Date;
  const fixedMs = RealDate.parse(W10_AS_OF);
  class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length ? args[0] : fixedMs);
    }
    static now() {
      return fixedMs;
    }
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

async function withWorkspace(prefix, fn) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await withFixedClock(async () => fn(await openStore({ workspace: root }), root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJob(root, name, text) {
  const filePath = path.join(root, name);
  writeFileSync(filePath, text);
  return filePath;
}

function liveness(jobId, status, source = 'greenhouse') {
  return {
    version: 1,
    jobId,
    status,
    checkedAt: W10_AS_OF,
    requestedUrl: `https://boards.example.test/jobs/${jobId}`,
    finalUrl: `https://boards.example.test/jobs/${jobId}`,
    httpStatus: status === 'active' ? 200 : status === 'expired' ? 404 : null,
    reasonCodes: [status === 'active' ? 'listed_in_current_listing' : status === 'expired' ? 'http_404' : 'manual_or_unchecked'],
    evidence: [],
    source,
    freshUntil: W10_FRESH_UNTIL
  };
}

function setLiveness(store, jobId, status, source = 'greenhouse') {
  const value = liveness(jobId, status, source);
  run(store, 'UPDATE jobs SET liveness_status=?,liveness_checked_at=?,liveness_json=? WHERE id=?', [status, W10_AS_OF, JSON.stringify(value), jobId]);
  save(store);
  return value;
}

async function documentCompletenessProjection() {
  return withWorkspace('jobos-w10-doc-', async (store, root) => {
    const profile = createProfile(store, 'W10 Document Candidate').profile;
    const proof = addProof(store, profile.id, 'Led a verified launch that improved activation by 30%.', 'W10 portfolio evidence', ['product', 'launch'], ['30%']);
    const job = importText(store, {
      profileId: profile.id,
      filePath: writeJob(root, 'document-job.md', 'Title: Product Manager\nCompany: W10 Documents\nLocation: Remote\n\nMust lead product launches.')
    }).job;
    setLiveness(store, job.id, 'active', 'manual');
    const readiness = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id });
    const publicProjection = {
      family: 'document-completeness',
      asOf: W10_AS_OF,
      profileId: profile.id,
      jobId: job.id,
      version: readiness.version,
      status: readiness.status,
      valid: readiness.blockers.length === 0,
      blockerCodes: readiness.blockers.map(item => item.code).sort(),
      artifactStates: Object.fromEntries(['resume', 'coverLetter'].map(key => {
        const value = readiness.materials[key];
        return [key, {
          required: value.required,
          state: value.status,
          approvalStatus: value.approvalStatus ?? null,
          valid: value.semanticValidation?.valid ?? null
        }];
      }))
    };
    const serialized = canonicalJson(publicProjection);
    assert.equal(serialized.includes(proof.summary), false);
    return publicProjection;
  });
}

async function scoreStabilityProjection() {
  return withWorkspace('jobos-w10-score-', async (store, root) => {
    const profile = createProfile(store, 'W10 Product Manager').profile;
    addProof(store, profile.id, 'Led product discovery and launched a workflow used by 30 teams.', 'W10 verified portfolio', ['product', 'discovery', 'launch'], ['30']);
    const job = importText(store, {
      profileId: profile.id,
      filePath: writeJob(root, 'score-job.md', 'Title: Product Manager\nCompany: W10 Scores\nLocation: Remote\n\nLead product discovery, analytics, and cross-functional launches.')
    }).job;
    setLiveness(store, job.id, 'active');
    const opts = { now: () => Date.parse(W10_AS_OF), providerConfig: { configured: false } };
    const active = await score(store, job.id, profile.id, opts);
    run(store, "DELETE FROM audit_log WHERE action='job.scored'");
    const repeated = await score(store, job.id, profile.id, opts);
    run(store, "DELETE FROM audit_log WHERE action='job.scored'");
    const stableFields = value => ({
      contract: value.contract,
      jobId: value.jobId,
      profileId: value.profileId,
      mode: value.mode,
      overall: value.overall,
      baseOverall: value.baseOverall,
      scoreStatus: value.scoreStatus,
      evidenceCoverage: value.evidenceCoverage,
      dimensions: value.dimensions,
      constraints: value.constraints,
      postingRisks: value.postingRisks,
      reasoning: value.reasoning
    });
    setLiveness(store, job.id, 'uncertain', 'manual');
    const uncertain = await score(store, job.id, profile.id, opts);
    const persistedBeforeExpired = one(store, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [job.id]);
    setLiveness(store, job.id, 'expired');
    let expiredCode = null;
    try {
      await score(store, job.id, profile.id, opts);
    } catch (error) {
      expiredCode = error.code;
    }
    const persistedAfterExpired = one(store, 'SELECT fit_score,score_json FROM jobs WHERE id=?', [job.id]);
    return {
      family: 'score-stability',
      asOf: W10_AS_OF,
      score: stableFields(active),
      byteStableRepeat: canonicalJson(stableFields(active)) === canonicalJson(stableFields(repeated)),
      uncertainGate: {
        status: uncertain.postingLiveness.status,
        fitUnchanged: canonicalJson(stableFields(active)) === canonicalJson(stableFields(uncertain))
      },
      expiredGate: {
        code: expiredCode,
        persistedFitUnchanged: canonicalJson(persistedBeforeExpired) === canonicalJson(persistedAfterExpired)
      }
    };
  });
}

function observation(store, { id, companyId, jobId, url, fetchedAt, email, name = 'Casey Contact' }) {
  const value = {
    id,
    companyId,
    jobId,
    url,
    canonicalUrl: url,
    title: 'W10 contact source',
    snippet: `Contact ${email}`,
    sourceType: 'page_fetch',
    provider: 'page_fetch',
    query: '',
    metadata: { emails: [email], emailContexts: [{ email, name, context: 'Team contact', generic: false }] },
    fetchedAt,
    contentHash: `hash-${id}`
  };
  saveSourceObservation(store, value);
  return value;
}

function contactSummary(projection) {
  return {
    evidenceTier: projection.evidenceTier,
    usable: projection.usable,
    usabilityReason: projection.usabilityReason,
    freshness: projection.signals.freshness.state,
    domainMatch: projection.signals.companyDomain.matchState,
    catchAll: projection.signals.catchAll.state,
    generated: projection.signals.pattern.state,
    doNotUse: projection.doNotUse,
    warnings: projection.warnings
  };
}

async function contactTieringProjection() {
  return withWorkspace('jobos-w10-contact-', async (store, root) => {
    const profile = createProfile(store, 'W10 Contact Candidate').profile;
    const job = importText(store, {
      profileId: profile.id,
      filePath: writeJob(root, 'contact-job.md', 'Title: Staff Product Manager\nCompany: Evidence Labs\nLocation: Remote\n\nLead product discovery.')
    }).job;
    run(store, 'UPDATE companies SET website=?,domain=? WHERE id=?', ['https://evidence.example', 'evidence.example', job.company_id]);
    const fresh = observation(store, { id: 'w10-contact-fresh', companyId: job.company_id, jobId: job.id, url: 'https://evidence.example/team/casey', fetchedAt: W10_CONTACT_FRESH, email: 'casey@evidence.example' });
    const stale = observation(store, { id: 'w10-contact-stale', companyId: job.company_id, jobId: job.id, url: 'https://evidence.example/team/stale', fetchedAt: W10_CONTACT_STALE, email: 'stale@evidence.example' });
    const catchAll = observation(store, { id: 'w10-contact-catchall', companyId: job.company_id, jobId: job.id, url: 'https://evidence.example/team/catchall', fetchedAt: W10_CONTACT_FRESH, email: 'catchall@evidence.example' });
    const unrelated = observation(store, { id: 'w10-contact-unrelated', companyId: job.company_id, jobId: job.id, url: 'https://unrelated.example/team', fetchedAt: W10_CONTACT_FRESH, email: 'casey@unrelated.example' });
    const patternOne = observation(store, { id: 'w10-pattern-one', companyId: job.company_id, jobId: job.id, url: 'https://evidence.example/team/alice', fetchedAt: W10_CONTACT_FRESH, email: 'alice@evidence.example', name: 'Alice Alpha' });
    const patternTwo = observation(store, { id: 'w10-pattern-two', companyId: job.company_id, jobId: job.id, url: 'https://evidence.example/team/bruno', fetchedAt: W10_CONTACT_FRESH, email: 'bruno@evidence.example', name: 'Bruno Beta' });
    run(store, 'INSERT INTO email_patterns VALUES (?,?,?,?,?,?,?,?,?)', ['w10-pattern', job.company_id, 'evidence.example', 'first', 2, JSON.stringify([patternOne.id, patternTwo.id]), 'high', W10_CONTACT_FRESH, W10_CONTACT_FRESH]);
    const create = input => projectContactConfidenceV2(store, upsertContactPoint(store, input, W10_CONTACT_FRESH), { nowDate: new Date(W10_CONTACT_NOW) });
    const supported = create({ id: 'w10-supported', companyId: job.company_id, type: 'email', value: 'casey@evidence.example', evidenceTier: 'A', verificationStatus: 'exact_public', confidence: 'high', sourceObservationIds: [fresh.id], checks: { exactPublic: true }, humanApproved: true });
    const staleProjection = create({ id: 'w10-stale', companyId: job.company_id, type: 'email', value: 'stale@evidence.example', evidenceTier: 'A', verificationStatus: 'exact_public', confidence: 'high', sourceObservationIds: [stale.id], checks: { exactPublic: true }, humanApproved: true });
    const catchAllProjection = create({ id: 'w10-catchall', companyId: job.company_id, type: 'email', value: 'catchall@evidence.example', evidenceTier: 'A', verificationStatus: 'exact_public', confidence: 'high', sourceObservationIds: [catchAll.id], checks: { exactPublic: true, catchAll: { status: 'detected', method: 'fixture', evidence: 'domain accepts fixture sentinel' } }, humanApproved: true });
    const generated = create({ id: 'w10-generated', companyId: job.company_id, type: 'email', value: 'generated@evidence.example', evidenceTier: 'C', verificationStatus: 'pattern_candidate', confidence: 'medium', sourceObservationIds: [patternOne.id, patternTwo.id], checks: { generated: true, pattern: 'first', supportCount: 2 }, humanApproved: true });
    const suppressed = create({ id: 'w10-suppressed', companyId: job.company_id, type: 'email', value: 'blocked@evidence.example', evidenceTier: 'A', verificationStatus: 'exact_public', confidence: 'high', sourceObservationIds: [fresh.id], checks: { exactPublic: true }, humanApproved: true, doNotUse: true });
    const unrelatedProjection = create({ id: 'w10-unrelated', companyId: job.company_id, type: 'email', value: 'casey@unrelated.example', evidenceTier: 'A', verificationStatus: 'exact_public', confidence: 'high', sourceObservationIds: [unrelated.id], checks: { exactPublic: true }, humanApproved: true });
    return {
      family: 'contact-tiering',
      asOf: W10_AS_OF,
      cases: {
        supported: contactSummary(supported),
        stale: contactSummary(staleProjection),
        catchAll: contactSummary(catchAllProjection),
        generated: contactSummary(generated),
        suppressed: contactSummary(suppressed),
        unrelatedDomain: contactSummary(unrelatedProjection)
      }
    };
  });
}

function normalizedJob(id, title, source = 'greenhouse') {
  return {
    id,
    title,
    company: 'W10 Discovery Co',
    location: 'Remote',
    url: `https://${source}.example.test/jobs/${id}`,
    source,
    sourceId: id,
    description: `${title} at W10 Discovery Co`,
    postedDate: '2026-07-20T00:00:00.000Z',
    compensation: { text: '', min: null, max: null, currency: '', interval: 'unknown' },
    workModel: 'remote',
    employmentTypes: ['full-time'],
    department: 'Product',
    sourceNativeFields: {},
    livenessHint: null
  };
}

async function discoveryPartialsProjection() {
  return withWorkspace('jobos-w10-discovery-', async store => {
    const profile = createProfile(store, 'W10 Discovery Candidate').profile;
    const successful = createSearch(store, { name: 'w10-source-success', profileId: profile.id, adapter: 'greenhouse', config: { sourceCase: 'success' }, minFit: 50 });
    const failing = createSearch(store, { name: 'w10-source-backoff', profileId: profile.id, adapter: 'lever', config: { sourceCase: 'backoff' }, minFit: 50 });
    const adapter = {
      async fetchJobs(config) {
        if (config.sourceCase === 'backoff') throw Object.assign(new Error('fixture source backed off'), { code: 'source_backoff', status: 429 });
        return [normalizedJob('w10-active', 'Active Product Role'), normalizedJob('w10-uncertain', 'Uncertain Product Role')];
      }
    };
    const checkLiveness = async job => job.sourceId === 'w10-uncertain'
      ? liveness(job.sourceId, 'uncertain', job.source)
      : liveness(job.sourceId, 'active', job.source);
    const scoreJob = async (_store, jobId, profileId) => ({ overall: 72, jobId, profileId, mode: 'deterministic-degraded', postingLiveness: { contract: 'jobos.posting-liveness.v1', jobId, status: jobId.includes('uncertain') ? 'uncertain' : 'active', checkedAt: W10_AS_OF, reasonCodes: [], source: 'greenhouse' } });
    const result = await runAllSearches(store, { profileId: profile.id, adapter, importJob: importNormalized, checkLiveness, scoreJob, now: () => Date.parse(W10_AS_OF) });
    return {
      family: 'discovery-partials-liveness',
      asOf: W10_AS_OF,
      status: result.status,
      count: result.count,
      searches: result.runs.map(runResult => ({
        searchId: runResult.searchId,
        searchName: runResult.searchName,
        adapter: runResult.adapter,
        status: runResult.status,
        errorCodes: runResult.errors.map(error => error.code).sort(),
        jobs: runResult.jobs.map(job => ({ sourceId: job.sourceId, outcome: job.outcome, liveness: job.liveness.status, source: job.liveness.source }))
      })),
      survivingJobSources: all(store, 'SELECT id,source,title FROM jobs ORDER BY title').map(row => ({ jobId: row.id, source: row.source, title: row.title })),
      expectedSearchIds: [successful.id, failing.id].sort()
    };
  });
}

function semanticResume(revision, proof, renderManifest) {
  return {
    sourceResumeRevisionId: revision.id,
    document: revision.document,
    coverage: { schemaVersion: 1, matrix: [{ requirementId: 'requirement_launch', status: 'supported', proofPointIds: [proof.id], sourceEntryIds: ['bullet_fixture'], matchedTerms: ['launch'], confidence: 'high' }], summary: { importantRequirementCount: 1, supportedImportantCount: 1, coverageRatio: 1, matchedRequirementIds: ['requirement_launch'], partiallySupportedRequirementIds: [], omittedSupportedRequirementIds: [], unsupportedRequirementIds: [] } },
    validation: { valid: true, schemaVersion: 1, sourceResumeRevisionId: revision.id, blockers: [], warnings: [] },
    layoutProfile: { templateId: 'jobos-classic', templateVersion: 1, roleFamily: 'professional', sectionOrder: ['summary', 'experience', 'skills', 'education'], density: 'standard', pageSize: 'letter', pageLimit: 2 },
    renderManifest
  };
}

async function seedPacketWorkspace(store, root) {
  const profile = createProfile(store, 'W10 Packet Candidate').profile;
  const proof = addProof(store, profile.id, 'Led a grounded product launch that improved activation by 30%.', 'W10 portfolio', ['product', 'launch'], ['30%']);
  const resumeRevision = createCompleteResumeFixture(store, profile, proof);
  const job = importText(store, { profileId: profile.id, filePath: writeJob(root, 'packet-job.md', 'Title: Product Manager\nCompany: W10 Packet Co\nLocation: Remote\n\nMust lead product launches and improve activation.') }).job;
  const resumePdfPath = path.join('jobs', job.id, 'artifacts', 'resume-tailored.pdf');
  const resumePdfBytes = Buffer.from('%PDF-1.4\n% JobOS deterministic W10 fixture\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
  const resumePdfHash = crypto.createHash('sha256').update(resumePdfBytes).digest('hex');
  const resumeSemantic = semanticResume(resumeRevision, proof, { format: 'pdf', status: 'passed', pdfPath: resumePdfPath, pdfHash: resumePdfHash, blockers: [], warnings: [] });
  run(store, 'UPDATE jobs SET fit_score=?,score_json=? WHERE id=?', [85, JSON.stringify({ overall: 85, confidence: 'high', mode: 'fixture', dimensions: {}, redFlags: [], reasoning: 'fixture' }), job.id]);
  save(store);
  addAnswer(store, { profileId: profile.id, category: 'motivation', question: 'Why this role?', answer: 'Verified launch experience matches this role.', sensitivity: 'public', reuseScope: 'global', verificationStatus: 'verified', sourceRef: 'w10-fixture' });
  let resume = createArtifact(store, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: path.join('jobs', job.id, 'artifacts', 'tailored-resume.md'),
    title: 'Tailored resume',
    content: '# Resume\n\nGrounded product launch improved activation by 30%.',
    evidence: [{ proofPointId: proof.id }],
    warnings: [],
    series: { kind: 'resume' },
    mutate: (target, created) => run(target, 'INSERT INTO artifact_resume_documents (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json) VALUES (?,?,?,?,?,?,?,?)', [created.id, 1, resumeSemantic.sourceResumeRevisionId, JSON.stringify(resumeSemantic.document), JSON.stringify(resumeSemantic.coverage), JSON.stringify(resumeSemantic.validation), JSON.stringify(resumeSemantic.layoutProfile), JSON.stringify(resumeSemantic.renderManifest)])
  });
  writeFileSync(path.join(store.p.ws, resumePdfPath), resumePdfBytes);
  resume = approveArtifact(store, resume.id, { reviewedBy: 'cli', note: 'W10 fixture approval.' });
  const snapshot = buildFormSnapshot({
    snapshotId: 'form_snapshot_w10_packet',
    jobId: job.id,
    profileId: profile.id,
    capturedAt: W10_AS_OF,
    requestedUrl: 'https://apply.w10.test/jobs/1?token=redacted-at-source',
    finalUrl: 'https://apply.w10.test/jobs/1',
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frame: { url: 'https://apply.w10.test/jobs/1', name: '', title: '', ordinal: 0 }, formKey: 'application', candidateCount: 1, score: 12 },
    fields: [
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'full_name', ordinal: 0 }, prompt: 'Full name', control: 'text', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'email', ordinal: 1 }, prompt: 'Email', control: 'email', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'why', ordinal: 2 }, prompt: 'Why this role?', control: 'textarea', required: true, classification: { category: 'motivation', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' } },
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'resume', ordinal: 3 }, prompt: 'Resume', control: 'file', required: true, classification: { category: 'document', sensitivity: 'personal', handling: 'packet-material', reasonCode: 'packet_material', provenance: 'dom' } },
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'authorized', ordinal: 4 }, prompt: 'Are you authorized to work?', control: 'radio-group', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], classification: { category: 'work_authorization', sensitivity: 'restricted', handling: 'human-input', reasonCode: 'restricted_category', provenance: 'hard-safety-rule' } },
      { frame: { url: 'https://apply.w10.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'consent', ordinal: 5 }, prompt: 'I certify this application', control: 'checkbox', required: true, classification: { category: 'legal_attestation', sensitivity: 'restricted', handling: 'human-action', reasonCode: 'legal_consent', provenance: 'hard-safety-rule' } }
    ],
    warnings: []
  });
  writeFileSync(path.join(store.p.state, 'form-target.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  persistFormSnapshot(store, snapshot);
  appCreate(store, job.id, 'researching', 'W10 fixture.');
  return { profile, proof, job, resume, snapshot };
}

async function deniedCode(store, tool, args) {
  try {
    await callDomainTool(store, tool, args, { source: 'mcp', allowExternalAttestation: true });
    return 'unexpectedly_allowed';
  } catch (error) {
    return error.code || error.type || error.message;
  }
}

async function packetOutcomeProjection() {
  return withWorkspace('jobos-w10-packet-', async (store, root) => {
    const seeded = await seedPacketWorkspace(store, root);
    const readiness = compileApplicationReadiness(store, { jobId: seeded.job.id, profileId: seeded.profile.id });
    const packet = createApplicationPacket(store, { jobId: seeded.job.id, profileId: seeded.profile.id, createdBy: 'cli' });
    const previous = {
      fill: process.env.JOBOS_FORM_FILL_ENABLED,
      submit: process.env.JOBOS_FORM_SUBMIT_ENABLED,
      agent: process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED
    };
    process.env.JOBOS_FORM_FILL_ENABLED = '1';
    process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
    process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = '1';
    let fillPolicy;
    let submitPolicy;
    try {
      fillPolicy = validateFormFillAuthorization(store, { profileId: seeded.profile.id, allowSideEffects: true });
      submitPolicy = validateFormSubmissionAuthorization(store, { profileId: seeded.profile.id, allowSubmit: true });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const envKey = key === 'fill' ? 'JOBOS_FORM_FILL_ENABLED' : key === 'submit' ? 'JOBOS_FORM_SUBMIT_ENABLED' : 'JOBOS_AGENT_FORM_INVOCATION_ENABLED';
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
    const denied = {
      approval: await deniedCode(store, 'approve_artifact', { artifactId: seeded.resume.id }),
      rejection: await deniedCode(store, 'reject_artifact', { artifactId: seeded.resume.id }),
      restrictedAnswer: await deniedCode(store, 'answers_add', { profileId: seeded.profile.id, category: 'work_authorization', question: 'Authorized?', answer: 'yes', sensitivity: 'restricted' }),
      attestation: await deniedCode(store, 'attest_application_submitted', { packetId: packet.id, submittedAt: '2026-07-22T15:00:00.000Z' }),
      confirmation: await deniedCode(store, 'confirm_application_receipt', { packetId: packet.id, reference: 'W10-REF' }),
      careerMemoryTransition: await deniedCode(store, 'accept_memory_proposal', { profileId: seeded.profile.id, proposalId: 'proposal_missing', referenceId: 'w10-ref' })
    };
    const manual = attestApplicationSubmitted(store, { packetId: packet.id, submittedAt: '2026-07-22T15:00:00.000Z', source: 'cli', note: 'W10 manual fixture' });
    const shown = showApplicationPacket(store, packet.id);
    const projection = {
      family: 'packet-bound-browser-outcome',
      asOf: W10_AS_OF,
      readiness: { status: readiness.status, blockerCodes: readiness.blockers.map(item => item.code).sort(), artifactReview: readiness.materials.resume.status },
      packet: { id: packet.id, contentHash: packet.contentHash, formFingerprint: packet.form.formFingerprint, currency: shown.currency, receiptState: shown.receiptState },
      mediation: { fillExternalSideEffects: fillPolicy.externalSideEffects, submitExternalSideEffects: submitPolicy.externalSideEffects },
      manualOutcome: { receiptBound: manual.receiptBound, submissionPerformed: manual.submissionPerformed, externalSideEffects: manual.externalSideEffects, packetId: manual.receipt.packetId, packetHash: packet.contentHash, formFingerprint: manual.receipt.formFingerprint, receiptState: shown.receiptState },
      deniedAgentMutations: denied
    };
    const serialized = canonicalJson(projection);
    for (const forbidden of ['Verified launch experience matches this role.', 'redacted-at-source', 'full_name', 'W10-REF']) assert.equal(serialized.includes(forbidden), false);
    return projection;
  });
}

const W10_CM_AS_OF = '2026-07-25T12:00:00.000Z';
const W10_CM_SCHEMA = 'jobos.career-memory-observation.v1';
const W10_CM_TABLES = Object.freeze([
  'career_memory_observations',
  'career_memory_proposals',
  'career_memory_proposal_evidence',
  'career_memory_proposal_transitions',
  'career_memory_projection_revisions',
  'career_memory_projection_sources',
  'audit_log'
]);

async function withCareerMemoryWorkspace(prefix, fn) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const state = path.join(root, '.jobos');
  mkdirSync(state, { recursive: true });
  copyFileSync(path.resolve('tests/fixtures/w08-schema14.sqlite'), path.join(state, 'jobos.sqlite'));
  let store;
  try {
    return await withFixedClock(async () => {
      store = await openStore({ workspace: root });
      return fn(store, root);
    });
  } finally {
    try {
      store?.db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

function memoryCounts(store) {
  return Object.fromEntries(W10_CM_TABLES.map(table => [table, one(store, `SELECT COUNT(*) AS count FROM ${table}`).count]));
}

function cloneMemoryJob(store, profileId, id, index) {
  const base = one(store, "SELECT * FROM jobs WHERE profile_id=? AND status='saved' ORDER BY id LIMIT 1", [profileId]);
  const row = {
    ...base,
    id,
    profile_id: profileId,
    title: 'Product Manager',
    url: `jobos:test:${id}`,
    status: 'new',
    dedupe_key: `${profileId}|w10-memory|${index}`,
    source_history_json: '[]',
    created_at: `2026-07-${20 + index}T08:00:00.000Z`,
    updated_at: `2026-07-${20 + index}T08:00:00.000Z`
  };
  const columns = Object.keys(row);
  run(store, `INSERT INTO jobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
  save(store);
  updateJobStatus(store, id, 'saved');
  return one(store, 'SELECT * FROM jobs WHERE id=?', [id]);
}

async function seedMemoryRule(store, {
  profileId,
  prefix,
  privateNote,
  accept = true,
  createdAt = '2026-07-24T12:00:00.000Z'
}) {
  const observations = [];
  const jobs = [];
  for (let index = 0; index < 3; index += 1) {
    const job = cloneMemoryJob(store, profileId, `job_w10_${prefix}_${index}`, index);
    jobs.push(job);
    observations.push(recordJobFeedback(store, {
      profileId,
      jobId: job.id,
      input: {
        schema: 'jobos.job-feedback-input.v1',
        decision: 'save',
        reasonCodes: ['role_fit'],
        signals: [{ field: 'role_family', polarity: 'prefer', value: job.title, match: 'exact' }],
        publicExplanation: '',
        privateNote: index === 0 ? privateNote : '',
        referenceId: `w10-${prefix}-feedback-${index}`,
        occurredAt: `2026-07-${20 + index}T10:00:00.000Z`
      },
      actor: 'user',
      source: 'cli'
    }));
  }
  const proposal = createMemoryProposal(store, {
    schema: 'jobos.memory-proposal-input.v1',
    domain: 'search',
    scope: 'search',
    ruleType: 'role_family',
    value: { polarity: 'prefer', value: jobs[0].title, match: 'exact' },
    rationale: 'Repeated structured job feedback supports this public guidance.',
    evidence: observations.map(item => ({ observationSchema: W10_CM_SCHEMA, observationId: item.id, polarity: 'support' })),
    referenceId: `w10-${prefix}-proposal`,
    createdAt
  });
  const transition = accept
    ? transitionMemoryProposal(store, {
        profileId,
        proposalId: proposal.id,
        action: 'accept',
        reason: '',
        referenceId: `w10-${prefix}-accept`,
        actor: 'user',
        source: 'cli',
        nowDate: new Date(W10_CM_AS_OF)
      })
    : null;
  return { jobs, observations, proposal, transition };
}

function memoryCli(root, profileId, jobId) {
  const result = spawnSync(process.execPath, [
    'src/cli.js', 'memory', 'retrieve',
    '--profile', profileId,
    '--consumer', 'discovery',
    '--job', jobId,
    '--as-of', W10_CM_AS_OF,
    '--json'
  ], {
    cwd: process.cwd(),
    env: { ...process.env, JOBOS_HOME: root },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
}

function memoryRuleSummary(rule) {
  return {
    id: rule.id,
    domain: rule.domain,
    scope: rule.scope,
    ruleType: rule.ruleType,
    status: rule.status,
    proposalHash: rule.proposalHash,
    evidenceHash: rule.evidenceHash,
    evidence: rule.evidence.map(item => ({
      observationId: item.observationId,
      sourceEntityId: item.sourceEntity.id,
      sourceVersionId: item.sourceEntity.versionId,
      evidenceHash: item.evidenceHash
    }))
  };
}

async function careerMemoryProvenanceProjection() {
  return withCareerMemoryWorkspace('jobos-w10-cm-provenance-', async (store, root) => {
    const privateNote = 'W10_CM_PROVENANCE_PRIVATE_NOTE';
    const privatePayload = 'W10_CM_PROVENANCE_PRIVATE_PAYLOAD';
    const seeded = await seedMemoryRule(store, { profileId: 'alpha', prefix: 'provenance', privateNote });
    const countsBeforeUnknown = memoryCounts(store);
    let unknownPayloadCode = null;
    try {
      recordJobFeedback(store, {
        profileId: 'alpha',
        jobId: seeded.jobs[0].id,
        input: {
          schema: 'jobos.job-feedback-input.v1',
          decision: 'save',
          reasonCodes: ['role_fit'],
          signals: [{ field: 'role_family', polarity: 'prefer', value: seeded.jobs[0].title, match: 'exact' }],
          publicExplanation: '',
          privateNote: '',
          referenceId: 'w10-provenance-unknown-payload',
          occurredAt: W10_CM_AS_OF,
          arbitraryPayload: privatePayload
        },
        actor: 'user',
        source: 'cli'
      });
    } catch (error) {
      unknownPayloadCode = error.code;
    }
    const unknownPayloadZeroDelta = canonicalJson(countsBeforeUnknown) === canonicalJson(memoryCounts(store));
    const retrieval = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const projection = refreshMemoryProjection(store, { profileId: 'alpha', projectionType: 'career_brief', asOf: new Date(W10_CM_AS_OF), actor: 'user', source: 'cli' });
    const projectionRow = one(store, 'SELECT id,content_hash FROM career_memory_projection_revisions WHERE profile_id=? AND projection_type=? AND revision=?', ['alpha', 'career_brief', projection.revision]);
    syncMemoryObservations(store, 'alpha');
    const domain = await callDomainTool(store, 'retrieve_career_memory', { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: W10_CM_AS_OF }, { source: 'cli' });
    const cli = memoryCli(root, 'alpha', seeded.jobs[0].id);
    const mirrorRoot = path.join(root, 'jobos-workspace', 'profiles', 'alpha', 'memory');
    const mirrorTexts = ['observations.yaml', 'career-brief.yaml', 'career-brief.md'].map(file => readFileSync(path.join(mirrorRoot, file), 'utf8'));
    const auditText = all(store, 'SELECT payload_json FROM audit_log ORDER BY id').map(row => row.payload_json).join('\n');
    const projectionSources = all(store, 'SELECT source_kind,source_id,source_version_id,source_hash FROM career_memory_projection_sources WHERE projection_id=? ORDER BY position', [projectionRow.id]);
    const publicTexts = [JSON.stringify(retrieval), JSON.stringify(domain), cli.stdout, cli.stderr, auditText, ...mirrorTexts, JSON.stringify(projection), JSON.stringify(projectionSources)];
    assert.equal(publicTexts.some(text => text.includes(privateNote) || text.includes(privatePayload)), false);
    const rule = retrieval.rules.find(item => item.id === seeded.proposal.id);
    return {
      family: 'career-memory-provenance',
      asOf: W10_CM_AS_OF,
      rule: memoryRuleSummary({ ...seeded.proposal, ...rule, status: seeded.transition.toStatus }),
      retrieval: {
        schema: retrieval.schema,
        ruleIds: retrieval.rules.map(item => item.id),
        citationIds: retrieval.citations.map(item => item.id),
        privateNotesPolicy: retrieval.policy.privateNotes
      },
      projection: {
        id: projectionRow.id,
        revision: projection.revision,
        contentHash: projectionRow.content_hash,
        sourceStateHash: projection.sourceStateHash,
        sources: projectionSources
      },
      surfaces: {
        mirrorFiles: mirrorTexts.length,
        cliSchema: cli.json.schema,
        domainSchema: domain.schema,
        privateDataFree: true
      },
      unknownPayload: {
        errorCode: unknownPayloadCode,
        zeroDelta: unknownPayloadZeroDelta
      }
    };
  });
}

function retrievalSummary(packet) {
  return {
    ruleIds: packet.rules.map(item => item.id),
    observationIds: packet.observations.map(item => item.id),
    citationIds: packet.citations.map(item => item.id),
    exclusions: packet.exclusions
  };
}

async function careerMemoryReversibilityProjection() {
  return withCareerMemoryWorkspace('jobos-w10-cm-reversible-', async store => {
    const seeded = await seedMemoryRule(store, { profileId: 'alpha', prefix: 'reversible', privateNote: 'W10_CM_REVERSIBLE_PRIVATE', accept: false });
    const inactive = createMemoryProposal(store, {
      schema: 'jobos.memory-proposal-input.v1',
      domain: 'search',
      scope: 'search',
      ruleType: 'role_family',
      value: { polarity: 'prefer', value: seeded.jobs[0].title, match: 'exact' },
      rationale: 'Inactive conflict candidate must not affect retrieval.',
      evidence: seeded.observations.map(item => ({ observationSchema: W10_CM_SCHEMA, observationId: item.id, polarity: 'support' })),
      referenceId: 'w10-reversible-inactive',
      createdAt: '2026-07-24T13:00:00.000Z'
    });
    const baseline = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const countsProposed = memoryCounts(store);
    const accepted = transitionMemoryProposal(store, {
      profileId: 'alpha', proposalId: seeded.proposal.id, action: 'accept', reason: '', referenceId: 'w10-reversible-accept',
      actor: 'user', source: 'cli', nowDate: new Date(W10_CM_AS_OF)
    });
    const active = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const countsAccepted = memoryCounts(store);
    const revoked = transitionMemoryProposal(store, {
      profileId: 'alpha', proposalId: seeded.proposal.id, action: 'revoke', reason: 'Withdraw reviewed guidance.', referenceId: 'w10-reversible-revoke',
      actor: 'user', source: 'cli', nowDate: new Date(W10_CM_AS_OF)
    });
    const afterRevoke = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const countsRevoked = memoryCounts(store);
    const undoArgs = {
      profileId: 'alpha', transitionId: revoked.id, reason: 'Restore reviewed guidance.', referenceId: 'w10-reversible-undo',
      actor: 'user', source: 'cli', nowDate: new Date(W10_CM_AS_OF)
    };
    const undone = undoMemoryTransition(store, undoArgs);
    const afterUndo = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const countsUndone = memoryCounts(store);
    const replay = undoMemoryTransition(store, undoArgs);
    const afterReplay = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: seeded.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const countsReplay = memoryCounts(store);
    const immutableTables = ['career_memory_observations', 'career_memory_proposals', 'career_memory_proposal_evidence'];
    return {
      family: 'career-memory-reversibility',
      asOf: W10_CM_AS_OF,
      proposalIds: { active: seeded.proposal.id, inactive: inactive.id },
      transitionIds: { accepted: accepted.id, revoked: revoked.id, undone: undone.id, replay: replay.id },
      states: {
        baseline: retrievalSummary(baseline),
        active: retrievalSummary(active),
        revoked: retrievalSummary(afterRevoke),
        undone: retrievalSummary(afterUndo),
        replay: retrievalSummary(afterReplay)
      },
      invariants: {
        activeOnlyWhileAccepted: active.rules.some(item => item.id === seeded.proposal.id) && !baseline.rules.some(item => item.id === seeded.proposal.id) && !afterRevoke.rules.some(item => item.id === seeded.proposal.id),
        revokeRestoresBaseline: canonicalJson(retrievalSummary(baseline)) === canonicalJson(retrievalSummary(afterRevoke)),
        undoRestoresActive: canonicalJson(retrievalSummary(active)) === canonicalJson(retrievalSummary(afterUndo)),
        replayIsExact: canonicalJson(retrievalSummary(afterUndo)) === canonicalJson(retrievalSummary(afterReplay)) && replay.idempotent === true,
        inactiveNeverActive: [baseline, active, afterRevoke, afterUndo, afterReplay].every(packet => !packet.rules.some(item => item.id === inactive.id)),
        immutableHistoryPreserved: immutableTables.every(table => countsProposed[table] === countsAccepted[table] && countsAccepted[table] === countsRevoked[table] && countsRevoked[table] === countsUndone[table]),
        replayZeroDelta: canonicalJson(countsUndone) === canonicalJson(countsReplay),
        transitionRows: [countsProposed.career_memory_proposal_transitions, countsAccepted.career_memory_proposal_transitions, countsRevoked.career_memory_proposal_transitions, countsUndone.career_memory_proposal_transitions]
      }
    };
  });
}

async function careerMemoryIsolationProjection() {
  return withCareerMemoryWorkspace('jobos-w10-cm-isolation-', async (store, root) => {
    const alphaPrivate = 'W10_ALPHA_PRIVATE_NOTE';
    const betaPrivate = 'W10_BETA_PRIVATE_NOTE';
    const alpha = await seedMemoryRule(store, { profileId: 'alpha', prefix: 'isolation-alpha', privateNote: alphaPrivate });
    const beta = await seedMemoryRule(store, { profileId: 'beta', prefix: 'isolation-beta', privateNote: betaPrivate });
    const alphaPacket = retrieveCareerMemory(store, { profileId: 'alpha', consumer: 'discovery', jobId: alpha.jobs[0].id, asOf: new Date(W10_CM_AS_OF) });
    const projection = refreshMemoryProjection(store, { profileId: 'alpha', projectionType: 'career_brief', asOf: new Date(W10_CM_AS_OF), actor: 'user', source: 'cli' });
    const projectionRow = one(store, 'SELECT id FROM career_memory_projection_revisions WHERE profile_id=? AND projection_type=? AND revision=?', ['alpha', 'career_brief', projection.revision]);
    syncMemoryObservations(store, 'alpha');
    const domain = await callDomainTool(store, 'retrieve_career_memory', { profileId: 'alpha', consumer: 'discovery', jobId: alpha.jobs[0].id, asOf: W10_CM_AS_OF }, { source: 'cli' });
    const cli = memoryCli(root, 'alpha', alpha.jobs[0].id);
    const alphaMirror = readFileSync(path.join(root, 'jobos-workspace', 'profiles', 'alpha', 'memory', 'observations.yaml'), 'utf8');
    const projectionSources = all(store, 'SELECT source_kind,source_id,source_version_id,source_hash FROM career_memory_projection_sources WHERE projection_id=? ORDER BY position', [projectionRow.id]);
    const alphaEntityIds = [...alpha.observations.map(item => item.id), alpha.proposal.id, projectionRow.id];
    const alphaAudit = all(store, `SELECT payload_json FROM audit_log WHERE entity_id IN (${alphaEntityIds.map(() => '?').join(',')}) ORDER BY id`, alphaEntityIds).map(row => row.payload_json).join('\n');
    const beforeDenied = memoryCounts(store);
    let deniedCode = null;
    try {
      createMemoryProposal(store, {
        schema: 'jobos.memory-proposal-input.v1',
        domain: 'search',
        scope: 'search',
        ruleType: 'role_family',
        value: { polarity: 'prefer', value: alpha.jobs[0].title, match: 'exact' },
        rationale: 'Cross-profile evidence must be rejected.',
        evidence: [
          { observationSchema: W10_CM_SCHEMA, observationId: alpha.observations[0].id, polarity: 'support' },
          { observationSchema: W10_CM_SCHEMA, observationId: beta.observations[0].id, polarity: 'support' }
        ],
        referenceId: 'w10-isolation-cross-profile',
        createdAt: '2026-07-24T14:00:00.000Z'
      });
    } catch (error) {
      deniedCode = error.code;
    }
    const afterDenied = memoryCounts(store);
    const alphaTexts = [JSON.stringify(alphaPacket), JSON.stringify(domain), cli.stdout, cli.stderr, alphaMirror, alphaAudit, JSON.stringify(projection), JSON.stringify(projectionSources)];
    const betaIdentifiers = [...beta.observations.map(item => item.id), beta.proposal.id, betaPrivate];
    assert.equal(alphaTexts.some(text => betaIdentifiers.some(value => text.includes(value))), false);
    assert.equal(alphaTexts.some(text => text.includes(alphaPrivate)), false);
    return {
      family: 'career-memory-isolation',
      asOf: W10_CM_AS_OF,
      alpha: {
        profileId: alphaPacket.profileId,
        ruleIds: alphaPacket.rules.map(item => item.id),
        observationIds: alphaPacket.observations.map(item => item.id),
        projectionId: projectionRow.id,
        projectionSourceIds: projectionSources.map(item => item.source_id)
      },
      beta: {
        ruleId: beta.proposal.id,
        observationIds: beta.observations.map(item => item.id)
      },
      surfaces: {
        cliSchema: cli.json.schema,
        domainSchema: domain.schema,
        alphaMirrorPrivateDataFree: true,
        noBetaDataInAlpha: true
      },
      crossProfile: {
        errorCode: deniedCode,
        zeroDelta: canonicalJson(beforeDenied) === canonicalJson(afterDenied),
        counts: afterDenied
      }
    };
  });
}

const generators = Object.freeze({
  'document-completeness': documentCompletenessProjection,
  'score-stability': scoreStabilityProjection,
  'contact-tiering': contactTieringProjection,
  'discovery-partials-liveness': discoveryPartialsProjection,
  'packet-bound-browser-outcome': packetOutcomeProjection,
  'career-memory-provenance': careerMemoryProvenanceProjection,
  'career-memory-reversibility': careerMemoryReversibilityProjection,
  'career-memory-isolation': careerMemoryIsolationProjection
});

export async function generateW10Projection(family) {
  const generate = generators[family];
  if (!generate) throw new Error(`Unknown W10 fixture family: ${family}`);
  return generate();
}

export async function assertW10Golden(family, root = path.resolve('tests/fixtures/w10')) {
  const { fixture } = loadW10Fixture(family, root);
  const actual = await generateW10Projection(family);
  assert.equal(canonicalJson(actual), canonicalJson(fixture));
  return actual;
}
