# CRITIQUE_3

Environment: `node -v` → `v22.22.3`. Provider/ACP keys unset or blank for B1–B5. No TTY started for the snapshot check. `--advisor` not used.

B2 is the frozen `npm test` with keys unset (no B4-only `JOBOS_SEARCH_PROVIDER` / `JOBOS_ACP_COMMAND`). The logged clean run is `/tmp/jobos-b2.log`.

**VERDICT: PASS**

Failing checks: none

---

CHECK: B1
COMMAND: node --test --test-concurrency=1 tests/tui-*.test.js tests/guided-setup-navigation.test.js tests/p0-p1-first-run-ux.test.js tests/w08-career-memory-tui.test.js
EXIT: 0
PASS_EVIDENCE: 97 pass / 0 fail of 97 (`# tests 97`, duration 54892ms). Exit 0 is necessary and met. The rewrite set no longer asserts retired chrome (SETUP-02 matches `SET UP JOBOS — \d/7 ESSENTIAL` and `doesNotMatch(/JOBOS ·/)`; UX-BENCH-02/08 pass `assertNoRetiredChrome`). Nested setup, keymap wrap/filter, Files/answers gates, due-brief projection, memory `source:'tui'`, and UX-BENCH-13 `@inkjs/ui` mount are green. Semantic audit below holds.

---

CHECK: B2
COMMAND: npm test
EXIT: 0
PASS_EVIDENCE: 683 pass / 0 fail / 1 skipped of 684 (`# tests 684`). The B1 rewrite set is inside this glob and is green. The single skip is environmental: `tests/tailored-resume.test.js` `t.skip('tectonic and/or Poppler utilities not installed')` on the cover-letter PDF render test. CRITIQUE_2 extras are now green: `--agent off` `tui.client === null`; review overlay due set; Files refresh; W09-RECOVERY-01 / W09-RESUME-02. Domain/MCP contracts stayed green while chrome changed.

---

CHECK: B3
COMMAND: npm run smoke
EXIT: 0
PASS_EVIDENCE: Smoke isolated `JOBOS_HOME` under `/tmp/jobos-smoke-6Qwv1w`, returned `"ok": true`, scored 71, packet `receiptState: "confirmed"` with `submissionPerformed: false` and `externalSideEffects: "none"` on human-review, receipt spine, W03–W08, and networking; no live employer submit.

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

B1 is green on exit and on the extra bar: the rewrite set does not still assert retired chrome. Nested setup persistence, keymap wrap/filter, Files/answers gates, due-brief projection, and memory TUI mediation now match the locked IA. Coverage holes called in CRITIQUE_2 are closed in product tests; one identity-loop omission remains in UX-BENCH-08 and is covered elsewhere in the same glob.

### Production `@inkjs/ui` usage

Product tree is Ink + React 19 via `src/tui.js` → `src/tui/runtime.js` (`startTui` / `JobosTui`) and `src/tui/render.js` (`renderToString`). CLI `jobos tui` dynamically imports `startTui`; `spike:ink` is not the product entry.

`@inkjs/ui` is a production dependency and is mounted:

- `src/tui/components.js` imports `ThemeProvider` and `Spinner`. `App` wraps the tree in `ThemeProvider` with `INKUI_THEME`. Header `working` mounts `Spinner`.
- `src/tui/theme.js` extends Badge / Spinner / StatusMessage tokens onto Classic red (`#111111` / `#ff6b6b` / JetBrains Mono). Badge and StatusMessage are still never mounted as widgets.
- UX-BENCH-13 (green) imports `ThemeProvider`, `Spinner`, and `INKUI_THEME` from the product facade, asserts Classic accent on Badge/Spinner tokens, and matches `/working/` both on a mounted Spinner and on the App header while `state.working` is true.

The stack is proven for ThemeProvider + Classic `INKUI_THEME` + one real widget (Spinner). Unused Badge/StatusMessage keys are not a B1 fail by themselves.

### Snapshot no-fabrication

B4’s isolated empty `--snapshot` did not invent visualizer listings (Northstar / Harbor / Example Learning Co / Contoso / Lumen) and did not spawn ACP. UX-BENCH-09 and KEYMAP-06 keep `model.empty.noProfile` / `noJobs` true on a genuinely empty store and after Esc skip. SETUP-01 continues welcome → setup without inventing rows.

Setup writes now persist through the TUI journey: SETUP-05 paste lands `setup-proof-review` with a canonical resume revision; SETUP-07/08/12 import, score, and complete materials into SQLite. First-run honesty holds on skip/empty and on the required journey.

### Retired chrome absence

Header wordmark `JobOS` (no space) is painted; box-drawing `┌ JOBS` / `SELECTED JOB` / `┌ ASSISTANT`, colon bars, `spike:ink`, and numeric `FIT n` row chrome were not observed in passing screens or B4.

SETUP-02 (green) matches `SET UP JOBOS — \d/7 ESSENTIAL` and `doesNotMatch(/JOBOS ·/)`. UX-BENCH-02/08 pass `assertNoRetiredChrome` on welcome and setup. B4 also does not match `JOBOS ·`. Nested kickers use `SETUP ·` / `FILES ·` identity copy, which is current Classic chrome, not the retired `JOBOS ·` header token. The rewrite set no longer *requires* the retired token.

### Locked IA / domain / human-gate coverage vs actual product

Tests that exist and pass (product meets the locked IA):

