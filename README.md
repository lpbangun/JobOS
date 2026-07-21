# JobOS

JobOS is a local-first, agent-native job application operating system. Its terminal product binds a real pipeline, job detail, review/log overlays, and an embedded guest-agent session to the same local state. SQLite is canonical; an agent-readable Markdown/YAML/JSONL mirror is written under `jobos-workspace/`.

The core product is offline-capable and deterministic. Public web discovery, LLMs, local agents, and authenticated Playwright sessions are optional. External effects are disabled by default and occur only through an explicitly configured tool or a trusted browser script run with `--allow-side-effects`.

## Requirements and install

- Node.js 22+
- npm

```bash
npm install
npm run jobos -- --help
```

### Optional Hermes ACP backend

The embedded pane supports ACP protocol v1 and the current product drill is verified with **Hermes Agent 0.18.2**. Other versions were not exercised here; use `hermes acp --check` before launch. Install Hermes from the upstream Nous Research installer, then configure one model provider:

```bash
# Linux, macOS, or WSL2. Inspect the upstream script first if required by policy.
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc

# Choose one setup path. Provider credentials remain in Hermes' private config.
hermes setup
hermes setup --portal       # Nous Portal OAuth alternative
hermes setup model          # provider/model section only
hermes acp --version
hermes acp --check
```

Hermes also accepts its documented provider environment variables. JobOS does not mirror credentials into `jobos-workspace/`; its ACP child environment is allowlisted and transcripts are redacted. If `hermes` is not on `PATH`, point JobOS at the ACP v1 executable without changing the workspace:

```bash
JOBOS_ACP_COMMAND=/absolute/path/to/hermes npm run tui -- --profile pm-edtech
```

Run provider setup in a trusted terminal before a headless session. A missing/unconfigured backend leaves the pipeline usable and shows reconnect guidance instead of substituting a fake agent.

## Launch the terminal product

```bash
# Optional but recommended for the embedded live agent pane.
hermes acp --check

# Start the data-bound 011 terminal shell. The agent pane is on by default.
npm run tui -- --profile pm-edtech

# Useful for SSH checks, CI, or a host without an ACP backend.
npm run jobos -- tui --profile pm-edtech --agent off
npm run jobos -- tui --profile pm-edtech --snapshot --width 140 --height 42
npm run jobos -- tui --profile pm-edtech --json
```

The shell shows header counts, due/interview/new/failure priorities, rich job cards, selected-job fit/proofs/path/artifacts/stages, and a live Hermes ACP pane. `j`/`k` moves selection without waiting for an agent turn. `i` prompts the agent; `a` explicitly toggles its pane; Escape closes transient input or overlays but never hides the agent. `r` and `l` open review and audit-log overlays; `n`, `o`, `q`, `s`, and `?` open network, documents, answers, discovery, and system surfaces. `p`, `z`, and `d` run pursue, score, and daily through the shared domain facade. `t` opens the selected job's application-stage picker; selecting `applied` records only that the user applied elsewhere. `:` opens the command bar; `x` cancels a live turn; `c` reconnects ACP; uppercase `Q` exits. After cancel or timeout, late guest updates are quarantined; the next prompt starts a clean Hermes process/session before accepting new output.

Review and document surfaces keep artifact decisions human-gated. In review, Enter opens the selected draft; `A`, `R`, and `B` approve, reject with required feedback, or return it to draft. In documents, `E` round-trips through `$VISUAL`/`$EDITOR` and creates a new draft version only when content changes; `V` shows the immediate predecessor diff; `I` shows evidence and warnings; `/`, `n`/`N`, arrows, and PageUp/PageDown search and scroll. Markdown and diffs are sanitized before terminal rendering, and editor paths are confined to the workspace. Agent-created artifacts open automatically when safe; active typing, confirmations, or editor ownership defer the open until the blocker clears.

An empty workspace is valid: the shell gives profile/import commands rather than fabricated sample data. If Hermes is absent or crashes, pipeline navigation and direct JobOS actions remain available with a visible reconnect message.

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

## Application readiness

Check whether your local materials are complete for human review:

```bash
npm run jobos -- applications plan --job <job-id> --profile <profile-id> --json
```

The plan returns one of three statuses:

