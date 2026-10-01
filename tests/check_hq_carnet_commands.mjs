// Pure checks for the shared editor command registry (assets/hq-carnet-commands.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet-commands.js");
const Rich = require("../assets/hq-carnet-rich.js");

// registry shape
const ids = C.COMMANDS.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length, "unique ids");
for (const want of ["paragraph", "heading", "bullet", "number", "check", "image", "camera", "file", "drawing", "measure", "calc", "decision", "cite", "time"]) assert.ok(ids.includes(want), want);
assert.deepEqual(C.insertItems().map((c) => c.id), ["image", "camera", "file", "drawing", "measure", "calc", "decision"]);
for (const c of C.COMMANDS) assert.ok(c.label && c.hint && Array.isArray(c.keys) && ["block", "tool", "format"].includes(c.kind), c.id);

// filter / rank (accent- and case-insensitive; label prefix beats keyword)
assert.equal(C.filter("").length, C.COMMANDS.length);
assert.equal(C.filter("deci")[0].id, "decision");
assert.equal(C.filter("DÉCI")[0].id, "decision");
assert.equal(C.filter("titre")[0].id, "heading");
assert.ok(C.filter("liste").map((c) => c.id).slice(0, 2).every((i) => ["bullet", "number"].includes(i)));
assert.deepEqual(C.filter("zzzzzz"), []);
assert.ok(C.filter("photo").map((c) => c.id).includes("camera"));

// slash eligibility
const para = (t) => ({ type: "paragraph", text: t });
assert.equal(C.slashEligible(para(""), 0), true);
assert.equal(C.slashEligible(para("abc "), 4), true, "after whitespace");
assert.equal(C.slashEligible(para("abc"), 3), false, "mid-word");
assert.equal(C.slashEligible(para("abc"), 0), true, "start of line");
assert.equal(C.slashEligible(para(""), 0, { composing: true }), false, "IME composition");
assert.equal(C.slashEligible(para(""), 0, { rangeSelection: true }), false);
assert.equal(C.slashEligible(para(""), 0, { readOnly: true }), false);
assert.equal(C.slashEligible({ type: "image", text: "" }, 0), false, "atoms never");
assert.equal(C.slashEligible({ type: "decision", text: "" }, 0), false);
assert.equal(C.slashEligible(null, 0), false);
assert.equal(C.slashEligible(para("ab"), 9), false);

// title guard: same first non-empty line as derive_title, prose only (paragraph/heading); atoms/lists never
const T = (type, text) => ({ type, text });
assert.equal(C.titleIndex([T("paragraph", "Titre"), T("paragraph", "x")]), 0);
assert.equal(C.titleIndex([T("heading", "Titre")]), 0);
assert.equal(C.titleIndex([T("paragraph", ""), T("paragraph", "Pump alignment")]), 1, "empty first paragraph: the real title line wears it");
assert.equal(C.titleIndex([T("paragraph", "  "), T("heading", "H"), T("paragraph", "x")]), 1, "whitespace-only is empty (derive_title strips)");
assert.equal(C.titleIndex([T("image", ""), T("paragraph", "Après l'image")]), 1, "atoms carry no text and are skipped like derive_title does");
assert.equal(C.titleIndex([T("bullet", "item"), T("paragraph", "later")]), -1, "a list item is never styled as the title");
assert.equal(C.titleIndex([T("check", "todo"), T("paragraph", "later")]), -1);
assert.equal(C.titleIndex([T("number", "un")]), -1);
assert.equal(C.titleIndex([T("decision", "go"), T("paragraph", "x")]), -1, "a decision is never the title block");
for (const t of ["image", "calc", "measure"]) assert.equal(C.titleIndex([T(t, "")]), -1, t + " alone");
assert.equal(C.titleIndex([T("paragraph", ""), T("paragraph", "")]), 0, "entirely empty page: first paragraph offers the affordance");
assert.equal(C.titleIndex([T("heading", "")]), -1, "empty heading-only page: nothing");
assert.equal(C.titleIndex([T("image", "")]), -1);
assert.equal(C.titleIndex([]), -1);

// transforms
const mk = () => {
  const l = [Rich.newLine("a"), Rich.newLine("b", "bullet"), Rich.newLine("c", "check", true)];
  l[0].id = "block-1"; l[1].id = "block-2"; l[2].id = "block-3";
  return l;
};
let r = C.move(Rich, mk(), 0, 1);
assert.deepEqual(r.lines.map((l) => l.id), ["block-2", "block-1", "block-3"]);
assert.equal(r.index, 1);
assert.equal(C.move(Rich, mk(), 0, -1).error, "edge");
assert.equal(C.move(Rich, mk(), 2, 1).error, "edge");
r = C.moveTo(Rich, mk(), 0, 2);
assert.deepEqual(r.lines.map((l) => l.id), ["block-2", "block-3", "block-1"], "ids preserved by reorder");
assert.equal(C.moveTo(Rich, mk(), 1, 1).error, "edge");
const src = mk();
r = C.duplicate(Rich, src, 2);
assert.equal(r.lines.length, 4);
assert.equal(r.lines[3].id, null, "duplicate gets a new identity");
assert.equal(r.lines[3].text, "c");
assert.equal(r.lines[3].checked, true);
assert.equal(src.length, 3, "input untouched");
assert.equal(src[2].id, "block-3");
r = C.remove(Rich, [Rich.newLine("only")], 0);
assert.equal(r.lines.length, 1);
assert.equal(r.lines[0].text, "", "never an empty page without a block");
assert.equal(C.remove(Rich, mk(), 1).lines.length, 2);
r = C.insertEmpty(Rich, mk(), 0, "above");
assert.equal(r.index, 0);
assert.equal(r.lines.length, 4);
assert.equal(r.lines[1].id, "block-1");
r = C.insertEmpty(Rich, mk(), 2, "below");
assert.equal(r.index, 3);
r = C.convert(Rich, mk(), 0, "heading");
assert.equal(r.lines[0].type, "heading");
r = C.convert(Rich, mk(), 2, "paragraph");
assert.equal(r.lines[0].checked, false);
assert.equal(r.lines[2].checked, false, "checked cleared when leaving check");
assert.equal(C.convert(Rich, mk(), 0, "image").error, "not-text");
assert.equal(C.convert(Rich, mk(), 0, "decision").error, "not-text");
const atom = [Rich.engLine("calc", { expr: "1+1" }) || Rich.newLine("", "calc")];
assert.equal(C.convert(Rich, atom, 0, "paragraph").error, "not-text", "atoms are never re-typed");
for (const bad of [-1, 9]) assert.equal(C.move(Rich, mk(), bad, 1).error, "invalid");

// caps: images (32) and decisions
const png = { id: "asset-x", mime: "image/png", w: 4, h: 4, width: 100, layout: "inline", caption: "", alt: "" };
const imgs = [];
for (let i = 0; i < Rich.IMAGES_PER_PAGE_MAX; i += 1) imgs.push(Rich.newLine("", "image", false, [], null, Object.assign({}, png, { id: "asset-" + i })));
const full = C.duplicate(Rich, imgs, 0);
assert.equal(imgs.length, 32);
assert.equal(full.error, "limit-images", "image cap respected");
assert.equal(C.duplicate(Rich, imgs.slice(0, 31), 0).lines.length, 32, "below the cap duplicates");
console.log("check_hq_carnet_commands: ok");
