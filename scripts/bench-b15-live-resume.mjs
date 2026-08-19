#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AcpClient, jobosMcpServer, readPersistedAcpSession, writePersistedAcpSession } from '../src/acp.js';
import { seedMcpDemo } from './seed-mcp-demo.js';
import { hermesEvidence, preflightHermes, stopAcpClient } from './lib/hermes-live.mjs';

const root = fs.mkdtempSync(path.join(tmpdir(), 'jobos-b15-resume-'));
const workspace = path.join(root, 'workspace');
let first = null;
let second = null;
let hermes = null;
let timedOut = false;
let hardStopCleanup = null;
let hardStopCleanupError = null;
const stopClients = async () => {
  await stopAcpClient(first);
  await stopAcpClient(second);
};
const hardStop = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`B15 prerequisite/live failure: real Hermes resume check exceeded 180000ms; hermes=${hermesEvidence(null, hermes)}\n`);
  process.exitCode = 124;
  hardStopCleanup = stopClients().catch(error => { hardStopCleanupError = error; });
}, 180_000);

try {
  hermes = preflightHermes();
  const seeded = await seedMcpDemo(workspace);
  const mcpServers = [jobosMcpServer(workspace, { allowAgentAttestation: false })];
  const nonce = `B15-${randomUUID()}`;

  first = new AcpClient({ root: workspace, command: hermes.executable, args: ['acp'], requestTimeoutMs: 45_000, promptTimeoutMs: 90_000 });
  await first.connect({ mcpServers });
  const firstSessionId = first.sessionId;
  assert.ok(firstSessionId, 'first launch returned no ACP session id');
  const firstTurn = await first.prompt(
    `Remember this exact opaque nonce for the next turn in this same conversation: ${nonce}. Reply only ACK. Do not call tools.`,
    { timeoutMs: 90_000 }
  );
  assert.equal(firstTurn?.stopReason, 'end_turn', `first turn stop reason was ${firstTurn?.stopReason || 'missing'}`);
  await writePersistedAcpSession(workspace, seeded.profileId, firstSessionId);
  const persisted = await readPersistedAcpSession(workspace, seeded.profileId);
  assert.equal(persisted, firstSessionId, 'readPersistedAcpSession did not return the first launch session');
  await stopAcpClient(first);
  first = null;

  const resumedText = [];
  second = new AcpClient({ root: workspace, command: hermes.executable, args: ['acp'], requestTimeoutMs: 45_000, promptTimeoutMs: 90_000 });
  second.on('event', event => {
    if (event.type === 'agent_message' && event.text) resumedText.push(String(event.text));
  });
  await second.connect({ mcpServers, sessionId: persisted });
  assert.equal(second.sessionId, firstSessionId, 'second launch did not load the persisted ACP session id');
  const secondTurn = await second.prompt(
    'What exact opaque nonce did I ask you to remember in the immediately prior turn? Reply with the nonce only. Do not call tools.',
    { timeoutMs: 90_000 }
  );
  assert.equal(secondTurn?.stopReason, 'end_turn', `resumed turn stop reason was ${secondTurn?.stopReason || 'missing'}`);
  const reply = resumedText.join('');
  assert.ok(reply.includes(nonce), `resumed session did not retain prior conversation context; reply was ${JSON.stringify(reply)}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(workspace, '.jobos', 'acp-sessions.json'), 'utf8'));
  assert.equal(onDisk.sessions[`hermes-acp:${seeded.profileId}`]?.sessionId, firstSessionId, 'persisted session file does not contain resumed id');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backend: 'hermes-acp',
    hermes,
    firstSessionId,
    resumedSessionId: second.sessionId,
    firstStopReason: firstTurn.stopReason,
    resumedStopReason: secondTurn.stopReason,
    nonce,
    priorContextRecovered: true,
    persistedFile: '.jobos/acp-sessions.json'
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`B15 prerequisite/live failure: ${error.message}; hermes=${hermesEvidence(error, hermes)}\n`);
  process.exitCode = timedOut ? 124 : 1;
} finally {
  clearTimeout(hardStop);
  try {
    if (hardStopCleanup) await hardStopCleanup;
    else await stopClients();
    if (hardStopCleanupError) throw hardStopCleanupError;
  } catch (error) {
    process.stderr.write(`B15 cleanup failure: ${error.message}\n`);
    process.exitCode = timedOut ? 124 : 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
