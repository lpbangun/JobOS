# Parity Evaluation Log

## Gate

The supplied brief requested a fresh independent Claude evaluator to score 8–10 dimensions, with every dimension and the average at least 9/10. Claude authentication was unavailable. On 2026-07-11 the user explicitly authorized OpenCode as the replacement evaluator and specified `opencode-go/kimi-k2.7-code`; the accepted replacement gate below uses that model in OpenCode's no-edit `summary` agent.

## Iteration 0 — Claude invocation unavailable

**Date:** 2026-07-10  
**Evaluator requested:** fresh local Claude Code process  
**Command mode:** non-interactive, read-only tools for the four deliverables, repository context, and PR diff  
**Result:** No evaluation occurred. The installed Claude Code CLI returned `Not logged in · Please run /login` before reading files. Neither `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is configured.

This is not a failed rubric score and not a pass. No score is invented. The independent-Claude exit gate remains open.

## Iteration 1 — Claude invocation retried after remediation

**Date:** 2026-07-10  
**Evaluator requested:** fresh local Claude Code process, read-only independent review of the four deliverables plus repository/PR context  
**Result:** No evaluation occurred. The CLI again returned `Not logged in · Please run /login` before it could read files. This repeats the same external authentication blocker; it is neither a score nor a pass.

## Iteration 2 — Claude invocation retried on 2026-07-11

**Evaluator requested:** fresh local Claude Code process with the three core documents, executive summary, repository, PR, and policy context  
**Result:** No evaluation occurred. The installed Claude Code 2.1.205 process again returned `Not logged in · Please run /login` before file access. No rubric score is inferred or substituted.

## Iteration 3 — Claude invocation retried on 2026-07-11

**Evaluator requested:** fresh local Claude Code process with the complete independent-review prompt  
**Result:** No evaluation occurred. The process again returned `Not logged in · Please run /login` before reading files. This is the fourth recorded invocation failure and the third consecutive continuation blocked by the same external authentication condition. The independent-Claude ≥9/10 exit criterion is therefore unverified, not failed or waived.

## Iteration 0A — provisional independent review

**Status:** Completed; did not pass the requested threshold.  
**Purpose:** Use a fresh-context independent agent to identify and remediate document defects while Claude authentication is unavailable.  
**Authority:** Diagnostic only; cannot satisfy the Claude-specific exit condition.

### Provisional scores before remediation

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 8 |
| Competitor coverage | 8 |
| Current-code fidelity | 8 |
| PR #2 / ethics / ToC / instruction fidelity | 9 |
| Gap-analysis rigor | 8 |
| Creative synthesis/downstream thinking | 9 |
| Architecture feasibility | 7 |
| Swarm actionability/acceptance criteria | 8 |
| Traceability/internal coherence | 7 |
| Professionalism/completion | 8 |
| **Average** | **8.1** |

### Localized feedback and remediation

1. Corrected stale version headers and unsupported matrix cells; added a matrix evidence map, product-selection rationale, and excluded-adjacent-products note in competitive analysis v1.3.
2. Refreshed documentation debt against the edited worktree, explained diagnostic equal weighting/evidence confidence, and aligned attested/confirmed semantics in gap analysis v1.2.
3. Added enforceable answer/artifact versioning, application identity/idempotency, packet event history, foreign keys/checks/indexes, answer retirement, packet/asset/item hashes, receipt snapshots/evidence hashes, and RFC 8785/SHA-256 canonical hash rules in feature plan v1.1.
4. Split `attest-submitted` from `confirm-receipt`, made sensitive reveal behavior executable, and aligned the hard assertions and executive language.
5. Added evidence → gap → feature → ticket → test traceability and a file/interface/fixture/dependency contract for every swarm ticket.

**Re-evaluation status:** Awaiting a fresh evaluator. The provisional scores above are not reused as post-remediation scores.

## Iteration 0B — second provisional independent review

**Status:** Completed; did not pass the requested threshold.  
**Authority:** Diagnostic only; cannot satisfy the Claude-specific exit condition.

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 8 |
| Competitor coverage | 9 |
| Current-code fidelity | 9 |
| PR #2 / ethics / ToC / instruction fidelity | 8 |
| Gap-analysis rigor | 9 |
| Creative synthesis/downstream thinking | 9 |
| Architecture feasibility | 8 |
| Swarm actionability/acceptance criteria | 8 |
| Traceability/internal coherence | 8 |
| Professionalism/completion | 9 |
| **Average** | **8.5** |

### Localized feedback and remediation

1. Removed overclaimed competitive cells, split receipt evidence from tracking, and added cell-level lifecycle citations in competitive analysis v1.4.
2. Replaced misleading current-product auto-apply/auto-send copy across README, agent guide, dashboard, tailoring, outreach, research, and scheduler outputs.
3. Defined one ordered receipt lifecycle: current-packet user attestation is mandatory before `applied`; external confirmation can only follow `user_submitted`.
4. Added reviewer identity, explicit reject/return events and transitions, canonical employer/requisition keys, database-backed idempotency, and audited next-attempt overrides.
5. Added deterministic fixture counts and scoring thresholds, distinguished a connector `no_go` from parity success, and serialized shared-file integration ownership.

## Iteration 0C — third provisional independent review

**Status:** Completed; did not pass the requested threshold.  
**Authority:** Diagnostic only; cannot satisfy the Claude-specific exit condition.

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 9 |
| Competitor coverage | 9 |
| Current-code fidelity | 8 |
| PR #2 / ethics / ToC / instruction fidelity | 9 |
| Gap-analysis rigor | 8 |
| Creative synthesis/downstream thinking | 9 |
| Architecture feasibility | 7 |
| Swarm actionability/acceptance criteria | 8 |
| Traceability/internal coherence | 8 |
| Professionalism/completion | 9 |
| **Average** | **8.4** |

### Localized feedback and remediation

1. Identified the reviewed state as `c5ef87b` plus an exact implementation-manifest snapshot hash rather than implying a clean-commit baseline.
2. Promoted `sql.js` stale-snapshot/lost-write risk to P0; added an all-mutator lock/reload/revision/atomic-save contract, sole integration owner, and 12-process/crash/stale-lock fixtures.
3. Required external-confirmation evidence, receipt idempotency/uniqueness, explicit dispute-to-unknown events, and immutable active packet-version supersession semantics.
4. Corrected the parity milestone to Sprint E and published staffing plus an 8.5–13.5-week A–E critical path.
5. Added the previously proposed `tests/docs-policy.test.js`; the full suite now passes 40/40.
6. Added independent corroboration/risk signals, qualified conflicting Jack onboarding copy, and introduced a high-risk matrix-cell evidence ledger with conservative downgrades.

## Iteration 0D — fourth provisional independent review

**Status:** Completed against v1.5/v1.5/v1.4/v1.4; did not pass the requested threshold.  
**Authority:** Diagnostic only.

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 9 |
| Competitor coverage | 9 |
| Current-code fidelity | 8 |
| PR #2 / ethics / ToC / instruction fidelity | 9 |
| Gap-analysis rigor | 9 |
| Creative synthesis/downstream thinking | 9 |
| Architecture feasibility | 8 |
| Swarm actionability/acceptance criteria | 8 |
| Traceability/internal coherence | 8 |
| Professionalism/completion | 8 |
| **Average** | **8.5** |

### Localized feedback and remediation

1. Reconciled the current test count and replaced literal-only policy checks with behavioral CLI/API/dashboard/MCP/scheduler/artifact tests.
2. Separated one active `application_attempt` per identity from one current packet version per attempt.
3. Published the exact canonical JSON hash projection and stable-domain-ID/sort rules.
4. Added deterministic legacy artifact version-1 backfill with mandatory re-review of unverified legacy decisions.
5. Made raw persistence private to `mutateStore()`, added import-graph enforcement, and specified stale-read/failure reload behavior.
6. Added named owners/person-days to every ticket and recalculated the A–E critical path to 17–23.5 weeks.
7. Converted the displayed competitor matrix itself into a classed, directly sourced canonical ledger with a mechanical-check contract.

## Iteration 4 — accepted OpenCode replacement evaluation

**Date:** 2026-07-11  
**Evaluator:** fresh OpenCode `summary` agent using `opencode-go/kimi-k2.7-code` with high reasoning; attached deliverables, AGENTS.md, README, and BUILD_PROGRESS; no edit permission.  
**Authority:** Accepted replacement for the unavailable Claude gate, explicitly authorized by the user.  
**Scope note:** The evaluator audited the attached final deliverables and governing product/docs context. The orchestrator separately verified the live worktree with the policy-contract test, full test command, smoke result, and `git diff --check`.

| Dimension | Score |
|---|---:|
| Competitor research / source quality | 9 |
| Competitor coverage | 9 |
| Current-code fidelity | 9 |
| PR ethics / ToC fidelity | 9 |
| Gap rigor | 9 |
| Creative feasible adaptation | 9 |
| Implementation actionability | 9 |
| Traceability / coherence | 9 |
| Professionalism | 9 |
| **Average** | **9.0** |

**Verdict:** **PASS.** Every dimension and the average meet the required threshold. The evaluator reported no localized remediation. Its rubric and cited sections are retained in OpenCode session `ses_0b1e21a2bffecY55WaI9e9F6Gl` (model `opencode-go/kimi-k2.7-code`, no edits).

## Iteration 5 — accepted replacement rerun on the hardened final package

**Date:** 2026-07-11  
**Evaluator:** fresh OpenCode `summary` agent using `opencode-go/kimi-k2.7-code` with high reasoning and no edit permission.  
**Exact inputs:** competitive v1.6, gap v1.6, feature plan v1.5, executive v1.5, objective attachments, current AGENTS/README/BUILD/historical-plan context, and implementation snapshot `sha256:0bf8a1d7e9310af8e447a00f06f9b944f4977fa1744a93b8ab90f8ceb6137be6`.

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 9 |
| Competitor coverage | 9 |
| Current-code fidelity | 9 |
| PR #2 / ethics / ToC / current-instruction fidelity | 9 |
| Gap-analysis rigor | 9 |
| Creative/downstream synthesis | 9 |
| Architecture feasibility | 9 |
| Implementation-swarm actionability/acceptance criteria | 9 |
| Traceability/internal coherence | 9 |
| Professionalism/completion | 9 |
| **Average** | **9.0** |

**Verdict:** **PASS.** Every dimension and the average meet the accepted replacement threshold; no localized remediation was requested. This rerun supersedes Iteration 4 for the current deliverables. Full output is retained in OpenCode session `ses_0b1d84a0affeWHzMV7jHMD1off`.

## Iteration 6 — final accepted gate on the stable implementation snapshot

**Date:** 2026-07-11  
**Evaluator:** fresh no-edit OpenCode `summary` agent, `opencode-go/kimi-k2.7-code`, high reasoning.  
**Exact implementation snapshot:** `sha256:b2ef3d05d6c420143ffe0e82cc7d2f70a5bf34940df49fe2b362600683c14634`; mutable progress/evaluation logs excluded from the hash by design.

| Dimension | Score |
|---|---:|
| Research depth/current accuracy/source quality | 9 |
| Competitor coverage | 9 |
| Current-code fidelity | 9 |
| PR #2 / ethics / ToC / current-instruction fidelity | 9 |
| Gap-analysis rigor | 9 |
| Creative/downstream synthesis | 9 |
| Architecture feasibility | 9 |
| Implementation-swarm actionability/acceptance criteria | 9 |
| Traceability/internal coherence | 9 |
| Professionalism/completion | 9 |
| **Average** | **9.0** |

**Verdict:** **PASS.** The evaluator explicitly verified the canonical classed matrix, snapshot identity, `sql.js` writer boundary, identity→attempt→packet-version model, hash projection, legacy-artifact migration, receipt invariants, behavioral policy tests, owner/person-day DAG, and 17–23.5-week path. No remediation was requested. Final session: `ses_0b1d573d2ffeavqZ45rpsxe305`.

## Deliverables presented for evaluation

- `Competitive_Feature_Analysis.md`
- `Gap_Analysis_and_Benchmark.md`
- `Feature_Adaptation_Plan.md`
- `Parity_Executive_Summary.md`
- Objective and success rubric from the supplied attachments
- Current `AGENTS.md`, README, BUILD_PROGRESS, expanded plan, source code, tests, and `6e75348..c5ef87b` PR diff as verification context

## Iteration history

| Iteration | Evaluator | Result | Remediation |
|---|---|---|---|
| 0 | Claude Code 2.1.205 | Not run — authentication unavailable | Run provisional independent audit; retain open Claude gate. |
| 1 | Claude Code 2.1.205 | Not run — authentication unavailable on retry | Authentication is required before the named independent evaluator can assess the remediated deliverables. |
| 2 | Claude Code 2.1.205 | Not run — authentication unavailable on 2026-07-11 retry | Same authentication blocker; no independent score exists. |
| 3 | Claude Code 2.1.205 | Not run — authentication unavailable on 2026-07-11 retry | Fourth recorded invocation failure; independent exit gate remains unverified. |
| 0A | Fresh-context non-Claude agent | 8.1 average; minimum 7; no pass | Applied localized remediation in competitive v1.3, gap v1.2, feature plan v1.1, and executive v1.1. |
| 0B | Fresh-context non-Claude agent | 8.5 average; minimum 8; no pass | Applied lifecycle, evidence, runtime-copy, idempotency, evaluation-anchor, and ownership remediation; final policy-normalization edits are in competitive v1.4, gap v1.4, feature plan v1.3, and executive v1.3. |
| 0C | Fresh-context non-Claude agent | 8.4 average; minimum 7; no pass | Remediated exact baseline identity, cross-process durability, receipt/packet invariants, milestone/staffing, policy regression tests, and cell-level evidence in competitive v1.5, gap v1.5, feature plan v1.4, and executive v1.4. |
| 0D | Fresh-context non-Claude agent | 8.5 average; minimum 8; no pass | Remediated attempt/version separation, exact hash projection, artifact migration, persistence boundary, DAG estimates, behavioral policy tests, and canonical cell ledger in competitive v1.6, gap v1.6, feature plan v1.5, and executive v1.5. |
| 4 | OpenCode `opencode-go/kimi-k2.7-code` summary agent | 9.0 average; every dimension 9; **PASS** | User-authorized replacement evaluator; no further remediation requested. |
| 5 | OpenCode `opencode-go/kimi-k2.7-code` summary agent | 9.0 average; every dimension 9; **PASS** | Current hardened package; session `ses_0b1d84a0affeWHzMV7jHMD1off`; no remediation requested. |
| 6 | OpenCode `opencode-go/kimi-k2.7-code` summary agent | 9.0 average; every dimension 9; **PASS** | Stable snapshot `b2ef3d05…c14634`; session `ses_0b1d573d2ffeavqZ45rpsxe305`; no remediation requested. |
| 7 | User-directed revision | N/A — direction reversal | Reverted human-gated normalization; updated AGENTS.md and all deliverables to user-configured automation (v2.0). Prior PASS scores superseded. |

## Iteration 7 — user-directed revision to user-configured automation

**Date:** 2026-07-13
**Authority:** User explicitly directed reversal of the human-gated "assisted-apply" direction to embrace user-configured auto-apply, auto-send, and board adapters per PR #2. User selected "User-configured, user-bears-risk" for LinkedIn/Indeed scope.
**Action:** Reverted all worktree code normalization that had changed `user_configured` labels to `user_performed`/`not_supported`. Updated `AGENTS.md` to reflect user-configured automation as the product direction. Revised all four parity deliverables (Competitive v2.0, Gap v2.0, Feature Plan v2.0, Executive Summary v2.0) to embrace auto-apply, auto-send, LinkedIn/Indeed session-cookie adapters with ToS risk warnings, and using latest drafts as a user-configured option. Streamlined schema from 11 to ~6 tables and reduced timeline from 17-23.5 to 8-12 weeks.
**Test verification:** `npm test` passed 38/38 on reverted PR #2 baseline (no worktree normalization diff). `tests/docs-policy.test.js` was removed as it enforced the reversed human-gated direction.
**Status:** The prior Iteration 4-6 PASS scores (9.0 average) were scored against the human-gated direction and are superseded by this revision. A fresh evaluation against the v2.0 user-configured package has not yet been run.
