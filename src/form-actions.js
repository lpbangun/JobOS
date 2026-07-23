import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, guardedWrite, one, run } from './db.js';
import { withAuthenticatedPage } from './browser.js';
import { DOM_ADAPTER_MANIFEST, inspectApplicationFormOnPage, validateAdapterManifest } from './form-browser.js';
import { getFormSnapshot, normalizeFrameKey } from './forms.js';
import { canonicalJson, packetContentHash, showApplicationPacket } from './packets.js';
import { id, now, parseJson } from './utils.js';

function actionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}
const SHA256_HEX = /^[a-f0-9]{64}$/;
const STRUCTURAL_FORM_KEY = /^form-(\d{1,4})$/;

function workspaceFile(s, relativePath) {
  const relative = String(relativePath || '').replaceAll('\\', '/');
  if (!relative || relative.length > 512 || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw actionError('packet_material_path_invalid', 'Packet material path is not a bounded workspace-relative path');
  }
  let workspace;
  let resolved;
  try {
    workspace = fs.realpathSync(s.p.ws);
    resolved = fs.realpathSync(path.resolve(workspace, relative));
  } catch {
    throw actionError('packet_material_missing', 'Packet material bytes are missing from the workspace');
  }
  const outside = path.relative(workspace, resolved);
  if (outside.startsWith('..') || path.isAbsolute(outside)) {
    throw actionError('packet_material_path_invalid', 'Packet material resolves outside the workspace');
  }
  return resolved;
}

function selectedFormOrdinal(formKey) {
  const match = STRUCTURAL_FORM_KEY.exec(String(formKey || ''));
  if (!match) throw actionError('form_snapshot_invalid', 'Selected form evidence is not structural');
  return Number(match[1]);
}


function enabledByProfile(s, profileId) {
  const profile = one(s, 'SELECT preferences_json FROM profiles WHERE id=?', [profileId]);
  const preferences = parseJson(profile?.preferences_json, {});
  return preferences?.externalActions?.formFillEnabled === true;

}

export function validateFormFillAuthorization(s, { profileId, allowSideEffects = false } = {}) {
  const configured = enabledByProfile(s, profileId) || process.env.JOBOS_FORM_FILL_ENABLED === '1';
  if (!configured || allowSideEffects !== true) {
    throw actionError('form_fill_not_enabled', 'Form fill requires configured profile/environment enablement and --allow-side-effects on this invocation', {
      configured,
      invocationAllowedSideEffects: allowSideEffects === true
    });
  }
  return { configured: true, invocationAllowedSideEffects: true, externalSideEffects: 'user-configured-form-fill' };
}

function assertCurrentPacket(s, packetId) {
  const packet = showApplicationPacket(s, packetId);
  if (packet.version !== 2 || !packet.form) throw actionError('legacy_packet_unbound', `Packet ${packetId} is not form-bound packet v2`);
  if (packet.currency !== 'current') throw actionError('packet_stale', `Packet ${packetId} is ${packet.currency}; re-inspect and freeze a new packet`, { currency: packet.currency });
  return packet;
}

