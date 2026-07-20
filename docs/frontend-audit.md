# JobOS Frontend Surface Audit

Date: 2026-07-07

## Scope

This audit covers the current agent-facing and human-facing JobOS surfaces:

- CLI: `src/cli.js`
- MCP stdio server: `src/mcp.js`
- Agent-readable workspace files: `src/workspace.js` plus module sync writers

The product invariant is that the CLI is the primary frontend because it is directly testable by humans and directly drivable by external agents, with MCP and agent-readable workspace files supporting agent workflows.

## Feature Surface Matrix

| Feature | CLI | MCP | Workspace files | Notes |
| --- | --- | --- | --- | --- |
| Workspace bootstrap | `init`; implicit via `openStore()` on every command | Implicit when MCP starts | `.jobos/`, `jobos-workspace/` | Auto-creation exists, but the CLI did not report first-run bootstrap before Sprint 9. |
| Profile create | `profile create` | Missing | `profiles/<id>.yaml`, proof markdown | CLI supports `--json`. |
| Proof point add | `proof add` | Missing | `proof-points/<profile>.md` | CLI supports flags and deterministic output. |
| Job import from text | `jobs import-text` | Missing | `jobs/<id>/job.yaml`, `description.md` | CLI uses local file input, good for agents. |
| Job import from URL | `jobs import-url` | `import_job_url` | Job workspace files | Human-initiated, best-effort fetch; preserves safety invariant. |
| Job list | `jobs list` | Missing | Job folders | CLI JSON hides internal `jobos:text:` URLs. |
| Job dedupe | `jobs dedupe` | Missing | Job tasks for duplicate review | CLI-only. |
| Saved search create/list | `searches create/list` | `list_saved_searches` | `searches/*.yaml` | CLI covers create/list; MCP covers listing. |
| Discovery run | `discover run`, `discover run-all` | `search_jobs` | `discovery/runs/*.yaml`, job files | CLI/MCP expose run paths. |
| Watchlist | `watchlist add/list` | Missing | `watchlist/*.yaml` | CLI/workspace only. |
| Fit scoring | `score` | `score_job` | `score.md`, job YAML | CLI JSON output exists. |
| Tailored resume | `tailor resume` | `tailor_resume` | `artifacts/resume-tailored.md` | Markdown output is human-friendly; JSON metadata should win when `--json` is present. |
| Cover letter | `tailor cover-letter` | `draft_cover_letter` | `artifacts/cover-letter.md` | Draft only, human gated. |
| Application create/update | `applications create/update` | `create_application`, `update_application_status` | `application.yaml`, `tasks.yaml` | Status `applied` is manual tracking only. |
| Company research | `research company` | `research_company` | `company-dossier.md` | Research worksheet cites public sources or records warnings. |
| Stakeholder research | `research stakeholders` | Missing | `stakeholders.md` | CLI-only except workspace. |
| Pasted stakeholder record | `research add-stakeholder` | Missing | `stakeholders.md`, SQLite stakeholders | Requires a public source URL and records human-provided context without contacting anyone. |
| Outreach draft | `outreach draft` | `draft_outreach` | `outreach/*.md`, artifacts/tasks | Draft-only, never sends. |
| Interview prep | `interview prep` | `interview_prep` | `artifacts/interview-prep-*.md` | CLI/MCP. |
| Funnel analytics | `analytics funnel` | Missing | Export markdown for review | CLI is the canonical report path. |
| Due tasks | `tasks due` | `list_tasks` | `tasks.yaml` per job | CLI lacked watch mode before Sprint 9. |
| Weekly review | `review weekly` | `weekly_review` | `exports/weekly-review-*.md` | CLI/MCP. |
| Automation create/list/enable/disable/run | `automation ...` | `list_automations`, `run_automation` | `automations/automations.yaml` | Scheduler-backed, audited, disabled by default. |
| Scheduler run/status/start | `scheduler run-once/status/start` | `list_automation_runs` | `automations/runs-*.jsonl` | Long-running scheduler exists; agent loop command was missing before Sprint 9. |
| Automation run history | `runs list` | `list_automation_runs` | JSONL run mirror | Good cross-surface coverage. |
| MCP server | `mcp` | N/A | N/A | Stdio JSON-RPC/MCP framing. |

## CLI Gaps And Inconsistencies

- Help was a handwritten string in `src/cli.js`, so command docs, command tests, MCP tool descriptions, and future integrations could drift.
- Some commands advertised `--json` inconsistently. Object outputs were parseable even without `--json`, but artifact/report commands preferred Markdown when `--output markdown` was set.
- Error exits were non-zero but not typed. Usage errors and runtime errors both exited with code `1`; the Sprint 9 contract needs `2` for usage.
- JSON errors existed on stderr with `--json`, but the shape was shallow: `{ok:false,error:"..."}`. Agents benefit from a stable object with code/type/message.
- `init` was documented as the required first step even though `openStore()` already creates the workspace on every command. The first-run experience needed to make auto-bootstrap official.
- No command registry existed to prove every command has usage/help/JSON contract metadata.
- Built-in app loops were split between `scheduler start`, `scheduler run-once`, and automations. There was no explicit `jobos loop ...` command with max-iteration and JSONL semantics for agents.
- `tasks due` had no `--watch` mode.
- The CLI has no interactive prompts, which is good for agents. TTY sugar can be added later as optional wrappers.

## Agent Blocking Audit

No current command blocks on an interactive prompt. Long-running commands are explicit:

- `scheduler start [--interval N]`
- `mcp`

These commands are acceptable because they are explicit long-running modes. Sprint 9 adds bounded loop controls (`--max-iterations`) so agents can run repeated cycles safely.

## OS-Specific Audit

- The implementation mostly uses Node APIs (`path.join`, `path.resolve`, `fs`, `process.env`) and avoids shelling out in product code.
- Tests and smoke scripts use `spawnSync(process.execPath, ['src/cli.js', ...])`, which is cross-OS friendly.
- Runtime paths are generated through `src/utils.js` and `path.join`.
- Workspace paths stored in SQLite/artifacts are relative POSIX-like strings in some content because Markdown/workspace links are human-facing, but filesystem writes resolve them through `path.join`.
- No native SQLite dependency is used; `sql.js` keeps install portable.

## Usability Rubric

Scores are 1 to 5, where 5 means production-grade for a technical local-first CLI.

| Dimension | Before Sprint 9 | Evidence |
| --- | ---: | --- |
| Discoverability | 2 | Root help listed commands, but per-command help and machine-readable command metadata were missing. |
| Consistency | 3 | Most commands used noun/verb groups, but `score <id>` is verb-first and Markdown-vs-JSON behavior varied. |
| Scriptability | 4 | Commands were non-interactive and mostly supported JSON; errors lacked typed exit contracts. |
| Agent-drivability | 3 | CLI/MCP surfaces existed, but there was no `agent-guide`, JSON schema inventory, or loop contract. |
| Error messages | 3 | Human errors were clear (`jobos: ...`), but JSON errors were not typed and usage errors used exit code 1. |
| First-run experience | 3 | Auto-creation already happened, but docs still led with mandatory `init` and no bootstrap notice existed. |

## Audit Conclusion

The evidence supports the sprint hypothesis: the CLI is the broadest and safest frontend. Sprint 9 should harden the CLI contract, document it for agents, and add explicit loops/watch modes, with MCP and workspace files supporting agent workflows.
