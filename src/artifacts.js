import { one, run, save, audit } from './db.js';
import { id, now } from './utils.js';

export const artifactApprovalStatuses = new Set(['approved', 'rejected', 'draft_needs_human_review']);

function publicRow(row) {
  return { id: row.id, job_id: row.job_id, profile_id: row.profile_id, type: row.type, path: row.path, title: row.title, approval_status: row.approval_status, created_at: row.created_at };
}

export function reviewArtifact(s, { artifactId, approvalStatus, note = '', source }) {
  if (!source || !['tui', 'api'].includes(source)) throw Error('Invalid source: must be tui or api');
  if (!artifactApprovalStatuses.has(approvalStatus)) throw Error(`Invalid artifact approval status: ${approvalStatus}`);
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw Error(`Unknown artifact: ${artifactId}`);
  run(s, 'UPDATE artifacts SET approval_status=? WHERE id=?', [approvalStatus, artifactId]);
  audit(s, 'artifact.reviewed', 'artifact', artifactId, { jobId: row.job_id, approvalStatus, note, source }, 'none');
  save(s);
  return publicRow(one(s, 'SELECT id,job_id,profile_id,type,path,title,approval_status,created_at FROM artifacts WHERE id=?', [artifactId]));
}

export function ingestEditedArtifact(s, { artifactId, content, source = 'tui' }) {
  if (!['tui', 'api'].includes(source)) throw Error('Invalid source: must be tui or api');
  const row = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!row) throw Error(`Unknown artifact: ${artifactId}`);
  const at = now();
  const newId = id('artifact', `${row.job_id}:${row.path}:${at}`);
  run(s, 'INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [newId, row.job_id, row.profile_id, row.type, row.path, row.title, content, row.evidence_json, row.warnings_json, 'draft_needs_human_review', at]);
  audit(s, 'artifact.edited', 'artifact', newId, { jobId: row.job_id, previousArtifactId: artifactId, artifactId: newId, path: row.path, source }, 'none');
  save(s);
  return publicRow(one(s, 'SELECT id,job_id,profile_id,type,path,title,approval_status,created_at FROM artifacts WHERE id=?', [newId]));
}
