import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import mammoth from 'mammoth';

import { renderSemanticResumeMarkdown } from '../src/resume-tailoring.js';
import { renderResumeDocx } from '../src/resume-docx.js';
import { listResumeTemplates, preflightExtractedText, preflightPdfMetadata, renderResumeLatex, resolveAccentColor, resolveLayoutProfile } from '../src/resume-renderer.js';

function completeResume(proofPointId = 'proof_launch') {
  return {
    schemaVersion: 1,
    identity: {
      name: 'Avery Candidate', email: 'avery@example.com', phone: '+1 555 555 0100', location: 'Chicago, IL', verificationStatus: 'verified',
      links: [{ id: 'link_portfolio', label: 'Portfolio', url: 'https://example.com/avery', verificationStatus: 'verified' }]
    },
    summary: { id: 'summary_main', text: 'Product leader focused on trustworthy education technology.', verificationStatus: 'verified', proofPointIds: [proofPointId] },
    experience: [{
      id: 'experience_acme', employer: 'Acme Learning', title: 'Senior Product Manager', location: 'Remote', startDate: '2021-02', endDate: null,
      dateSource: { startText: '2021-02', endText: 'Present', verificationStatus: 'verified' }, verificationStatus: 'verified',
      bullets: [{ id: 'bullet_launch', text: 'Led educator research and shipped a workflow that reduced review time by 30%.', proofPointIds: [proofPointId], verificationStatus: 'verified' }]
    }],
    education: [{ id: 'education_state', institution: 'State University', degree: 'BS', field: 'Computer Science', location: 'Chicago, IL', startDate: '2012', endDate: '2016', verificationStatus: 'verified' }],
    skills: [{ id: 'skill_research', name: 'User research', category: 'Product', verificationStatus: 'verified' }, { id: 'skill_sql', name: 'SQL', category: 'Technical', verificationStatus: 'verified' }],
    credentials: [{ id: 'credential_cspo', name: 'CSPO', issuer: 'Scrum Alliance', date: '2020', verificationStatus: 'verified' }],
    projects: [{ id: 'project_access', name: 'Accessibility Lab', description: 'Open accessibility research project.', url: 'https://example.com/accessibility', verificationStatus: 'verified', bullets: [{ id: 'project_bullet', text: 'Published accessible workflow guidance.', proofPointIds: [proofPointId], verificationStatus: 'verified' }] }],
    additionalSections: [{ id: 'section_community', title: 'Community Leadership', entries: ['Mentor, Product Collective'], verificationStatus: 'verified' }]
  };
}

