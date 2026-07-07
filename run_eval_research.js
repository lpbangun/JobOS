import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openStore, all, one } from './src/db.js';
import { parseJson } from './src/utils.js';

const fixtures = [
  {
    id: 'acme',
    company: 'Acme Learning',
    role: 'Product Manager, Learning Platform',
    validUrls: [
      'https://acme.example/about',
      'https://acme.example/customers',
      'https://acme.example/funding',
      'https://acme.example/careers/pm'
    ],
    distractorUrls: ['https://acme-labs.example/about'],
    companyResults: [
      { title: 'Acme Learning - AI tutoring platform', url: 'https://acme.example/about', snippet: 'Acme Learning builds an AI tutoring platform for workforce upskilling.' },
      { title: 'Acme Learning customers', url: 'https://acme.example/customers', snippet: 'Acme Learning serves healthcare and logistics employers with frontline learner programs.' },
      { title: 'Acme Learning funding', url: 'https://acme.example/funding', snippet: 'Acme Learning raised funding to expand employer partnerships and product development.' },
      { title: 'Acme Learning careers: Product Manager', url: 'https://acme.example/careers/pm', snippet: 'The Product Manager role focuses on educator discovery, activation metrics, and AI workflows.' },
      { title: 'Acme Labs overview', url: 'https://acme-labs.example/about', snippet: 'Acme Labs is an unrelated developer tooling company.' }
    ],
    stakeholderResults: [
      { title: 'Maya Chen - Head of Product at Acme Learning', url: 'https://acme.example/team/maya-chen', snippet: 'Maya Chen leads product at Acme Learning and writes about AI learning workflows.' },
      { title: 'Acme Learning Careers', url: 'https://acme.example/careers', snippet: 'Careers page for Acme Learning.' },
      { title: 'Riley Stone - Head of Product at Acme Labs', url: 'https://acme-labs.example/team/riley-stone', snippet: 'Riley Stone leads product at Acme Labs.' }
    ],
    validStakeholders: [{ name: 'Maya Chen', url: 'https://acme.example/team/maya-chen' }]
  },
  {
    id: 'beacon',
    company: 'Beacon Talent',
    role: 'People Operations Manager',
    validUrls: [
      'https://beacon.example/about',
      'https://beacon.example/product',
      'https://beacon.example/customers',
      'https://beacon.example/careers/ops'
    ],
    distractorUrls: ['https://beacon-analytics.example/news'],
    companyResults: [
      { title: 'Beacon Talent people platform', url: 'https://beacon.example/about', snippet: 'Beacon Talent builds workforce planning tools for distributed hiring teams.' },
      { title: 'Beacon Talent product', url: 'https://beacon.example/product', snippet: 'Beacon Talent combines hiring analytics, recruiter workflows, and manager dashboards.' },
      { title: 'Beacon Talent customers', url: 'https://beacon.example/customers', snippet: 'Beacon Talent customer stories mention operations-heavy scaling teams.' },
      { title: 'Beacon Talent careers: People Operations Manager', url: 'https://beacon.example/careers/ops', snippet: 'The role owns onboarding processes, employee systems, and cross-functional people operations.' },
      { title: 'Beacon Analytics funding', url: 'https://beacon-analytics.example/news', snippet: 'Beacon Analytics is an unrelated data company.' }
    ],
    stakeholderResults: [
      { title: 'Nora Singh - Talent Lead at Beacon Talent', url: 'https://beacon.example/team/nora-singh', snippet: 'Nora Singh leads talent programs at Beacon Talent and partners with people operations.' },
      { title: 'Beacon Talent Team Page', url: 'https://beacon.example/team', snippet: 'Team directory for Beacon Talent.' },
      { title: 'Drew Kim - Recruiter at Beacon Analytics', url: 'https://beacon-analytics.example/drew-kim', snippet: 'Drew Kim recruits for Beacon Analytics.' }
    ],
    validStakeholders: [{ name: 'Nora Singh', url: 'https://beacon.example/team/nora-singh' }]
  },
  {
    id: 'nimbus',
    company: 'Nimbus Health',
    role: 'Product Operations Lead',
    validUrls: [
      'https://nimbus.example/about',
      'https://nimbus.example/security',
      'https://nimbus.example/customers',
      'https://nimbus.example/careers/product-ops'
    ],
    distractorUrls: ['https://nimbus-home.example/about'],
    companyResults: [
      { title: 'Nimbus Health care coordination', url: 'https://nimbus.example/about', snippet: 'Nimbus Health builds care coordination software for specialty clinics.' },
      { title: 'Nimbus Health security', url: 'https://nimbus.example/security', snippet: 'Nimbus Health documents HIPAA-oriented security controls and audit workflows.' },
      { title: 'Nimbus Health customers', url: 'https://nimbus.example/customers', snippet: 'Nimbus Health customer stories mention scheduling, referral, and provider workflow improvements.' },
      { title: 'Nimbus Health careers: Product Operations Lead', url: 'https://nimbus.example/careers/product-ops', snippet: 'The role improves product operations, customer feedback loops, and launch readiness.' },
      { title: 'Nimbus Home launches app', url: 'https://nimbus-home.example/about', snippet: 'Nimbus Home is an unrelated smart-home company.' }
    ],
    stakeholderResults: [
      { title: 'Omar Diaz - Founder at Nimbus Health', url: 'https://nimbus.example/team/omar-diaz', snippet: 'Omar Diaz founded Nimbus Health and writes about healthcare workflow operations.' },
      { title: 'Nimbus Health Jobs', url: 'https://nimbus.example/jobs', snippet: 'Open jobs at Nimbus Health.' },
      { title: 'Mina Park - Product Leader at Nimbus Home', url: 'https://nimbus-home.example/mina-park', snippet: 'Mina Park leads product at Nimbus Home.' }
    ],
    validStakeholders: [{ name: 'Omar Diaz', url: 'https://nimbus.example/team/omar-diaz' }]
  }
];

