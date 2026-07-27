# JobOS QA Rubric & E2E Test Suite — 2026-07-27

Locked BEFORE testing. Thresholds are per core feature: **each feature must pass E2E**.
Worktree: `/home/logani/projects/JobOS-worktrees/fix-qa-test-1` (branch `fix/qa-test-1`).

## Ground rules

- Every E2E journey runs in its **own temp workspace**: `export JOBOS_HOME=$(mktemp -d /tmp/jobos-qa-XXXXXX)`.
- Deterministic core: scrub LLM env (`JOBOS_LLM_PROVIDER= JOBOS_LLM_MODEL= JOBOS_LLM_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= OLLAMA_API_KEY=`).
- `--json` output must parse; exit codes must be 0 on happy paths, non-zero with `jobos:` error on validation failures.
- sql.js is not WAL: agents never share a JOBOS_HOME concurrently.
- Environment facts (verified 2026-07-27): Node v22.22.3, network reachable, `hermes acp --check` = OK.

## Severity classes

- **S1 Critical** — feature E2E broken: crash, non-zero exit on happy path, data loss, wrong wiring, safety invariant violated (side effects without consent).
- **S2 Major** — runs but wrong: missing/garbled output fields, wrong status, broken contract vs README/AGENTS.md.
- **S3 Minor** — cosmetic, warning noise, doc drift.

## Convergence rule

**Converged = every feature F0–F12 at PASS with zero open S1/S2.** Stop when converged, or after **2 full iterations**, whichever first. S1/S2 must be hot-fixed between iterations; S3 logged, not blocking.

## Per-feature threshold: PASS = 100% of REQUIRED checks green.

### F0 — Baseline suite (meta)
Required: `npm test` all green (node --test, concurrency 1); `npm run smoke` exit 0.

### F1 — Init & workspace
Required: first command auto-creates workspace (`.jobos/jobos.sqlite` + `jobos-workspace/`); `agent-guide --json` lists commands; `init --json` idempotent, exit 0; workspace mirror (YAML/MD/JSONL) regenerated on writes.

### F2 — Profile & proof points
Required: `profile create <name> --from-resume samples/resume-proof-points.md --json` → profile id + extracted proof points > 0; `proof add --json` works; profile listed under `jobos-workspace/profiles/`; duplicate-name handling sane.

### F3 — Discovery & searches
Required: `searches create` (greenhouse + ashby + portfolio + career-page adapters) exit 0 with persisted search; fixture-backed `discover run --search <name> --json` → status `succeeded`, imports > 0, highFit flagged per `--min-fit`; `daily --profile --json` runs all sources, isolates per-source failures (one failing source must not abort others), dedupes, scores, ranks; live network adapter degrades to recorded failure (not a crash) when a board is unreachable.

### F4 — Jobs
Required: `jobs list --json` valid array; `jobs import-text --file samples/job-description.md --json` → job id; job detail retrievable; duplicate import detected, not silently doubled.

### F5 — Fit scoring & tailoring
Required: `score <job> --profile <p> --json` → overall > 0 with dimension breakdown; `tailor resume --output markdown` contains proof-grounded evidence section, never invents claims; `tailor cover-letter` exit 0; artifacts persisted with status `draft_needs_human_review`.

### F6 — Pursue pipeline
Required: `pursue <job> --profile <p> --json` runs the full stage ladder (fit → research → network → questions → resume+cover drafts → tracking → outreach); each stage reports `ok|failed|skipped` + elapsed + outputs/recovery; offline-tolerant stages (fit, questions, drafts, tracking) must be `ok`; network stages may be `failed` with recovery guidance but never crash the pipeline; `--dry-run` performs no writes; `--stage questions` re-runs one stage.

### F7 — Answers & readiness
Required: `applications plan --job <j> --profile <p> --json` → status ∈ {blocked, ready-for-review, approved} with blockers + `nextAction`; answering all questions via `answers add` (incl. restricted work-auth with `--reuse never_auto_fill`) advances blocked → ready-for-review; restricted answers never auto-filled.

### F8 — Human review of artifacts
Required: `artifacts queue --profile <p> --job <j> --json` lists exactly current resume + cover-letter revisions; `artifacts diff <id> --json` shows unified diff; `artifacts approve <id> --json` → `approvalStatus: approved`, `submissionPerformed: false`, `applicationStatusChanged: false`, `externalSideEffects: none`; after all approvals plan → `approved` with `localApprovalComplete: true`; reject-with-feedback path works; audit_log rows written; no external side effect anywhere.

### F9 — Network, research & outreach
Required: `network paths --job <j> --json` and `network contacts --job <j> --json` valid (may be empty, must not error); research worksheets create honest entries (no fabricated facts); outreach draft is source-grounded; `applications create --status materials-ready` tracks locally.

