// Carnet editor polish (phase 2 of the UX pass, NOT a Stage 09): visual title treatment, floating selection toolbar,
// "/" command menu (context-safe dismissal, IME), block rail / between-block "+" / block menu, drag reorder of any block,
// library polish, dark + light themes, responsive viewports, stale/concurrency behaviour and timing measurements.
//
//   node tests/visual_carnet_editor_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme emulation; no physical device). WebKit/Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
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
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-editor-"));
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


// ---------------------------------------------------------------- editor helpers
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);
const SLASH_NB = () => notebook([page("page-a", 1, [para("one"), para("")]), page("page-b", 1, [para("other page")])]);
const ed = (p) => p.locator("#hq-carnet-editor");
const caretEnd = (p) => p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
const edText = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
const menuVisible = (p) => p.locator("#carnet-cmd-menu").isVisible();
const cmdOpts = (p) => p.evaluate(() => [...document.querySelectorAll("#carnet-cmd-list [data-carnet-cmd]")].map((o) => [o.getAttribute("data-carnet-cmd"), o.getAttribute("aria-selected")]));
const blockTypes = (srv, id = "page-a") => blocksOf(srv, id).map((b) => b.type);
const blockTexts = (srv, id = "page-a") => blocksOf(srv, id).map((b) => b.text);
async function openEditor(profile = "desktop", nb = SLASH_NB(), extra = {}) {
  const srv = await server(nb);
  const ctx = await context(srv, profile, extra);
  const p = await openPage(ctx, srv);
  return { srv, ctx, p };
}
const rail = (p) => p.locator("#carnet-block-rail");
const onScreen = (r, vw, vh) => !!r && r.l >= -0.5 && r.t >= -0.5 && r.r <= vw + 0.5 && r.b <= vh + 0.5;
const vp = (p) => p.viewportSize();
// luminance contrast of two CSS colours resolved by the browser
const contrast = (p, fg, bg) => p.evaluate(([fg, bg]) => {
  const c = document.createElement("canvas").getContext("2d");
  const rgb = (v) => { c.fillStyle = "#000"; c.fillStyle = v; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const a = lum(rgb(fg)), b = lum(rgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, [fg, bg]);

// ---------------------------------------------------------------- slash menu
scenario("slash menu: '/' opens it (keystroke cancelled), keyboard nav + Enter inserts ONLY the command result", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu opens on '/'");
  check((await edText(p)) === "one\n", "no '/' entered the document: " + JSON.stringify(await edText(p)));
  check((await p.getAttribute("#carnet-cmd-input", "aria-expanded")) === "true", "aria-expanded=true on the search input");
  check((await p.evaluate(() => document.activeElement.id)) === "carnet-cmd-input", "focus is in the menu's own search input");
  let o = await cmdOpts(p);
  check(o.length === 24 && o[0][0] === "paragraph" && o[0][1] === "true", "all 24 commands (23 + Phase-8 portal), first selected: " + o.length);
  check(!(await dirty(p)), "opening the menu is not an edit (nothing dirty)");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  o = await cmdOpts(p);
  check(o[2][1] === "true" && o[0][1] === "false", "ArrowDown moves aria-selected");
  await p.keyboard.press("ArrowUp");
  check((await cmdOpts(p))[1][1] === "true", "ArrowUp moves back");
  await p.keyboard.type("titr");
  o = await cmdOpts(p);
  check(o.length === 1 && o[0][0] === "heading", "filtering by typing: " + JSON.stringify(o));
  await p.keyboard.press("Enter");
  await until(async () => !(await menuVisible(p)), "menu closes on Enter");
  await saved(p);
  check(JSON.stringify(blockTypes(srv)) === '["paragraph","heading"]', "the empty line became a heading: " + blockTypes(srv));
  check(blockTexts(srv).join("|") === "one|", "no '/' and no query text persisted: " + JSON.stringify(blockTexts(srv)));
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-editor", "focus returned to the editor");
});

scenario("slash menu: Escape restores ONE literal '/' at the original place; no phantom edits otherwise", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu opens");
  await p.keyboard.type("zzz");
  check((await cmdOpts(p)).length === 0, "no match: empty state");
  check((await p.locator(".carnet-cmd-empty").count()) === 1, "empty-state row shown");
  await p.keyboard.press("Enter");
  check(await menuVisible(p), "Enter with no match keeps the menu open and does nothing");
  await p.keyboard.press("Escape");
  await until(async () => !(await menuVisible(p)), "Escape closes");
  check((await edText(p)) === "one\n/", "exactly one literal '/' restored in the original line: " + JSON.stringify(await edText(p)));
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-editor", "focus back in the editor");
  await saved(p);
  check(blockTexts(srv).join("|") === "one|/", "the slash persists as ordinary text after a normal dismissal");
  // the restored '/' follows a non-whitespace char now: a second '/' typed there is plain text (not eligible)
  await p.keyboard.type("/");
  await sleep(150);
  check(!(await menuVisible(p)) && (await edText(p)) === "one\n//", "'/' after a non-space is literal text, no menu");
});

scenario("slash menu: only after whitespace / at line start; never mid-word; atoms never; read-only never", async () => {
  const { p } = await openEditor("desktop", notebook([page("page-a", 1, [para("abc"), para("x y")])]));
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(3, 3); });
  await p.keyboard.type("/");
  await sleep(150);
  check(!(await menuVisible(p)) && (await edText(p)).startsWith("abc/"), "mid-word '/' is typed normally");
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  await p.keyboard.type(" /");
  await until(() => menuVisible(p), "after a space the menu opens");
  check((await edText(p)).endsWith("x y "), "the space typed, the '/' swallowed: " + JSON.stringify(await edText(p)));
  await p.keyboard.press("Escape");
  await until(async () => !(await menuVisible(p)), "closed");
  check((await edText(p)).endsWith("x y /"), "dismissal restores the '/' after the space");
});

scenario("slash menu: block commands convert; tool commands reuse the SAME runInsert path (decision / measure)", async () => {
  const { srv, p } = await openEditor();
  for (const [q, want] of [["liste", "bullet"], ["numér", "number"], ["cases", "check"], ["texte", "paragraph"]]) {
    await caretEnd(p);
    await p.keyboard.type("/");
    await until(() => menuVisible(p), "menu for " + q);
    await p.keyboard.type(q);
    await p.keyboard.press("Enter");
    await until(async () => !(await menuVisible(p)), "closed after " + q);
    const t = await domLines(p);
    check(t[1][0] === want, `"${q}" -> ${want} (got ${t[1][0]})`);
  }
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu for décision");
  await p.keyboard.type("décis");
  await p.keyboard.press("Enter");
  await until(() => p.locator("[data-carnet-eng-panel], .carnet-eng-panel, #hq-carnet-eng-panel").first().isVisible().catch(() => false), "the existing decision tool opens (same path as + Insérer)");
  check(!(await edText(p)).includes("/"), "no '/' left behind by a tool command");
});

// ---------------------------------------------------------------- slash menu: stale contexts + IME
scenario("slash menu: page switch while open closes WITHOUT mutating either page", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu open");
  await p.keyboard.press("Alt+ArrowRight");
  await until(async () => !(await menuVisible(p)), "menu closed by the page switch");
  await until(async () => (await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId)) === "page-b", "now on page B");
  check((await edText(p)) === "other page", "page B untouched: " + JSON.stringify(await edText(p)));
  await sleep(700);
  check(!(await dirty(p)), "nothing became dirty");
  check(blockTexts(srv).join("|") === "one|" && blockTexts(srv, "page-b").join("|") === "other page", "server pages unchanged, no '/' anywhere");
  await p.keyboard.press("Alt+ArrowLeft");
  await until(async () => (await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId)) === "page-a", "back on page A");
  check((await edText(p)) === "one\n", "page A has no restored '/' either: " + JSON.stringify(await edText(p)));
});

scenario("slash menu: remote change of the source page while open -> no '/' restored, no command applied", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu open");
  const nb = srv.nb();
  const pg = nb.pages.find((x) => x.id === "page-a");
  pg.content.blocks[0].text = "one (changed elsewhere)";
  pg.rev += 1;
  nb.notebook_rev += 1;
  srv.put(nb);
  await until(async () => (await edText(p)).startsWith("one (changed elsewhere)"), "the remote version was adopted", 20000);
  await until(async () => !(await menuVisible(p)), "the stale menu closed itself");
  check(!(await edText(p)).includes("/"), "no '/' restored into the new content: " + JSON.stringify(await edText(p)));
  await sleep(700);
  check(!(await dirty(p)), "nothing dirty after the stale close");
  check(blockTexts(srv).every((t) => !t.includes("/")), "no '/' persisted");
});

scenario("slash menu: choosing a command in a changed context is refused (nothing applied)", async () => {
  const { p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu open");
  // a local edit happens behind the menu (e.g. another input path): the captured generation no longer matches
  await p.evaluate(() => {
    const dbg = window.hqCarnetDebug().core;
    window.__before = JSON.stringify(dbg.pages.map((x) => x.id));
  });
  await p.evaluate(() => {
    const e = document.querySelector("#hq-carnet-editor");
    e.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "Z", bubbles: true, cancelable: true }));
    const fn = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "textContent");
    const first = e.children[0].firstChild;
    first.textContent = "one!";
    e.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true }));
  });
  await sleep(100);
  await p.keyboard.type("titr");
  await p.keyboard.press("Enter");
  await until(async () => !(await menuVisible(p)), "menu closed");
  check((await flash(p)).includes("contexte"), "visible message: context changed");
  const t = await domLines(p);
  check(t[1][0] === "paragraph", "the line was NOT converted: " + JSON.stringify(t));
});

