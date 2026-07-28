import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, guardedWrite, one, run } from './db.js';
import { parseJson } from './utils.js';

// ---------------------------------------------------------------------------
// W02 Live Form Packet Bridge — pure canonicalization, classification,
// fingerprint, currency, and secret-safe formatting contracts.
//
// Exact request targets are held only in an authenticated private envelope.
// Public projections never contain query/fragment/userinfo, target bindings,
// ciphertext metadata, raw HTML, field values, or hashes of field values.
//
// Contracts: FormFieldMapV1 / FormSnapshotV1 per
// W02_LIVE_FORM_PACKET_BRIDGE_IMPLEMENTATION_PLAN.md sections 5.1-5.2.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------
function formError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

// ---------------------------------------------------------------------------
// Canonical JSON serializer — deterministic, sorted keys, no whitespace.
// Mirrors src/packets.js canonicalJson so fingerprints are comparable.
// ---------------------------------------------------------------------------
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const PRIVATE_EXACT_TARGET = Symbol('jobos.form.exact-target');
const TARGET_KEY_BYTES = 32;
const TARGET_IV_BYTES = 12;

function exactTargetUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw formError('form_contract_unsupported', 'Invalid exact target URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw formError('form_contract_unsupported', 'Exact target URL must be HTTP(S) without userinfo');
  }
  parsed.hash = '';
  return parsed.href;
}

function targetKeyPath(s) {
  return path.join(s.p.state, 'form-target.key');
}

function formTargetKey(s, { create = false } = {}) {
  const keyPath = targetKeyPath(s);
  if (create) {
    fs.mkdirSync(s.p.state, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(keyPath, crypto.randomBytes(TARGET_KEY_BYTES), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw formError('form_target_key_unavailable', 'Private form target key could not be created');
    }
  }
  let key;
  try {
    const stat = fs.lstatSync(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe key path');
    key = fs.readFileSync(keyPath);
  } catch {
    throw formError('form_target_key_unavailable', 'Private form target key is unavailable');
  }
  if (key.length !== TARGET_KEY_BYTES) throw formError('form_target_key_unavailable', 'Private form target key is invalid');
  return key;
}

function targetBinding(key, exactTarget) {
  return crypto.createHmac('sha256', key)
    .update('jobos.form-target.v1\0')
    .update(canonicalJson(exactTarget))
    .digest('hex');
}

function encryptTarget(key, snapshotId, exactTarget) {
  const iv = crypto.randomBytes(TARGET_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(snapshotId)));
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(exactTarget), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptTarget(key, row) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.target_iv, 'base64'));
    decipher.setAAD(Buffer.from(String(row.id)));
    decipher.setAuthTag(Buffer.from(row.target_tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.target_ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    const target = JSON.parse(plaintext);
    return {
      requestedUrl: exactTargetUrl(target.requestedUrl),
      finalUrl: exactTargetUrl(target.finalUrl)
    };
  } catch {
    throw formError('form_target_reinspection_required', 'Private exact form target is unavailable; reinspect the form');
  }
}

// ---------------------------------------------------------------------------
// Prompt normalization — visible label/question canonicalization.
// Reuses the exact stopword/whitespace rules from src/answers.js so live
// question fingerprints match persisted answer fingerprints.
// ---------------------------------------------------------------------------
export function normalizePrompt(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/\b(the|a|an|please|tell us|tell me)\b/g, ' ')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// URL normalization — origin/path only. Reject userinfo. Strip query/fragment.
// ---------------------------------------------------------------------------
export function normalizeTargetUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw formError('form_contract_unsupported', 'Invalid target URL');
  }
  if (parsed.username || parsed.password) {
    throw formError('form_contract_unsupported', 'URL userinfo is not permitted');
  }
  return {
    origin: `${parsed.protocol}//${parsed.host}`,
    path: parsed.pathname || '/'
  };
}

// ---------------------------------------------------------------------------
// Frame normalization — stable frame key from origin/path/name/title/ordinal.
// URL query/fragment is excluded; never a cookie-bearing URL.
// ---------------------------------------------------------------------------
export function normalizeFrameKey(frame) {
  if (!frame) return { frameKey: '', origin: '', path: '' };
  const { origin, path } = normalizeTargetUrl(
    frame.url || (frame.origin ? `${frame.origin}${frame.path || ''}` : '')
  );
  const name = String(frame.name || '').trim();
  const title = String(frame.title || '').trim().toLowerCase();
  const ordinal = Number.isFinite(frame.ordinal) ? frame.ordinal : 0;
  const frameKey = sha256Hex(canonicalJson({ origin, path, name, title, ordinal }));
  return { frameKey, origin, path };
}

