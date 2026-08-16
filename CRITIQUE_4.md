# CRITIQUE_4 — Iteration 1

Critic scope only. No product TUI, `src/**`, tests, or `BENCHMARK.md` were edited by this critique.

Node precondition: `v22.22.3`.

Reference comparison: `spikes/visualizer/classic.html` defines the covering overlay as `position: absolute; inset: 0`, and its header/footer use `Workspace | Jobs` plus `/ in Chat` and `Tab Job · People · Chat`. `spikes/visualizer/app.js` defines the compact `Job | People | Chat` pane family. B6–B9 exercise the corresponding terminal layout invariants.

CHECK: B1
COMMAND:
```bash
node --test --test-concurrency=1 \
  tests/tui-*.test.js \
  tests/guided-setup-navigation.test.js \
  tests/p0-p1-first-run-ux.test.js \
  tests/w08-career-memory-tui.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP summary was `# tests 98`, `# pass 98`, `# fail 0`, `# skipped 0`, with `# duration_ms 53111.970877`; the included B9 subtest also passed.

CHECK: B2
COMMAND:
```bash
npm test
```
EXIT: 0
PASS_EVIDENCE: Final TAP summary was `# tests 685`, `# pass 684`, `# fail 0`, `# skipped 1`, `# duration_ms 1148371.683875`. The sole skip was `cover letter PDF render blocks underfilled stub and passes a full letter # SKIP tectonic and/or Poppler utilities not installed`, which is the allowed Tectonic/Poppler skip.

B2 runner history (not scored as product failures): an earlier identical invocation was terminated by the command harness after 900 seconds and therefore produced no process exit code; its actual final harness line was `Command timed out after 900 seconds` after partial output through test 343. A subsequent invocation was interrupted by the prior session with `No result provided`; after revival, `ps` showed no overlapping `npm test` or `node --test` process. The completed invocation above is the frozen B2 result.

CHECK: B3
COMMAND:
```bash
npm run smoke
```
EXIT: 0
PASS_EVIDENCE: Smoke returned JSON with `"ok": true`; the isolated root was `/tmp/jobos-smoke-lQwimz`, `submissionPerformed` remained `false`, and `externalSideEffects` remained `"none"` across receipt, discovery, networking, W03, W04, W07, and W08 evidence.

CHECK: B4
COMMAND:
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
EXIT: 0
PASS_EVIDENCE: The exact isolated wrapper produced no stdout/stderr and exited 0, so every frozen identity, isolation, no-ACP, no-mock-data, and no-retired-chrome assertion held.

CHECK: B5
COMMAND A:
```bash
node src/cli.js agent-guide --json
```
EXIT A: 0
PASS_EVIDENCE A: Stdout parsed as JSON. It reported `architecture.interactive: "tui"`, `architecture.sideEffects: "default-off"`, exit codes `0/1/2`, and the `tui` command flags `--agent off`, `--snapshot`, `--width <columns>`, and `--height <rows>`. Required human-only domain tools reported `agentEligible: false` and `mediation: "trusted_cli_or_tui_only"`, including artifact approve/reject, packet creation, submission attestation, answers add, contact approval/record, mark sent, and memory accept/reject/revoke.

COMMAND B:
```bash
node src/cli.js score
```
EXIT B: 2
PASS_EVIDENCE B: Stderr was exactly `jobos: Missing job id`, matching `^jobos:`.

CHECK: B6
COMMAND:
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
EXIT: 0
PASS_EVIDENCE: The exact wrapper produced no stdout/stderr and exited 0; its 80×24 row-fill, trailing-row, covering-welcome, and non-crushed-navigation assertions all held.

CHECK: B7
COMMAND:
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
EXIT: 0
PASS_EVIDENCE: The exact wrapper produced no stdout/stderr and exited 0; its 140×42 row-fill, trailing-row, and non-crushed-navigation assertions all held.

CHECK: B8
COMMAND:
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
EXIT: 0
PASS_EVIDENCE: The exact wrapper produced no stdout/stderr and exited 0; welcome identity was present while rail tabs, pane tabs, and rail body copy were covered.

CHECK: B9
COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```
EXIT: 0
PASS_EVIDENCE: TAP summary was `# tests 1`, `# pass 1`, `# fail 0`, `# skipped 0`; `B9 board pane tabs hug their content instead of stretching across the main pane` passed in 69.445778 ms.

VERDICT: pass

## Residual risks

- `npm test` needed about 19.1 minutes (`1148371.683875 ms`), exceeding the first 900-second command-harness allowance; environments with a 15-minute job timeout may terminate a healthy suite before its summary.
- B6–B8 validate deterministic non-TTY snapshots, not a human-driven interactive TTY resize session.
- The worktree was already broadly dirty before this critique. The frozen bar passes the current aggregate tree, but `git status` alone cannot attribute all pre-existing product/test changes solely to this iteration's stated layout P0.
- The one B2 skip leaves PDF rendering unexecuted on this host because Tectonic and/or Poppler are unavailable; this is explicitly allowed by the frozen bar.
