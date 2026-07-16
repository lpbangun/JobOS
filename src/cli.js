#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit, openStore, save } from './db.js';
import { id, parseJson, paths, splitCsv, workspaceRoot } from './utils.js';
import { createProfile, addProof } from './profiles.js';
import { dedupeJobs, importText, importUrl } from './jobs.js';
import { tailor } from './tailoring.js';
import { appCreate, appUpdate, due } from './tracking.js';
import { addStakeholder, research } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan, discoverContacts, promoteStakeholder, suppressContact } from './research/contacts.js';
import { importNetworkCsv, mapReachableNetwork } from './research/network.js';
import { funnel, renderFunnelMarkdown, weekly } from './analytics.js';
import { web } from './web.js';
import { prepInterview } from './interview.js';
import { startMcp } from './mcp.js';
import { addWatchlist, configFromFlags, createSearch, listSearches, listWatchlist, runAllSearches, runSavedSearch } from './discovery.js';
import { createAutomation, listAutomations, setAutomationEnabled } from './scheduler/store.js';
import { recentRuns, runAutomation, runAutomationByName, runDueAutomations, schedulerStatus, startScheduler } from './scheduler/core.js';
import { addAnswer, listAnswers } from './answers.js';
import { listNetworkContacts, listNetworkEdges } from './workflows.js';
import { addAgent, listAgents, testAgent } from './agents.js';
import { callDomainTool } from './domain-tools.js';
import { authenticatedFetch, browserStatus, exportCookies, importCookies, loginPersistentProfile, registerScript, runRegisteredScript } from './browser.js';
import { buildTuiModel } from './tui-model.js';
import { defaultTuiState, renderTui, startTui } from './tui.js';

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
  };
}

