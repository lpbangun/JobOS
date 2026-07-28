import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { redactSensitive } from '../../../src/acp.js';
import { addAnswer } from '../../../src/answers.js';
import { recordJobFeedback } from '../../../src/career-memory-observations.js';
import { retrieveCareerMemory } from '../../../src/career-memory-retrieval.js';
import { callDomainTool } from '../../../src/domain-tools.js';
import { openStore, one } from '../../../src/db.js';
import { buildFormSnapshot, persistFormSnapshot } from '../../../src/forms.js';
import { validateFormFillAuthorization } from '../../../src/form-actions.js';
import { DOM_ADAPTER_MANIFEST } from '../../../src/form-browser.js';
import { validateFormSubmissionAuthorization } from '../../../src/form-submission.js';
import { startMcp } from '../../../src/mcp.js';
import { attestApplicationSubmitted, createApplicationPacket } from '../../../src/packets.js';
import { compileApplicationReadiness } from '../../../src/readiness.js';
import { seedW02Workspace } from '../w02-seed.js';

function sentinel(...parts) {
  return parts.join('_');
}

export const SENTINELS = Object.freeze({
  CM_PRIVATE_NOTE_SENTINEL: sentinel('CM', 'PRIVATE', 'NOTE', 'SENTINEL', 'VALUE', 'W10'),
  CM_PRIVATE_PAYLOAD_SENTINEL: sentinel('CM', 'PRIVATE', 'PAYLOAD', 'SENTINEL', 'VALUE', 'W10'),
  RESTRICTED_ANSWER_SENTINEL: sentinel('RESTRICTED', 'ANSWER', 'SENTINEL', 'VALUE', 'W10'),
  URL_USERINFO_QUERY_SENTINEL: sentinel('URL', 'USERINFO', 'QUERY', 'SENTINEL', 'VALUE', 'W10'),
  BROWSER_COOKIE_STATE_SENTINEL: sentinel('BROWSER', 'COOKIE', 'STATE', 'SENTINEL', 'VALUE', 'W10'),
  ACP_STDERR_TRANSCRIPT_SENTINEL: sentinel('ACP', 'STDERR', 'TRANSCRIPT', 'SENTINEL', 'VALUE', 'W10'),
  FORM_LOCATOR_CONFIRMATION_SENTINEL: sentinel('FORM', 'LOCATOR', 'CONFIRMATION', 'SENTINEL', 'VALUE', 'W10')
});

