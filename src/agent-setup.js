import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { agentBackendCatalog } from './acp.js';
import { listAgents } from './agents.js';
import { mcpToolNames } from './mcp.js';

const CLIENT_ALIASES = Object.freeze({
  omp: 'pi'
});

const CLIENTS = Object.freeze({
  hermes: Object.freeze({
    command: 'hermes',
    embedded: 'acp-v1',
    batch: true,
    registration: 'cli',
    probeArgs: Object.freeze(['mcp', 'test', 'jobos'])
  }),
  codex: Object.freeze({
    command: 'codex',
    embedded: null,
    batch: true,
    registration: 'cli',
    probeArgs: Object.freeze(['mcp', 'list'])
  }),
  claude: Object.freeze({
    command: 'claude',
    embedded: null,
    batch: false,
    registration: 'cli',
    probeArgs: Object.freeze(['mcp', 'list'])
  }),
  grok: Object.freeze({
    command: 'grok',
    embedded: null,
    batch: false,
    registration: 'cli',
    probeArgs: Object.freeze(['mcp', 'list'])
  }),
  cursor: Object.freeze({
    command: 'agent',
    embedded: null,
    batch: false,
    registration: 'file',
    configPath: '.cursor/mcp.json',
    probeArgs: Object.freeze(['mcp', 'list'])
  }),
  pi: Object.freeze({
    command: 'omp',
    embedded: 'acp-v1',
    batch: false,
    registration: 'file',
    configPath: '.omp/mcp.json',
    probeArgs: null
  })
});

export const SUPPORTED_AGENT_CLIENTS = Object.freeze(Object.keys(CLIENTS));

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
  const resolved = CLIENT_ALIASES[normalized] || normalized;
  const definition = CLIENTS[resolved];
  if (!definition) {
    throw new AgentSetupError('agent_client_unsupported', `Unsupported agent client: ${name || '(missing)'}`, {
      supported: SUPPORTED_AGENT_CLIENTS
    });
  }
  return { name: resolved, ...definition };
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

function runCommand(command, args, { cwd, env = process.env, timeoutMs = 10_000, stdin = null } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });
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
    if (stdin != null) {
      // EPIPE (child exits/closes stdin before the write drains) is delivered
      // asynchronously as an 'error' event on the writable stream; without a
      // listener it would crash the process. The close/exit result still decides success.
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(String(stdin));
        child.stdin.end();
      } catch {
        // Child may exit before stdin is fully written; probe/output still decide success.
      }
    }
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

function jobosMcpServerEntry({ cliPath, workspace, client }) {
  const entry = {
    command: process.execPath,
    args: [cliPath, 'mcp', '--workspace', workspace],
    env: {
      JOBOS_HOME: workspace,
      JOBOS_WORKSPACE: workspace
    }
  };
  if (client === 'pi') entry.enabled = true;
  return entry;
}

function registrationArgs(client, { cliPath, workspace }) {
  const server = [process.execPath, cliPath, 'mcp', '--workspace', workspace];
  if (client === 'codex') return ['mcp', 'add', 'jobos', '--', ...server];
  // User scope connects immediately; project/local .mcp.json requires interactive approval.
  if (client === 'claude') return ['mcp', 'add', '--scope', 'user', 'jobos', '--', ...server];
  if (client === 'grok') return ['mcp', 'add', 'jobos', '--scope', 'project', '--', ...server];
  return ['mcp', 'add', 'jobos', '--command', process.execPath, '--args', cliPath, 'mcp', '--workspace', workspace];
}

async function readMcpConfig(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { mcpServers: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { mcpServers: {} };
    throw error;
  }
}

function mcpConfigHasJobos(config) {
  const server = config?.mcpServers?.jobos;
  return Boolean(server?.command && Array.isArray(server?.args) && server.args.includes('mcp'));
}

async function probeFileRegistration(clientName, definition, root) {
  const configPath = path.join(root, definition.configPath);
  let output = '';
  try {
    const config = await readMcpConfig(configPath);
    const ok = mcpConfigHasJobos(config);
    output = ok ? `jobos configured in ${definition.configPath}` : `jobos not found in ${definition.configPath}`;
    return {
      ok,
      command: `read ${definition.configPath}`,
      exitCode: ok ? 0 : 1,
      output,
      error: ok ? null : 'jobos_missing'
    };
  } catch (error) {
    return {
      ok: false,
      command: `read ${definition.configPath}`,
      exitCode: null,
      output: error?.message || String(error),
      error: error?.code || 'read_failed'
    };
  }
}

