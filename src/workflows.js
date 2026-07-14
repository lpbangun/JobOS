import { all, one } from './db.js';
import { runAllSearches } from './discovery.js';
import { dedupeJobs } from './jobs.js';
import { score } from './scoring.js';
import { research, listJobStakeholders } from './research.js';
import { discoverContacts, createOutreachPlan } from './research/contacts.js';
import { mapReachableNetwork } from './research/network.js';
import { prepareApplicationQuestions } from './answers.js';
import { tailor } from './tailoring.js';
import { appCreate } from './tracking.js';
import { draftOutreach } from './outreach.js';

const pursuitStages = [
  'score',
  'company',
  'stakeholders',
  'contacts',
  'network',
  'questions',
  'resume',
  'cover-letter',
  'application',
  'outreach'
];

const stageDependencies = {
  score: [],
  company: ['score'],
  stakeholders: ['company'],
  contacts: ['stakeholders'],
  network: ['contacts'],
  questions: ['score'],
  resume: ['score'],
  'cover-letter': ['score'],
  application: ['questions', 'resume', 'cover-letter'],
  outreach: ['network', 'application']
};

function workflowError(code, message) {
  return Object.assign(new Error(message), { code, type: 'workflow' });
}

function shouldAdvanceApplication(currentStatus, newStatus) {
  const forwardOrder = ['researching', 'saved', 'materials-ready', 'applied', 'recruiter-screen', 'interview', 'offer'];
  const currentRank = forwardOrder.indexOf(currentStatus);
  const newRank = forwardOrder.indexOf(newStatus);
  if (currentRank === -1) return false;
  return newRank > currentRank;
}

function validateProfileJob(s, jobId, profileId) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw workflowError('unknown_job', `Unknown job: ${jobId}`);
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw workflowError('unknown_profile', `Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw workflowError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);
  return job;
}

function selectedStages(stage) {
  if (!stage) return pursuitStages;
  if (!pursuitStages.includes(stage)) throw workflowError('unknown_stage', `Unknown pursuit stage: ${stage}`);
  const selected = new Set([stage]);
  const visit = name => {
    for (const dependency of stageDependencies[name] || []) {
      selected.add(dependency);
      visit(dependency);
    }
  };
  visit(stage);
  return pursuitStages.filter(name => selected.has(name));
}

function compactResult(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20);
  const keep = ['id', 'jobId', 'profileId', 'path', 'yamlPath', 'status', 'mode', 'overall', 'count', 'matched', 'blocked', 'recommended', 'stakeholderId', 'contactPointId', 'relationshipEdgeId', 'channel', 'pathStrength', 'pathCount', 'paths', 'warnings', 'errors', 'counts', 'runs', 'jobs', 'draft', 'plan', 'application', 'questions', 'factCount', 'reasoning', 'dimensions', 'generatedAt', 'unmatched'];
  return Object.fromEntries(keep.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

async function runStage(name, operation, timeoutMs) {
  const started = Date.now();
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(workflowError('stage_timeout', `Stage "${name}" exceeded ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
    const elapsedMs = Date.now() - started;
    return {
      stage: name,
      status: 'ok',
      elapsedMs,
      deadlineExceeded: false,
      result: compactResult(result)
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const deadlineExceeded = elapsedMs > timeoutMs && error?.code !== 'stage_timeout';
    return {
      stage: name,
      status: 'failed',
      elapsedMs,
      deadlineExceeded,
      error: {
        code: error?.code || 'stage_failed',
        type: error?.type || 'runtime',
        message: error?.message || String(error)
      },
      recovery: `Run "jobos pursue --stage ${name} <job-id> --profile <profile-id> --json" after resolving the error.`
    };
  }
}

export async function runDaily(s, { profileId }) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw workflowError('unknown_profile', `Unknown profile: ${profileId}`);
  const discovery = await runAllSearches(s, { profileId });
  const dedupe = dedupeJobs(s, { apply: true });
  const runs = discovery.runs || [];
  const jobs = runs.flatMap(run => run.jobs || []).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.company || '').localeCompare(String(b.company || '')));
  const failures = runs.filter(run => run.status !== 'succeeded' || (run.errors || []).length).map(run => ({ searchId: run.searchId, searchName: run.searchName, adapter: run.adapter, status: run.status, errors: run.errors || [], metadata: run.metadata || null }));
  return {
    ok: failures.length === 0,
    status: failures.length ? (jobs.length ? 'partial' : 'failed') : 'succeeded',
    profileId,
    searched: runs.length,
    imported: runs.reduce((sum, run) => sum + Number(run.counts?.imported || 0), 0),
    highFit: runs.reduce((sum, run) => sum + Number(run.counts?.highFit || 0), 0),
    jobs,
    failures,
    dedupe,
    scheduler: {
      enable: 'jobos automation enable daily_discovery --json',
      start: 'jobos scheduler start --interval 60'
    },
    runs
  };
}

