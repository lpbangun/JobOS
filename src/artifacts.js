import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, guardedWrite, one, projectAudit, queuePostCommit, recordAudit, run, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd } from './workspace.js';
import { planApplication } from './readiness.js';
import {
  appendMemoryObservation,
  queueMemorySync,
} from './career-memory-observations.js';
import {
  ARTIFACT_FEEDBACK_INPUT_SCHEMA,
  normalizeArtifactFeedbackInput,
  normalizeRfc3339,
} from './career-memory-contract.js';

const REVIEW_STATUSES = new Set(['draft_needs_human_review', 'approved', 'rejected']);
const HUMAN_REVIEW_SOURCES = new Set(['cli', 'tui']);
const REVIEW_DECISION_BY_EVENT = Object.freeze({
  artifact_approved: 'approve',
  artifact_rejected: 'reject',
});
const EDIT_DECISION = 'edit';
const FEEDBACK_DECISION_BY_REVIEW = Object.freeze({
  approved: 'approve',
  rejected: 'reject',
});

export class ArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtifactError';
    this.type = 'artifact_error';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { type: this.type, code: this.code, message: this.message, details: this.details };
  }
}

export function normalizeArtifactContent(content) {
  const value = String(content ?? '');
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function artifactContentHash(content) {
  return crypto.createHash('sha256').update(normalizeArtifactContent(content)).digest('hex');
}

function token(value, fallback = 'none') {
  const normalized = String(value ?? '').trim();
  return encodeURIComponent(normalized || fallback);
}

export function artifactSeriesKey({ type, jobId = null, profileId = null, series = {}, path: artifactPath = '' }) {
  const kind = series.kind || type;
  if (kind === 'resume') return `resume:${token(jobId)}:${token(profileId)}`;
  if (kind === 'cover' || kind === 'cover_letter') return `cover_letter:${token(jobId)}:${token(profileId)}`;
  if (kind === 'outreach') {
    if (!series.stakeholderId) throw new ArtifactError('artifact_series_incomplete', 'Outreach artifacts require a stakeholderId series identity.');
    return `outreach:${token(jobId)}:${token(profileId)}:${token(series.stakeholderId)}:${token(series.goal, 'informational')}`;
  }
  if (kind === 'interview' || kind === 'interview_prep') {
    if (!series.applicationId) throw new ArtifactError('artifact_series_incomplete', 'Interview prep artifacts require an applicationId series identity.');
    return `interview_prep:${token(series.applicationId)}:${token(slug(series.stage || 'interview'))}`;
  }
  if (kind === 'followup') {
    const producerId = series.taskId || series.producerId;
    if (producerId) return `followup:${token(producerId)}`;
  }
  const producer = series.producerId || artifactPath;
  if (!producer) throw new ArtifactError('artifact_series_incomplete', `Artifact type ${type} requires a stable producer or path identity.`);
  return `${token(type)}:producer:${token(producer)}`;
}

function rowProjection(row, currentRevision = null) {
  const revision = Number(row.revision);
  const isCurrent = currentRevision == null ? true : revision === Number(currentRevision);
  const approvalStatus = row.approval_status;
  return {
    id: row.id,
    jobId: row.job_id || null,
    profileId: row.profile_id || null,
    type: row.type,
    path: row.path,
    title: row.title,
    content: row.content,
    evidence: parseJson(row.evidence_json, []),
    warnings: parseJson(row.warnings_json, []),
    approvalStatus,
    seriesKey: row.series_key,
    revision,
    supersedesArtifactId: row.supersedes_artifact_id || null,
    contentHash: row.content_hash,
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    reviewNote: row.review_note || '',
    createdAt: row.created_at,
    revisionState: isCurrent ? 'current' : 'superseded',
    effectiveReviewStatus: isCurrent
      ? (approvalStatus === 'draft_needs_human_review' ? 'pending' : approvalStatus)
      : 'stale'
  };
}

export function getArtifact(s, artifactId) {
  const row = one(s, `SELECT artifacts.*,(SELECT MAX(revision) FROM artifacts current
    WHERE current.series_key=artifacts.series_key) AS current_revision FROM artifacts WHERE id=?`, [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`, { artifactId });
  return rowProjection(row, row.current_revision);
}

export function artifactHistory(s, artifactId) {
  const selected = one(s, 'SELECT series_key FROM artifacts WHERE id=?', [artifactId]);
  if (!selected) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`, { artifactId });
  const rows = all(s, 'SELECT * FROM artifacts WHERE series_key=? ORDER BY revision DESC', [selected.series_key]);
  const currentRevision = Number(rows[0]?.revision || 0);
  return rows.map(row => rowProjection(row, currentRevision));
}

export function currentArtifacts(s, { jobId = null, profileId = null, types = null } = {}) {
  const where = ['NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.series_key=artifacts.series_key AND newer.revision>artifacts.revision)'];
  const params = [];
  if (jobId) { where.push('artifacts.job_id=?'); params.push(jobId); }
  if (profileId) { where.push('artifacts.profile_id=?'); params.push(profileId); }
  if (Array.isArray(types) && types.length > 0) {
    where.push(`artifacts.type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  return all(s, `SELECT artifacts.* FROM artifacts WHERE ${where.join(' AND ')} ORDER BY artifacts.created_at DESC,artifacts.id DESC`, params)
    .map(row => rowProjection(row, row.revision));
}

export function artifactQueue(s, { profileId = null, jobId = null } = {}) {
  const where = [
    "artifacts.approval_status='draft_needs_human_review'",
    'NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.series_key=artifacts.series_key AND newer.revision>artifacts.revision)'
  ];
  const params = [];
  if (profileId) { where.push('artifacts.profile_id=?'); params.push(profileId); }
  if (jobId) { where.push('artifacts.job_id=?'); params.push(jobId); }
  return all(s, `SELECT artifacts.*,jobs.title AS job_title,jobs.company,profiles.name AS profile_name
    FROM artifacts
    LEFT JOIN jobs ON jobs.id=artifacts.job_id
    LEFT JOIN profiles ON profiles.id=artifacts.profile_id
    WHERE ${where.join(' AND ')}
    ORDER BY artifacts.created_at DESC,artifacts.id DESC`, params).map(row => ({
      ...rowProjection(row, row.revision),
      content: undefined,
      evidenceCount: parseJson(row.evidence_json, []).length,
      warningCount: parseJson(row.warnings_json, []).length,
      jobTitle: row.job_title || '',
      company: row.company || '',
      profileName: row.profile_name || ''
    }));
}

function queueArtifactProjections(s, artifact, event, { refreshReadiness = true } = {}) {
  queuePostCommit(s, () => writeMd(path.join(s.p.ws, artifact.path), artifact.content));
  if (event) queuePostCommit(s, () => projectAudit(s, event));
  if (refreshReadiness && artifact.jobId && artifact.profileId && ['resume', 'cover_letter'].includes(artifact.type)) {
    queuePostCommit(s, () => planApplication(s, { jobId: artifact.jobId, profileId: artifact.profileId }));
  }
}

function insertArtifact(s, input) {
  const type = String(input.type || '').trim();
  if (!type) throw new ArtifactError('artifact_type_required', 'Artifact type is required.');
  const seriesKey = input.seriesKey || artifactSeriesKey({
    type,
    jobId: input.jobId,
    profileId: input.profileId,
    series: input.series,
    path: input.path
  });
  if (input.dedupePath) {
    const existing = one(s, 'SELECT * FROM artifacts WHERE path=? ORDER BY revision DESC LIMIT 1', [input.path]);
    if (existing) return { artifact: rowProjection(existing, existing.revision), created: false, event: null };
  }
  const predecessor = one(s, 'SELECT * FROM artifacts WHERE series_key=? ORDER BY revision DESC LIMIT 1', [seriesKey]);
  const revision = Number(predecessor?.revision || 0) + 1;
  if (predecessor && predecessor.series_key !== seriesKey) {
    throw new ArtifactError('artifact_predecessor_invalid', 'Artifact predecessor must belong to the same series.', { seriesKey, predecessorId: predecessor.id });
  }
  const content = normalizeArtifactContent(input.content);
  const contentHash = artifactContentHash(content);
  const createdAt = now();
  const artifactId = id('artifact', `${seriesKey}:${revision}:${contentHash}:${createdAt}`);
  const approvalStatus = input.approvalStatus || 'draft_needs_human_review';
  if (!REVIEW_STATUSES.has(approvalStatus)) throw new ArtifactError('artifact_review_status_invalid', `Invalid artifact review status: ${approvalStatus}`);
  run(s, `INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,
    series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    artifactId,
    input.jobId || null,
    input.profileId || null,
    type,
    input.path,
    input.title,
    content,
    JSON.stringify(input.evidence || []),
    JSON.stringify(input.warnings || []),
    approvalStatus,
    createdAt,
    seriesKey,
    revision,
    predecessor?.id || null,
    contentHash,
    null,
    null,
    ''
  ]);
  const artifact = rowProjection(one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]), revision);
  input.mutate?.(s, artifact);
  const payload = {
    jobId: artifact.jobId,
    profileId: artifact.profileId,
    type: artifact.type,
    path: artifact.path,
    seriesKey,
    revision,
    supersedesArtifactId: artifact.supersedesArtifactId,
    contentHash,
    approvalStatus,
    ...(input.auditPayload || {})
  };
  const event = recordAudit(s, input.auditAction || 'artifact.created', 'artifact', artifactId, payload, 'none');
  queueArtifactProjections(s, artifact, event, { refreshReadiness: input.refreshReadiness !== false });
  return { artifact, created: true, event };
}

