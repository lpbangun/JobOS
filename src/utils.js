import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const validStatuses = new Set(['saved','researching','materials-ready','applied','recruiter-screen','interview','offer','rejected','withdrawn','ghosted']);
export const jobStatuses = new Set(['imported','new','saved','archived']);
export const redFlags = ['unpaid','commission only','commission-only','no salary','equity only','1099 only','must pay','training fee'];
export function hash(s){ return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,12); }
export function id(prefix, seed){ return `${prefix}_${hash(seed)}`; }
export function slug(s){ return String(s||'').trim().toLowerCase().replace(/[\'\"]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'untitled'; }
export function now(){ return new Date().toISOString(); }
function workspaceHome({ env = process.env, home } = {}) {
  return path.resolve(home || env.HOME || os.homedir());
}

export function workspaceConfigPath(options = {}) {
  const env = options.env || process.env;
  const configRoot = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(workspaceHome(options), '.config');
  return path.join(configRoot, 'jobos', 'config.json');
}

export function readWorkspaceConfig(options = {}) {
  const file = options.configFile || workspaceConfigPath(options);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, config: null };
    throw error;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`Invalid JobOS config JSON: ${file}`), {
      code: 'workspace_config_invalid',
      type: 'validation',
      details: { configFile: file }
    });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.workspace !== undefined && (typeof config.workspace !== 'string' || !config.workspace.trim()))) {
    throw Object.assign(new Error(`Invalid JobOS workspace config: ${file}`), {
      code: 'workspace_config_invalid',
      type: 'validation',
      details: { configFile: file }
    });
  }
  return { file, config };
}

export function resolveWorkspace(options = {}) {
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const home = workspaceHome({ env, home: options.home });
  const defaultRoot = path.join(home, 'jobos-data');
  const configFile = options.configFile || workspaceConfigPath({ ...options, env, home });
  const explicitCandidates = [
    ['flag', options.workspace],
    ['env', env.JOBOS_HOME],
    ['internal_env', env.JOBOS_WORKSPACE]
  ];
  for (const [source, candidate] of explicitCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return { root: path.resolve(candidate), source, pinned: true, configFile, defaultRoot, cwd };
    }
  }
  const configured = readWorkspaceConfig({ ...options, env, home, configFile });
  if (configured.config?.workspace) {
    return {
      root: path.resolve(configured.config.workspace),
      source: 'config',
      pinned: true,
      configFile,
      defaultRoot,
      cwd
    };
  }
  if (fs.existsSync(path.join(cwd, '.jobos'))) {
    return { root: cwd, source: 'cwd_existing', pinned: false, configFile, defaultRoot, cwd };
  }
  return { root: defaultRoot, source: 'stable_default', pinned: false, configFile, defaultRoot, cwd };
}

export function workspaceRoot(flags = {}) {
  return resolveWorkspace(flags).root;
}

export function persistWorkspaceConfig(workspace, options = {}) {
  const root = path.resolve(workspace);
  const existing = readWorkspaceConfig(options);
  const config = { ...(existing.config || {}), workspace: root };
  fs.mkdirSync(path.dirname(existing.file), { recursive: true, mode: 0o700 });
  const temporary = `${existing.file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, existing.file);
  fs.chmodSync(existing.file, 0o600);
  return { file: existing.file, workspace: root };
}

function collectWorkspaceRoots(base, roots, maxEntries) {
  if (fs.existsSync(path.join(base, '.jobos'))) roots.add(path.resolve(base));
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.slice(0, maxEntries)) {
    if (!entry.isDirectory()) continue;
    const child = path.join(base, entry.name);
    if (fs.existsSync(path.join(child, '.jobos'))) roots.add(path.resolve(child));
  }
}

export function findNearbyWorkspaces({ root, cwd = process.cwd(), includeCwd = true, maxEntries = 256 } = {}) {
  const roots = new Set();
  const resolvedRoot = path.resolve(root);
  if (fs.existsSync(path.join(resolvedRoot, '.jobos'))) roots.add(resolvedRoot);
  // Multi-home footgun is cwd-relative: detect .jobos in cwd and sibling dirs under
  // cwd's parent. Do not walk the parent of an explicit/pinned root (e.g. /tmp tests).
  if (includeCwd) {
    const resolvedCwd = path.resolve(cwd);
    if (fs.existsSync(path.join(resolvedCwd, '.jobos'))) roots.add(resolvedCwd);
    const parent = path.dirname(resolvedCwd);
    if (parent !== resolvedCwd) collectWorkspaceRoots(parent, roots, maxEntries);
  }
  return [...roots].sort();
}
export function paths(r){ return { root:r, state:path.join(r,'.jobos'), db:path.join(r,'.jobos','jobos.sqlite'), ws:path.join(r,'jobos-workspace'), profiles:path.join(r,'jobos-workspace','profiles'), proofs:path.join(r,'jobos-workspace','proof-points'), jobs:path.join(r,'jobos-workspace','jobs'), searches:path.join(r,'jobos-workspace','searches'), watchlist:path.join(r,'jobos-workspace','watchlist'), discovery:path.join(r,'jobos-workspace','discovery'), exports:path.join(r,'jobos-workspace','exports'), automations:path.join(r,'jobos-workspace','automations') }; }
export function parseJson(s, fb){ try { return s ? JSON.parse(s) : fb; } catch { return fb; } }
export function tokenize(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').split(/\s+/).filter(t=>t.length>2 && !['the','and','with','for','you','our','are','will','this','that','from','your'].includes(t)); }
export function splitCsv(s){ return String(s||'').split(',').map(x=>x.trim()).filter(Boolean); }
