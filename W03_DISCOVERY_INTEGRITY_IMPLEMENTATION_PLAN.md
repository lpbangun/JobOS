# W03 Discovery Integrity Implementation Plan

**Status:** COMPLETE AND CRITIC-CONVERGED — all approved Phases 0–6 are implemented on `fix/discovery-integrity` and ready for integration-owner review.

**Implementation owner:** `fix/discovery-integrity` in `/home/logani/.herdr/worktrees/Job App/cleanup-w03-discovery-integrity`

**Baseline:** `cleanup/base` at `8191de3`

## 1. Outcome and authority

W03 will make discovery intake reliable and honest before downstream work begins. Existing public ATS and public career-page sources remain the scope. The bundle adds bounded transient recovery, per-result isolation, honest run status, source-native field preservation, decision filters, and a persisted liveness assessment before scoring or pursuit.

Authority applied in this order:

1. `AGENTS.md`
2. `/home/logani/.hermes/orchestration/jobos-w03-plan-brief.md`
3. `docs/JOBOS_CAPABILITY_PARITY_MASTER_PLAN.md`, especially `W03` at lines 163–169
4. `docs/JOBOS_WORKTREE_EXECUTION_BOARD.md`, especially the W03 brief at lines 90–107
5. `CAREER_OPS_IMPLEMENTATION_AUDIT.md`, especially lines 244–292
6. `docs/open_source_benchmark_checkup.md`, especially lines 160–191 and 402–415
7. Current source, callers, schema, projections, and tests

The controlling acceptance bar is: one transient response or one bad result cannot discard later results; child failures cannot be reported as full success; anti-bot ambiguity remains `uncertain`; existing SSRF, DNS, credential, redirect, request, and elapsed-time controls remain effective.

## 2. Confirmed current-code findings

### 2.1 HTTP and adapter behavior

- `src/discovery/adapters.js:requestOnce` performs a fixed delay, DNS/public-address validation, one request timeout, manual redirects, and abort handling. It has no retry loop and does not inspect `Retry-After`.
- `src/discovery/adapters.js:fetchResponse` follows at most five redirects and rejects non-OK responses. A `429` or `503` immediately fails.
- `src/discovery/adapters.js:publicUrl`, `assertPublicAddress`, and `isBlockedIp` reject URL credentials and public-host resolutions that include blocked private, loopback, link-local, documentation, multicast, or otherwise non-public addresses. These controls are stronger than the benchmark and must remain on every initial request, redirect, retry, and liveness request.
- `src/discovery/adapters.js:portfolio.fetchJobs` is the only adapter that constructs a shared request/elapsed-time budget. Direct Greenhouse, Lever, Ashby, and career-page runs receive a per-request timeout but no run-level request budget.
- `src/discovery/adapters.js:matchesFilters` supports keyword-any-match and location substring only. It has no posted-date recency, remote-only, or employment-type filter.
- `src/discovery/adapters.js:greenhouse.fetchJobs`, `lever.fetchJobs`, `ashby.fetchJobs`, and `parseCareerPage` return title/company/location/url/source/description/posted date only. Available department, workplace, employment-type, and compensation values are not carried in the normalized result.
- `src/discovery/adapters.js:portfolio.fetchJobs` records child failures in `metadata.errors` and truncation in `metadata`, which is useful evidence, but the caller does not turn either into `partial` consistently.

### 2.2 Run orchestration and isolation

- `src/discovery.js:runSavedSearch` initializes every run as `succeeded`.
- Adapter metadata errors are copied to `outputs.errors`, but the run remains `succeeded` unless the outer `try` throws.
- Import, score, high-fit update, projection, and result serialization all execute inside one result loop covered by one outer `try`. An exception for one result exits the loop and prevents later results from being processed.
- Any outer exception changes the entire run to `failed`, even when earlier results were durably imported and scored. There is no `partial` state.
- `src/discovery.js:recordAutomationRun` joins `outputs.errors` as strings even though portfolio errors are objects, and its audit action treats every non-`succeeded` status as `discovery.run.failed`; a future `partial` status needs an explicit audit action.
- `src/discovery.js:runAllSearches` returns only `{count, runs}` and has no aggregate status.
- `src/workflows.js:runDaily` reconstructs `partial` at the workflow surface, but this does not correct the persisted saved-search run status.
- `src/scheduler/actions.js:dailyDiscovery` returns discovery output without a status, and `src/scheduler/core.js:runAutomation` reports any non-throwing action as `succeeded`. A scheduled daily discovery can therefore be fully successful at the automation layer while containing partial child runs.

### 2.3 Persistence and serialization

- `src/db.js` already defines `jobs.compensation` and `jobs.work_model`. It has no employment-type, department, source-native field, or liveness columns.
- `src/jobs.js:importNormalized` drops compensation and work model along with employment type and department. Both the insert and exact-URL/dedupe refresh paths omit those fields.
- `src/jobs.js:syncJob` emits the legacy compensation string and work-model string to `job.yaml`, but cannot emit fields that were discarded. It has no liveness projection.
- `src/jobs.js:importNormalized` correctly preserves exact-URL-first dedupe, conservative key matching, source history, `first_seen_at`, `last_seen_at`, repost detection, possible-duplicate tasks, audit history, and the human review status. W03 must extend these paths rather than replace them.
- Existing refresh behavior should not erase a richer previously stored native field when a later source response omits that field.
- `src/domain-tools.js:publicJob` and `selectedJobContext`, `src/tui-model.js:buildTuiModel`, and raw job-list surfaces do not serialize liveness, employment type, department, or structured compensation.

### 2.4 Liveness and downstream gates

