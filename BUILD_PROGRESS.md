# JobOS Build Progress

## Current status — 2026-07-23

JobOS now has a data-bound terminal product as its primary local control surface. The CLI remains supported; SQLite is canonical and the terminal, CLI, ACP-session MCP, and external MCP all observe the same workspace state.

### Primary workflows

- `jobos tui --profile <id>` opens the locked 011 pipeline/list/detail/agent shell with real SQLite data, overlays, direct domain actions, and a default-on Hermes ACP guest.
- `jobos daily --profile <id>` runs every saved source, isolates failures, deduplicates, scores, and ranks imported jobs.
- `jobos pursue <job-id> --profile <id>` composes fit scoring, company and durable people research, application answers, resume and cover-letter drafts, application tracking, outreach path selection, and a review-gated outreach draft when an approved sourced path is available. Full reachable-network mapping remains available through the standalone `network paths` operation.
- `jobos applications plan --job <id> --profile <id>` compiles readiness v4: artifact review produces `materials-ready`; only a current inspected employer form with resolved required bindings produces `form-ready`. Blockers and mirrors remain secret-safe.
- `jobos network paths|contacts --job <id>` makes user-owned relationship data and public contact evidence a first-class control surface.
- `jobos research people --scope profile|target|job|person ...` runs budgeted, checkpointed people research; `research runs get|resume|cancel` exposes the durable lifecycle.
- `jobos profile network-intent ...` and the TUI `b` flow confirm progressive networking goals, exclusions, sources, and affiliations before an open profile network map is built.
- `jobos agents ...`, `--agent`, and `JOBOS_AGENT` route structured generation through Codex, Hermes, or any registered protocol-compatible executable.
- `jobos browser ...` provides optional private Playwright profiles, cookie/storage-state synchronization, authenticated fetches, and SHA-256-pinned trusted scripts with explicit side-effect gating.
- `jobos apply form inspect|show|assist|checkpoint|submit` provides the narrow packet-bound live-form bridge. Inspection is read-only; fill and configured submit have separate default-off configuration and per-invocation gates; manual submission/attestation remains first-class.

### Implemented in the ACP host, lean CLI, and people-research passes

