import path from 'node:path';
import { all, one } from './db.js';
import { inspectApplicationQuestions } from './answers.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeYaml } from './workspace.js';
import { applicationId } from './tracking.js';
import { readinessPacketSummary } from './packets.js';
import { FIT_CONTRACT, deserializeFitScore } from './scoring.js';

import { resolveFormBindings } from './forms.js';
import { DOM_ADAPTER_MANIFEST } from './form-browser.js';
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

function topLevelNextAction({ status, blockers, pendingArtifactIds, packet, jobId, profileId, form }) {
  if (status === 'blocked') {
    return blockers[0]?.nextAction || 'Resolve the first blocker listed above, then re-run readiness.';
  }
  if (status === 'ready-for-review') {
    return pendingArtifactIds.length
      ? `Approve the pending draft revision(s) after review: ${pendingArtifactIds.map(artifactId => `"jobos artifacts approve ${artifactId} --json"`).join(', ')}.`
      : 'Review the current material revisions and approve them with "jobos artifacts approve <artifact-id> --json".';
  }
  if (status === 'materials-ready') {
    return `Inspect the real employer form before freezing a packet: "jobos apply form inspect --job ${jobId} --profile ${profileId} --url <application-url> --json".`;
  }
  if (status === 'form-blocked') {
    return form?.unresolvedFieldKeys?.length
      ? `Resolve the required live-form fields (${form.unresolvedFieldKeys.join(', ')}), then reinspect the form.`
      : 'Resolve the live-form blocker, then reinspect the form.';
  }
  const currency = packet?.currency || 'none';
  const receiptState = packet?.receiptState || 'none';
  if (!packet?.currentPacketId || currency !== 'current') {
    const staleNote = packet?.currentPacketId && currency !== 'none' ? ` The latest packet is ${currency}; a new one must be frozen.` : '';
    return `Freeze an immutable packet bound to this exact form: "jobos apply packet create --job ${jobId} --profile ${profileId} --json".${staleNote}`;
  }
  if (receiptState === 'none') {
    return `Submit manually and attest, or use the separately configured exact-bound form submission command for packet ${packet.currentPacketId}.`;
  }
  if (receiptState === 'attested') {
    return `Submission attested. Once the external system confirms receipt, record it: "jobos apply confirm-receipt ${packet.currentPacketId} --reference <external-reference> --json".`;
  }
  return 'Receipt confirmed — the application loop is complete locally. Follow-ups only (outreach, interview prep).';
}

