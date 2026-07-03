import { all, one, run, save, audit, reload } from './db.js';
import { state } from './analytics.js';
import { createProfile, addProof } from './profiles.js';
import { appCreate, appUpdate } from './tracking.js';
import { syncJob } from './jobs.js';
import { id, now } from './utils.js';

async function body(req){ let b=''; for await (const c of req) b+=c; return b?JSON.parse(b):{}; }
function send(res,status,obj){ res.writeHead(status,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj,null,2)); }
function safeWriteOrigin(req){ const origin=req.headers.origin; if(!origin) return true; try { const host=new URL(origin).hostname; return ['127.0.0.1','localhost','::1'].includes(host); } catch { return false; } }
const tables={profiles:'profiles',proofs:'proof_points',jobs:'jobs',applications:'applications',tasks:'tasks',artifacts:'artifacts',companies:'companies',stakeholders:'stakeholders'};
const pk={profiles:'id',proofs:'id',jobs:'id',applications:'id',tasks:'id',artifacts:'id',companies:'id',stakeholders:'id'};
function publicRow(resource,row){ if(resource==='jobs' && row) return {...row,url:String(row.url||'').startsWith('jobos:text:')?'':row.url}; return row; }
export async function handleApi(s,req,res,u){
  try{
    reload(s);
    if(u.pathname==='/api/state' && req.method==='GET') return send(res,200,state(s));
    const m=u.pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/); if(!m) return false;
    const [,resource,rid]=m; if(!tables[resource]) return false;
    if(req.method==='GET' && !rid) return send(res,200,all(s,`SELECT * FROM ${tables[resource]} ORDER BY ${pk[resource]}`).map(row=>publicRow(resource,row)));
    if(req.method==='GET' && rid){ const row=one(s,`SELECT * FROM ${tables[resource]} WHERE ${pk[resource]}=?`,[rid]); return row?send(res,200,publicRow(resource,row)):send(res,404,{error:'not found'}); }
    if(['POST','PATCH','PUT','DELETE'].includes(req.method) && !safeWriteOrigin(req)) return send(res,403,{error:'write rejected: Origin must be localhost or omitted for CLI/agent calls'});
    const data=await body(req);
    if(req.method==='POST' && resource==='profiles'){ const r=createProfile(s,data.name||data.id||'Untitled Profile',{}); return send(res,201,{id:r.profile.id,created:r.created}); }
    if(req.method==='POST' && resource==='proofs'){ const p=addProof(s,data.profileId||data.profile_id,data.summary,data.evidence||'',data.skills||[]); return send(res,201,{id:p.id}); }
    if(req.method==='POST' && resource==='applications'){ const a=appCreate(s,data.jobId||data.job_id,data.status||'saved',data.notes||''); return send(res,201,a); }
    if(req.method==='PATCH' && resource==='applications' && rid){ const a=appUpdate(s,rid,data.status,data.notes??null); return send(res,200,a); }
    if(req.method==='POST' && resource==='tasks'){ const tid=id('task',`${data.title}:${now()}`), at=now(), jobId=data.jobId||null; run(s,'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[tid,jobId,data.applicationId||null,data.title||'Untitled task',data.description||'',data.type||'review',data.dueAt||null,data.priority||'normal',data.status||'open','api',at,at]); audit(s,'task.created','task',tid,{jobId}); if(jobId) syncJob(s,jobId); save(s); return send(res,201,{id:tid}); }
    if(req.method==='PATCH' && resource==='tasks' && rid){ const row=one(s,'SELECT * FROM tasks WHERE id=?',[rid]); if(!row) return send(res,404,{error:'not found'}); run(s,'UPDATE tasks SET title=?, description=?, due_at=?, priority=?, status=?, updated_at=? WHERE id=?',[data.title??row.title,data.description??row.description,data.dueAt??row.due_at,data.priority??row.priority,data.status??row.status,now(),rid]); audit(s,'task.updated','task',rid,{jobId:row.job_id||null}); if(row.job_id) syncJob(s,row.job_id); save(s); return send(res,200,one(s,'SELECT * FROM tasks WHERE id=?',[rid])); }
    return send(res,405,{error:'method not implemented for resource',resource});
  }catch(e){ return send(res,400,{error:e.message}); }
}
