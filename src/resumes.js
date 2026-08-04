import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { load } from 'cheerio';
import mammoth from 'mammoth';
import { all, audit, one, run, save } from './db.js';
import { id, now, parseJson } from './utils.js';
import { writeMd, writeYaml } from './workspace.js';

export const RESUME_SCHEMA_VERSION = 1;
export const RESUME_VERIFICATION_STATUSES = new Set(['verified', 'needs_verification', 'rejected']);

function text(value) { return value == null ? '' : String(value).trim(); }
function list(value) { return Array.isArray(value) ? value : []; }
function stableId(prefix, profileId, value, index) { return id(prefix, `${profileId}:${text(value) || index}`); }
function verification(value, fallback = 'needs_verification') {
  return RESUME_VERIFICATION_STATUSES.has(value) ? value : fallback;
}
function sourceHash(sourceText) {
  return crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
}

function normalizeBullet(profileId, bullet, experienceId, index) {
  const value = typeof bullet === 'string' ? { text: bullet } : (bullet || {});
  return {
    id: text(value.id) || stableId('bullet', profileId, `${experienceId}:${text(value.text)}`, index),
    text: text(value.text),
    proofPointIds: [...new Set(list(value.proofPointIds).map(text).filter(Boolean))],
    verificationStatus: verification(value.verificationStatus, 'needs_verification')
  };
}

function normalizeExperience(profileId, entry, index) {
  const value = entry || {};
  const experienceId = text(value.id) || stableId('experience', profileId, `${text(value.employer)}:${text(value.title)}:${text(value.startDate)}`, index);
  return {
    id: experienceId,
    employer: text(value.employer),
    title: text(value.title),
    location: text(value.location),
    startDate: value.startDate == null ? null : text(value.startDate),
    endDate: value.endDate == null || text(value.endDate).toLowerCase() === 'present' ? null : text(value.endDate),
    dateSource: {
      startText: text(value.dateSource?.startText ?? value.startDate),
      endText: text(value.dateSource?.endText ?? value.endDate),
      verificationStatus: verification(value.dateSource?.verificationStatus, 'needs_verification')
    },
    verificationStatus: verification(value.verificationStatus, 'needs_verification'),
    bullets: list(value.bullets).map((bullet, bulletIndex) => normalizeBullet(profileId, bullet, experienceId, bulletIndex))
  };
}

function normalizeNamedEntry(profileId, prefix, entry, index, fields) {
  const value = typeof entry === 'string' ? { name: entry } : (entry || {});
  const output = { id: text(value.id) || stableId(prefix, profileId, fields.map(field => text(value[field])).join(':'), index) };
  for (const field of fields) output[field] = text(value[field]);
  output.verificationStatus = verification(value.verificationStatus, 'needs_verification');
  return output;
}

function resumeInputShape(input) {
  const basics = input.basics || {};
  const locationText = value => {
    if (!value || typeof value !== 'object') return value;
    return [value.address, value.city, value.region, value.countryCode || value.country]
      .map(text).filter(Boolean).join(', ');
  };
  const identitySource = input.identity || {
    name: input.name ?? basics.name,
    email: input.email ?? basics.email,
    phone: input.phone ?? basics.phone,
    location: locationText(input.location ?? basics.location),
    links: input.links ?? basics.profiles?.map(profile => ({
      label: profile.network || profile.username || 'Link',
      url: profile.url
    }))
  };
  const identity = { ...identitySource, location: locationText(identitySource.location) };
  const experience = input.experience ?? input.experiences ?? input.workExperience ?? input.work ?? [];
  return {
    ...input,
    identity,
    summary: input.summary ?? basics.summary ?? '',
    experience: list(experience).map(entry => ({
      ...entry,
      employer: entry?.employer ?? entry?.company ?? entry?.organization ?? entry?.name,
      title: entry?.title ?? entry?.position ?? entry?.role,
      location: locationText(entry?.location),
      startDate: entry?.startDate ?? entry?.start,
      endDate: entry?.endDate ?? entry?.end,
      bullets: entry?.bullets ?? entry?.highlights ?? entry?.achievements ?? entry?.responsibilities ?? []
    })),
    education: input.education ?? input.educations ?? [],
    skills: input.skills ?? input.competencies ?? [],
    credentials: input.credentials ?? input.certificates ?? input.certifications ?? [],
    projects: input.projects ?? input.portfolio ?? []
  };
}

