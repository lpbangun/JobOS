import path from 'node:path';
import { all, audit, one, run, save } from './db.js';
import { id, now, parseJson } from './utils.js';
import { writeMd, writeYaml } from './workspace.js';
import { generateJson, llmConfig } from './llm.js';

export const answerCategories = new Set([
  'identity', 'contact', 'education', 'employment', 'portfolio', 'motivation',
  'experience_story', 'work_authorization', 'compensation', 'demographic',
  'legal_attestation', 'other'
]);
export const answerSensitivities = new Set(['public', 'personal', 'sensitive', 'restricted']);
export const answerReuseScopes = new Set(['global', 'employer_specific', 'never_auto_fill']);
export const answerStatuses = new Set(['unverified', 'verified', 'stale', 'retired']);
const restrictedCategories = new Set(['work_authorization', 'demographic', 'legal_attestation']);

function domainError(code, message) {
  return Object.assign(new Error(message), { code, type: 'validation' });
}

export function questionFingerprint(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/\b(the|a|an|please|tell us|tell me)\b/g, ' ')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function rowToAnswer(row, { reveal = false } = {}) {
  const redacted = !reveal && ['sensitive', 'restricted'].includes(row.sensitivity);
  return {
    id: row.id,
    profileId: row.profile_id,
    category: row.category,
    question: row.question_text,
    questionFingerprint: row.question_fingerprint,
    answer: redacted ? null : row.answer_text,
    redacted,
    sensitivity: row.sensitivity,
    reuseScope: row.reuse_scope,
    verificationStatus: row.verification_status,
    sourceRef: row.source_ref,
    employer: row.reuse_scope === 'employer_specific' ? row.employer : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateEnum(set, value, field) {
  if (!set.has(value)) throw domainError('invalid_answer_field', `Invalid ${field}: ${value}`);
  return value;
}

function syncAnswers(s, profileId) {
  const answers = listAnswers(s, { profileId });
  writeYaml(path.join(s.p.profiles, `${profileId}-answers.yaml`), {
    profileId,
    answers,
    note: 'Sensitive and restricted answer values are always redacted in this mirror.'
  });
}

export function addAnswer(s, {
  profileId,
  category = 'other',
  question,
  answer,
  sensitivity = 'personal',
  reuseScope = 'global',
  verificationStatus = 'verified',
  sourceRef = 'user_input',
  employer = ''
}) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw domainError('unknown_profile', `Unknown profile: ${profileId}`);
  const normalizedCategory = validateEnum(answerCategories, String(category), 'category');
  const requestedSensitivity = validateEnum(answerSensitivities, String(sensitivity), 'sensitivity');
  const requestedScope = validateEnum(answerReuseScopes, String(reuseScope), 'reuse scope');
  const normalizedStatus = validateEnum(answerStatuses, String(verificationStatus), 'verification status');
  const normalizedSensitivity = restrictedCategories.has(normalizedCategory) ? 'restricted' : requestedSensitivity;
  const normalizedScope = restrictedCategories.has(normalizedCategory) ? 'never_auto_fill' : requestedScope;
  const questionText = String(question || '').trim();
  const answerText = String(answer || '').trim();
  if (!questionText) throw domainError('missing_question', 'Answer requires a question');
  if (!answerText) throw domainError('missing_answer', 'Answer requires non-empty answer text');
  const fingerprint = questionFingerprint(questionText);
  const normalizedSourceRef = String(sourceRef || '').trim();
  const restrictedContextKey = normalizedSensitivity === 'restricted' && /^job:[a-z0-9_-]+$/i.test(normalizedSourceRef) ? normalizedSourceRef.toLowerCase() : '';
  const employerKey = restrictedContextKey || (normalizedScope === 'employer_specific' ? String(employer || '').trim().toLowerCase() : '');
  if (normalizedScope === 'employer_specific' && !employerKey) throw domainError('missing_employer', 'Employer-specific answers require --employer');
  const at = now();
  const answerId = id('answer', `${profileId}:${fingerprint}:${employerKey}`);
  run(s, `INSERT INTO answers (id,profile_id,category,question_fingerprint,question_text,answer_text,sensitivity,reuse_scope,verification_status,source_ref,employer,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(profile_id,question_fingerprint,employer) DO UPDATE SET category=excluded.category,question_text=excluded.question_text,answer_text=excluded.answer_text,sensitivity=excluded.sensitivity,reuse_scope=excluded.reuse_scope,verification_status=excluded.verification_status,source_ref=excluded.source_ref,updated_at=excluded.updated_at`,
  [answerId, profileId, normalizedCategory, fingerprint, questionText, answerText, normalizedSensitivity, normalizedScope, normalizedStatus, normalizedSourceRef, employerKey, at, at]);
  audit(s, 'answer.saved', 'answer', answerId, { profileId, category: normalizedCategory, sensitivity: normalizedSensitivity, reuseScope: normalizedScope, verificationStatus: normalizedStatus, sourceRef: normalizedSourceRef });
  syncAnswers(s, profileId);
  save(s);
  return rowToAnswer(one(s, 'SELECT * FROM answers WHERE profile_id=? AND question_fingerprint=? AND employer=?', [profileId, fingerprint, employerKey]));
}

export function listAnswers(s, { profileId, category = null, status = null } = {}) {
  if (!profileId) throw domainError('missing_profile', 'answers list requires a profile');
  const clauses = ['profile_id=?'];
  const params = [profileId];
  if (category) { clauses.push('category=?'); params.push(String(category)); }
  if (status) { clauses.push('verification_status=?'); params.push(String(status)); }
  return all(s, `SELECT * FROM answers WHERE ${clauses.join(' AND ')} ORDER BY category,question_text`, params).map(row => rowToAnswer(row));
}

function matchOne(rows, item, employer) {
  const question = typeof item === 'string' ? item : String(item?.question || '');
  const category = typeof item === 'object' && item ? String(item.category || 'other') : 'other';
  const fingerprint = questionFingerprint(question);
  if (!question) return { question, category, status: 'unmatched', confidence: 0 };
  if (restrictedCategories.has(category)) return { question, category, status: 'blocked', blocker: 'sensitive_prompt', confidence: 0 };
  const candidates = rows.filter(row => {
    if (row.verification_status !== 'verified') return false;
    if (['sensitive', 'restricted'].includes(row.sensitivity)) return false;
    if (row.reuse_scope === 'never_auto_fill') return false;
    if (row.reuse_scope === 'employer_specific' && row.employer !== String(employer || '').trim().toLowerCase()) return false;
    return true;
  });
  const exact = candidates.find(row => row.question_fingerprint === fingerprint);
  if (exact) return { question, category, status: 'matched', confidence: 1, match: rowToAnswer(exact, { reveal: true }) };
  const wanted = new Set(fingerprint.split(' ').filter(Boolean));
  let best = null;
  for (const row of candidates) {
    const available = new Set(row.question_fingerprint.split(' ').filter(Boolean));
    const shared = [...wanted].filter(token => available.has(token)).length;
    const union = new Set([...wanted, ...available]).size || 1;
    const score = shared / union;
    if (!best || score > best.score) best = { row, score };
  }
  if (best && best.score >= 0.75) return { question, category, status: 'matched', confidence: Number(best.score.toFixed(2)), match: rowToAnswer(best.row, { reveal: true }) };
  return { question, category, status: 'unmatched', confidence: best ? Number(best.score.toFixed(2)) : 0 };
}

export function matchAnswers(s, { profileId, questions, employer = '' }) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw domainError('unknown_profile', `Unknown profile: ${profileId}`);
  const list = Array.isArray(questions) ? questions : parseJson(questions, null);
  if (!Array.isArray(list)) throw domainError('invalid_questions', 'Questions must be a JSON array');
  const rows = all(s, 'SELECT * FROM answers WHERE profile_id=?', [profileId]);
  const matches = list.map(item => matchOne(rows, item, employer));
  return {
    profileId,
    employer,
    count: matches.length,
    matched: matches.filter(item => item.status === 'matched').length,
    blocked: matches.filter(item => item.status === 'blocked').length,
    questions: matches
  };
}

