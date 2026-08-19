# JobOS TUI rebuild — frozen pass bar

This file is the only pass bar for the Ink + React 19 + `@inkjs/ui` Classic-red rebuild.
It is frozen. Worker and lead must not edit it. Critics run these commands unchanged,
record each command + exit code + failing output, and verdict **pass** or **fail**.
There is no score. Every check must pass. Adding product tests is allowed only by
appending files that the targeted glob already includes; never delete or weaken a
check here to look green.

Implementation independence: evidence is information architecture, copy, domain
wiring, and product invariants. Do not treat the retired custom renderer as truth
(`src/tui.js` box-drawing panels, `┌ JOBS`, `SELECTED JOB`, filters 1–7, colon
command bar, numeric FIT as the row action, dashboard `NEXT UP` strip). Do not
treat the HTML mock or the Ink spike theme as the product. The IA source of truth
is `spikes/visualizer/classic.html` + `spikes/visualizer/app.js` (Classic red).
Domain, MCP, ACP, onboarding projection, and CLI contracts stay in
`src/domain-tools.js`, `src/tui-model.js`, `src/onboarding.js`, `src/acp.js`,
`src/capabilities.js`, and `src/cli.js`.

Run every command from the repository root on Node 22+. Unset or blank provider
keys for core checks. Isolated TUI snapshot state uses `JOBOS_HOME` (equivalent:
`--workspace`) so the repo working tree is never the workspace.

---

## Verdict

**Pass** only if every check below exits with the stated code **and** its evidence
holds. **Fail** if any command mismatches its exit code, hangs, invents state, or
still encodes retired chrome / Charm-green / spike-cyan tokens as the product IA.

---

## Environment (all checks)

```bash
node -v   # must be v22 or newer; this is a precondition, not a scored check
```

Default locale `C.UTF-8` is fine. Do not pass `--advisor`. Do not start a TTY
for the snapshot check.

---

## Check B1 — targeted TUI tests (rewrite these files to the locked IA)

### Command

```bash
node --test --test-concurrency=1 \
  tests/tui-*.test.js \
  tests/guided-setup-navigation.test.js \
  tests/p0-p1-first-run-ux.test.js \
  tests/w08-career-memory-tui.test.js
```

### Expected exit code

`0`

### What pass means

Exit `0` is necessary and **not sufficient**. These files are the rewrite set for
the locked IA. They fail this check if they still assert retired chrome, even when
node:test is green.

**Functional evidence the rewritten tests must prove**

1. `jobos tui` / the in-process TUI entry is the Ink app. Product command remains
   `jobos tui`. `spike:ink` is not the product entry.
2. One person, one profile in the TUI. No profile-switcher chrome. CLI may still
   accept `--profile`.
3. Welcome overlay is first-run chrome and continues into guided setup. Skip / Esc
   does not invent a profile, proofs, jobs, or contacts.
4. Setup step ids and labels match `SETUP_STEP_LABELS` / `src/onboarding.js`:
   - Required: Workspace ready, About you, Your resume, Validate experience
     highlights, Add a job you like, Check the fit, Application drafts.
   - Optional: Job discovery, Your preferences, AI assistant, Web applications,
     Connections.
5. Nested setup pickers (resume source, proof review, job source) stay overlays
   under setup and call real domain (`callDomainTool` / trusted TUI wrappers).
   They are not a fake checklist. Resume import, proof verify/keep/edit/drop, job
   import, and fit scoring persist into SQLite under the workspace.
6. Left rail is **New | Jobs**. New is daily / already-scored inbox. Jobs is the
   pipeline. **Add to Jobs** actually moves the row New → Jobs.
7. Job rows show action chips **Needs review / Create files / Find people /
   Due follow-up**, not a numeric fit score as the row action.
8. Right job-scoped tabs are **Job | People | Chat**, equal width, hugging
   content. Tab cycles Job → People → Chat. Shift+Tab reverses. Company is header
   context, not a third header toggle.
9. Job pane = rundown + Create files + Tracker. People pane = this listing’s
   contacts only (no Network button on that pane). Chat pane = this-job composer.
10. Composer exists only on Chat and Workspace. Workspace is whole-search chat.
    Jobs is the board.
