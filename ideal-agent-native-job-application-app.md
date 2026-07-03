# Ideal app concept: an agent-native job application operating system

_Date: 2026-07-02_

## Working name

**JobOS** — a local-first, agent-native operating system for job applications.

The app should help any job seeker run a higher-quality job search: discover fitting roles, understand companies and stakeholders, tailor materials truthfully, manage applications and relationships, automate repetitive tasks, and learn from outcomes.

It should be built so humans can use it directly through a web UI/browser extension, while agent harnesses like **Hermes**, **Codex**, **Claude Code**, and **OpenCode** can safely operate it through CLI, API, MCP, webhooks, and scheduled jobs.

---

## Core thesis

Most job-search apps are optimized for either manual organization or high-volume automation. The better product is a **quality-first, automation-ready command center**.

The app should:

- Make the user’s profile, proof points, preferences, constraints, and communication style explicit.
- Convert each job opportunity into a structured workspace.
- Use AI/agents to do bounded work: discover, score, research, draft, summarize, remind, and prepare.
- Keep external actions gated: applying, submitting forms, sending outreach, or answering sensitive questions should require review unless the user explicitly changes policy.
- Expose stable machine interfaces so agents do not need to scrape the UI.

---

## Product principles

1. **Local-first and privacy-first.** Resumes, salary constraints, job status, outreach notes, and personal stories are sensitive. Self-hosting/local mode should be first-class.
2. **Agent-native, not agent-bolted-on.** Every important UI action should also be a CLI/API/MCP operation with JSON output.
3. **Evidence-grounded generation.** Resume bullets, cover letters, screening answers, and outreach claims must link back to source facts.
4. **Human-in-the-loop by default.** Agents draft, score, research, and stage actions. Humans approve submissions and messages.
5. **Progressive autonomy.** Users choose automation levels per workflow: manual, suggest, draft, internal auto-update, stage (dry-run external actions), external auto-action with constraints. (See "Automation model" for the full ladder.)
6. **Full-funnel memory.** The app should remember not only jobs and resumes, but also contacts, stakeholders, screening answers, interview stories, follow-ups, and outcomes.
7. **Quality over spray-and-pray.** Optimize for best-fit applications, thoughtful networking, and learning loops, not raw application count.
8. **Portable data.** Export everything to markdown/JSON/CSV and optionally git-track artifacts.

---

## Overall architecture

```text
                 ┌──────────────────────────────────────────┐
                 │              Human Interfaces             │
                 │ Web app · TUI · Browser extension · Mobile │
                 └────────────────────┬─────────────────────┘
                                      │
 ┌────────────────────────────────────▼────────────────────────────────────┐
 │                              JobOS Core                                 │
 │  Profiles · Jobs · Companies · Stakeholders · Applications · Artifacts  │
 │  Tasks · Outreach · Automations · Audit log · Preferences · Analytics   │
 └─────────────┬──────────────────────────────┬──────────────────────────┘
               │                              │
 ┌─────────────▼────────────┐      ┌──────────▼──────────┐
 │ Agent Integration Layer  │      │ Automation Scheduler │
 │ CLI · REST · GraphQL     │      │ cron · queues · runs │
 │ MCP · webhooks · JSONL   │      │ approvals · alerts   │
 └─────────────┬────────────┘      └──────────┬──────────┘
               │                              │
 ┌─────────────▼──────────────────────────────▼──────────────────────────┐
 │                          Capability Modules                            │
 │ Discovery · Fit scoring · Tailoring · Research · Outreach · Autofill   │
 │ Interview prep · Negotiation · Analytics · Import/export               │
 └─────────────┬─────────────────────────────────────────────────────────┘
               │
 ┌─────────────▼─────────────────────────────────────────────────────────┐
 │ External adapters: JobSpy/Ever Jobs · Greenhouse/Ashby/Lever/Workday  │
 │ Gmail/Calendar/Notion/Google Docs · LinkedIn/manual imports · LLMs    │
 │ Browser automation · PDF generation · CRM/email providers             │
 └───────────────────────────────────────────────────────────────────────┘
```

### Deployment modes

1. **Solo local mode**
   - SQLite + local files.
   - Runs on laptop/VPS.
   - CLI and web UI on localhost.
   - Best for technical users and agent harnesses.

2. **Self-hosted team/career-coach mode**
   - Postgres + object storage.
   - Multi-user support for bootcamps, career centers, outplacement, or coaches.
   - Permissions and shared templates.

3. **Cloud/SaaS mode later**
   - Optional hosted version.
   - Must preserve data export and privacy controls.

---

## Canonical data model

### Profile

A user can have multiple profiles, because job seekers often target different role families.

Fields:

- Name, location preferences, work authorization, relocation preferences.
- Target role families, industries, company stages, locations, salary bands.
- Dealbreakers and preferences: remote/hybrid, mission, manager style, travel, sponsorship, visa, compensation, values.
- Search strategy: conservative, focused, exploratory, high-volume.
- Communication style: concise, warm, analytical, founder-style, academic, etc.
- Risk tolerance for automation.

