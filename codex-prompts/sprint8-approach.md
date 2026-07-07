# Sprint 8 Approach Dossier: LLM-Grounded Research and Outreach

Date: 2026-07-07

This dossier covers Sprint 8 Goal 1 only. It does not change production behavior. The implementation target is a local-first pipeline where search and LLM calls improve quality when configured, while no-key mode still creates honest, useful draft artifacts.

## Evidence Map

Repo evidence:

- `src/search.js:67-78` has one `searchWeb` path, defaults to DuckDuckGo HTML, accepts a custom base URL, parses either JSON or HTML, and has no provider metadata.
- `src/research.js:107-120` creates company dossiers from one query and writes `companies.facts_json`; `src/research.js:123-131` finds stakeholders from one query.
- `src/research.js:37-52` already renders source-backed facts and a human gate; `src/research.js:92-94` does the same for stakeholder research.
- `src/outreach.js:12-15` saves outreach as artifacts with `approval_status: draft_needs_human_review`; `src/outreach.js:37-44` has a static template, uses the profile name as background, and only reports communication style as a note.
- `src/llm.js:17-31` makes LLM use optional and degraded-mode by default; `src/llm.js:77-90` returns schema-named JSON through OpenAI-compatible or Anthropic providers.
- `src/tailoring.js:118-169` shows the existing pattern for validating LLM output against known proof point IDs before rendering claims.
- `src/db.js:14-27` shows current tables for profiles, proof points, companies, jobs, stakeholders, applications, artifacts, tasks, automations, automation runs, and audit log.
- `src/profiles.js:7-13` shows current profile data: name, preferences, resume text, communication style in preferences, and proof points with evidence/skills/metrics.
- `src/api.js:19-85`, `src/mcp.js:13-55`, and `src/web.js:31-44` are the current API, MCP, and dashboard surface patterns.
- `src/scheduler/actions.js:67-128` and `src/scheduler/actions.js:219-235` show the existing `followup_watch` scheduler action that creates draft follow-up artifacts from due tasks.

Web evidence:

- DuckDuckGo HTML exists as a no-JavaScript search surface at `https://html.duckduckgo.com/`; DuckDuckGo documents query settings and search syntax, but these are consumer-search pages, not a stable app API (`https://duckduckgo.com/duckduckgo-help-pages/settings/params`, `https://duckduckgo.com/duckduckgo-help-pages/results/syntax`).
- DuckDuckGo documents that its traditional web links are largely sourced from Bing and that settings parameters are intended for individual use, which is relevant to reliability and ToS risk (`https://duckduckgo.com/duckduckgo-help-pages/results/sources`, `https://duckduckgo.com/duckduckgo-help-pages/settings/params`).
- Brave Search API has documented web-search API usage, JSON responses, rate-limit headers, pricing, free monthly credits, and Search capacity of 50 requests per second (`https://api-dashboard.search.brave.com/app/documentation/web-search/get-started`, `https://api-dashboard.search.brave.com/documentation/guides/rate-limiting`, `https://api-dashboard.search.brave.com/documentation/pricing`).
- Tavily requires API keys, exposes `/search` and `/extract`, has development/production RPM limits, and publishes credit pricing with a free monthly tier (`https://docs.tavily.com/documentation/api-reference/introduction`, `https://docs.tavily.com/documentation/rate-limits`, `https://docs.tavily.com/documentation/api-credits`).
- SearXNG is self-hostable metasearch, does not track or profile users, and supports JSON search when an instance enables the format (`https://docs.searxng.org/`, `https://docs.searxng.org/dev/search_api.html`).

## Decision Log

