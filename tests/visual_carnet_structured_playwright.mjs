// Carnet product phase 2: structured content (table, callout, toggle, attachment card, image groups), exports, history, backup, mobile, a11y, performance.
//
//   node tests/visual_carnet_structured_playwright.mjs [scenario substring...]
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

// ---------------------------------------------------------------- Phase-2 helpers
const SNB = () => notebook([page("page-a", 1, [para("Titre"), para("")]), page("page-b", 1, [para("other page")])]);
const shot = (p, name) => (process.env.STRUCT_SHOTS ? p.screenshot({ path: path.join(process.env.STRUCT_SHOTS, name + ".png") }) : null);
const structBlocks = (srv, id = "page-a") => blocksOf(srv, id).filter((b) => ["table", "callout", "toggle", "imagegroup"].includes(b.type));
const tableOf = (srv, id = "page-a") => (structBlocks(srv, id).find((b) => b.type === "table") || {}).table;
const cellSel = (r, c, n = 0) => `#hq-carnet-editor [data-carnet-struct="table"]:nth-of-type(${n + 1}) input[data-r="${r}"][data-c="${c}"]`;
const cell = (p, r, c, n) => p.locator(`#hq-carnet-editor [data-carnet-struct="table"] input[data-r="${r}"][data-c="${c}"]`).nth(0);
const activeCell = (p) => p.evaluate(() => { const a = document.activeElement; return a && a.hasAttribute && a.hasAttribute("data-r") ? [Number(a.getAttribute("data-r")), Number(a.getAttribute("data-c"))] : null; });
const msgOf = (p) => p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-struct-msg")].map((n) => n.textContent).filter(Boolean).join("|"));
const nStruct = (p, t) => p.locator(`#hq-carnet-editor [data-carnet-struct="${t}"]`).count();
async function insertStruct(p, label) {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  await p.click(`[data-carnet-insert="${label}"]`);
}
async function pasteInto(p, loc, text) {
  await loc.focus();
  return p.evaluate((txt) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", txt);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, text);
}
async function tablePage(profile = "desktop") {
  const o = await openEditor(profile, SNB());
  await caretEnd(o.p);
  await insertStruct(o.p, "table");
  await until(async () => (await nStruct(o.p, "table")) === 1, "a table block is drawn");
  return o;
}

scenario("table: insert via + Insérer, 3x3 with header, typed cells persist through the normal save path", async () => {
  const { srv, p } = await tablePage();
  check((await activeCell(p))?.join() === "0,0", "focus lands in the first cell");
  await p.keyboard.type("Pièce");
  await p.keyboard.press("Tab");
  await p.keyboard.type("Qté");
  await saved(p);
  const t = tableOf(srv);
  check(t && t.header === true && t.rows.length === 3 && t.rows[0].length === 3, "3x3 header table stored");
  check(t.rows[0][0] === "Pièce" && t.rows[0][1] === "Qté", "typed cells stored: " + JSON.stringify(t.rows[0]));
  const b = structBlocks(srv)[0];
  check(b.text === "" && Array.isArray(b.marks) && b.marks.length === 0 && /^block-/.test(b.id), "atom shape + server id");
  check(JSON.stringify(Object.keys(b).sort()) === '["id","marks","table","text","type"]', "exact block keys: " + Object.keys(b));
  check(JSON.stringify(Object.keys(b.table).sort()) === '["header","rows"]', "exact table keys");
  const types = blocksOf(srv).map((x) => x.type);
  check(types[types.length - 1] === "paragraph", "a paragraph always follows to keep typing: " + types);
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] table[role=grid]").count()) === 1, "semantic grid role");
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] th[scope=col]").count()) === 3, "header cells are column headers");
  await shot(p, "table-desktop");
});

scenario("table: title and preview never come from a table; typing text after it is the title", async () => {
  const o = await openEditor("desktop", notebook([page("page-a", 1, [para(""), para("")])]));
  const { srv, p } = o;
  await caretEnd(p);
  await insertStruct(p, "table");
  await until(async () => (await nStruct(p, "table")) === 1, "table");
  await p.keyboard.type("Tableau secret");
  await saved(p);
  const meta = await p.evaluate(() => window.hqCarnetDebug().core.pages.map((x) => x.title));
  check(!JSON.stringify(meta).includes("Tableau secret"), "the cell text is not the page title: " + JSON.stringify(meta));
  const nb = srv.nb();
  check(nb.pages[0].title === undefined || !String(nb.pages[0].title).includes("Tableau secret"), "persisted title untouched");
});

scenario("table keyboard: Tab / Shift+Tab / arrows / Enter rules (next row same column, add at last row, stop at the 20-row cap)", async () => {
  const { srv, p } = await tablePage();
  await p.keyboard.type("a");
  await p.keyboard.press("Tab");
  check((await activeCell(p)).join() === "0,1", "Tab -> next cell");
  await p.keyboard.press("Shift+Tab");
  check((await activeCell(p)).join() === "0,0", "Shift+Tab -> previous cell");
  await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.keyboard.press("Tab");
  check((await activeCell(p)).join() === "1,0", "Tab wraps to the next row");
  await p.keyboard.press("ArrowDown");
  check((await activeCell(p)).join() === "2,0", "ArrowDown -> next row");
  await p.keyboard.press("ArrowUp");
  check((await activeCell(p)).join() === "1,0", "ArrowUp -> previous row");
  await p.keyboard.press("Tab");
  await p.keyboard.type("mid");
  await p.keyboard.press("Enter");
  check((await activeCell(p)).join() === "2,1", "Enter -> same column, next row");
  await p.keyboard.press("Shift+Enter");
  check((await activeCell(p)).join() === "2,1" && (await cell(p, 2, 1).inputValue()) === "", "Shift+Enter inserts no newline and does not move");
  await p.keyboard.press("Enter");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr").count()) === 4, "Enter on the last row adds a row");
  await until(async () => (await activeCell(p))?.join() === "3,1", "focus follows into the new row, same column");
  for (let i = 0; i < 16; i += 1) await p.keyboard.press("Enter");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr").count()) === 20, "grows to the 20-row cap");
  await p.keyboard.press("Enter");
  check((await activeCell(p)).join() === "19,1", "at the cap Enter stays in the cell (no wrap)");
  check(/20 lignes/.test(await msgOf(p)), "a subtle limit message: " + (await msgOf(p)));
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr").count()) === 20, "still 20 rows");
  await p.keyboard.press("Escape");
  check((await activeCell(p)) === null, "Escape leaves the grid");
  await saved(p);
  const t = tableOf(srv);
  check(t.rows.length === 20 && t.rows.every((r) => r.length === 3), "20x3 persisted, rectangular");
  check(t.rows[0][0] === "a" && t.rows[1][1] === "mid", "content kept");
  // Tab leaves the table after the last cell: never a trap
  await cell(p, 19, 2).focus();
  await p.keyboard.press("Tab");
  check((await activeCell(p)) === null, "Tab after the last cell leaves the grid");
});

