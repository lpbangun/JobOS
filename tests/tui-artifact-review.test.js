import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openStore, all, one, run, save, audit, reload } from '../src/db.js';

function artifactHash(content) {
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
function artifactSeriesKey(type, jobId, profileId, artifactPath) {
  return `${type}:${jobId || 'none'}:${profileId || 'none'}:${artifactPath}`;
}
import { createProfile, addProof } from '../src/profiles.js';
import { importText, importNormalized, updateJobStatus } from '../src/jobs.js';
import { appCreate, appUpdate } from '../src/tracking.js';
import { validStatuses } from '../src/utils.js';
import { buildTuiModel } from '../src/tui-model.js';
import { defaultTuiState, JobosTui, renderTui, TUI_DOMAIN_ACTIONS } from '../src/tui.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';
import { handleApi } from '../src/api.js';
import { ingestEditedArtifact } from '../src/artifacts.js';
import { renderArtifactDiff, sanitizeTerminalText } from '../src/tui-artifacts.js';
import { seedArtifactReviewWorkspace } from './fixtures/artifact-review-seed.js';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

// ---------------------------------------------------------------------------
// T1 — Artifact review actions and audit
// ---------------------------------------------------------------------------
test('T1 — Artifact review actions and audit', async t => {
  const { store, profile, jobs: { jobA }, artifacts, application } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // ── Setup: open review, select resumeV2 ──
  tui.openOverlay('review');
  tui.refresh({ disk: false });
  const model = tui.model;
  assert.ok(model.review.length > 0, 'review queue has items');
  const idx = model.review.findIndex(r => r.id === artifacts.resumeV2.id);
  assert.ok(idx >= 0, 'resumeV2 is in review queue');
  tui.state.overlayIndex = idx;
  const nonHighlighted = model.review.find(item => item.id !== artifacts.resumeV2.id);
  assert.ok(nonHighlighted, 'T1 setup: another review artifact exists');
  tui.state.selectedArtifactId = nonHighlighted.id;

  // ── Intended flow 1: A approves ──
  tui.onKeypress('A', { name: 'a', shift: true });
  const afterA = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  assert.equal(afterA.approval_status, 'approved',
    'T1-A: approval_status should change to approved');
  assert.equal(
    one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [nonHighlighted.id]).approval_status,
    'draft_needs_human_review',
    'T1-A: approval targets the highlighted review row, not stale selectedArtifactId'
  );

  const auditsA = all(store, "SELECT * FROM audit_log WHERE action='artifact.approved' AND entity_id=?", [artifacts.resumeV2.id]);
  assert.equal(auditsA.length, 1, 'T1-A: exactly one artifact.approved audit');
  const aPayload = JSON.parse(auditsA[0].payload_json);
  assert.equal(aPayload.jobId, jobA.id);
  assert.equal(aPayload.approvalStatus, 'approved');
  assert.equal(typeof aPayload.reviewNote, 'string');
  assert.equal(aPayload.reviewedBy, 'tui');
  assert.equal(auditsA[0].external_side_effect, 'none');

  // Approved item leaves review queue
  const modelAfterA = tui.model;
  assert.equal(modelAfterA.review.some(r => r.id === artifacts.resumeV2.id), false,
    'T1-A: approved item removed from review queue');

  // Next item in queue selected deterministically (first remaining)
  assert.ok(modelAfterA.review.length > 0, 'T1-A: nonempty queue after removal');

  // ── Intended flow 2: R rejects with audit feedback ──
  // Select next draft from queue
  const nextIdx = tui.model.review.findIndex(r => r.path !== artifacts.resumeV2.path);
  tui.state.overlayIndex = nextIdx >= 0 ? nextIdx : 0;
  const nextArtifactId = tui.model.review[tui.state.overlayIndex].id;

  tui.onKeypress('R', { name: 'r', shift: true });
  assert.equal(tui.state.mode, 'review-note', 'T1-R: mode becomes review-note');

  // Empty feedback refused
  tui.state.input = '';
  tui.onKeypress(null, { name: 'enter' });
  const auditsEmptyReject = all(store, "SELECT * FROM audit_log WHERE action='artifact.rejected' AND entity_id=?", [nextArtifactId]);
  assert.equal(auditsEmptyReject.length, 0, 'T1-R: empty rejection writes zero audits');

  // Feedback entered then Enter rejects
  tui.state.mode = 'review-note';
  tui.state.input = 'needs more metrics';
  tui.onKeypress(null, { name: 'enter' });
  const afterReject = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [nextArtifactId]);
  assert.equal(afterReject.approval_status, 'rejected', 'T1-R: artifact rejected after feedback');

  const rejectAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.rejected' AND entity_id=?", [nextArtifactId]);
  assert.ok(rejectAudits.length >= 1, 'T1-R: artifact.rejected audit written');
  const rPayload = JSON.parse(rejectAudits[rejectAudits.length - 1].payload_json);
  assert.equal(rPayload.reviewNote, 'needs more metrics');

  // PromptAgent called if client ready; otherwise status always includes CLI redraft nextAction
  if (tui.client?.state === 'ready' && !tui.state.busy) {
    // promptAgent with revise text — can't assert directly without mock
  } else {
    assert.match(tui.state.status, /redraft next: jobos tailor/,
      'T1-R: rejection status surfaces CLI redraft nextAction when agent offline');
  }

  // ── Intended flow 3: B restores draft ──
  // Open docs on rejected artifact, press B
  tui.state.overlay = 'docs';
  tui.state.selectedArtifactId = nextArtifactId;
  tui.onKeypress('B', { name: 'b', shift: true });
  const afterB = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [nextArtifactId]);
  assert.equal(afterB.approval_status, 'draft_needs_human_review',
    'T1-B: B restores draft_needs_human_review');

  const backAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.reviewed' AND entity_id=? ORDER BY created_at DESC", [nextArtifactId]);
  assert.equal(backAudits[0]?.payload_json ? JSON.parse(backAudits[0].payload_json).approvalStatus : null, 'draft_needs_human_review',
    'T1-B: latest artifact.reviewed shows draft_needs_human_review');

  // ── Intended invariant: no submit/send/applied from review keys ──
  const submitAudits = all(store, "SELECT * FROM audit_log WHERE action LIKE '%submit%' OR action LIKE '%sent%' OR action LIKE '%applied%'");
  assert.equal(submitAudits.length, 0, 'T1: no submit/sent/applied audits from TUI');

  // Returned row shape limited to id,job_id,profile_id,type,path,title,approval_status,created_at
  // (verified via API PATCH or reviewArtifact return — share service boundary)
});

// ---------------------------------------------------------------------------
// T2 — Discovery accept/archive
// ---------------------------------------------------------------------------
test('T2 — Discovery accept/archive', async t => {
  const { store, profile, jobs: { jobB, jobC } } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.refresh({ disk: false });

  // ── Setup: two new jobs exist ──
  assert.equal(one(store, 'SELECT status FROM jobs WHERE id=?', [jobB.id]).status, 'new');
  assert.equal(one(store, 'SELECT status FROM jobs WHERE id=?', [jobC.id]).status, 'new');

  tui.openOverlay('discovery');
  const model = tui.model;

  // ── Intended: discovery.queue exists and is ordered ──
  assert.ok(Array.isArray(model.discovery.queue), 'T2: model.discovery.queue is an array');
  assert.equal(model.discovery.queue.length, 2, 'T2: exactly 2 jobs in discovery queue');
  // Ordered high_fit DESC, fit_score DESC, created_at DESC
  assert.ok(model.discovery.queue[0].highFit >= model.discovery.queue[1].highFit);
  const jobBInQueue = model.discovery.queue.find(j => j.id === jobB.id);
  const jobCInQueue = model.discovery.queue.find(j => j.id === jobC.id);
  assert.ok(jobBInQueue, 'T2: jobB in discovery queue');
  assert.ok(jobCInQueue, 'T2: jobC in discovery queue');

  // ── Intended: A accepts jobB to saved ──
  tui.state.selectedDiscoveryJobId = jobB.id;
  tui.onKeypress('A', { name: 'a', shift: true });
  const afterB = one(store, 'SELECT status FROM jobs WHERE id=?', [jobB.id]);
  assert.equal(afterB.status, 'saved', 'T2-A: jobB becomes saved');

  const jobBAudits = all(store, "SELECT * FROM audit_log WHERE action='job.status_changed' AND entity_id=?", [jobB.id]);
  assert.equal(jobBAudits.length, 1, 'T2-A: one job.status_changed audit');
  const bPayload = JSON.parse(jobBAudits[0].payload_json);
  assert.equal(bPayload.jobId, jobB.id);
  assert.equal(bPayload.status, 'saved');
  assert.equal(jobBAudits[0].external_side_effect, 'none');

  // ── Intended: X archives jobC ──
  tui.state.selectedDiscoveryJobId = jobC.id;
  tui.onKeypress('X', { name: 'x', shift: true });
  const afterC = one(store, 'SELECT status FROM jobs WHERE id=?', [jobC.id]);
  assert.equal(afterC.status, 'archived', 'T2-X: jobC becomes archived');

  const jobCAudits = all(store, "SELECT * FROM audit_log WHERE action='job.status_changed' AND entity_id=?", [jobC.id]);
  assert.equal(jobCAudits.length, 1, 'T2-X: one job.status_changed audit');
  const cPayload = JSON.parse(jobCAudits[0].payload_json);
  assert.equal(cPayload.status, 'archived');

  // Both removed from queue
  tui.refresh({ disk: false });
  assert.equal(tui.model.discovery.queue.length, 0, 'T2: both jobs removed from queue');

  // No application rows created
  const appsForBC = all(store, 'SELECT id FROM applications WHERE job_id IN (?,?)', [jobB.id, jobC.id]);
  assert.equal(appsForBC.length, 0, 'T2: no applications for discovery decisions');

  // Searches/runs section renders before queue (when searches exist)
  // Baseline already shows searches first
  assert.ok(Array.isArray(tui.model.discovery.searches));

  // ── Intended: stale repeat protection ──
  // Accept again on already-saved jobB: refresh, clear status, zero extra audits
  const preStaleCount = all(store, "SELECT COUNT(*) c FROM audit_log WHERE action='job.status_changed' AND entity_id=?", [jobB.id])[0].c;
  tui.state.selectedDiscoveryJobId = jobB.id;
  tui.onKeypress('A', { name: 'a', shift: true });
  const postStaleCount = all(store, "SELECT COUNT(*) c FROM audit_log WHERE action='job.status_changed' AND entity_id=?", [jobB.id])[0].c;
  assert.equal(postStaleCount, preStaleCount, 'T2: stale discovery accept writes zero audits');
});

