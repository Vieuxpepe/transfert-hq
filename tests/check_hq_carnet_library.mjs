// Carnet Stage 03 — organization reconciliation, pins, search, recents, trash, context
// (no browser, no server, no live data). Fixtures from docs/carnet-agents/FIXTURES.md.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) {
  for (let i = 0; i < n; i += 1) await tick();
}
const clone = (x) => JSON.parse(JSON.stringify(x));

function page(id, rev, text, extra) {
  return Object.assign({
    id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010, updated_at: 1790680300,
    content: { version: 1, blocks: [{ id: "block-" + id.slice(5), type: "text", text, marks: [] }] },
  }, extra || {});
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

/** In-memory server mirroring hq_carnet semantics (page_save org refs, structural actions). */
function fakeServer() {
  const s = { nb: fixture(), offline: false, hold: false, held: [], calls: [], seq: 0, now: 1790690000 };
  function err(status, data) {
    const e = new Error(data.error || "Erreur " + status);
    e.status = status;
    e.data = data;
    return e;
  }
  const find = (id) => s.nb.pages.find((x) => x.id === id);
  function nbRev(p) {
    if (p.expected_notebook_rev !== s.nb.notebook_rev) throw err(409, { error: "Carnet modifié ailleurs", code: "notebook_revision_conflict", notebook_rev: s.nb.notebook_rev });
  }
  function pageRev(p, pg) {
    if (p.expected_rev !== pg.rev) throw err(409, { error: "Page modifiée ailleurs", code: "revision_conflict", page: clone(pg), notebook_rev: s.nb.notebook_rev });
  }
  function handle(p) {
    if (s.offline) throw new Error("Hors ligne");
    const nb = s.nb;
    s.now += 1;
    if (p.action === "page_save") {
      const pg = find(p.id);
      if (!pg) throw err(404, { error: "Page introuvable", code: "not_found" });
      pageRev(p, pg);
      if (pg.deleted_at != null) throw err(400, { error: "Page dans la corbeille — restaure-la d'abord", code: "validation_error" });
      let changed = false;
      if ("project_id" in p) {
        const pr = p.project_id && nb.projects.find((x) => x.id === p.project_id);
        if (p.project_id && !pr) throw err(404, { error: "Projet introuvable", code: "not_found" });
        if (pr && pr.archived && p.project_id !== pg.project_id) throw err(400, { error: "Projet archivé", code: "validation_error" });
        if (p.project_id !== pg.project_id) { pg.project_id = p.project_id; changed = true; }
      }
      if ("category_id" in p) {
        if (p.category_id && !nb.categories.some((x) => x.id === p.category_id)) throw err(404, { error: "Catégorie introuvable", code: "not_found" });
        if (p.category_id !== pg.category_id) { pg.category_id = p.category_id; changed = true; }
      }
      if ("pinned" in p && p.pinned !== pg.pinned) { pg.pinned = p.pinned; changed = true; }
      const text = p.content.blocks[0].text;
      if (text !== pg.content.blocks[0].text) { pg.content.blocks[0].text = text; changed = true; }
      if (changed) { pg.rev += 1; pg.updated_at = s.now; }
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(pg) };
    }
    if (p.action === "page_create") {
      nbRev(p);
      if (p.project_id && !nb.projects.some((x) => x.id === p.project_id && !x.archived)) throw err(400, { error: "Projet archivé", code: "validation_error" });
      s.seq += 1;
      const np = page("page-new" + s.seq, 1, "", { project_id: p.project_id || null, category_id: p.category_id || null, created_at: s.now, updated_at: s.now });
      const at = p.after_id ? nb.pages.findIndex((x) => x.id === p.after_id) + 1 : nb.pages.length;
      nb.pages.splice(at, 0, np);
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(np) };
    }
    if (p.action === "page_trash" || p.action === "page_restore" || p.action === "page_delete_permanent") {
      nbRev(p);
      const pg = find(p.id);
      if (!pg) throw err(404, { error: "Page introuvable", code: "not_found" });
      pageRev(p, pg);
      if (p.action === "page_trash") {
        if (pg.deleted_at != null) throw err(400, { error: "Page déjà dans la corbeille", code: "validation_error" });
        pg.deleted_at = s.now; pg.rev += 1; pg.updated_at = s.now; nb.notebook_rev += 1;
        const out = { ok: true, notebook_rev: nb.notebook_rev, page: clone(pg) };
        if (!nb.pages.some((x) => x.deleted_at == null)) {
          s.seq += 1;
          const blank = page("page-blank" + s.seq, 1, "", { created_at: s.now, updated_at: s.now });
          nb.pages.push(blank);
          out.replacement_page = clone(blank);
        }
        return out;
      }
      if (p.action === "page_restore") {
        if (pg.deleted_at == null) throw err(400, { error: "Page non supprimée", code: "validation_error" });
        pg.deleted_at = null; pg.rev += 1; pg.updated_at = s.now; nb.notebook_rev += 1;
        return { ok: true, notebook_rev: nb.notebook_rev, page: clone(pg) };
      }
      if (pg.deleted_at == null) throw err(400, { error: "Mets d'abord la page à la corbeille", code: "validation_error" });
      nb.pages = nb.pages.filter((x) => x !== pg);
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, id: pg.id };
    }
    if (p.action === "category_create") {
      nbRev(p);
      s.seq += 1;
      const c = { id: "cat-n" + s.seq, name: p.name, color: p.color, created_at: s.now, updated_at: s.now };
      nb.categories.push(c); nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, category: clone(c) };
    }
    if (p.action === "category_update") {
      nbRev(p);
      const c = nb.categories.find((x) => x.id === p.id);
      if ("name" in p) c.name = p.name;
      if ("color" in p) c.color = p.color;
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, category: clone(c) };
    }
    if (p.action === "category_delete") {
      nbRev(p);
      nb.categories = nb.categories.filter((x) => x.id !== p.id);
      const affected = [];
      for (const pg of nb.pages) if (pg.category_id === p.id) { pg.category_id = null; pg.rev += 1; affected.push(pg.id); }
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, category: { id: p.id, deleted: true }, affected_pages: affected };
    }
    if (p.action === "project_create") {
      nbRev(p);
      s.seq += 1;
      const pr = { id: "proj-n" + s.seq, name: p.name, archived: false, created_at: s.now, updated_at: s.now };
      nb.projects.push(pr); nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, project: clone(pr) };
    }
    if (p.action === "project_update" || p.action === "project_archive") {
      nbRev(p);
      const pr = nb.projects.find((x) => x.id === p.id);
      if (p.action === "project_update") pr.name = p.name;
      else pr.archived = p.archived;
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, project: clone(pr) };
    }
    throw err(400, { error: "action invalide", code: "validation_error" });
  }
  s.request = (payload, o) => {
    s.calls.push({ payload: clone(payload), keepalive: !!(o && o.keepalive) });
    if (s.hold && payload.action === "page_save") {
      return new Promise((resolve, reject) => {
        s.held.push(() => {
          try { resolve(handle(payload)); } catch (e) { reject(e); }
        });
      });
    }
    try { return Promise.resolve(handle(payload)); } catch (e) { return Promise.reject(e); }
  };
  s.release = () => s.held.splice(0).forEach((f) => f());
  s.fetchNotebook = (meta) => {
    s.calls.push({ get: meta ? "meta" : "full" });
    if (s.offline) return Promise.reject(new Error("Hors ligne"));
    const out = clone(s.nb);
    if (meta) out.pages = out.pages.map((p) => ({ id: p.id, rev: p.rev, deleted_at: p.deleted_at }));
    return Promise.resolve(out);
  };
  s.saves = () => s.calls.filter((c) => c.payload && c.payload.action === "page_save");
  s.pg = (id) => find(id);
  // "another device": an action applied on the server without going through this client's log
  s.remote = (payload) => handle(Object.assign({ expected_notebook_rev: s.nb.notebook_rev }, payload));
  // "another client": structural change applied directly on the server
  s.deleteCategory = (id) => handle({ action: "category_delete", id, expected_notebook_rev: s.nb.notebook_rev });
  return s;
}

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
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
  const core = C.createCore({ request: server.request, fetchNotebook: server.fetchNotebook, drafts, timers, now: () => 1790690000000, onChange: (e) => events.push(e) });
  return { core, drafts, timers, events };
}