| Area | Options considered | Decision | Why | Evidence |
| --- | --- | --- | --- | --- |
| Keyless search default | DuckDuckGo HTML, public SearXNG instance, no search | Keep `duckduckgo` as the no-key default. | It preserves JobOS local-first/no-key behavior and matches the current runtime, while we document that it is best-effort HTML parsing rather than a contracted API. | `src/search.js:67-78`, `https://html.duckduckgo.com/`, `https://duckduckgo.com/duckduckgo-help-pages/settings/params` |
| Configured API provider | Brave, Tavily, SearXNG | Implement Brave Search API first as the recommended configured provider. | Brave has documented JSON web-search API behavior, rate-limit headers, pricing, and capacity; it is a better production-grade configured provider than HTML scraping. | `https://api-dashboard.search.brave.com/app/documentation/web-search/get-started`, `https://api-dashboard.search.brave.com/documentation/guides/rate-limiting`, `https://api-dashboard.search.brave.com/documentation/pricing` |
| Fallback chain | Primary only, Brave to DuckDuckGo, Brave to SearXNG to DuckDuckGo, Tavily to DuckDuckGo | Use provider registry order from env, with practical fallback `brave -> searxng -> duckduckgo` when those providers are configured, and `duckduckgo` alone with no keys. | This gives a reliable API first, supports self-hosted privacy search, and preserves no-key operation. | `src/search.js:67-78`, `https://docs.searxng.org/dev/search_api.html`, `https://api-dashboard.search.brave.com/documentation/guides/rate-limiting` |
| Tavily role | Default provider, optional provider, omit | Treat Tavily as optional/env-selected, not the first implementation target. | Tavily is strong for AI retrieval and extraction, but it requires an API key and credit accounting, so it should not displace Brave as the first configured search provider or DuckDuckGo as no-key fallback. | `https://docs.tavily.com/documentation/api-reference/introduction`, `https://docs.tavily.com/documentation/api-credits`, `https://docs.tavily.com/documentation/rate-limits` |
| Search result shape | Provider-native payloads, lossy normalized records | Normalize every result to `{ provider, query, rank, title, url, snippet, fetchedAt, warning? }`. | Research/evals need uniform source validation and provider attribution across fallback paths. | `src/search.js:23-41`, `src/research.js:11-18` |
| Company research query plan | One broad query, crawl company site, 3-5 public search queries | Use 5 public queries per company/job and pool deduped results. | Current one-query behavior misses product, role, news, customer, and risk signals; public search avoids private scraping. | `src/research.js:107-120`, `ideal-agent-native-job-application-app.md` section 5, `https://duckduckgo.com/duckduckgo-help-pages/results/syntax` |
| LLM synthesis | Freeform markdown, JSON with source validation, no LLM | Use `generateJson` with strict schema and post-filter every claim/angle source URL against the pooled result URLs. | This follows the existing optional LLM pattern and enforces the evidence-grounding constraint even if the LLM emits unsupported text. | `src/llm.js:77-90`, `src/tailoring.js:118-169` |
| No-LLM dossier fallback | Empty dossier, current single-query facts, multi-query facts and open questions | Produce a multi-query pooled facts list, source diversity summary, warnings, and open questions without synthesized claims. | No-key JobOS should remain useful but clearly plainer and less interpretive. | `src/research.js:37-52`, `src/llm.js:17-31` |
| Stakeholder primary path | Search-first, ATS/contact scraping, user-pasted profile text/URL | Make user-pasted text/URL the reliable primary path through `research add-stakeholder`. | Public web search is weak for people discovery and ToS-sensitive around LinkedIn; user-pasted content is allowed by the sprint constraints. | Sprint 8 prompt hard constraints, `src/research.js:79-90`, `ideal-agent-native-job-application-app.md` section 6 |
| Search-based stakeholders | Disable, accept all person-looking results, best-effort with confidence | Keep search discovery as secondary, require public source URLs, label confidence, and LLM-check relevance when configured. | This preserves useful discovery while avoiding invented contacts and false precision. | `src/research.js:79-100`, `src/research.js:123-131` |
| Outreach generation | Static template, LLM freeform, LLM JSON with evidence IDs | Use LLM JSON output with subject/message/evidence/quality score, then render only evidence-backed content; fallback remains deterministic. | Existing outreach already saves gated draft artifacts, but current template underuses style and profile evidence. | `src/outreach.js:7-15`, `src/outreach.js:37-44`, `src/profiles.js:7-13` |
| Outreach lifecycle | Only artifacts, external send automation, local CRM thread/task records | Add `outreach_threads`, `mark-sent` as human logging only, `schedule-followup` as task creation, and `due` as local query. | This matches design doc section 6 without sending outreach or touching accounts. | `src/db.js:20-24`, `src/tracking.js:1-7`, `src/scheduler/actions.js:67-128` |
| Surface wiring | CLI only, CLI/API/MCP/dashboard | Wire CLI, API, MCP, and dashboard following existing patterns. | Agent-native behavior requires parseable surfaces beyond the CLI. | `src/cli.js:44-46`, `src/api.js:19-85`, `src/mcp.js:13-55`, `src/web.js:31-44` |
| Eval harness | Manual inspection, live API evals, fixture-backed deterministic evals with stub LLM | Use fixture search corpora and injectable/stub LLM clients; no live network in tests. | The sprint requires deterministic evals and no live API calls for LLM-dependent behavior. | Sprint 8 prompt Goal 6, `tests/sprint3-research.test.js`, `tests/sprint5-integration-eval.test.js` |

