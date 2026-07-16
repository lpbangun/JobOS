## Variant: Focus hierarchy

### Design stance
Clear depth levels instead of a permanent multi-pane cockpit. One question per screen; drill in / Esc back.

### Hierarchy
- **L0 Home** — Today / Pipeline / Review (3 cards max)
- **L1 List** — pick one item
- **L2 Focus** — one job + few actions
- **L3 Deep** — network / drafts / answers only when asked
- **Agent layer** — toggled, not always on
- **`:` command** — collapsed until needed

### Why less overwhelming
No kanban + agent + surface map + rail counts + command bar all at once. Progressive disclosure.

### Dynamic TUI note
This matches how real TUIs behave (lazygit, k9s, helix): stack navigation, transient panels, mode layers — not a static dashboard screenshot.
