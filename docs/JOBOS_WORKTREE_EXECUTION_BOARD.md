# JobOS Worktree Execution Board

**Updated:** 2026-07-24
**Strategy:** `docs/JOBOS_CAPABILITY_PARITY_MASTER_PLAN.md`  
**Inputs:** `CAREER_OPS_IMPLEMENTATION_AUDIT.md`, `docs/open_source_benchmark_checkup.md`, `Gap_Analysis_and_Benchmark.md`, `ideal-agent-native-job-application-app.md`, `Feature_Adaptation_Plan.md`

This is the shared operational view for capability-parity work. It tracks ownership, boundaries, dependencies, acceptance evidence, and what has actually reached the integration branch. The strategy document remains authoritative for product intent and non-goals.

## 1. Status model

| Status | Meaning | Who may set it |
|---|---|---|
| `PLANNED` | Scoped but no active owner | Integration owner |
| `IN_PROGRESS` | A named worktree owns a bounded slice | Worktree owner |
| `BLOCKED` | Work cannot proceed without a named contract or prerequisite | Worktree owner |
| `READY_FOR_MERGE` | Worktree acceptance checks pass; not yet integrated | Worktree owner |
| `INTEGRATING` | Merge/migration and cross-bundle verification are active | Integration owner |
| `DONE` | Merged, runtime-verified, documented, and evidenced below | Integration owner only |

A branch-local passing test does not mean `DONE`. A partial slice does not complete its parent bundle.

## 2. Live bundle board

| ID | Bundle | Priority | Status | Owner / worktree | Dependency gate | Next integration decision |
|---|---|---:|---|---|---|---|
| W01 | Candidate truth and complete document pipeline | P0 | **DONE** | `fix/tailored-resume` integrated through `ceffad3` | Artifact/proof/packet contracts preserved | Canonical resume, proof lifecycle, semantic completeness, deterministic renderer/preflight, exact revisions, and packet compatibility pass in the integrated suite |
| W02 | Live form, answer readiness, and packet bridge | P0 | **DONE** | `fix/live-form-packet-bridge` integrated as `06fdb5d`, hardened through `bf06878` | W01 artifact and W03 identity/liveness contracts verified | Packet-bound manual/configured paths and iframe confirmation pass the full suite and both smoke paths |
| W03 | Discovery integrity, liveness, and normalized intake | P0 | **DONE** | `fix/discovery-integrity` merged as `5af9766` | None; preserves W01 schema/workflow contracts | Retry/isolation, normalized fields, liveness, gates, and compatibility pass in the integrated suite |
| W04 | Fit consistency, legitimacy boundary, and calibration | P0 | **DONE** | `fix/fit-consistency` corrected at `4028a20`, integrated through `67681ef` | W03 legitimacy and W06 aggregate contracts consumed separately | Evidence/math/unknown/dealbreaker/golden/calibration contracts pass in the integrated suite |
| W05 | Contact confidence, outreach relevance, and outcomes | P1 | **DONE** | `fix/contact-outreach` integrated as `eac4e3e`, consolidated through `67681ef` | Existing research/outreach contracts plus W02 schema composition | Contact provenance, role-aware review-only outreach, append-only outcomes, and weekly review pass |
| W06 | Lifecycle next actions, follow-up, velocity, and analytics | P1 | **DONE** | Integrated into `cleanup/base` as `16ee93c` | Consumes W02/W05 events; publishes stable W04/W07/W08 handoffs | Fresh reviews passed; post-integration full suite 404/404 and both smoke paths passed |
| W07 | Verified interview story bank and debrief loop | P1 | **IN_PROGRESS** | `fix/interview-story-debrief` | W01 proof lifecycle and W06 `jobos.lifecycle-event-input.v1` are stable | Define persistent story/debrief contracts, implement strict TDD slices, and publish attributed W08 observations |
| W08 | Career Memory, preference calibration, and voice/positioning | P1 | PLANNED | Unassigned | Stable profile/artifact/job/outcome identifiers from W01/W03/W05/W06/W07 | Freeze canonical-versus-observational-versus-derived memory boundaries, event taxonomy, proposal lifecycle, and bounded retrieval contract |
| W09 | Guided onboarding and setup recovery | P2 | PLANNED | Unassigned | W01/W02/W03/W08 user path stable | Guide existing domain flows and optional calibration; do not create alternate setup or preference state |
| W10 | Quality, security, release, protocol, and docs | P2 | PLANNED | Unassigned | Behavioral bundles integrated | Gate final journey and Career Memory contracts; protocol migration remains conditional |

