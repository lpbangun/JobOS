# JobOS TUI — locked design (2026-07-14)

**Canonical sketch:** `sketches/011-rich-pipeline-operator-skin/`  
**Shared behavior:** `sketches/_rich-shell.js`  
**Preview:** http://100.81.6.117:8765/011-rich-pipeline-operator-skin/

Earlier sketches (001–010) are exploratory only. Do not implement from them.

---

## Visual

- **Structure / content density:** 009 (priority strip + job cards + full detail stack)
- **Style:** 010 operator palette (green mono, hard edges, Cascadia/JetBrains mono)
- **Not:** OpenCode minimal, funky gradients, pure drill-down hierarchy, empty list+buttons shell

---

## Layout (stable shell)

```
┌─ header: brand · profile · counts · review · log · agent · sources · system ─┐
├─ priority strip (4 cards: due / interview / new / failure) ──────────────────┤
├─ jobs list (cards) ──────────────┬─ detail stack ─────────┬─ agent (default) ─┤
│ filters: Today All High stages   │ selected · fit · body  │ chat + tools      │
│ job cards w/ fit stage next      │ next · proofs · path   │                   │
│ proofs/drafts/path signals       │ artifacts · stages     │                   │
│                                  │ actions                │                   │
├──────────────────────────────────┴────────────────────────┴───────────────────┤
│ : command (toggle)                                                            │
│ footer keys                                                                   │
└───────────────────────────────────────────────────────────────────────────────┘
```

Overlays (modal, not panes): review, log, network, docs, answers, discovery, system, profile.

---

## Always on

| ID | Surface |
|----|---------|
| A1 | Header (profile, agent ready, side-effects off, counts) |
| A2 | Footer keyhints |
| B1+B3 | Priority strip + list filters (Today / All / High-fit / stages) |
| B2 | Jobs list as **cards** (not kanban, not sparse one-liners) |
| C1 | Selected job summary |
| C2 | Fit score + mode + high-fit |
| C3 | Next action |
| — | Narrative blurb for selection |
| — | Proof match chips |
| — | Warm path one-liner |
| — | Artifact chips (open docs) |
| — | Pursue stage strip |
| C9 | Actions: Pursue · Score · Network · Docs · Answers · Agent |

Header counts: open / high / due / drafts / interviews.

---

## Toggle

| Control | Behavior |
|---------|----------|
| **Agent** | **On by default.** `a` or header pill toggles off. Esc does **not** hide agent. |
| **Command bar `:`** | Hidden until `:` / cmd focus |
| **Profile** | Opens profile overlay (not a permanent rail) |

---

## Overlay only

| Key | Overlay |
|-----|---------|
| `r` | Review queue → click item selects job + opens docs |
| `l` | Event log |
| `n` | Network paths |
| `o` | Document overview + reader |
| `q` | Answers match |
| `s` | Discovery health |
| `?` / system | System health |
| profile pill | Profile switcher |

---

## Explicitly cut (v1 TUI)

- Full multi-column kanban
- Funnel charts / analytics dashboards
- Answers bank full editor
- Automation builder UI
- Browser script manager
- Teaching “surface map” panels
- Mobile-style full-screen drill hierarchy (005)
- Empty minimal shells (006–008)

CLI + MCP remain full power for cut surfaces.

---

## Interaction contract

- `j/k` move selection in filtered list
- `p` pursue · `d` daily
- `a` agent toggle · `:` command
- Overlay keys above; Esc closes overlay or command, not agent
- Side-effects off by default; drafts human-gated
- Agent drives MCP/tools; list+detail stay authoritative orientation

---

## Implementation notes (when building)

1. Work only in `/home/logani/projects/tui-agent` (branch `tui-agent`).
2. Prefer a real TUI stack later (e.g. OpenTUI / ink / ratatui-class) with this IA — sketch is the product spec, not production UI.
3. Wire panes to existing JobOS CLI/MCP domain (`daily`, `pursue`, score, network, answers, artifacts, discovery).
4. Keep agent as first-class pane default-on; Hermes/Codex/MCP integration paths already exist in core.

---

## Decision log

- User rejected empty minimal shells and pure drill-down.
- User preferred 009 density + 010 skin → **011**.
- User locked: agent default on; review + log as overlays not toggles.
