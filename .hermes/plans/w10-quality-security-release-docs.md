# W10 — Quality, security, release, and documentation hygiene implementation plan

> **For Hermes:** Execute this plan task-by-task using strict RED → GREEN → REFACTOR TDD. Do not combine the RED phase of one task with another task, and preserve the existing product/domain boundaries.

**Goal:** Produce reproducible, no-deploy release evidence for the integrated W01–W09 JobOS behavior, add narrow security/dependency/generated-user-data leak gates, and reconcile public operator documentation with the shipped packet/receipt and Career Memory contracts.

**Architecture:** W10 adds release-quality harnesses and immutable, fixture-backed behavioral snapshots around existing real JobOS APIs, CLI subprocesses, SQL.js persistence, workspace mirrors, MCP framing, and smoke flow. It must not change product behavior, schema, state ownership, or mediation. Golden fixtures are generated only in temporary test/release directories; their public expected projections are checked into `tests/fixtures/w10/`, while raw runtime state and any secret-bearing source fixture stay untracked.

**Tech stack:** Node.js 22 ESM; Node built-in test runner; SQL.js; npm lockfile/audit; GitHub Actions; existing `scripts/smoke.js`, `scripts/mcp-demo.js`, and `tests/` helpers.

---

## Audit baseline and frozen scope

The integrated base is `17dd2d5` (`merge: integrate verified W09 guided onboarding`). Existing `quality.yml` runs only `npm ci`, the full suite, and smoke; it has no dedicated release-evidence artifact, dependency gate, generated-user-data scan, or docs-status assertion. Current test coverage already contains real W01/W02 packet/receipt/redaction tests, W03 discovery partial/liveness tests, W04 fit consistency tests, W05 contact tiers, W06 lifecycle, W07 provenance, W08 Career Memory tests, W09 setup tests, MCP framing, and smoke. W10 composes those contracts; it does **not** replace them with mocks or duplicate their domain implementation.

Current external MCP is intentionally narrow and handwritten in `src/mcp.js`, hard-codes protocol `2024-11-05`, sends the existing `DOMAIN_TOOLS` definitions, and has framing/mediation tests. The repository has no demonstrated incompatibility, upgrade failure, unrepresentable tool schema, or maintenance incident. Therefore the default W10 decision is **no MCP SDK migration**. Do not add `@modelcontextprotocol/sdk`, change the protocol, or rewrite transport merely because an SDK exists.

**Non-goals:** no product redesign; no schema migration; no new web/API surface; no telemetry or cloud service; no release/deploy/publish/tag/push; no committed `.jobos/`, `jobos-workspace/`, `.env*`, browser state, SQLite database, or release output; no broad suite from an individual implementation task except the final CI/release gate.

## Frozen W10 contracts

### Golden contract families

Add public, canonical JSON fixtures with fixed IDs and injected `asOf` timestamps. Each fixture contains only assertions/projections that are already safe to expose. Golden comparison must use sorted-key canonical JSON and reject a fixture update unless the test name/contract change is reviewed deliberately.

| Family | Real path and required stable assertions |
|---|---|
| `document-completeness` | W01 current resume/proof/artifact/readiness path: exact validity/blocker and artifact-review state; no resume/proof plaintext in summary. |
| `score-stability` | W03 current job + W04 fit projection with fixed clock: same inputs produce byte-identical canonical score/explanation fields; expired/uncertain liveness remains a visible gate, never silently changes fit math. |
| `contact-tiering` | W05 contact projections: supported, stale, catch-all, generated, suppressed, and unrelated-domain cases retain their current tier/usability boundary. |
| `discovery-partials-liveness` | W03 fake adapters: one source succeeds while another fails/backs off; final reduction is `partial`, surviving jobs remain attributable, and expired vs uncertain liveness stays distinct. |
| `packet-bound-browser-outcome` | W02 inspect → approved readiness → packet → configured mediated fill/submit → adapter/manual outcome path: public result binds packet ID/hash/fingerprint/receipt state, never answer values, URL query secrets, browser state, cookie, locator secret, or confirmation secret. Confirm MCP/ACP may use the existing configured mediation path, while human-authority mutations (approval/rejection, restricted answers, packet/receipt attestation/confirmation, and Career Memory transitions) remain denied to agent sources. |

