# OMP execution plan — JobOS PR 10: Application Packet + Receipt Spine

## Role and finish condition
Run this plan as the lead OMP session from base commit `8b6c97395fa5e254f278f1b9c7aa9a43b015e890`. This is a test-first implementation loop. OMP owns role and model routing; product code and documentation must not name or configure a provider/model for the loop.

The loop closes at the first of these conditions:
1. Convergence: the focused PR 10 suite, `npm test`, and `npm run smoke` all pass and no acceptance contract remains unresolved.
2. Three complete implementation iterations have run.

Three iterations are a hard maximum, not a target. Stop immediately at the first convergence. If iteration 3 ends with any required check failing, report `not converged`, list the exact failing checks and affected contracts, and do not claim completion.

## Product goal and loss function
Close the evidence gap between local artifact approval and honest application tracking. A trusted local user can freeze the exact approved materials, redacted answer references, and target identity used for an application attempt; later record a manual submission attestation and optional external receipt reference against that exact packet. Historical packets and receipts remain immutable and inspectable. No packet, readiness state, bare tracking status, agent action, or local approval may invent an external submission or receipt.

## Non-goals
- Auto-apply adapters, SMTP sending, browser submission handoff, authenticated-board connectors, or any other external action.
- PDF/DOCX generation.
- Restoring a web/API layer.
- Redesigning the locked 011 TUI shell. Its existing readiness/detail surface may show the new secret-safe summary; no new packet workflow or overlay is required.
- Full answer-vault versioning. Packet rows pin existing answer row IDs plus non-secret row-version fingerprints.
- Automatic packet creation from `pursue`, artifact review, or material redrafting.
- Adapter receipts in this PR. The schema reserves the type only.

## Non-negotiable contracts
- SQLite remains canonical. Packet YAML and audit JSONL are post-commit projections only.
- `src/domain-tools.js` remains the single mediation door for every new CLI/TUI/MCP/ACP verb.
- Packet creation, submission attestation, and receipt confirmation are trusted local human mutations. MCP/ACP receive list/show/diff inspection only and cannot invoke those mutations, even with `JOBOS_ALLOW_AGENT_ATTESTATION=1`, `allowExternalAttestation: true`, or spoofed `JOBOS_MEDIATION=cli|tui`.
- Packet creation is strict: readiness must be `approved` and `localApprovalComplete: true`. There is no `--allow-unapproved` path in this PR.
- A packet freezes canonical content; packet rows and receipt rows are never updated in place. Currency, staleness, and receipt state are derived.
- Creating a packet does not advance an existing application status. If no tracking application exists, packet creation atomically initializes one at `materials-ready` so the non-null packet/application relationship is honest.
- A manual attestation is evidence supplied by the user, not an external action performed by JobOS. Every packet/receipt audit uses `external_side_effect='none'`; mutation responses use `externalSideEffects: 'none'` and `submissionPerformed: false`.
- Bare `applications create|update --status applied` stays backward compatible but creates no receipt. Its audit payload says `receiptBound: false`; packet/readiness surfaces continue to report `receiptState: none` until a receipt exists.
- Restricted, sensitive, and ordinary answer plaintext never appears in a packet row, packet hash projection, CLI/MCP/ACP response, TUI model, YAML mirror, or audit payload.
- New writes use `guardedWrite`; canonical audit rows and status changes commit in the same transaction, while filesystem projections run only after persistence succeeds.

## Frozen architecture

### Schema version and tables
Bump the store schema version from 7 to 8. Add both tables to the base schema and idempotent migration path. Do not rewrite existing application, artifact, answer, or status rows.

```sql
CREATE TABLE IF NOT EXISTS application_packets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_hash TEXT NOT NULL,
  readiness_status_at_create TEXT NOT NULL CHECK(readiness_status_at_create = 'approved'),
  readiness_version INTEGER NOT NULL CHECK(readiness_version >= 3),
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
  CHECK((cover_artifact_id IS NULL AND cover_content_hash IS NULL) OR
        (cover_artifact_id IS NOT NULL AND cover_content_hash IS NOT NULL)),
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
  source TEXT NOT NULL CHECK(source IN ('cli','tui')),
  external_side_effect TEXT NOT NULL DEFAULT 'none' CHECK(external_side_effect = 'none'),
  UNIQUE(packet_id, type),
  FOREIGN KEY(packet_id) REFERENCES application_packets(id),
  FOREIGN KEY(application_id) REFERENCES applications(id)
);

CREATE INDEX IF NOT EXISTS application_receipts_application_idx
  ON application_receipts(application_id, recorded_at, id);
```

