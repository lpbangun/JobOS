# Agent prompt — P0 + Wave 0/1 TUI wiring

Copy everything below the line into a new agent session (worktree on `main` after this docs merge).

---

Work on JobOS at the current branch tip (prefer latest `main`). Do not use feature worktrees `artifact-viewer` or `researchflow-update` as the implementation baseline—fix against main only. They may be referenced only as contrast for incomplete landings.

Read first:

- `docs/capability-gap-sweep-main.md` (primary gap report)
- `docs/main-sweep-gaps.md` (secondary contract/cron notes)
- `src/tui.js`, `src/tui-model.js`, `src/tui-artifacts.js`, `src/readiness.js`, `src/packets.js`, `src/domain-tools.js`, `README.md`

Product constraint: agents may draft/score/summarize/stage; external apply/send stay human-gated. Packet freeze/attest/confirm and artifact approve/reject are trusted CLI/TUI only (MCP/ACP mutations stay denied). Prefer small boring changes; keep CLI `--json` and tests green.

## Scope: implement Wave 0 + Wave 1 (P0 + apply-loop)

### Wave 0 — Stop lying (must ship)

1. KEYMAP ≡ handlers: every key in `TUI_KEYMAP` and footer `keyHints` must either work or be removed from KEYMAP/footer. No silent no-ops.
2. Fix docs overlay field mismatch: handlers toggle `docsDiff` but render uses `docsView`. Wire one field end-to-end (prefer `docsView`). Diff key must actually show the diff.
3. Dead imports: either wire `runArtifactEditor` / `redraftArtifact` / `ingestEditedArtifact` / `parseEditorCommand` / stage cycling (`t`, `updateJobStatus`, `appCreate`/`appUpdate`), or delete unused imports and KEYMAP entries (stage, editor, search, etc.) so the shell only advertises live actions. Prefer minimal live contract if full editor is large: keep A approve, X/R reject, V/D diff working; strip the rest.
4. Readiness `nextAction` when status is `approved`: never fall back to "Complete readiness checks". Emit a real next step based on `packet.receiptState` (freeze → attest → confirm → done).
5. Filters: either bind keys for every entry in `FILTERS` (today/all/high/review/materials-ready/applied/interview) or only render filters that are bound.

### Wave 0 discovery P0

6. Discovery overlay: NEW JOB REVIEW list is shown but `selectedDiscoveryJobId` is never set; KEYMAP claims A accept / X archive but they no-op. Wire j/k selection, Enter to open job in main list, accept → save/interested (or project-consistent status), archive → archived, keep d → daily. Align KEYMAP with real behavior.

### Wave 1 — Close the apply loop in TUI

7. When readiness is `approved`, TUI must let a human:
   - create application packet (`source: 'tui'`)
   - attest-submitted
   - confirm-receipt  
   Schema already allows `created_by_source` cli|tui; domain tools exist; MCP denials stay.
8. Add command-bar verbs and/or keys so the user does not leave the shell (e.g. packet / attest / receipt). Detail readiness panel should show a clear CTA by `receiptState`.
9. Prefer reusing `callDomainTool` + existing packet service; do not invent a second policy path.

## Out of scope for this pass

- Wave 2 contact approve/suppress/promote UI (unless trivial shared plumbing appears)
- Wave 3 answers entry, interview/analytics/tasks
- Feature-branch-only artifact viewer polish beyond making advertised docs keys honest
- Auto-apply, auto-send, restoring the web dashboard

## Done when

- Raw TUI: every advertised key either changes state or is gone from hints
- Docs diff actually toggles
- Discovery queue selectable + accept/archive works
- Path works entirely in TUI: ready-for-review → approve artifacts → approved → packet create → attest → confirm-receipt (CLI parity checks OK)
- `npm test` and `npm run smoke` pass
- Update README/BUILD_PROGRESS only if user-facing contracts changed
- Report what changed, what was verified, and any remaining limitations

Start by reproducing the `docsDiff` vs `docsView` bug and the approved `nextAction` fallback, then implement Wave 0 fully before Wave 1.
