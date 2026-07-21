// Durable research run lifecycle.
// createResearchRun -> executeResearchRun (graph runs to terminal state) -> get/resume/cancel
import { one, run, audit, save } from '../db.js';
import { id, now, parseJson } from '../utils.js';
import { writeYaml, writeMd } from '../workspace.js';
import { resolvePerson } from './people.js';
import { runGraph } from './graph.js';
import { listAdapters } from './adapters/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- Status constants ----

export const RUN_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED_RETRYABLE: 'paused_retryable',
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled'
});

const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const RESUMEABLE_STATUSES = new Set(['paused_retryable']);

// ---- Default budgets ----

export const DEFAULT_BUDGET_STANDARD = Object.freeze({
  maxQueries: 8,
  maxCandidates: 15,
  maxSourceChars: 250000,
  maxModelCalls: 2,
  maxPaidToolCalls: 2,
  maxDurationMs: 120000,
  maxCostUsd: null
});

export const DEFAULT_BUDGET_DEEP = Object.freeze({
  maxQueries: 20,
  maxCandidates: 30,
  maxSourceChars: 750000,
  maxModelCalls: 4,
  maxPaidToolCalls: 4,
  maxDurationMs: 300000,
  maxCostUsd: null
});

// ---- Request shape ----
// {
//   profileId: string,
//   scope: 'profile'|'target'|'job'|'person',
//   jobId?: string,
//   company?: string,
//   role?: string,
//   personId?: string,
//   person?: { name, profileUrl },
//   depth: 'standard'|'deep',
//   sources: ('local_network'|'linkedin_import'|'public_web'|'github'|'gdelt'|'wayback'|'xai')[],
//   refresh?: boolean,
//   budget?: { maxQueries?, maxCandidates?, maxSourceChars?, maxModelCalls?, maxPaidToolCalls?, maxDurationMs?, maxCostUsd? }
// }

const VALID_SCOPES = new Set(['profile', 'target', 'job', 'person']);
const STATIC_SOURCES = new Set(['local_network', 'linkedin_import', 'public_web', 'github', 'gdelt', 'wayback', 'xai']);
function validSources() {
  const all = new Set(STATIC_SOURCES);
  for (const name of listAdapters()) all.add(name);
  // Also accept the dashed adapter names
  const mapped = Object.values(ADAPTER_NAME_MAP);
  for (const v of mapped) all.add(v);
  return all;
}
const ADAPTER_NAME_MAP = {
  local_network: 'local-network',
  linkedin_import: 'linkedin-import',
  public_web: 'public-web',
  github: 'github',
  gdelt: 'gdelt',
  wayback: 'wayback',
  xai: 'xai'
};

// ---- Validation ----