## Search Provider Comparison

| Provider | Reliability | Rate limits | Cost | No-key fallback | Fit for JobOS |
| --- | --- | --- | --- | --- | --- |
| DuckDuckGo HTML | Best-effort only. Current code scrapes HTML and JSON-looking test fixtures; DuckDuckGo documents consumer query behavior, not a stable app API. | No app API quota is documented for this HTML path. Treat failures and throttling as expected and recoverable. | No direct API charge. | Yes. | Keep as local-first fallback and test fixture target, but record provider and warnings. |
| Brave Search API | Strongest first configured API choice. It has documented web-search endpoints, JSON responses, pricing, and rate-limit headers. | Published rate-limit headers and plan capacity; Search pricing page lists 50 requests/second capacity. | Published metered pricing with free monthly credits. | No, requires API token. | Recommended first API provider. |
| Tavily | Good AI/RAG-oriented search and extract provider. It can be useful for future richer page extraction, but it introduces credit semantics. | Published RPM limits by environment and endpoint. | Free monthly credits plus paid credit pricing. | No, requires API token. | Optional provider after Brave or when user chooses Tavily. |
| SearXNG | Good privacy/self-host path when user controls an instance; public instances vary and may disable JSON. | Instance-specific; no global quota. Public instances can be unreliable. | Free software; hosting cost if self-hosted. | No for reliable use, because the user needs an instance URL. | Good fallback after Brave if `JOBOS_SEARXNG_URL` is configured. |

Recommended chain:

1. If `JOBOS_SEARCH_PROVIDER` is set, use that provider first.
2. If `JOBOS_BRAVE_API_KEY` exists, include `brave`.
3. If `JOBOS_SEARXNG_URL` exists, include `searxng`.
4. Always include `duckduckgo` last as keyless fallback.

Goal 2 implementation should record warnings per provider failure and return partial results instead of throwing if a fallback succeeds. Each normalized result should carry `provider` so dossiers and evals can inspect provenance.

## Company Research Pipeline

Queries per job/company:

1. `"${company}" official product customers`
2. `"${company}" "${job.title}" team role hiring`
3. `"${company}" funding news strategy`
4. `"${company}" careers "${job.title}" requirements`
5. `"${company}" layoffs legal controversy reviews`

Pooling:

- Execute every query through the provider registry with per-provider timeout.
- Normalize to `{ provider, query, rank, title, url, snippet, fetchedAt }`.
- Deduplicate by canonical URL.
- Drop URLs from known login-walled/private-account domains for factual claims.
- Score company match with existing name/host heuristics, plus exact phrase and company-domain hints.
- Keep distractors in internal diagnostics for eval, but do not render them as facts.

LLM synthesis:

- Call `generateJson` only when LLM config is complete.
- System prompt: "You are JobOS company research. Use only supplied search results. Do not invent facts. Every factual claim and outreach angle must cite one or more source URLs from the provided source list."
- User payload: job fields, company fields, query list, pooled results, and hard constraints.
- Expected JSON:

```json
{
  "claims": [
    {
      "claim": "string",
      "category": "product|market|funding|customers|role_context|risk|other",
      "sourceUrl": "string",
      "sourceTitle": "string",
      "confidence": "low|medium|high"
    }
  ],
  "openQuestions": ["string"],
  "outreachAngles": [
    {
      "angle": "string",
      "whyItMattersForRole": "string",
      "evidenceUrls": ["string"],
      "suggestedAsk": "string",
      "confidence": "low|medium|high"
    }
  ],
  "warnings": ["string"]
}
```

Validation:

- Drop any claim with no `sourceUrl`.
- Drop any claim whose `sourceUrl` is not in the pooled result URL set.
- Drop any outreach angle with no non-empty `evidenceUrls` subset of the pooled result URL set.
- Render a warning when the LLM emits unsupported material, but do not publish the unsupported text.

No-LLM fallback:

- Render grouped, source-backed facts from the pooled results.
- Keep deterministic open questions around product, business model, risks, compensation/work model, and role/team context.
- Render conservative outreach angles only as prompts tied to existing source-backed facts, not as claims.

Persistence:

- Continue writing `jobs/<jobId>/company-dossier.md`.
- Continue persisting validated facts to `companies.facts_json`; include provider/query/source metadata.
- Keep the Human gate section in every dossier.
- Audit every research write with source counts and provider warnings.

