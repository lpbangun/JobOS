import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findNearbyWorkspaces,
  persistWorkspaceConfig,
  resolveWorkspace,
  workspaceConfigPath,
  workspaceRoot
} from '../src/utils.js';

const cliPath = path.resolve('src/cli.js');

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('resolveWorkspace prefers flag, then JOBOS_HOME, then config, then cwd .jobos, then stable default', () => {
  const home = tempRoot('jobos-home-');
  const cwd = tempRoot('jobos-cwd-');
  const flagged = path.join(home, 'flagged');
  const envHome = path.join(home, 'env-home');
  const configDir = path.join(home, 'cfg');
  const configFile = path.join(configDir, 'jobos', 'config.json');
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ workspace: path.join(home, 'from-config') }, null, 2));

  const env = { HOME: home, XDG_CONFIG_HOME: configDir };

  assert.equal(
    resolveWorkspace({ workspace: flagged, cwd, env, home }).root,
    path.resolve(flagged)
  );
  assert.equal(
    resolveWorkspace({ cwd, env: { ...env, JOBOS_HOME: envHome }, home }).source,
    'env'
  );
  assert.deepEqual(
    resolveWorkspace({ cwd, env, home, configFile }),
    {
      root: path.resolve(path.join(home, 'from-config')),
      source: 'config',
      pinned: true,
      configFile,
      defaultRoot: path.join(home, 'jobos-data'),
      cwd: path.resolve(cwd)
    }
  );

  mkdirSync(path.join(cwd, '.jobos'));
  const existing = resolveWorkspace({
    cwd,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'empty-cfg') },
    home,
    configFile: path.join(home, 'empty-cfg', 'jobos', 'config.json')
  });
  assert.equal(existing.root, path.resolve(cwd));
  assert.equal(existing.source, 'cwd_existing');
  assert.equal(existing.pinned, false);

  const bareCwd = tempRoot('jobos-bare-');
  const stable = resolveWorkspace({
    cwd: bareCwd,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'empty-cfg-2') },
    home,
    configFile: path.join(home, 'empty-cfg-2', 'jobos', 'config.json')
  });
  assert.equal(stable.root, path.join(home, 'jobos-data'));
  assert.equal(stable.source, 'stable_default');
  assert.equal(stable.pinned, false);
  assert.equal(
    workspaceRoot({
      cwd: bareCwd,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'empty-cfg-2') },
      home,
      configFile: stable.configFile
    }),
    stable.root
  );

  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(bareCwd, { recursive: true, force: true });
});

test('persistWorkspaceConfig writes private user config and pins later resolution', () => {
  const home = tempRoot('jobos-persist-');
  const workspace = path.join(home, 'career');
  const configFile = workspaceConfigPath({ env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, home });
  const saved = persistWorkspaceConfig(workspace, {
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    home,
    configFile
  });
  assert.equal(saved.workspace, path.resolve(workspace));
  const parsed = JSON.parse(readFileSync(saved.file, 'utf8'));
  assert.equal(parsed.workspace, path.resolve(workspace));
  const resolved = resolveWorkspace({
    cwd: path.join(home, 'elsewhere'),
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    home,
    configFile: saved.file
  });
  assert.equal(resolved.root, path.resolve(workspace));
  assert.equal(resolved.pinned, true);
  assert.equal(resolved.source, 'config');
  rmSync(home, { recursive: true, force: true });
});

test('findNearbyWorkspaces reports sibling and parent .jobos trees', () => {
  const base = tempRoot('jobos-nearby-');
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  mkdirSync(path.join(a, '.jobos'), { recursive: true });
  mkdirSync(path.join(b, '.jobos'), { recursive: true });
  const found = findNearbyWorkspaces({ root: a, cwd: b, includeCwd: true });
  assert.deepEqual(found, [path.resolve(a), path.resolve(b)].sort());
  rmSync(base, { recursive: true, force: true });
});

test('setup status blocks workspace step until storage is pinned', t => {
  const home = tempRoot('jobos-setup-ws-');
  const configHome = path.join(home, '.config');
  const cwd = path.join(home, 'scratch');
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    JOBOS_HOME: '',
    JOBOS_WORKSPACE: ''
  };
  const status = spawnSync(process.execPath, [cliPath, 'setup', 'status', '--json'], {
    encoding: 'utf8',
    cwd,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  const setup = JSON.parse(status.stdout);
  const workspace = setup.steps.find(step => step.id === 'workspace');
  assert.equal(setup.workspace.status, 'needs_choice');
  assert.equal(setup.workspace.pinned, false);
  assert.equal(workspace.status, 'blocked');
  assert.ok(workspace.actions.some(action => action.id === 'use_default_workspace'));
  assert.equal(setup.workspace.root, path.join(home, 'jobos-data'));
});

test('jobos init --workspace persists config and prints absolute root', t => {
  const home = tempRoot('jobos-init-home-');
  const workspace = path.join(home, 'data');
  const configHome = path.join(home, '.config');
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [cliPath, 'init', '--workspace', workspace, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      JOBOS_HOME: '',
      JOBOS_WORKSPACE: ''
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.root, path.resolve(workspace));
  assert.equal(payload.workspaceResolution?.pinned, true);
  assert.match(result.stderr, new RegExp(`initialized workspace at ${path.resolve(workspace).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  const config = JSON.parse(readFileSync(path.join(configHome, 'jobos', 'config.json'), 'utf8'));
  assert.equal(config.workspace, path.resolve(workspace));

  const status2 = spawnSync(process.execPath, [cliPath, 'setup', 'status', '--json'], {
    encoding: 'utf8',
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      JOBOS_HOME: '',
      JOBOS_WORKSPACE: ''
    }
  });
  assert.equal(status2.status, 0, status2.stderr);
  const setup = JSON.parse(status2.stdout);
  assert.equal(setup.workspace.root, path.resolve(workspace));
  assert.equal(setup.workspace.pinned, true);
  assert.equal(setup.steps.find(step => step.id === 'workspace').status, 'complete');
});