export async function runPursuit(s, {
  jobId,
  profileId,
  stage = null,
  dryRun = false,
  stageTimeoutMs = 30000
}) {
  const job = validateProfileJob(s, jobId, profileId);
  const stagesToRun = selectedStages(stage);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      jobId,
      profileId,
      stages: stagesToRun.map(name => ({ stage: name, dependencies: stageDependencies[name] || [] }))
    };
  }

  const results = [];
  const byName = new Map();
  const operations = {
    score: () => score(s, jobId, profileId),
    company: () => research(s, jobId, 'company'),
    stakeholders: () => research(s, jobId, 'stakeholders'),
    contacts: () => discoverContacts(s, { jobId }),
    network: () => mapReachableNetwork(s, { jobId }),
    questions: () => prepareApplicationQuestions(s, { jobId, profileId }),
    resume: () => tailor(s, jobId, profileId, 'resume'),
    'cover-letter': () => tailor(s, jobId, profileId, 'cover'),
    application: () => {
      const materialStages = ['questions', 'resume', 'cover-letter'].map(name => byName.get(name));
      const materialsReady = materialStages.every(item => item?.status === 'ok');
      const existing = one(s, 'SELECT * FROM applications WHERE job_id=?', [jobId]);
      const status = materialsReady ? 'materials-ready' : 'researching';
      const notes = materialsReady ? 'Prepared by jobos pursue' : 'Pursuit completed with preparation gaps';
      const application = !existing || shouldAdvanceApplication(existing.status, status)
        ? appCreate(s, jobId, status, notes)
        : existing;
      return { application: { id: application.id, jobId: application.job_id, profileId: application.profile_id, status: application.status } };
    },
    outreach: async () => {
      const plan = createOutreachPlan(s, { jobId, profileId });
      const stakeholder = listJobStakeholders(s, jobId)[0] || null;
      if (!stakeholder) return { plan, draft: null, warnings: ['No source-backed stakeholder is available for an outreach draft.'] };
      try {
        const draft = await draftOutreach(s, { jobId, profileId, stakeholderId: stakeholder.id, goal: 'informational' });
        return { plan, draft };
      } catch (error) {
        return { plan, draft: null, warnings: [`Outreach draft needs attention: ${error.message}`] };
      }
    }
  };

  for (const name of stagesToRun) {
    const failedDependency = (stageDependencies[name] || []).find(dependency => byName.get(dependency)?.status === 'failed' || byName.get(dependency)?.status === 'skipped');
    let result;
    if (failedDependency) {
      result = { stage: name, status: 'skipped', elapsedMs: 0, reason: `upstream stage ${failedDependency} failed`, recovery: `Run "jobos pursue --stage ${failedDependency} ${jobId} --profile ${profileId} --json" first.` };
    } else {
      result = await runStage(name, operations[name], Number(stageTimeoutMs || 30000));
    }
    results.push(result);
    byName.set(name, result);
  }

  const failed = results.filter(item => item.status === 'failed');
  const skipped = results.filter(item => item.status === 'skipped');
  return {
    ok: failed.length === 0,
    status: failed.length ? 'partial' : 'succeeded',
    job: { id: job.id, title: job.title, company: job.company },
    jobId,
    profileId,
    failed: failed.length,
    skipped: skipped.length,
    stages: results
  };
}

export function listNetworkEdges(s) {
  return all(s, 'SELECT * FROM relationship_edges ORDER BY edge_type,from_id,to_id').map(row => ({
    id: row.id,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    edgeType: row.edge_type,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json || '[]'),
    createdAt: row.created_at
  }));
}

export function listNetworkContacts(s, { jobId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw workflowError('unknown_job', `Unknown job: ${jobId}`);
  const rows = all(s, `SELECT cp.*,pc.name,pc.role,pc.relevance
    FROM contact_points cp
    LEFT JOIN person_candidates pc ON pc.id=cp.person_id
    WHERE cp.company_id=? OR cp.person_id IN (SELECT id FROM person_candidates WHERE job_id=?)
    ORDER BY cp.human_approved DESC,cp.confidence DESC,pc.relevance DESC`, [job.company_id, jobId]);
  return rows.map(row => ({
    id: row.id,
    name: row.name || '',
    role: row.role || '',
    relevance: row.relevance || '',
    type: row.type,
    value: row.do_not_use ? null : row.value,
    evidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    approved: Boolean(row.human_approved),
    suppressed: Boolean(row.do_not_use)
  }));
}

export { pursuitStages };
