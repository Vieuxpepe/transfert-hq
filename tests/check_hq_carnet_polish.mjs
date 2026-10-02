// Pure checks of the Product Phase-3.5 interaction core (assets/hq-carnet-nav.js): block anchors, the page outline (a view over the parsed
// lines), the save-pill derivation, the inspector maths, deterministic suggestions and portal-card models. No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../assets/hq-carnet-nav.js");
const Rich = require("../assets/hq-carnet-rich.js");
const Cmd = require("../assets/hq-carnet-commands.js");
// the outline reuses the editor's accepted title rule (injected exactly like the browser host does)
const _build = N.buildOutline;
N.buildOutline = (lines, o) => _build(lines, Object.assign({ titleIndex: Cmd.titleIndex }, o || {}));
let groups = 0;
const group = (name, fn) => {
  try {
    fn();
    groups += 1;
  } catch (e) {
    console.error("FAIL group:", name);
    throw e;
  }
};

const P = "page-abc123";
const B = "block-0f3a9c";

group("anchor: canonical form, strict parse, zero junk accepted", () => {
  assert.equal(N.makeAnchor(P, B), "#carnet/page-abc123/block-0f3a9c");
  assert.deepEqual(N.parseAnchor(N.makeAnchor(P, B)), { pageId: P, blockId: B });
  assert.equal(N.makeAnchor("x", B), null);
  assert.equal(N.makeAnchor(P, "block-"), null);
  assert.equal(N.makeAnchor(P, "../etc"), null);
  assert.equal(N.makeAnchor(null, B), null);
  const bad = [
    "", "#", "#carnet", "#carnet/", "#carnet/page-a", "#carnet/page-a/", "#carnet//block-a", "#carnet/page-a/block-a/extra", "#carnet/page-a/block-a/",
    "#carnet/page-a/block-a?x=1", "#carnet/page-a/block-a#x", "#carnet/page-a/block-a ", " #carnet/page-a/block-a", "carnet/page-a/block-a",
    "#Carnet/page-a/block-a", "#carnet/page-%61/block-a", "#carnet/page-a/block-%61", "#carnet/page-a%2Fblock-a", "#carnet/page-a/block-a%2F..", "#carnet/page-a/%E0%A4%A",
    "#carnet/note-a/block-a", "#carnet/page-a/note-a", "#carnet/page-a/block-a\n", "#carnet/page-a/../block-a", "#carnet/../block-a", "#carnet/page-a/block-" + "a".repeat(65),
    "#carnet/page-" + "a".repeat(65) + "/block-a", "javascript:alert(1)", "#carnet/page-a/block-a\u0000", "#carnet/page-a/block-é",
  ];
  for (const h of bad) assert.equal(N.parseAnchor(h), null, "must reject " + JSON.stringify(h));
  for (const h of [null, undefined, 5, {}, []]) assert.equal(N.parseAnchor(h), null);
  assert.equal(N.parseAnchor("#carnet/" + "a".repeat(400)), null, "length bound");
  assert.equal(N.makeUrl({ origin: "http://h:1", pathname: "/", search: "" }, P, B), "http://h:1/#carnet/page-abc123/block-0f3a9c");
  assert.equal(N.makeUrl({ origin: "http://h:1", pathname: "/", search: "?a=1" }, P, B), "http://h:1/?a=1#carnet/page-abc123/block-0f3a9c");
  assert.equal(N.makeUrl({ origin: "http://h:1", pathname: "/" }, "bad", B), null);
  assert.equal(N.makeUrl(null, P, B), null);
});