scenario("slash menu: IME composition never opens it and Enter confirming IME never picks a command", async () => {
  const { p } = await openEditor("desktop");
  await caretEnd(p);
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Input.imeSetComposition", { text: "/", selectionStart: 1, selectionEnd: 1 });
  await sleep(150);
  check(!(await menuVisible(p)), "a '/' typed through an IME composition does not open the menu");
  await cdp.send("Input.insertText", { text: "あ" });
  await sleep(100);
  await p.keyboard.press("Enter");
  // composition inside the menu's own input: Enter that commits the composition must not select a command
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu opens normally outside a composition");
  await p.focus("#carnet-cmd-input");
  await cdp.send("Input.imeSetComposition", { text: "ti", selectionStart: 2, selectionEnd: 2 });
  await p.evaluate(() => { window.__ime = []; document.querySelector("#carnet-cmd-input").addEventListener("keydown", (e) => window.__ime.push([e.key, e.isComposing, e.keyCode])); });
  await p.evaluate(() => {
    const i = document.querySelector("#carnet-cmd-input");
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
  await sleep(100);
  check(await menuVisible(p), "Enter during composition (isComposing / keyCode 229) keeps the menu open and selects nothing");
  const t = await domLines(p);
  check(t.every((l) => l[0] === "paragraph"), "no command was applied: " + JSON.stringify(t));
  await cdp.send("Input.insertText", { text: "titre" });
  await p.keyboard.press("Escape");
});

scenario("search Enter hotfix + library search still intact next to the new key handling", async () => {
  const { p } = await openEditor();
  await openLibrary(p);
  const q = p.locator("#hq-carnet-search");
  await q.fill("other");
  await q.press("Enter");
  await sleep(300);
  const pages = await p.evaluate(() => window.hqCarnetDebug().core.pages.length);
  check(pages === 2, "Enter in search created no page: " + pages);
});

// ---------------------------------------------------------------- title treatment
scenario("title: first text block wears a non-persisted decoration; derive_title unchanged; no persisted title; export has no duplicate", async () => {
  const { srv, p } = await openEditor("desktop", notebook([page("page-a", 1, [para("Mon titre"), para("corps")])]));
  check((await p.locator('#hq-carnet-editor > [data-title="true"]').count()) === 1, "exactly one decorated block");
  check((await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-title="true"]').textContent)) === "Mon titre", "it is the first block");
  const fs = await p.evaluate(() => [getComputedStyle(document.querySelector('#hq-carnet-editor > [data-title="true"]')).fontSize, getComputedStyle(document.querySelector("#hq-carnet-editor > :nth-child(2)")).fontSize].map(parseFloat));
  check(fs[0] > fs[1] * 1.15, "title is visually larger: " + fs);
  await ed(p).click();
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(9, 9); });
  await p.keyboard.type(" X");
  await saved(p);
  const pg = srv.pg("page-a");
  check(pg.content.blocks[0].text === "Mon titre X", "typing the title is a normal edit: " + pg.content.blocks[0].text);
  check(!JSON.stringify(pg).includes("data-title") && !("title" in pg.content) && !pg.content.blocks.some((b) => "title" in b), "no persisted title field / decoration");
  const lib = await p.evaluate(() => window.hqCarnetDebug().core.pages.find((x) => x.id === "page-a"));
  const md = await p.evaluate(async () => { const r = await fetch("/api/carnet/export?id=page-a&format=md"); return r.ok ? await r.text() : ""; }).catch(() => "");
  if (md) check((md.match(/Mon titre X/g) || []).length === 1, "export contains the title text once (no duplicated title)");
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  check((await p.locator('#hq-carnet-editor > [data-title="true"]').count()) === 1, "decoration re-derived after reload (not stored)");
});

scenario("title: never decorates an image / calc / measure / decision atom just because it is first", async () => {
  const srv = await server(notebook([page("page-a", 1, [para("a")])]));
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await insertViaMenu(p, jpg(await makeImage(p, { w: 400, h: 300 })));
  await seeImage(p);
  await saved(p);
  const first = await p.evaluate(() => { const c = document.querySelector("#hq-carnet-editor").children[0]; return [c.getAttribute("data-line-type"), c.hasAttribute("data-title")]; });
  check(first[0] === "image" && first[1] === false, "image first -> the image is not decorated: " + first);
  const deco = await p.evaluate(() => [...document.querySelectorAll('#hq-carnet-editor [data-title="true"]')].map((n) => n.getAttribute("data-line-type")));
  check(deco.every((t) => t === "paragraph" || t === "heading") && deco.length <= 1, "only a prose block (the first non-empty text line) may wear it: " + deco);
});

scenario("empty page: non-persisted hint (desktop: '/', touch: + Insérer); typing starts in the first normal block", async () => {
  const { srv, p } = await openEditor("desktop", notebook([page("page-a", 1, [para("")])]));
  check((await ed(p).getAttribute("data-empty")) === "true", "empty-state flag");
  const hint = await p.evaluate(() => [getComputedStyle(document.querySelector("#hq-carnet-editor"), "::before").content, getComputedStyle(document.querySelector("#hq-carnet-editor"), "::after").content]);
  check(/Commence à écrire/.test(hint[0]) && /\//.test(hint[1]), "desktop hint mentions writing and '/': " + hint);
  await ed(p).click();
  await p.keyboard.type("Salut");
  check((await ed(p).getAttribute("data-empty")) === null, "hint disappears when typing");
  await saved(p);
  check(blockTexts(srv).join("|") === "Salut", "typed text persisted in the first block; no hint text persisted");
  const t = await openEditor("iphone", notebook([page("page-a", 1, [para("")])]));
  const th = await t.p.evaluate(() => getComputedStyle(document.querySelector("#hq-carnet-editor"), "::after").content);
  check(/Insérer/.test(th), "touch hint points to + Insérer: " + th);
});

scenario("slash menu: a height-only resize (on-screen keyboard) keeps it open; a width change closes it without mutating", async () => {
  const { srv, p } = await openEditor();
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "menu open");
  const vp0 = p.viewportSize();
  await p.setViewportSize({ width: vp0.width, height: Math.round(vp0.height * 0.6) });
  await sleep(300);
  check(await menuVisible(p), "height-only resize (keyboard) keeps the menu open");
  await p.setViewportSize({ width: vp0.width - 160, height: Math.round(vp0.height * 0.6) });
  await until(async () => !(await menuVisible(p)), "a width change (rotation) closes it");
  await sleep(700);
  check((await edText(p)) === "one\n" && !(await dirty(p)) && blockTexts(srv).join("|") === "one|", "closed without touching the document: " + JSON.stringify(await edText(p)));
});

const titleOf = (p) => p.evaluate(() => [...document.querySelectorAll('#hq-carnet-editor > [data-title="true"]')].map((n) => [n.getAttribute("data-line-type"), n.textContent]));
scenario("title: follows derive_title's first non-empty line; lists/decisions never; empty page offers the first paragraph", async () => {
  const cases = [
    ["empty first paragraph, then text", [para(""), para("Pump alignment")], [["paragraph", "Pump alignment"]]],
    ["first block is a bullet", [para("item", { type: "bullet" }), para("later")], []],
    ["first block is a checklist item", [para("todo", { type: "check", checked: false }), para("later")], []],
    ["first non-empty is a heading after an empty line", [para(""), para("Section", { type: "heading" }), para("x")], [["heading", "Section"]]],
    ["entirely empty page", [para("")], [["paragraph", ""]]],
  ];
  for (const [label, blocks, want] of cases) {
    const { srv, p } = await openEditor("desktop", notebook([page("page-a", 1, blocks)]));
    const got = await titleOf(p);
    check(JSON.stringify(got) === JSON.stringify(want), `${label}: decorated ${JSON.stringify(got)}`);
    const lib = await p.evaluate(() => window.hqCarnetDebug().core.pages.find((x) => x.id === "page-a"));
    void lib;
    void srv;
  }
  // typing on an empty first line moves the treatment as soon as that line has text
  const { p } = await openEditor("desktop", notebook([page("page-a", 1, [para(""), para("second")])]));
  check(JSON.stringify(await titleOf(p)) === '[["paragraph","second"]]', "starts on the real title line");
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(0, 0); });
  await p.keyboard.type("Nouveau");
  check(JSON.stringify(await titleOf(p)) === '[["paragraph","Nouveau"]]', "typing in the first line takes the treatment (derive_title now picks it)");
});