## 3. Active work note — tailored resume

The user reports a current fix for the tailored-resume portion. This board therefore marks **W01 `IN_PROGRESS`**, but records no unverified implementation claim.

Until that worktree publishes its branch scope:

- it owns edits to the tailored resume contract and should be treated as the coordination point for `src/tailoring.js` and directly coupled artifact/readiness behavior;
- other worktrees must not independently invent a second canonical document schema;
- profile/proof correction, cover-letter completeness, renderer/export, and semantic readiness remain open unless the active worktree explicitly satisfies their acceptance bars;
- W02 may design against the existing immutable packet boundary but must wait for the final document/artifact interface before integration.
- W08 may consume exact artifact review/edit events and diffs after W01 freezes those identifiers, but it must not edit or reinterpret the document schema inside the active W01 worktree.

## 4. Worktree briefs

These briefs are intentionally meta-level. A new worktree should inspect current code, turn its assigned acceptance bars into an implementation plan, and keep all changes inside its bundle contract.

### W01 — Candidate truth and complete document pipeline

**Goal:** Produce complete proof-grounded application documents from a correctable canonical candidate record.

**Owns:** candidate/resume structure, proof lifecycle, tailoring, requirement coverage, semantic document validation, one render/export handoff, and document-readiness integration.

**Must preserve:** immutable profile/artifact lineage, exact human approval, unsupported-claim rejection, and packet currency.

**Must not own:** live employer-form extraction/filling (W02), scoring math (W04), preference-learning logic (W08), or onboarding presentation (W09).

**Acceptance evidence to record:**

- complete resume round-trip and correction scenario;
- grounded changed-claim/unsupported-gap scenario;
- incomplete worksheet rejected before review/readiness;
- approved artifact rendered without content reconstruction;
- exact-revision approval and stale-packet behavior still work.

### W02 — Live form, answer readiness, and packet bridge

**Goal:** Make application readiness and configured form assistance truthful to the real employer form.

**Owns:** form/frame inspection, stable snapshot/fingerprint, field normalization/classification, answer matching, blockers, fill/read-back, human checkpoints, packet binding, narrow configured submission, replay-safe attempt state, and structured receipt/uncertainty handoff.

**Must preserve:** restricted-answer exclusions, redaction, adapter hash pinning, separate default-off action enablement and per-invocation authorization, CAPTCHA/auth recovery without bypass, packet/submission idempotency, honest uncertain outcomes, and the complete manual human submission/attestation path.

**Must not own:** broad board scraping (W03), document generation (W01), generic autonomous browsing, scheduled/bulk submission, or broad ATS automation.

**Implementation note (2026-07-23):** `fix/live-form-packet-bridge` implements the bounded W02 slice: deterministic main/frame inspection and secret-safe snapshots; hard-safety field classification; exact W01 material/identity and answer bindings; truthful readiness v4; packet v2 with non-hashed snapshot evidence; default-off fill/read-back; trusted human checkpoints; packet/form-bound manual attestation; separately configured and per-run-authorized submission; replay-safe attempts; and confirmed-versus-uncertain receipt handling. Populated packet-v1/receipt tables migrate without losing historical hashes. Acceptance passed `tests/live-form-bridge.test.js` **25/25**, readiness/packet/human-review **35/35**, `npm run smoke`, real-Chromium `npm run smoke:live-form`, and the full suite **302/302**. Independent critic convergence iteration 2 returned `accept` / `ready_for_merge: true`. W02 is `READY_FOR_MERGE`, not `DONE`; integration must rerun cross-bundle verification.

**Acceptance evidence to record:**

