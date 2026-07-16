#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpClient, agentBackendCatalog, jobosMcpServer, redactSensitive } from '../src/acp.js';
import { openStore, reload, one } from '../src/db.js';
import { selectedJobContext } from '../src/domain-tools.js';

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const name = value.slice(2);
    flags[name] = index + 1 < argv.length && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return flags;
}

function append(records, type, value = {}) {
  records.push(redactSensitive({ timestamp: new Date().toISOString(), type, ...value }));
}

export async function runAcpDemo({ workspace, profileId = null, jobId = null, output = null, timeoutMs = 300_000 } = {}) {
  const root = path.resolve(workspace || process.env.JOBOS_HOME || process.cwd());
  const transcriptPath = path.resolve(output || path.join(process.cwd(), '.tmp', 'acp-demo-transcript.jsonl'));
  const store = await openStore({ workspace: root });
  const job = jobId
    ? one(store, 'SELECT id,profile_id FROM jobs WHERE id=?', [jobId])
    : one(store, 'SELECT id,profile_id FROM jobs ORDER BY created_at DESC LIMIT 1');
  if (!job) throw Error('ACP demo needs one real JobOS job. Import a job before running the demo.');
  const selectedProfile = profileId || job.profile_id;
  if (!one(store, 'SELECT id FROM profiles WHERE id=?', [selectedProfile])) throw Error(`Unknown profile: ${selectedProfile}`);

  const records = [];
  const catalog = await agentBackendCatalog({ root });
  append(records, 'catalog', { catalog });
  const hermes = catalog.find(item => item.id === 'hermes-acp');
  if (!hermes?.available) throw Error(`Hermes ACP unavailable: ${hermes?.readiness || 'missing'}`);

  const before = {
    context: selectedJobContext(store, job.id),
    scoreAudits: Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [job.id])?.count || 0),
    appliedApplications: Number(one(store, "SELECT COUNT(*) AS count FROM applications WHERE job_id=? AND status='applied'", [job.id])?.count || 0)
  };
  append(records, 'before', before);

  const client = new AcpClient({ root, promptTimeoutMs: Number(timeoutMs) });
  client.on('frame', frame => append(records, 'acp_frame', frame));
  client.on('event', event => append(records, 'acp_event', { event }));
  client.on('state', state => append(records, 'acp_state', { state }));

  let firstTurn;
  let secondTurn;
  let policyTurn;
  let cancelledTurn;
  let recoveryTurn;
  let restartTurn;
  let cancelSent = false;
  let primarySessionId;
  let restartedSessionId;
  let cancelRecoverySessionId;
  let restartDetails;
  let processDetails;
  try {
    const connected = await client.connect({ mcpServers: [jobosMcpServer(root)] });
    processDetails = connected.process;
    append(records, 'connected', { connected });
    primarySessionId = client.sessionId;
    firstTurn = await client.prompt(
      `Call the JobOS score_job tool now with jobId ${job.id} and profileId ${selectedProfile}. Then call get_job_context for ${job.id}. Report the stored score and mode in one sentence. Do not use shell, filesystem, browser, or web tools.`,
      { context: before.context, timeoutMs: Number(timeoutMs) }
    );
    append(records, 'turn_complete', { turn: 1, sessionId: client.sessionId, result: firstTurn });

    reload(store);
    const between = selectedJobContext(store, job.id);
    append(records, 'host_refresh', { context: between });
    secondTurn = await client.prompt(
      `Follow up in the same session: call get_job_context for ${job.id} and confirm whether the score is persisted in JobOS. Answer in one sentence and cite the job ID.`,
      { context: between, timeoutMs: Number(timeoutMs) }
    );
    append(records, 'turn_complete', { turn: 2, sessionId: client.sessionId, result: secondTurn });
    policyTurn = await client.prompt(
      `Run a deliberate JobOS policy negative test in this same session: call create_application with jobId ${job.id}, status applied, and notes \"ACP policy probe\". Do not claim the application was submitted. Report the exact denial code returned by JobOS.`,
      { context: between, timeoutMs: Number(timeoutMs) }
    );
    append(records, 'turn_complete', { turn: 3, sessionId: client.sessionId, result: policyTurn });
    const pendingCancellation = client.prompt(
      'Begin a long response describing the selected job in at least twenty numbered observations. Do not call tools.',
      { context: between, timeoutMs: Number(timeoutMs) }
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    append(records, 'cancel_requested', { sessionId: client.sessionId });
    cancelSent = client.cancel();
    cancelledTurn = await pendingCancellation;
    append(records, 'turn_complete', { turn: 4, sessionId: client.sessionId, purpose: 'live_cancel', result: cancelledTurn });
    append(records, 'cancel_acknowledged', { sessionId: client.sessionId, recoveryRequired: client.details().recoveryRequired });
    await new Promise(resolve => setTimeout(resolve, 500));
    append(records, 'recovery_prompt_started', { quarantinedSessionId: client.sessionId });
    recoveryTurn = await client.prompt(
      `After cancellation, call get_job_context for ${job.id} and report only its stored score.`,
      { context: between, timeoutMs: Number(timeoutMs) }
    );
    cancelRecoverySessionId = client.sessionId;
    append(records, 'turn_complete', { turn: 5, sessionId: cancelRecoverySessionId, purpose: 'post_cancel_recovery', result: recoveryTurn });
    const restarted = await client.restart();
    restartedSessionId = client.sessionId;
    restartDetails = restarted.process;
    append(records, 'restarted', { previousSessionId: cancelRecoverySessionId, connected: restarted });
    restartTurn = await client.prompt(
      `After backend restart, call get_job_context for ${job.id} and confirm JobOS still owns the stored score.`,
      { context: between, timeoutMs: Number(timeoutMs) }
    );
    append(records, 'turn_complete', { turn: 6, sessionId: client.sessionId, purpose: 'post_restart_recovery', result: restartTurn });
  } finally {
    await client.stop();
    append(records, 'stopped', { process: client.details() });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  }

  let missingBackendError = null;
  const missingClient = new AcpClient({ root, command: 'jobos-acp-deliberately-missing' });
  missingClient.on('state', state => append(records, 'missing_backend_state', { state }));
  try {
    await missingClient.connect();
  } catch (error) {
    missingBackendError = typeof error?.toJSON === 'function' ? error.toJSON() : { code: error?.code || null, message: error?.message || String(error) };
    append(records, 'missing_backend', { error: missingBackendError });
  }

  let timeoutError = null;
  let timeoutProcess = null;
  const timeoutClient = new AcpClient({ root, promptTimeoutMs: 25 });
  timeoutClient.on('state', state => append(records, 'timeout_probe_state', { state }));
  timeoutClient.on('event', event => append(records, 'timeout_probe_event', { event }));
  try {
    await timeoutClient.connect();
    timeoutProcess = timeoutClient.details();
    append(records, 'timeout_probe_connected', { process: timeoutProcess });
    await timeoutClient.prompt(
      'Write a detailed response with at least fifty numbered observations. Do not call tools.',
      { context: before.context, timeoutMs: 25 }
    );
  } catch (error) {
    timeoutError = typeof error?.toJSON === 'function' ? error.toJSON() : { code: error?.code || null, message: error?.message || String(error) };
    append(records, 'timeout_probe', { error: timeoutError });
  } finally {
    await timeoutClient.stop();
    append(records, 'timeout_probe_stopped', { process: timeoutClient.details() });
  }

  reload(store);
  const after = {
    context: selectedJobContext(store, job.id),
    scoreAudits: Number(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='job.scored' AND entity_id=?", [job.id])?.count || 0),
    appliedApplications: Number(one(store, "SELECT COUNT(*) AS count FROM applications WHERE job_id=? AND status='applied'", [job.id])?.count || 0)
  };
  const toolEvents = records.filter(record => record.type === 'acp_event' && ['tool_start', 'tool_update'].includes(record.event?.type));
  const messageEvents = records.filter(record => record.type === 'acp_event' && record.event?.type === 'agent_message');
  const policyDenied = toolEvents.some(record => JSON.stringify(record.event?.rawOutput || '').includes('agent_human_confirmation_denied'));
  const visibleMutation = before.context.fit?.overall == null && Number.isFinite(after.context.fit?.overall);
  const sentinel = process.env.JOBOS_LLM_API_KEY || '';
  const sentinelRedacted = !sentinel || !JSON.stringify(records).includes(sentinel);
  const preCancelSessionIds = [...new Set(records
    .filter(record => record.type === 'turn_complete' && record.turn <= 4)
    .map(record => record.sessionId)
    .filter(Boolean))];
  const cancelIndex = records.findIndex(record => record.type === 'cancel_requested');
  const recoveryIndex = records.findIndex(record => record.type === 'recovery_prompt_started');
  const recoveryCompleteIndex = records.findIndex(record => record.type === 'turn_complete' && record.turn === 5);
  const postCancelEvents = records.slice(cancelIndex + 1, recoveryIndex).filter(record => record.type === 'acp_event');
  const postCancelSessionUpdates = postCancelEvents.filter(record => record.event?.source === 'session_update');
  const postCancelLeakedEvents = postCancelSessionUpdates.filter(record => record.event?.type !== 'discarded_update');
  const discardedUpdates = postCancelSessionUpdates.filter(record => record.event?.type === 'discarded_update');
  const recoveryToolEvents = records.slice(recoveryIndex + 1, recoveryCompleteIndex).filter(record => record.type === 'acp_event' && ['tool_start', 'tool_update'].includes(record.event?.type));
  const recoveryContextToolIds = new Set(recoveryToolEvents
    .filter(record => record.event?.type === 'tool_start' && String(record.event?.title || '').includes('get_job_context'))
    .map(record => record.event?.toolCallId)
    .filter(Boolean));
  const recoveryToolCompleted = recoveryToolEvents.some(record => record.event?.type === 'tool_update'
    && record.event?.status === 'completed'
    && recoveryContextToolIds.has(record.event?.toolCallId));
  const cleanCancelRecovery = recoveryTurn?.stopReason === 'end_turn'
    && cancelRecoverySessionId !== primarySessionId
    && postCancelLeakedEvents.length === 0
    && recoveryToolCompleted;
  const summary = {
    ok: firstTurn?.stopReason === 'end_turn'
      && secondTurn?.stopReason === 'end_turn'
      && policyTurn?.stopReason === 'end_turn'
      && cancelSent
      && cancelledTurn?.stopReason === 'cancelled'
      && recoveryTurn?.stopReason === 'end_turn'
      && restartTurn?.stopReason === 'end_turn'
      && preCancelSessionIds.length === 1
      && preCancelSessionIds[0] === primarySessionId
      && cancelRecoverySessionId
      && cancelRecoverySessionId !== primarySessionId
      && restartedSessionId
      && restartedSessionId !== cancelRecoverySessionId
      && postCancelLeakedEvents.length === 0
      && recoveryToolCompleted
      && toolEvents.length >= 4
      && after.scoreAudits > before.scoreAudits
      && Number.isFinite(after.context.fit?.overall)
      && visibleMutation
      && policyDenied
      && after.appliedApplications === before.appliedApplications
      && missingBackendError?.code === 'acp_missing_executable'
      && timeoutError?.code === 'acp_request_timeout'
      && sentinelRedacted,
    backend: processDetails,
    restartBackend: restartDetails,
    timeoutBackend: timeoutProcess,
    workspace: root,
    profileId: selectedProfile,
    jobId: job.id,
    sessionId: primarySessionId,
    restartedSessionId,
    cancelRecoverySessionId,
    turns: [
      firstTurn?.stopReason || null,
      secondTurn?.stopReason || null,
      policyTurn?.stopReason || null,
      cancelledTurn?.stopReason || null,
      recoveryTurn?.stopReason || null,
      restartTurn?.stopReason || null
    ],
    toolEventCount: toolEvents.length,
    messageEventCount: messageEvents.length,
    scoreAuditDelta: after.scoreAudits - before.scoreAudits,
    visibleMutation,
    cancelSent,
    recoveredAfterCancel: cleanCancelRecovery,
    postCancelLeakedEventCount: postCancelLeakedEvents.length,
    discardedUpdateCount: discardedUpdates.length,
    recoveryToolCompleted,
    recoveredAfterRestart: restartTurn?.stopReason === 'end_turn',
    missingBackendCode: missingBackendError?.code || null,
    timeoutCode: timeoutError?.code || null,
    sentinelConfigured: Boolean(sentinel),
    sentinelRedacted,
    policyDenied,
    appliedApplicationDelta: after.appliedApplications - before.appliedApplications,
    fitBefore: before.context.fit,
    fitAfter: after.context.fit,
    transcript: transcriptPath
  };
  append(records, 'summary', summary);
  fs.writeFileSync(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  if (!summary.ok) throw Object.assign(new Error(`ACP demo did not meet the real-session bar; inspect ${transcriptPath}`), { summary });
  return summary;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const summary = await runAcpDemo({
    workspace: flags.workspace,
    profileId: flags.profile || null,
    jobId: flags.job || null,
    output: flags.output || null,
    timeoutMs: typeof flags.timeout === 'string' && Number.isFinite(Number(flags.timeout)) ? Number(flags.timeout) : 300_000
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`jobos-acp-demo: ${error.message}`);
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    process.exitCode = 1;
  });
}
