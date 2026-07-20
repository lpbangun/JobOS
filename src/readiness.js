import path from 'node:path';
import { all, one } from './db.js';
import { inspectApplicationQuestions } from './answers.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeYaml } from './workspace.js';
import { applicationId } from './tracking.js';
import { readinessPacketSummary } from './packets.js';

const submittedEvidenceStatuses = new Set([
  'applied',
  'recruiter-screen',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted'
]);

function readinessError(code, message) {
  return Object.assign(new Error(message), { code, type: 'validation' });
}

function publicUrl(value) {
  const url = String(value || '');
  return url.startsWith('jobos:text:') ? '' : url;
}

function artifactState(artifact, proofIds, { required }) {
  if (!artifact) return { status: 'missing', required, artifactId: null, path: null, approvalStatus: null, grounded: false, proofPointIds: [], warnings: [] };
  const evidence = parseJson(artifact.evidence_json, []);
  const cited = [...new Set((Array.isArray(evidence) ? evidence : [])
    .map(item => String(item?.proofPointId || ''))
    .filter(proofId => proofIds.has(proofId)))];
  const status = artifact.approval_status === 'approved'
    ? 'approved'
    : artifact.approval_status === 'rejected'
      ? 'rejected'
      : 'reviewable-draft';
  return {
    status,
    required,
    artifactId: artifact.id,
    path: artifact.path,
    approvalStatus: artifact.approval_status,
    grounded: cited.length > 0,
    proofPointIds: cited,
    warnings: parseJson(artifact.warnings_json, [])
  };
}

function latestArtifacts(s, jobId, profileId) {
  const rows = all(s, `SELECT current.id,current.type,current.path,current.evidence_json,current.warnings_json,
      current.approval_status,current.created_at,current.series_key,current.revision
    FROM artifacts AS current
    WHERE current.job_id=? AND current.profile_id=? AND current.type IN ('resume','cover_letter')
      AND NOT EXISTS (
        SELECT 1 FROM artifacts AS successor
        WHERE successor.series_key=current.series_key AND successor.revision>current.revision
      )
    ORDER BY current.revision DESC,current.created_at DESC,current.id DESC`, [jobId, profileId]);
  const byType = new Map();
  for (const row of rows) if (!byType.has(row.type)) byType.set(row.type, row);
  return byType;
}

function possibleDuplicateApplications(s, job) {
  const priorApplied = new Set(all(s, `SELECT DISTINCT application_id FROM status_changes
    WHERE to_status IN ('applied','recruiter-screen','interview','offer','rejected','withdrawn','ghosted')`).map(row => row.application_id));
  const rows = all(s, `SELECT jobs.id AS job_id,jobs.url,jobs.dedupe_key,jobs.company,jobs.title,jobs.location,
      applications.id AS application_id,applications.status
    FROM jobs JOIN applications ON applications.job_id=jobs.id
    WHERE jobs.id<>?`, [job.id]);
  const jobUrl = publicUrl(job.url);
  return rows.flatMap(row => {
    const signals = [];
    if (jobUrl && publicUrl(row.url) === jobUrl) signals.push('exact_source_url');
    if (job.dedupe_key && row.dedupe_key === job.dedupe_key) signals.push('exact_employer_title_location_key');
    const hasApplicationEvidence = submittedEvidenceStatuses.has(row.status) || priorApplied.has(row.application_id);
    if (!signals.length || !hasApplicationEvidence) return [];
    return [{
      jobId: row.job_id,
      applicationId: row.application_id,
      status: row.status,
      signals,
      evidence: priorApplied.has(row.application_id) ? 'local_status_history' : 'local_application_status',
      confirmationClaimed: false
    }];
  });
}

function blocker(code, message, nextAction, details = {}) {
  return { code, message, nextAction, ...details };
}