- representative live/local form extraction including iframe and common controls;
- materials-ready before inspection versus form-ready after inspection;
- restricted/legal field pause;
- stale packet refusal;
- fill divergence detection;
- exact packet/form-bound handoff and receipt.
- configured submission is default-off, exact-binding-only, idempotent, and records explicit external side effects;
- ambiguous post-submit state is uncertain rather than success, while manual human submission/attestation remains supported.

### W03 — Discovery integrity, liveness, and normalized intake

**Goal:** Deliver reliable active-role intake from existing sources with honest partial state.

**Owns:** HTTP retry/backoff, per-result isolation, partial run semantics, normalized native fields, saved-search filters, and pre-score liveness/legitimacy evidence.

**Must preserve:** public-ATS-first scope, request/redirect budgets, SSRF protections, source provenance, deduplication, repost history, and human review queues.

**Must not own:** proxy/TLS evasion, authenticated-board arms races, candidate-fit math (W04), application form filling (W02), or automatic preference mutation (W08).

**Implementation note (2026-07-22):** All approved Phases 0–6 are complete on `fix/discovery-integrity`. The worktree was rebased onto the integrated W01 base before touching shared files, preserves W01 resume/proof/artifact/packet behavior, and is ready for integration-owner review.

**Acceptance evidence:**

- `W03-HTTP-01`–`W03-HTTP-05`: one shared run-level request/time budget, bounded `429`/`503` recovery, safe `Retry-After`, redirect, timeout, credential, DNS, and SSRF behavior pass;
- `W03-FILTER-01`–`W03-FILTER-02`: deterministic recency, remote-only, employment-type, keyword, and location precedence pass through adapter, saved-search, CLI, and workspace round trips;
- `W03-LIVE-01`–`W03-LIVE-03`: `active | expired | uncertain` classification and separate versioned evidence pass for ATS listings, closure evidence, anti-bot/transport ambiguity, and conflicts;
- `W03-ISO-01`–`W03-ISO-02`, `W03-RUN-01`–`W03-RUN-03`: per-result import/score/liveness failures are isolated; `succeeded | partial | failed` reduces consistently through run-all, daily, scheduler persistence, audit vocabulary, and workspace mirrors;
- `W03-FIELD-01`–`W03-FIELD-02`, `W03-COMPAT-01`: structured compensation, work model, employment type, department, source-native fields, and liveness survive persistence, refresh, dedupe, CLI/domain/TUI projection, and legacy migration;
- `W03-GATE-01`–`W03-GATE-03`, `W03-HANDOFF-01`: fresh known-expired jobs cannot score or pursue; uncertain jobs remain usable with warnings; 24-hour freshness refreshes only at the boundary; `jobos.posting-liveness.v1` remains separate from candidate-fit math;
- `W03-SAFETY-01`: provenance, dedupe/repost history, review queues, profile ownership, and zero external side effects remain intact.

### W04 — Fit consistency, legitimacy boundary, and calibration

**Goal:** Make pursue decisions mathematically consistent, evidence-readable, uncertainty-aware, and outcome-informed.

**Owns:** dimension/overall formula, override recomputation, unknown/dealbreaker semantics, reason evidence references, separate legitimacy consumption, golden evaluation, and score-band calibration presentation.

**Must preserve:** deterministic degraded mode, malformed provider fallback, proof awareness, and evidence-derived network access.

**Must not own:** liveness collection (W03), lifecycle event capture (W06), preference-proposal lifecycle (W08), or ATS keyword-tailoring output (W01).

**Acceptance evidence to record:**

- same dimensions always yield the same overall;
- network override changes overall consistently;
- unknown data differs from neutral fit;
- dealbreaker and contradiction ordering cases;
- legitimacy displayed separately;
- calibration hidden or caveated below sample threshold.

### W05 — Contact confidence, outreach relevance, and outcomes

**Goal:** Tighten contact-channel truth and make outreach relationship-aware with lightweight feedback.

**Owns:** confidence component labels, company-domain relevance, freshness, catch-all/inconclusive handling, stakeholder-aware deterministic drafts, and outreach outcome capture.

