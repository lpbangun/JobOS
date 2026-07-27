#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSentinelLeakFixture, SENTINELS } from '../tests/fixtures/w10/sentinel-leak-fixture.js';

const SQLITE_ALLOWLIST = Object.freeze([
  'tests/fixtures/w06-schema12.sqlite',
  'tests/fixtures/w07-schema13.sqlite',
  'tests/fixtures/w08-schema14.sqlite'
]);

export const RELEASE_SECURITY_POLICY = Object.freeze({
  sqliteAllowlist: SQLITE_ALLOWLIST,
  requiredIgnorePatterns: Object.freeze([
    '.jobos/',
    'jobos-workspace/',
    '.env',
    '.env.*',
    '.tmp/',
    'release-evidence/',
    '*.sqlite-*'
  ]),
  staticOutputFields: Object.freeze([
    'privateNote',
    'private_note',
    'answer_text',
    'target_ciphertext',
    'target_iv',
    'cookie',
    'browserState',
    'locator',
    'confirmationSecret'
  ]),
  staticOutputAllowedSites: Object.freeze([])
});

function gitFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed');
  return result.stdout.split('\0').filter(Boolean).map(file => file.replaceAll('\\', '/'));
}

function forbiddenTrackedReason(file) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  if (lower === '.jobos' || lower.startsWith('.jobos/') || lower.includes('/.jobos/')) return 'runtime-sqlite-state';
  if (lower === 'jobos-workspace' || lower.startsWith('jobos-workspace/') || lower.includes('/jobos-workspace/')) return 'runtime-workspace-mirror';
  if (base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example'))) return 'environment-file';
  if (/\.sqlite(?:-.+)?$/i.test(file) && !SQLITE_ALLOWLIST.includes(file)) return 'sqlite-or-sidecar';
  if (/(?:^|\/)(?:cookies?|browser-state|storage-state|session-storage|local-storage)(?:[._-]|\/)/i.test(file)) return 'browser-state-export';
  if (/(?:^|\/)release-evidence(?:\/|$)/i.test(file)) return 'release-output';
  return null;
}

export function checkTrackedData(files = gitFiles()) {
  const violations = files.map(file => ({ file, reason: forbiddenTrackedReason(file) })).filter(item => item.reason);
  return { status: violations.length ? 'failed' : 'passed', scanned: files.length, violations };
}

export function checkRuntimeIgnore(file = '.gitignore') {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const missing = RELEASE_SECURITY_POLICY.requiredIgnorePatterns.filter(pattern => !lines.includes(pattern));
  return { status: missing.length ? 'failed' : 'passed', required: [...RELEASE_SECURITY_POLICY.requiredIgnorePatterns], missing };
}

function eligibleStaticFile(file) {
  return /^(?:src|scripts|\.github\/workflows)\//.test(file) && /\.(?:c?js|mjs|json|ya?ml)$/.test(file);
}

export function checkStaticRawOutputPolicy(files = gitFiles()) {
  const fieldPattern = RELEASE_SECURITY_POLICY.staticOutputFields.join('|');
  const directOutput = new RegExp(`(?:console\\.log|process\\.stdout\\.write).*?(?:${fieldPattern})`, 'i');
  const violations = [];
  for (const file of files.filter(eligibleStaticFile)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!directOutput.test(line)) continue;
      const site = `${file}:${index + 1}`;
      if (!RELEASE_SECURITY_POLICY.staticOutputAllowedSites.includes(site)) violations.push({ file, line: index + 1 });
    }
  }
  return {
    status: violations.length ? 'failed' : 'passed',
    scannedFiles: files.filter(eligibleStaticFile).length,
    scannedFields: [...RELEASE_SECURITY_POLICY.staticOutputFields],
    allowedSites: [...RELEASE_SECURITY_POLICY.staticOutputAllowedSites],
    violations
  };
}

function listFilesRecursive(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function checkSentinelContainment() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w10-security-'));
  try {
    const fixture = await createSentinelLeakFixture({ root });
    const raw = fixture.rawInputs.map(file => readFileSync(file, 'utf8')).join('\n');
    const artifacts = fixture.artifacts.map(file => readFileSync(file, 'utf8')).join('\n');
    const source = readFileSync('tests/fixtures/w10/sentinel-leak-fixture.js', 'utf8');
    const checkedInFixtureFiles = listFilesRecursive(path.resolve('tests/fixtures/w10'));
    const checkedInFixtureText = checkedInFixtureFiles.map(file => readFileSync(file, 'utf8')).join('\n');
    const violations = [];
    for (const [name, value] of Object.entries(SENTINELS)) {
      if (!raw.includes(value)) violations.push({ sentinel: name, destination: 'controlled-raw-input', reason: 'missing-injection' });
      if (artifacts.includes(value)) violations.push({ sentinel: name, destination: 'public-artifact', reason: 'leak' });
      if (source.includes(value)) violations.push({ sentinel: name, destination: 'checked-in-source', reason: 'literal-value' });
      if (checkedInFixtureText.includes(value)) violations.push({ sentinel: name, destination: 'checked-in-fixture', reason: 'literal-value', file: checkedInFixtureFiles.find(file => readFileSync(file, 'utf8').includes(value)) });
    }
    return {
      status: violations.length ? 'failed' : 'passed',
      sentinelCount: Object.keys(SENTINELS).length,
      rawInputCount: fixture.rawInputs.length,
      artifactCount: fixture.artifacts.length,
      checkedInFixtureCount: checkedInFixtureFiles.length,
      violations
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { format: 'text', output: path.resolve('.tmp/w10-security-check') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--format') options.format = argv[++index];
    else if (argv[index] === '--output') options.output = path.resolve(argv[++index]);
    else if (argv[index] !== '--') throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['json', 'text'].includes(options.format)) throw new Error('--format must be json or text');
  return options;
}

export async function runReleaseSecurityChecks() {
  const checks = {
    trackedData: checkTrackedData(),
    runtimeIgnore: checkRuntimeIgnore(),
    sentinelContainment: await checkSentinelContainment(),
    staticRawOutput: checkStaticRawOutputPolicy()
  };
  const status = Object.values(checks).every(check => check.status === 'passed') ? 'passed' : 'failed';
  return {
    schema: 'jobos.w10-release-security.v1',
    status,
    policy: {
      sqliteAllowlist: [...SQLITE_ALLOWLIST],
      staticOutputAllowedSites: [...RELEASE_SECURITY_POLICY.staticOutputAllowedSites]
    },
    checks
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runReleaseSecurityChecks();
  mkdirSync(options.output, { recursive: true });
  writeFileSync(path.join(options.output, 'security-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (options.format === 'json') process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(`W10 release security: ${report.status}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`w10-release-security: ${error.message}\n`);
    process.exitCode = 1;
  });
}
