#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AcpClient, jobosMcpServer } from '../src/acp.js';
import { openStore, one } from '../src/db.js';
import { selectedJobContext } from '../src/domain-tools.js';
import { seedMcpDemo } from './seed-mcp-demo.js';
import { hermesEvidence, preflightHermes, stopAcpClient } from './lib/hermes-live.mjs';

const root = fs.mkdtempSync(path.join(tmpdir(), 'jobos-b13-live-'));
const workspace = path.join(root, 'workspace');
let client = null;
let store = null;
let hermes = null;
let timedOut = false;
let hardStopCleanup = null;
let hardStopCleanupError = null;
const events = [];
const hardStop = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`B13 prerequisite/live failure: real Hermes ACP check exceeded 180000ms; hermes=${hermesEvidence(null, hermes)}\n`);
  process.exitCode = 124;
  hardStopCleanup = stopAcpClient(client).catch(error => { hardStopCleanupError = error; });
}, 180_000);

try {
  hermes = preflightHermes();
  const seeded = await seedMcpDemo(workspace);
  store = await openStore({ workspace });
  const before = one(store, 'SELECT score_json FROM jobs WHERE id=?', [seeded.jobId]);
  assert.equal(before?.score_json, null, 'B13 seed must begin without score_json');
  const beforeAudits = Number(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='job.scored' AND entity_id=?", [seeded.jobId])?.n || 0);

  client = new AcpClient({
    root: workspace,
    command: hermes.executable,
    args: ['acp'],
    requestTimeoutMs: 45_000,
    promptTimeoutMs: 150_000
  });
  client.on('event', event => events.push(event));
  await client.connect({ mcpServers: [jobosMcpServer(workspace, { allowAgentAttestation: false })] });
  const sessionId = client.sessionId;
  assert.ok(sessionId, 'Hermes ACP returned no session id');
  const turn = await client.prompt(
    `Use the jobos MCP tool score_job exactly once with jobId ${seeded.jobId} and profileId ${seeded.profileId}. Then briefly confirm that the stored score was grounded in JobOS. Do not use shell, filesystem, browser, web, or non-jobos tools.`,
    { context: selectedJobContext(store, seeded.jobId, seeded.profileId), timeoutMs: 150_000 }
  );
  assert.equal(turn?.stopReason, 'end_turn', `Hermes turn stop reason was ${turn?.stopReason || 'missing'}`);

  store.db.close();
  store = await openStore({ workspace });
  const after = one(store, 'SELECT score_json FROM jobs WHERE id=?', [seeded.jobId]);
  const afterAudits = Number(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='job.scored' AND entity_id=?", [seeded.jobId])?.n || 0);
  assert.ok(after?.score_json, 'reloaded SQLite has no score_json');
  const score = JSON.parse(after.score_json);
  assert.equal(score.contract, 'jobos.fit-score.v1', 'reloaded score_json has the wrong contract');
  assert.ok(afterAudits > beforeAudits, 'reloaded SQLite has no new job.scored audit mutation');
  const starts = new Set(events.filter(event => event.type === 'tool_start' && /score_job/i.test(event.title || '')).map(event => event.toolCallId).filter(Boolean));
  assert.ok(starts.size > 0, 'Hermes emitted no visible score_job tool start');
  assert.ok(events.some(event => event.type === 'tool_update' && event.status === 'completed' && starts.has(event.toolCallId)), 'Hermes emitted no completed update for the visible score_job call');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backend: 'hermes-acp',
    hermes,
    sessionId,
    stopReason: turn.stopReason,
    jobId: seeded.jobId,
    scoreAuditDelta: afterAudits - beforeAudits,
    scoreJson: {
      contract: score.contract,
      overall: score.overall ?? null,
      sha256: createHash('sha256').update(after.score_json).digest('hex')
    },
    reloadVerifiedOnDisk: true,
    completedScoreToolCall: true
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`B13 prerequisite/live failure: ${error.message}; hermes=${hermesEvidence(error, hermes)}\n`);
  process.exitCode = timedOut ? 124 : 1;
} finally {
  clearTimeout(hardStop);
  try {
    if (hardStopCleanup) await hardStopCleanup;
    else await stopAcpClient(client);
    if (hardStopCleanupError) throw hardStopCleanupError;
  } catch (error) {
    process.stderr.write(`B13 cleanup failure: ${error.message}\n`);
    process.exitCode = timedOut ? 124 : 1;
  }
  try { store?.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