`UNIQUE(packet_id,type)` intentionally permits one attestation and one confirmation record for a packet. `adapter_receipt` is reserved and unreachable in this PR. Supporting multiple imported evidence items later requires an explicit migration rather than ambiguous replay behavior now.

Do not persist the strawman packet status enum. It conflates immutable content, current-version selection, and receipt evidence. Public projections derive three orthogonal fields instead:
- `currency: current | superseded | stale`
- `receiptState: none | attested | confirmed`
- `attestable: boolean`

### Packet series, attempt, and revision rules
The packet series is exactly `(job_id, profile_id)`.

Creation is explicit and deterministic:
1. Compile readiness without recursively including its packet summary.
2. Require `approved` plus `localApprovalComplete: true`.
3. Re-read the current approved resume and optional approved cover; verify each canonical artifact hash and workspace mirror hash.
4. Build the canonical redacted packet projection and hash it.
5. If the newest packet in the current un-attested attempt has the same hash, return it with `idempotent: true`; create no row, audit, status change, or projection.
6. If the newest packet has no `user_attestation` and the hash differs, keep its `attempt_number`, increment `revision`, and set `supersedes_packet_id` to that packet.
7. If the newest packet has an attestation or confirmation, start `attempt_number + 1`, `revision = 1`, and point `supersedes_packet_id` to the prior packet.
8. If no application exists, create the deterministic tracking application at `materials-ready` inside the same guarded transaction. Never alter an existing application status during packet creation.

A material or answer edit does not auto-create a packet. It makes the previous packet stale; the next explicit create produces the next revision or attempt under these rules. Historical rows and receipts remain untouched.

### Canonical packet projection and SHA-256
Add one recursive canonical JSON serializer: object keys sorted lexicographically; arrays pre-sorted by the domain keys below; UTF-8 JSON with no whitespace. Hash the exact canonical string with full lowercase SHA-256. Exclude packet ID, application tracking status/notes, attempt/revision, timestamps, mirror paths, receipt state, and readiness `generatedAt`, so equal inputs have equal hashes.

The version-1 hash projection is exactly:

```json
{
  "version": 1,
  "target": {
    "jobId": "...",
    "profileId": "...",
    "title": "...",
    "company": "...",
    "location": "...",
    "identityKey": "...",
    "employerKey": "...",
    "sourceKey": "...",
    "dedupeKey": "...",
    "source": "...",
    "sourceUrl": null
  },
  "materials": {
    "resume": { "artifactId": "...", "seriesKey": "...", "revision": 1, "contentHash": "..." },
    "coverLetter": null,
    "proofPointIds": ["..."],
    "score": { "overall": 80, "confidence": null, "mode": null }
  },
  "answers": [
    {
      "questionFingerprint": "...",
      "category": "...",
      "answerId": "...",
      "rowFingerprint": "...",
      "sensitivity": "restricted",
      "reuseScope": "never_auto_fill",
      "verificationStatus": "verified",
      "responseMode": "direct_input_redacted"
    }
  ],
  "readiness": {
    "version": 3,
    "status": "approved",
    "localApprovalComplete": true,
    "blockers": [],
    "warnings": []
  }
}
```

Rules:
- `coverLetter` is populated only when the current effective cover revision is approved; missing or currently rejected optional cover is `null`, with the readiness warning retained.
- Sort `proofPointIds`; sort answers by `questionFingerprint`, then `answerId`; retain readiness blocker/warning order from the compiler.
- The answer `rowFingerprint` is SHA-256 of canonical `{id,updatedAt,sensitivity,verificationStatus,reuseScope}`. It deliberately excludes answer text, including low-entropy restricted values that would be vulnerable to dictionary recovery. Updating an answer changes `updatedAt`, invalidates the packet, and requires a new packet. This is the bounded substitute for full answer-vault versioning.
- Store `answers`, `target`, `materials`, blockers, and warnings in the corresponding row JSON columns. Public/YAML projections reconstruct the same redacted shape.
- Recompute this projection before attestation. Any difference, loss of local approval, changed current artifact ID/hash, changed answer row version, or target identity change returns `packet_stale` with secret-safe changed paths. It writes nothing.

### Receipt hashing, idempotency, and conflicts
A receipt is immutable. Normalize `submitted_at` to UTC ISO-8601; reject an invalid or timezone-less value with `invalid_submitted_at`.

Hash canonical version-1 receipt content:

```json
{
  "version": 1,
  "type": "user_attestation",
  "packetHash": "...",
  "submittedAt": "2026-07-20T12:00:00.000Z",
  "externalReference": "",
  "evidenceHash": "",
  "note": ""
}
```