11. Typing `/` in the composer opens the slash menu **directly above the prompt**.
    The menu filters as you type. Arrows + Enter run the highlighted command.
    Esc clears `/`. `/` on Job or People jumps to Chat with `/` in the input.
    Footer is a hint (`/ in Chat`), not a launcher.
12. Slash catalog is present and wired to real actions:
    `/create-files` `/find-people` `/network` `/tracker` `/review` `/daily`
    `/chat` `/jobs` `/workspace` `/memory` `/setup`.
13. `/create-files` writes real artifacts for the selected job (resume +
    questions drafts) through domain tailoring / artifact create. It does not
    append mock chat.
14. Files overlay reviews `resume.md` + `questions.md` with Approve / Reject.
    Those calls use trusted TUI mediation (`source: 'tui'`) of
    `approve_artifact` / `reject_artifact`. Restricted answers stay gated.
15. Tracker overlay mutates **this job**: application status, packet freeze
    (`create_application_packet`), and human-only attest
    (`attest_application_submitted`). MCP/ACP callers cannot attest or freeze
    via a spoofed mediation flag.
16. `/find-people` on Jobs stages contacts for **this listing**. On Workspace it
    opens the keep/skip overlay (profile-scoped research), then Network.
17. `/network` is an overlay (intent + graph). Clicking a person opens the
    connection overlay (draft outreach / record contact). Record contact and
    mark-sent remain human-only.
18. `/review` is the morning-brief overlay (due + next actions + weekly collapse
    here). It is not an Updates inbox pane.
19. `/memory` is an overlay over real career-memory projections. Accept / reject
    / revoke stay human-only.
20. `/daily` focuses New. `/jobs` returns to the board. `/workspace` opens
    Workspace chat. `/chat` opens this-job Chat. `/setup` opens guided setup.
21. Chat and Workspace talk through existing ACP (`src/acp.js`). `--agent off`
    or a missing backend **says the assistant is off / unavailable** and does
    not invent replies, proofs, contacts, company facts, or submission receipts.
22. Human-only domain tools in `src/capabilities.js` remain TUI/CLI-only,
    including artifact approve/reject, packet freeze, attest, restricted
    `answers_add`, contact approve, network contact record, mark outreach sent,
    and memory lifecycle mutations. MCP catalog must not list them.
23. External apply / send stay user-configured and default off. Tests must not
    claim an external submit or send succeeded without the configured tool
    result.
24. Out of scope for this pass (must not appear as panes or this-pass overlays):
    interview suite, career-ops dashboard, extra left rails, Updates inbox,
    profile switcher, colon command bar, TUI filters 1–7 as chrome.

**Visual / IA evidence the rewritten tests must prove**

- Header: **Job** + **OS** wordmark (same font, no space; Job uses default text
  color, OS uses accent) | clock | `working` while a domain/ACP turn is busy |
  company as context | **Workspace | Jobs**.
- Classic red tokens: background `#111`, accent `#ff6b6b`, mono
  `"JetBrains Mono", Menlo, ui-monospace, monospace`. Not Charm green. Not the
  Ink-spike cyan/purple theme.
- Overlay family: welcome, setup (and nested resume-source / proof-review /
  job-source pickers), files, tracker, morning brief, keep/skip people,
  network, connection, memory, setup. Esc closes the overlay (slash Esc clears
  `/` first).
- Frames stay inside the requested width × height; no NUL / control-data leaks
  in visible copy.

---

## Check B2 — full unit suite

### Command

```bash
npm test
```

(`package.json` → `node --test --test-concurrency=1 tests/*.test.js`)

### Expected exit code

`0`

### What pass means

**Functional evidence**

- Every `tests/*.test.js` file passes, including the rewritten B1 set.
- Non-TUI tests stay green without rewriting domain, MCP, ACP, scoring,
  tailoring, packets, discovery, network, or onboarding **projection** contracts.
- `--json` CLI grammar, exit codes (`0` success, `1` runtime/domain, `2` usage),
  and `jobos: <message>` non-JSON error prefix remain unchanged.
- MCP agents still cannot call human-only tools (`human_review_required` /
  `mcp_tool_not_available` / typed handoff). ACP guests get the agent-eligible
  catalog only.
- Core flow requires no API keys. No telemetry. Local SQLite under `.jobos/`
  and agent mirror `jobos-workspace/` remain the source of truth.
