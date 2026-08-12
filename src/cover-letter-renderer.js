import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, toolVersion, blocker, latexEscape, measureInkCoverage, preflightPdfMetadata, atsHostileGlyphs } from './resume-renderer.js';

const TEMPLATE_ID = 'cover-letter-classic';
const TEMPLATE_VERSION = 1;
const TEX_ENGINES = new Set(['tectonic', 'pdflatex']);

function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function text(value) { return value == null ? '' : String(value); }
function normalizedText(value) { return text(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9+.%$]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function safePageSize(value) { return String(value || '').toLowerCase() === 'a4' ? 'a4' : 'letter'; }
function boundedPageLimit(value) { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 2 ? number : 1; }

// A cover letter document is a typed subset: identity/contact plus the letter
// body paragraphs. The renderer only ever emits escaped text from these fields.
export function resolveCoverLetterProfile(options = {}) {
  return {
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    pageSize: safePageSize(options.pageSize),
    pageLimit: boundedPageLimit(options.pageLimit),
    // Letters are shorter than resumes; require at least a fifth of the page so
    // a one-line stub letter is caught without rejecting a normal compact
    // proof-grounded letter (~25% fill).
    minFill: 0.2,
  };
}

function paragraphBlocks(value) {
  return text(value).split(/\n\s*\n/).map(line => line.trim()).filter(Boolean);
}
// Preserve single line breaks inside a block (e.g. "Sincerely,\nAvery") as
// LaTeX line breaks instead of letting TeX collapse them to spaces.
function blockText(value) {
  return text(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => latexEscape(line)).join('\\\\\n');
}

// The body is a deterministic letter: centered identity header, salutation,
// opening paragraph, proof paragraphs, and closing/signature. Every text field
// passes through latexEscape (which also ATS-normalizes smart quotes/dashes).
export function renderCoverLetterLatex(document, profile, { templateText = null } = {}) {
  const template = templateText ?? fs.readFileSync(new URL('../templates/cover-letter-classic.tex', import.meta.url), 'utf8');
  const identity = document.identity || {};
  const contact = [identity.email, identity.phone, identity.location].filter(Boolean).map(latexEscape);
  const name = latexEscape(identity.name || document.candidateName || 'Candidate');
  const blocks = [
    `{\\LARGE\\bfseries ${name}}`,
    contact.join(' \\textbar{} '),
    '\\vspace{12pt}',
    latexEscape(document.salutation || 'Dear hiring team,'),
    '',
    blockText(document.opening),
    '',
    ...paragraphBlocks(document.paragraphs).map(paragraph => blockText(paragraph)),
    '',
    ...paragraphBlocks(document.closing).map(paragraph => blockText(paragraph)),
  ].filter(line => line !== '');
  const body = blocks.join('\n\n');
  return template
    .replace('%%PAGE_SIZE%%', profile.pageSize === 'a4' ? 'a4paper' : 'letterpaper')
    .replace('%%BODY%%', body);
}

export function preflightCoverLetterText(document, extractedText) {
  const normalized = normalizedText(extractedText);
  const expected = [
    document.identity?.name,
    document.identity?.email,
    document.identity?.phone,
    document.salutation,
    document.opening,
    ...paragraphBlocks(document.paragraphs),
    ...paragraphBlocks(document.closing),
  ].filter(Boolean);
  const missing = expected.filter(value => !normalized.includes(normalizedText(value)));
  const hostile = atsHostileGlyphs(extractedText);
  const blockers = [];
  if (missing.length) blockers.push(blocker('cover_letter_render_text_invalid', 'Rendered PDF is missing expected letter text.', { missing }));
  if (hostile.length) blockers.push(blocker('cover_letter_render_ats_glyph', 'Rendered PDF text contains ATS-hostile glyphs that break keyword extraction.', { glyphs: hostile.map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`) }));
  return { valid: blockers.length === 0, blockers, missing, atsHostileGlyphs: hostile };
}

export function renderCoverLetterPdf({ statePath, workspacePath, jobId, artifact, document, layoutProfile, timeoutMs = 30000, engine = process.env.JOBOS_TEX_ENGINE || 'tectonic' }) {
  const profile = resolveCoverLetterProfile(layoutProfile);
  const tex = renderCoverLetterLatex(document, profile);
  const artifactsDirectory = path.join(workspacePath, 'jobs', jobId, 'artifacts');
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const stalePath of ['cover-letter.pdf', 'cover-letter.txt', 'cover-letter.pages']) fs.rmSync(path.join(artifactsDirectory, stalePath), { recursive: true, force: true });
  const texPath = path.join(artifactsDirectory, 'cover-letter.tex');
  fs.writeFileSync(texPath, tex);
  const baseManifest = { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, pageSize: profile.pageSize, pageLimit: profile.pageLimit, sourceArtifactHash: artifact.contentHash || artifact.content_hash, texHash: hashBuffer(tex), status: 'blocked', warnings: [], blockers: [], toolVersions: {} };
  if (!TEX_ENGINES.has(engine)) return { ...baseManifest, blockers: [blocker('cover_letter_render_failed', `Unsupported LaTeX engine: ${engine}.`, { setupAction: 'Set JOBOS_TEX_ENGINE to tectonic or pdflatex.' })], texPath: path.relative(workspacePath, texPath) };
  const engineVersion = toolVersion(engine);
  if (!engineVersion) return { ...baseManifest, blockers: [blocker('cover_letter_render_failed', `LaTeX engine ${engine} is not installed.`, { setupAction: `Install ${engine}, then rerun tailor cover-letter --format pdf.` })], texPath: path.relative(workspacePath, texPath) };
  const pdftotextVersion = toolVersion('pdftotext');
  const pdfinfoVersion = toolVersion('pdfinfo');
  const pdftoppmVersion = toolVersion('pdftoppm');
  const missingTools = [['pdftotext', pdftotextVersion], ['pdfinfo', pdfinfoVersion], ['pdftoppm', pdftoppmVersion]].filter(([, version]) => !version).map(([name]) => name);
  if (missingTools.length) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('cover_letter_render_failed', `Required PDF validation tools are missing: ${missingTools.join(', ')}.`, { setupAction: 'Install Poppler utilities and rerun cover-letter PDF tailoring.' })], texPath: path.relative(workspacePath, texPath) };
  const temporaryDirectory = fs.mkdtempSync(path.join(statePath, 'cover-letter-render-'));
  const temporaryTex = path.join(temporaryDirectory, 'cover-letter.tex');
  fs.writeFileSync(temporaryTex, tex);
  try {
    const compileArgs = engine === 'tectonic' ? ['--keep-logs', '--outdir', temporaryDirectory, temporaryTex] : ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-output-directory', temporaryDirectory, temporaryTex];
    const compile = run(engine, compileArgs, { cwd: temporaryDirectory, timeoutMs });
    if (compile.error?.code === 'ETIMEDOUT') return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('cover_letter_render_failed', 'LaTeX rendering timed out.', { timeoutMs })], texPath: path.relative(workspacePath, texPath) };
    if (compile.status !== 0) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('cover_letter_render_failed', 'LaTeX rendering failed.', { engine, exitCode: compile.status, log: text(compile.stdout || compile.stderr).slice(-4000) })], texPath: path.relative(workspacePath, texPath) };
    const temporaryPdf = path.join(temporaryDirectory, 'cover-letter.pdf');
    if (!fs.existsSync(temporaryPdf)) return { ...baseManifest, toolVersions: { [engine]: engineVersion }, blockers: [blocker('cover_letter_render_failed', 'LaTeX engine completed without producing a PDF.')], texPath: path.relative(workspacePath, texPath) };
    const temporaryExtracted = path.join(temporaryDirectory, 'cover-letter.txt');
    const extraction = run('pdftotext', ['-layout', temporaryPdf, temporaryExtracted], { timeoutMs: 10000 });
    if (extraction.status !== 0 || !fs.existsSync(temporaryExtracted)) return { ...baseManifest, toolVersions: { [engine]: engineVersion, pdftotext: pdftotextVersion }, blockers: [blocker('cover_letter_render_text_invalid', 'PDF text extraction failed.')], texPath: path.relative(workspacePath, texPath) };
    const extracted = fs.readFileSync(temporaryExtracted, 'utf8');
    const textPreflight = preflightCoverLetterText(document, extracted);
    const info = run('pdfinfo', [temporaryPdf], { timeoutMs: 10000 });
    const pageCount = Number(text(info.stdout).match(/^Pages:\s+(\d+)/m)?.[1] || 0);
    const reportedSize = text(info.stdout).match(/^Page size:\s+(.+)$/m)?.[1] || '';
    const blockers = [...textPreflight.blockers];
    const temporaryPages = path.join(temporaryDirectory, 'pages');
    fs.mkdirSync(temporaryPages, { recursive: true });
    const images = run('pdftoppm', ['-r', '120', temporaryPdf, path.join(temporaryPages, 'page')], { timeoutMs: 20000 });
    if (images.status !== 0) blockers.push(blocker('cover_letter_render_failed', 'PDF page image generation failed.'));
    const imageNames = fs.existsSync(temporaryPages) ? fs.readdirSync(temporaryPages).filter(name => name.endsWith('.ppm')).sort() : [];
    const pageInkCoverage = imageNames.map(name => measureInkCoverage(fs.readFileSync(path.join(temporaryPages, name)))).filter(value => value != null);
    blockers.push(...preflightPdfMetadata(profile, { pageCount, reportedSize, imageCount: imageNames.length, pageInkCoverage }).blockers);
    const warnings = [{ code: 'cover_letter_visual_review_required', message: 'Subjective typography and whitespace remain part of exact-revision human review.' }];
    const toolVersions = { [engine]: engineVersion, pdftotext: pdftotextVersion, pdfinfo: pdfinfoVersion, pdftoppm: pdftoppmVersion };
    if (blockers.length) return { ...baseManifest, blockers, warnings, toolVersions, pageCount, reportedPageSize: reportedSize, pageInkCoverage, texPath: path.relative(workspacePath, texPath), textPreflight };
    const pdfPath = path.join(artifactsDirectory, 'cover-letter.pdf');
    const extractedPath = path.join(artifactsDirectory, 'cover-letter.txt');
    const pagesDirectory = path.join(artifactsDirectory, 'cover-letter.pages');
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
