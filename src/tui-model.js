import { all, one } from './db.js';
import { discoveryHealth, listJobSummaries, reviewQueue, selectedJobContext } from './domain-tools.js';
import { parseJson } from './utils.js';
import { redactSensitive } from './acp.js';

const ACTIVE_APPLICATION_STATUSES = new Set(['interested', 'materials-ready', 'applied', 'interview', 'offer']);

function firstTask(s, jobId) {
  const row = one(s, "SELECT id,title,type,due_at,priority FROM tasks WHERE job_id=? AND status='open' ORDER BY due_at IS NULL,due_at,created_at LIMIT 1", [jobId]);
  return row ? { id: row.id, title: row.title, type: row.type, dueAt: row.due_at || null, priority: row.priority } : null;
}

function signals(s, jobId) {
  const artifacts = Number(one(s, 'SELECT COUNT(*) AS count FROM artifacts WHERE job_id=?', [jobId])?.count || 0);
  const proofIds = all(s, 'SELECT evidence_json FROM artifacts WHERE job_id=?', [jobId])
    .flatMap(row => parseJson(row.evidence_json, []))
    .map(value => typeof value === 'string' ? value : (value?.proofPointId || value?.id))
    .filter(Boolean);
  const path = one(s, 'SELECT path_strength FROM outreach_plans WHERE job_id=? ORDER BY recommended DESC,created_at DESC LIMIT 1', [jobId]);
  return { artifacts, proofs: new Set(proofIds).size, path: path?.path_strength || 'none' };
}

function stageState(s, context) {
  if (!context) return [];
  const jobId = context.job.id;
  const types = new Set(context.artifacts.map(item => item.type));
  const audits = new Set(all(s, 'SELECT action FROM audit_log WHERE entity_id=? ORDER BY created_at', [jobId]).map(row => row.action));
  const hasContacts = Boolean(one(s, `SELECT contact_points.id FROM contact_points
    LEFT JOIN person_candidates ON person_candidates.id=contact_points.person_id
    LEFT JOIN stakeholders ON stakeholders.id=contact_points.stakeholder_id
    WHERE person_candidates.job_id=? OR stakeholders.job_id=? LIMIT 1`, [jobId, jobId]));
  const application = context.job.applicationStatus;
  const done = value => value ? 'done' : 'empty';
  return [
    { name: 'score', state: done(Boolean(context.fit)) },
    { name: 'company', state: done([...audits].some(action => action.startsWith('research.company'))) },
    { name: 'contacts', state: done(hasContacts) },
    { name: 'network', state: done(Boolean(context.path)) },
    { name: 'answers', state: done(audits.has('application.questions.prepared')) },
    { name: 'resume', state: types.has('resume') ? 'draft' : 'empty' },
    { name: 'cover', state: types.has('cover') ? 'draft' : 'empty' },
    { name: 'application', state: application ? application : 'empty' },
    { name: 'outreach', state: types.has('outreach') ? 'draft' : 'empty' },
    { name: 'interview', state: types.has('interview_prep') ? 'draft' : 'empty' }
  ];
}

function priorityStrip(s, jobs, at) {
  const due = one(s, "SELECT tasks.title,tasks.due_at,jobs.id AS job_id,jobs.company FROM tasks LEFT JOIN jobs ON jobs.id=tasks.job_id WHERE tasks.status='open' AND tasks.due_at IS NOT NULL ORDER BY tasks.due_at LIMIT 1");
  const interview = one(s, "SELECT jobs.id AS job_id,jobs.company,tasks.title,tasks.due_at FROM applications JOIN jobs ON jobs.id=applications.job_id LEFT JOIN tasks ON tasks.application_id=applications.id AND tasks.status='open' WHERE applications.status='interview' ORDER BY tasks.due_at IS NULL,tasks.due_at LIMIT 1");
  const recentThreshold = new Date(new Date(at).getTime() - 7 * 86_400_000).toISOString();
  const newJobs = jobs.filter(job => ['new', 'imported'].includes(job.status) && String(job.updatedAt || '') >= recentThreshold);
  const failure = one(s, "SELECT trigger_name,error,created_at FROM automation_runs WHERE status='failed' ORDER BY created_at DESC LIMIT 1");
  return [
    {
      kind: 'due',
      jobId: due?.job_id || null,
      text: due ? `${due.title}${due.company ? ` · ${due.company}` : ''}${due.due_at ? ` · ${due.due_at.slice(0, 16)}` : ''}` : 'No due tasks'
    },
    {
      kind: 'interview',
      jobId: interview?.job_id || null,
      text: interview ? `${interview.title || 'Interview prep'} · ${interview.company}${interview.due_at ? ` · ${interview.due_at.slice(0, 16)}` : ''}` : 'No interviews scheduled'
    },
    {
      kind: 'new',
      jobId: newJobs[0]?.id || null,
      text: newJobs.length ? `${newJobs.length} new/imported · ${newJobs.filter(job => job.highFit).length} high-fit` : 'No new jobs this week'
    },
    {
      kind: 'failure',
      jobId: null,
      text: failure ? `${failure.trigger_name} · ${failure.error || 'failed'} · ${failure.created_at.slice(0, 16)}` : 'No recent source failures'
    }
  ];
}

