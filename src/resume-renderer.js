import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEMPLATE_ID = 'jobos-classic';
const TEMPLATE_VERSION = 1;
const ALLOWED_SECTIONS = new Set(['summary', 'skills', 'experience', 'projects', 'education', 'credentials', 'additionalSections']);
const PROFILE_ORDERS = {
  professional: ['summary', 'experience', 'skills', 'education', 'credentials', 'projects', 'additionalSections'],
  technical: ['summary', 'skills', 'experience', 'projects', 'education', 'credentials', 'additionalSections'],
  leadership: ['summary', 'experience', 'projects', 'skills', 'education', 'credentials', 'additionalSections']
};
const TEX_ENGINES = new Set(['tectonic', 'pdflatex']);

function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function text(value) { return value == null ? '' : String(value); }
function normalizedText(value) { return text(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9+.%$]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function safePageSize(value) { return String(value || '').toLowerCase() === 'a4' ? 'a4' : 'letter'; }
function boundedPageLimit(value) { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 2 ? number : 2; }

export function latexEscape(value) {
  const replacements = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '%': '\\%', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return text(value).replace(/[\\{}$&#%_~^]/g, character => replacements[character]);
}
export function latexUrlEscape(value) {
  return text(value).replace(/\\/g, '/').replace(/([%#{}])/g, '\\$1');
}
function roleFamilyFor(job) {
  const value = `${job?.title || ''} ${job?.description || ''}`.toLowerCase();
  if (/\b(engineer|developer|data|software|technical|machine learning|scientist|architect)\b/.test(value)) return 'technical';
  if (/\b(chief|executive|vice president|vp|director|head of|general manager)\b/.test(value)) return 'leadership';
  return 'professional';
}
export function resolveLayoutProfile(job, options = {}) {
  const roleFamily = PROFILE_ORDERS[options.layout]
    ? options.layout
    : PROFILE_ORDERS[options.roleFamily] ? options.roleFamily : roleFamilyFor(job);
  const requestedOrder = Array.isArray(options.sectionOrder) ? options.sectionOrder : PROFILE_ORDERS[roleFamily];
  const sectionOrder = [...new Set(requestedOrder.filter(sectionName => ALLOWED_SECTIONS.has(sectionName)))];
  for (const sectionName of PROFILE_ORDERS[roleFamily]) if (!sectionOrder.includes(sectionName)) sectionOrder.push(sectionName);
  return { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, roleFamily, sectionOrder, density: options.density === 'compact' ? 'compact' : 'standard', pageSize: safePageSize(options.pageSize), pageLimit: boundedPageLimit(options.pageLimit) };
}

function dateText(entry) {
  const start = entry.dateSource?.startText || entry.startDate || '';
  const end = entry.dateSource?.endText || entry.endDate || (entry.startDate ? 'Present' : '');
  return [start, end].filter(Boolean).join(' -- ');
}
function itemize(items) {
  return items.length ? `\\begin{itemize}\n${items.map(item => `\\item ${latexEscape(item)}`).join('\n')}\n\\end{itemize}` : '';
}
function section(title, body) { return body ? `\\section*{${latexEscape(title)}}\n${body}` : ''; }
function link(label, url) { return `\\href{${latexUrlEscape(url)}}{${latexEscape(label || url)}}`; }

export function renderResumeLatex(document, layoutProfile, { templateText = null } = {}) {
  const profile = resolveLayoutProfile(null, layoutProfile);
  const template = templateText ?? fs.readFileSync(new URL('../templates/jobos-classic.tex', import.meta.url), 'utf8');
  const identity = document.identity || {};
  const contact = [identity.email, identity.phone, identity.location].filter(Boolean).map(latexEscape);
  for (const value of identity.links || []) if (value.url) contact.push(link(value.label, value.url));
  const rendered = {
    summary: section(profile.roleFamily === 'leadership' ? 'Executive Summary' : 'Professional Summary', latexEscape(document.summary?.text || '')),
    skills: section('Skills', latexEscape((document.skills || []).map(skill => skill.name).join(' • '))),
    experience: section('Experience', (document.experience || []).map(entry => {
      const heading = `\\jobosrole{${latexEscape(entry.title)}}{${latexEscape([entry.employer, entry.location].filter(Boolean).join(' | '))}}{${latexEscape(dateText(entry))}}`;
      return `${heading}\n${itemize((entry.bullets || []).map(bullet => bullet.text))}`;
    }).join('\n\\vspace{4pt}\n')),
    projects: section('Projects', (document.projects || []).map(entry => {
      const heading = `\\jobosproject{${latexEscape(entry.name)}}{${entry.url ? link('Project link', entry.url) : ''}}`;
      return `${heading}${entry.description ? `\\\\\n${latexEscape(entry.description)}` : ''}\n${itemize((entry.bullets || []).map(bullet => bullet.text))}`;
    }).join('\n\\vspace{4pt}\n')),
    education: section('Education', (document.education || []).map(entry => `\\jobosrole{${latexEscape(entry.degree || entry.field || 'Education')}}{${latexEscape([entry.institution, entry.field, entry.location].filter(Boolean).join(' | '))}}{${latexEscape([entry.startDate, entry.endDate].filter(Boolean).join(' -- '))}}`).join('\n\\vspace{3pt}\n')),
    credentials: section('Credentials', itemize((document.credentials || []).map(entry => `${entry.name}${entry.issuer ? ` — ${entry.issuer}` : ''}${entry.date ? ` (${entry.date})` : ''}`))),
    additionalSections: (document.additionalSections || []).map(value => section(value.title, itemize(value.entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry))))).join('\n')
  };
  const body = `\\begin{center}\n{\\LARGE\\bfseries ${latexEscape(identity.name)}}\\\\[3pt]\n${contact.join(' \\textbar{} ')}\n\\end{center}\n${profile.sectionOrder.map(sectionName => rendered[sectionName]).filter(Boolean).join('\n')}`;
  return template.replace('%%PAGE_SIZE%%', profile.pageSize === 'a4' ? 'a4paper' : 'letterpaper').replace('%%BODY%%', body);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 30000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024, cwd: options.cwd, env: { ...process.env, ...(options.env || {}) }, shell: false });
}
function toolVersion(command) {
  const result = run(command, ['--version'], { timeoutMs: 5000, maxBuffer: 128 * 1024 });
  return result.error?.code === 'ENOENT' ? null : text(result.stdout || result.stderr).split(/\r?\n/)[0].trim() || command;
}
function blocker(code, message, details = {}) { return { code, message, ...details }; }
function expectedText(document, profile) {
  const expected = [document.identity?.name, document.identity?.email, document.identity?.phone];
  const sectionLabels = { summary: profile.roleFamily === 'leadership' ? 'Executive Summary' : 'Professional Summary', skills: 'Skills', experience: 'Experience', projects: 'Projects', education: 'Education', credentials: 'Credentials' };
  for (const sectionName of profile.sectionOrder) if (sectionLabels[sectionName] && ((sectionName === 'summary' && document.summary?.text) || (sectionName === 'skills' && document.skills?.length) || (sectionName === 'experience' && document.experience?.length) || (sectionName === 'projects' && document.projects?.length) || (sectionName === 'education' && document.education?.length) || (sectionName === 'credentials' && document.credentials?.length))) expected.push(sectionLabels[sectionName]);
  for (const entry of document.experience || []) expected.push(entry.title, entry.employer, dateText(entry), ...(entry.bullets || []).map(bullet => bullet.text));
  for (const entry of document.education || []) expected.push(entry.institution, entry.degree, entry.field);
  for (const entry of document.credentials || []) expected.push(entry.name, entry.issuer);
  for (const entry of document.projects || []) expected.push(entry.name, entry.description, ...(entry.bullets || []).map(bullet => bullet.text));
  return expected.filter(Boolean);
}

export function preflightExtractedText(document, extractedText, profile) {
  const normalized = normalizedText(extractedText);
  const missing = expectedText(document, profile).filter(value => !normalized.includes(normalizedText(value)));
  const normalizedLines = text(extractedText).split(/\r?\n/).map(normalizedText);
  const sectionLabels = profile.sectionOrder.map(sectionName => ({ summary: profile.roleFamily === 'leadership' ? 'Executive Summary' : 'Professional Summary', skills: 'Skills', experience: 'Experience', projects: 'Projects', education: 'Education', credentials: 'Credentials' }[sectionName])).filter(Boolean).filter(label => normalizedLines.includes(normalizedText(label)));
  const positions = sectionLabels.map(label => normalizedLines.indexOf(normalizedText(label)));
  const orderValid = positions.every((position, index) => index === 0 || position > positions[index - 1]);
  const blockers = [];
  if (missing.length) blockers.push(blocker('resume_render_text_invalid', 'Rendered PDF is missing expected semantic text.', { missing }));
  if (!orderValid) blockers.push(blocker('resume_render_text_invalid', 'Rendered section extraction order differs from the semantic layout.', { sectionLabels }));
  return { valid: blockers.length === 0, blockers, missing, orderValid };
}
export function preflightPdfMetadata(profile, { pageCount, reportedSize, imageCount }) {
  const blockers = [];
  if (!pageCount) blockers.push(blocker('resume_render_failed', 'PDF page count could not be determined.'));
  if (pageCount > profile.pageLimit) blockers.push(blocker('resume_page_budget_exceeded', `PDF has ${pageCount} pages; limit is ${profile.pageLimit}.`, { pageCount, pageLimit: profile.pageLimit }));
  const expectsA4 = profile.pageSize === 'a4';
  if ((expectsA4 && !/595(?:\.\d+)? x 842/i.test(reportedSize)) || (!expectsA4 && !/612(?:\.\d+)? x 792/i.test(reportedSize))) blockers.push(blocker('resume_render_failed', `PDF page geometry does not match ${profile.pageSize}.`, { reportedSize }));
  if (imageCount !== pageCount) blockers.push(blocker('resume_render_failed', 'Rendered page-image count differs from PDF page count.', { pageCount, imageCount }));
  return { valid: blockers.length === 0, blockers };
}


export function renderResumePdf({ statePath, workspacePath, jobId, artifact, document, layoutProfile, timeoutMs = 30000, engine = process.env.JOBOS_TEX_ENGINE || 'tectonic' }) {
  const profile = resolveLayoutProfile(null, layoutProfile);
  const tex = renderResumeLatex(document, profile);
  const artifactsDirectory = path.join(workspacePath, 'jobs', jobId, 'artifacts');
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const stalePath of ['resume-tailored.pdf', 'resume-tailored.txt', 'resume-tailored.pages']) fs.rmSync(path.join(artifactsDirectory, stalePath), { recursive: true, force: true });
  const texPath = path.join(artifactsDirectory, 'resume-tailored.tex');
  fs.writeFileSync(texPath, tex);
  const baseManifest = { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, pageSize: profile.pageSize, pageLimit: profile.pageLimit, sourceArtifactHash: artifact.contentHash || artifact.content_hash, texHash: hashBuffer(tex), status: 'blocked', warnings: [], blockers: [], toolVersions: {} };
  if (!TEX_ENGINES.has(engine)) return { ...baseManifest, blockers: [blocker('resume_render_failed', `Unsupported LaTeX engine: ${engine}.`, { setupAction: 'Set JOBOS_TEX_ENGINE to tectonic or pdflatex.' })], texPath: path.relative(workspacePath, texPath) };
  const engineVersion = toolVersion(engine);
  if (!engineVersion) return { ...baseManifest, blockers: [blocker('resume_render_failed', `LaTeX engine ${engine} is not installed.`, { setupAction: `Install ${engine}, then rerun tailor resume --format pdf.` })], texPath: path.relative(workspacePath, texPath) };
  const pdftotextVersion = toolVersion('pdftotext');
  const pdfinfoVersion = toolVersion('pdfinfo');
  const pdftoppmVersion = toolVersion('pdftoppm');
  const missingTools = [['pdftotext', pdftotextVersion], ['pdfinfo', pdfinfoVersion], ['pdftoppm', pdftoppmVersion]].filter(([, version]) => !version).map(([name]) => name);
  if (missingTools.length) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('resume_render_failed', `Required PDF validation tools are missing: ${missingTools.join(', ')}.`, { setupAction: 'Install Poppler utilities and rerun PDF tailoring.' })], texPath: path.relative(workspacePath, texPath) };
  const temporaryDirectory = fs.mkdtempSync(path.join(statePath, 'resume-render-'));
  const temporaryTex = path.join(temporaryDirectory, 'resume-tailored.tex');
  fs.writeFileSync(temporaryTex, tex);
  try {
    const compileArgs = engine === 'tectonic' ? ['--keep-logs', '--outdir', temporaryDirectory, temporaryTex] : ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-output-directory', temporaryDirectory, temporaryTex];
    const compile = run(engine, compileArgs, { cwd: temporaryDirectory, timeoutMs });
    if (compile.error?.code === 'ETIMEDOUT') return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('resume_render_failed', 'LaTeX rendering timed out.', { timeoutMs })], texPath: path.relative(workspacePath, texPath) };
    if (compile.status !== 0) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('resume_render_failed', 'LaTeX rendering failed.', { engine, exitCode: compile.status, log: text(compile.stdout || compile.stderr).slice(-4000) })], texPath: path.relative(workspacePath, texPath) };
    const temporaryPdf = path.join(temporaryDirectory, 'resume-tailored.pdf');
    if (!fs.existsSync(temporaryPdf)) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('resume_render_failed', 'LaTeX engine completed without producing a PDF.')], texPath: path.relative(workspacePath, texPath) };
    const temporaryExtracted = path.join(temporaryDirectory, 'resume-tailored.txt');
    const extraction = run('pdftotext', ['-layout', temporaryPdf, temporaryExtracted], { timeoutMs: 10000 });
    if (extraction.status !== 0 || !fs.existsSync(temporaryExtracted)) return { ...baseManifest, toolVersions: { [engine]: engineVersion, pdftotext: pdftotextVersion }, blockers: [blocker('resume_render_text_invalid', 'PDF text extraction failed.')], texPath: path.relative(workspacePath, texPath) };
    const extracted = fs.readFileSync(temporaryExtracted, 'utf8');
    const textPreflight = preflightExtractedText(document, extracted, profile);
    const info = run('pdfinfo', [temporaryPdf], { timeoutMs: 10000 });
    const pageCount = Number(text(info.stdout).match(/^Pages:\s+(\d+)/m)?.[1] || 0);
    const reportedSize = text(info.stdout).match(/^Page size:\s+(.+)$/m)?.[1] || '';
    const blockers = [...textPreflight.blockers];
    const temporaryPages = path.join(temporaryDirectory, 'pages');
    fs.mkdirSync(temporaryPages, { recursive: true });
    const images = run('pdftoppm', ['-png', '-r', '120', temporaryPdf, path.join(temporaryPages, 'page')], { timeoutMs: 20000 });
    if (images.status !== 0) blockers.push(blocker('resume_render_failed', 'PDF page image generation failed.'));
    const imageNames = fs.existsSync(temporaryPages) ? fs.readdirSync(temporaryPages).filter(name => name.endsWith('.png')).sort() : [];
    blockers.push(...preflightPdfMetadata(profile, { pageCount, reportedSize, imageCount: imageNames.length }).blockers);
    const warnings = [{ code: 'resume_visual_review_required', message: 'Subjective typography and whitespace remain part of exact-revision human review.' }];
    const toolVersions = { [engine]: engineVersion, pdftotext: pdftotextVersion, pdfinfo: pdfinfoVersion, pdftoppm: pdftoppmVersion };
    if (blockers.length) return { ...baseManifest, blockers, warnings, toolVersions, pageCount, reportedPageSize: reportedSize, texPath: path.relative(workspacePath, texPath), textPreflight };
    const pdfPath = path.join(artifactsDirectory, 'resume-tailored.pdf');
    const extractedPath = path.join(artifactsDirectory, 'resume-tailored.txt');
    const pagesDirectory = path.join(artifactsDirectory, 'resume-tailored.pages');
    fs.copyFileSync(temporaryPdf, pdfPath);
    fs.copyFileSync(temporaryExtracted, extractedPath);
    fs.cpSync(temporaryPages, pagesDirectory, { recursive: true });
    const pageImages = imageNames.map(name => path.relative(workspacePath, path.join(pagesDirectory, name)));
    const pdf = fs.readFileSync(pdfPath);
    const extractedBuffer = fs.readFileSync(extractedPath);
    return { ...baseManifest, status: 'passed', blockers: [], warnings, toolVersions, pageCount, reportedPageSize: reportedSize, pdfHash: hashBuffer(pdf), extractedTextHash: hashBuffer(extractedBuffer), pdfPath: path.relative(workspacePath, pdfPath), texPath: path.relative(workspacePath, texPath), extractedTextPath: path.relative(workspacePath, extractedPath), pageImages, textPreflight };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
