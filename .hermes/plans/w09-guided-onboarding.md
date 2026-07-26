# W09 — Resumable guided onboarding and setup recovery

## Outcome and authority boundary

W09 adds one guided CLI/TUI journey over the domain flows already shipped in W01, W02, W03, and W08. A clean workspace can reach a trustworthy pursue decision and the existing `materials-ready` readiness state without learning internal IDs or command order. Interrupting the journey loses no completed work: status and the next action are recomputed from canonical state on every open.

W09 does not add an onboarding database, wizard checkpoint table, duplicate profile/source/proof/preference record, required agent, cloud service, API key, browser, or external action. SQLite and existing private provider/browser configuration remain authoritative. Setup output is a read-only projection.

The guided journey is:

1. initialize or reopen the local workspace;
2. create/select the canonical profile;
3. import and validate the canonical resume;
4. verify, correct, replace, retire, or add proof points through W01;
5. configure a canonical public saved search and/or import a user-selected local job;
6. score a current non-expired job and show the existing evidence, uncertainty, legitimacy, and accepted-memory adjustment separately;
7. confirm the pursue decision, run the existing pursuit graph, review exact artifact revisions, and reach W02 `materials-ready`;
8. optionally calibrate with explicit ratings/reasons over canonical jobs, inspect resulting W08 observations/proposals, and explicitly accept or reject proposals;
9. optionally configure an ACP provider and private browser profile, with honest capability/recovery status.

`setup complete` means the required core steps are complete. Optional calibration, provider, browser, and network setup remain visible as `optional_ready`, `optional_incomplete`, `unavailable`, or `misconfigured`; they never block the deterministic core journey.

## Canonical, private external, and derived state

| State | Existing authority | W09 rule |
|---|---|---|
| Workspace/database | `.jobos/jobos.sqlite`, store revision, and existing bootstrap | `init` remains idempotent. W09 reads it and never creates a second workspace marker. |
| Profile and explicit preferences | `profiles` and `profiles.preferences_json` | Create/select through `createProfile`; never copy fields into setup state. |
| Resume and proofs | `profile_resume_revisions`, `proof_points`, proof lifecycle, and W01 validators | Completion derives from the current valid resume plus active verified proofs. Blockers link to existing correction commands. |
| Discovery sources | `saved_searches` and W03 source configuration | Source completion derives from a profile-owned canonical saved search. No wizard-owned source JSON. |
| Jobs, liveness, and fit | `jobs`, posting-liveness evidence, and persisted `fit_scores` | Intake/decision derive from current profile-owned rows. Guidance cannot override expired gates or fit math. |
| Pursuit and materials | workflow stage results, artifacts, exact review state, and `compileApplicationReadiness` | Materials completion is true only when the existing readiness result is `materials-ready` or `form-ready`; W09 does not invent a readiness label. |
| Career Memory | W08 observations, proposals, transitions, projections, and active-rule resolver | Calibration invokes existing trusted-human APIs. Proposal derivation and lifecycle remain W08-owned. |
| Agent/provider | live `agentBackendCatalog`, Hermes/private provider config, and environment | Read-only capability probe. No key, token, model, or auth state is stored in SQLite or mirrors. |
| Browser | `.jobos/browser/` private state and `browserStatus` | Read-only capability/profile probe and existing recovery commands. No browser secret enters setup JSON, audit, or mirror. |
| Guided status | deterministic `jobos.onboarding-status.v1` projection | Never persisted or mirrored. Recomputed after every action and reopen. |

There is no schema migration. Do not modify `src/db.js`, bump `schema_version`, add a setup audit event for a read, or write a setup-status file. Existing canonical mutations retain their existing audits and atomic-save behavior.

## Frozen setup projection

Add `src/onboarding.js` with a pure synchronous canonical projector and an asynchronous capability wrapper:

- `buildOnboardingStatus(s, { profileId = null, jobId = null, asOf })` reads SQLite only and performs no save, audit, mirror, network, subprocess, or capability probe.
- `inspectOnboardingStatus(s, options)` calls the pure projector and, when requested by CLI/TUI, attaches redacted `agentBackendCatalog` and `browserStatus` summaries in parallel. Probe failure becomes typed optional status and recovery, not a core setup failure.
- `nextOnboardingAction(status)` returns the first blocking required action by frozen order; after core completion it returns the first optional incomplete action by display order.

The exact top-level JSON shape is:

