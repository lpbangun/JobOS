import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { id, now, slug, parseJson } from './utils.js';
import { one, all, run, save, audit } from './db.js';
import { writeYaml, writeMd } from './workspace.js';
import { deserializeFitScore, qualifiesForHighFit, scoreMd } from './scoring.js';
import { extractRequirementInventory } from './requirements.js';
import { classifyLiveness, deserializeLiveness, isLivenessFresh, livenessGate, normalizeLiveness, postingLivenessHandoff } from './discovery/liveness.js';

export function requirementInventory(text){ return extractRequirementInventory(text); }
export function requirements(text){ return requirementInventory(text).requirements.map(requirement => requirement.sourceText); }
export function parseJob(text, fb = {}) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const find = key => lines.find(line => new RegExp(`^${key}\\s*:`, 'i').test(line))?.replace(new RegExp(`^${key}\\s*:\\s*`, 'i'), '');
  const heading = lines.find(line => /^#\s+/.test(line));
  const workModelText = String(fb.workModel || find('work model') || '').trim().toLowerCase();
  const workModel = /\bremote\b/.test(workModelText) ? 'remote' : /\bhybrid\b/.test(workModelText) ? 'hybrid' : /\b(on[- ]?site|in office)\b/.test(workModelText) ? 'onsite' : 'unknown';
  return {
    title: fb.title || find('title') || (heading ? heading.replace(/^#\s+/, '') : 'Imported role'),
    company: fb.company || find('company') || 'Unknown company',
    location: fb.location || find('location') || '',
    compensation: fb.compensation || { text: find('compensation') || '' },
    workModel,
    description: text
  };
}
export function ensureCompany(s,name){ const cid=slug(name||'unknown-company'), at=now(); run(s,'INSERT OR IGNORE INTO companies (id,name,created_at,updated_at) VALUES (?,?,?,?)',[cid,name||'Unknown company',at,at]); return one(s,'SELECT * FROM companies WHERE id=?',[cid]); }
function publicUrl(u){ return String(u || '').startsWith('jobos:text:') ? '' : (u || ''); }
export function dedupeKey(job){ return [job.company,job.title,job.location].map(x=>String(x||'').trim().toLowerCase().replace(/\s+/g,' ')).join('|'); }
function sourceEntry(source,url,at){ return {source:source||'manual',url:publicUrl(url),seenAt:at}; }
function appendSourceHistory(existing, entry){ const items=parseJson(existing?.source_history_json,[]); const arr=Array.isArray(items)?items:[]; if(!arr.some(x=>x.source===entry.source && x.url===entry.url)) arr.push(entry); return arr; }
function seenUrlBefore(existing, entry){ const items=parseJson(existing?.source_history_json,[]); const arr=Array.isArray(items)?items:[]; return arr.some(x=>String(x.url||'')===String(entry.url||'')); }
function isRepost(existing, entry, at){
  const firstSeen=existing?.first_seen_at||existing?.created_at;
  if(!firstSeen||seenUrlBefore(existing,entry)) return false;
  if((new Date(at).getTime()-new Date(firstSeen).getTime())>21*24*60*60*1000) return true;
  return existing?.status==='archived'&&existing?.last_seen_at ? (new Date(at).getTime()-new Date(existing.last_seen_at).getTime())>21*24*60*60*1000 : false;
}
function canMergeByKey(existing, dbUrl){ const a=publicUrl(existing?.url), b=publicUrl(dbUrl); return !a || !b || a===b; }
function createPossibleDuplicateTask(s, job, candidates, at){
  if(!candidates.length) return null;
  const ids=candidates.map(c=>c.id).sort(), tid=id('task',`possible-duplicate:${job.id}:${ids.join(':')}`);
  run(s,'INSERT OR IGNORE INTO tasks (id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,profile_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[tid,job.id,null,`Review possible duplicate job: ${job.title}`,`This posting shares company, title, and location with existing job(s) ${ids.join(', ')}, but has a different source URL. Review before archiving or merging.`,'review',null,'normal','open','system',at,at,job.profile_id]);
  audit(s,'job.possible_duplicate','job',job.id,{jobId:job.id,candidateJobIds:ids,dedupeKey:job.dedupe_key});
  return tid;
}
const WORK_MODELS = new Set(['remote', 'hybrid', 'onsite', 'unknown']);
const EMPLOYMENT_TYPES = new Set(['full_time', 'part_time', 'contract', 'temporary', 'internship', 'volunteer', 'other']);

function canonicalCompensation(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const numberOrNull = item => Number.isFinite(Number(item)) ? Number(item) : null;
  const interval = ['hour', 'day', 'week', 'month', 'year'].includes(source.interval) ? source.interval : 'unknown';
  return {
    text: String(source.text ?? ''),
    min: source.min == null ? null : numberOrNull(source.min),
    max: source.max == null ? null : numberOrNull(source.max),
    currency: String(source.currency ?? ''),
    interval
  };
}

function hasCompensation(value) {
  const item = canonicalCompensation(value);
  return Boolean(item.text || item.min != null || item.max != null || item.currency || item.interval !== 'unknown');
}

function nativeValuePresent(value) {
  if (value == null || value === '' || value === 'unknown') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function mergeNativeFields(stored, incoming) {
  const prior = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...prior };
  for (const [key, value] of Object.entries(next)) {
    if (nativeValuePresent(value)) merged[key] = value;
  }
  return merged;
}

function normalizedDiscoveryFields(job, existing = null, jobId = '') {
  const incomingCompensation = canonicalCompensation(job.compensation);
  const storedCompensation = canonicalCompensation(parseJson(existing?.compensation_json, {}));
  const compensationDetails = hasCompensation(incomingCompensation) ? incomingCompensation : storedCompensation;
  const incomingWorkModel = WORK_MODELS.has(job.workModel) ? job.workModel : 'unknown';
  const storedWorkModel = WORK_MODELS.has(existing?.work_model) ? existing.work_model : 'unknown';
  const incomingEmploymentTypes = Array.isArray(job.employmentTypes)
    ? [...new Set(job.employmentTypes.filter(value => EMPLOYMENT_TYPES.has(value)))]
    : [];
  const storedEmploymentTypes = parseJson(existing?.employment_types_json, []).filter(value => EMPLOYMENT_TYPES.has(value));
  const sourceNativeFields = mergeNativeFields(parseJson(existing?.source_native_json, {}), job.sourceNativeFields);
  const incomingLiveness = job.liveness
    ? normalizeLiveness(job.liveness, { id: jobId || existing?.id, source: job.source || existing?.source })
    : null;
  const incomingHasStructured = hasCompensation(incomingCompensation);
  const incomingHasText = Boolean(incomingCompensation.text);
  const storedDisplay = String(existing?.compensation ?? '');
  const compensationDisplay = incomingHasText
    ? incomingCompensation.text
    : (incomingHasStructured && storedDisplay ? storedDisplay : (incomingHasStructured ? incomingCompensation.text : storedDisplay));
  return {
    compensation: compensationDisplay,
    compensationDetails,
    workModel: incomingWorkModel !== 'unknown' ? incomingWorkModel : storedWorkModel,
    employmentTypes: incomingEmploymentTypes.length ? incomingEmploymentTypes : storedEmploymentTypes,
    department: String(job.department || existing?.department || ''),
    sourceNativeFields,
    liveness: incomingLiveness || (existing ? deserializeLiveness(existing) : null)
  };
}

export function getJobLiveness(row) {
  return deserializeLiveness(row);
}

export function getPostingLiveness(row) {
  return postingLivenessHandoff(deserializeLiveness(row), row);
}

export function persistJobLiveness(s, jid, assessment, { persist = true } = {}) {
  const row = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!row) throw Error(`Unknown job: ${jid}`);
  const liveness = normalizeLiveness(assessment, row);
  run(s, 'UPDATE jobs SET liveness_status=?, liveness_checked_at=?, liveness_json=?, updated_at=? WHERE id=?', [
    liveness.status,
    liveness.checkedAt,
    JSON.stringify(liveness),
    now(),
    jid
  ]);
  audit(s, 'job.liveness_checked', 'job', jid, {
    jobId: jid,
    status: liveness.status,
    checkedAt: liveness.checkedAt,
    reasonCodes: liveness.reasonCodes,
    source: liveness.source
  });
  syncJob(s, jid);
  if (persist) save(s);
  return liveness;
}

function staleDryRunLiveness(current, row) {
  return normalizeLiveness({
    ...current,
    jobId: row.id,
    status: 'uncertain',
    reasonCodes: [...new Set([...(current.reasonCodes || []), 'stale_or_unchecked'])],
    evidence: current.evidence || []
  }, row);
}

export async function resolveJobLiveness(s, jid, opts = {}) {
  const row = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!row) throw Error(`Unknown job: ${jid}`);
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const current = deserializeLiveness(row);
  if (opts.dryRun) {
    const visible = isLivenessFresh(current, nowFn()) ? current : staleDryRunLiveness(current, row);
    return { ...livenessGate(visible, row), persistedLiveness: current, handoff: postingLivenessHandoff(visible, row), refreshed: false };
  }
  let liveness = current;
  let refreshed = false;
  if (!isLivenessFresh(current, nowFn())) {
    const checkLiveness = opts.checkLiveness || classifyLiveness;
    liveness = await checkLiveness({
      jobId: row.id,
      sourceId: row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      url: row.url,
      source: row.source,
      listingPresent: false
    }, { ...opts, now: nowFn });
    liveness = persistJobLiveness(s, row.id, liveness);
    refreshed = true;
  }
  return { ...livenessGate(liveness, row), persistedLiveness: liveness, handoff: postingLivenessHandoff(liveness, row), refreshed };
}

export function assertJobLivenessGate(gate, operation = 'continue') {
  if (gate.outcome !== 'blocked') return gate;
  throw Object.assign(
    new Error(`Job ${gate.liveness.jobId} is expired and cannot ${operation}`),
    {
      code: 'job_expired',
      type: 'validation',
      liveness: gate.liveness,
      postingLiveness: gate.handoff
    }
  );
}
export function syncJob(s, jid) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) return;
  const storedScore = parseJson(job.score_json, null);
  const fit = deserializeFitScore(storedScore, { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id });
  const app = one(s, 'SELECT * FROM applications WHERE job_id=?', [jid]);
  const tasks = all(s, 'SELECT * FROM tasks WHERE job_id=? ORDER BY due_at IS NULL,due_at,created_at', [jid]);
  const liveness = deserializeLiveness(job);
  const dir = path.join(s.p.jobs, jid);
  writeYaml(path.join(dir, 'job.yaml'), {
    id: job.id,
    profileId: job.profile_id,
    title: job.title,
    company: job.company,
    location: job.location,
    url: publicUrl(job.url),
    source: job.source,
    postedDate: job.posted_date || '',
    sourceHistory: parseJson(job.source_history_json, []),
    requirements: parseJson(job.requirements_json, []),
    compensation: job.compensation,
    compensationDetails: canonicalCompensation(parseJson(job.compensation_json, {})),
    workModel: WORK_MODELS.has(job.work_model) ? job.work_model : 'unknown',
    employmentTypes: parseJson(job.employment_types_json, []),
    department: job.department || '',
    sourceNativeFields: parseJson(job.source_native_json, {}),
    liveness,
    postingLiveness: getPostingLiveness(job),
    status: job.status,
    fitScore: fit?.overall ?? null,
    highFit: Boolean(job.high_fit) && qualifiesForHighFit(fit, 0),
    dedupeKey: job.dedupe_key,
    lastSeenAt: job.last_seen_at,
    reposted: Boolean(job.reposted),
    discoveryRunId: job.discovery_run_id || '',
    fit,
    application: app ? {
      id: app.id,
      status: app.status,
      notes: app.notes,
      confirmationUrl: app.confirmation_url,
      updatedAt: app.updated_at
    } : null,
    updatedAt: job.updated_at
  });
  writeMd(path.join(dir, 'description.md'), job.description);
  if (app) writeYaml(path.join(dir, 'application.yaml'), {
    id: app.id,
    status: app.status,
    notes: app.notes,
    confirmationUrl: app.confirmation_url,
    updatedAt: app.updated_at
  });
  if (tasks.length) writeYaml(path.join(dir, 'tasks.yaml'), tasks.map(task => ({
    id: task.id,
    title: task.title,
    type: task.type,
    dueAt: task.due_at,
    priority: task.priority,
    status: task.status,
    createdBy: task.created_by
  })));
  if (storedScore) writeMd(path.join(dir, 'score.md'), scoreMd(job, fit));
}
export function importNormalized(s, { profileId, job, source = 'discovery', status = 'new', runId = '' }) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const normalized = {
    title: job.title || 'Imported role',
    company: job.company || 'Unknown company',
    location: job.location || '',
    url: job.url || '',
    source: job.source || source,
    description: job.description || '',
    postedDate: job.postedDate || job.posted_date || ''
  };
  const at = now();
  const key = dedupeKey(normalized);
  const company = ensureCompany(s, normalized.company);
  const dbUrl = normalized.url || `jobos:text:${id('job', `${profileId}:${normalized.title}:${normalized.company}:${normalized.description}`)}`;
  const exByUrl = one(s, 'SELECT * FROM jobs WHERE profile_id=? AND url<>"" AND url=? ORDER BY created_at LIMIT 1', [profileId, dbUrl]);
  const keyMatches = all(s, 'SELECT * FROM jobs WHERE profile_id=? AND dedupe_key=? ORDER BY created_at', [profileId, key]);
  const keyMerge = keyMatches.find(existing => canMergeByKey(existing, dbUrl));
  const existing = exByUrl || keyMerge || null;
  const possibleDuplicates = exByUrl ? [] : keyMatches.filter(candidate => !canMergeByKey(candidate, dbUrl));
  const entry = sourceEntry(normalized.source, dbUrl, at);
  if (existing) {
    const history = appendSourceHistory(existing, entry);
    const reposted = isRepost(existing, entry, at) ? 1 : Number(existing.reposted || 0);
    const nextUrl = (!publicUrl(existing.url) && publicUrl(dbUrl) && !one(s, 'SELECT id FROM jobs WHERE profile_id=? AND url=? AND id<>?', [profileId, dbUrl, existing.id]))
      ? dbUrl
      : existing.url;
    const nextDescription = normalized.description || existing.description;
    const fields = normalizedDiscoveryFields(job, existing, existing.id);
    const liveness = fields.liveness;
    run(s, `UPDATE jobs SET company_id=?, title=?, company=?, location=?, url=?, source=?, description=?, requirements_json=?,
      compensation=?, compensation_json=?, work_model=?, employment_types_json=?, department=?, source_native_json=?,
      liveness_status=?, liveness_checked_at=?, liveness_json=?, posted_date=?, dedupe_key=?, last_seen_at=?,
      source_history_json=?, reposted=?, discovery_run_id=?, updated_at=? WHERE id=?`, [
      company.id,
      normalized.title,
      normalized.company,
      normalized.location,
      nextUrl,
      normalized.source,
      nextDescription,
      JSON.stringify(requirementInventory(nextDescription)),
      fields.compensation,
      JSON.stringify(fields.compensationDetails),
      fields.workModel,
      JSON.stringify(fields.employmentTypes),
      fields.department,
      JSON.stringify(fields.sourceNativeFields),
      liveness.status,
      liveness.checkedAt,
      job.liveness ? JSON.stringify(liveness) : existing.liveness_json,
      normalized.postedDate || existing.posted_date || '',
      key,
      at,
      JSON.stringify(history),
      reposted,
      runId || existing.discovery_run_id || '',
      at,
      existing.id
    ]);
    audit(s, 'job.seen_again', 'job', existing.id, {
      jobId: existing.id,
      profileId,
      source: normalized.source,
      url: publicUrl(dbUrl),
      created: false,
      reposted: Boolean(reposted)
    });
    syncJob(s, existing.id);
    save(s);
    return { job: one(s, 'SELECT * FROM jobs WHERE id=?', [existing.id]), created: false, deduped: true };
  }
  const jid = id('job', `${profileId}:${dbUrl}:${key}:${normalized.description.slice(0, 200)}`);
  const history = [entry];
  const reposted = possibleDuplicates.some(candidate => isRepost(candidate, entry, at)) ? 1 : 0;
  const fields = normalizedDiscoveryFields(job, null, jid);
  const liveness = fields.liveness;
  run(s, `INSERT INTO jobs (
    id,profile_id,company_id,title,company,location,url,source,description,requirements_json,
    compensation,compensation_json,work_model,employment_types_json,department,source_native_json,
    liveness_status,liveness_checked_at,liveness_json,status,posted_date,dedupe_key,source_history_json,
    first_seen_at,last_seen_at,reposted,discovery_run_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    jid,
    profileId,
    company.id,
    normalized.title,
    normalized.company,
    normalized.location,
    dbUrl,
    normalized.source,
    normalized.description,
    JSON.stringify(requirementInventory(normalized.description)),
    fields.compensation,
    JSON.stringify(fields.compensationDetails),
    fields.workModel,
    JSON.stringify(fields.employmentTypes),
    fields.department,
    JSON.stringify(fields.sourceNativeFields),
    liveness?.status || 'uncertain',
    liveness?.checkedAt || null,
    liveness ? JSON.stringify(liveness) : '{}',
    status,
    normalized.postedDate,
    key,
    JSON.stringify(history),
    at,
    at,
    reposted,
    runId,
    at,
    at
  ]);
  const inserted = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  createPossibleDuplicateTask(s, inserted, possibleDuplicates, at);
  audit(s, 'job.imported', 'job', jid, {
    jobId: jid,
    profileId,
    source: normalized.source,
    url: publicUrl(dbUrl),
    status,
    reposted: Boolean(reposted)
  });
  syncJob(s, jid);
  save(s);
  return { job: one(s, 'SELECT * FROM jobs WHERE id=?', [jid]), created: true, deduped: false };
}
export function importText(s,{profileId,filePath,source='text_file',url=''}){ const text=fs.readFileSync(filePath,'utf8'), parsed=parseJob(text), jidSeed=url||`${profileId}:${parsed.title}:${parsed.company}:${text}`, dbUrl=url||`jobos:text:${id('job',jidSeed)}`; return importNormalized(s,{profileId,job:{...parsed,url:dbUrl,source,description:text},source,status:'imported'}); }
export async function importUrl(s,{profileId,url}){ let text; try { const r=await fetch(url,{headers:{'user-agent':'JobOS local CLI (+human-initiated import)'}}); const html=await r.text(); const $=cheerio.load(html); $('script,style,noscript').remove(); const title=($('title').first().text()||$('h1').first().text()||'Imported URL role').replace(/\s+/g,' ').trim(); const body=$('body').text().replace(/\s+/g,' ').trim(); text=`Title: ${title}\nCompany: Unknown company\nSource URL: ${url}\n\n${body.slice(0,12000)}`; } catch(e) { text=`Title: Imported URL role\nCompany: Unknown company\nSource URL: ${url}\n\nURL import was recorded, but content fetch failed: ${e.message}\nManual enrichment required before scoring or tailoring.`; } const tmp=path.join(s.p.state,`${id('urlimport',url)}.txt`); fs.writeFileSync(tmp,text); return importText(s,{profileId,filePath:tmp,source:'url',url}); }
export function listJobs(s){ return all(s,'SELECT jobs.*, applications.status AS application_status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id ORDER BY jobs.created_at DESC').map(row => ({ ...row, liveness: deserializeLiveness(row) })); }
export function updateJobStatus(s,jid,status){
  if(!['imported','new','saved','archived'].includes(status)) throw Error(`Invalid job status: ${status}`);
  const job=one(s,'SELECT * FROM jobs WHERE id=?',[jid]); if(!job) throw Error(`Unknown job: ${jid}`);
  run(s,'UPDATE jobs SET status=?, updated_at=? WHERE id=?',[status,now(),jid]);
  audit(s,'job.status_changed','job',jid,{jobId:jid,status});
  syncJob(s,jid); save(s); return one(s,'SELECT * FROM jobs WHERE id=?',[jid]);
}
export function dedupeJobs(s,{apply=false}={}){
  const rows=all(s,'SELECT * FROM jobs ORDER BY created_at');
  const groups=new Map();
  for(const job of rows){
    const keys=[String(job.url||'').startsWith('jobos:text:')?'':job.url, job.dedupe_key || dedupeKey(job)].filter(Boolean);
    for(const key of keys){ if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(job); }
  }
  const parent=new Map(rows.map(j=>[j.id,j.id]));
  const find=x=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x=parent.get(x); } return x; };
  const union=(a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(rb,ra); };
  for(const jobs of groups.values()){
    const ids=[...new Set(jobs.map(j=>j.id))];
    for(const id of ids.slice(1)) union(ids[0],id);
  }
  const components=new Map();
  for(const job of rows){
    const root=find(job.id);
    if(!components.has(root)) components.set(root,[]);
    components.get(root).push(job);
  }
  const duplicates=[];
  for(const jobs of components.values()){
    if(jobs.length<2) continue;
    const sorted=[...jobs].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id)));
    const primary=sorted[0];
    for(const dup of sorted.slice(1)){
      duplicates.push({primaryId:primary.id,duplicateId:dup.id,title:dup.title,company:dup.company,url:publicUrl(dup.url),dedupeKey:dup.dedupe_key||dedupeKey(dup),action:apply?'archived':'would_archive'});
      if(apply && dup.status!=='archived'){
        const hist=appendSourceHistory(primary,{source:`duplicate:${dup.source}`,url:dup.url,seenAt:dup.last_seen_at||dup.updated_at||now()});
        run(s,'UPDATE jobs SET source_history_json=?, updated_at=? WHERE id=?',[JSON.stringify(hist),now(),primary.id]);
        run(s,'UPDATE jobs SET status=?, updated_at=? WHERE id=?',['archived',now(),dup.id]);
        audit(s,'job.deduped','job',dup.id,{jobId:dup.id,duplicateOf:primary.id});
        syncJob(s,primary.id); syncJob(s,dup.id);
      }
    }
  }
  if(apply) save(s);
  return {apply,duplicates,count:duplicates.length};
}
