import path from 'node:path';
import { createArtifact } from './artifacts.js';
import { all, audit, one, run, save } from './db.js';
import { generateJson, llmConfig } from './llm.js';
import { buildRequirementCoverage, inventoryForJob } from './requirements.js';
import { currentResume, validateResumeDocument } from './resumes.js';
import { renderResumePdf, resolveLayoutProfile } from './resume-renderer.js';
import { parseJson, tokenize } from './utils.js';
import { writeYaml } from './workspace.js';

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function copy(value) { return structuredClone(value); }
function metrics(text) { return [...String(text || '').matchAll(/(?:\$[\d,.]+|\d+(?:\.\d+)?%|\d+x|\b\d{2,}\b)/gi)].map(match => match[0]); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function fixedExperience(entry) { return { id: entry.id, employer: entry.employer, title: entry.title, location: entry.location, startDate: entry.startDate, endDate: entry.endDate, dateSource: entry.dateSource }; }
function proofRecord(proof) { return { ...proof, skills: parseJson(proof.skills_json, []), metrics: parseJson(proof.metrics_json, []) }; }

export const RESUME_TRANSFORMATION_SCHEMA = {
  schemaVersion: 1,
  fields: {
    summary: '{text, proofPointIds[]}',
    bullets: '[{sourceBulletId, proofPointIds[], text}]',
    selectedSkillIds: 'string[]',
    layoutProfileId: 'professional|technical|leadership',
    warnings: 'string[]'
  },
  forbiddenFields: ['identity', 'employers', 'titles', 'dates', 'education', 'credentials']
};

function activeProofMap(proofs) {
  return new Map(proofs.filter(proof => proof.status === 'active' && proof.verification_status === 'verified').map(proof => [proof.id, proof]));
}
function sourceBulletMap(document) {
  const bullets = [];
  for (const experience of document.experience || []) for (const bullet of experience.bullets || []) bullets.push(bullet);
  for (const project of document.projects || []) for (const bullet of project.bullets || []) bullets.push(bullet);
  return new Map(bullets.map(bullet => [bullet.id, bullet]));
}
function unsupportedTransformationMetrics(text, proofPointIds, proofById) {
  const allowed = new Set(proofPointIds.flatMap(proofPointId => {
    const proof = proofById.get(proofPointId);
    return proof ? (proof.metrics || parseJson(proof.metrics_json, [])) : [];
  }));
  return metrics(text).filter(metric => !allowed.has(metric));
}

const CLAIM_STOP = new Set([
  'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how',
  'but', 'not', 'nor', 'than', 'yet', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'less', 'some', 'such', 'same', 'only', 'just', 'even',
  'still', 'also', 'very', 'too', 'can', 'could', 'may', 'might', 'must',
  'should', 'would', 'shall', 'have', 'has', 'had', 'been', 'being', 'does',
  'did', 'into', 'onto', 'upon', 'over', 'under', 'above', 'below', 'between',
  'among', 'through', 'during', 'before', 'after', 'since', 'until', 'within',
  'without', 'against', 'across', 'along', 'around', 'behind', 'beyond',
  'toward', 'towards', 'including', 'while', 'although', 'though', 'because',
  'unless', 'whether', 'either', 'neither', 'however', 'therefore', 'moreover',
  'furthermore', 'nevertheless', 'nonetheless', 'accordingly', 'consequently',
  'thus', 'hence', 'indeed', 'perhaps', 'maybe', 'approximately', 'roughly',
  'nearly', 'almost', 'his', 'her', 'its', 'their', 'them', 'they', 'she',
  'him', 'was', 'were', 'per', 'via', 'off', 'out', 'down', 'here', 'there',
  'now', 'then', 'once', 'again', 'already', 'always', 'never', 'often',
  'sometimes', 'usually', 'about',
]);

function claimTokens(text) {
  return tokenize(text).filter(token => !CLAIM_STOP.has(token));
}

function supportedClaimVocabulary(sourceText, proofPointIds, proofById) {
  const vocab = new Set(claimTokens(sourceText));
  for (const proofPointId of proofPointIds) {
    const proof = proofById.get(proofPointId);
    if (!proof) continue;
    for (const token of claimTokens(proof.summary || '')) vocab.add(token);
    const skills = Array.isArray(proof.skills) ? proof.skills : parseJson(proof.skills_json, []);
    for (const token of claimTokens(skills.join(' '))) vocab.add(token);
    const proofMetrics = Array.isArray(proof.metrics) ? proof.metrics : parseJson(proof.metrics_json, []);
    for (const metric of proofMetrics) for (const token of claimTokens(metric)) vocab.add(token);
  }
  return vocab;
}

function unsupportedClaimTerms(text, sourceText, proofPointIds, proofById) {
  const vocab = supportedClaimVocabulary(sourceText, proofPointIds, proofById);
  return [...new Set(claimTokens(text).filter(token => !vocab.has(token)))];
}


export function applyResumeTransformations(canonical, transformations, proofs) {
  const document = copy(canonical);
  const warnings = [];
  const proofById = activeProofMap(proofs);
  const sourceById = sourceBulletMap(canonical);
  const input = transformations && typeof transformations === 'object' && !Array.isArray(transformations) ? transformations : {};
  const summary = input.summary;
  if (summary?.text) {
    const text = String(summary.text).trim();
    const proofPointIds = unique((Array.isArray(summary.proofPointIds) ? summary.proofPointIds : []).filter(proofId => proofById.has(proofId)));
    const unsupportedMetrics = unsupportedTransformationMetrics(text, proofPointIds, proofById);
    const unsupportedTerms = unsupportedClaimTerms(text, canonical.summary?.text || '', proofPointIds, proofById);
    if (!proofPointIds.length) warnings.push('Dropped generated summary because it did not cite active verified proof points.');
    else if (unsupportedMetrics.length) warnings.push(`Dropped generated summary because metrics lack cited evidence: ${unsupportedMetrics.join(', ')}.`);
    else if (unsupportedTerms.length) warnings.push(`Dropped generated summary because it contains terms not supported by the canonical source or cited evidence: ${unsupportedTerms.join(', ')}.`);
    else document.summary = { ...document.summary, text, proofPointIds, generated: true };
  }
  const rewrites = new Map();
  for (const item of Array.isArray(input.bullets) ? input.bullets : []) {
    const text = String(item?.text || '').trim();
    const source = sourceById.get(String(item?.sourceBulletId || ''));
    const proofPointIds = unique((Array.isArray(item?.proofPointIds) ? item.proofPointIds : []).filter(proofId => proofById.has(proofId)));
    const unsupportedMetrics = unsupportedTransformationMetrics(text, proofPointIds, proofById);
    const unsupportedTerms = source ? unsupportedClaimTerms(text, source.text || '', proofPointIds, proofById) : [];
    if (!source || !text || !proofPointIds.length) {
      warnings.push(`Dropped invalid bullet transformation for source ${String(item?.sourceBulletId || 'unknown')}.`);
      continue;
    }
    if (unsupportedMetrics.length) {
      warnings.push(`Dropped bullet transformation for source ${String(item?.sourceBulletId || 'unknown')} because metrics lack cited evidence: ${unsupportedMetrics.join(', ')}.`);
      continue;
    }
    if (unsupportedTerms.length) {
      warnings.push(`Dropped bullet transformation for source ${String(item?.sourceBulletId || 'unknown')} because it contains terms not supported by the canonical source or cited evidence: ${unsupportedTerms.join(', ')}.`);
      continue;
    }
    rewrites.set(source.id, { ...source, text, proofPointIds, generated: true });
  }
  for (const experience of document.experience || []) experience.bullets = (experience.bullets || []).map(bullet => rewrites.get(bullet.id) || bullet);
  for (const project of document.projects || []) project.bullets = (project.bullets || []).map(bullet => rewrites.get(bullet.id) || bullet);
  if (Array.isArray(input.selectedSkillIds)) {
    const selected = new Set(input.selectedSkillIds.map(String));
    const ordered = document.skills.filter(skill => selected.has(skill.id));
    const remainder = document.skills.filter(skill => !selected.has(skill.id));
    document.skills = [...ordered, ...remainder];
    const invalid = input.selectedSkillIds.filter(skillId => !document.skills.some(skill => skill.id === skillId));
    if (invalid.length) warnings.push(`Ignored unknown skill IDs: ${invalid.join(', ')}.`);
  }
  return { document, warnings: [...warnings, ...(Array.isArray(input.warnings) ? input.warnings.map(String) : [])], layoutProfileId: ['professional', 'technical', 'leadership'].includes(input.layoutProfileId) ? input.layoutProfileId : null };
}
function groundCanonicalClaims(document, proofs) {
  const output = copy(document);
  const proofById = activeProofMap(proofs);
  const bySourceEntry = new Map();
  for (const proof of proofById.values()) {
    if (proof.source_resume_entry_id) bySourceEntry.set(proof.source_resume_entry_id, [...(bySourceEntry.get(proof.source_resume_entry_id) || []), proof.id]);
  }
  for (const section of ['experience', 'projects']) {
    for (const entry of output[section] || []) {
      for (const bullet of entry.bullets || []) {
        const linked = unique([...(bullet.proofPointIds || []).filter(proofPointId => proofById.has(proofPointId)), ...(bySourceEntry.get(bullet.id) || [])]);
        if (linked.length) {
          bullet.proofPointIds = linked;
          continue;
        }
        const bulletTokens = new Set(tokenize(bullet.text));
        const bulletMetrics = metrics(bullet.text);
        const candidate = [...proofById.values()].map(proof => {
          const proofTokens = new Set(tokenize(`${proof.summary || ''} ${proof.evidence || ''}`));
          const overlap = [...bulletTokens].filter(token => proofTokens.has(token)).length;
          const proofMetrics = new Set(proof.metrics || parseJson(proof.metrics_json, []));
          const metricsSupported = bulletMetrics.every(metric => proofMetrics.has(metric));
          return { proof, overlap, metricsSupported };
        }).filter(item => item.overlap >= 2 && item.metricsSupported).sort((left, right) => right.overlap - left.overlap || String(left.proof.id).localeCompare(String(right.proof.id)))[0];
        bullet.proofPointIds = candidate ? [candidate.proof.id] : [];
      }
    }
  }
  return output;
}


function reorderByCoverage(document, coverage) {
  const selectedProofIds = new Set(coverage.matrix.filter(item => item.status === 'supported').flatMap(item => item.proofPointIds));
  const output = copy(document);
  const score = bullet => (bullet.proofPointIds || []).some(proofId => selectedProofIds.has(proofId)) ? 1 : 0;
  for (const experience of output.experience || []) experience.bullets = (experience.bullets || []).map((bullet, index) => ({ bullet, index })).sort((left, right) => score(right.bullet) - score(left.bullet) || left.index - right.index).map(item => item.bullet);
  for (const project of output.projects || []) project.bullets = (project.bullets || []).map((bullet, index) => ({ bullet, index })).sort((left, right) => score(right.bullet) - score(left.bullet) || left.index - right.index).map(item => item.bullet);
  const termOrder = new Map(coverage.matrix.flatMap(item => item.matchedTerms).map((term, index) => [term.toLowerCase(), index]));
  output.skills = (output.skills || []).map((skill, index) => ({ skill, index, rank: termOrder.get(String(skill.name).toLowerCase()) ?? Number.MAX_SAFE_INTEGER })).sort((left, right) => left.rank - right.rank || left.index - right.index).map(item => item.skill);
  return output;
}

export function validateTailoredResume({ document, canonical, proofs, coverage, sourceResumeRevisionId }) {
  const base = validateResumeDocument(document);
  const blockers = [...base.blockers];
  const warnings = [...base.warnings];
  const proofById = activeProofMap(proofs);
  const sourceById = sourceBulletMap(canonical);
  if (!sourceResumeRevisionId) blockers.push({ code: 'resume_source_missing', message: 'Canonical source revision is missing.' });
  if (!same(document.identity, canonical.identity)) blockers.push({ code: 'resume_unsupported_claim', field: 'identity', message: 'Identity must match the canonical resume.' });
  const canonicalExperience = new Map((canonical.experience || []).map(entry => [entry.id, entry]));
  if ((document.experience || []).length !== canonicalExperience.size) blockers.push({ code: 'resume_document_incomplete', field: 'experience', message: 'No canonical experience may be silently dropped.' });
  for (const entry of document.experience || []) {
    const source = canonicalExperience.get(entry.id);
    if (!source || !same(fixedExperience(entry), fixedExperience(source))) blockers.push({ code: 'resume_unsupported_claim', field: `experience.${entry.id}`, message: 'Employer, title, location, and dates must match the canonical source.' });
  }
  for (const section of ['education', 'credentials', 'additionalSections']) if (!same(document[section], canonical[section])) blockers.push({ code: 'resume_unsupported_claim', field: section, message: `${section} must remain unchanged from the canonical source.` });
  const canonicalProjectFacts = (canonical.projects || []).map(({ bullets, ...project }) => project);
  const documentProjectFacts = (document.projects || []).map(({ bullets, ...project }) => project);
  if (!same(documentProjectFacts, canonicalProjectFacts)) blockers.push({ code: 'resume_unsupported_claim', field: 'projects', message: 'Project facts must remain unchanged from the canonical source.' });
  const canonicalSkillIds = new Set((canonical.skills || []).map(skill => skill.id));
  if ((document.skills || []).some(skill => !canonicalSkillIds.has(skill.id))) blockers.push({ code: 'resume_unsupported_claim', field: 'skills', message: 'Generated skills must exist in the canonical resume.' });
  const validateGenerated = (entry, source) => {
    const cited = unique(entry.proofPointIds || []).map(proofId => proofById.get(proofId)).filter(Boolean);
    if (!cited.length) blockers.push({ code: 'resume_unsupported_claim', sourceEntryId: entry.id, message: entry.generated ? 'Changed accomplishment text requires active verified proof.' : 'Every emitted accomplishment requires an active verified proof.' });
    const allowedMetrics = new Set(cited.flatMap(proof => proof.metrics || parseJson(proof.metrics_json, [])));
    const unsupportedMetrics = metrics(entry.text).filter(metric => !allowedMetrics.has(metric));
    if (unsupportedMetrics.length) blockers.push({ code: 'resume_unsupported_metric', sourceEntryId: entry.id, metrics: unsupportedMetrics, message: `Generated metrics lack cited evidence: ${unsupportedMetrics.join(', ')}.` });
    if (entry.text !== source?.text) {
      const unsupportedTerms = unsupportedClaimTerms(entry.text, source?.text || '', entry.proofPointIds || [], proofById);
      if (unsupportedTerms.length) blockers.push({ code: 'resume_unsupported_claim', sourceEntryId: entry.id, terms: unsupportedTerms, message: `Generated text contains terms not supported by the canonical source or cited evidence: ${unsupportedTerms.join(', ')}.` });
    }
  };
  if (base.warnings.some(warning => warning.code === 'resume_source_unverified')) blockers.push({ code: 'resume_source_unverified', message: 'Canonical resume fields require verification before review.' });
  if (document.summary && (document.summary.generated || document.summary.text !== canonical.summary?.text)) validateGenerated(document.summary, canonical.summary);
  for (const entry of [...(document.experience || []).flatMap(experience => experience.bullets || []), ...(document.projects || []).flatMap(project => project.bullets || [])]) {
    const source = sourceById.get(entry.id);
    if (!source) blockers.push({ code: 'resume_unsupported_claim', sourceEntryId: entry.id, message: 'Tailored bullet lacks a canonical source entry.' });
    else validateGenerated(entry, source);
  }
  if ((coverage?.summary?.supportedImportantCount || 0) < 1) blockers.push({ code: 'resume_critical_requirements_uncovered', message: 'At least one important job requirement needs active verified support.' });
  for (const item of coverage?.unsupported || []) warnings.push({ code: 'resume_requirement_unsupported', requirementId: item.requirementId, message: `Unsupported requirement: ${item.requirement.sourceText}` });
  for (const item of coverage?.partiallySupported || []) warnings.push({ code: 'resume_requirement_partial', requirementId: item.requirementId, message: `Partially supported requirement: ${item.requirement.sourceText}` });
  return { valid: blockers.length === 0, schemaVersion: 1, sourceResumeRevisionId, blockers, warnings };
}
function dateText(entry) {
  const start = entry.dateSource?.startText || entry.startDate || '';
  const end = entry.dateSource?.endText || entry.endDate || (entry.startDate ? 'Present' : '');
  return [start, end].filter(Boolean).join(' – ');
}
function renderEntries(items, render) { return items.length ? items.map(render).join('\n\n') : ''; }
function section(title, content) { return content ? `## ${title}\n\n${content}` : ''; }

export function renderSemanticResumeMarkdown(document, { sectionOrder = ['summary', 'experience', 'skills', 'education', 'credentials', 'projects', 'additionalSections'], roleFamily = 'professional' } = {}) {
  const identity = document.identity;
  const contact = [identity.email, identity.phone, identity.location, ...(identity.links || []).map(link => `${link.label}: ${link.url}`)].filter(Boolean).join(' | ');
  const sections = {
    summary: section(roleFamily === 'leadership' ? 'Executive Summary' : 'Professional Summary', document.summary?.text || ''),
    experience: section('Experience', renderEntries(document.experience || [], entry => `### ${entry.title} — ${entry.employer}\n${[entry.location, dateText(entry)].filter(Boolean).join(' | ')}${entry.bullets?.length ? `\n\n${entry.bullets.map(bullet => `- ${bullet.text}`).join('\n')}` : ''}`)),
    skills: section('Skills', (document.skills || []).map(skill => skill.name).join(' • ')),
    education: section('Education', renderEntries(document.education || [], entry => `### ${entry.degree || entry.field || 'Education'} — ${entry.institution}\n${[entry.field, entry.location, [entry.startDate, entry.endDate].filter(Boolean).join(' – ')].filter(Boolean).join(' | ')}`)),
    credentials: section('Credentials', (document.credentials || []).map(entry => `- ${entry.name}${entry.issuer ? ` — ${entry.issuer}` : ''}${entry.date ? ` (${entry.date})` : ''}`).join('\n')),
    projects: section('Projects', renderEntries(document.projects || [], entry => `### ${entry.name}${entry.url ? ` — ${entry.url}` : ''}\n${entry.description || ''}${entry.bullets?.length ? `\n\n${entry.bullets.map(bullet => `- ${bullet.text}`).join('\n')}` : ''}`)),
    additionalSections: (document.additionalSections || []).map(value => section(value.title, value.entries.map(entry => `- ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`).join('\n'))).join('\n\n')
  };
  return `# ${identity.name}\n\n${contact}\n\n${sectionOrder.map(name => sections[name]).filter(Boolean).join('\n\n')}\n`;
}

function tailoringPrompt(job, profile, canonical, coverage, proofs) {
  return `Return only typed resume transformations. Never return identity, employers, titles, dates, education, credentials, or LaTeX. Use only listed sourceBulletId, proofPointId, and selectedSkillIds. Every rewritten factual claim must cite active proof IDs. Schema: ${JSON.stringify(RESUME_TRANSFORMATION_SCHEMA)}\n\nJOB: ${JSON.stringify({ id: job.id, title: job.title, company: job.company, requirements: inventoryForJob(job) })}\nPROFILE: ${JSON.stringify({ id: profile.id, name: profile.name })}\nCANONICAL: ${JSON.stringify(canonical)}\nCOVERAGE: ${JSON.stringify(coverage)}\nPROOFS: ${JSON.stringify(proofs.map(proof => ({ id: proof.id, summary: proof.summary, metrics: proof.metrics, skills: proof.skills, sourceResumeEntryId: proof.source_resume_entry_id })))}`;
}

export async function tailorResume(s, { jobId, profileId, sectionOrder, layoutProfileId = null, pageSize = 'letter', pageLimit = 2, density = 'standard', format = 'markdown' }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Object.assign(new Error(`Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`), { code: 'profile_job_mismatch', type: 'validation' });
  const source = currentResume(s, profileId);
  if (!source) throw Object.assign(new Error('A canonical resume is required before tailoring.'), { code: 'resume_source_missing', type: 'validation' });
  const proofs = all(s, "SELECT * FROM proof_points WHERE profile_id=? AND status='active' AND verification_status='verified' ORDER BY created_at", [profileId]).map(proofRecord);
  const inventory = inventoryForJob(job);
  const initialCoverage = buildRequirementCoverage(inventory, proofs);
  let document = reorderByCoverage(groundCanonicalClaims(source.document, proofs), initialCoverage);
  const transformationWarnings = [];
  const cfg = llmConfig();
  let mode = 'deterministic';
  let selectedLayout = layoutProfileId;
  if (cfg.configured && proofs.length) {
    try {
      const generated = await generateJson({ schemaName: 'jobos_resume_transformations', system: 'You are a constrained resume content transformer. Never invent facts or alter fixed fields.', user: tailoringPrompt(job, profile, source.document, initialCoverage, proofs) });
      if (generated.ok) {
        const transformed = applyResumeTransformations(document, generated.json, proofs);
        document = transformed.document;
        transformationWarnings.push(...transformed.warnings);
        selectedLayout = transformed.layoutProfileId || selectedLayout;
        mode = 'llm';
      }
    } catch (error) {
      if (error?.type === 'agent_error') throw error;
      transformationWarnings.push(`LLM transformation failed; used deterministic complete resume: ${error.message}`);
    }
  }
  const selectedProofPointIds = unique([...(document.summary?.proofPointIds || []), ...(document.experience || []).flatMap(entry => (entry.bullets || []).flatMap(bullet => bullet.proofPointIds || [])), ...(document.projects || []).flatMap(entry => (entry.bullets || []).flatMap(bullet => bullet.proofPointIds || []))]);
  const coverage = buildRequirementCoverage(inventory, proofs, { selectedProofPointIds });
  const validation = validateTailoredResume({ document, canonical: source.document, proofs, coverage, sourceResumeRevisionId: source.id });
  validation.warnings.push(...transformationWarnings.map(message => ({ code: 'resume_transformation_warning', message })));
  const layoutProfile = resolveLayoutProfile(job, { layout: selectedLayout, sectionOrder, pageSize, pageLimit, density });
  const content = renderSemanticResumeMarkdown(document, layoutProfile);
  const relativePath = path.join('jobs', job.id, 'artifacts', 'resume-tailored.md');
  let renderManifest = { format: 'markdown', status: 'not_requested', blockers: [], warnings: [] };
  const artifact = createArtifact(s, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: relativePath,
    title: `Tailored resume for ${job.title}`,
    content,
    evidence: selectedProofPointIds.map(proofPointId => ({ proofPointId })),
    warnings: validation.warnings.map(warning => warning.message),
    series: { kind: 'resume' },
    auditPayload: { sourceResumeRevisionId: source.id, semanticValidationStatus: validation.valid ? 'passed' : 'blocked', mode },
    mutate: (store, created) => run(store, 'INSERT INTO artifact_resume_documents (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json) VALUES (?,?,?,?,?,?,?,?)', [created.id, 1, source.id, JSON.stringify(document), JSON.stringify(coverage), JSON.stringify(validation), JSON.stringify(layoutProfile), JSON.stringify(renderManifest)])
  });
  if (format === 'pdf') {
    renderManifest = validation.valid
      ? { format: 'pdf', ...renderResumePdf({ statePath: s.p.state, workspacePath: s.p.ws, jobId: job.id, artifact, document, layoutProfile }) }
      : { format: 'pdf', status: 'not_run', blockers: [ { code: 'resume_render_failed', message: 'PDF rendering was not attempted because semantic validation failed.' } ], warnings: [] };
    validation.blockers.push(...(renderManifest.blockers || []));
    validation.warnings.push(...(renderManifest.warnings || []));
    validation.valid = validation.blockers.length === 0 && renderManifest.status === 'passed';
    run(s, 'UPDATE artifact_resume_documents SET validation_json=?,render_manifest_json=? WHERE artifact_id=?', [JSON.stringify(validation), JSON.stringify(renderManifest), artifact.id]);
    run(s, 'UPDATE artifacts SET warnings_json=? WHERE id=?', [JSON.stringify(validation.warnings.map(warning => warning.message)), artifact.id]);
    audit(s, 'artifact.resume_render_completed', 'artifact', artifact.id, { sourceResumeRevisionId: source.id, renderStatus: renderManifest.status, finalValidationStatus: validation.valid ? 'passed' : 'blocked', mode });
    save(s);
  }
  const sidecarBase = path.join(s.p.ws, 'jobs', job.id, 'artifacts', 'resume-tailored');
  writeYaml(`${sidecarBase}.coverage.yaml`, coverage);
  writeYaml(`${sidecarBase}.validation.yaml`, validation);
  writeYaml(`${sidecarBase}.render.yaml`, renderManifest);
  return { ...artifact, sourceResumeRevisionId: source.id, document, coverage, validation, layoutProfile, renderManifest, mode, submissionPerformed: false };
}
