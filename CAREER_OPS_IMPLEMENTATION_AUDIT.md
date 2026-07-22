# JobOS vs. Career Ops Implementation Audit

**Date:** 2026-07-22  
**JobOS scope:** Current worktree  
**Career Ops scope:** Version 1.22.0, fetched with `opensrc` from `github.com/santifer/career-ops@main`  
**Purpose:** Evaluate whether JobOS' existing capabilities meet a similar implementation standard to Career Ops without using feature-count expansion as the goal.

## Executive verdict

**JobOS is not yet at Career Ops' overall end-user standard.**

JobOS is stronger in foundational system properties:

- canonical local state and transactional persistence;
- artifact lineage and exact-revision approval;
- immutable application packets and submission receipts;
- sensitive-answer classification and redaction;
- executable company and people research;
- agent mediation and side-effect controls.

Career Ops is stronger in the parts users experience as the finished job-application product:

- complete tailored resumes and rendered PDFs;
- inspection and filling of real employer application forms;
- posting liveness and legitimacy checks;
- broader ATS/provider coverage;
- reusable interview-story workflows;
- guided onboarding and web presentation;
- evaluation and release-quality infrastructure.

The central finding is:

> JobOS has an excellent control plane around several semantically shallow deliverables. It can prove exactly which draft was approved, frozen, and submitted, but the approved draft may still be a proof-point outline rather than a complete resume.

Career Ops has nearly the inverse profile: stronger final-mile job-search output and browser workflows, but weaker structured persistence, provenance, and enforceable policy boundaries. Many Career Ops features are detailed agent instructions rather than durable domain implementations.

## Method

The comparison used implementation evidence rather than README claims alone:

- JobOS source, CLI behavior, tests, smoke scenario, generated artifacts, scoring output, persistence, TUI, MCP, ACP, research, readiness, and browser code were inspected.
- Career Ops source was fetched through `opensrc` and inspected across its command scripts, modes, providers, web application, form automation, document pipeline, liveness logic, tests, and golden evaluation harness.
- Prompt-only Career Ops behavior was distinguished from executable code.
- Representative runtime and test commands were executed in both repositories.

## Capability scorecard

Scores represent subjective implementation maturity from 1 to 5, not feature quantity.

| Capability | JobOS | Career Ops | Leader |
|---|---:|---:|---|
| Discovery and source coverage | 3.0 | 4.5 | Career Ops |
| Posting liveness and legitimacy | 1.5 | 4.5 | Career Ops |
| Fit evaluation | 3.0 | 4.0 | Career Ops, with caveats |
| Resume and cover-letter output | 1.5 | 4.5 | Career Ops |
| Application-form preparation | 2.0 | 4.5 | Career Ops |
| Application tracking and provenance | 5.0 | 3.0 | JobOS |
| Sensitive-answer handling | 4.5 | 2.5 | JobOS |
| Company, people, and network research | 4.5 | 2.5 | JobOS |
| Outreach safety and evidence | 4.5 | 3.0 | JobOS |
| Interview preparation | 2.5 | 4.0 | Career Ops |
| Agent and tool integration | 4.5 | 4.0 | JobOS |
| Onboarding and product UX | 3.0 | 4.5 | Career Ops |
| Test and release maturity | 3.5 | 4.5 | Career Ops |

## Critical findings

### 1. The tailored resume and cover letter are not application-ready documents

**Severity: Critical**

JobOS' deterministic tailored resume is an evidence outline. It contains:

- a target-role summary;
- a short collection of stored proof points;
- extracted job requirements;
- warnings;
- a human-review checklist.

It does not contain the complete document structure expected from a usable resume:

- contact header;
- employment chronology;
- education;
- skills section;
- complete professional summary;
- coherent role-by-role tailoring;
- production-ready rendering.

The deterministic cover letter similarly emits generic framing followed by a literal list of stored evidence. The implementation intentionally avoids unsupported claims, which is correct, but the result is evidence staging rather than a finished application artifact.

Relevant JobOS implementation:

- `src/tailoring.js:66-74` renders the resume from proof summaries.
- `src/tailoring.js:76-83` replaces full cover-letter prose with neutral boilerplate and proof bullets.
- `src/tailoring.js:108-120` persists these outputs as resume or cover-letter artifacts.

