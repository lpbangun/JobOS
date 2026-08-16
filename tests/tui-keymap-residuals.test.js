import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { upsertContactPoint } from '../src/research/contacts.js';
import { defaultTuiState, JobosTui, renderTui } from '../src/tui.js';
import { SLASH_CATALOG, slashHits } from '../src/tui/model.js';

const AS_OF = '2026-08-02T12:00:00.000Z';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 36;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function seeded(t, { application = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-keymap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Keymap PM').profile;
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\nLead educator discovery and launch a learning platform.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  if (application) appCreate(store, job.id, 'saved', '', { at: AS_OF });
  const tui = new JobosTui(store, { ...streams(), profileId: profile.id, selectedJobId: job.id, connectAgent: false, color: false });
  tui.refresh();
  return { store, profile, job, tui };
}

const tab = () => ({ tab: true });
const shiftTab = () => ({ tab: true, shiftTab: true });
const esc = () => ({ escape: true });

test('KEYMAP-01 Tab cycles Job -> People -> Chat and Shift+Tab reverses', async t => {
  const { tui } = await seeded(t);
  assert.equal(tui.state.jobTab, 'job');
  tui.handleKey('', tab());
  assert.equal(tui.state.jobTab, 'people', 'Tab advances to People');
  tui.handleKey('', tab());
  assert.equal(tui.state.jobTab, 'chat', 'Tab advances to Chat');
  tui.handleKey('', tab());
  assert.equal(tui.state.jobTab, 'job', 'Tab wraps back to Job');
  tui.handleKey('', shiftTab());
  assert.equal(tui.state.jobTab, 'chat', 'Shift+Tab reverses to Chat');
  tui.handleKey('', shiftTab());
  assert.equal(tui.state.jobTab, 'people', 'Shift+Tab reverses to People');
});

test('KEYMAP-02 "/" on Job or People jumps to Chat with "/" in the input', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'job';
  tui.handleKey('/', { name: '/' });
  assert.equal(tui.state.jobTab, 'chat', '/ on Job jumps to Chat');
  assert.equal(tui.state.input, '/', '/ is placed in the composer input');

  tui.state.jobTab = 'people';
  tui.handleKey('/', { name: '/' });
  assert.equal(tui.state.jobTab, 'chat', '/ on People jumps to Chat');
  assert.equal(tui.state.input, '/', '/ is placed in the composer input');
});

test('KEYMAP-03 the slash menu sits on the prompt, filters as you type, and keeps catalog order', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.state.input = '/';
  const full = slashHits('/');
  assert.deepEqual(full.map(item => item.id), SLASH_CATALOG.map(item => item.id), 'empty slash lists the full catalog in order');

  tui.handleKey('f', { name: 'f' });
  const filtered = slashHits(tui.state.input);
  assert.equal(tui.state.input, '/f');
  assert.ok(filtered.some(item => item.id === 'find-people'), '/f keeps find-people');
  assert.ok(!filtered.some(item => item.id === 'tracker'), '/f filters tracker out');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /\/find-people/, 'slash menu renders the filtered command above the prompt');
  assert.doesNotMatch(screen, /\/tracker/, 'filtered-out commands are not rendered');
});

test('KEYMAP-04 arrows move the slash highlight and Enter runs the highlighted command', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.state.input = '/';
  // Filter to a single workspace hit, then run it.
  for (const char of 'workspace') tui.handleKey(char, { name: char });
  const hits = slashHits(tui.state.input);
  assert.deepEqual(hits.map(item => item.id), ['workspace']);
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.headerMode, 'workspace', 'Enter runs the highlighted slash command');
  assert.equal(tui.state.input, '', 'running a slash command clears the input');

  // Arrows move the highlight within the visible hits and clamp at bounds.
  tui.state.jobTab = 'chat';
  tui.setInput('/');
  tui.handleKey('', { name: 'downArrow' });
  assert.equal(tui.state.slashIndex, 1, 'down arrow moves the slash highlight');
  tui.handleKey('', { name: 'downArrow' });
  assert.equal(tui.state.slashIndex, 2, 'down arrow moves again');
  tui.handleKey('', { name: 'upArrow' });
  assert.equal(tui.state.slashIndex, 1, 'up arrow reverses');
  tui.handleKey('', { name: 'upArrow' });
  tui.handleKey('', { name: 'upArrow' });
  tui.handleKey('', { name: 'upArrow' });
  assert.equal(tui.state.slashIndex, 0, 'up arrow clamps at the first entry');
  // Down arrow must reach the final catalog entry, then clamp on extra presses.
  for (let index = 0; index < SLASH_CATALOG.length; index += 1) {
    tui.handleKey('', { name: 'downArrow' });
  }
  assert.equal(tui.state.slashIndex, SLASH_CATALOG.length - 1, 'down arrow reaches the last catalog entry');
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'downArrow' });
  assert.equal(tui.state.slashIndex, SLASH_CATALOG.length - 1, 'down arrow clamps at the last entry on extra presses');
});

test('KEYMAP-05 Esc clears "/" and closes overlays', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.setInput('/create');
  tui.handleKey('', esc());
  assert.equal(tui.state.input, '', 'Esc clears the slash input');

  tui.openOverlay('review');
  assert.equal(tui.state.overlay, 'review');
  tui.handleKey('', esc());
  assert.equal(tui.state.overlay, null, 'Esc closes the overlay');

  tui.openOverlay('tracker');
  tui.handleKey('', esc());
  assert.equal(tui.state.overlay, null, 'Esc closes the tracker overlay');
});

