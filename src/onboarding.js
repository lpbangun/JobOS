import { all, one } from './db.js';
import { parseJson } from './utils.js';
import { validateResumeDocument } from './resumes.js';
import { compileApplicationReadiness } from './readiness.js';
import { listMemoryProposals, resolveActiveMemoryRules } from './career-memory-proposals.js';
import { agentBackendCatalog } from './acp.js';
import { browserStatus } from './browser.js';

export const ONBOARDING_SCHEMA = 'jobos.onboarding-status.v1';
const REQUIRED_IDS = ['workspace', 'profile', 'resume', 'proofs', 'intake', 'decision', 'materials'];
const OPTIONAL_IDS = ['source', 'calibration', 'provider', 'browser', 'network'];
const MATERIALS_COMPLETE = new Set(['materials-ready', 'form-ready', 'form-blocked']);

export function isOnboardingMaterialsComplete(readiness) {
  const required = readiness?.review?.requiredArtifactIds || [];
  const approved = new Set(readiness?.review?.approvedArtifactIds || []);
  const exactDraftsReviewed = required.length > 0 && required.every(id => approved.has(id));
  return Boolean(readiness && (
    readiness.localApprovalComplete === true
    || readiness.materialsStatus === 'approved'
    || MATERIALS_COMPLETE.has(readiness.status)
    || exactDraftsReviewed
  ));
}

const policy = Object.freeze({
  canonicalState: 'sqlite',
  projectionPersisted: false,
  cloudKeyRequired: false,
  providerRequired: false,
  browserRequired: false,
  calibrationRequired: false,
  preferencesMutatedByCalibration: false,
  externalSideEffects: 'none'
});

function domainError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

function action(id, label, command, { mutates = true, requiresHumanInput = true, externalSideEffect = 'none' } = {}) {
  return { id, label, command, mutates, requiresHumanInput, externalSideEffect };
}

function step(id, kind, required, status, summary, blockers = [], actions = [], evidence = {}) {
  return { id, kind, required, status, summary, blockers, actions, evidence };
}

function blocker(code, message, recovery) {
  return { code, message, recovery };
}

function selectedProfile(s, requested) {
  const profiles = all(s, 'SELECT id,name FROM profiles ORDER BY id');
  if (requested) {
    const selected = profiles.find(profile => profile.id === requested);
    if (!selected) throw domainError('unknown_profile', `Unknown profile: ${requested}`, { profileId: requested });
    return { profiles, selected };
  }
  return { profiles, selected: profiles.length === 1 ? profiles[0] : null };
}

function selectedJob(s, profileId, requested) {
  if (requested) {
    const job = one(s, 'SELECT id,profile_id,liveness_status,liveness_checked_at,score_json,fit_score,status FROM jobs WHERE id=?', [requested]);
    if (!job) throw domainError('unknown_job', `Unknown job: ${requested}`, { jobId: requested });
    if (!profileId || job.profile_id !== profileId) {
      throw domainError('profile_job_mismatch', `Job ${requested} belongs to profile ${job.profile_id}, not ${profileId || 'an unselected profile'}`, {
        profileId, jobId: requested, ownerProfileId: job.profile_id
      });
    }
    return { jobs: all(s, 'SELECT id FROM jobs WHERE profile_id=? ORDER BY id', [profileId]), selected: job };
  }
  if (!profileId) return { jobs: [], selected: null };
  const jobs = all(s, 'SELECT id,profile_id,liveness_status,liveness_checked_at,score_json,fit_score,status FROM jobs WHERE profile_id=? ORDER BY id', [profileId]);
  return { jobs, selected: jobs.length === 1 ? jobs[0] : null };
}

function scoreIsCurrent(job, profileId) {
  const score = parseJson(job?.score_json, null);
  if (!score) return false;
  if (score.jobId && score.jobId !== job.id) return false;
  if (score.profileId && score.profileId !== profileId) return false;
  return score.contract === 'jobos.fit-score.v1' || score.contract === 'jobos.fit-score.v2' || Boolean(score.dimensions || score.components);
}

function readinessProjection(s, profileId, job) {
  if (!profileId || !job || job.liveness_status === 'expired' || !scoreIsCurrent(job, profileId)) return null;
  return compileApplicationReadiness(s, { jobId: job.id, profileId, includePacket: false });
}

