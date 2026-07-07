# JobOS Frontend Surface Audit

Date: 2026-07-07

## Scope

This audit covers the current agent-facing and human-facing JobOS surfaces:

- CLI: `src/cli.js`
- REST/local dashboard API: `src/api.js`
- MCP stdio server: `src/mcp.js`
- Web dashboard: `src/web.js`
- Agent-readable workspace files: `src/workspace.js` plus module sync writers

The product invariant is that the CLI is the primary frontend because it is directly testable by humans and directly drivable by external agents. The web dashboard remains a local read-mostly companion with a few safe local write controls.

## Feature Surface Matrix

| Feature | CLI | API | MCP | Web | Workspace files | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Workspace bootstrap | `init`; implicit via `openStore()` on every command | Implicit when web server starts | Implicit when MCP starts | Implicit when web starts | `.jobos/`, `jobos-workspace/` | Auto-creation exists, but the CLI did not report first-run bootstrap before Sprint 9. |
| Profile create | `profile create` | `POST /api/profiles` | Missing | Profile list only; proof form exists | `profiles/<id>.yaml`, proof markdown | CLI supports `--json`; API supports basic create. |
| Proof point add | `proof add` | `POST /api/proofs` | Missing | Add proof form | `proof-points/<profile>.md` | CLI supports flags and deterministic output. |
| Job import from text | `jobs import-text` | `POST /api/jobs` | Missing | Create job form maps to text import | `jobs/<id>/job.yaml`, `description.md` | CLI uses local file input, good for agents. |
| Job import from URL | `jobs import-url` | Missing | `import_job_url` | Missing | Job workspace files | Human-initiated, best-effort fetch; preserves safety invariant. |
| Job list | `jobs list` | `GET /api/jobs` | Missing | Jobs table | Job folders | CLI JSON hides internal `jobos:text:` URLs. |
| Job dedupe | `jobs dedupe` | Missing | Missing | Missing | Job tasks for duplicate review | CLI-only. |
| Saved search create/list | `searches create/list` | `GET/POST /api/searches` | `list_saved_searches` | Search state visible in discovery panel | `searches/*.yaml` | CLI and API cover create/list. |
| Discovery run | `discover run`, `discover run-all` | `POST /api/searches/:id/run`, `GET /api/discovery/runs` | `search_jobs` | Review queue and recent runs | `discovery/runs/*.yaml`, job files | CLI/API/MCP all expose run paths. |
| Watchlist | `watchlist add/list` | Missing | Missing | Missing | `watchlist/*.yaml` | CLI/workspace only. |
| Fit scoring | `score` | Missing direct endpoint | `score_job` | Score visible when state exists | `score.md`, job YAML | CLI JSON output exists. |
| Tailored resume | `tailor resume` | Missing direct endpoint | `tailor_resume` | Artifact review after generation | `artifacts/resume-tailored.md` | Markdown output is human-friendly; JSON metadata should win when `--json` is present. |
| Cover letter | `tailor cover-letter` | Missing direct endpoint | `draft_cover_letter` | Artifact review after generation | `artifacts/cover-letter.md` | Draft only, human gated. |
| Application create/update | `applications create/update` | `POST/PATCH /api/applications` | `create_application`, `update_application_status` | Create form and kanban status update | `application.yaml`, `tasks.yaml` | Status `applied` is manual tracking only. |
| Company research | `research company` | Missing direct endpoint | `research_company` | Read-only guidance | `company-dossier.md` | Research worksheet cites public sources or records warnings. |
| Stakeholder research | `research stakeholders` | Missing direct endpoint | Missing | Read-only guidance | `stakeholders.md` | CLI-only except workspace. |
| Outreach draft | `outreach draft` | Missing direct endpoint | `draft_outreach` | Read-only/gated copy | `outreach/*.md`, artifacts/tasks | Draft-only, never sends. |
| Interview prep | `interview prep` | Missing direct endpoint | `interview_prep` | Artifact review after generation | `artifacts/interview-prep-*.md` | CLI/MCP. |
| Funnel analytics | `analytics funnel` | `/api/state` includes summarized state, not funnel endpoint | Missing | Dashboard summaries only | Export markdown for review | CLI is the canonical report path. |
| Due tasks | `tasks due` | `GET/POST/PATCH /api/tasks` | `list_tasks` | Task list and create form | `tasks.yaml` per job | CLI lacked watch mode before Sprint 9. |
| Weekly review | `review weekly` | Missing direct endpoint | `weekly_review` | Export visible via workspace | `exports/weekly-review-*.md` | CLI/MCP. |
| Automation create/list/enable/disable/run | `automation ...` | `GET/POST/PATCH /api/automations`, run endpoint | `list_automations`, `run_automation` | Automations table and run controls | `automations/automations.yaml` | Scheduler-backed, audited, disabled by default. |
| Scheduler run/status/start | `scheduler run-once/status/start` | `GET /api/runs` for history | `list_automation_runs` | Run history | `automations/runs-*.jsonl` | Long-running scheduler exists; agent loop command was missing before Sprint 9. |
| Automation run history | `runs list` | `GET /api/runs` | `list_automation_runs` | Recent runs table | JSONL run mirror | Good cross-surface coverage. |
| MCP server | `mcp` | N/A | N/A | N/A | N/A | Stdio JSON-RPC/MCP framing. |
| Web dashboard | `web` | Same process | Missing | Full local dashboard | Reads workspace links | Human companion, not primary automation surface. |

## CLI Gaps And Inconsistencies

- Help was a handwritten string in `src/cli.js`, so command docs, command tests, MCP tool descriptions, and future API generation could drift.
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
- `web [--port N]`
- `mcp`

Those commands are acceptable because they are server/daemon modes. Sprint 9 adds bounded loop controls (`--max-iterations`) so agents can run repeated cycles safely.

## OS-Specific Audit

- The implementation mostly uses Node APIs (`path.join`, `path.resolve`, `fs`, `http`, `process.env`) and avoids shelling out in product code.
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
| Agent-drivability | 3 | CLI/API/MCP surfaces existed, but there was no `agent-guide`, JSON schema inventory, or loop contract. |
| Error messages | 3 | Human errors were clear (`jobos: ...`), but JSON errors were not typed and usage errors used exit code 1. |
| First-run experience | 3 | Auto-creation already happened, but docs still led with mandatory `init` and no bootstrap notice existed. |

## Audit Conclusion

The evidence supports the sprint hypothesis: the CLI is already the broadest and safest frontend. The web dashboard is valuable for review and local editing, but it does not and should not become the primary automation surface. The Sprint 9 frontend work should harden the CLI contract, document it for agents, add explicit loops/watch modes, and preserve the dashboard as a companion over the same state.
