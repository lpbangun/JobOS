# Tailored Resume Implementation Plan

**Version:** v1.0 — 2026-07-22
**Inputs:** `docs/open_source_benchmark_checkup.md`; `CAREER_OPS_IMPLEMENTATION_AUDIT.md`; current JobOS tailoring, profile, artifact, readiness, and packet implementations.
**Purpose:** Replace JobOS's outline-style tailored resume with a complete, proof-grounded, visually polished, ATS-preflighted application document.

## Product decision

Build the resume workflow as a constrained document compiler:

> canonical resume → structured job requirements → proof coverage → tailored semantic document → ATS preflight → LaTeX rendering → machine and visual validation → exact-revision human review

The canonical resume is structured JSON. LaTeX is the primary polished-PDF renderer, not the canonical data format. The tailoring model returns typed content transformations and never emits LaTeX directly.

The existing JobOS controls remain mandatory:

- SQLite is canonical and local-first.
- Every accomplishment claim is linked to active stored proof points.
- Unsupported requirements remain explicit gaps; they never become invented claims.
- Generated documents default to `draft_needs_human_review`.
- Artifact series, revisions, hashes, diffs, approval, packets, and receipts remain exact-revision-bound.
- The deterministic path must produce a complete usable resume without an LLM.

## Problem statement

The current resume artifact is a proof-point worksheet rather than a complete resume:

- profile import stores raw text but extracts only action-verb proof lines;
- contact details, chronology, education, credentials, projects, and complete skills are not represented semantically;
- job requirement extraction is a line-level regex;
- proof selection uses raw token overlap and caps the resume at five proofs;
- LLM-tailored bullet text is discarded in favor of the stored proof summary;
- readiness treats one current proof citation as sufficient grounding;
- tests defend provenance and non-fabrication but not completeness, visual quality, or ATS-readable rendering.

PDF export alone would polish an incomplete document. Prompt changes alone would give the model more freedom without fixing the source record or validation contract.

## Scope

### In scope

1. A versioned canonical master-resume JSON model.
2. Complete resume import with explicit uncertain fields and human correction.
3. Proof verification, supersession, and retirement without destroying lineage.
4. Structured job-requirement extraction and persistence.
5. A mini ATS preflight analyzer based on requirement coverage and rendered-text checks.
6. Proof-grounded summary and bullet transformation.
7. Role-family layout profiles and constrained section ordering.
8. A maintained LaTeX renderer with ATS-safe templates.
9. Semantic, ATS, rendering, and visual quality gates before review.
10. Readiness integration, artifact metadata, CLI JSON output, workspace mirrors, and behavioral tests.

### Non-goals

- Reproducing proprietary ATS ranking algorithms.
- Keyword density gaming or unsupported keyword insertion.
- Letting an LLM generate arbitrary LaTeX.
- A template marketplace or dozens of themes.
- Multi-column, chart-heavy, icon-dependent, or decorative default resumes.
- Inventing employers, titles, dates, credentials, metrics, skills, or accomplishments.
- Making an LLM, TeX installation, or browser dependency mandatory for the local core workflow.
- Changing application packet, receipt, or external-action policy beyond consuming the stronger resume artifact.

## Design principles

### Content and presentation are separate

The semantic resume determines facts, selected evidence, wording, and section content. A layout profile determines section order, density, page size, and template. LaTeX converts those typed inputs into a PDF.

### Job-specific emphasis, stable visual identity

The target job may change the summary, selected bullets, skill ordering, and section emphasis. It should not produce a random visual design for every application. JobOS owns a small, consistent visual system.

### Beauty is constrained and testable

A beautiful resume has:

- clear information hierarchy;
- restrained typography;
- consistent alignment;
- balanced whitespace;
- readable bullet density;
- deliberate page breaks;
- no overflow, orphan headings, or nearly empty pages;
- clean ATS text extraction order.

### The ATS analyzer is an evidence compiler

The mini ATS identifies coverage and document risks. It does not claim to predict a vendor-specific hidden score. Any numeric coverage result must be decomposable into exact requirements, evidence, and gaps.

## Target architecture

```text
Source resume + manual profile facts + proof points
                         |
             Canonical resume revision JSON
                         |
Job description -> structured requirements inventory
                         |
          Requirement-to-proof coverage matrix
                         |
       Grounded content and layout transformation
                         |
          Tailored semantic resume snapshot
                         |
       Semantic validation + ATS content preflight
                         |
           Allowlisted LaTeX template renderer
                         |
             PDF + extracted text + page images
                         |
          ATS render checks + visual preflight
                         |
      Versioned artifact -> human review -> packet
```

