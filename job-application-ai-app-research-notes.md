# Research notes: open-source and AI-powered job-application apps

_Date: 2026-07-02_

## Scope

This scan focused on tools that help an individual job seeker or career-support organization with one or more parts of the job-search stack:

1. Job discovery and job-board / ATS scraping.
2. Application tracking and personal job-search CRM.
3. Resume, cover letter, and application-answer tailoring.
4. Company, stakeholder, hiring-manager, and recruiter research.
5. Outreach sequencing, follow-ups, and relationship tracking.
6. Interview preparation, negotiation, and feedback loops.
7. Automation surfaces: CLI, REST/GraphQL APIs, MCP servers, scheduled jobs, browser automation, hooks, and agent-harness compatibility.

The goal is not to copy one product wholesale, but to identify composable patterns for an agent-friendly app that Hermes, Codex, Claude Code, OpenCode, or similar harnesses can operate through stable interfaces.

---

## Executive observations

- The strongest open-source projects each cover a different slice, but no single project cleanly owns the full lifecycle from discovery -> fit scoring -> research -> tailored artifacts -> outreach -> tracking -> interviews -> analytics with an explicit agent API.
- Most job-search tools are either:
  - **UI-first trackers/builders** (JobSync, ResumeLM, Resume Matcher, Huntr/Teal/Simplify commercially), or
  - **automation-first pipelines** (ApplyPilot, AIHawk, Career-Ops), or
  - **narrow libraries / services** (JobSpy, Ever Jobs, jobspy-mcp-server, OpenOutreach, Mautic).
- The best agent-readiness patterns came from **Career-Ops**, **Ever Jobs**, **Resume Tailor**, **ApplyPilot**, and **jobspy-mcp-server**:
  - CLI-first commands with stage boundaries.
  - Plain files or structured databases as canonical state.
  - Batch processing and dry-run modes.
  - MCP / API surfaces for assistants.
  - Human approval gates before risky actions like applying or sending outreach.
- Commercial tools prove demand for browser extensions, autofill, kanban trackers, automatic application capture, resume scoring, keywords, and dashboards. They are usually not open or agent-extensible.
- The main opportunity is a **local-first, agent-native job operating system**: self-hosted web app + CLI + API + MCP + scheduled automations + browser extension, designed from day one for human-in-the-loop automation.

---

## Project catalog

### 1. Career-Ops (`santifer/career-ops`)

**Type:** open-source local job-search command center built around AI coding CLIs.  
**License:** MIT.  
**Notable claim:** turns any AI coding CLI into a full job-search command center.

**Useful features and patterns**

- Evaluates job offers using a structured scoring system across multiple weighted dimensions.
- Generates tailored ATS PDFs from candidate CV + job description.
- Scans portals including Greenhouse, Ashby, Lever, Wellfound, company pages, XML/RSS feeds, markdown feeds, and local parser integrations.
- Batch processing through headless CLI workers such as `claude -p`, `opencode run`, or similar.
- Tracks applications in markdown / TSV-style source-of-truth files with health checks, deduplication, and status normalization.
- Includes terminal dashboard, interview preparation, STAR story bank, negotiation scripts, cover letters, debriefs, and legitimacy / scam / ghost-job checks.
- Strong anti-spam posture: filter high-fit roles, do not blindly auto-submit.

**Agent-readiness**

- Very high. The project is explicitly designed around AI coding CLIs.
- Strong model for Hermes/Codex integration: stable file state, command stages, batch workers, and human approval gates.

**Limitations / cautions**

- Less focused on a polished consumer SaaS UX.
- Does not auto-submit applications; this is a feature ethically, but users wanting autofill/auto-apply need an add-on.
- Likely requires the user to be comfortable with terminal workflows.

**Takeaway for our app**

Use Career-Ops as a reference for the **agent-native core**: canonical structured state, scoring rubrics, batch jobs, TUI/dashboard, role evaluation blocks, interview/negotiation artifacts, and explicit human-in-the-loop defaults.

---

### 2. Resume Matcher (`srbhr/Resume-Matcher`)

