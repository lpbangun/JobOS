# AGENTS.md - JobOS development notes

This file gives coding agents the project-specific context needed to make safe, useful changes without rereading the whole spec.

## Project overview

JobOS is a local-first, agent-native job application operating system MVP. It helps a job seeker manage profiles, proof points, jobs, fit scoring, tailored draft artifacts, applications, tasks, research worksheets, and weekly reviews.

The product principle to preserve: agents may draft, score, summarize, and stage work, but external actions stay human-gated.

## Stack and commands

- Runtime: Node.js 22+ with ESM (`"type": "module"`).
- Main implementation: `src/cli.js`.
- Database: `sql.js` writing `.jobos/jobos.sqlite`.
- Agent-readable mirror: `jobos-workspace/` YAML/Markdown/JSONL files.
- Local dashboard: Node `http`, no frontend build step.
- Tests: Node's built-in test runner.

Common commands:

```bash
npm install
npm test
npm run smoke
npm run jobos -- init --json
npm run web -- --port 4317
```

Use targeted checks first. For meaningful behavior changes, run `npm test`; for end-to-end CLI/dashboard behavior, run `npm run smoke`.

## Important files

- `README.md` - user-facing install, quick start, CLI contract, safety policy, and current limitations.
- `src/cli.js` - CLI parser, schema/migrations, persistence, workspace sync, scoring, tailoring, research worksheets, weekly review, and web server.
- `tests/cli.test.js` - targeted behavioral tests.
- `scripts/smoke.js` - end-to-end local smoke check.
- `BUILD_PROGRESS.md` - implementation status, verification log, and known limitations.
- `ideal-agent-native-job-application-app.md` - broader product vision; do not treat every future idea there as already in MVP scope.

## Runtime state

Do not commit or hand-edit generated runtime state unless a task explicitly asks for fixture data:

- `.jobos/`
- `jobos-workspace/`

SQLite is canonical for dashboard queries. Workspace files are regenerated on writes so agents and humans can inspect state without a running server.

## Product invariants

Preserve these unless the user explicitly changes the product direction:

1. Local-first and privacy-first. No telemetry, cloud sync, or required API keys for the core flow.
2. No auto-apply, auto-submit, auto-send, private-account scraping, or irreversible external actions.
3. Generated resume and cover-letter artifacts remain drafts needing human review.
4. Tailoring must use stored proof points; never invent accomplishments or unverifiable claims.
5. Research commands create honest worksheets, not fabricated company or stakeholder facts.
6. Most successful CLI commands should support parseable `--json` output where practical.
7. Validation failures should exit non-zero with a clear `jobos:` error.

## Implementation guidance

- Prefer small, boring changes that keep the single-file MVP understandable. Split `src/cli.js` only when a change clearly benefits from modules.
- Keep CLI behavior deterministic and local. Avoid adding LLM calls, paid APIs, browser automation, or network dependencies unless requested.
- When adding a command, update the README CLI contract and add a targeted test or smoke coverage.
- Keep generated Markdown/YAML useful for agents: stable headings, explicit IDs, and source/evidence references.
- Avoid concurrent write-heavy flows; `sql.js` is portable but not a native SQLite/WAL setup.
- Use workspace selection consistently: `JOBOS_HOME` or `--workspace`.

## Common gotchas

- This project intentionally uses `sql.js`, not native `sqlite3`.
- The dashboard and CLI read/write the same local database.
- URL import is best-effort and human-initiated. If fetch fails, record the URL/manual-enrichment path instead of pretending success.
- Application status `applied` is manual tracking only; JobOS does not submit applications.
- Runtime paths are ignored by git; tests/smoke scripts should create their own temporary workspaces.

## Before yielding

For non-trivial changes, report:

- What changed.
- Which commands or scenarios were verified.
- Any known limitation or blocker that remains.

Do not present scaffolding, stubs, or mock integrations as complete product behavior.