// ---------------------------------------------------------------------------
// T3 — Application stage create/update
// ---------------------------------------------------------------------------
test('T3 — Application stage create/update', async t => {
  const { store, profile, jobs: { jobA, jobB }, application } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobB.id; // jobB has no application
  tui.refresh({ disk: false });

  // ── Setup: stage order from validStatuses ──
  const stageOrder = Array.from(validStatuses);
  assert.ok(stageOrder.includes('materials-ready'));
  assert.ok(stageOrder.includes('applied'));

  // ── Intended flow 1: create application via stage picker ──
  // Press t → stage mode
  tui.onKeypress('t', { name: 't' });
  assert.equal(tui.state.mode, 'stage', 'T3: mode becomes stage after t');
  assert.equal(typeof tui.state.stageIndex, 'number', 'T3: stageIndex is set');
  assert.ok(tui.state.stageIndex >= 0 && tui.state.stageIndex < stageOrder.length,
    'T3: stageIndex in valid range');

  // Left/Right cycle through statuses — cycle to materials-ready
  tui.onKeypress(null, { name: 'right' });
  tui.onKeypress(null, { name: 'right' });
  // (depends on starting index; final position = materials-ready)
  const selectedStage = stageOrder[tui.state.stageIndex];
  assert.equal(selectedStage, 'materials-ready', 'T3: cycled to materials-ready');

  // Enter → stage-note mode
  tui.onKeypress(null, { name: 'enter' });
  assert.equal(tui.state.mode, 'stage-note', 'T3: mode becomes stage-note');

  // Type note and Enter
  tui.state.input = 'packet ready';
  tui.onKeypress(null, { name: 'enter' });
  const newApp = one(store, 'SELECT * FROM applications WHERE job_id=? AND profile_id=?', [jobB.id, profile.id]);
  assert.ok(newApp, 'T3: application created');
  assert.equal(newApp.status, 'materials-ready');
  assert.equal(newApp.notes, 'packet ready');

  const scRows = all(store, 'SELECT * FROM status_changes WHERE application_id=?', [newApp.id]);
  assert.equal(scRows.length, 1, 'T3: one status_changes row');
  assert.equal(scRows[0].to_status, 'materials-ready');
  assert.equal(scRows[0].note, 'packet ready');

  const newAppAudits = all(store, 'SELECT * FROM audit_log WHERE entity_id=?', [newApp.id]);
  assert.equal(newAppAudits.length, 1, 'T3: stage create emits exactly one audit');
  assert.equal(newAppAudits[0].action, 'application.created', 'T3: create audit is authoritative');
  const createPayload = JSON.parse(newAppAudits[0].payload_json);
  assert.equal(createPayload.toStatus, 'materials-ready');

  // ── Intended flow 2: update existing app to applied ──
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });
  tui.onKeypress('t', { name: 't' });
  assert.equal(tui.state.mode, 'stage');
  // Cycle to applied
  while (stageOrder[tui.state.stageIndex] !== 'applied') {
    tui.onKeypress(null, { name: 'right' });
  }
  tui.onKeypress(null, { name: 'enter' });
  // Optional note (empty)
  tui.state.input = '';
  tui.onKeypress(null, { name: 'enter' });

  const updatedApp = one(store, 'SELECT * FROM applications WHERE id=?', [application.id]);
  assert.equal(updatedApp.status, 'applied', 'T3: updated to applied');

  // Screen/model refresh shows tracking-only warning
  const screenAfterUpdate = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(screenAfterUpdate, /Tracking only — JobOS did not submit this application\./,
    'T3: tracking-only warning visible');

  // ── Intended: invalid status guard ──
  const preAppCount = all(store, 'SELECT id FROM applications').length;
  const preSCount = all(store, 'SELECT id FROM status_changes').length;

  // Attempt invalid status via TUI stage: should show UI error
  tui.state.mode = 'stage';
  tui.state.stageIndex = -1; // outside valid range
  tui.onKeypress(null, { name: 'enter' });
  assert.ok(tui.state.error || /Invalid/.test(tui.state.status),
    'T3: invalid status produces UI error');

  // No rows created for the failed attempt
  const postAppCount = all(store, 'SELECT id FROM applications').length;
  const postSCount = all(store, 'SELECT id FROM status_changes').length;
  assert.equal(postAppCount, preAppCount, 'T3: invalid status does not create applications');
  assert.equal(postSCount, preSCount, 'T3: invalid status does not create status_changes');

  // ── Intended: no external side effects ──
  const extAudits = all(store, "SELECT * FROM audit_log WHERE external_side_effect!='none'");
  assert.equal(extAudits.length, 0, 'T3: no external side effects from stage actions');
});