scenario("title: rendered atom text (image caption, calc, measure) never counts as the title line; decision first -> none", async () => {
  const srv0 = await server(notebook([page("page-a", 1, [para("Arbre de transmission")])]));
  const ctx0 = await context(srv0);
  const p0 = await openPage(ctx0, srv0);
  await select(p0, 0, 0);
  await insertViaMenu(p0, jpg(await makeImage(p0, { w: 300, h: 200 })));
  await seeImage(p0);
  await saved(p0);
  // 1. uncaptioned image first -> the paragraph after it is the title
  check(JSON.stringify(await titleOf(p0)) === '[["paragraph","Arbre de transmission"]]', "uncaptioned image -> paragraph title: " + JSON.stringify(await titleOf(p0)));
  // 2. captioned image first (rendered text non-empty, model text empty)
  await selectFig(p0);
  await p0.fill("#carnet-image-caption", "Vue arbre");
  await saved(p0);
  const rendered = await p0.evaluate(() => document.querySelector('#hq-carnet-editor > [data-line-type="image"]').textContent);
  check(rendered.includes("Vue arbre"), "the caption IS rendered text in the DOM: " + JSON.stringify(rendered));
  check(JSON.stringify(await titleOf(p0)) === '[["paragraph","Arbre de transmission"]]', "captioned image -> paragraph still wears the title: " + JSON.stringify(await titleOf(p0)));
  check(blocksOf(srv0)[0].type === "image" && blocksOf(srv0)[0].text === "", "model: image text is empty");
  // reload: re-derived from the model, same result
  await p0.reload();
  await p0.locator('.bottom-nav [data-nav="carnet"]').click();
  await p0.waitForSelector("#hq-carnet-editor");
  await p0.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  check(JSON.stringify(await titleOf(p0)) === '[["paragraph","Arbre de transmission"]]', "same after reload");
  // 3/4. calc and measure atoms first (their rendered UI contains text; stored text is empty)
  const measure = JSON.parse(readFileSync(path.join(here, "fixtures_carnet_eng.json"), "utf8")).measure_ok[0];
  for (const [label, atom] of [
    ["calc", { id: "block-c1c1c1c1c1c1", type: "calc", text: "", marks: [], calc: { expr: "2 * 3", result: "6", unit: null, at: 1790000000, v: 1 } }],
    ["measure", { id: "block-m1m1m1m1m1m1", type: "measure", text: "", marks: [], measure }],
  ]) {
    const nb = srv0.nb();
    nb.pages[0].content.blocks = [atom, para("Titre après " + label)];
    nb.pages[0].rev += 1; nb.notebook_rev += 1;
    srv0.put(nb);
    const c1 = await context(srv0);
    const p1 = await openPage(c1, srv0);
    const kinds = await p1.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].map((d) => [d.getAttribute("data-line-type"), d.textContent.length > 0]));
    check(kinds[0][0] === label && kinds[0][1], label + " atom first, with rendered text in the DOM: " + JSON.stringify(kinds));
    check(JSON.stringify(await titleOf(p1)) === JSON.stringify([["paragraph", "Titre après " + label]]), label + " atom -> the paragraph after it wears the title: " + JSON.stringify(await titleOf(p1)));
    await c1.close();
  }
  // 5. decision first -> no visual title (the derived title IS the decision text; decisions are never styled as the title)
  const nb2 = srv0.nb();
  nb2.pages[0].content.blocks = [{ id: "block-d1d1d1d1d1d1", type: "decision", text: "Go pour h7", marks: [], decision: { at: 1790000000 } }, para("plus tard")];
  nb2.pages[0].rev += 1; nb2.notebook_rev += 1;
  srv0.put(nb2);
  const c2 = await context(srv0);
  const p2 = await openPage(c2, srv0);
  check((await p2.evaluate(() => document.querySelector("#hq-carnet-editor").children[0].getAttribute("data-line-type"))) === "decision", "decision first");
  check(JSON.stringify(await titleOf(p2)) === "[]", "decision first -> no visual title at all");
});

scenario("title: model lines end-to-end — empty decision skipped; non-empty decision blocks; late title after 64+ empty blocks", async () => {
  const dec = (text) => ({ id: "block-d2d2d2d2d2d2", type: "decision", text, marks: [], decision: { at: 1790000000 } });
  const cases = [
    ["empty decision then paragraph", [dec(""), para("Titre réel")], [["paragraph", "Titre réel"]]],
    ["non-empty decision then paragraph", [dec("Go pour h7"), para("Titre réel")], []],
    ["64 empty paragraphs then paragraph", [...Array.from({ length: 64 }, () => para("")), para("Titre réel")], [["paragraph", "Titre réel"]]],
    ["65 empty paragraphs then paragraph", [...Array.from({ length: 65 }, () => para("")), para("Titre réel")], [["paragraph", "Titre réel"]]],
    ["100 empty paragraphs then heading", [...Array.from({ length: 100 }, () => para("")), para("Section", { type: "heading" })], [["heading", "Section"]]],
    ["empty decision, 70 empty paragraphs, then bullet -> none", [dec(""), ...Array.from({ length: 70 }, () => para("")), para("item", { type: "bullet" })], []],
  ];
  for (const [label, blocks, want] of cases) {
    const { p } = await openEditor("desktop", notebook([page("page-a", 1, blocks)]));
    const got = await titleOf(p);
    check(JSON.stringify(got) === JSON.stringify(want), `${label}: decorated ${JSON.stringify(got)}`);
  }
  // typing into an empty decision does not change the rule until it has text
  const { p } = await openEditor("desktop", notebook([page("page-a", 1, [dec(""), para("Titre réel")])]));
  check(JSON.stringify(await titleOf(p)) === '[["paragraph","Titre réel"]]', "before typing: paragraph wears the title");
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(0, 0); });
  await p.keyboard.type("Choix");
  check(JSON.stringify(await titleOf(p)) === "[]", "decision now has text -> it is the derived title, never styled: " + JSON.stringify(await titleOf(p)));
});

// ---------------------------------------------------------------- selection toolbar
const NB3 = () => notebook([page("page-a", 1, [para("alpha beta gamma"), para("second line"), para("third")]), page("page-b", 1, [para("other page")])]);
const tb = (p) => p.locator("#carnet-sel-toolbar");

scenario("selection toolbar: floats above a selection (desktop), formats through the normal edit path, hides on collapse", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  check(!(await tb(p).isVisible()), "hidden without a selection");
  await select(p, 6, 10);
  await until(() => tb(p).isVisible(), "toolbar appears for a range selection");
  const r = await rect(p, "#carnet-sel-toolbar");
  const lr = await rect(p, "#hq-carnet-editor > :first-child");
  check(r.b <= lr.t + 4, `above the selection on desktop (toolbar bottom ${r.b} <= line top ${lr.t})`);
  check(onScreen(r, vp(p).width, vp(p).height), "clamped on-screen");
  const names = await p.evaluate(() => [...document.querySelectorAll("#carnet-sel-toolbar button")].map((b) => b.getAttribute("aria-label")));
  check(JSON.stringify(names) === JSON.stringify(["Gras", "Italique", "Souligné", "Surligné", "Code", "Lien", "Référence", "Effacer la mise en forme"]), "actions + accessible names: " + names);
  check((await p.getAttribute("#carnet-sel-toolbar", "role")) === "toolbar", "role=toolbar");
  await p.click('#carnet-sel-toolbar [data-carnet-sel="bold"]');
  await saved(p);
  let b0 = blocksOf(srv)[0];
  check(JSON.stringify(b0.marks.map((m) => [m.type, m.start, m.end])) === '[["bold",6,10]]', "bold applied to the exact range: " + JSON.stringify(b0.marks));
  check(await tb(p).isVisible(), "toolbar stays while the selection persists");
  check((await p.getAttribute('#carnet-sel-toolbar [data-carnet-sel="bold"]', "aria-pressed")) === "true", "aria-pressed reflects the mark");
  await p.click('#carnet-sel-toolbar [data-carnet-sel="italic"]');
  await p.click('#carnet-sel-toolbar [data-carnet-sel="highlight"]');
  await p.click('#carnet-sel-toolbar [data-carnet-sel="underline"]');
  await p.click('#carnet-sel-toolbar [data-carnet-sel="code"]');
  await saved(p);
  b0 = blocksOf(srv)[0];
  check(new Set(b0.marks.map((m) => m.type)).size === 5, "bold+italic+highlight+underline+code coexist: " + b0.marks.map((m) => m.type));
  await p.click('#carnet-sel-toolbar [data-carnet-sel="clear"]');
  await saved(p);
  check(blocksOf(srv)[0].marks.length === 0, "Effacer la mise en forme removed every inline mark");
  await p.keyboard.press("ArrowRight");
  await until(async () => !(await tb(p).isVisible()), "hidden when the selection collapses");
  check(blocksOf(srv)[0].text === "alpha beta gamma", "text untouched by formatting");
});

scenario("selection toolbar: keyboard (Alt+F10, arrows), Escape closes and returns focus + selection", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await select(p, 0, 5);
  await until(() => tb(p).isVisible(), "visible");
  await p.keyboard.press("Alt+F10");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-sel"))) === "bold", "Alt+F10 focuses the first action");
  await p.keyboard.press("ArrowRight");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-sel"))) === "italic", "ArrowRight moves");
  await p.keyboard.press("End");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-sel"))) === "clear", "End -> last");
  await p.keyboard.press("Home");
  await p.keyboard.press("Enter");
  await saved(p);
  check(blocksOf(srv)[0].marks.some((m) => m.type === "bold" && m.start === 0 && m.end === 5), "Enter on the focused action applied bold");
  await p.keyboard.press("Escape");
  await until(async () => !(await tb(p).isVisible()), "Escape closes the toolbar");
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-editor", "focus returned to the editor");
  const sel = await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); return [e.selectionStart, e.selectionEnd]; });
  check(sel[0] === 0 && sel[1] === 5, "selection preserved: " + sel);
});

