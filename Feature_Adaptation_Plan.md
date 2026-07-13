# Feature Adaptation Plan

**Version:** v2.0 — 2026-07-13  
**Inputs:** `Competitive_Feature_Analysis.md` v2.0; `Gap_Analysis_and_Benchmark.md` v2.0; merged PR #2 (`c5ef87b`); current `AGENTS.md`.
**Purpose:** Implementation specification for local-first, user-configured application automation.

## Product decision and scope

Build JobOS into the best **local-first, proof-grounded job application OS** with user-configured application parity, including auto-apply, auto-send, and board adapters. The target loop is:

> understand intent → discover → explain fit → prepare exact application packet → review exceptions → user-controlled handoff or configured auto-apply → record receipt → reconcile outcomes → learn

Auto-apply, auto-send, and board adapters are user-configured features. LinkedIn and Indeed adapters use session cookies provided by the user and display clear Terms-of-Service risk warnings before they are enabled; the user bears responsibility for third-party platform terms. Greenhouse and Lever auto-apply use their public ATS APIs. SMTP delivers configured outreach. Using the latest draft when no approved artifact exists is an opt-in policy setting.

Merged PR #2 is incorporated as follows:

- User configuration is a typed, executable policy that defaults external actions to off and permits specific configured connectors.
- Proof grounding, source provenance and URL validation, artifact approval status, audit logs, local-first storage, origin/CSRF protection, duplicate prevention, and scheduler protections remain mandatory.
- CAPTCHA bypass and employer-account creation are not supported. Sensitive answers always require direct user input.
- External effects are executed only through user-configured adapters, with idempotency keys and recorded receipts or confirmations.
## Design thesis

The application should behave like a combination of four trustworthy systems:

1. **A compiler:** a job application “compiles” only when required fields are typed, evidence-linked, current, and non-contradictory. Unknowns are explicit errors, not plausible text.
2. **A password manager:** recurring answers live in a local vault with origin, sensitivity, allowed scope, verification date, and deliberate fill behavior.
3. **Git:** approval binds to immutable content versions and hashes; edits after approval create a new review state.
4. **A bank ledger:** “applied” is a recorded external transaction with a receipt or explicit user attestation, not a casual board movement.

These analogies close the biggest competitor gaps while making JobOS safer and more explainable than volume-first agents.

## Non-negotiable trust contract

1. Never invent, embellish, or silently rewrite a factual candidate claim.
2. Never infer answers to work authorization, sponsorship, legal attestations, criminal history, disability, veteran status, demographic/EEO fields, security clearance, compensation commitment, conflicts, or signature/consent fields.
3. Submit or send only through a user-configured adapter; every adapter action must record an idempotency key and receipt or confirmation.
4. The user bears responsibility for platform-terms compliance. JobOS displays and records Terms-of-Service risk warnings for authenticated LinkedIn/Indeed adapters but does not block a configured adapter.
5. Never reuse an answer solely because two prompts look similar. Reuse requires compatible category, employer scope, context, and freshness.
6. Never send sensitive fields to a cloud model without an explicit data-class policy and per-operation disclosure.
7. Every user-visible AI assertion must be distinguishable as stored fact, source-backed fact, inference, suggestion, or unknown.
8. Every lifecycle transition must be auditable and recoverable under the workspace mutation lock.
9. Every new core operation should have CLI JSON, REST, MCP, workspace mirror, dashboard visibility, tests, and docs—or an explicit exception.

## Target architecture

```text
Profile + proofs + preferences + answers
                    |
Job + source + requirements + match feedback
                    |
             Application compiler
        (field map, evidence, risks, blockers)
                    |
        Immutable application packet/version
                    |
            Exception-based review queue
                    |
  user-controlled handoff OR configured auto-apply
                    |
configured SMTP auto-send for outreach, when applicable
                    |
       Adapter receipt/confirmation + user fallback
                    |
      Status timeline + optional mail import
                    |
         Local analytics + learned proposals
```

The SQLite file remains canonical. The `sql.js` snapshot model is not cross-process safe, so every mutation takes one workspace-wide lock, reloads after acquisition, commits, and atomically persists through a same-directory temporary file and rename. The local server warns when bound beyond loopback because it has no authentication; it does not refuse a configured binding. Browser and SMTP adapters never become canonical stores.

## Core state machines

### Application packet

```text
draft
  -> needs_input        one or more blocking fields
  -> ready_for_review   complete and eligible for handoff or configured submission
  -> approved           immutable version/hash approved when policy requires it
  -> handed_off         opened/copied/filled for user-controlled completion
  -> submitted          adapter receipt or user attestation recorded
  -> confirmed          stronger external evidence stored
  -> failed|unknown     adapter/user/receipt indicates failure or ambiguity
  -> withdrawn          application stopped
```

Rules:

- Editing packet content creates a new active child version; the prior version retains its historical status/hash and is marked inactive with `superseded_by_packet_id`.
- A configured adapter may submit a blocker-free current packet from `ready_for_review` or `approved`. Approval is required only when the effective policy requires it; the opt-in latest-draft setting controls whether a current draft artifact may be used when no approved artifact exists.
- `handed_off` is not `submitted`; `submitted` is not necessarily `confirmed`. A user attestation is the fallback when auto-apply is off. An auto-apply adapter records its receipt in the same locked transaction as the `submitted` transition.
- A unique key on profile + normalized employer + target requisition/source identity prevents accidental duplicates. Exactly one `application_identity` may be active for a canonical target; a reapplication closes it and inserts the next numbered inactive-history-preserving identity with a reasoned override.
- Every status and version transition is written to the existing `audit_log`; the packet tables do not duplicate an event ledger.

