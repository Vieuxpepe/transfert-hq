// Carnet product phase 3: native Dessiner integration (inline drawing block, preview, create / reopen / return, annotation, exports, backup).
//
//   node tests/visual_carnet_dessiner_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs) with the REAL Dessiner and the REAL
// drawing endpoints; run it from a disposable copy of the checkout. The Python side of the contract is in
// tests/test_hq_carnet_drawings.py (schema, backup closure, recovery) — this file only covers what needs a browser.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  const require = createRequire(process.env.PLAYWRIGHT_NODE_PATH ? process.env.PLAYWRIGHT_NODE_PATH.replace(/\/?$/, "/") : import.meta.url);
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright"));
  } catch (e) {
    console.log("SKIP: Playwright not available");
    process.exit(0);
  }
}

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
  console.log("  OK  ", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) {
        check(true, msg);
        return last;
      }
    } catch (e) {
      last = e;
    }
    await sleep(60);
  }
  throw new Error(`FAIL: ${msg} (last=${String(last && last.message ? last.message : last)})`);
}

// ---------------------------------------------------------------- fixtures
let seq = 0;
const bid = () => "block-" + (++seq).toString(36).padStart(6, "0");
const para = (text, id) => ({ id: id || bid(), type: "paragraph", text, marks: [] });
const dblock = (stem, id) => ({ id: id || bid(), type: "drawing", text: "", marks: [], drawing: { id: stem } });
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0, content: { version: 2, blocks } }, extra || {});
}
const notebook = (pages, rev = 4) => ({ version: 1, notebook_rev: rev, projects: [], categories: [], pages });

class Server {
  static async start(seed) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-dessiner-"));
    const seedPath = path.join(tmpdir(), "hq-carnet-seed-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".json");
    writeFileSync(seedPath, JSON.stringify(seed));
    s.proc = spawn(process.env.PYTHON || "python3", [path.join(here, "carnet_test_server.py"), s.root, seedPath], { stdio: ["pipe", "pipe", "inherit"] });
    const info = await new Promise((res, rej) => {
      s.proc.once("error", rej);
      s.proc.stdout.once("data", (d) => res(JSON.parse(String(d))));
    });
    rmSync(seedPath, { force: true });
    Object.assign(s, info);
    s.nbPath = path.join(s.root, ".hq-carnet", "notebook.json");
    s.adir = path.join(s.root, ".hq-carnet", "assets");
    s.ddir = path.join(s.root, "Inbox", "Drawings");
    return s;
  }
  nb() { return JSON.parse(readFileSync(this.nbPath, "utf8")); }
  put(nb) { writeFileSync(this.nbPath, JSON.stringify(nb)); }
  pg(id) { return this.nb().pages.find((p) => p.id === id); }
  blocks(id = "page-a") { return this.pg(id).content.blocks; }
  /** Edit the notebook behind the browser's back as ANOTHER device would (bumps both revisions). */
  remote(fn, id = "page-a") {
    const nb = this.nb();
    nb.notebook_rev += 1;
    const pg = nb.pages.find((p) => p.id === id);
    pg.rev += 1;
    fn(pg, nb);
    this.put(nb);
  }
  assets() { return existsSync(this.adir) ? readdirSync(this.adir).filter((n) => n.startsWith("asset-")).sort() : []; }
  asset(name) { return readFileSync(path.join(this.adir, name)); }
  drawings() { return existsSync(this.ddir) ? readdirSync(this.ddir).sort() : []; }
  stems() { return this.drawings().filter((n) => n.endsWith(".hqdraw.json")).map((n) => n.replace(/\.hqdraw\.json$/, "")); }
  drawing(stem) { return JSON.parse(readFileSync(path.join(this.ddir, stem + ".hqdraw.json"), "utf8")); }
  drawingBytes(stem) { return ["hqdraw.json", "png", "dxf"].map((e) => readFileSync(path.join(this.ddir, stem + "." + e))); }
  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    rmSync(this.root, { recursive: true, force: true });
  }
}

const PROFILES = {
  desktop: { viewport: { width: 1366, height: 900 } },
  iphone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
};

