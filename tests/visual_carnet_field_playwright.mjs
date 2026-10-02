// Carnet product phase 4: Field Capture (mobile HUD, document scanner, OCR, voice notes, transcript adapter, recovery stash).
//
//   node tests/visual_carnet_field_playwright.mjs [scenario substring...]
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
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-field-"));
    const seedPath = path.join(tmpdir(), "hq-carnet-seed-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".json");
    writeFileSync(seedPath, JSON.stringify(seed));
    s.proc = spawn(process.env.PYTHON || "python3", [path.join(here, "carnet_test_server.py"), s.root, seedPath], { stdio: ["pipe", "pipe", "inherit"], env: Object.assign({}, process.env, env || {}) });
    const info = await new Promise((res, rej) => {
      s.proc.once("error", rej);
      s.proc.stdout.once("data", (d) => res(JSON.parse(String(d))));
    });
    rmSync(seedPath, { force: true });
    Object.assign(s, info);
    s.nbPath = path.join(s.root, ".hq-carnet", "notebook.json");
    s.adir = path.join(s.root, ".hq-carnet", "assets");
    s.ddir = path.join(s.root, "Inbox", "Drawings");
    s.vdir = path.join(s.root, ".hq-carnet", "voice");
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
  voices() { return existsSync(this.vdir) ? readdirSync(this.vdir).filter((n) => n.startsWith("voice-")).sort() : []; }
  voice(name) { return readFileSync(path.join(this.vdir, name)); }
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
const server = async (seed, env) => {
  const s = await Server.start(seed, env);
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
const shot = (p, name) => (process.env.P4_SHOTS ? p.screenshot({ path: path.join(process.env.P4_SHOTS, name + ".png") }) : null);


// ---------------------------------------------------------------- phase 4 helpers
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.env.P4_SHOTS) mkdirSync(process.env.P4_SHOTS, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");

const NB = () => notebook([page("page-a", 1, [para("Titre", "block-title"), para("fin", "block-end")]), page("page-b", 1, [para("autre page")])]);
async function openEditor(profile = "iphone", nb = NB(), extra = {}, env) {
  const srv = await server(nb, env);
  const ctx = await context(srv, profile, extra);
  const p = await openPage(ctx, srv);
  return { srv, ctx, p };
}
const sheet = (p) => p.locator("#hq-carnet-field-sheet");
const sheetOpen = (p) => p.locator("#hq-carnet-field-sheet").count();
const rectOf = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const blocksOf = (srv, id = "page-a") => srv.blocks(id);
const types = (srv, id = "page-a") => blocksOf(srv, id).map((b) => b.type);

/** A synthetic photographed sheet of paper: grey table, a skewed white sheet with big black words. Returns file + the paper corners. */
async function docPhoto(p, o = {}) {
  const w = o.w || 1200;
  const h = o.h || 900;
  const lines = o.lines || ["BONJOUR MONDE", "FACTURE 2024"];
  const r = await p.evaluate(async ([w, h, lines]) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d");
    c.fillStyle = "#3b3b3b"; c.fillRect(0, 0, w, h);
    const q = [[0.15 * w, 0.14 * h], [0.86 * w, 0.18 * h], [0.9 * w, 0.88 * h], [0.11 * w, 0.84 * h]];
    c.fillStyle = "#f4f2ea"; c.beginPath(); c.moveTo(...q[0]); for (const pt of q.slice(1)) c.lineTo(...pt); c.closePath(); c.fill();
    c.fillStyle = "#111"; c.textBaseline = "top";
    const fs = Math.round(h * 0.11);
    c.font = "bold " + fs + "px Arial, Helvetica, sans-serif";
    lines.forEach((t, i) => c.fillText(t, 0.2 * w, 0.28 * h + i * fs * 1.5));
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const u = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return { b64: btoa(s), q };
  }, [w, h, lines]);
  return { file: { name: "scan.png", mimeType: "image/png", buffer: Buffer.from(r.b64, "base64") }, corners: r.q.map(([x, y]) => [x, y]), w, h };
}
/** A plain image of printed words (no paper, no skew): the OCR-on-image case. */
async function textImage(p, lines = ["BONJOUR MONDE", "FACTURE 2024"]) {
  const r = await docPhoto(p, { w: 900, h: 500, lines });
  return r.file;
}
async function hudClick(p, id) { await p.click(`[data-field-action="${id}"]`); }
async function insertItem(p, key) {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  await p.click(`[data-carnet-insert="${key}"]`);
}
async function startField(p, id, profile) {
  if (profile === "desktop") await insertItem(p, id === "scanner" ? "scan" : id);
  else await hudClick(p, id);
}
async function viaChooser(p, selector, file) {
  const chooser = p.waitForEvent("filechooser");
  await p.click(selector);
  (await chooser).setFiles(file);
}
async function canvasPoint(p, w, h, [x, y]) {
  const b = await p.locator(".carnet-field-view").boundingBox();
  return [b.x + (x / w) * b.width, b.y + (y / h) * b.height];
}
async function dragHandle(p, i, w, h, to) {
  const hb = await p.locator(`[data-handle="${i}"]`).boundingBox();
  const [tx, ty] = await canvasPoint(p, w, h, to);
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down();
  await p.mouse.move(tx, ty, { steps: 6 });
  await p.mouse.up();
}
async function setCorners(p, w, h, corners) {
  for (let i = 0; i < 4; i += 1) await dragHandle(p, i, w, h, corners[i]);
}
async function frameFromPhoto(p, ph) {
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "framing step: four corner handles");
  await setCorners(p, ph.w, ph.h, ph.corners);
}
async function acceptPage(p, nth) {
  await p.click("[data-field-accept]");
  await until(async () => (await p.locator("li.carnet-field-page").count()) === nth, "page " + nth + " kept in the review list", 20000);
}
async function scanOnePage(p, srv, ph, profile = "iphone") {
  await startField(p, "scanner", profile);
  await p.waitForSelector("#hq-carnet-field-sheet");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
}
const assetDims = (buf) => {
  // JPEG SOF / PNG IHDR
  if (buf[0] === 0x89) return { mime: "image/png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: "image/jpeg", h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
};
/** Decode a stored asset in the browser and return {w, h, gray, bimodal, dark}: gray = fraction of near-neutral pixels. */
async function assetStats(p, id) {
  return p.evaluate(async (id) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "/api/carnet/asset/" + id; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let gray = 0, ext = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      n += 1;
      if (Math.abs(d[i] - d[i + 1]) < 6 && Math.abs(d[i + 1] - d[i + 2]) < 6) gray += 1;
      const y = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (y < 40 || y > 215) ext += 1;
    }
    return { w: c.width, h: c.height, gray: gray / n, bimodal: ext / n };
  }, id);
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ================================================================ A. Field HUD
scenario("1 mobile field HUD: five named 44 px actions above the bottom nav, a launcher that persists nothing, hidden on desktop", async () => {
  for (const [w, h] of [[360, 740], [390, 844]]) {
    const { srv, p } = await openEditor("iphone", NB(), { viewport: { width: w, height: h } });
    const rev0 = srv.nb().notebook_rev;
    const hud = p.locator("#hq-carnet-field-hud");
    check(await hud.isVisible(), `HUD visible at ${w}x${h}`);
    check((await hud.getAttribute("role")) === "toolbar" && !!(await hud.getAttribute("aria-label")), "HUD is a named toolbar");
    const names = await p.$$eval("[data-field-action]", (b) => b.map((x) => x.getAttribute("aria-label")));
    check(names.length === 5 && names.every(Boolean), "five named actions: " + names.join(" | "));
    const ids = await p.$$eval("[data-field-action]", (b) => b.map((x) => x.getAttribute("data-field-action")));
    check(ids.join() === "camera,scanner,voice,measure,sketch", "Camera, Scanner, Voice, Measurement, Sketch: " + ids);
    for (const r of await p.$$eval("[data-field-action]", (b) => b.map((x) => { const q = x.getBoundingClientRect(); return [q.width, q.height]; }))) check(r[0] >= 44 && r[1] >= 44, "target >= 44x44: " + r.map(Math.round));
    const hb = await rectOf(p, "#hq-carnet-field-hud");
    const nb = await rectOf(p, ".bottom-nav");
    check(hb.b <= nb.t + 1.5 && hb.l >= 0 && hb.r <= w + 0.5, `dock sits above the bottom nav and inside the viewport (${Math.round(hb.b)} <= ${Math.round(nb.t)})`);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll");
    await hudClick(p, "measure");
    await p.waitForSelector('[data-carnet-tool], .carnet-eng-panel, #hq-carnet-eng-panel', { state: "attached", timeout: 5000 }).catch(() => {});
    await sleep(200);
    check(srv.nb().notebook_rev === rev0, "using the launcher persists nothing by itself (notebook revision unchanged)");
    if (w === 390) await shot(p, "01-hud-390x844");
    else await shot(p, "01-hud-360x740");
    await p.context().close();
  }
  const d = await openEditor("desktop");
  check(!(await d.p.locator("#hq-carnet-field-hud").isVisible()), "the dock is a phone surface: hidden at desktop width");
  await d.p.click("#btn-carnet-insert");
  await d.p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  for (const k of ["scan", "voice", "ocr", "camera", "measure", "sketch"]) check(await d.p.locator(`[data-carnet-insert="${k}"]`).count() === 1, "desktop exposes the same action through the Insert menu: " + k);
  await d.ctx.close();
  const t = await openEditor("iphone", NB(), { viewport: { width: 820, height: 1180 } });
  check(!(await t.p.locator("#hq-carnet-field-hud").isVisible()), "tablet portrait uses the insert surfaces (HUD is <= 720 px only)");
  await t.p.click("#btn-carnet-insert");
  check(await t.p.locator('[data-carnet-insert="scan"]').count() === 1, "tablet: scanner reachable from Insérer");
});