function memorySummary(s, profileId, asOf) {
  if (!profileId) return { observationIds: [], proposalCounts: {}, activeCount: 0 };
  const observations = all(s, `SELECT o.id FROM career_memory_observations o
    WHERE o.profile_id=? AND o.source_schema='jobos.job-feedback-input.v1'
      AND o.reason_codes_json<>'[]'
      AND NOT EXISTS (SELECT 1 FROM career_memory_observations n WHERE n.supersedes_observation_id=o.id)
    ORDER BY o.id`, [profileId]);
  const proposals = listMemoryProposals(s, { profileId, includeEvidence: false }).proposals;
  const proposalCounts = {};
  for (const proposal of proposals) proposalCounts[proposal.status] = (proposalCounts[proposal.status] || 0) + 1;
  const activeCount = resolveActiveMemoryRules(s, { profileId, asOf: new Date(asOf) }).rules.length;
  return { observationIds: observations.map(row => row.id), proposalCounts, activeCount };
}

export function nextOnboardingAction(status) {
  for (const id of [...REQUIRED_IDS, ...OPTIONAL_IDS]) {
    const item = status.steps.find(candidate => candidate.id === id);
    if (!item) continue;
    const incomplete = item.required ? item.status !== 'complete' : item.status !== 'optional_ready';
    if (incomplete && item.actions.length) return item.actions[0];
  }
  return null;
}