Including `note` corrects the strawman: an “exact replay” is exact across every immutable user-supplied field. `recorded_at`, row ID, source, and the fixed `external_side_effect` are metadata and are not hashed.

For an existing `(packet_id,type)`:
- Equal `receipt_hash` returns the existing receipt with `idempotent: true` and performs no duplicate audit or status transition.
- A different hash returns typed `receipt_conflict`; it never overwrites evidence.

`confirm-receipt` writes type `imported_evidence`, copies `submitted_at` from the required prior `user_attestation`, requires a non-empty external reference, and leaves evidence path/hash empty in this PR. It may set `applications.confirmation_url` only when the reference is an absolute `http:` or `https:` URL; non-URL references live only in the receipt. It never changes application status.

### Application status and audit semantics
Actual valid application statuses are `saved`, `researching`, `materials-ready`, `applied`, `recruiter-screen`, `interview`, `offer`, `rejected`, `withdrawn`, and `ghosted`.

`attest-submitted` behavior:
- Require a current, non-stale, attestable packet and trusted source `cli|tui`.
- Insert the `user_attestation` receipt and canonical audit in one guarded transaction.
- If current application status is `saved`, `researching`, or `materials-ready`, set it to `applied` and add exactly one `status_changes` row whose note includes packet ID, packet hash, and receipt ID.
- If current status is `applied` or any later/outcome status, record the receipt without regressing or otherwise changing status.
- Return `receiptBound: true`, `applicationStatusChanged`, previous/current status, `externalSideEffects: 'none'`, and `submissionPerformed: false`.

Audit actions:
- `application_packet.created` on entity `application_packet`.
- `application.submission_attested` on entity `application_receipt`.
- `application.receipt_confirmed` on entity `application_receipt`.
- Existing direct application create/update audits gain `receiptBound: false`; a bare transition to `applied` has no receipt ID/hash and no receipt insert.

Refactor tracking writes around one non-persisting internal mutation primitive so packet/application/receipt changes can share a single `guardedWrite` transaction. Public `appCreate` and `appUpdate` wrappers must themselves use `guardedWrite`, queue audit and job projections post-commit, and preserve current CLI behavior. Do not nest guarded writes.

### Public service and error contracts
Add a focused packet/receipt service. Public operations:
- `createApplicationPacket(s, {jobId, profileId, createdBy})`
- `listApplicationPackets(s, {jobId, profileId})`
- `showApplicationPacket(s, packetId)`
- `diffApplicationPackets(s, firstPacketId, secondPacketId)`
- `attestApplicationSubmitted(s, {packetId, submittedAt, note, source})`
- `confirmApplicationReceipt(s, {packetId, reference, note, source})`
- a secret-safe current packet/receipt summary used by readiness

Stable typed errors:
- Reuse `unknown_job`, `unknown_profile`, and `profile_job_mismatch`.
- `packet_list_filter_required`
- `unknown_packet`
- `packet_not_ready` for readiness blockers
- `artifact_unapproved` when the only gap is pending local artifact review
- existing artifact mirror/hash integrity codes where applicable
- `packet_stale`
- `invalid_submitted_at`
- `receipt_attestation_required`
- `receipt_reference_required`
- `receipt_conflict`
- `human_packet_freeze_required`
- `human_submission_attestation_required`

Every error includes only secret-safe details and reaches CLI JSON through the existing normalized non-zero error envelope.

Packet show/list output includes packet identity, attempt/revision, artifact IDs/hashes, redacted answer metadata, target identity, readiness snapshot, derived `currency`, `receiptState`, `attestable`, and secret-safe receipt metadata. It never returns answer values. Packet diff recursively compares the two public canonical projections and returns deterministic JSON-pointer changes as `{path,before,after}` plus `sameContent`; text mode renders those same changes without reading artifact plaintext.

### CLI and domain tools
Register and route these exact CLI commands through `callDomainTool(..., {source:'cli'})`:
- `jobos apply packet create --job <job-id> --profile <profile-id> [--json]`
- `jobos apply packet show <packet-id> [--json]`
- `jobos apply packet list (--job <job-id> | --profile <profile-id>) [--json]` (both filters may be supplied)
- `jobos apply packet diff <packet-a> <packet-b> [--json]`
- `jobos apply attest-submitted <packet-id> --submitted-at <rfc3339> [--note <text>] [--json]`
- `jobos apply confirm-receipt <packet-id> --reference <text> [--note <text>] [--json]`

