# OMP execution plan — JobOS PR 8: Human Review Closure

## Role and finish condition
Run this plan as the lead session inside OMP. Branch from `main` only after PR 7 is present. Keep shared contracts and integration under the lead session; use OMP subagents only when slices are genuinely independent.

The verification loop closes at the first of these conditions:
1. The suite converges: the current iteration passes its required focused checks, `npm test`, and `npm run smoke`, with no unresolved acceptance failure.
2. Two complete iterations have run.

Two iterations are a hard maximum, not a minimum. If iteration 2 ends without convergence, close the loop, report exact remaining failures and blockers, and do not claim convergence or completion.

## Product goal
Close the local loop opened by the readiness compiler: a human can see application readiness and blockers, inspect the exact current artifact revision and its diff, and record local approval or rejection. Approval never submits, applies, sends, changes application status, or claims a receipt.

## Non-negotiable contracts
- Preserve `sketches/LOCKED.md`: review/documents remain overlays; do not redesign the shell.
- SQLite is canonical; workspace Markdown/YAML/JSONL are post-commit projections.
- Every new CLI/TUI/MCP/ACP verb enters through `src/domain-tools.js`.
- MCP/ACP can inspect queues/diffs but can never approve or reject, even with `JOBOS_ALLOW_AGENT_ATTESTATION=1` or a spoofed mediation environment.
- Do not add an application `approved` stage. Artifact review and application tracking remain orthogonal.
- A new artifact revision invalidates effective approval of the previous revision without erasing its historical approval.
- No bulk approval, submission, browser apply, receipt capture, or canonical in-place workspace editor in this PR.

## OMP execution orchestration

The lead OMP session owns schema and migration decisions, human-gate policy, shared interfaces, integration, and final acceptance. It may invoke OMP subagents when delegation reduces total work and the slices have no dependency or ownership overlap.

Before dispatch:
- Freeze the shared contract.
- Assign disjoint file and symbol ownership.
- Give each subagent exact acceptance checks.
- Keep migration, data-integrity, authorization, and cross-surface policy decisions with the lead.

Each subagent must return exact changed files and symbols, decisions, focused verification evidence, and unresolved risks or ownership conflicts. The lead reviews and integrates every handoff and runs project-level checks once per loop iteration. Do not add OMP orchestration, subagent selection logic, or harness configuration to JobOS product code or runtime.

## Frozen architecture contracts

### Artifact series and revisions
Add a stable `series_key`; `(job_id, profile_id, type)` alone is invalid because it would merge unrelated outreach, interview, and scheduled drafts.

Series identities:
- Resume: job + profile + `resume`.
- Cover letter: job + profile + `cover_letter`.
- Outreach: job + profile + stakeholder + goal.
- Interview prep: application + normalized stage.
- Scheduler/follow-up or unknown types: stable canonical path/producer identity; ambiguous legacy rows become separate series rather than falsely superseding each other.

Add `revision`, `series_key`, `supersedes_artifact_id`, `content_hash`, `reviewed_at`, `reviewed_by`, and `review_note`. Enforce `UNIQUE(series_key, revision)` and predecessor integrity in service validation/indexes. Persist only `draft_needs_human_review`, `approved`, or `rejected`. Derive `current|superseded`; a superseded approved revision is effectively stale but remains historically approved.

All artifact producers must use one `src/artifacts.js` service with named-column inserts: tailoring, outreach, interview prep, and scheduler actions. No positional `INSERT INTO artifacts VALUES (...)` remains.

### Review transitions
- Only the current revision can be reviewed.
- Draft may become approved or rejected.
- Repeat approval of the same current approved revision is idempotent and creates no duplicate event.
- Rejected revisions require a new draft; do not flip them to approved.
- Approval verifies current revision, content hash, and workspace-mirror integrity.
- A divergent mirror fails with a typed recovery error; do not approve ambiguous content.

