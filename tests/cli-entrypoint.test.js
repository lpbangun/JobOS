import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cliPath = path.resolve('src/cli.js');
const packageVersion = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;

test('CLI prints the package version for long and short flags', () => {
  for (const flag of ['--version', '-V']) {
    const result = spawnSync(process.execPath, [cliPath, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${flag}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), packageVersion, flag);
    assert.equal(result.stderr, '', flag);
  }
});

test('CLI executes through the symlink shape created by npm bin', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-bin-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'jobos');
  symlinkSync(cliPath, link);
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Run `jobos` to open the primary terminal product/);
  assert.match(result.stdout, /jobos agents connect/);
});