### F10 — MCP server (Claude Code connection path)
Required: stdio MCP server starts; JSON-RPC initialize handshake succeeds; `tools/list` returns the JobOS domain tools; at least 3 representative `tools/call` invocations succeed end-to-end against real workspace state (e.g. list jobs, selected-job context, one write-free domain action); `npm run mcp-demo` exits 0; tool errors returned as MCP error content, never crash the server.

### F11 — ACP / Hermes embedded agent path
Required: `agentBackendCatalog` reports hermes-acp available (hermes installed, `hermes acp --check` OK); `npm run acp-demo` completes a real ACP session against Hermes and writes a redacted transcript (no credentials/secrets in transcript); `AcpClient` quarantine: late guest updates after cancel/timeout are quarantined; reconnect spawns a clean process; fake-acp fixture tests (`tests/tui-acp.test.js`, `tests/acp-host.test.js`) green.

### F12 — TUI
Required: `tui --profile <p> --snapshot --width 140 --height 42 --agent off` renders (header counts, job cards, priorities) exit 0; `--json` snapshot mode valid JSON; empty-workspace TUI shows guidance, not fabricated data; keymap docs consistent with implementation; `--agent off` never attempts ACP spawn.

## Iteration protocol

1. **Iter 1** — parallel QA agents (one per feature cluster), structured findings (feature, check, status, severity, evidence, repro).
2. **Hot-fix** — every S1/S2 fixed on `fix/qa-test-1`; fixes re-verified by the same check that failed.
3. **Iter 2** — re-run all previously-failed checks + full F0 regression. Converged if all PASS.

---

## Results — 2026-07-27

### Iteration 1 (parallel fleet, 9 agents)

| Feature | Verdict | Notes |
|---|---|---|
| F0 baseline | PASS | npm test 599/599 (background run), smoke exit 0 |
| F1/F2/F4 core | PASS | 9/9 checks; S3: create outputs omit proof-count field |
| F3 discovery | PASS | fixture import, failure isolation, dedupe/rank, live degradation |
| F5/F6 scoring+pursue | PARTIAL→fixed | S2: `--from-resume` never extracted preferences → coverage 42% → overall=null |
| F7/F8 readiness+review | PASS | full blocked→ready-for-review→approved journey, safe approval metadata |
| F9 network/research | PASS | honest worksheets, source-grounded outreach |
| F10 MCP (Claude Code path) | PASS | handshake, tools/list, 3+ tools/call, error containment, mcp-demo exit 0 |
| F11 ACP/Hermes | PARTIAL→fixed | ACP session fully green; demo bar failed only via the F5 scoring bug |
| F12 TUI | PARTIAL→fixed | snapshot/JSON/empty-guidance/agent-off all green; S3 keymap drift |

### Hot fixes applied (branch fix/qa-test-1)

1. `src/profiles.js` — `extractResumePreferences()`: deterministic lexicon extraction of industries, missionKeywords, skills (structured + proof tokens, stoplisted), locations (with location-likeness guard), workModel, targetRoleFamilies from resume content; merge order defaults ← extracted ← explicit `--preferences`; audit records extraction counts. Verified: README flow now scores overall=74 (scored/review_required, coverage 74–86); pursue all 8 stages ok; `npm run acp-demo` exit 0; targeted tests 66/66 + TUI 40/40 green; smoke exit 0.
2. `src/tui.js` + `README.md` — `v` (profile overlay) added to TUI_KEYMAP/TUI_HANDLED_KEYS/footer; README documents `g`, `b`, `m`, `v`, `1`–`7`, Tab, Enter.

### Iteration 2

Verification fleet (3 agents) + inline bars, post-fix:

| Feature | Verdict | Evidence |
|---|---|---|
| F0 regression | PASS | post-fix full suite 599/599 pass, 0 fail; smoke exit 0 |
| F3 discovery | PASS | locked bar met: discover run succeeded, imported=1, highFit=1 (smoke-equivalent profile); failure isolation intact (career-page 404 isolated, greenhouse succeeds); dedupe/rank ok. Note: bare 3-bullet sample resume honestly caps at coverage 74 → highFit=0 by design (qualifiesForHighFit is unit-locked; fabricating location/salary to raise it would violate honesty invariants) |
| F5 scoring | PASS | bare --from-resume: overall=74, status scored/review_required, 5 scored dimensions; constructed profile: highFit |
| F6 pursue | PASS | complete resume: all 8 stages ok, pipeline succeeded; bare resume: typed resume_source_missing + recovery command (designed isolation) |
| F7/F8 readiness+review | PASS | blocked (8 blockers+nextActions) → 10 answers (restricted work-auth never_auto_fill) → ready-for-review → approve both (submissionPerformed=false, externalSideEffects=none) → approved/localApprovalComplete=true → reject-with-note path regresses to blocked |
| F10 MCP | PASS | mcp-demo exit 0; protocol 2024-11-05; 57 tools; initialize handshake; get_job_context reflects extracted prefs (overall=74); -32601 typed error containment; 0 sentinel leaks |
| F11 ACP/Hermes | PASS | npm run acp-demo EXIT=0: real Hermes session, visibleMutation gate satisfied, transcript redacted (verified iter-1: no credentials), quarantine/reconnect green, tui-acp+acp-host tests 40/40 |
| F12 TUI | PASS | snapshot 140x42 + 90x30 render new footer (g/b/v); --json valid; empty-workspace guidance; keymap drill 40/40; README documents all bound keys |

