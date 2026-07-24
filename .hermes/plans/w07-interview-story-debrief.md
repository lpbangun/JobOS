# W07 — Verified interview story bank and debrief loop

## Context and required outcome

Implement the W07 P1 contract from `docs/JOBOS_CAPABILITY_PARITY_MASTER_PLAN.md` and `docs/JOBOS_WORKTREE_EXECUTION_BOARD.md` against the schema-13 integrated tree at `e331217`.

W07 owns persistent profile-scoped STAR+Reflection story meaning, proof links, sourced/inferred interview questions, deterministic audience packs and coverage gaps, and append-only application/interview-stage debriefs. It must reuse W01 proof truth, publish the exact W06 lifecycle input, and expose attributed observations for W08 without taking over either consumer's policy.

The end-to-end result is:

1. A user creates and revises one canonical story identity. Every factual STAR field cites profile-owned proof points. Only a human-confirmed revision whose cited proofs are currently active and verified can become verified.
2. The same verified story revision can be selected in packs for multiple applications. Each pack persists the canonical story ID, exact story revision ID, proof snapshots, question provenance, match score, and gap state.
3. Recruiter, hiring-manager, peer/panel, executive, and unknown audiences produce distinct deterministic question sets and matching results without a network or LLM.
4. A debrief records only user-observed questions, outcome, used stories, and proof gaps. Corrections append a revision; they do not rewrite the original. The stable debrief identity drives one valid `jobos.lifecycle-event-input.v1` into W06 and a versioned attributed observation into W08.
5. Existing `interview prep` callers continue to receive a draft `interview_prep` artifact at the same application/stage series and path. Existing artifacts are not rewritten or promoted into verified stories.

## Invariants

- Local SQLite remains canonical; mirrors are projections. No network, LLM, browser, or external action is required.
- Story verification is a trusted human action. Agent-authored fields may remain draft, but cannot verify until each required field is explicitly confirmed.
- Story matching uses only revisions backed by proof points that are still `status='active'` and `verification_status='verified'` for the same profile.
- W01 proof rows and lifecycle remain unchanged. A proof retirement or supersession makes a formerly verified story ineligible for new packs without deleting story history.
- Story and debrief identities are stable. Revisions, corrections, proof snapshots, pack links, and observation history are append-only.
- Profile, job, application, story, revision, and proof ownership is checked before any write. A cross-profile reference fails before a row, audit event, task, or mirror is produced.
- W07 supplies W06's accepted event; it does not calculate due dates, create a parallel task type, or interpret task policy.
- W07 supplies W08 attributed observations; it does not infer preferences, confidence, causality, coaching rules, or activate guidance.
- Generated packs remain `draft_needs_human_review`. Story verification is separate from artifact approval.
- Validation errors are typed, clear, non-zero in CLI use, and JSON-safe.

## Current architecture and gaps

### Reusable seams

- `src/interview.js::prepInterview` already resolves an application to its job/profile, collects company/stakeholder context, creates a versioned `interview_prep` artifact, and writes the established `jobs/<jobId>/artifacts/interview-prep-<stage>.md` mirror.
- `src/artifacts.js` already supplies immutable artifact revisions, application/stage series keys (`interview_prep:<applicationId>:<stage>`), exact content hashes, human review state, a transaction callback for related rows, and post-commit mirror/audit projection.
- W01 publishes `activeVerifiedProofs`, proof lifecycle fields, structured requirement inventories, and deterministic requirement coverage. Imported resume proofs are deliberately unverified until explicit verification.
- W06 publishes `LIFECYCLE_EVENT_INPUT_SCHEMA`, accepts `interview_debrief_recorded`, validates profile/application ownership and RFC3339 time, requires lifecycle trigger `stage='interview'`, and reconciles the current task without storing debrief content.
- W06's debrief policy is already protected by `W06-ACTION-04`: for an application whose lifecycle status is `interview`, the event creates `follow-up-after-interview`, remains anchored across note events, and is superseded on a real stage change.
- `src/outreach-outcomes.js` supplies the local append-only/correctable observation pattern: stable schemas, strict ownership, reference-id idempotency, correction lineage, no causal claims, YAML mirrors, and attributed list projections.
- `src/domain-tools.js` is the shared CLI/TUI/MCP execution seam. `src/mcp.js` derives its catalog from `DOMAIN_TOOLS` and has an explicit human-gated deny list. ACP launches that MCP server, so it inherits the same catalog and policy.
- The TUI already reaches `interview_prep` through `:prep`, reviews the resulting artifact, exposes interview-stage jobs, and builds all selected-profile state through `buildTuiModel`.
- `guardedWrite`, named-column inserts, queued post-commit projections, schema-version metadata, and idempotent `CREATE ... IF NOT EXISTS` migrations are established persistence conventions.

### Gaps to close

- Interview prep is artifact-only. There is no story identity, story revision, proof-per-field evidence map, story verification/retirement state, canonical reuse record, debrief, or W08 observation.
- Current prep reads every profile proof, including retired and unverified rows. Its fallback creates STAR-shaped rehearsal placeholders per application; configured LLM output can influence questions and story selection. Neither path is a persistent verified story bank.
- `stage` is a loose string and a regex proxy for audience. There is no audience enum, explicit unknown behavior, stable template ID, question provenance label, persisted match score, or machine-readable gap.
- No explicit sourced interview-question intake exists. Observed debrief questions cannot feed later preparation.
- Current artifact `evidence_json` contains proof summaries but not a canonical story/revision link or a relational question-to-story match ledger.
- No debrief writer emits W06 input. W06 lifecycle observations intentionally contain status/receipt truth only, so W07 must publish its own observation projection rather than injecting story/debrief semantics there.
- CLI/domain/MCP expose only `interview_prep`. TUI has only `:prep` and artifact review. Workspace mirrors have only generated prep Markdown.
- Database schema 13 has no W07 tables or migration fixture.