const profileFixtures = [
  {
    name: 'PM EdTech',
    style: 'concise, warm, evidence-grounded',
    proof: 'Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.'
  },
  {
    name: 'People Ops Builder',
    style: 'direct, operational, metrics-first',
    proof: 'Built onboarding workflows for 120-person distributed teams and reduced manual HR handoffs by 40%.'
  },
  {
    name: 'Healthcare Ops PM',
    style: 'thoughtful, precise, collaborative',
    proof: 'Launched healthcare workflow pilots with clinicians, support teams, and product engineers across 14 clinics.'
  }
];

function jsonResponse(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function fixtureForText(text) {
  return fixtures.find(f => text.toLowerCase().includes(f.company.toLowerCase())) || fixtures[0];
}

function createSearchServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const query = url.searchParams.get('q') || '';
    requests.push(query);
    const fixture = fixtureForText(query);
    const isStakeholder = /stakeholder|hiring manager|recruiter|product leader/i.test(query);
    jsonResponse(res, { results: isStakeholder ? fixture.stakeholderResults : fixture.companyResults });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/search`
  })));
}

function parseSection(text, marker, nextMarker) {
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = start + marker.length;
  const end = nextMarker ? text.indexOf(nextMarker, bodyStart) : -1;
  return text.slice(bodyStart, end >= 0 ? end : undefined).trim();
}

function parseJsonSection(text, marker, nextMarker) {
  const value = parseSection(text, marker, nextMarker);
  return value ? JSON.parse(value) : null;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 3));
}

function jaccardSimilarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? intersection / union : 0;
}

function createLlmServer() {
  const requests = [];
  const validStakeholderUrls = new Set(fixtures.flatMap(f => f.validStakeholders.map(s => s.url)));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        requests.push(parsed);
        const schema = parsed.metadata?.schemaName;
        const user = parsed.messages?.find(m => m.role === 'user')?.content || '';
        if (schema === 'jobos_company_dossier') {
        const job = parseJsonSection(user, 'JOB:\n', '\n\nSOURCES:') || {};
        const sources = parseJsonSection(user, 'SOURCES:\n') || [];
        const fixture = fixtureForText(job.company || user);
        const byUrl = new Map(sources.map(s => [s.url, s]));
        const valid = fixture.validUrls.map(url => byUrl.get(url)).filter(Boolean);
        const payload = {
          claims: valid.slice(0, 4).map(source => ({
            claim: source.snippet,
            category: source.url.includes('careers') ? 'role_context' : source.url.includes('customer') ? 'customers' : 'product',
            sourceUrl: source.url,
            sourceTitle: source.title,
            confidence: 'high'
          })),
          openQuestions: [`Confirm how ${job.title || fixture.role} maps to the current team priorities.`],
          outreachAngles: valid.slice(0, 2).map(source => ({
            angle: `Ask how ${source.snippet.replace(/\.$/, '')} affects the ${job.title || fixture.role} role.`,
            whyItMattersForRole: 'The angle connects a source-backed company signal to the imported role.',
            evidenceUrls: [source.url],
            suggestedAsk: 'How is the team translating this priority into near-term work?',
            confidence: 'high'
          })),
          warnings: []
        };
          return jsonResponse(res, { choices: [{ message: { content: JSON.stringify(payload) } }] });
        }
        if (schema === 'jobos_stakeholder_relevance') {
        const candidates = parseJsonSection(user, 'CANDIDATES:\n') || [];
        const payload = {
          candidates: candidates.map(candidate => {
            const valid = validStakeholderUrls.has(candidate.sourceUrl);
            return {
              sourceUrl: candidate.sourceUrl,
              isPerson: valid,
              belongsToCompany: valid,
              roleRelevance: valid ? 'high' : 'none',
              confidence: valid ? 'high' : 'low',
              reason: valid ? `${candidate.name} has source-backed company relevance.` : 'Not a source-backed stakeholder for this company.'
            };
          })
        };
          return jsonResponse(res, { choices: [{ message: { content: JSON.stringify(payload) } }] });
        }
        if (schema === 'jobos_stakeholder_structuring') {
        const source = parseJsonSection(user, 'SOURCE:\n') || {};
        const name = source.name || String(source.text || '').match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/)?.[0] || 'Source Backed Stakeholder';
        const payload = { name, role: source.role || 'Relevant stakeholder', relevanceSummary: source.text || `${name} has public source context.`, confidence: 'high', warnings: [] };
          return jsonResponse(res, { choices: [{ message: { content: JSON.stringify(payload) } }] });
        }
        if (schema === 'jobos_outreach_draft') {
        const job = parseJsonSection(user, 'JOB:\n', '\n\nPROFILE:') || {};
        const profile = parseJsonSection(user, 'PROFILE:\n', '\n\nSTAKEHOLDER:') || {};
        const stakeholder = parseJsonSection(user, 'STAKEHOLDER:\n', '\n\nGOAL:') || {};
        const goal = parseSection(user, 'GOAL:\n', '\n\nALLOWED_EVIDENCE:') || 'informational';
        const evidence = parseJsonSection(user, 'ALLOWED_EVIDENCE:\n') || [];
        const stakeholderEvidence = evidence.find(e => e.type === 'stakeholder');
        const companyEvidence = evidence.find(e => e.type === 'company_fact');
        const proofEvidence = evidence.find(e => e.type === 'profile_proof');
        const warm = /warm/i.test(profile.communicationStyle || '');
        const direct = /direct|metrics/i.test(profile.communicationStyle || '');
        const reflective = /thoughtful|collaborative/i.test(profile.communicationStyle || '');
        const toneLine = warm ? 'I hope your week is going well.' : direct ? 'I will keep this brief.' : reflective ? 'I am comparing the role with where I can contribute thoughtfully.' : 'I wanted to reach out with a specific question.';
        const focusLine = direct
          ? 'The fit I am testing is operational rigor, cleaner handoffs, and measurable execution.'
          : reflective
            ? 'The fit I am testing is clinic workflow empathy, careful rollout planning, and cross-functional trust.'
            : 'The fit I am testing is educator discovery, learning workflow depth, and evidence-backed product judgment.';
        const ask = goal === 'referral' ? 'would you suggest a thoughtful referral path or another appropriate next step?' : 'would you be open to a short learning conversation?';
        const message = `Hi ${String(stakeholder.name || 'there').split(/\s+/)[0]},

${toneLine} I am exploring the ${job.title} role at ${job.company}. I noticed ${stakeholderEvidence?.summary || stakeholder.summary}. I also noted ${companyEvidence?.summary || `${job.company} has source-backed context`}. My relevant background is ${proofEvidence?.summary || 'stored in JobOS proof points'}. ${focusLine}

If appropriate, ${ask}

Thanks,
${profile.name}`;
        const payload = {
          subject: `${goal === 'referral' ? 'Referral question' : 'Question'} about ${job.company}`,
          message,
          evidence: [
            stakeholderEvidence?.sourceUrl ? { sourceUrl: stakeholderEvidence.sourceUrl } : null,
            companyEvidence?.sourceUrl ? { sourceUrl: companyEvidence.sourceUrl } : null,
            proofEvidence?.id ? { id: proofEvidence.id } : null
          ].filter(Boolean),
          quality: { specificity: 9, personalization: 9, askClarity: 9, lengthDiscipline: wordCount(message) <= 150 ? 10 : 8, toneMatch: 9 },
          warnings: []
        };
          return jsonResponse(res, { choices: [{ message: { content: JSON.stringify(payload) } }] });
        }
        jsonResponse(res, { choices: [{ message: { content: '{}' } }] });
      } catch (e) {
        if (process.env.DEBUG_JOBOS_EVAL) console.error(e.stack || e.message);
        jsonResponse(res, { choices: [{ message: { content: JSON.stringify({ error: e.message }) } }] });
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`
  })));
}