## Canonical master-resume model

The canonical document must preserve complete factual content and stable IDs:

```json
{
  "schemaVersion": 1,
  "identity": {
    "name": "Candidate Name",
    "email": "candidate@example.com",
    "phone": "+1 555 555 5555",
    "location": "City, State",
    "links": [{ "id": "link_1", "label": "LinkedIn", "url": "https://..." }]
  },
  "summary": {
    "id": "summary_1",
    "text": "...",
    "verificationStatus": "verified"
  },
  "experience": [
    {
      "id": "experience_1",
      "employer": "Example Co",
      "title": "Product Manager",
      "location": "Remote",
      "startDate": "2022-01",
      "endDate": null,
      "bullets": [
        {
          "id": "bullet_1",
          "text": "Improved activation by 30%...",
          "proofPointIds": ["proof_1"],
          "verificationStatus": "verified"
        }
      ]
    }
  ],
  "education": [],
  "skills": [],
  "credentials": [],
  "projects": [],
  "additionalSections": []
}
```

Rules:

- Unknown sections are preserved as typed `additionalSections`; import never silently drops them.
- Dates use normalized values plus retained source text when parsing is uncertain.
- Imported fields begin as `verified`, `needs_verification`, or `rejected` according to source confidence and user review.
- Stable entry IDs survive wording corrections where identity is unchanged.
- The original source text and source hash remain available for comparison.
- A correction creates a new canonical revision; it does not mutate historical tailored artifacts.

## Persistence changes

Use additive migrations.

### `profile_resume_revisions`

```text
id
profile_id
revision
schema_version
source_text
source_text_hash
document_json
verification_status
supersedes_resume_id
created_at
reviewed_at
```

Constraints:

- unique `(profile_id, revision)`;
- exactly one current revision per profile;
- `supersedes_resume_id` belongs to the same profile;
- `document_json` passes the versioned resume schema before persistence.

### `proof_points`

Add:

```text
status                    active | retired | needs_verification
verification_status       verified | unverified | rejected
source_resume_entry_id
supersedes_proof_point_id
updated_at
retired_at
retirement_reason
```

Tailoring may use only active proof points. Unverified proof points may be displayed as gaps or warnings but may not support a generated factual claim unless the user explicitly verifies them.

### `artifact_resume_documents`

```text
artifact_id
schema_version
source_resume_revision_id
document_json
coverage_json
validation_json
layout_profile_json
render_manifest_json
```

The generic `artifacts` row continues to own content, path, review state, revision, predecessor, and hash. This table stores resume-specific semantic and render state.

## Structured job requirements

Replace line-level filtering with a persisted inventory in `jobs.requirements_json`:

```json
{
  "schemaVersion": 1,
  "requirements": [
    {
      "id": "requirement_1",
      "sourceText": "Experience conducting educator research",
      "category": "experience",
      "priority": "must_have",
      "normalizedTerms": ["educator research", "user research"],
      "years": null,
      "credential": null
    }
  ]
}
```

Supported categories:

- responsibility;
- skill;
- experience;
- domain;
- seniority;
- credential;
- work model;
- preferred qualification.

The deterministic parser recognizes headings, bullet boundaries, must/preferred language, years, credentials, and common skill syntax. An optional LLM may normalize the inventory but must retain exact source text and stable requirement IDs.

## Mini ATS preflight analyzer

### Requirement coverage

For each important requirement, produce:

```json
{
  "requirementId": "requirement_1",
  "status": "supported",
  "proofPointIds": ["proof_1"],
  "sourceEntryIds": ["bullet_1"],
  "matchedTerms": ["educator research"],
  "confidence": "high",
  "reason": "Verified bullet and proof describe educator discovery."
}
```

Statuses:

- `supported`;
- `partially_supported`;
- `unsupported`;
- `not_applicable`.

Ranking combines exact skills, normalized terms, proof verification, role/domain context, metrics, and optional LLM classification restricted to known requirement, proof, and resume-entry IDs.

### Honest ATS output

The user-facing report shows:

- matched requirements;
- supported evidence omitted from the current draft;
- partially supported requirements;
- unsupported requirements;
- section-completeness risks;
- rendered-text extraction risks.

