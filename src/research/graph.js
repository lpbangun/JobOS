// LangGraph orchestration for durable people-research runs.
// Fixed graph: validate -> hydrate_context -> plan_queries -> collect_sources -> resolve_people -> verify_contacts -> rank_paths -> persist_outputs
import { StateGraph, START, END, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { one, run, all } from '../db.js';
import { now, parseJson, id } from '../utils.js';
import { saveSourceObservation, canonicalUrl, normalizeEmail } from './sources.js';
import { buildResearchContext } from './context.js';
import { getAdapters, registerAdapter } from './adapters/index.js';
import { resolvePerson, upsertPerson } from './people.js';
import { TIER_RANK, upsertContactPoint, verifyObservationContacts } from './contacts.js';
import { saveRunState, linkRunSources, writeRunMirrors, writeProfileNetworkMap, writeJobRunMirrors } from './runs.js';

// ---- Research State Schema ----

const ResearchState = new StateSchema({
  runId: z.string().default(''),
  status: z.string().default('queued'),
  scope: z.string().default(''),
  profileId: z.string().default(''),
  jobId: z.string().nullable().default(null),
  companyName: z.string().default(''),
  role: z.string().default(''),
  personId: z.string().nullable().default(null),
  person: z.unknown().nullable().default(null),
  depth: z.string().default('standard'),
  sources: z.array(z.string()).default(() => []),
  budget: z.record(z.string(), z.unknown()).default(() => ({})),
  completedNodes: z.array(z.string()).default(() => []),
  plannedQueries: z.array(z.unknown()).default(() => []),
  observationIds: z.array(z.string()).default(() => []),
  personHints: z.array(z.unknown()).default(() => []),
  contactIds: z.array(z.string()).default(() => []),
  usage: z.record(z.string(), z.unknown()).default(() => ({})),
  warnings: z.array(z.string()).default(() => []),
  nextNode: z.string().nullable().default(null),
  cancelled: z.boolean().default(false),
  error: z.string().default(''),
  networkIntent: z.unknown().nullable().default(null),
  confirmedAffiliations: z.array(z.unknown()).default(() => []),
  companyId: z.string().nullable().default(null),
  deadlineAt: z.number().nullable().default(null),
  refresh: z.boolean().default(false),
  personIds: z.array(z.string()).default(() => [])
});

// ---- Node order (for sequencing) ----

const NODE_ORDER = [
  'validate',
  'hydrate_context',
  'plan_queries',
  'collect_sources',
  'resolve_people',
  'verify_contacts',
  'rank_paths',
  'persist_outputs'
];

const NODE_INDEX = Object.fromEntries(NODE_ORDER.map((name, i) => [name, i]));

function nextNodeName(currentName) {
  const idx = NODE_INDEX[currentName];
  if (idx === undefined || idx >= NODE_ORDER.length - 1) return null;
  return NODE_ORDER[idx + 1];
}

// ---- Cancellation check ----

function checkCancelled(s, runId, state, signal) {
  if (signal?.aborted) {
    const deadline = Number(state.deadlineAt || 0);
    if (deadline && Date.now() >= deadline) {
      return {
        ...state,
        status: 'partial',
        nextNode: null,
        warnings: [...(state.warnings || []), 'budget_exhausted: maxDurationMs reached'],
        completedNodes: [...(state.completedNodes || [])]
      };
    }
    return { ...state, status: 'cancelled', nextNode: null, cancelled: true, completedNodes: [...state.completedNodes || []] };
  }
  const row = one(s, 'SELECT status FROM research_runs WHERE id=?', [runId]);
  if (row?.status === 'cancel_requested') {
    return { ...state, status: 'cancelled', nextNode: null, cancelled: true, completedNodes: [...state.completedNodes || []] };
  }
  return null;
}

// ---- Budget/deadline check ----

function budgetExhausted(state) {
  const budget = state.budget || {};
  const usage = state.usage || {};
  if (budget.maxQueries != null && (usage.queries || 0) >= budget.maxQueries) return true;
  if (budget.maxSourceChars != null && (usage.sourceChars || 0) >= budget.maxSourceChars) return true;
  if (budget.maxModelCalls != null && (usage.modelCalls || 0) >= budget.maxModelCalls) return true;
  if (budget.maxPaidToolCalls != null && (usage.paidToolCalls || 0) >= budget.maxPaidToolCalls) return true;
  return false;
}

function deadlinePassed(budget) {
  if (!budget.maxDurationMs) return false;
  // We don't have a start time in state during graph execution, so this is checked
  // by the caller (executeResearchRun) which passes a signal with a timeout
  return false;
}

// ---- Apply exclusions ----

function matchesExclusion(value, exclusions) {
  if (!value || !exclusions?.length) return false;
  const lower = String(value).toLowerCase();
  return exclusions.some(ex => lower.includes(String(ex).toLowerCase()));
}

function applyExclusions(personHints, exclusions) {
  if (!exclusions?.length) return personHints;
  return personHints.filter(p => {
    if (matchesExclusion(p.name, exclusions)) return false;
    if (matchesExclusion(p.company, exclusions)) return false;
    if (matchesExclusion(p.role, exclusions)) return false;
    return true;
  });
}

// ---- Priority score ----
// Relationship strength: 30, Role/persona relevance: 25, Shared confirmed affiliation: 20,
// Target timing: 15, Evidence confidence/freshness: 10. Total = 100.

function computePriorityScore(hint, state) {
  let score = 0;

  // Relationship strength (0-30)
  // Direct connection = 30, mutual path = 20, known affiliation = 10, cold = 0
  if (hint.relationshipType === 'direct_connection') score += 30;
  else if (hint.relationshipType === 'mutual_path') score += 20;
  else if (hint.relationshipType === 'confirmed_affiliation') score += 10;
  else score += 0;

  // Role/persona relevance (0-25)
  if (hint.roleRelevance === 'high') score += 25;
  else if (hint.roleRelevance === 'medium') score += 15;
  else if (hint.roleRelevance === 'low') score += 5;

  // Shared confirmed affiliation (0-20)
  const affiliations = state.confirmedAffiliations || [];
  if (hint.sharedAffiliation) {
    const aff = affiliations.find(a => a.normalizedOrganization === hint.sharedAffiliation);
    if (aff && aff.status === 'confirmed') score += 20;
    else if (aff) score += 10;
  }

  // Target timing (0-15) — higher for recent observations
  if (hint.freshnessDays !== undefined) {
    if (hint.freshnessDays <= 7) score += 15;
    else if (hint.freshnessDays <= 30) score += 10;
    else if (hint.freshnessDays <= 90) score += 5;
    else score += 0;
  } else {
    score += 5; // neutral if unknown
  }

  // Evidence confidence/freshness (0-10)
  if (hint.confidence === 'high') score += 10;
  else if (hint.confidence === 'medium') score += 5;
  else if (hint.confidence === 'low') score += 2;

  return Math.min(100, Math.max(0, score));
}

// ---- Validation node ----

function validateNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const budget = state.budget || {};
  const warnings = [...(state.warnings || [])];

  // Scope validation (basic checks already done at create, but re-check)
  if (!state.scope || !state.profileId) {
    return {
      ...state,
      status: 'failed',
      nextNode: null,
      error: 'Missing scope or profileId',
      completedNodes: [...(state.completedNodes || []), 'validate']
    };
  }


  // Check if any sources are selected
  const sources = state.sources || [];
  if (sources.length === 0) {
    warnings.push('No sources selected — run will collect no observations');
  }


  saveRunState(s, state.runId, {
    ...state,
    status: 'running',
    warnings,
    completedNodes: [...(state.completedNodes || []), 'validate']
  });

  return {
    ...state,
    status: 'running',
    warnings,
    nextNode: 'hydrate_context',
    completedNodes: [...(state.completedNodes || []), 'validate']
  };
}