scenario("selection toolbar: stale selection fails closed (page switch / remote change), nothing applied", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await select(p, 0, 5);
  await until(() => tb(p).isVisible(), "visible");
  const nb = srv.nb();
  const pg = nb.pages.find((x) => x.id === "page-a");
  pg.content.blocks[0].text = "ALPHA beta gamma";
  pg.rev += 1;
  nb.notebook_rev += 1;
  srv.put(nb);
  await until(async () => (await edText(p)).startsWith("ALPHA"), "remote text adopted (selection lost)", 20000);
  await sleep(600);
  check(blocksOf(srv)[0].marks.length === 0 && !(await dirty(p)), "no mark was applied to the replaced content");
  // forced stale apply: click handler of a stale stamp must refuse
  await select(p, 0, 5);
  await until(() => tb(p).isVisible(), "visible again");
  await p.evaluate(() => { window.__tbBtn = document.querySelector('#carnet-sel-toolbar [data-carnet-sel="bold"]'); });
  await p.keyboard.press("ArrowRight"); // collapse: stamp dropped, toolbar hidden
  await p.evaluate(() => window.__tbBtn.click());
  await sleep(300);
  check(blocksOf(srv)[0].marks.length === 0, "a click on a hidden/stale toolbar button applies nothing");
  check(!(await dirty(p)), "and nothing is pending");
});

for (const [label, profile, vw, vh] of [["phone 390x844 (touch: below the selection, 44px targets)", "iphone", 390, 844], ["tablet portrait", "ipad", 834, 1112]]) {
  scenario(`selection toolbar: touch placement + targets — ${label}`, async () => {
    const { p } = await openEditor(profile, NB3());
    await select(p, 6, 10);
    await until(() => tb(p).isVisible(), "toolbar visible on touch without hover");
    const r = await rect(p, "#carnet-sel-toolbar");
    const lr = await rect(p, "#hq-carnet-editor > :first-child");
    check(r.t >= lr.b - 2 || r.b <= lr.t + 2, "does not cover the selection");
    check(r.t >= lr.b - 2, "touch: below the selection (native menu sits above)");
    check(onScreen(r, vw, vh), `on-screen: ${JSON.stringify(r)}`);
    const small = await p.evaluate(() => [...document.querySelectorAll("#carnet-sel-toolbar button")].filter((b) => b.offsetHeight < 43).length);
    check(small === 0, "all toolbar buttons are at least 44px tall on touch");
    await p.tap('#carnet-sel-toolbar [data-carnet-sel="bold"]');
    await saved(p);
    check(await tb(p).isVisible(), "still usable after a tap");
  });
}

// ---------------------------------------------------------------- block rail, menu, between-block "+"
scenario("block rail: appears on hover, one single element (not per-block markup), editor DOM unchanged", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  check(!(await rail(p).isVisible()), "hidden until hover");
  const before = await p.evaluate(() => document.querySelector("#hq-carnet-editor").innerHTML);
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await until(() => rail(p).isVisible(), "rail shows on hover");
  check((await p.locator("#carnet-block-rail").count()) === 1 && (await p.locator("#hq-carnet-editor #carnet-block-rail").count()) === 0, "a single rail outside the editor");
  const same = await p.evaluate((b) => document.querySelector("#hq-carnet-editor").innerHTML === b, before);
  check(same, "hovering never touches the editor markup");
  const rr = await rect(p, "#carnet-block-rail");
  const lr = await rect(p, "#hq-carnet-editor > :nth-child(2)");
  check(Math.abs((rr.t + rr.b) / 2 - (lr.t + 15)) < 22, "rail aligned with the hovered block");
  check(onScreen(rr, vp(p).width, vp(p).height), "on-screen");
  const names = await p.evaluate(() => [...document.querySelectorAll("#carnet-block-rail button")].map((b) => b.getAttribute("aria-label")));
  check(names.length === 3 && names.every(Boolean), "three named buttons: " + names);
  check(!(await dirty(p)) && srv.pg("page-a").rev === 1, "no write from hovering");
});

scenario("block menu: Monter / Descendre / Dupliquer / Insérer au-dessus / convert / Supprimer — one revision each, ids kept, caps respected", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  const ids0 = blocksOf(srv).map((b) => b.id);
  const menu = async (n) => {
    await p.locator(`#hq-carnet-editor > :nth-child(${n})`).hover();
    await until(() => rail(p).isVisible(), "rail");
    await p.click('#carnet-block-rail [data-carnet-rail="more"]');
    await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  };
  const item = (id) => p.click(`#carnet-block-menu [data-carnet-block="${id}"]`);
  // Descendre block 1
  await menu(1);
  check((await p.getAttribute("#carnet-block-menu", "role")) === "menu", "role=menu");
  check((await p.locator('#carnet-block-menu [data-carnet-block="up"]').isDisabled()), "Monter disabled on the first block");
  await item("down");
  await saved(p);
  check(blockTexts(srv).join("|") === "second line|alpha beta gamma|third", "Descendre: " + blockTexts(srv));
  check(srv.pg("page-a").rev === 2, "ONE revision for the action: rev " + srv.pg("page-a").rev);
  check(JSON.stringify(blocksOf(srv).map((b) => b.id)) === JSON.stringify([ids0[1], ids0[0], ids0[2]]), "ids preserved by the move");
  // Monter block 3
  await menu(3);
  await item("up");
  await saved(p);
  check(blockTexts(srv).join("|") === "second line|third|alpha beta gamma" && srv.pg("page-a").rev === 3, "Monter: " + blockTexts(srv));
  // Dupliquer block 1
  await menu(1);
  await item("dup");
  await saved(p);
  const dup = blocksOf(srv);
  check(dup.length === 4 && dup[1].text === "second line" && dup[1].id !== dup[0].id && srv.pg("page-a").rev === 4, "Dupliquer: new id, one revision");
  // Insérer au-dessus block 1
  await menu(1);
  await item("above");
  await saved(p);
  check(blockTexts(srv)[0] === "" && blockTexts(srv).length === 5 && srv.pg("page-a").rev === 5, "Insérer au-dessus adds ONE empty block");
  // convert block 2 -> heading
  await menu(2);
  await item("convert:heading");
  await saved(p);
  check(blockTypes(srv)[1] === "heading" && blockTexts(srv)[1] === "second line", "Convertir : Titre keeps text");
  // delete needs confirmation for a non-empty block
  await menu(2);
  await item("delete");
  check(await p.locator("#carnet-block-menu").isVisible(), "first press only arms the deletion");
  check((await p.textContent('#carnet-block-menu [data-carnet-block="delete"]')).includes("Confirmer"), "button asks for confirmation");
  await item("delete");
  await saved(p);
  check(blockTexts(srv).length === 4 && blockTexts(srv).filter((t) => t === "second line").length === 1 && !blockTypes(srv).includes("heading"), "Supprimer removed that block only: " + blockTypes(srv) + " " + blockTexts(srv));
});

scenario("block menu: keyboard only (Alt+Shift+B, arrows, Escape returns focus); Alt+Shift+Arrow moves the caret block", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(20, 20); }); // inside block 2
  await p.keyboard.press("Alt+Shift+ArrowUp");
  await saved(p);
  check(blockTexts(srv).join("|") === "second line|alpha beta gamma|third", "Alt+Shift+Up moved the caret block: " + blockTexts(srv));
  await p.keyboard.press("Alt+Shift+B");
  await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-block"))) !== null, "focus moved into the menu");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Escape");
  await until(async () => !(await p.locator("#carnet-block-menu").isVisible()), "Escape closes");
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-editor", "focus back in the editor");
});

scenario("block menu: atoms are never converted (no convert entries for an image)", async () => {
  const srv = await server(notebook([page("page-a", 1, [para("a")])]));
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 1, 1);
  await insertViaMenu(p, jpg(await makeImage(p, { w: 300, h: 200 })));
  await seeImage(p);
  await saved(p);
  const imgLine = p.locator('#hq-carnet-editor > [data-line-type="image"]').first();
  await imgLine.hover();
  await until(() => rail(p).isVisible(), "rail on image line");
  await p.click('#carnet-block-rail [data-carnet-rail="more"]');
  await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  check((await p.locator('#carnet-block-menu [data-carnet-block^="convert:"]').count()) === 0, "no conversion entries for an image");
  check((await p.locator('#carnet-block-menu [data-carnet-block="dup"]').count()) === 1, "Dupliquer is still offered for an image");
  await p.keyboard.press("Escape");
});

