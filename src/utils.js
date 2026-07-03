import crypto from 'node:crypto';
import path from 'node:path';

export const validStatuses = new Set(['saved','researching','materials-ready','applied','recruiter-screen','interview','offer','rejected','withdrawn','ghosted']);
export const redFlags = ['unpaid','commission only','commission-only','no salary','equity only','1099 only','must pay','training fee'];
export function hash(s){ return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,12); }
export function id(prefix, seed){ return `${prefix}_${hash(seed)}`; }
export function slug(s){ return String(s||'').trim().toLowerCase().replace(/[\'\"]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'untitled'; }
export function now(){ return new Date().toISOString(); }
export function workspaceRoot(flags={}){ return path.resolve(flags.workspace || process.env.JOBOS_HOME || process.cwd()); }
export function paths(r){ return { root:r, state:path.join(r,'.jobos'), db:path.join(r,'.jobos','jobos.sqlite'), ws:path.join(r,'jobos-workspace'), profiles:path.join(r,'jobos-workspace','profiles'), proofs:path.join(r,'jobos-workspace','proof-points'), jobs:path.join(r,'jobos-workspace','jobs'), exports:path.join(r,'jobos-workspace','exports'), automations:path.join(r,'jobos-workspace','automations') }; }
export function parseJson(s, fb){ try { return s ? JSON.parse(s) : fb; } catch { return fb; } }
export function tokenize(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').split(/\s+/).filter(t=>t.length>2 && !['the','and','with','for','you','our','are','will','this','that','from','your'].includes(t)); }
export function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function splitCsv(s){ return String(s||'').split(',').map(x=>x.trim()).filter(Boolean); }