- **`blocked`** — one or more blockers prevent review readiness. Blockers include missing stored proof points (`missing_proofs`), no persisted fit score (`missing_score`), no tailored resume (`missing_resume_material`), a rejected or ungrounded resume (`resume_rejected` / `resume_missing_proof_grounding`), unmatched ordinary questions (`unmatched_questions`), unresolved restricted questions (`restricted_questions_require_input`), and a possible prior application detected from local status evidence (`possible_duplicate_application`). Each blocker includes a recovery `nextAction`.
- **`ready-for-review`** — local evidence and required materials are complete, but at least one current required artifact revision still needs trusted human review.
- **`approved`** — every current required artifact revision is locally human-approved. This means only reviewable completeness plus local approval; it does **not** mean submitted, applied, sent, receipt-recorded, or authorized for an agent to perform an external action (`policy.submissionPerformed: false`, `applicationStatusChanged: false`).

### Exact-revision human review

```bash
# Current pending revisions only.
npm run jobos -- artifacts queue --profile <profile-id> --job <job-id> --json

# Diff an exact revision against its predecessor, or choose another revision
# from the same immutable series with --against.
npm run jobos -- artifacts diff <artifact-id> [--against <artifact-id>] --json

# Trusted local human decisions. Neither command submits, applies, sends,
# changes application status, or records a receipt.
npm run jobos -- artifacts approve <artifact-id> [--note <text>] --json
npm run jobos -- artifacts reject <artifact-id> [--note <text>] --json
```

Each artifact has a stable `seriesKey`, increasing `revision`, predecessor ID, and SHA-256 `contentHash`. Review is allowed only for the exact current revision when its SQLite content and workspace mirror both match that hash. Approval is idempotent; rejection is terminal for that revision. A redraft creates a successor, makes the prior approval stale for current readiness, and returns readiness to `ready-for-review`. Review audit events are `artifact.approved` or `artifact.rejected` with `externalSideEffect: "none"`.

### Immutable application packets and receipts

After readiness reaches `approved`, freeze the exact approved materials, redacted answer-row versions, and target identity before recording an application attempt:

```bash
# Trusted local freeze. This creates no external action.
npm run jobos -- apply packet create --job <job-id> --profile <profile-id> --json

# Inspect immutable history. List requires --job, --profile, or both.
npm run jobos -- apply packet list --job <job-id> --json
npm run jobos -- apply packet show <packet-id> --json
npm run jobos -- apply packet diff <packet-a> <packet-b> --json

# Record what the user did outside JobOS against one exact packet.
npm run jobos -- apply attest-submitted <packet-id> \
  --submitted-at <timezone-qualified-rfc3339> [--note <text>] --json
npm run jobos -- apply confirm-receipt <packet-id> \
  --reference <external-reference> [--note <text>] --json
```

Packet creation requires current readiness `approved`; there is no unapproved bypass. The packet SHA-256 covers approved resume/optional-cover IDs and hashes, matched answer IDs with non-secret row-version fingerprints, target identity, proof IDs, score, blockers, and warnings. It never contains answer plaintext. Equal unchanged input is idempotent. A material, answer, or target edit makes the old packet non-attestable; the next explicit create adds a revision, or starts a new attempt after an attestation. Historical rows remain immutable. Redacted mirrors live under `jobos-workspace/jobs/<job-id>/packets/`.

`attest-submitted` records a `user_attestation`; from `saved`, `researching`, or `materials-ready` it also advances local tracking to `applied` with a status-history note bound to the packet ID, packet hash, and receipt ID. `confirm-receipt` requires that attestation and records the external reference without another status transition. These commands record user evidence only: responses, audits, and readiness retain `externalSideEffects: \"none\"` and `submissionPerformed: false`.

Direct `applications create|update --status applied` remains available for manual/backward-compatible tracking, but it creates no receipt and audits `receiptBound: false`. Application status alone is never presented as receipt evidence. Readiness v3 exposes the independent packet `receiptState` (`none`, `attested`, or `confirmed`).

### Identity and duplicate detection

The plan emits stable identity keys (`identityKey`, `employerKey`, `sourceKey`, `applicationKey`) for cross-session reference. Duplicate checking uses two precision-first signals—exact source URL match and exact dedupe-key (company|title|location) match—both gated on local status or status-history evidence that the matched job reached `applied` or a later outcome. Results appear under `possibleDuplicateApplications` with the matching signals and a disclaimer that no submission receipt is inferred.

### Restricted input redaction

