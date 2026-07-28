import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHostPrompt, readPersistedAcpSession, writePersistedAcpSession } from '../src/acp.js';
import { AGENT_DOMAIN_TOOLS, HUMAN_ONLY_DOMAIN_TOOLS } from '../src/capabilities.js';
import { DOMAIN_TOOLS } from '../src/domain-tools.js';
import { openStore } from '../src/db.js';
import { JobosTui } from '../src/tui.js';
import { mcpToolNames } from '../src/mcp.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-agent-wiring-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('one capability policy drives MCP eligibility and human handoffs', () => {
  const allNames = DOMAIN_TOOLS.map(tool => tool.name);
  assert.deepEqual(
    [...AGENT_DOMAIN_TOOLS.map(tool => tool.name), ...HUMAN_ONLY_DOMAIN_TOOLS].sort(),
    [...allNames].sort(),
  );
  assert.deepEqual(mcpToolNames(), AGENT_DOMAIN_TOOLS.map(tool => tool.name));
  assert.ok(HUMAN_ONLY_DOMAIN_TOOLS.includes('approve_artifact'));
  assert.equal(mcpToolNames().includes('approve_artifact'), false);
});

test('embedded NLP prompt receives full agent tool catalog and typed human handoffs', () => {
  const prompt = buildHostPrompt('Approve this resume and then pursue the job.', { job: { id: 'job-1' } });
  for (const name of mcpToolNames()) assert.match(prompt, new RegExp(`\\b${name}\\b`));
  assert.match(prompt, /approve_artifact.*trusted TUI slash command/s);
  assert.match(prompt, /Natural-language requests are the default/);
  assert.match(prompt, /\/approve_artifact/);
});

test('ACP session id persists privately per profile across JobOS processes', async t => {
  const root = workspace(t);
  assert.equal(await readPersistedAcpSession(root, 'pm'), null);
  await writePersistedAcpSession(root, 'pm', 'session-123');
  assert.equal(await readPersistedAcpSession(root, 'pm'), 'session-123');
  const file = path.join(root, '.jobos', 'acp-sessions.json');
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions['hermes-acp:pm'].sessionId, 'session-123');
});

test('quarantining an ACP turn clears the resumable session before reconnect', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  t.after(() => store.db.close());
  const output = { columns: 120, rows: 40, isTTY: false, write() {} };
  const tui = new JobosTui(store, { stdout: output, connectAgent: false, color: false });
  await tui.persistAgentSession('session-cancelled');

  tui.onAgentEvent({ type: 'session_quarantined', reason: 'cancelled' });
  await tui.sessionPersistence;

  assert.equal(await readPersistedAcpSession(root, tui.model.profileId), null);
});

test('TUI slash syntax dispatches domain tools through the shared facade', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  t.after(() => store.db.close());
  const output = { columns: 120, rows: 40, isTTY: false, write() {} };
  const tui = new JobosTui(store, { stdout: output, connectAgent: false, color: false });

  tui.executeCommand('/list_jobs {}');
  await wait();
  assert.match(tui.state.status, /list_jobs complete/);
  assert.equal(tui.state.error, null);

  tui.executeCommand('/score_job not-json');
  assert.match(tui.state.status, /Usage: \/score_job <json-object>/);
});
