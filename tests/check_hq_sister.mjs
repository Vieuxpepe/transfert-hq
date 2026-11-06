/**
 * Node checks for assets/hq-sister.js core helpers (no DOM required).
 * Run: node tests/check_hq_sister.mjs
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = require(path.join(root, "assets", "hq-sister.js"));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok:", msg);
  }
}

assert(typeof core.shouldAppendSisterRow === "function", "shouldAppendSisterRow export");
assert(typeof core.clientMayReactToAmbient === "function", "clientMayReactToAmbient export");
assert(typeof core.attentionBlocksBanter === "function", "attentionBlocksBanter export");
assert(typeof core.stripRows === "function", "stripRows export");
assert(typeof core.createSisterDirector === "function", "createSisterDirector export");
assert(typeof core.ensureSister === "function", "ensureSister export");
assert(core.MSG_CAP === 40, "message cap");
assert(core.attentionBlocksBanter({ document: { hidden: true } }) === true, "hidden blocks banter");

assert(core.shouldAppendSisterRow([], "else", "hi") === true, "append empty");
assert(core.shouldAppendSisterRow([{ speaker: "else", text: "hi" }], "else", "hi") === false, "dedupe last");
assert(core.shouldAppendSisterRow([{ speaker: "else", text: "hi" }], "transferania", "hi") === true, "other speaker ok");
assert(core.shouldAppendSisterRow([], "seed", "x") === false, "skip seed");

const rows = core.stripRows([
  { speaker: "seed", text: "s" },
  { speaker: "transferania", text: "a" },
  { speaker: "else", text: "b" },
  { speaker: "master", text: "m" },
], 6);
assert(rows.length === 3 && rows[0].speaker === "transferania", "stripRows filters seed");

assert(core.clientMayReactToAmbient({ sister_cue: true, text: "hello there world" }) === true, "cue+text ok");
assert(core.clientMayReactToAmbient({ sister_cue: true, text: "short" }) === false, "too short");
assert(core.clientMayReactToAmbient({ sister_cue: true, text: "hello there world", fallback: true }) === false, "no fallback");
assert(core.clientMayReactToAmbient({ sister_cue: true, text: "hello there world", nsfw: true }) === false, "no nsfw");
assert(core.clientMayReactToAmbient({ sister_cue: false, text: "hello there world" }) === false, "needs cue");

assert(core.labelSpeaker("else") === "Else", "label else");
assert(core.labelSpeaker("transferania") === "Transferania", "label t");

if (process.exitCode) {
  console.error("hq-sister checks failed");
  process.exit(1);
}
console.log("hq-sister checks passed");