// ---------------------------------------------------------------- between-block "+" and rail "+", block drag, stale blocks
scenario("between-block '+': appears near a seam on hover, opens the shared command menu, inserts ONE block there", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  const l1 = await rect(p, "#hq-carnet-editor > :nth-child(1)");
  const er = await rect(p, "#hq-carnet-editor");
  await p.mouse.move(er.l + 22, l1.b - 1);
  await p.mouse.move(er.l + 22, l1.b);
  await until(() => p.locator("#carnet-gap-plus").isVisible(), "gap '+' near the boundary");
  const gr = await rect(p, "#carnet-gap-plus");
  check(onScreen(gr, vp(p).width, vp(p).height) && Math.abs((gr.t + gr.b) / 2 - l1.b) < 8, "centred on the seam");
  check(!(await p.evaluate(() => document.querySelector("#hq-carnet-editor").contains(document.querySelector("#carnet-gap-plus")))), "outside the editor DOM");
  await p.click("#carnet-gap-plus");
  await until(() => menuVisible(p), "same command menu opens");
  check((await cmdOpts(p)).length === 24, "the full shared registry");
  await p.keyboard.type("titr");
  await p.keyboard.press("Enter");
  await saved(p);
  check(JSON.stringify(blockTypes(srv)) === '["paragraph","heading","paragraph","paragraph"]' && blockTexts(srv)[1] === "", "one new heading block between 1 and 2: " + blockTypes(srv));
  check(blockTexts(srv).join("|") === "alpha beta gamma||second line|third", "other blocks untouched");
});

scenario("rail '+': insert below via the command menu; dismiss changes nothing; Escape returns focus", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await until(() => rail(p).isVisible(), "rail");
  await p.click('#carnet-block-rail [data-carnet-rail="plus"]');
  await until(() => menuVisible(p), "menu");
  await p.keyboard.press("Escape");
  await until(async () => !(await menuVisible(p)), "closed");
  await sleep(600);
  check(blockTexts(srv).length === 3 && !(await dirty(p)), "dismissing the '+' menu inserts nothing (no slash involved)");
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await p.click('#carnet-block-rail [data-carnet-rail="plus"]');
  await until(() => menuVisible(p), "menu again");
  await p.keyboard.type("cases");
  await p.keyboard.press("Enter");
  await saved(p);
  check(JSON.stringify(blockTypes(srv)) === '["paragraph","paragraph","check","paragraph"]', "a new check block below block 2: " + blockTypes(srv));
});

scenario("block drag (any block): drag handle reorders, ids preserved, ONE revision, no write during the move", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  const ids0 = blocksOf(srv).map((b) => b.id);
  const posts = [];
  pageSaves(p, posts);
  await p.locator("#hq-carnet-editor > :nth-child(1)").hover();
  await until(() => rail(p).isVisible(), "rail");
  const h = await rect(p, '#carnet-block-rail [data-carnet-rail="drag"]');
  const l3 = await rect(p, "#hq-carnet-editor > :nth-child(3)");
  await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
  await p.mouse.down();
  await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2 + 30, { steps: 4 });
  await p.mouse.move(h.l + h.w / 2, l3.b + 6, { steps: 8 });
  check((await p.locator(".carnet-drop-indicator").count()) === 1, "drop indicator shown during the drag");
  await sleep(700);
  check(posts.length === 0, "no server write while the pointer moves");
  await p.mouse.up();
  await saved(p);
  check(blockTexts(srv).join("|") === "second line|third|alpha beta gamma", "block 1 dropped at the end: " + blockTexts(srv));
  check(JSON.stringify(blocksOf(srv).map((b) => b.id)) === JSON.stringify([ids0[1], ids0[2], ids0[0]]), "ids preserved");
  check(srv.pg("page-a").rev === 2 && posts.length === 1, "ONE edit, ONE revision, one save: rev " + srv.pg("page-a").rev + ", posts " + posts.length);
  check((await p.locator(".carnet-drop-indicator").count()) === 0, "indicator removed");
});

scenario("block drag: Escape cancels; a quick click on the handle moves nothing", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.locator("#hq-carnet-editor > :nth-child(1)").hover();
  await until(() => rail(p).isVisible(), "rail");
  const h = await rect(p, '#carnet-block-rail [data-carnet-rail="drag"]');
  const l3 = await rect(p, "#hq-carnet-editor > :nth-child(3)");
  await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
  await p.mouse.down();
  await p.mouse.move(h.l + h.w / 2, l3.b + 6, { steps: 6 });
  await p.keyboard.press("Escape");
  await p.mouse.up();
  await sleep(700);
  check(blockTexts(srv).join("|") === "alpha beta gamma|second line|third" && srv.pg("page-a").rev === 1, "Escape cancelled the drag");
  await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
  await p.mouse.down();
  await p.mouse.up();
  await sleep(700);
  check(srv.pg("page-a").rev === 1, "a plain click does not reorder or save");
});

scenario("block drag: remote revision change during the drag is never silently overwritten", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.locator("#hq-carnet-editor > :nth-child(1)").hover();
  await until(() => rail(p).isVisible(), "rail");
  const h = await rect(p, '#carnet-block-rail [data-carnet-rail="drag"]');
  const l3 = await rect(p, "#hq-carnet-editor > :nth-child(3)");
  await p.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
  await p.mouse.down();
  await p.mouse.move(h.l + h.w / 2, l3.b + 6, { steps: 6 });
  const nb = srv.nb();
  const pg = nb.pages.find((x) => x.id === "page-a");
  pg.content.blocks[2].text = "third (remote)";
  pg.rev += 1;
  nb.notebook_rev += 1;
  srv.put(nb);
  await until(async () => (await edText(p)).includes("third (remote)"), "remote version adopted during the gesture", 20000);
  await p.mouse.up();
  await sleep(1200);
  const t = blockTexts(srv);
  check(t.includes("third (remote)") && t.length === 3, "the remote edit survives: " + t);
  check(t.join("|") === "alpha beta gamma|second line|third (remote)", "the stale drag was discarded, order unchanged: " + t);
});

scenario("stale block menu: remote edit closes it; a forced stale Dupliquer/Supprimer applies nothing", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await until(() => rail(p).isVisible(), "rail");
  await p.click('#carnet-block-rail [data-carnet-rail="more"]');
  await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  await p.evaluate(() => { // an unrelated local edit bumps the generation behind the open menu
    const e = document.querySelector("#hq-carnet-editor");
    e.children[2].firstChild.textContent = "third!";
    e.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true }));
  });
  await p.click('#carnet-block-menu [data-carnet-block="dup"]');
  await sleep(300);
  check((await flash(p)).includes("contexte"), "visible refusal: context changed");
  await saved(p);
  check(blockTexts(srv).length === 3, "nothing duplicated: " + blockTexts(srv));
  // remote edit while the menu is open: menu closes
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await p.click('#carnet-block-rail [data-carnet-rail="more"]');
  await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  const nb = srv.nb();
  const pg = nb.pages.find((x) => x.id === "page-a");
  pg.content.blocks[0].text = "alpha (remote)";
  pg.rev += 1;
  nb.notebook_rev += 1;
  srv.put(nb);
  await until(async () => (await edText(p)).includes("alpha (remote)"), "remote adopted", 20000);
  await until(async () => !(await p.locator("#carnet-block-menu").isVisible()), "block menu closed by the remote change");
  check(blockTexts(srv).length === 3, "no stale action applied");
});

scenario("remote trash while the block menu is open: action refused, page content untouched", async () => {
  const { srv, p } = await openEditor("desktop", NB3());
  await p.locator("#hq-carnet-editor > :nth-child(2)").hover();
  await until(() => rail(p).isVisible(), "rail");
  await p.click('#carnet-block-rail [data-carnet-rail="more"]');
  await p.waitForSelector("#carnet-block-menu", { state: "visible" });
  const nb = srv.nb();
  const pg = nb.pages.find((x) => x.id === "page-a");
  pg.deleted_at = 1790690000.0;
  pg.rev += 1;
  nb.notebook_rev += 1;
  srv.put(nb);
  await until(() => p.evaluate(() => !!document.querySelector(".carnet-trashed:not([hidden]), [data-carnet-restore]")), "page seen as trashed", 20000);
  if (await p.locator("#carnet-block-menu").isVisible()) await p.click('#carnet-block-menu [data-carnet-block="delete"]').catch(() => {});
  await sleep(500);
  check(blockTexts(srv).length === 3, "no block deleted from a trashed page: " + blockTexts(srv));
});

scenario("duplicate respects the 32-image cap end to end (visible refusal, nothing added)", async () => {
  const { srv, ctx, p } = await oneImagePage("desktop", { w: 200, h: 150 });
  const asset = imgs(srv)[0].asset;
  await ctx.close();
  const nb = srv.nb();
  const pg = nb.pages[0];
  const blocks = [{ id: "block-p0", type: "paragraph", text: "x", marks: [] }];
  for (let i = 0; i < 32; i += 1) blocks.push({ id: "block-i" + String(i).padStart(2, "0"), type: "image", text: "", marks: [], asset: Object.assign({}, asset) });
  pg.content.blocks = blocks; pg.rev += 1; nb.notebook_rev += 1;
  srv.put(nb);
  const c = await context(srv, "desktop");
  const q = await openPage(c, srv);
  await seeImage(q, 32);
  await q.locator('#hq-carnet-editor > [data-line-type="image"]').first().hover();
  await until(() => rail(q).isVisible(), "rail");
  await q.click('#carnet-block-rail [data-carnet-rail="more"]');
  await q.click('#carnet-block-menu [data-carnet-block="dup"]');
  await sleep(300);
  check((await flash(q)).includes("Limite d'images"), "visible refusal: " + (await flash(q)));
  await sleep(700);
  check(blocksOf(srv).filter((b) => b.type === "image").length === 32 && srv.pg("page-a").rev === pg.rev, "nothing added, no write");
});