It may report transparent coverage ratios, but it must not claim a universal proprietary ATS score or interview probability.

### Pre-render checks

- required sections are present;
- role-relevant skills are present only when stored in the canonical record;
- important supported requirements are represented;
- no unsupported requirement was inserted as a candidate claim;
- common headings use ATS-readable labels;
- dates and chronology are consistent;
- section order matches the selected layout profile.

### Post-render checks

- PDF text extraction succeeds;
- extracted text contains expected identity, section headings, employers, titles, dates, and selected bullets;
- extracted order matches semantic order;
- no text is missing, duplicated, or garbled;
- fonts are embedded or reliably available;
- links remain accessible;
- page size and page count match policy.

## Tailoring contract

Tailoring transforms the canonical resume; it does not construct a resume from isolated proof points.

1. Load the current verified canonical resume revision.
2. Parse or load the structured job requirements.
3. Build the requirement-to-proof coverage matrix.
4. Select a role-family layout profile, allowing explicit user override.
5. Copy identity, employers, titles, dates, education, and credentials unchanged.
6. Generate or preserve a grounded professional summary.
7. Select and reorder verified bullets within their actual roles.
8. Permit grounded rewriting tied to source bullet and proof IDs.
9. Select and order only canonical skills.
10. Validate the semantic result.
11. Render it through the allowlisted LaTeX template.
12. Run post-render ATS and visual checks.
13. Persist the artifact, semantic snapshot, coverage, validation, and render manifest.

### LLM output schema

The model returns transformations only:

```json
{
  "summary": {
    "text": "...",
    "proofPointIds": ["proof_1", "proof_2"]
  },
  "bullets": [
    {
      "sourceBulletId": "bullet_1",
      "proofPointIds": ["proof_1"],
      "text": "..."
    }
  ],
  "selectedSkillIds": ["skill_1"],
  "layoutProfileId": "technical",
  "warnings": []
}
```

The LLM cannot set identity, employer, title, date, education, credential, source entry ID, or proof identity. Invalid IDs are dropped and recorded as warnings. A rewritten claim must pass fact and metric validation before it can appear in the document.

### Deterministic path

Without an LLM, JobOS still emits a complete resume by:

- preserving the verified canonical summary;
- retaining factual sections;
- selecting and ordering existing verified bullets;
- ordering canonical skills by supported requirement coverage;
- recording unsupported requirements as gaps outside the human document.

The deterministic path may be less eloquent, but it must never degrade into a worksheet.

## Layout profiles

Start with one visual system and three constrained profiles.

### `professional`

Default for most roles:

```text
summary -> experience -> skills -> education -> credentials/projects
```

### `technical`

For engineering, data, technical product, and related roles:

```text
summary -> skills -> experience -> projects -> education -> credentials
```

### `leadership`

For senior management and executive roles:

```text
executive summary -> leadership experience -> selected impact -> skills -> education/credentials
```

Research or academic CV behavior should be added only when product demand establishes that a longer CV contract is necessary.

A layout profile contains:

```json
{
  "templateId": "jobos-classic",
  "roleFamily": "technical",
  "sectionOrder": ["summary", "skills", "experience", "projects", "education"],
  "density": "compact",
  "pageSize": "letter",
  "pageLimit": 2
}
```

Inference is deterministic from job and profile data where possible. The user may override template, role family, section order, density, page size, and page limit.

## LaTeX renderer

### Renderer contract

- Input is validated semantic resume JSON plus an allowlisted layout profile.
- Templates are maintained local assets, not model output.
- All user-controlled text and URLs are escaped by one tested escaping layer.
- Renderer execution has bounded time, bounded output paths, and no shell interpolation.
- The render manifest records template ID/version, page size, page count, source artifact hash, PDF hash, extracted-text hash, warnings, and tool versions.
- TeX failure produces a typed blocker and retains the semantic draft for inspection.

### Template requirements

- single-column default;
- conventional headings;
- restrained typography;
- selectable Letter or A4;
- consistent date alignment;
- no icons required to understand contact information;
- no text boxes, charts, skill bars, or graphical ratings;
- deterministic page-break rules;
- fonts selected for readability and reliable embedding;
- accessible extracted text order.

### Dependency policy

The core semantic and Markdown output remains usable without TeX. PDF rendering is enabled when the configured local LaTeX engine is available. JobOS reports the missing dependency and exact setup action rather than silently substituting a fake PDF.

