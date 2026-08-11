import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectAgentClient, doctorAgents, SUPPORTED_AGENT_CLIENTS } from '../src/agent-setup.js';

function fixture(t, { command = 'codex', script = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-agent-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'registration.txt');
  const executable = path.join(root, command);
  const defaultScript = `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  if [ -f "$FAKE_AGENT_STATE" ]; then printf 'jobos enabled\\n'; else printf 'No MCP servers configured\\n'; fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  printf '%s\\n' "$@" > "$FAKE_AGENT_STATE"
  printf 'Added jobos\\n'
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "enable" ]; then
  touch "$FAKE_AGENT_STATE"
  printf 'Enabled jobos\\n'
  exit 0
fi
printf '${command} 1.0\\n'
`;
  writeFileSync(executable, script || defaultScript, 'utf8');
  chmodSync(executable, 0o755);
  return {
    workspace: root,
    root,
    state,
    cliPath: path.resolve('src/cli.js'),
    env: { ...process.env, PATH: root, FAKE_AGENT_STATE: state }
  };
}

test('agents connect registers the installed client, verifies MCP, and is idempotent', async t => {
  const setup = fixture(t);
  const first = await connectAgentClient('codex', setup);
  assert.equal(first.status, 'ready');
  assert.equal(first.changed, true);
  assert.equal(first.alreadyConnected, false);
  assert.equal(first.verification.ok, true);
  assert.deepEqual(first.modes, { embedded: null, externalMcp: true, batch: true });
  const args = readFileSync(setup.state, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 4), ['mcp', 'add', 'jobos', '--']);
  assert.ok(args.includes(setup.cliPath));
  assert.ok(args.includes(setup.root));

  const second = await connectAgentClient('codex', setup);
  assert.equal(second.status, 'ready');
  assert.equal(second.changed, false);
  assert.equal(second.alreadyConnected, true);
});

test('agents connect dry-run reports the exact registration without mutating client state', async t => {
  const setup = fixture(t);
  const result = await connectAgentClient('codex', { ...setup, dryRun: true });
  assert.equal(result.status, 'preview');
  assert.equal(result.changed, false);
  assert.equal(result.alreadyConnected, false);
  assert.match(result.registration.display, /codex mcp add jobos --/);
  assert.equal(existsSync(setup.state), false);
});

test('agents doctor distinguishes core readiness and usable agent paths', async t => {
  const setup = fixture(t);
  await connectAgentClient('codex', setup);
  const report = await doctorAgents({ ...setup, client: 'codex' });
  assert.equal(report.schema, 'jobos.agent-doctor.v1');
  assert.equal(report.status, 'ready');
  assert.equal(report.coreReady, true);
  assert.equal(report.agentReady, true);
  assert.ok(report.mcpToolCount > 0);
  assert.equal(report.clients.length, 1);
  assert.equal(report.clients[0].name, 'codex');
  assert.equal(report.clients[0].externalMcp.ok, true);
  assert.equal(report.policy.primaryHumanSurface, 'tui');
});

test('agents connect rejects unsupported and missing clients with typed errors', async t => {
  const setup = fixture(t);
  await assert.rejects(() => connectAgentClient('unknown-agent', setup), error => error.code === 'agent_client_unsupported');
  await assert.rejects(() => connectAgentClient('claude', setup), error => error.code === 'agent_client_missing');
  assert.deepEqual([...SUPPORTED_AGENT_CLIENTS].sort(), ['claude', 'codex', 'cursor', 'grok', 'hermes', 'pi']);
});

test('agents connect registers grok through its MCP CLI', async t => {
  const setup = fixture(t, { command: 'grok' });
  const result = await connectAgentClient('grok', setup);
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, true);
  assert.deepEqual(result.modes, { embedded: null, externalMcp: true, batch: false });
  const args = readFileSync(setup.state, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 5), ['mcp', 'add', 'jobos', '--scope', 'project']);
});

test('agents connect writes cursor MCP config and verifies through agent mcp list', async t => {
  const setup = fixture(t, { command: 'agent' });
  const result = await connectAgentClient('cursor', setup);
  assert.equal(result.status, 'ready');
  assert.match(result.registration.display, /\.cursor\/mcp\.json/);
  const config = JSON.parse(readFileSync(path.join(setup.root, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.jobos.command, process.execPath);
  assert.ok(config.mcpServers.jobos.args.includes(setup.cliPath));
  assert.equal(result.verification.ok, true);
});

test('agents connect dry-run for cursor reports file registration without writing', async t => {
  const setup = fixture(t, { command: 'agent' });
  const result = await connectAgentClient('cursor', { ...setup, dryRun: true });
  assert.equal(result.status, 'preview');
  assert.match(result.registration.display, /\.cursor\/mcp\.json/);
  assert.equal(existsSync(path.join(setup.root, '.cursor', 'mcp.json')), false);
});

test('agents connect writes pi MCP config and accepts omp alias', async t => {
  const setup = fixture(t, { command: 'omp', script: `#!/bin/sh
printf 'omp 1.0\\n'
` });
  const result = await connectAgentClient('pi', setup);
  assert.equal(result.status, 'ready');
  assert.equal(result.modes.embedded, 'acp-v1');
  const config = JSON.parse(readFileSync(path.join(setup.root, '.omp', 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.jobos.enabled, true);
  assert.equal(result.verification.ok, true);

  const alias = await connectAgentClient('omp', setup);
  assert.equal(alias.client, 'pi');
  assert.equal(alias.alreadyConnected, true);
});
