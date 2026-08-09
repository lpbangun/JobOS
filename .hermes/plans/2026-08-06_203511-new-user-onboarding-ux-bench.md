# JobOS TUI New-User Full-Stack UX Bench

> **For Hermes:** Plan only until Logani approves. Execution = orchestrator + one dogfood Hermes agent as a first-time TUI user. All runtime state is temporary.

**Goal:** Dogfood the **JobOS TUI app** end-to-end as a brand-new user with **Hermes connected in the TUI**, exercise onboarding, navigation, resume generation, connection/network finder, and every primary TUI surface, then return a **benchmark scorecard + experience report**.

**Architecture:** Temp workspace only. Primary interaction surface is `JobosTui` (guided setup overlay + dashboard + overlays + embedded ACP agent pane). CLI is **support only** (init doctor, MCP connect if needed, evidence dumps) — not the main journey.

**Tech Stack:** `node src/cli.js tui`, `src/tui.js` (`JobosTui`, `TUI_KEYMAP`, `onKeypress`), samples, Hermes ACP (embedded), optional `agents connect hermes` for MCP, evidence under `.tmp/onboarding-ux-bench/<run-id>/`.

---

## Scope lock (Logani: TUI-specific)

| In scope | Out of scope for this bench |
|---|---|
| Empty-workspace TUI first run | CLI-only README journey as the scored path |
| Guided setup **inside TUI** (`g`, steps 1–7, Enter actions) | Live LinkedIn/Indeed auth |
| Dashboard navigation, filters, priority strip, help `?` | Production employer form submit |
| Resume import UX in setup (paste/path from samples) | Fixing bugs mid-bench (report-only default) |
| Proof validation in setup | Full `npm test` suite unless requested |
| First job intake + fit decision in TUI | Checkout `.jobos/` pollution |
| Materials generation / review / docs viewer (`o`) | Git commits of evidence |
| Network / connection finder overlay (`n`, `b`) | |
| Discovery overlay (`d`) | |
| Embedded Hermes agent pane (`Tab` / `i` / `a`) with real ACP | |
| Responsive snapshots: 60×20, 80×24, 120×36, 140×42 | |
| Mouse optional pass if time | |

**Product truth:** bare `jobos` / `jobos tui` is the primary human product. On empty workspace, setup opens automatically (`overlay: 'setup'` when `noProfile`).

---

## Current context (verified 2026-08-06)

| Fact | Evidence |
|---|---|
| Branch | `fix/setup-navigation` @ `7aae427` (onboarding + document navigation) |
| Worktree | `/home/logani/.herdr/worktrees/Job App/fix-setup-navigation` |
| Node | v22.22.3 |
| Hermes ACP | `hermes acp --check` → OK |
| Doctor | embedded Hermes ready; external MCP **not** registered on checkout workspace |
| Fixtures | `samples/resume-proof-points.md`, `samples/job-description.md` |
| Required setup steps | `workspace → profile → resume → proofs → intake → decision → materials` |
| Optional setup | `source`, `calibration`, `provider`, `browser`, `network` |
| Drive API | tests use `new JobosTui(store, { stdin, stdout, connectAgent })` + `tui.onKeypress(value, key)` |
| Live TUI | requires TTY; non-interactive: `tui --snapshot --width --height [--json] [--agent off]` |
| Key refs | `TUI_KEYMAP` / `TUI_HANDLED_KEYS` in `src/tui.js:72-106`; README first-run keys |

---

## Isolation (hard)

```text
RUN_ID=<utc>-tui-ux
EVIDENCE=<worktree>/.tmp/onboarding-ux-bench/$RUN_ID
JOBOS_HOME=$(mktemp -d /tmp/jobos-tui-ux-XXXXXX)
```

- All SQLite/mirrors under `$JOBOS_HOME` only.
- Frames, key logs, agent transcripts, scorecard, report under `$EVIDENCE/`.
- Never use checkout `.jobos/` or `jobos-workspace/` for the run.
- One writer only (sql.js).
- End of run: `rm -rf "$JOBOS_HOME"`; keep `$EVIDENCE` (gitignored `.tmp/`) until Logani drops it.
- `git status` must show no new runtime junk in tracked paths.

Evidence layout:

```text
$EVIDENCE/
  env.json
  journey-log.jsonl          # every key sequence + intent + outcome
  frames/                    # text frames after major steps
    00-empty-setup-140x42.txt
    ...
  snapshots/                 # jobos tui --snapshot dumps
  agents/                    # doctor, acp transcript excerpts
  scorecard.json
  REPORT.md
  issues/S*.md
  harness/                   # optional driver script used by agent
```

---

## How the dogfood agent drives the TUI

**Primary method (reliable, matches unit tests): in-process driver**