**Must preserve:** research budgets/checkpoints, person identity rules, approval/suppression, `doNotUse`, proof/source allowlists, exact artifact revision, and no claimed delivery.

**Must not own:** broad OSINT sweeps, SMTP auto-send, lead scoring, application lifecycle follow-up (W06), or derived preference rules (W08).

**Acceptance evidence to record:**

- unrelated domain cannot receive company A/B tier;
- stale/catch-all observations visibly downgrade confidence;
- recruiter/manager/peer/executive fallbacks differ;
- reply/meeting/no-response can be recorded and summarized without causal probability claims.

### W06 — Lifecycle next actions, follow-up, velocity, and analytics

**Goal:** Convert every application event into one current dated action and useful, honest feedback.

**Owns:** profile-scoped tasks, next-action replacement, employer follow-up cadence, waiting/overdue/urgent state, stage dwell/time-to-response, outcome aggregation, and recommendation links to source/targeting/proof/score gaps.

**Must preserve:** append-only status history, manual override, application provenance, immutable attestation/receipt events, and profile isolation.

**Must not own:** score formula (W04), outreach-thread follow-up semantics (W05), interview story content (W07), or interpretation of outcomes as preferences (W08).

**Acceptance evidence to record:**

- profile A review cannot expose profile B tasks;
- each active application has one stage-correct dated action;
- attestation seeds idempotent employer follow-up;
- manual reschedule survives recomputation;
- dwell/velocity folds observed status events with sample cautions.

### W07 — Verified interview story bank and debrief loop

**Goal:** Reuse verified proof-grounded stories across interviews and feed debrief evidence back into preparation.

**Owns:** STAR+Reflection record lifecycle, proof links, audience packs, sourced/inferred question labels, deterministic story/gap matching, and application/stage debrief records.

**Must preserve:** no fabricated facts, profile isolation, source/proof traceability, and human verification.

**Must not own:** generic coaching product features, voice rehearsal, lifecycle task engine (W06), candidate proof schema (W01), or derived preference interpretation (W08).

**Acceptance evidence to record:**

- verified story reused across two applications with provenance intact;
- unsupported content cannot become verified;
- audience-specific packs expose covered and uncovered questions;
- debrief records proof gaps, emits the agreed W06 event/action input, and exposes an attributed observation W08 may use for proposals.

### W08 — Career Memory, preference calibration, and voice/positioning

**Goal:** Turn explicit user decisions, artifact feedback, and outcomes into local, attributable, reversible guidance for search and writing.

**Owns:** the shared memory contract: typed observational events, reason taxonomy, derived proposal lifecycle, deterministic brief/guide projections, bounded retrieval, accept/reject/supersede/revoke/undo behavior, conflict/staleness controls, and evaluation of accepted guidance.

**Data boundary:**

- **Canonical:** existing user-controlled facts, constraints, proofs, answers, and explicit preferences remain in their owning domain records.
- **Observational:** append-only profile-scoped events record what the user did and why, with actor, time, source entity, exact artifact/job/version ID, reason codes, and optional note.
- **Derived:** proposals cite observations, declare confidence and scope, and remain behaviorally inactive until explicitly accepted.

**Writing projection:** a per-profile voice/positioning guide may include artifact-type tone and length, opening/closing preferences, avoid terms or claims, approved exemplar snippets tied to exact artifact revisions, positioning hierarchy, and active accepted rules. It controls selection and framing only; proofs remain the authority for factual claims.

**Must preserve:** local-first privacy, append-only attribution, profile isolation, proof grounding, human review, exact artifact revisions, protected/sensitive inference exclusions, and honest uncertainty.

**Must not own:** canonical candidate/document facts (W01), discovery intake/liveness (W03), outreach event meaning (W05), lifecycle event meaning (W06), interview debrief meaning (W07), or silent model fine-tuning.

**Acceptance evidence to record:**