async function buildFileRegistration(clientName, definition, { cliPath, workspace }) {
  const configPath = path.join(workspace, definition.configPath);
  const existing = await readMcpConfig(configPath);
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      jobos: jobosMcpServerEntry({ cliPath, workspace, client: clientName })
    }
  };
  return {
    kind: 'file',
    configPath: definition.configPath,
    absolutePath: configPath,
    content: merged,
    display: `write ${definition.configPath} (merge jobos MCP server)`
  };
}

async function applyFileRegistration(registration, { dryRun = false } = {}) {
  if (dryRun) return { ok: true, output: 'dry-run' };
  try {
    const dir = path.dirname(registration.absolutePath);
    await mkdir(dir, {
      recursive: true,
      mode: registration.configPath.startsWith('.omp/') ? 0o700 : undefined
    });
    await writeFile(registration.absolutePath, `${JSON.stringify(registration.content, null, 2)}\n`, 'utf8');
    return { ok: true, output: `wrote ${registration.configPath}` };
  } catch (error) {
    // Return a structured failure so connectAgentClient's existing
    // agent_registration_failed path (instead of a raw fs error) fires.
    return { ok: false, output: '', error: error?.message || String(error) };
  }
}

function displayCommand(command, args) {
  const quote = value => /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
  return [command, ...args].map(value => quote(String(value))).join(' ');
}

function registrationObserved(client, probe) {
  if (!probe.ok) return false;
  // Claude/Codex list lines look like `jobos: …` or table rows containing jobos.
  if (!/\bjobos\b/i.test(probe.output)) return false;
  if (client === 'hermes') return /(?:✓|passed|success|connected|healthy|ready)/i.test(probe.output);
  // Project-scoped Claude servers may be listed as pending approval until the user
  // confirms once inside `claude`; registration still succeeded.
  return true;
}

function registrationPendingApproval(probe) {
  return /pending approval/i.test(String(probe?.output || ''));
}

async function probeClient(client, executable, options) {
  const definition = CLIENTS[client];
  const root = path.resolve(options.cwd || process.cwd());
  if (definition.registration === 'file' && !definition.probeArgs) {
    return probeFileRegistration(client, definition, root);
  }
  let cliProbe = null;
  if (definition.probeArgs && executable) {
    const result = await runCommand(executable, definition.probeArgs, options);
    cliProbe = {
      ok: registrationObserved(client, result),
      command: displayCommand(executable, definition.probeArgs),
      exitCode: result.exitCode,
      output: result.output,
      error: result.error
    };
    if (cliProbe.ok || client !== 'cursor') return cliProbe;
  }
  if (definition.registration === 'file') {
    const fileProbe = await probeFileRegistration(client, definition, root);
    if (fileProbe.ok || !cliProbe) return fileProbe;
    return { ...cliProbe, fileFallback: fileProbe };
  }
  if (!executable) {
    return { ok: false, command: definition.command, exitCode: null, output: '', error: 'client_missing' };
  }
  return cliProbe;
}

function connectVerificationOk(client, { listProbe, fileProbe } = {}) {
  if (listProbe?.ok) return true;
  // File-registration clients are verified by reading back the config we just
  // wrote; requiring `agent mcp enable` to succeed too would fail a connect
  // that already registered (headless/CI where the CLI enable step exits
  // non-zero but the .cursor/mcp.json write is intact and re-readable).
  if (client === 'cursor') return Boolean(fileProbe?.ok);
  if (client === 'pi') return Boolean(fileProbe?.ok);
  return false;
}

