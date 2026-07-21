# PR 10 application packet + receipt acceptance contract

This checklist is locked to `docs/pr10-apppacket-receipt-spine-plan.md`. An OMP critic/advisor authors `tests/apppacket-receipt.test.js` before product implementation. Each acceptance ID below maps to exactly one `test()` with the exact title shown. Keep the ID in the test title so failures map back without interpretation.

Use real temporary JobOS workspaces, sql.js persistence, the real domain facade, real CLI subprocesses where CLI behavior is asserted, and real YAML/audit projections. Do not mock packet/receipt services, hashing, policy enforcement, persistence, or filesystem projection. Helpers may seed profiles, proofs, jobs, answers, approved artifact revisions, and legacy databases.

## One-to-one acceptance map

### AP01 — identity validation
**Test title:** `AP01 packet create rejects unknown identities and profile-job mismatch with typed errors`

- Unknown job returns `unknown_job`.
- Unknown profile returns `unknown_profile`.
- A real job paired with another real profile returns `profile_job_mismatch`.
- Each failure exits non-zero through CLI JSON and creates no application, packet, receipt, audit event, status change, or packet YAML.

### AP02 — approved-only freeze gate
**Test title:** `AP02 packet create requires approved local readiness and exact artifact integrity`

- Blocked readiness returns `packet_not_ready` with blocker codes and no writes.
- Compile-clean `ready-for-review` with a current unapproved resume returns `artifact_unapproved`; this PR has no bypass flag.
- Approved readiness succeeds only while the current approved resume and optional approved cover match both canonical content hashes and workspace mirrors.
- A divergent/missing artifact mirror returns the existing typed integrity error and creates no packet.

### AP03 — exact redacted snapshot and tracking initialization
**Test title:** `AP03 packet freezes exact approved materials answers target and initializes missing tracking only`

- Creating from an approved job/profile with no application atomically creates one `materials-ready` application and one packet linked to it.
- If an application already exists, packet creation does not alter its status, notes, confirmation URL, or pre-existing status history.
- Packet fields pin the current resume artifact ID/hash; pin the approved cover ID/hash when present; and snapshot target identity keys, title/company/location, sorted proof IDs, score, readiness version 3, blockers, and warnings.
- Answer entries contain answer ID, question fingerprint, metadata row fingerprint, sensitivity, reuse scope, verification status, and response mode only. No answer value or full answer plaintext is present.
- Packet response reports `externalSideEffects: 'none'` and `submissionPerformed: false`.

### AP04 — canonical hash and create idempotency
**Test title:** `AP04 canonical packet hash is stable and identical create is idempotent`

- Independently canonicalized equal inputs produce the same full lowercase SHA-256 even when source object key insertion order differs.
- Repeating packet create with unchanged current inputs returns the same packet ID/hash with `idempotent: true`.
- The replay creates no second packet row, audit row, status change, task, or YAML file.
- Volatile timestamps, application status/notes, receipt state, packet attempt/revision, and readiness generation time do not affect `content_hash`.

### AP05 — revision attempt and diff history
**Test title:** `AP05 packet versions preserve revision attempt lineage and deterministic diff`

- Before attestation, approving a new resume revision and explicitly creating again keeps the attempt number, increments packet revision, points `supersedesPacketId` to the prior packet, and changes `contentHash`.
- After an attestation, a later explicit packet create starts the next attempt at revision 1 and retains historical lineage.
- Prior packet rows and their YAML remain inspectable and unchanged.
- Diff returns deterministic JSON-pointer changes and `sameContent: false`; it exposes IDs/hashes/redacted metadata but no artifact or answer plaintext.

### AP06 — stale packet invalidation
**Test title:** `AP06 material answer or target changes make an old packet non-attestable`

- A new current resume draft immediately makes the old packet stale, including before that draft is approved.
- A new/changed cover state, an answer row update, or target identity input change also changes the recomputed canonical projection.
- `attest-submitted` on the old packet returns `packet_stale` with secret-safe changed paths.
- No receipt, application status update, status change, audit event, or receipt-bearing projection is written.
- After the new required material is approved, explicit create yields the next packet version; no edit auto-creates one.