- There is no posting-liveness module or persisted liveness assessment.
- `src/scoring.js:score` validates job/profile ownership and immediately computes fit. It does not check posting liveness.
- `src/workflows.js:runPursuit` validates job/profile ownership and begins the selected stage graph without a liveness check.
- `src/discovery.js:runSavedSearch` scores every successfully imported result without first classifying the posting as `active`, `expired`, or `uncertain`.
- `src/discovery.js:recommendResearchForJobs`, weekly-review queries in `src/analytics.js`, and scheduled recommendation queries can recommend high-fit jobs without liveness context. Their selection predicates must exclude known-expired jobs while retaining uncertain records as visibly uncertain review candidates.
- `src/cli.js`, `src/domain-tools.js`, and the TUI call the same scoring/pursuit functions, so source-level gates in `score` and `runPursuit` cover those entry points without duplicating policy in each presentation layer.

### 2.5 Existing behavioral coverage and missing proof

- `tests/sprint6-discovery.test.js` covers basic Greenhouse/Lever normalization, successful import/score/dedupe, fatal fetch failure, profile-scoped run-all, repost handling, and MCP tool presence.
- `tests/discovery-watchlist-consolidation.test.js` covers saved-search/watchlist consolidation but not the W03 integrity contract.
- No current test locks retry count, `Retry-After`, retry budget accounting, redirect safety, run-level partial semantics, result isolation, native-field round-trip, decision filters, or liveness classification/gating.
- Existing manual text-import pursuit tests create `jobos:text:` jobs. Compatibility must not make these local-first, human-provided records unusable merely because no public URL can be checked.

## 3. Locked scope

W03 owns:

1. A shared safe GET path for discovery and liveness, preserving current URL, DNS, credential, redirect, request, and time controls.
2. Bounded recovery for `429` and `503` only.
3. Per-result liveness/import/score isolation and structured result errors.
4. Persisted and serialized `succeeded | partial | failed` discovery semantics at saved-search, run-all/daily, and scheduled-daily surfaces.
5. A versioned normalized intake shape that retains compensation, work model/remote, employment type, department, and source-native representations when present.
6. Saved-search filters for recency, remote-only, and employment type, in addition to existing keyword and location filters.
7. A versioned `active | expired | uncertain` posting-liveness result, checked before score and pursuit.
8. Exclusion of known-expired jobs from automated high-fit/research recommendations without automatic archival or application-state mutation.
9. Parseable CLI/domain/TUI/workspace projections of the new evidence.
10. Regression proof for public-source safety, provenance, dedupe, repost history, local-first operation, review queues, and `external_side_effects: none`.

## 4. Non-goals

W03 will not:

- change W04 candidate-fit dimensions, weights, overall-score math, calibration, dealbreakers, contradictions, or score-band outcomes;
- merge liveness or source legitimacy into candidate fit or `fit_score`;
- add LinkedIn, Indeed, Glassdoor, authenticated-board scraping, session-cookie discovery, broad provider expansion, rotating proxies, TLS-fingerprint evasion, CAPTCHA solving, or anti-bot bypasses;
- auto-apply, submit a form, send outreach, mutate external accounts, or change application receipts;
- auto-archive an expired job or silently accept an uncertain job as active;
- replace exact-URL/conservative-key dedupe, source history, repost detection, possible-duplicate review tasks, or human review queues;
- introduce cloud state, telemetry, required API keys, or required network access for manual/local imports;
- implement W08 preference learning or mutate saved-search preferences from observed outcomes;
- edit or reinterpret W01's resume/document/proof contracts.

## 5. Locked contracts

### 5.1 Shared HTTP policy

All discovery adapter and liveness GETs use one request primitive.

- Retryable statuses: `429` and `503` only.
- Attempts: at most 3 total requests for one URL/redirect hop (initial attempt plus at most 2 retries).
- `Retry-After`: accept non-negative integer delta-seconds or a valid future HTTP date. Honor it only when the delay is at most `10_000ms` and fits the remaining elapsed-time budget. A larger valid value is not clamped into an early retry; return a typed `retry_after_exceeds_limit` error containing the safe parsed delay. Invalid or past values use deterministic fallback backoff.
- Fallback backoff: `250ms`, then `500ms`. No jitter in the deterministic local/test path.
- Every attempt, including redirects, retries, and liveness checks, consumes the shared request budget. DNS validation runs again for every distinct redirect target and retry.
- Existing hard limits remain: per-request timeout at most `10_000ms`, at most 5 redirects, at most 90 requests per saved-search run, at most 60 seconds elapsed per saved-search run, and at most 30 portfolio companies. Retry sleeps must fit the same elapsed-time budget before sleeping.
- A liveness refresh outside a saved-search run creates its own budget: at most 8 requests and at most 30 seconds elapsed for that one check. It uses the same retry, redirect, DNS, credential, and per-request limits; there is no unbudgeted standalone fetch path.
- A timeout, exhausted budget, unsafe redirect, credentialed URL, or non-public resolution is never retried as a transient server response.
- The request result carries `requestedUrl`, `finalUrl`, `status`, `redirects`, and `attempts` so liveness can classify without bypassing the safe transport.
- Errors are typed and serializable: `{code, stage, message, retryable, source, url, jobKey, details}`. Secrets and response bodies are not included.

### 5.2 Normalized adapter result v1

Every adapter result uses this shape before filtering/import:

```js
{
  version: 1,
  title: string,
  company: string,
  location: string,
  url: string,
  source: 'greenhouse' | 'lever' | 'ashby' | 'career-page',
  sourceId: string,
  description: string,
  postedDate: string, // ISO-8601 when known; '' when unknown
  compensation: {
    text: string,
    min: number | null,
    max: number | null,
    currency: string,
    interval: 'hour' | 'day' | 'week' | 'month' | 'year' | 'unknown'
  },
  workModel: 'remote' | 'hybrid' | 'onsite' | 'unknown',
  employmentTypes: Array<'full_time' | 'part_time' | 'contract' | 'temporary' | 'internship' | 'volunteer' | 'other'>,
  department: string,
  sourceNativeFields: {
    compensation: unknown,
    workModel: unknown,
    employmentType: unknown,
    department: unknown
  },
  livenessHint: {
    kind: 'listed_in_public_ats' | 'listed_on_career_page' | 'none',
    observedAt: string,
    request: {
      requestedUrl: string,
      finalUrl: string,
      httpStatus: number | null
    }
  }
}
```

Rules:

- Canonical values support filtering and display; `sourceNativeFields` preserves the exact JSON-compatible source value so normalization does not destroy useful ATS data.
- Missing data remains empty/`unknown`; adapters do not infer compensation, department, or employment type from prose.
- Work model may use explicit source fields and standards-based `jobLocationType`; a plain location containing “remote” is a fallback signal only when no explicit workplace field exists.
- Greenhouse, Lever, Ashby, and JSON-LD fixtures will each lock only source fields actually observed in that source format. Unsupported fields remain unknown rather than guessed.

### 5.3 Database and workspace migration

Add idempotent `jobs` migrations:

```text
compensation_json       TEXT NOT NULL DEFAULT '{}'
employment_types_json   TEXT NOT NULL DEFAULT '[]'
department              TEXT NOT NULL DEFAULT ''
source_native_json      TEXT NOT NULL DEFAULT '{}'
liveness_status         TEXT NOT NULL DEFAULT 'uncertain'
liveness_checked_at     TEXT
liveness_json           TEXT NOT NULL DEFAULT '{}'
```

Compatibility behavior:

- Keep the existing `compensation` text column as the display/backward-compatible projection of `compensation.text`.
- Keep the existing `work_model` column as the canonical enum projection. Legacy `''` deserializes as `unknown`; no eager rewrite is required.
- Keep all existing job identifiers and dedupe keys. New fields do not participate in identity.
- A mandatory `deserializeLiveness(row)` boundary handles every DB/workspace/domain/TUI read. It converts legacy `'{}'`, null, missing-version, or malformed payloads into `{version:1,jobId:row.id,status:'uncertain',reasonCodes:['legacy_unchecked'],checkedAt:null,requestedUrl:'',finalUrl:'',httpStatus:null,evidence:[],source:row.source,freshUntil:null}`. Opening a store performs no network backfill, and W03-COMPAT-01 locks this read behavior.
- A later exact-URL/dedupe refresh updates a field when the incoming adapter has a meaningful value; an omitted/unknown incoming field does not erase a meaningful stored value.
- `job.yaml` keeps `compensation` and `workModel` for compatibility and adds `compensationDetails`, `employmentTypes`, `department`, `sourceNativeFields`, and `liveness`.
- JSON/domain projections use camelCase. Existing fields are not renamed or removed in W03.
- Liveness changes append audit events and refresh the job workspace projection; they do not change job/application status.

### 5.4 Liveness result v1

Persist and serialize:

```js
{
  version: 1,
  jobId: string,
  status: 'active' | 'expired' | 'uncertain',
  checkedAt: string | null,
  requestedUrl: string,
  finalUrl: string,
  httpStatus: number | null,
  reasonCodes: string[],
  evidence: Array<{
    kind: 'ats_listing' | 'http_status' | 'redirect' | 'closure_text' | 'apply_control' | 'anti_bot' | 'transport_error' | 'manual_import',
    value: string
  }>,
  source: string,
  freshUntil: string | null
}
```

Classification decision tree:

1. **Ambiguity stop:** if there is no public URL/manual text import; the response is `401`, `403`, `429`, or `503`; the page is a CAPTCHA/challenge/access-denied/anti-bot response; the request times out or hits DNS/transport/request/time-budget failure; or active and expired evidence conflict, return `uncertain` immediately. These conditions prevent a false active or false expired result.
2. **Definitive expiration:** otherwise, return `expired` for `404`/`410`, explicit closed/expired/filled/no-longer-accepting language, or a redirect from a direct posting to a generic jobs listing/home page without the original posting identity.
3. **Positive active evidence:** otherwise, return `active` when the job is present in the current successful public ATS/listing response, or a successful direct page contains an explicit visible application control.
4. **Fallback:** otherwise return `uncertain`; HTTP `200` alone is not proof of an active posting.

Adapter-to-classifier data flow:

- A successful adapter listing response is the initial liveness observation. The adapter passes `livenessHint.request` plus source/job identity to the classifier, which records `ats_listing` evidence without a redundant per-job request.
- The classifier performs an independent safe fetch only when no current listing evidence exists: a public manual/direct import, standalone score/pursuit with missing evidence, a result older than the freshness window, or a direct-page-only job.

Freshness and gates:

- Store `liveness_checked_at` and `checkedAt` as ISO-8601 UTC. A result is fresh only when `0 <= nowUtc - checkedAt < 86_400_000ms`; null, unparseable, or future timestamps are stale. `freshUntil` is exactly `checkedAt + 24h`.
- Score/pursuit refresh stale public-URL results through the same safe HTTP path and standalone budget. Manual text imports remain `uncertain` with `manual_import` evidence and require no network.
- Known `expired` is a hard pre-score and pre-pursuit stop with a typed `job_expired` error. No fit, research, tailoring, application-preparation, or outreach stage starts.
- `uncertain` is a visible soft gate: it is never relabeled expired, never auto-archived, and may proceed for a human-requested local score/pursuit with a structured warning. Automated discovery may retain/import it, but the child outcome is not fully successful and the run becomes `partial`.
- Known `active` proceeds normally.
- Dry-run pursuit reports the persisted assessment and gate outcome without performing a liveness fetch or any other write; stale/missing evidence is reported as uncertain.

