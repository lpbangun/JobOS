import { all, one, run, save, audit, reload } from './db.js';
import { state } from './analytics.js';
import { createProfile, addProof } from './profiles.js';
import { appCreate, appUpdate } from './tracking.js';
import { importText, syncJob, ensureCompany, requirements } from './jobs.js';
import { configFromFlags, createSearch, discoveryRuns, listSearches, reviewQueue, runSavedSearch } from './discovery.js';
import { id, now } from './utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { createAutomation, listAutomations, updateAutomation } from './scheduler/store.js';
import { recentRuns, runAutomationByName } from './scheduler/core.js';
import { draftOutreach, listOutreachThreads, markOutreachSent, outreachDue, scheduleFollowup } from './outreach.js';
import { approveContact, createOutreachPlan, discoverContacts, listContactPoints, suppressContact } from './research/contacts.js';
import { mapReachableNetwork } from './research/network.js';

async function body(req){ let b=''; for await (const c of req) b+=c; return b?JSON.parse(b):{}; }
function send(res,status,obj){ res.writeHead(status,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj,null,2)); }
function safeWriteOrigin(req){ const origin=req.headers.origin; if(!origin) return true; try { const host=new URL(origin).hostname; return ['127.0.0.1','localhost','::1'].includes(host); } catch { return false; } }
const tables={profiles:'profiles',proofs:'proof_points',jobs:'jobs',applications:'applications',status_changes:'status_changes',tasks:'tasks',artifacts:'artifacts',companies:'companies',stakeholders:'stakeholders',outreach_threads:'outreach_threads',source_observations:'source_observations',person_candidates:'person_candidates',contact_points:'contact_points',email_patterns:'email_patterns',relationship_edges:'relationship_edges',outreach_plans:'outreach_plans'};
const pk={profiles:'id',proofs:'id',jobs:'id',applications:'id',status_changes:'id',tasks:'id',artifacts:'id',companies:'id',stakeholders:'id',outreach_threads:'id',source_observations:'id',person_candidates:'id',contact_points:'id',email_patterns:'id',relationship_edges:'id',outreach_plans:'id'};
function publicRow(resource,row){ if(resource==='jobs' && row) return {...row,url:String(row.url||'').startsWith('jobos:text:')?'':row.url}; return row; }
export async function handleApi(s,req,res,u){
  try{
    reload(s);
    if(u.pathname==='/api/state' && req.method==='GET') return send(res,200,state(s));
    if(u.pathname==='/api/outreach/due' && req.method==='GET') return send(res,200,outreachDue(s));
    if(u.pathname==='/api/outreach/threads' && req.method==='GET') return send(res,200,listOutreachThreads(s,{jobId:u.searchParams.get('jobId')||u.searchParams.get('job_id')||null}));
    if(u.pathname==='/api/research/contacts' && req.method==='GET') return send(res,200,listContactPoints(s,{jobId:u.searchParams.get('jobId')||u.searchParams.get('job_id')||null,stakeholderId:u.searchParams.get('stakeholderId')||u.searchParams.get('stakeholder_id')||null,companyId:u.searchParams.get('companyId')||u.searchParams.get('company_id')||null}));
    if(u.pathname==='/api/research/network' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,mapReachableNetwork(s,{jobId:data.jobId||data.job_id||u.searchParams.get('jobId')||u.searchParams.get('job_id')}));
    }
    if(u.pathname==='/api/research/contacts/discover' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,await discoverContacts(s,{jobId:data.jobId||data.job_id||null,stakeholderId:data.stakeholderId||data.stakeholder_id||null}));
    }
    const contactApproveMatch=u.pathname.match(/^\/api\/research\/contacts\/([^/]+)\/approve$/);
    if(contactApproveMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      return send(res,200,approveContact(s,{contactId:decodeURIComponent(contactApproveMatch[1])}));
    }
    const contactSuppressMatch=u.pathname.match(/^\/api\/research\/contacts\/([^/]+)\/suppress$/);
    if(contactSuppressMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,suppressContact(s,{contactId:decodeURIComponent(contactSuppressMatch[1]),reason:data.reason||'dashboard'}));
    }
    if(u.pathname==='/api/outreach/plan' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,createOutreachPlan(s,{jobId:data.jobId||data.job_id,profileId:data.profileId||data.profile_id,stakeholderId:data.stakeholderId||data.stakeholder_id||null,goal:data.goal||'informational'}));
    }
    if(u.pathname==='/api/outreach/draft' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,await draftOutreach(s,{jobId:data.jobId||data.job_id||null,profileId:data.profileId||data.profile_id,stakeholderId:data.stakeholderId||data.stakeholder_id||null,goal:data.goal||'informational',planId:data.planId||data.plan_id||null,contactId:data.contactId||data.contact_id||null}));
    }
    if(u.pathname==='/api/outreach/mark-sent' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,markOutreachSent(s,{artifactId:data.artifactId||data.artifact_id,channel:data.channel,notes:data.notes||''}));
    }
    if(u.pathname==='/api/outreach/schedule-followup' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,scheduleFollowup(s,{threadId:data.threadId||data.thread_id,afterDays:data.afterDays??data.after_days??data.after}));
    }
    const outreachSentMatch=u.pathname.match(/^\/api\/outreach\/([^/]+)\/mark-sent$/);
    if(outreachSentMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,markOutreachSent(s,{artifactId:decodeURIComponent(outreachSentMatch[1]),channel:data.channel,notes:data.notes||''}));
    }
    const outreachFollowupMatch=u.pathname.match(/^\/api\/outreach\/threads\/([^/]+)\/followup$/);
    if(outreachFollowupMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,scheduleFollowup(s,{threadId:decodeURIComponent(outreachFollowupMatch[1]),afterDays:data.afterDays??data.after_days??data.after}));
    }
    if(u.pathname==='/api/runs' && req.method==='GET') return send(res,200,recentRuns(s, Number(u.searchParams.get('limit') || 25)));
    if(u.pathname==='/api/automations' && req.method==='GET') return send(res,200,listAutomations(s));
    if(u.pathname==='/api/automations' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,createAutomation(s,{name:data.name||data.id,actionId:data.actionId||data.action_id||data.action,schedule:data.schedule,profileId:data.profileId||data.profile_id||data.profile||null,enabled:Boolean(data.enabled),config:data.config||{}}));
    }
    const automationRunMatch=u.pathname.match(/^\/api\/automations\/([^/]+)\/run$/);
    if(automationRunMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      return send(res,200,await runAutomationByName(s,automationRunMatch[1],{trigger:'api'}));
    }
    const automationPatchMatch=u.pathname.match(/^\/api\/automations\/([^/]+)$/);
    if(automationPatchMatch && req.method==='PATCH'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,200,updateAutomation(s,automationPatchMatch[1],data));
    }
    if(u.pathname==='/api/searches' && req.method==='GET') return send(res,200,listSearches(s));
    if(u.pathname==='/api/searches' && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      const data=await body(req);
      return send(res,201,createSearch(s,{name:data.name,profileId:data.profileId||data.profile_id,adapter:data.adapter,config:data.config||configFromFlags(data),minFit:data.minFit||data.min_fit||70}));
    }
    const runMatch=u.pathname.match(/^\/api\/searches\/([^/]+)\/run$/);
    if(runMatch && req.method==='POST'){
      if(!safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
      return send(res,200,await runSavedSearch(s,decodeURIComponent(runMatch[1])));
    }
    if(u.pathname==='/api/discovery/runs' && req.method==='GET') return send(res,200,discoveryRuns(s));
    if(u.pathname==='/api/discovery/review-queue' && req.method==='GET') return send(res,200,reviewQueue(s));
    const m=u.pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/); if(!m) return false;
    const [,resource,rid]=m; if(!tables[resource]) return false;
    if(req.method==='GET' && !rid) return send(res,200,all(s,`SELECT * FROM ${tables[resource]} ORDER BY ${pk[resource]}`).map(row=>publicRow(resource,row)));
    if(req.method==='GET' && rid){ const row=one(s,`SELECT * FROM ${tables[resource]} WHERE ${pk[resource]}=?`,[rid]); return row?send(res,200,publicRow(resource,row)):send(res,404,{error:'not found'}); }
    if(['POST','PATCH','PUT','DELETE'].includes(req.method) && !safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
    const data=await body(req);
    if(req.method==='POST' && resource==='profiles'){ const r=createProfile(s,data.name||data.id||'Untitled Profile',{}); return send(res,201,{id:r.profile.id,created:r.created}); }
    if(req.method==='POST' && resource==='proofs'){ const p=addProof(s,data.profileId||data.profile_id,data.summary,data.evidence||'',data.skills||[]); return send(res,201,{id:p.id}); }
    if(req.method==='POST' && resource==='jobs'){
      const profileId=data.profileId||data.profile_id; if(!profileId) throw Error('Missing profileId');
      const body=data.description||data.notes||'';
      const text=`Title: ${data.title||'Imported role'}\nCompany: ${data.company||'Unknown company'}\nLocation: ${data.location||''}\n\n${body}`;
      const tmp=path.join(s.p.state,`${id('api-job',`${profileId}:${data.title}:${data.company}:${now()}`)}.txt`); fs.writeFileSync(tmp,text);
      const r=importText(s,{profileId,filePath:tmp,source:data.source||'dashboard',url:data.url||''});
      return send(res,201,{id:r.job.id,created:r.created});
    }
    if(req.method==='PATCH' && resource==='jobs' && rid){
      const row=one(s,'SELECT * FROM jobs WHERE id=?',[rid]); if(!row) return send(res,404,{error:'not found'});
      const companyName=data.company??row.company, company=ensureCompany(s,companyName), at=now();
      const description=data.description??row.description;
      const nextUrl=(data.url==='' && String(row.url||'').startsWith('jobos:text:')) ? row.url : (data.url??row.url);
      if(data.status && !['imported','new','saved','archived'].includes(String(data.status))) throw Error(`Invalid job status: ${data.status}`);
      run(s,'UPDATE jobs SET company_id=?, title=?, company=?, location=?, url=?, source=?, description=?, requirements_json=?, compensation=?, work_model=?, status=?, updated_at=? WHERE id=?',[company.id,data.title??row.title,companyName,data.location??row.location,nextUrl,data.source??row.source,description,JSON.stringify(requirements(description)),data.compensation??row.compensation,data.workModel??data.work_model??row.work_model,data.status??row.status,at,rid]);
      audit(s,'job.updated','job',rid,{jobId:rid}); syncJob(s,rid); save(s); return send(res,200,one(s,'SELECT * FROM jobs WHERE id=?',[rid]));
    }
    if(req.method==='POST' && resource==='applications'){ const a=appCreate(s,data.jobId||data.job_id,data.status||'saved',data.notes||''); return send(res,201,a); }
    if(req.method==='PATCH' && resource==='applications' && rid){ const a=appUpdate(s,rid,data.status,data.notes??null); return send(res,200,a); }
    if(req.method==='POST' && resource==='tasks'){ const tid=id('task',`${data.title}:${now()}`), at=now(), jobId=data.jobId||null; run(s,'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[tid,jobId,data.applicationId||null,data.title||'Untitled task',data.description||'',data.type||'review',data.dueAt||null,data.priority||'normal',data.status||'open','api',at,at]); audit(s,'task.created','task',tid,{jobId}); if(jobId) syncJob(s,jobId); save(s); return send(res,201,{id:tid}); }
    if(req.method==='PATCH' && resource==='tasks' && rid){ const row=one(s,'SELECT * FROM tasks WHERE id=?',[rid]); if(!row) return send(res,404,{error:'not found'}); run(s,'UPDATE tasks SET title=?, description=?, due_at=?, priority=?, status=?, updated_at=? WHERE id=?',[data.title??row.title,data.description??row.description,data.dueAt??row.due_at,data.priority??row.priority,data.status??row.status,now(),rid]); audit(s,'task.updated','task',rid,{jobId:row.job_id||null}); if(row.job_id) syncJob(s,row.job_id); save(s); return send(res,200,one(s,'SELECT * FROM tasks WHERE id=?',[rid])); }
    if(req.method==='PATCH' && resource==='artifacts' && rid){ const row=one(s,'SELECT * FROM artifacts WHERE id=?',[rid]); if(!row) return send(res,404,{error:'not found'}); const status=data.approvalStatus||data.approval_status||data.status; if(!['approved','rejected','draft_needs_human_review'].includes(status)) throw Error('Invalid artifact approval status'); run(s,'UPDATE artifacts SET approval_status=? WHERE id=?',[status,rid]); audit(s,'artifact.reviewed','artifact',rid,{jobId:row.job_id,approvalStatus:status}); save(s); return send(res,200,one(s,'SELECT id,job_id,profile_id,type,path,title,approval_status,created_at FROM artifacts WHERE id=?',[rid])); }
    return send(res,405,{error:'method not implemented for resource',resource});
  }catch(e){ return send(res,400,{error:e.message}); }
}
