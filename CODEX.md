@docs/AGENT_GUIDE.md
@.agents/skills/jobos/SKILL.md

<!-- Codex product entry. Keep development notes in AGENTS.md; put Codex-only deltas here. -->

# JobOS + Codex

1. From this repo: `codex`
2. Wire MCP once: `node src/cli.js agents connect codex`
3. Slash commands are not guaranteed — ask by mode name (`daily`, `pursue`, `score`, `tracker`).
4. Headless: `codex exec "Run JobOS daily discovery and summarize new roles"`

Use JobOS MCP tools or `node src/cli.js … --json`. Never invent proofs, contacts, or submission receipts.