export function normalizeResumeDocument(profileId, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Resume document must be an object');
  input = resumeInputShape(input);
  const identity = input.identity || {};
  const summary = typeof input.summary === 'string' ? { text: input.summary } : (input.summary || {});
  return {
    schemaVersion: RESUME_SCHEMA_VERSION,
    identity: {
      name: text(identity.name),
      email: text(identity.email),
      phone: text(identity.phone),
      location: text(identity.location),
      links: list(identity.links).map((link, index) => ({
        id: text(link?.id) || stableId('link', profileId, `${text(link?.label)}:${text(link?.url)}`, index),
        label: text(link?.label),
        url: text(link?.url),
        verificationStatus: verification(link?.verificationStatus, 'needs_verification')
      })),
      verificationStatus: verification(identity.verificationStatus, 'needs_verification')
    },
    summary: {
      id: text(summary.id) || stableId('summary', profileId, summary.text, 0),
      text: text(summary.text),
      proofPointIds: [...new Set(list(summary.proofPointIds).map(text).filter(Boolean))],
      verificationStatus: verification(summary.verificationStatus, 'needs_verification')
    },
    experience: list(input.experience).map((entry, index) => normalizeExperience(profileId, entry, index)),
    education: list(input.education).map((entry, index) => normalizeNamedEntry(profileId, 'education', {
      ...entry,
      institution: entry?.institution ?? entry?.school,
      degree: entry?.degree ?? entry?.studyType,
      field: entry?.field ?? entry?.area
    }, index, ['institution', 'degree', 'field', 'location', 'startDate', 'endDate'])),
    skills: list(input.skills).flatMap(entry => {
      if (typeof entry === 'string') return [entry];
      if (entry?.name) return [{ ...entry, category: entry.category ?? list(entry.keywords).join(', ') }];
      return list(entry?.keywords).map(name => ({ name, category: entry?.category || '' }));
    }).map((entry, index) => normalizeNamedEntry(profileId, 'skill', entry, index, ['name', 'category'])),
    credentials: list(input.credentials).map((entry, index) => normalizeNamedEntry(profileId, 'credential', {
      ...entry,
      issuer: entry?.issuer ?? entry?.organization,
      date: entry?.date ?? entry?.startDate
    }, index, ['name', 'issuer', 'date'])),
    projects: list(input.projects).map((entry, index) => {
      const normalized = normalizeNamedEntry(profileId, 'project', entry, index, ['name', 'description', 'url']);
      normalized.bullets = list(entry?.bullets).map((bullet, bulletIndex) => normalizeBullet(profileId, bullet, normalized.id, bulletIndex));
      return normalized;
    }),
    additionalSections: list(input.additionalSections).map((section, index) => ({
      id: text(section?.id) || stableId('section', profileId, section?.title, index),
      title: text(section?.title) || `Additional section ${index + 1}`,
      entries: list(section?.entries).map(value => typeof value === 'string' ? value : structuredClone(value)),
      verificationStatus: verification(section?.verificationStatus, 'needs_verification')
    }))
  };
}

function headingName(line) {
  const markdown = String(line).match(/^#{1,3}\s+(.+)$/);
  if (markdown) return markdown[1].trim();
  const plain = String(line).trim();
  if (/^(?:professional summary|summary|profile|objective|work experience|professional experience|career experience|experience|employment|employment history|work history|career history|professional background|education|academic background|education and training|technical skills|professional skills|skills|core competencies|expertise|technical stack|tools and technologies|credentials|certifications|licenses|certificates|qualifications|selected projects|personal projects|professional projects|projects|portfolio|selected work|awards?|honors?|publications?|languages?|volunteer(?:ing| experience)?|community|leadership|interests?|activities|associations?|memberships?|references?)\s*:?$/i.test(plain)) return plain.replace(/\s*:$/, '');
  if (/^[A-Z][A-Z &/]{2,40}$/.test(plain)) return plain;
  return '';
}
function canonicalSection(value) {
  const key = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/^(professional )?summary|profile|objective$/.test(key)) return 'summary';
  if (/^(work |professional |career )?experience|employment( history)?|work history|career history|professional background$/.test(key)) return 'experience';
  if (/^education|academic background|education and training$/.test(key)) return 'education';
  if (/^(technical |professional )?skills|core competencies|expertise|technical stack|tools and technologies$/.test(key)) return 'skills';
  if (/^credentials|certifications|licenses|certificates|qualifications$/.test(key)) return 'credentials';
  if (/^(selected |personal |professional )?projects|portfolio|selected work$/.test(key)) return 'projects';
  return '';
}
function cleanBullet(line) { return String(line).replace(/^\s*[-*•]\s*/, '').trim(); }
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i;
const MONTH_PATTERN = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_PART_PATTERN = `(?:${MONTH_PATTERN}\\s+(?:19|20)\\d{2}|(?:0?[1-9]|1[0-2])[/.](?:19|20)\\d{2}|(?:19|20)\\d{2}(?:[-/.](?:0?[1-9]|1[0-2]))?)`;
const ROLE_PATTERN = /\b(?:engineer|developer|manager|director|designer|analyst|consultant|specialist|coordinator|administrator|architect|scientist|researcher|recruiter|producer|strategist|executive|officer|president|founder|owner|partner|associate|assistant|intern|lead|head|principal|product|marketing|sales|operations|teacher|educator|writer|editor)\b/i;
const EMPLOYER_PATTERN = /\b(?:inc\.?|llc|ltd\.?|corp(?:oration)?\.?|company|co\.?|gmbh|ag|plc|group|studio|studios|labs?|systems?|solutions?|technologies|university|college|school|institute|foundation|agency|partners?)\b/i;