function bindingValue(s, packet, binding, field) {
  if (binding.mode === 'answer') {
    const row = one(s, 'SELECT answer_text FROM answers WHERE id=?', [binding.answerId]);
    return row?.answer_text ?? null;
  }
  if (binding.mode === 'profile-identity') {
    const row = one(s, 'SELECT document_json FROM profile_resume_revisions WHERE id=?', [binding.profileResumeRevisionId]);
    const identity = parseJson(row?.document_json, {})?.identity || {};
    const key = String(binding.identityPath || '').replace(/^identity\./, '');
    const value = identity[key];
    if (key === 'links' && Array.isArray(value)) {
      const first = value.find(item => item);
      return typeof first === 'string' ? first : first?.url || first?.value || null;
    }
    return value ?? null;
  }
  if (binding.mode === 'packet-material') {
    const artifact = one(s, `SELECT artifacts.path,artifacts.content_hash,artifacts.type,
      artifact_resume_documents.render_manifest_json
      FROM artifacts LEFT JOIN artifact_resume_documents ON artifact_resume_documents.artifact_id=artifacts.id
      WHERE artifacts.id=?`, [binding.artifactId]);
    if (!artifact) return null;
    if (artifact.type !== 'resume' || field.control !== 'file') {
      throw actionError('unsupported_packet_file', 'Only an exact packet-bound rendered resume PDF may be uploaded automatically');
    }
    const artifactPath = workspaceFile(s, artifact.path);
    const content = fs.readFileSync(artifactPath, 'utf8');
    const actualArtifactHash = crypto.createHash('sha256').update(content.endsWith('\n') ? content : `${content}\n`).digest('hex');
    if (!binding.artifactContentHash || artifact.content_hash !== binding.artifactContentHash || actualArtifactHash !== binding.artifactContentHash) {
      throw actionError('artifact_mirror_diverged', `Workspace mirror content hash mismatch for packet material ${binding.artifactId}`);
    }
    const manifest = parseJson(artifact.render_manifest_json, null);
    const frozen = packet.materials?.resume || {};
    if (manifest?.format !== 'pdf'
      || manifest?.status !== 'passed'
      || frozen.artifactId !== binding.artifactId
      || manifest.pdfPath !== frozen.pdfPath
      || manifest.pdfHash !== frozen.pdfHash
      || !SHA256_HEX.test(String(frozen.pdfHash || ''))) {
      throw actionError('resume_pdf_binding_invalid', 'Resume upload is not bound to the approved packet render manifest');
    }
    return {
      kind: 'packet-pdf',
      path: workspaceFile(s, frozen.pdfPath),
      name: path.basename(frozen.pdfPath),
      mimeType: 'application/pdf',
      expectedHash: frozen.pdfHash
    };
  }
  return null;
}

async function frameForKey(page, frameKey) {
  const frames = typeof page.frames === 'function' ? page.frames() : [page.mainFrame()];
  for (let ordinal = 0; ordinal < frames.length; ordinal += 1) {
    const frame = frames[ordinal];
    const descriptor = {
      url: typeof frame.url === 'function' ? frame.url() : '',
      name: typeof frame.name === 'function' ? frame.name() : '',
      title: typeof frame.title === 'function' ? await frame.title().catch(() => '') : '',
      ordinal
    };
    if (normalizeFrameKey(descriptor).frameKey === frameKey) return frame;
  }
  return null;
}

async function applyField(frame, selection, field, value, expectedOptionKey) {
  const formOrdinal = selectedFormOrdinal(selection?.formKey);
  if (field.locator.strategy !== 'selected-form-control') {
    return { status: 'failed', reasonCode: 'unsupported_structural_locator' };
  }
  if (field.control === 'file') {
    if (value?.kind !== 'packet-pdf') {
      throw actionError('unsupported_packet_file', 'File controls accept only verified packet-bound PDF bytes');
    }
    const bytes = fs.readFileSync(value.path);
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== value.expectedHash) {
      throw actionError('artifact_pdf_diverged', 'Rendered resume PDF bytes changed after packet freeze');
    }
    const locator = frame.locator('form').nth(formOrdinal)
      .locator('input,textarea,select,[role="combobox"],[contenteditable="true"]')
      .nth(field.locator.ordinal);
    if (await locator.count() !== 1) return { status: 'failed', reasonCode: 'locator_missing' };
    await locator.setInputFiles({
      name: value.name,
      mimeType: value.mimeType,
      buffer: bytes
    });
    const count = await locator.evaluate(element => element.files?.length || 0);
    return { status: count > 0 ? 'equal' : 'diverged', reasonCode: count > 0 ? 'file_attached' : 'file_missing' };
  }
  return frame.evaluate(({ formOrdinal, locator, control, value, expectedOptionKey }) => {
    const form = [...document.forms][formOrdinal];
    if (!form) return { status: 'failed', reasonCode: 'locator_missing' };
    const controls = [...form.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]')];
    let element = controls[locator.ordinal] || null;
    if (control === 'radio-group' && element?.matches('input[type="radio"]')) {
      const groupName = element.name;
      element = controls.find(item => item.matches('input[type="radio"]')
        && item.name === groupName
        && String(item.value) === String(expectedOptionKey)) || null;
    }
    if (!element) return { status: 'failed', reasonCode: 'locator_missing' };
    let expectedChecked = null;
    if (control === 'select-one') element.value = expectedOptionKey ?? String(value);
    else if (control === 'radio-group') element.checked = true;
    else if (control === 'checkbox') {
      expectedChecked = /^(1|true|yes|on|checked)$/i.test(String(value));
      element.checked = expectedChecked;
    } else element.value = String(value ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    let equal;
    if (control === 'radio-group') equal = element.checked === true;
    else if (control === 'checkbox') equal = Boolean(element.checked) === expectedChecked;
    else equal = String(element.value) === String(expectedOptionKey ?? value ?? '');
    return { status: equal ? 'equal' : 'diverged', reasonCode: equal ? 'readback_equal' : 'readback_mismatch' };
  }, { formOrdinal, locator: field.locator, control: field.control, value, expectedOptionKey });
}

