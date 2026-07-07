# JobOS local-first MVP

JobOS is a local-first, agent-native job application operating system MVP. It provides a CLI, a SQLite-backed local data store, an agent-readable workspace, direct public ATS discovery adapters, an audited automation scheduler, provider-backed LLM fit scoring/tailoring/interview prep with deterministic degraded-mode fallback, evidence-grounded Markdown artifact drafts, application tracking with status history, funnel analytics, weekly review automation, an interactive local web dashboard, REST API endpoints, and an MCP stdio server for agent integrations.

The implementation deliberately does **not** auto-apply to jobs, submit forms, send outreach, scrape private accounts, or require paid APIs.

## Stack

- Node.js 22+
- `sql.js` for a file-backed SQLite database at `.jobos/jobos.sqlite`
- `cheerio` for human-initiated HTML/job-page parsing
- Provider-backed LLM calls through OpenAI-compatible, Ollama Cloud, or Anthropic chat APIs
- YAML/Markdown/JSONL workspace mirror at `jobos-workspace/`
- Node `http` local dashboard; no build step
- Node's built-in test runner

`sql.js` is used instead of a native SQLite binding because the workstation does not have a system `sqlite3` binary and this keeps install/runtime portable.

## Install

```bash
npm install
```

No API keys or cloud accounts are required for the offline core flow. To enable LLM scoring and tailoring, set `JOBOS_LLM_PROVIDER` (`openai`, `ollama-cloud`, or `anthropic`), `JOBOS_LLM_MODEL`, and `JOBOS_LLM_API_KEY`. `JOBOS_LLM_BASE_URL` is optional for OpenAI-compatible local/fake/test endpoints. Without credentials, JobOS clearly marks scoring and tailoring as deterministic degraded mode.

Optional workspace selection:

```bash
export JOBOS_HOME=/path/to/private/jobos-root
# or pass --workspace /path/to/private/jobos-root on any command
```

## Quick start

```bash
# Any successful command auto-creates the local DB and agent-readable workspace.
# init remains available for explicit setup or path inspection.
npm run jobos -- init --json
npm run jobos -- agent-guide --json

# Create a profile and import proof points from a local resume/proof file
npm run jobos -- profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json

# Import a job description from text
npm run jobos -- jobs import-text --profile pm-edtech --file samples/job-description.md --json

# Create and run a saved public-ATS discovery search
npm run jobos -- searches create "Acme Discovery" --profile pm-edtech --adapter greenhouse --board-token acme --keywords product,learning --location remote --min-fit 70 --json
npm run jobos -- discover run --search "Acme Discovery" --json
npm run jobos -- jobs dedupe --json

# List imported jobs
npm run jobos -- jobs list --json

# Score the imported job; replace <job-id> with the ID from import/list
npm run jobos -- score <job-id> --profile pm-edtech --json

# Create evidence-grounded drafts; both write Markdown artifacts under jobos-workspace/jobs/<job-id>/artifacts/
npm run jobos -- tailor resume --job <job-id> --profile pm-edtech --output markdown
npm run jobos -- tailor cover-letter --job <job-id> --profile pm-edtech --output markdown

# Track the application and create a human review task
npm run jobos -- applications create --job <job-id> --status materials-ready --json
npm run jobos -- applications update <application-id> --status applied --json

# Public web-search-backed research and human-gated outreach drafts
npm run jobos -- research company --job <job-id> --json
npm run jobos -- research stakeholders --job <job-id> --json
npm run jobos -- research add-stakeholder --job <job-id> --source-url https://example.com/person --name "Maya Chen" --text "Source-backed stakeholder context." --json
npm run jobos -- outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile pm-edtech --json

# Due tasks and weekly review
npm run jobos -- tasks due --json
npm run jobos -- interview prep --application <application-id> --stage hiring-manager --output markdown
npm run jobos -- analytics funnel --profile pm-edtech --since 30 --output markdown
npm run jobos -- review weekly --profile pm-edtech --output markdown

# Audited scheduler: defaults are seeded disabled; enable only what you want
npm run jobos -- automation list --json
npm run jobos -- automation enable daily_discovery --json
npm run jobos -- automation enable morning_priority_brief --json
npm run jobos -- scheduler run-once --json
npm run jobos -- scheduler start --interval 60
npm run jobos -- loop scheduler --max-iterations 1 --json
npm run jobos -- tasks due --watch --max-iterations 1 --json

# Local interactive dashboard
npm run web -- --port 4317
# open http://127.0.0.1:4317
# The dashboard includes a kanban board, create/edit forms, and artifact approve/reject UI.
# machine-readable state: http://127.0.0.1:4317/api/state
# REST scaffold examples:
#   GET  /api/profiles
#   GET  /api/jobs
#   GET  /api/searches
#   POST /api/searches/:id/run
#   GET  /api/discovery/runs
#   GET  /api/automations
#   POST /api/automations/:id/run
#   GET  /api/runs
#   POST /api/tasks {"title":"Follow up","priority":"high"}

# MCP server for agents that speak stdio JSON-RPC/MCP framing
npm run jobos -- mcp
```

