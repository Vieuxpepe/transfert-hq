// Carnet Stage 02 — editor state machine checks (no browser, no server, no live data).
// Race fixtures from docs/carnet-agents/FIXTURES.md.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) {
  for (let i = 0; i < n; i += 1) await tick();
}

function fixture() {
  return {
    version: 1,
    notebook_rev: 4,
    projects: [{ id: "proj-fixture", name: "Fixture redesign", archived: false, created_at: 1, updated_at: 1 }],
    categories: [{ id: "cat-measures", name: "Mesures", color: "amber", created_at: 1, updated_at: 1 }],
    pages: [
      page("page-shaft", 3, "Shaft inspection\nØ12.034 mm\nCheck bearing preload", { project_id: "proj-fixture", category_id: "cat-measures", pinned: true }),
      page("page-idea", 1, "Try a split clamp instead"),
    ],
  };
}

function page(id, rev, text, extra) {
  return Object.assign({
    id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1, updated_at: 1,
    content: { version: 1, blocks: [{ id: "block-" + id.slice(5), type: "text", text, marks: [] }] },
  }, extra || {});
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** In-memory server mirroring hq_carnet page_save/page_create semantics. */
function fakeServer() {
  const s = { nb: fixture(), offline: false, hold: false, held: [], calls: [], seq: 0 };
  function err(status, data) {
    const e = new Error(data.error || "Erreur " + status);
    e.status = status;
    e.data = data;
    return e;
  }
  function handle(payload) {
    if (s.offline) {
      const e = new Error("Hors ligne");
      throw e; // network failure: no status
    }
    const nb = s.nb;
    if (payload.action === "page_save") {
      assert.equal("project_id" in payload, false, "Stage 02 never sends project_id");
      assert.equal("category_id" in payload, false, "Stage 02 never sends category_id");
      const p = nb.pages.find((x) => x.id === payload.id);
      if (!p) throw err(404, { error: "Page introuvable", code: "not_found" });
      if (s.validation) throw err(400, { error: "Texte trop long", code: "validation_error" });
      if (payload.expected_rev !== p.rev) throw err(409, { error: "Page modifiée ailleurs", code: "revision_conflict", page: clone(p), notebook_rev: nb.notebook_rev });
      const text = payload.content.blocks[0].text;
      const pinned = "pinned" in payload ? payload.pinned : p.pinned;
      if (text !== p.content.blocks[0].text || pinned !== p.pinned) {
        p.content.blocks[0].text = text;
        p.pinned = pinned;
        p.rev += 1;
      }
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(p) };
    }
    if (payload.action === "page_create") {
      if (payload.expected_notebook_rev !== nb.notebook_rev) throw err(409, { error: "Carnet modifié ailleurs", code: "notebook_revision_conflict", notebook_rev: nb.notebook_rev });
      s.seq += 1;
      const np = page("page-new" + s.seq, 1, "");
      const at = payload.after_id ? nb.pages.findIndex((x) => x.id === payload.after_id) + 1 : nb.pages.length;
      nb.pages.splice(at, 0, np);
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(np) };
    }
    throw err(400, { error: "action invalide", code: "validation_error" });
  }
  s.request = (payload, o) => {
    s.calls.push({ payload: clone(payload), keepalive: !!(o && o.keepalive) });
    if (s.hold) {
      return new Promise((resolve, reject) => {
        s.held.push(() => {
          try {
            resolve(handle(payload));
          } catch (e) {
            reject(e);
          }
        });
      });
    }
    try {
      return Promise.resolve(handle(payload));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  s.release = () => {
    const fns = s.held.splice(0);
    fns.forEach((f) => f());
  };
  s.fetchNotebook = (meta) => {
    s.calls.push({ get: meta ? "meta" : "full" });
    if (s.offline) return Promise.reject(new Error("Hors ligne"));
    const out = clone(s.nb);
    if (meta) out.pages = out.pages.map((p) => ({ id: p.id, rev: p.rev, deleted_at: p.deleted_at, title: C.deriveTitle(p.content.blocks[0].text) }));
    return Promise.resolve(out);
  };
  s.saves = () => s.calls.filter((c) => c.payload && c.payload.action === "page_save");
  return s;
}

function memStorage() {
  const m = new Map();
  return {
    m,
    fail: false,
    getItem(k) { if (this.fail) throw new Error("quota"); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (this.fail) throw new Error("quota"); m.set(k, String(v)); },
    removeItem(k) { if (this.fail) throw new Error("quota"); m.delete(k); },
  };
}

function fakeTimers() {
  const t = { list: new Map(), seq: 0 };
  t.set = (fn, ms) => { t.seq += 1; t.list.set(t.seq, { fn, ms }); return t.seq; };
  t.clear = (h) => { t.list.delete(h); };
  t.runAll = () => { const fns = [...t.list.values()]; t.list.clear(); fns.forEach((x) => x.fn()); };
  t.pending = () => t.list.size;
  return t;
}

function make(server, storage, user = "admin-test") {
  const timers = fakeTimers();
  const drafts = C.createDraftStore(storage, user);
  const events = [];
  const core = C.createCore({
    request: server.request,
    fetchNotebook: server.fetchNotebook,
    drafts,
    timers,
    now: () => 1000,
    onChange: (e) => events.push(e),
  });
  return { core, drafts, timers, events };
}

function draftsOf(storage, user = "admin-test") {
  const raw = storage.m.get(C.draftKey(user));
  return raw ? JSON.parse(raw).pages : {};
}

// ---------------------------------------------------------------- pure helpers
assert.equal(C.deriveTitle("\n  \nShaft inspection\nx"), "Shaft inspection");
assert.equal(C.deriveTitle("   \n"), "Page sans titre");
assert.equal(C.draftKey("admin test/é"), "hq_carnet_drafts_v1:admin%20test%2F%C3%A9");
assert.equal(C.timeMarker(new Date(2026, 8, 29, 7, 5)), "07:05 — ");
assert.equal(C.isSwipe(-60, 0), true);
assert.equal(C.isSwipe(59, 0), false);
assert.equal(C.isSwipe(80, 57), true); // 80 > 1.4*57 = 79.8
assert.equal(C.isSwipe(80, 58), false); // 80 < 81.2: vertical-ish never flips
assert.equal(C.isSwipe(10, 300), false);
assert.equal(C.pageNavDelta({ altKey: true, key: "ArrowLeft" }), -1);
assert.equal(C.pageNavDelta({ altKey: true, key: "ArrowRight" }), 1);
assert.equal(C.pageNavDelta({ altKey: false, key: "ArrowRight" }), 0, "plain arrows stay caret keys");
assert.equal(C.pageNavDelta({ altKey: true, shiftKey: true, key: "ArrowRight" }), 0);
assert.equal(C.pageNavDelta({ altKey: true, ctrlKey: true, key: "ArrowLeft" }), 0);
assert.equal(C.POLL_MS, 5000);
assert.deepEqual(C.SYMBOLS, ["Ø", "±", "°", "µ", "Δ", "×", "→", "≤", "≥", "²", "³"]);

// ---------------------------------------------------------------- late-success race
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  core.select("page-idea");
  // Reach the fixture's generation 10 / serverRev... (page-idea is rev 1 here; shape is the same)
  const e = core.entry("page-idea");
  e.generation = 9;
  e.savedGeneration = 9;
  core.edit("page-idea", { text: "first edit" }); // generation 10
  assert.equal(e.generation, 10);
  assert.equal(draftsOf(st)["page-idea"].content.blocks[0].text, "first edit", "draft written synchronously before debounce");
  assert.equal(timers.pending(), 1);
  srv.hold = true;
  timers.runAll(); // debounce -> save A in flight
  await settle();
  assert.equal(srv.saves().length, 1);
  assert.equal(srv.saves()[0].payload.expected_rev, 1);
  core.edit("page-idea", { text: "first edit + newer text" }); // generation 11
  timers.runAll(); // debounce fires while A is in flight: no second concurrent save
  await settle();
  assert.equal(srv.saves().length, 1, "one in-flight save per page");
  srv.hold = false;
  srv.release(); // A succeeds -> rev 2
  await settle();
  assert.equal(e.local.text, "first edit + newer text", "never reverts to A");
  const second = srv.saves()[1];
  assert.ok(second, "B queued immediately after A returns");
  assert.equal(second.payload.expected_rev, 2, "B saved against A's returned rev");
  assert.equal(second.payload.content.blocks[0].text, "first edit + newer text");
  await settle();
  assert.equal(e.serverRev, 3);
  assert.equal(core.isDirty(e), false, "clean after B success");
  assert.equal(draftsOf(st)["page-idea"], undefined, "draft cleared only after matching generation+payload");
  assert.equal(srv.nb.pages[1].content.blocks[0].text, "first edit + newer text");
}

