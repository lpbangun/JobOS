# CRITIQUE_1

Environment: `node -v` → `v22.22.3`. Provider/ACP keys unset or blank for B1–B5. No TTY started for the snapshot check. `--advisor` not used.

**VERDICT: FAIL**

Failing checks: **B1**, **B2**

---

CHECK: B1
COMMAND: node --test --test-concurrency=1 tests/tui-*.test.js tests/guided-setup-navigation.test.js tests/p0-p1-first-run-ux.test.js tests/w08-career-memory-tui.test.js
EXIT: 1
PASS_EVIDENCE: 50 pass / 46 fail of 96. Exit 0 is required and not met. Failures include SETUP-01 (`null !== 'setup'` on welcome Enter), nested setup pickers never opening (`setup-resume-source` / `setup-proof-review` / `setup-job-source` stay `null`), ART-01 missing “restricted answers stay gated”, ART-02 `undefined !== 1` for `artifact.approved` audit count, GATE-03 Enter stays on `network` not `connection`, KEYMAP-01 Tab wrap `'chat' !== 'job'`, KEYMAP-03 `/tracker` still painted after `/f`, UX-BENCH-02/08 product paints `SET UP JOBOS ·`, W08-TUI-02 accept writes `source:'cli'` on the wrong proposal. Semantic audit also fails: B1 files never prove production `@inkjs/ui` usage, and SETUP-02 (green) still asserts retired chrome `/SET UP JOBOS · \d\/7 ESSENTIAL/`.

---

CHECK: B2
COMMAND: npm test
EXIT: 1
PASS_EVIDENCE: 625 pass / 57 fail / 1 skipped of 683 (`# tests 683`). The B1 rewrite set is inside this glob and still red. Extra non-B1 failures: W04-LIVE-04 `stale_snapshot` “Workspace changed from revision 5 to 7”, Files refresh does not observe an external disk write, TUI review overlay leaks future/undated reminders, W09-RECOVERY/JOURNEY/CALIBRATION/RESUME setup keys do not open setup or persist derive/reject. Domain/MCP contracts are not fully green while chrome changed.

---

CHECK: B3
COMMAND: npm run smoke
EXIT: 0
PASS_EVIDENCE: Smoke isolated `JOBOS_HOME` under `/tmp/jobos-smoke-tuBfwv`, returned `"ok": true`, scored 71, packet `receiptState: "confirmed"` with `submissionPerformed: false` and `externalSideEffects: "none"` on human-review, receipt spine, W03–W08, and networking; no live employer submit.

---

CHECK: B4
COMMAND: node --input-type=module -e '<frozen BENCHMARK.md B4 wrapper: isolated JOBOS_HOME, non-TTY stdio, `src/cli.js tui --snapshot --width 140 --height 42 --agent off`, IA assertions>'
EXIT: 0
PASS_EVIDENCE: Wrapper and snapshot process exited 0 within 15s. Isolated empty workspace matched JobOS wordmark, Workspace|Jobs, welcome/setup copy, `/ in Chat`, Job/People/Chat/Tab; did not match `JOBOS ·` header, box-drawing dashboard, filters 1–7, visualizer mock companies, `spike:ink`, numeric `FIT n`, or ACP spawn on stderr.

---

CHECK: B5
COMMAND: node src/cli.js agent-guide --json ; node src/cli.js score
EXIT: 0 ; 2
PASS_EVIDENCE: Command A stdout is JSON with `architecture.interactive="tui"`, `architecture.sideEffects="default-off"`, `exitCodes.success=0/runtimeError=1/usageError=2`, `tui` flags `--snapshot` `--agent off` `--width` `--height`, and human-only tools (`approve_artifact`, `reject_artifact`, `create_application_packet`, `attest_application_submitted`, `answers_add`, `approve_contact`, `network_contact_record`, `mark_outreach_sent`, `accept_memory_proposal`, `reject_memory_proposal`, `revoke_memory_proposal`) all `agentEligible=false` / `mediation=trusted_cli_or_tui_only`. Command B exit 2, stderr `jobos: Missing job id` (matches `^jobos:`), empty stdout.

---

## Semantic audit (B1 rewrite set vs locked IA)

