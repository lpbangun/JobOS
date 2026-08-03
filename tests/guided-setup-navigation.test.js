import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import {
  JobosTui,
  TUI_HANDLED_KEYS,
  TUI_KEYMAP,
  expandKeymapBinding,
  renderTui
} from '../src/tui.js';

const AS_OF = '2026-08-02T12:00:00.000Z';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-setup-navigation-'));
}

function output(width = 120, height = 36) {
  return { columns: width, rows: height, isTTY: false, write() {}, on() {}, off() {} };
}

async function emptyTui({ width = 120, height = 36 } = {}) {
  const store = await openStore({ workspace: workspace() });
  const stdout = output(width, height);
  const tui = new JobosTui(store, {
    stdout,
    connectAgent: false,
    now: () => new Date(AS_OF)
  });
  return { store, stdout, tui };
}

function screenOf(tui, width = 120, height = 36) {
  return renderTui(tui.model, tui.state, { width, height, color: false }).split('\n');
}

function typeText(tui, text) {
  tui.onKeypress(text, { name: 'paste' });
}

function enter(tui) {
  tui.onKeypress('', { name: 'return' });
}

// Resume text that parses with a verified identity and produces two
// achievement-style claims for proof review.
const RESUME_TEXT = [
  'Alex Chen',
  'alex@example.com',
  '+1 555 0100',
  '',
  '# Experience',
  'Senior Engineer | Acme Corp | Remote',
  '- Built a distributed scheduler that handles one million events daily',
  '- Led the migration of the deployment pipeline to cut release time in half'
].join('\n');

test('first-run setup is an isolated screen at 120x36 and 80x24 with the profile as the first actionable step and no dashboard bleed', async () => {
  for (const { width, height } of [{ width: 120, height: 36 }, { width: 80, height: 24 }]) {
    const { tui } = await emptyTui({ width, height });
    assert.equal(tui.state.overlay, 'setup', 'fresh store opens the guided setup workspace');
    assert.equal(
      tui.model.onboarding.steps[tui.state.overlayIndex].id,
      'profile',
      'setup starts focused on the first actionable blocker'
    );

    const lines = screenOf(tui, width, height);
    assert.equal(lines.length, height, 'setup workspace fills the terminal exactly');
    assert.ok(lines.every(line => stringWidth(line) <= width), 'no line overflows the terminal width');
    assert.ok(lines.some(line => line.includes('JOBOS  /  GUIDED SETUP')), 'setup header is present');
    assert.ok(lines.every(line => !line.includes('JOBS ·')), 'dashboard job list never bleeds into setup');
    assert.ok(lines.every(line => !line.includes('SELECTED JOB')), 'dashboard selected-job panel never bleeds into setup');
  }
});

