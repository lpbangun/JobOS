import { id, parseJson, tokenize } from './utils.js';

export const REQUIREMENTS_SCHEMA_VERSION = 1;
const CATEGORIES = new Set(['responsibility', 'skill', 'experience', 'domain', 'seniority', 'credential', 'work_model', 'preferred_qualification']);
const SKILL_PHRASES = ['user research', 'product management', 'project management', 'data analysis', 'machine learning', 'artificial intelligence', 'cross-functional', 'stakeholder management', 'software development', 'product strategy', 'roadmap', 'sql', 'python', 'javascript', 'typescript', 'react', 'node.js', 'aws', 'azure', 'gcp', 'figma', 'tableau', 'salesforce'];
const STOP = new Set(['must', 'have', 'with', 'years', 'year', 'experience', 'required', 'preferred', 'qualification', 'qualifications', 'responsibilities', 'responsibility', 'ability', 'strong', 'excellent', 'including', 'role', 'work', 'working']);

function cleanLine(line) { return String(line || '').trim().replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim(); }
function heading(line) {
  const value = cleanLine(String(line).replace(/^#{1,6}\s*/, '')).replace(/:$/, '').toLowerCase();
  if (/^(minimum|required|basic|preferred|desired|nice to have)?\s*(qualifications?|requirements?)$/.test(value)) return value.includes('preferred') || value.includes('desired') || value.includes('nice') ? 'preferred' : 'requirements';
  if (/^(what you.ll do|responsibilities|the role|you will|duties)$/.test(value)) return 'responsibilities';
  if (/^(preferred|nice to have|bonus)$/.test(value)) return 'preferred';
  return '';
}
function priorityFor(sourceText, section) {
  if (section === 'preferred' || /\b(preferred|nice to have|bonus|ideally|a plus)\b/i.test(sourceText)) return 'preferred';
  return 'must_have';
}
function categoryFor(sourceText, section) {
  const value = sourceText.toLowerCase();
  if (priorityFor(sourceText, section) === 'preferred') return 'preferred_qualification';
  if (/\b(certif|license|degree|bachelor|master|phd|mba|credential)\b/.test(value)) return 'credential';
  if (/\b(remote|hybrid|on[- ]site|travel|timezone|relocat)\b/.test(value)) return 'work_model';
  if (/\b(senior|lead|manager|director|executive|staff|principal)\b/.test(value)) return 'seniority';
  if (/\b\d+\+?\s+years?\b/.test(value)) return 'experience';
  if (/\b(industry|domain|healthcare|education|edtech|fintech|saas|marketplace|enterprise)\b/.test(value)) return 'domain';
  if (section === 'responsibilities' || /\b(lead|own|build|create|deliver|manage|develop|design|drive|conduct|collaborate|partner)\b/.test(value)) return 'responsibility';
  return 'skill';
}
function normalizedTerms(sourceText) {
  const lower = sourceText.toLowerCase();
  const phrases = SKILL_PHRASES.filter(term => lower.includes(term));
  const words = tokenize(sourceText).filter(term => !STOP.has(term) && !/^\d+$/.test(term));
  const informative = words.filter(term => term.length >= 4).slice(0, 8);
  return [...new Set([...phrases, ...informative])];
}
function yearsFor(sourceText) {
  const match = sourceText.match(/\b(\d+)\+?\s+years?\b/i);
  return match ? Number(match[1]) : null;
}
function credentialFor(sourceText) {
  const match = sourceText.match(/\b(BS|BA|MS|MA|MBA|PhD|JD|PMP|CPA|RN|[A-Za-z][A-Za-z -]+ certification|[A-Za-z][A-Za-z -]+ license)\b/i);
  return match?.[0] || null;
}
function requirementLine(line, inSection) {
  const trimmed = String(line || '').trim();
  if (!trimmed || heading(trimmed)) return false;
  if (/^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) return Boolean(inSection) || /\b(must|required|preferred|experience|ability|responsib|proficien|knowledge)\b/i.test(trimmed);
  return /\b(must|required|preferred|minimum of|years? of experience|responsible for|you will|ability to|proficien|knowledge of)\b/i.test(trimmed);
}

export function extractRequirementInventory(sourceText) {
  const requirements = [];
  let section = '';
  const lines = String(sourceText || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const nextSection = heading(raw);
    if (nextSection) { section = nextSection; continue; }
    if (!requirementLine(raw, section)) continue;
    const source = cleanLine(raw);
    if (!source) continue;
    const category = categoryFor(source, section);
    requirements.push({
      id: id('requirement', `${index}:${source}`),
      sourceText: source,
      sourceLine: index + 1,
      category: CATEGORIES.has(category) ? category : 'skill',
      priority: priorityFor(source, section),
      normalizedTerms: normalizedTerms(source),
      years: yearsFor(source),
      credential: credentialFor(source)
    });
  }
  return { schemaVersion: REQUIREMENTS_SCHEMA_VERSION, requirements };
}

export function normalizeRequirementInventory(value, fallbackSource = '') {
  if (Array.isArray(value)) {
    return { schemaVersion: REQUIREMENTS_SCHEMA_VERSION, requirements: value.map((sourceText, index) => ({ id: id('requirement', `${index}:${sourceText}`), sourceText: String(sourceText), sourceLine: null, category: categoryFor(String(sourceText), ''), priority: priorityFor(String(sourceText), ''), normalizedTerms: normalizedTerms(String(sourceText)), years: yearsFor(String(sourceText)), credential: credentialFor(String(sourceText)) })) };
  }
  if (!value || value.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION || !Array.isArray(value.requirements)) return extractRequirementInventory(fallbackSource);
  return { schemaVersion: REQUIREMENTS_SCHEMA_VERSION, requirements: value.requirements.map((requirement, index) => ({ id: String(requirement.id || id('requirement', `${index}:${requirement.sourceText}`)), sourceText: String(requirement.sourceText || ''), sourceLine: Number.isInteger(requirement.sourceLine) ? requirement.sourceLine : null, category: CATEGORIES.has(requirement.category) ? requirement.category : categoryFor(String(requirement.sourceText || ''), ''), priority: requirement.priority === 'preferred' ? 'preferred' : 'must_have', normalizedTerms: Array.isArray(requirement.normalizedTerms) ? [...new Set(requirement.normalizedTerms.map(String))] : normalizedTerms(String(requirement.sourceText || '')), years: Number.isFinite(requirement.years) ? requirement.years : yearsFor(String(requirement.sourceText || '')), credential: requirement.credential == null ? credentialFor(String(requirement.sourceText || '')) : String(requirement.credential) })) };
}

export function inventoryForJob(job) {
  return normalizeRequirementInventory(parseJson(job?.requirements_json, null), job?.description || '');
}
export function requirementTextsForJob(job) {
  return inventoryForJob(job).requirements.map(requirement => requirement.sourceText);
}
function proofTerms(proof) {
  const skills = Array.isArray(proof.skills) ? proof.skills : parseJson(proof.skills_json, []);
  return new Set(tokenize(`${proof.summary || ''} ${skills.join(' ')}`));
}
function coverageForRequirement(requirement, proofs) {
  const requirementTokens = new Set(tokenize(`${requirement.sourceText} ${requirement.normalizedTerms.join(' ')}`));
  const candidates = proofs.map(proof => {
    const terms = proofTerms(proof);
    const matchedTerms = [...requirementTokens].filter(term => terms.has(term));
    const exactSkills = requirement.normalizedTerms.filter(term => {
      const normalized = tokenize(term);
      const recognizedSkill = SKILL_PHRASES.includes(term);
      return normalized.length && (normalized.length > 1 || recognizedSkill) && normalized.every(token => terms.has(token));
    });
    const strength = matchedTerms.length + exactSkills.length * 2;
    return { proof, matchedTerms: [...new Set([...exactSkills, ...matchedTerms])], strength };
  }).filter(candidate => candidate.strength > 0).sort((a, b) => b.strength - a.strength || String(a.proof.id).localeCompare(String(b.proof.id)));
  const best = candidates[0];
  if (!best) return { requirementId: requirement.id, status: 'unsupported', proofPointIds: [], sourceEntryIds: [], matchedTerms: [], confidence: 'low', reason: 'No active verified proof matches this requirement.' };
  const status = best.strength >= 3 ? 'supported' : 'partially_supported';
  const selected = candidates.filter(candidate => candidate.strength === best.strength).slice(0, 3);
  return {
    requirementId: requirement.id,
    status,
    proofPointIds: selected.map(candidate => candidate.proof.id),
    sourceEntryIds: [...new Set(selected.map(candidate => candidate.proof.source_resume_entry_id).filter(Boolean))],
    matchedTerms: [...new Set(selected.flatMap(candidate => candidate.matchedTerms))],
    confidence: status === 'supported' ? 'high' : 'medium',
    reason: status === 'supported' ? 'Active verified evidence matches the requirement terms.' : 'Active verified evidence overlaps, but does not fully establish the requirement.'
  };
}

export function buildRequirementCoverage(inventory, proofs, { selectedProofPointIds } = {}) {
  const normalized = normalizeRequirementInventory(inventory);
  const eligible = proofs.filter(proof => (proof.status || 'active') === 'active' && (proof.verification_status || proof.verificationStatus) === 'verified');
  const hasSelection = Array.isArray(selectedProofPointIds);
  const selected = new Set(hasSelection ? selectedProofPointIds : []);
  const matrix = normalized.requirements.map(requirement => ({ ...coverageForRequirement(requirement, eligible), requirement }));
  const matched = matrix.filter(item => item.status === 'supported' && (!hasSelection || item.proofPointIds.some(proofId => selected.has(proofId))));
  const omittedSupported = hasSelection ? matrix.filter(item => item.status === 'supported' && !item.proofPointIds.some(proofId => selected.has(proofId))) : [];
  const partial = matrix.filter(item => item.status === 'partially_supported');
  const unsupported = matrix.filter(item => item.status === 'unsupported');
  const important = matrix.filter(item => item.requirement.priority === 'must_have');
  const supportedImportant = matched.filter(item => item.requirement.priority === 'must_have').length;
  return {
    schemaVersion: 1,
    matrix,
    summary: {
      importantRequirementCount: important.length,
      supportedImportantCount: supportedImportant,
      coverageRatio: important.length ? supportedImportant / important.length : 0,
      matchedRequirementIds: matched.map(item => item.requirementId),
      partiallySupportedRequirementIds: partial.map(item => item.requirementId),
      omittedSupportedRequirementIds: omittedSupported.map(item => item.requirementId),
      unsupportedRequirementIds: unsupported.map(item => item.requirementId)
    },
    matched,
    partiallySupported: partial,
    omittedSupported,
    unsupported
  };
}
