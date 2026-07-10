import path from 'node:path';
import { one, all, run, audit, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd } from './workspace.js';
import { searchWebDetailed } from './search.js';
import { generateJson, llmConfig } from './llm.js';

function sourceUrl(job) {
  return String(job.url || '').startsWith('jobos:text:') ? '' : job.url;
}

function factFromResult(result) {
  return {
    claim: result.snippet || result.title,
    title: result.title,
    url: result.url,
    confidence: 'medium',
    source: 'web-search',
    provider: result.provider || 'unknown',
    query: result.query || '',
    rank: result.rank || null
  };
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(raw || '').replace(/\/$/, '');
  }
}

function companyMatches(result, company) {
  const companyPhrase = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!companyPhrase) return false;
  const strippedPhrase = companyPhrase.replace(/\b(inc|incorporated|llc|ltd|limited|gmbh|ag|corp|corporation|co|company|plc|pbc)\b/g, '').replace(/\s+/g, ' ').trim();
  const phrases = [...new Set([companyPhrase, strippedPhrase].filter(p => p.length >= 2))];
  const sourceText = `${result.title || ''} ${result.snippet || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const sourceUrl = String(result.url || '').toLowerCase();
  let hostLabels = [];
  try { hostLabels = new URL(sourceUrl).hostname.replace(/^www\./, '').split('.').map(label => label.replace(/[^a-z0-9]+/g, '')); } catch {}
  const phraseIn = (text, phrase) => new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
  return phrases.some(phrase => {
    const compact = phrase.replace(/\s+/g, '');
    return phraseIn(sourceText, phrase) || hostLabels.some(label => label === compact);
  });
}

function renderFacts(facts) {
  return facts.length
    ? facts.map((f, idx) => `${idx + 1}. ${f.claim}\n   - Source: [${f.title || f.sourceTitle || f.url}](${f.url})\n   - Confidence: ${f.confidence}${f.provider ? `\n   - Provider: ${f.provider}` : ''}${f.category ? `\n   - Category: ${f.category}` : ''}`).join('\n')
    : 'No source-backed facts were found. Add company URLs or rerun with a working search provider.';
}

async function safeSearch(query, limit) {
  try {
    const detailed = await searchWebDetailed(query, { limit });
    return { results: detailed.results, error: null, warnings: detailed.warnings, provider: detailed.provider, attempted: detailed.attempted };
  } catch (e) {
    return { results: [], error: e.message, warnings: [{ provider: 'search', message: e.message }], provider: null, attempted: [] };
  }
}

function renderWarnings(warnings) {
  if (!warnings.length) return '';
  return `\n**Warnings:**\n${warnings.map(w => `- ${w}`).join('\n')}\n`;
}

function renderQueries(queries) {
  return queries.map(q => `- ${q}`).join('\n');
}

function renderOpenQuestions(questions) {
  return questions.length ? questions.map(q => `- ${q}`).join('\n') : '- No additional open questions generated.';
}

function renderAngles(angles) {
  if (!angles.length) return '- No source-backed outreach angles were generated. Use the facts above to write a conservative, human-reviewed note.';
  return angles.map((a, idx) => {
    const urls = (a.evidenceUrls || []).map(url => `  - Evidence: ${url}`).join('\n');
    return `${idx + 1}. ${a.angle}\n   - Why it matters: ${a.whyItMattersForRole || 'Connect this to the role only after human review.'}\n   - Suggested ask: ${a.suggestedAsk || 'Ask a concise question about current priorities and team context.'}\n   - Confidence: ${a.confidence || 'low'}${urls ? `\n${urls}` : ''}`;
  }).join('\n');
}

function renderCompanyDossier({ job, facts, queries, generatedAt, warnings, mode, openQuestions, outreachAngles }) {
  return `# Company dossier — ${job.company}\n\nGenerated: ${generatedAt}\n\n**Related job:** ${job.title} (${job.id})\n**Job source URL:** ${sourceUrl(job) || 'not provided'}\n**Research mode:** ${mode}\n\n## Search queries\n${renderQueries(queries)}\n${renderWarnings(warnings)}\n## Known from imported job text\n- Company: ${job.company}\n- Role: ${job.title}\n- Location: ${job.location || 'not specified'}\n\n## Source-backed facts\n${renderFacts(facts)}\n\n## Job-specific outreach angles\n${renderAngles(outreachAngles)}\n\n## Open questions for human review\n${renderOpenQuestions(openQuestions)}\n\n## Notes\nThis command searched web sources and wrote a dossier. Configure auto-apply and auto-send to take external actions.\n`;
}

