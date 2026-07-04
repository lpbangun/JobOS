# /goal: Finish JobOS — Sprints 4-5 (interview prep, analytics, dashboard, MCP, integration)

You are the conductor in `/home/logani/projects/Job App` on branch `main`. Act as conductor, not a blind coder. Maintain `.tmp/session-state.tmp` and `.tmp/jobos-rebuild-loop-plan.md`. Keep both current.

## Read first

1. `.tmp/session-state.tmp` — current progress (Sprints 1-3 complete)
2. `.tmp/jobos-rebuild-loop-plan.md` — the full loop plan with module targets
3. `AGENTS.md` — project conventions
4. `ideal-agent-native-job-application-app.md` — the product spec (canonical reference)
5. `src/` — current codebase (modular: db.js, profiles.js, jobs.js, scoring.js, tailoring.js, research.js, outreach.js, search.js, tracking.js, analytics.js, api.js, web.js, workspace.js, utils.js, llm.js, cli.js)

## What's already done

- Sprint 1: ✅ Foundation rebuild (modular refactor, REST API scaffold, structured proof points)
- Sprint 2: ✅ LLM scoring + tailoring (provider-backed, 50-point score gap, proof-grounded artifacts)
- Sprint 3: ✅ Research + outreach (web search integration, company dossiers, outreach drafting)

## What remains

### Sprint 4: Interview prep + analytics + dashboard + MCP

1. **Interview prep** (`src/interview.js`): LLM-powered packet generation
   - `interview prep --application <id> --stage <stage>` generates:
     - Role-specific likely interview questions (not generic)
     - STAR stories mapped from proof points to competencies
     - Questions to ask the interviewer
     - Company/role refresh summary
   - Usability bar: packet is useful for actual interview prep, not a blank template
   - Add test coverage

2. **Analytics** (`src/analytics.js`): real funnel metrics
   - `analytics funnel --profile <id> --since <days>` shows conversion by source, stage, role family
   - Weekly review includes real insights, not just counts
   - Add test coverage

3. **Dashboard** (`src/web.js`): upgrade from read-only to interactive
   - Kanban-style application status board
   - Create/edit forms for jobs, applications, proof points
   - Artifact review UI with approve/reject
   - Not just read-only HTML

4. **MCP server** (`src/mcp.js`): stdio transport
   - Tools for all core operations: score_job, tailor_resume, draft_cover_letter, research_company, draft_outreach, create_application, update_application_status, list_tasks, interview_prep, weekly_review
   - Add `jobos mcp` CLI command to start the server

### Sprint 5: Integration + polish + eval

1. **End-to-end smoke**: profile → import → score → research → tailor → track → interview prep → analytics
2. **Full test suite green**
3. **README update** with real usage examples for all commands
4. **All eval cases passing**
5. **Architecture review** by Claude (window: claude) — ask: "Is this usable, not a skeleton?"
6. **Final verification**: every module produces usable output

## How to run the loop

1. Read session state and plan before each sprint.
2. For each sprint: plan the slice → delegate implementation to Droid (window: droid, GLM 5.2) or OpenCode (window: opencode, DeepSeek V4 Pro) → review the diff → run tests → inspect actual output for usability → delegate review to Codex (window: codex) → delegate architecture review to Claude (window: claude) if sprint boundary → commit → update session state.
3. **Never accept worker self-report as proof.** Inspect files/diffs, run tests, read actual output yourself.
4. **One sprint at a time.** Do not start Sprint 5 until Sprint 4 is verified.
5. **Real tool output only.** `npm test` output is evidence. Reading a generated interview packet and confirming it's useful is evidence.
6. **Git commit after every sprint.** Bisectable history.
7. **Update `.tmp/session-state.tmp` after every phase change.**

## Worker delegation

- **Droid (GLM 5.2)**: primary implementer. In tmux window "droid". Give narrow, file-specific tasks via `droid exec -m glm-5.2 "task description"` or interactively. Read the diff after.
- **OpenCode (DeepSeek V4 Pro)**: secondary implementer for parallel tasks. In tmux window "opencode".
- **Codex (GPT-5.5)**: reviewer 1 — code quality. In tmux window "codex". After implementation, send the diff or changed files for review.
- **OMP agent (grok-composer-2.5-fast)**: reviewer 2 — high-level functionality. In tmux window "omp-review". Ask: "Does the implemented feature actually work end-to-end? Would a real job seeker use this output?"
- **Claude (Fable 5 low)**: architecture critic at sprint boundaries. In tmux window "claude". Ask: "Is this a real improvement toward usability? What's the highest-leverage next step?"

## Safety rules

- Do not push to remote. Commit locally only.
- Do not delete or overwrite the spec files.
- Do not commit `.env` or credential files.
- Keep the human-gating principle: no auto-apply, no auto-send.
- Keep the evidence-grounding principle: no unsupported claims in generated artifacts.
- Keep local-first: no telemetry, no cloud sync, LLM calls go through user's own keys.

## Stop conditions

- All Sprint 4 modules produce usable output (not templates/stubs)
- All Sprint 5 integration and eval passes
- `npm test` green
- `npm run smoke` green
- MCP server exposes all core operations
- Dashboard has interactive create/edit, not just read-only
- Claude architecture review confirms: "this is usable, not a skeleton"
- `.tmp/session-state.tmp` shows all 5 sprints COMPLETE

When all stop conditions are met, write a final report in `.tmp/final-report.md` summarizing what was built, what's usable, and what remains.