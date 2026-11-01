// Pure checks for the assistant panel (assets/hq-ai.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const A = require("../assets/hq-ai.js").pure;

const b = A.parseAnswer("Tu as **trois** choses [1] :\n- Labo jeudi [2]\n- Vis à racheter [3, 9]\n\nC'est tout.", 3);
assert.equal(b.length, 3);
assert.deepEqual(b[0].runs, [{ text: "Tu as trois choses " }, { ref: 1 }, { text: " :" }]);
assert.equal(b[1].type, "list");
assert.deepEqual(b[1].items[1], [{ text: "Vis à racheter " }, { ref: 3 }], "an unknown source number is dropped");
assert.deepEqual(b[2], { type: "p", runs: [{ text: "C'est tout." }] });
assert.deepEqual(A.parseAnswer("## Titre\n1. un", 0).map((x) => x.type), ["p", "list"]);
assert.deepEqual(A.target("#projets/prj-a"), { view: "projets", hash: "#projets/prj-a" });
assert.deepEqual(A.target("#calendrier"), { view: "calendrier", hash: "" });
assert.deepEqual(A.target("#carnet/page-1/block-2"), { view: "carnet", hash: "#carnet/page-1/block-2" });
assert.equal(A.target("javascript:alert(1)"), null);
assert.equal(A.target("https://evil.example"), null);
for (const k of ["event", "task", "project_note", "stock", "note"]) assert.ok(A.KIND[k], k);

const src = readFileSync(new URL("../assets/hq-ai.js", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), "no HTML from strings");
assert.ok(!/AQ\.[A-Za-z0-9_-]{20,}|x-goog-api-key/.test(src), "no key in the page");
const css = readFileSync(new URL("../assets/hq-ai.css", import.meta.url), "utf8");
assert.ok(!/animation:[^;}]*infinite/.test(css.split("@media (prefers-reduced-motion:no-preference)")[0]), "loops only with motion allowed");
console.log("check_hq_ai: ok");
