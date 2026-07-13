# Competitive Feature Analysis

**Version:** v2.0 — 2026-07-13
**Research cutoff:** 2026-07-10  
**Scope:** Candidate-facing AI and agentic job-search/application products, with Jack & Jill AI, Sprout, and Indeed as anchors and Simplify, LinkedIn, Teal, LoopCV, and Adzuna ApplyIQ as comparators.

## Executive finding

The market does not have one settled definition of an “agentic apply” product. It has three distinct models:

1. **Career agent, human submission:** Jack searches continuously, learns through conversation, helps tailor materials, prepares interviews, supports negotiation, and can broker Jill-managed introductions, but explicitly does not apply to web-sourced roles for the candidate. Teal likewise emphasizes preparation and organization rather than unattended execution.
2. **Application copilot, human submission:** LinkedIn Premium Apply Assistant, Simplify Copilot, and Teal reduce form and document work. LinkedIn and Simplify read the active application context, prepare or fill supported fields, and require the user to review and submit in their generally available workflows.
3. **Delegated application agent:** Sprout, LoopCV, Adzuna ApplyIQ, Indeed’s limited Apply For Me beta, and Simplify’s private Autopilot can submit for the candidate. The higher-quality variants add match thresholds, per-application material generation, review queues, question escalation, receipts, caps, activity checks, and tracking. The riskiest variant is background submission with generated screening answers and only post-hoc review.

Meaningful parity is therefore a coherent loop that learns intent, finds high-quality opportunities, produces truthful materials and answers, exposes uncertainty, and can execute applications when the user configures and enables it—recording what happened and helping the user improve from outcomes.

## Method and evidence standard

- Research used current first-party product pages, help centers, legal terms, and privacy notices. Vendor marketing metrics are recorded as **vendor claims**, not independently verified facts.
- Product behavior is marked **Verified** when a current first-party help or legal page describes the workflow; **Claimed** when only a product/marketing page describes it; and **Inferred** when it is a reasonable architectural conclusion rather than a documented capability.
- Feature availability can vary by geography, subscription, rollout cohort, application site, or app surface. Absence from public documentation is not proof of absence.
- “Auto-apply” means the service can transmit or submit an application without the user completing the target form. “Autofill” means the user remains in the target form and performs final submission.
- Source links were checked on 2026-07-10. No authenticated product testing or paid subscription testing was performed.
- Feature and terms claims intentionally privilege first-party help/legal pages because they define the current workflow and contractual boundary. Independent coverage was used as corroboration, not as authority: Social Media Today independently reported LinkedIn's June 2026 Apply Assistant rollout [X1], while Sprout's App Store review corpus provides mixed, anecdotal reliability signals [X2]. Competitor-authored comparison blogs were excluded as conflicted evidence. User reviews are never used to score a capability or claim an outcome.

### Market selection

The anchors were named in the objective (Jack & Jill, Sprout, Indeed). Comparators were selected to cover the major current archetypes with verifiable first-party evidence: professional network (LinkedIn), cross-ATS copilot/private agent (Simplify), structured resume/tracker/autofill workspace (Teal), high-autonomy multi-board loop (LoopCV), and quality-thresholded auto-apply inside a large aggregator (Adzuna ApplyIQ). This is a purposive product-pattern sample, not a market-share ranking. Products were included only when current public documentation was detailed enough to separate feature fact from marketing inference.

## Platform profiles

### Jack & Jill AI — high-touch career agent, not an auto-apply bot

**Verified workflow.** Jack onboards through a short voice or chat conversation—current first-party surfaces use varying duration descriptions—learns background and preferences, searches continuously, emails selected matches at a user-selected cadence, and uses feedback to refine search. The product distinguishes web-sourced jobs, where the user follows a link and applies, from Jill-managed roles, where interest can lead to a direct hiring-manager introduction. Jack supports CV/cover-letter tailoring, application-question help, source-backed contact discovery/drafting in an alpha workflow, role-specific voice mock interviews with feedback, salary benchmarking, career clarity, and negotiation practice. Jack’s 2026 guide explicitly says it will not apply on the user’s behalf and should sharpen rather than fabricate experience. ([J1], [J2])

**Data and control.** Jack records/transcribes AI calls; its terms warn that AI output may be inaccurate and require independent assessment. Its privacy policy describes automated matching, user-requestable explanation/human review, public-profile sourcing, and employer sharing controlled through account settings. It also says candidate data may be automatically shared with suitable Jill employers, with settings to change this behavior. ([J3], [J4])

