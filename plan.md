# Enhanced Research and Outreach Plan

Updated: 2026-07-09

## Phase 0 - Harness State

- [x] Capture must-meet criteria in `SKILLS.md`.
- [x] Maintain this atomic task plan.
- [x] Maintain `eval_progress.md` with test scores, evidence, and fix loops.

Acceptance: future agents can resume without rereading all source docs.

## Phase 1 - Contact Discovery Core

- [x] Add conservative company identity resolver fields and structured `company-research.yaml`.
- [x] Add schema/migrations for `source_observations`, `person_candidates`, `contact_points`, `email_patterns`, `relationship_edges`, and `outreach_plans`.
- [x] Implement source observation storage and workspace mirror.
- [x] Implement public page fetcher for company home, team, about, press, contact, careers pages.
- [x] Extract `mailto:` anchors, plain-text emails, likely person names/titles, and public profile URLs from observations.
- [x] Infer email patterns from exact public emails.
- [x] Verify domains with DNS/MX/TXT/NS checks through injectable resolver support.
- [x] Render contact worksheet with A-E tiers, warnings, and human gate text.
- [x] Add `research contacts` and `research approve-contact` CLI commands.

Acceptance: a fake company team page produces exact public contact points, inferred pattern candidates, DNS labels, and a workspace worksheet without sending anything.

## Phase 2 - Person Discovery

- [x] Stage public people in `person_candidates` before promotion.
- [x] Add `research promote-stakeholder`.
- [x] Allow LinkedIn `/in/` URLs from search results and record them as Tier E `profile_url` contact points.
- [x] Expand stakeholder search query packs for people ops, recruiters, hiring managers, and public profiles.
- [x] Add GitHub org/member source adapter.

Acceptance: noisy search results produce reviewable candidates; only promoted candidates become stakeholders.

## Phase 3 - Network and Outreach Planning

- [x] Add CSV network import.
- [x] Add `research network --job`.
- [x] Rank contact path ladder.
- [x] Add `outreach plan`.
- [x] Allow `outreach draft --plan <plan-id>` or explicit `--contact <contact-id>`.
- [x] Enforce suppression/approval/channel warnings before email-channel drafts.

Acceptance: JobOS recommends safe, human-gated paths and blocks unsafe email drafts without approval.

## Phase 4 - Optional Adapters and Verification Depth

- [x] Add optional Exa/Tavily providers behind env vars.
- [x] Add GDELT news/event adapter.
- [x] Add Wayback CDX archived team-page adapter.
- [x] Add opt-in SMTP probing behind `JOBOS_SMTP_PROBE=true`.

Acceptance: optional providers feed the same source observation/evidence model and never become unsourced truth.

## Phase 5 - Surfaces and Docs

- [x] Expose contacts/network/plans through API.
- [x] Expose contacts/network/plans through MCP.
- [x] Add dashboard contact review and outreach plan views.
- [x] Update README command/API/MCP contract.
- [x] Update BUILD_PROGRESS verification log.

Acceptance: CLI, API, MCP, dashboard, README, and workspace mirrors agree on behavior and policy.