B1 is a fail even beyond exit 1. The rewrite set is aimed at Classic red IA, but it does not prove every locked point, and several green assertions still encode retired chrome.

### Production `@inkjs/ui` usage

Product tree is Ink + React 19 via `src/tui.js` → `src/tui/runtime.js` (`startTui` / `JobosTui`) and `src/tui/render.js` (`renderToString`). CLI `jobos tui` dynamically imports `startTui`; `spike:ink` is not the product entry.

`@inkjs/ui` is a production dependency and is used, but thinly:

- `src/tui/components.js` imports `ThemeProvider` and `Spinner` only. `Spinner` is the sole `@inkjs/ui` widget (header `working`).
- `src/tui/theme.js` extends Badge / Spinner / StatusMessage tokens onto Classic red (`#111111` / `#ff6b6b` / JetBrains Mono). Badge and StatusMessage are never mounted.
- No B1 test imports `@inkjs/ui`, `ThemeProvider`, `INKUI_THEME`, or `Spinner`. Theme tests assert `CLASSIC_THEME` constants only. Production `@inkjs/ui` usage is therefore unproven by the rewrite set.

### Snapshot no-fabrication

B4’s isolated empty `--snapshot` did not invent visualizer listings (Northstar / Harbor / Example Learning Co / Contoso / Lumen) and did not spawn ACP. That first-run snapshot path holds.

In-process first-run tests do not: UX-BENCH-09 `model.empty.noProfile` is `false` on an empty fixture; KEYMAP-06 `model.empty.noJobs` is `false` after Esc skip. SETUP-01 still shows 0 profile/proof/job/contact rows after skip, so the empty flags are lying rather than inserting SQLite rows. ACP-02 fails `undefined !== 0` on submission-receipt count (query shape, not a painted fake receipt). Do not treat B4 green as proof that first-run TUI state is honest.

### Retired chrome absence

Header wordmark `JobOS` (no space) is painted; box-drawing `┌ JOBS` / `SELECTED JOB` / `┌ ASSISTANT`, colon bars, `spike:ink`, and numeric `FIT n` row chrome were not observed in passing screens.

Setup overlay still paints retired token `JOBOS ·` as `SET UP JOBOS · 1/7 ESSENTIAL`. UX-BENCH-02 (minimum setup) and UX-BENCH-08 (setup overlay) fail `assertNoRetiredChrome` on `/JOBOS ·/`. B4 misses this because the empty snapshot stays on welcome, not setup.

SETUP-02 is green and still *requires* `/SET UP JOBOS · \d\/7 ESSENTIAL/`. BENCHMARK: the rewrite set fails B1 if it still asserts retired chrome, even when node:test is green.

### Locked IA / domain / human-gate coverage vs actual failures

Tests that exist and fail (product short of the locked IA):