const A = (c) => ({ id: "asset-" + c.repeat(24), mime: "image/png", w: 10, h: 8, caption: "" });
const blk = (type, extra, id) => Object.assign({ id: id || "block-" + Math.random().toString(16).slice(2, 10), type, text: "", marks: [] }, extra);
const page = (blocks) => Rich.linesFromContent({ version: 2, blocks });
const sample = () =>
  page([
    blk("paragraph", { text: "Banc d'essai" }, "block-title"),
    blk("paragraph", { text: "intro" }, "block-p1"),
    blk("heading", { text: "Montage" }, "block-h1"),
    blk("paragraph", { text: "texte" }, "block-p2"),
    blk("table", { table: { header: true, rows: [["Pièce", "Qté"], ["Vis", "4"]] } }, "block-t1"),
    blk("image", { asset: Object.assign(A("a"), { width: 100, layout: "inline", caption: "Vue de face" }) }, "block-i1"),
    blk("imagegroup", { group: { layout: "compare", items: [A("b"), A("c")] } }, "block-g1"),
    blk("drawing", { drawing: { id: "Plan-A_HQWeb-Desktop" } }, "block-d1"),
    blk("heading", { text: "  " }, "block-h2"),
    blk("heading", { text: "Résultats" }, "block-h3"),
  ]);

group("outline: title + headings + assets from the parsed model; paragraphs and empty headings never listed", () => {
  const lines = sample();
  assert.ok(lines);
  const o = N.buildOutline(lines, { drawingLabel: Rich.Struct.drawingLabel });
  assert.deepEqual(o.items.map((i) => [i.kind, i.group, i.id, i.label]), [
    ["title", "text", "block-title", "Banc d'essai"],
    ["heading", "text", "block-h1", "Montage"],
    ["table", "asset", "block-t1", "Tableau · Pièce"],
    ["image", "asset", "block-i1", "Image · Vue de face"],
    ["imagegroup", "asset", "block-g1", "Avant / après"],
    ["drawing", "asset", "block-d1", "Croquis · Plan-A"],
    ["heading", "text", "block-h3", "Résultats"],
  ]);
  assert.deepEqual(o.items.map((i) => i.index), [0, 2, 4, 5, 6, 7, 9]);
  assert.equal(N.buildOutline(null).items.length, 0);
  assert.equal(N.buildOutline([]).sig, "");
  assert.equal(N.buildOutline(page([blk("paragraph", { text: "" }, "block-e")])).items[0].label, "Page sans titre");
  assert.equal(N.buildOutline(page([blk("heading", { text: "Gros titre" }, "block-e")])).items[0].kind, "title", "a heading on line 0 is the page title, not listed twice");
});

group("outline title follows Carnet's accepted first-non-empty-line rule (HqCarnetCommands.titleIndex)", () => {
  const title = (lines) => N.buildOutline(page(lines)).items.filter((i) => i.kind === "title").map((i) => [i.id, i.label]);
  assert.deepEqual(title([blk("paragraph", { text: "" }, "block-a"), blk("paragraph", { text: "Rapport moteur" }, "block-b")]), [["block-b", "Rapport moteur"]], "empty paragraph then paragraph");
  const img = { id: "asset-0123456789abcdef01234567", mime: "image/png", w: 10, h: 10, width: 100, layout: "inline", caption: "" };
  assert.deepEqual(title([blk("image", { text: "", asset: img }, "block-i"), blk("paragraph", { text: "Inspection moteur" }, "block-b")]), [["block-b", "Inspection moteur"]], "image then paragraph: the atom has no text, the paragraph is the title");
  assert.deepEqual(title([blk("paragraph", { text: "" }, "block-a"), blk("paragraph", { text: "  " }, "block-c"), blk("heading", { text: "Gros" }, "block-h")]), [["block-h", "Gros"]], "several empty paragraphs then a heading");
  assert.deepEqual(title([blk("decision", { text: "Go", eng: { at: 1790680000 } }, "block-d"), blk("paragraph", { text: "Plus tard" }, "block-b")]), [], "a non-empty decision prevents the later paragraph from becoming the title");
  assert.deepEqual(title([blk("paragraph", { text: "" }, "block-a"), blk("paragraph", { text: "" }, "block-b")]), [["block-a", "Page sans titre"]], "a completely empty page keeps the first-paragraph affordance");
  assert.deepEqual(title([blk("check", { text: "tâche" }, "block-k"), blk("paragraph", { text: "x" }, "block-b")]), [], "a list item is never the title");
  assert.deepEqual(N.buildOutline(page([blk("paragraph", { text: "Titre" }, "block-a")]), { titleIndex: undefined }).items.length, 0, "without the injected rule there is no title node (never a second copy of the rule)");
});