**Type:** open-source AI resume builder / matcher.  
**License:** Apache-2.0.  
**Stack:** TypeScript + Python.

**Useful features and patterns**

- Master resume as reusable source of truth.
- Paste job descriptions to receive tailored resume improvements.
- Cover letter generator.
- Resume scoring and keyword highlighting.
- Drag-and-drop section customization.
- Multiple templates and PDF export.
- Multi-language UI and content generation.
- Supports local and remote LLMs, including many model providers.

**Agent-readiness**

- Medium. Strong AI functionality and open code, but the public-facing pattern appears more app/UI-oriented than command/API-first.
- Could be wrapped by Hermes/Codex if there is a backend API or CLI exposed locally; otherwise agents would need direct code integration or browser automation.

**Limitations / cautions**

- Primarily covers tailoring artifacts, not full application CRM, stakeholder research, outreach sequencing, or scheduled discovery.
- Match scoring and keyword highlighting can overfit to ATS myths if not paired with quality and truthfulness constraints.

**Takeaway**

Adopt the **master resume -> tailored variant -> score -> review -> PDF** workflow, but expose it as CLI/API/MCP operations and bind every generated bullet to source evidence.

---

### 3. ApplyPilot (`Pickle-Pixel/ApplyPilot`)

**Type:** open-source autonomous job-application pipeline.  
**License:** AGPL-3.0.  
**Stack:** Python.

**Useful features and patterns**

- Six-stage pipeline:
  1. Discover jobs from multiple sources.
  2. Enrich full job descriptions.
  3. Score fit against resume and preferences.
  4. Tailor resume.
  5. Generate cover letter.
  6. Auto-apply through browser automation.
- CLI commands: `applypilot init`, `doctor`, `run`, `apply`, `apply --dry-run`, worker counts.
- Supports dry-run form filling without submitting.
- Parallel workers for discovery/enrichment and application submission.
- Uses Claude Code + Chrome automation for form filling, uploads, screening questions.

**Agent-readiness**

- High. CLI stages and dry-run/apply separation are ideal for agent harnesses.
- Hermes could run discovery nightly, inspect generated artifacts, then invoke dry-run or ask for approval.

**Limitations / cautions**

- Auto-apply is risky: quality, reputational risk, platform ToS issues, possible inaccurate screening answers, duplicate submissions.
- Requires Chrome/Chromium, Claude Code, Node, API keys, and job-board scraping dependencies.
- High-volume claims can encourage spray-and-pray behavior.

**Takeaway**

Steal the **stage-gated CLI pipeline** and dry-run pattern, but default to **review-first**. Auto-submit should be a policy-controlled optional capability with audit logs.

---

### 4. AIHawk (`feder-cr/Jobs_Applier_AI_Agent_AIHawk`)

**Type:** archived open-source AI web agent for applying to jobs.  
**License:** AGPL-3.0.  
**Status:** archived May 2026.

**Useful features and patterns**

- Python/Selenium/Chrome web automation.
- Automates applying to multiple jobs in a tailored way.
- Uses user data folders and configuration.
- Added resume style selection in later commits.
- Large community interest: many stars/forks and media attention.

**Agent-readiness**

- Medium to high conceptually, but lower now due to archive status and removed third-party plugins.

**Limitations / cautions**

- Archived and read-only.
- Provider plugins removed due to copyright concerns.
- Auto-application bots attract ethical, legal, and platform risk.
- Browser automation can be brittle.

**Takeaway**

Use as evidence of demand for automated job-apply agents, but avoid inheriting a brittle, opaque, high-volume workflow. Prefer modular browser actions with dry-runs, selectors, logs, and approval gates.

---

### 5. JobSpy (`speedyapply/JobSpy`)

**Type:** Python job-board scraping library.  
**License:** MIT.

**Useful features and patterns**

- Scrapes LinkedIn, Indeed, Glassdoor, Google Jobs, ZipRecruiter, Bayt, BDJobs, Naukri.
- Returns pandas dataframe / CSV-friendly structured data.
- Supports concurrent scraping, proxies, salary extraction, country/location filters, hours-old filters, and optional LinkedIn description fetching.
- Simple Python API: `scrape_jobs(...)`.