### ResumeSource

The source-of-truth resume and proof library.

Fields:

- Master resume sections.
- Work/project/education entries.
- Proof points with evidence links.
- Metrics and allowed claims.
- Skills taxonomy.
- Story bank entries.
- Portfolio links, writing samples, GitHub repos, case studies.

### Job

A normalized opportunity record.

Fields:

- Title, company, location, URL, source, ATS vendor, posted date.
- Full job description and extracted requirements.
- Compensation range and benefits if available.
- Work model, seniority, role family, department.
- Deduplication keys and source history.
- Fit score, reasons, red flags, uncertainty.

### Company

Fields:

- Website, industry, stage, size, funding, business model.
- Products, customers, competitors.
- News, strategy, recent changes.
- Hiring patterns.
- Values/culture evidence.
- Risk flags: layoffs, scams, ghost jobs, bad reviews, suspicious postings.

### Stakeholder

Fields:

- Name, role, company, likely relationship to opening.
- Public links: LinkedIn, GitHub, website, publications, talks.
- Relevance to role: recruiter, hiring manager, team member, founder, alumni, mutual connection.
- Research summary and evidence.
- Outreach status, last contact, next action.

### Application

Fields:

- Job, profile, selected resume variant, cover letter, answers, submission status.
- Stages: saved, researching, materials ready, applied, recruiter screen, interview, offer, rejected, withdrawn, ghosted.
- Tasks, deadlines, interview dates, follow-ups.
- Source and confirmation URL/screenshot.
- Outcome and lessons learned.

### Artifact

Generated or imported documents:

- Tailored resumes.
- Cover letters.
- Company dossiers.
- Stakeholder briefs.
- Outreach drafts.
- Screening answer drafts.
- Interview prep packets.
- Negotiation scripts.

Each artifact should include:

- Prompt/config used.
- Source evidence.
- Model/agent used.
- Diff from prior version when relevant.
- Approval status.

### Task

First-class entity (referenced by Applications, Outreach, and the scheduler — not just a field on other records).

Fields:

- Title, description, type: follow-up, prep, research, apply, review, admin.
- Linked job/application/stakeholder/artifact.
- Due date, recurrence, priority.
- Status: open, snoozed, done, cancelled.
- Created by: user, automation, agent (for audit).

### OutreachThread

The CLI and MCP surfaces reference threads (`--thread thread_789`, `log_outreach_event`), so the thread is canonical state.

Fields:

- Stakeholder, job/application context, channel (email, LinkedIn, intro request, in-person).
- Goal: informational, referral, application signal, thank-you, negotiation.
- Message history: drafts, sent messages, replies, timestamps.
- Follow-up schedule and pause conditions (e.g., pause when application status changes).
- Suppression state and relevance rationale (why this contact is appropriate).

### Offer

Referenced by negotiation commands (`jobos negotiation packet --offer offer_123`) and needed for offer comparison.

Fields:

- Application link, company, role, level.
- Base, bonus, equity (type, vesting, strike/valuation context), benefits, location/remote terms.
- Deadlines and exploding-offer terms.
- Competing offers and comparison notes.
- Negotiation history: asks, responses, final terms.
- Decision and rationale.

### AutomationRun

Fields:

- Trigger, inputs, outputs, logs, agent/model used.
- Status: queued, running, succeeded, failed, needs approval.
- External side effects attempted/completed.
- Audit links.

---

## Main app modules

## 1. Profile and preference onboarding

### What it looks like

A guided setup that feels like onboarding a recruiter:

- Upload/import existing resume, LinkedIn export, portfolio, GitHub, writing samples.
- Ask structured questions about target roles, industries, locations, salary, constraints, and dealbreakers.
- Build role-specific profiles, e.g.:
  - Product Manager, early-stage EdTech.
  - People Ops / Talent roles.
  - Learning Designer / Education Engineer.
  - Software engineer, designer, data analyst, etc. for other users.

### Key features

- Multiple profiles/personas.
- Preference rubrics with weights.
- Explicit negative preferences.
- Evidence/proof-point library.
- Reusable answer bank for common application questions.
- Communication-style profile for outreach and cover letters.
- Calibration workflow: user rates sample jobs; model learns preferences.

### Tailoring to different users

- New graduate: emphasize internships, projects, coursework, networking volume, campus recruiting.
- Career switcher: emphasize transferable skills, story framing, portfolio proof.
- Senior operator/executive: emphasize targeted search, stakeholder mapping, warm intros, market diligence.
- International candidate: track sponsorship, visa, relocation, country constraints.
- Career center/coach user: shared rubrics, reviewed templates, progress dashboards.

### Agent integration