```text
{
  schema: 'jobos.onboarding-status.v1',
  workspace,
  profileId,
  jobId,
  asOf,
  state: 'needs_input' | 'in_progress' | 'complete',
  coreReady: boolean,
  completedRequired: number,
  totalRequired: 7,
  steps: [...],
  nextAction: object | null,
  recovery: [...],
  policy: {
    canonicalState: 'sqlite',
    projectionPersisted: false,
    cloudKeyRequired: false,
    providerRequired: false,
    browserRequired: false,
    calibrationRequired: false,
    preferencesMutatedByCalibration: false,
    externalSideEffects: 'none'
  }
}
```

Each step has exactly `id`, `kind`, `required`, `status`, `summary`, `blockers`, `actions`, and `evidence`. `kind` is `canonical`, `derived`, or `optional_external`. Required status is `blocked`, `ready`, or `complete`; optional status is `optional_ready`, `optional_incomplete`, `unavailable`, or `misconfigured`. Actions have `id`, `label`, `command`, `mutates`, `requiresHumanInput`, and `externalSideEffect`. Evidence contains IDs/counts/status codes only and never resume text, proof text, job descriptions, notes, credentials, cookies, storage state, or private W08 notes.

Required step order and exact completion rules:

1. `workspace`: store opened successfully.
2. `profile`: selected profile exists. With no `--profile`, exactly one profile is selected automatically; zero profiles blocks; multiple profiles require explicit selection and must never silently choose the first.
3. `resume`: selected profile has a current resume revision and `validateResumeDocument` returns `valid: true`.
4. `proofs`: at least one selected-profile proof is both `status='active'` and `verification_status='verified'`. Unverified imported proofs are not treated as complete.
5. `intake`: at least one selected-profile job exists. A saved search alone prepares discovery but does not satisfy intake; a local text/URL import is a valid keyless route.
6. `decision`: one explicitly selected profile-owned job has fresh/current liveness other than `expired` and a persisted current W04 fit result. If several jobs exist and no `--job` is supplied, selection is required; setup must not silently score or pursue the first job.
7. `materials`: `compileApplicationReadiness` for the selected profile/job returns `materials-ready` or `form-ready`. `blocked` and `ready-for-review` remain incomplete and expose their existing blocker/next-action vocabulary. `form-ready` counts because it strictly includes materials readiness.

Optional step order:

8. `source`: at least one selected-profile canonical saved search; list existing public adapters and keyless/local routes.
9. `calibration`: at least one current W08 job-feedback observation with explicit reason codes for the profile; show proposal counts by status and active count. This status never implies acceptance.
10. `provider`: live Hermes ACP availability/readiness; absence is `unavailable`, failed auth/check is `misconfigured`, and core continues.
11. `browser`: live package/private-profile status; missing Playwright/Chromium is `unavailable`, missing auth is `optional_incomplete`, and headless recovery remains honest.
12. `network`: reuse `networkIntent.completedAt` and suggested-affiliation counts; never replace the existing network setup flow.

`asOf` must be injected in unit tests. Stable fixtures with the same SQLite bytes and `asOf` produce deep-equal canonical projections. Live capability summaries are explicitly non-deterministic and tested through injected probes.

## Frozen CLI and TUI surface

### CLI

Add these commands to the existing registry and parser:

```text
jobos setup [--profile <profile-id>] [--job <job-id>] [--json]
jobos setup status [--profile <profile-id>] [--job <job-id>] [--json]
jobos setup next [--profile <profile-id>] [--job <job-id>] [--json]
```

- `setup --json` and `setup status --json` return the identical full projection and exit `0` even when incomplete. Incompleteness is product state, not a runtime error.
- `setup next --json` returns `{ schema, profileId, jobId, state, nextAction, policy }` and is read-only.
- `setup` without `--json` starts the existing TUI with the setup overlay open. It does not implement a second prompt engine.
- Unknown explicit profile/job, cross-profile job, invalid resume input, and malformed source/calibration input retain non-zero typed existing domain errors. Multiple profiles/jobs without explicit selection return a non-mutating setup blocker, not an arbitrary selection.
- Commands shown in actions use user-facing IDs, but the TUI carries selected IDs internally.

Do not expose setup mutations as a generic MCP tool. Agents may read the normal domain state through existing tools, but provider/browser setup, resume/profile input, artifact review, calibration feedback, and proposal lifecycle remain human-owned as already mediated.

### TUI