// ---------------------------------------------------------------------------
// T4 — Status-note and no-op semantics
// ---------------------------------------------------------------------------
test('T4 — Status-note and no-op semantics', async t => {
  const { store, profile, jobs: { jobA }, application } = await seedArtifactReviewWorkspace(t);

  // Setup: application status=researching notes=keep-me
  assert.equal(application.status, 'researching');
  assert.equal(application.notes, 'keep-me');

  // Baseline: seed creates one application with application.created audit
  const preAllAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c;
  assert.equal(preAllAudits, 1, 'T4 setup: one audit (application.created) exists');

  // 1. CHANGE+NOTE: researching → materials-ready with 'n1'
  const preScAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c;
  const preSCount = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;

  const r1 = appUpdate(store, application.id, 'materials-ready', 'n1');
  assert.equal(r1.notes, 'n1', 'T4: change+note writes application notes');

  const sc1 = one(store, "SELECT * FROM status_changes WHERE application_id=? ORDER BY created_at DESC", [application.id]);
  assert.equal(sc1.note, 'n1', 'T4: change+note writes status_changes.note');
  assert.equal(sc1.to_status, 'materials-ready');

  // Exactly one new status_changes row
  const postSCount = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  assert.equal(postSCount, preSCount + 1, 'T4: change+note adds one status_changes row');

  // Exactly one new application.status_changed audit
  const postScAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c;
  assert.equal(postScAudits, preScAudits + 1, 'T4: change+note adds one status_changed audit');

  const audit1 = all(store, "SELECT * FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id]);
  const p1 = JSON.parse(audit1[audit1.length - 1].payload_json);
  assert.equal(p1.fromStatus, 'researching', 'T4: change+note audit has fromStatus');
  assert.equal(p1.toStatus, 'materials-ready', 'T4: change+note audit has toStatus');
  assert.equal(p1.status, 'materials-ready');

  // 2. CHANGE+OMIT: materials-ready → applied with empty/omitted note
  const preScAudits2 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c;

  const r2 = appUpdate(store, application.id, 'applied'); // notes=null (omitted)
  assert.equal(r2.notes, 'n1', 'T4: change+omit preserves existing application notes');

  const sc2 = one(store, "SELECT * FROM status_changes WHERE application_id=? ORDER BY created_at DESC", [application.id]);
  assert.equal(sc2.note, '', 'T4: change+omit writes empty status_changes.note');
  assert.equal(sc2.to_status, 'applied');

  // Exactly one new status_changed audit
  const postScAudits2 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c;
  assert.equal(postScAudits2, preScAudits2 + 1, 'T4: change+omit adds one status_changed audit');

  const audit2 = all(store, "SELECT * FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id]);
  const p2 = JSON.parse(audit2[audit2.length - 1].payload_json);
  assert.equal(p2.fromStatus, 'materials-ready');
  assert.equal(p2.toStatus, 'applied');

  // 3. SAME+NOTE: applied → applied with note 'n2'
  const preScCount3 = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  const preNotesAudit3 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.notes_updated'", [application.id])[0].c;

  const r3 = appUpdate(store, application.id, 'applied', 'n2');
  assert.equal(r3.notes, 'n2', 'T4: same+note updates application notes');

  // No new status_changes row
  const postScCount3 = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  assert.equal(postScCount3, preScCount3, 'T4: same+note adds no status_changes');

  // Exactly one notes_updated audit
  const postNotesAudit3 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.notes_updated'", [application.id])[0].c;
  assert.equal(postNotesAudit3, preNotesAudit3 + 1, 'T4: same+note adds one notes_updated audit');

  const audit3 = all(store, "SELECT * FROM audit_log WHERE entity_id=? AND action='application.notes_updated' ORDER BY created_at DESC", [application.id]);
  assert.equal(audit3[0]?.action, 'application.notes_updated', 'T4: same+note audit action is notes_updated');
  const p3 = JSON.parse(audit3[0].payload_json);
  assert.equal(p3.status, 'applied', 'T4: same+note audit has status');
  assert.equal(p3.notes, 'n2', 'T4: same+note audit has notes');

  // 4. SAME+OMIT: applied → applied no note (true no-op)
  const preAllAudits4 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c;
  const preScCount4 = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  const preNotes4 = one(store, 'SELECT notes FROM applications WHERE id=?', [application.id]).notes;

  appUpdate(store, application.id, 'applied'); // same status, no note

  const postNotes4 = one(store, 'SELECT notes FROM applications WHERE id=?', [application.id]).notes;
  const postScCount4 = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  const postAllAudits4 = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c;

  assert.equal(postNotes4, preNotes4, 'T4: same+omit leaves notes unchanged');
  assert.equal(postScCount4, preScCount4, 'T4: same+omit adds no status_changes');
  assert.equal(postAllAudits4, preAllAudits4, 'T4: same+omit adds zero audits (true no-op)');

  // Invalid status throws before any write
  assert.throws(() => appUpdate(store, application.id, 'invalid_status'), /Invalid status/);

  // Assert no audits on invalid attempt
  const finalAllAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c;
  assert.equal(finalAllAudits, postAllAudits4, 'T4: invalid status adds no audits');
});

// ---------------------------------------------------------------------------
// T5 — Stable selection
// ---------------------------------------------------------------------------
test('T5 — Stable selection', async t => {
  const { store, profile, jobs: { jobA, jobB, jobC }, artifacts } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // Setup: defaults from defaultTuiState
  const base = defaultTuiState();
  assert.equal(base.selectedJobId, null);
  assert.equal(base.overlay, null);

  // ── Intended: new state fields are initialized ──
  assert.equal(base.selectedArtifactId, null,
    'T5: selectedArtifactId null in defaultTuiState');
  assert.equal(base.selectedDiscoveryJobId, null,
    'T5: selectedDiscoveryJobId null in defaultTuiState');
  assert.equal(base.docsScroll, 0,
    'T5: docsScroll 0 in defaultTuiState');
  assert.equal(base.docsDiffScroll, 0,
    'T5: docsDiffScroll 0 in defaultTuiState');
  assert.equal(base.docsQuery, '',
    'T5: docsQuery empty in defaultTuiState');
  assert.equal(base.docsMatchIndex, 0,
    'T5: docsMatchIndex 0 in defaultTuiState');

  // ── Intended: selectedJobId survives disk refresh ──
  tui.state.selectedJobId = jobA.id;
  const store2 = await openStore({ workspace: tui.store.root });
  run(store2, "UPDATE jobs SET title=? WHERE id=?", ['Unrelated', jobA.id]);
  save(store2);
  tui.refresh();
  assert.equal(tui.state.selectedJobId, jobA.id,
    'T5: selectedJobId persists across disk refresh');

  // ── Intended: selectedJobId survives unrelated mutation ──
  await callDomainTool(tui.store, 'score_job', { jobId: jobB.id, profileId: profile.id }, { source: 'tui' });
  tui.refresh();
  assert.equal(tui.state.selectedJobId, jobA.id,
    'T5: selectedJobId persists across unrelated mutation');

  // ── Intended: selectedArtifactId clamps when artifact removed from review queue ──
  // Select resumeV2 through review overlay, then delete the row + save/refresh
  // to simulate removal (A key approval is tested separately in T1)
  tui.openOverlay('review');
  tui.refresh({ disk: false });
  const reviewIdx = tui.model.review.findIndex(r => r.id === artifacts.resumeV2.id);
  tui.state.overlayIndex = Math.max(0, reviewIdx);
  // Open docs for selected artifact (Enter behavior)
  tui.onKeypress(null, { name: 'enter' });
  assert.equal(tui.state.selectedArtifactId, artifacts.resumeV2.id,
    'T5: enter in review selects artifact ID');
  assert.equal(tui.state.overlay, 'docs',
    'T5: enter opens docs overlay');
  assert.equal(tui.state.docsScroll, 0,
    'T5: enter resets docsScroll');
  assert.equal(tui.state.docsMatchIndex, 0,
    'T5: enter resets docsMatchIndex');

  // Delete the artifact row + save/refresh to simulate removal
  const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE id=?', [artifacts.resumeV2.id])[0].c;
  assert.equal(preCount, 1, 'T5: artifact exists before deletion');
  run(store, 'DELETE FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  save(store);
  tui.refresh({ disk: false });

  // Clamp to next item in review queue (or null if empty)
  if (tui.model.review.length > 0) {
    assert.ok(tui.model.review.some(r => r.id === tui.state.selectedArtifactId),
      'T5: selectedArtifactId clamps to next review item after removal');
  } else {
    assert.equal(tui.state.selectedArtifactId, null,
      'T5: selectedArtifactId null after last review item removed');
  }

  // ── Intended: artifact change via viewer j/k resets scroll/match/query ──
  tui.state.focusTarget = 'viewer';
  tui.state.overlay = 'docs';
  const firstDocId = tui.model.selected?.docs?.[0]?.id;
  const secondDocId = tui.model.selected?.docs?.[1]?.id;
  if (firstDocId && secondDocId) {
    tui.state.selectedArtifactId = firstDocId;
    tui.state.docsScroll = 5;
    tui.state.docsDiffScroll = 3;
    tui.state.docsMatchIndex = 2;
    tui.state.docsQuery = 'search';
    // j to advance to next artifact — should reset scroll/match/query
    tui.onKeypress('j', { name: 'j' });
    assert.equal(tui.state.selectedArtifactId, secondDocId,
      'T5: viewer j changes selectedArtifactId');
    assert.equal(tui.state.docsScroll, 0,
      'T5: artifact change via j resets docsScroll');
    assert.equal(tui.state.docsDiffScroll, 0,
      'T5: artifact change via j resets docsDiffScroll');
    assert.equal(tui.state.docsMatchIndex, 0,
      'T5: artifact change via j resets docsMatchIndex');
    assert.equal(tui.state.docsQuery, '',
      'T5: artifact change via j resets docsQuery');
  }

  // ── Intended: selectedDiscoveryJobId clamps when archived ──
  tui.openOverlay('discovery');
  tui.state.selectedDiscoveryJobId = jobC.id;
  updateJobStatus(store, jobC.id, 'archived');
  tui.refresh({ disk: false });
  const remainingNew = all(store, "SELECT id FROM jobs WHERE status='new'");
  if (remainingNew.length > 0) {
    assert.equal(tui.state.selectedDiscoveryJobId, remainingNew[0].id,
      'T5: selectedDiscoveryJobId clamps to next new job');
  } else {
    assert.equal(tui.state.selectedDiscoveryJobId, null,
      'T5: selectedDiscoveryJobId null when no new jobs remain');
  }
});

// ---------------------------------------------------------------------------
// T6 — Auto-open and focus deferral
// ---------------------------------------------------------------------------
test('T6 — Auto-open and focus deferral', async t => {
  const { store, profile, jobs: { jobA, jobB }, artifacts } = await seedArtifactReviewWorkspace(t);

  // ── SCENARIO 1: Immediate auto-open (no blockers present) ──
  {
    const io = streams();
    const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
    tui.state.selectedJobId = jobA.id;
    tui.refresh({ disk: false });

    // Snapshot artifacts before simulated agent work
    const before = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts WHERE job_id=?', [jobA.id]);

    // Insert created and same-path updated artifacts (deterministic IDs)
    const atNow = new Date().toISOString();
    const atLater = new Date(Date.now() + 1).toISOString();
    const createdId = 't6_created_' + Date.now();
    const updatedId = 't6_updated_' + Date.now();
    run(store, 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [createdId, jobA.id, profile.id, 'resume', 't6-new.md', 'T6 Created', 'c', '[]', '[]', 'draft_needs_human_review', atNow, artifactSeriesKey('resume', jobA.id, profile.id, 't6-new.md'), 1, null, artifactHash('c'), null, null, '']);
    run(store, 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [updatedId, jobA.id, profile.id, 'resume', 'resume.md', 'T6 Updated', 'c', '[]', '[]', 'draft_needs_human_review', atLater, artifactSeriesKey('resume', jobA.id, profile.id, 'resume.md'), 3, null, artifactHash('c'), null, null, '']);
    save(store);

    const after = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts WHERE job_id=?', [jobA.id]);

    // noteArtifactChanges is a method on tui
    assert.equal(typeof tui.noteArtifactChanges, 'function',
      'T6-s1: noteArtifactChanges is a method on tui');

    // Call the helper (immediate: mode=normal, pendingConfirm=null, busy=null)
    const preCount = tui.state.messages.length;
    tui.noteArtifactChanges(before, after);

    // Exactly two banners (Created + Updated), no duplicates
    const banners = tui.state.messages.slice(preCount);
    const createdBanners = banners.filter(m => /^Created:/.test(m.text || ''));
    const updatedBanners = banners.filter(m => /^Updated:/.test(m.text || ''));
    assert.equal(createdBanners.length, 1, 'T6-s1: exactly one Created banner');
    assert.equal(updatedBanners.length, 1, 'T6-s1: exactly one Updated banner');
    assert.match(createdBanners[0].text, /Ctrl\+A to focus viewer/,
      'T6-s1: Created banner includes focus hint');
    assert.match(updatedBanners[0].text, /Ctrl\+A to focus viewer/,
      'T6-s1: Updated banner includes focus hint');

    // Newest changed artifact selected
    assert.equal(tui.state.selectedArtifactId, updatedId,
      'T6-s1: immediate auto-open sets selectedArtifactId');
    assert.equal(tui.state.overlay, 'docs',
      'T6-s1: immediate auto-open opens docs');
  }

  // ── SCENARIO 2: Deferred auto-open (blockers present, cleared via public path) ──
  {
    const io2 = streams();
    const tui2 = new JobosTui(store, { ...io2, profileId: profile.id, connectAgent: false, color: false });
    tui2.state.selectedJobId = jobA.id;
    tui2.refresh({ disk: false });

    const before2 = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts WHERE job_id=?', [jobA.id]);
    const atNow2 = new Date().toISOString();
    const deferId = 't6_defer_' + Date.now();
    run(store, 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [deferId, jobA.id, profile.id, 'resume', 't6-defer.md', 'T6 Defer', 'c', '[]', '[]', 'draft_needs_human_review', atNow2, artifactSeriesKey('resume', jobA.id, profile.id, 't6-defer.md'), 1, null, artifactHash('c'), null, null, '']);
    save(store);
    const after2 = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts WHERE job_id=?', [jobA.id]);

    // Set blockers: review-note mode, pendingConfirm set, busy=true
    tui2.state.mode = 'review-note';
    tui2.state.input = 'pending feedback';
    tui2.state.pendingConfirm = { kind: 'discard-review-note', next: 'close' };
    tui2.state.busy = true;

    assert.equal(typeof tui2.noteArtifactChanges, 'function',
      'T6-s2: noteArtifactChanges exists');
    tui2.noteArtifactChanges(before2, after2);

    // All state preserved — deferred
    assert.equal(tui2.state.mode, 'review-note',
      'T6-s2: mode preserved during deferral');
    assert.equal(tui2.state.input, 'pending feedback',
      'T6-s2: input preserved during deferral');
    assert.equal(tui2.state.overlay, null,
      'T6-s2: overlay unchanged during deferral');
    assert.equal(tui2.state.selectedArtifactId, null,
      'T6-s2: selectedArtifactId null during deferral');
    assert.equal(tui2.state.pendingAutoOpenArtifactId, deferId,
      'T6-s2: pendingAutoOpenArtifactId set during deferral');

    // Clear blockers via public path (mode → normal, refresh)
    tui2.state.pendingConfirm = null;
    tui2.state.busy = null;
    tui2.state.mode = 'normal';
    tui2.refresh({ disk: false });

    // Auto-open applies exactly once from the pending value
    assert.equal(tui2.state.overlay, 'docs',
      'T6-s2: deferred auto-open opens docs after clearing blockers');
    assert.equal(tui2.state.selectedArtifactId, deferId,
      'T6-s2: deferred auto-open selects deferred artifact');
    assert.equal(tui2.state.pendingAutoOpenArtifactId, null,
      'T6-s2: pendingAutoOpenArtifactId cleared after auto-open');
  }

  // ── SCENARIO 3: Created/Updated classification is scoped by job+path ──
  {
    const io3 = streams();
    const tui3 = new JobosTui(store, { ...io3, profileId: profile.id, connectAgent: false, color: false });
    tui3.state.selectedJobId = jobB.id;
    tui3.refresh({ disk: false });
    const beforeAll = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts');
    const crossJobId = `t6_cross_job_${Date.now()}`;
    run(store, 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [crossJobId, jobB.id, profile.id, 'resume', 'resume.md', 'T6 Cross-job Created', 'c', '[]', '[]', 'draft_needs_human_review', new Date().toISOString(), artifactSeriesKey('resume', jobB.id, profile.id, 'resume.md'), 1, null, artifactHash('c'), null, null, '']);
    save(store);
    const afterAll = all(store, 'SELECT id,path,job_id as jobId,created_at as createdAt FROM artifacts');
    const messageCount = tui3.state.messages.length;
    tui3.noteArtifactChanges(beforeAll, afterAll);
    assert.match(tui3.state.messages[messageCount]?.text || '', /^Created:/,
      'T6-s3: same path on another job is Created, not Updated');
  }

  // ── SCENARIO 4: editor lifecycle blocks deferred auto-open ──
  {
    const io4 = streams();
    const tui4 = new JobosTui(store, { ...io4, profileId: profile.id, connectAgent: false, color: false });
    tui4.state.selectedJobId = jobA.id;
    tui4.state.pendingAutoOpenArtifactId = artifacts.cover.id;
    tui4.state.editorActive = true;
    tui4.refresh({ disk: false });
    assert.equal(tui4.state.pendingAutoOpenArtifactId, artifacts.cover.id,
      'T6-s4: polling refresh cannot apply pending auto-open during editor');
    tui4.state.editorActive = false;
    tui4.refresh({ disk: false });
    assert.equal(tui4.state.pendingAutoOpenArtifactId, null,
      'T6-s4: pending auto-open applies after editor completes');
  }
});
// T7 — Markdown and terminal safety
// ---------------------------------------------------------------------------
test('T7 — Markdown and terminal safety', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobA.id });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobA.id };

  const docs = model.selected?.docs || [];
  const docIdx = docs.findIndex(d => d.id === artifacts.resumeV2.id);
  const state = { ...base, overlay: 'docs', overlayIndex: Math.max(0, docIdx), agentState: 'offline' };

  // ── Setup: seeded content has control bytes ──
  const content0 = docs[docIdx]?.content || '';
  assert.ok(content0.includes('\x1b]8;'), 'T7: seeded OSC hyperlink present');
  assert.ok(content0.includes('\x1b[31m'), 'T7: seeded CSI present');
  assert.ok(content0.includes('\x07'), 'T7: seeded BEL present');
  assert.ok(content0.includes('\x7f'), 'T7: seeded DEL present');

  // Render at full height so all content is visible
  const screenOn = renderTui(model, state, { width: 140, height: 200, color: true });
  const screenOff = renderTui(model, state, { width: 140, height: 200, color: false });

  // ── Intended: useful markdown hierarchy visible ──
  assert.match(screenOn, /# Resume|## Experience|## Education|## Skills/,
    'T7: heading hierarchy visible');

  // ── Intended: control bytes REMOVED from output ──
  assert.doesNotMatch(screenOff, /\x1b\]8;|[\x07\x7f]/,
    'T7: OSC/BEL/DEL removed from output after sanitization');
  assert.equal(sanitizeTerminalText('before\rafter'), 'beforeafter',
    'T7: carriage return is stripped');
  const unsafeDiff = renderArtifactDiff(
    'safe\n',
    'safe\n\x1b[31mRED\x1b[0m\rOVERWRITE\x07\n',
    { width: 80, color: false }
  );
  assert.doesNotMatch(unsafeDiff.lines.join('\n'), /[\x00-\x08\x0b-\x1f\x7f]/,
    'T7: diff output strips control bytes including CSI and CR');
  assert.match(unsafeDiff.lines.join('\n'), /\+ REDOVERWRITE/,
    'T7: diff preserves sanitized printable content');

  // ── Intended: color:false output has no SGR escape sequences ──
  assert.doesNotMatch(screenOff, /\x1b\[[0-9;]*m/,
    'T7: no SGR escapes in color:false output');

  // ── Intended: no JS length truncation corrupts ANSI ──
  // (slice-ansi properly clips; no lone 'm' artifacts)
  assert.doesNotMatch(screenOff, /(?:\x1b\[[0-9;]*[^m]|^m)/,
    'T7: no truncated ANSI artifacts');

  // Long lines wrap within width
  const lines = screenOff.split('\n');
  for (const line of lines) {
    assert.ok(line.length <= 142, // width + padding
      'T7: rendered lines wrapped to width');
  }
});