### Readiness v2
Bump the public readiness plan to version 2 because the status enum expands.
- Any completeness blocker -> `blocked`.
- No blockers plus any required current reviewable material -> `ready-for-review`.
- No blockers plus approved current resume and every present non-rejected current cover approved -> `approved`.
- Rejected current resume remains blocked.
- Missing cover remains a warning; rejected optional cover is excluded with a warning.
- `readyForReview` is true for both non-blocked states.
- `localApprovalComplete` is true only for `approved`.
- Policy exclusions always include submitted/applied/receipt-recorded/authorized-for-agent-submission and must not contradict an `approved` local state.

### Trusted mediation
CLI and TUI are the only trusted human review sources. MCP source classification must be hardcoded to `mcp` or `acp`; never trust `JOBOS_MEDIATION=cli|tui`. Deny `approve_artifact` and `reject_artifact` before any attestation override. Remove or deny the direct unauthenticated artifact-approval PATCH in `src/api.js` unless a genuine trusted human web-confirmation flow is added through the same service; for PR 8, prefer disabling that bypass and its web control.

### Failure atomicity
Approval must not emit a false audit/mirror projection if optimistic save fails:
1. Acquire the guarded write path and reload authoritative state.
2. Validate current revision and hashes.
3. Apply review mutation and canonical audit row in one DB transaction.
4. Persist SQLite atomically while still protected.
5. Only after persistence succeeds, append/regenerate audit JSONL, artifact mirrors, and readiness YAML from canonical state.
6. On `stale_snapshot`, emit no approval JSONL and no approved YAML projection.

The actionable review queue contains only current pending revisions. History remains available in documents/diff. Regenerate readiness after both resume/cover creation and review decisions so redrafting cannot leave an approved YAML mirror behind.

## Phase 0 — Freeze contracts and establish the test baseline

Lead:
- Confirm main contains PR 7 and inspect current schema, artifact producers, policy boundaries, TUI overlays, API bypass, and existing tests.
- Freeze the series-key rules, review transition table, readiness v2 shape, error codes, and JSON contracts before implementation.
- Establish failing behavioral coverage for migration/lineage, approval policy, readiness transitions, concurrency, TUI behavior, and smoke deltas.
- Delegate independent test or implementation slices through OMP only after ownership is disjoint.

## Phase 1 — Canonical artifact service and migration
Files:
- `src/db.js`
- new `src/artifacts.js`
- `src/tailoring.js`
- `src/outreach.js`
- `src/interview.js`
- `src/scheduler/actions.js`

Work:
- Bump schema version and add/backfill revision fields.
- Backfill deterministic series using canonical producer/path data; preserve ambiguous legacy rows separately.
- Add current/history lookup, revision creation, public projection, mirror integrity, line diff, approve, and reject.
- Replace every positional artifact insert with the named-column service.
- Make canonical save precede filesystem projections.
- Add the failure-atomic audit/projection path required above.

Proof:
- Focused migration/artifact tests, including all producers and two-store race.

## Phase 2 — Shared surfaces and hard policy boundary
Files:
- `src/domain-tools.js`
- `src/cli.js`
- `src/mcp.js`
- `src/api.js`
- `src/web.js` if it exposes the unsafe PATCH control
- affected API/MCP tests

Domain tools:
- Enrich existing `review_queue` with current revision, hash, evidence/warning counts, and job/profile metadata.
- Add `diff_artifact`.
- Add human-only `approve_artifact` and `reject_artifact`.

CLI:
- `jobos artifacts queue [--profile <id>] [--job <id>] [--json]`
- `jobos artifacts diff <artifact-id> [--against <artifact-id>] [--json]`
- `jobos artifacts approve <artifact-id> [--note <text>] [--json]`
- `jobos artifacts reject <artifact-id> --note <reason> [--json]`

Policy:
- CLI/TUI use trusted internal source labels.
- MCP/ACP expose inspect/diff but return typed human-review denial for approve/reject.
- Denial survives `JOBOS_ALLOW_AGENT_ATTESTATION=1` and `JOBOS_MEDIATION=cli`.
- Direct HTTP approval mutation is denied/removed; update existing API tests and controls.

All mutation output states local-only, `externalSideEffects: none`, `submissionPerformed: false`, and `applicationStatusChanged: false`.

