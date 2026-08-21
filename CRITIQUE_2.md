# CRITIQUE_2

Environment: `node -v` → `v22.22.3`. Provider/ACP keys unset or blank for B1–B5. No TTY started for the snapshot check. `--advisor` not used.

B2 is the frozen `npm test` with keys unset (no B4-only `JOBOS_SEARCH_PROVIDER` / `JOBOS_ACP_COMMAND`). An earlier `npm test` that still had those B4 env vars leaked in produced extra sprint3/sprint10 fails; those vanished on the clean run and are not scored here.

**VERDICT: FAIL**

Failing checks: **B1**, **B2**

---

CHECK: B1
COMMAND: node --test --test-concurrency=1 tests/tui-*.test.js tests/guided-setup-navigation.test.js tests/p0-p1-first-run-ux.test.js tests/w08-career-memory-tui.test.js
EXIT: 1
PASS_EVIDENCE: 77 pass / 20 fail of 97. Exit 0 is required and not met. Failures: SETUP-05 `null !== 'resume-paste'`; SETUP-06 `null !== 'setup-proof-review'`; SETUP-07 `null !== 'setup-job-source'`; SETUP-08 `Cannot read properties of null (reading 'fit_score')`; SETUP-09 sample offline search not saved; SETUP-11 `null !== 'resume-path'`; SETUP-12 materials `'blocked' !== 'complete'`; SETUP-13 workspace profile `null !== 'alex-chen'`; ANSW-02 `reuse_scope` `'global' !== 'auto_fill'`; ANSW-03 files copy missing `/restricted answers stay gated/` (truncated `restricted answers sta…`); ART-04 approve on questions.md is not refused (`working · approve draft`); KEYMAP-01 Tab wrap `'chat' !== 'job'`; KEYMAP-03 `/f` still paints `/tracker` (chat empty-state copy); KEYMAP-04 slashIndex `6 !== 10`; KEYMAP-07 G stays `'workspace'` not `'jobs'`; KEYMAP-09 connection opens but `/Record contact \(r\)/` misses truncated `Record contac…`; RAIL-04 `dueTasks` `[]` vs `['due-outreach']`; UX-BENCH-05 chip `'Needs review' !== 'Find people'`; W08-TUI-02 accept writes `source:'cli'` / `proposalId:'memory_proposal_revoke'` not `source:'tui'` / `memory_proposal_accept`; W08-TUI-03 trusted TUI accept throws `memory_required_field` (`evidence must contain at least one observation.`).

---

CHECK: B2
COMMAND: npm test
EXIT: 1
PASS_EVIDENCE: 658 pass / 25 fail / 1 skipped of 684 (`# tests 684`). The B1 rewrite set is inside this glob and still red (same 20). Extra non-B1 failures: `--agent off` `tui.client` is `undefined` not `null`; TUI review overlay paints a future/undated reminder; Files refresh does not list reloaded drafts after an external disk write; W09-RECOVERY-01 `onboarding.profileId` `null !== 'alpha'`; W09-RESUME-02 added proof evidence `'' !== 'source'`. Domain/MCP contracts are not fully green while chrome changed.

---

CHECK: B3
COMMAND: npm run smoke
EXIT: 0
PASS_EVIDENCE: Smoke isolated `JOBOS_HOME` under `/tmp/jobos-smoke-cjFhUs`, returned `"ok": true`, scored 71, packet `receiptState: "confirmed"` with `submissionPerformed: false` and `externalSideEffects: "none"` on human-review, receipt spine, W03–W08, and networking; no live employer submit.

---

CHECK: B4
COMMAND: node --input-type=module -e '<frozen BENCHMARK.md B4 wrapper: isolated JOBOS_HOME, non-TTY stdio, `src/cli.js tui --snapshot --width 140 --height 42 --agent off`, IA assertions>'
EXIT: 0
PASS_EVIDENCE: Wrapper and snapshot process exited 0 within 15s. Isolated empty workspace matched JobOS wordmark, Workspace|Jobs, WELCOME TO JOBOS / Start guided setup, `/ in Chat`, Job/People/Chat/Tab; did not match `JOBOS ·` header, box-drawing dashboard, filters 1–7, visualizer mock companies, `spike:ink`, numeric `FIT n`, or ACP spawn on stderr.

---

CHECK: B5
COMMAND: node src/cli.js agent-guide --json ; node src/cli.js score
EXIT: 0 ; 2
PASS_EVIDENCE: Command A stdout is JSON with `architecture.interactive="tui"`, `architecture.sideEffects="default-off"`, `exitCodes.success=0/runtimeError=1/usageError=2`, `tui` flags `--snapshot` `--agent off` `--width` `--height`, and human-only tools (`approve_artifact`, `reject_artifact`, `create_application_packet`, `attest_application_submitted`, `answers_add`, `approve_contact`, `network_contact_record`, `mark_outreach_sent`, `accept_memory_proposal`, `reject_memory_proposal`, `revoke_memory_proposal`) all `agentEligible=false` / `mediation=trusted_cli_or_tui_only`. Command B exit 2, stderr `jobos: Missing job id` (matches `^jobos:`), empty stdout.