- save/skip/apply feedback with structured reasons and source job ID;
- approve/reject/edit feedback tied to exact artifact revision and diff;
- a proposal citing multiple supporting observations, remaining inactive before acceptance, changing only its declared scope after acceptance, and restoring prior behavior after revocation;
- accepted and rejected proposals preserved in history;
- deterministic career brief and voice guide with source fact/rule IDs;
- contradictory, stale, single-sample, protected, and cross-profile evidence cannot become silently active guidance;
- artifact-type writing rules remain scoped unless separately accepted globally;
- held-out search evaluation reports precision at a fixed review budget, and writing evaluation proves accepted rules are followed without unsupported claims.

### W09 — Guided onboarding and setup recovery

**Goal:** Guide a clean workspace through trustworthy setup using existing domain tools and canonical state.

**Owns:** resumable setup state/presentation, missing-data detection, correction routes, source/provider configuration guidance, optional sample-job calibration, browser setup guidance, and first-journey handoff.

**Must preserve:** local-first defaults, optional external credentials/actions, transparent IDs under the hood, existing canonical storage, and visible accept/reject for any calibration proposal.

**Must not own:** another web product/dashboard, duplicate profile/source/preference state, hidden automatic external actions, or Career Memory derivation rules (W08).

**Acceptance evidence to record:**

- clean workspace reaches a pursue decision and materials-ready state through guidance;
- interruption resumes at the correct step;
- invalid imported profile/source data has a correction path;
- optional sample-job ratings create attributed observations and visible proposals without changing canonical preferences;
- no API key is required for the core path.

### W10 — Quality, security, release, protocol, and documentation hygiene

**Goal:** Turn integrated behavior into reproducible, safe release evidence and accurate operator guidance.

**Owns:** cross-bundle golden fixtures, Career Memory provenance/reversibility/isolation fixtures, security/dependency/data-leak checks, release automation, README/build-status drift, and conditional MCP SDK migration.

**Must preserve:** focused observable tests, local fixture isolation, no committed runtime state, and domain mediation.

**Must not own:** behavioral redesign late in release work or protocol modernization without demonstrated compatibility/maintenance need.

**Acceptance evidence to record:**

- merged journey smoke proof;
- golden fixtures for the final contracts, including inactive proposals, revocation, conflict handling, and profile isolation;
- security/data-leak checks against generated fixtures;
- reproducible release command/path;
- packet/receipt, Career Memory boundaries, and current limitations documented consistently;
- MCP compatibility evidence only if migration is performed.

## 5. Integration waves

### Wave A — Independent foundations

- W01: active candidate/document work.
- W03: discovery/liveness may run independently.
- W05: contact/outreach quality may run independently.
- W04: internal score consistency may begin, but legitimacy integration waits for W03 and outcome calibration waits for W06.

### Wave B — Complete the application and event bridge

- W02 starts integration after W01 freezes the approved artifact/document interface.
- W06 can build on existing status, packet, attestation, and receipt events while publishing aggregate/debrief interfaces.

### Wave C — Reuse, memory, and feedback

- W07 consumes stable proof and lifecycle interfaces.
- W08 freezes the shared observation/proposal/projection contract, then consumes exact identifiers and events from W01/W03/W05/W06/W07 without taking ownership of those domains.
- W04 consumes W03 legitimacy and W06 aggregate outputs; accepted W08 preferences may become explicit score inputs only through a visible versioned contract.

### Wave D — Adoption and release

- W09 guides stable product behavior from W01/W02/W03 and offers optional W08 calibration.
- W10 performs final cross-bundle verification, Career Memory safety checks, hygiene, and documentation reconciliation.

## 6. Protected baseline already built before this roadmap

These are not new roadmap completions. They are integration constraints:

- canonical local SQLite state and agent-readable mirrors;
- status history, artifact revisions/hashes/diffs, exact approval, and mirror-divergence protection;
- immutable packets, currency checks, attestation, idempotency, and receipt confirmation;
- scoped/redacted/restricted answer records;
- durable research graph, contact approval/suppression, and warm-path evidence;
- domain tools shared across CLI/TUI/ACP/MCP with mediation;
- private browser profiles, typed recovery, registered script hashes, and side-effect gates;
- Greenhouse, Lever, Ashby, generic career-page, and bounded portfolio discovery with SSRF controls.

## 7. Update protocol for every worktree

