import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';

import { preflightExtractedText, resolveLayoutProfile } from './resume-renderer.js';

function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function xml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]); }
function dateText(entry) {
  const start = entry.dateSource?.startText || entry.startDate || '';
  const end = entry.dateSource?.endText || entry.endDate || (entry.startDate ? 'Present' : '');
  return [start, end].filter(Boolean).join(' – ');
}
function summaryHeading(profile) {
  return profile.templateId === 'executive' || profile.roleFamily === 'leadership' ? 'Executive Summary' : 'Professional Summary';
}
function run(text, { bold = false, italic = false, color = null } = {}) {
  const properties = [bold ? '<w:b/>' : '', italic ? '<w:i/>' : '', color ? `<w:color w:val="${xml(color)}"/>` : ''].join('');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}
function paragraph(content, style = 'Body', { keepNext = false } = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${content}</w:p>`;
}
function hyperlink(label, url, relationships, accent) {
  const id = `rId${relationships.length + 1}`;
  relationships.push({ id, url });
  return `<w:hyperlink r:id="${id}">${run(label || url, { color: accent })}</w:hyperlink>`;
}
function section(title) { return paragraph(run(title), 'Heading1', { keepNext: true }); }
function bullet(value) { return paragraph(run(`• ${value}`), 'ListParagraph'); }
function renderBody(document, profile, relationships) {
  const identity = document.identity || {};
  const contactRuns = [identity.email, identity.phone, identity.location].filter(Boolean).map(value => run(value));
  for (const link of identity.links || []) {
    if (link.url) contactRuns.push(hyperlink(link.label || link.url, link.url, relationships, profile.accentColor.slice(1)));
  }
  const joinRuns = values => values.flatMap((value, index) => index ? [run(' | '), value] : [value]).join('');
  const rendered = {
    summary: document.summary?.text ? `${section(summaryHeading(profile))}${paragraph(run(document.summary.text))}` : '',
    skills: document.skills?.length ? `${section('Skills')}${paragraph(run(document.skills.map(skill => skill.name).join(' • ')))}` : '',
    experience: document.experience?.length ? `${section('Experience')}${document.experience.map(entry => {
      const heading = paragraph(`${run(entry.title, { bold: true })}${run(` — ${entry.employer}`)}${entry.location ? run(` | ${entry.location}`) : ''}${dateText(entry) ? run(` | ${dateText(entry)}`) : ''}`, 'Role', { keepNext: true });
      return `${heading}${(entry.bullets || []).map(item => bullet(item.text)).join('')}`;
    }).join('')}` : '',
    projects: document.projects?.length ? `${section('Projects')}${document.projects.map(entry => {
      const headingRuns = [run(entry.name, { bold: true })];
      if (entry.url) headingRuns.push(run(' — '), hyperlink('Project link', entry.url, relationships, profile.accentColor.slice(1)));
      return `${paragraph(headingRuns.join(''), 'Role', { keepNext: true })}${entry.description ? paragraph(run(entry.description)) : ''}${(entry.bullets || []).map(item => bullet(item.text)).join('')}`;
    }).join('')}` : '',
    education: document.education?.length ? `${section('Education')}${document.education.map(entry => paragraph(run([
      entry.degree || entry.field || 'Education', entry.institution, entry.field, entry.location, [entry.startDate, entry.endDate].filter(Boolean).join(' – ')
    ].filter(Boolean).join(' | ')), 'Role')).join('')}` : '',
    credentials: document.credentials?.length ? `${section('Credentials')}${document.credentials.map(entry => bullet(`${entry.name}${entry.issuer ? ` — ${entry.issuer}` : ''}${entry.date ? ` (${entry.date})` : ''}`)).join('')}` : '',
    additionalSections: (document.additionalSections || []).map(value => `${section(value.title)}${(value.entries || []).map(entry => bullet(typeof entry === 'string' ? entry : JSON.stringify(entry))).join('')}`).join('')
  };
  return `${paragraph(run(identity.name), 'Title', { keepNext: true })}${paragraph(joinRuns(contactRuns), 'Contact', { keepNext: true })}${profile.sectionOrder.map(name => rendered[name]).filter(Boolean).join('')}`;
}
function stylesXml(profile) {
  const accent = profile.accentColor.slice(1);
  const sans = ['modern', 'technical'].includes(profile.templateId);
  const font = sans ? 'Arial' : 'Cambria';
  const compact = profile.density === 'compact';
  const spacious = profile.density === 'spacious';
  const bodySize = profile.templateId === 'technical' ? 18 : 20;
  const after = compact ? 40 : spacious ? 100 : 70;
  const headingBefore = compact ? 100 : spacious ? 180 : 140;
  const titleSize = profile.templateId === 'executive' ? 42 : 38;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="${bodySize}"/><w:szCs w:val="${bodySize}"/><w:color w:val="111111"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="240" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Body"><w:name w:val="Body"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Body"/><w:pPr><w:keepNext/><w:spacing w:after="40"/>${['classic','executive'].includes(profile.templateId) ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:rPr><w:b/><w:sz w:val="${titleSize}"/><w:szCs w:val="${titleSize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Contact"><w:name w:val="Contact"/><w:basedOn w:val="Body"/><w:pPr><w:keepNext/><w:spacing w:after="80"/>${['classic','executive'].includes(profile.templateId) ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Body"/><w:next w:val="Body"/><w:pPr><w:keepNext/><w:spacing w:before="${headingBefore}" w:after="55"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="${accent}"/></w:pBdr></w:pPr><w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="${profile.templateId === 'executive' ? 25 : 23}"/><w:szCs w:val="${profile.templateId === 'executive' ? 25 : 23}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Role"><w:name w:val="Role"/><w:basedOn w:val="Body"/><w:pPr><w:keepNext/><w:spacing w:after="35"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Body"/><w:pPr><w:ind w:left="300" w:hanging="180"/><w:spacing w:after="${compact ? 25 : spacious ? 75 : 45}"/></w:pPr></w:style>
</w:styles>`;
}
function documentXml(document, profile, relationships) {
  const body = renderBody(document, profile, relationships);
  const pageSize = profile.pageSize === 'a4' ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 };
  const margin = profile.density === 'compact' ? 835 : profile.density === 'spacious' ? 1123 : 979;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="${pageSize.width}" w:h="${pageSize.height}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:num="1" w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;
}
function contentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
}
function rootRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
}
function documentRelationships(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.map(value => `<Relationship Id="${value.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(value.url)}" TargetMode="External"/>`).join('')}</Relationships>`;
}
function coreProperties(artifact) {
  const identifier = `${artifact.id || 'unbound'}:${artifact.contentHash || artifact.content_hash || ''}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Tailored resume</dc:title><dc:creator>JobOS</dc:creator><dc:identifier>${xml(identifier)}</dc:identifier></cp:coreProperties>`;
}

export async function renderResumeDocx({ workspacePath, jobId, artifact, document, layoutProfile }) {
  const profile = resolveLayoutProfile(null, layoutProfile);
  const relationships = [];
  const documentContent = documentXml(document, profile, relationships);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes());
  zip.file('_rels/.rels', rootRelationships());
  zip.file('word/document.xml', documentContent);
  zip.file('word/styles.xml', stylesXml(profile));
  zip.file('word/_rels/document.xml.rels', documentRelationships(relationships));
  zip.file('docProps/core.xml', coreProperties(artifact));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const extraction = await mammoth.extractRawText({ buffer: bytes });
  const extractedText = String(extraction.value || '');
  const textPreflight = preflightExtractedText(document, extractedText, profile);
  const structureBlockers = [];
  if (!documentContent.includes('<w:cols w:num="1"')) structureBlockers.push({ code: 'resume_docx_layout_invalid', message: 'DOCX does not declare a single-column section.' });
  if (documentContent.includes('<w:br w:type="page"')) structureBlockers.push({ code: 'resume_docx_layout_invalid', message: 'DOCX contains a forced page break instead of accessible flowing pagination.' });
  const blockers = [...textPreflight.blockers, ...structureBlockers];
  const warnings = [
    ...(profile.accent.warning ? [profile.accent.warning] : []),
    { code: 'resume_visual_review_required', message: 'Word-compatible pagination can vary by installed fonts and editor; review the exact DOCX revision before approval.' }
  ];
  const artifactToken = String(artifact.id || artifact.contentHash || artifact.content_hash || 'unbound').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
  const artifactsDirectory = path.join(workspacePath, 'jobs', jobId, 'artifacts');
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  const docxPath = path.join(artifactsDirectory, `resume-${artifactToken}.docx`);
  if (!blockers.length) fs.writeFileSync(docxPath, bytes);
  return {
    templateId: profile.templateId,
    templateVersion: profile.templateVersion,
    accent: profile.accent,
    pageSize: profile.pageSize,
    pageLimit: profile.pageLimit,
    pagination: { mode: 'flowing', columns: 1, forcedPageBreaks: 0 },
    sourceArtifactId: artifact.id || null,
    sourceArtifactHash: artifact.contentHash || artifact.content_hash,
    status: blockers.length ? 'blocked' : 'passed',
    blockers,
    warnings,
    docxPath: blockers.length ? null : path.relative(workspacePath, docxPath),
    docxHash: blockers.length ? null : hashBuffer(bytes),
    extractedTextHash: hashBuffer(extractedText),
    textPreflight,
    toolVersions: { docx: 'OOXML', mammoth: 'runtime' }
  };
}
