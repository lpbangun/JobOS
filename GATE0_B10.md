# Gate 0 confirmation — B10–B15 freeze

Gate 0 verdict: **frozen**.

This artifact records only the benchmark freeze. No product TUI or `src/` file was edited, and `CRITIQUE_8.md` was not created.

## Freeze integrity

- Pre-append whole-file SHA-256 (`BENCHMARK.md`): `85ddd3d2daaa18ffebdfb847048e8ec7272ce230074fa40f3b5d0881eeeda9f4`
- Post-append whole-file SHA-256 (`BENCHMARK.md`): `52f12ba7f8fb59d82340f2259b72173e024555ba0a670173fe8cfd8ef0cd0687`
- Pre-append B1–B5 region SHA-256: `bac8bc571c22b1b4639e78ac5fba69c48caee96e1c4d491710f57a52aa5f3a9f`
- Post-append B1–B5 region SHA-256: `bac8bc571c22b1b4639e78ac5fba69c48caee96e1c4d491710f57a52aa5f3a9f`
- B1–B5 region definition: bytes from `## Check B1` through the line before `## Product invariants` (the raw slice ends immediately before that heading).
- `git diff -- BENCHMARK.md` has one append-only hunk beginning after the former final sentence `B6–B9 are pass/fail only. No partial credit.` No pre-existing line changed.
- The complete original B6–B9 tail compared byte-for-byte with `git show HEAD:BENCHMARK.md`: identical; SHA-256 `4d5f685663d24d9ae54559b4d0a32d852b5be003568ba0ab5daabda163a3ff1a`.
- Individual B6–B9 sections and command snippets compared with `HEAD:BENCHMARK.md`: all identical. Command-text SHA-256 values:
  - B6: `86c3b5572d7d2dd869422f921e14a6c4420e6de222a2e655ff136f592841a14a`
  - B7: `95a2dd0849d7493ebae9ed16f96aa7ade1944a3b2daf1f44fd72c915dbffc968`
  - B8: `b797180c3d107f83aa19f27fce6090b5f2101b1e25612894909ecbf8d75c480d`
  - B9: `6b9459280febe79b30dbbcdf4fadee3c48f89234b96dcb18a5c41a05624c6af9`

## Today's frozen-check evidence

### B10 — fixed-grid SGR mouse routing

Command:

```bash
node scripts/bench-b10-mouse.mjs
```

Exit code: `1` (required fail-today proof).

Fail output:

```text
node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: B10 SGR mouse routing failures:
header Workspace click: Expected values to be strictly equal:
+ actual - expected

+ 'jobs'
- 'workspace'

rail New click: Expected values to be strictly equal:

'jobs' !== 'new'

second rail row click: Expected values to be strictly equal:
+ actual - expected

+ 'job_cea94bc2b731'
- 'job_78c2db318ef1'
       ^

People pane click: Expected values to be strictly equal:

'job' !== 'people'

Chat pane click: Expected values to be strictly equal:

'job' !== 'chat'

covering overlay row click: Expected values to be strictly equal:

0 !== 5

composer send click: Expected values to be strictly deep-equal:
+ actual - expected

+ null
- {
-   scope: 'job',
-   text: 'send this grounded question'
- }

composer byte quarantine: composer send click leaked SGR mouse bytes into the composer
    at file:///home/logani/.herdr/worktrees/Job%20App/exp-tui-migration/scripts/bench-b10-mouse.mjs:67:31 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: undefined,
  operator: 'fail',
  diff: 'simple'
}

Node.js v22.22.3
```

### B11 — direct key and click reachability

Command:

```bash
node scripts/bench-b11-direct-surfaces.mjs
```

Exit code: `1` (required fail-today proof).

Fail output:

```text
node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: B11 direct key/click reachability failures:
documented n key selects New rail: Expected values to be strictly equal:

'jobs' !== 'new'

New rail click: Expected values to be strictly equal:

'jobs' !== 'new'

rail keys are documented: The input did not match the regular expression /n\s+New.*j\s+Jobs/i. Input:

' JobOS 07:31                                                                                              B10 Company 1 │ Workspace │ Jobs\n' +
  ' New                    Jobs                     Job       People    Chat\n' +
  ' Product Manager 2\n' +
  ' B10 Company 2                    Create files    SAVED\n' +
  ' Product Manager 1                                Product Manager 2\n' +
  ' B10 Company 1                    Create files    B10 Company 2 · Remote · Create files\n' +
  '\n' +
  '                                                   Create files   Tracker\n' +
  '                                                  Tab to Chat, then type / like Claude Code. Menu sits on the prompt.\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  ' Ready · local workspace · B10 Company 1\n' +
  ' / in Chat   Tab Job · People · Chat   G Workspace   Esc closes'

tracker saved key: Expected values to be strictly equal:
+ actual - expected

+ 'researching'
- 'saved'

tracker saved click: Expected values to be strictly equal:
+ actual - expected

+ 'researching'
- 'saved'

tracker researching key: Expected values to be strictly equal:
+ actual - expected

+ 'saved'
- 'researching'

tracker researching click: Expected values to be strictly equal:
+ actual - expected

+ 'saved'
- 'researching'

tracker applied key: Expected values to be strictly equal:

'saved' !== 'applied'

tracker applied click: Expected values to be strictly equal:

'saved' !== 'applied'

tracker waiting key: Expected values to be strictly equal:

'saved' !== 'waiting'

tracker waiting click: Expected values to be strictly equal:

'saved' !== 'waiting'

tracker direct-stage keys are documented: The input did not match the regular expression /1\s+saved.*2\s+researching.*3\s+applied.*4\s+waiting/is. Input:

' JobOS 07:31                                                                                              B10 Company 1 │ Workspace │ Jobs\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '                                              TRACKER · THIS JOB\n' +
  '                                              B10 Company 1\n' +
  '                                              Product Manager 1\n' +
  '                                              STATUS · saved\n' +
  '\n' +
  '                                               saved   researching   materials-ready\n' +
  '\n' +
  '                                               applied   recruiter-screen   interview\n' +
  '\n' +
  '                                               offer\n' +
  '\n' +
  '\n' +
  '                                              saved                                    current\n' +
  '\n' +
  '                                              researching                                  set\n' +
  '\n' +
  '                                              materials-ready                              set\n' +
  '\n' +
  '                                              applied                              attest only\n' +
  '\n' +
  '                                              recruiter-screen                     attest only\n' +
  '\n' +
  '                                              interview                            attest only\n' +
  '\n' +
  '                                              offer                                attest only\n' +
  '\n' +
  '                                              Freeze packet                          no packet\n' +
  '\n' +
  '                                              Attest submitted                            none\n' +
  '                                              Readiness · blocked — Review pursuit decision\n' +
  '                                              ↑/↓ pick a stage or action · Enter applies · f …\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  ' Ready · local workspace · B10 Company 1\n' +
  ' / in Chat   Tab Job · People · Chat   G Workspace   Esc closes'

network i key opens Edit intent: Expected values to be strictly equal:
+ actual - expected

+ null
- 'network-intent'

network Edit intent click: Expected values to be strictly equal:
+ actual - expected

+ null
- 'network-intent'

network Edit intent key is documented: The input did not match the regular expression /i\s+Edit intent/i. Input:

' JobOS 07:31                                                                                              B10 Company 1 │ Workspace │ Jobs\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '                                              NETWORK · PROFILE\n' +
  '                                              Graph\n' +
  '                                              Intent · publicWeb\n' +
  '                                              total 0 · strategic 0 · hot 0 warm 0 cool 0 col…\n' +
  '                                              No stored relationships yet. Configure intent i…\n' +
  '                                              ↑/↓ choose · Enter opens connection · g queries…\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  '\n' +
  ' Ready · local workspace · B10 Company 1\n' +
  ' / in Chat   Tab Job · People · Chat   G Workspace   Esc closes'

    at file:///home/logani/.herdr/worktrees/Job%20App/exp-tui-migration/scripts/bench-b11-direct-surfaces.mjs:60:31 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: undefined,
  operator: 'fail',
  diff: 'simple'
}

Node.js v22.22.3
```

### B12 — bare Enter after `/chat`

Command:

```bash
node scripts/bench-b12-chat-enter.mjs
```

Exit code: `1` (required fail-today proof).

Fail output:

```text
node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: bare Enter after /chat dispatched domain slash action(s): create-files
+ actual - expected

+ [
+   'create-files'
+ ]
- []

    at file:///home/logani/.herdr/worktrees/Job%20App/exp-tui-migration/scripts/bench-b12-chat-enter.mjs:16:10 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [ 'create-files' ],
  expected: [],
  operator: 'deepStrictEqual',
  diff: 'simple'
}

Node.js v22.22.3
```

### B13 — real Hermes grounded tool call

Command:

```bash
node scripts/bench-b13-live-grounded.mjs
```

Exit code: `0` (honest live pass today; the frozen command still requires every specified evidence item).

Live output:

```json
{
  "ok": true,
  "backend": "hermes-acp",
  "sessionId": "3335a99f-6b9c-4267-af9a-91c07ff393fb",
  "stopReason": "end_turn",
  "jobId": "w10-mcp-job",
  "scoreAuditDelta": 1,
  "scoreJson": {
    "contract": "jobos.fit-score.v1",
    "overall": 70,
    "sha256": "9dc29e507cb499ce2d76d04d24ee94a818c20ffc8ee35d6f0bfc348532dd10ba"
  },
  "reloadVerifiedOnDisk": true,
  "completedScoreToolCall": true
}
```

This is real evidence from an isolated `/tmp/jobos-b13-live-*` workspace. The harness reopened SQLite before asserting the score contract, audit delta, and hash, then removed the throwaway workspace.

### B14 — in-pane cancellation

Command:

```bash
node scripts/bench-b14-cancel.mjs
```

Exit code: `1` (required fail-today proof).

Fail output:

```text
node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: B14 in-pane cancel failures:
cancel notification: Esc while working must call AcpClient.cancel exactly once
+ actual - expected

+ []
- [
-   {
-     method: 'session/cancel',
-     params: {
-       sessionId: 'b14-live-turn'
-     }
-   }
- ]

session quarantine: cancelled session must be quarantined
+ actual - expected

+ null
- 'b14-live-turn'

quarantine reason: Expected values to be strictly equal:
+ actual - expected

+ null
- 'cancelled'

pane working reset: pane must leave working state after in-pane cancel

true !== false

pane agent reset: pane agent state must be ready/off, got working
late update discarded: late quarantined session update was not discarded
late text quarantined: late agent text escaped quarantine

true !== false

    at file:///home/logani/.herdr/worktrees/Job%20App/exp-tui-migration/scripts/bench-b14-cancel.mjs:44:31 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: undefined,
  operator: 'fail',
  diff: 'simple'
}

Node.js v22.22.3
```

### B15 — real Hermes session resume across launches

Command:

```bash
node scripts/bench-b15-live-resume.mjs
```

Exit code: `0` (honest live pass today, accepted by the supervisor rather than fabricating a failure).

Live output:

```json
{
  "ok": true,
  "backend": "hermes-acp",
  "firstSessionId": "316ca2ea-748e-4e93-ad23-3394dd45d311",
  "resumedSessionId": "316ca2ea-748e-4e93-ad23-3394dd45d311",
  "firstStopReason": "end_turn",
  "resumedStopReason": "end_turn",
  "nonce": "B15-83bb155c-d54b-4f3a-acaa-dcffe44e520c",
  "priorContextRecovered": true,
  "persistedFile": ".jobos/acp-sessions.json"
}
```

The nonce was generated for this isolated run, appeared only in the first turn, and was found in real agent-message text after a new `AcpClient`/Hermes process loaded the persisted id. The harness also read `.jobos/acp-sessions.json` and asserted that id on disk.

## Additional validation

- `node --check` passed for all seven `scripts/bench-b1*.mjs` files.
- `git diff --check` exited `0`.
- `git diff --name-only -- src` was empty (`SRC_UNTOUCHED`).
- `git diff --cached --quiet` exited `0` (`NO_STAGED_FILES`).
- No files were added under `tests/`; B1's `tests/tui-*.test.js` glob is unaffected.

## Files changed

- `BENCHMARK.md` — append-only B10–B15 frozen pass bar.
- `GATE0_B10.md` — this confirmation artifact.
- `scripts/bench-b10-fixture.mjs` — isolated local controller fixture shared by B10–B12/B14.
- `scripts/bench-b10-mouse.mjs` — B10 fixed-grid SGR routing harness.
- `scripts/bench-b11-direct-surfaces.mjs` — B11 direct key/click harness.
- `scripts/bench-b12-chat-enter.mjs` — B12 stray-Enter harness.
- `scripts/bench-b13-live-grounded.mjs` — B13 bounded real-Hermes/SQLite harness.
- `scripts/bench-b14-cancel.mjs` — B14 cancellation/quarantine harness.
- `scripts/bench-b15-live-resume.mjs` — B15 bounded real-Hermes resume harness.

## Residual risks

- B13 and B15 intentionally depend on the specified absolute Hermes executable and its locally usable ACP/model configuration; missing prerequisites fail honestly.
- B10/B11 intentionally freeze the 140×42 hit grid. Layout changes must retain those target coordinates or update product hit-testing without changing this bar.
- B15 already passes today; it guards regression rather than exposing a current gap. B13 likewise passes today.
- A forced 180-second hard timeout exits `124` and may leave a throwaway `/tmp/jobos-b13-live-*` or `/tmp/jobos-b15-resume-*` directory for later cleanup; it never targets a personal workspace.
- The repository already contains unrelated untracked `.hermes/` and `.pi/` files. They were not changed or staged by this Gate 0 work.