Sensitive and restricted answer values are always redacted in JSON and YAML output (answer text is `null`, `redacted: true`). Restricted questions (`work_authorization`, `demographic`, `legal_attestation`) are never auto-filled. A direct response clears a readiness blocker only when it is recorded for that exact job with `--sensitivity restricted --reuse never_auto_fill --source job:<job-id>`; its value remains redacted in plans and mirrors and is never populated into forms or draft assertions.

### Mirror

The readiness v3 plan is written to `jobos-workspace/jobs/<job-id>/application-readiness.yaml` on every `applications plan` call, during the `application` stage of `pursue`, and after resume/cover, packet, or receipt changes. The mirror carries the same redaction guarantee as JSON and includes an always-present secret-safe packet summary.

### MCP parity

The MCP tool `applications_plan` returns the identical readiness v3 structure. Agents may inspect `review_queue`, `diff_artifact`, `application_packets_list`, `application_packet_show`, and `application_packet_diff` to recommend a human action. MCP and the embedded ACP guest cannot approve/reject artifacts or create/attest/confirm packets, even with spoofed mediation metadata or agent-attestation configuration. The removed local web/API interface provides no mutation bypass. Approval, packet freeze, and receipt evidence remain limited to trusted CLI/TUI policy sources. The `pursue` workflow includes `readiness` in dry-run and real execution but never creates a packet automatically.

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

## People research, networking, and outreach

People research is progressive and human-gated. Confirm the profile's goals, exclusions, source choices, and affiliations before building an open-ended profile network map. In the TUI, press `b` to open **Build My Network Map**; the default action saves the setup without launching research.

```json
{
  "version": 1,
  "targetCompanies": ["Acme Learning"],
  "targetRoles": ["Product Manager"],
  "preferredPersonas": ["recruiter", "hiring_manager", "peer", "alumni"],
  "comfortableRelationshipTypes": ["school", "employer", "community"],
  "exclusions": ["current employer"],
  "allowedSources": {
    "publicWeb": true,
    "linkedinImport": true,
    "xai": false
  }
}
```

```bash
npm run jobos -- profile network-intent \
  --profile pm-edtech --file intent.json --json

# Generic relationship-edge CSV remains supported.
npm run jobos -- network import \
  --profile pm-edtech --file relationships.csv --format generic --json

# A user-exported LinkedIn connections CSV is detected automatically.
npm run jobos -- network import \
  --profile pm-edtech --file Connections.csv --format linkedin --json
```

LinkedIn import accepts the export columns `First Name`, `Last Name`, `URL`, `Email Address`, `Company`, and `Position`. It reads the local file only: JobOS does not sign in to LinkedIn or scrape profile pages. Imported URLs and emails remain local, are tier `U` (`user_imported`), and are never approved automatically. Import audits store counts, the basename, and a short file hash—not raw rows, email addresses, exclusions, or secrets.

Generic relationship CSV uses:

```csv
from_type,from_id,to_type,to_id,edge_type,confidence,evidence
profile,pm-edtech,company,acme,shared_employer,high,Worked with an Acme alum
profile,pm-edtech,person,person_123,direct_connection,high,Former colleague
```

Valid `edge_type` values are `direct_connection`, `shared_employer`, `shared_school`, `shared_investor`, `shared_event`, `shared_open_source`, `shared_customer_domain`, and `manual_note`. Confidence is `low`, `medium`, or `high`.

Run durable research at the narrowest useful scope:

```bash
# Requires confirmed network intent.
npm run jobos -- research people \
  --profile pm-edtech --scope profile --depth standard --json

npm run jobos -- research people \
  --profile pm-edtech --scope target \
  --company "Acme Learning" --role "Product Manager" --json

npm run jobos -- research people \
  --profile pm-edtech --scope job --job <job-id> --depth deep --json

npm run jobos -- research people \
  --profile pm-edtech --scope person --person <person-id> --json

npm run jobos -- research runs get <run-id> --json
npm run jobos -- research runs resume <run-id> --json
npm run jobos -- research runs cancel <run-id> --json
```

Runs persist budgets, usage, warnings, source links, and checkpoints in SQLite. They finish as `succeeded`, `partial`, `paused_retryable`, `failed`, or `cancelled`; retryable runs resume from their saved node. Public observations are cached for seven days and xAI observations for 24 hours unless `--refresh` is used. Standard and deep modes enforce bounded queries, source characters, candidates, model/tool calls, duration, and optional dollar cost.

Default source selection is local-network data, enabled LinkedIn imports, and bounded public web search. Optional GitHub, GDELT, and Wayback adapters can be selected with `--sources public_web,github,gdelt,wayback`. Public LinkedIn profile URLs may be recorded from search results, but JobOS never fetches those profile pages.