export function buildOnboardingStatus(s, { profileId = null, jobId = null, asOf = new Date().toISOString() } = {}) {
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) throw domainError('invalid_as_of', `Invalid asOf timestamp: ${asOf}`);
  const canonicalAsOf = at.toISOString();
  const { profiles, selected: profile } = selectedProfile(s, profileId);
  const pid = profile?.id || null;
  const { jobs, selected: job } = selectedJob(s, pid, jobId);
  const jid = job?.id || null;
  const steps = [];

  steps.push(step('workspace', 'canonical', true, 'complete', 'Local SQLite workspace is open.', [], [], { storeRevision: s.revision || null }));

  const profileBlockers = !profile
    ? [profiles.length === 0
      ? blocker('profile_missing', 'No canonical profile exists.', 'Create a profile.')
      : blocker('profile_selection_required', 'Multiple profiles exist; select one explicitly.', 'Reopen setup with --profile <profile-id>.')]
    : [];
  const profileActions = !profile
    ? profiles.length === 0
      ? [action('create_profile', 'Create profile', 'jobos profile create <name> --json')]
      : [action('select_profile', 'Select profile', 'jobos setup --profile <profile-id>', { mutates: false })]
    : [];
  steps.push(step('profile', 'canonical', true, profile ? 'complete' : 'blocked', profile ? 'Canonical profile selected.' : profileBlockers[0].message,
    profileBlockers, profileActions, { profileIds: profiles.map(item => item.id).sort(), selectedProfileId: pid }));

  const resume = pid ? one(s, 'SELECT id,revision,document_json,verification_status FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [pid]) : null;
  const validation = resume ? validateResumeDocument(parseJson(resume.document_json, null)) : null;
  const resumeComplete = Boolean(resume && validation.valid);
  const resumeBlockers = !pid ? [blocker('profile_required', 'Select a profile before importing a resume.', 'Complete profile setup.')]
    : !resume ? [blocker('resume_source_missing', 'No canonical resume revision exists.', 'Import a complete local resume.')]
      : validation.blockers.map(item => blocker(item.code, item.message, 'Replace the canonical resume with a corrected revision.'));
  steps.push(step('resume', 'canonical', true, resumeComplete ? 'complete' : 'blocked', resumeComplete ? 'Current canonical resume is valid.' : 'Canonical resume needs input or correction.', resumeBlockers,
    pid ? [action(resume ? 'replace_resume' : 'import_resume', resume ? 'Replace resume' : 'Import resume', `jobos resume ${resume ? 'replace' : 'import'} --profile ${pid} --file <path> --json`)] : [],
    { resumeId: resume?.id || null, revision: resume ? Number(resume.revision) : null, verificationStatus: resume?.verification_status || null, blockerCodes: validation?.blockers.map(item => item.code) || ['resume_source_missing'] }));

  const proofs = pid ? all(s, 'SELECT id,status,verification_status FROM proof_points WHERE profile_id=? ORDER BY id', [pid]) : [];
  const verified = proofs.filter(item => item.status === 'active' && item.verification_status === 'verified');
  const proofComplete = verified.length > 0;
  const proofActions = !pid ? [] : proofs.length ? [
    action('verify_proof', 'Verify proof', `jobos proof verify ${proofs[0].id} --json`),
    action('replace_proof', 'Replace proof', `jobos proof supersede ${proofs[0].id} --summary <claim> --evidence <source> --json`),
    action('retire_proof', 'Retire proof', `jobos proof retire ${proofs[0].id} --json`),
    action('add_proof', 'Add proof', `jobos proof add --profile ${pid} --summary <claim> --evidence <source> --json`)
  ] : [action('add_proof', 'Add proof', `jobos proof add --profile ${pid} --summary <claim> --evidence <source> --json`)];
  steps.push(step('proofs', 'canonical', true, proofComplete ? 'complete' : 'blocked', proofComplete ? 'Verified active proof is available.' : 'At least one active proof must be verified.',
    proofComplete ? [] : [blocker('verified_proof_missing', 'No active verified proof exists.', 'Verify, replace, retire, or add a proof point.')],
    proofActions,
    { proofCount: proofs.length, activeVerifiedCount: verified.length, activeVerifiedProofIds: verified.map(item => item.id) }));

  const intakeComplete = jobs.length > 0;
  const intakeActions = pid ? [action('import_local_job', 'Add a job you like', `jobos jobs import-text --profile ${pid} --file <path> --json`)] : [];
  steps.push(step('intake', 'canonical', true, intakeComplete ? 'complete' : 'blocked', intakeComplete ? 'Your first preference-setting job is saved.' : 'Add a role you like or would seriously consider so JobOS can understand your preferences.',
    intakeComplete ? [] : [blocker('job_missing', 'No job has been added yet.', 'Add a role you like; your first job helps JobOS learn what you want.')], intakeActions,
    { jobCount: jobs.length, jobIds: jobs.map(item => item.id) }));

  const ambiguousJobs = jobs.length > 1 && !jobId;
  const expired = job?.liveness_status === 'expired';
  const fitResult = parseJson(job?.score_json, null);
  const scored = scoreIsCurrent(job, pid);
  const decisionComplete = Boolean(job && !expired && scored);
  let decisionBlockers = [];
  if (!job) decisionBlockers = [blocker(ambiguousJobs ? 'job_selection_required' : 'job_missing', ambiguousJobs ? 'Multiple jobs exist; select one explicitly.' : 'No job is available for a decision.', ambiguousJobs ? 'Reopen setup with --job <job-id>.' : 'Complete intake.')];
  else if (expired) decisionBlockers = [blocker('posting_expired', 'The selected posting is expired.', 'Refresh liveness or select a current job.')];
  else if (!scored) decisionBlockers = [blocker('fit_score_missing', 'The selected job has no current persisted fit result.', 'Score the selected job explicitly.')];
  const decisionActions = !job && ambiguousJobs
    ? [action('select_job', 'Select job', `jobos setup --profile ${pid} --job <job-id>`, { mutates: false })]
    : job && !expired && !scored ? [action('score_job', 'Score job', `jobos score ${jid} --profile ${pid} --json`)]
      : expired ? [action('select_current_job', 'Select current job', `jobos setup --profile ${pid} --job <job-id>`, { mutates: false })] : [];
  const insufficientFit = scored && fitResult?.scoreStatus === 'insufficient_evidence';
  steps.push(step('decision', 'derived', true, decisionComplete ? 'complete' : 'blocked', decisionComplete ? (insufficientFit ? 'Fit check is saved; evidence remains insufficient for a numeric score.' : job.liveness_status === 'uncertain' ? 'Fit is scored; posting liveness remains uncertain.' : 'Current fit decision is available.') : decisionBlockers[0].message,
    decisionBlockers, decisionActions, { selectedJobId: jid, livenessStatus: job?.liveness_status || null, livenessCheckedAt: job?.liveness_checked_at || null, fitPersisted: scored, uncertaintyWarning: job?.liveness_status === 'uncertain' }));

  const readiness = readinessProjection(s, pid, job);
  const materialsComplete = isOnboardingMaterialsComplete(readiness);
  const readinessBlockers = readiness?.blockers || [];
  const materialBlockers = !decisionComplete ? [blocker('decision_required', 'Complete the explicit fit decision first.', 'Complete decision setup.')]
    : materialsComplete ? []
      : readinessBlockers.length ? readinessBlockers.map(item => blocker(item.code, item.message, item.nextAction))
        : [blocker('materials_review_required', 'Current artifact revisions require local human review.', readiness?.nextAction || 'Review exact current artifact revisions.')];
  const regenerationNeeded = readinessBlockers.some(item => /\btailor resume\b/i.test(String(item.nextAction || '')));
  const materialAction = readiness?.review?.pendingArtifactIds?.length && !regenerationNeeded
    ? action('review_materials', 'Review exact revisions', `jobos artifacts queue --profile ${pid} --job ${jid} --json`)
    : decisionComplete ? action('pursue_job', 'Prepare application materials', `jobos pursue ${jid} --profile ${pid} --json`) : null;
  steps.push(step('materials', 'derived', true, materialsComplete ? 'complete' : 'blocked', materialsComplete ? 'Local application materials are approved.' : 'Application materials are incomplete.', materialBlockers, materialAction ? [materialAction] : [],
    { readinessStatus: readiness?.status || null, materialsStatus: readiness?.materialsStatus || null, localApprovalComplete: readiness?.localApprovalComplete || false, pendingArtifactIds: readiness?.review?.pendingArtifactIds || [], blockerCodes: readinessBlockers.map(item => item.code) }));

  const searches = pid ? all(s, 'SELECT id,adapter FROM saved_searches WHERE profile_id=? ORDER BY id', [pid]) : [];
  steps.push(step('source', 'canonical', false, searches.length ? 'optional_ready' : 'optional_incomplete', searches.length ? 'A canonical saved search is configured.' : 'Saved discovery is optional; local import remains available.', [],
    pid && !searches.length ? [action('create_source', 'Create saved search', `jobos searches create <name> --profile ${pid} --adapter <adapter> --json`)] : [],
    { searchCount: searches.length, searchIds: searches.map(item => item.id), adapters: [...new Set(searches.map(item => item.adapter))] }));

  const memory = memorySummary(s, pid, canonicalAsOf);
  const proposalCount = Object.values(memory.proposalCounts).reduce((sum, count) => sum + count, 0);
  const calibrationActions = !pid ? [] : !memory.observationIds.length
    ? [action('record_calibration', 'Record attributed job feedback', `jobos feedback job <job-id> --profile ${pid} --file <job-feedback.json> --json`)]
    : proposalCount === 0
      ? [action('derive_calibration', 'Derive inactive proposals', `jobos preferences derive --profile ${pid} --json`)]
      : [action('review_calibration', 'Review inactive proposals', `jobos preferences proposals --profile ${pid} --json`, { mutates: false })];
  steps.push(step('calibration', 'canonical', false, memory.observationIds.length ? 'optional_ready' : 'optional_incomplete', memory.observationIds.length ? 'Attributed calibration feedback exists; proposals remain separately governed.' : 'Optional calibration has not been recorded.', [], calibrationActions, memory));

  steps.push(step('provider', 'optional_external', false, 'unavailable', 'Provider capability was not probed by the canonical projector.', [],
    [action('inspect_provider', 'Inspect provider', 'hermes acp --check', { mutates: false, externalSideEffect: 'none' })], { probeStatus: 'not_requested' }));
  steps.push(step('browser', 'optional_external', false, 'unavailable', 'Browser capability was not probed by the canonical projector.', [],
    [action('inspect_browser', 'Inspect browser', 'jobos browser status --json', { mutates: false })], { probeStatus: 'not_requested' }));

  const preferences = pid ? parseJson(one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [pid])?.preferences_json, {}) : {};
  const completedAt = preferences.networkIntent?.completedAt || null;
  const suggested = pid ? Number(one(s, "SELECT COUNT(*) AS count FROM profile_affiliations WHERE profile_id=? AND status='suggested'", [pid])?.count || 0) : 0;
  steps.push(step('network', 'canonical', false, completedAt && suggested === 0 ? 'optional_ready' : 'optional_incomplete', completedAt ? (suggested ? 'Network setup has affiliations awaiting confirmation.' : 'Network setup is ready.') : 'Optional network setup is incomplete.', [],
    pid ? [action('configure_network', 'Configure network intent', `jobos profile network-intent --profile ${pid} --file <json> --json`)] : [], { completedAt, suggestedAffiliationCount: suggested }));

  const completedRequired = steps.filter(item => item.required && item.status === 'complete').length;
  const coreReady = completedRequired === REQUIRED_IDS.length;
  const status = {
    schema: ONBOARDING_SCHEMA,
    workspace: { root: s.root, status: 'open' },
    profileId: pid,
    jobId: jid,
    asOf: canonicalAsOf,
    state: coreReady ? 'complete' : pid ? 'in_progress' : 'needs_input',
    coreReady,
    completedRequired,
    totalRequired: REQUIRED_IDS.length,
    steps,
    nextAction: null,
    recovery: steps.flatMap(item => item.blockers.map(itemBlocker => ({ stepId: item.id, code: itemBlocker.code, recovery: itemBlocker.recovery }))),
    policy: { ...policy }
  };
  status.nextAction = nextOnboardingAction(status);
  return status;
}

