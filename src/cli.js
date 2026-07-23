#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { all, audit, one, openStore, reload, save } from './db.js';
import { id, parseJson, paths, splitCsv, workspaceRoot } from './utils.js';
import { createProfile, addProof, retireProof, setNetworkIntent, supersedeProof, verifyProof } from './profiles.js';
import { getResume, importResume, replaceResume, validateResumeDocument } from './resumes.js';
import { buildRequirementCoverage, inventoryForJob } from './requirements.js';
import { dedupeJobs, importText, importUrl } from './jobs.js';
import { tailor } from './tailoring.js';
import { appCreate, appUpdate, due, openTasks, recommendResearch } from './tracking.js';
import { addStakeholder, researchCompany } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan, promoteStakeholder, suppressContact } from './research/contacts.js';
import { importNetworkCsv } from './research/network.js';
import { createResearchRun, executeResearchRun, getResearchRun, resumeResearchRun, requestCancelResearchRun } from './research/runs.js';
import { funnel, renderFunnelMarkdown, resumeFeedback, weekly } from './analytics.js';
import { listOutreachOutcomes, recordOutreachOutcome } from './outreach-outcomes.js';
import { prepInterview } from './interview.js';
import { startMcp } from './mcp.js';
import { configFromFlags, createCompanySearch, createSearch, listSearches, listWatchlist, migrateLegacyWatchlist, runAllSearches, runSavedSearch } from './discovery.js';
import { createAutomation, listAutomations, setAutomationEnabled } from './scheduler/store.js';
import { recentRuns, runAutomation, runAutomationByName, runDueAutomations, schedulerStatus, startScheduler } from './scheduler/core.js';
import { addAnswer, listAnswers } from './answers.js';
import { listNetworkContacts, listNetworkEdges } from './workflows.js';
import { addAgent, listAgents, testAgent } from './agents.js';
import { callDomainTool } from './domain-tools.js';
import { authenticatedFetch, browserStatus, exportCookies, importCookies, loginPersistentProfile, registerScript, runRegisteredScript } from './browser.js';
import { preflightResumeArtifact } from './artifacts.js';

const globalFlags = [
  '--workspace <dir>',
  '--profile <profile-id>',
  '--json',
  '--quiet',
  '--help',
  '--agent <name>',
  '--all (help only)'
];

function cmd(pathParts, usage, summary, opts = {}) {
  return {
    path: pathParts,
    name: pathParts.join(' '),
    usage,
    summary,
    json: opts.json ?? true,
    output: opts.output || 'object',
    flags: opts.flags || [],
    tests: opts.tests || ['tests/sprint9-frontend.test.js'],
    category: opts.category || 'advanced',
    audience: opts.audience || 'all',
    relatedWorkflow: opts.relatedWorkflow || null,
    workflowStage: opts.workflowStage || null,
    runsDependencies: opts.runsDependencies ?? null,
    deprecated: opts.deprecated || null,
  };
}

