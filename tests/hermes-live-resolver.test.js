import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  HermesPrerequisiteError,
  preflightHermes,
  resolveHermesExecutable,
  stopAcpClient
} from '../scripts/lib/hermes-live.mjs';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'jobos-hermes-resolver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(file, body = "printf 'Hermes ACP test 1.2.3\\n'\n") {
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

test('Hermes live resolver gives JOBOS_HERMES_BIN precedence over PATH', t => {
  const root = sandbox(t);
  const override = executable(path.join(root, 'override-hermes'));
  const pathDir = path.join(root, 'bin');
  fs.mkdirSync(pathDir);
  executable(path.join(pathDir, 'hermes'));

  assert.deepEqual(resolveHermesExecutable({
    env: { PATH: pathDir, JOBOS_HERMES_BIN: override },
    compatibilityFallback: null
  }), { executable: override, source: 'JOBOS_HERMES_BIN' });
});

test('Hermes live resolver uses PATH before the optional compatibility fallback', t => {
  const root = sandbox(t);
  const pathDir = path.join(root, 'bin');
  fs.mkdirSync(pathDir);
  const onPath = executable(path.join(pathDir, 'hermes'));
  const fallback = executable(path.join(root, 'fallback-hermes'));

  assert.deepEqual(resolveHermesExecutable({
    env: { PATH: pathDir },
    compatibilityFallback: fallback
  }), { executable: onPath, source: 'PATH' });
});

test('Hermes live resolver supports the compatibility fallback and fails closed when discovery is empty', t => {
  const root = sandbox(t);
  const fallback = executable(path.join(root, 'fallback-hermes'));
  assert.deepEqual(resolveHermesExecutable({ env: { PATH: '' }, compatibilityFallback: fallback }), {
    executable: fallback,
    source: 'compatibility-fallback'
  });

  assert.throws(
    () => resolveHermesExecutable({ env: { PATH: '' }, compatibilityFallback: null }),
    error => error instanceof HermesPrerequisiteError
      && error.context.source === 'discovery'
      && error.context.compatibilityFallback === null
  );
});

test('Hermes live resolver treats an explicit unusable override as a prerequisite failure', t => {
  const root = sandbox(t);
  const pathDir = path.join(root, 'bin');
  fs.mkdirSync(pathDir);
  executable(path.join(pathDir, 'hermes'));
  const unusable = path.join(root, 'not-executable');
  fs.writeFileSync(unusable, '#!/bin/sh\n', { mode: 0o644 });

  assert.throws(
    () => resolveHermesExecutable({
      env: { PATH: pathDir, JOBOS_HERMES_BIN: unusable },
      compatibilityFallback: null
    }),
    error => error instanceof HermesPrerequisiteError
      && error.context.source === 'JOBOS_HERMES_BIN'
      && error.context.requested === unusable
  );
});

test('Hermes ACP preflight returns executable, source, and version without contacting a provider', t => {
  const root = sandbox(t);
  const hermes = executable(path.join(root, 'hermes'), [
    'test "$1" = acp || exit 21',
    'test "$2" = --version || exit 22',
    "printf 'Hermes ACP 9.8.7\\n'"
  ].join('\n'));

  assert.deepEqual(preflightHermes({
    env: { PATH: '', JOBOS_HERMES_BIN: hermes },
    compatibilityFallback: null
  }), {
    executable: hermes,
    source: 'JOBOS_HERMES_BIN',
    version: 'Hermes ACP 9.8.7'
  });
});

test('Hermes ACP preflight fails nonzero with resolved prerequisite context', t => {
  const root = sandbox(t);
  const hermes = executable(path.join(root, 'hermes'), "printf 'ACP unavailable\\n' >&2\nexit 7\n");

  assert.throws(
    () => preflightHermes({
      env: { PATH: '', JOBOS_HERMES_BIN: hermes },
      compatibilityFallback: null
    }),
    error => error instanceof HermesPrerequisiteError
      && error.context.executable === hermes
      && error.context.version === 'ACP unavailable'
      && error.context.status === 7
  );
});

test('Hermes live cleanup escalates a hung ACP stop and verifies process exit', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  const client = { child, stop: () => new Promise(() => {}) };
  child.kill = signal => {
    signals.push(signal);
    child.signalCode = signal;
    client.child = null;
    child.emit('close', null, signal);
    return true;
  };

  await stopAcpClient(client, { timeoutMs: 5, killTimeoutMs: 50 });
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(client.child, null);
});

test('Hermes live cleanup fails closed when stop returns but the child remains live', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  const client = { child, stop: async () => {} };

  await assert.rejects(
    stopAcpClient(client, { timeoutMs: 5, killTimeoutMs: 5 }),
    /ACP child remained live/
  );
});

test('Hermes live cleanup escalates a rejected stop before surfacing its error', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  const client = { child, stop: async () => { throw new Error('stop failed'); } };
  child.kill = signal => {
    signals.push(signal);
    child.signalCode = signal;
    client.child = null;
    child.emit('close', null, signal);
    return true;
  };

  await assert.rejects(stopAcpClient(client, { timeoutMs: 5, killTimeoutMs: 50 }), /stop failed/);
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(client.child, null);
});