// intermediate state check: after A success, before B returns, B draft survives with new rev
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  core.edit("page-shaft", { text: "first edit" });
  srv.hold = true;
  timers.runAll();
  await settle();
  core.edit("page-shaft", { text: "first edit + newer text" });
  srv.release(); // A -> rev 4 ; B now held
  await settle();
  const e = core.entry("page-shaft");
  assert.equal(e.serverRev, 4);
  assert.equal(core.isDirty(e), true, "dirty remains true");
  const d = draftsOf(st)["page-shaft"];
  assert.equal(d.content.blocks[0].text, "first edit + newer text", "draft B remains");
  assert.equal(d.server_rev, 4, "draft records the new base rev");
  assert.equal(srv.held.length, 1, "B in flight against rev 4");
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(core.isDirty(e), false);
}

// same text but newer generation (type + undo) is still not cleared by the old response
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  core.edit("page-idea", { text: "A" });
  srv.hold = true;
  timers.runAll();
  await settle();
  core.edit("page-idea", { text: "AB" });
  core.edit("page-idea", { text: "A" }); // same payload as sent, newer generation
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(srv.saves().length, 2, "generation mismatch forces a follow-up save");
  assert.equal(core.isDirty(core.entry("page-idea")), false);
}

// ---------------------------------------------------------------- offline, multiple dirty pages, reload recovery
{
  const srv = fakeServer();
  const st = memStorage();
  const a = make(srv, st);
  await a.core.load();
  a.core.edit("page-shaft", { text: "shaft offline" });
  srv.offline = true;
  a.timers.runAll();
  await settle();
  assert.equal(a.core.st.offline, true);
  assert.equal(a.core.select("page-idea"), "page-idea", "page switch does not wait on server");
  a.core.edit("page-idea", { text: "idea offline" });
  a.timers.runAll(); // debounce + retry timers
  await settle();
  const saved = draftsOf(st);
  assert.deepEqual(Object.keys(saved).sort(), ["page-idea", "page-shaft"], "both drafts coexist");
  assert.equal(saved["page-shaft"].server_rev, 3);
  // "reload": new core, same storage, admin identity confirmed by caller
  srv.offline = false;
  const b = make(srv, st);
  await b.core.load();
  await settle();
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "shaft offline", "recovered draft saved after reload");
  assert.equal(srv.nb.pages[1].content.blocks[0].text, "idea offline");
  assert.deepEqual(draftsOf(st), {}, "drafts cleared once confirmed");
}