function applicationQuestions(job) {
  const requirements = parseJson(job.requirements_json, []);
  const questions = [
    { category: 'motivation', question: `Why are you interested in ${job.company}?` },
    { category: 'experience_story', question: `Describe the experience that best prepares you for the ${job.title} role.` },
    { category: 'work_authorization', question: 'Are you legally authorized to work in the role location?' },
    { category: 'work_authorization', question: 'Will you now or later require employment sponsorship?' }
  ];
  for (const requirement of requirements.slice(0, 6)) {
    const text = String(requirement || '').trim();
    if (text) questions.push({ category: 'experience_story', question: `Describe your experience with: ${text}` });
  }
  return questions;
}

export function inspectApplicationQuestions(s, { jobId, profileId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw domainError('unknown_job', `Unknown job: ${jobId}`);
  if (job.profile_id !== profileId) throw domainError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);
  const matched = matchAnswers(s, { profileId, questions: applicationQuestions(job), employer: job.company });
  const restrictedRows = all(s, `SELECT * FROM answers
    WHERE profile_id=? AND verification_status='verified' AND sensitivity='restricted' AND reuse_scope='never_auto_fill' AND source_ref=?`, [profileId, `job:${jobId}`]);
  const directByFingerprint = new Map(restrictedRows.map(row => [row.question_fingerprint, row]));
  const questions = matched.questions.map(item => {
    if (item.status === 'matched') {
      return {
        question: item.question,
        category: item.category,
        status: 'matched',
        confidence: item.confidence,
        answerId: item.match.id,
        autoFill: true
      };
    }
    if (item.status === 'blocked') {
      const direct = directByFingerprint.get(questionFingerprint(item.question));
      if (direct) {
        return {
          question: item.question,
          category: item.category,
          status: 'direct_input_recorded',
          blocker: null,
          confidence: 1,
          answerId: direct.id,
          redacted: true,
          autoFill: false
        };
      }
      return {
        question: item.question,
        category: item.category,
        status: 'blocked',
        blocker: 'sensitive_prompt',
        confidence: 0,
        answerId: null,
        redacted: true,
        autoFill: false
      };
    }
    return {
      question: item.question,
      category: item.category,
      status: 'unmatched',
      confidence: item.confidence,
      answerId: null,
      autoFill: false
    };
  });
  return {
    jobId,
    profileId,
    employer: job.company,
    count: questions.length,
    matched: questions.filter(item => item.status === 'matched').length,
    unmatched: questions.filter(item => item.status === 'unmatched').length,
    restricted: questions.filter(item => item.category === 'work_authorization' || restrictedCategories.has(item.category)).length,
    directInputRecorded: questions.filter(item => item.status === 'direct_input_recorded').length,
    unresolvedRestricted: questions.filter(item => item.status === 'blocked').length,
    questions
  };
}

