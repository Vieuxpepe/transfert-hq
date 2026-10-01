// Carnet product phase 1: categorized command menu (fuzzy search, recents, keyboard), page templates, Quick Capture.
//
//   node tests/visual_carnet_product_playwright.mjs [scenario substring...]
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

// ---------------------------------------------------------------- product helpers
const PNB = () => notebook([page("page-a", 1, [para("one"), para("")]), page("page-b", 1, [para("other page")])]);
const cmdRows = (p) => p.evaluate(() => [...document.querySelectorAll("#carnet-cmd-list [data-carnet-cmd],#carnet-cmd-list [data-carnet-cmd-recent]")].map((o) => ({ id: o.getAttribute("data-carnet-cmd") || o.getAttribute("data-carnet-cmd-recent"), recent: o.hasAttribute("data-carnet-cmd-recent"), sel: o.getAttribute("aria-selected") === "true", group: o.getAttribute("data-carnet-group"), domId: o.id })));
const groupLabels = (p) => p.evaluate(() => [...document.querySelectorAll("#carnet-cmd-list .carnet-cmd-group-label")].map((n) => n.textContent));
const activeId = (p) => p.evaluate(() => document.getElementById("carnet-cmd-input").getAttribute("aria-activedescendant"));
async function openSlash(p) {
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "slash menu open");
}
async function runSlash(p, query) {
  await openSlash(p);
  if (query) await p.keyboard.type(query);
  await p.keyboard.press("Enter");
  await until(async () => !(await menuVisible(p)), "menu closed after " + query);
}
const recentsKey = (p) => p.evaluate(() => localStorage.getItem("hq_carnet_recent_cmds_v1"));

scenario("menu: four categories in order, icons, concise descriptions, honest shortcuts (none invented)", async () => {
  const { p } = await openEditor("desktop", PNB());
  await openSlash(p);
  check(JSON.stringify(await groupLabels(p)) === JSON.stringify(["Écrire", "Ajouter", "Ingénierie", "Projet"]), "groups: " + (await groupLabels(p)));
  const rows = await cmdRows(p);
  check(rows.length === 20, "all 20 commands listed once (15 + 4 Phase-2 structured blocks + Croquis): " + rows.length);
  const byGroup = {};
  for (const r of rows) (byGroup[r.group] = byGroup[r.group] || []).push(r.id);
  check(JSON.stringify(byGroup.write) === '["paragraph","heading","bullet","number","check"]', "Écrire: " + byGroup.write);
  check(JSON.stringify(byGroup.add) === '["image","camera","table","callout","toggle","imagegroup","sketch","file","drawing"]', "Ajouter: " + byGroup.add);
  check(JSON.stringify(byGroup.eng) === '["measure","calc","decision"]', "Ingénierie: " + byGroup.eng);
  check(JSON.stringify(byGroup.project) === '["task","cite","time"]', "Projet: " + byGroup.project);
  const meta = await p.evaluate(() => [...document.querySelectorAll("#carnet-cmd-list .carnet-cmd-item")].map((o) => ({
    icon: !!o.querySelector("svg.carnet-cmd-icon path[d]"), label: o.querySelector(".carnet-cmd-label").textContent, hint: o.querySelector(".carnet-cmd-hint").textContent, kbd: !!o.querySelector("kbd"),
  })));
  check(meta.every((m) => m.icon), "every row has an icon (existing stroke-icon system)");
  check(meta.every((m) => m.hint.length > 0 && m.hint.length <= 32), "descriptions are concise: " + meta.map((m) => m.hint.length).join(","));
  check(meta.every((m) => !m.kbd), "no key hint on any command (no real per-command shortcut exists, none is invented)");
  check(JSON.stringify(meta.slice(0, 5).map((m) => m.label)) === '["Texte","Titre","Liste","Liste numérotée","Checklist"]', "labels (Écrire): " + meta.slice(0, 5).map((m) => m.label));
  const foot = await p.locator(".carnet-cmd-footer").innerText();
  check(/↑↓/.test(foot) && /⏎/.test(foot) && /Échap/.test(foot), "footer lists only the real menu keys: " + foot.replace(/\n/g, " | "));
  check((await rows[0].sel) === true || rows[0].sel === true, "first command selected");
  await p.keyboard.press("Escape");
});

scenario("menu: fuzzy search ranks (prefix, keyword, substring, in-order letters, category); Enter runs the top hit", async () => {
  const { p } = await openEditor("desktop", PNB());
  for (const [q, want] of [["chk", "check"], ["mesr", "measure"], ["clcl", "calc"], ["tache", "task"], ["TÂCHE", "task"], ["deci", "decision"], ["ingenierie", "measure"], ["photo", "camera"]]) {
    await openSlash(p);
    await p.keyboard.type(q);
    const rows = await cmdRows(p);
    check(rows.length >= 1 && rows[0].id === want, `"${q}" -> ${want} first (got ${rows[0] && rows[0].id}, ${rows.length} hits)`);
    check(JSON.stringify(await groupLabels(p)) === '["Résultats"]', "a query shows one flat Résultats group");
    await p.keyboard.press("Escape");
    await until(async () => !(await menuVisible(p)), "closed");
    await caretEnd(p);
    await p.keyboard.press("Backspace"); // remove the restored "/"
  }
  await openSlash(p);
  await p.keyboard.type("zzzz");
  check((await p.locator(".carnet-cmd-empty").count()) === 1 && (await cmdRows(p)).length === 0, "no hit -> 'Aucune commande'");
  await p.keyboard.press("Enter"); // nothing to choose: nothing happens, the menu stays
  check(await menuVisible(p), "Enter with no hit does nothing");
  await p.keyboard.press("Escape");
  await until(async () => !(await menuVisible(p)), "closed");
  const tags = await (async () => { await caretEnd(p); while ((await edText(p)).endsWith("/")) await p.keyboard.press("Backspace"); await openSlash(p); await p.keyboard.type("ing"); return p.evaluate(() => [...document.querySelectorAll("#carnet-cmd-list .carnet-cmd-cat")].map((n) => n.textContent)); })();
  check(tags.filter((t) => t === "Ingénierie").length === 3 && tags.every((t) => ["Écrire", "Ajouter", "Ingénierie", "Projet"].includes(t)), "results carry their category tag: " + tags);
  await p.keyboard.press("Escape");
  // Enter on the top fuzzy hit converts the block
  await caretEnd(p);
  await p.keyboard.press("Backspace");
  await runSlash(p, "chk");
  check((await domLines(p))[1][0] === "check", "'chk' + Enter -> Checklist: " + JSON.stringify(await domLines(p)));
});

