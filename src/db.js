import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { id, now, paths, workspaceRoot } from './utils.js';
import { mkdirs } from './workspace.js';
import { seedDefaultAutomations } from './scheduler/store.js';

const require = createRequire(import.meta.url);
let SQL;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

const schema = `PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, preferences_json TEXT NOT NULL, resume_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proof_points (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', skills_json TEXT NOT NULL DEFAULT '[]', metrics_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual', metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired','needs_verification')), verification_status TEXT NOT NULL DEFAULT 'verified' CHECK(verification_status IN ('verified','unverified','rejected')), source_resume_entry_id TEXT, supersedes_proof_point_id TEXT, updated_at TEXT NOT NULL, retired_at TEXT, retirement_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id), FOREIGN KEY(supersedes_proof_point_id) REFERENCES proof_points(id));
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '[]', domain TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]', source_confidence TEXT NOT NULL DEFAULT 'low', identity_sources_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, company_id TEXT, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', description TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', compensation TEXT NOT NULL DEFAULT '', compensation_json TEXT NOT NULL DEFAULT '{}', work_model TEXT NOT NULL DEFAULT '', employment_types_json TEXT NOT NULL DEFAULT '[]', department TEXT NOT NULL DEFAULT '', source_native_json TEXT NOT NULL DEFAULT '{}', liveness_status TEXT NOT NULL DEFAULT 'uncertain', liveness_checked_at TEXT, liveness_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'imported', fit_score INTEGER, score_json TEXT, high_fit INTEGER NOT NULL DEFAULT 0, posted_date TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL DEFAULT '', source_history_json TEXT NOT NULL DEFAULT '[]', first_seen_at TEXT, last_seen_at TEXT, reposted INTEGER NOT NULL DEFAULT 0, discovery_run_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,url), FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL, adapter TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', min_fit INTEGER NOT NULL DEFAULT 70, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS company_watchlist (id TEXT PRIMARY KEY, company TEXT NOT NULL, adapter TEXT NOT NULL, handle TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company,adapter,handle));
CREATE TABLE IF NOT EXISTS stakeholders (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', links_json TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', outreach_status TEXT NOT NULL DEFAULT 'not_contacted', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', confirmation_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(job_id,profile_id));
CREATE TABLE IF NOT EXISTS status_changes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', approval_status TEXT NOT NULL DEFAULT 'draft_needs_human_review' CHECK(approval_status IN ('draft_needs_human_review','approved','rejected')), created_at TEXT NOT NULL, series_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), supersedes_artifact_id TEXT, content_hash TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT, review_note TEXT NOT NULL DEFAULT '', UNIQUE(series_key,revision), FOREIGN KEY(supersedes_artifact_id) REFERENCES artifacts(id));
CREATE TABLE IF NOT EXISTS profile_resume_revisions (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), schema_version INTEGER NOT NULL, source_text TEXT NOT NULL DEFAULT '', source_text_hash TEXT NOT NULL, document_json TEXT NOT NULL, verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','needs_verification','rejected')), supersedes_resume_id TEXT, is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)), created_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE(profile_id,revision), FOREIGN KEY(profile_id) REFERENCES profiles(id), FOREIGN KEY(supersedes_resume_id) REFERENCES profile_resume_revisions(id));
CREATE UNIQUE INDEX IF NOT EXISTS profile_resume_current_idx ON profile_resume_revisions(profile_id) WHERE is_current=1;
CREATE TABLE IF NOT EXISTS artifact_resume_documents (artifact_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source_resume_revision_id TEXT NOT NULL, document_json TEXT NOT NULL, coverage_json TEXT NOT NULL DEFAULT '{}', validation_json TEXT NOT NULL DEFAULT '{}', layout_profile_json TEXT NOT NULL DEFAULT '{}', render_manifest_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(artifact_id) REFERENCES artifacts(id), FOREIGN KEY(source_resume_revision_id) REFERENCES profile_resume_revisions(id));
CREATE TABLE IF NOT EXISTS outreach_threads (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, goal TEXT NOT NULL DEFAULT 'informational', channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'drafted', sent_at TEXT, next_followup_at TEXT, followup_task_id TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_observations (id TEXT PRIMARY KEY, company_id TEXT, job_id TEXT, url TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT, snippet TEXT, source_type TEXT NOT NULL, provider TEXT NOT NULL, query TEXT, trust TEXT NOT NULL, fetched_at TEXT NOT NULL, content_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS person_candidates (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT, function TEXT, seniority TEXT, relevance TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'candidate', suppression_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_points (id TEXT PRIMARY KEY, person_id TEXT, stakeholder_id TEXT, company_id TEXT, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, evidence_tier TEXT NOT NULL, verification_status TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '{}', human_approved INTEGER NOT NULL DEFAULT 0, do_not_use INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_patterns (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, domain TEXT NOT NULL, pattern TEXT NOT NULL, support_count INTEGER NOT NULL, support_sources_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relationship_edges (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_plans (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, contact_point_id TEXT, goal TEXT NOT NULL, channel TEXT NOT NULL, path_strength TEXT NOT NULL, recommended INTEGER NOT NULL DEFAULT 0, reasoning_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL, question_fingerprint TEXT NOT NULL, question_text TEXT NOT NULL, answer_text TEXT NOT NULL, sensitivity TEXT NOT NULL, reuse_scope TEXT NOT NULL, verification_status TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', employer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,question_fingerprint,employer), FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, job_id TEXT, application_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'review', due_at TEXT, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL, schedule TEXT NOT NULL, profile_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, last_status TEXT NOT NULL DEFAULT 'never_run', consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, trigger_name TEXT NOT NULL, inputs_json TEXT NOT NULL DEFAULT '{}', outputs_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, external_side_effects TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, automation_id TEXT, action_id TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual', started_at TEXT, finished_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT, counts_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL, primary_profile_url TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]', identity_confidence TEXT NOT NULL DEFAULT 'low', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_affiliations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, type TEXT NOT NULL, organization TEXT NOT NULL, normalized_organization TEXT NOT NULL, role_or_program TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT, source TEXT NOT NULL DEFAULT 'manual', source_observation_ids_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'suggested', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS person_affiliations (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, type TEXT NOT NULL, organization TEXT NOT NULL, normalized_organization TEXT NOT NULL, role_or_program TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT, source TEXT NOT NULL DEFAULT 'manual', source_observation_ids_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'suggested', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, profile_id TEXT, scope TEXT NOT NULL, job_id TEXT, company_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', person_id TEXT, depth TEXT NOT NULL DEFAULT 'standard', sources_json TEXT NOT NULL DEFAULT '[]', budget_json TEXT NOT NULL DEFAULT '{}', usage_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', checkpoint_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_run_sources (run_id TEXT NOT NULL, source_observation_id TEXT NOT NULL, PRIMARY KEY (run_id, source_observation_id));
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', external_side_effect TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS application_packets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_hash TEXT NOT NULL,
  readiness_status_at_create TEXT NOT NULL CHECK(readiness_status_at_create IN ('approved','form-ready')),
  readiness_version INTEGER NOT NULL CHECK(readiness_version >= 3),
  packet_version INTEGER NOT NULL DEFAULT 1 CHECK(packet_version IN (1,2)),
  form_snapshot_id TEXT,
  form_fingerprint TEXT,
  form_binding_json TEXT,
  resume_artifact_id TEXT NOT NULL,
  resume_content_hash TEXT NOT NULL,
  cover_artifact_id TEXT,
  cover_content_hash TEXT,
  answers_json TEXT NOT NULL DEFAULT '[]',
  identity_json TEXT NOT NULL DEFAULT '{}',
  materials_json TEXT NOT NULL DEFAULT '{}',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by_source TEXT NOT NULL CHECK(created_by_source IN ('cli','tui')),
  supersedes_packet_id TEXT,
  UNIQUE(job_id, profile_id, attempt_number, revision),
  CHECK((cover_artifact_id IS NULL AND cover_content_hash IS NULL) OR (cover_artifact_id IS NOT NULL AND cover_content_hash IS NOT NULL)),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id),
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(resume_artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY(cover_artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY(supersedes_packet_id) REFERENCES application_packets(id)
);
CREATE INDEX IF NOT EXISTS application_packets_target_idx
  ON application_packets(job_id, profile_id, attempt_number DESC, revision DESC);
CREATE TABLE IF NOT EXISTS application_receipts (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('user_attestation','adapter_receipt','imported_evidence')),
  submitted_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  external_reference TEXT NOT NULL DEFAULT '',
  evidence_path TEXT NOT NULL DEFAULT '',
  evidence_hash TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  receipt_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('cli','tui','mcp','acp')),
  external_side_effect TEXT NOT NULL DEFAULT 'none' CHECK(external_side_effect IN ('none','user_configured_form_submission')),
  evidence_version INTEGER NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2)),
  form_fingerprint TEXT,
  checkpoint_id TEXT,
  checkpoint_hash TEXT,
  submission_attempt_id TEXT,
  submission_actor TEXT NOT NULL DEFAULT 'human' CHECK(submission_actor IN ('human','configured_adapter')),
  adapter_json TEXT,
  confirmation_origin TEXT,
  confirmation_path TEXT,
  policy_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(packet_id, type),
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(application_id) REFERENCES applications(id)
);
CREATE INDEX IF NOT EXISTS application_receipts_application_idx
  ON application_receipts(application_id, recorded_at, id);
CREATE TABLE IF NOT EXISTS form_snapshots (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version = 1),
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  requested_origin TEXT NOT NULL,
  requested_path TEXT NOT NULL,
  final_origin TEXT NOT NULL,
  final_path TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_protocol_version INTEGER NOT NULL CHECK(adapter_protocol_version = 1),
  adapter_source_hash TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  field_map_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);
CREATE INDEX IF NOT EXISTS form_snapshots_target_idx
  ON form_snapshots(job_id, profile_id, captured_at, id);
CREATE TABLE IF NOT EXISTS form_fill_runs (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  form_fingerprint TEXT NOT NULL,
  adapter_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('checkpoint-required','diverged','failed')),
  readback_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(packet_id) REFERENCES application_packets(id)
);
CREATE TABLE IF NOT EXISTS human_checkpoints (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  fill_run_id TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL UNIQUE,
  confirmation_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  accepted_by_source TEXT NOT NULL CHECK(accepted_by_source IN ('cli','tui')),
  UNIQUE(packet_id,fill_run_id),
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(fill_run_id) REFERENCES form_fill_runs(id)
);
CREATE TABLE IF NOT EXISTS form_submission_attempts (
  id TEXT PRIMARY KEY,
  submission_key TEXT NOT NULL UNIQUE,
  packet_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  form_fingerprint TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  adapter_json TEXT NOT NULL,
  invoked_by TEXT NOT NULL CHECK(invoked_by IN ('cli','tui','mcp','acp')),
  configuration_source TEXT NOT NULL CHECK(configuration_source IN ('profile','environment')),
  status TEXT NOT NULL CHECK(status IN ('armed','confirmed','uncertain','failed-before-submit')),
  outcome_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  external_side_effect TEXT NOT NULL CHECK(external_side_effect IN ('none','user_configured_form_submission')),
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(checkpoint_id) REFERENCES human_checkpoints(id)
);`;