function runner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-document-system-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const execute = args => spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  const run = args => {
    const result = execute(args);
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  const fail = args => {
    const result = execute(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    return `${result.stdout}\n${result.stderr}`;
  };
  return { root, run, fail };
}

test('curated templates are distinct, single-column, conventionally ordered, and pagination-safe', () => {
  const document = completeResume();
  const catalog = listResumeTemplates();
  assert.deepEqual(catalog.map(template => template.id), ['classic', 'modern', 'executive', 'technical']);
  assert.ok(catalog.every(template => template.atsSafe && template.columns === 1 && template.conventionalHeadings && template.accessibleReadingOrder));
  const rendered = new Set();
  for (const [index, template] of catalog.entries()) {
    const profile = resolveLayoutProfile({ title: 'Product Manager', description: '' }, { template: template.id, pageSize: index % 2 ? 'a4' : 'letter', pageLimit: index % 2 ? 2 : 1 });
    const latex = renderResumeLatex(document, profile);
    rendered.add(crypto.createHash('sha256').update(latex).digest('hex'));
    assert.doesNotMatch(latex, /\\(?:begin\{(?:multicols|tabular|minipage)|includegraphics|parbox|tikz)/i);
    for (const heading of ['Experience', 'Skills', 'Education', 'Credentials', 'Projects']) assert.match(latex, new RegExp(`section\\*\\{${heading}\\}`));
    const markdown = renderSemanticResumeMarkdown(document, profile);
    assert.equal(preflightExtractedText(document, markdown, profile).valid, true);
    const geometry = profile.pageSize === 'a4' ? '595 x 842 pts (A4)' : '612 x 792 pts (letter)';
    assert.equal(preflightPdfMetadata(profile, { pageCount: profile.pageLimit, reportedSize: geometry, imageCount: profile.pageLimit }).valid, true);
    assert.ok(preflightPdfMetadata(profile, { pageCount: profile.pageLimit + 1, reportedSize: geometry, imageCount: profile.pageLimit + 1 }).blockers.some(blocker => blocker.code === 'resume_page_budget_exceeded'));
  }
  assert.equal(rendered.size, 4);
  const technical = resolveLayoutProfile(null, { template: 'technical' });
  assert.deepEqual(technical.sectionOrder.slice(0, 4), ['summary', 'skills', 'projects', 'experience']);
  const executive = resolveLayoutProfile(null, { template: 'executive' });
  assert.deepEqual(executive.sectionOrder.slice(0, 4), ['summary', 'experience', 'projects', 'skills']);
});

test('accent colors require accessible text contrast and otherwise use the neutral palette', () => {
  const safe = resolveAccentColor('#003366', 'modern');
  assert.equal(safe.status, 'safe');
  assert.equal(safe.appliedColor, '#003366');
  assert.ok(safe.contrastRatio >= 4.5);
  const lowContrast = resolveAccentColor('#FFFF00', 'modern');
  assert.equal(lowContrast.status, 'fallback');
  assert.equal(lowContrast.appliedColor, '#1F4E5F');
  assert.ok(lowContrast.contrastRatio >= 4.5);
  assert.equal(lowContrast.warning.code, 'resume_accent_color_unsafe');
  const invalid = resolveAccentColor('company-blue', 'executive');
  assert.equal(invalid.status, 'fallback');
  assert.equal(invalid.appliedColor, '#4B3A2A');
});

test('every template exports ATS-readable single-column flowing DOCX in semantic order', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-docx-render-'));
  const workspacePath = path.join(root, 'jobos-workspace');
  const document = completeResume();
  const hashes = new Set();
  for (const [index, template] of listResumeTemplates().entries()) {
    const profile = resolveLayoutProfile(null, { template: template.id, pageSize: index % 2 ? 'a4' : 'letter', pageLimit: index % 2 ? 2 : 1, density: index % 2 ? 'standard' : 'compact' });
    const artifact = { id: `artifact_${template.id}`, contentHash: crypto.createHash('sha256').update(template.id).digest('hex') };
    const manifest = await renderResumeDocx({ workspacePath, jobId: 'job_docx', artifact, document, layoutProfile: profile });
    assert.equal(manifest.status, 'passed', JSON.stringify(manifest.blockers));
    assert.equal(manifest.textPreflight.valid, true);
    assert.deepEqual(manifest.pagination, { mode: 'flowing', columns: 1, forcedPageBreaks: 0 });
    assert.ok(existsSync(path.join(workspacePath, manifest.docxPath)));
    hashes.add(manifest.docxHash);
    const bytes = readFileSync(path.join(workspacePath, manifest.docxPath));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.docxHash);
    const archive = await JSZip.loadAsync(bytes);
    const documentXml = await archive.file('word/document.xml').async('string');
    assert.match(documentXml, /<w:cols w:num="1"/);
    assert.doesNotMatch(documentXml, /<w:(?:tbl|drawing|txbxContent)|<w:br w:type="page"/);
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    assert.equal(preflightExtractedText(document, extracted.value, profile).orderValid, true);
    const expectedPageWidth = profile.pageSize === 'a4' ? '11906' : '12240';
    assert.match(documentXml, new RegExp(`<w:pgSz w:w="${expectedPageWidth}"`));
  }
  assert.equal(hashes.size, 4);
});

