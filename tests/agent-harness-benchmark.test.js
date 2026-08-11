import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TARGET_HARNESS_IDS,
  checkCatalogCompleteness,
  checkConnectCliContract,
  checkDryRunRegistration,
  checkIdempotentConnect,
  checkMcpToolSurfaceParity,
  checkHermesAcpPrimary,
  checkPiOmpAcpAlternate,
  checkLiveInstalledClients,
  checkDocsMentionConnect,
  checkCareerOpsClaudeCodexParity,
  createHarnessFixture,
  runHarnessBenchmark
} from './agent-harness-benchmark.lib.js';
import { SUPPORTED_AGENT_CLIENTS } from '../src/agent-setup.js';

function benchContext(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'jobos-harness-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    cliPath: path.resolve('src/cli.js'),
    env: process.env
  };
}

test('HARNESS-01 catalog completeness: doctor knows all six target harness ids', async t => {
  const ctx = benchContext(t);
  const result = await checkCatalogCompleteness(ctx);
  assert.equal(result.id, 'catalog-completeness');
  assert.deepEqual(
    TARGET_HARNESS_IDS.filter(id => !result.details.supported.includes(id)),
    [],
    `CLIENTS missing: ${result.details.missing.join(', ')}`
  );
  assert.deepEqual(result.details.doctorMissing, [], `doctor missing: ${result.details.doctorMissing.join(', ')}`);
  assert.ok(result.pass, result.message);
});

test('HARNESS-02 connect CLI contract accepts all six harness names', async () => {
  const result = await checkConnectCliContract();
  assert.equal(result.id, 'connect-cli-contract');
  assert.deepEqual(result.details.missing, [], `usage missing: ${result.details.missing.join(', ')}`);
  assert.deepEqual(result.details.unsupported, [], `unsupported: ${result.details.unsupported.join(', ')}`);
  assert.ok(result.pass, result.message);
});

test('HARNESS-03 dry-run registration previews JobOS MCP entrypoint for each client', async t => {
  const supported = [...SUPPORTED_AGENT_CLIENTS];
  for (const clientId of TARGET_HARNESS_IDS) {
    if (!supported.includes(clientId)) {
      assert.fail(`${clientId} not registered in CLIENTS; dry-run benchmark cannot pass`);
    }
    const fixture = createHarnessFixture(clientId);
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const result = await checkDryRunRegistration(clientId, fixture);
    assert.equal(result.details.status, 'preview', `${clientId}: ${result.message}`);
    assert.equal(result.details.displayOk, true, `${clientId} registration must include mcp + cli/workspace paths`);
    assert.ok(result.pass, result.message);
  }
});

test('HARNESS-04 idempotent connect fixtures: not-connected → ready → alreadyConnected', async t => {
  const supported = [...SUPPORTED_AGENT_CLIENTS];
  for (const clientId of TARGET_HARNESS_IDS) {
    if (!supported.includes(clientId)) {
      assert.fail(`${clientId} not registered in CLIENTS; idempotent connect benchmark cannot pass`);
    }
    const fixture = createHarnessFixture(clientId);
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const result = await checkIdempotentConnect(clientId, fixture);
    assert.ok(result.pass, result.message);
  }
});

test('HARNESS-05 MCP tool surface parity and agent-eligible domain tools', async t => {
  const ctx = benchContext(t);
  const result = await checkMcpToolSurfaceParity(ctx);
  assert.ok(result.details.toolCount > 0);
  assert.equal(result.details.toolCount, result.details.doctorCount);
  assert.deepEqual(result.details.missingEligible, []);
  assert.ok(result.pass, result.message);
});

test('HARNESS-06 Hermes ACP primary backend remains cataloged', async t => {
  const ctx = benchContext(t);
  const result = await checkHermesAcpPrimary(ctx);
  assert.equal(result.details.hermes?.protocol, 'acp-v1');
  assert.equal(result.details.hermes?.role, 'primary');
  assert.ok(result.pass, result.message);
});

test('HARNESS-07 Pi/OMP ACP alternate backend cataloged (omp-acp or pi-acp)', async t => {
  const ctx = benchContext(t);
  const result = await checkPiOmpAcpAlternate(ctx);
  assert.ok(result.pass, result.message);
});

test('HARNESS-08 live installed-client smoke (soft skip when binary missing)', async t => {
  const ctx = benchContext(t);
  const result = await checkLiveInstalledClients(ctx);
  for (const [clientId, live] of Object.entries(result.details.live)) {
    if (!live.installed) continue;
    assert.equal(live.dryRunOk, true, `${clientId} is installed but dry-run failed: ${live.notes}`);
  }
  assert.ok(result.pass, result.message);
});

test('HARNESS-09 docs/AGENT_GUIDE.md mentions connect for expanded harness set', () => {
  const result = checkDocsMentionConnect();
  assert.equal(result.details.legacyOnly, false);
  assert.deepEqual(result.details.missing, []);
  assert.ok(result.pass, result.message);
});

test('HARNESS-10 career-ops Claude/Codex skill + wrapper parity', () => {
  const result = checkCareerOpsClaudeCodexParity();
  assert.deepEqual(result.details.missing, []);
  assert.equal(result.details.skillHasRouter, true);
  assert.equal(result.details.wrappersImportSkill, true);
  assert.equal(result.details.wrappersMentionConnect, true);
  assert.equal(result.details.symlinkOk, true);
  assert.ok(result.pass, result.message);
});

test('HARNESS-SUMMARY convergence gate matches explicit criteria', async () => {
  const report = await runHarnessBenchmark();
  assert.equal(report.schema, 'jobos.agent-harness-benchmark.v1');
  assert.equal(typeof report.converged, 'boolean');
  assert.equal(report.passed + report.failed, report.checks.length);
  if (!report.converged) {
    assert.ok(report.failures.length > 0);
    assert.match(report.iterationHint, /.+/);
  }
});
