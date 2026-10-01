// Carnet Stage 06 — note images: model, draft/save state machine, stale-tool rules, browser pipeline logic
// (no browser, no server, no live data). Shared render vectors with Python: tests/fixtures_carnet_media.json.
// The real browser (canvas decode/encode, DOM atoms, print, layout) is covered by tests/visual_carnet_media_playwright.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");
const R = require("../assets/hq-carnet-rich.js");
const M = require("../assets/hq-carnet-media.js");
const vectors = JSON.parse(readFileSync(new URL("./fixtures_carnet_media.json", import.meta.url), "utf8"));

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) {
  for (let i = 0; i < n; i += 1) await tick();
}
let groups = 0;
const ok = () => { groups += 1; };

const ASSET = (ch, extra) => Object.assign({ id: "asset-" + ch.repeat(24), mime: "image/png", w: 640, h: 480, width: 60, layout: "inline", caption: "" }, extra || {});
const P = (t, type) => R.newLine(t, type || "paragraph", false, []);
const I = (asset) => R.imageLine(asset);

// ---------------------------------------------------------------- schema
{
  assert.ok(R.checkAsset(ASSET("a")));
  const bad = [
    ASSET("a", { width: 29 }), ASSET("a", { width: 101 }), ASSET("a", { width: 50.5 }), ASSET("a", { width: "60" }), ASSET("a", { layout: "free" }),
    ASSET("a", { layout: "left" }), ASSET("a", { layout: "CENTER" }), ASSET("a", { layout: true }), ASSET("a", { layout: 1 }), ASSET("a", { layout: null }),
    ASSET("a", { caption: "x".repeat(301) }), ASSET("a", { caption: "a\nb" }), ASSET("a", { caption: 5 }), ASSET("a", { w: 0 }), ASSET("a", { w: 2561 }),
    ASSET("a", { id: "asset-../x" }), ASSET("a", { id: "asset-" + "A".repeat(24) }), ASSET("a", { mime: "image/gif" }), ASSET("a", { mime: "image/heic" }),
    Object.assign(ASSET("a"), { path: "/etc/passwd" }), null, [], "asset",
  ];
  for (const b of bad) assert.equal(R.checkAsset(b), null, JSON.stringify(b));
  const noCaption = ASSET("a");
  delete noCaption.caption;
  assert.equal(R.checkAsset(noCaption), null, "every field is required");
  for (const w of [30, 100]) assert.ok(R.checkAsset(ASSET("a", { width: w })), "boundary " + w);
  for (const lay of ["inline", "center", "right"]) assert.equal(R.checkAsset(ASSET("a", { layout: lay })).layout, lay);
  // fmt: an inline image row keeps the Stage-06 6-element encoding; center/right add a 7th; round-trips exactly.
  {
    const enc = (lay) => R.fmtOf([R.imageLine(ASSET("a", { layout: lay }))]);
    const row = (lay) => JSON.parse(enc(lay))[0][3];
    assert.equal(row("inline").length, 6);
    assert.equal(row("center").length, 7);
    assert.equal(row("right")[6], "right");
    for (const lay of ["inline", "center", "right"]) {
      const back = R.linesFromTextFmt("", enc(lay), [null]);
      assert.ok(back && back[0].asset.layout === lay, "fmt round trip " + lay);
      assert.equal(R.fmtOf(back), enc(lay));
    }
    const fake = JSON.parse(enc("center"));
    fake[0][3][6] = "inline"; // the default is never written as a 7th element
    assert.equal(R.linesFromTextFmt("", JSON.stringify(fake), [null]), null);
    fake[0][3][6] = "left";
    assert.equal(R.linesFromTextFmt("", JSON.stringify(fake), [null]), null);
  }
  assert.equal(R.checkAsset(ASSET("a", { caption: "x".repeat(300) })).caption.length, 300);
  ok();
}