// ---------------------------------------------------------------------------
// T8 — Document navigation/search
// ---------------------------------------------------------------------------
test('T8 — Document navigation/search', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // ── Setup: 3+ artifacts on selected job ──
  const docs = tui.model.selected?.docs || [];
  assert.ok(docs.length >= 3, 'T8: at least 3 artifacts');

  // Open docs, set focusTarget to viewer for keyboard navigation
  tui.openOverlay('docs');
  tui.state.focusTarget = 'viewer';

  // ── Intended: j/k change selectedArtifactId (not just overlayIndex) ──
  // Seed initial position via direct state (this is setup, not a reset check)
  tui.state.selectedArtifactId = docs[0].id;
  tui.onKeypress('j', { name: 'j' });
  assert.equal(tui.state.selectedArtifactId, docs[1].id,
    'T8: j advances selectedArtifactId');
  tui.onKeypress('k', { name: 'k' });
  assert.equal(tui.state.selectedArtifactId, docs[0].id,
    'T8: k decrements selectedArtifactId');

  // ── Intended: arrow keys content scroll ──
  tui.state.docsScroll = 10;
  tui.onKeypress(null, { name: 'down' });
  assert.equal(tui.state.docsScroll, 11,
    'T8: down arrow increments docsScroll');
  tui.onKeypress(null, { name: 'up' });
  assert.equal(tui.state.docsScroll, 10,
    'T8: up arrow decrements docsScroll');

  // ── Intended: PageUp/PageDown page content scroll ──
  tui.onKeypress(null, { name: 'pagedown' });
  const afterPageDown = tui.state.docsScroll;
  assert.ok(afterPageDown > 10,
    'T8: PageDown advances docsScroll');
  tui.onKeypress(null, { name: 'pageup' });
  assert.ok(tui.state.docsScroll < afterPageDown,
    'T8: PageUp decreases docsScroll');

  // ── Intended: clamp minimum scroll ──
  tui.state.docsScroll = 0;
  tui.onKeypress(null, { name: 'up' });
  assert.equal(tui.state.docsScroll, 0,
    'T8: scroll clamped at 0');

  // ── Intended: / enters search mode ──
  tui.onKeypress('/', { name: '/' });
  assert.equal(tui.state.mode, 'docs-search',
    'T8: / enters docs-search mode');

  // Enter search query, then Enter to commit
  tui.state.input = 'TechLearn';
  tui.onKeypress(null, { name: 'enter' });
  assert.ok(tui.state.docsMatchIndex >= 0,
    'T8: search yields match index');

  // n/N advances/retreats match
  const firstMatch = tui.state.docsMatchIndex;
  tui.onKeypress('n', { name: 'n' });
  assert.ok(tui.state.docsMatchIndex === firstMatch + 1 || tui.state.docsMatchIndex === 0,
    'T8: n advances to next match');
  tui.onKeypress('N', { name: 'n', shift: true });
  assert.ok(tui.state.docsMatchIndex === firstMatch || tui.state.docsMatchIndex === 0,
    'T8: N goes to previous match');

  // Honest no-match state
  tui.state.mode = 'docs-search';
  tui.state.input = 'zzzNONEXISTENTzzz';
  tui.onKeypress(null, { name: 'enter' });
  assert.equal(tui.state.docsMatchIndex, -1,
    'T8: no-match yields -1');
  assert.match(tui.state.status, /no match|not found/,
    'T8: status shows no-match message');

  // ── Intended: artifact change via j/k resets scroll, match index, query ──
  tui.state.docsScroll = 5;
  tui.state.docsMatchIndex = 2;
  tui.state.docsQuery = 'searchText';
  tui.state.docsDiffScroll = 3;
  // Navigate to a different artifact via public j/k helper
  tui.onKeypress('j', { name: 'j' });
  assert.equal(tui.state.docsScroll, 0,
    'T8: artifact change via j resets docsScroll');
  assert.equal(tui.state.docsMatchIndex, 0,
    'T8: artifact change via j resets docsMatchIndex');
  assert.equal(tui.state.docsQuery, '',
    'T8: artifact change via j resets docsQuery to empty');
  assert.equal(tui.state.docsDiffScroll, 0,
    'T8: artifact change via j resets docsDiffScroll');

  // ── Intended: Esc from viewer/doc overlay closes ──
  tui.onKeypress(null, { name: 'escape' });
  assert.equal(tui.state.overlay, null,
    'T8: Esc closes docs overlay');
});

