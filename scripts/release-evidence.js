#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SENTINELS } from '../tests/fixtures/w10/sentinel-leak-fixture.js';

const REPO_ROOT = process.cwd();
const NODE = process.execPath;

export const RELEASE_CHECKS = Object.freeze({
  goldens: Object.freeze([NODE, '--test', '--test-concurrency=1', 'tests/w10-golden.test.js']),
  security: Object.freeze([NODE, 'scripts/check-release-security.js', '--format', 'json']),
  docsStatus: Object.freeze([NODE, '--test', '--test-concurrency=1', 'tests/w10-docs-status.test.js']),
  mcpFraming: Object.freeze([NODE, '--test', '--test-concurrency=1', 'tests/mcp-framing.test.js']),
  mcpCompatibility: Object.freeze([
    Object.freeze([NODE, '--test', '--test-concurrency=1', 'tests/w10-mcp-compatibility.test.js', '--test-name-pattern=W10-MCP-COMPAT']),
    Object.freeze([NODE, 'scripts/seed-mcp-demo.js']),
    Object.freeze([NODE, 'scripts/mcp-demo.js'])
  ]),
  mcpDecision: Object.freeze([NODE, '--test', '--test-concurrency=1', 'tests/w10-mcp-compatibility.test.js', '--test-name-pattern=W10-MCP-DECISION']),
  fullSuite: Object.freeze(['npm', '--prefix', REPO_ROOT, 'run', 'test']),
  smoke: Object.freeze(['npm', '--prefix', REPO_ROOT, 'run', 'smoke']),
  dependencyAudit: Object.freeze(['npm', 'audit', '--omit=dev', '--audit-level=high', '--json'])
});

const CHECK_NAMES = Object.freeze(Object.keys(RELEASE_CHECKS));
const FORBIDDEN_COMMAND = /(?:^|\s)(?:deploy|publish|release|tag|push)(?:\s|$)/i;

