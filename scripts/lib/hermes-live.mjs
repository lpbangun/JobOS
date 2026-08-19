import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const HERMES_COMPATIBILITY_FALLBACK = '/home/logani/.local/bin/hermes';

function executableOnPath(command, env) {
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      const info = fs.statSync(candidate);
      if (info.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return null;
}

function explicitExecutable(value, { cwd, env }) {
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return path.isAbsolute(value) ? value : path.resolve(cwd, value);
  }
  return executableOnPath(value, env);
}

function usableExecutable(candidate) {
  if (!candidate) return false;
  try {
    const info = fs.statSync(candidate);
    fs.accessSync(candidate, fs.constants.X_OK);
    return info.isFile();
  } catch {
    return false;
  }
}

export class HermesPrerequisiteError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'HermesPrerequisiteError';
    this.context = context;
  }
}

/** Resolve the real Hermes executable without requiring a provider connection. */
export function resolveHermesExecutable({
  env = process.env,
  cwd = process.cwd(),
  compatibilityFallback = HERMES_COMPATIBILITY_FALLBACK
} = {}) {
  const override = String(env.JOBOS_HERMES_BIN || '').trim();
  if (override) {
    const executable = explicitExecutable(override, { cwd, env });
    const context = { source: 'JOBOS_HERMES_BIN', requested: override, executable: executable || null };
    if (!usableExecutable(executable)) {
      throw new HermesPrerequisiteError('JOBOS_HERMES_BIN does not identify an executable Hermes file', context);
    }
    return { executable, source: 'JOBOS_HERMES_BIN' };
  }

  const fromPath = executableOnPath('hermes', env);
  if (fromPath) return { executable: fromPath, source: 'PATH' };

  if (compatibilityFallback && usableExecutable(compatibilityFallback)) {
    return { executable: compatibilityFallback, source: 'compatibility-fallback' };
  }

  throw new HermesPrerequisiteError('Hermes executable was not found on PATH and no usable compatibility fallback exists', {
    source: 'discovery',
    override: null,
    path: String(env.PATH || ''),
    compatibilityFallback: compatibilityFallback || null
  });
}

/** Verify that the resolved binary exposes the ACP command and report its version. */
export function preflightHermes(options = {}) {
  const resolved = resolveHermesExecutable(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = spawnSync(resolved.executable, ['acp', '--version'], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false
  });
  const output = String(result.stdout || result.stderr || '').trim();
  const context = {
    ...resolved,
    version: output || null,
    preflight: 'hermes acp --version',
    status: result.status,
    signal: result.signal || null,
    error: result.error?.code || result.error?.message || null
  };
  if (result.error || result.status !== 0 || !output) {
    throw new HermesPrerequisiteError('Hermes ACP version preflight failed', context);
  }
  return { ...resolved, version: output };
}

export function hermesEvidence(error, preflight = null) {
  const context = error?.context || preflight;
  return context ? JSON.stringify(context) : 'unavailable';
}

/** Stop a live ACP client, escalate a hung stop, and prove its child exited. */
export async function stopAcpClient(client, { timeoutMs = 3_000, killTimeoutMs = 1_000 } = {}) {
  const child = client?.child || null;
  if (!child) return;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stopResult = await Promise.race([
    Promise.resolve().then(() => client.stop()).then(
      () => ({ done: true }),
      error => ({ done: true, error })
    ),
    delay(timeoutMs).then(() => ({ done: false }))
  ]);
  const childIsLive = () => client.child === child
    && child.exitCode === null
    && child.signalCode === null;
  if (childIsLive()) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      delay(killTimeoutMs)
    ]);
  }
  if (childIsLive()) {
    throw new Error(`ACP child remained live after cleanup (pid ${child.pid || 'unknown'})`);
  }
  if (stopResult.error) throw stopResult.error;
}
