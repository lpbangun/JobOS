import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { agentBackendCatalog } from './acp.js';
import { listAgents } from './agents.js';
import { mcpToolNames } from './mcp.js';

const CLIENTS = Object.freeze({
  hermes: Object.freeze({
    command: 'hermes',
    embedded: 'acp-v1',
    batch: true,
    probeArgs: Object.freeze(['mcp', 'test', 'jobos'])
  }),
  codex: Object.freeze({
    command: 'codex',
    embedded: null,
    batch: true,
    probeArgs: Object.freeze(['mcp', 'list'])
  }),
  claude: Object.freeze({
    command: 'claude',
    embedded: null,
    batch: false,
    probeArgs: Object.freeze(['mcp', 'list'])
  })
});

const MAX_PROBE_OUTPUT_BYTES = 32 * 1024;

export class AgentSetupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentSetupError';
    this.type = 'agent_setup_error';
    this.code = code;
    this.details = details;
  }
}

function clientDefinition(name) {
  const normalized = String(name || '').trim().toLowerCase();
  const definition = CLIENTS[normalized];
  if (!definition) {
    throw new AgentSetupError('agent_client_unsupported', `Unsupported agent client: ${name || '(missing)'}`, {
      supported: Object.keys(CLIENTS)
    });
  }
  return { name: normalized, ...definition };
}

function executableCandidates(command, env) {
  const directories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return [path.resolve(command)];
  if (process.platform !== 'win32') return directories.map(directory => path.join(directory, command));
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return directories.flatMap(directory => extensions.map(extension => path.join(directory, `${command}${extension}`)));
}

async function findExecutable(command, env = process.env) {
  for (const candidate of executableCandidates(command, env)) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function runCommand(command, args, { cwd, env = process.env, timeoutMs = 10_000 } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, output: '', error: error?.code || 'spawn_failed' });
      return;
    }
    let settled = false;
    let output = Buffer.alloc(0);
    const append = chunk => {
      if (output.length >= MAX_PROBE_OUTPUT_BYTES) return;
      const bytes = Buffer.from(chunk);
      output = Buffer.concat([output, bytes.subarray(0, MAX_PROBE_OUTPUT_BYTES - output.length)]);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: output.toString('utf8').trim() });
    };
    child.on('error', error => finish({ ok: false, exitCode: null, signal: null, error: error?.code || 'spawn_failed' }));
    child.on('close', (exitCode, signal) => finish({
      ok: exitCode === 0,
      exitCode,
      signal: signal || null,
      error: exitCode === 0 ? null : (signal ? `signal_${signal}` : `exit_${exitCode}`)
    }));
  });
}

function registrationArgs(client, { cliPath, workspace }) {
  const server = [process.execPath, cliPath, 'mcp', '--workspace', workspace];
  if (client === 'codex') return ['mcp', 'add', 'jobos', '--', ...server];
  if (client === 'claude') return ['mcp', 'add', '--scope', 'project', 'jobos', '--', ...server];
  return ['mcp', 'add', 'jobos', '--command', process.execPath, '--args', cliPath, 'mcp', '--workspace', workspace];
}

function displayCommand(command, args) {
  const quote = value => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
  return [command, ...args].map(value => quote(String(value))).join(' ');
}

function registrationObserved(client, probe) {
  if (!probe.ok || /(?:not found|not configured|failed|error|unavailable|✗)/i.test(probe.output)) return false;
  if (client === 'hermes') return /(?:✓|passed|success|connected|healthy|ready)/i.test(probe.output);
  return /(?:^|\s)jobos(?:\s|$)/i.test(probe.output);
}

async function probeClient(client, executable, options) {
  const definition = CLIENTS[client];
  const result = await runCommand(executable, definition.probeArgs, options);
  return {
    ok: registrationObserved(client, result),
    command: displayCommand(executable, definition.probeArgs),
    exitCode: result.exitCode,
    output: result.output,
    error: result.error
  };
}

export async function connectAgentClient(name, {
  workspace = process.cwd(),
  cliPath,
  env = process.env,
  dryRun = false,
  timeoutMs = 10_000
} = {}) {
  const client = clientDefinition(name);
  const root = path.resolve(workspace);
  const resolvedCli = path.resolve(String(cliPath || ''));
  if (!cliPath) throw new AgentSetupError('agent_cli_path_missing', 'JobOS CLI path is required for MCP registration');
  await access(resolvedCli, fsConstants.R_OK).catch(error => {
    throw new AgentSetupError('agent_cli_path_unavailable', 'JobOS CLI entrypoint is not readable', { cliPath: resolvedCli, cause: error?.code || 'unknown' });
  });
  const executable = await findExecutable(client.command, env);
  if (!executable) {
    throw new AgentSetupError('agent_client_missing', `${client.name} is not installed or is not on PATH`, {
      client: client.name,
      command: client.command
    });
  }
  const processOptions = { cwd: root, env, timeoutMs };
  const before = await probeClient(client.name, executable, processOptions);
  const args = registrationArgs(client.name, { cliPath: resolvedCli, workspace: root });
  const registration = {
    command: executable,
    args,
    display: displayCommand(executable, args)
  };
  if (before.ok) {
    return {
      schema: 'jobos.agent-connection.v1',
      client: client.name,
      workspace: root,
      modes: { embedded: client.embedded, externalMcp: true, batch: client.batch },
      status: 'ready',
      changed: false,
      alreadyConnected: true,
      registration,
      verification: before
    };
  }
  if (dryRun) {
    return {
      schema: 'jobos.agent-connection.v1',
      client: client.name,
      workspace: root,
      modes: { embedded: client.embedded, externalMcp: true, batch: client.batch },
      status: 'preview',
      changed: false,
      alreadyConnected: false,
      registration,
      verification: before
    };
  }
  const applied = await runCommand(executable, args, processOptions);
  if (!applied.ok) {
    throw new AgentSetupError('agent_registration_failed', `Could not register JobOS with ${client.name}`, {
      client: client.name,
      command: registration.display,
      exitCode: applied.exitCode,
      error: applied.error,
      output: applied.output
    });
  }
  const verification = await probeClient(client.name, executable, processOptions);
  if (!verification.ok) {
    throw new AgentSetupError('agent_registration_unverified', `JobOS registration was not visible to ${client.name}`, {
      client: client.name,
      registration: registration.display,
      verification
    });
  }
  return {
    schema: 'jobos.agent-connection.v1',
    client: client.name,
    workspace: root,
    modes: { embedded: client.embedded, externalMcp: true, batch: client.batch },
    status: 'ready',
    changed: true,
    alreadyConnected: false,
    registration,
    verification
  };
}

