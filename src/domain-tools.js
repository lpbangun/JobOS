import { compareFitDecisions, deserializeFitScore, qualifiesForHighFit, score } from './scoring.js';
import { tailor } from './tailoring.js';
import { researchCompany } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan } from './research/contacts.js';
import { mapReachableNetwork } from './research/network.js';
import { createResearchRun, executeResearchRun, getResearchRun, resumeResearchRun, requestCancelResearchRun } from './research/runs.js';
import { appCreate, appUpdate, openTasks, recommendResearch } from './tracking.js';
import { weekly } from './analytics.js';
import { prepInterview } from './interview.js';
import { getJobLiveness, getPostingLiveness, importUrl, listJobs } from './jobs.js';
import { listSearches, runSavedSearch } from './discovery.js';
import { listAutomations } from './scheduler/store.js';
import { recentRuns, runAutomationByName } from './scheduler/core.js';
import { addAnswer, matchAnswers } from './answers.js';
import { runDaily, runPursuit } from './workflows.js';
import { compileApplicationReadiness, planApplication } from './readiness.js';
import { all, one } from './db.js';
import { parseJson } from './utils.js';
import { approveArtifact, artifactQueue, diffArtifact, rejectArtifact } from './artifacts.js';
import {
  createApplicationPacket,
  listApplicationPackets,
  showApplicationPacket,
  diffApplicationPackets,
  attestApplicationSubmitted,
  confirmApplicationReceipt
} from './packets.js';
import { DOM_ADAPTER_MANIFEST, inspectLiveForm } from './form-browser.js';
import { getFormSnapshot } from './forms.js';
import { checkpointApplicationForm, fillApplicationForm } from './form-actions.js';
import { submitApplicationForm } from './form-submission.js';

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
const researchSources = {
  type: 'array',
  items: { type: 'string', enum: ['local_network', 'linkedin_import', 'public_web', 'github', 'gdelt', 'wayback', 'xai'] }
};
const researchBudget = object({
  maxQueries: { type: 'number' },
  maxCandidates: { type: 'number' },
  maxSourceChars: { type: 'number' },
  maxModelCalls: { type: 'number' },
  maxPaidToolCalls: { type: 'number' },
  maxDurationMs: { type: 'number' },
  maxCostUsd: { type: ['number', 'null'] }
});
const peopleResearchRequest = {
  profileId: text,
  scope: { type: 'string', enum: ['profile', 'target', 'job', 'person'] },
  jobId: text,
  company: text,
  role: text,
  personId: text,
  person: required({ name: text, profileUrl: text }, ['name', 'profileUrl']),
  depth: { type: 'string', enum: ['standard', 'deep'] },
  sources: researchSources,
  refresh: { type: 'boolean' },
  budget: researchBudget
};

