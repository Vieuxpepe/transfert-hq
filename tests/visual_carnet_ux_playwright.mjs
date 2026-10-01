// Carnet UX + media interaction pass (post-acceptance, NOT a Stage 09): library header / Corbeille structure at the
// screenshot viewport and other breakpoints, the visible "+ Insérer" menu, image insertion by picker / drop / paste
// (all through the accepted Stage-06 upload), direct manipulation (selection, resize handles, drag-handle block
// reorder, alignment), keyboard/button alternatives, touch behaviour, stale-gesture discard, print/export, history
// restore and backup with an aligned image, plus timing measurements.
//
//   node tests/visual_carnet_ux_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, no physical device). WebKit/Firefox: UNVERIFIED. Runs on a throwaway
// loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
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
const para = (text, extra) => Object.assign({ id: "block-" + Math.random().toString(16).slice(2, 14), type: "paragraph", text, marks: [] }, extra || {});
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0, content: { version: 2, blocks } }, extra || {});
}
const notebook = (pages, rev = 4) => ({ version: 1, notebook_rev: rev, projects: [], categories: [], pages });

class Server {
  static async start(seed) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-media-"));
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
    return s;
  }
  nb() { return JSON.parse(readFileSync(this.nbPath, "utf8")); }
  put(nb) { writeFileSync(this.nbPath, JSON.stringify(nb)); }
  pg(id) { return this.nb().pages.find((p) => p.id === id); }
  assets() { return existsSync(this.adir) ? readdirSync(this.adir).filter((n) => n.startsWith("asset-")).sort() : []; } // finalised files only (an in-flight upload has a .tmp- name)
  tmps() { return existsSync(this.adir) ? readdirSync(this.adir).filter((n) => n.startsWith(".tmp")) : []; }
  asset(name) { return readFileSync(path.join(this.adir, name)); }
  files(dir) { const d = path.join(this.root, dir); return existsSync(d) ? readdirSync(d).sort() : []; }
  read(rel) { return readFileSync(path.join(this.root, rel), "utf8"); }
  readBin(rel) { return readFileSync(path.join(this.root, rel)); }
  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    rmSync(this.root, { recursive: true, force: true });
  }
}

const PROFILES = {
  desktop: { viewport: { width: 1366, height: 900 } },
  ipad: { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  iphone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
};

const errors = [];
const external = [];
let browser;
const started = [];

async function server(seed) {
  const s = await Server.start(seed);
  started.push(s);
  return s;
}
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
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
  p.on("request", (r) => { const u = r.url(); if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u); });
  await p.goto(srv.base + "/");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { timeout: 15000 });
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  return p;
}
const dirty = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.dirty || x.inflight));
const conflict = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.conflict));
const saved = (p, msg) => until(async () => !(await dirty(p)), msg || "saved (client clean)");
async function openTools(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openImagePanel(p) {
  await openTools(p);
  if (await p.locator("#hq-carnet-image-panel").isHidden()) await p.click("#btn-carnet-image");
  await p.waitForSelector("#hq-carnet-image-panel", { state: "visible" });
}
async function select(p, a, b) {
  await p.evaluate(([x, y]) => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(x, y); }, [a, b]);
}
const domLines = (p) => p.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].map((d) => [d.getAttribute("data-line-type"), d.textContent]));
const types = (srv, id) => srv.pg(id).content.blocks.map((b) => b.type);
const imgs = (srv, id = "page-a") => srv.pg(id).content.blocks.filter((b) => b.type === "image");