**Strengths.** Deep intent elicitation; a continuous conversational relationship; market mapping and salary context; high-quality interview/negotiation support; direct-introduction network; explicit anti-fabrication and no-spray philosophy.

**Weaknesses/limits.** It does not remove final application-form work for web-sourced roles; the Jill introduction advantage depends on employer-network coverage; voice transcripts and employer-profile sharing create privacy/consent complexity. Its 2026 guide says application tracking is still being built and recommends an external spreadsheet/Notion workflow in the meantime. It does not document a structured answer bank or receipt model.

### Sprout — mobile/web delegated apply with configurable review

**Verified workflow.** Users set role, location, work-model, experience, salary, and freshness filters, upload a PDF resume, optionally link LinkedIn, and swipe right to apply. Sprout generates job-specific materials and sends the application. Its current web review flow supports document editing/regeneration, new-question review, saved answers that enrich a longitudinal profile, and a Manual Review setting; disabling Manual Review permits more automated submissions. Generated resume and cover-letter features can be toggled independently, and manual approval can be required. ([S1], [S2], [S3], [S4])

**Execution and feedback.** Sprout claims portal detection, field mapping, application delivery, submission confirmation, tracker sync, inbox/status updates, and Gmail-based classification of application messages. Its privacy notice says connected Gmail access is read-only and limited to application-addressed messages, describes retention/deletion, and names third-party AI processors. ([S5], [S6])

**Strengths.** Low-friction mobile apply; review queue instead of a single all-or-nothing autonomy switch; per-job materials; question escalation that improves future applications; post-submit receipts, tracking, and inbox reconciliation; clear credit refund behavior for technical failures.

**Weaknesses/limits.** Most capability and outcome evidence is first-party; the exact supported ATS/field coverage is not publicly enumerated. Help documentation describes multi-step forms, employer-account creation, CAPTCHA/anti-bot failures, and no in-app retry for failed submissions—each a material reliability or site-permission concern. The privacy notice says it does not process sensitive information while application automation can encounter demographic/disability/veteran fields, and its documented `whisperpost.io` application identity is not clearly reconciled with the privacy notice’s Gmail plus-address model. Automatic rewriting can introduce unsupported claims unless provenance is enforced; credit/subscription mechanics may reward throughput. Public App Store reviews are mixed and include unverified reports of stale listings, submission failures, and generated-data errors; these are risk signals only, not verified incidence or outcome evidence. ([S7], [S8], [S9], [X2])

### Indeed Career Scout — integrated conversational career coach

**Verified workflow.** Career Scout is an AI chat experience in Indeed’s mobile app. It uses profile, activity, and chat context to explore career paths, refine job search in natural language, provide company/salary insight, build or tailor resumes, track saved/applied jobs in My Jobs, run spoken mock interviews with feedback, and help draft interview, follow-up, and negotiation responses. Indeed frames generated content as suggestions and drafts that the user reviews. ([I1], [I2], [I3])

**Application execution.** Indeed announced Apply For Me on 2026-07-07 as a limited U.S. test. Its current terms permit Indeed to auto-submit applications for eligible U.S./Canadian adults based on profile/preferences and to generate employer-question answers from profile information and past responses. The announcement describes a draft-review mode and a more streamlined mode, submission caps, and inactivity pausing; the terms make clear that disabling the feature does not withdraw prior submissions and place correction responsibility on the user after the fact. This is an early test, not general availability. Third-party JobOS automation remains prohibited without Indeed’s written permission. ([I4], [I5], [I6])

**Strengths.** Huge integrated job/company/salary context; conversational refinement; career-path exploration; native resume persistence; outcome-linked My Jobs; voice interview feedback; Apply For Me quality caps and activity checks are more thoughtful than unlimited auto-apply.

**Weaknesses/limits.** Mobile-app-only Career Scout at the research cutoff; rollout/region constraints; Apply For Me is a limited beta with undisclosed caps; streamlined submissions may contain generated screening answers before the user sees them; switching it off cannot reverse external actions; saving a Career Scout resume replaces the existing Indeed resume; the system is platform-bound and uses extensive Indeed activity for personalization.

### Simplify Copilot — best reference for user-controlled browser autofill