**Task 2-only Career Memory families (not a Task 1 RED/GREEN input):**

| Family | Real path and required stable assertions |
|---|---|
| `career-memory-provenance` | W08 observation → evidence → proposal → accepted rule → retrieval/projection. Every returned rule cites source observation/entity/version/hash; private note sentinel and arbitrary payload keys never enter retrieval, projection, CLI/MCP text, audit, or mirror. |
| `career-memory-reversibility` | W08 accepted proposal changes a relevant retrieval only while active; revoke and undo/replay restore the exact prior active-rule/retrieval projection without deleting observation, evidence, or transition history. Include a conflict/inactive proposal that never affects retrieval. |
| `career-memory-isolation` | Alpha/Beta records with deliberately distinct observation/proposal/private-note sentinels: retrieval, mirror, CLI/domain response, audit summaries, and projection sources for Alpha contain no Beta IDs/content and cross-profile references fail with the existing typed error and zero writes. |

### Release-evidence contract

`npm run release:evidence` must be an offline/no-deploy, fresh-temporary-directory command. It writes a deterministic `release-evidence.json` plus JUnit-free human-readable summary under a caller-selected ignored output directory (default `./.tmp/release-evidence`), never `.jobos/` or `jobos-workspace/`. It records: Node/npm versions, git commit, `package-lock.json` SHA-256, command argv and exit status, fixture-manifest SHA-256, golden test result/count, focused security/leak/dependency/doc checks, smoke result, and UTC generated-at timestamp. The timestamp may vary; all contract inputs/results must be deterministic. It must refuse an output directory under tracked runtime paths and fail if output is not ignored or if a required check is absent/fails. It must not run deploy, publish, release, tag, push, network product actions, or mutate canonical workspaces.

Its schema has a required `checks` object with individually recorded `{ argv, cwd, exitCode, status, outputPath }` entries for `goldens`, `security`, `docsStatus`, `mcpFraming`, `mcpCompatibility`, `mcpDecision`, `smoke`, and `dependencyAudit`; `mcpDecision` records the decision-document assertion as well as the compatibility drill. `docsStatus`, `mcpFraming`, `mcpCompatibility`, and `mcpDecision` are required release gates—not narrative follow-ups or fields inferred from a broad `npm test` result.

### Security/dependency/generated-user-data contract

1. `npm ci --ignore-scripts` verifies a clean lockfile install in CI; release evidence uses the already-installed dependencies and does not rewrite the lockfile.
2. `npm audit --omit=dev --audit-level=high` runs as a separate, explicitly reported dependency gate. A registry/network failure is **inconclusive/failing release evidence**, not a passing zero-vulnerability result. Pin the command and its JSON artifact/exit classification; do not suppress advisories.
3. A tracked-file guard rejects `.jobos/`, `jobos-workspace/`, `*.sqlite`, `*.sqlite-*`, `.env`, `.env.*` (except documented safe examples if ever added), browser storage/cookie exports, and `release-evidence/` paths in `git ls-files`. The sole SQLite allowlist is the existing test-only schema seed databases matched by `tests/fixtures/*-schema*.sqlite`: `tests/fixtures/w06-schema12.sqlite`, `tests/fixtures/w07-schema13.sqlite`, and `tests/fixtures/w08-schema14.sqlite`; all other SQLite databases and sidecars remain forbidden. The guard must also ensure `.gitignore` contains the runtime state patterns.
4. `tests/fixtures/w10/sentinel-leak-fixture.js` is the sole sentinel source: it creates one deterministic W02 temporary workspace plus a copied W08 schema-14 temporary database and injects distinct exact values for `CM_PRIVATE_NOTE_SENTINEL`, `CM_PRIVATE_PAYLOAD_SENTINEL`, `RESTRICTED_ANSWER_SENTINEL`, `URL_USERINFO_QUERY_SENTINEL`, `BROWSER_COOKIE_STATE_SENTINEL`, `ACP_STDERR_TRANSCRIPT_SENTINEL`, and `FORM_LOCATOR_CONFIRMATION_SENTINEL`. It invokes the real public Career Memory retrieval/mirror/domain and CLI JSON projections; real MCP `initialize`, `tools/list`, `tools/call(score_job)`, and `tools/call(get_job_context)` frames; the existing ACP transcript/redaction path; and configured form fill/submit mediation without asserting that an agent may perform a denied human mutation. Scan exact sentinel strings in candidate golden JSON/manifest, CLI stdout/stderr, MCP summary/transcript/stderr, ACP transcript/stderr, public mirror/projection files, audit summaries, security-check JSON, `release-evidence.json`, its human summary, and every subprocess artifact under the release output root. The sentinels are forbidden in checked-in `tests/fixtures/w10/**`, `.tmp/release-evidence/**`, all release/security/MCP/ACP artifacts, stdout/stderr/transcripts, mirrors, audit output, and JSON/YAML/text projections; they may exist only in the named temporary fixture inputs and raw temporary database/browser-state files, which are deleted and never copied. This is a containment test, not a regex-only source scan.
5. A narrow static policy guard scans tracked source/config/workflow/script files for direct `console.log`/`process.stdout.write` of known raw secret-bearing fields only where current redaction helpers should mediate; exact allowed sites must be documented in the test to prevent false safety claims. It does not attempt a general secret scanner or alter runtime code.