**Agent-readiness**

- High as a library. Hermes/Codex can run a scheduled script that calls JobSpy and imports results.
- Lower as a standalone app unless wrapped by an API/MCP/CLI.

**Limitations / cautions**

- Scraping reliability depends on target sites and anti-bot controls.
- Not a full application tracker or tailoring system.
- Needs deduplication, enrichment, scoring, and compliance controls.

**Takeaway**

Use JobSpy-like adapters as one discovery source among many. Normalize results into a canonical Job entity and never treat scraped data as final without enrichment/deduping.

---

### 6. Ever Jobs (`ever-jobs/ever-jobs`)

**Type:** extensible TypeScript/NestJS job aggregation monorepo.  
**License:** MIT.  
**Surfaces:** REST API, GraphQL API, CLI, MCP server.

**Useful features and patterns**

- Aggregates jobs from 160+ sources; includes ATS and company-specific source plugins.
- Strong modular plugin architecture: each source is an independent package.
- Source adapters for Greenhouse/Ashby/Lever-like systems and many company boards.
- Exposes REST, GraphQL, CLI, and MCP server for AI assistants.
- Recent development includes MCP streamable HTTP transport and stdio mode.
- Agent tooling bundle under `.claude`, `.codex`, `.agents/skills/ever-jobs`.

**Agent-readiness**

- Very high. This is one of the clearest examples of job-search infrastructure designed for agents.
- MCP server means Claude/Hermes/Codex-like tools can query job discovery directly if configured.

**Limitations / cautions**

- Focuses on job aggregation, not candidate profile, resume tailoring, outreach, or tracking.
- 160+ source maintenance is non-trivial.
- Smaller community than the most popular resume/auto-apply projects.

**Takeaway**

This is the best reference for **discovery infrastructure**. Either integrate it directly or mimic its plugin architecture and MCP/API surfaces.

---

### 7. jobspy-mcp-server (`borgius/jobspy-mcp-server`)

**Type:** MCP wrapper around JobSpy.  
**License:** MIT.

**Useful features and patterns**

- Provides Model Context Protocol access to job search across Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google, Bayt, Naukri.
- Supports stdio transport for Claude Desktop and SSE for web clients.
- Returns structured data in JSON or CSV.
- Environment-variable configuration.

**Agent-readiness**

- High by design, though narrower and less polished than Ever Jobs.

**Limitations / cautions**

- Wrapper around a scraper; does not solve lifecycle tracking, scoring, tailoring, or outreach.
- Setup references may have inconsistencies (`HOST`/`PORT` versus `JOBSPY_HOST`/`JOBSPY_PORT`).

**Takeaway**

MCP is a simple and effective bridge for discovery. Our app should expose its own MCP server, not just internal REST.

---

### 8. JobSync (`Gsync/jobsync`)

**Type:** self-hosted job application tracker and AI career assistant.  
**License:** MIT.  
**Stack:** Next.js / TypeScript.

**Useful features and patterns**

- Application tracker with company details, job title, application date, status, notes.
- Monitoring dashboard with progress, success rates, upcoming tasks, trends.
- Resume management, PDF export, AI resume review, AI job matching.
- Task and activity management with time logging.
- Self-hosted/local privacy positioning.

**Agent-readiness**

- Medium. Strong data model and UI, but research did not surface a CLI/MCP/API-first automation surface.
- Agents can likely operate via database/API if documented or browser automation if not.

**Limitations / cautions**

- Does not seem to own job discovery, stakeholder research, or outreach automation deeply.
- Automation support needs validation before building on it.

**Takeaway**

Good reference for the **human dashboard/tracker** side. Pair this with Career-Ops/Ever Jobs-style agent interfaces.

---

### 9. ResumeLM (`olyaiy/resume-lm`)

