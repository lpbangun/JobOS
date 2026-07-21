# Full capability gap sweep — `origin/main`

**Baseline:** `origin/main` @ `769b592` (*Merge branch 'AppPacket-ReceiptSpine' into main*)  
**Date:** 2026-07-20  
**Surfaces compared:** CLI registry (80 commands) · domain tools (40) · MCP (37 advertised) · TUI (`src/tui.js` + `tui-model.js` + `tui-artifacts.js`) · readiness/packet/outreach backends  
**Excluded from “what’s next product work”:** feature worktrees `artifact-viewer` (+2 commits) and `researchflow-update` (+1 commit). Their incomplete landings *on main* are still called out as wiring debt.

**Problem class this report targets:** backend/background capability exists and often runs, but the user has no (or a broken) path in the primary control surface (TUI), or recovery guidance points only at CLI, or UI advertises actions that do nothing.

---

## Executive summary

Main is no longer a CLI+web MVP. After successive merges (lean CLI → ACP/TUI host → readiness → human review → packet/receipt spine), the **authoritative product surface is the TUI**, with CLI as the trusted power interface and MCP/ACP as agent doors.

The dominant gap pattern is **half-merged UI contracts**:

1. **State + render + KEYMAP advanced** (docs viewer, discovery accept/archive, stage cycling, editor/redraft).
2. **Key handlers and actions did not finish wiring** on the same tip.
3. **New backend workflows (packet freeze, contact human gates, answers bank)** landed with CLI/MCP inspection, but the TUI only *displays* status and has nowhere for the human to finish the loop.

Severity ranking for user-facing pain:

| Priority | Theme | User impact |
|---|---|---|
| P0 | Docs diff/editor KEYMAP vs handlers | User presses advertised keys / `D`; nothing useful happens |
| P0 | Readiness `approved` → no next path in TUI | Backend complete; freeze/attest only via CLI, and “next” is wrong |
| P0 | Discovery overlay KEYMAP accept/archive | Queue visible; selection/actions dead |
| P1 | Contact approve/suppress/promote human gates | Pursue can discover; TUI cannot complete outreach gating |
| P1 | Filters / stage / answers / packet overlays | Visible affordances or dead imports without user path |
| P2 | Domain/MCP tool incompleteness vs CLI | Agents cannot drive full human-gated flows they can only recommend |
| P3 | Pre-existing docs gaps (cron OR, test holes) | See `docs/main-sweep-gaps.md` |

---

## Surface inventory (main)

### What works end-to-end (backend + at least one user path)

| Capability | CLI | Domain tool | TUI | MCP/ACP |
|---|---|---|---|---|
| Init / workspace bootstrap | yes | n/a | empty-state tips | n/a |
| Profile create / proof add | yes | no | no (CLI only) | no |
| Daily discovery + pursue | yes | `daily_discovery`, `pursue_job` | `d` / `p` | yes |
| Score | yes | `score_job` | `z` | yes |
| Artifact approve/reject (exact revision) | yes | `approve_artifact` / `reject_artifact` | `A` + confirm / `X` + note | deny (intentional) |
| Network map refresh | yes (`network paths` / research network) | `map_reachable_network` | `n` + `m` | yes |
| Readiness compile | yes `applications plan` | `applications_plan` | display only | inspect |
| Packet freeze / attest / receipt | yes `apply …` | create/attest/confirm | **display only** | list/show/diff only; mutations denied |
| Outreach draft/mark-sent/followup | yes | yes | no dedicated UI | draft yes; mark-sent denied by default |
| Scheduler / automations | yes | list/run | no | list/run |
| Browser / agents | yes | no domain tools | system overlay honest about browser | n/a |
| Analytics funnel / weekly / interview prep | yes | `weekly_review`, `interview_prep` | no | yes |
| Answers add/list/match | yes | `answers_match` only | counts only | match only |

### Primary TUI actions that actually run domain tools

Only four workflow actions are wired in `TUI_DOMAIN_ACTIONS`:

- `daily` → `daily_discovery`
- `pursue` → `pursue_job`
- `score` → `score_job`
- `network` → `map_reachable_network`

Plus artifact approve/reject via `callDomainTool`. Everything else is either view-only, agent-mediated, or CLI-only.

---

## P0 — Broken or misleading user-facing wiring

### 1. Documents overlay: half-merged artifact viewer

