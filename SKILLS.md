# Enhanced Research and Outreach Criteria

Updated: 2026-07-09

This file captures must-meet criteria for the enhanced JobOS research and outreach implementation.

## Product Invariants

- Local-first by default: no telemetry, cloud sync, required API keys, or hidden remote services for core flows.
- Human gates are hard: JobOS never sends email, LinkedIn messages, connection requests, applications, follow-ups, or test emails.
- Evidence first: every company fact, person candidate, contact point, network edge, and outreach path must trace to source observations or user-provided data.
- Tailoring and outreach drafts must use stored proof points and source-backed facts; they must not invent accomplishments, relationships, contacts, or unverifiable claims.
- Public company pages may be fetched with `fetch()` and parsed with cheerio. This is not browser automation.
- LinkedIn public profile URLs may be recorded from search results as profile URLs, but JobOS must not fetch LinkedIn pages or automate LinkedIn actions.
- Guessed email addresses must be labeled as candidates or hypotheses, never verified contacts.
- SMTP probing, when implemented, must be opt-in behind `JOBOS_SMTP_PROBE=true`, rate-limited, audited, and must quit before DATA.

## Architecture Decisions

- Build on the existing modules instead of replacing them:
  - `src/research.js` remains the research CLI coordinator.
  - New contact-specific logic can live under `src/research/`.
  - `src/db.js` owns schema/migrations.
  - `src/mcp.js` exposes agent-readable local data; the CLI/TUI provide trusted human interaction.
- SQLite is canonical; workspace Markdown/YAML mirrors are generated for agent readability.
- Search-provider prose is not truth. Search and page fetch results become `source_observations`, then extraction/scoring reads from observations.
- Exact public contacts and user-approved contacts may persist in `contact_points`.
- Guessed contacts remain review-visible and may persist only as unapproved candidates with clear evidence tier/status labels.

## Required Data Model

- `source_observations`: URL/query/provider/source-type evidence ledger.
- `person_candidates`: pre-review people discovered from public sources.
- `contact_points`: email/profile/website/generic inbox contact records with evidence tiers and approval flags.
- `email_patterns`: observed company email pattern support.
- `relationship_edges`: local network/warm-path graph edges.
- `outreach_plans`: ranked, human-gated outreach paths.

## Required Commands and Surfaces

- CLI:
  - `jobos research contacts --job <job-id> --json`
  - `jobos research contacts --stakeholder <stakeholder-id> --json`
  - `jobos research approve-contact --contact <contact-id> --json`
  - `jobos research approve-contact --worksheet-candidate <candidate-id> --json`
  - `jobos research promote-stakeholder --candidate <candidate-id> --json`
  - `jobos network import --file <csv> --json`
  - `jobos research network --job <job-id> --json`
  - `jobos outreach plan --job <job-id> --profile <profile-id> --json`
- MCP:
  - Contact context and outreach planning remain agent-readable.
  - Contact approval remains limited to trusted CLI/TUI paths.
  - `map_reachable_network`
- Dashboard:
  - contact review with tier/confidence/approval labels
  - outreach plan review with channel/path warnings

## Verification Requirements

- Deterministic tests cover:
  - page extraction from fake HTML with `mailto:` and plain text emails
  - pattern inference from multiple exact public emails
  - DNS/MX labels through an injectable fake resolver
  - LinkedIn URL recording without page fetching
  - person candidate staging and promotion
  - contact approval flow
  - outreach planner blocking unapproved guessed contacts
- End-to-end gates:
  - `node --test` targeted tests for changed modules
  - `node run_eval_research.js`
  - `npm test`
  - `npm run smoke` for broad CLI/TUI behavior when changes are non-trivial