// a different user never sees admin drafts (per-user namespace)
{
  const st = memStorage();
  const srv = fakeServer();
  const a = make(srv, st, "admin-test");
  await a.core.load();
  srv.offline = true;
  a.core.edit("page-idea", { text: "secret draft" });
  const other = C.createDraftStore(st, "upload-test");
  assert.deepEqual(other.load(), {}, "other user key sees nothing");
  assert.ok(st.m.has("hq_carnet_drafts_v1:admin-test"));
}

// ---------------------------------------------------------------- localStorage failure
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, drafts, timers } = make(srv, st);
  await core.load();
  st.fail = true;
  core.edit("page-idea", { text: "memory only" });
  assert.equal(drafts.failed, true, "failure is reported");
  assert.equal(core.entry("page-idea").local.text, "memory only", "memory edit kept");
  assert.equal(core.isDirty(core.entry("page-idea")), true, "dirty remains true");
  assert.equal(C.MSG.storage, "Sauvegarde locale indisponible — ne ferme pas cette page.");
  srv.offline = true;
  timers.runAll();
  await settle();
  assert.equal(core.isDirty(core.entry("page-idea")), true, "not falsely saved");
}

// ---------------------------------------------------------------- 409 conflict + both resolutions
async function conflictSetup() {
  const srv = fakeServer();
  const stA = memStorage();
  const stB = memStorage();
  const A = make(srv, stA); // e.g. PC
  const B = make(srv, stB); // e.g. iPhone
  await A.core.load();
  await B.core.load();
  B.core.edit("page-shaft", { text: "from phone" });
  B.timers.runAll();
  await settle();
  assert.equal(srv.nb.pages[0].rev, 4);
  A.core.edit("page-shaft", { text: "from pc" });
  A.timers.runAll();
  await settle();
  return { srv, A, B, stA };
}
{
  const { srv, A, stA } = await conflictSetup();
  const e = A.core.entry("page-shaft");
  assert.ok(e.conflict, "409 -> conflict");
  assert.equal(e.local.text, "from pc", "local text untouched by 409");
  assert.equal(draftsOf(stA)["page-shaft"].content.blocks[0].text, "from pc", "draft preserved exactly");
  assert.equal(C.MSG.conflict, "Modifié ailleurs. Ta saisie est conservée sur cet appareil.");
  // autosave paused: more typing does not send
  const before = srv.saves().length;
  A.core.edit("page-shaft", { text: "from pc, more" });
  A.timers.runAll();
  await settle();
  assert.equal(srv.saves().length, before, "autosave paused while conflicted");
  // polling never overwrites the conflicted page
  await A.core.poll();
  assert.equal(e.local.text, "from pc, more");
  // keep local: current local payload + latest remote rev
  await A.core.keepLocal("page-shaft");
  await settle();
  const last = srv.saves().at(-1).payload;
  assert.equal(last.expected_rev, 4);
  assert.equal(last.content.blocks[0].text, "from pc, more");
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "from pc, more");
  assert.equal(e.conflict, null);
  assert.equal(A.core.isDirty(e), false);
  assert.deepEqual(draftsOf(stA), {});
}
{
  const { srv, A, stA } = await conflictSetup();
  assert.ok(A.core.loadRemote("page-shaft"));
  const e = A.core.entry("page-shaft");
  assert.equal(e.local.text, "from phone", "remote version loaded");
  assert.equal(e.serverRev, 4);
  assert.equal(A.core.isDirty(e), false);
  assert.deepEqual(draftsOf(stA), {}, "draft discarded only by explicit choice");
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "from phone");
}
// repeated 409 on keep-local is allowed
{
  const { srv, A, B } = await conflictSetup();
  // phone edits again before PC resolves
  B.core.edit("page-shaft", { text: "phone again" });
  B.timers.runAll();
  await settle();
  await A.core.keepLocal("page-shaft");
  await settle();
  const e = A.core.entry("page-shaft");
  assert.ok(e.conflict, "second 409 -> conflict again");
  assert.equal(e.conflict.page.rev, 5);
  assert.equal(e.local.text, "from pc");
  await A.core.keepLocal("page-shaft");
  await settle();
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "from pc");
}

