# JobOS advanced configuration

The deterministic JobOS core needs only Node.js 22+. Everything in this document is optional.

## Workspace and TUI

| Variable | Purpose | Default |
| --- | --- | --- |
| `JOBOS_HOME` | Workspace root containing `.jobos/` and `jobos-workspace/` | Current directory |
| `JOBOS_AGENT` | Default registered batch agent | Command-specific default |
| `JOBOS_ACP_COMMAND` | Hermes-compatible ACP executable | `hermes` |
| `JOBOS_TUI_MOUSE=1` | Enable terminal mouse reporting | Off |

Flags override environment values where both exist:

```bash
jobos --workspace ~/career-data
jobos tui --profile <profile-id> --agent off --mouse
```

The TUI requires at least `60×20`. Use `jobos tui --snapshot --width 120 --height 36` for a deterministic noninteractive rendering.

## Agent paths

Inspect detected clients and diagnose each integration layer:

```bash
jobos agents list --json
jobos agents doctor --json
jobos agents connect codex --dry-run --json
```

`agents connect` supports `hermes`, `codex`, and `claude`. It registers the current installed CLI path and workspace with the client's MCP configuration. JobOS passes an executable plus an argument array; it does not generate a shell command for execution.

For custom noninteractive agents, register a manifest and run the protocol test:

```bash
jobos agents add local-agent \
  --command /absolute/path/to/agent \
  --args '["--json"]' \
  --transport stdin-json
jobos agents test local-agent --json
```

See [AGENT_GUIDE.md](AGENT_GUIDE.md) for the stdin JSON contract, ACP lifecycle, MCP framing, capability policy, and security boundary.

## Optional LLM providers

Set a provider, model, and key to enable provider-backed structured scoring and tailoring:

```bash
export JOBOS_LLM_PROVIDER=openai
export JOBOS_LLM_MODEL=<model>
export JOBOS_LLM_API_KEY=<key>
```

Supported provider routes are `openai`, `anthropic`, and `ollama-cloud`. Provider-native `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OLLAMA_API_KEY` values are also recognized. Optional overrides:

```bash
export JOBOS_LLM_BASE_URL=https://example.invalid/v1
export JOBOS_LLM_TIMEOUT_MS=30000
```

Without a complete configuration, JobOS stays in deterministic degraded mode. It does not silently call another provider.

Research stages may use route-specific prefixes such as `<ROUTE>_PROVIDER`, `<ROUTE>_MODEL`, `<ROUTE>_API_KEY`, `<ROUTE>_BASE_URL`, and `<ROUTE>_TIMEOUT_MS`; the general `JOBOS_LLM_*` values remain the fallback.

## Optional public search

Public discovery defaults to DuckDuckGo HTML. Choose an ordered fallback chain:

```bash
export JOBOS_SEARCH_PROVIDERS=exa,tavily,perplexity,brave,duckduckgo
```

Recognized credentials:

| Provider | Key |
| --- | --- |
| Exa | `EXA_API_KEY` or `JOBOS_EXA_API_KEY` |
| Tavily | `TAVILY_API_KEY` or `JOBOS_TAVILY_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` or `JOBOS_PERPLEXITY_API_KEY` |
| Brave | `JOBOS_BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY` |
| SearXNG | `JOBOS_SEARXNG_URL` |

Use `JOBOS_SEARCH_PROVIDER=none` for fully deterministic offline worksheets. Set `JOBOS_SEARCH_TIMEOUT_MS` for the common timeout or a provider-specific `JOBOS_SEARCH_<PROVIDER>_TIMEOUT_MS` override.

## Authenticated browser profiles

Playwright is optional. Browser profiles, cookies, and registered scripts remain outside the agent-readable workspace mirror.

```bash
# On a machine with a display, sign in and close the window when finished.
jobos browser login work --url https://example.com/login

# Inspect a page with the saved local profile.
jobos browser fetch work --url https://example.com/jobs --json

# Inspect browser availability and recovery guidance.
jobos browser status work --json
```

Browser operations report typed authentication, CAPTCHA, blocked, and unavailable errors. They do not fabricate a successful fetch.

## External action gates

External effects default to off. Form operations require both persistent configuration and an explicit per-run gate:

| Capability | Persistent environment gate | Per-run gate |
| --- | --- | --- |
| Form fill | `JOBOS_FORM_FILL_ENABLED=1` | `--allow-side-effects` |
| Form submit | `JOBOS_FORM_SUBMIT_ENABLED=1` | Operation-specific submit approval |
| Agent form invocation | `JOBOS_AGENT_FORM_INVOCATION_ENABLED=1` | Same operation-specific gate |

Equivalent profile preferences can replace the persistent environment gate. Human-only artifact review and application decisions are still restricted to trusted TUI/CLI input.

Users are responsible for third-party platform terms when enabling authenticated adapters or automation.

## Optional Exa people research

Set `EXA_API_KEY`, then either request `--sources exa_people` explicitly or enable `networkIntent.allowedSources.exaPeople` for the profile. The adapter calls Exa search with `category: "people"` and records returned URLs/text as source observations before staging candidates and contact points. API-discovered emails are unapproved evidence, never trusted by default, and stay redacted from agent-readable workspace mirrors.

## Optional xAI people research

xAI research requires all three conditions:

1. `JOBOS_XAI_ENABLED=1`
2. `XAI_API_KEY` is present
3. The profile's network intent explicitly allows the `xai` source

Optional values include `JOBOS_XAI_MODEL` and `JOBOS_MODEL_PRICING_JSON`. Dollar budgets are rejected when pricing metadata is unavailable; they are never guessed.

## Scheduler and automation

The scheduler is local and explicit:

```bash
jobos automation list --json
jobos scheduler status --json
jobos scheduler run-once --json
jobos scheduler start --interval 60
```

Fresh and upgraded workspaces seed `profile_network_research` (weekly) and `network_nurture` (daily) disabled. Enable them explicitly with the automation commands. Profile research reuses the existing profile-scope people-research pipeline. Nurture runs only create local tasks and review-gated check-in drafts; they never send outreach.

Avoid concurrent write-heavy processes against one workspace. JobOS uses portable `sql.js`, not a native SQLite WAL service.

## PDF rendering

Resume PDF rendering uses `tectonic` by default. Override the executable with `JOBOS_TEX_ENGINE` when a compatible engine is installed.

## Secret handling

- Provider credentials stay in environment variables or the external agent's private configuration.
- ACP child environments are allowlisted and streamed output is secret-redacted.
- Agent-readable mirrors exclude browser cookies and restricted answer values.
- Do not place credentials in profile notes, proof text, job descriptions, agent prompts, or registered command arguments.
