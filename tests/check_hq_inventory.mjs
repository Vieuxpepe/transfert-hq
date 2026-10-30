// Pure checks for the Inventaire UI (assets/hq-inventory.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const I = require("../assets/hq-inventory.js");
const P = I.pure;

const pl = (id, name, parent = null, extra = {}) => Object.assign({ id: "plc-" + id.padStart(16, "0"), name, parent: parent && "plc-" + parent.padStart(16, "0"), kind: "box", code: "AB" + id.padStart(2, "2").slice(-2), note: "", photos: [] }, extra);
const it = (id, name, place, extra = {}) => Object.assign({ id: "itm-" + id.padStart(16, "0"), name, place: place && "plc-" + place.padStart(16, "0"), qty: 1, unit: "", min: null, tags: [], note: "", photos: [] }, extra);
const doc = {
  places: [pl("1", "Garage", null, { kind: "room" }), pl("2", "Étagère 2", "1", { kind: "shelf" }), pl("3", "Boîte visserie", "2"), pl("4", "Bureau", null, { kind: "room" })],
  items: [it("1", "Vis M4×12", "3", { qty: 140, unit: "pcs", min: 200, tags: ["visserie", "m4"] }), it("2", "Écrou M4", "3", { qty: 300, tags: ["visserie"] }), it("3", "Perceuse", "1"), it("4", "Câble USB-C", null, { note: "1 m tressé" })],
};
const ix = P.index(doc);
assert.deepEqual(ix.kids.get("").map((p) => p.name), ["Bureau", "Garage"], "top level sorted by name");
assert.equal(P.pathText(ix, "plc-0000000000000003"), "Garage › Étagère 2 › Boîte visserie");
assert.equal(P.pathText(ix, null), "Sans emplacement");
assert.equal(P.countDeep(ix, "plc-0000000000000001"), 3, "items below count");
assert.deepEqual(P.descendants(ix, "plc-0000000000000001").map((p) => p.name), ["Étagère 2", "Boîte visserie"]);
// search: accents and case ignored, every word must match, tags and place path count
assert.deepEqual(P.search(doc, ix, "ecrou").items.map((i) => i.name), ["Écrou M4"]);
assert.deepEqual(P.search(doc, ix, "#visserie m4").items.map((i) => i.name).sort(), ["Vis M4×12", "Écrou M4"].sort());
assert.deepEqual(P.search(doc, ix, "garage perceuse").items.map((i) => i.name), ["Perceuse"]);
assert.deepEqual(P.search(doc, ix, "tressé").items.map((i) => i.name), ["Câble USB-C"]);
assert.deepEqual(P.search(doc, ix, "étagere").places.map((p) => p.name), ["Étagère 2"]);
assert.deepEqual(P.search(doc, ix, "   ").items, []);
// low stock
assert.equal(doc.items.filter(P.isLow).length, 1);
// tags
assert.deepEqual(P.parseTags("vis, #M4  écrous;#m4"), ["vis", "m4", "écrous"]);
// label links: only http(s) bases and real place ids
assert.equal(P.labelUrl("https://pc.tail1234.ts.net/", "plc-0000000000000003"), "https://pc.tail1234.ts.net/#inventaire/plc-0000000000000003");
assert.equal(P.labelUrl("http://192.168.1.20:8765", "plc-0000000000000003"), "http://192.168.1.20:8765/#inventaire/plc-0000000000000003");
assert.equal(P.labelUrl("javascript:alert(1)", "plc-0000000000000003"), "");
assert.equal(P.labelUrl("https://x.y/path", "plc-0000000000000003"), "");
assert.equal(P.labelUrl("https://x.y", "plc-../../"), "");
// the place picker never offers a place inside itself
const opts = P.placeOptions(ix, "plc-0000000000000001");
assert.deepEqual(opts.map((o) => o.label), ["Bureau"]);
assert.deepEqual(P.placeOptions(ix, null).map((o) => [o.label, o.depth]), [["Bureau", 0], ["Garage", 0], ["Étagère 2", 1], ["Boîte visserie", 2]]);
// hash routes
for (const h of ["#inventaire", "#inventaire/plc-0123456789abcdef", "#inventaire/sans-emplacement"]) assert.ok(P.HASH_RE.test(h), h);
for (const h of ["#inventaire/plc-XYZ", "#inventaire/../x", "#carnet/page-1/block-1"]) assert.ok(!P.HASH_RE.test(h), h);
assert.equal(P.fmtQty({ qty: 12500, unit: "pcs" }), "12 500 pcs");

// house rules
const src = readFileSync(new URL("../assets/hq-inventory.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sendBeacon", "WebSocket"]) assert.ok(!src.includes(bad), "no " + bad);
const urls = [...src.matchAll(/["'](\/api\/[^"'?]*)/g)].map((m) => m[1]);
assert.ok(urls.every((u) => u === "/api/inventory" || u.startsWith("/api/carnet/asset")), "talks only to its own API and the image store: " + urls);
console.log("check_hq_inventory: ok");