When starting:

1. Change only the owned bundle row to `IN_PROGRESS` and add the owner/worktree name.
2. State the exact sub-scope if the worktree does not cover the whole bundle.
3. Record any dependency contract it publishes or consumes.
4. Do not edit another bundle's status.

Before requesting merge:

1. Change the owned row to `READY_FOR_MERGE`.
2. Add verification commands/scenarios and observed results to the evidence ledger.
3. List intentionally deferred acceptance bars; if any remain, keep the parent bundle short of `DONE`.
4. Note schema/interface changes downstream worktrees must consume.

During integration:

1. The integration owner sets `INTEGRATING`.
2. Migrate callers and resolve contract conflicts across bundles.
3. Run the relevant end-to-end journey, not only narrowed tests.
4. Set `DONE` only after merged runtime proof and documentation alignment.

## 8. Acceptance evidence ledger

| Date | Bundle | Integrated change | Runtime proof | Contract tests | Known remaining scope |
|---|---|---|---|---|---|
| 2026-07-22 | W01 | Proof-grounded complete resume pipeline integrated through `ceffad3` | Canonical resume round-trip, complete deterministic tailoring, renderer/preflight, and exact revision behavior exercised | Included in final integrated 404/404 suite | None in W01 acceptance scope |
| 2026-07-23 | W02 | Live-form/readiness/packet bridge integrated and hardened through `bf06878` | Standard and real-Chromium live-form smoke paths passed | Included in final integrated 404/404 suite | None in W02 acceptance scope |
| 2026-07-22 | W03 | Discovery retries/isolation, normalized intake, honest run states, persisted liveness, and score/pursuit gates integrated as `5af9766` | Clean-workspace smoke covers active/expired/uncertain discovery and hard stops | Included in final integrated 404/404 suite | None in W03 acceptance scope |
| 2026-07-23 | W04 | Fit evidence/math, legitimacy boundary, golden ordering, and calibration integrated through `67681ef` | Focused acceptance and merged smoke paths passed | Included in final integrated 404/404 suite | None in W04 acceptance scope |
| 2026-07-23 | W05 | Contact confidence, role-aware outreach, and append-only outcomes integrated through `67681ef` | Focused 52/52 and merged smoke paths passed | Included in final integrated 404/404 suite | None in W05 acceptance scope |
| 2026-07-24 | W06 | Lifecycle actions, scoped tasks, rescheduling, analytics, recommendations, and handoffs integrated as `16ee93c` | Parent and post-integration standard/live-form smokes passed | Fresh reviews PASS; post-integration `npm test` 404/404 | None in W06 acceptance scope; W07/W08 consume published interfaces |

## 9. Decision ledger

| Date | Decision | Reason | Affected bundles |
|---|---|---|---|
| 2026-07-22 | Close document and live-form semantic gaps before long-tail expansion | Both audits identify these as the largest user-visible failures | W01, W02 |
| 2026-07-22 | Preserve JobOS persistence, provenance, answer safety, research, and mediation | These are stronger than the benchmark systems and form the differentiation | All |
| 2026-07-22 | Bundle profile truth, tailoring, validation, and one renderer | They share one canonical document contract; splitting them invites schema drift | W01 |
| 2026-07-22 | Bundle live form, readiness, answers, packet, and receipt | Readiness cannot be truthful unless one vertical slice owns the real-form handoff | W02 |
| 2026-07-22 | Keep liveness with discovery, separate legitimacy from fit | Collection belongs at intake; candidate fit must not absorb posting trust | W03, W04 |
| 2026-07-22 | Use existing ledgers for follow-up and velocity | A second tracker would duplicate state and weaken invariants | W06 |
| 2026-07-22 | Add one Career Memory bundle with canonical, observational, and derived layers | Explicit feedback can improve discovery and writing, but a shared proposal/retrieval contract avoids silent mutation, duplicated truth, and separate learning silos | W01, W03, W05, W06, W07, W08, W09 |
| 2026-07-22 | Treat MCP modernization as conditional maintenance | Protocol polish must not outrank job-seeker outcomes | W10 |