test('default template, per-application override, preview, download, and approval bind exact revisions', () => {
  const { root, run, fail } = runner();
  JSON.parse(run(['init', '--json']));
  const profile = JSON.parse(run(['profile', 'create', 'Document Integrity', '--json']));
  const templates = JSON.parse(run(['resume', 'templates', '--json']));
  assert.equal(templates.length, 4);
  const preference = JSON.parse(run(['resume', 'template', '--profile', profile.id, '--template', 'modern', '--accent-color', '#FFFF00', '--json']));
  assert.equal(preference.defaultTemplate, 'modern');
  assert.equal(preference.accent.status, 'fallback');
  assert.equal(preference.accentColor, null);
  const proof = JSON.parse(run(['proof', 'add', '--profile', profile.id, '--summary', 'Led educator research and shipped a workflow that reduced review time by 30%.', '--evidence', 'Verified portfolio evidence', '--skills', 'user research,product management', '--json']));
  const resumePath = path.join(root, 'resume.json');
  writeFileSync(resumePath, JSON.stringify(completeResume(proof.id), null, 2));
  JSON.parse(run(['resume', 'import', '--profile', profile.id, '--file', resumePath, '--json']));
  const jobPath = path.join(root, 'job.md');
  writeFileSync(jobPath, 'Title: Technical Product Manager\nCompany: Learning Co\n\n## Requirements\n- Must lead educator research and reduce review time.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobPath, '--json']));

  const first = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--format', 'docx', '--json']));
  assert.equal(first.layoutProfile.templateId, 'modern');
  assert.equal(first.renderManifest.status, 'passed');
  assert.equal(first.approvalStatus, 'draft_needs_human_review');
  const firstPreview = JSON.parse(run(['artifacts', 'preview', first.id, '--json']));
  assert.equal(firstPreview.exactRevision.artifactId, first.id);
  assert.equal(firstPreview.exactRevision.revision, 1);
  assert.equal(firstPreview.downloads[0].hash, first.renderManifest.docxHash);
  assert.equal(firstPreview.approvalRequired, true);
  const downloadedPath = path.join(root, 'downloads', 'first.docx');
  const download = JSON.parse(run(['artifacts', 'download', first.id, '--format', 'docx', '--to', downloadedPath, '--json']));
  assert.equal(download.hash, first.renderManifest.docxHash);
  assert.equal(download.approvalRequired, true);
  assert.equal(crypto.createHash('sha256').update(readFileSync(downloadedPath)).digest('hex'), first.renderManifest.docxHash);

  const firstDocxPath = path.join(root, 'jobos-workspace', first.renderManifest.docxPath);
  const firstBytes = readFileSync(firstDocxPath);
  writeFileSync(firstDocxPath, Buffer.concat([firstBytes, Buffer.from('tampered')]));
  assert.match(fail(['artifacts', 'approve', first.id, '--note', 'Reviewed.', '--json']), /diverged from exact artifact revision|resume_export_revision_mismatch/i);
  writeFileSync(firstDocxPath, firstBytes);

  const second = JSON.parse(run(['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--template', 'technical', '--accent-color', '#003366', '--format', 'docx', '--json']));
  assert.equal(second.revision, 2);
  assert.equal(second.layoutProfile.templateId, 'technical');
  assert.equal(second.layoutProfile.accent.status, 'safe');
  assert.notEqual(second.renderManifest.docxPath, first.renderManifest.docxPath);
  const supersededPreview = JSON.parse(run(['artifacts', 'preview', first.id, '--json']));
  assert.equal(supersededPreview.exactRevision.revisionState, 'superseded');
  assert.equal(supersededPreview.downloads[0].hash, first.renderManifest.docxHash);
  assert.match(fail(['artifacts', 'approve', first.id, '--note', 'Reviewed stale revision.', '--json']), /superseded|artifact_not_current/i);
  const approval = JSON.parse(run(['artifacts', 'approve', second.id, '--note', 'Reviewed exact DOCX revision.', '--json']));
  assert.equal(approval.approvalStatus, 'approved');
  assert.equal(approval.submissionPerformed, false);
  assert.equal(approval.externalSideEffects, 'none');
  const approvedPreview = JSON.parse(run(['artifacts', 'preview', second.id, '--json']));
  assert.equal(approvedPreview.approvalRequired, false);
  assert.equal(approvedPreview.exactRevision.contentHash, second.contentHash);
});