function runCli(env, args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) {
        reject(new Error(`jobos ${args.join(' ')} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      try {
        resolve(json ? JSON.parse(stdout) : stdout);
      } catch (e) {
        reject(new Error(`jobos ${args.join(' ')} returned invalid JSON: ${e.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });
}

function writeProfileFiles(root, profile) {
  const resume = path.join(root, `${profile.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-resume.md`);
  const prefs = path.join(root, `${profile.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-prefs.json`);
  writeFileSync(resume, `- ${profile.proof}\n`);
  writeFileSync(prefs, JSON.stringify({ communicationStyle: profile.style, targetRoleFamilies: [profile.name], skills: [] }, null, 2));
  return { resume, prefs };
}

async function createJob(env, root, profileId, fixture) {
  const file = path.join(root, `${fixture.id}-job.md`);
  writeFileSync(file, `Title: ${fixture.role}
Company: ${fixture.company}
Location: Remote

${fixture.company} is hiring a ${fixture.role}. The role needs source-backed research, cross-functional judgment, and thoughtful stakeholder communication.`);
  return await runCli(env, ['jobs', 'import-text', '--profile', profileId, '--file', file, '--json']);
}

function scoreDossier({ fixture, result, dossier, facts }) {
  const valid = new Set(fixture.validUrls);
  const distractors = new Set(fixture.distractorUrls);
  const invalidFacts = facts.filter(f => !valid.has(f.url));
  const groundedness = invalidFacts.length ? 1 : 10;
  const distinct = new Set(facts.map(f => f.url).filter(url => valid.has(url))).size;
  const sourceDiversity = distinct >= 3 ? 10 : distinct === 2 ? 8 : distinct === 1 ? 5 : 1;
  const distractorRendered = [...distractors].some(url => dossier.includes(url));
  const distractorRejection = distractorRendered ? 1 : 10;
  const outreachAngleUsefulness = result.outreachAngleCount > 0 && /Suggested ask|Ask how/.test(dossier) ? 10 : 5;
  const average = (groundedness + sourceDiversity + distractorRejection + outreachAngleUsefulness) / 4;
  return {
    company: fixture.company,
    groundedness,
    sourceDiversity,
    distractorRejection,
    outreachAngleUsefulness,
    score: groundedness < 10 ? Math.min(5, average) : average,
    invalidFacts: invalidFacts.map(f => f.url)
  };
}

function scoreStakeholders({ fixture, rows }) {
  const validNames = new Set(fixture.validStakeholders.map(s => s.name));
  const foundNames = new Set(rows.map(r => r.name));
  const falseNames = rows.map(r => r.name).filter(name => !validNames.has(name));
  const truePositive = [...foundNames].filter(name => validNames.has(name)).length;
  const precisionScore = falseNames.length === 0 ? 10 : falseNames.length === 1 ? 5 : 1;
  const recallRatio = truePositive / validNames.size;
  const recallScore = recallRatio >= 1 ? 10 : recallRatio >= 0.5 ? 5 : 1;
  const confidenceScore = rows.every(r => /Confidence: (low|medium|high)/.test(r.summary) && parseJson(r.links_json, []).length) ? 10 : 5;
  return {
    company: fixture.company,
    precision: precisionScore,
    recall: recallScore,
    confidenceLabels: confidenceScore,
    score: ((precisionScore * 2) + recallScore + confidenceScore) / 4,
    falseNames,
    foundNames: [...foundNames]
  };
}

function scoreOutreachDraft({ content, evidence, profile, goal }) {
  const draftMessage = content.match(/## Draft message\n([\s\S]*?)\n## Evidence used/)?.[1] || content;
  const hasStakeholderOrCompany = evidence.some(e => e.type === 'stakeholder' && e.sourceUrl) && evidence.some(e => e.type === 'company_fact' && e.sourceUrl);
  const hasProof = evidence.some(e => e.type === 'profile_proof');
  const specificity = hasStakeholderOrCompany && hasProof ? 10 : hasStakeholderOrCompany ? 8 : 5;
  const askClarity = goal === 'referral'
    ? (/referral path|next step/i.test(content) ? 10 : 5)
    : (/short learning conversation/i.test(content) ? 10 : 5);
  const lengthDiscipline = wordCount(draftMessage) <= 170 ? 10 : 8;
  const toneMatch = /warm/i.test(profile.style)
    ? (/hope your week/i.test(content) ? 10 : 6)
    : /direct|metrics/i.test(profile.style)
      ? (/keep this brief/i.test(content) ? 10 : 7)
      : /thoughtful|collaborative/i.test(profile.style)
        ? (/contribute thoughtfully/i.test(content) ? 10 : 7)
        : 8;
  return { specificity, askClarity, lengthDiscipline, toneMatch, personalization: 9 };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function assertHard(hard, name, pass, detail = '') {
  hard.push({ name, pass: Boolean(pass), detail });
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-research-eval-'));
  const search = await createSearchServer();
  const llm = await createLlmServer();
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_SEARCH_PROVIDER: 'duckduckgo',
    JOBOS_SEARCH_PROVIDERS: 'duckduckgo',
    JOBOS_SEARCH_BASE_URL: search.baseUrl,
    JOBOS_SEARCH_TIMEOUT_MS: '2000',
    JOBOS_LLM_PROVIDER: 'openai',
    JOBOS_LLM_MODEL: 'fixture-research-eval',
    JOBOS_LLM_API_KEY: 'fixture-key',
    JOBOS_LLM_BASE_URL: llm.baseUrl,
    JOBOS_LLM_TIMEOUT_MS: '3000'
  };
  const noLlmEnv = {
    ...env,
    JOBOS_HOME: path.join(root, 'no-llm'),
    JOBOS_LLM_PROVIDER: '',
    JOBOS_LLM_MODEL: '',
    JOBOS_LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OLLAMA_API_KEY: ''
  };
  const hard = [];
  const dossierScores = [];
  const stakeholderScores = [];
  const outreachDrafts = [];

  try {
    await runCli(env, ['init', '--json']);
    const baseProfileFiles = writeProfileFiles(root, profileFixtures[0]);
    const baseProfile = await runCli(env, ['profile', 'create', profileFixtures[0].name, '--from-resume', baseProfileFiles.resume, '--preferences', baseProfileFiles.prefs, '--json']);

    for (const fixture of fixtures) {
      const job = await createJob(env, root, baseProfile.id, fixture);
      const dossierResult = await runCli(env, ['research', 'company', '--job', job.id, '--json']);
      const stakeholderResult = await runCli(env, ['research', 'stakeholders', '--job', job.id, '--json']);
      const store = await openStore({ workspace: root });
      const company = one(store, 'SELECT facts_json FROM companies WHERE id=?', [dossierResult.companyId]);
      const facts = parseJson(company?.facts_json, []);
      const dossier = readFileSync(path.join(root, 'jobos-workspace', dossierResult.path), 'utf8');
      dossierScores.push(scoreDossier({ fixture, result: dossierResult, dossier, facts }));
      const stakeholderRows = all(store, 'SELECT * FROM stakeholders WHERE job_id=?', [job.id]);
      stakeholderScores.push(scoreStakeholders({ fixture, rows: stakeholderRows }));
      assertHard(hard, `${fixture.company} dossier has Human gate`, /Human gate/.test(dossier));
      const stakeholderDoc = readFileSync(path.join(root, 'jobos-workspace', stakeholderResult.path), 'utf8');
      assertHard(hard, `${fixture.company} stakeholder doc has Human gate`, /Human gate/.test(stakeholderDoc));
    }

    for (const [profileIndex, profile] of profileFixtures.entries()) {
      const fixture = fixtures[profileIndex];
      const files = writeProfileFiles(root, profile);
      const created = await runCli(env, ['profile', 'create', profile.name, '--from-resume', files.resume, '--preferences', files.prefs, '--json']);
      const job = await createJob(env, root, created.id, fixture);
      await runCli(env, ['research', 'company', '--job', job.id, '--json']);
      const stakeholder = await runCli(env, ['research', 'add-stakeholder', '--job', job.id, '--source-url', fixture.validStakeholders[0].url, '--name', fixture.validStakeholders[0].name, '--role', 'Relevant stakeholder', '--text', `${fixture.validStakeholders[0].name} has source-backed relevance at ${fixture.company}.`, '--json']);
      for (const goal of ['informational', 'referral']) {
        const draft = await runCli(env, ['outreach', 'draft', '--job', job.id, '--stakeholder', stakeholder.id, '--profile', created.id, '--goal', goal, '--json']);
        const store = await openStore({ workspace: root });
        const artifact = one(store, 'SELECT * FROM artifacts WHERE id=?', [draft.id]);
        const content = readFileSync(path.join(root, 'jobos-workspace', draft.path), 'utf8');
        const evidence = parseJson(artifact.evidence_json, []);
        outreachDrafts.push({ profile, goal, draft, content, evidence, scores: scoreOutreachDraft({ content, evidence, profile, goal }) });
        assertHard(hard, `${profile.name} ${goal} outreach has Human gate`, /Human gate/.test(content));
        assertHard(hard, `${profile.name} ${goal} artifact is draft`, artifact.approval_status === 'draft_needs_human_review');
      }
    }

    const firstDraft = outreachDrafts[0].draft;
    const sent = await runCli(env, ['outreach', 'mark-sent', '--artifact', firstDraft.id, '--channel', 'email', '--notes', 'Human sent from eval email client.', '--json']);
    const scheduled = await runCli(env, ['outreach', 'schedule-followup', '--thread', firstDraft.threadId, '--after', '0', '--json']);
    const due = await runCli(env, ['outreach', 'due', '--json']);
    const followupRun = await runCli(env, ['automation', 'run', 'followup_watch', '--json']);
    const store = await openStore({ workspace: root });
    const followupArtifactId = followupRun.outputs?.followups?.find(f => f.artifactId)?.artifactId;
    const followupArtifact = followupArtifactId ? one(store, 'SELECT * FROM artifacts WHERE id=?', [followupArtifactId]) : null;
    if (followupArtifact) {
      const content = readFileSync(path.join(root, 'jobos-workspace', followupArtifact.path), 'utf8');
      assertHard(hard, 'follow-up draft has Human gate', /Human gate/.test(content));
      assertHard(hard, 'follow-up artifact is draft', followupArtifact.approval_status === 'draft_needs_human_review');
    } else {
      assertHard(hard, 'follow-up draft created by scheduler', false, JSON.stringify(followupRun));
    }
    assertHard(hard, 'mark-sent records human send only', sent.note.includes('JobOS did not send'));
    assertHard(hard, 'schedule-followup creates due task', due.some(item => item.taskId === scheduled.taskId));
    for (const action of ['research.company.created', 'research.stakeholders.created', 'research.stakeholder.added', 'outreach.draft.created', 'outreach.mark_sent.recorded', 'outreach.followup_scheduled']) {
      assertHard(hard, `audit row exists: ${action}`, Boolean(one(store, 'SELECT id FROM audit_log WHERE action=?', [action])));
    }

    await runCli(noLlmEnv, ['init', '--json']);
    const fallbackFiles = writeProfileFiles(noLlmEnv.JOBOS_HOME, profileFixtures[0]);
    const fallbackProfile = await runCli(noLlmEnv, ['profile', 'create', 'Fallback Profile', '--from-resume', fallbackFiles.resume, '--preferences', fallbackFiles.prefs, '--json']);
    const fallbackJob = await createJob(noLlmEnv, noLlmEnv.JOBOS_HOME, fallbackProfile.id, fixtures[0]);
    const fallbackStakeholder = await runCli(noLlmEnv, ['research', 'add-stakeholder', '--job', fallbackJob.id, '--source-url', fixtures[0].validStakeholders[0].url, '--name', fixtures[0].validStakeholders[0].name, '--role', 'Head of Product', '--text', `${fixtures[0].validStakeholders[0].name} leads product at ${fixtures[0].company}.`, '--json']);
    const fallbackDraft = await runCli(noLlmEnv, ['outreach', 'draft', '--job', fallbackJob.id, '--stakeholder', fallbackStakeholder.id, '--profile', fallbackProfile.id, '--json']);
    const fallbackContent = readFileSync(path.join(noLlmEnv.JOBOS_HOME, 'jobos-workspace', fallbackDraft.path), 'utf8');
    assertHard(hard, 'no-LLM fallback has Human gate', /Human gate/.test(fallbackContent));
    assertHard(hard, 'no-LLM fallback avoids invented secret claims', !/secret|unsupported|fabricated/i.test(fallbackContent));

    const outreachByGoal = new Map();
    for (const draft of outreachDrafts) {
      if (!outreachByGoal.has(draft.goal)) outreachByGoal.set(draft.goal, []);
      outreachByGoal.get(draft.goal).push(draft);
    }
    const dissimilarities = [];
    for (const drafts of outreachByGoal.values()) {
      for (let i = 0; i < drafts.length; i++) {
        for (let j = i + 1; j < drafts.length; j++) dissimilarities.push(1 - jaccardSimilarity(drafts[i].content, drafts[j].content));
      }
    }
    const dissimilarity = average(dissimilarities);
    for (const draft of outreachDrafts) draft.scores.personalization = dissimilarity >= 0.35 ? 10 : 5;
    assertHard(hard, 'outreach drafts are materially different across profiles', dissimilarity >= 0.35, `dissimilarity=${dissimilarity.toFixed(2)}`);
    assertHard(hard, 'eval uses only local fake servers', search.baseUrl.includes('127.0.0.1') && llm.baseUrl.includes('127.0.0.1') && search.requests.length > 0 && llm.requests.length > 0);
    assertHard(hard, 'workspace was temporary', existsSync(path.join(root, '.jobos', 'jobos.sqlite')));

    const dossier = {
      groundedness: average(dossierScores.map(s => s.groundedness)),
      sourceDiversity: average(dossierScores.map(s => s.sourceDiversity)),
      distractorRejection: average(dossierScores.map(s => s.distractorRejection)),
      outreachAngleUsefulness: average(dossierScores.map(s => s.outreachAngleUsefulness)),
      average: average(dossierScores.map(s => s.score)),
      cases: dossierScores
    };
    const stakeholder = {
      precision: average(stakeholderScores.map(s => s.precision)),
      recall: average(stakeholderScores.map(s => s.recall)),
      confidenceLabels: average(stakeholderScores.map(s => s.confidenceLabels)),
      average: average(stakeholderScores.map(s => s.score)),
      cases: stakeholderScores
    };
    const outreach = {
      specificity: average(outreachDrafts.map(d => d.scores.specificity)),
      personalization: average(outreachDrafts.map(d => d.scores.personalization)),
      askClarity: average(outreachDrafts.map(d => d.scores.askClarity)),
      lengthDiscipline: average(outreachDrafts.map(d => d.scores.lengthDiscipline)),
      toneMatch: average(outreachDrafts.map(d => d.scores.toneMatch)),
      average: average(outreachDrafts.flatMap(d => Object.values(d.scores))),
      dissimilarity,
      drafts: outreachDrafts.map(d => ({ profile: d.profile.name, goal: d.goal, artifact: d.draft.id, scores: d.scores }))
    };
    const hardAssertions = { passed: hard.filter(h => h.pass).length, total: hard.length, failures: hard.filter(h => !h.pass) };
    const axes = [
      dossier.groundedness,
      dossier.sourceDiversity,
      dossier.distractorRejection,
      dossier.outreachAngleUsefulness,
      stakeholder.precision,
      stakeholder.recall,
      stakeholder.confidenceLabels,
      outreach.specificity,
      outreach.personalization,
      outreach.askClarity,
      outreach.lengthDiscipline,
      outreach.toneMatch
    ];
    const ok = hardAssertions.failures.length === 0 && axes.every(score => score >= 8);
    const report = {
      scenario: 'sprint8-research-outreach-eval',
      ok,
      threshold: 8,
      judge: 'deterministic fixture judge with local fake LLM/search providers',
      dossier,
      stakeholder,
      outreach,
      hardAssertions,
      network: { searchRequests: search.requests.length, llmRequests: llm.requests.length, searchBaseUrl: search.baseUrl, llmBaseUrl: llm.baseUrl }
    };
    console.log(JSON.stringify(report, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    await new Promise(resolve => search.server.close(resolve));
    await new Promise(resolve => llm.server.close(resolve));
    if (!process.env.KEEP_JOBOS_EVAL) rmSync(root, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
