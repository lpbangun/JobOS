# Enhanced Research and Outreach Eval Progress

Updated: 2026-07-09

## Rubric

Scores use 1-10. The pass bar is 9/10 for each component and zero hard assertion failures.

| Component | Required evidence | Score | Status |
| --- | --- | ---: | --- |
| Source observations | Stored, deduped, mirrored observations include URL, canonical URL, source type, provider, query, trust, timestamp, and metadata | 10 | Passing |
| Page/email extraction | Fake public pages produce exact public emails and source-backed observations | 10 | Passing |
| Email pattern inference | Multiple exact emails infer transparent patterns and candidate addresses without claiming verification | 10 | Passing |
| DNS verification | Injectable resolver proves MX/no-MX/TXT/NS labels without live network in tests | 10 | Passing |
| LinkedIn URL policy | Search-result LinkedIn `/in/` URLs are recorded as profile URLs and never fetched | 10 | Passing |
| Person candidate staging | Public people are staged before promotion; stakeholders only get approved/promoted records | 9 | Passing |
| Contact approval | Approval updates human-approved status and audit/workspace state | 10 | Passing |
| Network mapping | CSV/manual edges produce a local path ladder | 9 | Passing |
| Outreach planning | Ranked plans select safe human-gated channels and block unsafe unapproved guessed contacts | 9 | Passing |
| API/MCP/dashboard | Local surfaces expose review/approval without external side effects | 9 | Passing |

## Iteration Log

### Iteration 0 - Baseline

Evidence:

- `architecture.md`, `research.md`, and `AUDIT.md` reviewed.
- Current baseline has research dossiers, stakeholder search, outreach drafts, follow-ups, API/MCP/dashboard surfaces, and `run_eval_research.js`.
- Current baseline does not implement the contact discovery tables, page extraction, patterns, DNS checks, candidate staging, network graph, or outreach planner.

Hard assertions:

- Baseline research eval is documented as passing 33/33, but it does not cover contact discovery.

### Iteration 1 - Contact Discovery Core and Surfaces

Implemented:

- Added `source_observations`, `person_candidates`, `contact_points`, `email_patterns`, `relationship_edges`, and `outreach_plans` schema.
- Added `src/research/sources.js`, `src/research/contacts.js`, and `src/research/network.js`.
- Added contact discovery CLI/API/MCP/dashboard surfaces, contact approval/suppression, person promotion, network CSV import, and outreach path planning.
- Added optional Exa/Tavily/Perplexity search providers and configured GitHub/GDELT/Wayback public-source adapters.
- Added opt-in SMTP probing with fixture support for deterministic tests.

Evidence:

- `node --test tests/sprint10-contact-discovery.test.js` passed 5/5.
- `node --test tests/sprint8-search.test.js` passed 4/4.
- `node --test tests/sprint3-research.test.js` passed 6/6 after stakeholder query-pack update.
- `node run_eval_research.js` passed: 33/33 hard assertions; dossier, stakeholder, and outreach axes all 10/10.
- `npm test` passed 44/44 after final adapter/docs updates.
- `npm run smoke` passed end-to-end.

Known remaining verification:

- None for the implemented enhanced research/contact/outreach MVP scope.
