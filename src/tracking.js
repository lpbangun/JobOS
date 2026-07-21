import { one, all, run, save, audit } from './db.js';
import { id, now, validStatuses } from './utils.js';
import { syncJob } from './jobs.js';
export const stageOrder = Array.from(validStatuses);

function recordStatusChange(s, { applicationId, jobId, profileId, fromStatus, toStatus, note, at }) {
  const sid = id('status', `${applicationId}:${fromStatus || 'new'}:${toStatus}:${at}`);
  run(s, 'INSERT INTO status_changes VALUES (?,?,?,?,?,?,?,?)', [sid, applicationId, jobId, profileId, fromStatus || null, toStatus, note || '', at]);
}

export function appCreate(s, jid, status, notes = '', { persist = true } = {}) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const at = now(), aid = id('app', `${jid}:${job.profile_id}`), ex = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  if (ex) {
    if (ex.status !== status) {
      recordStatusChange(s, { applicationId: aid, jobId: jid, profileId: job.profile_id, fromStatus: ex.status, toStatus: status, note: notes || '', at });
      run(s, 'UPDATE applications SET status=?, notes=?, updated_at=? WHERE id=?', [status, notes || ex.notes, at, aid]);
      const tid = id('task', `${aid}:review-next-action`);
      run(s, 'INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [tid, jid, aid, `Review next action for ${job.title}`, 'Human-gated review before external application, outreach, or status-sensitive action.', 'review', at, 'normal', 'open', 'system', at, at]);
      audit(s, 'application.status_changed', 'application', aid, { jobId: jid, profileId: job.profile_id, status, fromStatus: ex.status, toStatus: status, receiptBound: false }, 'none');
      syncJob(s, jid);
      if (persist) save(s);
    } else if (notes) {
      run(s, 'UPDATE applications SET notes=?, updated_at=? WHERE id=?', [notes, at, aid]);
      audit(s, 'application.notes_updated', 'application', aid, { jobId: jid, profileId: job.profile_id, status, notes }, 'none');
      if (persist) save(s);
    }
    return one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  }
  run(s, 'INSERT INTO applications VALUES (?,?,?,?,?,?,?,?)', [aid, jid, job.profile_id, status, notes, '', at, at]);
  recordStatusChange(s, { applicationId: aid, jobId: jid, profileId: job.profile_id, fromStatus: null, toStatus: status, note: notes, at });
  const tid = id('task', `${aid}:review-next-action`);
  run(s, 'INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [tid, jid, aid, `Review next action for ${job.title}`, 'Human-gated review before external application, outreach, or status-sensitive action.', 'review', at, 'normal', 'open', 'system', at, at]);
  audit(s, 'application.created', 'application', aid, { jobId: jid, profileId: job.profile_id, status, toStatus: status }, 'none');
  syncJob(s, jid);
  if (persist) save(s);
  return one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
}

export function appUpdate(s, aid, status, notes = null, { persist = true } = {}) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const app = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  if (!app) throw Error(`Unknown application: ${aid}`);
  const at = now();
  if (app.status !== status) {
    const noteOmitted = notes === null;
    recordStatusChange(s, { applicationId: aid, jobId: app.job_id, profileId: app.profile_id, fromStatus: app.status, toStatus: status, note: noteOmitted ? '' : (notes || ''), at });
    run(s, 'UPDATE applications SET status=?, notes=?, updated_at=? WHERE id=?', [status, noteOmitted ? app.notes : notes, at, aid]);
    audit(s, 'application.status_changed', 'application', aid, { jobId: app.job_id, profileId: app.profile_id, status, fromStatus: app.status, toStatus: status, receiptBound: false }, 'none');
    syncJob(s, app.job_id);
    if (persist) save(s);
  } else if (notes !== null) {
    run(s, 'UPDATE applications SET notes=?, updated_at=? WHERE id=?', [notes, at, aid]);
    audit(s, 'application.notes_updated', 'application', aid, { jobId: app.job_id, profileId: app.profile_id, status, notes }, 'none');
    if (persist) save(s);
  }
  return one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
}

export function due(s) { return all(s, 'SELECT * FROM tasks WHERE status="open" ORDER BY due_at IS NULL,due_at,created_at'); }

export function applicationId(jobId, profileId) { return id('app', `${jobId}:${profileId}`); }

export function _writeApp(s, jobId, profileId, status, notes = '', { receiptBound = false, skipIfExists = false, persist = true } = {}) {
  const appId = applicationId(jobId, profileId);
  if (skipIfExists && one(s, 'SELECT * FROM applications WHERE id=?', [appId])) return one(s, 'SELECT * FROM applications WHERE id=?', [appId]);
  return appCreate(s, jobId, status, notes, { persist });
}