- Real ACP v1 client lifecycle for Hermes 0.18.2: initialize, session creation, event streaming, mediated MCP tools, cancellation, timeout/crash typing, redacted stderr, and restart.
- Cancelled or timed-out ACP sessions quarantine later updates and start a clean process/session before the next prompt; raw TUI and ACP drills verify uncontaminated recovery.
- One `domain-tools` facade serves CLI/TUI actions, the ACP session's inward MCP door, and the independent external `jobos mcp` door.
- Data-bound locked 011 terminal shell: priority strip, dense job list, selected detail stack, default-on agent pane, human-gated review/discovery/stage actions, responsive artifact documents, and clean raw-terminal shutdown.
- Artifact review lifecycle: sanitized Markdown/diffs, selected-artifact evidence, predecessor-aware versions, workspace-confined `$VISUAL`/`$EDITOR` round-trips, auditable approve/reject/draft decisions, and input-safe agent-created artifact auto-open.
- Scripted real-client evidence: multi-turn ACP cancel/recover/restart/policy/timeout/missing-binary drill and external MCP initialize/list/call/exit drill.
- Concise root help grouped into Setup, Workflows, and Extend; the complete low-level registry remains behind `help --all` and `agent-guide --json`.
- Overlap cleanup: discovery and application statuses are explicitly namespaced with no generic cross-namespace agent field; task inbox and true-due semantics are separate and filterable in CLI/TUI, with outreach due as an enriched view of the canonical task query; company watch targets are canonical executable saved searches with explicit legacy migration; raw discovery is distinguished from `daily`; TUI packet/receipt commands use one documented vocabulary; and bounded loop commands are classified as agent-stream primitives.
- Ashby, public career-page, and bounded VC/startup portfolio discovery in addition to Greenhouse and Lever.
- Hard portfolio caps: 30 companies, 90 requests, 10 seconds per request, and 60 seconds total; partial results retain structured source failures.
- Discovery-integrity cutover: one shared retry/redirect/liveness budget per saved-search run; bounded `429`/`503` and `Retry-After` recovery; per-result liveness/import/score isolation; durable `succeeded`/`partial`/`failed` reduction through daily and scheduler records; structured native compensation/work-model/employment/department persistence; normalized recency/remote/type filters; 24-hour posting-liveness freshness; expired score/pursuit hard stops; uncertain warnings; and a separate `jobos.posting-liveness.v1` handoff that does not alter fit math.
- Cron-friendly `daily` and dependency-aware `pursue` workflow orchestration with dry-run, stage selection, elapsed times, result paths/IDs, skip reasons, and recovery guidance. Schedules follow standard Unix-cron semantics: when both day-of-month and day-of-week are restricted, either matching fires (OR).
- Profile/job ownership validation in scoring, tailoring, and pursue.
- Reusable answer bank with normalized matching, employer scoping, status/reuse policy, redacted mirrors, restricted-question blockers, and proof-grounded agent/LLM draft suggestions.
- Warm relationship edges integrated into outreach-plan selection; source-backed warm paths can outrank cold contact routes.
- W05 contact/outreach cutover: `ContactConfidenceV2` separates source ownership, company-domain alignment, pattern, DNS, optional SMTP, catch-all, freshness, approval, and suppression; raw observations remain immutable and unrelated-domain, stale, catch-all, unapproved, or suppressed contacts cannot be promoted into misleading readiness. Shared role classification drives distinct evidence-grounded recruiter, manager, peer, executive/founder, advisor/expert, and unknown-role drafts.
- Append-only `jobos.outreach-outcome.v1` observations support profile-scoped replies, meetings, explicit no-response windows, bounces, declines, idempotent references, and correction/supersession history. Weekly review exposes observed counts, denominators, periods, missing outcomes, and insufficient-data states without probabilities or causal attribution; W06 next-action policy and W08 learning remain explicit downstream handoffs.
- Generic local-agent registry and protocol with built-in Codex/Hermes manifests, executable checks, strict JSON stdout, 50 KiB output cap, timeout/kill, typed failures, and no silent fallback for explicit agent runtime failures.
- Agent routing across scoring, research, application-question drafting, tailoring, and outreach; generated modes identify `agent` versus `llm`.
- Optional Playwright integration with private permissions, login/auth failure classification, cookie import/export, CAPTCHA detection, script hash verification, and two-key side-effect authorization.
- `sql.js` save hardening with an exclusive lock, optimistic store revision, fsync, same-directory atomic rename, stale-snapshot rejection, and lock cleanup.
- Policy migration from obsolete `human_approval_required` wording to `user_configured`; external effects remain disabled until configured/enabled.
- Explicit `JOBOS_SEARCH_PROVIDER=none` mode for deterministic offline pursuit and research.
- MCP additions: `daily_discovery`, `pursue_job`, `applications_plan`, `answers_match`, and redacted packet list/show/diff inspection. Always-denied human mutations are omitted from the MCP catalog and remain denied at the service boundary.
- MCP stdio framing keeps one active request, pauses input, bounds headers/bodies, rejects oversized or incomplete frames, and closes atomically after the running request while dropping buffered work.
- The obsolete, unmounted HTTP API implementation is removed; CLI/TUI and MCP remain the supported human and agent surfaces.
- README and external agent guide consolidated around the current CLI workflow, extension contracts, safety model, installation, recovery, and intentional limitations.
- Live-form/packet bridge: deterministic semantic form and adapter fingerprints; main/iframe inspection; restricted/legal/unsupported human ownership; exact W01 identity/material and answer-row bindings; readiness v4; packet v2; fill/read-back without persisted values; trusted checkpoints; replay-safe configured submission; honest uncertain outcomes; and bound adapter/manual receipt evidence across CLI, TUI, MCP, and ACP mediation.
- Live-form hardening: exact targets are encrypted under a workspace-private key while public snapshots remain query-secret-safe; Chromium routing pins public DNS, freezes main-frame origin, blocks service workers/WebSockets, and seals before persistence; structural locators use absolute selected-form ordinals; validated confirmations outrank generic login-URL heuristics.
- Canonical `people`, profile/person affiliations, durable `research_runs`, and run-source joins with an idempotent migration that preserves contact, edge, stakeholder, and outreach-plan references.
- Identity resolution by canonical profile URL and then exact imported email; same-name records never merge automatically.
- User-exported LinkedIn connection import with tier `U` unapproved contacts, idempotent direct edges, skipped-row warnings, local mirrors, and privacy-safe audit metadata.
- Fixed LangGraph orchestration for profile, target, job, and person scopes with isolated adapters, standard/deep budgets, checkpoints, retryable resume, terminal cancellation, partial results, source caching, and internal deadline handling.
- Local-network, LinkedIn-import, public-web, GitHub, GDELT, and Wayback adapters use injectable fetch/DNS boundaries. Public LinkedIn URLs are record-only and never fetched.
- Optional xAI X Search is off by default and requires environment enablement, profile consent, and a user API key. Only citation-backed X evidence persists; usage and configured cost estimates are recorded.
- People research is integrated into pursuit, deterministic network-access scoring, application-status launch recommendations, CLI/TUI controls, ACP-session MCP, and external MCP. The obsolete `discover_contacts` tool/export is removed.
- Human gates remain authoritative: research never sends outreach or applies, imports remain unapproved, MCP cannot approve contacts for an agent, and suppressed contacts are unusable.

### Intentionally deferred

Not required for the smallest coherent CLI product:

- Universal auto-apply, Workday/iCIMS/Taleo automation, or LinkedIn/Indeed DOM-specific bots.
- SMTP auto-send, mailbox reconciliation, and hardcoded platform automation.
- Additional document export formats, voice interview coaching, offer/negotiation workspaces, and frontend redesign.
- Agent marketplace/plugin SDK beyond the small executable protocol and MCP surface.

