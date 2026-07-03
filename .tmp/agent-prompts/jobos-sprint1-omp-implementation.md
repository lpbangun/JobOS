You are OMP GLM 5.2 working in /home/logani/projects/Job App on branch main.

Task: Implement Sprint 1 foundation rebuild only. Do not commit, push, or touch spec files.

Read first:
1. .tmp/jobos-rebuild-loop-plan.md
2. .tmp/session-state.tmp
3. AGENTS.md
4. package.json
5. tests/cli.test.js
6. scripts/smoke.js
7. src/cli.js

Scope:
- Refactor the single-file `src/cli.js` into modules under `src/` while preserving existing CLI behavior and JSON surfaces.
- Add dependency scaffolding for future LLM + parsing work: `cheerio`, `openai`, `@anthropic-ai/sdk`.
- Add a provider-agnostic LLM adapter stub/module that reads `JOBOS_LLM_PROVIDER`, `JOBOS_LLM_MODEL`, `JOBOS_LLM_API_KEY` and returns deterministic degraded-mode metadata when unconfigured. Do not make network calls yet.
- Add structured proof point parsing/storage fields where feasible without breaking existing tests.
- Expand default profile preferences to include role families, industries, stages, locations, salary, dealbreakers, work model, communication style, strategy, and automation policy.
- Add REST API CRUD scaffold beyond GET /api/state for core entities. Keep local-only, human-gated. CRUD can be minimal but real for create/list/read/update where simple.
- Preserve existing smoke/test behavior.

Hard constraints:
- Do not implement Sprint 2 LLM scoring/tailoring yet.
- Do not delete/overwrite `ideal-agent-native-job-application-app.md` or `job-application-ai-app-research-notes.md`.
- No auto-apply, auto-send, telemetry, cloud sync, browser automation, or credential files.
- Do not commit.

Verification to run if you finish:
- npm test
- npm run smoke
- node -e "import('./src/cli.js').then(()=>console.log('cli module loads'))"

Return in the pane: files changed, commands run with output summary, risks/limitations, and anything the conductor should inspect manually.
