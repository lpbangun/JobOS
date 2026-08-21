#!/usr/bin/env node
/**
 * Regenerate the README screenshots from real JobOS TUI frames.
 *
 * Renders the actual Ink app tree (JobosTui -> renderTui) at 140x42 with the
 * locked Classic-red theme, converts the emitted truecolor ANSI to a styled
 * HTML page, and screenshots it with headless Chromium (playwright, the
 * existing devDependency). The output is deterministic: a fixed fixture
 * workspace, no agent, and a fixed clock, so docs never show invented state.
 *
 * Output:
 *   docs/jobos-tui.png     board: New | Jobs rail with action chips and the
 *                          Job | People | Chat detail pane
 *   docs/jobos-chat.png    chat pane with the slash menu open over the prompt
 *   docs/jobos-setup.png   guided-setup overlay covering the board
 *
 * Run:
 *   FORCE_COLOR=3 node scripts/readme-shots.mjs
 *
 * FORCE_COLOR=3 makes Ink emit 24-bit SGR so the PNG keeps the exact Classic
 * tokens (background #111, accent #ff6b6b) instead of a 16-color reduction.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Must be set before ink (loaded below via src/tui.js) resolves color support,
// so the PNG keeps the exact Classic tokens instead of a 16-color reduction.
process.env.FORCE_COLOR = '3';

const [{ chromium }, { openStore, run, save }, { createProfile, addProof }, { importText }, { appCreate }, { createArtifact }, { JobosTui }] =
  await Promise.all([
    import('playwright'),
    import('../src/db.js'),
    import('../src/profiles.js'),
    import('../src/jobs.js'),
    import('../src/tracking.js'),
    import('../src/artifacts.js'),
    import('../src/tui.js')
  ]);

const WIDTH = 140;
const HEIGHT = 42;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.14;
const FONT_STACK = '"DejaVu Sans Mono", "Liberation Mono", Menlo, ui-monospace, monospace';
const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

// ---------------------------------------------------------------------------
// Fixture workspace (mirrors the deterministic pattern used by the TUI tests
// and bench harnesses: real domain calls into a throwaway workspace).
// ---------------------------------------------------------------------------

function streams() {
  const stdout = new PassThrough();
  stdout.columns = WIDTH;
  stdout.rows = HEIGHT;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function seedWorkspace(root) {
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  addProof(store, profile.id, 'Led a product launch adopted by 30 teams, driving 40% weekly activation.', 'resume fixture', ['product'], ['30', '40%']);

  const addJob = (fileName, title, company, createdAt, status) => {
    const file = path.join(root, fileName);
    writeFileSync(file, `Title: ${title}\nCompany: ${company}\nLocation: Remote\n\n${title} description with requirements and responsibilities for fit scoring.`);
    const job = importText(store, { profileId: profile.id, filePath: file }).job;
    run(store, 'UPDATE jobs SET updated_at=? WHERE id=?', [createdAt, job.id]);
    if (status) appCreate(store, job.id, status, '', { at: createdAt });
    return job;
  };

  // New rail: fresh, not yet in the pipeline (no action chips by design).
  addJob('new-1.md', 'Product Manager, Learning Platform', 'Example Learning Co', '2026-08-10T09:00:00.000Z');
  addJob('new-2.md', 'Staff Product Manager, Growth', 'Northstar Learning', '2026-08-12T09:00:00.000Z');
  // Pipeline: varied action chips (Needs review / Create files).
  const selected = addJob('job-1.md', 'Product Manager, Assessment Platform', 'Harbor Schools', '2026-07-28T09:00:00.000Z', 'saved');
  addJob('job-2.md', 'Senior PM, Data Infrastructure', 'Lumen Labs', '2026-07-20T09:00:00.000Z', 'saved');
  addJob('job-3.md', 'Product Manager, Career Services', 'Northstar Learning', '2026-07-05T09:00:00.000Z', 'applied');
  createArtifact(store, { jobId: selected.id, profileId: profile.id, type: 'resume', path: `jobs/${selected.id}/artifacts/resume.md`, title: 'Resume Harbor Schools', content: '# draft\n', evidence: [], warnings: [] });
  save(store);
  return { store, profile, selected };
}

// ---------------------------------------------------------------------------
// ANSI SGR -> inline CSS (truecolor-first; 256 and 16 color fallbacks).
// ---------------------------------------------------------------------------

const ANSI16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000cd', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'
];

function ansi256Rgb(n) {
  if (n < 16) return ANSI16[n];
  if (n < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    n -= 16;
    const r = levels[Math.floor(n / 36)];
    const g = levels[Math.floor((n % 36) / 6)];
    const b = levels[n % 6];
    return [r, g, b];
  }
  const gray = 8 + (n - 232) * 10;
  return [gray, gray, gray];
}

const DEFAULT_FG = '#f5f5f5';

function applySgr(style, params) {
  const p = params.split(';');
  const next = { ...style };
  for (let i = 0; i < p.length; i += 1) {
    const code = Number(p[i]);
    if (code === 0) {
      next.fg = null; next.bg = null; next.bold = false; next.dim = false;
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code >= 30 && code <= 37) next.fg = ANSI16[code - 30];
    else if (code >= 90 && code <= 97) next.fg = ANSI16[code - 90 + 8];
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = ANSI16[code - 40];
    else if (code >= 100 && code <= 107) next.bg = ANSI16[code - 100 + 8];
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = Number(p[i + 1]);
      if (mode === 5 && Number.isInteger(Number(p[i + 2]))) {
        const [r, g, b] = ansi256Rgb(Number(p[i + 2]));
        next[target] = `rgb(${r}, ${g}, ${b})`;
        i += 2;
      } else if (mode === 2 && i + 4 < p.length + 1) {
        const r = Number(p[i + 2]); const g = Number(p[i + 3]); const b = Number(p[i + 4]);
        if ([r, g, b].every(Number.isInteger)) {
          next[target] = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        } else i += 2;
      }
    }
  }
  return next;
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function span(text, style) {
  if (!text) return '';
  const rules = [];
  rules.push(`color:${style.fg || DEFAULT_FG}`);
  if (style.bg) rules.push(`background-color:${style.bg}`);
  if (style.bold) rules.push('font-weight:700');
  if (style.dim) rules.push('opacity:.55');
  return `<span style="${rules.join(';')}">${escapeHtml(text)}</span>`;
}

function ansiToHtml(text) {
  const re = /\x1b\[([0-9;]*)m/g;
  let out = '';
  let last = 0;
  let style = { fg: null, bg: null, bold: false, dim: false };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += span(text.slice(last, m.index), style);
    style = applySgr(style, m[1]);
    last = m.index + m[0].length;
  }
  out += span(text.slice(last), style);
  return out;
}

function pageHtml(frameHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: #111111; }
    #term {
      display: block; width: max-content;
      white-space: pre; overflow: hidden; padding: 0 1px;
      font-family: ${FONT_STACK};
      font-size: ${FONT_SIZE}px; line-height: ${LINE_HEIGHT};
      border: 1px solid #3a3a3a; border-radius: 8px;
    }
  </style></head><body><pre id="term">${frameHtml}</pre></body></html>`;
}

// ---------------------------------------------------------------------------
// Frames -> PNGs
// ---------------------------------------------------------------------------

async function capture(browser, html, outFile) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(html);
  const term = page.locator('#term');
  const box = await term.boundingBox();
  if (!box) throw new Error(`no #term box for ${outFile}`);
  await page.setViewportSize({ width: Math.ceil(box.width + 2), height: Math.ceil(box.height + 2) });
  await term.screenshot({ path: outFile });
  console.log(`wrote ${path.relative(process.cwd(), outFile)} (${Math.round(box.width)}x${Math.round(box.height)}px @2x)`);
  await page.close();
}

const root = mkdtempSync(path.join(tmpdir(), 'jobos-shots-'));
const browser = await chromium.launch({ headless: true });
try {
  const { store, profile, selected } = await seedWorkspace(root);

  const frames = [
    {
      file: 'jobos-tui.png',
      mutate(tui) {
        tui.state.welcomeDismissed = true;
        tui.state.headerMode = 'jobs';
        tui.state.leftMode = 'jobs';
        tui.state.jobTab = 'job';
      }
    },
    {
      file: 'jobos-chat.png',
      mutate(tui) {
        tui.state.welcomeDismissed = true;
        tui.state.headerMode = 'jobs';
        tui.state.leftMode = 'jobs';
        tui.state.jobTab = 'chat';
        tui.state.input = '/';
        tui.state.slashIndex = 0;
      }
    },
    {
      file: 'jobos-setup.png',
      mutate(tui) {
        tui.state.welcomeDismissed = true;
        tui.state.headerMode = 'jobs';
        tui.state.leftMode = 'jobs';
        tui.state.jobTab = 'job';
        tui.state.overlay = 'setup';
        tui.state.overlayIndex = 0;
      }
    }
  ];

  for (const frame of frames) {
    const tui = new JobosTui(store, { ...streams(), profileId: profile.id, selectedJobId: selected.id, connectAgent: false, color: true });
    tui.refresh();
    tui.state.clock = '09:41'; // fixed clock so the header is deterministic
    frame.mutate(tui);
    tui.refresh();
    const ansi = tui.render({ width: WIDTH, height: HEIGHT, color: true });
    const lines = ansi
      .replace(/\r/g, '')
      .split('\n')
      .slice(0, HEIGHT);
    const html = pageHtml(lines.map(line => ansiToHtml(line)).join('\n'));
    await capture(browser, html, path.join(DOCS_DIR, frame.file));
  }
  try { store.db.close(); } catch { /* noop */ }
} finally {
  await browser.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
}