function draftsOf(storage) {
  const raw = storage.m.get(C.draftKey("admin-test"));
  return raw ? JSON.parse(raw).pages : {};
}

function legacyDraft(storage, id, rec) {
  storage.m.set(C.draftKey("admin-test"), JSON.stringify({ version: 1, pages: { [id]: rec } }));
}

let n = 0;
const ok = (label) => { n += 1; if (process.env.VERBOSE) console.log("  OK", label); };

// ================================================================ DATA INTEGRITY (before any org save)

// 1. Legacy Stage-02 draft with a stale category snapshot: category deleted elsewhere.
{
  const srv = fakeServer();
  srv.deleteCategory("cat-measures"); // page-shaft category -> null, rev 4
  assert.equal(srv.pg("page-shaft").rev, 4);
  const st = memStorage();
  legacyDraft(st, "page-shaft", { server_rev: 4, generation: 2, saved_generation: 1, updated_local_at: 5, project_id: "proj-fixture", category_id: "cat-measures", pinned: true,
    content: { version: 1, blocks: [{ id: "block-shaft", type: "text", text: "draft text", marks: [] }] } });
  const A = make(srv, st);
  await A.core.load();
  await settle();
  const e = A.core.entry("page-shaft");
  assert.equal(e.local.category_id, null, "draft snapshot never overrides authoritative category");
  assert.equal(e.local.text, "draft text", "draft still owns the text");
  const sv = srv.saves().at(-1).payload;
  assert.equal("category_id" in sv, false, "recovered draft never sends the stale category");
  assert.equal("project_id" in sv, false);
  assert.equal(srv.pg("page-shaft").category_id, null, "deleted category not resurrected");
  assert.equal(srv.pg("page-shaft").content.blocks[0].text, "draft text");
  ok("legacy draft snapshot ignored");
}

// 2. Draft with an explicit intent whose base no longer matches the server: dropped at recovery.
{
  const srv = fakeServer();
  srv.nb.categories.push({ id: "cat-x", name: "X", color: "blue", created_at: 1, updated_at: 1 });
  srv.deleteCategory("cat-x"); // no page affected, notebook_rev bump
  const st = memStorage();
  legacyDraft(st, "page-idea", { server_rev: 1, generation: 3, saved_generation: 1, updated_local_at: 5, pinned: false,
    org: { category_id: { value: "cat-x", base: null } },
    content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "idea draft", marks: [] }] } });
  const A = make(srv, st);
  await A.core.load();
  await settle();
  assert.deepEqual(A.core.entry("page-idea").intent, {}, "intent to a deleted category is dropped");
  assert.equal("category_id" in srv.saves().at(-1).payload, false);
  assert.equal(srv.pg("page-idea").category_id, null);
  ok("stale intent (deleted target) dropped on recovery");
}
{
  // intent base mismatch: page already moved elsewhere by another client -> server wins
  const srv = fakeServer();
  srv.nb.categories.push({ id: "cat-y", name: "Y", color: "teal", created_at: 1, updated_at: 1 });
  const st = memStorage();
  legacyDraft(st, "page-shaft", { server_rev: 3, generation: 2, saved_generation: 1, updated_local_at: 5, pinned: true,
    org: { category_id: { value: "cat-y", base: "cat-other" } },
    content: { version: 1, blocks: [{ id: "block-shaft", type: "text", text: "Shaft inspection\nØ12.034 mm\nCheck bearing preload", marks: [] }] } });
  const A = make(srv, st);
  await A.core.load();
  await settle();
  assert.equal(A.core.entry("page-shaft").local.category_id, "cat-measures", "base mismatch -> authoritative value");
  assert.deepEqual(draftsOf(st), {}, "draft identical to server once the stale intent is gone");
  assert.equal(srv.saves().length, 0);
  ok("stale intent (base mismatch) dropped on recovery");
}
{
  // valid intent survives reload and is sent
  const srv = fakeServer();
  const st = memStorage();
  legacyDraft(st, "page-idea", { server_rev: 1, generation: 2, saved_generation: 1, updated_local_at: 5, pinned: false,
    org: { category_id: { value: "cat-measures", base: null }, project_id: { value: "proj-fixture", base: null } },
    content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "Try a split clamp instead", marks: [] }] } });
  const A = make(srv, st);
  await A.core.load();
  await settle();
  assert.equal(srv.pg("page-idea").category_id, "cat-measures");
  assert.equal(srv.pg("page-idea").project_id, "proj-fixture");
  assert.deepEqual(A.core.entry("page-idea").intent, {});
  assert.deepEqual(draftsOf(st), {});
  ok("valid intent survives reload");
}

// 3. Initial load / clean polling: server org adopted.
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  assert.equal(A.core.entry("page-shaft").local.category_id, "cat-measures");
  srv.deleteCategory("cat-measures");
  await A.core.poll();
  assert.equal(A.core.entry("page-shaft").local.category_id, null, "clean refresh adopts null category");
  assert.equal(A.core.entry("page-shaft").serverRev, 4);
  ok("clean polling adopts org");
}