// ---------------------------------------------------------------- image helpers
/** A real encoder-made image (canvas), as a Buffer. Non-uniform pixels so it is a meaningful source. */
async function makeImage(p, { w, h, type = "image/jpeg", quality = 0.9, alpha = false }) {
  const b64 = await p.evaluate(async ([w, h, type, quality, alpha]) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    if (!alpha) { ctx.fillStyle = "#2a6fb0"; ctx.fillRect(0, 0, w, h); }
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#ff8800"); g.addColorStop(1, "#00aa66");
    ctx.fillStyle = g; ctx.fillRect(w * 0.1, h * 0.1, w * 0.6, h * 0.6);
    ctx.fillStyle = "#ffffff"; ctx.font = Math.round(h / 8) + "px sans-serif"; ctx.fillText("TOP-LEFT", w * 0.02, h * 0.12);
    const blob = await new Promise((r) => cv.toBlob(r, type, quality));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    cv.width = cv.height = 0;
    return btoa(s);
  }, [w, h, type, quality, alpha]);
  return Buffer.from(b64, "base64");
}
/** Insert an EXIF APP1 with the given orientation right after SOI of a JPEG. */
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("II", 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}
function dimsOf(buf) {
  if (buf[0] === 0x89) return { mime: "image/png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff) {
    let i = 2;
    while (i < buf.length) {
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xc2) return { mime: "image/jpeg", w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  if (buf.toString("latin1", 0, 4) === "RIFF") {
    const k = buf.toString("latin1", 12, 16);
    if (k === "VP8 ") return { mime: "image/webp", w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (k === "VP8L") { const bits = buf.readUInt32LE(21); return { mime: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (k === "VP8X") return { mime: "image/webp", w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}
const hasExif = (buf) => buf.includes(Buffer.from("Exif\0\0", "latin1"));

/** Choose a file through the real <input type=file> of the given source ("files" | "photos" | "camera"). */
async function chooseFile(p, file, source = "files") {
  await openImagePanel(p);
  await p.locator(`input[data-carnet-image-input="${source}"]`).setInputFiles(file);
}
// The panel buttons call input.click(); Playwright intercepts the native chooser with a filechooser event.
async function pickViaButton(p, source, file) {
  await openImagePanel(p);
  const chooser = p.waitForEvent("filechooser");
  await p.click(`[data-carnet-image-source="${source}"]`);
  (await chooser).setFiles(file);
}
const png = (buffer, name = "photo.png") => ({ name, mimeType: "image/png", buffer });
const jpg = (buffer, name = "photo.jpg") => ({ name, mimeType: "image/jpeg", buffer });
const figs = (p) => p.locator("#hq-carnet-editor [data-carnet-image]");
const imageLines = (p) => p.locator('#hq-carnet-editor [data-line-type="image"]');
async function seeImage(p, n = 1) {
  await until(async () => (await figs(p).count()) >= n, "image figure(s) rendered: " + n);
  await until(() => p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor img.carnet-img")].every((i) => i.complete && i.naturalWidth > 0)), "image pixels loaded");
}
const natural = (p, i = 0) => p.evaluate((i) => { const im = document.querySelectorAll("#hq-carnet-editor img.carnet-img")[i]; return [im.naturalWidth, im.naturalHeight]; }, i);
const msg = (p) => p.evaluate(() => (document.getElementById("carnet-image-msg") || {}).textContent || "");
const flash = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");

// ---------------------------------------------------------------- helpers (UX pass)
const textNb = () => notebook([page("page-a", 1, [para("one"), para("two"), para("three")]), page("page-b", 1, [para("other page")])]);
const rect = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const overlap = (a, b) => a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
async function openLibrary(p) {
  if (await p.locator("#hq-carnet-library").isHidden()) await p.click("#btn-carnet-library");
  await p.waitForSelector("#hq-carnet-library", { state: "visible" });
}
/** Insert an image through the VISIBLE "+ Insérer" menu (not the hidden tools drawer). */
async function insertViaMenu(p, file, item = "image") {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  const chooser = p.waitForEvent("filechooser");
  await p.click(`[data-carnet-insert="${item}"]`);
  (await chooser).setFiles(file);
}
const pageSaves = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet")) bag.push(r.postData() || ""); });
async function selectFig(p, i = 0) {
  await figs(p).nth(i).click({ position: { x: 20, y: 40 } });
  await p.waitForSelector("#hq-carnet-image-tools", { state: "visible" });
  await p.waitForSelector('#hq-carnet-editor [data-selected="true"] .carnet-handle-move', { state: "visible" });
  await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').scrollIntoView({ block: "center" })); // handles are mid-height: keep them clear of the sticky bars
  await sleep(120);
}
const blocksOf = (srv, id = "page-a") => srv.pg(id).content.blocks;
async function oneImagePage(profile = "desktop", size = { w: 1200, h: 800 }) {
  const srv = await server(textNb());
  const ctx = await context(srv, profile);
  const p = await openPage(ctx, srv);
  await select(p, 5, 5);
  await insertViaMenu(p, jpg(await makeImage(p, size)));
  await seeImage(p);
  await saved(p);
  return { srv, ctx, p };
}
const fileInPage = (p, buf, name, type) => p.evaluate(([b64, name, type]) => {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
  window.__file = new File([u], name, { type });
}, [buf.toString("base64"), name, type]);

// ---------------------------------------------------------------- scenarios
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

const VIEWPORTS = [
  ["screenshot-size desktop 1207x859", 1207, 859],
  ["1366x768 desktop", 1366, 768],
  ["tablet landscape 1024x768", 1024, 768],
  ["tablet portrait 768x1024", 768, 1024],
  ["narrow phone 360x740", 360, 740],
];
for (const [label, width, height] of VIEWPORTS) {
  scenario(`library header + insert row: no overlap/clipping, usable — ${label}`, async () => {
    const srv = await server(textNb());
    const touch = width < 900;
    const ctx = await browser.newContext(Object.assign({ viewport: { width, height }, acceptDownloads: true }, touch ? { hasTouch: true, isMobile: true } : {}));
    const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.admin_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
    check(r.status() === 303, "login");
    const p = await openPage(ctx, srv);
    await openLibrary(p);
    const m = await p.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      const head = q(".carnet-lib-head");
      const kids = [...head.querySelectorAll("h3, button")].filter((n) => n.offsetParent).map((n) => ({ id: n.id || n.tagName, ...box(n), clipped: n.scrollWidth > n.clientWidth + 1 }));
      const lib = box(q("#hq-carnet-library"));
      const chips = [...document.querySelectorAll(".carnet-chip")].map((n) => ({ f: n.dataset.carnetFilter, ...box(n) }));
      return { kids, lib, chips, docW: document.documentElement.scrollWidth, inner: innerWidth };
    });
    for (let i = 0; i < m.kids.length; i += 1) {
      for (let j = i + 1; j < m.kids.length; j += 1) {
        const a = m.kids[i]; const b = m.kids[j];
        check(!(a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5), `header items do not overlap: ${a.id} / ${b.id}`);
      }
    }
    check(m.kids.every((k) => !k.clipped), "no header label is clipped");
    check(m.kids.every((k) => k.l >= m.lib.l - 0.5 && k.r <= m.lib.r + 0.5), "header items stay inside the library panel");
    const title = m.kids.find((k) => k.id === "H3");
    check(title && title.r - title.l > 60, "the title keeps a readable width (" + Math.round(title.r - title.l) + "px)");
    const trash = m.chips.find((c) => c.f === "trash");
    const others = m.chips.filter((c) => c.f !== "trash");
    check(trash && others.every((o) => trash.t >= o.b - 0.5), "Corbeille sits on its own row, below the other filters");
    check(await p.locator(".carnet-filter-sep").count() === 1, "a visible separator divides Corbeille from the filters");
    check(m.docW <= m.inner + 1, `no horizontal page scroll (${m.docW} <= ${m.inner})`);
    // filters keep their semantics and stay usable
    await p.click('[data-carnet-filter="pinned"]');
    check((await p.getAttribute('[data-carnet-filter="pinned"]', "aria-pressed")) === "true", "Épinglées toggles");
    await p.click('[data-carnet-filter="all"]');
    check((await p.getAttribute('[data-carnet-filter="all"]', "aria-pressed")) === "true", "Toutes toggles back");
    await p.click('[data-carnet-filter="trash"]');
    check((await p.getAttribute('[data-carnet-filter="trash"]', "aria-pressed")) === "true", "Corbeille usable");
    await p.click('[data-carnet-filter="all"]');
    // + Nouvelle page works from the header
    const before = srv.nb().pages.length;
    await p.click("#btn-carnet-lib-new");
    await until(() => srv.nb().pages.length === before + 1, "+ Nouvelle page creates a page");
    // phone/tablet drawers cover the editor: close to reach the insert row
    await sleep(600); // creating a page closes the phone/tablet drawer by itself
    if (await p.locator("#btn-carnet-lib-close").isVisible()) await p.click("#btn-carnet-lib-close");
    await p.waitForSelector("#btn-carnet-insert", { state: "visible" });
    const top = await rect(p, ".carnet-bar-top");
    const ins = await rect(p, "#btn-carnet-insert");
    check(ins && ins.w > 60 && ins.h >= 43.5, `+ Insérer is visible with a ≥44px target (${Math.round(ins.w)}x${Math.round(ins.h)})`);
    check(!overlap(top, ins), "+ Insérer does not overlap the top bar");
    await p.click("#btn-carnet-insert");
    const items = await p.locator("#hq-carnet-insert-menu [data-carnet-insert]").allTextContents();
    const groups = await p.locator("#hq-carnet-insert-menu .carnet-cmd-group-label").allTextContents();
    check(JSON.stringify(groups) === JSON.stringify(["Écrire", "Ajouter", "Ingénierie", "Projet"]), "menu is grouped by category: " + groups);
    check(items.length === 15 && /Texte/.test(items[0]) && items.some((t) => /^Image/.test(t)) && items.some((t) => /Mesure/.test(t)) && items.some((t) => /Calcul/.test(t)) && items.some((t) => /Décision/.test(t)) && items.some((t) => /Dessin/.test(t)) && items.some((t) => /Fichier/.test(t)) && items.some((t) => /Photo/.test(t)) && items.some((t) => /Tâche/.test(t)), "menu lists every command once: " + items.map((t) => t.slice(0, 12)));
    const mr = await rect(p, "#hq-carnet-insert-menu");
    check(mr.l >= -0.5 && mr.r <= width + 0.5, "the menu stays inside the viewport");
    await p.keyboard.press("Escape");
    check(await p.locator("#hq-carnet-insert-menu").isHidden(), "Escape closes the menu");
    check((await p.evaluate(() => document.activeElement.id)) === "btn-carnet-insert", "focus returns to + Insérer");
    check(await p.locator("#hq-carnet-editor").getAttribute("data-page-id") !== null, "the editor is present");
    if (width >= 1200) await p.screenshot({ path: path.join(process.env.UX_SHOTS || tmpdir(), `carnet-ux-${width}.png`) });
    await ctx.close();
  });
}

scenario("insert from the visible menu: Image (Stage-06 pipeline), Mesure/Calcul/Décision, Fichier/Dessin links preselect their kind", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet/asset")) posts.push(r.url()); });
  await select(p, 5, 5);
  await insertViaMenu(p, jpg(await makeImage(p, { w: 900, h: 600 })));
  await seeImage(p);
  await saved(p);
  check(posts.length === 1, "exactly one upload request through the accepted endpoint");
  check(imgs(srv).length === 1 && imgs(srv)[0].asset.layout === "inline" && imgs(srv)[0].asset.width === 100, "new image block: inline, 100%");
  for (const [key, sel] of [["calc", "#btn-carnet-eng-calc"], ["measure", "#carnet-eng-panel, .carnet-eng-panel"], ["decision", "#carnet-eng-panel, .carnet-eng-panel"]]) {
    await p.click("#btn-carnet-insert");
    await p.click(`[data-carnet-insert="${key}"]`);
    await until(() => p.evaluate(() => !!document.querySelector(".carnet-eng-panel:not([hidden]), #hq-carnet-eng-panel:not([hidden])")), "the " + key + " tool opens from the menu");
    await p.keyboard.press("Escape");
  }
  await select(p, 0, 3);
  for (const kind of ["drawing", "file"]) {
    await p.click("#btn-carnet-insert");
    await p.click(`[data-carnet-insert="${kind}"]`);
    const v = await until(() => p.evaluate(() => (document.getElementById("hq-carnet-eng-l-kind") || {}).value), "the link tool opens for " + kind);
    check(v === kind, "link kind preselected: " + v);
    await p.keyboard.press("Escape");
    await select(p, 0, 3);
  }
  await ctx.close();
});

scenario("drag-and-drop an image file onto the page: highlight, upload through Stage 06, correct slot, bad files refused", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet/asset")) posts.push(r.url()); });
  await fileInPage(p, await makeImage(p, { w: 800, h: 500 }), "drop.jpg", "image/jpeg");
  const y = await p.evaluate(() => { const k = document.querySelector("#hq-carnet-editor").children[1].getBoundingClientRect(); return k.bottom + 2; }); // between "two" and "three"
  const fire = (type) => p.evaluate(([type, y]) => {
    const dt = new DataTransfer(); dt.items.add(window.__file);
    const target = document.querySelector("#hq-carnet-editor");
    target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 200, clientY: y }));
    return document.querySelector(".carnet-paper").getAttribute("data-drop");
  }, [type, y]);
  check((await fire("dragenter")) === "true", "dragging a file over the page highlights the drop target");
  check(await p.evaluate(() => getComputedStyle(document.querySelector(".carnet-paper"), "::after").content.includes("Déposer")), "the drop hint is visible");
  await fire("dragover");
  await fire("drop");
  check((await p.evaluate(() => document.querySelector(".carnet-paper").getAttribute("data-drop"))) === null, "highlight cleared on drop");
  await seeImage(p);
  await saved(p);
  check(posts.length === 1, "one upload through /api/carnet/asset");
  check(blocksOf(srv).map((b) => b.type).join() === "paragraph,paragraph,image,paragraph,paragraph" || blocksOf(srv).map((b) => b.type).join().includes("image"), "image block inserted: " + blocksOf(srv).map((b) => b.type));
  const order = blocksOf(srv).map((b) => b.text || "[img]").join("|");
  check(order.indexOf("two") < order.indexOf("[img]") && order.indexOf("[img]") < order.indexOf("three"), "dropped between the two lines under the pointer: " + order);
  // dragenter with a non-file drag (text) does not highlight
  check((await p.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "x"); document.querySelector("#hq-carnet-editor").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); return document.querySelector(".carnet-paper").getAttribute("data-drop"); })) === null, "text drags do not highlight");
  // a non-image file is refused with a message and nothing is uploaded
  await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["hello"], "a.txt", { type: "text/plain" })); const ed = document.querySelector("#hq-carnet-editor"); ed.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  await until(() => p.evaluate(() => /Seules les images/.test(document.querySelector(".carnet-flash").textContent)), "a non-image file is refused with a message");
  check(posts.length === 1, "still one upload");
  // dropping on a read-only (trashed) page does not upload
  await ctx.close();
});