function tableDefinition(db, name) {
  return String(dbRows(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name])[0]?.sql || '');
}

function migrateW02Constraints(db) {
  const packetDefinition = tableDefinition(db, 'application_packets');
  const receiptDefinition = tableDefinition(db, 'application_receipts');
  const rebuildPackets = packetDefinition && !packetDefinition.includes("'form-ready'");
  const rebuildReceipts = receiptDefinition
    && (!receiptDefinition.includes("'user_configured_form_submission'") || !receiptDefinition.includes("'mcp'"));
  if (!rebuildPackets && !rebuildReceipts) return;

  db.run('PRAGMA foreign_keys=OFF');
  try {
    db.run('BEGIN');
    if (rebuildPackets) {
      db.run(`CREATE TABLE application_packets_w02 (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        content_hash TEXT NOT NULL,
        readiness_status_at_create TEXT NOT NULL CHECK(readiness_status_at_create IN ('approved','form-ready')),
        readiness_version INTEGER NOT NULL CHECK(readiness_version >= 3),
        packet_version INTEGER NOT NULL DEFAULT 1 CHECK(packet_version IN (1,2)),
        form_snapshot_id TEXT,
        form_fingerprint TEXT,
        form_binding_json TEXT,
        resume_artifact_id TEXT NOT NULL,
        resume_content_hash TEXT NOT NULL,
        cover_artifact_id TEXT,
        cover_content_hash TEXT,
        answers_json TEXT NOT NULL DEFAULT '[]',
        identity_json TEXT NOT NULL DEFAULT '{}',
        materials_json TEXT NOT NULL DEFAULT '{}',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by_source TEXT NOT NULL CHECK(created_by_source IN ('cli','tui')),
        supersedes_packet_id TEXT,
        UNIQUE(job_id, profile_id, attempt_number, revision),
        CHECK((cover_artifact_id IS NULL AND cover_content_hash IS NULL) OR (cover_artifact_id IS NOT NULL AND cover_content_hash IS NOT NULL)),
        FOREIGN KEY(job_id) REFERENCES jobs(id),
        FOREIGN KEY(profile_id) REFERENCES profiles(id),
        FOREIGN KEY(application_id) REFERENCES applications(id),
        FOREIGN KEY(resume_artifact_id) REFERENCES artifacts(id),
        FOREIGN KEY(cover_artifact_id) REFERENCES artifacts(id),
        FOREIGN KEY(supersedes_packet_id) REFERENCES application_packets_w02(id)
      )`);
      db.run(`INSERT INTO application_packets_w02 (
        id,job_id,profile_id,application_id,attempt_number,revision,content_hash,
        readiness_status_at_create,readiness_version,packet_version,form_snapshot_id,
        form_fingerprint,form_binding_json,resume_artifact_id,resume_content_hash,
        cover_artifact_id,cover_content_hash,answers_json,identity_json,materials_json,
        blockers_json,warnings_json,created_at,created_by_source,supersedes_packet_id
      ) SELECT
        id,job_id,profile_id,application_id,attempt_number,revision,content_hash,
        readiness_status_at_create,readiness_version,packet_version,form_snapshot_id,
        form_fingerprint,form_binding_json,resume_artifact_id,resume_content_hash,
        cover_artifact_id,cover_content_hash,answers_json,identity_json,materials_json,
        blockers_json,warnings_json,created_at,created_by_source,supersedes_packet_id
      FROM application_packets`);
      db.run('DROP TABLE application_packets');
      db.run('ALTER TABLE application_packets_w02 RENAME TO application_packets');
      db.run('CREATE INDEX application_packets_target_idx ON application_packets(job_id, profile_id, attempt_number DESC, revision DESC)');
      db.run('CREATE INDEX application_packets_form_idx ON application_packets(form_fingerprint,packet_version)');
    }
    if (rebuildReceipts) {
      db.run(`CREATE TABLE application_receipts_w02 (
        id TEXT PRIMARY KEY,
        packet_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('user_attestation','adapter_receipt','imported_evidence')),
        submitted_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        external_reference TEXT NOT NULL DEFAULT '',
        evidence_path TEXT NOT NULL DEFAULT '',
        evidence_hash TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        receipt_hash TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK(source IN ('cli','tui','mcp','acp')),
        external_side_effect TEXT NOT NULL DEFAULT 'none' CHECK(external_side_effect IN ('none','user_configured_form_submission')),
        evidence_version INTEGER NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2)),
        form_fingerprint TEXT,
        checkpoint_id TEXT,
        checkpoint_hash TEXT,
        submission_attempt_id TEXT,
        submission_actor TEXT NOT NULL DEFAULT 'human' CHECK(submission_actor IN ('human','configured_adapter')),
        adapter_json TEXT,
        confirmation_origin TEXT,
        confirmation_path TEXT,
        policy_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(packet_id, type),
        FOREIGN KEY(packet_id) REFERENCES application_packets(id),
        FOREIGN KEY(application_id) REFERENCES applications(id)
      )`);
      db.run(`INSERT INTO application_receipts_w02 (
        id,packet_id,application_id,type,submitted_at,recorded_at,external_reference,
        evidence_path,evidence_hash,note,receipt_hash,source,external_side_effect,
        evidence_version,form_fingerprint,checkpoint_id,checkpoint_hash,
        submission_attempt_id,submission_actor,adapter_json,confirmation_origin,
        confirmation_path,policy_json
      ) SELECT
        id,packet_id,application_id,type,submitted_at,recorded_at,external_reference,
        evidence_path,evidence_hash,note,receipt_hash,source,external_side_effect,
        evidence_version,form_fingerprint,checkpoint_id,checkpoint_hash,
        submission_attempt_id,COALESCE(submission_actor,'human'),adapter_json,
        confirmation_origin,confirmation_path,policy_json
      FROM application_receipts`);
      db.run('DROP TABLE application_receipts');
      db.run('ALTER TABLE application_receipts_w02 RENAME TO application_receipts');
      db.run('CREATE INDEX application_receipts_application_idx ON application_receipts(application_id, recorded_at, id)');
    }
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.run('PRAGMA foreign_keys=ON');
  }
  const violations = dbRows(db, 'PRAGMA foreign_key_check');
  if (violations.length) throw new Error('W02 packet/receipt migration left foreign-key violations');
}