// 4. Dirty page: polling keeps text/base rev but org metadata is authoritative.
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-shaft", { text: "dirty shaft" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.deleteCategory("cat-measures");
  await A.core.poll();
  const e = A.core.entry("page-shaft");
  assert.equal(e.local.text, "dirty shaft");
  assert.equal(e.serverRev, 3, "dirty page keeps its base rev");
  assert.equal(e.local.category_id, null, "dirty page shows authoritative category");
  assert.equal("category_id" in (draftsOf(st)["page-shaft"] || {}), false, "draft holds no category snapshot");
  // save -> 409 (rev 4) -> keep local: never resurrects
  A.core.retryAll();
  await settle();
  assert.ok(e.conflict);
  await A.core.keepLocal("page-shaft");
  await settle();
  assert.equal(srv.pg("page-shaft").category_id, null);
  assert.equal(srv.pg("page-shaft").content.blocks[0].text, "dirty shaft");
  assert.equal(srv.saves().some((s) => "category_id" in s.payload), false, "no save ever carried category_id");
  ok("dirty page org reconciled + conflict keep-local safe");
}

// 5. User intent + category deleted elsewhere before the save lands -> 409 -> intent dropped.
{
  const srv = fakeServer();
  srv.nb.categories.push({ id: "cat-x", name: "X", color: "blue", created_at: 1, updated_at: 1 });
  const A = make(srv, memStorage());
  await A.core.load();
  srv.hold = true;
  assert.ok(A.core.setContext("page-idea", { category_id: "cat-x" }));
  await settle();
  // another client deletes cat-x and edits the page meanwhile
  srv.nb.categories = srv.nb.categories.filter((c) => c.id !== "cat-x");
  srv.pg("page-idea").rev = 2;
  srv.hold = false;
  srv.release();
  await settle();
  const e = A.core.entry("page-idea");
  assert.equal(srv.pg("page-idea").category_id, null);
  // the save was refused: 404 (target gone) or 409; either way the intent never survives
  await A.core.refreshFull().catch(() => {});
  if (e.conflict) await A.core.keepLocal("page-idea");
  await settle();
  assert.deepEqual(e.intent, {}, "deleted target intent dropped");
  assert.equal(srv.pg("page-idea").category_id, null, "never resurrected");
  ok("intent vs concurrent category delete");
}

// 6. Save success adopts server org; late success keeps newer choice rebased.
{
  const srv = fakeServer();
  srv.nb.categories.push({ id: "cat-y", name: "Y", color: "teal", created_at: 1, updated_at: 1 });
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.hold = true;
  A.core.setContext("page-idea", { category_id: "cat-measures" });
  await settle();
  assert.equal(srv.saves().length, 1);
  assert.equal(srv.saves()[0].payload.category_id, "cat-measures");
  A.core.setContext("page-idea", { category_id: "cat-y" }); // newer choice while in flight
  assert.equal(srv.saves().length, 1, "one in-flight save per page");
  srv.hold = false;
  srv.release();
  await settle();
  const e = A.core.entry("page-idea");
  const second = srv.saves()[1].payload;
  assert.equal(second.category_id, "cat-y", "newer choice sent after late success");
  assert.equal(second.expected_rev, 2);
  assert.equal(srv.pg("page-idea").category_id, "cat-y");
  assert.equal(e.local.category_id, "cat-y");
  assert.deepEqual(e.intent, {});
  assert.equal(A.core.isDirty(e), false);
  assert.deepEqual(draftsOf(st), {});
  ok("late success with newer org choice");
}

// 7. Clearing assignment + project semantics.
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  assert.ok(A.core.setContext("page-shaft", { project_id: null, category_id: "" }));
  await settle();
  const last = srv.saves().at(-1).payload;
  assert.equal(last.project_id, null);
  assert.equal(last.category_id, null);
  assert.equal(srv.pg("page-shaft").project_id, null);
  assert.equal(srv.pg("page-shaft").category_id, null);
  assert.equal(A.core.setContext("page-shaft", { category_id: "cat-missing" }), false, "unknown target refused locally");
  // archived project: cannot be newly assigned, but a page keeps it
  srv.nb.projects[0].archived = true;
  await A.core.refreshFull();
  assert.equal(A.core.setContext("page-idea", { project_id: "proj-fixture" }), false, "archived project not assignable");
  ok("clear assignment / archived refused");
}

// ================================================================ PIN through the normal queue
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.hold = true;
  A.core.edit("page-idea", { pinned: true });
  assert.equal(draftsOf(st)["page-idea"].pinned, true, "pin draft written synchronously");
  A.timers.runAll();
  await settle();
  A.core.edit("page-idea", { pinned: false }); // unpin while pin save in flight
  A.timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 1, "one in-flight save");
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(srv.saves().length, 2, "late success resends newest pin");
  assert.equal(srv.pg("page-idea").pinned, false);
  assert.equal(A.core.entry("page-idea").local.pinned, false);
  assert.equal(A.core.isDirty(A.core.entry("page-idea")), false);
  // pin conflict: remote text changed
  srv.pg("page-idea").rev += 1;
  srv.pg("page-idea").content.blocks[0].text = "remote";
  A.core.edit("page-idea", { pinned: true });
  A.timers.runAll();
  await settle();
  assert.ok(A.core.entry("page-idea").conflict, "pin save 409 -> conflict");
  assert.equal(A.core.entry("page-idea").local.pinned, true);
  // persistence across reload: new core, same storage
  const B = make(srv, st);
  await B.core.load();
  await settle();
  assert.equal(B.core.entry("page-idea").local.pinned, true, "pin survives reload via draft");
  ok("pin queue / late race / 409 / reload");
}

// ================================================================ create in context
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  const g = await A.core.createPage();
  assert.equal(srv.pg(g).project_id, null, "global New stays À classer");
  assert.equal(srv.pg(g).category_id, null);
  assert.equal("project_id" in srv.calls.find((c) => c.payload && c.payload.action === "page_create").payload, false);
  const p = await A.core.createPage({ project_id: "proj-fixture" });
  assert.equal(srv.pg(p).project_id, "proj-fixture", "inherits filtered project");
  const c = await A.core.createPage({ category_id: "cat-measures" });
  assert.equal(srv.pg(c).category_id, "cat-measures", "inherits filtered category");
  assert.equal(A.core.entry(c).local.category_id, "cat-measures");
  srv.nb.projects[0].archived = true;
  await A.core.refreshFull();
  const a = await A.core.createPage({ project_id: "proj-fixture" });
  assert.ok(a, "archived project scope still creates a page");
  assert.equal(srv.pg(a).project_id, null, "archived project is not inherited");
  ok("create in context");
}

