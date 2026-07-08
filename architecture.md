# Architecture for Enhanced Research and Outreach in JobOS

Updated: 2026-07-08

## Goal

Add a local-first, headless-capable research and outreach intelligence layer to JobOS. The design should deepen company dossiers, stakeholder discovery, contact detail discovery, 2nd-degree network expansion, and outreach planning while preserving the product invariant: JobOS may research, draft, score, and stage work, but external actions stay human-gated.

## Current Baseline

The existing worktree already provides strong foundations:

- `src/research.js`: company dossiers, stakeholder search, source filtering, LLM synthesis with unsupported-claim dropping, user-pasted stakeholder records.
- `src/outreach.js`: evidence-grounded outreach drafts, local outreach threads, human-sent recording, follow-up task scheduling, due follow-up listing.
- `src/search.js`: provider chain for DuckDuckGo HTML, Brave, and SearXNG.
- `src/db.js`: SQLite schema with `companies`, `jobs`, `stakeholders`, `artifacts`, `outreach_threads`, `tasks`, `automation_runs`, and `audit_log`.
- `src/api.js` and `src/mcp.js`: existing API/MCP surfaces for outreach drafting and lifecycle operations.
- `run_eval_research.js`: local fake-search/fake-LLM harness proving source-grounded research and human-gated outreach behavior.

The proposed architecture extends these modules rather than replacing them.

## Design Principles

1. Public, user-provided, and user-authorized account sources are allowed. Private-account access is acceptable only when the user explicitly grants access to their own session or exported data. No bypassing access controls, captchas, rate limits, or use of leaked data.
2. Evidence first. Every fact, person, contact point, and outreach angle must trace to source observations.
3. Confidence is explicit. Use clear tiers such as exact public email, pattern candidate, DNS-valid domain, unverified mailbox, source-backed stakeholder.
4. Human gates stay hard. JobOS never sends email, LinkedIn messages, connection requests, applications, or follow-ups.
5. Headless by default. CLI/API/MCP must work in a server, CI, or SSH environment without browser automation. A next iteration may add an optional user-GUI-browser connector for user-authorized sessions.
6. Local-first privacy. Store cache, evidence, contacts, drafts, graph edges, and audit entries in the selected workspace.

## Core Components

```text
Job + profile
  -> Company Identity Resolver
  -> Source Collector
  -> Source Observation Ledger
  -> Company Dossier Synthesizer
  -> Person Candidate Extractor
  -> Contact Discovery Engine
  -> Network Graph Mapper
  -> Outreach Planner
  -> Human Review Queue / Draft Artifacts / Follow-up Tasks
```

### 1. Company Identity Resolver

Purpose: canonicalize company name, domain, ATS board, aliases, and source trust before deeper research.

Inputs:

- Existing `jobs.company`, `jobs.url`, `companies.website`, imported job text, and ATS adapter metadata.
- Public sources from company website, ATS pages, SEC EDGAR for public companies, and search results.

Outputs:

- Canonical domain and aliases.
- Company source trust score.
- Known ATS board handles.
- Collision warnings when multiple similarly named companies appear.

Integration:

- Extend `companies` with `domain`, `aliases_json`, `source_confidence`, and `identity_sources_json`, or store this in a new `company_research_profiles` table if keeping `companies` lean is preferred.
- `research company` calls this before query generation.

### 2. Source Collector

Purpose: gather raw evidence observations from low-cost, configured, or user-authorized sources.

Adapters:

- Existing search provider chain: DuckDuckGo, Brave, SearXNG.
- Optional agentic search provider adapters: Perplexity, Tavily, Exa, or similar, enabled only when configured and kept if evaluations show better precision, coverage, or evidence quality than the default chain.
- Company website pages: homepage, careers, about, team, press, blog, sitemap, `robots.txt` respect.
- ATS public APIs: current Greenhouse/Lever adapters; add Ashby/Workable only when public endpoints are straightforward.
- News/index sources: GDELT, Common Crawl URL index, RSS feeds.
- Public/government sources: SEC EDGAR, BLS, O*NET, OFLC H-1B disclosure data, USAspending where relevant.
- GitHub public API/search for technical companies, respecting rate limits.
- User-pasted source cards and exported account data for LinkedIn/profile/manual research; future optional browser-session observations belong to the user-authorized GUI connector.