| From | Allowed next state | Trigger |
|---|---|---|
| `draft` | `needs_input`, `ready_for_review`, `withdrawn` | compile/validate or withdrawal |
| `needs_input` | `draft`, `ready_for_review`, `withdrawn` | edit/recompile or withdrawal |
| `ready_for_review` | `approved`, `handed_off`, `submitted`, `failed`, `withdrawn` | approve; configured adapter receipt; handoff; adapter failure; withdrawal |
| `approved` | `handed_off`, `submitted`, `draft`, `withdrawn` | configured adapter receipt; handoff; return to draft; withdrawal |
| `handed_off` | `submitted`, `failed`, `unknown`, `withdrawn` | user attestation; user/evidence report |
| `submitted` | `confirmed`, `failed`, `unknown`, `withdrawn` | adapter or stronger external evidence; later correction |
| `confirmed` | `unknown`, `withdrawn` | disputed evidence or withdrawal record |
| `failed`, `unknown` | `withdrawn` | stop; retry creates a new active identity and packet version |

Version creation is not a transition of the old row: one locked transaction sets `is_current_version=0`, links it to the child, inserts an audit-log record, and inserts the new current version. No handoff or configured adapter command accepts a non-current packet or an inactive identity. Adapter replay returns the receipt identified by its idempotency key; it never creates a second submission.
### Field decision

```text
unmapped -> proposed -> verified
                  \-> needs_user_input
                  \-> blocked_sensitive
                  \-> stale
                  \-> conflict
```

### Connector capability

```text
unreviewed -> fixture_only -> permitted_read -> permitted_handoff -> permitted_submit
                                        \-> disabled_terms_changed
permitted_read -> terms_warning -> permitted_handoff -> permitted_submit
```

`permitted_submit` is available only after the user has explicitly configured and enabled auto-apply for that connector. LinkedIn and Indeed session-cookie adapters must pass through `terms_warning`; JobOS displays the risk, records the user's acknowledgement, and leaves responsibility for platform terms with the user. CAPTCHA encounters fail gracefully without bypass.
## Data model (schema v6 proposal)

Use additive migrations in `src/db.js`; use the existing `meta` table for database revision and write audit records to the existing `audit_log`. The application workflow has six primary tables—`answer_bank`, `application_identities`, `application_packets`, `application_packet_items`, `application_receipts`, and `artifact_versions`—plus the retained supporting `match_feedback` and `connector_manifests` tables. It removes `workspace_meta`, `application_attempts`, `application_packet_assets`, and `application_packet_events`.

```sql
CREATE TABLE answer_bank (
  id TEXT PRIMARY KEY,
  answer_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_id TEXT,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  canonical_question TEXT NOT NULL,
  question_fingerprint TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','personal','sensitive','restricted')),
  reuse_scope TEXT NOT NULL CHECK (reuse_scope IN ('global','category_only','employer_specific','never_auto_fill')),
  employer_scope TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','verified','stale','retired')),
  verified_at TEXT,
  expires_at TEXT,
  retired_at TEXT,
  retirement_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES profiles(id),
  FOREIGN KEY(parent_id) REFERENCES answer_bank(id),
  UNIQUE(profile_id, answer_key, version)
);

CREATE TABLE application_identities (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  employer_key TEXT NOT NULL,
  requisition_or_source_key TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  override_of_identity_id TEXT,
  override_reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((attempt_number = 1 AND override_of_identity_id IS NULL AND override_reason = '') OR (attempt_number > 1 AND override_of_identity_id IS NOT NULL AND length(trim(override_reason)) > 0)),
  CHECK ((is_active = 1 AND closed_at IS NULL) OR (is_active = 0 AND closed_at IS NOT NULL)),
  FOREIGN KEY(profile_id) REFERENCES profiles(id),
  FOREIGN KEY(override_of_identity_id) REFERENCES application_identities(id),
  UNIQUE(profile_id, employer_key, requisition_or_source_key, attempt_number)
);

CREATE TABLE application_packets (
  id TEXT PRIMARY KEY,
  application_identity_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_packet_id TEXT,
  is_current_version INTEGER NOT NULL DEFAULT 1 CHECK (is_current_version IN (0,1)),
  superseded_by_packet_id TEXT,
  superseded_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','needs_input','ready_for_review','approved','handed_off','submitted','confirmed','failed','unknown','withdrawn')),
  submission_mode TEXT NOT NULL DEFAULT '' CHECK (submission_mode IN ('','handoff','auto_apply')),
  target_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL DEFAULT 'sha256-sorted-json-v1',
  asset_refs_json TEXT NOT NULL DEFAULT '[]',
  policy_snapshot_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  approval_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((is_current_version = 1 AND superseded_by_packet_id IS NULL AND superseded_at IS NULL) OR (is_current_version = 0 AND superseded_by_packet_id IS NOT NULL AND superseded_at IS NOT NULL)),
  FOREIGN KEY(application_identity_id) REFERENCES application_identities(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id),
  FOREIGN KEY(parent_packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(superseded_by_packet_id) REFERENCES application_packets(id),
  UNIQUE(application_identity_id, version),
  UNIQUE(application_identity_id, content_hash)
);

CREATE TABLE application_packet_items (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_text TEXT NOT NULL DEFAULT '',
  value_hash TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  answer_id TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','personal','sensitive','restricted')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  review_status TEXT NOT NULL CHECK (review_status IN ('proposed','verified','needs_user_input','blocked_sensitive','stale','conflict')),
  blocker_code TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(answer_id) REFERENCES answer_bank(id),
  UNIQUE(packet_id, item_type, field_key)
);

CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('draft_needs_review','approved','rejected')),
  review_provenance TEXT NOT NULL CHECK (review_provenance IN ('current_verified','legacy_unverified')),
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY(parent_version_id) REFERENCES artifact_versions(id),
  UNIQUE(artifact_id, version),
  UNIQUE(artifact_id, content_hash)
);

CREATE TABLE application_receipts (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT '',
  receipt_type TEXT NOT NULL CHECK (receipt_type IN ('user_attestation','adapter_receipt','external_confirmation','failure_evidence','status_import')),
  external_reference TEXT NOT NULL DEFAULT '',
  evidence_path TEXT NOT NULL DEFAULT '',
  evidence_hash TEXT NOT NULL DEFAULT '',
  packet_content_hash TEXT NOT NULL,
  artifact_snapshot_json TEXT NOT NULL DEFAULT '[]',
  answer_snapshot_json TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT NOT NULL UNIQUE,
  submitted_at TEXT,
  captured_at TEXT NOT NULL,
  CHECK ((evidence_path = '' AND evidence_hash = '') OR (evidence_path <> '' AND evidence_hash <> '')),
  CHECK (receipt_type NOT IN ('adapter_receipt','external_confirmation') OR external_reference <> '' OR evidence_hash <> ''),
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  UNIQUE(packet_id, receipt_type, packet_content_hash, external_reference, evidence_hash)
);

CREATE TABLE match_feedback (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  free_text TEXT NOT NULL DEFAULT '',
  applied_to_preferences INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);

CREATE TABLE connector_manifests (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  data_classes_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  terms_url TEXT NOT NULL DEFAULT '',
  terms_reviewed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('unreviewed','fixture_only','permitted_read','terms_warning','permitted_handoff','permitted_submit','disabled_terms_changed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, version)
);

CREATE UNIQUE INDEX idx_active_identity
  ON application_identities(profile_id, employer_key, requisition_or_source_key)
  WHERE is_active = 1;
CREATE INDEX idx_answer_bank_profile_status ON answer_bank(profile_id, verification_status);
CREATE INDEX idx_packet_identity_status ON application_packets(application_identity_id, status);
CREATE UNIQUE INDEX idx_current_packet_version
  ON application_packets(application_identity_id) WHERE is_current_version = 1;
CREATE INDEX idx_packet_items_review ON application_packet_items(packet_id, review_status);
CREATE INDEX idx_receipts_packet ON application_receipts(packet_id, captured_at);
```