export const DOMAIN_TOOLS = Object.freeze([
  { name: 'list_jobs', description: 'List local JobOS jobs and their current fit, discovery, and application state. Filter status with discoveryStatus or applicationStatus.', inputSchema: object({ profileId: text, discoveryStatus: text, applicationStatus: text }) },
  { name: 'get_job_context', description: 'Read the secret-safe, evidence-grounded context packet for one selected job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'review_queue', description: 'List local draft artifacts awaiting human review.', inputSchema: object({ profileId: text, jobId: text }) },
  { name: 'diff_artifact', description: 'Inspect a line diff for an exact artifact revision without changing local state.', inputSchema: required({ artifactId: text, againstArtifactId: text }, ['artifactId']) },
  { name: 'approve_artifact', description: 'Record trusted local human approval of an exact current artifact revision; never submit or apply.', inputSchema: required({ artifactId: text, note: text }, ['artifactId']) },
  { name: 'reject_artifact', description: 'Record trusted local human rejection of an exact current artifact revision; a reason is required.', inputSchema: required({ artifactId: text, note: text }, ['artifactId', 'note']) },
  { name: 'discovery_health', description: 'Inspect saved discovery sources and recent isolated run failures.', inputSchema: object({ profileId: text }) },
  { name: 'score_job', description: 'Score a job against a profile.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'tailor_resume', description: 'Create an evidence-grounded tailored resume draft with optional local PDF rendering and layout preflight.', inputSchema: required({ jobId: text, profileId: text, layoutProfileId: { type: 'string', enum: ['professional', 'technical', 'leadership'] }, pageSize: { type: 'string', enum: ['letter', 'a4'] }, pageLimit: { type: 'number' }, density: { type: 'string', enum: ['compact', 'standard', 'spacious'] }, format: { type: 'string', enum: ['markdown', 'pdf'] }, sectionOrder: { type: 'array', items: { type: 'string' } } }, ['jobId', 'profileId']) },
  { name: 'draft_cover_letter', description: 'Create an evidence-grounded cover letter draft.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'research_company', description: 'Create a source-backed company dossier for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'start_people_research', description: 'Run people research synchronously for a scope (profile/target/job/person) and return the run result.', inputSchema: required(peopleResearchRequest, ['profileId', 'scope']) },
  { name: 'get_people_research_run', description: 'Get the current state of a people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'resume_people_research_run', description: 'Resume a paused_retryable people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'cancel_people_research_run', description: 'Request cancellation of a people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'approve_contact', description: 'Mark a discovered contact point as human-approved for later draft use.', inputSchema: required({ contactId: text }, ['contactId']) },
  { name: 'plan_outreach', description: 'Rank a reviewable outreach path from discovered contacts and user-owned network evidence.', inputSchema: required({ jobId: text, profileId: text, stakeholderId: text, goal: text }, ['jobId', 'profileId']) },
  { name: 'map_reachable_network', description: 'Create a local reachable-network path ladder for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'draft_outreach', description: 'Draft human-reviewed outreach for a stakeholder; never send it.', inputSchema: { type: 'object', properties: { jobId: text, stakeholderId: text, profileId: text, goal: text, planId: text, contactId: text }, required: ['profileId'], anyOf: [{ required: ['jobId', 'stakeholderId'] }, { required: ['planId'] }] } },
  { name: 'mark_outreach_sent', description: 'Record a user-confirmed outreach send; agent mediation is denied unless explicitly enabled.', inputSchema: required({ artifactId: text, channel: { type: 'string', enum: ['email', 'linkedin', 'other'] }, notes: text }, ['artifactId', 'channel']) },
  { name: 'schedule_outreach_followup', description: 'Create a local follow-up task for an outreach thread.', inputSchema: required({ threadId: text, afterDays: { type: 'number' } }, ['threadId', 'afterDays']) },
  { name: 'list_outreach_due', description: 'Show outreach-thread context for the canonical due outreach-followup task set (open, non-null due time passed); never sends anything.', inputSchema: object({}) },
  { name: 'create_application', description: 'Create a local application tracking record; agent mediation cannot attest submission by default.', inputSchema: required({ jobId: text, status: text, notes: text }, ['jobId', 'status']) },
  { name: 'applications_plan', description: 'Compile review readiness from local score, proofs, materials, answers, and identity evidence without applying or sending.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'update_application_status', description: 'Update a local application status; agent mediation cannot attest submission by default.', inputSchema: required({ applicationId: text, status: text, notes: text }, ['applicationId', 'status']) },
  { name: 'list_tasks', description: 'List open inbox tasks ordered by due date, including future and undated tasks. Use the tasks due CLI command with type and created-by filters for the canonical elapsed-deadline query.', inputSchema: object({ type: text, createdBy: text }) },
  { name: 'interview_prep', description: 'Create an evidence-grounded interview prep packet for an application and stage.', inputSchema: required({ applicationId: text, stage: text }, ['applicationId']) },
  { name: 'weekly_review', description: 'Generate a local weekly review and funnel insights.', inputSchema: required({ profileId: text }, ['profileId']) },
  { name: 'answers_match', description: 'Match verified non-sensitive local answers to application questions.', inputSchema: required({ profileId: text, employer: text, questions: { type: 'array', items: { type: ['string', 'object'] } } }, ['profileId', 'questions']) },
  { name: 'answers_add', description: 'Save a human-provided answer for an application question. Restricted categories are stored redacted and never auto-filled. Agent mediation is denied.', inputSchema: required({ profileId: text, category: text, question: text, answer: text, sensitivity: text, reuseScope: text, verificationStatus: text, sourceRef: text, employer: text }, ['profileId', 'question', 'answer']) },
  { name: 'application_packets_list', description: 'List application packets for a job/profile with derived currency and receipt state. At least one of jobId or profileId is required.', inputSchema: { type: 'object', properties: { jobId: text, profileId: text }, anyOf: [{ required: ['jobId'] }, { required: ['profileId'] }] } },
  { name: 'application_packet_show', description: 'Show one application packet with artifact hashes, redacted answers, identity, readiness snapshot, currency, receipt state, and secret-safe receipt metadata.', inputSchema: required({ packetId: text }, ['packetId']) },
  { name: 'application_packet_diff', description: 'Diff two application packets by their canonical projections, returning deterministic JSON-pointer changes and sameContent flag.', inputSchema: required({ firstPacketId: text, secondPacketId: text }, ['firstPacketId', 'secondPacketId']) },
  { name: 'create_application_packet', description: 'Freeze current approved materials, answers, and target into one immutable application packet. Requires approved local readiness.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'attest_application_submitted', description: 'Record trusted local human submission attestation for an exact packet. Binds pre-apply application status to applied.', inputSchema: required({ packetId: text, submittedAt: text }, ['packetId', 'submittedAt']) },
  { name: 'confirm_application_receipt', description: 'Record an external reference confirming receipt after a user_attestation exists. Does not change application status.', inputSchema: required({ packetId: text, reference: text }, ['packetId', 'reference']) },
  { name: 'inspect_application_form', description: 'Inspect one live employer application form read-only and persist a secret-safe bound snapshot.', inputSchema: required({ jobId: text, profileId: text, url: text, browserProfile: text, expectedAdapterHash: text }, ['jobId', 'profileId', 'url']) },
  { name: 'application_form_show', description: 'Show one persisted secret-safe application-form snapshot.', inputSchema: required({ snapshotId: text }, ['snapshotId']) },
  { name: 'assist_application_form', description: 'Fill exact safe packet-bound fields and report transient read-back statuses without submitting.', inputSchema: required({ packetId: text, browserProfile: text, allowSideEffects: { type: 'boolean' } }, ['packetId']) },
  { name: 'checkpoint_application_form', description: 'Accept a trusted human checkpoint after successful read-back and explicit manual-field confirmation.', inputSchema: required({ packetId: text, fillRunId: text, confirmedFieldKeys: { type: 'array', items: text } }, ['packetId', 'fillRunId']) },
  { name: 'submit_application_form', description: 'Submit one exact packet/form/checkpoint through a separately enabled configured adapter and return structured outcome evidence.', inputSchema: required({ packetId: text, checkpointId: text, browserProfile: text, allowSubmit: { type: 'boolean' } }, ['packetId', 'checkpointId']) },
  { name: 'list_saved_searches', description: 'List configured local discovery searches.', inputSchema: object({}) },
  { name: 'search_jobs', description: 'Run a saved discovery search and queue results for human review.', inputSchema: required({ search: text }, ['search']) },
  { name: 'import_job_url', description: 'Import a human-provided job URL into local JobOS state.', inputSchema: required({ profileId: text, url: text }, ['profileId', 'url']) },
  { name: 'list_automations', description: 'List configured local automations and schedules.', inputSchema: object({}) },
  { name: 'run_automation', description: 'Run a user-configured automation through the audited scheduler path.', inputSchema: required({ name: text }, ['name']) },
  { name: 'list_automation_runs', description: 'List recent automation runs.', inputSchema: object({ limit: { type: 'number' } }) },
  { name: 'daily_discovery', description: 'Run every saved discovery source for one profile and return ranked results plus isolated failures.', inputSchema: required({ profileId: text }, ['profileId']) },
  { name: 'pursue_job', description: 'Run the integrated fit, research, network, answers, artifact, application, and outreach-preparation workflow.', inputSchema: required({ jobId: text, profileId: text, stage: text, dryRun: { type: 'boolean' }, stageTimeoutMs: { type: 'number' } }, ['jobId', 'profileId']) },
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
  if (!['acp', 'mcp'].includes(source)) return;

  // approve_contact is always denied for agent mediation regardless of attestation override
  if (name === 'approve_contact') {
    throw new DomainToolError(
      'agent_human_confirmation_denied',
      'Agent mediation cannot approve contacts. Complete human confirmation manually.',
      { tool: name, source, status: null, externalSideEffect: 'none' }
    );
  }

  // Artifact approval/rejection is always denied for agent mediation
  if (name === 'answers_add') {
    throw new DomainToolError(
      'human_answer_input_required',
      'Answers require direct human input; agent mediation cannot write answers (restricted values must never be agent-mediated).',
      { tool: name, source, status: null, externalSideEffect: 'none' }
    );
  }

  if (name === 'approve_artifact' || name === 'reject_artifact') {
    throw new DomainToolError(
      'human_review_required',
      'Artifact approval and rejection require the trusted CLI or TUI human review flow.',
      { tool: name, source, status: null, externalSideEffect: 'none' }
    );
  }

  // Packet freeze is always denied for agent mediation
  if (name === 'create_application_packet') {
    throw new DomainToolError(
      'human_packet_freeze_required',
      'Packet freeze requires trusted CLI or TUI source.',
      { tool: name, source, status: null, externalSideEffect: 'none' }
    );
  }

  // Submission attestation and receipt confirmation are always denied for agent mediation
  if (name === 'attest_application_submitted' || name === 'confirm_application_receipt') {
    throw new DomainToolError(
      'human_submission_attestation_required',
      'Submission attestation requires trusted CLI or TUI human confirmation.',
      { tool: name, source, status: null, externalSideEffect: 'none' }
    );
  }

  // Attestation override only applies to mark_outreach_sent and application attestation statuses
  if (allowAgentAttestation(options)) return;

  const status = String(args.status || '').trim().toLowerCase();
  const denied = name === 'mark_outreach_sent'
    || ((name === 'create_application' || name === 'update_application_status') && EFFECT_ATTESTATION_STATUSES.has(status));
  if (!denied) return;
  throw new DomainToolError(
    'agent_human_confirmation_denied',
    'Agent mediation cannot approve contacts or attest apply/send actions by default. Complete the human confirmation manually or explicitly enable JOBOS_ALLOW_AGENT_ATTESTATION=1.',
    { tool: name, source, status: status || null, externalSideEffect: 'none' }
  );
}


function fitForRow(row) {
  return deserializeFitScore(parseJson(row.score_json, null), {
    persistedOverall: row.fit_score,
    jobId: row.id,
    profileId: row.profile_id
  });
}

function publicJob(row) {
  const fit = fitForRow(row);
  const highFit = Boolean(row.high_fit) && qualifiesForHighFit(fit, 0);
  const postingLiveness = getPostingLiveness(row);
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    company: row.company,
    location: row.location || '',
    source: row.source,
    discoveryStatus: row.status,
    fitScore: fit?.overall ?? null,
    score: fit?.overall ?? null,
    fit: fit ? { ...fit, highFit } : null,
    highFit,
    scoringMode: fit?.mode || null,
    applicationStatus: row.application_status || null,
    url: String(row.url || '').startsWith('jobos:text:') ? '' : (row.url || ''),
    compensation: parseJson(row.compensation_json, {}),
    workModel: row.work_model || 'unknown',
    employmentTypes: parseJson(row.employment_types_json, []),
    department: row.department || '',
    sourceNativeFields: parseJson(row.source_native_json, {}),
    liveness: getJobLiveness(row),
    postingLiveness,
    updatedAt: row.updated_at
  };
}

export function listJobSummaries(s, {
  profileId = null,
  discoveryStatus = null,
  applicationStatus = null
} = {}) {
  return listJobs(s)
    .filter(row => !profileId || row.profile_id === profileId)
    .filter(row => !discoveryStatus || row.status === discoveryStatus)
    .filter(row => !applicationStatus || row.application_status === applicationStatus)
    .map(publicJob)
    .sort(compareFitDecisions);
}

export function reviewQueue(s, { profileId = null, jobId = null } = {}) {
  return artifactQueue(s, { profileId, jobId });
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
  const fitData = fitForRow(job);
  const tasks = all(s, "SELECT id,title,type,due_at,priority,status FROM tasks WHERE job_id=? AND status='open' ORDER BY due_at IS NULL,due_at,created_at LIMIT 8", [jobId])
    .map(row => ({ id: row.id, title: row.title, type: row.type, dueAt: row.due_at || null, priority: row.priority }));
  const artifacts = all(s, `SELECT artifacts.*,
      (SELECT MAX(revision) FROM artifacts current WHERE current.series_key=artifacts.series_key) AS current_revision
    FROM artifacts WHERE job_id=? ORDER BY created_at DESC,revision DESC`, [jobId])
    .map(row => ({
      id: row.id,
      type: row.type,
      path: row.path,
      title: row.title,
      proofIds: parseJson(row.evidence_json, []).map(value => typeof value === 'string' ? value : (value?.proofPointId || value?.id)).filter(Boolean),
      warnings: parseJson(row.warnings_json, []).map(value => typeof value === 'string' ? value : JSON.stringify(value)),
      approvalStatus: row.approval_status,
      seriesKey: row.series_key,
      revision: Number(row.revision),
      revisionState: Number(row.revision) === Number(row.current_revision) ? 'current' : 'superseded',
      effectiveReviewStatus: Number(row.revision) === Number(row.current_revision)
        ? (row.approval_status === 'draft_needs_human_review' ? 'pending' : row.approval_status)
        : 'stale',
      contentHash: row.content_hash,
      reviewedAt: row.reviewed_at || null,
      createdAt: row.created_at
    }));
  const proofIds = [...new Set(artifacts.flatMap(item => item.proofIds))];
  const proofs = proofIds.length
    ? all(s, `SELECT id,summary,evidence,source FROM proof_points WHERE id IN (${proofIds.map(() => '?').join(',')})`, proofIds)
      .map(row => ({ id: row.id, summary: row.summary, evidence: row.evidence, source: row.source }))
    : [];
  const path = one(s, 'SELECT id,path_strength,channel,reasoning_json,warnings_json,created_at FROM outreach_plans WHERE job_id=? ORDER BY recommended DESC,created_at DESC LIMIT 1', [jobId]);
  return {
    version: 2,
    job: {
      id: job.id,
      profileId: job.profile_id,
      title: job.title,
      company: job.company,
      location: job.location || '',
      source: job.source,
      discoveryStatus: job.status,
      applicationId: job.application_id || null,
      applicationStatus: job.application_status || null,
      compensation: parseJson(job.compensation_json, {}),
      workModel: job.work_model || 'unknown',
      employmentTypes: parseJson(job.employment_types_json, []),
      department: job.department || '',
      sourceNativeFields: parseJson(job.source_native_json, {}),
      postingLiveness: getPostingLiveness(job),
    },
    liveness: getPostingLiveness(job),
    fit: fitData ? {
      ...fitData,
      highFit: Boolean(job.high_fit) && qualifiesForHighFit(fitData, 0)
    } : null,
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
    readiness: compileApplicationReadiness(s, { jobId, profileId: job.profile_id }),
    policy: {
      drafts: 'draft_needs_human_review',
      localReview: 'trusted_cli_or_tui_only',
      externalApply: 'user_configured_default_off',
      externalSend: 'user_configured_default_off',
      externalSideEffects: 'none',
      submissionPerformed: false,
      applicationStatusChanged: false
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
  if (name === 'diff_artifact') return diffArtifact(s, args.artifactId, { againstArtifactId: args.againstArtifactId || null });
  if (name === 'approve_artifact') return approveArtifact(s, args.artifactId, { reviewedBy: mediationSource(options), note: args.note || '' });
  if (name === 'reject_artifact') return rejectArtifact(s, args.artifactId, { reviewedBy: mediationSource(options), note: args.note || '' });
  if (name === 'discovery_health') return discoveryHealth(s, args);
  if (name === 'score_job') return await score(s, args.jobId, args.profileId);
  if (name === 'tailor_resume') return await tailor(s, args.jobId, args.profileId, 'resume', { layoutProfileId: args.layoutProfileId, pageSize: args.pageSize, pageLimit: args.pageLimit, density: args.density, format: args.format, sectionOrder: args.sectionOrder });
  if (name === 'draft_cover_letter') return await tailor(s, args.jobId, args.profileId, 'cover');
  if (name === 'research_company') return await researchCompany(s, args.jobId);
  if (name === 'start_people_research') {
    const runId = createResearchRun(s, {
      profileId: args.profileId,
      scope: args.scope,
      jobId: args.jobId || undefined,
      company: args.company || undefined,
      role: args.role || undefined,
      personId: args.personId || undefined,
      person: args.person || undefined,
      depth: args.depth || 'standard',
      sources: args.sources || undefined,
      budget: args.budget || undefined,
      refresh: Boolean(args.refresh)
    });
    return await executeResearchRun(s, runId);
  }
  if (name === 'get_people_research_run') return getResearchRun(s, args.runId);
  if (name === 'resume_people_research_run') return await resumeResearchRun(s, args.runId);
  if (name === 'cancel_people_research_run') return requestCancelResearchRun(s, args.runId);
  if (name === 'approve_contact') return approveContact(s, { contactId: args.contactId });
  if (name === 'plan_outreach') return createOutreachPlan(s, { jobId: args.jobId, profileId: args.profileId, stakeholderId: args.stakeholderId || null, goal: args.goal || 'informational' });
  if (name === 'map_reachable_network') return mapReachableNetwork(s, { jobId: args.jobId });
  if (name === 'draft_outreach') {
    if (!(args.jobId && args.stakeholderId) && !args.planId) {
      throw new DomainToolError('draft_outreach_missing_target', 'draft_outreach requires a jobId+stakeholderId or a planId', { args });
    }
    return await draftOutreach(s, { jobId: args.jobId || null, stakeholderId: args.stakeholderId || null, profileId: args.profileId, goal: args.goal || 'informational', planId: args.planId || null, contactId: args.contactId || null });
  }
  if (name === 'mark_outreach_sent') return markOutreachSent(s, { artifactId: args.artifactId, channel: args.channel, notes: args.notes || '' });
  if (name === 'schedule_outreach_followup') return scheduleFollowup(s, { threadId: args.threadId, afterDays: args.afterDays });
  if (name === 'list_outreach_due') return outreachDue(s);
  if (name === 'create_application') {
    const application = appCreate(s, args.jobId, args.status, args.notes || '');
    return { ...application, researchRecommendation: recommendResearch(s, { jobId: application.job_id, profileId: application.profile_id, status: application.status }) };
  }
  if (name === 'applications_plan') return planApplication(s, { jobId: args.jobId, profileId: args.profileId });
  if (name === 'update_application_status') {
    const application = appUpdate(s, args.applicationId, args.status, args.notes ?? null);
    return { ...application, researchRecommendation: recommendResearch(s, { jobId: application.job_id, profileId: application.profile_id, status: application.status }) };
  }
  if (name === 'list_tasks') return openTasks(s, { type: args.type || null, createdBy: args.createdBy || null });
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
  if (name === 'answers_add') return addAnswer(s, {
    profileId: args.profileId,
    category: args.category || 'other',
    question: args.question,
    answer: args.answer,
    sensitivity: args.sensitivity || 'personal',
    reuseScope: args.reuseScope || 'global',
    verificationStatus: args.verificationStatus || 'verified',
    sourceRef: args.sourceRef || 'user_input',
    employer: args.employer || ''
  });
  if (name === 'application_packets_list') return listApplicationPackets(s, { jobId: args.jobId, profileId: args.profileId });
  if (name === 'application_packet_show') return showApplicationPacket(s, args.packetId);
  if (name === 'application_packet_diff') return diffApplicationPackets(s, args.firstPacketId, args.secondPacketId);
  if (name === 'inspect_application_form') return await inspectLiveForm(s, {
    jobId: args.jobId,
    profileId: args.profileId,
    url: args.url,
    browserProfile: args.browserProfile || 'default',
    expectedAdapterHash: args.expectedAdapterHash || null
  });
  if (name === 'application_form_show') return getFormSnapshot(s, args.snapshotId);
  if (name === 'assist_application_form') {
    const source = mediationSource(options);
    if (['mcp', 'acp'].includes(source)) {
      const packet = showApplicationPacket(s, args.packetId);
      const profile = one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [packet.profileId]);
      const preferences = parseJson(profile?.preferences_json, {});
      const enabled = preferences?.externalActions?.agentFormInvocationEnabled === true
        || process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED === '1';
      if (!enabled) throw new DomainToolError('agent_form_invocation_not_enabled', 'Mediated form actions are disabled for this profile/environment.', { source });
    }
    return await fillApplicationForm(s, {
      packetId: args.packetId,
      workspace: s.p.root,
      browserProfile: args.browserProfile || 'default',
      allowSideEffects: args.allowSideEffects === true,
      adapterManifest: DOM_ADAPTER_MANIFEST,
      expectedAdapterHash: args.expectedAdapterHash || null
    });
  }
  if (name === 'checkpoint_application_form') return checkpointApplicationForm(s, {
    packetId: args.packetId,
    fillRunId: args.fillRunId,
    confirmedFieldKeys: args.confirmedFieldKeys || [],
    source: mediationSource(options)
  });
  if (name === 'submit_application_form') {
    const source = mediationSource(options);
    if (['mcp', 'acp'].includes(source)) {
      const packet = showApplicationPacket(s, args.packetId);
      const profile = one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [packet.profileId]);
      const preferences = parseJson(profile?.preferences_json, {});
      const enabled = preferences?.externalActions?.agentFormInvocationEnabled === true
        || process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED === '1';
      if (!enabled) throw new DomainToolError('agent_form_invocation_not_enabled', 'Mediated form actions are disabled for this profile/environment.', { source });
    }
    return await submitApplicationForm(s, {
      packetId: args.packetId,
      checkpointId: args.checkpointId,
      workspace: s.p.root,
      browserProfile: args.browserProfile || 'default',
      allowSubmit: args.allowSubmit === true,
      invokedBy: source,
      expectedAdapterHash: args.expectedAdapterHash || null
    });
  }
  if (name === 'create_application_packet') {
    const readiness = compileApplicationReadiness(s, { jobId: args.jobId, profileId: args.profileId, includePacket: false });
    return await createApplicationPacket(s, { jobId: args.jobId, profileId: args.profileId, createdBy: mediationSource(options), readiness });
  }
  if (name === 'attest_application_submitted') return await attestApplicationSubmitted(s, { packetId: args.packetId, submittedAt: args.submittedAt, note: args.note || '', source: mediationSource(options) });
  if (name === 'confirm_application_receipt') return await confirmApplicationReceipt(s, { packetId: args.packetId, reference: args.reference, note: args.note || '', source: mediationSource(options) });
  throw new DomainToolError('unimplemented_domain_tool', `JobOS domain tool is not implemented: ${name}`, { name });
}