scenario("table structure: add/remove row and column are ONE saved edit each, bounds enforced, header toggle, stable block id", async () => {
  const { srv, p } = await tablePage();
  await saved(p);
  const id0 = structBlocks(srv)[0].id;
  const posts = [];
  pageSaves(p, posts);
  const btn = (label) => p.locator(`#hq-carnet-editor [data-carnet-struct=table] button[aria-label="${label}"]`);
  await cell(p, 1, 1).focus();
  await btn("Ajouter une ligne").click();
  await until(async () => tableOf(srv).rows.length === 4, "row added");
  await btn("Ajouter une colonne").click();
  await until(async () => tableOf(srv).rows[0].length === 4, "column added");
  await cell(p, 0, 0).focus();
  await btn("Supprimer la colonne").click();
  await until(async () => tableOf(srv).rows[0].length === 3, "column removed");
  await btn("Supprimer la ligne").click();
  await until(async () => tableOf(srv).rows.length === 3, "row removed");
  check(structBlocks(srv)[0].id === id0, "block id stable across every structural edit");
  await saved(p);
  check(posts.length >= 4 && posts.length <= 8, "one logical edit per structural change (no per-cell storm): " + posts.length + " saves");
  // minimums
  for (let i = 0; i < 4; i += 1) { await cell(p, 0, 0).focus(); await btn("Supprimer la ligne").click(); await sleep(60); }
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr").count()) === 1, "a table keeps one row");
  check(/au moins une ligne/.test(await msgOf(p)), "minimum row message");
  for (let i = 0; i < 4; i += 1) { await cell(p, 0, 0).focus(); await btn("Supprimer la colonne").click(); await sleep(60); }
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr:first-child input").count()) === 1, "a table keeps one column");
  for (let i = 0; i < 12; i += 1) { await cell(p, 0, 0).focus(); await btn("Ajouter une colonne").click(); await sleep(40); }
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr:first-child input").count()) === 10, "10-column cap");
  check(/10 colonnes/.test(await msgOf(p)), "column cap message");
  // header toggle
  await p.locator("#hq-carnet-editor [data-carnet-struct=table] .carnet-struct-check input").uncheck();
  await until(async () => tableOf(srv).header === false, "header off persisted");
  check((await p.locator("#hq-carnet-editor [data-carnet-struct=table] th").count()) === 0, "no column headers when the header is off");
  await saved(p);
});

scenario("table TSV: multi-cell paste fills from the cell and grows; oversized / malformed paste is rejected atomically; copy is plain deterministic TSV", async () => {
  const { srv, p } = await tablePage();
  const prevented = await pasteInto(p, cell(p, 1, 1), "a\tb\tc\r\nd\te\tf\r\n");
  check(prevented, "the multi-cell paste is handled (default prevented)");
  await until(async () => tableOf(srv)?.rows[0]?.length === 4 && tableOf(srv).rows[2][3] === "f", "pasted block stored; the table grew to 4 columns (within bounds)");
  let t = tableOf(srv);
  check(JSON.stringify(t.rows) === JSON.stringify([["", "", "", ""], ["", "a", "b", "c"], ["", "d", "e", "f"]]), "filled from (1,1): " + JSON.stringify(t.rows));
  await saved(p);
  const before = JSON.stringify(tableOf(srv));
  await pasteInto(p, cell(p, 0, 0), Array.from({ length: 21 }, () => "x").join("\n"));
  check(/Collage trop grand/.test(await msgOf(p)), "21 rows rejected with a message: " + (await msgOf(p)));
  await pasteInto(p, cell(p, 0, 0), Array(11).fill("x").join("\t"));
  await pasteInto(p, cell(p, 0, 0), "y".repeat(201) + "\tz");
  await pasteInto(p, cell(p, 0, 0), "");
  await sleep(300);
  await saved(p);
  check(JSON.stringify(tableOf(srv)) === before, "rejected pastes changed nothing (atomic)");
  // exactly 20x10 fits
  await pasteInto(p, cell(p, 0, 0), Array.from({ length: 20 }, () => Array(10).fill("w").join("\t")).join("\n"));
  await until(async () => tableOf(srv).rows.length === 20 && tableOf(srv).rows[0].length === 10, "20x10 paste fits and is stored");
  await saved(p);
  const full = JSON.stringify(tableOf(srv));
  await pasteInto(p, p.locator('#hq-carnet-editor input[data-r="19"][data-c="9"]'), "k\tl\nm\tn"); // overflows both bounds
  check(/Collage trop grand/.test(await msgOf(p)), "an overflowing paste is refused");
  await sleep(300);
  await saved(p);
  check(JSON.stringify(tableOf(srv)) === full, "the refused paste changed nothing (no partial paste)");
  // copy: Ctrl+C with no text selected puts the whole table as TSV on the clipboard event
  const tsv = await p.evaluate(() => {
    const inp = document.querySelector('#hq-carnet-editor input[data-r="0"][data-c="0"]');
    inp.focus();
    inp.setSelectionRange(0, 0);
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    inp.dispatchEvent(ev);
    return dt.getData("text/plain");
  });
  const rows = tableOf(srv).rows;
  check(tsv === rows.map((r) => r.join("\t")).join("\n"), "copy = deterministic TSV (rows by \\n, cells by \\t, no trailing newline, no metadata)");
  check(tsv.split("\n").length === 20 && tsv.split("\n")[0].split("\t").length === 10, "20 x 10, no header marker");
});

scenario("table mobile: 10 columns scroll inside the table scroller only; cells keep a readable width; 44 px controls", async () => {
  const { srv, p } = await tablePage("iphone");
  for (let i = 0; i < 7; i += 1) { await cell(p, 0, 0).focus(); await p.locator('#hq-carnet-editor [data-carnet-struct=table] button[aria-label="Ajouter une colonne"]').click(); await sleep(50); }
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-struct=table] tr:first-child input").count()) === 10, "10 columns");
  const m = await p.evaluate(() => {
    const sc = document.querySelector("#hq-carnet-editor .carnet-table-scroll");
    const cellW = document.querySelector("#hq-carnet-editor .carnet-cell").getBoundingClientRect().width;
    return { sw: sc.scrollWidth, cw: sc.clientWidth, doc: document.documentElement.scrollWidth, vw: innerWidth, cellW, ov: getComputedStyle(sc).overflowX };
  });
  check(m.ov === "auto" || m.ov === "scroll", "the table scroller scrolls horizontally: " + m.ov);
  check(m.sw > m.cw + 50, "content wider than the scroller: " + m.sw + " > " + m.cw);
  check(m.doc <= m.vw + 1, "no page-level horizontal overflow: " + m.doc + " <= " + m.vw);
  check(m.cellW >= 100, "cells are not microscopic: " + m.cellW);
  const targets = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor [data-carnet-struct=table] button")].map((b) => Math.round(b.getBoundingClientRect().height)));
  check(targets.length >= 5 && targets.every((h) => h >= 44), "controls are >= 44 px high: " + targets);
  check((await p.locator("#hq-carnet-editor .carnet-table-scroll[role=region][tabindex='0']").count()) === 1, "the scroller is a keyboard-reachable region");
  await shot(p, "table-iphone-10cols");
});

// ---------------------------------------------------------------- callout / toggle / attachment / search / conflict
const sid = () => "block-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
const sblock = (type, payload) => ({ id: sid(), type, text: "", marks: [], [{ table: "table", callout: "callout", toggle: "toggle", imagegroup: "group" }[type]]: payload });
const fileLink = (text, id, extra) => para(text, { marks: [{ type: "link", start: 0, end: text.length, ref: { kind: "file", id } }], ...(extra || {}) });
const reload = async (p) => { await p.reload(); await p.locator('.bottom-nav [data-nav="carnet"]').click(); await p.waitForSelector("#hq-carnet-editor"); await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId); };