Register these domain tool names:
- inspection: `application_packets_list`, `application_packet_show`, `application_packet_diff`
- human mutations: `create_application_packet`, `attest_application_submitted`, `confirm_application_receipt`

MCP/ACP advertise only the three inspection tools. Defense in depth remains in both domain policy and the packet service: explicit `mcp|acp` sources are denied before any generic attestation override is consulted. Inspection tools include receipts through packet show/list and are always redacted.

Migrate existing CLI `applications create|update` dispatch through the existing domain tools instead of direct tracking imports. This is required for the promised single mediation door and the new `receiptBound: false` audit contract.

### Readiness v3 and workflow integration
Bump the public readiness schema from version 2 to version 3. Preserve `blocked | ready-for-review | approved`, all PR 9 local-approval semantics, and all existing policy exclusions. Add an always-present secret-safe field:

```json
"packet": {
  "currentPacketId": null,
  "contentHash": null,
  "attemptNumber": null,
  "revision": null,
  "currency": "none",
  "receiptState": "none",
  "attestable": false,
  "latestReceiptId": null
}
```

When a packet exists, populate those fields from canonical packet/receipt state. `policy.submissionPerformed` remains `false`: it describes JobOS external behavior, not the user’s attestation. `policy.readyDoesNotMean` continues to include `submitted`, `applied`, `receipt-recorded`, and `authorized-for-agent-submission`. Receipt evidence is stated only in `packet.receiptState`.

Avoid recursive hashing: the packet hash projection compiles readiness with packet decoration disabled and excludes application status. `applications plan`, MCP `applications_plan`, `pursue --dry-run`, normal pursue, artifact review refresh, and readiness YAML all expose the same v3 shape. Neither dry nor normal pursue creates a packet.

The existing TUI model may render the new readiness packet summary in the selected-job detail. It must not add packet mutation controls and must inherit the same redaction.

### Workspace mirrors and failure atomicity
Write one redacted packet mirror after successful canonical persistence:

`jobos-workspace/jobs/<jobId>/packets/<packetId>.yaml`

The mirror contains show-equivalent packet data and receipt summaries, never answer values. Refresh that packet mirror after attestation or confirmation because receipts are separate immutable rows while the projection is a current view. Refresh `application-readiness.yaml` and the job projection after packet/receipt/application changes.

Required write order:
1. Acquire the guarded write lock and reload authoritative SQLite.
2. Revalidate readiness, artifact hashes/mirrors, packet currency, source policy, and receipt conflicts.
3. Apply packet/receipt/application/status/audit rows in one DB transaction.
4. Persist SQLite atomically while still protected.
5. Only then write packet/readiness/job mirrors and append audit JSONL from canonical events.
6. On rollback or `stale_snapshot`, clear queued projections. No packet YAML, receipt-bearing readiness YAML, status projection, or audit JSONL may survive without its canonical row.

## OMP-led test-first orchestration

### Gate 0 — critic/advisor authors acceptance first
Before product implementation, invoke an OMP critic/advisor role to translate `tests/apppacket-receipt.acceptance.md` one-for-one into named behavioral tests in `tests/apppacket-receipt.test.js`. The suite may use temporary real sql.js workspaces, the real CLI, domain tools, and MCP framing. It must not mock the packet service, receipt store, policy boundary, hashing, or filesystem projections.

The lead reviews the suite before assigning implementation. A valid initial suite must fail because behavior is absent, not because fixtures are incomplete or assertions contradict this plan. Lock test names and observable assertions. Later correction of a legitimate test defect is allowed only when the test disagrees with this document; weakening a contract to make implementation pass is prohibited.

### Gate 1 — implement against the locked suite
Only after the acceptance suite is authored and reviewed, assign an implementer role. The implementer receives this plan and the acceptance checklist, not provider/model instructions. OMP lead retains ownership of schema/migration, authorization, application-status semantics, shared domain contracts, and integration review.

If work is split, ownership must be disjoint. Suggested boundaries after the test gate:
- canonical schema plus packet/receipt service;
- CLI/domain mediation plus tracking integration;
- readiness/TUI projection integration;
- smoke/docs only after behavioral convergence.

Do not split tightly coupled schema and receipt-transaction decisions across agents. Every handoff must report exact changed symbols, focused command evidence, unresolved failures, and contract risks. OMP lead integrates and runs project-level checks.

## Implementation phases

### Phase 1 — acceptance baseline
- Author every mapped acceptance test first.
- Run `node --test tests/apppacket-receipt.test.js` and record the expected missing-behavior failures.
- Classify fixture/test defects before implementation begins; do not edit contracts opportunistically.