function isAdditionalSection(value) {
  const key = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return /^(awards?|honors?|publications?|languages?|volunteer(?:ing| experience)?|community|leadership|interests?|activities|associations?|memberships?|references?)$/.test(key);
}

function sectionHeading(line, { insideSection = false } = {}) {
  const heading = headingName(line);
  if (!heading) return '';
  if (canonicalSection(heading) || isAdditionalSection(heading)) return heading;
  const level = String(line).match(/^(#{1,3})\s+/)?.[1].length || 0;
  return !insideSection && level > 0 && level <= 2 ? heading : '';
}

export function normalizeResumeSourceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+)\s*(?:\n\s*)?@\s*(?:\n\s*)?([A-Z0-9-]+(?:\s*\.\s*[A-Z0-9-]+)+)/gi,
      (_match, local, domain) => `${local}@${domain.replace(/\s+/g, '')}`)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function parseDateRange(value) {
  const source = text(value);
  const range = new RegExp(`(${DATE_PART_PATTERN})\\s*(?:-|–|—|to|through)\\s*(Present|Current|Now|${DATE_PART_PATTERN})`, 'i');
  const match = source.match(range);
  if (match) return { matched: true, startDate: match[1], endDate: /present|current|now/i.test(match[2]) ? null : match[2], dateSource: { startText: match[1], endText: match[2], verificationStatus: /^\d{4}(?:-\d{1,2})?$/.test(match[1]) && (/present|current|now/i.test(match[2]) || /^\d{4}(?:-\d{1,2})?$/.test(match[2])) ? 'verified' : 'needs_verification' } };
  const single = source.match(new RegExp(`\\b(${DATE_PART_PATTERN})\\b`, 'i'));
  if (single) return { matched: true, startDate: single[1], endDate: null, dateSource: { startText: single[1], endText: '', verificationStatus: 'needs_verification' } };
  return { matched: false, startDate: null, endDate: null, dateSource: { startText: '', endText: '', verificationStatus: 'needs_verification' } };
}

function isDateLine(value) {
  const dates = parseDateRange(value);
  if (!dates.matched) return false;
  const remainder = text(value)
    .replace(new RegExp(DATE_PART_PATTERN, 'ig'), '')
    .replace(/present|current|now|through|to/ig, '')
    .replace(/[-–—|,()[\].]/g, '')
    .trim();
  return !remainder || /^(remote|hybrid|on[ -]?site)$/i.test(remainder);
}

function isLocation(value) {
  const source = text(value);
  return /^(?:remote|hybrid|on[ -]?site)$/i.test(source)
    || /^[\p{L} .'-]+,\s*(?:[A-Z]{2}|[\p{L} .'-]+)$/u.test(source);
}

function roleScore(value) {
  const source = text(value);
  return (ROLE_PATTERN.test(source) ? 4 : 0) + (/\b(?:senior|sr\.?|junior|jr\.?|chief|vp|vice president)\b/i.test(source) ? 2 : 0) - (EMPLOYER_PATTERN.test(source) ? 2 : 0);
}

