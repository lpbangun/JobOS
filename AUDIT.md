# Audit: Can These Docs Produce a Working Contact-Finding Tool?

Audited: 2026-07-09
Auditor: Hermes Agent (GLM-5.2)
Eval status: `run_eval_research.js` passes — 33/33 hard assertions, all 12 scoring axes at 10/10, `ok: true`

## Executive Verdict

**The docs describe a system that can absolutely be built into a powerful contact-finding and outreach tool for personal use.** The architecture is well-reasoned, the evidence/confidence model is sound, and the existing codebase already proves the core pipeline works. However, the docs are **over-constrained on the exact thing you want most: finding actual contact details for real people.** The ethics layer (which you've asked to override for personal use) is the primary blocker between "this works on fixture data" and "this finds real contacts at real companies."

This audit identifies what to keep, what to override, and what concrete open-source approaches to bolt on.

---

## Part 1: What the Docs Get Right (Keep These)

### 1. Evidence Tiers A–E
The tiered confidence model (`architecture.md:188-220`, `research.md:78-88`) is the single most valuable design decision. It's honest, actionable, and maps directly to outreach decisions:
- Tier A (exact public email on company page) → draft with high confidence
- Tier C (pattern + source-backed person) → draft as hypothesis
- Tier D (pattern guess + DNS only) → prefer LinkedIn/manual channel

**Keep this.** Even with ethics overrides, tiered confidence prevents you from sending garbage to wrong people.

### 2. Source Observation Ledger
The `source_observations` table design (`architecture.md:93-111`) is correct — every fact traces to a URL, query, provider, and timestamp. This is what separates a research tool from a guessing engine. The existing code already does a lightweight version (`research.js:119-129` dedupes by canonical URL).

### 3. Query Packs
`research.md:92-101` defines targeted search query packs for company emails, People Ops, hiring managers, and public profile URLs. These are **immediately usable** — they work with DuckDuckGo today, no API keys needed. The existing `companyResearchQueries()` (`research.js:91-99`) already runs 5 company-focused queries, but it's missing the person/contact-focused query packs from the research doc.

### 4. Human-Gated Outreach Lifecycle
The existing outreach pipeline (`outreach.js`) is fully working: draft → human review → mark-sent → follow-up scheduling. The eval proves it produces specific, personalized, evidence-grounded drafts. This is your outreach tool's backbone — it just needs better contact data feeding into it.

### 5. ATS Adapters
Greenhouse and Lever adapters (`discovery/adapters.js`) are working and tested. These give you free job discovery and company board handles, which feed company identity resolution.

---

## Part 2: What's Over-Constrained (Override for Personal Use)

### Blocker 1: No Email Extraction from Pages
**Current state:** `research.js` parses search *snippets* only. It never fetches full page content to extract `mailto:` links or emails from team/about/press pages. The architecture proposes a Source Collector with page fetching (`architecture.md:75-76`), but it's not implemented.

**Impact:** You miss every email that exists on a company page but isn't in a search snippet. This is the #1 gap.

**Override:** The ethics docs say "no browser automation" and "respect robots.txt." For personal use, fetching public web pages with `fetch()` + cheerio (already a dependency) is standard crawling, not "browser automation." The search engine already indexes these pages — you're just reading them directly.

**Action:** Implement `src/research/sources.js` with a `fetchPage()` adapter that:
1. Fetches company homepage, /team, /about, /press, /contact pages
2. Extracts `mailto:` anchors and plain-text emails via regex
3. Extracts person names + titles from team page patterns
4. Stores everything as source observations with the page URL as evidence

### Blocker 2: No Email Pattern Inference
**Current state:** Not implemented. The docs (`research.md:124-134`) describe it but mark it as worksheet-only until user approval.

**Impact:** You can't generate candidate emails for known people at a company. This is the "Hunter.io" core feature.

**Override:** For personal use, pattern inference from public emails is not a privacy violation — it's deduction from public data. If `jane.doe@company.com` and `john.smith@company.com` appear on a company's public team page, generating `maya.chen@company.com` for a source-backed person is reasonable.

**Action:** Implement pattern detection in a new `src/research/contacts.js`:
1. Collect all exact public emails for a domain (from page fetches + search snippets)
2. Detect patterns: `first@`, `first.last@`, `flast@`, `firstl@`, `first_last@`
3. Score by support count (2+ examples = stronger)
4. Generate candidates for source-backed people only
5. Label as `pattern_candidate` (Tier C) — never "verified"

**Open-source reference:** `apifyforge/email-pattern-finder` on GitHub does exactly this. The logic is simple enough to implement natively in Node.js without a dependency.

### Blocker 3: No DNS/MX Verification
**Current state:** Not implemented. The docs (`architecture.md:196-198`, `research.md:138-145`) describe DNS/MX checks but mark them as future work.

**Impact:** You can't distinguish `company.com` (has mail, pattern likely valid) from `company.io` (no MX, email won't work).

