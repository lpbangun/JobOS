import { one, all, run, save, audit } from './db.js';
import { parseJson, tokenize, redFlags, now } from './utils.js';
import { syncJob } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';
import { listProofs } from './profiles.js';

const dimensionKeys = ['roleFit', 'domainFit', 'seniority', 'locationWorkModel', 'compensation', 'missionInterest', 'networkAccess', 'redFlags'];

function overlap(jobTokens, wanted, base = 50) {
  const w = [...new Set(wanted.filter(Boolean))];
  if (!w.length) return { score: base, hits: [], reason: 'No explicit preferences set; neutral degraded-mode score.' };
  const set = new Set(jobTokens), hits = w.filter(t => set.has(t));
  return { score: Math.min(100, Math.round(base + (hits.length / w.length) * 60)), hits, reason: hits.length ? `Matched ${hits.join(', ')} in deterministic degraded mode.` : 'No direct keyword match found in deterministic degraded mode.' };
}

function deterministicScore(job, prof, proofs) {
  const prefs = parseJson(prof.preferences_json, {}), text = `${job.title}\n${job.company}\n${job.location}\n${job.description}`, toks = tokenize(text);
  const role = overlap(toks, tokenize([prof.name, ...(prefs.targetRoleFamilies || []), ...(prefs.skills || [])].join(' ')), 35);
  const domain = overlap(toks, tokenize([...(prefs.industries || []), ...(prefs.missionKeywords || []), ...(prefs.values || [])].join(' ')), 45);
  const loc = overlap(toks, tokenize([...(prefs.locations || []), prefs.workModel || ''].join(' ')), 50);
  const mission = overlap(toks, tokenize([...(prefs.missionKeywords || []), ...(prefs.values || [])].join(' ')), 45);
  const proofHitCount = proofs.flatMap(p => tokenize(`${p.summary} ${(p.skills || []).join(' ')}`)).filter(t => toks.includes(t)).length;
  const proofBoost = Math.min(12, proofHitCount * 2);
  const lower = text.toLowerCase(), pLower = `${prof.name} ${JSON.stringify(prefs)}`.toLowerCase();
  const senior = ['senior', 'staff', 'principal', 'lead', 'head of', 'director'].some(t => lower.includes(t)), pSenior = ['senior', 'staff', 'principal', 'lead', 'head of', 'director'].some(t => pLower.includes(t));
  let seniority = { score: 70, reason: 'No strong seniority mismatch detected. This degraded-mode score should be replaced by LLM reasoning when credentials are configured.' };
  if (senior && !pSenior) seniority = { score: 55, reason: 'Job appears senior while the profile does not explicitly target senior roles. Human review should confirm level fit.' };
  if (senior && pSenior) seniority = { score: 85, reason: 'Seniority language aligns with profile targets. Human review should still confirm scope and reporting line.' };
  const comp = /\$|salary|compensation|base pay|k\b|benefits/i.test(text) ? { score: 75, reason: 'Compensation or benefits language found. The candidate should still compare it against their salary band.' } : { score: 50, reason: 'No compensation data found. Treat this as an uncertainty until manually verified.' };
  const flags = redFlags.filter(t => lower.includes(t));
  const preferenceSignals = role.hits.length + domain.hits.length + loc.hits.length + mission.hits.length;
  const preferenceAlignment = preferenceSignals >= 2 ? 8 : (preferenceSignals === 1 ? 4 : 0);
  const transferableEvidence = proofHitCount >= 3 ? 4 : 0;
  const profileText = `${prof.name} ${JSON.stringify(prefs)} ${proofs.map(p => `${p.summary} ${(p.skills || []).join(' ')}`).join(' ')}`.toLowerCase();
  const decisiveRoleText = `${job.title}\n${parseJson(job.requirements_json, []).join('\n')}`;
  const outsideRequestedTrack = /\b(backend|infrastructure|payments engineer|enterprise account executive|quota|salesforce|cold outbound|closing deals)\b/i.test(decisiveRoleText)
    && !/\b(backend|infrastructure|payments|engineer|developer|software|salesforce|sales|account executive|quota|business development)\b/i.test(profileText);
  const weakFitPenalty = outsideRequestedTrack ? 18 : (preferenceSignals === 0 && proofHitCount < 2 ? 18 : 0);
  const heuristicAdjustment = preferenceAlignment + transferableEvidence - weakFitPenalty;
  const overall = Math.max(0, Math.min(100, Math.round(role.score * .28 + domain.score * .18 + seniority.score * .14 + loc.score * .12 + comp.score * .08 + mission.score * .14 + proofBoost + heuristicAdjustment - (flags.length * 12))));
  return {
    overall,
    confidence: job.description.length > 800 ? 'medium' : 'low',
    mode: 'deterministic-degraded',
    dimensions: {
      roleFit: { score: role.score, reason: `${role.reason} This is a fallback and not a substitute for LLM judgment.` },
      domainFit: { score: domain.score, reason: `${domain.reason} This is a fallback and may miss transferable domain signals.` },
      seniority,
      locationWorkModel: { score: loc.score, reason: `${loc.reason} Confirm location and work model manually.` },
      compensation: comp,
      missionInterest: { score: mission.score, reason: `${mission.reason} Mission fit should be confirmed with company research.` },
      networkAccess: { score: 50, reason: 'No stakeholder or network evidence has been researched yet. This remains neutral until Sprint 3 research is available.' },
      redFlags: { score: flags.length ? 35 : 90, reason: flags.length ? `Detected red-flag language: ${flags.join(', ')}. Investigate before proceeding.` : 'No configured red-flag terms were found. This does not replace diligence.' }
    },
    redFlags: flags,
    reasoning: 'Deterministic degraded scoring used because provider-backed LLM scoring was unavailable. Configure JOBOS_LLM_PROVIDER, JOBOS_LLM_MODEL, and JOBOS_LLM_API_KEY for structured LLM reasoning.'
  };
}