**Type:** open-source AI resume builder.  
**License:** AGPL-3.0.  
**Stack:** Next.js 15, React 19, Tailwind, Supabase/Postgres, React PDF, Stripe.

**Useful features and patterns**

- AI-powered resume assistant.
- Resume dashboard and multiple resume versions.
- ATS compatibility scoring and keyword insights.
- AI cover-letter generation.
- Multiple AI providers: OpenAI, Claude, Gemini, DeepSeek, Groq.
- Modern web UX, mobile responsive, PDF generation, live preview.

**Agent-readiness**

- Medium. Modern stack and open source, but not obviously built for CLI/MCP operation.

**Limitations / cautions**

- More resume-builder than full job-search operations platform.
- Includes SaaS-like pieces (Supabase, Stripe) that may be unnecessary for a local-first prototype.

**Takeaway**

Use as UI/UX inspiration for resume authoring, previews, and provider abstraction.

---

### 10. Resume Tailor (`rotsl/resume-tailor`)

**Type:** AI resume + cover letter tailoring tool with browser, local web, and CLI modes.  
**License:** MIT.

**Useful features and patterns**

- Takes a resume and job description; outputs tailored resume and cover letter PDFs.
- Three modes: static GitHub Pages app, local Flask app, CLI.
- CLI examples:
  - `python main.py tailor --resume my_resume.pdf --job-url ...`
  - `python main.py tailor --resume my_resume.docx --job-file job_description.pdf`
  - `python main.py history`
- Supports Claude and Gemini.
- Can fetch job descriptions from URL in local/CLI mode.
- Optional Notion logging through Notion MCP.
- Explicit anti-fabrication constraint: only use information already present in source resume.

**Agent-readiness**

- High for a small project because it has a CLI and Notion MCP integration.

**Limitations / cautions**

- Narrow scope: tailoring + logging, not discovery, scoring, outreach, or CRM.
- Small project/community.

**Takeaway**

Excellent pattern for **multi-surface design**: static web for quick use, local web for richer use, CLI for agents, and external logging via MCP. Also important: source-grounded rewriting should be a hard rule.

---

### 11. OpenOutreach (`eracle/OpenOutreach`)

**Type:** self-hosted LinkedIn/email outreach automation for B2B lead generation.  
**License:** GPLv3.

**Useful features and patterns**

- User defines product, campaign objective, target market.
- System generates LinkedIn search queries, discovers profiles, scrapes and embeds profiles.
- Uses Bayesian ML / Gaussian Process Regressor for exploration vs exploitation.
- LLM qualifies profiles and feeds decisions back into model.
- Routes qualified leads to email outreach if a work email is found, otherwise LinkedIn connection/follow-up.
- Stateful, resumable pipeline.
- Built-in CRM via Django Admin / DjangoCRM.
- Docker setup with noVNC so user can watch browser automation.

**Agent-readiness**

- Medium to high. It is autonomous and self-hosted, but oriented to B2B sales rather than career networking.
- The exploration/exploitation loop and CRM-backed state are valuable for stakeholder research.

**Limitations / cautions**

- LinkedIn automation is ToS-sensitive and can risk account restrictions.
- Outreach at scale must avoid spammy behavior; job-search networking should be relationship-first.
- GPLv3 licensing matters if code is reused.

**Takeaway**

Use the pattern, not necessarily the code: stakeholder discovery, enrichment, qualification, personalized messages, channel routing, follow-up sequences, and resumable state.

---

### 12. Company Research Agent (`guy-hartstein/company-research-agent`)

**Type:** multi-agent company research report generator.  
**Stack:** LangGraph, Tavily, Gemini, GPT.

**Useful features and patterns**

- Specialized nodes: CompanyAnalyzer, IndustryAnalyzer, FinancialAnalyst, NewsScanner, Collector, Curator, Briefing, Editor.
- Pulls from company websites, news, financial reports, industry analyses.
- Uses Tavily relevance scoring and thresholds.
- Asynchronous processing and polling for long-running jobs.
- Separates high-context synthesis from final formatting/editing.
- Modern web UI with progress tracking and report download.

**Agent-readiness**