function validateScopeInputs(s, request) {
  const errors = [];
  const profile = request.profileId ? one(s, 'SELECT id,preferences_json FROM profiles WHERE id=?', [request.profileId]) : null;
  if (!profile) errors.push(`Profile not found: ${request.profileId || '(missing)'}`);

  if (!VALID_SCOPES.has(request.scope)) errors.push(`Invalid scope: ${request.scope}. Must be one of: ${[...VALID_SCOPES].join(', ')}`);
  if (request.depth && !['standard', 'deep'].includes(request.depth)) errors.push(`Invalid depth: ${request.depth}. Must be 'standard' or 'deep'`);

  if (request.sources) {
    const valid = validSources();
    const invalid = request.sources.filter(s => !valid.has(s));
    if (invalid.length) errors.push(`Invalid sources: ${invalid.join(', ')}. Valid: ${[...valid].join(', ')}`);
  }

  if (request.scope === 'profile') {
    // Requires completed network intent
    if (profile) {
      const prefs = parseJson(profile.preferences_json, {});
      const intent = prefs.networkIntent;
      if (!intent?.completedAt) {
        errors.push('Profile scope requires completed network intent. Run jobos profile network-intent first.');
      }
    }
  }

  if (request.scope === 'target') {
    if (!request.company) errors.push('Target scope requires company');
    // role is optional for target scope
  }

  if (request.scope === 'job') {
    const job = request.jobId ? one(s, 'SELECT * FROM jobs WHERE id=?', [request.jobId]) : null;
    if (!job) {
      errors.push('Job scope requires a valid jobId');
    } else if (job.profile_id !== request.profileId) {
      errors.push('Job does not belong to the specified profile');
    } else {
      // Hard-fail if conflicting fields
      if (request.company && request.company !== job.company) {
        errors.push(`Job scope: supplied company "${request.company}" conflicts with job company "${job.company}"`);
      }
      if (request.role && request.role !== job.title) {
        errors.push(`Job scope: supplied role "${request.role}" conflicts with job title "${job.title}"`);
      }
      if (request.personId || request.person) {
        errors.push('Job scope must not include person fields');
      }
    }
  }

  if (request.scope === 'person') {
    if (request.personId) {
      const existing = one(s, 'SELECT id FROM people WHERE id=?', [request.personId]);
      if (!existing) errors.push(`Person not found: ${request.personId}`);
    } else if (request.person?.name && request.person?.profileUrl) {
      const profileUrl = String(request.person.profileUrl || '').trim();
      if (!/^https?:\/\//i.test(profileUrl)) {
        errors.push('Person profile URL must be HTTP(S)');
      }
    } else {
      errors.push('Person scope requires personId or person.name + person.profileUrl');
    }
  }

  return errors;
}

// ---- Budget helpers ----

function resolveDefaultBudget(depth) {
  return depth === 'deep' ? { ...DEFAULT_BUDGET_DEEP } : { ...DEFAULT_BUDGET_STANDARD };
}

