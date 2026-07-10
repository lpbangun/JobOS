#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './db.js';
import { id, parseJson, paths, splitCsv, workspaceRoot } from './utils.js';
import { createProfile, addProof } from './profiles.js';
import { dedupeJobs, importText, importUrl, listJobs } from './jobs.js';
import { score } from './scoring.js';
import { tailor } from './tailoring.js';
import { appCreate, appUpdate, due } from './tracking.js';
import { addStakeholder, research } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { funnel, renderFunnelMarkdown, weekly } from './analytics.js';
import { web } from './web.js';
import { prepInterview } from './interview.js';
import { startMcp } from './mcp.js';
import { addWatchlist, configFromFlags, createSearch, listSearches, listWatchlist, runAllSearches, runSavedSearch } from './discovery.js';
import { createAutomation, listAutomations, setAutomationEnabled } from './scheduler/store.js';
import { recentRuns, runAutomation, runAutomationByName, runDueAutomations, schedulerStatus, startScheduler } from './scheduler/core.js';

const globalFlags = [
  '--workspace <dir>',
  '--profile <profile-id>',
  '--json',
  '--quiet',
  '--help'
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
    tests: opts.tests || ['tests/sprint9-frontend.test.js']
  };
}

export const commandRegistry = [
  cmd(['init'], 'jobos init [--json]', 'Create or verify the local database and agent-readable workspace.'),
  cmd(['agent-guide'], 'jobos agent-guide [--json]', 'Print the machine-oriented guide for external agents.'),
  cmd(['profile', 'create'], 'jobos profile create <name> [--from-resume file] [--json]', 'Create a target profile and optionally import resume proof text.', { flags: ['--from-resume <file>', '--preferences <json>'] }),
  cmd(['proof', 'add'], 'jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b] [--json]', 'Add an evidence-backed proof point to a profile.', { flags: ['--summary <text>', '--evidence <text>', '--skills a,b'] }),
  cmd(['jobs', 'import-text'], 'jobos jobs import-text --profile <profile> --file <path> [--json]', 'Import a job description from a local text or Markdown file.', { flags: ['--file <path>'] }),
  cmd(['jobs', 'import-url'], 'jobos jobs import-url <url> --profile <profile> [--json]', 'Import a human-provided public job URL.'),
  cmd(['jobs', 'list'], 'jobos jobs list [--json]', 'List imported jobs.'),
  cmd(['jobs', 'dedupe'], 'jobos jobs dedupe [--apply] [--json]', 'Find likely duplicate jobs and optionally apply local dedupe updates.', { flags: ['--apply'] }),
  cmd(['searches', 'create'], 'jobos searches create <name> --profile <profile> --adapter greenhouse|lever [--board-token token|--company handle] [--keywords a,b] [--location remote] [--min-fit 70] [--json]', 'Create a saved public ATS discovery search.'),
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
  cmd(['research', 'add-stakeholder'], 'jobos research add-stakeholder --job <job-id> --source-url <url> [--name <name>] [--role <role>] [--text <text>|--file <path>] [--json]', 'Record a stakeholder from user-provided source text and a required public source URL.', { flags: ['--job <job-id>', '--source-url <url>', '--name <name>', '--role <role>', '--text <text>', '--file <path>'] }),
  cmd(['outreach', 'draft'], 'jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile-id> [--goal informational] [--json]', 'Draft human-reviewed outreach without sending it.'),
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

function renderRootHelp() {
  const lines = commandRegistry.map(c => `  ${c.usage}`).join('\n');
  return `JobOS local-first MVP

Usage:
  jobos <command> [flags]

Commands:
${lines}

Global flags:
  ${globalFlags.join('\n  ')}

Run "jobos <command> --help" for command-specific help.`;
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
    version: 1,
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
      tests: c.tests
    }))
  };
}