export function createArtifact(s, input, { persist = true } = {}) {
  let outcome;
  if (persist) outcome = guardedWrite(s, () => insertArtifact(s, input));
  else outcome = insertArtifact(s, input);
  return { ...outcome.artifact, created: outcome.created };
}

function simpleLineDiff(before, after) {
  const left = normalizeArtifactContent(before).split('\n');
  const right = normalizeArtifactContent(after).split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return [
    ...left.slice(0, prefix).map(line => ` ${line}`),
    ...left.slice(prefix, left.length - suffix).map(line => `-${line}`),
    ...right.slice(prefix, right.length - suffix).map(line => `+${line}`),
    ...left.slice(left.length - suffix).map(line => ` ${line}`)
  ];
}

export function diffArtifact(s, artifactId, { againstArtifactId = null } = {}) {
  const artifact = getArtifact(s, artifactId);
  const againstId = againstArtifactId || artifact.supersedesArtifactId;
  const against = againstId ? getArtifact(s, againstId) : null;
  if (against && against.seriesKey !== artifact.seriesKey) {
    throw new ArtifactError('artifact_diff_series_mismatch', 'Artifact diffs must compare revisions from the same series.', { artifactId, againstArtifactId: against.id });
  }
  const lines = simpleLineDiff(against?.content || '', artifact.content);
  return {
    artifactId: artifact.id,
    againstArtifactId: against?.id || null,
    seriesKey: artifact.seriesKey,
    revision: artifact.revision,
    againstRevision: against?.revision || null,
    contentHash: artifact.contentHash,
    againstContentHash: against?.contentHash || null,
    lines,
    text: [`--- ${against ? `${against.id} (revision ${against.revision})` : '/dev/null'}`, `+++ ${artifact.id} (revision ${artifact.revision})`, ...lines].join('\n')
  };
}