## Semantic validation

### Blocking validation

- canonical resume revision exists and is current;
- required identity and contact fields exist;
- at least one complete experience or applicable entry exists;
- employers, titles, dates, education, and credentials match the canonical source;
- every changed accomplishment cites active verified evidence;
- every generated metric is present in cited evidence;
- every generated skill is present in canonical skills or cited verified evidence;
- unsupported requirements are absent from candidate claims;
- no canonical factual section is silently dropped;
- semantic schema and layout profile are valid;
- PDF render and extracted-text checks pass when PDF output is requested.

### Warnings

- important unsupported requirements;
- partial or low-confidence coverage;
- stale proof evidence;
- optional incomplete sections;
- summary or bullet length concerns;
- excessive document density;
- page-budget risk that can be corrected without dropping required facts.

## Visual preflight

Render the PDF to page images and check:

- configured page limit;
- overflow or clipped text;
- orphan section headings;
- single bullet or heading stranded on a page;
- nearly empty final page;
- excessive whitespace;
- overly dense sections;
- inconsistent margins or date alignment;
- missing glyphs or font substitution;
- broken links.

Deterministic layout checks are blockers where objective. Subjective appearance remains part of exact-revision human review. JobOS should preview the final PDF or provide its local path before approval.

## Readiness changes

A resume is `ready-for-review` only when:

```text
semantic validation passed
AND canonical source revision is current
AND required sections are complete
AND no unsupported claims exist
AND at least one important requirement has verified support
AND requested render validation passed
```

New blocker codes:

- `resume_source_missing`;
- `resume_source_incomplete`;
- `resume_source_unverified`;
- `resume_document_incomplete`;
- `resume_unsupported_claim`;
- `resume_unsupported_metric`;
- `resume_stale_source_revision`;
- `resume_critical_requirements_uncovered`;
- `resume_render_failed`;
- `resume_render_text_invalid`;
- `resume_page_budget_exceeded`.

The current `grounded = cited.length > 0` check is retained only as low-level evidence information; it is no longer sufficient for review readiness.

Approving an exact current revision remains a trusted CLI/TUI human action. A new canonical resume revision or tailored artifact revision invalidates older approval currency through the existing artifact and packet rules.

## CLI contract

Proposed commands:

```text
jobos resume import --profile <id> --file <path> --json
jobos resume show --profile <id> [--revision <n>] --json
jobos resume validate --profile <id> --json
jobos resume replace --profile <id> --file <structured-json-or-yaml> --json
jobos proof verify <proof-id> --json
jobos proof retire <proof-id> --reason <text> --json
jobos tailor resume --job <id> --profile <id> [--layout professional|technical|leadership] [--page-size letter|a4] [--page-limit 1|2] [--format markdown|pdf] --json
jobos resume preflight --artifact <id> --json
```

`tailor resume --json` returns:

- artifact and revision identifiers;
- source canonical resume revision;
- content and PDF paths where applicable;
- coverage summary;
- validation status, blockers, and warnings;
- layout profile;
- render manifest;
- explicit `submissionPerformed: false`.

## Workspace mirror

```text
jobos-workspace/profiles/<profile-id>/resume/
  current.yaml
  revisions/<revision>.yaml

jobos-workspace/jobs/<job-id>/artifacts/
  resume-tailored.md
  resume-tailored.pdf
  resume-tailored.coverage.yaml
  resume-tailored.validation.yaml
  resume-tailored.render.yaml
```

SQLite remains canonical. Mirrors are projections and retain stable IDs and source references.

## Implementation phases

### Phase 1 — Canonical source record

Changes:

- add resume revision schema and migration;
- implement complete semantic import with preserved unknown sections;
- expose inspect/replace/validate commands;
- add proof verification, supersession, and retirement;
- update profile workspace projection.

Acceptance:

- a complete fixture round-trips identity, chronology, education, skills, credentials, projects, and unknown sections;
- uncertain parsing is visible and correctable;
- retiring a proof preserves history and excludes it from new tailoring;
- modifying the source creates a new revision rather than rewriting history.

### Phase 2 — Requirements and mini ATS

Changes:

- replace regex-only requirements with structured extraction;
- persist exact source text and typed requirements;
- implement requirement-to-proof coverage;
- expose transparent matched, partial, omitted-supported, and unsupported output.

Acceptance:

- every extracted requirement is traceable to job text;
- every supported classification cites existing active evidence;
- unsupported requirements never become generated candidate claims;
- coverage output is deterministic for fixtures without an LLM.

### Phase 3 — Complete semantic tailoring

Changes:

- replace outline construction with canonical-resume transformation;
- add typed LLM transformation schema;
- preserve fixed factual fields;
- implement deterministic complete tailoring;
- persist semantic snapshot, coverage, and validation.

Acceptance:

- deterministic and LLM paths both produce normal complete resumes;
- contact information, employers, titles, dates, education, and credentials remain intact;
- invented metrics, employers, dates, or credentials fail validation;
- proof annotations remain outside the submitted document;
- a one-proof worksheet cannot become reviewable.

### Phase 4 — LaTeX rendering and visual system

Changes:

- implement `jobos-classic` LaTeX template;
- add professional, technical, and leadership layout profiles;
- add safe escaping and bounded renderer execution;
- produce PDF, extracted text, page images, and render manifest.

Acceptance:

- Letter and A4 PDFs render deterministically;
- all expected semantic text is extractable in order;
- no template receives arbitrary LaTeX from a model or user field;
- technical and leadership profiles change emphasis without changing facts;
- generated PDFs meet typography, spacing, alignment, and page-budget requirements.

### Phase 5 — Readiness and workflow integration

Changes:

- require semantic and requested render validation for readiness;
- surface blocker-specific next actions in CLI/TUI;
- preserve artifact review, diff, packet, and receipt semantics;
- update the smoke scenario to use a complete source resume and rendered output when TeX is configured.

Acceptance:

- incomplete, stale, unsupported, or failed-render resumes cannot reach `ready-for-review`;
- an approved valid resume freezes into the existing immutable packet unchanged;
- a source or tailored revision makes prior approval/packet currency visibly stale;
- successful CLI output remains parseable and local-first.

### Phase 6 — Outcome feedback after sufficient data

Changes:

- aggregate recurring unsupported requirements;
- compare requirement coverage bands with observed recruiter/interview outcomes only when sample size is sufficient;
- recommend proof and profile improvements without claiming causation.

Acceptance:

- reports expose sample size and uncertainty;
- no automated résumé claim is created from outcome analytics;
- feedback links to source jobs, requirements, artifacts, and proof gaps.

## Test strategy

Add complete behavioral fixtures rather than source-text assertions.

### Canonical model

- full resume import and exact section preservation;
- uncertain dates and unknown sections;
- correction revision lineage;
- proof verification, supersession, and retirement.

### ATS analyzer

- must versus preferred classification;
- supported, partial, and unsupported coverage;
- omitted-but-supported evidence;
- no keyword recommendation without active proof.

### Tailoring

- deterministic complete resume;
- grounded LLM rewriting;
- rejection of invented `$10M`, credentials, employers, titles, dates, and skills;
- stable chronology and section preservation;
- role-family section emphasis;
- cross-profile isolation.

### Rendering

- escaping of LaTeX-special characters and URLs;
- deterministic PDF hash under pinned tool/template versions where practical;
- Letter and A4 page geometry;
- page-limit overflow;
- extracted-text completeness and order;
- missing engine and renderer timeout errors;
- no shell injection through resume content.

### Readiness and packets

- one-proof outline blocked as incomplete;
- stale canonical revision blocked;
- invalid render blocked when PDF is requested;
- valid artifact review and approval;
- existing packet hash, attestation, and receipt invariants preserved.

## Definition of done

The tailored-resume problem is fixed when:

1. A complete source resume becomes a correctable, versioned semantic record.
2. Every important job requirement has an honest evidence classification.
3. The deterministic path produces a complete usable resume.
4. LLM rewriting is constrained to active stored proof and source IDs.
5. Unsupported facts and metrics are blocked before review.
6. Job-specific layout changes emphasis without changing facts.
7. LaTeX produces an ATS-readable, visually polished PDF from typed data.
8. Machine extraction and visual preflight validate the final rendered document.
9. A one-proof worksheet cannot reach review readiness.
10. Exact-revision human approval, packet hashing, and local-first operation remain intact.

## Recommended execution decision

Use this repository plan as the durable implementation contract, then implement against it in the repository. Do not rely on a standalone copy/paste prompt as the primary specification: prompts lose decisions, acceptance criteria, and change history. A fresh implementation session can be started with a short instruction to read this file, the two audits, and `AGENTS.md`, then execute the phases in order.
