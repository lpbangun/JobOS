# JobOS

JobOS is a local-first CLI for discovering roles, researching companies and people, finding warm paths, preparing applications, and delegating structured work to local agents. SQLite is canonical; an agent-readable Markdown/YAML/JSONL mirror is written under `jobos-workspace/`.

The default product is offline-capable and deterministic. Public web discovery, LLMs, local agents, and authenticated Playwright sessions are optional. External effects are disabled by default and occur only through an explicitly configured tool or a trusted browser script run with `--allow-side-effects`.

## Requirements and install

- Node.js 22+
- npm

```bash
npm install
npm run jobos -- --help
```

A browser is optional. Install it only when authenticated browser work is needed:

```bash
npm install playwright
npx playwright install chromium
npm run jobos -- browser status --json
```

Core commands remain usable when Playwright or Chromium is absent; browser commands return `browser_unavailable` with recovery commands.

## Five-minute workflow

```bash
# 1. Create local state and a proof-backed target profile.
npm run jobos -- init --json
npm run jobos -- profile create "PM EdTech" \
  --from-resume samples/resume-proof-points.md --json

# 2. Configure one or more public discovery sources.
npm run jobos -- searches create "Acme Greenhouse" \
  --profile pm-edtech --adapter greenhouse --board-token acme \
  --keywords product,learning --location remote --json

# Hidden-source examples:
npm run jobos -- searches create "Startup portfolio" \
  --profile pm-edtech --adapter portfolio \
  --url https://example.vc/portfolio --max-companies 30 --json
npm run jobos -- searches create "Target career page" \
  --profile pm-edtech --adapter career-page \
  --url https://example.com/careers --json
npm run jobos -- searches create "Ashby target" \
  --profile pm-edtech --adapter ashby --handle example --json

# 3. Run every source, isolate failures, dedupe, score, and rank results.
npm run jobos -- daily --profile pm-edtech --json
npm run jobos -- jobs list --json

# 4. Prepare one role end to end.
npm run jobos -- pursue <job-id> --profile pm-edtech --json

# 5. Inspect first-class networking results.
npm run jobos -- network paths --job <job-id> --json
npm run jobos -- network contacts --job <job-id> --json
```

`pursue` runs this coherent pipeline:

```text
fit score
  -> company, stakeholder, and contact research
  -> user-owned network path ranking
  -> application-question preparation
  -> proof-grounded resume and cover-letter drafts
  -> local application tracking
  -> outreach path selection and source-grounded draft
```

Each stage reports `ok`, `failed`, or `skipped`, elapsed time, output IDs/paths, and recovery guidance. Independent stages continue after an unrelated failure.

Useful controls:

```bash
# Preview the graph without writes or network calls.
npm run jobos -- pursue <job-id> --profile pm-edtech --dry-run --json

# Re-run one stage and its dependencies.
npm run jobos -- pursue <job-id> --profile pm-edtech \
  --stage questions --json
```

## Daily automatic discovery

`daily` is the cron-friendly one-shot command. Existing scheduler support can run it every day:

```bash
npm run jobos -- automation enable daily_discovery --json
npm run jobos -- scheduler start --interval 60
```

For a host scheduler, invoke this command on the desired cadence:

```bash
npm run jobos -- daily --profile pm-edtech --json
```

Discovery sources:

- `greenhouse`: direct public Greenhouse board API.
- `lever`: direct public Lever postings API.
- `ashby`: direct public Ashby job-board API.
- `career-page`: public Schema.org `JobPosting` and direct job-link extraction.
- `portfolio`: bounded VC/startup routing across up to 30 companies and recognized ATS targets.

Portfolio runs cap each request at 10 seconds, the run at 60 seconds, and total requests at 90. A cap or child-source failure returns partial jobs plus structured failure metadata instead of discarding completed work. Public-page adapters reject private, loopback, link-local, credential-bearing, and unsafe redirect targets.

## Networking and outreach

Import user-owned relationship data:

```csv
from_type,from_id,to_type,to_id,edge_type,confidence,evidence
profile,pm-edtech,company,acme,shared_employer,high,Worked with an Acme alum
profile,pm-edtech,person,person_123,direct_connection,high,Former colleague
```

