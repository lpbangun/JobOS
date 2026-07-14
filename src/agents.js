import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquireWriteLock } from './db.js';

export const AGENT_PROTOCOL_VERSION = 1;
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
export const MAX_AGENT_STDOUT_BYTES = 50 * 1024;

const REGISTRY_VERSION = 1;
const MAX_STDERR_CAPTURE_BYTES = 8 * 1024;
const MAX_STDERR_DETAIL_CHARS = 2_000;
const VALID_TRANSPORTS = new Set(['stdin-json', 'prompt-arg']);
const MANIFEST_FIELDS = new Set(['name', 'command', 'args', 'transport']);
const REGISTRY_FIELDS = new Set(['version', 'agents']);
const REQUEST_FIELDS = new Set(['protocolVersion', 'stage', 'systemPrompt', 'userPrompt', 'schema']);
const SECRET_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|password|passwd|secret|token)/i;
const SECRET_FLAG_PATTERN = /^--?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|password|passwd|secret|token)(?:=|$)/i;
const SECRET_VALUE_PATTERN = /^(?:sk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}$/i;

const BUILTINS = Object.freeze({
  codex: Object.freeze({
    name: 'codex',
    command: 'codex',
    args: Object.freeze(['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-']),
    transport: 'stdin-json'
  }),
  hermes: Object.freeze({
    name: 'hermes',
    command: 'hermes',
    args: Object.freeze(['--oneshot']),
    transport: 'prompt-arg'
  })
});

export const BUILTIN_AGENT_MANIFESTS = BUILTINS;

export class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentError';
    this.type = 'agent_error';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { type: this.type, code: this.code, message: this.message, details: this.details };
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownFields(value, allowed, label) {
  if (!isObject(value)) {
    throw new AgentError('agent_invalid_manifest', `${label} must be a JSON object`, { label });
  }
  const unknownFields = Object.keys(value).filter(key => !allowed.has(key));
  if (unknownFields.length) {
    throw new AgentError('agent_invalid_manifest', `${label} contains unsupported fields`, { label, unknownFields });
  }
}

function validateName(name) {
  const normalized = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new AgentError('agent_invalid_manifest', 'Agent name must use lowercase letters, numbers, dot, underscore, or hyphen', { field: 'name' });
  }
  return normalized;
}

function secretLookingArg(arg) {
  return SECRET_FLAG_PATTERN.test(arg)
    || SECRET_VALUE_PATTERN.test(arg)
    || /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)=.+$/.test(arg)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(arg)
    || /^Bearer\s+\S+/i.test(arg);
}

function validateManifest(value, { includeName }) {
  assertKnownFields(value, MANIFEST_FIELDS, 'Agent manifest');
  const name = includeName ? validateName(value.name) : undefined;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (!command || command.length > 1_024 || /[\0\r\n]/.test(command)) {
    throw new AgentError('agent_invalid_manifest', 'Agent command must be a non-empty executable name or path', { field: 'command' });
  }
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4_096 || arg.includes('\0'))) {
    throw new AgentError('agent_invalid_manifest', 'Agent args must be an array of at most 64 bounded strings', { field: 'args' });
  }
  const secretArgIndexes = args.map((arg, index) => secretLookingArg(arg) ? index : -1).filter(index => index >= 0);
  if (secretArgIndexes.length) {
    throw new AgentError('agent_secret_in_args', 'Agent args must not contain credentials; provide authentication through the agent or its environment', { field: 'args', indexes: secretArgIndexes });
  }
  const transport = value.transport || 'stdin-json';
  if (!VALID_TRANSPORTS.has(transport)) {
    throw new AgentError('agent_invalid_transport', 'Agent transport must be stdin-json or prompt-arg', { transport });
  }
  return { ...(includeName ? { name } : {}), command, args: [...args], transport };
}

function resolveWorkspace({ workspace, env = process.env } = {}) {
  return path.resolve(workspace || env.JOBOS_HOME || env.JOBOS_WORKSPACE || process.cwd());
}

