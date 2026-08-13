import { access, constants as fsConstants } from 'node:fs/promises';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectAgentClient, doctorAgents, SUPPORTED_AGENT_CLIENTS } from '../src/agent-setup.js';
import { agentBackendCatalog } from '../src/acp.js';
import { mcpToolNames } from '../src/mcp.js';
import { AGENT_DOMAIN_TOOLS } from '../src/capabilities.js';
import { commandRegistry } from '../src/cli.js';

/** Canonical harness ids the parent loop must converge on. */
export const TARGET_HARNESS_IDS = Object.freeze(['hermes', 'codex', 'claude', 'grok', 'cursor', 'pi']);

/** Real PATH executable names (cursor → agent, pi → omp). */
export const HARNESS_EXECUTABLES = Object.freeze({
  hermes: 'hermes',
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
  cursor: 'agent',
  pi: 'omp'
});

const PI_ACP_BACKEND_IDS = ['omp-acp', 'pi-acp'];
const AGENT_ELIGIBLE_TOOL_NAMES = Object.freeze(['daily_discovery', 'pursue_job', 'answers_match']);

function checkResult(id, pass, message, details = {}) {
  return { id, pass: Boolean(pass), message, details };
}

function executableCandidates(command, env) {
  const directories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return [path.resolve(command)];
  if (process.platform !== 'win32') return directories.map(directory => path.join(directory, command));
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return directories.flatMap(directory => extensions.map(extension => path.join(directory, `${command}${extension}`)));
}

async function isExecutableOnPath(command, env = process.env) {
  for (const candidate of executableCandidates(command, env)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return { installed: true, path: candidate };
    } catch {}
  }
  return { installed: false, path: null };
}

function fakeAgentScript(clientId) {
  const label = HARNESS_EXECUTABLES[clientId] || clientId;
  return `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "test" ] && [ "$3" = "jobos" ]; then
  if [ -f "$FAKE_AGENT_STATE" ]; then printf '✓ jobos passed\\n'; exit 0; fi
  printf 'jobos not configured\\n'; exit 1
fi
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
printf '${label} 1.0\\n'
`;
}

export function createHarnessFixture(clientId, { root = mkdtempSync(path.join(tmpdir(), `jobos-harness-${clientId}-`)) } = {}) {
  const executableName = HARNESS_EXECUTABLES[clientId] || clientId;
  const state = path.join(root, 'registration.txt');
  const executable = path.join(root, executableName);
  writeFileSync(executable, fakeAgentScript(clientId), 'utf8');
  chmodSync(executable, 0o755);
  return {
    root,
    workspace: root,
    state,
    executable,
    cliPath: path.resolve('src/cli.js'),
    env: { ...process.env, PATH: root, FAKE_AGENT_STATE: state }
  };
}

export function registrationIncludesJobosEntrypoint(registration, { cliPath, workspace }) {
  const resolvedCli = path.resolve(cliPath);
  const resolvedWorkspace = path.resolve(workspace);

  if (registration?.kind === 'file' || registration?.content?.mcpServers?.jobos) {
    const server = registration.content?.mcpServers?.jobos;
    if (!server) return false;
    const args = Array.isArray(server.args) ? server.args : [];
    const hasMcp = args.includes('mcp') || /\bmcp\b/i.test(registration.display || '');
    const hasCli = args.includes(resolvedCli) || server.command === process.execPath;
    const hasWorkspace = args.includes(resolvedWorkspace)
      || args.some(arg => String(arg).includes('--workspace'))
      || server.env?.JOBOS_WORKSPACE === resolvedWorkspace;
    return hasMcp && hasCli && hasWorkspace;
  }

  const text = [
    registration?.display,
    registration?.path,
    registration?.command,
    ...(Array.isArray(registration?.args) ? registration.args : [])
  ].filter(Boolean).join(' ');
  if (!/\bmcp\b/i.test(text)) return false;
  const hasCli = text.includes(resolvedCli) || text.includes('cli.js');
  const hasWorkspace = text.includes(resolvedWorkspace) || /--workspace/.test(text);
  return hasCli && hasWorkspace;
}

export async function checkCatalogCompleteness({ workspace, cliPath, env }) {
  const supported = [...SUPPORTED_AGENT_CLIENTS];
  const missing = TARGET_HARNESS_IDS.filter(id => !supported.includes(id));
  const report = await doctorAgents({ workspace, cliPath, client: 'all', env });
  const doctorNames = report.clients.map(client => client.name);
  const doctorMissing = TARGET_HARNESS_IDS.filter(id => !doctorNames.includes(id));
  const pass = missing.length === 0 && doctorMissing.length === 0;
  return checkResult(
    'catalog-completeness',
    pass,
    pass
      ? 'Doctor catalog includes all six target harness ids.'
      : `Missing harness ids in CLIENTS (${missing.join(', ') || 'none'}) or doctor (${doctorMissing.join(', ') || 'none'}).`,
    { supported, doctorNames, missing, doctorMissing, mcpToolCount: report.mcpToolCount }
  );
}

