# Gap Analysis and Benchmark

**Version:** v2.0 — 2026-07-13
**Benchmark input:** `Competitive_Feature_Analysis.md` v2.0  
**Code state:** `c5ef87b` (`origin/main`) — PR #2 labels `user_configured` are active (worktree normalization diff reverted).
**Implementation snapshot:** Not applicable — baseline is `c5ef87b` on `origin/main` with no uncommitted normalization diff.
**Verification:** `npm test` passed 38/38 on 2026-07-13 (PR #2 baseline, no worktree diff); `npm run smoke` returned `ok: true`.

## Bottom line

JobOS is already strong where many commercial tools are weak: local ownership, agent-drivable CLI/MCP surfaces, source-backed research, claim-level proof grounding, auditable internal automation, and a coherent application pipeline. It is not yet close to end-to-end application-assistant parity because the flow stops after Markdown drafts. The largest practical gaps are:

1. no structured answer bank or risk-aware question workflow;
2. no immutable, reviewable per-job application packet;
3. no browser/ATS field-map handoff or supported autofill surface;
4. no submission receipt/confirmation model or automatic status reconciliation;
5. no conversational intent capture or feedback-learning loop;
6. no production resume document/export/version workflow;
7. no interactive interview practice with feedback;
8. narrow discovery coverage;
9. no offer, salary-market, or negotiation workflow.

The highest-return route is user-configured auto-apply and auto-send. A proof-grounded application packet plus risk-based review plus auto-apply adapters (Greenhouse/Lever public ATS, LinkedIn/Indeed session-cookie, SMTP outreach) closes the value gap against Sprout, LoopCV, and ApplyIQ while staying compatible with JobOS's local-first architecture. Platform terms compliance for authenticated-board adapters is the user's responsibility; JobOS displays ToS risk warnings but does not block the capability.

## Authoritative baseline

### Repository and test evidence

- The command registry exposes 44 CLI operations across profile/proof, discovery, scoring, tailoring, applications, research, outreach, interview prep, analytics, scheduler loops, MCP, and web (`src/cli.js:43-87`).
- The schema contains profiles, proof points, jobs, searches, watchlists, stakeholders, applications/status history, artifacts, outreach threads, tasks, automations/runs, and audit logs, but no answer, field-map, application-packet, submission-attempt, receipt, interview-session, or offer entity (`src/db.js:12-28`).
- Resume import and manual proof addition exist; extracted claims are stored with source/metrics metadata (`src/profiles.js:7-13`).
- Public discovery supports only Greenhouse and Lever adapters in the current registry (`src/cli.js:52-57`; `src/discovery/adapters.js`).
- Scoring has provider-backed structured output and deterministic fallback across role, domain, seniority, location/work model, compensation, mission, network, and red flags (`src/scoring.js:16-115`).
- Tailoring filters LLM mappings to known proof IDs and writes review-state Markdown artifacts (`src/tailoring.js:40-113`).
- Research uses multi-query public search, source pools, conservative synthesis, and unsupported-claim dropping (`src/research.js:133-477`).
- Outreach drafts use stakeholder/company/proof evidence, but `mark-sent` only records an action performed elsewhere (`src/outreach.js:368-429`).
- Applications are manually created/updated and lack external receipt semantics (`src/tracking.js:5-7`).
- Interview prep generates proof-grounded written packets; it does not conduct or score a session (`src/interview.js:79-139`).
- Scheduler runs are sequential, PID-guarded, audited, failure-recorded, and currently declare no external side effects (`src/scheduler/core.js:53-123`).
- The dashboard can create/edit core records, move application stages, and approve/reject artifacts, but it has no application review/handoff UI (`src/web.js:26-47`; `src/api.js:113`).
- `npm test` passed 41 tests on 2026-07-11, including table-driven current-copy/default-policy behavior across CLI init/guide, API/dashboard, MCP capability absence, scheduler metadata, generated artifacts, and the historical-plan quarantine. This proves covered current behavior, not missing parity features.

Important implementation defects affect parity work even though the current suite passes:

- `discover run-all --profile` passes a profile filter from the CLI, but `runAllSearches` ignores it (`src/cli.js:464-466`; `src/discovery.js:141-145`).
- URL import lacks scheme/private-network restrictions, response-status checks, timeout, and response-size limits (`src/jobs.js:37`), so expanding agent-driven imports without SSRF/resource controls would be unsafe.
- Scoring and tailoring do not enforce that the requested profile matches the job’s profile, while outreach does (`src/scoring.js:95-120`; `src/tailoring.js:81-113`; `src/outreach.js:368-377`).
- External LLM prompts can contain full preferences, proofs, job text, facts, and stakeholders with no sensitive-field redaction or per-data-class consent (`src/llm.js` and caller prompts).
- Originless API requests are accepted and the web server can bind to a custom host; non-loopback binding would expose unauthenticated local reads/writes (`src/api.js:14-16`; `src/cli.js:644-649`).
- `sql.js` loads and rewrites a complete database snapshot. Scheduler PID locking serializes scheduler runs only; a CLI process and long-running web/MCP process can hold stale independent copies and lose each other's writes. Table uniqueness cannot provide cross-process idempotency until every mutator reloads under one workspace-wide lock or the database engine changes (`src/db.js`; `src/scheduler/core.js:14-27`).

### What merged PR #2 changed

The exact merge is `c5ef87b`, merging `65b1d8e` and feature commit `750c3d0` with the title "Remove ethical/ToC guardrails for personal-use job search tool." PR #2 establishes user-configured automation as the product direction:

| Change | Evidence | Meaning for this benchmark |
|---|---|---|
| PR #2 changed policy labels to `user_configured` | PR diff; current `src/profiles.js`, `src/analytics.js`, `src/scheduler/store.js`, `src/workspace.js` | External actions (auto-apply, auto-send, board scraping) are user-configured. They default to off but can be enabled. F0 must supply an enforceable policy engine that honors this direction. |
| README described auto-apply/auto-send as planned future work | merged PR #2 README configuration section | These are the product direction. F0–F8 implement them as user-configured adapters with per-connector enablement and risk warnings. |
| LinkedIn/social source filtering was removed from research | PR diff and `run_eval_guardrails.js:115-124` | Search results include those domains. LinkedIn/Indeed discovery adapters using user-provided session cookies are user-configured capabilities. |
| Proof grounding, audit logging, source URLs, and artifact approval state were explicitly retained | `run_eval_guardrails.js:87-96`, `165-190`; `src/db.js:15,23,28` | These are non-negotiable data-integrity controls retained in the user-configured model. |
| No apply/send adapter, answer bank, or external scheduler action was implemented | command registry and schema inspection | The `user_configured` labels are the product direction; F0–F8 implement the executors (auto-apply adapters, SMTP auto-send, session-cookie board discovery). |

### Ethics/ToC interpretation used here

PR #2 established the product governance direction: external actions are user-configured, not hardcoded-disabled.

- The original `AGENTS.md` said external actions stay human-gated, forbade auto-apply/auto-send/private-account scraping, and required truthful proof-grounded drafts. PR #2 and the user's explicit direction (2026-07-13) supersede this: `AGENTS.md` is updated to reflect user-configured automation. The user bears responsibility for platform terms compliance when enabling authenticated-board adapters.
- `PLAN_EXPANDED_TOOLS.md` proposes LinkedIn/Indeed session-cookie adapters, auto-apply adapters, auto-send via SMTP, auto-followup, and using the latest draft when no approved artifact exists. This is the active product direction, not a superseded plan.
- PR #2 retained proof grounding, source URLs, audit logging, and artifact approval state as data-integrity controls. These remain mandatory in the user-configured model.
- Current code performs no submission yet (the executors are not implemented), but `user_configured` labels indicate the intent to build them.

For implementation, user-configured automation means:

1. External actions (auto-apply, auto-send, board discovery) are per-connector opt-in, not global switches.
2. Adapters authenticate with user-provided credentials (session cookies, SMTP creds, API keys) stored locally.
3. Sensitive answers (work authorization, criminal history, disability, demographic, security-clearance, legal attestations) still require explicit user input per application, even when auto-apply is enabled.
4. Greenhouse/Lever auto-apply uses public ATS APIs with no platform terms risk.
5. LinkedIn/Indeed adapters using session cookies carry real ToS risk (LinkedIn prohibits third-party automation, Indeed prohibits automated access without written permission). JobOS displays ToS risk warnings before enabling these connectors; the user explicitly acknowledges and accepts responsibility.
6. Using the latest draft when no approved artifact exists is a user-configured option (`useLatestDraftIfNoApproval`), not a default.

## Capability benchmark

Scale: **4 parity/advantage**, **3 strong**, **2 partial**, **1 scaffold**, **0 absent**. “Leader reference” identifies the strongest documented pattern, not a recommendation to copy it unchanged.

The 27 rows are intentionally equally weighted to make the raw inventory reproducible; the normalized 44/100 is diagnostic, not a roadmap score. Equal weighting avoids retrofitting weights to favor JobOS’s existing strengths. Product decisions instead use the separate P0/P1/P2 priority table, which considers user impact, dependency, risk reduction, and effort. Evidence confidence is **high** for current-state ratings backed by schema/command/function inspection and passing tests, **medium** for partial-behavior judgments and negative findings, and **low-to-medium** for relative “leader” comparisons that depend on vendor documentation. Missing public evidence is recorded as “not verified,” not proof of absence.

| Capability | Leader reference | JobOS | Evidence and gap |
|---|---|---:|---|
| Local data ownership/privacy | None of the reviewed SaaS tools | **4** | Local SQLite/workspace, no telemetry/cloud sync required. Clear JobOS advantage. |
| Agent-facing operability | No comparable public CLI/MCP found | **4** | Stable JSON CLI, loops, API, MCP, workspace mirror. Clear advantage. |
| Truth/evidence grounding | Jack principle; few expose claim lineage | **4** | Known proof IDs gate generated accomplishment claims. Clear advantage. |
| Career-intent onboarding | Jack voice/chat; Indeed Career Scout | **1** | Preferences schema exists, but onboarding is profile creation/resume parsing; no guided conversation, editable brief, or goal-conflict resolution. |
| Persistent candidate profile | Sprout/Simplify/Jack | **2** | Preferences and proof library exist; missing structured employment/education/contact identity, answer memory, freshness, and reuse scope. |
| Continuous multi-source discovery | Jack, Sprout, LoopCV, Indeed/LinkedIn | **2** | Saved/scheduled Greenhouse/Lever searches, dedupe, scoring; narrow source coverage and no permitted feed/plugin catalog. |
| Natural-language search/refinement | Indeed/LinkedIn | **0** | No query-to-search-plan or conversational refinement. |
| Feedback-learning loop | Jack, Indeed, LinkedIn, Simplify | **0** | No save/skip reason model, learned preference proposal, undo, or outcome-driven search adjustment. |
| Explainable fit | LinkedIn Job Match; JobOS proof scoring | **3** | Strong dimensional reasons and red flags; missing requirement-by-requirement evidence/missing-evidence map, user weights, and calibration history. |
| Company/stakeholder research | Indeed/LinkedIn; Jack alpha | **3** | Multi-query, URL-backed, conservative research and evidence-aware outreach are strong; current facts rely largely on search-result snippets, so a cited URL does not prove semantic entailment from the underlying page. |
| Resume/cover-letter content | Sprout/Simplify/Teal | **3** | Strong proof-grounded Markdown drafts; lacks full structured resume, layout preservation, PDF/DOCX export, variants, diffs, and exact final snapshot. |
| Artifact review/versioning | Sprout manual queue; Teal variants | **2** | Approval state and dashboard buttons exist; no immutable versions, field-level diff, reviewer comments, or “approved content hash.” |
| Answer bank/question escalation | Sprout, Simplify, LoopCV | **0** | No answer entity, question fingerprint, provenance, expiry, sensitivity, reuse boundary, or blocker queue. |
| Application form plan | LinkedIn Apply Assistant, Simplify | **0** | No target form schema, field mapping, confidence, unknown-field list, or conditional-question model. |
| Autofill/handoff | Simplify, LinkedIn Apply Assistant, Teal | **0** | No browser extension, clipboard manifest, local companion page, or ATS handoff. |
| Delegated submission | Sprout/ApplyIQ/Indeed beta/LoopCV | **0** | Intentionally absent under current instruction. Record as a governance-gated strategic gap, not P0 implementation. |
| Duplicate/idempotency control | Needed by all submission agents | **1** | Job dedupe exists; no per-employer application identity or packet hash, and current `sql.js` snapshot persistence has no all-writer cross-process lock. |
| Submission receipts | Sprout, LoopCV | **0** | Application `confirmation_url` exists but no command populates/verifies it and no receipt artifact/event exists. |
| Application tracking | Sprout, Teal, Indeed, Simplify | **3** | Status history, kanban, tasks, analytics are solid; external changes are manual and application artifact/answer snapshots are absent. |
| Inbox/status reconciliation | Sprout Gmail classification | **0** | No narrow mail import, local classifier, evidence link, or contradiction review. |
| Outreach/network path | Jack/Jill, LinkedIn, Simplify | **3** | Source-backed stakeholder research/drafting and follow-up tasks; no user-owned network import, warm-path graph, or permitted send connector. |
| Interview preparation | Jack, Indeed, Teal | **2** | Written, proof-backed packet; no interactive text/voice session, transcript, feedback rubric, or improvement history. |
| Salary/offer/negotiation | Jack, Indeed, Adzuna | **1** | Compensation is a score dimension; no offer entity, source-backed market range, scenario planning, or negotiation rehearsal. |
| Analytics/experimentation | Teal, LoopCV | **3** | Funnel/source/role analytics and weekly review; no artifact-version experiments, cohort caveats, or quality/effort metrics. |
| Automation reliability/audit | LoopCV long-running loops | **3** | Strong internal scheduler/audit/failure disable; missing resumable multi-step run graph and external-action receipt model. |
| Human control and exception review | LinkedIn/Simplify general flow; Sprout optional | **2** | Artifacts can be approved, but there is no complete application-level review or typed risk escalation. |
| Terms-aware connector governance | LinkedIn/Indeed own integrations | **1** | No connector capability manifest, permission record, terms review date, or allowed-action enforcement; future plan contains unsafe cookie/scraping proposals. |

**Overall:** 47/108, normalized to **44/100**, across 27 equally weighted capabilities. This number is directional, not a market-quality score. JobOS is high-quality in its implemented core, but the application-execution bridge and learning/coaching surfaces are largely absent.

## Direct benchmark by product

| Product | Where JobOS is at/above parity | Material gaps vs that product | Ethical/architectural adaptation |
|---|---|---|---|
| Jack | Proof-grounded tailoring, source-backed company/stakeholder research, tracker, agent interfaces, privacy | Conversational career brief, continuous broad search, feedback refinement, voice mock interviews, salary/negotiation, managed introductions | Local conversation-to-brief; explicit feedback rules; voice/text rehearsal; user-provided network graph. Do not auto-share profiles. |
| Sprout | Stronger proof provenance, local privacy, research, scheduler audit | Structured profile, targeted question memory, application review queue, form execution, exact sent artifacts, receipts, inbox/status sync | Build risk-aware answer/packet review and auto-apply adapters. Do not create employer accounts, solve CAPTCHAs, or bypass anti-bot; fail gracefully instead. |
| Indeed | Local privacy, source transparency, proof grounding, general CLI/API | Natural-language career/search agent, integrated company/salary data, resume builder, voice practice, native application prefill/tracking, limited Apply For Me | Query-to-search plans and local career coach; Indeed session-cookie adapter with ToS risk warning; application packet/auto-apply. |
| LinkedIn | Local ownership, claim evidence, company dossiers | Professional graph, semantic search, match summaries, Apply Assistant prefill, resume feedback, recruiter context | User-imported connections; requirement-proof explanation; LinkedIn session-cookie discovery adapter with ToS risk warning. |
| Simplify | Evidence grounding, research, audit, scheduler | Broad ATS detection/autofill, answer reuse, tracker capture, artifact versions, feedback learning, AI interviewer, private Autopilot | Local auto-apply adapters; typed answer bank; immutable packet/receipt; user-configured auto-send matching Autopilot's value with local control. |
| Teal | Agent automation, proof IDs, research, scheduler | Structured master resume/variants, polished exports, rich tracker metadata, interactive interview practice | Resume document model/version/diff/export; richer pipeline metadata; interview sessions. |
| LoopCV | Truthfulness, privacy, research, scheduler audit | Multi-board loops, email/form execution, questions, tracker analytics, A/B testing | Adopt resumable loop states, blockers, exclusions, and experiment metadata; adopt auto-apply and auto-send with per-connector config and audit. |
| Adzuna ApplyIQ | Research/proof/audit | Broad corpus, salary intelligence, quality-thresholded delegated apply | Adopt application-value threshold and caps for auto-apply; user-configured delegated submission with match floors and daily limits. |

## Prioritized gaps

Effort assumes one experienced engineer in this Node/sql.js architecture and includes tests/docs, not browser-store review or third-party partnership lead time.

| Priority | Gap | Impact | Effort | Why now / dependency |
|---|---|---:|---:|---|
| **P0** | Typed answer bank + sensitivity/provenance policy | Very high | 4–6 days | Foundational for every application workflow; prevents generated legal/sensitive answers. |
| **P0** | Immutable application packet + risk-based review | Very high | 5–8 days | Turns existing job/proof/artifacts into a complete, auditable unit; prerequisite to handoff. |
| **P0** | Application plan/dry-run + blocker taxonomy | Very high | 3–5 days | Gives agents and humans an honest readiness report before any browser action. |
| **P0** | Receipt/confirmation and idempotency model | High | 3–5 days | Avoids duplicate applications and false `applied` state; prerequisite to any future connector. |
| **P0** | Global `sql.js` writer coordination and crash-safe persistence | Very high | 4–7 days | Prevents stale CLI/web/MCP/scheduler snapshots from overwriting one another; prerequisite to trusting any identity, packet, or receipt constraint. |
| **P1** | Auto-apply adapters (Greenhouse/Lever public ATS) | Very high | 6–10 days | Closes the largest time-saving gap via public ATS APIs; depends on P0 packet. User-configured per-connector enablement. |
| **P1** | Structured resume model, versions, diff, PDF/DOCX export | High | 6–10 days | Commercial parity and reliable exact-artifact ledger; depends on artifact versioning. |
| **P1** | Explicit match feedback and reversible preference learning | High | 4–6 days | Jack/Indeed/Simplify differentiation; improves discovery quality before expanding volume. |
| **P1** | Auto-send outreach via SMTP | High | 3–5 days | Closes outreach delivery gap; user-configured SMTP credentials; depends on outreach draft. |
| **P1** | Board discovery connectors (LinkedIn/Indeed session-cookie) | High | 6–10 days | Broadens discovery; user-provided session credentials with ToS risk warnings; depends on connector manifest. |
| **P1** | Narrow local email/file reconciliation | Medium/high | 4–6 days | Reduces manual tracking; depends on receipt/timeline model and privacy threat model. |
| **P2** | Conversational career brief/search planner | High | 5–8 days | Strong UX differentiation; can remain provider-optional with deterministic prompts. |
| **P2** | Interactive text/voice mock interview with rubric history | Medium/high | 8–12 days | Extends existing packet/proof model; microphone/transcript privacy needs explicit design. |
| **P2** | Offer + salary evidence + negotiation packet | Medium | 4–6 days | Closes late-funnel parity after core apply flow is coherent. |
| **P2** | User-owned network import and warm-path mapping | Medium | 4–6 days | Jack/LinkedIn value with user-provided data; requires data-import consent model. |

## Contradictions and documentation debt to resolve

1. `PLAN_EXPANDED_TOOLS.md` is the active product direction (auto-apply, auto-send, board adapters, latest-draft fallback). It is no longer superseded. F0 must implement the policy engine that makes these user-configured capabilities executable.
2. `AGENTS.md` has been updated (2026-07-13) to reflect user-configured automation. Profile `automationPolicy` values (`user_configured`) and scheduler config must be centralized and enforced by F0's policy engine.
3. `src/tracking.js:5` creates a "Human-gated review" task. This wording should be updated to reflect user-configured review (review-by-exception when auto-apply is enabled, manual review when disabled).
4. The `approval_status` column has no artifact version, approver, timestamp, content hash, or rejection reason, so "approved" cannot prove what content was approved. F6 must add artifact versioning.
5. PR #2's generated/dashboard strings implying configurable auto-apply/auto-send are correct — the capability is planned. F0 must implement the executor, not remove the strings.
6. The expanded-plan body at `PLAN_EXPANDED_TOOLS.md:175` claims CLI artifact approval, but approval exists only through the dashboard/API. This should be implemented as part of F6.
7. Using unapproved drafts (`PLAN_EXPANDED_TOOLS.md:119`) is a user-configured option (`useLatestDraftIfNoApproval`), not a default. The policy engine must enforce this.

## Exit criteria for meaningful parity

JobOS can reasonably claim **user-configured application parity** when all of the following are demonstrated end to end:

- A user can import/select a job, see a requirement-to-proof and match explanation, and give structured match feedback.
- JobOS produces a complete application plan with exact artifacts, field answers, source/proof lineage, unknowns, sensitive-field blocks, and target URL.
- New/stale/sensitive/unsupported answers require review; unchanged verified identity fields do not create review fatigue.
- Approval binds to immutable content hashes. When auto-apply is enabled, the approved packet is the submission target. When `useLatestDraftIfNoApproval` is configured, the latest draft is used with a recorded warning.
- When auto-apply is enabled for a connector, the adapter submits the approved packet, records the submission confirmation, and moves the packet to `submitted`. When auto-apply is disabled, the user may use handoff/clipboard mode and manually attest submission.
- Auto-send outreach via SMTP delivers approved outreach drafts and records delivery confirmation when configured.
- Sensitive answers (work authorization, criminal history, disability, demographic, security-clearance, legal attestations) always require explicit user input, even when auto-apply is enabled.
- Duplicate target/profile applications are detected before submission or handoff.
- Multi-process write coordination proves no lost updates or duplicate identity across CLI/API/MCP/scheduler mutators.
- The tracker records exact artifact/answer versions and reconciles later changes without claiming certainty it does not have.
- All connectors declare permissions, allowed actions, data classes, terms-review date, and test fixtures. LinkedIn/Indeed session-cookie connectors display ToS risk warnings and require explicit user acknowledgment before enabling.
- CLI `--json`, REST, MCP, workspace mirrors, audit events, tests, README contract, and smoke flow all cover the same lifecycle.

Delegated auto-apply and auto-send are user-configured capabilities, not strategic gaps. The user bears responsibility for platform terms compliance on authenticated-board adapters.

## Version history
- **v2.0 — 2026-07-13:** Reversed human-gated direction to user-configured automation per PR #2 and user direction. Prioritized auto-apply, auto-send, and board adapters. Removed PLAN_EXPANDED_TOOLS.md supersession. Updated exit criteria for user-configured parity including delegated submission.

- **v1.6 — 2026-07-11:** Reconciled verification at 41/41 and the strengthened behavioral policy tests with the exact reviewed worktree.
- **v1.5 — 2026-07-10:** Identified the worktree baseline explicitly and promoted cross-process `sql.js` durability/lost-write risk into the evidence, benchmark, P0 priorities, and parity exit criteria.
- **v1.4 — 2026-07-10:** Re-audited after runtime policy-default normalization; distinguished historical PR #2 labels from current human-gated metadata and retained F0 as the required policy-engine gap.
- **v1.3 — 2026-07-10:** Updated the benchmark to competitive analysis v1.4, recorded remediation of misleading runtime copy, and made user attestation a mandatory predecessor to external confirmation.
- **v1.2 — 2026-07-10:** Added weighting/evidence rationale, refreshed documentation debt against the edited worktree, and aligned submitted/confirmed semantics after provisional evaluation.
- **v1.1 — 2026-07-10:** Added independent repository-audit defects and documentation drift; corrected the normalized capability score.
- **v1.0 — 2026-07-10:** Initial code-evidenced benchmark against competitive analysis v1.2; incorporated merged PR #2 policy changes, current AGENTS constraints, third-party terms, prioritized gaps, and parity exit criteria.
