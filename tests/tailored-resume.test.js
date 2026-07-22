import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import { applyResumeTransformations, renderSemanticResumeMarkdown, validateTailoredResume } from '../src/resume-tailoring.js';
import { buildRequirementCoverage, extractRequirementInventory } from '../src/requirements.js';
import { latexEscape, latexUrlEscape, preflightExtractedText, preflightPdfMetadata, renderResumeLatex, renderResumePdf, resolveLayoutProfile } from '../src/resume-renderer.js';
import { openStore, one as dbOne, run as dbRun, save as dbSave } from '../src/db.js';
import { resumeFeedback } from '../src/analytics.js';
import { preflightResumeArtifact, reviewArtifact } from '../src/artifacts.js';
import { callDomainTool } from '../src/domain-tools.js';
function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-resume-test-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const run = args => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  return { root, env, run };
}

function completeResume(summary = 'Product leader focused on trustworthy education technology.') {
  return {
    schemaVersion: 1,
    identity: {
      name: 'Avery Candidate', email: 'avery@example.com', phone: '+1 555 555 0100', location: 'Chicago, IL', verificationStatus: 'verified',
      links: [{ id: 'link_linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/in/avery', verificationStatus: 'verified' }]
    },
    summary: { id: 'summary_main', text: summary, verificationStatus: 'verified', proofPointIds: ['proof_launch'] },
    experience: [{
      id: 'experience_acme', employer: 'Acme Learning', title: 'Senior Product Manager', location: 'Remote', startDate: '2021-02', endDate: null,
      dateSource: { startText: '2021-02', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified',
      bullets: [{ id: 'bullet_launch', text: 'Led educator research and shipped a workflow that reduced review time by 30%.', proofPointIds: ['proof_launch'], verificationStatus: 'verified' }]
    }],
    education: [{ id: 'education_state', institution: 'State University', degree: 'BS', field: 'Computer Science', location: 'Chicago, IL', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_research', name: 'User research', category: 'Product', verificationStatus: 'verified' }, { id: 'skill_sql', name: 'SQL', category: 'Technical', verificationStatus: 'verified' }],
    credentials: [{ id: 'credential_cspo', name: 'CSPO', issuer: 'Scrum Alliance', date: '2020', verificationStatus: 'verified' }],
    projects: [{ id: 'project_access', name: 'Accessibility Lab', description: 'Open accessibility research project.', url: 'https://example.com/accessibility', verificationStatus: 'verified', bullets: [] }],
    additionalSections: [{ id: 'section_community', title: 'Community Leadership', entries: ['Mentor, Product Collective'], verificationStatus: 'verified' }]
  };
}

test('canonical resume round-trips complete sections and preserves revision history', () => {
  const { root, run, env } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Canonical Resume', '--json']));
  const firstPath = path.join(root, 'resume.json');
  writeFileSync(firstPath, JSON.stringify(completeResume(), null, 2));
  const first = JSON.parse(run(['resume', 'import', '--profile', profile.id, '--file', firstPath, '--json']));
  assert.equal(first.revision, 1);
  assert.equal(first.validation.valid, true);
  assert.equal(first.document.identity.email, 'avery@example.com');
  assert.equal(first.document.experience[0].employer, 'Acme Learning');
  assert.equal(first.document.education[0].institution, 'State University');
  assert.equal(first.document.skills[1].name, 'SQL');
  assert.equal(first.document.credentials[0].name, 'CSPO');
  assert.equal(first.document.projects[0].name, 'Accessibility Lab');
  assert.deepEqual(first.document.additionalSections[0].entries, ['Mentor, Product Collective']);

  const correctedPath = path.join(root, 'resume-corrected.json');
  writeFileSync(correctedPath, JSON.stringify(completeResume('Product leader building trustworthy education workflows.'), null, 2));
  const second = JSON.parse(run(['resume', 'replace', '--profile', profile.id, '--file', correctedPath, '--json']));
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesResumeId, first.id);
  const historical = JSON.parse(run(['resume', 'show', '--profile', profile.id, '--revision', '1', '--json']));
  assert.equal(historical.document.summary.text, 'Product leader focused on trustworthy education technology.');
  assert.equal(historical.isCurrent, false);

  const currentMirror = path.join(root, 'jobos-workspace', 'profiles', profile.id, 'resume', 'current.yaml');
  const oldMirror = path.join(root, 'jobos-workspace', 'profiles', profile.id, 'resume', 'revisions', '1.yaml');
  assert.equal(existsSync(currentMirror), true);
  assert.equal(existsSync(oldMirror), true);
  const projected = YAML.parse(readFileSync(currentMirror, 'utf8'));
  assert.equal(projected.revision, 2);
  assert.equal(projected.document.additionalSections[0].title, 'Community Leadership');
  const invalidPath = path.join(root, 'resume-invalid.json');
  const invalid = completeResume();
  invalid.identity.email = '';
  writeFileSync(invalidPath, JSON.stringify(invalid, null, 2));
  const rejected = spawnSync(process.execPath, ['src/cli.js', 'resume', 'replace', '--profile', profile.id, '--file', invalidPath, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /resume_source_incomplete/);
  const current = JSON.parse(run(['resume', 'show', '--profile', profile.id, '--json']));
  assert.equal(current.id, second.id);
  assert.equal(current.revision, 2);
});

test('text import exposes uncertain fields and preserves unknown sections', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Uncertain Resume', '--json']));
  const source = path.join(root, 'resume.md');
  writeFileSync(source, `Avery Candidate\navery@example.com | +1 555 555 0100\nChicago, IL\n\n## Summary\nProduct builder.\n\n## Experience\n### Product Manager — Acme Learning | February 2021 — Present\n- Led educator research and improved review time by 30%.\n\n## Selected Talks\n- Trustworthy product systems\n`);
  const imported = JSON.parse(run(['resume', 'import', '--profile', profile.id, '--file', source, '--json']));
  assert.equal(imported.document.additionalSections[0].title, 'Selected Talks');
  assert.deepEqual(imported.document.additionalSections[0].entries, ['Trustworthy product systems']);
  assert.ok(imported.validation.warnings.some(warning => warning.code === 'resume_source_unverified'));
  const validated = JSON.parse(run(['resume', 'validate', '--profile', profile.id, '--json']));
  assert.equal(validated.valid, true);
  assert.ok(validated.warnings.length > 0);
});

test('resume-imported proofs require explicit verification before coverage support', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const source = path.join(root, 'resume.md');
  writeFileSync(source, `Avery Candidate\navery@example.com | +1 555 555 0100\nChicago, IL\n\n## Summary\nProduct builder.\n\n## Experience\n### Product Manager — Acme Learning | February 2021 — Present\n- Led educator research and improved review time by 30%.\n\n## Education\n- State University\n`);
  const profile = JSON.parse(run(['profile', 'create', 'Imported Proof Review', '--from-resume', source, '--json']));
  const jobPath = path.join(root, 'job.md');
  writeFileSync(jobPath, 'Title: Product Manager\nCompany: Acme\n\n## Requirements\n- Must lead educator research and improve review time.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobPath, '--json']));
  const store = await openStore({ workspace: root });
  const proof = dbOne(store, 'SELECT * FROM proof_points WHERE profile_id=?', [profile.id]);
  assert.equal(proof.verification_status, 'unverified');
  store.db.close();
  const before = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
  assert.equal(before.coverage.matched.length, 0);
  assert.ok(before.validation.blockers.some(blocker => blocker.code === 'resume_source_unverified'));
  run(['proof', 'verify', proof.id, '--json']);
  const after = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
  assert.ok(after.coverage.matched.length + after.coverage.partiallySupported.length > 0);
  assert.ok(after.evidence.some(item => item.proofPointId === proof.id));
});

test('retired proof remains in history and is excluded from later tailoring', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Proof Lifecycle', '--json']));
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator research that reduced review time by 30%.', '--evidence', 'verified portfolio', '--json']));
  const retired = JSON.parse(run(['proof', 'retire', proof.id, '--reason', 'Metric source expired', '--json']));
  assert.equal(retired.status, 'retired');
  const resumePath = path.join(root, 'resume.json');
  writeFileSync(resumePath, JSON.stringify(completeResume(), null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
  const jobPath = path.join(root, 'job.md');
  writeFileSync(jobPath, 'Title: Product Manager\nCompany: Acme\n\nRequirements\n- Must have educator research experience.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobPath, '--json']));
  const tailored = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
  const draft = readFileSync(path.join(root, 'jobos-workspace', tailored.path), 'utf8');
  assert.doesNotMatch(draft, /Led educator research that reduced review time by 30%/i);
  assert.ok(tailored.coverage.unsupported.length > 0);
});

test('structured requirements remain source-traceable and coverage is deterministic', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'ATS Coverage', '--json']));
  const supportedProof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Conducted educator user research for a learning platform.', '--skills', 'user research,education', '--json']));
  run(['proof', 'add', '--profile', profile.id, '--summary', 'Communicated product updates with partner teams.', '--skills', 'communication', '--json']);
  const retiredProof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Earned PMP credential for program delivery.', '--skills', 'PMP', '--json']));
  run(['proof', 'retire', retiredProof.id, '--reason', 'Credential expired', '--json']);
  const source = path.join(root, 'structured-job.md');
  writeFileSync(source, `Title: Senior Product Manager
Company: Learning Co

## Responsibilities
- Conduct educator user research and synthesize findings.
- Partner with stakeholders to communicate the product roadmap.

## Required Qualifications
- Must have 5+ years of product management experience.
- PMP certification required.

## Preferred Qualifications
- Experience with machine learning products preferred.
`);
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', source, '--json']));
  const first = JSON.parse(run(['resume', 'coverage', '--job', job.id, '--profile', profile.id, '--json']));
  const second = JSON.parse(run(['resume', 'coverage', '--job', job.id, '--profile', profile.id, '--json']));
  assert.deepEqual(second, first);
  assert.equal(first.requirements.schemaVersion, 1);
  assert.equal(first.requirements.requirements.length, 5);
  for (const requirement of first.requirements.requirements) {
    assert.ok(readFileSync(source, 'utf8').includes(requirement.sourceText));
    assert.ok(requirement.sourceLine > 0);
  }
  const research = first.coverage.matrix.find(item => /educator user research/i.test(item.requirement.sourceText));
  assert.equal(research.status, 'supported');
  assert.deepEqual(research.proofPointIds, [supportedProof.id]);
  const credential = first.coverage.matrix.find(item => /PMP certification/i.test(item.requirement.sourceText));
  assert.equal(credential.status, 'unsupported');
  assert.deepEqual(credential.proofPointIds, []);
  assert.ok(first.coverage.partiallySupported.length >= 1);
  assert.ok(first.coverage.unsupported.length >= 1);
  const jobMirror = YAML.parse(readFileSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'job.yaml'), 'utf8'));
  assert.equal(jobMirror.requirements.schemaVersion, 1);
});