export async function applyBoundFormFields(s, page, packet, snapshot) {
  const fields = new Map(snapshot.fieldMap.fields.map(field => [field.fieldKey, field]));
  const readback = [];
  for (const binding of packet.form.bindings) {
    const field = fields.get(binding.fieldKey);
    if (!field) {
      readback.push({ fieldKey: binding.fieldKey, status: 'failed', reasonCode: 'field_missing' });
      continue;
    }
    if (!binding.autoFill) {
      readback.push({ fieldKey: binding.fieldKey, status: 'present-human', reasonCode: binding.reasonCode });
      continue;
    }
    const value = bindingValue(s, packet, binding, field);
    if (value == null) {
      readback.push({ fieldKey: binding.fieldKey, status: 'failed', reasonCode: 'bound_source_missing' });
      continue;
    }
    const frame = await frameForKey(page, field.frameKey);
    const observed = frame ? await applyField(frame, snapshot.selection, field, value, binding.expectedOptionKey) : { status: 'failed', reasonCode: 'frame_missing' };
    readback.push({ fieldKey: binding.fieldKey, ...observed });
  }
  return readback;
}

export async function fillApplicationForm(s, {
  packetId,
  workspace,
  browserProfile = 'default',
  allowSideEffects = false,
  adapterManifest = DOM_ADAPTER_MANIFEST,
  expectedAdapterHash = null,
  playwright,
  navigationTimeoutMs
} = {}) {
  const packet = assertCurrentPacket(s, packetId);
  const policy = validateFormFillAuthorization(s, { profileId: packet.profileId, allowSideEffects });
  const packetAdapter = validateAdapterManifest(packet.form.adapter);
  if (expectedAdapterHash !== null) {
    validateAdapterManifest(packetAdapter, { expectedSourceHash: expectedAdapterHash });
  }
  const adapter = validateAdapterManifest(adapterManifest, {
    expectedId: packetAdapter.id,
    expectedProtocolVersion: packetAdapter.protocolVersion,
    expectedSourceHash: packetAdapter.sourceHash
  });
  const frozenSnapshot = getFormSnapshot(s, packet.form.snapshotId, { raw: false });
  const url = `${frozenSnapshot.target.finalOrigin}${frozenSnapshot.target.finalPath}`;
  const result = await withAuthenticatedPage({ workspace, name: browserProfile, url, playwright, headless: true, createIfMissing: true, navigationTimeoutMs }, async ({ page }) => {
    const inspected = await inspectApplicationFormOnPage({
      page,
      requestedUrl: url,
      jobId: packet.jobId,
      profileId: packet.profileId,
      adapterManifest: adapter,
      expectedAdapterHash: adapter.sourceHash
    });
    if (inspected.fingerprint !== packet.form.formFingerprint) {
      throw actionError('form_fingerprint_stale', 'The live form changed after packet freeze; re-inspect and freeze a new packet', {
        packetFingerprint: packet.form.formFingerprint,
        liveFingerprint: inspected.fingerprint
      });
    }
    return applyBoundFormFields(s, page, packet, inspected);
  });
  const divergedFieldKeys = result.filter(item => !['equal', 'present-human'].includes(item.status)).map(item => item.fieldKey);
  const status = divergedFieldKeys.length ? 'diverged' : 'checkpoint-required';
  const fillRunId = id('fill', `${packet.id}:${now()}:${adapter.sourceHash}`);
  guardedWrite(s, () => {
    run(s, 'INSERT INTO form_fill_runs (id,packet_id,form_fingerprint,adapter_json,status,readback_json,created_at) VALUES (?,?,?,?,?,?,?)', [
      fillRunId, packet.id, packet.form.formFingerprint, JSON.stringify(adapter), status, JSON.stringify(result), now()
    ]);
  });
  if (status === 'diverged') throw actionError('fill_readback_diverged', 'One or more fields failed transient read-back comparison', { fillRunId, divergedFieldKeys });
  return {
    version: 1,
    fillRunId,
    packetId: packet.id,
    formFingerprint: packet.form.formFingerprint,
    status,
    readback: result,
    humanActionFieldKeys: packet.form.humanActionFieldKeys,
    policy: { ...policy, submissionPerformed: false }
  };
}

