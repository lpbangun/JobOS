import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, one, openStore } from '../src/db.js';
import { createSearch, runSavedSearch } from '../src/discovery.js';
import { greenhouse } from '../src/discovery/adapters.js';
import { importNormalized } from '../src/jobs.js';
import { score as scoreJob } from '../src/scoring.js';
import { runPursuit } from '../src/workflows.js';
import { buildFormSnapshot, persistFormSnapshot } from '../src/forms.js';
import { DOM_ADAPTER_MANIFEST } from '../src/form-browser.js';

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
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator discovery and shipped a learning workflow that reduced manual review time by 30%.', '--evidence', 'Verified portfolio case study', '--skills', 'product discovery,user research,stakeholder management,launch execution', '--json']));
  const resume = path.join(root, 'resume.json');
  writeFileSync(resume, JSON.stringify({
    schemaVersion: 1,
    identity: { name: 'Morgan Candidate', email: 'morgan@example.com', phone: '+1 555 555 0100', location: 'Remote', links: [], verificationStatus: 'verified' },
    summary: { id: 'summary_main', text: 'Product leader building evidence-grounded learning workflows.', proofPointIds: [proof.id], verificationStatus: 'verified' },
    experience: [{ id: 'experience_learning', employer: 'Learning Studio', title: 'Senior Product Manager', location: 'Remote', startDate: '2021-01', endDate: null, dateSource: { startText: '2021-01', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified', bullets: [{ id: 'bullet_discovery', text: 'Led educator discovery and shipped a learning workflow that reduced manual review time by 30%.', proofPointIds: [proof.id], verificationStatus: 'verified' }] }],
    education: [{ id: 'education_state', institution: 'State University', degree: 'BS', field: 'Information Systems', location: '', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_discovery', name: 'Product discovery', category: 'Product', verificationStatus: 'verified' }, { id: 'skill_research', name: 'User research', category: 'Product', verificationStatus: 'verified' }],
    credentials: [],
    projects: [],
    additionalSections: []
  }, null, 2));
  JSON.parse(run(['resume', 'import', '--profile', profile.id, '--file', resume, '--json']));
  JSON.parse(run(['searches', 'create', 'Acme Discovery', '--profile', profile.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json'), '--keywords', 'Product,Learning', '--location', 'Remote', '--min-fit', '50', '--json']));
  const discovery = JSON.parse(run(['discover', 'run', '--search', 'Acme Discovery', '--json']));
  if (discovery.status !== 'succeeded' || discovery.counts.imported !== 1 || discovery.counts.highFit < 1) throw new Error('Fixture-backed discovery run did not import and flag a high-fit job');
  const richFixture = path.join(process.cwd(), 'tests', 'fixtures', 'discovery-integrity', 'greenhouse-rich.json');
  JSON.parse(run(['searches', 'create', 'W03 Rich Discovery', '--profile', profile.id, '--adapter', 'greenhouse', '--company', 'Acme', '--board-token', 'acme', '--fixture', richFixture, '--posted-within-days', '30', '--remote-only', '--employment-types', 'full_time', '--min-fit', '50', '--json']));
  const richDiscovery = JSON.parse(run(['discover', 'run', '--search', 'W03 Rich Discovery', '--json']));
  if (richDiscovery.status !== 'succeeded' || richDiscovery.counts.imported !== 1) throw new Error('W03 rich fixture discovery did not succeed');
  const richJobId = richDiscovery.jobs[0]?.id;
  const richStore = await openStore({ workspace: root });
  const richRow = one(richStore, 'SELECT * FROM jobs WHERE id=?', [richJobId]);
  const richYaml = readFileSync(path.join(root, 'jobos-workspace', 'jobs', richJobId, 'job.yaml'), 'utf8');
  if (JSON.parse(richRow.compensation_json).min !== 150000 || richRow.work_model !== 'remote' || !JSON.parse(richRow.employment_types_json).includes('full_time') || richRow.department !== 'Product') {
    throw new Error('W03 normalized native fields did not survive the SQLite round trip');
  }
  if (!richYaml.includes('compensationDetails:') || !richYaml.includes('workModel: remote') || !richYaml.includes('liveness:')) {
    throw new Error('W03 normalized native fields or liveness did not survive the workspace projection');
  }
  richStore.db.close();

  const w03Store = await openStore({ workspace: root });
  const [fixtureJob] = await greenhouse.fetchJobs({ fixture: richFixture, company: 'Acme', boardToken: 'acme' });
  const mixedJobs = [
    { ...fixtureJob, sourceId: 'smoke-active', title: 'W03 Active', url: 'https://boards.greenhouse.io/acme/jobs/smoke-active' },
    { ...fixtureJob, sourceId: 'smoke-expired', title: 'W03 Expired', url: 'https://boards.greenhouse.io/acme/jobs/smoke-expired' },
    { ...fixtureJob, sourceId: 'smoke-broken', title: 'W03 Broken Import', url: 'https://boards.greenhouse.io/acme/jobs/smoke-broken' },
    { ...fixtureJob, sourceId: 'smoke-uncertain', title: 'W03 Uncertain', url: 'https://boards.greenhouse.io/acme/jobs/smoke-uncertain' }
  ];
  const mixedSearch = createSearch(w03Store, {
    name: 'W03 Mixed Discovery',
    profileId: profile.id,
    adapter: 'greenhouse',
    config: { fixture: richFixture, company: 'Acme', boardToken: 'acme' },
    minFit: 50
  });
  const scoredW03Jobs = [];
  const mixedNow = () => Date.now();
  const mixedLiveness = async candidate => {
    const checkedAt = new Date(mixedNow()).toISOString();
    const status = candidate.sourceId === 'smoke-expired' ? 'expired' : candidate.sourceId === 'smoke-uncertain' ? 'uncertain' : 'active';
    return {
      version: 1,
      jobId: '',
      status,
      checkedAt,
      requestedUrl: candidate.url,
      finalUrl: candidate.url,
      httpStatus: status === 'expired' ? 404 : status === 'active' ? 200 : 429,
      reasonCodes: [status === 'expired' ? 'not_found' : status === 'active' ? 'listed_in_current_listing' : 'anti_bot'],
      evidence: [{ kind: status === 'uncertain' ? 'anti_bot' : 'http_status', value: status === 'expired' ? '404' : status === 'active' ? '200' : 'challenge' }],
      source: 'greenhouse',
      freshUntil: new Date(mixedNow() + 86_400_000).toISOString()
    };
  };
  const mixedDiscovery = await runSavedSearch(w03Store, mixedSearch.id, {
    adapter: { fetchJobs: async () => mixedJobs },
    importJob: (store, args) => {
      if (args.job.sourceId === 'smoke-broken') throw Object.assign(new Error('deterministic smoke import failure'), { code: 'smoke_import_failure' });
      return importNormalized(store, args);
    },
    scoreJob: async (store, jobId, profileId, options) => {
      scoredW03Jobs.push(jobId);
      return scoreJob(store, jobId, profileId, options);
    },
    checkLiveness: mixedLiveness,
    now: mixedNow
  });
  if (mixedDiscovery.status !== 'partial' || !mixedDiscovery.errors.some(item => item.stage === 'import') || !mixedDiscovery.jobs.some(item => item.title === 'W03 Uncertain' && item.outcome === 'scored')) {
    throw new Error('W03 mixed discovery did not preserve partial status, structured failure, and later-result progress');
  }
  const expiredW03 = one(w03Store, "SELECT * FROM jobs WHERE title='W03 Expired' AND profile_id=?", [profile.id]);
  const uncertainW03 = one(w03Store, "SELECT * FROM jobs WHERE title='W03 Uncertain' AND profile_id=?", [profile.id]);
  const activeW03 = one(w03Store, "SELECT * FROM jobs WHERE title='W03 Active' AND profile_id=?", [profile.id]);
  if (!activeW03 || activeW03.liveness_status !== 'active' || !expiredW03 || expiredW03.liveness_status !== 'expired' || !uncertainW03 || uncertainW03.liveness_status !== 'uncertain') {
    throw new Error('W03 active, expired, and uncertain liveness states are not visible');
  }
  if (expiredW03.fit_score != null || scoredW03Jobs.includes(expiredW03.id)) throw new Error('W03 expired result was scored');
  let expiredPursuitError = null;
  try {
    await runPursuit(w03Store, { jobId: expiredW03.id, profileId: profile.id });
  } catch (error) {
    expiredPursuitError = error;
  }
  if (expiredPursuitError?.code !== 'job_expired') throw new Error('W03 expired result entered pursuit');
  const w03Runs = all(w03Store, "SELECT external_side_effects FROM automation_runs WHERE trigger_name='discover.run'");
  const w03Audits = all(w03Store, "SELECT external_side_effect FROM audit_log WHERE entity_id=? OR entity_id IN (?,?,?)", [mixedDiscovery.runId, activeW03.id, expiredW03.id, uncertainW03.id]);
  if (w03Runs.some(item => item.external_side_effects !== 'none') || w03Audits.some(item => item.external_side_effect !== 'none')) throw new Error('W03 discovery claimed an external side effect');
  if (one(w03Store, 'SELECT COUNT(*) AS count FROM applications WHERE job_id IN (?,?,?)', [activeW03.id, expiredW03.id, uncertainW03.id]).count !== 0) throw new Error('W03 discovery created an application');
  w03Store.db.close();
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
  if (!(score.overall > 0)) throw new Error('Score did not compute');
  const resumeDraft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown'], true);
  if (!resumeDraft.includes('## Experience') || !resumeDraft.includes('## Education') || resumeDraft.includes('Evidence-backed highlights')) throw new Error('Resume draft was not a complete semantic resume');
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
  if (approvedPlan.status !== 'materials-ready' || approvedPlan.localApprovalComplete !== true) throw new Error(`Application did not reach materials-ready local readiness: ${approvedPlan.status}`);
  const afterReviewStore = await openStore({ workspace: root });
  persistFormSnapshot(afterReviewStore, buildFormSnapshot({
    snapshotId: 'form_smoke_application',
    jobId: job.id,
    profileId: profile.id,
    capturedAt: new Date().toISOString(),
    requestedUrl: 'https://board.example/jobs/smoke/apply',
    finalUrl: 'https://board.example/jobs/smoke/apply',
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frameKey: 'main', formKey: 'application', candidateCount: 1, score: 10 },
    fields: [{ frameKey: 'main', locatorPath: '#full-name', prompt: 'Full name', control: 'text', required: true }],
    warnings: []
  }));
  const applicationAfterReview = one(afterReviewStore, 'SELECT status,notes,confirmation_url,updated_at FROM applications WHERE id=?', [app.id]);
  const statusChangesAfterReview = Number(one(afterReviewStore, 'SELECT COUNT(*) AS count FROM status_changes WHERE application_id=?', [app.id]).count);
  const auditsAfterReview = Number(one(afterReviewStore, 'SELECT COUNT(*) AS count FROM audit_log').count);
  const approvalAudits = all(afterReviewStore, `SELECT entity_id,external_side_effect FROM audit_log
    WHERE action='artifact.approved' AND entity_id IN (?,?) ORDER BY entity_id`, reviewQueue.map(item => item.id));
  afterReviewStore.db.close();
  if (JSON.stringify(applicationAfterReview) !== JSON.stringify(applicationBeforeReview) || statusChangesAfterReview !== statusChangesBeforeReview) throw new Error('Local artifact approval changed application tracking state');
  if (auditsAfterReview !== auditsBeforeReview + 2 || approvalAudits.length !== 2 || approvalAudits.some(event => event.external_side_effect !== 'none')) throw new Error('Approval audit events were missing or claimed an external side effect');
  const formReadyPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (formReadyPlan.status !== 'form-ready' || formReadyPlan.form?.formReady !== true) throw new Error(`Application did not reach live form readiness: ${formReadyPlan.status}`);

  const applicationPacket = JSON.parse(run(['apply', 'packet', 'create', '--job', job.id, '--profile', profile.id, '--json']));
  const resumeReview = reviewQueue.find(item => item.type === 'resume');
  const coverReview = reviewQueue.find(item => item.type === 'cover_letter');
  if (applicationPacket.resumeContentHash !== resumeReview.contentHash || applicationPacket.coverContentHash !== coverReview.contentHash || applicationPacket.receiptState !== 'none') {
    throw new Error('Application packet did not freeze the exact approved material hashes');
  }
  const submittedAt = new Date().toISOString();
  const attestation = JSON.parse(run(['apply', 'attest-submitted', applicationPacket.id, '--submitted-at', submittedAt, '--note', 'Smoke user attestation.', '--json']));
  if (!attestation.receiptBound || !attestation.applicationStatusChanged || attestation.currentStatus !== 'applied' || attestation.externalSideEffects !== 'none' || attestation.submissionPerformed !== false) {
    throw new Error('Submission attestation did not bind the exact packet honestly');
  }
  const attestedPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (attestedPlan.packet.currentPacketId !== applicationPacket.id || attestedPlan.packet.receiptState !== 'attested' || attestedPlan.policy.submissionPerformed !== false) {
    throw new Error('Readiness did not expose user attestation without claiming adapter submission');
  }
  const confirmation = JSON.parse(run(['apply', 'confirm-receipt', applicationPacket.id, '--reference', 'https://board.example/smoke-confirmation', '--note', 'Smoke external confirmation.', '--json']));
  if (confirmation.receiptState !== 'confirmed' || confirmation.externalSideEffects !== 'none' || confirmation.submissionPerformed !== false) {
    throw new Error('Receipt confirmation reported unsafe semantics');
  }
  const confirmedPlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (confirmedPlan.packet.receiptState !== 'confirmed' || confirmedPlan.policy.submissionPerformed !== false) {
    throw new Error('Confirmed readiness invented submission behavior or lost receipt state');
  }
  const receiptStore = await openStore({ workspace: root });
  const receiptRows = all(receiptStore, 'SELECT type,external_side_effect FROM application_receipts WHERE packet_id=? ORDER BY type', [applicationPacket.id]);
  const receiptApplication = one(receiptStore, 'SELECT status,confirmation_url FROM applications WHERE id=?', [app.id]);
  const boundChange = one(receiptStore, 'SELECT note FROM status_changes WHERE application_id=? AND to_status=? ORDER BY created_at DESC,id DESC LIMIT 1', [app.id, 'applied']);
  const receiptAudits = all(receiptStore, `SELECT action,external_side_effect,payload_json FROM audit_log
    WHERE action IN ('application_packet.created','application.submission_attested','application.receipt_confirmed') ORDER BY created_at,id`);
  receiptStore.db.close();
  if (receiptRows.length !== 2 || receiptRows.some(row => row.external_side_effect !== 'none')) throw new Error('Canonical receipt rows missing or unsafe');
  if (receiptApplication.status !== 'applied' || receiptApplication.confirmation_url !== 'https://board.example/smoke-confirmation') throw new Error('Receipt-bound application tracking is inconsistent');
  if (!boundChange?.note.includes(applicationPacket.id) || !boundChange.note.includes(applicationPacket.contentHash) || !boundChange.note.includes(attestation.receipt.id)) throw new Error('Applied status history is not bound to packet/hash/receipt');
  if (receiptAudits.length !== 3 || receiptAudits.some(event => event.external_side_effect !== 'none' || JSON.parse(event.payload_json).submissionPerformed !== false)) throw new Error('Packet/receipt audit spine is incomplete or claims submission');
  const packetYaml = readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'packets', `${applicationPacket.id}.yaml`), 'utf8');
  if (!packetYaml.includes('receiptState: confirmed') || /^\s+answer(?:Text)?:/m.test(packetYaml)) throw new Error('Packet mirror is stale or contains answer plaintext fields');

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
  const revisedResume = JSON.parse(readFileSync(resume, 'utf8'));
  revisedResume.summary.text = 'Product leader building verified, evidence-grounded learning workflows.';
  const revisedResumePath = path.join(root, 'resume-revised.json');
  writeFileSync(revisedResumePath, JSON.stringify(revisedResume, null, 2));
  JSON.parse(run(['resume', 'replace', '--profile', profile.id, '--file', revisedResumePath, '--json']));
  const stalePlan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  if (!stalePlan.blockers.some(item => item.code === 'resume_stale_source_revision')) throw new Error('Canonical resume revision did not stale the tailored artifact');
  const stalePacket = JSON.parse(run(['apply', 'packet', 'show', applicationPacket.id, '--json']));
  if (stalePacket.currency !== 'stale') throw new Error('Canonical resume revision did not stale the frozen packet');
  console.log(JSON.stringify({
    ok: true,
    root,
    profile: profile.id,
    job: job.id,
    score: score.overall,
    application: app.id,
    humanReview: {
      readyForReview: reviewPlan.status,
      approved: approvedPlan.status,
      reviewedArtifactIds: reviewQueue.map(item => item.id),
      applicationStatusChanged: false,
      externalSideEffects: 'none'
    },
    receiptSpine: {
      packetId: applicationPacket.id,
      contentHash: applicationPacket.contentHash,
      receiptState: confirmedPlan.packet.receiptState,
      receiptCount: receiptRows.length,
      appliedStatusBound: true,
      submissionPerformed: false,
      externalSideEffects: 'none'
    },
    discoveryRun: discovery.runId,
    w03: {
      richRun: richDiscovery.runId,
      normalizedFieldsRoundTrip: true,
      mixedRun: mixedDiscovery.runId,
      mixedStatus: mixedDiscovery.status,
      laterResultImported: Boolean(uncertainW03),
      structuredErrors: mixedDiscovery.errors,
      liveness: {
        active: activeW03.liveness_status,
        expired: expiredW03.liveness_status,
        uncertain: uncertainW03.liveness_status
      },
      expiredScored: false,
      expiredPursued: false,
      submissionPerformed: false,
      externalSideEffects: 'none'
    },
    schedulerRun: schedulerRun.runs[0].id,
    priorityBrief: briefPath,
    interviewPrep: true,
    interviews: funnel.totals.interviews
  }, null, 2));
} finally {
  if (!process.env.KEEP_JOBOS_SMOKE) rmSync(root, { recursive: true, force: true });
}
