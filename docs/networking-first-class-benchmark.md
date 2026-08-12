# Networking first-class benchmark

**Iteration:** 1  
**Method:** Independent static audit of current `src/`, `tests/`, `README.md`, and `docs/CONFIGURATION.md`. No implementation edits. Tests, formatters, and linters were not run.  
**Overall verdict:** **PASS** (all requested deliverables pass; residual risks are non-blocking)

## Evidence table

| # | Deliverable | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Exact normalized-email resolution and index | **PASS** | `normalizeEmail` trims/`mailto:`/query/`toLowerCase` (`src/research/sources.js`). `findPersonByEmail` / `resolvePerson` query `contact_points.normalized_value` for `type IN ('email','generic_inbox')` (`src/research/people.js`). Partial index `idx_contact_points_email_normalized` on `normalized_value` with the same type predicate (`src/db.js`). Covered by `tests/networking-first-class.test.js` (case/whitespace lookup + index SQL). |
| 2 | CLI/domain outputs and mediation redaction | **PASS** | Trusted CLI `people find` reveals values (`src/cli.js` → `findPersonByEmail(..., { revealContacts: true })`). Domain `find_person` reveals only for `cli`/`tui`; MCP/agent path returns `contactSummary` without values (`src/domain-tools.js`). `src/mcp.js` hardcodes `{ source: 'mcp' }` (env `JOBOS_MEDIATION` cannot elevate reveal). README documents both commands. |
| 3 | Email research create-or-resolve | **PASS** | Person-scope run with `--email` / `email` validates, then `resolvePerson` with `sourceRecordId: person-scope:email:<normalized>` and stages a contact at tier `D`, `verification_status: research_input_unverified`, default `human_approved=0` (`src/research/runs.js`, `upsertContactPoint`). Domain `start_people_research` + CLI `research people` wired. Asserted in `tests/networking-first-class.test.js`. |
| 4 | Exa `category=people` adapter, key preflight, evidence/contact staging and trust tier | **PASS** | Adapter POSTs `category: 'people'` with `x-api-key` (`src/research/adapters/exa-people.js`); registered as `exa-people` / source `exa_people`. `createResearchRun` fails closed with `exa_people_preflight_failed` when `EXA_API_KEY` missing (`src/research/runs.js`). Observations carry email contexts; `verifyObservationContacts` stages contacts with observation linkage, default unapproved; Exa third-party cases land at tier `D` (`src/research/contacts.js`). Docs: `docs/CONFIGURATION.md` Exa people section; tests cover staging + preflight. |
| 5 | All agent mirrors | **PASS** | Job `contacts.yaml` policy `valuesRedacted: true` + summary only (`syncContacts`). Source mirrors use `agentSafeObservation` / `redactEmailValues` and drop `emailContexts` (`src/research/sources.js`). Run mirrors persist counts/IDs, not raw emails (`writeRunMirrors`). Network health/opportunity/graph mirrors omit contact values (`src/research/network.js`; gaps tests assert no private email). README states agent mirrors redact values. |
| 6 | Trusted contacts show | **PASS** | Human-only CLI `contacts show` (`--person` XOR `--email`) calls `showPersonContacts` / `findPersonByEmail(..., { revealContacts: true })` (`src/cli.js`, `src/research/people.js`). No agent/MCP tool exposes full values; `find_person` remains summary-only for agents. README + help text mark the reveal path as trusted local. |
| 7 | TUI opportunities / health / record | **PASS** | Model loads `networkOpportunitiesList` + `networkHealthBrief` (`src/tui-model.js`). Overlay renders Health/Opportunities and opportunity rows; `R` records via `network_contact_record` with `{ source: 'tui' }` (`src/tui.js`). Covered by `tests/tui-contact-gates.test.js` (health, direct + 2-hop rows, record). |
| 8 | Indirect paths | **PASS** | `networkGraphQuery` bounds `maxHops` to 1\|2; traverse builds profile→person→person paths; opportunities mark `direct` vs `hops` (`src/research/network.js`). CLI/domain `network graph` / `network opportunities` exposed; MCP agent-eligible. Tests: deterministic two-hop mutual path (`networking-gaps`); TUI shows `2-hop` opportunity. |
| 9 | Test coverage | **PASS** | Focused suite spans the surface: `tests/networking-first-class.test.js` (email index/lookup/redaction, create-or-resolve, Exa stage + preflight); `tests/networking-gaps.test.js` (warmth/record mirrors, two-hop graph, agent reads + human `network_contact_record` gate, secret-safe reads); `tests/tui-contact-gates.test.js` (overlay health/opportunities/record); supporting identity/orchestration coverage in `tests/people-research-orchestration.test.js`. |

## Failures / risks

**Blocking defects:** none for the requested deliverables.

**Residual (non-blocking) risks:**

1. **Exa key alias asymmetry.** Public search accepts `EXA_API_KEY` or `JOBOS_EXA_API_KEY` (`src/search.js`), but Exa people preflight/adapter require `EXA_API_KEY` only. `docs/CONFIGURATION.md` states that correctly for people research; operators who set only `JOBOS_EXA_API_KEY` will get an honest preflight failure, not a silent wrong path.
2. **`mediationSource` env fallback.** Direct `callDomainTool(..., {})` without `source` can inherit `JOBOS_MEDIATION`. Product MCP/ACP paths hardcode `source: 'mcp'`, so agent reveal remains closed; residual risk is limited to non-product callers.
3. **Research-selector email casing.** Person-scope create-or-resolve persists the normalized address as `value` (not original casing). Lookup and redaction behavior remain correct.
4. **Static audit only.** This iteration did not execute the test suite; verdicts rest on implementation + committed test contracts.

## Exact acceptance verdict

| Deliverable | Pass/Fail |
| --- | --- |
| Exact normalized-email resolution and index | **PASS** |
| CLI/domain outputs and mediation redaction | **PASS** |
| Email research create-or-resolve | **PASS** |
| Exa category=people adapter, key preflight, evidence/contact staging and trust tier | **PASS** |
| All agent mirrors | **PASS** |
| Trusted contacts show | **PASS** |
| TUI opportunities/health/record | **PASS** |
| Indirect paths | **PASS** |
| Test coverage | **PASS** |

**Acceptance:** satisfied — `docs/networking-first-class-benchmark.md` exists and reports a defensible pass/fail for each requested deliverable. **Iteration 1 overall: PASS.**
