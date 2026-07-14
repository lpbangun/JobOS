# JobOS Build Progress

## Current status — 2026-07-14

The repository is a CLI-first, local-first job discovery, networking, and application system. The local dashboard remains available but is not the product focus.

### Primary workflows

- `jobos daily --profile <id>` runs every saved source, isolates failures, deduplicates, scores, and ranks imported jobs.
- `jobos pursue <job-id> --profile <id>` composes fit scoring, company/stakeholder/contact research, network mapping, application answers, resume and cover-letter drafts, application tracking, outreach path selection, and an outreach draft when a sourced stakeholder is available.
- `jobos network paths|contacts --job <id>` makes user-owned relationship data and public contact evidence a first-class control surface.
- `jobos agents ...`, `--agent`, and `JOBOS_AGENT` route structured generation through Codex, Hermes, or any registered protocol-compatible executable.
- `jobos browser ...` provides optional private Playwright profiles, cookie/storage-state synchronization, authenticated fetches, and SHA-256-pinned trusted scripts with explicit side-effect gating.

### Implemented in the lean CLI pass

- Concise root help grouped into Setup, Workflows, and Extend; the complete low-level registry remains behind `help --all` and `agent-guide --json`.
- Ashby, public career-page, and bounded VC/startup portfolio discovery in addition to Greenhouse and Lever.
- Hard portfolio caps: 30 companies, 90 requests, 10 seconds per request, and 60 seconds total; partial results retain structured source failures.
- Cron-friendly `daily` and dependency-aware `pursue` workflow orchestration with dry-run, stage selection, elapsed times, result paths/IDs, skip reasons, and recovery guidance.
- Profile/job ownership validation in scoring, tailoring, and pursue.
- Reusable answer bank with normalized matching, employer scoping, status/reuse policy, redacted mirrors, restricted-question blockers, and proof-grounded agent/LLM draft suggestions.
- Warm relationship edges integrated into outreach-plan selection; source-backed warm paths can outrank cold contact routes.
- Generic local-agent registry and protocol with built-in Codex/Hermes manifests, executable checks, strict JSON stdout, 50 KiB output cap, timeout/kill, typed failures, and no silent fallback for explicit agent runtime failures.
- Agent routing across scoring, research, application-question drafting, tailoring, and outreach; generated modes identify `agent` versus `llm`.
- Optional Playwright integration with private permissions, login/auth failure classification, cookie import/export, CAPTCHA detection, script hash verification, and two-key side-effect authorization.
- `sql.js` save hardening with an exclusive lock, optimistic store revision, fsync, same-directory atomic rename, stale-snapshot rejection, and lock cleanup.
- Policy migration from obsolete `human_approval_required` wording to `user_configured`; external effects remain disabled until configured/enabled.
- Explicit `JOBOS_SEARCH_PROVIDER=none` mode for deterministic offline pursuit and research.
- MCP additions: `daily_discovery`, `pursue_job`, and `answers_match`.
- README and external agent guide consolidated around the current CLI workflow, extension contracts, safety model, installation, recovery, and intentional limitations.

### Intentionally deferred

Not required for the smallest coherent CLI product:

- Immutable application packet/version/receipt graphs and exception-review UIs.
- Universal auto-apply, Workday/iCIMS/Taleo automation, or LinkedIn/Indeed DOM-specific bots.
- SMTP auto-send, mailbox reconciliation, and hardcoded platform automation.
- PDF/DOCX production rendering, voice interview coaching, offer/negotiation workspaces, and frontend redesign.
- Agent marketplace/plugin SDK beyond the small executable protocol and MCP surface.

## Verification

- `npm test`: **90/90 passed** after implementation.
- `npm run smoke`: passed; clean temp workspace, fixture discovery, scoring, tailoring, application/interview/analytics/scheduler flows, workspace exports, dashboard API/shell, and route hardening.
- Independent Advisor suite `tests/lean-cli-advisor.test.js`: **43/43 passed** after strengthening the warm-path assertion; includes clean CLI/help/policy, answer safety, profile isolation, discovery failure isolation, pursue E2E, agent failures/precedence, injected Playwright success/failures, warm networking, MCP invocation, and store locking.
- Focused contact/outreach suite: **8/8 passed**.
- Focused custom-agent smoke: connection test succeeded; `pursue --stage questions --agent fixture-agent` reported both score and question stages in `agent` mode; the worksheet contained generated drafts and proof-point IDs.
- Principal offline pursuit E2E completed with all stages and artifact/application outputs using `JOBOS_SEARCH_PROVIDER=none`.

## Independent Advisor gate

Final independent score: **9.2/10 overall**; **9 of 10** dimensions scored at least 9.

| Dimension | Score |
|---|---:|
| Functionality | 9/10 |
| Integration | 10/10 |
| CLI usability | 9/10 |
| Out-of-box operation | 8/10 |
| Reliability and failure handling | 10/10 |
| PR #4 feature selection | 9/10 |
| Networking | 9/10 |
| Pluggable agents | 10/10 |
| Authenticated browser | 9/10 |
| Clutter elimination | 9/10 |

The sole 8/10 is the deliberate browser-install tradeoff: Playwright and Chromium are optional so `npm install` remains lean; authenticated-browser users run `npm install playwright` and `npx playwright install chromium`.

## Known limitations

- Browser validation used injected fake Playwright for deterministic behavior in this headless environment. No real Chromium binary is installed here.
- Headed login requires a display; headless machines can import a Playwright storage-state file.
- Registered browser scripts are trusted, unsandboxed Node.js modules.
- Public research is best-effort and source-grounded; offline mode produces explicit open questions rather than fabricated facts.
- `sql.js` does not merge concurrent writes. A stale writer receives retryable `stale_snapshot` and must reopen/retry.
- Generated materials remain reviewable drafts unless a user separately configures an enabled external consumer.