- Validation failures still exit non-zero.

**Visual / IA evidence**

- None beyond B1: this check proves the rest of the product did not regress
  while the TUI chrome changed.

---

## Check B3 — smoke (keyless domain e2e)

### Command

```bash
npm run smoke
```

(`package.json` → `node scripts/smoke.js`)

### Expected exit code

`0`

### What pass means

The script already isolates `JOBOS_HOME` to a temp dir and blanks provider /
ACP keys. Do not point it at a personal workspace.

**Functional evidence**

- First CLI use auto-creates `.jobos/jobos.sqlite` and `jobos-workspace/`.
- Guided setup projection starts keyless at `create_profile`;
  `policy.cloudKeyRequired === false` and `policy.externalSideEffects === 'none'`.
- Interrupted setup resumes at canonical resume import, then local job intake.
- Fixture-backed discovery, scoring, pursue, artifacts, packets, and career
  memory complete without a live network LLM.
- No fabricated proofs, contacts, company facts, or submission receipts.
- External apply/send remain off. Smoke must not perform a live employer submit.

**Visual / IA evidence**

- None. Smoke is domain/CLI. TUI chrome is B1 + B4.

---

## Check B4 — non-TTY `tui --snapshot` in an isolated temp workspace

### Command

Run this exact Node snippet from the repository root (it creates a throwaway
`JOBOS_HOME`, forces non-TTY stdio, and fails unless IA evidence matches):

```bash
node --input-type=module -e '
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = mkdtempSync(path.join(tmpdir(), "jobos-bench-snapshot-"));
const env = {
  ...process.env,
  JOBOS_HOME: root,
  JOBOS_SEARCH_PROVIDER: "none",
  JOBOS_ACP_COMMAND: "__jobos_missing_acp__",
  JOBOS_LLM_PROVIDER: "",
  JOBOS_LLM_MODEL: "",
  JOBOS_LLM_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OLLAMA_API_KEY: "",
  XAI_API_KEY: "",
  GOOGLE_API_KEY: "",
  GEMINI_API_KEY: ""
};
const result = spawnSync(process.execPath, [
  "src/cli.js", "tui", "--snapshot", "--width", "140", "--height", "42", "--agent", "off"
], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 15000,
  stdio: ["ignore", "pipe", "pipe"]
});
try {
  assert.equal(result.error, undefined, result.error?.message || "spawn failed");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = String(result.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /JobOS/, "wordmark JobOS with no space");
  assert.doesNotMatch(text, /JOBOS ·/, "retired JOBOS · header");
  assert.match(text, /Workspace/, "header mode Workspace");
  assert.match(text, /Jobs/, "header mode Jobs");
  assert.match(text, /Welcome to JobOS|Start guided setup|guided setup/i, "first-run welcome/setup overlay");
  assert.match(text, /\/ in Chat/, "footer is a slash hint, not a launcher");
  assert.match(text, /Tab/, "Tab cycles Job · People · Chat");
  assert.match(text, /Job/, "Job tab present");
  assert.match(text, /People/, "People tab present");
  assert.match(text, /Chat/, "Chat tab present");
  assert.doesNotMatch(text, /\[today\].*all.*high.*review/, "retired filter chrome 1–7");
  assert.doesNotMatch(text, /┌ JOBS|SELECTED JOB|┌ ASSISTANT/, "retired box-drawing dashboard");
  assert.doesNotMatch(text, /Northstar Learning|Harbor Schools|Example Learning Co|Contoso Careers Lab|Lumen Labs/, "empty workspace must not invent visualizer mock listings");
  assert.doesNotMatch(text, /spike:ink/, "spike entry is not the product");
  assert.doesNotMatch(String(result.stderr || ""), /Hermes ACP guest session started|acp_spawn_failed/, "snapshot must not start an ACP process");
  assert.ok(!/\bFIT\s+\d+/.test(text), "numeric FIT is not row chrome");
} finally {
  rmSync(root, { recursive: true, force: true });
}
'
```

Equivalent product invocation (same flags; the Node wrapper above is the frozen
check because it also asserts evidence and isolation):

```bash
node src/cli.js tui --snapshot --width 140 --height 42 --agent off
```

