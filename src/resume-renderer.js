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

// ATS-hostile glyphs: PDF text extractors (what ATS systems read) decode
// ligature glyphs back to U+FB01/FB02/FB03 and garble smart quotes, dashes,
// zero-width characters, and non-breaking spaces — so a literal keyword search
// misses them. Normalize to ASCII before TeX escaping so the rendered PDF
// extracts cleanly. Mirrors career-ops' normalizeTextForATS.
const ATS_GLYPH_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2013': '-', '\u2014': '-',
  '\u00A0': ' ',
  '\u2026': '...',
  '\u2022': '|', '\u00B7': '|',
  '\u2190': ' from ', '\u2191': ' ', '\u2192': ' to ', '\u2193': ' ',
  '\u200B': '', '\u200C': '', '\u200D': '', '\u2060': '', '\uFEFF': '',
};
const ATS_GLYPH_RE = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2013\u2014\u00A0\u2026\u2022\u00B7\u2190\u2191\u2192\u2193\u200B\u200C\u200D\u2060\uFEFF]/g;
function atsNormalize(value) {
  return text(value).replace(ATS_GLYPH_RE, character => ATS_GLYPH_MAP[character] ?? '');
}
// Ligature codepoints (U+FB00–FB06) are not in the map above because they are
// produced by the font at layout time, not present in source text — but if any
// survive into extracted text they are a hard ATS blocker. Zero-width characters
// and non-breaking spaces also corrupt keyword extraction. Smart quotes and
// dashes are already normalized to ASCII by latexEscape before rendering, so
// they should never appear in extracted text; bullets (•) and middots (·) are
// legitimate separators and are NOT flagged.
const ATS_HOSTILE_EXTRACT_RE = /[\uFB00-\uFB06\u00A0\u200B\u200C\u200D\u2060\uFEFF]/;
export function atsHostileGlyphs(value) {
  return [...new Set(text(value).match(ATS_HOSTILE_EXTRACT_RE) || [])];
}

