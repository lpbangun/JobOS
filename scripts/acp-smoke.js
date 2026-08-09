#!/usr/bin/env node
// Live smoke: npm run acp-smoke. It self-seeds a temporary JOBOS_HOME and hard-stops before 90 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AcpClient, agentBackendCatalog, jobosMcpServer, redactSensitive } from '../src/acp.js';
import { openStore, one, reload } from '../src/db.js';
import { selectedJobContext } from '../src/domain-tools.js';
import { seedMcpDemo } from './seed-mcp-demo.js';

const MAX_RUNTIME_MS = 85_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    flags[name.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function append(records, type, value = {}) {
  records.push(redactSensitive({ timestamp: new Date().toISOString(), type, ...value }));
}

function completedGroundedTool(records) {
  const starts = new Set(records
    .filter(record => record.type === 'event'
      && record.event?.type === 'tool_start'
      && /\b(score_job|get_job_context)\b/.test(String(record.event?.title || '')))
    .map(record => record.event.toolCallId)
    .filter(Boolean));
  return records.some(record => record.type === 'event'
    && record.event?.type === 'tool_update'
    && record.event?.status === 'completed'
    && starts.has(record.event?.toolCallId));
}

export async function runAcpSmoke({ workspace = null, profileId = null, jobId = null, output = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const boundedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_RUNTIME_MS - 5_000));
  let temporaryRoot = null;
  let root = workspace ? path.resolve(workspace) : null;
  if (!root) {
    temporaryRoot = fs.mkdtempSync(path.join(tmpdir(), 'jobos-acp-smoke-'));
    const seeded = await seedMcpDemo(path.join(temporaryRoot, 'workspace'));
    root = seeded.workspace;
    profileId = seeded.profileId;
    jobId = seeded.jobId;
  }
  const transcriptPath = path.resolve(output || path.join(process.cwd(), '.tmp', 'acp-smoke-transcript.jsonl'));
  const store = await openStore({ workspace: root });
  const job = jobId
    ? one(store, 'SELECT id,profile_id,score_json FROM jobs WHERE id=?', [jobId])
    : one(store, 'SELECT id,profile_id,score_json FROM jobs ORDER BY created_at DESC LIMIT 1');
  if (!job) throw new Error('ACP smoke requires a seeded or selected JobOS job.');
  const selectedProfile = profileId || job.profile_id;
  const records = [];
  const client = new AcpClient({ root, promptTimeoutMs: boundedTimeout });
  client.on('event', event => append(records, 'event', { event }));
  client.on('state', state => append(records, 'state', { state }));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`ACP smoke exceeded ${boundedTimeout}ms`), { code: 'acp_smoke_timeout' })), boundedTimeout);
  });
  try {
    const summary = await Promise.race([(async () => {
      const catalog = await agentBackendCatalog({ root });
      const hermes = catalog.find(item => item.id === 'hermes-acp');
      if (!hermes?.available) throw new Error(`Hermes ACP unavailable: ${hermes?.readiness || 'missing'}`);
      const beforeAudits = Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [job.id])?.count || 0);
      const beforeScore = job.score_json || '';
      await client.connect({ mcpServers: [jobosMcpServer(root, { allowAgentAttestation: false })] });
      const turn = await client.prompt(
        `Call score_job with jobId ${job.id} and profileId ${selectedProfile}, then call get_job_context for ${job.id}. Report the stored FIT status in one sentence. Do not use shell, filesystem, browser, or web tools.`,
        { context: selectedJobContext(store, job.id, selectedProfile), timeoutMs: boundedTimeout }
      );
      reload(store);
      const afterRow = one(store, 'SELECT score_json FROM jobs WHERE id=?', [job.id]);
      const afterAudits = Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [job.id])?.count || 0);
      const visibleMutation = afterAudits > beforeAudits || String(afterRow?.score_json || '') !== String(beforeScore);
      const groundedToolUse = completedGroundedTool(records);
      const result = {
        ok: turn?.stopReason === 'end_turn' && (visibleMutation || groundedToolUse),
        workspace: root,
        profileId: selectedProfile,
        jobId: job.id,
        stopReason: turn?.stopReason || null,
        visibleMutation,
        groundedToolUse,
        scoreAuditDelta: afterAudits - beforeAudits,
        transcript: transcriptPath
      };
      append(records, 'summary', result);
      if (!result.ok) throw Object.assign(new Error(`ACP smoke did not observe a grounded turn; inspect ${transcriptPath}`), { summary: result });
      return result;
    })(), deadline]);
    return summary;
  } finally {
    clearTimeout(timer);
    await Promise.race([client.stop(), new Promise(resolve => setTimeout(resolve, 3_000))]);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
    store.db.close();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const hardStop = setTimeout(() => {
    process.stderr.write(`jobos-acp-smoke: hard timeout after ${MAX_RUNTIME_MS}ms\n`);
    process.exit(1);
  }, MAX_RUNTIME_MS);
  try {
    const summary = await runAcpSmoke({
      workspace: flags.workspace || null,
      profileId: flags.profile || null,
      jobId: flags.job || null,
      output: flags.output || null,
      timeoutMs: flags.timeout || DEFAULT_TIMEOUT_MS
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    clearTimeout(hardStop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`jobos-acp-smoke: ${error.message}\n`);
    if (error.summary) process.stderr.write(`${JSON.stringify(error.summary, null, 2)}\n`);
    process.exitCode = 1;
  });
}