Implementation shape:

- New `src/research/sources.js` with adapter interface:

```js
async function collect({ company, domain, job, queryPack, limit, env }) {
  return [{ url, title, snippet, sourceType, provider, query, fetchedAt, rawText?, trust }];
}
```

Storage:

- New `source_observations` table:

```text
id TEXT PRIMARY KEY
company_id TEXT
job_id TEXT
url TEXT NOT NULL
canonical_url TEXT NOT NULL
title TEXT
snippet TEXT
source_type TEXT NOT NULL
provider TEXT NOT NULL
query TEXT
trust TEXT NOT NULL
fetched_at TEXT NOT NULL
content_hash TEXT
metadata_json TEXT NOT NULL DEFAULT '{}'
```

Workspace mirror:

- `jobos-workspace/jobs/<job-id>/research/source-observations.yaml`

### 3. Company Dossier Synthesizer

Purpose: turn source observations into concise role-specific dossiers.

Existing baseline:

- `research company` already creates `company-dossier.md`, `companies.facts_json`, open questions, outreach angles, and warnings.

Enhancements:

- Add categories: identity, product/customer, hiring pulse, funding/financial, compensation/salary, culture/risk, legal/regulatory, role-specific team context.
- Render fact type as `fact`, `inference`, or `question`.
- Track source count and freshness per category.
- Generate "outreach-safe facts" separately from "interview-only risk notes".

Output:

- Existing `company-dossier.md` plus `company-research.yaml` for structured agent use.

### 4. Person Candidate Extractor

Purpose: discover relevant People Ops, recruiting, hiring-manager, executive, peer, alumni, and investor candidates.

Inputs:

- Source observations.
- Existing `stakeholders` records.
- Job title/role family.
- User-provided profile/proof point employers, schools, communities.

Extraction:

- Deterministic parsing: page title patterns, `Person - Title at Company`, `schema.org/Person` if present, `mailto:` anchors, author pages.
- Conservative LLM structuring when configured: only from supplied source text and URL.
- Role taxonomy:
  - recruiting/talent/people ops
  - likely hiring manager
  - functional peer
  - founder/executive
  - alumni/shared connection
  - investor/advisor
  - public expert

Storage:

- Continue using `stakeholders` for approved/visible candidates.
- Add `person_candidates` for pre-review candidates:

```text
id TEXT PRIMARY KEY
job_id TEXT
company_id TEXT
name TEXT NOT NULL
role TEXT
function TEXT
seniority TEXT
relevance TEXT NOT NULL
confidence TEXT NOT NULL
source_observation_ids_json TEXT NOT NULL DEFAULT '[]'
status TEXT NOT NULL DEFAULT 'candidate'
suppression_reason TEXT NOT NULL DEFAULT ''
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Promotion:

- `research stakeholders` can write candidates to `person_candidates`.
- `research promote-stakeholder --candidate <id>` or an API/dashboard action promotes to `stakeholders`.
- Current direct upsert behavior can remain for MVP compatibility.

### 5. Contact Discovery Engine

Purpose: recreate the practical parts of Hunter-style contact discovery without paid data.

Subcomponents:

- Email extractor: parses exact public emails and `mailto:` links from source observations.
- Pattern detector: infers email patterns from exact public person emails on the same domain.
- Candidate generator: creates transparent email hypotheses for source-backed people only.
- DNS verifier: syntax, domain, MX, SPF, DMARC, disposable-domain checks.
- Risk labeler: catch-all unknown, generic inbox, role account, stale source, guessed address.

Storage:

```text
contact_points
id TEXT PRIMARY KEY
person_id TEXT
stakeholder_id TEXT
company_id TEXT
type TEXT NOT NULL              -- email, profile_url, generic_inbox, website
value TEXT NOT NULL
normalized_value TEXT NOT NULL
evidence_tier TEXT NOT NULL     -- A, B, C, D, E
verification_status TEXT NOT NULL
confidence TEXT NOT NULL
source_observation_ids_json TEXT NOT NULL DEFAULT '[]'
checks_json TEXT NOT NULL DEFAULT '{}'
human_approved INTEGER NOT NULL DEFAULT 0
do_not_use INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

