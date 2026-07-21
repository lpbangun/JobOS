# Goal loop: Find and build the best frontend/UX for JobOS (Sprint 9)

## Context

You are working in the JobOS repo (`/home/logani/projects/Job App`). Read first:

- `ideal-agent-native-job-application-app.md` — the product vision; JobOS is agent-native: every capability must be equally usable by a human and by an external agent (Claude Code, Hermes, OpenClaw, etc.).
- `jobos-dashboard-uiux-handoff.md` — prior UI/UX thinking for the web dashboard.
- `src/cli.js`, `src/web.js`, `src/api.js`, `src/mcp.js`, `src/workspace.js` — the four existing surfaces (CLI, web dashboard, HTTP API, MCP) plus the file workspace. These are the incumbents you are evaluating.
- `BUILD_PROGRESS.md` and `AGENTS.md` — history and conventions.

Working hypothesis (test it, don't just accept it): the primary frontend should be a **full-featured CLI** — like Hermes CLI, which started CLI-only and grew a GUI only after traction — because a CLI is the surface every human can test each feature on directly AND every agent can drive via its own harness. The web dashboard becomes a read-mostly companion, not the primary UX.

## Hard constraints (binding)

- **Agentic-first**: every feature reachable from the CLI with `--json` output, stable exit codes, and non-interactive operation (no prompts that block an agent; interactive prompts allowed only as sugar when a TTY is detected, always with flag equivalents).
- **Loops within the app**: the app itself must offer built-in loops for its tools — e.g. `jobos loop <action> [--interval]` or watch modes that repeatedly run discovery/follow-up/scoring cycles — reusing the Sprint 7 scheduler machinery, not duplicating it.
- **Cross-OS**: everything must run on Linux, macOS, and Windows. No shell-specific hacks, no hardcoded path separators, no native deps. Linux is the primary target — verify there.
- **Auto-workspace**: on first run of any command, the app automatically creates the job-search folder and files (`jobos-workspace/` with profiles, applications, automations, exports, etc.) if absent — no separate mandatory `init` step. `init` remains for explicit/custom setup.
- Human-approval gates from prior sprints stay untouched (no auto-send/auto-apply).

## Goal loop

Work through these goals in order. After each goal: run `npm test`, fix regressions, commit with a clear message, append a dated line to `BUILD_PROGRESS.md`, then proceed. Do not move on with failing tests.

### Goal 1 — Analysis of the current approach
- Audit every command in `src/cli.js` and every feature in `src/web.js`/`src/api.js`/`src/mcp.js`. Produce `docs/frontend-audit.md`: a feature × surface matrix (CLI / API / MCP / web / workspace files), noting gaps, inconsistencies (naming, flags, output formats), features missing `--json`, commands that can block an agent, and anything OS-specific.
- Score the current CLI against a usability rubric you define: discoverability (`--help` quality), consistency, scriptability, agent-drivability, error messages, first-run experience.

### Goal 2 — Research & options
- Study 3–5 exemplar CLIs known for great UX and agent-friendliness (e.g. `gh`, `git`, Hermes CLI, `kubectl`, Claude Code itself) plus the clig.dev guidelines. Extract concrete patterns: noun-verb command grammar, `--json`/`--jq`-style output, exit-code conventions, config precedence, shell completion, TTY-aware output.
- Write `docs/frontend-options.md` comparing at least three architectures: (a) CLI-primary with web as companion, (b) TUI-first, (c) web-first with CLI wrapper. Evaluate each against: human testability of every feature, agent connectability (any agent with shell access can drive it), maintenance cost, cross-OS story. End with a decision and rationale. If the evidence contradicts the CLI-primary hypothesis, say so and justify the alternative.

### Goal 3 — Plan
- Turn the decision into `docs/frontend-plan.md`: target command grammar (full command tree), global flags (`--json`, `--quiet`, `--profile`, `--workspace`), output contract (human table vs JSON schema per command), error/exit-code convention, deprecation path for any renamed commands (old names alias with warning for one sprint), and the built-in loop design (`jobos loop`/watch mode semantics, how it delegates to the scheduler, ctrl-C behavior, `--max-iterations`, JSONL event output for agents).

### Goal 4 — Implementation
- Restructure the CLI per the plan: consistent noun-verb grammar, `--json` everywhere, stable exit codes (0 success, 1 error, 2 usage), machine-readable errors on stderr as JSON when `--json` is set, `jobos --help` and per-command help generated from one command registry (single source of truth also used to generate MCP tool definitions and API routes where feasible).
- Auto-workspace bootstrap: factor a `ensureWorkspace()` used by every command entry point; creates `jobos-workspace/` structure + default files on first use, idempotent, prints a one-line notice.
- Built-in loops: `jobos loop <automation|action> [--interval N] [--max-iterations N] [--json]` streaming one JSON line per iteration; `--watch` variants where natural (e.g. `jobos tasks due --watch`).
- Cross-OS pass: replace any `path` string concatenation, shell-outs, or POSIX-only assumptions; use `path.join`, `os.homedir()`, Node APIs only.
- Agent onboarding: `jobos agent-guide` command (and `docs/AGENT_GUIDE.md`) that prints a compact machine-oriented description of every command with JSON schemas — the file an external agent (Hermes, OpenClaw, Claude) reads to learn how to drive JobOS.

### Goal 5 — Evals
- `tests/sprint9-frontend.test.js`: command-registry completeness (every registered command has help, `--json`, and a test), exit-code contract, auto-workspace bootstrap in a temp dir, loop iteration/`--max-iterations`, JSON output validity for every command against fixtures, and a Windows-path simulation for workspace paths.
- Agent-usability eval: extend `run_eval.js` with a scripted "blind agent" scenario — starting from only `jobos agent-guide` output, execute an end-to-end flow (bootstrap workspace → add profile → run discovery → review queue → draft outreach → check runs) using only `--json` commands; score each step pass/fail and report ≥ 90% pass.
- Human-usability eval: a checklist in `docs/frontend-eval.md` scoring the rubric from Goal 1 before vs after; every dimension must improve.
- Extend `npm run smoke` to run in a fresh empty directory to prove the auto-workspace path.

## Definition of done

A brand-new user on a clean Linux (or macOS/Windows) machine can run one `jobos` command and get a working workspace automatically; every feature of the app is exercisable and testable from the CLI by a human; any external agent, given only the `agent-guide` output, can drive the full job-search flow non-interactively with `--json`; built-in loops let the app run its own tool cycles; the docs record why this architecture won, so a future GUI (the Hermes path) can be layered on top of the same command registry without rework.