A reproduced sample generated a 27-line resume whose substantive candidate content consisted of three proof bullets. Exporting that Markdown to PDF would not solve the problem because the gap is semantic, not cosmetic.

Career Ops implements a deeper document pipeline:

- complete structured CV generation;
- ATS-oriented HTML templates;
- A4 and Letter selection;
- section-order validation;
- Chromium PDF rendering;
- rendered page-count checks;
- optional strict page limits;
- unsupported-metric detection;
- output indexing back to the evaluation report.

Career Ops evidence:

- [`modes/pdf.md`](https://github.com/santifer/career-ops/blob/main/modes/pdf.md)
- [`generate-pdf.mjs`](https://github.com/santifer/career-ops/blob/main/generate-pdf.mjs)
- [`verify-cv-facts.mjs`](https://github.com/santifer/career-ops/blob/main/verify-cv-facts.mjs)

#### Recommendation

Keep JobOS' proof-ID grounding and exact-revision workflow, but replace the current artifact contract with a complete semantic document model:

1. Preserve immutable base-profile facts and employment chronology.
2. Map every important requirement to a proof point or explicit gap.
3. Permit grounded rewriting of bullets without inventing facts.
4. Validate document structure before review.
5. Detect unsupported metrics, credentials, employers, and dates.
6. Render and verify the final document, including page-budget checks.

Do not add more artifact types until the resume and cover-letter contracts are complete.

### 2. Application readiness is based on synthetic questions, not the employer's form

**Severity: Critical**

JobOS does not inspect the employer's actual application form before determining readiness. `src/answers.js:156-168` synthesizes likely questions from the job description, including:

- interest in the employer and role;
- relevant experience;
- work authorization;
- sponsorship;
- one generated question for each extracted requirement.

These synthetic questions feed answer matching and readiness in:

- `src/answers.js:171-235`;
- `src/readiness.js:134-180`.

This creates two correctness failures:

1. JobOS can block readiness for a question the employer never asks.
2. JobOS can report readiness while required fields on the real application remain unknown.

The application packet then hashes and freezes this synthetic answer model. The integrity mechanism is strong, but it can be cryptographically correct about an incomplete abstraction.

Career Ops inspects the live form. Its executable workflow:

- distinguishes application forms from job-search filters;
- searches the main document and embedded frames;
- selects the richest form;
- enriches fields from ATS schemas where available;
- attaches the selected CV to resume fields;
- fills text, select, radio, checkbox, and combobox controls;
- refuses to auto-accept legal consent;
- reads the form back and reports fill divergence;
- leaves final submission to the human.

Career Ops evidence:

- [`web/src/lib/apply/session.ts`](https://github.com/santifer/career-ops/blob/main/web/src/lib/apply/session.ts)
- [`web/src/lib/apply/extract.ts`](https://github.com/santifer/career-ops/blob/main/web/src/lib/apply/extract.ts)

#### Recommendation

Connect JobOS' existing browser, answer, readiness, artifact, packet, and receipt systems:

```text
live form snapshot
  -> stable field map and form fingerprint
  -> sensitive and restricted classification
  -> exact answer matching
  -> unresolved-field blockers
  -> fill and read-back verification
  -> packet freezes the form fingerprint and answer versions
  -> human submits
```

Until a live form has been inspected, the current status should mean `materials-ready` or `preflight-ready`, not complete application readiness.

## High-priority findings

### 3. Fit scoring is structured but internally inconsistent and uncalibrated

**Severity: High**

JobOS has a useful executable scoring model:

- eight named dimensions;
- human-readable reasons;
- deterministic fallback;
- malformed-output fallback;
- proof-aware scoring;
- evidence-derived network-access scoring.

Relevant implementation:

- `src/scoring.js:16-57`;
- `src/scoring.js:66-88`.

The main problems are consistency and calibration:

- `normalizeScore()` accepts the LLM-provided overall score independently from the dimensions.
- `score()` later overwrites `dimensions.networkAccess` from stored research evidence without recomputing the overall score.
- The deterministic overall formula does not directly include the returned `networkAccess` or `redFlags.score` dimensions.
- Proof evidence contributes through multiple adjustments, which can overstate confidence.
- Existing tests assert broad ranges but do not defend ranking order, calibration, dealbreaker precedence, or dimension-to-overall consistency.

In the reproduced sample, JobOS returned 81/100 even though several major dimensions scored between 45 and 55. The score follows the current formula but appears more confident than the visible dimension table.

Career Ops uses richer evaluation guidance, including:

- archetype classification;
- compensation-reliability context;
- culture requirements;
- geographic contradictions;
- posting legitimacy;
- consistent report blocks.

Relevant Career Ops evidence:

- [`modes/_shared.md`](https://github.com/santifer/career-ops/blob/main/modes/_shared.md)
- [`modes/oferta.md`](https://github.com/santifer/career-ops/blob/main/modes/oferta.md)
- [`eval-golden.mjs`](https://github.com/santifer/career-ops/blob/main/eval-golden.mjs)

Career Ops' golden evaluation is itself limited: only archetype agreement gates the run, while score tolerance is secondary. Its replay passed at 90% archetype agreement despite three of ten row-level combined checks failing.

#### Recommendation

1. Define one canonical relationship between dimensions and overall.
2. Recompute overall after evidence-derived overrides.
3. Give dealbreakers and unknown data explicit precedence.
4. Separate candidate fit from posting legitimacy.
5. Add labeled golden cases for ordering, calibration, transferability, and contradictions.

### 4. Discovery lacks Career Ops' provider depth and liveness checks

**Severity: High**

JobOS has executable adapters for:

- Greenhouse;
- Lever;
- Ashby;
- generic career pages;
- portfolio routing.

`src/discovery/adapters.js` contains meaningful safeguards:

- redirect and request budgets;
- URL credential rejection;
- DNS resolution;
- private, loopback, and link-local address blocking;
- structured partial failure;
- deduplication and repost recording.

These URL and DNS protections are stronger than Career Ops' generic HTTP helper.

Career Ops nevertheless has much broader source coverage through dynamically loaded provider modules and a deeper liveness ladder. It handles:

- HTTP closure signals;
- explicit expired or filled language;
- redirects away from the posting;
- generic listing pages;
- visible application controls;
- multilingual apply controls;
- anti-bot pages as `uncertain` rather than expired.

Career Ops evidence:

- [`providers/_registry.mjs`](https://github.com/santifer/career-ops/blob/main/providers/_registry.mjs)
- [`scan.mjs`](https://github.com/santifer/career-ops/blob/main/scan.mjs)
- [`liveness-core.mjs`](https://github.com/santifer/career-ops/blob/main/liveness-core.mjs)

JobOS records repost and `last_seen_at` data, but there is no equivalent pre-score or pre-pursuit liveness gate. It can spend evaluation, research, and tailoring work on a role that has already closed.

#### Recommendation

Do not copy all Career Ops providers immediately. First:

1. add a liveness gate before scoring and pursuing;
2. distinguish `active`, `expired`, and `uncertain`;
3. preserve JobOS' stricter URL and DNS controls;
4. add providers only from observed user demand.

### 5. Interview preparation produces prompts rather than reusable stories

**Severity: High**

JobOS requests structured STAR fields from the LLM but reduces them to safe writing instructions rather than rendering completed stories. See `src/interview.js:90-109`.

This protects against fabrication but leaves the user to write the substantive story. There is also no persistent cross-application story bank.

Career Ops provides:

- recruiter, hiring-manager, peer-technical, and mixed-panel packs;
- sourced-versus-inferred question labeling;
- a persistent story bank;
- gap mapping between questions and prepared stories;
- an executable zero-LLM story matcher.

Career Ops evidence:

- [`modes/interview-prep.md`](https://github.com/santifer/career-ops/blob/main/modes/interview-prep.md)
- [`match-star.mjs`](https://github.com/santifer/career-ops/blob/main/match-star.mjs)

Career Ops' story creation remains prompt-driven, so its implementation should not be copied literally.

#### Recommendation

Create verified, profile-scoped STAR+Reflection records tied to JobOS proof points. Match them across roles, questions, risks, and interview audiences without regenerating the same story for every application.

### 6. JobOS has browser primitives, not a cohesive application workflow

**Severity: High**

JobOS' browser infrastructure is strong:

- private persistent profiles;
- protected cookie import and export;
- script-name and path validation;
- script content hashes;
- explicit side-effecting registration;
- `--allow-side-effects`;
- typed recovery for CAPTCHA, authentication, and browser failures.

The missing piece is product integration. Site-specific behavior is delegated to trusted user-authored modules, and there is no built-in path connecting:

```text
form extraction
-> answer plan
-> fill
-> read-back verification
-> packet creation
-> human handoff
-> submission receipt
```

#### Recommendation

Deepen this existing vertical slice rather than adding more browser commands. The necessary domain components already exist; they need a common workflow and form-backed contract.

## Areas where JobOS is stronger

### Tracking, artifact lineage, and application receipts

JobOS is decisively stronger in data integrity and provenance:

- SQLite canonical state;
- foreign-keyed records;
- status-change history;
- monotonically increasing artifact revisions;
- SHA-256 content hashes;
- exact-current-revision approval;
- mirror-divergence protection;
- immutable application packets;
- packet currency and staleness;
- human submission attestations;
- receipt confirmation;
- profile isolation;
- audit records.

Relevant files:

- `src/db.js`;
- `src/artifacts.js`;
- `src/readiness.js`;
- `src/packets.js`;
- `src/tracking.js`.

Persistence uses explicit locking, optimistic store revision, temporary-file fsync, atomic rename, and guarded transactional writes. Career Ops' Markdown tracker is accessible and git-diffable but cannot enforce the same relational invariants.

### Sensitive and restricted answer handling

JobOS has a real answer-safety model:

- sensitivity;
- verification status;
- reuse scope;
- employer scope;
- `never_auto_fill`;
- restricted work-authorization, demographic, and legal categories;
- redacted list and workspace output;
- exact job-bound direct responses.

Relevant implementation: `src/answers.js`.

Career Ops refuses automatic legal consent and requests confirmation for sensitive fields, but its snapshots can contain free-text and selected values in Markdown. JobOS should preserve its stronger redaction boundary when live-form support is added.

### Executable people research and networking

JobOS' research implementation is materially stronger. Its LangGraph pipeline provides durable stages:

```text
validate
-> hydrate_context
-> plan_queries
-> collect_sources
-> resolve_people
-> verify_contacts
-> rank_paths
-> persist_outputs
```

It includes durable runs and checkpoints, cancellation, time and source budgets, paid-call controls, adapter failure isolation, source observations, identity resolution, contact evidence tiers, approval and suppression, affiliations, relationship edges, and network-path ranking.

Relevant implementation: `src/research/graph.js` and related `src/research/` modules.

Career Ops' company, contact, and deep-research features are mostly agent prompt files. They may produce useful output with a capable model, but their sourcing and persistence contracts are less enforceable.

### Agent mediation and extension safety

JobOS provides stronger executable policy boundaries:

- structured MCP domain tools;
- mediation-source enforcement;
- guest-agent approval and packet-mutation denial;
- ACP environment allowlisting;
- secret redaction;
- typed agent manifests;
- secret-looking argument rejection;
- executable availability checks;
- browser script hash pinning;
- default-off external side effects.

Career Ops supports a broader range of AI coding clients and has a polished action registry, but JobOS' domain-aware policy mediation is stronger.

## Medium-priority gaps

### Outcome analytics do not yet create a deep feedback loop

`src/analytics.js` produces useful funnel counts, conversions, source and role-family breakdowns, stale applications, and recommendations. Career Ops additionally implements rejection-pattern analysis, recurring skill-gap aggregation, funnel velocity, salary-gap observations, reply matching, and follow-up compliance.

JobOS should not add every report. It should connect existing outcomes back to source quality, role targeting, proof gaps, score calibration, and interview-story gaps.

### Onboarding remains operator-oriented

The JobOS TUI has honest empty states and useful controls, but setup still expects command knowledge, profile IDs, structured preferences, and source configuration. Career Ops detects missing canonical files and offers guided conversational completion in its web application.

The next standard is not a larger command registry. It is guided completion of the existing profile, source, proof, and browser setup.

### Release and security hygiene trail Career Ops

JobOS' CI currently runs installation, tests, and smoke verification. Career Ops also contains broader security and release controls, including CodeQL, dependency review, data-leak checks, SBOM work, and release automation.

These are secondary to the application workflow but still part of comparable production maturity.

### Documentation has drifted

`README.md:530` states that immutable packet and receipt graphs are deferred even though the implementation and other README sections document them as available. This should be corrected during cleanup after the next behavioral milestone.

## Career Ops weaknesses that should not be copied

Career Ops is not uniformly better:

1. Many flagship capabilities are detailed prompt instructions rather than enforceable domain implementations.
2. Its Markdown canonical store needs substantial parser, merge, deduplication, and repair machinery.
3. Its golden evaluation gates only archetype agreement, not score quality.
4. Direct tailoring scripts can bypass the higher-level fact-check workflow.
5. Application-answer snapshots can contain sensitive plaintext.
6. The observed web test command covered only 19 cases for one utility, although TypeScript checking passed.
7. Its broad core test runner depends on repository metadata; the opensrc snapshot could not satisfy several git-index checks.

JobOS should adopt Career Ops' semantic depth without weakening its own persistence and safety architecture.

## What not to build yet

Do not chase Career Ops' long-tail feature count while the shared core remains incomplete. Defer unless explicit product demand appears:

- offer-contract review;
- negotiation scripts;
- course and certification evaluation;
- portfolio-project evaluation;
- broad localization;
- plugin marketplace work;
- mass parallel evaluation;
- dozens of niche board providers;
- voice rehearsal.

These would increase surface area while resume and readiness semantics remain weak.

## Recommended implementation sequence

### P0: Make existing application outputs true

1. Replace outline-style tailoring with a complete proof-grounded document model.
2. Add semantic document validation before an artifact is reviewable.
3. Treat current readiness as preflight or materials readiness until a live form is inspected.
4. Make actual employer fields the source of truth for answer completeness.
5. Freeze the form fingerprint and field-answer versions into the application packet.

### P1: Make evaluation and preparation trustworthy

6. Add posting liveness before scoring and pursuing.
7. Separate posting legitimacy from candidate fit.
8. Make the overall score consistent with dimension evidence.
9. Add a labeled golden suite for ranking, calibration, dealbreakers, and contradictions.
10. Turn interview proof mappings into persistent, verified STAR+Reflection stories.

### P2: Improve adoption and operational maturity

11. Add providers according to observed source demand while preserving SSRF controls.
12. Connect analytics outcomes to source, score, proof, and targeting recommendations.
13. Add guided onboarding through the existing TUI and agent infrastructure.
14. Add security scanning, user-data leak checks, and release discipline.
15. Correct documentation and build-status drift.

## Verification evidence

### JobOS

The declared dependencies were installed before verification.

- `npm test`: **204 passed, 0 failed**.
- `npm run smoke`: passed the end-to-end application path, including profile and job creation, scoring, artifact review, readiness approval, immutable packet creation, submission attestation, receipt confirmation, discovery, scheduling, and interview preparation.
- A separate runtime scenario reproduced the current resume and cover-letter quality limitation directly.
- The sample deterministic score was inspected and returned 81/100 despite several major dimensions between 45 and 55.

### Career Ops 1.22.0 opensrc snapshot

- `node test-all.mjs`: **2,025 passed, 10 failed, 2 warnings**. Observed failures were dominated by missing `.git` metadata in the opensrc cache, so they were not treated as confirmed product regressions.
- Web `npm test`: **19 passed, 0 failed**.
- Web `npm run typecheck`: passed.
- `node eval-golden.mjs --replay`: aggregate gate passed with 90% archetype agreement and mean absolute score delta of 0.23; three of ten row-level combined checks failed.

## Final assessment

JobOS is closer to a trustworthy career data and control system. Career Ops is currently closer to a complete job-application product.

The fastest path to parity is not to add Career Ops' long tail. It is to close two semantic gaps:

1. turn a tailored artifact into a complete, production-ready document;
2. turn application readiness into a claim grounded in the employer's actual form.

Once those are fixed, JobOS' stronger provenance, research, answer safety, agent mediation, and packet/receipt architecture can make it materially better than Career Ops rather than merely comparable.