You can also run the CLI directly after install:

```bash
npx jobos init --json
```

## Implemented CLI contract

- `jobos init`
- `jobos agent-guide`
- `jobos profile create <name> [--from-resume file]`
- `jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b]`
- `jobos jobs import-url <url> --profile <profile>`
- `jobos jobs import-text --profile <profile> --file <path>`
- `jobos jobs list --json`
- `jobos jobs dedupe [--apply]`
- `jobos searches create <name> --profile <profile> --adapter greenhouse|lever [--board-token <token>|--company <handle>] [--keywords a,b] [--location <text>] [--min-fit 70]`
- `jobos searches list`
- `jobos watchlist add --company <company> --adapter greenhouse|lever --board-token <token>|--handle <handle> [--notes <text>]`
- `jobos watchlist list`
- `jobos discover run --search <name-or-id>`
- `jobos discover run-all`
- `jobos score <job-id> --profile <profile> --json`
- `jobos tailor resume --job <job-id> --profile <profile> --output markdown`
- `jobos tailor cover-letter --job <job-id> --profile <profile> --output markdown`
- `jobos applications create --job <job-id> --status <status>`
- `jobos applications update <application-id> --status <status>`
- `jobos research company --job <job-id>`
- `jobos research stakeholders --job <job-id>`
- `jobos research add-stakeholder --job <job-id> --source-url <url> [--name <name>] [--role <role>] [--text <text>|--file <path>]`
- `jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile-id> [--goal informational]`
- `jobos interview prep --application <application-id> --stage <stage> [--output markdown]`
- `jobos analytics funnel --profile <profile-id> [--since 30] [--output markdown]`
- `jobos tasks due --json`
- `jobos review weekly --profile <profile> --output markdown`
- `jobos automation create <name> --action <action-id> --schedule "0 7 * * 1-5" [--profile <profile>] [--enabled]`
- `jobos automation list`
- `jobos automation enable <name>`
- `jobos automation disable <name>`
- `jobos automation run <name>`
- `jobos scheduler run-once`
- `jobos scheduler start [--interval 60]`
- `jobos scheduler status`
- `jobos runs list`
- `jobos loop scheduler [--interval N] [--max-iterations N]`
- `jobos loop automation <name> [--interval N] [--max-iterations N]`
- `jobos loop action <action-id> [--profile <profile>] [--config JSON] [--interval N] [--max-iterations N]`
- `jobos mcp`
- `jobos web [--port 4317]`

Commands are non-interactive and are documented from a command registry that also powers `jobos --help`, per-command help, and `jobos agent-guide`. Most successful commands emit parseable JSON with `--json`; loop/watch commands emit JSONL. Usage errors exit `2`, runtime/domain errors exit `1`, and successes exit `0`. With `--json`, errors are written to stderr as a stable object: `{"ok":false,"error":{"code":"usage_error","type":"usage","message":"..."}}`.

On the first successful command in an empty workspace, JobOS creates `.jobos/` and `jobos-workspace/` automatically and prints a one-line bootstrap notice to stderr unless `--quiet` is set. `init` is optional and remains useful for explicit/custom setup.

## Workspace layout

Runtime state is local to the selected workspace root:

```text
.jobos/
  jobos.sqlite                  # canonical SQLite database
jobos-workspace/
  audit.log.jsonl               # global audit log
  profiles/<profile-id>.yaml
  proof-points/<profile-id>.md
  automations/
    automations.yaml
    scheduler-design.json
    runs-YYYY-MM-DD.jsonl
  searches/
    index.yaml
    <search-id>.yaml
  watchlist/
    index.yaml
    <watch-id>.yaml
  discovery/
    runs/
      <run-id>.yaml
      <run-id>.md
  jobs/<job-id>/
    job.yaml
    description.md
    score.md
    application.yaml
    tasks.yaml
    status history is stored in SQLite and exposed via /api/status_changes
    company-dossier.md
    stakeholders.md
    audit.log.jsonl
    artifacts/
      resume-tailored.md
      cover-letter.md
      interview-prep-<stage>.md
    outreach/
      <stakeholder-id>-informational.md
  exports/
    weekly-review-<profile-id>-<date>.md
    morning-priority-brief-<profile-id>-<date>.md
```

SQLite is canonical for queries and the web dashboard. Workspace files are regenerated on writes so agents can inspect state without running the web server.

## Architecture notes

- `src/cli.js` is now a thin command router. Domain logic lives in modules such as `src/db.js`, `src/profiles.js`, `src/jobs.js`, `src/discovery.js`, `src/discovery/adapters.js`, `src/scoring.js`, `src/tailoring.js`, `src/research.js`, `src/outreach.js`, `src/tracking.js`, `src/interview.js`, `src/analytics.js`, `src/api.js`, `src/mcp.js`, and `src/web.js`.
- The CLI has a command registry that generates root help, per-command help, and `jobos agent-guide`; registry metadata is covered by Sprint 9 tests.
- Discovery supports direct public Greenhouse and Lever API adapters, saved searches, company watchlist entries, client-side keyword/location filtering, dedupe by URL and normalized company/title/location, scored review queue entries, and `automation_runs` records. Network or fixture fetch failures produce failed run records rather than crashing the discovery command.
- The scoring engine uses provider-backed structured LLM JSON when configured. It scores role fit, domain fit, seniority, location/work model, compensation, mission/interest, network access, red flags, overall score, reasoning, and confidence. If no LLM is configured or a call fails, it falls back to clearly marked deterministic degraded mode.
- Tailoring uses provider-backed LLM JSON when configured and only allows claims grounded in stored proof point IDs. If proof points are missing or the LLM returns unsupported mappings, generated Markdown includes evidence warnings and refuses to invent accomplishments.
- Research commands use public web-search results when available, write source URLs into company/stakeholder dossiers, and avoid claiming facts without a source.
- Interview prep creates role/stage-specific packets with likely questions, proof-linked STAR story prompts, questions to ask, company/role refresh, and a human gate. LLM-generated interview packets render stored proof summaries/metrics rather than freeform accomplishment details.
- Analytics uses application status history for stages reached, conversion, source/role-family performance, and stale active-application warnings.
- The scheduler stores disabled default automations in SQLite and mirrors them to `jobos-workspace/automations/automations.yaml`. It supports five-field cron expressions, one-shot `scheduler run-once`, long-running `scheduler start`, sequential execution with a PID guard, failed run recording, failure auto-disable after three consecutive failures, and per-day automation run JSONL. Built-in actions are `daily_discovery`, `followup_watch`, `stale_application_check`, `weekly_retrospective`, and `morning_priority_brief`.
- Built-in loops reuse scheduler machinery: `loop scheduler`, `loop automation <name>`, `loop action <action-id>`, and `tasks due --watch` support `--interval`, `--max-iterations`, and JSONL output for agents.
- The dashboard reads the same SQLite database and exposes `/api/state` for agents or smoke checks. It now supports local create/edit forms, discovery review queue accept/archive actions, kanban status movement, and artifact approve/reject review.
- The REST API includes `GET/POST /api/searches`, `POST /api/searches/:id/run`, `GET /api/discovery/runs`, `GET/POST /api/automations`, `POST /api/automations/:id/run`, and `GET /api/runs` in addition to local CRUD-style core resources.
- The MCP server (`jobos mcp`) exposes core operations to agent clients over stdio JSON-RPC/MCP framing: score_job, tailor_resume, draft_cover_letter, research_company, draft_outreach, create_application, update_application_status, list_tasks, interview_prep, weekly_review, list_saved_searches, search_jobs, import_job_url, list_automations, run_automation, and list_automation_runs.