export const commandRegistry = [
  cmd(['init'], 'jobos init [--json]', 'Create or verify the local database and agent-readable workspace.'),
  cmd(['agent-guide'], 'jobos agent-guide [--json]', 'Print the machine-oriented guide for external agents.'),
  cmd(['tui'], 'jobos tui [--profile <profile-id>] [--agent off] [--snapshot] [--width 140] [--height 42] [--json]', 'Open the locked data-bound terminal product shell with an embedded ACP agent pane.', { flags: ['--agent off', '--snapshot', '--width <columns>', '--height <rows>'], category: 'workflow' }),
  cmd(['daily'], 'jobos daily --profile <profile-id> [--json]', 'Run every saved discovery source for a profile and rank the combined results.', { category: 'workflow' }),
  cmd(['pursue'], 'jobos pursue <job-id> --profile <profile-id> [--agent <name>] [--stage score|company|people-research|questions|resume|cover-letter|application|outreach] [--dry-run] [--json]', 'Run the primary integrated fit, research, application-preparation, and outreach-planning workflow.', { flags: ['--stage score|company|people-research|questions|resume|cover-letter|application|outreach', '--stage-timeout <ms>', '--dry-run'], category: 'workflow', runsDependencies: true }),
  cmd(['profile', 'create'], 'jobos profile create <name> [--from-resume file] [--json]', 'Create a target profile and optionally import resume proof text.', { flags: ['--from-resume <file>', '--preferences <json>'] }),
  cmd(['profile', 'network-intent'], 'jobos profile network-intent --profile <profile-id> --file <json> [--json]', 'Confirm progressive networking goals, exclusions, sources, and affiliations.', { flags: ['--profile <profile-id>', '--file <json>'] }),
  cmd(['resume', 'import'], 'jobos resume import --profile <profile-id> --file <path> [--json]', 'Import a complete resume into a versioned canonical source record.', { flags: ['--profile <profile-id>', '--file <path>'] }),
  cmd(['resume', 'show'], 'jobos resume show --profile <profile-id> [--revision <n>] [--json]', 'Inspect the current or historical canonical resume revision.', { flags: ['--profile <profile-id>', '--revision <n>'] }),
  cmd(['resume', 'validate'], 'jobos resume validate --profile <profile-id> [--json]', 'Validate the current canonical resume and expose correctable fields.', { flags: ['--profile <profile-id>'] }),
  cmd(['resume', 'coverage'], 'jobos resume coverage --job <job-id> --profile <profile-id> [--json]', 'Show transparent requirement coverage from active verified evidence.', { flags: ['--job <job-id>', '--profile <profile-id>'] }),
  cmd(['resume', 'preflight'], 'jobos resume preflight --artifact <artifact-id> [--json]', 'Recheck semantic, exact-revision, and requested render eligibility without mutating review state.', { flags: ['--artifact <artifact-id>'] }),
  cmd(['resume', 'replace'], 'jobos resume replace --profile <profile-id> --file <json-or-yaml> [--json]', 'Create a corrected canonical resume revision without rewriting history.', { flags: ['--profile <profile-id>', '--file <path>'] }),
  cmd(['proof', 'add'], 'jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b] [--json]', 'Add an evidence-backed proof point to a profile.', { flags: ['--summary <text>', '--evidence <text>', '--skills a,b'] }),
  cmd(['proof', 'verify'], 'jobos proof verify <proof-id> [--json]', 'Verify a stored proof point for generated factual claims.'),
  cmd(['proof', 'retire'], 'jobos proof retire <proof-id> --reason <text> [--json]', 'Retire a proof point while preserving its lineage.', { flags: ['--reason <text>'] }),
  cmd(['proof', 'replace'], 'jobos proof replace <proof-id> --summary <text> [--evidence <text>] [--skills a,b] [--json]', 'Supersede a proof point with a corrected active revision.', { flags: ['--summary <text>', '--evidence <text>', '--skills a,b'] }),
  cmd(['answers', 'add'], 'jobos answers add --profile <profile-id> --category <category> --question <text> --answer <text> [--sensitivity personal] [--json]', 'Store a verified reusable application answer locally.', { flags: ['--category <category>', '--question <text>', '--answer <text>', '--sensitivity <class>', '--reuse <scope>', '--status <status>', '--source <ref>', '--employer <name>'] }),
  cmd(['answers', 'list'], 'jobos answers list --profile <profile-id> [--category <category>] [--json]', 'List local answers with sensitive values redacted.', { flags: ['--category <category>', '--status <status>'] }),
  cmd(['answers', 'match'], 'jobos answers match --profile <profile-id> --questions <json-file> [--employer <name>] [--json]', 'Match verified non-sensitive answers to application questions.', { flags: ['--questions <json-file>', '--employer <name>'] }),
  cmd(['jobs', 'import-text'], 'jobos jobs import-text --profile <profile> --file <path> [--json]', 'Import a job description from a local text or Markdown file.', { flags: ['--file <path>'] }),
  cmd(['jobs', 'import-url'], 'jobos jobs import-url <url> --profile <profile> [--json]', 'Import a human-provided public job URL.'),
  cmd(['jobs', 'list'], 'jobos jobs list [--json]', 'List imported jobs.'),
  cmd(['jobs', 'dedupe'], 'jobos jobs dedupe [--apply] [--json]', 'Find likely duplicate jobs and optionally apply local dedupe updates.', { flags: ['--apply'] }),
  cmd(['searches', 'create'], 'jobos searches create <name> --profile <profile> --adapter greenhouse|lever|ashby|career-page|portfolio [--board-token token|--company handle|--url URL] [--keywords a,b] [--location remote] [--posted-within-days <n>] [--remote-only] [--employment-types <csv>] [--json]', 'Create a routed public-source discovery search.', { flags: ['--adapter <id>', '--board-token <token>', '--company <handle>', '--handle <handle>', '--url <url>', '--max-companies <n>', '--keywords a,b', '--location <text>', '--posted-within-days <n>', '--remote-only', '--employment-types <csv>', '--min-fit <n>'] }),
  cmd(['searches', 'list'], 'jobos searches list [--json]', 'List saved discovery searches.'),
  cmd(['searches', 'migrate-watchlist'], 'jobos searches migrate-watchlist --profile <profile> [--min-fit <n>] [--json]', 'Migrate legacy profile-less watchlist rows into executable saved searches for one profile.', { flags: ['--profile <profile>', '--min-fit <n>'] }),
  cmd(['watchlist', 'add'], 'jobos watchlist add --profile <profile> --company <company> --adapter greenhouse|lever --board-token <token>|--handle <handle> [--notes text] [--json]', 'Deprecated alias: create an executable company saved-search preset.', { deprecated: 'Use searches create with a company/ATS target.', relatedWorkflow: 'daily' }),
  cmd(['watchlist', 'list'], 'jobos watchlist list [--json]', 'Compatibility view of legacy watchlist rows and canonical company-search presets.', { deprecated: 'Use searches list.' }),
  cmd(['discover', 'run'], 'jobos discover run --search <name-or-id> [--json]', 'Run one saved discovery search and queue results for review.'),
  cmd(['discover', 'run-all'], 'jobos discover run-all [--profile <profile>] [--json]', 'Advanced raw execution of all saved searches; returns per-search runs without the daily workflow\'s cross-run dedupe or combined ranked report.', { relatedWorkflow: 'daily' }),
  cmd(['score'], 'jobos score <job-id> --profile <profile> [--json]', 'Advanced standalone scoring operation; runs only scoring without pursue dependencies.', { relatedWorkflow: 'pursue', workflowStage: 'score', runsDependencies: false }),
  cmd(['tailor', 'resume'], 'jobos tailor resume --job <job-id> --profile <profile> [--layout professional|technical|leadership] [--page-size letter|a4] [--page-limit 1|2] [--format markdown|pdf] [--output markdown] [--json]', 'Advanced standalone resume operation; creates a complete proof-grounded tailored resume draft with optional local PDF rendering without pursue dependencies.', { flags: ['--layout <profile>', '--page-size <size>', '--page-limit <n>', '--format <format>'], output: 'object-or-markdown', relatedWorkflow: 'pursue', workflowStage: 'resume', runsDependencies: false }),
  cmd(['tailor', 'cover-letter'], 'jobos tailor cover-letter --job <job-id> --profile <profile> [--output markdown] [--json]', 'Advanced standalone cover-letter operation; creates a new evidence-grounded draft revision without pursue dependencies.', { output: 'object-or-markdown', relatedWorkflow: 'pursue', workflowStage: 'cover-letter', runsDependencies: false }),
  cmd(['artifacts', 'queue'], 'jobos artifacts queue [--profile <profile-id>] [--job <job-id>] [--json]', 'List only current pending artifact revisions awaiting trusted human review.', { flags: ['--profile <profile-id>', '--job <job-id>'], category: 'workflow' }),
  cmd(['artifacts', 'diff'], 'jobos artifacts diff <artifact-id> [--against <artifact-id>] [--json]', 'Inspect the exact current artifact revision and its line diff.', { flags: ['--against <artifact-id>'], category: 'workflow' }),
  cmd(['artifacts', 'approve'], 'jobos artifacts approve <artifact-id> [--note <text>] [--json]', 'Record local human approval of an exact current artifact revision without submitting.', { flags: ['--note <text>'], category: 'workflow' }),
  cmd(['artifacts', 'reject'], 'jobos artifacts reject <artifact-id> --note <reason> [--json]', 'Reject an exact current artifact revision and require a new draft.', { flags: ['--note <reason>'], category: 'workflow' }),
  cmd(['applications', 'plan'], 'jobos applications plan --job <job-id> --profile <profile-id> [--json]', 'Compile review readiness from local score, proofs, materials, answers, and identity evidence.', { flags: ['--job <job-id>'], category: 'workflow' }),
  cmd(['applications', 'create'], 'jobos applications create --job <job-id> --status <status> [--json]', 'Create or upsert a local application tracking record.'),
  cmd(['applications', 'update'], 'jobos applications update <application-id> --status <status> [--json]', 'Update a tracked application status.'),
  cmd(['apply', 'packet', 'create'], 'jobos apply packet create --job <job-id> --profile <profile-id> [--json]', 'Freeze current approved materials, answers, and target into one immutable application packet.', { flags: ['--job <job-id>', '--profile <profile-id>'], category: 'workflow' }),
  cmd(['apply', 'packet', 'show'], 'jobos apply packet show <packet-id> [--json]', 'Show one application packet with artifact hashes, redacted answers, identity, readiness snapshot, currency, receipt state, and secret-safe receipt metadata.', { category: 'workflow' }),
  cmd(['apply', 'packet', 'list'], 'jobos apply packet list (--job <job-id> | --profile <profile-id>) [--json]', 'List application packets for a job/profile with derived currency and receipt state.', { flags: ['--job <job-id>', '--profile <profile-id>'], category: 'workflow' }),
  cmd(['apply', 'packet', 'diff'], 'jobos apply packet diff <packet-a> <packet-b> [--json]', 'Diff two application packets by their canonical projections.', { category: 'workflow' }),
  cmd(['apply', 'form', 'inspect'], 'jobos apply form inspect --job <job-id> --profile <profile-id> --url <https-url> [--browser-profile <name>] [--adapter-hash <sha256>] [--json]', 'Inspect a live employer form read-only and persist a secret-safe form snapshot.', { flags: ['--job <job-id>', '--profile <profile-id>', '--url <https-url>', '--browser-profile <name>', '--adapter-hash <sha256>'], category: 'workflow' }),
  cmd(['apply', 'form', 'show'], 'jobos apply form show <snapshot-id> [--json]', 'Show one persisted secret-safe live-form snapshot.', { category: 'workflow' }),
  cmd(['apply', 'form', 'assist'], 'jobos apply form assist <packet-id> [--browser-profile <name>] --allow-side-effects [--json]', 'Fill exact safe packet-bound fields, read them back, and pause before submission.', { flags: ['--browser-profile <name>', '--allow-side-effects'], category: 'workflow' }),
  cmd(['apply', 'form', 'checkpoint'], 'jobos apply form checkpoint <packet-id> --fill-run <fill-run-id> [--confirm-fields <field-key,...>] [--json]', 'Accept the trusted human checkpoint after reviewing read-back and every manual field.', { flags: ['--fill-run <fill-run-id>', '--confirm-fields <field-key,...>'], category: 'workflow' }),
  cmd(['apply', 'form', 'submit'], 'jobos apply form submit <packet-id> --checkpoint <checkpoint-id> [--browser-profile <name>] --allow-submit [--json]', 'Perform one exact configured submission after all packet, form, checkpoint, and policy gates pass.', { flags: ['--checkpoint <checkpoint-id>', '--browser-profile <name>', '--allow-submit'], category: 'workflow' }),
  cmd(['apply', 'attest-submitted'], 'jobos apply attest-submitted <packet-id> --submitted-at <rfc3339> [--note <text>] [--json]', 'Record trusted local human submission attestation for an exact packet.', { flags: ['--submitted-at <rfc3339>', '--note <text>'], category: 'workflow' }),
  cmd(['apply', 'confirm-receipt'], 'jobos apply confirm-receipt <packet-id> --reference <text> [--note <text>] [--json]', 'Record an external reference confirming receipt of a submitted application.', { flags: ['--reference <text>', '--note <text>'], category: 'workflow' }),
  cmd(['research', 'company'], 'jobos research company --job <job-id> [--json]', 'Advanced standalone company-research operation; runs without pursue dependencies.', { relatedWorkflow: 'pursue', workflowStage: 'company', runsDependencies: false }),
  cmd(['research', 'people'], 'jobos research people --profile <profile-id> --scope profile|target|job|person [--job <job-id>] [--company <name>] [--role <name>] [--person <person-id>|--name <name> --source-url <url>] [--depth standard|deep] [--sources csv] [--max-cost-usd n] [--json]', 'Run bounded, source-backed people research to a durable terminal state.', { flags: ['--profile <profile-id>', '--scope <scope>', '--job <job-id>', '--company <name>', '--role <name>', '--person <person-id>', '--name <name>', '--source-url <url>', '--depth <depth>', '--sources <csv>', '--max-cost-usd <n>'], category: 'workflow' }),
  cmd(['research', 'runs', 'get'], 'jobos research runs get <run-id> [--json]', 'Read a durable people-research run.'),
  cmd(['research', 'runs', 'resume'], 'jobos research runs resume <run-id> [--json]', 'Resume a paused_retryable people-research run.'),
  cmd(['research', 'runs', 'cancel'], 'jobos research runs cancel <run-id> [--json]', 'Request idempotent cancellation of a people-research run.'),
  cmd(['research', 'approve-contact'], 'jobos research approve-contact --contact <contact-id>|--worksheet-candidate <candidate-id> [--json]', 'Mark a discovered contact point as human-approved for later draft use.', { flags: ['--contact <contact-id>', '--worksheet-candidate <candidate-id>'] }),
  cmd(['research', 'suppress-contact'], 'jobos research suppress-contact --contact <contact-id> --reason <text> [--json]', 'Mark a discovered contact point as do-not-use in local state.', { flags: ['--contact <contact-id>', '--reason <text>'] }),
  cmd(['research', 'promote-stakeholder'], 'jobos research promote-stakeholder --candidate <candidate-id> [--json]', 'Promote a staged person candidate to a local stakeholder record.', { flags: ['--candidate <candidate-id>'] }),
  cmd(['network', 'import'], 'jobos network import --file <csv> [--profile <profile-id>] [--format auto|generic|linkedin] [--json]', 'Import generic edges or a user-exported LinkedIn connections CSV.', { flags: ['--file <csv>', '--profile <profile-id>', '--format <format>'] }),
  cmd(['network', 'paths'], 'jobos network paths --job <job-id> [--json]', 'Rank reachable introduction and advice paths for a job.', { flags: ['--job <job-id>'], category: 'workflow' }),
  cmd(['network', 'contacts'], 'jobos network contacts --job <job-id> [--json]', 'List ranked source-backed contacts for a job.', { flags: ['--job <job-id>'], category: 'workflow' }),
  cmd(['network', 'list'], 'jobos network list [--json]', 'List imported relationship edges.', { category: 'workflow' }),
  cmd(['research', 'add-stakeholder'], 'jobos research add-stakeholder --job <job-id> --source-url <url> [--name <name>] [--role <role>] [--text <text>|--file <path>] [--json]', 'Record a stakeholder from user-provided source text and a required public source URL.', { flags: ['--job <job-id>', '--source-url <url>', '--name <name>', '--role <role>', '--text <text>', '--file <path>'] }),
  cmd(['outreach', 'draft'], 'jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile-id> [--goal informational] [--plan <plan-id>] [--contact <contact-id>] [--json]', 'Advanced standalone outreach drafting operation; does not run pursue dependencies or send anything.', { flags: ['--job <job-id>', '--stakeholder <stakeholder-id>', '--profile <profile-id>', '--goal <goal>', '--plan <plan-id>', '--contact <contact-id>'], relatedWorkflow: 'pursue', workflowStage: 'outreach', runsDependencies: false }),
  cmd(['outreach', 'plan'], 'jobos outreach plan --job <job-id> --profile <profile-id> [--stakeholder <stakeholder-id>] [--goal informational] [--json]', 'Rank a reviewable outreach path from discovered contacts, network edges, and profile evidence.', { flags: ['--job <job-id>', '--profile <profile-id>', '--stakeholder <stakeholder-id>', '--goal <goal>'] }),
  cmd(['outreach', 'mark-sent'], 'jobos outreach mark-sent --artifact <artifact-id> --channel <email|linkedin|other> [--notes text] [--json]', 'Record that a human sent an outreach draft outside JobOS.', { flags: ['--artifact <artifact-id>', '--channel <email|linkedin|other>', '--notes <text>'] }),
  cmd(['outreach', 'schedule-followup'], 'jobos outreach schedule-followup --thread <thread-id> --after <days> [--json]', 'Create a local follow-up task for an outreach thread.', { flags: ['--thread <thread-id>', '--after <days>'] }),
  cmd(['outreach', 'due'], 'jobos outreach due [--json]', 'Show the outreach-thread context for due follow-up tasks; use tasks due --type followup --created-by outreach as the canonical filtered query.'),
  cmd(['outreach', 'outcome', 'record'], 'jobos outreach outcome record --thread <id> --profile <profile-id> --type <type> --occurred-at <rfc3339> [--window-end <rfc3339>] [--channel <channel>] [--note <text>] [--reference <id>] [--supersedes <outcome-id>] [--correction-reason <text>] [--json]', 'Record an explicit local append-only outreach outcome observation; does not infer or cause an external action.', { flags: ['--thread <thread-id>', '--profile <profile-id>', '--type <outcome-type>', '--occurred-at <rfc3339>', '--window-end <rfc3339>', '--channel <channel>', '--note <text>', '--reference <id>', '--supersedes <outcome-id>', '--correction-reason <text>'] }),
  cmd(['outreach', 'outcomes'], 'jobos outreach outcomes --profile <profile-id> [--since <days>] [--json]', 'List profile-scoped outreach outcome observations and correction history.', { flags: ['--profile <profile-id>', '--since <days>'] }),
  cmd(['interview', 'prep'], 'jobos interview prep --application <application-id> --stage <stage> [--output markdown] [--json]', 'Create an interview prep packet.', { output: 'object-or-markdown' }),
  cmd(['analytics', 'funnel'], 'jobos analytics funnel --profile <profile> [--since 30] [--output markdown] [--json]', 'Report funnel analytics for a profile.', { output: 'object-or-markdown' }),
  cmd(['analytics', 'resume-feedback'], 'jobos analytics resume-feedback --profile <profile> [--json]', 'Report recurring proof gaps and uncertainty-gated coverage outcome observations.'),
  cmd(['tasks', 'list'], 'jobos tasks list [--type <type>] [--created-by <source>] [--json]', 'List the open task inbox, including future and undated tasks.', { flags: ['--type <type>', '--created-by <source>'] }),
  cmd(['tasks', 'due'], 'jobos tasks due [--type <type>] [--created-by <source>] [--watch] [--interval N] [--max-iterations N] [--json]', 'Canonical filtered query for open tasks with a non-null due time that has passed, optionally watching on an interval.', { output: 'array-or-jsonl', flags: ['--type <type>', '--created-by <source>', '--watch', '--interval <seconds>', '--max-iterations <n>'] }),
  cmd(['review', 'weekly'], 'jobos review weekly --profile <profile> [--output markdown] [--json]', 'Generate a weekly review export.', { output: 'object-or-markdown' }),
  cmd(['automation', 'create'], 'jobos automation create <name> --action <action-id> --schedule "0 7 * * 1-5" [--profile <profile>] [--enabled] [--json]', 'Create or update a scheduler automation.'),
  cmd(['automation', 'list'], 'jobos automation list [--json]', 'List configured automations.'),
  cmd(['automation', 'enable'], 'jobos automation enable <name> [--json]', 'Enable an automation.'),
  cmd(['automation', 'disable'], 'jobos automation disable <name> [--json]', 'Disable an automation.'),
  cmd(['automation', 'run'], 'jobos automation run <name> [--json]', 'Run one automation through the audited scheduler path.'),
  cmd(['scheduler', 'run-once'], 'jobos scheduler run-once [--json]', 'Run all currently due enabled automations once.'),
  cmd(['scheduler', 'start'], 'jobos scheduler start [--interval 60] [--json]', 'Start the long-running local scheduler loop.', { output: 'jsonl-or-log' }),
  cmd(['scheduler', 'status'], 'jobos scheduler status [--json]', 'Show scheduler lock, automation, and recent run state.'),
  cmd(['runs', 'list'], 'jobos runs list [--limit 25] [--json]', 'List recent automation runs.'),
  cmd(['loop', 'scheduler'], 'jobos loop scheduler [--interval N] [--max-iterations N] [--json]', 'Agent streaming primitive: repeatedly run due scheduler automations with bounded JSONL events.', { output: 'jsonl', category: 'agent-stream', audience: 'agent' }),
  cmd(['loop', 'automation'], 'jobos loop automation <name> [--interval N] [--max-iterations N] [--json]', 'Agent streaming primitive: repeatedly run one persisted named automation.', { output: 'jsonl', category: 'agent-stream', audience: 'agent' }),
  cmd(['loop', 'action'], 'jobos loop action <action-id> [--profile <profile>] [--config JSON] [--interval N] [--max-iterations N] [--json]', 'Agent streaming primitive: repeatedly run one ephemeral scheduler action.', { output: 'jsonl', category: 'agent-stream', audience: 'agent' }),
  cmd(['agents', 'add'], 'jobos agents add <name> --command <executable> [--args <json>] [--transport stdin-json|prompt-arg] [--json]', 'Register a local Codex, Hermes, or compatible agent.', { flags: ['--command <executable>', '--args <json>', '--transport <type>'], category: 'extend' }),
  cmd(['agents', 'list'], 'jobos agents list [--json]', 'List configured and suggested local agents with availability.', { category: 'extend' }),
  cmd(['agents', 'test'], 'jobos agents test <name> [--json]', 'Check one agent executable and structured JSON protocol.', { category: 'extend' }),
  cmd(['browser', 'status'], 'jobos browser status [profile] [--json]', 'Check optional Playwright support and private browser profiles.', { category: 'extend' }),
  cmd(['browser', 'login'], 'jobos browser login <profile> --url <url> [--json]', 'Open a persistent headed browser profile for user login.', { flags: ['--url <url>'], category: 'extend' }),
  cmd(['browser', 'fetch'], 'jobos browser fetch <profile> --url <url> [--selector <css>] [--json]', 'Fetch an authenticated page with a persistent browser profile.', { flags: ['--url <url>', '--selector <css>'], category: 'extend' }),
  cmd(['browser', 'cookies', 'import'], 'jobos browser cookies import <profile> --file <path> [--json]', 'Import cookies or Playwright storage state without printing secrets.', { flags: ['--file <path>'], category: 'extend' }),
  cmd(['browser', 'cookies', 'export'], 'jobos browser cookies export <profile> --file <path> [--json]', 'Export browser session cookies to an explicit private file.', { flags: ['--file <path>'], category: 'extend' }),
  cmd(['browser', 'script', 'add'], 'jobos browser script add <name> --file <module> [--side-effecting] [--json]', 'Register and hash-pin a trusted local Playwright task module.', { flags: ['--file <module>', '--side-effecting'], category: 'extend' }),
  cmd(['browser', 'run'], 'jobos browser run <profile> --url <url> --script <name> [--input <json-file>] [--allow-side-effects] [--json]', 'Run a trusted registered Playwright task against an authenticated page.', { flags: ['--url <url>', '--script <name>', '--input <json-file>', '--allow-side-effects'], category: 'extend' }),
  cmd(['mcp'], 'jobos mcp', 'Start the MCP stdio server for agent clients.', { output: 'mcp-protocol' }),
];

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.type = 'usage';
    this.code = 'usage_error';
    this.exitCode = 2;
  }
}

