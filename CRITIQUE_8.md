# CRITIQUE_8 — Iteration 1

Critic scope. No product TUI, tests, or `BENCHMARK.md` were edited by this critique. Only this file was written.

Node precondition: `v22.22.3`.

Frozen bar re-run after parent-reported suite convergence. B1–B15 executed one at a time from the repository root. B2 was re-run in this session (not inherited). B13 and B15 are live Hermes; session ids and `score_json` below are from those runs.

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
PASS_EVIDENCE: TAP `# tests 112`, `# pass 110`, `# fail 0`, `# skipped 2` (ACP-12 and ACP-13 `JOBOS_LIVE_ACP=1` only), `# duration_ms 51034.846252`.

---

CHECK: B2
COMMAND:
```bash
npm test
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 699`, `# pass 696`, `# fail 0`, `# skipped 3`, `# duration_ms 1024379.251077`.

---

CHECK: B3
COMMAND:
```bash
npm run smoke
```
EXIT: 0
PASS_EVIDENCE: First invocation this pass exited 0. JSON `"ok": true`, root `/tmp/jobos-smoke-KBRceV`, `score: 71`, `receiptSpine.receiptState: "confirmed"`, `submissionPerformed: false`, `externalSideEffects: "none"`.

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
PASS_EVIDENCE: JSON parsed. `architecture.interactive` is `tui`, `sideEffects` is `default-off`, exit codes `0/1/2`. Command `tui` lists `--agent off`, `--snapshot`, `--width`, `--height`. Human-only tools (`approve_artifact`, `reject_artifact`, `create_application_packet`, `attest_application_submitted`, `answers_add`, `approve_contact`, `network_contact_record`, `mark_outreach_sent`, `accept_memory_proposal`, `reject_memory_proposal`, `revoke_memory_proposal`) have `agentEligible === false` / `mediation: "trusted_cli_or_tui_only"`.

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
EXIT: 1
FAIL_OUTPUT:

```
AssertionError [ERR_ASSERTION]: welcome exposes New | Jobs rail: / in Chat   Tab Job · People · Chat   n New   j Jobs   G Workspace   Esc closes
+ actual - expected

+ [
+   'welcome exposes New | Jobs rail: / in Chat   Tab Job · People · Chat   n New   j Jobs   G Workspace   Esc closes'
+ ]
- []
```

The frozen rail regex `/\bNew\b.*\bJobs\b/` matched the first-run footer hint (`n New   j Jobs`), not a painted left-rail strip. That is still a B8 fail.

---

CHECK: B9
COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 1`, `# pass 1`, `# fail 0`, `# duration_ms 1315.310238`.

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
PASS_EVIDENCE: Live Hermes ACP `sessionId` `bdbf8c8f-734a-43d3-a799-6f1ed7778aa9`, `stopReason: "end_turn"`, `completedScoreToolCall: true`, `scoreAuditDelta: 1`, `scoreJson.contract: "jobos.fit-score.v1"`, `overall: 70`, `sha256: "f41fefc80785f418a158ad66f92d535b26c7537ee63d4f5966abaa6b66bd712f"`, `reloadVerifiedOnDisk: true`.

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
PASS_EVIDENCE: Live Hermes ACP `firstSessionId` / `resumedSessionId` both `0d28cb6d-7247-4562-b378-320ba8b3bae8`, both stops `end_turn`, nonce `B15-6c11c7c8-4a5e-4bb6-a8d6-83652b340cc5`, `priorContextRecovered: true`, persisted file `.jobos/acp-sessions.json` under the isolated `/tmp` workspace.

---

VERDICT: fail

Failing check: B8 (welcome covering-overlay wrapper exit 1). B1–B7 and B9–B15 passed.

## Residual risks

- B8 fails because the first-run footer documents `n New` / `j Jobs` on one line. The frozen rail detector does not exclude `/ in Chat` / `Tab` footer copy the way the pane-tab detector does.
- B6–B8 remain non-TTY `--snapshot` paints, not a live TTY.
- B13/B15 depend on a working local Hermes ACP binary; this pass had one.
- No files staged by this critic.

## Files changed by critic

- `CRITIQUE_8.md`
