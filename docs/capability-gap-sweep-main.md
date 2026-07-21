# Remaining gaps checklist — check one by one

**Tip:** `origin/main` @ `a091001` (*Merge tui-focus into main*) + reconciliation + gaps #5–#8 on `baseline-fix`  
**Updated:** 2026-07-21  

This file is the **living remaining list only**. Historical full sweep narrative is retired; use git history if you need the original inventory.

**How to use:** work top to bottom. Mark each box when verified on the current tip (manual TUI or test). Do not expand scope mid-item.

---

## Closed (do not re-open unless regression)

- [x] Docs `docsView` / diff toggle (`V`/`D`) wired end-to-end  
- [x] Docs KEYMAP live (approve / reject / editor / search / evidence / scroll)  
- [x] Discovery queue selectable; `A` accept · `X` archive · `d` daily  
- [x] Stage cycling (`t`) live  
- [x] Reject → explicit redraft nextAction (CLI `jobos tailor …`; agent redraft when ACP ready)  
- [x] Read-only packet show (`:packet` / overlay; inspection only)  
- [x] KEYMAP ⊆ handled invariant test + automated KEYMAP drill  
- [x] MCP/ACP packet + artifact mutations stay denied  
- [x] Approved readiness nextAction follows `packet.receiptState` (freeze → attest → confirm → done; ready-for-review → approve materials) — `topLevelNextAction` in `src/readiness.js`, dead-end fallback removed from `src/tui.js`; lifecycle test in `tests/readiness.test.js` (2026-07-21)  
- [x] TUI apply loop mutations — `:packet create` / `:attest [rfc3339]` / `:receipt <ref>` via `callDomainTool` `source:'tui'`; overlay CTA follows `receiptState`; full approve→freeze→attest→confirm path tested in TUI, MCP/ACP denial still green (2026-07-21)  
- [x] Filter bar honesty — keys `4`–`7` bound to review / materials-ready / applied / interview (all backed by `filteredJobs`), advertised in KEYMAP; narrow-terminal footer rebalanced so `s/?/:/Q` stay visible (2026-07-21)  
- [x] Discovery Enter — Enter in the discovery overlay saves the highlighted job and selects it in the main list (overlay closes, filter → all); advertised in discovery KEYMAP; A/X/d unchanged (2026-07-21)  
- [x] Rebase reconciliation 1 — `b build-network` registered in `TUI_KEYMAP.global` + `TUI_HANDLED_KEYS.global` (global handler already live at `onKeypress`); drill now fires `b`, asserts the overlay opens, and resets — commit `0e2e04f` (2026-07-21)  
- [x] Rebase reconciliation 2 — SELECTED JOB hint derived from `TUI_KEYMAP` via `detailHints()`/`DETAIL_HINT_KEYS` (hardcoded `i agent` corrected to `a agent · i prompt`); 011 snapshot + new hint⊆KEYMAP invariant — commit `f9d4ad4` (2026-07-21)  
- [x] Rebase reconciliation 3 — review overlay `E`/`V`/`I` restored (open the artifact, then editor / diff toggle / evidence toggle via `onDocsKey`); drill reopens the review overlay per key and asserts the real effects — commit `952bf06` (2026-07-21)  
- [x] Contact human gates in TUI (#5) — `n` network overlay lists discovered contacts + candidates with `A` approve (`callDomainTool` `source:'tui'`), `X` suppress (reason input mode), `P` promote; new advertised `network` KEYMAP scope; the three dead `jobos research` CLI contact commands wired; suppress/promote stay library+CLI-only (agents don't need them; `approve_contact` agent denial unchanged); `tests/tui-contact-gates.test.js` — commit `eb5cbec` (2026-07-21)  
- [x] Answers entry in TUI (#6) — answers overlay lists the selected job's open questions (never values) with `:answer add [category] | <question> | <answer>`; new `answers_add` domain tool denied to mcp/acp (`human_answer_input_required`); restricted categories auto-redact + scope to `job:<id>`; value never echoed; `tests/tui-answers-entry.test.js` — commit `a22d66e` (2026-07-21)  
- [x] Strip actions (#7) — `Tab` cycles strip focus (advertised `strip` KEYMAP scope, `▶` marker), `Enter` jumps to the focused card's job (failure card honestly reports no linked job); `:due` overlay lists tasks + outreach follow-ups with jump-to-job; `:prep` drafts interview prep for the selected job's latest application (refuses when none); `:weekly` writes the weekly review; `tests/tui-strip-actions.test.js` — commit `e140473` (2026-07-21)  
- [x] Contract hygiene (#8) — cron DOM+DOW **OR** semantics decided/kept (standard Vixie cron), documented in `src/scheduler/cron.js` + `BUILD_PROGRESS.md` + `README.md` and locked by OR/wildcard cases in `tests/sprint7-scheduler.test.js`; AP03 link asserts, AP08 direct `confirmApplicationReceipt` mcp/acp denial + relational MCP-count pin, new AP13b post-conflict consistency (snapshot-based — attest and confirm each record a receipt row), AP15 cross-profile non-leak for profile-scoped filters (with `--job`-alone documented as job-scoped by design); advertised MCP tool count pinned at 41 over the wire; `docs/main-sweep-gaps.md` reconciled — commit `52ffa99` (2026-07-21)  

---

## Still open — check one by one

All sweep items are closed. Re-open an entry only on regression.

---

## Suggested order for the next sessions

Checklist complete — next work is new scope (e.g. the live-but-unregistered global keys `t`/`v`/`g`/`c`/`x`, or whatever the next design-doc milestone is).

---

## Done definition for an item

- Checkbox steps above all true on current tip  
- Targeted tests or a one-line smoke note for that item  
- No new advertised key that no-ops  
- `npm test` still green after the item (or known skip documented)

When an item is fully checked, move it into **Closed** at the top and leave a one-line pointer to the PR/commit if useful.