// ---------------------------------------------------------------------------
// Classification — hard safety rules override lower provenance.
// ---------------------------------------------------------------------------

const RESTRICTED_CATEGORIES = new Set(['work_authorization', 'demographic', 'legal_attestation']);
const SUPPORTED_CONTROLS = new Set([
  'text', 'email', 'tel', 'url', 'number', 'date', 'textarea',
  'select-one', 'radio-group', 'checkbox', 'file', 'combobox'
]);

// Controls that are never filled and remain explicit human actions / unsupported.
const RESTRICTED_CONTROL_HANDLING = {
  password: { sensitivity: 'restricted', handling: 'human-action', reasonCode: 'password_field' },
  signature: { sensitivity: 'restricted', handling: 'human-action', reasonCode: 'signature_required' },
  payment: { sensitivity: 'restricted', handling: 'human-action', reasonCode: 'payment_field' },
  captcha: { sensitivity: 'restricted', handling: 'human-action', reasonCode: 'captcha_control' },
  hidden: { sensitivity: 'restricted', handling: 'unsupported', reasonCode: 'hidden_control' }
};
const RESTRICTED_PROMPT = /\b(?:social security|ssn|national identification|national id|taxpayer identification|tax id|passport number|bank account|credit card)\b/i;

const UNSUPPORTED_CONTROLS = new Set([
  'contenteditable', 'custom-multiselect', 'unsupported',
  'hidden', 'password', 'signature', 'payment', 'captcha'
]);

export function classifyFormField(input) {
  const control = String(input?.control || 'unsupported');
  const category = String(input?.category || 'other').toLowerCase();
  const sensitivity = String(input?.sensitivity || 'public').toLowerCase();
  const prompt = String(input?.prompt || '');
  // 1. Restricted control types dominate everything.
  if (Object.prototype.hasOwnProperty.call(RESTRICTED_CONTROL_HANDLING, control)) {
    const rule = RESTRICTED_CONTROL_HANDLING[control];
    return {
      category,
      sensitivity: rule.sensitivity,
      handling: rule.handling,
      reasonCode: rule.reasonCode,
      provenance: 'hard-safety-rule',
      autoFill: false
    };
  }

  // 2. Restricted answer categories dominate adapter/dom/heuristic data.
  if (RESTRICTED_CATEGORIES.has(category)) {
    const isLegal = category === 'legal_attestation';
    return {
      category,
      sensitivity: 'restricted',
      handling: isLegal ? 'human-action' : 'human-input',
      reasonCode: isLegal ? 'legal_consent' : 'restricted_category',
      provenance: 'hard-safety-rule',
      autoFill: false
    };
  }

  // 3. Explicitly restricted sensitivity and restricted identifiers dominate
  // adapter category/handling claims.
  if (sensitivity === 'restricted' || RESTRICTED_PROMPT.test(prompt)) {
    return {
      category,
      sensitivity: 'restricted',
      handling: 'human-input',
      reasonCode: input?.reasonCode || 'restricted_field',
      provenance: 'hard-safety-rule',
      autoFill: false
    };
  }

  // 4. Unsupported controls become explicit unsupported handling.
  if (!SUPPORTED_CONTROLS.has(control) || UNSUPPORTED_CONTROLS.has(control)) {
    return {
      category,
      sensitivity,
      handling: 'unsupported',
      reasonCode: 'unsupported_control',
      provenance: 'hard-safety-rule',
      autoFill: false
    };
  }

  // 5. Sensitive (non-restricted) fields pause for human input, never auto-fill.
  if (sensitivity === 'sensitive') {
    return {
      category,
      sensitivity: 'sensitive',
      handling: 'human-input',
      reasonCode: input?.reasonCode || 'sensitive_field',
      provenance: input?.provenance || 'dom',
      autoFill: false
    };
  }

  // 5. Respect explicit provenance when no hard rule applies, but never allow
  //    an adapter/heuristic to downgrade into auto-fill from restricted.
  const handling = String(input?.handling || 'auto-fill').toLowerCase();
  const provenance = String(input?.provenance || 'dom').toLowerCase();
  return {
    category,
    sensitivity,
    handling,
    reasonCode: input?.reasonCode || (handling === 'auto-fill' ? 'safe_auto_fill' : handling),
    provenance,
    autoFill: handling === 'auto-fill'
  };
}

