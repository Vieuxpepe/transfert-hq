import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../assets/hq-dessiner-motion.js");

assert.equal(typeof M.calm(), "boolean");
const css = readFileSync(new URL("../assets/hq-dessiner-motion.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../assets/hq-dessiner-motion.js", import.meta.url), "utf8");
assert.ok(/prefers-reduced-motion/.test(css));
assert.ok(src.includes("hq-sk-motion"));
const dess = readFileSync(new URL("../assets/hq-dessiner.js", import.meta.url), "utf8");
assert.ok(dess.includes('skMotion("save")'));
// regression: .sk itself carries data-tool for the cursor styles, so the tool branch of the click delegation must
// ignore anything that is not a BUTTON — otherwise every data-act button (save, open, settings, undo…) is swallowed
assert.ok(/\.closest\("\[data-tool\]"\);\s*\n\s*if \(t && t\.tagName === "BUTTON"\)/.test(dess),
  "the [data-tool] branch of the click delegation must require a BUTTON");
console.log("check_hq_dessiner_motion: ok");
