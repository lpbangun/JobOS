# JobOS Build Progress

## Current status — 2026-07-20

JobOS now has a data-bound terminal product as its primary local control surface. The CLI remains supported; SQLite is canonical and the terminal, CLI, ACP-session MCP, and external MCP all observe the same workspace state.

### Primary workflows

- `jobos tui --profile <id>` opens the locked 011 pipeline/list/detail/agent shell with real SQLite data, overlays, direct domain actions, and a default-on Hermes ACP guest.
- `jobos daily --profile <id>` runs every saved source, isolates failures, deduplicates, scores, and ranks imported jobs.
- `jobos pursue <job-id> --profile <id>` composes fit scoring, company/stakeholder/contact research, network mapping, application answers, resume and cover-letter drafts, application tracking, outreach path selection, and an outreach draft when a sourced stakeholder is available.
- `jobos applications plan --job <id> --profile <id>` compiles readiness v3 from score, proofs, materials, answers, identity, and packet/receipt state, returning blocked/ready-for-review/approved with actionable blockers and a redacted YAML mirror.
- `jobos apply packet create|list|show|diff ...`, `apply attest-submitted`, and `apply confirm-receipt` freeze exact approved application inputs and record user-supplied submission/receipt evidence without performing an external action.
- `jobos network paths|contacts --job <id>` makes user-owned relationship data and public contact evidence a first-class control surface.
- `jobos agents ...`, `--agent`, and `JOBOS_AGENT` route structured generation through Codex, Hermes, or any registered protocol-compatible executable.
- `jobos browser ...` provides optional private Playwright profiles, cookie/storage-state synchronization, authenticated fetches, and SHA-256-pinned trusted scripts with explicit side-effect gating.

### Implemented in the ACP host and lean CLI passes

- Real ACP v1 client lifecycle for Hermes 0.18.2: initialize, session creation, event streaming, mediated MCP tools, cancellation, timeout/crash typing, redacted stderr, and restart.
- Cancelled or timed-out ACP sessions quarantine later updates and start a clean process/session before the next prompt; raw TUI and ACP drills verify uncontaminated recovery.
- One `domain-tools` facade serves CLI/TUI actions, the ACP session's inward MCP door, and the independent external `jobos mcp` door.
- Data-bound locked 011 terminal shell: priority strip, dense job list, selected detail stack, default-on agent pane, review/log overlays, responsive narrow/empty/failure states, and clean raw-terminal shutdown.
- Scripted real-client evidence: multi-turn ACP cancel/recover/restart/policy/timeout/missing-binary drill and external MCP initialize/list/call/exit drill.
- Concise root help grouped into Setup, Workflows, and Extend; the complete low-level registry remains behind `help --all` and `agent-guide --json`.
- Ashby, public career-page, and bounded VC/startup portfolio discovery in addition to Greenhouse and Lever.
- Hard portfolio caps: 30 companies, 90 requests, 10 seconds per request, and 60 seconds total; partial results retain structured source failures.
- Cron-friendly `daily` and dependency-aware `pursue` workflow orchestration with dry-run, stage selection, elapsed times, result paths/IDs, skip reasons, and recovery guidance.
- Profile/job ownership validation in scoring, tailoring, and pursue.
- Reusable answer bank with normalized matching, employer scoping, status/reuse policy, redacted mirrors, restricted-question blockers, and proof-grounded agent/LLM draft suggestions.
- Warm relationship edges integrated into outreach-plan selection; source-backed warm paths can outrank cold contact routes.
- Generic local-agent registry and protocol with built-in Codex/Hermes manifests, executable checks, strict JSON stdout, 50 KiB output cap, timeout/kill, typed failures, and no silent fallback for explicit agent runtime failures.
- Agent routing across scoring, research, application-question drafting, tailoring, and outreach; generated modes identify `agent` versus `llm`.
- Optional Playwright integration with private permissions, login/auth failure classification, cookie import/export, CAPTCHA detection, script hash verification, and two-key side-effect authorization.
- `sql.js` save hardening with an exclusive lock, optimistic store revision, fsync, same-directory atomic rename, stale-snapshot rejection, and lock cleanup.
- Policy migration from obsolete `human_approval_required` wording to `user_configured`; external effects remain disabled until configured/enabled.
- Explicit `JOBOS_SEARCH_PROVIDER=none` mode for deterministic offline pursuit and research.
- MCP additions: `daily_discovery`, `pursue_job`, `applications_plan`, `answers_match`, and redacted packet list/show/diff inspection. Packet freeze and receipt mutations are not advertised to MCP/ACP and are denied under spoofed overrides.
- README and external agent guide consolidated around the current CLI workflow, extension contracts, safety model, installation, recovery, and intentional limitations.
- Application readiness compiler v3: `applications plan --job <job-id> --profile <profile-id> --json`, MCP `applications_plan`, blocked/ready-for-review/approved statuses, an always-present secret-safe packet summary, actionable blockers, YAML redaction, stable identity keys, precision-first duplicate evidence, and restricted-value safe handling. Integrated into `pursue` dry-run and real execution without automatic packet creation.

