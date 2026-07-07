# JobOS CLI-Primary Frontend Plan

Date: 2026-07-07

## Target Grammar

Canonical grammar is `jobos <noun> <verb> [object] [flags]`. Legacy commands remain as aliases for one sprint when renamed.

Command tree:

```text
jobos init
jobos agent-guide
jobos profile create <name>
jobos proof add
jobos jobs import-text
jobos jobs import-url
jobos jobs list
jobos jobs dedupe
jobos searches create
jobos searches list
jobos watchlist add
jobos watchlist list
jobos discover run
jobos discover run-all
jobos score <job-id>
jobos tailor resume
jobos tailor cover-letter
jobos applications create
jobos applications update
jobos research company
jobos research stakeholders
jobos research add-stakeholder
jobos outreach draft
jobos interview prep
jobos analytics funnel
jobos tasks due
jobos review weekly
jobos automation create
jobos automation list
jobos automation enable
jobos automation disable
jobos automation run
jobos scheduler run-once
jobos scheduler start
jobos scheduler status
jobos runs list
jobos loop scheduler
jobos loop automation <name>
jobos loop action <action-id>
jobos mcp
jobos web
```

Legacy note: `jobos score <job-id>` stays for compatibility even though `jobs score <job-id>` would be more noun-first. A future sprint can add `jobs score` as an alias and deprecate direct `score`.

## Global Flags

| Flag | Purpose |
| --- | --- |
| `--workspace <dir>` | Overrides `JOBOS_HOME` and current directory for local state. |
| `--profile <id>` | Selects profile where a command needs one. |
| `--json` | Writes machine-readable JSON to stdout. Streaming commands write JSONL. |
| `--quiet` | Suppresses non-essential diagnostics such as first-run bootstrap notices. |
| `--help` | Prints root or command-specific help from the registry. |

Config precedence:

1. Command flags
2. Environment variables such as `JOBOS_HOME` and LLM provider settings
3. Current working directory defaults

## Output Contract

- Human output goes to stdout.
- Machine output goes to stdout with `--json`.
- Diagnostics and bootstrap notices go to stderr.
- JSON errors go to stderr when `--json` is set.
- Artifact/report commands may print Markdown for humans with `--output markdown`, but `--json` wins and returns metadata.
- Streaming commands use one JSON object per line.

Baseline JSON envelope patterns:

```json
{"ok":true,"id":"..."}
```

```json
{"ok":false,"error":{"code":"usage_error","type":"usage","message":"Missing --profile <profile-id>"}}
```

Command-specific JSON remains intentionally plain arrays/objects for backwards compatibility, but new agent guide schemas describe each result shape.

## Exit Codes

| Code | Meaning |
| ---: | --- |
| `0` | Success. |
| `1` | Runtime or domain error, such as missing records, provider failure, or scheduler lock contention. |
| `2` | Usage error, such as unknown command or missing required flag/argument. |

## Command Registry

`src/cli.js` owns a command registry with:

- command path
- summary
- usage
- global/local flags
- JSON support marker
- output schema summary
- handler test marker

The registry is used to generate root help, per-command help, `agent-guide`, and completeness tests. MCP/API metadata can be cross-checked against the same command list in later sprints; Sprint 9 keeps existing API and MCP behavior stable.

## Built-In Loop Design

Commands:

```text
jobos loop scheduler [--interval N] [--max-iterations N] [--json]
jobos loop automation <name> [--interval N] [--max-iterations N] [--json]
jobos loop action <action-id> [--profile <id>] [--config JSON] [--interval N] [--max-iterations N] [--json]
jobos tasks due --watch [--interval N] [--max-iterations N] [--json]
```

Semantics:

- `loop scheduler` delegates to `runDueAutomations()`.
- `loop automation` delegates to `runAutomationByName()`.
- `loop action` runs an ephemeral scheduler automation record through `runAutomation()` so action behavior remains centralized.
- `--max-iterations` bounds the loop for agents and tests.
- `--interval` is seconds between iterations; default is `60`.
- Ctrl-C stops before the next iteration and releases scheduler locks through existing scheduler cleanup.
- `--json` streams JSONL events:

```json
{"type":"loop.iteration","iteration":1,"targetType":"scheduler","target":"scheduler","startedAt":"...","finishedAt":"...","result":{}}
```

## Agent Onboarding

`jobos agent-guide` prints a compact guide for external agents. `docs/AGENT_GUIDE.md` contains the same stable contract:

- global rules
- command inventory
- JSON/JSONL output expectations
- exit codes
- human-gated safety policy
- workspace files agents may inspect
- end-to-end non-interactive example flow

## Completion Criteria For Sprint 9

- Audit, options, plan, agent guide, and eval docs exist.
- Help comes from the command registry.
- Every registered command has JSON support metadata and targeted coverage in Sprint 9 tests.
- First command in an empty workspace creates `.jobos/` and `jobos-workspace/`.
- Usage errors exit `2`; runtime errors exit `1`; JSON errors have stable object shape.
- `jobos loop ...` and `tasks due --watch` support `--max-iterations`.
- Smoke runs from a fresh empty directory without an explicit `init`.