```text
email_patterns
id TEXT PRIMARY KEY
company_id TEXT NOT NULL
domain TEXT NOT NULL
pattern TEXT NOT NULL           -- first, first.last, flast, first_last, etc.
support_count INTEGER NOT NULL
support_sources_json TEXT NOT NULL DEFAULT '[]'
confidence TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Persistence and verification policy:

- Default checks are local/DNS/public-source only.
- Exact public contacts and user-approved contacts may be stored in `contact_points`.
- Guessed email candidates are rendered only in review worksheets until the user approves them; approval creates the persistent `contact_points` row.
- SMTP mailbox probing is allowed only behind an explicit advanced flag and remains disabled by default.
- "Verified" means exact public evidence or user approval, not merely MX presence.

CLI/API shape:

- `jobos research contacts --job <job-id> --json`
- `jobos research contacts --stakeholder <stakeholder-id> --json`
- `jobos research approve-contact --contact <contact-id> --json`
- `jobos research approve-contact --worksheet-candidate <candidate-id> --json`
- API: `GET /api/research/contacts?jobId=...`, `POST /api/research/contacts/:id/approve`
- MCP: `discover_contacts`, `approve_contact`

### 6. Network Graph Mapper

Purpose: identify warm or semi-warm outreach paths without accessing private networks.

Storage:

```text
relationship_edges
id TEXT PRIMARY KEY
from_type TEXT NOT NULL         -- profile, proof_point, company, person
from_id TEXT NOT NULL
to_type TEXT NOT NULL
to_id TEXT NOT NULL
edge_type TEXT NOT NULL         -- shared_employer, shared_school, shared_investor, shared_event, shared_open_source
evidence_json TEXT NOT NULL DEFAULT '[]'
confidence TEXT NOT NULL
created_at TEXT NOT NULL
```

Sources:

- Stored proof points and resume text.
- User-imported relationship files in `jobos-workspace/network/*.yaml`.
- Public bios, event pages, GitHub orgs, VC portfolio pages, company customer pages.

CLI/API shape:

- `jobos network import --file <csv|yaml> --json`
- `jobos research network --job <job-id> --json`
- API: `GET /api/research/network?jobId=...`
- MCP: `map_reachable_network`

Output:

- `jobos-workspace/jobs/<job-id>/research/network-map.md`
- Ranked contact path ladder:
  1. direct user-provided connection
  2. shared employer/school/community
  3. shared investor/portfolio/community
  4. exact public contact
  5. generic routing inbox
  6. no safe path

### 7. Outreach Planner

Purpose: choose the best human-gated outreach path and generate better drafts.

Existing baseline:

- `outreach draft` already selects stakeholder/company/proof evidence, writes a draft artifact, and creates a thread.

Enhancements:

- Add `outreach_plans` table or structured artifact metadata:

```text
id TEXT PRIMARY KEY
job_id TEXT
profile_id TEXT
stakeholder_id TEXT
contact_point_id TEXT
goal TEXT NOT NULL
channel TEXT NOT NULL           -- email, linkedin_manual, generic_inbox, intro_request, no_safe_path
path_strength TEXT NOT NULL
recommended INTEGER NOT NULL DEFAULT 0
reasoning_json TEXT NOT NULL DEFAULT '{}'
warnings_json TEXT NOT NULL DEFAULT '[]'
created_at TEXT NOT NULL
```

- Drafts should render:
  - selected channel and why
  - contact confidence
  - evidence list
  - unresolved assumptions
  - compliance/reminder checklist
  - manual copy/send gate

Commands:

- `jobos outreach plan --job <job-id> --profile <profile-id> --json`
- Existing `jobos outreach draft` accepts `--plan <plan-id>` or explicit `--contact <contact-id>`.

## Data Flow Details

### Enhanced Company Dossier

1. User runs `jobos research company --job <job-id> --depth enhanced --json`.
2. Identity resolver canonicalizes company/domain and flags collisions.
3. Source collector runs role-specific query packs and public-source adapters.
4. Observations are deduped and stored.
5. Dossier synthesizer writes structured facts, inferences, open questions, and outreach-safe angles.
6. `companies.facts_json` remains a compatibility summary; richer data is in `source_observations` and structured workspace files.
7. Audit logs record query count, source count, warnings, and external side effect `none`.

### Stakeholder and Contact Discovery

1. User runs `jobos research stakeholders --job <job-id> --json`.
2. Person extractor creates ranked candidates from observations, public search, and explicitly user-authorized account sources where available.
3. Contact engine extracts exact emails and patterns, then generates contact points.
4. Exact and user-approved contacts may be persisted; guessed email candidates remain worksheet-only until approval.
5. Candidates with sufficient relevance are promoted or staged for review.
6. Markdown worksheet shows person, role relevance, contact evidence tier, source URLs, and warnings.
7. No message is sent, and private-account sources are accessed only through explicit user authorization.

### Outreach Planning and Drafting

1. User runs `jobos outreach plan --job <job-id> --profile <profile-id> --json`.
2. Planner ranks candidate paths by relationship strength, contact confidence, role relevance, source freshness, and application status.
3. User chooses a plan or lets JobOS draft for the top recommended plan.
4. Draft generation uses only allowed evidence: stakeholder source, company fact, contact evidence, relationship edge, and proof point.
5. Existing `outreach_threads` records human-sent status and follow-up tasks.

## Confidence Model

Use transparent additive scoring, then map to labels:

```text
person_relevance =
  role_title_match
  + company_affiliation_strength
  + role_family_alignment
  + source_trust
  + source_recency
  - ambiguity_penalty

contact_confidence =
  exact_public_email_evidence
  + same_domain_pattern_support
  + dns_mx_present
  + person_company_match
  - guessed_pattern_penalty
  - stale_source_penalty
  - generic_or_role_account_penalty

path_strength =
  relationship_edge_strength
  + stakeholder_relevance
  + contact_confidence
  + outreach_goal_fit
  - application_status_pause_penalty
  - suppression_penalty
```

Labels:

- `high`: exact source-backed and low ambiguity.
- `medium`: source-backed but incomplete, stale, or pattern-derived.
- `low`: weak source support or only a hypothesis.
- `blocked`: suppression, do-not-contact, unauthorized private-account source, or unsafe channel.

## Privacy, Ethics, and Compliance

Hard prohibitions:

- No auto-send, auto-connect, auto-apply, or auto-follow-up.
- No private-account access unless the user explicitly authorizes their own session or exported data.
- No bypassing access controls, captchas, or rate limits.
- No breached/leaked datasets.
- No hidden tracking pixels or email open tracking.
- No actual email delivery for verification.
- No SMTP mailbox probing unless the user enables the explicit advanced flag.

Default safeguards:

- Store source URL, query, provider, timestamp, and confidence for every observation.
- Keep guessed email candidates out of persistent contact storage until user approval.
- Require human approval before a contact point can be used in an email-channel draft.
- Keep suppression lists local.
- Pause outreach when application status is interview, offer, rejected, or user-suppressed.
- Render a cold-email compliance checklist, but do not insert a default opt-out sentence or claim legal compliance.

## MVP Scope

MVP should fit the existing single-user, local-first CLI and dashboard:

1. Add `source_observations`, `person_candidates`, `contact_points`, `email_patterns`, and `relationship_edges` tables with migrations.
2. Refactor `research company` and `research stakeholders` to store reusable source observations.
3. Add deterministic email extraction, pattern inference, DNS/MX checks, and optional advanced SMTP probing.
4. Add `research contacts` command and worksheet.
5. Add user-imported network CSV and `research network` command.
6. Add `outreach plan` command that ranks safe paths and feeds existing `outreach draft`.
7. Add dashboard contact views for candidate review, confidence labels, approval, and suppression.
8. Extend `run_eval_research.js` with fake source pages, exact email examples, pattern examples, network edges, and negative cases.

Out of MVP:

- Browser automation.
- Required paid APIs.
- User-GUI-browser private-account connector.
- Automatic sending/sequencing.
- Phone number enrichment except official public switchboard or user-provided values.

## Future Expansion

- Additional public ATS adapters such as Ashby and Workable.
- Per-company source cache with freshness policies and diffing.
- Dashboard views for stakeholder map and network path ladder beyond the MVP contact review view.
- Local LLM or embedding-based dedupe for person/company aliases.
- Bring-your-own paid or agentic search/enrichment adapter behind the same evidence/confidence interface, disabled by default and retained only when evaluations prove better results.
- Optional user-GUI-browser connector for explicitly authorized sessions, separated from headless CLI/API/MCP behavior.
- Team/multi-profile mode with encrypted local store if JobOS expands beyond single-user local operation.

## Recommended Implementation Order

1. Schema and source ledger: add tables and mirror files without changing user behavior.
2. Enhanced company identity and source collection: reuse current search provider chain and ATS adapters.
3. Contact extraction and email pattern lab: exact public emails first, then pattern inference.
4. Contact verification: syntax and DNS/MX only, with explicit unverified labels.
5. Person candidate staging: separate candidate extraction from promoted stakeholders.
6. Network graph import and mapping: start with user-provided CSV plus stored proof points.
7. Outreach planner: rank paths and feed existing draft/thread/follow-up lifecycle.
8. API/MCP/dashboard exposure: only after CLI behavior and eval coverage are stable.
9. Eval expansion: hard assertions for no-send, no-private-scrape, no unsupported contact claims, confidence labels, and headless deterministic runs.

## Test Strategy

Targeted unit/behavior tests:

- Source observations dedupe by canonical URL and content hash.
- Company identity collision warnings.
- Exact email extraction from HTML and text.
- Pattern inference from multiple public examples.
- DNS/MX checks using injectable fake DNS resolver.
- Optional SMTP probing using injectable fake SMTP resolver and explicit advanced flag.
- Contact confidence labels for exact, pattern, and DNS-only cases.
- Stakeholder candidate promotion and suppression.
- Network edge CSV import and path ranking.
- Dashboard contact review, approval, and suppression behavior.
- Outreach planner blocks unapproved guessed contacts.

End-to-end eval additions:

- Fake search server returns company pages, team pages, exact emails, generic inboxes, and distractors.
- Fake DNS resolver returns MX/no-MX/catch-all-like cases.
- Fake SMTP resolver returns accepted/rejected/unknown cases without sending email.
- Fake LLM attempts unsupported contact claims; JobOS drops them.
- Hard assertions prove no live network beyond local fake servers unless explicitly configured, no sent outreach, and no unauthorized private-account access.

## Risks and Unknowns

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Search provider instability | Missing or noisy sources | Cache observations, support SearXNG, evaluate optional agentic providers, show warnings |
| False positive people | Bad outreach targeting | Candidate staging, source-backed role checks, LLM conservative filtering |
| False positive emails | Trust damage | Evidence tiers, no "verified" for guesses, approval gates |
| Legal/compliance ambiguity | User misuse | Clear warnings, no sending, suppression lists, compliance checklist without default opt-out sentence |
| Scope creep into CRM/sequencer | Product invariant erosion | Keep outreach lifecycle local and human-gated |
| Large single-file complexity | Maintainability risk | Put new logic under `src/research/` modules while keeping CLI router thin |

## Product Decisions Captured

1. Guessed email candidates are only rendered in review worksheets until approved.
2. SMTP probing is allowed only behind an explicit advanced flag.
3. Relationship import ships first as CSV.
4. Cold email drafts do not include a default opt-out sentence.
5. Dashboard contact views are included in the first implementation loop.

## Self-Evaluation Rubric

Scores use 1-5, where 5 means the criterion is strongly satisfied in the final docs.

### Research Quality

1. Source coverage: names concrete public, user-authorized, and optional configured sources and cites official docs where possible.
2. Accuracy and honesty: distinguishes facts, inferences, hypotheses, and unavailable proprietary coverage.
3. Contact/outreach priority: puts personnel and contact discovery ahead of generic company research.
4. Headless baseline feasibility: avoids required paid APIs and browser automation for MVP.
5. Limitations and open questions: surfaces legal, ethical, data-quality, and operational trade-offs.
6. Integration relevance: ties research to JobOS data, commands, and invariants.

### Functionality and Integration

1. Fits current modules: builds on `research.js`, `outreach.js`, `search.js`, DB, API/MCP, and eval harness.
2. Data model clarity: proposes concrete tables, fields, confidence labels, and workspace mirrors.
3. Flow completeness: covers company dossier, stakeholder discovery, contact discovery, network mapping, outreach planning, and follow-ups.
4. Testability: includes deterministic headless test/eval strategy.
5. Safety enforcement: includes hard gates against unsupported claims, unauthorized private-account access, and auto-send behavior.
6. Implementation order: breaks MVP and future work into sequenced steps.

### Creative and UX Design

1. Hunter/Apollo reconstruction: recreates useful workflow pieces without pretending to match proprietary databases.
2. Contact confidence UX: gives users understandable evidence tiers and path strength.
3. Outreach effectiveness: improves "why this person, why now, why me" drafting.
4. 2nd-degree expansion: includes practical local graph ideas from proof points, alumni, employers, VC, events, and open source.
5. Human review ergonomics: supports approval, suppression, warnings, and copy/manual-send gates.
6. Role-specific value: prioritizes People Ops, recruiters, hiring managers, and relevant functional stakeholders.

## Self-Evaluation and Revision Log

### Cycle 1

Scores:

- Research Quality: 4.1/5
- Functionality and Integration: 3.8/5
- Creative and UX Design: 3.7/5

Findings:

- The first outline overemphasized email guessing and under-specified evidence tiers.
- Architecture needed clearer schema proposals and command surfaces.
- Network expansion was too abstract.

Revisions made:

- Added evidence tiers A-E, contact confidence model, table schemas, CLI/API/MCP proposals, and relationship edge types.

Remaining gaps after cycle 1:

- Need stronger compliance language and clearer SMTP boundary.
- Need more measurable test strategy.

### Cycle 2

Scores:

- Research Quality: 4.5/5
- Functionality and Integration: 4.3/5
- Creative and UX Design: 4.2/5

Findings:

- The architecture now fit JobOS better but still risked sounding like a sending/sequencing system.
- The company dossier section needed better HR/operational signal coverage.
- Contact verification needed explicit "not verified by MX alone" language.

Revisions made:

- Added hard prohibitions, compliance safeguards, HR/operational source matrix, verification policy, and explicit no-send/no-SMTP-by-default language.

Remaining gaps after cycle 2:

- User decisions remained around persistent guessed contacts, opt-out defaults, relationship import format, and dashboard priority.

### Cycle 3

Scores:

- Research Quality: 4.7/5
- Functionality and Integration: 4.6/5
- Creative and UX Design: 4.5/5

Findings:

- The final docs are actionable for a follow-on implementation loop and preserve the product invariants.
- The largest remaining uncertainty was policy/product direction, not architecture: how aggressive JobOS should be with guessed emails and cold-email compliance text.

Remaining gaps after cycle 3:

- Exact source reliability will only be proven once the implementation runs against fixture and real-world cases.
- Jurisdiction-specific outreach compliance requires human/legal review.

### Cycle 4

Findings:

- Product decisions now allow user-authorized private-account sources, optional agentic search providers, worksheet-only guessed email candidates, advanced-flag SMTP probing, CSV relationship import, no default opt-out sentence, and first-loop dashboard contact views.
- The architecture still preserves human-gated external actions: research and drafting can be staged, but JobOS does not send or submit.

Remaining gaps after cycle 4:

- The user-GUI-browser connector remains a next-iteration design item, separate from the headless MVP.
- Optional agentic search providers must prove better results in fixture and real-world evaluations before becoming recommended defaults.

## Recommended Next Steps

1. Start with schema plus source observation ledger. This unlocks richer research without changing user-facing outreach behavior.
2. Implement exact email extraction and evidence-tiered contact worksheets before rendering any guessed email candidates.
3. Add fake-search/fake-DNS/fake-SMTP eval cases that prove JobOS rejects unsupported contacts and labels pattern guesses correctly.
4. Add `research contacts`, `outreach plan`, CSV relationship import, and dashboard contact review behind JSON/API-compatible data shapes.
5. Add optional agentic provider adapters and the user-GUI-browser connector only after the headless workflow is deterministic and well covered.