// ---------------------------------------------------------------- different pages are independent
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  const B = make(srv, memStorage());
  await A.core.load();
  await B.core.load();
  A.core.edit("page-shaft", { text: "A shaft" });
  B.core.edit("page-idea", { text: "B idea" });
  A.timers.runAll();
  B.timers.runAll();
  await settle();
  assert.equal(A.core.entry("page-shaft").conflict, null);
  assert.equal(B.core.entry("page-idea").conflict, null);
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "A shaft");
  assert.equal(srv.nb.pages[1].content.blocks[0].text, "B idea");
  // conflict on one page leaves the other page's autosave running
  await A.core.poll(); // clean refresh picks up B's idea edit
  assert.equal(A.core.entry("page-idea").local.text, "B idea");
  srv.nb.pages[0].rev += 1; // someone else changed shaft
  A.core.edit("page-shaft", { text: "A shaft 2" });
  A.core.edit("page-idea", { text: "A idea" });
  A.timers.runAll();
  await settle();
  assert.ok(A.core.entry("page-shaft").conflict);
  assert.equal(A.core.entry("page-idea").conflict, null);
  assert.equal(srv.nb.pages[1].content.blocks[0].text, "A idea");
}

// ---------------------------------------------------------------- clean vs dirty polling
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  srv.nb.pages[1].content.blocks[0].text = "remote idea";
  srv.nb.pages[1].rev = 2;
  const adopted = await A.core.poll();
  assert.deepEqual(adopted, ["page-idea"], "clean page adopts remote change");
  assert.equal(A.core.entry("page-idea").local.text, "remote idea");
  A.core.edit("page-idea", { text: "local dirty" });
  srv.nb.pages[1].content.blocks[0].text = "remote again";
  srv.nb.pages[1].rev = 3;
  await A.core.poll();
  assert.equal(A.core.entry("page-idea").local.text, "local dirty", "dirty page never overwritten by polling");
  assert.equal(A.core.entry("page-idea").serverRev, 2, "dirty page keeps its base rev (save will 409)");
  // in-flight page is skipped too
  const srv2 = fakeServer();
  const B = make(srv2, memStorage());
  await B.core.load();
  B.core.edit("page-shaft", { text: "inflight" });
  srv2.hold = true;
  B.timers.runAll();
  await settle();
  B.core.entry("page-shaft").generation = B.core.entry("page-shaft").savedGeneration + 1; // still "saving"
  await B.core.poll();
  assert.equal(B.core.entry("page-shaft").local.text, "inflight");
  // meta-only polls when nothing changed
  const srv3 = fakeServer();
  const D = make(srv3, memStorage());
  await D.core.load();
  srv3.calls.length = 0;
  await D.core.poll();
  assert.deepEqual(srv3.calls, [{ get: "meta" }], "metadata-only when unchanged");
  // no duplicate concurrent polls
  const p1 = D.core.poll();
  const p2 = D.core.poll();
  await Promise.all([p1, p2]);
  assert.equal(srv3.calls.filter((c) => c.get).length, 2);
}