function connectionResult(client, {
  workspace,
  registration,
  verification,
  status,
  changed,
  alreadyConnected,
  enableProbe = null
}) {
  return {
    schema: 'jobos.agent-connection.v1',
    client: client.name,
    workspace,
    modes: { embedded: client.embedded, externalMcp: true, batch: client.batch },
    status,
    changed,
    alreadyConnected,
    pendingApproval: registrationPendingApproval(verification),
    registration,
    verification,
    ...(enableProbe ? {
      enable: {
        ok: enableProbe.ok,
        exitCode: enableProbe.exitCode,
        output: enableProbe.output,
        error: enableProbe.error
      }
    } : {})
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
  const processOptions = {
    cwd: root,
    env: {
      ...env,
      // Hermes MCP add prompts to enable tools; accept non-interactively when possible.
      HERMES_ACCEPT_HOOKS: env.HERMES_ACCEPT_HOOKS || '1'
    },
    // Hermes MCP discovery + tool enable can exceed the default 10s probe budget.
    timeoutMs: client.name === 'hermes' ? Math.max(timeoutMs, 45_000) : timeoutMs
  };
  const before = await probeClient(client.name, executable, processOptions);
  const registration = client.registration === 'file'
    ? await buildFileRegistration(client.name, client, { cliPath: resolvedCli, workspace: root })
    : {
        kind: 'cli',
        command: executable,
        args: registrationArgs(client.name, { cliPath: resolvedCli, workspace: root }),
        display: displayCommand(executable, registrationArgs(client.name, { cliPath: resolvedCli, workspace: root }))
      };
  if (dryRun) {
    return connectionResult(client, {
      workspace: root,
      registration,
      verification: before,
      status: 'preview',
      changed: false,
      alreadyConnected: Boolean(before.ok || (client.name === 'cursor' && before.fileFallback?.ok))
    });
  }
  if (before.ok || (client.name === 'cursor' && before.fileFallback?.ok)) {
    return connectionResult(client, {
      workspace: root,
      registration,
      verification: before.ok ? before : before.fileFallback,
      status: 'ready',
      changed: false,
      alreadyConnected: true
    });
  }
  let enableProbe = null;
  if (client.registration === 'file') {
    const applied = await applyFileRegistration(registration, { dryRun: false });
    if (!applied.ok) {
      throw new AgentSetupError('agent_registration_failed', `Could not register JobOS with ${client.name}`, {
        client: client.name,
        command: registration.display,
        output: applied.output,
        error: applied.error
      });
    }
    if (client.name === 'cursor') {
      enableProbe = await runCommand(executable, ['mcp', 'enable', 'jobos'], processOptions);
    }
  } else {
    const applied = await runCommand(executable, registration.args, {
      ...processOptions,
      // Hermes prompts "Enable all N tools? [Y/n/select]" — answer yes without a TTY.
      stdin: client.name === 'hermes' ? 'Y\n' : null
    });
    if (!applied.ok) {
      throw new AgentSetupError('agent_registration_failed', `Could not register JobOS with ${client.name}`, {
        client: client.name,
        command: registration.display,
        exitCode: applied.exitCode,
        error: applied.error,
        output: applied.output
      });
    }
  }
  const listProbe = client.probeArgs && executable
    ? await probeClient(client.name, executable, processOptions)
    : null;
  const fileProbe = client.registration === 'file'
    ? await probeFileRegistration(client.name, client, root)
    : null;
  const verification = listProbe?.ok
    ? listProbe
    : (fileProbe?.ok ? fileProbe : (listProbe || fileProbe));
  if (!connectVerificationOk(client.name, { listProbe, fileProbe, enableProbe })) {
    throw new AgentSetupError('agent_registration_unverified', `JobOS registration was not visible to ${client.name}`, {
      client: client.name,
      registration: registration.display,
      verification,
      enable: enableProbe ? {
        ok: enableProbe.ok,
        exitCode: enableProbe.exitCode,
        output: enableProbe.output,
        error: enableProbe.error
      } : null
    });
  }
  return connectionResult(client, {
    workspace: root,
    registration,
    verification,
    status: 'ready',
    changed: true,
    alreadyConnected: false,
    enableProbe
  });
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
  const selected = client === 'all' ? SUPPORTED_AGENT_CLIENTS : [clientDefinition(client).name];
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
    const embeddedBackendId = name === 'hermes' ? 'hermes-acp' : (name === 'pi' ? 'omp-acp' : null);
    const embeddedBackend = embeddedBackendId ? backends.find(item => item.id === embeddedBackendId) : null;
    const batch = batchAgents.find(item => item.name === name);
    let externalMcp = null;
    if (definition.registration === 'file' && !definition.probeArgs) {
      externalMcp = await probeFileRegistration(name, definition, root);
    } else if (executable) {
      externalMcp = await probeClient(name, executable, { cwd: root, env, timeoutMs });
    } else {
      externalMcp = { ok: false, error: 'client_missing', output: '' };
    }
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