**Verified workflow.** The browser extension detects the current application page, presents resume, cover letter, common questions, and unique questions, fills supported fields, uploads a selected resume, reuses exact-match saved answers, and can generate a job-aware cover letter. The user reviews, edits, and submits. Afterward, Copilot can add the job to its tracker. Unsupported sites fall back to quick copy from the profile. Separately, Simplify now describes Autopilot as private early access that can queue matching applications for review or send them automatically. Simplify says Copilot works across roughly 80% of application sites and names more than 100 job boards/ATS portals, but those are vendor claims and coverage will change. ([C1], [C2], [C3])

**Strengths.** Strong user-control boundary in generally available Copilot; in-context assistance; graceful unsupported-page fallback; reusable answers; automatic tracker handoff; broad ATS coverage; a free role/company-aware AI interviewer adds feedback to the candidate profile and matching loop.

**Weaknesses/limits.** Browser-extension/site compatibility maintenance; exact-question reuse is brittle without semantic matching and answer freshness; demographic/work-authorization fields need stronger sensitivity/consent rules than a generic answer cache; private Autopilot creates product/pre-submit-review ambiguity. Simplify’s formal privacy policy is dated 2021 and does not explain current AI providers, Autopilot, model-training choices, or interview-data reuse even though current product pages say interview responses enrich matching. ([C3], [C4], [C5])

### LinkedIn — intent search and explainable matching inside a large network

**Verified workflow.** LinkedIn offers natural-language job search, suggested refinements, personalized job recommendations, job-match summaries derived from profile/resume/job qualifications, AI cover-letter/resume assistance, recruiter-message drafting, and job alerts. Its newly documented Premium Apply Assistant appears for selected Premium members and supported strong-match jobs, prepares tailored resumes, prefills fields, supports selected Greenhouse/Lever flows, suggests outreach, and tracks status. Every draft remains editable and the user reviews before submitting. Current natural-language search has documented exclusions/profile-query limitations. Independent June 2026 trade coverage corroborates the staged rollout and prefill/confidence-indicator workflow but adds no stronger availability guarantee. ([L1], [L2], [L3], [L6], [X1])

**Terms boundary.** LinkedIn explicitly prohibits third-party software or extensions that scrape, modify, or automate activity on its website, and its User Agreement prohibits bots and unauthorized automated access. A JobOS adapter that logs in with a cookie and automates LinkedIn would therefore be a ToS-risk, regardless of user preference. ([L4], [L5])

**Strengths.** Network and employer graph; natural-language intent; profile-aware explanations; applicant-relative signals; native recruiter access and outreach context.

**Weaknesses/limits.** Premium/rollout/geography restrictions; platform lock-in; some AI prompts may be processed through Bing; match levels are proprietary and not employer-visible; automated third-party integration is contractually constrained.

### Teal — cross-site job-search operating system and resume workspace

**Verified/claimed workflow.** Teal combines a browser-based job tracker, Chrome capture across many job sites, resume building/tailoring, keyword analysis, opportunity ranking/excitement, pipeline stages, application autofill, and tailored open-answer generation. Its step-by-step flow tells users to review/edit and apply; one marketing heading says the extension can “populate and submit,” so unattended submission is not sufficiently verified. Teal also offers job-specific conversational interview practice with screening/technical/culture formats, optional video/transcription, feedback, and progress history. ([T1], [T2], [T3])

**Data and control.** Teal’s January 2026 privacy policy names AI processing and OpenAI as an example provider, allows career content to improve models only in anonymized/aggregated form, says it does not sell personal information, describes encryption, and says account deletion removes or anonymizes data within 30 days subject to exceptions. ([T4])

**Strengths.** Strong organization, cross-board capture, resume version workflow, prioritization, reviewed autofill, and interactive interview practice; comparatively current privacy disclosure.

**Weaknesses/limits.** Less autonomous and conversational in discovery than the largest platforms; tracker statuses generally remain user-maintained; generated answers still require factual review; public pages do not establish receipt or inbox reconciliation; the autofill page’s “submit” marketing language is broader than its review-first instructions.

### LoopCV — configurable loops and high-throughput multi-channel application

**Verified workflow.** A Loop configures search terms, location, source, email template, filters, excluded employers, matching strictness, and execution settings. It can send email applications, fill/submit supported forms, collect unanswered screening questions, generate AI answers on paid plans, and use an extension for authenticated boards. The dashboard distinguishes submitted, extension-required, pending-question, and manual applications. ([V1], [V2])

**Strengths.** Explicit long-running workflow model; clear fallback states; exclusions and matching strictness; multi-channel execution; application report and experiment/A/B-test concepts.