`--workspace <dir>` is accepted as an alias for isolating state. Default
snapshot size remains width 140 (min 60), height 42 (min 20). Color may be
stripped; critics judge structure and copy, not RGB, in this check.

### Expected exit code

`0` for the Node wrapper (and for `node src/cli.js tui --snapshot ...` itself).
The process must terminate; a TTY-only Ink hang is a fail.

### What pass means

**Functional evidence**

- `jobos tui --snapshot` is the non-TTY path. It does not require a terminal.
- Isolated temp `JOBOS_HOME` is used; the repo tree is not mutated.
- No ACP child is spawned (`--agent off` + missing ACP command).
- Empty workspace does not invent jobs, proofs, contacts, or companies.
- Core snapshot runs with no API keys.

**Visual / IA evidence**

- Classic wordmark **JobOS** (Job + OS, no space), not `JOBOS ·`.
- Header modes **Workspace | Jobs**.
- First-run **welcome → guided setup** overlay copy.
- Footer hint `/ in Chat`; Tab mentioned with Job / People / Chat.
- No retired dashboard boxes, no filter tabs 1–7, no visualizer fixture
  companies, no `spike:ink`.
- Numeric FIT is not the left-rail action chrome.

Theme RGB is proven in B1, not in this colorless snapshot.

---

## Check B5 — CLI contract invariants (unchanged `--json` and `jobos:` errors)

### Command A — `--json` registry still works

```bash
node src/cli.js agent-guide --json
```

Expected exit code: `0`

Stdout is JSON. Required fields:

- `architecture.interactive` is `"tui"`
- `architecture.sideEffects` is `"default-off"`
- `exitCodes.success === 0`, `runtimeError === 1`, `usageError === 2`
- commands include `tui` with flags `--snapshot`, `--agent off`, `--width`,
  `--height`
- `domainTools` entries for human-only names (`approve_artifact`,
  `reject_artifact`, `create_application_packet`,
  `attest_application_submitted`, `answers_add`, `approve_contact`,
  `network_contact_record`, `mark_outreach_sent`, memory accept/reject/revoke)
  have `agentEligible === false` / mediation `trusted_cli_or_tui_only`

### Command B — validation / usage failure

```bash
node src/cli.js score
```

Expected exit code: `2`

Stderr (non-JSON) matches `^jobos:`. No stack-as-success. No zero exit.

### What pass means

**Functional evidence:** the CLI `--json` contract and non-zero `jobos:` errors
survived the TUI rewrite. Domain tools were wrapped, not replaced.

**Visual / IA evidence:** none.

---

## Product invariants (every check)

These are true on a pass and may not be “fixed later”:

- Local-first. No telemetry. No required API keys for core flow.
- Never invent proofs, contacts, company facts, or submission receipts.
- Artifact approve/reject, packet freeze, attest, restricted answers: TUI/CLI
  human-only. MCP/ACP cannot attest.
- External apply/send stay user-configured, default off.
- Validation failures: non-zero + `jobos:` error (unless `--json`, which writes
  `{"ok":false,"error":{...}}` to stderr).
- `--json` CLI contract unchanged.
- One TUI profile. Tailor per job from stored proofs.

## Done criteria this bar covers

| Done criterion | Check |
| --- | --- |
| `jobos tui` is the Ink app | B1, B4 |
| `--snapshot` works for non-TTY | B4 |
| In-scope controls wired to domain/ACP and functional | B1, B2, B3 |
| Setup continues for real | B1, B3 |
| Create files writes artifacts | B1 |
| Tracker mutates status / packet / attest | B1, B2 |
| Find people stages contacts | B1 |
| Slash runs the named action | B1 |
| Classic red chrome matches the render | B1, B4 |
| Targeted TUI tests + `npm test` + `npm run smoke` pass | B1, B2, B3 |
| CLI `--json` / `jobos:` errors unchanged | B2, B5 |
| 80×24 and 140×42 first paint occupies the requested frame | B6, B7 |
| Welcome is a covering overlay with rail and pane tabs hidden | B6, B8 |
| Board pane tabs are fixed/compact and hug their labels | B9 |
| No stubs presented as done; no fabricated output | all |

## Non-goals (appearance here is a fail)