function employerScore(value) {
  const source = text(value);
  return (EMPLOYER_PATTERN.test(source) ? 4 : 0) + (/^[A-Z][\p{L}\d&.' -]+$/u.test(source) ? 1 : 0) - (ROLE_PATTERN.test(source) ? 2 : 0);
}

function inferTitleEmployer(values) {
  const candidates = values.map(text).filter(value => value && !isDateLine(value) && !isLocation(value));
  if (candidates.length < 2) return null;
  const [first, second] = candidates;
  const firstTitle = roleScore(first);
  const secondTitle = roleScore(second);
  const firstEmployer = employerScore(first);
  const secondEmployer = employerScore(second);
  if (secondTitle > firstTitle || firstEmployer > secondEmployer + 1) return { title: second, employer: first };
  return { title: first, employer: second };
}

function experienceHeader(value) {
  const source = cleanBullet(value);
  const dates = parseDateRange(source);
  let parts = source.split(/\s*(?:\||\t|—|–)\s*/).map(text).filter(Boolean);
  parts = parts.filter(part => !isDateLine(part));
  let inferred = inferTitleEmployer(parts);
  if (!inferred) {
    const at = source.match(/^(.+?)\s+at\s+(.+?)(?=\s+(?:\||—|–)\s*|$)/i);
    if (at) inferred = { title: text(at[1]), employer: text(at[2]) };
  }
  if (!inferred) {
    const withoutDates = dates.matched ? source.replace(new RegExp(`${DATE_PART_PATTERN}\\s*(?:-|–|—|to|through)\\s*(?:Present|Current|Now|${DATE_PART_PATTERN})`, 'ig'), '') : source;
    const comma = withoutDates.split(/\s*,\s*/).map(text).filter(Boolean);
    if (comma.length === 2 && (ROLE_PATTERN.test(comma[0]) || EMPLOYER_PATTERN.test(comma[1]))) inferred = { title: comma[0], employer: comma[1] };
  }
  if (!inferred?.title || !inferred?.employer) return null;
  const location = parts.find(part => isLocation(part)) || '';
  return { ...inferred, location, ...dates, verificationStatus: 'needs_verification', bullets: [] };
}

function headerComponents(value) {
  const source = text(value);
  const dates = parseDateRange(source);
  const withoutRange = dates.matched
    ? source
      .replace(new RegExp(`${DATE_PART_PATTERN}\\s*(?:-|–|—|to|through)\\s*(?:Present|Current|Now|${DATE_PART_PATTERN})`, 'ig'), '')
      .replace(new RegExp(DATE_PART_PATTERN, 'ig'), '')
    : source;
  return withoutRange.split(/\s*(?:\||\t|—|–)\s*/).map(text).filter(value => value && !isLocation(value));
}

function parseExperienceSection(lines) {
  const experience = [];
  const unparsed = [];
  let active = null;
  for (let index = 0; index < lines.length;) {
    const line = text(lines[index]);
    if (!line) { index++; continue; }
    if (/^[-*•]\s+/.test(line)) {
      const value = cleanBullet(line);
      if (active) active.bullets.push({ text: value, proofPointIds: [], verificationStatus: 'needs_verification' });
      else unparsed.push(value);
      index++;
      continue;
    }
    const inline = experienceHeader(line);
    if (inline) {
      active = inline;
      experience.push(active);
      index++;
      continue;
    }
    const nextLine = text(lines[index + 1]);
    const nextDates = parseDateRange(nextLine);
    if (nextLine && nextDates.matched && !parseDateRange(line).matched && !experienceHeader(nextLine)) {
      const inferred = inferTitleEmployer([line, ...headerComponents(nextLine)]);
      if (inferred && (ROLE_PATTERN.test(line) || ROLE_PATTERN.test(headerComponents(nextLine).join(' ')))) {
        const location = nextLine.split(/\s*(?:\||\t|—|–)\s*/).map(text).find(isLocation) || '';
        active = { ...inferred, location, ...nextDates, verificationStatus: 'needs_verification', bullets: [] };
        experience.push(active);
        index += 2;
        continue;
      }
    }
    let dateIndex = -1;
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset++) {
      if (/^[-*•]\s+/.test(lines[index + offset])) break;
      if (isDateLine(lines[index + offset])) { dateIndex = index + offset; break; }
    }
    if (dateIndex >= 0) {
      const allHeaderParts = lines.slice(index, dateIndex).flatMap(value => text(value).split(/\s*(?:\||\t|—|–)\s*/)).filter(value => value && !isLocation(value));
      const headerParts = allHeaderParts.slice(-2);
      const inferred = inferTitleEmployer(headerParts);
      if (inferred) {
        for (const detail of allHeaderParts.slice(0, -2)) {
          if (active) active.bullets.push({ text: cleanBullet(detail), proofPointIds: [], verificationStatus: 'needs_verification' });
          else unparsed.push(cleanBullet(detail));
        }
        const location = lines.slice(index, dateIndex).flatMap(value => text(value).split(/\s*(?:\||\t|—|–)\s*/)).find(isLocation) || '';
        active = { ...inferred, location, ...parseDateRange(lines[dateIndex]), verificationStatus: 'needs_verification', bullets: [] };
        experience.push(active);
        index = dateIndex + 1;
        continue;
      }
    }
    if (isDateLine(line) && active && !active.dateSource?.startText) Object.assign(active, parseDateRange(line));
    else if (isLocation(line) && active && !active.location) active.location = line;
    else if (active) active.bullets.push({ text: cleanBullet(line), proofPointIds: [], verificationStatus: 'needs_verification' });
    else unparsed.push(cleanBullet(line));
    index++;
  }
  return { experience, unparsed };
}

export function parseResumeText(profileId, sourceText) {
  const normalizedSource = normalizeResumeSourceText(sourceText);
  const rawLines = normalizedSource.split('\n');
  const nonempty = rawLines.map(text).filter(Boolean);
  const identity = { name: '', email: '', phone: '', location: '', links: [], verificationStatus: 'needs_verification' };
  const emailMatch = normalizedSource.match(EMAIL_PATTERN);
  const emailLine = emailMatch ? nonempty.find(line => line.includes(emailMatch[0])) : null;
  const phoneLine = nonempty.find(line => /(?:\+?\d[\d ().-]{7,}\d)/.test(line));
  identity.email = emailMatch?.[0] || '';
  identity.phone = phoneLine?.match(/(?:\+?\d[\d ().-]{7,}\d)/)?.[0] || '';
  const firstHeadingIndex = rawLines.findIndex(line => Boolean(canonicalSection(headingName(line))));
  const headerLines = rawLines.slice(0, firstHeadingIndex < 0 ? Math.min(rawLines.length, 8) : firstHeadingIndex).map(line => text(line).replace(/^#{1,3}\s+/, '')).filter(Boolean);
  const contactFree = value => text(value)
    .replace(EMAIL_PATTERN, '')
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/, '')
    .replace(/https?:\/\/\S+/gi, '')
    .split(/\s*[|•]\s*/)
    .map(text)
    .filter(Boolean);
  const headerParts = headerLines.flatMap(contactFree);
  identity.name = headerParts.find(line => !isLocation(line) && !/^(?:curriculum vitae|resume|cv)$/i.test(line)) || '';
  const locationCandidate = headerParts.find(line => line !== identity.name && isLocation(line));
  identity.location = locationCandidate || '';
  for (const line of headerLines) for (const match of line.matchAll(/(?:https?:\/\/|www\.)[^\s|]+/g)) identity.links.push({ label: 'Link', url: match[0], verificationStatus: 'verified' });
  if (identity.name && identity.email && identity.phone) identity.verificationStatus = 'verified';

  const sections = [];
  let current = { title: 'Unsectioned', key: '', lines: [] };
  for (const raw of rawLines.slice(firstHeadingIndex < 0 ? 0 : firstHeadingIndex)) {
    const heading = sectionHeading(raw, { insideSection: Boolean(current.key) });
    if (heading) {
      if (current.lines.some(line => text(line))) sections.push(current);
      current = { title: heading, key: canonicalSection(heading), lines: [] };
    } else current.lines.push(String(raw).match(/^#{3,6}\s+(.+)$/)?.[1] || raw);
  }
  if (current.lines.some(line => text(line))) sections.push(current);

  const document = { schemaVersion: 1, identity, summary: { text: '', verificationStatus: 'needs_verification' }, experience: [], education: [], skills: [], credentials: [], projects: [], additionalSections: [] };
  for (const section of sections) {
    const lines = section.lines.map(text).filter(Boolean);
    if (section.key === 'summary') document.summary = { text: lines.join(' '), verificationStatus: 'needs_verification' };
    else if (section.key === 'skills') document.skills = lines.flatMap(line => cleanBullet(line).split(/[,|;]/)).map(name => ({ name: text(name), category: '', verificationStatus: 'needs_verification' })).filter(entry => entry.name);
    else if (section.key === 'education') document.education = lines.filter(line => !isDateLine(line)).map(line => ({ institution: cleanBullet(line), degree: '', field: '', location: '', startDate: '', endDate: '', verificationStatus: 'needs_verification' }));
    else if (section.key === 'credentials') document.credentials = lines.map(line => ({ name: cleanBullet(line), issuer: '', date: '', verificationStatus: 'needs_verification' }));
    else if (section.key === 'projects') {
      let active = null;
      for (const line of lines) {
        if (/^[-*•]\s+/.test(line) && active) active.bullets.push({ text: cleanBullet(line), verificationStatus: 'needs_verification' });
        else {
          active = { name: cleanBullet(line), description: '', url: '', bullets: [], verificationStatus: 'needs_verification' };
          document.projects.push(active);
        }
      }
    }
    else if (section.key === 'experience') {
      const parsed = parseExperienceSection(lines);
      document.experience.push(...parsed.experience);
      if (parsed.unparsed.length) document.additionalSections.push({ title: 'Unparsed experience details', entries: parsed.unparsed, verificationStatus: 'needs_verification' });
    } else if (lines.length) document.additionalSections.push({ title: section.title, entries: lines.map(cleanBullet), verificationStatus: 'needs_verification' });
  }
  return normalizeResumeDocument(profileId, document);
}

export function parseResumeSource(profileId, sourceText, sourceFormat = 'text') {
  const format = String(sourceFormat || 'text').toLowerCase().replace(/^\./, '');
  if (format === 'json') return normalizeResumeDocument(profileId, JSON.parse(String(sourceText || '')));
  if (format === 'yaml' || format === 'yml') return normalizeResumeDocument(profileId, YAML.parse(String(sourceText || '')));
  return parseResumeText(profileId, sourceText);
}

export function validateResumeDocument(document, { requireComplete = true } = {}) {
  const blockers = [];
  const warnings = [];
  if (!document || document.schemaVersion !== RESUME_SCHEMA_VERSION) blockers.push({ code: 'resume_schema_invalid', message: `schemaVersion must be ${RESUME_SCHEMA_VERSION}` });
  const identity = document?.identity || {};
  if (!identity.name) blockers.push({ code: 'resume_source_incomplete', field: 'identity.name', message: 'Candidate name is required.' });
  if (requireComplete && !identity.email) blockers.push({ code: 'resume_source_incomplete', field: 'identity.email', message: 'Email is required.' });
  if (requireComplete && !identity.phone) blockers.push({ code: 'resume_source_incomplete', field: 'identity.phone', message: 'Phone is required.' });
  if (requireComplete && !list(document?.experience).length && !list(document?.projects).length) blockers.push({ code: 'resume_source_incomplete', field: 'experience', message: 'At least one experience or project entry is required.' });
  for (const entry of list(document?.experience)) {
    if (!entry.id || !entry.employer || !entry.title) blockers.push({ code: 'resume_source_incomplete', field: `experience.${entry.id || 'unknown'}`, message: 'Each experience requires an ID, employer, and title.' });
    if (!entry.dateSource?.startText) warnings.push({ code: 'resume_date_uncertain', entryId: entry.id, message: 'Experience start date needs verification.' });
  }
  const uncertain = [];
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    if (value.verificationStatus === 'needs_verification') uncertain.push(value.id || 'field');
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(inspect); else if (child && typeof child === 'object') inspect(child);
  };
  inspect(document);
  if (uncertain.length) warnings.push({ code: 'resume_source_unverified', entryIds: [...new Set(uncertain)], message: 'Imported fields require human verification or correction.' });
  return { valid: blockers.length === 0, schemaVersion: RESUME_SCHEMA_VERSION, blockers, warnings };
}
function invalidResumeError(validation) {
  const first = validation.blockers[0];
  return Object.assign(new Error(first?.message || 'Canonical resume does not pass the versioned schema.'), {
    code: first?.code || 'resume_schema_invalid',
    type: 'validation',
    details: { blockers: validation.blockers }
  });
}


export function readResumeFile(profileId, filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') return { sourceText, document: parseResumeSource(profileId, sourceText, ext) };
  const normalizedSource = normalizeResumeSourceText(sourceText);
  return { sourceText: normalizedSource, document: parseResumeText(profileId, normalizedSource) };
}

function docxHtmlToMarkdown(html) {
  const $ = load(`<body>${String(html || '')}</body>`);
  const lines = [];
  $('body').find('h1,h2,h3,h4,h5,h6,p,li,tr').each((_index, element) => {
    const item = $(element);
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'p' && item.closest('li,tr').length) return;
    if (tag === 'li' && item.parents('li').length) return;
    const value = tag === 'tr'
      ? item.find('th,td').map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).join(' | ')
      : item.text().replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (/^h[1-6]$/.test(tag)) lines.push(`${'#'.repeat(Math.min(3, Number(tag[1])))} ${value}`);
    else if (tag === 'li') lines.push(`- ${value}`);
    else lines.push(value);
  });
  return normalizeResumeSourceText(lines.join('\n'));
}

async function extractDocxText(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(() => ({ src: '' }))
  });
  const sourceText = docxHtmlToMarkdown(result.value);
  if (!sourceText) throw Object.assign(new Error('No readable text was found in that DOCX file.'), { code: 'resume_text_extraction_empty' });
  return {
    sourceText,
    extraction: {
      extractor: 'mammoth',
      warnings: (result.messages || []).map(message => String(message.message || message)).filter(Boolean)
    }
  };
}