group("outline signature: exactly what is displayed (typing in a paragraph = no change; label / order / delete = change)", () => {
  const sig = (lines) => N.buildOutline(lines, { drawingLabel: Rich.Struct.drawingLabel }).sig;
  const base = sig(sample());
  const edited = sample();
  edited[3].text = "texte modifié partout"; // an ordinary paragraph
  assert.equal(sig(edited), base, "paragraph typing does not change the outline");
  const h = sample();
  h[2].text = "Montage final"; // a heading label changes while type and id stay the same
  assert.notEqual(sig(h), base);
  const t = sample();
  t[4].struct.rows[0][0] = "Autre"; // the table's displayed first cell
  assert.notEqual(sig(t), base);
  const d = sample();
  d[7].struct.id = "Plan-B_HQWeb-Desktop";
  assert.notEqual(sig(d), base);
  const cap = sample();
  cap[5].asset.caption = "Vue de dos";
  assert.notEqual(sig(cap), base);
  const moved = sample();
  const [x] = moved.splice(2, 1);
  moved.splice(5, 0, x);
  assert.notEqual(sig(moved), base, "reorder");
  const removed = sample();
  removed.splice(4, 1);
  assert.notEqual(sig(removed), base, "delete");
  const dec = page([blk("paragraph", { text: "T" }, "block-a"), blk("decision", { text: "Go", decision: { at: 1790000000 } }, "block-dd")]);
  const dec2 = page([blk("paragraph", { text: "T" }, "block-a"), blk("decision", { text: "No go", decision: { at: 1790000000 } }, "block-dd")]);
  assert.notEqual(sig(dec), sig(dec2), "decision text is displayed so it is in the signature");
  assert.equal(N.buildOutline(dec).items[1].label, "Décision · Go");
  // an unsaved block (no real id yet) is still listed, navigable by index only
  const fresh = sample();
  fresh[2].id = null;
  const fo = N.buildOutline(fresh);
  assert.equal(fo.items[1].id, "");
  assert.equal(fo.items[1].index, 2);
  // long labels are bounded
  const long = N.buildOutline(page([blk("paragraph", { text: "T" }, "block-a"), blk("heading", { text: "x".repeat(300) }, "block-b")]));
  assert.ok(long.items[1].label.length <= N.LABEL_MAX);
});

const base = { hasEntry: true, trashed: false, conflict: false, error: false, storageFailed: false, dirty: false, inflight: false, offline: false, savedOnce: true, notice: "" };
const st = (o) => N.deriveSave(Object.assign({}, base, o));

