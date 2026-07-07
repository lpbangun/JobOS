# JobOS Agent Guide

Date: 2026-07-07

JobOS is a local-first, agent-native job application operating system. Treat the CLI as the primary control surface, use `--json` for commands you need to parse, and inspect `jobos-workspace/` files when Markdown/YAML context is useful.

## Safety Rules

- Do not submit applications, send outreach, scrape private accounts, or perform external side effects.
- Generated resumes, cover letters, research dossiers, interview prep packets, and outreach drafts require human review.
- Application status `applied` is manual tracking only.
- Research outputs are worksheets with sources and uncertainty; do not invent company or stakeholder facts.

## Global Contract

- Workspace selection: `--workspace <dir>` overrides `JOBOS_HOME`; otherwise JobOS uses the current directory.
- First successful command in an empty workspace creates `.jobos/` and `jobos-workspace/`.
- Machine output: pass `--json`; streaming commands emit one JSON object per line.
- Diagnostics go to stderr.
- Exit codes: `0` success, `1` runtime/domain error, `2` usage error.
- JSON errors use this stderr shape:

```json
{"ok":false,"error":{"code":"usage_error","type":"usage","message":"Missing --profile <profile-id>"}}
```

## Command Inventory

Run `jobos agent-guide --json` for the generated registry. Current command families:

- `jobos profile create <name> --json`
- `jobos proof add --profile <profile> --summary <text> --json`
- `jobos jobs import-text --profile <profile> --file <path> --json`
- `jobos jobs import-url <url> --profile <profile> --json`
- `jobos jobs list --json`
- `jobos searches create <name> --profile <profile> --adapter greenhouse|lever --json`
- `jobos discover run --search <name-or-id> --json`
- `jobos score <job-id> --profile <profile> --json`
- `jobos tailor resume --job <job-id> --profile <profile> --json`
- `jobos tailor cover-letter --job <job-id> --profile <profile> --json`
- `jobos applications create --job <job-id> --status <status> --json`
- `jobos applications update <application-id> --status <status> --json`
- `jobos research company --job <job-id> --json`
- `jobos research stakeholders --job <job-id> --json`
- `jobos outreach draft --job <job-id> --stakeholder <stakeholder-id> --profile <profile> --json`
- `jobos interview prep --application <application-id> --stage <stage> --json`
- `jobos analytics funnel --profile <profile> --json`
- `jobos tasks due --json`
- `jobos tasks due --watch --max-iterations 1 --json`
- `jobos automation list --json`
- `jobos automation run <name> --json`
- `jobos scheduler run-once --json`
- `jobos runs list --json`
- `jobos loop scheduler --max-iterations 1 --json`
- `jobos loop automation <name> --max-iterations 1 --json`
- `jobos loop action <action-id> --max-iterations 1 --json`

## Minimal Flow

```bash
jobos agent-guide --json
jobos profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json
jobos jobs import-text --profile pm-edtech --file samples/job-description.md --json
jobos jobs list --json
jobos score <job-id> --profile pm-edtech --json
jobos tailor resume --job <job-id> --profile pm-edtech --json
jobos applications create --job <job-id> --status materials-ready --json
jobos tasks due --json
jobos loop scheduler --max-iterations 1 --json
```

## Workspace Files

SQLite is canonical for dashboard/API queries, but agents may read:

- `jobos-workspace/profiles/*.yaml`
- `jobos-workspace/proof-points/*.md`
- `jobos-workspace/jobs/<job-id>/job.yaml`
- `jobos-workspace/jobs/<job-id>/description.md`
- `jobos-workspace/jobs/<job-id>/score.md`
- `jobos-workspace/jobs/<job-id>/artifacts/*.md`
- `jobos-workspace/jobs/<job-id>/company-dossier.md`
- `jobos-workspace/jobs/<job-id>/stakeholders.md`
- `jobos-workspace/automations/automations.yaml`
- `jobos-workspace/automations/runs-YYYY-MM-DD.jsonl`

Workspace files are mirrors. Use CLI/API/MCP writes instead of hand-editing runtime state.