function applyUserBudget(defaults, userBudget) {
  const budget = { ...defaults };
  if (!userBudget) return budget;
  if (typeof userBudget !== 'object' || Array.isArray(userBudget)) {
    throw Object.assign(new Error('budget must be an object'), { code: 'invalid_research_budget', type: 'research' });
  }
  const allowOverride = process.env.JOBOS_RESEARCH_ALLOW_BUDGET_OVERRIDE === '1';
  for (const key of ['maxQueries', 'maxCandidates', 'maxSourceChars', 'maxModelCalls', 'maxPaidToolCalls', 'maxDurationMs']) {
    if (userBudget[key] === undefined) continue;
    const value = Number(userBudget[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw Object.assign(new Error(`${key} must be a non-negative number`), { code: 'invalid_research_budget', type: 'research' });
    }
    if (!allowOverride && value > defaults[key]) {
      throw Object.assign(new Error(`${key} exceeds the ${defaults[key]} ${key} cap; set JOBOS_RESEARCH_ALLOW_BUDGET_OVERRIDE=1 to raise it`), { code: 'research_budget_exceeds_default', type: 'research' });
    }
    budget[key] = value;
  }
  if (userBudget.maxCostUsd !== undefined) {
    const value = userBudget.maxCostUsd;
    if (value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw Object.assign(new Error('maxCostUsd must be null or a non-negative number'), { code: 'invalid_research_budget', type: 'research' });
    }
    budget.maxCostUsd = value === null ? null : Number(value);
  }
  return budget;
}

function checkPricingPreflight(budget, sources) {
  // If maxCostUsd is set AND there are paid sources, verify pricing is available
  if (budget.maxCostUsd === null || budget.maxCostUsd === undefined) return null;

  if (!sources.includes('xai')) return null;
  const pricingEnv = process.env.JOBOS_MODEL_PRICING_JSON;
  if (!pricingEnv) {
    return 'maxCostUsd specified but JOBOS_MODEL_PRICING_JSON is not set — cannot enforce dollar budget';
  }
  try {
    const pricing = JSON.parse(pricingEnv);
    if (!pricing || typeof pricing !== 'object') {
      return 'JOBOS_MODEL_PRICING_JSON is not a valid pricing object';
    }
    const model = String(process.env.JOBOS_XAI_MODEL || 'grok-4.5').trim();
    const rate = pricing?.models?.[model] || pricing?.xai?.[model] || pricing?.[model];
    const fields = rate && typeof rate === 'object'
      ? ['inputPerMillionUsd', 'inputPer1MTokensUsd', 'inputPerMillion', 'input', 'outputPerMillionUsd', 'outputPer1MTokensUsd', 'outputPerMillion', 'output', 'xSearchCallUsd', 'toolCallUsd', 'xSearchCall', 'tool']
      : [];
    if (!fields.some(field => Number.isFinite(Number(rate[field])) && Number(rate[field]) >= 0)) {
      return `JOBOS_MODEL_PRICING_JSON has no usable price for xAI model ${model}`;
    }
  } catch {
    return 'JOBOS_MODEL_PRICING_JSON is not valid JSON';
  }

  return null;
}

// ---- Status helpers ----

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function isResumeable(status) {
  return RESUMEABLE_STATUSES.has(status);
}

// ---- Checkpoint persistence ----

function buildCheckpoint(state) {
  return {
    completedNodes: state.completedNodes || [],
    plannedQueries: state.plannedQueries || [],
    observationIds: state.observationIds || [],
    personIds: state.personIds || [],
    contactIds: state.contactIds || [],
    refresh: Boolean(state.refresh),
    nextNode: state.nextNode || null
  };
}

function buildUsage(state) {
  const u = state.usage || {};
  return {
    queries: u.queries || 0,
    sourceChars: u.sourceChars || 0,
    modelCalls: u.modelCalls || 0,
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    paidToolCalls: u.paidToolCalls || 0,
    estimatedUsd: u.estimatedUsd == null && (u.modelCalls || 0) > 0 ? null : Number(u.estimatedUsd) || 0
  };
}

export function saveRunState(s, runId, state) {
  const at = now();
  const checkpoint = buildCheckpoint(state);
  const usage = buildUsage(state);
  run(s, `UPDATE research_runs SET status=?,usage_json=?,checkpoint_json=?,warnings_json=?,error=?,updated_at=? WHERE id=?`, [
    state.status || 'queued',
    JSON.stringify(usage),
    JSON.stringify(checkpoint),
    JSON.stringify(state.warnings || []),
    state.error || '',
    at,
    runId
  ]);
  save(s);
}

// ---- Row mapping ----

export function researchRunRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    scope: row.scope,
    jobId: row.job_id || null,
    companyName: row.company_name || '',
    role: row.role || '',
    personId: row.person_id || null,
    depth: row.depth || 'standard',
    sources: parseJson(row.sources_json, []),
    budget: parseJson(row.budget_json, {}),
    usage: parseJson(row.usage_json, {}),
    status: row.status,
    checkpoint: parseJson(row.checkpoint_json, {}),
    warnings: parseJson(row.warnings_json, []),
    error: row.error || '',
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---- Create ----

export function createResearchRun(s, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw Object.assign(new Error('Research request must be an object'), { code: 'invalid_research_request', type: 'research' });
  }
  const errors = validateScopeInputs(s, request);
  if (errors.length) {
    throw Object.assign(new Error(errors.join('; ')), { code: 'invalid_research_scope_inputs', type: 'research', details: { errors } });
  }
  const depth = request.depth || 'standard';
  let sources;
  const profile = one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [request.profileId]);
  const intent = parseJson(profile?.preferences_json, {}).networkIntent || {};
  if (request.sources === undefined) {
    sources = ['local_network'];
    if (intent.allowedSources?.linkedinImport === true) sources.push('linkedin_import');
    if (request.scope === 'profile') {
      if ((intent.targetCompanies || []).length && intent.allowedSources?.publicWeb !== false) sources.push('public_web');
    } else if (intent.allowedSources?.publicWeb !== false) {
      sources.push('public_web');
    }
  } else if (!Array.isArray(request.sources)) {
    throw Object.assign(new Error('sources must be an array'), { code: 'invalid_research_request', type: 'research' });
  } else {
    sources = [...new Set(request.sources)];
  }
  const valid = validSources();
  const invalidSources = sources.filter(source => !valid.has(source));
  if (invalidSources.length) {
    throw Object.assign(new Error(`Invalid sources: ${invalidSources.join(', ')}`), { code: 'invalid_research_request', type: 'research' });
  }
  if (request.scope === 'profile' && (sources.includes('public_web') || sources.includes('xai')) && !(intent.targetCompanies || []).length) {
    throw Object.assign(new Error('Open profile research may use public_web or xai only after confirming target companies'), { code: 'invalid_research_scope_inputs', type: 'research' });
  }
  if (sources.includes('xai')) {
    if (process.env.JOBOS_XAI_ENABLED !== '1' || intent.allowedSources?.xai !== true || !String(process.env.XAI_API_KEY || '').trim()) {
      throw Object.assign(new Error('xAI requires JOBOS_XAI_ENABLED=1, profile consent, and XAI_API_KEY'), { code: 'xai_preflight_failed', type: 'research' });
    }
  }
  const budget = applyUserBudget(resolveDefaultBudget(depth), request.budget || {});
  const pricingWarning = checkPricingPreflight(budget, sources);
  if (pricingWarning) throw Object.assign(new Error(pricingWarning), { code: 'research_pricing_unknown', type: 'research' });

  let personId = request.personId || null;
  if (request.scope === 'person' && !personId) {
    const resolved = resolvePerson(s, {
      name: request.person.name,
      profileUrl: request.person.profileUrl,
      sourceRecordId: `person-scope:${request.person.profileUrl}`
    });
    personId = resolved?.person?.id || null;
  }
  // Resolve company name and role from job for job scope
  let companyName = request.company || '';
  let role = request.role || '';
  if (request.scope === 'job' && request.jobId && (!companyName || !role)) {
    const job = one(s, 'SELECT * FROM jobs WHERE id=?', [request.jobId]);
    if (job) {
      if (!companyName) companyName = job.company || '';
      if (!role) role = job.title || '';
    }
  }

  const at = now();
  const runId = id('research', `${request.profileId}:${request.scope}:${at}`);
  const checkpoint = { completedNodes: [], plannedQueries: [], observationIds: [], personIds: [], contactIds: [], refresh: Boolean(request.refresh), nextNode: 'validate' };
  run(s, `INSERT INTO research_runs (id,profile_id,scope,job_id,company_name,role,person_id,depth,sources_json,budget_json,usage_json,status,checkpoint_json,warnings_json,error,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    runId, request.profileId, request.scope, request.jobId || null, companyName, role, personId,
    depth, JSON.stringify(sources), JSON.stringify(budget), '{}', 'queued', JSON.stringify(checkpoint), '[]', '',
    null, null, at, at
  ]);
  audit(s, 'research.run.created', 'research', runId, {
    profileId: request.profileId,
    scope: request.scope,
    jobId: request.jobId || null,
    depth,
    sourceCount: sources.length
  });
  save(s);
  return runId;
}

// ---- Get ----

export function getResearchRun(s, runId) {
  const row = one(s, 'SELECT * FROM research_runs WHERE id=?', [runId]);
  return researchRunRow(row);
}

// ---- Checkpoint state reconstruction ----

function stateFromRun(run) {
  const cp = run.checkpoint || {};
  return {
    runId: run.id,
    status: run.status,
    scope: run.scope,
    profileId: run.profileId,
    jobId: run.jobId,
    companyName: run.companyName,
    role: run.role,
    personId: run.personId,
    depth: run.depth,
    sources: run.sources,
    budget: run.budget,
    usage: run.usage,
    warnings: [...run.warnings],
    error: run.error,
    completedNodes: cp.completedNodes || [],
    plannedQueries: cp.plannedQueries || [],
    observationIds: cp.observationIds || [],
    personIds: cp.personIds || [],
    contactIds: cp.contactIds || [],
    refresh: Boolean(cp.refresh),
    nextNode: 'nextNode' in cp ? cp.nextNode : 'validate'
  };
}

// ---- Execute ----

export async function executeResearchRun(s, runId, options = {}) {
  const runRow = getResearchRun(s, runId);
  if (!runRow) throw Object.assign(new Error(`Unknown research run: ${runId}`), { code: 'unknown_research_run', type: 'research' });

  if (runRow.status !== 'queued' && !isResumeable(runRow.status)) {
    throw Object.assign(new Error(`Cannot execute run ${runId}: status is ${runRow.status}. Must be 'queued' or 'paused_retryable'`), { code: 'invalid_run_status', type: 'research' });
  }

  const isResume = runRow.status === 'paused_retryable';
  const state = stateFromRun(runRow);
  if (isResume && state.nextNode === null) {
    throw Object.assign(new Error(`Cannot resume run ${runId}: nextNode is null`), { code: 'invalid_run_checkpoint', type: 'research' });
  }

  const externalSignal = options.signal || new AbortController().signal;
  const deadlineController = new AbortController();
  const deadlineAt = Date.now() + Number(state.budget?.maxDurationMs ?? DEFAULT_BUDGET_STANDARD.maxDurationMs);
  const deadlineTimer = setTimeout(() => deadlineController.abort('research_deadline'), Math.max(1, deadlineAt - Date.now()));
  deadlineTimer.unref?.();
  const signal = AbortSignal.any([externalSignal, deadlineController.signal]);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  // Mark running
  const at = now();
  run(s, `UPDATE research_runs SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?`, [at, at, runId]);
  save(s);

  if (!isResume) {
    audit(s, 'research.run.started', 'research', runId, {
      scope: state.scope,
      depth: state.depth,
      sources: state.sources
    });
  } else {
    audit(s, 'research.run.resumed', 'research', runId, {
      fromNode: state.nextNode
    });
  }

  try {
    // Run the LangGraph to terminal state
    const finalState = await runGraph(s, {
      ...state,
      status: 'running',
      error: '',
      warnings: isResume ? state.warnings.filter(warning => !/adapter failed:/i.test(warning)) : state.warnings,
      deadlineAt
    }, { signal, env, fetchImpl, deadlineAt });

    // Persist final state
    saveRunState(s, runId, finalState);

    // Set finished timestamp for terminal states
    if (isTerminal(finalState.status) || finalState.status === 'cancelled') {
      run(s, `UPDATE research_runs SET finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?`, [now(), now(), runId]);
    }

    // Write workspace mirrors
    writeRunMirrors(s, runId, finalState);

    // Profile scope: update network map
    if (finalState.scope === 'profile') {
      writeProfileNetworkMap(s, runId, finalState);
    }

    // Job scope: update job mirrors
    if (finalState.scope === 'job' && finalState.jobId) {
      writeJobRunMirrors(s, runId, finalState);
    }

    audit(s, 'research.run.completed', 'research', runId, {
      status: finalState.status,
      scope: finalState.scope,
      usage: buildUsage(finalState),
      warningCount: (finalState.warnings || []).length,
      observationCount: (finalState.observationIds || []).length
    });
    save(s);
    const counts = {
      observations: (finalState.observationIds || []).length,
      people: one(s, 'SELECT COUNT(*) AS count FROM person_candidates WHERE research_run_id=?', [runId])?.count || 0,
      contacts: one(s, 'SELECT COUNT(*) AS count FROM contact_points WHERE origin_research_run_id=?', [runId])?.count || 0
    };

    return {
      runId,
      status: finalState.status,
      scope: finalState.scope,
      profileId: finalState.profileId,
      jobId: finalState.jobId || null,
      usage: buildUsage(finalState),
      observationCount: (finalState.observationIds || []).length,
      counts,
      path: path.join('research', 'runs', `${runId}.yaml`),
      warnings: finalState.warnings || []
    };
  } catch (err) {
    // Unexpected error during graph execution
    const errorMessage = err?.message || String(err);
    const status = err?.retryable ? 'paused_retryable' : 'failed';
    run(s, `UPDATE research_runs SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?`, [status, errorMessage.slice(0, 2000), status === 'paused_retryable' ? null : now(), now(), runId]);
    audit(s, 'research.run.error', 'research', runId, { status, error: errorMessage.slice(0, 500) });
    save(s);
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// ---- Resume ----

export async function resumeResearchRun(s, runId, options = {}) {
  const runRow = getResearchRun(s, runId);
  if (!runRow) throw Object.assign(new Error(`Unknown research run: ${runId}`), { code: 'unknown_research_run', type: 'research' });
  if (!isResumeable(runRow.status)) {
    throw Object.assign(new Error(`Cannot resume run ${runId}: status is ${runRow.status}. Only 'paused_retryable' can be resumed`), { code: 'invalid_run_status', type: 'research' });
  }
  return executeResearchRun(s, runId, options);
}

// ---- Cancel ----

export function requestCancelResearchRun(s, runId) {
  const runRow = getResearchRun(s, runId);
  if (!runRow) throw Object.assign(new Error(`Unknown research run: ${runId}`), { code: 'unknown_research_run', type: 'research' });
  if (isTerminal(runRow.status)) return { runId, status: runRow.status, note: 'Run already in terminal state' };
  if (runRow.status === 'cancel_requested') return { runId, status: 'cancel_requested', note: 'Cancel already requested' };

  const at = now();
  audit(s, 'research.run.cancel_requested', 'research', runId, {});
  if (runRow.status === 'queued' || runRow.status === 'paused_retryable') {
    run(s, `UPDATE research_runs SET status='cancelled',finished_at=?,updated_at=? WHERE id=?`, [at, at, runId]);
    audit(s, 'research.run.cancelled', 'research', runId, { fromStatus: runRow.status });
    save(s);
    return { runId, status: 'cancelled', note: 'Run cancelled before further work was scheduled' };
  }
  run(s, `UPDATE research_runs SET status='cancel_requested',updated_at=? WHERE id=?`, [at, runId]);
  save(s);
  return { runId, status: 'cancel_requested', note: 'Cancel requested — will stop at next checkpoint' };
}

// ---- Workspace mirrors ----

function runMirrorDir(s) {
  return path.join(s.p.ws, 'research', 'runs');
}

export function writeRunMirrors(s, runId, state) {
  const dir = runMirrorDir(s);
  const base = path.join(dir, runId);

  const usage = buildUsage(state);
  const checkpoint = buildCheckpoint(state);

  const yamlData = {
    version: 2,
    runId,
    status: state.status,
    scope: state.scope,
    profileId: state.profileId,
    jobId: state.jobId || null,
    companyName: state.companyName || '',
    role: state.role || '',
    personId: state.personId || null,
    depth: state.depth,
    sources: state.sources || [],
    budget: state.budget || {},
    usage,
    startedAt: state.startedAt || null,
    finishedAt: state.finishedAt || null,
    warnings: state.warnings || [],
    error: state.error || '',
    observationCount: (state.observationIds || []).length,
    personHintCount: (state.personHints || []).length,
    contactCount: (state.contactIds || []).length,
    policy: {
      externalSideEffects: 'none',
      humanGate: 'required before outreach or applications'
    }
  };

  writeYaml(base + '.yaml', yamlData);

  const mdLines = [
    `# Research Run — ${runId}`,
    ``,
    `**Status:** ${state.status}`,
    `**Scope:** ${state.scope}`,
    `**Profile:** ${state.profileId}`,
    state.jobId ? `**Job:** ${state.jobId}` : null,
    state.personId ? `**Person:** ${state.personId}` : null,
    `**Depth:** ${state.depth}`,
    `**Sources:** ${(state.sources || []).join(', ')}`,
    ``,
    `## Usage`,
    `- Queries: ${usage.queries}`,
    `- Source chars: ${usage.sourceChars}`,
    `- Model calls: ${usage.modelCalls}`,
    `- Paid tool calls: ${usage.paidToolCalls}`,
    usage.estimatedUsd ? `- Estimated cost: \$${usage.estimatedUsd.toFixed(4)}` : null,
    ``,
    `## Warnings`,
    ...(state.warnings || []).map(w => `- ${w}`),
    (!state.warnings || state.warnings.length === 0) ? '- None' : null,
    ``,
    `## Observability`,
    `- Observations recorded: ${(state.observationIds || []).length}`,
    `- Person hints found: ${(state.personHints || []).length}`,
    `- Contact IDs: ${(state.contactIds || []).length}`,
    ``,
    `## Human gate`,
    `This run created local evidence and review records only; no outreach was sent.`,
    ``,
    `## Policy`,
    `- External side effects: none`,
    `- Human gate: required before outreach or applications`
  ].filter(Boolean).join('\n');

  writeMd(base + '.md', mdLines);
}