function verifyReviewable(s, artifactId, decision) {
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`, { artifactId });
  const current = one(s, 'SELECT id,revision FROM artifacts WHERE series_key=? ORDER BY revision DESC LIMIT 1', [row.series_key]);
  if (current.id !== row.id) {
    throw new ArtifactError('artifact_not_current', `Artifact ${artifactId} is superseded by ${current.id}. Review the current revision instead.`, { artifactId, currentArtifactId: current.id });
  }
  const canonicalHash = artifactContentHash(row.content);
  if (canonicalHash !== row.content_hash) {
    throw new ArtifactError('artifact_content_hash_mismatch', `Artifact ${artifactId} no longer matches its canonical content hash.`, { artifactId, expectedHash: row.content_hash, actualHash: canonicalHash });
  }
  const mirror = path.join(s.p.ws, row.path);
  if (!fs.existsSync(mirror)) {
    throw new ArtifactError('artifact_mirror_missing', `Artifact mirror is missing for ${artifactId}; regenerate the draft before review.`, { artifactId, path: row.path });
  }
  const mirrorHash = artifactContentHash(fs.readFileSync(mirror, 'utf8'));
  if (mirrorHash !== row.content_hash) {
    throw new ArtifactError('artifact_mirror_diverged', `Artifact mirror diverged for ${artifactId}; restore or regenerate it before review.`, { artifactId, path: row.path, expectedHash: row.content_hash, actualHash: mirrorHash });
  }
  if (decision === 'approved' && row.type === 'resume') {
    const resumeDocument = one(s, 'SELECT * FROM artifact_resume_documents WHERE artifact_id=?', [artifactId]);
    if (!resumeDocument) throw new ArtifactError('resume_document_incomplete', `Resume ${artifactId} has no semantic document snapshot.`, { artifactId });
    const validation = parseJson(resumeDocument.validation_json, null);
    if (!validation?.valid) {
      const first = validation?.blockers?.[0];
      throw new ArtifactError(first?.code || 'resume_document_incomplete', first?.message || `Resume ${artifactId} did not pass semantic validation.`, { artifactId, blockers: validation?.blockers || [] });
    }
    const currentSource = one(s, 'SELECT id FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [row.profile_id]);
    if (!currentSource || currentSource.id !== resumeDocument.source_resume_revision_id) {
      throw new ArtifactError('resume_stale_source_revision', `Resume ${artifactId} was built from a stale canonical source revision.`, { artifactId, sourceResumeRevisionId: resumeDocument.source_resume_revision_id, currentResumeRevisionId: currentSource?.id || null });
    }
    const renderManifest = parseJson(resumeDocument.render_manifest_json, null);
    if (renderManifest?.format === 'pdf') {
      if (renderManifest.status !== 'passed') throw new ArtifactError('resume_render_failed', `Resume ${artifactId} did not pass requested PDF rendering.`, { artifactId, renderStatus: renderManifest.status });
      const pdfPath = path.join(s.p.ws, renderManifest.pdfPath || '');
      if (!renderManifest.pdfPath || !fs.existsSync(pdfPath)) throw new ArtifactError('resume_render_failed', `Rendered PDF is missing for ${artifactId}.`, { artifactId, pdfPath: renderManifest.pdfPath || null });
      const pdfHash = crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex');
      if (pdfHash !== renderManifest.pdfHash) throw new ArtifactError('resume_render_failed', `Rendered PDF hash diverged for ${artifactId}.`, { artifactId, expectedHash: renderManifest.pdfHash, actualHash: pdfHash });
    }
  }
  if (decision === 'approved' && row.approval_status === 'rejected') {
    throw new ArtifactError('artifact_rejected_requires_redraft', `Rejected artifact ${artifactId} requires a new draft before approval.`, { artifactId });
  }
  return row;
}

export function preflightResumeArtifact(s, artifactId) {
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`, { artifactId });
  if (row.type !== 'resume') throw new ArtifactError('artifact_type_invalid', `Artifact ${artifactId} is not a resume.`, { artifactId, type: row.type });
  const resumeDocument = one(s, 'SELECT * FROM artifact_resume_documents WHERE artifact_id=?', [artifactId]);
  if (!resumeDocument) throw new ArtifactError('resume_document_incomplete', `Resume ${artifactId} has no semantic document snapshot.`, { artifactId });
  const validation = parseJson(resumeDocument.validation_json, { valid: false, blockers: [{ code: 'resume_document_incomplete', message: 'Semantic validation is missing.' }], warnings: [] });
  const renderManifest = parseJson(resumeDocument.render_manifest_json, { format: 'markdown', status: 'not_requested', blockers: [], warnings: [] });
  const blockers = [...(validation.blockers || []), ...(renderManifest.blockers || [])];
  let approvalEligible = false;
  try {
    verifyReviewable(s, artifactId, 'approved');
    approvalEligible = true;
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    if (!blockers.some(item => item.code === error.code)) blockers.push({ code: error.code, message: error.message, ...error.details });
  }
  return {
    artifactId,
    revision: Number(row.revision),
    contentHash: row.content_hash,
    sourceResumeRevisionId: resumeDocument.source_resume_revision_id,
    approvalStatus: row.approval_status,
    approvalEligible,
    valid: validation.valid === true && approvalEligible,
    validation,
    renderManifest,
    blockers,
    warnings: [...(validation.warnings || []), ...(renderManifest.warnings || [])],
    externalSideEffects: 'none',
    submissionPerformed: false
  };
}