function usage(message) {
  throw new UsageError(message);
}

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const [name, ...value] = key.split('=');
        out.flags[name] = value.join('=');
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out.flags[key] = argv[++i];
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function commandFor(parts) {
  return commandRegistry.find(c => c.path.length === parts.length && c.path.every((p, i) => p === parts[i])) || null;
}

function renderRootHelp({ allCommands = false } = {}) {
  const primaryNames = new Set(['init', 'profile create', 'tui', 'daily', 'pursue', 'jobs list', 'network paths', 'agents list', 'browser status']);
  const primary = commandRegistry.filter(command => primaryNames.has(command.name));
  const section = (title, names) => `${title}:\n${names.map(command => `  ${command.usage}\n      ${command.summary}`).join('\n')}`;
  const setup = primary.filter(command => ['init', 'profile create'].includes(command.name));
  const workflows = primary.filter(command => ['tui', 'daily', 'pursue', 'jobs list', 'network paths'].includes(command.name));
  const extend = primary.filter(command => ['agents list', 'browser status'].includes(command.name));
  const advanced = allCommands ? `\n\nAdvanced commands:\n${commandRegistry.filter(command => !primaryNames.has(command.name)).map(command => `  ${command.usage}`).join('\n')}` : '\n\nRun "jobos help --all" for every low-level command.';
  return `JobOS — local-first agent-native terminal product and composable CLI

Usage:
  jobos <command> [flags]

Use \`tui\` for interactive work; use \`daily\` and \`pursue\` for scripted workflows.

${section('Setup', setup)}

${section('Workflows', workflows)}

${section('Extend', extend)}${advanced}

Global flags:
  ${globalFlags.join('\n  ')}

Run \"jobos <command> --help\" for command-specific help.`;
}