test('arrows, j/k, tab, number jumps, and mouse clicks select setup steps and the resume-source picker', async () => {
  const { tui } = await emptyTui();
  const focusedId = () => tui.model.onboarding.steps[tui.state.overlayIndex]?.id;

  // Every advertised setup binding routes to a live handler.
  for (const [binding] of TUI_KEYMAP.setup) {
    for (const token of expandKeymapBinding(binding)) {
      assert.ok(TUI_HANDLED_KEYS.setup.includes(token), `${binding} expands to routed setup token ${token}`);
    }
  }

  tui.onKeypress('', { name: 'down' });
  assert.equal(focusedId(), 'resume');
  tui.onKeypress('', { name: 'up' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('', { name: 'up' });
  assert.equal(focusedId(), 'workspace');
  tui.onKeypress('j', { name: 'j' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('k', { name: 'k' });
  assert.equal(focusedId(), 'workspace');
  tui.onKeypress('', { name: 'tab' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('', { name: 'tab', shift: true });
  assert.equal(focusedId(), 'workspace');
  tui.onKeypress('3', { name: '3' });
  assert.equal(focusedId(), 'resume', '1–7 jumps to the numbered required step');
  tui.onKeypress('1', { name: '1' });
  assert.equal(focusedId(), 'workspace');

  // Mouse click on a setup row selects that step.
  tui.render();
  const lines = screenOf(tui);
  const clickRow = term => {
    const y = lines.findIndex(line => line.includes(term));
    assert.ok(y >= 0, `row for ${term} renders`);
    const x = lines[y].indexOf(term);
    return `\x1b[<0;${x + 1};${y + 1}M`;
  };
  tui.onMouseData(clickRow('About you'));
  assert.equal(focusedId(), 'profile', 'mouse press selects the clicked setup step');
  tui.onMouseData(clickRow('Workspace ready'));
  assert.equal(focusedId(), 'workspace');

  // The resume-source picker uses the same arrows and tabs.
  tui.beginSetupSource('resume');
  assert.equal(tui.state.overlay, 'setup-resume-source');
  tui.onKeypress('', { name: 'down' });
  assert.equal(tui.state.overlayIndex, 1);
  tui.onKeypress('', { name: 'tab' });
  assert.equal(tui.state.overlayIndex, 2);
  tui.onKeypress('k', { name: 'k' });
  assert.equal(tui.state.overlayIndex, 1);
  tui.onKeypress('', { name: 'tab', shift: true });
  assert.equal(tui.state.overlayIndex, 0);
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'setup');
});

test('profile creation auto-advances to resume and the resume source lists paste, browse, and path', async () => {
  const { store, tui } = await emptyTui();

  tui.onKeypress('3', { name: '3' });
  assert.equal(tui.state.overlayIndex, 2, '1–7 reaches resume while profile is missing');
  tui.onKeypress('1', { name: '1' });
  tui.onKeypress('', { name: 'down' });
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'profile');

  enter(tui);
  assert.equal(tui.state.mode, 'setup-profile', 'Enter on the profile step opens name capture');
  typeText(tui, 'Alex Chen');
  enter(tui);

  assert.equal(tui.state.mode, 'normal');
  assert.equal(tui.state.overlay, 'setup', 'profile creation returns to setup');
  const profile = createProfile(store, 'Alex Chen');
  assert.equal(tui.state.profileId, profile.profile.id, 'created profile becomes the workspace profile');
  assert.equal(tui.state.setupProfileId, profile.profile.id);
  const profileStep = tui.model.onboarding.steps.find(step => step.id === 'profile');
  assert.equal(profileStep.status, 'complete', 'profile step is complete after creation');
  assert.equal(
    tui.model.onboarding.steps[tui.state.overlayIndex].id,
    'resume',
    'focus auto-advances to the resume step'
  );

  enter(tui);
  assert.equal(tui.state.overlay, 'setup-resume-source', 'Enter on resume opens the source chooser');

  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-paste', 'first source choice is paste');
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'setup-resume-source');

  tui.onKeypress('j', { name: 'j' });
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-file-browser', 'second source choice browses the computer');
  assert.equal(tui.state.setupFilePurpose, 'resume');
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'setup-resume-source');

  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('j', { name: 'j' });
  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-path', 'third source choice enters a file path');
});

test('resume paste and path preview, supported-format guidance, import, and immediate proof review with verify/reject/add', async () => {
  const { store, tui } = await emptyTui();
  const focusedId = () => tui.model.onboarding.steps[tui.state.overlayIndex]?.id;
  const stepTo = id => {
    while (focusedId() !== id) tui.onKeypress('j', { name: 'j' });
  };

  // Create the profile, then open the resume source chooser.
  stepTo('profile');
  enter(tui);
  typeText(tui, 'Alex Chen');
  enter(tui);
  stepTo('resume');
  enter(tui);

  // Paste a resume and preview the extraction.
  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-paste');
  typeText(tui, RESUME_TEXT);
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-resume-preview');
  assert.equal(tui.state.setupResumePreview.document.identity.name, 'Alex Chen');
  assert.equal(tui.state.setupResumePreview.validation.valid, true);
  assert.ok(tui.state.setupResumePreview.claims.length >= 2, 'preview extracts achievement-style claims');
  tui.onKeypress('', { name: 'escape' });

  // Unsupported file types are rejected with guidance and the path input stays open.
  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('j', { name: 'j' });
  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-path');
  typeText(tui, path.join(workspace(), 'resume.pdf'));
  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-path', 'invalid path keeps the path input open');
  assert.ok(tui.state.error && /not supported/i.test(tui.state.error), 'unsupported format guidance is shown');
  assert.equal(tui.state.overlay, 'setup-resume-source');
  tui.onKeypress('', { name: 'escape' });

  // A supported path previews the same extraction.
  const resumeFile = path.join(store.root, 'resume.txt');
  writeFileSync(resumeFile, RESUME_TEXT, 'utf8');
  enter(tui);
  assert.equal(tui.state.mode, 'setup-resume-path');
  typeText(tui, resumeFile);
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-resume-preview');
  assert.equal(tui.state.setupResumePreview.document.identity.name, 'Alex Chen', 'path source previews the resume');

  // Confirming the import jumps straight into proof review with the extracted claims.
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-proof-review');
  assert.ok(tui.state.setupProofItems.length >= 2, 'imported claims are queued for human review');
  const rejectedBefore = tui.state.setupProofItems.length;

  // Verify the first claim.
  enter(tui);
  assert.equal(tui.state.setupProofItems[0].verification_status, 'verified', 'Enter verifies the selected highlight');

  // Reject the next claim and it leaves the review list.
  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('R', { name: 'r', shift: true });
  assert.equal(tui.state.setupProofItems.length, rejectedBefore - 1, 'rejected highlights are excluded');

  // Add a claim in the user's own words.
  tui.onKeypress('A', { name: 'a', shift: true });
  assert.equal(tui.state.mode, 'setup-proof');
  typeText(tui, 'Led quarterly planning | board deck');
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-proof-review');
  assert.ok(
    tui.state.setupProofItems.some(item => item.summary === 'Led quarterly planning'),
    'added highlight appears in the review list'
  );
});

test('input fields support cursor movement, Delete, Home/End, Shift selection, and replacement paste', async () => {
  const { tui } = await emptyTui();
  tui.state.mode = 'setup-profile';

  typeText(tui, 'abcde');
  assert.equal(tui.state.input, 'abcde');
  assert.equal(tui.state.inputCursor, 5);

  tui.onKeypress('', { name: 'left' });
  tui.onKeypress('', { name: 'left' });
  assert.equal(tui.state.inputCursor, 3);
  tui.onKeypress('', { name: 'backspace' });
  assert.equal(tui.state.input, 'abde', 'backspace removes the char before the cursor');
  assert.equal(tui.state.inputCursor, 2);
  tui.onKeypress('', { name: 'delete' });
  assert.equal(tui.state.input, 'abe', 'Delete removes the char at the cursor');

  tui.onKeypress('', { name: 'home' });
  assert.equal(tui.state.inputCursor, 0);
  tui.onKeypress('', { name: 'end' });
  assert.equal(tui.state.inputCursor, 3);

  tui.onKeypress('', { name: 'left', shift: true });
  tui.onKeypress('', { name: 'left', shift: true });
  assert.equal(tui.state.inputAnchor, 3, 'Shift movement establishes a selection anchor');
  assert.equal(tui.state.inputCursor, 1);
  typeText(tui, 'X');
  assert.equal(tui.state.input, 'aX', 'typing replaces the shift-selected range');
  assert.equal(tui.state.inputAnchor, null, 'replacement clears the selection');

  tui.onKeypress('a', { name: 'a', ctrl: true });
  assert.equal(tui.state.inputAnchor, 0);
  assert.equal(tui.state.inputCursor, 2);
  typeText(tui, 'YZ');
  assert.equal(tui.state.input, 'YZ', 'select-all followed by typing replaces the whole field');
  typeText(tui, '123');
  assert.equal(tui.state.input, 'YZ123', 'pasted text is inserted at the cursor');
  assert.equal(tui.state.inputCursor, 5);
});

test('contextual help opens first and render writes zero output for unchanged frames, line updates for changes', async () => {
  const { tui } = await emptyTui();

  // Contextual help is reachable from setup and returns to the same surface.
  tui.onKeypress('?', { name: '?' });
  assert.equal(tui.state.overlay, 'help');
  assert.equal(tui.state.helpContextOverlay, 'setup', 'help is contextual to the setup workspace');
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'setup', 'closing help returns to setup');

  const stdout = { columns: 120, rows: 36, isTTY: false, buffer: '', write(chunk) { this.buffer += chunk; }, on() {}, off() {} };
  const { store } = await emptyTui();
  const tui2 = new JobosTui(store, { stdout, connectAgent: false, now: () => new Date(AS_OF) });

  assert.equal(tui2.render(), true, 'first frame is a full paint');
  assert.ok(stdout.buffer.includes('\x1b[2J'), 'first frame clears the terminal');
  stdout.buffer = '';

  assert.equal(tui2.render(), false, 'unchanged frame renders nothing');
  assert.equal(stdout.buffer, '', 'unchanged frame writes zero bytes');

  tui2.onKeypress('j', { name: 'j' });
  assert.match(stdout.buffer, /\x1b\[\d+;1H\x1b\[2K/, 'changed frame emits line-level updates');
  assert.ok(!stdout.buffer.includes('\x1b[2J'), 'changed frame never full-clears');
  assert.ok(!stdout.buffer.includes('\x1b[H'), 'changed frame never re-homes the cursor');
  stdout.buffer = '';

  assert.equal(tui2.render(), false, 'post-update unchanged frame stays silent');
  assert.equal(stdout.buffer, '', 'no bytes written for a settled screen');
});
