# JobOS MVP Architecture Handoff

**Project:** `/home/logani/projects/Job App`  
**Goal:** Local-first, agent-native job application operating system — MVP 0/1 vertical slice.  
**Handoff purpose:** A Task agent must be able to implement the MVP from this document without further product clarification.

---

## 1. Scope & Anchoring Decisions

### 1.1 What is in scope for this handoff

Implement the **CLI + local workspace + web dashboard** wedge described in `ideal-agent-native-job-application-app.md` and `jobos-build-goal.md`.

Required capabilities:

- Initialize and manage a local workspace.
- Create one or more job-search profiles.
- Import jobs from URL or text.
- Store and query jobs, companies, applications, artifacts, tasks, and audit history.
- Score job fit against a profile using deterministic, explainable heuristics.
- Generate source-grounded tailored resume and cover-letter drafts in Markdown.
- Track application statuses and derive tasks/next actions.
- Produce a weekly review report.
- Expose a minimal local web dashboard reading the same SQLite store.
- Log every significant action to an append-only audit log.

### 1.2 Explicit non-goals

- Browser extension.
- Automatic form submission or auto-send of outreach/email.
- Paid API integration as a hard dependency (LLM hooks are optional and gated).
- Multi-user auth, SaaS hosting, Postgres migration.
- Complex ATS adapters beyond basic URL/text import.
- PDF/DOCX export in MVP (Markdown only; PDF is a next-step).

### 1.3 Stack choice

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (Node.js ≥ 20) | Single language for CLI and web dashboard; excellent JSON/YAML/SQLite tooling; agent harnesses read TS/JS easily. |
| CLI framework | `commander` | Stable, idiomatic, supports `--json`, exit codes, subcommands. |
| Database | SQLite via `better-sqlite3` | Local-first, file-backed, zero external service, good concurrent reads for dashboard. |
| Validation | `zod` | Single source of truth for CLI args, DB rows, file schema, API payloads. |
| Templating | `handlebars` | Simple evidence-grounded resume/cover-letter templates. |
| Web server | `express` + static HTML/vanilla JS | Minimal, no build step required for the dashboard in MVP. |
| YAML/JSON | `js-yaml` | Agent-readable file format. |
| IDs | Deterministic slugs where stable; UUID fallback | Idempotency and reproducibility for agents. |

If a future maintainer wants to migrate to Python, the schema and file layout in this document are language-agnostic.

### 1.4 Repo layout

```text
/home/logani/projects/Job App/
  package.json
  tsconfig.json
  .gitignore
  README.md                    # populated during implementation
  src/
    cli/                       # commander command definitions
      init.ts
      profile.ts
      jobs.ts
      score.ts
      tailor.ts
      applications.ts
      tasks.ts
      research.ts
      review.ts
      sync.ts
      index.ts
    core/                      # domain logic; no CLI or HTTP concerns
      config.ts
      id.ts
      errors.ts
    db/                        # SQLite schema, migrations, connection, queries
      schema.ts
      migrate.ts
      connection.ts
      repositories/
        profiles.ts
        jobs.ts
        companies.ts
        stakeholders.ts
        applications.ts
        artifacts.ts
        tasks.ts
        audit.ts
    scoring/                   # fit scoring engine
      rubric.ts
      scorer.ts
    tailoring/                 # artifact generation
      templates.ts
      resume.ts
      cover-letter.ts
      evidence.ts
    sync/                      # SQLite ↔ file layout sync
      export.ts
      import.ts
    web/                       # dashboard server
      server.ts
      routes.ts
      public/
        index.html
        app.js
        style.css
    types/                     # shared Zod schemas + TS types
      index.ts
    audit/                     # audit-log helpers
      logger.ts
    sample/                    # fixtures for smoke tests
      profile.yaml
      job-urls.txt
      job-description.txt
  bin/
    jobos                      # CLI entry shim
  tests/
    smoke.test.ts
    scoring.test.ts
    tailoring.test.ts
```

---

## 2. Workspace & File Layout

The workspace is the directory the user points to with `--workspace` (default: current working directory). All runtime state lives inside `<workspace>/jobos-workspace/`.

