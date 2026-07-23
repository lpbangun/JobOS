import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  normalizePrompt,
  normalizeFrameKey,
  normalizeTargetUrl,
  classifyFormField,
  buildFormFieldMap,
  semanticFieldMapProjection,
  buildFormSnapshot,
  formSnapshotFingerprint,
  formSnapshotCurrency,
  formatFormSnapshot,
  validateFormFieldMap,
  validateFormSnapshot,
  resolveFormBindings,
  persistFormSnapshot,
  getFormSnapshot
} from '../src/forms.js';
import {
  DOM_ADAPTER_MANIFEST,
  inspectApplicationFormOnPage,
  inspectLiveForm,
  validateAdapterManifest,
  validateRegisteredInspectionOutcome
} from '../src/form-browser.js';
import { assertPageAccessible } from '../src/browser.js';
import { startFormServer } from './fixtures/form-server.js';
import { commandRegistry } from '../src/cli.js';
import { seedW02Workspace } from './fixtures/w02-seed.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import {
  createApplicationPacket,
  showApplicationPacket,
  attestApplicationSubmitted,
  diffApplicationPackets
} from '../src/packets.js';
import { one, openStore, run, save } from '../src/db.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';
import {
  applyBoundFormFields,
  checkpointApplicationForm,
  fillApplicationForm,
  validateFormFillAuthorization
} from '../src/form-actions.js';
import { addAnswer } from '../src/answers.js';
import { submitApplicationForm } from '../src/form-submission.js';

const ADAPTER = { id: 'dom-v1', protocolVersion: 1, sourceHash: 'a'.repeat(64) };
const FRAME = { origin: 'https://boards.greenhouse.io', path: '/job', name: '', title: '', ordinal: 0 };