```bash
jobos profile create --name "PM EdTech"
jobos profile import-resume ./resume.pdf --profile pm-edtech
jobos profile set-preferences --profile pm-edtech preferences.yaml
jobos profile calibrate --profile pm-edtech --from ratings.csv
jobos profile export --profile pm-edtech --format markdown
```

MCP tools:

- `get_profile`
- `update_profile_preferences`
- `list_proof_points`
- `add_proof_point`
- `calibrate_preferences`

---

## 2. Job discovery and ingestion

### What it looks like

A search workspace with saved searches, company lists, job-board sources, and a browser extension.

Users can:

- Run saved searches manually.
- Schedule searches.
- Save a job from any web page.
- Import CSVs or links.
- Watch target companies and ATS boards.
- Ask an agent: "Find 20 promising PM roles at early-stage EdTech/worktech companies in Boston/NYC/SF/remote posted this week."

### Key features

- Source adapters:
  - JobSpy-like broad job-board scraping.
  - Ever Jobs-like modular source plugins.
  - Direct ATS APIs: Greenhouse, Lever, Ashby, Workday where possible.
  - RSS/XML/company career pages.
  - Manual browser capture.
- Deduplication across sources.
- Enrichment of sparse postings.
- Saved searches with schedule and thresholds.
- Company watchlists.
- Job freshness and repost detection.
- Scam/ghost-job heuristics.

### Automation support

Examples:

- Nightly discovery for saved searches.
- Weekly target-company scan.
- Alerts when high-fit jobs appear.
- Auto-archive duplicates or low-fit roles.
- Create review queue rather than auto-apply.

### Agent integration

CLI:

```bash
jobos discover run --search pm-edtech-boston --since 24h --json
jobos jobs import-url https://boards.greenhouse.io/example/jobs/123
jobos jobs list --status new --min-fit 4.0 --json
jobos jobs enrich job_123 --json
jobos jobs dedupe --apply
```

REST:

```http
POST /api/searches/{id}/run
POST /api/jobs/import-url
GET  /api/jobs?status=new&min_fit=4
POST /api/jobs/{id}/enrich
```

MCP:

- `search_jobs`
- `import_job_url`
- `get_job`
- `list_jobs`
- `enrich_job`

---

## 3. Fit scoring and decision support

### What it looks like

Each job gets a fit report:

- Overall score.
- Subscores: role fit, domain fit, seniority, compensation, location, mission, growth, likelihood, network access, red flags.
- Reasons and evidence.
- Missing information.
- Recommendation: ignore, save, research, apply, network-first, monitor.

### Key features

- User-editable scoring rubric.
- Weighted dimensions by profile.
- Explainable scores, not black boxes.
- Confidence estimates.
- Calibration from user decisions and outcomes.
- Comparisons across opportunities.
- Decision queues: "top 10 this week".

### Tailoring to different users

- A high-volume early-career user may weight eligibility and application speed higher.
- A senior or niche-role user may weight stakeholder access and company quality higher.
- A career switcher may weight transferable skill match and portfolio relevance higher.
- A user with strict location constraints may make location a hard filter.

### Agent integration

```bash
jobos score job_123 --profile pm-edtech --json
jobos score batch --status new --profile pm-edtech --min-confidence 0.7
jobos jobs recommend --profile pm-edtech --limit 10
```

MCP:

- `score_job_fit`
- `explain_job_score`
- `rank_jobs`
- `update_scoring_rubric`

---

## 4. Resume, cover letter, and application-answer tailoring

### What it looks like

A document studio for a job opportunity:

- Left: job requirements and company research.
- Middle: master resume/proof library.
- Right: tailored resume, cover letter, and screening answers.
- Diff view showing what changed.
- Evidence panel showing where every claim came from.
- ATS/readability checks that are advisory, not magical.

### Key features

- Master resume source of truth.
- Role-specific resume variants.
- Truth-preserving rewriting.
- Requirement-to-proof mapping.
- Keyword coverage and missing skills.
- Cover letter generator with tone controls.
- Application answer bank:
  - Work authorization.
  - Salary expectations.
  - Relocation.
  - "Why this company?"
  - "Why this role?"
  - DEI statements if needed.
  - Project/achievement examples.
- PDF, DOCX, Markdown, and plain-text exports.
- Versioning and approval status.

### Evidence-grounding rule

Every generated claim should be one of:

- **Directly supported** by a resume/profile/proof point.
- **Reasonably reframed** from existing evidence.
- **Needs user input**.
- **Not allowed**.

The UI should block or flag unsupported claims.

### Automation support

- Auto-generate first draft for high-fit jobs.
- Auto-run keyword/readability checks.
- Auto-create an application packet after approval.
- Reuse approved answer snippets across applications.
- Scheduled cleanup: stale drafts, missing proof points, old variants.

### Agent integration

```bash
jobos tailor resume --job job_123 --profile pm-edtech --template ats-clean --output pdf --json
jobos tailor cover-letter --job job_123 --tone warm-concise --json
jobos answers draft --job job_123 --question "Why are you interested in us?" --json
jobos artifacts diff artifact_1 artifact_2
jobos artifacts approve artifact_456
```