**Evidence (`src/tui.js` on main):**

- Render path uses `state.docsView === 'diff'`, `docsScroll` / `docsDiffScroll`, markdown/diff renderers from `tui-artifacts.js`.
- Handlers still toggle the **legacy** field `state.docsDiff` on `D` and never set `docsView`.
- `TUI_KEYMAP.docs` advertises `R reject · B draft · E editor · V diff · I evidence · / search · n/N match · ↑/↓ scroll · Ctrl+A focus`.
- Actual handlers: `A` approve, `X` reject, `D` “diff” (broken field), `j/k` select.
- Imports present but **never called:** `runArtifactEditor`, `redraftArtifact`, `ingestEditedArtifact`, `parseEditorCommand`.
- `stageOrder`, `updateJobStatus`, `appCreate`, `appUpdate` imported / exported for stage UI that never starts (`t` not handled; `mode === 'stage'` only rendered).

**User symptom:** Footer/KEYMAP promise a document workstation. Diff toggle is a no-op relative to render. Editor/redraft/search/scroll/evidence keys do nothing. After reject, there is no in-TUI redraft path even though `redraftArtifact` exists.

**Closest complete implementation:** worktree `artifact-viewer` (intentionally excluded as feature add) already wires `V`→`docsView`, `E`→editor, `R`→reject, etc. Main absorbed **state + render + KEYMAP + helpers** without the handlers.

**Fix direction:** Either (a) finish wiring handlers to match KEYMAP/state, or (b) strip KEYMAP/state/imports down to the live `A`/`X`/`D` contract until the feature lands. Do not leave advertised keys that no-op.

### 2. Readiness reaches `approved` with nowhere to go in TUI

**Backend complete:**

- `applications plan` → `blocked | ready-for-review | approved`
- `apply packet create|list|show|diff`
- `apply attest-submitted` / `apply confirm-receipt`
- Domain tools + schema allow `created_by_source IN ('cli','tui')`
- Policy text: freeze/attest require “trusted CLI **or TUI**”

**TUI reality:**

- Detail shows `READINESS approved · packet currency/receiptState` when present.
- No key/command for packet create, list, attest, or confirm.
- When `status === 'approved'`, `nextActions` is derived only from **blockers**, so it is empty; UI falls through to the default string **“Complete readiness checks”** — actively wrong.

**User symptom:** User finishes review in TUI (`A`/`X`), readiness flips to approved, and the product implies they are stuck at readiness rather than offering freeze → external submit → attest → receipt.

**Fix direction:**

1. When `status === 'approved'` and `packet.receiptState === 'none'`, set an explicit next action: freeze packet (and show key/command).
2. Wire TUI trusted actions for packet create / attest / confirm (schema already allows `source: 'tui'`).
3. Keep MCP/ACP mutation denials; they are correct.

### 3. Discovery overlay: queue rendered, KEYMAP lies, selection dead

**Evidence:**

- `tui-model` loads `discovery.queue` (`jobs` with `status='new'`).
- Overlay renders “NEW JOB REVIEW” list and compares `item.id === state.selectedDiscoveryJobId`.
- `selectedDiscoveryJobId` is initialized `null` and **never assigned**.
- `TUI_KEYMAP.discovery` claims `A accept · X archive · d run`.
- Handlers: only `d` → `daily`. No accept/archive; no j/k selection of queue rows in discovery mode (j/k only works for overlays registered in `overlayItems`, which returns `[]` for discovery).

**User symptom:** After `daily`, new jobs appear in an overlay that looks actionable. Nothing is selectable; accept/archive do nothing. User must leave to CLI (`jobs list`, manual status) or hope pursue/list filters find them.

**Fix direction:** Wire j/k + Enter to select job into main list; accept → mark `saved`/`interested`; archive → `archived`; align KEYMAP with real actions. Optionally expose discovery queue as filter `new` in the main job list.

### 4. Filter bar shows unreachable modes

`FILTERS = ['today','all','high','review','materials-ready','applied','interview']` is painted in the list header, but keys only set:

- `1` today · `2` all · `3` high

So `review`, `materials-ready`, `applied`, `interview` are **visible chrome without a path**.

**Fix direction:** Number or letter bindings for every FILTERS entry, or only render filters that are bound.

---

## P1 — Capability exists; primary surface is view-only or CLI-only