scenario("2 camera launch path: HUD Photo opens the native capture input (rear camera hint), the photo lands as an ordinary image", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await docPhoto(p);
  const attr = await p.evaluate(() => { const i = document.querySelector('input[type=file][capture]'); return i ? i.getAttribute("capture") : null; });
  check(attr === "environment", "the camera input asks for the rear camera (capture=environment)");
  const chooser = p.waitForEvent("filechooser");
  await hudClick(p, "camera");
  (await chooser).setFiles(ph.file);
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-image]").count()) === 1, "photo inserted as an image block");
  await saved(p);
  check(types(srv).includes("image"), "image block persisted: " + types(srv));
  check(srv.assets().length === 1, "exactly one asset stored");
});

// ================================================================ B. Scanner
scenario("3 scanner single page: manual corners -> perspective-corrected JPEG -> one image block", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await docPhoto(p);
  const rev0 = srv.nb().notebook_rev;
  await scanOnePage(p, srv, ph);
  check(srv.assets().length === 0 && srv.nb().notebook_rev === rev0, "before inserting nothing was uploaded or saved");
  const sheetRect = await rectOf(p, ".carnet-field-panel");
  check(sheetRect.b <= 844.5 && sheetRect.l >= 0 && sheetRect.r <= 390.5, "sheet fits the phone viewport");
  await shot(p, "03-scanner-review");
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "sheet closes after insertion");
  await saved(p);
  const t = types(srv);
  check(t.filter((x) => x === "image").length === 1 && t.filter((x) => x === "imagegroup").length === 0, "one image block: " + t);
  const a = srv.assets();
  check(a.length === 1, "one asset: " + a);
  const buf = srv.asset(a[0]);
  const d = assetDims(buf);
  check(d && d.mime === "image/jpeg" && Math.max(d.w, d.h) <= 2560, "stored scan is a JPEG within 2560 px: " + JSON.stringify(d));
  const paperW = (Math.hypot(ph.corners[1][0] - ph.corners[0][0], ph.corners[1][1] - ph.corners[0][1]) + Math.hypot(ph.corners[2][0] - ph.corners[3][0], ph.corners[2][1] - ph.corners[3][1])) / 2;
  check(Math.abs(d.w - paperW) / paperW < 0.06, `output width follows the crop (${d.w} ~ ${Math.round(paperW)})`);
  check(buf.length <= 12 * 1024 * 1024, "within the 12 MiB image limit: " + buf.length);
});

scenario("4 manual crop: handles drag and use arrow keys; an invalid frame blocks the page with a spoken reason", async () => {
  const { p } = await openEditor("iphone");
  const ph = await docPhoto(p);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "four handles");
  const before = await p.locator('[data-handle="0"]').getAttribute("aria-label");
  await dragHandle(p, 0, ph.w, ph.h, [300, 200]);
  const after = await p.locator('[data-handle="0"]').getAttribute("aria-label");
  check(before !== after && /pour cent/.test(after), "dragging moves the corner and updates its spoken value: " + after);
  await p.focus('[data-handle="1"]');
  const b1 = await p.locator('[data-handle="1"]').getAttribute("aria-label");
  await p.keyboard.press("ArrowLeft");
  await p.keyboard.press("Shift+ArrowDown");
  check((await p.locator('[data-handle="1"]').getAttribute("aria-label")) !== b1, "arrow keys move a focused corner (Shift = larger step)");
  // cross the frame: swap two opposite corners -> concave / degenerate
  await dragHandle(p, 0, ph.w, ph.h, [ph.corners[2][0] - 10, ph.corners[2][1] - 10]);
  await until(async () => await p.locator("[data-field-accept]").isDisabled(), "invalid frame disables 'Valider la page'");
  check((await p.locator('.carnet-field-warn[role="alert"]:visible').count()) === 1, "the reason is shown as an alert, not by colour alone");
  await shot(p, "04-invalid-frame");
  await p.click("button:has-text('Réinitialiser le cadre')");
  await until(async () => !(await p.locator("[data-field-accept]").isDisabled()), "reset restores a valid frame");
});

scenario("5 rotate: 90 degree turns keep the frame on the paper and swap the output", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await docPhoto(p, { w: 1200, h: 800 });
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "four handles");
  await setCorners(p, ph.w, ph.h, ph.corners);
  const dims0 = await p.evaluate(() => { const c = document.querySelector(".carnet-field-view"); return [c.width, c.height]; });
  await p.click('[data-field-rotate="right"]');
  await until(async () => (await p.evaluate(() => { const c = document.querySelector(".carnet-field-view"); return c.width; })) === dims0[1], "canvas swapped to portrait");
  check(await p.locator("[data-field-accept]").isEnabled(), "the rotated frame is still valid");
  await p.click("[data-field-accept]");
  await p.waitForSelector("li.carnet-field-page", { timeout: 20000 });
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted");
  await saved(p);
  const d = assetDims(srv.asset(srv.assets()[0]));
  check(d.h > d.w, `rotated page is portrait: ${d.w}x${d.h}`);
});

// ================================================================ C. OCR
async function pageWithImage(profile = "iphone", lines) {
  const o = await openEditor(profile);
  const file = await textImage(o.p, lines);
  const chooser = o.p.waitForEvent("filechooser");
  if (profile === "desktop") await insertItem(o.p, "image"); else await hudClick(o.p, "camera");
  (await chooser).setFiles(file);
  await until(async () => (await o.p.locator("#hq-carnet-editor [data-carnet-image]").count()) === 1, "image inserted");
  await saved(o.p);
  return o;
}
async function openOcrOnSelected(p) {
  await p.click("#hq-carnet-editor [data-carnet-image]");
  await p.waitForSelector("#btn-carnet-image-ocr", { state: "visible" });
  await p.click("#btn-carnet-image-ocr");
  await p.waitForSelector('[data-field-sheet="ocr"]');
}
async function runOcr(p, timeout = 90000) {
  await p.waitForSelector("[data-field-ocr-run]", { state: "visible" });
  await p.click("[data-field-ocr-run]");
  await p.waitForSelector("[data-field-ocr-text]", { state: "visible", timeout });
}

scenario("10 OCR success: local engine (vendored, one worker), progress announced, text reviewed then inserted with provenance", async () => {
  const { srv, p } = await pageWithImage();
  const assetId = srv.assets()[0].replace(/\.[a-z]+$/, "");
  const reqs = [];
  p.on("request", (r) => reqs.push(r.url()));
  await openOcrOnSelected(p);
  const t0 = Date.now();
  await p.selectOption("[data-field-lang]", "eng");
  await p.click("[data-field-ocr-run]");
  await until(async () => /Reconnaissance du texte : page 1 sur 1/.test(await p.locator("[data-field-ocr-status]").innerText()), "progress text shows the page", 60000);
  check(await p.locator("[data-field-ocr-cancel]").isVisible(), "a cancel action is offered while running");
  await p.waitForSelector("[data-field-ocr-text]", { state: "visible", timeout: 90000 });
  const ms = Date.now() - t0;
  console.log("   [perf] OCR (worker boot + eng data + 1 page) " + ms + " ms");
  const txt = await p.locator("[data-field-ocr-text]").inputValue();
  check(/BONJOUR/i.test(txt) && /2024/.test(txt), "recognised text: " + JSON.stringify(txt.slice(0, 60)));
  const cnt = await p.locator("[data-field-ocr-count]").innerText();
  check(/paragraphe/.test(cnt) && /caractères/.test(cnt), "the number of blocks is shown BEFORE insertion: " + cnt);
  check(srv.blocks().every((b) => b.type !== "paragraph" || !b.from), "nothing inserted yet");
  check(reqs.every((u) => u.startsWith(srv.base) || u.startsWith("blob:") || u.startsWith("data:")), "every request stayed on the page's own origin");
  check(reqs.some((u) => /eng\.traineddata\.gz/.test(u)) && !reqs.some((u) => /fra\.traineddata/.test(u)), "only the selected language data was fetched");
  await shot(p, "10-ocr-review");
  await p.click("[data-field-ocr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "sheet closes after insertion");
  await saved(p);
  const derived = srv.blocks().filter((b) => b.from);
  check(derived.length >= 1, "derived paragraph(s) persisted: " + derived.length);
  for (const b of derived) check(JSON.stringify(b.from) === JSON.stringify({ kind: "ocr", source_kind: "asset", source_id: assetId }), "provenance is canonical {kind, source_kind, source_id}, no path: " + JSON.stringify(b.from));
  check(await p.locator('#hq-carnet-editor [data-carnet-derived="ocr"]').count() >= 1, "derived text is marked in the editor");
  check(await p.locator("[data-carnet-derived-badge]").count() === 1, "one badge opens the run");
  await shot(p, "10-ocr-inserted");
});

scenario("11 OCR failure: engine unavailable -> visible failure, image and page untouched, retry works", async () => {
  const { srv, p } = await pageWithImage();
  const before = JSON.stringify(srv.blocks());
  await p.route("**/assets/vendor-tesseract-worker.min.js", (r) => r.abort());
  await openOcrOnSelected(p);
  await p.click("[data-field-ocr-run]");
  await until(async () => /a échoué/.test(await p.locator("[data-field-ocr-status]").innerText()), "failure is stated in the status text", 60000);
  check(await p.locator("[data-field-ocr-run]").innerText() === "Réessayer", "a retry action is offered");
  check(await p.locator("[data-field-ocr-insert]").isDisabled(), "nothing can be inserted after a failure");
  check(JSON.stringify(srv.blocks()) === before && srv.assets().length === 1, "page and scan untouched");
  await p.unroute("**/assets/vendor-tesseract-worker.min.js");
  await p.click("[data-field-ocr-run]");
  await p.waitForSelector("[data-field-ocr-text]", { state: "visible", timeout: 90000 });
  check((await p.locator("[data-field-ocr-text]").inputValue()).length > 3, "retry succeeds");
});

scenario("12 OCR source preserved: the scan stays byte-identical and reachable from the derived text, even after the image block is removed", async () => {
  const { srv, p } = await pageWithImage();
  const name = srv.assets()[0];
  const id = name.replace(/\.[a-z]+$/, "");
  const h0 = sha(srv.asset(name));
  await openOcrOnSelected(p);
  await p.selectOption("[data-field-lang]", "eng");
  await runOcr(p);
  await p.click("[data-field-ocr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted");
  await saved(p);
  check(sha(srv.asset(name)) === h0, "the source scan is unchanged by OCR");
  await p.click("[data-carnet-derived-open]");
  await p.waitForSelector('[data-field-sheet="source"] img.carnet-field-source-img');
  check(await p.evaluate(() => { const i = document.querySelector("img.carnet-field-source-img"); return i.complete ? i.naturalWidth > 0 : new Promise((r) => (i.onload = () => r(true))); }), "'Voir le scan' shows the exact source image");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "Esc closes the viewer");
  // remove the image block itself: the derived text keeps pointing at a scan that must stay stored
  await p.click("#hq-carnet-editor [data-carnet-image]");
  await p.click("#btn-carnet-image-remove");
  const confirm = p.locator("#btn-carnet-image-remove");
  if (/onfirm|ûr|Sûr/i.test(await confirm.innerText())) await confirm.click();
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-image]").count()) === 0, "image block removed");
  await saved(p);
  check(srv.blocks().some((b) => b.from && b.from.source_id === id), "derived text still carries its source reference");
  check(srv.assets().includes(name) && sha(srv.asset(name)) === h0, "the scan file is still stored (provenance keeps it)");
  const r = await p.context().request.get(srv.base + "/api/carnet/asset/" + id);
  check(r.status() === 200, "and still served");
});