// ---- Hydrate context node ----

function hydrateContextNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  try {
    const ctx = buildResearchContext(s, state.runId);

    saveRunState(s, state.runId, {
      ...state,
      confirmedAffiliations: ctx.confirmedAffiliations,
      networkIntent: ctx.networkIntent,
      companyId: ctx.companyId,
      completedNodes: [...(state.completedNodes || []), 'hydrate_context']
    });

    return {
      ...state,
      confirmedAffiliations: ctx.confirmedAffiliations || [],
      networkIntent: ctx.networkIntent || null,
      companyId: ctx.companyId || null,
      nextNode: 'plan_queries',
      completedNodes: [...(state.completedNodes || []), 'hydrate_context']
    };
  } catch (err) {
    return {
      ...state,
      status: 'failed',
      nextNode: null,
      error: `hydrate_context failed: ${err?.message || err}`,
      completedNodes: [...(state.completedNodes || []), 'hydrate_context']
    };
  }
}

// ---- Query planner node ----

function planQueriesNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const maxQueries = state.budget?.maxQueries || 8;
  const queries = [];
  const addQuery = (query, sourceType, target) => {
    if (queries.length >= maxQueries) return;
    // Deduplicate by query text
    if (queries.some(q => q.query.toLowerCase() === query.toLowerCase())) return;
    queries.push({ query, sourceType, target: target || '' });
  };

  const company = state.companyName || '';
  const role = state.role || '';
  const affiliations = state.confirmedAffiliations || [];
  const intent = state.networkIntent || {};

  if (state.scope === 'person') {
    // Person scope: start from exact supplied URL/name
    const personObj = state.person;
    if (personObj?.profileUrl) {
      addQuery(`site:linkedin.com/in ${personObj.name || ''}`, 'web_search', personObj.name);
    }
    if (personObj?.name) {
      addQuery(`"${personObj.name}" ${company || ''} ${role || ''}`, 'web_search', personObj.name);
    }
  } else if (state.scope === 'target' || state.scope === 'job') {
    const targetCompanies = company ? [company] : (intent.targetCompanies || []);
    const targetRoles = role ? [role] : (intent.targetRoles || []);

    for (const tc of targetCompanies) {
      if (queries.length >= maxQueries) break;

      // Official team queries
      if (targetRoles.length) {
        for (const tr of targetRoles) {
          addQuery(`${tc} ${tr} team`, 'web_search', `${tc} ${tr}`);
          addQuery(`${tc} ${tr} head`, 'web_search', `${tc} ${tr}`);
        }
      } else {
        addQuery(`${tc} team`, 'web_search', tc);
      }

      // Public LinkedIn profile queries
      addQuery(`site:linkedin.com/in ${tc}`, 'web_search', tc);

      // Persona-specific queries
      for (const persona of (intent.preferredPersonas || [])) {
        addQuery(`${tc} ${persona}`, 'web_search', `${tc} ${persona}`);
      }

      // Affinity queries: confirmed affiliation + target company/role
      for (const aff of affiliations) {
        if (queries.length >= maxQueries) break;
        if (aff.status !== 'confirmed') continue;
        const org = aff.normalizedOrganization;
        if (targetRoles.length) {
          for (const tr of targetRoles) {
            addQuery(`"${org}" "${tc}" ${tr}`, 'web_search', `${org} → ${tc} ${tr}`);
          }
        } else {
          addQuery(`"${org}" "${tc}"`, 'web_search', `${org} → ${tc}`);
        }
      }
    }
  } else if (state.scope === 'profile') {
    // Profile scope: from confirmed target companies and affiliations
    const targetCompanies = intent.targetCompanies || [];

    for (const tc of targetCompanies) {
      if (queries.length >= maxQueries) break;
      addQuery(`${tc} team`, 'web_search', tc);
      addQuery(`site:linkedin.com/in ${tc}`, 'web_search', tc);

      // Persona-specific
      for (const persona of (intent.preferredPersonas || [])) {
        addQuery(`${tc} ${persona}`, 'web_search', `${tc} ${persona}`);
      }

      // Affinity queries
      for (const aff of affiliations) {
        if (queries.length >= maxQueries) break;
        if (aff.status !== 'confirmed') continue;
        if (aff.type === 'school' || aff.type === 'employer' || aff.type === 'community') {
          addQuery(`"${aff.normalizedOrganization}" "${tc}"`, 'web_search', `${aff.type}:${aff.normalizedOrganization} → ${tc}`);
        }
      }
    }

    // If no target companies, still query from affiliations
    if (targetCompanies.length === 0) {
      for (const aff of affiliations) {
        if (queries.length >= maxQueries) break;
        if (aff.status !== 'confirmed') continue;
        addQuery(`${aff.organization} ${aff.roleOrProgram ? aff.roleOrProgram + ' alumni' : 'alumni'} network`, 'web_search', aff.organization);
      }
    }
  }

  // Ensure at least one query
  if (queries.length === 0) {
    // Fallback: generic query from company/role
    if (company) {
      addQuery(`${company} ${role || 'team'}`, 'web_search', company);
    }
  }

  saveRunState(s, state.runId, {
    ...state,
    plannedQueries: queries,
    completedNodes: [...(state.completedNodes || []), 'plan_queries']
  });

  return {
    ...state,
    plannedQueries: queries,
    nextNode: 'collect_sources',
    completedNodes: [...(state.completedNodes || []), 'plan_queries']
  };
}