1. Open store on `$JOBOS_HOME`.
2. Construct `JobosTui` with fake TTY streams (`PassThrough` stdin, capturing stdout), `connectAgent: true` only for agent phases (or false + separate ACP demo if spawn is heavy).
3. Drive with `tui.onKeypress` / `keypressForToken` from `src/tui.js`.
4. After each meaningful action: `renderTui(tui.model, tui.state, { width, height, color: false })` → save frame; append `journey-log.jsonl`.
5. For Hermes-in-pane: prefer real ACP when safe (`connectAgent: true` with timeout), else `npm run acp-demo`-style session against same home and score agent path separately — **note which path in report**.

**Secondary method (optional realism): real PTY**

```bash
# script/tmux/expect style — only if primary path cannot exercise live agent pane
JOBOS_HOME=$JOBOS_HOME node src/cli.js tui --width 140 --height 42
```

Use only for a short agent chat smoke if in-process ACP wiring is blocked. Do not depend on flaky full-PTY automation for the whole journey.

**CLI allowed as scaffolding only:**

- `init --json`, `agents doctor|connect hermes --json`
- `tui --snapshot` cross-checks
- Read-only inspect of `$JOBOS_HOME/jobos-workspace` after TUI mutations
- **Not scored as the user path** if the same action exists in TUI

---

## Persona: Alex (first TUI session)

- Opens JobOS with an empty folder; expects guided setup, not a hollow three-pane dashboard.
- Imports “my resume” via setup (sample markdown path or paste).
- Validates proof highlights with Enter.
- Adds one job they might want (sample JD path/paste).
- Checks fit, chooses pursue, waits for materials.
- Opens documents, tries network/connection finder, discovery if offered.
- Tabs to Hermes, asks: “What should I do next?” and “Summarize fit for the selected job.”
- Uses `?` when stuck; records whether help names the real recovery.
- Quits cleanly with `Q`.
- Never invents facts; never assumes external send succeeded.

---

## Scoring

### Layer A — TUI feature bars (PASS/FAIL)

| Code | Surface | Required proof (all must hold) |
|---|---|---|
| T0 | Harness | Driver runs; frames captured; no uncaught throw on happy path |
| T1 | Empty first paint | Auto setup **or** single welcome with `g  Start guided setup`; no three empty panels (`JOBS`/`SELECTED`/`AGENT` hollow) |
| T2 | Setup navigation | `↑/↓`, `Tab`/`Shift+Tab`, `1`–`7` jump, `r` refresh, `Esc` dashboard, `g` resume setup; `?` context help on a blocked step names reason + recovery |
| T3 | Profile create | Complete profile step in setup; profile id persists after reload/model refresh |
| T4 | Resume import | Source choices visible (paste/browse/path); formats guidance survives compact 60×24; import from sample succeeds; identity review if shown |
| T5 | Proof validation | Enter validates highlight → advances; after required proofs, next step unlocks |
| T6 | Job intake | Add job via setup intake (paste/path); job appears selected on dashboard |
| T7 | Fit decision | Score visible (`FIT`); decision step completable; no crash on `z`/pursue entry |
| T8 | Materials / resume gen | `p` pursue or setup materials action produces resume+cover drafts; status draft/review; docs `o` lists them; content proof-grounded (spot-check sample phrases, no alien employers) |
| T9 | Docs viewer nav | `o`: vertical doc list `↑/↓`; `PgUp`/`PgDn` scrolls body; Esc closes |
| T10 | Connection finder | `n` and/or `b` opens network UI; paths/contacts empty-OK if honest; no fabricated people; pursue people-research reflection if shown |
| T11 | Discovery | `d` opens discovery; run or clear empty/error state without crash |
| T12 | Dashboard nav | Filters `1`–`7`, job list `↑/↓`, priority `←/→`, `e` details toggle, footer keys match live bindings |
| T13 | Review | `r` queue; open draft; approve/reject metadata safe (`submissionPerformed` false / no external side effect) if approve exercised |
| T14 | Hermes embedded | Agent pane focus `Tab`/`i`; real ACP turn grounded in workspace **or** documented blocker with doctor evidence; `--agent off` never spawns |
| T15 | Responsive | Frames at 60×20, 80×24, 120×36, 140×42: no overflow rows (string-width), min size shows resize guidance if below min, compact chat page via Tab |
| T16 | Clean quit | `Q` exits without corrupting DB; reopen snapshot still coherent |

**Feature pass rate** = PASS / attempted. Gate: **≥ 90%**, **zero S1**.

Severity: S1 crash/data loss/safety; S2 wrong/missing TUI contract vs README; S3 cosmetic/doc drift.

### Layer B — Experience (1–5, weighted)