export const commandRegistry = [
  cmd(['init'], 'jobos init [--json]', 'Create or verify the local database and agent-readable workspace.'),
  cmd(['agent-guide'], 'jobos agent-guide [--json]', 'Print the machine-oriented guide for external agents.'),
  cmd(['tui'], 'jobos tui [--profile <profile-id>] [--agent off] [--snapshot] [--width 140] [--height 42] [--json]', 'Open the locked data-bound terminal product shell with an embedded ACP agent pane.', { flags: ['--agent off', '--snapshot', '--width <columns>', '--height <rows>'], category: 'workflow' }),
  cmd(['daily'], 'jobos daily --profile <profile-id> [--json]', 'Run every saved discovery source for a profile and rank the combined results.', { category: 'workflow' }),
  cmd(['pursue'], 'jobos pursue <job-id> --profile <profile-id> [--agent <name>] [--stage <name>] [--dry-run] [--json]', 'Run integrated fit, research, networking, application preparation, and outreach planning.', { flags: ['--stage <name>', '--stage-timeout <ms>', '--dry-run'], category: 'workflow' }),
  cmd(['profile', 'create'], 'jobos profile create <name> [--from-resume file] [--json]', 'Create a target profile and optionally import resume proof text.', { flags: ['--from-resume <file>', '--preferences <json>'] }),
  cmd(['proof', 'add'], 'jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b] [--json]', 'Add an evidence-backed proof point to a profile.', { flags: ['--summary <text>', '--evidence <text>', '--skills a,b'] }),
  cmd(['answers', 'add'], 'jobos answers add --profile <profile-id> --category <category> --question <text> --answer <text> [--sensitivity personal] [--json]', 'Store a verified reusable application answer locally.', { flags: ['--category <category>', '--question <text>', '--answer <text>', '--sensitivity <class>', '--reuse <scope>', '--status <status>', '--source <ref>', '--employer <name>'] }),
  cmd(['answers', 'list'], 'jobos answers list --profile <profile-id> [--category <category>] [--json]', 'List local answers with sensitive values redacted.', { flags: ['--category <category>', '--status <status>'] }),
  cmd(['answers', 'match'], 'jobos answers match --profile <profile-id> --questions <json-file> [--employer <name>] [--json]', 'Match verified non-sensitive answers to application questions.', { flags: ['--questions <json-file>', '--employer <name>'] }),
  cmd(['jobs', 'import-text'], 'jobos jobs import-text --profile <profile> --file <path> [--json]', 'Import a job description from a local text or Markdown file.', { flags: ['--file <path>'] }),
  cmd(['jobs', 'import-url'], 'jobos jobs import-url <url> --profile <profile> [--json]', 'Import a human-provided public job URL.'),
  cmd(['jobs', 'list'], 'jobos jobs list [--json]', 'List imported jobs.'),
  cmd(['jobs', 'dedupe'], 'jobos jobs dedupe [--apply] [--json]', 'Find likely duplicate jobs and optionally apply local dedupe updates.', { flags: ['--apply'] }),
  cmd(['searches', 'create'], 'jobos searches create <name> --profile <profile> --adapter greenhouse|lever|ashby|career-page|portfolio [--board-token token|--company handle|--url URL] [--keywords a,b] [--location remote] [--json]', 'Create a routed public-source discovery search.', { flags: ['--adapter <id>', '--board-token <token>', '--company <handle>', '--handle <handle>', '--url <url>', '--max-companies <n>', '--keywords a,b', '--location <text>', '--min-fit <n>'] }),
  cmd(['searches', 'list'], 'jobos searches list [--json]', 'List saved discovery searches.'),
  cmd(['watchlist', 'add'], 'jobos watchlist add --company <company> --adapter greenhouse|lever --board-token <token>|--handle <handle> [--notes text] [--json]', 'Add a company to the local discovery watchlist.'),
  cmd(['watchlist', 'list'], 'jobos watchlist list [--json]', 'List watchlist companies.'),
  cmd(['discover', 'run'], 'jobos discover run --search <name-or-id> [--json]', 'Run one saved discovery search and queue results for review.'),
  cmd(['discover', 'run-all'], 'jobos discover run-all [--profile <profile>] [--json]', 'Run all saved discovery searches, optionally scoped to a profile.'),
  cmd(['score'], 'jobos score <job-id> --profile <profile> [--json]', 'Score one job against a profile.'),
  cmd(['tailor', 'resume'], 'jobos tailor resume --job <job-id> --profile <profile> [--output markdown] [--json]', 'Create an evidence-grounded tailored resume draft.', { output: 'object-or-markdown' }),
  cmd(['tailor', 'cover-letter'], 'jobos tailor cover-letter --job <job-id> --profile <profile> [--output markdown] [--json]', 'Create an evidence-grounded cover letter draft.', { output: 'object-or-markdown' }),
  cmd(['applications', 'create'], 'jobos applications create --job <job-id> --status <status> [--json]', 'Create or upsert a local application tracking record.'),
  cmd(['applications', 'update'], 'jobos applications update <application-id> --status <status> [--json]', 'Update a tracked application status.'),
  cmd(['research', 'company'], 'jobos research company --job <job-id> [--json]', 'Create a source-backed company research worksheet.'),
  cmd(['research', 'stakeholders'], 'jobos research stakeholders --job <job-id> [--json]', 'Create a source-backed stakeholder worksheet.'),
  cmd(['research', 'contacts'], 'jobos research contacts --job <job-id>|--stakeholder <stakeholder-id> [--json]', 'Discover source-backed contact points, email patterns, and public profile paths for review.', { flags: ['--job <job-id>', '--stakeholder <stakeholder-id>'] }),
  cmd(['research', 'approve-contact'], 'jobos research approve-contact --contact <contact-id>|--worksheet-candidate <candidate-id> [--json]', 'Mark a discovered contact point as human-approved for later draft use.', { flags: ['--contact <contact-id>', '--worksheet-candidate <candidate-id>'] }),
  cmd(['research', 'suppress-contact'], 'jobos research suppress-contact --contact <contact-id> --reason <text> [--json]', 'Mark a discovered contact point as do-not-use in local state.', { flags: ['--contact <contact-id>', '--reason <text>'] }),
  cmd(['research', 'promote-stakeholder'], 'jobos research promote-stakeholder --candidate <candidate-id> [--json]', 'Promote a staged person candidate to a local stakeholder record.', { flags: ['--candidate <candidate-id>'] }),
  cmd(['research', 'network'], 'jobos research network --job <job-id> [--json]', 'Create a local reachable-network path ladder for a job.', { flags: ['--job <job-id>'] }),
  cmd(['network', 'import'], 'jobos network import --file <csv> [--json]', 'Import local relationship edges from a CSV file.', { flags: ['--file <csv>'] }),
  cmd(['network', 'paths'], 'jobos network paths --job <job-id> [--json]', 'Rank reachable introduction and advice paths for a job.', { flags: ['--job <job-id>'], category: 'workflow' }),
  cmd(['network', 'contacts'], 'jobos network contacts --job <job-id> [--json]', 'List ranked source-backed contacts for a job.', { flags: ['--job <job-id>'], category: 'workflow' }),
  cmd(['network', 'list'], 'jobos network list [--json]', 'List imported relationship edges.', { category: 'workflow' }),
  cmd(['research', 'add-stakeholder'], 'jobos research add-stakeholder --job <job-id> --source-url <url> [--name <name>] [--role <role>] [--text <text>|--file <path>] [--json]', 'Record a stakeholder from user-provided source text and a required public source URL.', { flags: ['--job <job-id>', '--source-url <url>', '--name <name>', '--role <role>', '--text <text>', '--file <path>'] }),
  cmd(['outreach', 'draft'], 'jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile-id> [--goal informational] [--plan <plan-id>] [--contact <contact-id>] [--json]', 'Draft human-reviewed outreach without sending it.', { flags: ['--job <job-id>', '--stakeholder <stakeholder-id>', '--profile <profile-id>', '--goal <goal>', '--plan <plan-id>', '--contact <contact-id>'] }),
  cmd(['outreach', 'plan'], 'jobos outreach plan --job <job-id> --profile <profile-id> [--stakeholder <stakeholder-id>] [--goal informational] [--json]', 'Rank a reviewable outreach path from discovered contacts, network edges, and profile evidence.', { flags: ['--job <job-id>', '--profile <profile-id>', '--stakeholder <stakeholder-id>', '--goal <goal>'] }),
  cmd(['outreach', 'mark-sent'], 'jobos outreach mark-sent --artifact <artifact-id> --channel <email|linkedin|other> [--notes text] [--json]', 'Record that a human sent an outreach draft outside JobOS.', { flags: ['--artifact <artifact-id>', '--channel <email|linkedin|other>', '--notes <text>'] }),
  cmd(['outreach', 'schedule-followup'], 'jobos outreach schedule-followup --thread <thread-id> --after <days> [--json]', 'Create a local follow-up task for an outreach thread.', { flags: ['--thread <thread-id>', '--after <days>'] }),
  cmd(['outreach', 'due'], 'jobos outreach due [--json]', 'List due outreach follow-up tasks without sending anything.'),
  cmd(['interview', 'prep'], 'jobos interview prep --application <application-id> --stage <stage> [--output markdown] [--json]', 'Create an interview prep packet.', { output: 'object-or-markdown' }),
  cmd(['analytics', 'funnel'], 'jobos analytics funnel --profile <profile> [--since 30] [--output markdown] [--json]', 'Report funnel analytics for a profile.', { output: 'object-or-markdown' }),
  cmd(['tasks', 'due'], 'jobos tasks due [--watch] [--interval N] [--max-iterations N] [--json]', 'List due tasks, optionally watching on an interval.', { output: 'array-or-jsonl' }),
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
  cmd(['loop', 'scheduler'], 'jobos loop scheduler [--interval N] [--max-iterations N] [--json]', 'Repeatedly run due scheduler automations with JSONL loop events.', { output: 'jsonl' }),
  cmd(['loop', 'automation'], 'jobos loop automation <name> [--interval N] [--max-iterations N] [--json]', 'Repeatedly run one named automation through scheduler machinery.', { output: 'jsonl' }),
  cmd(['loop', 'action'], 'jobos loop action <action-id> [--profile <profile>] [--config JSON] [--interval N] [--max-iterations N] [--json]', 'Repeatedly run one scheduler action through an ephemeral automation.', { output: 'jsonl' }),
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
  cmd(['web'], 'jobos web [--port 4317] [--host 127.0.0.1]', 'Start the local web dashboard and REST API.', { output: 'server' })
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
      tests: c.tests
    }))
  };
}