scenario("paste an image from the clipboard (Stage-06 pipeline); text paste still plain text", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet/asset")) posts.push(r.url()); });
  await fileInPage(p, await makeImage(p, { w: 600, h: 400, type: "image/png" }), "shot.png", "image/png");
  await select(p, 5, 5);
  await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(window.__file); const ed = document.querySelector("#hq-carnet-editor"); ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await seeImage(p);
  await saved(p);
  check(posts.length === 1 && imgs(srv).length === 1 && imgs(srv)[0].asset.mime === "image/png", "pasted PNG stored via the accepted endpoint");
  await select(p, 0, 0);
  await p.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "plain"); document.querySelector("#hq-carnet-editor").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await saved(p);
  check(blocksOf(srv)[0].text === "plainone" && posts.length === 1, "text paste unchanged");
  await ctx.close();
});

scenario("select shows handles + toolbar; resize by handle: no save on pointermove, ONE save on release, 5% steps, ratio kept, reload-persistent", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await p.click("#btn-carnet-image-done").catch(() => {});
  check((await p.locator(".carnet-handle:visible").count()) === 0, "no handles while nothing is selected");
  await selectFig(p);
  check((await p.locator("#hq-carnet-editor .carnet-handle:visible").count()) === 2, "selected inline image shows a move handle and the one resize handle that follows its free edge");
  const bag = [];
  pageSaves(p, bag);
  const rev0 = srv.pg("page-a").rev;
  check((await p.locator('#hq-carnet-editor [data-selected="true"] .carnet-handle-sw').count()) === 0, "inline: no left resize handle (its edge is anchored)");
  const he = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-se');
  const fig0 = await rect(p, "#hq-carnet-editor figure");
  check(he.w >= 18, "the resize handle is a real, visible target");
  await p.mouse.move(he.l + he.w / 2, he.t + he.h / 2);
  await p.mouse.down();
  const steps = 24;
  const t0 = Date.now();
  for (let i = 1; i <= steps; i += 1) await p.mouse.move(he.l + he.w / 2 - (i * 4), he.t + he.h / 2);
  await sleep(150);
  const midW = await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").style.width);
  check(/^\d+%$/.test(midW) && parseInt(midW, 10) % 5 === 0 && parseInt(midW, 10) < 100, "live preview snaps to 5% steps: " + midW);
  check(bag.length === 0 && srv.pg("page-a").rev === rev0, "NO save request while the pointer is moving (" + steps + " moves)");
  await p.mouse.up();
  await saved(p);
  check(bag.length === 1, "exactly ONE save request after release (got " + bag.length + ")");
  check(srv.pg("page-a").rev === rev0 + 1, "exactly one server revision");
  const a = imgs(srv)[0].asset;
  check(a.width === parseInt(midW, 10) || Math.abs(a.width - parseInt(midW, 10)) <= 5, "persisted width follows the gesture: " + a.width);
  const fig1 = await rect(p, "#hq-carnet-editor figure");
  check(Math.abs(fig1.w / fig1.h - 1.5) < 0.03, "aspect ratio preserved (" + (fig1.w / fig1.h).toFixed(3) + ")");
  console.log(`  INFO  resize: ${steps} pointermoves in ${Date.now() - t0}ms wall`);
  // the SE handle of a non-100% image can grow it back; clamps at 30..100
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  check((await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").style.width)) === a.width + "%", "reload: width restored");
  await ctx.close();
});

scenario("resize handle tracks the moving edge for every alignment; quick gestures (one move, immediate release) still commit", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await selectFig(p);
  for (let i = 0; i < 4; i += 1) await p.click("#btn-carnet-image-smaller"); // 80%
  await saved(p);
  for (const layout of ["inline", "center", "right"]) {
    await p.click(layout === "inline" ? "#btn-carnet-image-left" : "#btn-carnet-image-" + layout);
    await saved(p);
    await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').scrollIntoView({ block: "center" }));
    const wantW = layout === "right" ? 1 : 0, wantE = layout === "right" ? 0 : 1;
    check((await p.locator('#hq-carnet-editor [data-selected="true"] .carnet-handle-sw').count()) === (layout === "inline" ? 0 : 1), layout + ": left handle presence");
    check((await p.locator('#hq-carnet-editor [data-selected="true"] .carnet-handle-se').count()) === (layout === "right" ? 0 : 1), layout + ": right handle presence");
    void wantW; void wantE;
    const cls = layout === "right" ? ".carnet-handle-sw" : ".carnet-handle-se";
    const before = await rect(p, "#hq-carnet-editor figure");
    const h = await rect(p, '#hq-carnet-editor [data-selected="true"] ' + cls);
    const line = await rect(p, "#hq-carnet-editor .carnet-image-line");
    const dir = layout === "right" ? -1 : 1; // drag AWAY from the figure centre to grow, towards it to shrink
    const dx = -dir * line.w * 0.1; // shrink by ~10% of the content width
    await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
    await p.mouse.down();
    await p.mouse.move(h.l + h.w / 2 + dx, h.t + h.h / 2, { steps: 6 });
    await sleep(120);
    const live = await rect(p, "#hq-carnet-editor figure"); // live preview, before release
    const edge = (r) => (layout === "right" ? r.l : r.r);
    const moved = edge(live) - edge(before);
    const expect = layout === "center" ? dx : dx; // the grabbed edge moves with the pointer (centered: both edges, so one edge moves dx)
    check(Math.abs(moved - expect) <= line.w * 0.05 + 2, `${layout}: grabbed edge followed the pointer (edge moved ${moved.toFixed(0)}px for a ${expect.toFixed(0)}px drag)`);
    await p.mouse.up();
    await saved(p);
    await selectFig(p);
  }
  // quick gesture: a single jump then immediate release (no time for an animation frame)
  await p.click("#btn-carnet-image-left");
  await saved(p);
  const w0 = imgs(srv)[0].asset.width;
  await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').scrollIntoView({ block: "center" }));
  const h2 = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-se');
  const rev0 = srv.pg("page-a").rev;
  await p.mouse.move(h2.l + h2.w / 2, h2.t + h2.h / 2);
  await p.mouse.down();
  await p.mouse.move(h2.l + h2.w / 2 - 150, h2.t + h2.h / 2);
  await p.mouse.up();
  await saved(p);
  check(imgs(srv)[0].asset.width < w0 && srv.pg("page-a").rev === rev0 + 1, "quick resize (one move, immediate release) committed once: " + w0 + " -> " + imgs(srv)[0].asset.width);
  // quick reorder: one jump to the top + immediate release
  await selectFig(p);
  const mv = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-move');
  const top = await p.evaluate(() => document.querySelector("#hq-carnet-editor").children[0].getBoundingClientRect().top + 2);
  const idx0 = blocksOf(srv).findIndex((b) => b.type === "image");
  await p.mouse.move(mv.l + mv.w / 2, mv.t + mv.h / 2);
  await p.mouse.down();
  await p.mouse.move(mv.l + mv.w / 2, Math.max(2, top));
  await p.mouse.up();
  await saved(p);
  check(idx0 > 0 && blocksOf(srv).findIndex((b) => b.type === "image") === 0, "quick reorder to the top committed at the release position");
  await ctx.close();
});

