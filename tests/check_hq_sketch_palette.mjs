import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../assets/hq-sketch-palette.js");

assert.equal(P.COLORS.length, 6);
assert.equal(new Set(P.COLORS.map((c) => c.id)).size, 6);
for (const c of P.COLORS) {
  assert.match(c.id, /^[a-z]+$/);
  assert.match(c.phrase, /^dominante /);
  assert.match(c.swatch, /^#[0-9a-f]{6}$/i);
}

let r = P.withColor("", "", "bleu");
assert.equal(r.text, "dominante bleue");
assert.equal(r.id, "bleu");
r = P.withColor(r.text, "bleu", "");
assert.equal(r.text, "", "deselecting an empty-prompt colour clears its phrase");
assert.equal(r.id, "");
r = P.withColor("une cabane", "", "bleu");
assert.equal(r.text, "une cabane · dominante bleue");
r = P.withColor(r.text, "bleu", "vert");
assert.equal(r.text, "une cabane · dominante verte", "changing colour replaces the previous phrase");
r = P.withColor(r.text, "vert", "");
assert.equal(r.text, "une cabane", "deselecting removes only the palette phrase");
assert.equal(r.id, "");
assert.equal(P.withColor("une cabane", "", "inconnu").text, "une cabane");
assert.equal(P.withColor("  ", "", "ocre").text, "dominante ocre");

const calls = [];
const api = { open() {} };
const Paint = { mount(w, host) { calls.push([w, host]); return api; } };
const win = { HqSketchPaint: Paint, console };
assert.equal(P.install(win), true);
assert.equal(P.install(win), false, "installing twice would double-wrap mount");
assert.equal(Paint.mount(win, { querySelector() { return null; } }), api);
assert.equal(calls.length, 1);

console.log("hq-sketch-palette: ok");