MCP:

- `create_tailored_resume`
- `draft_cover_letter`
- `draft_application_answer`
- `check_artifact_evidence`
- `approve_artifact`

---

## 5. Company and stakeholder research

### What it looks like

A dossier builder for each company/job:

- Company snapshot: product, market, business model, stage, funding, competitors.
- Role context: why this team is hiring, likely challenges, expected outcomes.
- Stakeholder map: recruiter, hiring manager, team members, founders, alumni, mutuals.
- Recent news and strategic signals.
- Interview angles and thoughtful questions.
- Outreach opportunities.

### Key features

- Multi-agent research pipeline:
  - Company analyzer.
  - Product/market analyzer.
  - Role/team analyzer.
  - News scanner.
  - Stakeholder finder.
  - Alumni/mutual connection finder.
  - Dossier editor.
- Source citations and confidence levels.
- Stakeholder relationship CRM.
- Warm intro path detection.
- Red-flag detection: layoffs, legal issues, suspicious postings, poor reviews.
- Research templates by role type.

### Tailoring to different users

- Product roles: product strategy, customer segments, roadmap hypotheses, metrics.
- People/Talent roles: hiring plans, culture, org growth, recruiting process, employer brand.
- Learning design roles: learners, curriculum/product model, assessment, efficacy evidence.
- Engineering roles: tech stack, architecture clues, engineering blog, GitHub activity.
- Executive roles: board/investors, financials, market position, org design.

### Automation support

- Auto-create basic dossier for jobs above fit threshold.
- Watch company news weekly for active applications.
- Before interviews, refresh company/stakeholder dossier.
- Generate interview prep packet 24 hours before interview.
- Generate outreach draft only after stakeholder relevance is established.

### Agent integration

```bash
jobos research company --job job_123 --depth standard --json
jobos research stakeholders --company company_456 --role "Head of Product" --json
jobos research refresh --application app_789 --before-interview
jobos dossier export --job job_123 --format markdown
```

MCP:

- `create_company_dossier`
- `find_stakeholders`
- `get_stakeholder_brief`
- `refresh_dossier`
- `generate_interview_questions`

---

## 6. Outreach and relationship management

### What it looks like

A lightweight personal CRM embedded in the job tracker:

- Contacts/stakeholders connected to companies and jobs.
- Outreach drafts and history.
- Follow-up schedule.
- Relationship notes.
- Warm-intro paths.
- Suppression/quiet rules.

### Key features

- Personalized outreach drafts from stakeholder research and user style.
- Channels: email, LinkedIn, alumni directory, mutual-intro request, existing contact.
- Follow-up templates and rules.
- Calendar/task reminders.
- Outreach quality score: specificity, relevance, ask clarity, length, tone.
- Contact segmentation: recruiter, hiring manager, team member, alumni, founder, friend-of-friend.
- Anti-spam constraints:
  - Daily/weekly caps.
  - Do-not-contact list.
  - No mass generic sends.
  - Approval required by default.
  - Record why contact is relevant.

### Tailoring to different users

- Introverted/low-volume user: fewer, deeper messages and prep.
- Sales-oriented user: more structured campaigns, but still constrained.
- Career changer: messages emphasize narrative and learning conversations.
- Senior candidate: board/founder/executive stakeholder paths.
- Students/new grads: alumni and campus channels.

### Automation support

- Draft outreach after dossier completion.
- Remind user after 5-7 business days if no response.
- Pause follow-ups if application status changes.
- Auto-log sent messages from Gmail/IMAP if connected.
- Weekly relationship review.

### Agent integration

```bash
jobos outreach draft --stakeholder person_123 --job job_456 --goal informational --json
jobos outreach schedule-followup --thread thread_789 --after 5d
jobos outreach due --json
jobos outreach mark-sent --thread thread_789 --channel email
```

MCP:

- `draft_outreach`
- `list_due_followups`
- `schedule_followup`
- `log_outreach_event`
- `get_relationship_context`

---

## 7. Application tracking and workflow management

### What it looks like

A kanban + table + timeline dashboard:

- New / Saved / Researching / Materials Ready / Applied / Follow-up / Interview / Offer / Rejected / Withdrawn.
- Each card shows fit score, next action, deadline, stakeholder status, artifact readiness.
- Timeline view shows all upcoming interviews, follow-ups, and tasks.
- Analytics show conversion by source, role family, resume variant, outreach strategy.

### Key features

- Status normalization.
- Custom pipeline stages.
- Tasks and reminders.
- Activity log.
- Attach artifacts and notes.
- Confirmation capture.
- Email/calendar sync optional.
- Dedupe and merge applications.
- Bulk status updates.
- Weekly review report.

### Automation support

- Auto-create application record when a job is saved or imported.
- Auto-update status when confirmation email is detected.
- Remind if no follow-up after N days.
- Detect stale applications.
- Generate weekly retrospective: sources, conversion, bottlenecks, next experiments.