// 409 whose remote content equals what we sent (keepalive landed during unload) is not a conflict
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.edit("page-idea", { text: "landed already" });
  srv.nb.pages[1].content.blocks[0].text = "landed already";
  srv.nb.pages[1].rev = 2;
  A.timers.runAll();
  await settle();
  const e = A.core.entry("page-idea");
  assert.equal(e.conflict, null, "identical remote is adopted, no conflict UI");
  assert.equal(e.serverRev, 2);
  assert.equal(A.core.isDirty(e), false);
  assert.deepEqual(draftsOf(st), {});
}

// ---------------------------------------------------------------- stale category: never resurrected
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  // category deleted elsewhere: page-shaft category -> null, rev 4
  srv.nb.categories = [];
  srv.nb.pages[0].category_id = null;
  srv.nb.pages[0].rev = 4;
  srv.nb.notebook_rev = 5;
  A.core.edit("page-shaft", { text: "stale edit" });
  A.timers.runAll();
  await settle();
  assert.ok(A.core.entry("page-shaft").conflict, "stale client -> 409");
  await A.core.keepLocal("page-shaft");
  await settle();
  assert.equal(srv.nb.pages[0].category_id, null, "category not resurrected");
}

// ---------------------------------------------------------------- page create + navigation
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  assert.equal(A.core.st.currentId, "page-shaft");
  assert.equal(A.core.go(1), "page-idea");
  assert.equal(A.core.go(1), null, "no page after last");
  assert.equal(A.core.go(-1), "page-shaft");
  srv.nb.notebook_rev = 9; // someone else changed structure
  const id = await A.core.createPage();
  assert.ok(id && id.startsWith("page-new"));
  assert.deepEqual(A.core.st.order, ["page-shaft", id, "page-idea"], "inserted after current");
  assert.equal(A.core.st.currentId, id);
  srv.offline = true;
  assert.equal(await A.core.createPage(), null);
  assert.equal(A.core.st.offline, true);
}

// ---------------------------------------------------------------- keepalive flush + pin
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  A.core.edit("page-idea", { text: "leaving" });
  A.core.edit("page-shaft", { pinned: false });
  await A.core.flushAll({ keepalive: true });
  await settle();
  const saves = srv.saves();
  assert.equal(saves.length, 2);
  assert.ok(saves.every((s) => s.keepalive), "lifecycle flush uses keepalive");
  assert.equal(srv.nb.pages[0].pinned, false);
  assert.equal("pinned" in saves.find((s) => s.payload.id === "page-idea").payload, false, "unchanged pin not sent");
  // oversized body falls back to ordinary fetch
  A.core.edit("page-idea", { text: "é".repeat(40000) });
  await A.core.flushAll({ keepalive: true });
  assert.equal(srv.saves().at(-1).keepalive, false);
}

// ---------------------------------------------------------------- orphan draft is kept, never silently dropped
{
  const srv = fakeServer();
  const st = memStorage();
  st.m.set(C.draftKey("admin-test"), JSON.stringify({ version: 1, pages: {
    "page-gone": { server_rev: 2, generation: 3, saved_generation: 1, updated_local_at: 5, project_id: null, category_id: null, pinned: false,
      content: { version: 1, blocks: [{ id: "block-gone", type: "text", text: "lost?", marks: [] }] } },
  } }));
  const A = make(srv, st);
  await A.core.load();
  await settle();
  const e = A.core.entry("page-gone");
  assert.ok(e && e.orphan);
  assert.equal(e.local.text, "lost?");
  assert.ok(A.core.st.order.includes("page-gone"));
  assert.equal(srv.saves().length, 0, "orphan is not auto-saved");
  assert.ok(draftsOf(st)["page-gone"], "orphan draft retained");
}

