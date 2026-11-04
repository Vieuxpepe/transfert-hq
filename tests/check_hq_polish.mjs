import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

const css = readFileSync(new URL("../assets/hq-polish.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../assets/hq-polish.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
const P = require("../assets/hq-polish.js").pure;

assert.ok(/prefers-reduced-motion/.test(css) && /prefers-reduced-motion/.test(src));
const loops = css.split("@media (prefers-reduced-motion:no-preference)")[0];
assert.ok(!/animation:[^;}]*infinite/.test(loops), "infinite loops only with motion allowed");
assert.ok(src.includes("onViewChange") && src.includes("successBurst") && src.includes("hq_polish_sound"));
assert.ok(P.hourTone(3) === "night" && P.hourTone(10) === "day" && P.hourTone(19) === "dusk");
assert.ok(bridge.includes("hq-polish.css") && bridge.includes("hq-polish.js"));
assert.ok(bridge.includes("player-primary") && bridge.includes("hq-polish-sound"));
console.log("check_hq_polish: ok");