function replaceStep(status, id, values) {
  status.steps = status.steps.map(item => item.id === id ? { ...item, ...values } : item);
}

function providerCapability(catalog) {
  const hermes = Array.isArray(catalog) ? catalog.find(item => item.id === 'hermes-acp') : null;
  if (!hermes) return { status: 'unavailable', summary: 'Hermes ACP is unavailable.', evidence: { probeStatus: 'unavailable', backendId: 'hermes-acp' } };
  return hermes.available
    ? { status: 'optional_ready', summary: 'Hermes ACP is available.', evidence: { probeStatus: 'ready', backendId: hermes.id, protocol: hermes.protocol || null } }
    : { status: hermes.path ? 'misconfigured' : 'unavailable', summary: hermes.path ? 'Hermes ACP is installed but not ready.' : 'Hermes ACP is unavailable.', evidence: { probeStatus: hermes.path ? 'misconfigured' : 'unavailable', backendId: hermes.id } };
}

function browserCapability(result) {
  if (!result?.packageAvailable || !result?.executableAvailable) return { status: 'unavailable', summary: 'Optional browser package or Chromium is unavailable.', evidence: { probeStatus: 'unavailable', packageAvailable: Boolean(result?.packageAvailable), executableAvailable: Boolean(result?.executableAvailable), profileCount: 0 } };
  const profiles = result.profile ? [result.profile] : (result.profiles || []);
  const existing = profiles.filter(item => item.exists);
  const authenticated = existing.filter(item => item.lastLoginAt);
  return authenticated.length
    ? { status: 'optional_ready', summary: 'An authenticated private browser profile is available.', evidence: { probeStatus: 'ready', packageAvailable: true, executableAvailable: true, profileCount: existing.length, authenticatedProfileCount: authenticated.length } }
    : { status: 'optional_incomplete', summary: existing.length ? 'Private browser profiles exist but authentication is not confirmed.' : 'Browser is available but no private profile is configured.', evidence: { probeStatus: existing.length ? 'auth_missing' : 'profile_missing', packageAvailable: true, executableAvailable: true, profileCount: existing.length, authenticatedProfileCount: 0 } };
}

