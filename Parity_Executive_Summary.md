# JobOS Agentic Apply Parity — Executive Summary

**Date:** 2026-07-13  
**Version:** v2.0  
**Code baseline:** `c5ef87b` / `origin/main` (PR #2 active, no worktree normalization diff)  
**Evidence:** `Competitive_Feature_Analysis.md` v2.0; `Gap_Analysis_and_Benchmark.md` v2.0; `Feature_Adaptation_Plan.md` v2.0.

## Decision summary

JobOS should pursue **user-configured application parity** — auto-apply, auto-send, and board discovery adapters that the user explicitly configures and enables.

The market now spans three models. Jack & Jill remains a deep career/search/coaching agent that deliberately does not submit web applications. LinkedIn Premium Apply Assistant, Simplify Copilot, and Teal prepare or fill applications while the user reviews and submits. Sprout, LoopCV, Adzuna ApplyIQ, Indeed's new limited Apply For Me beta, and Simplify's private Autopilot can submit on the candidate's behalf. JobOS will combine the best of the delegated-submission model with local-first privacy and proof-grounded trust: auto-apply through ATS adapters (Greenhouse/Lever public, LinkedIn/Indeed session-cookie with ToS risk warnings), auto-send outreach via SMTP, and user-controlled quality budgets.

JobOS already has a differentiated foundation:

- local SQLite plus an agent-readable workspace;
- stable CLI JSON, REST, MCP, loops, and audit records;
- proof-point grounding that rejects unsupported accomplishments;
- source-backed company/stakeholder research;
- fit scoring, tailored drafts, application status history, tasks, funnel analytics, and internal scheduler automation;
- no required cloud account, telemetry, or paid provider.

But JobOS is not an application agent yet. It ends at Markdown drafts and manual status changes. The directional benchmark is **44/100** across 27 parity capabilities: excellent in trust/agent foundations, mostly absent in the bridge from "materials ready" to "application truthfully submitted and confirmed." PR #2 established the `user_configured` direction; this plan implements the executors.
+
## Highest-ROI build sequence

### 1. Build the application transaction (P0)

Add a typed local answer vault, an application compiler, immutable per-job packets, risk-based review, idempotency, and receipt states.

The packet should contain the target, exact artifact versions, field answers, proof/source lineage, freshness, sensitivity, confidence, unknowns, blockers, duplicate check, and policy snapshot. Approval binds to a content hash. When auto-apply is enabled, the adapter submits the approved packet and records the receipt. When auto-apply is disabled, the user may use handoff/clipboard mode and manually attest submission.

This single architecture closes the most important gaps against Sprout, Simplify, LinkedIn Apply Assistant, Teal, and LoopCV while strengthening JobOS's existing evidence advantage.

### 2. Add auto-apply and auto-send adapters (P1)

Build auto-apply adapters for Greenhouse/Lever (public ATS APIs, no platform terms risk) first, then LinkedIn/Indeed (session-cookie auth with ToS risk warnings). Build auto-send outreach via SMTP with user-configured credentials. Add a browser/copy handoff as a fallback for unsupported sites.

The user explicitly configures and enables each connector per-profile. Quality budgets (match floors, daily caps, exclusions, cooldowns) constrain volume. Sensitive answers always require explicit user input even when auto-apply is enabled.

### 3. Make artifacts production-grade (P1)

Introduce a structured resume model, immutable versions, proof-linked diffs, deterministic PDF export, and exact final snapshots. Today’s Markdown drafts are trustworthy but not sufficient for mainstream application flow parity.

### 4. Add explicit learning (P1)

Store save/skip/apply reasons and outcome signals. Let JobOS propose reversible preference changes and compile natural-language intent into a visible search plan. Never silently infer protected traits or mutate the canonical profile.

### 5. Broaden discovery and deepen coaching (P1/P2)

Add LinkedIn/Indeed session-cookie discovery adapters with ToS risk warnings. Add Ashby/import/feed connectors. Then add user-selected `.eml` status reconciliation, interactive proof-aware interview practice, offer/negotiation workspace, and user-owned network import.

## Ethics and Terms position

Merged PR #2 changed policy labels to `user_configured`, removed social-domain result filtering, and established user-configured automation as the product direction. It explicitly retained proof grounding, source URLs, audit logs, and artifact review state as data-integrity controls.

`AGENTS.md` has been updated (2026-07-13) to reflect this direction. `PLAN_EXPANDED_TOOLS.md` is the active implementation roadmap for auto-apply, auto-send, and board adapters. LinkedIn's User Agreement prohibits third-party automation and Indeed's ToS prohibits automated access without written permission — these are real contractual risks. JobOS addresses this by displaying ToS risk warnings before enabling authenticated-board connectors and requiring explicit user acknowledgment. The user bears responsibility for platform terms compliance.

The implementation plan makes policy typed and executable with `user_configured` external actions. Auto-apply and auto-send are per-connector opt-in capabilities, not global switches. They include immutable approvals, sensitive-answer rules, caps, idempotency, receipts, and external-action audits as safety controls.

## Risk warnings

- LinkedIn/Indeed session-cookie adapters carry real ToS risk; JobOS displays warnings and requires acknowledgment before enabling.
- CAPTCHA bypass and employer-account creation are not supported; adapters fail gracefully.
- Automatic generation/submission of work-authorization, demographic, disability, veteran, criminal-history, compensation-commitment, security-clearance, or legal-attestation answers is always blocked; these require explicit user input.
- Using the latest draft when no artifact is approved is a user-configured option, not a default.
- A global auto-apply switch is not provided; control is per connector, per profile, with match thresholds and daily caps.
- Claims that marketing lift or local correlations prove causal hiring outcomes are not made.

## Implementation shape

The plan is organized into five sprints:

1. **Trust and durability foundation:** typed policy, `sql.js` write coordination, URL-import/host/profile-scope fixes.
2. **Application data foundation:** answer vault, packet schema/compiler, blockers, CLI/API/MCP/workspace surfaces.
3. **Auto-apply and auto-send adapters:** Greenhouse/Lever auto-apply, SMTP auto-send, receipts, exception queue, end-to-end smoke.
4. **Board adapters and quality:** LinkedIn/Indeed session-cookie discovery with ToS warnings, artifact versions/PDF, feedback learning, connector SDK.
5. **Career-agent depth:** editable brief, interview sessions/optional voice, offers, negotiation, network import.

Every feature has concrete data contracts, command proposals, acceptance criteria, risks, and test gates in `Feature_Adaptation_Plan.md`.

With 1–2 experienced engineers, the dependency-derived parity critical path is estimated at 8–12 elapsed weeks. The schema → answer vault → packet compiler → auto-apply adapter paths are deliberately sequential. Browser-store review, partner permission, or a connector no-go is outside the range.
+
## Parity claim and remaining gaps

After the first four sprints, JobOS can claim meaningful parity with top **application agents** including Sprout, LoopCV, and ApplyIQ if an end-to-end test proves:

- explained fit and explicit user feedback;
- a complete evidence-linked application packet;
- mandatory review for new/stale/sensitive/unsupported fields;
- immutable approval and exact artifact/answer versions;
- auto-apply through configured adapters with recorded receipts and duplicate prevention;
- auto-send outreach via SMTP with delivery confirmation;
- user-configured quality budgets (match floors, daily caps, exclusions);
- consistent CLI, API, MCP, dashboard, workspace, audit, docs, tests, and smoke behavior.

Strategic gaps will remain: no proprietary job corpus, recruiter marketplace, universal ATS coverage, employer-side status network, mobile-native app, or large-cohort outcome evidence. These require partnerships and distribution, not engineering shortcuts.

## Deliverables

- `Competitive_Feature_Analysis.md` — current platform evidence, capability inventory/matrix, strengths, weaknesses, legal boundaries, and sources.
- `Gap_Analysis_and_Benchmark.md` — code/PR-evidenced current-state benchmark, prioritized gaps, defects, documentation drift, and parity exit criteria.
- `Feature_Adaptation_Plan.md` — implementation architecture, schema/state machines, ten feature specs, swarm tickets, acceptance tests, risks, and evaluation plan.
- `Parity_Evaluation_Log.md` — independent evaluator rubric, scores, feedback, and remediation history.


## Version history

- **v2.0 — 2026-07-13:** Reversed from human-gated "assisted-apply" to user-configured application parity. Embraced auto-apply, auto-send, and board adapters per PR #2. Reduced timeline from 17-23.5 to 8-12 weeks with 1-2 engineers. Renamed "What not to build" to "Risk warnings."
- **v1.5 — 2026-07-11:** Updated the reviewed evidence package after attempt/version, hash, migration, persistence-boundary, ticket-estimate, and behavioral-test hardening.
- **v1.4 — 2026-07-10:** Corrected the parity milestone to Sprint E, identified the worktree baseline, added cross-process durability to Sprint A, and published staffing/critical-path assumptions.
- **v1.3 — 2026-07-10:** Updated evidence versions after current runtime policy defaults were normalized to the documented human-gated contract.
- **v1.2 — 2026-07-10:** Updated source versions and made user attestation an explicit mandatory predecessor to `applied` and external confirmation.
- **v1.1 — 2026-07-10:** Aligned source document versions, attestation/confirmation semantics, and historical-plan supersession language after provisional evaluation.
- **v1.0 — 2026-07-10:** Initial executive summary of evidence, decision, sequencing, policy position, parity claim, and remaining strategic gaps.