- Medium. The architecture is agentic and modular, but the extracted docs emphasize web UI more than CLI/MCP.

**Limitations / cautions**

- Company-level research needs adaptation for job applications: hiring managers, team/product, role-specific risks, interview prep, outreach angles.
- Requires external search/model APIs.

**Takeaway**

Borrow the **research pipeline architecture** and adapt it to produce application dossiers, stakeholder maps, outreach angles, and interview prep.

---

### 13. Sales Outreach Automation with LangGraph (`kaymen99/sales-outreach-automation-langgraph`)

**Type:** AI lead research and outreach automation.  
**Stack:** Python, LangGraph, CRM integrations.

**Useful features and patterns**

- Connects to HubSpot, Airtable, Google Sheets, or custom CRMs.
- Fetches leads, researches LinkedIn/company websites/news/social media.
- Qualifies leads against criteria.
- Generates analysis reports, personalized emails, interview prep scripts, outreach reports.
- Saves reports locally and in Google Docs.
- Updates CRM records with status and report links.

**Agent-readiness**

- Medium. It is scriptable and agentic; integration surface depends on implementation details.

**Limitations / cautions**

- Sales framing needs adaptation to job-search networking.
- LinkedIn scraping and unsolicited outreach risks remain.

**Takeaway**

Good reference for **CRM-integrated research -> report -> message -> status update** loops.

---

### 14. Email-automation (`PaulleDemon/Email-automation`)

**Type:** open-source cold email / follow-up scheduling tool.

**Useful features and patterns**

- Dynamic templates with Jinja2 variables and conditionals.
- Schedule emails and follow-ups.
- Follow-up rules.
- Campaign creation and unlimited templates.
- Warnings against spam and against using Gmail/Yahoo for cold outreach.

**Agent-readiness**

- Medium. It has clear data-driven workflows, but may need an API/CLI wrapper.

**Limitations / cautions**

- Cold outreach deliverability, ethics, and legal compliance matter.
- For job seekers, lower-volume high-quality outreach is better than campaigns.

**Takeaway**

Our app needs templated, scheduled, conditional follow-ups, but must be constrained by consent, volume limits, and relationship context.

---

### 15. Mautic (`mautic/mautic`)

**Type:** mature open-source marketing automation platform.

**Useful features and patterns**

- Multi-channel campaigns.
- Contact segmentation.
- Email marketing automation.
- Automation workflows.
- Custom integrations.
- Privacy-focused, self-hosted deployment.
- Large mature project with releases and CLI-oriented install workflows.

**Agent-readiness**

- Medium. Very automatable in principle, but heavyweight and designed for organizations/marketing more than individual job seekers.

**Limitations / cautions**

- Overkill for a personal job-search app.
- Campaign metaphor can encourage inappropriate scale.

**Takeaway**

Use as inspiration for workflow builder concepts: triggers, conditions, actions, segments, suppression rules, and compliance guardrails.

---

### 16. Twenty CRM (`twentyhq/twenty`)

**Type:** open-source CRM designed for AI.  
**Stack:** modern web CRM with SDK/CLI.

**Useful features and patterns**

- Open alternative to Salesforce, designed for AI.
- Custom CRM objects, fields, views as code via SDK.
- CLI for app publishing: `npx create-twenty-app`, `npx twenty app:publish --private`.
- Supports objects, views, agents, logic functions.
- Self-hosting via Docker Compose.

**Agent-readiness**

- High as a programmable CRM substrate.

**Limitations / cautions**

- General CRM, not job-search-specific.
- Would need custom schema and UI for applications, roles, stakeholder maps, resumes, and artifacts.

**Takeaway**

Could be a foundation for a job-search CRM if we want to build on an extensible CRM rather than creating one from scratch. Strong idea: define job-search objects as code.

---

## Commercial product patterns worth copying

These products are not open-source references, but they validate user needs and UX patterns.

### Teal

- Chrome extension saves jobs from 40+ job boards.
- Central dashboard for applications, contacts, companies, follow-ups, notes, ratings, stages, weekly goals.
- Super Search opens searches across multiple job boards.
- Stores job descriptions, salary information, resume keywords, and structured job breakdowns.