function migrate(db){
  for (const sql of [
    "ALTER TABLE proof_points ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE proof_points ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE companies ADD COLUMN facts_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE companies ADD COLUMN domain TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE companies ADD COLUMN source_confidence TEXT NOT NULL DEFAULT 'low'",
    "ALTER TABLE companies ADD COLUMN identity_sources_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jobs ADD COLUMN high_fit INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN posted_date TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN source_history_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jobs ADD COLUMN first_seen_at TEXT",
    "ALTER TABLE jobs ADD COLUMN last_seen_at TEXT",
    "ALTER TABLE jobs ADD COLUMN reposted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN discovery_run_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN compensation_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE jobs ADD COLUMN employment_types_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jobs ADD COLUMN department TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN source_native_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE jobs ADD COLUMN liveness_status TEXT NOT NULL DEFAULT 'uncertain'",
    "ALTER TABLE jobs ADD COLUMN liveness_checked_at TEXT",
    "ALTER TABLE jobs ADD COLUMN liveness_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE automation_runs ADD COLUMN automation_id TEXT",
    "ALTER TABLE automation_runs ADD COLUMN action_id TEXT",
    "ALTER TABLE automation_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE automation_runs ADD COLUMN started_at TEXT",
    "ALTER TABLE automation_runs ADD COLUMN finished_at TEXT",
    "ALTER TABLE automation_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE automation_runs ADD COLUMN error TEXT",
    "ALTER TABLE automation_runs ADD COLUMN counts_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE artifacts ADD COLUMN series_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE artifacts ADD COLUMN supersedes_artifact_id TEXT",
    "ALTER TABLE artifacts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE artifacts ADD COLUMN reviewed_at TEXT",
    "ALTER TABLE artifacts ADD COLUMN reviewed_by TEXT",
    "ALTER TABLE artifacts ADD COLUMN review_note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE proof_points ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired','needs_verification'))",
    "ALTER TABLE proof_points ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'verified' CHECK(verification_status IN ('verified','unverified','rejected'))",
    "ALTER TABLE proof_points ADD COLUMN source_resume_entry_id TEXT",
    "ALTER TABLE proof_points ADD COLUMN supersedes_proof_point_id TEXT",
    "ALTER TABLE proof_points ADD COLUMN updated_at TEXT",
    "ALTER TABLE proof_points ADD COLUMN retired_at TEXT",
    "ALTER TABLE proof_points ADD COLUMN retirement_reason TEXT NOT NULL DEFAULT ''",
    "UPDATE proof_points SET updated_at=COALESCE(updated_at,created_at)",
    "CREATE TABLE IF NOT EXISTS profile_resume_revisions (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), schema_version INTEGER NOT NULL, source_text TEXT NOT NULL DEFAULT '', source_text_hash TEXT NOT NULL, document_json TEXT NOT NULL, verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','needs_verification','rejected')), supersedes_resume_id TEXT, is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)), created_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE(profile_id,revision), FOREIGN KEY(profile_id) REFERENCES profiles(id), FOREIGN KEY(supersedes_resume_id) REFERENCES profile_resume_revisions(id))",
    "CREATE UNIQUE INDEX IF NOT EXISTS profile_resume_current_idx ON profile_resume_revisions(profile_id) WHERE is_current=1",
    "CREATE TABLE IF NOT EXISTS artifact_resume_documents (artifact_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source_resume_revision_id TEXT NOT NULL, document_json TEXT NOT NULL, coverage_json TEXT NOT NULL DEFAULT '{}', validation_json TEXT NOT NULL DEFAULT '{}', layout_profile_json TEXT NOT NULL DEFAULT '{}', render_manifest_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(artifact_id) REFERENCES artifacts(id), FOREIGN KEY(source_resume_revision_id) REFERENCES profile_resume_revisions(id))",
    "CREATE TABLE IF NOT EXISTS outreach_threads (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, goal TEXT NOT NULL DEFAULT 'informational', channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'drafted', sent_at TEXT, next_followup_at TEXT, followup_task_id TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS source_observations (id TEXT PRIMARY KEY, company_id TEXT, job_id TEXT, url TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT, snippet TEXT, source_type TEXT NOT NULL, provider TEXT NOT NULL, query TEXT, trust TEXT NOT NULL, fetched_at TEXT NOT NULL, content_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}')",
    "CREATE TABLE IF NOT EXISTS person_candidates (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT, function TEXT, seniority TEXT, relevance TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'candidate', suppression_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS contact_points (id TEXT PRIMARY KEY, person_id TEXT, stakeholder_id TEXT, company_id TEXT, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, evidence_tier TEXT NOT NULL, verification_status TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '{}', human_approved INTEGER NOT NULL DEFAULT 0, do_not_use INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS email_patterns (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, domain TEXT NOT NULL, pattern TEXT NOT NULL, support_count INTEGER NOT NULL, support_sources_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS relationship_edges (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS outreach_plans (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, contact_point_id TEXT, goal TEXT NOT NULL, channel TEXT NOT NULL, path_strength TEXT NOT NULL, recommended INTEGER NOT NULL DEFAULT 0, reasoning_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL, question_fingerprint TEXT NOT NULL, question_text TEXT NOT NULL, answer_text TEXT NOT NULL, sensitivity TEXT NOT NULL, reuse_scope TEXT NOT NULL, verification_status TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', employer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,question_fingerprint,employer), FOREIGN KEY(profile_id) REFERENCES profiles(id))",
    "CREATE TABLE IF NOT EXISTS application_packets (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, application_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK(attempt_number > 0), revision INTEGER NOT NULL CHECK(revision > 0), content_hash TEXT NOT NULL, readiness_status_at_create TEXT NOT NULL CHECK(readiness_status_at_create = 'approved'), readiness_version INTEGER NOT NULL CHECK(readiness_version >= 3), resume_artifact_id TEXT NOT NULL, resume_content_hash TEXT NOT NULL, cover_artifact_id TEXT, cover_content_hash TEXT, answers_json TEXT NOT NULL DEFAULT '[]', identity_json TEXT NOT NULL DEFAULT '{}', materials_json TEXT NOT NULL DEFAULT '{}', blockers_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, created_by_source TEXT NOT NULL CHECK(created_by_source IN ('cli','tui')), supersedes_packet_id TEXT, UNIQUE(job_id, profile_id, attempt_number, revision), CHECK((cover_artifact_id IS NULL AND cover_content_hash IS NULL) OR (cover_artifact_id IS NOT NULL AND cover_content_hash IS NOT NULL)), FOREIGN KEY(job_id) REFERENCES jobs(id), FOREIGN KEY(profile_id) REFERENCES profiles(id), FOREIGN KEY(application_id) REFERENCES applications(id), FOREIGN KEY(resume_artifact_id) REFERENCES artifacts(id), FOREIGN KEY(cover_artifact_id) REFERENCES artifacts(id), FOREIGN KEY(supersedes_packet_id) REFERENCES application_packets(id))",
    "CREATE INDEX IF NOT EXISTS application_packets_target_idx ON application_packets(job_id, profile_id, attempt_number DESC, revision DESC)",
    "CREATE TABLE IF NOT EXISTS application_receipts (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL, application_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('user_attestation','adapter_receipt','imported_evidence')), submitted_at TEXT NOT NULL, recorded_at TEXT NOT NULL, external_reference TEXT NOT NULL DEFAULT '', evidence_path TEXT NOT NULL DEFAULT '', evidence_hash TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', receipt_hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK(source IN ('cli','tui')), external_side_effect TEXT NOT NULL DEFAULT 'none' CHECK(external_side_effect = 'none'), UNIQUE(packet_id, type), FOREIGN KEY(packet_id) REFERENCES application_packets(id), FOREIGN KEY(application_id) REFERENCES applications(id))",
    "CREATE INDEX IF NOT EXISTS application_receipts_application_idx ON application_receipts(application_id, recorded_at, id)",
    "ALTER TABLE application_packets ADD COLUMN packet_version INTEGER NOT NULL DEFAULT 1 CHECK(packet_version IN (1,2))",
    "ALTER TABLE application_packets ADD COLUMN form_snapshot_id TEXT",
    "ALTER TABLE application_packets ADD COLUMN form_fingerprint TEXT",
    "ALTER TABLE application_packets ADD COLUMN form_binding_json TEXT",
    "CREATE INDEX IF NOT EXISTS application_packets_form_idx ON application_packets(form_fingerprint,packet_version)",
    "ALTER TABLE application_receipts ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2))",
    "ALTER TABLE application_receipts ADD COLUMN form_fingerprint TEXT",
    "ALTER TABLE application_receipts ADD COLUMN checkpoint_id TEXT",
    "ALTER TABLE application_receipts ADD COLUMN checkpoint_hash TEXT",
    "ALTER TABLE application_receipts ADD COLUMN submission_attempt_id TEXT",
    "ALTER TABLE application_receipts ADD COLUMN submission_actor TEXT NOT NULL DEFAULT 'human'",
    "ALTER TABLE application_receipts ADD COLUMN adapter_json TEXT",
    "ALTER TABLE application_receipts ADD COLUMN confirmation_origin TEXT",
    "ALTER TABLE application_receipts ADD COLUMN confirmation_path TEXT",
    "ALTER TABLE application_receipts ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'",
    "CREATE TABLE IF NOT EXISTS form_snapshots (id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version = 1), job_id TEXT NOT NULL, profile_id TEXT NOT NULL, captured_at TEXT NOT NULL, requested_origin TEXT NOT NULL, requested_path TEXT NOT NULL, final_origin TEXT NOT NULL, final_path TEXT NOT NULL, adapter_id TEXT NOT NULL, adapter_protocol_version INTEGER NOT NULL CHECK(adapter_protocol_version = 1), adapter_source_hash TEXT NOT NULL, selection_json TEXT NOT NULL, field_map_json TEXT NOT NULL, fingerprint TEXT NOT NULL, warnings_json TEXT NOT NULL DEFAULT '[]', FOREIGN KEY(job_id) REFERENCES jobs(id), FOREIGN KEY(profile_id) REFERENCES profiles(id))",
    "CREATE INDEX IF NOT EXISTS form_snapshots_target_idx ON form_snapshots(job_id, profile_id, captured_at, id)",
    "CREATE TABLE IF NOT EXISTS form_fill_runs (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL, form_fingerprint TEXT NOT NULL, adapter_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('checkpoint-required','diverged','failed')), readback_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(packet_id) REFERENCES application_packets(id))",
    "CREATE TABLE IF NOT EXISTS human_checkpoints (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL, fill_run_id TEXT NOT NULL, checkpoint_hash TEXT NOT NULL UNIQUE, confirmation_json TEXT NOT NULL, accepted_at TEXT NOT NULL, accepted_by_source TEXT NOT NULL CHECK(accepted_by_source IN ('cli','tui')), UNIQUE(packet_id,fill_run_id), FOREIGN KEY(packet_id) REFERENCES application_packets(id), FOREIGN KEY(fill_run_id) REFERENCES form_fill_runs(id))",
    "CREATE TABLE IF NOT EXISTS form_submission_attempts (id TEXT PRIMARY KEY, submission_key TEXT NOT NULL UNIQUE, packet_id TEXT NOT NULL, packet_hash TEXT NOT NULL, form_fingerprint TEXT NOT NULL, checkpoint_id TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, adapter_json TEXT NOT NULL, invoked_by TEXT NOT NULL CHECK(invoked_by IN ('cli','tui','mcp','acp')), configuration_source TEXT NOT NULL CHECK(configuration_source IN ('profile','environment')), status TEXT NOT NULL CHECK(status IN ('armed','confirmed','uncertain','failed-before-submit')), outcome_json TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL, completed_at TEXT, external_side_effect TEXT NOT NULL CHECK(external_side_effect IN ('none','user_configured_form_submission')), FOREIGN KEY(packet_id) REFERENCES application_packets(id), FOREIGN KEY(checkpoint_id) REFERENCES human_checkpoints(id))",
    "ALTER TABLE person_candidates ADD COLUMN person_id TEXT",
    "ALTER TABLE person_candidates ADD COLUMN research_run_id TEXT",
    "ALTER TABLE stakeholders ADD COLUMN person_id TEXT",
    "ALTER TABLE contact_points ADD COLUMN origin_research_run_id TEXT NOT NULL DEFAULT ''",
    "CREATE INDEX IF NOT EXISTS idx_people_normalized_name ON people(normalized_name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_people_primary_profile_url ON people(primary_profile_url) WHERE primary_profile_url != ''",
    "CREATE INDEX IF NOT EXISTS idx_profile_affiliations_owner ON profile_affiliations(profile_id, type, normalized_organization)",
    "CREATE INDEX IF NOT EXISTS idx_person_affiliations_owner ON person_affiliations(person_id, type, normalized_organization)",
    "CREATE INDEX IF NOT EXISTS idx_research_runs_profile ON research_runs(profile_id, status, scope)",
    "CREATE INDEX IF NOT EXISTS idx_research_runs_job ON research_runs(job_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_person_candidates_run ON person_candidates(research_run_id)",
    "CREATE INDEX IF NOT EXISTS idx_stakeholders_person ON stakeholders(person_id)",
    "CREATE INDEX IF NOT EXISTS idx_research_run_sources_run ON research_run_sources(run_id)",
    "CREATE INDEX IF NOT EXISTS idx_research_run_sources_source ON research_run_sources(source_observation_id)"
  ]) {
    try { db.run(sql); } catch (e) {
      const message = String(e?.message || e);
      if (!/duplicate column name/i.test(message) && !/already exists/i.test(message)) throw e;
    }
  }
  migrateW02Constraints(db);
  const backfillKey = 'migration_resume_import_backfill';
  const check = db.prepare('SELECT value FROM meta WHERE key=?', [backfillKey]);
  let alreadyBackfilled = false;
  try { while (check.step()) alreadyBackfilled = true; } finally { check.free(); }
  if (!alreadyBackfilled) {
    db.run("UPDATE proof_points SET verification_status='unverified' WHERE source='resume_import' AND verification_status='verified'");
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [backfillKey, 'done']);
  }
}
function dbRows(db, sql, params = []) {
  const statement = db.prepare(sql, params);
  const rows = [];
  try {
    while (statement.step()) rows.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  return rows;
}

function artifactContentHash(content) {
  const value = String(content);
  return crypto.createHash('sha256').update(value.endsWith('\n') ? value : `${value}\n`).digest('hex');
}

function legacyArtifactSeries(row) {
  const jobId = row.job_id || 'none';
  const profileId = row.profile_id || 'none';
  if (row.type === 'resume' || row.type === 'cover_letter') return `${row.type}:${jobId}:${profileId}`;
  if (row.type === 'outreach' && row.stakeholder_id) {
    return `outreach:${jobId}:${profileId}:${row.stakeholder_id}:${encodeURIComponent(row.goal || 'informational')}`;
  }
  if (row.type === 'interview_prep' && row.application_id) {
    const stage = String(row.path || '').match(/interview-prep-([^/]+)\.md$/)?.[1] || 'interview';
    return `interview_prep:${row.application_id}:${stage}`;
  }
  if (row.type === 'followup') {
    let evidence = [];
    try { evidence = JSON.parse(row.evidence_json || '[]'); } catch {}
    if (!Array.isArray(evidence)) evidence = [];
    const taskId = evidence.find(item => item && typeof item === 'object' && item.taskId)?.taskId;
    if (taskId) return `followup:${taskId}`;
  }
  return `legacy:${row.id}`;
}

function migrateArtifacts(db) {
  const rows = dbRows(db, `SELECT artifacts.*,outreach_threads.stakeholder_id,outreach_threads.goal,
      applications.id AS application_id
    FROM artifacts
    LEFT JOIN outreach_threads ON outreach_threads.artifact_id=artifacts.id
    LEFT JOIN applications ON applications.job_id=artifacts.job_id AND applications.profile_id=artifacts.profile_id
    ORDER BY artifacts.created_at,artifacts.id`);
  // outreach_threads.artifact_id is not UNIQUE, so a single artifact can appear multiple times.
  const seen = new Set();
  const uniqueRows = rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const needsBackfill = uniqueRows.some(row => !row.series_key || Number(row.revision) < 1 || !row.content_hash);
  if (!needsBackfill) {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_series_revision ON artifacts(series_key,revision)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_supersedes ON artifacts(supersedes_artifact_id) WHERE supersedes_artifact_id IS NOT NULL');
    db.run('CREATE INDEX IF NOT EXISTS idx_artifacts_current ON artifacts(series_key,revision DESC)');
    return;
  }
  const bySeries = new Map();
  for (const row of uniqueRows) {
    const seriesKey = row.series_key || legacyArtifactSeries(row);
    if (!bySeries.has(seriesKey)) bySeries.set(seriesKey, []);
    bySeries.get(seriesKey).push({ ...row, seriesKey });
  }
  for (const items of bySeries.values()) {
    let predecessor = null;
    let revision = 0;
    for (const item of items) {
      revision += 1;
      const reviewed = ['approved', 'rejected'].includes(item.approval_status);
      db.run(`UPDATE artifacts SET series_key=?,revision=?,supersedes_artifact_id=?,content_hash=?,
        reviewed_at=COALESCE(reviewed_at,?),reviewed_by=COALESCE(reviewed_by,?),review_note=COALESCE(review_note,'')
        WHERE id=?`, [
        item.seriesKey,
        revision,
        predecessor,
        item.content_hash || artifactContentHash(item.content),
        reviewed ? item.created_at : null,
        reviewed ? 'legacy' : null,
        item.id
      ]);
      predecessor = item.id;
    }
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_series_revision ON artifacts(series_key,revision)');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_supersedes ON artifacts(supersedes_artifact_id) WHERE supersedes_artifact_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_artifacts_current ON artifacts(series_key,revision DESC)');
}

function revisionOf(db) {
  try {
    const rows = db.exec("SELECT value FROM meta WHERE key='store_revision'");
    return Number(rows[0]?.values?.[0]?.[0] || 0);
  } catch {
    return 0;
  }
}

function diskRevision(file) {
  if (!fs.existsSync(file)) return 0;
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    return revisionOf(db);
  } finally {
    db.close();
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function concurrencyError(code, message) {
  return Object.assign(new Error(message), { code, type: 'concurrency', retryable: true });
}

export function acquireWriteLock(s, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(s.p.state, { recursive: true });
  const file = path.join(s.p.state, 'jobos.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return () => {
        try {
          const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Number(lock.pid) === process.pid) fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(file);
        const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number(lock.pid) === process.pid) return () => {};
        stale = Date.now() - stat.mtimeMs > staleMs && !processAlive(Number(lock.pid));
      } catch {
        try { stale = Date.now() - fs.statSync(file).mtimeMs > staleMs; } catch {}
      }
      if (stale) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw concurrencyError('lock_timeout', `Workspace is busy; retry after the writer holding ${file} finishes`);
      Atomics.wait(lockSleep, 0, 0, 25);
    }
  }
}