export function checkpointApplicationForm(s, { packetId, fillRunId, confirmedFieldKeys = [], source = 'cli' } = {}) {
  if (!['cli', 'tui'].includes(source)) throw actionError('human_checkpoint_required', 'Checkpoint acceptance requires trusted CLI or TUI input');
  const packet = assertCurrentPacket(s, packetId);
  const fillRun = one(s, 'SELECT * FROM form_fill_runs WHERE id=? AND packet_id=?', [fillRunId, packetId]);
  if (!fillRun) throw actionError('unknown_fill_run', `Unknown fill run ${fillRunId} for packet ${packetId}`);
  if (fillRun.status !== 'checkpoint-required' || fillRun.form_fingerprint !== packet.form.formFingerprint) {
    throw actionError('checkpoint_stale', 'The fill run is not eligible for a current checkpoint');
  }
  const required = [...new Set(packet.form.humanActionFieldKeys || [])].sort();
  const confirmed = [...new Set((confirmedFieldKeys || []).map(String))].sort();
  const missing = required.filter(fieldKey => !confirmed.includes(fieldKey));
  if (missing.length) throw actionError('human_checkpoint_incomplete', 'Confirm every restricted or unsupported human-action field', { missingFieldKeys: missing });
  const projection = { version: 1, packetId, fillRunId, formFingerprint: packet.form.formFingerprint, confirmedFieldKeys: confirmed };
  const checkpointHash = packetContentHash(projection);
  return guardedWrite(s, () => {
    const existing = one(s, 'SELECT * FROM human_checkpoints WHERE packet_id=? AND fill_run_id=?', [packetId, fillRunId]);
    if (existing) {
      if (existing.checkpoint_hash !== checkpointHash) throw actionError('checkpoint_conflict', 'Checkpoint evidence is immutable');
      return { checkpointId: existing.id, checkpointHash, idempotent: true, ...projection };
    }
    const checkpointId = id('check', `${packetId}:${fillRunId}:${checkpointHash}`);
    run(s, 'INSERT INTO human_checkpoints VALUES (?,?,?,?,?,?,?)', [checkpointId, packetId, fillRunId, checkpointHash, canonicalJson(projection), now(), source]);
    return { checkpointId, checkpointHash, idempotent: false, ...projection };
  });
}