// ================================================================ projects / categories CRUD
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  srv.nb.notebook_rev += 1; // someone else changed structure: one refresh + retry
  const pr = await A.core.createProject("Banc d'essai");
  assert.ok(pr && pr.id);
  assert.ok(A.core.st.projects.some((x) => x.id === pr.id));
  await A.core.renameProject(pr.id, "Banc");
  assert.equal(A.core.st.projects.find((x) => x.id === pr.id).name, "Banc");
  await A.core.archiveProject(pr.id, true);
  assert.equal(A.core.st.projects.find((x) => x.id === pr.id).archived, true);
  await A.core.archiveProject(pr.id, false);
  const cat = await A.core.createCategory("Idées", "violet");
  assert.equal(A.core.st.categories.find((x) => x.id === cat.id).color, "violet");
  await A.core.updateCategory(cat.id, { name: "Idées folles", color: "pink" });
  assert.equal(A.core.st.categories.find((x) => x.id === cat.id).name, "Idées folles");
  A.core.setContext("page-idea", { category_id: cat.id });
  await settle();
  assert.equal(srv.pg("page-idea").category_id, cat.id);
  await A.core.deleteCategory(cat.id);
  assert.equal(srv.pg("page-idea").category_id, null);
  assert.equal(A.core.entry("page-idea").local.category_id, null, "client adopts unassigned page");
  assert.equal(A.core.entry("page-idea").conflict, null, "own delete does not self-conflict a clean page");
  ok("project/category CRUD");
}

// ================================================================ TRASH
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.edit("page-shaft", { text: "edited before trash" });
  assert.ok(await A.core.trashPage("page-shaft"));
  assert.equal(srv.pg("page-shaft").content.blocks[0].text, "edited before trash", "pending edit saved before trashing");
  assert.ok(srv.pg("page-shaft").deleted_at != null, "soft delete");
  assert.deepEqual(A.core.st.order, ["page-idea"]);
  assert.equal(A.core.st.currentId, "page-idea", "moves to a neighbour");
  // read-only while trashed
  A.core.select("page-shaft");
  assert.equal(A.core.st.currentId, "page-shaft", "trashed page viewable");
  assert.equal(A.core.edit("page-shaft", { text: "nope" }), false, "edit refused");
  assert.equal(A.core.edit("page-shaft", { pinned: false }), false, "pin refused");
  assert.equal(A.core.setContext("page-shaft", { category_id: null }), false, "context refused");
  A.timers.runAll();
  await settle();
  assert.equal(srv.saves().filter((s) => s.payload.id === "page-shaft").length, 1, "no autosave while trashed");
  await A.core.poll();
  assert.equal(A.core.st.currentId, "page-shaft", "polling keeps the trashed page open");
  assert.equal(A.core.go(1), null, "no page flip from trash");
  // undo/restore
  assert.ok(await A.core.restorePage("page-shaft"));
  assert.equal(srv.pg("page-shaft").deleted_at, null);
  assert.deepEqual(A.core.st.order, ["page-shaft", "page-idea"], "restored in server order");
  assert.ok(A.core.edit("page-shaft", { text: "editable again" }));
  A.timers.runAll();
  await settle();
  assert.equal(srv.pg("page-shaft").content.blocks[0].text, "editable again");
  // permanent delete: only from trash
  await assert.rejects(A.core.deletePermanent("page-shaft", srv.pg("page-shaft").rev), /corbeille/);
  assert.ok(srv.pg("page-shaft"), "active page never permanently deleted");
  await A.core.trashPage("page-shaft");
  await assert.rejects(A.core.deletePermanent("page-shaft"), /Confirmation/, "no confirmed revision -> refused");
  assert.ok(await A.core.deletePermanent("page-shaft", A.core.entry("page-shaft").latest.rev));
  assert.equal(srv.pg("page-shaft"), undefined);
  assert.equal(A.core.entry("page-shaft"), undefined);
  ok("trash / read-only / restore / permanent");
}
{
  // final active page: server replacement is adopted and opened
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  await A.core.trashPage("page-shaft");
  await A.core.trashPage("page-idea");
  assert.equal(A.core.st.order.length, 1);
  const repl = A.core.st.order[0];
  assert.ok(repl.startsWith("page-blank"));
  assert.equal(A.core.st.currentId, repl, "replacement blank page opened");
  assert.equal(A.core.entry(repl).local.text, "");
  ok("final-active-page");
}
{
  // conflicted page cannot be trashed; stale page rev refreshes once and retries
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  srv.pg("page-shaft").rev = 9;
  A.core.edit("page-shaft", { text: "local" });
  A.timers.runAll();
  await settle();
  assert.ok(A.core.entry("page-shaft").conflict);
  await assert.rejects(A.core.trashPage("page-shaft"), /conflit/);
  assert.equal(srv.pg("page-shaft").deleted_at, null);
  // clean page changed elsewhere (stale rev): refresh + retry
  srv.pg("page-idea").rev = 5;
  srv.pg("page-idea").content.blocks[0].text = "remote idea";
  assert.ok(await A.core.trashPage("page-idea"));
  assert.ok(srv.pg("page-idea").deleted_at != null);
  ok("trash around conflict / stale rev");
}
// ================================================================ AUDIT HIGH 1: permanent delete never crosses a conflict
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  await A.core.trashPage("page-idea"); // rev 2, trashed
  const e = A.core.entry("page-idea");
  const confirmedRev = e.latest.rev;
  assert.equal(confirmedRev, 2);
  // another device: restore, edit, re-trash -> rev 5 with NEW content
  srv.remote({ action: "page_restore", id: "page-idea", expected_rev: 2 });
  srv.remote({ action: "page_save", id: "page-idea", expected_rev: 3, content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "newer remote content", marks: [] }] } });
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 4 });
  assert.equal(srv.pg("page-idea").rev, 5);
  const before = srv.calls.filter((c) => c.payload && c.payload.action === "page_delete_permanent").length;
  await assert.rejects(A.core.deletePermanent("page-idea", confirmedRev), (err) => err.data && err.data.code === "delete_stale");
  const sent = srv.calls.filter((c) => c.payload && c.payload.action === "page_delete_permanent");
  assert.equal(sent.length - before, 1, "exactly one delete request; NO automatic retry");
  assert.equal(sent.at(-1).payload.expected_rev, 2, "the request carried the confirmed revision");
  assert.ok(srv.pg("page-idea"), "page still exists");
  assert.equal(e.latest.rev, 5, "authoritative state refreshed");
  assert.equal(e.local.text, "newer remote content", "refreshed current content shown");
  // the old confirmation stays invalid without contacting the server
  await assert.rejects(A.core.deletePermanent("page-idea", confirmedRev), (err) => err.data.code === "delete_stale");
  assert.equal(srv.calls.filter((c) => c.payload && c.payload.action === "page_delete_permanent").length, sent.length, "stale confirmation never re-sent");
  // a NEW human confirmation of the current revision is required, then succeeds
  assert.ok(await A.core.deletePermanent("page-idea", e.latest.rev));
  assert.equal(srv.pg("page-idea"), undefined, "only the reconfirmed rev 5 is deleted");
  ok("permanent delete: no retry across 409, reconfirmation required");
}
{
  // notebook-level conflict is not retried either
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  await A.core.trashPage("page-idea");
  const rev = A.core.entry("page-idea").latest.rev;
  srv.remote({ action: "project_create", name: "x" }); // unrelated structural change
  const n0 = srv.calls.filter((c) => c.payload && c.payload.action === "page_delete_permanent").length;
  await assert.rejects(A.core.deletePermanent("page-idea", rev), (err) => err.data.code === "delete_stale");
  assert.equal(srv.calls.filter((c) => c.payload && c.payload.action === "page_delete_permanent").length - n0, 1);
  assert.ok(srv.pg("page-idea"));
  assert.ok(await A.core.deletePermanent("page-idea", A.core.entry("page-idea").latest.rev));
  ok("permanent delete: notebook conflict needs reconfirmation");
}