## Implementation tasks

### Task 1: Add the W10 fixture manifest and canonical comparison helper

**Objective:** Establish one public fixture manifest and deterministic serializer without duplicating W01–W09 behavior.

**Files:**
- Create: `tests/fixtures/w10/manifest.json`
- Create: `tests/w10-golden.test.js`
- Create: `tests/helpers/w10-golden.js` (only if existing test helpers cannot host the serializer/temporary-workspace setup)

**Ownership boundary:** Task 1 owns only `document-completeness`, `score-stability`, `contact-tiering`, `discovery-partials-liveness`, and `packet-bound-browser-outcome`. It must not create, register, load, seed, name, or execute any `career-memory-*` fixture or test; those three families are exclusively Task 2 work and cannot appear in Task 1 RED/GREEN output.

**Step 1 — RED:** Add `tests/w10-golden.test.js` with one `test()` for each Task 1-owned family only. Initially load a nonexistent manifest entry and assert the intended canonical expected projection so every test fails specifically with `W10 fixture missing`.

**Step 2 — verify RED:**
```bash
node --test --test-concurrency=1 tests/w10-golden.test.js
```
Expected: each named `W10-GOLDEN-*` test fails because its fixture/manifest entry is absent, not because an import, clock, or test harness is malformed.

**Step 3 — GREEN:** Create `manifest.json` with Task 1 entries only, the corresponding non-Career-Memory fixture JSON files, and the smallest helper that: creates real temporary workspaces; copies only existing non-W08 seed fixtures; injects fixed `asOf`; calls existing services/CLI/MCP framing; canonicalizes JSON recursively with sorted object keys; and compares exact safe public projections. Name each fixture with its contract family and source W-wave. Do not pre-create placeholders for Task 2.

**Step 4 — verify GREEN:**
```bash
node --test --test-concurrency=1 tests/w10-golden.test.js
```
Expected: all `W10-GOLDEN-*` tests pass. Re-run the same command once and confirm byte-identical expected/output comparison rather than updating fixtures.

**Step 5 — REFACTOR:** Deduplicate fixture loading/canonicalization only after all tests are green. Keep fixtures human-reviewable and exclude raw SQLite/runtime data.

**Step 6 — commit:**
```bash
git add tests/fixtures/w10 tests/w10-golden.test.js tests/helpers/w10-golden.js
git commit -m "test: add W10 cross-bundle golden fixtures"
```

### Task 2: Add explicit Career Memory provenance, reversibility, and isolation goldens

**Objective:** Make W08’s most release-sensitive trust boundaries independently replayable with real storage and history. Task 2 begins only after Task 1 is GREEN/committed; it exclusively adds the three `career-memory-*` manifest entries, fixtures, seed helpers, and tests.

**Files:**
- Modify: `tests/w10-golden.test.js`
- Create: `tests/fixtures/w10/career-memory-provenance.json`
- Create: `tests/fixtures/w10/career-memory-reversibility.json`
- Create: `tests/fixtures/w10/career-memory-isolation.json`