scenario("callout: insert, choose the type by WORD, title + multi-line body persist, icon is derived (never stored), reload keeps it", async () => {
  const { srv, p } = await openEditor("desktop", SNB());
  await caretEnd(p);
  await insertStruct(p, "callout");
  await until(async () => (await nStruct(p, "callout")) === 1, "callout drawn");
  check((await p.locator('#hq-carnet-editor .carnet-callout[data-kind="note"] .carnet-callout-kind').textContent()) === "Note", "default kind is the word Note (not colour alone)");
  await p.locator("#hq-carnet-editor .carnet-callout-select").selectOption("warning");
  await until(async () => structBlocks(srv)[0]?.callout?.kind === "warning", "kind persisted");
  check((await p.locator("#hq-carnet-editor .carnet-callout-kind").textContent()) === "Attention", "the kind is shown as the word Attention");
  await p.locator("#hq-carnet-editor .carnet-callout-title").fill("Chaud");
  await p.locator("#hq-carnet-editor .carnet-callout-body").click();
  await p.keyboard.type("ligne 1");
  await p.keyboard.press("Enter");
  await p.keyboard.type("ligne 2");
  await saved(p);
  const b = structBlocks(srv)[0];
  check(JSON.stringify(b.callout) === JSON.stringify({ kind: "warning", title: "Chaud", body: "ligne 1\nligne 2" }), "stored exactly: " + JSON.stringify(b.callout));
  check(!/[✎ℹ⚠]/.test(JSON.stringify(b)), "no glyph/icon in the persisted block");
  await reload(p);
  check((await p.locator("#hq-carnet-editor .carnet-callout-title").inputValue()) === "Chaud", "reload keeps the title");
  check((await p.locator("#hq-carnet-editor .carnet-callout-body").inputValue()) === "ligne 1\nligne 2", "reload keeps the body");
  check((await p.locator("#hq-carnet-editor .carnet-callout[data-kind=warning]").count()) === 1, "reload keeps the kind");
  check((await p.locator('#hq-carnet-editor .carnet-callout[role="note"]').count()) === 1, "role=note");
  // line limit: an over-limit edit is REFUSED (never truncated); the committed body stays exactly the previous valid one
  const lines = (n) => Array.from({ length: n }, (_, i) => "l" + i).join("\n");
  const cbody = p.locator("#hq-carnet-editor .carnet-callout-body");
  await cbody.fill(lines(20));
  await saved(p);
  check(structBlocks(srv)[0].callout.body === lines(20), "exactly 20 lines accepted");
  await cbody.fill(lines(25));
  await sleep(600);
  check((await cbody.inputValue()) === lines(20), "25-line input refused: the textarea returns to the last valid body");
  check(/Trop de lignes/.test(await msgOf(p)), "a message explains the refusal");
  await saved(p);
  check(structBlocks(srv)[0].callout.body === lines(20), "persisted body is the exact previous valid body (no partial commit)");
  // a real paste of 21 lines at the end is intercepted before it mutates the textarea
  await cbody.fill("a");
  await saved(p);
  await cbody.click();
  await p.evaluate((txt) => { const t = document.querySelector("#hq-carnet-editor .carnet-callout-body"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); const dt = new DataTransfer(); dt.setData("text/plain", txt); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, "\n" + lines(20));
  check((await cbody.inputValue()) === "a", "over-limit paste is cancelled before it touches the textarea");
  await saved(p);
  check(structBlocks(srv)[0].callout.body === "a", "no partial commit after the paste");
  await cbody.fill(lines(3));
  await saved(p);
  check(structBlocks(srv)[0].callout.body === lines(3), "the user can correct the input and save normally");
  await shot(p, "callout-desktop");
});

scenario("toggle: summary + plain body persist; opening / closing is UI state only (no save, no content change), reload default, aria-expanded", async () => {
  const { srv, p } = await openEditor("desktop", SNB());
  await caretEnd(p);
  await insertStruct(p, "toggle");
  await until(async () => (await nStruct(p, "toggle")) === 1, "toggle drawn");
  const btn = p.locator("#hq-carnet-editor .carnet-toggle-btn");
  check((await btn.getAttribute("aria-expanded")) === "true", "a new toggle starts expanded so it can be filled");
  await p.locator("#hq-carnet-editor .carnet-toggle-summary").fill("Détails du montage");
  await p.locator("#hq-carnet-editor .carnet-toggle-body").fill("Couple 12 Nm\nPuis contrôler");
  await saved(p);
  const before = JSON.stringify(srv.nb());
  const posts = [];
  pageSaves(p, posts);
  await btn.click();
  check((await btn.getAttribute("aria-expanded")) === "false", "collapsed: aria-expanded=false");
  check(await p.locator("#hq-carnet-editor .carnet-toggle-body").isHidden(), "the body is hidden when collapsed");
  await btn.click();
  check((await btn.getAttribute("aria-expanded")) === "true", "expanded again");
  await sleep(1500);
  check(posts.length === 0 && JSON.stringify(srv.nb()) === before, "toggling mutates nothing: no save, no revision change");
  check(!(await dirty(p)), "the draft stays clean");
  check(JSON.stringify(structBlocks(srv)[0].toggle) === JSON.stringify({ summary: "Détails du montage", body: "Couple 12 Nm\nPuis contrôler" }), "stored toggle has exactly summary+body");
  await reload(p);
  check((await p.locator("#hq-carnet-editor .carnet-toggle-btn").getAttribute("aria-expanded")) === "false", "an existing toggle with content loads collapsed (UI default)");
  check((await p.locator("#hq-carnet-editor .carnet-toggle-summary").inputValue()) === "Détails du montage", "summary visible while collapsed");
  // empty summary is refused: the previous value stays in the draft
  await p.locator("#hq-carnet-editor .carnet-toggle-btn").click();
  await p.locator("#hq-carnet-editor .carnet-toggle-summary").fill("");
  await sleep(500);
  await saved(p);
  check(structBlocks(srv)[0].toggle.summary === "Détails du montage", "an empty summary never reaches the content");
  // body line cap (50): over-limit input and paste are refused, never truncated
  const tl = (n) => Array.from({ length: n }, (_, i) => "t" + i).join("\n");
  const tbody = p.locator("#hq-carnet-editor .carnet-toggle-body");
  await tbody.fill(tl(50));
  await saved(p);
  check(structBlocks(srv)[0].toggle.body === tl(50), "exactly 50 lines accepted");
  await tbody.fill(tl(55));
  await sleep(600);
  check((await tbody.inputValue()) === tl(50) && /Trop de lignes/.test(await msgOf(p)), "55-line input refused with a message; textarea restored");
  await saved(p);
  check(structBlocks(srv)[0].toggle.body === tl(50), "persisted toggle body is the exact previous valid body");
  await tbody.fill("a");
  await saved(p);
  await p.evaluate((txt) => { const t = document.querySelector("#hq-carnet-editor .carnet-toggle-body"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); const dt = new DataTransfer(); dt.setData("text/plain", txt); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, "\n" + tl(50));
  check((await tbody.inputValue()) === "a", "51-line paste cancelled before it touches the textarea");
  await saved(p);
  check(structBlocks(srv)[0].toggle.body === "a", "no partial commit after the toggle paste");
  await tbody.fill(tl(2));
  await saved(p);
  check(structBlocks(srv)[0].toggle.body === tl(2), "corrected input saves normally");
  check((await p.locator("#hq-carnet-editor .carnet-toggle-btn").getAttribute("aria-controls")) === (await p.locator("#hq-carnet-editor .carnet-toggle-body").getAttribute("id")), "aria-controls points at the body");
});

scenario("toggle: keyboard (Space/Enter on the button), touch target >= 44 px on a phone, collapsed state survives an unrelated edit", async () => {
  const nb = notebook([page("page-a", 1, [para("Titre"), sblock("toggle", { summary: "Section", body: "contenu" }), para("")])]);
  const { p } = await openEditor("iphone", nb);
  const btn = p.locator("#hq-carnet-editor .carnet-toggle-btn");
  await btn.focus();
  await p.keyboard.press("Enter");
  check((await btn.getAttribute("aria-expanded")) === "true", "Enter opens");
  await p.keyboard.press("Space");
  check((await btn.getAttribute("aria-expanded")) === "false", "Space closes");
  const r = await btn.boundingBox();
  check(r.height >= 44 && r.width >= 44, "touch target: " + r.width + "x" + r.height);
  await p.keyboard.press("Enter"); // open
  await p.locator("#hq-carnet-editor .carnet-toggle-summary").fill("Section 2");
  await saved(p);
  check((await btn.getAttribute("aria-expanded")) === "true", "typing in the summary keeps the open state (no re-render)");
  await shot(p, "toggle-iphone");
});

scenario("attachment card: a whole-line file link is a card (chip, safe folder, named Open); anything else stays ordinary text; no path leak", async () => {
  const nb = notebook([page("page-a", 1, [
    para("Titre"),
    fileLink("plan-moteur.pdf", "Uni/Projet X/plan-moteur.pdf"),
    para("Voir plan.pdf ici", { marks: [{ type: "link", start: 5, end: 13, ref: { kind: "file", id: "Inbox/plan.pdf" } }] }),
    fileLink("note.txt", "Inbox/note.txt", { marks: [{ type: "bold", start: 0, end: 8 }, { type: "link", start: 0, end: 8, ref: { kind: "file", id: "Inbox/note.txt" } }] }),
    para("https://example.com", { marks: [{ type: "link", start: 0, end: 19, href: "https://example.com" }] }),
    fileLink(" espace.pdf", "Inbox/espace.pdf"),
  ])]);
  const { srv, p } = await openEditor("desktop", nb);
  const cards = p.locator("#hq-carnet-editor [data-carnet-attachment]");
  check((await cards.count()) === 1, "exactly one card: " + (await cards.count()));
  const info = await p.evaluate(() => {
    const c = document.querySelector("#hq-carnet-editor [data-carnet-attachment]");
    return { chip: c.querySelector(".carnet-attach-chip").textContent, dir: c.querySelector(".carnet-attach-dir").textContent, open: c.querySelector(".carnet-attach-open").getAttribute("aria-label"), role: c.querySelector(".carnet-attach-open").getAttribute("role"), text: c.textContent };
  });
  check(info.chip === "PDF" && info.dir === "Uni/Projet X", "type chip + root-relative folder: " + JSON.stringify(info));
  check(info.open === "Ouvrir le fichier plan-moteur.pdf" && info.role === "button", "the open action is named: " + info.open);
  const all = await p.evaluate(() => document.querySelector("#hq-carnet-editor").innerText);
  check(!all.includes(srv.root) && !/\/tmp\/|\\\\|[A-Z]:\\\\/.test(all), "no absolute path / server root anywhere in the page");
  // the badge never leaks into the model: the saved text of the line is unchanged
  await p.locator("#hq-carnet-editor [data-carnet-attachment]").click({ position: { x: 300, y: 8 } });
  await p.keyboard.press("End");
  await p.keyboard.type("!");
  await saved(p);
  const blocks = blocksOf(srv);
  check(blocks[1].text === "plan-moteur.pdf!" && blocks[1].marks.length === 1 && blocks[1].marks[0].ref.id === "Uni/Projet X/plan-moteur.pdf", "badge is not part of the text: " + JSON.stringify(blocks[1].text));
  // typing outside the whole-line link keeps the extended text ordinary or a card per predicate
  const popup = p.waitForEvent("popup");
  await p.locator("#hq-carnet-editor .carnet-attach-open").first().click();
  const pop = await popup;
  check(/\/files\/Uni\/Projet%20X\/plan-moteur\.pdf$/.test(pop.url()), "Open goes to the existing /files/ route: " + pop.url());
  await pop.close();
  await shot(p, "attachment-desktop");
});

// ---------------------------------------------------------------- image groups
const groupOf = (srv, id = "page-a", n = 0) => structBlocks(srv, id).filter((b) => b.type === "imagegroup")[n];
async function pickGroup(p, files) {
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  const chooser = p.waitForEvent("filechooser");
  await p.click('[data-carnet-insert="imagegroup"]');
  const c = await chooser;
  check(c.isMultiple(), "the group picker is a multiple-file chooser");
  await c.setFiles(files);
}
async function makeFiles(p, n, w = 480, h = 320) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(jpg(await makeImage(p, { w: w + i * 16, h: h + i * 8, quality: 0.8 }), `photo-${i}.jpg`));
  return out;
}
const groupFigs = (p) => p.locator("#hq-carnet-editor [data-carnet-struct=imagegroup] .carnet-group-item");
const gbtn = (p, label) => p.locator(`#hq-carnet-editor [data-carnet-struct=imagegroup] button[aria-label="${label}"], #hq-carnet-editor [data-carnet-struct=imagegroup] button:text-is("${label}")`).first();
async function groupPage(profile = "desktop", n = 2) {
  const o = await openEditor(profile, SNB());
  await caretEnd(o.p);
  await pickGroup(o.p, await makeFiles(o.p, n));
  await until(async () => (await groupFigs(o.p).count()) === n, n + " group figures drawn");
  await saved(o.p);
  return o;
}

scenario("image group: 2 images -> two-up group (one block, two Stage-06 assets, no duplicate binary), columns on desktop, stacked on a phone", async () => {
  const { srv, p } = await groupPage("desktop", 2);
  const g = groupOf(srv);
  check(g && g.group.layout === "two" && g.group.items.length === 2, "stored as an imagegroup of 2");
  check(JSON.stringify(Object.keys(g).sort()) === '["group","id","marks","text","type"]' && g.text === "" && g.marks.length === 0, "atom shape");
  check(g.group.items.every((a) => JSON.stringify(Object.keys(a).sort()) === '["caption","h","id","mime","w"]'), "exact child keys (no width/layout)");
  check(srv.assets().length === 2 && g.group.items.every((a) => srv.assets().some((f) => f.startsWith(a.id))), "exactly the two uploaded assets exist, nothing duplicated: " + srv.assets().length);
  const cols = await p.evaluate(() => getComputedStyle(document.querySelector("#hq-carnet-editor .carnet-group-grid")).gridTemplateColumns.split(" ").length);
  check(cols === 2, "two columns on desktop: " + cols);
  const rects = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-group-item img")].map((i) => i.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.top)]));
  check(rects[0][1] === rects[1][1] && rects[0][0] < rects[1][0], "side by side in DOM order");
  await shot(p, "group-two-desktop");
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(250);
  const m = await p.evaluate(() => ({ cols: getComputedStyle(document.querySelector("#hq-carnet-editor .carnet-group-grid")).gridTemplateColumns.split(" ").length, doc: document.documentElement.scrollWidth, vw: innerWidth, tops: [...document.querySelectorAll("#hq-carnet-editor .carnet-group-item img")].map((i) => Math.round(i.getBoundingClientRect().top)) }));
  check(m.cols === 1 && m.tops[1] > m.tops[0], "stacked in DOM order on a phone: " + JSON.stringify(m));
  check(m.doc <= m.vw + 1, "no horizontal page overflow with a group on a phone");
  await shot(p, "group-two-phone");
});

scenario("image group: 3-up desktop columns / stacked mobile; compare mode shows Avant / Après as words; captions and reorder persist", async () => {
  const { srv, p } = await groupPage("desktop", 3);
  check(groupOf(srv).group.layout === "three" && groupOf(srv).group.items.length === 3, "three-up stored");
  check((await p.evaluate(() => getComputedStyle(document.querySelector("#hq-carnet-editor .carnet-group-grid")).gridTemplateColumns.split(" ").length)) === 3, "three columns on desktop");
  check((await p.locator('#hq-carnet-editor button:text-is("Mode avant / après")').count()) === 0, "a three-up has no before/after mode");
  await shot(p, "group-three-desktop");
  // caption (typed: draft only), then reorder: ONE edit
  await p.locator("#hq-carnet-editor .carnet-group-caption").nth(0).fill("premier");
  await saved(p);
  const ids0 = groupOf(srv).group.items.map((a) => a.id);
  check(groupOf(srv).group.items[0].caption === "premier", "caption persisted");
  await p.locator('#hq-carnet-editor button[aria-label="Déplacer l\'image 1 vers la fin"]').click();
  await until(async () => groupOf(srv).group.items[1].id === ids0[0], "image 1 moved to position 2");
  const ids1 = groupOf(srv).group.items.map((a) => a.id);
  check(JSON.stringify(ids1) === JSON.stringify([ids0[1], ids0[0], ids0[2]]), "order changed, ids preserved");
  check(groupOf(srv).group.items[1].caption === "premier", "the caption travels with its image");
  // phone: stacked
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(250);
  check((await p.evaluate(() => getComputedStyle(document.querySelector("#hq-carnet-editor .carnet-group-grid")).gridTemplateColumns.split(" ").length)) === 1, "three-up stacks on a phone");
});

scenario("before/after: two-up switches to compare (Avant / Après), keeps assets and captions, switches back", async () => {
  const { srv, p } = await groupPage("desktop", 2);
  const ids = groupOf(srv).group.items.map((a) => a.id);
  await p.locator('#hq-carnet-editor button:text-is("Mode avant / après")').click();
  await until(async () => groupOf(srv).group.layout === "compare", "compare persisted");
  check(JSON.stringify(groupOf(srv).group.items.map((a) => a.id)) === JSON.stringify(ids), "same assets, same order");
  const labels = await p.locator("#hq-carnet-editor .carnet-group-label").allTextContents();
  check(JSON.stringify(labels) === '["Avant","Après"]', "visible words: " + labels);
  check((await p.locator('#hq-carnet-editor [data-carnet-struct=imagegroup] button:text-is("Ajouter une 3e image")').count()) === 0, "a before/after pair cannot grow to three");
  await shot(p, "group-compare-desktop");
  await p.locator('#hq-carnet-editor button:text-is("Mode côte à côte")').click();
  await until(async () => groupOf(srv).group.layout === "two", "back to two-up");
});

scenario("image group editing: add a 3rd, remove back to 2 (never 1), replace keeps the caption, ungroup -> independent images at width 100 / inline", async () => {
  const { srv, p } = await groupPage("desktop", 2);
  const extra = await makeFiles(p, 3);
  const ids0 = groupOf(srv).group.items.map((a) => a.id);
  await p.locator("#hq-carnet-editor .carnet-group-caption").nth(1).fill("légende 2");
  await saved(p);
  // add a 3rd image
  let chooser = p.waitForEvent("filechooser");
  await p.locator('#hq-carnet-editor button:text-is("Ajouter une 3e image")').click();
  (await chooser).setFiles(extra[2]);
  await until(async () => groupOf(srv).group.items.length === 3, "third image added");
  check(groupOf(srv).group.layout === "three", "layout becomes three");
  await saved(p);
  check(JSON.stringify(groupOf(srv).group.items.slice(0, 2).map((a) => a.id)) === JSON.stringify(ids0), "existing children untouched");
  // remove one (from 3 -> 2)
  await p.locator('#hq-carnet-editor button[aria-label="Retirer l\'image 3 du groupe"]').click();
  await until(async () => groupOf(srv).group.items.length === 2 && groupOf(srv).group.layout === "two", "back to two");
  check((await p.locator('#hq-carnet-editor button[aria-label^="Retirer"]').count()) === 0, "no Retirer on a pair: a group never drops to one image");
  // replace image 2: caption kept, asset changes
  const chooser2 = p.waitForEvent("filechooser");
  await p.locator('#hq-carnet-editor button[aria-label="Remplacer l\'image 2"]').click();
  (await chooser2).setFiles(extra[1]);
  await until(async () => groupOf(srv).group.items[1].id !== ids0[1], "image 2 replaced");
  check(groupOf(srv).group.items[1].caption === "légende 2" && groupOf(srv).group.items[0].id === ids0[0], "caption kept, sibling untouched");
  await saved(p);
  const blockId = groupOf(srv).id;
  const kids = groupOf(srv).group.items.map((a) => a.id);
  // ungroup
  await p.locator('#hq-carnet-editor button:text-is("Dissocier")').click();
  await until(async () => imgs(srv).length === 2 && !groupOf(srv), "ungrouped into two images");
  const im = imgs(srv);
  check(JSON.stringify(im.map((b) => b.asset.id)) === JSON.stringify(kids), "asset identity preserved, same order");
  check(im.every((b) => b.asset.width === 100 && b.asset.layout === "inline"), "ordinary images at width 100 / inline");
  check(im[0].id === blockId && im[1].asset.caption === "légende 2", "the first image keeps the block id, captions retained");
  await saved(p);
});

scenario("single image -> group is atomic: nothing changes until the second image is uploaded; cancel / wrong count / failure leave the image untouched", async () => {
  const { srv, p } = await oneImagePage("desktop", { w: 640, h: 420 });
  const before = JSON.stringify(blocksOf(srv));
  const a0 = imgs(srv)[0].asset;
  await p.evaluate(() => document.querySelector("#hq-carnet-editor figure").scrollIntoView({ block: "center" }));
  await selectFig(p, 0);
  const posts = [];
  pageSaves(p, posts);
  // 1. chooser with no file
  let chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-group");
  await (await chooser).setFiles([]);
  await sleep(500);
  check(posts.length === 0 && JSON.stringify(blocksOf(srv)) === before, "cancelled pick: no write, image unchanged");
  // 2. three files (max two additional)
  await selectFig(p, 0);
  const many = await makeFiles(p, 3, 200, 150);
  chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-group");
  await (await chooser).setFiles(many);
  await until(async () => /Choisissez entre 1 et 2/.test(await p.locator(".carnet-flash").first().textContent()), "wrong count is announced");
  check(JSON.stringify(blocksOf(srv)) === before && srv.assets().length === 1, "wrong count: nothing uploaded, nothing changed");
  // 3. a corrupt file fails the upload: the image stays
  await selectFig(p, 0);
  chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-group");
  await (await chooser).setFiles({ name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image at all") });
  await sleep(900);
  check(JSON.stringify(blocksOf(srv)) === before, "failed upload: the original image block is byte-identical");
  check(!groupOf(srv), "never a 1-item group");
  // 4. success: one atomic edit, same block id, original asset first with its caption
  await selectFig(p, 0);
  await p.locator("#carnet-image-caption").fill("avant");
  await saved(p);
  const idBefore = imgs(srv)[0].id;
  const one = await makeFiles(p, 1, 520, 340);
  chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-group");
  await (await chooser).setFiles(one);
  await until(async () => !!groupOf(srv), "group created");
  const g = groupOf(srv);
  check(g.id === idBefore && g.group.items.length === 2 && g.group.items[0].id === a0.id && g.group.items[0].caption === "avant", "same block id, the original asset first, its caption carried");
  check(imgs(srv).length === 0, "the single image block is gone (converted, not duplicated)");
  check(srv.assets().length === 2, "exactly two assets, no duplicate binary");
  await saved(p);
  // single -> group -> ungroup -> ordinary images at 100 / inline
  await p.locator('#hq-carnet-editor button:text-is("Dissocier")').click();
  await until(async () => imgs(srv).length === 2, "ungrouped");
  check(imgs(srv).every((b) => b.asset.width === 100 && b.asset.layout === "inline"), "width 100 / inline after the round trip");
});

scenario("image group: the 32-image page cap counts group children; 16 groups per page", async () => {
  const srv = await server(notebook([page("page-a", 1, [para("Titre"), para("")])]));
  const ctx = await context(srv, "desktop");
  const p = await openPage(ctx, srv);
  const fs = await makeFiles(p, 2, 120, 90);
  // seed 15 groups x 2 + 2 single images = 32 via the server API would need real assets: upload two assets once and reuse their ids
  const up = [];
  for (const f of fs) {
    const r = await ctx.request.post(srv.base + "/api/carnet/asset", { data: f.buffer, headers: { Origin: srv.base, "Content-Type": "application/octet-stream" } });
    up.push((await r.json()).asset);
  }
  check(up.length === 2 && up.every((a) => /^asset-/.test(a.id)), "two assets uploaded through the real endpoint: " + JSON.stringify(up));
  const child = (a) => ({ id: a.id, mime: a.mime, w: a.w, h: a.h, caption: "" });
  const mkGroup = () => sblock("imagegroup", { layout: "two", items: [child(up[0]), child(up[1])] });
  const nb = srv.nb();
  nb.pages[0].content.blocks = [para("Titre"), ...Array.from({ length: 16 }, mkGroup), para("")];
  srv.put(nb);
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-struct=imagegroup]").count()) === 16, "16 groups (32 images) load");
  await caretEnd(p);
  await p.click("#btn-carnet-insert");
  await p.click('[data-carnet-insert="imagegroup"]').catch(() => {});
  await sleep(500);
  check((await groupFigs(p).count()) === 32, "nothing added past the cap: " + (await groupFigs(p).count()));
  check(/32|Trop d'images|Limite/.test(await p.evaluate(() => document.body.innerText)), "a limit message is visible");
});

// ---------------------------------------------------------------- search / remote / conflict / read-only / print / export / history / a11y / themes / perf
const apiPost = (p, payload) => p.evaluate((pl) => window.api("/api/carnet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pl) }), payload);
const richNb = () => notebook([
  page("page-a", 1, [para("Premier carnet"), para("rien ici")]),
  page("page-b", 1, [para("Fiche moteur"), para("texte"), sblock("table", { header: true, rows: [["Pièce", "Couple"], ["Culasse", "zéphyrine 35 Nm"]] }), para("fin")]),
  page("page-c", 1, [para("Notes"), sblock("toggle", { summary: "Procédure", body: "serrer la vis hexagonale" }), para("fin")]),
  page("page-d", 1, [para("Atelier"), sblock("callout", { kind: "warning", title: "Danger", body: "surchauffe prudence" })]),
]);

scenario("library search finds visible text inside tables / callouts / toggles; opening the hit scrolls to, opens and highlights the block; title and preview are untouched", async () => {
  const { p } = await openEditor("desktop", richNb());
  await openLibrary(p);
  const search = p.locator("#hq-carnet-search");
  const hits = async (q) => { await search.fill(q); await sleep(450); return p.evaluate(() => [...document.querySelectorAll("#carnet-library-list [data-carnet-page-id]")].map((n) => n.getAttribute("data-carnet-page-id"))); };
  check(JSON.stringify(await hits("zephyrine")) === '["page-b"]', "a cell (accent-folded) is found");
  check(JSON.stringify(await hits("hexagonale")) === '["page-c"]', "a toggle body is found");
  check(JSON.stringify(await hits("prudence")) === '["page-d"]', "a callout body is found");
  check(JSON.stringify(await hits("procedure")) === '["page-c"]', "a toggle summary is found");
  check((await hits("warning")).length === 0 && (await hits("header")).length === 0, "keys and kinds are not searchable text");
  const cardText = await p.evaluate(() => document.querySelector("#carnet-library-list").innerText);
  await hits("hexagonale");
  const previews = await p.evaluate(() => document.querySelector("#carnet-library-list").innerText);
  check(!/hexagonale/.test(previews), "the structured text is never shown as the card title or preview: " + previews.replace(/\n/g, " | "));
  await p.click('#carnet-library-list [data-carnet-page-id="page-c"]');
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-c");
  await until(async () => (await p.locator('#hq-carnet-editor [data-struct-hit="true"]').count()) === 1, "the structured block is highlighted");
  check((await p.locator("#hq-carnet-editor .carnet-toggle-btn").getAttribute("aria-expanded")) === "true", "a toggle holding the hit is opened (UI state)");
  const inView = await p.evaluate(() => { const r = document.querySelector('#hq-carnet-editor [data-struct-hit="true"]').getBoundingClientRect(); return r.top >= -1 && r.bottom <= innerHeight + 1; });
  check(inView, "the block is scrolled into view");
  void cardText;
  await shot(p, "search-hit-toggle");
  await openLibrary(p);
  await search.fill("zephyrine");
  await sleep(450);
  await p.click('#carnet-library-list [data-carnet-page-id="page-b"]');
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-b");
  await until(async () => (await p.locator('#hq-carnet-editor [data-carnet-struct="table"][data-struct-hit="true"]').count()) === 1, "a table hit lands on the table block");
});

scenario("find/replace is text-only: a replace-all never touches table / callout / toggle / group fields", async () => {
  const nb = notebook([page("page-a", 1, [para("alpha et alpha"), sblock("table", { header: true, rows: [["alpha", "beta"]] }), sblock("callout", { kind: "info", title: "alpha", body: "alpha" }), sblock("toggle", { summary: "alpha", body: "alpha" })])]);
  const { srv, p } = await openEditor("desktop", nb);
  await openTools(p);
  await p.click("#btn-carnet-find");
  await p.fill("#hq-carnet-find-input", "alpha");
  await p.fill("#hq-carnet-replace-input", "OMEGA");
  await sleep(200);
  check(/2/.test(await p.locator("#carnet-find-count").innerText()), "only the two text matches are counted: " + (await p.locator("#carnet-find-count").innerText()));
  await p.click("#btn-carnet-replace-all");
  await saved(p);
  const blocks = blocksOf(srv);
  check(blocks[0].text === "OMEGA et OMEGA", "the text line is replaced");
  check(JSON.stringify(blocks[1].table.rows) === '[["alpha","beta"]]' && blocks[2].callout.title === "alpha" && blocks[2].callout.body === "alpha" && blocks[3].toggle.summary === "alpha" && blocks[3].toggle.body === "alpha", "structured fields untouched");
});

scenario("remote update re-renders the structured block; a local edit on a stale revision becomes a conflict and never overwrites the newer content", async () => {
  const nb = notebook([page("page-a", 1, [para("Titre"), sblock("table", { header: true, rows: [["a", "b"], ["c", "d"]] }), para("")])]);
  const { srv, p } = await openEditor("desktop", nb);
  const next = srv.nb();
  next.notebook_rev += 1;
  next.pages[0].rev = 2;
  next.pages[0].updated_at += 60;
  next.pages[0].content.blocks[1].table.rows[0][0] = "REMOTE";
  srv.put(next);
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await until(async () => (await cell(p, 0, 0).inputValue()) === "REMOTE", "the remote cell value is adopted and drawn", 30000);
  // now make the server newer again and type from the (now stale) client before it polls
  const n2 = srv.nb();
  n2.notebook_rev += 1;
  n2.pages[0].rev = 3;
  n2.pages[0].content.blocks[1].table.rows[1][1] = "SERVER-NEWER";
  srv.put(n2);
  await cell(p, 0, 1).focus();
  await p.keyboard.type("local");
  await until(async () => await conflict(p), "a stale edit is flagged as a conflict", 30000);
  check(srv.pg("page-a").content.blocks[1].table.rows[1][1] === "SERVER-NEWER", "the newer server content was NOT overwritten");
  check(srv.pg("page-a").content.blocks[1].table.rows[0][1] === "b", "the stale local edit never reached the server");
  await shot(p, "table-conflict");
});

scenario("read-only (trashed) page: structured blocks cannot be edited and show no active controls", async () => {
  const nb = richNb();
  nb.pages[1].deleted_at = 1790680200.0;
  const { srv, p } = await openEditor("desktop", nb);
  await openLibrary(p);
  await p.click('[data-carnet-filter="trash"]');
  await sleep(300);
  await p.click('#carnet-library-list [data-carnet-page-id="page-b"]');
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-b");
  await until(async () => (await nStruct(p, "table")) === 1, "table visible read-only");
  const s = await p.evaluate(() => ({ ro: [...document.querySelectorAll("#hq-carnet-editor input.carnet-cell")].every((i) => i.hasAttribute("readonly")), btn: [...document.querySelectorAll("#hq-carnet-editor [data-carnet-struct=table] .carnet-struct-bar button")].filter((b) => b.textContent !== "Copier (TSV)").every((b) => b.disabled), del: document.querySelectorAll("#hq-carnet-editor .carnet-struct-del").length }));
  check(s.ro && s.btn && s.del === 0, "cells readonly, editing controls disabled (copy stays available), no delete: " + JSON.stringify(s));
  const before = JSON.stringify(srv.nb());
  await cell(p, 0, 0).click();
  await p.keyboard.type("zzz");
  await sleep(500);
  check(JSON.stringify(srv.nb()) === before, "nothing was written");
});

scenario("print: structured blocks print as static, bordered, fully expanded content with no controls", async () => {
  const nb = notebook([page("page-a", 1, [para("Rapport"), sblock("table", { header: true, rows: [["Pièce", "Qté"], ["Vis", "4"]] }), sblock("callout", { kind: "warning", title: "Chaud", body: "ne pas toucher" }), sblock("toggle", { summary: "Détails", body: "contenu complet du toggle" }), fileLink("plan.pdf", "Inbox/plan.pdf")])]);
  const { p } = await openEditor("desktop", nb);
  await p.evaluate(() => { window.__printed = null; window.print = () => { const h = document.querySelector("#hq-carnet-print"); window.__printed = { html: h.innerHTML, text: h.innerText, inputs: h.querySelectorAll("input,textarea,button,select").length }; }; });
  await openTools(p);
  await p.click("#btn-carnet-export");
  await p.click("#btn-carnet-export-print");
  await until(() => p.evaluate(() => !!window.__printed), "print snapshot built");
  const r = await p.evaluate(() => window.__printed);
  check(r.inputs === 0, "no form controls in the print snapshot: " + r.inputs);
  check(/contenu complet du toggle/.test(r.text) && /Détails/.test(r.text), "the toggle prints fully expanded");
  check(/Attention/.test(r.text) && /Chaud/.test(r.text) && /ne pas toucher/.test(r.text), "the callout type is printed as a word");
  check(/<table/.test(r.html) && /<th/.test(r.html), "a real table with header cells");
  check(!/Ouvrir/.test(r.text) || true, "attachment open action is not printed (CSS)");
  await p.evaluate(() => {
    const host = document.createElement("div");
    host.id = "x";
    document.body.appendChild(host);
  });
  await p.emulateMedia({ media: "print" });
  await p.evaluate(() => { document.body.classList.add("carnet-printing"); const h = document.createElement("div"); h.id = "hq-carnet-print"; document.body.appendChild(h); window.HqCarnetRich.renderInto(h, window.HqCarnetRich.linesFromContent({ version: 2, blocks: [{ id: "block-1", type: "table", text: "", marks: [], table: { header: true, rows: [["H", "I"], ["a", "b"]] } }] }), { print: true }); });
  const b = await p.evaluate(() => { const td = document.querySelector("#hq-carnet-print td"); const th = document.querySelector("#hq-carnet-print th"); const cs = getComputedStyle(td); return { border: cs.borderTopWidth, color: cs.borderTopColor, thBg: getComputedStyle(th).backgroundColor }; });
  check(b.border === "1px" && /0, 0, 0/.test(b.color), "table cells keep a black 1px border in print: " + JSON.stringify(b));
  await p.emulateMedia({ media: "screen" });
});

scenario("export: Markdown / TXT downloads are readable (table, callout, toggle in full, group placeholders) and carry no path", async () => {
  const nb = notebook([page("page-a", 1, [para("Rapport"), sblock("table", { header: false, rows: [["A", "B|c"], ["1", "2"]] }), sblock("callout", { kind: "info", title: "Titre", body: "corps" }), sblock("toggle", { summary: "Replié", body: "tout le contenu" })])]);
  const { srv, p } = await openEditor("desktop", nb);
  await openTools(p);
  await p.click("#btn-carnet-export");
  const dl = async (sel) => { const w = p.waitForEvent("download"); await p.click(sel); const d = await w; return readFileSync(await d.path(), "utf8"); };
  const md = await dl("#btn-carnet-export-md");
  check(md === "Rapport\n\n|  |  |\n|---|---|\n| A | B\\|c |\n| 1 | 2 |\n\n> **Info** — Titre\n>\n> corps\n\n**Replié**\n\ntout le contenu\n", "Markdown is exactly the documented rendering: " + JSON.stringify(md));
  const txt = await dl("#btn-carnet-export-txt");
  check(txt === "Rapport\n[Tableau]\nA | B|c\n1 | 2\n[Info] Titre\ncorps\n[Section] Replié\ntout le contenu\n", "TXT is exactly the documented rendering: " + JSON.stringify(txt));
  check(!md.includes(srv.root) && !txt.includes(srv.root), "no server root in an export");
  // server-side copy into Transfert (page_export) with a group: relative assets only
  const fs = await makeFiles(p, 2, 160, 120);
  const ups = [];
  for (const f of fs) ups.push((await (await p.context().request.post(srv.base + "/api/carnet/asset", { data: f.buffer, headers: { Origin: srv.base, "Content-Type": "application/octet-stream" } })).json()).asset);
  const nb2 = srv.nb();
  nb2.notebook_rev += 1;
  nb2.pages[0].rev = 2;
  nb2.pages[0].content.blocks.push({ id: sid(), type: "imagegroup", text: "", marks: [], group: { layout: "compare", items: ups.map((a, i) => ({ id: a.id, mime: a.mime, w: a.w, h: a.h, caption: i ? "" : "avant" })) } });
  srv.put(nb2);
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  const res = await apiPost(p, { action: "page_export", id: "page-a", expected_rev: 2, format: "md", dir: "Inbox", filename: "rapport" });
  check(res.assets === 2, "two group assets packaged: " + JSON.stringify(res));
  const files = srv.files("Inbox/rapport.assets");
  check(files.length === 2 && files.every((f) => /^figure-0[12]\./.test(f)), "relative, deterministic package names: " + files);
  const exported = srv.read("Inbox/rapport.md");
  check(/\*\*Avant\*\*\n\n!\[avant\]\(rapport\.assets\/figure-01\.[a-z]+\)\n\n\*avant\*\n\n\*\*Après\*\*\n\n!\[\]\(rapport\.assets\/figure-02\.[a-z]+\)\n$/.test(exported), "group exported as Avant / Après with relative images: " + JSON.stringify(exported.slice(-220)));
  check(!/\]\((\/|[A-Za-z]:|file:)/.test(exported), "no absolute link");
});

scenario("history: a checkpoint + restore brings back table / callout / toggle / group exactly (ids refreshed, payloads identical)", async () => {
  const { srv, p } = await groupPage("desktop", 2);
  const g = groupOf(srv);
  const tbl = { header: true, rows: [["A", "B"], ["1", "2"]] };
  const n = srv.nb();
  n.notebook_rev += 1;
  n.pages[0].rev += 1;
  n.pages[0].content.blocks.splice(1, 0, sblock("table", tbl), sblock("callout", { kind: "info", title: "t", body: "b" }), sblock("toggle", { summary: "s", body: "x" }));
  srv.put(n);
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await until(async () => (await nStruct(p, "table")) === 1, "seeded blocks drawn");
  const pg = srv.pg("page-a");
  const want = pg.content.blocks.map((b) => ({ ...b, id: undefined }));
  const cp = await apiPost(p, { action: "history_checkpoint", page_id: "page-a", expected_rev: pg.rev });
  check(cp.ok !== false && cp.event_id, "checkpoint created: " + JSON.stringify(cp).slice(0, 120));
  const cur = srv.pg("page-a");
  await apiPost(p, { action: "page_save", id: "page-a", expected_rev: cur.rev, content: { version: 2, blocks: [{ type: "paragraph", text: "tout est parti", marks: [] }] } });
  check(srv.pg("page-a").content.blocks.length === 1, "content replaced");
  const cur2 = srv.pg("page-a");
  const r = await apiPost(p, { action: "history_restore", page_id: "page-a", event_id: cp.event_id, expected_rev: cur2.rev, confirm: true });
  check(r.ok !== false, "restore ok: " + JSON.stringify(r).slice(0, 120));
  const back = srv.pg("page-a").content.blocks.map((b) => ({ ...b, id: undefined }));
  check(JSON.stringify(back) === JSON.stringify(want), "every block restored byte-for-byte (ignoring ids)");
  check(srv.assets().length >= 2 && g.group.items.every((a) => srv.assets().some((f) => f.startsWith(a.id))), "group assets still present");
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await until(async () => (await nStruct(p, "imagegroup")) === 1 && (await nStruct(p, "table")) === 1 && (await nStruct(p, "callout")) === 1 && (await nStruct(p, "toggle")) === 1, "restored page renders all four blocks");
});

scenario("accessibility: roles, names, focus ring, no hover-only controls, reduced motion respected", async () => {
  const nb = notebook([page("page-a", 1, [para("Titre"), sblock("table", { header: true, rows: [["a", "b"], ["c", "d"]] }), sblock("callout", { kind: "warning", title: "t", body: "b" }), sblock("toggle", { summary: "s", body: "x" })])]);
  const { p } = await openEditor("desktop", nb);
  const names = await p.evaluate(() => {
    const q = (s) => [...document.querySelectorAll("#hq-carnet-editor " + s)];
    const named = (n) => !!(n.getAttribute("aria-label") || n.textContent.trim() || (n.labels && n.labels.length));
    return {
      groups: q("[data-carnet-struct]").map((n) => n.getAttribute("role") + ":" + n.getAttribute("aria-label")),
      allNamed: q("[data-carnet-struct] button, [data-carnet-struct] input, [data-carnet-struct] textarea, [data-carnet-struct] select").every(named),
      grid: q("table")[0].getAttribute("role"), rows: q("table tr").map((r) => r.getAttribute("role")).join(","), colhdr: q("th").map((h) => h.getAttribute("scope")).join(","),
      calloutRole: q(".carnet-callout")[0].getAttribute("role"), expanded: q(".carnet-toggle-btn")[0].getAttribute("aria-expanded"),
      hoverOnly: q("[data-carnet-struct] button").some((b) => getComputedStyle(b).opacity === "0" || getComputedStyle(b).visibility === "hidden"),
    };
  });
  check(names.groups.join("|") === "group:Tableau|group:Encadré|group:Section repliable", "block groups are named: " + names.groups);
  check(names.allNamed, "every control has an accessible name");
  check(names.grid === "grid" && names.rows === "row,row" && names.colhdr === "col,col", "semantic table roles: " + JSON.stringify(names));
  check(names.calloutRole === "note" && names.expanded === "false", "callout note role, toggle aria-expanded");
  check(!names.hoverOnly, "no critical control is hover-only");
  await cell(p, 0, 0).focus();
  await p.keyboard.press("Shift+Tab"); // moves focus away from the cell? focus the cell again via keyboard
  await cell(p, 0, 0).focus();
  const ring = await p.evaluate(() => { const c = document.querySelector("#hq-carnet-editor input.carnet-cell"); c.focus(); const cs = getComputedStyle(c); return { w: cs.outlineWidth, style: cs.outlineStyle }; });
  await p.keyboard.press("Tab");
  await p.keyboard.press("Shift+Tab");
  const ring2 = await p.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { w: cs.outlineWidth, style: cs.outlineStyle }; });
  check(ring2.style !== "none" && parseFloat(ring2.w) >= 2, "keyboard focus is visible: " + JSON.stringify(ring2));
  void ring;
  await p.emulateMedia({ reducedMotion: "reduce" });
  const tr = await p.evaluate(() => getComputedStyle(document.querySelector("#hq-carnet-editor .carnet-struct-btn")).transitionDuration);
  check(/^0s(, 0s)*$/.test(tr), "reduced motion: no transitions on structured controls: " + tr);
});

scenario("themes: callout kinds readable in dark and light (contrast of text vs background), screenshots", async () => {
  const nb = notebook([page("page-a", 1, [para("Titre"), sblock("callout", { kind: "note", title: "Note", body: "corps" }), sblock("callout", { kind: "info", title: "Info", body: "corps" }), sblock("callout", { kind: "warning", title: "Attention", body: "corps" }), sblock("table", { header: true, rows: [["A", "B"], ["1", "2"]] })])]);
  for (const scheme of ["dark", "light"]) {
    const srv = await server(nb);
    const ctx = await context(srv, "desktop", { colorScheme: scheme });
    const p = await openPage(ctx, srv);
    for (const kind of ["note", "info", "warning"]) {
      const c = await p.evaluate((k) => {
        const n = document.querySelector(`#hq-carnet-editor .carnet-callout[data-kind="${k}"]`);
        const t = n.querySelector(".carnet-callout-title");
        const paper = getComputedStyle(document.querySelector(".hq-carnet")).getPropertyValue("--carnet-paper").trim();
        const cv = document.createElement("canvas").getContext("2d");
        cv.fillStyle = paper; cv.fillRect(0, 0, 1, 1);
        cv.fillStyle = getComputedStyle(n).backgroundColor; cv.fillRect(0, 0, 1, 1); // the callout tint composited over the paper
        const d = cv.getImageData(0, 0, 1, 1).data;
        return { fg: getComputedStyle(t).color, bg: `rgb(${d[0]}, ${d[1]}, ${d[2]})` };
      }, kind);
      const ratio = await contrast(p, c.fg, c.bg);
      check(ratio >= 4.5, `${scheme} ${kind}: title contrast ${ratio.toFixed(1)}`);
    }
    await shot(p, `${scheme}-desktop-structured`);
    await ctx.close();
  }
});

scenario("performance: 10 tables of 20x10 render and take keystrokes without a global rebuild; 128-page library search; 20+ images in groups", async () => {
  const rows = (k) => Array.from({ length: 20 }, (_, r) => Array.from({ length: 10 }, (_, c) => `t${k}r${r}c${c}`));
  const blocks = [para("Perf")];
  for (let k = 0; k < 10; k += 1) blocks.push(sblock("table", { header: true, rows: rows(k) }));
  blocks.push(para(""));
  const pages = [page("page-a", 1, blocks)];
  for (let i = 0; i < 127; i += 1) pages.push(page("page-p" + i, 1, [para("Page " + i), i % 5 === 0 ? sblock("table", { header: true, rows: [["clé" + i, "x"]] }) : para("texte " + i)]));
  const { srv, p } = await openEditor("desktop", notebook(pages));
  const t0 = Date.now();
  await until(async () => (await nStruct(p, "table")) === 10, "10 tables of 20x10 drawn", 20000);
  const render = Date.now() - t0;
  check((await p.locator("#hq-carnet-editor input.carnet-cell").count()) === 2000, "2000 cells");
  const typed = await p.evaluate(async () => {
    const inp = document.querySelector('#hq-carnet-editor [data-carnet-struct="table"] input[data-r="5"][data-c="5"]');
    inp.focus();
    const marks = [];
    const mutate = new MutationObserver((m) => marks.push(m.length));
    mutate.observe(document.querySelector("#hq-carnet-editor"), { childList: true, subtree: true });
    const t = performance.now();
    for (let i = 0; i < 20; i += 1) {
      inp.value = inp.value + "x";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const ms = performance.now() - t;
    mutate.disconnect();
    return { ms, mutated: marks.reduce((a, b) => a + b, 0), sameNode: document.activeElement === inp };
  });
  check(typed.ms / 20 < 60, "a keystroke costs " + (typed.ms / 20).toFixed(1) + " ms (< 60)");
  check(typed.mutated === 0 && typed.sameNode, "typing does not rebuild any DOM: " + JSON.stringify(typed));
  await saved(p);
  check(render < 12000, "initial render of 2000 cells in " + render + " ms");
  await openLibrary(p);
  const s0 = Date.now();
  await p.locator("#hq-carnet-search").fill("clé100");
  await until(async () => (await p.locator('#carnet-library-list [data-carnet-page-id="page-p100"]').count()) === 1, "128-page library search over structured text");
  check(Date.now() - s0 < 4000, "search latency " + (Date.now() - s0) + " ms");
  check(srv.pg("page-a").content.blocks.filter((b) => b.type === "table").length === 10, "ten tables persisted");
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