// ================================================================ AUDIT HIGH 2: authoritative lifecycle
// A. dirty local page + remote trash + poll
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.select("page-idea");
  srv.offline = true;
  A.core.edit("page-idea", { text: "dirty idea" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 1 });
  await A.core.poll();
  const e = A.core.entry("page-idea");
  assert.equal(e.local.text, "dirty idea", "local draft text survives");
  assert.ok(draftsOf(st)["page-idea"], "draft kept");
  assert.ok(A.core.isTrashed(e), "authoritative deleted state advanced");
  assert.equal(A.core.edit("page-idea", { text: "more" }), false, "read-only immediately");
  assert.ok(!A.core.st.order.includes("page-idea"), "left the active pages");
  const trash = C.selectPages(A.core.libraryItems(), { filter: "trash" }, 0).groups[0].items.map((i) => i.id);
  assert.deepEqual(trash, ["page-idea"], "appears in Corbeille");
  assert.equal(A.core.st.currentId, "page-idea", "the open page stays visible (read-only)");
  assert.equal(A.core.status().text, C.MSG.trashedDraft, "status is truthful, never Enregistrement…");
  const saves = srv.saves().length;
  A.timers.runAll();
  A.core.retryAll();
  await A.core.flushAll();
  await settle();
  assert.equal(srv.saves().length, saves, "no autosave while trashed");
  assert.ok(srv.pg("page-idea").deleted_at != null);
  ok("A: remote trash of a dirty page");
}
// B. recovered trashed page + remote restore + poll
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "draft B" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 1 });
  const n0 = srv.saves().length; // offline attempts before the reload
  const B = make(srv, st); // reload: recovered draft of a trashed page
  await B.core.load();
  await settle();
  const e = B.core.entry("page-idea");
  assert.ok(B.core.isTrashed(e) && B.core.isDirty(e));
  assert.equal(srv.saves().length, n0, "no save of a trashed page after reload");
  srv.remote({ action: "page_restore", id: "page-idea", expected_rev: 2 }); // restored elsewhere, rev 3
  await B.core.poll();
  await settle();
  assert.equal(B.core.isTrashed(e), false, "authoritative active state advanced");
  assert.ok(B.core.st.order.includes("page-idea"), "back among active pages");
  await assert.rejects(B.core.restorePage("page-idea"), /non supprimée/, "stale Restore no longer offered");
  assert.equal(srv.calls.filter((c) => c.payload && c.payload.action === "page_restore").length, 0, "no restore sent against a restored page");
  assert.equal(srv.pg("page-idea").content.blocks[0].text, "draft B", "draft resumed automatically (content was unchanged remotely)");
  assert.equal(srv.saves().at(-1).payload.expected_rev, 3, "rebased on the restored rev");
  assert.equal(B.core.isDirty(e), false);
  ok("B: remote restore of a recovered trashed draft");
}
{
  // B': remote content changed before trash -> restore never overwrites it silently
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "my offline words" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.remote({ action: "page_save", id: "page-idea", expected_rev: 1, content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "other device words", marks: [] }] } });
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 2 });
  await A.core.poll();
  const e = A.core.entry("page-idea");
  assert.ok(A.core.isTrashed(e));
  srv.remote({ action: "page_restore", id: "page-idea", expected_rev: 3 });
  await A.core.poll();
  await settle();
  assert.ok(e.conflict, "different remote content -> explicit version choice (409 guard kept)");
  assert.equal(srv.pg("page-idea").content.blocks[0].text, "other device words", "newer remote content not overwritten");
  assert.equal(e.local.text, "my offline words", "local draft protected");
  ok("B': remote restore keeps 409 protection");
}
// C. local Restore with a recovered dirty draft: save resumes by itself (no retryAll)
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "offline words" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 1 }); // rev 2
  const n0 = srv.saves().length;
  const B = make(srv, st); // reload
  await B.core.load();
  await settle();
  const e = B.core.entry("page-idea");
  assert.equal(e.local.text, "offline words", "draft text kept");
  assert.ok(B.core.isTrashed(e));
  assert.ok(!B.core.st.order.includes("page-idea"), "recovered trashed draft waits in Corbeille");
  assert.equal(srv.saves().length, n0, "nothing saved while trashed");
  const trashedRev = srv.pg("page-idea").rev; // 2
  assert.ok(await B.core.restorePage("page-idea"));
  const restoreRev = trashedRev + 1; // page_restore bumps the rev once
  await settle();
  assert.equal(srv.pg("page-idea").rev, restoreRev + 1, "exactly one content save after the restore");
  const last = srv.saves().at(-1);
  assert.ok(last, "save scheduled automatically after restore");
  assert.equal(last.payload.expected_rev, restoreRev, "restored rev is the save base");
  assert.equal(last.payload.content.blocks[0].text, "offline words");
  assert.equal(srv.pg("page-idea").content.blocks[0].text, "offline words");
  assert.equal(B.core.isDirty(e), false);
  assert.deepEqual(draftsOf(st), {}, "draft cleared once safely saved");
  assert.notEqual(B.core.status().text, C.MSG.saving);
  ok("C: local restore resumes the recovered draft");
}
{
  // C': restore when the base is unknown/changed -> scheduled save meets the 409 guard (never stuck)
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "offline words" });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  srv.remote({ action: "page_save", id: "page-idea", expected_rev: 1, content: { version: 1, blocks: [{ id: "block-idea", type: "text", text: "remote edit", marks: [] }] } });
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 2 });
  const B = make(srv, st);
  await B.core.load();
  await settle();
  await B.core.restorePage("page-idea");
  await settle();
  const e = B.core.entry("page-idea");
  assert.ok(e.conflict, "save attempted automatically and stopped at the conflict guard");
  assert.equal(srv.pg("page-idea").content.blocks[0].text, "remote edit");
  B.core.select("page-idea");
  assert.equal(B.core.status().text, C.MSG.conflictStatus, "truthful status, not Enregistrement…");
  await B.core.keepLocal("page-idea");
  await settle();
  assert.equal(srv.pg("page-idea").content.blocks[0].text, "offline words", "explicit choice applies");
  ok("C': restore with changed remote content");
}
// ================================================================ AUDIT HIGH 3: exact draft-base equivalence (no hash)
const SAVE = (text) => ({ version: 1, blocks: [{ id: "block-idea", type: "text", text, marks: [] }] });
/** Recovered dirty draft of page-idea based on rev 1, then the page is trashed elsewhere. */
async function recoveredTrashed({ baseText = "VfFlTvt5Gv", draftText = "my local draft", remoteText = null, remotePin = null, mutateDraft = null } = {}) {
  const srv = fakeServer();
  srv.pg("page-idea").content.blocks[0].text = baseText;
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: draftText });
  A.timers.runAll();
  await settle();
  srv.offline = false;
  let rev = 1;
  if (remoteText !== null || remotePin !== null) {
    const p = { action: "page_save", id: "page-idea", expected_rev: rev, content: SAVE(remoteText !== null ? remoteText : baseText) };
    if (remotePin !== null) p.pinned = remotePin;
    srv.remote(p);
    rev += 1;
  }
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: rev });
  if (mutateDraft) {
    const all = JSON.parse(st.m.get(C.draftKey("admin-test")));
    mutateDraft(all.pages["page-idea"]);
    st.m.set(C.draftKey("admin-test"), JSON.stringify(all));
  }
  const B = make(srv, st); // reload
  await B.core.load();
  await settle();
  return { srv, st, B, e: B.core.entry("page-idea") };
}
async function remoteRestoreAndPoll(ctx) {
  ctx.srv.remote({ action: "page_restore", id: "page-idea", expected_rev: ctx.srv.pg("page-idea").rev });
  await ctx.B.core.poll();
  await settle();
}
// A. the audit's FNV collision: never rebased, conflict protection instead
{
  const ctx = await recoveredTrashed({ baseText: "VfFlTvt5Gv", remoteText: "ql7bKb34bF" });
  await remoteRestoreAndPoll(ctx);
  assert.ok(ctx.e.conflict, "colliding remote content -> 409 conflict protection");
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "ql7bKb34bF", "remote text not silently overwritten");
  assert.equal(ctx.e.local.text, "my local draft", "local draft protected");
  // the same through a LOCAL restore
  const c2 = await recoveredTrashed({ baseText: "VfFlTvt5Gv", remoteText: "ql7bKb34bF" });
  await c2.B.core.restorePage("page-idea");
  await settle();
  assert.ok(c2.e.conflict);
  assert.equal(c2.srv.pg("page-idea").content.blocks[0].text, "ql7bKb34bF");
  ok("exact base: audit collision never rebases");
}
// B. exact same base text + pin -> safe rebase, draft resumes
{
  const ctx = await recoveredTrashed({ baseText: "VfFlTvt5Gv" });
  const draft = draftsOf(ctx.st)["page-idea"];
  assert.deepEqual(draft.base, { version: 1, text: "VfFlTvt5Gv", pinned: false }, "exact base snapshot persisted");
  assert.equal("base_sig" in draft, false, "no hash signature persisted");
  await remoteRestoreAndPoll(ctx);
  assert.equal(ctx.e.conflict, null);
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "my local draft", "draft resumed");
  assert.equal(ctx.srv.saves().at(-1).payload.expected_rev, 3, "rebased onto the restored rev");
  ok("exact base: identical content rebases");
}
// C. same text, different pin -> not equivalent
{
  const ctx = await recoveredTrashed({ baseText: "VfFlTvt5Gv", remotePin: true });
  await remoteRestoreAndPoll(ctx);
  assert.ok(ctx.e.conflict, "pin changed remotely -> conflict path");
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "VfFlTvt5Gv");
  assert.equal(ctx.srv.pg("page-idea").pinned, true);
  ok("exact base: pin difference is not equivalent");
}
// D. malformed base records fail closed
for (const [label, bad] of [
  ["missing version", { text: "VfFlTvt5Gv", pinned: false }],
  ["unknown version", { version: 2, text: "VfFlTvt5Gv", pinned: false }],
  ["missing text", { version: 1, pinned: false }],
  ["non-string text", { version: 1, text: 42, pinned: false }],
  ["missing pinned", { version: 1, text: "VfFlTvt5Gv" }],
  ["non-boolean pinned", { version: 1, text: "VfFlTvt5Gv", pinned: "false" }],
  ["oversized text", { version: 1, text: "é".repeat(30000), pinned: false }],
  ["extra keys", { version: 1, text: "VfFlTvt5Gv", pinned: false, rev: 1 }],
  ["not an object", "VfFlTvt5Gv"],
]) {
  const ctx = await recoveredTrashed({ baseText: "VfFlTvt5Gv", mutateDraft: (d) => { d.base = bad; } });
  assert.equal(ctx.e.local.text, "my local draft", `${label}: draft still recovered`);
  await remoteRestoreAndPoll(ctx);
  assert.ok(ctx.e.conflict, `${label}: fails closed -> conflict path`);
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "VfFlTvt5Gv", `${label}: remote untouched`);
}
ok("exact base: malformed records fail closed");
// E. legacy base_sig-only draft: recoverable, signature never trusted
{
  const ctx = await recoveredTrashed({
    baseText: "VfFlTvt5Gv",
    mutateDraft: (d) => { delete d.base; d.base_sig = "12:6ca6bb6b"; },
  });
  assert.equal(ctx.e.local.text, "my local draft", "legacy draft recoverable");
  await remoteRestoreAndPoll(ctx);
  assert.ok(ctx.e.conflict, "legacy signature never trusted -> conflict path");
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "VfFlTvt5Gv");
  await ctx.B.core.keepLocal("page-idea");
  await settle();
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "my local draft", "explicit choice still works");
  ok("exact base: legacy base_sig ignored");
}
// G. remote trash + remote restore happen BEFORE this browser reloads (audit MEDIUM)
async function restoredBeforeReload({ remoteText = null, remotePin = null } = {}) {
  const srv = fakeServer();
  srv.pg("page-idea").content.blocks[0].text = "A";
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  A.core.edit("page-idea", { text: "my local draft" }); // dirty draft based on rev 1, text "A"
  A.timers.runAll();
  await settle();
  srv.offline = false;
  let rev = 1;
  if (remoteText !== null || remotePin !== null) {
    const p = { action: "page_save", id: "page-idea", expected_rev: rev, content: SAVE(remoteText !== null ? remoteText : "A") };
    if (remotePin !== null) p.pinned = remotePin;
    srv.remote(p);
    rev += 1;
  }
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: rev });
  srv.remote({ action: "page_restore", id: "page-idea", expected_rev: rev + 1 });
  const before = srv.saves().length;
  const B = make(srv, st); // only now does this browser reload
  await B.core.load();
  await settle();
  return { srv, st, B, e: B.core.entry("page-idea"), newSaves: srv.saves().slice(before) };
}
{
  const ctx = await restoredBeforeReload();
  assert.equal(ctx.srv.pg("page-idea").rev, 4, "server: trash rev 2, restore rev 3, our save rev 4");
  assert.equal(ctx.e.conflict, null, "identical base -> no needless conflict");
  assert.equal(ctx.newSaves.length, 1, "exactly one automatic save after reload");
  assert.equal(ctx.newSaves[0].payload.expected_rev, 3, "save uses the restored rev");
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "my local draft");
  assert.equal(ctx.B.core.isDirty(ctx.e), false);
  assert.deepEqual(draftsOf(ctx.st), {});
  ok("exact base: remote restore before reload rebases");
}
for (const [label, opts] of [["text differs", { remoteText: "B" }], ["pin differs", { remotePin: true }]]) {
  const ctx = await restoredBeforeReload(opts);
  assert.ok(ctx.e.conflict, `${label}: normal conflict after reload`);
  assert.equal(ctx.newSaves.length, 1, `${label}: one save attempt, refused by 409`);
  assert.equal(ctx.newSaves[0].payload.expected_rev, 1, `${label}: base not advanced`);
  const pg = ctx.srv.pg("page-idea");
  assert.equal(pg.content.blocks[0].text, opts.remoteText || "A", `${label}: remote text untouched`);
  assert.equal(pg.pinned, !!opts.remotePin, `${label}: remote pin untouched`);
  assert.equal(ctx.e.local.text, "my local draft", `${label}: local draft protected`);
  assert.ok(draftsOf(ctx.st)["page-idea"], `${label}: draft kept`);
}
ok("exact base: remote restore before reload with changed content conflicts");

