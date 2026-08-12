import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderResumePdf, resolveLayoutProfile } from '../src/resume-renderer.js';

const root = mkdtempSync(path.join(tmpdir(), 'jobos-render-e2e-'));
const statePath = path.join(root, '.jobos');
const workspacePath = path.join(root, 'jobos-workspace');
mkdirSync(statePath, { recursive: true });
mkdirSync(workspacePath, { recursive: true });
const document = JSON.parse(readFileSync(new URL('../samples/resume-full-realistic.json', import.meta.url), 'utf8'));

const profile = resolveLayoutProfile({ title: 'Senior Product Manager', description: '' }, { layout: 'professional', pageSize: 'letter', pageLimit: 2 });
const manifest = renderResumePdf({ statePath, workspacePath, jobId: 'job_e2e', artifact: { contentHash: 'abc' }, document, layoutProfile: profile, engine: 'tectonic' });

console.log('status:', manifest.status);
console.log('pageCount:', manifest.pageCount);
console.log('pageInkCoverage:', manifest.pageInkCoverage?.map(v => v == null ? null : Math.round(v * 100) + '%'));
console.log('blockers:', JSON.stringify(manifest.blockers, null, 2));
console.log('warnings:', JSON.stringify(manifest.warnings));
console.log('pdfPath:', manifest.pdfPath);
console.log('pdf exists:', existsSync(path.join(workspacePath, manifest.pdfPath)));
console.log('textPreflight valid:', manifest.textPreflight?.valid);
console.log('atsHostileGlyphs:', JSON.stringify(manifest.textPreflight?.atsHostileGlyphs));
