#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { openStore, run, save } from '../src/db.js';
import { importNormalized, syncJob } from '../src/jobs.js';
import { addProof, createProfile } from '../src/profiles.js';

const PROFILE_ID = 'w10-mcp-profile';
const JOB_ID = 'w10-mcp-job';
const FIXED_AT = '2026-07-27T12:00:00.000Z';

function parseArgs(argv) {
  let workspace = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--workspace') workspace = argv[++index];
    else if (argv[index] !== '--') throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!workspace) throw new Error('Missing --workspace <temporary-directory>');
  return { workspace: path.resolve(workspace) };
}

function assertTemporaryWorkspace(root) {
  const relativeToTemp = path.relative(path.resolve(tmpdir()), root);
  if (!relativeToTemp || relativeToTemp === '.' || relativeToTemp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTemp)) {
    throw new Error(`MCP demo seed requires a workspace beneath the system temporary directory: ${tmpdir()}`);
  }
  if (existsSync(path.join(root, '.jobos'))) throw new Error('MCP demo seed requires a fresh temporary workspace');
}

async function withFixedClock(fn) {
  const RealDate = globalThis.Date;
  const fixedMs = RealDate.parse(FIXED_AT);
  class FixedDate extends RealDate {
    constructor(...args) { super(args.length ? args[0] : fixedMs); }
    static now() { return fixedMs; }
    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
  }
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

export async function seedMcpDemo(workspace) {
  const root = path.resolve(workspace);
  assertTemporaryWorkspace(root);
  const store = await openStore({ workspace: root });
  try {
    await withFixedClock(async () => {
      const profile = createProfile(store, 'w10 mcp profile').profile;
      if (profile.id !== PROFILE_ID) throw new Error(`Unexpected deterministic profile ID: ${profile.id}`);
      addProof(
        store,
        PROFILE_ID,
        'Led a product discovery program and launched a workflow used by 30 teams.',
        'W10 deterministic MCP compatibility fixture',
        ['product', 'discovery', 'launch'],
        ['30']
      );
      const imported = importNormalized(store, {
        profileId: PROFILE_ID,
        source: 'w10_mcp_fixture',
        status: 'saved',
        job: {
          title: 'Product Manager',
          company: 'W10 MCP Company',
          location: 'Remote',
          url: 'https://jobs.example.test/w10-mcp-product-manager',
          source: 'w10_mcp_fixture',
          description: 'Lead product discovery and launch reliable workflows. Must have product discovery and stakeholder leadership experience.',
          postedDate: '2026-07-20',
          liveness: {
            contract: 'jobos.posting-liveness.v1',
            status: 'active',
            checkedAt: FIXED_AT,
            freshUntil: '2026-07-28T12:00:00.000Z',
            httpStatus: 200,
            reasonCodes: ['fixture_active'],
            evidence: [],
            source: 'w10_mcp_fixture'
          }
        }
      }).job;
      run(store, 'UPDATE jobs SET id=? WHERE id=?', [JOB_ID, imported.id]);
      run(store, 'UPDATE audit_log SET entity_id=? WHERE entity_type=? AND entity_id=?', [JOB_ID, 'job', imported.id]);
      rmSync(path.join(store.p.jobs, imported.id), { recursive: true, force: true });
      syncJob(store, JOB_ID);
      save(store);
    });
  } finally {
    store.db.close();
  }
  return { workspace: root, profileId: PROFILE_ID, jobId: JOB_ID };
}

async function main() {
  const { workspace } = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await seedMcpDemo(workspace))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`seed-mcp-demo: ${error.message}\n`);
    process.exitCode = 1;
  });
}