// F. exact base survives reload(s) and keeps the restore behaviour
{
  const ctx = await recoveredTrashed({ baseText: "VfFlTvt5Gv" });
  const C2 = make(ctx.srv, ctx.st); // second reload
  await C2.core.load();
  await settle();
  assert.deepEqual(draftsOf(ctx.st)["page-idea"].base, { version: 1, text: "VfFlTvt5Gv", pinned: false }, "base survives reload");
  await C2.core.restorePage("page-idea");
  await settle();
  const e = C2.core.entry("page-idea");
  assert.equal(e.conflict, null);
  assert.equal(ctx.srv.pg("page-idea").content.blocks[0].text, "my local draft");
  assert.deepEqual(draftsOf(ctx.st), {});
  ok("exact base: survives reload");
}
{
  // quota semantics: a failed write of the (larger) record is reported, never silently "safe"
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  srv.offline = true;
  const set = st.setItem.bind(st);
  st.setItem = (k, v) => { if (String(v).length > 200) throw new Error("quota"); return set(k, v); };
  A.core.edit("page-shaft", { text: "x" });
  assert.equal(A.drafts.failed, true, "storage failure reported");
  assert.equal(A.core.isDirty(A.core.entry("page-shaft")), true);
  ok("exact base: quota failure stays visible");
}