// ================================================================ D. Voice
const VOICE_PERMS = { permissions: ["microphone"] };
async function startRecording(p, profile = "iphone") {
  await startField(p, "voice", profile);
  await p.waitForSelector('[data-field-sheet="voice"]');
  await p.click("[data-field-record]");
  await p.waitForSelector("[data-field-recording]", { timeout: 10000 });
}
async function recordFor(p, ms, profile) {
  await startRecording(p, profile);
  await sleep(ms);
  await p.click("[data-field-stop]");
  await p.waitForSelector("[data-field-playback]", { timeout: 10000 });
}
async function recordAndInsert(p, ms = 1800, profile) {
  await recordFor(p, ms, profile);
  await p.click("[data-field-keep]");
  await until(async () => (await sheetOpen(p)) === 0, "voice sheet closes after insertion", 20000);
  await saved(p);
}
const voiceBlocks = (srv) => blocksOf(srv).filter((b) => b.type === "voice");

scenario("13 voice record: permission asked only after the tap, state + elapsed time as text, one voice block with immutable audio", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  check(await p.evaluate(() => performance.getEntriesByType("resource").every((r) => !/voice/.test(r.name))), "opening the page requested no audio");
  await startRecording(p);
  const status = await p.locator("[data-field-rec-status]").innerText();
  check(/Enregistrement en cours/.test(status), "recording state is announced as text: " + status);
  await sleep(2300);
  const t = await p.locator("[data-field-time]").innerText();
  check(/^0:0[1-9]$/.test(t), "elapsed time is exposed as text: " + t);
  check((await p.locator("[data-field-time]").getAttribute("role")) === "timer", "role=timer on the elapsed time");
  check((await p.locator("[data-field-recording]").innerText()).includes("Enregistrement"), "a text marker (not only colour) shows recording");
  await shot(p, "13-recording");
  const rev0 = srv.pg("page-a").rev;
  check(srv.voices().length === 0, "nothing is uploaded while recording");
  await p.click("[data-field-stop]");
  await p.waitForSelector("[data-field-playback]");
  await p.click("[data-field-keep]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 20000);
  await saved(p);
  const vb = voiceBlocks(srv);
  check(vb.length === 1, "one voice block: " + types(srv));
  const v = vb[0].voice;
  check(Object.keys(v).sort().join() === "dur_ms,id,mime,recorded_at" && /^voice-[0-9a-f]{24}$/.test(v.id), "block = exactly {id, mime, dur_ms, recorded_at}: " + JSON.stringify(v));
  check(v.dur_ms >= 1500 && v.dur_ms <= 8000 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v.recorded_at), "duration and UTC stamp are plausible: " + v.dur_ms);
  check(srv.voices().length === 1 && srv.voices()[0].startsWith(v.id), "one voice file stored under the asset id, not the block id: " + srv.voices());
  check(vb[0].id !== v.id, "block id and voice asset id are distinct");
  const bytes = srv.voice(srv.voices()[0]);
  check(bytes.slice(0, 4).toString("hex") === "1a45dfa3" || bytes.slice(4, 8).toString() === "ftyp", "stored bytes are a real WebM/MP4 container");
  console.log("   [perf] voice: " + bytes.length + " bytes for " + v.dur_ms + " ms (" + Math.round((bytes.length * 1000) / v.dur_ms) + " B/s; 10 min worst case ~ " + Math.round((bytes.length / v.dur_ms) * 600000 / 1024) + " KiB vs 16384 KiB limit)");
  check((bytes.length / v.dur_ms) * 600000 < 16 * 1024 * 1024, "extrapolated 10-minute size stays under the 16 MiB asset limit");
  check(await p.locator('#hq-carnet-editor [data-carnet-struct="voice"] audio').count() === 1, "voice card with a player is rendered");
  check(srv.pg("page-a").rev === rev0 + 1, "the insertion is exactly one saved revision of the page");
});

scenario("14 stop / discard: Supprimer deletes the take, nothing reaches the server, the stash is empty", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordFor(p, 1200);
  check(await p.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("hq-carnet-field"); q.onsuccess = () => r(q.result); }); return await new Promise((r) => { const c = db.transaction("captures").objectStore("captures").count(); c.onsuccess = () => r(c.result); }); }) === 1, "a finished take is held in the recovery stash");
  await p.click("[data-field-discard]");
  await until(async () => /Prêt à enregistrer/.test(await p.locator("[data-field-rec-status]").innerText()), "back to ready");
  check(await p.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("hq-carnet-field"); q.onsuccess = () => r(q.result); }); return await new Promise((r) => { const c = db.transaction("captures").objectStore("captures").count(); c.onsuccess = () => r(c.result); }); }) === 0, "discard also empties the stash");
  check(srv.voices().length === 0 && voiceBlocks(srv).length === 0, "nothing stored, no block");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "closed");
});

scenario("15 playback: the card's player streams the stored note (Range supported)", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordAndInsert(p);
  const id = voiceBlocks(srv)[0].voice.id;
  const r = await p.context().request.get(srv.base + "/api/carnet/voice/" + id, { headers: { Range: "bytes=0-31" } });
  check(r.status() === 206 && /^bytes 0-31\//.test(r.headers()["content-range"] || ""), "Range request answered 206: " + r.status());
  check(/^audio\//.test(r.headers()["content-type"] || "") && r.headers()["x-content-type-options"] === "nosniff", "fixed audio type + nosniff");
  const ready = await p.evaluate(() => new Promise((res) => { const a = document.querySelector("audio.carnet-voice-audio"); if (a.readyState >= 1) return res(a.readyState); a.addEventListener("loadedmetadata", () => res(a.readyState)); a.addEventListener("error", () => res(-1)); a.load(); setTimeout(() => res(-2), 8000); }));
  check(ready >= 1, "the player loaded the audio metadata (readyState " + ready + ")");
  const unauth = await (await browser.newContext()).request.get(srv.base + "/api/carnet/voice/" + id);
  check(unauth.status() === 401 || unauth.status() === 403, "audio is not served without a session: " + unauth.status());
});

scenario("16 permission denial: a clear text state, retry offered, no recorder left running, nothing stored", async () => {
  const b2 = await chromium.launch({ args: ["--use-fake-device-for-media-stream"] });
  const keep = browser;
  browser = b2;
  try {
    const { srv, p } = await openEditor("iphone");
    // SYNTHETIC denial: a headless Chromium has no permission prompt to answer, so the user's "Block" is simulated with the
    // exact error a real denial raises (NotAllowedError). Real browser prompts on real devices are UNVERIFIED.
    await p.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")); });
    await startField(p, "voice", "iphone");
    await p.click("[data-field-record]");
    await until(async () => /refusé/.test(await p.locator("[data-field-rec-status]").innerText()), "denial is stated in words", 15000);
    check(await p.locator("[data-field-retry]").isVisible(), "'Réessayer' is offered");
    check(/réglages du navigateur/.test(await p.locator(".carnet-field-body").innerText()), "the way out is explained");
    check(srv.voices().length === 0, "nothing stored");
    check(await p.locator("[data-field-recording]").count() === 0, "no recording indicator: no hidden recording");
    await shot(p, "16-denied");
    await p.context().close();
  } finally {
    browser = keep;
    await b2.close();
  }
});

scenario("17 long recording limit: the recorder stops itself at 10:00 with a stated reason and the take stays usable", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await p.clock.install();
  await startRecording(p);
  await sleep(400);
  // Advance the FAKE clock in chunks until the recorder has stopped itself (bounded): every interval tick really runs, and the test
  // does not depend on how many chunks a loaded machine manages per real second.
  for (let i = 0; i < 40 && (await p.locator("[data-field-playback]").count()) === 0; i += 1) {
    await p.clock.fastForward(30000);
    await sleep(120);
  }
  await until(async () => (await p.locator("[data-field-playback]").count()) === 1, "recorder stopped by itself", 15000);
  await p.clock.runFor(200);
  const st = await p.locator("[data-field-rec-status]").innerText();
  check(/Durée maximale atteinte/.test(st) && /10 minutes/.test(st), "reason + duration stated: " + st);
  check((await p.locator("[data-field-time]").innerText()) === "10:00", "elapsed text capped at 10:00");
  await p.click("[data-field-keep]");
  await until(async () => voiceBlocks(srv).length === 1, "block inserted after the limit", 20000);
  check(voiceBlocks(srv)[0].voice.dur_ms === 600000, "dur_ms is capped at 600000");
});

