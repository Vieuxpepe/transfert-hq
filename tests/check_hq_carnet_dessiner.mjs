// Pure checks of the Product Phase-3 return-context codec and the create / open / annotate / return flows
// (assets/hq-carnet-dessiner.js) against a MOCK host. No browser, no server, no live data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../assets/hq-carnet-dessiner.js");
let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n += 1;
  } catch (e) {
    console.error("FAIL:", name);
    throw e;
  }
};

const NOW = 1_800_000_000_000;
const PAGE = "page-abc";
const ASSET = "asset-" + "a".repeat(24);

await test("context: exact keys per mode, bounded, never trusts shape", () => {
  const open = D.makeContext({ mode: "open", pageId: PAGE, rev: 3, blockId: "block-1", stem: "Plan_HQWeb" }, NOW);
  assert.deepEqual(open, { v: 1, mode: "open", pageId: PAGE, rev: 3, t: NOW, blockId: "block-1", stem: "Plan_HQWeb" });
  const nw = D.makeContext({ mode: "new", pageId: PAGE, rev: 1 }, NOW);
  assert.equal(nw.anchorId, "");
  const an = D.makeContext({ mode: "annotate", pageId: PAGE, rev: 2, anchorId: "block-2", assetId: ASSET }, NOW);
  assert.equal(an.assetId, ASSET);
  assert.equal(D.makeContext({ mode: "annotate", pageId: PAGE, rev: 2, anchorId: "", assetId: ASSET }, NOW), null, "annotate needs a real anchor");
  assert.equal(D.makeContext({ mode: "open", pageId: PAGE, rev: 3, blockId: "x", stem: "ok" }, NOW), null, "bad block id");
  assert.equal(D.makeContext({ mode: "open", pageId: "../x", rev: 3, blockId: "block-1", stem: "ok" }, NOW), null, "bad page id");
  assert.equal(D.makeContext({ mode: "open", pageId: PAGE, rev: 3, blockId: "block-1", stem: "../etc" }, NOW), null, "path-like stem");
  assert.equal(D.makeContext({ mode: "open", pageId: PAGE, rev: 0, blockId: "block-1", stem: "ok" }, NOW), null, "rev >= 1");
  assert.equal(D.makeContext({ mode: "weird", pageId: PAGE, rev: 1 }, NOW), null);
  assert.equal(D.checkContext({ ...open, extra: 1 }, NOW), null, "unknown key");
  assert.equal(D.checkContext({ ...open, saved: "a b" }, NOW), null, "bad saved stem");
  assert.deepEqual(D.checkContext({ ...open, saved: "Plan2_HQWeb" }, NOW).saved, "Plan2_HQWeb");
  assert.equal(D.checkContext({ ...nw, blockId: "block-1" }, NOW), null, "key of another mode");
  for (const bad of [null, undefined, 1, "x", [], {}]) assert.equal(D.checkContext(bad, NOW), null);
});

await test("context: 6 h TTL, bounded clock skew", () => {
  const c = D.makeContext({ mode: "new", pageId: PAGE, rev: 1 }, NOW);
  assert.ok(D.checkContext(c, NOW + D.TTL_MS));
  assert.equal(D.checkContext(c, NOW + D.TTL_MS + 1), null);
  assert.equal(D.checkContext(c, NOW - 61000), null);
});

// ---- mock host -------------------------------------------------------------------------------------------------------
function world(over = {}) {
  const store = new Map();
  const w = {
    flashes: [],
    inserted: [],
    offers: [],
    revealed: [],
    previews: 0,
    views: [],
    cleared: 0,
    cur: { pageId: PAGE, rev: 5, dirty: false, conflict: false, readOnly: false },
    page: { trashed: false, rev: 5, dirty: false, conflict: false },
    blocks: { "block-d": { id: "block-d", type: "drawing", stem: "Plan_HQWeb" }, "block-i": { id: "block-i", type: "image", assetId: ASSET } },
    order: [{ id: "block-i", type: "image", assetId: ASSET }],
    flushOk: true,
    sk: null,
    store,
    ...over,
  };
  const calls = (w.calls = []);
  w.sk = w.sk || {
    openExact: async (stem, link) => (calls.push(["openExact", stem]), (w.link = link), { ok: true }),
    startBlank: (link) => (calls.push(["startBlank"]), (w.link = link), { ok: true }),
    startUnderlay: (id, link) => (calls.push(["startUnderlay", id]), (w.link = link), { ok: true }),
  };
  const host = {
    now: () => NOW,
    storage: () => ({ getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }),
    sketch: () => w.sk,
    current: () => w.cur,
    flushCurrent: async () => w.flushOk,
    findBlock: (id) => w.blocks[id] || null,
    blockAt: (i) => w.order[i] || null,
    refreshRemote: async () => {
      w.refreshes = (w.refreshes || 0) + 1;
      if (typeof w.onRefresh === "function") w.onRefresh();
      return w.refreshOk !== false;
    },
    pageState: (id) => (id === PAGE && !w.gone ? w.page : null),
    openPage: async (id) => id === PAGE && !w.gone,
    reveal: (id) => w.revealed.push(id),
    refreshPreviews: () => (w.previews += 1),
    offerVersion: (b, f, t) => w.offers.push([b, f, t]),
    insertDrawing: (o) => (w.insertRefuse ? -1 : (w.inserted.push(o), 1)),
    setView: (v) => w.views.push(v),
    clearSketchLink: () => (w.cleared += 1),
    flash: (m) => w.flashes.push(m),
  };
  w.m = D.mount(host);
  return w;
}