async function extractPdfText(filePath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let line = '';
      let lastY = null;
      for (const item of content.items || []) {
        if (!item || typeof item.str !== 'string') continue;
        const y = Number(item.transform?.[5]);
        if (line && Number.isFinite(y) && Number.isFinite(lastY) && Math.abs(y - lastY) > 2) {
          lines.push(line.trim());
          line = '';
        }
        const value = item.str.trim();
        if (value) line += `${line && !/^[,.;:!?)]/.test(value) ? ' ' : ''}${value}`;
        if (item.hasEOL && line) {
          lines.push(line.trim());
          line = '';
        }
        if (Number.isFinite(y)) lastY = y;
      }
      if (line) lines.push(line.trim());
      pages.push(lines.filter(Boolean).join('\n'));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const sourceText = normalizeResumeSourceText(pages.filter(Boolean).join('\n\n'));
  if (sourceText.replace(/[^\p{L}\p{N}]/gu, '').length < 20) {
    throw Object.assign(new Error('No readable text layer was found in that PDF. It may be a scanned document; run local OCR or upload a text-based PDF, DOCX, TXT, or Markdown file.'), { code: 'resume_text_extraction_empty' });
  }
  return { sourceText, extraction: { extractor: 'pdfjs-dist', pageCount: pages.length, warnings: [] } };
}