function clamp(n, fallback = 50) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function normalizeScore(raw, job, profileId, cfg, fallback) {
  const hasValidShape = raw && Number.isFinite(Number(raw.overall)) && raw.dimensions && dimensionKeys.every(key => raw.dimensions[key] && Number.isFinite(Number(raw.dimensions[key].score)) && raw.dimensions[key].reason);
  if (!hasValidShape) {
    return { ...fallback, jobId: job.id, profileId, llm: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl }, llmError: 'Malformed LLM score output; used deterministic fallback.', reasoning: `${fallback.reasoning} LLM score output was malformed, so JobOS used deterministic fallback instead.`, generatedAt: now() };
  }
  const dimensions = {};
  for (const key of dimensionKeys) {
    const source = raw?.dimensions?.[key] || fallback.dimensions[key];
    dimensions[key] = { score: clamp(source?.score, fallback.dimensions[key]?.score), reason: String(source?.reason || fallback.dimensions[key]?.reason || 'No reasoning supplied.') };
  }
  return {
    jobId: job.id,
    profileId,
    overall: clamp(raw?.overall, fallback.overall),
    confidence: ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : fallback.confidence,
    mode: cfg.provider === 'agent' ? 'agent' : 'llm',
    llm: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl },
    dimensions,
    redFlags: Array.isArray(raw?.redFlags) ? raw.redFlags.map(String) : fallback.redFlags,
    reasoning: String(raw?.reasoning || 'Provider-backed LLM generated this structured fit score from the profile, proof points, and job description.'),
    generatedAt: now()
  };
}

export function networkAccessFromEvidence(s, { jobId, profileId }) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const runRow = one(s, `SELECT id,finished_at FROM research_runs WHERE job_id=? AND profile_id=? AND scope='job' AND status IN ('succeeded','partial') ORDER BY finished_at DESC LIMIT 1`,
    [jobId, profileId]);
  if (!runRow) {
    return { score: 50, reason: 'No verified network evidence. No people-research run has been completed for this job.' };
  }
  const fresh = runRow.finished_at && runRow.finished_at >= cutoff;
  const freshLabel = fresh ? 'Fresh' : 'Stale';
  const prefix = fresh ? '' : `Stale evidence (research run ${runRow.id} completed ${runRow.finished_at}). `;

  // Check for direct connections to stakeholders at this job
  const direct = one(s, `SELECT 1 FROM relationship_edges WHERE edge_type='direct_connection' AND to_id IN (
    SELECT id FROM stakeholders WHERE job_id=? UNION SELECT person_id FROM stakeholders WHERE job_id=? AND person_id IS NOT NULL
    UNION SELECT id FROM person_candidates WHERE job_id=? UNION SELECT person_id FROM person_candidates WHERE job_id=? AND person_id IS NOT NULL
  ) LIMIT 1`, [jobId, jobId, jobId, jobId]);
  if (direct) {
    return { score: fresh ? 90 : 80, reason: `${prefix}Direct network connection to a stakeholder at this company. ${freshLabel} evidence supports network access.` };
  }

  // Check for mutual affiliations (shared employer, school, community, event, open source)
  const mutual = one(s, `SELECT 1 FROM relationship_edges WHERE edge_type IN ('shared_employer','shared_school','shared_open_source','shared_event') AND to_id IN (
    SELECT id FROM stakeholders WHERE job_id=? UNION SELECT person_id FROM stakeholders WHERE job_id=? AND person_id IS NOT NULL
    UNION SELECT id FROM person_candidates WHERE job_id=? UNION SELECT person_id FROM person_candidates WHERE job_id=? AND person_id IS NOT NULL
  ) LIMIT 1`, [jobId, jobId, jobId, jobId]);
  if (mutual) {
    return { score: fresh ? 80 : 70, reason: `${prefix}Mutual affiliation (shared employer, school, or community) found with a stakeholder at this company. ${freshLabel} evidence suggests network access.` };
  }

  // Check for approved contact points linked to stakeholders
  const approvedContact = one(s, `SELECT 1 FROM contact_points WHERE human_approved=1 AND do_not_use=0 AND (
    stakeholder_id IN (SELECT id FROM stakeholders WHERE job_id=?)
    OR person_id IN (SELECT person_id FROM stakeholders WHERE job_id=? AND person_id IS NOT NULL)
    OR person_id IN (SELECT person_id FROM person_candidates WHERE job_id=? AND person_id IS NOT NULL)
  ) LIMIT 1`, [jobId, jobId, jobId]);
  if (approvedContact) {
    return { score: fresh ? 70 : 60, reason: `${prefix}Approved contact point exists for a stakeholder at this company. ${freshLabel} evidence supports potential network access.` };
  }

  // Research run completed but no specific network path found — generic company awareness
  return { score: fresh ? 60 : 50, reason: `${prefix}People research completed but no direct or mutual connection found. ${freshLabel} evidence provides generic company awareness.` };
}

