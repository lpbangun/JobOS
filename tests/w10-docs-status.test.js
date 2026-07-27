import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');
const progress = readFileSync('BUILD_PROGRESS.md', 'utf8');
const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

function section(document, heading) {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const rest = document.slice(start + heading.length);
  const next = rest.search(/^##(?:#)?\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('W10-DOCS-01 README states the shipped packet v2 and receipt contracts', () => {
  const packet = section(readme, '### Live form, immutable packet, and receipt bridge');
  assert.match(packet, /Packet v2/);
  assert.match(packet, /receiptState.*none.*attested.*confirmed/s);
  assert.match(packet, /uncertain.*creates no receipt.*cannot be replayed automatically/s);
});

test('W10-DOCS-02 README bounds MCP and ACP to mediated actions without human authority', () => {
  const mcp = section(readme, '### MCP parity');
  assert.match(mcp, /existing mediated inspection, configured fill, and configured submission path/);
  const authorityBoundaries = [/artifact approval/, /rejection/, /restricted answer/, /attestation/, /receipt confirmation/, /Career Memory transition/i];
  for (const authority of authorityBoundaries) {
    assert.match(mcp, authority, `missing authority boundary: ${authority}`);
  }
  assert.match(mcp, /omitted from the MCP catalog.*rejected at the service boundary/s);
});

test('W10-DOCS-03 README documents the Career Memory trust boundary', () => {
  const memory = section(readme, '## Career Memory');
  for (const contract of ['provenance', 'accepted', 'revoke', 'undo', 'profile isolation', 'private note']) {
    assert.match(memory, new RegExp(contract, 'i'), `missing Career Memory contract: ${contract}`);
  }
  assert.match(memory, /private note.*(?:excluded|never).*retrieval/s);
  assert.match(memory, /Only accepted rules may affect/);
});

test('W10-DOCS-04 build status separates shipped W08/W09 behavior from intentional deferrals', () => {
  assert.match(progress, /W08.*Career Memory/is);
  assert.match(progress, /W09.*guided setup/is);
  assert.match(progress, /packet v2.*receipt/is);
  assert.match(progress, /### Intentionally deferred/);
  assert.doesNotMatch(progress, /External MCP catalog now exposes 41/);
  assert.doesNotMatch(progress, /npm test`: \*\*368\/368 passed/);
  assert.doesNotMatch(`${readme}\n${progress}`, /(?:will|must|planned to) migrate[^\n]*MCP SDK/i);
});

test('W10-DOCS-05 quality workflow runs no-deploy W10 gates on Node 22 and always uploads evidence', () => {
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /run:\s*npm ci --ignore-scripts/);
  assert.match(workflow, /run:\s*npm run test:w10/);
  assert.match(workflow, /run:\s*npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /run:\s*npm run release:evidence/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /path:\s*\.tmp\/release-evidence/);
  assert.match(workflow, /run:\s*npm test\s*$/m);
  assert.doesNotMatch(workflow, /(?:deploy|publish|git push|npm version)/i);
  assert.equal(pkg.scripts['test:w10'], 'node --test --test-concurrency=1 tests/w10-golden.test.js tests/w10-security-release.test.js tests/w10-docs-status.test.js tests/w10-mcp-compatibility.test.js');
});