xAI X Search is optional, user-keyed, and off by default. It runs only when all three gates pass: profile consent (`allowedSources.xai: true`), `JOBOS_XAI_ENABLED=1`, and `XAI_API_KEY`. Uncited candidates are dropped. If `--max-cost-usd` is supplied, configure `JOBOS_MODEL_PRICING_JSON` for the selected model so the run can enforce the cap before calling xAI.

```bash
export JOBOS_XAI_ENABLED=1
export XAI_API_KEY=...
# Example schema only: replace these values with current provider prices.
export JOBOS_MODEL_PRICING_JSON='{"grok-4.5":{"inputPerMillionUsd":3,"outputPerMillionUsd":15,"xSearchCallUsd":0.01}}'
npm run jobos -- research people \
  --profile pm-edtech --scope target --company "Acme Learning" \
  --sources public_web,xai --max-cost-usd 0.50 --json
```

Research and networking share canonical people, affiliations, source observations, staged candidates, contact points, and relationship edges. Identity resolves by canonical profile URL and then exact imported email—never by name alone. Email checks distinguish syntax, domain/MX, optional SMTP confidence, and user-imported data; guessed addresses are never labeled verified.

```bash
npm run jobos -- network list --json
npm run jobos -- network paths --job <job-id> --json
npm run jobos -- network contacts --job <job-id> --json
npm run jobos -- outreach plan --job <job-id> --profile pm-edtech --json
```

Warm, source-backed paths outrank cold routes. Network access scores describe evidence strength, not the probability of a reply. Contacts remain unapproved until a human explicitly approves them; suppressed contacts cannot be used. Research creates local evidence and review records only—it does not send outreach, create connection requests, apply, or access private accounts.

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

### Host, guest, and the two tool doors

JobOS is the host and source of truth; it is not a general agent harness. `jobos tui` starts an ACP v1 client, launches the real `hermes acp` binary in the selected JobOS workspace, opens a multi-turn session, and attaches JobOS as a session-scoped MCP server. Hermes is the guest. The host sends only the selected job's IDs, fit, proof references, path, artifact metadata, next actions, and policy—not the database or browser secrets. ACP filesystem/terminal capabilities are disabled, permission requests are denied, subprocess environment variables are allowlisted, and streamed events/stderr are secret-redacted.

```text
interactive:  JobOS TUI -> ACP client -> Hermes guest -> session MCP -> domain-tools -> SQLite/workspace
direct:       JobOS TUI/CLI ---------------------------> domain-tools -> SQLite/workspace
external:     external agent -> jobos mcp ------------> domain-tools -> SQLite/workspace
```

Both doors expose the same domain semantics. Agent tool completions reload the authoritative database into list/detail; optimistic revisions reject colliding writers instead of silently merging them. External apply/send or human-confirmation attestations are denied in ACP/MCP mediation unless the operator explicitly enables `JOBOS_ALLOW_AGENT_ATTESTATION=1`. Drafts still default to `draft_needs_human_review`.

Hermes ACP is the primary embedded backend. The System overlay reports the runtime capability matrix. An installed Codex app-server is detected honestly as a separate adapter that is not selected by this ACP client; it is not mislabeled as ACP. The structured subprocess runner below remains a noninteractive batch fallback, not the architecture of the agent pane.

### Noninteractive batch agents


Built-in batch manifests are available when their executables are installed:

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

This batch process must exit `0` and write one JSON object to stdout. Missing executables, timeouts, non-zero exits, malformed/oversized output, and failed connection tests return typed `agent_error`; explicit agent selection never silently falls back to another provider. `--agent` overrides `JOBOS_AGENT` for batch workflow generation. Without either, existing HTTP LLM configuration remains available; without any provider, deterministic degraded mode remains.

External agents can run `jobos mcp`. The server accepts standard Content-Length framing and ACP-session JSONL framing, and exposes `daily_discovery`, `pursue_job`, `applications_plan`, `answers_match`, selection/review/discovery reads, and the lower-level scoring, research, networking, tailoring, application, and scheduler tools through the same `domain-tools` facade.

The repository includes a real external-client drill—not a tool-list unit test. It initializes `jobos mcp`, discovers the live tool catalog, calls `score_job` and `get_job_context`, closes the server, and verifies the same stored score:

```bash
npm run mcp-demo -- --workspace <dir> --profile <profile-id> --job <job-id> \
  --output .tmp/mcp-demo-transcript.jsonl
```

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

On a headless VPS, the TUI, ACP session, CLI, discovery adapters, and external MCP server work without Chromium. A headed `browser login` does not: authenticate on a trusted machine and import an explicit storage-state file, or use a host with a display. Imported sessions can still expire or encounter MFA, CAPTCHA, bot defenses, or site changes; JobOS returns a typed failure and requires manual recovery rather than claiming success. The TUI System overlay deliberately reports browser support as optional/unavailable and never treats the embedded agent as a hidden browser login path.

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

Optional people-research sources are selected per run with `--sources`; GitHub, GDELT, Wayback, and xAI use bounded, isolated adapters. Source failures preserve completed observations and return a partial or retryable run instead of fabricating missing facts.

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
    <profile-id>.yaml
    <profile-id>/
      network-map.yaml
      network-map.md
  proof-points/
  research/runs/
    <run-id>.yaml
    <run-id>.md
  searches/
  discovery/runs/
  jobs/<job-id>/
    research/
    artifacts/
    outreach/
    application-readiness.yaml   # redacted plan mirror
  automations/
  audit.log.jsonl
```

Default help is intentionally small:

```bash
npm run jobos -- --help
npm run jobos -- help --all
npm run jobos -- agent-guide --json
```

The full low-level CLI—manual imports, scoring, tailoring, contact review, task/analytics commands, loops, scheduler controls, and MCP—remains available for composition.

`jobos tui --json` exposes the same presentation model for machine inspection; `jobos tui --snapshot` renders the terminal shell without starting an agent process.

## Safety and honest limitations

- Core state is local; there is no telemetry or required cloud sync.
- Generated claims must trace to stored proof points or cited public sources.
- Draft artifacts default to `draft_needs_human_review`. Local approval or rejection is bound to an exact current revision and never triggers an external effect.
- External effects default off. A browser script runs them only after explicit configuration and `--allow-side-effects`.
- No CAPTCHA bypass, employer-account creation, proprietary global job corpus, or universal Workday/iCIMS/Taleo automation.
- User-exported LinkedIn connection files are local inputs. JobOS records public LinkedIn URLs but does not fetch profile pages, sign in, or bypass platform controls.
- LinkedIn/Indeed DOM-specific bots, universal unattended auto-apply, SMTP auto-send, immutable application packet/receipt graphs, PDF/DOCX production rendering, mail reconciliation, voice rehearsal, offers, and frontend redesign are intentionally deferred.
- `sql.js` is portable but write-heavy concurrent workflows are rejected on stale snapshots rather than merged automatically; reopen and retry.
- A headed browser login needs a display. Headless hosts can import user-owned storage state, but expired auth, MFA, CAPTCHA, and site defenses still require manual recovery.
- `ready-for-review` indicates complete local evidence awaiting human review; `approved` adds only trusted local approval of every current required revision. Neither status means submitted, applied, sent, receipt-recorded, or agent-authorized. Restricted and sensitive answer values are redacted from workspace mirrors and never auto-filled.
- Trusted browser scripts are not sandboxed.

## Verification

```bash
npm test
npm run smoke

# Each demo requires one real local job in <dir>.
npm run acp-demo -- --workspace <dir> --profile <profile-id> --job <job-id> \
  --output .tmp/acp-demo-transcript.jsonl
npm run mcp-demo -- --workspace <dir> --profile <profile-id> --job <job-id> \
  --output .tmp/mcp-demo-transcript.jsonl
```
The ACP drill launches the installed backend, performs same-session tool turns, denies an applied-status policy probe, cancels a live turn, proves zero leaked post-cancel events, starts a clean recovery session, completes an exact `get_job_context` call, restarts again, checks a real deadline and missing-backend typing, and verifies sentinel redaction. Set a throwaway `JOBOS_LLM_API_KEY` value only when explicitly running the transcript-redaction probe; the summary reports whether that sentinel was configured and absent.

The test suite covers the established CLI/domain behavior plus exact artifact lineage/hash/diff/review contracts, readiness approval and redraft invalidation, MCP/ACP review denials, absence of the removed HTTP mutation surface, optimistic two-store races, real ACP framing/lifecycle contracts, locked TUI state binding and responsive controls, external MCP framing, routed discovery, workflow integration, answer safety, agent failure handling, browser session contracts, networking paths, and profile isolation.
