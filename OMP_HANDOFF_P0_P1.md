# OMP Handoff: P0–P1 first-run UX fixes (JobOS)

**Workspace:** `/home/logani/.herdr/worktrees/Job App/fix-p0-p1-first-run-ux`  
**Branch:** `fix/p0-p1-first-run-ux` (based on `origin/fix/setup-navigation` @ `5baffb2`)  
**Herdr:** workspace `w3S` label `p0-p1-first-run`  
**Do not** edit other worktrees. **Do not** force-push main.

## Already shipped on this base (do not redo)

Top-4 from dogfood already on this branch:
- FIT chip: `low evidence · N%` instead of unscored/unknown
- TUI disk reload on docs/review/discovery/network + after domain actions
- Hermes `agents connect` pipes `Y` noninteractively
- Sample offline Greenhouse discovery + network CTA on priority strip

## Your mission: implement ALL remaining P0 + P1

### P0

1. **Identity consistency (Alex vs Avery)**  
   After resume import, cover letter / drafts must use the canonical resume identity name (Avery Candidate), not only the profile display name, or setup should offer rename profile from resume identity. No mismatched “Alex Chen search profile” under Avery resume.

2. **Cover letter quality**  
   Keep proof gates and draft_needs_human_review. Improve structure: short opening tied to role/company, 1–2 proof paragraphs (not a bullet dump of evidence footnotes), clean close. Still no invented claims.

3. **Unlock FIT overall CTA**  
   When `scoreStatus === 'insufficient_evidence'` (or overall null with coverage), TUI selected job / priority / help must name concrete next prefs: target roles, location/work model, compensation, mission — and link to setup calibration or profile prefs surface. Do not invent an overall score.

4. **Pure TUI pursue → materials review path**  
   After in-process `p` pursue (same store), docs + review must show drafts; materials/setup nextAction should prefer **review exact revisions** when drafts exist. Add/extend automated test (JobosTui + onKeypress or domain tool) proving this without external CLI writer.

### P1

5. **Live Hermes ACP pane smoke reliability**  
   Harden `scripts/acp-demo.js` (or add `scripts/acp-smoke.js`): self-seed temp JOBOS_HOME, hard timeout, exit 0 on real session with visibleMutation or grounded tool use; no hang >90s. Document run command in AGENTS or script header.

6. **Empty network after people-research ok**  
   Beyond existing `b` CTA: prefill build-network draft with selected job company; optional one-key from network overlay to start map after intent save. Honest empty state if no sources.

7. **Discovery beyond sample**  
   Setup source step / discovery overlay: document or action for company-watch with board token; show recentFailures clearly after failed daily; keep sample offline path.

8. **Materials blocked → Enter opens review**  
   When onboarding next is `review_materials` or readiness needs artifact review, dashboard Enter / priority primary action opens review (or docs) on pending drafts — not “import resume” or pursue again.

## Constraints

- Local-first; no fake scores, no invented proofs/contacts, no silent external side effects.
- Prefer small boring changes in existing modules (`src/tui.js`, `tui-model.js`, `tailoring.js`/`artifacts.js`, `onboarding.js`, `scoring` consumers, `scripts/acp-demo.js`).
- Match project style; no drive-by refactors.

## Mandatory verification (do not finish without)

```bash
cd "/home/logani/.herdr/worktrees/Job App/fix-p0-p1-first-run-ux"
node --test --test-concurrency=1 tests/top4-fix-routes.test.js
# Plus any new tests you add for P0/P1
node --test --test-concurrency=1 tests/<your-new-tests>.test.js
# Broader related suite before done:
node --test --test-concurrency=1 \
  tests/top4-fix-routes.test.js \
  tests/tui-ux-benchmark.test.js \
  tests/guided-setup-navigation.test.js \
  tests/w09-guided-onboarding.test.js \
  tests/agent-setup.test.js \
  tests/tailored-resume.test.js \
  tests/human-review.test.js \
  tests/tui-artifact-review.test.js
# If time: npm test (full) — at least the suites above must be green
```

Also manually/script:
- Import sample resume + job → score → FIT shows low evidence + unlock CTA
- pursue via TUI path or same-store domain tool → open docs → drafts visible
- Cover uses Avery (or aligned identity)
- Sample discovery still works
- `npm run acp-demo` or new smoke exits 0 within timeout (if hermes available)

## Deliverables

1. Commits on `fix/p0-p1-first-run-ux` (conventional messages)
2. Push to origin
3. Write `HANDOFF_RESULT.md` in worktree root with:
   - what changed (paths)
   - test commands + exit codes
   - remaining gaps
4. Leave branch ready for PR into `fix/setup-navigation` or `main` (note which base you recommend)

## Done criteria

- All 8 items addressed or explicitly blocked with evidence
- Required test suites exit 0
- `git status` clean of secrets; no force-push
