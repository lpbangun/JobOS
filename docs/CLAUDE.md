# Claude Code Guide

JobOS supports Claude Code with the same career-ops pattern: shared product instructions, a `/jobos` skill router, and MCP tools.

## Mapping

- `docs/AGENT_GUIDE.md` — product contract and workflows
- `.agents/skills/jobos/SKILL.md` — mode router (symlinked under `.claude/skills/jobos/`)
- Root `CLAUDE.md` — thin Claude wrapper that imports the guide and skill
- `jobos agents connect claude` — registers the JobOS MCP stdio server (`--scope user` so it connects without a one-time interactive `.mcp.json` approval)

## Interactive

```bash
cd /path/to/jobos   # or any JobOS workspace
node src/cli.js agents connect claude
claude
```

Then use `/jobos` or natural language:

```text
/jobos daily
/jobos pursue <job-id>
Run JobOS agents doctor and summarize readiness
Score this JD against my JobOS profile
```

## One-shot

```bash
claude -p "Run JobOS agents doctor --json and summarize"
claude -p "List JobOS MCP tools and summarize daily_discovery / pursue_job"
claude -p "Run JobOS daily discovery for my profile and summarize new roles"
```

## Notes

- Claude Code uses external MCP for domain tools; Hermes remains the default embedded TUI chat guest.
- Prefer MCP or `node src/cli.js … --json` over hand-editing workspace mirrors.
- Never invent proof points, contacts, or submission receipts.