```text
<workspace>/
  jobos-workspace/
    .jobos/                        # internal runtime state
      config.yaml                  # active profile, paths, automation policy
      jobos.sqlite                 # canonical structured store
      audit.log.jsonl              # global append-only audit log
    profiles/
      <profile-id>.yaml            # human/editable profile
    proof-points/
      <proof-id>.md                # master proof library entries
    jobs/
      <job-id>/
        job.yaml                   # structured job record (canonical mirror)
        description.md             # full job description
        score.md                   # fit-score report
        company/
          dossier.md               # placeholder in MVP; research stubs create this
        stakeholders.yaml          # placeholder in MVP
        artifacts/
          resume-tailored.md
          cover-letter.md
        application.yaml           # present once an application is created
        tasks.yaml                 # job-specific tasks
        audit.log.jsonl            # per-job audit log (redundant subset of global)
    exports/
      weekly-review-<iso-date>.md
```

### 2.1 File format rules

- All structured records: YAML (human-editable) **and** JSON is accepted on import.
- Long text: Markdown (`description.md`, `*.md` artifacts).
- Audit logs: JSONL, one object per line.
- Proof points: Markdown frontmatter + body.

### 2.2 `.jobos/config.yaml` shape

```yaml
version: 1
active_profile: pm-edtech
automation_level: draft          # one of: manual | suggest | draft | internal-auto
require_approval_for:
  - external_submit
  - external_send
  - sensitive_fields
sync:
  enabled: true
  on_write: true
  format: yaml
```

---

## 3. Data Model

SQLite is the **canonical source of truth** for queries and the web dashboard. Files are a **readable, agent-accessible mirror** that is regenerated on write.

### 3.1 SQLite schema

Use `better-sqlite3` with foreign keys enabled. Migration scripts live in `src/db/migrate.ts`.

```sql
-- profiles
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  preferences_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  communication_style TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- proof points (linked to a profile, but reusable)
CREATE TABLE proof_points (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id),
  category TEXT NOT NULL,         -- skill, project, metric, story, answer
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_links TEXT,             -- JSON array of {url, description}
  tags TEXT,                       -- JSON array of strings
  allowed_claims TEXT,             -- JSON array of strings
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- companies
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  stage TEXT,
  size TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- jobs
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  company_name TEXT NOT NULL,
  url TEXT,
  source TEXT,                     -- url | text | manual
  location TEXT,
  work_model TEXT,                 -- remote | hybrid | onsite | unknown
  seniority TEXT,
  role_family TEXT,
  department TEXT,
  description TEXT,
  compensation_json TEXT,          -- {min, max, currency, period, equity}
  requirements TEXT,               -- Markdown list
  fit_score_json TEXT,           -- cached latest score
  status TEXT DEFAULT 'new',       -- new | saved | researching | materials_ready | applied | ...
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- stakeholders
CREATE TABLE stakeholders (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  job_id TEXT REFERENCES jobs(id),
  name TEXT,
  role TEXT,
  channel TEXT,
  relevance TEXT,
  links TEXT,                      -- JSON array
  research_summary TEXT,
  created_at TEXT NOT NULL
);

-- applications
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL,
  resume_artifact_id TEXT,
  cover_letter_artifact_id TEXT,
  notes TEXT,
  confirmation_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- artifacts
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  application_id TEXT REFERENCES applications(id),
  type TEXT NOT NULL,              -- tailored_resume | cover_letter | dossier | outreach_draft | interview_packet
  format TEXT NOT NULL,            -- markdown
  content TEXT NOT NULL,
  evidence_warnings TEXT,          -- JSON array of {claim, status, proof_ids}
  model_used TEXT,                 -- null in MVP unless optional LLM is configured
  approved BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- follow_up | prep | research | apply | review | admin
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',      -- open | snoozed | done | cancelled
  priority TEXT,
  due_date TEXT,
  job_id TEXT REFERENCES jobs(id),
  application_id TEXT REFERENCES applications(id),
  stakeholder_id TEXT REFERENCES stakeholders(id),
  artifact_id TEXT REFERENCES artifacts(id),
  created_by TEXT,               -- user | automation | agent
  created_at TEXT NOT NULL
);

-- automation runs
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,           -- command | schedule | webhook
  action TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id),
  inputs_json TEXT,
  outputs_json TEXT,
  status TEXT NOT NULL,            -- queued | running | succeeded | failed | needs_approval
  started_at TEXT,
  finished_at TEXT,
  logs TEXT
);

-- audit logs
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,             -- user | cli | agent | automation
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT,
  inputs_json TEXT,
  outputs_json TEXT,
  approval_status TEXT             -- n/a | pending | approved | rejected
);
```

