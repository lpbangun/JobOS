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