// ---------------------------------------------------------------- review: storage warning stays truthful across pages
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, drafts, timers } = make(srv, st);
  await core.load();
  srv.offline = true;
  st.fail = true;
  core.edit("page-shaft", { text: "shaft only in memory" });
  assert.equal(drafts.failed, true);
  st.fail = false;
  core.edit("page-idea", { text: "idea persisted" }); // a later write of ANOTHER page succeeds
  assert.equal(draftsOf(st)["page-shaft"], undefined, "shaft edit is not in storage");
  assert.equal(drafts.failed, true, "warning must stay while another dirty page exists only in memory");
  srv.offline = false;
  timers.runAll();
  await settle();
  assert.equal(srv.nb.pages[0].content.blocks[0].text, "shaft only in memory");
  assert.equal(core.isDirty(core.entry("page-shaft")), false);
  assert.equal(drafts.failed, false, "warning clears once the unpersisted page is safe on the server");
}

// ---------------------------------------------------------------- review: success never erases another tab's newer draft (same generation number)
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.edit("page-idea", { text: "tab A" }); // generation 1 in tab A
  srv.hold = true;
  A.timers.runAll();
  await settle();
  // tab B (same user, same storage) writes its own generation-1 draft for the same page
  const B = C.createDraftStore(st, "admin-test");
  B.put("page-idea", { server_rev: 1, generation: 1, saved_generation: 0, updated_local_at: 2, project_id: null, category_id: null, pinned: false,
    content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "tab B newer", marks: [] }] } });
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(A.core.isDirty(A.core.entry("page-idea")), false);
  assert.equal(draftsOf(st)["page-idea"].content.blocks[0].text, "tab B newer", "other tab's draft survives");
}

// ---------------------------------------------------------------- review: full refresh (another page changed) never overwrites a dirty page
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "dirty local" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.nb.pages[1].content.blocks[0].text = "remote idea";
  srv.nb.pages[1].rev = 2;
  srv.nb.pages[0].content.blocks[0].text = "remote shaft"; // clean page change forces a full fetch
  srv.nb.pages[0].rev = 4;
  const adopted = await A.core.poll();
  assert.deepEqual(adopted, ["page-shaft"], "only the clean page adopts");
  assert.equal(A.core.entry("page-idea").local.text, "dirty local", "dirty page untouched by full refresh");
  assert.equal(A.core.entry("page-idea").serverRev, 1, "dirty page keeps its base rev");
  assert.equal(draftsOf(st)["page-idea"].content.blocks[0].text, "dirty local");
}

// ---------------------------------------------------------------- review: 409 equivalence requires pin to match too
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.edit("page-idea", { text: "same text" });
  srv.nb.pages[1].content.blocks[0].text = "same text";
  srv.nb.pages[1].pinned = true; // remote pinned the page; we did not
  srv.nb.pages[1].rev = 2;
  A.timers.runAll();
  await settle();
  const e = A.core.entry("page-idea");
  assert.ok(e.conflict, "differing pin is a real conflict");
  assert.equal(e.local.pinned, false);
  assert.equal(draftsOf(st)["page-idea"].content.blocks[0].text, "same text");
}

// ---------------------------------------------------------------- review: 409 equivalence with newer local typing keeps the newer draft and resends it
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.edit("page-idea", { text: "landed" });
  srv.hold = true;
  A.timers.runAll();
  await settle();
  A.core.edit("page-idea", { text: "landed + newer" }); // typed after send
  // meanwhile the same text already landed (e.g. keepalive from a closed tab): server rev 2
  srv.nb.pages[1].content.blocks[0].text = "landed";
  srv.nb.pages[1].rev = 2;
  srv.hold = false;
  srv.release(); // 409 with identical sent text
  await settle();
  const e = A.core.entry("page-idea");
  assert.equal(e.conflict, null, "no conflict UI for identical content");
  assert.equal(e.local.text, "landed + newer", "newer typing never discarded");
  const last = srv.saves().at(-1).payload;
  assert.equal(last.expected_rev, 2, "newer text resent against the adopted remote rev");
  assert.equal(last.content.blocks[0].text, "landed + newer");
  assert.equal(srv.nb.pages[1].content.blocks[0].text, "landed + newer");
  assert.equal(A.core.isDirty(e), false);
}

