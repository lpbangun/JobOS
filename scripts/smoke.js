import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(tmpdir(), 'jobos-smoke-'));
const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
function run(args, raw = false) {
  const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return raw ? result.stdout : result.stdout.trim();
}

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
  console.log(JSON.stringify({ ok: true, root, profile: profile.id, job: job.id, score: score.overall, application: app.id, discoveryRun: discovery.runId, schedulerRun: schedulerRun.runs[0].id, priorityBrief: briefPath, interviewPrep: true, interviews: funnel.totals.interviews }, null, 2));
} finally {
  if (!process.env.KEEP_JOBOS_SMOKE) rmSync(root, { recursive: true, force: true });
}