group("save pill: truthful mapping with explicit precedence (conflict > failed > local > offline > saving > saved)", () => {
  assert.equal(st({}).state, "saved");
  assert.equal(st({}).label, "Enregistré");
  assert.equal(st({ dirty: true }).state, "saving");
  assert.equal(st({ inflight: true }).state, "saving");
  assert.equal(st({ offline: true }).state, "offline");
  assert.equal(st({ offline: true }).label, "Hors ligne");
  assert.equal(st({ dirty: true, offline: true }).state, "local");
  assert.equal(st({ dirty: true, offline: true }).label, "Brouillon local");
  assert.equal(st({ inflight: true, offline: true }).state, "local");
  assert.equal(st({ trashed: true, dirty: true }).state, "local", "a trashed page's kept draft is a local draft");
  assert.equal(st({ conflict: true }).label, "Conflit");
  assert.equal(st({ error: "x" }).label, "Échec");
  assert.equal(st({ storageFailed: true }).label, "Échec");
  // simultaneous conditions
  assert.equal(st({ conflict: true, inflight: true }).state, "conflict", "an in-flight save never hides a conflict");
  assert.equal(st({ conflict: true, dirty: true, offline: true }).state, "conflict");
  assert.equal(st({ error: "x", inflight: true }).state, "failed");
  assert.equal(st({ conflict: true, error: "x" }).state, "conflict");
  assert.equal(st({ error: "x", dirty: true, offline: true }).state, "failed");
  // never "Enregistré" while anything is pending / wrong
  for (const f of ["dirty", "inflight", "conflict", "error", "storageFailed", "offline"]) {
    assert.notEqual(st({ [f]: f === "error" ? "boom" : true }).state, "saved", f + " must not read as saved");
  }
  // exhaustive: saved only for a fully clean, online, confirmed entry
  for (let m = 0; m < 128; m += 1) {
    const s = { trashed: !!(m & 1), conflict: !!(m & 2), error: !!(m & 4), storageFailed: !!(m & 8), dirty: !!(m & 16), inflight: !!(m & 32), offline: !!(m & 64), savedOnce: true };
    const r = st(s);
    const clean = !s.conflict && !s.error && !s.storageFailed && !s.dirty && !s.inflight && !s.offline;
    assert.equal(r.state === "saved", clean, JSON.stringify(s) + " -> " + r.state);
  }
  assert.equal(st({ savedOnce: false }).state, "idle", "nothing saved yet in this session: no claim");
  assert.equal(N.deriveSave({ hasEntry: false }).state, "idle");
  assert.equal(N.deriveSave(null).state, "idle");
  // a benign notice is information, never a state
  const n = st({ notice: "Hors ligne — nouvelle page impossible" });
  assert.equal(n.state, "saved");
  assert.ok(n.detail.includes("nouvelle page impossible") && n.notice);
  // explanations distinguish a LOCAL draft from a server-saved state
  assert.ok(/sur cet appareil/.test(st({ dirty: true, offline: true }).detail) && /pas encore sur le serveur/.test(st({ dirty: true, offline: true }).detail));
  assert.ok(/enregistrées sur le serveur/.test(st({}).detail));
  assert.deepEqual(["conflict", "failed", "local", "offline", "saving", "saved", "idle"].map(N.announceNow), [true, true, true, true, false, false, false]);
});

group("inspector: only validated identities become URLs; the compare mode needs layout 'compare' + two assets", () => {
  const asset = "asset-" + "a".repeat(24);
  assert.equal(N.inspectSource("drawing", "Plan-A_HQWeb-Desktop"), "/api/drawings/file?stem=Plan-A_HQWeb-Desktop&kind=png");
  assert.equal(N.inspectSource("image", asset), "/api/carnet/asset/" + asset);
  for (const [k, id] of [["drawing", "../x"], ["drawing", "a b"], ["drawing", ""], ["drawing", "-x"], ["drawing", "http://evil/x.png"], ["image", "asset-xyz"], ["image", "http://evil/x"], ["image", asset + "/../x"], ["url", asset], ["drawing", 5], ["image", null]]) {
    assert.equal(N.inspectSource(k, id), null, k + " " + id);
  }
  assert.equal(N.inspectSpec({ kind: "drawing", stem: "../x" }), null);
  assert.equal(N.inspectSpec({ kind: "drawing", stem: "Plan_HQWeb" }).src, "/api/drawings/file?stem=Plan_HQWeb&kind=png");
  assert.equal(N.inspectSpec(null), null);
  assert.equal(N.inspectSpec({ kind: "evil" }), null);
  const ids = ["asset-" + "b".repeat(24), "asset-" + "c".repeat(24)];
  const cmp = N.inspectSpec({ kind: "imagegroup", layout: "compare", assetIds: ids });
  assert.deepEqual(cmp.compare, { before: "/api/carnet/asset/" + ids[0], after: "/api/carnet/asset/" + ids[1] });
  assert.equal(N.inspectSpec({ kind: "imagegroup", layout: "two", assetIds: ids }).compare, null);
  assert.equal(N.inspectSpec({ kind: "imagegroup", layout: "compare", assetIds: [ids[0]] }).compare, null);
  assert.equal(N.inspectSpec({ kind: "imagegroup", layout: "compare", assetIds: [ids[0], "x"] }), null, "one bad child rejects the whole spec");
  assert.equal(N.inspectSpec({ kind: "imagegroup", layout: "three", assetIds: [ids[0], ids[1], asset], index: 2 }).assetId, asset);
});