// ---------------------------------------------------------------------------
// FormFieldMapV1 — build, project, validate
// ---------------------------------------------------------------------------

const FIELD_MAP_VERSION = 1;
const MAX_STRUCTURAL_ORDINAL = 4095;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function structuralLocator(raw) {
  const ordinal = Number(raw?.locator?.ordinal ?? raw?.controlOrdinal ?? 0);
  return {
    strategy: 'selected-form-control',
    value: '',
    ordinal: Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal <= MAX_STRUCTURAL_ORDINAL ? ordinal : 0
  };
}

function structuralFormKey(selection) {
  const explicitOrdinal = Number(selection?.formOrdinal);
  if (Number.isSafeInteger(explicitOrdinal) && explicitOrdinal >= 0 && explicitOrdinal <= MAX_STRUCTURAL_ORDINAL) {
    return `form-${explicitOrdinal}`;
  }
  const match = /^form-(\d{1,4})$/.exec(String(selection?.formKey || ''));
  const ordinal = match ? Number(match[1]) : 0;
  return `form-${ordinal <= MAX_STRUCTURAL_ORDINAL ? ordinal : 0}`;
}

function hasApprovedResumePdf(s, artifact) {
  if (!artifact) return false;
  const document = one(s, 'SELECT render_manifest_json FROM artifact_resume_documents WHERE artifact_id=?', [artifact.id]);
  const manifest = parseJson(document?.render_manifest_json, null);
  const pdfPath = String(manifest?.pdfPath || '').replaceAll('\\', '/');
  return manifest?.format === 'pdf'
    && manifest?.status === 'passed'
    && SHA256_HEX.test(String(manifest.pdfHash || ''))
    && pdfPath.length > 0
    && pdfPath.length <= 512
    && !pdfPath.startsWith('/')
    && !pdfPath.split('/').includes('..')
    && pdfPath.toLowerCase().endsWith('.pdf');
}


function normalizeOption(opt) {
  if (!opt) return null;
  const optionKey = String(opt.optionKey || opt.value || '').trim();
  const label = normalizePrompt(opt.label || opt.optionKey || '');
  if (!optionKey && !label) return null;
  return {
    optionKey: optionKey || sha256Hex(label).slice(0, 16),
    label,
    disabled: Boolean(opt.disabled)
  };
}

function fieldKeyOf({ frameKey, atsFieldId, prompt, control, required, multiple, options }) {
  return sha256Hex(canonicalJson({
    frameKey,
    atsFieldId: atsFieldId || null,
    prompt,
    control,
    required: Boolean(required),
    multiple: Boolean(multiple),
    options
  }));
}

export function buildFormFieldMap({ fields }) {
  const out = [];
  for (const raw of fields || []) {
    const { frameKey } = normalizeFrameKey(raw.frame);
    const prompt = normalizePrompt(raw.prompt);
    const rawControl = String(raw.control || 'unsupported');
    const control = SUPPORTED_CONTROLS.has(rawControl) ? rawControl : 'unsupported';
    const required = Boolean(raw.required);
    const multiple = Boolean(raw.multiple);
    const atsFieldId = raw.atsFieldId ? String(raw.atsFieldId) : null;
    const options = (raw.options || [])
      .map(normalizeOption)
      .filter(Boolean)
      .map(o => ({ optionKey: o.optionKey, label: o.label, disabled: o.disabled }));

    const classification = classifyFormField({
      prompt,
      control: rawControl,
      category: raw.classification?.category,
      sensitivity: raw.classification?.sensitivity,
      handling: raw.classification?.handling,
      reasonCode: raw.classification?.reasonCode,
      provenance: raw.classification?.provenance
    });

    const fieldKey = fieldKeyOf({ frameKey, atsFieldId, prompt, control, required, multiple, options });

    out.push({
      fieldKey,
      frameKey,
      locator: structuralLocator(raw),
      atsFieldId,
      prompt,
      questionFingerprint: normalizePrompt(prompt),
      control,
      required,
      multiple,
      options,
      classification: {
        category: classification.category,
        sensitivity: classification.sensitivity,
        handling: classification.handling,
        reasonCode: classification.reasonCode,
        provenance: classification.provenance,
        autoFill: classification.autoFill
      }
    });
  }

  // Stable order: frameKey, then provided order (DOM/form order is preserved by caller).
  out.sort((a, b) => (a.frameKey < b.frameKey ? -1 : a.frameKey > b.frameKey ? 1 : 0));

  return { version: FIELD_MAP_VERSION, fields: out };
}