function sha256File(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function commandText(argv) {
  return (Array.isArray(argv[0]) ? argv.flat() : argv).join(' ');
}

function checkEntry(name, outputRoot) {
  const argv = RELEASE_CHECKS[name];
  if (FORBIDDEN_COMMAND.test(commandText(argv))) throw new Error(`Forbidden release command in ${name}`);
  return {
    argv,
    cwd: REPO_ROOT,
    exitCode: null,
    status: 'pending',
    outputPath: path.join(outputRoot, `${name}.json`)
  };
}

export function buildEvidenceSkeleton({ outputRoot, generatedAt = new Date().toISOString() }) {
  const resolved = path.resolve(outputRoot);
  return {
    schema: 'jobos.release-evidence.v1',
    generatedAt,
    status: 'pending',
    environment: { node: process.version, npm: null },
    gitCommit: null,
    packageLockSha256: null,
    fixtureManifestSha256: null,
    goldenFixtureCount: null,
    checks: Object.fromEntries(CHECK_NAMES.map(name => [name, checkEntry(name, resolved)]))
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function classifyAuditResult({ skipped = false, exitCode, stdout, stderr }) {
  if (skipped) return { status: 'inconclusive', reason: 'audit-skipped-test-only', vulnerabilities: null };
  const parsed = parseJson(stdout);
  const vulnerabilities = parsed?.metadata?.vulnerabilities || null;
  if (exitCode === 0 && vulnerabilities && Number(vulnerabilities.high || 0) === 0 && Number(vulnerabilities.critical || 0) === 0) {
    return { status: 'passed', reason: 'no-high-or-critical-production-advisories', vulnerabilities };
  }
  if (vulnerabilities && (Number(vulnerabilities.high || 0) > 0 || Number(vulnerabilities.critical || 0) > 0)) {
    return { status: 'failed', reason: 'high-or-critical-production-advisory', vulnerabilities };
  }
  const transport = /(?:ENET|EAI_AGAIN|ECONN|ETIMEDOUT|network|registry|socket|fetch)/i.test(`${stderr}\n${stdout}`);
  return { status: 'inconclusive', reason: transport ? 'audit-transport-failure' : 'audit-result-unavailable', vulnerabilities };
}

function parseArgs(argv) {
  const options = { output: path.resolve('.tmp/release-evidence'), skipAudit: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') options.output = path.resolve(argv[++index]);
    else if (argv[index] === '--skip-audit') options.skipAudit = true;
    else if (argv[index] !== '--') throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function validateOutputRoot(outputRoot) {
  const relative = path.relative(REPO_ROOT, outputRoot).replaceAll('\\', '/');
  if (!relative || relative === '.') throw new Error('Output directory must not be the repository root');
  if (relative === '.jobos' || relative.startsWith('.jobos/') || relative === 'jobos-workspace' || relative.startsWith('jobos-workspace/')) {
    throw new Error('Output directory must not be under tracked runtime paths');
  }
  if (!relative.startsWith('../') && !path.isAbsolute(relative)) {
    const ignored = spawnSync('git', ['check-ignore', '-q', '--', relative], { cwd: REPO_ROOT });
    if (ignored.status !== 0) throw new Error(`Output directory is not ignored: ${relative}`);
  } else {
    throw new Error('Output directory must be an ignored path inside the repository');
  }
}

function run(argv, { cwd = REPO_ROOT, env = process.env } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { argv, cwd, exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message || null };
}

function writeCommandArtifact(file, executions) {
  const value = Array.isArray(executions) ? executions : [executions];
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function applyExecution(entry, execution, status = null) {
  const executions = Array.isArray(execution) ? execution : [execution];
  entry.argv = executions.map(item => item.argv);
  if (executions.length === 1) entry.argv = executions[0].argv;
  entry.cwd = executions.find(item => item.cwd !== REPO_ROOT)?.cwd || executions[0]?.cwd || REPO_ROOT;
  entry.exitCode = executions.find(item => item.exitCode !== 0)?.exitCode ?? executions.at(-1)?.exitCode ?? null;
  entry.status = status || (executions.every(item => item.exitCode === 0) ? 'passed' : 'failed');
  writeCommandArtifact(entry.outputPath, executions);
}

function runMcpCompatibility(outputRoot) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'jobos-w10-mcp-evidence-'));
  try {
    const testRun = run(RELEASE_CHECKS.mcpCompatibility[0]);
    const seedArgv = [NODE, path.join(REPO_ROOT, 'scripts/seed-mcp-demo.js'), '--workspace', workspace];
    const seedRun = run(seedArgv, { cwd: workspace });
    const transcript = path.join(outputRoot, 'mcp-demo-transcript.jsonl');
    const demoArgv = [
      NODE, path.join(REPO_ROOT, 'scripts/mcp-demo.js'), '--workspace', workspace,
      '--profile', 'w10-mcp-profile', '--job', 'w10-mcp-job', '--output', transcript, '--timeout', '30000'
    ];
    const demoRun = seedRun.exitCode === 0
      ? run(demoArgv, { cwd: workspace })
      : { argv: demoArgv, cwd: workspace, exitCode: 1, stdout: '', stderr: 'seed failed', error: null };
    return [testRun, seedRun, demoRun];
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runSmoke() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'jobos-w10-smoke-evidence-'));
  try {
    return run(RELEASE_CHECKS.smoke, { cwd: workspace });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function allFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function assertNoSentinels(outputRoot) {
  for (const file of allFiles(outputRoot)) {
    const content = readFileSync(file, 'utf8');
    for (const [name, value] of Object.entries(SENTINELS)) {
      if (content.includes(value)) throw new Error(`Release evidence leaked ${name} in ${path.relative(outputRoot, file)}`);
    }
  }
}

function humanSummary(evidence) {
  const lines = [
    'JobOS W10 release evidence',
    `Generated: ${evidence.generatedAt}`,
    `Status: ${evidence.status}`,
    `Commit: ${evidence.gitCommit}`,
    `Lockfile SHA-256: ${evidence.packageLockSha256}`,
    `Fixture manifest SHA-256: ${evidence.fixtureManifestSha256}`,
    '',
    ...Object.entries(evidence.checks).map(([name, check]) => `${name}: ${check.status} (exit ${check.exitCode ?? 'not-run'})`)
  ];
  return `${lines.join('\n')}\n`;
}

export function runReleaseEvidence({ outputRoot, skipAudit = false }) {
  validateOutputRoot(outputRoot);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const evidence = buildEvidenceSkeleton({ outputRoot });
  const npmVersion = run(['npm', '--version']);
  const commit = run(['git', 'rev-parse', 'HEAD']);
  evidence.environment.npm = npmVersion.exitCode === 0 ? npmVersion.stdout.trim() : null;
  evidence.gitCommit = commit.exitCode === 0 ? commit.stdout.trim() : null;
  evidence.packageLockSha256 = sha256File(path.join(REPO_ROOT, 'package-lock.json'));
  evidence.fixtureManifestSha256 = sha256File(path.join(REPO_ROOT, 'tests/fixtures/w10/manifest.json'));
  evidence.goldenFixtureCount = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/fixtures/w10/manifest.json'), 'utf8')).fixtures.length;

  applyExecution(evidence.checks.goldens, run(RELEASE_CHECKS.goldens));
  const securityArgv = [...RELEASE_CHECKS.security, '--output', path.join(outputRoot, 'security')];
  applyExecution(evidence.checks.security, run(securityArgv));
  applyExecution(evidence.checks.docsStatus, run(RELEASE_CHECKS.docsStatus));
  applyExecution(evidence.checks.mcpFraming, run(RELEASE_CHECKS.mcpFraming));
  applyExecution(evidence.checks.mcpCompatibility, runMcpCompatibility(outputRoot));
  applyExecution(evidence.checks.mcpDecision, run(RELEASE_CHECKS.mcpDecision));
  applyExecution(evidence.checks.fullSuite, run(RELEASE_CHECKS.fullSuite));
  applyExecution(evidence.checks.smoke, runSmoke());

  if (skipAudit) {
    const classification = classifyAuditResult({ skipped: true, exitCode: null, stdout: '', stderr: '' });
    evidence.checks.dependencyAudit.argv = [...RELEASE_CHECKS.dependencyAudit];
    evidence.checks.dependencyAudit.cwd = REPO_ROOT;
    evidence.checks.dependencyAudit.exitCode = null;
    evidence.checks.dependencyAudit.status = classification.status;
    writeFileSync(evidence.checks.dependencyAudit.outputPath, `${JSON.stringify({ skipped: true, classification }, null, 2)}\n`);
  } else {
    const audit = run(RELEASE_CHECKS.dependencyAudit);
    const classification = classifyAuditResult(audit);
    applyExecution(evidence.checks.dependencyAudit, audit, classification.status);
    const artifact = parseJson(readFileSync(evidence.checks.dependencyAudit.outputPath, 'utf8'));
    writeFileSync(evidence.checks.dependencyAudit.outputPath, `${JSON.stringify({ executions: artifact, classification }, null, 2)}\n`);
  }

  const statuses = Object.values(evidence.checks).map(check => check.status);
  evidence.status = statuses.every(status => status === 'passed') ? 'passed' : statuses.includes('failed') ? 'failed' : 'inconclusive';
  const reportPath = path.join(outputRoot, 'release-evidence.json');
  const summaryPath = path.join(outputRoot, 'summary.txt');
  writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(summaryPath, humanSummary(evidence));
  assertNoSentinels(outputRoot);
  return evidence;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = runReleaseEvidence({ outputRoot: options.output, skipAudit: options.skipAudit });
  process.stdout.write(`${JSON.stringify({ status: evidence.status, output: options.output })}\n`);
  process.exitCode = evidence.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`release-evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