## Frozen W07 domain contracts

### Schema constants

Publish from `src/interview.js`:

- `INTERVIEW_STORY_SCHEMA = 'jobos.interview-story.v1'`
- `INTERVIEW_STORY_LIST_SCHEMA = 'jobos.interview-story-list.v1'`
- `INTERVIEW_QUESTION_SCHEMA = 'jobos.interview-question.v1'`
- `INTERVIEW_PACK_SCHEMA = 'jobos.interview-pack.v1'`
- `INTERVIEW_DEBRIEF_SCHEMA = 'jobos.interview-debrief.v1'`
- `INTERVIEW_DEBRIEF_LIST_SCHEMA = 'jobos.interview-debrief-list.v1'`
- `INTERVIEW_OBSERVATION_SCHEMA = 'jobos.interview-observation.v1'`
- `INTERVIEW_OBSERVATION_LIST_SCHEMA = 'jobos.interview-observation-list.v1'`

Allowed audiences are exactly:

- `recruiter`
- `hiring_manager`
- `peer_panel`
- `executive`
- `unknown`

Preserve the existing prep stages exactly: `recruiter-screen`, `interview`, `hiring-manager`, `onsite`, `final`, and `offer`. Default audience mapping is deterministic:

| Stage | Default audience |
|---|---|
| `recruiter-screen` | `recruiter` |
| `hiring-manager` | `hiring_manager` |
| `onsite` | `peer_panel` |
| `final` | `executive` |
| `interview`, `offer` | `unknown` |

An explicit valid audience overrides the default. Invalid stages/audiences are validation errors; do not silently slug arbitrary input.

### Database schema 14

Bump `meta.schema_version` from `13` to `14`. Add these seven tables to the base schema and idempotent migration path.

#### `interview_stories`

Immutable canonical identity:

- `id TEXT PRIMARY KEY`
- `profile_id TEXT NOT NULL REFERENCES profiles(id)`
- `created_at TEXT NOT NULL`

Do not store a mutable current pointer. Current/latest verified state is derived from ordered revisions.

#### `interview_story_revisions`

Append-only content and lifecycle:

- `id TEXT PRIMARY KEY`
- `story_id TEXT NOT NULL REFERENCES interview_stories(id)`
- `profile_id TEXT NOT NULL REFERENCES profiles(id)`
- `revision INTEGER NOT NULL CHECK(revision > 0)`
- `state TEXT NOT NULL CHECK(state IN ('draft_needs_verification','verified','retired'))`
- `change_kind TEXT NOT NULL CHECK(change_kind IN ('create','edit','verify','retire'))`
- `title`, `situation`, `task`, `action`, `result`, `reflection` as non-null text
- `competency_tags_json`, `audience_tags_json`, `field_provenance_json`, `confirmed_fields_json` as non-null JSON text
- `content_hash TEXT NOT NULL`
- `supersedes_revision_id TEXT REFERENCES interview_story_revisions(id)`
- `change_reason TEXT NOT NULL DEFAULT ''`
- `actor TEXT NOT NULL`, `source TEXT NOT NULL`, `created_at TEXT NOT NULL`, `verified_at TEXT`
- `UNIQUE(story_id, revision)` and `UNIQUE(id, story_id, profile_id)`

`field_provenance_json` contains all six content fields with `{origin:'user'|'agent', actor, source, sourceRef|null}`. `confirmed_fields_json` records explicit human confirmation and never implies proof support.

Revision rules:

- Create and edit append `draft_needs_verification`.
- Verify appends a new `verified` revision that copies the selected draft's content/evidence and names it in `supersedes_revision_id`; it never updates the draft.
- Retire appends a `retired` revision with a required reason. A retired latest revision excludes the story from matching; history remains inspectable.
- If a verified story has a newer draft, matching may continue to use its latest verified revision until the draft verifies or the story retires.

#### `interview_story_field_evidence`

Immutable field-to-proof provenance per revision:

- `revision_id`, `story_id`, `profile_id`, `field_name`, `proof_point_id`, `position`
- `proof_snapshot_json TEXT NOT NULL`
- `linked_at TEXT NOT NULL`
- primary key `(revision_id, field_name, proof_point_id)`
- foreign key `(revision_id, story_id, profile_id)` to the revision identity
- foreign keys to `interview_stories`, `profiles`, and `proof_points`
- `field_name` is limited to `situation`, `task`, `action`, and `result`

The snapshot freezes proof ID, summary, evidence, skills, metrics, source, status, verification status, source resume entry ID, superseded-proof ID, and `updated_at` as observed by that revision. Application validation—not a new proof schema—enforces that every referenced proof belongs to the same profile.

Verification requires all six content fields non-empty; every factual STAR field has at least one evidence row; every linked proof is still same-profile, active, and verified; and all six fields are user-authored or explicitly human-confirmed. Reflection is user-authored/confirmed but is not forced to cite a factual proof. This is the structural boundary for “unsupported content cannot become verified.”

#### `interview_question_sources`

Append-only explicit sourced question records:

- `id TEXT PRIMARY KEY`
- `profile_id`, `job_id`, `application_id` as non-null ownership columns
- `interview_stage`, `audience`, `question_text`, `normalized_text`
- `source_kind` limited to `user_provided`, `recruiter_provided`, `interviewer_provided`
- `source_ref TEXT NOT NULL DEFAULT ''`, `actor`, `source`, `created_at`
- `supersedes_source_id`, `correction_reason`
- partial unique root-reference index:
  `CREATE UNIQUE INDEX interview_question_sources_root_reference_idx ON interview_question_sources(profile_id,source_ref) WHERE source_ref != '' AND supersedes_source_id IS NULL`
- branch-prevention index:
  `CREATE UNIQUE INDEX interview_question_sources_one_correction_idx ON interview_question_sources(supersedes_source_id) WHERE supersedes_source_id IS NOT NULL`
- resolution index:
  `CREATE INDEX interview_question_sources_reference_chain_idx ON interview_question_sources(profile_id,source_ref,created_at,id) WHERE source_ref != ''`
- foreign keys to profile/job/application and the superseded question source

Recruiter/interviewer sources require a non-empty reference. `user_provided` questions use actor/source attribution. A correction reuses its root row's non-empty `source_ref`, must supersede the current chain tip, must preserve profile/job/application/stage/audience/source kind, and requires a non-empty reason. The branch-prevention index permits only one direct successor, while write validation rejects a successor to a non-tip; current resolution follows the root's latest-only chain and chooses the unique tip. Debrief-observed questions remain in debrief revisions and are merged into later packs as sourced questions with debrief/revision provenance; do not duplicate them into this table.

#### `interview_pack_items`

Immutable machine-readable provenance for each created prep artifact:

- `artifact_id REFERENCES artifacts(id)` and `position`
- `profile_id`, `job_id`, `application_id`, `interview_stage`, `audience`
- `question_id`, `question_origin CHECK IN ('sourced','inferred')`, `question_text`, `question_source_json`
- `coverage_status CHECK IN ('covered','gap')`
- nullable `story_id`, `story_revision_id`
- `match_score INTEGER NOT NULL`, `match_reasons_json`, `alternative_matches_json`
- primary key `(artifact_id, position)` and unique `(artifact_id, question_id)`

Covered rows must name a story and exact verified revision; gap rows must not. `createArtifact(s,{...,mutate(s,artifact)})` inserts these rows in the artifact transaction. Artifact `evidence_json` contains the same IDs/snapshots for agent-readable compatibility, while this table is canonical for reuse/provenance queries.

#### `interview_debriefs`

Immutable debrief identity:

- `id TEXT PRIMARY KEY`
- `profile_id`, `job_id`, `application_id` as non-null ownership columns
- `interview_stage`, `audience`
- `reference_id TEXT NOT NULL DEFAULT ''`
- `created_at TEXT NOT NULL`
- partial unique reference index:
  `CREATE UNIQUE INDEX interview_debriefs_profile_reference_idx ON interview_debriefs(profile_id,reference_id) WHERE reference_id != ''`
- foreign keys to profile/job/application
- `UNIQUE(id, profile_id)` supplies the composite parent key for revision ownership

The stable debrief ID is the W06 `eventId`; corrections do not create a different lifecycle identity.

#### `interview_debrief_revisions`

Append-only observation/correction payload:

- `id TEXT PRIMARY KEY`, `debrief_id TEXT NOT NULL`, `profile_id TEXT NOT NULL`, `revision INTEGER CHECK(revision > 0)`
- `occurred_at`, `recorded_at`, `actor`, `source`
- `observed_questions_json`, `observed_outcome_json`, `proof_gaps_json`, `story_uses_json`, `notes`
- `field_provenance_json`, `content_hash`
- `supersedes_revision_id`, `correction_reason`
- `UNIQUE(debrief_id, revision)` and `UNIQUE(id, debrief_id, profile_id)`
- composite foreign key `(debrief_id, profile_id)` to `interview_debriefs(id, profile_id)`, plus foreign keys to profile and superseded revision

Payload shapes are versioned by `INTERVIEW_DEBRIEF_SCHEMA`:

- questions: `{id, text, askedByAudience, source:'user_observed'}` where `id` is exactly `debrief.<debriefId>.<revision>.<questionIndex>` and `questionIndex` is zero-based
- outcome: `{type:'advanced'|'no_change'|'rejected'|'withdrawn'|'unknown', note}`
- proof gaps: `{id, type:'missing_proof'|'weak_metric'|'unsupported_detail'|'needs_verification'|'other', text, questionId|null, storyId|null, proofPointId|null}`
- story uses: `{storyId, storyRevisionId, questionId|null, adaptationNote}`

All referenced story revisions and proof points are validated against exact ownership. Notes/adaptation text is user-authored observation, not proof verification or causal attribution. A correction must target the latest revision, stay in the same debrief/profile/application/stage, and include a reason.

For a non-empty debrief `reference_id`, exact replay returns the existing debrief, current revision, and existing W06 action. It does not rerun reconciliation or add a revision, audit event, or mirror write. A different payload for that reference is a conflict.

### Story projection

`jobos.interview-story.v1` returns:

- stable `id`, `profileId`, `createdAt`
- `currentRevision` (latest append-only revision)
- `activeVerifiedRevision` (latest verified revision unless latest state is retired)
- `eligibility`: `draft_only`, `eligible`, `proof_stale`, or `retired`
- exact `staleProofPointIds` and `verificationBlockers`
- full requested revision history only for `show`; list output omits long content but retains IDs/state/timestamps/tags

