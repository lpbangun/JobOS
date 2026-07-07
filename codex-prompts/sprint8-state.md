# Sprint 8 Loop State

Started: 2026-07-07

## Hard Constraints Check

- Human gate is immutable: outreach remains draft-only, with no sending or external-account actions.
- Evidence-grounded generation: dossier and outreach factual claims must carry source URLs; unsourced LLM claims are dropped.
- No ToS-hostile scraping: use public web search, public company pages, public ATS APIs, or user-pasted content only.
- Never invent stakeholders: stakeholder records require public source URLs; user-pasted content may support the record but cannot replace the URL requirement.
- Existing tests are not weakened; production changes stay in research/outreach/search/eval plus surface wiring.

## Goal 1 - Approach Dossier

Status: completed

Plan: Produce `codex-prompts/sprint8-approach.md` before production implementation. The dossier will compare search providers, define the LLM-grounded company research pipeline, define honest stakeholder handling, specify outreach generation inputs/schema/lifecycle direction, and design the Phase C eval rubric using evidence from the repo and public documentation.

Files to touch:

- `codex-prompts/sprint8-state.md`
- `codex-prompts/sprint8-approach.md`

Decisions made:

- Keep `duckduckgo` as the no-key search default to preserve local-first behavior.
- Implement Brave Search API first as the recommended configured provider, with registry fallback toward SearXNG when configured and DuckDuckGo last.
- Treat Tavily as optional/env-selected rather than the first provider implementation.
- Normalize search results to include provider/query/rank/title/url/snippet/fetchedAt/warning metadata.
- Use five public-search queries for company dossiers and validate every LLM claim/angle source URL against pooled result URLs before rendering.
- Make user-pasted stakeholder text the primary structuring path, but require a public `--source-url` before creating a stakeholder record.
- Keep search-based stakeholder discovery secondary, confidence-labeled, and source-required.
- Generate outreach through evidence-validated LLM JSON when configured, with deterministic draft-only fallback.
- Add outreach lifecycle as local thread/log/task state only; no sending.
- Extend evals with fixture-backed no-network research, stakeholder, outreach, and hard regression assertions.

Verification:

- `npm test` passed: 27/27 tests.
- `npm run smoke` passed.
- Goal 1 docs-only note: no new behavioral test was added because this goal creates an approach dossier, not runtime behavior.
- Gate check: approach dossier exists, every decision row cites repo evidence or a URL, hard constraints are reflected in the design, and the state file is updated.

Eval scores:

- Not applicable yet. Phase C eval harness is Goal 6; Goal 1 defines the rubric and target bar.

Blockers:

- None.

## Goal 2 - Pluggable Search Provider

Status: completed

Plan: Rework `src/search.js` from a single DuckDuckGo HTML fetcher into a provider registry with normalized result shape, per-provider timeouts, provider metadata on each result, and warning-preserving fallback. Keep `duckduckgo` as the no-key default, add Brave Search API as the configured API provider, and support SearXNG as a configured self-host fallback because the Goal 1 dossier selected that chain.

Files to touch:

- `codex-prompts/sprint8-state.md`
- `src/search.js`
- `tests/sprint8-search.test.js`
- `BUILD_PROGRESS.md`

Decisions made:

- `searchWeb` keeps the previous array return shape for compatibility with existing research code.
- Added `searchWebDetailed` for provider/fallback metadata and warnings that later dossier rendering can use directly.
- Provider registry now includes `duckduckgo`, `brave`, and `searxng`.
- `duckduckgo` remains the no-key default.
- `JOBOS_SEARCH_PROVIDER` or `JOBOS_SEARCH_PROVIDERS` selects the primary/chain; `auto` includes configured Brave/SearXNG before DuckDuckGo.
- Brave uses `JOBOS_BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY` and `JOBOS_BRAVE_SEARCH_URL` for tests/custom endpoints.
- SearXNG uses `JOBOS_SEARXNG_URL` and requests `format=json`.
- Per-provider timeout is supported with `JOBOS_SEARCH_<PROVIDER>_TIMEOUT_MS`, falling back to `JOBOS_SEARCH_TIMEOUT_MS`.
- Every normalized result includes `provider`, `query`, `rank`, and `fetchedAt`.
- Provider failures are captured as warnings and fallback continues without throwing when a later provider succeeds or all providers fail.

Verification:

- `node --test tests/sprint8-search.test.js` passed: 3/3 tests.
- `node --test tests/sprint3-research.test.js` passed: 2/2 tests for compatibility.
- `npm test` passed: 30/30 tests.
- `npm run smoke` passed.
- New behavior is covered by `tests/sprint8-search.test.js`; the fallback/provider assertions would fail against the previous single-provider `src/search.js`.

Eval scores:

- Not applicable yet; Phase C eval harness is Goal 6.

Blockers:

- None.

## Goal 3 - LLM-Synthesized Company Dossier

Status: completed

Plan: Rework company research to run the Goal 1 multi-query plan through the Goal 2 provider registry, pool/dedupe company-matched results, optionally call `generateJson` for claims/open questions/outreach angles, validate every LLM claim and angle against source URLs from the pool, drop unsupported LLM output, and keep a useful multi-query no-LLM fallback. Persist the final source-backed facts to `companies.facts_json` and keep the dossier Human gate.

Files to touch:

- `codex-prompts/sprint8-state.md`
- `src/research.js`
- `tests/sprint3-research.test.js`
- `BUILD_PROGRESS.md`

Decisions made:

- Company research now runs five public search queries from the Goal 1 plan.
- Company search results are pooled, URL-deduped, filtered to public allowed sources, and matched to the company before facts or LLM source maps are built.
- `generateJson` is used only when LLM config is complete and company-matched sources exist.
- LLM claims are accepted only when `claim` and `sourceUrl` exist and the URL matches the company-matched source pool.
- LLM outreach angles are accepted only when they cite at least one valid source URL from the same pool.
- Unsupported LLM claims/angles are counted and rendered only as aggregate warnings; unsupported text is not published.
- If the LLM is missing, fails, or returns no valid claims, JobOS renders a deterministic multi-query fallback facts list and conservative source-backed outreach angles.
- `companies.facts_json` is always refreshed with the final rendered source-backed facts.
- Company dossiers now show research mode, query list, warnings, source-backed facts, job-specific outreach angles, open questions, and the Human gate.

Verification:

- `node --test tests/sprint3-research.test.js` passed: 3/3 tests.
- `npm test` passed: 31/31 tests.
- `npm run smoke` passed.
- New behavior is covered by expanded no-LLM multi-query assertions and an LLM-backed fake-provider test that verifies unsourced claims and angles are dropped.

Eval scores:

- Not applicable yet; Phase C eval harness is Goal 6.

Blockers:

- None.

## Goal 4 - Honest Stakeholder Pipeline

Status: completed

Plan: Add a primary `research add-stakeholder` path that accepts user-pasted text plus a required public source URL, structures the stakeholder with LLM JSON when configured or deterministic heuristics otherwise, and refuses to create unsourced stakeholder records. Upgrade search-based stakeholder discovery to attach confidence/source metadata and use an LLM relevance check when configured, dropping unsourced or irrelevant candidates rather than inventing people.

Files to touch:

- `codex-prompts/sprint8-state.md`
- `src/research.js`
- `src/cli.js`
- `tests/sprint3-research.test.js`
- `BUILD_PROGRESS.md`

Decisions made:

- `research add-stakeholder` requires `--job` and `--source-url`; missing/non-http source URLs fail before creating a record.
- User-pasted stakeholder text can be supplied with `--text` or `--file`, and `--name`/`--role` can override or support deterministic inference.
- LLM structuring is used when configured through `generateJson`; deterministic inference remains the no-LLM fallback.
- Stakeholder records continue to use the existing table shape, with confidence/source-type labels persisted in the summary text to avoid a Goal 4 DB migration.
- Search-based stakeholder discovery now excludes login/private social-profile domains from auto-created candidates.
- Search candidates are labeled with confidence and source type before persistence.
- When an LLM is configured, search candidates pass through a conservative relevance check; wrong-company/non-person/no-relevance candidates are dropped.
- Stakeholder worksheets include confidence, source type, source URL, warnings, suppression policy, and Human gate.

Verification:

- `node --test tests/sprint3-research.test.js` passed: 5/5 tests.
- `npm test` passed: 39/39 tests.
- `npm run smoke` passed.
- New behavior is covered by tests for source-URL enforcement, pasted stakeholder recording, LLM relevance filtering, LinkedIn exclusion from search promotion, confidence labels, and continued draft-only outreach behavior.

Eval scores:

- Not applicable yet; Phase C eval harness is Goal 6.

Blockers:

- None.