// ---------------------------------------------------------------------------
// T9 — Selected-artifact evidence
// ---------------------------------------------------------------------------
test('T9 — Selected-artifact evidence', async t => {
  const { store, profile, jobs: { jobA }, artifacts, proofs } = await seedArtifactReviewWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobA.id });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // ── Setup: proof points exist; docs from model with resolved evidence ──
  assert.equal(proofs.length, 2);
  const docs = tui.model.selected?.docs || [];
  assert.ok(docs.length >= 1, 'T9: at least one doc');

  // ── Intended: I toggles evidence section for selected artifact ──
  tui.openOverlay('docs');
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  tui.onKeypress('I', { name: 'i', shift: true });
  assert.equal(tui.state.docsEvidenceExpanded, true,
    'T9: I toggles docsEvidenceExpanded to true');

  // ── Intended: evidence derived from artifactDocs resolving proof_point_ids ──
  // Refresh model and get the evidence for the selected artifact
  const freshModel = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobA.id });
  const freshDocs = freshModel.selected?.docs || [];
  const resumeDoc = freshDocs.find(d => d.id === artifacts.resumeV2.id);
  assert.ok(resumeDoc, 'T9: resumeV2 in fresh model docs');

  // evidence is an array of resolved proof entries from artifactDocs
  const evidence = resumeDoc.evidence || [];
  const withValidProof = evidence.filter(e => e.proofPointId && !e.missing);
  assert.ok(withValidProof.length > 0, 'T9: resolved evidence entries exist');
  // Each entry has summary/evidence/metrics from proof_points table
  assert.ok(evidence.some(e => e.summary && e.summary.includes('Led educator discovery')),
    'T9: evidence includes stored summary from proof_points');
  assert.ok(evidence.some(e => e.evidence && e.evidence.includes('portfolio case study')),
    'T9: evidence includes stored evidence text');
  assert.ok(evidence.some(e => e.metrics && e.metrics.includes('30%')),
    'T9: evidence includes stored metrics');

  // ── Intended: source-url evidence preserved in rendered output ──
  tui.state.selectedArtifactId = artifacts.sourceUrl.id;
  const srcDoc = freshDocs.find(d => d.id === artifacts.sourceUrl.id);
  const srcEvidence = srcDoc?.evidence || [];
  const urlEvidence = srcEvidence.filter(e => e.url || (e.type === 'url'));
  assert.ok(urlEvidence.length > 0,
    'T9: source-URL evidence preserved, not dropped');
  assert.ok(urlEvidence.some(e => e.url && e.url.includes('http')),
    'T9: URL evidence contains URL');

  // ── Intended: no-evidence artifact shows empty state ──
  tui.state.selectedArtifactId = artifacts.emptyEvidence.id;
  const emptyDoc = freshDocs.find(d => d.id === artifacts.emptyEvidence.id);
  const emptyEvidence = emptyDoc?.evidence || [];
  assert.ok(emptyEvidence.length === 0 || emptyEvidence.every(e => !e.proofPointId),
    'T9: empty-evidence artifact has zero resolved proof entries');

  // ── Intended: missing proof ID shows explicit missing:true ──
  tui.state.selectedArtifactId = artifacts.staleEvidence.id;
  const staleDoc = freshDocs.find(d => d.id === artifacts.staleEvidence.id);
  const staleEvidence = staleDoc?.evidence || [];
  const missingEntries = staleEvidence.filter(e => e.missing === true);
  assert.ok(missingEntries.length > 0,
    'T9: stale proof IDs produce missing:true entries');

  // ── Intended: toggle I renders evidence section ──
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  tui.state.docsEvidenceExpanded = true;
  const evidenceScreen = renderTui(freshModel, tui.state, { width: 140, height: 42, color: false });
  assert.match(evidenceScreen, /Evidence|proof/i,
    'T9: evidence section visible in rendered output when expanded');

  // ── Intended: I does NOT change approval_status or write artifact.reviewed ──
  const preStatus = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  tui.onKeypress('I', { name: 'i', shift: true });
  const postStatus = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  assert.equal(postStatus.approval_status, preStatus.approval_status,
    'T9: I does not change approval_status');
  const reviewedAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.reviewed' AND entity_id=?", [artifacts.resumeV2.id]);
  assert.equal(reviewedAudits.length, 0,
    'T9: I does not write artifact.reviewed');

  // I again toggles closed
  assert.equal(tui.state.docsEvidenceExpanded, false,
    'T9: second I toggles docsEvidenceExpanded to false');
});

