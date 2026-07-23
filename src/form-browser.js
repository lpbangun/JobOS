import crypto from 'node:crypto';
import { id, now } from './utils.js';
import { buildFormSnapshot, persistFormSnapshot } from './forms.js';
import { withAuthenticatedPage } from './browser.js';

const SHA256 = /^[a-f0-9]{64}$/;


function formBrowserError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

function hashesEqual(left, right) {
  if (!SHA256.test(String(left || '')) || !SHA256.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function validateAdapterManifest(manifest, {
  expectedSourceHash = null,
  expectedId = null,
  expectedProtocolVersion = null
} = {}) {
  if (!manifest || typeof manifest.id !== 'string'
    || !Number.isInteger(manifest.protocolVersion)
    || !SHA256.test(String(manifest.sourceHash || ''))) {
    throw formBrowserError('form_contract_unsupported', 'Form adapter manifest must include an id, integer protocol version, and SHA-256 source hash');
  }
  if (expectedId !== null && manifest.id !== expectedId) {
    throw formBrowserError('adapter_id_mismatch', `Form adapter identity changed from ${expectedId} to ${manifest.id}; reinspect before continuing`);
  }
  if (expectedProtocolVersion !== null && manifest.protocolVersion !== expectedProtocolVersion) {
    throw formBrowserError('adapter_protocol_mismatch', `Form adapter ${manifest.id} protocol version changed; reinspect before continuing`);
  }
  if (manifest.protocolVersion !== 1) {
    throw formBrowserError('form_contract_unsupported', 'Form adapter manifest must use protocol version 1');
  }
  if (expectedSourceHash !== null && !hashesEqual(manifest.sourceHash, expectedSourceHash)) {
    throw formBrowserError('adapter_hash_mismatch', `Form adapter ${manifest.id} source hash changed; reinspect before continuing`, {
      adapterId: manifest.id
    });
  }
  return { id: manifest.id, protocolVersion: manifest.protocolVersion, sourceHash: manifest.sourceHash };
}

const UNSAFE_ADAPTER_KEYS = /^(?:value|values|answer|answerText|html|rawHtml|cookies?|storage|storageState|authorization|password|secret|token)$/i;

function assertSecretSafeOutcome(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw formBrowserError('adapter_outcome_unsafe', 'Form adapter outcome contains a cycle');
  seen.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_ADAPTER_KEYS.test(key)) {
        throw formBrowserError('adapter_outcome_unsafe', `Form adapter outcome contains forbidden key: ${key}`);
      }
      assertSecretSafeOutcome(item, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function validateRegisteredInspectionOutcome(outcome, manifest, {
  requestedUrl,
  jobId,
  profileId,
  snapshotId = id('form_snapshot', `${jobId}:${profileId}:${now()}`),
  capturedAt = now(),
  expectedSourceHash = null
} = {}) {
  const adapter = validateAdapterManifest(manifest, { expectedSourceHash });
  assertSecretSafeOutcome(outcome);
  if (!outcome || !Array.isArray(outcome.fields) || !outcome.selection || !outcome.finalUrl) {
    throw formBrowserError('form_contract_unsupported', 'Registered form adapter inspection outcome is incomplete');
  }
  return buildFormSnapshot({
    snapshotId,
    jobId,
    profileId,
    capturedAt,
    requestedUrl,
    finalUrl: outcome.finalUrl,
    adapter,
    selection: outcome.selection,
    fields: outcome.fields,
    warnings: Array.isArray(outcome.warnings) ? outcome.warnings : []
  });
}

function fieldCategory(prompt, control) {
  const value = String(prompt || '').toLowerCase();
  if (/work (?:authorization|authorisation)|authorized to work|sponsor/.test(value)) return 'work_authorization';
  if (/race|ethnicity|gender|sex|veteran|disability|demographic/.test(value)) return 'demographic';
  if (/consent|certify|attest|terms|privacy|signature/.test(value)) return 'legal_attestation';
  if (control === 'file') return 'document';
  if (/e-?mail|phone|telephone|name|location|address|linkedin|portfolio|website/.test(value)) return 'identity';
  if (/motivation|why|cover letter|interest/.test(value)) return 'motivation';
  return 'other';
}

const RESTRICTED_IDENTITY_PROMPT = /\b(?:social security|ssn|national identification|national id|taxpayer identification|tax id|passport number|bank account|credit card)\b/i;
function classificationFor(prompt, control) {
  const category = fieldCategory(prompt, control);
  if (RESTRICTED_IDENTITY_PROMPT.test(String(prompt || ''))) {
    return { category, sensitivity: 'restricted', handling: 'human-input', reasonCode: 'restricted_identifier', provenance: 'hard-safety-rule' };
  }
  if (category === 'work_authorization' || category === 'demographic' || category === 'legal_attestation') {
    return { category, sensitivity: 'restricted', handling: category === 'legal_attestation' ? 'human-action' : 'human-input', reasonCode: category === 'legal_attestation' ? 'legal_consent' : 'restricted_category', provenance: 'hard-safety-rule' };
  }
  if (category === 'document') return { category, sensitivity: 'personal', handling: 'packet-material', reasonCode: 'packet_material', provenance: 'dom' };
  return { category, sensitivity: category === 'identity' ? 'personal' : 'public', handling: 'auto-fill', reasonCode: category === 'identity' ? 'profile_identity' : 'safe_auto_fill', provenance: 'dom' };
}

async function inspectFrame(frame, frameOrdinal) {
  const url = typeof frame.url === 'function' ? frame.url() : '';
  const name = typeof frame.name === 'function' ? frame.name() : '';
  let title = '';
  try { title = await frame.title(); } catch {}
  const frameInfo = { url, name, title, ordinal: frameOrdinal };
  let forms;
  try {
    forms = await frame.evaluate(() => {
      function visible(element) {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
      }
      function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
      function labelFor(control) {
        const id = control.id;
        const direct = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const wrapped = control.closest('label');
        const labelledBy = control.getAttribute('aria-labelledby');
        const aria = labelledBy ? labelledBy.split(/\s+/).map(key => document.getElementById(key)?.textContent || '').join(' ') : '';
        return text(direct?.innerText || wrapped?.innerText || aria || control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.name || id);
      }
      function groupLabel(control) {
        const fieldLabel = control.closest('.field')?.querySelector('.label');
        return text(fieldLabel?.textContent || labelFor(control));
      }
      function kind(control) {
        if (control.matches('[contenteditable="true"]')) return 'contenteditable';
        if (control.getAttribute('role') === 'combobox') return 'combobox';
        if (control.tagName === 'TEXTAREA') return 'textarea';
        if (control.tagName === 'SELECT') return control.multiple ? 'custom-multiselect' : 'select-one';
        const type = String(control.type || 'text').toLowerCase();
        if (type === 'radio') return 'radio';
        if (['text','email','tel','url','number','date','checkbox','file','hidden','password'].includes(type)) return type;
        return 'unsupported';
      }
      return [...document.forms].map((form, formIndex) => {
        const controls = [...form.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]')].filter(visible);
        const radioGroups = new Map();
        const fields = [];
        controls.forEach((control, ordinal) => {
          const controlKind = kind(control);
          if (controlKind === 'radio') {
            const key = control.name || `radio-${ordinal}`;
            if (!radioGroups.has(key)) radioGroups.set(key, { first: control, ordinal, controls: [] });
            radioGroups.get(key).controls.push(control);
            return;
          }
          fields.push({
            locator: { strategy: 'selected-form-control', value: '', ordinal },
            prompt: labelFor(control),
            control: controlKind,
            required: Boolean(control.required || control.getAttribute('aria-required') === 'true'),
            multiple: Boolean(control.multiple),
            atsFieldId: control.getAttribute('data-ats-field-id') || null,
            options: control.tagName === 'SELECT' ? [...control.options].map(option => ({ optionKey: option.value || text(option.textContent), label: text(option.textContent), disabled: option.disabled })) : []
          });
        });
        for (const [groupName, group] of radioGroups) {
          fields.push({
            locator: { strategy: 'selected-form-control', value: '', ordinal: group.ordinal },
            prompt: groupLabel(group.first),
            control: 'radio-group',
            required: group.controls.some(control => control.required || control.getAttribute('aria-required') === 'true'),
            multiple: false,
            atsFieldId: group.first.getAttribute('data-ats-field-id') || null,
            options: group.controls.map(control => ({ optionKey: control.value || labelFor(control), label: labelFor(control), disabled: control.disabled }))
          });
        }
        const allText = text(`${form.getAttribute('aria-label') || ''} ${form.innerText || ''}`).toLowerCase();
        const roleSearch = form.getAttribute('role') === 'search' || /search jobs|filter jobs/.test(allText);
        let score = 0;
        for (const field of fields) {
          const prompt = field.prompt.toLowerCase();
          if (field.control === 'file') score += 5;
          if (field.control === 'email' || /email|phone|full name/.test(prompt)) score += 2;
          if (/work authorization|sponsor|cover letter|resume|cv/.test(prompt)) score += 2;
          if (field.required) score += 0.25;
        }
        if (/application|apply for|candidate/.test(allText)) score += 3;
        if (roleSearch) score -= 20;
        const submit = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
        return {
          formIndex,
          formKey: `form-${formIndex}`,
          score,
          roleSearch,
          hasSubmit: Boolean(submit),
          fields
        };
      });
    });
  } catch {
    return { frameInfo, forms: null, inaccessible: true };
  }
  return { frameInfo, forms, inaccessible: false };
}

export const DOM_CONFIRMATION_POLICY = Object.freeze({
  markerValue: 'dom-v1',
  confirmedStatus: 'confirmed',
  maxReferenceLength: 64,
  maxPathLength: 512
});

const DOM_ADAPTER_SOURCE = [
  fieldCategory,
  RESTRICTED_IDENTITY_PROMPT,
  classificationFor,
  inspectFrame,
  JSON.stringify(DOM_CONFIRMATION_POLICY)
].map(value => value.toString()).join('\n');
export const DOM_ADAPTER_MANIFEST = Object.freeze({
  id: 'dom-v1',
  protocolVersion: 1,
  sourceHash: crypto.createHash('sha256').update(DOM_ADAPTER_SOURCE).digest('hex')
});

export async function inspectApplicationFormOnPage({
  page,
  requestedUrl,
  jobId,
  profileId,
  snapshotId = id('form_snapshot', `${jobId}:${profileId}:${now()}`),
  capturedAt = now(),
  adapterManifest = DOM_ADAPTER_MANIFEST,
  expectedAdapterHash = null
} = {}) {
  const adapter = validateAdapterManifest(adapterManifest, { expectedSourceHash: expectedAdapterHash });
  if (!page || typeof page.frames !== 'function') throw formBrowserError('browser_unavailable', 'A Playwright page is required for form inspection');
  const frames = page.frames();
  const inspected = [];
  for (let index = 0; index < frames.length; index += 1) inspected.push(await inspectFrame(frames[index], index));
  const candidates = inspected.flatMap((entry, frameOrder) => (entry.forms || [])
    .filter(form => !form.roleSearch && form.score >= 2 && form.fields.length > 0)
    .map(form => ({ ...form, frameOrder, frameInfo: entry.frameInfo })));
  candidates.sort((left, right) => right.score - left.score || left.frameOrder - right.frameOrder || left.formIndex - right.formIndex);
  const selected = candidates[0];
  if (!selected) {
    if (inspected.some(entry => entry.inaccessible)) throw formBrowserError('form_frame_unsupported', 'Required application form content is in an inaccessible frame');
    throw formBrowserError('application_form_not_found', 'No application form was found on the inspected page');
  }
  const fields = selected.fields.map(field => ({
    ...field,
    frame: selected.frameInfo,
    classification: classificationFor(field.prompt, field.control)
  }));
  const finalUrl = typeof page.url === 'function' ? page.url() : requestedUrl;
  return buildFormSnapshot({
    snapshotId,
    jobId,
    profileId,
    capturedAt,
    requestedUrl,
    finalUrl,
    adapter,
    selection: {
      frame: selected.frameInfo,
      formKey: selected.formKey,
      candidateCount: candidates.length,
      score: selected.score
    },
    fields,
    warnings: inspected.filter(entry => entry.inaccessible).map(() => ({ code: 'form_frame_unsupported', message: 'One frame could not be inspected.' }))
  });
}

export async function inspectLiveForm(s, {
  jobId,
  profileId,
  url,
  browserProfile = 'default',
  expectedAdapterHash = null,
  playwright,
  persist = true
} = {}) {
  return withAuthenticatedPage({
    workspace: s.root,
    name: browserProfile,
    url,
    playwright,
    headless: true,
    createIfMissing: true
  }, async ({ page }) => {
    const snapshot = await inspectApplicationFormOnPage({
      page,
      requestedUrl: url,
      jobId,
      profileId,
      adapterManifest: DOM_ADAPTER_MANIFEST,
      expectedAdapterHash
    });
    return persist ? persistFormSnapshot(s, snapshot) : snapshot;
  });
}
