import fs from 'node:fs';
import path from 'node:path';
import { one, all, run, save, audit } from './db.js';
import { id, now, parseJson, tokenize } from './utils.js';
import { writeMd } from './workspace.js';
import { requirements } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';

function relevant(job, proofs) {
  const jt = new Set(tokenize(`${job.title}\n${job.description}`));
  return proofs.map(p => {
    const skills = parseJson(p.skills_json, []), metrics = parseJson(p.metrics_json, []);
    const rel = tokenize(`${p.summary} ${skills.join(' ')}`).filter(t => jt.has(t)).length;
    return { ...p, skills, metrics, relevance: rel };
  }).sort((a, b) => b.relevance - a.relevance);
}

function saveArtifact(s, { job, prof, type, title, file, content, evidence, warnings }) {
  const rel = path.join('jobs', job.id, 'artifacts', file), abs = path.join(s.p.ws, rel), at = now(), aid = id('artifact', `${type}:${job.id}:${prof.id}:${at}`);
  writeMd(abs, content);
  run(s, 'INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?)', [aid, job.id, prof.id, type, rel, title, content, JSON.stringify(evidence), JSON.stringify(warnings), 'draft_needs_human_review', at]);
  audit(s, 'artifact.created', 'artifact', aid, { jobId: job.id, profileId: prof.id, type, path: rel, approvalStatus: 'draft_needs_human_review' });
  save(s);
  return { id: aid, path: rel, approvalStatus: 'draft_needs_human_review', warnings };
}

function fallbackResume({ job, prof, chosen, warnings }) {
  const warningBlock = warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None from deterministic evidence checks.';
  const bullets = chosen.length ? chosen.map(p => `- ${p.summary}${p.evidence ? ` _(evidence: ${p.evidence})_` : ''}${p.metrics?.length ? ` Metrics: ${p.metrics.join(', ')}` : ''}`).join('\n') : '- Add evidence-backed accomplishments before using this resume externally.';
  const reqBlock = requirements(job.description).length ? requirements(job.description).map(r => `- ${r}`).join('\n') : '- No explicit requirements extracted from the job text.';
  return `# Tailored resume draft — ${prof.name} for ${job.title}\n\n**Company:** ${job.company}\n\n**Approval status:** Draft; human review required before submission.\n\n## Target role summary\nUse this degraded-mode draft as a source-grounded outline. It includes only stored proof points; it does not invent metrics, employers, credentials, or claims. Configure an LLM provider for stronger tailoring.\n\n## Evidence-backed highlights\n${bullets}\n\n## Job requirements to address\n${reqBlock}\n\n## Evidence warnings\n${warningBlock}\n\n## Human review checklist\n- Confirm every claim is true and current.\n- Add missing proof points for important requirements before exporting a final resume.\n- Do not submit from JobOS; external applications remain human-gated.\n`;
}

function fallbackCover({ job, prof, chosen, warnings }) {
  const warningBlock = warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None from deterministic evidence checks.';
  const proofParagraph = chosen.length ? chosen.map(p => `- ${p.summary}${p.evidence ? ` (evidence: ${p.evidence})` : ''}`).join('\n') : '- [Add a verified proof point before sending.]';
  return `# Cover letter draft — ${job.title} at ${job.company}\n\n**Approval status:** Draft; human review required before sending.\n\nDear hiring team,\n\nI am interested in ${job.title} at ${job.company}. The role appears aligned with my ${prof.name} search profile.\n\nEvidence I can safely claim from my proof library:\n${proofParagraph}\n\nI would tailor the final version after confirming the job requirements, company context, and any sensitive screening questions manually.\n\n## Evidence warnings\n${warningBlock}\n\n## External-action gate\nJobOS generated this draft only. It did not send email, submit forms, or contact anyone.\n`;
}

