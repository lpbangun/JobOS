# JobOS MVP Final Review Checklist
## Role: advisor/reviewer for plan quality

---

## 1. Tests / Smokes Required Before Shipping

- [ ] **Install/build smoke:** Project installs from clean state (npm/pnpm install or Python venv) with documented env vars.
- [ ] **CLI init smoke:** `jobos init` creates workspace directory and seed files; idempotent re-run does not corrupt state.
- [ ] **Profile smoke:** `jobos profile create <name>` creates profile file; `--from-resume` or manual import falls back gracefully if parser/LLM unavailable.
- [ ] **Job import smokes:**
  - `jobos jobs import-url <url>` creates a Job record and local workspace folder.
  - `jobos jobs import-text --file <path>` parses into canonical Job fields.
  - `jobos jobs list --json` returns parseable JSON.
- [ ] **Fit scoring smoke:** `jobos score <job-id> --profile <profile> --json` returns numeric subscores, overall score, reasoning, confidence, and red flags; deterministic without API keys.
- [ ] **Tailoring smokes:**
  - `jobos tailor resume --job <job-id> --profile <profile> --output markdown` writes file.
  - `jobos tailor cover-letter ...` writes file.
  - Both include evidence-warnings when proof points are missing.
- [ ] **Application tracking smokes:**
  - `jobos applications create --job <job-id> --status <status>` creates application.
  - `jobos applications update <id> --status <status>` updates status.
  - Status transitions are validated.
- [ ] **Task smoke:** `jobos tasks due --json` returns due tasks; tasks created by imports/automation link to parent entities.
- [ ] **Weekly review smoke:** `jobos review weekly --profile <profile> --output markdown` produces a non-empty report.
- [ ] **Web dashboard smoke:** Dashboard starts locally, reads same data store, and lists profiles/jobs/applications/artifacts.
- [ ] **Import/round-trip smoke:** Create profile → import job → score → tailor → create application → list application → run weekly review; end-to-end works with only local data.

---

## 2. Common Failure Modes to Watch

- [ ] **Missing API-key graceful degradation:** Any LLM-dependent feature falls back to deterministic/template output or exits with clear "API key required" message; core flow never breaks.
- [ ] **Bad/unreachable URL handling:** `import-url` does not crash the CLI; returns structured error with exit code.
- [ ] **Duplicate job imports:** Importing the same URL twice should not create duplicates or should warn and provide `--force` semantics.
- [ ] **Profile mismatch:** Score/tailor commands without valid `--profile` fail explicitly.
- [ ] **Workspace path issues:** `--workspace` flag resolves correctly; multiple workspaces do not leak state.
- [ ] **Broken JSON output:** `--json` output is parseable even for errors (or a separate documented error envelope is used).
- [ ] **Status machine errors:** Invalid application status transitions are rejected; status enum is consistent across CLI, API, and web.
- [ ] **Markdown/template injection:** Tailored output treats user profile/job description as data, not trusted template source.
- [ ] **Concurrency/race on SQLite:** If web and CLI run concurrently, SQLite WAL mode or file locking prevents corruption.
- [ ] **Empty proof-point warnings:** Tailoring must surface "needs user input" warnings, never silently hallucinate claims.

---

## 3. Anti-Fabrication / Evidence Checks

- [ ] **Evidence-grounding rule enforced:** Every resume bullet and cover-letter claim maps to a profile/proof-point or is explicitly labeled `needs_user_input` / `not_allowed`.
- [ ] **Resume source-of-truth exists:** A master profile/resume file is the canonical source; tailored variants are diffs against it.
- [ ] **Proof-point library schema:** Proof points have fields for claim, evidence, source link, metric, allowed scope.
- [ ] **Tailoring diff review:** `jobos artifacts diff` or equivalent shows what changed vs. master resume.
- [ ] **Artifact approval status:** Generated artifacts carry `draft` / `approved` status; unapproved artifacts are not used for external actions.
- [ ] **Answer bank for recurring questions:** Common screening answers (salary, work auth, relocation, DEI, why us) stored once, approved by user, reused.
- [ ] **LLM prompt constraints documented:** If LLM is used, system prompt includes anti-fabrication instruction; documented in code or README.
- [ ] **No unsupported superlatives:** Generated text does not invent metrics, titles, or achievements absent from source material.
- [ ] **Audit trail for generation:** Each artifact records generation config, model (if any), source evidence, and timestamp.

---

## 4. Human-Gating / Safety Checks

