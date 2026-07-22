# Open-Source Benchmark Checkup: JobOS Capability Depth

**Date:** 2026-07-22  
**Question:** Are JobOS's existing features implemented deeply enough to help a person get a job, rather than merely present in the command list?  
**Scope:** Existing JobOS journey only: profile/proofs → discovery → fit decision → research/networking → tailored materials → application → tracking/interview/review. This is not a feature-expansion proposal.

---

## 1. Executive conclusion

The original sweep was directionally useful but materially overestimated some JobOS outcomes, underestimated several implemented controls, and attributed capabilities to benchmark projects that their source does not contain.

The clearest conclusion is:

> **JobOS is already a first-class trustworthy local control plane, but it is not yet first-class at the two deliverables that leave the system: a submission-ready application document and a supported application-form workflow.**

### Current standing

| Journey capability | Verdict | Why |
|---|---|---|
| Profile and proof foundation | **Foundational** | Local ownership and proof IDs are strong, but resume ingestion is regex-based and proof records have add/list rather than a complete correction/retirement workflow. |
| Job discovery | **Competitive with gaps** | Safe public ATS adapters, provenance, cross-run dedupe, portfolio routing, scoring, and review are strong. Retry behavior, partial-run semantics, filters, and structured field preservation are shallow. |
| Fit scoring and decision support | **Competitive with correctness gaps** | The eight-dimensional model is more useful than an ATS keyword score, but the persisted overall can disagree with its displayed network dimension and the scores are not calibrated against outcomes. |
| People research and warm paths | **First-class orchestration; competitive data quality** | Durable, budgeted, resumable research and human-gated warm-path ranking are excellent. Contact tiering and freshness need tightening. |
| Outreach | **Competitive** | Drafts are source/proof-grounded, short, reviewable, and connected to follow-up state. Deterministic copy and stakeholder-specific asks remain basic. |
| Tailored resume and cover letter | **Foundational outcome; first-class governance** | Revision lineage, hashes, diffs, approval, and proof validation are excellent. The generated “resume” is a requirement-to-proof worksheet, not a complete resume; generated cover-letter prose is intentionally discarded. |
| Readiness, answer safety, packet, and receipt | **First-class** | Restricted-answer handling, exact-revision approval, immutable packets, currency checks, attestation, and receipt confirmation are unusually rigorous. |
| Application form assistance/execution | **Foundational** | Authenticated profiles and hash-pinned Playwright modules exist, but users must author site scripts and there is no packet-bound safe autofill/submit/receipt contract. |
| Application lifecycle and review | **Competitive with gaps** | Status history, tasks, funnel metrics, interview prep, and weekly review form a real loop. Next actions and follow-up cadence are generic; stage velocity and outcome calibration are absent. |
| ACP/MCP agent interfaces | **Strong supporting infrastructure, not a product benchmark win** | ACP recovery and mediation are strong. The MCP server is a narrow handwritten implementation with a hard-coded 2024 protocol version, unlike current SDK-based reference servers. |

### Product implication

Adding more boards, more protocols, or more automation modes would not address the highest-value gaps. The next quality bar is to make the existing flow trustworthy **and complete**:

1. maintain an accurate profile/proof base;
2. preserve enough job data to make a reliable decision;
3. generate a complete, usable document from approved evidence;
4. carry the exact approved packet through a user-configured form workflow;
5. turn application events into specific follow-ups and better future targeting.

---

## 2. Method

### 2.1 What “first-class” means here

A feature is first-class only when it satisfies the whole user outcome, not when a function or command exists.

| Dimension | Test |
|---|---|
| Outcome completeness | Can the job seeker finish the expected task without reconstructing the result elsewhere? |
| Quality and truth | Is the result useful, source/proof-grounded, and explicit about uncertainty? |
| Reliability and recovery | Are partial failures, stale data, retries, resume points, and next actions represented honestly? |
| User control and safety | Can the user review, correct, suppress, approve, and constrain external effects? |
| Maintainability | Does the implementation avoid a brittle site-specific or template-specific maintenance burden? |
| Journey fit | Does it improve the probability or quality of getting a job rather than maximize activity volume? |

Stars and raw feature counts were not used as quality scores. Most benchmark repositories are single-purpose tools; JobOS is an end-to-end operating system. The useful comparison is implementation technique at the relevant stage.

### 2.2 Source method

