import path from 'node:path';
import { one, all } from './db.js';
import { now, parseJson, slug, tokenize } from './utils.js';
import { createArtifact } from './artifacts.js';
import { requirements } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';

const stageLabels = {
  'recruiter-screen': 'recruiter screen',
  interview: 'interview',
  'hiring-manager': 'hiring manager interview',
  onsite: 'onsite / panel interview',
  final: 'final interview',
  offer: 'offer conversation'
};

function parseProof(p) {
  return { ...p, skills: parseJson(p.skills_json, []), metrics: parseJson(p.metrics_json, []) };
}

function competencies(job, proofs) {
  const words = new Set(tokenize(`${job.title} ${job.description}`));
  const reqs = requirements(job.description).slice(0, 8);
  const useful = new Set(['discovery','analytics','roadmap','stakeholder','communication','launch','learning','education','ai','workflow','product','strategy','experiments','operations','research','cross-functional']);
  const fromReqs = reqs.map(r => {
    const tokens = tokenize(r).filter(t => useful.has(t) || /discover|analytic|roadmap|stakeholder|launch|learning|product|experiment|research|cross/.test(t));
    return tokens.slice(0, 2).join(' ');
  }).filter(Boolean);
  const proofSkills = proofs.flatMap(p => p.skills || []).map(String).filter(skill => words.has(skill.toLowerCase()) && (useful.has(skill.toLowerCase()) || skill.length > 5));
  return [...new Set([...fromReqs, ...proofSkills, 'product judgment', 'cross-functional leadership'].filter(Boolean))].slice(0, 8);
}

function relevantProofs(job, proofs) {
  const jobTokens = new Set(tokenize(`${job.title} ${job.description}`));
  return proofs.map(p => ({
    ...p,
    relevance: tokenize(`${p.summary} ${(p.skills || []).join(' ')}`).filter(t => jobTokens.has(t)).length
  })).sort((a, b) => b.relevance - a.relevance || a.summary.localeCompare(b.summary));
}

function likelyQuestions(job, stage, comps) {
  const reqs = requirements(job.description).slice(0, 5);
  const role = job.title;
  const company = job.company;
  const base = [
    `How would you approach the first 30-60-90 days as ${role} at ${company}?`,
    `Which signals would you use to decide whether this ${role} work is succeeding?`,
    `Tell me about a time you had to make tradeoffs similar to: ${reqs[0] || 'this role\'s core responsibilities'}.`,
    `What would you need to learn about ${company}'s users, team, and constraints before recommending a roadmap?`
  ];
  if (/recruiter/.test(stage)) base.unshift(`What is your concise narrative for why ${role} at ${company} fits your search now?`);
  if (/manager|onsite|final|interview/.test(stage)) base.push(...comps.slice(0, 4).map(c => `Walk me through a specific example that shows ${c} in a high-stakes work context.`));
  return [...new Set(base)].slice(0, 10);
}

function storyForProof(proof, competency) {
  const metric = proof.metrics?.length ? ` Metrics to mention: ${proof.metrics.join(', ')}.` : '';
  const evidence = proof.evidence ? ` Evidence/source: ${proof.evidence}.` : '';
  return `- **${competency}:** use proof \`${proof.id}\` — ${proof.summary}${metric}${evidence}\n  - Situation: set the context and constraints behind this proof.\n  - Task: explain what you owned or influenced.\n  - Action: name the decisions, collaboration, analysis, or delivery work you performed.\n  - Result: quantify only with stored metrics/evidence; otherwise state the qualitative result and say what you learned.`;
}

function askQuestions(job, facts) {
  const factHooks = facts.slice(0, 3).map(f => `Given ${f.claim}, how is the ${job.title} role expected to contribute over the next two quarters?`);
  return [
    ...factHooks,
    `What are the most important problems this ${job.title} hire should solve in the first six months?`,
    'How does the team make tradeoffs between speed, user learning, and operational quality?',
    'What evidence would make you confident that the person in this role is succeeding?',
    'What should I understand about the team, stakeholders, or constraints that is not visible in the job posting?'
  ].slice(0, 8);
}

function refreshSummary(job, company, facts, stakeholders) {
  const factLines = facts.length ? facts.slice(0, 5).map(f => `- ${f.claim} (${f.url})`).join('\n') : '- No source-backed company facts are stored yet; run `research company --job '+job.id+'` before the interview.';
  const people = stakeholders.length ? stakeholders.slice(0, 5).map(s => `- ${s.name} — ${s.role}: ${s.summary}`).join('\n') : '- No stakeholder research stored yet.';
  return `## Company / role refresh\n- Role: ${job.title}\n- Company: ${job.company}\n- Location: ${job.location || 'not specified'}\n- Application source: ${String(job.url || '').startsWith('jobos:text:') ? 'manual/text import' : job.url || 'not provided'}\n\n### Stored company facts\n${factLines}\n\n### Stakeholder context\n${people}`;
}