function renderAgentGuide() {
  const commands = commandRegistry.map(c => `- \`${c.usage}\`: ${c.summary} Output: ${c.output}.`).join('\n');
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

function dueTasks(s) {
  return due(s).map(t => ({
    id: t.id,
    title: t.title,
    dueAt: t.due_at,
    priority: t.priority,
    status: t.status,
    jobId: t.job_id
  }));
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
  s.suppressBootstrapNotice = ['mcp', 'web', 'tui'].includes(group);
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
    out({ id: r.profile.id, name: r.profile.name, created: r.created, preferences: parseJson(r.profile.preferences_json, {}) });
    return;
  }
  if (group === 'proof' && action === 'add') {
    const summary = requireFlag(flags, 'summary');
    const p = addProof(s, needProfile(flags), String(summary), flags.evidence ? String(flags.evidence) : '', flags.skills ? splitCsv(flags.skills) : []);
    out({ id: p.id, profileId: p.profile_id, summary: p.summary });
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
  if (group === 'watchlist' && action === 'add') {
    const company = flags.company ? String(flags.company) : [subaction, ...rest].filter(Boolean).join(' ');
    if (!company) usage('Missing --company <company>');
    const handle = flags['board-token'] || flags.handle || '';
    const item = addWatchlist(s, { company, adapter: String(flags.adapter || ''), handle: String(handle), notes: flags.notes ? String(flags.notes) : '' });
    out(item);
    return;
  }
  if (group === 'watchlist' && action === 'list') {
    out(listWatchlist(s));
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
    const r = await tailor(s, jobId, needProfile(flags), 'resume');
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
  if (group === 'applications' && action === 'create') {
    if (!flags.job || !flags.status) usage('Missing --job or --status');
    const a = appCreate(s, flags.job, String(flags.status), flags.notes ? String(flags.notes) : '');
    out({ id: a.id, jobId: a.job_id, profileId: a.profile_id, status: a.status });
    return;
  }
  if (group === 'applications' && action === 'update') {
    if (!subaction || !flags.status) usage('Missing application id or --status');
    const a = appUpdate(s, subaction, String(flags.status), flags.notes ? String(flags.notes) : null);
    out({ id: a.id, jobId: a.job_id, profileId: a.profile_id, status: a.status });
    return;
  }
  if (group === 'research' && action === 'company') {
    const jobId = requireFlag(flags, 'job');
    out(await research(s, jobId, 'company'));
    return;
  }
  if (group === 'research' && action === 'stakeholders') {
    const jobId = requireFlag(flags, 'job');
    out(await research(s, jobId, 'stakeholders'));
    return;
  }
  if (group === 'research' && action === 'contacts') {
    if (!flags.job && !flags.stakeholder) usage('Missing --job <job-id> or --stakeholder <stakeholder-id>');
    out(await discoverContacts(s, { jobId: flags.job ? String(flags.job) : null, stakeholderId: flags.stakeholder ? String(flags.stakeholder) : null }));
    return;
  }
  if (group === 'research' && action === 'approve-contact') {
    const contactId = flags.contact || flags['worksheet-candidate'];
    if (!contactId) usage('Missing --contact <contact-id> or --worksheet-candidate <candidate-id>');
    out(approveContact(s, { contactId: String(contactId) }));
    return;
  }
  if (group === 'research' && action === 'suppress-contact') {
    const contactId = requireFlag(flags, 'contact', '--contact <contact-id>');
    out(suppressContact(s, { contactId: String(contactId), reason: flags.reason ? String(flags.reason) : 'user_suppressed' }));
    return;
  }
  if (group === 'research' && action === 'promote-stakeholder') {
    const candidateId = requireFlag(flags, 'candidate', '--candidate <candidate-id>');
    out(promoteStakeholder(s, { candidateId: String(candidateId) }));
    return;
  }
  if (group === 'research' && action === 'network') {
    const jobId = requireFlag(flags, 'job');
    out(mapReachableNetwork(s, { jobId: String(jobId) }));
    return;
  }
  if (group === 'network' && action === 'import') {
    const filePath = requireFlag(flags, 'file', '--file <csv>');
    out(importNetworkCsv(s, { filePath: String(filePath) }));
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
  if (group === 'outreach' && action === 'draft') {
    if (!flags.plan && (!flags.job || !flags.stakeholder)) usage('Missing --job/--stakeholder or --plan');
    const r = await draftOutreach(s, { jobId: flags.job ? String(flags.job) : null, profileId: needProfile(flags), stakeholderId: flags.stakeholder ? String(flags.stakeholder) : null, goal: flags.goal ? String(flags.goal) : 'informational', planId: flags.plan ? String(flags.plan) : null, contactId: flags.contact ? String(flags.contact) : null });
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
  if (group === 'tasks' && action === 'due') {
    if (flags.watch) {
      await repeat({ flags, s, eventType: 'watch.iteration', targetType: 'tasks', target: 'due', run: () => ({ tasks: dueTasks(s), checkedAt: new Date().toISOString() }) });
    } else {
      out(dueTasks(s));
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
  if (group === 'web') {
    const port = flags.port ? Number(flags.port) : 4317;
    const host = flags.host ? String(flags.host) : '127.0.0.1';
    const server = web(s, { port, host, onReady: () => console.log(`JobOS dashboard running at http://${host}:${port}`) });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
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