export function agentRegistryPath(options = {}) {
  return path.join(resolveWorkspace(options), '.jobos', 'agents.json');
}

async function readRegistry(options = {}) {
  const file = agentRegistryPath(options);
  let fileInfo;
  try {
    fileInfo = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: REGISTRY_VERSION, agents: [] };
    throw new AgentError('agent_registry_read_failed', 'Could not inspect the agent registry', { cause: error?.code || 'unknown' });
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new AgentError('agent_registry_invalid', 'Agent registry must be a regular file, not a link', {});
  }
  if ((fileInfo.mode & 0o077) !== 0) {
    throw new AgentError('agent_registry_permissions', 'Agent registry permissions must be private (0600)', { mode: (fileInfo.mode & 0o777).toString(8) });
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new AgentError('agent_registry_invalid', 'Agent registry is not valid JSON', { cause: error?.code || error?.name || 'parse_error' });
  }
  assertKnownFields(parsed, REGISTRY_FIELDS, 'Agent registry');
  if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.agents) || parsed.agents.length > 128) {
    throw new AgentError('agent_registry_invalid', 'Agent registry has an unsupported version or shape', { version: parsed.version });
  }
  const seen = new Set();
  const agents = parsed.agents.map(entry => {
    const manifest = validateManifest(entry, { includeName: true });
    if (BUILTINS[manifest.name] || seen.has(manifest.name)) {
      throw new AgentError('agent_registry_invalid', 'Agent registry contains a reserved or duplicate name', { name: manifest.name });
    }
    seen.add(manifest.name);
    return manifest;
  });
  return { version: REGISTRY_VERSION, agents };
}

async function writeRegistry(registry, options = {}) {
  const file = agentRegistryPath(options);
  const stateDir = path.dirname(file);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    throw new AgentError('agent_registry_write_failed', 'Could not persist the agent registry', { cause: error?.code || 'unknown' });
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function executableCandidates(command, root, env) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [path.isAbsolute(command) ? command : path.resolve(root, command)];
  }
  const directories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') return directories.map(directory => path.join(directory, command));
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return directories.flatMap(directory => extensions.map(extension => path.join(directory, `${command}${extension}`)));
}

