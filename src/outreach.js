import path from 'node:path';
import { one, run, audit, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd } from './workspace.js';
import { getStakeholder } from './research.js';

function saveOutreachArtifact(s, { job, profile, stakeholder, goal, content, evidence, warnings }) {
  const at = now();
  const rel = path.join('jobs', job.id, 'outreach', `${stakeholder.id}-${goal}.md`);
  const aid = id('artifact', `outreach:${job.id}:${profile.id}:${stakeholder.id}:${goal}:${at}`);
  writeMd(path.join(s.p.ws, rel), content);
  run(s, 'INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?)', [aid, job.id, profile.id, 'outreach', rel, `Outreach draft to ${stakeholder.name}`, content, JSON.stringify(evidence), JSON.stringify(warnings), 'draft_needs_human_review', at]);
  audit(s, 'outreach.draft.created', 'artifact', aid, { jobId: job.id, profileId: profile.id, stakeholderId: stakeholder.id, path: rel, goal, approvalStatus: 'draft_needs_human_review' });
  save(s);
  return { id: aid, path: rel, approvalStatus: 'draft_needs_human_review', warnings };
}

function profileStyle(profile) {
  const prefs = parseJson(profile.preferences_json, {});
  return prefs.communicationStyle || 'concise, specific, and respectful';
}

export function draftOutreach(s, { jobId, profileId, stakeholderId, goal = 'informational' }) {
  const safeGoal = slug(goal || 'informational');
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Error(`Profile ${profileId} is not linked to job ${jobId}`);
  const stakeholder = getStakeholder(s, stakeholderId);
  if (!stakeholder) throw Error(`Unknown stakeholder: ${stakeholderId}`);
  if (!stakeholder.job_id || stakeholder.job_id !== jobId) throw Error(`Stakeholder ${stakeholderId} is not linked to job ${jobId}`);
  const app = one(s, 'SELECT status FROM applications WHERE job_id=? ORDER BY updated_at DESC LIMIT 1', [jobId]);
  const source = stakeholder.links[0] || '';
  const hasSourcedSummary = Boolean(String(stakeholder.summary || '').trim() && source);
  const context = String(stakeholder.summary || `public source captured for ${stakeholder.name}`).replace(/[.\s]+$/, '');
  const warnings = ['Draft only — not sent. Human approval is required before any external outreach.'];
  if (!hasSourcedSummary) warnings.push('Stakeholder summary is missing; verify relevance manually before using this draft.');
  if (app && ['interview', 'offer', 'rejected'].includes(app.status)) warnings.push(`Application status is ${app.status}; pause outreach unless you intentionally approve this follow-up.`);
  const evidence = [{ stakeholderId, source, summary: hasSourcedSummary ? context : '', role: stakeholder.role }];
  const ask = safeGoal === 'referral' ? 'whether there is a thoughtful referral path' : 'whether you would be open to a short learning conversation';
  const contextLine = hasSourcedSummary ? `Source-backed context: ${context}.` : 'Source-backed context: no summary captured; verify relevance before using this draft.';
  const messageContext = hasSourcedSummary ? `noticed the source-backed context above for your work at ${job.company}` : `found your public profile while researching relevant contacts for this role`;
  const content = `# Outreach draft — ${stakeholder.name}\n\n**Approval status:** Draft only — not sent.\n**Goal:** ${safeGoal}\n**Related job:** ${job.title} at ${job.company}\n\n## Why this contact is relevant\n- ${stakeholder.name} is listed as ${stakeholder.role}.\n- ${contextLine}\n- Source: ${source || 'no source URL captured'}\n\n## Draft message\nHi ${stakeholder.name.split(/\s+/)[0]},\n\nI’m exploring the ${job.title} role at ${job.company} and ${messageContext}. My background is ${profile.name}, and I’m especially interested in understanding the team context, current priorities, and what strong contribution in this role would look like.\n\nIf it is appropriate, I would appreciate ${ask}. I’m happy to keep it brief and specific.\n\nThanks,\n${profile.name}\n\n## Style notes\n- Tone target: ${profileStyle(profile)}.\n- Keep the final message short, specific, and low-pressure.\n\n## Human gate\n- JobOS created this draft only. It did not send email, LinkedIn messages, or contact anyone.\n- Verify the source and relationship context before copying this into any external tool.\n`;
  return saveOutreachArtifact(s, { job, profile, stakeholder, goal: safeGoal, content, evidence, warnings });
}