### 3.2 File schema (YAML examples)

#### `profiles/<profile-id>.yaml`

```yaml
id: pm-edtech
name: PM EdTech
slug: pm-edtech
preferences:
  role_families: [Product Manager]
  industries: [EdTech, WorkTech]
  company_stages: [seed, series_a, series_b]
  locations: [Boston, "New York", "San Francisco", Remote]
  work_models: [remote, hybrid]
  salary_band:
    min: 130000
    max: 180000
    currency: USD
    period: yearly
constraints:
  dealbreakers:
    - no_sponsorship
    - full_time_only
  remote_required: false
communication_style: warm-concise
automation_level: draft
created_at: "2026-07-04T12:00:00Z"
updated_at: "2026-07-04T12:00:00Z"
```

#### `jobs/<job-id>/job.yaml`

```yaml
id: job_abc123
title: Senior Product Manager
company_id: cmp_exampleco
company_name: ExampleCo
url: https://example.com/careers/senior-pm
source: url
location: Remote US
work_model: remote
seniority: senior
role_family: Product Manager
department: Product
requirements: |
  - 5+ years PM experience
  - EdTech or B2B SaaS background
  - Strong analytics and experimentation
compensation:
  min: 140000
  max: 190000
  currency: USD
  period: yearly
status: researching
imported_at: "2026-07-04T12:00:00Z"
updated_at: "2026-07-04T12:00:00Z"
```

#### `jobs/<job-id>/application.yaml`

```yaml
id: app_abc123_pm-edtech
job_id: job_abc123
profile_id: pm-edtech
status: materials-ready
resume_artifact_id: art_abc123_resume
cover_letter_artifact_id: art_abc123_cover
notes: ""
created_at: "2026-07-04T12:00:00Z"
updated_at: "2026-07-04T12:00:00Z"
```

---

## 4. Module Boundaries

Each module owns a single concern. Cross-cutting behavior (audit, sync, errors) is injected via utilities.

| Module | Responsibility | Must NOT do |
|--------|----------------|-------------|
| `src/cli/*` | Parse args, validate with Zod, call core services, print JSON/text, set exit codes. | No direct DB access; no business logic. |
| `src/core/*` | Pure domain logic: ID generation, config loading, error taxonomy. | No CLI or HTTP I/O. |
| `src/db/*` | Connection, migrations, typed repository functions. | No scoring or tailoring logic. |
| `src/scoring/*` | Fit scoring heuristics, rubric resolution, confidence calculation. | No DB writes. Returns a score object. |
| `src/tailoring/*` | Evidence mapping, template rendering, artifact generation. | No external API calls unless optional LLM is configured. |
| `src/sync/*` | Export canonical SQLite rows to files; import files back to SQLite on `sync --import`. | No business logic. |
| `src/web/*` | HTTP routes, static asset serving, dashboard API. | No direct CLI parsing. |
| `src/audit/*` | Append audit events to SQLite and JSONL. | No policy decisions. |
| `src/types/*` | Zod schemas exported as TypeScript types. | No runtime behavior. |

---

## 5. CLI Command Contract

Every command:

- Supports `--workspace <path>` (default: `process.cwd()`).
- Supports `--json` where machine-readable output is useful.
- Returns exit code `0` on success, `1` on validation/error, `2` on missing approval/policy block (reserved), `3` on I/O failures.
- Is idempotent where possible (imports use stable IDs; updates upsert state).
- Writes to the audit log on mutations.

### 5.1 Required command specifications

#### `jobos init [--workspace <path>]`

Creates the workspace directory tree and SQLite DB with migrations.

**Output:**

```text
Created workspace at /home/logani/projects/Job App/jobos-workspace
```

**JSON output (`--json`):**

```json
{
  "success": true,
  "workspace": "/home/logani/projects/Job App/jobos-workspace",
  "created": ["profiles", "proof-points", "jobs", "exports", ".jobos"]
}
```

**Idempotency:** safe to re-run; does not overwrite existing data.

---

#### `jobos profile create <name> [--json] [--workspace <path>]`

Creates a new profile from a name. Slug derived from name (lowercase, spaces → hyphens, non-alphanumeric stripped). If slug exists, returns `409`-style error and existing ID.