function renderAgentGuide() {
  const commands = commandRegistry.map(c => `- \`${c.usage}\`: ${c.summary} Output: ${c.output}.`).join('\n');
  return `# JobOS Agent Guide

JobOS is local-first. Use the CLI as the primary control surface and inspect \`jobos-workspace/\` files when useful. External actions are user-initiated; auto-apply and auto-send are planned for future phases. Use --json for machine-readable output.

## Global Rules

- Prefer \`--json\` for one-shot commands.
- Streaming commands use one JSON object per line.
- Use \`--workspace <dir>\` or \`JOBOS_HOME\` to select state.
- Commands are non-interactive; pass flags instead of waiting for prompts.
- Exit codes: \`0\` success, \`1\` runtime/domain error, \`2\` usage error.
- JSON errors are written to stderr as \`{"ok":false,"error":{"code":"...","type":"...","message":"..."}}\`.
- Generated resumes, cover letters, research, interview prep, and outreach are drafts requiring human review.

## Commands

${commands}

## Minimal Non-Interactive Flow

\`\`\`bash
jobos agent-guide --json
jobos profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json
jobos jobs import-text --profile pm-edtech --file samples/job-description.md --json
jobos jobs list --json
jobos score <job-id> --profile pm-edtech --json
jobos tailor resume --job <job-id> --profile pm-edtech --json
jobos applications create --job <job-id> --status materials-ready --json
jobos tasks due --json
jobos loop scheduler --max-iterations 1 --json
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
  if (!flags[name]) usage(`Missing ${display}`);
  return flags[name];
}

function numberFlag(flags, name, fallback, { min = 0 } = {}) {
  const raw = flags[name] ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) usage(`Invalid --${name}: ${raw}`);
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
  return {
    ok: false,
    error: {
      code: e?.code || (isUsage ? 'usage_error' : 'runtime_error'),
      type: isUsage ? 'usage' : 'runtime',
      message: e?.message || String(e)
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parse(argv);
  const flags = parsed.flags;
  const [group, action, subaction, ...rest] = parsed._;

  if (!group || group === 'help' || flags.help) {
    const parts = group === 'help' ? parsed._.slice(1) : parsed._;
    if (flags.json) output(parts.length ? commandFor(parts) || registryJson() : registryJson(), flags);
    else console.log(parts.length ? renderCommandHelp(parts) : renderRootHelp());
    return;
  }

  const boot = bootstrapInfo(flags);
  const s = await openStore(flags);
  s.bootstrapCreated = boot.created;
  s.bootstrapNoticeEmitted = false;
  s.suppressBootstrapNotice = ['mcp', 'web'].includes(group);
  const out = value => output(value, flags, s);
  const text = value => printText(value, flags, s);

  if (group === 'init') {
    out({ ok: true, root: s.root, database: s.p.db, workspace: s.p.ws, policy: { externalActions: 'user_configured' } });
    return;
  }
  if (group === 'agent-guide') {
    if (flags.json) out(registryJson());
    else text(renderAgentGuide());
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
    out(listJobs(s).map(x => ({ id: x.id, title: x.title, company: x.company, profileId: x.profile_id, score: x.fit_score, applicationStatus: x.application_status || null, url: String(x.url || '').startsWith('jobos:text:') ? '' : x.url || '' })));
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
    out(await score(s, action, needProfile(flags)));
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
  if (group === 'research' && action === 'add-stakeholder') {
    const jobId = requireFlag(flags, 'job');
    const sourceUrl = requireFlag(flags, 'source-url', '--source-url <url>');
    const textInput = flags.file ? fs.readFileSync(String(flags.file), 'utf8') : (flags.text ? String(flags.text) : '');
    if (!textInput && !flags.name) usage('Missing --text, --file, or --name for stakeholder source context');
    out(await addStakeholder(s, { jobId, sourceUrl: String(sourceUrl), name: flags.name ? String(flags.name) : '', role: flags.role ? String(flags.role) : '', text: textInput }));
    return;
  }
  if (group === 'outreach' && action === 'draft') {
    if (!flags.job || !flags.stakeholder) usage('Missing --job or --stakeholder');
    const r = await draftOutreach(s, { jobId: flags.job, profileId: needProfile(flags), stakeholderId: flags.stakeholder, goal: flags.goal ? String(flags.goal) : 'informational' });
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