## Verification
- `npm test`: **368/368 passed** on 2026-07-23 after live-form/browser/MCP hardening, including private exact-target migration, public snapshot privacy, pinned protected routing, locator alignment, confirmed login-shaped outcomes, catch-all exact-contact handling, and leadership LaTeX semantics.
- `npm test`: **265/265 passed** on 2026-07-22, including discovery-integrity retry/budget/isolation/liveness/gate contracts, status-namespace, canonical outreach-due semantics, MCP catalog, removed-API, workflow-help and TUI-command vocabulary, watchlist consolidation, CLI compatibility, and all established CLI, TUI, ACP, MCP, readiness, research, outreach, and workflow checks.
- `npm run smoke` and `npm run smoke:live-form`: passed on 2026-07-23. The general clean-workspace smoke reaches materials-ready → form-ready → packet/manual receipt confirmation; the real Chromium live-form smoke proves one-submit manual (`externalSideEffects: none`) and configured (`user_configured_form_submission`) paths.
- W05 targeted acceptance: **52/52 passed** on 2026-07-23 across confidence, migration, role-aware outreach, append-only outcomes, weekly review, CLI/domain tools, W01 proof grounding, W03 source integrity, and post-review safety corrections.
- `npm run smoke`: passed on 2026-07-23 in a clean temporary workspace through fixture-backed active/expired/uncertain discovery, expired score/pursuit hard stops, scoring, tailoring, application readiness, packet/receipt confirmation, interview, analytics, scheduler, workspace exports, and zero external effects.
- Real Hermes ACP drill: six turns across pre-cancel, clean recovery, and explicit restart sessions; 12 tool lifecycle events; null-to-58 state mutation; zero post-cancel leaked events; exact recovery tool completion; policy denial; timeout/missing-binary typing; sentinel redaction.
- External MCP catalog now exposes 41 policy-eligible tools, including secret-safe form inspection and separately gated fill/configured-submit operations. Eight always-denied human mutations—including the form checkpoint—are omitted and still rejected at the service boundary.
- Raw PTY exercises: populated shell, overlay behavior, live tool progress, cancel quarantine, clean-session recovery, exact post-cancel tool completion, missing-backend degradation, narrow layout, honest empty states, and exit `0`.
- People-research critic suite `tests/people-research-orchestration.test.js`: **14/14 passed**; companion contact/TUI/integration suites: **25/25 passed**.
- Application readiness suite `tests/readiness.test.js`: **16/16 passed** covering readiness v4 shape, materials-ready/form-ready transitions, exact review and live-form authority, redaction/job scoping, CLI/MCP equivalence, mirror integrity, duplicate evidence, dry-run purity, packet/receipt next actions, and no false submission claims.
- Principal offline pursuit E2E completed with all stages and artifact/application outputs using `JOBOS_SEARCH_PROVIDER=none`.
- Independent people-research convergence gate passed on critic pass 3 with no failures or unmet criteria. It covers migration and identity, onboarding/import privacy, all four scopes, adapter isolation, budgets, cache/resume/cancel/deadline behavior, xAI gates/citations, integrated alumni path ranking, deterministic network-access bands, status launch recommendations, MCP/TUI mediation, exact mirrors, and zero external effects.
- W03 discovery-integrity critic convergence: iteration 1 found truncation-only status and missing shared run-budget defects; targeted corrections passed the combined W03 suite **25/25**, and iteration 2 returned `CONVERGED` with no residual findings.
- W02 live-form bridge critic convergence: iteration 1 found legacy CHECK migration, snapshot-ID hashing, restricted-sensitivity auto-fill, file re-hash, uncertain-result, and packet-diff defects; all were corrected with targeted acceptance evidence, and iteration 2 returned `accept` / `ready_for_merge: true` with no remaining blocker or high-severity finding.

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

The 2026-07-20 artifact-review convergence used a critic-authored T1–T13 red suite and three independent critic passes. Iteration 1 found editor teardown, terminal-sanitization, stage-audit, and job-scoping defects. Iteration 2 found remaining editor TTY ownership during refresh/resize. Iteration 3 confirmed all blockers fixed and approved full verification.

## Known limitations

- No real Chromium binary is installed in this headless environment. Headed login needs a display; headless hosts may import a user-owned Playwright storage-state file.
- Registered browser scripts are trusted, unsandboxed Node.js modules.
- Public research is best-effort and source-grounded; offline mode produces explicit open questions rather than fabricated facts.
- Optional xAI research uses the user's key and provider billing. It remains disabled without all consent/configuration gates, and dollar caps require user-supplied current pricing metadata.
- Public LinkedIn URLs are record-only. JobOS does not fetch profile pages or authenticate to LinkedIn; connection data comes only from a user-exported local CSV.
- `sql.js` does not merge concurrent writes. A stale writer receives retryable `stale_snapshot` and must reopen/retry.
- Hermes ACP needs configured provider authentication for live conversation; absent/crashed backends leave the JobOS pipeline usable with typed recovery.
- Codex app-server is cataloged as a distinct future adapter, not mislabeled as ACP.
- Generated materials remain reviewable drafts unless a user separately configures an enabled external consumer.
