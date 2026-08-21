import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appUpdate } from '../src/tracking.js';
import { tailor } from '../src/tailoring.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import { addAnswer } from '../src/answers.js';
import { buildFormSnapshot, persistFormSnapshot } from '../src/forms.js';
import { DOM_ADAPTER_MANIFEST } from '../src/form-browser.js';
import { JobosTui, renderTui } from '../src/tui.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';
import { ingestEditedArtifact } from '../src/artifacts.js';
import { seedArtifactReviewWorkspace } from './fixtures/artifact-review-seed.js';
import { createCompleteResumeFixture } from './fixtures/resume.js';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

function makeTui(store, profileId, jobId) {
  const tui = new JobosTui(store, { ...streams(), profileId, selectedJobId: jobId, connectAgent: false, color: false });
  tui.state.selectedJobId = jobId;
  tui.refresh();
  return tui;
}

/** Drive readiness to the exact form-ready bound through real domain writes. */
async function driveToFormReady(store, profile, job) {
  for (let round = 0; round < 3; round++) {
    const plan = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id });
    if (plan.status === 'materials-ready') break;
    for (const q of plan.answers.questions) {
      if (q.status === 'unmatched') {
        addAnswer(store, { profileId: profile.id, category: q.category, question: q.question, answer: 'A verified response grounded in stored evidence.', sensitivity: 'public', verificationStatus: 'verified' });
      } else if (q.status === 'blocked') {
        addAnswer(store, { profileId: profile.id, category: q.category, question: q.question, answer: 'direct-response', sensitivity: 'restricted', reuseScope: 'never_auto_fill', sourceRef: `job:${job.id}`, verificationStatus: 'verified' });
      }
    }
    for (const artifactId of plan.review.pendingArtifactIds) {
      await callDomainTool(store, 'approve_artifact', { artifactId }, { source: 'tui' });
    }
  }
  persistFormSnapshot(store, buildFormSnapshot({
    snapshotId: 'form_tui_apply_loop',
    jobId: job.id,
    profileId: profile.id,
    capturedAt: '2026-07-22T12:00:00.000Z',
    requestedUrl: 'https://apply.example.test/jobs/tui/apply',
    finalUrl: 'https://apply.example.test/jobs/tui/apply',
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frameKey: 'main', formKey: 'application', candidateCount: 1, score: 10 },
    fields: [{ frameKey: 'main', locatorPath: '#name', prompt: 'Full name', control: 'text', required: false }],
    warnings: []
  }));
  const plan = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id });
  assert.equal(plan.status, 'form-ready', `expected form-ready, got ${plan.status}: ${plan.blockers.map(b => b.code).join(',')}`);
  return plan;
}

test('ART-01 Files overlay lists the exact current revision per series plus questions.md as a reference copy', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  tui.openOverlay('files');
  const screen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(screen, /FILES · THIS JOB/, 'files overlay identity');
  assert.match(screen, /Resume v2/, 'the current resume revision is listed');
  assert.match(screen, /Cover Letter/, 'the cover draft is listed');
  assert.match(screen, /questions\.md/, 'questions.md is the reference copy');
  assert.doesNotMatch(screen, /Resume v1/, 'older superseded revisions are not review targets');
  assert.doesNotMatch(screen, /ADDED_LINE_V2/, 'artifact contents are not dumped into the overlay chrome');
  const rows = tui.model.selected.docs.filter(doc => doc.id === artifacts.resumeV2.id);
  assert.equal(rows.length, 1, 'the exact revision is the current doc');

  // The questions row is the last Files row; its detail names the restricted-answer gate.
  const filesRowsList = tui.model.selected.docs.length; // every artifact series, then questions
  tui.state.overlayIndex = filesRowsList;
  const questionsScreen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(questionsScreen, /restricted answers stay gated/, 'questions copy states the restricted-answer gate');
});