// ---- Collect sources node ----

async function collectSourcesNode(s, state, signal, env = process.env, fetchImpl = globalThis.fetch) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const budget = state.budget || {};
  const usage = { queries: 0, sourceChars: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, paidToolCalls: 0, estimatedUsd: 0, ...(state.usage || {}) };
  const warnings = [...(state.warnings || [])];
  let allObservations = [];
  let personHints = [...(state.personHints || [])];
  let anySuccess = false;
  let anyRetryable = false;
  let anyNonRetryable = false;

  // Map standard source names to adapter names; passthrough unknown names for custom/testing adapters
  const sourceMappings = {
    local_network: 'local-network',
    linkedin_import: 'linkedin-import',
    public_web: 'public-web',
    github: 'github',
    gdelt: 'gdelt',
    wayback: 'wayback',
    xai: 'xai'
  };
  const adapterNames = (state.sources || [])
    .map(s => sourceMappings[s] || s)
    .filter(Boolean);
  const uniqueAdapterNames = [...new Set(adapterNames)];
  let adapters = getAdapters(uniqueAdapterNames);

  const edgeRows = all(s, `SELECT re.*,p.name AS person_name,p.primary_profile_url AS person_url
    FROM relationship_edges re
    LEFT JOIN people p ON re.to_type='person' AND p.id=re.to_id
    WHERE (re.from_type='profile' AND re.from_id=?) OR (re.to_type='profile' AND re.to_id=?)
    ORDER BY re.created_at`, [state.profileId, state.profileId]);
  const networkEdges = edgeRows.map(edge => ({
    id: edge.id,
    fromType: edge.from_type,
    fromId: edge.from_id,
    toType: edge.to_type,
    toId: edge.to_id,
    edgeType: edge.edge_type,
    evidence: parseJson(edge.evidence_json, []),
    confidence: edge.confidence,
    personId: edge.to_type === 'person' ? edge.to_id : edge.from_type === 'person' ? edge.from_id : null,
    personName: edge.person_name || '',
    personUrl: edge.person_url || ''
  }));
  const connectedPersonIds = new Set(networkEdges.map(edge => edge.personId).filter(Boolean));
  const contactRows = all(s, `SELECT cp.*,p.name AS person_name FROM contact_points cp
    LEFT JOIN people p ON p.id=cp.person_id WHERE cp.person_id IS NOT NULL AND cp.person_id!=''`);
  const networkContacts = contactRows.filter(contact => connectedPersonIds.has(contact.person_id)).map(contact => ({
    id: contact.id,
    personId: contact.person_id,
    stakeholderId: contact.stakeholder_id || null,
    personName: contact.person_name || '',
    type: contact.type,
    value: contact.value,
    evidenceTier: contact.evidence_tier,
    verificationStatus: contact.verification_status,
    confidence: contact.confidence,
    humanApproved: Boolean(contact.human_approved),
    doNotUse: Boolean(contact.do_not_use)
  }));
  const connections = [];
  for (const personId of connectedPersonIds) {
    const person = one(s, 'SELECT * FROM people WHERE id=?', [personId]);
    if (!person) continue;
    const contacts = contactRows.filter(contact => contact.person_id === personId && contact.evidence_tier === 'U');
    if (!contacts.length) continue;
    const employer = one(s, `SELECT * FROM person_affiliations WHERE person_id=? AND type='employer' ORDER BY updated_at DESC LIMIT 1`, [personId]);
    connections.push({
      id: personId,
      personId,
      name: person.name,
      url: contacts.find(contact => contact.type === 'profile_url')?.value || person.primary_profile_url || '',
      email: contacts.find(contact => contact.type === 'email')?.value || '',
      company: employer?.organization || '',
      position: employer?.role_or_program || ''
    });
  }
  const plan = {
    queries: (state.plannedQueries || []).map(item => typeof item === 'string' ? item : item?.query).filter(Boolean),
    depth: state.depth,
    localNetwork: { edges: networkEdges, contacts: networkContacts },
    linkedinImport: { connections }
  };

  const context = {
    runId: state.runId,
    scope: state.scope,
    profileId: state.profileId,
    jobId: state.jobId || null,
    companyId: state.companyId || null,
    companyName: state.companyName || '',
    role: state.role || '',
    personId: state.personId || null,
    person: state.person || null,
    confirmedAffiliations: state.confirmedAffiliations || [],
    networkIntent: state.networkIntent || null
  };
  const reusedObservationIds = [];
  const cacheableSources = (state.sources || []).filter(source => !['local_network', 'linkedin_import'].includes(source));
  if (!state.refresh && cacheableSources.length) {
    const previous = one(s, `SELECT id FROM research_runs
      WHERE id!=? AND profile_id=? AND scope=? AND COALESCE(job_id,'')=? AND company_name=? AND role=?
        AND COALESCE(person_id,'')=? AND depth=? AND sources_json=? AND status IN ('succeeded','partial')
      ORDER BY COALESCE(finished_at,updated_at) DESC LIMIT 1`, [
      state.runId,
      state.profileId,
      state.scope,
      state.jobId || '',
      state.companyName || '',
      state.role || '',
      state.personId || '',
      state.depth,
      JSON.stringify(state.sources || [])
    ]);
    if (previous) {
      const rows = all(s, `SELECT so.* FROM source_observations so
        JOIN research_run_sources rrs ON rrs.source_observation_id=so.id
        WHERE rrs.run_id=? AND so.provider NOT IN ('local-network','linkedin-import')`, [previous.id]);
      const currentTime = Date.now();
      const freshRows = rows.filter(row => {
        const age = currentTime - Date.parse(row.fetched_at);
        const ttl = row.provider === 'xai' || row.source_type === 'x_search'
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
        return Number.isFinite(age) && age >= 0 && age <= ttl;
      });
      if (freshRows.length && freshRows.length === rows.length) {
        reusedObservationIds.push(...freshRows.map(row => row.id));
        const candidates = all(s, `SELECT pc.*,p.name AS person_name,p.primary_profile_url
          FROM person_candidates pc LEFT JOIN people p ON p.id=pc.person_id
          WHERE pc.research_run_id=? ORDER BY pc.created_at`, [previous.id]);
        for (const candidate of candidates) {
          personHints.push({
            name: candidate.person_name || candidate.name,
            profileUrl: candidate.primary_profile_url || '',
            company: state.companyName || '',
            role: candidate.role || '',
            confidence: candidate.confidence || 'medium',
            source: 'cache',
            sourceObservationIds: parseJson(candidate.source_observation_ids_json, [])
          });
        }
        adapters = adapters.filter(adapter => ['local-network', 'linkedin-import'].includes(adapter.name));
        anySuccess = true;
        warnings.push(`cache_reused: ${freshRows.length} source observation(s) from ${previous.id}`);
      }
    }
  }

  // Run adapters with concurrency 3
  const concurrency = 3;
  let deadlineHit = false;
  let budgetHit = false;

  for (let i = 0; i < adapters.length; i += concurrency) {
    if (signal?.aborted) {
      const stopped = checkCancelled(s, state.runId, state, signal);
      if (stopped?.status === 'cancelled') return stopped;
      warnings.push(...(stopped?.warnings || []).filter(warning => !warnings.includes(warning)));
      deadlineHit = true;
      break;
    }

    const candidateBatch = adapters.slice(i, i + concurrency);
    const usesQuery = adapter => !['local-network', 'linkedin-import'].includes(adapter.name);
    const queryRemaining = Math.max(0, (budget.maxQueries ?? Infinity) - (usage.queries || 0));
    const sourceCharsRemaining = Math.max(0, (budget.maxSourceChars ?? Infinity) - (usage.sourceChars || 0));
    const modelCallsRemaining = Math.max(0, (budget.maxModelCalls ?? Infinity) - (usage.modelCalls || 0));
    const paidCallsRemaining = Math.max(0, (budget.maxPaidToolCalls ?? Infinity) - (usage.paidToolCalls || 0));
    const costRemaining = budget.maxCostUsd == null
      ? null
      : Math.max(0, budget.maxCostUsd - (usage.estimatedUsd || 0));
    const runnable = candidateBatch.filter(adapter => {
      const exhausted = (usesQuery(adapter) && (queryRemaining <= 0 || sourceCharsRemaining <= 0))
        || (adapter.name === 'xai' && (modelCallsRemaining <= 0 || paidCallsRemaining <= 0 || costRemaining === 0));
      if (exhausted) {
        budgetHit = true;
        warnings.push(`budget_exhausted: skipped ${adapter.name}`);
      }
      return !exhausted;
    });
    if (!runnable.length) continue;

    let querySlots = runnable.filter(usesQuery).length;
    let sourceSlots = querySlots;
    let queriesLeft = queryRemaining;
    let sourceCharsLeft = sourceCharsRemaining;
    const batch = runnable.map(adapter => {
      const adapterBudget = { ...budget };
      if (usesQuery(adapter)) {
        const queryShare = Number.isFinite(queriesLeft) ? Math.ceil(queriesLeft / querySlots) : budget.maxQueries;
        const sourceShare = Number.isFinite(sourceCharsLeft) ? Math.ceil(sourceCharsLeft / sourceSlots) : budget.maxSourceChars;
        adapterBudget.maxQueries = queryShare;
        adapterBudget.maxSourceChars = sourceShare;
        if (Number.isFinite(queriesLeft)) queriesLeft -= queryShare;
        if (Number.isFinite(sourceCharsLeft)) sourceCharsLeft -= sourceShare;
        querySlots--;
        sourceSlots--;
      }
      if (adapter.name === 'xai') {
        adapterBudget.maxModelCalls = modelCallsRemaining;
        adapterBudget.maxPaidToolCalls = paidCallsRemaining;
        adapterBudget.maxCostUsd = costRemaining;
      }
      return { adapter, budget: adapterBudget };
    });
    const settled = await Promise.allSettled(
      batch.map(entry => entry.adapter.run({ context, plan, budget: entry.budget, signal, env, fetchImpl }))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = settled[j];
      const name = batch[j]?.adapter?.name || 'unknown';

      if (result.status === 'fulfilled') {
        const value = result.value;
        const failureWarnings = (value.warnings || []).filter(warning =>
          /fail|error|no data|no citations|no usage|unavailable|misconfigured/i.test(warning)
        );
        if (failureWarnings.length === 0) {
          anySuccess = true;
        } else {
          const retryableFailure = failureWarnings.every(warning =>
            /timeout|temporar|network|fetch|request failed|http 5|unavailable/i.test(warning)
          );
          if (retryableFailure) anyRetryable = true;
          else anyNonRetryable = true;
        }

        if (value.observations?.length) allObservations.push(...value.observations);
        if (value.personHints?.length) personHints.push(...value.personHints);
        if (value.usage) {
          usage.queries = (usage.queries || 0) + (value.usage.queries || 0);
          usage.sourceChars = (usage.sourceChars || 0) + (value.usage.sourceChars || 0);
          usage.modelCalls = (usage.modelCalls || 0) + (value.usage.modelCalls || 0);
          usage.inputTokens = (usage.inputTokens || 0) + (value.usage.inputTokens || 0);
          usage.outputTokens = (usage.outputTokens || 0) + (value.usage.outputTokens || 0);
          usage.paidToolCalls = (usage.paidToolCalls || 0) + (value.usage.paidToolCalls || 0);
          if (value.usage.estimatedUsd == null && ((value.usage.modelCalls || 0) > 0 || (value.usage.paidToolCalls || 0) > 0)) {
            usage.estimatedUsd = null;
          } else if (usage.estimatedUsd != null && Number.isFinite(value.usage.estimatedUsd)) {
            usage.estimatedUsd += value.usage.estimatedUsd;
          }
        }
        if (value.warnings?.length) {
          warnings.push(...value.warnings.map(w => `${name}: ${w}`));
        }
      } else {
        const errMsg = result.reason?.message || String(result.reason || 'Unknown adapter error');
        warnings.push(`${name} adapter failed: ${errMsg}`);
        if (result.reason?.retryable || result.reason?.code === 'timeout') anyRetryable = true;
        else anyNonRetryable = true;
      }
    }
    if (signal?.aborted) {
      const stopped = checkCancelled(s, state.runId, state, signal);
      if (stopped?.status === 'cancelled') return stopped;
      warnings.push(...(stopped?.warnings || []).filter(warning => !warnings.includes(warning)));
      deadlineHit = true;
    }
  }
  const requestedCancellation = checkCancelled(s, state.runId, state, signal);
  if (requestedCancellation) return requestedCancellation;

  // No adapters to run
  if (adapters.length === 0 && !anySuccess) {
    warnings.push('No adapters matched requested sources — run will have no source observations');
    const cpCompleted = [...(state.completedNodes || []), 'collect_sources'];
    saveRunState(s, state.runId, { ...state, usage, warnings, personHints, completedNodes: cpCompleted });
    return { ...state, usage, warnings, personHints, nextNode: 'persist_outputs', completedNodes: cpCompleted };
  }


  // At least one adapter succeeded — save observations
  const observationIds = [...new Set([...(state.observationIds || []), ...reusedObservationIds])];
  if (allObservations.length > 0) {
    const seen = new Set(observationIds);
    for (const obs of allObservations) {
      // Allow empty URL — local observations use a local identifier
      const obsUrl = obs.url || obs.localId || '';
      const canonical = obs.canonicalUrl || (obsUrl ? canonicalUrl(obsUrl) : '');
      const obsId = obs.id || id('src', `${state.runId}:${canonical || obs.localId || 'local'}:${obs.provider || 'unknown'}:${obs.query || ''}`);
      if (!seen.has(obsId)) {
        try {
          saveSourceObservation(s, { ...obs, id: obsId, url: obsUrl, canonicalUrl: canonical || obsUrl, companyId: obs.companyId || null, jobId: obs.jobId || state.jobId || null });
          seen.add(obsId);
          observationIds.push(obsId);
        } catch (e) {
          warnings.push(`Failed to save observation ${obsId}: ${e?.message || String(e)}`);
        }
      }
    }
  }
  linkRunSources(s, state.runId, observationIds);

  // Apply exclusions and maxCandidates cap
  const exclusions = state.networkIntent?.exclusions || [];
  const dedupedHints = [];
  const seenHints = new Set();
  for (const hint of applyExclusions(personHints, exclusions)) {
    const key = hint.profileUrl
      ? `url:${canonicalUrl(hint.profileUrl)}`
      : hint.email
        ? `email:${normalizeEmail(hint.email)}`
        : `source:${hint.sourceObservationId || (hint.sourceObservationIds || []).join(',')}`;
    if (seenHints.has(key)) continue;
    seenHints.add(key);
    dedupedHints.push(hint);
  }
  const maxCandidates = budget.maxCandidates ?? 50;
  const filteredHints = dedupedHints.slice(0, maxCandidates);

  const hasEvidence = observationIds.length > 0 || filteredHints.length > 0;
  let status = state.status;
  let error = '';
  let nextNode = 'resolve_people';
  if (deadlineHit) {
    status = 'partial';
    nextNode = 'persist_outputs';
  } else if (budgetHit && !anySuccess && !hasEvidence) {
    status = 'partial';
    nextNode = 'persist_outputs';
  } else if (!anySuccess && hasEvidence) {
    status = 'partial';
  } else if (!anySuccess && anyRetryable && !anyNonRetryable) {
    status = 'paused_retryable';
    error = 'All adapters failed with retryable errors';
    nextNode = 'collect_sources';
  } else if (!anySuccess) {
    status = 'failed';
    error = 'All adapters failed with non-retryable errors';
    nextNode = null;
  } else if (anySuccess && (anyRetryable || anyNonRetryable)) {
    status = 'partial';
  } else if (budgetHit) {
    status = 'partial';
  }

  const cpCompleted = [...(state.completedNodes || []), 'collect_sources'];
  const resultState = { ...state, status, error, usage, warnings, observationIds, personHints: filteredHints, nextNode, completedNodes: cpCompleted };
  saveRunState(s, state.runId, resultState);
  return resultState;
}