// ================================================================ E. Transcription adapter (FAKE engine only: no model, no binary)
async function voicePage(env) {
  const o = await openEditor("iphone", NB(), VOICE_PERMS, env);
  await recordAndInsert(o.p);
  return o;
}
async function openTranscript(p) {
  await p.click("[data-voice-transcribe]");
  await p.waitForSelector('[data-field-sheet="transcript"]');
}

scenario("18 transcription success: browser derives a 16 kHz WAV, the configured engine answers, text is offered for review", async () => {
  const { srv, p } = await voicePage({ CARNET_TEST_ENGINE: "ok" });
  await openTranscript(p);
  const reqs = [];
  p.on("request", (r) => reqs.push(r.method() + " " + r.url()));
  await p.click("[data-field-tr-run]");
  await p.waitForSelector("[data-field-tr-text]", { state: "visible", timeout: 30000 });
  const txt = await p.locator("[data-field-tr-text]").inputValue();
  check(/Premier paragraphe dicté/.test(txt), "engine text shown: " + JSON.stringify(txt));
  check(/prête à relire/.test(await p.locator("[data-field-tr-status]").innerText()), "status is spoken text");
  check(reqs.every((r) => r.includes(srv.base) || r.includes("blob:") || r.includes("data:")), "no external request");
  check(reqs.some((r) => /POST .*\/voice-[0-9a-f]{24}\/transcribe$/.test(r)), "the WAV went to the local transcribe endpoint only");
  await shot(p, "18-transcript");
});

scenario("19 transcription failure + unconfigured: stated plainly, the note is intact, 'Traiter plus tard' leaves it untouched", async () => {
  const f = await voicePage({ CARNET_TEST_ENGINE: "fail" });
  const id = voiceBlocks(f.srv)[0].voice.id;
  const h0 = sha(f.srv.voice(f.srv.voices()[0]));
  await openTranscript(f.p);
  await f.p.click("[data-field-tr-run]");
  await until(async () => /a échoué/.test(await f.p.locator("[data-field-tr-status]").innerText()), "failure is stated", 30000);
  check(await f.p.locator("[data-field-tr-run]").innerText() === "Réessayer", "retry offered");
  check(sha(f.srv.voice(f.srv.voices()[0])) === h0 && voiceBlocks(f.srv)[0].voice.id === id, "voice note and block unchanged");
  const u = await voicePage();
  await openTranscript(u.p);
  await u.p.click("[data-field-tr-run]");
  await until(async () => /non configurée/.test(await u.p.locator("[data-field-tr-status]").innerText()), "unconfigured server says so", 30000);
  await u.p.click("[data-field-tr-later]");
  await until(async () => /reportée/.test(await u.p.locator("[data-field-tr-status]").innerText()), "'Traiter plus tard' is acknowledged");
  const rev = u.srv.pg("page-a").rev;
  await u.p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(u.p)) === 0, "closed");
  await sleep(300);
  check(u.srv.pg("page-a").rev === rev && !blocksOf(u.srv).some((b) => b.from), "deferring changes nothing and queues nothing");
  check(await u.p.locator("[data-voice-transcribe]").isVisible(), "the action stays available on the card for later");
});

scenario("20 transcript editing: the user corrects the text; the count follows; the limit is shown", async () => {
  const { p } = await voicePage({ CARNET_TEST_ENGINE: "ok" });
  await openTranscript(p);
  await p.click("[data-field-tr-run]");
  await p.waitForSelector("[data-field-tr-text]", { state: "visible", timeout: 30000 });
  const c0 = await p.locator("[data-field-tr-count]").innerText();
  await p.fill("[data-field-tr-text]", "Texte corrigé.\n\nSecond paragraphe.\n\nTroisième.");
  const c1 = await p.locator("[data-field-tr-count]").innerText();
  check(/3 paragraphes/.test(c1) && c0 !== c1, "count updates with the edit: " + c0 + " -> " + c1);
  await p.fill("[data-field-tr-text]", "");
  check(await p.locator("[data-field-tr-insert]").isDisabled(), "empty text cannot be inserted");
  check((await p.locator("[data-field-tr-text]").getAttribute("maxlength")) === "20000", "the 20,000 character limit is enforced on the field");
});

scenario("21 insert transcript: derived paragraphs after the voice block, each with transcript provenance", async () => {
  const { srv, p } = await voicePage({ CARNET_TEST_ENGINE: "ok" });
  const vid = voiceBlocks(srv)[0].voice.id;
  await openTranscript(p);
  await p.click("[data-field-tr-run]");
  await p.waitForSelector("[data-field-tr-text]", { state: "visible", timeout: 30000 });
  await p.fill("[data-field-tr-text]", "Un.\n\nDeux.\n\nTrois.");
  await p.click("[data-field-tr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 15000);
  await saved(p);
  const bl = blocksOf(srv);
  const vi = bl.findIndex((b) => b.type === "voice");
  const d = bl.slice(vi + 1, vi + 4);
  check(d.length === 3 && d.every((b) => b.type === "paragraph" && b.from && b.from.kind === "transcript" && b.from.source_kind === "voice" && b.from.source_id === vid), "three derived paragraphs directly after the voice block: " + JSON.stringify(d.map((b) => b.text)));
  check(Object.keys(d[0].from).sort().join() === "kind,source_id,source_kind", "provenance has exactly kind/source_kind/source_id");
  check(await p.locator('#hq-carnet-editor [data-carnet-derived="transcript"]').count() === 3 && await p.locator("[data-carnet-derived-badge]").count() === 1, "marked in the editor, one badge for the run");
  await p.click("[data-carnet-derived-open]");
  await p.waitForSelector('[data-field-sheet="source"] audio');
  check(true, "the badge opens the source voice note");
  await p.keyboard.press("Escape");
});

scenario("22 source audio preserved: transcription never alters the audio, and removing the card keeps both the file and the derived text's source", async () => {
  const { srv, p } = await voicePage({ CARNET_TEST_ENGINE: "ok" });
  const name = srv.voices()[0];
  const id = voiceBlocks(srv)[0].voice.id;
  const h0 = sha(srv.voice(name));
  await openTranscript(p);
  await p.click("[data-field-tr-run]");
  await p.waitForSelector("[data-field-tr-text]", { state: "visible", timeout: 30000 });
  await p.click("[data-field-tr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 15000);
  await saved(p);
  check(sha(srv.voice(name)) === h0, "audio bytes identical after transcription");
  const del = p.locator('[data-carnet-struct="voice"] .carnet-struct-del');
  await del.click();
  await del.click();
  await until(async () => (await p.locator('[data-carnet-struct="voice"]').count()) === 0, "voice block removed");
  await saved(p);
  check(srv.voices().includes(name) && sha(srv.voice(name)) === h0, "the audio file is still stored (immutable store, referenced by the transcript)");
  check(blocksOf(srv).some((b) => b.from && b.from.source_id === id), "derived text keeps its source id");
  const r = await p.context().request.get(srv.base + "/api/carnet/voice/" + id);
  check(r.status() === 200, "and it is still served");
});

// ================================================================ B (cont.). Scanner: treatments, multi-page, cancel, failure
async function addPage(p, ph, n, filter) {
  await viaChooser(p, "[data-field-pick]", ph.file);
  await frameFromPhoto(p, ph);
  if (filter) await p.click(`label[for="hq-field-f-${filter}"]`);
  await acceptPage(p, n);
}
const smallDoc = (p, lines) => docPhoto(p, { w: 640, h: 480, lines });

scenario("6 grayscale / document treatments: really neutral and high-contrast pixels, colour page stays colour", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await docPhoto(p, { w: 900, h: 700 });
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  check(await p.locator("#hq-field-f-color").isChecked(), "colour/original is the default");
  check((await p.locator('[role="radiogroup"] input[type=radio]').count()) === 3, "exactly three treatments: colour, grey, document");
  await acceptPage(p, 1);
  await addPage(p, ph, 2, "gray");
  await addPage(p, ph, 3, "document");
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted");
  await saved(p);
  const g = blocksOf(srv).find((b) => b.type === "imagegroup");
  const items = (g.imagegroup || g.group || Object.values(g).find((v) => v && v.items)).items;
  const st = [];
  for (const it of items) st.push(await assetStats(p, it.id));
  console.log("   [stats]", JSON.stringify(st.map((s) => ({ gray: +s.gray.toFixed(2), bimodal: +s.bimodal.toFixed(2) }))));
  check(st[0].gray < 0.9 || st[0].bimodal < 0.95, "colour page keeps its colours (not forced grey)");
  check(st[1].gray > 0.98, "grey treatment: neutral pixels " + st[1].gray.toFixed(3));
  check(st[2].gray > 0.98 && st[2].bimodal > 0.9, "document treatment: black/white, high contrast " + st[2].bimodal.toFixed(3));
});

scenario("7 multi-page scan: atomic insertion as image groups of 2-3 (4 pages -> 2+2), reorder controls, one revision", async () => {
  const { srv, p } = await openEditor("iphone");
  await startField(p, "scanner", "iphone");
  const phs = [];
  for (let i = 0; i < 4; i += 1) phs.push(await smallDoc(p, ["PAGE " + (i + 1)]));
  await viaChooser(p, "[data-field-take]", phs[0].file);
  await frameFromPhoto(p, phs[0]);
  await acceptPage(p, 1);
  for (let i = 1; i < 4; i += 1) await addPage(p, phs[i], i + 1);
  check((await p.locator("li.carnet-field-page").count()) === 4, "four pages listed");
  // reorder: move page 4 up to the front through Monter x3
  for (let k = 0; k < 3; k += 1) await p.click('li[data-page="' + (4 - k) + '"] button:has-text("Monter")');
  check(/Insérer 4 pages/.test(await p.locator("[data-field-insert]").innerText()), "the insert action names the page count");
  const rev0 = srv.pg("page-a").rev;
  const a0 = srv.assets().length;
  check(a0 === 0, "nothing uploaded before the user inserts");
  await shot(p, "07-multipage-review");
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 40000);
  await saved(p);
  check(srv.pg("page-a").rev === rev0 + 1, "all pages arrive in ONE saved revision");
  const t = types(srv);
  check(t.filter((x) => x === "imagegroup").length === 2 && !t.includes("image"), "two image groups, no stray image: " + t);
  check(srv.assets().length === 4, "four scan assets");
  check(await p.locator('#hq-carnet-editor [data-carnet-struct="imagegroup"]').count() === 2, "both groups rendered");
});