### Phase 2 — canonical packet and receipt spine
Primary implementation areas: `src/db.js`, new `src/packets.js`, and `src/tracking.js`.
- Add schema v8 and migration behavior.
- Implement canonical JSON/hash, redacted answer pinning, packet attempts/revisions, diff, receipt idempotency/conflict, status binding, audit, and post-commit projections.
- Refactor tracking writes for guarded composition without changing existing status vocabulary.
- Prove legacy v7 stores open unchanged and new constraints/indexes exist.

### Phase 3 — mediation and CLI
Primary implementation areas: `src/domain-tools.js`, `src/cli.js`, and MCP/ACP policy tests.
- Register the six domain operations and exact CLI grammar.
- Expose only packet inspection to MCP/ACP.
- Enforce mutation denials before spoofable overrides, with service-level trusted-source validation.
- Route existing application create/update CLI calls through domain tools.

### Phase 4 — readiness and local surfaces
Primary implementation areas: `src/readiness.js`, `src/tui-model.js`/`src/tui.js` only if their current projection requires adjustment, and readiness tests.
- Publish readiness v3 with the always-present packet summary.
- Keep packet hashing recursion-free and preserve PR 9 approval semantics.
- Refresh redacted readiness/packet/job mirrors after committed changes.
- Keep pursue packet-free and TUI changes read-only/minimal.

### Phase 5 — smoke, documentation, and final acceptance
This phase begins only after the focused behavioral suite works.
- Extend `scripts/smoke.js`: approve exact resume/cover revisions, create a packet, attest it, verify `applied` plus `receiptState: attested`, confirm a reference, and verify `receiptState: confirmed` while every action reports no external side effect and no adapter submission.
- Preserve a bare direct-`applied` scenario in focused tests, not as the smoke golden path, to prove backward-compatible unbound tracking.
- Update `README.md` with commands, packet/receipt honesty, direct-status limitation, redaction, and agent mutation denial.
- Update `BUILD_PROGRESS.md` only with observed verification results. Remove packet/receipt spine from deferred gaps; keep auto-apply and adapter receipts deferred.
- No web layer, TUI redesign, export format, adapter, or answer-vault rewrite.

## Verification loop — convergence or three iterations maximum
A complete iteration is:
1. Run `node --test tests/apppacket-receipt.test.js`.
2. Classify every failure as product defect, legitimate test defect, integration regression, or unmet prerequisite.
3. Fix product defects and only legitimate test defects, without weakening any locked observable contract.
4. Review and integrate all role handoffs.
5. Re-run `node --test tests/apppacket-receipt.test.js`.
6. Run `npm test`.
7. Run `npm run smoke`.
8. Record exact pass/fail counts, failing test names/commands, classifications, corrections, and unresolved acceptance failures.

Stop immediately when all three commands pass and no acceptance item remains unresolved. Otherwise begin the next iteration, up to iteration 3. Do not run a fourth iteration under this goal.

Convergence additionally requires direct inspection of the generated packet YAML and audit rows from the smoke workspace to confirm:
- packet and receipt hashes/IDs match SQLite;
- no answer plaintext appears;
- receipt-bound status history names the exact packet/hash/receipt;
- `external_side_effect` is `none`;
- readiness still says `submissionPerformed: false` and exposes user evidence only through `receiptState`;
- MCP/ACP mutation bypass checks pass;
- the race check leaves no half projection.

If iteration 3 does not converge, final output must begin with `not converged` and include exact failing checks, classifications, attempted corrections, affected contracts/files, and the next concrete action. Do not update completion language as if the PR shipped.

## Final acceptance
- A trusted local user can explicitly freeze the exact current approved resume, optional approved cover, redacted answer row versions, target identity, proof IDs, score snapshot, blockers, and warnings.
- Equal packet inputs hash equally; changed approved materials/answers/target state make the old packet stale and produce a new explicit version without erasing history.
- A trusted local user can bind a manual submission attestation and optional confirmation reference to one exact packet; replay is idempotent and conflicting evidence is rejected.
- Application status reaches `applied` through attestation when pre-apply, with an exact receipt-bound status change; direct applied tracking remains possible but provably receipt-unbound.
- Agents can list/show/diff redacted packets and receipts, but cannot freeze, attest, confirm, or forge evidence through MCP/ACP or mediation spoofing.
- Canonical writes, status history, audit rows, readiness, and YAML projections agree after concurrency/failure checks.
- No external action, adapter submission, web/API restoration, TUI redesign, export pipeline, or plaintext answer leakage is introduced.