async function findExecutable(command, root, env) {
  for (const candidate of executableCandidates(command, root, env)) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function publicManifest(manifest, { builtin, executablePath }) {
  return {
    ...manifest,
    args: [...manifest.args],
    builtin,
    suggested: builtin,
    available: Boolean(executablePath),
    authentication: 'untested'
  };
}

async function resolveAgent(name, options = {}) {
  const normalizedName = validateName(name);
  const root = resolveWorkspace(options);
  const env = options.env || process.env;
  const registry = await readRegistry({ ...options, workspace: root, env });
  const builtin = BUILTINS[normalizedName];
  const manifest = builtin || registry.agents.find(entry => entry.name === normalizedName);
  if (!manifest) {
    throw new AgentError('agent_not_found', `Agent "${normalizedName}" is not registered`, { name: normalizedName });
  }
  const executablePath = await findExecutable(manifest.command, root, env);
  return {
    manifest: { ...manifest, args: [...manifest.args] },
    builtin: Boolean(builtin),
    executablePath,
    root,
    env
  };
}

export async function addAgent(name, manifest, options = {}) {
  const normalizedName = validateName(name);
  if (BUILTINS[normalizedName]) {
    throw new AgentError('agent_reserved_name', `Agent name "${normalizedName}" is reserved for a built-in manifest`, { name: normalizedName });
  }
  const normalizedManifest = { name: normalizedName, ...validateManifest(manifest, { includeName: false }) };
  const root = resolveWorkspace(options);
  const release = acquireWriteLock({ p: { state: path.join(root, '.jobos') } });
  try {
    const registry = await readRegistry(options);
    const index = registry.agents.findIndex(entry => entry.name === normalizedName);
    if (index >= 0) registry.agents[index] = normalizedManifest;
    else registry.agents.push(normalizedManifest);
    registry.agents.sort((left, right) => left.name.localeCompare(right.name));
    await writeRegistry(registry, options);
  } finally {
    release();
  }
  return getAgent(normalizedName, options);
}

export async function listAgents(options = {}) {
  const root = resolveWorkspace(options);
  const env = options.env || process.env;
  const registry = await readRegistry({ ...options, workspace: root, env });
  const manifests = [
    ...Object.values(BUILTINS).map(manifest => ({ manifest, builtin: true })),
    ...registry.agents.map(manifest => ({ manifest, builtin: false }))
  ];
  const resolved = await Promise.all(manifests.map(async ({ manifest, builtin }) => {
    const executablePath = await findExecutable(manifest.command, root, env);
    return publicManifest(manifest, { builtin, executablePath });
  }));
  return resolved.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getAgent(name, options = {}) {
  const resolved = await resolveAgent(name, options);
  return publicManifest(resolved.manifest, resolved);
}

function normalizeRequest(request) {
  assertKnownFields(request, REQUEST_FIELDS, 'Agent request');
  const protocolVersion = request.protocolVersion ?? AGENT_PROTOCOL_VERSION;
  if (protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError('agent_protocol_version', 'Unsupported agent protocol version', { protocolVersion });
  }
  const stage = typeof request.stage === 'string' ? request.stage.trim() : '';
  if (!stage || stage.length > 128) {
    throw new AgentError('agent_invalid_request', 'Agent request stage must be a non-empty bounded string', { field: 'stage' });
  }
  if (typeof request.systemPrompt !== 'string' || typeof request.userPrompt !== 'string') {
    throw new AgentError('agent_invalid_request', 'Agent systemPrompt and userPrompt must be strings', { field: 'prompts' });
  }
  if (!isObject(request.schema)) {
    throw new AgentError('agent_invalid_request', 'Agent request schema must be a JSON object', { field: 'schema' });
  }
  const normalized = { protocolVersion, stage, systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, schema: request.schema };
  try {
    JSON.stringify(normalized);
  } catch {
    throw new AgentError('agent_invalid_request', 'Agent request must be JSON-serializable', {});
  }
  return normalized;
}

function promptArgument(request) {
  return [
    'JobOS agent protocol request:',
    'Return exactly one JSON object on stdout. Do not include Markdown fences or explanatory prose.',
    JSON.stringify(request)
  ].join('\n');
}

function appendTail(current, chunk, limit) {
  const combined = current.length ? Buffer.concat([current, chunk]) : Buffer.from(chunk);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

function redactStderr(buffer, wasTruncated, env) {
  let text = buffer.toString('utf8');
  for (const [key, value] of Object.entries(env || {})) {
    if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 4) text = text.split(value).join('[REDACTED]');
  }
  text = text
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|authorization|bearer|client[-_ ]?secret|password|passwd|secret|token)\s*(?:=|:)\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/("(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|password|passwd|secret|token)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]');
  let stderrTruncated = wasTruncated;
  if (text.length > MAX_STDERR_DETAIL_CHARS) {
    text = text.slice(-MAX_STDERR_DETAIL_CHARS);
    stderrTruncated = true;
  }
  return { stderr: text.trim(), stderrTruncated };
}

function processDetails({ name, manifest, exitCode, signal, stderr, stderrTruncated, env, elapsedMs, stdoutBytes }) {
  return {
    name,
    command: manifest.command,
    exitCode: exitCode ?? null,
    signal: signal ?? null,
    elapsedMs,
    stdoutBytes,
    ...redactStderr(stderr, stderrTruncated, env)
  };
}

async function executeAgent({ name, manifest, executablePath, root, env, request, timeoutMs }) {
  const serialized = JSON.stringify(request);
  const args = manifest.transport === 'prompt-arg' ? [...manifest.args, promptArgument(request)] : [...manifest.args];
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, args, { cwd: root, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new AgentError('agent_spawn_failed', `Agent "${name}" could not be started`, { name, command: manifest.command, cause: error?.code || 'unknown' }));
      return;
    }
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let stderrBytes = 0;
    let forcedFailure = null;
    let settled = false;
    let forceKillTimer;

    const stop = reason => {
      if (!forcedFailure) forcedFailure = reason;
      child.kill('SIGTERM');
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceKillTimer.unref?.();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_AGENT_STDOUT_BYTES) {
        stop('oversize');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      stderr = appendTail(stderr, chunk, MAX_STDERR_CAPTURE_BYTES);
    });
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      const code = error?.code === 'ENOENT' ? 'agent_missing_executable' : 'agent_spawn_failed';
      reject(new AgentError(code, `Agent "${name}" could not be started`, { name, command: manifest.command, cause: error?.code || 'unknown' }));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      const elapsedMs = Date.now() - startedAt;
      const details = processDetails({
        name,
        manifest,
        exitCode,
        signal,
        stderr,
        stderrTruncated: stderrBytes > stderr.length,
        env,
        elapsedMs,
        stdoutBytes
      });
      if (forcedFailure === 'timeout') {
        reject(new AgentError('agent_timeout', `Agent "${name}" timed out after ${timeoutMs}ms`, { ...details, timeoutMs }));
        return;
      }
      if (forcedFailure === 'oversize') {
        reject(new AgentError('agent_output_too_large', `Agent "${name}" exceeded the 50 KiB stdout limit`, { ...details, limitBytes: MAX_AGENT_STDOUT_BYTES }));
        return;
      }
      if (exitCode !== 0) {
        reject(new AgentError('agent_nonzero_exit', `Agent "${name}" exited unsuccessfully`, details));
        return;
      }
      const output = Buffer.concat(stdoutChunks).toString('utf8').trim();
      let json;
      try {
        json = JSON.parse(output);
      } catch {
        reject(new AgentError('agent_malformed_output', `Agent "${name}" did not return valid JSON`, details));
        return;
      }
      if (!isObject(json)) {
        reject(new AgentError('agent_malformed_output', `Agent "${name}" must return a JSON object`, details));
        return;
      }
      resolve({ json, elapsedMs, stdoutBytes });
    });

    child.stdin.end(manifest.transport === 'stdin-json' ? serialized : '');
  });
}

