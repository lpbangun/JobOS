import path from 'node:path';
import { one, all, run, audit, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd } from './workspace.js';
import { searchWeb } from './search.js';

function sourceUrl(job) {
  return String(job.url || '').startsWith('jobos:text:') ? '' : job.url;
}

function factFromResult(result) {
  return {
    claim: result.snippet || result.title,
    title: result.title,
    url: result.url,
    confidence: 'medium',
    source: 'web-search'
  };
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
    ? facts.map((f, idx) => `${idx + 1}. ${f.claim}\n   - Source: [${f.title}](${f.url})\n   - Confidence: ${f.confidence}`).join('\n')
    : 'No source-backed facts were found. Add company URLs or rerun with a working search provider.';
}

async function safeSearch(query, limit) {
  try {
    return { results: await searchWeb(query, { limit }), error: null };
  } catch (e) {
    return { results: [], error: e.message };
  }
}

function renderCompanyDossier({ job, facts, query, generatedAt, searchError }) {
  return `# Company dossier — ${job.company}\n\nGenerated: ${generatedAt}\n\n**Related job:** ${job.title} (${job.id})\n**Job source URL:** ${sourceUrl(job) || 'not provided'}\n**Search query:** ${query}\n${searchError ? `**Search warning:** ${searchError}\n` : ''}\n## Known from imported job text\n- Company: ${job.company}\n- Role: ${job.title}\n- Location: ${job.location || 'not specified'}\n\n## Source-backed facts\n${renderFacts(facts)}\n\n## Role and outreach angles\n- Connect any outreach to the role's stated requirements and the verified facts above.\n- Ask about product priorities, team context, and how this role contributes to current company goals.\n\n## Open questions for human review\n- Confirm stage, business model, and customer segment from primary sources.\n- Check for layoffs, legal issues, or suspicious postings before applying.\n- Verify compensation and work model directly with the company.\n\n## Human gate\nThis command searched public web sources and wrote an internal dossier only. It did not browse private accounts, scrape LinkedIn, submit applications, or send outreach.\n`;
}

function roleFromTitle(title) {
  const lower = title.toLowerCase();
  if (lower.includes('recruit')) return 'Recruiting Lead';
  if (lower.includes('product')) return 'Product Leader';
  if (lower.includes('founder')) return 'Founder';
  if (lower.includes('talent')) return 'Talent Lead';
  return 'Relevant stakeholder';
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
  return { name, role: roleFromTitle(`${title} ${result.snippet || ''}`), links: [result.url], summary: result.snippet || title };
}

function renderStakeholders({ job, stakeholders, query, generatedAt, searchError }) {
  const rows = stakeholders.length ? stakeholders.map(s => `- **${s.name}** — ${s.role}\n  - Relevance: ${s.summary}\n  - Source: ${s.links[0]}`).join('\n') : '- No named public stakeholders found from search results.';
  return `# Stakeholder research — ${job.title} at ${job.company}\n\nGenerated: ${generatedAt}\n\n**Search query:** ${query}\n${searchError ? `**Search warning:** ${searchError}\n` : ''}\n## Candidates\n${rows}\n\n## Suppression and relevance policy\n- Draft outreach only after relevance is documented.\n- Do not send messages from JobOS.\n- Pause outreach if application stage changes to interview/offer/rejected unless user reviews.\n\n## Human gate\nThis command used public web-search results only. It did not scrape private accounts or contact anyone.\n`;
}

function upsertStakeholder(s, job, person, at) {
  const sid = id('stakeholder', `${job.id}:${person.name}:${person.links[0] || ''}`);
  run(s, 'INSERT OR REPLACE INTO stakeholders VALUES (?,?,?,?,?,?,?,?,?,?)', [sid, job.id, job.company_id, person.name, person.role, JSON.stringify(person.links), person.summary, 'not_contacted', at, at]);
  return { id: sid, ...person };
}

export async function research(s, jid, type) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const at = now();
  if (type === 'company') {
    const query = `${job.company} ${job.title} company product funding customers`;
    const { results, error: searchError } = await safeSearch(query, 5);
    const facts = results.filter(result => companyMatches(result, job.company)).map(factFromResult);
    const rel = path.join('jobs', jid, 'company-dossier.md');
    const content = renderCompanyDossier({ job, facts, query, generatedAt: at, searchError });
    writeMd(path.join(s.p.ws, rel), content);
    if (facts.length) {
      const summary = facts[0].claim;
      run(s, 'UPDATE companies SET summary=?, facts_json=?, updated_at=? WHERE id=?', [summary, JSON.stringify(facts), at, job.company_id]);
    }
    audit(s, 'research.company.created', 'job', jid, { jobId: jid, path: rel, query, sourceCount: facts.length });
    save(s);
    return { jobId: jid, companyId: job.company_id || slug(job.company), path: rel, factCount: facts.length, sourceCount: new Set(facts.map(f => f.url)).size, sources: facts.map(f => f.url), searchError, note: 'Company dossier created from public web-search results; no external side effects.' };
  }

  const query = `${job.company} ${job.title} stakeholder hiring manager recruiter product leader`;
  const { results, error: searchError } = await safeSearch(query, 8);
  const people = results.map(result => personFromResult(result, job.company)).filter(Boolean).slice(0, 5);
  const stakeholders = people.map(p => upsertStakeholder(s, job, p, at));
  const rel = path.join('jobs', jid, 'stakeholders.md');
  writeMd(path.join(s.p.ws, rel), renderStakeholders({ job, stakeholders, query, generatedAt: at, searchError }));
  audit(s, 'research.stakeholders.created', 'job', jid, { jobId: jid, path: rel, query, stakeholderIds: stakeholders.map(x => x.id) });
  save(s);
  return { jobId: jid, path: rel, stakeholderIds: stakeholders.map(x => x.id), sourceCount: new Set(stakeholders.flatMap(x => x.links)).size, searchError, note: 'Stakeholder research created from public web-search results; no outreach was sent.' };
}

export function getStakeholder(s, sid) {
  const row = one(s, 'SELECT * FROM stakeholders WHERE id=?', [sid]);
  return row ? { ...row, links: parseJson(row.links_json, []) } : null;
}

export function listJobStakeholders(s, jid) {
  return all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [jid]).map(row => ({ ...row, links: parseJson(row.links_json, []) }));
}