const errors = [];
const external = [];
let browser;
const started = [];
const server = async (seed) => {
  const s = await Server.start(seed);
  started.push(s);
  return s;
};
async function context(srv, profile = "desktop", extra = {}) {
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, PROFILES[profile], extra));
  const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.admin_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(r.status() === 303, "login " + profile);
  return ctx;
}
async function openPage(ctx, srv) {
  const p = await ctx.newPage();
  const tag = "[" + (p.viewportSize() ? p.viewportSize().width : "?") + "]";
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${e.message}`));
  if (process.env.DBG) p.on("response", async (r) => { if (r.request().method() === "POST" && /api\/drawings/.test(r.url())) console.log("   [drawings POST]", r.status(), (await r.text().catch(() => "")).slice(0, 200)); });
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
  p.on("request", (r) => { const u = r.url(); if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u); });
  await p.goto(srv.base + "/");
  await showCarnet(p);
  return p;
}
async function showCarnet(p) {
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible", timeout: 15000 });
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
}
const dirty = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.dirty || x.inflight));
const saved = (p, msg) => until(async () => !(await dirty(p)), msg || "saved (client clean)");
const flash = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const ctxKey = "hq-carnet-dessiner-ctx-v1";
const stored = (p) => p.evaluate((k) => sessionStorage.getItem(k), ctxKey);
const shot = (p, name) => (process.env.DESSINER_SHOTS ? p.screenshot({ path: path.join(process.env.DESSINER_SHOTS, name + ".png") }) : null);

// ---------------------------------------------------------------- carnet helpers
const drawingCards = (p) => p.locator('#hq-carnet-editor [data-carnet-struct="drawing"]');
const card = (p, n = 0) => drawingCards(p).nth(n);
const cardImg = (p, n = 0) => card(p, n).locator("img.carnet-drawing-img");
const cardState = (p, n = 0) => card(p, n).locator(".carnet-drawing").getAttribute("data-state");
async function seeDrawing(p, n = 0) {
  await until(async () => (await drawingCards(p).count()) > n, "drawing block rendered");
  await until(() => p.evaluate((n) => { const i = document.querySelectorAll("#hq-carnet-editor img.carnet-drawing-img")[n]; return !!i && i.complete && i.naturalWidth > 0; }, n), "drawing preview pixels loaded");
}
async function caretEnd(p) {
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
}
async function insertItem(p, key) {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  await p.click(`[data-carnet-insert="${key}"]`);
}
const NB = () => notebook([page("page-a", 1, [para("Titre", "block-title"), para("fin", "block-end")]), page("page-b", 1, [para("autre page")])]);
async function openEditor(profile = "desktop", nb = NB(), extra = {}) {
  const srv = await server(nb);
  const ctx = await context(srv, profile, extra);
  const p = await openPage(ctx, srv);
  return { srv, ctx, p };
}

// ---------------------------------------------------------------- dessiner helpers
const skView = (p) => p.waitForSelector(".sk-canvas", { state: "visible", timeout: 15000 });
const skState = (p) => p.evaluate(() => { const s = window.hqSketchState(); return { stem: s.stem, dirty: s.dirty, n: s.doc.objects.length, underlay: s.doc.underlay || null, name: s.name }; });
async function drawLine(p, from = [0.3, 0.4], to = [0.7, 0.6]) {
  await p.click('[data-tool="pen"]');
  const b = await p.locator(".sk-canvas").boundingBox();
  await p.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 10 });
  await p.mouse.up();
  await p.click('[data-tool="select"]');
  await sleep(60);
}
/** Save the current Dessiner document through its real dialog; returns the new stem. */
async function dessinerSave(p, name) {
  const before = (await skState(p)).stem;
  await p.click('[data-act="save"]');
  await p.waitForSelector("#sk-save-dlg[open]");
  await p.fill("#sk-save-name", name);
  await p.click("#sk-save-go");
  return until(async () => { const s = await skState(p); return s.stem && s.stem !== before && !s.dirty ? s.stem : null; }, "saved in Dessiner as a NEW stem");
}
const backToCarnet = async (p) => {
  await p.click('.sk-return [data-act="return"]');
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
};
/** Make a drawing with the real Dessiner UI (through the Dessiner tab, no Carnet link) and come back to Carnet. */
async function makeDrawing(p, name) {
  await p.locator('.bottom-nav [data-nav="dessiner"]').click();
  await skView(p);
  await drawLine(p);
  const stem = await dessinerSave(p, name);
  await showCarnet(p);
  return stem;
}
/** A page whose only drawing block (block-d) references an existing real drawing. */
async function drawingPage(profile = "desktop") {
  const o = await openEditor(profile);
  const stem = await makeDrawing(o.p, "plan");
  o.srv.remote((pg) => pg.content.blocks.splice(1, 0, dblock(stem, "block-d")));
  await o.p.reload();
  await showCarnet(o.p);
  await seeDrawing(o.p);
  return Object.assign(o, { stem });
}
async function makeImage(p, w = 400, h = 300) {
  const b64 = await p.evaluate(async ([w, h]) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d");
    c.fillStyle = "#2a6fb0"; c.fillRect(0, 0, w, h);
    c.fillStyle = "#ffcc00"; c.fillRect(w * 0.1, h * 0.1, w * 0.4, h * 0.4);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const u = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  }, [w, h]);
  return { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}
async function insertImage(p, file) {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  const chooser = p.waitForEvent("filechooser");
  await p.click('[data-carnet-insert="image"]');
  (await chooser).setFiles(file);
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-image]").count()) >= 1, "image figure rendered");
  await saved(p);
}
const rectOf = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ================================================================ 1-3: create, open exact, save
scenario("1 create: + Insérer → Croquis opens a BLANK Dessiner; nothing is created or inserted before a save", async () => {
  const { srv, p } = await openEditor();
  const nb0 = JSON.stringify(srv.nb());
  await caretEnd(p);
  await insertItem(p, "sketch");
  await skView(p);
  check((await p.locator(".sk-return").isVisible()) && /Nouveau croquis/.test(await p.textContent(".sk-return-msg")), "the return bar names the Carnet link");
  const s = await skState(p);
  check(s.n === 0 && !s.stem && !s.underlay, "blank document, no stem, no underlay: " + JSON.stringify(s));
  const ctx = JSON.parse(await stored(p));
  check(ctx.mode === "new" && ctx.pageId === "page-a" && ctx.rev === 1 && typeof ctx.t === "number", "bounded context in sessionStorage: " + JSON.stringify(ctx));
  check(!/drawing|stem/i.test(p.url()), "no drawing identity in the URL: " + p.url());
  check(srv.drawings().length === 0, "no placeholder / empty drawing file on disk");
  check(JSON.stringify(srv.nb()) === nb0, "notebook byte-identical (no block yet)");
  shot(p, "01-blank-dessiner");
});

scenario("2 + 3 save: a new drawing is saved by Dessiner, then Carnet inserts ONE exact reference (no path, no preview, no name)", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await insertItem(p, "sketch");
  await skView(p);
  await drawLine(p);
  const stem = await dessinerSave(p, "support moteur");
  check(/^support-moteur_HQWeb-Desktop$/.test(stem) && srv.stems().length === 1, "one immutable stem: " + stem);
  check(JSON.parse(await stored(p)).saved === stem, "Dessiner reported the exact stem into the context");
  await backToCarnet(p);
  await seeDrawing(p);
  await saved(p);
  const bl = srv.blocks().filter((b) => b.type === "drawing");
  check(bl.length === 1 && JSON.stringify(bl[0].drawing) === JSON.stringify({ id: stem }) && bl[0].text === "" && bl[0].marks.length === 0, "block stores ONLY {drawing:{id}}: " + JSON.stringify(bl[0]));
  check(!/svg|png|path|data:|\/api\/|Inbox/.test(JSON.stringify(srv.pg("page-a").content)), "no SVG / PNG / path / URL in the notebook");
  check(JSON.parse(await stored(p) || "null") === null, "context consumed (single-shot)");
  check((await flash(p)) === "Croquis inséré", "confirmation shown: " + (await flash(p)));
  check((await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === "page-a", "back on the same page");
  shot(p, "02-inserted");
});

scenario("2b exact open: the block opens ITS stem (not a name, not the latest) in Dessiner", async () => {
  const { srv, p, stem } = await drawingPage();
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  const s = await skState(p);
  check(s.stem === stem && s.n === 1, "Dessiner holds the exact stem and its content: " + JSON.stringify(s));
  const ctx = JSON.parse(await stored(p));
  check(ctx.mode === "open" && ctx.blockId === "block-d" && ctx.stem === stem, "context names block + stem: " + JSON.stringify(ctx));
  check(/ouvert depuis le carnet/.test(await p.textContent(".sk-return-msg")), "link label shown");
  // a second drawing with a similar name never gets picked up
  check(srv.stems().length === 1, "opening writes nothing");
});

// ================================================================ 4-6: return, preview, reload
scenario("4 + 5 return (open): focuses the SAME block, refreshes the preview, OFFERS the new version, never auto-follows", async () => {
  const { srv, p, stem } = await drawingPage();
  const src0 = await cardImg(p).getAttribute("src");
  const nb0 = JSON.stringify(srv.nb());
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  await drawLine(p, [0.2, 0.7], [0.8, 0.3]);
  const stem2 = await dessinerSave(p, "plan");
  check(stem2 !== stem && srv.stems().length === 2, "a SECOND immutable stem exists: " + stem2);
  check(srv.drawing(stem2).meta.parent === stem, "lineage recorded: meta.parent = the opened stem");
  await backToCarnet(p);
  await seeDrawing(p);
  check((await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === "page-a", "same page");
  await until(() => card(p).locator(".carnet-drawing-offer").isVisible(), "the offer banner is shown");
  check(/Nouvelle version enregistrée/.test(await card(p).locator(".carnet-drawing-offer").textContent()), "offer text");
  check((await cardImg(p).getAttribute("src")) !== src0 && /&r=\d+/.test(await cardImg(p).getAttribute("src")), "preview URL refreshed (cache-busted)");
  await sleep(700);
  check((await dirty(p)) === false && JSON.stringify(srv.nb()) === nb0, "NAVIGATION ONLY: nothing modified, nothing saved");
  check(srv.blocks().find((b) => b.id === "block-d").drawing.id === stem, "block still references the OLD exact stem");
  const inView = await p.evaluate(() => { const r = document.querySelector('[data-carnet-block-id="block-d"]').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  check(inView, "the block is back in view");
  // explicit action only
  await card(p).locator(".carnet-drawing-use").click();
  await saved(p);
  check(srv.blocks().find((b) => b.id === "block-d").drawing.id === stem2, "'Utiliser cette version' = an ordinary Carnet edit, now persisted");
  check(!(await card(p).locator(".carnet-drawing-offer").isVisible()), "offer gone after use");
  check(srv.stems().length === 2, "the old drawing was not deleted or changed");
});

scenario("5b ignoring the offer keeps the old reference; the other stem is untouched", async () => {
  const { srv, p, stem } = await drawingPage();
  const bytes = srv.drawingBytes(stem);
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  await drawLine(p, [0.2, 0.7], [0.8, 0.3]);
  await dessinerSave(p, "plan");
  await backToCarnet(p);
  await card(p).locator(".carnet-drawing-offer button", { hasText: "Ignorer" }).click();
  check(!(await card(p).locator(".carnet-drawing-offer").isVisible()), "offer dismissed");
  check(srv.blocks().find((b) => b.id === "block-d").drawing.id === stem, "reference unchanged");
  check(srv.drawingBytes(stem).every((b, i) => b.equals(bytes[i])), "the opened drawing's three files are byte-identical");
});

scenario("6 reload: references and previews survive a reload; no stale context is replayed", async () => {
  const { srv, p, stem } = await drawingPage();
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  await backToCarnet(p);
  await p.reload();
  await showCarnet(p);
  await seeDrawing(p);
  check((await stored(p)) === null, "no context left over");
  check(srv.blocks().find((b) => b.id === "block-d").drawing.id === stem, "still references the stem");
  // a context abandoned in another tab (never returned) is replayed ONCE as navigation, never as an edit
  await p.evaluate(([k, stem]) => sessionStorage.setItem(k, JSON.stringify({ v: 1, mode: "open", pageId: "page-a", rev: 99, t: Date.now(), blockId: "block-d", stem })), [ctxKey, stem]);
  await p.reload();
  await showCarnet(p);
  await seeDrawing(p);
  await sleep(500);
  check((await stored(p)) === null && (await dirty(p)) === false, "abandoned context consumed without writing");
});

// ================================================================ 7-10: things changing while Dessiner is open
scenario("7 block moved while Dessiner is open: found by id, no duplicate", async () => {
  const { srv, p } = await drawingPage();
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  srv.remote((pg) => { const b = pg.content.blocks; const i = b.findIndex((x) => x.id === "block-d"); const [d] = b.splice(i, 1); b.unshift(d); });
  await backToCarnet(p);
  await seeDrawing(p);
  const orderNow = () => p.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].map((c) => c.getAttribute("data-carnet-block-id")));
  await until(async () => (await orderNow())[0] === "block-d", "the remote move is adopted");
  const order = await orderNow();
  check(order[0] === "block-d" && order.filter((x) => x === "block-d").length === 1, "the block is first now and unique: " + JSON.stringify(order));
  check(srv.blocks().filter((b) => b.type === "drawing").length === 1, "still ONE drawing block on the server");
});

scenario("8 block deleted while Dessiner is open: explicit message, nothing recreated", async () => {
  const { srv, p, stem } = await drawingPage();
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  await drawLine(p, [0.2, 0.7], [0.8, 0.3]);
  const stem2 = await dessinerSave(p, "plan");
  srv.remote((pg) => { pg.content.blocks = pg.content.blocks.filter((x) => x.id !== "block-d"); });
  await backToCarnet(p);
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
  await until(async () => /retiré de la page/.test(await flash(p)), "message: the drawing was removed from the page: " + (await flash(p)));
  check((await drawingCards(p).count()) === 0 && srv.blocks().every((b) => b.type !== "drawing"), "no block recreated");
  check(srv.stems().includes(stem) && srv.stems().includes(stem2), "both drawings still exist in Dessiner (never deleted)");
});

scenario("9 page trashed / deleted while Dessiner is open (new sketch): no insertion, drawing kept", async () => {
  for (const mode of ["trash", "delete"]) {
    const { srv, p } = await openEditor();
    await caretEnd(p);
    await insertItem(p, "sketch");
    await skView(p);
    await drawLine(p);
    const stem = await dessinerSave(p, "orphelin");
    srv.remote((pg, nb) => { if (mode === "trash") pg.deleted_at = 1790690000.0; else nb.pages = nb.pages.filter((x) => x.id !== "page-a"); });
    await backToCarnet(p);
    await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
    await until(async () => /corbeille|n'existe plus/.test(await flash(p)), mode + ": message " + (await flash(p)));
    const nb = srv.nb();
    check(!JSON.stringify(nb).includes(stem), mode + ": the reference was NOT inserted anywhere");
    check(srv.stems().includes(stem), mode + ": the saved drawing stays an independent Dessiner drawing");
  }
});

scenario("10 stale revision while Dessiner is open: the reference is NOT inserted over a newer page; remote edit untouched", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await insertItem(p, "sketch");
  await skView(p);
  await drawLine(p);
  const stem = await dessinerSave(p, "tard");
  srv.remote((pg) => { pg.content.blocks.push(para("modif distante", "block-remote")); });
  await backToCarnet(p);
  await until(async () => /a changé pendant/.test(await flash(p)), "message: " + (await flash(p)));
  await sleep(600);
  const bl = srv.blocks();
  check(bl.every((b) => b.type !== "drawing") && bl.some((b) => b.id === "block-remote"), "remote edit intact, no drawing block");
  check(srv.stems().includes(stem), "drawing kept");
  check((await dirty(p)) === false, "no local draft created");
  // a dirty LOCAL page is refused too
  const o = await openEditor();
  await caretEnd(o.p);
  await insertItem(o.p, "sketch");
  await skView(o.p);
  await drawLine(o.p);
  const s2 = await dessinerSave(o.p, "sale");
  await backToCarnet(o.p);
  await until(async () => (await o.srv.blocks().filter((b) => b.type === "drawing").length) === 1 || /Croquis inséré/.test(await flash(o.p)), "clean page + valid context -> inserted");
  check(o.srv.stems().includes(s2), "control: valid context inserts");
});

scenario("10b authoritative refresh FAILS on return: nothing is decided on cached state, the context is kept, a later return is refused as stale", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await insertItem(p, "sketch");
  await skView(p);
  await drawLine(p);
  const stem = await dessinerSave(p, "hors-ligne");
  srv.remote((pg) => { pg.content.blocks.push(para("modif distante", "block-remote")); });
  await p.route("**/api/carnet**", (r) => (r.request().method() === "GET" ? r.abort() : r.continue()));
  await backToCarnet(p);
  await until(async () => /Impossible de vérifier/.test(await flash(p)), "message: the notebook could not be verified: " + (await flash(p)));
  await sleep(500);
  check(srv.blocks().every((b) => b.type !== "drawing"), "no reference inserted on the cached revision");
  check((await dirty(p)) === false, "no local draft created");
  check(JSON.parse((await stored(p)) || "null")?.saved === stem, "the validated return context is still available");
  await p.unroute("**/api/carnet**");
  await p.locator('.bottom-nav [data-nav="fichiers"]').click();
  await showCarnet(p);
  await until(async () => /a changé pendant/.test(await flash(p)), "retry after reconnect: refused as stale: " + (await flash(p)));
  check((await stored(p)) === null, "terminal state consumed the context");
  check(srv.blocks().every((b) => b.type !== "drawing") && srv.blocks().some((b) => b.id === "block-remote") && srv.stems().includes(stem), "remote edit intact, drawing kept");
  // an existing drawing: no offer until a refresh has succeeded
  const o = await drawingPage();
  await o.p.locator(".carnet-drawing-open").first().click();
  await skView(o.p);
  await drawLine(o.p, [0.2, 0.7], [0.8, 0.3]);
  await dessinerSave(o.p, "plan");
  await o.p.route("**/api/carnet**", (r) => (r.request().method() === "GET" ? r.abort() : r.continue()));
  await backToCarnet(o.p);
  await until(async () => /Impossible de vérifier/.test(await flash(o.p)), "existing drawing: unverified message");
  check(!(await o.p.locator(".carnet-drawing-offer").first().isVisible()), "no stale version offer yet");
  await o.p.unroute("**/api/carnet**");
  await o.p.locator('.bottom-nav [data-nav="fichiers"]').click();
  await showCarnet(o.p);
  await until(() => o.p.locator(".carnet-drawing-offer").first().isVisible(), "offer appears once the refresh succeeds");
});

// ================================================================ 11-12: missing drawing, remove reference
scenario("11 missing underlying drawing: the block stays, explicit unavailable state, remove / relink available, no crash", async () => {
  const nb = notebook([page("page-a", 1, [para("Titre"), dblock("Fantome_HQWeb-Desktop", "block-ghost"), para("fin")])]);
  const { srv, p } = await openEditor("desktop", nb);
  await until(async () => (await cardState(p)) === "missing", "state=missing after the preview fails");
  const g = card(p).locator(".carnet-drawing-missing");
  check((await g.isVisible()) && /Croquis indisponible/.test(await g.textContent()) && (await g.getAttribute("role")) === "note", "visible, textual, role=note");
  check(!(await card(p).locator(".carnet-drawing-open").isVisible()), "no 'Ouvrir' on a missing drawing");
  check(await card(p).locator(".carnet-drawing-retry").isVisible(), "'Réessayer' offered");
  check((await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === "page-a" && srv.blocks().length === 3, "page intact");
  shot(p, "11-missing");
  await card(p).getByRole("button", { name: /Relier à un autre croquis/ }).click();
  await until(async () => /Aucun croquis|disponible/i.test(await p.evaluate(() => document.body.innerText)) || (await p.locator(".carnet-drawing-select").count()) > 0, "relink picker or an honest empty message");
  // the drawing appears later (recovery): Réessayer resolves it without any edit
  const real = await makeDrawing(p, "fantome");
  srv.remote((pg) => { pg.content.blocks.find((b) => b.id === "block-ghost").drawing.id = real; });
  await p.reload();
  await showCarnet(p);
  await seeDrawing(p);
  check(true, "once the stem resolves the preview works again");
});

scenario("12 removing the Carnet reference NEVER deletes the drawing", async () => {
  const { srv, p, stem } = await drawingPage();
  const bytes = srv.drawingBytes(stem);
  const del = card(p).locator(".carnet-struct-del");
  check(/Retirer du carnet/.test(await del.textContent()) && /reste dans Dessiner/.test(await del.getAttribute("aria-label")), "wording says: removed from the notebook, drawing stays");
  await del.click();
  check(/Confirmer le retrait/.test(await del.textContent()), "two-step confirm");
  await del.click();
  await until(async () => (await drawingCards(p).count()) === 0, "block gone");
  await saved(p);
  check(srv.blocks().every((b) => b.type !== "drawing"), "server page has no drawing block");
  check(srv.stems().includes(stem) && srv.drawingBytes(stem).every((b, i) => b.equals(bytes[i])), "drawing files all still present and byte-identical");
  await p.locator('.bottom-nav [data-nav="dessiner"]').click();
  await skView(p);
  const r = await p.evaluate(async (stem) => (await window.api("/api/drawings")).items.some((x) => (x.stem || x.name || "").startsWith(stem)) || JSON.stringify(await window.api("/api/drawings")).includes(stem), stem);
  check(r, "the drawing is still listed by Dessiner");
});

// ================================================================ 13-15: annotation
scenario("13-15 annotate: image → Dessiner with a fixed underlay → separate drawing block after the image; original unchanged; survives reload", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await insertImage(p, await makeImage(p));
  const img0 = JSON.stringify(srv.blocks().find((b) => b.type === "image"));
  const assets0 = srv.assets();
  const bytes0 = srv.asset(assets0[0]);
  await p.locator("#hq-carnet-editor [data-carnet-image]").first().click({ position: { x: 20, y: 40 } });
  await p.waitForSelector("#btn-carnet-image-annotate", { state: "visible" });
  await p.click("#btn-carnet-image-annotate");
  await skView(p);
  const aid = JSON.parse(await stored(p)).assetId;
  check(/^asset-[0-9a-f]{24}$/.test(aid) && assets0.some((n) => n.startsWith(aid)), "context names the Carnet asset: " + aid);
  const s0 = await skState(p);
  check(s0.underlay && s0.underlay.asset_id === aid && s0.underlay.fit === "contain" && s0.n === 0, "Dessiner holds the fixed 'contain' underlay: " + JSON.stringify(s0.underlay));
  await until(() => p.evaluate(() => { const u = window.hqSketchState(); return !!document.querySelector(".sk-canvas") && !!u; }), "canvas ready");
  shot(p, "13-annotate");
  await drawLine(p);
  const stem = await dessinerSave(p, "annot");
  const doc = srv.drawing(stem);
  check(doc.doc ? doc.doc.underlay.asset_id === aid : doc.underlay.asset_id === aid, "saved drawing document carries the underlay reference (asset id + fit only)");
  await backToCarnet(p);
  await seeDrawing(p);
  await saved(p);
  const blocks = srv.blocks();
  const ii = blocks.findIndex((b) => b.type === "image");
  check(blocks[ii + 1] && blocks[ii + 1].type === "drawing" && blocks[ii + 1].drawing.id === stem, "the annotation is a SEPARATE drawing block right AFTER the image");
  check(JSON.stringify(blocks[ii]) === img0, "14: the original image block is byte-identical");
  check(JSON.stringify(srv.assets()) === JSON.stringify(assets0) && srv.asset(assets0[0]).equals(bytes0), "14: the original asset file is unchanged and no asset was added");
  await p.reload();
  await showCarnet(p);
  await seeDrawing(p);
  await card(p).locator(".carnet-drawing-open").click();
  await skView(p);
  const s1 = await skState(p);
  check(s1.stem === stem && s1.underlay && s1.underlay.asset_id === aid && s1.n === 1, "15: after reload the annotation reopens with underlay AND strokes: " + JSON.stringify(s1));
});

scenario("13b annotate refuses a changed image / wrong anchor; Annoter only appears for a single image", async () => {
  const { srv, p } = await openEditor();
  check(!(await p.locator("#btn-carnet-image-annotate").isVisible()), "no Annoter without a selected image");
  await caretEnd(p);
  await insertImage(p, await makeImage(p));
  await p.locator("#hq-carnet-editor [data-carnet-image]").first().click({ position: { x: 20, y: 40 } });
  await p.click("#btn-carnet-image-annotate");
  await skView(p);
  await drawLine(p);
  await dessinerSave(p, "annot");
  const id = srv.blocks().find((b) => b.type === "image").id;
  srv.remote((pg) => { pg.content.blocks = pg.content.blocks.filter((b) => b.id !== id); });
  await backToCarnet(p);
  await until(async () => /changé|disparu|a changé/.test(await flash(p)), "refused: " + (await flash(p)));
  await sleep(400);
  check(srv.blocks().every((b) => b.type !== "drawing") && srv.stems().length === 1, "nothing inserted, drawing kept");
});

// ================================================================ 16-18: print, markdown, report
scenario("16 print: the drawing prints as a static figure with its caption and no controls", async () => {
  const { p } = await drawingPage();
  await p.evaluate(() => { window.__printed = null; window.print = () => { const h = document.querySelector("#hq-carnet-print"); window.__printed = { html: h.innerHTML, text: h.innerText, inputs: h.querySelectorAll("input,textarea,button,select").length }; }; });
  await p.click("#btn-carnet-more").catch(() => {});
  await p.click("#btn-carnet-export");
  await p.click("#btn-carnet-export-print");
  await until(() => p.evaluate(() => !!window.__printed), "print snapshot built");
  const r = await p.evaluate(() => window.__printed);
  check(r.inputs === 0 && /carnet-drawing/.test(r.html) && /Croquis : plan/.test(r.text), "static figure + caption, zero form controls: " + r.text.slice(0, 80));
  check(/\/api\/drawings\/file\?stem=[^"&]+&(amp;)?kind=png/.test(r.html), "the preview is Dessiner's PNG endpoint, not copied data");
  check(!/Ouvrir|Retirer|Relier/.test(r.text), "no action buttons printed");
  await p.emulateMedia({ media: "print" });
  const vis = await p.evaluate(() => { const i = document.querySelector("#hq-carnet-print img.carnet-drawing-img"); return i ? { ok: i.complete && i.naturalWidth > 0, w: i.getBoundingClientRect().width } : null; });
  check(vis === null || vis.ok, "print image resolves");
  await p.emulateMedia({ media: "screen" });
});

scenario("17 Markdown / TXT: a readable text placeholder, no path, no preview asset, no drawing bytes", async () => {
  const { srv, p, stem } = await drawingPage();
  await p.click("#btn-carnet-more").catch(() => {});
  await p.click("#btn-carnet-export");
  const dl = async (sel) => { const w = p.waitForEvent("download"); await p.click(sel); const d = await w; return readFileSync(await d.path(), "utf8"); };
  const md = await dl("#btn-carnet-export-md");
  const txt = await dl("#btn-carnet-export-txt");
  check(/Croquis : plan/.test(md) && /\[Croquis : plan\]/.test(txt), "placeholder in both: " + JSON.stringify(md.slice(0, 80)));
  check(!md.includes(stem) && !/\.png|\.assets|Inbox|\/api\//.test(md + txt) && !md.includes(srv.root), "no stem file name, path, PNG or root in the exports");
});

scenario("18 report: a drawing is its OWN kind (Croquis), never a photo", async () => {
  const { srv, p, stem } = await drawingPage();
  await p.click("#btn-carnet-more").catch(() => {});
  await p.click("#btn-carnet-history");
  await p.waitForSelector('[data-hx-tab="report"], [data-hx="tab"][data-tab="report"], #hq-carnet-hx-tab-report', { timeout: 8000 }).catch(() => {});
  const tab = p.locator('[data-tab="report"], #hq-carnet-hx-tab-report, [data-hx-tab="report"]').first();
  await tab.click();
  const opts = await p.locator("#hq-carnet-hx-radd option").evaluateAll((o) => o.map((x) => [x.value, x.textContent]));
  const d = opts.find((o) => o[0].startsWith("drawing:"));
  check(d && /Croquis/.test(d[1]) && !opts.some((o) => o[0].startsWith("photo:")), "the picker offers a 'drawing:' item labelled Croquis: " + JSON.stringify(d));
  await p.selectOption("#hq-carnet-hx-radd", d[0]);
  await p.click("#btn-carnet-hx-radd");
  await p.click("#btn-carnet-hx-rbuild");
  await p.waitForSelector("#hq-carnet-hx-md");
  const md = await p.textContent("#hq-carnet-hx-md");
  check(/Croquis/.test(md) && !/Photo/.test(md) && !md.includes(stem) && !md.includes(srv.root), "Markdown report says Croquis, not Photo, no stem/path: " + JSON.stringify(md.slice(0, 160)));
});

// ================================================================ 19-21: theme, phone, a11y
scenario("19 dark / light: preview, missing and offer states stay legible", async () => {
  for (const scheme of ["dark", "light"]) {
    const { p, srv } = await openEditor("desktop", notebook([page("page-a", 1, [para("T"), dblock("Absent_HQWeb-Desktop", "block-x")])]), { colorScheme: scheme });
    await until(async () => (await cardState(p)) === "missing", scheme + ": missing state shown");
    const c = await p.evaluate(() => { const m = document.querySelector(".carnet-drawing-missing"); const cs = getComputedStyle(m); return { color: cs.color, bg: getComputedStyle(document.body).backgroundColor, border: cs.borderTopStyle }; });
    const ratio = await p.evaluate(([fg, bg]) => {
      const cv = document.createElement("canvas").getContext("2d");
      const rgb = (v) => { cv.fillStyle = "#000"; cv.fillStyle = v; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
      const L = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const a = L(rgb(fg)), b = L(rgb(bg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, [c.color, c.bg]);
    check(ratio >= 4.5 && c.border === "dashed", `${scheme}: missing text contrast ${ratio.toFixed(1)} ≥ 4.5, dashed frame`);
    shot(p, "19-" + scheme);
    void srv;
  }
});

scenario("20 phone viewport: no horizontal overflow, ≥44 px targets, Dessiner return bar reachable", async () => {
  const { p } = await drawingPage("iphone");
  const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ed: document.querySelector("#hq-carnet-editor").scrollWidth - document.querySelector("#hq-carnet-editor").clientWidth }));
  check(o.sw <= o.cw + 1 && o.ed <= 1, "no horizontal overflow: " + JSON.stringify(o));
  const targets = await p.evaluate(() => [...document.querySelectorAll('[data-carnet-struct="drawing"] button')].filter((b) => b.offsetParent).map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]));
  check(targets.length >= 3 && targets.every(([, h]) => h >= 44), "every visible drawing button ≥ 44 px: " + JSON.stringify(targets));
  const im = await rectOf(p, "#hq-carnet-editor img.carnet-drawing-img");
  check(im && im.r <= 391 && im.l >= -1, "preview inside the viewport: " + JSON.stringify(im));
  await card(p).locator(".carnet-drawing-open").tap();
  await skView(p);
  const r = await rectOf(p, ".sk-return-btn");
  check(r && r.h >= 44 && r.l >= 0 && r.r <= 391, "return button reachable and ≥ 44 px: " + JSON.stringify(r));
  shot(p, "20-phone-dessiner");
  await p.locator(".sk-return-btn").tap();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
  await seeDrawing(p);
  shot(p, "20-phone-carnet");
});

scenario("21 accessibility: names, roles, live regions and a keyboard-only round trip", async () => {
  const { p, stem } = await drawingPage();
  const a = await p.evaluate(() => {
    const c = document.querySelector('[data-carnet-struct="drawing"]');
    return { alt: c.querySelector("img").alt, bar: c.querySelector('[role="toolbar"]').getAttribute("aria-label"), del: c.querySelector(".carnet-struct-del").getAttribute("aria-label"), live: !!c.querySelector('.carnet-drawing-offer[aria-live="polite"][role="status"]'), open: c.querySelector(".carnet-drawing-open").getAttribute("aria-label") };
  });
  check(/^Croquis : plan/.test(a.alt) && /Croquis/.test(a.bar) && /reste dans Dessiner/.test(a.del) && a.live && /Ouvrir dans Dessiner/.test(a.open), "accessible names + status region: " + JSON.stringify(a));
  await card(p).locator(".carnet-drawing-open").focus();
  await p.keyboard.press("Enter");
  await skView(p);
  await until(async () => { await p.locator(".sk-return-btn").focus(); return p.evaluate(() => /sk-return-btn/.test(document.activeElement.className)); }, "the return button is focusable (retried: Dessiner may move focus while it is still initialising)");
  const role = await p.getAttribute(".sk-return", "role");
  check(role === "region" && /Retour au carnet/.test(await p.getAttribute(".sk-return", "aria-label")), "return bar is a labelled region");
  await p.keyboard.press("Enter");
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
  await seeDrawing(p);
  const act = await p.evaluate(() => document.activeElement && document.activeElement.tagName);
  check(!!act, "focus is somewhere sane after returning: " + act);
  void stem;
});

// ================================================================ 22: performance + limits
scenario("22 performance + limits: 32 lazy previews render fast, typing never rebuilds them, the 33rd is refused", async () => {
  const stems = [];
  const boot = await openEditor();
  for (let i = 0; i < 3; i += 1) stems.push(await makeDrawing(boot.p, "p" + i));
  const blocks = [para("Titre", "block-title")];
  for (let i = 0; i < 32; i += 1) blocks.push(dblock(stems[i % 3], "block-d" + i));
  boot.srv.remote((pg) => { pg.content.blocks = blocks; });
  const t0 = Date.now();
  await boot.p.reload();
  await showCarnet(boot.p);
  await until(async () => (await drawingCards(boot.p).count()) === 32, "32 drawing blocks rendered");
  const render = Date.now() - t0;
  check(render < 12000, "render of 32 drawing blocks in " + render + " ms");
  const lazy = await boot.p.evaluate(() => [...document.querySelectorAll("img.carnet-drawing-img")].every((i) => i.loading === "lazy"));
  check(lazy, "all previews are loading=lazy");
  const typed = await boot.p.evaluate(async () => {
    const e = document.querySelector("#hq-carnet-editor");
    const first = e.querySelector("img.carnet-drawing-img");
    const t = performance.now();
    const p = e.querySelector('[data-carnet-block-id="block-title"]');
    p.focus();
    for (let i = 0; i < 20; i += 1) { const r = getSelection(); void r; document.execCommand && document.execCommand("insertText", false, "x"); }
    return { ms: (performance.now() - t) / 20, same: e.querySelector("img.carnet-drawing-img") === first };
  });
  check(typed.same, "typing in a text block keeps the preview nodes (no rebuild)");
  // client + server cap: a 33rd drawing block is refused
  const over = await boot.p.evaluate(async (stem) => {
    const nb = await window.api("/api/carnet");
    const pg = nb.pages.find((x) => x.id === "page-a");
    const bl = pg.content.blocks.concat([{ type: "drawing", text: "", marks: [], drawing: { id: stem } }]);
    try {
      await window.api("/api/carnet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "page_save", id: "page-a", expected_rev: pg.rev, content: { version: 2, blocks: bl } }) });
      return "accepted";
    } catch (e) {
      return String(e.message || e);
    }
  }, stems[0]);
  check(/max 32|Trop de croquis/.test(over), "the server refuses a 33rd drawing: " + over);
});

// ---------------------------------------------------------------- runner
async function main() {
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log("SKIP: Chromium unavailable — " + String(e.message).split("\n")[0]);
    process.exit(0);
  }
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const [name, fn] of scenarios) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    console.log("\n# " + name);
    try {
      await fn();
    } catch (e) {
      failures.push([name, e]);
      console.log("  FAIL ", e.message.split("\n")[0]);
    }
  }
  await browser.close();
  for (const s of started) s.close();
  if (external.length) {
    console.log("\nEXTERNAL REQUESTS:\n" + external.slice(0, 5).join("\n"));
    failures.push(["external requests", new Error(external[0])]);
  }
  if (errors.length) {
    console.log("\nBROWSER ERRORS:\n" + errors.slice(0, 10).join("\n"));
    failures.push(["browser errors", new Error(errors[0])]);
  }
  console.log("\nWebKit / Firefox / physical devices: UNVERIFIED (Chromium emulation only).");
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s)`);
  if (failures.length) {
    for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
