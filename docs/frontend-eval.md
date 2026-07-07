# Sprint 9 Frontend Eval

Date: 2026-07-07

## Human Usability Rubric

Scores are 1 to 5. The before score comes from `docs/frontend-audit.md`; the after score reflects the Sprint 9 CLI-primary implementation.

| Dimension | Before | After | Evidence |
| --- | ---: | ---: | --- |
| Discoverability | 2 | 4 | Root help and every per-command help page are generated from `commandRegistry`; `jobos agent-guide` exposes the same inventory for agents. |
| Consistency | 3 | 4 | Commands retain stable noun/verb groups, all commands have registry usage metadata, and Markdown output no longer overrides `--json`. |
| Scriptability | 4 | 5 | Commands remain non-interactive; usage errors exit `2`, runtime errors exit `1`, and JSON errors have a stable stderr object. |
| Agent-drivability | 3 | 5 | `docs/AGENT_GUIDE.md`, `jobos agent-guide --json`, loop JSONL, `--max-iterations`, and the blind-agent eval cover the external-agent path. |
| Error messages | 3 | 4 | Human errors still use `jobos: ...`; JSON errors include code/type/message. |
| First-run experience | 3 | 5 | First successful command auto-creates `.jobos/` and `jobos-workspace/`; `init` is optional. |

Total: 18/30 before, 27/30 after.

## Checklist

- [x] Every registered command has usage, summary, output mode, JSON metadata, and test metadata.
- [x] Root help and per-command help come from the same registry.
- [x] `jobos agent-guide` prints the generated registry for external agents.
- [x] `docs/AGENT_GUIDE.md` gives a compact static onboarding reference.
- [x] Successful first command in a fresh workspace creates local state automatically.
- [x] `--quiet` can suppress bootstrap notices.
- [x] Usage errors use exit code `2`.
- [x] Runtime/domain errors use exit code `1`.
- [x] JSON errors are written to stderr with a stable object shape.
- [x] `jobos loop scheduler`, `jobos loop automation`, and `jobos loop action` support bounded JSONL loops.
- [x] `jobos tasks due --watch` supports bounded JSONL watch output.
- [x] Blind-agent eval starts from `agent-guide --json` and scores at least 90%.

## Residual Risk

- The command registry is implemented in `src/cli.js`; a future cleanup could move it to a small shared module if MCP/API generation needs direct imports without CLI dependencies.
- The web dashboard remains a companion surface. It should continue to read/write canonical state rather than grow a separate model.
- Shell completion is not implemented yet, but the registry now makes it straightforward to generate later.
