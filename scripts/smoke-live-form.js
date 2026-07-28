import { seedW02Workspace } from '../tests/fixtures/w02-seed.js';
import { startFormServer } from '../tests/fixtures/form-server.js';
import { inspectLiveForm } from '../src/form-browser.js';
import { fillApplicationForm, checkpointApplicationForm } from '../src/form-actions.js';
import { submitApplicationForm } from '../src/form-submission.js';
import { createApplicationPacket, attestApplicationSubmitted, showApplicationPacket } from '../src/packets.js';

async function withFixtureFlow(mode) {
  const cleanups = [];
  const context = { after(cleanup) { cleanups.push(cleanup); } };
  try {
    const fixture = await seedW02Workspace(context);
    const server = await startFormServer(context);
    const browserProfile = `smoke-${mode}`;
    const snapshot = await inspectLiveForm(fixture.store, { jobId: fixture.job.id,
    profileId: fixture.profile.id,
    url: server.url('/application-configured.html'),
    browserProfile, protectRequests: false });
    const packet = createApplicationPacket(fixture.store, {
      jobId: fixture.job.id,
      profileId: fixture.profile.id,
      createdBy: 'cli'
    });
    const fill = await fillApplicationForm(fixture.store, { packetId: packet.id,
    workspace: fixture.root,
    browserProfile,
    allowSideEffects: true, protectRequests: false });
    const checkpoint = checkpointApplicationForm(fixture.store, {
      packetId: packet.id,
      fillRunId: fill.fillRunId,
      confirmedFieldKeys: fill.humanActionFieldKeys,
      source: 'cli'
    });
    if (mode === 'manual') {
      const response = await fetch(`${server.baseUrl}/submit/application?outcome=confirmed`, { method: 'POST' });
      if (!response.ok) throw new Error(`Manual fixture submit failed: ${response.status}`);
      const attestation = attestApplicationSubmitted(fixture.store, {
        packetId: packet.id,
        submittedAt: new Date().toISOString(),
        note: 'Live-form smoke manual submission',
        source: 'cli'
      });
      if (attestation.submissionPerformed !== false || attestation.externalSideEffects !== 'none') {
        throw new Error('Manual smoke flow claimed configured submission side effects');
      }
      return { mode, snapshotId: snapshot.snapshotId, packetId: packet.id, fillRunId: fill.fillRunId, checkpointId: checkpoint.checkpointId, receiptState: showApplicationPacket(fixture.store, packet.id).receiptState, submissionPerformed: false, externalSideEffects: 'none', submitCount: server.state.submits };
    }
    const submission = await submitApplicationForm(fixture.store, { packetId: packet.id,
    checkpointId: checkpoint.checkpointId,
    workspace: fixture.root,
    browserProfile,
    allowSubmit: true,
    invokedBy: 'cli', protectRequests: false });
    if (submission.status !== 'confirmed' || submission.submissionPerformed !== true || submission.externalSideEffects !== 'user_configured_form_submission') {
      throw new Error(`Configured smoke flow was not confirmed honestly: ${submission.status}`);
    }
    return { mode, snapshotId: snapshot.snapshotId, packetId: packet.id, fillRunId: fill.fillRunId, checkpointId: checkpoint.checkpointId, receiptState: showApplicationPacket(fixture.store, packet.id).receiptState, submissionPerformed: true, externalSideEffects: submission.externalSideEffects, submitCount: server.state.submits };
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

const previousFill = process.env.JOBOS_FORM_FILL_ENABLED;
const previousSubmit = process.env.JOBOS_FORM_SUBMIT_ENABLED;
process.env.JOBOS_FORM_FILL_ENABLED = '1';
process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
try {
  const manual = await withFixtureFlow('manual');
  const configured = await withFixtureFlow('configured');
  if (manual.submitCount !== 1 || configured.submitCount !== 1 || manual.receiptState !== 'attested' || configured.receiptState !== 'confirmed') {
    throw new Error('Live-form smoke did not preserve one-submit packet-bound receipt semantics');
  }
  console.log(JSON.stringify({ ok: true, manual, configured }, null, 2));
} finally {
  if (previousFill === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED;
  else process.env.JOBOS_FORM_FILL_ENABLED = previousFill;
  if (previousSubmit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED;
  else process.env.JOBOS_FORM_SUBMIT_ENABLED = previousSubmit;
}