**Step 1 — RED:** Add the three manifest entries and three separate tests, named `W10-GOLDEN-CM-01 provenance remains attributable and private-data-free`, `W10-GOLDEN-CM-02 revoke and undo restore active behavior without deleting history`, and `W10-GOLDEN-CM-03 profile isolation rejects cross-profile data with zero delta`. Assert provenance source IDs/version/hash, active-rule before/after/replay comparison, append-only row counts, cross-profile typed error, and sentinel absence. Do not mock retrieval/proposal/observation modules.

**Step 2 — verify RED:**
```bash
node --test --test-concurrency=1 tests/w10-golden.test.js --test-name-pattern="W10-GOLDEN-CM"
```
Expected: each fails because its exact fixture/projection is absent; an immediately passing test is invalid and must be strengthened.

**Step 3 — GREEN:** Seed real W08 schema-14 temporary databases from `tests/fixtures/w08-schema14.sqlite`; use existing `career-memory-observations`, `career-memory-proposals`, retrieval, mirror, domain/MCP helpers; add only test fixture/projection code. Snapshot counts before each denied cross-profile action and assert zero deltas across observations, proposals, evidence, transitions, projections, and audit rows.

**Step 4 — verify GREEN:**
```bash
node --test --test-concurrency=1 tests/w10-golden.test.js --test-name-pattern="W10-GOLDEN-CM"
node --test --test-concurrency=1 tests/w08-career-memory.test.js tests/w08-career-memory-retrieval.test.js tests/w08-career-memory-mirrors.test.js
```
Expected: W10 CM goldens and the targeted W08 compatibility tests pass.

**Step 5 — REFACTOR:** Keep the fixture’s public projection limited to IDs/hashes/statuses/counts. Never add a production export flag or weaken private-note storage to make it observable.

**Step 6 — commit:**
```bash
git add tests/w10-golden.test.js tests/fixtures/w10/career-memory-*.json
git commit -m "test: lock Career Memory release boundaries"
```

### Task 3: Add release security, dependency, tracked-data, and generated-data leak gates

**Objective:** Fail release evidence on actual leak paths, committed runtime data, or unresolved production dependency risk.

**Files:**
- Create: `tests/w10-security-release.test.js`
- Create: `tests/fixtures/w10/sentinel-leak-fixture.js`
- Create: `scripts/check-release-security.js`
- Modify: `.gitignore` only if Task 3’s RED test proves a required runtime artifact pattern is missing
- Modify: `package.json`

**Step 1 — RED:** Add the deterministic `sentinel-leak-fixture.js` named in the frozen security contract, then write real tests for (a) its exact sentinel containment across SQL.js/audit/mirror/CLI/MCP/ACP/release projection outputs and every named forbidden destination, (b) tracked-file/runtime ignore guard, including the frozen contract’s narrow allowlist for the three existing `tests/fixtures/*-schema*.sqlite` seed databases and rejection of every other SQLite database or sidecar, (c) static raw-secret output guard with narrow allowlist, (d) deterministic release-evidence schema—including each required `checks` entry—and no-deploy command allowlist, and (e) audit-result classification. Begin with nonexistent `scripts/check-release-security.js` / `release:evidence` and assert their required JSON contracts.

**Step 2 — verify RED:**
```bash
node --test --test-concurrency=1 tests/w10-security-release.test.js
```
Expected: failures identify missing script/package command/gate; do not accept unrelated test errors or an audit network result as a test pass.

