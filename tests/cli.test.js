import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-test-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  return { root, run };
}
function resumeDocument(proofPointIds = []) {
  return {
    schemaVersion: 1,
    identity: { name: 'PM EdTech', email: 'pm@example.com', phone: '+1 555 555 0100', location: 'Remote', links: [], verificationStatus: 'verified' },
    summary: { id: 'summary_cli', text: 'Product manager focused on learning workflows.', proofPointIds, verificationStatus: 'verified' },
    experience: [{ id: 'experience_cli', employer: 'Learning Studio', title: 'Product Manager', location: 'Remote', startDate: '2021-01', endDate: null, dateSource: { startText: '2021-01', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified', bullets: [{ id: 'bullet_cli', text: 'Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.', proofPointIds, verificationStatus: 'verified' }] }],
    education: [{ id: 'education_cli', institution: 'State University', degree: 'BS', field: 'Product Systems', location: '', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_cli', name: 'Product discovery', category: 'Product', verificationStatus: 'verified' }],
    credentials: [],
    projects: [],
    additionalSections: []
  };
}



test('CLI initializes, imports, scores, tailors, and tracks an application', () => {
  const { root, run } = makeRunner();
  const init = JSON.parse(run(['init', '--json']));
  assert.equal(init.policy.externalActions, 'user_configured');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--preferences', path.join(process.cwd(), 'tests/eval/profiles/remote-only.json'), '--json']));
  assert.equal(profile.id, 'pm-edtech');
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.', '--evidence', 'Portfolio case study', '--skills', 'product,discovery', '--json']));
  const resume = path.join(root, 'resume.json');
  writeFileSync(resume, JSON.stringify(resumeDocument([proof.id]), null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resume, '--json']);
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  assert.match(job.id, /^job_/);
  const score = JSON.parse(run(['score', job.id, '--profile', profile.id, '--json']));
  assert.ok(score.overall >= 50);
  const resumeDraft = run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--output', 'markdown']);
  assert.match(resumeDraft, /## Experience/);
  assert.match(resumeDraft, /reduced manual review time by 30%/);
  assert.doesNotMatch(resumeDraft, /sent email/i);
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'materials-ready', '--json']));
  assert.equal(app.status, 'materials-ready');
  const tasks = JSON.parse(run(['tasks', 'due', '--json']));
  assert.ok(tasks.some(t => t.title.includes('Review next action')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'job.yaml')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.coverage.yaml')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.validation.yaml')));
});

test('Tailoring warns instead of fabricating when proof points are missing', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Generic Search', '--json']));
  const resume = path.join(root, 'resume.json');
  writeFileSync(resume, JSON.stringify(resumeDocument(), null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resume, '--json']);
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const draft = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
  assert.equal(draft.validation.valid, false);
  assert.ok(draft.coverage.unsupported.length > 0);
  assert.deepEqual(draft.evidence, []);
  assert.equal((draft.content.match(/reduced manual review time by 30%/gi) || []).length, 1);
  assert.doesNotMatch(draft.content, /10M ARR|invented claim/i);
});