// ---------------------------------------------------------------- review 2: status describes the CURRENT page; other pages surface as attention
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  // page B (page-idea) gets a real conflict while the user is on clean page A (page-shaft)
  srv.nb.pages[1].rev = 2;
  srv.nb.pages[1].content.blocks[0].text = "changed elsewhere";
  A.core.edit("page-idea", { text: "local B" });
  A.core.edit("page-shaft", { text: "A saved" });
  A.timers.runAll();
  await settle();
  assert.equal(A.core.st.currentId, "page-shaft");
  assert.ok(A.core.entry("page-idea").conflict);
  assert.equal(A.core.isDirty(A.core.entry("page-shaft")), false);
  let s = A.core.status();
  assert.notEqual(s.text, C.MSG.saving, "conflict on B never makes clean A show Enregistrement…");
  assert.equal(s.text, C.MSG.saved);
  assert.deepEqual(s.attention, ["page-idea"], "conflict on B stays discoverable");
  // current-page saving still shows Enregistrement…
  srv.hold = true;
  A.core.edit("page-shaft", { text: "A typing" });
  assert.equal(A.core.status().text, C.MSG.saving, "dirty current page -> Enregistrement…");
  A.timers.runAll();
  await settle();
  assert.equal(A.core.status().text, C.MSG.saving, "in-flight current page -> Enregistrement…");
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(A.core.status().text, C.MSG.saved);
  // resolving B clears the attention notice
  await A.core.keepLocal("page-idea");
  await settle();
  assert.equal(A.core.entry("page-idea").conflict, null);
  s = A.core.status();
  assert.deepEqual(s.attention, [], "resolved conflict clears the notice");
  assert.equal(s.text, C.MSG.saved);
  // the conflicted page itself still reports its own conflict when current
  srv.nb.pages[1].rev += 1;
  A.core.edit("page-idea", { text: "local B again" });
  A.timers.runAll();
  await settle();
  A.core.select("page-idea");
  assert.equal(A.core.status().text, C.MSG.conflictStatus);
  assert.deepEqual(A.core.status().attention, []);
  A.core.loadRemote("page-idea");
  A.core.select("page-shaft");
  assert.deepEqual(A.core.status().attention, [], "load-remote also clears the notice");
}
// orphan and error on another page stay discoverable; clearing them clears the notice
{
  const srv = fakeServer();
  const st = memStorage();
  st.m.set(C.draftKey("admin-test"), JSON.stringify({ version: 1, pages: {
    "page-gone": { server_rev: 2, generation: 3, saved_generation: 1, updated_local_at: 5, project_id: null, category_id: null, pinned: false,
      content: { version: 1, blocks: [{ id: "block-gone", type: "text", text: "orphan text", marks: [] }] } },
  } }));
  const A = make(srv, st);
  await A.core.load();
  await settle();
  assert.equal(A.core.st.currentId, "page-shaft");
  assert.deepEqual(A.core.status().attention, ["page-gone"], "orphan on another page is discoverable");
  assert.notEqual(A.core.status().text, C.MSG.saving, "orphan elsewhere never shows Enregistrement…");
  // validation error on page-idea while the user is elsewhere
  srv.validation = true;
  A.core.edit("page-idea", { text: "rejected" });
  A.timers.runAll();
  await settle();
  assert.ok(A.core.entry("page-idea").error);
  assert.deepEqual(A.core.status().attention, ["page-idea", "page-gone"], "error on another page is discoverable (page order)");
  assert.notEqual(A.core.status().text, C.MSG.saving);
  // fixing the error (next edit saves) clears it from the notice
  srv.validation = false;
  A.core.edit("page-idea", { text: "accepted" });
  A.timers.runAll();
  await settle();
  assert.equal(A.core.entry("page-idea").error, "");
  assert.deepEqual(A.core.status().attention, ["page-gone"]);
  // current orphan/error pages describe themselves
  A.core.select("page-gone");
  assert.equal(A.core.status().text, C.MSG.orphan);
  assert.deepEqual(A.core.status().attention, []);
}

console.log("hq carnet checks ok");