Do not store screenshots, resumes, or receipts as database blobs; store local paths plus hashes. Asset references (`role`, artifact version, content hash, and path) are immutable objects in `application_packets.asset_refs_json`. Never mirror highly sensitive answer values into broadly readable Markdown. YAML mirrors redact values according to sensitivity.

**Canonical application identity.** Prefer the canonical JobOS company ID for `employer_key`; otherwise use Unicode NFKC, trim, Unicode lowercase, and whitespace collapse on the employer name—without fuzzy matching or corporate-suffix deletion. Use an ATS requisition ID for `requisition_or_source_key` when present; otherwise canonicalize the source URL by lowercasing scheme/host, removing the fragment and documented tracking parameters, sorting remaining query parameters, and normalizing the path. If neither exists, compute SHA-256 over recursively key-sorted JSON for `{employerKey,titleNfkcLower,locationNfkcLower,descriptionHash}`. `identity_key` is SHA-256 over recursively key-sorted JSON for `{profileId,employerKey,requisitionOrSourceKey}`; `idempotency_key` adds `attemptNumber`. The active-identity index is the duplicate-prevention boundary.

**Canonical packet hashing.** `sha256-sorted-json-v1` means SHA-256 over UTF-8 JSON after recursively sorting object keys; arrays preserve their documented order. It hashes exactly this projection:

```json
{
  "schema": "jobos.application-packet",
  "schemaVersion": 1,
  "identity": {"profileId": "...", "employerKey": "...", "requisitionOrSourceKey": "...", "attemptNumber": 1},
  "job": {"jobId": "...", "targetUrl": "https://canonical.example/apply"},
  "items": [{"itemType": "field", "fieldKey": "email", "ordinal": 1, "valueHash": "...", "sourceType": "answer", "sourceDomainId": "contact.email", "sourceRefs": ["..."], "sensitivity": "personal", "confidence": "high", "reviewStatus": "verified", "blockerCode": ""}],
  "assets": [{"role": "resume", "artifactDomainId": "resume_master", "artifactVersion": 3, "contentHash": "..."}],
  "policy": {"version": 1, "externalApply": "user_configured"}
}
```

`profileId`, `jobId`, answer/source domain IDs, `artifactDomainId`, and attempt number are stable domain identifiers and are included. Storage row IDs, timestamps, paths, reviewer notes, and mutable lifecycle/current/supersession fields are excluded. `items` sort by `(itemType, fieldKey, ordinal)`; `sourceRefs` sort lexicographically after canonical URL/ID normalization; `assets` sort by `(role, artifactDomainId, artifactVersion)`. Duplicate sort keys are a compiler error. Packet creation runs inside one SQLite transaction under the workspace lock, re-reads referenced versions after lock acquisition, and fails on a uniqueness conflict. The existing `audit_log` records packet lifecycle, adapter action, policy snapshot, outcome, and receipt ID.
## Executable policy model

Use a versioned policy snapshot:

```json
{
  "version": 1,
  "externalApply": "user_configured",
  "externalSend": "user_configured",
  "autoApply": "user_configured",
  "autoSend": "user_configured",
  "useLatestDraftIfNoApproval": false,
  "artifactApprovalRequired": true,
  "sensitiveAnswers": "always_prompt",
  "cloudDataClasses": ["job_text", "public_company_facts", "non_sensitive_proofs"],
  "dailyApplyLimit": 20,
  "minimumFitForAutoApply": 70,
  "duplicateWindowDays": 365,
  "allowedConnectors": ["greenhouse_public", "lever_public", "linkedin_session", "indeed_session", "smtp_email"]
}
```

The policy module defaults all external connectors to disabled until the user configures them. Unknown values fail closed with a clear `jobos:` error. Each configured submission/send stores the evaluated policy snapshot in its packet or outreach audit record so later audits do not depend on current settings.
## Feature specifications

### F0 — Policy and foundation repair (Quick win, P0, 3–5 days)

**Closes:** configuration, terms-warning, and durability defects that would make automation unreliable.

**Changes**

- Implement `src/policy.js` with schema validation plus `jobos policy show/validate`; external actions default off and become available per user-configured connector.
- Add profile/environment configuration for Greenhouse, Lever, LinkedIn session, Indeed session, and SMTP credentials. Store acknowledgements and configuration metadata locally; never log session cookies or SMTP secrets.
- Fix `discover run-all --profile` scoping and enforce job/profile consistency in score/tailor.
- Harden URL import: only `http/https`, validate canonical source URLs, reject loopback/private/link-local targets by default, apply timeout/status/byte limits, and provide an explicit trusted-local override.
- Warn, rather than refuse, when the web server binds beyond loopback; document the lack of authentication.
- Add a simple workspace mutation lock around every database write: acquire, reload, mutate, atomically save, release. It prevents lost `sql.js` snapshot writes without a separate write-coordinator subsystem.

**Acceptance**

- Invalid policy exits 2 with a typed JSON error; a default policy has every connector disabled.
- Existing workspaces migrate without losing preferences.
- Tests cover source-URL validation, private-address rejection, oversized/timeout fetch, profile scoping, mismatch rejection, non-loopback warning, and local configuration redaction.
- Concurrent-write fixtures prove no lost update or duplicate active identity; interrupted persistence leaves either the prior valid database or the complete new database.
- Adapter configuration records a policy snapshot and Terms-of-Service acknowledgement for LinkedIn/Indeed without recording secrets.
### F1 — Answer vault and question queue (Quick win, P0, 4–6 days)

**Closes:** Sprout/Simplify/LoopCV reusable-answer gap.

**Commands**

```text
jobos answers add --profile <id> --category <category> --question <text> --answer <text> --source <ref> --sensitivity <class>
jobos answers list --profile <id>
jobos answers show <answer-id> [--reveal-sensitive]
jobos answers verify <id> [--expires <date>]
jobos answers retire <id> --reason <text>
jobos answers match --profile <id> --questions <json-file>
```

**Rules**

- Categories: identity, contact, education, employment, portfolio, motivation, experience_story, work_authorization, compensation, demographic, legal_attestation, other.
- Sensitivity: public, personal, sensitive, restricted.
- Reuse: global, category-only, employer-specific, never-auto-fill.
- Exact normalized match may propose a verified non-sensitive answer. Semantic matching may only propose and must show why; it never auto-fills restricted categories.
- Any generative polish creates a side-by-side draft. If facts/numbers/entities change, block until the user verifies the source.
- Answer rows are append-only versions. Verify, edit, expire, and retire operations insert a new version under the same `answer_key`; packet items continue to reference the exact prior row when historical reconstruction is needed.

**Acceptance**

- Work-authorization/demographic/legal questions always become `needs_user_input` even when a stored answer exists, unless the user explicitly selects the exact answer in the current packet.
- Stale/expired answers block reuse.
- `answers list` and every JSON/API/MCP list response always redact sensitive/restricted values. `answers show --reveal-sensitive` is rejected when `--json` is present or stdout is not a local TTY; it prints one selected value and never writes it to audit payloads. The loopback review UI uses a short-lived, packet-scoped reveal token and never embeds restricted values in initial HTML.
- Workspace mirror lists IDs/categories/statuses without restricted values.

### F2 — Application compiler and immutable packet (Medium, P0, 5–8 days)

**Closes:** application-plan, exact-artifact, review, idempotency, configured auto-apply, and trust gaps.

**Commands**

```text
jobos apply plan --job <id> --profile <id> [--questions <json-file>]
jobos apply packet create --job <id> --profile <id> [--questions <json-file>] [--auto]
jobos apply packet show <packet-id> [--json|--output markdown]
jobos apply packet review <packet-id> --decision approve|reject --note <text>
jobos apply packet return-to-draft <packet-id> --reason <text>
jobos apply packet submit <packet-id> --connector <id>
jobos apply packet diff <old-id> <new-id>
```

`--auto` compiles and submits through the configured connector in one locked, idempotent operation. It is allowed only when the packet has no blockers, the connector is configured with `permitted_submit`, the fit meets `minimumFitForAutoApply`, the daily limit remains, and effective artifact policy permits the selected versions.

**Compiler output**

- target/source identity and duplicate assessment;
- fit floor and dealbreaker result;
- requirement-to-proof coverage;
- chosen resume/cover-letter artifact version/hash;
- field map with answer source, confidence, freshness, and sensitivity;
- blocking errors, review warnings, and informational notes;
- exact policy and connector snapshot.

**Blocker codes**