// ---------------------------------------------------------------- caption parity with Python (shared differential vectors)
{
  for (const c of vectors.captions) {
    const asset = ASSET("a", { caption: c.caption });
    assert.equal(R.checkAsset(asset) !== null, c.ok, "caption vector: " + c.name);
    assert.equal(R.captionOk(c.caption), c.ok, "captionOk: " + c.name);
    if (c.ok) assert.equal(R.checkAsset(asset).caption, c.caption, "stored as-is: " + c.name);
  }
  // the UI cleaner always yields something captionOk accepts, and never splits a surrogate pair
  for (const raw of ["a\tb\nc", "x".repeat(500), "\u{1F600}".repeat(200), "a\ud83db", "\ude00", "a\u0085b", "a\u2028b\u2029c", null, "ok"]) {
    const cleaned = R.cleanCaptionText(raw);
    assert.ok(R.captionOk(cleaned), "cleaned caption is valid: " + JSON.stringify(raw).slice(0, 30));
  }
  assert.equal(R.cleanCaptionText("\u{1F600}".repeat(200)).length, 300);
  ok();
}

// ---------------------------------------------------------------- lines / fmt / content round trips
{
  const lines = [P("intro"), I(ASSET("a", { caption: "Vue de face", width: 45 })), P("fin")];
  const text = R.flat(lines);
  assert.equal(text, "intro\n\nfin", "an image occupies no text");
  const fmt = R.fmtOf(lines);
  assert.ok(fmt.includes("asset-" + "a".repeat(24)));
  const back = R.linesFromTextFmt(text, fmt);
  assert.deepEqual(back.map((l) => l.type), ["paragraph", "image", "paragraph"]);
  assert.deepEqual(back[1].asset, ASSET("a", { caption: "Vue de face", width: 45 }));
  assert.equal(R.fmtOf(back), fmt, "fmt is stable");
  // fmt rows of non-image lines are byte-identical to the pre-Stage-06 encoding (3 elements)
  const plain = [P("x", "heading"), P("y")];
  assert.equal(R.fmtOf(plain), '[["h",0,[]],["p",0,[]]]');
  // malformed image rows are refused, never guessed
  const row = JSON.parse(fmt);
  const mut = (f) => { const r = clone(row); f(r); return JSON.stringify(r); };
  for (const bad of [
    mut((r) => { r[1].pop(); }), mut((r) => { r[1][3][4] = 10; }), mut((r) => { r[1][3][0] = "asset-x"; }), mut((r) => { r[0].push(["a"]); }),
    mut((r) => { r[1][2] = [["bold", 0, 1]]; }), mut((r) => { r[1][0] = "p"; }), mut((r) => { delete r[1][3]; }),
  ]) assert.equal(R.linesFromTextFmt(text, bad), null, bad.slice(0, 80));
  assert.equal(R.linesFromTextFmt("intro\nx\nfin", fmt), null, "an image row needs an empty text line");
  // server content round trip
  const content = R.contentFromLines(back);
  assert.equal(content.blocks[1].type, "image");
  assert.deepEqual(content.blocks[1].asset, back[1].asset);
  assert.equal(content.blocks[1].text, "");
  assert.deepEqual(content.blocks[1].marks, []);
  assert.equal(content.blocks[0].asset, undefined, "text blocks never carry an asset key");
  assert.equal("checked" in content.blocks[1], false);
  const again = R.linesFromContent(content);
  assert.equal(R.fmtOf(again), fmt);
  for (const bad of [
    (c) => { c.blocks[1].text = "x"; }, (c) => { c.blocks[1].marks = [{ type: "bold", start: 0, end: 1 }]; }, (c) => { delete c.blocks[1].asset; },
    (c) => { c.blocks[0].asset = clone(c.blocks[1].asset); }, (c) => { c.blocks[1].checked = false; }, (c) => { c.blocks[1].asset.width = 10; },
  ]) { const c = clone(content); bad(c); assert.equal(R.linesFromContent(c), null); }
  // more than 32 images per page is refused on read of a draft
  const many = Array.from({ length: 33 }, () => I(ASSET("a")));
  assert.equal(R.linesFromTextFmt(R.flat(many), R.fmtOf(many)), null);
  assert.ok(R.linesFromTextFmt(R.flat(many.slice(0, 32)), R.fmtOf(many.slice(0, 32))));
  ok();
}

