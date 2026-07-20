import { one, all, run, save, guardedWrite, queuePostCommit, recordAudit, projectAudit, audit } from './db.js';
import { id, now, validStatuses } from './utils.js';
import { syncJob } from './jobs.js';

export function applicationId(jobId, profileId) {
  return id('app', `${jobId}:${profileId}`);
}

function recordStatusChange(s, { applicationId, jobId, profileId, fromStatus, toStatus, note, at }) {
  const sid = id('status', `${applicationId}:${fromStatus || 'new'}:${toStatus}:${at}`);
  run(s, 'INSERT INTO status_changes VALUES (?,?,?,?,?,?,?,?)',
    [sid, applicationId, jobId, profileId, fromStatus || null, toStatus, note || '', at]);
}

// ---------------------------------------------------------------------------
// Internal application mutation primitive — DB writes only.
// No save(), no syncJob(), no audit projection/queuing.
// Use inside a guardedWrite mutate callback.
// Returns { application, auditEvents }
// ---------------------------------------------------------------------------
export function _writeApp(s, jobId, profileId, status, notes = '', { receiptBound = false, skipIfExists = false } = {}) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const at = now();
  const aid = applicationId(jobId, profileId);
  const auditEvents = [];

  const ex = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);

  if (skipIfExists && ex) {
    return { application: ex, auditEvents: [] };
  }

  if (ex) {
    if (ex.status !== status) {
      recordStatusChange(s, {
        applicationId: aid, jobId, profileId,
        fromStatus: ex.status, toStatus: status,
        note: notes || ex.notes, at
      });
    }
    run(s, 'UPDATE applications SET status=?, notes=?, updated_at=? WHERE id=?',
      [status, notes || ex.notes, at, aid]);
    const evt = recordAudit(s, 'application.status_changed', 'application', aid, {
      jobId, profileId, status, receiptBound
    });
    auditEvents.push(evt);
  } else {
    run(s, 'INSERT INTO applications VALUES (?,?,?,?,?,?,?,?)',
      [aid, jobId, profileId, status, notes, '', at, at]);
    recordStatusChange(s, {
      applicationId: aid, jobId, profileId,
      fromStatus: null, toStatus: status, note: notes, at
    });
    const evt = recordAudit(s, 'application.created', 'application', aid, {
      jobId, profileId, status, receiptBound
    });
    auditEvents.push(evt);
  }

  const tid = id('task', `${aid}:review-next-action`);
  run(s, 'INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [tid, jobId, aid,
     `Review next action for ${job.title}`,
     'Human-gated review before external application, outreach, or status-sensitive action.',
     'review', at, 'normal', 'open', 'system', at, at]);

  return { application: one(s, 'SELECT * FROM applications WHERE id=?', [aid]), auditEvents };
}

// ---------------------------------------------------------------------------
// Public appCreate — guardedWrite wrapper with post-commit projections
// ---------------------------------------------------------------------------
export function appCreate(s, jid, status, notes = '') {
  return guardedWrite(s, () => {
    const { application, auditEvents } = _writeApp(s, jid, one(s, 'SELECT * FROM jobs WHERE id=?', [jid]).profile_id, status, notes, { receiptBound: false });
    queuePostCommit(s, () => {
      for (const evt of auditEvents) {
        if (evt) projectAudit(s, evt);
      }
      syncJob(s, jid);
    });
    return application;
  });
}

// ---------------------------------------------------------------------------
// Public appUpdate — guardedWrite wrapper with post-commit projections
// ---------------------------------------------------------------------------
export function appUpdate(s, aid, status, notes = null) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const app = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  if (!app) throw Error(`Unknown application: ${aid}`);

  return guardedWrite(s, () => {
    const { application, auditEvents } = _writeApp(s, app.job_id, app.profile_id, status, notes ?? app.notes, { receiptBound: false });
    queuePostCommit(s, () => {
      for (const evt of auditEvents) {
        if (evt) projectAudit(s, evt);
      }
      syncJob(s, app.job_id);
    });
    return application;
  });
}

export function due(s) {
  return all(s, 'SELECT * FROM tasks WHERE status="open" ORDER BY due_at IS NULL,due_at,created_at');
}