Proof retirement is evaluated at read/match time. Never mutate an old story revision in response to a W01 proof change.

### Deterministic questions and matching

The pack question list is deterministic and ordered:

1. Current explicit `interview_question_sources` for the exact application/stage/audience.
2. Current debrief-observed questions for the same profile and compatible audience, labeled `sourced` with the exact zero-based ID `debrief.<debriefId>.<revision>.<questionIndex>` and debrief/revision provenance.
3. Inferred audience templates in frozen template order.
4. Inferred requirement-example questions in job requirement source order/ID order.

Deduplicate by normalized question text, keeping the earliest and strongest provenance. Every question projection includes `schema`, stable `id`, `origin:'sourced'|'inferred'`, `text`, `stage`, `audience`, and `source`.

Freeze these template IDs so tests do not depend on array accidents:

- `recruiter.motivation`, `recruiter.scope`
- `manager.ownership`, `manager.tradeoff`
- `panel.collaboration`, `panel.conflict`
- `executive.strategy`, `executive.influence`
- `unknown.impact`, `unknown.learning`
- `requirement.<requirementId>.example`; because requirement IDs already have the form `requirement_<hash>`, the concrete ID is `requirement.requirement_<hash>.example`

Only eligible story revisions are candidates. Normalize with the existing `tokenize` rules. For each question/story pair calculate:

- `4 * min(2, competencyTagOverlap)`
- `2 * min(3, linkedProofSkillOverlap)`
- `min(4, otherStoryTokenOverlap)`
- `2` if the story explicitly tags the audience

A score of at least `3` is covered. Sort candidates by score descending, then story ID and revision ID ascending. Persist the first as the selected match and at most two remaining qualifying matches as alternatives. Lower scores produce an explicit gap with reason codes such as `no_verified_story`, `proof_stale`, or `insufficient_overlap`; never synthesize a story to fill a gap.

`jobos.interview-pack.v1` contains profile/job/application IDs, stage, audience, artifact ID/revision, ordered questions, covered/gap counts, selected canonical story/revision IDs, alternatives, match reasons, and `deterministic:true`. LLM output cannot add, remove, relabel, or reorder questions/matches. The recommended cutover is to remove the current LLM-authored STAR path; company refresh and questions-to-ask remain deterministic/source-backed.

### Debrief → W06 contract

Inside the same `guardedWrite` as a new debrief identity/revision, call:

```js
reconcileApplicationNextAction(s, {
  applicationId,
  trigger: {
    schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
    profileId,
    applicationId,
    eventId: debriefId,
    eventType: 'interview_debrief_recorded',
    occurredAt,
    stage: 'interview'
  },
  nowDate: new Date(occurredAt)
})
```

`interview_stage` remains W07's round label. Trigger `stage='interview'` is the existing W06 lifecycle-contract discriminator; do not overload it with `hiring-manager`/audience values. Acceptance uses an application whose lifecycle status is `interview`, so W06 produces `follow-up-after-interview`. Corrections reuse the stable debrief ID, allowing W06's deterministic task identity and manual-reschedule preservation to remain intact while policy timestamps can reconcile.

Return the validated trigger and W06 action projection in the debrief write result, but do not store task semantics in W07 tables.

### Debrief → W08 observation contract

`jobos.interview-observation.v1` is a projection of one debrief revision:

- `id: <debriefId>:<revision>` and stable `debriefId`
- `profileId`, `jobId`, `applicationId`, `interviewStage`, `audience`
- `sourceEntity: {type:'interview_debrief', id:debriefId, versionId:revisionId, revision, supersedesVersionId}`
- `occurredAt`, `recordedAt`, `actor`, `source`, `current`
- copied observed questions/outcome/proof gaps/story uses
- `interpretation:'attributed_observation_only_no_preference_or_causal_claim'`
- `externalSideEffects:'none'`

The list schema returns profile, period, observation schema, ordered observations, and correction history. It never returns a preference, recommendation, confidence score, inferred reason, or activation state. W08 may cite this source entity later; W07 does not write W08-owned records.

## Strict-TDD implementation phases

### Phase 1 — Freeze schema-13 migration and ownership boundaries

1. Before changing persistence, generate `tests/fixtures/w07-schema13.sqlite` from the current schema-13 store. Seed two profiles; active/retired/unverified/superseded proof rows; two jobs/applications; status history; one W02 packet/receipt; one W05 outcome/correction; W06 current/manual actions; and one current plus one historical `interview_prep` artifact. The checked fixture contains no W07 tables.
2. Add failing `W07-MIGRATE-01`, `W07-MIGRATE-02`, and `W07-ISO-01` tests in `tests/w07-interview-story-debrief.test.js`. Require schema 14, all seven tables/indexes/FKs, `PRAGMA foreign_key_check=[]`, byte-stable protected W01/W02/W05/W06/artifact rows, no inferred story backfill, and byte/count stability after close/reopen.
3. Add the seven tables/indexes to `src/db.js` base schema and idempotent migration list; bump schema version to 14. Do not rebuild a protected table or add W07 columns to W01/W06 tables.
4. Add `InterviewError` with `type='validation'`, stable error codes, required-text/RFC3339/enum/JSON-shape helpers, and one shared ownership resolver in `src/interview.js`. It validates profile → job → application before story/proof references and performs no writes on failure.

Red/green command:

```bash
node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js --test-name-pattern='W07-(MIGRATE|ISO)'
```

### Phase 2 — Implement the verified story lifecycle

