# JobOS Rebuild Loop Plan

## Mission

Rebuild JobOS from a test-passing skeleton into a genuinely usable agent-native job application OS. Every core module must produce output that a real job seeker would use without manual rework.

## Why the current MVP failed

The original goal prompt asked for "templates and heuristics first" and "placeholder stubs." The agent optimized for that target. Tests pass (2/2), but:
- Scoring is keyword counting — can't differentiate good-fit from poor-fit jobs
- Tailoring is template concatenation — doesn't rewrite or map requirements to proof
- Research is blank worksheets — no real company/stakeholder facts
- No outreach, no interview prep, no analytics, no MCP, no discovery

The loss function was wrong. This plan fixes it.

## Architecture decision: LLM-integrated, not deterministic-only

The spec's thesis is "agent-native, not agent-bolted-on." The MVP must use LLM calls for the intelligent operations (scoring, tailoring, research, outreach, interview prep). The local-first principle is preserved: LLM calls go through the user's own API keys / Ollama Cloud, no telemetry, no cloud sync. Deterministic fallbacks remain for offline use but are clearly marked as degraded mode.

## Module targets (the loss function)

Each module has a measurable usability bar. Tests passing is necessary but not sufficient.

### Module 1: Profile & Proof Points
- Profile stores structured preferences: role families, industries, locations, salary bands, dealbreakers, work model, communication style
- Proof points are structured (summary, evidence link, skills, metrics) not regex-extracted
- CLI: `profile create`, `profile import-resume`, `proof add`, `proof list`, `profile export`

### Module 2: Job Discovery & Ingestion
- `jobs import-url` fetches and parses real job pages (Greenhouse, Lever, Ashby, generic)
- `jobs import-text` parses structured job descriptions
- `jobs list` with filters: status, min-fit, profile, source
- `jobs enrich` fills missing fields (work model, seniority, compensation) from job text
- Deduplication across sources

### Module 3: Fit Scoring (LLM-powered)
- Score uses LLM with structured output: overall 0-100, sub-scores per dimension, reasoning, red flags, confidence
- **Usability bar**: Score must differentiate a well-fit job from a poor-fit job by ≥30 points
- Dimensions: role fit, domain fit, seniority, location, compensation, mission, network access, red flags
- Explainable: each score includes 2-3 sentence reasoning per dimension
- CLI: `score <job-id> --profile <profile> --json`, `score batch --status new --profile <profile>`

### Module 4: Resume & Cover Letter Tailoring (LLM-powered)
- Tailored resume maps ≥3 job requirements to specific proof points
- Zero unsupported claims — every bullet links to a proof point ID
- Cover letter references specific company/role details, not generic template
- **Usability bar**: Generated resume is usable as a first draft with minor edits, not a blank template
- CLI: `tailor resume --job <id> --profile <id> --output markdown`, `tailor cover-letter --job <id> --profile <id> --tone <tone>`
- Artifacts stored with evidence chain, approval status, version history

### Module 5: Company & Stakeholder Research (web search + LLM)
- `research company --job <id>` produces a real dossier with:
  - ≥5 verified facts with source URLs (website, news, product info)
  - Company stage, size, funding if available
  - Risk flags (layoffs, ghost jobs) if found
  - NOT a blank template
- `research stakeholders --job <id>` identifies likely roles (recruiter, hiring manager) and suggests outreach angles
- Uses web search + LLM summarization with citations
- **Usability bar**: Dossier contains real information about the specific company, not placeholder text

### Module 6: Outreach & Relationship Management
- `outreach draft --stakeholder <id> --job <id> --goal <goal>` produces a personalized message
- Message references specific stakeholder context and company facts
- Follow-up scheduling, outreach history, suppression rules
- **Usability bar**: Draft message is specific enough that a human would only need minor edits before sending

### Module 7: Application Tracking
- Kanban-style status pipeline: saved → researching → materials-ready → applied → recruiter-screen → interview → offer → rejected/withdrawn/ghosted
- Tasks with due dates, priorities, linked jobs/applications
- Weekly review with real funnel metrics
- CLI + web dashboard with create/edit (not read-only)

### Module 9: Interview Preparation
- `interview prep --application <id> --stage <stage>` generates a packet:
  - Likely questions (role-specific, not generic)
  - STAR stories mapped from proof points to competencies
  - Questions to ask the interviewer
  - Company/role refresh summary
- **Usability bar**: Packet is useful for actual interview prep, not a blank template

### Module 10: Analytics
- `analytics funnel --profile <id> --since <days>` shows conversion by source, stage, role family
- Weekly review includes real metrics, not just counts

