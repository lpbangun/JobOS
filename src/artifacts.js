import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, guardedWrite, one, projectAudit, queuePostCommit, recordAudit, run, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd } from './workspace.js';
import { planApplication } from './readiness.js';

const REVIEW_STATUSES = new Set(['draft_needs_human_review', 'approved', 'rejected']);
const HUMAN_REVIEW_SOURCES = new Set(['cli', 'tui']);

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
  if (decision === 'approved' && row.approval_status === 'rejected') {
    throw new ArtifactError('artifact_rejected_requires_redraft', `Rejected artifact ${artifactId} requires a new draft before approval.`, { artifactId });
  }
  return row;
}

function _reviewArtifact(s, artifactId, { decision, reviewedBy, note = '' }) {
  if (!HUMAN_REVIEW_SOURCES.has(reviewedBy)) {
    throw new ArtifactError('human_review_required', 'Artifact approval and rejection require the trusted CLI or TUI human review flow.', { artifactId, reviewedBy: reviewedBy || null });
  }
  if (decision === 'rejected' && !String(note).trim()) {
    throw new ArtifactError('artifact_rejection_note_required', 'Rejecting an artifact requires a review note.', { artifactId });
  }
  return guardedWrite(s, () => {
    const row = verifyReviewable(s, artifactId, decision);
    if (decision === 'approved' && row.approval_status === 'approved') {
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

export function approveArtifact(s, artifactId, { reviewedBy = 'cli', note = '' } = {}) {
  return _reviewArtifact(s, artifactId, { decision: 'approved', reviewedBy, note });
}

export function rejectArtifact(s, artifactId, { reviewedBy = 'cli', note = '' } = {}) {
  return _reviewArtifact(s, artifactId, { decision: 'rejected', reviewedBy, note });
}

// TUI artifact-review compatibility wrappers
export function reviewArtifact(s, { artifactId, approvalStatus, note = '', source }) {
  if (!source || !['tui', 'api', 'cli'].includes(source)) throw new ArtifactError('invalid_review_source', 'Invalid source: must be tui, api, or cli');
  if (!REVIEW_STATUSES.has(approvalStatus)) throw new ArtifactError('artifact_review_status_invalid', `Invalid artifact approval status: ${approvalStatus}`);
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`);
  const reviewedAt = now();
  if (approvalStatus === 'draft_needs_human_review') {
    run(s, 'UPDATE artifacts SET approval_status=?, reviewed_at=NULL, reviewed_by=NULL, review_note=? WHERE id=?', [approvalStatus, note, artifactId]);
  } else {
    run(s, 'UPDATE artifacts SET approval_status=?, reviewed_at=?, reviewed_by=?, review_note=? WHERE id=?', [approvalStatus, reviewedAt, source, note, artifactId]);
  }
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

export function ingestEditedArtifact(s, { artifactId, content, source = 'tui' }) {
  if (!['tui', 'api', 'cli'].includes(source)) throw new ArtifactError('invalid_edit_source', 'Invalid source: must be tui, api, or cli');
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw new ArtifactError('unknown_artifact', `Unknown artifact: ${artifactId}`);
  const result = createArtifact(s, {
    jobId: row.job_id,
    profileId: row.profile_id,
    type: row.type,
    path: row.path,
    title: row.title,
    content,
    evidence: parseJson(row.evidence_json, []),
    warnings: parseJson(row.warnings_json, []),
    seriesKey: row.series_key,
    auditAction: null
  });
  recordAudit(s, 'artifact.edited', 'artifact', result.id, {
    jobId: row.job_id || null,
    profileId: row.profile_id || null,
    previousArtifactId: artifactId,
    artifactId: result.id,
    path: row.path,
    source
  }, 'none');
  return result;
}