- Human review closure: immutable artifact series/revisions with SHA-256 content identity, current-revision queue/diff, trusted CLI/TUI approval or rejection, fail-closed workspace verification, local-only review audit events, readiness `approved` semantics, redraft invalidation, explicit MCP/ACP mutation denials, and no restored web/API bypass.
- Application packet + receipt spine: schema-v8 immutable packet/receipt rows, canonical SHA-256 input and receipt hashes, approved-only exact material pinning, non-secret answer row-version fingerprints, explicit attempt/revision lineage, deterministic packet diff, idempotent replay/conflict rejection, receipt-bound applied status history, confirmation references, guarded post-commit YAML/audit projections, and direct-applied `receiptBound: false` honesty.

### Intentionally deferred

Not required for the smallest coherent CLI product:

- Universal auto-apply, Workday/iCIMS/Taleo automation, or LinkedIn/Indeed DOM-specific bots.
- SMTP auto-send, mailbox reconciliation, and hardcoded platform automation.
- PDF/DOCX production rendering, voice interview coaching, offer/negotiation workspaces, and frontend redesign.
- Agent marketplace/plugin SDK beyond the small executable protocol and MCP surface.

## Verification

- PR 10 converged in iteration 1 after classifying and correcting four integration regressions (readiness v3 expectation, lost policy-context merge, a dropped MCP registry entry, and TUI vertical-layout pressure). Focused packet/receipt acceptance suite: **16/16 passed**; `npm test`: **142/142 passed**.
- `npm run smoke`: passed the extended `ready-for-review` → exact approvals → immutable packet → user attestation → receipt confirmation path. Observed two canonical receipt rows, `receiptState: confirmed`, packet/hash/receipt-bound `applied` history, redacted packet YAML, `submissionPerformed: false`, and `externalSideEffects: none`; the subsequent interview analytics, scheduler, and export flow also completed.
- PR 9 converged after the TUI-focus web-interface cutover: affected artifact/readiness/CLI/TUI/discovery/scheduler checks **53/53 passed**; `npm test` **126/126 passed**. No unresolved acceptance failure remains.
- `npm run smoke`: passed the extended local human-review path (`ready-for-review` → exact resume/cover diffs → local approvals → `approved`) with unchanged application/status state, exactly two approval audit events, and `external_side_effect='none'`; the existing applied/interview analytics, scheduler, and workspace-export flow then completed without the removed web interface.
- Real Hermes ACP drill: six turns across pre-cancel, clean recovery, and explicit restart sessions; 12 tool lifecycle events; null-to-58 state mutation; zero post-cancel leaked events; exact recovery tool completion; policy denial; timeout/missing-binary typing; sentinel redaction.
- Real external MCP drill: initialize, 31-tool list (includes `applications_plan`), `score_job`, `get_job_context`, persisted audit/state, and exit `0`.
- Raw PTY exercises: populated shell, overlay behavior, live tool progress, cancel quarantine, clean-session recovery, exact post-cancel tool completion, missing-backend degradation, narrow layout, honest empty states, and exit `0`.
- Independent Advisor suite `tests/lean-cli-advisor.test.js`: **43/43 passed**; focused contact/outreach suite: **8/8 passed**.
- Principal offline pursuit E2E completed with all stages and artifact/application outputs using `JOBOS_SEARCH_PROVIDER=none`.
- Human-review suite `tests/human-review.test.js`: **6/6 passed**, covering current-only queueing, exact/idempotent/local-only decisions, redraft invalidation, workspace divergence, MCP/ACP denials, optimistic two-store races, and legacy lineage migration. Readiness review transitions, restricted-value redaction, and YAML refresh passed in the focused readiness checks.
- Final raw-terminal review drill: opened the current queue, exact resume r2 with hash/evidence/history, predecessor diff, and approval confirmation; Escape cancelled the first confirmation, the second committed locally, the queue dropped that revision, readiness refreshed to `approved`, the audit overlay showed `artifact.approved (none)`, and uppercase `Q` exited `0`. A post-run CLI check retained application status `interview` with `submissionPerformed: false` and `applicationStatusChanged: false`.

