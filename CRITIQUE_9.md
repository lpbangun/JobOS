# CRITIQUE_9 — Iteration 2

Critic scope. No product TUI, tests, or `BENCHMARK.md` were edited by this critique. Only this file was written.

Node precondition: `v22.22.3`.

Frozen bar re-run after parent-reported B8 footer-hint fix (`n New   j Jobs` omitted while welcome is covering). B1–B15 executed one at a time from the repository root. B2 was re-run in this session (not inherited). B13 and B15 are live Hermes; session ids and `score_json` below are from those runs.

---

CHECK: B1
COMMAND:
```bash
node --test --test-concurrency=1 \
  tests/tui-*.test.js \
  tests/guided-setup-navigation.test.js \
  tests/p0-p1-first-run-ux.test.js \
  tests/w08-career-memory-tui.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 112`, `# pass 110`, `# fail 0`, `# skipped 2` (ACP-12 and ACP-13 `JOBOS_LIVE_ACP=1` only), `# duration_ms 51583.568757`.

---

CHECK: B2
COMMAND:
```bash
npm test
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 699`, `# pass 696`, `# fail 0`, `# skipped 3`, `# duration_ms 1023711.724296`. Re-run in this session; not inherited.

---

CHECK: B3
COMMAND:
```bash
npm run smoke
```
EXIT: 0
PASS_EVIDENCE: JSON `"ok": true`, root `/tmp/jobos-smoke-YAUr5I`, `score: 71`, `receiptSpine.receiptState: "confirmed"`, `submissionPerformed: false`, `externalSideEffects: "none"`.

---

CHECK: B4
COMMAND: exact isolated Node wrapper in `BENCHMARK.md` (`jobos-bench-snapshot-`).
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B5
COMMAND:
```bash
node src/cli.js agent-guide --json
```
EXIT: 0
PASS_EVIDENCE: JSON parsed. `architecture.interactive` is `tui`, `sideEffects` is `default-off`, exit codes `0/1/2`. Command `tui` lists `--agent off`, `--snapshot`, `--width <columns>`, `--height <rows>`. Human-only tools (`approve_artifact`, `reject_artifact`, `create_application_packet`, `attest_application_submitted`, `answers_add`, `approve_contact`, `network_contact_record`, `mark_outreach_sent`, `accept_memory_proposal`, `reject_memory_proposal`, `revoke_memory_proposal`) have `agentEligible === false` / `mediation: "trusted_cli_or_tui_only"`.

COMMAND:
```bash
node src/cli.js score
```
EXIT: 2
PASS_EVIDENCE: stderr `jobos: Missing job id`.

---

CHECK: B6
COMMAND: exact `BENCHMARK.md` 80×24 wrapper.
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B7
COMMAND: exact `BENCHMARK.md` 140×42 wrapper.
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B8
COMMAND: exact `BENCHMARK.md` covering-welcome wrapper.
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0. Welcome identity is open; the rail regex `/\bNew\b.*\bJobs\b/` no longer matches the first-run footer.

---

CHECK: B9
COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 1`, `# pass 1`, `# fail 0`, `# duration_ms 1278.919423`.

---

CHECK: B10
COMMAND:
```bash
node scripts/bench-b10-mouse.mjs
```
EXIT: 0
PASS_EVIDENCE: stdout `B10 PASS: fixed-grid SGR clicks routed to header, rail, rows, panes, overlay, and composer without byte leakage.`

---

CHECK: B11
COMMAND:
```bash
node scripts/bench-b11-direct-surfaces.mjs
```
EXIT: 0
PASS_EVIDENCE: stdout `B11 PASS: New/Jobs, tracker stages, and Network Edit intent each have documented direct keys and fixed-grid clicks.`

---

CHECK: B12
COMMAND:
```bash
node scripts/bench-b12-chat-enter.mjs
```
EXIT: 0
PASS_EVIDENCE: stdout `B12 PASS: bare Enter after /chat dispatched no slash action.`

---

CHECK: B13
COMMAND:
```bash
node scripts/bench-b13-live-grounded.mjs
```
EXIT: 0
PASS_EVIDENCE: Live Hermes ACP `sessionId` `82ca13a3-4ac8-4fc0-ae9d-1ce4dae11a81`, `stopReason: "end_turn"`, `completedScoreToolCall: true`, `scoreAuditDelta: 1`, `scoreJson.contract: "jobos.fit-score.v1"`, `overall: 70`, `sha256: "f676e4b563b5e8f72f200eab3af196a8028c4e1b698fb4b8f11d98afe3242877"`, `reloadVerifiedOnDisk: true`. Isolated `/tmp` workspace via the committed harness.

---

CHECK: B14
COMMAND:
```bash
node scripts/bench-b14-cancel.mjs
```
EXIT: 0
PASS_EVIDENCE: stdout `B14 PASS: Esc cancelled, quarantined, reset the pane, and discarded the late update.`

---

CHECK: B15
COMMAND:
```bash
node scripts/bench-b15-live-resume.mjs
```
EXIT: 0
PASS_EVIDENCE: Live Hermes ACP `firstSessionId` / `resumedSessionId` both `f86780d8-eac1-42ba-9252-39674eaadfd1`, both stops `end_turn`, nonce `B15-350f972f-42db-4db7-a969-95ef7aa8ff1c`, `priorContextRecovered: true`, persisted file `.jobos/acp-sessions.json` under the isolated `/tmp` workspace.

---

VERDICT: pass

B1–B15 all passed. B8, which failed in CRITIQUE_8 because the welcome footer matched `/\bNew\b.*\bJobs\b/`, now exits 0.

## Residual risks

- B6–B8 remain non-TTY `--snapshot` paints, not a live TTY.
- B13/B15 depend on a working local Hermes ACP binary; this pass had one.
- If first-run footer copy again places `New` then `Jobs` on one line, the frozen B8 rail regex will fail.
- No files staged by this critic.

## Files changed by critic

- `CRITIQUE_9.md`