**Example:**

```bash
jobos profile create "PM EdTech"
```

**JSON output:**

```json
{
  "id": "prof_pm-edtech",
  "name": "PM EdTech",
  "slug": "pm-edtech",
  "created_at": "2026-07-04T12:00:00Z"
}
```

**Note:** The build goal showed `<name>` without a `--name` flag; keep that contract. Optional future flag `--from-resume <path>` is out of scope for MVP.

---

#### `jobos jobs import-url <url> --profile <profile> [--json]`

Imports a job from a URL. In MVP, this performs a **local parse/heuristic extraction** only (no paid scraping service). It:

1. Normalizes the URL and derives `job_id` deterministically from `sha256(domain + pathname)` truncated to 12 chars, prefixed `job_`.
2. Extracts title/company from URL path, `<title>` tag fallback, or user-corrected later.
3. Creates company row derived from domain.
4. Creates job row with status `new`.
5. Writes `description.md` with the raw URL and a placeholder note.
6. Triggers file sync.
7. Logs audit event `job.imported`.

**If the URL already exists:** return existing job ID and status `200` equivalent; do not duplicate.

**JSON output:**

```json
{
  "id": "job_abc123",
  "title": "Senior Product Manager",
  "company_id": "cmp_exampleco",
  "company_name": "ExampleCo",
  "url": "https://example.com/careers/senior-pm",
  "status": "new",
  "created": false,
  "imported_at": "2026-07-04T12:00:00Z"
}
```

---

#### `jobos jobs import-text --profile <profile> --file <path> [--json]`

Imports a job from a text/Markdown file containing a job description. Derives `job_id` from a hash of the first 1000 characters of normalized text. Extracts title/company using regex heuristics (e.g., first line as title, domain/company from explicit frontmatter).

**JSON output:**

```json
{
  "id": "job_def456",
  "title": "Product Manager",
  "company_name": "Acme Inc",
  "source": "text",
  "status": "new",
  "file": "/path/to/job.md"
}
```

---

#### `jobos jobs list --json [--status <status>] [--min-fit <n>] [--profile <profile>]`

Lists jobs from SQLite. Supports filters. If `fit_score_json` is cached, includes `overall_score` and `confidence`.

**JSON output:**

```json
{
  "jobs": [
    {
      "id": "job_abc123",
      "title": "Senior Product Manager",
      "company_name": "ExampleCo",
      "status": "new",
      "overall_score": 7.2,
      "confidence": 0.6,
      "url": "https://example.com/careers/senior-pm"
    }
  ],
  "count": 1
}
```

---

#### `jobos score <job-id> --profile <profile> --json`

Runs fit scoring heuristics for the job against the profile and caches the result in `jobs.fit_score_json`. Also writes `jobs/<job-id>/score.md`.

**JSON output:**

```json
{
  "job_id": "job_abc123",
  "profile_id": "prof_pm-edtech",
  "overall_score": 7.2,
  "confidence": 0.6,
  "recommendation": "research",
  "dimensions": {
    "role_fit": { "score": 8, "reason": "Title matches role family", "confidence": 0.8 },
    "domain_fit": { "score": 9, "reason": "EdTech keyword found", "confidence": 0.7 },
    "seniority": { "score": 7, "reason": "Senior level", "confidence": 0.6 },
    "location_work_model": { "score": 8, "reason": "Remote US matches preference", "confidence": 0.9 },
    "compensation": { "score": 6, "reason": "Min below band but overlaps", "confidence": 0.4 },
    "mission_interest": { "score": 7, "reason": "No explicit mission conflict", "confidence": 0.5 },
    "red_flags": { "score": 8, "reason": "No red flags detected", "confidence": 0.5 }
  },
  "reasoning": "Strong domain and role fit; compensation data is sparse.",
  "missing_information": ["equity", "benefits", "reporting_structure"]
}
```

**Scoring rubric (1–10 per dimension, weighted):**

| Dimension | Weight | Notes |
|-----------|--------|-------|
| role_fit | 1.25 | Match title/role_family to profile preferences. |
| domain_fit | 1.25 | Industry/sector keyword overlap. |
| seniority | 1.0 | Seniority string match and years-of-experience heuristic. |
| location_work_model | 1.0 | Location and remote/hybrid/onsite preference. |
| compensation | 0.75 | Only scored if data present; otherwise low confidence. |
| mission_interest | 0.75 | Keyword alignment with profile values; low weight in MVP. |
| red_flags | 1.0 | Penalize dealbreakers (e.g., wrong location model, excluded industries). |