### 5. Contact / stakeholder human gate (pursue produces work you cannot finish in TUI)

| Step | Backend | TUI | Domain/MCP |
|---|---|---|---|
| Discover contacts | CLI + pursue stage | no list | `discover_contacts` |
| Promote candidate → stakeholder | CLI `research promote-stakeholder` | no | **missing tool** |
| Approve contact | CLI `research approve-contact` | no | `approve_contact` (human-only for agents) |
| Suppress contact | CLI | no | **missing tool** |
| Outreach plan / draft | CLI + pursue | network overlay shows path only | plan/draft tools |

**User symptom:** `p` pursue completes contacts/network/outreach stages in the background. Network overlay shows a path strength blob. There is no contact list, no approve/suppress, no promote. Warm/cold outreach quality depends on human gates the user cannot perform without leaving the product shell.

### 6. Answers bank is counts-only

- CLI: add / list / match with restricted redaction.
- Domain: `answers_match` only.
- TUI `q` overlay: verified count + restricted count + prose.

No path to add a restricted answer when readiness blocker says `restricted_questions_require_input` (nextAction is a long CLI invocation only).

### 7. Packet/receipt spine missing from command bar

`: command` accepts only `pursue score daily network review log docs answers system profile agent refresh reconnect quit`.

Even if user knows packet CLI exists, the in-shell command bar cannot freeze/attest. Given README’s “CLI/TUI policy sources” language, this is a documentation + product gap.

### 8. Priority strip is non-interactive

`priorityStrip` carries `jobId` for due / interview / new items, but no key jumps selection. High-value “what should I do now?” chrome is display-only.

### 9. Post-apply lifecycle absent from TUI

Interview prep, analytics funnel, weekly review, tasks due, outreach due — all CLI (+ some domain tools). Stage strip in detail even shows `interview:…` but pursue does not run interview prep, and TUI has no action.

### 10. Application status stage cycling is a ghost feature

- `TUI_KEYMAP.global` includes `t stage`.
- Render supports `mode === 'stage'` and `stage-note`.
- `stageOrder` / `updateJobStatus` / `appUpdate` imported.
- **No handler sets `mode = 'stage'`.** Dead product surface.

---

## P2 — Cross-surface incompleteness (agent / domain parity)

These are less “user stuck in TUI” and more “agent can see the world is incomplete”:

| CLI capability | Domain tool | Notes |
|---|---|---|
| `research stakeholders` / `add-stakeholder` | missing | pursue runs stakeholders internally; agents cannot re-run alone |
| `research suppress-contact` / `promote-stakeholder` | missing | human gate incomplete for agents *and* no TUI |
| `analytics funnel` | only via `weekly_review` | funnel command not a tool |
| `network import` / `network list` / `network contacts` | partial via map/plan | import remains CLI |
| `proof add` / `profile create` | missing | empty TUI correctly points at CLI |
| `jobs dedupe --apply` | missing | daily may dedupe internally; manual path CLI-only |
| Packet mutations | present but MCP-denied | intentional; TUI should own human path |

MCP list size is **37** (40 domain tools minus 3 packet mutations) — consistent with `BUILD_PROGRESS` after the prior doc fix.

---

## P3 — Pre-existing / secondary gaps

From `docs/main-sweep-gaps.md` (still open unless re-decided):

1. **Cron DOM+DOW matching is OR** (standard cron). Confirm intentional; document if kept.
2. **Packet acceptance test holes** (AP03/AP08/AP13/AP15) — contract coverage, not missing UX.
3. **Web dashboard removed** — intentional. Ensure no docs/scripts still tell users `npm run web` (current README/package look clean).

Not treated as gaps for this sweep:

- Universal auto-apply / SMTP send / marketplace agents (intentionally deferred).
- Feature work on `artifact-viewer` and `researchflow-update` worktrees (explicitly excluded).

---

## “Nowhere to go” user journeys (concrete)

### Journey A — Review → apply evidence

1. User runs TUI, `p` pursue, `r` review, Enter, `A` approve materials.  
2. Readiness → `approved`.  
3. **Stuck:** next line says “Complete readiness checks”; no freeze/attest.  
4. Escape hatch: leave shell, run CLI packet/attest commands.

### Journey B — Daily → triage