// D. in-flight save around a remote trash
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  A.core.select("page-idea");
  A.core.edit("page-idea", { text: "in flight" });
  srv.hold = true;
  A.timers.runAll();
  await settle();
  A.core.edit("page-idea", { text: "in flight + newer" });
  srv.remote({ action: "page_trash", id: "page-idea", expected_rev: 1 }); // lands first
  await A.core.poll(); // lifecycle advances while the save is still in flight
  const e = A.core.entry("page-idea");
  assert.ok(A.core.isTrashed(e), "trashed while in flight");
  srv.hold = false;
  srv.release(); // save -> 409 with the trashed page
  await settle();
  assert.equal(e.conflict, null, "no fake conflict prompt on a trashed page");
  assert.ok(A.core.isTrashed(e), "late response cannot reactivate the page");
  assert.equal(e.local.text, "in flight + newer", "newest local text kept");
  assert.equal(draftsOf(st)["page-idea"].content.blocks[0].text, "in flight + newer", "draft kept");
  assert.equal(A.core.edit("page-idea", { text: "x" }), false, "still read-only");
  const n = srv.saves().length;
  A.timers.runAll();
  await settle();
  assert.equal(srv.saves().length, n, "no further autosave while trashed");
  assert.ok(srv.pg("page-idea").deleted_at != null && srv.pg("page-idea").content.blocks[0].text === "Try a split clamp instead");
  // keep-local cannot be used to write into a trashed page
  await A.core.keepLocal("page-idea");
  assert.equal(srv.saves().length, n);
  ok("D: in-flight save vs remote trash");
}