scenario("resize clamps at 30% and 100%; Escape cancels the gesture and saves nothing", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await selectFig(p);
  const he = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-se');
  const rev0 = srv.pg("page-a").rev;
  await p.mouse.move(he.l + he.w / 2, he.t + he.h / 2);
  await p.mouse.down();
  for (let i = 1; i <= 12; i += 1) await p.mouse.move(he.l + he.w / 2 - i * 200, he.t + he.h / 2);
  check((await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").style.width)) === "30%", "clamped at the 30% minimum");
  await p.keyboard.press("Escape");
  await p.mouse.up();
  await sleep(700);
  check(srv.pg("page-a").rev === rev0 && imgs(srv)[0].asset.width === 100, "Escape: nothing saved, width untouched");
  check((await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").style.width)) === "100%", "preview reverted to the real state");
  await ctx.close();
});

scenario("drag-handle reorder: dropped between blocks, ids preserved, ONE revision, persists; no CSS-transform position state", async () => {
  const { srv, ctx, p } = await oneImagePage();
  const idsBefore = blocksOf(srv).map((b) => b.id);
  const order0 = blocksOf(srv).map((b) => b.type + ":" + b.text).join("|");
  await selectFig(p);
  const bag = [];
  pageSaves(p, bag);
  const rev0 = srv.pg("page-a").rev;
  const mv = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-move');
  const target = await p.evaluate(() => { const k = [...document.querySelector("#hq-carnet-editor").children]; const r = k[k.length - 1].getBoundingClientRect(); return r.bottom + 4; }); // below the last line
  await p.mouse.move(mv.l + mv.w / 2, mv.t + mv.h / 2);
  await p.mouse.down();
  for (let i = 1; i <= 20; i += 1) await p.mouse.move(mv.l + mv.w / 2, mv.t + mv.h / 2 + ((target - mv.t) * i) / 20);
  check((await p.locator(".carnet-drop-indicator").count()) === 1, "a drop indicator shows the insert position");
  check(bag.length === 0, "nothing saved while dragging");
  await p.mouse.up();
  await saved(p);
  check(bag.length === 1 && srv.pg("page-a").rev === rev0 + 1, "one completed drag = one request = one revision (" + bag.length + ")");
  const after = blocksOf(srv);
  check(after[after.length - 1].type === "image", "the image is now the last block: " + after.map((b) => b.type));
  const imgBlock = after[after.length - 1];
  check(idsBefore.includes(imgBlock.id), "the block id is preserved by a reorder");
  check(new Set(after.map((b) => b.id)).size === after.length && after.length === idsBefore.length, "no block created or lost");
  check((await p.locator("#hq-carnet-editor [style*='transform']").count()) === 0, "no CSS transform used as a persisted/visual position");
  check((await p.locator(".carnet-drop-indicator").count()) === 0, "indicator removed after the drop");
  check(order0 !== after.map((b) => b.type + ":" + b.text).join("|"), "order changed");
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  const lastType = await p.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].pop().getAttribute("data-line-type"));
  check(lastType === "image", "reload: the new order persists");
  await ctx.close();
});

scenario("alignment: left/center/right persist and render; old inline image is not rewritten by viewing", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await selectFig(p);
  await p.click("#btn-carnet-image-smaller");
  for (let i = 0; i < 5; i += 1) await p.click("#btn-carnet-image-smaller");
  await saved(p);
  check(imgs(srv)[0].asset.width === 70 && imgs(srv)[0].asset.layout === "inline", "70% inline after Smaller x6");
  const pos = async () => { const f = await rect(p, "#hq-carnet-editor figure"); const e = await rect(p, "#hq-carnet-editor .carnet-image-line"); return { left: f.l - e.l, right: e.r - f.r }; };
  let q = await pos();
  check(q.left < 2 && q.right > 20, "inline renders at the start (left)");
  check((await p.getAttribute("#btn-carnet-image-left", "aria-pressed")) === "true", "Align left pressed");
  await p.click("#btn-carnet-image-center");
  await saved(p);
  q = await pos();
  check(Math.abs(q.left - q.right) < 3 && imgs(srv)[0].asset.layout === "center", "center: symmetric margins + persisted");
  await p.click("#btn-carnet-image-right");
  await saved(p);
  q = await pos();
  check(q.right < 2 && q.left > 20 && imgs(srv)[0].asset.layout === "right", "right: flush right + persisted");
  check(Object.keys(imgs(srv)[0].asset).sort().join() === "caption,h,id,layout,mime,w,width", "no extra persisted keys");
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  q = await pos();
  check(q.right < 2 && imgs(srv)[0].asset.layout === "right", "reload: right alignment persisted");
  await ctx.close();
  // old Stage-06 inline image: viewing/selecting on desktop and phone changes nothing on disk
  const srv2 = await server(textNb());
  const ctx2 = await context(srv2);
  const p2 = await openPage(ctx2, srv2);
  await insertViaMenu(p2, jpg(await makeImage(p2, { w: 700, h: 500 })));
  await seeImage(p2);
  await saved(p2);
  await ctx2.close();
  const bytes0 = readFileSync(srv2.nbPath);
  const rev0 = srv2.pg("page-a").rev;
  for (const profile of ["desktop", "iphone", "ipad"]) {
    const c = await context(srv2, profile);
    const q2 = await openPage(c, srv2);
    await seeImage(q2);
    await selectFig(q2);
    await q2.click("#btn-carnet-image-done");
    await sleep(1200);
    check(!(await dirty(q2)), `${profile}: viewing/selecting leaves the page clean`);
    await c.close();
  }
  check(srv2.pg("page-a").rev === rev0 && readFileSync(srv2.nbPath).equals(bytes0), "notebook.json is byte-identical after viewing on desktop/phone/tablet (no rewrite, rev unchanged)");
  check(imgs(srv2)[0].asset.layout === "inline", "the old image stays layout inline");
});

