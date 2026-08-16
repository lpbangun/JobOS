# CRITIQUE_5 — Iteration 2 frozen-bar review

Node precondition: `v22.22.3` (Node 22+).

## Frozen critic log

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

PASS_EVIDENCE: TAP reported `tests 98`, `pass 98`, `fail 0`, `skipped 0`; this included the B9 live visual test and the targeted setup, keymap, ACP, artifact, contact, rail, Classic-theme, and Career Memory checks.

---

CHECK: B2

COMMAND:
```bash
npm test
```

EXIT: 0

PASS_EVIDENCE: TAP reported `tests 685`, `pass 684`, `fail 0`, `skipped 1`, duration `1151160.779707 ms`. The only skip was actual output `cover letter PDF render blocks underfilled stub and passes a full letter # SKIP tectonic and/or Poppler utilities not installed`, which is the allowed `tests/tailored-resume.test.js` dependency skip.

---

CHECK: B3

COMMAND:
```bash
npm run smoke
```

EXIT: 0

PASS_EVIDENCE: Smoke emitted JSON with `"ok": true`; the isolated root was `/tmp/jobos-smoke-Ln5MuN`, score was `71`, packet receipt state was `confirmed`, `submissionPerformed` was `false`, and all reported external side effects were `none`.

---

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

PASS_EVIDENCE: The wrapper produced no output and exited 0, so every isolated snapshot IA, non-fabrication, no-ACP, and retired-chrome assertion held.

---

CHECK: B5

COMMAND:
```bash
node src/cli.js agent-guide --json
```

EXIT: 0

PASS_EVIDENCE: Stdout parsed as JSON. Actual fields were `architecture.interactive: "tui"`, `architecture.sideEffects: "default-off"`, and exit codes `0/1/2`; the `tui` command flags were `--agent off`, `--snapshot`, `--width <columns>`, and `--height <rows>`. Required human-only artifact, packet, attestation, answers, contact, outreach, and memory accept/reject/revoke tools were `agentEligible: false` with `mediation: "trusted_cli_or_tui_only"`.

CHECK: B5

COMMAND:
```bash
node src/cli.js score
```

EXIT: 2

PASS_EVIDENCE: Actual stderr was `jobos: Missing job id`, matching `^jobos:`.

---

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

PASS_EVIDENCE: The wrapper produced no output and exited 0; the 80×24 paint met the row-fill threshold, exposed no rail body through welcome, and had no crushed combined navigation row.

---

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

PASS_EVIDENCE: The wrapper produced no output and exited 0; the 140×42 paint met the row-fill threshold and did not collapse both navigation families into one strip.

---

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

PASS_EVIDENCE: The wrapper produced no output and exited 0; welcome was open while New/Jobs rail segments, Job/People/Chat pane tabs, and rail empty copy were absent.

---

CHECK: B9

COMMAND:
```bash
node --test --test-concurrency=1 tests/tui-live-visual.test.js
```

EXIT: 0

PASS_EVIDENCE: TAP reported `tests 1`, `pass 1`, `fail 0`; `B9 board pane tabs hug their content instead of stretching across the main pane` passed.

## Iteration 2 interaction review

- The isolated 80×24 first paint visibly showed `Enter starts setup · Esc skips`, matching the iteration requirement and the Classic visualizer’s covering welcome treatment.
- `src/tui/components.js` renders a theme-accent `█` caret in the shared composer/inline entry component.
- `src/tui/runtime.js` normalizes Ink’s `{ name: "tab", shift: true }` into reverse tab cycling and routes `/daily` through trusted-TUI `daily_discovery`.
- `agent-guide --json` lists neither `--mouse` for `tui` nor for setup help/registry flags.
- An additional isolated in-process interaction probe exited 0 and printed: `interaction probes passed: caret rendered; key.shift reversed; /daily completed real no-source discovery`.
- Comparison against `spikes/visualizer/classic.html` and `spikes/visualizer/app.js` found the relevant correspondence: covering overlay, Classic footer hints, compact tabs, composer prompt, Shift+Tab reversal, and `/daily` focusing New. No retired box renderer or spike cyan/purple product theme was observed by the bar.

## Verdict

VERDICT: pass

B6+ FAILS TODAY: no. B6, B7, B8, and B9 each exited 0.

## Files changed by critic

- `/home/logani/.pi/agent/sessions/--home-logani-.herdr-worktrees-Job App-exp-tui-migration--/subagent-artifacts/outputs/6451a018-2049-4500-8e3c-75683e70fbe3/critique2.md`

No repository product files, tests, `src/**`, `BENCHMARK.md`, or prior critique files were edited. The authoritative runtime output path was used rather than creating a repository `CRITIQUE_5.md`.

## Residual risks

- B6–B8 are isolated non-TTY snapshot wrappers despite their “live” labels; they do not exercise a real terminal emulator’s escape-sequence decoding or repaint behavior.
- The committed KEYMAP test injects normalized `shiftTab`; the raw Ink-shaped `key.shift` path and `/daily` completion were independently probed during this critique but are not separately frozen regression tests.
- The full suite retained the one permitted Tectonic/Poppler skip, so PDF visual rendering was not exercised on this host.
- The worktree already contained many unstaged modifications and untracked files before review. No files were staged, and the critic did not alter those repository changes.