**Step 3 — GREEN:** Implement `check-release-security.js` as a read-only checker with `--format json --output <ignored-dir>` that uses `git ls-files`, `.gitignore`, the named controlled temporary sentinel fixture, and explicit sentinel scans across exactly the contract-listed artifacts. Add npm scripts:
```json
"check:release-security": "node scripts/check-release-security.js --format json",
"test:w10": "node --test --test-concurrency=1 tests/w10-golden.test.js tests/w10-security-release.test.js",
"release:evidence": "node scripts/release-evidence.js"
```
Implement `scripts/release-evidence.js` only after its test is red: it invokes focused commands with `spawnSync` argument arrays, writes all output below its ignored output root, captures audit JSON/nonzero/network-inconclusive outcome, and exits nonzero if any required gate is not `passed`. Its subprocess list must include exactly `node --test --test-concurrency=1 tests/w10-docs-status.test.js` for `docsStatus`; `node --test --test-concurrency=1 tests/mcp-framing.test.js` for `mcpFraming`; `node --test --test-concurrency=1 tests/w10-mcp-compatibility.test.js --test-name-pattern="W10-MCP-COMPAT"` plus the seeded supported `scripts/mcp-demo.js` invocation for `mcpCompatibility`; and `node --test --test-concurrency=1 tests/w10-mcp-compatibility.test.js --test-name-pattern="W10-MCP-DECISION"` for `mcpDecision`. Record each command and its captured output under the exact `checks` key defined above. It must use a subprocess cwd temporary workspace for smoke and MCP seeding and never initialize a repository-root `.jobos/` or mirror.

**Step 4 — verify GREEN:**
```bash
node --test --test-concurrency=1 tests/w10-security-release.test.js
npm run check:release-security -- --format json --output .tmp/w10-security-check
```
Expected: tests pass and the JSON reports tracked-data, ignore, sentinel, and static-policy results. Confirm `git status --short` contains no runtime state/output.

**Step 5 — dependency gate:**
```bash
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high --json > .tmp/w10-npm-audit.json
node scripts/release-evidence.js --output .tmp/w10-release-evidence --skip-audit
```
Expected: clean install succeeds; audit result is recorded exactly (a high vulnerability or audit transport failure blocks release rather than being hidden); the `--skip-audit` path is test-only and stamped `inconclusive`, never release-pass; release-evidence validates all local/no-deploy gates and leaves only ignored `.tmp/` output.

**Step 6 — REFACTOR:** Prefer one explicit policy table for forbidden tracked paths/sentinel destinations/allowed raw-output sites. Do not add a secret scanning SaaS, broad ignore pattern that hides source fixtures, or runtime logging changes unless a failing concrete test proves one is needed.

**Step 7 — commit:**
```bash
git add package.json package-lock.json scripts/check-release-security.js scripts/release-evidence.js tests/w10-security-release.test.js .gitignore
git commit -m "build: add W10 release security evidence"
```

### Task 4: Wire CI without deploying and correct operator documentation/build status

**Objective:** Make CI run the release gates and make README/build status describe only shipped contracts.

**Files:**
- Modify: `.github/workflows/quality.yml`
- Modify: `README.md`
- Modify: `BUILD_PROGRESS.md`
- Create: `tests/w10-docs-status.test.js`
- Modify: `package.json` only if a dedicated docs check script is useful

**Step 1 — RED:** Add docs-status tests that parse source documents and assert: README describes packet v2/receipt states; it accurately says MCP/ACP can use only the existing configured mediated fill/submit path and cannot perform human-authority mutations (approval/rejection, restricted-answer, attestation/confirmation, or Career Memory transition); README has a Career Memory section that names provenance, accepted-only effect, revoke/undo, profile isolation, and private-note exclusion; BUILD_PROGRESS no longer claims stale W10-incompatible MCP tool count/test count as current; docs distinguish intentional deferred work from shipped packet/receipt/W08/W09 behavior; no doc promises an MCP SDK migration. Assert workflow uses Node 22, `npm ci --ignore-scripts`, `npm run test:w10`, the explicit docs-status and MCP framing/compatibility commands, `npm run release:evidence`, smoke, and uploads only redacted/public release evidence on failure/success—no deploy/publish/tag/push action.

**Step 2 — verify RED:**
```bash
node --test --test-concurrency=1 tests/w10-docs-status.test.js
```
Expected: fails solely on missing/outdated wording and CI release-gate steps.

**Step 3 — GREEN:** Update `quality.yml` with ordered jobs/steps: clean dependency install; focused W10 goldens/security checks; exact docs-status and MCP framing/compatibility/decision checks; full existing test suite; isolated smoke; release evidence; artifact upload from `.tmp/release-evidence` only. Keep pull-request/push-to-main triggers and do not add credentials or deployment permissions. Correct README and BUILD_PROGRESS using current verified facts; add a concise W10 verification entry that links commands rather than claiming a future test count. Document release invocation, artifact location, audit policy, no-deploy guarantee, configured mediation boundary, and denied human mutations.