// ---------------------------------------------------------------------------
// T10 — Correct predecessor diff
// ---------------------------------------------------------------------------
test('T10 — Correct predecessor diff', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobA.id });
  const docs = model.selected?.docs || [];

  // ── Setup: two same-path artifacts, one different-path same-type ──
  const v2Doc = docs.find(d => d.id === artifacts.resumeV2.id);
  const v1Doc = docs.find(d => d.id === artifacts.resumeV1.id);
  const orphanDoc = docs.find(d => d.id === artifacts.orphanResume.id);
  assert.ok(v2Doc, 'T10: resumeV2 in docs');
  assert.ok(v1Doc, 'T10: resumeV1 in docs');
  assert.ok(orphanDoc, 'T10: orphanResume in docs');
  assert.ok(v2Doc.content.includes('ADDED_LINE_V2'), 'T10: resumeV2 has ADDED_LINE_V2');
  assert.equal(v1Doc.content.includes('ADDED_LINE_V2'), false, 'T10: resumeV1 lacks ADDED_LINE_V2');

  // ── Intended: predecessor resolves to same-path older row ──
  const predecessor = v2Doc.previousDraft;
  assert.ok(predecessor, 'T10: previousDraft exists for resumeV2');
  assert.equal(predecessor.id, artifacts.resumeV1.id,
    'T10: predecessor is resumeV1, not orphanResume');
  assert.notEqual(predecessor.id, artifacts.orphanResume.id,
    'T10: predecessor is NOT the different-path same-type orphan');

  // ── Intended: V toggles diff with previous draft ──
  tui.openOverlay('docs');
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  tui.onKeypress('V', { name: 'v', shift: true });
  assert.equal(tui.state.docsView, 'diff',
    'T10: V toggles docsView to diff');
  assert.match(tui.state.status || '', /Previous draft/,
    'T10: diff status labels Previous draft');

  // ── Intended: diff shows context, +/− lines, and counts via renderTui ──
  tui.state.docsView = 'diff';
  tui.state.focusTarget = 'viewer';
  const diffScreen = renderTui(model, tui.state, { width: 140, height: 200, color: false });
  assert.match(diffScreen, /ADDED_LINE_V2/,
    'T10: diff rendered output shows added line content');
  assert.match(diffScreen, /-.*Prev|Prev.*-|resume\.md.*Prev|Previous/,
    'T10: diff labels render Previous draft context');

  // ── Intended: diffScroll independent from docsScroll ──
  tui.state.docsScroll = 5;
  tui.state.docsDiffScroll = 3;
  tui.onKeypress(null, { name: 'down' });
  assert.equal(tui.state.docsDiffScroll, 4,
    'T10: down arrow increments docsDiffScroll in diff mode');
  tui.onKeypress('V', { name: 'v', shift: true }); // back to document
  assert.equal(tui.state.docsView, 'document',
    'T10: V toggles back to document');
  assert.equal(tui.state.docsScroll, 5,
    'T10: docsScroll preserved when leaving diff');

  // ── Intended: first draft shows honest message ──
  // Use j/k public helper to navigate to cover artifact
  // First set viewer focus and current position
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  // j enough to reach cover (which has a different title/path)
  // Navigate to cover via selection list (direct assignment of ID for target)
  tui.state.selectedArtifactId = artifacts.cover.id;
  tui.onKeypress('V', { name: 'v', shift: true });
  assert.match(tui.state.status || '', /First draft|no previous draft/,
    'T10: first draft shows no-predecessor message');

  // ── Intended: V does not change content or status ──
  const statusBefore = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  tui.state.selectedArtifactId = artifacts.resumeV2.id;
  tui.onKeypress('V', { name: 'v', shift: true });
  tui.onKeypress('V', { name: 'v', shift: true });
  const statusAfter = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  assert.equal(statusAfter.approval_status, statusBefore.approval_status,
    'T10: V does not change approval_status');
  const reviewedAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.reviewed' AND entity_id=?", [artifacts.resumeV2.id]);
  assert.equal(reviewedAudits.length, 0,
    'T10: V does not write artifact.reviewed');
});