1. Add failing `W07-STORY-01` through `W07-STORY-05` cases:
   - create one canonical identity plus draft revision/evidence snapshots;
   - reject cross-profile proofs before writes;
   - reject verification for empty fields, missing field evidence, agent fields lacking confirmation, unverified/retired/rejected proofs, and stale/non-latest draft targets;
   - verify by appending a revision and preserve the draft;
   - edit by appending a new draft while the previous verified revision remains eligible;
   - retire by appending a reasoned revision and preserve every prior revision;
   - retire/supersede a W01 proof after verification and require `proof_stale` exclusion from matching without mutating story rows.
2. Implement `createInterviewStory`, `editInterviewStory`, `verifyInterviewStory`, `retireInterviewStory`, `getInterviewStory`, and `listInterviewStories` in `src/interview.js`. All writes use one synchronous `guardedWrite`, named columns, record-audit plus queued projection, deterministic IDs/content hashes, and exact revision ordering.
3. Verification is callable only with trusted `source:'cli'|'tui'`. Domain/MCP policy enforcement is added in Phase 5, but the core function also rejects agent sources so a direct caller cannot bypass the gate.
4. Add profile story mirror projection now: `jobos-workspace/profiles/<profileId>/interviews/stories.yaml` with schema/version, append-only policy, current/verified revision IDs, eligibility, stale proofs, field evidence snapshots, and full history.

Red/green command:

```bash
node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js --test-name-pattern='W07-STORY'
```

### Phase 3 — Implement sourced questions, deterministic matching, and compatible packs

1. Add failing `W07-QUESTION-01`, `W07-PACK-01`, `W07-MATCH-01`, `W07-REUSE-01`, and `W07-PREP-COMPAT-01` cases:
   - explicit questions keep source kind/ref and corrections; root non-empty references satisfy the partial unique index, corrections reuse that reference through a reasoned latest-only branchless chain, and current resolution selects the unique tip; inferred questions never claim a source;
   - five audiences have distinct stable template IDs/text, including explicit unknown behavior;
   - identical calls return identical question order, scores, reasons, selected story IDs, and gaps;
   - ineligible/stale stories cannot cover questions;
   - one verified story ID/revision appears in two applications' pack rows/artifact evidence without cloning a story;
   - existing command result keys, artifact type/path/series/revision/review status, company/stakeholder refresh, prior artifact readability, and the exact Markdown substrings `STAR story`, `Questions to ask the interviewer`, `did not contact the company`, a `proof_` ID, and one of `Role-specific`/`Likely interview questions` remain intact;
   - new labels and gaps are additive; existing smoke and Sprint 4 assertions remain unchanged unless behavior genuinely requires an explicit reviewed test update;
   - a profile with only excluded legacy proofs receives an explicit gap/excluded-proof warning, not a fabricated story, while the compatibility Markdown still identifies the relevant proof IDs and STAR section.
2. Implement sourced-question add/list and current-row resolution. Create root/correction/reference-chain indexes exactly as frozen above. Validate exact application ownership and stage/audience before insertion; require corrections to reuse the root reference, target the unique current tip, preserve immutable ownership/source fields, and include a reason.
3. Implement pure deterministic `questionsForInterview`, `matchInterviewStories`, and `buildInterviewPack` helpers using the frozen algorithm. Unit tests call the pure matcher with fixed rows and adversarial ties.
4. Refactor `prepInterview(s, applicationId, stage='interview', options={})` to preserve its existing positional contract while accepting `{audience}`. Use only eligible verified story revisions for coverage. Keep research/company/stakeholder sections and questions-to-ask; remove LLM authority over story/question selection.
5. Insert `interview_pack_items` through `createArtifact(s,{...,mutate(s,artifact)})`. Return the legacy artifact projection plus `pack`; render labels `[sourced]`/`[inferred]`, exact story/revision/proof IDs, coverage reasons, and a dedicated gaps section.
6. Project current sourced questions to `jobos-workspace/jobs/<jobId>/interviews/questions.yaml`. Existing pack Markdown stays at the established artifact path.

Red/green command:

```bash
node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js tests/sprint4-interview-analytics-mcp.test.js --test-name-pattern='W07-(QUESTION|PACK|MATCH|REUSE|PREP)|interview prep'
```

### Phase 4 — Implement debrief revisions and W06/W08 handoffs

1. Add failing `W07-DEBRIEF-01` through `W07-DEBRIEF-04`:
   - record an application/stage/audience-bound debrief with attributed observed questions/outcome/proof gaps/story uses;
   - reject wrong-profile application/story/proof links, future/invalid time, missing user provenance, unsupported enums, and duplicate conflicting references before any write/task/audit/mirror;
   - exact reference replay returns the existing debrief/current revision/action without rerunning W06 reconciliation or adding a revision, audit event, or mirror write; conflicting replay fails;
   - correction appends revision 2 with a required reason, keeps identity/ownership, and leaves revision 1 unchanged;
   - debrief record/correction emits the exact W06 input and yields one W06 `follow-up-after-interview`; correction reuses event identity and does not duplicate an open action or erase a manual reschedule;
   - W08 list exposes attributed current/history observations and no inferred preference/causal/guidance fields.