Add `g` = `setup` to `TUI_KEYMAP.global`. `jobos tui` automatically opens the setup overlay only when there is no profile; otherwise it preserves the normal shell and the user opens setup with `g`. `jobos setup` always opens it.

The setup overlay renders all steps, required/optional labels, current blockers, and one focused action. Enter opens an in-TUI form or existing overlay for the action; Escape closes without writes; `j/k` changes step; `r` recomputes; `c` opens correction for the focused canonical record. No action executes merely because the overlay opened or because status was computed.

Mutating actions call the existing owner directly:

- profile: `createProfile`;
- resume: `importResume` / `replaceResume` and existing validation;
- proof: `verifyProof`, `supersedeProof`, `retireProof`, or `addProof`;
- source: `createSearch`; intake: `importText` / `importUrl` or `daily_discovery` only after explicit confirmation;
- decision/pursuit: `score_job` / `pursue_job` through `callDomainTool`;
- material review: existing document/review overlays and exact `approve_artifact` / `reject_artifact` gates;
- calibration: `record_job_feedback`, `derive_memory_proposals`, list, and explicit accept/reject through trusted TUI mediation;
- provider/browser: display recovery commands only. JobOS does not collect credentials or run `hermes setup`, package installation, headed login, cookie import, or side-effecting browser operations inside the overlay.

After every successful mutation, reload authoritative SQLite and rebuild both the setup projection and normal TUI model. A failed mutation leaves the focused step and user input visible with a typed error and recovery; it must not advance optimistically.

## Recovery semantics

Recovery is state-derived, idempotent, and narrow:

| Condition | Status and recovery |
|---|---|
| Interrupted/closed process | Reopen `jobos setup`; recompute from canonical rows. No checkpoint replay or rollback. |
| Workspace lock/stale writer | Preserve `stale_snapshot`; reload and retry the same canonical action. Never merge silently. |
| Zero profiles | Block at `profile`; offer create. |
| Multiple profiles, none selected | Block at `profile`; list ID/name choices. Never default to first. |
| Invalid/incomplete resume | Block at `resume`; expose validator blocker codes and route to import/replace. Keep prior revision history. |
| Unverified/incorrect proof | Block at `proofs`; route to verify/replace/retire/add. Never auto-verify imported claims. |
| Saved source invalid | Keep source incomplete; expose adapter validation error and preserve other sources. |
| Discovery partial/failed | Preserve W03 partial results and per-source recovery. An imported surviving job may satisfy intake; no false success. |
| No job or ambiguous job | Offer local import, daily after source confirmation, or explicit selection. Never fabricate or auto-select. |
| Expired job | Decision remains blocked for that job; route to current liveness refresh/existing source flow or select another job. No override. |
| Uncertain job | Allow scoring/pursuit with the existing visible uncertainty warning; do not relabel active. |
| Pursuit stage failure | Read existing stage `failed/skipped` result and recovery guidance; retry only the failed stage plus declared dependencies. Preserve successful stages/artifact history. |
| Missing/rejected/stale artifact | Reuse readiness blockers and exact revision queue/diff/redraft/review. Never approve or regenerate silently. |
| `ready-for-review` | Focus exact pending current revisions. Completion changes only after trusted approval makes canonical readiness `materials-ready`. |
| Calibration has too little/conflicting evidence | Observation remains visible; W08 may produce no proposal or inactive/conflicted proposal. Setup remains core-complete. |
| Proposal exists | Display proposed versus active separately. No ranking/writing effect until explicit acceptance. |
| Provider absent/auth fails | Optional `unavailable`/`misconfigured`; show `hermes setup`, `hermes acp --check`; deterministic flow remains enabled. |
| Browser package/display/auth absent | Optional typed status and existing recovery commands; core flow remains enabled. Never claim authenticated readiness. |
| Probe timeout/crash | Optional probe error with retry; no canonical status mutation. |

Recovery actions may be retried. Existing idempotency, exact revision, source replay, proposal transition reference, lock, and audit contracts remain authoritative.

## Calibration and trust freeze

Calibration is optional and uses 1–3 profile-owned canonical jobs selected by the user; W09 ships no fake candidate, company, outcome, or preference fixture into runtime state. For each selected job, the user chooses `save`, `skip`, or `apply`, at least one existing W08 reason code, optional allowlisted structured signals, and an optional private note. The TUI previews the exact `jobos.job-feedback-input.v1` payload, validates it, then requires confirmation before calling `record_job_feedback` with `source:'tui'`, `actor:'user'`, and a unique reference ID.