`missing_required`, `missing_proof`, `unsupported_claim`, `sensitive_prompt`, `stale_answer`, `conflicting_answer`, `profile_job_mismatch`, `duplicate_application`, `artifact_unapproved`, `target_unknown`, `connector_not_permitted`, `terms_warning_unacknowledged`, `daily_apply_limit`, `fit_below_auto_apply_minimum`.

**Acceptance**

- The same inputs produce the same simple SHA-256 packet hash.
- A packet with blockers cannot use a configured adapter.
- Approval records stable local reviewer ID, timestamp, note, and hash; rejection requires a reason and moves to `needs_input`; return-to-draft is a distinct audited command. Any content edit makes a new version.
- A duplicate target/profile is blocked before handoff or auto-apply unless explicitly overridden with an audited reason.
- Packets cannot use an artifact version with `review_provenance=legacy_unverified`; migrated legacy approvals require one explicit current review before compilation can clear `artifact_unapproved`.
- `--auto` calls only the selected user-configured adapter, persists its request idempotency key, and atomically records either an adapter receipt and `submitted` status or a `failed` status.
### F3 — Local review workspace (Quick win, P0/P1, 4–7 days)

**Closes:** Sprout manual-review and LinkedIn Apply Assistant review-UI gap.

**Dashboard**

- Packet list grouped by `needs_input`, `ready_for_review`, `approved`, and adapter outcome.
- Review by exception: blockers first, then new/stale/low-confidence items, then collapsed verified items.
- Side-by-side artifact/answer diffs with proof/source links.
- Visible policy, connector configuration, Terms-of-Service warning acknowledgement, and receipt state. Packet review is available for exceptions; it is not a prerequisite for a configured auto-apply.
- Sensitive values hidden by default and never injected into page HTML until revealed.

**Acceptance**

- Keyboard-accessible review flow; no sensitive value in initial HTML response/log.
- Approval API requires current hash to prevent stale-tab approval.
- Reject requires a reason and writes an audit-log record before moving to `needs_input`; return-to-draft records its own audit event and moves to `draft`.
- CSRF/origin checks cover every mutation, including adapter configuration and external-action requests.
### F4 — Auto-apply adapters and browser handoff (Strategic parity bridge, P1, 10–15 days)

**Closes:** Simplify/LinkedIn/Teal autofill and application-submission parity gaps.

Deliver in three increments:

1. **Greenhouse and Lever auto-apply (first):** adapters call the configured public ATS APIs with the exact packet fields and immutable asset references. They enforce policy, fit, duplicate, and idempotency checks; a successful response immediately creates an adapter receipt.
2. **LinkedIn and Indeed session adapters (second):** user-provided session cookies enable configured discovery and auto-apply. Before enablement JobOS displays a Terms-of-Service risk warning, records acknowledgement, and makes clear that the user bears compliance responsibility. CAPTCHA pages fail gracefully without bypass.
3. **Browser companion (useful fallback):** `jobos apply handoff <packet> --format clipboard|json|html` and an optional loopback extension expose exact fields/files for unsupported forms. It is not the primary path when a configured adapter supports the target.

Every adapter submits only a current, blocker-free packet and records its request idempotency key, response reference, policy snapshot, and outcome in the receipt/audit ledgers. The companion retains an explicit domain allowlist, never creates employer accounts, and never bypasses CAPTCHA.

**Acceptance**

- Greenhouse and Lever fixture adapters submit the exact packet projection once per idempotency key and automatically populate `application_receipts`.
- LinkedIn/Indeed adapters require user-provided session configuration and a recorded Terms-of-Service warning acknowledgement before use; they redact session data from all surfaces and logs.
- Conditional, unknown, and sensitive fields are never guessed; sensitive answers require direct user input before any adapter request.
- All filled or submitted values come from the current packet hash and immutable asset references.
- Unsupported pages and CAPTCHA encounters yield a typed failure or portable-handoff result without an external duplicate.
### F5 — Receipt ledger and honest reconciliation (Quick win, P0/P1, 3–6 days)

**Closes:** Sprout/LoopCV confirmation and tracker-sync gap.

**Commands**

```text
jobos apply attest-submitted <packet-id> --submitted-at <iso> [--note <text>]
jobos apply confirm-receipt <packet-id> --reference <text> [--evidence <file>]
jobos apply fail <packet-id> --reason <code> --note <text>
jobos apply status <packet-id>
jobos applications reconcile --input <eml|json|csv>
```

Auto-apply adapters populate receipts in their submission transaction. User attestation and selected-file import remain the fallback when auto-apply is off or an adapter cannot return a receipt.

**Acceptance**

- Handoff alone never changes application status to `applied`.
- A successful configured adapter request records an `adapter_receipt`, marks the packet `submitted`, and may move the tracker to `applied` in the same locked transaction.
- `attest-submitted` is the fallback for a current `handed_off` packet; it records a typed user-attestation receipt and moves the packet to `submitted`.
- `confirm-receipt` rejects any packet not already `submitted`; it adds external evidence and advances to `confirmed`. A dispute records `evidence_disputed` in `audit_log` and moves the packet to `unknown` without deleting either receipt.
- Receipt operations store exact packet/artifact/answer hashes; external evidence also stores a local file hash.
- Receipt idempotency is simple SHA-256 over recursively key-sorted JSON for packet ID/hash, receipt type, connector ID, submitted time, external reference, and evidence hash. Exact replays return the existing receipt; conflicting replays fail and create no second lifecycle event.
- Conflicting status evidence creates a review task. Imported mail is scoped to user-selected files; originals and classifier confidence are retained.
### F6 — Resume document and artifact version system (Medium, P1, 8–12 days)