### Agent integration

```bash
jobos applications create --job job_123 --profile pm-edtech
jobos applications update app_123 --status applied --note "Submitted via Greenhouse"
jobos tasks due --today --json
jobos review weekly --profile pm-edtech --json
```

MCP:

- `create_application`
- `update_application_status`
- `list_tasks`
- `create_task`
- `weekly_review`

---

## 8. Browser extension and autofill

### What it looks like

A browser companion like Teal/Huntr/Simplify, but connected to the local/self-hosted JobOS backend.

On a job page, the extension can:

- Save job.
- Extract posting fields.
- Detect ATS.
- Show fit score.
- Show whether a tailored resume exists.
- Autofill standard fields from approved profile data.
- Suggest answers from approved answer bank.
- Capture confirmation after submission.

### Key features

- One-click save from job boards and company ATS pages.
- Job extraction with fallback manual correction.
- Autofill profile fields.
- Application question detection.
- Draft answer insertion with citation/approval status.
- Dry-run mode.
- Confirmation screenshot and URL capture.
- Local API connection.

### Automation support

- Agents can launch browser automation in dry-run mode.
- Human reviews filled forms before submit.
- Optional policy-based auto-submit for low-risk, high-confidence forms only.

### Agent integration

```bash
jobos browser open --job job_123 --mode dry-run
jobos apply dry-run --job job_123 --browser chrome --json
jobos apply submit --job job_123 --require-approved-artifacts
jobos apply capture-confirmation --job job_123
```

MCP:

- `prepare_application_form`
- `run_apply_dry_run`
- `capture_application_confirmation`

---

## 9. Interview preparation and debriefs

### What it looks like

For every interview stage, the app generates a packet:

- Interviewer briefs.
- Company/role refresh.
- Likely questions.
- STAR stories mapped to competencies.
- Questions to ask.
- Compensation and negotiation context.
- Notes and debrief after interview.

### Key features

- Story bank with STAR/SCAR/behavioral examples.
- Role-specific interview simulations.
- Interviewer research.
- Calendar integration.
- Debrief template.
- Feedback loop into resume/story bank.
- Negotiation scripts and offer comparison.

### Automation support

- 24-hour pre-interview packet generation.
- Morning-of briefing.
- Post-interview debrief reminder.
- Follow-up thank-you draft.
- Negotiation prep after offer stage.

### Agent integration

```bash
jobos interview prep --application app_123 --stage recruiter-screen --json
jobos interview questions --job job_123 --stakeholder person_456
jobos interview debrief --application app_123 --notes debrief.md
jobos negotiation packet --offer offer_123
```

MCP:

- `create_interview_packet`
- `generate_mock_questions`
- `record_interview_debrief`
- `create_negotiation_packet`

---

## 10. Analytics and learning loops

### What it looks like

A dashboard that answers:

- Which sources produce high-fit jobs?
- Which resume variants get responses?
- Which role families convert?
- Where does the funnel stall?
- What criteria need recalibration?
- Which outreach approaches produce replies?

### Key features

- Funnel metrics by source, role type, location, company stage.
- Response rate and interview rate.
- Resume variant performance.
- Outreach performance.
- Time spent per application.
- Weekly review and suggested experiments.
- Exportable reports.

### Automation support

- Weekly digest.
- Monthly retrospective.
- Suggest search strategy changes.
- Identify stale companies/contacts.
- Update preference weights based on user feedback.

### Agent integration

```bash
jobos analytics funnel --profile pm-edtech --since 30d --json
jobos analytics sources --metric interview_rate
jobos review weekly --send-to markdown
jobos experiments suggest --profile pm-edtech
```

MCP:

- `get_funnel_metrics`
- `get_source_performance`
- `get_variant_performance`
- `suggest_experiments`
- `generate_weekly_review`

---

## Automation model

### Automation levels

Each workflow should support policy levels:

1. **Manual:** user triggers everything.
2. **Suggest:** agent recommends actions but does not create artifacts.
3. **Draft:** agent creates internal drafts/artifacts.
4. **Internal auto-update:** agent updates internal state, tasks, statuses.
5. **Stage:** agent prepares external actions (filled forms, queued messages) but does not submit/send.
6. **External auto-action:** agent can apply/send only under explicit constraints.

Levels are ordered by increasing risk: everything through level 4 touches only internal state; levels 5-6 involve external side effects and default to requiring approval.

### Scheduled jobs to support

- `daily-discovery`: run saved searches and queue high-fit roles (early morning, so the priority brief has fresh data).
- `morning-priority-brief`: summarize today's top actions.
- `followup-watch`: list due follow-ups and draft messages.
- `company-watch`: refresh news for active applications.
- `interview-prep`: generate packet before scheduled interviews.
- `stale-application-check`: identify applications with no updates.
- `weekly-retrospective`: summarize metrics and suggest experiments.
- `profile-improvement`: detect missing proof points or weak answer-bank entries.