Residual S3 from the initial run: (1) proof/job create responses do not all use a common `ok` envelope; (2) `artifacts reject` uses the documented `--note` flag.

## Initial convergence claim — superseded by independent audit

The initial F0–F12 result was not independently reproducible. A direct rerun reopened F6, F10, F11, and F12:

| Finding | Severity | Reproduction |
|---|---|---|
| The documented `samples/resume-proof-points.md` flow created no canonical resume, so `pursue` failed the resume stage and skipped application/outreach. | S2 | Fresh workspace; README profile + sample job + `pursue` returned `partial`, failed=1, skipped=2. |
| `npm run mcp-demo` required an undocumented `--job` and exited 1. | S2 | Bare package script returned `Missing --job <job-id>`. |
| `npm run acp-demo` reused arbitrary workspace state and required a null→numeric score mutation, so reruns could fail despite a healthy ACP session. | S2 | Bare package script completed six turns but returned `ok:false`, `visibleMutation:false`. |
| Resume employment facts were stored as declared preferences. A past title/location could become a target role, desired location, and remote-work constraint. | S2 | `Senior Product Manager` was accepted as a location; `Backend Engineer` and `Remote` became target/work-model preferences. |
| The compact TUI footer omitted `g` and `v`; implemented `t`, `c`, and `x` bindings were absent from the central keymap. | S3 | 80-column snapshot omitted setup/profile/stage/reconnect/cancel guidance. |
| Profile creation did not expose imported-proof or canonical-resume counts, and missing-proof text incorrectly said no proofs existed when only verification was missing. | S3 | Fresh README profile import returned preferences but no proof/resume summary. |

Corrections:

1. The sample resume is now a complete canonical Markdown resume while preserving the same three proof bullets.
2. Resume extraction keeps factual industries and structured skills, but never converts past titles, locations, remote work, or mission text into job-search preferences. Explicit `--preferences` remains authoritative.
3. Bare MCP and ACP demos self-seed isolated temporary workspaces; MCP default-sentinel redaction is enforced even without a caller-provided secret; temporary workspaces are removed.
4. The TUI central keymap and compact/wide footers now advertise `t`, `c`, `x`, `g`, and `v`; the key drill covers them.
5. Profile-create JSON now reports `proofPointCount` and `canonicalResumeCreated`; readiness and tailoring say “active verified proof points.”

## Supplemental usability coverage

The original F0–F12 grouping did not give documented setup, form/packet/receipt, Career Memory, interview/debrief, scheduler, or configured browser submission their own E2E bars. Independent checks therefore add:

| Area | Required proof | Result |
|---|---|---|
| README local journey | Fresh init → sample profile → sample job → full pursue | PASS: 3 proofs, canonical resume created, all 8 stages `ok` |
| Live form / packet / receipt | Manual and configured local form server paths | PASS: `npm run smoke:live-form`; manual attested with no submission, configured submission confirmed with explicit side-effect metadata |
| Review / receipt spine | Exact revisions, approvals, immutable packet, attestation/confirmation | PASS: `npm run smoke`; materials-ready and confirmed receipt with no implicit submission |
| Career Memory / interviews / scheduler | Observation lifecycle, artifacts, interview debrief, scheduled run | PASS: `npm run smoke` W07/W08 and scheduler sections |
| MCP | Bare package script, real stdio handshake, calls, typed error, redaction | PASS: 57 tools, score/context calls, `-32601`, zero sentinel leaks |
| ACP / Hermes | Bare package script, real session, cancel quarantine, reconnect, timeout, policy denial | PASS: six turns, visible mutation, zero leaked late updates, clean reconnect |
| TUI discoverability | 80/90/140-column guidance plus automated key drill | PASS: targeted keymap suite |

## Final convergence

Post-correction full regression: **601/601 pass, 0 fail**. Targeted changed-path tests: **79/79 pass**. `npm run smoke`, `npm run smoke:live-form`, bare `npm run mcp-demo`, and a real bare `npm run acp-demo` all exit 0. The README sample journey creates 3 proof points plus a canonical resume and completes all 8 pursue stages. **CONVERGED for the local/deterministic and configured-local-browser rubric on 2026-07-27.**

Environment boundary: live third-party authenticated boards, user mail accounts, and employer-owned production forms still require the user’s own credentials, consent, and target-specific validation. The QA result proves the adapters, mediation gates, local browser fixture, and failure containment; it does not claim universal compatibility with every external site.
