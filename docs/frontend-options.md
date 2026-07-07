# JobOS Frontend Architecture Options

Date: 2026-07-07

## Research Patterns From Exemplar CLIs

The relevant CLI UX patterns are stable across `git`, `gh`, `kubectl`, Claude Code-style agent CLIs, and clig.dev guidance:

- Prefer predictable command grammar: noun groups with verbs (`jobs list`, `applications update`) and a small number of legacy verb aliases where needed.
- Make every workflow scriptable: flags instead of required prompts, stdout for primary output, stderr for diagnostics, stable exit codes.
- Support machine output intentionally: `--json` for structured output, JSONL for streams, and stable field names.
- Generate help from a command registry so docs, completion, agent guides, API/MCP metadata, and tests do not drift.
- Separate human and machine rendering: concise tables/Markdown for people, schemas and IDs for agents.
- Use config precedence that agents can reason about: command flags > environment (`JOBOS_HOME`) > current directory defaults.
- Make long-running behavior explicit and bounded when requested: `--watch`, `--interval`, `--max-iterations`, Ctrl-C cleanup.
- Treat shell completion as a registry product rather than handwritten docs.
- Preserve human approval gates for external side effects.

## Option A: CLI-Primary, Web Companion

Description: The CLI is the canonical frontend. The web dashboard reads/writes the same local SQLite state for review, local editing, kanban movement, and artifact approval. API and MCP remain integration surfaces generated or cross-checked against the command registry where feasible.

Evaluation:

| Criterion | Rating | Notes |
| --- | --- | --- |
| Human testability of every feature | High | Every feature can be run directly from a terminal and asserted in tests. |
| Agent connectability | High | Any agent with shell access can call `jobos ... --json`; MCP remains an optional native protocol. |
| Maintenance cost | Low/Medium | A registry adds structure without requiring a frontend build stack. |
| Cross-OS story | Strong | Node CLI, `sql.js`, and filesystem workspace work across Linux/macOS/Windows. |
| Safety model | Strong | Human-gated external actions stay visible in command outputs and artifacts. |

Risks:

- Human users who dislike terminals may need a richer dashboard later.
- CLI grammar cleanup must preserve backwards-compatible aliases for at least one sprint.

## Option B: TUI-First

Description: Build a full terminal UI as the main frontend while keeping the CLI commands behind it.

Evaluation:

| Criterion | Rating | Notes |
| --- | --- | --- |
| Human testability of every feature | Medium | Good for keyboard users, but harder to script and snapshot reliably. |
| Agent connectability | Medium/Low | Agents can drive TUIs, but it is brittle compared with direct commands. |
| Maintenance cost | Medium/High | Adds stateful rendering, keybindings, layout, and terminal compatibility. |
| Cross-OS story | Medium | Terminal behavior varies across Windows terminals, SSH, CI, and agent sandboxes. |
| Safety model | Strong if backed by CLI | Approval gates can be visible, but must still map to command actions. |

Risks:

- A TUI can become another special-case surface and weaken the agent-native invariant.
- Automated evals become more expensive and less deterministic.

## Option C: Web-First With CLI Wrapper

Description: Build the browser dashboard as the main UX and route CLI commands through local API calls.

Evaluation:

| Criterion | Rating | Notes |
| --- | --- | --- |
| Human testability of every feature | High for browser users | Good for inspection-heavy workflows and artifact review. |
| Agent connectability | Medium | Agents can call APIs, but need server lifecycle management and route docs. |
| Maintenance cost | High | Requires more UI state, routing, accessibility, and browser test coverage. |
| Cross-OS story | Medium | Localhost is portable, but browsers/server lifecycle introduce more moving parts. |
| Safety model | Strong if carefully gated | Human gates are visible, but API write permissions need ongoing scrutiny. |

Risks:

- The CLI wrapper can become second-class, violating the sprint requirement that every feature be shell-drivable.
- More work shifts into UI behavior before product traction proves a GUI is the highest leverage path.

## Decision

Choose Option A: CLI-primary with the web dashboard as a companion.

Rationale:

- The current code already has the strongest coverage in CLI commands, with API/MCP/web catching subsets.
- A CLI is the only surface equally usable by humans, tests, and arbitrary external agents without requiring browser automation or a running server.
- The Hermes-style path is appropriate here: harden the command substrate first, then layer a richer GUI later over the same registry/contracts.
- The sprint's hard constraints map directly to CLI primitives: `--json`, exit codes, non-interactive flags, workspace bootstrap, loops/watch modes, JSONL events, and generated agent documentation.

The evidence does not contradict the CLI-primary hypothesis. It narrows the dashboard's role: review, local editing, and visual status, not full workflow ownership.
