## Variant: Dense Operator Console

### Design stance
A radar console for operators who want every signal visible at once: funnel, jobs table, discovery health, agent status, event log, command line.

### Key choices
- Layout: multi-panel dense grid (htop / mission-control)
- Emphasis: scan speed, filtering, command execution
- Interaction: table selection, filter chips, `:` command bar, live event log
- Aesthetic: pure terminal green/amber monochrome cues

### Trade-offs
- Strong at: power-user triage, debugging discovery/agent runs, high information density
- Weak at: approachability, narrative coaching, pleasant long reading of drafts

### Best for
Users who already live in terminals and want JobOS as infrastructure, not a chat product.