export function latexEscape(value) {
  const bs = '\\';
  const replacements = { [bs]: bs + 'textbackslash{}', '{': bs + '{', '}': bs + '}', '$': bs + '$', '&': bs + '&', '#': bs + '#', '%': bs + '%', '_': bs + '_', '~': bs + 'textasciitilde{}', '^': bs + 'textasciicircum{}' };
  return atsNormalize(value).replace(/[\\{}$&#%_~^]/g, character => replacements[character]);
}
export function latexUrlEscape(value) {
  return atsNormalize(value).replace(/\\/g, '/').replace(/([%#{}])/g, '\\$1');
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

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 30000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024, cwd: options.cwd, env: { ...process.env, ...(options.env || {}) }, shell: false });
}
export function toolVersion(command) {
  const result = run(command, ['--version'], { timeoutMs: 5000, maxBuffer: 128 * 1024 });
  return result.error?.code === 'ENOENT' ? null : text(result.stdout || result.stderr).split(/\r?\n/)[0].trim() || command;
}
export function blocker(code, message, details = {}) { return { code, message, ...details }; }
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
  const hostile = atsHostileGlyphs(extractedText);
  if (hostile.length) blockers.push(blocker('resume_render_ats_glyph', 'Rendered PDF text contains ATS-hostile glyphs (ligatures, smart quotes, dashes, or zero-width characters) that break keyword extraction.', { glyphs: hostile.map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`) }));
  return { valid: blockers.length === 0, blockers, missing, orderValid, atsHostileGlyphs: hostile };
}

// Parse a PPM (P6 binary) buffer and return the vertical fill fraction: the
// fraction of the page height that contains any ink. This is the right measure
// of "is the resume too short" — a full page of 10pt text is only ~5% dark
// pixels but extends ~80% down the page. Returns null on unparseable input.
export function measureInkCoverage(ppmBuffer) {
  const headerEnd = ppmBuffer.indexOf(Buffer.from('\n255\n'));
  if (headerEnd === -1) return null;
  // The PPM header ends with "\n255\n" (5 bytes); pixel data begins after it.
  const dataStart = headerEnd + 5;
  const header = ppmBuffer.subarray(0, dataStart).toString('latin1');
  const match = header.match(/^P6\s+(\d+)\s+(\d+)\s+255\s*$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixelCount = width * height;
  const data = ppmBuffer.subarray(dataStart, dataStart + pixelCount * 3);
  if (data.length < pixelCount * 3) return null;
  let minInkRow = -1;
  let maxInkRow = -1;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + x * 3;
      // A pixel counts as "ink" when any channel is meaningfully below white.
      if (data[offset] < 245 || data[offset + 1] < 245 || data[offset + 2] < 245) {
        if (minInkRow === -1) minInkRow = y;
        maxInkRow = y;
        break;
      }
    }
  }
  if (minInkRow === -1) return 0;
  // Vertical fill = (last ink row - first ink row + 1) / page height, so a
  // page with ink from the very top to the very bottom reports ~1.
  return (maxInkRow - minInkRow + 1) / height;
}

// Default minimum fill: a single-page resume must use at least 4/5 of the page
// so it does not look too short. Multi-page resumes only require the final page
// to be reasonably filled (not a near-empty orphan page). Cover letters are
// shorter documents and set a lower minFill in their layout profile.
const DEFAULT_MIN_FILL = 0.8;
const DEFAULT_MIN_FINAL_PAGE_FILL = 0.1;

export function preflightPdfMetadata(profile, { pageCount, reportedSize, imageCount, pageInkCoverage = [] }) {
  const blockers = [];
  const minFill = typeof profile.minFill === 'number' ? profile.minFill : DEFAULT_MIN_FILL;
  const minFinalPageFill = typeof profile.minFinalPageFill === 'number' ? profile.minFinalPageFill : DEFAULT_MIN_FINAL_PAGE_FILL;
  if (!pageCount) blockers.push(blocker('resume_render_failed', 'PDF page count could not be determined.'));
  if (pageCount > profile.pageLimit) blockers.push(blocker('resume_page_budget_exceeded', `PDF has ${pageCount} pages; limit is ${profile.pageLimit}.`, { pageCount, pageLimit: profile.pageLimit }));
  const expectsA4 = profile.pageSize === 'a4';
  if ((expectsA4 && !/595(?:\.\d+)? x 842/i.test(reportedSize)) || (!expectsA4 && !/612(?:\.\d+)? x 792/i.test(reportedSize))) blockers.push(blocker('resume_render_failed', `PDF page geometry does not match ${profile.pageSize}.`, { reportedSize }));
  if (imageCount !== pageCount) blockers.push(blocker('resume_render_failed', 'Rendered page-image count differs from PDF page count.', { pageCount, imageCount }));
  if (pageCount && pageInkCoverage.length === pageCount) {
    if (pageCount === 1) {
      const fill = pageInkCoverage[0];
      if (fill < minFill) blockers.push(blocker('resume_page_underfilled', `Resume fills only ${Math.round(fill * 100)}% of the page; at least ${Math.round(minFill * 100)}% is required so it does not look too short.`, { fill, minFill }));
    } else {
      const finalFill = pageInkCoverage[pageCount - 1];
      if (finalFill < minFinalPageFill) blockers.push(blocker('resume_page_nearly_empty', `Final page is nearly empty (${Math.round(finalFill * 100)}% filled); trim content or tighten layout so it does not end with an orphan page.`, { fill: finalFill, minFill: minFinalPageFill }));
    }
  }
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
    const images = run('pdftoppm', ['-r', '120', temporaryPdf, path.join(temporaryPages, 'page')], { timeoutMs: 20000 });
    if (images.status !== 0) blockers.push(blocker('resume_render_failed', 'PDF page image generation failed.'));
    const imageNames = fs.existsSync(temporaryPages) ? fs.readdirSync(temporaryPages).filter(name => name.endsWith('.ppm')).sort() : [];
    const pageInkCoverage = imageNames.map(name => measureInkCoverage(fs.readFileSync(path.join(temporaryPages, name)))).filter(value => value != null);
    blockers.push(...preflightPdfMetadata(profile, { pageCount, reportedSize, imageCount: imageNames.length, pageInkCoverage }).blockers);
    const warnings = [{ code: 'resume_visual_review_required', message: 'Subjective typography and whitespace remain part of exact-revision human review.' }];
    const toolVersions = { [engine]: engineVersion, pdftotext: pdftotextVersion, pdfinfo: pdfinfoVersion, pdftoppm: pdftoppmVersion };
    if (blockers.length) return { ...baseManifest, blockers, warnings, toolVersions, pageCount, reportedPageSize: reportedSize, pageInkCoverage, texPath: path.relative(workspacePath, texPath), textPreflight };
    const pdfPath = path.join(artifactsDirectory, 'resume-tailored.pdf');
    const extractedPath = path.join(artifactsDirectory, 'resume-tailored.txt');
    const pagesDirectory = path.join(artifactsDirectory, 'resume-tailored.pages');
    fs.copyFileSync(temporaryPdf, pdfPath);
    fs.copyFileSync(temporaryExtracted, extractedPath);
    fs.cpSync(temporaryPages, pagesDirectory, { recursive: true });
    const pageImages = imageNames.map(name => path.relative(workspacePath, path.join(pagesDirectory, name)));
    const pdf = fs.readFileSync(pdfPath);
    const extractedBuffer = fs.readFileSync(extractedPath);
    return { ...baseManifest, status: 'passed', blockers: [], warnings, toolVersions, pageCount, reportedPageSize: reportedSize, pageInkCoverage, pdfHash: hashBuffer(pdf), extractedTextHash: hashBuffer(extractedBuffer), pdfPath: path.relative(workspacePath, pdfPath), texPath: path.relative(workspacePath, texPath), extractedTextPath: path.relative(workspacePath, extractedPath), pageImages, textPreflight };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