### Example schedule config

```yaml
automations:
  daily_discovery:
    schedule: "0 7 * * 1-5"
    action: discover.run_saved_searches
    profile: pm-edtech
    create_review_queue: true
    external_side_effects: false

  followup_watch:
    schedule: "0 9 * * 1-5"
    action: outreach.list_due_and_draft
    require_approval_to_send: true

  interview_prep:
    trigger: calendar.event_with_tag("interview") - 24h
    action: interview.create_packet
```

---

## Agent harness integration design

## CLI contract

Every command should support:

- `--json` for machine-readable output.
- Idempotency keys for side-effecting actions.
- `--dry-run` for actions with external effects.
- `--profile` to choose target persona.
- `--workspace` for multi-user/self-hosted mode.
- Exit codes that distinguish validation errors, missing approvals, transient failures, and completed actions.

Example:

```bash
jobos jobs list --status new --min-fit 4 --json
jobos tailor resume --job job_123 --profile pm-edtech --json
jobos outreach draft --stakeholder person_456 --job job_123 --json
jobos apply dry-run --job job_123 --json
```

## REST/OpenAPI

Expose everything through documented endpoints so Hermes/Codex can call the app from scripts.

Example resources:

- `/api/profiles`
- `/api/jobs`
- `/api/applications`
- `/api/artifacts`
- `/api/stakeholders`
- `/api/outreach`
- `/api/automations`
- `/api/approvals`
- `/api/audit-log`

## MCP tools

MCP should be first-class for agent tools:

```text
search_jobs
import_job_url
list_jobs
get_job
score_job_fit
create_tailored_resume
draft_cover_letter
create_company_dossier
find_stakeholders
draft_outreach
list_due_followups
create_interview_packet
update_application_status
request_approval
```

## Webhooks

Useful events:

- `job.created`
- `job.scored`
- `artifact.created`
- `application.status_changed`
- `followup.due`
- `interview.scheduled`
- `approval.requested`
- `automation.failed`

## File layout for agent-readable workspaces

```text
jobos-workspace/
  profiles/
    pm-edtech.yaml
    people-ops.yaml
  proof-points/
    master-proof-library.md
  searches/
    pm-edtech-boston.yaml
  jobs/
    job_123/
      job.yaml
      description.md
      score.md
      company-dossier.md
      stakeholders.md
      artifacts/
        resume-tailored.md
        resume-tailored.pdf
        cover-letter.md
      application.yaml
      outreach/
        thread_789.yaml
      tasks.yaml
      audit.log.jsonl
  exports/
    weekly-review-2026-07-02.md
```

This makes the app readable to any agent even if the web server is unavailable.

---

## Recommended build strategy

### MVP 0: schema + CLI + local files

Goal: make agents useful immediately.

Build:

- Profile schema.
- Job import from URL/text/CSV.
- Local workspace file layout.
- Fit scoring command.
- Tailored resume/cover-letter command.
- Application tracker commands.
- Markdown artifact output.

Do not build yet:

- Browser extension.
- Auto-submit.
- Complex dashboards.

### MVP 1: web dashboard + SQLite/Postgres

Build:

- Kanban/table tracker.
- Job detail pages.
- Artifact diff/review/approval UI.
- Resume/proof library editor.
- Basic analytics.
- REST/OpenAPI.

### MVP 2: discovery adapters + scheduler

Build:

- JobSpy or Ever Jobs integration.
- Greenhouse/Ashby/Lever importers.
- Saved searches.
- Daily discovery.
- Weekly review.
- Follow-up reminders.

### MVP 3: research and outreach

Build:

- Company dossier pipeline.
- Stakeholder map.
- Outreach draft/follow-up CRM.
- Gmail/Calendar optional integration.
- Approval queues.

### MVP 4: browser extension + autofill dry-run

Build:

- Save job from browser.
- Extract job page fields.
- Autofill standard profile fields.
- Suggest application answers.
- Capture submission confirmation.
- Dry-run automation.

### MVP 5: advanced agent operations

Build:

- MCP server.
- Webhooks.
- Agent run audit UI.
- Multi-agent batch processing.
- Custom rubrics and plugins.
- Policy-controlled auto-send/apply for advanced users.

---

## What to steal or reuse later

