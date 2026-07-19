#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, reload, one } from '../src/db.js';
import { selectedJobContext } from '../src/domain-tools.js';
import { redactSensitive } from '../src/acp.js';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const name = value.slice(2);
    flags[name] = index + 1 < argv.length && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return flags;
}

function parseToolResult(response) {
  const text = response?.result?.content?.find(item => item?.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

class McpProcessClient {
  constructor({ root, transcriptPath, timeoutMs = 30_000 }) {
    this.root = root;
    this.transcriptPath = transcriptPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child = null;
    this.exit = null;
  }

  record(direction, message) {
    const row = {
      timestamp: new Date().toISOString(),
      type: 'mcp_frame',
      direction,
      message: redactSensitive(message, process.env)
    };
    fs.appendFileSync(this.transcriptPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  start() {
    this.child = spawn(process.execPath, [CLI_PATH, 'mcp', '--workspace', this.root], {
      cwd: this.root,
      env: { ...process.env, JOBOS_HOME: this.root, JOBOS_WORKSPACE: this.root, JOBOS_MEDIATION: 'mcp' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384);
    });
    this.exit = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`MCP server exited before response (${code ?? signal})`));
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });
  }

  onStdout(chunk) {
    this.buffer += String(chunk);
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      this.record('server_to_client', message);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(Object.assign(new Error(message.error.message), { response: message })) : pending.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    this.record('client_to_server', message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params = {}) {
    const message = { jsonrpc: '2.0', method, params };
    this.record('client_to_server', message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop() {
    this.child.stdin.end();
    const result = await Promise.race([
      this.exit,
      new Promise(resolve => setTimeout(() => resolve(null), 5_000))
    ]);
    if (result) return result;
    this.child.kill('SIGTERM');
    return await this.exit;
  }
}

export async function runMcpDemo({ workspace, profileId, jobId, output = null, timeoutMs = 30_000 } = {}) {
  const root = path.resolve(workspace || process.env.JOBOS_HOME || process.cwd());
  const transcriptPath = path.resolve(output || path.join(process.cwd(), '.tmp', 'mcp-demo-transcript.jsonl'));
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '', { mode: 0o600 });
  fs.chmodSync(transcriptPath, 0o600);

  const store = await openStore({ workspace: root });
  const context = selectedJobContext(store, jobId);
  const selectedProfileId = profileId || context.job.profileId;
  const before = {
    context,
    scoreAudits: Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [jobId])?.count || 0)
  };

  const client = new McpProcessClient({ root, transcriptPath, timeoutMs: Number(timeoutMs) });
  client.start();
  let initialize;
  let list;
  let scoreResponse;
  let contextResponse;
  let exit;
  try {
    initialize = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'jobos-mcp-demo', version: '0.1.0' }
    });
    client.notify('notifications/initialized');
    list = await client.request('tools/list');
    scoreResponse = await client.request('tools/call', {
      name: 'score_job',
      arguments: { jobId, profileId: selectedProfileId }
    });
    contextResponse = await client.request('tools/call', {
      name: 'get_job_context',
      arguments: { jobId }
    });
  } finally {
    exit = await client.stop();
  }

  reload(store);
  const after = {
    context: selectedJobContext(store, jobId),
    scoreAudits: Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [jobId])?.count || 0)
  };
  const score = parseToolResult(scoreResponse);
  const mediatedContext = parseToolResult(contextResponse);
  const toolNames = (list?.result?.tools || []).map(tool => tool.name);
  const summary = {
    ok: initialize?.result?.serverInfo?.name === 'jobos'
      && toolNames.includes('score_job')
      && toolNames.includes('get_job_context')
      && Number.isFinite(score?.overall)
      && mediatedContext?.fit?.overall === score.overall
      && after.context.fit?.overall === score.overall
      && after.scoreAudits > before.scoreAudits
      && exit?.code === 0,
    workspace: root,
    profileId: selectedProfileId,
    jobId,
    server: initialize?.result?.serverInfo || null,
    protocolVersion: initialize?.result?.protocolVersion || null,
    toolCount: toolNames.length,
    calledTools: ['score_job', 'get_job_context'],
    scoreAuditDelta: after.scoreAudits - before.scoreAudits,
    fitBefore: before.context.fit,
    fitAfter: after.context.fit,
    exit,
    stderr: redactSensitive(client.stderr, process.env),
    transcript: transcriptPath
  };
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'summary', ...summary })}\n`, { mode: 0o600 });
  if (!summary.ok) throw Object.assign(new Error(`MCP demo did not meet the protocol/state bar; inspect ${transcriptPath}`), { summary });
  return summary;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (typeof flags.job !== 'string' || !flags.job) throw new Error('Missing --job <job-id>');
  const summary = await runMcpDemo({
    workspace: flags.workspace,
    profileId: flags.profile || null,
    jobId: String(flags.job),
    output: flags.output || null,
    timeoutMs: typeof flags.timeout === 'string' && Number.isFinite(Number(flags.timeout)) ? Number(flags.timeout) : 30_000
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`jobos-mcp-demo: ${error.message}`);
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    process.exitCode = 1;
  });
}
