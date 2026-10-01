// Pure checks for the shared editor command registry (assets/hq-carnet-commands.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet-commands.js");
const Rich = require("../assets/hq-carnet-rich.js");

// registry shape
const ids = C.COMMANDS.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length, "unique ids");
for (const want of ["paragraph", "heading", "bullet", "number", "check", "image", "camera", "file", "drawing", "measure", "calc", "decision", "task", "cite", "time"]) assert.ok(ids.includes(want), want);
for (const c of C.COMMANDS) assert.ok(c.label && c.hint && Array.isArray(c.keys) && ["block", "tool", "format"].includes(c.kind), c.id);

// ---- product phase 1: categories, icons, concise hints, honest shortcuts
assert.deepEqual(C.CATEGORIES.map((c) => c.label), ["Écrire", "Ajouter", "Ingénierie", "Projet"]);
const byCat = (cat) => C.COMMANDS.filter((c) => c.cat === cat).map((c) => c.label);
assert.deepEqual(byCat("write"), ["Texte", "Titre", "Liste", "Liste numérotée", "Checklist"]);
assert.deepEqual(byCat("add"), ["Image", "Photo", "Tableau", "Encadré", "Section repliable", "Groupe d'images", "Croquis", "Fichier", "Dessin"]);
assert.deepEqual(byCat("eng"), ["Mesure", "Calcul", "Décision"]);
assert.deepEqual(byCat("project"), ["Tâche", "Référence", "Heure"]);
for (const c of C.COMMANDS) {
  assert.ok(C.category(c.cat), "known category " + c.id);
  assert.match(c.icon, /^[MmLlHhVvZzAaCcQq0-9 .,\-]+$/, "icon is a plain stroke path " + c.id);
  assert.ok(c.hint.length <= 32, "concise description " + c.id + ": " + c.hint);
  assert.ok(c.shortcut === undefined, "no invented shortcut on " + c.id);
}
assert.equal(new Set(C.COMMANDS.map((c) => c.icon)).size, C.COMMANDS.length, "every command has its own icon");

// ---- catalog: grouped when the query is empty (with Récents first when there are some), flat results otherwise
let g = C.catalog({});
assert.deepEqual(g.map((x) => x.label), ["Écrire", "Ajouter", "Ingénierie", "Projet"]);
assert.equal(C.flatten(g).length, C.COMMANDS.length);
g = C.catalog({ recents: ["calc", "image", "calc", "nope", "heading", "time"] });
assert.equal(g[0].id, "recent");
assert.deepEqual(g[0].items.map((c) => c.id), ["calc", "image", "heading"], "unknown ids dropped, duplicates collapsed, shown capped at 3");
assert.equal(g.length, 5);
g = C.catalog({ query: "mes" });
assert.deepEqual(g.map((x) => x.id), ["results"]);
assert.equal(g[0].items[0].id, "measure");
assert.deepEqual(C.catalog({ query: "zzzzzz" }), []);
assert.deepEqual(C.catalog({ exclude: ["calc"] }).find((x) => x.id === "eng").items.map((c) => c.id), ["measure", "decision"]);

// ---- fuzzy ranking: accepted ranks 0..3 unchanged, in-order letters (rank 4) as the extension
assert.equal(C.filter("chk")[0].id, "check", "chk -> Checklist");
assert.equal(C.filter("mesr")[0].id, "measure", "mesr -> Mesure");
assert.equal(C.filter("clcl")[0].id, "calc", "clcl -> Calcul");
assert.equal(C.filter("dsn")[0].id, "drawing", "dsn -> Dessin (tight match beats looser ones)");
assert.equal(C.filter("ingenierie").length, 3, "a category name finds its commands");
assert.deepEqual(C.filter("ingenierie").map((c) => c.id), ["measure", "calc", "decision"]);
assert.equal(C.filter("tableau")[0].id, "table", "Phase 2: Tableau is now a real table block (it used to resolve to Tâche)");
assert.ok(C.filter("tableau").some((c) => c.id === "task"), "Tâche is still reachable through the same word");
assert.equal(C.filter("tache")[0].id, "task");
assert.equal(C.filter("TÂCHE")[0].id, "task");
assert.ok(C.filter("m").length >= 1 && C.filter("m")[0].label.toLowerCase().startsWith("m"), "single letter: prefix only, no fuzzy noise");
assert.ok(C.filter("m").every((c) => /m/i.test(c.label + c.keys.join(" ") + c.hint + C.category(c.cat).label)), "single letter never fuzzy-matches unrelated commands");
assert.ok(C.score("deci", C.byId("decision")).rank === 0 && C.score("chk", C.byId("check")).rank === 4);
assert.equal(C.score("xyz", C.byId("check")), null);
// determinism: same query, same order
assert.deepEqual(C.filter("li").map((c) => c.id), C.filter("li").map((c) => c.id));
assert.deepEqual(C.filter("").map((c) => c.id), C.COMMANDS.map((c) => c.id), "empty query keeps registry order");

// ---- recents: pure, bounded, sanitized
assert.deepEqual(C.pushRecent([], "calc"), ["calc"]);
assert.deepEqual(C.pushRecent(["calc", "image"], "image"), ["image", "calc"], "a repeat moves to the front");
let recent = [];
for (const id of ["paragraph", "heading", "bullet", "number", "check", "image"]) recent = C.pushRecent(recent, id);
assert.equal(recent.length, C.RECENTS_MAX);
assert.deepEqual(recent, ["image", "check", "number", "bullet"]);
assert.deepEqual(C.pushRecent(["calc"], "not-a-command"), ["calc"], "an unknown id is ignored");
assert.deepEqual(C.sanitizeRecents("calc"), []);
assert.deepEqual(C.sanitizeRecents(["calc", 3, null, {}, "calc", "time"]), ["calc", "time"]);
assert.deepEqual(C.sanitizeRecents(null), []);
const before = ["calc"];
C.pushRecent(before, "time");
assert.deepEqual(before, ["calc"], "input never mutated");

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