### 5.5 Discovery run result v2

Saved-search output becomes:

```js
{
  version: 2,
  runId: string,
  searchId: string,
  searchName: string,
  profileId: string,
  adapter: string,
  config: object,
  status: 'succeeded' | 'partial' | 'failed',
  counts: {
    fetched: number,
    processed: number,
    imported: number,
    deduped: number,
    scored: number,
    highFit: number,
    active: number,
    expired: number,
    uncertain: number,
    failed: number
  },
  jobs: Array<{
    id: string | null,
    sourceId: string,
    title: string,
    company: string,
    outcome: 'scored' | 'imported_unscored' | 'expired' | 'failed',
    created: boolean,
    deduped: boolean,
    score: number | null,
    highFit: boolean,
    liveness: object,
    error: object | null
  }>,
  errors: object[],
  metadata: object,
  createdAt: string,
  finishedAt: string
}
```

Status rules:

- `succeeded`: adapter completed without metadata errors/truncation and every fetched result completed its required active path.
- `partial`: at least one result made durable progress, and at least one child failed, was classified expired/uncertain, or the adapter reported child errors/truncation.
- `failed`: the adapter failed before durable progress, returned an invalid result, or every fetched result failed before durable progress.
- A valid empty source with no errors is `succeeded` with zero counts.
- Result-level failures are caught inside the loop. Later results always continue while request/time budget remains.
- Aggregate `runAllSearches` and `runDaily` use the same success/partial/failure reduction.
- Discovery audits use `discovery.run.completed`, `discovery.run.partial`, or `discovery.run.failed` exactly.
- Scheduler actions may return `derivedStatus: 'succeeded' | 'partial' | 'failed'`. `src/scheduler/core.js:runAutomation` validates and persists that non-throwing derived status instead of defaulting every return to `succeeded`; scheduled discovery audits use `automation.succeeded`, `automation.partial`, or `automation.failed`. `partial` records useful progress and does not increment the consecutive hard-failure disable counter.
- Every discovery and scheduler run retains `external_side_effects: 'none'`.

### 5.6 Filter contract

Saved-search config adds:

```js
{
  postedWithinDays: number,       // positive integer, hard maximum 3650
  remoteOnly: boolean,
  employmentTypes: string[]       // canonical values from §5.2
}
```

Rules:

- Existing searches with none of these keys behave exactly as before.
- `postedWithinDays` compares a valid source date to an injected/current clock. Unknown, invalid, or future dates do not satisfy an explicitly requested recency filter.
- `remoteOnly` requires canonical `workModel === 'remote'`; `hybrid`, `onsite`, and `unknown` do not match.
- Employment-type filtering is OR across requested canonical values and requires at least one intersection. Unknown/empty types do not match an explicit type filter.
- Keyword, location, recency, remote, and employment-type clauses combine with AND. Keyword values remain OR within the keyword clause.
- CLI flags: `--posted-within-days <n>`, `--remote-only`, and `--employment-types <csv>`. The same normalized config is stored in `saved_searches.config_json`, YAML, CLI JSON, MCP/domain output, and scheduled execution.

### 5.7 W04 handoff

W03 publishes `liveness` v1 as a separate posting-integrity input. It does not add a liveness dimension, penalty, boost, or weight to `fit_score`.

W04 will consume this required handoff after W03 lands:

```js
{
  contract: 'jobos.posting-liveness.v1',
  jobId: string,
  status: 'active' | 'expired' | 'uncertain',
  checkedAt: string | null,
  reasonCodes: string[],
  source: string
}
```

W04 must preserve the boundary: candidate fit answers “is this role a fit for this candidate”; W03 liveness answers “is this posting currently actionable with what evidence.” W04 owns any later legitimacy presentation or pursue-decision composition. W03 does not calibrate or alter candidate-fit math.

## 6. Phased implementation order

### Pre-`/goal` transition

After human approval and only when OMP `/goal` actually begins, update the W03 board row from `PLANNED` to `IN_PROGRESS` while retaining `cleanup/w03-discovery-integrity` as owner. The current planning turn records planning ownership only and must not make that status transition.

### Phase 0 — critic/advisor locks acceptance before implementation

1. Convert every acceptance ID in §7 into a test with the exact title shown.
2. Add deterministic response, clock, sleep, ATS-native field, liveness HTML, and legacy-row fixtures described in §8.
3. Confirm the tests fail for the intended current defects and do not assert implementation details.
4. Freeze the result/status/schema contracts above before product code changes.

Files: new `tests/discovery-integrity.test.js`, new fixture files under `tests/fixtures/discovery-integrity/`, and only minimal additions to existing discovery/workflow tests where an existing public contract belongs there.

### Phase 1 — safe HTTP extraction and retry semantics

1. Extract the URL/DNS/request/redirect/budget primitives from `src/discovery/adapters.js` into `src/discovery/http.js` without changing safety behavior.
2. Add bounded `429`/`503` retry and safe `Retry-After` parsing.
3. Create one run-level budget in saved-search orchestration and pass it through direct ATS, career-page, portfolio-child, and later liveness requests.
4. Retain injected fetch/lookup/sleep/clock hooks for deterministic tests.
5. Pass HTTP/safety/retry acceptance tests before adapter or persistence changes.

Files: `src/discovery/http.js`, `src/discovery/adapters.js`, `src/discovery.js`, targeted tests.

### Phase 2 — normalized fields and filtering at adapter boundary

