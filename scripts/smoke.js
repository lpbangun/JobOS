import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
    const req = http.request({ hostname: '127.0.0.1', port: webPort, path: pathname, method: 'GET' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const webPort = 4399 + Math.floor(Math.random() * 1000);
let server;
try {
  const guide = JSON.parse(run(['agent-guide', '--json']));
  if (!guide.commands?.length || !existsSync(path.join(root, '.jobos', 'jobos.sqlite')) || !existsSync(path.join(root, 'jobos-workspace'))) throw new Error('First command did not auto-create the JobOS workspace');
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.\n- Shipped a cross-functional product launch with engineering and design partners, improving activation for a technical user workflow.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  JSON.parse(run(['searches', 'create', 'Acme Discovery', '--profile', profile.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json'), '--keywords', 'Product,Learning', '--location', 'Remote', '--min-fit', '50', '--json']));
  const discovery = JSON.parse(run(['discover', 'run', '--search', 'Acme Discovery', '--json']));
  if (discovery.status !== 'succeeded' || discovery.counts.imported !== 1 || discovery.counts.highFit < 1) throw new Error('Fixture-backed discovery run did not import and flag a high-fit job');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
  if (!(score.overall > 0)) throw new Error('Score did not compute');
  const resumeDraft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown'], true);
  if (!resumeDraft.includes('Evidence-backed highlights')) throw new Error('Resume draft missing evidence section');
  run(['tailor', 'cover-letter', '--job', job.id, '--profile', profile.id, '--output', 'markdown'], true);
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'materials-ready', '--json']));
  JSON.parse(run(['applications', 'update', app.id, '--status', 'applied', '--json']));
  JSON.parse(run(['applications', 'update', app.id, '--status', 'interview', '--json']));
  const interviewPacket = run(['interview', 'prep', '--application', app.id, '--stage', 'hiring-manager', '--output', 'markdown'], true);
  if (!interviewPacket.includes('STAR story') || !interviewPacket.includes('Questions to ask the interviewer')) throw new Error('Interview prep packet missing useful sections');
  const funnel = JSON.parse(run(['analytics', 'funnel', '--profile', profile.id, '--since', '30', '--json']));
  if (funnel.totals.interviews < 1 || !funnel.byRoleFamily.length) throw new Error('Analytics funnel did not report interview conversion by role family');
  JSON.parse(run(['tasks', 'due', '--json']));
  const review = run(['review', 'weekly', '--profile', profile.id, '--output', 'markdown'], true);
  if (!review.includes('Weekly JobOS review') || !review.includes('Funnel analytics')) throw new Error('Weekly review missing funnel insights');
  const now = new Date();
  const schedule = `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`;
  JSON.parse(run(['automation', 'create', 'smoke_brief', '--action', 'morning_priority_brief', '--schedule', schedule, '--profile', profile.id, '--enabled', '--json']));
  const schedulerRun = JSON.parse(run(['scheduler', 'run-once', '--json']));
  if (schedulerRun.due !== 1 || schedulerRun.runs[0]?.status !== 'succeeded') throw new Error('Scheduler did not run due smoke automation');
  const briefPath = schedulerRun.runs[0]?.outputs?.briefs?.[0]?.path;
  if (!briefPath || !readFileSync(path.join(root, 'jobos-workspace', briefPath), 'utf8').includes('Morning priority brief')) throw new Error('Scheduler did not write priority brief export');
  const runDay = schedulerRun.runs[0].createdAt.slice(0, 10);
  if (!readFileSync(path.join(root, 'jobos-workspace', 'automations', `runs-${runDay}.jsonl`), 'utf8').includes('smoke_brief')) throw new Error('Scheduler did not append automation run JSONL');
  server = spawn(process.execPath, ['src/cli.js', 'web', '--port', String(webPort)], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('web server did not start')), 5000);
    server.stdout.on('data', data => { if (String(data).includes('JobOS dashboard running')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', data => reject(new Error(String(data))));
  });
  const response = await fetch(`http://127.0.0.1:${webPort}/api/state`);
  const state = await response.json();
  if (!state.jobs.length || !state.profiles.length) throw new Error('Dashboard API did not expose state');
  if (!state.audit.length || !state.automationRuns.length) throw new Error('Dashboard API missing audit or automation state');
  if (!state.automations.some(a => a.name === 'smoke_brief')) throw new Error('Dashboard API missing configured automation');
  if (!state.artifacts.every(a => a.approval_status === 'draft_needs_human_review')) throw new Error('Draft artifacts must remain human-review gated');
  const dashboard = await requestRaw('/');
  if (dashboard.status !== 200 || !dashboard.body.includes('Profile & Proof') || !dashboard.body.includes('Kanban-style application status board') || !dashboard.body.includes('Artifact review UI') || !dashboard.body.includes('Discovery')) throw new Error('Dashboard shell did not render expected interactive navigation');
  const traversal = await requestRaw('/workspace/../README.md');
  const unknown = await requestRaw('/README.md');
  if (![400, 404].includes(traversal.status) || unknown.status !== 404) throw new Error(`Dashboard route hardening failed: traversal=${traversal.status}, unknown=${unknown.status}`);
  server.kill('SIGTERM');
  console.log(JSON.stringify({ ok: true, root, profile: profile.id, job: job.id, score: score.overall, application: app.id, discoveryRun: discovery.runId, schedulerRun: schedulerRun.runs[0].id, priorityBrief: briefPath, interviewPrep: true, interviews: funnel.totals.interviews, dashboardApiJobs: state.jobs.length, dashboardShell: true, interactiveDashboard: true, routeHardening: true }, null, 2));
} finally {
  if (server && !server.killed) server.kill('SIGTERM');
  if (!process.env.KEEP_JOBOS_SMOKE) rmSync(root, { recursive: true, force: true });
}
