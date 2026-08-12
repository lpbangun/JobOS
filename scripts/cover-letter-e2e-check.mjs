import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCoverLetterPdf } from '../src/cover-letter-renderer.js';

const root = mkdtempSync(path.join(tmpdir(), 'jobos-cover-e2e-'));
const statePath = path.join(root, '.jobos');
const workspacePath = path.join(root, 'jobos-workspace');
mkdirSync(statePath, { recursive: true });
mkdirSync(workspacePath, { recursive: true });

const document = {
  identity: {
    name: 'Avery Candidate',
    email: 'avery@example.com',
    phone: '+1 555 555 0100',
    location: 'Chicago, IL',
    links: [{ id: 'l1', label: 'LinkedIn', url: 'https://www.linkedin.com/in/avery' }],
  },
  candidateName: 'Avery Candidate',
  salutation: 'Dear hiring team,',
  opening: 'I am applying for Senior Product Manager at Acme Learning. The role stated responsibilities are the focus of this application.',
  paragraphs: 'One relevant example from my verified records: Led educator research and shipped a workflow that reduced review time by 30%.\n\nA second relevant example from my verified records: Drove activation improvements of 22% through onboarding redesign and user feedback loops.',
  closing: 'Thank you for your consideration. I would welcome the opportunity to discuss how this verified experience could support Acme Learning in the Senior Product Manager role.\n\nSincerely,\nAvery Candidate',
};

const manifest = renderCoverLetterPdf({
  statePath,
  workspacePath,
  jobId: 'job_cover_e2e',
  artifact: { contentHash: 'abc' },
  document,
  layoutProfile: { pageSize: 'letter', pageLimit: 1 },
  engine: 'tectonic',
});

console.log('status:', manifest.status);
console.log('pageCount:', manifest.pageCount);
console.log('pageInkCoverage:', manifest.pageInkCoverage?.map(v => v == null ? null : Math.round(v * 100) + '%'));
console.log('blockers:', JSON.stringify(manifest.blockers, null, 2));
console.log('warnings:', JSON.stringify(manifest.warnings));
console.log('pdfPath:', manifest.pdfPath);
console.log('pdf exists:', existsSync(path.join(workspacePath, manifest.pdfPath)));
console.log('textPreflight valid:', manifest.textPreflight?.valid);
console.log('atsHostileGlyphs:', JSON.stringify(manifest.textPreflight?.atsHostileGlyphs));
