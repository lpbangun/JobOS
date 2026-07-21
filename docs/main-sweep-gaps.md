# Main-sweep gaps — AppPacket-ReceiptSpine branch

This document records gaps and behavioral changes that were intentionally left
out of the focused PR 10 review-fix commit (`947b0d1`) so they can be addressed
during a full sweep against `main`.

## 1. Cron day-of-month + day-of-week matching changed from AND to OR

**Status:** Decided (2026-07-21): OR semantics (standard Vixie cron) is **kept**. Documented in a comment above `matchesCron()` in `src/scheduler/cron.js`, in `BUILD_PROGRESS.md`, and in `README.md`; locked by explicit OR/wildcard cases in `tests/sprint7-scheduler.test.js`.  
**Location:** `src/scheduler/cron.js`, `matchesCron()` (lines 58–64).  
**What changed:** When a cron expression specifies both a concrete day-of-month
and a concrete day-of-week (neither is `*`), the old `matchesCron` logic treated
them as **AND** (both had to match). The current code treats them as **OR**
(either matching is enough). This matches the most common Unix cron
implementation, but it is a breaking change for any existing JobOS automations
that relied on the AND semantics.

**Concrete example:**

```cron
0 9 1 * 1
```

- **Old behavior:** fired only when the 1st day of the month was also a Monday.
- **New behavior:** fires on the 1st of any month **and** on any Monday.

**Action for main sweep:**

1. Decide whether the OR semantics is intentional (standard cron) or whether the
   AND behavior should be restored for backward compatibility.
2. If OR is intentional, document the change in `BUILD_PROGRESS.md` and
   `README.md`, and add a release-note warning for users with existing schedules.
3. If OR is accidental, restore the AND branch and update the scheduler tests in
   `tests/sprint7-scheduler.test.js` to match.
4. Add explicit tests for both the OR and wildcard cases so the contract is
   locked.

## 2. BUILD_PROGRESS.md MCP tool count (fixed in this branch)

**Status:** Fixed in `BUILD_PROGRESS.md` as part of the review follow-up;
reconciled again on 2026-07-21 (gap #8) when the catalog grew.  
**Location:** `BUILD_PROGRESS.md` line under "Real external MCP drill".  
**What was wrong:** The verification log recorded a "31-tool list" for the
external MCP drill, but the current MCP catalog is `DOMAIN_TOOLS` (44 entries
after `answers_add`) minus the three packet-mutation tools filtered by
`MUTATION_DENY` in `src/mcp.js`, i.e., **41 tools**. The advertised count is
now pinned by tests (AP08 relational check in `tests/apppacket-receipt.test.js`
and the over-the-wire count in `tests/sprint4-interview-analytics-mcp.test.js`)
so the verification log cannot drift again.

**What was changed:** Updated the line to read "37-tool list (includes
`applications_plan` and packet list/show/diff inspection)".

**Action for main sweep:**

- Re-run the external MCP drill on the merged `main` and confirm the tool count
  is still 37 (or update it if it changes).
- Consider adding a lightweight test that asserts the advertised MCP tool count
  so the verification log does not drift again.

## 3. Test coverage gaps (deferred)

These are real security/contract tests that the current acceptance suite should
include but does not yet. They are **not** product regressions; the code behaves
correctly, but the tests do not prove it.

### 3.1 AP08 — missing service-level denial for `confirm_application_receipt`

**Location:** `tests/apppacket-receipt.test.js`, lines 469–487.  
**Gap:** The test verifies that `mcp`/`acp` sources are denied through the
`callDomainTool` facade for `create_application_packet`,
`attest_application_submitted`, and `confirm_application_receipt`. It also
verifies a direct service-level denial for `attestApplicationSubmitted`. It does
not call the packet service directly with `source: 'mcp'|'acp'` for
`confirmApplicationReceipt`.

**Suggested addition:** Inside the `for (const source of ['mcp', 'acp'])` loop,
add:

```javascript
await assertRejectCode(
  () => Promise.resolve().then(() => api.confirmApplicationReceipt(fixture.store, {
    packetId: packet.id,
    reference: 'REF',
    source
  })),
  'human_submission_attestation_required'
);
```

### 3.2 AP15 — list filters do not verify cross-profile leakage

**Location:** `tests/apppacket-receipt.test.js`, lines 678–690.  
**Gap:** The test asserts that `--job`, `--profile`, and combined filters return
the same packets for the current profile, but it never creates a second profile
with its own packet to verify that the filter cannot leak another profile's
packets.

**Suggested addition:** Create a second profile, job, and packet; then assert:

- `apply packet list --profile <first-profile>` does not contain the second
  packet's ID.
- `apply packet list --job <first-job>` does not contain the second packet's ID.
- `apply packet list --job <first-job> --profile <first-profile>` does not
  contain the second packet's ID.

### 3.3 AP13 — no post-conflict receipt consistency check

**Location:** `tests/apppacket-receipt.test.js`, lines 587–610.  
**Gap:** The test covers concurrent packet creation and the stale-snapshot
guard, but it does not exercise the requirement that a failed or conflicting
receipt write leaves application status, status history, receipts, readiness
YAML, packet YAML receipt summary, and audit JSONL mutually consistent with
SQLite.

**Suggested addition:** After the existing stale-snapshot test, add a conflict
scenario:

1. Confirm a receipt once successfully.
2. Attempt a second confirmation with a different reference.
3. Verify `receipt_conflict`.
4. Assert that:
   - `applications.status` is unchanged.
   - `status_changes` count is unchanged.
   - `application_receipts` count is still 1.
   - `application-readiness.yaml` and the packet YAML receipt summary are
     unchanged.
   - No new audit JSONL entry was written for the failed confirmation.

### 3.4 AP03 — existing application branch does not assert packet links

**Location:** `tests/apppacket-receipt.test.js`, lines 300–320.  
**Gap:** The branch checks that the existing application row is unchanged after
packet creation, but it does not assert that the packet's `applicationId` equals
the existing application ID or that no second application row was created.

**Suggested addition:** After `createApplicationPacket` in the
existing-application branch, assert:

```javascript
assert.equal(packet.applicationId, existing.application.id);
assert.equal(count(existing.store, 'applications'), 1);
```

## 4. Other notes for the main sweep

- The review also identified the cron change as being outside the PR 10 packet
  scope; if the OR semantics is kept, the scheduler section of `BUILD_PROGRESS.md`
  should be updated to mention the standard-cron alignment.
- Consider running a final `npm run smoke` and `npm test` on the merged `main`
  after the sweep to confirm these additions do not introduce regressions.