function fallbackPacket({ job, prof, app, stage, proofs, company, stakeholders }) {
  const facts = parseJson(company?.facts_json, []);
  const comps = competencies(job, proofs);
  const ranked = relevantProofs(job, proofs);
  const stories = comps.slice(0, 6).map((c, idx) => ranked[idx % Math.max(ranked.length, 1)] ? storyForProof(ranked[idx % ranked.length], c) : `- **${c}:** add a stored proof point before relying on this story.`).join('\n');
  const qs = likelyQuestions(job, stage, comps).map(q => `- ${q}`).join('\n');
  const asks = askQuestions(job, facts).map(q => `- ${q}`).join('\n');
  const proofWarning = proofs.length ? '- Stories below are mapped to stored proof points; verify details before the interview.' : '- No proof points exist for this profile; packet avoids inventing STAR stories.';
  return `# Interview prep packet — ${stageLabels[stage] || stage} for ${job.title} at ${job.company}\n\nGenerated: ${now()}\n\n**Application:** ${app.id} (${app.status})\n**Profile:** ${prof.name}\n**Approval status:** Draft for human review.\n\n${refreshSummary(job, company, facts, stakeholders)}\n\n## Likely interview questions\n${qs}\n\n## STAR story bank mapped to competencies\n${stories || '- Add proof points to generate story mappings.'}\n\n## Questions to ask the interviewer\n${asks}\n\n## Final prep checklist\n- Prepare a 60-second narrative connecting ${prof.name} to ${job.title}.\n- Choose 3 proof-backed stories above and rehearse them out loud.\n- Confirm compensation, location/work model, and next-step timeline directly with the company.\n- Do not claim unstored accomplishments; add proof points if a story is missing.\n\n## Evidence and safety notes\n${proofWarning}\n- JobOS generated an internal prep packet only. It did not contact the company, schedule interviews, or send messages.\n`;
}

function llmPrompt({ job, prof, app, stage, proofs, company, stakeholders }) {
  return `Generate a role-specific interview prep packet as JSON. Do not invent accomplishments. STAR stories must cite supplied proofPointId values only. Return: likelyQuestions array, starStories array ({competency, proofPointId, situation, task, action, result, rehearsalNote}), questionsToAsk array, refreshSummary string, warnings array.\n\nAPPLICATION: ${JSON.stringify(app)}\nPROFILE: ${JSON.stringify({ id: prof.id, name: prof.name, preferences: parseJson(prof.preferences_json, {}) })}\nJOB: ${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, requirements: requirements(job.description) })}\nSTAGE: ${stage}\nCOMPANY_FACTS: ${company?.facts_json || '[]'}\nSTAKEHOLDERS: ${JSON.stringify(stakeholders)}\nPROOF_POINTS: ${JSON.stringify(proofs.map(p => ({ id: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics })))}\n`;
}

function renderLlmPacket({ job, prof, app, stage, json, proofs, company, stakeholders }) {
  const proofIds = new Set(proofs.map(p => p.id));
  const proofById = new Map(proofs.map(p => [p.id, p]));
  const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : [];
  const questions = (Array.isArray(json.likelyQuestions) ? json.likelyQuestions : []).map(String).filter(Boolean).slice(0, 10);
  const stories = (Array.isArray(json.starStories) ? json.starStories : []).filter(s => proofIds.has(s.proofPointId)).slice(0, 8);
  if (stories.length < Math.min(3, proofs.length)) warnings.push('LLM returned fewer than three valid proof-grounded STAR stories; review manually.');
  const facts = parseJson(company?.facts_json, []);
  const qs = (questions.length ? questions : likelyQuestions(job, stage, competencies(job, proofs))).map(q => `- ${q}`).join('\n');
  const storyBlock = stories.length ? stories.map(s => {
    const proof = proofById.get(s.proofPointId);
    const metrics = proof.metrics?.length ? ` Stored metrics: ${proof.metrics.join(', ')}.` : '';
    return `- **${s.competency || 'Role competency'}** _(proof: ${s.proofPointId})_\n  - Proof: ${proof.summary}${metrics}\n  - Situation: set the context using only details you can verify from this proof/evidence.\n  - Task: explain what you personally owned or influenced.\n  - Action: describe decisions, collaboration, analysis, or delivery work that is directly supported by the proof.\n  - Result: quantify only with stored metrics/evidence; otherwise state the qualitative result and learning.\n  - Rehearsal note: ${s.rehearsalNote ? String(s.rehearsalNote).slice(0, 180) : 'Keep it concise and evidence-grounded; do not add unstored details.'}`;
  }).join('\n') : relevantProofs(job, proofs).slice(0, 4).map((p, idx) => storyForProof(p, competencies(job, proofs)[idx] || job.title)).join('\n');
  const asks = (Array.isArray(json.questionsToAsk) && json.questionsToAsk.length ? json.questionsToAsk.map(String) : askQuestions(job, facts)).slice(0, 8).map(q => `- ${q}`).join('\n');
  return `# LLM interview prep packet — ${stageLabels[stage] || stage} for ${job.title} at ${job.company}\n\nGenerated: ${now()}\n\n**Application:** ${app.id} (${app.status})\n**Profile:** ${prof.name}\n**Approval status:** Draft for human review.\n\n${refreshSummary(job, company, facts, stakeholders)}\n\n## Role-specific likely questions\n${qs}\n\n## STAR stories mapped from proof points\n${storyBlock || '- Add proof points to generate story mappings.'}\n\n## Questions to ask the interviewer\n${asks}\n\n## Warnings\n${warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None; story claims are rendered from stored proof summaries/metrics only. LLM suggestions are limited to question selection, competencies, and rehearsal notes.'}\n\n## Human gate\nJobOS generated an internal prep packet only. It did not contact the company, schedule interviews, or send messages.\n`;
}

