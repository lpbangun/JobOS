import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { id, now, slug, parseJson } from './utils.js';
import { one, all, run, save, audit } from './db.js';
import { writeYaml, writeMd } from './workspace.js';
import { scoreMd } from './scoring.js';

export function requirements(text){ return String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).filter(l=>/require|qualification|experience|skill|must|responsibil|you will|we need|looking for|preferred|ability/i.test(l)).slice(0,20); }
export function parseJob(text, fb={}){ const lines=String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean); const find=k=>lines.find(l=>new RegExp('^'+k+'\\s*:','i').test(l))?.replace(new RegExp('^'+k+'\\s*:\\s*','i'),''); const heading=lines.find(l=>/^#\s+/.test(l)); return {title:fb.title||find('title')||(heading?heading.replace(/^#\s+/,''):'Imported role'),company:fb.company||find('company')||'Unknown company',location:fb.location||find('location')||'',description:text}; }
export function ensureCompany(s,name){ const cid=slug(name||'unknown-company'), at=now(); run(s,'INSERT OR IGNORE INTO companies (id,name,created_at,updated_at) VALUES (?,?,?,?)',[cid,name||'Unknown company',at,at]); return one(s,'SELECT * FROM companies WHERE id=?',[cid]); }
function publicUrl(u){ return String(u || '').startsWith('jobos:text:') ? '' : (u || ''); }
export function dedupeKey(job){ return [job.company,job.title,job.location].map(x=>String(x||'').trim().toLowerCase().replace(/\s+/g,' ')).join('|'); }
function sourceEntry(source,url,at){ return {source:source||'manual',url:publicUrl(url),seenAt:at}; }
function appendSourceHistory(existing, entry){ const items=parseJson(existing?.source_history_json,[]); const arr=Array.isArray(items)?items:[]; if(!arr.some(x=>x.source===entry.source && x.url===entry.url)) arr.push(entry); return arr; }
function isRepost(existing, at){ if(!existing?.last_seen_at) return false; return (new Date(at).getTime() - new Date(existing.last_seen_at).getTime()) > 21*24*60*60*1000; }
export function syncJob(s,jid){ const job=one(s,'SELECT * FROM jobs WHERE id=?',[jid]); if(!job) return; const score=parseJson(job.score_json,null), app=one(s,'SELECT * FROM applications WHERE job_id=?',[jid]), tasks=all(s,'SELECT * FROM tasks WHERE job_id=? ORDER BY due_at IS NULL,due_at,created_at',[jid]); const dir=path.join(s.p.jobs,jid); writeYaml(path.join(dir,'job.yaml'),{id:job.id,profileId:job.profile_id,title:job.title,company:job.company,location:job.location,url:publicUrl(job.url),source:job.source,postedDate:job.posted_date||'',sourceHistory:parseJson(job.source_history_json,[]),requirements:parseJson(job.requirements_json,[]),compensation:job.compensation,workModel:job.work_model,status:job.status,fitScore:job.fit_score,highFit:Boolean(job.high_fit),dedupeKey:job.dedupe_key,lastSeenAt:job.last_seen_at,reposted:Boolean(job.reposted),discoveryRunId:job.discovery_run_id||'',score,application:app?{id:app.id,status:app.status,notes:app.notes,confirmationUrl:app.confirmation_url,updatedAt:app.updated_at}:null,updatedAt:job.updated_at}); writeMd(path.join(dir,'description.md'),job.description); if(app) writeYaml(path.join(dir,'application.yaml'),{id:app.id,status:app.status,notes:app.notes,confirmationUrl:app.confirmation_url,updatedAt:app.updated_at}); if(tasks.length) writeYaml(path.join(dir,'tasks.yaml'),tasks.map(t=>({id:t.id,title:t.title,type:t.type,dueAt:t.due_at,priority:t.priority,status:t.status,createdBy:t.created_by}))); if(score) writeMd(path.join(dir,'score.md'),scoreMd(job,score)); }
export function importNormalized(s,{profileId,job,source='discovery',status='new',runId=''}) {
  if(!one(s,'SELECT id FROM profiles WHERE id=?',[profileId])) throw Error(`Unknown profile: ${profileId}`);
  const normalized={title:job.title||'Imported role',company:job.company||'Unknown company',location:job.location||'',url:job.url||'',source:job.source||source,description:job.description||'',postedDate:job.postedDate||job.posted_date||''};
  const at=now(), key=dedupeKey(normalized), company=ensureCompany(s,normalized.company), dbUrl=normalized.url||`jobos:text:${id('job',`${profileId}:${normalized.title}:${normalized.company}:${normalized.description}`)}`;
  const ex=one(s,'SELECT * FROM jobs WHERE profile_id=? AND ((url<>"" AND url=?) OR dedupe_key=?) ORDER BY created_at LIMIT 1',[profileId,dbUrl,key]);
  const entry=sourceEntry(normalized.source,dbUrl,at);
  if(ex){
    const history=appendSourceHistory(ex,entry), reposted=isRepost(ex,at)?1:Number(ex.reposted||0);
    run(s,'UPDATE jobs SET last_seen_at=?, source_history_json=?, reposted=?, discovery_run_id=?, updated_at=? WHERE id=?',[at,JSON.stringify(history),reposted,runId||ex.discovery_run_id||'',at,ex.id]);
    audit(s,'job.seen_again','job',ex.id,{jobId:ex.id,profileId,source:normalized.source,url:publicUrl(dbUrl),created:false,reposted:Boolean(reposted)});
    syncJob(s,ex.id); save(s); return {job:one(s,'SELECT * FROM jobs WHERE id=?',[ex.id]),created:false,deduped:true};
  }
  const jid=id('job',`${profileId}:${dbUrl}:${key}:${normalized.description.slice(0,200)}`);
  const history=[entry];
  run(s,'INSERT INTO jobs (id,profile_id,company_id,title,company,location,url,source,description,requirements_json,status,posted_date,dedupe_key,source_history_json,first_seen_at,last_seen_at,discovery_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[jid,profileId,company.id,normalized.title,normalized.company,normalized.location,dbUrl,normalized.source,normalized.description,JSON.stringify(requirements(normalized.description)),status,normalized.postedDate,key,JSON.stringify(history),at,at,runId,at,at]);
  audit(s,'job.imported','job',jid,{jobId:jid,profileId,source:normalized.source,url:publicUrl(dbUrl),status});
  syncJob(s,jid); save(s); return {job:one(s,'SELECT * FROM jobs WHERE id=?',[jid]),created:true,deduped:false};
}
export function importText(s,{profileId,filePath,source='text_file',url=''}){ const text=fs.readFileSync(filePath,'utf8'), parsed=parseJob(text), jidSeed=url||`${profileId}:${parsed.title}:${parsed.company}:${text}`, dbUrl=url||`jobos:text:${id('job',jidSeed)}`; return importNormalized(s,{profileId,job:{...parsed,url:dbUrl,source,description:text},source,status:'imported'}); }
export async function importUrl(s,{profileId,url}){ let text; try { const r=await fetch(url,{headers:{'user-agent':'JobOS local CLI (+human-initiated import)'}}); const html=await r.text(); const $=cheerio.load(html); $('script,style,noscript').remove(); const title=($('title').first().text()||$('h1').first().text()||'Imported URL role').replace(/\s+/g,' ').trim(); const body=$('body').text().replace(/\s+/g,' ').trim(); text=`Title: ${title}\nCompany: Unknown company\nSource URL: ${url}\n\n${body.slice(0,12000)}`; } catch(e) { text=`Title: Imported URL role\nCompany: Unknown company\nSource URL: ${url}\n\nURL import was recorded, but content fetch failed: ${e.message}\nManual enrichment required before scoring or tailoring.`; } const tmp=path.join(s.p.state,`${id('urlimport',url)}.txt`); fs.writeFileSync(tmp,text); return importText(s,{profileId,filePath:tmp,source:'url',url}); }
export function listJobs(s){ return all(s,'SELECT jobs.*, applications.status AS application_status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id ORDER BY jobs.created_at DESC'); }
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
  const seen=new Set(), duplicates=[];
  for(const jobs of groups.values()){
    const ids=[...new Set(jobs.map(j=>j.id))];
    if(ids.length<2) continue;
    const sorted=ids.map(jid=>rows.find(r=>r.id===jid)).filter(Boolean).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    const primary=sorted[0];
    for(const dup of sorted.slice(1)){
      const marker=`${primary.id}:${dup.id}`; if(seen.has(marker)) continue; seen.add(marker);
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
