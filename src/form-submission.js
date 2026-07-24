import { guardedWrite, one, run, queuePostCommit, recordAudit, projectAudit } from './db.js';
import { withAuthenticatedPage } from './browser.js';
import { DOM_ADAPTER_MANIFEST, DOM_CONFIRMATION_POLICY, inspectApplicationFormOnPage, validateAdapterManifest } from './form-browser.js';
import { applyBoundFormFields } from './form-actions.js';
import { bindFormSnapshotTarget, getFormSnapshot, getPrivateFormTarget, normalizeFrameKey } from './forms.js';
import { canonicalJson, packetContentHash, showApplicationPacket } from './packets.js';
import { planApplication } from './readiness.js';
import { syncJob } from './jobs.js';
import { id, now, parseJson } from './utils.js';
import {
  LIFECYCLE_EVENT_INPUT_SCHEMA,
  lifecycleTaskView,
  reconcileApplicationNextAction,
} from './lifecycle.js';

function submissionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

function submissionConfiguration(s, profileId) {
  const profile = one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [profileId]);
  const preferences = parseJson(profile?.preferences_json, {});
  if (preferences?.externalActions?.formSubmitEnabled === true) return 'profile';
  if (process.env.JOBOS_FORM_SUBMIT_ENABLED === '1') return 'environment';
  return null;
}

export function validateFormSubmissionAuthorization(s, { profileId, allowSubmit = false } = {}) {
  const configurationSource = submissionConfiguration(s, profileId);
  if (!configurationSource || allowSubmit !== true) {
    throw submissionError('form_submission_not_enabled', 'Configured form submission requires profile/environment enablement and --allow-submit on this invocation', {
      configured: Boolean(configurationSource),
      invocationAllowedSubmit: allowSubmit === true
    });
  }
  return { configurationSource, externalSideEffects: 'user_configured_form_submission' };
}
const STRUCTURAL_FORM_KEY = /^form-(\d{1,4})$/;
const SAFE_REFERENCE = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const SECRET_OR_PII = /(?:bearer|credential|password|secret|session|token|api[_-]?key|authorization|cookie|[\w.+-]+@[\w.-]+\.[A-Z]{2,})/i;

function selectedFormOrdinal(formKey) {
  const match = STRUCTURAL_FORM_KEY.exec(String(formKey || ''));
  if (!match) throw submissionError('form_snapshot_invalid', 'Selected form evidence is not structural');
  return Number(match[1]);
}

function safeConfirmationReference(value) {
  const reference = typeof value === 'string' ? value : '';
  if (!reference || reference !== reference.trim() || reference.length > DOM_CONFIRMATION_POLICY.maxReferenceLength) return null;
  if (!SAFE_REFERENCE.test(reference) || SECRET_OR_PII.test(reference)) return null;
  const digits = reference.replace(/\D/g, '');
  if (digits.length >= 9 || /^[A-Z0-9]{24,}$/.test(reference)) return null;
  return reference;
}

function trustedConfirmationLocation(initialTarget, finalUrl) {
  let final;
  try {
    final = new URL(finalUrl);
  } catch {
    return null;
  }
  const path = final.pathname;
  if (final.username || final.password || final.origin !== initialTarget.finalOrigin
    || !path || path.length > DOM_CONFIRMATION_POLICY.maxPathLength
    || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(path)
    || path.split('/').some(segment => segment.length > 80)) {
    return null;
  }
  const allowedPath = path === initialTarget.finalPath
    || /(?:confirmation|confirmed|thank-you|received|success|complete)/i.test(path);
  return allowedPath ? { origin: final.origin, path } : null;
}

async function readConfirmationMarker(scope) {
  return scope.evaluate(({ markerValue }) => {
    const marker = document.querySelector(`[data-confirmation-marker="${markerValue}"]`);
    if (!marker) return null;
    const status = document.querySelector('[data-confirmation-status]');
    return {
      marker: marker.getAttribute('data-confirmation-marker'),
      reference: marker.getAttribute('data-confirmation-reference'),
      status: status?.getAttribute('data-confirmation-status') || null
    };
  }, { markerValue: DOM_CONFIRMATION_POLICY.markerValue });
}