### AP07 — trusted CLI attestation and status binding
**Test title:** `AP07 CLI attestation creates one receipt and binds pre-apply status to the exact packet`

- `jobos apply attest-submitted <packet> --submitted-at <timezone-qualified-rfc3339> --note <text> --json` succeeds and normalizes time to UTC ISO-8601.
- It inserts one `user_attestation` receipt linked to the packet/application and one `application.submission_attested` canonical audit row.
- From each pre-apply status (`saved`, `researching`, `materials-ready`), it advances to `applied` and adds exactly one status change whose note includes packet ID, packet hash, and receipt ID.
- From `applied` or a later/outcome status, it records the receipt without status regression or another status change.
- Response/audit state `receiptBound: true`, `externalSideEffects: 'none'`, `submissionPerformed: false`, and the accurate `applicationStatusChanged` value.
- Invalid or timezone-less time returns `invalid_submitted_at` and writes nothing.

### AP08 — MCP/ACP mutation denial
**Test title:** `AP08 MCP and ACP can inspect but cannot freeze attest or confirm under spoofed overrides`

- MCP and ACP tool registries expose packet list/show/diff inspection and do not advertise create/attest/confirm mutations.
- Direct domain calls for `create_application_packet`, `attest_application_submitted`, and `confirm_application_receipt` with source `mcp` or `acp` fail with `human_packet_freeze_required` or `human_submission_attestation_required` as applicable.
- Denial survives `JOBOS_MEDIATION=cli`, `JOBOS_ALLOW_AGENT_ATTESTATION=1`, and `allowExternalAttestation: true`.
- Service-level calls with untrusted source also fail, so bypassing the facade cannot forge evidence.
- No canonical or projected state changes.

### AP09 — receipt replay and conflict
**Test title:** `AP09 exact receipt replay is idempotent and conflicting immutable evidence is rejected`

- Repeating the exact attestation, including normalized time and note, returns the original receipt with `idempotent: true`.
- Replay creates no duplicate receipt, audit row, status change, or projection append.
- Changing submitted time or note for the same packet/type returns `receipt_conflict`.
- The original receipt hash/content remains unchanged.

### AP10 — confirmation requires attestation
**Test title:** `AP10 confirmation requires prior attestation and records reference without status mutation`

- Confirm before attestation returns `receipt_attestation_required`; empty reference returns `receipt_reference_required`.
- After attestation, `confirm-receipt` inserts one `imported_evidence` receipt using the attested submitted time and returns `receiptState: confirmed`.
- Exact replay is idempotent; a different reference or note conflicts.
- Confirmation never changes application status or adds a status change.
- An absolute HTTP(S) reference populates `confirmation_url`; a non-URL external reference remains only in the receipt.
- Audit and response still report no external side effect and no JobOS-performed submission.

### AP11 — direct applied status remains receipt-unbound
**Test title:** `AP11 bare application applied update creates no receipt and remains explicitly unbound`

- Existing `applications create|update --status applied` CLI behavior remains accepted.
- The command is mediated through `callDomainTool` and inserts no packet or receipt.
- Its canonical audit payload includes `receiptBound: false` and no receipt ID/hash.
- Readiness v3 packet summary reports `receiptState: none` even when application status is `applied`.
- A later valid manual attestation may bind a receipt without adding a redundant applied status change.

### AP12 — redaction across every projection
**Test title:** `AP12 restricted and sensitive answer plaintext never crosses packet inspection surfaces`

- Seed unique sentinel values in public, personal, sensitive, and restricted answer rows used by readiness.
- Assert none of those values appears in packet table JSON columns, hash projection serialization, receipt/audit payloads, CLI create/list/show/diff JSON or text, MCP/ACP list/show/diff results, TUI selected-job model, packet YAML, readiness YAML, job YAML, or audit JSONL.
- Assert IDs, sensitivity classes, row fingerprints, and `direct_input_redacted`/`auto_fill` response modes remain available for inspection.
- Packet and receipt hashes alone are not treated as plaintext evidence; no value-derived hash is persisted for restricted/sensitive answers.

