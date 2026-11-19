// The HQ type scale: six steps and nothing between them (11 / 13 / 15 / 17 / 20 / 26).
// Every font-size the page can paint must land on a step, or be deliberate display art (>= 38px: the
// clock face, the album glyph), or an icon reset (0). Relative sizes are how the scale leaked before:
// `em` compounds against a parent nobody checked, so it is allowed only in the notebook's document
// prose, where the reader's own content has to scale; `rem` is read against the 16px root.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const STEPS = [11, 13, 15, 17, 20, 26];
const DISPLAY_MIN = 38; // larger than this is art, not text
const EM_ALLOWED = new Set(["hq-carnet.css"]); // document prose scales with its parent on purpose
const ROOT_FONT = 16;

const fail = [];
const note = (file, line, token, why) => fail.push(`${file}:${line}: ${token.trim()} — ${why}`);

function checkValue(file, line, raw, inPrint) {
  const v = String(raw).trim().toLowerCase();
  if (!v || /^(inherit|initial|unset|revert|revert-layer)$/.test(v) || v.includes("var(")) return;
  if (/\$\{/.test(v)) return; // a computed size in a JS template: measured in the browser, not here
  const fluid = /min\(|max\(|clamp\(/.test(v); // a bounded size: its px/rem bounds are checked below
  const lengths = [...v.matchAll(/(\d*\.?\d+)(px|rem|em|%|pt|vw|vh|cqw|cqh|ch)/g)];
  for (const m of lengths) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "em") {
      if (!EM_ALLOWED.has(file)) note(file, line, m[0], "em sizes compound against a parent; use a --text-* step");
      continue;
    }
    if (unit === "%") {
      if (n !== 100) note(file, line, m[0], "a percentage font-size hides the step it lands on");
      continue;
    }
    if (unit === "pt") {
      // Paper is measured in points; on screen it hides the scale.
      if (!inPrint) note(file, line, m[0], "pt is a print size; on screen use a --text-* step");
      continue;
    }
    if (unit !== "px" && unit !== "rem") {
      if (!fluid) note(file, line, m[0], "viewport/container units are outside the scale unless min()/max()/clamp() bounds them");
      continue;
    }
    const size = unit === "rem" ? n * ROOT_FONT : n;
    if (size === 0 || size >= DISPLAY_MIN) continue;
    if (!STEPS.some((s) => Math.abs(s - size) < 0.01)) {
      note(file, line, m[0], `${size}px is not a step (${STEPS.join("/")})`);
    }
  }
}

// `font: 600 15px/1.2 var(--font)` — only the size token is measured.
function shorthandSize(value) {
  for (const tok of value.trim().split(/\s+/)) {
    const head = tok.split("/")[0];
    if (/^\d*\.?\d+(px|rem|em|%)$/.test(head)) return head;
  }
  return null;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

// Line numbers inside an `@media print` block: paper sizes there are physical, not the screen scale.
function printLines(text) {
  const lines = new Set();
  const stack = [];
  let buf = "";
  let line = 1;
  for (const ch of text) {
    if (ch === "\n") line += 1;
    else if (ch === "{") {
      stack.push({ at: buf.trim(), from: line });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (top && /^@media[^{]*\bprint\b/i.test(top.at)) for (let l = top.from; l <= line; l += 1) lines.add(l);
      buf = "";
    } else if (ch === ";") buf = "";
    else buf += ch;
  }
  return lines;
}

function scan(file, text) {
  const clean = stripComments(text);
  const printed = printLines(clean);
  clean.split("\n").forEach((line, i) => {
    const inPrint = printed.has(i + 1);
    for (const m of line.matchAll(/font-size\s*:\s*([^;}]+)/gi)) checkValue(file, i + 1, m[1], inPrint);
    for (const m of line.matchAll(/(?:^|[\s;{])font\s*:\s*([^;}]+)/gi)) {
      const size = shorthandSize(m[1]);
      if (size) checkValue(file, i + 1, size, inPrint);
    }
  });
}

const assetFiles = readdirSync(new URL("assets/", ROOT)).filter((n) => /\.(css|js)$/.test(n));
for (const file of assetFiles) scan(file, readFileSync(new URL("assets/" + file, ROOT), "utf8"));

// BASE_CSS and the modules that build inline styles live in Python.
const pyFiles = readdirSync(ROOT).filter((n) => n.endsWith(".py") && !n.includes("conflict-backup"));
for (const file of pyFiles) scan(file, readFileSync(new URL(file, ROOT), "utf8"));

const base = readFileSync(new URL("iphone_bridge.py", ROOT), "utf8");
for (const step of ["--text-xs:11px", "--text-sm:13px", "--text-md:15px", "--text-lg:17px", "--text-xl:20px", "--text-2xl:26px"]) {
  assert.ok(base.includes(step), `BASE_CSS keeps the step ${step}`);
}
assert.ok(!/^\s*--text-base\s*:/m.test(base), "--text-base:16px stays retired: 16px was a seventh size between 15 and 17");

assert.deepEqual(fail, [], "off-scale font sizes:\n  " + fail.join("\n  ") + "\n");
console.log(`check_hq_scale: ok (${STEPS.length} steps, ${assetFiles.length} asset files, ${pyFiles.length} python files)`);