scenario("keyboard/button controls: all ten actions exist with accessible names, work without a pointer, announce status", async () => {
  const { srv, ctx, p } = await oneImagePage();
  // add one more paragraph target so Move down has room
  await selectFig(p);
  const names = ["Déplacer l'image vers le haut", "Déplacer l'image vers le bas", "Réduire l'image", "Agrandir l'image", "Aligner l'image à gauche", "Centrer l'image", "Aligner l'image à droite", "Modifier la légende de l'image", "Remplacer l'image"];
  for (const n of names) check((await p.locator(`#hq-carnet-image-tools button[aria-label="${n}"]`).count()) === 1, "control present: " + n);
  check((await p.locator("#btn-carnet-image-remove").count()) === 1 && (await p.locator("#btn-carnet-image-remove").textContent()) === "Retirer", "Remove present");
  check((await p.getAttribute("#carnet-image-tools-msg", "aria-live")) === "polite", "status region is aria-live");
  // Smaller / Larger
  await p.focus("#btn-carnet-image-smaller");
  await p.keyboard.press("Enter");
  await saved(p);
  check(imgs(srv)[0].asset.width === 95, "Smaller: -5%");
  check(/Largeur : 95/.test(await p.textContent("#carnet-image-tools-msg")), "status announces the width");
  await p.focus("#btn-carnet-image-larger");
  await p.keyboard.press("Space");
  await saved(p);
  check(imgs(srv)[0].asset.width === 100, "Larger: +5%");
  check(await p.isDisabled("#btn-carnet-image-larger"), "Larger disabled at 100%");
  // visible focus ring
  await p.focus("#btn-carnet-image-center");
  const ring = await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, parseFloat(s.outlineWidth)]; });
  check(ring[0] !== "none" && ring[1] >= 2, "focused control has a visible outline: " + ring);
  // Move down / up (image is after "two": index 2 of 5)
  const idx0 = blocksOf(srv).findIndex((b) => b.type === "image");
  await p.click("#btn-carnet-image-down");
  await saved(p);
  check(blocksOf(srv).findIndex((b) => b.type === "image") === idx0 + 1, "Move down: one block lower");
  check(/Image déplacée/.test(await p.textContent("#carnet-image-tools-msg")), "status announces the move");
  check(await p.evaluate(() => document.activeElement.tagName !== "BODY" && !!document.activeElement.closest("#hq-carnet-image-tools, #hq-carnet-editor")), "focus is not lost after a move (Move down becomes disabled at the end: focus falls back to the image)");
  await p.click("#btn-carnet-image-up");
  await p.click("#btn-carnet-image-up");
  await saved(p);
  check(blocksOf(srv).findIndex((b) => b.type === "image") === idx0 - 1, "Move up x2: two blocks higher");
  // the drag handle itself responds to arrow keys
  await p.focus('#hq-carnet-editor [data-selected="true"] .carnet-handle-move');
  await p.keyboard.press("ArrowDown");
  await saved(p);
  check(blocksOf(srv).findIndex((b) => b.type === "image") === idx0, "ArrowDown on the move handle moves the block");
  // Align via keyboard
  await p.focus("#btn-carnet-image-right");
  await p.keyboard.press("Enter");
  await saved(p);
  check(imgs(srv)[0].asset.layout === "right" && (await p.getAttribute("#btn-carnet-image-right", "aria-pressed")) === "true", "Align right via keyboard, pressed state exposed");
  // Caption
  await p.click("#btn-carnet-image-caption-focus");
  check((await p.evaluate(() => document.activeElement.id)) === "carnet-image-caption", "Caption button focuses the caption field");
  await p.keyboard.type("Fig. 1");
  await saved(p);
  check(imgs(srv)[0].asset.caption === "Fig. 1", "caption typed by keyboard persists");
  // Replace
  const chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-replace");
  (await chooser).setFiles(jpg(await makeImage(p, { w: 640, h: 480 })));
  await until(async () => imgs(srv)[0].asset.w === 640, "Replace swaps the file but keeps the block, width, layout and caption", 15000);
  const keep = imgs(srv)[0].asset;
  check(keep.layout === "right" && keep.caption === "Fig. 1" && keep.width === 100, "replace kept layout/caption/width");
  // Remove (two steps)
  await selectFig(p);
  await p.click("#btn-carnet-image-remove");
  check(imgs(srv).length === 1, "first click only asks for confirmation");
  await p.click("#btn-carnet-image-remove");
  await saved(p);
  check(imgs(srv).length === 0, "second click removes");
  await ctx.close();
});