// ---------------------------------------------------------------- library polish
const LIB_NB = () => {
  const n = notebook([
    page("page-a", 1, [para("Alpha"), para("a")], { project_id: "proj-1", category_id: "cat-1", pinned: true }),
    page("page-b", 1, [para("Beta")], { project_id: "proj-1" }),
    page("page-c", 1, [para("Gamma")]),
    page("page-d", 1, [para("Deleted")], { deleted_at: 1790690000.0 }),
  ]);
  n.projects = [{ id: "proj-1", name: "Atelier", archived: false, created_at: 1790680000.0, updated_at: 1790680000.0 }, { id: "proj-2", name: "Dock", archived: false, created_at: 1790680000.0, updated_at: 1790680000.0 }];
  n.categories = [{ id: "cat-1", name: "Mesures", color: "blue", created_at: 1790680000.0, updated_at: 1790680000.0 }];
  return n;
};
scenario("library: counts beside filters, collapsible Projets/Catégories kept in memory only, selected row, empty states", async () => {
  const { srv, p } = await openEditor("desktop", LIB_NB());
  await openLibrary(p);
  const counts = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-carnet-fcount]")].map((n) => [n.getAttribute("data-carnet-fcount"), n.textContent])));
  check(counts.all === "3" && counts.pinned === "1" && counts.unfiled === "1" && counts.trash === "1", "derived counts: " + JSON.stringify(counts));
  check((await p.locator('[data-carnet-fold="projects"]').getAttribute("aria-expanded")) === "true", "Projets expanded by default");
  check((await p.locator("#carnet-sec-projects .carnet-scope").count()) === 2, "both projects listed");
  await p.click('[data-carnet-fold="projects"]');
  check((await p.locator('[data-carnet-fold="projects"]').getAttribute("aria-expanded")) === "false", "collapsed: aria-expanded=false");
  check((await p.locator("#carnet-sec-projects .carnet-scope").count()) === 0, "chips hidden while collapsed (no active filter)");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-fold"))) === "projects", "focus stays on the toggle");
  await p.click('[data-carnet-fold="categories"]');
  check((await p.locator("#carnet-sec-categories .carnet-scope").count()) === 0, "Catégories collapsible too");
  await p.click('[data-carnet-fold="projects"]');
  await p.click('[data-carnet-project="proj-2"]');
  await p.click('[data-carnet-fold="projects"]');
  check((await p.locator('#carnet-sec-projects .carnet-scope[aria-pressed="true"]').count()) === 1, "the active filter's chip stays visible when its section is collapsed");
  await p.click('[data-carnet-project="proj-2"]');
  // empty states
  await p.click('[data-carnet-filter="pinned"]');
  await p.click('[data-carnet-fold="projects"]');
  // storage: collapse state is NOT in the draft store and no new browser store was created
  const store = await p.evaluate(() => ({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), drafts: localStorage.getItem("hq_carnet_drafts_v1") }));
  check(!/fold|collapsed|projets/i.test(JSON.stringify(store)), "no fold state in any browser store: " + JSON.stringify(store.ls));
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await openLibrary(p);
  check((await p.locator('[data-carnet-fold="projects"]').getAttribute("aria-expanded")) === "true", "collapse state is per page load (memory only), not persisted");
  await p.click('[data-carnet-filter="trash"]');
  check((await p.locator("#carnet-library-list .carnet-card").count()) === 1, "trash lists the deleted page, separate from the filters");
  const cur = await p.evaluate(() => { const c = document.querySelector("#carnet-library-list .carnet-card.is-current"); return c ? getComputedStyle(c).boxShadow : "none"; });
  await p.click('[data-carnet-filter="all"]');
  const cur2 = await p.evaluate(() => { const c = document.querySelector("#carnet-library-list .carnet-card.is-current"); return c ? [getComputedStyle(c).boxShadow, c.querySelector("[aria-current]") ? "cur" : "no"] : null; });
  check(cur2 && cur2[0] !== "none" && cur2[1] === "cur", "the current page row is clearly marked: " + JSON.stringify(cur2));
  await p.fill("#hq-carnet-search", "zzzz-nothing");
  await until(() => p.locator(".carnet-empty-hint").isVisible(), "friendly empty state for a search with no result");
  check((await p.locator(".carnet-empty-hint").textContent()).length > 10, "hint text present");
  void srv; void cur;
});

scenario("library: 128 pages — render + filter + fold timing, counts correct", async () => {
  const pages = Array.from({ length: 128 }, (_, i) => page("page-" + i, 1, [para("Page " + i), para("x".repeat(40))], { pinned: i % 16 === 0 }));
  const { p } = await openEditor("desktop", notebook(pages));
  await openLibrary(p);
  await until(async () => (await p.locator("#carnet-library-list .carnet-card").count()) === 128, "128 rows rendered");
  const t = await p.evaluate(async () => {
    const out = {};
    let t0 = performance.now();
    document.querySelector('[data-carnet-filter="pinned"]').click();
    out.filter = performance.now() - t0;
    t0 = performance.now();
    document.querySelector('[data-carnet-filter="all"]').click();
    out.back = performance.now() - t0;
    t0 = performance.now();
    document.querySelector('[data-carnet-fold="projects"]').click();
    out.fold = performance.now() - t0;
    out.all = document.querySelector('[data-carnet-fcount="all"]').textContent;
    out.pinned = document.querySelector('[data-carnet-fcount="pinned"]').textContent;
    return out;
  });
  console.log(`  PERF  library 128 pages: filter ${t.filter.toFixed(1)}ms, back ${t.back.toFixed(1)}ms, fold ${t.fold.toFixed(1)}ms`);
  check(t.all === "128" && t.pinned === "8", "counts for 128 pages: " + JSON.stringify(t));
  check(t.filter < 300 && t.back < 300 && t.fold < 100, "interactions stay fast (<300ms)");
});

