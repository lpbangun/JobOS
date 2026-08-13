@docs/AGENT_GUIDE.md
@.agents/skills/jobos/SKILL.md

<!-- Claude Code product entry. Keep development notes in AGENTS.md; put Claude-only deltas here. -->

# JobOS + Claude Code

1. From this repo: `claude`
2. Wire MCP once: `node src/cli.js agents connect claude`
3. Drive JobOS with `/jobos` or natural language (daily, pursue, score, tracker).
4. Headless: `claude -p "Run JobOS daily discovery and summarize new roles"`

Use JobOS MCP tools or `node src/cli.js … --json`. Never invent proofs, contacts, or submission receipts.