**Closes:** Teal/Simplify/Sprout production-document gap.

- Extend the foundational `artifact_versions` ledger with a structured resume JSON model using stable section/item IDs and proof links.
- Import Markdown/text first; evaluate PDF parsing separately and label extraction confidence.
- Add templates with deterministic HTML/PDF export; DOCX is a separate adapter and should not block PDF parity.
- Store immutable artifact versions, parent version, content hash, generation mode, proof set, warnings, reviewer decision, and export paths.
- Add section/item diff, page-count warning, missing-contact warning, and text-extraction smoke check.

**Acceptance**

- Exported PDF text contains all selected proof-backed content and no unsupported claims.
- Packet references exact artifact versions, not mutable paths.
- Regeneration never overwrites an approved artifact.

### F7 — Feedback-driven discovery and career brief (Medium, P1/P2, 8–12 days)

**Closes:** Jack/Indeed/LinkedIn/Simplify learning gap.

**Commands**

```text
jobos feedback job <job-id> --verdict save|skip|apply --reason <codes> [--note <text>]
jobos profile brief --profile <id> [--refresh]
jobos search plan --profile <id> --intent <text>
jobos preferences proposals --profile <id>
jobos preferences accept|reject <proposal-id>
```

- Reasons are explicit: role, seniority, company stage, industry, mission, location, work model, pay, skills, timing, trust/red flag, other.
- Feedback proposes preference changes; it never silently mutates the canonical profile.
- Natural-language intent compiles into a visible search plan (target titles, synonyms, positive/negative filters, sources, schedule).
- The deterministic mode uses templates/rules; configured LLM mode produces structured proposals only.

**Acceptance**

- Every learned rule shows supporting feedback events and can be rejected/undone.
- Protected/sensitive inferences are excluded.
- Search quality evaluation uses a held-out fixture set and reports precision@review-budget, not only job count.

### F8 — User-configured connector SDK (Medium, P1, 6–10 days plus connector work)

**Closes:** board discovery, configured submission, and outreach-delivery coverage.

Connector interface:

```js
{
  manifest(),
  discover(config, context),
  inspectApplication?(url, context),
  submitApplication?(packet, context),
  sendOutreach?(message, context),
  buildHandoff?(packet, context)
}
```

Manifest fields include owner, version, capabilities, domains, auth type, data classes, API/feed status, terms/privacy URLs and review dates, rate limit, side-effect declaration, configuration requirements, Terms-of-Service warning requirement, and fixture pack.

Prioritize:

1. LinkedIn session-cookie discovery and auto-apply adapter with a displayed and recorded Terms-of-Service risk warning;
2. Indeed session-cookie discovery and auto-apply adapter with the same warning and acknowledgement;
3. SMTP outreach delivery;
4. Greenhouse and Lever public ATS auto-apply;
5. Ashby public job-post feed, then generic RSS/JSON/CSV/import adapters.

**Acceptance**

- Core permits side effects only for a user-configured connector in `permitted_submit` and records the evaluated policy, connector, idempotency key, outcome, and receipt reference.
- LinkedIn/Indeed adapters require session configuration and warning acknowledgement but do not require platform-partner status; CAPTCHA and expired sessions return typed non-bypass failures.
- Every connector passes shared normalization, URL validation, dedupe, timeout, size, rate-limit, audit, and idempotency contract tests.
- Connector failures do not crash other saved searches or create duplicate applications/messages.

### F-auto-send — SMTP outreach delivery (P1, 3–5 days)

**Closes:** configurable outbound outreach delivery.

**Commands**

```text
jobos outreach send --profile <id> --to <email> --draft <artifact-id> [--auto]
jobos outreach status <message-id>
```

The SMTP adapter sends a proof-grounded, versioned outreach draft only when `autoSend` and `smtp_email` are user-configured. `--auto` selects the latest draft only when `useLatestDraftIfNoApproval` is enabled; otherwise it uses the approved artifact required by policy. It stores a sorted-JSON SHA-256 idempotency key, SMTP message ID, policy snapshot, and delivery outcome in `audit_log`.

**Acceptance**

- SMTP fixture delivery sends one exact draft per idempotency key and records the returned message ID.
- Missing or unapproved artifacts fail according to effective policy; sensitive answers are never inserted or inferred.
- A retry returns the prior delivery record rather than sending a second message.
### F9 — Interactive interview rehearsal (Strategic, P2, 10–15 days)

**Closes:** Jack/Indeed/Teal coaching gap.

- Text session first: question → response → proof-aware feedback → retry.
- Optional browser microphone/voice later, off by default, with local transcript and per-session deletion.
- Feedback rubric: relevance, structure, evidence, specificity, ownership, concision, unsupported-claim flags.
- Map responses to proof IDs and maintain a versioned STAR story library.
- Never create employer-facing interview content or impersonate the candidate.

**Acceptance**

- Deterministic fixture evaluation catches invented metrics/claims.
- Users can run without recording audio or using a cloud model.
- Deleting a session removes transcript/audio derivatives and leaves only aggregate opt-in scores if requested.

### F10 — Offer and negotiation workspace (Strategic, P2, 6–9 days)

**Closes:** Jack/Indeed late-funnel gap.

- Add offer entity: compensation components, dates, contingencies, benefits, location, equity assumptions, source documents.
- Build source-backed market comparison with explicit geography/date/sample caveats.
- Generate negotiation scenarios and rehearsal prompts, not legal or financial advice.
- Configure SMTP delivery for a proof-grounded negotiation draft only when the user enables that connector; otherwise keep the draft local.

**Acceptance**