await test("open: exact stem only, context captured, Dessiner link given", async () => {
  const w = world();
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), true);
  assert.deepEqual(w.calls, [["openExact", "Plan_HQWeb"]]);
  assert.deepEqual(w.views, ["dessiner"]);
  const ctx = JSON.parse(w.store.get(D.CTX_KEY));
  assert.deepEqual([ctx.mode, ctx.blockId, ctx.stem, ctx.rev], ["open", "block-d", "Plan_HQWeb", 5]);
  assert.ok(!("saved" in ctx));
  assert.equal(typeof w.link.ret, "function");
});

await test("open: refused when the block changed, page is dirty/conflicted/read-only or cannot be saved", async () => {
  let w = world();
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Other" }), false);
  assert.ok(w.calls.length === 0 && !w.store.size && w.views.length === 0);
  w = world({ flushOk: false });
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), false);
  assert.equal(w.flashes.at(-1), D.MSG.saveFirst);
  w = world({ cur: { pageId: PAGE, rev: 5, dirty: true, conflict: false, readOnly: false } });
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), false);
  w = world({ cur: { pageId: PAGE, rev: 5, dirty: false, conflict: true, readOnly: false } });
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), false);
  assert.equal(w.flashes.at(-1), D.MSG.conflict);
  w = world({ cur: { pageId: PAGE, rev: 5, dirty: false, conflict: false, readOnly: true } });
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), false);
  w = world({ sk: null });
  w.sk = null;
  const bare = D.mount({ ...{ now: () => NOW, storage: () => null, sketch: () => null, flash: (m) => w.flashes.push(m) } });
  assert.equal(await bare.start("new", {}), false);
  assert.equal(w.flashes.at(-1), D.MSG.unavailable);
});

