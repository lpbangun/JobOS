# JobOS Build Progress

## Status
- 2026-07-02: Repo/spec inspection completed. Initial workspace contained product/research specs and no app scaffold.
- 2026-07-02: MVP stack selected: Node.js CLI + sql.js-backed SQLite file + agent-readable workspace files + local HTTP dashboard. Rationale: works in this empty repo with Node 22/npm available and no system sqlite3 dependency.
- 2026-07-02: Planner, designer, and advisor handoffs completed.
- 2026-07-02: Working MVP scaffold implemented: CLI, SQLite schema, workspace sync, scoring, tailoring, research worksheets, application tracking, weekly review, dashboard, tests, smoke script, README.
- 2026-07-02: Vision UI blocker pass addressed with navigable dashboard shell, route sections, artifact review modal, gate modal, command palette/CLI copy helpers, responsive CSS, accessibility labels, audit/automation state, and route hardening.
- 2026-07-04: Sprint 6 discovery module implemented: Greenhouse/Lever public ATS adapters, saved searches, company watchlist, dedupe/review queue, discovery AutomationRun records, workspace sync, dashboard/API/MCP surfaces, tests, and smoke coverage.
- 2026-07-04: Sprint 7 scheduler implemented: automations table/YAML sync, seeded disabled defaults, cron parser, run-once/start/manual triggers, action registry, audited AutomationRun rows, JSONL run mirror, dashboard/API/MCP surfaces, failure auto-disable, targeted tests, and smoke coverage.
- 2026-07-07: Sprint 9 Goal 1 frontend surface audit completed in `docs/frontend-audit.md`; full test suite rerun passed after one transient API fetch failure passed on targeted rerun.
- 2026-07-07: Sprint 9 Goal 2 frontend architecture options completed in `docs/frontend-options.md`; decision remains CLI-primary with web as a companion after exemplar CLI pattern review.
- 2026-07-07: Sprint 9 Goal 3 CLI-primary frontend plan completed in `docs/frontend-plan.md`, including command registry, exit-code, auto-workspace, loop/watch, and agent-guide contracts.
- 2026-07-07: Sprint 8 Goal 1 approach dossier completed for LLM-grounded research/outreach: search provider recommendation, multi-query dossier pipeline, stakeholder source policy, outreach lifecycle design, and Phase C eval rubric.

## Handoffs
- PlannerSpec: `.hermes/jobos-mvp-architecture-handoff.md`
- DesignerSpec: `jobos-dashboard-uiux-handoff.md`
- AdvisorChecklist: `jobos-mvp-review-checklist.md`
- FinalAdvisor: PASS after targeted checks.
- VisionUICheck: initial BLOCKED; fixes implemented and regate requested.

## Verification log
- `npm install` completed successfully.
- `npm test` passed after Sprint 7: 24/24 Node tests.
- `npm run smoke` passed after Sprint 7: initialized workspace, ran fixture-backed discovery, created profile/job/application, scored/tailored/interview-prepped, generated weekly review, ran due scheduler automation, verified priority brief export, AutomationRun JSONL, dashboard `/api/state`, dashboard shell navigation, and route hardening for unknown/traversal paths.
- Additional URL smoke passed: `jobs import-url` with a data URL creates one idempotent job and duplicate import returns `created:false`.
- Sprint 6 targeted test passed: `node --test tests/sprint6-discovery.test.js`.
- Sprint 7 targeted test passed: `node --test tests/sprint7-scheduler.test.js`.
- Sprint 8 Goal 1 gate passed: `npm test` (27/27) and `npm run smoke`.

## Current implementation notes
- Core flow is local-only and API-key-free.
- Generated artifacts are `draft_needs_human_review` and include evidence warnings when proof points are absent or unmatched.
- External actions remain human-gated: no auto-apply, no auto-send, no browser automation.
- Scheduler actions are internal-only, run sequentially behind a PID guard, and write audit/run records for every attempted automation.

## Known limitations
- SQLite is via `sql.js`, so concurrent write locking is simpler than a native SQLite/WAL setup; avoid simultaneous write-heavy CLI processes.
- Dashboard is local and functional but still intentionally lightweight; richer persisted approve/reject commands, editable profile forms, and full artifact diffs are next steps.
- URL import fetches public page text when available and otherwise records a manual-enrichment job; no ATS/private-account scraping.
- Research commands create honest worksheets, not fabricated dossiers.
- Discovery uses direct public ATS APIs (Greenhouse/Lever) or local fixtures; no LinkedIn/Indeed/private-account scraping and no auto-apply behavior.
- Default automations are seeded disabled; humans must opt in before scheduled discovery or briefs run.