export async function readResumeFileAsync(profileId, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.pdf', '.docx'].includes(ext)) {
    const input = readResumeFile(profileId, filePath);
    return { ...input, sourceFormat: ext.slice(1) || 'text', sourceName: path.basename(filePath), sourceFilePath: filePath, extraction: { extractor: 'jobos-text', warnings: [] } };
  }
  const extracted = ext === '.pdf' ? await extractPdfText(filePath) : await extractDocxText(filePath);
  return {
    ...extracted,
    document: parseResumeText(profileId, extracted.sourceText),
    sourceFormat: ext.slice(1),
    sourceName: path.basename(filePath),
    sourceFilePath: filePath
  };
}

export function currentResume(s, profileId) {
  const row = one(s, `SELECT r.*,COALESCE(i.source_format,'text') AS source_format,COALESCE(i.source_name,'') AS source_name,COALESCE(i.source_archive_path,'') AS source_archive_path,COALESCE(i.extraction_json,'{}') AS extraction_json
    FROM profile_resume_revisions r LEFT JOIN resume_source_imports i ON i.resume_id=r.id WHERE r.profile_id=? AND r.is_current=1`, [profileId]);
  return row ? { ...row, document: parseJson(row.document_json, null), extraction: parseJson(row.extraction_json, {}), validation: validateResumeDocument(parseJson(row.document_json, null)) } : null;
}
export function getResume(s, profileId, revision = null) {
  const select = `SELECT r.*,COALESCE(i.source_format,'text') AS source_format,COALESCE(i.source_name,'') AS source_name,COALESCE(i.source_archive_path,'') AS source_archive_path,COALESCE(i.extraction_json,'{}') AS extraction_json
    FROM profile_resume_revisions r LEFT JOIN resume_source_imports i ON i.resume_id=r.id`;
  const row = revision == null ? one(s, `${select} WHERE r.profile_id=? AND r.is_current=1`, [profileId]) : one(s, `${select} WHERE r.profile_id=? AND r.revision=?`, [profileId, revision]);
  return row ? { ...row, document: parseJson(row.document_json, null), extraction: parseJson(row.extraction_json, {}), validation: validateResumeDocument(parseJson(row.document_json, null)) } : null;
}
export function listResumeRevisions(s, profileId) {
  return all(s, `SELECT r.*,COALESCE(i.source_format,'text') AS source_format,COALESCE(i.source_name,'') AS source_name,COALESCE(i.source_archive_path,'') AS source_archive_path,COALESCE(i.extraction_json,'{}') AS extraction_json
    FROM profile_resume_revisions r LEFT JOIN resume_source_imports i ON i.resume_id=r.id WHERE r.profile_id=? ORDER BY r.revision`, [profileId]).map(row => ({ ...row, document: parseJson(row.document_json, null), extraction: parseJson(row.extraction_json, {}) }));
}