Valid `edge_type` values are `direct_connection`, `shared_employer`, `shared_school`, `shared_investor`, `shared_event`, `shared_open_source`, `shared_customer_domain`, and `manual_note`. Confidence is `low`, `medium`, or `high`.

```bash
npm run jobos -- network import --file relationships.csv --json
npm run jobos -- network list --json
npm run jobos -- network paths --job <job-id> --json
npm run jobos -- outreach plan --job <job-id> --profile pm-edtech --json
```

Research and networking share one evidence model. Contact discovery records source observations, stages person candidates, extracts public email/contact points, labels confidence, and combines approved contact quality with user-owned relationship edges. Warm introduction paths outrank cold routes when evidence supports them.

Outreach drafting remains local by default. Marking a thread sent records what the user did elsewhere; it does not pretend JobOS delivered the message:

```bash
npm run jobos -- outreach draft --job <job-id> \
  --stakeholder <stakeholder-id> --profile pm-edtech --json
npm run jobos -- outreach mark-sent --artifact <artifact-id> \
  --channel email --json
```

## Reusable application answers

```bash
npm run jobos -- answers add --profile pm-edtech \
  --category motivation \
  --question "Why are you interested in this company?" \
  --answer "My source-backed reason." \
  --sensitivity personal --json
npm run jobos -- answers list --profile pm-edtech --json
npm run jobos -- answers match --profile pm-edtech \
  --questions questions.json --employer Acme --json
```

Answers are profile-scoped and may be `verified`, `unverified`, `stale`, or `retired`. Sensitive/restricted values are redacted from lists and workspace mirrors. Work authorization, sponsorship, demographic, and legal-attestation questions always emit `sensitive_prompt`; JobOS does not infer or auto-select them. Unanswered non-restricted questions may receive a draft only when every assertion is linked to stored proof-point IDs.

## Pluggable agents: Hermes, Codex, and compatible tools

Built-in suggested manifests are available when their executables are installed:

```bash
npm run jobos -- agents list --json
npm run jobos -- agents test codex --json
npm run jobos -- agents test hermes --json

# Use one agent for structured generation across score, research,
# application questions, tailoring, and outreach.
npm run jobos -- pursue <job-id> --profile pm-edtech \
  --agent codex --json
```

Register another compatible executable:

```bash
npm run jobos -- agents add my-agent \
  --command /absolute/path/to/my-agent \
  --args '["--json"]' --transport stdin-json --json
```

Generic `stdin-json` contract:

```json
{
  "protocolVersion": 1,
  "stage": "jobos_fit_score",
  "systemPrompt": "...",
  "userPrompt": "...",
  "schema": { "type": "object" }
}
```

The process must exit `0` and write one JSON object to stdout. Missing executables, timeouts, non-zero exits, malformed/oversized output, and failed connection tests return typed `agent_error`; explicit agent selection never silently falls back to another provider. `--agent` overrides `JOBOS_AGENT`. Without either, existing HTTP LLM configuration remains available; without any provider, deterministic degraded mode remains.

Agents that prefer tool orchestration can run `jobos mcp`. The MCP surface includes `daily_discovery`, `pursue_job`, and `answers_match` alongside the lower-level scoring, research, networking, tailoring, application, and scheduler tools.

## Authenticated Playwright profiles

```bash
# On a machine with a display, log in and close the browser when done.
npm run jobos -- browser login work --url https://example.com/login --json

# Reuse the private persistent profile headlessly.
npm run jobos -- browser fetch work \
  --url https://example.com/member/jobs --json

# Synchronize a user-owned Playwright storage-state/cookie file.
npm run jobos -- browser cookies import work \
  --file ./storage-state.json --json
npm run jobos -- browser cookies export work \
  --file ./jobos-cookies.json --json
```

Browser state stays under `.jobos/browser/` with private permissions and is never mirrored to `jobos-workspace/`. Cookie values never appear in command results, audit logs, or error messages. Login redirects, expired auth, blocked responses, CAPTCHA, timeouts, missing packages, and missing browser binaries have distinct typed failures and recovery commands. CAPTCHA bypass is not supported.