---

## Semantic audit (B1 rewrite set vs locked IA)

B1 is a fail even beyond exit 1. The rewrite set is aimed at Classic red IA. Retired-chrome assertions are no longer the blocker they were in CRITIQUE_1, but nested setup persistence, keymap wrap/filter, Files/answers gates, due-brief projection, and memory TUI mediation still miss the locked bar.

### Production `@inkjs/ui` usage

Product tree is Ink + React 19 via `src/tui.js` → `src/tui/runtime.js` (`startTui` / `JobosTui`) and `src/tui/render.js` (`renderToString`). CLI `jobos tui` dynamically imports `startTui`; `spike:ink` is not the product entry.

`@inkjs/ui` is a production dependency and is mounted:

- `src/tui/components.js` imports `ThemeProvider` and `Spinner`. `App` wraps the tree in `ThemeProvider` with `INKUI_THEME`. Header `working` mounts `Spinner`.
- `src/tui/theme.js` extends Badge / Spinner / StatusMessage tokens onto Classic red (`#111111` / `#ff6b6b` / JetBrains Mono). Badge and StatusMessage are still never mounted as widgets.
- UX-BENCH-13 (green) imports `ThemeProvider`, `Spinner`, and `INKUI_THEME` from the product facade, asserts Classic accent on Badge/Spinner tokens, and matches `/working/` both on a mounted Spinner and on the App header while `state.working` is true.

The stack is proven for ThemeProvider + Classic `INKUI_THEME` + one real widget (Spinner). Unused Badge/StatusMessage keys are not a B1 fail by themselves.

### Snapshot no-fabrication

B4’s isolated empty `--snapshot` did not invent visualizer listings (Northstar / Harbor / Example Learning Co / Contoso / Lumen) and did not spawn ACP. UX-BENCH-09 and KEYMAP-06 now keep `model.empty.noProfile` / `noJobs` true on a genuinely empty store and after Esc skip. SETUP-01 (green) continues welcome → setup without inventing rows.

Do not treat that as proof that setup writes persist: SETUP-05/07/09/12 never land nested pickers or complete materials, so first-run honesty holds on skip/empty, not on the required journey.

### Retired chrome absence

Header wordmark `JobOS` (no space) is painted; box-drawing `┌ JOBS` / `SELECTED JOB` / `┌ ASSISTANT`, colon bars, `spike:ink`, and numeric `FIT n` row chrome were not observed in passing screens or B4.

SETUP-02 (green) now matches `SET UP JOBOS — \d/7 ESSENTIAL` and `doesNotMatch(/JOBOS ·/)`. UX-BENCH-02/08 pass `assertNoRetiredChrome` on welcome and setup. B4 also does not match `JOBOS ·`. The rewrite set no longer *requires* the retired `JOBOS ·` token.

### Locked IA / domain / human-gate coverage vs actual failures

Tests that exist and fail (product short of the locked IA), plus what now holds:

1. Ink product entry / `jobos tui` — covered by `JobosTui`/`renderTui`/`startTui`; CLI snapshot proven in B4; UX-BENCH-13 proves the `@inkjs/ui` mount.
2. One person, one profile in the TUI. No profile-switcher chrome — SETUP-13 expected workspace profile `alex-chen`, got `null`. W09-RECOVERY-01 (B2) `onboarding.profileId` stays `null` after `/setup`.
3. Welcome → setup; Skip/Esc invents nothing — SETUP-01 and KEYMAP-06 pass.
4. Setup step ids/labels — SETUP-02 labels match `SETUP_STEP_LABELS` (pass) and no longer asserts retired `JOBOS ·`.
5. Nested setup pickers call real domain — SETUP-04 opens `setup-resume-source` (pass). SETUP-05 Enter does not enter `resume-paste`; SETUP-06 never reaches `setup-proof-review`; SETUP-07 never opens `setup-job-source`; SETUP-11 never enters `resume-path`. Resume import, proof verify/keep/edit/drop, job import, and fit scoring do not persist through the TUI journey (SETUP-08/12).
6. Left rail New | Jobs; Add to Jobs moves the row — RAIL-01 and RAIL-02 pass.
7. Action chips not numeric FIT — UX-BENCH-04 pass; UX-BENCH-05 after creating a resume artifact returns `Needs review` (review-queue precedence) not `Find people`.
8. Job | People | Chat tabs, Tab/Shift+Tab — UX-BENCH-06 pass; KEYMAP-01 third Tab stays on `chat` (no wrap).
9. Job = rundown + Create files + Tracker; People = this listing, no Network button; Chat = this-job composer — People/Chat copy asserted; KEYMAP-09 does open `connection` but the CTA is truncated (`Record contac…`) so `/Record contact \(r\)/` fails. GATE-03/04 (green) open connection from Network/People with a different seed.
10. Composer only on Chat and Workspace — asserted in UX-BENCH-06 (pass). KEYMAP-07 `g` opens Workspace; `G` does not return to Jobs.
11. Slash menu above prompt, filters, arrows+Enter, Esc clears `/`, `/` on Job/People jumps to Chat — KEYMAP-02/05/11 pass; KEYMAP-03 still paints `/tracker` after `/f` via chat empty-state copy; KEYMAP-04 down-arrow clamp `6 !== 10`.
12. Slash catalog `/create-files` `/find-people` `/network` `/tracker` `/review` `/daily` `/chat` `/jobs` `/workspace` `/memory` `/setup` — UX-BENCH-12 catalog ids + live handlers pass.
13. `/create-files` writes real artifacts — P0/P1 in-process create-files pass; SETUP-08 dies before score (`fit_score` on null job).
14. Files overlay resume.md + questions.md Approve/Reject via `source:'tui'` — ART-01/02/03 pass; ART-04 approve on questions.md is not refused; ANSW-03 restricted-gate copy is truncated off the frame.
15. Tracker mutates this job; packet freeze; human-only attest — ART-05/06/07 pass in B1.
16. `/find-people` stages this listing / Workspace keep-skip — GATE-05/06/07 pass (keep promotes, skip suppresses, profile research opens `people-review`).
17. `/network` overlay; person → connection; record contact / mark-sent human-only — GATE-01/02/03/04/09 pass; KEYMAP-09 copy miss only.
18. `/review` morning brief, not Updates inbox — RAIL-04 `dueTasks` is `[]` vs `['due-outreach']`; RAIL-05 Enter on a brief draft opens `files` (pass). B2 task-semantics still paints a future/undated reminder.
19. `/memory` over real projections; accept/reject/revoke human-only — W08-TUI-01/01b pass (alpha listed, beta excluded); W08-TUI-02 accept does not persist `source:'tui'` on the listed proposal; W08-TUI-03 MCP/ACP denied, but trusted TUI accept throws `memory_required_field`.
20. `/daily` `/jobs` `/workspace` `/chat` `/setup` — RAIL-03 pass; `/setup` reopen fails (SETUP-13 / W09-RECOVERY-01).
21. ACP off/unavailable invents no replies — ACP-01/02 pass in B1. B2 `--agent off` never assigns `this.client` (`undefined !== null`) even though `agentState` is `off` and no session file is written.
22. Human-only tools stay TUI/CLI; MCP catalog excludes them — ACP-05 / ART-07 / GATE-09 / B5 hold. ANSW-01 denies mcp/acp. W08-TUI-03’s TUI-side accept still does not complete.
23. External apply/send default off — ACP-07 / ART-09 pass; B3 `submissionPerformed: false`.
24. Out of scope (interview pane, career-ops, extra rails, Updates, profile switcher, colon bar, filters 1–7) — KEYMAP-10 / ANSW-05 / W07 locked-IA absence tests pass.

Overlay-family hole in UX-BENCH-08: expectations still omit `people-review` (keep/skip) and `connection`. Those overlays exist in `overlayContent` and GATE tests (green) cover them; the rewrite set’s overlay-identity loop does not.

### Actionable product/test gaps (do not treat as patches)

- Nested setup Enter must open `resume-paste` / `setup-proof-review` / `setup-job-source` / `resume-path` and persist resume/proofs/jobs/sample search; materials must complete after human approval.
- `/setup` must bind the workspace profile (`alex-chen` / W09 `alpha`); `onboarding.profileId` must not stay `null`.
- Tab must wrap Chat → Job; `G` must return Jobs; slash filter must not leave `/tracker` in visible copy; down-arrow must clamp at the last catalog entry.
- Files overlay must paint the full restricted-answer gate line and refuse approve/reject on `questions.md`.
- `answers_add` verified public answers must persist `reuse_scope='auto_fill'`.
- Action-chip precedence after artifacts with no outreach path must be `Find people`, not `Needs review`, unless the review queue is the locked rule — then UX-BENCH-05 is wrong, but B1 still fails until they agree.
- `/review` must project the real due set (`due-outreach`) and keep future/undated reminders out of the painted brief.
- Memory overlay accept must write `source:'tui'` / `actor:'user'` on the listed proposal; trusted TUI accept must not throw `memory_required_field` on a seeded proposed row.
- Files refresh must observe an external disk write.
- `--agent off` must leave no AcpClient (`null`, not an unset property) and start no child.
- UX-BENCH-08 should include keep/skip (`people-review`) and `connection` in the overlay family it claims to cover.

No 9/10. No partial credit. B3, B4, and B5 held; B1 and B2 did not. Verdict is **FAIL**.