test('ART-02 approve targets the highlighted artifact, writes one audit, and drains the review queue', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  assert.ok(tui.model.review.some(r => r.id === artifacts.resumeV2.id), 'resumeV2 is queued');
  tui.openOverlay('files');
  const idx = tui.model.selected.docs.findIndex(doc => doc.id === artifacts.resumeV2.id);
  tui.state.overlayIndex = Math.max(0, idx);
  await tui.approveSelectedArtifact();
  const afterA = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.resumeV2.id]);
  assert.equal(afterA.approval_status, 'approved', 'approval persists');
  const auditsA = all(store, "SELECT * FROM audit_log WHERE action='artifact.approved' AND entity_id=?", [artifacts.resumeV2.id]);
  assert.equal(auditsA.length, 1, 'exactly one artifact.approved audit');
  const aPayload = JSON.parse(auditsA[0].payload_json);
  assert.equal(aPayload.jobId, jobA.id);
  assert.equal(aPayload.approvalStatus, 'approved');
  assert.equal(aPayload.reviewedBy, 'tui');
  assert.equal(auditsA[0].external_side_effect, 'none');
  assert.equal(tui.model.review.some(r => r.id === artifacts.resumeV2.id), false, 'approved item leaves the review queue');
  assert.match(tui.state.status, /Draft approved · local review/);
  // Approving again is a no-op with guidance, never a second audit.
  await tui.approveSelectedArtifact();
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='artifact.approved' AND entity_id=?", [artifacts.resumeV2.id]).n, 1);
});

test('ART-03 reject requires a human reason and writes the rejection audit', async t => {
  const { store, profile, jobs: { jobA }, artifacts } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  tui.openOverlay('files');
  const idx = tui.model.selected.docs.findIndex(doc => doc.id === artifacts.cover.id);
  tui.state.overlayIndex = Math.max(0, idx);
  tui.handleKey('r', { name: 'r' });
  assert.ok(tui.state.filesReason, 'reject opens the reason editor');
  tui.handleKey('', { name: 'return' });
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='artifact.rejected'").n, 0, 'empty rejection writes zero audits');
  for (const char of 'needs more metrics') tui.handleKey(char, { name: char });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 60));
  const afterReject = one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [artifacts.cover.id]);
  assert.equal(afterReject.approval_status, 'rejected', 'rejection persists');
  const rejectAudits = all(store, "SELECT * FROM audit_log WHERE action='artifact.rejected' AND entity_id=?", [artifacts.cover.id]);
  assert.ok(rejectAudits.length >= 1, 'artifact.rejected audit written');
  const rPayload = JSON.parse(rejectAudits[rejectAudits.length - 1].payload_json);
  assert.equal(rPayload.reviewNote, 'needs more metrics');
  assert.equal(rPayload.reviewedBy, 'tui');
  assert.match(tui.state.status, /Draft rejected · local review/);
});

test('ART-04 questions.md is a reference copy and never an approve/reject target', async t => {
  const { store, profile, jobs: { jobA } } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  tui.openOverlay('files');
  const rows = tui.model.selected.docs;
  const questionsIndex = rows.length; // appended after every artifact series
  tui.state.overlayIndex = questionsIndex;
  const before = one(store, 'SELECT COUNT(*) AS n FROM audit_log').n;
  tui.handleKey('a', { name: 'a' });
  assert.match(tui.state.status, /questions\.md is a reference copy/, 'approve on questions is refused');
  tui.handleKey('r', { name: 'r' });
  assert.match(tui.state.status, /reference copy/, 'reject on questions is refused');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM audit_log').n, before, 'no audits from the reference copy');
});

test('ART-05 tracker mutates only pre-apply stages; applied is attestation-only', async t => {
  const { store, profile, jobs: { jobA, jobB }, application } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  const scBefore = one(store, 'SELECT COUNT(*) AS n FROM status_changes WHERE application_id=?', [application.id]).n;
  const statusAuditsBefore = one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='application.status_changed' AND entity_id=?", [application.id]).n;
  await tui.applyApplicationStatus('materials-ready');
  const after = one(store, 'SELECT status FROM applications WHERE id=?', [application.id]);
  assert.equal(after.status, 'materials-ready', 'pre-apply stage persists');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM status_changes WHERE application_id=?', [application.id]).n, scBefore + 1, 'exactly one new status_changes row for the transition');
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='application.status_changed' AND entity_id=?", [application.id]).n, statusAuditsBefore + 1, 'one status_changed audit for the transition');

  const preAppCount = all(store, 'SELECT id FROM applications').length;
  const preSCount = all(store, 'SELECT id FROM status_changes').length;
  await tui.applyApplicationStatus('applied');
  assert.match(tui.state.status, /attestation only/, 'applied is refused as a manual stage');
  assert.equal(all(store, 'SELECT id FROM applications').length, preAppCount, 'refused stage creates no application');
  assert.equal(all(store, 'SELECT id FROM status_changes').length, preSCount, 'refused stage creates no status_changes');

  // A job with no application gets one created at a settable stage.
  const tuiB = makeTui(store, profile.id, jobB.id);
  await tuiB.applyApplicationStatus('saved');
  const created = one(store, 'SELECT * FROM applications WHERE job_id=? AND profile_id=?', [jobB.id, profile.id]);
  assert.ok(created, 'application created for the pipeline job');
  assert.equal(created.status, 'saved');
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='application.created' AND entity_id=?", [created.id]).n, 1);
});