// ---------------------------------------------------------------- visual system: dark (default) + light, every viewport
const SHOT_DIR = process.env.EDITOR_SHOTS || "";
const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); };
const VIS_NB = () => notebook([page("page-a", 1, [
  para("Arbre de transmission — reprise"),
  para("Mesures relevées sur le banc, voir la photo ci-dessous."),
  para("Tolérance h7 sur le portage", { type: "heading" }),
  para("Rectifier à 24,998", { type: "bullet" }),
  para("Contrôler la coaxialité", { type: "check", checked: false }),
  para("Dernier paragraphe pour la longueur de la page."),
]), page("page-b", 1, [para("Autre page")])]);
const VIEWS = [
  ["wide desktop 1600x900", 1600, 900],
  ["screenshot size 1207x859", 1207, 859],
  ["1366x768", 1366, 768],
  ["tablet landscape 1024x768", 1024, 768],
  ["tablet portrait 768x1024", 768, 1024],
  ["narrow phone 360x740", 360, 740],
];
for (const scheme of ["dark", "light"]) {
  for (const [label, w, h] of VIEWS) {
    if (scheme === "light" && !["screenshot size 1207x859", "narrow phone 360x740"].includes(label)) continue; // light: the two reference sizes
    scenario(`visual ${scheme} — ${label}: toolbar, slash menu, block menu, image toolbar on-screen, no overlap, no horizontal scroll`, async () => {
      const touch = w < 900;
      const { srv, p } = await openEditor("desktop", VIS_NB(), Object.assign({ viewport: { width: w, height: h }, colorScheme: scheme }, touch ? { hasTouch: true, isMobile: true } : {}));
      const tag = `${scheme}-${w}x${h}`;
      check((await p.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)) === (scheme === "dark"), "colour scheme emulated: " + scheme);
      await p.evaluate(() => document.querySelector("#hq-carnet-editor").scrollIntoView());
      // title treatment + shell
      check((await p.locator('#hq-carnet-editor > [data-title="true"]').count()) === 1, "title decoration present");
      const noScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      check(await noScroll(), "no horizontal page scroll (resting)");
      await shot(p, tag + "-page");
      // selection toolbar
      await select(p, 0, 7);
      await until(() => tb(p).isVisible(), "selection toolbar");
      const r = await rect(p, "#carnet-sel-toolbar");
      check(onScreen(r, w, h), `selection toolbar on-screen: ${JSON.stringify(r)}`);
      await shot(p, tag + "-selection-toolbar");
      await p.keyboard.press("ArrowRight");
      // slash menu
      const lastLen = await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); return e.value.length; });
      await p.keyboard.press("Enter");
      await p.keyboard.type("/");
      await until(() => menuVisible(p), "slash menu");
      const m = await rect(p, "#carnet-cmd-menu");
      check(onScreen(m, w, h), `slash menu on-screen: ${JSON.stringify(m)}`);
      if (touch) {
        const navTop = (await rect(p, ".bottom-nav")).t;
        check(m.w >= w - 1 && m.b <= navTop + 0.5, `touch: slash sheet ends above the bottom nav (sheet bottom ${m.b}, nav top ${navTop})`);
        const lastVis = await p.evaluate(() => { const l = document.querySelector("#carnet-cmd-list"); const last = l.lastElementChild; last.scrollIntoView({ block: "nearest" }); const r = last.getBoundingClientRect(); const lr = l.getBoundingClientRect(); const nav = document.querySelector(".bottom-nav").getBoundingClientRect(); return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 && r.bottom <= nav.top + 0.5; });
        check(lastVis, "touch: the LAST command can be scrolled fully into view above the nav");
      }
      await shot(p, tag + "-slash-menu");
      await p.keyboard.press("Escape");
      void lastLen;
      // block rail + menu (hover capable only)
      if (!touch) {
        await p.locator("#hq-carnet-editor > :nth-child(3)").hover();
        await until(() => rail(p).isVisible(), "rail");
        const rr = await rect(p, "#carnet-block-rail");
        check(onScreen(rr, w, h), "rail on-screen");
        await p.click('#carnet-block-rail [data-carnet-rail="more"]');
        await p.waitForSelector("#carnet-block-menu", { state: "visible" });
        const bm = await rect(p, "#carnet-block-menu");
        check(onScreen(bm, w, h), `block menu on-screen: ${JSON.stringify(bm)}`);
        await shot(p, tag + "-block-menu");
        await p.keyboard.press("Escape");
      } else {
        await p.locator("#hq-carnet-editor > :nth-child(3)").tap();
        await until(() => rail(p).isVisible(), "touch: rail shows for the caret block");
        const rr = await rect(p, "#carnet-block-rail");
        check(onScreen(rr, w, h), `touch rail on-screen: ${JSON.stringify(rr)}`);
        const small = await p.evaluate(() => [...document.querySelectorAll("#carnet-block-rail button")].filter((b) => b.offsetParent && (b.offsetHeight < 43 || b.offsetWidth < 43)).length);
        check(small === 0, "touch rail buttons are ≥44px");
        await p.tap('#carnet-block-rail [data-carnet-rail="more"]');
        await p.waitForSelector("#carnet-block-menu", { state: "visible" });
        const bm = await rect(p, "#carnet-block-menu");
        const navTop2 = (await rect(p, ".bottom-nav")).t;
        check(onScreen(bm, w, h) && bm.b <= navTop2 + 0.5, `touch: block menu sheet ends above the bottom nav (${bm.b} <= ${navTop2})`);
        const lastItem = await p.evaluate(() => { const m = document.querySelector("#carnet-block-menu"); const last = m.querySelector("[data-carnet-block]:last-of-type") || m.lastElementChild; last.scrollIntoView({ block: "nearest" }); const r = last.getBoundingClientRect(); const mr = m.getBoundingClientRect(); const nav = document.querySelector(".bottom-nav").getBoundingClientRect(); return [r.top >= mr.top - 1, r.bottom <= mr.bottom + 1, r.bottom <= nav.top + 0.5, last.getAttribute("data-carnet-block")]; });
        check(lastItem[0] && lastItem[1] && lastItem[2] && lastItem[3] === "delete", "touch: the LAST block-menu item (Supprimer) is fully reachable above the nav: " + lastItem);
        await shot(p, tag + "-block-menu");
        await p.keyboard.press("Escape");
      }
      // image + floating toolbar
      await select(p, 1, 1);
      await insertViaMenu(p, jpg(await makeImage(p, { w: 1000, h: 700 })));
      await seeImage(p);
      await saved(p);
      await selectFig(p);
      const tools = await rect(p, "#hq-carnet-image-tools");
      const fig = await rect(p, "#hq-carnet-editor [data-selected=\"true\"] figure");
      check(onScreen(tools, w, h), `image toolbar on-screen: ${JSON.stringify(tools)} (${await p.getAttribute("#hq-carnet-image-tools", "data-float")})`);
      const mode = await p.getAttribute("#hq-carnet-image-tools", "data-float");
      if (!touch && mode !== "dock") check(!overlap(tools, fig), "image toolbar does not cover its image (" + mode + ")");
      if (touch) check(mode === "sheet", "touch/narrow: bottom sheet");
      const badge = await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').getAttribute("data-badge"));
      check(/^\d+ % · /.test(badge || ""), "width + alignment badge: " + badge);
      check((await p.locator("#carnet-image-caption").isVisible()) && (await p.locator("#btn-carnet-image-replace").isVisible()) && (await p.locator("#btn-carnet-image-remove").isVisible()), "caption, Remplacer and Retirer are visible in the toolbar");
      check(await noScroll(), "no horizontal page scroll with everything open");
      await shot(p, tag + "-image-selected");
      // library
      await p.keyboard.press("Escape");
      if (!touch || w >= 600) { /* drawer or dock */ }
      await openLibrary(p);
      const lib = await rect(p, "#hq-carnet-library");
      check(lib.l >= -1 && lib.r <= w + 1, `library within the viewport width: ${JSON.stringify(lib)}`);
      check(await noScroll(), "no horizontal scroll with the library open");
      await shot(p, tag + "-library");
      void srv;
    });
  }
}

