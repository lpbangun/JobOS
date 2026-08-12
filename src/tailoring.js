import path from 'node:path';
import { one, all, run as dbRun, save as dbSave, audit } from './db.js';
import { parseJson, tokenize } from './utils.js';
import { createArtifact } from './artifacts.js';
import { requirements } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';
import { tailorResume } from './resume-tailoring.js';
import { renderCoverLetterPdf } from './cover-letter-renderer.js';
import { retrieveCareerMemory, validateWritingGuidance } from './career-memory-retrieval.js';
import { writeYaml } from './workspace.js';

function memoryEvidence(packet) {
  return packet.rules.length || packet.citations.length
    ? [{ careerMemoryRuleIds: packet.rules.map(rule => rule.id), careerMemoryCitations: packet.citations }]
    : [];
}

function memoryWarnings(packet) {
  return packet.rules.length ? [`Career-memory guidance retrieved and deterministically projected: ${packet.rules.map(rule => rule.id).join(', ')}.`] : [];
}

function memoryRule(packet, type) {
  return packet.rules.find(rule => rule.ruleType === type) || null;
}

function writingVariants(packet) {
  const tone = memoryRule(packet, 'tone')?.value.value || 'baseline';
  return {
    tone,
    template: {
      concise: 'concise_brief', warm: 'warm_letter', analytical: 'evidence_analysis',
      direct: 'direct_brief', narrative: 'narrative_letter', formal: 'formal_letter'
    }[tone] || 'baseline',
    openingVariant: memoryRule(packet, 'opening')?.value.value || null,
    closingVariant: memoryRule(packet, 'closing')?.value.value || null,
  };
}

function guidanceHeader(packet) {
  const variants = writingVariants(packet);
  if (!packet.rules.length) return '';
  return `**Career-memory tone:** ${variants.tone}\n**Career-memory template:** ${variants.template}\n**Opening variant:** ${variants.openingVariant || 'baseline'}\n**Closing variant:** ${variants.closingVariant || 'baseline'}\n\n`;
}

function coverTemplateHeading(packet) {
  const style = writingVariants(packet);
  return {
    concise_brief: '## Concise brief — role and proof',
    warm_letter: '## Warm letter — why this role and evidence',
    evidence_analysis: '## Evidence analysis — role requirements and proof',
    direct_brief: '## Direct brief — fit and evidence',
    narrative_letter: '## Narrative letter — context, evidence, and next step',
    formal_letter: '## Formal letter — candidacy and evidence',
  }[style.template] || '## Letter — role and evidence';
}

function coverOpening({ job, chosen, packet }) {
  const variant = writingVariants(packet).openingVariant;
  return {
    direct: `I am applying for ${job.title} at ${job.company}.`,
    context_first: `The opportunity to contribute as ${job.title} at ${job.company} is compelling, and this letter focuses on the role's stated needs.`,
    proof_first: chosen[0]
      ? `${chosen[0].summary} That verified experience is why I am interested in ${job.title} at ${job.company}.`
      : `I am interested in ${job.title} at ${job.company}.`,
    none: '',
  }[variant] ?? `I am applying for ${job.title} at ${job.company}. The role's stated responsibilities are the focus of this application.`;
}

function coverClosing({ job, candidateName, packet }) {
  const signature = `Sincerely,\n${candidateName}`;
  return {
    gratitude: `Thank you for considering this evidence-grounded draft.\n\n${signature}`,
    call_to_action: `I would welcome a conversation about the role and the verified evidence above.\n\n${signature}`,
    none: signature,
  }[writingVariants(packet).closingVariant] ?? `Thank you for your consideration. I would welcome the opportunity to discuss how this verified experience could support ${job.company} in the ${job.title} role.\n\n${signature}`;
}

