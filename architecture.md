# Architecture for Enhanced Research and Outreach in JobOS

Updated: 2026-07-09 (revised per contact-discovery audit)

## Goal

Add a local-first, headless-capable research and outreach intelligence layer to JobOS. The design should deepen company dossiers, stakeholder discovery, contact detail discovery, 2nd-degree network expansion, and outreach planning while preserving the product invariant: JobOS may research, draft, score, and stage work, but external actions stay human-gated.

## Current Baseline

The existing worktree already provides strong foundations:

- `src/research.js`: company dossiers, stakeholder search, source filtering, LLM synthesis with unsupported-claim dropping, user-pasted stakeholder records.
- `src/outreach.js`: evidence-grounded outreach drafts, local outreach threads, human-sent recording, follow-up task scheduling, due follow-up listing.
- `src/search.js`: provider chain for DuckDuckGo HTML, Brave, and SearXNG.
- `src/db.js`: SQLite schema with `companies`, `jobs`, `stakeholders`, `artifacts`, `outreach_threads`, `tasks`, `automation_runs`, and `audit_log`.
- `src/api.js` and `src/mcp.js`: existing API/MCP surfaces for outreach drafting and lifecycle operations.
- `run_eval_research.js`: local fake-search/fake-LLM harness proving source-grounded research and human-gated outreach behavior.

The proposed architecture extends these modules rather than replacing them.

## Design Principles

1. Public, user-provided, and user-authorized account sources are allowed. Private-account access is acceptable only when the user explicitly grants access to their own session or exported data. No bypassing access controls, captchas, rate limits, or use of leaked data.
2. Evidence first. Every fact, person, contact point, and outreach angle must trace to source observations.
3. Confidence is explicit. Use clear tiers such as exact public email, pattern candidate, DNS-valid domain, unverified mailbox, source-backed stakeholder.
4. Human gates stay hard. JobOS never sends email, LinkedIn messages, connection requests, applications, or follow-ups.
5. Headless by default. CLI/API/MCP must work in a server, CI, or SSH environment without browser automation. A next iteration may add an optional user-GUI-browser connector for user-authorized sessions.
6. Local-first privacy. Store cache, evidence, contacts, drafts, graph edges, and audit entries in the selected workspace.
7. Contact discovery is the primary product goal. This system is for personal use: finding real contacts at real companies. The architecture prioritizes contact extraction, email pattern inference, and verification depth over generic company research. Fetching public web pages with `fetch()` + cheerio is standard crawling, not browser automation. Recording a public LinkedIn profile URL from search results is not scraping — the page is not fetched and no automated actions are taken.

## Core Components

```text
Job + profile
  -> Company Identity Resolver
  -> Source Collector
  -> Source Observation Ledger
  -> Company Dossier Synthesizer
  -> Person Candidate Extractor
  -> Contact Discovery Engine
  -> Network Graph Mapper
  -> Outreach Planner
  -> Human Review Queue / Draft Artifacts / Follow-up Tasks
```

### 1. Company Identity Resolver

Purpose: canonicalize company name, domain, ATS board, aliases, and source trust before deeper research.

Inputs:

- Existing `jobs.company`, `jobs.url`, `companies.website`, imported job text, and ATS adapter metadata.
- Public sources from company website, ATS pages, SEC EDGAR for public companies, and search results.

Outputs:

- Canonical domain and aliases.
- Company source trust score.
- Known ATS board handles.
- Collision warnings when multiple similarly named companies appear.

Integration:

- Extend `companies` with `domain`, `aliases_json`, `source_confidence`, and `identity_sources_json`, or store this in a new `company_research_profiles` table if keeping `companies` lean is preferred.
- `research company` calls this before query generation.

### 2. Source Collector

Purpose: gather raw evidence observations from low-cost, configured, or user-authorized sources.

Adapters:

- Existing search provider chain: DuckDuckGo, Brave, SearXNG.
- Optional agentic search provider adapters: Perplexity, Tavily, Exa, or similar, enabled only when configured and kept if evaluations show better precision, coverage, or evidence quality than the default chain.
- Company website pages: homepage, careers, about, team, press, blog, sitemap. Pages are fetched directly with `fetch()` + cheerio (already a dependency) — this is standard crawling of public web pages, not browser automation. `robots.txt` is respected for crawl-delay hints but does not block fetching of individual public pages for personal-use research.
- ATS public APIs: current Greenhouse/Lever adapters; add Ashby/Workable only when public endpoints are straightforward.
- News/index sources: GDELT DOC API (`https://api.gdeltproject.org/api/v2/doc/doc`, free, no key required), Common Crawl URL index, RSS feeds.
- Wayback Machine CDX API (`https://web.archive.org/cdx/search/cdx?url=company.com/team*&output=json`): fetch archived versions of company team pages that may have since been removed. Emails extracted from archived pages are labeled Tier B (credible public third-party page, potentially stale).
- GitHub public REST API: `GET https://api.github.com/orgs/{org}/members` returns public member profiles (unauthenticated, 60 req/hr). For EdTech/WorkTech companies, many teams have public GitHub orgs with member lists. Search `site:github.com "{company}" org` via DuckDuckGo to discover org handles.
- Public/government sources: SEC EDGAR, BLS, O*NET, OFLC H-1B disclosure data, USAspending where relevant.
- User-pasted source cards and exported account data for LinkedIn/profile/manual research; future optional browser-session observations belong to the user-authorized GUI connector.
- LinkedIn public profile URLs: search results that include `linkedin.com/in/` URLs are recorded as `profile_url` contact points (Tier E). The LinkedIn page is never fetched by JobOS. The URL is recorded because DuckDuckGo already indexed it — recording a public URL is not scraping.

Implementation shape:

- New `src/research/sources.js` with adapter interface:

```js
async function collect({ company, domain, job, queryPack, limit, env }) {
  return [{ url, title, snippet, sourceType, provider, query, fetchedAt, rawText?, trust }];
}
```

Storage:

- New `source_observations` table:

```text
id TEXT PRIMARY KEY
company_id TEXT
job_id TEXT
url TEXT NOT NULL
canonical_url TEXT NOT NULL
title TEXT
snippet TEXT
source_type TEXT NOT NULL
provider TEXT NOT NULL
query TEXT
trust TEXT NOT NULL
fetched_at TEXT NOT NULL
content_hash TEXT
metadata_json TEXT NOT NULL DEFAULT '{}'
```

Workspace mirror:

- `jobos-workspace/jobs/<job-id>/research/source-observations.yaml`

### 3. Company Dossier Synthesizer

Purpose: turn source observations into concise role-specific dossiers.

Existing baseline:

- `research company` already creates `company-dossier.md`, `companies.facts_json`, open questions, outreach angles, and warnings.

Enhancements:

- Add categories: identity, product/customer, hiring pulse, funding/financial, compensation/salary, culture/risk, legal/regulatory, role-specific team context.
- Render fact type as `fact`, `inference`, or `question`.
- Track source count and freshness per category.
- Generate "outreach-safe facts" separately from "interview-only risk notes".

Output:

- Existing `company-dossier.md` plus `company-research.yaml` for structured agent use.

### 4. Person Candidate Extractor

Purpose: discover relevant People Ops, recruiting, hiring-manager, executive, peer, alumni, and investor candidates.

Inputs:

- Source observations.
- Existing `stakeholders` records.
- Job title/role family.
- User-provided profile/proof point employers, schools, communities.

Extraction:

- Deterministic parsing: page title patterns, `Person - Title at Company`, `schema.org/Person` if present, `mailto:` anchors, author pages.
- Conservative LLM structuring when configured: only from supplied source text and URL.
- Role taxonomy:
  - recruiting/talent/people ops
  - likely hiring manager
  - functional peer
  - founder/executive
  - alumni/shared connection
  - investor/advisor
  - public expert

Storage:

- Continue using `stakeholders` for approved/visible candidates.
- Add `person_candidates` for pre-review candidates:

```text
id TEXT PRIMARY KEY
job_id TEXT
company_id TEXT
name TEXT NOT NULL
role TEXT
function TEXT
seniority TEXT
relevance TEXT NOT NULL
confidence TEXT NOT NULL
source_observation_ids_json TEXT NOT NULL DEFAULT '[]'
status TEXT NOT NULL DEFAULT 'candidate'
suppression_reason TEXT NOT NULL DEFAULT ''
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Promotion:

- `research stakeholders` can write candidates to `person_candidates`.
- `research promote-stakeholder --candidate <id>` or an API/dashboard action promotes to `stakeholders`.
- Current direct upsert behavior can remain for MVP compatibility.

### 5. Contact Discovery Engine

Purpose: recreate the practical parts of Hunter-style contact discovery without paid data. This is the primary product goal — finding real contacts at real companies.

Subcomponents:

- Page email extractor: fetches company /team, /about, /press, /contact pages with `fetch()` + cheerio, extracts `mailto:` anchors and plain-text emails via regex, extracts person names + titles from team page patterns. Stores every email as a source observation with the page URL as evidence. This is the highest-leverage component — it finds emails that search snippets miss.
- Email extractor: parses exact public emails and `mailto:` links from source observations (search snippets + fetched pages).
- Pattern detector: infers email patterns from exact public person emails on the same domain. Detects `first@`, `first.last@`, `flast@`, `firstl@`, `first_last@`. Scores by support count (2+ examples = stronger). Open-source reference: `apifyforge/email-pattern-finder` on GitHub.
- Candidate generator: creates transparent email hypotheses for source-backed people only. Generated candidates are labeled `pattern_candidate` (Tier C) — never "verified."
- DNS verifier: uses Node.js `dns.promises` module (built-in, zero dependencies). `dns.resolveMx(domain)` for MX record presence, `dns.resolveTxt(domain)` for SPF/DMARC records, `dns.resolveNs(domain)` for nameserver validity, disposable-domain check against a static blocklist. Open-source reference: `@devmehq/email-validator-js` on npm (MIT).
- SMTP verifier (advanced, opt-in): enabled behind `JOBOS_SMTP_PROBE=true` env flag. Uses `net.connect(25, mxServer)` to the domain's MX host, sends SMTP `HELO`, `MAIL FROM:<test@jobos.local>`, `RCPT TO:<candidate@company.com>`, checks response code. Labels: `smtp_accepts_rcpt`, `smtp_rejects_rcpt`, `smtp_inconclusive`. Strict rate limit: 1 probe per domain per 30 seconds. Never sends actual DATA — quits after RCPT TO check. Open-source reference: `AfterShip/email-verifier` (Go, MIT).
- Risk labeler: catch-all unknown, generic inbox, role account, stale source, guessed address.

Storage:

```text
contact_points
id TEXT PRIMARY KEY
person_id TEXT
stakeholder_id TEXT
company_id TEXT
type TEXT NOT NULL              -- email, profile_url, generic_inbox, website
value TEXT NOT NULL
normalized_value TEXT NOT NULL
evidence_tier TEXT NOT NULL     -- A, B, C, D, E
verification_status TEXT NOT NULL
confidence TEXT NOT NULL
source_observation_ids_json TEXT NOT NULL DEFAULT '[]'
checks_json TEXT NOT NULL DEFAULT '{}'
human_approved INTEGER NOT NULL DEFAULT 0
do_not_use INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