function reviewArtifactFeedbackInput(memoryFeedback, decision) {
  if (memoryFeedback == null) return null;
  return normalizeArtifactFeedbackInput(memoryFeedback, { decision });
}

function artifactSourceEntity(row, auditEvent) {
  return {
    type: 'artifact',
    id: row.id,
    versionId: auditEvent.id,
    revision: Number(row.revision),
    contentHash: row.content_hash,
  };
}

function recordArtifactReviewObservation(s, row, auditEvent, eventType, feedback, reviewedBy) {
  const decision = REVIEW_DECISION_BY_EVENT[eventType];
  const occurredAt = auditEvent.createdAt || auditEvent.created_at;
  const versionId = auditEvent.id;
  const observation = appendMemoryObservation(s, {
    profileId: row.profile_id,
    eventType,
    sourceSchema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
    sourceEntity: artifactSourceEntity(row, { id: versionId }),
    occurredAt: normalizeRfc3339(occurredAt, 'occurredAt'),
    actor: reviewedBy,
    source: reviewedBy,
    reasonCodes: feedback.reasonCodes,
    signals: feedback.signals,
    publicExplanation: feedback.publicExplanation,
    privateNote: feedback.privateNote,
    payload: { decision },
    referenceId: feedback.referenceId,
  });
  return observation;
}

