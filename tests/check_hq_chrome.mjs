import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../assets/hq-chrome.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../assets/hq-chrome.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");

assert.ok(/prefers-reduced-motion/.test(css) && /prefers-reduced-motion/.test(src));
const loops = css.split("@media (prefers-reduced-motion:no-preference)")[0];
assert.ok(!/animation:[^;}]*infinite/.test(loops), "infinite loops only with motion allowed");
assert.ok(src.includes("hqToast") && src.includes("paletteOpened"));
assert.ok(src.includes("rippleTarget") && src.includes("hq-sk-app"));
assert.ok(src.includes("revealDisclosure") && src.includes("button.hq-disclosure"));
assert.ok(bridge.includes("hq-chrome.css"));
console.log("check_hq_chrome: ok");