1. Ink product entry / `jobos tui` — covered indirectly by `JobosTui`/`renderTui`/`startTui` facade; CLI snapshot proven only in B4.
2. One TUI profile, no switcher — SETUP-13 expected workspace profile `alex-chen`, got `null`.
3. Welcome → setup; Skip/Esc invents nothing — SETUP-01 Enter leaves `overlay=null`; skip row counts are 0; empty flags disagree (KEYMAP-06).
4. Setup step ids/labels — SETUP-02 labels match `SETUP_STEP_LABELS` (pass) but asserts retired `JOBOS ·` header.
5. Nested resume/proof/job pickers call real domain — SETUP-04/05/06/07/11/12 never leave `overlay='setup'`; pickers stay `null`.
6. Left rail New | Jobs; Add to Jobs moves the row — RAIL-01 pass; RAIL-02 Enter on New does not add.
7. Action chips not numeric FIT — UX-BENCH-04 pass; UX-BENCH-05 chip after artifacts is `Needs review` not `Find people`.
8. Job | People | Chat tabs, Tab/Shift+Tab — UX-BENCH-06 pass; KEYMAP-01 third Tab stays on `chat` (no wrap).
9. Job = rundown + Create files + Tracker; People = this listing, no Network button; Chat = this-job composer — People/Chat copy asserted; connection overlay from People Enter stays `null` (KEYMAP-09).
10. Composer only on Chat and Workspace — asserted in UX-BENCH-06 (pass).
11. Slash menu above prompt, filters, arrows+Enter, Esc clears `/`, `/` on Job/People jumps to Chat — KEYMAP-02/05 pass; KEYMAP-03 still paints `/tracker` after `/f`; KEYMAP-04 Enter on `/workspace` lands `headerMode='jobs'`.
12. Slash catalog `/create-files` `/find-people` `/network` `/tracker` `/review` `/daily` `/chat` `/jobs` `/workspace` `/memory` `/setup` — UX-BENCH-12 catalog ids + live handlers pass.
13. `/create-files` writes real artifacts — SETUP-08 dies before score (`fit_score` on null job); P0/P1 Enter on brief draft opens `review` not `files`.
14. Files overlay resume.md + questions.md Approve/Reject via `source:'tui'` — ART-01 missing restricted-answer gate copy; ART-02/03 audit counts `undefined`; ART-04 approve on questions is not refused.
15. Tracker mutates this job; packet freeze; human-only attest — ART-05 `2 !== 1` on status_changes; ART-06/07 were not in the fail list (packet/attest mediation cases held in this run).
16. `/find-people` stages this listing / Workspace keep-skip — GATE-05 keep/skip count `0 !== 1`; GATE-06 candidate stays `candidate` not `promoted`.
17. `/network` overlay; person → connection; record contact / mark-sent human-only — GATE-03 Enter stays `network` not `connection`.
18. `/review` morning brief, not Updates inbox — RAIL-04 due set `[]` vs `['due-outreach']`; RAIL-05 Enter stays on `review` not `files`.
19. `/memory` over real projections; accept/reject/revoke human-only — W08-TUI-01b does not list the alpha proposal; W08-TUI-02 accept hits `memory_proposal_revoke` with `source:'cli'` / `actor:'fixture-user'`; W08-TUI-03 accept throws `memory_required_field`.
20. `/daily` `/jobs` `/workspace` `/chat` `/setup` — RAIL-03 pass; `/setup` reopen fails (SETUP-13).
21. ACP off/unavailable invents no replies — ACP-01 pass; ACP-02 receipt count `undefined !== 0`.
22. Human-only tools stay TUI/CLI; MCP catalog excludes them — ACP-05 / ART-07 present and not in the B1 fail list.
23. External apply/send default off — ACP-07 pass.
24. Out of scope (interview pane, career-ops, extra rails, Updates, profile switcher, colon bar, filters 1–7) — KEYMAP-10 / ANSW-05 / W07 locked-IA absence tests pass; W07-TUI-01 trusted story retire throws `interview_actor_required`.

Overlay-family hole in the rewrite set: UX-BENCH-08 never opens keep/skip people or connection (locked overlay family). Coverage is only the failing GATE tests.

### Actionable product/test gaps (do not treat as patches)

- Welcome Enter must open `overlay='setup'`; nested setup Enter must open `setup-resume-source` / `setup-proof-review` / `setup-job-source` and persist resume/proofs/jobs.
- Remove `JOBOS ·` from setup chrome (`SET UP JOBOS · n/7 ESSENTIAL`). Stop asserting that retired token in SETUP-02.
- Tab must wrap Chat → Job; `g`/`G` must toggle Workspace|Jobs; composer backspace must delete at cursor; slash filter must not paint non-hits; Enter on a highlighted slash must run it.
- Files overlay must name the restricted-answer gate, write `artifact.approved` / `artifact.rejected` audits, and refuse approve/reject on `questions.md`.
- People Enter and network person-click must open `connection`. Keep must promote; skip must suppress.
- `/review` must project the real due set; Enter on a brief draft must open `files`.
- Memory overlay must bind the listed proposal and persist accept/reject/revoke with `source:'tui'`.
- First-run `model.empty.noProfile` / `noJobs` must be true on an empty workspace.
- B1 tests must assert the mounted `@inkjs/ui` tree (at least `ThemeProvider` + Classic `INKUI_THEME`, and a real widget — not only unused Badge/StatusMessage theme keys).
- B2 stale_snapshot (W04-LIVE-04, ART-10, Files refresh) and W09 setup journeys remain red on the same chrome/controller.

No 9/10. No partial credit. B3, B4, and B5 held; B1 and B2 did not. Verdict is **FAIL**.