**Pattern to copy:** browser extension capture + tracker + goals + contact/company records.

### Huntr

- Job tracker, contact tracker, interview tracker, metrics.
- AI resume builder/review/checker, cover letters, bullet/summary/skills generators.
- Resume tailoring, keyword scanner, job keyword finder.
- Autofill and Chrome extension.
- Also supports organizations such as bootcamps, career centers, workforce development.

**Pattern to copy:** complete job-search workspace with individual and career-coach/team modes.

### Simplify Copilot

- Autofill job applications in one click.
- Resume score and job-description-specific optimization insights.
- AI-generated application question responses.
- Automatic tracking of applications submitted through the extension.
- Curated job discovery lists.

**Pattern to copy:** autofill + automatic capture + question-answer memory.

### Jobscan

- Resume/job match report.
- Missing keywords, hard/soft skills, formatting, ATS compatibility.
- LinkedIn optimization.
- Resume builder, cover letters, job tracker, auto-apply with user review.

**Pattern to copy:** explainable match reports, but avoid blindly optimizing for questionable ATS scoring myths.

### LoopCV / Sonara-style tools

- Continuous job scanning and auto-apply.
- Analytics on applications, opens, replies, CV performance, A/B tests.
- Daily automation loops.

**Pattern to copy carefully:** scheduled discovery and analytics. Avoid opaque high-volume auto-apply defaults.

---

## Cross-project feature matrix

| Capability | Strong references | Notes for our app |
|---|---|---|
| Job discovery | Ever Jobs, JobSpy, ApplyPilot, Career-Ops | Use plugin adapters + APIs + schedules; dedupe and enrich. |
| ATS/company portal scanning | Ever Jobs, Career-Ops, ApplyPilot | Greenhouse/Ashby/Lever first; company-targeted scans. |
| Resume tailoring | Resume Matcher, ResumeLM, Resume Tailor, Career-Ops, ApplyPilot | Source-grounded variants; evidence-linked bullets. |
| Cover letters | Resume Matcher, ResumeLM, Resume Tailor, Career-Ops, ApplyPilot | Generate only after role fit/research; include approval gate. |
| Application question answers | Simplify, ApplyPilot | Build reusable verified answer bank; never fabricate. |
| Application tracking | JobSync, Teal, Huntr, Career-Ops | Kanban + timeline + status normalization + source of truth. |
| Stakeholder research | OpenOutreach, Sales Outreach LangGraph, Company Research Agent | Adapt sales lead research into hiring-team/recruiter research. |
| Outreach/follow-ups | OpenOutreach, Email-automation, Mautic, Teal/Huntr contacts | Relationship-first templates, schedules, suppression rules. |
| Browser capture/autofill | Teal, Huntr, Simplify, ApplyPilot, AIHawk | Extension + Playwright/Chrome automation; dry-run by default. |
| Agent integration | Career-Ops, Ever Jobs, jobspy-mcp-server, Resume Tailor | CLI + REST + GraphQL + MCP + files as canonical state. |
| Scheduled automation | ApplyPilot, LoopCV, Mautic, cron patterns | Nightly discovery, weekly review, follow-up reminders, stale-status checks. |
| Interview prep | Career-Ops, career-assistant projects | Role dossier -> likely questions -> STAR story map -> debrief. |
| Analytics | JobSync, Huntr, LoopCV | Conversion funnel, source quality, response rates, bottlenecks. |

---

## Technical approaches observed

### 1. CLI-first staged pipelines

Examples: ApplyPilot, Career-Ops, Resume Tailor.

A good CLI exposes stages that agents can compose:

```bash
jobos discover --profile logani --source greenhouse --since 24h
jobos score --job job_123 --profile logani
jobos tailor --job job_123 --resume master_pm --format pdf
jobos research company --job job_123
jobos outreach draft --stakeholder person_456 --job job_123
jobos apply dry-run --job job_123
jobos apply submit --job job_123 --requires-approval
```