export async function checkConnectCliContract() {
  const connectCmd = commandRegistry.find(entry => entry.name === 'agents connect');
  const usage = connectCmd?.usage || '';
  const missing = TARGET_HARNESS_IDS.filter(id => !usage.includes(id));
  const rejections = [];
  for (const id of TARGET_HARNESS_IDS) {
    try {
      await connectAgentClient(id, {
        workspace: process.cwd(),
        cliPath: path.resolve('src/cli.js'),
        env: { PATH: '/nonexistent' },
        dryRun: true
      });
      rejections.push({ id, code: null });
    } catch (error) {
      rejections.push({ id, code: error?.code || error?.message });
    }
  }
  const unsupported = rejections.filter(item => item.code === 'agent_client_unsupported').map(item => item.id);
  const pass = missing.length === 0 && unsupported.length === 0;
  return checkResult(
    'connect-cli-contract',
    pass,
    pass
      ? 'agents connect usage and connectAgentClient accept all six harness names.'
      : `Connect contract incomplete: usage missing [${missing.join(', ')}]; unsupported [${unsupported.join(', ')}].`,
    { usage, missing, unsupported, rejections }
  );
}

export async function checkDryRunRegistration(clientId, fixture) {
  try {
    const result = await connectAgentClient(clientId, { ...fixture, dryRun: true });
    const displayOk = registrationIncludesJobosEntrypoint(result.registration, fixture);
    const pass = result.status === 'preview' && displayOk;
    return checkResult(
      `dry-run-registration:${clientId}`,
      pass,
      pass
        ? `${clientId} dry-run preview includes JobOS MCP entrypoint.`
        : `${clientId} dry-run failed: status=${result.status}, displayOk=${displayOk}.`,
      { status: result.status, registration: result.registration, displayOk }
    );
  } catch (error) {
    return checkResult(
      `dry-run-registration:${clientId}`,
      false,
      `${clientId} dry-run threw: ${error?.code || error?.message}`,
      { error: error?.code || error?.message }
    );
  }
}

export async function checkIdempotentConnect(clientId, fixture) {
  try {
    const first = await connectAgentClient(clientId, fixture);
    const second = await connectAgentClient(clientId, fixture);
    const pass = first.status === 'ready'
      && first.changed === true
      && first.alreadyConnected === false
      && second.status === 'ready'
      && second.changed === false
      && second.alreadyConnected === true;
    return checkResult(
      `idempotent-connect:${clientId}`,
      pass,
      pass
        ? `${clientId} connect is idempotent (not-connected → ready → alreadyConnected).`
        : `${clientId} idempotent connect failed: first=${JSON.stringify({ status: first?.status, changed: first?.changed, alreadyConnected: first?.alreadyConnected })}, second=${JSON.stringify({ status: second?.status, changed: second?.changed, alreadyConnected: second?.alreadyConnected })}.`,
      { first: first ? { status: first.status, changed: first.changed, alreadyConnected: first.alreadyConnected } : null,
        second: second ? { status: second.status, changed: second.changed, alreadyConnected: second.alreadyConnected } : null }
    );
  } catch (error) {
    return checkResult(
      `idempotent-connect:${clientId}`,
      false,
      `${clientId} connect flow threw: ${error?.code || error?.message}`,
      { error: error?.code || error?.message }
    );
  }
}

export async function checkMcpToolSurfaceParity({ workspace, cliPath, env }) {
  const toolNames = mcpToolNames();
  const report = await doctorAgents({ workspace, cliPath, client: 'all', env });
  const countMatch = toolNames.length > 0 && report.mcpToolCount === toolNames.length;
  const agentToolSet = new Set(AGENT_DOMAIN_TOOLS.map(tool => tool.name));
  const missingEligible = AGENT_ELIGIBLE_TOOL_NAMES.filter(name => !agentToolSet.has(name) || !toolNames.includes(name));
  const pass = countMatch && missingEligible.length === 0;
  return checkResult(
    'mcp-tool-surface-parity',
    pass,
    pass
      ? `MCP exposes ${toolNames.length} tools; doctor mcpToolCount matches; agent-eligible domain tools present.`
      : `MCP tool parity failed: count=${toolNames.length}, doctor=${report.mcpToolCount}, missingEligible=[${missingEligible.join(', ')}].`,
    { toolCount: toolNames.length, doctorCount: report.mcpToolCount, missingEligible, sampleTools: toolNames.slice(0, 8) }
  );
}