## Stakeholder Strategy

Public web search can sometimes find company team pages, recruiter pages, founder bios, conference bios, or alumni pages. It cannot reliably prove hiring-team relevance, and generic search snippets often confuse similar company names, team pages, careers pages, and people at competitor companies.

Primary path:

- Add `jobos research add-stakeholder --job <id>` with `--name`, `--role`, required `--source-url`, and `--text` or `--file` support.
- If LLM is configured, structure pasted text into `{ name, role, company, relevanceSummary, sourceUrl, confidence, evidenceQuotes }`.
- If LLM is not configured, use heuristics: explicit name/role flags win; otherwise infer a short summary from the pasted text and mark confidence `low`.
- Require a public source URL for every stakeholder record. User-pasted content is allowed as evidence text, but if no URL is supplied, write a review worksheet/warning instead of creating a stakeholder record.

Secondary path:

- Keep `jobos research stakeholders --job <id>` as best-effort search.
- Prefer public company/team/conference/blog pages over login-walled or private-account pages.
- Each candidate must have a public URL, role/relevance summary, and confidence.
- With LLM configured, pass candidates through relevance JSON: `{ isPerson, belongsToCompany, roleRelevance, confidence, reason }`.
- Never create a stakeholder from an unsourced name or from a page that only proves a generic company mention.

Recommended stakeholder schema additions:

```json
{
  "confidence": "low|medium|high",
  "sourceType": "user_pasted|public_search|public_company_page",
  "sourceUrl": "string",
  "relevanceReason": "string",
  "lastVerifiedAt": "ISO-8601"
}
```

The current `stakeholders` table can initially store these fields inside summary/links JSON-compatible metadata if a table migration is too large for Goal 4, but the dossier should render them explicitly.

## Outreach Generation

Available profile fields today:

- `profiles.id`, `profiles.name`, `profiles.preferences_json`, and `profiles.resume_text`.
- Preferences include `communicationStyle`, `targetRoleFamilies`, `industries`, `locations`, `skills`, `missionKeywords`, `values`, `workModel`, and automation policy.
- Proof points include `summary`, `evidence`, `skills`, `metrics`, and metadata.

What the LLM needs:

- Job: title, company, location, description, requirements, application status.
- Dossier: validated claims and outreach angles only, each with source URLs.
- Stakeholder: name, role, source URL, confidence, relevance summary.
- Profile: communication style, selected proof points, concise background derived from proof points/resume text, and positioning angles.
- Goal: informational, referral, reconnect, recruiter clarification, or follow-up.

Positioning angles:

- An angle is a bridge between a verified company/job fact and a verified candidate proof point.
- Example structure: `{ angle, companyEvidenceUrl, proofPointId, draftUse }`.
- Angles must not invent user accomplishments or stakeholder facts.

LLM prompt design:

- System: "You draft low-volume, human-reviewed outreach. Use only supplied evidence. Do not send, imply sending, or claim relationships not provided."
- User: JSON payload with job, dossier claims, stakeholder summary, profile, proof points, communication style, goal, and hard constraints.
- Output schema:

```json
{
  "subject": "string",
  "message": "string",
  "evidence": [
    {
      "type": "dossier_claim|stakeholder|proof_point",
      "id": "string",
      "sourceUrl": "string",
      "usedFor": "string"
    }
  ],
  "quality": {
    "specificity": 1,
    "personalization": 1,
    "askClarity": 1,
    "lengthDiscipline": 1,
    "toneMatch": 1
  },
  "warnings": ["string"]
}
```

Rendering and validation:

- Render only if evidence references valid dossier source URLs, stakeholder source URLs, or proof point IDs.
- If LLM output lacks valid evidence, fall back to deterministic template and include a warning.
- Keep `approval_status: draft_needs_human_review`.
- Keep "Draft only - not sent" and the Human gate.
- Fix fallback bugs by using actual proof/profile summaries for background and applying `communicationStyle` to sentence length/tone choices.

Lifecycle:

- Add `outreach_threads` with artifact ID, stakeholder ID, job ID, profile ID, goal, channel, status, sent_at, last_event_at, next_followup_at, and metadata JSON.
- `jobos outreach mark-sent --artifact <id> --channel <email|linkedin|other>` records that the human sent it; it does not send.
- `jobos outreach schedule-followup --thread <id> --after <days>` creates a `tasks` row of type `followup` with the thread/job/application link.
- `jobos outreach due` lists due open follow-up tasks/threads.
- Wire scheduled follow-ups into existing `followup_watch` by creating tasks that match its follow-up filters.

