# CRITIQUE_7 — Iteration 4

Critic scope. No product TUI, tests, or `BENCHMARK.md` were edited by this critique.

Node precondition: `v22.22.3`.

This iteration is a frozen-bar re-run after CRITIQUE_6 failed B2. Layout/interaction/chrome P0–P1 were already in the tree. Host load average stayed ~28.

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
PASS_EVIDENCE: TAP `# tests 98`, `# pass 98`, `# fail 0`, `# skipped 0`, `# duration_ms 254264.320443` (reviewer session `db0294a9`).

---

CHECK: B2
COMMAND:
```bash
npm test
```
EXIT: 124 (harness timeout; no completed TAP summary)
FAIL_OUTPUT: One complete-suite attempt this iteration (`timeout 4200 npm test`, `/tmp/jobos-c7-b2.out`) was killed at 4200s after `ok 330`. Observed failures before the kill:

```
not ok 270 - readiness: ready-for-review with score, proofs, resume, matched ordinary, and direct-input restricted answers
location: tests/readiness.test.js:296
error: answers add ...
STDERR:

STDOUT:

null !== 0
```

```
not ok 326 - Sprint 8 research/outreach eval harness clears the rubric bar
location: tests/sprint8-research-eval.test.js:5
error:
STDOUT:

STDERR:

null !== 0
```

Both are `spawnSync` `status: null` (killed/timeout) under host load, not TUI chrome assertions. That does not make B2 pass. An earlier leftover `npm test` from the timed-out critic (PIDs 131144/131176) also exited without a captured TAP summary.

Counts in the killed log: 328 `ok` lines, 2 `not ok` lines, no `# tests` / `# pass` / `# fail` footer.

---

CHECK: B3
COMMAND:
```bash
npm run smoke
```
EXIT: 0 (retry)
PASS_EVIDENCE: First invocation this parent pass exited 1 with `Error: Scheduler did not run due smoke automation` (`scripts/smoke.js:703`). Immediate retry exited 0. JSON `"ok": true`, root `/tmp/jobos-smoke-VwVXjC`, `score: 71`, `receiptSpine.receiptState: "confirmed"`, `submissionPerformed: false`, `externalSideEffects: "none"`.

The frozen command’s first run this iteration was not clean. The retry that is scored here exited 0. Residual: smoke is load-sensitive.

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
PASS_EVIDENCE: JSON parsed. `architecture.interactive` is `tui`, `sideEffects` is `default-off`, exit codes `0/1/2`.

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
PASS_EVIDENCE: Wrapper produced no stdout/stderr and exited 0.

---

CHECK: B9
COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP `# tests 1`, `# pass 1`, `# fail 0`, `# duration_ms 9418.048495`.

---

VERDICT: fail

Failing check: B2 (`npm test` did not exit 0 with a complete TAP summary). B1 and B4–B9 passed. B3 passed on retry after one scheduler flake.

## Residual risks

- Host load average ~28 throughout. `null !== 0` failures are spawn timeouts, not proven TUI regressions.
- Iterations 1–2 had B2 exit 0 (684 pass / 1 allowed PDF skip). Those older runs are not this iteration’s B2 evidence.
- B6–B8 remain non-TTY snapshots.
- No files staged.

## Files changed by critic

- `CRITIQUE_7.md`