2. Implement `recordInterviewDebrief`, `correctInterviewDebrief`, `getInterviewDebrief`, `listInterviewDebriefs`, and `listInterviewObservations`. Run W06 reconciliation inside the same guarded transaction, then queue audit/mirror projection.
3. Add the W07 observation source to no W06 table and no generic memory table. W06 remains the sole task policy owner; W08 remains the future interpretation owner.
4. Project `jobos-workspace/jobs/<jobId>/interviews/debriefs.yaml` with full revisions and `jobos-workspace/profiles/<profileId>/interviews/observations.yaml` with the W08-safe list.
5. Extend the selected job's `job.yaml`/`application.yaml` mirror through `src/jobs.js::syncJob` with links/counts only: latest prep artifact ID, covered/gap counts, latest debrief ID/revision, and current W06 action. Do not copy private notes into job summary files.

Red/green command:

```bash
node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js tests/w06-lifecycle-next-actions.test.js --test-name-pattern='W07-DEBRIEF|W06-ACTION-04|W06-ACTION-06|W06-HANDOFF'
```

### Phase 5 — Route CLI, domain, MCP/ACP, and workspace surfaces

1. Add failing `W07-CLI-01`, `W07-DOMAIN-01`, `W07-POLICY-01`, and `W07-MIRROR-01` cases, including JSON success/error shapes, non-zero validation exits, required flags, cross-profile rejection, catalog presence/absence, source attribution, and mirror regeneration after reopen/correction.
2. Add CLI commands to `src/cli.js`:

```text
jobos interview stories create --profile <id> --file <story.json> --json
jobos interview stories edit <story-id> --profile <id> --file <story.json> --json
jobos interview stories verify <story-id> --profile <id> --revision <n> --confirm-fields <csv> --json
jobos interview stories retire <story-id> --profile <id> --reason <text> --json
jobos interview stories list --profile <id> [--history] --json
jobos interview stories show <story-id> --profile <id> [--revision <n>] --json
jobos interview questions add --profile <id> --application <id> --file <question.json> --json
jobos interview questions list --profile <id> --application <id> [--stage <stage>] [--audience <audience>] --json
jobos interview prep --application <id> --stage <stage> [--audience <audience>] [--output markdown] --json
jobos interview debrief record --profile <id> --application <id> --file <debrief.json> --json
jobos interview debrief correct <debrief-id> --profile <id> --file <debrief.json> --reason <text> --json
jobos interview debriefs --profile <id> [--application <id>] [--history] --json
jobos interview observations --profile <id> [--since <days>] --json
```

The structured files use the v1 shapes above, avoiding lossy comma/repeated-flag parsing. Preserve existing prep positional API and output modes.

3. Add domain tools: `list_interview_stories`, `get_interview_story`, `draft_interview_story`, `verify_interview_story`, `retire_interview_story`, `add_interview_question_source`, existing `interview_prep` with optional audience, `record_interview_debrief`, `correct_interview_debrief`, `list_interview_debriefs`, and `list_interview_observations`.
4. MCP/ACP may expose read-only story/debrief/observation tools, `draft_interview_story`, and `interview_prep`. Add verify, retire, sourced-question write, debrief record, and debrief correction to both `MCP_DENY` and `enforcePolicy` with stable human-input error codes. The duplicated catalog and runtime gate are intentional defense in depth. ACP needs no separate tool registry change because it launches the MCP catalog; add an ACP/catalog assertion.
5. Queue mirrors only after successful persistence. Reopening/regenerating state must reproduce byte-equivalent YAML for unchanged rows, with stable key order pinned in each projection and asserted by the reopen/regenerate tests.

Red/green command:

```bash
node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js tests/sprint4-interview-analytics-mcp.test.js tests/mcp-framing.test.js tests/tui-acp.test.js
```

### Phase 6 — TUI, end-to-end smoke, and protected regression

1. Add failing `W07-TUI-01` cases in `tests/tui-strip-actions.test.js` (or a focused `tests/tui-interview.test.js` if the file becomes unwieldy): selected-profile isolation, visible verified/stale/story/gap/debrief counts, story/debrief overlay, audience-aware `:prep`, trusted verification/retirement commands, debrief-file record/correction, and no advertised dead key/command.
2. Extend `buildTuiModel` with a selected-profile `interviews` projection and selected-application pack/debrief summary. It must never query profile-less/global story state.
3. Add an `interviews` overlay to `src/tui.js`; keep the primary shell compact. Recommended command-bar surface:

```text
:interviews
:prep <stage> [audience]
:story-verify <story-id> <revision> | <confirmed-fields-csv>
:story-retire <story-id> | <reason>
:debrief <json-file>
:debrief-correct <debrief-id> | <json-file> | <reason>
```

All trusted mutations call domain tools with `source:'tui'`. Agent-pane calls remain MCP-policy constrained.
4. Extend `scripts/smoke.js` after the existing application interview transition: add/verify one proof-grounded story, create two applications/packs that cite the same story identity, assert recruiter and hiring-manager packs differ with labels/gaps, record and correct one debrief, assert one W06 follow-up action and the attributed W08 projection, inspect the workspace mirrors, and assert `externalSideEffects:'none'`.
5. Run targeted files, then the full suite and both existing smoke paths. Do not weaken protected W01/W06 assertions to make W07 pass.

## Acceptance ID map