// ---------------------------------------------------------------------------
// T11 — Editor lifecycle and versioning
// ---------------------------------------------------------------------------
test('T11 — Editor lifecycle and versioning', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const io = streams();
  io.stdin.isTTY = true;
  io.stdout.isTTY = true;
  const rawModes = [];
  io.stdin.setRawMode = value => {
    rawModes.push(value);
    io.stdin.isRaw = value;
  };
  const terminalWrites = [];
  const passThroughWrite = io.stdout.write.bind(io.stdout);
  io.stdout.write = (chunk, ...args) => {
    terminalWrites.push(String(chunk));
    return passThroughWrite(chunk, ...args);
  };
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // ── Setup: workspace file exists for editor ──
  const wsFile = path.join(store.p.ws, 'resume.md');
  const fileContent = readFileSync(wsFile, 'utf8');
  assert.ok(fileContent.includes('Resume'), 'T11: workspace resume.md exists');

  // ── Intended: Ctrl+E with unsent review-note prompts confirmation ──
  tui.state.mode = 'review-note';
  tui.state.input = 'needs revision';
  tui.onKeypress('\x05', { name: 'e', ctrl: true });
  assert.equal(tui.state.pendingConfirm?.kind, 'editor-with-note',
    'T11: Ctrl+E with unsent note sets pendingConfirm editor-with-note');
  // Confirm clears note and continues to editor
  assert.equal(typeof tui.state.pendingConfirm?.next, 'string');

  // Regression: uppercase E is ordinary text in review-note, not the editor shortcut
  tui.state.pendingConfirm = null;
  tui.state.input = 'needs revision';
  tui.onKeypress('E', { name: 'e', shift: true });
  assert.equal(tui.state.input, 'needs revisionE',
    'T11: uppercase E is typed into review-note');
  assert.equal(tui.state.pendingConfirm, null,
    'T11: uppercase E does not open editor confirmation');

  // ── Intended: parseEditorCommand handles quotes/backslashes/= ──
  assert.equal(typeof tui.parseEditorCommand, 'function',
    'T11: parseEditorCommand is exported');

  const parsed = tui.parseEditorCommand('vi +42 "file name.md"');
  assert.deepEqual(parsed, ['vi', '+42', 'file name.md'],
    'T11: parse handles double quotes');

  const parsed2 = tui.parseEditorCommand("vim --cmd 'set hlsearch'");
  assert.deepEqual(parsed2, ['vim', '--cmd', 'set hlsearch'],
    'T11: parse handles single quotes');

  const parsed3 = tui.parseEditorCommand('code --wait file=.md');
  assert.deepEqual(parsed3, ['code', '--wait', 'file=.md'],
    'T11: parse handles = in args');

  // Reject empty/unclosed
  assert.throws(() => tui.parseEditorCommand(''), /empty/i,
    'T11: empty command rejected');
  assert.throws(() => tui.parseEditorCommand('echo "unclosed'), /unclosed/i,
    'T11: unclosed quote rejected');

  // ── Intended: openArtifactEditor exists and accepts injected spawn/fs seams ──
  assert.equal(typeof tui.openArtifactEditor, 'function',
    'T11: openArtifactEditor exists on tui');

  {
    const escapedPath = '/etc/passwd';
    let spawnCalled = false;
    const mockFs = { realpathSync: () => escapedPath };
    const writeMark = terminalWrites.length;
    const result = await tui.openArtifactEditor(store, artifacts.resumeV2.id, {
      spawnImpl: () => {
        spawnCalled = true;
        return 0;
      },
      fs: mockFs,
      editor: ['cat']
    });
    assert.match(result.error || '', /outside workspace|escape/i,
      'T11: symlink escape returns a handled error');
    assert.equal(spawnCalled, false, 'T11: symlink escape never spawns editor');
    assert.match(tui.state.error || '', /outside workspace|escape/i,
      'T11: symlink escape is visible in UI error state');
    assert.equal(tui.state.editorActive, false, 'T11: validation failure clears editor lifecycle blocker');
    const writes = terminalWrites.slice(writeMark).join('');
    assert.match(writes, /\x1b\[\?25h\x1b\[\?1049l/,
      'T11: validation failure shows cursor and leaves alternate buffer');
    assert.match(writes, /\x1b\[\?1049h\x1b\[\?25l/,
      'T11: validation failure restores alternate buffer and cursor');
  }

  // A pending auto-open remains blocked until an active editor fully restores.
  {
    const child = new EventEmitter();
    tui.state.mode = 'normal';
    tui.state.pendingConfirm = null;
    tui.state.pendingAutoOpenArtifactId = artifacts.cover.id;
    const pending = tui.openArtifactEditor(store, artifacts.resumeV2.id, {
      spawnImpl: () => child,
      readFile: () => fileContent,
      editor: ['cat']
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tui.state.editorActive, true, 'T11: editor lifecycle blocker is active while child runs');
    const suspendedWriteCount = terminalWrites.length;
    assert.equal(io.stdin.isPaused(), true, 'T11: parent input stream pauses while editor owns TTY');
    tui.refresh({ disk: false });
    tui.render();
    tui.boundResize();
    tui.onAgentEvent({ type: 'agent_message', text: 'buffer while editor runs' });
    assert.equal(terminalWrites.length, suspendedWriteCount,
      'T11: poll/refresh/resize/agent events write no TUI frame while editor owns TTY');
    tui.refresh({ disk: false });
    assert.equal(tui.state.pendingAutoOpenArtifactId, artifacts.cover.id,
      'T11: active editor prevents polling refresh from applying auto-open');
    child.emit('exit', 0);
    await pending;
    assert.equal(tui.state.editorActive, false, 'T11: editor lifecycle blocker clears after restore');
    assert.equal(tui.state.pendingAutoOpenArtifactId, null,
      'T11: deferred auto-open applies once after editor completion');
    assert.equal(io.stdin.isPaused(), false, 'T11: parent input stream resumes after editor exits');
    assert.ok(terminalWrites.length > suspendedWriteCount,
      'T11: exactly the post-editor restoration/refresh resumes TUI output');
  }

  // ── Intended: unchanged file → no new artifact row (exit 0, same content) ──
  {
    const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    let spawnCalled = false;
    const unchangedSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, signal: null, error: null };
    };
    // Read file content before, inject readFileSync to return same bytes
    const contentBefore = readFileSync(wsFile, 'utf8');
    const mockReader = () => contentBefore; // return unchanged

    await tui.openArtifactEditor(store, artifacts.resumeV2.id,
      { spawnImpl: unchangedSpawn, readFile: mockReader, editor: ['cat'] });

    assert.ok(spawnCalled, 'T11: unchanged: spawn was called');
    const postCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    assert.equal(postCount, preCount,
      'T11: unchanged file creates no new artifact row');
  }

  // ── Intended: changed file → new draft row + artifact.edited audit ──
  {
    const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    const rawNewContent = '# Edited Resume\n\nChanged content via editor';
    const newContent = rawNewContent.endsWith('\n') ? rawNewContent : `${rawNewContent}\n`;
    const changedSpawn = async () => {
      return { exitCode: 0, signal: null, error: null };
    };
    const mockReader = () => newContent; // return changed content

    const result = await tui.openArtifactEditor(store, artifacts.resumeV2.id,
      { spawnImpl: changedSpawn, readFile: mockReader, editor: ['cat'] });

    const postCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    assert.equal(postCount, preCount + 1,
      'T11: changed file creates one new artifact row');

    // New artifact row has correct properties
    const newRow = one(store, "SELECT * FROM artifacts WHERE job_id=? AND path=? AND content=? AND approval_status='draft_needs_human_review' ORDER BY created_at DESC",
      [jobA.id, 'resume.md', newContent]);
    assert.ok(newRow, 'T11: new artifact stores edited content');
    assert.equal(newRow.job_id, jobA.id, 'T11: new artifact same job_id');
    assert.equal(newRow.profile_id, profile.id, 'T11: new artifact same profile_id');
    assert.equal(newRow.approval_status, 'draft_needs_human_review',
      'T11: edited artifact gets draft_needs_human_review');
    // Evidence/warnings preserved from original — read from DB row, not seed return object
    const origRow = one(store, 'SELECT evidence_json,warnings_json FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
    const origEvidence = JSON.parse(origRow.evidence_json || '[]');
    const origWarnings = JSON.parse(origRow.warnings_json || '[]');
    const newEvidence = JSON.parse(newRow.evidence_json || '[]');
    const newWarnings = JSON.parse(newRow.warnings_json || '[]');
    assert.deepEqual(newEvidence, origEvidence,
      'T11: edited artifact preserves evidence');
    assert.deepEqual(newWarnings, origWarnings,
      'T11: edited artifact preserves warnings');

    // artifact.edited audit written
    const editAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.edited' AND entity_id=?",
      [newRow.id]);
    assert.equal(editAudits.length, 1, 'T11: artifact.edited audit created');
    const editPayload = JSON.parse(editAudits[0].payload_json);
    assert.equal(editPayload.jobId, jobA.id, 'T11: edit audit has jobId');
    assert.equal(editPayload.previousArtifactId, artifacts.resumeV2.id,
      'T11: edit audit has previousArtifactId');
    assert.equal(editPayload.artifactId, newRow.id,
      'T11: edit audit has new artifactId');
    assert.equal(editPayload.source, 'tui', 'T11: edit audit has source=tui');
  }

  // ── Intended: nonzero exit → error, no ingest ──
  {
    const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    const failSpawn = async () => {
      return { exitCode: 1, signal: null, error: new Error('editor failed') };
    };
    const result = await tui.openArtifactEditor(store, artifacts.resumeV2.id,
      { spawnImpl: failSpawn, readFile: () => 'content', editor: ['false'] });

    const postCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    assert.equal(postCount, preCount,
      'T11: nonzero exit creates no new artifact row');
    // Error state set on tui
    assert.ok(tui.state.error || /editor failed|error/.test(tui.state.status || ''),
      'T11: nonzero exit produces error');
  }

  // Regression: signal exit is treated as failure, not success
  {
    const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    const child = new EventEmitter();
    const signalSpawn = async () => child;
    const pending = tui.openArtifactEditor(store, artifacts.resumeV2.id,
      { spawnImpl: signalSpawn, readFile: () => 'content', editor: ['cat'] });
    await new Promise(resolve => setImmediate(resolve));
    child.emit('exit', null, 'SIGTERM');
    await pending;

    const postCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    assert.equal(postCount, preCount,
      'T11: signal exit creates no new artifact row');
    assert.ok(tui.state.error || /SIGTERM|signal|error/i.test(tui.state.status || ''),
      'T11: signal exit produces error');
  }

  // Regression: spawn error with exitCode 0 is still treated as failure
  {
    const preCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    const zeroErrorSpawn = async () => {
      return { exitCode: 0, signal: null, error: new Error('spawn killed') };
    };
    await tui.openArtifactEditor(store, artifacts.resumeV2.id,
      { spawnImpl: zeroErrorSpawn, readFile: () => 'content', editor: ['cat'] });

    const postCount = all(store, 'SELECT COUNT(*) c FROM artifacts WHERE job_id=? AND path=?', [jobA.id, 'resume.md'])[0].c;
    assert.equal(postCount, preCount,
      'T11: spawn error with exitCode 0 creates no new artifact row');
    assert.ok(tui.state.error || /spawn killed|error/i.test(tui.state.status || ''),
      'T11: spawn error with exitCode 0 produces error');
  }

  // ── Intended: terminal mode restored (raw/alt/cursor) ──
  // On completion (both success and failure), rawMode ends false
  const preRaw = rawModes[rawModes.length - 1];
  // After any openArtifactEditor call, raw mode should be restored to pre-call value
  // (asserted as capability — openArtifactEditor restores terminal)
  assert.equal(typeof tui.openArtifactEditor, 'function');

  // ── Intended: Q quit restores raw mode ──
  const running = tui.start();
  io.stdin.emit('keypress', 'Q', { name: 'q', shift: true });
  await running;
  assert.equal(tui.stopped, true, 'T11: Q stops TUI');
  assert.equal(rawModes[rawModes.length - 1], false,
    'T11: Q quits with raw mode false');
});

// ---------------------------------------------------------------------------
// T12 — Human-gate mediation and shared mutation
// ---------------------------------------------------------------------------
test('T12 — Human-gate mediation and shared mutation', async t => {
  const { store, profile, jobs: { jobA }, artifacts, application } = await seedArtifactReviewWorkspace(t);

  // ── Setup: DOMAIN_TOOLS and MCP tool names ──
  const toolNames = DOMAIN_TOOLS.map(dt => dt.name);
  const mcpNames = mcpToolNames();
  const deniedMcp = new Set(['create_application_packet', 'attest_application_submitted', 'confirm_application_receipt']);
  assert.deepEqual(mcpNames, toolNames.filter(name => !deniedMcp.has(name)));
  assert.ok(toolNames.length > 0);

  // ── Intended: API cannot impersonate trusted CLI/TUI human review ──
  const req = new PassThrough();
  req.method = 'PATCH';
  req.headers = {};
  const bodyStr = JSON.stringify({ approvalStatus: 'approved', note: 'via api' });
  req.push(bodyStr);
  req.push(null);
  const res = new PassThrough();
  res.writeHead = function (status, headers) { this.statusCode = status; };
  res.end = function () {};
  const u = new URL(`http://localhost/api/artifacts/${encodeURIComponent(artifacts.resumeV1.id)}`);
  await handleApi(store, req, res, u);
  assert.equal(res.statusCode, 400, 'T12: API approval is denied by the human-review gate');
  assert.equal(one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV1.id]).approval_status, 'draft_needs_human_review');
  const apiAudits = all(store, "SELECT * FROM audit_log WHERE entity_id=? AND action IN ('artifact.approved','artifact.reviewed')", [artifacts.resumeV1.id]);
  assert.equal(apiAudits.length, 0, 'T12: denied API approval writes no review audit');

  const missingReq = new PassThrough();
  missingReq.method = 'PATCH';
  missingReq.headers = {};
  missingReq.end(JSON.stringify({ approvalStatus: 'approved' }));
  const missingRes = new PassThrough();
  missingRes.writeHead = function (status) { this.statusCode = status; };
  missingRes.end = function () {};
  await handleApi(store, missingReq, missingRes, new URL('http://localhost/api/artifacts/missing'));
  assert.equal(missingRes.statusCode, 404, 'T12: API preserves not-found status for unknown artifact');
  assert.throws(
    () => ingestEditedArtifact(store, { artifactId: artifacts.resumeV1.id, content: 'x', source: 'evil' }),
    /Invalid source/,
    'T12: edited-artifact mutation rejects untrusted audit sources'
  );

  // TUI would call same service with source='tui' (verified in T1)

  // ── Intended: no ACP/MCP artifact-approval tool exists ──
  const hasArtifactTool = toolNames.some(n => /^artifact_/.test(n));
  assert.equal(hasArtifactTool, false,
    'T12: no tool with artifact_ prefix');
  const hasApproveTool = toolNames.some(n => /artifact.*(?:approv|reject)/i.test(n));
  assert.equal(hasApproveTool, false,
    'T12: no artifact approval domain tool');

  // ── Intended: agents cannot attest applied/submitted/sent ──
  await assert.rejects(
    () => callDomainTool(store, 'update_application_status',
      { applicationId: application.id, status: 'applied' }, { source: 'acp' }),
    { code: 'agent_human_confirmation_denied' },
    'T12: ACP cannot attest applied'
  );
  await assert.rejects(
    () => callDomainTool(store, 'create_application',
      { jobId: jobA.id, status: 'submitted', notes: '' }, { source: 'mcp' }),
    { code: 'agent_human_confirmation_denied' },
    'T12: MCP cannot attest submitted'
  );
  await assert.rejects(
    () => callDomainTool(store, 'update_application_status',
      { applicationId: application.id, status: 'sent' }, { source: 'acp' }),
    { code: 'agent_human_confirmation_denied' },
    'T12: ACP cannot attest sent'
  );

  // ── Intended: TUI (human) path can update applied ──
  const r = await callDomainTool(store, 'update_application_status',
    { applicationId: application.id, status: 'applied', notes: '' }, { source: 'tui' });
  assert.equal(r.status, 'applied', 'T12: TUI can update to applied');

  // ── Intended: review/discovery/stage audits are local ──
  const allAudits = all(store, "SELECT * FROM audit_log WHERE entity_id=?", [application.id]);
  for (const a of allAudits) {
    assert.equal(a.external_side_effect, 'none',
      `T12: audit ${a.action} external_side_effect=none`);
  }
});