// ---------------------------------------------------------------- editing primitives around an image atom
{
  const base = () => [P("one"), I(ASSET("a", { caption: "c" })), P("two")];
  const idOf = (lines) => lines.map((l) => l.type + ":" + l.text);
  // typing before/after never touches the image
  let r = R.replaceRange(base(), 1, 1, "X");
  assert.deepEqual(idOf(r.lines), ["paragraph:oXne", "image:", "paragraph:two"]);
  const starts = R.lineStarts(base()); // [0, 4, 5]
  assert.deepEqual(starts, [0, 4, 5]);
  r = R.replaceRange(base(), 5, 5, "Y");
  assert.deepEqual(idOf(r.lines), ["paragraph:Ytwo", "image:", "paragraph:two"].slice(0, 0).concat(["paragraph:one", "image:", "paragraph:Ytwo"]));
  // insertion AT the image goes into a new paragraph above it; the image keeps its asset
  r = R.replaceRange(base(), 4, 4, "new");
  assert.deepEqual(idOf(r.lines), ["paragraph:one", "paragraph:new", "image:", "paragraph:two"]);
  assert.equal(r.lines[2].asset.caption, "c");
  // a range ending exactly at the image start keeps the image
  r = R.replaceRange(base(), 1, 4, "");
  assert.deepEqual(idOf(r.lines), ["paragraph:o", "image:", "paragraph:two"]);
  // a range covering the image (and its newline) removes it like any selected atom
  r = R.replaceRange(base(), 2, 6, "");
  assert.deepEqual(idOf(r.lines), ["paragraph:otwo"].slice(0, 0).concat(["paragraph:on" + "wo"]));
  assert.equal(r.lines.some((l) => l.type === "image"), false);
  // select-all delete leaves one empty paragraph
  r = R.replaceRange(base(), 0, R.flat(base()).length, "");
  assert.deepEqual(idOf(r.lines), ["paragraph:"]);
  // a range starting AT the image start (caret before the atom) deletes it
  r = R.replaceRange(base(), 4, 6, "");
  assert.equal(r.lines.some((l) => l.type === "image"), false);
  assert.deepEqual(idOf(r.lines), ["paragraph:one", "paragraph:wo"]);
  // two images: selection over the first keeps the second
  const two = () => [P("a"), I(ASSET("a")), I(ASSET("b")), P("z")];
  r = R.replaceRange(two(), 2, 3, "");
  assert.deepEqual(r.lines.filter((l) => l.type === "image").map((l) => l.asset.id), ["asset-" + "b".repeat(24)]);
  // never produces an image with text or marks
  for (let s = 0; s <= 8; s += 1) for (let e = s; e <= 8; e += 1) {
    for (const rep of ["", "q", "a\nb"]) {
      const out = R.replaceRange(two(), s, e, rep).lines;
      for (const l of out) {
        if (l.type === "image") { assert.equal(l.text, ""); assert.deepEqual(l.marks, []); assert.ok(R.checkAsset(l.asset)); } else assert.equal(l.asset, null);
      }
      assert.ok(R.linesFromTextFmt(R.flat(out), R.fmtOf(out)), "state stays representable");
    }
  }
  // block type / Enter / marks / find-replace never alter the image
  const lines = base();
  assert.deepEqual(R.setBlockType(lines, 0, R.flat(lines).length, "heading").map((l) => l.type), ["heading", "image", "heading"]);
  assert.equal(R.setBlockType(lines, 4, 4, "heading")[1].type, "image", "an image is never re-typed");
  assert.equal(R.setBlockType(lines, 4, 4, "image")[1].type, "image");
  const enter = R.splitAt(lines, 4, 4);
  assert.deepEqual(idOf(enter.lines), ["paragraph:one", "paragraph:", "image:", "paragraph:two"]);
  assert.equal(enter.caret, 4);
  const marked = R.toggleMark(lines, 0, R.flat(lines).length, "bold");
  assert.deepEqual(marked[1].marks, []);
  assert.equal(marked[1].asset.id, "asset-" + "a".repeat(24));
  const hits = R.findAll(lines, "c", {});
  assert.deepEqual(hits, [], "a caption is never searched: the atom has no text");
  assert.deepEqual(R.findAll(lines, "o", {}).length, 2);
  const replaced = R.replaceMatches(lines, R.findAll(lines, "o", {}), "0");
  assert.deepEqual(replaced[1], lines[1]);
  assert.equal(replaced[1].asset.caption, "c");
  const empty = R.replaceMatches(lines, R.findAll(lines, "o", {}), "");
  assert.equal(R.flat(empty), "ne\n\ntw");
  assert.equal(empty[1].type, "image");
  ok();
}