- Salary estimates are labelled estimates with sources and dates.
- Equity values show assumptions and never present speculative value as cash.
- Sensitive offer data is local-only unless explicitly selected for a configured model call.

## Downstream and lateral-thinking analysis

| Design choice | First-order benefit | Second/third-order consequence | Mitigation / leverage |
|---|---|---|---|
| Immutable packet/version | Exact application target | More versions and storage | Content-addressed files; retain approved and submitted versions, prune abandoned drafts only by explicit command. |
| Answer vault | Faster repeated forms | Stale errors can propagate | Expiry, employer scope, conflict detection, review-by-exception, receipt snapshot. |
| User-configured adapters with browser handoff | Fast supported submissions with a fallback | Connector and Terms-of-Service risk | Per-connector configuration, warning acknowledgement for authenticated boards, idempotent receipts, and portable handoff on failure. |
| Feedback proposals, not silent learning | Explainability and reversibility | More decisions for user | Batch proposals in weekly review with supporting evidence and one-click accept/reject. |
| Quality floor/application budget | Better signal and reputation | May miss exploratory/pivot roles | Separate “exploration budget” with explicit lower-confidence label. |
| Local mail import | Privacy and status automation | Email content is highly sensitive and classifier errors can move stages | User-selected `.eml` first; propose changes; keep original evidence; narrow later OAuth scopes only after threat model. |
| Connector terms manifest | Prevents accidental prohibited automation | Ongoing legal/product maintenance | Expiry dates fail closed; community connectors remain fixture-only until reviewed. |
| Proof-required claims | Trust and interview defensibility | Sparse profiles produce weaker drafts | Turn missing proof into focused user questions and proof-collection tasks, not invented content. |
| Hash-bound receipt ledger | Trustworthy analytics | “Confirmed” rates may initially be lower | Honest unknown state is a feature; weekly review prompts for missing receipts. |
| Voice rehearsal | Higher coaching value | Audio/transcript privacy and emotional sensitivity | Text-first, opt-in mic, per-session deletion, local processing where practical. |

## Implementation sequence and tickets

This is an **8–12 week plan for 1–2 engineers**. One engineer owns migrations and the application domain; a second, when available, owns connectors and surfaces. Only one engineer modifies `src/db.js` in a sprint, and the workspace lock serializes all database writes.

| Ticket | Focus | Required result | Depends |
|---|---|---|---|
| A1 | Policy and configuration | `user_configured` policy, connector configuration/redaction, Terms-of-Service acknowledgement, simple mutation lock | — |
| A2 | Foundation safety | Source URL validation, profile consistency, non-loopback warning, concurrency/atomic-save fixtures | A1 |
| B1 | Schema v6 | Simplified identity/packet/receipt migration; sorted-JSON SHA-256; audit-log transition records | A1 |
| B2 | Application data | Answer bank, packet compiler, `--auto`, duplicate prevention, review and receipt commands | B1 |
| C1 | Public ATS auto-apply | Greenhouse/Lever adapter fixtures, request idempotency, automatic receipts | B2 |
| C2 | SMTP outreach | Configured SMTP send, artifact policy selection, delivery idempotency | A1/B2 |
| D1 | Authenticated board adapters | LinkedIn/Indeed session discovery and auto-apply with recorded risk warning | B2 |
| D2 | Quality and career depth | Artifact versions, feedback, reconciliation, connector contract/evaluation coverage | B2/C1/C2/D1 |

### Sprint A — Foundation (1.5 weeks)

- Implement typed policy and per-connector configuration with external actions disabled by default.
- Add the simple workspace mutation lock, URL/profile safety fixes, non-loopback warning, secret redaction, and Terms-of-Service warning acknowledgement storage.

### Sprint B — Application data (3 weeks)

- Migrate to schema v6: six primary application tables plus retained feedback/connector registries, with existing `meta` and `audit_log`.
- Deliver answer bank, immutable packets/items/assets JSON, simple SHA-256 hashing, duplicate prevention, artifact checks, receipts, and `apply packet create --auto`.

### Sprint C — Auto-apply and auto-send adapters (2.5 weeks)

- Deliver Greenhouse and Lever public-ATS auto-apply with fixture replay, idempotency, policy/fit limits, and automatic receipts.
- Deliver SMTP outreach auto-send with versioned-draft selection, delivery receipts, and safe retry behavior.

### Sprint D — Board adapters and quality (3 weeks)

- Deliver LinkedIn and Indeed session-cookie discovery/auto-apply adapters, displayed and recorded Terms-of-Service risk warnings, graceful CAPTCHA failure, and session-secret redaction.
- Complete artifact versions, match feedback, reconciliation, audit/receipt verification, and connector contract tests.

### Sprint E — Career depth (optional, 2 weeks)

- Add interview rehearsal, offers/negotiation, and network/career-brief work after the application MVP is stable.

The core A–D path is approximately **10 elapsed weeks**, with an expected range of **8–12 weeks for 1–2 engineers**. Sprint E is optional and excluded from that MVP range. Browser handoff remains available for unsupported targets but does not delay configured adapter delivery.

### Shared-file ownership and merge order

The migration owner updates `src/db.js` and fixtures first. The application-domain owner then integrates CLI/API/MCP/workspace surfaces; the connector owner integrates adapters only against the frozen policy and packet interfaces. Each adapter must land with its fixture, idempotency test, receipt test, and audit assertion.
## Shared definition of done

Every ticket is complete only when:

