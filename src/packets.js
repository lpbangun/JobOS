import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { id, now, parseJson } from './utils.js';
import { one, all, run, guardedWrite, queuePostCommit, recordAudit, projectAudit } from './db.js';
import { compileApplicationReadiness, planApplication } from './readiness.js';
import { applicationId, _writeApp } from './tracking.js';
import { syncJob } from './jobs.js';
import { writeYaml } from './workspace.js';
import { canonicalPacketFormBinding, resolveFormBindings } from './forms.js';

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------
function packetError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

// ---------------------------------------------------------------------------
// Canonical JSON serializer — deterministic, sorted keys, no whitespace
// ---------------------------------------------------------------------------
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// SHA-256 of canonical JSON
// ---------------------------------------------------------------------------
export function packetContentHash(projection) {
  return crypto.createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

// ---------------------------------------------------------------------------
// Answer row fingerprint — SHA-256 of {id, updatedAt, sensitivity, verificationStatus, reuseScope}
// ---------------------------------------------------------------------------
function answerRowFingerprint(answer) {
  const obj = {
    id: answer.id,
    updatedAt: answer.updated_at,
    sensitivity: answer.sensitivity,
    verificationStatus: answer.verification_status,
    reuseScope: answer.reuse_scope
  };
  return crypto.createHash('sha256').update(canonicalJson(obj)).digest('hex');
}
const SHA256_HEX = /^[a-f0-9]{64}$/;

function freezeApprovedResumePdf(s, renderManifest) {
  if (renderManifest?.format !== 'pdf' || renderManifest?.status !== 'passed') return null;
  const pdfPath = String(renderManifest.pdfPath || '').replaceAll('\\', '/');
  const pdfHash = String(renderManifest.pdfHash || '');
  if (!pdfPath || pdfPath.length > 512 || path.isAbsolute(pdfPath) || pdfPath.split('/').includes('..')
    || !pdfPath.toLowerCase().endsWith('.pdf') || !SHA256_HEX.test(pdfHash)) {
    throw packetError('resume_pdf_binding_invalid', 'Approved resume render manifest does not contain a bounded PDF path and SHA-256 hash');
  }
  let workspace;
  let resolved;
  let bytes;
  try {
    workspace = fs.realpathSync(s.p.ws);
    resolved = fs.realpathSync(path.resolve(workspace, pdfPath));
    const outside = path.relative(workspace, resolved);
    if (outside.startsWith('..') || path.isAbsolute(outside)) throw new Error('outside workspace');
    bytes = fs.readFileSync(resolved);
  } catch {
    throw packetError('resume_pdf_missing', 'Approved rendered resume PDF bytes are missing');
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== pdfHash) {
    throw packetError('resume_pdf_diverged', 'Approved rendered resume PDF bytes no longer match the render manifest');
  }
  return { pdfPath, pdfHash };
}


// ---------------------------------------------------------------------------
// Build the canonical version-2 packet projection from current state.
// W01 target/material shapes are preserved verbatim; form is a sibling binding.
export function buildPacketProjection(s, { jobId, profileId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw packetError('unknown_job', `Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT id,name FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw packetError('unknown_profile', `Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) {
    throw packetError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);
  }

  // Compile readiness WITHOUT packet decoration to avoid recursion.
  // The integration peer accepts includePacket: false.
  const readiness = compileApplicationReadiness(s, { jobId, profileId, includePacket: false });
  if (readiness.form?.inspectionStatus === 'stale') {
    throw packetError('adapter_hash_mismatch', 'The installed form adapter changed; reinspect before freezing a packet');
  }

  // Current resume and cover artifacts
  const currentResume = one(s, `SELECT * FROM artifacts WHERE job_id=? AND profile_id=? AND type='resume' ORDER BY revision DESC LIMIT 1`, [jobId, profileId]);
  const currentCover = one(s, `SELECT * FROM artifacts WHERE job_id=? AND profile_id=? AND type='cover_letter' ORDER BY revision DESC LIMIT 1`, [jobId, profileId]);
  const resumeDocument = currentResume ? one(s, 'SELECT * FROM artifact_resume_documents WHERE artifact_id=?', [currentResume.id]) : null;
  const resumeRenderManifest = parseJson(resumeDocument?.render_manifest_json, null);
  const frozenResumePdf = freezeApprovedResumePdf(s, resumeRenderManifest);

  if (!currentResume || currentResume.approval_status !== 'approved') {
    throw packetError('artifact_unapproved', 'The current resume revision is not approved');
  }

  const resolvedForm = resolveFormBindings(s, { jobId, profileId });
  if (!resolvedForm.snapshot) throw packetError('form_inspection_required', 'Inspect the current employer form before freezing a packet');
  if (!resolvedForm.formReady) throw packetError('packet_not_ready', 'The current employer form has unresolved required fields', {
    fieldKeys: resolvedForm.unresolvedFieldKeys
  });
  const form = canonicalPacketFormBinding(resolvedForm);
  const pinnedAnswerIds = new Set(resolvedForm.bindings
    .map(binding => binding.answerId)
    .filter(Boolean));
  const answers = all(s, `SELECT id, category, question_fingerprint, sensitivity, reuse_scope, verification_status, updated_at
    FROM answers WHERE profile_id=? ORDER BY question_fingerprint, id`, [profileId])
    .filter(answer => pinnedAnswerIds.has(answer.id));
  const answerEntries = answers.map(answer => ({
    questionFingerprint: answer.question_fingerprint,
    category: answer.category,
    answerId: answer.id,
    rowFingerprint: answerRowFingerprint(answer),
    sensitivity: answer.sensitivity,
    reuseScope: answer.reuse_scope,
    verificationStatus: answer.verification_status,
    responseMode: answer.sensitivity === 'restricted' ? 'direct_input_redacted' : 'auto_fill'
  }));

  // Cover letter only when the current revision is approved
  const coverEntry = currentCover && currentCover.approval_status === 'approved' ? {
    artifactId: currentCover.id,
    seriesKey: currentCover.series_key,
    revision: Number(currentCover.revision),
    contentHash: currentCover.content_hash
  } : null;

  // Build materials
  const materials = {
    resume: {
      artifactId: currentResume.id,
      seriesKey: currentResume.series_key,
      revision: Number(currentResume.revision),
      contentHash: currentResume.content_hash,
      sourceResumeRevisionId: resumeDocument?.source_resume_revision_id || null,
      pdfPath: frozenResumePdf?.pdfPath || null,
      pdfHash: frozenResumePdf?.pdfHash || null
    },
    coverLetter: coverEntry,
    proofPointIds: (readiness.materials.proofs.proofPointIds || []).slice().sort()
  };

  // Target identity
  const target = {
    jobId,
    profileId,
    title: job.title,
    company: job.company,
    location: job.location || null,
    identityKey: readiness.identity.identityKey,
    employerKey: readiness.identity.employerKey,
    sourceKey: readiness.identity.sourceKey,
    dedupeKey: readiness.identity.dedupeKey,
    source: readiness.identity.source,
    sourceUrl: readiness.identity.sourceUrl
  };

  return {
    version: 2,
    target,
    materials,
    answers: answerEntries,
    form,
    readiness: {
      version: readiness.version,
      status: readiness.status,
      localApprovalComplete: readiness.localApprovalComplete,
      blockers: readiness.blockers,
      warnings: readiness.warnings
    }
  };
}

// ---------------------------------------------------------------------------
// Derive receipt state for a packet
// ---------------------------------------------------------------------------
function packetReceiptState(s, packetId) {
  const receipt = one(s, `SELECT id,type FROM application_receipts WHERE packet_id=?
    ORDER BY CASE type WHEN 'imported_evidence' THEN 2 WHEN 'user_attestation' THEN 1 ELSE 0 END DESC, recorded_at DESC, id DESC
    LIMIT 1`, [packetId]);
  if (!receipt) return { receiptState: 'none', latestReceiptId: null };
  const state = ['imported_evidence', 'adapter_receipt'].includes(receipt.type) ? 'confirmed' : 'attested';
  return { receiptState: state, latestReceiptId: receipt.id };
}

function packetAttemptClosed(s, packetId) {
  const receipt = one(s, 'SELECT id FROM application_receipts WHERE packet_id=? LIMIT 1', [packetId]);
  if (receipt) return true;
  return Boolean(one(s, "SELECT id FROM form_submission_attempts WHERE packet_id=? AND status='confirmed' LIMIT 1", [packetId]));
}

// ---------------------------------------------------------------------------
// Determine packet currency state
// ---------------------------------------------------------------------------
function packetCurrency(s, packet, currentProjectionHash) {
  // Check if a newer packet exists in the series
  const newer = one(s, `SELECT id FROM application_packets
    WHERE job_id=? AND profile_id=?
      AND (attempt_number > ? OR (attempt_number = ? AND revision > ?))
    LIMIT 1`,
    [packet.job_id, packet.profile_id, packet.attempt_number, packet.attempt_number, packet.revision]);
  if (newer) return 'superseded';
  if (Number(packet.packet_version || 1) !== 2 || !packet.form_fingerprint || !packet.form_binding_json) return 'legacy-unbound';

  // Check staleness — compare stored hash with current projection
  if (currentProjectionHash == null || currentProjectionHash !== packet.content_hash) return 'stale';

  return 'current';
}

// ---------------------------------------------------------------------------
// Source validation helper
// ---------------------------------------------------------------------------
function assertTrustedSource(source, code = 'human_submission_attestation_required') {
  if (source !== 'cli' && source !== 'tui') {
    const action = code === 'human_packet_freeze_required' ? 'Packet freeze' : 'Submission attestation';
    throw packetError(code, `${action} requires trusted CLI or TUI source, not ${source || 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Normalize an RFC3339 datetime to UTC ISO-8601
// ---------------------------------------------------------------------------
function normalizeRfc3339(value) {
  if (!value || typeof value !== 'string') throw packetError('invalid_submitted_at', 'submittedAt must be a non-empty RFC 3339 string');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw packetError('invalid_submitted_at', `Invalid RFC 3339 datetime: ${value}`);
  // Reject timezone-naive strings that Date.parse interprets as UTC
  if (!/[+-]\d{2}:\d{2}$|Z$/i.test(value.trim())) {
    throw packetError('invalid_submitted_at', `submittedAt must include timezone offset or Z: ${value}`);
  }
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Build canonical receipt content object for hashing
// ---------------------------------------------------------------------------
function buildReceiptContent({ type, packetHash, submittedAt, externalReference, evidenceHash, note, formFingerprint = null, checkpointHash = null, submissionAttemptId = null, submissionActor = 'human' }) {
  return {
    version: formFingerprint ? 2 : 1,
    type,
    packetHash,
    formFingerprint,
    checkpointHash,
    submissionAttemptId,
    submissionActor,
    submittedAt,
    externalReference: externalReference || '',
    evidenceHash: evidenceHash || '',
    note: note || ''
  };
}

// ---------------------------------------------------------------------------
// Readiness summary — exported for readiness v3 integration
// ---------------------------------------------------------------------------
export function readinessPacketSummary(s, { jobId, profileId }) {
  const empty = { currentPacketId: null, contentHash: null, attemptNumber: null, revision: null, currency: 'none', receiptState: 'none', attestable: false, latestReceiptId: null };

  const packet = one(s, `SELECT * FROM application_packets
    WHERE job_id=? AND profile_id=?
    ORDER BY attempt_number DESC, revision DESC LIMIT 1`, [jobId, profileId]);
  if (!packet) return empty;

  let curHash = packet.content_hash;
  let currency = 'current';

  // Check superseded
  const newer = one(s, `SELECT id FROM application_packets
    WHERE job_id=? AND profile_id=?
      AND (attempt_number > ? OR (attempt_number = ? AND revision > ?))
    LIMIT 1`,
    [jobId, profileId, packet.attempt_number, packet.attempt_number, packet.revision]);
  if (newer) {
    currency = 'superseded';
  } else {
    // Check staleness — build current projection and compare hash
    try {
      const projection = buildPacketProjection(s, { jobId, profileId });
      curHash = projection ? packetContentHash(projection) : packet.content_hash;
      if (curHash !== packet.content_hash) currency = 'stale';
    } catch {
      // If projection fails (e.g. missing approval), the packet is stale
      currency = 'stale';
    }
  }

  const { receiptState, latestReceiptId } = packetReceiptState(s, packet.id);
  const attestable = currency === 'current' && receiptState === 'none';

  return {
    currentPacketId: packet.id,
    contentHash: packet.content_hash,
    attemptNumber: packet.attempt_number,
    revision: packet.revision,
    currency,
    receiptState,
    attestable,
    latestReceiptId
  };
}

// ---------------------------------------------------------------------------
// createApplicationPacket
// ---------------------------------------------------------------------------
export function createApplicationPacket(s, { jobId, profileId, createdBy }) {
  assertTrustedSource(createdBy, 'human_packet_freeze_required');

  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw packetError('unknown_job', `Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT id,name FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw packetError('unknown_profile', `Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) {
    throw packetError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);
  }

  // Compile readiness (without packet decoration) and validate
  const readiness = compileApplicationReadiness(s, { jobId, profileId, includePacket: false });
  if (readiness.status !== 'form-ready' || !readiness.localApprovalComplete) {
    const blockerCodes = readiness.blockers.map(b => b.code);
    if (blockerCodes.length > 0) {
      throw packetError('packet_not_ready', `Readiness is blocked: ${blockerCodes.join(', ')}`);
    }
    const pendingArtifacts = readiness.review.pendingArtifactIds;
    if (pendingArtifacts.length > 0) {
      throw packetError('artifact_unapproved', `Pending artifact review required: ${pendingArtifacts.join(', ')}`);
    }
    if (readiness.form?.inspectionStatus === 'uninspected') {
      throw packetError('form_inspection_required', 'Inspect the current employer form before freezing a packet');
    }
    if (readiness.form?.inspectionStatus === 'stale') {
      throw packetError('adapter_hash_mismatch', 'The installed form adapter changed; reinspect before freezing a packet');
    }
    throw packetError('packet_not_ready', 'Readiness must be form-ready with exact current bindings');
  }

  // Helper: verify artifact content hash against workspace mirror
  function verifyArtifact(artifact, label) {
    if (!artifact.content_hash) throw packetError('artifact_content_hash_mismatch', `${label} artifact has no content hash`);
    const mirrorPath = path.join(s.p.ws, artifact.path);
    if (!fs.existsSync(mirrorPath)) throw packetError('artifact_mirror_diverged', `Workspace mirror missing for ${label} artifact ${artifact.id}`);
    const mirrorContent = fs.readFileSync(mirrorPath, 'utf8');
    const mirrorHash = crypto.createHash('sha256').update(
      mirrorContent.endsWith('\n') ? mirrorContent : mirrorContent + '\n'
    ).digest('hex');
    if (mirrorHash !== artifact.content_hash) {
      throw packetError('artifact_mirror_diverged', `Workspace mirror content hash mismatch for ${label} artifact ${artifact.id}`);
    }
  }

  // Verify resume artifact integrity
  const resumeArtifact = one(s, `SELECT * FROM artifacts WHERE job_id=? AND type='resume' AND approval_status='approved' ORDER BY revision DESC LIMIT 1`, [jobId]);
  if (!resumeArtifact) throw packetError('artifact_unapproved', `No approved resume artifact for job ${jobId}`);
  verifyArtifact(resumeArtifact, 'Resume');

  // Optional cover: use the latest revision only if it is approved
  const coverArtifact = one(s, `SELECT * FROM artifacts WHERE job_id=? AND type='cover_letter' ORDER BY revision DESC LIMIT 1`, [jobId]);
  if (coverArtifact && coverArtifact.approval_status === 'approved') verifyArtifact(coverArtifact, 'Cover letter');

  // Build the canonical projection
  const projection = buildPacketProjection(s, { jobId, profileId });
  const contentHash = packetContentHash(projection);

  return guardedWrite(s, () => {
    const readiness = compileApplicationReadiness(s, { jobId, profileId, includePacket: false });
    if (readiness.status !== 'form-ready' || !readiness.localApprovalComplete) {
      const blockerCodes = readiness.blockers.map(blocker => blocker.code);
      if (blockerCodes.length) throw packetError('packet_not_ready', `Readiness is blocked: ${blockerCodes.join(', ')}`, { blockerCodes });
      if (readiness.review.pendingArtifactIds.length) {
        throw packetError('artifact_unapproved', `Pending artifact review required: ${readiness.review.pendingArtifactIds.join(', ')}`, {
          artifactIds: readiness.review.pendingArtifactIds
        });
      }
      if (readiness.form?.inspectionStatus === 'uninspected') throw packetError('form_inspection_required', 'Inspect the current employer form before freezing a packet');
      if (readiness.form?.inspectionStatus === 'stale') throw packetError('adapter_hash_mismatch', 'The installed form adapter changed; reinspect before freezing a packet');
      throw packetError('packet_not_ready', 'Readiness must be form-ready with exact current bindings');
    }
    const resumeArtifact = one(s, `SELECT * FROM artifacts WHERE job_id=? AND type='resume' AND approval_status='approved' ORDER BY revision DESC LIMIT 1`, [jobId]);
    if (!resumeArtifact) throw packetError('artifact_unapproved', `No approved resume artifact for job ${jobId}`);
    verifyArtifact(resumeArtifact, 'Resume');
    const coverArtifact = one(s, `SELECT * FROM artifacts WHERE job_id=? AND type='cover_letter' ORDER BY revision DESC LIMIT 1`, [jobId]);
    if (coverArtifact && coverArtifact.approval_status === 'approved') verifyArtifact(coverArtifact, 'Cover letter');
    const projection = buildPacketProjection(s, { jobId, profileId });
    const contentHash = packetContentHash(projection);
    // Reload authoritative state inside lock
    // Find the latest packet in this series
    const latestPacket = one(s, `SELECT * FROM application_packets
      WHERE job_id=? AND profile_id=?
      ORDER BY attempt_number DESC, revision DESC LIMIT 1`, [jobId, profileId]);

    let attemptNumber = 1;
    let revision = 1;
    let supersedesPacketId = null;

    if (latestPacket) {
      const closed = packetAttemptClosed(s, latestPacket.id);
      if (latestPacket.content_hash === contentHash && !closed) {
        const app = one(s, 'SELECT * FROM applications WHERE id=?', [latestPacket.application_id]);
        const display = formatPacketRow(s, latestPacket, contentHash);
        return {
          ...display,
          application: app,
          idempotent: true,
          externalSideEffects: 'none',
          submissionPerformed: false
        };
      }
      if (closed) {
        attemptNumber = latestPacket.attempt_number + 1;
        revision = 1;
      } else {
        attemptNumber = latestPacket.attempt_number;
        revision = latestPacket.revision + 1;
      }
      supersedesPacketId = latestPacket.id;
    }

    // Ensure application exists at materials-ready
    const appId = applicationId(jobId, profileId);
    const existingApp = one(s, 'SELECT * FROM applications WHERE id=?', [appId]);
    let application;
    let auditEvents = [];

    if (!existingApp) {
      application = _writeApp(s, jobId, profileId, 'materials-ready', '', { receiptBound: false, skipIfExists: true, persist: false });
    } else {
      application = existingApp;
    }

    // Build the JSON columns for the packet row
    const answersJson = JSON.stringify(projection.answers);
    const identityJson = JSON.stringify(projection.target);
    const materialsJson = JSON.stringify(projection.materials);
    const blockersJson = JSON.stringify(readiness.blockers || []);
    const warningsJson = JSON.stringify(readiness.warnings || []);
    const formBindingJson = JSON.stringify(projection.form);

    const packetId = id('pkt', `${jobId}:${profileId}:${attemptNumber}:${revision}:${contentHash}`);
    const createdAt = now();

    run(s, `INSERT INTO application_packets
      (id, job_id, profile_id, application_id, attempt_number, revision, content_hash,
       readiness_status_at_create, readiness_version, packet_version, form_snapshot_id, form_fingerprint, form_binding_json,
       resume_artifact_id, resume_content_hash,
       cover_artifact_id, cover_content_hash,
       answers_json, identity_json, materials_json, blockers_json, warnings_json,
       created_at, created_by_source, supersedes_packet_id)
      VALUES (?,?,?,?,?,?,?,
              ?,?,?,?,?,?,
              ?,?,
              ?,?,
              ?,?,?,?,?,
              ?,?,?)`,
      [packetId, jobId, profileId, appId, attemptNumber, revision, contentHash,
       'form-ready', readiness.version || 4, 2, readiness.form.snapshotId, projection.form.formFingerprint, formBindingJson,
       resumeArtifact.id, resumeArtifact.content_hash,
       coverArtifact ? coverArtifact.id : null, coverArtifact ? coverArtifact.content_hash : null,
       answersJson, identityJson, materialsJson, blockersJson, warningsJson,
       createdAt, createdBy, supersedesPacketId]);

    // Audit
    const auditPayload = {
      jobId,
      profileId,
      packetId,
      contentHash,
      attemptNumber,
      revision,
      supersedesPacketId: supersedesPacketId || null,
      externalSideEffects: 'none',
      submissionPerformed: false
    };
    const auditEvent = recordAudit(s, 'application_packet.created', 'application_packet', packetId, auditPayload, 'none');
    auditEvents.push(auditEvent);

    // Queue post-commit projections
    const packetMirrorDir = path.join('jobs', jobId, 'packets');
    const packetMirrorPath = path.join(packetMirrorDir, `${packetId}.yaml`);

    queuePostCommit(s, () => {
      // Packet YAML mirror
      writeYaml(path.join(s.p.ws, packetMirrorPath), formatPacketRow(
        s,
        one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]),
        contentHash
      ));

      // Project audit events
      for (const evt of auditEvents) {
        if (evt) projectAudit(s, evt);
      }

      // Sync job projection
      syncJob(s, jobId);

      // Refresh readiness YAML
      try {
        planApplication(s, { jobId, profileId, writeMirror: true });
      } catch {
        // Readiness YAML refresh is best-effort post-commit
      }
    });

    const row = one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]);
    const display = formatPacketRow(s, row, contentHash);
    return {
      ...display,
      application: one(s, 'SELECT * FROM applications WHERE id=?', [appId]),
      idempotent: false,
      externalSideEffects: 'none',
      submissionPerformed: false
    };
  });
}

// ---------------------------------------------------------------------------
// Format a packet row for public output (never includes answer values)
// ---------------------------------------------------------------------------
function formatPacketRow(s, row, currentProjectionHash) {
  return derivePacketDisplay(s, row, currentProjectionHash);
}

// ---------------------------------------------------------------------------
// Derive packet display data (currency, receipt state, attestable)
// ---------------------------------------------------------------------------
function derivePacketDisplay(s, row, currentProjectionHash) {
  const { receiptState, latestReceiptId } = packetReceiptState(s, row.id);
  const currency = packetCurrency(s, row, currentProjectionHash);
  const receipts = all(s, 'SELECT * FROM application_receipts WHERE packet_id=? ORDER BY recorded_at,id', [row.id]).map(formatReceiptRow);
  return {
    id: row.id,
    jobId: row.job_id,
    profileId: row.profile_id,
    applicationId: row.application_id,
    attemptNumber: row.attempt_number,
    revision: row.revision,
    contentHash: row.content_hash,
    version: Number(row.packet_version || 1),
    readinessStatusAtCreate: row.readiness_status_at_create,
    readinessVersion: row.readiness_version,
    resumeArtifactId: row.resume_artifact_id,
    resumeContentHash: row.resume_content_hash,
    coverArtifactId: row.cover_artifact_id || null,
    coverContentHash: row.cover_content_hash || null,
    answers: parseJson(row.answers_json, []),
    target: parseJson(row.identity_json, {}),
    materials: parseJson(row.materials_json, {}),
    blockers: parseJson(row.blockers_json, []),
    warnings: parseJson(row.warnings_json, []),
    form: row.form_binding_json ? { ...parseJson(row.form_binding_json, {}), snapshotId: row.form_snapshot_id || null } : null,
    createdAt: row.created_at,
    createdBySource: row.created_by_source,
    supersedesPacketId: row.supersedes_packet_id || null,
    currency,
    receiptState,
    attestable: Number(row.packet_version || 1) === 2 && currency === 'current' && receiptState === 'none',
    latestReceiptId,
    receipts
  };
}

// ---------------------------------------------------------------------------
// listApplicationPackets
// ---------------------------------------------------------------------------
export function listApplicationPackets(s, { jobId, profileId }) {
  if (!jobId && !profileId) {
    throw packetError('packet_list_filter_required', 'At least one of jobId or profileId filter is required');
  }

  let conditions = [];
  let params = [];

  if (jobId) {
    conditions.push('job_id=?');
    params.push(jobId);
  }
  if (profileId) {
    conditions.push('profile_id=?');
    params.push(profileId);
  }

  const rows = all(s, `SELECT * FROM application_packets WHERE ${conditions.join(' AND ')} ORDER BY attempt_number DESC, revision DESC`, params);

  const currentHashes = new Map();
  return rows.map(row => {
    const key = `${row.job_id}\u0000${row.profile_id}`;
    if (!currentHashes.has(key)) {
      try {
        currentHashes.set(key, packetContentHash(buildPacketProjection(s, { jobId: row.job_id, profileId: row.profile_id })));
      } catch {
        currentHashes.set(key, null);
      }
    }
    return derivePacketDisplay(s, row, currentHashes.get(key));
  });
}

// ---------------------------------------------------------------------------
// showApplicationPacket
// ---------------------------------------------------------------------------
export function showApplicationPacket(s, packetId) {
  const row = one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]);
  if (!row) throw packetError('unknown_packet', `Unknown packet: ${packetId}`);

  let currentHash = null;
  try {
    const proj = buildPacketProjection(s, { jobId: row.job_id, profileId: row.profile_id });
    currentHash = packetContentHash(proj);
  } catch {
    // Best-effort
  }

  return derivePacketDisplay(s, row, currentHash);
}

// ---------------------------------------------------------------------------
// diffApplicationPackets
// ---------------------------------------------------------------------------
export function diffApplicationPackets(s, firstPacketId, secondPacketId) {
  const a = one(s, 'SELECT * FROM application_packets WHERE id=?', [firstPacketId]);
  if (!a) throw packetError('unknown_packet', `Unknown packet: ${firstPacketId}`);
  const b = one(s, 'SELECT * FROM application_packets WHERE id=?', [secondPacketId]);
  if (!b) throw packetError('unknown_packet', `Unknown packet: ${secondPacketId}`);

  // Build canonical projections from the stored JSON columns
  function rebuildProjection(row) {
    const version = Number(row.packet_version || 1);
    const projection = {
      version,
      target: parseJson(row.identity_json, {}),
      materials: parseJson(row.materials_json, {}),
      answers: parseJson(row.answers_json, []),
      readiness: {
        version: row.readiness_version,
        status: row.readiness_status_at_create,
        localApprovalComplete: true,
        blockers: parseJson(row.blockers_json, []),
        warnings: parseJson(row.warnings_json, [])
      }
    };
    if (version === 2) projection.form = parseJson(row.form_binding_json, null);
    return projection;
  }

  const projA = rebuildProjection(a);
  const projB = rebuildProjection(b);
  const hashA = packetContentHash(projA);
  const hashB = packetContentHash(projB);
  const sameContent = hashA === hashB;

  // Compute differences via recursive comparison
  const changes = [];
  function compare(label, va, vb) {
    if (va === vb) return;
    if (va && typeof va === 'object' && vb && typeof vb === 'object') {
      const allKeys = new Set([...Object.keys(va), ...Object.keys(vb)]);
      for (const k of allKeys) {
        compare(`${label}/${k}`, va[k], vb[k]);
      }
      return;
    }
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) {
        changes.push({ path: label, before: va, after: vb });
      } else {
        for (let i = 0; i < va.length; i++) {
          compare(`${label}/${i}`, va[i], vb[i]);
        }
      }
      return;
    }
    changes.push({ path: label, before: va, after: vb });
  }

  compare('', projA, projB);

  return {
    firstPacketId,
    secondPacketId,
    sameContent,
    changes
  };
}

// ---------------------------------------------------------------------------
// attestApplicationSubmitted
// ---------------------------------------------------------------------------
export function attestApplicationSubmitted(s, { packetId, submittedAt, note, source }) {
  assertTrustedSource(source);

  const packet = one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]);
  if (!packet) throw packetError('unknown_packet', `Unknown packet: ${packetId}`);
  if (Number(packet.packet_version || 1) !== 2 || !packet.form_fingerprint || !packet.form_binding_json) {
    throw packetError('legacy_packet_unbound', `Packet ${packetId} is not bound to a versioned live form; re-inspect and freeze a packet v2`);
  }

  // Validate submitted_at
  const normalizedAt = normalizeRfc3339(submittedAt);
  const packetHash = packet.content_hash;


  return guardedWrite(s, () => {
    // Re-check every receipt/confirmed-attempt closure before allowing manual evidence.
    const anyReceipt = one(s, 'SELECT * FROM application_receipts WHERE packet_id=? ORDER BY recorded_at,id LIMIT 1', [packetId]);
    if (anyReceipt && anyReceipt.type !== 'user_attestation') {
      throw packetError('packet_already_submitted', `Packet ${packetId} already has confirmed submission evidence`, {
        receiptId: anyReceipt.id,
        receiptType: anyReceipt.type,
        idempotent: true
      });
    }
    if (!anyReceipt) {
      const confirmedAttempt = one(s, "SELECT id FROM form_submission_attempts WHERE packet_id=? AND status='confirmed' LIMIT 1", [packetId]);
      if (confirmedAttempt) {
        throw packetError('packet_already_submitted', `Packet ${packetId} already has a confirmed configured submission`, {
          submissionAttemptId: confirmedAttempt.id,
          idempotent: true
        });
      }
    }
    const existing = anyReceipt;
    if (existing) {
      // Idempotency check
      const rc = buildReceiptContent({
        type: 'user_attestation',
        packetHash,
        submittedAt: normalizedAt,
        externalReference: '',
        evidenceHash: '',
        note: note || '',
        formFingerprint: packet.form_fingerprint
      });
      const receiptHash = packetContentHash(rc);
      if (existing.receipt_hash === receiptHash) {
        // Idempotent
        queuePostCommit(s, () => {
          // Refresh readiness YAML
          try { planApplication(s, { jobId: packet.job_id, profileId: packet.profile_id, writeMirror: true }); } catch {}
          syncJob(s, packet.job_id);
        });
        return {
          receipt: formatReceiptRow(existing),
          receiptId: existing.id,
          idempotent: true,
          receiptBound: true,
          applicationStatusChanged: false,
          previousStatus: null,
          currentStatus: null,
          externalSideEffects: 'none',
          submissionPerformed: false
        };
      }
      // Conflict — different hash for same packet/type
      throw packetError('receipt_conflict', `Existing receipt for packet ${packetId} has different content; original receipt unchanged`);
    }
    const lockedPacket = one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]);
    if (!lockedPacket) throw packetError('unknown_packet', `Unknown packet: ${packetId}`);
    let lockedHash = null;
    try {
      lockedHash = packetContentHash(buildPacketProjection(s, { jobId: lockedPacket.job_id, profileId: lockedPacket.profile_id }));
    } catch {}
    const lockedCurrency = packetCurrency(s, lockedPacket, lockedHash);
    if (lockedCurrency !== 'current') {
      throw packetError('packet_stale', `Packet ${packetId} is ${lockedCurrency}; only current packets are attestable`, {
        changedPaths: lockedHash !== lockedPacket.content_hash ? ['/contentHash'] : []
      });
    }

    const at = now();
    const receiptId = id('rcpt', `${packetId}:user_attestation:${normalizedAt}`);

    const receiptContent = buildReceiptContent({
      type: 'user_attestation',
      packetHash,
      submittedAt: normalizedAt,
      externalReference: '',
      evidenceHash: '',
      note: note || '',
      formFingerprint: packet.form_fingerprint
    });
    const receiptHash = packetContentHash(receiptContent);

    run(s, `INSERT INTO application_receipts
      (id, packet_id, application_id, type, submitted_at, recorded_at,
       external_reference, evidence_path, evidence_hash, note, receipt_hash, source, external_side_effect,
       evidence_version, form_fingerprint, submission_actor, policy_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [receiptId, packetId, packet.application_id, 'user_attestation', normalizedAt, at,
       '', '', '', note || '', receiptHash, source, 'none',
       2, packet.form_fingerprint, 'human', JSON.stringify({ submissionPerformed: false, evidenceKind: 'manual_attestation' })]);

    // Application status transition
    const app = one(s, 'SELECT * FROM applications WHERE id=?', [packet.application_id]);
    const preApplyStatuses = new Set(['saved', 'researching', 'materials-ready']);
    let statusChanged = false;
    let previousStatus = app.status;
    let currentStatus = app.status;

    if (preApplyStatuses.has(app.status)) {
      // Advance to applied
      const changeNote = `Packet: ${packetId} Hash: ${packetHash} Receipt: ${receiptId}`;
      const statusChangeId = id('status', `${app.id}:${app.status}:applied:${at}`);
      run(s, 'INSERT INTO status_changes VALUES (?,?,?,?,?,?,?,?)',
        [statusChangeId, app.id, packet.job_id, packet.profile_id, app.status, 'applied', changeNote, at]);
      run(s, 'UPDATE applications SET status=?, updated_at=? WHERE id=?', ['applied', at, app.id]);
      currentStatus = 'applied';
      statusChanged = true;
    }

    // Audit
    const auditPayload = {
      jobId: packet.job_id,
      profileId: packet.profile_id,
      packetId,
      packetHash,
      receiptId,
      receiptHash,
      type: 'user_attestation',
      submittedAt: normalizedAt,
      previousStatus,
      currentStatus,
      applicationStatusChanged: statusChanged,
      externalSideEffects: 'none',
      submissionPerformed: false,
      receiptBound: true
    };
    const auditEvent = recordAudit(s, 'application.submission_attested', 'application_receipt', receiptId, auditPayload, 'none');

    // Post-commit projections
    queuePostCommit(s, () => {
      projectAudit(s, auditEvent);
      // Packet YAML refresh (receipt summary)
      try {
        const packetDir = path.join('jobs', packet.job_id, 'packets');
        const yamlPath = path.join(s.p.ws, packetDir, `${packetId}.yaml`);
        if (fs.existsSync(yamlPath)) {
          writeYaml(yamlPath, showApplicationPacket(s, packetId));
        }
      } catch {}
      // Refresh readiness YAML
      try { planApplication(s, { jobId: packet.job_id, profileId: packet.profile_id, writeMirror: true }); } catch {}
      syncJob(s, packet.job_id);
    });

    return {
      receipt: formatReceiptRow(one(s, 'SELECT * FROM application_receipts WHERE id=?', [receiptId])),
      receiptId,
      idempotent: false,
      receiptBound: true,
      applicationStatusChanged: statusChanged,
      previousStatus,
      currentStatus: currentStatus,
      externalSideEffects: 'none',
      submissionPerformed: false
    };
  });
}

// ---------------------------------------------------------------------------
// confirmApplicationReceipt
// ---------------------------------------------------------------------------
export function confirmApplicationReceipt(s, { packetId, reference, note, source }) {
  assertTrustedSource(source);

  const packet = one(s, 'SELECT * FROM application_packets WHERE id=?', [packetId]);
  if (!packet) throw packetError('unknown_packet', `Unknown packet: ${packetId}`);

  // Require prior attestation
  const attestation = one(s, "SELECT * FROM application_receipts WHERE packet_id=? AND type='user_attestation'", [packetId]);
  if (!attestation) throw packetError('receipt_attestation_required', `Packet ${packetId} has no user attestation; confirm requires prior attestation`);

  // Require non-empty reference
  if (!reference || typeof reference !== 'string' || !reference.trim()) {
    throw packetError('receipt_reference_required', 'A non-empty external reference is required for receipt confirmation');
  }

  return guardedWrite(s, () => {
    // Check for existing imported_evidence
    const existing = one(s, "SELECT * FROM application_receipts WHERE packet_id=? AND type='imported_evidence'", [packetId]);

    // Determine if reference is an absolute HTTP(S) URL
    const isHttpUrl = /^https?:\/\/.+/.test(reference.trim());

    const receiptContent = buildReceiptContent({
      type: 'imported_evidence',
      packetHash: packet.content_hash,
      submittedAt: attestation.submitted_at,
      externalReference: reference.trim(),
      evidenceHash: '',
      note: note || ''
    });
    const receiptHash = packetContentHash(receiptContent);

    if (existing) {
      if (existing.receipt_hash === receiptHash) {
        // Idempotent
        queuePostCommit(s, () => {
          try { planApplication(s, { jobId: packet.job_id, profileId: packet.profile_id, writeMirror: true }); } catch {}
          syncJob(s, packet.job_id);
        });
        return {
          receipt: formatReceiptRow(existing),
          receiptId: existing.id,
          idempotent: true,
          receiptState: 'confirmed',
          confirmationUrl: isHttpUrl ? reference.trim() : null,
          externalSideEffects: 'none',
          submissionPerformed: false
        };
      }
      throw packetError('receipt_conflict', `Existing confirmation for packet ${packetId} has different content; original unchanged`);
    }

    const at = now();
    const receiptId = id('rcpt', `${packetId}:imported_evidence:${at}`);

    run(s, `INSERT INTO application_receipts
      (id, packet_id, application_id, type, submitted_at, recorded_at,
       external_reference, evidence_path, evidence_hash, note, receipt_hash, source, external_side_effect)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [receiptId, packetId, packet.application_id, 'imported_evidence', attestation.submitted_at, at,
       reference.trim(), '', '', note || '', receiptHash, source, 'none']);

    // Set confirmation_url on application if HTTP(S) reference
    if (isHttpUrl) {
      run(s, 'UPDATE applications SET confirmation_url=?, updated_at=? WHERE id=?',
        [reference.trim(), at, packet.application_id]);
    }

    // Audit
    const auditPayload = {
      jobId: packet.job_id,
      profileId: packet.profile_id,
      packetId,
      receiptId,
      receiptHash,
      type: 'imported_evidence',
      externalReference: reference.trim(),
      isHttpUrl,
      externalSideEffects: 'none',
      applicationStatusChanged: false,
      submissionPerformed: false,
      receiptBound: true
    };
    const auditEvent = recordAudit(s, 'application.receipt_confirmed', 'application_receipt', receiptId, auditPayload, 'none');

    // Post-commit projections
    queuePostCommit(s, () => {
      projectAudit(s, auditEvent);
      // Packet YAML refresh
      try {
        const packetDir = path.join('jobs', packet.job_id, 'packets');
        writeYaml(path.join(s.p.ws, packetDir, `${packetId}.yaml`), showApplicationPacket(s, packetId));
      } catch {}
      // Refresh readiness YAML
      try { planApplication(s, { jobId: packet.job_id, profileId: packet.profile_id, writeMirror: true }); } catch {}
      syncJob(s, packet.job_id);
    });

    return {
      receipt: formatReceiptRow(one(s, 'SELECT * FROM application_receipts WHERE id=?', [receiptId])),
      receiptId,
      idempotent: false,
      receiptState: 'confirmed',
      confirmationUrl: isHttpUrl ? reference.trim() : null,
      externalSideEffects: 'none',
      submissionPerformed: false
    };
  });
}

// ---------------------------------------------------------------------------
// Format a receipt row for public output
// ---------------------------------------------------------------------------
function formatReceiptRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    evidenceVersion: Number(row.evidence_version || 1),
    formFingerprint: row.form_fingerprint || null,
    checkpointId: row.checkpoint_id || null,
    checkpointHash: row.checkpoint_hash || null,
    submissionAttemptId: row.submission_attempt_id || null,
    submissionActor: row.submission_actor || 'human',
    adapter: parseJson(row.adapter_json, null),
    confirmationOrigin: row.confirmation_origin || null,
    confirmationPath: row.confirmation_path || null,
    policy: parseJson(row.policy_json, {}),
    packetId: row.packet_id,
    applicationId: row.application_id,
    type: row.type,
    submittedAt: row.submitted_at,
    recordedAt: row.recorded_at,
    externalReference: row.external_reference || null,
    evidencePath: row.evidence_path || null,
    evidenceHash: row.evidence_hash || null,
    note: row.note || null,
    receiptHash: row.receipt_hash,
    source: row.source,
    externalSideEffect: row.external_side_effect
  };
}
