# HANDOFF_RESULT — P0/P1 first-run UX

**Branch:** `fix/p0-p1-first-run-ux`  
**Base:** `origin/fix/setup-navigation` @ `5baffb2` (top-4 already present)  
**Worktree:** `/home/logani/.herdr/worktrees/Job App/fix-p0-p1-first-run-ux`  
**Herdr workspace:** `w3S` (JobOS p0-p1-first-run)  
**Implementer:** OMP (GPT-5.6-Sol); delivery finalized by Hermes conductor after full `npm test` hung at 1800s timeout.

## Status

| Area | Status |
|---|---|
| P0 identity (Alex vs Avery) | **Done** — cover uses `canonicalCandidateName` from resume revision identity |
| P0 cover letter quality | **Done** — paragraph proofs + signature; no “Alex Chen search profile” template |
| P0 FIT unlock CTA | **Done** — `fitUnlockGuidance` + priority strip + setup-calibration jump |
| P0 TUI pursue → review | **Done** — recommendedAction prefers `review_materials` when drafts pending; Enter → review |
| P1 ACP smoke | **Done** — `scripts/acp-smoke.js` + `npm run acp-smoke` (hard ~85s cap) |
| P1 empty network | **Done** — build-network prefill from selected job company (prior CTA retained) |
| P1 discovery beyond sample | **Done** — setup source actions + failure listing retained from top-4 |
| P1 materials Enter → review | **Done** — primary strip / Enter path to review |

## Key paths changed

- `src/tailoring.js` — candidate name from resume; cover prose structure
- `src/tui-model.js` — `fitUnlockGuidance`, review_materials priority, fit CTA strip
- `src/tui.js` — Enter/review jump, unlock_fit → setup calibration, network draft prefill
- `src/onboarding.js` — source/discovery guidance
- `scripts/acp-smoke.js` — new bounded ACP smoke
- `package.json` — `acp-smoke` script
- `tests/p0-p1-first-run-ux.test.js` — new coverage
- `tests/tui-acp.test.js`, `tests/tui-strip-actions.test.js`, `tests/w08-career-memory-consumers.test.js` — expectation updates

## Verification (conductor)

```text
node --test --test-concurrency=1 \
  tests/top4-fix-routes.test.js \
  tests/p0-p1-first-run-ux.test.js \
  tests/tui-ux-benchmark.test.js \
  tests/guided-setup-navigation.test.js \
  tests/w09-guided-onboarding.test.js \
  tests/agent-setup.test.js \
  tests/tailored-resume.test.js \
  tests/human-review.test.js \
  tests/tui-artifact-review.test.js \
  tests/tui-strip-actions.test.js \
  tests/tui-acp.test.js
```

**Result:** `143` tests, **0 fail**, duration ~149s, exit **0**.

OMP also reported mandated suite **110/110** pass earlier in-session.

**Full `npm test`:** started by OMP; hit **1800s wall timeout** mid-suite — not used as the finish gate. Prefer targeted suites + CI on PR.

## Gaps / follow-ups

- Full suite not completed in-agent (timeout). Run CI or overnight `npm test` if required for merge gate.
- Live `npm run acp-smoke` depends on Hermes ACP on the host; not re-run in conductor finalize if hermes busy.
- Branch tracks `origin/fix/setup-navigation` until pushed; open PR to `fix/setup-navigation` or rebase onto `main` as preferred.

## Recommend PR base

`fix/setup-navigation` (keeps top-4 + P0/P1 stacked) or `main` after merge of setup-navigation.