**Weaknesses/risks.** Vendor messaging emphasizes hundreds or thousands of applications and says employers are not told about automation; extension automation on LinkedIn conflicts with LinkedIn’s documented third-party automation policy; AI-generated screening answers without per-answer provenance can misrepresent the candidate; high volume can harm reputation and ecosystem signal quality.

### Adzuna ApplyIQ — quality-thresholded auto-apply

**Verified vendor description.** Users upload a resume, choose up to eight target titles, location, and salary expectations. ApplyIQ searches Adzuna’s inventory, scores fit, applies only when a strict threshold is met, and submits a tailored cover note. Adzuna explicitly positions limits and controls as an alternative to volume-first automation. ([A1], [A2])

**Strengths.** Quality-first framing; explicit target limits; integrated job corpus and salary tools; simple always-on workflow.

**Weaknesses/limits.** Public sources do not expose threshold logic, per-field review, answer provenance, receipt/retry semantics, or supported destination mechanics; effectiveness claims are vendor-provided.

## Categorized capability inventory

| Capability | Leading implementation pattern | User value | Recurring limitation / risk |
|---|---|---|---|
| Conversational onboarding | Jack voice/chat career discovery; Indeed Career Scout chat | Captures motivations, constraints, pivots, and tacit preferences that forms miss | Sensitive oversharing, transcript retention, and weak conversion into explicit editable rules |
| Persistent candidate memory | Jack evolving profile; Sprout questions enrich future applications; Simplify saved answers | Less repetition and improving personalization | Stale answers, hidden inference, no provenance, accidental reuse in a different context |
| Natural-language discovery | LinkedIn AI search; Indeed chat refinement; Jack continuous search | Lets users describe intent beyond keywords | Opaque ranking, rollout limits, weak negation/exclusion support |
| Multi-source continuous discovery | Jack daily scanning; LoopCV loops; Sprout aggregated feed | Earlier access and less manual browsing | Duplicates, stale/reposted roles, scraping/ToS risk, source attribution loss |
| Explainable match | LinkedIn qualification summary; Adzuna threshold; Sprout profile analysis | Helps decide whether an application is worth time | Proprietary scores can create false certainty; comparative applicant data is usually unavailable |
| Preference feedback loop | Jack “right/wrong” feedback; LinkedIn thumbs; Indeed chat corrections | Search improves from behavior | Feedback may overfit or infer sensitive traits; undo/reset controls are often unclear |
| Evidence-aware materials | Jack anti-fabrication rule; Job-specific tailoring across Sprout/Simplify/Teal | Better relevance without starting over | Many products describe personalization but not claim-level source provenance |
| Resume versioning and format | Teal/Simplify builders; Sprout per-job generated PDFs | Reusable, ATS-compatible documents | Formatting regressions, version confusion, keyword gaming, unsupported metrics |
| Cover letters and short answers | Most products generate role-aware drafts | Removes repetitive writing | Generic voice, unsupported enthusiasm/facts, disclosure and authorship concerns |
| Structured answer bank | Simplify exact-question reuse; Sprout/LoopCV learned questions | Avoids repeated form work | Sensitive fields, semantic collisions, answer expiry, employer-specific nuance |
| Form schema/detection | Simplify in-browser sections; Sprout smart mapping; LoopCV form/extension states | Converts arbitrary forms into manageable data | Constant adapter maintenance, CAPTCHAs/login, dynamic/conditional forms |
| Human review queue | Sprout Manual Review; Simplify review-before-submit | High leverage without blind submission | Review fatigue if every field is shown; lack of risk-based prioritization |
| Delegated submission | Sprout, LoopCV, ApplyIQ | Largest time saving | Wrong target/answer, duplicate submission, ToS/account risk, no proof of delivery |
| Fallback/escalation | Simplify copy mode; LoopCV pending questions/manual link | Prevents silent failure | Context switching; weak resumption/idempotency can duplicate applications |
| Receipts and tracker sync | Sprout confirmation/tracker; Simplify post-submit capture; LoopCV reports | Trust, auditability, and less manual logging | Confirmation may be inferred rather than source-backed; external status is hard to reconcile |
| Email/inbox reconciliation | Sprout Gmail classification | Automatic status updates and reminders | High-sensitivity inbox scope, retention, false classification, OAuth security |
| Outreach/network path | Jack/Jill introductions; LinkedIn recruiter context; LoopCV email finder | Bypasses cold ATS channel and improves response odds | Spam, private-profile scraping, non-consensual contact enrichment, reputation risk |
| Interview simulation | Jack voice mock interview; Indeed spoken practice; LoopCV AI mock tools | Builds spoken skill with role context | Feedback quality and bias; recording consent; no ground-truth interviewer rubric |
| Salary/career/offer support | Jack and Indeed market insight and negotiation practice; Adzuna salary data | Extends value beyond application submission | Estimates may be wrong/stale; legal/financial-professional-advice boundary |
| Outcome analytics | Teal tracker, LoopCV A/B concepts, Sprout status, Indeed My Jobs | Learns which sources/materials produce interviews | Confounding and small samples; optimizing volume rather than quality |
| Autonomy controls | Sprout manual-review toggle; LoopCV per-method toggles; Jack assist-only boundary | Matches different risk tolerances | Binary global switches are too coarse; settings often fail to distinguish low/high-risk fields |
| Privacy and transparency | Jack explainability/human review; Sprout processor disclosure; Indeed responsible AI | Builds trust and enables informed choices | Centralized services require resume, profile, transcript, and sometimes inbox data |