### AP13 — guarded two-store and concurrent create atomicity
**Test title:** `AP13 concurrent packet writers converge and stale persistence leaves no half projection`

- Two real writers racing to create the same unchanged packet converge on one canonical packet row/hash and one packet YAML; neither produces duplicate audit/status/task state.
- A stale sql.js store that queues a packet-like projection and loses the store revision race receives `stale_snapshot`; its queued YAML/audit projection does not exist afterward.
- A failed/conflicting receipt write leaves application status, status history, receipts, readiness YAML, packet YAML receipt summary, and audit JSONL mutually consistent with canonical SQLite.

### AP14 — readiness v3 honesty and pursue purity
**Test title:** `AP14 readiness v3 reports packet receipt state without claiming adapter submission`

- Before packet creation, readiness has version 3 and the all-null/`none` packet summary.
- After create, attest, and confirm, `applications plan`, MCP `applications_plan`, readiness YAML, `pursue --dry-run`, and normal pursue agree on current packet ID/hash/currency and `none -> attested -> confirmed` receipt state.
- `policy.submissionPerformed` is always false, `externalSideEffects` remains none, and `readyDoesNotMean` retains submitted/applied/receipt-recorded/authorized-for-agent-submission.
- Neither dry-run nor normal pursue auto-creates a packet or receipt.

### AP15 — CLI list show diff and typed failures
**Test title:** `AP15 packet CLI list show and diff are filterable parseable historical and typed`

- List requires at least `--job` or `--profile`; no filter returns non-zero `packet_list_filter_required`.
- Job/profile filters work separately and together and cannot leak another profile’s packets.
- Show includes historical packets, derived currency/receipt state, secret-safe receipts, and immutable hashes.
- Diff accepts two packet IDs and returns stable machine JSON; text mode is human-readable and redacted.
- Unknown packet IDs return non-zero `unknown_packet` in show, diff, attest, and confirm paths.
- Root/command help and agent guide list the exact six CLI commands and three inspection domain tools.

### AP16 — end-to-end receipt spine
**Test title:** `AP16 approved materials freeze attest confirm end to end with honest local evidence`

Using only real CLI commands in a temporary workspace:
1. Create profile/proofs/job, score it, prepare all ordinary/restricted answers, and tailor resume/cover.
2. Approve the exact current artifact revisions and observe readiness `approved` with no packet.
3. Create a packet; verify exact artifact hashes and redacted YAML.
4. Attest submission; verify application `applied`, one bound receipt/status change, and readiness `receiptState: attested`.
5. Confirm an external reference; verify `receiptState: confirmed` and unchanged applied status.
6. Verify list/show/diff inspection, audit `external_side_effect='none'`, `submissionPerformed: false`, no agent mutation route, and no answer plaintext in the workspace.

The later smoke update must exercise the same golden path, but AP16 remains a focused `test()` authored before implementation.

## Critic/advisor suite lock
Before handing the suite to an implementer, the OMP lead must verify:
- all 16 exact titles exist once;
- every case fails for absent product behavior rather than a broken fixture;
- no assertion accepts draft/unapproved packets, agent attestation, invented receipt state, answer plaintext, pre-commit projection, or status regression;
- no test replaces persistence, hashing, policy, or projections with mocks;
- existing PR 9 approval/readiness contracts are reused rather than duplicated with a second convention.

During iterations, test changes require an explicit classification as a legitimate test defect against the locked plan. A test may be corrected for fixture, syntax, timing, or an assertion that contradicts the plan. It may not be relaxed merely because implementation differs.

## Required commands per iteration
1. `node --test tests/apppacket-receipt.test.js`
2. `npm test`
3. `npm run smoke`

Stop on the first iteration where all three pass and all 16 cases are satisfied. Iteration 3 is the absolute cap. If any case or command still fails after iteration 3, report `not converged` with exact failing test titles/commands and do not claim completion.
