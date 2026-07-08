# Job Researcher module — research eval rubric

_Date started: 2026-07-04. Research does not stop until every criterion scores ≥ 8/10._

Scoring guide: a criterion scores 8+ only when the research names concrete, working, license-compatible open-source building blocks (or documented workarounds), explains how they plug into JobOS's existing CLI/workspace architecture, covers failure modes and ToS/account-risk mitigations, and gives enough implementation detail that a build could start without further research.

## Criteria

| # | Criterion | Score | Round |
|---|-----------|-------|-------|
| 1 | **ATS / job-board parsing** — parse Ashby, Greenhouse, Lever, Workday, etc.: extract keywords, key requirements, and the actual application questions/fields | **9/10** | R1 |
| 2 | **LinkedIn access** — job postings, company info, people data, treated as a parseable web source; realistic "unlimited access" workarounds with account-risk analysis | **8/10** | R1 |
| 3 | **Universal page parsing** — turn any company careers page / arbitrary job posting URL into structured, parseable data | **8/10** | R1 |
| 4 | **Pluggability** — module integrates into the current JobOS CLI/workspace AND its fundamentals stand alone (own CLI/library, no JobOS dependency) | **9/10** | R1 |
| 5 | **Open-source grounding** — concrete OSS projects/workarounds identified, licenses checked, reuse strategy stated | **8/10** | R1 |

## Scoring log

### Round 1 (2026-07-04) — all criteria ≥ 8. Threshold met.

- **C1 = 9.** Firsthand-verified public JSON APIs for Greenhouse (incl. 17 application questions via `?questions=true`), Ashby (full app form via undocumented GraphQL, no key), Lever, Workday, SmartRecruiters. ATS-detection regexes, keyword-extraction strategy, and a concrete `AtsAdapter` interface with an explicit `supported:false` path for ATSes that don't expose questions. Not 10: Lever/Workday application-question extraction still needs a Playwright fallback that isn't yet spec'd to field level, and SmartRecruiters form coverage unconfirmed.
- **C2 = 8.** Layered strategy (guest JSON-LD → user's-own-browser CDP/extension attach → GDPR export), verified guest endpoint returns data, concrete libraries with licenses, real account-risk analysis (hiQ, Proxycurl shutdown, reported thresholds) and mitigations. Not higher: "unlimited access" is inherently ToS-capped; the honest ceiling is human-paced personal use, not unlimited automated scraping — so 8 reflects the best *responsible* answer.
- **C3 = 8.** Full ordered fallback pipeline (JSON-LD → ATS API → Readability → headless → LLM → manual paste), library table w/ licenses+maintenance, anti-bot realism, careers-page discovery. Not higher: Cloudflare-walled SPAs remain a real gap handled only by manual-paste fallback.
- **C4 = 9.** `@jobos/researcher` standalone package (own CLI + library, zero JobOS imports, optional peer deps for Playwright/LLM) with a concrete drop-in for JobOS's `importUrl()` and named schema changes. Deterministic core is key-free/local-first, matching current constraints.
- **C5 = 8.** Concrete OSS projects named with licenses (JobSpy/adgramigna/d-alleyne MIT, Resume-Matcher Apache-2.0), copyleft/no-license flagged (jobspy-mcp-server avoided), reuse-as-pattern vs reuse-as-code distinguished. Not higher: reuse is mostly pattern-level since no surveyed project extracts application questions.

**Conclusion: feasible.** Every criterion ≥ 8/10. Build recommendation stands.