function artifactDocs(s, jobId) {
  if (!jobId) return [];
  return all(s, 'SELECT id,type,path,title,content,approval_status,created_at FROM artifacts WHERE job_id=? ORDER BY created_at DESC', [jobId])
    .map(row => ({
      id: row.id,
      type: row.type,
      path: row.path,
      title: row.title,
      content: row.content,
      approvalStatus: row.approval_status,
      createdAt: row.created_at
    }));
}

export function buildTuiModel(s, { profileId = null, selectedJobId = null, at = new Date().toISOString() } = {}) {
  const profiles = all(s, 'SELECT id,name,created_at,updated_at FROM profiles ORDER BY created_at').map(row => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
  const selectedProfile = profileId && profiles.some(profile => profile.id === profileId)
    ? profileId
    : (profiles[0]?.id || null);
  const jobs = listJobSummaries(s, { profileId: selectedProfile }).map(job => ({
    ...job,
    stage: job.applicationStatus || job.status,
    next: firstTask(s, job.id),
    signals: signals(s, job.id)
  }));
  const selectedId = jobs.some(job => job.id === selectedJobId) ? selectedJobId : (jobs[0]?.id || null);
  const selected = selectedId ? selectedJobContext(s, selectedId) : null;
  const selectedRow = selectedId ? one(s, 'SELECT description,requirements_json,compensation,work_model FROM jobs WHERE id=?', [selectedId]) : null;
  const details = selected ? {
    ...selected,
    narrative: selected.fit?.reasoning || String(selectedRow?.description || '').replace(/\s+/g, ' ').slice(0, 280) || 'No description is stored for this job.',
    requirements: parseJson(selectedRow?.requirements_json, []).slice(0, 6),
    compensation: selectedRow?.compensation || '',
    workModel: selectedRow?.work_model || '',
    stages: stageState(s, selected),
    docs: artifactDocs(s, selectedId)
  } : null;
  const reviews = reviewQueue(s, { profileId: selectedProfile });
  const openJobs = jobs.filter(job => job.status !== 'archived' && (!job.applicationStatus || ACTIVE_APPLICATION_STATUSES.has(job.applicationStatus)));
  const dueCount = Number(one(s, "SELECT COUNT(*) AS count FROM tasks WHERE status='open' AND due_at IS NOT NULL AND due_at<=?", [at])?.count || 0);
  const interviewCount = jobs.filter(job => job.applicationStatus === 'interview').length;
  const logs = all(s, 'SELECT id,action,entity_type,entity_id,payload_json,external_side_effect,created_at FROM audit_log ORDER BY created_at DESC LIMIT 80')
    .map(row => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: redactSensitive(parseJson(row.payload_json, {})),
      externalSideEffect: row.external_side_effect,
      createdAt: row.created_at
    }));
  const answerCounts = selectedProfile ? {
    verified: Number(one(s, "SELECT COUNT(*) AS count FROM answers WHERE profile_id=? AND verification_status='verified' AND sensitivity<>'restricted'", [selectedProfile])?.count || 0),
    restricted: Number(one(s, "SELECT COUNT(*) AS count FROM answers WHERE profile_id=? AND sensitivity='restricted'", [selectedProfile])?.count || 0)
  } : { verified: 0, restricted: 0 };

  return {
    version: 1,
    generatedAt: at,
    workspace: s.root,
    profiles,
    profileId: selectedProfile,
    profile: profiles.find(profile => profile.id === selectedProfile) || null,
    counts: {
      open: openJobs.length,
      high: openJobs.filter(job => job.highFit).length,
      due: dueCount,
      drafts: reviews.length,
      interviews: interviewCount
    },
    priority: priorityStrip(s, jobs, at),
    jobs,
    selectedJobId: selectedId,
    selected: details,
    review: reviews,
    log: logs,
    answers: answerCounts,
    discovery: discoveryHealth(s, { profileId: selectedProfile }),
    policy: {
      sideEffects: 'off',
      autoApply: 'disabled',
      autoSend: 'disabled',
      drafts: 'draft_needs_human_review'
    },
    empty: {
      noProfile: profiles.length === 0,
      noJobs: profiles.length > 0 && jobs.length === 0
    }
  };
}
