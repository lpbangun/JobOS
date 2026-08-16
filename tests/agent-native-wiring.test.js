import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildHostPrompt, listPersistedAcpSessions, readPersistedAcpSession, writePersistedAcpSession } from '../src/acp.js';
import { AGENT_DOMAIN_TOOLS, HUMAN_ONLY_DOMAIN_TOOLS } from '../src/capabilities.js';
import { DOMAIN_TOOLS } from '../src/domain-tools.js';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { defaultTuiState, JobosTui, TUI_DOMAIN_ACTIONS } from '../src/tui.js';
import { mcpToolNames } from '../src/mcp.js';

function workspace(t) {  const root = mkdtempSync(path.join(tmpdir(), 'jobos-agent-wiring-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
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
  assert.match(prompt, /Current JobOS context/);
  assert.match(prompt, /secret-safe resume-upload summary/);
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

test('listPersistedAcpSessions returns per-profile session ids and updatedAt', async t => {
  const root = workspace(t);
  assert.deepEqual(await listPersistedAcpSessions(root), []);
  await writePersistedAcpSession(root, 'pm', 'session-123');
  await writePersistedAcpSession(root, 'backend', 'session-456');
  const sessions = await listPersistedAcpSessions(root);
  assert.equal(sessions.length, 2);
  const pm = sessions.find(s => s.profileId === 'pm');
  assert.equal(pm.sessionId, 'session-123');
  assert.ok(pm.updatedAt, 'updatedAt is present');
  assert.equal(sessions.find(s => s.profileId === 'backend').sessionId, 'session-456');
});

test('with --agent off the TUI never starts an ACP child and writes no session state', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  t.after(() => store.db.close());
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false });
  await tui.start();
  assert.equal(tui.state.agentState, 'off', 'agentState is off with --agent off');
  assert.equal(tui.client, null, 'no AcpClient is created');
  assert.equal(existsSync(path.join(root, '.jobos', 'acp-sessions.json')), false, 'no session state is written');
  assert.equal(await readPersistedAcpSession(root, null), null);
});

test('TUI slash ids map to real agent-door domain tools and unknown commands are refused', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  t.after(() => store.db.close());
  const profile = createProfile(store, 'Agent Wiring').profile;
  const tui = new JobosTui(store, { ...streams(), profileId: profile.id, connectAgent: false, color: false });
  tui.refresh();

  const externalTools = new Set(mcpToolNames());
  for (const [slash, tool] of Object.entries(TUI_DOMAIN_ACTIONS)) {
    assert.ok(externalTools.has(tool), `slash ${slash} maps to ${tool}, which is missing from the external MCP catalog`);
    assert.doesNotThrow(() => tui.runSlash(slash), `runSlash(${slash}) routes to a live handler`);
  }
  tui.runSlash('not-a-command');
  assert.match(tui.state.status, /No matching command/);
});

test('retired colon commands are gone: no command buffer, no /: dispatch', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  t.after(() => store.db.close());
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false });
  tui.refresh();
  const base = defaultTuiState();
  assert.equal('commandBuffer' in base, false, 'no colon command buffer');
  assert.equal('mode' in base, false, 'no modal command mode');
  const before = tui.state.input;
  tui.handleKey(':', { name: ':' });
  assert.equal(tui.state.input, before, '":" in the shell is not a command bar');
  assert.equal(tui.state.overlay, null, '":" opens no overlay');
});