export async function checkHermesAcpPrimary({ workspace, env }) {
  const backends = await agentBackendCatalog({ root: workspace, env });
  const hermes = backends.find(item => item.id === 'hermes-acp');
  const pass = Boolean(hermes && hermes.protocol === 'acp-v1' && hermes.role === 'primary');
  return checkResult(
    'hermes-acp-primary',
    pass,
    pass
      ? 'agentBackendCatalog includes hermes-acp (acp-v1, primary).'
      : 'hermes-acp missing or not primary acp-v1 backend.',
    { hermes: hermes ? { id: hermes.id, protocol: hermes.protocol, role: hermes.role } : null }
  );
}

export async function checkPiOmpAcpAlternate({ workspace, env }) {
  const backends = await agentBackendCatalog({ root: workspace, env });
  const piBackend = backends.find(item => PI_ACP_BACKEND_IDS.includes(item.id));
  const pass = Boolean(piBackend && piBackend.protocol === 'acp-v1');
  return checkResult(
    'pi-omp-acp-alternate',
    pass,
    pass
      ? `agentBackendCatalog includes ${piBackend.id} (acp-v1 alternate).`
      : `Pi/OMP ACP alternate missing: expected backend id ${PI_ACP_BACKEND_IDS.join(' or ')} with protocol acp-v1.`,
    { backends: backends.map(item => ({ id: item.id, protocol: item.protocol, role: item.role })) }
  );
}

export async function checkLiveInstalledClients({ workspace, cliPath, env = process.env }) {
  const live = {};
  const failures = [];
  for (const clientId of TARGET_HARNESS_IDS) {
    const command = HARNESS_EXECUTABLES[clientId];
    const { installed, path: executablePath } = await isExecutableOnPath(command, env);
    let dryRunOk = null;
    let notes = installed ? 'binary on PATH' : 'binary not installed (skipped)';
    if (installed) {
      try {
        const result = await connectAgentClient(clientId, { workspace, cliPath, env, dryRun: true });
        dryRunOk = result.status === 'preview'
          && registrationIncludesJobosEntrypoint(result.registration, { cliPath, workspace });
        if (!dryRunOk) {
          notes = 'installed but dry-run preview/registration check failed';
          failures.push(clientId);
        }
      } catch (error) {
        dryRunOk = false;
        notes = `installed but dry-run threw ${error?.code || error?.message}`;
        failures.push(clientId);
      }
    }
    live[clientId] = { installed, executable: executablePath, dryRunOk, notes };
  }
  const pass = failures.length === 0;
  return checkResult(
    'live-installed-client-smoke',
    pass,
    pass
      ? 'All installed harness binaries pass dry-run registration.'
      : `Installed harness dry-run failures: ${failures.join(', ')}.`,
    { live, failures }
  );
}

export function checkDocsMentionConnect() {
  const guide = readFileSync(path.resolve('docs/AGENT_GUIDE.md'), 'utf8');
  const mentionsConnect = /agents connect/i.test(guide);
  const required = ['hermes', 'codex', 'claude', 'grok', 'cursor', 'pi'];
  const missing = required.filter(name => !new RegExp(`\\b${name}\\b`, 'i').test(guide));
  const legacyOnly = /\bhermes\b/i.test(guide)
    && /\bcodex\b/i.test(guide)
    && /\bclaude\b/i.test(guide)
    && missing.length > 0;
  const pass = mentionsConnect && missing.length === 0 && !legacyOnly;
  return checkResult(
    'docs-agent-guide-connect',
    pass,
    pass
      ? 'docs/AGENT_GUIDE.md mentions agents connect for the expanded harness set.'
      : `AGENT_GUIDE incomplete: missing [${missing.join(', ')}]; legacy-only=${legacyOnly}.`,
    { mentionsConnect, missing, legacyOnly }
  );
}

/**
 * Career-ops parity: Claude Code / Codex can open the repo and drive JobOS via
 * thin wrappers + shared skill (not MCP alone).
 */