1. Add normalized result v1 builders and canonical enum parsing.
2. Map only verified Greenhouse, Lever, Ashby, and JSON-LD fields; retain exact source-native values.
3. Apply keyword/location/recency/remote/type filters after normalization and before import.
4. Extend saved-search CLI/config serialization with the three new filters.
5. Prove adapter output and filter behavior independently of database persistence.

Files: `src/discovery/adapters.js`, `src/discovery.js`, `src/cli.js`, rich ATS fixture files, targeted tests.

### Phase 3 — liveness classifier over the safe transport

1. Add `src/discovery/liveness.js` with the explicit ambiguity-stop/expired/active/fallback decision tree and versioned serializer.
2. Treat successful ATS/listing request evidence from `livenessHint` as the initial observation; do not issue a redundant per-result fetch.
3. Use the shared safe transport and standalone budget only for missing, stale, manual-public-URL, or direct-page evidence.
4. Add anti-bot, closure text, redirects-away, apply-control, status, ambiguous-200, and transport-error fixtures.
5. Prove classification without fit/scoring changes.

Files: `src/discovery/liveness.js`, `src/discovery/http.js`, `src/discovery/adapters.js`, targeted tests.

### Phase 4 — one coordinated shared-schema/persistence cutover

This phase and every later shared-file edit begin only after the active W01 tailored-resume worktree freezes or lands its shared-file edits and W03 rebases onto that stable result.

1. Add the idempotent `jobs` columns/migrations in one `src/db.js` change.
2. Extend both insert and refresh branches in `src/jobs.js:importNormalized` without disturbing W01 requirement-inventory changes, dedupe, source history, repost logic, or review tasks.
3. Add compatibility parsers and `job.yaml` projection fields.
4. Persist liveness updates and audit events without mutating lifecycle status.
5. Extend domain/TUI projections in one pass.

Files: `src/db.js`, `src/jobs.js`, `src/domain-tools.js`, `src/tui-model.js`, targeted migration/round-trip tests.

### Phase 5 — per-result isolation, honest status, and gates

1. Refactor `runSavedSearch` so each result has its own liveness/import/score boundary and structured outcome.
2. Derive saved-search and run-all/daily status from durable progress plus child evidence; propagate `derivedStatus` through scheduler persistence and the three-way audit vocabulary.
3. Make `score` enforce fresh liveness before computing fit; do not alter fit math.
4. Make `runPursuit` report/enforce the same gate before starting its stage graph; preserve dry-run non-mutation.
5. Exclude known-expired records from automatic research/high-fit recommendations while showing uncertain evidence.
6. Keep review queues and all external side-effect fields unchanged.

Files: `src/discovery.js`, `src/scoring.js`, `src/workflows.js`, `src/scheduler/actions.js`, `src/scheduler/core.js`, `src/analytics.js`, `src/domain-tools.js`, `src/tui-model.js`, and focused tests.

### Phase 6 — presentation, runtime proof, and documentation reconciliation

1. Show new filter flags in the CLI registry/agent guide.
2. Show liveness and normalized fields in CLI/domain/TUI/workspace output without renaming existing fields.
3. Add a fixture-backed W03 segment to `scripts/smoke.js` that exercises a successful rich-field run plus a partial run and proves no external side effect.
4. Run all commands in §9.
5. Only after behavior passes, update `README.md` and `BUILD_PROGRESS.md` with implemented behavior and evidence. Do not claim broad-provider or W04 work.

Files: `src/cli.js`, `src/domain-tools.js`, `src/tui-model.js`, `src/tui.js` only if a visible label is needed, `scripts/smoke.js`, `README.md`, `BUILD_PROGRESS.md`.

## 7. Acceptance IDs and exact future test titles

Each line below is both an acceptance ID and the exact full `node:test` title.

| ID | Exact future behavioral test title | Contract defended |
|---|---|---|
| W03-HTTP-01 | `W03-HTTP-01 retries 429 and 503 within the shared request and time budgets` | Bounded transient recovery; attempts consume budget |
| W03-HTTP-02 | `W03-HTTP-02 honors safe Retry-After values and never retries early after an excessive delay` | Delta/date parsing; safe maximum; no server-abusive clamp |
| W03-HTTP-03 | `W03-HTTP-03 falls back deterministically for invalid or past Retry-After values` | Invalid/past header handling and deterministic fallback |
| W03-HTTP-04 | `W03-HTTP-04 never retries non-retryable HTTP statuses` | Only 429/503 are retried |
| W03-HTTP-05 | `W03-HTTP-05 preserves credential DNS SSRF redirect timeout and request-budget controls across retries` | Existing network protections remain intact |
| W03-ISO-01 | `W03-ISO-01 isolates a bad result and imports and scores later results` | Per-result liveness/import/score isolation |
| W03-ISO-02 | `W03-ISO-02 skips scoring an expired middle result and still scores the later active result` | Expiration is isolated without aborting the loop |
| W03-RUN-01 | `W03-RUN-01 reports partial when child errors uncertainty or truncation accompany durable results` | Child failures and ambiguous liveness cannot yield full success |
| W03-RUN-02 | `W03-RUN-02 reports failed without durable progress and succeeded for a clean empty source` | Exact run-status reduction |
| W03-RUN-03 | `W03-RUN-03 propagates partial through run-all daily scheduler persistence and audit output` | `derivedStatus` and partial audit vocabulary |
| W03-FIELD-01 | `W03-FIELD-01 round-trips native compensation work model employment type and department` | Adapter → SQLite → YAML → JSON preservation |
| W03-FIELD-02 | `W03-FIELD-02 refresh preserves prior native fields when a later source omits them` | Dedupe refresh is non-destructive |
| W03-COMPAT-01 | `W03-COMPAT-01 opens legacy jobs as unchecked uncertain without network migration or identifier changes` | Mandatory legacy liveness deserialization |
| W03-FILTER-01 | `W03-FILTER-01 applies deterministic recency filtering and rejects unknown dates only when requested` | Recency semantics |
| W03-FILTER-02 | `W03-FILTER-02 combines remote and employment-type filters with existing keyword and location filters` | Remote/type normalization and AND/OR precedence |
| W03-LIVE-01 | `W03-LIVE-01 classifies current ATS listings and explicit apply controls as active` | Positive liveness evidence without redundant fetch |
| W03-LIVE-02 | `W03-LIVE-02 classifies closure status text and redirects away from a direct posting as expired` | Definitive expiration evidence |
| W03-LIVE-03 | `W03-LIVE-03 classifies anti-bot rate-limit timeout and ambiguous pages as uncertain` | Anti-bot ambiguity never becomes expired |
| W03-GATE-01 | `W03-GATE-01 checks liveness before score and pursuit and stops known-expired jobs` | No downstream work begins for known-expired posting |
| W03-GATE-02 | `W03-GATE-02 preserves manual imports and surfaces uncertain liveness without auto-archiving` | Local/manual compatibility and soft uncertainty gate |
| W03-GATE-03 | `W03-GATE-03 reuses fresh liveness and refreshes stale public evidence before score or pursuit` | Exact 24-hour boundary and standalone budget |
| W03-HANDOFF-01 | `W03-HANDOFF-01 exposes posting-liveness v1 separately from candidate fit` | Required persisted/domain W04 handoff without fit math |
| W03-SAFETY-01 | `W03-SAFETY-01 preserves provenance dedupe repost review queues and zero external side effects` | Existing product and safety invariants |