**Step 4 — verify GREEN:**
```bash
node --test --test-concurrency=1 tests/w10-docs-status.test.js
npm run test:w10
node scripts/release-evidence.js --output .tmp/w10-release-evidence --skip-audit
```
Expected: all focused tests pass; evidence is structurally complete but marked inconclusive when audit is skipped. Inspect it to confirm no sentinel/raw user data is present.

**Step 5 — REFACTOR:** Keep document tests semantic and bounded (required truthful statements/forbidden stale claims), not whole-file snapshots or a second documentation source of truth.

**Step 6 — commit:**
```bash
git add .github/workflows/quality.yml README.md BUILD_PROGRESS.md tests/w10-docs-status.test.js package.json package-lock.json
git commit -m "docs: publish W10 release contract"
```

### Task 5: Decide MCP migration from measured compatibility evidence

**Objective:** Retain the working handwritten MCP implementation unless an evidenced interoperability/maintenance failure meets a predeclared threshold.

**Files (default/no migration):**
- Create: `docs/mcp-compatibility-decision.md`
- Modify: `tests/mcp-framing.test.js` or create `tests/w10-mcp-compatibility.test.js`
- Modify: `scripts/mcp-demo.js` only to emit machine-readable compatibility evidence from its existing real stdio drill
- Create: `scripts/seed-mcp-demo.js`

**Step 1 — RED:** Add a `W10-MCP-COMPAT` real-client compatibility test requiring `scripts/seed-mcp-demo.js --workspace <temp-workspace>` to create a deterministic temporary workspace with profile ID `w10-mcp-profile` and job ID `w10-mcp-job`, then requiring the existing supported invocation `node scripts/mcp-demo.js --workspace <temp-workspace> --profile w10-mcp-profile --job w10-mcp-job --output <temp-workspace>/mcp-demo-transcript.jsonl --timeout 30000`. The test parses the demo's JSON stdout summary (no unsupported `--json` flag) and requires it to record requested/offered protocol version, initialize/list/call result, framing, catalog count/names, typed errors, and zero leaked sentinel. Add a separate `W10-MCP-DECISION` test requiring `docs/mcp-compatibility-decision.md` to state the tested protocol, current catalog evidence, and exact `Decision: retain handwritten MCP` when the drill passes, so the release `mcpDecision` check is executable. Test the current supported `2024-11-05` client path; no SDK dependency is introduced in RED.

**Step 2 — verify RED:**
```bash
node --test --test-concurrency=1 tests/w10-mcp-compatibility.test.js
```
Expected: fails because the demo lacks the evidence JSON contract, not due to a product protocol failure.

**Step 3 — GREEN:** Add `scripts/seed-mcp-demo.js` as a deterministic temporary-only seed command (fixed profile/job IDs, fixed job text/clock, no repository workspace write) and add only the evidence output capability; preserve raw MCP wire behavior and existing policy catalog. The seed command prints `{ "workspace": "…", "profileId": "w10-mcp-profile", "jobId": "w10-mcp-job" }` to stdout. The demo prints one JSON summary to stdout and writes a redacted JSONL transcript only to its supported `--output` path; the summary must include requested/offered protocol version, frame type, catalog count/names, called-tool results, typed errors, and sentinel-scan result. Migration is authorized **only** when all are true: (1) two independently reproducible real-client compatibility failures, or one supported-client failure plus a maintenance incident that cannot be fixed with a bounded handwritten patch; (2) the failure is attributable to protocol negotiation/schema/transport maintenance rather than JobOS domain policy or test setup; (3) a minimal SDK spike proves the SDK resolves it while preserving all `MCP_DENY` and framing/size/one-request safety tests; (4) the spike includes a dependency/license/security review and a migration rollback path. Otherwise record `Decision: retain handwritten MCP`, current evidence, owner, next re-evaluation trigger, and no migration.

