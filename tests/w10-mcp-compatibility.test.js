import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const protocol = '2024-11-05';

function run(args, options = {}) {
  return spawnSync(node, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: 45_000
  });
}

test('W10-MCP-COMPAT real stdio client records complete redacted compatibility evidence', t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'jobos-w10-mcp-test-'));
  const workspace = path.join(parent, 'workspace');
  const transcript = path.join(workspace, 'mcp-demo-transcript.jsonl');
  const sentinel = 'W10_MCP_REAL_CLIENT_SECRET_SENTINEL';
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const seed = run([path.join(repoRoot, 'scripts/seed-mcp-demo.js'), '--workspace', workspace], { cwd: parent });
  assert.equal(seed.status, 0, seed.stderr);
  assert.deepEqual(JSON.parse(seed.stdout), { workspace, profileId: 'w10-mcp-profile', jobId: 'w10-mcp-job' });
  assert.equal(existsSync(path.join(parent, '.jobos')), false, 'seed wrote a default workspace outside the requested temporary directory');

  const demo = run([
    path.join(repoRoot, 'scripts/mcp-demo.js'),
    '--workspace', workspace,
    '--profile', 'w10-mcp-profile',
    '--job', 'w10-mcp-job',
    '--output', transcript,
    '--timeout', '30000'
  ], { cwd: parent, env: { W10_MCP_SECRET: sentinel } });
  assert.equal(demo.status, 0, demo.stderr);
  const summary = JSON.parse(demo.stdout);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.protocol, { requested: protocol, offered: protocol, negotiated: protocol });
  assert.equal(summary.frameType, 'jsonl');
  assert.equal(summary.results.initialize, 'passed');
  assert.equal(summary.results.list, 'passed');
  assert.equal(summary.results.calls, 'passed');
  assert.equal(summary.catalog.count, summary.catalog.names.length);
  assert.ok(summary.catalog.names.includes('score_job'));
  assert.ok(summary.catalog.names.includes('get_job_context'));
  assert.deepEqual(summary.calledTools, ['score_job', 'get_job_context']);
  assert.equal(summary.calledToolResults.score_job.contract, 'jobos.fit-score.v1');
  assert.equal(summary.calledToolResults.get_job_context.fitContract, 'jobos.fit-score.v1');
  assert.ok(summary.typedErrors.some(error => error.code === -32601 && error.type === 'method_not_found'));
  assert.deepEqual(summary.sentinelScan, { checked: true, leakCount: 0 });
  assert.equal(summary.transcript, transcript);

  const transcriptText = readFileSync(transcript, 'utf8');
  assert.equal(transcriptText.includes(sentinel), false);
  assert.match(transcriptText, /\[REDACTED\]/);
  for (const line of transcriptText.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

test('bare MCP demo self-seeds a temporary workspace and exits cleanly', t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'jobos-w10-mcp-bare-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const demo = run([path.join(repoRoot, 'scripts/mcp-demo.js')], {
    cwd: parent,
    env: { JOBOS_HOME: '', W10_MCP_SECRET: '' }
  });
  assert.equal(demo.status, 0, demo.stderr);
  const summary = JSON.parse(demo.stdout);
  assert.equal(summary.ok, true);
  assert.equal(Number.isFinite(summary.calledToolResults.score_job.overall), true);
  assert.equal(existsSync(summary.workspace), false, 'temporary demo workspace is removed after the run');
  assert.equal(existsSync(summary.transcript), true, 'the redacted transcript remains available');
  assert.deepEqual(summary.sentinelScan, { checked: true, leakCount: 0 });
});

test('W10-MCP-DECISION retains handwritten MCP unless all migration thresholds are met', () => {
  const decision = readFileSync('docs/mcp-compatibility-decision.md', 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  const lock = readFileSync('package-lock.json', 'utf8');
  assert.match(decision, /^Decision: retain handwritten MCP$/m);
  assert.match(decision, /Tested protocol: `2024-11-05`/);
  assert.match(decision, /Catalog evidence: \d+ policy-eligible tools/);
  assert.match(decision, /`score_job`.*`get_job_context`/s);
  assert.match(decision, /two independently reproducible real-client compatibility failures/i);
  assert.match(decision, /protocol negotiation, schema, or transport maintenance/);
  assert.match(decision, /preserv(?:e|ing) all MCP denial and framing safety tests/i);
  assert.match(decision, /dependency, license, and security review/i);
  assert.match(decision, /Owner:/);
  assert.match(decision, /Next re-evaluation trigger:/);
  assert.doesNotMatch(`${pkg}\n${lock}`, /@modelcontextprotocol\/sdk/);
});
