import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-test-'));
  const env = { ...process.env, JOBOS_HOME: root };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  return { root, run };
}

test('CLI initializes, imports, scores, tailors, and tracks an application', () => {
  const { root, run } = makeRunner();
  const init = JSON.parse(run(['init', '--json']));
  assert.equal(init.policy.externalActions, 'human_approval_required');
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.\n- Shipped a cross-functional product launch with engineering and design partners, improving activation for a technical user workflow.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  assert.equal(profile.id, 'pm-edtech');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  assert.match(job.id, /^job_/);
  const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
  assert.ok(score.overall >= 50);
  const resumeDraft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown']);
  assert.match(resumeDraft, /Evidence-backed highlights/);
  assert.doesNotMatch(resumeDraft, /sent email/i);
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'materials-ready', '--json']));
  assert.equal(app.status, 'materials-ready');
  const tasks = JSON.parse(run(['tasks', 'due', '--json']));
  assert.ok(tasks.some(t => t.title.includes('Review next action')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'job.yaml')));
  assert.ok(readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.md'), 'utf8').includes('human review required'));
});

test('Tailoring warns instead of fabricating when proof points are missing', () => {
  const { run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Generic Search', '--json']));
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const draft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown']);
  assert.match(draft, /No proof points exist/);
  assert.match(draft, /avoids unsupported achievement claims/);
});

test('REST API scaffold exposes local CRUD-style task creation', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  const port = 4500 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['src/cli.js', 'web', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, JOBOS_HOME: root }, encoding: 'utf8' });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('web server did not start')), 5000);
    server.stdout.on('data', data => { if (String(data).includes('JobOS dashboard running')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', data => reject(new Error(String(data))));
  });
  try {
    const job = JSON.parse(run(['jobs', 'import-text', '--profile', 'pm-edtech', '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
    const profiles = await fetch(`http://127.0.0.1:${port}/api/profiles`).then(r => r.json());
    assert.equal(profiles.length, 1);
    const proof = await fetch(`http://127.0.0.1:${port}/api/proofs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'pm-edtech', summary: 'Led an evidence-backed product discovery effort.', skills: ['product', 'discovery'] }) }).then(r => r.json());
    assert.match(proof.id, /^proof_/);
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Review API scaffold', priority: 'high' }) }).then(r => r.json());
    assert.match(created.id, /^task_/);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ title: 'Cross-site write' }) });
    assert.equal(blocked.status, 403);
    const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`).then(r => r.json());
    assert.ok(tasks.some(t => t.title === 'Review API scaffold'));
    const jobs = JSON.parse(run(['jobs', 'list', '--json']));
    assert.ok(jobs.some(j => j.id === job.id));
    const apiState = await fetch(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
    assert.ok(apiState.jobs.some(j => j.id === job.id && Array.isArray(j.requirements)));
    assert.deepEqual(apiState.artifacts, []);
  } finally {
    server.kill('SIGTERM');
  }
});