## 8. Critic-first test strategy and fixtures

The critic/advisor owns or explicitly locks tests before implementation. Tests assert observable contracts, not source text or private helper names.

Plan validation used two narrow read-only scouts: one reconciled the contract against the authority chain, and one mapped acceptance IDs to deterministic fixtures/current dependency-injection seams. The primary agent reviewed their findings, rejected over-broad recommendations, and retained every final contract decision. The same cost-saving pattern is required by the future OMP `/goal` loop in §10.

### Deterministic fixtures

- `retry-429-then-200`: response queue with delta-seconds `Retry-After`, captured attempts/sleeps, and before/after request/time-budget snapshots.
- `retry-503-date-then-200`: fixed clock plus HTTP-date header.
- `retry-after-invalid`, `retry-after-past`, and `retry-after-excessive`: fallback timing and the typed `retry_after_exceeds_limit` result.
- `non-retryable-statuses`: `400`, `401`, `403`, `404`, and `500`, each with an unused success response that proves no retry occurred.
- `redirect-public`, `redirect-private`, `credentialed-url`, mixed public/private DNS answers, timeout, and request-limit queues.
- `greenhouse-rich.json`, `lever-rich.json`, `ashby-rich.json`, and `career-page-rich.html` under `tests/fixtures/discovery-integrity/`, using verified provider-native shapes for compensation/workplace/employment/department fields actually exposed by each source.
- Jobs dated inside, outside, unknown, invalid, and in the future relative to an injected clock.
- Active page with an explicit application control; closure-text page; direct-posting redirect to generic listing; generic `200`; CAPTCHA/challenge/access-denied pages.
- A three-result run where result 1 succeeds, result 2 throws during import or score, and result 3 succeeds. `runSavedSearch` accepts narrow injected `importJob`, `scoreJob`, and `checkLiveness` dependencies for deterministic orchestration tests while production defaults remain the real functions.
- A second three-result run where result 2 is definitively expired and result 3 remains active.
- Portfolio result with jobs plus `metadata.errors`/truncation; a clean empty adapter result; and an all-results-fail result.
- A generated legacy SQLite store lacking W03 columns. It remains test-local and is never committed as runtime state.

### Test discipline

- Inject fetch, lookup, sleep, and clock. No acceptance test uses the public network or real waiting.
- Assert retries do not bypass DNS/redirect validation and do not exceed request/time budgets.
- Assert exact status/count/error shapes at saved-search, daily, scheduler, workspace, and domain-tool boundaries.
- Assert structured native values survive a store close/reopen and workspace regeneration.
- Assert plausible bugs: off-by-one retry, early retry after excessive `Retry-After`, retry sleep beyond deadline, object errors serialized as `[object Object]`, loop abort after result 2, metadata error with `succeeded`, field erasure on refresh, ambiguous `200` marked active, anti-bot marked expired, expired job scored, dry-run writes liveness, or scheduler wrapper reports success.
- Keep W04 math assertions out. Gate tests may spy that `score` was not entered for expired jobs, but do not assert dimension values or calibration.

## 9. Exact verification commands for implementation

Run in this order after implementation, not during this planning-only brief.

```bash
node --test tests/discovery-integrity.test.js
node --test tests/sprint6-discovery.test.js tests/discovery-watchlist-consolidation.test.js tests/sprint5-integration-eval.test.js tests/sprint7-scheduler.test.js tests/lean-cli-advisor.test.js
npm test
npm run smoke
npm run jobos -- agent-guide --json
```

Runtime proof required from the smoke output:

- one rich ATS fixture run is `succeeded` and its normalized native fields survive SQLite/workspace round-trip;
- one mixed-result fixture run is `partial`, imports a later result after a child failure, and records structured errors;
- one active, one expired, and one anti-bot-uncertain liveness result are visible;
- the expired result is not scored/pursued;
- every discovery/automation record reports `external_side_effects: none` and no application/outreach submission occurs.

Full-suite or smoke failures caused by the contract change must be fixed before convergence; tests are not weakened to preserve dishonest legacy status.

## 10. OMP `/goal` loop with a two-iteration convergence cap