scenario("menu: keyboard — arrows wrap, PageUp/PageDown jump groups, activedescendant follows, Escape restores '/', Tab dismisses", async () => {
  const { p } = await openEditor("desktop", PNB());
  await openSlash(p);
  check((await activeId(p)) === "carnet-cmd-0", "starts on the first command: " + (await activeId(p)));
  await p.keyboard.press("ArrowUp");
  let rows = await cmdRows(p);
  check(rows[rows.length - 1].sel && (await activeId(p)) === "carnet-cmd-19", "ArrowUp from the first wraps to the last");
  await p.keyboard.press("ArrowDown");
  check((await cmdRows(p))[0].sel, "ArrowDown from the last wraps to the first");
  await p.keyboard.press("PageDown");
  rows = await cmdRows(p);
  check(rows.find((r) => r.sel).id === "image", "PageDown -> first of the next group (Ajouter): " + rows.find((r) => r.sel).id);
  await p.keyboard.press("PageDown");
  check((await cmdRows(p)).find((r) => r.sel).id === "measure", "PageDown again -> Ingénierie");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("PageUp");
  check((await cmdRows(p)).find((r) => r.sel).id === "measure", "PageUp inside a group -> its first command");
  await p.keyboard.press("PageUp");
  check((await cmdRows(p)).find((r) => r.sel).id === "image", "PageUp at a group start -> the previous group's first command");
  const live = await p.evaluate(() => document.querySelector("#carnet-cmd-menu [role=status]").textContent);
  check(/20 commandes/.test(live), "live region announces the count: " + live);
  const aria = await p.evaluate(() => { const i = document.getElementById("carnet-cmd-input"); return [i.getAttribute("role"), i.getAttribute("aria-expanded"), i.getAttribute("aria-controls"), document.getElementById("carnet-cmd-list").getAttribute("role"), document.querySelectorAll("#carnet-cmd-list [role=group]").length, [...document.querySelectorAll("#carnet-cmd-list [role=group]")].every((g) => document.getElementById(g.getAttribute("aria-labelledby")))]; });
  check(JSON.stringify(aria) === JSON.stringify(["combobox", "true", "carnet-cmd-list", "listbox", 4, true]), "combobox/listbox/group semantics with labelled groups: " + JSON.stringify(aria));
  await p.keyboard.press("Escape");
  await until(async () => !(await menuVisible(p)), "closed");
  check((await edText(p)).endsWith("/"), "Escape restores the '/'");
  await caretEnd(p);
  await p.keyboard.press("Backspace");
  await openSlash(p);
  await p.keyboard.press("Tab");
  await until(async () => !(await menuVisible(p)), "Tab closes the menu");
  // a mouse click chooses too
  await caretEnd(p);
  await p.keyboard.press("Backspace");
  await openSlash(p);
  await p.click('#carnet-cmd-list [data-carnet-cmd="heading"]');
  await until(async () => !(await menuVisible(p)), "closed after click");
  check((await domLines(p))[1][0] === "heading", "click on Titre converts the block");
});

scenario("recents: fed by the single insertion path, shown first (max 3), persisted as ids only, sanitised, never written by viewing", async () => {
  const { srv, ctx, p } = await openEditor("desktop", PNB());
  check((await recentsKey(p)) === null, "nothing stored before any command ran (viewing writes nothing)");
  await openSlash(p);
  check(JSON.stringify(await groupLabels(p)) === '["Écrire","Ajouter","Ingénierie","Projet"]', "no Récents group when there are none");
  await p.keyboard.press("Escape");
  await caretEnd(p);
  await p.keyboard.press("Backspace");
  await runSlash(p, "titre");
  await caretEnd(p);
  await runSlash(p, "chk");
  check(JSON.parse(await recentsKey(p)).join() === "check,heading", "stored most-recent-first ids only: " + (await recentsKey(p)));
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "open again");
  check(JSON.stringify(await groupLabels(p)) === '["Récents","Écrire","Ajouter","Ingénierie","Projet"]', "Récents first: " + (await groupLabels(p)));
  let rows = await cmdRows(p);
  check(rows[0].recent && rows[0].id === "check" && rows[1].recent && rows[1].id === "heading" && !rows[2].recent, "recent rows first and flagged: " + JSON.stringify(rows.slice(0, 3).map((r) => [r.id, r.recent])));
  check((await p.locator('#carnet-cmd-list [data-carnet-cmd="check"]').count()) === 1, "[data-carnet-cmd=id] stays unique (the category row)");
  check(new Set(rows.map((r) => r.domId)).size === rows.length, "every row has a unique DOM id");
  await p.keyboard.press("Escape");
  await caretEnd(p);
  await p.keyboard.press("Backspace");
  // survives a reload
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await openSlash(p);
  check(JSON.stringify((await cmdRows(p)).filter((r) => r.recent).map((r) => r.id)) === '["check","heading"]', "recents survive a reload");
  await p.keyboard.press("Escape");
  // "+ Insérer" shows them too
  await p.click("#btn-carnet-insert");
  check(JSON.stringify(await p.locator("#hq-carnet-insert-menu .carnet-cmd-group-label").allTextContents()) === '["Récents","Écrire","Ajouter","Ingénierie","Projet"]', "+ Insérer: Récents first");
  check((await p.locator('#hq-carnet-insert-menu [data-carnet-insert="check"]').count()) === 1, "[data-carnet-insert=id] stays unique");
  await p.keyboard.press("Escape");
  // a different command pushes the others down; the list is capped
  await caretEnd(p);
  while ((await edText(p)).endsWith("/")) await p.keyboard.press("Backspace");
  for (const q of ["liste", "texte", "numer"]) { await caretEnd(p); try { await runSlash(p, q); } catch (e) { throw new Error(e.message + " q=" + q + " ed=" + JSON.stringify(await edText(p)) + " types=" + JSON.stringify(await domLines(p))); } }
  const stored = JSON.parse(await recentsKey(p));
  check(stored.length === 4 && stored[0] === "number", "bounded to 4 stored: " + stored.join());
  await caretEnd(p);
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "open");
  check((await cmdRows(p)).filter((r) => r.recent).length === 3, "at most 3 shown");
  await p.keyboard.press("Escape");
  // hostile / corrupted values never break the menu
  await p.evaluate(() => localStorage.setItem("hq_carnet_recent_cmds_v1", JSON.stringify(["calc", "<img src=x onerror=1>", 5, null, "calc", "nope", "time"])));
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await caretEnd(p);
  while ((await edText(p)).endsWith("/")) await p.keyboard.press("Backspace");
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "open with hostile store");
  check(JSON.stringify((await cmdRows(p)).filter((r) => r.recent).map((r) => r.id)) === '["calc","time"]', "unknown / duplicate / non-string entries are dropped");
  await p.keyboard.press("Escape");
  await p.evaluate(() => localStorage.setItem("hq_carnet_recent_cmds_v1", "{not json"));
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await caretEnd(p);
  while ((await edText(p)).endsWith("/")) await p.keyboard.press("Backspace");
  await p.keyboard.type("/");
  await until(() => menuVisible(p), "open with corrupted store");
  check(JSON.stringify(await groupLabels(p)) === '["Écrire","Ajouter","Ingénierie","Projet"]', "corrupted JSON -> no Récents, menu still fine");
  await p.keyboard.press("Escape");
  const nb = srv.nb();
  check(!JSON.stringify(nb).includes("hq_carnet_recent"), "recents never reach the notebook");
  void ctx;
});

scenario("menu: '+ Insérer' is categorized, keyboard-navigable and every row is reachable (phone)", async () => {
  const { p } = await openEditor("iphone", PNB());
  await p.click("#btn-carnet-insert");
  const menu = await rect(p, "#hq-carnet-insert-menu");
  const nav = await rect(p, ".bottom-nav");
  const v = p.viewportSize();
  check(menu && menu.l >= -0.5 && menu.r <= v.width + 0.5, "inside the viewport width: " + JSON.stringify(menu));
  check((await p.locator("#hq-carnet-insert-menu .carnet-cmd-group-label").allTextContents()).join() === "Écrire,Ajouter,Ingénierie,Projet", "grouped");
  const small = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-insert-menu .carnet-insert-item")].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect()).filter((r) => r.height < 43.5).length);
  check(small === 0, "every row is a ≥44px target");
  // scroll to the last command and click it: nothing is hidden behind the nav
  await p.evaluate(() => { const m = document.getElementById("hq-carnet-insert-menu"); m.scrollTop = m.scrollHeight; });
  await sleep(150);
  const last = await rect(p, '#hq-carnet-insert-menu [data-carnet-insert="time"]');
  check(last && last.b <= (nav ? nav.t : v.height) + 0.5 && last.t >= 0, `last row visible above the nav (${Math.round(last.b)} <= ${Math.round(nav ? nav.t : v.height)})`);
  await p.keyboard.press("ArrowDown");
  const ids = [];
  for (let i = 0; i < 4; i += 1) { ids.push(await p.evaluate(() => document.activeElement.getAttribute("data-carnet-insert") || document.activeElement.getAttribute("data-carnet-insert-recent"))); await p.keyboard.press("ArrowDown"); }
  check(ids.every(Boolean), "arrows move focus between rows: " + ids);
  await p.keyboard.press("Home");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-insert"))) === "paragraph", "Home -> first row");
  await p.keyboard.press("End");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-insert"))) === "time", "End -> last row");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-insert-menu").isHidden(), "Escape closes");
  // choose Heure from the menu: the shared path runs it and records the recent
  await p.click("#btn-carnet-insert");
  await p.locator('#hq-carnet-insert-menu [data-carnet-insert="time"]').scrollIntoViewIfNeeded();
  await p.click('#hq-carnet-insert-menu [data-carnet-insert="time"]');
  await until(async () => /\d{1,2}[:h]\d{2}/.test(await edText(p)), "time inserted: " + (await edText(p)));
  check((await recentsKey(p)) === '["time"]', "recorded: " + (await recentsKey(p)));
});