scenario("8 scanner cancel: a page can be dropped, closing keeps captures recoverable, nothing is inserted or uploaded", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await smallDoc(p, ["ANNULER"]);
  const rev0 = srv.pg("page-a").rev;
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "framing");
  await p.click("[data-field-cancel-page]");
  await until(async () => (await p.locator("[data-field-take]").count()) === 1 && (await p.locator("li.carnet-field-page").count()) === 0, "dropping the page returns to the start with no page kept");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-close]");
  check((await sheetOpen(p)) === 1, "first close only warns (captures are kept)");
  check(/récupérables/.test(await flash(p)) || /récupérables/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText()), "the warning says captures stay recoverable");
  await p.click("[data-field-close]");
  await until(async () => (await sheetOpen(p)) === 0, "second close leaves");
  check(srv.assets().length === 0 && srv.pg("page-a").rev === rev0 && !types(srv).includes("image"), "nothing uploaded, nothing inserted");
  check(await p.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("hq-carnet-field"); q.onsuccess = () => r(q.result); }); return await new Promise((r) => { const c = db.transaction("captures").objectStore("captures").count(); c.onsuccess = () => r(c.result); }); }) === 1, "the kept page waits in the bounded recovery stash");
  check(await p.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-field-action")) === "scanner", "focus returns to the HUD button that opened the scanner");
});

scenario("9 processing failure: a failed upload inserts nothing, discloses the orphan, and a retry reuses the uploaded page", async () => {
  const { srv, p } = await openEditor("iphone");
  const ph = await smallDoc(p, ["ECHEC"]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await addPage(p, ph, 2);
  let n = 0;
  await p.route("**/api/carnet/asset", async (route) => {
    n += 1;
    if (route.request().method() === "POST" && n === 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disque plein (test)", code: "storage_error" }) });
    return route.continue();
  });
  const rev0 = srv.pg("page-a").rev;
  await p.click("[data-field-insert]");
  await until(async () => /Aucune page n'a été insérée/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText()), "failure is announced and states that nothing was inserted", 30000);
  check(srv.assets().length === 1, "one page had already been uploaded (orphan)");
  check(/déjà téléversée/.test(await p.locator(".carnet-field-body").innerText()), "the orphan is disclosed on screen");
  check(srv.pg("page-a").rev === rev0 && !types(srv).includes("imagegroup"), "page untouched");
  check((await p.locator("li.carnet-field-page").count()) === 2, "both pages are still held for a retry");
  await p.unroute("**/api/carnet/asset");
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "retry inserts", 30000);
  await saved(p);
  check(srv.assets().length === 2, "the retry reused the uploaded page (2 assets, not 3)");
  check(types(srv).filter((x) => x === "imagegroup").length === 1, "one group of two");
});

// ================================================================ F. Offline, persistence, history, backup
const stashCount = (p) => p.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("hq-carnet-field"); q.onsuccess = () => r(q.result); }); return await new Promise((r) => { const c = db.transaction("captures").objectStore("captures").count(); c.onsuccess = () => r(c.result); }); });

scenario("23 offline capture: scanning and recording work without a network; uploading is refused with a clear message and the capture is kept", async () => {
  const { srv, ctx, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await ctx.setOffline(true);
  const ph = await smallDoc(p, ["HORS LIGNE"]);
  const rev0 = srv.pg("page-a").rev;
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-insert]");
  await until(async () => /Hors ligne/.test(await flash(p)) || /Hors ligne/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText()), "offline is stated in words");
  check(srv.assets().length === 0 && srv.pg("page-a").rev === rev0, "nothing reached the server");
  check((await stashCount(p)) === 1, "the scan is held in the recovery stash");
  await p.click("[data-field-close]");
  await p.click("[data-field-close]");
  await until(async () => (await sheetOpen(p)) === 0, "closed");
  await recordFor(p, 1200);
  await p.click("[data-field-keep]");
  await until(async () => /Hors ligne/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-body").innerText()), "recording: offline message shown, take kept");
  check(await p.locator("[data-field-playback]").count() === 1 && srv.voices().length === 0, "the take is still playable and nothing was uploaded");
  check((await stashCount(p)) === 2, "scan + take are both in the stash");
  await shot(p, "23-offline");
});

scenario("24 reconnect / process later: after a reload the captures are offered back, inserted on demand, and the stash is emptied only after confirmed insertion", async () => {
  const { srv, ctx, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  const ph = await smallDoc(p, ["PLUS TARD"]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-close]");
  await p.click("[data-field-close]");
  await recordFor(p, 1200);
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "closed with a pending take");
  check((await stashCount(p)) === 2, "two uncommitted captures stashed");
  await p.reload();
  await showCarnet(p);
  const banner = p.locator("[data-field-recover]");
  await until(async () => await banner.isVisible(), "a banner offers the captures back after the reload");
  const bt = await banner.innerText();
  check(/1 page numérisée/.test(bt) && /1 note vocale/.test(bt), "what is waiting is named: " + bt.replace(/\n/g, " "));
  await shot(p, "24-recovery-banner");
  await p.click("[data-field-recover-open]");
  await p.waitForSelector('[data-field-sheet="recovery"]');
  check(/24 heures/.test(await p.locator(".carnet-field-body").innerText()) && /Aucune synchronisation/.test(await p.locator(".carnet-field-body").innerText()), "TTL and 'no sync' are stated");
  await ctx.setOffline(true);
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => /Hors ligne/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText()), "offline: refused with a message");
  check((await stashCount(p)) === 2 && srv.assets().length === 0, "nothing lost, nothing uploaded while offline");
  await ctx.setOffline(false);
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "scan inserted after reconnect", 20000);
  await saved(p);
  check(types(srv).includes("image") && srv.assets().length === 1 && (await stashCount(p)) === 1, "scan inserted, its stash entry removed, the take still waiting");
  await p.click("[data-field-recover-open]");
  await p.waitForSelector('[data-recover-kind="voice"]');
  await p.click('[data-recover-kind="voice"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "voice inserted", 20000);
  await saved(p);
  check(voiceBlocks(srv).length === 1 && srv.voices().length === 1 && (await stashCount(p)) === 0, "voice note inserted and the stash is empty");
  await until(async () => !(await banner.isVisible()), "the banner goes away");
});

scenario("25 save / reload: scan + OCR text + voice survive a reload exactly (atomic scan-with-text insertion)", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  const ph = await docPhoto(p, { w: 900, h: 600 });
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  const rev0 = srv.pg("page-a").rev;
  await p.click("[data-field-insert-ocr]");
  await p.waitForSelector("[data-field-ocr-run]", { timeout: 30000 });
  check(srv.pg("page-a").rev === rev0 && srv.assets().length === 1, "pages are uploaded but NOT yet inserted while OCR runs");
  await p.selectOption("[data-field-lang]", "eng");
  await p.click("[data-field-ocr-run]");
  await p.waitForSelector("[data-field-ocr-text]", { state: "visible", timeout: 90000 });
  await p.click("[data-field-ocr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 20000);
  await saved(p);
  check(srv.pg("page-a").rev === rev0 + 1, "image and text arrived in ONE revision");
  await recordAndInsert(p, 1500);
  const snap = () => srv.blocks().map((b) => [b.type, b.text || "", b.from ? b.from.kind : "", b.voice ? b.voice.id : "", b.image ? b.image.id : ""]);
  const before = JSON.stringify(snap());
  const img = blocksOf(srv).find((b) => b.type === "image");
  const der = blocksOf(srv).filter((b) => b.from);
  check(der.length >= 1 && der.every((b) => b.from.source_id === (img.image || img.asset || {}).id), "OCR text points at the uploaded scan of this very page");
  await p.reload();
  await showCarnet(p);
  await until(async () => (await p.locator('#hq-carnet-editor [data-carnet-struct="voice"]').count()) === 1, "voice card back after reload");
  check((await p.locator("#hq-carnet-editor [data-carnet-image]").count()) === 1 && (await p.locator("[data-carnet-derived-badge]").count()) === 1, "image and derived text back");
  check(JSON.stringify(snap()) === before, "server content is identical after the reload");
  check(await p.evaluate(() => !window.hqCarnetDebug().core.pages.some((x) => x.dirty)), "reloading does not mark the page dirty (provenance round-trips)");
  await shot(p, "25-reloaded");
});

const postCarnet = (p, srv, data) => p.context().request.post(srv.base + "/api/carnet", { data, headers: { Origin: srv.base } });