function check(id, status, message, recovery = null, details = {}) {
  return { id, status, message, recovery, details };
}

export async function doctorAgents({
  workspace = process.cwd(),
  cliPath,
  client = 'all',
  env = process.env,
  timeoutMs = 5_000
} = {}) {
  const root = path.resolve(workspace);
  const selected = client === 'all' ? Object.keys(CLIENTS) : [clientDefinition(client).name];
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check(
    'node',
    nodeMajor >= 22 ? 'pass' : 'fail',
    `Node.js ${process.versions.node}`,
    nodeMajor >= 22 ? null : 'Install Node.js 22 or newer.'
  ));
  let workspaceReady = true;
  try {
    await access(root, fsConstants.R_OK | fsConstants.W_OK);
    checks.push(check('workspace', 'pass', `Workspace is readable and writable: ${root}`));
  } catch (error) {
    workspaceReady = false;
    checks.push(check('workspace', 'fail', `Workspace is not readable and writable: ${root}`, 'Choose a writable --workspace directory.', { cause: error?.code || 'unknown' }));
  }
  let cliReady = true;
  const resolvedCli = cliPath ? path.resolve(cliPath) : null;
  try {
    if (!resolvedCli) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    await access(resolvedCli, fsConstants.R_OK);
    checks.push(check('jobos-cli', 'pass', `CLI entrypoint is readable: ${resolvedCli}`));
  } catch (error) {
    cliReady = false;
    checks.push(check('jobos-cli', 'fail', 'CLI entrypoint is unavailable.', 'Reinstall JobOS or run doctor from the installed package.', { cause: error?.code || 'unknown' }));
  }
  const [backends, batchAgents] = await Promise.all([
    agentBackendCatalog({ root, env }),
    listAgents({ workspace: root, env })
  ]);
  const clients = [];
  for (const name of selected) {
    const definition = CLIENTS[name];
    const executable = await findExecutable(definition.command, env);
    const embeddedBackend = name === 'hermes' ? backends.find(item => item.id === 'hermes-acp') : null;
    const batch = batchAgents.find(item => item.name === name);
    let externalMcp = null;
    if (executable) externalMcp = await probeClient(name, executable, { cwd: root, env, timeoutMs });
    const usable = Boolean(embeddedBackend?.available || batch?.available || externalMcp?.ok);
    clients.push({
      name,
      executable,
      installed: Boolean(executable),
      authentication: embeddedBackend?.available ? 'verified_by_acp_check' : 'not_verified',
      embedded: embeddedBackend ? {
        available: embeddedBackend.available,
        protocol: embeddedBackend.protocol,
        readiness: embeddedBackend.readiness
      } : { available: false, protocol: null, readiness: 'external-mcp-only' },
      externalMcp: externalMcp || { ok: false, error: 'client_missing', output: '' },
      batch: { available: Boolean(batch?.available), transport: batch?.transport || null },
      usable,
      recovery: executable
        ? (externalMcp?.ok || embeddedBackend?.available ? null : `Run jobos agents connect ${name}`)
        : `Install ${name}, then run jobos agents connect ${name}`
    });
    checks.push(check(
      `agent-${name}`,
      usable ? 'pass' : (executable ? 'warn' : 'fail'),
      usable ? `${name} has a usable JobOS path.` : `${name} is not ready for JobOS.`,
      clients.at(-1).recovery,
      { installed: Boolean(executable), embedded: Boolean(embeddedBackend?.available), externalMcp: Boolean(externalMcp?.ok), batch: Boolean(batch?.available) }
    ));
  }
  const coreReady = nodeMajor >= 22 && workspaceReady && cliReady;
  const agentReady = clients.some(item => item.usable);
  return {
    schema: 'jobos.agent-doctor.v1',
    status: coreReady && agentReady ? 'ready' : (coreReady ? 'needs_agent' : 'blocked'),
    coreReady,
    agentReady,
    workspace: root,
    mcpToolCount: mcpToolNames().length,
    checks,
    clients,
    policy: {
      primaryHumanSurface: 'tui',
      canonicalState: 'sqlite',
      externalAgents: 'mcp',
      humanAuthority: 'trusted_tui_or_cli'
    }
  };
}