After ratings, `derive_memory_proposals` may run only on explicit user action. Every result is shown as `proposed`, with evidence IDs, scope, confidence, conflicts/staleness, and the statement “inactive until accepted.” Accept and reject are separate confirmed actions using existing W08 transitions. W09 never edits `profiles.preferences_json`, saved searches, fit scores, job status, hard filters, artifact text, or active rules itself.

Trust invariants:

- no mandatory API key, cloud account, LLM, ACP backend, search provider credential, Playwright install, Chromium, or authenticated browser profile;
- local text job import plus deterministic scoring/pursuit is a supported core route;
- optional provider/browser checks reveal capability and recovery only, never secret values;
- setup reads never audit, save, mirror, spawn external actions, or mutate preferences;
- provider/browser commands are never auto-run;
- calibration never silently accepts, rejects, supersedes, revokes, or activates guidance;
- external apply/send/fill/submit remain outside onboarding and retain their existing separate configuration and per-run gates;
- opening or completing setup has `externalSideEffects:'none'`.

## Acceptance IDs

| ID | Frozen observable contract |
|---|---|
| `W09-JOURNEY-01` | Clean workspace projects the seven required steps in frozen order with profile as first blocker. |
| `W09-JOURNEY-02` | Guided canonical actions reach an explicit job score/pursue decision without the user supplying internal IDs manually. |
| `W09-JOURNEY-03` | Exact artifact review advances only through existing readiness and reaches `materials-ready`; setup never aliases `ready-for-review`. |
| `W09-JOURNEY-04` | Multiple profiles/jobs require explicit selection; profile/job ownership is enforced. |
| `W09-JOURNEY-05` | CLI JSON, `setup next`, TUI overlay, and canonical state agree after each action. |
| `W09-RESUME-01` | Missing/invalid canonical resume blocks and exposes W01 validator codes and correction routes. |
| `W09-RESUME-02` | Imported unverified proofs do not complete proof setup; verify/replace/retire/add preserves lineage. |
| `W09-RESUME-03` | Resume/proof correction recomputes status without an onboarding checkpoint or duplicate truth. |
| `W09-RECOVERY-01` | Process interruption resumes at the first canonical incomplete step with no replayed writes. |
| `W09-RECOVERY-02` | Partial discovery preserves surviving jobs/failures and exposes narrow recovery without false success. |
| `W09-RECOVERY-03` | Expired blocks, uncertain warns, and current active intake follows W03 unchanged. |
| `W09-RECOVERY-04` | Pursuit stage failure resumes through the existing stage/dependency contract and preserves completed work. |
| `W09-RECOVERY-05` | Stale writer, rejected/stale artifacts, and optional probe failures retain typed existing recovery semantics. |
| `W09-CALIBRATION-01` | Explicit rating/reasons create one attributable profile-owned W08 observation tied to the exact canonical job. |
| `W09-CALIBRATION-02` | Derivation is optional; proposals remain visibly inactive before acceptance and canonical preferences are byte-unchanged. |
| `W09-CALIBRATION-03` | Explicit accept changes only W08-declared scope; reject/revoke/undo history and prior behavior remain W08-owned and visible. |
| `W09-CALIBRATION-04` | Small/conflicting/protected/cross-profile evidence cannot become silently active guidance. |
| `W09-TRUST-01` | Full core journey passes with provider/search keys absent, ACP off, Playwright absent, and network disabled after local import. |
| `W09-TRUST-02` | Provider/browser are optional honest statuses with redacted recovery; no credentials enter JSON, mirrors, or audit. |
| `W09-TRUST-03` | Status/next/render are zero-write and deterministic for fixed SQLite bytes and `asOf`. |
| `W09-TRUST-04` | Setup/calibration cannot silently mutate preferences, saved searches, score math, status, artifacts, or external-action policy. |
| `W09-TRUST-05` | MCP/ACP cannot invoke trusted setup inputs, calibration decisions, artifact review, or provider/browser setup. |

## Strict-TDD implementation order

Implementation must not begin a phase until its listed RED tests fail for the intended missing behavior. Add no production code in a RED commit.

### Phase 0 — projection and no-duplicate-state RED

Create `tests/w09-guided-onboarding.test.js` with fixture helpers that open isolated temporary workspaces and injected `asOf`/capability probes.

RED first:

- `W09-JOURNEY-01`, `W09-JOURNEY-04` step order and ambiguity;
- `W09-RESUME-01..03` canonical resume/proof gates;
- `W09-TRUST-03..04` deep equality and protected-table/file byte counts before/after repeated status/next reads;
- assert no onboarding/setup table, schema bump, mirror, audit, or preference delta.

Then implement only `src/onboarding.js`.

Focused command:

```bash
node --test --test-concurrency=1 --test-name-pattern='W09-(JOURNEY-01|JOURNEY-04|RESUME|TRUST-03|TRUST-04)' tests/w09-guided-onboarding.test.js
```

### Phase 1 — CLI and recovery RED

RED first:

- frozen registry/JSON grammar and incomplete exit `0`;
- explicit profile/job ownership and ambiguity;
- local-import → score → readiness blockers;
- expired/uncertain, partial discovery, stage failure, and stale artifact recovery projections;
- repeated `setup status` / `setup next` make zero writes.

Then modify `src/cli.js`; reuse existing command functions and `callDomainTool`. Do not create setup mutations in `src/domain-tools.js`.

Focused command:

```bash
node --test --test-concurrency=1 --test-name-pattern='W09-(JOURNEY-02|JOURNEY-03|JOURNEY-05|RECOVERY)' tests/w09-guided-onboarding.test.js
```

### Phase 2 — optional capabilities and calibration RED

RED first:

- absent/misconfigured/ready provider and browser probe mappings with injected probes;
- no key/provider/browser required for core completion;
- calibration preview/confirm, exact observation source, inactive proposal, explicit transition, private-note/redaction, and cross-profile denial;
- byte-stable `profiles.preferences_json`, saved searches, fit rows, and external-action policy before/after derive.

Then integrate existing `agentBackendCatalog`, `browserStatus`, and W08 domain calls. Capability probes remain read-only; calibration mutations remain trusted TUI/CLI existing W08 calls.

Focused command:

```bash
node --test --test-concurrency=1 --test-name-pattern='W09-(CALIBRATION|TRUST-01|TRUST-02|TRUST-04|TRUST-05)' tests/w09-guided-onboarding.test.js tests/w08-career-memory-surfaces.test.js
```

### Phase 3 — TUI resumability RED

Add TUI tests to the same W09 file, using existing render/key harnesses.

RED first:

- no-profile auto-open and existing-profile no-auto-open;
- `g`, navigation, Escape zero-write, correction focus, and explicit confirmation;
- failed action remains focused and does not advance;
- successful mutation reloads authoritative state and setup/normal models agree;
- agent pane cannot trigger human setup/calibration/review actions;
- narrow snapshot renders honest optional unavailable states without secrets.

Then modify `src/tui-model.js` and `src/tui.js` only as needed. Keep current shell, overlays, ACP lifecycle, and key behavior intact.

Focused command:

```bash
node --test --test-concurrency=1 --test-name-pattern='W09-(JOURNEY-05|RECOVERY-01|RECOVERY-05|TRUST-02|TRUST-05)' tests/w09-guided-onboarding.test.js tests/sprint9-frontend.test.js tests/tui-acp.test.js
```

### Phase 4 — runtime journey and compatibility

Extend `scripts/smoke.js` with a clean temporary, network-disabled setup drill: no cloud/search/provider keys, ACP off, no Playwright assumption; create profile, import valid resume, verify/correct proof, import local job, score, pursue, exact artifact approvals, and assert existing readiness is `materials-ready`. Interrupt by closing/reopening the store between at least three steps and prove the derived next step is exact. Add optional calibration and prove proposal inactivity/preferences byte stability. Assert zero external effects.

Only after focused phases pass, update user-facing command/help text and build evidence.

Focused commands:

```bash
node --test --test-concurrency=1 tests/w09-guided-onboarding.test.js
node --test --test-concurrency=1 tests/cli.test.js tests/cleanup-cli.test.js tests/sprint9-frontend.test.js tests/tui-acp.test.js
node --test --test-concurrency=1 tests/tailored-resume.test.js tests/readiness.test.js tests/human-review.test.js tests/discovery-integrity.test.js tests/fit-consistency.test.js
node --test --test-concurrency=1 tests/w08-career-memory-surfaces.test.js tests/w08-career-memory-consumers.test.js
JOBOS_SEARCH_PROVIDER=none npm run smoke
```

Integration owner, not this plan worker, runs the final serial gates:

```bash
npm test
npm run smoke
npm run smoke:live-form
```

## Exact implementation files

| File | Planned change |
|---|---|
| `src/onboarding.js` | New read-only canonical setup projector, next-action reducer, and optional capability wrapper. |
| `src/cli.js` | Register/parse `setup`, `setup status`, and `setup next`; launch existing TUI setup overlay. |
| `src/tui-model.js` | Attach the derived setup projection without changing canonical selection/readiness ownership. |
| `src/tui.js` | Add `g` and setup overlay/forms/confirmations routed to existing canonical owners. |
| `tests/w09-guided-onboarding.test.js` | New strict RED acceptance, zero-write, resumability, capability, calibration, CLI, and TUI coverage. |
| `scripts/smoke.js` | Add clean offline interrupted guided journey through canonical `materials-ready`. |
| `README.md` | Replace command-order-first setup entry with shipped guided commands and optional capability trust text. |
| `BUILD_PROGRESS.md` | Record W09 behavior and observed verification only after implementation passes. |

No other product file is planned. In particular, do not edit `src/db.js`, `src/profiles.js`, `src/resumes.js`, `src/discovery.js`, `src/scoring.js`, `src/workflows.js`, `src/readiness.js`, W08 modules, browser/ACP modules, or `src/domain-tools.js` unless an escalation trigger is met and the plan is amended first. Tests may import those existing owners but must not weaken their contracts.

## Non-goals

- A web dashboard, second TUI shell, conversational agent-led wizard, or generic prompt framework.
- An onboarding/checkpoint/schema table, setup mirror, duplicate profile/source/proof/preference state, or schema migration.
- Automatic profile selection in ambiguous workspaces, job selection, proof verification, scoring, pursuit, artifact approval, proposal acceptance, provider setup, package install, browser login, or external action.
- Mandatory Hermes/Codex/LLM/search API key, network access, Playwright, Chromium, browser profile, telemetry, cloud sync, or cloud account.
- Collecting/storing credentials, cookies, storage state, provider tokens, or private W08 notes in setup JSON/audit/mirrors.
- Replacing W01 resume/proof correction, W02 readiness/form/packet semantics, W03 source/liveness semantics, W04 fit math, or W08 observation/proposal lifecycle.
- Bundled fake career facts, fake company/job outcomes, fabricated calibration evidence, or runtime sample records silently mixed into user state.
- Automatic preference/profile/saved-search mutation, hidden personalization, hard search exclusion, or causal claims from calibration.
- Browser fill/submit, apply/send automation, CAPTCHA handling, authenticated-board scraping, network-map research, or form setup as a core completion requirement.
- MCP protocol modernization, release hygiene beyond changed behavior, or W10 scope.

## Escalation triggers

Stop implementation and request a plan amendment before proceeding if any of these is required:

1. A required step cannot be derived from existing canonical rows and would require persisted wizard/checkpoint/skip state.
2. Reaching `materials-ready` requires changing W02 readiness labels, artifact approval meaning, or form/packet semantics.
3. Offline deterministic pursue cannot reach reviewable materials from a valid canonical resume, verified proof, and local job without a provider/network call.
4. Existing W01 APIs cannot expose validator blocker codes or preserve correction lineage without modifying their contract.
5. W03 cannot distinguish expired/uncertain/current evidence without changing liveness authority or fit math.
6. Calibration requires a new reason code, observation/proposal schema, automatic transition, preference mutation, or runtime fake job.
7. Provider/browser status cannot be safely redacted using existing `agentBackendCatalog` / `browserStatus`, or a probe would write/authenticate/install.
8. A setup mutation would need MCP/ACP exposure or would weaken trusted CLI/TUI human gates.
9. The exact implementation file list must expand into `src/db.js`, W01/W02/W03/W04/W08 owner modules, browser/ACP internals, or a new dependency.
10. A command/key/schema literal, seven-step required order, completion rule, trust invariant, or acceptance ID must change.
11. Existing tests reveal a conflict between first-profile auto-selection in normal TUI and W09’s explicit ambiguity rule; W09 setup must remain explicit and normal TUI behavior must not be changed without review.
12. Any proposed recovery would delete history, silently merge a stale writer, fabricate success, or bypass exact revision/source ownership.

## Planning resolution

No unresolved product choice remains. Implementation starts with the W09 RED suite, keeps setup status derived and zero-write, reuses canonical domain owners, and stops for amendment on any escalation above.