function validateConfirmationEvidence({ before, after, initialTarget, finalUrl, responseStatus, activation }) {
  if (!activation?.submitEventObserved || activation.submitPrevented) {
    return { status: 'uncertain', errorCode: 'submit_activation_unverified' };
  }
  if (Number.isFinite(responseStatus) && responseStatus >= 400) {
    return { status: 'uncertain', errorCode: 'post_boundary_http_error' };
  }
  const location = trustedConfirmationLocation(initialTarget, finalUrl);
  if (!location) return { status: 'uncertain', errorCode: 'confirmation_location_untrusted' };
  if (!after || after.marker !== DOM_CONFIRMATION_POLICY.markerValue
    || after.status !== DOM_CONFIRMATION_POLICY.confirmedStatus) {
    return { status: 'uncertain', errorCode: 'confirmation_marker_missing' };
  }
  if (before && before.marker === after.marker && before.reference === after.reference && before.status === after.status) {
    return { status: 'uncertain', errorCode: 'confirmation_marker_unchanged' };
  }
  const reference = safeConfirmationReference(after.reference);
  if (!reference) return { status: 'uncertain', errorCode: 'confirmation_reference_rejected' };
  return {
    status: 'confirmed',
    confirmation: { reference, status: DOM_CONFIRMATION_POLICY.confirmedStatus },
    confirmationOrigin: location.origin,
    confirmationPath: location.path
  };
}


async function selectedFrame(page, frameKey) {
  const frames = page.frames();
  for (let ordinal = 0; ordinal < frames.length; ordinal += 1) {
    const frame = frames[ordinal];
    const descriptor = {
      url: frame.url(),
      name: frame.name(),
      title: await frame.title().catch(() => ''),
      ordinal
    };
    if (normalizeFrameKey(descriptor).frameKey === frameKey) return frame;
  }
  return null;
}

async function activateSelectedSubmit(page, snapshot, onActivated, {
  waitForHumanFields = false,
  humanFieldTimeoutMs = 300_000,
  evidenceTimeoutMs = 5_000
} = {}) {
  const frame = await selectedFrame(page, snapshot.selection.frameKey);
  if (!frame) throw submissionError('form_fingerprint_stale', 'The selected form frame is no longer available');
  const formOrdinal = selectedFormOrdinal(snapshot.selection.formKey);
  const inspectReadiness = () => frame.evaluate(ordinal => {
    const form = [...document.forms][ordinal];
    if (!form) return { available: false, valid: false, hasSubmit: false };
    return {
      available: true,
      valid: form.checkValidity(),
      hasSubmit: Boolean(form.querySelector('button[type="submit"],input[type="submit"],button:not([type])'))
    };
  }, formOrdinal);
  let readiness = await inspectReadiness();
  if (!readiness.available) throw submissionError('form_fingerprint_stale', 'The selected application form is no longer available');
  if (!readiness.hasSubmit) throw submissionError('submit_control_not_found', 'The selected application form has no bounded submit control');
  if (!readiness.valid && waitForHumanFields) {
    await frame.waitForFunction(ordinal => Boolean([...document.forms][ordinal]?.checkValidity()), formOrdinal, {
      timeout: humanFieldTimeoutMs
    }).catch(() => null);
    readiness = await inspectReadiness();
  }
  if (!readiness.valid) throw submissionError('human_action_required', 'Required human-owned fields were not completed before the submit deadline; no submit control was activated');
  const before = await readConfirmationMarker(frame);
  // Navigation waiting must target the selected submitting browsing context.
  // For an iframe-hosted form the submit navigates the frame, not the top
  // page; page.waitForNavigation would never resolve and the caller would read
  // confirmation evidence from the wrong document. frame.waitForNavigation is
  // identical to page.waitForNavigation when the selected frame is the main
  // frame, so main-frame behavior is preserved.
  const navigation = frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: evidenceTimeoutMs }).catch(() => null);
  onActivated();
  const activation = await frame.evaluate(ordinal => {
    const form = [...document.forms][ordinal];
    const submit = form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    if (!submit) return { activated: false, submitEventObserved: false, submitPrevented: false };
    let submitEvent = null;
    form.addEventListener('submit', event => {
      submitEvent = event;
    }, { once: true });
    submit.click();
    return {
      activated: true,
      submitEventObserved: Boolean(submitEvent),
      submitPrevented: Boolean(submitEvent?.defaultPrevented)
    };
  }, formOrdinal);
  if (!activation.activated) throw submissionError('submit_control_not_found', 'The selected application form has no bounded submit control');
  return { response: await navigation, before, frame, ...activation };
}

