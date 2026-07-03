# JobOS local-first MVP

JobOS is a local-first, agent-native job application operating system MVP. It provides a CLI, a SQLite-backed local data store, an agent-readable workspace, provider-backed LLM fit scoring/tailoring with deterministic degraded-mode fallback, evidence-grounded Markdown artifact drafts, application tracking, weekly review automation, a local web dashboard, and REST API scaffolding for agent integrations.

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
# Initialize local DB and agent-readable workspace
npm run jobos -- init --json

# Create a profile and import proof points from a local resume/proof file
npm run jobos -- profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json

# Import a job description from text
npm run jobos -- jobs import-text --profile pm-edtech --file samples/job-description.md --json

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

# Research worksheet stubs with explicit no-fabrication language
npm run jobos -- research company --job <job-id> --json
npm run jobos -- research stakeholders --job <job-id> --json

# Due tasks and weekly review
npm run jobos -- tasks due --json
npm run jobos -- review weekly --profile pm-edtech --output markdown

# Local dashboard
npm run web -- --port 4317
# open http://127.0.0.1:4317
# machine-readable state: http://127.0.0.1:4317/api/state
# REST scaffold examples:
#   GET  /api/profiles
#   GET  /api/jobs
#   POST /api/tasks {"title":"Follow up","priority":"high"}
```

You can also run the CLI directly after install:

```bash
npx jobos init --json
```

## Implemented CLI contract

- `jobos init`
- `jobos profile create <name> [--from-resume file]`
- `jobos proof add --profile <profile> --summary <text> [--evidence <text>] [--skills a,b]`
- `jobos jobs import-url <url> --profile <profile>`
- `jobos jobs import-text --profile <profile> --file <path>`
- `jobos jobs list --json`
- `jobos score <job-id> --profile <profile> --json`
- `jobos tailor resume --job <job-id> --profile <profile> --output markdown`
- `jobos tailor cover-letter --job <job-id> --profile <profile> --output markdown`
- `jobos applications create --job <job-id> --status <status>`
- `jobos applications update <application-id> --status <status>`
- `jobos research company --job <job-id>`
- `jobos research stakeholders --job <job-id>`
- `jobos tasks due --json`
- `jobos review weekly --profile <profile> --output markdown`
- `jobos web [--port 4317]`

Most successful commands can emit parseable JSON with `--json`. Validation errors exit non-zero and print a clear `jobos:` error message.

## Workspace layout

Runtime state is local to the selected workspace root:

```text
.jobos/
  jobos.sqlite                  # canonical SQLite database
jobos-workspace/
  audit.log.jsonl               # global audit log
  profiles/<profile-id>.yaml
  proof-points/<profile-id>.md
  automations/scheduler-design.json
  jobs/<job-id>/
    job.yaml
    description.md
    score.md
    application.yaml
    tasks.yaml
    company-dossier.md
    stakeholders.md
    audit.log.jsonl
    artifacts/
      resume-tailored.md
      cover-letter.md
  exports/
    weekly-review-<profile-id>-<date>.md
```

SQLite is canonical for queries and the web dashboard. Workspace files are regenerated on writes so agents can inspect state without running the web server.

## Architecture notes

- `src/cli.js` is now a thin command router. Domain logic lives in modules such as `src/db.js`, `src/profiles.js`, `src/jobs.js`, `src/scoring.js`, `src/tailoring.js`, `src/research.js`, `src/tracking.js`, `src/analytics.js`, `src/api.js`, and `src/web.js`.
- The scoring engine uses provider-backed structured LLM JSON when configured. It scores role fit, domain fit, seniority, location/work model, compensation, mission/interest, network access, red flags, overall score, reasoning, and confidence. If no LLM is configured or a call fails, it falls back to clearly marked deterministic degraded mode.
- Tailoring uses provider-backed LLM JSON when configured and only allows claims grounded in stored proof point IDs. If proof points are missing or the LLM returns unsupported mappings, generated Markdown includes evidence warnings and refuses to invent accomplishments.
- Research commands create structured worksheets for future adapters. They do not claim facts that were not imported or verified.
- The dashboard reads the same SQLite database and exposes `/api/state` for agents or smoke checks.

## Human-gating and safety policy

- No command submits applications, sends messages, posts to job boards, or performs account actions.
- Generated resumes and cover letters are marked `draft_needs_human_review`.
- Application status `applied` is manual; JobOS does not capture or fake confirmation.
- URL import is human-initiated. If a URL cannot be fetched, JobOS records the URL and requires manual enrichment instead of failing the whole workspace.
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
5. Scoring JSON, including degraded-mode fallback in smoke and provider-backed LLM behavior in tests.
6. Resume and cover-letter Markdown artifacts.
7. Application create/update and due task listing.
8. Weekly review export.
9. Web dashboard startup and `/api/state` reading the same local data.
10. Dashboard shell navigation render.
11. Route hardening for unknown and traversal-style workspace paths.

## Implemented vs. next steps

Implemented:

- Local SQLite + workspace mirror.
- Core entities: profiles, proof points, companies, jobs, stakeholders schema, applications, artifacts, tasks, automation runs, audit log.
- CLI JSON surfaces for the required MVP commands.
- Modular code foundation under `src/`.
- REST API scaffold with local CRUD-style routes for core entities.
- Structured proof-point import with metrics, skills, source, and metadata fields.
- Expanded profile preferences.
- Provider-backed LLM fit scoring with deterministic degraded-mode fallback.
- Provider-backed, proof-grounded resume and cover-letter drafts with deterministic degraded-mode fallback.
- Company/stakeholder research worksheets.
- Manual application tracking.
- Weekly review automation command.
- Minimal local web dashboard.
- Targeted tests and end-to-end smoke script.

Next steps:

- Extend scoring/tailoring evals against live configured providers, not only OpenAI-compatible fake provider tests.
- Add richer profile preference editing and answer-bank commands.
- Add artifact approval/diff commands.
- Add explicit export archive command; current data is already portable as files plus SQLite.
- Add LLM-powered research, outreach, and interview prep while preserving the deterministic no-key flow.
- Add discovery adapters and scheduler runner with rate limits and approval queues.
- Add browser extension/autofill dry-run only after approval model and answer bank mature.

## Specialist handoffs

- Architecture handoff: `.hermes/jobos-mvp-architecture-handoff.md`
- UI/UX handoff: `jobos-dashboard-uiux-handoff.md`
- Advisor review checklist: `jobos-mvp-review-checklist.md`
- Build progress: `BUILD_PROGRESS.md`