Overall = weighted average of dimension scores. Confidence = average of per-dimension confidences, lowered when required fields are missing. Recommendation mapping: `< 4` ignore, `4–5.9` save, `6–7.4` research, `7.5–8.9` apply, `≥ 9` network-first/apply.

---

#### `jobos tailor resume --job <job-id> --profile <profile> --output markdown [--json]`

Generates a tailored resume Markdown artifact using:

1. Profile preferences.
2. Proof points filtered by job requirements keywords.
3. A Handlebars template (`src/tailoring/templates/resume.hbs`).
4. Evidence mapping: each bullet links to `proof_points` IDs.

Writes artifact to `jobs/<job-id>/artifacts/resume-tailored.md` and `artifacts` table with `approved: false`. If no proof points exist, writes evidence warnings and a prominent "NEEDS USER INPUT" block.

**JSON output:**

```json
{
  "artifact_id": "art_job_abc123_resume",
  "job_id": "job_abc123",
  "type": "tailored_resume",
  "format": "markdown",
  "path": "jobos-workspace/jobs/job_abc123/artifacts/resume-tailored.md",
  "evidence_warnings": [
    { "claim": "Led analytics-driven experimentation", "status": "supported", "proof_ids": ["pp_analytics_1"] },
    { "claim": "EdTech PM experience", "status": "needs_user_input" }
  ],
  "approved": false
}
```

---

#### `jobos tailor cover-letter --job <job-id> --profile <profile> --output markdown [--json]`

Same pattern as resume, using `cover-letter.hbs` template. Output to `jobs/<job-id>/artifacts/cover-letter.md`.

**JSON output:**

```json
{
  "artifact_id": "art_job_abc123_cover",
  "job_id": "job_abc123",
  "type": "cover_letter",
  "format": "markdown",
  "path": "jobos-workspace/jobs/job_abc123/artifacts/cover-letter.md",
  "evidence_warnings": [],
  "approved": false
}
```

---

#### `jobos applications create --job <job-id> --status <status> [--profile <profile>] [--json]`

Creates an application linking job and active profile (or `--profile`). Valid statuses: `saved`, `researching`, `materials-ready`, `applied`, `recruiter-screen`, `interview`, `offer`, `rejected`, `withdrawn`, `ghosted`.

Upserts if an application for the same `(job_id, profile_id)` already exists, updating status and `updated_at`. Creates a default task when status changes to `materials-ready` or `applied`.

**JSON output:**

```json
{
  "id": "app_job_abc123_prof_pm-edtech",
  "job_id": "job_abc123",
  "profile_id": "prof_pm-edtech",
  "status": "materials-ready",
  "created": true,
  "updated_at": "2026-07-04T12:00:00Z"
}
```

---

#### `jobos applications update <application-id> --status <status> [--note <text>] [--json]`

Updates application status and optionally appends a note. Logs audit event and creates/updates tasks as needed.

**JSON output:**

```json
{
  "id": "app_job_abc123_prof_pm-edtech",
  "status": "applied",
  "note": "Submitted via Greenhouse",
  "updated_at": "2026-07-04T12:00:00Z"
}
```

---

#### `jobos tasks due --json [--today] [--profile <profile>]`

Returns open tasks, sorted by due date then priority. If `--today`, filter to today or overdue.

**JSON output:**

```json
{
  "tasks": [
    {
      "id": "tsk_job_abc123_apply",
      "type": "apply",
      "title": "Apply to Senior Product Manager at ExampleCo",
      "status": "open",
      "due_date": "2026-07-05",
      "job_id": "job_abc123",
      "application_id": "app_job_abc123_prof_pm-edtech"
    }
  ],
  "count": 1
}
```

---

#### `jobos review weekly --profile <profile> --output markdown [--json]`

Generates a weekly review report:

- Imported jobs this week.
- Scored jobs and top recommendations.
- Applications by status.
- Open tasks.
- Missing proof points (requirements seen multiple times with no proof).
- Suggested next actions.

Writes to `exports/weekly-review-<iso-date>.md`. With `--json`, returns the report metadata and path.

