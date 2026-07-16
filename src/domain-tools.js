import { score } from './scoring.js';
import { tailor } from './tailoring.js';
import { research } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan, discoverContacts } from './research/contacts.js';
import { mapReachableNetwork } from './research/network.js';
import { appCreate, appUpdate, due } from './tracking.js';
import { weekly } from './analytics.js';
import { prepInterview } from './interview.js';
import { importUrl, listJobs } from './jobs.js';
import { listSearches, runSavedSearch } from './discovery.js';
import { listAutomations } from './scheduler/store.js';
import { recentRuns, runAutomationByName } from './scheduler/core.js';
import { matchAnswers } from './answers.js';
import { runDaily, runPursuit } from './workflows.js';
import { all, one } from './db.js';
import { parseJson } from './utils.js';

export class DomainToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainToolError';
    this.type = 'domain_tool_error';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { type: this.type, code: this.code, message: this.message, details: this.details };
  }
}

const object = properties => ({ type: 'object', properties });
const required = (properties, names) => ({ ...object(properties), required: names });
const text = { type: 'string' };

export const DOMAIN_TOOLS = Object.freeze([
  { name: 'list_jobs', description: 'List local JobOS jobs and their current fit and application state.', inputSchema: object({ profileId: text, status: text }) },
  { name: 'get_job_context', description: 'Read the secret-safe, evidence-grounded context packet for one selected job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'review_queue', description: 'List local draft artifacts awaiting human review.', inputSchema: object({ profileId: text }) },
  { name: 'discovery_health', description: 'Inspect saved discovery sources and recent isolated run failures.', inputSchema: object({ profileId: text }) },
  { name: 'score_job', description: 'Score a job against a profile.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'tailor_resume', description: 'Create an evidence-grounded tailored resume draft.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'draft_cover_letter', description: 'Create an evidence-grounded cover letter draft.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'research_company', description: 'Create a source-backed company dossier for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'discover_contacts', description: 'Discover source-backed contact points and email patterns for a job or stakeholder without sending outreach.', inputSchema: object({ jobId: text, stakeholderId: text }) },
  { name: 'approve_contact', description: 'Mark a discovered contact point as human-approved for later draft use.', inputSchema: required({ contactId: text }, ['contactId']) },
  { name: 'plan_outreach', description: 'Rank a reviewable outreach path from discovered contacts and user-owned network evidence.', inputSchema: required({ jobId: text, profileId: text, stakeholderId: text, goal: text }, ['jobId', 'profileId']) },
  { name: 'map_reachable_network', description: 'Create a local reachable-network path ladder for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'draft_outreach', description: 'Draft human-reviewed outreach for a stakeholder; never send it.', inputSchema: required({ jobId: text, stakeholderId: text, profileId: text, goal: text, planId: text, contactId: text }, ['profileId']) },
  { name: 'mark_outreach_sent', description: 'Record a user-confirmed outreach send; agent mediation is denied unless explicitly enabled.', inputSchema: required({ artifactId: text, channel: { type: 'string', enum: ['email', 'linkedin', 'other'] }, notes: text }, ['artifactId', 'channel']) },
  { name: 'schedule_outreach_followup', description: 'Create a local follow-up task for an outreach thread.', inputSchema: required({ threadId: text, afterDays: { type: 'number' } }, ['threadId', 'afterDays']) },
  { name: 'list_outreach_due', description: 'List due outreach follow-up tasks without sending anything.', inputSchema: object({}) },
  { name: 'create_application', description: 'Create a local application tracking record; agent mediation cannot attest submission by default.', inputSchema: required({ jobId: text, status: text, notes: text }, ['jobId', 'status']) },
  { name: 'update_application_status', description: 'Update a local application status; agent mediation cannot attest submission by default.', inputSchema: required({ applicationId: text, status: text, notes: text }, ['applicationId', 'status']) },
  { name: 'list_tasks', description: 'List open tasks ordered by due date.', inputSchema: object({}) },
  { name: 'interview_prep', description: 'Create an evidence-grounded interview prep packet for an application and stage.', inputSchema: required({ applicationId: text, stage: text }, ['applicationId']) },
  { name: 'weekly_review', description: 'Generate a local weekly review and funnel insights.', inputSchema: required({ profileId: text }, ['profileId']) },
  { name: 'list_saved_searches', description: 'List configured local discovery searches.', inputSchema: object({}) },
  { name: 'search_jobs', description: 'Run a saved discovery search and queue results for human review.', inputSchema: required({ search: text }, ['search']) },
  { name: 'import_job_url', description: 'Import a human-provided job URL into local JobOS state.', inputSchema: required({ profileId: text, url: text }, ['profileId', 'url']) },
  { name: 'list_automations', description: 'List configured local automations and schedules.', inputSchema: object({}) },
  { name: 'run_automation', description: 'Run a user-configured automation through the audited scheduler path.', inputSchema: required({ name: text }, ['name']) },
  { name: 'list_automation_runs', description: 'List recent automation runs.', inputSchema: object({ limit: { type: 'number' } }) },
  { name: 'daily_discovery', description: 'Run every saved discovery source for one profile and return ranked results plus isolated failures.', inputSchema: required({ profileId: text }, ['profileId']) },
  { name: 'pursue_job', description: 'Run the integrated fit, research, network, answers, artifact, application, and outreach-preparation workflow.', inputSchema: required({ jobId: text, profileId: text, stage: text, dryRun: { type: 'boolean' }, stageTimeoutMs: { type: 'number' } }, ['jobId', 'profileId']) },
  { name: 'answers_match', description: 'Match verified non-sensitive local answers to application questions.', inputSchema: required({ profileId: text, employer: text, questions: { type: 'array', items: { type: ['string', 'object'] } } }, ['profileId', 'questions']) }
]);

const EFFECT_ATTESTATION_STATUSES = new Set(['applied', 'submitted', 'sent']);

function mediationSource(options) {
  return String(options.source || process.env.JOBOS_MEDIATION || 'domain');
}

function allowAgentAttestation(options) {
  if (options.allowExternalAttestation === true) return true;
  return process.env.JOBOS_ALLOW_AGENT_ATTESTATION === '1';
}

function enforcePolicy(name, args, options) {
  const source = mediationSource(options);
  if (!['acp', 'mcp'].includes(source) || allowAgentAttestation(options)) return;
  const status = String(args.status || '').trim().toLowerCase();
  const denied = name === 'approve_contact'
    || name === 'mark_outreach_sent'
    || ((name === 'create_application' || name === 'update_application_status') && EFFECT_ATTESTATION_STATUSES.has(status));
  if (!denied) return;
  throw new DomainToolError(
    'agent_human_confirmation_denied',
    'Agent mediation cannot approve contacts or attest apply/send actions by default. Complete the human confirmation manually or explicitly enable JOBOS_ALLOW_AGENT_ATTESTATION=1.',
    { tool: name, source, status: status || null, externalSideEffect: 'none' }
  );
}

function publicJob(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    company: row.company,
    location: row.location || '',
    source: row.source,
    status: row.status,
    fitScore: row.fit_score == null ? null : Number(row.fit_score),
    highFit: Boolean(row.high_fit),
    scoringMode: parseJson(row.score_json, {})?.mode || null,
    applicationStatus: row.application_status || null,
    url: String(row.url || '').startsWith('jobos:text:') ? '' : (row.url || ''),
    updatedAt: row.updated_at
  };
}

export function listJobSummaries(s, { profileId = null, status = null } = {}) {
  return listJobs(s)
    .filter(row => !profileId || row.profile_id === profileId)
    .filter(row => !status || row.application_status === status || row.status === status)
    .map(publicJob);
}

export function reviewQueue(s, { profileId = null } = {}) {
  const params = [];
  const where = ["artifacts.approval_status='draft_needs_human_review'"];
  if (profileId) {
    where.push('artifacts.profile_id=?');
    params.push(profileId);
  }
  return all(s, `SELECT artifacts.id,artifacts.job_id,artifacts.profile_id,artifacts.type,artifacts.path,artifacts.title,artifacts.approval_status,artifacts.created_at,jobs.title AS job_title,jobs.company
    FROM artifacts LEFT JOIN jobs ON jobs.id=artifacts.job_id WHERE ${where.join(' AND ')} ORDER BY artifacts.created_at DESC`, params)
    .map(row => ({
      id: row.id,
      jobId: row.job_id || null,
      profileId: row.profile_id || null,
      type: row.type,
      path: row.path,
      title: row.title,
      approvalStatus: row.approval_status,
      jobTitle: row.job_title || '',
      company: row.company || '',
      createdAt: row.created_at
    }));
}

export function discoveryHealth(s, { profileId = null } = {}) {
  const searches = listSearches(s).filter(item => !profileId || item.profileId === profileId || item.profile_id === profileId);
  const runs = recentRuns(s, 20)
    .filter(item => !profileId || item.inputs?.profileId === profileId)
    .map(item => ({
      id: item.id,
      actionId: item.actionId,
      status: item.status,
      error: item.error || null,
      counts: item.counts || {},
      startedAt: item.startedAt,
      finishedAt: item.finishedAt
    }));
  return { searches, runs, browser: 'optional', externalSideEffects: 'off_by_default' };
}

export function selectedJobContext(s, jobId) {
  const job = one(s, `SELECT jobs.*,applications.id AS application_id,applications.status AS application_status
    FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id WHERE jobs.id=?`, [jobId]);
  if (!job) throw new DomainToolError('unknown_job', `Unknown job: ${jobId}`, { jobId });
  const scoreData = parseJson(job.score_json, {});
  const tasks = all(s, "SELECT id,title,type,due_at,priority,status FROM tasks WHERE job_id=? AND status='open' ORDER BY due_at IS NULL,due_at,created_at LIMIT 8", [jobId])
    .map(row => ({ id: row.id, title: row.title, type: row.type, dueAt: row.due_at || null, priority: row.priority }));
  const artifacts = all(s, 'SELECT id,type,path,title,evidence_json,warnings_json,approval_status,created_at FROM artifacts WHERE job_id=? ORDER BY created_at DESC', [jobId])
    .map(row => ({
      id: row.id,
      type: row.type,
      path: row.path,
      title: row.title,
      proofIds: parseJson(row.evidence_json, []).map(value => typeof value === 'string' ? value : (value?.proofPointId || value?.id)).filter(Boolean),
      warnings: parseJson(row.warnings_json, []).map(String),
      approvalStatus: row.approval_status,
      createdAt: row.created_at
    }));
  const proofIds = [...new Set(artifacts.flatMap(item => item.proofIds))];
  const proofs = proofIds.length
    ? all(s, `SELECT id,summary,evidence,source FROM proof_points WHERE id IN (${proofIds.map(() => '?').join(',')})`, proofIds)
      .map(row => ({ id: row.id, summary: row.summary, evidence: row.evidence, source: row.source }))
    : [];
  const path = one(s, 'SELECT id,path_strength,channel,reasoning_json,warnings_json,created_at FROM outreach_plans WHERE job_id=? ORDER BY recommended DESC,created_at DESC LIMIT 1', [jobId]);
  return {
    version: 1,
    job: {
      id: job.id,
      profileId: job.profile_id,
      title: job.title,
      company: job.company,
      location: job.location || '',
      source: job.source,
      status: job.status,
      applicationId: job.application_id || null,
      applicationStatus: job.application_status || null
    },
    fit: job.fit_score == null ? null : {
      overall: Number(job.fit_score),
      highFit: Boolean(job.high_fit),
      mode: scoreData.mode || 'unknown',
      confidence: scoreData.confidence || null,
      reasoning: scoreData.reasoning || ''
    },
    next: tasks,
    proofs,
    path: path ? {
      id: path.id,
      strength: path.path_strength,
      channel: path.channel,
      reasoning: parseJson(path.reasoning_json, {}),
      warnings: parseJson(path.warnings_json, [])
    } : null,
    artifacts,
    policy: {
      drafts: 'draft_needs_human_review',
      externalApply: 'user_configured_default_off',
      externalSend: 'user_configured_default_off'
    }
  };
}

export async function callDomainTool(s, name, args = {}, options = {}) {
  const tool = DOMAIN_TOOLS.find(item => item.name === name);
  if (!tool) throw new DomainToolError('unknown_domain_tool', `Unknown JobOS domain tool: ${name}`, { name });
  enforcePolicy(name, args, options);

  if (name === 'list_jobs') return listJobSummaries(s, args);
  if (name === 'get_job_context') return selectedJobContext(s, args.jobId);
  if (name === 'review_queue') return reviewQueue(s, args);
  if (name === 'discovery_health') return discoveryHealth(s, args);
  if (name === 'score_job') return await score(s, args.jobId, args.profileId);
  if (name === 'tailor_resume') return await tailor(s, args.jobId, args.profileId, 'resume');
  if (name === 'draft_cover_letter') return await tailor(s, args.jobId, args.profileId, 'cover');
  if (name === 'research_company') return await research(s, args.jobId, 'company');
  if (name === 'discover_contacts') return await discoverContacts(s, { jobId: args.jobId || null, stakeholderId: args.stakeholderId || null });
  if (name === 'approve_contact') return approveContact(s, { contactId: args.contactId });
  if (name === 'plan_outreach') return createOutreachPlan(s, { jobId: args.jobId, profileId: args.profileId, stakeholderId: args.stakeholderId || null, goal: args.goal || 'informational' });
  if (name === 'map_reachable_network') return mapReachableNetwork(s, { jobId: args.jobId });
  if (name === 'draft_outreach') return await draftOutreach(s, { jobId: args.jobId || null, stakeholderId: args.stakeholderId || null, profileId: args.profileId, goal: args.goal || 'informational', planId: args.planId || null, contactId: args.contactId || null });
  if (name === 'mark_outreach_sent') return markOutreachSent(s, { artifactId: args.artifactId, channel: args.channel, notes: args.notes || '' });
  if (name === 'schedule_outreach_followup') return scheduleFollowup(s, { threadId: args.threadId, afterDays: args.afterDays });
  if (name === 'list_outreach_due') return outreachDue(s);
  if (name === 'create_application') return appCreate(s, args.jobId, args.status, args.notes || '');
  if (name === 'update_application_status') return appUpdate(s, args.applicationId, args.status, args.notes ?? null);
  if (name === 'list_tasks') return due(s);
  if (name === 'interview_prep') return await prepInterview(s, args.applicationId, args.stage || 'interview');
  if (name === 'weekly_review') {
    const result = weekly(s, args.profileId);
    return { runId: result.runId, path: result.path, metrics: result.metrics };
  }
  if (name === 'list_saved_searches') return listSearches(s);
  if (name === 'search_jobs') return await runSavedSearch(s, args.search);
  if (name === 'import_job_url') return await importUrl(s, { profileId: args.profileId, url: args.url });
  if (name === 'list_automations') return listAutomations(s);
  if (name === 'run_automation') return await runAutomationByName(s, args.name, { trigger: mediationSource(options) });
  if (name === 'list_automation_runs') return recentRuns(s, args.limit || 25);
  if (name === 'daily_discovery') return await runDaily(s, { profileId: args.profileId });
  if (name === 'pursue_job') return await runPursuit(s, { jobId: args.jobId, profileId: args.profileId, stage: args.stage || null, dryRun: Boolean(args.dryRun), stageTimeoutMs: args.stageTimeoutMs || 30000 });
  if (name === 'answers_match') return matchAnswers(s, { profileId: args.profileId, questions: args.questions, employer: args.employer || '' });
  throw new DomainToolError('unimplemented_domain_tool', `JobOS domain tool is not implemented: ${name}`, { name });
}