// ================================================================ SEARCH (pure)
{
  const items = [
    { id: "p-a", title: "Ébauche moteur", body: "diamètre arbre", context: "Fixture redesign Mesures", pinned: false, updated: 10 },
    { id: "p-b", title: "Notes", body: "voir ébauche", context: "", pinned: false, updated: 50 },
    { id: "p-c", title: "Divers", body: "rien", context: "Fixture redesign", pinned: true, updated: 5 },
    { id: "p-d", title: "ÉBAUCHE châssis", body: "", context: "", pinned: true, updated: 1 },
    { id: "p-e", title: "<img src=x onerror=alert(1)>", body: "<b>bold</b>", context: "", pinned: false, updated: 2 },
  ];
  assert.equal(C.fold("Ébauche Œuvre"), "ebauche oeuvre");
  assert.deepEqual(C.searchPages(items, "ebauche").map((x) => x.id), ["p-d", "p-a", "p-b"], "title > (pinned tie-break) > body");
  assert.deepEqual(C.searchPages(items, "EBAUCHE").map((x) => x.id), ["p-d", "p-a", "p-b"], "case folding");
  assert.deepEqual(C.searchPages(items, "diametre").map((x) => x.id), ["p-a"], "accent folding in body");
  assert.deepEqual(C.searchPages(items, "mesures").map((x) => x.id), ["p-a"], "category search");
  assert.deepEqual(C.searchPages(items, "fixture").map((x) => x.id), ["p-c", "p-a"], "project search: pinned first");
  assert.deepEqual(C.searchPages(items, "ebauche moteur").map((x) => x.id), ["p-a"], "all tokens required");
  assert.deepEqual(C.searchPages(items, "moteur arbre").map((x) => x.id), ["p-a"]);
  assert.deepEqual(C.searchPages(items, "onerror").map((x) => x.id), ["p-e"], "HTML-looking text is plain text");
  assert.deepEqual(C.searchPages(items, "   "), []);
  // determinism: recency then id tie-break
  const tie = [{ id: "b", title: "x", body: "", context: "", pinned: false, updated: 1 }, { id: "a", title: "x", body: "", context: "", pinned: false, updated: 1 },
    { id: "c", title: "x", body: "", context: "", pinned: false, updated: 2 }];
  assert.deepEqual(C.searchPages(tie, "x").map((x) => x.id), ["c", "a", "b"]);
  assert.equal(C.derivePreview("  Titre \n\n a  b \n c"), "a b c");
  assert.equal(C.deriveTitle("   \n"), "Page sans titre");
  ok("search ranking/folding");
}

// ================================================================ RECENTS (pure, local calendar)
{
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0).getTime() / 1000;
  const now = new Date(2026, 8, 30, 10, 0).getTime(); // Wednesday 30 Sept 2026 10:00 local
  assert.equal(C.recencyBucket(at(2026, 9, 30, 0, 0), now), "today", "local midnight is today");
  assert.equal(C.recencyBucket(at(2026, 9, 29, 23, 59), now), "yesterday");
  assert.equal(C.recencyBucket(at(2026, 9, 29, 0, 0), now), "yesterday");
  assert.equal(C.recencyBucket(at(2026, 9, 28, 23, 59), now), "week", "Monday of this week");
  assert.equal(C.recencyBucket(at(2026, 9, 28, 0, 0), now), "week");
  assert.equal(C.recencyBucket(at(2026, 9, 27, 23, 59), now), "older", "Sunday before is older");
  assert.equal(C.recencyBucket(at(2026, 10, 1, 9, 0), now), "today", "future skew counts as today");
  assert.equal(C.recencyBucket(null, now), "older");
  // Monday: yesterday (Sunday) is Hier, never Cette semaine
  const mon = new Date(2026, 8, 28, 8, 0).getTime();
  assert.equal(C.recencyBucket(at(2026, 9, 27, 12, 0), mon), "yesterday");
  assert.equal(C.recencyBucket(at(2026, 9, 26, 12, 0), mon), "older");
  // DST end (America/Toronto 1 Nov 2026) — 25-hour day: every hour lands in exactly one bucket
  const dstNow = new Date(2026, 10, 2, 9, 0).getTime(); // Monday 2 Nov
  let prev = null;
  const seen = [];
  for (let h = 0; h < 24 * 4; h += 1) {
    const ts = dstNow / 1000 - h * 3600;
    const b = C.recencyBucket(ts, dstNow);
    if (b !== prev) seen.push(b);
    prev = b;
  }
  assert.deepEqual(seen, ["today", "yesterday", "older"], "monotonic buckets across DST");
  const items = [
    { id: "a", updated: at(2026, 9, 30, 9) }, { id: "b", updated: at(2026, 9, 29, 9) },
    { id: "c", updated: at(2026, 9, 28, 9) }, { id: "d", updated: at(2026, 9, 1, 9) }, { id: "e", updated: at(2026, 9, 30, 8) },
  ];
  const g = C.groupRecents(items, now);
  assert.deepEqual(g.map((x) => x.label), ["Aujourd'hui", "Hier", "Cette semaine", "Plus ancien"]);
  assert.deepEqual(g.map((x) => x.items.map((i) => i.id)), [["a", "e"], ["b"], ["c"], ["d"]]);
  assert.equal(g.reduce((s, x) => s + x.items.length, 0), items.length, "no duplicate/missing");
  ok("recents buckets");
}

// ================================================================ selectPages filters (pure)
{
  const items = [
    { id: "1", title: "a", body: "", context: "", pinned: true, updated: 3, project_id: "proj-x", category_id: null, deleted: false },
    { id: "2", title: "b", body: "", context: "", pinned: false, updated: 9, project_id: null, category_id: null, deleted: false },
    { id: "3", title: "c", body: "", context: "", pinned: false, updated: 5, project_id: null, category_id: "cat-y", deleted: false },
    { id: "4", title: "d", body: "", context: "", pinned: false, updated: 7, project_id: null, category_id: null, deleted: true, deleted_at: 8 },
  ];
  const ids = (r) => r.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids(C.selectPages(items, { filter: "all" }, 0)), ["1", "2", "3"], "Toutes: pinned first then recency, no trash");
  assert.deepEqual(ids(C.selectPages(items, { filter: "pinned" }, 0)), ["1"]);
  assert.deepEqual(ids(C.selectPages(items, { filter: "unfiled" }, 0)), ["2"], "À classer = no project and no category");
  assert.deepEqual(ids(C.selectPages(items, { filter: "trash" }, 0)), ["4"], "Corbeille separate");
  assert.deepEqual(ids(C.selectPages(items, { filter: "project", id: "proj-x" }, 0)), ["1"]);
  assert.deepEqual(ids(C.selectPages(items, { filter: "category", id: "cat-y" }, 0)), ["3"]);
  assert.deepEqual(ids(C.selectPages(items, { filter: "trash", query: "d" }, 0)), ["4"], "search inside trash");
  assert.deepEqual(ids(C.selectPages(items, { filter: "all", query: "d" }, 0)), [], "trash excluded from normal search");
  ok("filters");
}

// ================================================================ library view model uses effective org
{
  const srv = fakeServer();
  const A = make(srv, memStorage());
  await A.core.load();
  const it = A.core.libraryItems().find((x) => x.id === "page-shaft");
  assert.equal(it.title, "Shaft inspection");
  assert.equal(it.preview, "Ø12.034 mm Check bearing preload");
  assert.equal(it.project, "Fixture redesign");
  assert.equal(it.category, "Mesures");
  assert.equal(it.pinned, true);
  assert.equal(it.updated, 1790680300);
  ok("library items");
}

console.log(`hq carnet library checks ok (${n} groups)`);