export async function prepInterview(s, applicationId, stage = 'interview') {
  const app = one(s, 'SELECT * FROM applications WHERE id=?', [applicationId]);
  if (!app) throw Error(`Unknown application: ${applicationId}`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [app.job_id]);
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [app.profile_id]);
  if (!job || !prof) throw Error('Application is missing linked job or profile');
  const proofs = all(s, 'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at', [prof.id]).map(parseProof);
  const company = job.company_id ? one(s, 'SELECT * FROM companies WHERE id=?', [job.company_id]) : null;
  const stakeholders = all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [job.id]).map(st => ({ ...st, links: parseJson(st.links_json, []) }));
  // Look up the latest people-research run for this job
  const researchRun = one(s, `SELECT id,status,finished_at FROM research_runs WHERE job_id=? AND profile_id=? AND scope='job' AND status IN ('succeeded','partial') ORDER BY finished_at DESC LIMIT 1`, [job.id, prof.id]);
  const researchInfo = researchRun
    ? { runId: researchRun.id, finishedAt: researchRun.finished_at, stale: !researchRun.finished_at || researchRun.finished_at < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }
    : null;
  const at = now();
  let content;
  const cfg = llmConfig();
  if (cfg.configured && proofs.length) {
    try {
      const result = await generateJson({ schemaName: 'jobos_interview_prep', system: 'You are JobOS interview prep. Create useful, role-specific prep while grounding every accomplishment in supplied proof IDs.', user: llmPrompt({ job, prof, app, stage, proofs, company, stakeholders }) });
      if (result.ok) content = renderLlmPacket({ job, prof, app, stage, json: result.json, proofs, company, stakeholders });

    } catch (e) {
      if (e?.type === 'agent_error') throw e;
    }
  }
  if (!content) content = fallbackPacket({ job, prof, app, stage, proofs, company, stakeholders });
  // Prepend research run context
  if (researchInfo) {
    const runRel = path.join('research', 'runs', `${researchInfo.runId}.md`);
    const runLine = `\n> Research run: [${researchInfo.runId}](${runRel}) completed ${researchInfo.finishedAt}.`;
    const staleWarning = researchInfo.stale ? ' ⚠️ This research is more than 30 days old. Consider running fresh people research before the interview.' : '';
    content = content + runLine + staleWarning + '\n';
  } else {
    content = content + '\n> ⚠️ No people-research run found for this job. Run `jobos research people --scope job --job <job-id> --depth standard` before the interview for network-aware preparation.\n';
  }
  const safeStage = slug(stage);
  const rel = path.join('jobs', job.id, 'artifacts', `interview-prep-${safeStage}.md`);
  const evidence = proofs.map(p => ({ proofPointId: p.id, summary: p.summary, evidence: p.evidence, metrics: p.metrics }));
  const artifact = createArtifact(s, {
    jobId: job.id,
    profileId: prof.id,
    type: 'interview_prep',
    path: rel,
    title: `Interview prep: ${stage} for ${job.title}`,
    content,
    evidence,
    warnings: [],
    series: { kind: 'interview_prep', applicationId, stage },
    auditAction: 'interview_prep.created',
    auditPayload: { applicationId, stage }
  });
  return { ...artifact, applicationId, jobId: job.id, profileId: prof.id, stage, note: 'Interview prep packet created for human review.' };
}