| Brief scenario | Planned evidence |
|---|---|
| 1. Create/edit/retire/verify; unsupported cannot verify | `W07-STORY-01..05` |
| 2. Canonical story reused across two applications | `W07-REUSE-01`, smoke |
| 3. Five deterministic audience packs | `W07-PACK-01` |
| 4. Sourced/inferred labels, coverage, gaps | `W07-QUESTION-01`, `W07-MATCH-01` |
| 5. Bound append-only/correctable debrief | `W07-DEBRIEF-01..02` |
| 6. Valid W06 input and W08 observation | `W07-DEBRIEF-03..04`, protected W06 handoff tests |
| 7. CLI/domain/MCP/ACP/TUI/mirrors/migration/isolation | `W07-MIGRATE-*`, `W07-ISO-01`, `W07-CLI-01`, `W07-DOMAIN-01`, `W07-POLICY-01`, `W07-TUI-01`, `W07-MIRROR-01` |
| 8. Existing prep and W01/W06 remain green | `W07-PREP-COMPAT-01`, targeted protected tests, full suite/smokes |

## Exact files and surfaces likely to change

### Production

- `src/interview.js` — W07 owner: constants, validation, ownership resolver, story/question/debrief lifecycle, projections, deterministic matching, compatible prep rendering, mirror sync.
- `src/db.js` — seven schema-14 tables/indexes, idempotent migration, version bump only.
- `src/cli.js` — command registry/help/routes/JSON-file parsing for the listed interview commands; preserve existing prep output.
- `src/domain-tools.js` — schemas, handlers, and human-mediation policy for W07 tools.
- `src/mcp.js` — human-only W07 deny entries; catalog remains derived from domain tools.
- `src/tui-model.js` — selected-profile interview summary and selected-job pack/debrief state.
- `src/tui.js` — interview overlay and trusted command-bar flows; existing artifact review remains the prep review path.
- `src/jobs.js` — minimal interview summary links/counts in job/application workspace YAML.
- `scripts/smoke.js` — end-to-end W07 scenario with no external action.

`src/acp.js` should not need production changes: it already launches the same MCP server. `src/workspace.js` should not need changes because `writeYaml`/`writeMd` create nested directories. If implementation discovers a real need, keep it to path plumbing rather than adding a second sync abstraction.

### Tests/fixtures

- New `tests/w07-interview-story-debrief.test.js`
- New `tests/fixtures/w07-schema13.sqlite`
- Existing `tests/sprint4-interview-analytics-mcp.test.js`
- Existing `tests/w06-lifecycle-next-actions.test.js`
- Existing `tests/tailored-resume.test.js`
- Existing `tests/tui-strip-actions.test.js` and/or new focused `tests/tui-interview.test.js`
- Existing `tests/tui-acp.test.js`
- Existing `tests/mcp-framing.test.js` only if catalog/framing assertions share that seam
- Existing smoke script noted above

No roadmap/board edits belong in implementation until behavior and verification are complete; those are conductor-owned status records.

## Dependency and compatibility strategy

### W01

- Consume `activeVerifiedProofs` semantics and existing proof columns; do not alter proof lifecycle or canonical resume schemas.
- Draft story evidence may point at same-profile non-eligible proof for correction workflows, but verification fails until every factual field cites active verified proof.
- Freeze proof snapshots at each story revision while dynamically checking current eligibility. W01 retirement/supersession therefore invalidates future use without erasing historical truth.
- Reuse existing `tokenize` and requirement inventory/order. Do not introduce semantic embeddings or a second proof score.

### Existing interview prep

- Preserve CLI command, domain tool name, positional `prepInterview` signature, artifact type, artifact review status, series key, path, company/stakeholder refresh, questions-to-ask, JSON artifact fields, and old artifact readability.
- Freeze the case-sensitive Markdown substring contracts `STAR story`, `Questions to ask the interviewer`, `did not contact the company`, a `proof_` ID, and one of `Role-specific`/`Likely interview questions`. New labels/gaps are additive. Keep existing smoke and Sprint 4 assertions unchanged unless a genuine behavior change receives an explicit reviewed test update.
- Add optional audience and `pack`; additive callers remain compatible.
- Do not migrate old artifact prose into stories. It lacks field-level user confirmation and exact revision evidence.
- Existing proof-only profiles get explicit excluded-proof/coverage-gap content. They do not silently become verified stories.
- Deterministic W07 data is authoritative. The recommended implementation removes the existing LLM-generated STAR selection path rather than maintaining two conventions.

### W06

- Import and emit the existing schema constant and call the existing reconciliation function; do not clone validators or policy tables.
- W07's `interviewStage` and audience stay in W07. W06 receives literal lifecycle `stage='interview'` as already specified.
- Use stable debrief identity as W06 `eventId`, including corrections, so idempotency/manual schedule behavior is preserved.
- Keep W06 observation lists unchanged. Debrief content remains W07-owned exactly as the handoff says.

### W08

- Publish versioned attributed observations with exact profile/application/job/debrief/revision IDs.
- Include correction history and current markers. Do not collapse corrections or claim that outcomes/preferences are causal.
- Do not create preference proposals, career briefs, voice rules, confidence scores, or retrieval logic in W07.

### MCP/ACP/TUI

- Read and draft operations may be agent-mediated. Human verification, retirement, sourced observations/questions, and debrief correction are trusted CLI/TUI only.
- ACP inherits MCP policy. The TUI agent pane therefore cannot bypass direct TUI human gates.
- All TUI model queries include selected profile and exact application ownership.

## Verification matrix

