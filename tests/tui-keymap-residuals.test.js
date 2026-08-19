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

test('KEYMAP-13 SGR mouse presses route the frozen fixed grid without polluting the composer', async t => {
  const { tui } = await seeded(t);
  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.jobTab = 'job';
  tui.state.leftMode = 'jobs';
  tui.setInput('');
  // Frozen 140x42 cells: header mode segs, rail segs, pane tabs.
  tui.handleKey('[<0;124;1M', {});
  assert.equal(tui.state.headerMode, 'workspace', 'click on Workspace seg switches the header mode');
  tui.handleKey('[<0;137;1M', {});
  assert.equal(tui.state.headerMode, 'jobs', 'click on Jobs seg returns to the board');
  tui.handleKey('[<0;12;2M', {});
  assert.equal(tui.state.leftMode, 'new', 'click on the New rail seg selects New');
  tui.handleKey('[<0;36;2M', {});
  assert.equal(tui.state.leftMode, 'jobs', 'click on the Jobs rail seg selects Jobs');
  tui.handleKey('[<0;53;2M', {});
  assert.equal(tui.state.jobTab, 'job', 'click on the Job pane tab');
  tui.handleKey('[<0;63;2M', {});
  assert.equal(tui.state.jobTab, 'people', 'click on the People pane tab');
  tui.handleKey('[<0;73;2M', {});
  assert.equal(tui.state.jobTab, 'chat', 'click on the Chat pane tab');
  assert.equal(tui.state.input, '', 'no mouse bytes leaked into the composer input');
});

test('KEYMAP-14 mouse CSI never appends SGR bytes to composer input and releases are swallowed', async t => {
  const { tui } = await seeded(t);
  tui.state.jobTab = 'chat';
  tui.setInput('type me');
  tui.handleKey('[<0;124;1M', {});
  tui.handleKey('[<0;63;2M', {});
  tui.handleKey('[<0;12;2M', {});
  assert.equal(tui.state.input, 'type me', 'mouse bytes must never enter typed composer text');
  // Release (lowercase m) is a no-op: no routing, no typing pollution.
  const before = tui.state.headerMode;
  tui.handleKey('[<0;124;1m', {});
  assert.equal(tui.state.headerMode, before, 'release bytes do not route');
  assert.equal(tui.state.input, 'type me', 'release bytes do not pollute the input');
});