### Agent Interfaces
- REST API with real CRUD (not just GET /api/state)
- MCP server with tools for all core operations
- All commands support `--json`
- Audit log tracks all actions with side-effect classification

## Build sequence

### Sprint 1: Foundation rebuild
- Refactor src/cli.js into modules (src/db.js, src/profiles.js, src/jobs.js, src/scoring.js, src/tailoring.js, src/research.js, src/outreach.js, src/tracking.js, src/interview.js, src/analytics.js, src/api.js, src/mcp.js, src/web.js, src/cli.js)
- Install deps: better SQLite (keep sql.js or switch to better-sqlite3), an LLM client (@anthropic-ai/sdk or openai or ollama), cheerio for HTML parsing
- Structured proof points (not regex extraction)
- Enriched profile schema
- REST API scaffold with CRUD

### Sprint 2: LLM-powered scoring + tailoring
- LLM integration layer (provider-agnostic, works with Ollama Cloud / OpenAI / Anthropic)
- Scoring: LLM with structured output, explainable dimensions
- Tailoring: LLM with proof-point grounding constraints, anti-fabrication rule
- Eval cases: 5 real job descriptions scored against a real profile

### Sprint 3: Research + outreach
- Web search integration (web_search tool or direct)
- Company dossier: real facts with citations
- Stakeholder identification: role inference, outreach angles
- Outreach draft: personalized, context-specific
- Eval cases: 5 real companies, verify dossier has real facts

### Sprint 4: Interview prep + analytics + dashboard
- Interview prep packet: questions, STAR stories, questions to ask
- Analytics: funnel metrics, source performance
- Dashboard: kanban, create/edit forms, artifact review UI
- MCP server: stdio transport, tools for all core operations
- Status: COMPLETE in Sprint 4 implementation.
- Evidence: `src/interview.js`, `src/analytics.js`, `src/web.js`, `src/mcp.js`, extended `src/api.js` and `src/cli.js`, `tests/sprint4-interview-analytics-mcp.test.js`, and `scripts/smoke.js`.
- Verification: `npm test` passed 12/12, `npm run smoke` passed with `interviewPrep: true`, `interactiveDashboard: true`, and MCP tool-list/framing coverage. Codex found no discrete issues after fixes. OMP judged the sprint a functional local MVP slice. Claude judged it a real improvement, not a skeleton.
- Sprint 5 carry-forward: add append-only application status history so analytics can report stages reached, time-in-stage, and stale/ghost detection rather than current-status snapshots only; validate MCP against a real MCP client.

### Sprint 5: Integration + polish + eval
- End-to-end smoke: profile → import → score → research → tailor → track → interview prep
- Full test suite
- README update with real usage
- All eval cases passing
- Final architecture review
- Status: NOT STARTED after Sprint 4 commit. Start with status history + analytics hardening, then README/eval/final report.

## Verification protocol

Every sprint ends with:
1. `npm test` — all tests pass
2. `npm run smoke` — end-to-end CLI flow works
3. Manual eval check — conductor inspects actual output for usability
4. Architecture review — Claude reviews whether sprint is real improvement
5. `git commit` — bisectable history
6. State file update

## Stop conditions

- All 10 modules produce usable output (not templates/stubs)
- `npm test` green
- `npm run smoke` green
- At least 5 real job descriptions scored with meaningful differentiation
- At least 3 real company dossiers with verified facts
- REST API has CRUD for all core entities
- MCP server exposes all core operations
- Architecture reviewer (Claude) confirms: "this is usable, not a skeleton"

## Final report gate

When all stop conditions are met, write `.tmp/final-report.md` before yielding. The report must summarize:

- What was built across all five sprints.
- Which modules are genuinely usable, with evidence from inspected real output.
- Verification commands and results.
- Remaining limitations, risks, and recommended next steps.

## Role assignments

| Role | Agent | Model | Windows |
|------|-------|-------|---------|
| Conductor | Hermes /goal | GPT-5.5 (Ollama Cloud) | goal |
| Implementer 1 | Droid | GLM 5.2 (Droid subscription) | droid |
| Implementer 2 | OpenCode | DeepSeek V4 Pro | opencode |
| Reviewer 1 (code quality) | Codex | GPT-5.5 | codex |
| Reviewer 2 (high-level functionality) | OMP agent | grok-composer-2.5-fast | omp-review |
| Architecture critic | Claude | Claude (Fable 5 low) | claude |
| Build/test | shell | — | dev |