- [ ] **External action approval gate:** No command auto-sends email, auto-submits applications, or auto-posts outreach in MVP.
- [ ] **Dry-run defaults:** Research and outreach commands default to creating drafts/artifacts, not performing external side effects.
- [ ] **Automation levels documented:** The five/six-level ladder is implemented or at least documented; default level is `draft` or lower.
- [ ] **No auto-apply in MVP:** Browser/autofill module, if mentioned, is explicitly flagged as future work.
- [ ] **Sensitive question handling:** Salary expectations, work authorization, demographics, DEI are not auto-answered from hallucination; they pull from approved answer bank or ask user.
- [ ] **Outreach volume caps:** If outreach scheduling is present, it enforces daily/weekly caps and do-not-contact suppression.
- [ ] **Confirmation capture design:** Application status `applied` requires human confirmation or manual `applications update`; no fake confirmation.
- [ ] **Review queue for automation:** Automated discovery creates a review queue; it does not auto-apply.

---

## 5. Local-First / Privacy Checks

- [ ] **No cloud-only dependencies for core flow:** SQLite + local files suffice; no required SaaS account.
- [ ] **LLM optional and opt-in:** API keys are env vars only; app works without them.
- [ ] **Sensitive data stays local by default:** Compensation, immigration, demographics stored in local DB/files; not sent to analytics/telemetry.
- [ ] **Workspace layout is portable:** Files are markdown/JSON/YAML; can be git-tracked or zipped.
- [ ] **Export capability:** `jobos export` or README documents how to export all data to files.
- [ ] **No telemetry without consent:** If any analytics/telemetry exists, it is off by default and documented.
- [ ] **Data directory configurable:** `--workspace` or env var lets user choose data location.
- [ ] **No hidden cloud sync:** No accidental cloud storage of resume/job data in MVP.

---

## 6. Spec-Requirement Traceability

| Spec requirement | MVP must satisfy |
|---|---|
| Local-first / privacy-first | Checks in section 5. |
| Agent-native CLI + JSON output | All CLI commands have `--json`; file layout readable by agents. |
| Evidence-grounded generation | Anti-fabrication checks section 3. |
| Human-in-the-loop by default | Section 4 gates. |
| Progressive automation | Automation levels documented; default low. |
| Full lifecycle: discovery, scoring, tailoring, research, outreach, tracking, interviews, analytics | At minimum: import/score/tailor/research stubs/application tracking/tasks/weekly review. |
| No paid API dependency for core functionality | Section 5 + fallback tests. |
| No uncontrolled auto-apply/auto-send | Section 4. |
| README with setup, usage, architecture | Deliverable; verify exists. |
| Web dashboard starts locally | Section 1 web dashboard smoke. |

---

## 7. CLI Contract Review

- [ ] Every documented command exists and exits cleanly.
- [ ] `--json` is supported on all listed commands.
- [ ] Exit codes distinguish success (0), validation error (1), missing approval/config (2), transient failure (non-zero).
- [ ] `--dry-run` available for any side-effecting command.
- [ ] `--profile` required where specified.
- [ ] `--workspace` supported.
- [ ] Idempotency: `init`, `profile create`, `import-url`, `applications create` are idempotent or warn on duplicates.

---

## 8. Data Model / Workspace Layout Review

- [ ] `profiles/` directory/file exists.
- [ ] `jobs/<job-id>/` contains job.yaml/json, description.md, score.md, artifacts/, application.yaml/json.
- [ ] `audit.log.jsonl` or equivalent records mutations.
- [ ] Fit score structure matches rubric: role fit, domain fit, seniority, location/work model, compensation, mission/interest, red flags, overall, reasoning, confidence.
- [ ] Application status enum documented and enforced.
- [ ] Task entity first-class, not just a field.
- [ ] Research commands create company-dossier/stakeholder placeholder files even if deep research is stubbed.

---

## 9. Documentation / Transparency

- [ ] README includes install steps.
- [ ] README includes sample end-to-end command flow.
- [ ] README documents what is implemented vs. what is next.
- [ ] README lists env vars and API-key requirements.
- [ ] README notes anti-fabrication and approval policies.
- [ ] README describes workspace file layout.

---

## 10. Final Gate Questions

- [ ] Can a user run the entire MVP with zero API keys?
- [ ] Can an agent read the workspace state without running the web server?
- [ ] Is every generated resume/cover-letter claim either sourced or flagged?
- [ ] Is there any command that performs an external side effect without explicit user action?
- [ ] Does the web dashboard show the same data as the CLI?
- [ ] Are status transitions and automation policies documented?
- [ ] Is the project in a commit-ready state?

---

## Red Flags (Block Ship if Any)

1. Auto-apply or auto-send implemented in MVP.
2. Generated resume/cover letter fabricates unsupported claims.
3. Core CLI commands require paid API key with no fallback.
4. Web dashboard and CLI use separate/inconsistent data stores.
5. No evidence-warning when proof points are missing.
6. Sensitive personal data sent to cloud by default.
7. No README or no usage examples.

---

*Generated from: ideal-agent-native-job-application-app.md + job-application-ai-app-research-notes.md + jobos-build-goal.md*