- **Ever Jobs:** discovery plugin architecture, REST/GraphQL/CLI/MCP surfaces, ATS source adapters.
- **JobSpy:** Python scraping library for early discovery MVP.
- **Career-Ops:** agent-native file workflows, scoring/evaluation blocks, batch CLI worker philosophy, dashboard/TUI patterns, interview prep and negotiation artifacts.
- **Resume Matcher / ResumeLM:** resume builder UX, scoring/keyword panels, PDF templates, multi-provider LLM support.
- **Resume Tailor:** small clean CLI/local/web pattern, Notion/MCP logging idea, anti-fabrication prompt rule.
- **ApplyPilot:** staged pipeline, `doctor`, worker flags, dry-run apply mode.
- **JobSync:** self-hosted tracker/dashboard, task and activity logging, progress analytics.
- **OpenOutreach / Sales Outreach LangGraph:** stakeholder discovery, qualification, CRM updates, personalized outreach, feedback loops.
- **Company Research Agent:** multi-agent research pipeline (analyzer/scanner/curator/editor nodes), relevance thresholds, async long-running jobs — the direct template for the module 5 dossier pipeline.
- **jobspy-mcp-server:** minimal MCP-wrapper pattern (stdio + SSE transports, JSON/CSV output) as a reference for our own MCP server design.
- **Mautic / Email-automation:** scheduled follow-up workflow concepts, template variables, suppression rules.
- **Twenty:** CRM objects/views/logic as code if a programmable CRM foundation is preferred.
- **Teal/Huntr/Simplify:** browser extension capture, autofill, automatic tracking, contacts/interviews/metrics, clean consumer UX.

**Licensing caveat:** ApplyPilot and ResumeLM are AGPL-3.0, AIHawk is AGPL-3.0, and OpenOutreach is GPLv3. From those projects, reuse *patterns and architecture only* — do not copy code unless we accept copyleft obligations. MIT/Apache references (Career-Ops, JobSpy, Ever Jobs, jobspy-mcp-server, Resume Tailor, JobSync, Resume Matcher) are safe to reuse directly.

---

## Risks and compliance guardrails

Cautions from the research that must be designed in, not bolted on:

1. **Scraping and platform ToS.** LinkedIn/Indeed/Glassdoor scraping is ToS-sensitive and brittle (see JobSpy, AIHawk, OpenOutreach cautions). Prefer direct ATS APIs and official feeds; keep scrapers as clearly-labeled optional adapters the user opts into, with rate limits.
2. **Account risk from automation.** LinkedIn automation can get user accounts restricted. Outreach automation should draft, not send, on LinkedIn; email sending only via the user's own connected account with caps.
3. **Auto-apply hazards.** Duplicate submissions, wrong screening answers, and reputational damage (ApplyPilot/AIHawk lessons). Auto-submit stays policy-gated, idempotency-keyed, audited, and off by default.
4. **ATS-score myths.** Keyword/ATS checks are advisory heuristics, not guarantees — never let scoring pressure the user into keyword-stuffing or fabrication (Resume Matcher/Jobscan caution).
5. **Fabrication.** The evidence-grounding rule is a hard constraint at the generation layer (Resume Tailor's anti-fabrication rule), not just a UI flag.
6. **Sensitive data.** Compensation, immigration status, demographics, and DEI answers get stricter handling: local-only by default, excluded from logs/telemetry, explicit consent before any cloud model sees them.

---

## Gaps this app should solve better than existing tools

1. **Agent-native by default:** not just a web app with AI features; a system agents can operate safely.
2. **Full lifecycle:** one opportunity workspace from discovery through offer/debrief.
3. **Stakeholder intelligence:** hiring-team and network research as first-class, not an afterthought.
4. **Evidence-grounded documents:** no unsupported resume claims or hallucinated outreach personalization.
5. **Progressive automation:** not manual-only and not reckless auto-apply.
6. **Local-first privacy:** usable on a laptop/VPS without sending all career data to a SaaS.
7. **Machine-readable state:** CLI JSON, MCP, OpenAPI, webhooks, files, audit logs.
8. **Learning loop:** outcomes improve preferences, scoring, search queries, and artifacts over time.
9. **Reusable answer bank:** verified answers for repetitive application questions.
10. **Quality networking:** researched, low-volume outreach with reminders and relationship memory.

---

## Example end-to-end workflow

### Daily automated run

1. Scheduler runs saved searches at 7am.
2. Discovery imports 120 jobs.
3. Deduper reduces to 73 unique jobs.
4. Fit scorer selects 12 above threshold.
5. Research module creates lightweight dossiers for top 5.
6. Hermes receives/reads a morning brief:
   - Top 5 roles.
   - Why they fit.
   - Missing information.
   - Suggested next actions.

### Human review

1. User marks 3 roles as worth applying.
2. App generates tailored resume and cover letter drafts.
3. User reviews diff and evidence panel.
4. User approves final artifacts.

### Agent-assisted application

1. Hermes runs `jobos apply dry-run --job job_123`.
2. Browser automation fills the form but does not submit.
3. App flags two screening questions needing user input.
4. User answers once; answer bank saves approved response.
5. User submits manually or approves submit.
6. App captures confirmation and updates status.

### Relationship workflow

1. Stakeholder finder identifies likely hiring manager and two alumni.
2. Agent drafts short, specific outreach messages.
3. User edits/approves one message.
4. Follow-up scheduled for five business days.
5. If interview scheduled, follow-up pauses and interview prep starts.

### Weekly learning loop

1. App summarizes application funnel.
2. Notes that roles from direct company boards convert better than broad job boards.
3. Suggests new saved searches and target companies.
4. Identifies weak proof points for a recurring requirement.

---

## Concrete next steps for prototyping

1. **Create a workspace schema** in YAML/JSON for profiles, jobs, applications, artifacts, stakeholders, and automations.
2. **Build the CLI skeleton** with JSON output and dry-run/idempotency patterns.
3. **Implement manual job import** from URL/text and a simple `jobs list` / `applications update` flow.
4. **Add fit scoring** using a user-editable rubric.
5. **Add source-grounded tailoring** that outputs Markdown first, then PDF later.
6. **Add company dossier generation** using web search/extraction and citations.
7. **Add a local web dashboard** only after the CLI/data model feels right.
8. **Integrate JobSpy or Ever Jobs** for discovery.
9. **Expose MCP tools** once 5-8 CLI operations are stable.
10. **Add browser extension/autofill** after the data model, approval model, and answer bank are stable.

---

## Minimal prototype command set

```bash
# Setup
jobos init
jobos profile create pm-edtech --from-resume resume.pdf

# Import and score
jobos jobs import-url "https://company.com/careers/job123" --profile pm-edtech
jobos score job_123 --profile pm-edtech --json

# Research and tailor
jobos research company --job job_123 --json
jobos tailor resume --job job_123 --profile pm-edtech --output markdown
jobos tailor cover-letter --job job_123 --profile pm-edtech --output markdown

# Track and outreach
jobos applications create --job job_123 --status materials-ready
jobos research stakeholders --job job_123
jobos outreach draft --job job_123 --stakeholder person_456
jobos tasks due --json

# Automation
jobos automation create daily-discovery --schedule "0 7 * * 1-5" --search pm-edtech
jobos review weekly --profile pm-edtech --output markdown
```

---

## Final recommendation

Build **JobOS** as a local-first, agent-native job-search command center rather than a resume builder or auto-apply bot alone.

The strongest initial wedge is:

> **A CLI + workspace + web dashboard that imports jobs, scores fit against user profiles, creates evidence-grounded application packets, tracks applications, and exposes every operation to agents.**

That wedge is immediately useful for a technical job seeker using Hermes/Codex today, while still expandable into a general-purpose app for non-technical users through web UI, browser extension, templates, and guided onboarding.

---

## Audit changelog (2026-07-03, Claude Code review)

Audited against `job-application-ai-app-research-notes.md`. Changes made and why:

1. **Added `Task`, `OutreachThread`, and `Offer` to the canonical data model.** The research notes' prototype schema (implication #1) lists OutreachThread and Task as canonical entities, and the doc's own CLI/MCP surfaces already referenced them (`--thread thread_789`, `jobos negotiation packet --offer offer_123`, `list_tasks`) without defining them. Agents can't operate on undefined entities.
2. **Reordered automation levels 4 and 5** (internal auto-update now before stage). The ladder is meant to be ordered by risk; updating internal state is lower-risk than staging external actions. Added an explicit note that levels 5-6 are where external side effects begin.
3. **Aligned product principle 5 wording with the automation-model ladder.** It previously used a different, partially overlapping list ("suggest-only, draft-only, dry-run…"), which would cause naming drift in implementation.
4. **Added MCP tools to module 10 (Analytics).** Every other module listed MCP tools; analytics only had CLI, which contradicted the "every important UI action is also an MCP operation" principle.
5. **Renamed `nightly-discovery` → `daily-discovery`** (scheduled jobs list, YAML example, CLI example, MVP 2). It was scheduled at 7am weekdays — not nightly — and the example workflow describes a 7am run.
6. **Added Company Research Agent and jobspy-mcp-server to "What to steal or reuse later."** Both are load-bearing references in the research notes (the module 5 dossier pipeline is modeled directly on Company Research Agent) but were missing from the reuse list.
7. **Added a licensing caveat to the reuse list.** The research notes flag AGPL (ApplyPilot, ResumeLM, AIHawk) and GPLv3 (OpenOutreach) explicitly; the reuse list recommended these projects with no copyleft warning.
8. **Added a "Risks and compliance guardrails" section.** The research notes repeatedly caution about scraping ToS, LinkedIn account risk, auto-apply hazards, ATS-score myths, fabrication, and sensitive-data handling; the design doc had scattered mitigations but no consolidated commitments.
9. **Extended the workspace file layout** with `outreach/` and `tasks.yaml` per job, matching the newly canonical entities so file-based agents see the same model as the API.

Noted but deliberately not changed:

- **AIHawk correctly excluded** from the reuse list (archived, brittle) — consistent with the research notes.
- **Heading levels:** "Main app modules" and the numbered modules share the `##` level; harmless in rendering, left as-is to avoid churn.
- **MVP sequencing** already matches the research implications (extension after core model, autofill/dry-run last, never first).