Career-ops dashboard, filter tabs, sort modes, extra left rails, Updates inbox,
interview suite as a pane or this-pass overlay, profile switcher, colon command
bar, TUI filters 1–7 as chrome, Charm/green theme, Ink-spike `theme.js` tokens,
rewriting CLI/MCP/domain “while we are here,” mock chat, fake setup.

---

## Critic log (required)

For each check record:

```
CHECK: B<n>
COMMAND: <exact command>
EXIT: <code>
PASS_EVIDENCE: <one sentence or fail output>
```

Verdict is **pass** only when B1–B5 are all pass. Otherwise **fail**.
No 9/10. No partial credit.

The frozen live extension below adds B6–B9. The overall verdict is **pass** only
when B1–B9 all pass; otherwise it is **fail**.

---

## Check B6 — live 80×24 first paint fills the frame

### Command

Run this exact Node snippet from the repository root. The product CLI itself
must exit `0`; the wrapper rejects a compressed or uncovered welcome paint.

```bash
node --input-type=module -e '
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = mkdtempSync(path.join(tmpdir(), "jobos-bench-live-80-"));
const env = { ...process.env, JOBOS_HOME: root, JOBOS_SEARCH_PROVIDER: "none", JOBOS_ACP_COMMAND: "__jobos_missing_acp__", JOBOS_LLM_PROVIDER: "", JOBOS_LLM_MODEL: "", JOBOS_LLM_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OLLAMA_API_KEY: "", XAI_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "" };
const result = spawnSync(process.execPath, ["src/cli.js", "tui", "--snapshot", "--width", "80", "--height", "24", "--agent", "off"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
try {
  assert.equal(result.error, undefined, result.error?.message || "spawn failed");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = String(result.stdout || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const violations = [];
  const lastPainted = lines.findLastIndex(line => line.trim().length > 0) + 1;
  const trailingBlankRows = lines.length - lastPainted;
  if (lines.length < 23) violations.push(`80x24 emitted ${lines.length} visual rows; expected at least 23`);
  if (lastPainted < 23) violations.push(`80x24 last painted row is ${lastPainted}; expected row 23 or 24`);
  if (trailingBlankRows > 1) violations.push(`80x24 has ${trailingBlankRows} blank trailing rows; at most 1 allowed`);
  const crushed = lines.find(line => /\bNew\b.*\bJobs\b.*\bJob\b.*\bPeople\b.*\bChat\b/.test(line));
  if (crushed) violations.push(`rail and pane tabs share one crushed row beside welcome: ${crushed.trim()}`);
  const railCopy = lines.find(line => /No jobs yet|Add to Jobs/.test(line));
  if (railCopy) violations.push(`welcome overlay exposes left-rail empty copy: ${railCopy.trim()}`);
  assert.deepEqual(violations, [], violations.join("\n"));
} finally { rmSync(root, { recursive: true, force: true }); }
'
```

### Expected exit code

`0`

### What pass means

- The isolated first-run paint occupies at least 23 of the requested 24 visual
  rows (at most one terminal trailing row may be absent).
- The welcome surface is not squeezed beside a combined **New | Jobs** and
  **Job | People | Chat** navigation strip.
- Empty left-rail copy such as **No jobs yet** / **Add to Jobs** is not visible
  through the covering welcome overlay.

---

## Check B7 — live 140×42 first paint fills the frame

### Command

```bash
node --input-type=module -e '
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = mkdtempSync(path.join(tmpdir(), "jobos-bench-live-140-"));
const env = { ...process.env, JOBOS_HOME: root, JOBOS_SEARCH_PROVIDER: "none", JOBOS_ACP_COMMAND: "__jobos_missing_acp__", JOBOS_LLM_PROVIDER: "", JOBOS_LLM_MODEL: "", JOBOS_LLM_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OLLAMA_API_KEY: "", XAI_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "" };
const result = spawnSync(process.execPath, ["src/cli.js", "tui", "--snapshot", "--width", "140", "--height", "42", "--agent", "off"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
try {
  assert.equal(result.error, undefined, result.error?.message || "spawn failed");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = String(result.stdout || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const violations = [];
  const lastPainted = lines.findLastIndex(line => line.trim().length > 0) + 1;
  const trailingBlankRows = lines.length - lastPainted;
  if (lines.length < 41) violations.push(`140x42 emitted ${lines.length} visual rows; expected at least 41`);
  if (lastPainted < 41) violations.push(`140x42 last painted row is ${lastPainted}; expected row 41 or 42`);
  if (trailingBlankRows > 1) violations.push(`140x42 has ${trailingBlankRows} blank trailing rows; at most 1 allowed`);
  const crushed = lines.find(line => /\bNew\b.*\bJobs\b.*\bJob\b.*\bPeople\b.*\bChat\b/.test(line));
  if (crushed) violations.push(`wide first paint is a crushed navigation strip: ${crushed.trim()}`);
  assert.deepEqual(violations, [], violations.join("\n"));
} finally { rmSync(root, { recursive: true, force: true }); }
'
```

