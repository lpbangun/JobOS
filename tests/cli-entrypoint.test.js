import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cliPath = path.resolve('src/cli.js');

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
