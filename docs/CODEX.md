# Codex Guide

JobOS supports Codex the same way career-ops does: shared product instructions plus MCP tools, with plain-language modes when slash commands are unavailable.

## Mapping

- `docs/AGENT_GUIDE.md` — product contract and workflows
- `.agents/skills/jobos/SKILL.md` — mode router (`/jobos` where supported)
- Root `CODEX.md` — thin Codex wrapper that imports the guide and skill
- `jobos agents connect codex` — registers the JobOS MCP stdio server

## Interactive

```bash
cd /path/to/jobos   # or any JobOS workspace
node src/cli.js agents connect codex
codex
```

Example prompts:

```text
Connect JobOS MCP for this workspace and list jobos tools.
Run JobOS daily discovery for my profile and summarize new matches.
Pursue job <id> with JobOS and report score, drafts, and gaps.
Show the JobOS application tracker and due follow-ups.
```

## One-shot

```bash
codex exec "Run JobOS agents doctor and summarize readiness"
codex exec "List JobOS MCP tools and call jobs list for the active workspace"
codex exec "Run JobOS daily discovery and summarize new roles"
```

## Notes

- Codex uses external MCP for full domain access; it is not the embedded TUI ACP guest (Hermes/OMP are).
- Human-only gates (artifact approval, restricted answers, attestations) stay on CLI/TUI.
