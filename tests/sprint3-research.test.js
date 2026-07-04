import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
    assert.equal(result.factCount, 4);
    assert.equal(result.sourceCount, 4);
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

test('stakeholder research creates sourced outreach draft without sending anything', async () => {
  const fake = await fakeSearchServer();
  try {
    const { root, run, runRaw } = makeRunner({ JOBOS_SEARCH_BASE_URL: fake.baseUrl });
    const { profile, job } = await seedJob(run, root);
    const stakeholders = JSON.parse(await run(['research', 'stakeholders', '--job', job.id, '--json']));
    assert.equal(stakeholders.stakeholderIds.length, 3);
    const stakeholderDoc = readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'stakeholders.md'), 'utf8');
    assert.match(stakeholderDoc, /Priya Rao/);
    assert.doesNotMatch(stakeholderDoc, /OtherCo|Learning Guild|Sam Lee/);
    const draft = JSON.parse(await run(['outreach', 'draft', '--job', job.id, '--stakeholder', stakeholders.stakeholderIds[0], '--profile', profile.id, '--goal', 'informational', '--json']));
    assert.equal(draft.approvalStatus, 'draft_needs_human_review');
    const content = readFileSync(path.join(root, 'jobos-workspace', draft.path), 'utf8');
    assert.match(content, /Draft only — not sent/);
    assert.match(content, /Why this contact is relevant/);
    assert.match(content, /Human gate/);
    assert.match(content, /did not send email/);
    assert.match(content, /Maya Chen|Jordan Patel/);
    assert.match(content, /https:\/\/acme\.example\/team\//);
    assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'stakeholders.md')));
    const otherProfile = JSON.parse(await run(['profile', 'create', 'Other Profile', '--json']));
    const wrongProfile = await runRaw(['outreach', 'draft', '--job', job.id, '--stakeholder', stakeholders.stakeholderIds[0], '--profile', otherProfile.id, '--json']);
    assert.notEqual(wrongProfile.status, 0);
    assert.match(wrongProfile.stderr, /not linked to job/);
    const traversal = JSON.parse(await run(['outreach', 'draft', '--job', job.id, '--stakeholder', stakeholders.stakeholderIds[0], '--profile', profile.id, '--goal', '../../../../evil', '--json']));
    assert.match(traversal.path, new RegExp(`^jobs/${job.id}/outreach/`));
    assert.doesNotMatch(traversal.path, /\.\./);
  } finally {
    await fake.close();
  }
});