export function writeProfileNetworkMap(s, runId, state) {
  if (state.scope !== 'profile' || !state.profileId) return;
  const profileDir = path.join(s.p.profiles, state.profileId);
  fs.mkdirSync(profileDir, { recursive: true });
  const mapBase = path.join(profileDir, 'network-map');
  const usage = buildUsage(state);

  const mapData = {
    version: 2,
    generatedBy: runId,
    profileId: state.profileId,
    generatedAt: now(),
    status: state.status,
    scope: state.scope,
    sources: state.sources || [],
    usage,
    personHints: (state.personHints || []).slice(0, 100),
    observationCount: (state.observationIds || []).length,
    contactCount: (state.contactIds || []).length,
    warnings: state.warnings || [],
    policy: {
      externalSideEffects: 'none',
      humanGate: 'required before outreach or applications'
    }
  };

  writeYaml(`${mapBase}.yaml`, mapData);

  const mdLines = [
    `# Network Map — ${state.profileId}`,
    ``,
    `**Generated by run:** ${runId}`,
    `**Status:** ${state.status}`,
    `**Sources:** ${(state.sources || []).join(', ')}`,
    ``,
    `## People discovered`,
    ...(state.personHints || []).slice(0, 50).map((p, i) => `- **${p.name}**${p.company ? ` @ ${p.company}` : ''}${p.role ? ` — ${p.role}` : ''}`),
    (state.personHints || []).length === 0 ? '- No people discovered yet' : null,
    ``,
    `## Usage`,
    `- Queries: ${usage.queries}`,
    `- Source chars: ${usage.sourceChars}`,
    ``,
    `## Warnings`,
    ...(state.warnings || []).map(w => `- ${w}`),
    (!state.warnings || state.warnings.length === 0) ? '- None' : null,
    ``,
    `## Human gate`,
    `This network map was created from local profiles and source observations.`,
    `No external outreach was sent. All contacts require human approval before use.`
  ].filter(Boolean).join('\n');

  writeMd(`${mapBase}.md`, mdLines);
}