// ---------------------------------------------------------------- exports (Python parity vectors)
for (const c of vectors.render) {
  const lines = R.linesFromContent({ version: 2, blocks: c.blocks });
  assert.ok(lines, c.name);
  assert.equal(R.renderTxt(lines), c.txt, "txt: " + c.name);
  assert.equal(R.renderMarkdown(lines, Object.keys(c.paths).length ? c.paths : undefined), c.md, "md: " + c.name);
}
ok();

// ---------------------------------------------------------------- browser pipeline logic (no canvas needed)
{
  const png = (w, h) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); b.set([w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255], 16); b.set([h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255], 20); return b; };
  assert.deepEqual(M.sniffDims(png(4000, 3000)), { mime: "image/png", w: 4000, h: 3000 });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  assert.deepEqual(M.sniffDims(jpg), { mime: "image/jpeg", w: 4000, h: 3000 });
  const vp8l = new Uint8Array(30); vp8l.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f]);
  const bits = (1999 | (999 << 14)) >>> 0; vp8l.set([bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 21);
  assert.deepEqual(M.sniffDims(vp8l), { mime: "image/webp", w: 2000, h: 1000 });
  for (const junk of [new Uint8Array(40), new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0]), null, new Uint8Array(3), new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), new TextEncoder().encode("ftypheic" + "0".repeat(30))]) assert.equal(M.sniffDims(junk), null);
  assert.deepEqual(M.fitWithin(5000, 2500, 2560), { w: 2560, h: 1280, scaled: true });
  assert.deepEqual(M.fitWithin(2500, 5000, 2560), { w: 1280, h: 2560, scaled: true });
  assert.deepEqual(M.fitWithin(2560, 1000, 2560), { w: 2560, h: 1000, scaled: false }, "at the bound: untouched");
  assert.deepEqual(M.fitWithin(100, 50, 2560), { w: 100, h: 50, scaled: false }, "never upscales");
  const ratio = (w, h) => w / h;
  for (const [w, h] of [[4032, 3024], [3024, 4032], [8000, 1], [1, 8000], [2561, 2561]]) {
    const f = M.fitWithin(w, h, 2560);
    assert.ok(Math.max(f.w, f.h) <= 2560 && f.w >= 1 && f.h >= 1);
    if (Math.min(w, h) > 50) assert.ok(Math.abs(ratio(f.w, f.h) - ratio(w, h)) / ratio(w, h) < 0.01, "aspect ratio preserved");
  }
  const file = (bytes, size) => ({ size: size == null ? bytes.length : size, type: "image/png", slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  const rejects = async (f, code, o) => { await assert.rejects(() => M.prepare(f, o), (e) => e instanceof M.MediaError && e.code === code, code); };
  await rejects(file(png(10, 10), 0), "empty");
  await rejects(file(png(10, 10), 16 * 1048576 + 1), "source_too_large");
  await rejects(file(new Uint8Array(64)), "unsupported_type");
  await rejects(file(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0])), "unsupported_type");
  await rejects(file(png(9000, 9000)), "source_pixels");
  await rejects({ size: 5 }, "bad_file");
  // a fake engine: decode -> canvas -> encode. Checks plan, dimensions, fallbacks, cleanup.
  const engine = (opts) => {
    const log = { closed: 0, canvases: [], encodes: [] };
    const env = {
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => { log.closed += 1; } },
      Image: class { constructor() { this.naturalWidth = opts.w; this.naturalHeight = opts.h; } set src(v) { void v; setTimeout(() => this.onload && this.onload(), 0); } decode() { return Promise.resolve(); } },
      document: {
        createElement: () => {
          const cv = {
            width: 0, height: 0,
            getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) { void v; } }),
            toBlob(cb, type, q) { log.encodes.push([type, q, cv.width, cv.height]); const size = opts.size ? opts.size(type, q) : 1000; cb(opts.unsupported && opts.unsupported.includes(type) ? { type: "image/png", size } : { type, size }); },
          };
          log.canvases.push(cv);
          return cv;
        },
      },
    };
    return { env, log };
  };
  {
    const { env, log } = engine({ w: 4032, h: 3024 });
    const out = await M.prepare(file(png(4032, 3024)), { env });
    assert.deepEqual([out.w, out.h, out.scaled, out.mime], [2560, 1920, true, "image/png"]);
    assert.equal(log.encodes[0][0], "image/png", "a PNG source stays PNG");
    assert.equal(log.closed, 1, "object URL released");
    assert.ok(log.canvases.every((c) => c.width === 0 && c.height === 0), "canvas backing store released");
  }
  {
    // JPEG source with EXIF orientation: the decoder reports oriented dimensions (here 3024x4032); the output uses them
    const { env } = engine({ w: 3024, h: 4032 });
    const out = await M.prepare(file(jpg), { env });
    assert.deepEqual([out.w, out.h], [1920, 2560]);
    assert.equal(out.mime, "image/jpeg");
  }
  {
    // too heavy as PNG -> falls back to JPEG quality steps; never returns an oversize blob
    const { env, log } = engine({ w: 2000, h: 2000, size: (type, q) => (type === "image/png" ? 13 * 1048576 : q >= 0.9 ? 12.5 * 1048576 : 4 * 1048576) });
    const out = await M.prepare(file(png(2000, 2000)), { env });
    assert.equal(out.mime, "image/jpeg");
    assert.ok(out.blob.size <= 12 * 1048576);
    assert.ok(log.encodes.length >= 3);
    const { env: env2 } = engine({ w: 2000, h: 2000, size: () => 20 * 1048576 });
    await rejects(file(png(2000, 2000)), "too_heavy", { env: env2 });
  }
  {
    // engines that cannot encode WebP answer with another type: accepted only if it is allowed and small
    const { env } = engine({ w: 100, h: 100, unsupported: ["image/webp"] });
    const out = await M.prepare(file(vp8l), { env });
    assert.equal(out.mime, "image/png", "a WebP source on an engine without WebP encoding ends as an allowed type");
  }
  assert.equal(M.describeError({ data: { error: "Quota des images atteint" } }), "Quota des images atteint");
  assert.equal(M.describeError(new M.MediaError("x", "Image trop lourde")), "Image trop lourde");
  assert.equal(M.describeError(new Error("Hors ligne")), "Hors ligne");
  assert.equal(M.describeError({}), "Téléversement impossible");
  // upload: raw body, octet-stream, declared mime hint, no file name anywhere
  const seen = [];
  const res = await M.upload({ type: "image/jpeg", size: 3 }, async (url, init) => { seen.push([url, init]); return { ok: true, asset: { id: "asset-" + "c".repeat(24), mime: "image/jpeg", w: 10, h: 20, bytes: 3 } }; });
  assert.deepEqual([seen[0][0], seen[0][1].method, seen[0][1].headers["Content-Type"], seen[0][1].headers["X-Carnet-Mime"]], ["/api/carnet/asset", "POST", "application/octet-stream", "image/jpeg"]);
  assert.equal(JSON.stringify(seen[0][1]).includes("filename"), false);
  assert.equal(res.id, "asset-" + "c".repeat(24));
  await assert.rejects(() => M.upload({ type: "image/png" }, async () => ({ ok: true, asset: { id: "x" } })), (e) => e.code === "bad_response");
  ok();
}

