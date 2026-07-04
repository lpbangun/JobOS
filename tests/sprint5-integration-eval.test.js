import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, run as dbRun, save as dbSave } from '../src/db.js';

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-sprint5-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  return { root, run };
}

test('status history preserves stages reached for analytics after terminal outcomes', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.\n- Shipped activation experiments for adult learning products with design and engineering partners.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'materials-ready', '--json']));
  const store = await openStore({ workspace: root });
  dbRun(store, 'UPDATE applications SET created_at=? WHERE id=?', [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), app.id]);
  dbSave(store);
  run(['applications', 'update', app.id, '--status', 'applied', '--json']);
  run(['applications', 'update', app.id, '--status', 'interview', '--json']);
  run(['applications', 'update', app.id, '--status', 'rejected', '--json']);
  const staleJobFile = path.join(root, 'stale-job.md');
  writeFileSync(staleJobFile, 'Title: Curriculum Operations Manager\nCompany: SlowCo Learning\nLocation: Remote\n\nBuild curriculum operations workflows for adult learners.');
  const staleJob = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', staleJobFile, '--json']));
  const staleApp = JSON.parse(run(['applications', 'create', '--job', staleJob.id, '--status', 'interview', '--json']));
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const staleStore = await openStore({ workspace: root });
  dbRun(staleStore, 'UPDATE applications SET created_at=?, updated_at=? WHERE id=?', [old, old, staleApp.id]);
  dbRun(staleStore, 'UPDATE status_changes SET created_at=? WHERE application_id=?', [old, staleApp.id]);
  dbSave(staleStore);
  const funnel = JSON.parse(run(['analytics', 'funnel', '--profile', profile.id, '--since', '1', '--json']));
  assert.equal(funnel.byStage.find(s => s.stage === 'rejected')?.count, 1);
  assert.equal(funnel.totals.interviews, 1, 'interview reached should remain counted after rejection');
  assert.ok(funnel.bySource.some(s => s.interviews === 1), 'source breakdown should include in-window status changes for older applications');
  assert.ok(funnel.byRoleFamily.some(s => s.interviews === 1), 'role-family breakdown should include in-window status changes for older applications');
  assert.equal(funnel.totals.staleActive, 1, 'stale active applications should be counted even when older than the analytics window');
  assert.ok(funnel.stageReached.some(s => s.stage === 'interview' && s.count === 1));
  const state = JSON.parse(run(['tasks', 'due', '--json']));
  assert.ok(Array.isArray(state));
});

test('deterministic eval scoring cases stay within declared ranges', () => {
  const { run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', path.join(process.cwd(), 'tests/eval/profile-proof-points.md'), '--json']));
  const cases = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/eval/scoring-cases.json'), 'utf8'));
  const results = [];
  for (const c of cases) {
    const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'tests/eval', c.file), '--json']));
    const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
    results.push(`${c.id}: ${score.overall} expected ${c.expectedRange.join('-')}`);
    assert.ok(score.overall >= c.expectedRange[0] && score.overall <= c.expectedRange[1], results.join('\n'));
  }
});