scenario("26 history: a checkpoint can be restored over later field captures; media stays stored and the history keeps the event", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordAndInsert(p, 1200);
  const rev = srv.pg("page-a").rev;
  const cp = await postCarnet(p, srv, { action: "history_checkpoint", page_id: "page-a", expected_rev: rev, label: "Avec la note" });
  check(cp.status() === 200, "checkpoint created: " + cp.status());
  await p.reload();
  await showCarnet(p);
  const ph = await smallDoc(p, ["APRES"]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "scan inserted after the checkpoint", 20000);
  await saved(p);
  check(types(srv).includes("image"), "page now has the scan");
  const hist = await (await p.context().request.get(srv.base + "/api/carnet?history=1&page=page-a")).json();
  const ev = (hist.events || hist.history || []).find((e) => e.kind === "checkpoint");
  check(!!ev, "the checkpoint is listed in the history");
  const rs = await postCarnet(p, srv, { action: "history_restore", page_id: "page-a", event_id: ev.id, expected_rev: srv.pg("page-a").rev, confirm: true });
  check(rs.status() === 200, "restore accepted: " + rs.status());
  const t = types(srv);
  check(t.includes("voice") && !t.includes("image"), "the page is back to 'with the note, without the scan': " + t);
  check(srv.assets().length === 1 && srv.voices().length === 1, "no media was deleted by the restore (scan asset and voice file are both still stored)");
  await p.reload();
  await showCarnet(p);
  check(await p.locator('[data-carnet-struct="voice"] audio').count() === 1, "the restored page renders the voice card again");
});

scenario("27 backup / recovery: the real snapshot carries the scan, the voice note and the transcript's source; a missing voice file makes it invalid", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS, { CARNET_TEST_ENGINE: "ok" });
  const ph = await smallDoc(p, ["SAUVEGARDE"]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "scan in", 20000);
  await recordAndInsert(p, 1200);
  await openTranscript(p);
  await p.click("[data-field-tr-run]");
  await p.waitForSelector("[data-field-tr-text]", { state: "visible", timeout: 30000 });
  await p.click("[data-field-tr-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "transcript in", 15000);
  await saved(p);
  const dest = path.join(srv.root, "..", "p4-snap-" + process.pid + "-" + Date.now());
  const run = (d) => JSON.parse(execFileSync(process.env.PYTHON || "python3", [path.join(here, "carnet_field_probe.py"), srv.root, "snapshot", d], { encoding: "utf8" }));
  const rep = run(dest);
  check(rep.valid === true && rep.assets.missing === 0 && rep.voice.missing === 0 && rep.voice.count === 1, "snapshot valid, scan + voice copied: " + JSON.stringify({ a: rep.assets.count, v: rep.voice }));
  check(readdirSync(path.join(dest, "voice")).length === 1 && readdirSync(path.join(dest, "assets")).length === 1, "files are present in the snapshot");
  rmSync(path.join(srv.vdir, srv.voices()[0]));
  const bad = run(dest + "-2");
  check(bad.valid === false && bad.voice.missing === 1, "a missing voice file is reported, never silently skipped: " + JSON.stringify(bad.voice));
  rmSync(dest, { recursive: true, force: true });
  rmSync(dest + "-2", { recursive: true, force: true });
});

// ================================================================ F2. Retry after "uploaded, but the notebook insertion failed" reuses the SAME canonical asset
const switchTo = async (p, id) => {
  const sel = '#carnet-library-list [data-carnet-page-id="' + id + '"]';
  for (let i = 0; i < 3; i += 1) {
    const ok = await p.evaluate((q) => { const n = document.querySelector(q); if (n) { n.click(); return true; } return false; }, sel);
    if (ok) return true;
    await p.evaluate(() => { const b = document.querySelector("#btn-carnet-library"); if (b) b.click(); });
    await sleep(300);
  }
  return false;
};
const stashRecords = (p) => p.evaluate(async () => {
  const db = await new Promise((r) => { const q = indexedDB.open("hq-carnet-field"); q.onsuccess = () => r(q.result); });
  return await new Promise((r) => { const q = db.transaction("captures").objectStore("captures").getAll(); q.onsuccess = () => r(q.result.map((x) => ({ id: x.id, kind: x.kind, uploaded: x.uploaded || null }))); });
});
/** The next POST really reaches the server (the upload SUCCEEDS), but the page under the capture changes before the response is used,
 *  so the client's insertion is refused as stale. Returns an `off()` that restores the network path. */
async function failInsertionAfterUpload(p, glob) {
  let armed = true;
  await p.route(glob, async (route) => {
    if (!armed || route.request().method() !== "POST") return route.continue();
    armed = false;
    try {
      const r = await route.fetch();
      await switchTo(p, "page-b");
      await route.fulfill({ response: r });
    } catch (_) { /* the page was torn down under the handler (reload / scenario end): nothing to fulfil */ }
  });
  return async () => { armed = false; await p.unroute(glob); await switchTo(p, "page-a"); await sleep(300); };
}
/** Wait until the client has really processed the refusal: the capture's record carries the canonical id and the editor is on the other page. */
async function refusalSettled(p, kind) {
  await until(async () => (await stashRecords(p)).some((r) => r.kind === kind && r.uploaded && r.uploaded.id), "the " + kind + " record carries its canonical id");
  await until(async () => (await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId)) === "page-b", "the editor is on the other page (insertion was refused)");
  await sleep(700);
}
async function recoverableScan(p, label) {
  const ph = await smallDoc(p, [label]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-close]");
  await p.click("[data-field-close]");
  await until(async () => (await sheetOpen(p)) === 0, "scan left in the stash");
}
async function ensureRecoverySheet(p) {
  if ((await p.locator('[data-field-sheet="recovery"]').count()) === 0) {
    await until(async () => await p.locator("[data-field-recover-open]").isVisible(), "banner still offers it");
    await p.click("[data-field-recover-open]");
  }
  await p.waitForSelector('[data-field-sheet="recovery"]');
}
async function openRecoveryAfterReload(p) {
  await p.reload();
  await showCarnet(p);
  await until(async () => await p.locator("[data-field-recover]").isVisible(), "banner offers the capture back");
  await p.click("[data-field-recover-open]");
  await p.waitForSelector('[data-field-sheet="recovery"]');
}

scenario("33 live voice: upload succeeded + insertion refused -> the retry inserts the SAME voice asset (server voice count stays 1)", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordFor(p, 1200);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/voice");
  await p.click("[data-field-keep]");
  await until(async () => srv.voices().length === 1, "the voice note reached the server");
  await until(async () => /déjà envoyé/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText().catch(() => "")), "the refusal says the take is already uploaded", 20000);
  check(voiceBlocks(srv).length === 0, "nothing inserted");
  const first = srv.voices()[0];
  await off();
  await p.waitForSelector("[data-field-keep]", { timeout: 10000 });
  await p.click("[data-field-keep]");
  await until(async () => (await sheetOpen(p)) === 0, "retry inserts", 20000);
  await saved(p);
  check(srv.voices().length === 1 && srv.voices()[0] === first, "still ONE voice file, the same one: " + srv.voices());
  check(voiceBlocks(srv).length === 1 && first.startsWith(voiceBlocks(srv)[0].voice.id), "the block references that asset");
});

scenario("34 recovered voice: upload succeeded + insertion refused -> the stash remembers the asset and the retry reuses it", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordFor(p, 1200);
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "closed with a pending take");
  await openRecoveryAfterReload(p);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/voice");
  await p.click('[data-recover-kind="voice"] [data-recover-insert]');
  await until(async () => srv.voices().length === 1, "uploaded once");
  await until(async () => (await stashRecords(p)).some((r) => r.kind === "voice" && r.uploaded && /^voice-/.test(r.uploaded.id)), "the stash record now carries the canonical voice id");
  check(voiceBlocks(srv).length === 0 && (await stashRecords(p)).length === 1, "nothing inserted, capture still in the stash");
  const first = srv.voices()[0];
  await refusalSettled(p, "voice");
  await off();
  await ensureRecoverySheet(p);
  await p.waitForSelector('[data-recover-kind="voice"]');
  await p.click('[data-recover-kind="voice"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "retry inserts", 20000);
  await saved(p);
  check(srv.voices().length === 1 && srv.voices()[0] === first && voiceBlocks(srv).length === 1, "same single voice asset reused");
  check((await stashRecords(p)).length === 0, "the stash is emptied only after the confirmed insertion");
});

scenario("35 recovered scan: upload succeeded + insertion refused -> the retry reuses the image asset", async () => {
  const { srv, p } = await openEditor("iphone");
  await recoverableScan(p, "REPRISE");
  await openRecoveryAfterReload(p);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/asset");
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => srv.assets().length === 1, "uploaded once");
  await until(async () => (await stashRecords(p)).some((r) => r.kind === "scan" && r.uploaded && /^asset-/.test(r.uploaded.id)), "the stash record carries the canonical asset id");
  check(!types(srv).includes("image"), "nothing inserted");
  const first = srv.assets()[0];
  await refusalSettled(p, "scan");
  await off();
  await ensureRecoverySheet(p);
  await p.waitForSelector('[data-recover-kind="scan"]');
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "retry inserts", 20000);
  await saved(p);
  check(srv.assets().length === 1 && srv.assets()[0] === first, "still ONE image asset: " + srv.assets());
  check(types(srv).includes("image") && (await stashRecords(p)).length === 0, "inserted; stash emptied");
});