function _reviewArtifact(s, artifactId, { decision, reviewedBy, note = '', memoryFeedback = null }) {
  if (!HUMAN_REVIEW_SOURCES.has(reviewedBy)) {
    throw new ArtifactError('human_review_required', 'Artifact approval and rejection require the trusted CLI or TUI human review flow.', { artifactId, reviewedBy: reviewedBy || null });
  }
  if (decision === 'rejected' && !String(note).trim()) {
    throw new ArtifactError('artifact_rejection_note_required', 'Rejecting an artifact requires a review note.', { artifactId });
  }
  const feedback = reviewArtifactFeedbackInput(memoryFeedback, FEEDBACK_DECISION_BY_REVIEW[decision]);
  // Pre-check: if feedback with this referenceId already produced an observation for this
  // profile+event, return idempotently without entering guardedWrite (avoids store_revision bump).
  if (feedback) {
    const profileId = one(s, 'SELECT profile_id FROM artifacts WHERE id=?', [artifactId])?.profile_id;
    const existing = one(s, `SELECT * FROM career_memory_observations
      WHERE profile_id=? AND reference_id=? AND event_type=?`, [
      profileId,
      feedback.referenceId,
      decision === 'approved' ? 'artifact_approved' : 'artifact_rejected',
    ]);
    if (existing) {
      // Verify the existing observation matches the current feedback; conflicting reuse fails.
      const existingReasons = JSON.parse(existing.reason_codes_json);
      const existingSignals = JSON.parse(existing.signal_json);
      const existingPublic = existing.public_explanation || '';
      if (JSON.stringify(existingReasons) !== JSON.stringify(feedback.reasonCodes)
        || JSON.stringify(existingSignals) !== JSON.stringify(feedback.signals)
        || existingPublic !== feedback.publicExplanation) {
        throw new ArtifactError('memory_reference_conflict', `Reference ${feedback.referenceId} already identifies different observation content.`, { referenceId: feedback.referenceId });
      }
      const reviewed = getArtifact(s, artifactId);
      return {
        ...reviewed,
        idempotent: true,
        externalSideEffects: 'none',
        submissionPerformed: false,
        applicationStatusChanged: false,
      };
    }
  }
  return guardedWrite(s, () => {
    const row = verifyReviewable(s, artifactId, decision);
    if (decision === 'approved' && row.approval_status === 'approved') {
      if (feedback) {
        const event = one(s, `SELECT * FROM audit_log WHERE action='artifact.approved' AND entity_type='artifact' AND entity_id=?
          ORDER BY created_at DESC,id DESC LIMIT 1`, [artifactId]);
        const observation = recordArtifactReviewObservation(s, row, event, 'artifact_approved', feedback, reviewedBy);
        if (observation.idempotent) {
          const memRow = one(s, "SELECT * FROM audit_log WHERE action='career_memory.observation_recorded' AND entity_type='career_memory_observation' AND entity_id=? ORDER BY rowid DESC LIMIT 1", [observation.id]);
          if (memRow) {
            const memEvent = { id: memRow.id, action: memRow.action, entityType: memRow.entity_type, entityId: memRow.entity_id, payload: JSON.parse(memRow.payload_json), externalSideEffect: memRow.external_side_effect, createdAt: memRow.created_at };
            queueMemorySync(s, row.profile_id, memEvent);
          }
        }
      }
      return {
        ...rowProjection(row, row.revision),
        idempotent: true,
        externalSideEffects: 'none',
        submissionPerformed: false,
        applicationStatusChanged: false
      };
    }
    if (row.approval_status !== 'draft_needs_human_review') {
      throw new ArtifactError('artifact_review_transition_invalid', `Artifact ${artifactId} cannot transition from ${row.approval_status} to ${decision}.`, { artifactId, from: row.approval_status, to: decision });
    }
    const reviewedAt = now();
    run(s, 'UPDATE artifacts SET approval_status=?,reviewed_at=?,reviewed_by=?,review_note=? WHERE id=?', [decision, reviewedAt, reviewedBy, String(note || ''), artifactId]);
    const payload = {
      jobId: row.job_id || null,
      profileId: row.profile_id || null,
      seriesKey: row.series_key,
      revision: Number(row.revision),
      contentHash: row.content_hash,
      approvalStatus: decision,
      reviewedBy,
      reviewNote: String(note || ''),
      submissionPerformed: false,
      applicationStatusChanged: false
    };
    const event = recordAudit(s, `artifact.${decision}`, 'artifact', artifactId, payload, 'none');
    if (feedback) {
      const eventType = decision === 'approved' ? 'artifact_approved' : 'artifact_rejected';
      const observation = recordArtifactReviewObservation(s, row, event, eventType, feedback, reviewedBy);
      if (!observation.idempotent) {
        const memEvent = recordAudit(s, 'career_memory.observation_recorded', 'career_memory_observation', observation.id, {
          profileId: observation.profileId,
          eventType: observation.eventType,
          sourceSchema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
          sourceEntity: observation.sourceEntity,
          reasonCodes: observation.reasonCodes,
          signals: observation.signals,
          publicExplanation: observation.publicExplanation,
          hasPrivateNote: observation.hasPrivateNote,
          referenceId: feedback.referenceId,
          observationHash: one(s, 'SELECT observation_hash FROM career_memory_observations WHERE id=?', [observation.id]).observation_hash,
        }, 'none');
        queueMemorySync(s, row.profile_id, memEvent);
      }
    }
    const reviewed = rowProjection(one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]), row.revision);
    queuePostCommit(s, () => projectAudit(s, event));
    if (reviewed.jobId && reviewed.profileId && ['resume', 'cover_letter'].includes(reviewed.type)) {
      queuePostCommit(s, () => planApplication(s, { jobId: reviewed.jobId, profileId: reviewed.profileId }));
    }
    return {
      ...reviewed,
      idempotent: false,
      externalSideEffects: 'none',
      submissionPerformed: false,
      applicationStatusChanged: false
    };
  });
}