The benchmark repositories were fetched and read through `opensrc`. Findings below are based on implementation files, schemas, and tests where present—not only README claims.

| Project | `opensrc` snapshot | Useful comparison |
|---|---|---|
| [Sherlock](https://github.com/sherlock-project/sherlock) | `github.com/sherlock-project/sherlock@master` | Broad username-site probing; mostly a negative-scope comparator |
| [theHarvester](https://github.com/laramies/theHarvester) | `github.com/laramies/theHarvester@master` | Multi-provider public email/domain collection |
| [SalesGPT](https://github.com/filip-michalsky/SalesGPT) | `github.com/filip-michalsky/SalesGPT@main` | Staged sales conversation and SMTP sending; not job-seeker networking |
| [RenderCV](https://github.com/rendercv/rendercv) | `github.com/rendercv/rendercv@main` | Validated resume data and Typst/PDF presentation |
| [Awesome-CV](https://github.com/posquit0/Awesome-CV) | `github.com/posquit0/Awesome-CV@master` | Manual LaTeX presentation template |
| [Resume Matcher](https://github.com/srbhr/Resume-Matcher) | `github.com/srbhr/Resume-Matcher@main` | Full-resume parsing, editing, ATS comparison, and PDF export |
| [JobSpy](https://github.com/speedyapply/JobSpy) | `github.com/speedyapply/JobSpy@main` | Multi-board normalization, filters, throttling, and partial results |
| [AIHawk](https://github.com/feder-cr/Auto_Jobs_Applier_AIHawk) | `github.com/feder-cr/Auto_Jobs_Applier_AIHawk@main` | Turnkey browser-application automation and its maintenance/safety costs |
| [browser-use](https://github.com/browser-use/browser-use) | `github.com/browser-use/browser-use@main` | General LLM browser action model; not a job workflow standard |
| [MCP reference servers](https://github.com/modelcontextprotocol/servers) | `github.com/modelcontextprotocol/servers@main` | Current SDK-based MCP implementation patterns |
| [career-ops](https://github.com/santifer/career-ops) | `github.com/santifer/career-ops@main` | Comparable local career pipeline, follow-up cadence, and stage velocity |

These are branch snapshots cached on 2026-07-21/22, not immutable commit pins. Re-run `opensrc fetch` before treating line-level upstream observations as current.

---

## 3. Corrections to the initial sweep

### 3.1 People/contact benchmark claims

The initial document said Sherlock and theHarvester infer corporate email patterns and perform SMTP verification. Their source does not support that claim.

- Sherlock's `sherlock_project/sherlock.py` tests username-derived URLs across site definitions. It does not implement email discovery, corporate pattern inference, MX checks, or SMTP recipient verification.
- theHarvester aggregates email addresses returned by search engines and provider integrations. SMTP strings in its wordlists are hostnames for infrastructure discovery, not recipient verification logic.
- SalesGPT has a staged sales agent and an SMTP send tool in `salesgpt/tools.py`. It is an outbound sales system, not a warm-network path or job-seeker contact-quality benchmark.

JobOS already implements the capabilities listed as missing:

- six inferred address forms in `src/research/contacts.js:patternForNameEmail` / `generateFromPattern`;
- MX, SPF, DMARC, and NS checks in `verifyEmailDomain`;
- opt-in, rate-limited SMTP `RCPT TO` probing in `smtpProbe`;
- exact-public, imported, inferred-pattern, and profile-only evidence tiers;
- approve/suppress gates and `doNotUse`;
- source-backed warm paths and proof-grounded outreach.

The gap is not feature absence. It is **confidence correctness**: `tierForEmailObservation` falls back to tier B even when the observed email domain is not a known company domain, and A/B contacts are then labeled `exact_public`. SMTP acceptance is also only a signal; catch-all mail systems prevent it from proving a person-specific mailbox.

### 3.2 Resume benchmark claims

- Current RenderCV uses Pydantic-validated data, Jinja2-generated **Typst**, and a Typst compiler in `src/rendercv/renderer/pdf_png.py`. It is not a Jinja2 → LaTeX → `pdflatex`/`tectonic` pipeline.
- Awesome-CV is a high-quality LaTeX class/template, not a resume data or tailoring pipeline.
- Resume Matcher exposes ATS score, keyword highlighting, suggestions, full-resume editing, and PDF export. Calling this a “keyword density heatmap” overstates the backend implementation; `apps/backend/app/services/ats.py` returns numeric sub-scores, missing keywords, and recommendations.

The real JobOS gap is not “no LaTeX.” It is that there is no complete structured tailored resume to render. `renderLlmResume` emits a target summary and requirement-to-proof map. `renderLlmCover` explicitly omits the LLM's cover-letter prose. A PDF renderer would only turn those incomplete worksheets into polished incomplete PDFs.

### 3.3 Discovery and automation repository names

The current repositories are `speedyapply/JobSpy` and `feder-cr/Auto_Jobs_Applier_AIHawk`; the initial URLs were stale.

JobSpy's broad aggregator support is real, but its rotating proxies, randomized TLS behavior, and board-specific scraping are not an appropriate default architecture for a privacy-first job seeker. The transferable practices are its richer normalized model, recency/type/remote filters, throttling, retry handling, and partial-result behavior.

AIHawk and browser-use prove that generic or site-specific form automation is possible. They do not establish that unattended application volume is a first-class outcome. Neither benchmark matches JobOS's answer sensitivity, exact artifact review, immutable packet, idempotency, or receipt evidence.

### 3.4 Application packets are already implemented

The initial checkup omitted JobOS's immutable application packet and receipt lifecycle. `src/packets.js` implements canonical hashing, packet attempt/revision lineage, currency checks, exact-material and answer fingerprints, human attestation, idempotency, and receipt confirmation.

`README.md:530` still says immutable packet/receipt graphs are deferred, contradicting the implemented commands and the earlier README packet section. That documentation line should be corrected separately; it should not influence the benchmark verdict.

### 3.5 MCP is useful but not “above standard”

`src/mcp.js` provides the narrow methods JobOS needs and has end-to-end framing tests. It also manually implements JSON-RPC framing and hard-codes protocol version `2024-11-05`.

The current MCP filesystem reference server uses `@modelcontextprotocol/sdk` `^1.29.0`, `McpServer`, `StdioServerTransport`, typed schemas, and SDK-managed negotiation. JobOS's domain policy is strong; its protocol implementation should be described as **working and deliberately narrow**, not categorically above the current open-source standard.

---

## 4. Deep capability analysis along the job-seeker journey

### 4.1 Profile and proof foundation

### JobOS implementation

- `src/profiles.js:structuredProofs` splits resume lines, requires an action-verb match, takes at most 24 lines, extracts simple metric patterns, and creates proof IDs.
- `suggestProfileAffiliations` uses regex heuristics for education, employer, and community affiliations.
- The raw imported resume remains local, and profile/proof mirrors are agent-readable.
- The public workflow provides `proof add` and proof listing. There is no equivalent first-class edit, retire, merge, or “needs verification” lifecycle for an incorrectly parsed proof.

### Benchmark lessons

- RenderCV's `src/rendercv/schema/models/cv/cv.py` treats identity, sections, entries, dates, links, and ordering as validated structured data.
- Resume Matcher parses PDF/DOCX into a complete editable master resume before tailoring.

### Assessment

**Verdict: Foundational.**

JobOS has a stronger truth model than the benchmarks but a weaker source record. Proof IDs cannot compensate for a profile that omitted education, credentials, role history, or a valid accomplishment because it did not match the import regex. This weakness propagates into scoring, tailoring, answers, outreach, and interview prep.

**First-class bar:** the user can inspect every imported section, correct extraction, update/retire proof points without destroying lineage, and distinguish imported text from human-verified evidence.

---

### 4.2 Discovery and normalized job intake

### JobOS implementation

- `src/discovery/adapters.js` has Greenhouse, Lever, Ashby, generic career-page, and bounded portfolio routing.
- The shared HTTP path enforces public addresses, manual redirects, timeouts, request budgets, identifiable user agent, and bounded portfolio traversal.
- `src/jobs.js:importNormalized` uses exact URL first, a conservative company/title/location key second, source history, repost detection, and possible-duplicate review tasks.
- Every result flows into persistence, scoring, a review queue, workspace mirrors, and automation-run audit history.

### What is genuinely first-class

- Public-ATS-first scope has much lower account and maintenance risk than JobSpy's scraper arms race.
- Cross-run provenance and duplicate handling are materially deeper than JobSpy's per-session `seen_ids`.
- Portfolio → company → ATS routing is useful for focused startup searches and is more aligned with a targeted job seeker than maximizing aggregator volume.

### Depth gaps

1. `requestOnce` has a fixed delay but no `429`/`503` retry or `Retry-After` handling.
2. Portfolio child errors are placed in `metadata.errors`, but `runSavedSearch` can retain `status: succeeded`; the run does not have an honest `partial` state.
3. A per-job import/score exception exits the surrounding loop and prevents later fetched jobs from being processed.
4. ATS-native employment type, remote/work model, department, and compensation data are mostly flattened into text or discarded even though JobOS has related database fields.
5. Filters are keyword-any-match and location substring. Recency, employment type, and remote-only are missing.

### Benchmark lessons

JobSpy's `jobspy/model.py` has richer normalized fields and search inputs. Its HTTP layer includes retry/backoff behavior, while some board adapters return partial results on rate limits. Do **not** copy rotating proxies, TLS evasion, CAPTCHA workarounds, or board-specific scraping by default.

### Assessment

**Verdict: Competitive with gaps.**

Adding LinkedIn, Indeed, and Glassdoor is not the first priority. Reliable retries, honest partial results, and preservation of structured data from the five existing sources would improve user outcomes more with much less maintenance.

---

### 4.3 Fit scoring and the pursue decision

### JobOS implementation

- `src/scoring.js` models role, domain, seniority, location/work model, compensation, mission, network access, and red flags.
- It has a deterministic degraded mode, provider-backed structured mode, malformed-output fallback, confidence, explanations, persistence, and an eval that separates known good/poor fixtures.
- Network access is derived from completed people-research evidence rather than model speculation.

### Benchmark lessons

Resume Matcher's ATS service is narrower: weighted keyword match, skills coverage, and section completeness. It is useful for tailoring, not a substitute for JobOS's go/no-go decision. RenderCV and Awesome-CV do no fit scoring.

### Correctness gaps

1. `deterministicScore` computes `overall` before live network evidence is loaded. `score` later replaces `out.dimensions.networkAccess` but does not recompute `out.overall`. The displayed dimensions can therefore disagree with the persisted overall.
2. Deterministic overlap is set intersection with hard-coded neutral bases. Missing compensation or preferences can look like middling fit rather than explicit uncertainty.
3. LLM validation checks shape and numeric ranges, but not evidence references for dimension reasons.
4. There is no calibration report comparing score bands to later recruiter screens/interviews. A precise-looking 0–100 number can drift without detection.

### Assessment

**Verdict: Competitive with correctness gaps.**

The model is broader than Resume Matcher, but “more dimensions” is not itself first-class. Mathematical consistency, uncertainty, and outcome calibration matter more than adding another dimension or a visual score.

**First-class bar:** the overall is a reproducible function of the displayed dimensions, unknowns are explicit, and the weekly loop shows whether high scores actually convert better than low scores.

---

### 4.4 Company, people, contact, and warm-path research

### JobOS implementation

- `src/research/graph.js` runs a bounded graph from validation through source collection, people resolution, contact verification, path ranking, and persistence.
- `src/research/runs.js` records budgets, checkpoints, usage, warnings, partial/retryable states, deadlines, cancellation, and resume.
- `src/research/people.js:resolvePerson` uses canonical profile URL, then exact email, and never merges by name alone.
- `src/research/contacts.js` extracts exact public emails, infers patterns from observed name/email pairs, generates hypotheses, performs domain checks, optionally probes SMTP, and requires approval before email-channel drafting.
- `src/research/network.js` incorporates user-owned LinkedIn exports and generic relationship edges into warm-path ranking.

### Benchmark lessons

- Sherlock's 400+ username sites are irrelevant to most job-seeker paths and create false-positive/privacy burden.
- theHarvester demonstrates adapter breadth, not contact suitability, consent, or warm-path quality.
- SalesGPT's staged sales flow and SMTP sender optimize outbound selling, not a respectful networking ask.

### Depth gaps

1. Company-domain matching and exact-public provenance are conflated in contact tiering. An exact address on an unrelated public source should not automatically imply company relevance.
2. Source freshness does not reduce contact tier/confidence.
3. SMTP `RCPT TO` acceptance is presented as confidence but cannot distinguish catch-all domains from a real mailbox without explicit catch-all detection.
4. Warm-path numeric strengths are deterministic bands, not observed reply probabilities. The current wording correctly avoids a reply-probability claim; that distinction must remain.

### Assessment

**Verdict: First-class orchestration and governance; competitive contact quality.**

The initial recommendation to “add email pattern discovery and SMTP validation” should be deleted. The work is to make existing confidence labels stricter and easier to inspect.

---

### 4.5 Outreach drafting and follow-up

### JobOS implementation

- `src/outreach.js` builds an allowlist of stakeholder, company, job, contact, and proof evidence.
- LLM evidence references are normalized against that allowlist; unsupported references are dropped.
- Drafts are capped at 150 words, use profile communication style, remain exact-revision artifacts, and cannot use a suppressed or unapproved email contact.
- `markOutreachSent`, `scheduleFollowup`, and `outreachDue` record user actions and next steps without claiming delivery.

### Depth gaps

- The deterministic fallback uses nearly the same ask for recruiter, hiring manager, peer, and executive.
- “Sent” and “due” are tracked, but reply/no-reply/meeting outcome is not fed into path or outreach quality.
- Company/stakeholder evidence can be present in the artifact without a claim-level check that every sentence in free-form LLM prose is entailed by that evidence.

### Assessment

**Verdict: Competitive.**

JobOS is more appropriate for job-seeker networking than SalesGPT. A role-aware ask and simple outcome feedback would deepen the feature; bulk sequences, SMTP auto-send, and lead-scoring funnels would bloat it.

---

### 4.6 Tailored resume, cover letter, artifact review, and export

### JobOS implementation

The governance layer is excellent:

- valid proof IDs are required for generated accomplishment mappings;
- malformed or unsupported model references are dropped;
- missing proof produces explicit warnings rather than fabricated claims;
- artifacts have a stable series, monotonic revision, predecessor, SHA-256 content hash, diff, workspace-integrity check, approval/rejection, and editor round-trip;
- ACP/MCP cannot spoof human review.

The generated outcome is not yet a first-class application document:

- `renderLlmResume` outputs a heading, generic summary, and requirement-to-proof map. It omits the source resume's contact information, work history structure, education, dates, credentials, and skills sections.
- `groundedBullet` uses the stored proof summary rather than the model's tailored `bullet`, so the output is selected evidence more than tailored phrasing.
- `renderLlmCover` explicitly records that generated cover-letter prose was omitted and renders a generic introduction plus proof list.
- `compileApplicationReadiness` considers a resume grounded when its artifact evidence contains at least one current proof ID. It does not validate that the document is complete or exportable.

### Benchmark lessons

- Resume Matcher owns a complete master-resume → editable tailored resume → template → PDF path and provides keyword highlighting/suggestions. Its truth controls are weaker than JobOS's.
- RenderCV owns a validated structured resume → theme → Typst → ATS-compatible PDF path. It does no tailoring.
- Awesome-CV is useful only if a user wants to maintain LaTeX manually.

### Assessment

**Verdict: Foundational outcome; first-class governance.**

This is JobOS's largest user-visible gap. A user cannot submit the current resume artifact as a normal resume without rebuilding it elsewhere. Adding `--format latex` before fixing the document model would optimize the wrong layer.

**First-class bar:** one approved artifact represents a complete resume, preserves untailored factual sections, makes every changed accomplishment traceable to proofs, records requirement coverage, and can be handed to one optional renderer without manual reconstruction.

---

### 4.7 Application readiness, answer safety, packet, browser, and receipt

### JobOS implementation

JobOS is unusually strong before and after the external form:

- `src/answers.js` scopes reusable answers, fingerprints questions, tracks verification/reuse/sensitivity, redacts secrets, and blocks automatic handling of work authorization, demographic, and legal attestations.
- `src/readiness.js` gives typed blockers and next actions.
- `src/packets.js` freezes exact current materials, answer row fingerprints, target identity, proof IDs, score, and warnings; packet creation is idempotent and stale inputs invalidate attestation.
- submission attestation and receipt confirmation are distinct, immutable events.
- `src/browser.js` has private persistent profiles, cookie redaction, typed auth/CAPTCHA/blocked/timeout errors, SHA-pinned modules, and two explicit side-effect gates.

### Outcome gap

There is no supported bridge across the form itself:

- the user must write or obtain a local ESM Playwright module;
- registered scripts are trusted unsandboxed code;
- the runner accepts generic input and returns a normalized outcome, but the contract does not require an exact packet ID/hash;
- safe reusable answers, restricted-answer exclusions, final-submit confirmation, and returned receipt evidence are not one adapter contract;
- no supported portal flow is tested end to end.

### Benchmark lessons

AIHawk's LinkedIn/Selenium implementation and browser-use's LLM-driven actions demonstrate breadth, but also the brittleness and account risk JobOS should avoid. AIHawk's browser flags include `--disable-web-security`; browser-use includes CAPTCHA-solving examples. Neither is a model for JobOS safety or evidence.

### Assessment

- **Readiness, answer governance, packet, and receipt: First-class.**
- **Form assistance/execution: Foundational.**

This is a real gap, not a reason to hard-code external action off. JobOS's product policy allows explicitly configured external actions. The right refinement is a narrow packet-bound adapter contract with human checkpoints, not universal unattended auto-apply.

---

### 4.8 Application tracking, follow-up, interview, analytics, and weekly review

### JobOS implementation

- `src/tracking.js` stores ten statuses and an append-only `status_changes` ledger.
- State changes are audited and synchronized to the workspace.
- `src/analytics.js` reports source/role/stage counts, response/interview/offer conversion, stale applications, and a weekly review.
- `src/interview.js` creates stage-specific, proof-grounded questions, STAR stories, questions to ask, and research refresh warnings.
- The TUI binds pipeline, selected-job context, review, documents, answers, discovery, network, tasks, logs, and agent state.

### Benchmark lessons

career-ops is the useful comparator here:

- `followup-cadence.mjs` computes waiting/overdue/urgent states and next dates;
- `followup-seed.mjs` seeds an idempotent follow-up when an application reaches Applied;
- `funnel-velocity.mjs` folds status events into stage timelines and computes median/p75 dwell time with sample-size cautions;
- its interview-session format distinguishes practice/debrief and preserves competency tags.

JobOS already has the ledger career-ops needs. It does not need a second tracking system.

### Depth gaps

1. The application next-action task uses one deterministic ID and `INSERT OR IGNORE`; later stage changes do not refresh its title, due date, or stage-specific action.
2. Application-level follow-up cadence is not seeded from an attested application. Outreach follow-up covers networking threads, not employer response follow-up.
3. Weekly `tasks = due(s)` is not profile-scoped, so a profile review can include another profile's tasks.
4. The status ledger is not used to calculate time-to-response or stage dwell.
5. Funnel insights do not test score-band calibration or distinguish small-sample noise.
6. Interview prep creates a packet but no lightweight post-interview debrief/outcome link back to proof gaps.

### Assessment

**Verdict: Competitive with gaps.**

The missing work is not another Kanban or web dashboard. It is to make each state transition produce the right dated next action and make the existing ledger improve later decisions.

---

### 4.9 Agent interfaces and protocol quality

### JobOS implementation

- ACP has environment allowlisting, permission denial, transcript redaction, cancellation quarantine, timeout/crash restart, and clean-session recovery.
- Domain tools share one implementation across CLI/TUI/ACP/MCP and enforce mediation policy.
- MCP exposes the relevant schemas and reads/writes through the same store.

### Assessment

**Verdict: Strong supporting infrastructure.**

ACP resilience and shared domain semantics are first-class engineering. MCP protocol maintenance is not. More importantly, neither helps a job seeker if the resume artifact is incomplete or the next action is vague. Protocol work should remain below the user-outcome priorities in this report.

---

## 5. Focused improvement plan

These items deepen existing features. They do not add a new product surface.

### P0 — Close correctness and outcome gaps

| Item | Focused change | Acceptance bar |
|---|---|---|
| Complete the profile/proof source record | Parse and retain a canonical resume structure; let users correct, merge, and retire proofs while preserving provenance and history. | A user can review every imported section and correct a false/missing proof without recreating the profile. |
| Produce a complete tailored document | Preserve identity, experience, education, dates, credentials, and factual sections; tailor only supported summaries/bullets; retain proof mapping outside or alongside the human document. | The approved resume reads as a normal complete resume, not a requirement worksheet. The cover letter contains usable prose whose claims are grounded. |
| Make readiness test usability, not one citation | Add document completeness/version checks before `ready-for-review`; keep exact-revision approval. | A one-proof worksheet cannot reach approved application readiness. |
| Fix score consistency and uncertainty | Recompute overall after network evidence, make unknown dimensions explicit, and add score-band outcome calibration to the weekly loop. | Persisted overall always matches displayed dimensions; weekly review shows conversion by score band only when sample size supports it. |
| Tighten contact confidence | Separate “publicly observed,” “company-domain match,” “pattern hypothesis,” DNS health, catch-all/inconclusive SMTP, and freshness. | An unrelated-domain observation cannot become a company tier A/B contact; stale or catch-all evidence is visibly downgraded. |
| Make existing discovery runs reliable | Add bounded `429`/`503` + `Retry-After` handling, per-job isolation, and an honest `partial` status; preserve ATS-native compensation/work model/employment type when available. | One transient response or one scoring failure does not discard later jobs, and a run with child errors is never labeled fully succeeded. |
| Scope lifecycle tasks correctly | Profile-scope weekly tasks and replace/update the generic next-action task on each status event. | A profile review cannot expose another profile's tasks; each active application has one current, stage-specific, dated next action. |

### P1 — Complete handoffs between existing stages

| Item | Focused change | Acceptance bar |
|---|---|---|
| Structured document/export handoff | Define one canonical resume JSON/YAML representation and one optional renderer adapter, preferably RenderCV/Typst or a single HTML-to-PDF path—not both initially. | Approved structured content renders without retyping and round-trips to the same proof-linked source. |
| Grounded ATS/requirement coverage | Show matched, missing-but-supported, and unsupported JD terms during tailoring. Never recommend a keyword absent from the canonical profile/proofs. | Every suggested insertion cites a proof; unsupported requirements become honest gaps, not generated claims. |
| Packet-bound form adapter contract | Require packet ID/hash, safe answer IDs, explicit restricted-field pauses, a pre-submit checkpoint, and structured outcome/receipt data from trusted scripts. | A configured adapter cannot silently use stale materials or auto-fill restricted answers; successful submission evidence binds to the exact packet. |
| Application follow-up and velocity | Seed a due follow-up from attestation, use `status_changes` for time-to-response/stage dwell, and preserve manual overrides. | Applied roles appear as waiting/overdue with specific next dates; velocity reports use observed events and minimum-sample warnings. |
| Role-aware outreach and outcomes | Vary asks by recruiter/hiring-manager/peer/executive and record reply/meeting/no-response outcomes. | The fallback copy changes appropriately by relationship and the weekly loop can compare warm-path outcomes without claiming causation. |
| Interview debrief loop | Add a lightweight debrief tied to the application, stage, questions, proof gaps, and next action. | Interview outcomes can update proof gaps and follow-up without creating a separate coaching product. |

### P2 — Useful polish after P0/P1

- Add recency, remote/work-model, and employment-type saved-search filters using already normalized fields.
- Add deterministic benchmark fixtures for score stability, document completeness, grounded keyword suggestions, contact tiering, and packet-bound browser outcomes.
- Move the MCP server to the maintained SDK when protocol compatibility creates real maintenance pain; do not make this a product milestone ahead of user outcomes.

---

## 6. Explicit non-goals

Do not use this benchmark exercise to build:

- a 400-site username OSINT sweep;
- proxy rotation, TLS fingerprint evasion, or a LinkedIn/Indeed scraper arms race;
- CAPTCHA solving or universal unattended auto-apply;
- SMTP auto-send, sales cadences, or lead-qualification stages;
- a template marketplace or a bespoke LaTeX engine;
- a keyword heatmap before a concise proof-backed coverage report;
- another web dashboard when the missing work is stage logic and document completeness;
- more agent protocols before the existing job-seeker outcomes are complete.

---

## 7. Recommended sequence through the natural user flow

1. **Profile/proofs:** make the source record correctable and complete.
2. **Discovery:** harden retries/partial results and preserve the fields the user filters on.
3. **Decision:** fix score consistency and connect score bands to observed outcomes.
4. **Research/network:** tighten contact confidence and freshness labels.
5. **Tailoring:** create a complete structured document, then add one renderer handoff.
6. **Application:** bind configured form assistance to the exact approved packet and safety policy.
7. **Tracking:** make every event produce a dated next action and feed velocity/debrief evidence into the weekly review.

That sequence raises the quality of every existing stage without turning JobOS into a scraper farm, sales platform, browser-agent framework, or document-template suite.