function migratePolicyPreferences(db) {
  const rows = [];
  const statement = db.prepare('SELECT id,preferences_json FROM profiles');
  try {
    while (statement.step()) rows.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  for (const row of rows) {
    let prefs;
    try { prefs = JSON.parse(row.preferences_json || '{}'); } catch { continue; }
    const policy = prefs.automationPolicy || {};
    let changed = false;
    for (const key of ['externalApply', 'externalSend']) {
      if (policy[key] === 'human_approval_required') {
        policy[key] = 'user_configured';
        changed = true;
      }
    }
    if (changed) {
      prefs.automationPolicy = policy;
      db.run('UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [JSON.stringify(prefs), now(), row.id]);
    }
  }
}

function migratePeopleBackfill(db) {
  // Idempotent — skip if already done
  const existing = db.exec("SELECT value FROM meta WHERE key='people_backfill_version'");
  if (existing.length > 0 && existing[0].values?.[0]?.[0]) return;

  const ts = now();

  // Collect all candidates without person_id
  const candidates = [];
  {
    const st = db.prepare("SELECT * FROM person_candidates WHERE person_id IS NULL AND name != ''");
    while (st.step()) candidates.push(st.getAsObject());
    st.free();
  }

  if (candidates.length === 0) {
    db.run("INSERT OR REPLACE INTO meta VALUES (?,?)", ['people_backfill_version', '1']);
    return;
  }


  // Group candidates by job_id
  const byJob = {};
  for (const c of candidates) {
    const jid = c.job_id || '';
    if (!byJob[jid]) byJob[jid] = [];
    byJob[jid].push(c);
  }

  for (const [jobId, jobCandidates] of Object.entries(byJob)) {
    let profileId = null;
    let companyName = '';
    let role = '';
    if (jobId) {
      const jobStatement = db.prepare('SELECT profile_id,company,title FROM jobs WHERE id=?', [jobId]);
      try {
        if (jobStatement.step()) {
          const job = jobStatement.getAsObject();
          profileId = job.profile_id || null;
          companyName = job.company || '';
          role = job.title || '';
        }
      } finally {
        jobStatement.free();
      }
    }
    // Create synthetic migration research run
    const runId = id('research', `migration:${jobId}:people-backfill`);
    db.run(`INSERT OR IGNORE INTO research_runs (id,profile_id,scope,job_id,company_name,role,person_id,depth,sources_json,budget_json,usage_json,status,checkpoint_json,warnings_json,error,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      runId, profileId, jobId ? 'job' : 'person', jobId || null, companyName, role, null, 'standard',
      '[]', '{}', '{}', 'succeeded', '{}', '[]', '',
      ts, ts, ts, ts
    ]);

    for (const c of jobCandidates) {
      // Create canonical person seeded from candidate ID
      const pid = id('person', c.id);
      const normalizedName = String(c.name || '').trim().toLowerCase();

      db.run(`INSERT OR IGNORE INTO people (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [
        pid, c.name, normalizedName, '', '[]', 'low', ts, ts
      ]);

      // Link candidate to person and research run
      db.run(`UPDATE person_candidates SET person_id=?, updated_at=? WHERE id=?`, [pid, ts, c.id]);
      db.run(`UPDATE person_candidates SET research_run_id=? WHERE id=? AND (research_run_id IS NULL OR research_run_id='')`, [runId, c.id]);
    }
  }

  // Link unambiguous stakeholders — same name+job as a single candidate that has person_id
  {
    const st = db.prepare("SELECT s.* FROM stakeholders s WHERE (s.person_id IS NULL OR s.person_id = '') AND s.job_id IS NOT NULL");
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free();

    for (const sh of rows) {
      const cands = [];
      const cst = db.prepare("SELECT * FROM person_candidates WHERE job_id=? AND name=? AND person_id IS NOT NULL AND person_id != ''", [sh.job_id, sh.name]);
      while (cst.step()) cands.push(cst.getAsObject());
      cst.free();

      if (cands.length === 1) {
        db.run(`UPDATE stakeholders SET person_id=?, updated_at=? WHERE id=?`, [cands[0].person_id, ts, sh.id]);
      }
      // 0 or >1 matches — leave unlinked (ambiguous)
    }
  }

  // Rewrite contact_points.person_id from candidate IDs to canonical person IDs
  // Keep contact IDs immutable so outreach-plan references survive
  db.run(`UPDATE contact_points SET person_id = (
    SELECT pc.person_id FROM person_candidates pc WHERE pc.id = contact_points.person_id
  ) WHERE person_id IN (SELECT id FROM person_candidates WHERE person_id IS NOT NULL AND person_id != '')`);

  // Rewrite relationship_edges — candidate endpoints to person endpoints
  db.run(`UPDATE relationship_edges SET from_type='person', from_id = (
    SELECT pc.person_id FROM person_candidates pc WHERE pc.id = relationship_edges.from_id
  ) WHERE from_type='candidate' AND from_id IN (SELECT id FROM person_candidates WHERE person_id IS NOT NULL AND person_id != '')`);

  db.run(`UPDATE relationship_edges SET to_type='person', to_id = (
    SELECT pc.person_id FROM person_candidates pc WHERE pc.id = relationship_edges.to_id
  ) WHERE to_type='candidate' AND to_id IN (SELECT id FROM person_candidates WHERE person_id IS NOT NULL AND person_id != '')`);

  // Rewrite relationship_edges — stakeholder endpoints to person endpoints
  db.run(`UPDATE relationship_edges SET from_type='person', from_id = (
    SELECT s.person_id FROM stakeholders s WHERE s.id = relationship_edges.from_id
  ) WHERE from_type='stakeholder' AND from_id IN (SELECT id FROM stakeholders WHERE person_id IS NOT NULL AND person_id != '')`);

  db.run(`UPDATE relationship_edges SET to_type='person', to_id = (
    SELECT s.person_id FROM stakeholders s WHERE s.id = relationship_edges.to_id
  ) WHERE to_type='stakeholder' AND to_id IN (SELECT id FROM stakeholders WHERE person_id IS NOT NULL AND person_id != '')`);

  // Mark backfill complete
  db.run("INSERT OR REPLACE INTO meta VALUES (?,?)", ['people_backfill_version', '1']);
}

function loadAuthoritativeStore(s) {
  if (!fs.existsSync(s.p.db)) return s;
  try { s.db.close(); } catch {}
  s.db = new SQL.Database(fs.readFileSync(s.p.db));
  s.db.run(schema);
  migrate(s.db);
  migrateArtifacts(s.db);
  migratePolicyPreferences(s.db);
  seedDefaultAutomations(s);
  s.baseRevision = revisionOf(s.db);
  return s;
}

function persistLocked(s) {
  let temp = null;
  try {
    const current = diskRevision(s.p.db);
    if (current !== Number(s.baseRevision || 0)) {
      throw concurrencyError('stale_snapshot', `Workspace changed from revision ${s.baseRevision || 0} to ${current}; reopen it and retry the command`);
    }
    const next = current + 1;
    s.db.run('INSERT OR REPLACE INTO meta VALUES (?,?)', ['store_revision', String(next)]);
    const bytes = Buffer.from(s.db.export());
    temp = `${s.p.db}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, s.p.db);
    temp = null;
    try {
      const directory = fs.openSync(path.dirname(s.p.db), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {}
    s.baseRevision = next;
  } finally {
    if (temp) try { fs.unlinkSync(temp); } catch {}
  }
}

function flushPostCommit(s) {
  const projections = s.postCommitProjections || [];
  s.postCommitProjections = [];
  const errors = [];
  for (const project of projections) {
    try { project(); } catch (e) { errors.push(e); }
  }
  if (errors.length) throw errors[0];
}

export async function openStore(flags={}) {
  const r=workspaceRoot(flags), p=paths(r); mkdirs(p);
  if(!SQL) SQL=await initSqlJs({ locateFile: f => path.join(path.dirname(require.resolve('sql.js')), f) });
  const existed = fs.existsSync(p.db);
  const db=existed ? new SQL.Database(fs.readFileSync(p.db)) : new SQL.Database();
  const baseRevision = revisionOf(db);
  let previousSchemaVersion = '0';
  try { previousSchemaVersion = String(db.exec("SELECT value FROM meta WHERE key='schema_version'")[0]?.values?.[0]?.[0] || '0'); } catch {}
  db.run(schema);
  migrate(db);
  migrateArtifacts(db);
  migratePolicyPreferences(db);
  migratePeopleBackfill(db);
  db.run('INSERT OR REPLACE INTO meta VALUES (?,?)',['schema_version','10']);
  const store={db,p,root:r,baseRevision,postCommitProjections:[]};
  seedDefaultAutomations(store);
  if (!existed || previousSchemaVersion !== '10') save(store);
  return store;
}

export function reload(s) {
  return loadAuthoritativeStore(s);
}

export function queuePostCommit(s, projection) {
  if (typeof projection !== 'function') throw new TypeError('Post-commit projection must be a function');
  if (!s.postCommitProjections) s.postCommitProjections = [];
  s.postCommitProjections.push(projection);
}

export function save(s) {
  if (s._inGuardedWrite) return;
  const release = acquireWriteLock(s);
  try {
    persistLocked(s);
  } catch (error) {
    s.postCommitProjections = [];
    throw error;
  } finally {
    release();
  }
  flushPostCommit(s);
}

export function guardedWrite(s, mutate) {
  const release = acquireWriteLock(s);
  let result;
  try {
    loadAuthoritativeStore(s);
    s.db.run('BEGIN IMMEDIATE');
    s._inGuardedWrite = true;
    try {
      result = mutate();
      if (result && typeof result.then === 'function') throw new TypeError('guardedWrite mutation must be synchronous');
      s.db.run('COMMIT');
    } catch (error) {
      try { s.db.run('ROLLBACK'); } catch {}
      s.postCommitProjections = [];
      throw error;
    } finally {
      s._inGuardedWrite = false;
    }
    try {
      persistLocked(s);
    } catch (error) {
      s.postCommitProjections = [];
      loadAuthoritativeStore(s);
      throw error;
    }
  } finally {
    release();
  }
  flushPostCommit(s);
  return result;
}

export function all(s, sql, params=[]){ const st=s.db.prepare(sql,params), rows=[]; try { while(st.step()) rows.push(st.getAsObject()); } finally { st.free(); } return rows; }
export function one(s, sql, params=[]){ return all(s,sql,params)[0] || null; }
export function run(s, sql, params=[]){ s.db.run(sql,params); }

export function recordAudit(s, action, type, eid, payload={}, side='none') {
  const at=now(), aid=id('audit',`${action}:${type}:${eid}:${at}:${JSON.stringify(payload)}`);
  run(s,'INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)',[aid,action,type,eid,JSON.stringify(payload),side,at]);
  return {id:aid,action,entityType:type,entityId:eid,payload,externalSideEffect:side,createdAt:at};
}

export function projectAudit(s, event) {
  fs.appendFileSync(path.join(s.p.ws,'audit.log.jsonl'),JSON.stringify(event)+'\n');
  const jid=event.payload.jobId || (event.entityType==='job'?event.entityId:null);
  if(jid){
    const directory=path.join(s.p.jobs,jid);
    fs.mkdirSync(directory,{recursive:true});
    fs.appendFileSync(path.join(directory,'audit.log.jsonl'),JSON.stringify(event)+'\n');
  }
}

export function audit(s, action, type, eid, payload={}, side='none'){
  const event = recordAudit(s, action, type, eid, payload, side);
  projectAudit(s, event);
  return event;
}