group("inspector view: fit = zoom 1, bounded zoom, pan can never leave the image, reset", () => {
  const vw = 800, vh = 600, dw = 800, dh = 450; // a 16:9 image contained in 800x600
  let v = N.viewInit();
  assert.deepEqual(v, { z: 1, x: 0, y: 0 });
  assert.deepEqual(N.viewPan(v, 100, 100, vw, vh, dw, dh), { z: 1, x: 0, y: 0 }, "no pan at fit");
  v = N.viewZoomAt(v, 2, 0, 0, vw, vh, dw, dh);
  assert.equal(v.z, 2);
  v = N.viewPan(v, 5000, 5000, vw, vh, dw, dh);
  const lim = N.panLimits(2, vw, vh, dw, dh);
  assert.deepEqual([v.x, v.y], [lim.x, lim.y]);
  assert.deepEqual([lim.x, lim.y], [400, 150]);
  v = N.viewPan(v, -99999, -99999, vw, vh, dw, dh);
  assert.deepEqual([v.x, v.y], [-400, -150]);
  v = N.viewZoomAt(v, 100, 0, 0, vw, vh, dw, dh);
  assert.equal(v.z, N.ZOOM_MAX);
  v = N.viewZoomAt(v, 0.0001, 0, 0, vw, vh, dw, dh);
  assert.equal(v.z, N.ZOOM_MIN);
  assert.deepEqual([v.x, v.y], [0, 0], "zooming back out to fit recentres");
  // zoom about a point keeps that point under the pointer (when no clamp interferes)
  const z = N.viewZoomAt({ z: 2, x: 0, y: 0 }, 1.5, 100, 50, vw, vh, dw, dh);
  assert.ok(Math.abs(z.x - (100 - (100 - 0) * 1.5)) < 1e-9 && Math.abs(z.y - (50 - 50 * 1.5)) < 1e-9);
  // garbage never propagates
  assert.deepEqual(N.viewClamp({ z: NaN, x: NaN, y: Infinity }, vw, vh, dw, dh), { z: 1, x: 0, y: 0 });
  assert.equal(N.viewClamp({ z: -3, x: 0, y: 0 }, vw, vh, dw, dh).z, 1);
  // a tall image overflowing only vertically pans only vertically
  const t = N.viewPan({ z: 1.5, x: 0, y: 0 }, 999, 999, 800, 600, 300, 900);
  assert.equal(t.x, 0);
  assert.equal(t.y, N.panLimits(1.5, 800, 600, 300, 900).y);
});

group("compare slider: clamped, keyboard operable, no persistence", () => {
  assert.equal(N.compareClamp(NaN), 50);
  assert.equal(N.compareClamp(-10), 0);
  assert.equal(N.compareClamp(130), 100);
  assert.equal(N.compareClamp(33.4), 33);
  assert.equal(N.compareKey(50, "ArrowRight"), 55);
  assert.equal(N.compareKey(50, "ArrowLeft"), 45);
  assert.equal(N.compareKey(2, "ArrowLeft"), 0);
  assert.equal(N.compareKey(98, "ArrowUp"), 100);
  assert.equal(N.compareKey(50, "Home"), 0);
  assert.equal(N.compareKey(50, "End"), 100);
  assert.equal(N.compareKey(50, "PageUp"), 70);
  assert.equal(N.compareKey(50, "PageDown"), 30);
  assert.equal(N.compareKey(50, "a"), null);
});