function attemptView(row) {
  return {
    version: 1,
    attemptId: row.id,
    submissionKey: row.submission_key,
    packetId: row.packet_id,
    packetHash: row.packet_hash,
    formFingerprint: row.form_fingerprint,
    checkpointId: row.checkpoint_id,
    checkpointHash: row.checkpoint_hash,
    adapter: parseJson(row.adapter_json, {}),
    invokedBy: row.invoked_by,
    configurationSource: row.configuration_source,
    status: row.status,
    outcome: parseJson(row.outcome_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    externalSideEffects: row.external_side_effect,
    submissionPerformed: row.status === 'confirmed' ? true : row.status === 'uncertain' ? null : false
  };
}

export async function submitApplicationForm(s, {
  packetId,
  checkpointId,
  workspace,
  browserProfile = 'default',
  allowSubmit = false,
  invokedBy = 'cli',
  adapterManifest = DOM_ADAPTER_MANIFEST,
  expectedAdapterHash = null,
  playwright,
  navigationTimeoutMs,
  protectRequests = true,
  networkPolicyOptions
} = {}) {
  if (!['cli', 'tui', 'mcp', 'acp'].includes(invokedBy)) throw submissionError('invalid_submission_source', `Unsupported submission source: ${invokedBy}`);
  const packet = showApplicationPacket(s, packetId);
  if (packet.version !== 2 || !packet.form) throw submissionError('legacy_packet_unbound', `Packet ${packetId} is not form-bound packet v2`);
  if (packet.currency !== 'current') throw submissionError('packet_stale', `Packet ${packetId} is ${packet.currency}`, { currency: packet.currency });
  if (packet.receiptState !== 'none') {
    const existingAttempt = one(s, "SELECT * FROM form_submission_attempts WHERE packet_id=? AND status='confirmed' ORDER BY started_at DESC LIMIT 1", [packetId]);
    if (existingAttempt) return { ...attemptView(existingAttempt), idempotent: true };
    throw submissionError('packet_already_submitted', `Packet ${packetId} already has receipt evidence`);
  }
  const checkpoint = one(s, 'SELECT * FROM human_checkpoints WHERE id=? AND packet_id=?', [checkpointId, packetId]);
  if (!checkpoint) throw submissionError('checkpoint_required', 'Configured submission requires an accepted checkpoint bound to this packet');
  if (checkpoint.checkpoint_hash !== packetContentHash(parseJson(checkpoint.confirmation_json, {}))) {
    throw submissionError('checkpoint_stale', 'Checkpoint hash does not match its immutable evidence');
  }
  const policy = validateFormSubmissionAuthorization(s, { profileId: packet.profileId, allowSubmit });
  const packetAdapter = validateAdapterManifest(packet.form.adapter);
  if (expectedAdapterHash !== null) {
    validateAdapterManifest(packetAdapter, { expectedSourceHash: expectedAdapterHash });
  }
  const adapter = validateAdapterManifest(adapterManifest, {
    expectedId: packetAdapter.id,
    expectedProtocolVersion: packetAdapter.protocolVersion,
    expectedSourceHash: packetAdapter.sourceHash
  });
  if (adapter.id !== DOM_ADAPTER_MANIFEST.id) {
    throw submissionError('confirmation_policy_unsupported', 'Configured submission requires an installed adapter-specific confirmation policy');
  }
  const submissionKey = packetContentHash({
    packetHash: packet.contentHash,
    formFingerprint: packet.form.formFingerprint,
    adapter: { id: adapter.id, protocolVersion: adapter.protocolVersion, sourceHash: adapter.sourceHash }
  });
  let attempt = guardedWrite(s, () => {
    const existing = one(s, 'SELECT * FROM form_submission_attempts WHERE submission_key=?', [submissionKey]);
    if (existing) {
      if (existing.status === 'confirmed') return existing;
      if (existing.status === 'armed' || existing.status === 'uncertain') {
        throw submissionError('submission_replay_blocked', `Submission ${submissionKey} is ${existing.status}; replay is forbidden`, { status: existing.status });
      }
      run(s, "UPDATE form_submission_attempts SET status='armed',outcome_json='{}',started_at=?,completed_at=NULL,checkpoint_id=?,checkpoint_hash=?,invoked_by=?,configuration_source=?,external_side_effect='none' WHERE id=?", [
        now(), checkpoint.id, checkpoint.checkpoint_hash, invokedBy, policy.configurationSource, existing.id
      ]);
      return one(s, 'SELECT * FROM form_submission_attempts WHERE id=?', [existing.id]);
    }
    const attemptId = id('submit', submissionKey);
    run(s, 'INSERT INTO form_submission_attempts (id,submission_key,packet_id,packet_hash,form_fingerprint,checkpoint_id,checkpoint_hash,adapter_json,invoked_by,configuration_source,status,outcome_json,started_at,completed_at,external_side_effect) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      attemptId, submissionKey, packet.id, packet.contentHash, packet.form.formFingerprint, checkpoint.id, checkpoint.checkpoint_hash,
      JSON.stringify(adapter), invokedBy, policy.configurationSource, 'armed', '{}', now(), null, 'none'
    ]);
    return one(s, 'SELECT * FROM form_submission_attempts WHERE id=?', [attemptId]);
  });
  if (attempt.status === 'confirmed') return { ...attemptView(attempt), idempotent: true };

  const frozenSnapshot = getFormSnapshot(s, packet.form.snapshotId);
  const url = getPrivateFormTarget(s, packet.form.snapshotId).requestedUrl;
  let boundaryInvoked = false;
  let outcome;
  try {
    outcome = await withAuthenticatedPage({
      workspace,
      name: browserProfile,
      url,
      playwright,
      headless: !(packet.form.humanActionFieldKeys || []).length,
      createIfMissing: true,
      navigationTimeoutMs,
      protectRequests,
      networkPolicyOptions,
      postOperationValidator: ({ result }) => result?.status === 'confirmed'
    }, async ({ page }) => {
      const inspected = await inspectApplicationFormOnPage({
        page,
        requestedUrl: url,
        jobId: packet.jobId,
        profileId: packet.profileId,
        adapterManifest: adapter,
        expectedAdapterHash: adapter.sourceHash
      });
      bindFormSnapshotTarget(s, inspected);
      if (inspected.fingerprint !== packet.form.formFingerprint) throw submissionError('form_fingerprint_stale', 'The live form changed after checkpoint');
      const readback = await applyBoundFormFields(s, page, packet, inspected);
      const failed = readback.filter(item => !['equal', 'present-human'].includes(item.status)).map(item => item.fieldKey);
      if (failed.length) throw submissionError('fill_readback_diverged', 'Safe bindings diverged before submit', { fieldKeys: failed });
      const activation = await activateSelectedSubmit(page, inspected, () => {
        boundaryInvoked = true;
      }, {
        waitForHumanFields: (packet.form.humanActionFieldKeys || []).length > 0,
        evidenceTimeoutMs: Math.min(Math.max(Number(navigationTimeoutMs) || 5_000, 250), 10_000)
      });
      const after = await readConfirmationMarker(activation.frame);
      return validateConfirmationEvidence({
        before: activation.before,
        after,
        initialTarget: frozenSnapshot.target,
        finalUrl: activation.frame.url(),
        responseStatus: activation.response ? activation.response.status() : null,
        activation
      });
    });
  } catch (error) {
    const status = boundaryInvoked ? 'uncertain' : 'failed-before-submit';
    const safeOutcome = { status, errorCode: error?.code || 'form_submission_failed' };
    guardedWrite(s, () => {
      run(s, 'UPDATE form_submission_attempts SET status=?,outcome_json=?,completed_at=?,external_side_effect=? WHERE id=?', [
        status, JSON.stringify(safeOutcome), now(), boundaryInvoked ? 'user_configured_form_submission' : 'none', attempt.id
      ]);
    });
    throw Object.assign(error, { submissionAttemptId: attempt.id, submissionStatus: status, externalSideEffects: boundaryInvoked ? 'user_configured_form_submission' : 'none' });
  }

  if (outcome.status === 'confirmed') {
    const reference = safeConfirmationReference(outcome.confirmation?.reference);
    const location = trustedConfirmationLocation(frozenSnapshot.target, `${outcome.confirmationOrigin}${outcome.confirmationPath}`);
    if (!reference || !location
      || location.origin !== outcome.confirmationOrigin
      || location.path !== outcome.confirmationPath) {
      outcome = { status: 'uncertain', errorCode: 'confirmation_evidence_rejected' };
    } else {
      outcome = {
        status: 'confirmed',
        confirmation: { reference, status: DOM_CONFIRMATION_POLICY.confirmedStatus },
        confirmationOrigin: location.origin,
        confirmationPath: location.path
      };
    }
  }
  if (outcome.status !== 'confirmed') {
    attempt = guardedWrite(s, () => {
      run(s, 'UPDATE form_submission_attempts SET status=?,outcome_json=?,completed_at=?,external_side_effect=? WHERE id=?', [
        outcome.status, JSON.stringify(outcome), now(), outcome.status === 'uncertain' ? 'user_configured_form_submission' : 'none', attempt.id
      ]);
      return one(s, 'SELECT * FROM form_submission_attempts WHERE id=?', [attempt.id]);
    });
    return { ...attemptView(attempt), idempotent: false };
  }

  return guardedWrite(s, () => {
    const completedAt = now();
    const receiptId = id('rcpt', `${attempt.id}:${outcome.confirmation.reference}`);
    const receiptProjection = {
      version: 2,
      type: 'adapter_receipt',
      packetHash: packet.contentHash,
      formFingerprint: packet.form.formFingerprint,
      checkpointHash: checkpoint.checkpoint_hash,
      submissionAttemptId: attempt.id,
      externalReference: outcome.confirmation.reference,
      confirmationOrigin: outcome.confirmationOrigin,
      confirmationPath: outcome.confirmationPath
    };
    const receiptHash = packetContentHash(receiptProjection);
    run(s, `INSERT INTO application_receipts
      (id,packet_id,application_id,type,submitted_at,recorded_at,external_reference,evidence_path,evidence_hash,note,receipt_hash,source,external_side_effect,evidence_version,form_fingerprint,checkpoint_id,checkpoint_hash,submission_attempt_id,submission_actor,adapter_json,confirmation_origin,confirmation_path,policy_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      receiptId, packet.id, packet.applicationId, 'adapter_receipt', completedAt, completedAt,
      outcome.confirmation.reference, '', '', '', receiptHash, invokedBy, 'user_configured_form_submission', 2,
      packet.form.formFingerprint, checkpoint.id, checkpoint.checkpoint_hash, attempt.id, 'configured_adapter', JSON.stringify(adapter),
      outcome.confirmationOrigin, outcome.confirmationPath, JSON.stringify({ submissionPerformed: true, configured: true })
    ]);
    run(s, "UPDATE form_submission_attempts SET status='confirmed',outcome_json=?,completed_at=?,external_side_effect='user_configured_form_submission' WHERE id=?", [JSON.stringify(outcome), completedAt, attempt.id]);
    const application = one(s, 'SELECT * FROM applications WHERE id=?', [packet.applicationId]);
    if (application && ['saved', 'researching', 'materials-ready'].includes(application.status)) {
      const statusChangeId = id('status', `${application.id}:${application.status}:applied:${completedAt}`);
      run(s, `INSERT INTO status_changes
        (id,application_id,job_id,profile_id,from_status,to_status,note,created_at,actor,source,source_event_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        statusChangeId, application.id, packet.jobId, packet.profileId, application.status,
        'applied', `Configured form submission: ${attempt.id}`, completedAt,
        'configured_adapter', invokedBy, receiptId,
      ]);
      run(s, 'UPDATE applications SET status=?,confirmation_url=?,updated_at=? WHERE id=?', ['applied', `${outcome.confirmationOrigin}${outcome.confirmationPath}`, completedAt, application.id]);
    }
    const action = reconcileApplicationNextAction(s, {
      applicationId: packet.applicationId,
      trigger: {
        schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
        profileId: packet.profileId,
        applicationId: packet.applicationId,
        eventId: receiptId,
        eventType: 'configured_submission_confirmed',
        occurredAt: completedAt,
      },
      nowDate: new Date(completedAt),
    });
    const nextAction = action ? lifecycleTaskView(action, { nowDate: new Date(completedAt) }) : null;
    const audit = recordAudit(s, 'application.form_submission_confirmed', 'form_submission_attempt', attempt.id, {
      packetId: packet.id,
      formFingerprint: packet.form.formFingerprint,
      checkpointId: checkpoint.id,
      receiptId,
      externalSideEffects: 'user_configured_form_submission',
      submissionPerformed: true
    }, 'user_configured_form_submission');
    queuePostCommit(s, () => {
      projectAudit(s, audit);
      try { planApplication(s, { jobId: packet.jobId, profileId: packet.profileId, writeMirror: true }); } catch {}
      syncJob(s, packet.jobId);
    });
    attempt = one(s, 'SELECT * FROM form_submission_attempts WHERE id=?', [attempt.id]);
    return {
      ...attemptView(attempt),
      idempotent: false,
      receipt: {
        receiptId,
        receiptHash,
        type: 'adapter_receipt',
        externalReference: outcome.confirmation.reference,
        formFingerprint: packet.form.formFingerprint,
        checkpointId: checkpoint.id,
        checkpointHash: checkpoint.checkpoint_hash,
        submissionAttemptId: attempt.id,
        submissionActor: 'configured_adapter',
        externalSideEffect: 'user_configured_form_submission'
      },
      nextAction,
    };
  });
}