function sha256Of(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function baseFields() {
  return [
    {
      frame: FRAME,
      locator: { strategy: 'label', value: 'Email', ordinal: 0 },
      prompt: 'Email Address',
      control: 'email',
      required: true,
      multiple: false,
      atsFieldId: 'gh_email',
      options: [],
      classification: { category: 'contact', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' }
    },
    {
      frame: FRAME,
      locator: { strategy: 'label', value: 'First name', ordinal: 1 },
      prompt: 'First Name',
      control: 'text',
      required: true,
      multiple: false,
      atsFieldId: null,
      options: [],
      classification: { category: 'identity', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' }
    },
    {
      frame: FRAME,
      locator: { strategy: 'select', value: 'country', ordinal: 2 },
      prompt: 'Country',
      control: 'select-one',
      required: true,
      multiple: false,
      atsFieldId: 'gh_country',
      options: [
        { optionKey: 'us', label: 'United States', disabled: false },
        { optionKey: 'ca', label: 'Canada', disabled: false }
      ],
      classification: { category: 'contact', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' }
    }
  ];
}

function baseSnapshotInput(overrides = {}) {
  return {
    snapshotId: 'snap_1',
    jobId: 'job_1',
    profileId: 'prof_1',
    capturedAt: '2026-07-22T00:00:00.000Z',
    requestedUrl: 'https://boards.greenhouse.io/job?ref=linkedin',
    finalUrl: 'https://boards.greenhouse.io/job/app#section1',
    adapter: ADAPTER,
    selection: { frame: FRAME, formKey: 'form-0', candidateCount: 3, score: 12 },
    fields: baseFields(),
    warnings: [{ code: 'optional_unmatched', fieldKey: null, message: 'An optional field was unmatched' }],
    ...overrides
  };
}

function assertTyped(error, code) {
  return Boolean(error && error.code === code);
}
async function assertRejectCode(action, code) {
  // action may be a function (sync throw) or a thenable.
  let thunk = typeof action === 'function' ? action : () => action;
  await assert.rejects(async () => thunk(), error => assertTyped(error, code));
}

function workspaceContains(root, needle) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const name of readdirSync(current)) {
      const target = path.join(current, name);
      if (statSync(target).isDirectory()) pending.push(target);
      else if (readFileSync(target).includes(Buffer.from(needle))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WF02
// ---------------------------------------------------------------------------

test('WF02 form snapshot and field-map fingerprints are deterministic and semantic changes make them stale', async () => {
  const a = buildFormSnapshot(baseSnapshotInput());
  const b = buildFormSnapshot(baseSnapshotInput({ snapshotId: 'snap_2', capturedAt: '2026-08-01T00:00:00.000Z' }));

  // Deterministic: identical semantic content -> identical fingerprint despite id/time changes.
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, formSnapshotFingerprint(a));
  assert.ok(typeof a.fingerprint === 'string' && a.fingerprint.length === 64);

  // Semantic field-map projection excludes raw locator evidence.
  const proj = semanticFieldMapProjection(a.fieldMap);
  assert.ok(Array.isArray(proj));
  for (const f of proj) {
    assert.equal('locator' in f, false);
    assert.deepEqual(Object.keys(f).sort(), ['atsFieldId', 'classification', 'control', 'fieldKey', 'frameKey', 'multiple', 'options', 'prompt', 'questionFingerprint', 'required'].sort());
  }

  // fieldKey excludes locator and timestamps: differing only in locator keeps the same key.
  const mapOnlyLocator = buildFormFieldMap({
    fields: [
      { ...baseFields()[0], locator: { strategy: 'css', value: '#different', ordinal: 9 } }
    ]
  });
  const mapOriginal = buildFormFieldMap({ fields: [baseFields()[0]] });
  assert.equal(mapOnlyLocator.fields[0].fieldKey, mapOriginal.fields[0].fieldKey);

  // Semantic changes alter the fingerprint.
  const semChange = (fields) => buildFormSnapshot(baseSnapshotInput({ fields })).fingerprint;
  const base = a.fingerprint;

  assert.notEqual(semChange([{ ...baseFields()[0], prompt: 'Email Address 2' }, ...baseFields().slice(1)]), base);
  assert.notEqual(semChange([{ ...baseFields()[0], control: 'text' }, ...baseFields().slice(1)]), base);
  assert.notEqual(semChange([{ ...baseFields()[0], required: false }, ...baseFields().slice(1)]), base);
  assert.notEqual(semChange([
    { ...baseFields()[0], atsFieldId: 'gh_email_v2' }, ...baseFields().slice(1)
  ]), base);
  assert.notEqual(semChange([
    ...baseFields().slice(0, 2),
    {
      ...baseFields()[2],
      options: [{ optionKey: 'us', label: 'United States of America', disabled: false }]
    }
  ]), base);
  assert.notEqual(semChange([
    { ...baseFields()[0], frame: { ...FRAME, path: '/job/v2' } }, ...baseFields().slice(1)
  ]), base);

  // Non-semantic changes do NOT alter the fingerprint.
  assert.equal(
    buildFormSnapshot(baseSnapshotInput({
      requestedUrl: 'https://boards.greenhouse.io/job?ref=other',
      finalUrl: 'https://boards.greenhouse.io/job/app#other'
    })).fingerprint,
    base
  );
  assert.equal(
    buildFormSnapshot(baseSnapshotInput({
      warnings: [{ code: 'optional_unmatched', fieldKey: null, message: 'completely different prose' }]
    })).fingerprint,
    base
  );
  assert.equal(
    buildFormSnapshot(baseSnapshotInput({
      fields: [{ ...baseFields()[0], locator: { strategy: 'css', value: '#changed', ordinal: 7 } }, ...baseFields().slice(1)]
    })).fingerprint,
    base
  );

  // Currency compares version + fingerprint + adapter hash, not capture time or snapshot id.
  assert.equal(formSnapshotCurrency(a, b), 'current');
  const driftedAdapter = buildFormSnapshot(baseSnapshotInput({ adapter: { ...ADAPTER, sourceHash: 'b'.repeat(64) } }));
  assert.equal(formSnapshotCurrency(a, driftedAdapter), 'stale');
  assert.equal(formSnapshotCurrency(a, { version: a.version, fingerprint: a.fingerprint, adapter: { sourceHash: a.adapter.sourceHash } }), 'current');
  assert.equal(formSnapshotCurrency(a, { version: a.version, fingerprint: '0'.repeat(64), adapter: { sourceHash: a.adapter.sourceHash } }), 'stale');

  // Unknown future versions are rejected.
  await assertRejectCode(() => validateFormFieldMap({ version: 2, fields: [] }), 'form_contract_unsupported');
  await assertRejectCode(() => validateFormSnapshot({ version: 2, fieldMap: { version: 1, fields: [] } }), 'form_contract_unsupported');
});

// ---------------------------------------------------------------------------
// WF05
// ---------------------------------------------------------------------------

test('WF05 restricted demographic authorization and legal controls stay redacted and pause for human action', async () => {
  // Restricted categories force restricted + human pause, provenance hard-safety-rule.
  const demo = classifyFormField({ control: 'select-one', category: 'demographic' });
  assert.equal(demo.sensitivity, 'restricted');
  assert.equal(demo.handling, 'human-input');
  assert.equal(demo.provenance, 'hard-safety-rule');
  assert.equal(demo.autoFill, false);

  const auth = classifyFormField({ control: 'radio-group', category: 'work_authorization' });
  assert.equal(auth.sensitivity, 'restricted');
  assert.equal(auth.handling, 'human-input');
  assert.equal(auth.provenance, 'hard-safety-rule');

  const legal = classifyFormField({ control: 'checkbox', category: 'legal_attestation' });
  assert.equal(legal.sensitivity, 'restricted');
  assert.equal(legal.handling, 'human-action');
  assert.equal(legal.reasonCode, 'legal_consent');
  assert.equal(legal.provenance, 'hard-safety-rule');

  // Hard safety overrides adapter enrichment that tries to downgrade.
  const downgraded = classifyFormField({
    control: 'select-one',
    category: 'demographic',
    sensitivity: 'public',
    handling: 'auto-fill',
    reasonCode: 'safe_auto_fill',
    provenance: 'ats-adapter'
  });
  assert.equal(downgraded.sensitivity, 'restricted');
  assert.equal(downgraded.handling, 'human-input');
  assert.equal(downgraded.provenance, 'hard-safety-rule');

  const explicitRestricted = classifyFormField({
    prompt: 'Employee identifier',
    control: 'text',
    category: 'identity',
    sensitivity: 'restricted',
    handling: 'auto-fill',
    provenance: 'ats-adapter'
  });
  assert.equal(explicitRestricted.sensitivity, 'restricted');
  assert.equal(explicitRestricted.handling, 'human-input');
  assert.equal(explicitRestricted.autoFill, false);
  assert.equal(explicitRestricted.provenance, 'hard-safety-rule');

  // Signature / payment / password controls are restricted human actions.
  const sig = classifyFormField({ control: 'signature' });
  assert.equal(sig.sensitivity, 'restricted');
  assert.equal(sig.handling, 'human-action');
  assert.equal(sig.reasonCode, 'signature_required');

  const pay = classifyFormField({ control: 'payment' });
  assert.equal(pay.sensitivity, 'restricted');
  assert.equal(pay.handling, 'human-action');
  assert.equal(pay.reasonCode, 'payment_field');

  const pw = classifyFormField({ control: 'password' });
  assert.equal(pw.sensitivity, 'restricted');
  assert.equal(pw.handling, 'human-action');
  assert.equal(pw.reasonCode, 'password_field');

  // buildFormFieldMap stores these as control 'unsupported' with restricted handling.
  const map = buildFormFieldMap({
    fields: [
      { frame: FRAME, locator: { strategy: 'label', value: 'ssn', ordinal: 0 }, prompt: 'Social Security Number', control: 'text', required: true, multiple: false, options: [], classification: { category: 'identity', sensitivity: 'restricted', handling: 'human-input', reasonCode: 'identity_sensitive', provenance: 'dom' } },
      { frame: FRAME, locator: { strategy: 'label', value: 'auth', ordinal: 1 }, prompt: 'Are you authorized to work', control: 'radio-group', required: true, multiple: false, options: [], classification: { category: 'work_authorization', provenance: 'dom' } }
    ]
  });
  const restricted = map.fields.find(f => f.prompt === 'are you authorized to work');
  assert.equal(restricted.classification.sensitivity, 'restricted');
  assert.equal(restricted.classification.handling, 'human-input');
  assert.equal(restricted.classification.autoFill, false);
  const ssn = map.fields.find(f => f.prompt === 'social security number');
  assert.equal(ssn.classification.sensitivity, 'restricted');
  assert.equal(ssn.classification.handling, 'human-input');
  assert.equal(ssn.classification.autoFill, false);
  assert.equal(ssn.classification.provenance, 'hard-safety-rule');

  // No field value or secret appears in the secret-safe formatted snapshot.
  const snap = buildFormSnapshot(baseSnapshotInput({
    fields: [
      { frame: FRAME, locator: { strategy: 'label', value: 'ssn', ordinal: 0 }, prompt: 'Social Security Number', control: 'text', required: true, multiple: false, options: [], classification: { category: 'identity', sensitivity: 'restricted', handling: 'human-input', reasonCode: 'identity_sensitive', provenance: 'dom' } }
    ]
  }));
  const formatted = formatFormSnapshot(snap);
  const json = JSON.stringify(formatted);
  assert.equal(json.includes('value'), false);
  assert.equal(json.includes('answerText'), false);
  assert.equal(json.includes('locator'), false);
  for (const f of formatted.fields) {
    assert.equal('locator' in f, false);
    assert.equal('value' in f, false);
  }
});

// ---------------------------------------------------------------------------
// WF06
// ---------------------------------------------------------------------------

test('WF06 unsupported and inaccessible required controls remain explicit and cannot silently pass readiness', async () => {
  const contenteditable = classifyFormField({ control: 'contenteditable', prompt: 'Cover letter', required: true });
  assert.equal(contenteditable.handling, 'unsupported');
  assert.equal(contenteditable.reasonCode, 'unsupported_control');
  assert.equal(contenteditable.provenance, 'hard-safety-rule');
  assert.equal(contenteditable.autoFill, false);

  const customMultiselect = classifyFormField({ control: 'custom-multiselect', prompt: 'Skills', required: true });
  assert.equal(customMultiselect.handling, 'unsupported');
  assert.equal(customMultiselect.reasonCode, 'unsupported_control');

  const hidden = classifyFormField({ control: 'hidden', prompt: 'csrf', required: false });
  assert.equal(hidden.handling, 'unsupported');
  assert.equal(hidden.reasonCode, 'hidden_control');

  // An unsupported required control is stored as control 'unsupported' and stays explicit.
  const map = buildFormFieldMap({
    fields: [
      { frame: FRAME, locator: { strategy: 'css', value: '[contenteditable]', ordinal: 0 }, prompt: 'Cover letter', control: 'contenteditable', required: true, multiple: false, options: [], classification: { category: 'motivation', provenance: 'dom' } }
    ]
  });
  const field = map.fields[0];
  assert.equal(field.control, 'unsupported');
  assert.equal(field.classification.handling, 'unsupported');
  assert.equal(field.classification.reasonCode, 'unsupported_control');
  assert.equal(field.required, true);

  // It appears explicitly in the semantic projection (never silently dropped).
  const proj = semanticFieldMapProjection(map);
  assert.equal(proj.length, 1);
  assert.equal(proj[0].control, 'unsupported');
  assert.equal(proj[0].classification.handling, 'unsupported');

  // Sensitive (non-restricted) fields pause for human input rather than auto-fill.
  const sensitive = classifyFormField({ control: 'text', category: 'compensation', sensitivity: 'sensitive', handling: 'auto-fill', provenance: 'dom' });
  assert.equal(sensitive.handling, 'human-input');
  assert.equal(sensitive.autoFill, false);
});

// ---------------------------------------------------------------------------
// WF19
// ---------------------------------------------------------------------------

test('WF19 form values URL tokens checkpoint input and browser secrets never cross persisted or mediated surfaces', async () => {
  // URL userinfo is rejected with a typed error.
  await assertRejectCode(() => normalizeTargetUrl('https://user:secret@boards.io/job'), 'form_contract_unsupported');

  // Query and fragment are stripped; only normalized origin/path remain.
  const norm = normalizeTargetUrl('https://boards.io/job?token=shh&ref=ln#section1');
  assert.deepEqual(norm, { origin: 'https://boards.io', path: '/job' });
  assert.equal(JSON.stringify(norm).includes('token'), false);
  assert.equal(JSON.stringify(norm).includes('shh'), false);
  assert.equal(JSON.stringify(norm).includes('section1'), false);

  // buildFormSnapshot rejects userinfo in either requested or final URL.
  await assertRejectCode(() => buildFormSnapshot(baseSnapshotInput({ requestedUrl: 'https://user:secret@boards.io/job' })), 'form_contract_unsupported');
  await assertRejectCode(() => buildFormSnapshot(baseSnapshotInput({ finalUrl: 'https://user:secret@boards.io/job/app' })), 'form_contract_unsupported');

  // Query/fragment never reach the snapshot target or formatted output.
  const snap = buildFormSnapshot(baseSnapshotInput({
    requestedUrl: 'https://boards.greenhouse.io/job?token=SECRET_TOKEN&ref=ln#frag1',
    finalUrl: 'https://boards.greenhouse.io/job/app?session=SECRET_SESSION#sec'
  }));
  const formatted = formatFormSnapshot(snap);
  const json = JSON.stringify(formatted);
  assert.equal(json.includes('SECRET_TOKEN'), false);
  assert.equal(json.includes('SECRET_SESSION'), false);
  assert.equal(json.includes('token='), false);
  assert.equal(json.includes('session='), false);
  assert.equal(json.includes('#sec'), false);
  assert.equal(snap.target.requestedOrigin, 'https://boards.greenhouse.io');
  assert.equal(snap.target.requestedPath, '/job');
  assert.equal(snap.target.finalPath, '/job/app');

  // A sentinel secret placed in a locator value must not cross the semantic projection or formatted output.
  const sentinelMap = buildFormFieldMap({
    fields: [
      { frame: FRAME, locator: { strategy: 'css', value: 'input[name="SECRET_VALUE_123"]', ordinal: 0 }, prompt: 'Email', control: 'email', required: true, multiple: false, options: [], classification: { category: 'contact', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' } }
    ]
  });
  const sentinelProj = semanticFieldMapProjection(sentinelMap);
  assert.equal(JSON.stringify(sentinelProj).includes('SECRET_VALUE_123'), false);
  const sentinelSnap = buildFormSnapshot(baseSnapshotInput({ fields: sentinelMap.fields }));
  assert.equal(JSON.stringify(formatFormSnapshot(sentinelSnap)).includes('SECRET_VALUE_123'), false);

  // fieldKey is a hash of semantic identity, never a hash of a field value; no value hash appears.
  for (const f of semanticFieldMapProjection(snap.fieldMap)) {
    assert.equal('valueHash' in f, false);
    assert.equal('value' in f, false);
  }

  // Raw HTML in a prompt is normalized away (no tags/entities in prompt or formatted output).
  const htmlSnap = buildFormSnapshot(baseSnapshotInput({
    fields: [
      { frame: FRAME, locator: { strategy: 'label', value: 'x', ordinal: 0 }, prompt: '<script>alert(1)</script>Email', control: 'email', required: true, multiple: false, options: [], classification: { category: 'contact', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' } }
    ]
  }));
  const htmlJson = JSON.stringify(formatFormSnapshot(htmlSnap));
  assert.equal(htmlJson.includes('<script>'), false);
  assert.equal(htmlJson.includes('</script>'), false);
  assert.equal(htmlSnap.fieldMap.fields[0].prompt.includes('<'), false);

  // Warning prose never alters the fingerprint.
  const w1 = buildFormSnapshot(baseSnapshotInput({ warnings: [{ code: 'optional_unmatched', message: 'prose A' }] }));
  const w2 = buildFormSnapshot(baseSnapshotInput({ warnings: [{ code: 'optional_unmatched', message: 'prose B' }] }));
  assert.equal(w1.fingerprint, w2.fingerprint);
});

test('WF01 live inspection selects the richest application form across main and iframe documents', async t => {
  const { chromium } = await import('playwright');
  const fixture = await startFormServer(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(fixture.url('/application-host.html'));
  const snapshot = await inspectApplicationFormOnPage({
    page,
    requestedUrl: fixture.url('/application-host.html?secret=drop-me'),
    jobId: 'job-fixture',
    profileId: 'profile-fixture',
    snapshotId: 'snapshot-fixture',
    capturedAt: '2026-07-22T12:00:00.000Z'
  });
  assert.equal(snapshot.adapter.id, 'dom-v1');
  assert.equal(snapshot.adapter.sourceHash, DOM_ADAPTER_MANIFEST.sourceHash);
  assert.equal(snapshot.selection.candidateCount >= 1, true);
  assert.notEqual(snapshot.selection.frameKey, '');
  assert.equal(snapshot.fieldMap.fields.some(field => field.control === 'email'), true);
  assert.equal(snapshot.fieldMap.fields.some(field => field.control === 'file'), true);
  assert.equal(snapshot.fieldMap.fields.some(field => field.prompt.includes('search')), false);
  assert.equal(snapshot.target.requestedPath, '/application-host.html');
});

test('WF13 adapter hash drift is rejected before inspection fill submission and receipt handling', async t => {
  assert.throws(
    () => validateAdapterManifest(DOM_ADAPTER_MANIFEST, { expectedSourceHash: 'b'.repeat(64) }),
    error => error.code === 'adapter_hash_mismatch'
  );
  assert.equal(validateAdapterManifest(DOM_ADAPTER_MANIFEST, {
    expectedSourceHash: DOM_ADAPTER_MANIFEST.sourceHash
  }).sourceHash, DOM_ADAPTER_MANIFEST.sourceHash);
  assert.throws(() => validateRegisteredInspectionOutcome({
    finalUrl: 'https://apply.example.test/jobs/1',
    selection: { frameKey: 'main', formKey: 'app', candidateCount: 1, score: 4 },
    fields: [{ prompt: 'Email', control: 'email', value: 'must-never-cross' }]
  }, DOM_ADAPTER_MANIFEST, {
    requestedUrl: 'https://apply.example.test/jobs/1',
    jobId: 'job-1',
    profileId: 'profile-1'
  }), error => error.code === 'adapter_outcome_unsafe');

  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const frame = { url: f.snapshot.target.finalOrigin + f.snapshot.target.finalPath, name: '', title: '', ordinal: 0 };
  const drifted = buildFormSnapshot({
    snapshotId: `form_snapshot_${crypto.randomUUID()}`,
    jobId: f.job.id,
    profileId: f.profile.id,
    capturedAt: '2026-07-22T13:00:00.000Z',
    requestedUrl: frame.url,
    finalUrl: frame.url,
    adapter: { ...DOM_ADAPTER_MANIFEST, sourceHash: 'b'.repeat(64) },
    selection: { frame, formKey: 'form-0', candidateCount: 1, score: 12 },
    fields: f.snapshot.fieldMap.fields.map(field => ({ ...field, frame })),
    warnings: []
  });
  persistFormSnapshot(f.store, drifted);
  const readiness = compileApplicationReadiness(f.store, { jobId: f.job.id, profileId: f.profile.id });
  assert.equal(readiness.status, 'materials-ready');
  assert.equal(readiness.form.inspectionStatus, 'stale');
  assert.equal(showApplicationPacket(f.store, packet.id).currency, 'stale');
  assert.throws(
    () => createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' }),
    error => error.code === 'adapter_hash_mismatch'
  );
  let browserLaunches = 0;
  const playwright = { chromium: { launchPersistentContext: async () => { browserLaunches += 1; throw new Error('must not launch'); } } };
  await assert.rejects(() => fillApplicationForm(f.store, {
    packetId: packet.id,
    workspace: f.root,
    allowSideEffects: true,
    playwright
  }), error => error.code === 'packet_stale');
  await assert.rejects(() => submitApplicationForm(f.store, {
    packetId: packet.id,
    checkpointId: 'check_unused',
    workspace: f.root,
    allowSubmit: true,
    playwright
  }), error => error.code === 'packet_stale');
  assert.equal(browserLaunches, 0);
});

test('WF14 CAPTCHA and authentication recovery never bypass challenges and preserves pre-submit versus uncertain truth', async () => {
  const captchaPage = {
    url: () => 'https://apply.example.test/jobs/1',
    evaluate: async () => ({ captcha: true, loginForm: false, blockedText: false })
  };
  await assert.rejects(
    () => assertPageAccessible(captchaPage, { status: () => 200 }, 'fixture', new URL(captchaPage.url())),
    error => error.code === 'captcha' && error.recovery?.length > 0
  );
  const loginPage = {
    url: () => 'https://apply.example.test/login',
    evaluate: async () => ({ captcha: false, loginForm: true, blockedText: false })
  };
  await assert.rejects(
    () => assertPageAccessible(loginPage, { status: () => 200 }, 'fixture', new URL(loginPage.url())),
    error => error.code === 'auth_required' && error.recovery?.length > 0
  );
});

test('form inspection and snapshot reads are exposed through CLI and secret-safe domain tools', () => {
  const commands = new Set(commandRegistry.map(entry => entry.path.join(' ')));
  assert.equal(commands.has('apply form inspect'), true);
  assert.equal(commands.has('apply form show'), true);
  assert.equal(commands.has('apply form submit'), true);
  const tools = new Set(DOMAIN_TOOLS.map(entry => entry.name));
  assert.equal(tools.has('inspect_application_form'), true);
  assert.equal(tools.has('application_form_show'), true);
  assert.equal(tools.has('assist_application_form'), true);
  assert.equal(tools.has('checkpoint_application_form'), true);
  assert.equal(tools.has('submit_application_form'), true);
});

test('WF03 readiness is materials-ready before inspection and form-ready only after current field resolution', async t => {
  const uninspected = await seedW02Workspace(t, { withSnapshot: false });
  const before = compileApplicationReadiness(uninspected.store, { jobId: uninspected.job.id, profileId: uninspected.profile.id });
  assert.equal(before.version, 4);
  assert.equal(before.materialsStatus, 'approved');
  assert.equal(before.status, 'materials-ready');
  assert.equal(before.form.inspectionStatus, 'uninspected');
  assert.equal(before.application.status, 'researching');

  const inspected = await seedW02Workspace(t);
  const after = compileApplicationReadiness(inspected.store, { jobId: inspected.job.id, profileId: inspected.profile.id });
  assert.equal(after.status, 'form-ready');
  assert.equal(after.form.formReady, true);
  assert.equal(after.form.unresolvedFieldKeys.length, 0);
  assert.equal(after.application.status, 'researching');
});

test('WF04 live fields require exact answer and pinned W01 identity components while fuzzy suggestions never auto-fill', async t => {
  const f = await seedW02Workspace(t);
  const resolved = resolveFormBindings(f.store, { jobId: f.job.id, profileId: f.profile.id, snapshot: f.snapshot });
  const answer = resolved.bindings.find(binding => binding.mode === 'answer');
  assert.ok(answer);
  assert.ok(answer.answerId);
  assert.ok(answer.answerRowFingerprint);
  const identity = resolved.bindings.filter(binding => binding.mode === 'profile-identity');
  assert.equal(identity.length, 2);
  assert.equal(identity.every(binding => binding.profileResumeRevisionId === f.resumeRevision.id), true);
  run(f.store, "UPDATE answers SET question_fingerprint='why this role approximately' WHERE id=?", [answer.answerId]);
  save(f.store);
  const changed = resolveFormBindings(f.store, { jobId: f.job.id, profileId: f.profile.id, snapshot: f.snapshot });
  assert.equal(changed.bindings.some(binding => binding.fieldKey === answer.fieldKey && binding.mode === 'unresolved'), true);
});

test('WF07 a changed live form invalidates packet checkpoint and submission binding before external action', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const changed = buildFormSnapshot({
    snapshotId: `form_snapshot_${crypto.randomUUID()}`,
    jobId: f.job.id,
    profileId: f.profile.id,
    capturedAt: '2026-07-22T13:00:00.000Z',
    requestedUrl: 'https://apply.w02.test/jobs/1',
    finalUrl: 'https://apply.w02.test/jobs/1',
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, formKey: 'application', candidateCount: 1, score: 3 },
    fields: [{ frame: { url: 'https://apply.w02.test/jobs/1', ordinal: 0 }, locator: { strategy: 'name', value: 'email', ordinal: 0 }, prompt: 'Different required prompt', control: 'email', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } }]
  });
  const { persistFormSnapshot } = await import('../src/forms.js');
  persistFormSnapshot(f.store, changed);
  assert.equal(showApplicationPacket(f.store, packet.id).currency, 'stale');
});

test('WF08 changed materials identity or answers invalidate a form-bound packet before fill or submit', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const answer = one(f.store, "SELECT id FROM answers WHERE question_fingerprint='why this role'");
  run(f.store, "UPDATE answers SET updated_at='2026-07-22T14:00:00.000Z' WHERE id=?", [answer.id]);
  save(f.store);
  assert.equal(showApplicationPacket(f.store, packet.id).currency, 'stale');
});

test('WF09 packet v2 binds exact form fields materials answers and adapter hash idempotently', async t => {
  const f = await seedW02Workspace(t);
  const first = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const second = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  assert.equal(first.version, 2);
  assert.equal(second.id, first.id);
  assert.equal(second.idempotent, true);
  assert.equal(first.form.formFingerprint, f.snapshot.fingerprint);
  assert.equal(first.form.adapter.sourceHash, DOM_ADAPTER_MANIFEST.sourceHash);
  assert.equal(first.materials.resume.sourceResumeRevisionId, f.resumeRevision.id);
  assert.equal(first.form.bindings.some(binding => binding.mode === 'answer'), true);

  const identicalInspection = structuredClone(f.snapshot);
  identicalInspection.snapshotId = `form_snapshot_${crypto.randomUUID()}`;
  identicalInspection.capturedAt = '2026-07-22T13:00:00.000Z';
  persistFormSnapshot(f.store, identicalInspection);
  const afterReinspection = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  assert.equal(afterReinspection.id, first.id, 'snapshot evidence identity must not affect the packet hash');
  assert.equal(afterReinspection.contentHash, first.contentHash);

  const targetUrl = `${f.snapshot.target.finalOrigin}${f.snapshot.target.finalPath}`;
  const changedInspection = buildFormSnapshot({
    snapshotId: `form_snapshot_${crypto.randomUUID()}`,
    jobId: f.job.id,
    profileId: f.profile.id,
    capturedAt: '2026-07-22T14:00:00.000Z',
    requestedUrl: targetUrl,
    finalUrl: targetUrl,
    adapter: f.snapshot.adapter,
    selection: { ...f.snapshot.selection },
    fields: f.snapshot.fieldMap.fields.map((field, index) => ({
      frame: { url: targetUrl, name: '', title: '', ordinal: 0 },
      locator: field.locator,
      prompt: field.prompt,
      control: field.control,
      required: index === 0 ? !field.required : field.required,
      multiple: field.multiple,
      atsFieldId: field.atsFieldId,
      options: field.options,
      classification: field.classification
    })),
    warnings: []
  });
  persistFormSnapshot(f.store, changedInspection);
  const changedPacket = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const diff = diffApplicationPackets(f.store, first.id, changedPacket.id);
  assert.equal(diff.sameContent, false);
  assert.ok(diff.changes.some(change => change.path.startsWith('/form/')));
});

test('WF18 manual human submission observation and attestation remain packet-form-bound when configured submit is unused', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const result = attestApplicationSubmitted(f.store, {
    packetId: packet.id,
    submittedAt: '2026-07-22T15:00:00.000Z',
    source: 'cli',
    note: 'manual fixture'
  });
  assert.equal(result.externalSideEffects, 'none');
  assert.equal(result.submissionPerformed, false);
  assert.equal(result.receipt.formFingerprint, f.snapshot.fingerprint);
});

test('WF21 populated pre-W02 packet and receipt tables migrate intact and accept v2 constraints', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const attested = attestApplicationSubmitted(f.store, {
    packetId: packet.id,
    submittedAt: '2026-07-22T15:00:00.000Z',
    source: 'cli',
    note: 'legacy migration fixture'
  });
  run(f.store, `UPDATE application_packets
    SET readiness_status_at_create='approved',packet_version=1,
        form_snapshot_id=NULL,form_fingerprint=NULL,form_binding_json=NULL
    WHERE id=?`, [packet.id]);
  f.store.db.run('PRAGMA writable_schema=ON');
  f.store.db.run(`UPDATE sqlite_master SET sql=replace(
    sql,
    'CHECK(readiness_status_at_create IN (''approved'',''form-ready''))',
    'CHECK(readiness_status_at_create = ''approved'')'
  ) WHERE type='table' AND name='application_packets'`);
  f.store.db.run(`UPDATE sqlite_master SET sql=replace(
    replace(
      sql,
      'CHECK(source IN (''cli'',''tui'',''mcp'',''acp''))',
      'CHECK(source IN (''cli'',''tui''))'
    ),
    'CHECK(external_side_effect IN (''none'',''user_configured_form_submission''))',
    'CHECK(external_side_effect = ''none'')'
  ) WHERE type='table' AND name='application_receipts'`);
  f.store.db.run('PRAGMA writable_schema=OFF');
  save(f.store);
  f.store.db.close();

  const migrated = await openStore({ workspace: f.root });
  t.after(() => { try { migrated.db.close(); } catch {} });
  const legacy = showApplicationPacket(migrated, packet.id);
  assert.equal(legacy.currency, 'legacy-unbound');
  assert.equal(legacy.contentHash, packet.contentHash);
  assert.equal(one(migrated, 'SELECT receipt_hash FROM application_receipts WHERE id=?', [attested.receipt.id]).receipt_hash, attested.receipt.receiptHash);
  assert.throws(() => attestApplicationSubmitted(migrated, {
    packetId: packet.id,
    submittedAt: '2026-07-22T15:00:00.000Z',
    source: 'cli'
  }), error => error.code === 'legacy_packet_unbound');

  const current = createApplicationPacket(migrated, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  assert.equal(current.version, 2);
  assert.equal(current.readinessStatusAtCreate, 'form-ready');
  run(migrated, `INSERT INTO application_receipts (
    id,packet_id,application_id,type,submitted_at,recorded_at,external_reference,
    receipt_hash,source,external_side_effect,evidence_version,form_fingerprint,
    submission_actor,policy_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    `receipt_${crypto.randomUUID()}`, current.id, current.applicationId, 'adapter_receipt',
    '2026-07-22T16:00:00.000Z', '2026-07-22T16:00:00.000Z', 'EXT-W02-MIGRATION',
    crypto.createHash('sha256').update('w02-migrated-receipt').digest('hex'),
    'mcp', 'user_configured_form_submission', 2, current.form.formFingerprint,
    'configured_adapter', JSON.stringify({ migrated: true })
  ]);
  save(migrated);
  assert.equal(one(migrated, "SELECT external_side_effect FROM application_receipts WHERE packet_id=? AND type='adapter_receipt'", [current.id]).external_side_effect, 'user_configured_form_submission');
});

test('form fill policy requires configuration and explicit per-invocation side-effect consent', async t => {
  const f = await seedW02Workspace(t);
  const previous = process.env.JOBOS_FORM_FILL_ENABLED;
  delete process.env.JOBOS_FORM_FILL_ENABLED;
  try {
    assert.throws(() => validateFormFillAuthorization(f.store, {
      profileId: f.profile.id,
      allowSideEffects: true
    }), error => error.code === 'form_fill_not_enabled');
    process.env.JOBOS_FORM_FILL_ENABLED = '1';
    assert.throws(() => validateFormFillAuthorization(f.store, {
      profileId: f.profile.id,
      allowSideEffects: false
    }), error => error.code === 'form_fill_not_enabled');
    const policy = validateFormFillAuthorization(f.store, {
      profileId: f.profile.id,
      allowSideEffects: true
    });
    assert.equal(policy.externalSideEffects, 'user-configured-form-fill');
  } finally {
    if (previous === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED;
    else process.env.JOBOS_FORM_FILL_ENABLED = previous;
  }
});

test('WF12 checkpoint approval requires trusted human confirmation of every manual required field', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const fillRunId = `fill_${crypto.randomUUID().replaceAll('-', '')}`;
  run(f.store, 'INSERT INTO form_fill_runs VALUES (?,?,?,?,?,?,?)', [
    fillRunId,
    packet.id,
    packet.form.formFingerprint,
    JSON.stringify(packet.form.adapter),
    'checkpoint-required',
    JSON.stringify(packet.form.bindings.map(binding => ({
      fieldKey: binding.fieldKey,
      status: binding.autoFill ? 'equal' : 'present-human',
      reasonCode: binding.reasonCode
    }))),
    '2026-07-22T15:00:00.000Z'
  ]);
  save(f.store);
  assert.throws(() => checkpointApplicationForm(f.store, {
    packetId: packet.id,
    fillRunId,
    confirmedFieldKeys: [],
    source: 'cli'
  }), error => error.code === 'human_checkpoint_incomplete');
  const accepted = checkpointApplicationForm(f.store, {
    packetId: packet.id,
    fillRunId,
    confirmedFieldKeys: packet.form.humanActionFieldKeys,
    source: 'cli'
  });
  assert.match(accepted.checkpointHash, /^[a-f0-9]{64}$/);
  assert.equal(accepted.idempotent, false);
  assert.equal(checkpointApplicationForm(f.store, {
    packetId: packet.id,
    fillRunId,
    confirmedFieldKeys: packet.form.humanActionFieldKeys,
    source: 'cli'
  }).idempotent, true);
  const persisted = one(f.store, 'SELECT * FROM human_checkpoints WHERE id=?', [accepted.checkpointId]);
  assert.equal(JSON.stringify(persisted).includes('answer_text'), false);
  assert.equal(JSON.stringify(persisted).includes('browser secret'), false);
});

test('WF20 MCP and ACP form actions default off and run only when mediated and action-specific gates are configured', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const previousFill = process.env.JOBOS_FORM_FILL_ENABLED;
  const previousAgent = process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED;
  process.env.JOBOS_FORM_FILL_ENABLED = '1';
  delete process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED;
  try {
    await assert.rejects(() => callDomainTool(f.store, 'assist_application_form', {
      packetId: packet.id,
      allowSideEffects: true
    }, { source: 'mcp' }), error => error.code === 'agent_form_invocation_not_enabled');
    await assert.rejects(() => callDomainTool(f.store, 'checkpoint_application_form', {
      packetId: packet.id,
      fillRunId: 'fill_missing',
      confirmedFieldKeys: []
    }, { source: 'mcp' }), error => error.code === 'human_checkpoint_required');
    process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = '1';
    delete process.env.JOBOS_FORM_FILL_ENABLED;
    await assert.rejects(() => callDomainTool(f.store, 'assist_application_form', {
      packetId: packet.id,
      allowSideEffects: true
    }, { source: 'mcp' }), error => error.code === 'form_fill_not_enabled');
    assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM form_fill_runs').count, 0);
  } finally {
    if (previousFill === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED;
    else process.env.JOBOS_FORM_FILL_ENABLED = previousFill;
    if (previousAgent === undefined) delete process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED;
    else process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = previousAgent;
  }
});

test('WF10 assist requires configured and per-run fill enablement then fills supported controls only', async t => {
  const f = await seedW02Workspace(t);
  const server = await startFormServer(t);
  for (const [question, answer] of [
    ['Preferred role', 'Engineer'],
    ['Work arrangement', 'Remote']
  ]) {
    addAnswer(f.store, {
      profileId: f.profile.id,
      category: 'other',
      question,
      answer,
      sensitivity: 'public',
      reuseScope: 'global',
      verificationStatus: 'verified',
      sourceRef: 'localhost-fill-fixture'
    });
  }
  await inspectLiveForm(f.store, {
    jobId: f.job.id,
    profileId: f.profile.id,
    url: server.url('/application-frame.html'),
    browserProfile: 'fill-acceptance'
  });
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const previous = process.env.JOBOS_FORM_FILL_ENABLED;
  process.env.JOBOS_FORM_FILL_ENABLED = '1';
  try {
    const result = await callDomainTool(f.store, 'assist_application_form', {
      packetId: packet.id,
      browserProfile: 'fill-acceptance',
      allowSideEffects: true
    }, { source: 'cli' });
    assert.equal(result.status, 'checkpoint-required');
    assert.equal(result.readback.some(item => item.status === 'diverged' || item.status === 'failed'), false);
    assert.ok(result.readback.some(item => item.status === 'equal'));
    assert.ok(result.humanActionFieldKeys.length >= 1);
    assert.equal(server.state.submits, 0);
    const stored = one(f.store, 'SELECT readback_json FROM form_fill_runs WHERE id=?', [result.fillRunId]);
    assert.equal(stored.readback_json.includes('Engineer'), false);
    assert.equal(stored.readback_json.includes('Remote'), false);
    writeFileSync(path.join(f.store.p.ws, f.resume.path), '# tampered packet material\n');
    await assert.rejects(() => callDomainTool(f.store, 'assist_application_form', {
      packetId: packet.id,
      browserProfile: 'fill-acceptance',
      allowSideEffects: true
    }, { source: 'cli' }), error => error.code === 'artifact_mirror_diverged');
    assert.equal(server.state.submits, 0);
  } finally {
    if (previous === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED;
    else process.env.JOBOS_FORM_FILL_ENABLED = previous;
  }
});

test('WF11 read-back divergence records field statuses without persisting values and blocks checkpoint', async t => {
  const f = await seedW02Workspace(t);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const fillRunId = `fill_${crypto.randomUUID().replaceAll('-', '')}`;
  const readback = [{ fieldKey: packet.form.bindings[0].fieldKey, status: 'diverged', reasonCode: 'readback_mismatch' }];
  run(f.store, 'INSERT INTO form_fill_runs VALUES (?,?,?,?,?,?,?)', [
    fillRunId,
    packet.id,
    packet.form.formFingerprint,
    JSON.stringify(packet.form.adapter),
    'diverged',
    JSON.stringify(readback),
    '2026-07-22T15:00:00.000Z'
  ]);
  save(f.store);
  assert.throws(() => checkpointApplicationForm(f.store, {
    packetId: packet.id,
    fillRunId,
    confirmedFieldKeys: packet.form.humanActionFieldKeys,
    source: 'cli'
  }), error => error.code === 'checkpoint_stale');
  const stored = one(f.store, 'SELECT readback_json FROM form_fill_runs WHERE id=?', [fillRunId]);
  assert.deepEqual(JSON.parse(stored.readback_json), readback);
});

async function configuredSubmissionFixture(t, fixturePath = '/application-configured.html') {
  const f = await seedW02Workspace(t);
  const server = await startFormServer(t);
  const browserProfile = `submit-${crypto.randomUUID().slice(0, 8)}`;
  await inspectLiveForm(f.store, {
    jobId: f.job.id,
    profileId: f.profile.id,
    url: server.url(fixturePath),
    browserProfile
  });
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  const previousFill = process.env.JOBOS_FORM_FILL_ENABLED;
  process.env.JOBOS_FORM_FILL_ENABLED = '1';
  t.after(() => {
    if (previousFill === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED;
    else process.env.JOBOS_FORM_FILL_ENABLED = previousFill;
  });
  const fill = await fillApplicationForm(f.store, {
    packetId: packet.id,
    workspace: f.root,
    browserProfile,
    allowSideEffects: true,
    adapterManifest: DOM_ADAPTER_MANIFEST
  });
  const checkpoint = checkpointApplicationForm(f.store, {
    packetId: packet.id,
    fillRunId: fill.fillRunId,
    confirmedFieldKeys: fill.humanActionFieldKeys,
    source: 'cli'
  });
  return { ...f, server, browserProfile, packet, fill, checkpoint };
}

test('W02 direct callers cannot override the packet-frozen adapter identity', async t => {
  const f = await configuredSubmissionFixture(t);
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  t.after(() => {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  });

  let browserLaunches = 0;
  const noLaunchPlaywright = {
    chromium: {
      launchPersistentContext: async () => {
        browserLaunches += 1;
        throw new Error('adapter mismatch must reject before browser launch');
      }
    }
  };
  const packetHash = f.packet.form.adapter.sourceHash;
  const replacements = [
    {
      manifest: { ...DOM_ADAPTER_MANIFEST, sourceHash: 'b'.repeat(64) },
      expectedHash: 'b'.repeat(64),
      errorCode: 'adapter_hash_mismatch'
    },
    {
      manifest: { ...DOM_ADAPTER_MANIFEST, id: 'replacement-dom-v1' },
      expectedHash: packetHash,
      errorCode: 'adapter_id_mismatch'
    },
    {
      manifest: { ...DOM_ADAPTER_MANIFEST, protocolVersion: 2 },
      expectedHash: packetHash,
      errorCode: 'adapter_protocol_mismatch'
    }
  ];

  for (const replacement of replacements) {
    await assert.rejects(() => fillApplicationForm(f.store, {
      packetId: f.packet.id,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSideEffects: true,
      adapterManifest: replacement.manifest,
      expectedAdapterHash: replacement.expectedHash,
      playwright: noLaunchPlaywright
    }), error => error.code === replacement.errorCode);
    await assert.rejects(() => submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true,
      adapterManifest: replacement.manifest,
      expectedAdapterHash: replacement.expectedHash,
      playwright: noLaunchPlaywright
    }), error => error.code === replacement.errorCode);
  }

  assert.equal(browserLaunches, 0);
  assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM form_submission_attempts').count, 0);
  const fill = await fillApplicationForm(f.store, {
    packetId: f.packet.id,
    workspace: f.root,
    browserProfile: f.browserProfile,
    allowSideEffects: true,
    adapterManifest: DOM_ADAPTER_MANIFEST,
    expectedAdapterHash: packetHash
  });
  assert.equal(fill.status, 'checkpoint-required');
  const submission = await submitApplicationForm(f.store, {
    packetId: f.packet.id,
    checkpointId: f.checkpoint.checkpointId,
    workspace: f.root,
    browserProfile: f.browserProfile,
    allowSubmit: true,
    adapterManifest: DOM_ADAPTER_MANIFEST,
    expectedAdapterHash: packetHash
  });
  assert.equal(submission.status, 'confirmed');
  assert.equal(f.server.state.submits, 1);
});

test('WF15 configured submission requires separate enablement per-run allow-submit and exact current checkpoint binding', async t => {
  const f = await configuredSubmissionFixture(t);
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
  try {
    await assert.rejects(() => submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    }), error => error.code === 'form_submission_not_enabled');
    process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
    await assert.rejects(() => submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: false
    }), error => error.code === 'form_submission_not_enabled');
    assert.equal(f.server.state.submits, 0);
    assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM form_submission_attempts').count, 0);
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('WF16 submission idempotency returns confirmed evidence and blocks armed uncertain or duplicate replay', async t => {
  const f = await configuredSubmissionFixture(t);
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    const first = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    });
    const second = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    });
    assert.equal(first.status, 'confirmed');
    assert.equal(second.idempotent, true);
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(f.server.state.submits, 1);
    assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM application_receipts').count, 1);
    const nextPacket = createApplicationPacket(f.store, {
      jobId: f.job.id,
      profileId: f.profile.id,
      createdBy: 'cli'
    });
    assert.equal(nextPacket.idempotent, false);
    assert.equal(nextPacket.attemptNumber, f.packet.attemptNumber + 1);
    assert.equal(nextPacket.revision, 1);
    assert.equal(nextPacket.supersedesPacketId, f.packet.id);
    assert.throws(() => attestApplicationSubmitted(f.store, {
      packetId: f.packet.id,
      submittedAt: '2026-07-22T16:00:00.000Z',
      source: 'cli',
      note: 'must not duplicate configured evidence'
    }), error => error.code === 'packet_already_submitted' && error.details?.idempotent === true);
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('WF17 configured submission confirms only with structured receipt and records ambiguous post-submit state as uncertain', async t => {
  const f = await configuredSubmissionFixture(t, '/application-uncertain.html');
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    const result = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.submissionPerformed, null);
    assert.equal(result.externalSideEffects, 'user_configured_form_submission');
    assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM application_receipts').count, 0);
    assert.notEqual(one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status, 'applied');
    await assert.rejects(() => submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    }), error => error.code === 'submission_replay_blocked');
    assert.equal(f.server.state.submits, 1);
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('WF22 localhost manual bridge completes inspect freeze fill read-back checkpoint human-submit and receipt handoff', async t => {
  const f = await configuredSubmissionFixture(t);
  const response = await fetch(`${f.server.baseUrl}/submit/application?outcome=confirmed`, { method: 'POST' });
  assert.equal(response.ok, true);
  const attested = attestApplicationSubmitted(f.store, {
    packetId: f.packet.id,
    submittedAt: '2026-07-22T15:00:00.000Z',
    source: 'cli',
    note: 'Local human fixture submit'
  });
  assert.equal(attested.submissionPerformed, false);
  assert.equal(attested.externalSideEffects, 'none');
  assert.equal(attested.receipt.checkpointId, null);
  assert.equal(f.server.state.submits, 1);
});

test('WF23 localhost configured bridge submits once records external side effects and returns confirmed or honest uncertain evidence', async t => {
  const f = await configuredSubmissionFixture(t);
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  const previousAgent = process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = '1';
  try {
    const result = await callDomainTool(f.store, 'submit_application_form', {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      browserProfile: f.browserProfile,
      allowSubmit: true
    }, { source: 'mcp' });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.submissionPerformed, true);
    assert.equal(result.externalSideEffects, 'user_configured_form_submission');
    assert.equal(result.receipt.submissionActor, 'configured_adapter');
    assert.equal(result.receipt.checkpointId, f.checkpoint.checkpointId);
    assert.equal(f.server.state.submits, 1);
    assert.equal(showApplicationPacket(f.store, f.packet.id).receiptState, 'confirmed');
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
    if (previousAgent === undefined) delete process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED;
    else process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = previousAgent;
  }
});

test('W02 packet upload uses exact frozen PDF bytes and refuses mutation before file attachment', async t => {
  const f = await seedW02Workspace(t, { withSnapshot: false });
  const server = await startFormServer(t);
  for (const [question, answer] of [
    ['Preferred role', 'Engineer'],
    ['Work arrangement', 'Remote']
  ]) {
    addAnswer(f.store, {
      profileId: f.profile.id,
      category: 'other',
      question,
      answer,
      sensitivity: 'public',
      reuseScope: 'global',
      verificationStatus: 'verified',
      sourceRef: 'pdf-upload-regression'
    });
  }
  await inspectLiveForm(f.store, {
    jobId: f.job.id,
    profileId: f.profile.id,
    url: server.url('/application-frame.html'),
    browserProfile: 'pdf-freeze'
  });
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  assert.equal(packet.materials.resume.pdfPath, f.resumePdfPath);
  assert.equal(packet.materials.resume.pdfHash, f.resumePdfHash);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url('/application-frame.html'));
  const inspected = await inspectApplicationFormOnPage({
    page,
    requestedUrl: server.url('/application-frame.html'),
    jobId: f.job.id,
    profileId: f.profile.id
  });
  const readback = await applyBoundFormFields(f.store, page, packet, inspected);
  assert.equal(readback.some(item => item.status === 'failed' || item.status === 'diverged'), false);
  let upload = null;
  for (const frame of page.frames()) {
    const locator = frame.locator('input[type="file"]').first();
    if (await locator.count()) {
      upload = await locator.evaluate(async input => {
        const file = input.files?.[0];
        if (!file) return null;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          name: file.name,
          type: file.type,
          hash: [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
        };
      });
      break;
    }
  }
  assert.deepEqual(upload, {
    name: path.basename(f.resumePdfPath),
    type: 'application/pdf',
    hash: f.resumePdfHash
  });

  await page.reload();
  writeFileSync(path.join(f.store.p.ws, f.resumePdfPath), Buffer.from('%PDF-1.4\nmutated\n%%EOF\n'));
  await assert.rejects(
    () => applyBoundFormFields(f.store, page, packet, inspected),
    error => error.code === 'artifact_pdf_diverged'
  );
  for (const frame of page.frames()) {
    const locator = frame.locator('input[type="file"]').first();
    if (await locator.count()) assert.equal(await locator.evaluate(input => input.files?.length || 0), 0);
  }

  await page.goto(server.url('/application-main.html'));
  const mainSnapshot = await inspectApplicationFormOnPage({
    page,
    requestedUrl: server.url('/application-main.html'),
    jobId: f.job.id,
    profileId: f.profile.id
  });
  const mainBindings = resolveFormBindings(f.store, { jobId: f.job.id, profileId: f.profile.id, snapshot: mainSnapshot });
  const coverField = mainSnapshot.fieldMap.fields.find(field => field.control === 'file' && /cover/.test(field.prompt));
  const coverBinding = mainBindings.bindings.find(binding => binding.fieldKey === coverField.fieldKey);
  assert.equal(coverBinding.mode, 'human-action');
  assert.equal(coverBinding.autoFill, false);
  assert.equal(coverBinding.reasonCode, 'cover_file_requires_human_upload');
});

test('W02 structural locators stay secret-free, scope to the selected form, and read back false checkboxes', async t => {
  const sentinel = 'SECRET_DOM_TOKEN_ID_7YQ9';
  const f = await seedW02Workspace(t, { withSnapshot: false });
  const server = await startFormServer(t);
  addAnswer(f.store, {
    profileId: f.profile.id,
    category: 'other',
    question: 'Send me company news',
    answer: 'No',
    sensitivity: 'public',
    reuseScope: 'global',
    verificationStatus: 'verified',
    sourceRef: 'false-checkbox-regression'
  });
  const inspectedPublic = await inspectLiveForm(f.store, {
    jobId: f.job.id,
    profileId: f.profile.id,
    url: server.url('/application-secret-locators.html'),
    browserProfile: 'structural-locators'
  });
  assert.equal(inspectedPublic.selection.formKey, 'form-1');
  const raw = getFormSnapshot(f.store, inspectedPublic.snapshotId, { raw: true });
  assert.equal(raw.fieldMap.fields.every(field => field.locator.strategy === 'selected-form-control'), true);
  assert.equal(raw.fieldMap.fields.every(field => field.locator.value === ''), true);
  const packet = createApplicationPacket(f.store, { jobId: f.job.id, profileId: f.profile.id, createdBy: 'cli' });
  assert.equal(Buffer.from(f.store.db.export()).includes(Buffer.from(sentinel)), false);
  assert.equal(workspaceContains(f.store.p.ws, sentinel), false);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url('/application-secret-locators.html'));
  const inspected = await inspectApplicationFormOnPage({
    page,
    requestedUrl: server.url('/application-secret-locators.html'),
    jobId: f.job.id,
    profileId: f.profile.id
  });
  const readback = await applyBoundFormFields(f.store, page, packet, inspected);
  const values = await page.evaluate(() => ({
    decoy: document.querySelector('#decoy-name').value,
    selected: document.querySelector('#SECRET_DOM_TOKEN_ID_7YQ9').value,
    checked: document.querySelector('input[name="newsletter"]').checked
  }));
  assert.equal(values.decoy, '');
  assert.equal(values.selected, f.resumeRevision.document.identity.name);
  assert.equal(values.checked, false);
  const checkbox = inspected.fieldMap.fields.find(field => field.control === 'checkbox');
  assert.equal(readback.find(item => item.fieldKey === checkbox.fieldKey).status, 'equal');
});

test('W02 stale, prevented, unchanged, and unrelated-origin confirmation evidence stays uncertain', async t => {
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    for (const scenario of [
      { path: '/application-preexisting.html', submits: 1 },
      { path: '/application-prevented.html', submits: 0 },
      { path: '/application-unchanged.html', submits: 0 },
      { path: '/application-unrelated.html', submits: 1 }
    ]) {
      const f = await configuredSubmissionFixture(t, scenario.path);
      const beforeStatus = one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status;
      const result = await submitApplicationForm(f.store, {
        packetId: f.packet.id,
        checkpointId: f.checkpoint.checkpointId,
        workspace: f.root,
        browserProfile: f.browserProfile,
        allowSubmit: true,
        navigationTimeoutMs: 1_000
      });
      assert.equal(result.status, 'uncertain', scenario.path);
      assert.equal(result.submissionPerformed, null, scenario.path);
      assert.equal(f.server.state.submits, scenario.submits, scenario.path);
      assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM application_receipts').count, 0, scenario.path);
      assert.equal(one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status, beforeStatus, scenario.path);
    }
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('W02 post-click 422 remains uncertain and replay-blocked after exactly one POST', async t => {
  const f = await configuredSubmissionFixture(t, '/application-post-422.html');
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    const result = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true,
      navigationTimeoutMs: 1_000
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.externalSideEffects, 'user_configured_form_submission');
    assert.equal(f.server.state.submits, 1);
    await assert.rejects(() => submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    }), error => error.code === 'submission_replay_blocked');
    assert.equal(f.server.state.submits, 1);
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('W02 secret-shaped confirmation references never reach SQLite audits mirrors or returned output', async t => {
  const sentinel = 'SECRET_TOKEN_SENTINEL_7YQ9';
  const f = await configuredSubmissionFixture(t, '/application-secret-confirmation.html');
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    const beforeStatus = one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status;
    const result = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(Buffer.from(f.store.db.export()).includes(Buffer.from(sentinel)), false);
    assert.equal(workspaceContains(f.store.p.ws, sentinel), false);
    assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM application_receipts').count, 0);
    assert.equal(one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status, beforeStatus);
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('W02 confirmed configured submission advances a pre-apply application status to applied', async t => {
  const f = await configuredSubmissionFixture(t);
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    const beforeStatus = one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status;
    assert.equal(['saved', 'researching', 'materials-ready'].includes(beforeStatus), true);
    const result = await submitApplicationForm(f.store, {
      packetId: f.packet.id,
      checkpointId: f.checkpoint.checkpointId,
      workspace: f.root,
      browserProfile: f.browserProfile,
      allowSubmit: true
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.submissionPerformed, true);
    const afterStatus = one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status;
    assert.equal(afterStatus, 'applied');
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});

test('W02 confirmed configured submission never regresses recruiter-screen interview or offer to applied', async t => {
  const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  try {
    for (const postApplyStatus of ['recruiter-screen', 'interview', 'offer']) {
      const f = await configuredSubmissionFixture(t);
      run(f.store, 'UPDATE applications SET status=? WHERE id=?', [postApplyStatus, f.packet.applicationId]);
      save(f.store);
      const result = await submitApplicationForm(f.store, {
        packetId: f.packet.id,
        checkpointId: f.checkpoint.checkpointId,
        workspace: f.root,
        browserProfile: f.browserProfile,
        allowSubmit: true
      });
      assert.equal(result.status, 'confirmed', postApplyStatus);
      assert.equal(result.submissionPerformed, true, postApplyStatus);
      const afterStatus = one(f.store, 'SELECT status FROM applications WHERE id=?', [f.packet.applicationId]).status;
      assert.equal(afterStatus, postApplyStatus, `${postApplyStatus} must not regress to applied`);
      assert.equal(one(f.store, 'SELECT COUNT(*) AS count FROM status_changes WHERE to_status=? AND application_id=?', ['applied', f.packet.applicationId]).count, 0, `${postApplyStatus} must not record an applied status change`);
    }
  } finally {
    if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
    else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
  }
});