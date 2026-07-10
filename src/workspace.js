import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export function mkdirs(p){ for(const d of [p.state,p.ws,p.profiles,p.proofs,p.jobs,p.searches,p.watchlist,p.discovery,p.exports,p.automations]) fs.mkdirSync(d,{recursive:true}); }
export function writeYaml(file, value){ fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file, YAML.stringify(value,{lineWidth:0})); }
export function writeMd(file, value){ fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file, value.endsWith('\n') ? value : value+'\n'); }
export function ensureSchedulerDesign(p){ const scheduler=path.join(p.automations,'scheduler-design.json'); if(!fs.existsSync(scheduler)) fs.writeFileSync(scheduler, JSON.stringify({version:1,note:'Scheduler design. Configure automations via jobos automation commands.',jobs:[{id:'weekly-review',command:'jobos review weekly --profile <profile> --output markdown',schedule:'0 9 * * 5',externalSideEffects:'user_configured'},{id:'daily-discovery',command:'jobos jobs import-url <url> --profile <profile>',schedule:'0 7 * * 1-5',status:'design-only'}],policy:{autoApply:'user_configured',autoSend:'user_configured',defaultExternalActions:'user_configured'}},null,2)+'\n'); }