## Cross-platform capability matrix

Legend: **●** documented strong capability; **◐** partial/limited/assistive; **○** not found in reviewed public sources; **!** capability with material terms/privacy/reputation risk. Evidence class: **V** verified in a first-party help/legal workflow; **C** vendor marketing claim; **I** analyst inference. Every non-`○` cell is the canonical ledger entry and names its evidence class/source IDs.

| Capability | Jack | Sprout | Indeed | Simplify | LinkedIn | Teal | LoopCV | ApplyIQ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Conversational/voice intent capture | ●V [J1/J2] | ○ | ●V [I1/I2] | ○ | ◐V [L1] | ○ | ○ | ○ |
| Continuous personalized discovery | ●V [J1] | ●C [S1] | ◐V [I1] | ◐C [C3] | ●V [L1/L3] | ◐C [T1] | ●V [V1] | ●C [A1] |
| Feedback-driven search refinement | ●V [J1/J2] | ○ | ●V [I1/I2] | ◐C [C3] | ●V [L1/L3] | ○ | ○ | ○ |
| Explainable fit/match | ●V [J1/J2] | ◐C [S1/S2] | ◐V [I1/I2] | ●C [C3] | ●V [L2/L6] | ●C [T1/T2] | ◐V [V1] | ◐C [A1] |
| Evidence/anti-fabrication commitment | ●V [J2] | ○ | ◐V [I3] | ◐C [C2] | ◐V [L2] | ◐C [T1] | ○ | ○ |
| Job-specific resume/letter | ●V [J2] | ●V [S2/S3] | ●V [I1/I3] | ●V [C1/C2] | ●V [L6] | ●C [T1/T2] | ◐C [V2] | ◐C [A1] |
| Reusable application answers | ○ | ●V [S2] | ◐V beta [I5/I6] | ●V [C1] | ◐V [L6] | ○ | ●V [V1] | ○ |
| Browser/form autofill | ○ | ●C [S5] | ◐V beta [I5/I6] | ●V [C1] | ●V native [L6] | ●C [T2] | ●!V [V1/V2] | ○ |
| Background/delegated submission | ○ | ●V [S1/S2/S5] | ◐V beta [I5/I6] | ◐C private beta [C3] | ○ | ○ | ●!V [V1/V2] | ●C [A1] |
| Per-application manual review | N/A—no apply V [J1] | ●V [S2] | ◐V optional beta [I5/I6] | ●V [C1] | ●V [L6] | ●C [T2] | ◐V [V1] | ○ |
| Submission receipt evidence | ○ | ●C [S5] | ○ | ○ | ○ | ○ | ●V [V1] | ○ |
| Automatic application tracker | ○ | ●C [S5] | ●V [I1/I5] | ●V [C1] | ●V [L6] | ◐C [T1] | ●V [V1] | ○ |
| Inbox/status reconciliation | ○ | ●V [S6] | ◐V [I1] | ○ | ●V native [L6] | ○ | ○ | ○ |
| Research/outreach assistance | ◐V [J2] | ○ | ◐V [I1/I3] | ◐C [C3] | ◐V [L3/L6] | ○ | ◐!C [V2] | ○ |
| Voice/mock interview + feedback | ●V [J1/J2] | ○ | ●V [I1/I2] | ●C [C4] | ○ | ●C [T3] | ●C [V2] | ◐C suite-level [A2] |
| Salary/negotiation support | ●V [J1/J2] | ○ | ●V [I1/I2] | ○ | ◐V [L3] | ○ | ○ | ●C suite-level [A2] |
| Local-first/offline core | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Agent-facing CLI/API/MCP | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

