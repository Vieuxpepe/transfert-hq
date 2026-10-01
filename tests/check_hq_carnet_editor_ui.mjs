// Pure checks for the editor UI's placement maths + a static hygiene scan of the new modules. No browser, no server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const U = require("../assets/hq-carnet-editor-ui.js");

const view = { w: 1000, h: 700 };
const size = { w: 300, h: 40 };
// above by default, below when there is no room above, always clamped
let p = U.place({ top: 300, bottom: 320, left: 400, right: 500 }, size, view, false);
assert.ok(p.top < 300 && p.top >= 8, "above the anchor");
p = U.place({ top: 10, bottom: 30, left: 400, right: 500 }, size, view, false);
assert.ok(p.top >= 30, "no room above -> below");
p = U.place({ top: 300, bottom: 320, left: 400, right: 500 }, size, view, true);
assert.ok(p.top >= 320, "touch: below");
p = U.place({ top: 680, bottom: 700, left: 400, right: 500 }, size, view, true);
assert.ok(p.top + size.h <= view.h - 8 && p.top >= 8, "no room below -> above/clamped, on-screen");
p = U.place({ top: 300, bottom: 320, left: -50, right: 10 }, size, view, false);
assert.ok(p.left >= 8, "left clamp");
p = U.place({ top: 300, bottom: 320, left: 990, right: 1200 }, size, view, false);
assert.ok(p.left + size.w <= view.w - 8, "right clamp");
for (let top = -100; top < 900; top += 37) for (let left = -200; left < 1200; left += 91) for (const below of [true, false]) {
  const r = U.place({ top, bottom: top + 20, left, right: left + 60 }, size, view, below);
  assert.ok(r.left >= 8 && r.left + size.w <= view.w - 8 && r.top >= 8 && r.top + size.h <= view.h - 8, `always on-screen: ${top}/${left}/${below}`);
  assert.ok(Number.isInteger(r.top) && Number.isInteger(r.left));
}
assert.deepEqual(U.SEL_ACTIONS.map((a) => a[2]), ["Gras", "Italique", "Souligné", "Surligné", "Code", "Lien", "Référence", "Effacer la mise en forme"]);

// hygiene of the three new/changed UI modules: no HTML-string sinks, no storage, no network, no dynamic code
for (const f of ["hq-carnet-editor-ui.js", "hq-carnet-commands.js", "hq-carnet-image-ui.js"]) {
  const src = readFileSync(new URL("../assets/" + f, import.meta.url), "utf8");
  for (const bad of [/innerHTML\s*=/, /outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /localStorage/, /sessionStorage/, /indexedDB/, /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /setTimeout\s*\(\s*["'`]/]) {
    assert.ok(!bad.test(src), `${f} must not contain ${bad}`);
  }
}
console.log("check_hq_carnet_editor_ui: ok");