export async function runAgent(name, request, options = {}) {
  const normalizedRequest = normalizeRequest(request);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_AGENT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new AgentError('agent_invalid_timeout', 'Agent timeout must be an integer from 1 to 3600000 milliseconds', { timeoutMs: options.timeoutMs });
  }
  const resolved = await resolveAgent(name, options);
  if (!resolved.executablePath) {
    throw new AgentError('agent_missing_executable', `Agent executable "${resolved.manifest.command}" is unavailable`, {
      name: resolved.manifest.name,
      command: resolved.manifest.command,
      exitCode: null,
      signal: null,
      stderr: '',
      stderrTruncated: false
    });
  }
  const result = await executeAgent({ ...resolved, name: resolved.manifest.name, request: normalizedRequest, timeoutMs });
  return {
    ok: true,
    json: result.json,
    agent: {
      name: resolved.manifest.name,
      transport: resolved.manifest.transport,
      builtin: resolved.builtin
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
    timeoutMs,
    elapsedMs: result.elapsedMs,
    stdoutBytes: result.stdoutBytes
  };
}

export async function testAgent(name, options = {}) {
  const result = await runAgent(name, {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    stage: 'connection_test',
    systemPrompt: 'This is a JobOS agent protocol connection test. Do not access external services or modify state.',
    userPrompt: 'Return exactly {"ok":true,"protocolVersion":1}.',
    schema: {
      type: 'object',
      properties: { ok: { const: true }, protocolVersion: { const: AGENT_PROTOCOL_VERSION } },
      required: ['ok', 'protocolVersion'],
      additionalProperties: false
    }
  }, options);
  if (result.json.ok !== true || result.json.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError('agent_test_failed', `Agent "${result.agent.name}" did not satisfy the connection-test response`, {
      name: result.agent.name,
      expected: { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION }
    });
  }
  return { ...result, authenticated: true };
}