```text
email_patterns
id TEXT PRIMARY KEY
company_id TEXT NOT NULL
domain TEXT NOT NULL
pattern TEXT NOT NULL           -- first, first.last, flast, first_last, etc.
support_count INTEGER NOT NULL
support_sources_json TEXT NOT NULL DEFAULT '[]'
confidence TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Persistence and verification policy:

- Default checks are local/DNS/public-source only.
- Exact public contacts and user-approved contacts may be stored in `contact_points`.
- Guessed email candidates are visible in the contact worksheet with evidence tiers and source URLs. The user reviews them in the same workflow — approval creates the persistent `contact_points` row. For personal use, the user is the sole reviewer.
- SMTP mailbox probing is available behind `JOBOS_SMTP_PROBE=true` env flag, rate-limited (1 per domain per 30s), and audited. It checks RCPT TO acceptance without sending data.
- "Verified" means exact public evidence or user approval, not merely MX presence.

CLI/API shape:

- `jobos research contacts --job <job-id> --json`
- `jobos research contacts --stakeholder <stakeholder-id> --json`
- `jobos research approve-contact --contact <contact-id> --json`
- `jobos research approve-contact --worksheet-candidate <candidate-id> --json`
- API: `GET /api/research/contacts?jobId=...`, `POST /api/research/contacts/:id/approve`
- MCP: `discover_contacts`, `approve_contact`

### 6. Network Graph Mapper

Purpose: identify warm or semi-warm outreach paths without accessing private networks.

Storage:

```text
relationship_edges
id TEXT PRIMARY KEY
from_type TEXT NOT NULL         -- profile, proof_point, company, person
from_id TEXT NOT NULL
to_type TEXT NOT NULL
to_id TEXT NOT NULL
edge_type TEXT NOT NULL         -- shared_employer, shared_school, shared_investor, shared_event, shared_open_source
evidence_json TEXT NOT NULL DEFAULT '[]'
confidence TEXT NOT NULL
created_at TEXT NOT NULL
```

Sources:

- Stored proof points and resume text.
- User-imported relationship files in `jobos-workspace/network/*.yaml`.
- Public bios, event pages, GitHub orgs, VC portfolio pages, company customer pages.

CLI/API shape:

- `jobos network import --file <csv|yaml> --json`
- `jobos research network --job <job-id> --json`
- API: `POST /api/research/network {"jobId":"..."}`
- MCP: `map_reachable_network`

Output:

- `jobos-workspace/jobs/<job-id>/research/network-map.md`
- Ranked contact path ladder:
  1. direct user-provided connection
  2. shared employer/school/community
  3. shared investor/portfolio/community
  4. exact public contact
  5. generic routing inbox
  6. no safe path

### 7. Outreach Planner

Purpose: choose the best human-gated outreach path and generate better drafts.

Existing baseline:

- `outreach draft` already selects stakeholder/company/proof evidence, writes a draft artifact, and creates a thread.

Enhancements:

- Add `outreach_plans` table or structured artifact metadata:

```text
id TEXT PRIMARY KEY
job_id TEXT
profile_id TEXT
stakeholder_id TEXT
contact_point_id TEXT
goal TEXT NOT NULL
channel TEXT NOT NULL           -- email, linkedin_manual, generic_inbox, intro_request, no_safe_path
path_strength TEXT NOT NULL
recommended INTEGER NOT NULL DEFAULT 0
reasoning_json TEXT NOT NULL DEFAULT '{}'
warnings_json TEXT NOT NULL DEFAULT '[]'
created_at TEXT NOT NULL
```

- Drafts should render:
  - selected channel and why
  - contact confidence
  - evidence list
  - unresolved assumptions
  - compliance/reminder checklist
  - manual copy/send gate

Commands:

- `jobos outreach plan --job <job-id> --profile <profile-id> --json`
- Existing `jobos outreach draft` accepts `--plan <plan-id>` or explicit `--contact <contact-id>`.

## Data Flow Details

### Enhanced Company Dossier

1. User runs `jobos research company --job <job-id> --depth enhanced --json`.
2. Identity resolver canonicalizes company/domain and flags collisions.
3. Source collector runs role-specific query packs and public-source adapters.
4. Observations are deduped and stored.
5. Dossier synthesizer writes structured facts, inferences, open questions, and outreach-safe angles.
6. `companies.facts_json` remains a compatibility summary; richer data is in `source_observations` and structured workspace files.
7. Audit logs record query count, source count, warnings, and external side effect `none`.

### Stakeholder and Contact Discovery

1. User runs `jobos research stakeholders --job <job-id> --json`.
2. Person extractor creates ranked candidates from observations, public search, and explicitly user-authorized account sources where available.
3. Contact engine extracts exact emails and patterns, then generates contact points.
4. Exact and user-approved contacts may be persisted; guessed email candidates remain worksheet-only until approval.
5. Candidates with sufficient relevance are promoted or staged for review.
6. Markdown worksheet shows person, role relevance, contact evidence tier, source URLs, and warnings.
7. No message is sent, and private-account sources are accessed only through explicit user authorization.

### Outreach Planning and Drafting

1. User runs `jobos outreach plan --job <job-id> --profile <profile-id> --json`.
2. Planner ranks candidate paths by relationship strength, contact confidence, role relevance, source freshness, and application status.
3. User chooses a plan or lets JobOS draft for the top recommended plan.
4. Draft generation uses only allowed evidence: stakeholder source, company fact, contact evidence, relationship edge, and proof point.
5. Existing `outreach_threads` records human-sent status and follow-up tasks.

## Confidence Model

Use transparent additive scoring, then map to labels:

```text
person_relevance =
  role_title_match
  + company_affiliation_strength
  + role_family_alignment
  + source_trust
  + source_recency
  - ambiguity_penalty

contact_confidence =
  exact_public_email_evidence
  + same_domain_pattern_support
  + dns_mx_present
  + person_company_match
  - guessed_pattern_penalty
  - stale_source_penalty
  - generic_or_role_account_penalty

path_strength =
  relationship_edge_strength
  + stakeholder_relevance
  + contact_confidence
  + outreach_goal_fit
  - application_status_pause_penalty
  - suppression_penalty
```

Labels:

- `high`: exact source-backed and low ambiguity.
- `medium`: source-backed but incomplete, stale, or pattern-derived.
- `low`: weak source support or only a hypothesis.
- `blocked`: suppression, do-not-contact, unauthorized private-account source, or unsafe channel.

## Privacy, Ethics, and Compliance

This system is designed for personal use — finding contacts for the user's own job search outreach. The following overrides apply relative to the original ethics design.

Hard prohibitions (these are legal/technical boundaries, not just ethics):

- No auto-send, auto-connect, auto-apply, or auto-follow-up.
- No private-account access unless the user explicitly authorizes their own session or exported data.
- No bypassing access controls, captchas, or rate limits.
- No breached/leaked datasets.
- No hidden tracking pixels or email open tracking.
- No actual email delivery for verification.
- No fake accounts or proxies.

Personal-use overrides (what changed from the original design):

- Public company pages are fetched directly with `fetch()` + cheerio. This is standard crawling of public web pages, not browser automation. `robots.txt` is consulted for crawl-delay hints but does not block fetching of individual public pages.
- LinkedIn public profile URLs from search results are recorded as `profile_url` contact points (Tier E). The LinkedIn page is never fetched by JobOS — recording a public URL that DuckDuckGo already indexed is not scraping.
- Guessed email candidates are visible in the contact worksheet with evidence tiers and source URLs. The user reviews them in the same workflow. For personal use, the user is the sole reviewer.
- SMTP mailbox probing is available behind `JOBOS_SMTP_PROBE=true` env flag, rate-limited (1 per domain per 30s), and audited. It checks RCPT TO acceptance without sending data.

Default safeguards:

- Store source URL, query, provider, timestamp, and confidence for every observation.
- Require human approval before a contact point can be used in an email-channel draft.
- Keep suppression lists local.
- Pause outreach when application status is interview, offer, rejected, or user-suppressed.
- Render a cold-email compliance checklist, but do not insert a default opt-out sentence or claim legal compliance.

## MVP Scope

MVP should fit the existing single-user, local-first CLI and dashboard. Contact discovery is the primary goal — the implementation order below reflects that priority.

1. Add `source_observations`, `person_candidates`, `contact_points`, `email_patterns`, and `relationship_edges` tables with migrations.
2. Implement page fetcher + email extractor in `src/research/sources.js`: fetch company /team, /about, /press, /contact pages, extract `mailto:` anchors and plain-text emails. This is the highest-leverage component.
3. Add email pattern inference, DNS/MX checks via `dns.promises`, and optional SMTP probing behind `JOBOS_SMTP_PROBE=true`.
4. Add `research contacts --job <id> --json` command and contact worksheet with evidence tiers.
5. Add contact-focused query packs (company emails, People Ops, hiring managers, public profile URLs) to the stakeholder research flow.
6. Allow LinkedIn public profile URLs from search results to be recorded as `profile_url` contact points (Tier E).
7. Refactor `research company` and `research stakeholders` to store reusable source observations.
8. Add user-imported network CSV and `research network` command.
9. Add `outreach plan` command that ranks safe paths and feeds existing `outreach draft`.
10. Add dashboard contact views for candidate review, confidence labels, approval, and suppression.
11. Add GitHub org adapter for public member discovery.
12. Add Wayback Machine CDX adapter for archived team pages.
13. Add GDELT DOC API adapter for company news/event signals.
14. Add optional Exa/Tavily search providers for better people-search coverage.
15. Extend `run_eval_research.js` with fake source pages, exact email examples, pattern examples, network edges, and negative cases.

Out of MVP:

- Browser automation.
- Required paid APIs.
- User-GUI-browser private-account connector.
- Automatic sending/sequencing.
- Phone number enrichment except official public switchboard or user-provided values.

## Future Expansion

- Additional public ATS adapters such as Ashby and Workable.
- Per-company source cache with freshness policies and diffing.
- Dashboard views for stakeholder map and network path ladder beyond the MVP contact review view.
- Local LLM or embedding-based dedupe for person/company aliases.
- Bring-your-own paid or agentic search/enrichment adapter behind the same evidence/confidence interface, disabled by default and retained only when evaluations prove better results.
- Optional user-GUI-browser connector for explicitly authorized sessions, separated from headless CLI/API/MCP behavior.
- Team/multi-profile mode with encrypted local store if JobOS expands beyond single-user local operation.

## Recommended Implementation Order

Contact discovery is the primary goal — the order below front-loads the highest-leverage contact-finding features.

### Phase 1: Contact Discovery Core (Highest Impact)

1. **Page fetcher + email extractor** — fetch company /team, /about, /press, /contact pages, extract `mailto:` and plain-text emails. ~150 lines in `src/research/sources.js`. This alone will find more contacts than everything else combined.
2. **Email pattern inference** — detect `first@`, `first.last@`, etc. from observed emails. ~80 lines in `src/research/contacts.js`.
3. **DNS/MX verification** — `dns.promises` module, ~40 lines. Add to `src/research/contacts.js`.
4. **`contact_points` + `email_patterns` tables** — schema migration in `src/db.js`.
5. **`research contacts --job <id> --json` command** — CLI wiring in `src/cli.js`.
6. **Contact worksheet** — Markdown output with evidence tiers, source URLs, warnings.
7. **Eval expansion** — fake team pages with emails, fake DNS, pattern inference assertions.

### Phase 2: Person Discovery Improvement

8. **Person candidate staging** — `person_candidates` table, promote workflow.
9. **Allow LinkedIn URLs in source recording** — modify `sourceAllowed()` to allow `linkedin.com/in/` URLs.
10. **Contact-focused query packs** — add the person/recruiter/hiring-manager queries to the stakeholder research flow.
11. **GitHub org adapter** — public member discovery for technical companies.

### Phase 3: Outreach Intelligence

12. **Outreach planner** — `outreach_plans` table, path ranking, `outreach plan` command.
13. **Network graph import** — CSV import, `relationship_edges` table.
14. **Suppression lists** — per-person, per-domain, per-recruiter/company-pair.
15. **Optional Exa/Tavily providers** — for better search coverage.

### Phase 4: Verification Depth

16. **SMTP probing** — behind `JOBOS_SMTP_PROBE=true` flag, rate-limited, audited.
17. **Wayback Machine adapter** — archived team pages for email discovery.
18. **GDELT adapter** — news/event signals for company research.

### Phase 5: Integration

19. **API/MCP/dashboard exposure** — only after CLI behavior and eval coverage are stable.
20. **Eval expansion** — hard assertions for no-send, no-private-scrape, no unsupported contact claims, confidence labels, and headless deterministic runs.

## Test Strategy

The existing eval harness (`run_eval_research.js`) passes 33/33 hard assertions and scores 10/10 on all 12 axes for company dossiers, stakeholder discovery, and outreach drafting. The following additions are needed for contact discovery coverage.

Targeted unit/behavior tests:

- Source observations dedupe by canonical URL and content hash.
- Company identity collision warnings.
- Page email extraction: fake team page with `mailto:` links and plain-text emails → extractor finds all emails → stores as source observations with page URL as evidence.
- Pattern inference from multiple public examples: fixture with `jane.doe@company.com` and `john.smith@company.com` → detects `first.last@` pattern → generates `maya.chen@company.com` for a source-backed person → labels as `pattern_candidate` (Tier C).
- DNS/MX checks using injectable fake DNS resolver: MX/no-MX/catch-all-like cases → verification labels match.
- SMTP probing using injectable fake SMTP resolver and `JOBOS_SMTP_PROBE=true` flag: accept/reject/unknown cases without sending email → labels match.
- Contact confidence labels for exact, pattern, and DNS-only cases.
- LinkedIn URL recording: search result includes `linkedin.com/in/maya-chen` → source recorded as `profile_url` contact point (Tier E) → page NOT fetched.
- Person candidate staging: 5 candidates, 2 false positives → staging table holds all → promote only valid ones → stakeholders table gets only approved.
- Stakeholder candidate promotion and suppression.
- Network edge CSV import and path ranking.
- Dashboard contact review, approval, and suppression behavior.
- Outreach planner blocks unapproved guessed contacts.

End-to-end eval additions:

- Fake search server returns company pages, team pages, exact emails, generic inboxes, and distractors.
- Fake DNS resolver returns MX/no-MX/catch-all-like cases.
- Fake SMTP resolver returns accepted/rejected/unknown cases without sending email.
- Fake LLM attempts unsupported contact claims (e.g. returns `maya.chen@company.com` as "verified" without source) → JobOS drops them and labels as unverified.
- Hard assertions prove no live network beyond local fake servers unless explicitly configured, no sent outreach, and no unauthorized private-account access.

## Risks and Unknowns

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Search provider instability | Missing or noisy sources | Cache observations, support SearXNG, evaluate optional agentic providers, show warnings |
| False positive people | Bad outreach targeting | Candidate staging, source-backed role checks, LLM conservative filtering |
| False positive emails | Trust damage | Evidence tiers, no "verified" for guesses, approval gates |
| Legal/compliance ambiguity | User misuse | Clear warnings, no sending, suppression lists, compliance checklist without default opt-out sentence |
| Scope creep into CRM/sequencer | Product invariant erosion | Keep outreach lifecycle local and human-gated |
| Large single-file complexity | Maintainability risk | Put new logic under `src/research/` modules while keeping CLI router thin |

## Open-Source Tools and References

| Tool | What it does | How JobOS uses it | License |
|------|-------------|-------------------|---------|
| `apifyforge/email-pattern-finder` | Detects company email naming convention from domain | Pattern inference logic reference | Check repo |
| `@devmehq/email-validator-js` | Email verification with MX, disposable, DNS checks | npm dependency or reference implementation | MIT |
| `alpkeskin/mosint` | Automated email OSINT (Go) — checks email across services | Reference for verification workflow | MIT |
| `megadose/holehe` | Checks if email is registered on sites (Twitter, Instagram, etc.) | Reference for email validation approach | GPL-3.0 |
| `AfterShip/email-verifier` | Go email verification with MX, SMTP | Reference for SMTP probing logic | MIT |
| `jivoi/awesome-osint` | Curated OSINT tool list | Source discovery for additional adapters | — |
| Wayback CDX API | Archived web page lookup | No dependency — use `fetch()` | Public API |
| GDELT DOC API | Global news index | No dependency — use `fetch()` | Public API |
| GitHub REST API | Public org members, user profiles | No dependency — use `fetch()` | Public API |
| Exa API | AI-powered people/company search | Optional paid provider adapter | API key |
| Tavily API | Search + extract + crawl | Optional paid provider adapter | API key |

## Product Decisions Captured

1. Guessed email candidates are visible in the contact worksheet with evidence tiers. The user reviews them in the same workflow — approval creates the persistent `contact_points` row. For personal use, the user is the sole reviewer.
2. SMTP probing is available behind `JOBOS_SMTP_PROBE=true` env flag, rate-limited (1 per domain per 30s), and audited.
3. Relationship import ships first as CSV.
4. Cold email drafts do not include a default opt-out sentence.
5. Dashboard contact views are included in the first implementation loop.
6. Public company pages are fetched directly with `fetch()` + cheerio — standard crawling, not browser automation.
7. LinkedIn public profile URLs from search results are recorded as `profile_url` contact points (Tier E). The LinkedIn page is never fetched by JobOS.
8. Contact discovery is the primary product goal. The implementation order front-loads page fetching, email extraction, and pattern inference.

## Self-Evaluation Rubric

Scores use 1-5, where 5 means the criterion is strongly satisfied in the final docs.

### Research Quality

1. Source coverage: names concrete public, user-authorized, and optional configured sources and cites official docs where possible.
2. Accuracy and honesty: distinguishes facts, inferences, hypotheses, and unavailable proprietary coverage.
3. Contact/outreach priority: puts personnel and contact discovery ahead of generic company research.
4. Headless baseline feasibility: avoids required paid APIs and browser automation for MVP.
5. Limitations and open questions: surfaces legal, ethical, data-quality, and operational trade-offs.
6. Integration relevance: ties research to JobOS data, commands, and invariants.

### Functionality and Integration

1. Fits current modules: builds on `research.js`, `outreach.js`, `search.js`, DB, API/MCP, and eval harness.
2. Data model clarity: proposes concrete tables, fields, confidence labels, and workspace mirrors.
3. Flow completeness: covers company dossier, stakeholder discovery, contact discovery, network mapping, outreach planning, and follow-ups.
4. Testability: includes deterministic headless test/eval strategy.
5. Safety enforcement: includes hard gates against unsupported claims, unauthorized private-account access, and auto-send behavior.
6. Implementation order: breaks MVP and future work into sequenced steps.

### Creative and UX Design

1. Hunter/Apollo reconstruction: recreates useful workflow pieces without pretending to match proprietary databases.
2. Contact confidence UX: gives users understandable evidence tiers and path strength.
3. Outreach effectiveness: improves "why this person, why now, why me" drafting.
4. 2nd-degree expansion: includes practical local graph ideas from proof points, alumni, employers, VC, events, and open source.
5. Human review ergonomics: supports approval, suppression, warnings, and copy/manual-send gates.
6. Role-specific value: prioritizes People Ops, recruiters, hiring managers, and relevant functional stakeholders.

## Self-Evaluation and Revision Log

### Cycle 1

Scores:

- Research Quality: 4.1/5
- Functionality and Integration: 3.8/5
- Creative and UX Design: 3.7/5

Findings:

- The first outline overemphasized email guessing and under-specified evidence tiers.
- Architecture needed clearer schema proposals and command surfaces.
- Network expansion was too abstract.

Revisions made:

- Added evidence tiers A-E, contact confidence model, table schemas, CLI/API/MCP proposals, and relationship edge types.

Remaining gaps after cycle 1:

- Need stronger compliance language and clearer SMTP boundary.
- Need more measurable test strategy.

### Cycle 2

Scores:

- Research Quality: 4.5/5
- Functionality and Integration: 4.3/5
- Creative and UX Design: 4.2/5

Findings:

- The architecture now fit JobOS better but still risked sounding like a sending/sequencing system.
- The company dossier section needed better HR/operational signal coverage.
- Contact verification needed explicit "not verified by MX alone" language.

Revisions made:

- Added hard prohibitions, compliance safeguards, HR/operational source matrix, verification policy, and explicit no-send/no-SMTP-by-default language.

Remaining gaps after cycle 2:

- User decisions remained around persistent guessed contacts, opt-out defaults, relationship import format, and dashboard priority.

### Cycle 3

Scores:

- Research Quality: 4.7/5
- Functionality and Integration: 4.6/5
- Creative and UX Design: 4.5/5

Findings:

- The final docs are actionable for a follow-on implementation loop and preserve the product invariants.
- The largest remaining uncertainty was policy/product direction, not architecture: how aggressive JobOS should be with guessed emails and cold-email compliance text.

Remaining gaps after cycle 3:

- Exact source reliability will only be proven once the implementation runs against fixture and real-world cases.
- Jurisdiction-specific outreach compliance requires human/legal review.

### Cycle 4

Findings:

- Product decisions now allow user-authorized private-account sources, optional agentic search providers, worksheet-only guessed email candidates, advanced-flag SMTP probing, CSV relationship import, no default opt-out sentence, and first-loop dashboard contact views.
- The architecture still preserves human-gated external actions: research and drafting can be staged, but JobOS does not send or submit.

Remaining gaps after cycle 4:

- The user-GUI-browser connector remains a next-iteration design item, separate from the headless MVP.
- Optional agentic search providers must prove better results in fixture and real-world evaluations before becoming recommended defaults.

### Cycle 5 (Audit-Driven Revision)

Findings:

- The docs over-constrained contact discovery. Page fetching, email pattern inference, DNS/MX verification, LinkedIn URL recording, and person candidate staging were described but not prioritized. The contact discovery layer is 0% implemented while outreach is 90% done.
- The existing eval harness passes 33/33 hard assertions but has zero coverage for email extraction, pattern inference, DNS/MX, SMTP, LinkedIn URL recording, or person candidate staging.
- The docs spent more energy on what not to do than on how to actually find contacts.

Revisions made:

- Added page fetching with `fetch()` + cheerio as standard crawling (not browser automation).
- Added LinkedIn public profile URL recording (Tier E) — page never fetched, URL from search results only.
- Added GitHub org member adapter, Wayback Machine CDX adapter, GDELT DOC API adapter.
- Added concrete open-source tool references (email-pattern-finder, email-validator-js, AfterShip/email-verifier).
- Reordered implementation to front-load contact discovery (page fetcher + email extraction first).
- Updated ethics section with personal-use overrides (page fetching, LinkedIn URL recording, worksheet-visible guesses, SMTP probing).
- Added eval expansion plan with 6 new test cases for contact discovery.

Revised scores:

- Research Quality: 4.2/5 (over-indexed on constraints, under-indexed on extraction guidance)
- Functionality and Integration: 3.5/5 (contact discovery 0% implemented, 5 tables and 7 commands proposed but not built)
- Creative and UX Design: 4.0/5 (evidence tiers and path ladder are strong, but contact review UX underspecified)
- Testability: 3.8/5 (existing eval excellent but zero contact discovery coverage)

## Recommended Next Steps

1. Implement page fetching + email extraction (Phase 1, item 1) — this alone will find more contacts than everything else combined.
2. Add email pattern inference + DNS/MX checks (Phase 1, items 2-3).
3. Expand the eval with fake team pages containing emails (Phase 1, item 7).
4. Allow LinkedIn URL recording from search results (Phase 2, item 9).
5. Add Exa or Tavily as an optional provider for better people-search coverage (Phase 3, item 15).
6. Add optional agentic provider adapters and the user-GUI-browser connector only after the headless workflow is deterministic and well covered.