## Phase C Eval Design

Dossier eval:

- Fixtures: 3 synthetic companies with official/product/news/customer pages and one similar-name distractor per case.
- Hard fail: if any rendered factual claim lacks a fixture source URL or uses a distractor URL, groundedness is below 10/10 and total dossier score is capped at 5.
- Claim groundedness anchors: 10 = every claim exactly traceable to fixture source URLs; 8 = all claims sourced but one minor categorization issue; 5 = sourced but weakly related; 1 = unsupported or fabricated claim.
- Source diversity anchors: 10 = uses at least 3 distinct relevant URLs across product/role/news/risk when available; 8 = 2-3 relevant URLs; 5 = one source dominates; 1 = no useful source variety.
- Distractor rejection anchors: 10 = no distractor in facts or angles; 8 = distractor only appears in diagnostics/warnings; 5 = ambiguous distractor not rendered as fact but counted; 1 = distractor rendered as company fact.
- Outreach angle usefulness anchors: 10 = angles are job-specific, evidence-cited, and suitable for outreach; 8 = useful but generic in one dimension; 5 = mostly boilerplate; 1 = not actionable or unsupported.

Stakeholder eval:

- Fixtures: real-looking people, non-people pages, careers/team pages, and wrong-company people.
- Precision weighted 2x: false stakeholders are more harmful than misses.
- Precision anchors: 10 = no false stakeholders; 8 = one low-confidence ambiguous candidate but not promoted; 5 = one false stakeholder rendered; 1 = multiple false stakeholders.
- Recall anchors: 10 = finds all fixture-valid stakeholders; 8 = misses one secondary stakeholder; 5 = finds only obvious primary; 1 = finds none.
- Confidence labeling anchors: 10 = all candidates have source and confidence matching evidence strength; 8 = one confidence too high/low; 5 = several unlabeled weak results; 1 = confidence absent.

Outreach eval:

- Fixtures: 3 synthetic profiles with different proof points and `communicationStyle` values x 2 goals: informational and referral.
- LLM judge axes, each 1-10: specificity, personalization, ask clarity, length discipline, and tone match.
- Specificity anchors: 10 = references valid company/stakeholder/proof evidence; 8 = cites evidence but lightly; 5 = generic; 1 = fabricated or unsupported.
- Personalization anchors: 10 = materially different across profiles and goals; 8 = some shared structure but distinct evidence and tone; 5 = mostly same template; 1 = interchangeable.
- Ask clarity anchors: 10 = one clear, low-pressure ask; 8 = clear but slightly wordy; 5 = vague; 1 = pushy or unclear.
- Length discipline anchors: 10 = concise and channel-appropriate; 8 = slightly long; 5 = bloated; 1 = unusably long.
- Tone match anchors: 10 = matches `communicationStyle`; 8 = mostly matches; 5 = generic tone; 1 = conflicts with requested style.
- Programmatic assertion: drafts for different profiles must pass textual dissimilarity threshold and use different proof/evidence arrays.
- No-LLM assertion: fallback drafts contain no fabricated claims and cite only stored proof points, stakeholder sources, and dossier URLs.

Regression assertions:

- Every company dossier, stakeholder doc, outreach artifact, and follow-up draft includes the Human gate or equivalent draft-only gate.
- All outreach/follow-up artifacts have `approval_status = draft_needs_human_review`.
- Test mode makes no live network calls; search and LLM are injected/stubbed.
- Audit rows are written for research, stakeholder add/search, outreach draft, mark-sent logging, and follow-up scheduling.
- CLI JSON output exists for new successful commands.

Bar:

- Every hard assertion passes.
- Every LLM-judged axis averages at least 8/10.
- Below bar: write failure analysis to `codex-prompts/sprint8-state.md`, remediate implementation, and rerun. Stop after two failed remediation passes on the same axis.

## Constraint Compliance Notes

- Human gate: all outreach and follow-up behavior remains draft/log/task only; no external account access.
- Evidence grounding: source URL validation is a render-time gate, not only a prompt instruction.
- Scraping: use public search results, public pages, public ATS APIs, or user-pasted text; no LinkedIn/private-account scraping.
- Stakeholders: no stakeholder record is created without a public source URL; user-pasted text can support the record, and all search candidates carry confidence.
- Existing tests: Goals 2-6 should add tests and fixtures; do not weaken Sprint 3/5/6/7 tests.
