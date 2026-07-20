import { all, one } from './db.js';
import { discoveryHealth, listJobSummaries, reviewQueue, selectedJobContext } from './domain-tools.js';
import { reviewQueue as discoveryReviewQueue } from './discovery.js';
import { parseJson } from './utils.js';
import { redactSensitive } from './acp.js';
import { compileApplicationReadiness } from './readiness.js';

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
  const currentArtifacts = new Map();
  for (const artifact of context.artifacts) {
    const key = artifact.seriesKey || artifact.series_key || `${artifact.type}:${artifact.path}`;
    const prior = currentArtifacts.get(key);
    if (!prior || Number(artifact.revision || 0) > Number(prior.revision || 0)) currentArtifacts.set(key, artifact);
  }
  const types = new Map();
  for (const artifact of currentArtifacts.values()) {
    const prior = types.get(artifact.type);
    if (!prior || Number(artifact.revision || 0) > Number(prior.revision || 0)) types.set(artifact.type, artifact);
  }
  const audits = new Set(all(s, 'SELECT action FROM audit_log WHERE entity_id=? ORDER BY created_at', [jobId]).map(row => row.action));
  const hasContacts = Boolean(one(s, `SELECT contact_points.id FROM contact_points
    LEFT JOIN person_candidates ON person_candidates.id=contact_points.person_id
    LEFT JOIN stakeholders ON stakeholders.id=contact_points.stakeholder_id
    WHERE person_candidates.job_id=? OR stakeholders.job_id=? LIMIT 1`, [jobId, jobId]));
  const application = context.job.applicationStatus;
  const done = value => value ? 'done' : 'empty';
  const material = type => {
    const artifact = types.get(type);
    return artifact ? artifact.approvalStatus || 'draft_needs_human_review' : 'empty';
  };
  return [
    { name: 'score', state: done(Boolean(context.fit)) },
    { name: 'company', state: done([...audits].some(action => action.startsWith('research.company'))) },
    { name: 'contacts', state: done(hasContacts) },
    { name: 'network', state: done(Boolean(context.path)) },
    { name: 'answers', state: done(audits.has('application.questions.prepared')) },
    { name: 'resume', state: material('resume') },
    { name: 'cover', state: material('cover_letter') },
    { name: 'application', state: application ? application : 'empty' },
    { name: 'outreach', state: material('outreach') },
    { name: 'interview', state: material('interview_prep') }
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

export function artifactDocs(s, jobId) {
  if (!jobId) return [];
  const rows = all(s, `SELECT id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at
    FROM artifacts WHERE job_id=? ORDER BY created_at DESC,id DESC`, [jobId]);
  const proofIds = [...new Set(rows.flatMap(row => parseJson(row.evidence_json, []))
    .map(value => typeof value === 'string' ? value : (value?.proofPointId || value?.id))
    .filter(Boolean))];
  const proofs = proofIds.length
    ? all(s, `SELECT id,summary,evidence,skills_json,metrics_json,source FROM proof_points WHERE id IN (${proofIds.map(() => '?').join(',')})`, proofIds)
    : [];
  const proofById = new Map(proofs.map(row => [row.id, row]));
  const resolveEvidence = value => {
    const proofPointId = typeof value === 'string' ? value : (value?.proofPointId || value?.id);
    if (!proofPointId) return value;
    const proof = proofById.get(proofPointId);
    if (!proof) return { ...(typeof value === 'object' && value ? value : {}), proofPointId, missing: true };
    return {
      ...(typeof value === 'object' && value ? value : {}),
      proofPointId,
      summary: proof.summary,
      evidence: proof.evidence,
      skills: parseJson(proof.skills_json, []),
      metrics: parseJson(proof.metrics_json, []),
      source: proof.source
    };
  };
  return rows.map(row => {
    const previous = rows.find(candidate =>
      candidate.profile_id === row.profile_id &&
      candidate.path === row.path &&
      (candidate.created_at < row.created_at || (candidate.created_at === row.created_at && candidate.id < row.id)));
    return {
      id: row.id,
      jobId: row.job_id,
      profileId: row.profile_id,
      type: row.type,
      path: row.path,
      title: row.title,
      content: row.content,
      evidence: parseJson(row.evidence_json, []).map(resolveEvidence),
      warnings: parseJson(row.warnings_json, []).map(String),
      approvalStatus: row.approval_status,
      createdAt: row.created_at,
      previousDraft: previous ? {
        id: previous.id,
        title: previous.title,
        path: previous.path,
        content: previous.content,
        approvalStatus: previous.approval_status,
        createdAt: previous.created_at
      } : null
    };
  });
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
  const readiness = selected?.job.profileId
    ? compileApplicationReadiness(s, { jobId: selectedId, profileId: selected.job.profileId })
    : null;
  const details = selected ? {
    ...selected,
    narrative: selected.fit?.reasoning || String(selectedRow?.description || '').replace(/\s+/g, ' ').slice(0, 280) || 'No description is stored for this job.',
    requirements: parseJson(selectedRow?.requirements_json, []).slice(0, 6),
    compensation: selectedRow?.compensation || '',
    workModel: selectedRow?.work_model || '',
    stages: stageState(s, selected),
    docs: artifactDocs(s, selectedId),
    readiness: redactSensitive(readiness || selected.readiness || {}),
    policy: redactSensitive({ ...(selected.policy || {}), ...(readiness?.policy || {}) })
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
    version: 2,
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
    discovery: {
      ...discoveryHealth(s, { profileId: selectedProfile }),
      queue: discoveryReviewQueue(s)
        .filter(row => !selectedProfile || row.profile_id === selectedProfile)
        .map(row => ({
          id: row.id,
          profileId: row.profile_id,
          title: row.title,
          company: row.company,
          location: row.location || '',
          source: row.source,
          status: row.status,
          fitScore: row.fit_score == null ? null : Number(row.fit_score),
          highFit: Boolean(row.high_fit),
          createdAt: row.created_at
        }))
    },
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