test('ART-06 packet freeze requires approved readiness and attestation binds applied', async t => {
  // Tailor-based workspace: canonical resume + proof + drafted resume artifact
  // (the exact bound the packet path was designed for).
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-artifact-packet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  const proof = addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio', ['product'], ['30%']);
  createCompleteResumeFixture(store, profile, proof);
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\n## Requirements\n- Must lead educator discovery and launch a learning platform that improves activation.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  await callDomainTool(store, 'score_job', { jobId: job.id, profileId: profile.id }, { source: 'tui' });
  await tailor(store, job.id, profile.id, 'resume');

  const tui = makeTui(store, profile.id, job.id);
  await tui.freezePacket();
  assert.match(tui.state.status, /readiness|Pending artifact review/i, 'freeze refuses unapproved readiness');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM application_packets').n, 0);

  await tui.attestSubmission();
  assert.match(tui.state.status, /No packet to attest/, 'attestation without a packet is refused');

  // Drive the exact bound: answer open questions, approve every pending draft,
  // and persist the inspected form snapshot so readiness is form-ready.
  await driveToFormReady(store, profile, job);
  await tui.freezePacket();
  assert.match(tui.state.status, /Packet frozen/, 'freeze persists once readiness is approved');
  const packet = one(store, 'SELECT * FROM application_packets WHERE job_id=? AND profile_id=?', [job.id, profile.id]);
  assert.ok(packet, 'packet row persisted');
  assert.equal(packet.readiness_status_at_create, 'form-ready');
  assert.equal(packet.created_by_source, 'tui');
  assert.ok(tui.model.selected.readiness.packet.currentPacketId, 'readiness exposes the current packet');

  await tui.attestSubmission();
  const receipt = one(store, "SELECT * FROM application_receipts WHERE packet_id=? AND type='user_attestation'", [packet.id]);
  assert.ok(receipt, 'attestation receipt persisted');
  assert.equal(receipt.source, 'tui', 'attestation is a trusted human source');
  assert.equal(one(store, 'SELECT status FROM applications WHERE job_id=?', [job.id]).status, 'applied', 'attestation binds pre-apply to applied');
  assert.match(tui.state.status, /Attested/, 'attestation reports the local status change');
});

test('ART-07 human-gate mediation: agents cannot attest, freeze, or spoof sources', async t => {
  const { store, jobs: { jobA }, artifacts, application } = await seedArtifactReviewWorkspace(t);

  const toolNames = DOMAIN_TOOLS.map(dt => dt.name);
  const mcpNames = mcpToolNames();
  const deniedMcp = new Set([
    'approve_artifact', 'reject_artifact', 'approve_contact', 'answers_add',
    'create_application_packet', 'attest_application_submitted', 'confirm_application_receipt',
    'checkpoint_application_form', 'verify_interview_story', 'retire_interview_story',
    'add_interview_question_source', 'record_interview_debrief', 'correct_interview_debrief',
    'record_job_feedback', 'correct_memory_observation', 'undo_memory_observation',
    'accept_memory_proposal', 'reject_memory_proposal', 'revoke_memory_proposal',
    'undo_memory_transition',
    'network_contact_record',
    'mark_outreach_sent',
  ]);
  assert.deepEqual(mcpNames, toolNames.filter(name => !deniedMcp.has(name)));
  assert.ok(toolNames.length > 0);

  assert.throws(
    () => ingestEditedArtifact(store, { artifactId: artifacts.resumeV1.id, content: 'x', source: 'evil' }),
    /Invalid source/,
    'edited-artifact mutation rejects untrusted audit sources'
  );

  for (const name of deniedMcp) {
    assert.equal(mcpNames.includes(name), false, `MCP does not advertise ${name}`);
  }

  await assert.rejects(
    () => callDomainTool(store, 'update_application_status',
      { applicationId: application.id, status: 'applied' }, { source: 'acp' }),
    { code: 'agent_human_confirmation_denied' },
    'ACP cannot attest applied'
  );
  await assert.rejects(
    () => callDomainTool(store, 'create_application',
      { jobId: jobA.id, status: 'submitted', notes: '' }, { source: 'mcp' }),
    { code: 'agent_human_confirmation_denied' },
    'MCP cannot attest submitted'
  );
  await assert.rejects(
    () => callDomainTool(store, 'update_application_status',
      { applicationId: application.id, status: 'sent' }, { source: 'acp' }),
    { code: 'agent_human_confirmation_denied' },
    'ACP cannot attest sent'
  );
  await assert.rejects(
    () => callDomainTool(store, 'create_application_packet',
      { jobId: jobA.id, profileId: application.profile_id }, { source: 'mcp' }),
    { code: 'human_packet_freeze_required' },
    'MCP cannot freeze a packet'
  );

  const r = await callDomainTool(store, 'update_application_status',
    { applicationId: application.id, status: 'applied', notes: '' }, { source: 'tui' });
  assert.equal(r.status, 'applied', 'TUI can update to applied');

  const allAudits = all(store, "SELECT * FROM audit_log WHERE entity_id=?", [application.id]);
  for (const a of allAudits) {
    assert.equal(a.external_side_effect, 'none', `audit ${a.action} external_side_effect=none`);
  }
});

