# /goal: Build JobOS — an agent-native job application operating system

You are working in `/home/logani/projects/Job App`.

The workspace currently contains two research/spec documents:

- `job-application-ai-app-research-notes.md` — research notes on open-source and commercial job-search/resume/outreach/tracking tools.
- `ideal-agent-native-job-application-app.md` — the synthesized ideal app concept.

## Goal

Build a working prototype of **JobOS**, a local-first, agent-native job application operating system for job seekers.

The prototype should be useful immediately to a technical user running Hermes/OMP/Codex/OpenCode and should be extensible toward a general-purpose app later.

## Product direction

Build the first version as a **CLI + local workspace + web dashboard**. Prioritize agent-compatible interfaces and real working flows over polish.

Core principles:

1. Local-first / privacy-first.
2. Agent-native: CLI JSON output, stable commands, files readable by agents.
3. Evidence-grounded generation: no unsupported resume/application claims.
4. Human-in-the-loop by default for external actions.
5. Progressive automation: draft/stage first, auto-send/apply later.
6. Full lifecycle: discovery, scoring, tailoring, research, outreach, tracking, interview prep, analytics.

## Implementation expectations

Start by inspecting the two markdown files. Then design and build the MVP. Do not stop at a plan: create a working artifact and verify it.

Recommended MVP scope:

### 1. Project scaffold

Choose a pragmatic stack suitable for local development. A good default is:

- TypeScript/Node for CLI + web app, or Python if you strongly justify it.
- SQLite for local state.
- Markdown/YAML/JSON export layout for agent-readable workspace files.
- A simple web dashboard.

If choosing a different stack, document why.

### 2. Data model

Implement core entities:

- Profile
- ResumeSource / ProofPoint
- Job
- Company
- Stakeholder
- Application
- Artifact
- Task
- AutomationRun / AuditLog if feasible

Minimum viable schema can be smaller, but it must support the main workflow below.

### 3. CLI

Create a `jobos` CLI with machine-readable output. Minimum commands:

```bash
jobos init
jobos profile create <name>
jobos jobs import-url <url> --profile <profile>
jobos jobs import-text --profile <profile> --file <path>
jobos jobs list --json
jobos score <job-id> --profile <profile> --json
jobos tailor resume --job <job-id> --profile <profile> --output markdown
jobos tailor cover-letter --job <job-id> --profile <profile> --output markdown
jobos applications create --job <job-id> --status <status>
jobos applications update <application-id> --status <status>
jobos tasks due --json
jobos review weekly --profile <profile> --output markdown
```

Use `--json` wherever useful. Commands should be idempotent where possible and produce clear exit codes/errors.

### 4. Workspace/file layout

Create and maintain an agent-readable layout similar to:

```text
jobos-workspace/
  profiles/
  proof-points/
  jobs/<job-id>/
    job.yaml or job.json
    description.md
    score.md
    artifacts/
    application.yaml or application.json
    audit.log.jsonl
  exports/
```

### 5. Fit scoring

Implement a first-pass scoring rubric:

- role fit
- domain fit
- seniority
- location/work model
- compensation if available
- mission/interest
- red flags
- overall score
- reasoning
- confidence

This can use deterministic heuristics first. Add optional LLM hooks only if the local flow still works without API keys.

### 6. Tailoring artifacts

Implement simple source-grounded draft generation:

- Tailored resume markdown
- Cover letter markdown
- Evidence warnings when the system lacks proof points

The first version can use templates and heuristics. If LLM integration is added, keep it optional and document required env vars.

### 7. Company/stakeholder research placeholders

Implement the schema and CLI stubs for research outputs even if deep web research comes later:

```bash
jobos research company --job <job-id>
jobos research stakeholders --job <job-id>
```

The commands should create files/artifacts and be ready for future web/LLM integration.

### 8. Web dashboard

Create a minimal dashboard that can show:

- profiles
- imported jobs
- scores
- application statuses
- artifacts
- tasks / next actions

It does not need to be beautiful, but it should run locally and read from the same data store/workspace.

### 9. Automation design

Implement at least one working scheduled/automation-like command, e.g.:

```bash
jobos review weekly --profile <profile> --output markdown
```

Also include a design note or config shape for future cron/scheduler support.

### 10. Tests and verification

Add realistic sample data and tests/smoke checks. Verify at minimum:

- project installs
- CLI initializes workspace
- sample profile/job can be created/imported
- scoring runs
- tailoring creates markdown artifacts
- application tracking works
- web dashboard starts

Use real command output to verify, not fabricated results.

## Deliverables

By the end, produce:

1. Working code in this project directory.
2. README with setup, usage examples, and architecture notes.
3. CLI verified with sample data.
4. Web dashboard verified to start locally.
5. Clear notes on what is implemented vs next steps.
6. Commit-ready state if this becomes a git repo.

## Important constraints

- Do not silently depend on paid APIs for core functionality.
- Do not implement uncontrolled auto-apply or auto-send in MVP.
- Do not fabricate user claims in generated resumes/cover letters.
- Keep outputs readable and auditable for agents.
- Prefer small, working vertical slices over large incomplete architecture.

## Suggested first actions

1. Read both markdown files.
2. Inspect the current directory.
3. Decide stack and create scaffold.
4. Build the CLI/data model first.
5. Add sample data and smoke tests.
6. Add web dashboard.
7. Run verification commands.
8. Summarize implemented features and remaining work.