// ---------------------------------------------------------------- state machine with image blocks
function v2Page(id, rev, blocks) {
  return { id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1, updated_at: 1,
    content: { version: 2, blocks: blocks.map((b, i) => Object.assign({ id: "block-" + id.slice(5) + i, marks: [] }, b)) } };
}
const imgBlock = (asset) => ({ type: "image", text: "", asset });
function fixture() {
  return { version: 1, notebook_rev: 4, projects: [], categories: [], pages: [
    v2Page("page-img", 3, [{ type: "paragraph", text: "intro" }, imgBlock(ASSET("a", { caption: "Vue" })), { type: "paragraph", text: "fin" }]),
    v2Page("page-txt", 1, [{ type: "paragraph", text: "texte" }]),
  ] };
}
function fakeServer() {
  const s = { nb: fixture(), hold: false, held: [], calls: [], seq: 0, known: new Set(["a", "b", "c"].map((c) => "asset-" + c.repeat(24))) };
  const err = (status, data) => Object.assign(new Error(data.error), { status, data });
  const find = (id) => s.nb.pages.find((x) => x.id === id);
  function handle(p) {
    if (p.action !== "page_save") throw err(400, { error: "action invalide", code: "validation_error" });
    const pg = find(p.id);
    if (p.expected_rev !== pg.rev) throw err(409, { error: "Page modifiée ailleurs", code: "revision_conflict", page: clone(pg), notebook_rev: s.nb.notebook_rev });
    const incoming = R.linesFromContent(p.content);
    if (!incoming) throw err(400, { error: "Contenu invalide", code: "validation_error" });
    for (const l of incoming) if (l.type === "image" && !s.known.has(l.asset.id)) throw err(400, { error: "Image inconnue du carnet", code: "validation_error" });
    const cur = R.linesFromContent(pg.content);
    const owned = new Set(R.idsOf(cur).filter(Boolean));
    for (const l of incoming) if (l.id && !owned.has(l.id)) throw err(400, { error: "Bloc étranger à cette page", code: "validation_error" });
    if (R.flat(incoming) !== R.flat(cur) || R.fmtOf(incoming) !== R.fmtOf(cur)) {
      pg.content = { version: 2, blocks: incoming.map((l) => Object.assign({ id: l.id || "block-srv" + (++s.seq), type: l.type, text: l.text, marks: clone(l.marks) }, l.type === "check" ? { checked: l.checked } : {}, l.type === "image" ? { asset: clone(l.asset) } : {})) };
      pg.rev += 1;
    }
    return { ok: true, notebook_rev: s.nb.notebook_rev, page: clone(pg) };
  }
  s.request = (payload) => {
    s.calls.push(clone(payload));
    if (s.hold) return new Promise((resolve, reject) => s.held.push(() => { try { resolve(handle(payload)); } catch (e) { reject(e); } }));
    try { return Promise.resolve(handle(payload)); } catch (e) { return Promise.reject(e); }
  };
  s.release = () => s.held.splice(0).forEach((f) => f());
  s.fetchNotebook = (meta) => { const out = clone(s.nb); if (meta) out.pages = out.pages.map((p) => ({ id: p.id, rev: p.rev, deleted_at: p.deleted_at })); return Promise.resolve(out); };
  s.pg = find;
  s.saves = () => s.calls;
  s.remote = (p) => handle(p);
  return s;
}
function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function fakeTimers() {
  const t = { list: new Map(), seq: 0 };
  t.set = (fn, ms) => { t.seq += 1; t.list.set(t.seq, { fn, ms }); return t.seq; };
  t.clear = (h) => { t.list.delete(h); };
  t.runAll = () => { const fns = [...t.list.values()]; t.list.clear(); fns.forEach((x) => x.fn()); };
  return t;
}
function make(server, storage) {
  const timers = fakeTimers();
  const drafts = C.createDraftStore(storage, "admin-test");
  const events = [];
  const core = C.createCore({ request: server.request, fetchNotebook: server.fetchNotebook, drafts, timers, now: () => 1000, onChange: (e) => events.push(e) });
  return { core, drafts, timers, events };
}
const draftsOf = (st) => { const raw = st.m.get(C.draftKey("admin-test")); return raw ? JSON.parse(raw).pages : {}; };
const linesOf = (e) => R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
const setLines = (core, id, lines) => { R.ensureKeys(lines); return core.edit(id, { text: R.flat(lines), fmt: R.fmtOf(lines), ids: R.idsOf(lines) }); };