1. Ink product entry / `jobos tui` — covered by `JobosTui`/`renderTui`/`startTui`; CLI snapshot proven in B4; UX-BENCH-13 proves the `@inkjs/ui` mount.
2. One person, one profile in the TUI. No profile-switcher chrome — SETUP-13 and W09-RECOVERY-01 bind the workspace profile (`alex-chen` / `alpha`).
3. Welcome → setup; Skip/Esc invents nothing — SETUP-01 and KEYMAP-06 pass.
4. Setup step ids/labels — SETUP-02 labels match `SETUP_STEP_LABELS` and no longer asserts retired `JOBOS ·`.
5. Nested setup pickers call real domain — SETUP-04 opens `setup-resume-source`; SETUP-05 Enter enters `resume-paste` then `setup-proof-review`; SETUP-06 verifies/adds/drops proofs; SETUP-07 opens `setup-job-source` and persists the listing; SETUP-11 keeps unsupported paths; SETUP-08/12 score and complete materials.
6. Left rail New | Jobs; Add to Jobs moves the row — RAIL-01 and RAIL-02 pass.
7. Action chips not numeric FIT — UX-BENCH-04/05 pass with deterministic chip precedence (`Needs review` / `Create files` / `Find people` / `Due follow-up`).
8. Job | People | Chat tabs, Tab/Shift+Tab — UX-BENCH-06 pass; KEYMAP-01 third Tab wraps Chat → Job.
9. Job = rundown + Create files + Tracker; People = this listing, no Network button; Chat = this-job composer — People/Chat copy asserted; KEYMAP-09 opens `connection` with `/Record contact \(r\)/`. GATE-03/04 open connection from Network/People.
10. Composer only on Chat and Workspace — UX-BENCH-06; KEYMAP-07 `g`/`G` toggles Workspace|Jobs.
11. Slash menu above prompt, filters, arrows+Enter, Esc clears `/`, `/` on Job/People jumps to Chat — KEYMAP-02/03/04/05/11 pass; KEYMAP-03 `/f` no longer paints `/tracker`.
12. Slash catalog `/create-files` `/find-people` `/network` `/tracker` `/review` `/daily` `/chat` `/jobs` `/workspace` `/memory` `/setup` — UX-BENCH-12 catalog ids + live handlers pass.
13. `/create-files` writes real artifacts — P0/P1 in-process create-files pass; SETUP-08 scores the imported job and writes files.
14. Files overlay resume.md + questions.md Approve/Reject via `source:'tui'` — ART-01 restricted-gate copy; ART-02/03 audits; ART-04 refuse approve/reject on questions.md.
15. Tracker mutates this job; packet freeze; human-only attest — ART-05/06/07 pass; packet `created_by_source='tui'`; receipt `source='tui'`.
16. `/find-people` stages this listing / Workspace keep-skip — GATE-05/06/07 pass (keep promotes, skip suppresses, profile research opens `people-review`).
17. `/network` overlay; person → connection; record contact / mark-sent human-only — GATE-01/02/03/04/09 pass; KEYMAP-09 copy holds.
18. `/review` morning brief, not Updates inbox — RAIL-04 projects the real due set; RAIL-05 Enter on a brief draft opens `files`.
19. `/memory` over real projections; accept/reject/revoke human-only — W08-TUI-01/01b list alpha and exclude beta; W08-TUI-02 accept/reject/revoke persist `source:'tui'` / `actor:'user'` on the listed proposal; W08-TUI-03 MCP/ACP denied, trusted TUI accept completes.
20. `/daily` `/jobs` `/workspace` `/chat` `/setup` — RAIL-03; `/setup` reopen binds the workspace profile (SETUP-13).
21. ACP off/unavailable invents no replies — ACP-01/02 pass. B2 `--agent off` assigns `this.client === null`, `agentState` is `off`, and no session file is written.
22. Human-only tools stay TUI/CLI; MCP catalog excludes them — ACP-05 / ART-07 / GATE-09 / W08-TUI-03 / B5 hold. ANSW-01 denies mcp/acp.
23. External apply/send default off — ACP-07 / ART-09 pass; B3 `submissionPerformed: false`.
24. Out of scope (interview pane, career-ops, extra rails, Updates, profile switcher, colon bar, filters 1–7) — KEYMAP-10 / ANSW-05 / W07 locked-IA absence tests pass.

Overlay-family note in UX-BENCH-08: the identity loop still omits `setup-proof-review`, keep/skip (`people-review`), and `connection`. Those overlays exist in `overlayContent` (`SetupProofOverlay`, `PeopleReviewOverlay`, `ConnectionOverlay`) and are proven in SETUP-06 / GATE-05–07 / GATE-03–04 / KEYMAP-09. That is a single-test coverage gap, not missing proof in the rewrite set, and not retired-chrome assertion. Not a B1 fail.

### Human-gate / no-fabrication (B2–B5)

- `src/capabilities.js` `HUMAN_ONLY_DOMAIN_TOOLS` still maps `agentEligible=false` / `mediation=trusted_cli_or_tui_only`. B5 JSON matches. MCP catalog excludes those names (ART-07 / GATE-09 / W08-TUI-03).
- Trusted TUI wrappers pass `{ source: 'tui' }` from `src/tui/runtime.js` for artifact approve/reject, packet freeze, attest, contact record, and memory transitions.
- Empty first-run and missing ACP do not invent jobs, proofs, contacts, companies, replies, or receipts (B4, UX-BENCH-09, ACP-01/02, GATE-02).
- Smoke packet is receipt-confirmed with `submissionPerformed: false` and `externalSideEffects: "none"`.

No 9/10. No partial credit. B1–B5 all hold. Verdict is **PASS**.