function tailoringPrompt({ kind, job, prof, proofs }) {
  return `Create a ${kind === 'resume' ? 'tailored resume' : 'cover letter'} draft for this job. Use ONLY the supplied proof points for claims. Do not invent employers, metrics, credentials, or accomplishments. Return JSON with title, summary, requirementProofMap array of at least 3 items when possible ({requirement, proofPointId, bullet}), warnings array, and coverLetter string for cover-letter work. Include only proofPointId values that appear in PROOF POINTS.\n\nPROFILE:\n${JSON.stringify({ id: prof.id, name: prof.name, preferences: parseJson(prof.preferences_json, {}) }, null, 2)}\n\nPROOF POINTS:\n${JSON.stringify(proofs.map(p => ({ id: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics })), null, 2)}\n\nJOB:\n${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, requirements: requirements(job.description) }, null, 2)}\n\nThe rendered output will include a Requirement-to-proof map, so make that map concrete and useful.`;
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

function renderLlmCover({ job, prof, json, proofById }) {
  const items = groundedItems(json, proofById);
  const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : [];
  if (!items.length) warnings.push('LLM returned no valid proof-grounded cover-letter mappings; add proof points or review manually.');
  const proofLines = items.map(x => `- ${groundedBullet(x)} _(proof: ${x.proofPointId})_`).join('\n') || '- [Add a verified proof point before sending.]';
  if (json.coverLetter) warnings.push('LLM cover-letter prose was omitted; JobOS renders only proof-grounded claims plus neutral role/company context.');
  const letter = `Dear hiring team,\n\nI am interested in ${job.title} at ${job.company}. The role appears to connect with my ${prof.name} search profile, and the proof-grounded examples below are the only accomplishment claims JobOS is staging for human review.`;
  return { content: `# LLM cover letter draft — ${job.title} at ${job.company}\n\n**Approval status:** Draft; human review required before sending.\n\n${letter}\n\n## Proof-grounded claims\n${proofLines}\n\n## Evidence warnings\n${warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None; proof-grounded draft.'}\n\n## External-action gate\nJobOS generated this draft only. It did not send email, submit forms, or contact anyone.\n`, warnings, evidence: items.map(x => ({ proofPointId: x.proofPointId, requirement: x.requirement, summary: x.proof.summary, metrics: x.proof.metrics })) };
}

export async function tailor(s, jid, pid, kind) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (!prof) throw Error(`Unknown profile: ${pid}`);
  const proofs = all(s, 'SELECT * FROM proof_points WHERE profile_id=?', [pid]);
  const enriched = relevant(job, proofs);
  const chosen = enriched.filter(p => p.relevance > 0).slice(0, kind === 'resume' ? 5 : 3);
  const warnings = [];
  if (!proofs.length) warnings.push('No proof points exist for this profile; draft intentionally avoids unsupported achievement claims.');
  else if (!chosen.length) warnings.push('No proof points matched job language; add evidence before strengthening this artifact.');
  const proofById = new Map(enriched.map(p => [p.id, p]));
  const cfg = llmConfig();

  if (cfg.configured && proofs.length) {
    try {
      const result = await generateJson({
        schemaName: kind === 'resume' ? 'jobos_tailored_resume' : 'jobos_cover_letter',
        system: 'You are JobOS tailoring. You create useful drafts while strictly grounding every achievement claim in supplied proof point IDs.',
        user: tailoringPrompt({ kind, job, prof, proofs: enriched })
      });
      if (result.ok) {
        const rendered = kind === 'resume' ? renderLlmResume({ job, prof, json: result.json, proofById }) : renderLlmCover({ job, prof, json: result.json, proofById });
        return saveArtifact(s, { job, prof, type: kind === 'resume' ? 'resume' : 'cover_letter', title: `${kind === 'resume' ? 'Tailored resume' : 'Cover letter'} for ${job.title}`, file: kind === 'resume' ? 'resume-tailored.md' : 'cover-letter.md', content: rendered.content, evidence: rendered.evidence, warnings: rendered.warnings });
      }
    } catch (e) {
      warnings.push(`LLM tailoring failed; used deterministic degraded-mode draft instead: ${e.message}`);
    }
  }

  const evidence = chosen.map(p => ({ proofPointId: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics }));
  const content = kind === 'resume' ? fallbackResume({ job, prof, chosen, warnings }) : fallbackCover({ job, prof, chosen, warnings });
  return saveArtifact(s, { job, prof, type: kind === 'resume' ? 'resume' : 'cover_letter', title: `${kind === 'resume' ? 'Tailored resume' : 'Cover letter'} for ${job.title}`, file: kind === 'resume' ? 'resume-tailored.md' : 'cover-letter.md', content, evidence, warnings });
}