1. User presses `d` / discovery overlay.  
2. Sees NEW JOB REVIEW list.  
3. **Stuck:** cannot highlight, accept, or archive; KEYMAP lies.  
4. Escape hatch: CLI `jobs list` / status updates / filters that are also partly unreachable.

### Journey C — Outreach quality

1. Pursue discovers contacts and ranks a path.  
2. Network overlay shows strength JSON.  
3. **Stuck:** cannot approve contact or promote stakeholder in shell.  
4. Escape hatch: CLI research approve/promote/suppress, then outreach draft.

### Journey D — Document quality loop

1. User opens docs, tries `V`/`E`/`R` per KEYMAP (or `D` per footer).  
2. Diff/editor/redraft either no-op or wrong field.  
3. **Stuck** on revision quality without CLI redraft/tailor.

### Journey E — Restricted application questions

1. Readiness blocker `restricted_questions_require_input` with CLI-only nextAction.  
2. Answers overlay shows a count.  
3. **Stuck** inside TUI; must craft a precise CLI `answers add … --sensitivity restricted …`.

---

## Recommended fix program (ordered)

### Wave 0 — Stop lying (1–2 days, high leverage)

1. **Single source of truth for keybindings:** either implement KEYMAP handlers or shrink KEYMAP/footer to live keys only.  
2. **Fix docs diff field mismatch** (`docsDiff` vs `docsView`) immediately.  
3. **Fix approved readiness nextAction** to point at packet freeze CLI *and* planned TUI key.  
4. **Only render filters that are bound**, or bind `4–7` for remaining FILTERS.

### Wave 1 — Close the apply loop in TUI (highest product value)

1. Packet create / show summary / attest-submitted / confirm-receipt as trusted TUI flows (mirroring CLI, `source: 'tui'`).  
2. Command-bar verbs: `packet`, `attest`, `receipt`.  
3. Detail readiness panel: explicit CTA by `receiptState` (`none` → freeze, `attested` → confirm, `confirmed` → done).

### Wave 2 — Discovery triage + contact gates

1. Discovery queue j/k + accept/archive + Enter to open job.  
2. Contacts/stakeholders overlay (or expand network): list candidates/contacts; approve/suppress/promote.  
3. Add missing domain tools for promote/suppress so ACP guest can *inspect* and recommend, human still confirms in TUI/CLI.

### Wave 3 — Answers + post-apply ops

1. Minimal answers add flow for restricted/ordinary blockers (prompt in TUI, write via domain/CLI service).  
2. Tasks due / outreach due strip jump.  
3. Interview prep + weekly review actions from selected application (can stay command-bar only).

### Wave 4 — Finish or revert ghost features

1. Stage cycling (`t`) **or** delete KEYMAP/render/import.  
2. Artifact editor/redraft/search **or** delete dead imports and KEYMAP entries (prefer finishing if Wave 0/1 already touch docs).  
3. Align pursue stage strip with pursue stages (interview is display-only today).

### Wave 5 — Contract hygiene

1. Cron OR decision + docs.  
2. Packet acceptance tests from `main-sweep-gaps.md`.  
3. Lightweight test: KEYMAP keys ⊆ handled keys; `docsView` toggled by the advertised diff key; MCP tool count assertion.

---

## Suggested acceptance checks for any fix PR

- Press every key printed by `keyHints('docs'|'discovery'|'global')` in a raw TUI session; each must change state or show an explicit “not available” status (no silent no-op).  
- `ready-for-review` → approve → `approved` → packet create → attest → confirm, **entirely from TUI**, with CLI parity checks.  
- After `daily`, discovery overlay can accept one job into the main list without CLI.  
- Rejected artifact offers redraft (TUI or explicit CLI nextAction shown in status).  
- `npm test` + `npm run smoke` green; optional raw PTY drill for KEYMAP.

---

## Method notes

- Inventory built from live `src/cli.js` `commandRegistry`, `src/domain-tools.js` `DOMAIN_TOOLS`, `src/mcp.js` deny set, and static analysis of `src/tui.js` handlers vs `TUI_KEYMAP` vs `defaultTuiState` fields.  
- Feature worktrees `artifact-viewer` and `researchflow-update` were used only as *contrast* for incomplete landings already present on main, not as scope to implement.  
- Prior doc `docs/main-sweep-gaps.md` covers packet PR micro-gaps; this document is the full user-facing wiring sweep.