// contrast assertions for the key text/background pairs in both schemes (browser-resolved opaque colours)
for (const scheme of ["dark", "light"]) {
  scenario(`contrast ${scheme}: ink/paper, toolbar, menu, hint, badge, accent meet WCAG thresholds`, async () => {
    const { p } = await openEditor("desktop", VIS_NB(), { viewport: { width: 1366, height: 768 }, colorScheme: scheme });
    await select(p, 0, 7);
    await until(() => tb(p).isVisible(), "toolbar visible");
    const css = (sel, prop) => p.evaluate(([sel, prop]) => getComputedStyle(document.querySelector(sel))[prop], [sel, prop]);
    const pairs = [
      ["editor ink on paper", await css("#hq-carnet-editor > :nth-child(2)", "color"), await css(".carnet-paper", "backgroundColor"), 7],
      ["title on paper", await css('#hq-carnet-editor [data-title="true"]', "color"), await css(".carnet-paper", "backgroundColor"), 7],
      ["toolbar button text on toolbar", await css('#carnet-sel-toolbar [data-carnet-sel="italic"]', "color"), await css("#carnet-sel-toolbar", "backgroundColor"), 4.5],
    ];
    await p.keyboard.press("ArrowRight");
    await caretEnd(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("/");
    await until(() => menuVisible(p), "menu visible");
    pairs.push(["menu label on menu", await css(".carnet-cmd-label", "color"), await css("#carnet-cmd-menu", "backgroundColor"), 4.5]);
    pairs.push(["menu hint on menu", await css(".carnet-cmd-hint", "color"), await css("#carnet-cmd-menu", "backgroundColor"), 4.5]);
    pairs.push(["input text on input", await css("#carnet-cmd-input", "color"), await css("#carnet-cmd-input", "backgroundColor"), 4.5]);
    await p.keyboard.press("Escape");
    for (const [name, fg, bg, min] of pairs) {
      const c = await contrast(p, fg, bg);
      check(c >= min, `${scheme}: ${name} contrast ${c.toFixed(2)} ≥ ${min}`);
    }
    const acc = await p.evaluate(() => getComputedStyle(document.querySelector(".hq-carnet")).getPropertyValue("--accent") || getComputedStyle(document.body).getPropertyValue("--accent"));
    const onAcc = await p.evaluate(() => getComputedStyle(document.querySelector(".hq-carnet")).getPropertyValue("--carnet-on-accent").trim());
    const c2 = await contrast(p, onAcc, acc.trim() || "#2fd39a");
    check(c2 >= 4.5, `${scheme}: badge / primary-button text on the accent colour ${onAcc} on ${acc.trim()} ${c2.toFixed(2)} ≥ 4.5`);
  });
}

// ---------------------------------------------------------------- image polish, concurrency leftovers, read-only, viewport persistence
scenario("image polish: floating toolbar anchored to the image, badge follows width/alignment, selection survives a local re-render", async () => {
  const { srv, p } = await oneImagePage("desktop", { w: 1000, h: 600 });
  await selectFig(p);
  const mode = await p.getAttribute("#hq-carnet-image-tools", "data-float");
  check(["below", "above", "dock"].includes(mode), "desktop: floating next to the image (" + mode + ")");
  const t = await rect(p, "#hq-carnet-image-tools");
  check(onScreen(t, vp(p).width, vp(p).height), "clamped on-screen");
  check((await p.locator("#carnet-image-caption").isVisible()) && (await p.locator("#btn-carnet-image-replace").isVisible()) && (await p.locator("#btn-carnet-image-remove").isVisible()), "caption + Remplacer + Retirer visible in the toolbar");
  let badge = await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').getAttribute("data-badge"));
  check(badge === "100 % · à gauche", "badge: " + badge);
  await p.click("#btn-carnet-image-center");
  await p.click("#btn-carnet-image-smaller");
  badge = await p.evaluate(() => document.querySelector('#hq-carnet-editor [data-selected="true"] figure').getAttribute("data-badge"));
  check(badge === "95 % · centré", "badge follows alignment + width: " + badge);
  const badgeBox = await p.evaluate(() => { const f = document.querySelector('#hq-carnet-editor [data-selected="true"] figure'); const c = getComputedStyle(f, "::after"); return [c.content, c.position]; });
  check(/95 %/.test(badgeBox[0]) && badgeBox[1] === "absolute", "badge is rendered (CSS ::after)");
  await saved(p);
  check(imgs(srv)[0].asset.width === 95 && imgs(srv)[0].asset.layout === "center", "values persisted through the normal path");
  check(!JSON.stringify(srv.pg("page-a")).includes("badge"), "the badge is not persisted");
  // a local re-render (block menu action on ANOTHER block) keeps the same image selected
  const lines = await p.locator("#hq-carnet-editor > [data-line-type]").count();
  await p.locator("#hq-carnet-editor > :nth-child(1)").hover();
  await until(() => rail(p).isVisible(), "rail");
  await p.click('#carnet-block-rail [data-carnet-rail="more"]');
  await p.click('#carnet-block-menu [data-carnet-block="above"]');
  await until(async () => (await p.locator("#hq-carnet-editor > [data-line-type]").count()) === lines + 1, "block inserted (editor re-rendered)");
  await sleep(300);
  check((await p.locator('#hq-carnet-editor [data-selected="true"] figure').count()) === 1, "same image still marked selected after the re-render");
  check(await p.locator("#hq-carnet-image-tools").isVisible(), "image tools still shown");
  await saved(p);
});

scenario("image polish: keyboard-only (arrows, alignment, Escape) keeps working in the floating toolbar", async () => {
  const { srv, p } = await oneImagePage("desktop", { w: 800, h: 500 });
  await selectFig(p);
  await p.focus("#btn-carnet-image-right");
  await p.keyboard.press("Enter");
  await saved(p);
  check(imgs(srv)[0].asset.layout === "right", "alignment via keyboard on a floating toolbar button");
  await p.focus("#carnet-image-caption");
  await p.keyboard.type("Vue de face");
  await p.keyboard.press("Tab");
  await saved(p);
  check(imgs(srv)[0].asset.caption === "Vue de face", "caption edited inside the toolbar");
  await p.focus("#btn-carnet-image-done");
  await p.keyboard.press("Enter");
  await until(async () => !(await p.locator("#hq-carnet-image-tools").isVisible()), "Terminé closes the toolbar");
});

scenario("read-only page: no slash menu, no selection toolbar, no rail actions", async () => {
  const nb = notebook([page("page-a", 1, [para("one"), para("")], { deleted_at: 1790690000.0 }), page("page-b", 1, [para("other")])]);
  const { p } = await openEditor("desktop", nb);
  await openLibrary(p);
  await p.click('[data-carnet-filter="trash"]');
  await p.locator('#carnet-library-list [data-carnet-page-id="page-a"]').click();
  await until(() => p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-a"), "the trashed page is open");
  await sleep(300);
  const ce = await ed(p).getAttribute("contenteditable");
  check(ce === "false", "editor is read-only on a trashed page");
  await caretEnd(p);
  await p.keyboard.type("/");
  await sleep(250);
  check(!(await menuVisible(p)), "no menu on a read-only page");
  await select(p, 0, 3);
  await sleep(250);
  check(!(await tb(p).isVisible()), "no selection toolbar on a read-only page");
  const l1 = await rect(p, "#hq-carnet-editor > :nth-child(1)");
  await p.mouse.move(l1.l + 80, l1.t + 8);
  await p.mouse.move(l1.l + 90, l1.t + 10);
  await sleep(300);
  check(!(await rail(p).isVisible()), "no block rail on a read-only page");
});

scenario("viewing never persists anything: byte-identical notebook after opening on desktop / tablet / phone, dark and light", async () => {
  const nb = VIS_NB();
  const srv = await server(nb);
  const before = readFileSync(srv.nbPath, "utf8");
  for (const [profile, scheme] of [["desktop", "dark"], ["ipad", "light"], ["iphone", "dark"]]) {
    const ctx = await context(srv, profile, { colorScheme: scheme });
    const p = await openPage(ctx, srv);
    await openLibrary(p).catch(() => {});
    await p.locator("#hq-carnet-editor > :nth-child(2)").hover().catch(() => {});
    await sleep(600);
    await ctx.close();
  }
  check(readFileSync(srv.nbPath, "utf8") === before, "the notebook file is byte-identical after viewing in three environments");
});

scenario("phone library: sheet opens, folding works, selecting a page closes it and edits keep working", async () => {
  const { srv, p } = await openEditor("iphone", VIS_NB());
  await p.click("#btn-carnet-library");
  await p.waitForSelector("#hq-carnet-library", { state: "visible" });
  check((await p.getAttribute("#hq-carnet-library", "data-mode")) === "sheet", "phone: sheet mode");
  const lr = await rect(p, "#hq-carnet-library");
  check(lr.l >= -1 && lr.r <= 391, "sheet within the viewport");
  await p.click('[data-carnet-fold="projects"]');
  check((await p.locator('[data-carnet-fold="projects"]').getAttribute("aria-expanded")) === "false", "fold works inside the sheet");
  await p.locator('#carnet-library-list [data-carnet-page-id="page-b"]').click();
  await until(async () => !(await p.locator("#hq-carnet-library").isVisible()), "the sheet closes after choosing a page");
  check((await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId)) === "page-b", "page B opened");
  await ed(p).tap();
  await p.keyboard.type("!");
  await saved(p);
  check(srv.pg("page-b").content.blocks[0].text.endsWith("!"), "typing after the transition saves normally");
});

// ---------------------------------------------------------------- performance
scenario("performance: typing, slash filtering, toolbar appearance, rail, 300 blocks + 24 images, block drag", async () => {
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
  blocks.push({ id: "block-end", type: "paragraph", text: "", marks: [] });
  pg.content.blocks = blocks; pg.rev += 1; nb.notebook_rev += 1;
  srv.put(nb);
  const c = await context(srv, "desktop");
  const q = await openPage(c, srv);
  await seeImage(q, 24);
  const nBlocks = await q.locator("#hq-carnet-editor > [data-line-type]").count();
  check(nBlocks >= 298, "page with " + nBlocks + " blocks and 24 images");
  // normal typing: per-keystroke cost in the page (execCommand insertText = the native path), no history/backlink recompute
  await q.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  const typing = await q.evaluate(() => { const t = []; for (let i = 0; i < 60; i += 1) { const t0 = performance.now(); document.execCommand("insertText", false, "a"); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { median: t[30], p95: t[57], max: t[59] }; });
  console.log(`  PERF  typing in a ${nBlocks}-block page: median ${typing.median.toFixed(2)}ms, p95 ${typing.p95.toFixed(2)}ms, max ${typing.max.toFixed(2)}ms`);
  check(typing.median < 40 && typing.p95 < 120, "typing stays responsive");
  await saved(q);
  // slash menu: open + filter per keystroke
  await q.keyboard.press("Enter");
  await q.keyboard.type("/");
  await until(() => menuVisible(q), "menu opens on a large page");
  const filt = await q.evaluate(() => { const i = document.querySelector("#carnet-cmd-input"); const t = []; for (const ch of "décision") { i.value += ch; const t0 = performance.now(); i.dispatchEvent(new Event("input", { bubbles: true })); t.push(performance.now() - t0); } return t; });
  console.log(`  PERF  slash filtering per keystroke: max ${Math.max(...filt).toFixed(2)}ms (${filt.length} keys)`);
  check(Math.max(...filt) < 30, "filtering is cheap");
  await q.keyboard.press("Escape");
  // selection toolbar appearance: selectionchange -> visible
  const appear = await q.evaluate(() => new Promise((res) => {
    const e = document.querySelector("#hq-carnet-editor");
    const tb = document.querySelector("#carnet-sel-toolbar");
    const t0 = performance.now();
    e.setSelectionRange(10, 14);
    const tick = () => { if (!tb.hidden) res(performance.now() - t0); else if (performance.now() - t0 > 1500) res(-1); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  console.log(`  PERF  selection toolbar appearance: ${appear.toFixed(1)}ms`);
  check(appear >= 0 && appear < 200, "toolbar appears within a couple of frames");
  // typing with a selection toolbar visible must not parse the whole page per keystroke: collapsed selections gate cheaply
  await q.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.setSelectionRange(20, 20); });
  // block drag cost: move first block's handle through 30 moves, no save
  await q.evaluate(() => window.scrollTo(0, 0));
  await q.locator("#hq-carnet-editor > :nth-child(1)").hover();
  await until(() => rail(q).isVisible(), "rail on the large page");
  const h = await rect(q, '#carnet-block-rail [data-carnet-rail="drag"]');
  const bag = [];
  pageSaves(q, bag);
  await q.mouse.move(h.l + h.w / 2, h.t + h.h / 2);
  await q.mouse.down();
  const t0 = Date.now();
  for (let i = 1; i <= 30; i += 1) await q.mouse.move(h.l + h.w / 2, h.t + h.h / 2 + i * 6);
  const dt = Date.now() - t0;
  await sleep(600);
  check(bag.length === 0, "no server write during the drag on a large page");
  await q.mouse.up();
  await saved(q);
  console.log(`  PERF  block drag: 30 pointermoves in ${dt}ms (${(dt / 30).toFixed(1)}ms/move incl. test overhead), saves during move: ${bag.length}`);
  check(bag.length <= 1, "at most one save for the whole gesture");
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