### Expected exit code

`0`

### What pass means

The product process exits `0`, while the wrapper independently proves that the
wide paint occupies at least 41 of 42 rows and does not collapse both navigation
families into one strip beside the first-run welcome.

---

## Check B8 — first-run welcome covers the board term

`classic.html` defines `[data-overlay]` as `position:absolute; inset:0` over the
term. In the terminal translation, the header may remain, but an open welcome
(or any covering overlay) hides the left rail and the **Job | People | Chat**
pane bar. The overlay is not a main-pane stub.

### Command

```bash
node --input-type=module -e '
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = mkdtempSync(path.join(tmpdir(), "jobos-bench-overlay-"));
const env = { ...process.env, JOBOS_HOME: root, JOBOS_SEARCH_PROVIDER: "none", JOBOS_ACP_COMMAND: "__jobos_missing_acp__", JOBOS_LLM_PROVIDER: "", JOBOS_LLM_MODEL: "", JOBOS_LLM_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OLLAMA_API_KEY: "", XAI_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "" };
const result = spawnSync(process.execPath, ["src/cli.js", "tui", "--snapshot", "--width", "140", "--height", "42", "--agent", "off"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
try {
  assert.equal(result.error, undefined, result.error?.message || "spawn failed");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = String(result.stdout || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  assert.match(text, /WELCOME TO JOBOS|Welcome to JobOS/, "first-run welcome must be open");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const rail = lines.find(line => /\bNew\b.*\bJobs\b/.test(line));
  const panes = lines.find(line => /\bJob\b.*\bPeople\b.*\bChat\b/.test(line) && !/\/ in Chat|\bTab\b/.test(line));
  const violations = [];
  if (rail) violations.push(`welcome exposes New | Jobs rail: ${rail.trim()}`);
  if (panes) violations.push(`welcome exposes Job | People | Chat pane tabs: ${panes.trim()}`);
  const railCopy = lines.find(line => /No jobs yet|Add to Jobs from New/.test(line));
  if (railCopy) violations.push(`welcome exposes left-rail body copy: ${railCopy.trim()}`);
  assert.deepEqual(violations, [], violations.join("\n"));
} finally { rmSync(root, { recursive: true, force: true }); }
'
```

### Expected exit code

`0`

### What pass means

The welcome identity is visible, but the board rail segments, pane tabs, and
left-rail empty copy are not painted behind or beside it.

---

## Check B9 — board pane tabs hug their content

This test is also included automatically by B1's existing `tests/tui-*.test.js`
glob and by B2's full-suite glob.

### Command

```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```

### Expected exit code

`0`

### What pass means

With a non-empty model and `welcomeDismissed`, the board paints **Job | People |
Chat** at fixed, compact spacing (no more than 12 columns from one label start to
the next) rather than three `flexGrow: 1` tabs stretched across the main pane.

---

## Live visual critic log (B6+ required)

For each frozen live check record:

```
CHECK: B<n>
COMMAND: <exact command above>
EXIT: <code>
PASS_EVIDENCE: <one sentence or fail output>
```

B6–B9 are pass/fail only. No partial credit.

---

## B10+ critic log and verdict extension

The frozen interaction and live-agent extension below adds B10–B15. The overall
verdict is **pass** only when B1–B15 all pass; otherwise it is **fail**. B10–B15
are pass/fail only. No partial credit. The scripts they invoke are committed
benchmark harnesses and must be run unchanged from the repository root.

## Check B10 — fixed-grid SGR mouse routing

### Command

```bash
node scripts/bench-b10-mouse.mjs
```