test('deterministic tailoring produces a complete normal resume and persists semantic sidecars', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Complete Tailoring', '--json']));
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator research and shipped a workflow that reduced review time by 30%.', '--evidence', 'portfolio case study', '--skills', 'user research,product management', '--json']));
  const resume = completeResume();
  resume.summary.proofPointIds = [proof.id];
  resume.experience[0].bullets[0].proofPointIds = [proof.id];
  const resumePath = path.join(root, 'complete-resume.json');
  writeFileSync(resumePath, JSON.stringify(resume, null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
  const source = path.join(root, 'target-job.md');
  writeFileSync(source, 'Title: Senior Product Manager\nCompany: Learning Co\n\n## Required Qualifications\n- Must conduct educator user research.\n- PMP certification required.\n');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', source, '--json']));
  const tailored = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']));
  assert.equal(tailored.mode, 'deterministic');
  assert.equal(tailored.validation.valid, true);
  assert.equal(tailored.document.identity.email, 'avery@example.com');
  assert.equal(tailored.document.experience[0].employer, 'Acme Learning');
  assert.equal(tailored.document.education[0].institution, 'State University');
  assert.equal(tailored.document.credentials[0].name, 'CSPO');
  assert.equal(tailored.submissionPerformed, false);
  const markdown = readFileSync(path.join(root, 'jobos-workspace', tailored.path), 'utf8');
  assert.match(markdown, /^# Avery Candidate/m);
  assert.match(markdown, /## Experience/);
  assert.match(markdown, /## Education/);
  assert.match(markdown, /## Credentials/);
  assert.doesNotMatch(markdown, /proof_[a-z0-9]+/i);
  assert.doesNotMatch(markdown, /evidence:/i);
  assert.equal(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.coverage.yaml')), true);
  assert.equal(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'resume-tailored.validation.yaml')), true);
});

test('all review surfaces enforce semantic and current-source gates', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Review Gates', '--json']));
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator research and shipped a workflow that reduced review time by 30%.', '--evidence', 'Verified portfolio evidence', '--json']));
  const document = completeResume();
  document.summary.proofPointIds = [proof.id];
  document.experience[0].bullets[0].proofPointIds = [proof.id];
  const resumePath = path.join(root, 'resume.json');
  writeFileSync(resumePath, JSON.stringify(document, null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
  const blockedJobPath = path.join(root, 'blocked-job.md');

  writeFileSync(blockedJobPath, 'Title: Product Manager\nCompany: Acme\n\n## Requirements\n- PMP certification required.');
  const blockedJob = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', blockedJobPath, '--json']));
  const blockedDraft = JSON.parse(run(['tailor', 'resume', '--job', blockedJob.id, '--profile', profile.id, '--json']));
  assert.equal(blockedDraft.validation.valid, false);
  const cliPreflight = JSON.parse(run(['resume', 'preflight', '--artifact', blockedDraft.id, '--json']));
  assert.equal(cliPreflight.valid, false);
  assert.ok(cliPreflight.blockers.some(blocker => blocker.code === 'resume_critical_requirements_uncovered'));
  let store = await openStore({ workspace: root });
  assert.throws(() => reviewArtifact(store, { artifactId: blockedDraft.id, approvalStatus: 'approved', source: 'tui' }), error => error.code === 'resume_critical_requirements_uncovered');
  assert.throws(() => reviewArtifact(store, { artifactId: blockedDraft.id, approvalStatus: 'approved', source: 'api' }), error => error.code === 'human_review_required');
  assert.equal(dbOne(store, 'SELECT approval_status FROM artifacts WHERE id=?', [blockedDraft.id]).approval_status, 'draft_needs_human_review');
  const blockedPreflight = preflightResumeArtifact(store, blockedDraft.id);
  assert.equal(blockedPreflight.valid, false);
  assert.ok(blockedPreflight.blockers.some(blocker => blocker.code === 'resume_critical_requirements_uncovered'));
  store.db.close();

  const supportedJobPath = path.join(root, 'supported-job.md');
  writeFileSync(supportedJobPath, 'Title: Product Manager\nCompany: Learning Co\n\n## Requirements\n- Must lead educator research and reduce review time.');
  const supportedJob = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', supportedJobPath, '--json']));
  const supportedDraft = JSON.parse(run(['tailor', 'resume', '--job', supportedJob.id, '--profile', profile.id, '--json']));
  store = await openStore({ workspace: root });
  const approved = reviewArtifact(store, { artifactId: supportedDraft.id, approvalStatus: 'approved', note: 'Reviewed exact semantic revision.', source: 'tui' });
  assert.equal(approved.approvalStatus, 'approved');
  store.db.close();
  document.summary.text = 'Updated canonical summary.';
  writeFileSync(resumePath, JSON.stringify(document, null, 2));
  run(['resume', 'replace', '--profile', profile.id, '--file', resumePath, '--json']);
  store = await openStore({ workspace: root });
  const stalePreflight = preflightResumeArtifact(store, supportedDraft.id);
  assert.equal(stalePreflight.valid, false);
  assert.ok(stalePreflight.blockers.some(blocker => blocker.code === 'resume_stale_source_revision'));
  assert.throws(() => reviewArtifact(store, { artifactId: supportedDraft.id, approvalStatus: 'approved', source: 'tui' }), error => error.code === 'resume_stale_source_revision');
  store.db.close();
});

test('domain tailoring preserves requested layout and PDF preflight options', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Domain Resume', '--json']));
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator research and shipped a workflow that reduced review time by 30%.', '--evidence', 'Verified portfolio evidence', '--json']));
  const document = completeResume();
  document.summary.proofPointIds = [proof.id];
  document.experience[0].bullets[0].proofPointIds = [proof.id];
  const resumePath = path.join(root, 'resume.json');
  writeFileSync(resumePath, JSON.stringify(document, null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
  const jobPath = path.join(root, 'job.md');
  writeFileSync(jobPath, 'Title: Technical Product Manager\nCompany: Learning Co\n\n## Requirements\n- Must lead educator research and reduce review time.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobPath, '--json']));
  const store = await openStore({ workspace: root });
  const draft = await callDomainTool(store, 'tailor_resume', { jobId: job.id, profileId: profile.id, layoutProfileId: 'technical', pageSize: 'a4', pageLimit: 1, density: 'compact', format: 'pdf' }, { source: 'cli' });
  assert.equal(draft.layoutProfile.roleFamily, 'technical');
  assert.equal(draft.layoutProfile.pageSize, 'a4');
  assert.equal(draft.layoutProfile.pageLimit, 1);
  assert.equal(draft.layoutProfile.density, 'compact');
  assert.equal(draft.renderManifest.format, 'pdf');
  assert.ok(['passed', 'blocked'].includes(draft.renderManifest.status));
  store.db.close();
});

test('typed transformations preserve fixed facts and reject invented claims', () => {
  const canonical = completeResume();
  const proof = { id: 'proof_valid', status: 'active', verification_status: 'verified', summary: 'Reduced review time by 30%.', metrics: ['30%'], metrics_json: '[\"30%\"]', skills: ['user research'] };
  canonical.experience[0].bullets[0].proofPointIds = [proof.id];
  const transformed = applyResumeTransformations(canonical, {
    summary: { text: 'Product leader who reduced review time by 30%.', proofPointIds: [proof.id] },
    bullets: [{ sourceBulletId: 'bullet_launch', proofPointIds: [proof.id], text: 'Shipped an educator workflow that reduced review time by 30%.' }],
    selectedSkillIds: ['skill_sql', 'skill_research'],
    layoutProfileId: 'technical',
    warnings: []
  }, [proof]);
  assert.equal(transformed.document.identity.email, canonical.identity.email);
  assert.equal(transformed.document.experience[0].employer, canonical.experience[0].employer);
  assert.equal(transformed.document.education[0].institution, canonical.education[0].institution);
  assert.match(renderSemanticResumeMarkdown(transformed.document), /State University/);
  const inventory = extractRequirementInventory('## Requirements\n- Must conduct user research.');
  const coverage = buildRequirementCoverage(inventory, [proof]);
  const valid = validateTailoredResume({ document: transformed.document, canonical, proofs: [proof], coverage, sourceResumeRevisionId: 'resume_1' });
  assert.equal(valid.valid, true);

  const invented = structuredClone(transformed.document);
  invented.experience[0].employer = 'Invented Employer';
  invented.experience[0].bullets[0].text = 'Generated $10M while reducing review time by 30%.';
  invented.credentials.push({ id: 'credential_fake', name: 'Invented MBA', issuer: 'Fake University', date: '2024', verificationStatus: 'verified' });
  const invalid = validateTailoredResume({ document: invented, canonical, proofs: [proof], coverage, sourceResumeRevisionId: 'resume_1' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.blockers.some(blocker => blocker.code === 'resume_unsupported_metric'));
  assert.ok(invalid.blockers.some(blocker => blocker.field === 'experience.experience_acme'));
  assert.ok(invalid.blockers.some(blocker => blocker.field === 'credentials'));
});

test('one-proof outline cannot become a valid semantic resume', async () => {
  const { root, env, run } = makeRunner();
  run(['init', '--json']);
  const sourceResume = path.join(root, 'outline.md');
  writeFileSync(sourceResume, '- Led educator research that improved a workflow by 30%.\n');
  const profile = JSON.parse(run(['profile', 'create', 'Incomplete Outline', '--from-resume', sourceResume, '--json']));
  const jobPath = path.join(root, 'job.md');
  writeFileSync(jobPath, 'Title: Product Manager\nCompany: Acme\n\n## Requirements\n- Must conduct educator research.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobPath, '--json']));
  const tailoring = spawnSync(process.execPath, ['src/cli.js', 'tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.notEqual(tailoring.status, 0);
  assert.match(tailoring.stderr, /resume_source_missing/);
  const plan = JSON.parse(run(['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.materials.resume.status, 'missing');
  const store = await openStore({ workspace: root });
  assert.equal(dbOne(store, 'SELECT id FROM profile_resume_revisions WHERE profile_id=?', [profile.id]), null);
  assert.equal(dbOne(store, 'SELECT verification_status FROM proof_points WHERE profile_id=?', [profile.id]).verification_status, 'unverified');
  store.db.close();
});

test('LaTeX renderer is deterministic, escaped, and profile-constrained', () => {
  const document = completeResume();
  document.identity.name = 'Avery & Co \\\\input{evil}';
  document.summary.text = 'Built R&D systems at 30% efficiency with $10M scope #1.';
  const professional = resolveLayoutProfile({ title: 'Product Manager', description: '' }, { layout: 'professional', pageSize: 'letter', pageLimit: 2 });
  const technical = resolveLayoutProfile({ title: 'Software Engineer', description: '' }, { layout: 'technical', pageSize: 'a4', pageLimit: 1 });
  const leadership = resolveLayoutProfile({ title: 'VP Product', description: '' }, { layout: 'leadership' });
  assert.deepEqual(professional.sectionOrder.slice(0, 3), ['summary', 'experience', 'skills']);
  assert.deepEqual(technical.sectionOrder.slice(0, 3), ['summary', 'skills', 'experience']);
  assert.equal(leadership.roleFamily, 'leadership');
  const letterFirst = renderResumeLatex(document, professional);
  const letterSecond = renderResumeLatex(document, professional);
  const a4 = renderResumeLatex(document, technical);
  assert.equal(letterFirst, letterSecond);
  assert.match(letterFirst, /letterpaper/);
  assert.match(a4, /a4paper/);
  assert.doesNotMatch(letterFirst, /\\\\input\\{evil\\}/);
  assert.ok(letterFirst.includes('Avery \\& Co \\textbackslash{}'));
  assert.equal(latexEscape('%_$&#{}'), ['%', '_', '$', '&', '#', '{', '}'].map(character => `\\${character}`).join(''));
  assert.equal(document.experience[0].employer, 'Acme Learning');
  assert.equal(document.credentials[0].name, 'CSPO');
});

test('render preflights enforce extraction order, geometry, images, and page budget', () => {
  const document = completeResume();
  const profile = resolveLayoutProfile({ title: 'Product Manager', description: '' }, { layout: 'professional', pageSize: 'letter', pageLimit: 1 });
  const extracted = renderSemanticResumeMarkdown(document, profile);
  const textCheck = preflightExtractedText(document, extracted, profile);
  assert.equal(textCheck.valid, true);
  const wrongOrder = extracted.replaceAll('## Experience', '## TEMP').replaceAll('## Skills', '## Experience').replaceAll('## TEMP', '## Skills');
  assert.equal(preflightExtractedText(document, wrongOrder, profile).valid, false);
  assert.equal(preflightPdfMetadata(profile, { pageCount: 1, reportedSize: '612 x 792 pts (letter)', imageCount: 1 }).valid, true);
  const overflow = preflightPdfMetadata(profile, { pageCount: 2, reportedSize: '612 x 792 pts (letter)', imageCount: 1 });
  assert.ok(overflow.blockers.some(blocker => blocker.code === 'resume_page_budget_exceeded'));
  assert.ok(overflow.blockers.some(blocker => /image count/i.test(blocker.message)));
  const a4 = resolveLayoutProfile(null, { layout: 'technical', pageSize: 'a4' });
  assert.equal(preflightPdfMetadata(a4, { pageCount: 1, reportedSize: '595 x 842 pts (A4)', imageCount: 1 }).valid, true);
});

test('missing LaTeX dependency returns a typed blocker and never creates a fake PDF', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-render-test-'));
  const statePath = path.join(root, '.jobos');
  const workspacePath = path.join(root, 'jobos-workspace');
  const profile = resolveLayoutProfile(null, { layout: 'professional', pageSize: 'letter' });
  const manifest = renderResumePdf({ statePath, workspacePath, jobId: 'job_render', artifact: { contentHash: 'abc' }, document: completeResume(), layoutProfile: profile, engine: 'not-an-engine' });
  assert.equal(manifest.status, 'blocked');
  assert.ok(manifest.blockers.some(blocker => blocker.code === 'resume_render_failed'));
  assert.equal(existsSync(path.join(workspacePath, 'jobs', 'job_render', 'artifacts', 'resume-tailored.tex')), true);
  assert.equal(existsSync(path.join(workspacePath, 'jobs', 'job_render', 'artifacts', 'resume-tailored.pdf')), false);
});

test('resume feedback exposes linked gaps and gates outcome comparisons on sample size', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Feedback Profile', '--json']));
  const resumePath = path.join(root, 'resume.json');
  writeFileSync(resumePath, JSON.stringify(completeResume(), null, 2));
  run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']);
  const store = await openStore({ workspace: root });
  const sourceResumeId = dbOne(store, 'SELECT id FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profile.id]).id;
  const at = new Date().toISOString();
  for (let index = 0; index < 10; index += 1) {
    const jobId = `job_feedback_${index}`;
    const artifactId = `artifact_feedback_${index}`;
    const seriesKey = `resume:${jobId}:${profile.id}`;
    dbRun(store, 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [artifactId, jobId, profile.id, 'resume', `jobs/${jobId}/artifacts/resume-tailored.md`, 'Feedback resume', 'Resume', '[]', '[]', 'approved', at, seriesKey, 1, null, `hash_${index}`, at, 'cli', '']);
    const coverageRatio = index < 5 ? 0.2 : 0.8;
    const coverage = { summary: { coverageRatio }, unsupported: [{ requirementId: `requirement_${index}`, requirement: { sourceText: 'Kubernetes platform experience', category: 'skill', priority: 'must_have' } }] };
    dbRun(store, 'INSERT INTO artifact_resume_documents (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json) VALUES (?,?,?,?,?,?,?,?)', [artifactId, 1, sourceResumeId, '{}', JSON.stringify(coverage), JSON.stringify({ valid: true, blockers: [], warnings: [] }), '{}', JSON.stringify({ format: 'markdown', status: 'not_requested' })]);
    dbRun(store, 'INSERT INTO applications (id,job_id,profile_id,status,notes,confirmation_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [`app_feedback_${index}`, jobId, profile.id, index < 5 ? 'rejected' : 'interview', '', '', at, at]);
  }
  dbSave(store);
  const proofCountBefore = Number(dbOne(store, 'SELECT COUNT(*) AS count FROM proof_points WHERE profile_id=?', [profile.id]).count);
  const report = resumeFeedback(store, profile.id);
  const proofCountAfter = Number(dbOne(store, 'SELECT COUNT(*) AS count FROM proof_points WHERE profile_id=?', [profile.id]).count);
  assert.equal(report.artifactSampleSize, 10);
  assert.equal(report.outcomeComparison.available, true);
  assert.equal(report.outcomeComparison.causalClaim, false);
  assert.match(report.outcomeComparison.uncertainty, /does not establish causation/i);
  assert.equal(report.recurringUnsupported[0].count, 10);
  assert.equal(report.recurringUnsupported[0].occurrences[0].artifactId, 'artifact_feedback_0');
  assert.equal(report.recommendations[0].sources.length, 10);
  assert.deepEqual(report.generatedClaims, []);
  assert.equal(report.policy.createsResumeClaims, false);
  assert.equal(proofCountAfter, proofCountBefore);
  store.db.close();

  const cliReport = JSON.parse(run(['analytics', 'resume-feedback', '--profile', profile.id, '--json']));
  assert.equal(cliReport.outcomeComparison.available, true);
  assert.equal(cliReport.policy.externalSideEffects, 'none');
});

test('invented qualitative claim with no numbers is blocked by claim vocabulary gate', () => {
  const canonical = completeResume();
  const proof = { id: 'proof_valid', status: 'active', verification_status: 'verified', summary: 'Reduced review time by 30%.', metrics: ['30%'], metrics_json: '["30%"]', skills: ['user research'] };
  canonical.experience[0].bullets[0].proofPointIds = [proof.id];
  const transformed = applyResumeTransformations(canonical, {
    bullets: [{ sourceBulletId: 'bullet_launch', proofPointIds: [proof.id], text: 'Won international awards and transformed company culture.' }],
    warnings: []
  }, [proof]);
  assert.ok(transformed.warnings.some(w => /not supported/i.test(w)));
  assert.equal(transformed.document.experience[0].bullets[0].generated, undefined);
  assert.equal(transformed.document.experience[0].bullets[0].text, canonical.experience[0].bullets[0].text);
  const invented = structuredClone(canonical);
  invented.experience[0].bullets[0].text = 'Won international awards and transformed company culture.';
  invented.experience[0].bullets[0].proofPointIds = [proof.id];
  invented.experience[0].bullets[0].generated = true;
  const inventory = extractRequirementInventory('## Requirements\n- Must conduct user research.');
  const coverage = buildRequirementCoverage(inventory, [proof]);
  const validation = validateTailoredResume({ document: invented, canonical, proofs: [proof], coverage, sourceResumeRevisionId: 'resume_1' });
  assert.equal(validation.valid, false);
  assert.ok(validation.blockers.some(b => b.code === 'resume_unsupported_claim' && Array.isArray(b.terms) && b.terms.length > 0));
});

test('legitimate bounded rewrite using source and proof vocabulary passes', () => {
  const canonical = completeResume();
  const proof = { id: 'proof_valid', status: 'active', verification_status: 'verified', summary: 'Reduced review time by 30%.', metrics: ['30%'], metrics_json: '["30%"]', skills: ['user research'] };
  canonical.experience[0].bullets[0].proofPointIds = [proof.id];
  const transformed = applyResumeTransformations(canonical, {
    bullets: [{ sourceBulletId: 'bullet_launch', proofPointIds: [proof.id], text: 'Shipped educator research workflow that reduced review time by 30%.' }],
    warnings: []
  }, [proof]);
  assert.equal(transformed.warnings.length, 0);
  assert.equal(transformed.document.experience[0].bullets[0].generated, true);
  assert.match(transformed.document.experience[0].bullets[0].text, /reduced review time by 30%/);
  const inventory = extractRequirementInventory('## Requirements\n- Must conduct user research.');
  const coverage = buildRequirementCoverage(inventory, [proof]);
  const validation = validateTailoredResume({ document: transformed.document, canonical, proofs: [proof], coverage, sourceResumeRevisionId: 'resume_1' });
  assert.equal(validation.valid, true);
});

test('generated text cannot claim unsupported requirements', () => {
  const canonical = completeResume();
  const proof = { id: 'proof_valid', status: 'active', verification_status: 'verified', summary: 'Reduced review time by 30%.', metrics: ['30%'], metrics_json: '["30%"]', skills: ['user research'] };
  canonical.experience[0].bullets[0].proofPointIds = [proof.id];
  const transformed = applyResumeTransformations(canonical, {
    bullets: [{ sourceBulletId: 'bullet_launch', proofPointIds: [proof.id], text: 'Earned PMP certification and reduced review time by 30%.' }],
    warnings: []
  }, [proof]);
  assert.ok(transformed.warnings.some(w => /not supported/i.test(w)));
  assert.equal(transformed.document.experience[0].bullets[0].generated, undefined);
});

test('migration backfills legacy resume_import proofs as unverified while preserving manual proofs', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Migration Test', '--json']));
  const at = new Date().toISOString();
  let store = await openStore({ workspace: root });
  dbRun(store, 'INSERT INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,status,verification_status,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ['proof_legacy_import', profile.id, 'Legacy import proof', '', '[]', '[]', 'resume_import', '{}', 'active', 'verified', at, at]);
  dbRun(store, 'INSERT INTO proof_points (id,profile_id,summary,evidence,skills_json,metrics_json,source,metadata_json,status,verification_status,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ['proof_legacy_manual', profile.id, 'Legacy manual proof', '', '[]', '[]', 'manual', '{}', 'active', 'verified', at, at]);
  dbRun(store, "DELETE FROM meta WHERE key='migration_resume_import_backfill'");
  dbSave(store);
  store.db.close();
  store = await openStore({ workspace: root });
  const importProof = dbOne(store, 'SELECT verification_status FROM proof_points WHERE id=?', ['proof_legacy_import']);
  const manualProof = dbOne(store, 'SELECT verification_status FROM proof_points WHERE id=?', ['proof_legacy_manual']);
  assert.equal(importProof.verification_status, 'unverified');
  assert.equal(manualProof.verification_status, 'verified');
  dbRun(store, "UPDATE proof_points SET verification_status='verified' WHERE id='proof_legacy_import'");
  dbSave(store);
  store.db.close();
  store = await openStore({ workspace: root });
  const reVerified = dbOne(store, 'SELECT verification_status FROM proof_points WHERE id=?', ['proof_legacy_import']);
  assert.equal(reVerified.verification_status, 'verified');
  store.db.close();
});

test('explicit empty selectedProofPointIds yields zero supported while omitted selection preserves discovery coverage', () => {
  const proof = { id: 'proof_research', status: 'active', verification_status: 'verified', summary: 'Conducted educator user research.', skills: ['user research'], skills_json: '["user research"]', metrics: [], metrics_json: '[]' };
  const inventory = extractRequirementInventory('## Required Qualifications\n- Must conduct educator user research.');
  const initial = buildRequirementCoverage(inventory, [proof]);
  assert.ok(initial.summary.supportedImportantCount >= 1);
  assert.ok(initial.matched.length >= 1);
  const finalEmpty = buildRequirementCoverage(inventory, [proof], { selectedProofPointIds: [] });
  assert.equal(finalEmpty.summary.supportedImportantCount, 0);
  assert.equal(finalEmpty.matched.length, 0);
  assert.ok(finalEmpty.omittedSupported.length >= 1);
  const finalSelected = buildRequirementCoverage(inventory, [proof], { selectedProofPointIds: ['proof_research'] });
  assert.ok(finalSelected.summary.supportedImportantCount >= 1);
  assert.ok(finalSelected.matched.length >= 1);
  assert.equal(finalSelected.omittedSupported.length, 0);
});

test('vocabulary gate blocks changed text even when generated flag is absent', () => {
  const canonical = completeResume();
  const proof = { id: 'proof_valid', status: 'active', verification_status: 'verified', summary: 'Reduced review time by 30%.', metrics: ['30%'], metrics_json: '["30%"]', skills: ['user research'] };
  canonical.experience[0].bullets[0].proofPointIds = [proof.id];
  const modified = structuredClone(canonical);
  modified.experience[0].bullets[0].text = 'Won international awards and transformed company culture.';
  modified.experience[0].bullets[0].proofPointIds = [proof.id];
  modified.experience[0].bullets[0].generated = false;
  const inventory = extractRequirementInventory('## Requirements\n- Must conduct user research.');
  const coverage = buildRequirementCoverage(inventory, [proof]);
  const validation = validateTailoredResume({ document: modified, canonical, proofs: [proof], coverage, sourceResumeRevisionId: 'resume_1' });
  assert.equal(validation.valid, false);
  assert.ok(validation.blockers.some(b => b.code === 'resume_unsupported_claim' && Array.isArray(b.terms) && b.terms.length > 0));
});

test('latexUrlEscape normalizes backslashes instead of emitting LaTeX line breaks', () => {
  const escaped = latexUrlEscape('https://example.com\\path');
  assert.equal(escaped, 'https://example.com/path');
  assert.equal(escaped.includes('\\'), false);
  const document = completeResume();
  document.identity.links[0].url = 'https://example.com\\profile';
  const profile = resolveLayoutProfile({ title: 'Product Manager', description: '' }, { layout: 'professional', pageSize: 'letter' });
  const latex = renderResumeLatex(document, profile);
  assert.match(latex, /https:\/\/example\.com\/profile/);
  assert.doesNotMatch(latex, /href\{[^}]*\\\\[^}]*\}/);
});
