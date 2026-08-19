import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { JobosTui } from '../src/tui.js';

export const WIDTH = 140;
export const HEIGHT = 42;

function streams() {
  const stdout = new PassThrough();
  stdout.columns = WIDTH;
  stdout.rows = HEIGHT;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

export async function makeBenchTui() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-b10-'));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'B10 keyboard and pointer profile').profile;
  addProof(store, profile.id, 'Led a product launch used by 30 teams.', 'B10 local fixture', ['product'], ['30']);
  const jobs = [];
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(root, `job-${index}.md`);
    writeFileSync(file, `Title: Product Manager ${index + 1}\nCompany: B10 Company ${index + 1}\nLocation: Remote\n\nLead product discovery and launch reliable workflows.`);
    jobs.push(importText(store, { profileId: profile.id, filePath: file }).job);
  }
  appCreate(store, jobs[0].id, 'saved', '', { at: '2026-07-30T12:00:00.000Z' });
  appCreate(store, jobs[1].id, 'saved', '', { at: '2026-07-30T12:01:00.000Z' });
  const tui = new JobosTui(store, {
    ...streams(),
    profileId: profile.id,
    selectedJobId: jobs[0].id,
    connectAgent: false,
    color: false,
    width: WIDTH,
    height: HEIGHT
  });
  tui.refresh();
  tui.state.welcomeDismissed = true;
  tui.state.headerMode = 'jobs';
  tui.state.leftMode = 'jobs';
  tui.state.jobTab = 'job';
  tui.refresh();
  return {
    root,
    store,
    profile,
    jobs,
    tui,
    cleanup() {
      try { store.db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function click(tui, col, row, release = false) {
  const suffix = release ? 'm' : 'M';
  tui.handleKey(`[<0;${col};${row}${suffix}`, {});
}