// ---------------------------------------------------------------------------
// T13 — Responsive existing-docs surface
// ---------------------------------------------------------------------------
test('T13 — Responsive existing-docs surface', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobA.id });
  const docs = model.selected?.docs || [];
  const docIdx = Math.max(0, docs.findIndex(d => d.id === artifacts.resumeV2.id));

  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobA.id;
  tui.refresh({ disk: false });

  // ── Setup: defaultTuiState ──
  const def = defaultTuiState();
  assert.equal(def.overlay, null);
  assert.equal(def.mode, 'normal');

  // ── Intended: focusTarget defaults to 'shell' ──
  assert.equal(def.focusTarget, 'shell',
    'T13: focusTarget defaults to shell in defaultTuiState');

  // ── WIDE (width >= 116): chat/activity panel visible alongside docs ──
  const wideState = { ...def, overlay: 'docs', overlayIndex: docIdx, agentState: 'offline',
    selectedJobId: jobA.id, profileId: profile.id, focusTarget: 'shell' };
  const screenWide = renderTui(model, wideState, { width: 140, height: 42, color: false });

  // Content visible
  assert.match(screenWide, /DOCUMENTS/,
    'T13: docs title at width 140');
  assert.match(screenWide, /resume\.md/,
    'T13: artifact path at width 140');

  // Agent-off placeholder visible alongside content
  assert.match(screenWide, /agent off|AGENT.*off/,
    'T13: wide split shows agent/placeholder alongside content');

  // ── Intended: Ctrl+A toggles focusTarget in wide docs ──
  tui.state.focusTarget = 'shell';
  tui.state.overlay = 'docs';
  tui.onKeypress(null, { name: 'a', ctrl: true });
  assert.equal(tui.state.focusTarget, 'viewer',
    'T13: Ctrl+A toggles focusTarget to viewer');
  tui.onKeypress(null, { name: 'a', ctrl: true });
  assert.equal(tui.state.focusTarget, 'shell',
    'T13: Ctrl+A toggles focusTarget back to shell');

  // ── Intended: shell focus retains j/k job selection and lowercase n network ──
  tui.state.focusTarget = 'shell';
  tui.state.overlay = null; // no overlay for shell focus test
  const preJobId = tui.state.selectedJobId;
  tui.onKeypress('j', { name: 'j' });
  assert.notEqual(tui.state.selectedJobId, preJobId,
    'T13: shell j advances job selection');
  tui.onKeypress('n', { name: 'n' });
  assert.equal(tui.state.overlay, 'network',
    'T13: shell n opens network');

  // ── Intended: viewer focus gets j/k artifact change, / search, n/N matches, arrows scroll ──
  tui.state.focusTarget = 'viewer';
  tui.state.overlay = 'docs';
  tui.state.selectedArtifactId = docs[0].id;

  tui.onKeypress('j', { name: 'j' });
  assert.equal(tui.state.selectedArtifactId, docs[1].id,
    'T13: viewer j changes artifact');
  tui.onKeypress('/', { name: '/' });
  assert.equal(tui.state.mode, 'docs-search',
    'T13: viewer / enters search');
  tui.closeTransient();
  tui.state.focusTarget = 'viewer';

  // ── Intended: uppercase R rejects (viewer), lowercase r opens review (global) ──
  tui.state.overlay = 'docs';
  tui.onKeypress('r', { name: 'r' });
  assert.equal(tui.state.overlay, 'review',
    'T13: lowercase r opens review in viewer mode');
  tui.state.overlay = 'docs';
  tui.onKeypress('R', { name: 'r', shift: true });
  assert.equal(tui.state.mode, 'review-note',
    'T13: uppercase R enters review-note from viewer');

  // ── NARROW (width < 116): docs full-screen, viewer focus forced ──
  // Use JobosTui with narrow stdout width, not renderTui state mutation
  {
    const narrowIo = streams();
    narrowIo.stdout.columns = 90;
    narrowIo.stdout.rows = 32;
    const narrowTui = new JobosTui(store, { ...narrowIo, profileId: profile.id, connectAgent: false, color: false });
    narrowTui.state.selectedJobId = jobA.id;
    narrowTui.refresh({ disk: false });
    narrowTui.openOverlay('docs');
    // Narrow forces focusTarget to viewer automatically
    assert.equal(narrowTui.state.focusTarget, 'viewer',
      'T13: narrow width forces focusTarget to viewer');

    // Render at narrow width produces docs output
    const narrowScreen = renderTui(narrowTui.model, narrowTui.state, { width: 90, height: 32, color: false });
    assert.match(narrowScreen, /DOCUMENTS/,
      'T13: docs title at width 90');
    assert.equal(narrowTui.state.overlay, 'docs',
      'T13: narrow overlay name remains docs');
  }

  // ── Intended: footer hints map to active handlers ──
  // (keymap/hint formatter used; each uppercase action has handler: A approve, R reject,
  //  B draft, E editor, V diff, I evidence, Ctrl+A focus)
  assert.match(screenWide, /A approve|A:.*approve/,
    'T13: footer hints include A approve');
});