function companyResearchQueries(job) {
  return [
    `"${job.company}" official product customers`,
    `"${job.company}" "${job.title}" team role hiring`,
    `"${job.company}" funding news strategy`,
    `"${job.company}" careers "${job.title}" requirements`,
    `"${job.company}" layoffs legal controversy reviews`
  ];
}


function isHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const result of results) {
    const key = canonicalUrl(result.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function fallbackOpenQuestions(job) {
  return [
    `Confirm ${job.company}'s current product, business model, and customer segment from primary sources.`,
    `Ask how ${job.title} connects to the team's current priorities and expected outcomes.`,
    'Check for layoffs, legal issues, suspicious postings, compensation, and work model before applying or sending outreach.'
  ];
}

function fallbackOutreachAngles(job, facts) {
  return facts.slice(0, 3).map(fact => ({
    angle: `Use the source-backed ${fact.category || 'company'} signal when discussing the ${job.title} role.`,
    whyItMattersForRole: `Tie the conversation to ${job.title} responsibilities only where the job text and source-backed fact overlap.`,
    suggestedAsk: 'Ask how this signal affects the team priorities for the role.',
    evidenceUrls: [fact.url],
    confidence: 'low'
  }));
}

function companyResearchPrompt({ job, results }) {
  return `Create a source-grounded company dossier for this job. Use only SOURCES. Return JSON with claims array, openQuestions array, outreachAngles array, and warnings array. Each claim must include claim, category, sourceUrl, sourceTitle, confidence. Each outreach angle must include angle, whyItMattersForRole, evidenceUrls array, suggestedAsk, confidence. Do not include any factual claim or angle that lacks a source URL from SOURCES.\n\nJOB:\n${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, url: sourceUrl(job) }, null, 2)}\n\nSOURCES:\n${JSON.stringify(results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet, provider: r.provider, query: r.query, rank: r.rank })), null, 2)}`;
}

function normalizeConfidence(value, fallback = 'medium') {
  const v = String(value || '').toLowerCase();
  return ['low', 'medium', 'high'].includes(v) ? v : fallback;
}

function sourceMap(results) {
  return new Map(results.map(result => [canonicalUrl(result.url), result]));
}

function validatedClaims(rawClaims, resultByUrl) {
  const dropped = { missingSource: 0, invalidSource: 0 };
  const claims = [];
  for (const raw of Array.isArray(rawClaims) ? rawClaims : []) {
    const url = String(raw?.sourceUrl || raw?.url || '').trim();
    const claim = String(raw?.claim || '').replace(/\s+/g, ' ').trim();
    if (!claim || !url) {
      dropped.missingSource++;
      continue;
    }
    const source = resultByUrl.get(canonicalUrl(url));
    if (!source) {
      dropped.invalidSource++;
      continue;
    }
    claims.push({
      claim,
      title: String(raw.sourceTitle || source.title || source.url),
      url: source.url,
      confidence: normalizeConfidence(raw.confidence),
      source: 'llm-synthesis',
      category: String(raw.category || 'other'),
      provider: source.provider || 'unknown',
      query: source.query || '',
      rank: source.rank || null
    });
  }
  return { claims, dropped };
}

function validatedAngles(rawAngles, resultByUrl) {
  const dropped = { missingSource: 0 };
  const angles = [];
  for (const raw of Array.isArray(rawAngles) ? rawAngles : []) {
    const validUrls = (Array.isArray(raw?.evidenceUrls) ? raw.evidenceUrls : [])
      .map(url => resultByUrl.get(canonicalUrl(url))?.url)
      .filter(Boolean);
    if (!validUrls.length) {
      dropped.missingSource++;
      continue;
    }
    const angle = String(raw?.angle || '').replace(/\s+/g, ' ').trim();
    if (!angle) {
      dropped.missingSource++;
      continue;
    }
    angles.push({
      angle,
      whyItMattersForRole: String(raw.whyItMattersForRole || '').replace(/\s+/g, ' ').trim(),
      evidenceUrls: [...new Set(validUrls)],
      suggestedAsk: String(raw.suggestedAsk || '').replace(/\s+/g, ' ').trim(),
      confidence: normalizeConfidence(raw.confidence, 'low')
    });
  }
  return { angles, dropped };
}

async function synthesizeCompanyResearch(job, matchedResults, fallbackFacts) {
  const cfg = llmConfig();
  if (!cfg.configured || !matchedResults.length) {
    return {
      mode: 'deterministic-degraded',
      facts: fallbackFacts,
      openQuestions: fallbackOpenQuestions(job),
      outreachAngles: fallbackOutreachAngles(job, fallbackFacts),
      warnings: cfg.configured ? [] : ['JOBOS LLM is not configured; rendered multi-query deterministic fallback.'],
      droppedClaims: 0,
      droppedAngles: 0
    };
  }
  try {
    const result = await generateJson({
      schemaName: 'jobos_company_dossier',
      system: 'You are JobOS company research. Use only supplied public source results. Every factual claim and outreach angle must cite source URLs from the supplied source list.',
      user: companyResearchPrompt({ job, results: matchedResults }),
      temperature: 0.1,
      maxTokens: 2600
    });
    if (!result.ok) throw new Error(result.reason || 'LLM unavailable');
    const resultByUrl = sourceMap(matchedResults);
    const { claims, dropped: droppedClaims } = validatedClaims(result.json?.claims, resultByUrl);
    const { angles, dropped: droppedAngles } = validatedAngles(result.json?.outreachAngles, resultByUrl);
    const warnings = Array.isArray(result.json?.warnings) ? result.json.warnings.map(String) : [];
    const droppedClaimCount = droppedClaims.missingSource + droppedClaims.invalidSource;
    const droppedAngleCount = droppedAngles.missingSource;
    if (droppedClaimCount) warnings.push(`Dropped ${droppedClaimCount} unsupported LLM claim(s) without valid source URLs.`);
    if (droppedAngleCount) warnings.push(`Dropped ${droppedAngleCount} unsupported LLM outreach angle(s) without valid source URLs.`);
    if (!claims.length) warnings.push('LLM returned no valid source-backed claims; rendered deterministic facts instead.');
    return {
      mode: 'llm',
      facts: claims.length ? claims : fallbackFacts,
      openQuestions: Array.isArray(result.json?.openQuestions) ? result.json.openQuestions.map(String).filter(Boolean) : fallbackOpenQuestions(job),
      outreachAngles: angles.length ? angles : fallbackOutreachAngles(job, fallbackFacts),
      warnings,
      droppedClaims: droppedClaimCount,
      droppedAngles: droppedAngleCount
    };
  } catch (e) {
    return {
      mode: 'deterministic-degraded',
      facts: fallbackFacts,
      openQuestions: fallbackOpenQuestions(job),
      outreachAngles: fallbackOutreachAngles(job, fallbackFacts),
      warnings: [`LLM company synthesis failed; rendered deterministic fallback: ${e.message}`],
      droppedClaims: 0,
      droppedAngles: 0
    };
  }
}

async function buildCompanyResearch(job) {
  const queries = companyResearchQueries(job);
  const rawResults = [];
  const searchWarnings = [];
  for (const query of queries) {
    const searched = await safeSearch(query, 5);
    rawResults.push(...searched.results);
    if (searched.error) searchWarnings.push(`${query}: ${searched.error}`);
    for (const warning of searched.warnings || []) searchWarnings.push(`${query}: ${warning.provider} ${warning.message}`);
  }
  const pooled = dedupeResults(rawResults);
  const matched = pooled.filter(result => companyMatches(result, job.company));
  const fallbackFacts = matched.map(factFromResult);
  const synthesized = await synthesizeCompanyResearch(job, matched, fallbackFacts);
  return {
    queries,
    pooled,
    matched,
    facts: synthesized.facts,
    openQuestions: synthesized.openQuestions,
    outreachAngles: synthesized.outreachAngles,
    warnings: [...searchWarnings, ...synthesized.warnings],
    mode: synthesized.mode,
    droppedClaims: synthesized.droppedClaims,
    droppedAngles: synthesized.droppedAngles
  };
}

function roleFromTitle(title) {
  const lower = title.toLowerCase();
  if (lower.includes('recruit')) return 'Recruiting Lead';
  if (lower.includes('product')) return 'Product Leader';
  if (lower.includes('founder')) return 'Founder';
  if (lower.includes('talent')) return 'Talent Lead';
  return 'Relevant stakeholder';
}

function stripStakeholderMetadata(summary) {
  return String(summary || '').replace(/^Confidence: [^.]+\. Source type: [^.]+\. /, '').trim();
}

function stakeholderSummary({ summary, confidence = 'low', sourceType = 'public_search', reason = '' }) {
  const body = stripStakeholderMetadata(summary || reason || 'Source-backed stakeholder relevance requires human review.');
  const extra = reason && !body.includes(reason) ? ` Relevance check: ${reason}` : '';
  return `Confidence: ${normalizeConfidence(confidence, 'low')}. Source type: ${sourceType}. ${body}${extra}`.trim();
}

function stakeholderConfidence(result, company) {
  if (companyMatches({ title: result.title, snippet: '', url: result.url }, company)) return 'high';
  if (companyAffiliationMatches(result, company)) return 'medium';
  return 'low';
}

function companyAffiliationMatches(result, company) {
  if (companyMatches({ title: result.title, snippet: '', url: result.url }, company)) return true;
  const companyPhrase = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!companyPhrase) return false;
  const strippedPhrase = companyPhrase.replace(/\b(inc|incorporated|llc|ltd|limited|gmbh|ag|corp|corporation|co|company|plc|pbc)\b/g, '').replace(/\s+/g, ' ').trim();
  const phrases = [...new Set([companyPhrase, strippedPhrase].filter(p => p.length >= 2))];
  const snippet = String(result.snippet || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return phrases.some(phrase => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(at|for|with|from) ${escaped}\\b`).test(snippet)
      || new RegExp(`\\b(leads|leading|supports|recruits|hiring|focused on|works on) [a-z0-9 ]{0,80} (at|for|with) ${escaped}\\b`).test(snippet);
  });
}

function personFromResult(result, company) {
  const title = result.title.replace(/\s+/g, ' ').trim();
  const name = title.split(/\s+[—|-]\s+/)[0]?.trim();
  const words = name ? name.split(/\s+/) : [];
  const companyTokens = new Set(String(company || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  const looksLikePerson = words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z][A-Za-z'.-]+$/.test(w));
  const hasRoleSignal = /\b(head|lead|manager|director|recruit|talent|founder|product|people|hiring)\b/i.test(`${title} ${result.snippet || ''}`);
  const overlapsCompany = words.some(w => companyTokens.has(w.toLowerCase()));
  const affiliatedWithCompany = companyAffiliationMatches(result, company);
  if (!name || !looksLikePerson || !hasRoleSignal || overlapsCompany || !affiliatedWithCompany || /career|job|team|company|about/i.test(name)) return null;
  const confidence = stakeholderConfidence(result, company);
  const rawSummary = result.snippet || title;
  return { name, role: roleFromTitle(`${title} ${result.snippet || ''}`), links: [result.url], rawSummary, summary: stakeholderSummary({ summary: rawSummary, confidence, sourceType: 'public_search' }), confidence, sourceType: 'public_search' };
}

function renderStakeholders({ job, stakeholders, query, generatedAt, searchError, warnings = [] }) {
  const rows = stakeholders.length ? stakeholders.map(s => {
    const confidence = s.confidence ? `\n  - Confidence: ${s.confidence}` : '';
    const sourceType = s.sourceType ? `\n  - Source type: ${s.sourceType}` : '';
    return `- **${s.name}** — ${s.role}${confidence}${sourceType}\n  - Relevance: ${s.summary}\n  - Source: ${s.links[0]}`;
  }).join('\n') : '- No named public stakeholders found from search results.';
  const warningText = warnings.length ? `\n**Warnings:**\n${warnings.map(w => `- ${w}`).join('\n')}\n` : '';
  return `# Stakeholder research — ${job.title} at ${job.company}\n\nGenerated: ${generatedAt}\n\n**Search query:** ${query}\n${searchError ? `**Search warning:** ${searchError}\n` : ''}${warningText}\n## Candidates\n${rows}\n\n## Suppression and relevance policy\n- Draft outreach only after relevance is documented.\n- Use outreach commands to draft and manage messages.\n- Pause outreach if application stage changes to interview/offer/rejected unless user reviews.\n\n## Notes\nThis command used web-search results. Stakeholders can be contacted via outreach commands.\n`;
}

function upsertStakeholder(s, job, person, at) {
  const sid = id('stakeholder', `${job.id}:${person.name}:${person.links[0] || ''}`);
  run(s, 'INSERT OR REPLACE INTO stakeholders VALUES (?,?,?,?,?,?,?,?,?,?)', [sid, job.id, job.company_id, person.name, person.role, JSON.stringify(person.links), person.summary, 'not_contacted', at, at]);
  return { id: sid, ...person };
}

function inferName(text) {
  const match = String(text || '').match(/\b([A-Z][A-Za-z'.-]+\s+[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+)?)\b/);
  return match?.[1] || '';
}

function inferRole(text) {
  const value = String(text || '');
  const role = value.match(/\b(Head of [A-Z][A-Za-z ]+|Director of [A-Z][A-Za-z ]+|Recruiting Lead|Talent Lead|Product Manager|Product Leader|Hiring Manager|Founder|Recruiter)\b/);
  return role?.[1]?.trim() || roleFromTitle(value);
}

function inferStakeholder(job, { name = '', role = '', sourceUrl, text = '', sourceType = 'user_pasted' }) {
  const finalName = String(name || '').trim() || inferName(text);
  if (!finalName) throw new Error('Missing --name or inferable person name in --text/--file');
  const finalRole = String(role || '').trim() || inferRole(text);
  const mentionsCompany = String(text || '').toLowerCase().includes(String(job.company || '').toLowerCase());
  const confidence = mentionsCompany && finalRole !== 'Relevant stakeholder' ? 'medium' : 'low';
  const rawSummary = String(text || `${finalName} is a possible stakeholder for ${job.company}.`).replace(/\s+/g, ' ').trim();
  return {
    name: finalName,
    role: finalRole,
    links: [sourceUrl],
    rawSummary,
    summary: stakeholderSummary({ summary: rawSummary, confidence, sourceType }),
    confidence,
    sourceType
  };
}

async function structureStakeholder(job, input, fallback) {
  const cfg = llmConfig();
  if (!cfg.configured) return { person: fallback, warnings: ['JOBOS LLM is not configured; structured stakeholder with deterministic fallback.'] };
  try {
    const result = await generateJson({
      schemaName: 'jobos_stakeholder_structuring',
      system: 'You are JobOS stakeholder research. Structure only the user-provided source text and URL. Do not invent names, employers, or relevance.',
      user: `Structure this pasted stakeholder source for a job. Return JSON with name, role, relevanceSummary, confidence low|medium|high, warnings array. The source URL is required and already supplied; do not replace it.\n\nJOB:\n${JSON.stringify({ title: job.title, company: job.company }, null, 2)}\n\nSOURCE:\n${JSON.stringify(input, null, 2)}`,
      temperature: 0.1,
      maxTokens: 1200
    });
    if (!result.ok) throw new Error(result.reason || 'LLM unavailable');
    const json = result.json || {};
    const name = String(json.name || fallback.name || '').trim();
    if (!name) throw new Error('LLM returned no stakeholder name');
    const role = String(json.role || fallback.role || 'Relevant stakeholder').trim();
    const confidence = normalizeConfidence(json.confidence, fallback.confidence || 'low');
    const rawSummary = String(json.relevanceSummary || fallback.rawSummary || fallback.summary || '').replace(/\s+/g, ' ').trim();
    return {
      person: { ...fallback, name, role, rawSummary, confidence, summary: stakeholderSummary({ summary: rawSummary, confidence, sourceType: 'user_pasted' }) },
      warnings: Array.isArray(json.warnings) ? json.warnings.map(String) : []
    };
  } catch (e) {
    return { person: fallback, warnings: [`LLM stakeholder structuring failed; used deterministic fallback: ${e.message}`] };
  }
}

function stakeholderRelevancePrompt(job, candidates) {
  return `Check stakeholder candidates for this job. Return JSON with candidates array. Each item must include sourceUrl, isPerson boolean, belongsToCompany boolean, roleRelevance high|medium|low|none, confidence low|medium|high, reason. Drop wrong-company and non-person candidates by setting belongsToCompany or isPerson false.\n\nJOB:\n${JSON.stringify({ title: job.title, company: job.company }, null, 2)}\n\nCANDIDATES:\n${JSON.stringify(candidates.map(c => ({ name: c.name, role: c.role, sourceUrl: c.links[0], summary: c.rawSummary || c.summary })), null, 2)}`;
}

async function filterStakeholdersWithLlm(job, candidates) {
  const cfg = llmConfig();
  if (!cfg.configured || !candidates.length) return { people: candidates, warnings: [] };
  try {
    const result = await generateJson({
      schemaName: 'jobos_stakeholder_relevance',
      system: 'You are JobOS stakeholder relevance checking. Be conservative. Never promote a candidate without source-backed company relevance.',
      user: stakeholderRelevancePrompt(job, candidates),
      temperature: 0,
      maxTokens: 1800
    });
    if (!result.ok) throw new Error(result.reason || 'LLM unavailable');
    const decisions = new Map((Array.isArray(result.json?.candidates) ? result.json.candidates : []).map(d => [canonicalUrl(d.sourceUrl), d]));
    const people = [];
    for (const candidate of candidates) {
      const decision = decisions.get(canonicalUrl(candidate.links[0]));
      if (!decision) continue;
      if (!decision.isPerson || !decision.belongsToCompany || String(decision.roleRelevance || '').toLowerCase() === 'none') continue;
      const confidence = normalizeConfidence(decision.confidence, candidate.confidence || 'low');
      const reason = String(decision.reason || '').replace(/\s+/g, ' ').trim();
      people.push({
        ...candidate,
        confidence,
        summary: stakeholderSummary({ summary: candidate.rawSummary || candidate.summary, confidence, sourceType: candidate.sourceType || 'public_search', reason })
      });
    }
    return { people, warnings: [] };
  } catch (e) {
    return { people: candidates, warnings: [`LLM stakeholder relevance check failed; used deterministic candidates: ${e.message}`] };
  }
}

function writeStakeholderDoc(s, job, stakeholders, query, at, warnings = [], searchError = null) {
  const rel = path.join('jobs', job.id, 'stakeholders.md');
  writeMd(path.join(s.p.ws, rel), renderStakeholders({ job, stakeholders, query, generatedAt: at, searchError, warnings }));
  return rel;
}

export async function addStakeholder(s, { jobId, name = '', role = '', sourceUrl = '', text = '' }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const url = String(sourceUrl || '').trim();
  if (!url) throw Error('Missing --source-url; stakeholder records require a public source URL.');
  if (!isHttpUrl(url)) throw Error('Stakeholder --source-url must be a public http(s) URL.');
  const at = now();
  const fallback = inferStakeholder(job, { name, role, sourceUrl: url, text, sourceType: 'user_pasted' });
  const structured = await structureStakeholder(job, { name, role, sourceUrl: url, text }, fallback);
  const stakeholder = upsertStakeholder(s, job, structured.person, at);
  const stakeholders = listJobStakeholders(s, job.id);
  const rel = writeStakeholderDoc(s, job, stakeholders, 'user-pasted stakeholder source', at, structured.warnings);
  audit(s, 'research.stakeholder.added', 'stakeholder', stakeholder.id, { jobId: job.id, path: rel, sourceUrl: url, confidence: structured.person.confidence });
  save(s);
  return { id: stakeholder.id, jobId: job.id, path: rel, name: stakeholder.name, role: stakeholder.role, sourceUrl: url, confidence: structured.person.confidence, warnings: structured.warnings, note: 'Stakeholder recorded from user-provided source text/URL.' };
}

export async function research(s, jid, type) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const at = now();
  if (type === 'company') {
    const researchResult = await buildCompanyResearch(job);
    const { queries, facts, warnings, mode, openQuestions, outreachAngles, droppedClaims, droppedAngles } = researchResult;
    const rel = path.join('jobs', jid, 'company-dossier.md');
    const content = renderCompanyDossier({ job, facts, queries, generatedAt: at, warnings, mode, openQuestions, outreachAngles });
    writeMd(path.join(s.p.ws, rel), content);
    const summary = facts[0]?.claim || '';
    run(s, 'UPDATE companies SET summary=?, facts_json=?, updated_at=? WHERE id=?', [summary, JSON.stringify(facts), at, job.company_id]);
    audit(s, 'research.company.created', 'job', jid, { jobId: jid, path: rel, queries, sourceCount: facts.length, mode, droppedClaims, droppedAngles, warnings: warnings.length });
    save(s);
    return { jobId: jid, companyId: job.company_id || slug(job.company), path: rel, mode, factCount: facts.length, sourceCount: new Set(facts.map(f => f.url)).size, sources: facts.map(f => f.url), queryCount: queries.length, outreachAngleCount: outreachAngles.length, droppedUnsupportedClaims: droppedClaims, droppedUnsupportedAngles: droppedAngles, warnings, note: 'Company dossier created from web-search results.' };
  }

  const query = `${job.company} ${job.title} stakeholder hiring manager recruiter product leader`;
  const { results, error: searchError } = await safeSearch(query, 8);
  const candidates = results.map(result => personFromResult(result, job.company)).filter(Boolean).slice(0, 5);
  const checked = await filterStakeholdersWithLlm(job, candidates);
  const people = checked.people;
  const stakeholders = people.map(p => upsertStakeholder(s, job, p, at));
  const rel = writeStakeholderDoc(s, job, stakeholders, query, at, checked.warnings, searchError);
  audit(s, 'research.stakeholders.created', 'job', jid, { jobId: jid, path: rel, query, stakeholderIds: stakeholders.map(x => x.id), candidateCount: candidates.length, warnings: checked.warnings.length });
  save(s);
  return { jobId: jid, path: rel, stakeholderIds: stakeholders.map(x => x.id), candidateCount: candidates.length, sourceCount: new Set(stakeholders.flatMap(x => x.links)).size, searchError, warnings: checked.warnings, note: 'Stakeholder research created from web-search results.' };
}

export function getStakeholder(s, sid) {
  const row = one(s, 'SELECT * FROM stakeholders WHERE id=?', [sid]);
  return row ? { ...row, links: parseJson(row.links_json, []) } : null;
}

export function listJobStakeholders(s, jid) {
  return all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [jid]).map(row => ({ ...row, links: parseJson(row.links_json, []) }));
}
