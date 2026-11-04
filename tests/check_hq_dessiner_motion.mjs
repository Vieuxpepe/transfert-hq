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
console.log("check_hq_dessiner_motion: ok");
