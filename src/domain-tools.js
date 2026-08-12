import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareFitDecisions, deserializeFitScore, qualifiesForHighFit, score } from './scoring.js';
import { tailor } from './tailoring.js';
import { researchCompany } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan } from './research/contacts.js';
import { listOutreachOutcomes, recordOutreachOutcome } from './outreach-outcomes.js';
import { mapReachableNetwork, networkGraphQuery, networkHealthBrief, networkOpportunitiesList, recordNetworkContact } from './research/network.js';
import { createResearchRun, executeResearchRun, getResearchRun, resumeResearchRun, requestCancelResearchRun } from './research/runs.js';
import { findPersonByEmail } from './research/people.js';
import { appCreate, appUpdate, openTasks, recommendResearch, taskView } from './tracking.js';
import { weekly } from './analytics.js';
import { lifecycleAnalytics } from './lifecycle-analytics.js';
import { listLifecycleObservations } from './lifecycle.js';
import { INTERVIEW_AUDIENCES, INTERVIEW_STAGES, INTERVIEW_STORY_CONTENT_FIELDS, createInterviewQuestionSource, createInterviewStory, correctInterviewDebrief, getInterviewDebrief, getInterviewStory, listInterviewDebriefs, listInterviewObservations, listInterviewStories, prepInterview, recordInterviewDebrief, retireInterviewStory, verifyInterviewStory } from './interview.js';
import { getPostingLiveness, importUrl, listJobs } from './jobs.js';
import { listSearches, runSavedSearch } from './discovery.js';
import { listAutomations } from './scheduler/store.js';
import { recentRuns, runAutomationByName } from './scheduler/core.js';
import { addAnswer, matchAnswers } from './answers.js';
import { runDaily, runPursuit } from './workflows.js';
import { compileApplicationReadiness, planApplication } from './readiness.js';
import { all, one, openStore } from './db.js';
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
import { correctMemoryObservation, listMemoryObservations, recordJobFeedback, undoMemoryObservation } from './career-memory-observations.js';
import { createMemoryProposal, deriveMemoryProposals, listMemoryProposals, transitionMemoryProposal, undoMemoryTransition } from './career-memory-proposals.js';
import { getCareerBrief, getVoicePositioningGuide } from './career-memory-projections.js';
import { retrieveCareerMemory } from './career-memory-retrieval.js';

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
const closed = properties => ({ type: 'object', properties, additionalProperties: false });
const closedRequired = (properties, names) => ({ ...closed(properties), required: names });
const text = { type: 'string' };
const boolean = { type: 'boolean' };
const stringArray = { type: 'array', items: text };
const interviewStoryProperties = {
  profileId: text,
  storyId: text,
  title: text,
  situation: text,
  task: text,
  action: text,
  result: text,
  reflection: text,
  competencyTags: stringArray,
  audienceTags: { type: 'array', items: { type: 'string', enum: INTERVIEW_AUDIENCES } },
  fieldProvenance: { type: 'object' },
  confirmedFields: { type: 'array', items: { type: 'string', enum: INTERVIEW_STORY_CONTENT_FIELDS } },
  fieldEvidence: { type: 'object' },
  actor: text,
};
const interviewQuestionProperties = {
  profileId: text,
  applicationId: text,
  stage: { type: 'string', enum: INTERVIEW_STAGES },
  audience: { type: 'string', enum: INTERVIEW_AUDIENCES },
  questionText: text,
  sourceKind: { type: 'string', enum: ['user_provided', 'recruiter_provided', 'interviewer_provided'] },
  sourceRef: text,
  actor: text,
  supersedesSourceId: text,
  correctionReason: text,
};
const interviewDebriefProperties = {
  profileId: text,
  debriefId: text,
  applicationId: text,
  interviewStage: { type: 'string', enum: INTERVIEW_STAGES },
  audience: { type: 'string', enum: INTERVIEW_AUDIENCES },
  referenceId: text,
  targetRevision: { type: 'number' },
  reason: text,
  occurredAt: text,
  actor: text,
  observedQuestions: { type: 'array', items: { type: 'object' } },
  observedOutcome: { type: 'object' },
  proofGaps: { type: 'array', items: { type: 'object' } },
  storyUses: { type: 'array', items: { type: 'object' } },
  notes: text,
  fieldProvenance: { type: 'object' },
};
const researchSources = {
  type: 'array',
  items: { type: 'string', enum: ['local_network', 'linkedin_import', 'public_web', 'exa_people', 'github', 'gdelt', 'wayback', 'xai'] }
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
const memorySearchValue = closedRequired({
  polarity: { type: 'string', enum: ['prefer', 'avoid'] },
  value: text,
  match: { type: 'string', enum: ['exact', 'token'] },
}, ['polarity', 'value', 'match']);
const memoryProposalValue = {
  oneOf: [
    memorySearchValue,
    closedRequired({ value: text }, ['value']),
    closedRequired({ minWords: { type: 'number' }, maxWords: { type: 'number' } }, ['minWords', 'maxWords']),
    closedRequired({ terms: stringArray }, ['terms']),
    closedRequired({ claimPattern: text, reasonCode: { type: 'string', enum: ['unsupported', 'unwanted_positioning'] } }, ['claimPattern', 'reasonCode']),
    closedRequired({ theme: text, proofPointIds: stringArray }, ['theme', 'proofPointIds']),
    closedRequired({ artifactId: text, revision: { type: 'number' }, contentHash: text, startLine: { type: 'number' }, endLine: { type: 'number' }, excerptHash: text }, ['artifactId', 'revision', 'contentHash', 'startLine', 'endLine', 'excerptHash']),
  ],
};
const memoryEvidence = closedRequired({
  observationSchema: text,
  observationId: text,
  polarity: { type: 'string', enum: ['support', 'conflict'] },
}, ['observationSchema', 'observationId', 'polarity']);
const memoryProposalInput = closedRequired({
  schema: { type: 'string', enum: ['jobos.memory-proposal-input.v1'] },
  domain: { type: 'string', enum: ['search', 'writing'] },
  scope: { type: 'string', enum: ['search', 'resume', 'cover_letter', 'outreach', 'interview_prep', 'writing_global'] },
  ruleType: text,
  value: memoryProposalValue,
  rationale: text,
  evidence: { type: 'array', items: memoryEvidence },
  referenceId: text,
  createdAt: text,
}, ['schema', 'domain', 'scope', 'ruleType', 'value', 'rationale', 'evidence', 'referenceId']);
const memorySignal = closed({ field: text, polarity: text, value: { oneOf: [text, memoryProposalValue] }, match: text, ruleType: text });
const jobFeedbackInput = closedRequired({
  schema: { type: 'string', enum: ['jobos.job-feedback-input.v1'] },
  decision: { type: 'string', enum: ['save', 'skip', 'apply'] },
  reasonCodes: stringArray,
  signals: { type: 'array', items: memorySignal },
  publicExplanation: text,
  privateNote: text,
  referenceId: text,
  occurredAt: text,
}, ['schema', 'decision', 'reasonCodes', 'signals', 'publicExplanation', 'privateNote', 'referenceId', 'occurredAt']);
const memoryReplacement = closedRequired({
  reasonCodes: stringArray,
  signals: { type: 'array', items: memorySignal },
  publicExplanation: text,
  privateNote: text,
}, ['reasonCodes', 'signals', 'publicExplanation', 'privateNote']);
const peopleResearchRequest = {
  profileId: text,
  scope: { type: 'string', enum: ['profile', 'target', 'job', 'person'] },
  jobId: text,
  company: text,
  role: text,
  personId: text,
  email: text,
  person: required({ name: text, profileUrl: text }, ['name', 'profileUrl']),
  depth: { type: 'string', enum: ['standard', 'deep'] },
  sources: researchSources,
  refresh: { type: 'boolean' },
  budget: researchBudget
};

export const DOMAIN_TOOLS = Object.freeze([
  { name: 'list_jobs', description: 'List local JobOS jobs and their current fit, discovery, and application state. Filter status with discoveryStatus or applicationStatus.', inputSchema: object({ profileId: text, discoveryStatus: text, applicationStatus: text }) },
  { name: 'get_job_context', description: 'Read the secret-safe, evidence-grounded context packet for one profile-owned selected job.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'review_queue', description: 'List local draft artifacts awaiting human review.', inputSchema: object({ profileId: text, jobId: text }) },
  { name: 'diff_artifact', description: 'Inspect a line diff for an exact artifact revision without changing local state.', inputSchema: required({ artifactId: text, againstArtifactId: text }, ['artifactId']) },
  { name: 'approve_artifact', description: 'Record trusted local human approval of an exact current artifact revision; never submit or apply.', inputSchema: required({ artifactId: text, note: text }, ['artifactId']) },
  { name: 'reject_artifact', description: 'Record trusted local human rejection of an exact current artifact revision; a reason is required.', inputSchema: required({ artifactId: text, note: text }, ['artifactId', 'note']) },
  { name: 'discovery_health', description: 'Inspect saved discovery sources and recent isolated run failures.', inputSchema: object({ profileId: text }) },
  { name: 'score_job', description: 'Score a job against a profile.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'tailor_resume', description: 'Create an evidence-grounded tailored resume draft with optional local PDF rendering and layout preflight.', inputSchema: required({ jobId: text, profileId: text, layoutProfileId: { type: 'string', enum: ['professional', 'technical', 'leadership'] }, pageSize: { type: 'string', enum: ['letter', 'a4'] }, pageLimit: { type: 'number' }, density: { type: 'string', enum: ['compact', 'standard', 'spacious'] }, format: { type: 'string', enum: ['markdown', 'pdf'] }, sectionOrder: { type: 'array', items: { type: 'string' } } }, ['jobId', 'profileId']) },
  { name: 'draft_cover_letter', description: 'Create an evidence-grounded cover letter draft with optional local PDF rendering.', inputSchema: required({ jobId: text, profileId: text, pageSize: { type: 'string', enum: ['letter', 'a4'] }, pageLimit: { type: 'number' }, format: { type: 'string', enum: ['markdown', 'pdf'] } }, ['jobId', 'profileId']) },
  { name: 'research_company', description: 'Create a source-backed company dossier for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'find_person', description: 'Find one canonical person by an exact normalized email. Agent callers receive contact types, counts, and tiers without values.', inputSchema: required({ email: text }, ['email']) },
  { name: 'start_people_research', description: 'Run people research synchronously for a scope (profile/target/job/person) and return the run result.', inputSchema: required(peopleResearchRequest, ['profileId', 'scope']) },
  { name: 'get_people_research_run', description: 'Get the current state of a people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'resume_people_research_run', description: 'Resume a paused_retryable people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'cancel_people_research_run', description: 'Request cancellation of a people research run.', inputSchema: required({ runId: text }, ['runId']) },
  { name: 'approve_contact', description: 'Mark a discovered contact point as human-approved for later draft use.', inputSchema: required({ contactId: text }, ['contactId']) },
  { name: 'plan_outreach', description: 'Rank a reviewable outreach path from discovered contacts and user-owned network evidence.', inputSchema: required({ jobId: text, profileId: text, stakeholderId: text, goal: text }, ['jobId', 'profileId']) },
  { name: 'map_reachable_network', description: 'Create a local reachable-network path ladder for a job.', inputSchema: required({ jobId: text }, ['jobId']) },
  { name: 'network_opportunities_list', description: 'List profile-level networking opportunities ranked deterministically from local relationship and contact-point state; never sends or requests anything.', inputSchema: closedRequired({ profileId: text, limit: { type: 'number' }, asOf: text }, ['profileId']) },
  { name: 'network_graph_query', description: 'Query the local profile network graph with bounded two-hop paths from the profile through people to people or companies; deterministic and read-only.', inputSchema: closedRequired({ profileId: text, jobId: text, personId: text, maxHops: { type: 'number' } }, ['profileId']) },
  { name: 'network_health_brief', description: 'Read the deterministic profile network health brief with relationship warmth and recency derived from local state as of a timestamp.', inputSchema: closedRequired({ profileId: text, asOf: text }, ['profileId']) },
  { name: 'network_contact_record', description: 'Record a trusted human-confirmed contact with a person, updating the profile relationship edge and contact-point warmth and last-contact timestamps; agent mediation is denied.', inputSchema: closedRequired({ profileId: text, personId: text, contactPointId: text, occurredAt: text, warmth: { type: 'string', enum: ['unknown', 'cold', 'cool', 'warm', 'hot'] }, note: text }, ['profileId', 'personId']) },
  { name: 'draft_outreach', description: 'Draft human-reviewed outreach for a stakeholder; never send it.', inputSchema: { type: 'object', properties: { jobId: text, stakeholderId: text, profileId: text, goal: text, planId: text, contactId: text }, required: ['profileId'], anyOf: [{ required: ['jobId', 'stakeholderId'] }, { required: ['planId'] }] } },
  { name: 'mark_outreach_sent', description: 'Record a user-confirmed outreach send; agent mediation is denied unless explicitly enabled.', inputSchema: required({ artifactId: text, channel: { type: 'string', enum: ['email', 'linkedin', 'other'] }, notes: text }, ['artifactId', 'channel']) },
  { name: 'schedule_outreach_followup', description: 'Create a local follow-up task for an outreach thread.', inputSchema: required({ threadId: text, afterDays: { type: 'number' } }, ['threadId', 'afterDays']) },
  { name: 'list_outreach_due', description: 'Show outreach-thread context for the canonical due outreach-followup task set (open, non-null due time passed); never sends anything.', inputSchema: object({}) },
  { name: 'record_outreach_outcome', description: 'Record one explicit append-only profile-scoped outreach observation. No reply prediction, causality, or external action.', inputSchema: required({ threadId: text, profileId: text, type: { type: 'string', enum: ['reply_positive', 'reply_neutral', 'reply_negative', 'meeting_booked', 'no_response', 'bounced', 'declined'] }, occurredAt: text, windowEndAt: text, channel: text, referenceId: text, supersedesOutcomeId: text, correctionReason: text }, ['threadId', 'profileId', 'type', 'occurredAt']) },
  { name: 'list_outreach_outcomes', description: 'List profile-scoped outreach observations and correction history without private notes.', inputSchema: required({ profileId: text, sinceDays: { type: 'number' } }, ['profileId']) },
  { name: 'create_application', description: 'Create a local application tracking record; agent mediation cannot attest submission by default.', inputSchema: required({ jobId: text, status: text, notes: text }, ['jobId', 'status']) },
  { name: 'applications_plan', description: 'Compile review readiness from local score, proofs, materials, answers, and identity evidence without applying or sending.', inputSchema: required({ jobId: text, profileId: text }, ['jobId', 'profileId']) },
  { name: 'update_application_status', description: 'Update a local application status; agent mediation cannot attest submission by default.', inputSchema: required({ applicationId: text, status: text, notes: text }, ['applicationId', 'status']) },
  { name: 'list_tasks', description: 'List one profile task inbox ordered by due date, including future and undated tasks.', inputSchema: required({ profileId: text, type: text, createdBy: text }, ['profileId']) },
  { name: 'lifecycle_analytics', description: 'Report profile-owned observed lifecycle analytics with explicit denominators, cautions, and no causal claims.', inputSchema: required({ profileId: text, sinceDays: { type: 'number' } }, ['profileId']) },
  { name: 'list_lifecycle_observations', description: 'List attributed profile-owned lifecycle status and immutable submission observations.', inputSchema: required({ profileId: text, sinceDays: { type: 'number' } }, ['profileId']) },
  { name: 'list_interview_stories', description: 'List profile-owned interview stories with optional append-only revision history.', inputSchema: required({ profileId: text, includeHistory: boolean }, ['profileId']) },
  { name: 'get_interview_story', description: 'Read one profile-owned interview story with optional append-only revision history.', inputSchema: required({ profileId: text, storyId: text, includeHistory: boolean }, ['profileId', 'storyId']) },
  { name: 'draft_interview_story', description: 'Create an attributed proof-linked interview story draft that still requires direct human verification.', inputSchema: required(interviewStoryProperties, ['profileId']) },
  { name: 'verify_interview_story', description: 'Direct trusted human verification of an exact interview story draft revision.', inputSchema: required({ profileId: text, storyId: text, revision: { type: 'number' }, confirmedFields: stringArray, actor: text }, ['profileId', 'storyId', 'revision', 'confirmedFields', 'actor']) },
  { name: 'retire_interview_story', description: 'Direct trusted human retirement of an interview story with a required reason.', inputSchema: required({ profileId: text, storyId: text, reason: text, actor: text }, ['profileId', 'storyId', 'reason', 'actor']) },
  { name: 'add_interview_question_source', description: 'Record a directly sourced profile- and application-owned interview question.', inputSchema: required(interviewQuestionProperties, ['profileId', 'applicationId', 'stage', 'questionText', 'sourceKind', 'actor']) },
  { name: 'interview_prep', description: 'Create an evidence-grounded interview prep packet for an application, stage, and optional audience.', inputSchema: required({ applicationId: text, stage: text, audience: { type: 'string', enum: INTERVIEW_AUDIENCES } }, ['applicationId']) },
  { name: 'record_interview_debrief', description: 'Record a directly observed attributed interview debrief; no external action or causal inference.', inputSchema: required(interviewDebriefProperties, ['profileId', 'applicationId', 'interviewStage', 'audience', 'occurredAt', 'actor', 'observedQuestions', 'observedOutcome', 'proofGaps', 'storyUses', 'notes', 'fieldProvenance']) },
  { name: 'correct_interview_debrief', description: 'Append a direct human correction to the exact current interview debrief revision.', inputSchema: required(interviewDebriefProperties, ['profileId', 'debriefId', 'targetRevision', 'reason', 'occurredAt', 'actor', 'observedQuestions', 'observedOutcome', 'proofGaps', 'storyUses', 'notes', 'fieldProvenance']) },
  { name: 'list_interview_debriefs', description: 'List full local profile-owned interview debrief data with optional revision history.', inputSchema: required({ profileId: text, applicationId: text, includeHistory: boolean }, ['profileId']) },
  { name: 'list_interview_observations', description: 'List attributed interview observations without private debrief notes.', inputSchema: required({ profileId: text, sinceDays: { type: 'number' } }, ['profileId']) },
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
  { name: 'list_memory_observations', description: 'List profile-scoped career-memory observations without private-note text.', inputSchema: closedRequired({ profileId: text, sinceDays: { type: ['number', 'null'] }, types: stringArray, includeHistory: boolean }, ['profileId']) },
  { name: 'list_memory_proposals', description: 'List immutable profile-scoped career-memory proposals and transition history.', inputSchema: closedRequired({ profileId: text, statuses: stringArray, domain: { type: 'string', enum: ['search', 'writing'] }, scope: text, includeEvidence: boolean }, ['profileId']) },
  { name: 'get_career_brief', description: 'Read or explicitly refresh the deterministic cited career brief.', inputSchema: closedRequired({ profileId: text, revision: { type: ['number', 'null'] }, asOf: text, refresh: boolean }, ['profileId']) },
  { name: 'get_voice_positioning_guide', description: 'Read or explicitly refresh the deterministic proof-safe voice and positioning guide.', inputSchema: closedRequired({ profileId: text, artifactType: text, revision: { type: ['number', 'null'] }, asOf: text, refresh: boolean }, ['profileId']) },
  { name: 'retrieve_career_memory', description: 'Retrieve bounded accepted guidance with private notes excluded.', inputSchema: closedRequired({ profileId: text, consumer: { type: 'string', enum: ['discovery', 'scoring', 'tailoring', 'outreach', 'interview_prep'] }, jobId: text, artifactType: text, asOf: text }, ['profileId', 'consumer']) },
  { name: 'derive_memory_proposals', description: 'Derive inactive memory proposals, optionally as a write-free dry run.', inputSchema: closedRequired({ profileId: text, asOf: text, dryRun: boolean }, ['profileId']) },
  { name: 'create_memory_proposal', description: 'Create only an inactive cited memory proposal.', inputSchema: closedRequired({ profileId: text, proposal: memoryProposalInput, validateOnly: boolean }, ['profileId', 'proposal']) },
  { name: 'record_job_feedback', description: 'Record direct trusted-human structured job feedback.', inputSchema: closedRequired({ profileId: text, jobId: text, feedback: jobFeedbackInput, validateOnly: boolean }, ['profileId', 'jobId', 'feedback']) },
  { name: 'correct_memory_observation', description: 'Append a direct trusted-human observation correction.', inputSchema: closedRequired({ profileId: text, observationId: text, replacement: memoryReplacement, reason: text, validateOnly: boolean }, ['profileId', 'observationId', 'replacement', 'reason']) },
  { name: 'undo_memory_observation', description: 'Undo the current direct-human observation correction.', inputSchema: closedRequired({ profileId: text, observationId: text, referenceId: text, reason: text }, ['profileId', 'observationId', 'referenceId', 'reason']) },
  { name: 'accept_memory_proposal', description: 'Direct trusted-human acceptance of an eligible proposal.', inputSchema: closedRequired({ profileId: text, proposalId: text, referenceId: text, reason: text }, ['profileId', 'proposalId', 'referenceId']) },
  { name: 'reject_memory_proposal', description: 'Direct trusted-human rejection of an inactive proposal.', inputSchema: closedRequired({ profileId: text, proposalId: text, referenceId: text, reason: text }, ['profileId', 'proposalId', 'referenceId', 'reason']) },
  { name: 'revoke_memory_proposal', description: 'Direct trusted-human revocation of accepted guidance.', inputSchema: closedRequired({ profileId: text, proposalId: text, referenceId: text, reason: text }, ['profileId', 'proposalId', 'referenceId', 'reason']) },
  { name: 'undo_memory_transition', description: 'Direct trusted-human inverse of a current reversible transition.', inputSchema: closedRequired({ profileId: text, transitionId: text, referenceId: text, reason: text }, ['profileId', 'transitionId', 'referenceId', 'reason']) },
]);

const EFFECT_ATTESTATION_STATUSES = new Set(['applied', 'submitted', 'sent']);

function mediationSource(options) {
  return String(options.source || process.env.JOBOS_MEDIATION || 'domain');
}

function allowAgentAttestation(options) {
  if (options.allowExternalAttestation === true) return true;
  return process.env.JOBOS_ALLOW_AGENT_ATTESTATION === '1';
}
const HUMAN_INTERVIEW_MUTATIONS = new Set([
  'verify_interview_story',
  'retire_interview_story',
  'add_interview_question_source',
  'record_interview_debrief',
  'correct_interview_debrief',
]);
const HUMAN_INTERVIEW_INPUT_MESSAGE = 'Interview verification, retirement, sourced questions, and debrief recording or correction require trusted CLI or TUI human input.';
const HUMAN_MEMORY_MUTATIONS = new Set([
  'record_job_feedback', 'correct_memory_observation', 'undo_memory_observation',
  'accept_memory_proposal', 'reject_memory_proposal', 'revoke_memory_proposal',
  'undo_memory_transition',
]);
const HUMAN_MEMORY_INPUT_MESSAGE = 'Career-memory feedback, corrections, and lifecycle decisions require trusted CLI or TUI human input.';
const HUMAN_NETWORK_MUTATIONS = new Set([
  'network_contact_record',
  'mark_outreach_sent',
]);
const HUMAN_NETWORK_INPUT_MESSAGE = 'Recording network contacts or confirmed sends requires trusted CLI or TUI human input.';

function trustedNetworkSource(options) {
  const source = mediationSource(options);
  if (source === 'cli' || source === 'tui') return source;
  throw new DomainToolError(
    'human_network_input_required',
    HUMAN_NETWORK_INPUT_MESSAGE,
    { tool: null, source, status: null, externalSideEffect: 'none' },
  );
}

function trustedInterviewSource(options) {
  const source = mediationSource(options);
  if (source === 'cli' || source === 'tui') return source;
  throw new DomainToolError(
    'human_interview_input_required',
    HUMAN_INTERVIEW_INPUT_MESSAGE,
    { tool: null, source, status: null, externalSideEffect: 'none' },
  );
}

function attributedInterviewDraft(args, options) {
  const source = mediationSource(options);
  if (!['mcp', 'acp'].includes(source)) {
    return {
      ...args,
      actor: args.actor || source,
      source,
    };
  }
  const supplied = args.fieldProvenance && typeof args.fieldProvenance === 'object'
    ? args.fieldProvenance
    : {};
  const fieldProvenance = Object.fromEntries(INTERVIEW_STORY_CONTENT_FIELDS.map(field => [
    field,
    {
      origin: 'agent',
      actor: source,
      source,
      sourceRef: supplied[field]?.sourceRef ?? null,
    },
  ]));
  return {
    ...args,
    actor: source,
    source,
    confirmedFields: [],
    fieldProvenance,
  };
}

function attributedInterviewDebrief(args, source) {
  const fieldProvenance = args.fieldProvenance && typeof args.fieldProvenance === 'object'
    ? Object.fromEntries(Object.entries(args.fieldProvenance).map(([field, entry]) => [
      field,
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...entry, source }
        : entry,
    ]))
    : args.fieldProvenance;
  return { ...args, source, fieldProvenance };
}

function enforcePolicy(name, args, options) {
  const source = mediationSource(options);
  if (HUMAN_MEMORY_MUTATIONS.has(name) && !['cli', 'tui'].includes(source)) {
    throw new DomainToolError(
      'human_memory_input_required',
      HUMAN_MEMORY_INPUT_MESSAGE,
      { tool: name, source, status: null, externalSideEffect: 'none' },
    );
  }
  if (HUMAN_NETWORK_MUTATIONS.has(name) && !['cli', 'tui'].includes(source)) {
    throw new DomainToolError(
      'human_network_input_required',
      HUMAN_NETWORK_INPUT_MESSAGE,
      { tool: name, source, status: null, externalSideEffect: 'none' },
    );
  }
  if (!['acp', 'mcp'].includes(source)) return;
  if (HUMAN_INTERVIEW_MUTATIONS.has(name)) {
    throw new DomainToolError(
      'human_interview_input_required',
      HUMAN_INTERVIEW_INPUT_MESSAGE,
      { tool: name, source, status: null, externalSideEffect: 'none' },
    );
  }
  if (name === 'create_memory_proposal'
    && (args.proposal?.ruleType === 'approved_exemplar' || args.proposal?.scope === 'writing_global')) {
    throw new DomainToolError(
      'human_memory_input_required',
      'Agents cannot designate approved exemplars or globally promote career-memory guidance.',
      { tool: name, source, status: null, externalSideEffect: 'none' },
    );
  }

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

async function validateWithoutWorkspaceWrites(s, operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobos-memory-validation-'));
  try {
    fs.mkdirSync(path.join(root, '.jobos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.jobos', 'jobos.sqlite'), Buffer.from(s.db.export()));
    const isolated = await openStore({ workspace: root });
    try {
      const normalizedPublicPayload = await operation(isolated);
      return {
        schema: 'jobos.career-memory-validation.v1',
        valid: true,
        wouldWrite: false,
        normalizedPublicPayload,
        errors: [],
        externalSideEffects: 'none',
      };
    } finally {
      isolated.db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const recentFailures = [];
  for (const item of runs) {
    if (item.status !== 'failed' && item.status !== 'partial') continue;
    recentFailures.push({
      searchId: item.id,
      searchName: item.actionId || 'discovery',
      status: item.status,
      error: item.error || null,
      message: item.error || (item.status === 'partial' ? 'partial run' : 'failed'),
      startedAt: item.startedAt
    });
  }
  // Prefer structured discovery.run outputs when present on failed automation rows.
  const discoveryRows = all(s, `SELECT id,inputs_json,outputs_json,status,error,started_at,finished_at
    FROM automation_runs
    WHERE action_id IN ('discover.run','daily_discovery') OR trigger_name IN ('discover.run','daily')
    ORDER BY created_at DESC LIMIT 12`);
  for (const row of discoveryRows) {
    if (row.status !== 'failed' && row.status !== 'partial') continue;
    const inputs = parseJson(row.inputs_json, {});
    if (profileId && inputs.profileId && inputs.profileId !== profileId) continue;
    const outputs = parseJson(row.outputs_json, {});
    const failures = Array.isArray(outputs.failures) ? outputs.failures : [];
    if (failures.length) {
      for (const failure of failures.slice(0, 3)) {
        const err = failure.errors?.[0] || {};
        recentFailures.push({
          searchId: failure.searchId || outputs.searchId || row.id,
          searchName: failure.searchName || outputs.searchName || 'search',
          status: failure.status || row.status,
          error: err.message || row.error || null,
          message: err.message || row.error || failure.status || row.status,
          startedAt: row.started_at
        });
      }
    } else if (row.error) {
      recentFailures.push({
        searchId: outputs.searchId || row.id,
        searchName: outputs.searchName || 'discovery',
        status: row.status,
        error: row.error,
        message: row.error,
        startedAt: row.started_at
      });
    }
  }
  return {
    searches,
    runs,
    recentFailures: recentFailures.slice(0, 8),
    sampleOfflineSearch: {
      name: 'Sample offline Greenhouse',
      adapter: 'greenhouse',
      note: 'Enter in discovery overlay when no searches exist'
    },
    browser: 'optional',
    externalSideEffects: 'off_by_default'
  };
}

export function profileAgentContext(s, profileId) {
  const profile = one(s, 'SELECT id,name FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw new DomainToolError('unknown_profile', `Unknown profile: ${profileId}`, { profileId });
  const resume = one(s, `SELECT r.id,r.revision,r.document_json,r.verification_status,r.reviewed_at,
      i.source_format,i.source_name
    FROM profile_resume_revisions r
    LEFT JOIN resume_source_imports i ON i.resume_id=r.id
    WHERE r.profile_id=? AND r.is_current=1`, [profileId]);
  const document = parseJson(resume?.document_json, null);
  const verifiedProofs = all(s, `SELECT id,summary,evidence,source,updated_at
    FROM proof_points
    WHERE profile_id=? AND status='active' AND verification_status='verified'
    ORDER BY created_at,id`, [profileId]).map(row => ({
    id: row.id,
    summary: row.summary,
    evidence: row.evidence,
    source: row.source,
    verifiedAt: row.updated_at || null
  }));
  const jobCount = Number(one(s, 'SELECT COUNT(*) AS count FROM jobs WHERE profile_id=?', [profileId])?.count || 0);
  return {
    version: 1,
    profile: { id: profile.id, name: profile.name, jobCount },
    resumeUpload: resume ? {
      id: resume.id,
      revision: Number(resume.revision),
      sourceFormat: resume.source_format || 'text',
      sourceName: resume.source_name || 'resume',
      verificationStatus: resume.verification_status,
      reviewedAt: resume.reviewed_at || null,
      summary: document?.summary?.text || '',
      experience: (document?.experience || []).map(item => ({
        title: item.title || '',
        employer: item.employer || '',
        startDate: item.startDate || item.dateSource?.startText || null,
        endDate: item.endDate || item.dateSource?.endText || null
      })),
      skills: (document?.skills || []).map(item => item?.name || String(item)).filter(Boolean)
    } : null,
    verifiedProofs,
    privacy: {
      rawResumeTextIncluded: false,
      contactDetailsIncluded: false,
      onlyVerifiedProofsIncluded: true
    }
  };
}

export function selectedJobContext(s, jobId, profileId) {
  const profileContext = profileAgentContext(s, profileId);
  const job = one(s, `SELECT jobs.*,applications.id AS application_id,applications.status AS application_status
    FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id
    WHERE jobs.id=? AND jobs.profile_id=?`, [jobId, profileId]);
  if (!job) throw new DomainToolError('unknown_job', `Unknown job for profile ${profileId}: ${jobId}`, { jobId, profileId });
  const fitData = fitForRow(job);
  const taskRows = all(s, `SELECT * FROM tasks WHERE job_id=? AND profile_id=? AND status='open'
    ORDER BY CASE action_kind WHEN 'application_next_action' THEN 0 ELSE 1 END,
      due_at IS NULL,due_at,created_at,id LIMIT 8`, [jobId, profileId]);
  const tasks = taskRows.map(row => taskView(row));
  const nextAction = tasks.find(task => task.schema === 'jobos.lifecycle-next-action.v1') || null;
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
    profile: profileContext.profile,
    resumeUpload: profileContext.resumeUpload,
    verifiedProofs: profileContext.verifiedProofs,
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
    },
    postingLiveness: getPostingLiveness(job),
    fit: fitData ? {
      ...fitData,
      highFit: Boolean(job.high_fit) && qualifiesForHighFit(fitData, 0)
    } : null,
    nextAction,
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
    },
    privacy: profileContext.privacy
  };
}

export async function callDomainTool(s, name, args = {}, options = {}) {
  const tool = DOMAIN_TOOLS.find(item => item.name === name);
  if (!tool) throw new DomainToolError('unknown_domain_tool', `Unknown JobOS domain tool: ${name}`, { name });
  enforcePolicy(name, args, options);

  const memorySource = mediationSource(options);
  const memoryNow = () => new Date().toISOString();
  const ensureMemoryOwner = result => {
    if (result.profileId !== args.profileId) {
      throw new DomainToolError('memory_profile_mismatch', 'Career-memory evidence belongs to a different profile.', { profileId: args.profileId });
    }
    return result;
  };
  if (name === 'list_memory_observations') return listMemoryObservations(s, {
    profileId: args.profileId,
    sinceDays: args.sinceDays === undefined ? 365 : args.sinceDays,
    types: args.types || null,
    includeHistory: Boolean(args.includeHistory),
    includePrivateNotes: false,
  });
  if (name === 'list_memory_proposals') return listMemoryProposals(s, {
    profileId: args.profileId,
    statuses: args.statuses || null,
    domain: args.domain || null,
    scope: args.scope || null,
    includeEvidence: args.includeEvidence !== false,
  });
  if (name === 'get_career_brief' || name === 'get_voice_positioning_guide') {
    if (args.refresh === true && !['cli', 'tui'].includes(memorySource)) {
      throw new DomainToolError('human_memory_input_required', 'Refreshing a persisted career-memory projection requires trusted CLI or TUI input.', { tool: name, source: memorySource, status: null, externalSideEffect: 'none' });
    }
    const projectionArgs = {
      profileId: args.profileId,
      revision: args.revision ?? null,
      refresh: args.refresh === true,
      asOf: args.asOf ? new Date(args.asOf) : new Date(),
    };
    return name === 'get_career_brief'
      ? getCareerBrief(s, projectionArgs)
      : getVoicePositioningGuide(s, { ...projectionArgs, artifactType: args.artifactType || null });
  }
  if (name === 'retrieve_career_memory') return retrieveCareerMemory(s, {
    profileId: args.profileId,
    consumer: args.consumer,
    jobId: args.jobId || null,
    artifactType: args.artifactType || null,
    asOf: args.asOf ? new Date(args.asOf) : new Date(),
  });
  if (name === 'derive_memory_proposals') return deriveMemoryProposals(s, {
    profileId: args.profileId,
    asOf: args.asOf ? new Date(args.asOf) : new Date(),
    dryRun: Boolean(args.dryRun),
    source: 'deterministic',
  });
  if (name === 'create_memory_proposal') {
    const operation = store => ensureMemoryOwner(createMemoryProposal(store, args.proposal));
    const validation = await validateWithoutWorkspaceWrites(s, operation);
    return args.validateOnly ? validation : operation(s);
  }
  if (name === 'record_job_feedback') {
    const operation = store => recordJobFeedback(store, {
      profileId: args.profileId, jobId: args.jobId, input: args.feedback,
      actor: 'user', source: memorySource,
    });
    return args.validateOnly ? await validateWithoutWorkspaceWrites(s, operation) : operation(s);
  }
  if (name === 'correct_memory_observation') {
    const operation = store => correctMemoryObservation(store, {
      profileId: args.profileId, observationId: args.observationId,
      replacement: args.replacement, reason: args.reason,
      referenceId: args.replacement?.referenceId || `correction:${args.observationId}:${memoryNow()}`,
      actor: 'user', source: memorySource,
      occurredAt: args.replacement?.occurredAt || memoryNow(),
    });
    return args.validateOnly ? await validateWithoutWorkspaceWrites(s, operation) : operation(s);
  }
  if (name === 'undo_memory_observation') return undoMemoryObservation(s, {
    profileId: args.profileId, observationId: args.observationId,
    referenceId: args.referenceId, reason: args.reason,
    actor: 'user', source: memorySource, occurredAt: memoryNow(),
  });
  if (['accept_memory_proposal', 'reject_memory_proposal', 'revoke_memory_proposal'].includes(name)) {
    return transitionMemoryProposal(s, {
      profileId: args.profileId, proposalId: args.proposalId,
      action: name.split('_')[0], reason: args.reason || '', referenceId: args.referenceId,
      actor: 'user', source: memorySource,
    });
  }
  if (name === 'undo_memory_transition') return undoMemoryTransition(s, {
    profileId: args.profileId, transitionId: args.transitionId,
    referenceId: args.referenceId, reason: args.reason,
    actor: 'user', source: memorySource,
  });

  if (name === 'list_jobs') return listJobSummaries(s, args);
  if (name === 'get_job_context') return selectedJobContext(s, args.jobId, args.profileId);
  if (name === 'review_queue') return reviewQueue(s, args);
  if (name === 'diff_artifact') return diffArtifact(s, args.artifactId, { againstArtifactId: args.againstArtifactId || null });
  if (name === 'approve_artifact') return approveArtifact(s, args.artifactId, { reviewedBy: mediationSource(options), note: args.note || '' });
  if (name === 'reject_artifact') return rejectArtifact(s, args.artifactId, { reviewedBy: mediationSource(options), note: args.note || '' });
  if (name === 'discovery_health') return discoveryHealth(s, args);
  if (name === 'score_job') return await score(s, args.jobId, args.profileId);
  if (name === 'tailor_resume') return await tailor(s, args.jobId, args.profileId, 'resume', { layoutProfileId: args.layoutProfileId, pageSize: args.pageSize, pageLimit: args.pageLimit, density: args.density, format: args.format, sectionOrder: args.sectionOrder });
  if (name === 'draft_cover_letter') return await tailor(s, args.jobId, args.profileId, 'cover', { pageSize: args.pageSize, pageLimit: args.pageLimit, format: args.format });
  if (name === 'research_company') return await researchCompany(s, args.jobId);
  if (name === 'find_person') {
    const trusted = ['cli', 'tui'].includes(mediationSource(options));
    return findPersonByEmail(s, args.email, { revealContacts: trusted })
      || { person: null, ...(trusted ? { contacts: [] } : { contactSummary: { count: 0, types: [], tiers: {} } }), edges: [] };
  }
  if (name === 'start_people_research') {
    const runId = createResearchRun(s, {
      profileId: args.profileId,
      scope: args.scope,
      jobId: args.jobId || undefined,
      company: args.company || undefined,
      role: args.role || undefined,
      personId: args.personId || undefined,
      email: args.email || undefined,
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
  if (name === 'network_opportunities_list') return networkOpportunitiesList(s, {
    profileId: args.profileId,
    limit: args.limit == null ? 25 : args.limit,
    asOf: args.asOf ? new Date(args.asOf) : new Date(),
  });
  if (name === 'network_graph_query') return networkGraphQuery(s, {
    profileId: args.profileId,
    jobId: args.jobId || null,
    personId: args.personId || null,
    maxHops: args.maxHops == null ? 2 : args.maxHops,
  });
  if (name === 'network_health_brief') return networkHealthBrief(s, {
    profileId: args.profileId,
    asOf: args.asOf ? new Date(args.asOf) : new Date(),
  });
  if (name === 'network_contact_record') {
    const source = trustedNetworkSource(options);
    return recordNetworkContact(s, {
      profileId: args.profileId,
      personId: args.personId,
      contactPointId: args.contactPointId || null,
      occurredAt: args.occurredAt ? new Date(args.occurredAt) : new Date(),
      warmth: args.warmth || null,
      note: args.note || '',
      source,
    });
  }
  if (name === 'draft_outreach') {
    if (!(args.jobId && args.stakeholderId) && !args.planId) {
      throw new DomainToolError('draft_outreach_missing_target', 'draft_outreach requires a jobId+stakeholderId or a planId', { args });
    }
    return await draftOutreach(s, { jobId: args.jobId || null, stakeholderId: args.stakeholderId || null, profileId: args.profileId, goal: args.goal || null, planId: args.planId || null, contactId: args.contactId || null });
  }
  if (name === 'mark_outreach_sent') return markOutreachSent(s, { artifactId: args.artifactId, channel: args.channel, notes: args.notes || '' });
  if (name === 'schedule_outreach_followup') return scheduleFollowup(s, { threadId: args.threadId, afterDays: args.afterDays });
  if (name === 'list_outreach_due') return outreachDue(s);
  if (name === 'record_outreach_outcome') return recordOutreachOutcome(s, {
    threadId: args.threadId,
    profileId: args.profileId,
    type: args.type,
    occurredAt: args.occurredAt,
    windowEndAt: args.windowEndAt || null,
    channel: args.channel || null,
    referenceId: args.referenceId || '',
    supersedesOutcomeId: args.supersedesOutcomeId || null,
    correctionReason: args.correctionReason || '',
    actor: mediationSource(options),
    source: 'domain_tool'
  }, { includeNotes: false });
  if (name === 'list_outreach_outcomes') return listOutreachOutcomes(s, {
    profileId: args.profileId,
    sinceDays: args.sinceDays == null ? null : args.sinceDays,
    includeNotes: false
  });
  if (name === 'create_application') {
    const provenance = mediationSource(options);
    const application = appCreate(s, args.jobId, args.status, args.notes || '', { actor: provenance, source: 'domain_tool' });
    return { ...application, nextAction: application.nextAction, researchRecommendation: application.researchRecommendation };
  }
  if (name === 'applications_plan') return planApplication(s, { jobId: args.jobId, profileId: args.profileId });
  if (name === 'update_application_status') {
    const provenance = mediationSource(options);
    const application = appUpdate(s, args.applicationId, args.status, args.notes ?? null, { actor: provenance, source: 'domain_tool' });
    return { ...application, nextAction: application.nextAction, researchRecommendation: application.researchRecommendation };
  }
  if (name === 'list_tasks') return openTasks(s, {
    profileId: args.profileId,
    type: args.type || null,
    createdBy: args.createdBy || null,
  }).map(row => taskView(row));
  if (name === 'lifecycle_analytics') return lifecycleAnalytics(s, {
    profileId: args.profileId,
    sinceDays: args.sinceDays ?? 30,
  });
  if (name === 'list_lifecycle_observations') return listLifecycleObservations(s, {
    profileId: args.profileId,
    sinceDays: args.sinceDays ?? 30,
  });
  if (name === 'list_interview_stories') return listInterviewStories(s, {
    profileId: args.profileId,
    includeHistory: Boolean(args.includeHistory),
  });
  if (name === 'get_interview_story') return getInterviewStory(s, {
    profileId: args.profileId,
    storyId: args.storyId,
    includeHistory: Boolean(args.includeHistory),
  });
  if (name === 'draft_interview_story') return createInterviewStory(
    s,
    attributedInterviewDraft(args, options),
  );
  if (name === 'verify_interview_story') {
    const source = trustedInterviewSource(options);
    return verifyInterviewStory(s, {
      profileId: args.profileId,
      storyId: args.storyId,
      revision: args.revision,
      confirmedFields: args.confirmedFields,
      actor: args.actor,
      source,
    });
  }
  if (name === 'retire_interview_story') {
    const source = trustedInterviewSource(options);
    return retireInterviewStory(s, {
      profileId: args.profileId,
      storyId: args.storyId,
      reason: args.reason,
      actor: args.actor,
      source,
    });
  }
  if (name === 'add_interview_question_source') {
    const source = trustedInterviewSource(options);
    return createInterviewQuestionSource(s, {
      ...args,
      jobId: undefined,
      source,
    });
  }
  if (name === 'interview_prep') return await prepInterview(
    s,
    args.applicationId,
    args.stage || 'interview',
    { audience: args.audience || undefined },
  );
  if (name === 'record_interview_debrief') {
    const source = trustedInterviewSource(options);
    return recordInterviewDebrief(s, {
      ...attributedInterviewDebrief(args, source),
      jobId: undefined,
      debriefId: undefined,
      targetRevision: undefined,
      reason: undefined,
    });
  }
  if (name === 'correct_interview_debrief') {
    const source = trustedInterviewSource(options);
    const current = getInterviewDebrief(s, {
      profileId: args.profileId,
      debriefId: args.debriefId,
      includeHistory: false,
    });
    return correctInterviewDebrief(s, {
      ...attributedInterviewDebrief(args, source),
      profileId: current.profileId,
      debriefId: current.id,
      jobId: current.jobId,
      applicationId: current.applicationId,
      interviewStage: current.interviewStage,
      audience: current.audience,
      referenceId: current.referenceId,
      targetRevision: args.targetRevision,
      reason: args.reason,
    });
  }
  if (name === 'list_interview_debriefs') return listInterviewDebriefs(s, {
    profileId: args.profileId,
    applicationId: args.applicationId || null,
    includeHistory: Boolean(args.includeHistory),
  });
  if (name === 'list_interview_observations') return listInterviewObservations(s, {
    profileId: args.profileId,
    sinceDays: args.sinceDays ?? null,
  });
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
    expectedAdapterHash: args.expectedAdapterHash || null,
    protectRequests: options.protectRequests !== false
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
      expectedAdapterHash: args.expectedAdapterHash || null,
      protectRequests: options.protectRequests !== false
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
      expectedAdapterHash: args.expectedAdapterHash || null,
      protectRequests: options.protectRequests !== false
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
