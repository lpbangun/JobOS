import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createSentinelLeakFixture, SENTINELS } from './fixtures/w10/sentinel-leak-fixture.js';

const REQUIRED_EVIDENCE_CHECKS = [
  'goldens', 'security', 'docsStatus', 'mcpFraming', 'mcpCompatibility', 'mcpDecision', 'fullSuite', 'smoke', 'dependencyAudit'
];
const NO_DEPLOY_TOKENS = /(?:deploy|publish|release\s|git\s+(?:tag|push)|npm\s+publish)/i;

function outputRoot(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readArtifacts(files) {
  return files.map(file => readFileSync(file, 'utf8')).join('\n');
}

test('W10-SECURITY-01 exact sentinels stay only in controlled raw inputs', async t => {
  const root = outputRoot(t, 'jobos-w10-sentinel-');
  const fixture = await createSentinelLeakFixture({ root });
  const raw = readArtifacts(fixture.rawInputs);
  const publicArtifacts = readArtifacts(fixture.artifacts);
  const checkedInSource = readFileSync('tests/fixtures/w10/sentinel-leak-fixture.js', 'utf8');
  for (const value of Object.values(SENTINELS)) {
    assert.match(raw, new RegExp(value));
    assert.equal(publicArtifacts.includes(value), false, value);
    assert.equal(checkedInSource.includes(value), false, `${value} must be constructed only at runtime`);
  }
  assert.deepEqual(fixture.summary.mcpMethods, ['initialize', 'tools/list', 'score_job', 'get_job_context']);
  assert.equal(fixture.summary.configuredMediation, true);
  assert.equal(fixture.summary.careerMemoryError, 'memory_unknown_key');
});

test('W10-SECURITY-02 tracked-data and runtime-ignore guard uses only the frozen SQLite allowlist', t => {
  const output = path.join('.tmp', `w10-security-test-${process.pid}`);
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/check-release-security.js', '--format', 'json', '--output', output], {
    cwd: process.cwd(), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'jobos.w10-release-security.v1');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.policy.sqliteAllowlist, [
    'tests/fixtures/w06-schema12.sqlite',
    'tests/fixtures/w07-schema13.sqlite',
    'tests/fixtures/w08-schema14.sqlite'
  ]);
  assert.equal(report.checks.trackedData.status, 'passed');
  assert.equal(report.checks.runtimeIgnore.status, 'passed');
  assert.equal(report.checks.sentinelContainment.status, 'passed');
});

test('W10-SECURITY-03 static raw-output policy is narrow and documents every allowed site', async () => {
  const security = await import('../scripts/check-release-security.js');
  const result = security.checkStaticRawOutputPolicy();
  assert.deepEqual(security.RELEASE_SECURITY_POLICY.staticOutputAllowedSites, []);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.violations, []);
  assert.match(result.scannedFields.join(' '), /privateNote|answer_text|target_ciphertext|cookie|locator/);
});

test('W10-SECURITY-04 release evidence schema records every focused no-deploy gate', async () => {
  const release = await import('../scripts/release-evidence.js');
  const skeleton = release.buildEvidenceSkeleton({ outputRoot: '.tmp/release-evidence', generatedAt: '2026-07-25T12:00:00.000Z' });
  assert.equal(skeleton.schema, 'jobos.release-evidence.v1');
  assert.deepEqual(Object.keys(skeleton.checks).sort(), [...REQUIRED_EVIDENCE_CHECKS].sort());
  for (const name of REQUIRED_EVIDENCE_CHECKS) {
    const check = skeleton.checks[name];
    assert.deepEqual(Object.keys(check).sort(), ['argv', 'cwd', 'exitCode', 'outputPath', 'status']);
    assert.equal(NO_DEPLOY_TOKENS.test(JSON.stringify(check.argv)), false, name);
  }
  assert.deepEqual(release.RELEASE_CHECKS.docsStatus, [process.execPath, '--test', '--test-concurrency=1', 'tests/w10-docs-status.test.js']);
  assert.deepEqual(release.RELEASE_CHECKS.mcpFraming, [process.execPath, '--test', '--test-concurrency=1', 'tests/mcp-framing.test.js']);
  assert.match(JSON.stringify(release.RELEASE_CHECKS.mcpCompatibility), /W10-MCP-COMPAT/);
  assert.match(JSON.stringify(release.RELEASE_CHECKS.mcpDecision), /W10-MCP-DECISION/);
});

test('W10-SECURITY-05 audit classification never turns network or high advisories into pass', async () => {
  const { classifyAuditResult } = await import('../scripts/release-evidence.js');
  assert.equal(classifyAuditResult({ exitCode: 0, stdout: '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}', stderr: '' }).status, 'passed');
  assert.equal(classifyAuditResult({ exitCode: 1, stdout: '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}', stderr: '' }).status, 'failed');
  assert.equal(classifyAuditResult({ exitCode: 1, stdout: '', stderr: 'ENETUNREACH registry.npmjs.org' }).status, 'inconclusive');
  assert.equal(classifyAuditResult({ skipped: true, exitCode: null, stdout: '', stderr: '' }).status, 'inconclusive');
});

test('W10-SECURITY-06 package scripts expose only focused W10 and evidence commands', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['check:release-security'], 'node scripts/check-release-security.js --format json');
  assert.equal(pkg.scripts['test:w10'], 'node --test --test-concurrency=1 tests/w10-golden.test.js tests/w10-security-release.test.js tests/w10-docs-status.test.js tests/w10-mcp-compatibility.test.js');
  assert.equal(pkg.scripts['release:evidence'], 'node scripts/release-evidence.js');
});