**JSON output:**

```json
{
  "profile_id": "prof_pm-edtech",
  "path": "jobos-workspace/exports/weekly-review-2026-07-04.md",
  "summary": {
    "jobs_imported": 3,
    "jobs_scored": 3,
    "applications": 1,
    "open_tasks": 2,
    "top_recommendations": ["job_abc123"]
  }
}
```

---

#### `jobos research company --job <job-id> [--json]` (placeholder)

In MVP, creates a placeholder dossier file `jobs/<job-id>/company/dossier.md` with a structured template and no external web calls. The file contains sections for product, market, stage, funding, competitors, news, red flags, and interview angles, each marked `TODO: user/agent input`.

**JSON output:**

```json
{
  "job_id": "job_abc123",
  "company_id": "cmp_exampleco",
  "path": "jobos-workspace/jobs/job_abc123/company/dossier.md",
  "status": "placeholder"
}
```

---

#### `jobos research stakeholders --job <job-id> [--json]` (placeholder)

Creates `jobs/<job-id>/stakeholders.yaml` with a placeholder list (recruiter, hiring manager, team member, alumni) and empty fields for links/relevance. No external lookup in MVP.

**JSON output:**

```json
{
  "job_id": "job_abc123",
  "path": "jobos-workspace/jobs/job_abc123/stakeholders.yaml",
  "stakeholders": [
    { "id": "stk_job_abc123_recruiter", "role": "recruiter" },
    { "id": "stk_job_abc123_hiring_manager", "role": "hiring_manager" }
  ],
  "status": "placeholder"
}
```

---

### 5.2 Optional but recommended commands

- `jobos sync [--export] [--import]` — force file/SQLite reconciliation.
- `jobos config set <key> <value>` — update workspace config.

---

## 6. SQLite / File Sync Strategy

### 6.1 Canonical source of truth

**SQLite is canonical.** All reads from CLI and web dashboard go through the repository layer against `jobos-workspace/.jobos/jobos.sqlite`.

### 6.2 File mirror

Files are a **one-way mirror** from SQLite by default. On every mutating command, after the SQLite transaction commits, the sync layer rewrites the affected YAML/Markdown files for that entity.

Rules:

- One record → one file (profiles, proof-points, job.yaml, application.yaml, tasks.yaml, stakeholders.yaml).
- Long text → Markdown file (description.md, artifacts/*.md, company/dossier.md, exports/*.md).
- Audit → append JSONL to both global and per-job files.
- Sync failures do not fail the command, but they log a warning and an audit event.

### 6.3 Reconciliation

Provide `jobos sync`:

- `--export` (default): rewrite all files from SQLite.
- `--import`: read files and upsert into SQLite. Use for disaster recovery or agent-edited files.

On import, prefer the most recent `updated_at` between file mtime and SQLite row; prompt or skip conflicts unless `--force`.

### 6.4 Web dashboard reads

The dashboard server opens the same SQLite file in read-only or WAL mode. `better-sqlite3` handles concurrent reads safely.

---

## 7. Human-Gating & Audit Policy

### 7.1 Automation levels

Implement four levels in MVP (5 and 6 are explicitly out of scope):

1. **manual** — user triggers every action.
2. **suggest** — agent recommends but does not write state.
3. **draft** — agent creates internal drafts/artifacts only (default).
4. **internal-auto** — agent may update internal state (status, tasks) when explicitly invoked.

Levels 5 (**stage external actions**) and 6 (**external auto-action**) are **not implemented** in MVP. No command sends email, submits forms, or performs browser automation.

### 7.2 Approval model

- Generated artifacts default to `approved: false`.
- Status updates by the user CLI command are considered approved by the invoking user.
- Any future automation that would change `applications.status` to `applied` or create external artifacts must write a `needs_approval` `AutomationRun` and stop.

### 7.3 Audit logging

Every mutating CLI command writes one row to `audit_logs` and one line to `audit.log.jsonl`. Read-only commands do not log by default.

**Audit event shape:**

```json
{
  "timestamp": "2026-07-04T12:00:00Z",
  "actor": "cli",
  "action": "job.import_text",
  "entity_type": "job",
  "entity_id": "job_def456",
  "idempotency_key": "import-text-abc",
  "inputs": { "profile_id": "prof_pm-edtech", "file": "/path/to/job.md" },
  "outputs": { "job_id": "job_def456" },
  "approval_status": "n/a"
}
```

### 7.4 Evidence-grounded generation rule

The tailoring engine must classify every generated claim as one of:

- `supported` — linked to one or more proof points.
- `reframed` — reworded from a proof point.
- `needs_user_input` — no proof point exists.
- `not_allowed` — unsupported claim (e.g., invented metrics). This must be removed from output and flagged.

No fabricated metrics, titles, or achievements.

---

## 8. Web Dashboard

### 8.1 Server

`jobos dashboard [--port 3000] [--workspace <path>]` starts an Express server.

### 8.2 API routes

Return JSON:

- `GET /api/profiles`
- `GET /api/jobs?status=&profile=`
- `GET /api/jobs/:id`
- `GET /api/applications`
- `GET /api/tasks?due=today`
- `GET /api/artifacts/:id`

### 8.3 UI

Minimal static dashboard (`src/web/public/`):

- Top navigation: Profiles, Jobs, Applications, Tasks.
- Jobs table: title, company, status, overall score, recommendation.
- Applications kanban/status list.
- Tasks list with due dates.
- Artifact viewer (read-only Markdown rendering).

No auth, no write UI required in MVP.

---

## 9. Fit Scoring Implementation

`src/scoring/scorer.ts` accepts a `Job` and `Profile` and returns the score object from §5.1.

Guidelines:

- Use simple keyword/regex heuristics; no LLM required.
- Confidence is lowered when required fields are missing (compensation, work_model, seniority).
- Red flags are explicit dealbreakers in the profile (e.g., `no_onsite`, excluded industries).
- Cache the score JSON in `jobs.fit_score_json` and update `jobs.updated_at`.

---

## 10. Tailoring Engine

### 10.1 Evidence mapping

`src/tailoring/evidence.ts`:

- Tokenizes job requirements.
- Searches proof points for matching tags/keywords.
- Returns a ranked list of `(requirement, proof_points[], coverage_status)`.

### 10.2 Templates

Two Handlebars templates:

- `src/tailoring/templates/resume.hbs`
- `src/tailoring/templates/cover-letter.hbs`

Template context includes:

```typescript
{
  profile: Profile,
  job: Job,
  proofPoints: ProofPoint[],
  evidenceMap: EvidenceMap,
  warnings: EvidenceWarning[]
}
```

### 10.3 Optional LLM hook

If an `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` env var is present and `config.llm.enabled` is true, the tailoring engine may use the LLM to rewrite bullets. The LLM **must** receive the evidence map and be instructed to only use supported proof points. The default path works entirely without API keys.

---

## 11. Implementation Order (Vertical Slices)

Build in this order so the system is smoke-testable after each slice:

1. **Repo + CLI skeleton** — `init`, `config`, `sync`, empty command structure.
2. **Database + file layout** — migrations, workspace creation, sync export.
3. **Profiles + proof points** — `profile create`, YAML schema, sample fixtures.
4. **Job import** — `jobs import-url`, `jobs import-text`, `jobs list`.
5. **Fit scoring** — `score`, `score.md`, cached JSON.
6. **Applications + tasks** — `applications create/update`, `tasks due`.
7. **Tailoring** — `tailor resume/cover-letter`, evidence warnings.
8. **Research placeholders** — `research company/stakeholders`.
9. **Weekly review** — `review weekly`.
10. **Web dashboard** — Express server + minimal UI.
11. **Tests + smoke verification** — see §12.

---

## 12. Test Acceptance

Add these tests in `tests/` and run them as part of verification.

### 12.1 Unit tests

- `scoring.test.ts` — score a known job/profile fixture and assert overall score, dimension scores, confidence, and recommendation.
- `tailoring.test.ts` — generate resume/cover letter, assert output contains supported proof, assert warnings for missing proof, assert no fabricated claims.
- `sync.test.ts` — write to SQLite, run sync export, assert file contents round-trip via sync import.

### 12.2 CLI smoke tests

A single `smoke.test.ts` or shell script runs the real CLI in a temp workspace:

```bash
jobos init
jobos profile create "PM EdTech"
jobos jobs import-url "https://example.com/careers/senior-pm" --profile pm-edtech
jobos score <job-id> --profile pm-edtech --json
jobos tailor resume --job <job-id> --profile pm-edtech --output markdown
jobos tailor cover-letter --job <job-id> --profile pm-edtech --output markdown
jobos applications create --job <job-id> --status materials-ready
jobos applications update <application-id> --status applied --note "Test submission"
jobos tasks due --json
jobos research company --job <job-id>
jobos research stakeholders --job <job-id>
jobos review weekly --profile pm-edtech --output markdown
```

Assertions:

- Each command exits `0`.
- JSON output is parseable and contains expected keys.
- Workspace files exist at expected paths.
- Audit log contains one event per mutating command.
- Tailored artifacts contain evidence warning section.

### 12.3 Web dashboard verification

- `npm run dashboard` starts on `http://localhost:3000`.
- `GET /api/jobs` returns imported jobs.
- `GET /api/tasks?due=today` returns expected tasks.
- Static `index.html` loads without errors.

### 12.4 No-API-key verification

Run all smoke tests with no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set. Core functionality must pass.

---

## 13. Non-Goals & Next Steps

### 13.1 Non-goals (do not implement now)

- Browser extension and form autofill.
- Auto-apply, auto-send, or any external side effect beyond local file/DB writes.
- Paid API as a hard dependency.
- PDF/DOCX export.
- Real-time web scraping or ATS APIs.
- Email/Calendar integration.
- MCP server (design only; implement in MVP 2).
- Multi-user auth.

### 13.2 Next steps after MVP

1. **Discovery adapters** — JobSpy/Ever Jobs-style source plugins with rate limits and ToS warnings.
2. **Real company/stakeholder research** — web search + LLM, with citations and red-flag detection.
3. **Outreach CRM** — threads, follow-ups, suppression rules.
4. **Interview prep + negotiation packets**.
5. **MCP server** exposing the core tools to Hermes/Codex.
6. **Browser extension** for one-click job capture and dry-run autofill.
7. **PDF/DOCX export** using templates.
8. **Analytics and learning loops** — funnel metrics, source performance, preference calibration.

---

## Appendix A: Sample Fixture Data

Provide these files in `src/sample/` for tests and demos.

### `src/sample/profile.yaml`

```yaml
id: prof_pm-edtech
name: PM EdTech
slug: pm-edtech
preferences:
  role_families: [Product Manager]
  industries: [EdTech, WorkTech]
  company_stages: [seed, series_a, series_b]
  locations: [Boston, "New York", "San Francisco", Remote]
  work_models: [remote, hybrid]
  salary_band:
    min: 130000
    max: 180000
    currency: USD
    period: yearly
constraints:
  dealbreakers:
    - no_sponsorship
    - full_time_only
  remote_required: false
communication_style: warm-concise
automation_level: draft
```

### `src/sample/proof-points/` (Markdown files with frontmatter)

Example `src/sample/proof-points/pp_edtech_launch.md`:

```markdown
---
id: pp_edtech_launch
category: project
title: Launched analytics dashboard for K-12 EdTech platform
tags: [edtech, analytics, product_management, experimentation]
allowed_claims:
  - "Led analytics-driven experimentation in EdTech"
  - "Improved teacher engagement by 20%"
---
Led a 0→1 analytics dashboard for teachers, resulting in a 20% lift in weekly active users and a 15% reduction in support tickets.
```

### `src/sample/job-description.txt`

Plain text file used by `jobs import-text` smoke test:

```text
Senior Product Manager — ExampleCo

ExampleCo is an EdTech startup building workflow tools for K-12 educators.

We’re looking for a Senior Product Manager to lead our core learning platform.
You will own the roadmap, run experiments, and work closely with engineering and design.

Requirements:
- 5+ years of product management experience
- Background in EdTech or B2B SaaS
- Strong analytics and A/B testing skills
- Experience with remote teams

Location: Remote US
Salary: $140,000–$190,000/year
```

---

## Appendix B: Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Validation / argument / runtime error |
| 2 | Policy / approval block (reserved for future external actions) |
| 3 | I/O or database failure |

---

## Appendix C: Environment Variables

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `JOBOS_WORKSPACE` | Default workspace path | No |
| `OPENAI_API_KEY` | Optional LLM rewrite | No |
| `ANTHROPIC_API_KEY` | Optional LLM rewrite | No |
| `JOBOS_LOG_LEVEL` | `debug` | `info` | `warn` | `error` | No |

No env var is required for the MVP to function.