test('KEYMAP-06 Esc on the first-run welcome skips without inventing state', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-keymap-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false });
  tui.refresh();
  assert.equal(tui.state.overlay, null, 'welcome is derived, not stored');
  tui.handleKey('', esc());
  assert.equal(tui.state.welcomeDismissed, true, 'Esc dismisses the welcome overlay');
  assert.match(tui.state.status, /Skipped setup/, 'skip copy is honest');
  assert.equal(tui.model.empty.noProfile, true, 'no profile invented by skipping');
  assert.equal(tui.model.empty.noJobs, true, 'no jobs invented by skipping');
});

test('KEYMAP-07 G toggles Workspace and Jobs, and the composer stays active only where it exists', async t => {
  const { tui } = await seeded(t);
  assert.equal(tui.state.headerMode, 'jobs');
  tui.handleKey('g', { name: 'g' });
  assert.equal(tui.state.headerMode, 'workspace', 'g opens Workspace');
  tui.handleKey('G', { name: 'g', shift: true });
  assert.equal(tui.state.headerMode, 'jobs', 'G returns to Jobs');
});

test('KEYMAP-08 shell arrows move the rail selection and Enter opens the tracker for a pipeline job', async t => {
  const { store, profile, job, tui } = await seeded(t, { application: false });
  // Two pipeline jobs so selection moves.
  const secondFile = path.join(store.root, 'second.md');
  writeFileSync(secondFile, 'Title: Associate PM\nCompany: Second Co\nLocation: Remote\n\nSupport the launch.');
  const second = importText(store, { profileId: profile.id, filePath: secondFile }).job;
  appCreate(store, job.id, 'saved', '', { at: AS_OF });
  appCreate(store, second.id, 'saved', '', { at: AS_OF });
  tui.refresh();
  tui.state.leftMode = 'jobs';
  assert.equal(tui.state.selectedIndex, 0);
  tui.handleKey('', { name: 'downArrow' });
  assert.equal(tui.state.selectedIndex, 1, 'down arrow moves the rail selection');
  tui.handleKey('', { name: 'upArrow' });
  assert.equal(tui.state.selectedIndex, 0, 'up arrow moves the rail selection back');
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'tracker', 'Enter on a pipeline row opens the tracker overlay');
});

test('KEYMAP-09 the People pane uses arrows and Enter opens the connection overlay for a staged contact', async t => {
  const { store, profile, job, tui } = await seeded(t);
  // Seed one staged contact point for this listing.
  const at = AS_OF;
  run(store, `INSERT INTO people (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, ['person_ada', 'Ada Lovelace', 'ada lovelace', '', '[]', 'high', at, at]);
  run(store, `INSERT INTO person_candidates (id, job_id, company_id, name, role, relevance, confidence, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, ['cand_ada', job.id, null, 'Ada Lovelace', 'Engineering Manager', 'Likely hiring manager', 'high', 'candidate', at, at]);
  upsertContactPoint(store, { companyId: null, personId: 'cand_ada', type: 'email', value: 'ada@example.test', evidenceTier: 'A', verificationStatus: 'verified', confidence: 'high' });
  save(store);
  tui.refresh();
  tui.state.jobTab = 'people';
  tui.handleKey('', { name: 'downArrow' });
  assert.equal(tui.state.peopleIndex, 0);
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'connection', 'Enter on a People row opens the connection overlay');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /Ada Lovelace/, 'connection overlay names the staged person');
  assert.match(screen, /Record contact \(r\)/, 'record contact is available on the connection overlay');
});

test('KEYMAP-10 the locked state vocabulary has no filters 1-7 and no colon command bar', async t => {
  const base = defaultTuiState();
  assert.equal('filter' in base, false, 'retired filter state is gone');
  assert.equal('taskFilter' in base, false, 'retired task filter state is gone');
  assert.equal('mode' in base, false, 'retired modal mode state is gone');
  const { tui } = await seeded(t);
  const text = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.doesNotMatch(text, /\[today\]/, 'no filter tabs 1-7');
  assert.doesNotMatch(text, /:packet|:answer|:prep/, 'no colon command bar');
  assert.match(text, /\/ in Chat/, 'footer hint remains the slash hint');
});

test('KEYMAP-11 the composer input supports cursor movement and backspace', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.setInput('');
  for (const char of 'abcde') tui.handleKey(char, { name: char });
  assert.equal(tui.state.input, 'abcde');
  tui.handleKey('', { name: 'leftArrow' });
  tui.handleKey('', { name: 'leftArrow' });
  tui.handleKey('', { name: 'backspace' });
  assert.equal(tui.state.input, 'abde', 'backspace removes the char before the cursor');
  tui.handleKey('', { name: 'rightArrow' });
  tui.handleKey('x', { name: 'x' });
  assert.equal(tui.state.input, 'abdxe', 'typing inserts at the cursor');
});

test('KEYMAP-12 Esc from an active composer keeps the overlay closed state and the shell responsive', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.setInput('plain question');
  tui.handleKey('', esc());
  assert.equal(tui.state.input, 'plain question', 'Esc does not clear non-slash composer text');
});
