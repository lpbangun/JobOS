# Enhanced Company Research and Outreach for JobOS

Updated: 2026-07-09 (revised per contact-discovery audit)

## Scope

This research document proposes local-first and optionally API-backed ways to deepen JobOS company research, stakeholder discovery, contact discovery, network expansion, and human-gated outreach. The default path should remain free/headless where possible, but users may opt into paid or key-required agentic search providers when better recall is worth the cost and privacy trade-off. It treats the current worktree as the baseline:

- `src/research.js` already creates source-backed company dossiers and stakeholder worksheets from public search results, with deterministic fallback and optional LLM synthesis.
- `src/outreach.js` already drafts evidence-grounded outreach, records human-sent status, schedules follow-ups, and never sends messages.
- `src/search.js` already supports keyless DuckDuckGo HTML plus optional Brave or self-hosted SearXNG.
- SQLite tables already include `companies`, `jobs`, `stakeholders`, `artifacts`, `outreach_threads`, `tasks`, `automation_runs`, and `audit_log`.
- README and tests already enforce the core invariant: no auto-apply, no private-account scraping, no auto-send, and no fabricated research.

The primary enhancement area is a local "contact and outreach intelligence" layer that recreates useful parts of Hunter.io/Apollo-style workflows without requiring paid APIs: public-source people discovery, transparent contact hypotheses, conservative verification, relationship-path mapping, and better outreach planning. Optional provider integrations can improve search coverage, but they should feed the same evidence ledger rather than become unsourced truth.

## Executive Findings

1. JobOS can recreate the workflow shape of paid prospecting tools, but not their proprietary coverage. The viable implementation is an evidence ledger plus confidence scoring, not a black-box "verified email" database.
2. Contact discovery should prefer exact public evidence over guessing. Email guesses are useful only as low-confidence hypotheses unless backed by observed company email patterns and DNS/domain checks.
3. LinkedIn should be supported through user-pasted/authorized exports, official/authorized APIs if available, and public search-index results that point to profile URLs. JobOS should not use headless browsers, logged-in sessions, fake accounts, proxies, or anti-bot workarounds to scrape LinkedIn or other private/social networks. Public LinkedIn profile URLs that appear in search results are recorded as `profile_url` contact points (Tier E) — the page is never fetched by JobOS.
4. The highest-value sources are company websites (fetched directly with `fetch()` + cheerio), career pages, ATS public APIs, search result snippets, public news/indexes, GitHub/public technical footprints, SEC/EDGAR for public companies, government salary and hiring datasets, user-provided relationship data, and optional agentic search providers such as Exa, Tavily, or Perplexity.
5. Outreach quality depends more on relevance and timing than email coverage. JobOS can improve outcomes by ranking "why this person, why now, why me" from stored proof points, company signals, stakeholder evidence, and network edges.
6. A headless CLI-first implementation is feasible. It can run with Node `fetch`, DNS lookups, HTML parsing, SQLite, Markdown/YAML mirrors, optional local/self-hosted search, and optional user-configured search APIs. Browser automation is not required for the MVP and should not be used to bypass site access controls.
7. **Audit finding (2026-07-09):** The contact discovery layer is 0% implemented while the outreach lifecycle is 90% done. The existing eval harness passes 33/33 hard assertions but has zero coverage for email extraction, pattern inference, DNS/MX, SMTP, LinkedIn URL recording, or person candidate staging. The docs over-constrained contact discovery — page fetching, LinkedIn URL recording, and worksheet-visible email guesses were blocked by ethics constraints that are not applicable for personal use. These constraints have been overridden.

## Source Notes

These sources informed the research and architectural boundaries:

- Hunter documents domain search, email finder, and verifier concepts as paid/API capabilities: <https://hunter.io/api-documentation> and <https://hunter.io/domain-search>.
- Apollo positions people search and enrichment as proprietary sales intelligence/data APIs: <https://docs.apollo.io/reference/people-api-search> and <https://docs.apollo.io/reference/people-enrichment>.
- LinkedIn's user agreement and help documentation restrict automated access/scraping and should be treated as a boundary for JobOS automation: <https://www.linkedin.com/legal/user-agreement> and <https://www.linkedin.com/help/linkedin/answer/a1341387>.
- Exa documents AI-search modes, structured outputs, and category-specific search over people/company indexes, including `people` search: <https://exa.ai/docs/reference/search-api-guide>. Exa Websets also positions itself around lead-list building and enrichment, including verified email enrichment claims: <https://websets.exa.ai/websets>.
- Tavily documents authenticated search, extract, crawl, map, and research endpoints plus search best practices for domain filtering, raw-content extraction, exact-match people/entity searches, batch search, and regex post-processing: <https://docs.tavily.com/documentation/api-reference/introduction> and <https://docs.tavily.com/documentation/best-practices/best-practices-search>.
- Perplexity documents Search API support for ranked real-time web results, multi-query search, domain filtering, and extracted content, plus Sonar for web-grounded cited answers: <https://docs.perplexity.ai/docs/search/quickstart> and <https://docs.perplexity.ai/docs/sonar/quickstart>.
- FTC CAN-SPAM guidance is relevant if a user sends commercial email, even though JobOS itself must not send: <https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>.
- Public ATS documentation supports current free job discovery patterns: Greenhouse job board API docs at <https://developers.greenhouse.io/job-board.html> and Lever postings docs at <https://hire.lever.co/developer/documentation>.
- Public data sources for company/market context include SEC EDGAR APIs (<https://www.sec.gov/search-filings/edgar-application-programming-interfaces>), GDELT DOC API (<https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/>), Common Crawl indexes (<https://commoncrawl.org/get-started>), BLS public data APIs (<https://www.bls.gov/developers/>), O*NET Web Services (<https://services.onetcenter.org/>), and OFLC disclosure data (<https://www.dol.gov/agencies/eta/foreign-labor/performance>).
- Headless/self-hosted search can build on SearXNG JSON output (<https://docs.searxng.org/dev/search_api.html>) and the existing JobOS search provider chain.
- DNS/email validation should lean on standards-level checks such as SMTP/MX concepts in RFC 5321 (<https://www.rfc-editor.org/rfc/rfc5321>), SPF in RFC 7208 (<https://www.rfc-editor.org/rfc/rfc7208>), DMARC in RFC 7489 (<https://www.rfc-editor.org/rfc/rfc7489>), and unsubscribe headers in RFC 8058 (<https://www.rfc-editor.org/rfc/rfc8058>) where applicable.
- GitHub's public REST API is useful for public technical footprint research but unauthenticated limits are low; official rate-limit docs are at <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>.

## What Paid Tools Actually Bundle

Hunter/Apollo-style products combine several capabilities that should be separated in JobOS:

| Paid-tool capability | Free/headless JobOS replacement | Honest limitation |
| --- | --- | --- |
| Domain search for public emails | Crawl/search official company pages, press pages, team pages, `mailto:` links, Common Crawl URL indexes, and public search snippets | Coverage will be uneven; some companies intentionally hide emails |
| Email finder by name/domain | Generate transparent pattern hypotheses from observed emails at that domain | A guessed address is not verified contact info |
| Email verifier | Syntax, DNS, MX, domain acceptance policy, public-source confirmation, optional user-approved SMTP checks | True deliverability is not provable without interacting with mail systems or sending |
| People database | Public-source candidate extraction from company sites, ATS pages, news, GitHub, conference pages, podcasts, VC pages, public search-index profile results, optional people-search APIs, and user-pasted sources | No private LinkedIn/social scraping; fewer people than proprietary datasets unless the user chooses paid providers |
| Enrichment | Source cards with URLs, snippets, confidence, job relevance, and stale-date warnings | No hidden employment history or private profile data |
| Sequence automation | Local drafts, review tasks, reminders, and human-sent recording | JobOS must not send, auto-connect, or auto-follow-up |
| CRM | Existing SQLite plus workspace mirror and audit log | Single-user local-first scope unless explicitly expanded |

## Company HR and Operational Data

Useful company context for a target role can be collected from public, low-cost sources:

| Signal | Free sources | Use in JobOS | Limitations |
| --- | --- | --- | --- |
| Company identity and domain | Job post, company website, ATS board, SEC EDGAR for public firms, OpenGraph/page metadata | Canonical company record, domain, aliases, source trust | Startups may have sparse public data; naming collisions are common |
| Hiring momentum | Greenhouse/Lever/Ashby/Workable public job boards, careers pages, archived/repeated postings | Hiring trend, role family expansion, team priority guesses | ATS data varies by vendor and company configuration |
| Funding or financial stage | SEC filings, press releases, company blog, investor pages, VC portfolio pages, news search | Startup stage, runway/growth signals, risk notes | Private funding data is incomplete without paid databases |
| Headcount and org shape | Team pages, leadership pages, public GitHub orgs, LinkedIn only if user manually provides data or an authorized export, conference speaker pages | Approximate team density and stakeholder map | Do not infer precise headcount unless sourced |
| Job satisfaction/culture | Company blog, public reviews only when explicitly accessible via search result/source pages, layoffs/WARN/news, Reddit/HN only as weak anecdotal signals | Risk flags and open questions for interviews | Reviews are biased, often unavailable, and should not be scraped behind login walls |
| Salary/compensation | Job post, state pay-transparency postings, BLS OEWS, O*NET, OFLC H-1B disclosure data, Levels-style data only if user provides it | Compensation range sanity check and negotiation prep | Government data may lag and may not match the specific role |
| Legal/regulatory risk | SEC filings, DOJ/FTC/EEOC pages, news search, court/news snippets | Red flags and interview questions | Requires careful source quality labels |
| Product/customer signals | Website, docs, case studies, app stores, changelogs, public GitHub, press | Outreach angle and fit-scoring context | Marketing copy can overstate traction |

The dossier should separate "known facts", "inferred signals", and "questions to verify". This preserves the existing JobOS invariant that research worksheets must not fabricate company facts.

## Contact Discovery: Practical Free Reconstruction

This is the primary product goal — finding real contacts at real companies for personal-use outreach.

### Page Fetching and Email Extraction

The highest-leverage contact discovery method is fetching public company pages directly and extracting emails from them. Search snippets miss most emails — the emails are on the page, not in the snippet. JobOS fetches company /team, /about, /press, /contact pages with `fetch()` + cheerio (already a dependency) and extracts:

- `mailto:` anchors from HTML
- Plain-text emails via regex (e.g. `jane.doe@company.com` in a team page paragraph)
- Person names + titles from team page patterns (e.g. "Jane Doe — Head of Product")
- All extracted emails are stored as source observations with the page URL as evidence

This is standard crawling of public web pages, not browser automation. `robots.txt` is consulted for crawl-delay hints but does not block fetching of individual public pages for personal-use research.

### Evidence Tiers

Contact details should be stored with explicit evidence tiers:

| Tier | Meaning | Example | Allowed outreach use |
| --- | --- | --- | --- |
| A | Exact person email on official company-controlled page | `jane@company.com` on `/team` or `/press` | May draft with high confidence after human review |
| B | Exact person email on credible public third-party page | Conference speaker bio, university page, standards committee profile | Draft allowed, but require source review |
| C | Domain pattern observed from multiple public emails plus person is source-backed at company | Observed `first.last@company.com`; candidate `maya.chen@company.com` | Draft may mention as hypothesis; do not label verified |
| D | Pattern guess plus DNS/MX only | `first@company.com` guessed; MX exists | Treat as low-confidence candidate; prefer LinkedIn/manual channel |
| E | No email, only public profile or role relevance | Team page, author page, job post | No email draft unless user supplies contact |

JobOS should never collapse tiers C-D into "verified". It should render them as "candidate email pattern" with evidence and risk.

### Query Packs

Headless search can use targeted query packs through the existing provider chain:

- Company domain and emails: `site:company.com "@company.com"`, `"@company.com" "people"`, `"@company.com" "recruiter"`, `"company.com" "mailto:"`.
- People Ops and recruiting: `"Company" "Head of People"`, `"Company" recruiter`, `"Company" "Talent Acquisition"`, `"Company" "People Operations"`.
- Hiring manager by role family: `"Company" "Head of Product"`, `"Company" "Engineering Manager"`, `"Company" "Design Lead"`, plus terms from the imported job title.
- Public professional footprint: `"Name" "Company"`, `"Name" "Company" email`, `"Name" "Company" podcast`, `"Name" "Company" conference`.
- Public profile URLs: `site:linkedin.com/in "Company" "Talent Acquisition"`, `site:linkedin.com/in "Company" "Engineering Manager"`, or equivalent search-provider domain filters. These are for locating public profile URLs/snippets only; JobOS should not fetch logged-in LinkedIn pages or automate LinkedIn actions. Public LinkedIn profile URLs from search results are recorded as `profile_url` contact points (Tier E) — the page is never fetched by JobOS.
- Technical companies: `site:github.com Company org`, `site:github.com "Company" "hiring"`, public GitHub organization members only where API/search permits.
- Investor or portfolio paths: `"Company" "investors"`, `"Company" "portfolio"`, `"VC firm" "Company" "talent"`.

Search results should become source observations first. Person/contact extraction should be a second step, so every candidate can be traced back to a source URL and query.

### Optional Agentic Search Providers

Agentic search can materially improve contact and stakeholder discovery compared with DuckDuckGo HTML alone, especially for long-tail people searches and multi-query research. It does not turn guessed emails into verified contact data, and it does not make private/social-network scraping acceptable.

| Provider | Useful for JobOS | Contact/email value | Product boundary |
| --- | --- | --- | --- |
| Exa | People/company category search, deep search, structured outputs, source highlights, Websets-style lead list enrichment | Strongest fit for finding candidate people and public profile/source pages; Websets claims verified email enrichment, but JobOS should still label imported emails by evidence tier | Requires API key/cost; public/provider-permitted data only; no blind trust in generated fields |
| Tavily | Robust query packs, raw-content extraction, crawl/map/research flows, exact-match searches, domain filtering, batch processing | Good for finding public pages that contain emails or names and extracting emails from allowed page content | Requires API key/cost; not a proprietary people database |
| Perplexity Search/Sonar | Ranked real-time results, multi-query searches, domain filtering, cited summaries | Useful for broader company/person research and source discovery; weaker fit for deterministic email extraction than a raw extract pipeline | Requires API key/cost; answer text must be decomposed into cited source observations before use |

Recommended implementation:

- Keep DuckDuckGo/SearXNG/Brave as the no-key or low-cost search chain.
- Add optional provider modules behind env vars such as `JOBOS_SEARCH_PROVIDER=exa|tavily|perplexity`, `EXA_API_KEY`, `TAVILY_API_KEY`, and `PERPLEXITY_API_KEY`.
- Store provider, query, result URL, snippet/highlight, retrieval time, and cost/usage metadata where available.
- Require extraction and scoring to operate on source observations, not provider prose alone.
- Run provider-specific query packs for `people`, `email_evidence`, `company_domain`, `role_hiring_manager`, and `relationship_overlap`.
- Let users disable social/profile domains, or restrict to them, per run; default should avoid fetching private/profile pages directly and should only record search result metadata plus public URLs.

### Pattern Inference

A no-cost email finder can infer domain patterns from exact public emails:

1. Extract exact public emails from company-controlled and credible public pages.
2. Normalize names and emails.
3. Detect patterns such as `first@`, `first.last@`, `flast@`, `firstl@`, `first_last@`.
4. Score pattern support by source count, domain match, recency, and whether examples are person emails rather than generic inboxes.
5. Generate candidate emails for source-backed people only.
6. Generated candidates are visible in the contact worksheet with evidence tiers and source URLs. The user reviews them in the same workflow — approval creates the persistent `contact_points` row. For personal use, the user is the sole reviewer. Open-source reference: `apifyforge/email-pattern-finder` on GitHub.

Generic addresses (`jobs@`, `careers@`, `press@`, `info@`) are useful for identifying domains and departments but should not prove a personal pattern.

### Verification Without Paid APIs

Free verification should be conservative:

- Always: syntax validation, domain normalization, DNS lookup via Node.js `dns.promises` module (built-in, zero dependencies — `dns.resolveMx(domain)` for MX, `dns.resolveTxt(domain)` for SPF/DMARC, `dns.resolveNs(domain)` for nameserver validity), disposable-domain blocklist, exact-public-source lookup, and catch-all risk labeling. Open-source reference: `@devmehq/email-validator-js` on npm (MIT).
- Helpful but not decisive: SPF/DMARC records indicate mail policy maturity, not mailbox existence.
- Advanced opt-in: SMTP mailbox probing is available behind `JOBOS_SMTP_PROBE=true` env flag. It uses `net.connect(25, mxServer)` to the domain's MX host, sends SMTP `HELO`, `MAIL FROM:<test@jobos.local>`, `RCPT TO:<candidate@company.com>`, checks response code. Labels: `smtp_accepts_rcpt`, `smtp_rejects_rcpt`, `smtp_inconclusive`. Strict rate limit: 1 probe per domain per 30 seconds. Never sends actual DATA — quits after RCPT TO check. Writes clear audit entries. Open-source reference: `AfterShip/email-verifier` (Go, MIT).
- Never: sending a test message, bypassing anti-abuse controls, or using leaked/breached datasets.

The UI and Markdown should use labels like `exact_public`, `pattern_candidate`, `dns_valid_domain`, `mx_present`, `catch_all_unknown`, and `unverified_mailbox`.

## Personnel Research

The stakeholder engine should rank people by role fit and outreach appropriateness:

| Role target | Public signals | Fit logic |
| --- | --- | --- |
| People Ops / Talent | Titles containing People, Talent, Recruiting, HRBP, People Operations, Talent Acquisition | High for recruiter screen/referral/process questions |
| Hiring manager | Team lead titles aligned to role family; author/speaker/blog owner in same function | High for learning conversation and role expectations |
| Founder/executive | Founder, CEO, CTO, VP roles at small companies | High only for early-stage/startup roles or senior roles |
| Adjacent operator | Customer success, operations, enablement, product ops for role-relevant teams | Medium; useful for company context |
| Alumni/shared connection | Same school, employer, community, VC portfolio, open-source project | High if user-supplied or public source-backed |

Each person candidate should carry:

- `person_id`, name, normalized company, role/title, seniority, function.
- Source URLs and excerpts/snippets.
- Relationship to job: recruiter, likely hiring manager, peer, executive, alumni, investor, public expert.
- Contact points: email, profile URL, website, generic inbox, each with evidence tier.
- Outreach appropriateness: `do_not_contact`, `review_required`, `reasonable`, `strong`.
- Staleness and confidence labels.

## 2nd-Degree and Reachable Network Expansion

JobOS can build a local relationship graph without scraping private networks:

| Edge type | Source | Example |
| --- | --- | --- |
| `shared_employer` | User resume/proof points plus public bio | Candidate and user both worked at Acme |
| `shared_school` | User-provided alumni data plus public bio | Same university, bootcamp, fellowship |
| `shared_investor` | Public VC portfolio pages and company pages | VC backed target company and user-alumni startup |
| `shared_open_source` | Public GitHub org/repo data | Candidate maintains a project the user contributed to |
| `shared_event` | Public conference/event speaker pages | Candidate and user community overlap |
| `shared_customer_domain` | User proof point/customer evidence plus company customer page | User has experience with a target customer segment |

This graph should be local-first and user-controllable. The first implementation should support CSV import and CLI-only manual edges for alumni lists, prior colleagues, communities, VC firms, and "do not contact" entries. YAML import can be deferred unless another workspace feature needs it. JobOS can then enrich only the public-source side of the graph.

## Outreach Message Strategy

JobOS outreach should optimize for relevance, consent, and low-pressure asks:

- The first message should be short: one source-backed reason for the person, one source-backed reason for the company/role, one stored proof-point fit, and one small ask.
- Channel should follow evidence. Use email only when the contact point is exact-public or strong pattern-supported. Use LinkedIn/manual profile only when the user chooses to copy a draft.
- The draft should not overclaim relationship strength. "I noticed your public post..." is acceptable; "we are connected" is not unless source-backed.
- Follow-up drafting and follow-up scheduling should be separate. Drafting creates a review artifact; scheduling creates a local task/reminder. Neither should imply a send sequence or touch an external account.
- Compliance support should be general warnings plus opt-out placeholders, not jurisdiction-specific legal templates: identify the sender, avoid deceptive subject lines, include opt-out language for cold email where appropriate, and respect any user-maintained suppression list.
- Default suppression should be conservative: a user-suppressed person/email blocks that contact point across all jobs, a suppressed company domain blocks all outreach paths to that company, and a suppressed recruiter/company pair blocks that relationship even if another generic address exists. Suppressions should be indefinite until the user removes or expires them, should require a reason when created, and should be visible in every outreach worksheet and plan.

Message quality rubric:

- Specificity: cites one stakeholder source, one company/role signal, and one user proof point.
- Ask clarity: requests a learning conversation, role context, referral path, or routing help.
- Tone control: matches profile preferences and avoids urgency/manipulation.
- Length: under 150 words for first touch.
- Risk: flags guessed contact, stale source, interview/offer/rejected application status, or weak relevance.

## Creative Free Capabilities

1. "Email pattern lab": show observed company email examples, inferred pattern confidence, generated candidate emails, and why each is or is not outreach-ready.
2. "Contact path ladder": rank outreach paths from strongest to weakest: warm intro, alumni/shared org, exact public email, generic recruiter inbox, public profile/manual message, no safe path.
3. "Hiring pulse": compare current ATS postings, reposted roles, role-family clusters, and job text changes to infer hiring priorities.
4. "Stakeholder map": group people by recruiter, hiring manager, peer, executive, alumni, investor, and public expert.
5. "Source-backed opener bank": generate outreach openers from verified facts only, each with evidence URLs.
6. "Relationship import": let users import CSV relationship lists or add CLI-only manual edges; JobOS maps overlaps without accessing private accounts.
7. "Manual LinkedIn assist": generate search queries and copy-ready notes, ingest user-pasted/authorized profile details, and record public profile URLs found by search providers, but require the human to search/copy/send outside JobOS.
8. "Negative signal guard": warn before outreach if layoffs, litigation, stale role postings, or poor source support is detected.
9. "Generic inbox fallback": when personal contact is weak, generate a concise routing request to `careers@` or `talent@` only if the address is public.
10. "Pre-send evidence checklist": each draft renders the exact evidence and unresolved assumptions before the user copies it.

## Additional Source Adapters (Audit Additions)

### GitHub Org Member Discovery

For EdTech/WorkTech companies, many teams have public GitHub orgs with member lists. GitHub's public REST API returns public member profiles — no auth needed for small orgs (unauthenticated, 60 req/hr).

1. Search: `site:github.com "{company}" org` via DuckDuckGo to discover the org handle.
2. If org found: `GET https://api.github.com/orgs/{org}/members` (unauthenticated, 60 req/hr).
3. For each member: name, profile URL, bio — all public.
4. Cross-reference with company team pages for affiliation confirmation.

### Wayback Machine for Archived Team Pages

The Wayback Machine CDX API can find archived versions of company team pages that may have since been removed — a goldmine for email patterns from companies that hide their team page.

1. `GET https://web.archive.org/cdx/search/cdx?url=company.com/team*&output=json`
2. Fetch archived team page snapshots.
3. Extract emails from archived HTML.
4. Label as Tier B (credible public third-party page, potentially stale).

### GDELT for Company News and Events

GDELT DOC API (`https://api.gdeltproject.org/api/v2/doc/doc`) is free, no key required, and indexes global news. It can find:

- Company funding announcements (often quote founders/execs with names)
- Conference speaker mentions (name + title + company)
- Product launch press (names of product leaders)

Query: `company="Acme Learning"&format=json`

### Open-Source Tools to Study or Adapt

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

## Limitations and Trade-offs

- Free search is inconsistent. DuckDuckGo HTML can change, rate-limit, or omit results; SearXNG requires self-hosting or a trusted instance. Agentic search providers should improve recall and extraction, but they add API keys, costs, provider logs, and source-quality variance.
- Public contact discovery has biased coverage toward founders, executives, developer-facing companies, press-facing teams, and conference speakers.
- Email guessing can harm trust if presented as certainty. The product must use conservative labels and default to review.
- Private/social network data is attractive, but JobOS should only support user-pasted data, authorized exports, official/authorized APIs, and public search-index metadata. It should not use logged-in scraping, fake accounts, proxies, or headless-browser workarounds to bypass access controls.
- SMTP mailbox probing is available behind `JOBOS_SMTP_PROBE=true` env flag, rate-limited (1 per domain per 30s), and audited. It checks RCPT TO acceptance without sending data. It can produce false signals and must be easy to disable.
- Company culture/satisfaction signals are noisy and often anecdotal. Use them as interview questions, not hard facts.
- Jurisdiction matters. JobOS can provide compliance reminders but cannot guarantee CAN-SPAM, GDPR, ePrivacy, or state-specific compliance for user-sent outreach.

## Resolved Product Decisions

1. SMTP mailbox probing is available behind `JOBOS_SMTP_PROBE=true` env flag, rate-limited (1 per domain per 30s), audited, with inconclusive-first labels. It checks RCPT TO acceptance without sending data.
2. Candidate email guesses are visible in the contact worksheet with evidence tiers and source URLs. The user reviews them in the same workflow — approval creates the persistent `contact_points` row. For personal use, the user is the sole reviewer.
3. Support CSV import and CLI-only manual relationship edges in the first implementation; defer YAML import.
4. Provide general cold-email warnings and opt-out placeholders, not jurisdiction-specific legal templates.
5. Use indefinite, hard default suppression for user-suppressed people/emails, company domains, and recruiter/company pairs until the user removes or expires the suppression.
6. Keep outreach follow-up drafting separate from scheduling so JobOS remains a draft/task system, not sequence automation.
7. Public company pages are fetched directly with `fetch()` + cheerio — standard crawling, not browser automation.
8. Public LinkedIn profile URLs from search results are recorded as `profile_url` contact points (Tier E). The LinkedIn page is never fetched by JobOS.
9. Contact discovery is the primary product goal. The implementation order front-loads page fetching, email extraction, and pattern inference.