async function draftUnmatchedAnswers(s, job, profileId, questions) {
  const proofs = all(s, 'SELECT id,summary,evidence,skills_json,metrics_json FROM proof_points WHERE profile_id=? ORDER BY created_at', [profileId]);
  const unmatched = questions.filter(item => item.status === 'unmatched');
  const cfg = llmConfig();
  if (!cfg.configured || !proofs.length || !unmatched.length) return { mode: 'deterministic', drafts: new Map(), warnings: [] };
  try {
    const response = await generateJson({
      schemaName: 'jobos_application_questions',
      system: 'Draft concise application-question answers using only supplied proof points. Never answer restricted, legal, demographic, work-authorization, sponsorship, compensation-commitment, or consent questions. Every draft must cite one or more supplied proofPointIds.',
      user: JSON.stringify({
        job: { id: job.id, title: job.title, company: job.company, description: job.description },
        proofPoints: proofs.map(proof => ({ id: proof.id, summary: proof.summary, evidence: proof.evidence, skills: parseJson(proof.skills_json, []), metrics: parseJson(proof.metrics_json, []) })),
        questions: unmatched.map(item => ({ question: item.question, category: item.category }))
      }, null, 2)
    });
    if (!response.ok) return { mode: 'deterministic', drafts: new Map(), warnings: [response.reason || 'Generation unavailable.'] };
    const proofIds = new Set(proofs.map(proof => proof.id));
    const allowedQuestions = new Set(unmatched.map(item => item.question));
    const drafts = new Map();
    for (const item of Array.isArray(response.json?.answers) ? response.json.answers : []) {
      const question = String(item?.question || '');
      const draft = String(item?.draft || '').trim();
      const cited = Array.isArray(item?.proofPointIds) ? item.proofPointIds.map(String).filter(proofId => proofIds.has(proofId)) : [];
      if (allowedQuestions.has(question) && draft && cited.length) drafts.set(question, { draft, proofPointIds: cited });
    }
    return { mode: response.config?.provider === 'agent' ? 'agent' : 'llm', drafts, warnings: drafts.size < unmatched.length ? ['Some unanswered questions lacked a proof-grounded generated draft.'] : [] };
  } catch (error) {
    if (error?.type === 'agent_error') throw error;
    return { mode: 'deterministic', drafts: new Map(), warnings: [`Question drafting failed; kept explicit unanswered prompts: ${error.message}`] };
  }
}