export function approveArtifact(s, artifactId, { reviewedBy = 'cli', note = '', memoryFeedback = null } = {}) {
  return _reviewArtifact(s, artifactId, { decision: 'approved', reviewedBy, note, memoryFeedback });
}

export function rejectArtifact(s, artifactId, { reviewedBy = 'cli', note = '', memoryFeedback = null } = {}) {
  return _reviewArtifact(s, artifactId, { decision: 'rejected', reviewedBy, note, memoryFeedback });
}

// TUI artifact-review compatibility wrappers
export function reviewArtifact(s, { artifactId, approvalStatus, note = '', source }) {
  if (!source || !['tui', 'api', 'cli'].includes(source)) throw new ArtifactError('invalid_review_source', 'Invalid source: must be tui, api, or cli');
  if (!REVIEW_STATUSES.has(approvalStatus)) throw new ArtifactError('artifact_review_status_invalid', `Invalid artifact approval status: ${approvalStatus}`);
  if (approvalStatus === 'approved') return approveArtifact(s, artifactId, { reviewedBy: source, note });
  if (approvalStatus === 'rejected') return rejectArtifact(s, artifactId, { reviewedBy: source, note });
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`);
  run(s, 'UPDATE artifacts SET approval_status=?, reviewed_at=NULL, reviewed_by=NULL, review_note=? WHERE id=?', [approvalStatus, note, artifactId]);
  recordAudit(s, 'artifact.reviewed', 'artifact', artifactId, {
    jobId: row.job_id || null,
    profileId: row.profile_id || null,
    seriesKey: row.series_key,
    revision: Number(row.revision),
    contentHash: row.content_hash,
    approvalStatus,
    source,
    reviewedBy: source,
    note: String(note || ''),
    reviewNote: String(note || '')
  }, 'none');
  save(s);
  return rowProjection(one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]), row.revision);
}

function canonicalLineDiffHash(lines) {
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function recordArtifactEditObservation(s, baseRow, newArtifact, editEvent, feedback, source) {
  const diffLines = simpleLineDiff(baseRow.content, newArtifact.content);
  const added = diffLines.filter(line => line.startsWith('+')).length;
  const removed = diffLines.filter(line => line.startsWith('-')).length;
  const observation = appendMemoryObservation(s, {
    profileId: newArtifact.profileId,
    eventType: 'artifact_edited',
    sourceSchema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
    sourceEntity: {
      type: 'artifact',
      id: newArtifact.id,
      versionId: editEvent.id,
      revision: Number(newArtifact.revision),
      contentHash: newArtifact.contentHash,
    },
    occurredAt: normalizeRfc3339(editEvent.createdAt, 'occurredAt'),
    actor: source,
    source,
    reasonCodes: feedback.reasonCodes,
    signals: feedback.signals,
    publicExplanation: feedback.publicExplanation,
    privateNote: feedback.privateNote,
    payload: { decision: EDIT_DECISION },
    referenceId: feedback.referenceId,
  });
  return { observation, diffHash: canonicalLineDiffHash(diffLines), addedLines: added, removedLines: removed };
}

export function ingestEditedArtifact(s, { artifactId, content, source = 'tui', memoryFeedback = null }) {
  if (!['tui', 'api', 'cli'].includes(source)) throw new ArtifactError('invalid_edit_source', 'Invalid source: must be tui, api, or cli');
  const feedback = reviewArtifactFeedbackInput(memoryFeedback, EDIT_DECISION);
  const baseRow = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!baseRow) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`);
  const normalizedContent = normalizeArtifactContent(content);
  if (artifactContentHash(normalizedContent) === baseRow.content_hash) {
    throw new ArtifactError('artifact_same_content', `Edited content is identical to artifact ${artifactId}; no revision created.`, { artifactId });
  }
  // Exact edit replay: if feedback with this referenceId already produced an artifact_edited
  // observation for this profile, return the existing new revision idempotently.
  if (feedback) {
    const existing = one(s, `SELECT * FROM career_memory_observations
      WHERE profile_id=? AND reference_id=? AND event_type='artifact_edited'`, [baseRow.profile_id, feedback.referenceId]);
    if (existing) {
      const existingArtifact = getArtifact(s, existing.source_entity_id);
      if (existingArtifact.contentHash === artifactContentHash(normalizedContent)) {
        return existingArtifact;
      }
      throw new ArtifactError('memory_reference_conflict', `Reference ${feedback.referenceId} already identifies a different edit observation.`, { referenceId: feedback.referenceId });
    }
  }
  return guardedWrite(s, () => {
    const currentBase = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
    if (!currentBase) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`);
    if (feedback) {
      const existing = one(s, `SELECT * FROM career_memory_observations
        WHERE profile_id=? AND reference_id=? AND event_type='artifact_edited'`, [currentBase.profile_id, feedback.referenceId]);
      if (existing) {
        const existingArtifact = getArtifact(s, existing.source_entity_id);
        if (existingArtifact.contentHash === artifactContentHash(normalizedContent)) {
          return existingArtifact;
        }
        throw new ArtifactError('memory_reference_conflict', `Reference ${feedback.referenceId} already identifies a different edit observation.`, { referenceId: feedback.referenceId });
      }
    }
    const outcome = insertArtifact(s, {
      jobId: currentBase.job_id,
      profileId: currentBase.profile_id,
      type: currentBase.type,
      path: currentBase.path,
      title: currentBase.title,
      content,
      evidence: parseJson(currentBase.evidence_json, []),
      warnings: parseJson(currentBase.warnings_json, []),
      seriesKey: currentBase.series_key,
      auditAction: null,
    });
    const editEvent = recordAudit(s, 'artifact.edited', 'artifact', outcome.artifact.id, {
      jobId: currentBase.job_id || null,
      profileId: currentBase.profile_id || null,
      previousArtifactId: artifactId,
      artifactId: outcome.artifact.id,
      path: currentBase.path,
      source,
    }, 'none');
    if (feedback) {
      const { observation, diffHash, addedLines, removedLines } = recordArtifactEditObservation(s, currentBase, outcome.artifact, editEvent, feedback, source);
      // Store edit metadata in the audit payload (observation payload is decision-only by contract).
      run(s, 'UPDATE audit_log SET payload_json=? WHERE id=?', [JSON.stringify({
        jobId: currentBase.job_id || null,
        profileId: currentBase.profile_id || null,
        previousArtifactId: artifactId,
        artifactId: outcome.artifact.id,
        baseRevision: Number(currentBase.revision),
        newRevision: Number(outcome.artifact.revision),
        baseContentHash: currentBase.content_hash,
        newContentHash: outcome.artifact.contentHash,
        diffHash,
        addedLines,
        removedLines,
        path: currentBase.path,
        source,
      }), editEvent.id]);
      if (!observation.idempotent) {
        const memEvent = recordAudit(s, 'career_memory.observation_recorded', 'career_memory_observation', observation.id, {
          profileId: observation.profileId,
          eventType: observation.eventType,
          sourceSchema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
          sourceEntity: observation.sourceEntity,
          reasonCodes: observation.reasonCodes,
          signals: observation.signals,
          publicExplanation: observation.publicExplanation,
          hasPrivateNote: observation.hasPrivateNote,
          referenceId: feedback.referenceId,
          observationHash: one(s, 'SELECT observation_hash FROM career_memory_observations WHERE id=?', [observation.id]).observation_hash,
        }, 'none');
        queueMemorySync(s, currentBase.profile_id, memEvent);
      }
    }
    return outcome.artifact;
  });
}
