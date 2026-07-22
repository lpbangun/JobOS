# JobOS Agent Guide

JobOS is a local-first CLI for job discovery, networking, and application preparation. Treat the CLI as the write surface, prefer `--json`, and inspect `jobos-workspace/` when Markdown/YAML context is useful. Run `jobos agent-guide --json` for the current generated command registry and schemas; it is authoritative over this overview.

## Contract

- Workspace selection: `--workspace <dir>` overrides `JOBOS_HOME`; otherwise JobOS uses the current directory.
- A successful command in an empty workspace creates `.jobos/` and `jobos-workspace/`.
- Machine output: pass `--json`; streaming commands emit one JSON object per line.
- Diagnostics go to stderr.
- Exit codes: `0` success, `1` runtime/domain error, `2` usage error.
- JSON errors have `{ "ok": false, "error": { "code", "type", "message" } }`.
- Select a registered local agent with `--agent <name>` or `JOBOS_AGENT`; the flag wins. Explicit agent failures never fall back silently.
- SQLite is canonical. Use CLI/MCP writes instead of hand-editing runtime mirrors.

## Safety

- Never invent claims, accomplishments, company facts, stakeholders, contact details, or external-action receipts.
- Tailoring and answer drafts must trace to stored proof-point IDs.
- Research claims require public source URLs and explicit uncertainty.
- Sensitive/restricted application answers require direct user input; do not infer them.
- External actions default off. They may run only through a connector or browser script the user explicitly configured and enabled.
- Browser scripts are trusted unsandboxed Node.js. A side-effecting script additionally requires the per-run `--allow-side-effects` flag.
- Never print or mirror browser cookies, storage state, API keys, or other credentials.
- Do not bypass CAPTCHA or claim a send/submission succeeded without the configured tool's result.

## Primary workflow

```bash
jobos profile create "PM EdTech" --from-resume samples/resume-proof-points.md --json
jobos searches create "Portfolio" --profile pm-edtech --adapter portfolio --url https://example.vc/portfolio --json
jobos daily --profile pm-edtech --json
jobos jobs list --json
jobos pursue <job-id> --profile pm-edtech --json
jobos network paths --job <job-id> --json
```

`daily` runs all saved discovery sources for one profile, isolates source failures, deduplicates, and ranks results. `discover run-all` is the advanced raw runner for callers that need per-search results without the daily workflow's cross-run dedupe and combined ranking. `pursue` composes score, research, contact discovery, reusable/proof-grounded application answers, resume and cover-letter drafts, application tracking, and outreach preparation. `--dry-run` returns its graph without writes or network calls; `--stage <name>` runs one stage plus dependencies. Full reachable-network mapping remains the standalone `network paths` operation.

Prefer `pursue` for the first end-to-end pass. Standalone score, research, tailoring, application, and outreach commands intentionally run only their operation. The `loop ...` commands are bounded JSONL primitives for agents and test harnesses; use `scheduler start` or `scheduler run-once` for human-operated background automation.

## Extension surfaces

```bash
jobos agents list --json
jobos agents test codex --json
jobos browser status --json
jobos mcp
```

Generic agents receive one protocol-v1 JSON request on stdin and must emit exactly one JSON object on stdout. MCP exposes `daily_discovery`, `pursue_job`, and `answers_match` plus lower-level domain tools. Authenticated browser state stays only in `.jobos/browser/`; it is credential material and never part of the workspace mirror.

## Agent-readable files

SQLite is canonical. Useful mirrors include:

- `jobos-workspace/profiles/*.yaml`
- `jobos-workspace/proof-points/*.md`
- `jobos-workspace/profiles/*-answers.yaml`
- `jobos-workspace/searches/*.yaml`
- `jobos-workspace/discovery/runs/*.yaml`
- `jobos-workspace/jobs/<job-id>/job.yaml`
- `jobos-workspace/jobs/<job-id>/score.md`
- `jobos-workspace/jobs/<job-id>/research/*`
- `jobos-workspace/jobs/<job-id>/artifacts/*`
- `jobos-workspace/jobs/<job-id>/outreach/*`
- `jobos-workspace/automations/*`
- `jobos-workspace/audit.log.jsonl`

Browser profiles, cookie files, and registered browser scripts are deliberately absent from the mirror.
Workspace files are mirrors. Use CLI/MCP writes instead of hand-editing runtime state.