**Action:** Use Node.js `dns` module (built-in, zero dependencies):
1. `dns.resolveMx(domain)` — MX record presence
2. `dns.resolveTxt(domain)` — SPF/DMARC records
3. `dns.resolveNs(domain)` — nameserver validity
4. Disposable domain check against a static blocklist

**Open-source reference:** `@devmehq/email-validator-js` on npm does this in JS. Or just use `dns.promises` directly — it's 20 lines of code.

### Blocker 4: LinkedIn Source Filtering
**Current state:** `research.js:101-108` actively **blocks** LinkedIn, Facebook, Instagram, X/Twitter URLs from results. The `sourceAllowed()` function filters them out entirely.

**Impact:** You lose LinkedIn profile URLs that appear in public search results — the single richest source of person/company affiliation data available without logging in.

**Override:** For personal use, recording a *public LinkedIn profile URL* found via search results is not "scraping LinkedIn." You're not fetching the page or logging in — you're recording a URL that DuckDuckGo already indexed. The docs even acknowledge this (`research.md:98`): "These are for locating public profile URLs/snippets only."

**Action:** 
1. Modify `sourceAllowed()` to allow `linkedin.com/in/` URLs (but still don't fetch them)
2. Record LinkedIn profile URLs as `profile_url` contact points (Tier E)
3. Generate "Manual LinkedIn assist" — copy-ready notes for the user to search/copy/send outside JobOS
4. Keep the hard gate: no fetching LinkedIn pages, no automated actions

### Blocker 5: No Person Candidate Staging
**Current state:** `research.js` extracts people from search titles (`personFromResult()`, lines 339-353) and directly upserts them into `stakeholders`. There's no `person_candidates` table, no review-before-promote flow.

**Impact:** You get false positives promoted directly to stakeholders. The existing eval works because the fake LLM filters perfectly, but real search results are noisier.

**Action:** Add `person_candidates` table as described in `architecture.md:164-180`. Route all extracted people through it first. Add `research promote-stakeholder --candidate <id>` command.

### Blocker 6: No Network Graph / Relationship Mapping
**Current state:** Not implemented. No `relationship_edges` table, no CSV import, no path ranking.

**Impact:** You can't identify warm paths (shared employer, shared school, shared investor) that would make cold outreach warmer.

**Action:** This is lower priority for "finding contacts" but high value for "outreach effectiveness." Implement after contact discovery is working. Start with CSV import of your own network data (past colleagues, schools, communities).

---

## Part 3: What's Missing from Both Docs (Add These)

### Gap 1: GitHub as a People Source
The docs mention GitHub (`research.md:99`, `architecture.md:79`) but only for "technical companies." For EdTech/WorkTech companies (your target sector), many teams have public GitHub orgs with member lists. GitHub's public API (`/orgs/{org}/members`) returns public member profiles — no auth needed for small orgs, rate-limited but usable.

**Action:** Add a GitHub adapter to the source collector:
1. Search: `site:github.com "{company}" org` via DuckDuckGo
2. If org found: `GET https://api.github.com/orgs/{org}/members` (unauthenticated, 60 req/hr)
3. For each member: name, profile URL, bio — all public
4. Cross-reference with company team pages for affiliation confirmation

### Gap 2: Common Crawl / Wayback for Email Discovery
The docs mention Common Crawl (`research.md:38`) but never use it operationally. The Wayback Machine CDX API (`https://web.archive.org/cdx/search/cdx`) can find archived versions of company team pages that may have since been removed — a goldmine for email patterns from companies that hide their team page.

**Action:** Add a Wayback adapter:
1. `GET https://web.archive.org/cdx/search/cdx?url=company.com/team*&output=json`
2. Fetch archived team page snapshots
3. Extract emails from archived HTML
4. Label as Tier B (credible public third-party page, potentially stale)

### Gap 3: GDELT for Company News/Events
GDELT DOC API (`https://api.gdeltproject.org/api/v2/doc/doc`) is free, no key required, and indexes global news. It can find:
- Company funding announcements (often quote founders/execs with names)
- Conference speaker mentions (name + title + company)
- Product launch press (names of product leaders)

**Action:** Add GDELT as a source adapter in the query pack for company research. Query: `company="Acme Learning"&format=json`

### Gap 4: Exa/Tavily for People Search
The docs discuss these as optional (`research.md:104-121`) but position them behind "disabled by default." For a personal-use tool where you want maximum contact coverage, these are **the highest-leverage paid additions**:

- **Exa** has a `people` search category that directly finds person pages. Their API returns highlighted snippets with source URLs — perfect for the source observation ledger.
- **Tavily** has `extract` and `crawl` endpoints that can pull full page content from company team pages (solving Blocker 1 without writing your own crawler).

**Action:** Add Exa and Tavily as optional search providers in `src/search.js`:
1. `JOBOS_SEARCH_PROVIDER=exa` + `EXA_API_KEY` env var
2. `JOBOS_SEARCH_PROVIDER=tavily` + `TAVILY_API_KEY` env var
3. Both feed into the existing `searchWebDetailed()` provider chain
4. Run the contact-focused query packs through them

You already have Nous subscription with Firecrawl — that's another option for page extraction.

### Gap 5: SMTP Mailbox Probing
The docs include this as "advanced opt-in, disabled by default" (`architecture.md:240`, `research.md:142`). For personal use, this is the difference between "I think this email works" and "this email accepts mail."

**Action:** Implement behind `JOBOS_SMTP_PROBE=true` env flag:
1. `net.connect(25, mxServer)` to the domain's MX host
2. SMTP `HELO`, `MAIL FROM:<test@jobos.local>`, `RCPT TO:<candidate@company.com>`
3. Check response: `250` = accepted, `550` = rejected, `421` = deferral
4. Labels: `smtp_accepts_rcpt`, `smtp_rejects_rcpt`, `smtp_inconclusive`
5. Strict rate limit: 1 probe per domain per 30 seconds
6. Never send actual DATA — quit after RCPT TO check

**Open-source reference:** `AfterShip/email-verifier` (Go) shows the pattern. In Node.js, `net.connect` + basic SMTP commands is ~50 lines.

---

## Part 4: Eval Assessment

### Current Eval (What It Tests)
The existing `run_eval_research.js` is excellent for what it covers:
- 3 company fixtures with valid/distractor URLs
- Company dossier groundedness, source diversity, distractor rejection
- Stakeholder precision/recall with false-name detection
- Outreach specificity, personalization, ask clarity, length, tone
- Hard assertions: human gate present, draft status, no-send, audit trail
- No-LLM fallback path tested independently
- All local fake servers — no real network calls

**Result: 33/33 hard assertions pass, all axes 10/10.**

### What the Eval Does NOT Test (Critical Gaps)
The eval has zero coverage for the contact discovery features that matter most:

1. **No email extraction test** — no fixture with `mailto:` links or plain-text emails
2. **No pattern inference test** — no fixture with multiple emails at the same domain
3. **No DNS/MX verification test** — no fake DNS resolver
4. **No contact point storage test** — no `contact_points` table exists yet
5. **No person candidate staging test** — no `person_candidates` table exists yet
6. **No LinkedIn URL recording test** — LinkedIn is blocked entirely
7. **No network graph test** — no `relationship_edges` table exists yet
8. **No outreach planner test** — no `outreach_plans` table or path ranking

### Eval Expansion Plan (Before Implementing)
Per the architecture's own test strategy (`architecture.md:467-489`), add these eval cases:

1. **Fake team page with emails**: fixture returns HTML with `mailto:jane@company.com` and `mailto:john.smith@company.com` → email extractor finds both → pattern detector infers `first@` and `first.last@` → candidate generator creates `maya.chen@company.com` for a source-backed person
2. **Fake DNS resolver**: injectable fake that returns MX/no-MX/catch-all → verification labels match
3. **Fake SMTP resolver**: injectable fake that returns accept/reject/unknown → labels match, no real connection
4. **LinkedIn URL in search results**: fixture includes `linkedin.com/in/maya-chen` → source recorded as profile_url → page NOT fetched → LinkedIn domain not blocked at source-recording level
5. **Person candidate staging**: 5 candidates, 2 false positives → staging table holds all → promote only valid ones → stakeholders table gets only approved
6. **LLM unsupported email claim**: fake LLM returns `maya.chen@company.com` as "verified" without source → JobOS drops it and labels as unverified

---

## Part 5: Implementation Priority (What to Build First)

Based on "finding contacts" as the primary goal:

### Phase 1: Contact Discovery Core (Highest Impact)
1. **Page fetcher + email extractor** — fetch company /team, /about, /press pages, extract `mailto:` and plain-text emails. ~150 lines in `src/research/sources.js`.
2. **Email pattern inference** — detect `first@`, `first.last@`, etc. from observed emails. ~80 lines in `src/research/contacts.js`.
3. **DNS/MX verification** — `dns.promises` module, ~40 lines. Add to contacts.js.
4. **`contact_points` + `email_patterns` tables** — schema migration in `db.js`.
5. **`research contacts --job <id> --json` command** — CLI wiring in `cli.js`.
6. **Contact worksheet** — Markdown output with evidence tiers, source URLs, warnings.
7. **Eval expansion** — fake team pages with emails, fake DNS, pattern inference assertions.

### Phase 2: Person Discovery Improvement
8. **Person candidate staging** — `person_candidates` table, promote workflow.
9. **Allow LinkedIn URLs in source recording** — modify `sourceAllowed()`.
10. **Contact-focused query packs** — add the person/recruiter/hiring-manager queries from `research.md:92-101` to the stakeholder research flow.
11. **GitHub org adapter** — public member discovery for technical companies.

### Phase 3: Outreach Intelligence
12. **Outreach planner** — `outreach_plans` table, path ranking, `outreach plan` command.
13. **Network graph import** — CSV import, `relationship_edges` table.
14. **Suppression lists** — per-person, per-domain, per-recruiter/company-pair.
15. **Optional Exa/Tavily providers** — for better search coverage.

### Phase 4: Verification Depth
16. **SMTP probing** — behind explicit flag, rate-limited, audited.
17. **Wayback Machine adapter** — archived team pages for email discovery.
18. **GDELT adapter** — news/event signals for company research.

---

## Part 6: Concrete Open-Source Tools to Study/Adapt

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

---

## Part 7: Ethics Override Summary

You asked to override the ethics space for personal use. Here's what changes:

| Original constraint | Override for personal use | Rationale |
|---|---|---|
| No page fetching beyond search snippets | Fetch public company pages directly | Reading public web pages is not scraping |
| LinkedIn URLs blocked entirely | Record public LinkedIn profile URLs from search results | URL recording ≠ scraping; don't fetch the page |
| Guessed emails worksheet-only until approval | Guessed emails visible in contact worksheet, approval still required for outreach draft | Personal use = you review everything yourself |
| SMTP probing disabled by default | Available behind `JOBOS_SMTP_PROBE=true` flag | RCPT TO check without sending is standard verification |
| No browser automation | Still no browser automation | Not needed — `fetch()` + cheerio covers page fetching |
| No private-account access | Still no private-account access | This isn't an ethics constraint, it's a technical boundary |
| No leaked/breached data | Still no leaked/breached data | Using breach data is illegal, not just unethical |

**What stays hard-gated regardless of override:**
- JobOS never sends email, LinkedIn messages, or connection requests
- JobOS never submits applications
- JobOS never uses fake accounts or proxies
- JobOS never bypasses captchas or rate limits
- JobOS never accesses leaked/breached datasets

These aren't ethics — they're the difference between a research tool and a spam/abuse tool. A tool that sends email automatically is a different product with different legal exposure.

---

## Part 8: Architecture Doc Quality Scores (Using the Doc's Own Rubric)

### Research Quality: 4.7/5 → **Actual: 4.2/5**
The docs name concrete sources and cite official docs, but they over-index on what *not* to do and under-index on *how* to actually extract contacts. The source coverage is excellent on paper but the implementation guidance for email extraction, pattern inference, and DNS verification is described at architecture altitude, not code level. The "What Paid Tools Actually Bundle" table (`research.md:44-56`) is the most useful section — it maps each paid-tool capability to a free reconstruction.

### Functionality and Integration: 4.6/5 → **Actual: 3.5/5**
The docs propose 5 new tables (`source_observations`, `person_candidates`, `contact_points`, `email_patterns`, `relationship_edges`) and 7 new CLI commands. None are implemented. The existing codebase has the outreach lifecycle working end-to-end, but the contact discovery layer — the thing you want most — is 0% implemented. The implementation order (`architecture.md:456-465`) is correct but starts with "schema and source ledger" rather than "contact extraction," which delays the highest-value feature.

### Creative and UX Design: 4.5/5 → **Actual: 4.0/5**
The evidence tier UX (A–E labels), contact path ladder, and "email pattern lab" concept are genuinely creative reconstructions of paid-tool workflows. The "Manual LinkedIn assist" idea is practical. But the docs don't address how contact discovery results surface in the dashboard or CLI workflow — the user experience of *reviewing and acting on contacts* is underspecified.

### Testability: 4.4/5 → **Actual: 3.8/5**
The eval harness for existing features is excellent (33/33 hard assertions, deterministic fixtures). But the eval has zero coverage for the new contact discovery features. The test strategy section (`architecture.md:467-489`) is thorough on paper but none of the proposed test cases (email extraction, pattern inference, DNS/MX, SMTP, LinkedIn URL recording) exist yet.

---

## Bottom Line

**The docs are good enough to build from.** The architecture is sound, the existing code proves the pipeline works, and the eval harness is a solid foundation. The main problem is that the docs spend more energy on what not to do than on how to actually find contacts, and the implementation hasn't started on the contact discovery layer.

**Immediate next steps:**
1. Implement page fetching + email extraction (Phase 1, item 1) — this alone will find more contacts than everything else combined
2. Add email pattern inference + DNS/MX checks (Phase 1, items 2-3)
3. Expand the eval with fake team pages containing emails (Phase 1, item 7)
4. Allow LinkedIn URL recording from search results (Phase 2, item 9)
5. Add Exa or Tavily as an optional provider for better people-search coverage (Phase 3, item 15)

The system you want is 80% designed and 20% implemented for contact discovery. The outreach side is 90% implemented. The gap is bridgeable in a focused implementation sprint.