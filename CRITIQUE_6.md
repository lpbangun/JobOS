# CRITIQUE_6 — Iteration 3

Critic scope. Product TUI was not edited by this critique. `BENCHMARK.md` was not edited.

Node precondition: `v22.22.3`.

This iteration’s product change (already in the tree from the worker): `src/tui/components.js` compact Workspace|Jobs modebar with left border, contiguous JobOS wordmark, Modal `width: 52` centered panel instead of `78%`.

Host load during this critique was high (`uptime` load average ~27). That is recorded because it affected B2 completion, not because it changes the pass/fail rule.

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
PASS_EVIDENCE: TAP summary `# tests 98`, `# pass 98`, `# fail 0`, `# skipped 0`, `# duration_ms 255118.791833`. Logged in `/tmp/jobos-c6-b1.out`.

---

CHECK: B2
COMMAND:
```bash
npm test
```
EXIT: 124 (command harness timeout; no completed TAP summary)
FAIL_OUTPUT: Three complete-suite attempts this iteration did not emit `# tests` / `# pass` / `# fail`.

- Attempt A (`timeout 1500 npm test` → `/tmp/jobos-c6-b2.out`): killed at 1500s after `ok 150`.
- Attempt B (`timeout 2400 npm test` → same log family): killed at 2400s after `ok 270`; one observed failure before the kill:
  ```
  not ok 164 - greenhouse adapter: fixture-backed search runs
  location: tests/lean-cli-advisor.test.js:363
  error: discover run-all --profile pm
  STDERR:

  STDOUT:

  null !== 0
  ```
  The helper asserts `result.status === 0` but `spawnSync` returned `status: null` (killed/timeout), not a product assertion about TUI chrome.
- Attempt C (`timeout 2400 npm test` → `/tmp/jobos-c6-b2b.out`): killed at 2400s after `ok 270` (`readiness: ready-for-review…`, duration_ms 111154). No final suite summary.

A targeted retry of the greenhouse test alone also timed out (`timeout 60` → exit 124, TAP header only).

B2 is therefore **fail** for this critique: the frozen command did not exit 0 with a complete TAP summary.

---

CHECK: B3
COMMAND:
```bash
npm run smoke
```
EXIT: 0
PASS_EVIDENCE: Smoke JSON `"ok": true`, isolated root `/tmp/jobos-smoke-VoySCZ`, `score: 71`, `receiptSpine.receiptState: "confirmed"`, `submissionPerformed: false`, `externalSideEffects: "none"` on humanReview / receiptSpine / w03 / w04 / networking / w07 / w08.

---

CHECK: B4
COMMAND: exact isolated Node wrapper in `BENCHMARK.md` (`jobos-bench-snapshot-`, `tui --snapshot --width 140 --height 42 --agent off`).
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B5
COMMAND:
```bash
node src/cli.js agent-guide --json
```
EXIT: 0
PASS_EVIDENCE: JSON `architecture.interactive: "tui"`, `architecture.sideEffects: "default-off"`, exit codes `0/1/2`. `tui` usage/flags are `--agent off`, `--snapshot`, `--width <columns>`, `--height <rows>` (no `--mouse`). Required human-only tools `approve_artifact`, `reject_artifact`, `create_application_packet`, `attest_application_submitted`, `answers_add`, `approve_contact`, `network_contact_record`, `mark_outreach_sent`, `accept_memory_proposal`, `reject_memory_proposal`, `revoke_memory_proposal` are `agentEligible: false` / `mediation: "trusted_cli_or_tui_only"`.

COMMAND:
```bash
node src/cli.js score
```
EXIT: 2
PASS_EVIDENCE: stderr `jobos: Missing job id` (matches `^jobos:`).

---

CHECK: B6
COMMAND: exact `BENCHMARK.md` 80×24 wrapper (`jobos-bench-live-80-`).
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B7
COMMAND: exact `BENCHMARK.md` 140×42 wrapper (`jobos-bench-live-140-`).
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B8
COMMAND: exact `BENCHMARK.md` covering-welcome wrapper (`jobos-bench-overlay-`).
EXIT: 0
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B9
COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 1`, `# pass 1`, `# fail 0`, `# duration_ms 9723.898885`.

---

VERDICT: fail

Failing check: B2 (`npm test` did not complete with exit 0). B1 and B3–B9 passed.

## Residual risks

- Host load average was ~27 during B2. The greenhouse `null !== 0` looks like `spawnSync` timeout/kill, not a TUI chrome regression. That does not make B2 pass.
- Iterations 1–2 already had B2 exit 0 (684 pass / 1 allowed PDF skip) on this same product family. This critique does not reuse those older runs as this iteration’s B2 evidence.
- B6–B8 remain non-TTY snapshot wrappers.
- The worktree is broadly dirty from prior iterations; this critique staged nothing.

## Files changed by critic

- `CRITIQUE_6.md`