- domain behavior and failure modes are implemented, not stubbed;
- migrations are backward-compatible and tested on a prior-schema fixture;
- CLI success/error JSON and non-zero validation exits are stable;
- corresponding API/MCP/workspace/dashboard surfaces are added or an exception is documented;
- audit records identify inputs, policy, entity/version, configured connector, side effect, receipt reference, and outcome;
- sensitive values are absent from logs/default mirrors/error messages;
- deterministic offline behavior exists where practical;
- targeted tests pass, then `npm test`, `npm run smoke`, and the relevant eval pass;
- README CLI contract, agent guide registry, BUILD_PROGRESS, and limitations are updated;
- no test treats removal of safety language as a quality metric.

## Evaluation plan

Add `run_eval_apply.js` with at least these axes, each requiring 9/10:

1. truth/proof grounding;
2. sensitive-field handling;
3. packet completeness and deterministic sorted-JSON SHA-256 hash;
4. version and artifact-policy correctness;
5. idempotency and duplicate defense;
6. configured auto-apply/auto-send behavior and receipt capture;
7. receipt/status honesty;
8. connector configuration and Terms-of-Service warning enforcement;
9. agent/API/workspace surface parity;
10. privacy/log redaction and regression coverage.

**Deterministic corpus.** The checked-in corpus contains ordinary, conditional, sensitive/restricted, stale/conflicting, duplicate/idempotency, Greenhouse/Lever, LinkedIn/Indeed, SMTP, CAPTCHA, and connector-warning cases. Fixed clocks, IDs, policy snapshots, and recursively key-sorted JSON hash vectors make results reproducible offline.

**Axis-specific hard measures.** Truth/proof and sensitive handling require zero unsupported claims or inferred restricted values. Hash/version cases require every sorted-JSON vector and stale-version case to pass. Duplicate defense blocks same active-identity replay and accepts only a reasoned next attempt. Configured auto-apply and auto-send must emit exactly one request per idempotency key, use only a configured connector, and atomically record outcome/receipt; disabled connectors emit no request. LinkedIn/Indeed require a recorded warning acknowledgement, but an acknowledged user configuration permits the adapter. CAPTCHA must produce a typed failure without bypass. Privacy requires zero seeded secrets in HTML, logs, errors, or default mirrors.

Hard assertions override average score: no unsupported claim, no restricted-field inference, no side effect from a disabled or unconfigured connector, no duplicate request for an idempotency key, no `applied` transition without an adapter receipt or typed user attestation, no `confirmed` transition before `submitted`, and no sensitive value in default logs/mirrors.
## Risk warnings

- **LinkedIn and Indeed:** session-cookie adapters display a clear Terms-of-Service risk warning and require the user to acknowledge it before enabling the connector. JobOS records the acknowledgement; the user bears responsibility for platform compliance.
- **CAPTCHA:** bypass is not supported. An adapter encountering a CAPTCHA stops with a typed failure and offers no evasion path.
- **Accounts:** JobOS does not create employer accounts.
- **Sensitive answers:** work authorization, criminal history, disability, demographic/EEO, legal-attestation, and other restricted answers always require direct user input; adapters never infer them.
- **Scope:** there is no global auto-apply switch. Auto-apply and auto-send require separate per-connector configuration, policy limits, current packet checks, idempotency, and receipt logging.
- **Credentials and delivery:** session cookies and SMTP credentials stay local, are redacted from logs, and are never copied to workspace mirrors.
## Remaining strategic gaps after this plan

Even after F0–F10, JobOS will not have:

- a proprietary global job corpus or first-party recruiter network like Indeed/LinkedIn/Jack & Jill;
- platform-authorized delegated submission at commercial scale;
- universal Workday/iCIMS/Taleo form coverage;
- employer-side status APIs across the market;
- independently validated outcome lift from large cohorts;
- mobile-native apps.

These are partnership/distribution investments, not missing MVP functions. They should not be disguised with unsupported coverage or outcome claims.

## Version history
- **v2.0 — 2026-07-13:** Revised to embrace user-configured auto-apply/auto-send direction per PR #2. Streamlined the schema from 11 tables to six primary application tables, added LinkedIn/Indeed and SMTP connectors, and reduced the MVP timeline from 17–23.5 to 8–12 weeks.

- **v1.5 — 2026-07-11:** Separated canonical identities, active attempts, and current packet versions; published the exact hash projection; added legacy artifact backfill/re-review; enforced a single persistence boundary; and derived staffing/critical path from person-day ticket estimates.
- **v1.4 — 2026-07-10:** Added an all-writer `sql.js` coordinator with durable-save/crash tests, active packet-version semantics, receipt evidence/replay constraints, dispute events, realistic staffing/critical path, and serialized Sprint-A integration ownership.
- **v1.3 — 2026-07-10:** Updated inputs after earlier runtime policy defaults were normalized; F0 remains the required central policy-engine implementation.
- **v1.2 — 2026-07-10:** Made identity normalization and database idempotency enforceable; added explicit review/rejection transitions and reviewers; made attestation a mandatory confirmation predecessor; distinguished connector no-go from parity success; serialized shared-file ownership; and added deterministic evaluation fixtures, thresholds, and axis measures.
- **v1.1 — 2026-07-10:** Remediated provisional evaluation: added enforceable answer/artifact versions, application identity/idempotency, packet events, receipt snapshots/hashes, canonical hashing, unified attested/confirmed semantics, evidence-to-test traceability, and independently assignable test-mapped tickets.
- **v1.0 — 2026-07-10:** Initial swarm-ready adaptation plan; translated competitive patterns into typed policy, answer vault, application compiler, immutable packets, exception review, user-controlled handoff, receipt ledger, feedback learning, connector governance, and phased acceptance tests.