## Phase 3 — Readiness and pursue integration
Files:
- `src/readiness.js`
- `src/workflows.js`
- readiness tests and mirror fixtures

Work:
- Implement readiness version 2 and the frozen transition table.
- Material states distinguish reviewable draft, approved, and rejected.
- Add `review` summary, required/approved/pending/rejected IDs, and `localApprovalComplete`.
- Keep application tracking status orthogonal; approval never changes it.
- `applications plan`, MCP `applications_plan`, `pursue --dry-run`, and normal pursue return the same richer readiness structure.
- Refresh readiness YAML after artifact creation and review decisions.

Proof:
- blocked -> ready-for-review -> approved;
- approved -> redraft -> ready-for-review immediately in JSON, queue, and YAML;
- dry-run remains pure;
- no submission/receipt claim.

## Phase 4 — Locked TUI completion
Files:
- `src/tui-model.js`
- `src/tui.js`
- `tests/tui-acp.test.js`

Work:
- Add selected-job readiness block and readiness-first next action.
- Show revision/approval state in artifacts and stage strip.
- Add readiness/policy summary to secret-safe ACP selected-job context and visible agent next action.
- Review queue uses current revisions and opens the exact selected artifact by ID.
- Documents show content hash, evidence, warnings, history/diff.
- `D` toggles diff; `A` begins approval confirmation; `X` begins rejection confirmation; `y` commits; `n`/Esc cancels.
- Refresh queue, header count, detail, readiness, and audit log after decision.
- Preserve agent-default-on, Escape, overlay, narrow terminal, and navigation behavior.

## Verification loop — convergence or two iterations maximum

A complete iteration is:
1. Run the focused PR 8 behavioral suite against the current implementation.
2. Classify each failure as a product defect, test defect, integration issue, or unmet prerequisite.
3. Correct legitimate product and test defects without weakening the observable contract.
4. Review and integrate all subagent handoffs.
5. Run the focused PR 8 suite, `npm test`, and `npm run smoke`.
6. Record exact results and unresolved acceptance failures.

Stop immediately when the suite converges. If it does not converge in iteration 1, run one second and final iteration. Close the loop after iteration 2 regardless of outcome.

Convergence means:
- Focused artifact, readiness, policy, API, and TUI checks pass.
- `npm test` passes.
- `npm run smoke` passes.
- No unresolved acceptance failure remains.
- MCP/ACP and direct HTTP approval bypass tests pass.
- Redraft invalidation and optimistic-race checks pass.
- Approval causes no application-status or external-side-effect mutation.

If iteration 2 is not converged, the final result must be explicitly `not converged` and list the failing checks, affected files/contracts, attempted corrections, and next action. Do not relabel the capped loop as successful completion.

## Phase 5 — Smoke, docs, and final acceptance
Do not defer test creation here; only final documentation/cleanup occurs after convergence.

Smoke scenario:
- Generate application artifacts and reach `ready-for-review`.
- Snapshot application/status/audit state.
- Diff and approve current resume/cover.
- Assert readiness becomes `approved`, zero approval-caused application/status changes, and audit side effect is none.
- Continue the existing unrelated `applied`/`interview` analytics scenario afterward; do not globally assert that smoke never contains an applied status.

Update:
- `scripts/smoke.js`
- `README.md`
- `BUILD_PROGRESS.md`

Final commands:
- focused PR 8 behavioral tests;
- `npm test`;
- `npm run smoke`;
- `npm run jobos -- tui --profile <fixture-profile> --agent off --snapshot --width 140 --height 42`;
- one raw-terminal flow: review queue -> exact document -> diff -> cancel confirmation -> approve -> refreshed queue/readiness/log.

## Final acceptance
- Human can see readiness/blockers and approve or reject an exact current revision through CLI/TUI.
- Agent can inspect queue/diff and recommend a human action but cannot decide it through MCP/ACP or HTTP bypass.
- Audit distinguishes created, approved, and rejected with no external side effect.
- Redrafting makes prior approval effectively stale and returns the current packet to `ready-for-review`.
- Readiness `approved` means only locally human-reviewed completeness.
- No submission, apply, send, application-status mutation, receipt, or external-action claim is introduced.
