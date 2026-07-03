import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';

const root = mkdtempSync(path.join(tmpdir(), 'jobos-smoke-'));
const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
function run(args, raw = false) {
  const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return raw ? result.stdout : result.stdout.trim();
}

function requestRaw(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 4399, path: pathname, method: 'GET' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
try {
  run(['init', '--json']);
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.\n- Shipped a cross-functional product launch with engineering and design partners, improving activation for a technical user workflow.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
  if (!(score.overall > 0)) throw new Error('Score did not compute');
  const resumeDraft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown'], true);
  if (!resumeDraft.includes('Evidence-backed highlights')) throw new Error('Resume draft missing evidence section');
  run(['tailor', 'cover-letter', '--job', job.id, '--profile', profile.id, '--output', 'markdown'], true);
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'materials-ready', '--json']));
  JSON.parse(run(['applications', 'update', app.id, '--status', 'applied', '--json']));
  JSON.parse(run(['tasks', 'due', '--json']));
  const review = run(['review', 'weekly', '--profile', profile.id, '--output', 'markdown'], true);
  if (!review.includes('Weekly JobOS review')) throw new Error('Weekly review missing heading');
  const server = spawn(process.execPath, ['src/cli.js', 'web', '--port', '4399'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('web server did not start')), 5000);
    server.stdout.on('data', data => { if (String(data).includes('JobOS dashboard running')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', data => reject(new Error(String(data))));
  });
  const response = await fetch('http://127.0.0.1:4399/api/state');
  const state = await response.json();
  if (!state.jobs.length || !state.profiles.length) throw new Error('Dashboard API did not expose state');
  if (!state.audit.length || !state.automationRuns.length) throw new Error('Dashboard API missing audit or automation state');
  const dashboard = await requestRaw('/');
  if (dashboard.status !== 200 || !dashboard.body.includes('Profile & Proof') || !dashboard.body.includes('Command palette')) throw new Error('Dashboard shell did not render expected navigation');
  const traversal = await requestRaw('/workspace/../README.md');
  const unknown = await requestRaw('/README.md');
  if (![400, 404].includes(traversal.status) || unknown.status !== 404) throw new Error(`Dashboard route hardening failed: traversal=${traversal.status}, unknown=${unknown.status}`);
  server.kill('SIGTERM');
  console.log(JSON.stringify({ ok: true, root, profile: profile.id, job: job.id, score: score.overall, application: app.id, dashboardApiJobs: state.jobs.length, dashboardShell: true, routeHardening: true }, null, 2));
} finally {
  if (!process.env.KEEP_JOBOS_SMOKE) rmSync(root, { recursive: true, force: true });
}