group("suggestions: deterministic and additive (heading -> 4, image -> annotate only for a valid asset)", () => {
  assert.deepEqual(N.suggestFor({ type: "heading" }).map((s) => s.id), ["paragraph", "check", "table", "image"]);
  assert.ok(N.suggestFor({ type: "heading" }).every((s) => s.action === "command"));
  const a = "asset-" + "a".repeat(24);
  assert.deepEqual(N.suggestFor({ type: "image", assetId: a }).map((s) => [s.id, s.action]), [["annotate", "annotate"], ["imagegroup", "command"]]);
  assert.deepEqual(N.suggestFor({ type: "image", assetId: "nope" }).map((s) => s.id), ["imagegroup"], "no Annoter without a canonical asset");
  assert.deepEqual(N.suggestFor({ type: "image" }).map((s) => s.id), ["imagegroup"]);
  for (const t of ["paragraph", "bullet", "table", "drawing", "check", "number", "decision", "imagegroup", "measure", "calc", undefined]) assert.deepEqual(N.suggestFor({ type: t }), [], String(t));
  assert.deepEqual(N.suggestFor(null), []);
  assert.deepEqual(N.suggestFor(undefined), []);
  assert.deepEqual(N.suggestFor({ type: "heading" }), N.suggestFor({ type: "heading", text: "anything else" }), "pure: same input kind, same output");
  // the commands catalog is untouched by suggestions (categories, recents, count)
  const C = require("../assets/hq-carnet-commands.js");
  const before = JSON.stringify(C.catalog({ recents: ["table"] }));
  N.suggestFor({ type: "heading" });
  assert.equal(JSON.stringify(C.catalog({ recents: ["table"] })), before);
  for (const s of N.suggestFor({ type: "heading" }).concat(N.suggestFor({ type: "image", assetId: a }))) if (s.action === "command") assert.ok(C.byId(s.id), "suggestion " + s.id + " is a real catalog command");
});

group("portal cards: renderer over an existing ref; unavailable keeps the reference; no absolute path, no copied state", () => {
  const f = N.portalModel({ kind: "file", id: "Inbox/sub/plan.pdf" }, "unknown");
  assert.deepEqual([f.title, f.subtitle, f.chip, f.unavailable, f.openAria], ["plan.pdf", "Inbox/sub", "PDF", false, "Ouvrir le fichier plan.pdf"]);
  assert.equal(N.portalModel({ kind: "file", id: "Inbox/x.unknownext" }, "ok").chip, "UNKN");
  assert.equal(N.portalModel({ kind: "file", id: "Inbox/noext" }, "ok").chip, "FICHIER");
  assert.equal(N.portalModel({ kind: "model", id: "Inbox/piece.stl" }).chip, "3D");
  assert.equal(N.portalModel({ kind: "media", id: "Inbox/clip.mp4" }).chip, "MÉDIA");
  const d = N.portalModel({ kind: "drawing", id: "Plan-A_HQWeb-Desktop" }, "unknown", { drawingLabel: Rich.Struct.drawingLabel });
  assert.deepEqual([d.title, d.chip, d.preview, d.openLabel, d.unavailable], ["Plan-A", "CROQUIS", "/api/drawings/file?stem=Plan-A_HQWeb-Desktop&kind=png", "Ouvrir dans Dessiner", false]);
  const gone = N.portalModel({ kind: "drawing", id: "Plan-A_HQWeb-Desktop" }, "missing", { drawingLabel: Rich.Struct.drawingLabel });
  assert.deepEqual([gone.unavailable, gone.preview, gone.message, gone.title], [true, null, "Croquis indisponible", "Plan-A"], "missing: explicit state, same reference still rendered");
  assert.equal(N.portalModel({ kind: "file", id: "Inbox/a.pdf" }, "missing").message, "Fichier indisponible");
  // unsafe / unsupported refs get no card at all
  for (const r of [{ kind: "file", id: "/etc/passwd" }, { kind: "file", id: "C:\\Users\\x" }, { kind: "file", id: "C:/x" }, { kind: "file", id: "Inbox/../x" }, { kind: "file", id: "Inbox\\x" }, { kind: "drawing", id: "../x" },
    { kind: "task", id: "t-1" }, { kind: "event", id: "e-1" }, { kind: "note", id: P }, { kind: "file" }, null, "x", { kind: "file", id: 4 }]) {
    assert.equal(N.portalModel(r, "ok"), null, JSON.stringify(r));
  }
  // the model never holds anything but strings derived from the ref itself
  for (const v of Object.values(f)) assert.ok(typeof v === "string" || typeof v === "boolean" || v === null);
});

console.log("hq carnet polish checks ok (" + groups + " groups)");