export async function inspectOnboardingStatus(s, {
  includeCapabilities = false,
  agentProbe = agentBackendCatalog,
  browserProbe = browserStatus,
  ...options
} = {}) {
  const status = buildOnboardingStatus(s, options);
  if (!includeCapabilities) return status;
  const [agentResult, browserResult] = await Promise.allSettled([
    agentProbe({ root: s.root }),
    browserProbe({ workspace: s.root })
  ]);
  replaceStep(status, 'provider', agentResult.status === 'fulfilled'
    ? providerCapability(agentResult.value)
    : { status: 'misconfigured', summary: 'Provider capability probe failed; core setup is unaffected.', blockers: [blocker('provider_probe_failed', 'Provider capability probe failed.', 'Retry or run hermes acp --check.')], evidence: { probeStatus: 'failed' } });
  replaceStep(status, 'browser', browserResult.status === 'fulfilled'
    ? browserCapability(browserResult.value)
    : { status: 'misconfigured', summary: 'Browser capability probe failed; core setup is unaffected.', blockers: [blocker('browser_probe_failed', 'Browser capability probe failed.', 'Retry jobos browser status.')], evidence: { probeStatus: 'failed' } });
  status.nextAction = nextOnboardingAction(status);
  status.recovery = status.steps.flatMap(item => item.blockers.map(itemBlocker => ({ stepId: item.id, code: itemBlocker.code, recovery: itemBlocker.recovery })));
  return status;
}