function scoringPrompt({ job, prof, proofs }) {
  const prefs = parseJson(prof.preferences_json, {});
  return `Score this job for the candidate. Use the candidate profile, preferences, proof points, and job description. Do not use keyword counting. Return JSON with: overall number 0-100, confidence low|medium|high, dimensions.roleFit/domainFit/seniority/locationWorkModel/compensation/missionInterest/networkAccess/redFlags each {score, reason}, redFlags array, reasoning string. Each dimension reason must be 2-3 sentences.\n\nPROFILE:\n${JSON.stringify({ id: prof.id, name: prof.name, preferences: prefs }, null, 2)}\n\nPROOF POINTS:\n${JSON.stringify(proofs, null, 2)}\n\nJOB:\n${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, requirements: parseJson(job.requirements_json, []) }, null, 2)}`;
}

export async function score(s, jid, pid) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (!prof) throw Error(`Unknown profile: ${pid}`);
  if (job.profile_id !== pid) throw Object.assign(new Error(`Job ${jid} belongs to profile ${job.profile_id}, not ${pid}`), { code: 'profile_job_mismatch', type: 'validation' });
  const proofs = listProofs(s, pid);
  const fallback = deterministicScore(job, prof, proofs);
  const cfg = llmConfig();
  let out = { ...fallback, jobId: jid, profileId: pid, llm: cfg, generatedAt: now() };
  if (cfg.configured) {
    try {
      const result = await generateJson({
        schemaName: 'jobos_fit_score',
        system: 'You are JobOS fit scoring. Produce evidence-aware, explainable fit scoring for a job seeker. Be honest about mismatches and uncertainty.',
        user: scoringPrompt({ job, prof, proofs })
      });
      if (result.ok) out = normalizeScore(result.json, job, pid, result.config, fallback);
    } catch (e) {
      if (e?.type === 'agent_error') throw e;
      out = { ...out, llmError: e.message, reasoning: `${out.reasoning} LLM call failed: ${e.message}` };
    }
  }
  // Override networkAccess with evidence from people-research runs
  out.dimensions.networkAccess = networkAccessFromEvidence(s, { jobId: jid, profileId: pid });
  run(s, 'UPDATE jobs SET fit_score=?, score_json=?, updated_at=? WHERE id=?', [out.overall, JSON.stringify(out), now(), jid]);
  audit(s, 'job.scored', 'job', jid, { jobId: jid, profileId: pid, overall: out.overall, mode: out.mode });
  syncJob(s, jid);
  save(s);
  return out;
}

export function scoreMd(job, sc) {
  const dims = Object.entries(sc.dimensions).map(([k, v]) => `- **${k}:** ${v.score}/100 — ${v.reason}`).join('\n');
  const flags = sc.redFlags.length ? sc.redFlags.map(f => `- ${f}`).join('\n') : '- None detected.';
  return `# Fit score: ${job.title} at ${job.company}\n\nOverall: **${sc.overall}/100**\n\nMode: **${sc.mode || 'deterministic-degraded'}**\n\nConfidence: **${sc.confidence}**\n\n## Dimensions\n${dims}\n\n## Red flags\n${flags}\n\n## Reasoning\n${sc.reasoning}\n\n_Human review required before applying or sending materials._\n`;
}