// ---- Resolve people node ----

function resolvePeopleNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const personHints = state.personHints || [];
  const observationIds = state.observationIds || [];
  const warnings = [...(state.warnings || [])];
  const resolvedPeople = [];
  const personIds = [...(state.personIds || [])];

  for (const hint of personHints) {
    if (!hint?.name) continue;
    try {
      // resolvePerson returns {person, created} or null
      const hintObservationIds = [
        ...(hint.sourceObservationIds || []),
        ...(hint.evidenceObservationIds || []),
        hint.sourceObservationId
      ].filter(Boolean);
      const result = resolvePerson(s, {
        profileUrl: hint.profileUrl || '',
        email: hint.email || '',
        name: hint.name,
        sourceRecordId: hintObservationIds[0] || `${state.runId}:${hint.profileUrl || hint.name}`
      });
      if (!result?.person) continue;
      const person = result.person;
      const uniqueObsIds = [...new Set(hintObservationIds)];

      // Create/update person_candidate linked to this run
      const cid = id('candidate', `${state.runId}:${person.id}`);
      const at = now();
      run(s, `INSERT OR IGNORE INTO person_candidates
        (id,job_id,company_id,name,role,function,seniority,relevance,confidence,source_observation_ids_json,status,suppression_reason,created_at,updated_at,person_id,research_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        cid,
        state.jobId || null,
        state.companyId || null,
        person.name || hint.name,
        hint.role || '',
        '',
        '',
        hint.roleRelevance || 'medium',
        hint.confidence || 'medium',
        JSON.stringify(uniqueObsIds),
        'candidate',
        '',
        at, at,
        person.id,
        state.runId
      ]);

      if (!personIds.includes(person.id)) personIds.push(person.id);

      resolvedPeople.push({
        personId: person.id,
        name: person.name,
        profileUrl: person.primaryProfileUrl || hint.profileUrl || '',
        company: hint.company || '',
        role: hint.role || '',
        confidence: hint.confidence || 'medium',
        source: hint.source || '',
        sourceObservationIds: uniqueObsIds,
        evidenceObservationIds: uniqueObsIds,
        relationshipType: hint.relationshipType || hint.edgeType || '',
        sharedAffiliation: hint.sharedAffiliation || '',
        freshnessDays: hint.freshnessDays,
        roleRelevance: hint.roleRelevance || 'medium'
      });
    } catch (err) {
      warnings.push(`Failed to resolve person ${hint.name}: ${err.message}`);
    }
  }

  // Strip raw emails from resolved people before checkpoint (PII safety)
  const cleanPeople = resolvedPeople.map(p => {
    const cleaned = { ...p };
    delete cleaned.email;
    return cleaned;
  });

  const cpCompleted = [...(state.completedNodes || []), 'resolve_people'];
  saveRunState(s, state.runId, {
    ...state, warnings, personIds,
    completedNodes: cpCompleted
  });

  return {
    ...state,
    personHints: cleanPeople,
    personIds,
    warnings,
    nextNode: 'verify_contacts',
    completedNodes: cpCompleted
  };
}

// ---- Verify contacts node ----

async function verifyContactsNode(s, state, signal, env = process.env) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const personHints = state.personHints || [];
  const contactIds = [...(state.contactIds || [])];
  const warnings = [...(state.warnings || [])];

  for (const hint of personHints) {
    if (!hint.personId) continue;
    const isUserImported = ['linkedin_import', 'local_network_edge', 'local_network_contact'].includes(hint.source);
    const evidenceTier = isUserImported ? 'U' : 'E';
    const verificationStatus = isUserImported ? 'user_imported' : 'external_public';

    if (hint.profileUrl) {
      const evidenceIds = hint.evidenceObservationIds || hint.sourceObservationIds || [];
      try {
        const contact = upsertContactPoint(s, {
          personId: hint.personId,
          companyId: state.companyId || null,
          type: 'profile_url',
          value: hint.profileUrl,
          evidenceTier,
          verificationStatus,
          confidence: hint.confidence || 'medium',
          sourceObservationIds: evidenceIds,
          checks: { fetched: false },
          originResearchRunId: state.runId
        });
        if (contact?.id) contactIds.push(contact.id);
      } catch (e) {
        warnings.push(`Failed to save contact point for ${hint.name}: ${e.message}`);
      }
    }
  }

  try {
    const verified = await verifyObservationContacts(s, {
      runId: state.runId,
      jobId: state.jobId || null,
      companyId: state.companyId || null,
      observationIds: state.observationIds || [],
      env
    });
    contactIds.push(...verified.contactIds);
  } catch (error) {
    warnings.push(`Contact verification failed: ${error.message}`);
  }

  const cpCompleted = [...(state.completedNodes || []), 'verify_contacts'];
  saveRunState(s, state.runId, {
    ...state, contactIds, warnings,
    completedNodes: cpCompleted
  });

  return {
    ...state, contactIds, warnings,
    nextNode: 'rank_paths',
    completedNodes: cpCompleted
  };
}

// ---- Rank paths node ----

function rankPathsNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const personHints = state.personHints || [];
  const warnings = [...(state.warnings || [])];
  const exclusions = state.networkIntent?.exclusions || [];

  // Apply exclusions again (should already be done but defend against new hints)
  const ranked = applyExclusions(personHints, exclusions).map(hint => ({
    ...hint,
    priorityScore: computePriorityScore(hint, state)
  }));

  // Sort by priority score descending
  ranked.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  // Store ranking info in warnings (for observability, not as persistent rankings)
  if (ranked.length) {
    const top = ranked.slice(0, 3);
    for (const r of top) {
      warnings.push(`Ranked: ${r.name}${r.company ? ` @${r.company}` : ''} — priority ${r.priorityScore}`);
    }
  }

  saveRunState(s, state.runId, {
    ...state,
    personHints: ranked,
    warnings,
    completedNodes: [...(state.completedNodes || []), 'rank_paths']
  });

  return {
    ...state,
    personHints: ranked,
    warnings,
    nextNode: 'persist_outputs',
    completedNodes: [...(state.completedNodes || []), 'rank_paths']
  };
}

// ---- Persist outputs node ----

function persistOutputsNode(s, state, signal) {
  const cancelled = checkCancelled(s, state.runId, state, signal);
  if (cancelled) return cancelled;

  const usage = state.usage || {};
  const warnings = [...(state.warnings || [])];

  // Determine final status
  let finalStatus = state.status === 'partial' ? 'partial' : 'succeeded';
  if (state.status === 'failed' || state.error) {
    finalStatus = state.error && /retryable/i.test(state.error) ? 'paused_retryable' : 'failed';
  } else if (state.status === 'cancelled') {
    finalStatus = 'cancelled';
  } else if (warnings.some(warning => /budget[_ ]exhausted|adapter failed/i.test(warning))) {
    finalStatus = 'partial';
  }

  // Write mirrors (done here as final persistence, also done by caller)
  try {
    writeRunMirrors(s, state.runId, { ...state, status: finalStatus, warnings });

    if (state.scope === 'profile') {
      writeProfileNetworkMap(s, state.runId, { ...state, status: finalStatus, warnings });
    }

    if (state.scope === 'job' && state.jobId) {
      writeJobRunMirrors(s, state.runId, { ...state, status: finalStatus, warnings });
    }
  } catch (err) {
    warnings.push(`Failed to write workspace mirrors: ${err.message}`);
  }

  const completedNodes = [...(state.completedNodes || []), 'persist_outputs'];

  saveRunState(s, state.runId, {
    ...state,
    status: finalStatus,
    warnings,
    completedNodes
  });

  return {
    ...state,
    status: finalStatus,
    warnings,
    nextNode: null,
    completedNodes
  };
}

// ---- Build and run graph ----

export async function runGraph(s, initialState, { signal, env = process.env, fetchImpl = globalThis.fetch, deadlineAt } = {}) {
  const state = { ...initialState };

  // Create the graph
  const graph = new StateGraph(ResearchState);

  // Add all nodes — pass env/fetchImpl/deadlineAt to each
  graph.addNode('validate', async (st) => validateNode(s, st, signal, env, fetchImpl));
  graph.addNode('hydrate_context', async (st) => hydrateContextNode(s, st, signal, env, fetchImpl));
  graph.addNode('plan_queries', async (st) => planQueriesNode(s, st, signal, env, fetchImpl));
  graph.addNode('collect_sources', async (st) => collectSourcesNode(s, st, signal, env, fetchImpl));
  graph.addNode('resolve_people', async (st) => resolvePeopleNode(s, st, signal, env, fetchImpl));
  graph.addNode('verify_contacts', async (st) => verifyContactsNode(s, st, signal, env, fetchImpl));
  graph.addNode('rank_paths', async (st) => rankPathsNode(s, st, signal, env, fetchImpl));
  graph.addNode('persist_outputs', async (st) => persistOutputsNode(s, st, signal, env, fetchImpl));

  // Route from START to the next uncompleted node
  graph.addConditionalEdges(START, (st) => st.nextNode || END);

  // Route from each node to the next, or END
  for (const nodeName of NODE_ORDER) {
    graph.addConditionalEdges(nodeName, (st) => {
      if (st.status === 'paused_retryable') return END;
      if (st.nextNode && NODE_INDEX[st.nextNode] !== undefined) return st.nextNode;
      return END;
    });
  }

  // Compile and invoke
  const app = graph.compile();
  return app.invoke(state);
}