test('KEYMAP-15 headless start writes no mouse-mode escapes (snapshot byte-clean)', async t => {
  const { store, tui } = await seeded(t);
  const captured = [];
  const originalWrite = tui.options.stdout.write.bind(tui.options.stdout);
  tui.options.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalWrite(chunk, ...rest); };
  await tui.start();
  await tui.exit();
  const bytes = captured.join('');
  assert.doesNotMatch(bytes, /\x1b\[\?1000[hl]/, 'headless/non-TTY start must not write mouse-mode escapes');
  assert.doesNotMatch(bytes, /\x1b\[\?1006[hl]/, 'headless/non-TTY start must not write SGR-encoding escapes');
  const snapshot = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.doesNotMatch(snapshot, /\?1000[hl]|\?1006[hl]/, 'snapshot frame stays byte-clean of mouse-mode sequences');
});

test('KEYMAP-16 writeMouseSequences emits SGR enable/disable on the TTY stdout (no Ink mount)', async t => {
  // Do NOT call start() here: TTY start mounts a real Ink render() tree, which
  // is not what this unit asserts. We exercise writeMouseSequences directly so
  // the test stays synchronous and never leaks into a live Ink process.
  const { store } = await seeded(t);
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = true;
  const captured = [];
  stdout.on('data', chunk => captured.push(String(chunk)));
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false, width: 140, height: 42 });
  tui.options.stdout = stdout;

  tui._mouseEnabled = true;
  tui.writeMouseSequences('h');
  tui.writeMouseSequences('l');
  tui._mouseEnabled = false;

  const bytes = captured.join('');
  assert.match(bytes, /\x1b\[\?1000h/, 'enable emits ESC[?1000h (button-event mouse)');
  assert.match(bytes, /\x1b\[\?1006h/, 'enable emits ESC[?1006h (SGR mouse encoding)');
  assert.match(bytes, /\x1b\[\?1000l/, 'disable emits ESC[?1000l');
  assert.match(bytes, /\x1b\[\?1006l/, 'disable emits ESC[?1006l');
});

test('KEYMAP-17 n and j directly select the New and Jobs rail (distinct from g)', async t => {
  const { tui } = await seeded(t);
  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.leftMode = 'jobs';
  tui.handleKey('n', { name: 'n' });
  assert.equal(tui.state.leftMode, 'new', 'n selects the New rail directly');
  tui.handleKey('j', { name: 'j' });
  assert.equal(tui.state.leftMode, 'jobs', 'j selects the Jobs rail directly');
});

test('KEYMAP-18 n and j type in the composer and do not switch the rail', async t => {
  const { tui } = await seeded(t);
  tui.state.overlay = null;
  tui.state.jobTab = 'chat';
  tui.state.input = '';
  tui.handleKey('n', { name: 'n' });
  assert.equal(tui.state.input, 'n', 'composer n types');
  assert.equal(tui.state.leftMode, 'jobs', 'composer n does not switch the rail');
  tui.handleKey('j', { name: 'j' });
  assert.equal(tui.state.input, 'nj', 'composer j types');
  assert.equal(tui.state.leftMode, 'jobs', 'composer j does not switch the rail');
});

test('KEYMAP-19 tracker keys 1-4 select saved/researching/applied/waiting without mutating status', async t => {
  const { tui } = await seeded(t);
  tui.state.overlay = null;
  tui.state.jobTab = 'job';
  tui.openOverlay('tracker');
  const stages = [['1', 'saved'], ['2', 'researching'], ['3', 'applied'], ['4', 'waiting']];
  for (const [key, label] of stages) {
    tui.state.overlayIndex = 0;
    tui.handleKey(key, { name: key });
    assert.equal(tui.trackerSelectedRow()?.label, label, `key ${key} selects ${label}`);
  }
  assert.equal(tui.model?.selected?.job?.applicationStatus, 'saved', 'direct stage selection never mutates application status');
  assert.equal(tui.state.overlay, 'tracker', 'tracker overlay stays open');
});

test('KEYMAP-20 network i opens Edit intent and a fixed-grid click on the Edit-intent cell does the same', async t => {
  const { tui } = await seeded(t);
  tui.state.overlay = null;
  tui.openOverlay('network');
  tui.state.setupMode = null;
  tui.handleKey('i', { name: 'i' });
  assert.equal(tui.state.setupMode, 'network-intent', 'network i opens the Edit-intent input mode');
  tui.state.setupMode = null;
  tui.handleKey('[<0;55;22M', {});
  assert.equal(tui.state.setupMode, 'network-intent', 'click on the Edit-intent cell (55,22) opens the same input mode');
});

test('KEYMAP-21 /chat leaves an empty ready composer and a bare Enter runs no slash action', async t => {
  const { tui } = await seeded(t);
  const dispatched = [];
  const originalRunSlash = tui.runSlash.bind(tui);
  tui.runSlash = id => { dispatched.push(id); return originalRunSlash(id); };
  tui.createFiles = async () => false;

  tui.runSlash('chat');
  assert.equal(tui.state.jobTab, 'chat', '/chat opens this-job Chat');
  assert.equal(tui.state.input, '', '/chat must leave an empty, ready composer, not a slash query');
  dispatched.length = 0; // /chat itself invokes runSlash; only the bare Enter must not.

  // A bare Enter after /chat must not select the first catalog entry.
  tui.handleKey('', { name: 'return', return: true });
  assert.deepEqual(dispatched, [], 'bare Enter after /chat dispatches no slash action (create-files included)');
  assert.equal(tui.state.input, '', 'bare Enter after /chat keeps the composer empty');
});

test('KEYMAP-22 slash stays available-anywhere but a lone "/" Enter runs nothing and clears', async t => {
  const { tui } = await seeded(t);
  const dispatched = [];
  const originalRunSlash = tui.runSlash.bind(tui);
  tui.runSlash = id => { dispatched.push(id); return originalRunSlash(id); };
  tui.createFiles = async () => false;

  // slash-anywhere is preserved: typing "/" on the board opens the menu.
  tui.state.jobTab = 'job';
  tui.handleKey('/', { name: '/' });
  assert.equal(tui.state.jobTab, 'chat', '/ on Job jumps to Chat with the menu available');
  assert.equal(tui.state.input, '/', 'the slash menu is open with a lone slash');
  assert.ok(slashHits('/').some(item => item.id === 'create-files'), 'lone slash lists the full catalog');

  // A bare Enter on the lone "/" must not dispatch the first catalog entry.
  tui.handleKey('', { name: 'return', return: true });
  assert.deepEqual(dispatched, [], 'Enter on a lone "/" dispatches no slash action');
  assert.equal(tui.state.input, '', 'Enter on a lone "/" clears the slash to an empty ready composer');
});
