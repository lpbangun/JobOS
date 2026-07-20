import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import { all, one, openStore } from '../src/db.js';

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
  JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led evidence-backed EdTech product discovery and launch execution', '--evidence', 'Resume source: reduced manual review time by 30%', '--skills', 'product discovery,stakeholder management,launch execution', '--json']));
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
  const unansweredPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  for (const item of unansweredPlan.answers.questions.filter(question => question.category !== 'work_authorization')) {
    const answer = item.category === 'motivation'
      ? 'The learning mission matches my evidence-backed EdTech product experience.'
      : 'My stored proof covers educator discovery, stakeholder management, launch execution, and a measured 30% workflow improvement.';
    JSON.parse(run(['answers', 'add', '--profile', profile.id, '--category', item.category, '--question', item.question, '--answer', answer, '--sensitivity', 'public', '--status', 'verified', '--json']));
  }
  for (const item of unansweredPlan.answers.questions.filter(question => question.category === 'work_authorization')) {
    const answer = item.question.includes('now or later require') ? 'no' : 'yes';
    JSON.parse(run(['answers', 'add', '--profile', profile.id, '--category', item.category, '--question', item.question, '--answer', answer, '--sensitivity', 'restricted', '--reuse', 'never_auto_fill', '--source', `job:${job.id}`, '--status', 'verified', '--json']));
  }
  const reviewPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (reviewPlan.status !== 'ready-for-review' || reviewPlan.localApprovalComplete !== false) throw new Error(`Application did not reach ready-for-review: ${reviewPlan.status}`);
  const reviewQueue = JSON.parse(run(['artifacts', 'queue', '--profile', profile.id, '--job', job.id, '--json']));
  if (reviewQueue.length !== 2 || reviewQueue.map(item => item.type).sort().join(',') !== 'cover_letter,resume') throw new Error('Review queue did not contain the exact current resume and cover letter revisions');
  const reviewDiffs = reviewQueue.map(item => JSON.parse(run(['artifacts', 'diff', item.id, '--json'])));
  if (reviewDiffs.some(diff => diff.artifactId == null || diff.revision !== 1 || !diff.text.includes('+++'))) throw new Error('Artifact diff did not identify each exact current revision');

  const beforeReviewStore = await openStore({ workspace: root });
  const applicationBeforeReview = one(beforeReviewStore, 'SELECT status,notes,confirmation_url,updated_at FROM applications WHERE id=?', [app.id]);
  const statusChangesBeforeReview = Number(one(beforeReviewStore, 'SELECT COUNT(*) AS count FROM status_changes WHERE application_id=?', [app.id]).count);
  const auditsBeforeReview = Number(one(beforeReviewStore, 'SELECT COUNT(*) AS count FROM audit_log').count);
  beforeReviewStore.db.close();

  for (const item of reviewQueue) {
    const approval = JSON.parse(run(['artifacts', 'approve', item.id, '--note', 'Smoke-reviewed exact current revision.', '--json']));
    if (approval.approvalStatus !== 'approved' || approval.externalSideEffects !== 'none' || approval.submissionPerformed !== false || approval.applicationStatusChanged !== false) throw new Error(`Unsafe approval metadata for ${item.id}`);
  }
  const approvedPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (approvedPlan.status !== 'approved' || approvedPlan.localApprovalComplete !== true) throw new Error(`Application did not reach approved local readiness: ${approvedPlan.status}`);
  const afterReviewStore = await openStore({ workspace: root });
  const applicationAfterReview = one(afterReviewStore, 'SELECT status,notes,confirmation_url,updated_at FROM applications WHERE id=?', [app.id]);
  const statusChangesAfterReview = Number(one(afterReviewStore, 'SELECT COUNT(*) AS count FROM status_changes WHERE application_id=?', [app.id]).count);
  const auditsAfterReview = Number(one(afterReviewStore, 'SELECT COUNT(*) AS count FROM audit_log').count);
  const approvalAudits = all(afterReviewStore, `SELECT entity_id,external_side_effect FROM audit_log
    WHERE action='artifact.approved' AND entity_id IN (?,?) ORDER BY entity_id`, reviewQueue.map(item => item.id));
  afterReviewStore.db.close();
  if (JSON.stringify(applicationAfterReview) !== JSON.stringify(applicationBeforeReview) || statusChangesAfterReview !== statusChangesBeforeReview) throw new Error('Local artifact approval changed application tracking state');
  if (auditsAfterReview !== auditsBeforeReview + 2 || approvalAudits.length !== 2 || approvalAudits.some(event => event.external_side_effect !== 'none')) throw new Error('Approval audit events were missing or claimed an external side effect');

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
  const reviewedArtifacts = state.artifacts.filter(artifact => reviewQueue.some(item => item.id === artifact.id));
  if (reviewedArtifacts.length !== 2 || reviewedArtifacts.some(artifact => artifact.approval_status !== 'approved')) throw new Error('Dashboard API did not preserve local approval for the reviewed material revisions');
  if (state.artifacts.some(artifact => !['draft_needs_human_review', 'approved', 'rejected'].includes(artifact.approval_status))) throw new Error('Dashboard API exposed an invalid artifact review status');
  const dashboard = await requestRaw('/');
  if (dashboard.status !== 200 || !dashboard.body.includes('Profile & Proof') || !dashboard.body.includes('Kanban-style application status board') || !dashboard.body.includes('Artifact review status') || !dashboard.body.includes('Discovery')) throw new Error('Dashboard shell did not render expected interactive navigation');
  const traversal = await requestRaw('/workspace/../README.md');
  const unknown = await requestRaw('/README.md');
  if (![400, 404].includes(traversal.status) || unknown.status !== 404) throw new Error(`Dashboard route hardening failed: traversal=${traversal.status}, unknown=${unknown.status}`);
  server.kill('SIGTERM');
  console.log(JSON.stringify({ ok: true, root, profile: profile.id, job: job.id, score: score.overall, application: app.id, humanReview: { readyForReview: reviewPlan.status, approved: approvedPlan.status, reviewedArtifactIds: reviewQueue.map(item => item.id), applicationStatusChanged: false, externalSideEffects: 'none' }, discoveryRun: discovery.runId, schedulerRun: schedulerRun.runs[0].id, priorityBrief: briefPath, interviewPrep: true, interviews: funnel.totals.interviews, dashboardApiJobs: state.jobs.length, dashboardShell: true, interactiveDashboard: true, routeHardening: true }, null, 2));
} finally {
  if (server && !server.killed) server.kill('SIGTERM');
  if (!process.env.KEEP_JOBOS_SMOKE) rmSync(root, { recursive: true, force: true });
}
