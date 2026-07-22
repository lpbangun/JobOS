# Open-Source Benchmark Checkup: JobOS vs. Top GitHub Projects

**Date:** 2026-07-22  
**Target Project:** JobOS (`src/cli.js`, `src/people.js`, `src/outreach.js`, `src/tailoring.js`)  
**Scope:** Deep-dive evaluation of JobOS's core feature set against top-tier GitHub open-source projects across 8 functional categories, with dedicated focus on **People/Contact Lookup & Outreach** and **LaTeX Resume Personalization**.

---

## 1. Executive Summary

JobOS sets a **new open-source standard** for **agentic operability, local-first data ownership, and claim-level truth grounding**. Unlike typical single-purpose GitHub repos (e.g., scraping scripts or LaTeX templates), JobOS integrates local SQLite storage, TUI/CLI/MCP interfaces, ACP v1 guest agent execution, and strict proof provenance.

### Overall Category Standings:
* **Exceeds Open-Source Standards in:** Local Data Ownership & Engine, Dual ACP/MCP Protocol Integration, Proof-Grounded Tailoring & Verification, Multi-Scope Research Orchestration, and Terminal UX.
* **Meets Open-Source Standards in:** Application Lifecycle CRM, Warm Network Path Selection, Fit Scoring & Matching.
* **Lagging Open-Source Standards in:** LaTeX Compilation & PDF Pipelines (vs. *RenderCV* / *Awesome-CV*), Broad Multi-Board Scraping (vs. *JobSpy*), Automated Email Discovery/Validation (vs. *theHarvester* / *Sherlock*), and Turnkey ATS Form Autofill (vs. *AI Hawk* / *Browser-Use*).

---

## 2. Deep-Dive Category Benchmarks

