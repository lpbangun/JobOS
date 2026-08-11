---
name: jobos
description: Local-first JobOS job-search operating system -- discover roles, score fit, research companies/people, tailor drafts from proof points, track applications, and prepare outreach. Use when the user pastes a job description or URL, asks to score or pursue a role, manage profiles/proofs, run daily discovery, draft resume/cover materials, prepare interviews, or connect Claude Code / Codex / other agents to JobOS.
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[doctor | connect | daily | pursue | score | research | network | tailor | answers | applications | tracker | interview | memory | tui | mcp | help]"
license: MIT
---

# jobos -- Router

JobOS is a local-first job application OS. SQLite under `.jobos/` is canonical; `jobos-workspace/` is the agent-readable mirror. Prefer `jobos … --json` or the `jobos` MCP tools. Never invent accomplishments, company facts, contacts, or submission receipts.

## Invocation Notes

- Claude Code: open this repo and use `/jobos` (or ask in plain language). Headless: `claude -p "…"`.
- Codex: open this repo with `codex`. Slash commands are not guaranteed — ask by mode name. Headless: `codex exec "…"`.
- First-time MCP wiring: `node src/cli.js agents connect claude` or `… connect codex` (or installed `jobos agents connect …`).
- Authoritative command/tool registry: `node src/cli.js agent-guide --json`.

## Codex / Claude prompt examples

```text
Connect JobOS MCP for this workspace and list available jobos tools.
Run JobOS daily discovery for my active profile and summarize new roles.
Pursue job <id> with JobOS and show score, research gaps, and draft status.
Score this JD against my JobOS profile (paste or path).
Show JobOS application tracker / due follow-ups.
Draft interview prep for the selected JobOS job using stored proof points only.
```

## Mode Routing

| Input | Mode |
|-------|------|
| (empty) / `help` | Show this menu + point at `docs/AGENT_GUIDE.md` |
| `doctor` | `node src/cli.js agents doctor --json` |
| `connect` | `node src/cli.js agents connect <claude\|codex\|…> --json` |
| `mcp` | Ensure MCP registered; use jobos MCP tools for domain work |
| JD text/URL with no sub-command | **`pursue` / import+score path** (see Auto) |
| `daily` | Daily discovery for the active profile |
| `pursue` | End-to-end pursue for a job id |
| `score` | Fit score only |
| `research` | Company/people research worksheets |
| `network` | Network paths / contact discovery |
| `tailor` | Resume/cover drafts from stored proof points |
| `answers` | Application answers grounded in proofs |
| `applications` / `tracker` | Application status and follow-ups |
| `interview` | Interview prep from Career Memory / proofs |
| `memory` | Career Memory inspect / propose (human gates apply) |
| `tui` | Tell the user to run `node src/cli.js tui` for the primary product surface |

**Auto detection:** If `$mode` is not a known sub-command and looks like a JD (URL or responsibilities/requirements text), import or attach the job, then score/pursue rather than inventing a resume.

## Safety (non-negotiable)

- Tailor and answer only from stored proof-point IDs; never fabricate claims.
- Research must cite sources or mark uncertainty; no invented stakeholders.
- External apply/send stays off unless the user configured and enabled connectors.
- Human-only gates (approve artifact, attest sent/applied, restricted answers) are CLI/TUI — not agent-attestable via MCP.
- Prefer MCP/`--json` CLI over hand-editing `jobos-workspace/` mirrors.

## Preferred tools / commands

High-level MCP (when connected): `daily_discovery`, `pursue_job`, `answers_match`, plus lower-level domain tools from `agent-guide`.

CLI equivalents:

```bash
node src/cli.js agents doctor --json
node src/cli.js agents connect codex --json
node src/cli.js agents connect claude --json
node src/cli.js profile list --json
node src/cli.js daily --profile <id> --json
node src/cli.js jobs list --json
node src/cli.js pursue <job-id> --profile <id> --json
```
