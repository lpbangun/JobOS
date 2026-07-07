import { score } from './scoring.js';
import { tailor } from './tailoring.js';
import { research } from './research.js';
import { draftOutreach, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { appCreate, appUpdate, due } from './tracking.js';
import { weekly } from './analytics.js';
import { prepInterview } from './interview.js';
import { importUrl } from './jobs.js';
import { listSearches, runSavedSearch } from './discovery.js';
import { listAutomations } from './scheduler/store.js';
import { recentRuns, runAutomationByName } from './scheduler/core.js';

const tools = [
  { name: 'score_job', description: 'Score a job against a profile.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, profileId: { type: 'string' } }, required: ['jobId', 'profileId'] } },
  { name: 'tailor_resume', description: 'Create an evidence-grounded tailored resume draft.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, profileId: { type: 'string' } }, required: ['jobId', 'profileId'] } },
  { name: 'draft_cover_letter', description: 'Create an evidence-grounded cover letter draft.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, profileId: { type: 'string' } }, required: ['jobId', 'profileId'] } },
  { name: 'research_company', description: 'Create a source-backed company dossier for a job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } },
  { name: 'draft_outreach', description: 'Draft human-reviewed outreach for a stakeholder.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, stakeholderId: { type: 'string' }, profileId: { type: 'string' }, goal: { type: 'string' } }, required: ['jobId', 'stakeholderId', 'profileId'] } },
  { name: 'mark_outreach_sent', description: 'Record that a human sent an outreach draft outside JobOS.', inputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, channel: { type: 'string', enum: ['email', 'linkedin', 'other'] }, notes: { type: 'string' } }, required: ['artifactId', 'channel'] } },
  { name: 'schedule_outreach_followup', description: 'Create a local follow-up task for an outreach thread.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, afterDays: { type: 'number' } }, required: ['threadId', 'afterDays'] } },
  { name: 'list_outreach_due', description: 'List due outreach follow-up tasks without sending anything.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_application', description: 'Create a local application tracking record.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['jobId', 'status'] } },
  { name: 'update_application_status', description: 'Update a tracked application status.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['applicationId', 'status'] } },
  { name: 'list_tasks', description: 'List open tasks ordered by due date.', inputSchema: { type: 'object', properties: {} } },
  { name: 'interview_prep', description: 'Create an interview prep packet for an application and stage.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, stage: { type: 'string' } }, required: ['applicationId'] } },
  { name: 'weekly_review', description: 'Generate weekly review and funnel insights.', inputSchema: { type: 'object', properties: { profileId: { type: 'string' } }, required: ['profileId'] } },
  { name: 'list_saved_searches', description: 'List configured local discovery searches.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_jobs', description: 'Run a saved discovery search and queue results for human review.', inputSchema: { type: 'object', properties: { search: { type: 'string' } }, required: ['search'] } },
  { name: 'import_job_url', description: 'Import a human-provided job URL into local JobOS state.', inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, url: { type: 'string' } }, required: ['profileId', 'url'] } },
  { name: 'list_automations', description: 'List configured local automations and schedules.', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_automation', description: 'Run an automation manually through the audited scheduler path.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'list_automation_runs', description: 'List recent automation runs.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } }
];

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function callTool(s, name, args = {}) {
  if (name === 'score_job') return result(await score(s, args.jobId, args.profileId));
  if (name === 'tailor_resume') return result(await tailor(s, args.jobId, args.profileId, 'resume'));
  if (name === 'draft_cover_letter') return result(await tailor(s, args.jobId, args.profileId, 'cover'));
  if (name === 'research_company') return result(await research(s, args.jobId, 'company'));
  if (name === 'draft_outreach') return result(await draftOutreach(s, { jobId: args.jobId, stakeholderId: args.stakeholderId, profileId: args.profileId, goal: args.goal || 'informational' }));
  if (name === 'mark_outreach_sent') return result(markOutreachSent(s, { artifactId: args.artifactId, channel: args.channel, notes: args.notes || '' }));
  if (name === 'schedule_outreach_followup') return result(scheduleFollowup(s, { threadId: args.threadId, afterDays: args.afterDays }));
  if (name === 'list_outreach_due') return result(outreachDue(s));
  if (name === 'create_application') return result(appCreate(s, args.jobId, args.status, args.notes || ''));
  if (name === 'update_application_status') return result(appUpdate(s, args.applicationId, args.status, args.notes ?? null));
  if (name === 'list_tasks') return result(due(s));
  if (name === 'interview_prep') return result(await prepInterview(s, args.applicationId, args.stage || 'interview'));
  if (name === 'weekly_review') {
    const r = weekly(s, args.profileId);
    return result({ runId: r.runId, path: r.path, metrics: r.metrics });
  }
  if (name === 'list_saved_searches') return result(listSearches(s));
  if (name === 'search_jobs') return result(await runSavedSearch(s, args.search));
  if (name === 'import_job_url') return result(await importUrl(s, { profileId: args.profileId, url: args.url }));
  if (name === 'list_automations') return result(listAutomations(s));
  if (name === 'run_automation') return result(await runAutomationByName(s, args.name, { trigger: 'mcp' }));
  if (name === 'list_automation_runs') return result(recentRuns(s, args.limit || 25));
  throw Error(`Unknown MCP tool: ${name}`);
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

export function mcpToolNames() {
  return tools.map(t => t.name);
}

export function startMcp(s, { input = process.stdin } = {}) {
  let buffer = Buffer.alloc(0);
  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    while (buffer.length) {
      if (buffer.toString('utf8', 0, Math.min(buffer.length, 15)).startsWith('Content-Length:')) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buffer.toString('utf8', 0, headerEnd);
        const len = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isFinite(len)) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Missing Content-Length' } }); buffer = buffer.subarray(headerEnd + 4); continue; }
        const bodyStart = headerEnd + 4;
        if (buffer.length - bodyStart < len) break;
        const body = buffer.toString('utf8', bodyStart, bodyStart + len);
        buffer = buffer.subarray(bodyStart + len);
        handleLine(s, body);
        continue;
      }
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.toString('utf8', 0, idx).trim();
      buffer = buffer.subarray(idx + 1);
      if (line) handleLine(s, line);
    }
  });
}

async function handleLine(s, line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }); return; }
  try {
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'jobos', version: '0.1.0' }, capabilities: { tools: {} } } });
      return;
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools } }); return; }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      send({ jsonrpc: '2.0', id: msg.id, result: await callTool(s, name, args || {}) });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: e.message } });
  }
}