export function checkCareerOpsClaudeCodexParity() {
  const root = process.cwd();
  const requiredFiles = [
    'CLAUDE.md',
    'CODEX.md',
    'docs/CLAUDE.md',
    'docs/CODEX.md',
    '.agents/skills/jobos/SKILL.md',
    '.claude/skills/jobos/SKILL.md'
  ];
  const missing = requiredFiles.filter(rel => !existsSync(path.join(root, rel)));
  const skill = existsSync(path.join(root, '.agents/skills/jobos/SKILL.md'))
    ? readFileSync(path.join(root, '.agents/skills/jobos/SKILL.md'), 'utf8')
    : '';
  const claude = existsSync(path.join(root, 'CLAUDE.md'))
    ? readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
    : '';
  const codex = existsSync(path.join(root, 'CODEX.md'))
    ? readFileSync(path.join(root, 'CODEX.md'), 'utf8')
    : '';
  const skillHasRouter = /name:\s*jobos/i.test(skill) && /Mode Routing/i.test(skill);
  const wrappersImportSkill = /@\.agents\/skills\/jobos\/SKILL\.md/.test(claude)
    && /@\.agents\/skills\/jobos\/SKILL\.md/.test(codex);
  const wrappersMentionConnect = /agents connect claude/i.test(claude)
    && /agents connect codex/i.test(codex);
  let symlinkOk = false;
  try {
    const link = path.join(root, '.claude/skills/jobos/SKILL.md');
    const st = lstatSync(link);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(link);
      symlinkOk = target.includes('.agents/skills/jobos/SKILL.md');
    } else {
      symlinkOk = existsSync(link);
    }
  } catch {
    symlinkOk = false;
  }
  const pass = missing.length === 0 && skillHasRouter && wrappersImportSkill && wrappersMentionConnect && symlinkOk;
  return checkResult(
    'career-ops-claude-codex-parity',
    pass,
    pass
      ? 'Claude/Codex career-ops-style entrypoints and jobos skill are present.'
      : `Career-ops Claude/Codex parity incomplete: missing=[${missing.join(', ')}] skillRouter=${skillHasRouter} wrappers=${wrappersImportSkill} connect=${wrappersMentionConnect} symlink=${symlinkOk}.`,
    { missing, skillHasRouter, wrappersImportSkill, wrappersMentionConnect, symlinkOk }
  );
}

export async function runHarnessBenchmark({
  workspace = mkdtempSync(path.join(tmpdir(), 'jobos-harness-bench-')),
  cliPath = path.resolve('src/cli.js'),
  env = process.env
} = {}) {
  const supported = [...SUPPORTED_AGENT_CLIENTS];
  const checks = [];

  checks.push(await checkCatalogCompleteness({ workspace, cliPath, env }));
  checks.push(await checkConnectCliContract());
  checks.push(await checkMcpToolSurfaceParity({ workspace, cliPath, env }));
  checks.push(await checkHermesAcpPrimary({ workspace, env }));
  checks.push(await checkPiOmpAcpAlternate({ workspace, env }));
  checks.push(checkDocsMentionConnect());
  checks.push(checkCareerOpsClaudeCodexParity());

  for (const clientId of TARGET_HARNESS_IDS) {
    if (!supported.includes(clientId)) {
      checks.push(checkResult(
        `dry-run-registration:${clientId}`,
        false,
        `${clientId} not in CLIENTS; dry-run registration cannot run.`,
        { supported }
      ));
      checks.push(checkResult(
        `idempotent-connect:${clientId}`,
        false,
        `${clientId} not in CLIENTS; idempotent connect cannot run.`,
        { supported }
      ));
      continue;
    }
    const fixture = createHarnessFixture(clientId);
    checks.push(await checkDryRunRegistration(clientId, fixture));
    checks.push(await checkIdempotentConnect(clientId, fixture));
  }

  const liveCheck = await checkLiveInstalledClients({ workspace, cliPath, env });
  checks.push(liveCheck);

  const passed = checks.filter(item => item.pass).length;
  const failed = checks.filter(item => !item.pass).length;
  const failures = checks.filter(item => !item.pass).map(item => ({ id: item.id, message: item.message }));
  const converged = failed === 0;

  const iterationHint = converged
    ? 'All harness convergence criteria pass; parent loop may stop.'
    : failures.some(item => item.id.startsWith('dry-run-registration:') || item.id === 'catalog-completeness' || item.id === 'connect-cli-contract')
      ? 'Add missing CLIENTS/connect wiring for grok, cursor, and pi (omp) first.'
      : failures.some(item => item.id === 'pi-omp-acp-alternate')
        ? 'Catalog omp-acp/pi-acp in agentBackendCatalog with acp-v1.'
        : failures.some(item => item.id === 'docs-agent-guide-connect')
          ? 'Expand docs/AGENT_GUIDE.md to mention grok, cursor, and pi connect paths.'
          : failures.some(item => item.id === 'career-ops-claude-codex-parity')
            ? 'Add CLAUDE.md, CODEX.md, and .agents/skills/jobos (Claude symlink) like career-ops.'
            : 'Fix remaining benchmark failures and re-run benchmark:harness.';

  return {
    schema: 'jobos.agent-harness-benchmark.v1',
    converged,
    passed,
    failed,
    iterationHint,
    failures,
    checks,
    live: liveCheck.details.live,
    targetHarnessIds: [...TARGET_HARNESS_IDS],
    supportedClients: supported
  };
}

export function formatHarnessBenchmarkResult(report) {
  return `HARNESS_BENCHMARK_RESULT ${JSON.stringify({
    converged: report.converged,
    passed: report.passed,
    failed: report.failed,
    iterationHint: report.iterationHint,
    failures: report.failures
  })}`;
}