test('ART-08 status-note and no-op semantics stay authoritative', async t => {
  const { store, application } = await seedArtifactReviewWorkspace(t);
  assert.equal(application.status, 'researching');
  assert.equal(application.notes, 'keep-me');

  const preScAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c;
  const r1 = appUpdate(store, application.id, 'materials-ready', 'n1');
  assert.equal(r1.notes, 'n1', 'change+note writes application notes');
  const sc1 = one(store, "SELECT * FROM status_changes WHERE application_id=? ORDER BY created_at DESC", [application.id]);
  assert.equal(sc1.note, 'n1', 'change+note writes status_changes.note');
  assert.equal(sc1.to_status, 'materials-ready');
  assert.equal(all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=? AND action='application.status_changed'", [application.id])[0].c, preScAudits + 1);

  const r2 = appUpdate(store, application.id, 'applied');
  assert.equal(r2.notes, 'n1', 'change+omit preserves existing notes');

  const preNotes = one(store, 'SELECT notes FROM applications WHERE id=?', [application.id]).notes;
  const preScCount = all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c;
  const preAudits = all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c;
  appUpdate(store, application.id, 'applied');
  assert.equal(one(store, 'SELECT notes FROM applications WHERE id=?', [application.id]).notes, preNotes, 'same+omit leaves notes unchanged');
  assert.equal(all(store, 'SELECT COUNT(*) c FROM status_changes WHERE application_id=?', [application.id])[0].c, preScCount, 'same+omit adds no status_changes');
  assert.equal(all(store, "SELECT COUNT(*) c FROM audit_log WHERE entity_id=?", [application.id])[0].c, preAudits, 'same+omit adds zero audits');

  assert.throws(() => appUpdate(store, application.id, 'invalid_status'), /Invalid status/);
});

test('ART-09 external apply and send are user-configured, default off, and never claimed', async t => {
  const { store, profile, jobs: { jobA } } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  const selected = tui.model.selected;
  assert.ok(selected.policy, 'readiness exposes policy');
  assert.equal(selected.policy.externalApply, 'user_configured_default_off');
  assert.equal(tui.model.policy.autoApply, 'disabled');
  assert.equal(tui.model.policy.autoSend, 'disabled');
  const screen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.doesNotMatch(screen, /submitted successfully|application sent|applied on your behalf/, 'no external submit claim');
  assert.doesNotMatch(screen, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');
});

test('ART-10 selected job survives external disk mutation and unrelated scoring', async t => {
  const { store, profile, jobs: { jobA, jobB } } = await seedArtifactReviewWorkspace(t);
  const tui = makeTui(store, profile.id, jobA.id);
  // Persist a changed row through a second store on the same workspace; the
  // controller refresh must observe the external disk write via reload.
  const store2 = await openStore({ workspace: tui.store.root });
  run(store2, "UPDATE jobs SET title=? WHERE id=?", ['Externally renamed', jobA.id]);
  save(store2);
  tui.refresh();
  assert.equal(tui.model.jobs.find(item => item.id === jobA.id)?.title, 'Externally renamed', 'refresh observes the externally persisted title');
  assert.equal(tui.state.selectedJobId, jobA.id, 'selection survives a disk refresh');
  await callDomainTool(tui.store, 'score_job', { jobId: jobB.id, profileId: profile.id }, { source: 'tui' });
  tui.refresh();
  assert.equal(tui.state.selectedJobId, jobA.id, 'selection survives unrelated mutation');
});