function renderCommandHelp(parts) {
  const command = commandFor(parts);
  if (!command) usage(`Unknown command for help: ${parts.join(' ')}`);
  const flags = [...globalFlags, ...command.flags];
  return `JobOS command: ${command.name}

Summary:
  ${command.summary}

Usage:
  ${command.usage}

Output:
  ${command.output}

JSON:
  ${command.json ? 'Supports --json for machine-readable output.' : 'Uses its own protocol.'}

Flags:
  ${flags.join('\n  ')}`;
}

function registryJson() {
  return {
    version: 3,
    architecture: {
      role: 'jobos-host',
      interactive: 'tui',
      guestProtocol: 'acp-v1',
      primaryGuest: 'hermes-acp',
      sessionTools: 'mcp',
      externalToolDoor: 'jobos mcp',
      sourceOfTruth: 'local-sqlite-and-workspace',
      sideEffects: 'default-off'
    },
    globalFlags,
    exitCodes: { success: 0, runtimeError: 1, usageError: 2 },
    commands: commandRegistry.map(c => ({
      name: c.name,
      path: c.path,
      usage: c.usage,
      summary: c.summary,
      json: c.json,
      output: c.output,
      flags: c.flags,
      category: c.category,
      audience: c.audience,
      relatedWorkflow: c.relatedWorkflow,
      workflowStage: c.workflowStage,
      runsDependencies: c.runsDependencies,
      deprecated: c.deprecated,
      tests: c.tests
    }))
  };
}

function renderAgentGuide() {
  const categoryOrder = ['workflow', 'advanced', 'agent-stream', 'extend'];
  const commands = categoryOrder.map(category => {
    const items = commandRegistry.filter(command => command.category === category);
    if (!items.length) return '';
    const heading = category === 'workflow' ? 'Primary workflows' : category === 'agent-stream' ? 'Agent streaming primitives' : category === 'extend' ? 'Extension surfaces' : 'Advanced standalone operations';
    return `### ${heading}\n\n${items.map(c => `- \`${c.usage}\`: ${c.summary} Output: ${c.output}.`).join('\n')}`;
  }).filter(Boolean).join('\n\n');
  return `# JobOS Agent Guide

JobOS is the local-first host and source of truth for job state. The TUI is the primary interactive product: it launches a real Hermes ACP guest session and mediates JobOS MCP tools. The CLI and external \`jobos mcp\` server remain first-class automation doors. Core workflows may discover, score, research, draft, and stage actions. External effects are disabled by default.

## Host Architecture

- \`jobos tui --profile <id>\` launches the data-bound shell and the Hermes ACP guest pane.
- The guest receives a secret-safe selected-job packet and a session-scoped JobOS MCP server; it does not receive terminal or filesystem permission.
- \`jobos mcp\` exposes the same \`domain-tools\` semantics to external agents.
- \`--agent <name>\` / \`JOBOS_AGENT\` select the separate noninteractive batch generator; explicit failures never silently fall back.
- JobOS reloads SQLite after guest tools complete and rejects stale concurrent writers.

## Global Rules

- Prefer \`--json\` for one-shot commands; use \`tui --snapshot\` for a noninteractive shell view.
- Use \`--workspace <dir>\` or \`JOBOS_HOME\` to select state. ACP cwd and MCP tools use that same root.
- Exit codes: \`0\` success, \`1\` runtime/domain error, \`2\` usage error.
- JSON errors are written to stderr as \`{"ok":false,"error":{"code":"...","type":"...","message":"..."}}\`.
- Generated resumes, cover letters, research, interview prep, application answers, and outreach remain proof/source-grounded drafts.
- Never infer restricted answers, print browser cookies, bypass CAPTCHA, or claim an external action succeeded without its configured tool's result.

## Commands

Prefer \`daily\` and \`pursue\` for complete workflows. Use advanced standalone operations when intentionally refreshing one operation without its pursuit dependencies. Streaming primitives are intended for agents and test harnesses; human background automation should use \`scheduler start\` or \`scheduler run-once\`.

${commands}

## Interactive Flow

\`\`\`bash
hermes acp --check
jobos tui --profile pm-edtech
# External agents use the second door:
jobos mcp
\`\`\`

## Minimal Non-Interactive Flow

\`\`\`bash
jobos profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json
jobos searches create "Acme" --profile pm-edtech --adapter greenhouse --board-token acme --json
jobos daily --profile pm-edtech --json
jobos jobs list --json
jobos pursue <job-id> --profile pm-edtech --json
jobos network paths --job <job-id> --json
jobos agents list --json
jobos browser status --json
\`\`\`
`;
}

function emitBootstrapNotice(s, flags) {
  if (!s.bootstrapCreated || s.bootstrapNoticeEmitted || flags.quiet || s.suppressBootstrapNotice) return;
  console.error(`jobos: initialized workspace at ${s.root}`);
  s.bootstrapNoticeEmitted = true;
}

function output(value, flags = {}, s = null) {
  if (s) emitBootstrapNotice(s, flags);
  if (flags.json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function printText(text, flags, s) {
  emitBootstrapNotice(s, flags);
  console.log(text);
}

function writeJsonLine(value, flags, s) {
  emitBootstrapNotice(s, flags);
  console.log(JSON.stringify(value));
}

function needProfile(flags) {
  if (!flags.profile) usage('Missing --profile <profile-id>');
  return String(flags.profile);
}

function requireFlag(flags, name, display = `--${name}`) {
  const value = flags[name];
  if (value === undefined || value === true) usage(`Missing ${display}`);
  return value;
}

function numberFlag(flags, name, fallback, { min = 0 } = {}) {
  const raw = flags[name];
  if (raw === true) usage(`Missing --${name}`);
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < min) usage(`Invalid --${name}: ${raw ?? fallback}`);
  return n;
}

function parseConfig(flags) {
  if (!flags.config) return {};
  try {
    return JSON.parse(String(flags.config));
  } catch (e) {
    usage(`Invalid --config JSON: ${e.message}`);
  }
}

function publicTasks(rows) {
  return rows.map(t => ({
    id: t.id,
    title: t.title,
    type: t.type,
    createdBy: t.created_by,
    dueAt: t.due_at,
    priority: t.priority,
    status: t.status,
    jobId: t.job_id,
    applicationId: t.application_id
  }));
}

function taskFilters(flags) {
  return {
    type: flags.type ? String(flags.type) : null,
    createdBy: flags['created-by'] ? String(flags['created-by']) : null
  };
}

function watchlistProfile(s, flags) {
  if (flags.profile) return String(flags.profile);
  const profiles = all(s, 'SELECT id FROM profiles ORDER BY created_at');
  if (profiles.length === 1) return profiles[0].id;
  usage(profiles.length
    ? 'Missing --profile <profile-id>; legacy watchlists were not profile-scoped'
    : 'Missing --profile <profile-id>; create a profile first');
}

function compatibilityWatchlist(s) {
  const legacy = listWatchlist(s).map(item => ({ ...item, legacy: true }));
  const canonical = listSearches(s)
    .filter(search => search.config?.preset === 'company-watch')
    .map(search => ({
      id: search.id,
      searchId: search.id,
      company: search.config.companyLabel || search.name,
      adapter: search.adapter,
      handle: search.config.boardToken || search.config.handle || '',
      notes: search.config.notes || '',
      profileId: search.profileId,
      legacy: false
    }));
  const targetKey = item => [item.company, item.adapter, item.handle].map(value => String(value || '').trim().toLowerCase()).join('|');
  const canonicalTargets = new Set(canonical.map(targetKey));
  return [...canonical, ...legacy.filter(item => !canonicalTargets.has(targetKey(item)))];
}

function dueTasks(s, flags = {}) {
  return publicTasks(due(s, taskFilters(flags)));
}

function inboxTasks(s, flags = {}) {
  return publicTasks(openTasks(s, taskFilters(flags)));
}

function sleep(ms, isStopped) {
  if (ms <= 0 || isStopped()) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    let check;
    const finish = () => {
      clearTimeout(timer);
      clearInterval(check);
      resolve();
    };
    timer = setTimeout(finish, ms);
    check = setInterval(() => {
      if (isStopped()) {
        finish();
      }
    }, 100);
  });
}