**Step 4 — verify GREEN:**
```bash
node --test --test-concurrency=1 tests/w10-mcp-compatibility.test.js tests/mcp-framing.test.js
MCP_WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/jobos-w10-mcp.XXXXXX")"
node scripts/seed-mcp-demo.js --workspace "$MCP_WORKSPACE"
node scripts/mcp-demo.js --workspace "$MCP_WORKSPACE" --profile w10-mcp-profile --job w10-mcp-job --output "$MCP_WORKSPACE/mcp-demo-transcript.jsonl" --timeout 30000 > "$MCP_WORKSPACE/mcp-demo-summary.json"
rm -rf "$MCP_WORKSPACE"
```
Expected: the seed command reports the fixed temporary IDs; the supported demo invocation exits 0; stdout summary reports `ok: true`, negotiated protocol `2024-11-05`, `score_job` and `get_job_context`, and a redacted transcript path; decision document says retain, not migrate; no MCP SDK appears in `package.json`/lockfile.

**Step 5 — REFACTOR:** If no threshold is met, stop. Do not create an SDK abstraction, adapter, compatibility layer, or migration branch “for later.” If threshold is met, create a separately approved implementation plan; it is outside this W10 execution plan.

**Step 6 — commit:**
```bash
git add docs/mcp-compatibility-decision.md scripts/mcp-demo.js scripts/seed-mcp-demo.js tests/w10-mcp-compatibility.test.js tests/mcp-framing.test.js
git commit -m "docs: record MCP compatibility decision"
```

## Final no-deploy release gate

Run this once in CI or a clean disposable checkout after every task above is green; it is the only W10 broad verification ownership point:

```bash
npm ci --ignore-scripts
npm run test:w10
node --test --test-concurrency=1 tests/w10-docs-status.test.js tests/mcp-framing.test.js tests/w10-mcp-compatibility.test.js
npm test
npm run smoke
npm run release:evidence -- --output .tmp/release-evidence
```

**Expected release evidence:** every command exits 0; `release-evidence.json` records commit/lockfile/fixture hashes, tests, smoke, security guard, dependency audit, and docs/MCP decision checks; its output contains no generated-user-data sentinel; `git status --short` contains only ignored `.tmp/` output; no tag, push, publish, deploy, persistent workspace initialization, or external side effect occurred.

If `npm audit` reports a production high/critical advisory, fails to contact the registry, a leak sentinel appears, or release evidence is incomplete, the release is **blocked**. Record the raw tool status and remediation owner in a tracked issue/CI result; do not downgrade it to a warning or hand-edit a passing artifact.

## File-change inventory

**Expected creates:** `tests/fixtures/w10/*.json`, `tests/fixtures/w10/sentinel-leak-fixture.js`, `tests/w10-golden.test.js`, `tests/w10-security-release.test.js`, `tests/w10-docs-status.test.js`, `tests/w10-mcp-compatibility.test.js`, `scripts/check-release-security.js`, `scripts/release-evidence.js`, `scripts/seed-mcp-demo.js`, `docs/mcp-compatibility-decision.md`.

**Expected modifications:** `package.json`/lockfile only if dependencies or scripts actually change (default: scripts only, no new dependency), `.github/workflows/quality.yml`, `README.md`, `BUILD_PROGRESS.md`, narrowly `scripts/mcp-demo.js`, and `.gitignore` only if red test identifies a missing required runtime-output pattern.

**Must not modify:** JobOS schema/domain implementation (`src/db.js`, Career Memory services, packet/form services), runtime-state files, external transport behavior, or MCP implementation absent the separately proven migration threshold.

## Risks and decisions

- Golden fixtures can become false confidence if derived from live/unfixed time or raw private state. Mitigation: fixed clock, real temporary stores, canonical public projections, fixture hash, and red/green proof before creation.
- `npm audit` depends on registry availability. Mitigation: classify unavailable audit as release-blocking inconclusive evidence, never as clean.
- A “release script” that runs in the repo root could create user state. Mitigation: subprocess temporary cwd, reject output/runtime paths, tracked-file check, and post-run status assertion.
- Docs can drift again. Mitigation: small semantic assertions in CI and a command/result-based BUILD_PROGRESS entry rather than brittle literal suite counts.
- MCP modernization could enlarge risk late in integration. Decision: retain handwritten MCP unless the four-part demonstrated-compatibility threshold is met; a passing current real-client drill is affirmative evidence to defer migration.