| Layer | Command/scenario | Required proof |
|---|---|---|
| Migration | `node --test --test-concurrency=1 tests/w07-interview-story-debrief.test.js --test-name-pattern='W07-(MIGRATE|ISO)'` | Schema 13→14, FK clean, protected rows unchanged, reopen stable |
| Story lifecycle | same file, `W07-STORY` | Append-only revisions, field proof/confirmation gates, retirement/stale proof behavior |
| Matching/reuse | same file, `W07-(QUESTION|PACK|MATCH|REUSE|PREP)` | Five audiences, stable ordering/scores, labels/gaps, canonical reuse |
| Debrief/handoffs | W07 + W06 files, `W07-DEBRIEF|W06-ACTION-04|W06-ACTION-06|W06-HANDOFF` | Append-only corrections, exact W06 event/action, W08-safe projection |
| CLI/domain/protocol | W07 + sprint4 + MCP/ACP files | Registry, JSON/error exits, domain schemas, deny policy/catalog |
| TUI | `node --test --test-concurrency=1 tests/tui-strip-actions.test.js tests/tui-interview.test.js tests/tui-acp.test.js` as applicable | Profile isolation, reachable live commands/overlay, policy boundary |
| W01 regression | `node --test --test-concurrency=1 tests/tailored-resume.test.js tests/readiness.test.js tests/apppacket-receipt.test.js` | Proof verification/retirement, coverage, packet truth unchanged |
| Existing prep regression | `node --test --test-concurrency=1 tests/sprint4-interview-analytics-mcp.test.js` | Existing command/artifact behavior compatible |
| Full regression | `npm test` | Entire integrated suite green |
| End-to-end | `npm run smoke` | Story→two packs→debrief→W06/W08→mirrors, no side effects |
| Live-form regression | `npm run smoke:live-form` | W02 configured path remains unaffected |

The direct runtime proof is: create/verify a story from active verified proof; prepare two applications with different audiences and observe the same story ID/revision plus distinct questions/gaps; retire a cited proof and observe the story become ineligible without row loss; repair/reverify it; record/correct a debrief; observe one W06 follow-up action and current/history W08 observations; inspect deterministic local mirrors; observe no external action.

## Parallel child-lane boundaries

Phase 1 must freeze schema, enums, projection shapes, error codes, ownership helpers, and the test fixture, then land as one merged green common skeleton before any child work begins.

The three core lanes all own `src/interview.js`, so run and integrate them serially:

1. **Lane A — story lifecycle:** Phase 2 in `src/interview.js` plus story tests/mirror.
2. **Lane B — questions/matcher/pack:** Phase 3 after Lane A is merged and green.
3. **Lane C — debrief/handoffs:** Phase 4 after Lane B is merged and green.

Do not have A/B/C edit `src/interview.js` concurrently and do not split validators/contracts across child branches.

After the complete core is merged and green, parallelize only genuinely non-overlapping surface lanes:

- **Lane D — CLI/domain/MCP/ACP policy**
- **Lane E — TUI/model**
- **Lane F — workspace/smoke/regression tests**

Assign disjoint files to D/E/F, then integrate their results serially with targeted checks after each merge. Phase 6 final targeted/full verification remains serialized after all surfaces integrate.

## Risks, non-goals, and conductor review

### Risks and controls

- **Proof text cannot be semantically proven by token matching.** Control: verification requires per-field proof mapping plus explicit human authorship/confirmation; matching never upgrades content truth.
- **A proof may retire after story verification.** Control: dynamic eligibility excludes stale stories while frozen snapshots preserve history.
- **Configured LLM behavior currently changes prep prose.** Control: deterministic W07 pack is authoritative; retain only source-backed deterministic refresh/asks and make the cutover explicit in release notes later.
- **Debrief correction could perturb W06 scheduling.** Control: stable debrief identity is the W06 event ID; same-action reconciliation preserves a manual date while updating policy metadata.
- **Circular profile/application references in JSON could leak another profile.** Control: resolve and validate the full ownership chain before child references and before entering any insert loop; tests assert zero row/audit/task deltas.
- **Mirrors can diverge if written inside transactions.** Control: queue projections post-commit and regenerate from SQLite only.
- **A giant TUI editor would crowd the P1 contract.** Control: one read overlay plus structured-file command-bar intake; artifact review remains the pack review UI.

### Non-goals

- Generic coaching curriculum, mock-interview voice rehearsal, speech/video analysis, scoring delivery quality, or interviewer simulation.
- LLM/embedding similarity, cloud sync, telemetry, network research, or external actions.
- Auto-generating or auto-verifying STAR content from proofs/resumes/artifacts.
- W06 due-date/follow-up policy changes or a second task engine.
- W08 preference inference, confidence, proposals, career brief, voice guide, or guidance activation.
- Changing W01 proof/resume truth, upgrading old prep artifacts into stories, or deleting retired/superseded history.
- Inferring that an observed question/story/outcome caused an application result.

### Decisions requiring conductor review

1. **Recommended:** treat W07 `interviewStage` as the round label and send literal W06 trigger `stage='interview'`. This is the only interpretation compatible with the already-frozen W06 validator while supporting recruiter/manager/panel/executive audiences.
2. **Recommended:** remove LLM authority from prep story/question selection. Keeping a second LLM-selected convention would violate deterministic coverage and make gaps non-reproducible. Optional future prose polish must consume, not change, the frozen pack.
3. **Recommended:** require direct CLI/TUI human source for verify/retire/question-source/debrief writes. Agents may draft and read. This follows existing artifact/contact/answer human gates and prevents fabricated observations.
4. **Recommended:** use structured JSON files for story/debrief CLI writes instead of extending the global parser for repeated/nested flags. This keeps schemas exact and avoids unrelated parser risk.

None of these is a planning blocker; they are explicit review points. Dependencies are now installed via `npm ci`, and the protected baseline is 47/47 green. Implementation can begin with the Phase 1 red/green migration slice; this plan-only correction does not rerun tests.