// A. load, insert an image between blocks: draft first, autosave sends a NEW image block (no id), server id adopted
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-txt");
  assert.equal(linesOf(core.entry("page-img"))[1].asset.caption, "Vue", "server image block loads");
  const lines = linesOf(e);
  lines.splice(1, 0, I(ASSET("b", { width: 100 })), P(""));
  assert.equal(setLines(core, "page-txt", lines), true);
  const rec = draftsOf(st)["page-txt"];
  assert.equal(rec.content.blocks[1].type, "image", "draft written synchronously, before any network work");
  assert.equal(rec.content.blocks[1].id, undefined, "a new image block has no id yet (never a temporary key on the wire)");
  assert.deepEqual(rec.content.blocks[1].asset, ASSET("b", { width: 100 }));
  assert.equal(JSON.stringify(rec).includes("base64"), false);
  timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 1);
  const sent = srv.saves()[0].content.blocks;
  assert.deepEqual(sent.map((b) => b.type), ["paragraph", "image", "paragraph"]);
  assert.equal(sent[1].asset.id, "asset-" + "b".repeat(24));
  const saved = R.linesFromContent(srv.pg("page-txt").content);
  assert.ok(R.isRealId(saved[1].id), "server assigned the block id");
  assert.ok(R.isRealId(linesOf(e)[1].id), "client adopted it");
  assert.equal(core.isDirty(e), false);
  assert.equal(draftsOf(st)["page-txt"], undefined, "draft cleared only after the matching save");
  ok();
}