| Dim | Weight | What “5” looks like in the TUI |
|---|---|---|
| D1 First-run clarity | 15% | Setup owns the empty state; next action always obvious |
| D2 Onboarding completion | 15% | All 7 required steps finish in-TUI without CLI bailout |
| D3 Navigation | 15% | Keys, setup jumps, docs list, overlays match mental model; `?` sufficient |
| D4 Resume → materials | 15% | Import → proofs → tailored drafts reviewable in `o` |
| D5 Connection finder | 10% | Network UI usable or honestly empty with recovery |
| D6 Agent in TUI | 15% | Hermes pane feels connected; answers use local state |
| D7 Trust & safety | 10% | Drafts gated; no fake apply/send |
| D8 Time-to-value | 5% | Scripted driver reaches materials without dead ends (wall clock recorded) |

Overall `/10` = weighted_avg × 2.

| /10 | Label |
|---|---|
| 9.0–10 | Ship-ready TUI first run |
| 7.0–8.9 | Strong; polish |
| 5.0–6.9 | Usable; material friction |
| <5 | Broken first run |

---

## Journey script (TUI-ordered)

Each step: keys → wait model settle → frame dump → log → classify failures.

### J0 — Env + Hermes readiness (support CLI)

```bash
export JOBOS_HOME=...
node src/cli.js --workspace "$JOBOS_HOME" init --json
node src/cli.js --workspace "$JOBOS_HOME" agents doctor hermes --json | tee "$EVIDENCE/agents/doctor.json"
# Optional MCP (config side effect — only if Logani approved default):
# node src/cli.js --workspace "$JOBOS_HOME" agents connect hermes --dry-run --json
# node src/cli.js --workspace "$JOBOS_HOME" agents connect hermes --json
```

Snapshot control:
```bash
node src/cli.js --workspace "$JOBOS_HOME" tui --agent off --snapshot --width 140 --height 42 | tee "$EVIDENCE/snapshots/empty.txt"
```

### J1 — First paint / auto-setup (T0, T1)

- Start `JobosTui` on empty store.
- Expect `state.overlay === 'setup'` **or** welcome centering with primary `g`.
- Frame at 140×42 and 80×24.
- Fail S2 if three hollow dashboard panels on empty home.

### J2 — Setup navigation drill (T2)

Without completing work yet:

- `1`–`7` jump required steps; confirm highlight/summary changes.
- `Tab` / `Shift+Tab` move actions.
- `?` on blocked resume-before-profile: reason + recovery.
- `Esc` → dashboard/welcome; `g` back to setup.
- `r` refresh.

### J3 — Profile (T3)

- Select profile step → Enter → create flow.
- Name: `Alex Chen` (type into field; exercise cursor keys once).
- Confirm save; step status complete; profile selected.

### J4 — Resume import (T4)

- Resume step → choose **Enter a file path** or paste.
- Path: absolute path to `samples/resume-proof-points.md` (copy under `$EVIDENCE/fixtures` first).
- Complete identity review if presented.
- Confirm canonical/projection exists under `$JOBOS_HOME/jobos-workspace/profiles/.../resume/` after step.

### J5 — Proofs (T5)

- On proofs step: `Enter` validates each required highlight; finish auto-advance.
- Reject/edit path: optional one edit if UI offers — record friction.
- Step complete only when product says so.

### J6 — Intake job (T6)

- Intake step → path or paste `samples/job-description.md`.
- Job selected; dashboard would show title/company after Esc.

### J7 — Decision / fit (T7)

- Decision step and/or dashboard `z` score.
- Frame must show FIT summary (not only technical dump).
- Choose pursue when prompted.

### J8 — Materials + resume generation (T8, T9)

- Setup materials action and/or dashboard `p` pursue.
- Bound wait (e.g. 3–5 min stages); capture progress UI copy.
- `o` docs: list resume + cover; open each; scroll; spot-check text against sample proofs.
- `r` review queue if materials landed there.

### J9 — Connection finder (T10)

- From dashboard: `n` network overlay; `b` build-network if distinct.
- Record empty vs populated; any pursue people-research output mirrored in UI.
- S1 if crash; S2 if fabricated contacts without sources.

### J10 — Discovery + filters (T11, T12)

- `d` discovery overlay; attempt daily/run if affordance clear.
- Cycle filters `1`–`7`; priority `←/→`; `e` toggle details.
- Compact 60×20: Tab chat page vs dashboard still reachable.

### J11 — Hermes in TUI (T14)

- Ensure agent not `--agent off`.
- `Tab` or `i`: focus chat; send:
  1. `What is my setup status and next action?`
  2. `Summarize fit evidence for the selected job.`
- Pass: session starts; reply references local profile/job/setup (not generic hello-only); no credential leak in frame/log.
- Also verify `tui --agent off --snapshot` does not attempt ACP (doctor/process).