**Ledger rule.** A filled circle records documented breadth, not independent validation of quality or coverage. “Native” means the platform owns the application surface; it does not imply third-party access. `○` cells may include a parenthetical near-miss explanation in the high-risk notes, but a near-miss source never upgrades the symbol. A release-time `tests/competitive-ledger.test.js` parser must fail when a non-`○` cell lacks an evidence class/source ID, when a referenced source is undefined, or when a displayed symbol differs from the canonical cell.

**High-risk cell evidence ledger.** This compact ledger makes the most interpretation-sensitive rows directly auditable; `○` means no supporting source was found in the reviewed corpus.

| Capability | Jack | Sprout | Indeed | Simplify | LinkedIn | Teal | LoopCV | ApplyIQ |
|---|---|---|---|---|---|---|---|---|
| Feedback learning | J1/J2 | S2 (answer memory only) | I1/I2 | C3 | L1/L3 | T1 (ranking only) | V1 (loop settings) | ○ |
| Explainable fit | J1/J2 | S1/S2 | I1/I2 | C3 | L2/L6 | T1/T2 | V1 | A1 |
| Interview feedback | J1/J2 | ○ | I1/I2 | C4 | ○ (L6 is application confidence, not mock interview) | T3 | V2 | A2 (suite-level only) |
| Submission evidence | ○ | S5 | ○ (I5/I6 document delegated apply, not a receipt) | ○ | ○ | ○ | V1 | ○ |
| Tracker automation | ○ | S5 | I1/I5 | C1 | L6 | T1/T2 (partial capture) | V1 | ○ |

## What leaders do well—and patterns to selectively adapt

### Patterns worth adapting

1. **One evolving profile, multiple explicit views.** Combine career intent, verified proof, reusable answers, application history, and feedback, but keep each claim editable and source-labelled.
2. **Review by exception.** A review queue should elevate new, stale, sensitive, unsupported, contradictory, or low-confidence fields instead of making the user reread their name and email every time.
3. **A resumable application plan.** Detect fields, map known answers, list blockers, prepare files, and produce a deterministic application before submission.
4. **Receipts as a first-class object.** Store target URL, exact artifact versions, answer snapshot, timestamp, user confirmation, and external receipt/confirmation evidence.
5. **Learning from explicit feedback and outcomes.** Search refinement should use thumbs/reasons and interview outcomes, while keeping learned rules inspectable and reversible.
6. **Career support beyond submit.** Voice rehearsal, market mapping, company research, network paths, and negotiation are often more differentiating than another application click.
7. **Quality budgets.** Use match floors, daily caps, exclusions, cooldowns, duplicate protection, and application-value scoring. Volume is a constraint, not the goal.
8. **User-configured delegation.** Sprout, LoopCV, ApplyIQ, and Indeed Apply For Me demonstrate that delegated submission is a real market model. JobOS should support auto-apply and auto-send when the user explicitly configures and enables them, with displayed risk warnings for platform terms compliance.
9. **Authenticated-board discovery.** LinkedIn and Indeed job discovery through user-provided session credentials is technically feasible and valuable. The user bears responsibility for platform terms compliance; JobOS should display ToS risk warnings but not block the capability.

### Patterns to handle with care

1. **Hidden automation.** "Employers see no indication" is not a trust feature. JobOS should retain a truthful local audit and never misrepresent the candidate or confirmation state.
2. **Generated screening answers without source lineage.** Work authorization, compensation, criminal history, disability, demographic, security-clearance, and legal attestations must never be inferred without explicit user input.
3. **Using a draft when approval is absent.** A missing approved artifact should be a blocker by default, but the user may configure use of the latest draft as a user-configured option.
4. **Outcome claims based on marketing metrics.** Interview/hire lift should be measured locally with clear denominators and no causal overclaim.
5. **Global "auto" switches.** Control should be per connector, action, employer, field category, match threshold, volume window, and data class.
6. **CAPTCHA bypass / employer-account creation.** Adapters should fail gracefully rather than attempt to bypass anti-bot measures or create accounts on behalf of the employer.

## Sources