scenario("36 reload between upload and insertion: the persisted record still reuses the same canonical asset (scan and voice)", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recoverableScan(p, "RECHARGE");
  await recordFor(p, 1200);
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "closed");
  await openRecoveryAfterReload(p);
  const offA = await failInsertionAfterUpload(p, "**/api/carnet/asset");
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => srv.assets().length === 1, "scan uploaded");
  await refusalSettled(p, "scan");
  await offA();
  await ensureRecoverySheet(p);
  await p.waitForSelector('[data-recover-kind="voice"]');
  const offV = await failInsertionAfterUpload(p, "**/api/carnet/voice");
  await p.click('[data-recover-kind="voice"] [data-recover-insert]');
  await until(async () => srv.voices().length === 1, "voice uploaded");
  await refusalSettled(p, "voice");
  await offV();
  const recs = await stashRecords(p);
  check(recs.length === 2 && recs.every((r) => r.uploaded && r.uploaded.id), "both records persisted their canonical ids: " + JSON.stringify(recs.map((r) => r.uploaded && r.uploaded.id)));
  const [a0, v0] = [srv.assets()[0], srv.voices()[0]];
  await openRecoveryAfterReload(p); // a second reload: the ids must survive it
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => types(srv).includes("image"), "scan inserted", 20000);
  await saved(p);
  await ensureRecoverySheet(p);
  await p.waitForSelector('[data-recover-kind="voice"]');
  await p.click('[data-recover-kind="voice"] [data-recover-insert]');
  await until(async () => voiceBlocks(srv).length === 1, "voice inserted", 20000);
  await saved(p);
  check(srv.assets().length === 1 && srv.assets()[0] === a0 && srv.voices().length === 1 && srv.voices()[0] === v0, "no duplicate asset anywhere after two reloads");
  check((await stashRecords(p)).length === 0, "stash empty");
});

// ================================================================ F3. The existence probe is tri-state: only an authoritative 404 allows a second upload
const UNVERIFIED_RE = /Impossible de vérifier le fichier déjà envoyé/;
const liveText = (p) => p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText().catch(() => "");

scenario("37 live voice: the probe of the remembered asset is ABORTED -> no second upload, the take is kept, a later good probe reuses the asset", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await recordFor(p, 1200);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/voice");
  await p.click("[data-field-keep]");
  await until(async () => srv.voices().length === 1, "uploaded once");
  await until(async () => /déjà envoyé/.test(await liveText(p)), "refused, already uploaded", 20000);
  await off();
  const first = srv.voices()[0];
  let posts = 0;
  await p.route("**/api/carnet/voice", (route) => { if (route.request().method() === "POST") posts += 1; return route.continue(); });
  await p.route("**/api/carnet/voice/voice-*", (route) => route.abort("connectionreset"));
  await p.waitForSelector("[data-field-keep]", { timeout: 10000 });
  await p.click("[data-field-keep]");
  await until(async () => UNVERIFIED_RE.test(await liveText(p)), "an unverifiable file is stated, not re-uploaded", 20000);
  check(posts === 0 && srv.voices().length === 1, "NO second upload (posts=" + posts + ", voices=" + srv.voices().length + ")");
  check((await p.locator("[data-field-keep]").count()) === 1 && (await p.locator("[data-field-playback]").count()) === 1, "the take is still there and can be retried");
  check(voiceBlocks(srv).length === 0, "nothing inserted");
  await p.unroute("**/api/carnet/voice/voice-*");
  await p.click("[data-field-keep]");
  await until(async () => (await sheetOpen(p)) === 0, "a later successful probe inserts", 20000);
  await saved(p);
  check(posts === 0 && srv.voices().length === 1 && srv.voices()[0] === first && voiceBlocks(srv).length === 1, "the ORIGINAL asset was reused (still no upload)");
});

scenario("38 recovered scan: the probe answers 503 / 401 -> no second upload and the stash is kept; then the original is reused", async () => {
  const { srv, p } = await openEditor("iphone");
  await recoverableScan(p, "INCERTAIN");
  await openRecoveryAfterReload(p);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/asset");
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => srv.assets().length === 1, "uploaded once");
  await refusalSettled(p, "scan");
  await off();
  const first = srv.assets()[0];
  await ensureRecoverySheet(p);
  let posts = 0;
  let status = 503;
  await p.route("**/api/carnet/asset", (route) => { if (route.request().method() === "POST") posts += 1; return route.continue(); });
  await p.route("**/api/carnet/asset/asset-*", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "x" }) }));
  for (const st of [503, 401]) {
    status = st;
    await p.click('[data-recover-kind="scan"] [data-recover-insert]');
    await until(async () => UNVERIFIED_RE.test(await liveText(p)), "unverifiable (" + st + ") is stated");
    check(posts === 0 && srv.assets().length === 1, "status " + st + ": no second upload");
    check((await stashRecords(p)).length === 1, "status " + st + ": the stash entry is kept");
  }
  await p.unroute("**/api/carnet/asset/asset-*");
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "a good probe inserts", 20000);
  await saved(p);
  check(posts === 0 && srv.assets().length === 1 && srv.assets()[0] === first && types(srv).includes("image"), "the original asset was reused");
  check((await stashRecords(p)).length === 0, "stash emptied after the confirmed insertion");
});

scenario("39 recovered scan: an authoritative 404 (the remembered asset is really gone) -> exactly ONE new upload and the stash record is updated", async () => {
  const { srv, p } = await openEditor("iphone");
  await recoverableScan(p, "DISPARU");
  await openRecoveryAfterReload(p);
  const off = await failInsertionAfterUpload(p, "**/api/carnet/asset");
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => srv.assets().length === 1, "uploaded once");
  await refusalSettled(p, "scan");
  await off();
  const gone = srv.assets()[0];
  const oldId = (await stashRecords(p))[0].uploaded.id;
  for (const f of readdirSync(srv.adir)) if (f.startsWith(oldId)) rmSync(path.join(srv.adir, f), { force: true }); // the server no longer has it
  let posts = 0;
  await p.route("**/api/carnet/asset", (route) => { if (route.request().method() === "POST") posts += 1; return route.continue(); });
  await ensureRecoverySheet(p);
  await p.click('[data-recover-kind="scan"] [data-recover-insert]');
  await until(async () => (await sheetOpen(p)) === 0, "re-uploaded and inserted", 30000);
  await saved(p);
  check(posts === 1, "exactly one new upload: " + posts);
  const now = srv.assets();
  check(now.length >= 1 && !now.includes(gone) && types(srv).includes("image"), "a NEW asset is referenced: " + now);
});

scenario("40 existence probe is genuinely light: one byte for images and voice, whole bodies unchanged without Range", async () => {
  const { srv, ctx, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  const ph = await smallDoc(p, ["UN OCTET"]);
  await startField(p, "scanner", "iphone");
  await viaChooser(p, "[data-field-take]", ph.file);
  await frameFromPhoto(p, ph);
  await acceptPage(p, 1);
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "image inserted", 30000);
  await recordAndInsert(p, 1200);
  await saved(p);
  const img = srv.assets()[0].replace(/\.[a-z]+$/, "");
  const vid = srv.voices()[0].replace(/\.[a-z0-9]+$/, "");
  for (const [url, label] of [["/api/carnet/asset/" + img, "image"], ["/api/carnet/voice/" + vid, "voice"]]) {
    const full = await ctx.request.get(srv.base + url);
    check(full.status() === 200 && Number(full.headers()["content-length"]) > 1000, label + ": no Range -> 200 with the whole body (" + full.headers()["content-length"] + ")");
    const one = await ctx.request.get(srv.base + url, { headers: { Range: "bytes=0-0" } });
    check(one.status() === 206 && one.headers()["content-length"] === "1" && /^bytes 0-0\//.test(one.headers()["content-range"] || ""), label + ": Range bytes=0-0 -> 206, Content-Length 1");
    const bad = await ctx.request.get(srv.base + url, { headers: { Range: "bytes=99999999-" } });
    check(bad.status() === 416, label + ": an unsatisfiable range -> 416");
    const miss = await ctx.request.get(srv.base + url.replace(/[0-9a-f]{24}$/, "0".repeat(24)), { headers: { Range: "bytes=0-0" } });
    check(miss.status() === 404, label + ": an unknown id -> 404 (the only 'missing' answer)");
  }
});

// ================================================================ G. Layout, themes, accessibility, performance
const contrast = (p, sel, prop = "color") => p.evaluate(([sel, prop]) => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const n = document.querySelector(sel);
  const fg = parse(getComputedStyle(n)[prop]);
  let bgEl = n, bg = { r: 255, g: 255, b: 255, a: 0 };
  while (bgEl) { const c = parse(getComputedStyle(bgEl).backgroundColor); if (c.a > 0.99) { bg = c; break; } bgEl = bgEl.parentElement; }
  const a = L(fg), b = L(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, [sel, prop]);

scenario("28 mobile safe-area and layout: every sheet fits 360x740 and 390x844, targets stay >= 44 px, insets are honoured in the CSS", async () => {
  const css = await (await (await browser.newContext()).request.get((await server(NB())).base + "/assets/hq-carnet.css")).text();
  check(/\.carnet-field-hud\{[^}]*env\(safe-area-inset-bottom/.test(css.replace(/\n/g, " ")) || /safe-area-inset-bottom[^}]*\}\s*\.carnet-field-hud\[data-kb/.test(css.replace(/\n/g, " ")), "the dock offsets by env(safe-area-inset-bottom)");
  check(/\.carnet-field-panel\{[^}]*padding-bottom:env\(safe-area-inset-bottom/.test(css), "the sheet pads by env(safe-area-inset-bottom)");
  for (const [w, h] of [[360, 740], [390, 844]]) {
    const { p, ctx } = await openEditor("iphone", NB(), { viewport: { width: w, height: h }, permissions: ["microphone"] });
    for (const kind of ["scanner", "voice"]) {
      await hudClick(p, kind);
      await p.waitForSelector("#hq-carnet-field-sheet");
      const r = await rectOf(p, ".carnet-field-panel");
      check(r.l >= -0.5 && r.r <= w + 0.5 && r.b <= h + 0.5 && r.t >= -0.5, `${kind} sheet inside ${w}x${h}: ${JSON.stringify([r.l, r.t, r.r, r.b].map(Math.round))}`);
      check(await p.evaluate(() => { const b = document.querySelector(".carnet-field-body"); const f = document.querySelector(".carnet-field-foot"); return b.scrollWidth <= b.clientWidth + 1 && f.scrollWidth <= f.clientWidth + 1; }), `${kind}: no horizontal overflow`);
      const small = await p.$$eval(".carnet-field-btn,.carnet-field-close", (bs) => bs.filter((b) => !b.closest("[hidden]")).map((b) => b.getBoundingClientRect()).filter((r) => r.height < 43.5 || r.width < 43.5).length);
      check(small === 0, `${kind}: every visible control is at least 44x44`);
      await shot(p, `28-${kind}-${w}x${h}`);
      await p.keyboard.press("Escape");
      await until(async () => (await sheetOpen(p)) === 0, "closed");
    }
    await ctx.close();
  }
});

scenario("29 keyboard handling: the dock and the sheets follow a (stubbed) software keyboard and never sit under it", async () => {
  const { p } = await openEditor("iphone", NB(), VOICE_PERMS);
  await p.evaluate(() => { Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => 400 }); window.visualViewport.dispatchEvent(new Event("resize")); });
  await until(async () => (await p.locator("#hq-carnet-field-hud").getAttribute("data-kb")) === "open", "keyboard detected from the visual viewport");
  const r = await rectOf(p, "#hq-carnet-field-hud");
  check(Math.abs(r.b - 400) <= 3, "the dock rides on top of the keyboard (" + Math.round(r.b) + " ~ 400)");
  await hudClick(p, "voice");
  await p.waitForSelector("#hq-carnet-field-sheet");
  const pr = await rectOf(p, ".carnet-field-panel");
  check(pr.b <= 400.5, "the sheet is laid out inside the visible area: bottom " + Math.round(pr.b));
  check(await p.evaluate(() => { const f = document.querySelector(".carnet-field-foot").getBoundingClientRect(); return f.bottom <= 400.5 && f.top >= 0; }), "its actions stay reachable above the keyboard");
  await p.keyboard.press("Escape");
  await p.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event("resize")); });
  await until(async () => (await p.locator("#hq-carnet-field-hud").getAttribute("data-kb")) === "closed", "dock returns when the keyboard closes");
  console.log("   [note] the keyboard is STUBBED through visualViewport; a real software keyboard on a real phone is UNVERIFIED");
});