### J12 — Responsive matrix (T15)

Re-render key states (empty setup, mid-setup, populated dashboard, docs, help) at four sizes; assert frame height and max line width.

### J13 — Quit + reopen (T16)

- `Q` clean shutdown.
- New TUI/snapshot on same `$JOBOS_HOME`: profile, job, drafts still present; setup residual steps honest.

### J14 — Score + report

Agent writes `scorecard.json` + `issues/*` + draft `REPORT.md`. Orchestrator verifies 2–3 S1/S2 claims, finalizes report, deletes `$JOBOS_HOME`.

---

## Orchestration

```text
Logani: approve plan
        │
        ▼
Orchestrator
  ├─ RUN_ID, EVIDENCE, JOBOS_HOME
  ├─ env.json + doctor + empty snapshot
  ├─ optional tiny F0: tests/tui-ux-benchmark + guided-setup-navigation + w09 (not the UX score)
  ├─ delegate_task → Dogfood Hermes (Alex)
  │     full plan path + JOBOS_HOME + EVIDENCE + keymap cheat sheet
  │     implements/runs harness; completes J1–J13
  │     returns scorecard + frames
  ├─ verify claims + git status clean
  ├─ finalize REPORT.md
  ├─ rm -rf JOBOS_HOME
  └─ chat: /10, pass table, top issues, report path
```

**One dogfood agent** (not parallel feature agents): TUI state is sequential; one persona = one coherent experience narrative.

---

## Keymap cheat sheet (driver)

Global: `↑↓` select · `←→` priority · `Enter` jump · `Tab` chat · `g` setup · `o` docs · `r` review · `n` network · `b` build-network · `d` daily/discovery · `p` pursue · `z` score · `i`/`a` agent · `e` details · `?` help · `Q` quit  

Setup: `↑↓` step · `Tab`/`Shift+Tab` · `1–7` required · `Enter` action · `c` change · `r` refresh · `Esc` close  

Docs: `↑↓` document · `PgUp/PgDn` scroll · `Esc` close  

Review: `Enter` open · `A` approve · `R` reject · `Esc` close  

---

## REPORT.md skeleton

1. Executive scorecard (feature %, experience /10, label)
2. Environment (branch, sha, hermes, sizes tested)
3. Journey timeline + wall clock to materials
4. Frame gallery index (paths)
5. What felt good (TUI-specific)
6. Issues table (severity, surface, repro keys, expected/actual, frame path)
7. Dimension scores with one frame quote each
8. Hermes pane findings
9. Safety
10. Gaps vs README first-run promises
11. P0/P1/P2 recommendations (no code in this mission)
12. Not tested

---

## Risks

| Risk | Mitigation |
|---|---|
| Live ACP slow/flaky in headless | Timeouts; fallback acp-demo against same home; score D6 honestly |
| Setup flows need multi-field editing | Reuse patterns from `tests/tui-ux-benchmark.test.js` (`captureProfile`, etc.) |
| Agent mutates `src/` | Brief forbids; orchestrator git status |
| MCP connect edits global Hermes config | Default: **dry-run only** unless Logani says connect; embedded ACP is the TUI path under test |
| Long pursue | Cap wait; partial materials still scored; S2 if silent hang |

---

## Defaults if Logani says “go”

1. Bench **this branch** (`fix/setup-navigation`).
2. **TUI driver primary**; CLI support only.
3. Hermes: **embedded ACP in TUI** required attempt; **MCP connect dry-run only** (no global config write) unless you flip it.
4. Report-only (no fix PR) after scores.
5. Targeted TUI unit files as smoke, not full suite.
6. All state tmp; wipe `JOBOS_HOME` at end.

---

## Open questions (remaining)

1. Allow `agents connect hermes` to write real Hermes MCP config? (default: no, dry-run only)
2. After report: stop vs fix S1/S2 on this branch?
3. Must interactive real-TTY session be part of evidence, or is in-process `onKeypress` + snapshots enough? (default: in-process + snapshots enough; one short real ACP turn if feasible)

---

## Post-approval checklist

- [ ] Create RUN_ID + evidence tree
- [ ] mktemp JOBOS_HOME + init
- [ ] doctor + empty snapshot
- [ ] Spawn dogfood agent with this plan
- [ ] J1–J13 TUI journey
- [ ] scorecard + REPORT.md
- [ ] Verify + wipe JOBOS_HOME
- [ ] Deliver scores to Logani

---

## Planning artifacts

- This file: `.hermes/plans/2026-08-06_203511-new-user-onboarding-ux-bench.md`
- Evidence root (empty until run): `.tmp/onboarding-ux-bench/`

No product code changes in planning.