## Human-gating and safety policy

- No command submits applications, sends messages, posts to job boards, or performs account actions.
- Generated resumes, cover letters, outreach drafts, and interview prep packets are marked `draft_needs_human_review` unless explicitly approved in local state.
- Application status `applied` is manual; JobOS does not capture or fake confirmation.
- URL import is human-initiated. If a URL cannot be fetched, JobOS records the URL and requires manual enrichment instead of failing the whole workspace.
- Discovery adapters use direct public ATS APIs or local fixtures. JobOS does not scrape LinkedIn, Indeed, Glassdoor, private accounts, or ToS-sensitive boards.
- No telemetry or cloud sync exist in the MVP. External LLM calls happen only when the user explicitly configures provider credentials through environment variables.

## Tests and smoke checks

```bash
npm test
npm run smoke
```

Current smoke coverage verifies:

1. Installable Node dependencies.
2. `jobos init` creates DB/workspace.
3. Profile creation with local proof import.
4. Job text import.
5. Fixture-backed saved discovery search run.
6. Scoring JSON, including degraded-mode fallback in smoke and provider-backed LLM behavior in tests.
7. Resume and cover-letter Markdown artifacts.
8. Application create/update and due task listing.
9. Interview prep packet creation.
10. Status-history-backed analytics and weekly review export.
11. Scheduler run-once for a due morning priority brief, AutomationRun row, workspace JSONL, and human-review-gated drafts.
12. Web dashboard startup, discovery/automation section render, interactive shell render, and `/api/state` reading the same local data.
13. MCP tool-list/framing coverage.
14. Route hardening for unknown and traversal-style workspace paths.

## Implemented vs. next steps

Implemented:

- Local SQLite + workspace mirror.
- Core entities: profiles, proof points, companies, jobs, stakeholders schema, applications, artifacts, tasks, automation runs, audit log.
- Discovery entities: saved searches, company watchlist entries, discovery run summaries, high-fit review queue metadata, source history, and last-seen/repost metadata on jobs.
- CLI JSON surfaces for the required MVP commands.
- Modular code foundation under `src/`.
- REST API scaffold with local CRUD-style routes for core entities.
- Structured proof-point import with metrics, skills, source, and metadata fields.
- Expanded profile preferences.
- Provider-backed LLM fit scoring with deterministic degraded-mode fallback.
- Provider-backed, proof-grounded resume and cover-letter drafts with deterministic degraded-mode fallback.
- Web-search-backed company dossiers and stakeholder research with source URLs.
- Human-gated outreach draft artifacts connected to researched stakeholders.
- Manual application tracking.
- Append-only application status history for stage-reached analytics.
- Interview prep packets grounded in stored proof points.
- Funnel analytics and weekly review insights.
- Weekly review automation command.
- Audited automation scheduler with cron parsing, run-once/start/manual trigger commands, disabled seeded defaults, dashboard/API/MCP surfaces, failure auto-disable, and workspace run JSONL.
- Interactive local web dashboard with kanban board, create/edit forms, and artifact approval UI.
- MCP stdio server exposing core operations for agents.
- Greenhouse and Lever public ATS discovery adapters with fixture-backed tests.
- Targeted tests and end-to-end smoke script.

Next steps:

- Extend scoring/tailoring evals against live configured providers, not only OpenAI-compatible fake provider tests.
- Add richer profile preference editing and answer-bank commands.
- Add artifact approval/diff CLI commands; dashboard/API approval already exists.
- Add explicit export archive command; current data is already portable as files plus SQLite.
- Validate `jobos mcp` against a real external MCP client in addition to stdio framing tests.
- Add browser extension/autofill dry-run only after approval model and answer bank mature.

## Specialist handoffs

- Architecture handoff: `.hermes/jobos-mvp-architecture-handoff.md`
- UI/UX handoff: `jobos-dashboard-uiux-handoff.md`
- Advisor review checklist: `jobos-mvp-review-checklist.md`
- Build progress: `BUILD_PROGRESS.md`
