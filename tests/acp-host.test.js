import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpClient,
  buildAgentEnvironment,
  buildHostPrompt,
  normalizeSessionUpdate,
  redactSensitive
} from '../src/acp.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.js', import.meta.url));

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-acp-test-'));
}

function fakeClient(root, mode, marker = '', options = {}) {
  return new AcpClient({
    root,
    command: process.execPath,
    args: [fixture, mode, marker].filter(Boolean),
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    promptTimeoutMs: options.promptTimeoutMs ?? 1000,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-secret-value', UNRELATED_SECRET: 'must-not-cross-boundary' }
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('ACP client runs an evented turn, denies guest permissions, and redacts every transcript frame', async t => {
  const root = workspace();
  const marker = path.join(root, 'permission.json');
  const client = fakeClient(root, 'normal', marker);
  t.after(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const events = [];
  const frames = [];
  client.on('event', event => events.push(event));
  client.on('frame', frame => frames.push(frame));

  const connected = await client.connect({ mcpServers: [] });
  assert.equal(connected.session.sessionId, 'fake-session-1');
  assert.equal(client.state, 'ready');
  const result = await client.prompt('Summarize safely', { context: { job: { id: 'job-1' }, password: 'must-not-appear' } });

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(client.state, 'ready');
  assert.ok(events.some(event => event.type === 'tool_start'));
  assert.ok(events.some(event => event.type === 'tool_update' && event.status === 'completed'));
  assert.ok(events.some(event => event.type === 'agent_message' && event.text === 'Grounded '));
  assert.ok(events.some(event => event.type === 'permission_denied'));
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { outcome: { outcome: 'cancelled' } });
  const transcript = JSON.stringify(frames);
  assert.doesNotMatch(transcript, /sk-test-secret-value|supersecretvalue|must-not-appear/);
  assert.match(transcript, /\[REDACTED\]/);
});

test('ACP cancel quarantines late updates and starts a clean session before recovery', async t => {
  const root = workspace();
  const marker = path.join(root, 'cancelled.txt');
  const client = fakeClient(root, 'cancelable', marker);
  t.after(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const events = [];
  client.on('event', event => events.push(event));
  await client.connect({ mcpServers: [] });
  const previousPid = client.child.pid;
  const prompt = client.prompt('Wait for cancellation');
  await waitFor(() => client.state === 'working');
  assert.equal(client.cancel(), true);
  const result = await prompt;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(client.state, 'ready');
  assert.equal(client.details().recoveryRequired, true);
  assert.equal(readFileSync(marker, 'utf8'), 'cancelled');
  await waitFor(() => events.filter(event => event.type === 'discarded_update').length >= 2);
  const emittedAgentText = events.filter(event => event.type === 'agent_message').map(event => event.text).join('');
  assert.doesNotMatch(emittedAgentText, /between cancel and acknowledgement|stale cancelled output/);
  assert.ok(events.filter(event => event.type === 'discarded_update').every(event => event.source === 'session_update'));

  const recovered = await client.prompt('Recover with a clean turn');
  assert.equal(recovered.stopReason, 'end_turn');
  assert.notEqual(client.child.pid, previousPid);
  assert.equal(client.details().recoveryRequired, false);
  assert.ok(events.some(event => event.type === 'session_quarantined' && event.reason === 'cancelled'));
  assert.ok(events.some(event => event.type === 'session_recovery_started'));
  assert.ok(events.some(event => event.type === 'session_recovered'));
});

test('ACP timeout cancels and restarts the quarantined session before recovery', async t => {
  const root = workspace();
  const marker = path.join(root, 'timeout-cancel.txt');
  const client = fakeClient(root, 'hang', marker, { promptTimeoutMs: 30 });
  t.after(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await client.connect({ mcpServers: [] });
  const previousPid = client.child.pid;
  await assert.rejects(client.prompt('Hang'), error => error.code === 'acp_request_timeout');
  assert.equal(client.state, 'timeout');
  assert.equal(client.details().recoveryRequired, true);
  await waitFor(() => existsSync(marker));
  assert.equal(readFileSync(marker, 'utf8'), 'cancelled');

  const recovered = await client.prompt('Recover after timeout');
  assert.equal(recovered.stopReason, 'end_turn');
  assert.notEqual(client.child.pid, previousPid);
  assert.equal(client.state, 'ready');
  assert.equal(client.details().recoveryRequired, false);
});

test('ACP crash is typed, stderr is redacted, and restart creates a fresh usable session', async t => {
  const root = workspace();
  const marker = path.join(root, 'crashed-once.txt');
  const client = fakeClient(root, 'crash-once', marker);
  t.after(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await client.connect({ mcpServers: [] });
  await assert.rejects(client.prompt('Crash once'), error => error.code === 'acp_process_exit');
  assert.equal(client.state, 'crashed');
  const details = client.details();
  assert.doesNotMatch(details.stderr, /sk-test-secret-value|supersecretvalue/);
  assert.match(details.stderr, /\[REDACTED\]/);

  const restarted = await client.restart();
  assert.equal(restarted.session.sessionId, 'fake-session-1');
  assert.equal((await client.prompt('Now recover')).stopReason, 'end_turn');
  assert.equal(client.state, 'ready');
});

test('ACP handshake failures stop the child and unavailable executables return typed errors', async t => {
  const root = workspace();
  const badVersion = fakeClient(root, 'bad-version');
  t.after(async () => {
    await badVersion.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(badVersion.connect({ mcpServers: [] }), error => error.code === 'acp_protocol_version');
  assert.equal(badVersion.child, null);
  assert.equal(badVersion.state, 'failed');

  const missing = new AcpClient({ root, command: 'jobos-definitely-missing-acp' });
  await assert.rejects(missing.connect({ mcpServers: [] }), error => error.code === 'acp_missing_executable');
  assert.equal(missing.state, 'unavailable');
});

test('ACP security helpers enforce an environment allowlist and normalize/redact update variants', () => {
  const env = buildAgentEnvironment('/tmp/jobos-root', {
    HOME: '/home/test',
    PATH: '/bin',
    OPENAI_API_KEY: 'sk-test-secret-value',
    HERMES_MODEL: 'model',
    JOBOS_ALLOW_AGENT_ATTESTATION: '1',
    RANDOM_VALUE: 'nope'
  });
  assert.equal(env.JOBOS_HOME, '/tmp/jobos-root');
  assert.equal(env.OPENAI_API_KEY, 'sk-test-secret-value');
  assert.equal(env.HERMES_MODEL, 'model');
  assert.equal(env.JOBOS_ALLOW_AGENT_ATTESTATION, undefined);
  assert.equal(env.RANDOM_VALUE, undefined);

  const normalized = normalizeSessionUpdate({
    sessionId: 'session',
    update: { sessionUpdate: 'tool_call', title: 'tool', rawInput: { apiKey: 'secret', nested: 'Bearer abcdefghijklmnop' } }
  });
  assert.equal(normalized.type, 'tool_start');
  assert.deepEqual(normalized.rawInput, { apiKey: '[REDACTED]', nested: 'Bearer [REDACTED]' });
  assert.deepEqual(redactSensitive({ password: 'value', safe: 'token=abcdef' }), { password: '[REDACTED]', safe: 'token=[REDACTED]' });
  assert.doesNotMatch(buildHostPrompt('hello', { cookie: 'secret', job: { id: 'job-1' } }), /"cookie": "secret"/);
});