### Category A: People & Contact Lookup, Lead OSINT & Outreach
* **Benchmark GitHub Projects:**
  * [`sherlock-project/sherlock`](https://github.com/sherlock-project/sherlock) (~54k+ stars): Top OSINT tool for username footprinting across 400+ social networks.
  * [`theharvester/theHarvester`](https://github.com/theharvester/theHarvester) (~10k+ stars): Leading OSINT tool for harvesting emails, employee names, subdomains, and PGP keys across public sources.
  * [`filip-michalsky/SalesGPT`](https://github.com/filip-michalsky/SalesGPT) (~6k+ stars): Open-source autonomous AI sales/outreach agent for context-aware email drafting and lead qualification.
* **JobOS Current Capability (`src/people.js`, `src/outreach.js`, `src/research/`):**
  * Budgeted multi-scope people research (profile, target, job, person) querying local network, GDELT, Wayback, GitHub, and web citations.
  * User-owned LinkedIn CSV import (`importNetworkCsv`) to map alumni, former colleagues, and warm relationship paths.
  * Proof-grounded outreach drafting (`draftOutreach`) tying personalized notes to candidate proof points and shared company context.
  * Contact governance: approval (`approveContact`), suppression (`suppressContact`), and warm path ranking.
* **Comparison & Standard Check:**
  * **Status:** **Meets Standard on Warm Networking / Lacks OSINT Pattern Finder**
  * **Where JobOS Wins:** Privacy-first design, warm-path relationship graph, and proof-grounded outreach drafting (prevents AI from inventing fake mutual interests).
  * **Where Benchmark Leads:** *theHarvester* and *Sherlock* provide direct corporate email pattern guessing (`first.last@company.com`), SMTP verification handshakes, and broad username footprinting across hundreds of networks.

---

### Category B: Resume Personalization, LaTeX Compilation & Job Matching
* **Benchmark GitHub Projects:**
  * [`rendercv/rendercv`](https://github.com/rendercv/rendercv) (~5k+ stars): Modern CLI pipeline that parses YAML resume data and compiles tailored LaTeX resume PDFs using Jinja2 + `tectonic`/`pdflatex`.
  * [`posquit0/Awesome-CV`](https://github.com/posquit0/Awesome-CV) (~18k+ stars): The gold-standard LaTeX resume & cover letter template on GitHub.
  * [`srbhr/Resume-Matcher`](https://github.com/srbhr/Resume-Matcher) (~6k+ stars): Open-source AI tool comparing resumes against job descriptions to score ATS keyword overlap and optimize tailored bullet points.
* **JobOS Current Capability (`src/tailoring.js`, `src/scoring.js`):**
  * Multi-dimensional fit scoring analyzing role, domain, seniority, work model, compensation, network, and red flags against job descriptions.
  * Proof-grounded resume & cover letter tailoring (`tailor resume`) mapping job requirements directly to candidate proof IDs (`proof.id`).
  * Predecessor-aware artifact versioning, markdown diffs (`artifacts diff`), terminal `$EDITOR` round-trips, and auditable approval states (`artifacts approve`).
* **Comparison & Standard Check:**
  * **Status:** **Partial / Formatting & LaTeX Engine Gap**
  * **Where JobOS Wins:** Strict evidence grounding. JobOS guarantees that tailored bullets are backed by real candidate accomplishments, avoiding LLM keyword stuffing or hallucinated claims.
  * **Where Benchmark Leads:** *RenderCV* and *Awesome-CV* provide native LaTeX source generation, customizable `.tex` Jinja2 templates, and automated PDF compilation. *Resume Matcher* provides visual keyword density heatmaps comparing the resume directly to the target Job Description.

---

### Category C: Job Discovery & Multi-Source Aggregation
* **Benchmark Projects:** [`croyera/jobspy`](https://github.com/croyera/jobspy) (~5k+ stars), `SearXNG`
* **JobOS Current Capability:** Greenhouse, Lever, Ashby, public career pages, and VC portfolio pages with rate-limiting and deduplication.
* **Comparison:** JobOS provides structured pipeline integration, but lacks native scrapers for major aggregators (LinkedIn, Indeed, Glassdoor, ZipRecruiter).

---

### Category D: Auto-Apply & Browser Automation
* **Benchmark Projects:** [`federicoporus/Auto_Jobs_Applier_AI_Hawk`](https://github.com/federicoporus/Auto_Jobs_Applier_AI_Hawk) (~15k+ stars), [`browser-use/browser-use`](https://github.com/browser-use/browser-use) (~15k+ stars)
* **JobOS Current Capability:** Readiness planning (`applications plan`), reusable Answer Bank with sensitive-question redaction, and SHA-256 validated Playwright script runner.
* **Comparison:** JobOS leads in security and question governance, but lacks turnkey DOM autofill handlers for complex portals (Workday, iCIMS, LinkedIn Easy Apply).

---

### Category E: Agent Architecture & Protocol Standards
* **Benchmark Projects:** [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers), `ACP v1 Standard`
* **JobOS Current Capability:** Dual-door architecture serving CLI, TUI, internal ACP session (`Hermes 0.18.2`), and external MCP server (`jobos mcp`).
* **Comparison:** **Exceeds Open-Source Standard.**

---

### Category F: Application Tracking & CRM Lifecycle
* **Benchmark Projects:** Open-source job trackers (`Career-Canvas`, Huntr alternatives)
* **JobOS Current Capability:** Data-bound TUI Kanban board, status timeline, task generation, analytics, and weekly review.
* **Comparison:** **Meets / Exceeds Open-Source Standard.**

---

## 3. Comparative Matrix

| Category | Benchmark Project | JobOS Status | Key Strength | Key Gap |
|---|---|---|---|---|
| **People Lookup & Outreach** | `sherlock`, `theHarvester`, `SalesGPT` | **Meets Standard** | Warm network path ranking & proof-grounded outreach | No email pattern guessing (`first.last@company.com`) or SMTP validation |
| **LaTeX Resume & Personalization** | `RenderCV`, `Awesome-CV`, `Resume-Matcher` | **Partial** | Proof-grounded bullet tailoring & markdown diff versioning | No LaTeX `.tex` generator or PDF compilation engine (`pdflatex`/`tectonic`) |
| **Job Discovery** | `jobspy` | **Partial** | Safe portfolio scans & fit scoring integration | Missing LinkedIn/Indeed/Glassdoor scrapers |
| **Auto-Apply & Fill** | `AI_Hawk`, `browser-use` | **Partial** | Answer Bank & sensitive-question safety gate | Missing out-of-the-box Workday/iCIMS form drivers |
| **Agent Protocols** | `MCP Standard`, `ACP v1` | **Exceeds** | Dual ACP/MCP facade, zero-leak session recovery, 40+ tools | None |
| **Application CRM** | `Huntr OSS Clones` | **Meets/Exceeds** | Data-bound TUI Kanban, task engine, network edges | Web UI is minimal compared to TUI |

---

## 4. Specific Actionable Roadmap

1. **LaTeX & RenderCV Integration:**
   * Implement `jobos tailor resume --format latex` to output valid `.tex` markup or integrate with Jinja2/RenderCV templates.
   * Add optional compilation via `tectonic` or `pdflatex` for pixel-perfect PDF rendering.
2. **ATS Keyword Density Heatmap:**
   * Build a keyword comparison utility (similar to *Resume Matcher*) that highlights matching vs. missing skill keywords between the Job Description and the candidate's tailored resume.
3. **Corporate Email Pattern Discovery:**
   * Add email format inference (e.g. `{first}.{last}@{domain}`) and MX/SMTP verification options in `src/research/` to bolster people lookup alongside the existing GDELT/GitHub adapters.