export function compileApplicationReadiness(s, { jobId, profileId, includePacket = true }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw readinessError('unknown_job', `Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT id,name FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw readinessError('unknown_profile', `Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw readinessError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);

  const proofs = all(s, 'SELECT id FROM proof_points WHERE profile_id=? ORDER BY created_at,id', [profileId]);
  const proofIds = new Set(proofs.map(proof => proof.id));
  const artifacts = latestArtifacts(s, jobId, profileId);
  const resume = artifactState(artifacts.get('resume'), proofIds, { required: true });
  const coverLetter = artifactState(artifacts.get('cover_letter'), proofIds, { required: false });
  const score = parseJson(job.score_json, null);
  const scoreAvailable = job.fit_score != null && Number.isFinite(Number(job.fit_score)) && score && typeof score === 'object';
  const answers = inspectApplicationQuestions(s, { jobId, profileId });
  const application = one(s, 'SELECT id,status,notes,updated_at FROM applications WHERE job_id=? AND profile_id=?', [jobId, profileId]);
  const duplicates = possibleDuplicateApplications(s, job);
  const sourceUrl = publicUrl(job.url);
  const employerKey = job.company_id || slug(job.company);
  const sourceKey = id('source', sourceUrl || `${job.source}:${job.dedupe_key || job.id}`);
  const applicationKey = application?.id || applicationId(job.id, profileId);
  const identityKey = id('identity', `${employerKey}:${job.dedupe_key || job.id}`);
  const blockers = [];

  if (!proofs.length) blockers.push(blocker(
    'missing_proofs',
    'The profile has no stored proof points, so JobOS cannot ground application claims.',
    `Add evidence with "jobos proof add --profile ${profileId} --summary <claim> --evidence <source> --json".`
  ));
  if (!scoreAvailable) blockers.push(blocker(
    'missing_score',
    'This job has no persisted fit score for the selected profile.',
    `Run "jobos score ${jobId} --profile ${profileId} --json".`
  ));
  if (!resume.artifactId) blockers.push(blocker(
    'missing_resume_material',
    'No tailored resume draft exists for this job and profile.',
    `Run "jobos tailor resume --job ${jobId} --profile ${profileId} --json".`
  ));
  else if (resume.status === 'rejected') blockers.push(blocker(
    'resume_rejected',
    'The latest tailored resume was rejected in local review.',
    `Create and review a new draft with "jobos tailor resume --job ${jobId} --profile ${profileId} --json".`
  ));
  else if (!resume.grounded) blockers.push(blocker(
    'resume_missing_proof_grounding',
    'The latest resume draft contains no evidence references to current stored proof points.',
    `Add relevant proof points, then rerun "jobos tailor resume --job ${jobId} --profile ${profileId} --json".`
  ));
  if (answers.unmatched) blockers.push(blocker(
    'unmatched_questions',
    `${answers.unmatched} ordinary application question(s) have no verified answer match.`,
    `Review the question list and add verified answers with "jobos answers add --profile ${profileId} ... --json".`,
    { count: answers.unmatched }
  ));
  if (answers.unresolvedRestricted) blockers.push(blocker(
    'restricted_questions_require_input',
    `${answers.unresolvedRestricted} restricted application question(s) require direct user input.`,
    `Store each exact direct response with \"jobos answers add --profile ${profileId} --category <restricted-category> --question <exact-prompt> --answer <direct-response> --sensitivity restricted --reuse never_auto_fill --source job:${jobId} --json\"; JobOS redacts and never auto-fills the value.`,
    { count: answers.unresolvedRestricted }
  ));
  if (duplicates.length) blockers.push(blocker(
    'possible_duplicate_application',
    'Local status evidence indicates a possible prior application for the same source or identity key.',
    'Review the listed local application record before proceeding; JobOS has not claimed a receipt or submitted anything.',
    { count: duplicates.length }
  ));

  const warnings = [];
  if (!coverLetter.artifactId) warnings.push({
    code: 'cover_letter_missing',
    message: 'No cover-letter draft exists. It is optional because not every application requests one.',
    nextAction: `If required, run "jobos tailor cover-letter --job ${jobId} --profile ${profileId} --json".`
  });
  else if (coverLetter.status === 'rejected') warnings.push({
    code: 'cover_letter_rejected',
    message: 'The current optional cover-letter revision was rejected in local review and is excluded from approval completeness.',
    nextAction: `Create a new draft with "jobos tailor cover-letter --job ${jobId} --profile ${profileId} --json" if this application requires a cover letter.`
  });
  if (duplicates.length) warnings.push({
    code: 'possible_duplicate_application',
    message: 'Possible duplicate evidence is based only on local job identity and application status/history.',
    nextAction: 'Verify the prior record manually; no submission receipt is inferred.'
  });

  const reviewableMaterials = [resume, coverLetter]
    .filter(material => material.artifactId && (material.required || material.status !== 'rejected'));
  const requiredArtifactIds = reviewableMaterials.map(material => material.artifactId);
  const approvedArtifactIds = [resume, coverLetter]
    .filter(material => material.status === 'approved')
    .map(material => material.artifactId);
  const pendingArtifactIds = [resume, coverLetter]
    .filter(material => material.status === 'reviewable-draft')
    .map(material => material.artifactId);
  const rejectedArtifactIds = [resume, coverLetter]
    .filter(material => material.status === 'rejected')
    .map(material => material.artifactId);
  const approvalsComplete = blockers.length === 0
    && requiredArtifactIds.length > 0
    && requiredArtifactIds.every(artifactId => approvedArtifactIds.includes(artifactId));
  const status = blockers.length ? 'blocked' : approvalsComplete ? 'approved' : 'ready-for-review';
  const readyForReview = status !== 'blocked';
  const mirrorPath = path.join('jobs', jobId, 'application-readiness.yaml');
  const packetSummary = includePacket ? readinessPacketSummary(s, { jobId, profileId }) : null;
  return {
    version: 3,
    generatedAt: now(),
    jobId,
    profileId,
    status,
    readyForReview,
    localApprovalComplete: status === 'approved',
    review: {
      requiredArtifactIds,
      approvedArtifactIds,
      pendingArtifactIds,
      rejectedArtifactIds,
      localApprovalComplete: status === 'approved'
    },
    identity: {
      identityKey,
      employerKey,
      sourceKey,
      applicationKey,
      dedupeKey: job.dedupe_key || '',
      source: job.source || 'manual',
      sourceUrl: sourceUrl || null
    },
    job: { id: job.id, title: job.title, company: job.company },
    application: application ? { id: application.id, status: application.status, updatedAt: application.updated_at } : null,
    materials: {
      proofs: { status: proofs.length ? 'available' : 'missing', count: proofs.length, proofPointIds: proofs.map(proof => proof.id) },
      score: scoreAvailable ? { status: 'available', overall: Number(job.fit_score), confidence: score.confidence || null, mode: score.mode || null } : { status: 'missing', overall: null, confidence: null, mode: null },
      resume,
      coverLetter
    },
    answers,
    blockers,
    nextActions: blockers.map(item => ({ code: item.code, action: item.nextAction })),
    warnings,
    possibleDuplicateApplications: duplicates,
    packet: includePacket ? (packetSummary || {
      currentPacketId: null,
      contentHash: null,
      attemptNumber: null,
      revision: null,
      currency: 'none',
      receiptState: 'none',
      attestable: false,
      latestReceiptId: null
    }) : null,
    mirrorPath,
    policy: {
      meaning: 'Reviewable completeness and local human approval from local evidence only.',
      externalSideEffects: 'none',
      submissionPerformed: false,
      applicationStatusChanged: false,
      readyDoesNotMean: ['submitted', 'applied', 'receipt-recorded', 'authorized-for-agent-submission']
    }
  };
}

export function planApplication(s, { jobId, profileId, writeMirror = true, policyContext = null, includePacket = true }) {
  const plan = compileApplicationReadiness(s, { jobId, profileId, includePacket });
  if (policyContext) plan.policy = { ...plan.policy, ...policyContext };
  if (writeMirror) writeYaml(path.join(s.p.ws, plan.mirrorPath), plan);
  return plan;
}
