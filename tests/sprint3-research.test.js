import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openStore, one } from '../src/db.js';

function fakeSearchServer() {
  const requests = [];
  const companyResults = [
    { title: 'OtherCo product update', url: 'https://other.example/news', snippet: 'OtherCo launched an unrelated recruiting analytics product.' },
    { title: 'Acme Learning — AI tutoring platform for workforce upskilling', url: 'https://acme.example/about', snippet: 'Acme Learning builds an AI tutoring platform for adult learners and workforce upskilling programs.' },
    { title: 'Acme Learning raises Series A led by Reach Capital', url: 'https://acme.example/funding', snippet: 'The company announced a Series A to expand employer partnerships and product development.' },
    { title: 'Acme Learning product overview', url: 'https://acme.example/product', snippet: 'Its product combines cohort-based learning, skills assessment, and manager dashboards.' },
    { title: 'Acme Learning customers include healthcare and logistics employers', url: 'https://acme.example/customers', snippet: 'Customer stories mention frontline learner programs in healthcare and logistics.' },
    { title: 'Acme Learning careers: Product Manager, Learning Platform', url: 'https://acme.example/careers/pm', snippet: 'The role focuses on educator discovery, activation metrics, and roadmap tradeoffs.' }
  ];
  const stakeholderResults = [
    { title: 'Maya Chen — Head of Product at Acme Learning', url: 'https://acme.example/team/maya-chen', snippet: 'Maya Chen leads product for Acme Learning and writes about AI learning workflows.' },
    { title: 'Jordan Patel — Recruiting Lead at Acme Learning', url: 'https://acme.example/team/jordan-patel', snippet: 'Jordan Patel supports product and design hiring at Acme Learning.' },
    { title: 'Priya Rao — LinkedIn', url: 'https://www.linkedin.com/in/priya-rao', snippet: 'Head of Product at Acme Learning focused on AI learning workflows.' },
    { title: 'Riley Stone — Head of Product at OtherCo', url: 'https://other.example/team/riley-stone', snippet: 'Riley Stone leads product at OtherCo.' },
    { title: 'Sam Lee — Head of Product at OtherCo', url: 'https://other.example/team/sam-lee', snippet: 'Sam Lee wrote a roundup that mentions Acme Learning as a market peer.' },
    { title: 'Alice Smith — Head of Product at Learning Guild', url: 'https://learning-guild.example/team/alice-smith', snippet: 'Alice Smith leads product at Learning Guild.' },
    { title: 'Acme Learning — AI tutoring platform for workforce upskilling', url: 'https://acme.example/about', snippet: 'Acme Learning builds an AI tutoring platform for adult learners.' }
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.searchParams.get('q') || '');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const results = q.includes('stakeholder') || q.includes('hiring manager') || q.includes('recruiter') ? stakeholderResults : companyResults;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}/search`,
    requests,
    close: () => new Promise(done => server.close(done))
  })));
}

function fakeResearchLlmServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: parsed });
      if (parsed.metadata?.schemaName === 'jobos_stakeholder_relevance') {
        const payload = {
          candidates: [
            {
              sourceUrl: 'https://acme.example/team/maya-chen',
              isPerson: true,
              belongsToCompany: true,
              roleRelevance: 'high',
              confidence: 'high',
              reason: 'Maya Chen leads product at Acme Learning, matching the product manager role context.'
            },
            {
              sourceUrl: 'https://acme.example/team/jordan-patel',
              isPerson: true,
              belongsToCompany: false,
              roleRelevance: 'none',
              confidence: 'low',
              reason: 'The fixture asks the LLM relevance check to reject this candidate.'
            }
          ]
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        return;
      }
      if (parsed.metadata?.schemaName === 'jobos_stakeholder_structuring') {
        const payload = {
          name: 'Maya Chen',
          role: 'Head of Product',
          relevanceSummary: 'Maya Chen leads product at Acme Learning and writes about AI learning workflows.',
          confidence: 'high',
          warnings: []
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        return;
      }
      if (parsed.metadata?.schemaName === 'jobos_outreach_draft') {
        const payload = {
          subject: 'Question about Acme Learning product priorities',
          message: 'Hi Maya,\n\nI saw that you lead product at Acme Learning and that Acme Learning builds an AI tutoring platform for workforce upskilling. My background includes educator discovery for AI-assisted learning workflows, so I would value your perspective on what strong contribution looks like for the Product Manager role.\n\nWould you be open to a short learning conversation?\n\nThanks,\nPM EdTech',
          evidence: [
            { sourceUrl: 'https://acme.example/team/maya-chen', reason: 'Stakeholder relevance' },
            { sourceUrl: 'https://acme.example/about', reason: 'Company product context' }
          ],
          quality: { specificity: 9, personalization: 9, askClarity: 9, lengthDiscipline: 9, toneMatch: 9 },
          warnings: []
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        return;
      }
      const payload = {
        claims: [
          {
            claim: 'Acme Learning builds an AI tutoring platform for workforce upskilling.',
            category: 'product',
            sourceUrl: 'https://acme.example/about',
            sourceTitle: 'Acme Learning - AI tutoring platform for workforce upskilling',
            confidence: 'high'
          },
          {
            claim: 'Unsupported claim with no source URL.',
            category: 'market',
            confidence: 'high'
          },
          {
            claim: 'OtherCo is secretly the same company.',
            category: 'risk',
            sourceUrl: 'https://other.example/news',
            sourceTitle: 'OtherCo product update',
            confidence: 'high'
          }
        ],
        openQuestions: [
          'Confirm how the product manager role will measure educator discovery outcomes.'
        ],
        outreachAngles: [
          {
            angle: 'Ask how educator discovery shapes the roadmap for the learning platform role.',
            whyItMattersForRole: 'The job asks for educator discovery and the source-backed company context is an AI learning platform.',
            evidenceUrls: ['https://acme.example/about', 'https://acme.example/careers/pm'],
            suggestedAsk: 'How is the team balancing learner workflow research with activation metrics this quarter?',
            confidence: 'high'
          },
          {
            angle: 'Unsupported angle should be dropped.',
            whyItMattersForRole: 'No source.',
            evidenceUrls: [],
            suggestedAsk: 'Should not render.',
            confidence: 'high'
          }
        ],
        warnings: ['Review synthesized claims before outreach.']
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise(done => server.close(done))
  })));
}

function makeRunner(extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-sprint3-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '', ...extraEnv };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      else resolve(stdout);
    });
  });
  const runRaw = (args) => new Promise(resolve => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return { root, run, runRaw };
}

async function seedJob(run, root) {
  await run(['init', '--json']);
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.\n- Shipped activation experiments for adult learning products with design and engineering partners.\n');
  const profile = JSON.parse(await run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  const jobFile = path.join(root, 'acme-job.md');
  writeFileSync(jobFile, 'Title: Product Manager, Learning Platform\nCompany: Acme Learning\nLocation: Remote\n\nAcme Learning needs a PM to lead educator discovery, roadmap tradeoffs, activation metrics, and AI learning workflow experiments.');
  const job = JSON.parse(await run(['jobs', 'import-text', '--profile', profile.id, '--file', jobFile, '--json']));
  return { profile, job };
}

test('company research uses web search results to create sourced dossier facts', async () => {
  const fake = await fakeSearchServer();
  try {
    const { root, run } = makeRunner({ JOBOS_SEARCH_BASE_URL: fake.baseUrl });
    const { job } = await seedJob(run, root);
    const result = JSON.parse(await run(['research', 'company', '--job', job.id, '--json']));
    assert.equal(result.queryCount, 5);
    assert.equal(result.factCount, 4);
    assert.equal(result.sourceCount, 4);
    assert.ok(fake.requests.length >= 5, `expected multi-query search, got ${fake.requests.join(', ')}`);
    assert.ok(fake.requests.some(q => q.includes('Acme Learning')));
    const dossier = readFileSync(path.join(root, 'jobos-workspace', result.path), 'utf8');
    assert.match(dossier, /Source-backed facts/);
    assert.match(dossier, /Human gate/);
    assert.match(dossier, /https:\/\/acme\.example\/funding/);
    assert.match(dossier, /Series A/);
    assert.doesNotMatch(dossier, /OtherCo/);
    assert.doesNotMatch(dossier, /other\.example/);
    assert.doesNotMatch(dossier, /not fabricated/i);
  } finally {
    await fake.close();
  }
});

test('company research uses LLM synthesis but drops unsourced claims and angles', async () => {
  const fake = await fakeSearchServer();
  const llm = await fakeResearchLlmServer();
  try {
    const { root, run } = makeRunner({
      JOBOS_SEARCH_BASE_URL: fake.baseUrl,
      JOBOS_LLM_PROVIDER: 'openai',
      JOBOS_LLM_MODEL: 'fake-research-model',
      JOBOS_LLM_API_KEY: 'test-key',
      JOBOS_LLM_BASE_URL: llm.baseUrl
    });
    const { job } = await seedJob(run, root);
    const result = JSON.parse(await run(['research', 'company', '--job', job.id, '--json']));
    assert.equal(result.mode, 'llm');
    assert.equal(result.queryCount, 5);
    assert.equal(result.factCount, 1);
    assert.equal(result.outreachAngleCount, 1);
    assert.equal(result.droppedUnsupportedClaims, 2);
    assert.equal(result.droppedUnsupportedAngles, 1);
    assert.ok(fake.requests.length >= 5, `expected multi-query search, got ${fake.requests.join(', ')}`);
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0].authorization, 'Bearer test-key');
    const dossier = readFileSync(path.join(root, 'jobos-workspace', result.path), 'utf8');
    assert.match(dossier, /Research mode:\*\* llm/);
    assert.match(dossier, /Acme Learning builds an AI tutoring platform/);
    assert.match(dossier, /Ask how educator discovery shapes the roadmap/);
    assert.match(dossier, /Confirm how the product manager role will measure educator discovery outcomes/);
    assert.match(dossier, /Human gate/);
    assert.doesNotMatch(dossier, /Unsupported claim with no source URL/);
    assert.doesNotMatch(dossier, /OtherCo is secretly/);
    assert.doesNotMatch(dossier, /Unsupported angle should be dropped/);
    const store = await openStore({ workspace: root });
    const company = one(store, 'SELECT facts_json FROM companies WHERE id=?', [result.companyId]);
    const facts = JSON.parse(company.facts_json);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].source, 'llm-synthesis');
    assert.equal(facts[0].url, 'https://acme.example/about');
  } finally {
    await fake.close();
    await llm.close();
  }
});

test('add-stakeholder requires source URL and records pasted stakeholder context', async () => {
  const { root, run, runRaw } = makeRunner();
  const { job } = await seedJob(run, root);
  const missingSource = await runRaw([
    'research', 'add-stakeholder',
    '--job', job.id,
    '--name', 'Maya Chen',
    '--text', 'Maya Chen is Head of Product at Acme Learning.'
  ]);
  assert.notEqual(missingSource.status, 0);
  assert.match(missingSource.stderr, /source-url/i);
  const added = JSON.parse(await run([
    'research', 'add-stakeholder',
    '--job', job.id,
    '--source-url', 'https://acme.example/team/maya-chen',
    '--name', 'Maya Chen',
    '--role', 'Head of Product',
    '--text', 'Maya Chen is Head of Product at Acme Learning and writes about AI learning workflows.',
    '--json'
  ]));
  assert.equal(added.name, 'Maya Chen');
  assert.equal(added.sourceUrl, 'https://acme.example/team/maya-chen');
  assert.equal(added.confidence, 'medium');
  const stakeholderDoc = readFileSync(path.join(root, 'jobos-workspace', added.path), 'utf8');
  assert.match(stakeholderDoc, /Maya Chen/);
  assert.match(stakeholderDoc, /Confidence: medium/);
  assert.match(stakeholderDoc, /Source type: user_pasted/);
  assert.match(stakeholderDoc, /Human gate/);
  assert.match(stakeholderDoc, /explicit public source URLs/);
  assert.doesNotMatch(stakeholderDoc, /did send|sent email/i);
});


test('outreach draft uses LLM evidence schema when configured', async () => {
  const fake = await fakeSearchServer();
  const llm = await fakeResearchLlmServer();
  try {
    const { root, run } = makeRunner({
      JOBOS_SEARCH_BASE_URL: fake.baseUrl,
      JOBOS_LLM_PROVIDER: 'openai',
      JOBOS_LLM_MODEL: 'fake-outreach-model',
      JOBOS_LLM_API_KEY: 'test-key',
      JOBOS_LLM_BASE_URL: llm.baseUrl
    });
    const { profile, job } = await seedJob(run, root);
    await run(['research', 'company', '--job', job.id, '--json']);
    const added = JSON.parse(await run([
      'research', 'add-stakeholder',
      '--job', job.id,
      '--source-url', 'https://acme.example/team/maya-chen',
      '--name', 'Maya Chen',
      '--role', 'Head of Product',
      '--text', 'Maya Chen leads product at Acme Learning and writes about AI learning workflows.',
      '--json'
    ]));
    const draft = JSON.parse(await run(['outreach', 'draft', '--job', job.id, '--stakeholder', added.id, '--profile', profile.id, '--goal', 'informational', '--json']));
    assert.equal(draft.mode, 'llm');
    assert.equal(draft.subject, 'Question about Acme Learning product priorities');
    assert.ok(llm.requests.some(r => r.body.metadata?.schemaName === 'jobos_outreach_draft'));
    const content = readFileSync(path.join(root, 'jobos-workspace', draft.path), 'utf8');
    assert.match(content, /AI tutoring platform for workforce upskilling/);
    assert.match(content, /https:\/\/acme\.example\/team\/maya-chen/);
    assert.match(content, /https:\/\/acme\.example\/about/);
    assert.match(content, /Quality check/);
    assert.match(content, /Human gate/);
    const store = await openStore({ workspace: root });
    const artifact = one(store, 'SELECT evidence_json FROM artifacts WHERE id=?', [draft.id]);
    const evidence = JSON.parse(artifact.evidence_json);
    assert.ok(evidence.some(item => item.sourceUrl === 'https://acme.example/team/maya-chen'));
    assert.ok(evidence.some(item => item.sourceUrl === 'https://acme.example/about'));
  } finally {
    await fake.close();
    await llm.close();
  }
});