function resumeMarkdown(document) {
  const identity = document.identity || {};
  const lines = [
    `# ${identity.name || 'Resume'}`,
    '',
    [identity.email, identity.phone, identity.location].filter(Boolean).join(' · ')
  ];
  for (const link of identity.links || []) if (link.url) lines.push(`- [${link.label || link.url}](${link.url})`);
  if (document.summary?.text) lines.push('', '## Summary', '', document.summary.text);
  if (document.experience?.length) {
    lines.push('', '## Experience');
    for (const entry of document.experience) {
      lines.push('', `### ${entry.title}${entry.employer ? ` — ${entry.employer}` : ''}`);
      const details = [entry.location, [entry.dateSource?.startText, entry.dateSource?.endText].filter(Boolean).join(' – ')].filter(Boolean).join(' · ');
      if (details) lines.push('', details);
      for (const bullet of entry.bullets || []) if (bullet.text) lines.push(`- ${bullet.text}`);
    }
  }
  const simpleSections = [
    ['Skills', document.skills, item => [item.name, item.category].filter(Boolean).join(' — ')],
    ['Education', document.education, item => [item.institution, item.degree, item.field, item.location].filter(Boolean).join(' — ')],
    ['Credentials', document.credentials, item => [item.name, item.issuer, item.date].filter(Boolean).join(' — ')],
    ['Projects', document.projects, item => [item.name, item.description, item.url].filter(Boolean).join(' — ')]
  ];
  for (const [title, items, format] of simpleSections) {
    if (!items?.length) continue;
    lines.push('', `## ${title}`, '');
    for (const item of items) {
      const value = format(item);
      if (value) lines.push(`- ${value}`);
      for (const bullet of item.bullets || []) if (bullet.text) lines.push(`  - ${bullet.text}`);
    }
  }
  for (const section of document.additionalSections || []) {
    lines.push('', `## ${section.title}`, '');
    for (const entry of section.entries || []) lines.push(`- ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function syncResume(s, profileId) {
  const revisions = listResumeRevisions(s, profileId);
  if (!revisions.length) return;
  const directory = path.join(s.p.profiles, profileId, 'resume');
  for (const revision of revisions) {
    const source = { format: revision.source_format, name: revision.source_name, archivePath: revision.source_archive_path || null, extraction: revision.extraction };
    writeYaml(path.join(directory, 'revisions', `${revision.revision}.yaml`), { id: revision.id, profileId, revision: revision.revision, schemaVersion: revision.schema_version, sourceTextHash: revision.source_text_hash, source, verificationStatus: revision.verification_status, supersedesResumeId: revision.supersedes_resume_id || null, isCurrent: Boolean(revision.is_current), createdAt: revision.created_at, reviewedAt: revision.reviewed_at || null, document: revision.document });
    writeMd(path.join(directory, 'revisions', `${revision.revision}.md`), resumeMarkdown(revision.document));
    writeMd(path.join(directory, 'revisions', `${revision.revision}-source.md`), `# Extracted resume source\n\n> Generated from ${revision.source_name || revision.source_format || 'resume input'}. Edit the reviewed resume through JobOS so changes create a revision.\n\n${revision.source_text}`);
  }
  const current = revisions.find(revision => revision.is_current);
  if (current) {
    const source = { format: current.source_format, name: current.source_name, archivePath: current.source_archive_path || null, extraction: current.extraction };
    writeYaml(path.join(directory, 'current.yaml'), { id: current.id, profileId, revision: current.revision, schemaVersion: current.schema_version, sourceTextHash: current.source_text_hash, source, verificationStatus: current.verification_status, createdAt: current.created_at, reviewedAt: current.reviewed_at || null, document: current.document, validation: validateResumeDocument(current.document) });
    writeMd(path.join(directory, 'current.md'), resumeMarkdown(current.document));
    writeMd(path.join(directory, 'current-source.md'), `# Extracted resume source\n\n> Generated from ${current.source_name || current.source_format || 'resume input'}. Edit the reviewed resume through JobOS so changes create a revision.\n\n${current.source_text}`);
  }
}

export function createResumeRevision(s, { profileId, document, sourceText = '', sourceFormat = 'text', sourceName = '', sourceFilePath = '', extraction = {}, verificationStatus = null, reviewedAt = null, persist = true }) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const normalized = normalizeResumeDocument(profileId, document);
  const validation = validateResumeDocument(normalized);
  if (!validation.valid) throw invalidResumeError(validation);
  const current = one(s, 'SELECT * FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profileId]);
  const revision = Number(one(s, 'SELECT COALESCE(MAX(revision),0) AS revision FROM profile_resume_revisions WHERE profile_id=?', [profileId])?.revision || 0) + 1;
  const at = now();
  const resumeId = id('resume', `${profileId}:${revision}:${sourceHash(sourceText)}:${JSON.stringify(normalized)}`);
  const status = verificationStatus || (validation.warnings.some(warning => warning.code === 'resume_source_unverified') ? 'needs_verification' : 'verified');
  if (!RESUME_VERIFICATION_STATUSES.has(status)) throw Error(`Invalid resume verification status: ${status}`);
  let sourceArchivePath = '';
  if (sourceFilePath && ['pdf', 'docx'].includes(String(sourceFormat).toLowerCase())) {
    const archiveDirectory = path.join(s.p.state, 'resume-sources', profileId);
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, `${revision}.${String(sourceFormat).toLowerCase()}`);
    fs.copyFileSync(sourceFilePath, archivePath);
    sourceArchivePath = path.relative(s.root, archivePath);
  }
  if (current) run(s, 'UPDATE profile_resume_revisions SET is_current=0 WHERE id=?', [current.id]);
  run(s, 'INSERT INTO profile_resume_revisions (id,profile_id,revision,schema_version,source_text,source_text_hash,document_json,verification_status,supersedes_resume_id,is_current,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [resumeId, profileId, revision, RESUME_SCHEMA_VERSION, sourceText, sourceHash(sourceText), JSON.stringify(normalized), status, current?.id || null, 1, at, reviewedAt]);
  run(s, 'INSERT INTO resume_source_imports (resume_id,source_format,source_name,source_archive_path,extraction_json) VALUES (?,?,?,?,?)', [resumeId, sourceFormat || 'text', sourceName || '', sourceArchivePath, JSON.stringify(extraction || {})]);
  run(s, 'UPDATE profiles SET resume_text=?,updated_at=? WHERE id=?', [sourceText, at, profileId]);
  audit(s, 'resume.revision_created', 'profile_resume_revision', resumeId, { profileId, revision, supersedesResumeId: current?.id || null, verificationStatus: status, valid: validation.valid });
  syncResume(s, profileId);
  if (persist) save(s);
  return getResume(s, profileId, revision);
}

export async function importResume(s, { profileId, filePath, persist = true }) {
  const input = await readResumeFileAsync(profileId, filePath);
  return createResumeRevision(s, { profileId, ...input, persist });
}
export async function replaceResume(s, { profileId, filePath }) {
  return importResume(s, { profileId, filePath });
}
