import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importResume, normalizeResumeSourceText, parseResumeText, readResumeFileAsync } from '../src/resumes.js';

const RESUME_LINES = [
  'Alex Chen',
  'alex@example.com',
  '+1 555 0100',
  'Berlin, Germany',
  'EXPERIENCE',
  'Senior Engineer | Acme Corp | Remote',
  '- Built a distributed scheduler that handles one million events daily'
];

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-resume-file-'));
}

function pdfBuffer(lines) {
  const escapePdf = value => String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const operations = ['BT', '/F1 12 Tf', '72 720 Td'];
  lines.forEach((line, index) => {
    if (index) operations.push('0 -18 Td');
    operations.push(`(${escapePdf(line)}) Tj`);
  });
  operations.push('ET');
  const stream = `${operations.join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'binary');
}

async function docxBuffer(lines) {
  const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      ${lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('')}
      <w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('resume normalization reconnects common copy/paste email artifacts', () => {
  const source = RESUME_LINES.join('\n').replace('alex@example.com', 'alex\u200B @\n example . com');
  const normalized = normalizeResumeSourceText(source);
  const document = parseResumeText('alex', normalized);
  assert.equal(document.identity.email, 'alex@example.com');
});

test('PDF and DOCX files are extracted locally into the canonical resume shape', async () => {
  const root = workspace();
  const pdfPath = path.join(root, 'resume.pdf');
  const docxPath = path.join(root, 'resume.docx');
  writeFileSync(pdfPath, pdfBuffer(RESUME_LINES));
  writeFileSync(docxPath, await docxBuffer(RESUME_LINES));

  const pdf = await readResumeFileAsync('alex', pdfPath);
  const docx = await readResumeFileAsync('alex', docxPath);

  for (const [format, input] of [['pdf', pdf], ['docx', docx]]) {
    assert.equal(input.sourceFormat, format);
    assert.equal(input.document.identity.name, 'Alex Chen');
    assert.equal(input.document.identity.email, 'alex@example.com');
    assert.equal(input.document.identity.phone, '+1 555 0100');
    assert.equal(input.document.experience[0].employer, 'Acme Corp');
  }
});

test('binary resume import archives the original and writes structured and Markdown projections', async () => {
  const root = workspace();
  const pdfPath = path.join(root, 'resume.pdf');
  writeFileSync(pdfPath, pdfBuffer(RESUME_LINES));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;

  const revision = await importResume(store, { profileId: profile.id, filePath: pdfPath });
  const resumeDirectory = path.join(root, 'jobos-workspace', 'profiles', profile.id, 'resume');

  assert.equal(revision.source_format, 'pdf');
  assert.ok(revision.source_archive_path.startsWith('.jobos/'));
  assert.equal(existsSync(path.join(root, revision.source_archive_path)), true);
  assert.match(readFileSync(path.join(resumeDirectory, 'current.md'), 'utf8'), /# Alex Chen/);
  assert.match(readFileSync(path.join(resumeDirectory, 'current-source.md'), 'utf8'), /alex@example\.com/);
  assert.match(readFileSync(path.join(resumeDirectory, 'current.yaml'), 'utf8'), /format: pdf/);
});

test('image-only PDFs fail honestly with OCR guidance', async () => {
  const root = workspace();
  const pdfPath = path.join(root, 'scan.pdf');
  writeFileSync(pdfPath, pdfBuffer([]));
  await assert.rejects(
    readResumeFileAsync('alex', pdfPath),
    error => error.code === 'resume_text_extraction_empty' && /OCR/i.test(error.message)
  );
});