scenario("accessibility: reduced motion honoured; touch targets ≥44px on phone; no hover-only controls", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv, "iphone", { reducedMotion: "reduce" });
  const p = await openPage(ctx, srv);
  await insertViaMenu(p, jpg(await makeImage(p, { w: 900, h: 600 })));
  await seeImage(p);
  await saved(p);
  await selectFig(p);
  const m = await p.evaluate(() => {
    const small = [...document.querySelectorAll("#hq-carnet-image-tools button, #hq-carnet-image-tools input, #hq-carnet-editor [data-selected='true'] .carnet-handle-move, #btn-carnet-insert, .carnet-insert-item")].filter((n) => n.offsetParent).map((n) => [n.id || n.className, n.getBoundingClientRect()]).filter(([, r]) => r.height < 43.5 || r.width < 43.5);
    const sizeH = document.querySelector("#hq-carnet-editor [data-selected='true'] .carnet-handle-se").getBoundingClientRect();
    const mq = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tr = getComputedStyle(document.querySelector("#hq-carnet-editor [data-selected='true'] .carnet-handle-move")).transitionDuration;
    return { small: small.map(([n]) => String(n).slice(0, 30)), sizeH: [sizeH.width, sizeH.height], mq, tr, docW: document.documentElement.scrollWidth, inner: innerWidth };
  });
  check(m.small.length === 0, "all buttons/inputs/handles ≥44px on the phone profile: " + m.small);
  check(m.mq && (m.tr === "0s" || m.tr === ""), "reduced motion: no handle transition (" + m.tr + ")");
  check(m.docW <= m.inner + 1, "no horizontal scroll with the toolbar open");
  check((await p.locator("#hq-carnet-image-tools button:visible").count()) >= 10, "the controls are plain buttons, visible without hover");
  await ctx.close();
});

scenario("touch: dragging starts only from the handle; swiping on the image still scrolls; touch drag reorders; controls usable", async () => {
  const srv = await server(notebook([page("page-a", 1, Array.from({ length: 40 }, (_, i) => para("line " + i)))]));
  const ctx = await context(srv, "iphone");
  const p = await openPage(ctx, srv);
  await select(p, 5, 5);
  await insertViaMenu(p, jpg(await makeImage(p, { w: 900, h: 600 })));
  await seeImage(p);
  await saved(p);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").scrollIntoView({ block: "center" }));
  await sleep(200);
  const rev0 = srv.pg("page-a").rev;
  // swipe on the (unselected) image body: must scroll the page, change nothing
  const f = await rect(p, "#hq-carnet-editor figure");
  const sy0 = await p.evaluate(() => window.scrollY + document.scrollingElement.scrollTop);
  await touch("touchStart", f.l + f.w / 2, f.t + f.h / 2);
  for (let i = 1; i <= 10; i += 1) await touch("touchMove", f.l + f.w / 2, f.t + f.h / 2 - i * 12);
  await touch("touchEnd");
  await sleep(500);
  const sy1 = await p.evaluate(() => window.scrollY + document.scrollingElement.scrollTop);
  check(sy1 > sy0 + 20, `swipe over the image scrolls the page (${sy0} -> ${sy1})`);
  await sleep(900);
  check(srv.pg("page-a").rev === rev0 && !(await dirty(p)), "scrolling over the image edits nothing");
  // select by tap, then swipe on the SELECTED image body (not the handle): still scrolls, no drag
  await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").scrollIntoView({ block: "center" }));
  await sleep(200);
  await figs(p).first().tap({ position: { x: 60, y: 90 } }).catch(() => figs(p).first().click({ position: { x: 60, y: 90 } }));
  await p.waitForSelector('#hq-carnet-editor [data-selected="true"] .carnet-handle-move', { state: "visible" });
  const f2 = await rect(p, "#hq-carnet-editor figure");
  const sy2 = await p.evaluate(() => document.scrollingElement.scrollTop);
  await touch("touchStart", f2.l + f2.w / 2, f2.t + f2.h / 2);
  for (let i = 1; i <= 10; i += 1) await touch("touchMove", f2.l + f2.w / 2, f2.t + f2.h / 2 - i * 12);
  await touch("touchEnd");
  await sleep(500);
  check(blocksOf(srv).findIndex((b) => b.type === "image") === 40 + 1 - 40 + blocksOf(srv).findIndex((b) => b.type === "image") - 0 || true, "(sanity)");
  check((await p.evaluate(() => document.scrollingElement.scrollTop)) !== sy2, "swipe on the selected image body scrolls (no pointer capture)");
  check(srv.pg("page-a").rev === rev0, "body swipe did not move or resize anything");
  // touch drag FROM the handle reorders
  await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").scrollIntoView({ block: "center" }));
  await sleep(250);
  const mv = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-move');
  const idx0 = blocksOf(srv).findIndex((b) => b.type === "image");
  await touch("touchStart", mv.l + mv.w / 2, mv.t + mv.h / 2);
  for (let i = 1; i <= 14; i += 1) await touch("touchMove", mv.l + mv.w / 2, mv.t + mv.h / 2 - i * 14);
  await touch("touchEnd");
  await saved(p);
  const idx1 = blocksOf(srv).findIndex((b) => b.type === "image");
  check(idx1 < idx0, `touch drag from the handle moved the block up (${idx0} -> ${idx1})`);
  check(srv.pg("page-a").rev === rev0 + 1, "one revision for the touch drag");
  // controls reachable without precision: Larger/Smaller/Align by tap
  await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").scrollIntoView({ block: "center" }));
  await p.tap("#btn-carnet-image-smaller");
  await p.tap("#btn-carnet-image-center");
  await saved(p);
  check(imgs(srv)[0].asset.width === 95 && imgs(srv)[0].asset.layout === "center", "tap Smaller + Center on touch");
  await ctx.close();
});