All sources accessed 2026-07-10.

- **[J1]** Jack & Jill, [Meet Jack — Your AI Career Agent](https://www.jackandjill.ai/).
- **[J2]** Jack & Jill, [How to Find a Job in 2026 (PDF)](https://www.jackandjill.ai/downloads/jacks-guide.pdf).
- **[J3]** Jack & Jill, [Job Seeker Terms](https://www.jackandjill.ai/terms) (effective 2026-01-28).
- **[J4]** Jack & Jill, [Privacy Policy](https://www.jackandjill.ai/privacy).
- **[S1]** Sprout Help, [How Do I Apply to Jobs on Sprout?](https://help.usesprout.com/en/articles/11676023-how-do-i-apply-to-jobs-on-sprout) (2026-02-23).
- **[S2]** Sprout Help, [Reviewing Applications in the Web App (Manual Review Mode)](https://help.usesprout.com/en/articles/13604310-reviewing-applications-in-the-web-app-manual-review-mode) (2026-02-23).
- **[S3]** Sprout Help, [AI Generated Resume and Cover Letters](https://help.usesprout.com/en/articles/11743856-ai-generated-resume-and-cover-letters) (2026-01-30).
- **[S4]** Sprout Help, [See How Applications Work in Sprout](https://help.usesprout.com/en/articles/13802695-see-how-applications-work-in-sprout) (2026-02-21).
- **[S5]** Sprout, [AI Apply](https://www.usesprout.com/features/ai-apply).
- **[S6]** Sprout, [Privacy Policy](https://www.usesprout.com/legal/privacy-policy).
- **[S7]** Sprout Help, [Why did Sprout fail to submit my job application?](https://help.usesprout.com/en/articles/11511529-why-did-sprout-fail-to-submit-my-job-application).
- **[S8]** Sprout Help, [Why did I run out of application credits even though I only applied to a few jobs?](https://help.usesprout.com/en/articles/11511308-why-did-i-run-out-of-application-credits-even-though-i-only-applied-to-a-few-jobs).
- **[S9]** Sprout Help, [Why is the email on my job applications not my personal email?](https://help.usesprout.com/en/articles/11511462-why-is-the-email-on-my-job-applications-not-my-personal-email).
- **[I1]** Indeed, [What Is Indeed Career Scout?](https://www.indeed.com/help/job-seekers/articles/33940519874317-what-is-indeed-career-scout).
- **[I2]** Indeed, [FAQs: Career Scout](https://support.indeed.com/hc/en-us/articles/39321745715853-FAQs-Career-Scout).
- **[I3]** Indeed, [What Is Indeed Career Scout? — Career Guide](https://www.indeed.com/career-advice/finding-a-job/what-is-indeed-career-scout) (updated 2026-03-25).
- **[I4]** Indeed, [Save and Continue a Job Application](https://www.indeed.com/help/job-seekers/articles/31239896015245-save-and-continue-a-job-application).
- **[I5]** Indeed, [Terms of Service](https://www.indeed.com/legal) (last updated 2026-07-07).
- **[I6]** Indeed Newsroom, [Indeed’s Apply For Me: Testing a New Way to Help Job Seekers Find Relevant Opportunities](https://www.indeed.com/news/releases/indeed-tests-apply-for-me-job-search?co=US) (2026-07-07).
- **[C1]** Simplify Help, [Using Copilot to Autofill Applications](https://help.simplify.jobs/en/help/articles/2415391-using-copilot-to-autofill-applications).
- **[C2]** Simplify, [Copilot](https://simplify.jobs/copilot).
- **[C3]** Simplify, [AI Talent Agent](https://simplify.jobs/ai-talent-agent) (Autopilot described as private early access).
- **[C4]** Simplify, [AI Interview Coach](https://simplify.jobs/ai-interviewer).
- **[C5]** Simplify, [Privacy Policy](https://simplify.jobs/privacy) (last updated 2021-06-01).
- **[L1]** LinkedIn Help, [Discover new opportunities with AI-powered job search](https://www.linkedin.com/help/linkedin/answer/a8078917).
- **[L2]** LinkedIn Help, [Find how you match up with jobs on LinkedIn](https://www.linkedin.com/help/linkedin/answer/a7120158).
- **[L3]** LinkedIn Help, [How we help job seekers and hirers connect](https://www.linkedin.com/help/linkedin/answer/a7134286).
- **[L4]** LinkedIn Help, [Automated activity on LinkedIn](https://www.linkedin.com/help/linkedin/answer/a1340567).
- **[L5]** LinkedIn, [User Agreement](https://www.linkedin.com/legal/user-agreement).
- **[L6]** LinkedIn Help, [Premium Apply Assistant on LinkedIn](https://www.linkedin.com/help/linkedin/answer/a11270026).
- **[T1]** Teal, [All-in-One AI Job Search Toolkit](https://join.tealhq.com/).
- **[T2]** Teal, [Autofill Job Applications](https://www.tealhq.com/tools/autofill-job-applications).
- **[T3]** Teal, [AI Interview Practice](https://www.tealhq.com/tools/ai-interview-practice).
- **[T4]** Teal, [Privacy Policy](https://www.tealhq.com/privacy-policy) (last updated 2026-01-21).
- **[V1]** LoopCV, [Knowledge Base](https://loopcv.freshdesk.com/support/solutions/articles/103000399849-knowledge-base).
- **[V2]** LoopCV, [Auto Apply for Jobs](https://www.loopcv.pro/auto-apply-for-jobs/).
- **[A1]** Adzuna, [ApplyIQ launch announcement](https://www.adzuna.com/blog/adzuna-launches-ai-job-search-agent-applyiq/) (2025-04-15).
- **[A2]** Adzuna, [AI job-search tools](https://www.adzuna.com/ai-job-search).
- **[X1]** Social Media Today, [LinkedIn automates job application process for premium users](https://www.socialmediatoday.com/news/linkedin-automates-job-application-process-for-premium-users/823719/) (2026-06-24; independent rollout corroboration).
- **[X2]** Apple App Store, [Sprout — AI Job Search ratings and reviews](https://apps.apple.com/us/app/sprout-ai-job-search/id6740011494?see-all=reviews) (anecdotal user reports; not used for capability or outcome scoring).

## Adjacent products screened but not benchmarked

- **Resume/tracker specialists** such as Jobscan and Huntr overlap the Teal/Simplify pattern but were not needed to establish the core resume-match/tracker gap.
- **Additional autonomous apply tools** such as LazyApply, Sonara, and open-source browser bots overlap the Sprout/LoopCV/ApplyIQ execution pattern; they were excluded because this analysis prioritized products with current, sufficiently detailed first-party workflow and legal/privacy evidence.
- **Standalone interview coaches** were excluded because Jack, Indeed, Simplify, Teal, and LoopCV already expose the coaching pattern inside a broader job-search system.
- **Employer-side hiring agents** were considered only where they materially affect the seeker experience. The benchmark is candidate-facing, not an ATS/recruiter product survey.

## Version history
- **v2.0 — 2026-07-13:** Revised adaptation patterns to embrace user-configured auto-apply, auto-send, and authenticated-board adapters per PR #2 direction. Renamed "Patterns to reject" to "Patterns to handle with care." Added user-configured delegation and authenticated-board discovery as patterns worth adapting. Platform terms compliance is the user's responsibility; JobOS displays ToS risk warnings but does not block capabilities.

- **v1.6 — 2026-07-11:** Converted the displayed matrix into the canonical cell ledger: every non-empty capability cell now carries verified/claimed/inferred class and direct source IDs, with mechanical-check requirements.
- **v1.5 — 2026-07-10:** Added independent rollout/user-risk triangulation, qualified conflicting Jack onboarding-duration copy, and added a high-risk cell evidence ledger with conservative feedback/interview/receipt corrections.
- **v1.4 — 2026-07-10:** Removed unsupported ApplyIQ anti-fabrication and Jack application-review claims; separated receipt evidence from tracker automation; added cell-level citations to ambiguous lifecycle rows.
- **v1.3 — 2026-07-10:** Corrected matrix contradictions, added a row-level evidence map, clarified selection rationale, and documented adjacent-product exclusions after provisional evaluation.
- **v1.2 — 2026-07-10:** Deepened Jack tracking, Sprout execution/privacy limitations, Simplify interview/privacy, and Teal autofill/interview/privacy evidence.
- **v1.1 — 2026-07-10:** Added July 2026 Indeed Apply For Me beta, LinkedIn Premium Apply Assistant, and Simplify private Autopilot after independent research found newly published primary sources.
- **v1.0 — 2026-07-10:** Initial evidence-backed synthesis; separated career-agent, copilot, and delegated-submission models; added legal/terms boundaries and adaptation/rejection patterns.