This protocol starts only after human approval and an explicit OMP `/goal` outside this planning turn.
The primary agent retains every final contract, schema, gate-policy, decomposition, shared-file integration, and convergence decision. Subagents are strategic and cost-saving, never a broad swarm: use narrow scouts for read-only fixture/caller inventory, a critic/advisor to author or lock acceptance tests and review convergence, and bounded implementation agents only for independent file slices after contracts are frozen. Do not assign the same research or implementation slice twice, and do not delegate the final W03/W04 boundary or merge decision.

The future OMP command/prompt must preserve this contract:

```text
/goal Execute the human-approved W03_DISCOVERY_INTEGRITY_IMPLEMENTATION_PLAN.md.
Primary agent owns final contracts, shared-file integration, and verification.
Use narrow cost-saving subagents only for independent fixture inventory, acceptance-test locking,
bounded non-overlapping implementation slices, and independent critique. Critic/advisor locks tests
before product implementation. Stop early on convergence; cap the loop at two iterations and report
not converged after iteration 2. Preserve all W03 scope, non-goals, W01 coordination, and evidence commands.
```

### Iteration 1

1. Primary agent freezes the §5 contracts and assigns narrow, non-overlapping work only.
2. A critic/advisor authors or locks all §7 tests and fixtures first; a read-only scout may inventory existing fixtures/callers to avoid duplicate test setup.
3. After tests are locked, bounded implementation agents may handle genuinely independent Phases 1–3 slices while the primary agent owns shared interfaces and Phase 4–6 integration. No agent receives a broad “implement W03” assignment.
4. The primary agent integrates changes and runs the targeted commands, full suite, and smoke commands in §9 once.
5. The critic independently reviews contract shapes, error/status reduction, safety invariants, W04 boundary, migration compatibility, and runtime evidence.
6. If every acceptance ID passes and the critic has no contract-level finding, report `converged in iteration 1` and stop. Do not run a second iteration.

### Iteration 2, only if needed

1. Critic/advisor maps every remaining failure to an existing acceptance ID and locks any correction to the test only when iteration 1 exposed a genuine contract ambiguity; implementation convenience is not a reason to weaken a test.
2. Primary agent assigns only the bounded, non-overlapping corrections that benefit from delegation; it keeps contract changes and shared-file conflict resolution.
3. Make only the corrections needed for those findings.
4. Rerun all §9 commands once and obtain independent critic review.
5. If all acceptance IDs pass, report `converged in iteration 2` and stop.
6. Otherwise stop after iteration 2 and report `not converged`, including failing acceptance IDs, exact commands/output, incomplete contract points, and blockers. There is no silent third iteration and no merge-ready claim.

## 11. Likely files touched and conflict risks

| File | Planned reason | W01/merge risk |
|---|---|---|
| `src/discovery/http.js` | New shared safe request/retry/budget primitive | New W03-owned file; low |
| `src/discovery/liveness.js` | New liveness classifier/serializer | New W03-owned file; low |
| `src/discovery/adapters.js` | HTTP extraction, field normalization, filters, liveness hints | No current uncommitted W01 edit observed; low |
| `src/discovery.js` | Run budget, result isolation, partial contract | No current uncommitted W01 edit observed; medium because branches diverged from different bases |
| `src/db.js` | New job columns and migrations | **High:** active W01 has uncommitted schema/migration additions |
| `src/jobs.js` | Import/update/round-trip new fields | **High:** active W01 edits the same `importNormalized` insert/update statements for requirement inventory |
| `src/scoring.js` | Pre-score liveness gate only | **Medium/high:** W01 adds requirement helpers/imports; W03 must not touch fit math |
| `src/workflows.js` | Pre-pursuit gate and daily aggregate status | Low direct W01 overlap observed |
| `src/scheduler/actions.js`, `src/scheduler/core.js` | Propagate aggregate partial status | Low direct W01 overlap observed |
| `src/cli.js` | Filter flags and serialized command surface | **High:** active W01 has substantial uncommitted CLI registry/handler changes |
| `src/domain-tools.js` | Liveness/native-field output | Medium; branch-level overlap exists even though no current uncommitted edit was observed |
| `src/tui-model.js` | Selected/list job liveness/native fields | **Medium:** active W01 changes requirement projection here |
| `src/tui.js` | Only if a visible liveness label is needed | Low current uncommitted overlap; avoid if model output suffices |
| `src/analytics.js` | Exclude known-expired recommendations | **Medium:** active W01 currently modifies this file |
| `scripts/smoke.js` | W03 runtime proof | **High:** active W01 currently modifies smoke |
| `tests/discovery-integrity.test.js` and fixtures | W03 acceptance suite | New W03-owned files; low |
| existing discovery/workflow/scheduler tests | Compatibility and wrapper status | Medium; keep additions narrow |
| `README.md`, `BUILD_PROGRESS.md` | Post-proof user/status reconciliation | High shared-doc churn; last only |

Observed W01 state on 2026-07-22:

- `fix-tailored-resume` is based on common ancestor `3eba22e`, not W03 baseline `8191de3`.
- Its worktree currently has 14 modified and 7 untracked files.
- Direct shared uncommitted files include `src/cli.js`, `src/db.js`, `src/jobs.js`, `src/scoring.js`, `src/tui-model.js`, `src/analytics.js`, and `scripts/smoke.js`.
- Its `src/db.js` adds resume/proof tables and migrations; `src/jobs.js` edits the same import insert/update statements; `src/scoring.js` and `src/tui-model.js` consume a new requirement inventory.

Conflict-control decision:

1. Complete W03 Phases 0–3 only in W03-owned files if implementation starts before W01 freezes; any Phase 2/3 edit to a shared High/Medium-risk file waits.
2. Do not edit any High/Medium-risk shared file in Phases 4–6 until W01 publishes a stable commit and W03 implementation is rebased onto it.
3. Recommended order: land/freeze W01, rebase W03 implementation onto that result, then apply W03 schema/import/gate changes once. This avoids manually merging two independently edited long SQL statements and two migration lists.
4. Preserve W01's requirement inventory and document contracts verbatim; W03 only adds discovery fields and liveness gates.
5. Keep W03 documentation cleanup last to reduce board/README/BUILD_PROGRESS conflicts.

## 12. Human approvals required before implementation

1. **Approve the uncertainty gate policy.** Recommended: `expired` hard-stops score/pursuit; `uncertain` remains a visible soft gate that can proceed for human-requested local work, makes automated mixed runs `partial`, and is never auto-archived. A hard block for all uncertain/manual jobs would break existing local text-import pursuit and needs an explicit override design.
2. **Approve the W01/W03 merge order.** Recommended: W01 freezes/lands its uncommitted shared-file work before W03 edits any High/Medium-risk shared file in Phases 4–6; W03 may implement only non-overlapping W03-owned slices beforehand.
3. **Approve the persisted normalized shape.** Recommended: retain legacy `compensation`/`work_model` projections and add structured/native JSON columns rather than changing existing field types.

No provider, credential, proxy, CAPTCHA, external-action, candidate-fit, or calibration decision is required for W03.

## 13. Approval gate

After reviewing the contracts, phases, acceptance IDs, and three decisions above, a human must explicitly approve this plan before OMP `/goal` or any product implementation begins.

## 14. Execution checkpoint at the W01 boundary

**Recorded:** 2026-07-22 on `fix/discovery-integrity`.

The independent Phase 0–3 slice is complete:

- critic-locked deterministic fixtures and behavioral tests cover `W03-HTTP-01`–`W03-HTTP-05`, `W03-FILTER-01`–`W03-FILTER-02`, and `W03-LIVE-01`–`W03-LIVE-03`;
- `src/discovery/http.js` centralizes the preserved public-URL, credential, DNS/SSRF, redirect, timeout, retry, and shared-budget controls;
- existing adapters normalize structured compensation, work model, employment type, department, source-native fields, and current-listing hints without inferring absent native data from prose;
- `src/discovery/liveness.js` returns the separate versioned `active | expired | uncertain` assessment without persistence, fit-score mutation, or external side effects;
- iteration 1 found three bounded defects: over-broad closure tokens, active/expired conflict precedence, and lost `DiscoveryLimitError` identity. Those defects were corrected and defended by new behavioral cases;
- iteration 2 critic review returned `CONVERGED`;
- `node --test tests/discovery-integrity.test.js` passes 12/12;
- `node --test tests/sprint6-discovery.test.js` passes 6/6; the existing watchlist consolidation cases also passed in the combined compatibility run.

At that checkpoint W01 was still unstable, so no Phase 4–6 High/Medium-risk shared file had been edited and the remaining acceptance IDs were dependency-gated. The branch was later rebased onto the integrated W01 base before those phases began; Section 15 records their completed evidence.

## 15. Final implementation evidence

**Recorded:** 2026-07-22 after rebasing onto the integrated W01 base.

All remaining Phase 4–6 acceptance IDs are complete:

- `W03-FIELD-01`–`W03-FIELD-02`: native compensation, work model, employment type, department, source-native fields, and liveness evidence round-trip through SQLite, workspace YAML, refresh, dedupe, CLI, domain, and TUI projections;
- `W03-COMPAT-01`: legacy rows migrate to explicit unchecked/uncertain liveness without network access, identifier changes, or automatic archival;
- `W03-ISO-01`–`W03-ISO-02`: each discovered result isolates liveness, import, and score failures so later results continue; known-expired results are skipped without suppressing later active results;
- `W03-RUN-01`–`W03-RUN-03`: durable progress plus uncertainty, truncation, or child errors yields `partial`; zero-progress errors yield `failed`; clean empty sources yield `succeeded`; run-all, daily, scheduler records, audit events, and workspace mirrors preserve the reduction;
- `W03-GATE-01`–`W03-GATE-03`: score and pursue resolve liveness before candidate work, hard-stop known-expired jobs without archiving them, permit uncertain/manual jobs with visible warnings, and reuse evidence younger than 24 hours;
- `W03-HANDOFF-01`: `jobos.posting-liveness.v1` is exposed separately from fit and never changes fit dimensions, overall score, penalties, or boosts;
- `W03-SAFETY-01`: provenance, source history, repost identity, review queues, profile isolation, W01 artifact/packet/readiness contracts, and `externalSideEffects: "none"` remain intact.

The Phase 4–6 convergence protocol stopped after the allowed second iteration:

1. Critic iteration 1 found two contract defects: a truncation-only run could reduce to `succeeded`, and saved-search orchestration did not install one run-level budget shared by adapter and liveness calls.
2. Both defects were corrected and defended by targeted regression cases.
3. Critic iteration 2 returned `CONVERGED` with no residual defects.

Observed verification:

- combined W03 suites: **25/25 passed**;
- Sprint 6 discovery, watchlist consolidation, integration evaluation, scheduler, and lean-CLI compatibility suites: **62/62 passed**;
- full `npm test`: **265/265 passed**;
- `npm run smoke`: passed in a clean temporary workspace with fixture-backed active/expired/uncertain discovery, expired score/pursuit hard stops, scheduler propagation, preserved W01 application/packet flow, and zero external effects;
- `npm run jobos -- agent-guide --json`: discovery flags and command shapes are present in the machine-readable registry.

No W03 acceptance ID is intentionally deferred. Integration-owner merge and merged-runtime verification remain; downstream W04 must consume posting liveness as a separate legitimacy input rather than candidate-fit math.