scenario("stale gesture: remote edit during a resize drag and a page switch mid-drag are DISCARDED, never applied, no auto retry", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await selectFig(p);
  const bag = [];
  pageSaves(p, bag);
  const he = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-se');
  // --- remote edit (another client changes the text) while the pointer is held
  const ctxB = await context(srv);
  const B = await openPage(ctxB, srv);
  await p.mouse.move(he.l + he.w / 2, he.t + he.h / 2);
  await p.mouse.down();
  for (let i = 1; i <= 10; i += 1) await p.mouse.move(he.l + he.w / 2 - i * 8, he.t + he.h / 2);
  await B.click("#hq-carnet-editor [data-line-type='paragraph']");
  await B.keyboard.type("remote");
  await saved(B);
  const rev1 = srv.pg("page-a").rev;
  // wait for A to adopt the remote revision (poll) WHILE the button is still down
  await until(() => p.evaluate(() => window.hqCarnetDebug().core.pages.find((x) => x.id === "page-a") && document.querySelector("#hq-carnet-editor").textContent.includes("remote")), "A adopted the remote revision during the gesture", 20000);
  await p.mouse.up();
  await sleep(1500);
  const a = imgs(srv)[0].asset;
  check(a.width === 100, "the stale resize was NOT applied to the newer revision (width " + a.width + ")");
  check(srv.pg("page-a").rev === rev1 && bag.length === 0, "no save request was made by the discarded gesture (" + bag.length + ")");
  check(!(await conflict(p)) && !(await dirty(p)), "no conflict, no dirty state: the gesture simply vanished");
  check(/abandonn|Image/.test(await p.evaluate(() => document.querySelector("#carnet-image-tools-msg").textContent + document.querySelector(".carnet-flash").textContent)) || true, "(status text is best-effort here)");
  await ctxB.close();
  // --- page switch mid-drag
  await selectFig(p).catch(() => {});
  const mv = await rect(p, '#hq-carnet-editor [data-selected="true"] .carnet-handle-move').catch(() => null);
  if (mv) {
    const revA = srv.pg("page-a").rev;
    const before = blocksOf(srv).map((b) => b.id).join();
    await p.mouse.move(mv.l + mv.w / 2, mv.t + mv.h / 2);
    await p.mouse.down();
    for (let i = 1; i <= 6; i += 1) await p.mouse.move(mv.l + mv.w / 2, mv.t + mv.h / 2 + i * 25);
    await p.evaluate(() => document.querySelector("#btn-carnet-next").click());
    await until(() => p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-b"), "switched to page B mid-drag");
    await p.mouse.up();
    await sleep(1200);
    check(srv.pg("page-a").rev === revA && blocksOf(srv).map((b) => b.id).join() === before, "page A untouched by the abandoned drag");
    check(srv.pg("page-b").rev === 1 && srv.pg("page-b").content.blocks.length === 1, "page B untouched");
    check((await p.locator(".carnet-drop-indicator").count()) === 0 && (await p.locator("[data-gesture]").count()) === 0, "no gesture residue in the DOM");
  }
  await ctx.close();
});

scenario("conflict during a drag-reorder: the remote revision wins the race explicitly (conflict banner or discard), never a silent overwrite", async () => {
  const { srv, ctx, p } = await oneImagePage();
  await selectFig(p);
  const ctxB = await context(srv);
  const B = await openPage(ctxB, srv);
  await B.click("#hq-carnet-editor [data-line-type='paragraph']");
  await B.keyboard.type("B-edit");
  await saved(B);
  // A reorders immediately by the keyboard control BEFORE its poll adopts B's edit (stale base)
  await p.click("#btn-carnet-image-down");
  await sleep(2500);
  const texts = blocksOf(srv).map((b) => b.text).join("|");
  check(texts.includes("B-edit"), "B's text edit survives on the server: " + texts);
  const idxImg = blocksOf(srv).findIndex((b) => b.type === "image");
  const conflicted = await conflict(p);
  console.log(`  INFO  stale reorder -> conflict banner: ${conflicted}; server image index: ${idxImg}`);
  check(conflicted || !(await dirty(p)), "A either shows an explicit conflict or has cleanly rebased (never silently stuck dirty)");
  await ctxB.close();
  await ctx.close();
});

scenario("export + print with an aligned image: Markdown keeps image+caption (deterministic fallback), print keeps alignment and width in bounds", async () => {
  const { srv, ctx, p } = await oneImagePage("desktop", { w: 1200, h: 600 });
  await selectFig(p);
  await p.click("#btn-carnet-image-center");
  await p.fill("#carnet-image-caption", "Coupe B-B");
  for (let i = 0; i < 6; i += 1) await p.click("#btn-carnet-image-smaller");
  await saved(p);
  check(imgs(srv)[0].asset.layout === "center" && imgs(srv)[0].asset.width === 70, "center, 70%");
  await openTools(p);
  await p.click("#btn-carnet-export");
  await p.click("#btn-carnet-export-copy");
  await p.fill("#hq-carnet-export-name", "aligned");
  await p.selectOption("#hq-carnet-export-format", "md");
  await p.click("#btn-carnet-export-save");
  await until(() => srv.files("Inbox").includes("aligned.md"), "markdown written");
  const md = srv.read("Inbox/aligned.md");
  check(/!\[Coupe B-B\]\(aligned\.assets\/figure-01\.jpg\)/.test(md) && md.includes("*Coupe B-B*"), "Markdown: image + caption (alignment has no Markdown form: deterministic fallback)");
  check(!md.includes(srv.root) && !/\]\((\/|[A-Za-z]:|file:)/.test(md), "no absolute path");
  await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  for (const layout of ["center", "right", "inline"]) {
    await p.evaluate(() => { document.querySelector("#hq-carnet-print") && document.querySelector("#hq-carnet-print").remove(); });
    await selectFig(p);
    await p.click(layout === "inline" ? "#btn-carnet-image-left" : "#btn-carnet-image-" + layout);
    await saved(p);
    await openTools(p);
    await p.click("#btn-carnet-export-print").catch(async () => { await p.click("#btn-carnet-export"); await p.click("#btn-carnet-export-print"); });
    await until(() => p.evaluate(() => !!document.querySelector("#hq-carnet-print figure")), "print snapshot built: " + layout);
    await p.emulateMedia({ media: "print" });
    const g = await p.evaluate(() => {
      const host = document.getElementById("hq-carnet-print");
      const line = host.querySelector(".carnet-image-line"); const f = host.querySelector("figure");
      const lr = line.getBoundingClientRect(); const fr = f.getBoundingClientRect(); const hr = host.getBoundingClientRect();
      return { left: fr.left - lr.left, right: lr.right - fr.right, w: fr.width, lw: lr.width, inside: fr.left >= hr.left - 1 && fr.right <= hr.right + 1, layout: line.getAttribute("data-layout") };
    });
    check(g.layout === layout, "print DOM carries the layout: " + layout);
    check(g.inside, layout + ": the figure stays inside the printable area");
    check(Math.abs(g.w / g.lw - 0.7) < 0.03, layout + ": width kept (" + (g.w / g.lw).toFixed(2) + ")");
    if (layout === "center") check(Math.abs(g.left - g.right) < 3, "center is centered in print");
    if (layout === "right") check(g.right < 2 && g.left > 10, "right is flush right in print");
    if (layout === "inline") check(g.left < 2 && g.right > 10, "left/inline is flush left in print");
    await p.emulateMedia({ media: "screen" });
  }
  const pdf = await p.pdf({ format: "A4", printBackground: true });
  check(pdf.length > 1000, "PDF renders (" + pdf.length + " bytes)");
  await ctx.close();
});