// B. caption / width edits: same block id, autosave, old response + newer edit race
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-img");
  const before = linesOf(e)[1].id;
  const edit = (f) => { const l = linesOf(e); f(l[1].asset); return setLines(core, "page-img", l); };
  edit((a) => { a.caption = "v1"; });
  srv.hold = true;
  timers.runAll();
  await settle();
  edit((a) => { a.caption = "v2"; a.width = 30; }); // newer edit while save #1 is in flight
  timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 1, "one in-flight save per page");
  srv.hold = false;
  srv.release();
  await settle(14);
  assert.equal(linesOf(e)[1].asset.caption, "v2", "newer state survives the old response");
  assert.equal(srv.saves().length, 2);
  assert.equal(srv.saves()[1].expected_rev, 4, "the follow-up save is against the returned revision");
  assert.equal(R.linesFromContent(srv.pg("page-img").content)[1].asset.width, 30);
  assert.equal(R.linesFromContent(srv.pg("page-img").content)[1].id, before, "block identity kept through caption/width edits");
  assert.equal(core.isDirty(e), false);
  ok();
}

// C. another client edits the image block (caption/width/replace/delete) -> explicit conflict, nothing silent, nothing lost
for (const remoteEdit of ["caption", "replace", "delete", "width"]) {
  const srv = fakeServer();
  const { core, timers } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-img");
  const l = linesOf(e);
  l[1].asset.caption = "mine";
  setLines(core, "page-img", l);
  const remote = R.linesFromContent(srv.pg("page-img").content);
  if (remoteEdit === "caption") remote[1].asset.caption = "theirs";
  else if (remoteEdit === "width") remote[1].asset.width = 35;
  else if (remoteEdit === "replace") remote[1] = I(ASSET("c", { caption: "Vue" }));
  else remote.splice(1, 1);
  srv.remote({ action: "page_save", id: "page-img", expected_rev: 3, content: R.wireContent(remote.map((x, i) => Object.assign(x, { id: R.isRealId(x.id) ? x.id : null })), new Set(R.idsOf(R.linesFromContent(srv.pg("page-img").content))), null) });
  timers.runAll();
  await settle();
  assert.ok(e.conflict, remoteEdit + ": explicit conflict");
  assert.equal(srv.saves().length, 1, remoteEdit + ": autosave paused, never retried against the new revision");
  assert.equal(linesOf(e)[1].asset.caption, "mine", remoteEdit + ": local image state kept");
  assert.equal(linesOf(e)[1].asset.id, "asset-" + "a".repeat(24));
  core.loadRemote("page-img");
  await settle();
  assert.equal(core.isDirty(e), false);
  const now = linesOf(e);
  if (remoteEdit === "delete") assert.equal(now.some((x) => x.type === "image"), false);
  else if (remoteEdit === "replace") assert.equal(now[1].asset.id, "asset-" + "c".repeat(24));
  else assert.equal(now[1].type, "image");
}
ok();

