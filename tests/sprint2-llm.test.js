import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

function makeRunner(extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-sprint2-'));
  const env = { ...process.env, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '', ...extraEnv, JOBOS_HOME: root };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  const runAsync = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      else resolve(stdout);
    });
  });
  return { root, run, runAsync };
}

function startFakeOpenAiScoringServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) });
      if (body.includes('fake-malformed-model')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
        return;
      }
      const prompt = body.toLowerCase();
      if (prompt.includes('jobos_resume_transformations')) {
        const proofIds = [...prompt.matchAll(/proof_[a-f0-9]+/g)].map(match => match[0]);
        const sourceEntryIds = [...prompt.matchAll(/resume_entry_[a-f0-9]+/g)].map(match => match[0]);
        const payload = {
          summary: { text: 'Invented $10M ARR ownership claim.', proofPointIds: [proofIds[0]] },
          bulletRewrites: [{ sourceBulletId: sourceEntryIds[0], text: 'Invented $10M ARR ownership claim.', proofPointIds: [proofIds[0]] }],
          selectedSkillIds: [],
          layoutProfileId: 'professional'
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        return;
      }
      if (prompt.includes('tailored resume') || prompt.includes('requirement-to-proof')) {
        const proofIds = [...prompt.matchAll(/proof_[a-f0-9]+/g)].map(m => m[0]);
        const payload = {
          title: 'LLM tailored resume draft',
          summary: 'Product leader focused on educator-centered learning platforms, workflow discovery, and evidence-backed launches.',
          requirementProofMap: [
            { requirement: 'Ship cross-functional product improvements', proofPointId: proofIds[1], bullet: 'Shipped a cross-functional product launch with engineering and design partners to improve activation.' },
            { requirement: 'Use data to guide roadmap decisions', proofPointId: proofIds[2], bullet: 'Built dashboards and weekly operating reviews connecting adoption data to roadmap decisions.' }
          ],
          warnings: [],
          coverLetter: 'I am excited by the learning platform context and the chance to improve curriculum workflows for educators.'
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        return;
      }
      const isPoor = prompt.includes('backend payments engineer') || prompt.includes('kubernetes') || prompt.includes('fraud models');
      const isGood = !isPoor && (prompt.includes('curriculum product manager') || prompt.includes('learning platform') || prompt.includes('educators'));
      const overall = isGood ? 88 : isPoor ? 38 : 68;
      const payload = {
        overall,
        confidence: 'high',
        dimensions: {
          roleFit: { score: isGood ? 90 : 35, reason: 'The role responsibilities are compared against the profile target role families and proof points. The rating reflects whether the work is product/discovery oriented or primarily unrelated engineering execution.' },
          domainFit: { score: isGood ? 92 : 30, reason: 'The company and problem space are evaluated against the profile emphasis on EdTech, learning systems, and educator workflows. A learning platform is strongly aligned while payments infrastructure is not.' },
          seniority: { score: 82, reason: 'The role expectations appear appropriate for a candidate with cross-functional product and research proof points. There is no explicit executive-level mismatch or junior-only signal.' },
          locationWorkModel: { score: 75, reason: 'The location and work model do not create an obvious blocker from the provided preferences. The candidate should still verify hybrid or remote expectations manually.' },
          compensation: { score: 65, reason: 'The posting includes enough compensation or benefits context to avoid a major unknown. Final fit should still depend on the candidate salary band.' },
          missionInterest: { score: isGood ? 90 : 35, reason: 'The mission is assessed against the candidate interest in education, workforce learning, and human-centered systems. Roles outside that mission receive a lower score even if otherwise strong.' },
          networkAccess: { score: 60, reason: 'No direct stakeholder or alumni signal is present in the job text. This is a neutral score pending company and stakeholder research.' },

          redFlags: { score: 90, reason: 'No scam, unpaid, commission-only, or suspicious application language appears in the job text. This does not replace manual diligence.' }
        },
        redFlags: [],
        reasoning: 'This structured score is based on profile preferences, proof points, and the job description rather than keyword counts. The strong-fit role aligns with PM, EdTech, educator discovery, and learning workflow proof; the poor-fit role is mainly backend payments infrastructure.'
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

function completeLlmResume(proofs) {
  return {
    schemaVersion: 1,
    identity: { name: 'PM EdTech', email: 'pm@example.com', phone: '+1 555 555 0100', location: 'Remote', links: [], verificationStatus: 'verified' },
    summary: { id: 'summary_llm', text: 'Product manager focused on learning platforms.', proofPointIds: proofs.map(proof => proof.id), verificationStatus: 'verified' },
    experience: [{
      id: 'experience_llm', employer: 'Learning Studio', title: 'Product Manager', location: 'Remote', startDate: '2020-01', endDate: null,
      dateSource: { startText: '2020-01', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified',
      bullets: proofs.map((proof, index) => ({ id: `bullet_llm_${index}`, text: proof.summary, proofPointIds: [proof.id], verificationStatus: 'verified' }))
    }],
    education: [{ id: 'education_llm', institution: 'State University', degree: 'BS', field: 'Product Systems', location: '', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_research', name: 'User research', category: 'Product', verificationStatus: 'verified' }],
    credentials: [],
    projects: [],
    additionalSections: []
  };
}

test('LLM scoring calls provider and differentiates good fit from poor fit by at least 30 points', async () => {
  const fake = await startFakeOpenAiScoringServer();
  try {
    const { runAsync } = makeRunner({ JOBOS_LLM_PROVIDER: 'openai', JOBOS_LLM_MODEL: 'fake-scoring-model', JOBOS_LLM_API_KEY: 'test-key', JOBOS_LLM_BASE_URL: fake.baseUrl });
    await runAsync(['init', '--json']);
    const profile = JSON.parse(await runAsync(['profile', 'create', 'PM EdTech', '--from-resume', path.join(process.cwd(), 'tests/eval/profile-proof-points.md'), '--json']));
    const good = JSON.parse(await runAsync(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'tests/eval/jobs/good-fit-curriculum-pm.md'), '--json']));
    const poor = JSON.parse(await runAsync(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'tests/eval/jobs/poor-fit-backend-payments.md'), '--json']));
    const goodScore = JSON.parse(await runAsync(['score', good.id, '--profile', profile.id, '--json']));
    const poorScore = JSON.parse(await runAsync(['score', poor.id, '--profile', profile.id, '--json']));
    assert.equal(goodScore.mode, 'llm');
    assert.equal(poorScore.mode, 'llm');
    assert.ok(goodScore.overall - poorScore.overall >= 30, `expected >=30 point gap, got ${goodScore.overall} vs ${poorScore.overall}`);
    assert.match(goodScore.dimensions.roleFit.reason, /responsibilities/i);
    assert.ok(fake.requests.length >= 2);
    assert.ok(fake.requests.every(r => r.authorization === 'Bearer test-key'));
  } finally {
    fake.server.close();
  }
});

test('LLM tailoring grounds resume requirements to stored proof point IDs', async () => {
  const fake = await startFakeOpenAiScoringServer();
  try {
    const { root, runAsync } = makeRunner({ JOBOS_LLM_PROVIDER: 'openai', JOBOS_LLM_MODEL: 'fake-tailoring-model', JOBOS_LLM_API_KEY: 'test-key', JOBOS_LLM_BASE_URL: fake.baseUrl });
    await runAsync(['init', '--json']);
    const profile = JSON.parse(await runAsync(['profile', 'create', 'PM EdTech', '--json']));
    const proofSummaries = readFileSync(path.join(process.cwd(), 'tests/eval/profile-proof-points.md'), 'utf8').split(/\r?\n/).map(line => line.replace(/^-\s*/, '').trim()).filter(Boolean);
    const proofs = [];
    for (const summary of proofSummaries) proofs.push(JSON.parse(await runAsync(['proof', 'add', '--profile', profile.id, '--summary', summary, '--evidence', 'Verified evaluation fixture', '--json'])));
    const resumePath = path.join(root, 'resume.json');
    writeFileSync(resumePath, JSON.stringify(completeLlmResume(proofs), null, 2));
    await runAsync(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
    const job = JSON.parse(await runAsync(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'tests/eval/jobs/good-fit-curriculum-pm.md'), '--json']));
    const draft = JSON.parse(await runAsync(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
    assert.equal(draft.mode, 'llm');
    assert.doesNotMatch(draft.content, /10M ARR|Invented claim/i);
    assert.ok(draft.validation.warnings.some(warning => warning.code === 'resume_transformation_warning' && /Dropped generated summary/.test(warning.message)));
    const cited = draft.coverage.matrix.flatMap(item => item.proofPointIds);
    assert.ok(new Set(cited).size >= 3, `expected at least 3 proof point IDs in coverage, got ${cited.join(', ')}`);
    assert.ok(draft.coverage.matrix.every(item => item.requirement.sourceText));
    const artifactPath = path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.md');
    assert.doesNotMatch(readFileSync(artifactPath, 'utf8'), /10M ARR|Invented claim/i);
  } finally {
    fake.server.close();
  }
});


test('malformed LLM score output falls back instead of being marked as LLM scored', async () => {
  const fake = await startFakeOpenAiScoringServer();
  try {
    const { runAsync } = makeRunner({ JOBOS_LLM_PROVIDER: 'openai', JOBOS_LLM_MODEL: 'fake-malformed-model', JOBOS_LLM_API_KEY: 'test-key', JOBOS_LLM_BASE_URL: fake.baseUrl });
    await runAsync(['init', '--json']);
    const profile = JSON.parse(await runAsync(['profile', 'create', 'PM EdTech', '--from-resume', path.join(process.cwd(), 'tests/eval/profile-proof-points.md'), '--json']));
    const job = JSON.parse(await runAsync(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'tests/eval/jobs/good-fit-curriculum-pm.md'), '--json']));
    const score = JSON.parse(await runAsync(['score', job.id, '--profile', profile.id, '--json']));
    assert.equal(score.mode, 'deterministic-degraded');
    assert.match(score.reasoning, /malformed|failed|fallback/i);
  } finally {
    fake.server.close();
  }
});
