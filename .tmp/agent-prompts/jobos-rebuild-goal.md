# /goal: Rebuild JobOS into a genuinely usable agent-native job application OS

You are the conductor in `/home/logani/projects/Job App` on branch `main`. Act as conductor, not a blind coder. Maintain `.tmp/session-state.tmp` and `.tmp/jobos-rebuild-loop-plan.md`. Keep both current.

## Read first

1. `.tmp/jobos-rebuild-loop-plan.md` — the full loop plan with module targets
2. `.tmp/session-state.tmp` — current phase and progress
3. `AGENTS.md` — project conventions
4. `ideal-agent-native-job-application-app.md` — the product spec (1,211 lines, canonical reference)
5. `src/cli.js` — current MVP (143 lines, to be replaced)

## The problem

The current MVP passes tests but is unusable. Scoring is keyword counting. Tailoring is template concatenation. Research is blank worksheets. No outreach, no interview prep, no analytics, no MCP, no discovery. The original goal asked for "templates and heuristics first" — the agent optimized for that. We are fixing the loss function.

## The target (loss function)

Every core module must produce output that a real job seeker would use without manual rework. Tests passing is necessary but NOT sufficient. The conductor must inspect actual output at each sprint boundary and verify usability.

### Module usability bars (the real acceptance criteria)

1. **Scoring**: LLM-powered. Score differentiates a well-fit job from a poor-fit job by ≥30 points. Each dimension has 2-3 sentence explainable reasoning. NOT keyword counting.

2. **Tailoring**: LLM-powered. Resume maps ≥3 job requirements to specific proof points. Zero unsupported claims. Cover letter references specific company/role details. NOT template fill.

3. **Research**: Web search + LLM. Company dossier has ≥5 verified facts with source URLs. Stakeholder identification suggests likely roles and outreach angles. NOT blank worksheets.

4. **Outreach**: LLM-powered. Draft message references specific stakeholder context and company facts. Usable with minor edits. NOT generic template.

5. **Interview prep**: LLM-powered. Packet has role-specific likely questions, STAR stories mapped from proof points, questions to ask. NOT blank template.

6. **Analytics**: Funnel metrics by source, stage, role family. Weekly review with real insights. NOT just counts.

7. **Application tracking**: Full status pipeline, tasks with due dates, kanban dashboard with create/edit. NOT read-only HTML.

8. **Agent interfaces**: REST API with CRUD for all entities. MCP server with tools for all core operations. NOT just GET /api/state.

## Build sequence

### Sprint 1: Foundation rebuild
- Refactor `src/cli.js` into modules under `src/`
- Install deps: LLM client (provider-agnostic — works with Ollama Cloud, OpenAI, or Anthropic via env vars), cheerio for HTML parsing
- Structured proof points (not regex extraction)
- Enriched profile schema with full preferences
- REST API scaffold with real CRUD
- Verify: `npm test` passes, `npm run smoke` passes, modules load

### Sprint 2: LLM scoring + tailoring
- LLM integration layer: provider-agnostic, reads `JOBOS_LLM_PROVIDER` (ollama-cloud | openai | anthropic), `JOBOS_LLM_MODEL`, `JOBOS_LLM_API_KEY` env vars. Falls back to deterministic mode with clear warning if no LLM configured.
- Scoring: LLM with structured JSON output, explainable dimensions
- Tailoring: LLM with proof-point grounding, anti-fabrication constraint
- Create eval cases: 5 real job descriptions in `tests/eval/` with expected score ranges
- Verify: score a good-fit job and a poor-fit job — scores differ by ≥30 points. Inspect the actual scoring JSON. Is the reasoning meaningful?

### Sprint 3: Research + outreach
- Web search integration for company research
- Company dossier: real facts, source URLs, stage/size/funding, risk flags
- Stakeholder identification: role inference, outreach angles
- Outreach draft: personalized, context-specific
- Create eval cases: 3 real companies in `tests/eval/` — verify dossier has real facts
- Verify: run `research company --job <id>` on a real job. Read the dossier. Does it contain real information about the specific company? NOT placeholder text.

### Sprint 4: Interview prep + analytics + dashboard
- Interview prep packet: questions, STAR stories, questions to ask
- Analytics: funnel metrics, source performance
- Dashboard: kanban view, create/edit forms, artifact review UI
- MCP server: stdio transport, tools for all core operations
- Verify: run `interview prep --application <id>`. Read the packet. Is it useful for real interview prep?

### Sprint 5: Integration + polish + eval
- End-to-end smoke: profile → import → score → research → tailor → track → interview prep
- Full test suite green
- README update with real usage examples
- All eval cases passing
- Architecture review by Claude
- Final verification: every module produces usable output

## How to run the loop

1. Read the loop plan and session state before each sprint.
2. For each sprint: plan the slice → delegate implementation to OpenCode (window: opencode) or OMP (window: omp) → review the diff → run tests → inspect actual output for usability → delegate review to Codex (window: codex) → delegate architecture review to Claude (window: claude) if sprint boundary → commit → update session state.
3. **Never accept worker self-report as proof.** Inspect files/diffs, run tests, read actual output yourself.
4. **One sprint at a time.** Do not start Sprint 2 until Sprint 1 is verified.
5. **Real tool output only.** "Should work" is not evidence. `npm test` output is evidence. Reading a generated dossier and confirming it has real facts is evidence.
6. **Git commit after every sprint.** Bisectable history.
7. **Update `.tmp/session-state.tmp` after every phase change.**

## Worker delegation

- **OMP (GLM 5.2)**: primary implementer. Start with `omp --model glm-5.2` in the omp window. Give narrow, file-specific tasks. Read the diff after.
- **OpenCode (DeepSeek V4 Pro)**: secondary implementer for parallel tasks or when a different perspective helps. Start with `opencode -m opencode-go/deepseek-v4-pro` in the opencode window. Give narrow tasks.
- **Codex (GPT-5.5)**: reviewer 1 — code quality. After implementation, send the diff or changed files for review. Check for regressions, missing tests, security issues, code quality.
- **OMP agent (grok-composer-2.5-fast)**: reviewer 2 — high-level functionality. Ask: "Does the implemented feature actually work end-to-end? Does it meet the usability bar? Would a real job seeker use this output?" Give it the actual generated output to inspect, not just the code.
- **Claude (Fable 5 low)**: architecture critic at sprint boundaries. Ask: "Is this sprint a real improvement toward usability, or same-knob-harder? Are we approaching MVP 5 level? What's the highest-leverage next step?"

## Safety rules

- Do not push to remote. Commit locally only.
- Do not delete or overwrite the spec files (`ideal-agent-native-job-application-app.md`, `job-application-ai-app-research-notes.md`).
- Do not commit `.env` or credential files.
- Keep the human-gating principle: no auto-apply, no auto-send, no browser automation.
- Keep the evidence-grounding principle: no unsupported claims in generated artifacts.
- Keep local-first: no telemetry, no cloud sync, LLM calls go through user's own keys.
- If a worker goes off-task, kill it and reassign. Do not let it spiral.

## Stop conditions

- All 8 module usability bars are met (conductor has inspected real output for each)
- `npm test` green
- `npm run smoke` green
- 5 real job descriptions scored with ≥30 point differentiation
- 3 real company dossiers with verified facts
- REST API has CRUD for all core entities
- MCP server exposes all core operations
- Claude architecture review confirms: "this is usable, not a skeleton"
- `.tmp/session-state.tmp` shows all 5 sprints COMPLETE

When all stop conditions are met, write a final report in `.tmp/final-report.md` summarizing what was built, what's usable, and what remains.