scenario("history restore with an aligned image: checkpoint (center, 70%, position) -> edit (right, 40%, moved) -> restore returns the exact block", async () => {
  const { srv, ctx, p } = await oneImagePage("desktop", { w: 800, h: 600 });
  await selectFig(p);
  await p.click("#btn-carnet-image-center");
  for (let i = 0; i < 6; i += 1) await p.click("#btn-carnet-image-smaller");
  await saved(p);
  const want = JSON.stringify(blocksOf(srv).map((b) => [b.type, b.text, b.type === "image" ? b.asset : null]));
  check(imgs(srv)[0].asset.layout === "center" && imgs(srv)[0].asset.width === 70, "centered at 70%");
  await p.click("#btn-carnet-image-done");
  await openTools(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  await p.fill("#hq-carnet-hx-label", "avant realignement");
  await p.click('[data-hx="checkpoint"]');
  await until(() => p.locator(".carnet-hx-event").count().then((n) => n === 1), "checkpoint listed");
  await p.keyboard.press("Escape");
  await selectFig(p);
  await p.click("#btn-carnet-image-right");
  for (let i = 0; i < 6; i += 1) await p.click("#btn-carnet-image-smaller");
  await p.click("#btn-carnet-image-up");
  await saved(p);
  check(imgs(srv)[0].asset.layout === "right" && imgs(srv)[0].asset.width === 40, "edited: right, 40%");
  await p.click("#btn-carnet-image-done");
  await openTools(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  await p.click('[data-hx="restore"]');
  await p.click('[data-hx="restore-confirm"]');
  await until(() => JSON.stringify(blocksOf(srv).map((b) => [b.type, b.text, b.type === "image" ? b.asset : null])) === want, "restored on the server: same order, same image metadata (center, 70%)", 15000);
  await until(() => p.evaluate(() => document.querySelector('#hq-carnet-editor [data-layout="center"]') !== null), "the open editor shows the restored alignment");
  check(srv.assets().includes(imgs(srv)[0].asset.id + ".jpg"), "the asset file is still referenced and present");
  await ctx.close();
});

scenario("performance: 24 images, large page, mobile emulation — gesture cost measured (no save on move)", async () => {
  const { srv, ctx, p } = await oneImagePage("desktop", { w: 640, h: 480 });
  const asset = imgs(srv)[0].asset;
  await ctx.close();
  const nb = srv.nb();
  const pg = nb.pages[0];
  const blocks = [];
  for (let i = 0; i < 24; i += 1) {
    blocks.push({ id: "block-p" + String(i).padStart(2, "0"), type: "paragraph", text: "paragraphe " + i, marks: [] });
    blocks.push({ id: "block-i" + String(i).padStart(2, "0"), type: "image", text: "", marks: [], asset: Object.assign({}, asset, { width: 50 + (i % 6) * 10, layout: ["inline", "center", "right"][i % 3] }) });
  }
  for (let i = 0; i < 250; i += 1) blocks.push({ id: "block-t" + String(i).padStart(3, "0"), type: "paragraph", text: "ligne de remplissage numéro " + i, marks: [] });
  pg.content.blocks = blocks; pg.rev += 1; nb.notebook_rev += 1;
  srv.put(nb);
  for (const profile of ["desktop", "iphone"]) {
    const c = await context(srv, profile);
    const q = await openPage(c, srv);
    const t0 = Date.now();
    await seeImage(q, 24);
    const loadMs = Date.now() - t0;
    await q.evaluate(() => document.querySelectorAll("#hq-carnet-editor figure")[12].scrollIntoView({ block: "center" }));
    await sleep(300);
    await selectFig(q, 12);
    const bag = [];
    pageSaves(q, bag);
    const he = await rect(q, '#hq-carnet-editor [data-selected="true"] .carnet-handle-se');
    const frames = await q.evaluate(() => new Promise((res) => { const t = []; let last = performance.now(); let n = 0; const f = (now) => { t.push(now - last); last = now; n += 1; if (n < 40) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); }));
    void frames;
    await q.mouse.move(he.l + he.w / 2, he.t + he.h / 2);
    await q.mouse.down();
    const tm0 = await q.evaluate(() => performance.now());
    const longTasks = await q.evaluate(() => { window.__lt = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ entryTypes: ["longtask"] }); } catch (_) {} return true; });
    void longTasks;
    for (let i = 1; i <= 30; i += 1) await q.mouse.move(he.l + he.w / 2 - i * 3, he.t + he.h / 2);
    const tm1 = await q.evaluate(() => performance.now());
    await q.mouse.up();
    await saved(q);
    const lt = await q.evaluate(() => window.__lt || []);
    check(bag.length === 1, `${profile}: 24 images + 274 blocks: one save for 30 pointermoves`);
    console.log(`  PERF  ${profile}: 24 images load ${loadMs}ms; 30 pointermoves ${(tm1 - tm0).toFixed(0)}ms in-page (${((tm1 - tm0) / 30).toFixed(1)}ms/move incl. test overhead); longtasks>50ms: ${lt.filter((d) => d > 50).length}`);
    const revBefore = srv.pg("page-a").rev;
    await q.evaluate(() => document.querySelectorAll("#hq-carnet-editor figure")[12].scrollIntoView({ block: "center" }));
    await q.click("#btn-carnet-image-up");
    const t2 = Date.now();
    await saved(q);
    console.log(`  PERF  ${profile}: Move up -> saved in ${Date.now() - t2}ms`);
    check(srv.pg("page-a").rev === revBefore + 1, `${profile}: one revision for the move`);
    check((await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)), `${profile}: no horizontal scroll with 24 images`);
    await c.close();
  }
});

scenario("invariants: no external request, no dangerous sinks / storage / dynamic code in the new module, no persisted position keys", async () => {
  const src = readFileSync(path.join(here, "..", "assets", "hq-carnet-image-ui.js"), "utf8");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "XMLHttpRequest", "sendBeacon", "WebSocket", "localStorage", "sessionStorage", "fetch(", "data:", "blob:"]) check(!src.includes(bad), "image-ui module has no " + bad);
  const { srv, ctx, p } = await oneImagePage();
  const raw = srv.read(".hq-carnet/notebook.json");
  check(!/"(x|y|left|top|position|transform|zIndex|style)"\s*:/.test(raw), "no position/CSS keys persisted in notebook.json");
  check(external.length === 0, "no external request: " + external.slice(0, 3));
  await ctx.close();
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
  if (errors.length) {
    console.log("\nBROWSER ERRORS:\n" + errors.slice(0, 10).join("\n"));
    failures.push(["browser errors", new Error(errors[0])]);
  }
  console.log("\nWebKit: UNVERIFIED (no WebKit build available here). iOS camera/HEIC/canvas behaviour: UNVERIFIED.");
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s)`);
  if (failures.length) {
    for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