export async function prepareApplicationQuestions(s, { jobId, profileId }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw domainError('unknown_job', `Unknown job: ${jobId}`);
  if (job.profile_id !== profileId) throw domainError('profile_job_mismatch', `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`);
  const result = matchAnswers(s, { profileId, questions: applicationQuestions(job), employer: job.company });
  const generated = await draftUnmatchedAnswers(s, job, profileId, result.questions);
  for (const item of result.questions) {
    const draft = generated.drafts.get(item.question);
    if (draft) item.draft = draft;
  }
  const generatedAt = now();
  const lines = [`# Application questions — ${job.title} at ${job.company}`, '', `Generated: ${generatedAt}`, `Mode: ${generated.mode}`, '', 'Answers are proposals for preparation only. Restricted questions always require direct user input.', ''];
  for (const item of result.questions) {
    lines.push(`## ${item.question}`, '', `- Category: ${item.category}`, `- Status: ${item.status}`, `- Confidence: ${item.confidence}`);
    if (item.blocker) lines.push(`- Blocker: ${item.blocker}`, '- Next: answer this exact question directly; JobOS will not infer or auto-select it.');
    else if (item.match) lines.push(`- Answer source: ${item.match.id}`, `- Proposed answer: ${item.match.answer}`);
    else if (item.draft) lines.push(`- Generated draft: ${item.draft.draft}`, `- Proof point IDs: ${item.draft.proofPointIds.join(', ')}`, '- Next: verify and save this answer before reuse.');
    else lines.push('- Next: add a verified answer with `jobos answers add` or draft from stored proof points.');
    lines.push('');
  }
  if (generated.warnings.length) lines.push('## Warnings', '', ...generated.warnings.map(warning => `- ${warning}`), '');
  const rel = path.join('jobs', job.id, 'artifacts', 'application-questions.md');
  writeMd(path.join(s.p.ws, rel), lines.join('\n'));
  audit(s, 'application.questions.prepared', 'job', job.id, { jobId, profileId, path: rel, matched: result.matched, blocked: result.blocked, count: result.count, mode: generated.mode });
  save(s);
  return { ...result, jobId, path: rel, generatedAt, mode: generated.mode, warnings: generated.warnings };
}
