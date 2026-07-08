# Pluggable Job Researcher — feasibility research

_Date: 2026-07-04. Companion eval: `job-researcher-eval.md`. Verdict tracked there; research iterates until every criterion ≥ 8/10._

## Goal

A **job researcher/checker module** that:
1. Parses ATS platforms (Ashby, Greenhouse, Lever, Workday, …) — keywords, key requirements, and the actual application questions/fields.
2. Treats LinkedIn as a parseable source — jobs, company info, people data.
3. Turns any webpage/company job posting into structured data.
4. Is **pluggable**: integrates into the JobOS CLI/workspace, and its fundamentals stand alone as an independent library/CLI.

## First-hand verified findings (probed live 2026-07-04, no auth, plain curl)

| Surface | Endpoint | Verified result |
|---|---|---|
| Ashby job board | `GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | Full postings JSON incl. comp, location, remote/workplace type |
| Ashby application form | `POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` — `jobPosting { applicationForm }` | Field exists (`FormRender` type); needs subfield selection |
| Greenhouse board | `GET boards-api.greenhouse.io/v1/boards/{org}/jobs?content=true` | Full postings JSON w/ descriptions |
| Greenhouse questions | `GET .../jobs/{id}?questions=true` | **Full application form**: 17 questions for a Stripe role, each with label, required flag, field types |
| Lever board | `GET api.lever.co/v0/postings/{org}?mode=json` | Full postings incl. salary text |
| Workday | `POST {tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | JSON search (2,000 postings @ NVIDIA); per-job detail at `/wday/cxs/.../job/{path}` |
| LinkedIn guest jobs | `GET linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=…&location=…` | Returns job-card HTML (title, company, `urn:li:jobPosting:{id}`) without login |

Implication: **the core of criterion 1 is not scraping at all — it's calling stable public JSON APIs.** The module's ATS adapters can be thin, deterministic, and reliable.

## Current JobOS integration points

- `src/cli.js` `importUrl()` currently does naive fetch + tag-strip. The researcher module replaces this: URL → ATS detection → adapter → normalized `Job` (title, company, location, description, requirements_json, compensation, **questions_json**).
- Workspace files (`jobs/job_x/job.yaml`, `description.md`) and the `jobs` SQLite table already exist; adding `questions_json` + `ats_vendor` columns is the only schema change needed.
- Standalone shape: `@jobos/researcher` package with its own CLI (`job-researcher fetch <url> --json`), zero JobOS imports; JobOS calls it as a library.

## Agent research reports

### Report B — LinkedIn as a parseable source (criterion 2)

**Recommended layered strategy, safest → riskiest:**
1. **Guest job-search endpoints + JSON-LD** (no login) — primary jobs source. `linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=` returns paginated job-card HTML; individual `/jobs/view/{id}` pages carry a `<script type="application/ld+json">` JobPosting block (title, hiringOrganization, jobLocation, datePosted, description, employmentType, baseSalary). This is the Googlebot surface — most resilient, lowest risk. Throttles ~page 10 from one IP; fine for one person's periodic search.
2. **User's own logged-in browser via Playwright MCP `--extension` / CDP attach** (`--cdp-endpoint=http://localhost:9222`) — for gated company/people data. Reuses the real session cookies and fingerprint; fingerprint-identical to manual browsing since it *is* the user's browser. Invoke on-demand ("enrich this profile/company"), never background polling.
3. **GDPR "Download your data" archive** — zero-risk bulk backfill of the user's own connections/messages/applications as CSVs; refresh monthly.
4. **Avoid**: Voyager-API libs (tomquirk/linkedin-api, StaffSpy) run headless/at volume, and any paid resale API.

**OSS libraries:** tomquirk/linkedin-api (Python, Voyager, fork-proliferation = maintenance churn, self-declared ToS-violating); StaffSpy (staff rosters, ban risk); joeyism/linkedin_scraper (Apache-2.0, Playwright mode; spawned `patchright` stealth fork = plain Playwright getting detected). Best-fit for us is the **companion-extension / CDP-attach-to-live-tab** pattern — DOM read during genuine human sessions, effectively undetectable because there's no separate automation.

**Account-risk reality:** hiQ v. LinkedIn — scraping *public* data isn't a CFAA crime, but ToS breach + account termination remain live remedies LinkedIn uses aggressively. Proxycurl sued Jan 2025 → shut down July 2025 (clear signal: commercial-scale Voyager scraping gets litigated to death). Detection = request rate, TLS/header fingerprint, datacenter-IP reputation, no-dwell behavioral signals. Reported (unofficial) ceilings ~150 actions/day, ~50 direct-URL profile visits/day; direct-URL hopping flagged fastest. Mitigations: real user session, human-paced/on-demand, no headless, organic interleaving, cap volume far below thresholds (single-user needs are tiny).

**Node integration:** discovery via guest endpoint → fetch `/jobs/view/{id}` → parse JSON-LD → normalize into JobOS job model, jittered delays; company/people via on-demand Playwright-attach to user's open Chrome; GDPR ZIP importer for own network. Keep everything single-user/personal-use.

### Report C — Universal page parsing (criterion 3)

**Recommended ordered fallback pipeline** (cheap → expensive, only fall through on failure, cache raw HTML/markdown):
1. **JSON-LD `JobPosting`** — schema.org type Google-for-Jobs requires; `<script type="application/ld+json">` in head. Broad but not universal adoption (Google indexes 100K–1M domains). Parse by direct `JSON.parse` of the script (most are flat) or `jsonld` lib; fall back to OpenGraph/microdata.
2. **ATS API detection** — URL pattern / careers-page iframe sniff → hit the public ATS JSON directly (Greenhouse/Lever/Ashby/Workable). Workday/Taleo/iCIMS are SPA-hard: intercept their internal XHR JSON via Playwright network tab.
3. **Static fetch + Readability** — `@mozilla/readability` + `jsdom` (Apache-2.0, native Node, F1 ~0.91–0.95, most consistent) as primary; `@extractus/article-extractor` (MIT) wrapper adds OG meta. Trafilatura (Python, Apache-2.0) wins raw F1 (~0.94–0.96) but needs a sidecar — skip unless quality demands. Use `isProbablyReaderable()` to short-circuit empty JS shells.
4. **Headless render** — Playwright only when static body is near-empty/SPA shell. Prefer waiting on a specific selector over `networkidle`; better still, intercept the page's own XHR/fetch to grab underlying JSON (the right way to handle Workday-class pages).
5. **LLM structured extraction** — feed cleaned markdown (not raw HTML) to a **small/cheap model** with a strict JSON schema (Zod). This stage is reformatting, not comprehension — keep it cheap. Low-confidence flag when title/company missing from source.
6. **Manual paste fallback** (UI) — for Cloudflare-walled SPAs.

**Markdown services:** Jina Reader `r.jina.ai` (free ~100 RPM, hosted 3rd-party — privacy flag), Firecrawl (AGPL core, self-host loses anti-bot Fire-engine), crawl4ai (Apache-2.0, Python, best license/self-host story), markdowner (MIT-ish, Cloudflare). For local-first JobOS: **do extraction locally** (Playwright + Readability), Jina as optional fallback only.

**Anti-bot reality:** `puppeteer-extra-stealth` is stale/ineffective vs modern Cloudflare; Camoufox (patched Firefox) is the credible OSS option but heavy. For single-user low-volume research, use plain Playwright + realistic UA + self rate-limiting, accept a small failure fraction → manual-paste fallback. Stay light-touch/lawful.

**Careers-page crawling:** check `/sitemap.xml` for a jobs sitemap; detect `/careers` embedding an ATS iframe → jump to ATS API; else shallow same-origin depth-limited crawl applying stages 1–4 per detail page.

### Report A — ATS / job-board parsing (criterion 1)

**Application-question availability by ATS (this is the hard part):**
| ATS | Postings | Application questions | Endpoint |
|---|---|---|---|
| Greenhouse | ✅ `boards-api.greenhouse.io/v1/boards/{org}/jobs?content=true` | ✅ **full** — `?questions=true` returns `questions[]`, `location_questions[]`, `compliance[]`, `demographic_questions` (verified: 17 fields on a Stripe role) | public, no auth |
| Ashby | ✅ `api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | ✅ **full, no key** — via undocumented `POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting`, `jobPosting.applicationForm.sections[].fieldEntries[].{field,isRequired}` (verified firsthand: pulled OpenAI form fields + required flags). *Correction to the documented path — the Developer API key is only needed for the officially-supported `jobPosting.info`; the widget GraphQL endpoint is unauthenticated.* |
| Lever | ✅ `api.lever.co/v0/postings/{org}?mode=json` | ❌ not exposed (docs confirm) |
| Workday | ✅ `POST {tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` (verified: 2,000 NVIDIA postings) | ❌ no stable endpoint; behind authed apply flow; Akamai bot mgmt |
| SmartRecruiters | ✅ `api.smartrecruiters.com/v1/companies/{org}/postings` | ⚠️ unconfirmed |

**OSS inventory (license-checked):** JobSpy (speedyapply/JobSpy, MIT, active, 3.7k★ — LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter, postings only); adgramigna/job-board-scraper (MIT — Greenhouse/Lever/Ashby/Rippling); d-alleyne/ashby-job-scraper (MIT); Resume-Matcher (Apache-2.0 — JD↔resume keyword/embedding matching). **Avoid** jobspy-mcp-server (no license). *Key finding: no surveyed scraper extracts application questions — the ATS-native APIs are the only reliable source, which is exactly what makes this module worth building.*

**ATS detection:** pure hostname regex (first-match-wins, no I/O): `boards.greenhouse.io|job-boards.greenhouse.io|{org}.greenhouse.io`, `jobs.lever.co|jobs.eu.lever.co`, `jobs.ashbyhq.com`, `{tenant}.wd{1-12}.myworkdayjobs.com`, `jobs.smartrecruiters.com`, `ats.rippling.com`. Fallback for custom domains proxying an ATS: sniff page source for embed script tags.

**Keyword/requirement extraction:** hybrid — deterministic regex/skills-taxonomy + spaCy PhraseMatcher / TF-IDF first (free, offline), fall back to a **small local LLM** only on low-confidence JDs; always use a classifier/LLM to structure freeform application questions (open-text vs dropdown vs yes/no) since those are too varied for regex.

**Adapter architecture:**
```ts
interface AtsAdapter {
  name: string;
  detect(url): boolean;                 // pure regex, no I/O
  parseUrl(url): { org, jobId? } | null;
  fetchPosting(org, jobId): Promise<NormalizedPosting>;
  fetchQuestions(org, jobId): Promise<{ supported: boolean; questions: NormalizedQuestion[] }>;
}
```
`fetchQuestions` split from `fetchPosting` because coverage is uneven — adapters lacking a form schema return `supported:false` explicitly (never silently omit). Shared HTTP client owns rate-limit/backoff (Lever 429s, Workday Akamai). Optional Playwright DOM fallback for Lever/Workday forms, user-consent gated.

---

## Architecture: pluggable + standalone (criterion 4)

**Standalone package `@jobos/researcher`** — zero JobOS imports, own CLI + library:
```
job-researcher fetch <url> --json          # ATS-detect → adapter → NormalizedPosting(+questions)
job-researcher parse <url> --json          # universal pipeline (JSON-LD→readability→headless→LLM)
job-researcher linkedin jobs "<query>" --location <loc> --json
job-researcher careers <company-domain> --json   # crawl/discover postings
```
Internal shape:
```
@jobos/researcher/
  detect.js            # hostname → vendor
  ats/{greenhouse,ashby,lever,workday,smartrecruiters}.js
  universal/{jsonld,readability,headless,llm}.js
  linkedin/{guest,jsonld,browser-attach}.js
  normalize.js         # NormalizedPosting / NormalizedQuestion (single downstream contract)
  index.js  cli.js
```
Only hard dependency for the safe core: `node:fetch` + `@mozilla/readability`+`jsdom`. Playwright and LLM are **optional peer deps** — the deterministic core (ATS APIs, JSON-LD, guest LinkedIn) runs with zero heavy deps and no API keys, matching JobOS's local-first/key-free constraint.

**JobOS integration:** replace `src/cli.js` `importUrl()`'s naive tag-strip with a call to `researcher.fetch(url)`. Schema: add `ats_vendor TEXT` and `questions_json TEXT` columns to `jobs`; write `questions.md` into `jobs/{id}/` workspace dir. New CLI verbs map onto existing patterns: `jobos jobs import-url` (upgraded), `jobos jobs questions <job-id>`, `jobos research linkedin-jobs`. MCP tools `import_job_url`/`enrich_job` from the design doc wrap the same library. Human-gate + evidence rules already in JobOS apply unchanged (researcher only reads/normalizes; never submits).

**Model-cost policy (per user instruction):** deterministic parsing = no model. Freeform question classification + low-confidence JD structuring = **small model (Sonnet/Haiku-class)**. Reserve larger models for downstream dossier synthesis, not parsing. Extraction always feeds cleaned markdown (not raw HTML) to minimize tokens.




---

# Revision (2026-07-08): grounding against the current codebase

Everything above was written before auditing the shipped MVP. This section revises the plan against what `src/cli.js` (142 lines, single-file, `sql.js`-backed) actually implements, and focuses on the two functions the user called out: **research** and **outreach**.

## Current-state analysis (what exists today)

| Area | Function / location | What it actually does | Gap vs. our findings |
|---|---|---|---|
| URL import | `importUrl()` cli.js:66 | `fetch` → regex tag-strip → first 12k chars; **hardcodes `Company: Unknown company`**; source tagged `url` | No ATS detection, no JSON-LD, no questions, no real company/comp/location extraction |
| Requirement extraction | `reqs()` cli.js:61 | line-filter on keywords (`require|must|you will…`), first 12 | Crude but serviceable; no skills taxonomy, no structured requirement objects |
| Company research | `research(s,jid,'company')` cli.js:78 | Writes a **static `company-dossier.md` template** with the company name echoed back. No fetch, no data. | `companies` table exists (schema line 32) but only ever holds a bare name from `ensureCompany()`. Dossier fields (website, stage, funding, news, risk flags) are all placeholder bullets. |
| Stakeholder research | `research(s,jid,'stakeholders')` cli.js:78 | Writes a **static `stakeholders.md` template**. Explicitly "No people were inferred." | `stakeholders` table exists (schema line 34) but **is never INSERTed anywhere in the codebase**. Fully dead. |
| Outreach | — | **Does not exist.** Dashboard Outreach tab (cli.js:103) is a hardcoded placeholder + dead "Review & Send" button. | No `outreach_threads` table, no `draft_outreach`, no follow-up scheduling. The design doc's `OutreachThread` / `Offer` canonical entities are unbuilt. |
| Automation | `weekly()` cli.js:79 | Real internal summary run; `daily-discovery` is design-only JSON | No discovery, no company-watch, no follow-up-watch |

**Bottom line:** research is a worksheet generator, not a researcher; outreach is a UI stub. Both are the natural landing zone for the `@jobos/researcher` library — research consumes it directly, outreach is built on top of the stakeholder data research produces.

## Making **research** better (and the wiring)

The researcher library turns the two static templates into data-backed dossiers. Ordered by leverage:

**1. Upgrade `importUrl` first — it feeds everything.** Replace the tag-strip body (cli.js:66) with `researcher.fetch(url)` (ATS-detect → adapter → JSON-LD → readability fallback). This alone fixes `company`, `location`, `compensation`, structured `requirements`, and adds **`questions_json`** — none of which import populates today.
- *Schema wiring:* `ALTER`-add `ats_vendor TEXT`, `questions_json TEXT DEFAULT '[]'`, `comp_json TEXT` to `jobs` (schema line 33). `sql.js` has no migrations, so gate with `PRAGMA table_info` add-if-missing in `open()` (cli.js:41).
- *Workspace wiring:* `syncJob()` (cli.js:64) writes a new `jobs/{id}/questions.md` when `questions_json` is non-empty — this is the answer-bank seed the design doc's module 4 wants.

**2. Make `research company` fetch real data.** Signature stays `research(s,jid,'company')`; body calls `researcher.company(job.url || companyDomain)`:
- ATS adapter already yields org/company + careers URL; JSON-LD `hiringOrganization` yields website/name; LinkedIn **guest** company page + JSON-LD yields industry/size/about (safe, no-auth path from Report B).
- Populate the real `companies` row (add columns: `industry, stage, size, funding, about, risk_flags_json, sources_json`) instead of the name-only stub from `ensureCompany()` (cli.js:63).
- Keep the **evidence-grounding rule**: every dossier field carries a `source` URL; unknown fields stay explicitly "unknown," never fabricated. This matches the existing honesty posture of the worksheet.
- *Red-flag detection* reuses the existing `redFlags` list (cli.js:12) plus dossier signals (layoff/ghost-job language) → writes into `companies.risk_flags_json`, surfaced in the score's `redFlags` dimension (cli.js:69).

**3. Make `research stakeholders` populate the dead table.** Call `researcher.linkedin.people({company, role})` via the on-demand browser-attach path (Report B tier 2) — but default to the **safe, no-auth** surface: LinkedIn guest + JSON-LD + public company "people" hints, and let the user paste/confirm. Each candidate becomes a real `stakeholders` row (`name, role, links_json, summary, outreach_status='not_contacted'`, plus a new `relevance TEXT` + `source TEXT`). This is the data outreach needs to exist at all.
- *Human gate preserved:* stakeholders are recorded, never contacted; `relevance` must be non-empty before any outreach draft (enforced in step below).

**4. Model-cost discipline (per instruction).** Steps 1–3 are deterministic/no-model. Only two spots earn a **small model (Haiku/Sonnet-class)**: classifying freeform application questions into types, and synthesizing the dossier prose from fetched fields. Larger models are never used in the parse path.

## Making **outreach** better (and the wiring)

Outreach doesn't exist, so this is greenfield but small — it rides entirely on the stakeholder rows research now produces.

**1. Add the canonical `OutreachThread` entity** the design doc already references (`--thread thread_789`, `log_outreach_event`):
```sql
CREATE TABLE outreach_threads (id TEXT PRIMARY KEY, stakeholder_id TEXT NOT NULL,
  job_id TEXT, channel TEXT NOT NULL DEFAULT 'email', goal TEXT NOT NULL DEFAULT 'informational',
  status TEXT NOT NULL DEFAULT 'draft', relevance TEXT NOT NULL DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]', next_followup_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

**2. `draft_outreach` function** — mirrors `tailor()` (cli.js:73) exactly: evidence-grounded, `draft_needs_human_review`, warnings when relevance/proof is thin, writes `jobs/{id}/outreach/{thread}.yaml`, logs an artifact + audit row. Personalization pulls from the stakeholder's `summary`/`links` (research output) and the profile's proof points — **no fabricated personalization**, matching the tailoring anti-fabrication rule.
- *Hard gate:* refuse to draft if `stakeholder.relevance` is empty → forces the research step first. This encodes the design doc's "draft outreach only after stakeholder relevance is established."

**3. Follow-up scheduling reuses the existing `tasks` table** (cli.js:37) — no new machinery. `outreach schedule-followup --thread T --after 5d` inserts a `type='follow-up'` task with `due_at`; `weekly()` (cli.js:79) already surfaces due tasks. Add a pause rule: if the linked application status flips to interview/offer/rejected (`appUpdate` cli.js:76), cancel open follow-up tasks for that job.

**4. Anti-spam constraints from the design doc** as cheap deterministic checks: daily/weekly draft caps (count `outreach_threads` created per day), a do-not-contact list (new `suppressions` table or a flag), and `status` stays `draft`/`staged` — **never `sent`**; JobOS records a human-confirmed send via `outreach mark-sent`, exactly like `applications update` records real confirmations (cli.js:76). No connector sends mail.

**5. Dashboard wiring:** replace the placeholder Outreach section (cli.js:103) with a thread list rendered from `state()` (cli.js:80 — add `outreach` to the snapshot), each thread showing stakeholder, goal, relevance, next follow-up, and a gated "Review & Mark Sent" that opens the existing gate modal (cli.js:114).

## CLI surface added (maps onto existing patterns)

```bash
jobos jobs import-url <url> --profile <p>          # upgraded: real fields + questions
jobos jobs questions <job-id> --json              # NEW: dump captured application questions
jobos research company --job <id> --json          # upgraded: data-backed dossier + companies row
jobos research stakeholders --job <id> --json     # upgraded: populates stakeholders table
jobos outreach draft --stakeholder <id> --job <id> --goal informational   # NEW
jobos outreach schedule-followup --thread <id> --after 5d                  # NEW
jobos outreach mark-sent --thread <id> --channel email                    # NEW (human-confirmed)
jobos outreach due --json                                                 # NEW
```

## Sequencing (lowest risk → highest)

1. `@jobos/researcher` standalone package + `importUrl` swap + jobs schema columns. (Deterministic, no model, immediately improves every downstream function.)
2. `research company` data-backed dossier + real `companies` columns.
3. `research stakeholders` populates `stakeholders` table (safe no-auth surface first; browser-attach opt-in later).
4. `outreach_threads` + `draft_outreach` + follow-up tasks + dashboard tab.
5. Optional: on-demand LinkedIn browser-attach enrichment, gated and human-paced.

Steps 1–2 need no LinkedIn and no browser automation — they're pure public-API/JSON-LD work and carry the least ToS/account risk, so they should ship first.