## Prior lean-CLI advisor gate (superseded by the ACP finished-product rubric)

Final independent score: **9.2/10 overall**; **9 of 10** dimensions scored at least 9.

| Dimension | Score |
|---|---:|
| Functionality | 9/10 |
| Integration | 10/10 |
| CLI usability | 9/10 |
| Out-of-box operation | 8/10 |
| Reliability and failure handling | 10/10 |
| PR #4 feature selection | 9/10 |
| Networking | 9/10 |
| Pluggable agents | 10/10 |
| Authenticated browser | 9/10 |
| Clutter elimination | 9/10 |

The sole 8/10 is the deliberate browser-install tradeoff: Playwright and Chromium are optional so `npm install` remains lean; authenticated-browser users run `npm install playwright` and `npx playwright install chromium`.

## ACP finished-product critic gate

Final independent score after two evidence-driven iterations: **87/90 (9.67/10)**. Every major criterion is at least 9/10; Bars A–F, evidence gates, and trust/security gates pass.

| Major criterion | Score |
|---|---:|
| Host/guest boundary | 10/10 |
| Real ACP lifecycle | 10/10 |
| Shared domain tools/state | 10/10 |
| Locked real-data TUI | 9/10 |
| Dual ACP/MCP/CLI door | 10/10 |
| Trust/local-first/security | 10/10 |
| Operations/recovery/responsiveness | 9/10 |
| Regression/artifact/non-skeleton proof | 10/10 |
| Operator reproducibility | 9/10 |

Iteration 1 exposed missing raw evidence and then cancel-stream contamination. Iteration 2 quarantined cancel/timeout updates at send time, restarted the guest before the next prompt, strengthened the fake and real drills, corrected the artifact evidence ID, and finished with no critic findings.

## Known limitations

- No real Chromium binary is installed in this headless environment. Headed login needs a display; headless hosts may import a user-owned Playwright storage-state file.
- Registered browser scripts are trusted, unsandboxed Node.js modules.
- Public research is best-effort and source-grounded; offline mode produces explicit open questions rather than fabricated facts.
- `sql.js` does not merge concurrent writes. A stale writer receives retryable `stale_snapshot` and must reopen/retry.
- Hermes ACP needs configured provider authentication for live conversation; absent/crashed backends leave the JobOS pipeline usable with typed recovery.
- Codex app-server is cataloged as a distinct future adapter, not mislabeled as ACP.
- Generated materials remain reviewable drafts unless a user separately configures an enabled external consumer.