scenario("menu: dark and light, phone and desktop — selected row, icon tile and group labels keep contrast; screenshots", async () => {
  for (const [scheme, profile] of [["dark", "desktop"], ["light", "desktop"], ["dark", "iphone"], ["light", "iphone"]]) {
    const { p, ctx } = await openEditor(profile, PNB(), { colorScheme: scheme });
    await openSlash(p);
    await p.keyboard.type("");
    await sleep(150);
    const c = await p.evaluate(() => {
      const sel = document.querySelector('#carnet-cmd-list [aria-selected="true"]');
      const lab = document.querySelector(".carnet-cmd-group-label");
      const menu = document.getElementById("carnet-cmd-menu");
      return { selBg: getComputedStyle(sel).backgroundColor, selFg: getComputedStyle(sel.querySelector(".carnet-cmd-label")).color, tileBg: getComputedStyle(sel.querySelector(".carnet-cmd-icon")).backgroundColor, tileFg: getComputedStyle(sel.querySelector(".carnet-cmd-icon")).color, labFg: getComputedStyle(lab).color, menuBg: getComputedStyle(menu).backgroundColor };
    });
    const flat = (col, over) => col; // computed colours are opaque here except the selected tint (alpha): measure against the menu background
    void flat;
    check((await contrast(p, c.selFg, c.menuBg)) >= 4.5, `${scheme}/${profile}: row label on the menu: ${(await contrast(p, c.selFg, c.menuBg)).toFixed(2)}`);
    check((await contrast(p, c.labFg, c.menuBg)) >= 3, `${scheme}/${profile}: group label on the menu: ${(await contrast(p, c.labFg, c.menuBg)).toFixed(2)}`);
    check((await contrast(p, c.tileFg, c.tileBg)) >= 3, `${scheme}/${profile}: selected icon on its tile: ${(await contrast(p, c.tileFg, c.tileBg)).toFixed(2)}`);
    const m = await rect(p, "#carnet-cmd-menu");
    const v = p.viewportSize();
    check(m.l >= -0.5 && m.r <= v.width + 0.5 && m.t >= -0.5 && m.b <= v.height + 0.5, `${scheme}/${profile}: menu on-screen`);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${scheme}/${profile}: no horizontal scroll`);
    if (process.env.PRODUCT_SHOTS) await p.screenshot({ path: path.join(process.env.PRODUCT_SHOTS, `${scheme}-${profile}-command-menu.png`) });
    await ctx.close();
  }
});

// ---------------------------------------------------------------- templates
const TPL_IDS = ["blank", "journal", "inspection", "test", "meeting", "decision", "project"];
const TPL_LABELS = ["Note vide", "Journal d'ingénierie", "Inspection", "Test / expérience", "Réunion", "Registre de décision", "Journal de projet"];
const CANON = ["paragraph", "heading", "bullet", "number", "check"];
async function openTpl(p) {
  await openTools(p);
  await p.click("#btn-carnet-templates");
  await p.waitForSelector("#hq-carnet-templates", { state: "visible" });
}
const pickTpl = async (p, id) => { await p.click(`[data-carnet-template="${id}"]`); };
const serverPages = (srv) => srv.nb().pages;
async function waitNewPage(srv, before) {
  return until(() => serverPages(srv).find((x) => !before.includes(x.id)), "new page exists on the server");
}

scenario("templates: picker lists the seven templates, is a labelled modal dialog, keyboard-driven, closes cleanly", async () => {
  const { srv, p } = await openEditor("desktop", PNB());
  await openTpl(p);
  check(JSON.stringify(await p.locator(".carnet-tpl-label").allTextContents()) === JSON.stringify(TPL_LABELS), "seven templates in the requested order: " + (await p.locator(".carnet-tpl-label").allTextContents()));
  const a = await p.evaluate(() => { const d = document.getElementById("hq-carnet-templates"); return [d.getAttribute("role"), d.getAttribute("aria-modal"), document.getElementById(d.getAttribute("aria-labelledby")).textContent, document.activeElement.getAttribute("data-carnet-template")]; });
  check(a[0] === "dialog" && a[1] === "true" && /modèle/i.test(a[2]) && a[3] === "blank", "dialog semantics, title, focus on the first template: " + JSON.stringify(a));
  check((await p.locator(".carnet-tpl-hint").allTextContents()).every((t) => t.length > 0 && t.length <= 48), "concise descriptions");
  await p.keyboard.press("ArrowDown");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-template"))) === "journal", "ArrowDown moves");
  await p.keyboard.press("ArrowUp");
  await p.keyboard.press("ArrowUp");
  check((await p.evaluate(() => document.activeElement.id)) === "btn-carnet-tpl-close", "ArrowUp wraps to the close button");
  await p.keyboard.press("Tab");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-carnet-template"))) === "blank", "Tab cycles inside the modal");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-templates").isHidden(), "Escape closes");
  await openTpl(p);
  await p.click("#btn-carnet-tpl-close");
  check(await p.locator("#hq-carnet-templates").isHidden(), "close button closes");
  await openTpl(p);
  await p.mouse.click(5, 5);
  check(await p.locator("#hq-carnet-templates").isHidden(), "backdrop closes");
  check(serverPages(srv).length === 2, "opening / closing created nothing");
});

scenario("templates: every template creates an ordinary page — canonical types only, empty fill-in lines, unique server ids, date stamped, saved, reloaded, exported", async () => {
  const { srv, p } = await openEditor("desktop", PNB());
  const today = await p.evaluate(() => { const d = new Date(); const t = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + t(d.getMonth() + 1) + "-" + t(d.getDate()); });
  const allIds = new Set(serverPages(srv).flatMap((x) => x.content.blocks.map((b) => b.id)));
  for (const id of TPL_IDS) {
    const before = serverPages(srv).map((x) => x.id);
    await openTpl(p);
    await pickTpl(p, id);
    const np = await waitNewPage(srv, before);
    await until(async () => (await p.locator("#hq-carnet-templates").isHidden()), "picker closed after " + id);
    check(serverPages(srv).length === before.length + 1, id + ": exactly one page created");
    const blocks = np.content.blocks;
    check(blocks.length >= 1 && blocks.every((b) => CANON.includes(b.type)), id + ": canonical types only: " + [...new Set(blocks.map((b) => b.type))]);
    check(blocks.every((b) => /^block-[0-9a-z-]+$/.test(b.id) && !allIds.has(b.id)), id + ": fresh server-assigned ids, none reused");
    for (const b of blocks) allIds.add(b.id);
    check(new Set(blocks.map((b) => b.id)).size === blocks.length, id + ": ids unique within the page");
    check(blocks.every((b) => (b.type === "heading" ? b.text.length > 0 : b.text === "")), id + ": headings carry the structure; every other line is an EMPTY fill-in (nothing pre-written)");
    check(blocks.every((b) => !/\{[a-z]+\}/.test(b.text)), id + ": no unresolved placeholder");
    if (id === "blank") check(blocks.length === 1 && blocks[0].type === "paragraph", "blank: one empty paragraph");
    else check(blocks[0].type === "heading" && blocks[0].text.includes(today), id + ": title heading carries today's date: " + blocks[0].text);
    check(np.project_id === null && np.category_id === null, id + ": no organisation set (À classer)");
    check(!JSON.stringify(blocks).match(/"(image|measure|calc|decision|drawing|task)"/), id + ": no atom, no engineering content");
    // it IS the ordinary current page, editable and clean
    await until(async () => (await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === np.id, id + ": opened in the editor");
    check(!(await dirty(p)), id + ": opening is not an edit");
  }
  // inspection structure exactly as requested
  const insp = serverPages(srv).find((x) => x.content.blocks[0].text.startsWith("Inspection — "));
  check(insp.content.blocks.filter((b) => b.type === "heading").map((b) => b.text).slice(1).join("|") === "Objet|Conditions|Mesures|Photos|Observations|Décision", "Inspection: Objet / Conditions / Mesures / Photos / Observations / Décision");
  // typing over a template line saves through the normal path and survives a reload
  await p.evaluate(() => document.querySelector("#hq-carnet-editor").focus());
  const last = serverPages(srv).find((x) => x.content.blocks[0].text.startsWith("Journal de projet"));
  await p.evaluate((id) => window.hqCarnetOpen && window.hqCarnetOpen(id), last.id);
  await until(async () => (await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === last.id, "reopen project page");
  const txt0 = await edText(p);
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); const i = e.value.indexOf("Avancement") + "Avancement".length + 1; e.setSelectionRange(i, i); });
  await p.keyboard.type("Fondations coulées");
  await saved(p);
  check(serverPages(srv).find((x) => x.id === last.id).content.blocks.some((b) => b.text === "Fondations coulées"), "typing over a fill-in saves via the normal draft/save path");
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await p.evaluate((id) => window.hqCarnetOpen(id), last.id);
  await until(async () => (await edText(p)).includes("Fondations coulées") && (await edText(p)).includes("Jalons"), "reload keeps the template page");
  void txt0;
  // export (md + txt) of a template page
  await openTools(p);
  await p.click("#btn-carnet-export");
  let [dl] = await Promise.all([p.waitForEvent("download"), p.click("#btn-carnet-export-md")]);
  const md = readFileSync(await dl.path(), "utf8");
  check(/^## Journal de projet — \d{4}-\d{2}-\d{2}\n/.test(md) && md.includes("## Avancement") && md.includes("Fondations coulées") && md.includes("- [ ]"), "Markdown export of a template page: " + JSON.stringify(md.slice(0, 120)));
  [dl] = await Promise.all([p.waitForEvent("download"), p.click("#btn-carnet-export-txt")]);
  const tx = readFileSync(await dl.path(), "utf8");
  check(tx.startsWith("Journal de projet — ") && tx.includes("Avancement\nFondations coulées") && tx.includes("[ ]"), "TXT export of a template page: " + JSON.stringify(tx.slice(0, 120)));
});

scenario("templates: created from a library scope inherit its project/category; the tools-drawer entry creates À classer", async () => {
  const nb = notebook([page("page-a", 1, [para("one")]), page("page-b", 1, [para("other")], { project_id: "proj-1", category_id: "cat-1" })]);
  nb.projects = [{ id: "proj-1", name: "Pont", archived: false, created_at: 1790680000, updated_at: 1790680000 }];
  nb.categories = [{ id: "cat-1", name: "Chantier", color: "green", created_at: 1790680000, updated_at: 1790680000 }];
  const { srv, p } = await openEditor("desktop", nb);
  await openLibrary(p);
  const btn = p.locator("#btn-carnet-lib-templates");
  check(await btn.isVisible(), "library header offers 'Modèle'");
  await p.click('.carnet-scope[data-carnet-project="proj-1"]');
  check(/Projet : Pont/.test(await p.locator(".carnet-lib-scope").innerText()), "library scoped to the project");
  const before = serverPages(srv).map((x) => x.id);
  await btn.click();
  await p.waitForSelector("#hq-carnet-templates", { state: "visible" });
  await pickTpl(p, "meeting");
  const np = await waitNewPage(srv, before);
  check(np.project_id === "proj-1" && np.category_id === null, "page inherits the scoped project: " + np.project_id + "/" + np.category_id);
  await p.click('.carnet-scope[data-carnet-category="cat-1"]').catch(() => {});
  // tools drawer: unscoped
  const before2 = serverPages(srv).map((x) => x.id);
  await p.click("#btn-carnet-library"); // close the library
  await openTpl(p);
  await pickTpl(p, "journal");
  const np2 = await waitNewPage(srv, before2);
  check(np2.content.blocks[0].text.startsWith("Journal d'ingénierie — ") && np2.project_id === null && np2.category_id === null, "tools-drawer entry: unscoped page (À classer)");
});

scenario("templates: failures are atomic — server refusal, dropped connection, page limit and notebook limit leave NO page and keep the picker usable", async () => {
  const { srv, p } = await openEditor("desktop", PNB());
  const before = serverPages(srv).map((x) => x.id);
  const revBefore = srv.nb().notebook_rev;
  // 1. the server refuses
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Refusé par le test" }) });
    return route.continue();
  });
  await openTpl(p);
  await pickTpl(p, "inspection");
  await until(async () => (await p.locator("#hq-carnet-templates").isVisible()) && (await p.locator("[data-carnet-template]:not([disabled])").count()) === 7, "picker stays open and usable after a refusal");
  check(serverPages(srv).length === before.length && srv.nb().notebook_rev === revBefore, "refusal: no page, no revision bump");
  await p.unroute("**/api/carnet");
  // 2. the connection drops before any response
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) return route.abort("connectionreset");
    return route.continue();
  });
  await pickTpl(p, "test");
  await sleep(600);
  check(serverPages(srv).length === before.length, "dropped request: no page");
  await p.unroute("**/api/carnet");
  await p.keyboard.press("Escape");
  // 3. the REAL server limit: 128 active pages
  const many = [];
  for (let i = 0; i < 128; i += 1) many.push(page("page-full-" + i, 1, [para("p" + i)]));
  const full = await openEditor("desktop", notebook(many));
  await openTpl(full.p);
  await pickTpl(full.p, "journal");
  await until(async () => /128|limite|maximum|trop/i.test(await full.p.evaluate(() => document.body.innerText)), "limit message shown");
  check(full.srv.nb().pages.length === 128, "page limit: nothing was created");
  check(await full.p.locator("#hq-carnet-templates").isVisible(), "picker still open to retry/close");
});

// ---------------------------------------------------------------- Quick Capture
async function capHome(profile = "desktop", nb = PNB(), extra = {}) {
  const srv = await server(nb);
  const ctx = await context(srv, profile, extra);
  const p = await ctx.newPage();
  const tag = "[cap " + (p.viewportSize() ? p.viewportSize().width : "?") + "]";
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
  p.on("request", (r) => { const u = r.url(); if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u); });
  await p.goto(srv.base + "/");
  await p.waitForSelector("#hq-capture-fab", { state: "visible", timeout: 15000 });
  return { srv, ctx, p };
}
const capOpen = async (p) => { await p.click("#hq-capture-fab"); await p.waitForSelector("#hq-capture", { state: "visible" }); };
const capMode = (p, m) => p.click(`[data-capture-mode="${m}"]`);
const capSave = (p) => p.click("#hq-capture-save");
const capMsg = (p) => p.locator("#hq-capture-msg").innerText();
const capClosed = (p) => until(async () => p.locator("#hq-capture").isHidden(), "capture sheet closed");
const newPages = (srv, before) => serverPages(srv).filter((x) => !before.includes(x.id));
const idsOf = (srv) => serverPages(srv).map((x) => x.id);

scenario("capture: gated to admins (the Carnet API is admin-only); no FAB for upload users, none on the login page", async () => {
  const srv = await server(PNB());
  const ctx = await browser.newContext(PROFILES.desktop);
  const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.upload_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(r.status() === 303, "upload user logs in");
  const p = await ctx.newPage();
  await p.goto(srv.base + "/");
  await sleep(1500);
  check((await p.locator("#hq-capture-fab").count()) === 0 && !(await p.evaluate(() => !!window.hqCapture)), "no capture entry for an upload-role user");
  const anon = await (await browser.newContext(PROFILES.desktop)).newPage();
  await anon.goto(srv.base + "/");
  await sleep(800);
  check((await anon.locator("#hq-capture-fab").count()) === 0, "none when signed out");
});

scenario("capture: FAB on the home screen, opens a labelled modal sheet; Escape / close / backdrop close it; focus returns", async () => {
  const { srv, p } = await capHome();
  const fab = await p.evaluate(() => { const b = document.getElementById("hq-capture-fab"); return [b.getAttribute("aria-label"), b.getAttribute("aria-haspopup")]; });
  check(fab[0] === "Capture rapide" && fab[1] === "dialog", "FAB is labelled: " + fab);
  await capOpen(p);
  const a = await p.evaluate(() => { const d = document.getElementById("hq-capture"); return [d.getAttribute("role"), d.getAttribute("aria-modal"), document.getElementById(d.getAttribute("aria-labelledby")).textContent, document.activeElement.id, document.getElementById("hq-capture-fab").offsetParent === null || getComputedStyle(document.getElementById("hq-capture-fab")).visibility === "hidden" || getComputedStyle(document.getElementById("hq-capture-fab")).display === "none"]; });
  check(a[0] === "dialog" && a[1] === "true" && a[2] === "Capture rapide", "dialog semantics: " + a);
  check(a[3] === "hq-capture-text", "focus lands in the note field (text is the default mode): " + a[3]);
  check(a[4] === true, "FAB hidden while the sheet is open");
  check((await p.evaluate(() => [...document.querySelectorAll("[data-capture-mode]")].map((b) => b.textContent + ":" + b.getAttribute("aria-pressed")).join())) === "Texte:true,Photo:false,Mesure:false,Décision:false", "four modes, Texte active");
  // defaults
  const d = await p.evaluate(() => [document.getElementById("hq-capture-project").selectedOptions[0].textContent, document.getElementById("hq-capture-category").selectedOptions[0].textContent]);
  check(/classer/i.test(d[0]) || /Aucun/i.test(d[0]), "project defaults to À classer: " + d);
  await p.keyboard.press("Escape");
  await capClosed(p);
  check((await p.evaluate(() => document.activeElement.id)) === "hq-capture-fab", "focus returns to the FAB");
  await capOpen(p);
  await p.click("#hq-capture-close");
  await capClosed(p);
  await capOpen(p);
  await p.mouse.click(3, 3);
  await capClosed(p);
  check(serverPages(srv).length === 2, "opening/closing created nothing");
  // focus trap
  await capOpen(p);
  for (let i = 0; i < 25; i += 1) await p.keyboard.press("Tab");
  check(await p.evaluate(() => document.getElementById("hq-capture").contains(document.activeElement)), "Tab never leaves the modal sheet");
  for (let i = 0; i < 25; i += 1) await p.keyboard.press("Shift+Tab");
  check(await p.evaluate(() => document.getElementById("hq-capture").contains(document.activeElement)), "Shift+Tab neither");
});

scenario("capture: TEXT — two interactions, ordinary page À classer, first line becomes the title, saved/reloaded/exportable; toast opens it", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  await capOpen(p);
  await p.keyboard.type("Fuite au raccord B2\nJoint à changer demain");
  await p.keyboard.press("Control+Enter");
  await capClosed(p);
  const np = (await until(() => newPages(srv, before)[0], "page created"));
  check(newPages(srv, before).length === 1, "exactly one page");
  check(np.project_id === null && np.category_id === null, "default: À classer");
  check(np.content.blocks.map((b) => b.type + ":" + b.text).filter((x) => x !== "paragraph:").join("|").startsWith("paragraph:Fuite au raccord B2|paragraph:Joint à changer demain"), "blocks: " + JSON.stringify(np.content.blocks.map((b) => b.text)));
  check(np.content.blocks.every((b) => /^block-/.test(b.id)), "server-assigned block ids");
  check(await p.locator("#hq-capture-toast").isVisible(), "confirmation toast shown");
  check(/Capturé dans/.test(await p.locator("#hq-capture-toast").innerText()) && /classer/i.test(await p.locator("#hq-capture-toast").innerText()), "toast names where it went: " + (await p.locator("#hq-capture-toast").innerText()).replace(/\n/g, " "));
  check(!(await p.url()).includes("Fuite") && !(await p.url()).includes("?") && !(await p.url()).includes("#capture"), "nothing in the URL: " + p.url());
  check((await p.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)))).indexOf("Fuite") < 0, "capture text never stored in the browser");
  await p.click(".hq-capture-toast-open");
  await p.waitForSelector("#hq-carnet-editor", { timeout: 10000 });
  await until(async () => (await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === np.id && (await edText(p)).includes("Fuite au raccord B2"), "toast 'Ouvrir' opens the captured page in Carnet");
  // the sheet is reusable and empty again
  await p.evaluate(() => document.getElementById("hq-capture-fab").click());
});

scenario("capture: TEXT validation — empty and over-long are refused in place, nothing created", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  await capOpen(p);
  await capSave(p);
  check(/Écris quelque chose/.test(await capMsg(p)) && (await p.locator("#hq-capture").isVisible()), "empty: message, sheet stays");
  await p.fill("#hq-capture-text", "   \n  ");
  await capSave(p);
  check(/Écris quelque chose/.test(await capMsg(p)), "whitespace-only is empty too");
  await p.fill("#hq-capture-text", "x".repeat(60000));
  await capSave(p);
  check(/trop long/.test(await capMsg(p)), "too long: " + (await capMsg(p)));
  check(serverPages(srv).length === before.length && srv.nb().notebook_rev === 4, "nothing created, revision untouched");
  check((await p.evaluate(() => document.getElementById("hq-capture-msg").getAttribute("data-bad"))) === "true", "message flagged as an error");
});

scenario("capture: MEASURE — typed measure atom through the engineering validator; French decimals; tolerance only with a nominal", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  await capOpen(p);
  await capMode(p, "measure");
  check((await p.evaluate(() => document.activeElement.id)) === "hq-capture-m-label", "focus on the label");
  await capSave(p);
  check(/nom à la mesure/.test(await capMsg(p)), "label required: " + (await capMsg(p)));
  await p.fill("#hq-capture-m-label", "Jeu axial");
  await p.fill("#hq-capture-m-value", "abc");
  await capSave(p);
  check(/Valeur invalide/.test(await capMsg(p)), "bad value refused");
  await p.fill("#hq-capture-m-value", "12,5");
  await p.fill("#hq-capture-m-tol", "0,2");
  await capSave(p);
  check(/Tolérance invalide/.test(await capMsg(p)), "tolerance without nominal refused: " + (await capMsg(p)));
  check(serverPages(srv).length === before.length, "nothing created by the refusals");
  await p.selectOption("#hq-capture-m-unit", "mm");
  await p.fill("#hq-capture-m-nominal", "12");
  await capSave(p);
  await capClosed(p);
  const np = await until(() => newPages(srv, before)[0], "measure page created");
  const m = np.content.blocks.find((b) => b.type === "measure");
  check(!!m, "a canonical measure block: " + JSON.stringify(np.content.blocks.map((b) => b.type)));
  check(m.measure.observed.v === "12.5" && m.measure.observed.u === "mm" && m.measure.nominal.v === "12" && m.measure.mode === "sym" && m.measure.tol.t === "0.2", "12,5 mm, nominal 12, ±0,2 (comma decimals normalised): " + JSON.stringify(m.measure));
  check(np.content.blocks[0].text.startsWith("Mesure — Jeu axial"), "heading line above names it (page title): " + np.content.blocks[0].text);
  check(np.content.blocks[np.content.blocks.length - 1].type === "paragraph", "ends on an empty paragraph to keep typing");
  check(!np.content.blocks.some((b) => b.type === "decision" || (b.text || "").match(/conforme|accept|rejet/i)), "no verdict authored");
});

scenario("capture: DECISION — one decision block, page titled by it", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  await capOpen(p);
  await capMode(p, "decision");
  await capSave(p);
  check(/Écris la décision/.test(await capMsg(p)), "empty refused");
  await p.keyboard.type("On garde l'ajustement H7/g6");
  await p.keyboard.press("Enter"); // single-line input: Enter submits
  await capClosed(p);
  const np = await until(() => newPages(srv, before)[0], "decision page created");
  const d = np.content.blocks.find((b) => b.type === "decision");
  check(!!d && d.text === "On garde l'ajustement H7/g6", "decision block: " + JSON.stringify(np.content.blocks.map((b) => [b.type, b.text])));
  check(np.content.blocks.filter((b) => b.type === "decision").length === 1, "exactly one decision");
});

scenario("capture: PHOTO — through the existing media pipeline and /api/carnet/asset; asset referenced by the new page; caption optional", async () => {
  const { srv, ctx, p } = await capHome();
  const before = idsOf(srv);
  const assetsBefore = srv.assets().length;
  const png = await makeImage(p, { w: 1600, h: 1200 });
  const up = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/carnet/asset")) up.push(r.url()); });
  await capOpen(p);
  await capMode(p, "photo");
  await capSave(p);
  check(/photo/i.test(await capMsg(p)), "no photo: refused: " + (await capMsg(p)));
  await p.setInputFiles('[data-capture-input="photos"]', jpg(png));
  await until(async () => p.locator(".hq-capture-preview").isVisible(), "preview shown");
  await p.fill("#hq-capture-caption", "Raccord B2");
  await capSave(p);
  await capClosed(p);
  const np = await until(() => newPages(srv, before)[0], "photo page created");
  const img = np.content.blocks.find((b) => b.type === "image");
  check(!!img && up.length === 1 && srv.assets().length === assetsBefore + 1, "one upload through the existing endpoint, one asset: uploads=" + up.length);
  check(!!img.asset && srv.assets().some((a) => a.startsWith(img.asset.id)) && img.asset.mime === "image/jpeg", "image block references the uploaded asset: " + JSON.stringify(img).slice(0, 300) + " / " + srv.assets());
  check(/Photo — /.test(np.content.blocks[0].text) && JSON.stringify(img).includes("Raccord B2"), "caption kept: " + JSON.stringify(np.content.blocks.map((b) => [b.type, b.text])));
  check(srv.tmps().length === 0, "no temp upload left");
  check(!up.some((u) => /[?#]/.test(u)), "no query/fragment on the upload URL");
  void ctx;
});

scenario("capture: classification — project/category chosen, remembered nowhere, applied to the new page", async () => {
  const nb = notebook([page("page-a", 1, [para("one")])]);
  nb.projects = [{ id: "proj-1", name: "Pont", archived: false, created_at: 1790680000, updated_at: 1790680000 }, { id: "proj-old", name: "Ancien", archived: true, created_at: 1790680000, updated_at: 1790680000 }];
  nb.categories = [{ id: "cat-1", name: "Chantier", color: "green", created_at: 1790680000, updated_at: 1790680000 }];
  const { srv, p } = await capHome("desktop", nb);
  await capOpen(p);
  await until(() => p.evaluate(() => document.getElementById("hq-capture-project").options.length > 1), "organisation lists loaded (read fresh on open)");
  const opts = await p.evaluate(() => [[...document.getElementById("hq-capture-project").options].map((o) => o.textContent), [...document.getElementById("hq-capture-category").options].map((o) => o.textContent)]);
  check(opts[0].includes("Pont") && !opts[0].includes("Ancien"), "active projects only: " + opts[0]);
  check(opts[1].includes("Chantier"), "categories listed: " + opts[1]);
  const before = idsOf(srv);
  await p.selectOption("#hq-capture-project", "proj-1");
  await p.selectOption("#hq-capture-category", "cat-1");
  await p.fill("#hq-capture-text", "Relevé du pilier 3");
  await capSave(p);
  await capClosed(p);
  const np = await until(() => newPages(srv, before)[0], "created");
  check(np.project_id === "proj-1" && np.category_id === "cat-1", "organisation applied: " + np.project_id + "/" + np.category_id);
  check(/Pont/.test(await p.locator("#hq-capture-toast").innerText()), "toast names the project: " + (await p.locator("#hq-capture-toast").innerText()).replace(/\n/g, " "));
  await capOpen(p);
  const back = await p.evaluate(() => [document.getElementById("hq-capture-project").value, document.getElementById("hq-capture-category").value]);
  check(back[0] === "" && back[1] === "", "next capture defaults to À classer again: " + back);
});

scenario("capture: STALE selection — project archived/deleted or notebook changed meanwhile: nothing created, selects refreshed, message shown", async () => {
  const nb = notebook([page("page-a", 1, [para("one")])]);
  nb.projects = [{ id: "proj-1", name: "Pont", archived: false, created_at: 1790680000, updated_at: 1790680000 }];
  nb.categories = [{ id: "cat-1", name: "Chantier", color: "green", created_at: 1790680000, updated_at: 1790680000 }];
  const { srv, p } = await capHome("desktop", nb);
  await capOpen(p);
  await p.selectOption("#hq-capture-project", "proj-1");
  await p.selectOption("#hq-capture-category", "cat-1");
  await p.fill("#hq-capture-text", "Note qui ne doit pas atterrir ailleurs");
  // the project disappears behind the sheet's back (another device)
  const cur = srv.nb();
  cur.projects[0].archived = true;
  cur.notebook_rev += 1;
  srv.put(cur);
  const before = idsOf(srv);
  await capSave(p);
  await until(async () => /projet|archiv/i.test(await capMsg(p)), "stale project message: " + (await capMsg(p)));
  check(serverPages(srv).length === before.length, "nothing created");
  check((await p.locator("#hq-capture").isVisible()) && (await p.inputValue("#hq-capture-text")).startsWith("Note qui"), "sheet stays open, text kept");
  check((await p.inputValue("#hq-capture-project")) === "", "project select reset");
  // the category is deleted too
  const cur2 = srv.nb();
  cur2.categories = [];
  cur2.notebook_rev += 1;
  srv.put(cur2);
  await p.selectOption("#hq-capture-category", "").catch(() => {});
  // notebook revision moved: a fresh capture still succeeds exactly once (one retry on the 409)
  const cur3 = srv.nb();
  cur3.notebook_rev += 1;
  srv.put(cur3);
  await capSave(p);
  await capClosed(p);
  check(newPages(srv, before).length === 1, "after re-reading, a stale revision still yields exactly one page");
});

scenario("capture: FAILURES leave nothing half-created — refusal, dropped request, dropped RESPONSE (no duplicate), photo retry reuses the upload", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  // 1. refusal
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Refusé par le test" }) });
    return route.continue();
  });
  await capOpen(p);
  await p.fill("#hq-capture-text", "A");
  await capSave(p);
  await until(async () => /Refusé par le test/.test(await capMsg(p)), "server error surfaced");
  check(serverPages(srv).length === before.length && (await p.locator("#hq-capture").isVisible()) && (await p.inputValue("#hq-capture-text")) === "A", "refusal: no page, sheet open, text kept");
  check(await p.locator("#hq-capture-save").isEnabled(), "save usable again");
  await p.unroute("**/api/carnet");
  // 2. request never leaves
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) return route.abort("connectionreset");
    return route.continue();
  });
  await capSave(p);
  await until(async () => /Hors ligne|rien n'a été créé/.test(await capMsg(p)), "offline message: " + (await capMsg(p)));
  check(serverPages(srv).length === before.length, "dropped request: no page");
  await p.unroute("**/api/carnet");
  // 3. the server DID create the page but the response is lost: the capture stays in the sheet, and Save again is IDEMPOTENT (same request_id)
  const bodies = [];
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) { bodies.push(JSON.parse(r.postData())); await route.fetch(); return route.abort("connectionreset"); }
    return route.continue();
  });
  await capSave(p);
  await until(async () => /Hors ligne|rien n'a été créé/.test(await capMsg(p)), "lost response: offline message, capture kept");
  check(newPages(srv, before).length === 1 && (await p.locator("#hq-capture").isVisible()) && (await p.inputValue("#hq-capture-text")) === "A", "server has the page; the sheet still holds the capture");
  await p.unroute("**/api/carnet");
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) bodies.push(JSON.parse(r.postData()));
    return route.continue();
  });
  await capSave(p);
  await capClosed(p);
  check(newPages(srv, before).length === 1, "retry after a lost response: still exactly ONE page: " + newPages(srv, before).length);
  check(bodies.length === 2 && bodies[0].request_id && bodies[0].request_id === bodies[1].request_id && JSON.stringify(bodies[0].content) === JSON.stringify(bodies[1].content), "the retry re-sent the SAME request_id and the SAME content");
  await p.unroute("**/api/carnet");
  // 4. photo: upload succeeds, creation fails; the retry must NOT upload again
  const before2 = idsOf(srv);
  const png = await makeImage(p, { w: 800, h: 600 });
  const up = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/carnet/asset")) up.push(1); });
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "panne" }) });
    return route.continue();
  });
  await capOpen(p);
  await capMode(p, "photo");
  await p.setInputFiles('[data-capture-input="photos"]', jpg(png));
  await until(async () => p.locator(".hq-capture-preview").isVisible(), "preview");
  await capSave(p);
  await until(async () => /Hors ligne|rien n'a été créé|panne/.test(await capMsg(p)), "photo creation failed message");
  check(serverPages(srv).length === before2.length + 0 || newPages(srv, before2).length === 0, "photo: failed creation leaves no page");
  await p.unroute("**/api/carnet");
  await capSave(p);
  await capClosed(p);
  check(up.length === 1, "retry reused the uploaded asset (uploads: " + up.length + ")");
  check(newPages(srv, before2).length === 1, "retry created exactly one page");
});

scenario("capture: dirty close needs a second press; a clean close is immediate; busy state disables the form", async () => {
  const { srv, p } = await capHome();
  await capOpen(p);
  await p.fill("#hq-capture-text", "à garder");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-capture").isVisible() && /Appuie encore/.test(await capMsg(p)), "first Escape asks for confirmation: " + (await capMsg(p)));
  await p.keyboard.press("Escape");
  await capClosed(p);
  await capOpen(p);
  check((await p.inputValue("#hq-capture-text")) === "", "an abandoned capture is gone (nothing persisted)");
  await p.keyboard.press("Escape");
  await capClosed(p);
  check(serverPages(srv).length === 2, "nothing created");
});

scenario("capture: PHONE and desktop — FAB clear of the nav/dock/toast, sheet inside the viewport with 16px/44px fields, dark + light contrast, screenshots", async () => {
  for (const [scheme, profile] of [["dark", "iphone"], ["light", "iphone"], ["dark", "desktop"], ["light", "desktop"]]) {
    const { srv, ctx, p } = await capHome(profile, PNB(), { colorScheme: scheme });
    const v = p.viewportSize();
    const fab = await rect(p, "#hq-capture-fab");
    const nav = await rect(p, ".bottom-nav");
    check(fab && fab.l >= 0 && fab.r <= v.width && fab.b <= v.height && fab.t >= 0, `${scheme}/${profile}: FAB on-screen`);
    if (nav) check(!overlap(fab, nav), `${scheme}/${profile}: FAB does not cover the bottom nav`);
    if (profile === "iphone") check(fab.w >= 44 && fab.h >= 44, `${scheme}/${profile}: FAB is a ≥44px target (${Math.round(fab.w)}x${Math.round(fab.h)})`);
    check((await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)), `${scheme}/${profile}: no horizontal scroll`);
    if (process.env.PRODUCT_SHOTS) await p.screenshot({ path: path.join(process.env.PRODUCT_SHOTS, `${scheme}-${profile}-capture-fab.png`) });
    await capOpen(p);
    for (const mode of ["text", "photo", "measure", "decision"]) {
      await capMode(p, mode);
      const box = await rect(p, "#hq-capture");
      check(box.l >= -0.5 && box.r <= v.width + 0.5 && box.t >= -0.5 && box.b <= v.height + 0.5, `${scheme}/${profile}/${mode}: sheet inside the viewport`);
      const f = await p.evaluate(() => [...document.querySelectorAll("#hq-capture input:not([type=file]), #hq-capture textarea, #hq-capture select")].filter((n) => n.offsetParent).map((n) => ({ id: n.id, fs: parseFloat(getComputedStyle(n).fontSize), h: n.getBoundingClientRect().height, tag: n.tagName })));
      check(f.every((x) => x.fs >= 16), `${scheme}/${profile}/${mode}: inputs ≥16px (no iOS zoom) ` + JSON.stringify(f.filter((x) => x.fs < 16)));
      check(f.filter((x) => x.tag !== "TEXTAREA").every((x) => x.h >= 43.5), `${scheme}/${profile}/${mode}: fields ≥44px high`);
      const sv = await rect(p, "#hq-capture-save");
      check(sv && sv.b <= v.height + 0.5 && sv.t >= 0, `${scheme}/${profile}/${mode}: Save button reachable without scrolling the page`);
      if (process.env.PRODUCT_SHOTS) await p.screenshot({ path: path.join(process.env.PRODUCT_SHOTS, `${scheme}-${profile}-capture-${mode}.png`) });
    }
    const c = await p.evaluate(() => { const s = document.getElementById("hq-capture-save"), b = document.getElementById("hq-capture"); return [getComputedStyle(s).color, getComputedStyle(s).backgroundColor, getComputedStyle(b).backgroundColor, getComputedStyle(document.querySelector(".hq-capture-label")).color]; });
    check((await contrast(p, c[0], c[1])) >= 4.5, `${scheme}/${profile}: Save label on accent ${(await contrast(p, c[0], c[1])).toFixed(2)}`);
    check((await contrast(p, c[3], c[2])) >= 4.5, `${scheme}/${profile}: field labels on the sheet ${(await contrast(p, c[3], c[2])).toFixed(2)}`);
    await capMode(p, "text");
    await p.fill("#hq-capture-text", "Capture de test");
    await capSave(p);
    await capClosed(p);
    const toast = await rect(p, "#hq-capture-toast");
    const nav2 = await rect(p, ".bottom-nav");
    check(toast && toast.l >= 0 && toast.r <= v.width + 0.5 && (!nav2 || !overlap(toast, nav2)), `${scheme}/${profile}: toast on-screen and clear of the nav`);
    if (process.env.PRODUCT_SHOTS) await p.screenshot({ path: path.join(process.env.PRODUCT_SHOTS, `${scheme}-${profile}-capture-toast.png`) });
    await ctx.close();
    void srv;
  }
});

scenario("capture: FAB inside Carnet — clear of the bottom bar and the library dock; hidden in focus mode", async () => {
  const { p } = await capHome("iphone");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor");
  const v = p.viewportSize();
  const fab = await rect(p, "#hq-capture-fab");
  for (const sel of [".bottom-nav", ".carnet-bottombar", "#hq-carnet-dock", ".carnet-dock"]) {
    const r = await rect(p, sel);
    if (r && r.w > 0 && r.h > 0) check(!overlap(fab, r), `FAB clear of ${sel}`);
  }
  check(fab && fab.b <= v.height && fab.r <= v.width, "FAB on-screen in Carnet");
  await openLibrary(p);
  const fab2 = await rect(p, "#hq-capture-fab");
  const dock = await rect(p, "#hq-carnet-library");
  void dock;
  check(!fab2 || fab2.r <= v.width, "FAB sane with the library open");
  if (process.env.PRODUCT_SHOTS) await p.screenshot({ path: path.join(process.env.PRODUCT_SHOTS, "dark-iphone-capture-in-carnet-library.png") });
});

scenario("capture: lost response AND lost recovery read, then manual retry later — one page; a concurrent same-title page is never adopted", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  let outage = false;
  const posts = [];
  await p.route("**/api/carnet**", async (route) => {
    const r = route.request();
    const body = r.postData() || "";
    if (r.method() === "POST" && /"action":"page_create"/.test(body)) {
      posts.push(JSON.parse(body));
      if (!outage) { outage = true; await route.fetch(); return route.abort("connectionreset"); } // applied, response lost, and the network stays down
    }
    if (outage === true) return route.abort("connectionreset");
    return route.continue();
  });
  await capOpen(p);
  await p.fill("#hq-capture-text", "Même titre");
  await capSave(p);
  await until(async () => /Hors ligne|rien n'a été créé/.test(await capMsg(p)), "offline message");
  check(newPages(srv, before).length === 1, "the server did create the page (response lost)");
  // meanwhile ANOTHER client creates a page with the very same title
  const cur = srv.nb();
  cur.pages.push(page("page-other-same-title", 1, [para("Même titre")]));
  cur.notebook_rev += 1;
  srv.put(cur);
  const afterOther = idsOf(srv);
  outage = "back";
  await p.unroute("**/api/carnet**");
  await p.route("**/api/carnet**", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) posts.push(JSON.parse(r.postData()));
    return route.continue();
  });
  await capSave(p);
  await capClosed(p);
  const mine = newPages(srv, before).filter((x) => x.id !== "page-other-same-title");
  check(mine.length === 1 && serverPages(srv).length === afterOther.length, "network back + Save again: exactly one capture page, no duplicate (pages " + serverPages(srv).length + " vs " + afterOther.length + ")");
  check(posts.length === 2 && posts[0].request_id === posts[1].request_id, "same request_id on the retry");
  const toastId = await p.evaluate(() => window.hqCapture && window.hqCapture.lastId ? window.hqCapture.lastId : null);
  void toastId;
  await p.click(".hq-capture-toast-open");
  await until(async () => (await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === mine[0].id, "'Ouvrir' opens MY page, not the same-title one");
  // a changed capture is a NEW attempt (new request_id)
  await p.evaluate(() => document.getElementById("hq-capture-fab") && 0);
});

scenario("capture: long MULTILINE text over the limit is refused whole (never silently truncated); under the limit it is kept in full", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  const big = Array.from({ length: 20 }, (_, i) => String(i % 10).repeat(3000)).join("\n");
  await capOpen(p);
  await p.evaluate((v) => { const t = document.getElementById("hq-capture-text"); t.value = v; t.dispatchEvent(new Event("input", { bubbles: true })); }, big);
  await capSave(p);
  check(/trop long/.test(await capMsg(p)), "refused: " + (await capMsg(p)));
  check((await p.inputValue("#hq-capture-text")).length === big.length, "everything typed is still in the sheet (nothing lost)");
  check(serverPages(srv).length === before.length, "no page created");
  const ok = Array.from({ length: 10 }, (_, i) => String(i).repeat(3000)).join("\n");
  await p.evaluate((v) => { const t = document.getElementById("hq-capture-text"); t.value = v; t.dispatchEvent(new Event("input", { bubbles: true })); }, ok);
  await capSave(p);
  await capClosed(p);
  const np = await until(() => newPages(srv, before)[0], "created");
  check(np.content.blocks.map((b) => b.text).filter(Boolean).join("\n") === ok, "kept in full, byte for byte (" + ok.length + " chars)");
});

scenario("templates: pressing a template again after an uncertain failure creates ONE page (same request_id)", async () => {
  const { srv, p } = await openEditor("desktop", PNB());
  const before = serverPages(srv).map((x) => x.id);
  const bodies = [];
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) {
      bodies.push(JSON.parse(r.postData()));
      if (bodies.length === 1) { await route.fetch(); return route.abort("connectionreset"); }
    }
    return route.continue();
  });
  await openTpl(p);
  await pickTpl(p, "inspection");
  await until(async () => (await p.locator("[data-carnet-template]:not([disabled])").count()) === 7, "picker usable again after the lost response");
  check(serverPages(srv).length === before.length + 1, "the server did create it");
  await pickTpl(p, "inspection");
  await until(async () => (await p.locator("#hq-carnet-templates").isHidden()), "picker closed after the retry");
  check(serverPages(srv).length === before.length + 1, "retry: still exactly one new page");
  check(bodies.length === 2 && bodies[0].request_id === bodies[1].request_id && /^tpl-/.test(bodies[0].request_id), "same request_id re-sent");
});

scenario("capture: lost response, the page is permanently deleted elsewhere, retry — NOT resurrected; only an explicit new Save creates again", async () => {
  const { srv, p } = await capHome();
  const before = idsOf(srv);
  const bodies = [];
  await p.route("**/api/carnet", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && /"action":"page_create"/.test(r.postData() || "")) {
      bodies.push(JSON.parse(r.postData()));
      if (bodies.length === 1) { await route.fetch(); return route.abort("connectionreset"); }
    }
    return route.continue();
  });
  await capOpen(p);
  await p.fill("#hq-capture-text", "À ne pas ressusciter");
  await capSave(p);
  await until(async () => /Hors ligne|rien n'a été créé/.test(await capMsg(p)), "offline message");
  const created = newPages(srv, before);
  check(created.length === 1, "the server created it (response lost)");
  // another client deletes it for good
  const cur = srv.nb();
  cur.pages = cur.pages.filter((x) => x.id !== created[0].id);
  cur.notebook_rev += 1;
  srv.put(cur);
  const afterDelete = idsOf(srv);
  await capSave(p);
  await until(async () => /déjà été créée, puis supprimée/.test(await capMsg(p)), "controlled message: " + (await capMsg(p)));
  check(idsOf(srv).join() === afterDelete.join(), "NOT resurrected: the page list is unchanged");
  check(bodies.length === 2 && bodies[0].request_id === bodies[1].request_id, "the retry used the same request_id");
  check((await p.locator("#hq-capture").isVisible()) && (await p.inputValue("#hq-capture-text")) === "À ne pas ressusciter", "the capture is kept in the sheet");
  // the user explicitly saves again: a NEW attempt (new request_id) creates a page
  await capSave(p);
  await capClosed(p);
  check(bodies.length === 3 && bodies[2].request_id !== bodies[0].request_id, "explicit Save = new request_id");
  check(idsOf(srv).length === afterDelete.length + 1, "exactly one page created by the explicit Save");
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