export function compileApplicationReadiness(s, { jobId, profileId, includePacket = true }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw readinessError('unknown_job', `Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT id,name,preferences_json FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw readinessError('unknown_profile', `Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw readinessError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);

  const proofs = all(s, "SELECT id FROM proof_points WHERE profile_id=? AND status='active' AND verification_status='verified' ORDER BY created_at,id", [profileId]);
  const proofIds = new Set(proofs.map(proof => proof.id));
  const artifacts = latestArtifacts(s, jobId, profileId);
  const resume = artifactState(artifacts.get('resume'), proofIds, { required: true });
  const coverLetter = artifactState(artifacts.get('cover_letter'), proofIds, { required: false });
  const resumeRecord = resume.artifactId ? one(s, 'SELECT * FROM artifact_resume_documents WHERE artifact_id=?', [resume.artifactId]) : null;
  const resumeValidation = resumeRecord ? parseJson(resumeRecord.validation_json, null) : null;
  const resumeCoverage = resumeRecord ? parseJson(resumeRecord.coverage_json, null) : null;
  const resumeRenderManifest = resumeRecord ? parseJson(resumeRecord.render_manifest_json, null) : null;
  const currentResumeSource = one(s, 'SELECT id,revision FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profileId]);
  if (resume.artifactId) Object.assign(resume, {
    sourceResumeRevisionId: resumeRecord?.source_resume_revision_id || null,
    semanticValidation: resumeValidation,
    coverage: resumeCoverage?.summary || null,
    renderManifest: resumeRenderManifest
  });
  const storedScore = parseJson(job.score_json, null);
  const fit = deserializeFitScore(storedScore, { persistedOverall: job.fit_score, jobId, profileId });
  const scoreAvailable = fit?.contract === FIT_CONTRACT
    && fit.scoreStatus !== 'insufficient_evidence'
    && fit.overall != null
    && Number.isFinite(Number(fit.overall));
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
  if (resume.artifactId && !resumeRecord) blockers.push(blocker(
    'resume_document_incomplete',
    'The current resume artifact has no persisted semantic document snapshot.',
    `Regenerate it with "jobos tailor resume --job ${jobId} --profile ${profileId} --json".`
  ));
  if (resumeRecord && resumeRecord.source_resume_revision_id !== currentResumeSource?.id) blockers.push(blocker(
    'resume_stale_source_revision',
    'The tailored resume was built from an older canonical resume revision.',
    `Rerun "jobos tailor resume --job ${jobId} --profile ${profileId} --json" against canonical revision ${currentResumeSource?.revision || 'current'}.`,
    { sourceResumeRevisionId: resumeRecord.source_resume_revision_id, currentResumeRevisionId: currentResumeSource?.id || null }
  ));
  if (resumeRecord && (!resumeValidation || resumeValidation.valid !== true)) {
    const semanticBlockers = Array.isArray(resumeValidation?.blockers) && resumeValidation.blockers.length
      ? resumeValidation.blockers
      : [{ code: 'resume_document_incomplete', message: 'Semantic resume validation did not pass.' }];
    for (const item of semanticBlockers) blockers.push(blocker(
      item.code || 'resume_document_incomplete',
      item.message || 'Semantic resume validation did not pass.',
      item.code?.startsWith('resume_render')
        ? `Rerun "jobos tailor resume --job ${jobId} --profile ${profileId} --format pdf --json" after correcting the render blocker.`
        : `Correct the canonical resume or proofs, then rerun "jobos tailor resume --job ${jobId} --profile ${profileId} --json".`,
      { artifactId: resume.artifactId, ...item }
    ));
  }
  if (resumeRenderManifest?.format === 'pdf' && resumeRenderManifest.status !== 'passed' && !(resumeValidation?.blockers || []).some(item => item.code === 'resume_render_failed' || item.code === 'resume_render_text_invalid' || item.code === 'resume_page_budget_exceeded')) blockers.push(blocker(
    'resume_render_failed',
    'Requested PDF render validation did not pass.',
    `Rerun "jobos tailor resume --job ${jobId} --profile ${profileId} --format pdf --json" after installing or correcting the local renderer.`,
    { renderStatus: resumeRenderManifest.status }
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
  const materialsStatus = blockers.length ? 'blocked' : approvalsComplete ? 'approved' : 'ready-for-review';
  const resolvedForm = materialsStatus === 'approved'
    ? resolveFormBindings(s, { jobId, profileId })
    : { snapshot: null, bindings: [], requiredFieldCount: 0, resolvedFieldCount: 0, humanActionFieldKeys: [], unsupportedFieldKeys: [], unresolvedFieldKeys: [], formReady: false, autoFillComplete: false };
  const adapterCurrent = Boolean(resolvedForm.snapshot
    && resolvedForm.snapshot.adapter?.id === DOM_ADAPTER_MANIFEST.id
    && resolvedForm.snapshot.adapter?.protocolVersion === DOM_ADAPTER_MANIFEST.protocolVersion
    && resolvedForm.snapshot.adapter?.sourceHash === DOM_ADAPTER_MANIFEST.sourceHash);
  const inspectionStatus = !resolvedForm.snapshot ? 'uninspected' : adapterCurrent ? 'current' : 'stale';
  const form = {
    inspectionStatus,
    snapshotId: resolvedForm.snapshot?.snapshotId || null,
    fingerprint: resolvedForm.snapshot?.fingerprint || null,
    formReady: adapterCurrent && resolvedForm.formReady,
    autoFillComplete: adapterCurrent && resolvedForm.autoFillComplete,
    requiredFieldCount: resolvedForm.requiredFieldCount,
    resolvedFieldCount: resolvedForm.resolvedFieldCount,
    humanActionFieldKeys: resolvedForm.humanActionFieldKeys,
    unsupportedFieldKeys: resolvedForm.unsupportedFieldKeys,
    unresolvedFieldKeys: resolvedForm.unresolvedFieldKeys,
    bindings: resolvedForm.bindings
  };
  const status = materialsStatus === 'blocked'
    ? 'blocked'
    : materialsStatus === 'ready-for-review'
      ? 'ready-for-review'
      : inspectionStatus !== 'current'
        ? 'materials-ready'
        : resolvedForm.formReady
          ? 'form-ready'
          : 'form-blocked';
  const readyForReview = materialsStatus !== 'blocked';
  const mirrorPath = path.join('jobs', jobId, 'application-readiness.yaml');
  const packetSummary = includePacket ? readinessPacketSummary(s, { jobId, profileId }) : null;
  const packetView = includePacket ? (packetSummary || {
    currentPacketId: null,
    contentHash: null,
    attemptNumber: null,
    revision: null,
    currency: 'none',
    receiptState: 'none',
    attestable: false,
    latestReceiptId: null
  }) : null;
  const preferences = parseJson(profile.preferences_json, {});
  const externalActions = preferences.externalActions || {};
  const actionPolicy = {
    fillConfigured: externalActions.formFillEnabled === true || process.env.JOBOS_FORM_FILL_ENABLED === '1',
    submitConfigured: externalActions.formSubmitEnabled === true || process.env.JOBOS_FORM_SUBMIT_ENABLED === '1',
    mediatedFormInvocationConfigured: externalActions.agentFormInvocationEnabled === true || process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED === '1',
    fillRequiresPerInvocationAllowSideEffects: true,
    submitRequiresPerInvocationAllowSubmit: true
  };
  const nextAction = topLevelNextAction({ status, blockers, pendingArtifactIds, packet: packetView, jobId, profileId, form });
  return {
    version: 4,
    generatedAt: now(),
    jobId,
    profileId,
    status,
    materialsStatus,
    readyForReview,
    localApprovalComplete: materialsStatus === 'approved',
    review: {
      requiredArtifactIds,
      approvedArtifactIds,
      pendingArtifactIds,
      rejectedArtifactIds,
      localApprovalComplete: materialsStatus === 'approved'
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
      score: scoreAvailable ? {
        status: 'available',
        contract: fit.contract,
        overall: Number(fit.overall),
        baseOverall: fit.baseOverall,
        scoreStatus: fit.scoreStatus,
        evidenceCoverage: fit.evidenceCoverage,
        confidence: fit.confidence || null,
        mode: fit.mode || null
      } : {
        status: 'missing',
        contract: fit?.contract || null,
        overall: fit?.overall ?? null,
        baseOverall: fit?.baseOverall ?? null,
        scoreStatus: fit?.scoreStatus || null,
        evidenceCoverage: fit?.evidenceCoverage ?? null,
        confidence: fit?.confidence || null,
        mode: fit?.mode || null
      },
      resume,
      coverLetter
    },
    answers,
    form,
    actionPolicy,
    blockers,
    nextAction,
    nextActions: blockers.map(item => ({ code: item.code, action: item.nextAction })),
    warnings,
    possibleDuplicateApplications: duplicates,
    packet: packetView,
    mirrorPath,
    policy: {
      meaning: 'Material approval and live-form readiness from exact local evidence only.',
      externalSideEffects: 'none',
      submissionPerformed: false,
      applicationStatusChanged: false,
      readyDoesNotMean: ['filled', 'checkpointed', 'authorized-to-submit', 'authorized-for-agent-submission', 'submitted', 'applied', 'receipt-recorded']
    }
  };
}

export function planApplication(s, { jobId, profileId, writeMirror = true, policyContext = null, includePacket = true }) {
  const plan = compileApplicationReadiness(s, { jobId, profileId, includePacket });
  if (policyContext) plan.policy = { ...plan.policy, ...policyContext };
  if (writeMirror) writeYaml(path.join(s.p.ws, plan.mirrorPath), plan);
  return plan;
}