For site-specific inspection, autofill, or configured application actions, register a trusted local Playwright module:

```bash
npm run jobos -- browser script add fill-supported-form \
  --file ./fill-supported-form.mjs --side-effecting --json
npm run jobos -- browser run work \
  --url https://example.com/apply \
  --script fill-supported-form \
  --input ./packet.json \
  --allow-side-effects --json
```

Registered modules are copied into `.jobos/browser/scripts/` and SHA-256 pinned. They are trusted unsandboxed Node.js code with full process privileges. Side-effecting modules require both registration as side-effecting and the per-run `--allow-side-effects` flag. JobOS audits script/hash/URL/outcome hash without storing script input or browser credentials.

## Optional HTTP LLM and search providers

No API key is required for the deterministic core. Optional structured LLM calls:

```bash
export JOBOS_LLM_PROVIDER=openai       # openai, ollama-cloud, anthropic
export JOBOS_LLM_MODEL=...
export JOBOS_LLM_API_KEY=...
export JOBOS_LLM_BASE_URL=...          # optional OpenAI-compatible endpoint
```

Public search defaults to keyless DuckDuckGo HTML. Optional providers:

```bash
export JOBOS_SEARCH_PROVIDER=auto
export JOBOS_BRAVE_API_KEY=...
export JOBOS_SEARXNG_URL=https://search.local
export EXA_API_KEY=...
export TAVILY_API_KEY=...
export PERPLEXITY_API_KEY=...
```

Set `JOBOS_SEARCH_PROVIDER=none` for deterministic offline pursuit/research; worksheets then contain explicit open questions instead of network-derived claims.

Optional public contact-research adapters:

```bash
export JOBOS_RESEARCH_ADAPTERS=github,gdelt,wayback
```

## CLI contract and local state

- `--workspace <dir>` overrides `JOBOS_HOME`; otherwise the current directory is used.
- Successful one-shot commands support `--json` where practical.
- Validation/usage failures exit `2`; runtime/domain failures exit `1`.
- JSON errors are written to stderr as `{ "ok": false, "error": { "code", "type", "message" } }`.
- Database saves use an exclusive lock, optimistic revision check, fsync, and same-directory atomic rename. A stale writer returns retryable `stale_snapshot` instead of overwriting newer state.

```text
.jobos/
  jobos.sqlite
  agents.json
  browser/                    # credential material; never mirrored
jobos-workspace/
  profiles/
  proof-points/
  searches/
  discovery/runs/
  jobs/<job-id>/
    research/
    artifacts/
    outreach/
  automations/
  audit.log.jsonl
```

Default help is intentionally small:

```bash
npm run jobos -- --help
npm run jobos -- help --all
npm run jobos -- agent-guide --json
```

The full low-level CLI—manual imports, scoring, tailoring, contact review, task/analytics commands, loops, scheduler controls, MCP, API, and local dashboard—remains available for composition. Dashboard work is not the product focus.

## Safety and honest limitations

- Core state is local; there is no telemetry or required cloud sync.
- Generated claims must trace to stored proof points or cited public sources.
- Draft artifacts default to `draft_needs_human_review`; users may separately configure how trusted external tools consume them.
- External effects default off. A browser script runs them only after explicit configuration and `--allow-side-effects`.
- No CAPTCHA bypass, employer-account creation, proprietary global job corpus, or universal Workday/iCIMS/Taleo automation.
- LinkedIn/Indeed DOM-specific bots, universal unattended auto-apply, SMTP auto-send, immutable application packet/receipt graphs, PDF/DOCX production rendering, mail reconciliation, voice rehearsal, offers, and frontend redesign are intentionally deferred.
- `sql.js` is portable but write-heavy concurrent workflows are rejected on stale snapshots rather than merged automatically; reopen and retry.
- A headed browser login needs a display. Headless hosts can import an existing storage-state file.
- Trusted browser scripts are not sandboxed.

## Verification

```bash
npm test
npm run smoke
```

The test suite covers the established CLI/domain behavior plus routed discovery, workflow integration, answer safety, agent failure handling, browser session contracts, networking paths, profile isolation, and concurrent snapshot defense.