function renderedCoverVariants(text, packet) {
  const style = writingVariants(packet);
  const openingChecks = {
    direct: /Dear hiring team,\n\nI am applying for /,
    context_first: /Dear hiring team,\n\nThe work described for /,
    proof_first: /Dear hiring team,\n\n(?!I am applying for |The work described for |\n)/,
    none: /Dear hiring team,\n\n\n\nEvidence I can safely claim|Dear hiring team,\n\n\n\n## Proof-grounded claims/,
  };
  const closingChecks = {
    gratitude: /Thank you for considering this evidence-grounded draft\./,
    call_to_action: /I would welcome a conversation about the role and the verified evidence above\./,
    none: /(?:## Evidence warnings|## External-action gate)/,
  };
  return {
    openingVariant: style.openingVariant && openingChecks[style.openingVariant]?.test(text) ? style.openingVariant : null,
    closingVariant: style.closingVariant && closingChecks[style.closingVariant]?.test(text)
      && (style.closingVariant !== 'none' || !/Thank you for considering this evidence-grounded draft|I would welcome a conversation about the role/.test(text)) ? style.closingVariant : null,
  };
}

function orderedGuidedProofs(proofs, packet) {
  const positioning = memoryRule(packet, 'positioning_priority');
  if (!positioning) return proofs;
  const rank = new Map(positioning.value.proofPointIds.map((proofId, index) => [proofId, index]));
  return proofs.filter(proof => rank.has(proof.id)).sort((left, right) => rank.get(left.id) - rank.get(right.id));
}

function validationProjection(text, packet, proofPointIds) {
  const variants = writingVariants(packet);
  const rendered = renderedCoverVariants(text, packet);
  const candidate = { text, proofPointIds, claims: [], exemplarExcerptHashes: [], ...rendered };
  const validation = validateWritingGuidance(candidate, packet);
  const toneRule = memoryRule(packet, 'tone');
  if (toneRule && !text.includes(coverTemplateHeading(packet))) {
    validation.errors.push({ code: 'memory_writing_tone_invalid', ruleIds: [toneRule.id], details: { expectedTemplate: variants.template } });
    validation.valid = false;
  }
  return { validation, warnings: [] };
}

function relevant(job, proofs) {
  const jt = new Set(tokenize(`${job.title}\n${job.description}`));
  return proofs.map(p => {
    const skills = parseJson(p.skills_json, []), metrics = parseJson(p.metrics_json, []);
    const rel = tokenize(`${p.summary} ${skills.join(' ')}`).filter(t => jt.has(t)).length;
    return { ...p, skills, metrics, relevance: rel };
  }).sort((a, b) => b.relevance - a.relevance);
}

function canonicalIdentity(s, profileId) {
  const row = one(s, 'SELECT document_json FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profileId]);
  const document = parseJson(row?.document_json, {});
  return {
    identity: document.identity || {},
    name: String(document.identity?.name || '').trim(),
  };
}

function canonicalCandidateName(s, profileId, fallback) {
  const { name } = canonicalIdentity(s, profileId);
  return name || fallback || 'Candidate';
}

function coverBody({ job, chosen, memory, candidateName }) {
  return {
    salutation: 'Dear hiring team,',
    opening: coverOpening({ job, chosen, packet: memory }),
    paragraphs: coverProofParagraphs(chosen),
    closing: coverClosing({ job, candidateName, packet: memory }),
  };
}

function coverLetterDocument(s, profileId, { job, chosen, memory, candidateName }) {
  const { identity } = canonicalIdentity(s, profileId);
  return {
    identity,
    candidateName,
    ...coverBody({ job, chosen, memory, candidateName }),
  };
}

function coverProofParagraphs(proofs) {
  if (!proofs.length) return '[Add a verified proof point before sending.]';
  return proofs.slice(0, 2).map((proof, index) => (
    `${index === 0 ? 'One relevant example' : 'A second relevant example'} from my verified records: ${proof.summary}`
  )).join('\n\n');
}

function saveArtifact(s, { job, prof, type, title, file, content, evidence, warnings }) {
  const rel = path.join('jobs', job.id, 'artifacts', file);
  return createArtifact(s, {
    jobId: job.id,
    profileId: prof.id,
    type,
    path: rel,
    title,
    content,
    evidence,
    warnings,
    series: { kind: type }
  });
}

function fallbackResume({ job, prof, chosen, warnings }) {
  const warningBlock = warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None from deterministic evidence checks.';
  const bullets = chosen.length ? chosen.map(p => `- ${p.summary}${p.evidence ? ` _(evidence: ${p.evidence})_` : ''}${p.metrics?.length ? ` Metrics: ${p.metrics.join(', ')}` : ''}`).join('\n') : '- Add evidence-backed accomplishments before using this resume externally.';
  const reqBlock = requirements(job.description).length ? requirements(job.description).map(r => `- ${r}`).join('\n') : '- No explicit requirements extracted from the job text.';
  return `# Tailored resume draft — ${prof.name} for ${job.title}\n\n**Company:** ${job.company}\n\n**Approval status:** Draft; human review required before submission.\n\n## Target role summary\nUse this degraded-mode draft as a source-grounded outline. It includes only stored proof points; it does not invent metrics, employers, credentials, or claims. Configure an LLM provider for stronger tailoring.\n\n## Evidence-backed highlights\n${bullets}\n\n## Job requirements to address\n${reqBlock}\n\n## Evidence warnings\n${warningBlock}\n\n## Human review checklist\n- Confirm every claim is true and current.\n- Add missing proof points for important requirements before exporting a final resume.\n- Do not submit from JobOS; external applications remain human-gated.\n`;
}

function fallbackCover({ job, chosen, warnings, memory, candidateName }) {
  const warningBlock = warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None from deterministic evidence checks.';
  const body = coverBody({ job, chosen, memory, candidateName });
  const template = memory.rules.length ? `${coverTemplateHeading(memory)}\n\n` : '';
  const review = memory.rules.length ? '\n\nDuring human review, compare each selected proof with the role requirements, preserve its source meaning, and remove any statement that cannot be verified from the stored evidence.' : '';
  return {
    content: `# Cover letter draft — ${job.title} at ${job.company}\n\n**Approval status:** Draft; human review required before sending.\n\n${guidanceHeader(memory)}${template}${body.salutation}\n\n${body.opening}\n\n${body.paragraphs}${review}\n\n${body.closing}\n\n## Evidence warnings\n${warningBlock}\n\n## External-action gate\nJobOS generated this draft only. It did not send email, submit forms, or contact anyone.\n`,
    chosen,
    body,
    evidence: chosen.map(p => ({ proofPointId: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics })),
  };
}

function tailoringPrompt({ kind, job, prof, proofs, memory, candidateName }) {
  return `Create a ${kind === 'resume' ? 'tailored resume' : 'cover letter'} draft for this job. Use ONLY the supplied proof points for claims. Do not invent employers, metrics, credentials, or accomplishments. Return JSON with title, summary, requirementProofMap array of at least 3 items when possible ({requirement, proofPointId, bullet}), warnings array, and coverLetter string for cover-letter work. Include only proofPointId values that appear in PROOF POINTS.\n\nCAREER MEMORY (bounded public guidance):\n${JSON.stringify(memory, null, 2)}\n\nPROFILE:\n${JSON.stringify({ id: prof.id, profileLabel: prof.name, candidateName, preferences: parseJson(prof.preferences_json, {}) }, null, 2)}\n\nPROOF POINTS:\n${JSON.stringify(proofs.map(p => ({ id: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics })), null, 2)}\n\nJOB:\n${JSON.stringify({ id: job.id, title: job.title, company: job.company, description: job.description }, null, 2)}`;
}

function groundedItems(json, proofById) {
  return (Array.isArray(json.requirementProofMap) ? json.requirementProofMap : [])
    .filter(x => proofById.has(x.proofPointId))
    .map(x => ({ ...x, proof: proofById.get(x.proofPointId) }));
}

function groundedBullet(item) {
  const metrics = item.proof.metrics?.length ? ` Metrics: ${item.proof.metrics.join(', ')}` : '';
  return `${item.proof.summary}${metrics}`;
}

function mappedRequirement(item, index, job) {
  const candidate = String(item.requirement || '').trim();
  if (candidate && candidate.length <= 180 && String(job.description || '').toLowerCase().includes(candidate.toLowerCase())) return candidate;
  return `Job requirement ${index + 1}`;
}

function renderLlmResume({ job, prof, json, proofById }) {
  const items = groundedItems(json, proofById);
  const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : [];
  if (items.length < 3) warnings.push('LLM returned fewer than three valid proof-grounded requirement mappings; add proof points or review manually.');
  const map = items.length ? items.map((x, idx) => `- **${mappedRequirement(x, idx, job)}:** ${groundedBullet(x)} _(proof: ${x.proofPointId})_`).join('\n') : '- Add evidence-backed proof mappings before external use.';
  const warningBlock = warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None; every generated claim below is linked to a stored proof point.';
  const summary = `${prof.name} evidence-grounded draft for ${job.title} at ${job.company}. The only accomplishment claims in this draft are the proof-linked bullets below.`;
  return { content: `# LLM tailored resume draft — ${prof.name} for ${job.title}\n\n**Company:** ${job.company}\n\n**Approval status:** Draft; human review required before submission.\n\n## Target role summary\n${summary}\n\n## Requirement-to-proof map\n${map}\n\n## Evidence warnings\n${warningBlock}\n\n## Human review checklist\n- Confirm every claim is true and current.\n- Confirm the resume format before submission.\n- Do not submit from JobOS; external applications remain human-gated.\n`, warnings, evidence: items.map((x, idx) => ({ proofPointId: x.proofPointId, requirement: mappedRequirement(x, idx, job), summary: x.proof.summary, metrics: x.proof.metrics })) };
}

function renderLlmCover({ job, json, proofById, memory, candidateName }) {
  const items = groundedItems(json, proofById);
  const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : [];
  if (!items.length) warnings.push('LLM returned no valid proof-grounded cover-letter mappings; add proof points or review manually.');
  if (json.coverLetter) warnings.push('LLM cover-letter prose was omitted; JobOS renders only proof-grounded claims plus neutral role/company context.');
  const selectedItems = items.slice(0, 2);
  const chosen = selectedItems.map(item => item.proof);
  const body = coverBody({ job, chosen, memory, candidateName });
  const template = memory.rules.length ? `${coverTemplateHeading(memory)}\n\n` : '';
  return {
    content: `# LLM cover letter draft — ${job.title} at ${job.company}\n\n**Approval status:** Draft; human review required before sending.\n\n${template}${body.salutation}\n\n${body.opening}\n\n${body.paragraphs}\n\n${body.closing}\n\n## Evidence warnings\n${warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None; proof-grounded draft.'}\n\n## External-action gate\nJobOS generated this draft only. It did not send email, submit forms, or contact anyone.\n`,
    warnings,
    chosen,
    body,
    evidence: selectedItems.map(item => ({ proofPointId: item.proofPointId, requirement: item.requirement, summary: item.proof.summary, metrics: item.proof.metrics }))
  };
}

export async function tailor(s, jid, pid, kind, options = {}) {
  if (kind === 'resume') return tailorResume(s, { jobId: jid, profileId: pid, ...options });
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (!prof) throw Error(`Unknown profile: ${pid}`);
  if (job.profile_id !== pid) throw Object.assign(new Error(`Job ${jid} belongs to profile ${job.profile_id}, not ${pid}`), { code: 'profile_job_mismatch', type: 'validation' });
  const candidateName = canonicalCandidateName(s, pid, prof.name);
  const memory = retrieveCareerMemory(s, { profileId: pid, consumer: 'tailoring', jobId: jid, artifactType: 'cover_letter' });
  const proofs = all(s, "SELECT * FROM proof_points WHERE profile_id=? AND status='active' AND verification_status='verified'", [pid]);
  const enriched = relevant(job, proofs);
  const chosen = orderedGuidedProofs(enriched.filter(p => p.relevance > 0), memory).slice(0, 2);
  const warnings = memoryWarnings(memory);
  if (!proofs.length) warnings.push('No active verified proof points exist for this profile; draft intentionally avoids unsupported achievement claims.');
  else if (!chosen.length) warnings.push('No proof points matched job language; add evidence before strengthening this artifact.');
  const proofById = new Map(orderedGuidedProofs(enriched, memory).map(p => [p.id, p]));
  const cfg = llmConfig();
  let rendered = null;
  let mode = 'deterministic';

  if (cfg.configured && proofs.length) {
    try {
      const result = await generateJson({
        schemaName: 'jobos_cover_letter',
        system: 'You are JobOS tailoring. You create useful drafts while strictly grounding every achievement claim in supplied proof point IDs.',
        user: tailoringPrompt({ kind, job, prof, proofs: enriched, memory, candidateName })
      });
      if (result.ok) {
        const candidate = renderLlmCover({ job, json: result.json, proofById, memory, candidateName });
        const guidedContent = `${guidanceHeader(memory)}${candidate.content}`;
        const projected = validationProjection(guidedContent, memory, candidate.evidence.map(item => item.proofPointId));
        if (projected.validation.valid) {
          rendered = { ...candidate, content: guidedContent, warnings: [...candidate.warnings, ...projected.warnings, ...memoryWarnings(memory)] };
          mode = 'llm';
        } else {
          warnings.push(`LLM tailoring output failed career-memory validation (${projected.validation.errors.map(error => error.code).join(', ')}); used deterministic renderer.`);
        }
      }
    } catch (e) {
      if (e?.type === 'agent_error') throw e;
      warnings.push(`LLM tailoring failed; used deterministic degraded-mode draft instead: ${e.message}`);
    }
  }

  if (!rendered) {
    const fallback = fallbackCover({ job, chosen, warnings, memory, candidateName });
    const projected = validationProjection(fallback.content, memory, fallback.chosen.map(proof => proof.id));
    if (!projected.validation.valid) throw Object.assign(new Error('Deterministic tailoring renderer failed career-memory validation.'), { code: 'memory_writing_fallback_invalid', type: 'validation', details: projected.validation.errors });
    rendered = { ...fallback, warnings: [...warnings, ...projected.warnings] };
  }

  const artifact = saveArtifact(s, { job, prof, type: 'cover_letter', title: `Cover letter for ${job.title}`, file: 'cover-letter.md', content: rendered.content, evidence: [...rendered.evidence, ...memoryEvidence(memory)], warnings: rendered.warnings });
  let renderManifest = { format: 'markdown', status: 'not_requested', blockers: [], warnings: [] };
  if (options.format === 'pdf') {
    const document = coverLetterDocument(s, pid, { job, chosen: rendered.chosen || chosen, memory, candidateName });
    renderManifest = { format: 'pdf', ...renderCoverLetterPdf({ statePath: s.p.state, workspacePath: s.p.ws, jobId: jid, artifact, document, layoutProfile: { pageSize: options.pageSize, pageLimit: options.pageLimit } }) };
    if (renderManifest.blockers?.length || renderManifest.warnings?.length) {
      const mergedWarnings = [...rendered.warnings, ...(renderManifest.warnings || []).map(warning => warning.message), ...(renderManifest.blockers || []).map(blockerItem => blockerItem.message)];
      dbRun(s, 'UPDATE artifacts SET warnings_json=? WHERE id=?', [JSON.stringify(mergedWarnings), artifact.id]);
    }
    writeYaml(path.join(s.p.ws, 'jobs', jid, 'artifacts', 'cover-letter.render.yaml'), renderManifest);
    audit(s, 'artifact.cover_letter_render_completed', 'artifact', artifact.id, { renderStatus: renderManifest.status, mode });
    dbSave(s);
  }
  return { ...artifact, mode, renderManifest };
}