async function repeat({ flags, s, eventType = 'loop.iteration', targetType, target, run }) {
  const intervalSeconds = numberFlag(flags, 'interval', 60, { min: 0 });
  const maxIterations = flags['max-iterations'] === undefined ? Infinity : numberFlag(flags, 'max-iterations', 1, { min: 1 });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (let iteration = 1; !stopped && iteration <= maxIterations; iteration++) {
      const startedAt = new Date().toISOString();
      try {
        const result = await run(iteration);
        const event = {
          type: eventType,
          iteration,
          targetType,
          target,
          status: result?.status || 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          result
        };
        if (flags.json) writeJsonLine(event, flags, s);
        else printText(`${targetType} ${target} iteration ${iteration}: ${event.status}`, flags, s);
      } catch (e) {
        const event = {
          type: eventType,
          iteration,
          targetType,
          target,
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          error: { message: e.message }
        };
        if (flags.json) writeJsonLine(event, flags, s);
        else {
          emitBootstrapNotice(s, flags);
          console.error(`jobos: ${targetType} ${target} iteration ${iteration} failed: ${e.message}`);
        }
        throw e;
      }
      if (iteration >= maxIterations || stopped) break;
      await sleep(intervalSeconds * 1000, () => stopped);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function bootstrapInfo(flags) {
  const root = workspaceRoot(flags);
  const p = paths(root);
  return {
    root,
    created: !(fs.existsSync(p.db) && fs.existsSync(p.ws))
  };
}

function normalizedError(e) {
  const isUsage = e?.exitCode === 2 || e?.type === 'usage';
  const error = {
    code: e?.code || (isUsage ? 'usage_error' : 'runtime_error'),
    type: isUsage ? 'usage' : (e?.type || 'runtime'),
    message: e?.message || String(e)
  };
  if (e?.retryable) error.retryable = true;
  if (e?.recovery) error.recovery = e.recovery;
  if (e?.details) error.details = e.details;
  return { ok: false, error };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parse(argv);
  const flags = parsed.flags;
  const [group, action, subaction, ...rest] = parsed._;

  if (!group || group === 'help' || flags.help) {
    const parts = group === 'help' ? parsed._.slice(1) : parsed._;
    if (flags.json) output(parts.length ? commandFor(parts) || registryJson() : registryJson(), flags);
    else console.log(parts.length ? renderCommandHelp(parts) : renderRootHelp({ allCommands: Boolean(flags.all) }));
    return;
  }

  if (flags.agent && group !== 'tui') process.env.JOBOS_AGENT = String(flags.agent);
  if (flags.workspace) process.env.JOBOS_WORKSPACE = path.resolve(String(flags.workspace));
  const boot = bootstrapInfo(flags);
  const s = await openStore(flags);
  s.bootstrapCreated = boot.created;
  s.bootstrapNoticeEmitted = false;
  s.suppressBootstrapNotice = ['mcp', 'tui'].includes(group);
  const out = value => output(value, flags, s);
  const text = value => printText(value, flags, s);

  if (group === 'init') {
    out({ ok: true, root: s.root, database: s.p.db, workspace: s.p.ws, policy: { externalActions: 'user_configured', autoApply: 'disabled', autoSend: 'disabled' } });
    return;
  }
  if (group === 'agent-guide') {
    if (flags.json) out(registryJson());
    else text(renderAgentGuide());
    return;
  }
  if (group === 'tui') {
    const [
      { buildTuiModel },
      { defaultTuiState, renderTui, startTui }
    ] = await Promise.all([import('./tui-model.js'), import('./tui.js')]);
    const profileId = flags.profile ? String(flags.profile) : null;
    const model = buildTuiModel(s, { profileId });
    if (flags.json) {
      out(model);
      return;
    }
    if (flags.snapshot) {
      const state = { ...defaultTuiState(), profileId: model.profileId, selectedJobId: model.selectedJobId, agentState: 'offline', status: 'snapshot · no agent process started' };
      text(renderTui(model, state, {
        width: numberFlag(flags, 'width', 140, { min: 60 }),
        height: numberFlag(flags, 'height', 42, { min: 20 }),
        color: false
      }));
      return;
    }
    const agentFlag = String(flags.agent || 'hermes-acp').toLowerCase();
    await startTui(s, {
      profileId,
      connectAgent: !['off', 'false', 'none', '0'].includes(agentFlag)
    });
    return;
  }
  if (group === 'daily') {
    out(await callDomainTool(s, 'daily_discovery', { profileId: needProfile(flags) }, { source: 'cli' }));
    return;
  }
  if (group === 'pursue') {
    if (!action) usage('Missing job id');
    out(await callDomainTool(s, 'pursue_job', {
      jobId: String(action),
      profileId: needProfile(flags),
      stage: flags.stage ? String(flags.stage) : null,
      dryRun: Boolean(flags['dry-run']),
      stageTimeoutMs: flags['stage-timeout'] ? numberFlag(flags, 'stage-timeout', 30000, { min: 1000 }) : 30000
    }, { source: 'cli' }));
    return;
  }
  if (group === 'profile' && action === 'create') {
    const name = [subaction, ...rest].filter(Boolean).join(' ');
    if (!name) usage('Missing profile name');
    const r = createProfile(s, name, { fromResume: flags['from-resume'], preferences: flags.preferences });
    out({ id: r.profile.id, name: r.profile.name, created: r.created, preferences: parseJson(r.profile.preferences_json, {}), nextActions: r.nextActions });
    return;
  }
  if (group === 'profile' && action === 'network-intent') {
    const filePath = requireFlag(flags, 'file', '--file <json>');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(String(filePath), 'utf8'));
    } catch (e) {
      usage(`Invalid --file JSON: ${e.message}`);
    }
    out(setNetworkIntent(s, { profileId: needProfile(flags), intent: data.intent, affiliations: data.affiliations }));
    return;
  }
  if (group === 'resume' && action === 'import') {
    const row = importResume(s, { profileId: needProfile(flags), filePath: String(requireFlag(flags, 'file', '--file <path>')) });
    out({ id: row.id, profileId: row.profile_id, revision: row.revision, verificationStatus: row.verification_status, document: row.document, validation: row.validation });
    return;
  }
  if (group === 'resume' && action === 'show') {
    const revision = flags.revision == null ? null : numberFlag(flags, 'revision', null, { min: 1 });
    const row = getResume(s, needProfile(flags), revision);
    if (!row) throw Error(`Resume revision not found${revision == null ? '' : `: ${revision}`}`);
    out({ id: row.id, profileId: row.profile_id, revision: row.revision, sourceTextHash: row.source_text_hash, verificationStatus: row.verification_status, supersedesResumeId: row.supersedes_resume_id || null, isCurrent: Boolean(row.is_current), document: row.document, validation: row.validation });
    return;
  }
  if (group === 'resume' && action === 'validate') {
    const row = getResume(s, needProfile(flags));
    if (!row) out({ valid: false, schemaVersion: 1, blockers: [{ code: 'resume_source_missing', message: 'No canonical resume revision exists.' }], warnings: [] });
    else out({ resumeId: row.id, revision: row.revision, ...validateResumeDocument(row.document) });
    return;
  }
  if (group === 'resume' && action === 'preflight') {
    out(preflightResumeArtifact(s, String(requireFlag(flags, 'artifact', '--artifact <artifact-id>'))));
    return;
  }
  if (group === 'resume' && action === 'replace') {
    const row = replaceResume(s, { profileId: needProfile(flags), filePath: String(requireFlag(flags, 'file', '--file <json-or-yaml>')) });
    out({ id: row.id, profileId: row.profile_id, revision: row.revision, supersedesResumeId: row.supersedes_resume_id, verificationStatus: row.verification_status, document: row.document, validation: row.validation });
    return;
  }
  if (group === 'resume' && action === 'coverage') {
    const profileId = needProfile(flags);
    const jobId = String(requireFlag(flags, 'job'));
    const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
    if (!job) throw Error(`Unknown job: ${jobId}`);
    if (job.profile_id !== profileId) throw Object.assign(new Error(`Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`), { code: 'profile_job_mismatch', type: 'validation' });
    const proofs = all(s, "SELECT * FROM proof_points WHERE profile_id=? AND status='active' AND verification_status='verified'", [profileId]);
    out({ jobId, profileId, requirements: inventoryForJob(job), coverage: buildRequirementCoverage(inventoryForJob(job), proofs) });
    return;
  }
  if (group === 'proof' && action === 'add') {
    const summary = requireFlag(flags, 'summary');
    const p = addProof(s, needProfile(flags), String(summary), flags.evidence ? String(flags.evidence) : '', flags.skills ? splitCsv(flags.skills) : []);
    out({ id: p.id, profileId: p.profile_id, summary: p.summary });
    return;
  }
  if (group === 'proof' && action === 'verify') {
    const proofId = subaction || rest[0];
    if (!proofId) usage('Missing proof id');
    const proof = verifyProof(s, String(proofId));
    out({ id: proof.id, profileId: proof.profile_id, status: proof.status, verificationStatus: proof.verification_status });
    return;
  }
  if (group === 'proof' && action === 'retire') {
    const proofId = subaction || rest[0];
    if (!proofId) usage('Missing proof id');
    const proof = retireProof(s, String(proofId), String(requireFlag(flags, 'reason')));
    out({ id: proof.id, profileId: proof.profile_id, status: proof.status, retiredAt: proof.retired_at, retirementReason: proof.retirement_reason });
    return;
  }
  if (group === 'proof' && action === 'replace') {
    const proofId = subaction || rest[0];
    if (!proofId) usage('Missing proof id');
    const proof = supersedeProof(s, String(proofId), { summary: String(requireFlag(flags, 'summary')), evidence: flags.evidence ? String(flags.evidence) : '', skills: flags.skills ? splitCsv(flags.skills) : [] });
    out({ id: proof.id, profileId: proof.profile_id, status: proof.status, verificationStatus: proof.verification_status, supersedesProofPointId: proof.supersedes_proof_point_id });
    return;
  }
  if (group === 'answers' && action === 'add') {
    out(addAnswer(s, {
      profileId: needProfile(flags),
      category: String(requireFlag(flags, 'category')),
      question: String(requireFlag(flags, 'question')),
      answer: String(requireFlag(flags, 'answer')),
      sensitivity: flags.sensitivity ? String(flags.sensitivity) : 'personal',
      reuseScope: flags.reuse ? String(flags.reuse) : 'global',
      verificationStatus: flags.status ? String(flags.status) : 'verified',
      sourceRef: flags.source ? String(flags.source) : 'user_input',
      employer: flags.employer ? String(flags.employer) : ''
    }));
    return;
  }
  if (group === 'answers' && action === 'list') {
    out(listAnswers(s, { profileId: needProfile(flags), category: flags.category ? String(flags.category) : null, status: flags.status ? String(flags.status) : null }));
    return;
  }
  if (group === 'answers' && action === 'match') {
    const file = requireFlag(flags, 'questions', '--questions <json-file>');
    let questions;
    try {
      questions = JSON.parse(fs.readFileSync(String(file), 'utf8'));
    } catch (e) {
      usage(`Invalid --questions JSON file: ${e.message}`);
    }
    out(await callDomainTool(s, 'answers_match', { profileId: needProfile(flags), questions, employer: flags.employer ? String(flags.employer) : '' }, { source: 'cli' }));
    return;
  }
  if (group === 'jobs' && action === 'import-text') {
    const filePath = requireFlag(flags, 'file', '--file <path>');
    const r = importText(s, { profileId: needProfile(flags), filePath });
    out({ id: r.job.id, title: r.job.title, company: r.job.company, created: r.created });
    return;
  }
  if (group === 'jobs' && action === 'import-url') {
    const url = subaction || flags.url;
    if (!url) usage('Missing URL');
    const r = await importUrl(s, { profileId: needProfile(flags), url });
    out({ id: r.job.id, title: r.job.title, company: r.job.company, url: r.job.url, created: r.created });
    return;
  }
  if (group === 'jobs' && action === 'list') {
    out(await callDomainTool(s, 'list_jobs', {}, { source: 'cli' }));
    return;
  }
  if (group === 'jobs' && action === 'dedupe') {
    out(dedupeJobs(s, { apply: Boolean(flags.apply) }));
    return;
  }
  if (group === 'searches' && action === 'create') {
    const name = [subaction, ...rest].filter(Boolean).join(' ');
    if (!name) usage('Missing search name');
    const search = createSearch(s, { name, profileId: needProfile(flags), adapter: String(flags.adapter || ''), config: configFromFlags(flags), minFit: flags['min-fit'] ? Number(flags['min-fit']) : 70 });
    out(search);
    return;
  }
  if (group === 'searches' && action === 'list') {
    out(listSearches(s));
    return;
  }
  if (group === 'searches' && action === 'migrate-watchlist') {
    out(migrateLegacyWatchlist(s, {
      profileId: needProfile(flags),
      minFit: flags['min-fit'] ? Number(flags['min-fit']) : 70
    }));
    return;
  }
  if (group === 'watchlist' && action === 'add') {
    const company = flags.company ? String(flags.company) : [subaction, ...rest].filter(Boolean).join(' ');
    if (!company) usage('Missing --company <company>');
    const handle = flags['board-token'] || flags.handle || '';
    const item = createCompanySearch(s, {
      company,
      profileId: watchlistProfile(s, flags),
      adapter: String(flags.adapter || ''),
      handle: String(handle),
      notes: flags.notes ? String(flags.notes) : '',
      minFit: flags['min-fit'] ? Number(flags['min-fit']) : 70
    });
    out({
      ...item,
      company,
      handle: String(handle),
      deprecated: true,
      replacement: 'searches create'
    });
    return;
  }
  if (group === 'watchlist' && action === 'list') {
    out(compatibilityWatchlist(s));
    return;
  }
  if (group === 'discover' && action === 'run') {
    const search = flags.search || subaction;
    if (!search) usage('Missing --search <name-or-id>');
    out(await runSavedSearch(s, String(search)));
    return;
  }
  if (group === 'discover' && action === 'run-all') {
    out(await runAllSearches(s, { profileId: flags.profile ? String(flags.profile) : null }));
    return;
  }
  if (group === 'score') {
    if (!action) usage('Missing job id');
    out(await callDomainTool(s, 'score_job', { jobId: action, profileId: needProfile(flags) }, { source: 'cli' }));
    return;
  }
  if (group === 'tailor' && action === 'resume') {
    const jobId = requireFlag(flags, 'job');
    const layout = flags.layout ? String(flags.layout) : null;
    const pageSize = flags['page-size'] ? String(flags['page-size']).toLowerCase() : 'letter';
    const format = flags.format ? String(flags.format).toLowerCase() : 'markdown';
    if (layout && !['professional', 'technical', 'leadership'].includes(layout)) usage('Invalid --layout; expected professional, technical, or leadership');
    if (!['letter', 'a4'].includes(pageSize)) usage('Invalid --page-size; expected letter or a4');
    if (!['markdown', 'pdf'].includes(format)) usage('Invalid --format; expected markdown or pdf');
    const r = await tailor(s, jobId, needProfile(flags), 'resume', { layoutProfileId: layout, pageSize, pageLimit: numberFlag(flags, 'page-limit', 2, { min: 1 }), format });
    if (flags.output === 'markdown' && !flags.json) text(fs.readFileSync(path.join(s.p.ws, r.path), 'utf8'));
    else out(r);
    return;
  }
  if (group === 'tailor' && action === 'cover-letter') {
    const jobId = requireFlag(flags, 'job');
    const r = await tailor(s, jobId, needProfile(flags), 'cover');
    if (flags.output === 'markdown' && !flags.json) text(fs.readFileSync(path.join(s.p.ws, r.path), 'utf8'));
    else out(r);
    return;
  }
  if (group === 'artifacts' && action === 'queue') {
    out(await callDomainTool(s, 'review_queue', {
      profileId: flags.profile ? String(flags.profile) : null,
      jobId: flags.job ? String(flags.job) : null
    }, { source: 'cli' }));
    return;
  }
  if (group === 'artifacts' && action === 'diff') {
    if (!subaction) usage('Missing artifact id');
    const result = await callDomainTool(s, 'diff_artifact', {
      artifactId: String(subaction),
      againstArtifactId: flags.against ? String(flags.against) : null
    }, { source: 'cli' });
    if (flags.json) out(result);
    else text(result.text);
    return;
  }
  if (group === 'artifacts' && action === 'approve') {
    if (!subaction) usage('Missing artifact id');
    out(await callDomainTool(s, 'approve_artifact', {
      artifactId: String(subaction),
      note: flags.note ? String(flags.note) : ''
    }, { source: 'cli' }));
    return;
  }
  if (group === 'artifacts' && action === 'reject') {
    if (!subaction) usage('Missing artifact id');
    out(await callDomainTool(s, 'reject_artifact', {
      artifactId: String(subaction),
      note: String(requireFlag(flags, 'note'))
    }, { source: 'cli' }));
    return;
  }
  if (group === 'applications' && action === 'plan') {
    out(await callDomainTool(s, 'applications_plan', {
      jobId: String(requireFlag(flags, 'job')),
      profileId: needProfile(flags)
    }, { source: 'cli' }));
    return;
  }
  if (group === 'applications' && action === 'create') {
    if (!flags.job || !flags.status) usage('Missing --job or --status');
    const a = appCreate(s, flags.job, String(flags.status), flags.notes ? String(flags.notes) : '');
    out({ id: a.id, jobId: a.job_id, profileId: a.profile_id, status: a.status, researchRecommendation: recommendResearch(s, { jobId: a.job_id, profileId: a.profile_id, status: a.status }) });
    return;
  }
  if (group === 'applications' && action === 'update') {
    if (!subaction || !flags.status) usage('Missing application id or --status');
    const a = appUpdate(s, subaction, String(flags.status), flags.notes ? String(flags.notes) : null);
    out({ id: a.id, jobId: a.job_id, profileId: a.profile_id, status: a.status, researchRecommendation: recommendResearch(s, { jobId: a.job_id, profileId: a.profile_id, status: a.status }) });
    return;
  }
  if (group === 'apply') {
    if (action === 'form' && subaction === 'inspect') {
      out(await callDomainTool(s, 'inspect_application_form', {
        jobId: String(requireFlag(flags, 'job')),
        profileId: String(requireFlag(flags, 'profile')),
        url: String(requireFlag(flags, 'url')),
        browserProfile: flags['browser-profile'] ? String(flags['browser-profile']) : 'default',
        expectedAdapterHash: flags['adapter-hash'] ? String(flags['adapter-hash']) : null
      }, { source: 'cli' }));
      return;
    }
    if (action === 'form' && subaction === 'show') {
      if (!rest[0]) usage('Missing snapshot id');
      out(await callDomainTool(s, 'application_form_show', {
        snapshotId: String(rest[0])
      }, { source: 'cli' }));
      return;
    }
    if (action === 'form' && subaction === 'assist') {
      if (!rest[0]) usage('Missing packet id');
      out(await callDomainTool(s, 'assist_application_form', {
        packetId: String(rest[0]),
        browserProfile: flags['browser-profile'] ? String(flags['browser-profile']) : 'default',
        allowSideEffects: flags['allow-side-effects'] === true,
        expectedAdapterHash: flags['adapter-hash'] ? String(flags['adapter-hash']) : null
      }, { source: 'cli' }));
      return;
    }
    if (action === 'form' && subaction === 'checkpoint') {
      if (!rest[0]) usage('Missing packet id');
      out(await callDomainTool(s, 'checkpoint_application_form', {
        packetId: String(rest[0]),
        fillRunId: String(requireFlag(flags, 'fill-run')),
        confirmedFieldKeys: flags['confirm-fields'] ? String(flags['confirm-fields']).split(',').map(value => value.trim()).filter(Boolean) : []
      }, { source: 'cli' }));
      return;
    }
    if (action === 'form' && subaction === 'submit') {
      if (!rest[0]) usage('Missing packet id');
      out(await callDomainTool(s, 'submit_application_form', {
        packetId: String(rest[0]),
        checkpointId: String(requireFlag(flags, 'checkpoint')),
        browserProfile: flags['browser-profile'] ? String(flags['browser-profile']) : 'default',
        allowSubmit: flags['allow-submit'] === true,
        expectedAdapterHash: flags['adapter-hash'] ? String(flags['adapter-hash']) : null
      }, { source: 'cli' }));
      return;
    }
    if (action === 'packet' && subaction === 'create') {
      out(await callDomainTool(s, 'create_application_packet', {
        jobId: String(requireFlag(flags, 'job')),
        profileId: String(requireFlag(flags, 'profile'))
      }, { source: 'cli' }));
      return;
    }
    if (action === 'packet' && subaction === 'show') {
      if (!rest[0]) usage('Missing packet id');
      out(await callDomainTool(s, 'application_packet_show', {
        packetId: String(rest[0])
      }, { source: 'cli' }));
      return;
    }
    if (action === 'packet' && subaction === 'list') {
      const jobId = flags.job ? String(requireFlag(flags, 'job', '--job <job-id>')) : null;
      const profileId = flags.profile ? String(requireFlag(flags, 'profile', '--profile <profile-id>')) : null;
      if (!jobId && !profileId) usage('Missing --job <job-id> or --profile <profile-id>');
      out(await callDomainTool(s, 'application_packets_list', {
        jobId,
        profileId
      }, { source: 'cli' }));
      return;
    }
    if (action === 'packet' && subaction === 'diff') {
      if (!rest[0] || !rest[1]) usage('Missing packet-a or packet-b');
      out(await callDomainTool(s, 'application_packet_diff', {
        firstPacketId: String(rest[0]),
        secondPacketId: String(rest[1])
      }, { source: 'cli' }));
      return;
    }
    if (action === 'attest-submitted') {
      if (!subaction) usage('Missing packet id');
      out(await callDomainTool(s, 'attest_application_submitted', {
        packetId: String(subaction),
        submittedAt: String(requireFlag(flags, 'submitted-at', '--submitted-at <rfc3339>')),
        note: flags.note ? String(flags.note) : ''
      }, { source: 'cli' }));
      return;
    }
    if (action === 'confirm-receipt') {
      if (!subaction) usage('Missing packet id');
      out(await callDomainTool(s, 'confirm_application_receipt', {
        packetId: String(subaction),
        reference: String(requireFlag(flags, 'reference', '--reference <text>')),
        note: flags.note ? String(flags.note) : ''
      }, { source: 'cli' }));
      return;
    }
    usage('Unknown apply command. Try: jobos apply form inspect/show, jobos apply packet create/show/list/diff, jobos apply attest-submitted, jobos apply confirm-receipt');
  }
  if (group === 'research' && action === 'company') {
    const jobId = requireFlag(flags, 'job');
    out(await researchCompany(s, jobId));
    return;
  }
  if (group === 'research' && action === 'people') {
    const profileId = needProfile(flags);
    const scope = requireFlag(flags, 'scope');
    if (!['profile', 'target', 'job', 'person'].includes(scope)) usage('--scope must be profile, target, job, or person');
    const personField = (flags.name && flags['source-url']) ? { name: String(flags.name), profileUrl: String(flags['source-url']) } : undefined;
    const runId = createResearchRun(s, {
      profileId,
      scope,
      jobId: flags.job ? String(flags.job) : undefined,
      company: flags.company ? String(flags.company) : undefined,
      role: flags.role ? String(flags.role) : undefined,
      personId: flags.person ? String(flags.person) : undefined,
      person: personField,
      depth: flags.depth || 'standard',
      sources: flags.sources ? String(flags.sources).split(',').map(s => s.trim()) : undefined,
      budget: flags['max-cost-usd'] !== undefined ? { maxCostUsd: Number(flags['max-cost-usd']) } : undefined
    });
    const result = await executeResearchRun(s, runId);
    out(result);
    return;
  }
  if (group === 'research' && action === 'runs') {
    if (subaction === 'get') {
      const runId = rest[0] || flags.run;
      if (!runId) usage('Missing run id');
      out(getResearchRun(s, String(runId)));
      return;
    }
    if (subaction === 'resume') {
      const runId = rest[0] || flags.run;
      if (!runId) usage('Missing run id');
      out(await resumeResearchRun(s, String(runId)));
      return;
    }
    if (subaction === 'cancel') {
      const runId = rest[0] || flags.run;
      if (!runId) usage('Missing run id');
      out(requestCancelResearchRun(s, String(runId)));
      return;
    }
    usage('Missing run subcommand: get, resume, or cancel');
  }
  if (group === 'network' && action === 'import') {
    const filePath = requireFlag(flags, 'file', '--file <csv>');
    out(importNetworkCsv(s, {
      filePath: String(filePath),
      profileId: flags.profile ? String(flags.profile) : null,
      format: String(flags.format || 'auto')
    }));
    return;
  }
  if (group === 'network' && action === 'paths') {
    out(await callDomainTool(s, 'map_reachable_network', { jobId: String(requireFlag(flags, 'job')) }, { source: 'cli' }));
    return;
  }
  if (group === 'network' && action === 'contacts') {
    out(listNetworkContacts(s, { jobId: String(requireFlag(flags, 'job')) }));
    return;
  }
  if (group === 'network' && action === 'list') {
    out(listNetworkEdges(s));
    return;
  }
  if (group === 'research' && action === 'add-stakeholder') {
    const jobId = requireFlag(flags, 'job');
    const sourceUrl = requireFlag(flags, 'source-url', '--source-url <url>');
    const textInput = flags.file ? fs.readFileSync(String(flags.file), 'utf8') : (flags.text ? String(flags.text) : '');
    if (!textInput && !flags.name) usage('Missing --text, --file, or --name for stakeholder source context');
    out(await addStakeholder(s, { jobId, sourceUrl: String(sourceUrl), name: flags.name ? String(flags.name) : '', role: flags.role ? String(flags.role) : '', text: textInput }));
    return;
  }
  if (group === 'research' && action === 'approve-contact') {
    const contactId = flags.contact ? String(flags.contact) : null;
    const candidateId = flags['worksheet-candidate'] ? String(flags['worksheet-candidate']) : null;
    if (!contactId && !candidateId) usage('Provide --contact <contact-id> or --worksheet-candidate <candidate-id>');
    if (contactId) {
      out(approveContact(s, { contactId }));
      return;
    }
    const candidate = one(s, 'SELECT id,person_id FROM person_candidates WHERE id=?', [candidateId]);
    if (!candidate) usage(`Unknown candidate: ${candidateId}`);
    const keys = [candidate.id, candidate.person_id].filter(Boolean);
    const contactIds = all(s, `SELECT id FROM contact_points WHERE person_id IN (${keys.map(() => '?').join(',')})`, keys).map(row => row.id);
    if (!contactIds.length) usage(`Candidate ${candidateId} has no contact points to approve`);
    out({ candidateId, approvedContacts: contactIds.map(id => approveContact(s, { contactId: id }).id), note: 'Contacts approved for human-reviewed use; JobOS did not send outreach.' });
    return;
  }
  if (group === 'research' && action === 'suppress-contact') {
    out(suppressContact(s, { contactId: String(requireFlag(flags, 'contact')), reason: String(requireFlag(flags, 'reason')) }));
    return;
  }
  if (group === 'research' && action === 'promote-stakeholder') {
    out(promoteStakeholder(s, { candidateId: String(requireFlag(flags, 'candidate')) }));
    return;
  }
  if (group === 'outreach' && action === 'outcome' && subaction === 'record') {
    out(recordOutreachOutcome(s, {
      threadId: String(requireFlag(flags, 'thread', '--thread <thread-id>')),
      profileId: needProfile(flags),
      type: String(requireFlag(flags, 'type', '--type <outcome-type>')),
      occurredAt: String(requireFlag(flags, 'occurred-at', '--occurred-at <rfc3339>')),
      windowEndAt: flags['window-end'] ? String(flags['window-end']) : null,
      channel: flags.channel ? String(flags.channel) : null,
      note: flags.note ? String(flags.note) : '',
      referenceId: flags.reference ? String(flags.reference) : '',
      supersedesOutcomeId: flags.supersedes ? String(flags.supersedes) : null,
      correctionReason: flags['correction-reason'] ? String(flags['correction-reason']) : '',
      actor: 'user',
      source: 'cli'
    }));
    return;
  }
  if (group === 'outreach' && action === 'outcomes') {
    out(listOutreachOutcomes(s, {
      profileId: needProfile(flags),
      sinceDays: flags.since == null ? null : Number(flags.since),
      includeNotes: true
    }));
    return;
  }
  if (group === 'outreach' && action === 'draft') {
    if (!flags.plan && (!flags.job || !flags.stakeholder)) usage('Missing --job/--stakeholder or --plan');
    const r = await draftOutreach(s, { jobId: flags.job ? String(flags.job) : null, profileId: needProfile(flags), stakeholderId: flags.stakeholder ? String(flags.stakeholder) : null, goal: flags.goal ? String(flags.goal) : null, planId: flags.plan ? String(flags.plan) : null, contactId: flags.contact ? String(flags.contact) : null });
    out(r);
    return;
  }
  if (group === 'outreach' && action === 'plan') {
    const jobId = requireFlag(flags, 'job');
    const r = createOutreachPlan(s, { jobId: String(jobId), profileId: needProfile(flags), stakeholderId: flags.stakeholder ? String(flags.stakeholder) : null, goal: flags.goal ? String(flags.goal) : 'informational' });
    out(r);
    return;
  }
  if (group === 'outreach' && action === 'mark-sent') {
    const artifactId = requireFlag(flags, 'artifact', '--artifact <artifact-id>');
    const channel = requireFlag(flags, 'channel', '--channel <email|linkedin|other>');
    out(markOutreachSent(s, { artifactId: String(artifactId), channel: String(channel), notes: flags.notes ? String(flags.notes) : '' }));
    return;
  }
  if (group === 'outreach' && action === 'schedule-followup') {
    const threadId = requireFlag(flags, 'thread', '--thread <thread-id>');
    const afterDays = requireFlag(flags, 'after', '--after <days>');
    out(scheduleFollowup(s, { threadId: String(threadId), afterDays }));
    return;
  }
  if (group === 'outreach' && action === 'due') {
    out(outreachDue(s));
    return;
  }
  if (group === 'interview' && action === 'prep') {
    const applicationId = requireFlag(flags, 'application');
    const r = await prepInterview(s, String(applicationId), flags.stage ? String(flags.stage) : 'interview');
    if (flags.output === 'markdown' && !flags.json) text(fs.readFileSync(path.join(s.p.ws, r.path), 'utf8'));
    else out(r);
    return;
  }
  if (group === 'analytics' && action === 'funnel') {
    const r = funnel(s, needProfile(flags), flags.since ? Number(flags.since) : 30);
    if (flags.output === 'markdown' && !flags.json) text(renderFunnelMarkdown(r));
    else out(r);
    return;
  }
  if (group === 'analytics' && action === 'resume-feedback') {
    out(resumeFeedback(s, needProfile(flags)));
    return;
  }
  if (group === 'tasks' && action === 'list') {
    out(inboxTasks(s, flags));
    return;
  }
  if (group === 'tasks' && action === 'due') {
    if (flags.watch) {
      await repeat({ flags, s, eventType: 'watch.iteration', targetType: 'tasks', target: 'due', run: () => {
        reload(s);
        return { tasks: dueTasks(s, flags), checkedAt: new Date().toISOString() };
      } });
    } else {
      out(dueTasks(s, flags));
    }
    return;
  }
  if (group === 'review' && action === 'weekly') {
    const r = weekly(s, needProfile(flags));
    if (flags.output === 'markdown' && !flags.json) text(r.content);
    else out({ runId: r.runId, path: r.path });
    return;
  }
  if (group === 'automation' && action === 'create') {
    const name = subaction;
    if (!name) usage('Missing automation name');
    const r = createAutomation(s, { name, actionId: String(flags.action || name), schedule: String(flags.schedule || ''), profileId: flags.profile ? String(flags.profile) : null, enabled: Boolean(flags.enabled), config: parseConfig(flags) });
    out(r);
    return;
  }
  if (group === 'automation' && action === 'list') {
    out(listAutomations(s));
    return;
  }
  if (group === 'automation' && action === 'enable') {
    if (!subaction) usage('Missing automation name');
    out(setAutomationEnabled(s, subaction, true));
    return;
  }
  if (group === 'automation' && action === 'disable') {
    if (!subaction) usage('Missing automation name');
    out(setAutomationEnabled(s, subaction, false));
    return;
  }
  if (group === 'automation' && action === 'run') {
    if (!subaction) usage('Missing automation name');
    out(await runAutomationByName(s, subaction, { trigger: 'manual' }));
    return;
  }
  if (group === 'scheduler' && action === 'run-once') {
    out(await runDueAutomations(s));
    return;
  }
  if (group === 'scheduler' && action === 'status') {
    out(await schedulerStatus(s));
    return;
  }
  if (group === 'scheduler' && action === 'start') {
    const interval = numberFlag(flags, 'interval', 60, { min: 1 });
    emitBootstrapNotice(s, flags);
    if (flags.json) console.log(JSON.stringify({ type: 'scheduler.started', intervalSeconds: interval }));
    else console.log(`JobOS scheduler running every ${interval}s`);
    await startScheduler(s, { intervalSeconds: interval, onTick: r => { if (flags.json) console.log(JSON.stringify({ type: 'scheduler.tick', result: r })); } });
    return;
  }
  if (group === 'runs' && action === 'list') {
    out(recentRuns(s, flags.limit ? Number(flags.limit) : 25));
    return;
  }
  if (group === 'loop') {
    if (action === 'scheduler' || action === 'due') {
      await repeat({ flags, s, targetType: 'scheduler', target: 'due', run: () => runDueAutomations(s) });
      return;
    }
    if (action === 'automation') {
      if (!subaction) usage('Missing automation name');
      await repeat({ flags, s, targetType: 'automation', target: subaction, run: () => runAutomationByName(s, subaction, { trigger: 'loop' }) });
      return;
    }
    if (action === 'action') {
      if (!subaction) usage('Missing action id');
      const actionId = String(subaction);
      const automation = {
        id: id('loop', actionId),
        name: `loop_${actionId.replace(/[^a-z0-9_]+/gi, '_')}`,
        actionId,
        schedule: '* * * * *',
        profileId: flags.profile ? String(flags.profile) : null,
        enabled: true,
        config: parseConfig(flags),
        consecutiveFailures: 0
      };
      await repeat({ flags, s, targetType: 'action', target: actionId, run: () => runAutomation(s, automation, { trigger: 'loop' }) });
      return;
    }
    usage('Missing loop target: scheduler, automation, or action');
  }
  if (group === 'agents' && action === 'add') {
    if (!subaction) usage('Missing agent name');
    let args = [];
    if (flags.args) {
      try {
        args = JSON.parse(String(flags.args));
      } catch (e) {
        usage(`Invalid --args JSON: ${e.message}`);
      }
    }
    if (!Array.isArray(args)) usage('--args must be a JSON array');
    out(await addAgent(String(subaction), {
      command: String(requireFlag(flags, 'command')),
      args,
      transport: flags.transport ? String(flags.transport) : 'stdin-json'
    }, { workspace: s.root }));
    return;
  }
  if (group === 'agents' && action === 'list') {
    out(await listAgents({ workspace: s.root }));
    return;
  }
  if (group === 'agents' && action === 'test') {
    if (!subaction) usage('Missing agent name');
    out(await testAgent(String(subaction), { workspace: s.root, timeoutMs: flags.timeout ? numberFlag(flags, 'timeout', 120000, { min: 1000 }) : undefined }));
    return;
  }
  if (group === 'browser' && action === 'status') {
    out(await browserStatus({ workspace: s.root, name: subaction ? String(subaction) : undefined }));
    return;
  }
  if (group === 'browser' && action === 'login') {
    if (!subaction) usage('Missing browser profile name');
    const result = await loginPersistentProfile({ workspace: s.root, name: String(subaction), url: String(requireFlag(flags, 'url')) });
    audit(s, 'browser.login.completed', 'browser_profile', String(subaction), { profile: String(subaction), loginOrigin: result.loginOrigin });
    save(s);
    out(result);
    return;
  }
  if (group === 'browser' && action === 'fetch') {
    if (!subaction) usage('Missing browser profile name');
    out(await authenticatedFetch({ workspace: s.root, name: String(subaction), url: String(requireFlag(flags, 'url')), selector: flags.selector ? String(flags.selector) : undefined }));
    return;
  }
  if (group === 'browser' && action === 'cookies' && subaction === 'import') {
    const profile = rest[0];
    if (!profile) usage('Missing browser profile name');
    const result = await importCookies({ workspace: s.root, name: String(profile), file: String(requireFlag(flags, 'file')) });
    audit(s, 'browser.cookies.imported', 'browser_profile', String(profile), { profile: String(profile), cookieCount: result.cookieCount });
    save(s);
    out(result);
    return;
  }
  if (group === 'browser' && action === 'cookies' && subaction === 'export') {
    const profile = rest[0];
    if (!profile) usage('Missing browser profile name');
    const result = await exportCookies({ workspace: s.root, name: String(profile), file: String(requireFlag(flags, 'file')) });
    audit(s, 'browser.cookies.exported', 'browser_profile', String(profile), { profile: String(profile), cookieCount: result.cookieCount });
    save(s);
    out(result);
    return;
  }
  if (group === 'browser' && action === 'script' && subaction === 'add') {
    const name = rest[0];
    if (!name) usage('Missing browser script name');
    const result = await registerScript({ workspace: s.root, name: String(name), file: String(requireFlag(flags, 'file')), sideEffecting: Boolean(flags['side-effecting']) });
    audit(s, 'browser.script.registered', 'browser_script', String(name), { scriptName: String(name), scriptHash: result.scriptHash, sideEffecting: result.sideEffecting });
    save(s);
    out(result);
    return;
  }
  if (group === 'browser' && action === 'run') {
    if (!subaction) usage('Missing browser profile name');
    const scriptName = String(requireFlag(flags, 'script'));
    const allowSideEffects = Boolean(flags['allow-side-effects']);
    let input = null;
    if (flags.input) {
      try {
        input = JSON.parse(fs.readFileSync(String(flags.input), 'utf8'));
      } catch (e) {
        usage(`Invalid --input JSON file: ${e.message}`);
      }
    }
    try {
      const result = await runRegisteredScript({ workspace: s.root, profile: String(subaction), url: String(requireFlag(flags, 'url')), script: scriptName, input, allowSideEffects });
      audit(s, 'browser.script.completed', 'browser_script', scriptName, result.audit, allowSideEffects ? 'user_configured_browser' : 'none');
      save(s);
      out(result);
    } catch (error) {
      audit(s, 'browser.script.failed', 'browser_script', scriptName, { scriptName, allowSideEffects, status: 'failed', code: error?.code || 'browser_script_failed' }, allowSideEffects ? 'user_configured_browser' : 'none');
      save(s);
      throw error;
    }
    return;
  }
  if (group === 'mcp') {
    startMcp(s);
    return;
  }
  usage(`Unknown command: ${argv.join(' ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    const wantsJson = process.argv.includes('--json');
    const payload = normalizedError(e);
    if (wantsJson) console.error(JSON.stringify(payload, null, 2));
    else console.error(`jobos: ${payload.error.message}`);
    process.exitCode = e?.exitCode || (payload.error.type === 'usage' ? 2 : 1);
  });
}
