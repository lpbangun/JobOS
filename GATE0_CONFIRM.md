# GATE 0 CONFIRM

**VERDICT: pass**

Scope was confirmation only. I did not run today’s TUI paint, `npm test`, or `npm run smoke`; did not edit `BENCHMARK.md`, product TUI code, or tests; and did not create a repo-root `GATE0_CONFIRM.md` because the authoritative runtime output override requires this artifact path.

## Frozen bar confirmation

The current `BENCHMARK.md` SHA-256 is:

```text
85ddd3d2daaa18ffebdfb847048e8ec7272ce230074fa40f3b5d0881eeeda9f4
```

That is identical to the final whole-file hash recorded by the original Gate 0 critic. The region from `## Check B1` through the line before `## Product invariants` hashes to:

```text
bac8bc571c22b1b4639e78ac5fba69c48caee96e1c4d491710f57a52aa5f3a9f
```

That is identical to the Gate 0 pre/post stability hash. Therefore B1–B5 remain byte-stable, not merely semantically similar.

The verifier also found these exact B1–B5 command contracts:

- B1: targeted `tests/tui-*.test.js`, guided setup, first-run UX, and W08 Career Memory glob.
- B2: `npm test`.
- B3: `npm run smoke`.
- B4: isolated temporary `JOBOS_HOME` wrapper invoking `src/cli.js tui --snapshot --width 140 --height 42 --agent off`.
- B5: `node src/cli.js agent-guide --json` and `node src/cli.js score`.

Exactly one heading exists for each check B1 through B9. Thus B6, B7, B8, and B9 are present.

## Old-crush predicate evidence

Source fixture: the original Gate 0 record at:

```text
/home/logani/.pi/agent/sessions/--home-logani-.herdr-worktrees-Job App-exp-tui-migration--/subagent-artifacts/outputs/85177cbf-89a4-4ceb-aa32-8a4732a22cbc/gate0.md
```

Its recorded 80×24 and 140×42 first paints each extract to exactly 12 rows. I reapplied the current B6/B7/B8 predicates to those recorded strings, not to today’s product paint.

### B6 against old 80×24 paint

Predicate verifier exit: `1`.

```text
80x24 emitted 12 visual rows; expected at least 23
80x24 last painted row is 12; expected row 23 or 24
rail and pane tabs share one crushed row beside welcome: New         Jobs        Job              People              Chat
welcome overlay exposes left-rail empty copy: No jobs yet · Add to Job…
```

Result: old crush **must fail B6**.

### B7 against old 140×42 paint

Predicate verifier exit: `1`.

```text
140x42 emitted 12 visual rows; expected at least 41
140x42 last painted row is 12; expected row 41 or 42
wide first paint is a crushed navigation strip: New                    Jobs                     Job                          People                           Chat
```

Result: old crush **must fail B7**.

### B8 against old 140×42 paint

Predicate verifier exit: `1`.

```text
welcome exposes New | Jobs rail: New                    Jobs                     Job                          People                           Chat
welcome exposes Job | People | Chat pane tabs: New                    Jobs                     Job                          People                           Chat
welcome exposes left-rail body copy: No jobs yet · Add to Jobs from New
```

Result: old crush **must fail B8**.

These outputs also match the failure evidence recorded at the original freeze. `classic.html` independently confirms the intended invariants: `.term` is full-height, `[data-overlay]` is absolute with `inset: 0`, and `.pbtn` is fixed/content-hugging (`flex: none; width: 5.5rem`).

## Change and repository checks

- File changed by this task: only this authoritative `gate0-confirm.md` artifact.
- Tests added or updated: none.
- `BENCHMARK.md` edits: none.
- Test deletions: none by this task; `git diff --name-status --diff-filter=D` was empty.
- Staged files: none; `git diff --cached --name-only` was empty.
- The worktree remains broadly dirty from pre-existing TUI work; this confirmation neither owns nor alters those files.

## Commands and exits

1. BENCHMARK contract/hash verifier — exit `0`; found exact B1–B5 commands, one B1–B9 heading each, and both frozen hashes.
2. Historical Gate 0 fixture extraction — exit `0`; both captured paints contain 12 rows.
3. B6 predicates applied to historical 80×24 fixture — exit `1`; failure output recorded above.
4. B7 predicates applied to historical 140×42 fixture — exit `1`; failure output recorded above.
5. B8 predicates applied to historical 140×42 fixture — exit `1`; failure output recorded above.
6. `git diff --name-status --diff-filter=D`, `git diff --cached --name-only`, `git diff -- BENCHMARK.md`, and `git status --short` inspection — exit `0`; no tracked deletions, no staged files, and no tracked BENCHMARK diff (BENCHMARK remains untracked in this worktree, so frozen hashes are the authoritative stability proof).
7. One initial historical-block regex extraction probe — exit `1` due to a helper-script JavaScript syntax error; it did not invoke product code or change files. The corrected extraction then exited `0` and produced the evidence above.

## Residual risks

- `BENCHMARK.md` is untracked in this worktree, so Git history cannot establish its baseline. Stability is instead proven against the original Gate 0 recorded whole-file and B1–B5 region SHA-256 hashes.
- Today’s paint and test health were intentionally not evaluated in this confirmation-only task.
