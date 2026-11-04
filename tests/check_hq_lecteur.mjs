import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { calm } = require("../assets/hq-lecteur.js");

assert.equal(typeof calm(), "boolean");
const css = readFileSync(new URL("../assets/hq-lecteur.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../assets/hq-lecteur.js", import.meta.url), "utf8");
assert.ok(/prefers-reduced-motion/.test(css));
assert.ok(src.includes("hqPlayerFlyFrom") && src.includes("onMediaLoad"));
console.log("check_hq_lecteur: ok");