await test("open: Dessiner failure restores Carnet and leaves no context", async () => {
  const w = world();
  w.sk = { openExact: async () => ({ ok: false, error: "Croquis introuvable" }) };
  assert.equal(await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" }), false);
  assert.equal(w.store.size, 0);
  assert.deepEqual(w.views, ["dessiner", "carnet"]);
  assert.equal(w.flashes.at(-1), "Croquis introuvable");
});

await test("return (open): navigation only, same stem -> no offer, never inserts or edits", async () => {
  const w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  await w.m.resume();
  assert.deepEqual(w.revealed, ["block-d"]);
  assert.equal(w.previews, 1);
  assert.deepEqual(w.offers, []);
  assert.deepEqual(w.inserted, []);
  assert.equal(w.store.size, 0, "single-shot: the context is gone");
  await w.m.resume();
  assert.equal(w.revealed.length, 1, "second resume is a no-op");
});

await test("return (open): a NEW saved stem is only OFFERED (explicit button), never applied", async () => {
  const w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  w.link.onSaved({ stem: "Plan_v2_HQWeb", parent: "Plan_HQWeb" });
  w.link.onSaved({ stem: "Plan_v3_HQWeb", parent: "Plan_v2_HQWeb" });
  await w.m.resume();
  assert.deepEqual(w.offers, [["block-d", "Plan_HQWeb", "Plan_v3_HQWeb"]], "the last EXACT stem Dessiner reported, no lookup");
  assert.deepEqual(w.inserted, []);
});

await test("return (open): block deleted meanwhile -> message, nothing recreated; page gone / trashed -> nothing", async () => {
  let w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  delete w.blocks["block-d"];
  await w.m.resume();
  assert.equal(w.flashes.at(-1), D.MSG.blockGone);
  assert.deepEqual([w.inserted, w.offers, w.revealed], [[], [], []]);
  w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  w.blocks["block-d"].stem = "Elsewhere";
  await w.m.resume();
  assert.equal(w.flashes.at(-1), D.MSG.blockChanged);
  w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  w.page.trashed = true;
  await w.m.resume();
  assert.equal(w.flashes.at(-1), D.MSG.pageTrashed);
  w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  w.gone = true;
  await w.m.resume();
  assert.equal(w.flashes.at(-1), D.MSG.pageGone);
  assert.deepEqual(w.revealed, []);
});

await test("new sketch: nothing is inserted until a save; cancel changes nothing", async () => {
  const w = world();
  assert.equal(await w.m.start("new", { anchorIndex: 0 }), true);
  assert.deepEqual(w.calls, [["startBlank"]]);
  assert.equal(JSON.parse(w.store.get(D.CTX_KEY)).anchorId, "block-i");
  await w.m.resume();
  assert.deepEqual(w.inserted, []);
  assert.deepEqual(w.revealed, ["block-i"]);
});

await test("new sketch: saved + context still valid -> exactly ONE insertion of the exact stem", async () => {
  const w = world();
  await w.m.start("new", { anchorIndex: 0 });
  w.link.onSaved({ stem: "New_HQWeb", parent: null });
  await w.m.resume();
  assert.deepEqual(w.inserted, [{ anchorId: "block-i", stem: "New_HQWeb", replaceEmpty: true }]);
  assert.equal(w.flashes.at(-1), D.MSG.inserted);
  await w.m.resume();
  assert.equal(w.inserted.length, 1);
});

await test("new sketch: with no anchor the reference is appended (anchorId '')", async () => {
  const w = world({ order: [] });
  await w.m.start("new", { anchorIndex: 3 });
  assert.equal(JSON.parse(w.store.get(D.CTX_KEY)).anchorId, "");
  w.link.onSaved({ stem: "New_HQWeb" });
  await w.m.resume();
  assert.deepEqual(w.inserted, [{ anchorId: "", stem: "New_HQWeb", replaceEmpty: true }]);
});

await test("return (new/annotate): remote revision advanced, dirty, conflicted, anchor gone, refused -> NO insertion, drawing kept", async () => {
  const cases = [
    ["rev advanced", (w) => (w.page.rev = 6), D.MSG.revAdvanced],
    ["conflict", (w) => (w.page.conflict = true), D.MSG.revAdvanced],
    ["dirty", (w) => (w.page.dirty = true), D.MSG.dirty],
    ["anchor gone", (w) => delete w.blocks["block-i"], D.MSG.anchorGone],
    ["trashed", (w) => (w.page.trashed = true), D.MSG.pageTrashed],
    ["page deleted", (w) => (w.gone = true), D.MSG.pageGone],
    ["host refuses", (w) => (w.insertRefuse = true), D.MSG.refused],
  ];
  for (const mode of ["new", "annotate"]) {
    for (const [name, mut, msg] of cases) {
      const w = world();
      await w.m.start(mode, { anchorIndex: 0, assetId: ASSET });
      w.link.onSaved({ stem: "Saved_HQWeb" });
      mut(w);
      await w.m.resume();
      assert.deepEqual(w.inserted, [], mode + " / " + name);
      assert.equal(w.flashes.at(-1), msg, mode + " / " + name);
      assert.equal(w.store.size, 0, "context consumed anyway");
    }
  }
});

await test("annotate: image looked up in the SAVED state, asset must match, anchor image must still be that asset", async () => {
  let w = world();
  assert.equal(await w.m.start("annotate", { anchorIndex: 0, assetId: ASSET }), true);
  assert.deepEqual(w.calls, [["startUnderlay", ASSET]]);
  w.link.onSaved({ stem: "Ann_HQWeb" });
  await w.m.resume();
  assert.deepEqual(w.inserted, [{ anchorId: "block-i", stem: "Ann_HQWeb", replaceEmpty: false }], "a separate drawing block AFTER the image");
  w = world();
  assert.equal(await w.m.start("annotate", { anchorIndex: 0, assetId: "asset-" + "b".repeat(24) }), false);
  assert.equal(w.store.size, 0);
  w = world({ order: [{ id: "block-d", type: "drawing", stem: "x" }] });
  assert.equal(await w.m.start("annotate", { anchorIndex: 0, assetId: ASSET }), false);
  w = world();
  await w.m.start("annotate", { anchorIndex: 0, assetId: ASSET });
  w.link.onSaved({ stem: "Ann_HQWeb" });
  w.blocks["block-i"] = { id: "block-i", type: "image", assetId: "asset-" + "c".repeat(24) };
  await w.m.resume();
  assert.deepEqual(w.inserted, []);
  assert.equal(w.flashes.at(-1), D.MSG.blockChanged);
});

await test("return: expired, tampered or foreign context is dropped silently and touches nothing", async () => {
  const w = world();
  w.store.set(D.CTX_KEY, JSON.stringify({ v: 1, mode: "new", pageId: PAGE, rev: 5, t: NOW - D.TTL_MS - 5, anchorId: "", saved: "S_HQWeb" }));
  await w.m.resume();
  assert.deepEqual([w.inserted, w.flashes, w.revealed], [[], [], []]);
  assert.equal(w.store.size, 0);
  w.store.set(D.CTX_KEY, "{not json");
  await w.m.resume();
  assert.equal(w.store.size, 0);
  w.store.set(D.CTX_KEY, JSON.stringify({ v: 1, mode: "new", pageId: "../../x", rev: 5, t: NOW, anchorId: "", saved: "S" }));
  await w.m.resume();
  assert.deepEqual(w.inserted, []);
  assert.equal(w.cleared >= 1, true);
});

await test("onSaved only records a canonical stem into a still-valid context", async () => {
  const w = world();
  w.link = null;
  w.m.onSaved({ stem: "x" });
  assert.equal(w.store.size, 0, "no context -> nothing written");
  await w.m.start("new", { anchorIndex: 0 });
  w.link.onSaved({ stem: "../bad" });
  w.link.onSaved(null);
  assert.ok(!("saved" in JSON.parse(w.store.get(D.CTX_KEY))));
  w.link.onSaved({ stem: "Good_1" });
  assert.equal(JSON.parse(w.store.get(D.CTX_KEY)).saved, "Good_1");
});

await test("refresh failure: NO decision on cached state, context RETAINED, retried on the next return (new / annotate)", async () => {
  for (const mode of ["new", "annotate"]) {
    const w = world();
    await w.m.start(mode, { anchorIndex: 0, assetId: ASSET });
    w.link.onSaved({ stem: "Saved_HQWeb" });
    w.page.rev = 6; // another client advanced the page while Dessiner was open ...
    w.cachedRev = 5; // ... but the cached state still says 5
    w.page.rev = 5;
    w.refreshOk = false; // the authoritative refresh fails
    await w.m.resume();
    assert.deepEqual(w.inserted, [], mode + ": nothing inserted on cached state");
    assert.equal(w.flashes.at(-1), D.MSG.unverified);
    assert.ok(w.store.has(D.CTX_KEY), mode + ": the validated context is still there");
    assert.equal(JSON.parse(w.store.get(D.CTX_KEY)).saved, "Saved_HQWeb");
    // connectivity restored: the real (newer) revision is fetched and the insertion is refused as stale
    w.refreshOk = true;
    w.onRefresh = () => (w.page.rev = 6);
    await w.m.resume();
    assert.deepEqual(w.inserted, [], mode + ": refused as stale after the successful refresh");
    assert.equal(w.flashes.at(-1), D.MSG.revAdvanced);
    assert.equal(w.store.size, 0, mode + ": terminal state consumed the context");
  }
});

await test("refresh failure then success on an unchanged page: the single insertion happens once", async () => {
  const w = world();
  await w.m.start("new", { anchorIndex: 0 });
  w.link.onSaved({ stem: "Saved_HQWeb" });
  w.refreshOk = false;
  await w.m.resume();
  await w.m.resume();
  assert.deepEqual(w.inserted, []);
  w.refreshOk = true;
  await w.m.resume();
  await w.m.resume();
  assert.equal(w.inserted.length, 1);
});

await test("refresh failure with an existing drawing: no version offer, no reveal, context retained until a successful refresh", async () => {
  const w = world();
  await w.m.start("open", { blockId: "block-d", stem: "Plan_HQWeb" });
  w.link.onSaved({ stem: "Plan_v2_HQWeb" });
  w.refreshOk = false;
  await w.m.resume();
  assert.deepEqual([w.offers, w.revealed, w.previews], [[], [], 0]);
  assert.ok(w.store.has(D.CTX_KEY));
  w.refreshOk = true;
  await w.m.resume();
  assert.deepEqual(w.offers, [["block-d", "Plan_HQWeb", "Plan_v2_HQWeb"]]);
  assert.equal(w.store.size, 0);
});

console.log("hq carnet dessiner checks ok (" + n + " tests)");