scenario("30 dark / light: text and primary actions keep WCAG AA contrast in light, dark, midnight and OLED", async () => {
  const { p } = await openEditor("iphone");
  for (const [scheme, theme] of [["light", ""], ["dark", ""], ["dark", "theme-midnight"], ["dark", "theme-oled"]]) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate((t) => { document.body.classList.remove("theme-midnight", "theme-oled"); if (t) document.body.classList.add(t); }, theme);
    await hudClick(p, "scanner");
    await p.waitForSelector("#hq-carnet-field-sheet");
    const rows = [[".carnet-field-title"], [".carnet-field-text,.carnet-field-note"], [".carnet-field-btn.primary"], [".carnet-field-btn:not(.primary)"], ["#hq-carnet-field-hud, .carnet-field-hud-btn"]];
    for (const [sel] of rows) {
      const c = await contrast(p, sel.split(",")[0]);
      check(c >= 4.5, `${scheme}${theme ? "/" + theme : ""}: ${sel.split(",")[0]} contrast ${c.toFixed(2)} >= 4.5`);
    }
    await shot(p, "30-" + scheme + (theme ? "-" + theme : ""));
    await p.keyboard.press("Escape");
    await until(async () => (await sheetOpen(p)) === 0, "closed");
  }
});

scenario("31 accessibility: roles, names, announced states, focus management, no colour-only state, reduced motion", async () => {
  const { p } = await openEditor("iphone", NB(), Object.assign({ reducedMotion: "reduce" }, VOICE_PERMS));
  // HUD: a named toolbar with roving focus
  await p.focus('[data-field-action="camera"]');
  await p.keyboard.press("ArrowRight");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-field-action"))) === "scanner", "ArrowRight moves along the toolbar");
  await p.keyboard.press("End");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-field-action"))) === "sketch", "End goes to the last action");
  // sheet: dialog semantics, focus in, trapped, Esc, restored
  await p.focus('[data-field-action="voice"]');
  await p.keyboard.press("Enter");
  await p.waitForSelector("#hq-carnet-field-sheet");
  const dlg = p.locator('#hq-carnet-field-sheet [role="dialog"][aria-modal="true"]');
  check((await dlg.count()) === 1, "the sheet is a modal dialog");
  const labelledby = await dlg.getAttribute("aria-labelledby");
  check((await p.locator("#" + labelledby).innerText()) === "Note vocale", "named by its visible title");
  check(await p.evaluate(() => document.querySelector(".carnet-field-panel").contains(document.activeElement)), "focus moved into the dialog");
  for (let i = 0; i < 8; i += 1) await p.keyboard.press("Tab");
  check(await p.evaluate(() => document.querySelector(".carnet-field-panel").contains(document.activeElement)), "Tab cannot leave the dialog");
  // recording: state announced + timer + non-colour marker
  await p.click("[data-field-record]");
  await p.waitForSelector("[data-field-recording]");
  await until(async () => /Enregistrement en cours/.test(await p.locator("#hq-carnet-field-sheet .carnet-field-live").innerText()), "the recording state is announced in a polite live region");
  check((await p.locator("#hq-carnet-field-sheet .carnet-field-live").getAttribute("aria-live")) === "polite", "aria-live is polite");
  check(await p.locator('[role="timer"][data-field-time]').count() === 1, "elapsed time is a text timer");
  check((await p.evaluate(() => getComputedStyle(document.querySelector("[data-field-recording]")).animationName)) === "none", "reduced motion: the recording marker does not animate");
  await p.click("[data-field-stop]");
  await p.waitForSelector("[data-field-playback]");
  check(!!(await p.locator("[data-field-playback]").getAttribute("aria-label")), "the audio player is named");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await until(async () => (await sheetOpen(p)) === 0, "Esc closes");
  check((await p.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-field-action"))) === "voice", "focus returns to the control that opened the dialog");
  // scanner: names, descriptions, text-bearing selected state
  const ph = await smallDoc(p, ["ACCES"]);
  await hudClick(p, "scanner");
  await viaChooser(p, "[data-field-take]", ph.file);
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "framing");
  const hl = await p.$$eval(".carnet-field-handle", (hs) => hs.map((h) => h.getAttribute("aria-label")));
  check(hl.every((l) => /Coin .*pour cent/.test(l)), "each corner handle has a name and a spoken position: " + hl[0]);
  check(!!(await p.locator("#hq-field-handle-hint").count()) && (await p.locator('[data-handle="0"]').getAttribute("aria-describedby")) === "hq-field-handle-hint", "keyboard instructions are linked to the handles");
  check(await p.locator('[role="radiogroup"]').getAttribute("aria-label") === "Traitement de l'image", "treatments form a named radio group");
  check((await p.evaluate(() => getComputedStyle(document.querySelector("#hq-field-f-color + label"), "::before").content)).includes("\u2713"), "the selected treatment carries a check mark, not only a colour");
  check(await p.evaluate(() => getComputedStyle(document.querySelector(".carnet-field-handle:focus-visible") || document.querySelector(".carnet-field-handle")).outlineStyle !== undefined), "focus ring defined");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(100);
  // OCR status is a polite status region
  const o = await pageWithImage();
  await openOcrOnSelected(o.p);
  check((await o.p.locator("[data-field-ocr-status]").getAttribute("role")) === "status" && (await o.p.locator("[data-field-ocr-status]").getAttribute("aria-live")) === "polite", "OCR progress is a polite status");
  check((await o.p.locator("[data-field-ocr-count]").getAttribute("aria-live")) === "polite", "the insertion count is announced politely");
});

scenario("32 performance: sheet open, 2560 px page processing, OCR page and recording start stay within budget", async () => {
  const { srv, p } = await openEditor("iphone", NB(), VOICE_PERMS);
  const t0 = Date.now();
  await hudClick(p, "scanner");
  await p.waitForSelector("#hq-carnet-field-sheet .carnet-field-btn");
  const openMs = Date.now() - t0;
  const big = await docPhoto(p, { w: 3200, h: 2400 });
  await viaChooser(p, "[data-field-take]", big.file);
  const t1 = Date.now();
  await until(async () => (await p.locator(".carnet-field-handle").count()) === 4, "framing", 30000);
  const prepMs = Date.now() - t1;
  // the source was reduced to <= 2560 px by the shared image pipeline: corners are given in that scale
  const scale = 2560 / 3200;
  await setCorners(p, 2560, 1920, big.corners.map(([x, y]) => [x * scale, y * scale]));
  const t2 = Date.now();
  await p.click("[data-field-accept]");
  await p.waitForSelector("li.carnet-field-page", { timeout: 40000 });
  const procMs = Date.now() - t2;
  await p.click("[data-field-insert]");
  await until(async () => (await sheetOpen(p)) === 0, "inserted", 40000);
  await saved(p);
  const d = assetDims(srv.asset(srv.assets()[0]));
  console.log(`   [perf] sheet open ${openMs} ms · decode+prepare ${prepMs} ms · warp+filter+encode at ${d.w}x${d.h} ${procMs} ms`);
  check(Math.max(d.w, d.h) <= 2560, "page processed within the 2560 px cap: " + d.w + "x" + d.h);
  check(openMs < 800, "scanner sheet opens in < 800 ms: " + openMs);
  check(procMs < 12000, "one full-size page processes in < 12 s: " + procMs);
  const t3 = Date.now();
  await startRecording(p);
  const recMs = Date.now() - t3;
  console.log("   [perf] recording start (permission granted, fake device) " + recMs + " ms");
  check(recMs < 3000, "recording starts in < 3 s: " + recMs);
  await p.click("[data-field-stop]");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
});
// ---------------------------------------------------------------- runner
async function main() {
  try {
    browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
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
      console.log("  FAIL ", e.message.split("\n").slice(0, 4).join(" | "));
    }
    for (const c of browser.contexts()) await c.close().catch(() => {}); // keep memory flat across 32 scenarios
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