### 2. MCP for agent-native discovery/tools

Examples: Ever Jobs, jobspy-mcp-server, Resume Tailor via Notion MCP.

MCP is valuable because agent harnesses can treat the job app as a set of tools rather than scraping its UI. Our app should expose MCP tools such as:

- `search_jobs`
- `get_job`
- `score_job_fit`
- `create_tailored_resume`
- `create_company_dossier`
- `list_due_followups`
- `draft_outreach`
- `update_application_status`

### 3. Canonical state as files or database

Career-Ops uses flat files / markdown / TSV-style sources of truth. JobSync and ResumeLM use web-app databases. Twenty defines CRM objects as code.

Recommended hybrid:

- SQLite/Postgres for app state and UI.
- Export/import to markdown/JSONL/YAML for agent readability and git versioning.
- Artifact folders per opportunity.

### 4. Browser extension capture and autofill

Commercial tools prove browser extensions are essential because many jobs are found inside browsers. Automation should support:

- Save current job page.
- Extract job description, salary, location, source URL, company, application URL.
- Detect ATS vendor.
- Autofill profile fields.
- Capture submitted applications and confirmation pages.
- Let users annotate fit, interest, red flags.

### 5. Human-in-the-loop gates

The safest tools separate generation from submission/sending:

- Dry-run autofill before submit.
- Approval required for external messages.
- Preview diffs between master resume and tailored resume.
- Confidence / evidence labels for research claims.
- Audit trail for every agent action.

---

## Gaps and opportunities

1. **No unified agent-native job OS.** Existing tools are either trackers, scrapers, tailors, or auto-appliers. The winning app combines them through stable CLI/API/MCP interfaces.
2. **Weak stakeholder research in job tools.** Sales tools research leads well, but job seekers need hiring-team maps, recruiter context, team/product strategy, and warm-intro paths.
3. **Poor evidence discipline.** Resume tailoring tools often optimize wording, but few attach every claim to a source profile/resume/project proof point.
4. **Automation is too binary.** Tools either do little automation or jump to auto-apply. Better: progressive autonomy levels.
5. **Limited personalization beyond resume.** Ideal app should learn user constraints, goals, role preferences, communication style, locations, salary thresholds, risk tolerance, industries, and target-company criteria.
6. **Missing agent contracts.** Most apps lack OpenAPI specs, CLI JSON output, webhooks, MCP, or idempotent operations that agents can safely call.
7. **Limited scheduled work.** Job seekers need recurring discovery, stale-application checks, follow-up nudges, company-watch alerts, and weekly retrospectives.
8. **Application-answer memory is underdeveloped.** Reusable verified answers for eligibility, work authorization, salary, DEI, relocation, projects, and behavioral prompts should be first-class.
9. **Few tools optimize for quality networking.** Outreach should be low-volume, researched, and relationship-aware, not sales spam.
10. **Privacy and local-first remain underserved.** Job-search data is sensitive: resumes, personal stories, contacts, compensation, immigration, demographics. Local-first/self-hosted should be a default option.

---

## Implications for prototype direction

The prototype should not start as a polished all-in-one SaaS. It should start as a **local-first command center** with a thin web UI and robust agent interfaces:

1. Define canonical data schema: Profile, ResumeSource, Job, Company, Stakeholder, Application, Artifact, OutreachThread, Task, AutomationRun.
2. Build/import discovery adapters: Ever Jobs or JobSpy first; manual URL capture second; Greenhouse/Ashby/Lever direct APIs third.
3. Build fit scoring with user-editable rubrics and reasons.
4. Build source-grounded resume/cover-letter tailoring with diff review.
5. Build company/stakeholder research dossier generator.
6. Build tracker and follow-up/task system.
7. Expose every operation via CLI JSON, REST/OpenAPI, and MCP.
8. Add cron/scheduler for recurring discovery, follow-up reminders, stale status checks, and weekly reports.
9. Add browser extension after core data model stabilizes.
10. Add autofill/dry-run submission later, never as the first feature.
