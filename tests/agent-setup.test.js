import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectAgentClient, doctorAgents } from '../src/agent-setup.js';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-agent-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'registration.txt');
  const executable = path.join(root, 'codex');
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  if [ -f "$FAKE_AGENT_STATE" ]; then printf 'jobos enabled\\n'; else printf 'No MCP servers configured\\n'; fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  printf '%s\\n' "$@" > "$FAKE_AGENT_STATE"
  printf 'Added jobos\\n'
  exit 0
fi
printf 'codex-cli 1.0\\n'
`, 'utf8');
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
  await assert.rejects(() => connectAgentClient('grok', setup), error => error.code === 'agent_client_unsupported');
  await assert.rejects(() => connectAgentClient('claude', setup), error => error.code === 'agent_client_missing');
});