// Semantic projection excludes raw locator evidence and the autoFill helper.
// Exactly the fields specified in 5.1.
export function semanticFieldMapProjection(fieldMap) {
  const fields = (fieldMap?.fields || []).map(f => ({
    fieldKey: f.fieldKey,
    frameKey: f.frameKey,
    atsFieldId: f.atsFieldId ?? null,
    prompt: f.prompt,
    questionFingerprint: f.questionFingerprint,
    control: f.control,
    required: Boolean(f.required),
    multiple: Boolean(f.multiple),
    options: (f.options || []).map(o => ({
      optionKey: o.optionKey,
      label: o.label,
      disabled: Boolean(o.disabled)
    })),
    classification: {
      category: f.classification?.category,
      sensitivity: f.classification?.sensitivity,
      handling: f.classification?.handling,
      reasonCode: f.classification?.reasonCode,
      provenance: f.classification?.provenance
    }
  }));
  return fields;
}

export function validateFormFieldMap(map) {
  if (!map || map.version !== FIELD_MAP_VERSION) {
    throw formError('form_contract_unsupported', `Unsupported field map version: ${map?.version}`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// FormSnapshotV1 — build, fingerprint, currency, validate, format
// ---------------------------------------------------------------------------

const SNAPSHOT_VERSION = 1;

export function formSnapshotFingerprint(snapshot, { targetBinding: binding = snapshot?.targetBinding || null } = {}) {
  const projection = {
    version: snapshot.version,
    adapter: {
      id: snapshot.adapter?.id,
      protocolVersion: snapshot.adapter?.protocolVersion,
      sourceHash: snapshot.adapter?.sourceHash
    },
    finalOrigin: snapshot.target?.finalOrigin,
    finalPath: snapshot.target?.finalPath,
    selection: {
      frameKey: snapshot.selection?.frameKey,
      formKey: snapshot.selection?.formKey
    },
    fieldMap: semanticFieldMapProjection(snapshot.fieldMap)
  };
  if (binding) projection.targetBinding = binding;
  return sha256Hex(canonicalJson(projection));
}

export function buildFormSnapshot(input) {
  const requested = normalizeTargetUrl(input.requestedUrl);
  const finalUrl = normalizeTargetUrl(input.finalUrl);

  const fieldMap = buildFormFieldMap({ fields: input.fields });
  validateFormFieldMap(fieldMap);

  const selectionFrame = input.selection?.frame
    ? normalizeFrameKey(input.selection.frame).frameKey
    : String(input.selection?.frameKey || '');
  const selection = {
    frameKey: selectionFrame,
    formKey: structuralFormKey(input.selection),
    candidateCount: Number.isFinite(input.selection?.candidateCount) ? input.selection.candidateCount : 0,
    score: Number.isFinite(input.selection?.score) ? input.selection.score : 0
  };

  const adapter = {
    id: String(input.adapter?.id || ''),
    protocolVersion: Number.isFinite(input.adapter?.protocolVersion) ? input.adapter.protocolVersion : 1,
    sourceHash: String(input.adapter?.sourceHash || '')
  };

  const snapshot = {
    version: SNAPSHOT_VERSION,
    snapshotId: String(input.snapshotId || ''),
    jobId: String(input.jobId || ''),
    profileId: String(input.profileId || ''),
    capturedAt: String(input.capturedAt || ''),
    target: {
      requestedOrigin: requested.origin,
      requestedPath: requested.path,
      finalOrigin: finalUrl.origin,
      finalPath: finalUrl.path
    },
    adapter,
    selection,
    fieldMap,
    warnings: (input.warnings || []).map(w => ({
      code: String(w.code || ''),
      fieldKey: w.fieldKey || null,
      message: String(w.message || '')
    }))
  };
  Object.defineProperty(snapshot, PRIVATE_EXACT_TARGET, {
    value: {
      requestedUrl: exactTargetUrl(input.requestedUrl),
      finalUrl: exactTargetUrl(input.finalUrl)
    }
  });

  snapshot.fingerprint = formSnapshotFingerprint(snapshot);
  return snapshot;
}

export function validateFormSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
    throw formError('form_contract_unsupported', `Unsupported form snapshot version: ${snapshot?.version}`);
  }
  validateFormFieldMap(snapshot.fieldMap);
  return snapshot;
}

// Currency compares version + fingerprint + adapter hash, not capture time
// or snapshot id. A repeated identical inspection may create a new evidence
// row but produces the same fingerprint.
export function formSnapshotCurrency(reference, candidate) {
  if (!reference || !candidate) return 'stale';
  if (reference.version !== candidate.version) return 'stale';
  if (reference.fingerprint !== candidate.fingerprint) return 'stale';
  if (reference.adapter?.sourceHash !== candidate.adapter?.sourceHash) return 'stale';
  return 'current';
}

// ---------------------------------------------------------------------------
// Secret-safe formatted snapshot — no values, no locators, no raw HTML.
// Suitable for SQLite/YAML/JSON/TUI/ACP mirrors and mediated surfaces.
// ---------------------------------------------------------------------------
export function formatFormSnapshot(snapshot) {
  validateFormSnapshot(snapshot);
  return {
    version: snapshot.version,
    snapshotId: snapshot.snapshotId,
    jobId: snapshot.jobId,
    profileId: snapshot.profileId,
    capturedAt: snapshot.capturedAt,
    target: {
      requestedOrigin: snapshot.target.requestedOrigin,
      requestedPath: snapshot.target.requestedPath,
      finalOrigin: snapshot.target.finalOrigin,
      finalPath: snapshot.target.finalPath
    },
    adapter: {
      id: snapshot.adapter.id,
      protocolVersion: snapshot.adapter.protocolVersion,
      sourceHash: snapshot.adapter.sourceHash
    },
    selection: {
      frameKey: snapshot.selection.frameKey,
      formKey: snapshot.selection.formKey,
      candidateCount: snapshot.selection.candidateCount,
      score: snapshot.selection.score
    },
    fingerprint: snapshot.fingerprint,
    fields: semanticFieldMapProjection(snapshot.fieldMap),
    warnings: snapshot.warnings.map(w => ({
      code: w.code,
      fieldKey: w.fieldKey || null
    }))
  };
}

function rowToSnapshot(row) {
  if (!row) return null;
  const snapshot = {
    version: Number(row.version),
    snapshotId: row.id,
    jobId: row.job_id,
    profileId: row.profile_id,
    capturedAt: row.captured_at,
    target: {
      requestedOrigin: row.requested_origin,
      requestedPath: row.requested_path,
      finalOrigin: row.final_origin,
      finalPath: row.final_path
    },
    adapter: {
      id: row.adapter_id,
      protocolVersion: Number(row.adapter_protocol_version),
      sourceHash: row.adapter_source_hash
    },
    selection: parseJson(row.selection_json, {}),
    fieldMap: parseJson(row.field_map_json, { version: 1, fields: [] }),
    fingerprint: row.fingerprint,
    warnings: parseJson(row.warnings_json, [])
  };
  if (row.target_binding) Object.defineProperty(snapshot, 'targetBinding', { value: row.target_binding });
  return snapshot;
}

function answerRowFingerprint(answer) {
  return sha256Hex(canonicalJson({
    id: answer.id,
    updatedAt: answer.updated_at,
    sensitivity: answer.sensitivity,
    verificationStatus: answer.verification_status,
    reuseScope: answer.reuse_scope
  }));
}

function emptyBinding(field, mode = 'unresolved', reasonCode = 'unresolved_required_field') {
  return {
    version: 1,
    fieldKey: field.fieldKey,
    mode,
    answerId: null,
    answerRowFingerprint: null,
    profileResumeRevisionId: null,
    identityPath: null,
    identityComponentId: null,
    artifactId: null,
    artifactContentHash: null,
    expectedOptionKey: null,
    autoFill: false,
    reasonCode
  };
}

function identityPathFor(field) {
  const prompt = String(field.prompt || '').toLowerCase();
  if (field.control === 'email' || /e-?mail/.test(prompt)) return 'identity.email';
  if (field.control === 'tel' || /phone|telephone|mobile/.test(prompt)) return 'identity.phone';
  if (field.control === 'url' || /linkedin|portfolio|website|profile url/.test(prompt)) return 'identity.links';
  if (/location|city|address/.test(prompt)) return 'identity.location';
  if (/full name|your name|candidate name|legal name|^name$/.test(prompt)) return 'identity.name';
  return null;
}

function optionKeyForAnswer(field, answerText) {
  if (!field.options?.length) return null;
  const normalized = normalizePrompt(answerText);
  const option = field.options.find(item => normalizePrompt(item.label) === normalized || normalizePrompt(item.optionKey) === normalized);
  return option?.optionKey || null;
}

export function resolveFormBindings(s, { jobId, profileId, snapshot = null } = {}) {
  const currentSnapshot = snapshot || latestFormSnapshot(s, { jobId, profileId, raw: true });
  if (!currentSnapshot) {
    return {
      snapshot: null,
      bindings: [],
      requiredFieldCount: 0,
      resolvedFieldCount: 0,
      humanActionFieldKeys: [],
      unsupportedFieldKeys: [],
      unresolvedFieldKeys: [],
      formReady: false,
      autoFillComplete: false
    };
  }
  validateFormSnapshot(currentSnapshot);
  if (currentSnapshot.jobId !== jobId || currentSnapshot.profileId !== profileId) {
    throw formError('form_snapshot_target_mismatch', 'Form snapshot does not belong to the selected job and profile');
  }
  const job = one(s, 'SELECT company FROM jobs WHERE id=? AND profile_id=?', [jobId, profileId]);
  if (!job) throw formError('form_snapshot_target_mismatch', 'Unknown form snapshot job/profile target');
  const resumeRevision = one(s, 'SELECT * FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profileId]);
  const resumeDocument = parseJson(resumeRevision?.document_json, null);
  const resumeIdentity = resumeDocument?.identity?.verificationStatus === 'verified' ? resumeDocument.identity : null;
  const artifacts = all(s, `SELECT * FROM artifacts WHERE job_id=? AND profile_id=? AND type IN ('resume','cover_letter')
    AND approval_status='approved' ORDER BY revision DESC,created_at DESC,id DESC`, [jobId, profileId]);
  const currentArtifacts = new Map();
  for (const artifact of artifacts) if (!currentArtifacts.has(artifact.type)) currentArtifacts.set(artifact.type, artifact);
  const answers = all(s, `SELECT * FROM answers WHERE profile_id=? AND verification_status='verified'
    ORDER BY updated_at DESC,id DESC`, [profileId]);
  const bindings = [];
  for (const field of currentSnapshot.fieldMap.fields) {
    const classification = field.classification || {};
    if (classification.sensitivity === 'restricted' || classification.handling === 'human-input' || classification.handling === 'human-action') {
      bindings.push(emptyBinding(field, classification.handling === 'human-input' ? 'human-input' : 'human-action', classification.reasonCode || 'restricted_human_action'));
      continue;
    }
    if (classification.handling === 'unsupported' || field.control === 'unsupported') {
      bindings.push(emptyBinding(field, 'human-action', classification.reasonCode || 'unsupported_control'));
      continue;
    }
    if (field.control === 'file' || classification.handling === 'packet-material') {
      const type = /cover/.test(field.prompt) ? 'cover_letter' : 'resume';
      const artifact = currentArtifacts.get(type);
      if (type === 'cover_letter') {
        bindings.push(emptyBinding(field, 'human-action', 'cover_file_requires_human_upload'));
      } else if (artifact && hasApprovedResumePdf(s, artifact)) {
        bindings.push({
          ...emptyBinding(field),
          mode: 'packet-material',
          artifactId: artifact.id,
          artifactContentHash: artifact.content_hash,
          autoFill: true,
          reasonCode: 'approved_resume_pdf'
        });
      } else {
        bindings.push(emptyBinding(field, 'human-action', 'resume_pdf_requires_human_upload'));
      }
      continue;
    }
    const identityPath = identityPathFor(field);
    if (identityPath) {
      const key = identityPath.slice('identity.'.length);
      const value = resumeIdentity?.[key];
      const link = key === 'links' && Array.isArray(value) ? value.find(item => item && (typeof item === 'string' || item.verificationStatus === 'verified')) : null;
      const present = key === 'links' ? Boolean(link) : typeof value === 'string' && value.trim().length > 0;
      bindings.push(present && resumeRevision ? {
        ...emptyBinding(field),
        mode: 'profile-identity',
        profileResumeRevisionId: resumeRevision.id,
        identityPath,
        identityComponentId: key === 'links' && typeof link === 'object' ? link.id || null : null,
        autoFill: true,
        reasonCode: 'verified_profile_identity'
      } : emptyBinding(field, 'unresolved', 'identity_component_missing'));
      continue;
    }
    const answer = answers.find(row => row.question_fingerprint === field.questionFingerprint
      && !['sensitive', 'restricted'].includes(row.sensitivity)
      && row.reuse_scope !== 'never_auto_fill'
      && (row.reuse_scope !== 'employer_specific' || normalizePrompt(row.employer) === normalizePrompt(job.company)));
    if (answer) {
      const expectedOptionKey = optionKeyForAnswer(field, answer.answer_text);
      if (field.options?.length && !expectedOptionKey) {
        bindings.push(emptyBinding(field, 'unresolved', 'answer_option_mismatch'));
      } else {
        bindings.push({
          ...emptyBinding(field),
          mode: 'answer',
          answerId: answer.id,
          answerRowFingerprint: answerRowFingerprint(answer),
          expectedOptionKey,
          autoFill: true,
          reasonCode: 'exact_verified_answer'
        });
      }
      continue;
    }
    bindings.push(emptyBinding(field, 'unresolved', field.required ? 'unresolved_required_field' : 'optional_unmatched_field'));
  }
  const required = new Set(currentSnapshot.fieldMap.fields.filter(field => field.required).map(field => field.fieldKey));
  const unresolvedFieldKeys = bindings.filter(binding => binding.mode === 'unresolved' && required.has(binding.fieldKey)).map(binding => binding.fieldKey);
  const humanActionFieldKeys = bindings.filter(binding => ['human-input', 'human-action'].includes(binding.mode)).map(binding => binding.fieldKey);
  const unsupportedFieldKeys = bindings.filter(binding => binding.reasonCode === 'unsupported_control').map(binding => binding.fieldKey);
  const resolvedFieldCount = bindings.filter(binding => required.has(binding.fieldKey) && binding.mode !== 'unresolved').length;
  return {
    snapshot: currentSnapshot,
    bindings,
    requiredFieldCount: required.size,
    resolvedFieldCount,
    humanActionFieldKeys,
    unsupportedFieldKeys,
    unresolvedFieldKeys,
    formReady: unresolvedFieldKeys.length === 0,
    autoFillComplete: unresolvedFieldKeys.length === 0 && humanActionFieldKeys.length === 0 && unsupportedFieldKeys.length === 0
  };
}

export function canonicalPacketFormBinding(resolved) {
  if (!resolved?.snapshot) throw formError('form_inspection_required', 'A current form snapshot is required');
  return {
    version: 1,
    fingerprint: resolved.snapshot.fingerprint,
    formFingerprint: resolved.snapshot.fingerprint,
    fieldMapVersion: resolved.snapshot.fieldMap.version,
    adapter: {
      id: resolved.snapshot.adapter.id,
      protocolVersion: resolved.snapshot.adapter.protocolVersion,
      sourceHash: resolved.snapshot.adapter.sourceHash
    },
    bindings: resolved.bindings,
    requiredFieldCount: resolved.requiredFieldCount,
    humanActionFieldKeys: [...resolved.humanActionFieldKeys],
    unsupportedFieldKeys: [...resolved.unsupportedFieldKeys]
  };
}

export function bindFormSnapshotTarget(s, snapshot) {
  validateFormSnapshot(snapshot);
  const exactTarget = snapshot[PRIVATE_EXACT_TARGET];
  if (!exactTarget) throw formError('form_target_reinspection_required', 'Live form inspection did not retain its exact target');
  const key = formTargetKey(s);
  const binding = targetBinding(key, exactTarget);
  const structuralFingerprint = formSnapshotFingerprint(snapshot, { targetBinding: null });
  const fingerprint = formSnapshotFingerprint(snapshot, { targetBinding: binding });
  if (snapshot.fingerprint !== structuralFingerprint && snapshot.fingerprint !== fingerprint) {
    throw formError('form_snapshot_invalid', 'Live form fingerprint does not match its canonical evidence');
  }
  Object.defineProperty(snapshot, 'targetBinding', { value: binding, configurable: true });
  snapshot.fingerprint = fingerprint;
  return snapshot;
}

export function persistFormSnapshot(s, snapshot) {
  validateFormSnapshot(snapshot);
  const warnings = (snapshot.warnings || []).map(item => ({
    code: String(item.code || ''),
    fieldKey: item.fieldKey || null
  }));
  return guardedWrite(s, () => {
    const existing = one(s, 'SELECT * FROM form_snapshots WHERE id=?', [snapshot.snapshotId]);
    if (existing) {
      const current = rowToSnapshot(existing);
      if (current.fingerprint !== snapshot.fingerprint) {
        throw formError('form_snapshot_immutable', `Form snapshot ${snapshot.snapshotId} already exists with different evidence`);
      }
      return formatFormSnapshot(current);
    }
    const exactTarget = snapshot[PRIVATE_EXACT_TARGET];
    if (!exactTarget) throw formError('form_snapshot_invalid', 'New form snapshots require a private exact target');
    const structuralFingerprint = formSnapshotFingerprint(snapshot, { targetBinding: null });
    if (snapshot.fingerprint !== structuralFingerprint) {
      throw formError('form_snapshot_invalid', 'Form snapshot fingerprint does not match its canonical evidence');
    }
    const key = formTargetKey(s, { create: true });
    const binding = targetBinding(key, exactTarget);
    const fingerprint = formSnapshotFingerprint(snapshot, { targetBinding: binding });
    const envelope = encryptTarget(key, snapshot.snapshotId, exactTarget);
    Object.defineProperty(snapshot, 'targetBinding', { value: binding, configurable: true });
    snapshot.fingerprint = fingerprint;
    run(s, `INSERT INTO form_snapshots (
      id,version,job_id,profile_id,captured_at,requested_origin,requested_path,
      final_origin,final_path,adapter_id,adapter_protocol_version,adapter_source_hash,
      selection_json,field_map_json,fingerprint,target_binding,target_ciphertext,target_iv,target_tag,warnings_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      snapshot.snapshotId,
      snapshot.version,
      snapshot.jobId,
      snapshot.profileId,
      snapshot.capturedAt,
      snapshot.target.requestedOrigin,
      snapshot.target.requestedPath,
      snapshot.target.finalOrigin,
      snapshot.target.finalPath,
      snapshot.adapter.id,
      snapshot.adapter.protocolVersion,
      snapshot.adapter.sourceHash,
      JSON.stringify(snapshot.selection),
      JSON.stringify(snapshot.fieldMap),
      fingerprint,
      binding,
      envelope.ciphertext,
      envelope.iv,
      envelope.tag,
      JSON.stringify(warnings)
    ]);
    return formatFormSnapshot(rowToSnapshot(one(s, 'SELECT * FROM form_snapshots WHERE id=?', [snapshot.snapshotId])));
  });
}

export function getPrivateFormTarget(s, snapshotId) {
  const row = one(s, 'SELECT id,target_binding,target_ciphertext,target_iv,target_tag FROM form_snapshots WHERE id=?', [snapshotId]);
  if (!row) throw formError('form_snapshot_not_found', `Unknown form snapshot: ${snapshotId}`);
  if (!row.target_binding || !row.target_ciphertext || !row.target_iv || !row.target_tag) {
    throw formError('form_target_reinspection_required', 'This form snapshot predates exact-target protection; reinspect the form');
  }
  const key = formTargetKey(s);
  const target = decryptTarget(key, row);
  if (targetBinding(key, target) !== row.target_binding) {
    throw formError('form_target_reinspection_required', 'Private exact form target binding is invalid; reinspect the form');
  }
  return target;
}

export function getFormSnapshot(s, snapshotId, { raw = false } = {}) {
  const snapshot = rowToSnapshot(one(s, 'SELECT * FROM form_snapshots WHERE id=?', [snapshotId]));
  if (!snapshot) throw formError('form_snapshot_not_found', `Unknown form snapshot: ${snapshotId}`);
  return raw ? snapshot : formatFormSnapshot(snapshot);
}

export function listFormSnapshots(s, { jobId = null, profileId = null, raw = false } = {}) {
  if (!jobId && !profileId) throw formError('form_snapshot_filter_required', 'List form snapshots by jobId or profileId');
  const clauses = [];
  const params = [];
  if (jobId) {
    clauses.push('job_id=?');
    params.push(jobId);
  }
  if (profileId) {
    clauses.push('profile_id=?');
    params.push(profileId);
  }
  return all(s, `SELECT * FROM form_snapshots WHERE ${clauses.join(' AND ')} ORDER BY captured_at,id`, params)
    .map(rowToSnapshot)
    .map(snapshot => raw ? snapshot : formatFormSnapshot(snapshot));
}

export function latestFormSnapshot(s, { jobId, profileId, raw = true }) {
  const snapshot = rowToSnapshot(one(s, `SELECT * FROM form_snapshots
    WHERE job_id=? AND profile_id=? ORDER BY captured_at DESC,id DESC LIMIT 1`, [jobId, profileId]));
  if (!snapshot) return null;
  return raw ? snapshot : formatFormSnapshot(snapshot);
}