// C2. "replace with mine" after a remote delete writes the local image back (a new block: the old id no longer exists)
{
  const srv = fakeServer();
  const { core, timers } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-img");
  const l = linesOf(e);
  l[1].asset.caption = "mine";
  setLines(core, "page-img", l);
  srv.remote({ action: "page_save", id: "page-img", expected_rev: 3, content: { version: 2, blocks: [{ type: "paragraph", text: "intro", marks: [] }, { type: "paragraph", text: "fin", marks: [] }].map((b, i) => Object.assign(b, { id: i ? "block-img2" : "block-img0" })) } });
  timers.runAll();
  await settle();
  assert.ok(e.conflict);
  await core.keepLocal("page-img");
  await settle();
  const out = R.linesFromContent(srv.pg("page-img").content);
  assert.deepEqual(out.map((x) => x.type), ["paragraph", "image", "paragraph"]);
  assert.equal(out[1].asset.caption, "mine");
  assert.notEqual(out[1].id, "block-img1", "the deleted block's id is never resurrected");
  ok();
}

// D. draft recovery after reload keeps the image; a reload never drops it
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  const l = linesOf(A.core.entry("page-img"));
  l[1].asset.caption = "unsaved caption";
  l[1].asset.width = 40;
  setLines(A.core, "page-img", l);
  const B = make(srv, st); // a fresh tab: the save never happened
  await B.core.load();
  const b = B.core.entry("page-img");
  assert.equal(B.core.isDirty(b), true);
  assert.equal(linesOf(b)[1].asset.caption, "unsaved caption");
  assert.equal(linesOf(b)[1].asset.width, 40);
  B.timers.runAll();
  await settle();
  assert.equal(R.linesFromContent(srv.pg("page-img").content)[1].asset.caption, "unsaved caption");
  ok();
}

// E. poll never overwrites a dirty image page; a clean one adopts the remote image state
{
  const srv = fakeServer();
  const { core } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-img");
  const l = linesOf(e);
  l[1].asset.caption = "local";
  setLines(core, "page-img", l);
  const remote = R.linesFromContent(srv.pg("page-img").content);
  remote[1].asset.caption = "remote";
  srv.remote({ action: "page_save", id: "page-img", expected_rev: 3, content: R.contentFromLines(remote) });
  await core.poll();
  await settle();
  assert.equal(linesOf(e)[1].asset.caption, "local", "dirty local image state protected from polling");
  const clean = make(srv, memStorage());
  await clean.core.load();
  const ce = clean.core.entry("page-img");
  const r2 = R.linesFromContent(srv.pg("page-img").content);
  r2[1].asset.width = 90;
  srv.remote({ action: "page_save", id: "page-img", expected_rev: srv.pg("page-img").rev, content: R.contentFromLines(r2) });
  await clean.core.poll();
  await settle();
  assert.equal(linesOf(ce)[1].asset.width, 90);
  ok();
}

// F. image + citation adjacency / checklist / marks survive alongside (structure is independent per line)
{
  const cite = { src: "srce-aaa", loc: { kind: "page", text: "417" }, pdf: 439, ok: false, snap: { title: "Shigley" }, from: null };
  let lines = [P("Voir Shigley p.417"), I(ASSET("a")), R.newLine("todo", "check", true, [])];
  const ins = R.insertCitation(lines, 4, 11, cite);
  assert.ok(ins, "citation inserted on the line above an image");
  lines = ins.lines;
  const out = R.linesFromTextFmt(R.flat(lines), R.fmtOf(lines));
  assert.ok(out, "citation line next to an image round-trips");
  assert.equal(out[0].marks.some((m) => m.type === "citation"), true);
  assert.equal(out[1].type, "image");
  assert.equal(out[2].checked, true);
  const cont = R.contentFromLines(out);
  assert.deepEqual(R.linesFromContent(cont).map((l) => l.type), ["paragraph", "image", "check"]);
  ok();
}

console.log(`hq carnet media checks ok (${groups} groups)`);