### Expected exit code

`0`

### What pass means

At 140×42, SGR mouse press bytes in Ink's stripped form
(`[<0;COL;ROWM`) route through `JobosTui.handleKey` to the spike-equivalent
fixed-grid action: **Workspace | Jobs** header modes, **New | Jobs** rail
segments, rail rows, **Job | People | Chat** pane tabs, covering-overlay rows,
and composer send. Mouse protocol bytes never enter visible composer input.
The harness uses only a throwaway workspace beneath `/tmp`.

## Check B11 — direct key and click reachability for three surfaces

### Command

```bash
node scripts/bench-b11-direct-surfaces.mjs
```

### Expected exit code

`0`

### What pass means

Each formerly unreachable surface has both a documented direct key and a
fixed-grid SGR click target:

- `n` selects **New** and `j` selects **Jobs** directly; each rail segment is
  also clickable. This is distinct from `g` (**Workspace | Jobs**) and from
  running `/daily` or `/jobs`.
- In Tracker, `1` selects **saved**, `2` **researching**, `3` **applied**, and
  `4` **waiting** directly; each displayed stage has a click target. Selection
  does not bypass packet/attestation safety for mutations that require it.
- In Network, `i` opens **Edit intent** and the displayed Edit-intent control is
  clickable. The edit continues through the real network-intent pathway.

The rendered hints document those keys; a hidden key with no product copy is a
fail. The harness is isolated beneath `/tmp`.

## Check B12 — `/chat` leaves bare Enter harmless

### Command

```bash
node scripts/bench-b12-chat-enter.mjs
```

### Expected exit code

`0`

### What pass means

`/chat` opens this-job Chat with an empty, ready composer. A subsequent bare
Enter dispatches no slash action. In particular it cannot select the first
catalog entry (`/create-files`) through `slashHits('/')`, start tailoring, or
run any other domain slash command.

## Check B13 — real Hermes ACP grounded score mutation

### Command

```bash
node scripts/bench-b13-live-grounded.mjs
```

### Expected exit code

`0`

### What pass means

A real `/home/logani/.local/bin/hermes acp` guest connects directly to JobOS in
an isolated `/tmp` workspace, completes a visible `score_job` MCP tool call,
and ends with `stopReason: "end_turn"`. The command prints the real ACP session
id and then reopens SQLite from disk. It passes only when the reopened job has a
new `job.scored` audit record and parseable `score_json` with contract
`jobos.fit-score.v1`; the output includes its overall value and SHA-256. Missing
or unusable Hermes, protocol failure, timeout, absent tool evidence, or absent
disk mutation is an honest non-zero prerequisite/live failure, never a fake
success.

## Check B14 — Esc cancels an in-pane running prompt

### Command

```bash
node scripts/bench-b14-cancel.mjs
```

### Expected exit code

`0`

### What pass means

While a Chat or Workspace ACP prompt is working, Esc calls the owned
`AcpClient.cancel()` exactly once, sends `session/cancel`, quarantines that
session as cancelled, and returns the pane to a clean non-working **ready** or
**off** state. A late `session/update` from the quarantined turn is emitted only
as `discarded_update`; late assistant text never reaches the pane.

## Check B15 — real Hermes ACP resume across launches

### Command

```bash
node scripts/bench-b15-live-resume.mjs
```

### Expected exit code

`0`

### What pass means

In an isolated `/tmp` workspace, a first real Hermes ACP launch receives an
opaque nonce and reaches `end_turn`. JobOS persists that session through
`writePersistedAcpSession` to `.jobos/acp-sessions.json`, and
`readPersistedAcpSession` returns it. After stopping the first ACP process, a
new `AcpClient` and Hermes process load the persisted id. The resumed id must be
identical, a second turn must reach `end_turn`, and its real agent-message text
must contain the nonce known only from the prior turn. Missing Hermes, a stale
or replaced id, missing persistence, session-load failure, timeout, or lost
conversation context exits non-zero honestly.

## Frozen critic record format (B10–B15)

For each check record:

```
CHECK: B<n>
COMMAND: <exact command above>
EXIT: <code>
PASS_EVIDENCE: <one sentence, live evidence, or fail output>
```

B10–B15 extend, and do not replace, B1–B9. The verdict remains pass or fail
only.