export function writeJobRunMirrors(s, runId, state) {
  if (!state.jobId) return;
  const jobDir = path.join(s.p.ws, 'jobs', state.jobId, 'research');
  fs.mkdirSync(jobDir, { recursive: true });

  const usage = buildUsage(state);

  const runRef = {
    version: 1,
    runId,
    status: state.status,
    scope: state.scope,
    profileId: state.profileId,
    generatedAt: now(),
    usage,
    observationCount: (state.observationIds || []).length,
    personHints: (state.personHints || []).length,
    warnings: state.warnings || [],
    policy: {
      externalSideEffects: 'none',
      humanGate: 'required before outreach or applications'
    }
  };

  writeYaml(path.join(jobDir, `run-${runId}.yaml`), runRef);
}

// ---- Source observation - run-source join ----

export function linkRunSource(s, runId, sourceObservationId) {
  run(s, 'INSERT OR IGNORE INTO research_run_sources (run_id, source_observation_id) VALUES (?,?)', [runId, sourceObservationId]);
}

export function linkRunSources(s, runId, sourceObservationIds) {
  for (const sid of sourceObservationIds) {
    if (sid) run(s, 'INSERT OR IGNORE INTO research_run_sources (run_id, source_observation_id) VALUES (?,?)', [runId, sid]);
  }
}

// ---- State from run row ----

export function stateFromResearchRun(s, runId) {
  const runRow = getResearchRun(s, runId);
  if (!runRow) return null;
  return stateFromRun(runRow);
}
