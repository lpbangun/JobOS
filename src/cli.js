#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './db.js';
import { parseJson, splitCsv } from './utils.js';
import { createProfile, addProof } from './profiles.js';
import { dedupeJobs, importText, importUrl, listJobs } from './jobs.js';
import { score } from './scoring.js';
import { tailor } from './tailoring.js';
import { appCreate, appUpdate, due } from './tracking.js';
import { research } from './research.js';
import { draftOutreach } from './outreach.js';
import { funnel, renderFunnelMarkdown, weekly } from './analytics.js';
import { web } from './web.js';
import { prepInterview } from './interview.js';
import { startMcp } from './mcp.js';
import { addWatchlist, configFromFlags, createSearch, listSearches, listWatchlist, runAllSearches, runSavedSearch } from './discovery.js';
import { createAutomation, listAutomations, setAutomationEnabled } from './scheduler/store.js';
import { recentRuns, runAutomationByName, runDueAutomations, schedulerStatus, startScheduler } from './scheduler/core.js';

function parse(argv){ const out={_:[],flags:{}}; for(let i=0;i<argv.length;i++){ const a=argv[i]; if(a.startsWith('--')){ const k=a.slice(2); if(k.includes('=')){ const [kk,...vv]=k.split('='); out.flags[kk]=vv.join('='); } else if(i+1<argv.length && !argv[i+1].startsWith('--')) out.flags[k]=argv[++i]; else out.flags[k]=true; } else out._.push(a); } return out; }
function output(v,flags={}){ if(flags.json) console.log(JSON.stringify(v,null,2)); else if(typeof v==='string') console.log(v); else console.log(JSON.stringify(v,null,2)); }
function needProfile(flags){ if(!flags.profile) throw Error('Missing --profile <profile-id>'); return String(flags.profile); }
export async function main(argv=process.argv.slice(2)){ const parsed=parse(argv), flags=parsed.flags, [group,action,subaction,...rest]=parsed._, s=await openStore(flags); if(!group||group==='help'||flags.help){ output(`JobOS local-first MVP\n\nCommands:\n  jobos init [--json]\n  jobos profile create <name> [--from-resume file] [--json]\n  jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b]\n  jobos jobs import-text --profile <profile> --file <path> [--json]\n  jobos jobs import-url <url> --profile <profile> [--json]\n  jobos jobs list --json\n  jobos jobs dedupe [--apply] [--json]\n  jobos searches create <name> --profile <profile> --adapter greenhouse|lever [--board-token token|--company handle] [--keywords a,b] [--location remote] [--min-fit 70] [--json]\n  jobos searches list --json\n  jobos watchlist add --company <company> --adapter greenhouse|lever --board-token <token>|--handle <handle> [--notes text] [--json]\n  jobos watchlist list --json\n  jobos discover run --search <name-or-id> [--json]\n  jobos discover run-all [--json]\n  jobos score <job-id> --profile <profile> --json\n  jobos tailor resume --job <job-id> --profile <profile> --output markdown\n  jobos tailor cover-letter --job <job-id> --profile <profile> --output markdown\n  jobos applications create --job <job-id> --status <status> [--json]\n  jobos applications update <application-id> --status <status> [--json]\n  jobos research company --job <job-id> [--json]\n  jobos research stakeholders --job <job-id> [--json]\n  jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile-id> [--goal informational] [--json]\n  jobos interview prep --application <application-id> --stage <stage> [--json]\n  jobos analytics funnel --profile <profile> [--since 30] [--json]\n  jobos tasks due --json\n  jobos review weekly --profile <profile> --output markdown\n  jobos automation create <name> --action <action-id> --schedule "0 7 * * 1-5" [--profile <profile>] [--enabled] [--json]\n  jobos automation list [--json]\n  jobos automation enable <name> [--json]\n  jobos automation disable <name> [--json]\n  jobos automation run <name> [--json]\n  jobos scheduler run-once [--json]\n  jobos scheduler start [--interval 60]\n  jobos scheduler status [--json]\n  jobos runs list [--json]\n  jobos mcp\n  jobos web [--port 4317]\n\nGlobal: --workspace <dir> or JOBOS_HOME.`, flags); return; }
 if(group==='init'){ output({ok:true,root:s.root,database:s.p.db,workspace:s.p.ws,policy:{externalActions:'human_approval_required'}},flags); return; }
 if(group==='profile'&&action==='create'){ const name=rest.length?[subaction,...rest].filter(Boolean).join(' '):subaction; if(!name) throw Error('Missing profile name'); const r=createProfile(s,name,{fromResume:flags['from-resume'],preferences:flags.preferences}); output({id:r.profile.id,name:r.profile.name,created:r.created,preferences:parseJson(r.profile.preferences_json,{})},flags); return; }
 if(group==='proof'&&action==='add'){ if(!flags.summary) throw Error('Missing --summary'); const p=addProof(s,needProfile(flags),String(flags.summary),flags.evidence?String(flags.evidence):'',flags.skills?splitCsv(flags.skills):[]); output({id:p.id,profileId:p.profile_id,summary:p.summary},flags); return; }
 if(group==='jobs'&&action==='import-text'){ if(!flags.file) throw Error('Missing --file <path>'); const r=importText(s,{profileId:needProfile(flags),filePath:flags.file}); output({id:r.job.id,title:r.job.title,company:r.job.company,created:r.created},flags); return; }
 if(group==='jobs'&&action==='import-url'){ const url=subaction||flags.url; if(!url) throw Error('Missing URL'); const r=await importUrl(s,{profileId:needProfile(flags),url}); output({id:r.job.id,title:r.job.title,company:r.job.company,url:r.job.url,created:r.created},flags); return; }
 if(group==='jobs'&&action==='list'){ output(listJobs(s).map(x=>({id:x.id,title:x.title,company:x.company,profileId:x.profile_id,score:x.fit_score,applicationStatus:x.application_status||null,url:String(x.url||'').startsWith('jobos:text:')?'':x.url||''})),flags); return; }
 if(group==='jobs'&&action==='dedupe'){ output(dedupeJobs(s,{apply:Boolean(flags.apply)}),flags); return; }
 if(group==='searches'&&action==='create'){ const name=[subaction,...rest].filter(Boolean).join(' '); const search=createSearch(s,{name,profileId:needProfile(flags),adapter:String(flags.adapter||''),config:configFromFlags(flags),minFit:flags['min-fit']?Number(flags['min-fit']):70}); output(search,flags); return; }
 if(group==='searches'&&action==='list'){ output(listSearches(s),flags); return; }
 if(group==='watchlist'&&action==='add'){ const company=flags.company?String(flags.company):[subaction,...rest].filter(Boolean).join(' '); const handle=flags['board-token']||flags.handle||''; const item=addWatchlist(s,{company,adapter:String(flags.adapter||''),handle:String(handle),notes:flags.notes?String(flags.notes):''}); output(item,flags); return; }
 if(group==='watchlist'&&action==='list'){ output(listWatchlist(s),flags); return; }
 if(group==='discover'&&action==='run'){ const search=flags.search||subaction; if(!search) throw Error('Missing --search <name-or-id>'); output(await runSavedSearch(s,String(search)),flags); return; }
 if(group==='discover'&&action==='run-all'){ output(await runAllSearches(s),flags); return; }
 if(group==='score'){ if(!action) throw Error('Missing job id'); output(await score(s,action,needProfile(flags)),flags); return; }
 if(group==='tailor'&&action==='resume'){ if(!flags.job) throw Error('Missing --job'); const r=await tailor(s,flags.job,needProfile(flags),'resume'); if(flags.output==='markdown') console.log(fs.readFileSync(path.join(s.p.ws,r.path),'utf8')); else output(r,flags); return; }
 if(group==='tailor'&&action==='cover-letter'){ if(!flags.job) throw Error('Missing --job'); const r=await tailor(s,flags.job,needProfile(flags),'cover'); if(flags.output==='markdown') console.log(fs.readFileSync(path.join(s.p.ws,r.path),'utf8')); else output(r,flags); return; }
 if(group==='applications'&&action==='create'){ if(!flags.job||!flags.status) throw Error('Missing --job or --status'); const a=appCreate(s,flags.job,String(flags.status),flags.notes?String(flags.notes):''); output({id:a.id,jobId:a.job_id,profileId:a.profile_id,status:a.status},flags); return; }
 if(group==='applications'&&action==='update'){ if(!subaction||!flags.status) throw Error('Missing application id or --status'); const a=appUpdate(s,subaction,String(flags.status),flags.notes?String(flags.notes):null); output({id:a.id,jobId:a.job_id,profileId:a.profile_id,status:a.status},flags); return; }
 if(group==='research'&&action==='company'){ if(!flags.job) throw Error('Missing --job'); output(await research(s,flags.job,'company'),flags); return; }
 if(group==='research'&&action==='stakeholders'){ if(!flags.job) throw Error('Missing --job'); output(await research(s,flags.job,'stakeholders'),flags); return; }
 if(group==='outreach'&&action==='draft'){ if(!flags.job||!flags.stakeholder) throw Error('Missing --job or --stakeholder'); const r=draftOutreach(s,{jobId:flags.job,profileId:needProfile(flags),stakeholderId:flags.stakeholder,goal:flags.goal?String(flags.goal):'informational'}); output(r,flags); return; }
 if(group==='interview'&&action==='prep'){ if(!flags.application) throw Error('Missing --application'); const r=await prepInterview(s,String(flags.application),flags.stage?String(flags.stage):'interview'); if(flags.output==='markdown') console.log(fs.readFileSync(path.join(s.p.ws,r.path),'utf8')); else output(r,flags); return; }
	 if(group==='analytics'&&action==='funnel'){ const r=funnel(s,needProfile(flags),flags.since?Number(flags.since):30); if(flags.output==='markdown') console.log(renderFunnelMarkdown(r)); else output(r,flags); return; }
	 if(group==='tasks'&&action==='due'){ output(due(s).map(t=>({id:t.id,title:t.title,dueAt:t.due_at,priority:t.priority,status:t.status,jobId:t.job_id})),flags); return; }
	 if(group==='review'&&action==='weekly'){ const r=weekly(s,needProfile(flags)); if(flags.output==='markdown') console.log(r.content); else output({runId:r.runId,path:r.path},flags); return; }
	 if(group==='automation'&&action==='create'){ const name=subaction; if(!name) throw Error('Missing automation name'); const config=flags.config?JSON.parse(String(flags.config)):{}; const r=createAutomation(s,{name,actionId:String(flags.action||name),schedule:String(flags.schedule||''),profileId:flags.profile?String(flags.profile):null,enabled:Boolean(flags.enabled),config}); output(r,flags); return; }
	 if(group==='automation'&&action==='list'){ output(listAutomations(s),flags); return; }
	 if(group==='automation'&&action==='enable'){ if(!subaction) throw Error('Missing automation name'); output(setAutomationEnabled(s,subaction,true),flags); return; }
	 if(group==='automation'&&action==='disable'){ if(!subaction) throw Error('Missing automation name'); output(setAutomationEnabled(s,subaction,false),flags); return; }
	 if(group==='automation'&&action==='run'){ if(!subaction) throw Error('Missing automation name'); output(await runAutomationByName(s,subaction,{trigger:'manual'}),flags); return; }
	 if(group==='scheduler'&&action==='run-once'){ output(await runDueAutomations(s),flags); return; }
	 if(group==='scheduler'&&action==='status'){ output(await schedulerStatus(s),flags); return; }
	 if(group==='scheduler'&&action==='start'){ const interval=flags.interval?Number(flags.interval):60; console.log(`JobOS scheduler running every ${interval}s`); await startScheduler(s,{intervalSeconds:interval,onTick:r=>{ if(flags.json) console.log(JSON.stringify(r)); }}); return; }
	 if(group==='runs'&&action==='list'){ output(recentRuns(s,flags.limit?Number(flags.limit):25),flags); return; }
	 if(group==='mcp'){ startMcp(s); return; }
 if(group==='web'){ const port=flags.port?Number(flags.port):4317, host=flags.host?String(flags.host):'127.0.0.1'; const server=web(s,{port,host,onReady:()=>console.log(`JobOS dashboard running at http://${host}:${port}`)}); process.on('SIGTERM',()=>server.close(()=>process.exit(0))); process.on('SIGINT',()=>server.close(()=>process.exit(0))); return; }
 throw Error(`Unknown command: ${argv.join(' ')}`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{ const wantsJson=process.argv.includes('--json'); if(wantsJson) console.error(JSON.stringify({ok:false,error:e.message},null,2)); else console.error(`jobos: ${e.message}`); process.exitCode=1; });