const CM_AS_OF = '2026-07-25T12:00:00.000Z';

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function cliMemory(root, jobId) {
  const result = spawnSync(process.execPath, [
    'src/cli.js', 'memory', 'retrieve', '--profile', 'alpha', '--consumer', 'discovery', '--job', jobId, '--as-of', CM_AS_OF, '--json'
  ], { cwd: process.cwd(), env: { ...process.env, JOBOS_HOME: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runMcp(store, profileId, jobId) {
  const input = new PassThrough();
  const responses = [];
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'w10-sentinel', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'score_job', arguments: { profileId, jobId } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_job_context', arguments: { profileId, jobId } } }
  ];
  const session = startMcp(store, { input, send: message => responses.push(message) });
  input.end(`${requests.map(request => JSON.stringify(request)).join('\n')}\n`);
  await session.completed;
  return { requests: requests.map(request => ({ id: request.id, method: request.method, tool: request.params?.name || null })), responses };
}

function secretFormSnapshot(fixture) {
  const frame = { url: 'https://apply.w10.test/jobs/1', name: '', title: '', ordinal: 0 };
  const locator = (value, ordinal) => ({ strategy: 'name', value, ordinal });
  return buildFormSnapshot({
    snapshotId: 'form_snapshot_w10_sentinel',
    jobId: fixture.job.id,
    profileId: fixture.profile.id,
    capturedAt: '2026-07-22T12:00:00.000Z',
    requestedUrl: `https://apply.w10.test/jobs/1?token=${SENTINELS.URL_USERINFO_QUERY_SENTINEL}`,
    finalUrl: `https://apply.w10.test/jobs/1?confirmation=${SENTINELS.URL_USERINFO_QUERY_SENTINEL}`,
    adapter: DOM_ADAPTER_MANIFEST,
    selection: { frame, formKey: 'application', candidateCount: 1, score: 12 },
    fields: [
      { frame, locator: locator('full_name', 0), prompt: 'Full name', control: 'text', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
      { frame, locator: locator('email', 1), prompt: 'Email', control: 'email', required: true, classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'profile_identity', provenance: 'dom' } },
      { frame, locator: locator('why', 2), prompt: 'Why this role?', control: 'textarea', required: true, classification: { category: 'motivation', sensitivity: 'public', handling: 'auto-fill', reasonCode: 'safe_auto_fill', provenance: 'dom' } },
      { frame, locator: locator('resume', 3), prompt: 'Resume', control: 'file', required: true, classification: { category: 'document', sensitivity: 'personal', handling: 'packet-material', reasonCode: 'packet_material', provenance: 'dom' } },
      { frame, locator: locator(SENTINELS.FORM_LOCATOR_CONFIRMATION_SENTINEL, 4), prompt: 'Are you authorized to work?', control: 'radio-group', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], classification: { category: 'work_authorization', sensitivity: 'restricted', handling: 'human-input', reasonCode: 'restricted_category', provenance: 'hard-safety-rule' } },
      { frame, locator: locator('consent', 5), prompt: 'I certify this application', control: 'checkbox', required: true, classification: { category: 'legal_attestation', sensitivity: 'restricted', handling: 'human-action', reasonCode: 'legal_consent', provenance: 'hard-safety-rule' } }
    ],
    warnings: []
  });
}

export async function createSentinelLeakFixture({ root }) {
  const rawRoot = path.join(root, 'raw-inputs');
  const publicRoot = path.join(root, 'public-artifacts');
  mkdirSync(rawRoot, { recursive: true });
  mkdirSync(publicRoot, { recursive: true });
  const rawInputs = [];
  const artifacts = [];
  const cleanup = [];
  const fakeTest = { after: callback => cleanup.push(callback) };

  const w02 = await seedW02Workspace(fakeTest);
  addAnswer(w02.store, {
    profileId: w02.profile.id,
    category: 'work_authorization',
    question: 'Are you authorized to work?',
    answer: SENTINELS.RESTRICTED_ANSWER_SENTINEL,
    sensitivity: 'restricted',
    reuseScope: 'never_auto_fill',
    verificationStatus: 'verified',
    sourceRef: `job:${w02.job.id}`
  });
  const secretSnapshot = secretFormSnapshot(w02);
  persistFormSnapshot(w02.store, secretSnapshot);
  const browserState = writeJson(path.join(rawRoot, 'browser-state.json'), {
    url: `https://user:${SENTINELS.URL_USERINFO_QUERY_SENTINEL}@apply.w10.test/jobs/1?token=${SENTINELS.URL_USERINFO_QUERY_SENTINEL}`,
    cookies: [{ name: 'session', value: SENTINELS.BROWSER_COOKIE_STATE_SENTINEL }],
    locator: SENTINELS.FORM_LOCATOR_CONFIRMATION_SENTINEL,
    restrictedAnswer: SENTINELS.RESTRICTED_ANSWER_SENTINEL
  });
  rawInputs.push(browserState);

  const packet = createApplicationPacket(w02.store, { jobId: w02.job.id, profileId: w02.profile.id, createdBy: 'cli' });
  const previous = {
    fill: process.env.JOBOS_FORM_FILL_ENABLED,
    submit: process.env.JOBOS_FORM_SUBMIT_ENABLED,
    agent: process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED
  };
  process.env.JOBOS_FORM_FILL_ENABLED = '1';
  process.env.JOBOS_FORM_SUBMIT_ENABLED = '1';
  process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = '1';
  let fillPolicy;
  let submitPolicy;
  try {
    fillPolicy = validateFormFillAuthorization(w02.store, { profileId: w02.profile.id, allowSideEffects: true });
    submitPolicy = validateFormSubmissionAuthorization(w02.store, { profileId: w02.profile.id, allowSubmit: true });
  } finally {
    if (previous.fill === undefined) delete process.env.JOBOS_FORM_FILL_ENABLED; else process.env.JOBOS_FORM_FILL_ENABLED = previous.fill;
    if (previous.submit === undefined) delete process.env.JOBOS_FORM_SUBMIT_ENABLED; else process.env.JOBOS_FORM_SUBMIT_ENABLED = previous.submit;
    if (previous.agent === undefined) delete process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED; else process.env.JOBOS_AGENT_FORM_INVOCATION_ENABLED = previous.agent;
  }
  const outcome = attestApplicationSubmitted(w02.store, { packetId: packet.id, submittedAt: '2026-07-22T15:00:00.000Z', source: 'cli', note: 'W10 containment fixture' });
  const mcp = await runMcp(w02.store, w02.profile.id, w02.job.id);
  artifacts.push(writeJson(path.join(publicRoot, 'w02-public.json'), {
    readiness: compileApplicationReadiness(w02.store, { jobId: w02.job.id, profileId: w02.profile.id }),
    packet: { id: packet.id, contentHash: packet.contentHash, formFingerprint: packet.form.formFingerprint },
    mediation: { fillPolicy, submitPolicy },
    outcome,
    mcp
  }));

  const cmRoot = path.join(root, 'career-memory-workspace');
  mkdirSync(path.join(cmRoot, '.jobos'), { recursive: true });
  copyFileSync(path.resolve('tests/fixtures/w08-schema14.sqlite'), path.join(cmRoot, '.jobos', 'jobos.sqlite'));
  const cmStore = await openStore({ workspace: cmRoot });
  const cmJob = one(cmStore, "SELECT id,title FROM jobs WHERE profile_id='alpha' AND status='saved' ORDER BY id LIMIT 1");
  const observation = recordJobFeedback(cmStore, {
    profileId: 'alpha',
    jobId: cmJob.id,
    input: {
      schema: 'jobos.job-feedback-input.v1',
      decision: 'save',
      reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: cmJob.title, match: 'exact' }],
      publicExplanation: '',
      privateNote: SENTINELS.CM_PRIVATE_NOTE_SENTINEL,
      referenceId: 'w10-sentinel-private-note',
      occurredAt: '2026-07-24T10:00:00.000Z'
    },
    actor: 'user',
    source: 'cli'
  });
  let privatePayloadError;
  try {
    recordJobFeedback(cmStore, {
      profileId: 'alpha', jobId: cmJob.id,
      input: {
        schema: 'jobos.job-feedback-input.v1', decision: 'save', reasonCodes: ['role_fit'], signals: [], publicExplanation: '', privateNote: '',
        referenceId: 'w10-sentinel-private-payload', occurredAt: '2026-07-24T11:00:00.000Z', arbitraryPayload: SENTINELS.CM_PRIVATE_PAYLOAD_SENTINEL
      },
      actor: 'user', source: 'cli'
    });
  } catch (error) {
    privatePayloadError = { code: error.code, type: error.type };
  }
  rawInputs.push(writeJson(path.join(rawRoot, 'career-memory-private-input.json'), {
    privateNote: SENTINELS.CM_PRIVATE_NOTE_SENTINEL,
    arbitraryPayload: SENTINELS.CM_PRIVATE_PAYLOAD_SENTINEL
  }));
  const retrieval = retrieveCareerMemory(cmStore, { profileId: 'alpha', consumer: 'discovery', jobId: cmJob.id, asOf: new Date(CM_AS_OF) });
  const domain = await callDomainTool(cmStore, 'retrieve_career_memory', { profileId: 'alpha', consumer: 'discovery', jobId: cmJob.id, asOf: CM_AS_OF }, { source: 'cli' });
  const cli = cliMemory(cmRoot, cmJob.id);
  const mirror = readFileSync(path.join(cmRoot, 'jobos-workspace', 'profiles', 'alpha', 'memory', 'observations.yaml'), 'utf8');
  artifacts.push(writeJson(path.join(publicRoot, 'career-memory-public.json'), { observationId: observation.id, privatePayloadError, retrieval, domain, cli, mirror }));

  const acpRaw = writeJson(path.join(rawRoot, 'acp-stderr.json'), { stderr: SENTINELS.ACP_STDERR_TRANSCRIPT_SENTINEL });
  rawInputs.push(acpRaw);
  const acp = redactSensitive({ stderr: SENTINELS.ACP_STDERR_TRANSCRIPT_SENTINEL, transcript: [`token=${SENTINELS.ACP_STDERR_TRANSCRIPT_SENTINEL}`] }, { ACP_SECRET_TOKEN: SENTINELS.ACP_STDERR_TRANSCRIPT_SENTINEL });
  artifacts.push(writeJson(path.join(publicRoot, 'acp-redacted.json'), acp));

  const summary = {
    schema: 'jobos.w10-sentinel-containment.v1',
    sentinelCount: Object.keys(SENTINELS).length,
    rawInputCount: rawInputs.length,
    artifactCount: artifacts.length,
    mcpMethods: mcp.requests.map(request => request.tool || request.method),
    careerMemoryError: privatePayloadError.code,
    configuredMediation: true
  };
  artifacts.push(writeJson(path.join(publicRoot, 'summary.json'), summary));

  cmStore.db.close();
  for (const callback of cleanup.reverse()) callback();
  return { sentinels: SENTINELS, rawInputs, artifacts, summary };
}

export function removeSentinelFixture(root) {
  rmSync(root, { recursive: true, force: true });
}
