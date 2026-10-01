// Carnet Stage 06 browser checks (Node Playwright, Chromium): camera/photos/files input, browser-side resize +
// re-encode, upload, inline image blocks, resize/caption tools, stale-tool and two-client rules, reload/draft,
// find/replace, export, print, backup-relevant disk state, phone/tablet layout and large-image behaviour —
// on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs).
//
//   node tests/visual_carnet_media_playwright.mjs
//
// Engines: Chromium only (desktop + touch/mobile device EMULATION for iPad/iPhone-sized profiles). There is NO
// WebKit build in this environment: WebKit/iOS behaviour (camera capture, HEIC -> JPEG conversion by the OS file
// picker, canvas limits, HEIC) is UNVERIFIED and this file says so in its summary. Skips (exit 0) when Playwright or
// Chromium is unavailable. Never touches the live root or a real PIN; run it from a disposable copy of the checkout.
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
const imgs = (srv, id) => srv.pg(id).content.blocks.filter((b) => b.type === "image");

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

// ---------------------------------------------------------------- scenarios
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

const textNb = () => notebook([page("page-a", 1, [para("one"), para("two"), para("three")]), page("page-b", 1, [para("other page")])]);

scenario("insert via Files: resized to <= 2560, EXIF-free, stored confined, binary absent from notebook JSON", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const big = await makeImage(p, { w: 4000, h: 3000, type: "image/jpeg" });
  check(big.length > 50000, "source is a real JPEG (" + big.length + " bytes)");
  await select(p, 5, 5); // inside "two"
  await pickViaButton(p, "files", jpg(big));
  await seeImage(p);
  check((await p.locator("#hq-carnet-image-tools").isVisible()), "selecting the new image reveals the tools");
  const [nw, nh] = await natural(p);
  check(nw === 2560 && nh === 1920, `optimised to ${nw}x${nh} (long side 2560, ratio 4:3)`);
  await saved(p);
  const blocks = srv.pg("page-a").content.blocks;
  check(blocks.map((b) => b.type).join() === "paragraph,paragraph,image,paragraph", "image inserted after the caret line: " + blocks.map((b) => b.type));
  check(blocks.map((b) => b.text).join("|") === "one|two||three", "text untouched around the image: " + blocks.map((b) => b.text));
  const a = blocks[2].asset;
  check(a.id.startsWith("asset-") && a.mime === "image/jpeg" && a.w === 2560 && a.h === 1920 && a.width === 100 && a.layout === "inline" && a.caption === "", "bounded metadata only");
  const files = srv.assets();
  check(files.length === 1 && files[0] === a.id + ".jpg", "one generated asset file: " + files);
  const bytes = srv.asset(files[0]);
  const d = dimsOf(bytes);
  check(d && d.w === 2560 && d.h === 1920 && !hasExif(bytes), "stored file: real dimensions, no EXIF");
  check(bytes.length < 12 * 1024 * 1024, "within the per-file cap (" + bytes.length + ")");
  const raw = readFileSync(srv.nbPath);
  check(!raw.includes(Buffer.from([0xff, 0xd8])) && !raw.includes("base64") && !raw.includes(srv.root), "no binary, no base64, no server path in notebook.json");
  check(!existsSync(path.join(srv.adir, "..", "assets", ".tmp")) && srv.tmps().length === 0, "no temp residue");
  await ctx.close();
});

scenario("EXIF orientation is baked into the pixels; the uploaded JPEG carries no orientation", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const base = await makeImage(p, { w: 600, h: 400, type: "image/jpeg" });
  for (const orientation of [1, 3, 6, 8]) {
    const src = orientation === 1 ? base : withOrientation(base, orientation);
    const known = new Set(srv.assets());
    const before = known.size;
    await select(p, 0, 0);
    await pickViaButton(p, "files", jpg(src, `o${orientation}.jpg`));
    await until(() => srv.assets().length === before + 1, "orientation " + orientation + " uploaded");
    const file = srv.assets().find((n) => !known.has(n));
    const bytes = srv.asset(file);
    const d = dimsOf(bytes);
    const swapped = orientation === 6 || orientation === 8;
    check(swapped ? d.w === 400 && d.h === 600 : d.w === 600 && d.h === 400, `orientation ${orientation}: stored ${d.w}x${d.h} (rotation baked in)`);
    check(!hasExif(bytes), `orientation ${orientation}: stored JPEG has no EXIF at all`);
    await until(async () => (await figs(p).count()) === before + 1, "rendered");
  }
  await seeImage(p, 4);
  await saved(p);
  await ctx.close();
});

scenario("PNG stays PNG, WebP and JPEG inputs accepted, other formats refused with a clear message, nothing stored", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const pngBuf = await makeImage(p, { w: 900, h: 600, type: "image/png" });
  await pickViaButton(p, "photos", png(pngBuf));
  await until(() => srv.assets().length === 1, "png uploaded");
  check(srv.assets()[0].endsWith(".png") && dimsOf(srv.asset(srv.assets()[0])).mime === "image/png", "PNG source stays PNG");
  const webp = await makeImage(p, { w: 500, h: 300, type: "image/webp", quality: 0.8 });
  check(webp.toString("latin1", 8, 12) === "WEBP", "chromium produced a real WebP source");
  await pickViaButton(p, "camera", { name: "x.webp", mimeType: "image/webp", buffer: webp });
  await until(() => srv.assets().length === 2, "webp source uploaded");
  const kinds = srv.assets().map((n) => dimsOf(srv.asset(n)).mime).sort();
  check(kinds.every((k) => ["image/png", "image/webp", "image/jpeg"].includes(k)), "stored types are all allowed: " + kinds);
  // refused inputs never reach the server
  const before = srv.assets().length;
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await pickViaButton(p, "files", { name: "anim.gif", mimeType: "image/gif", buffer: gif });
  await until(async () => /Format non pris en charge/.test(await msg(p)), "GIF refused with a clear message");
  await pickViaButton(p, "files", { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image at all, just text") });
  await until(async () => /Format non pris en charge/.test(await msg(p)), "spoofed extension/MIME (text named .jpg) refused from its bytes");
  await pickViaButton(p, "files", { name: "live.heic", mimeType: "image/heic", buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]) });
  await until(async () => /HEIC n'est pas pris en charge/.test(await msg(p)), "HEIC is refused explicitly (not supported)");
  const huge = { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(16 * 1024 * 1024 + 1, 1) };
  await pickViaButton(p, "files", huge);
  await until(async () => /trop volumineuse/.test(await msg(p)), "source over 16 MiB refused before decoding");
  // header says 9000x9000 (81 Mpx): refused from the header, never decoded
  const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0x23, 0x28, 0, 0, 0x23, 0x28, 8, 2, 0, 0, 0]), Buffer.alloc(200)]);
  await pickViaButton(p, "files", { name: "bomb.png", mimeType: "image/png", buffer: bomb });
  await until(async () => /trop grande/.test(await msg(p)), "decompression-bomb header (81 Mpx) refused before decoding");
  check(srv.assets().length === before, "refused inputs stored nothing");
  await ctx.close();
});

scenario("insert position: middle, beginning, end, empty page; always a place to keep typing", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const img = jpg(await makeImage(p, { w: 400, h: 300 }));
  // beginning: caret at offset 0 of a non-empty line -> BEFORE it
  await select(p, 0, 0);
  await pickViaButton(p, "files", img);
  await seeImage(p, 1);
  await saved(p);
  check(types(srv, "page-a").join() === "image,paragraph,paragraph,paragraph", "beginning: " + types(srv, "page-a"));
  // middle: after the caret line (caret inside "two")
  const text = await p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
  const at = text.indexOf("two") + 1;
  await select(p, at, at);
  await pickViaButton(p, "files", img);
  await seeImage(p, 2);
  await saved(p);
  check(types(srv, "page-a").join() === "image,paragraph,paragraph,image,paragraph", "middle: " + types(srv, "page-a") + " | " + srv.pg("page-a").content.blocks.map((b) => b.text).join("/"));
  // end: caret at the end of the last line -> after it, plus a trailing paragraph
  const t2 = await p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
  await select(p, t2.length, t2.length);
  await pickViaButton(p, "files", img);
  await seeImage(p, 3);
  await saved(p);
  const last = types(srv, "page-a");
  check(last[last.length - 1] === "paragraph" && last[last.length - 2] === "image", "end: image then a typing line: " + last);
  // text order intact
  check(srv.pg("page-a").content.blocks.filter((b) => b.type !== "image").map((b) => b.text).join("|") === "one|two|three|", "text lines untouched and in order: " + srv.pg("page-a").content.blocks.map((b) => b.text).join("|"));
  // empty page
  await p.click("#btn-carnet-new");
  await until(() => p.evaluate(() => document.querySelector("#hq-carnet-editor").value === ""), "new empty page");
  await pickViaButton(p, "files", img);
  await seeImage(p, 1);
  await saved(p);
  const nb = srv.nb();
  const fresh = nb.pages.find((pg) => pg.content.blocks.some((b) => b.type === "image") && pg.id !== "page-a");
  check(fresh.content.blocks.map((b) => b.type).join() === "image,paragraph", "empty page: image then an empty line to type in: " + fresh.content.blocks.map((b) => b.type));
  // typing after the image works and does not disturb it
  await p.click("#hq-carnet-editor [data-line-type='paragraph']");
  await p.keyboard.type("below the picture");
  await saved(p);
  const after = srv.pg(fresh.id).content.blocks;
  check(after[0].type === "image" && after[1].text === "below the picture", "typing below the image persists");
  await ctx.close();
});

scenario("resize 30..100 keeps the aspect ratio, survives reload; caption add/edit/remove", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 1200, h: 800 })));
  await seeImage(p);
  const box = () => p.evaluate(() => { const f = document.querySelector("#hq-carnet-editor figure"); const i = f.querySelector("img"); const ed = document.querySelector("#hq-carnet-editor"); const cs = getComputedStyle(ed); const inner = ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); const r = i.getBoundingClientRect(); return { w: r.width, h: r.height, inner, ratio: r.width / r.height }; });
  const setWidth = (v) => p.evaluate((v) => { const r = document.getElementById("carnet-image-width"); r.value = String(v); r.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  for (const w of [100, 30, 55, 100]) {
    await setWidth(w);
    await until(async () => { const b = await box(); return Math.abs(b.w / b.inner * 100 - w) < 2.5; }, `width ${w}% of the content width`);
    const b = await box();
    check(Math.abs(b.ratio - 1.5) < 0.02, `aspect ratio preserved at ${w}% (${b.ratio.toFixed(3)})`);
  }
  await setWidth(30);
  await saved(p);
  check(imgs(srv, "page-a")[0].asset.width === 30, "minimum persisted");
  const range = await p.evaluate(() => { const r = document.getElementById("carnet-image-width"); r.value = "5"; const lo = r.value; r.value = "500"; return [lo, r.value, r.min, r.max]; });
  check(range[0] === "30" && range[1] === "100" && range[2] === "30" && range[3] === "100", "the control itself clamps to 30..100: " + range);
  // caption: add, edit, remove
  const cap = "#carnet-image-caption";
  await p.fill(cap, "Vue de face Ø12");
  await until(async () => (await p.locator("#hq-carnet-editor figcaption").textContent()) === "Vue de face Ø12", "caption shown under the image");
  await saved(p);
  check(imgs(srv, "page-a")[0].asset.caption === "Vue de face Ø12", "caption persisted");
  await p.fill(cap, "Vue <b>x</b> & \"q\"");
  await saved(p);
  check(imgs(srv, "page-a")[0].asset.caption === 'Vue <b>x</b> & "q"', "caption is plain text (no markup interpretation)");
  check(await p.locator("#hq-carnet-editor figcaption b").count() === 0, "no element was created from caption text");
  const imgSrcBefore = await p.evaluate(() => document.querySelector("#hq-carnet-editor img").src);
  await p.fill(cap, "a".repeat(400));
  check((await p.inputValue(cap)).length === 300, "caption bounded to 300 characters by the control");
  check(await p.evaluate((s) => document.querySelector("#hq-carnet-editor img").src === s, imgSrcBefore), "editing the caption does not reload the picture element");
  await p.fill(cap, "");
  await saved(p);
  check(imgs(srv, "page-a")[0].asset.caption === "" && (await p.locator("#hq-carnet-editor figcaption").count()) === 0, "caption removed");
  await p.fill(cap, "final");
  await saved(p);
  // reload: everything comes back
  await p.reload();
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  const again = await p.evaluate(() => { const f = document.querySelector("#hq-carnet-editor figure"); return [f.style.width, f.querySelector("figcaption").textContent]; });
  check(again[0] === "30%" && again[1] === "final", "reload: width and caption restored: " + again);
  await ctx.close();
});

scenario("autosave, draft recovery while the save is blocked, then the draft is delivered", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 800, h: 600 })));
  await seeImage(p);
  await saved(p, "insert autosaved");
  // block the save endpoint; edit the caption; reload -> the draft must bring the change back
  await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await p.fill("#carnet-image-caption", "only in the draft");
  await p.evaluate(() => window.hqCarnetDebug().core.pages.length);
  await sleep(300);
  check(imgs(srv, "page-a")[0].asset.caption === "", "server has not seen the caption (saves blocked)");
  await p.reload();
  await ctx.unroute("**/api/carnet");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  await until(async () => (await p.locator("#hq-carnet-editor figcaption").count()) === 1 && (await p.locator("#hq-carnet-editor figcaption").textContent()) === "only in the draft", "draft recovered (caption back after reload)");
  await saved(p, "recovered draft delivered");
  check(imgs(srv, "page-a")[0].asset.caption === "only in the draft", "delivered to the server");
  await ctx.close();
});

scenario("two clients: conflicts are explicit; stale tools are invalidated, never applied to the wrong object", async () => {
  const srv = await server(textNb());
  const ctxA = await context(srv);
  const A = await openPage(ctxA, srv);
  await pickViaButton(A, "files", jpg(await makeImage(A, { w: 800, h: 600 })));
  await seeImage(A);
  await A.fill("#carnet-image-caption", "from A");
  await saved(A);
  const ctxB = await context(srv);
  const B = await openPage(ctxB, srv);
  await seeImage(B);
  // --- B opens the tools; A deletes the image; B's tools must close on its own, not retarget
  await B.locator("#hq-carnet-editor figure").click();
  await until(() => B.locator("#hq-carnet-image-tools").isVisible(), "B: tools open");
  const assetId = imgs(srv, "page-a")[0].asset.id;
  await A.locator("#hq-carnet-editor figure").click();
  await A.click("#btn-carnet-image-remove");
  await A.click("#btn-carnet-image-remove");
  await saved(A, "A removed the image");
  check(imgs(srv, "page-a").length === 0 && srv.assets().length === 1, "server: block gone, asset file kept (no deletion in Stage 06)");
  await until(async () => !(await B.locator("#hq-carnet-image-tools").isVisible()) && (await figs(B).count()) === 0, "B: poll adopted the deletion and closed the stale tools", 15000);
  check(imgs(srv, "page-a").length === 0, "B's stale tools did not resurrect the image");
  // --- same asset, other client changes the caption while B edits the width: explicit conflict
  await A.keyboard.press("Control+z").catch(() => {});
  srv.put((() => { const nb = srv.nb(); nb.pages[0].content.blocks.splice(1, 0, { id: "block-img1", type: "image", text: "", marks: [], asset: { id: assetId, mime: "image/jpeg", w: 800, h: 600, width: 100, layout: "inline", caption: "seed" } }); nb.pages[0].rev += 1; return nb; })());
  await A.reload(); await A.locator('.bottom-nav [data-nav="carnet"]').click();
  await B.reload(); await B.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(A); await seeImage(B);
  await A.locator("#hq-carnet-editor figure").click();
  await B.locator("#hq-carnet-editor figure").click();
  await A.fill("#carnet-image-caption", "A caption");
  await saved(A, "A saved its caption");
  await B.evaluate(() => { const r = document.getElementById("carnet-image-width"); r.value = "40"; r.dispatchEvent(new Event("input", { bubbles: true })); });
  await until(() => conflict(B), "B: explicit conflict (never a silent last-write-wins)", 15000);
  check(await B.locator("#hq-carnet-conflict").isVisible(), "B: conflict banner shown");
  check(imgs(srv, "page-a")[0].asset.caption === "A caption" && imgs(srv, "page-a")[0].asset.width === 100, "server keeps A's version");
  check((await B.locator("#hq-carnet-editor figure").evaluate((f) => f.style.width)) === "40%", "B's local change is kept on B");
  await ctxA.close(); await ctxB.close();
});

scenario("page switch while the upload is in flight: the image is NOT inserted into whatever page is current", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  let release;
  const gate = new Promise((r) => { release = r; });
  await ctx.route("**/api/carnet/asset", async (route) => { await gate; await route.continue(); });
  const pageBefore = await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await select(p, 2, 2);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 600, h: 400 })));
  await until(async () => /Téléversement/.test(await msg(p)), "upload started (held at the network)");
  check(await p.locator('[data-carnet-image-source="files"]').isDisabled(), "a second pick is disabled while busy (double-submit guard)");
  await p.click("#btn-carnet-next");
  await until(() => p.evaluate((b) => document.querySelector("#hq-carnet-editor").dataset.pageId !== b, pageBefore), "page switched while uploading");
  release();
  await until(async () => srv.assets().length === 1, "the upload finished");
  await until(async () => /La page a changé/.test(await msg(p)) || /La page a changé/.test(await flash(p)), "the user is told the image was not inserted");
  await sleep(400);
  check(imgs(srv, "page-a").length === 0 && imgs(srv, "page-b").length === 0, "no page received the image");
  check((await figs(p).count()) === 0, "current page shows no image");
  await ctx.unroute("**/api/carnet/asset");
  // the anchor line deleted while uploading -> refused too
  const ids = await p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  check(!!ids, "still on a valid page");
  await ctx.close();
});

scenario("anchor line deleted while the upload is in flight: the image is refused, nothing lands elsewhere", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  let release;
  const gate = new Promise((r) => { release = r; });
  await ctx.route("**/api/carnet/asset", async (route) => { await gate; await route.continue(); });
  await select(p, 5, 5); // inside "two": the image would go right after it
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 300, h: 200 })));
  await until(async () => /Téléversement/.test(await msg(p)), "upload held at the network");
  // meanwhile the user deletes the whole "two" line (range from the end of "one" to the end of "two")
  await select(p, 3, 7);
  await p.keyboard.press("Delete");
  await until(() => p.evaluate(() => document.querySelector("#hq-carnet-editor").value === "one\nthree"), "the anchor line is gone");
  release();
  await until(async () => srv.assets().length === 1, "the upload finished on the server");
  await until(async () => /emplacement a changé/.test(await msg(p)), "the user is told the location changed");
  await saved(p);
  check(imgs(srv, "page-a").length === 0 && (await figs(p).count()) === 0, "no image block was created");
  check(srv.pg("page-a").content.blocks.map((b) => b.text).join("|") === "one|three", "the user's own edit is intact");
  await ctx.unroute("**/api/carnet/asset");
  await ctx.close();
});

scenario("duplicate submit: the file input fires twice, only ONE asset is created; replace keeps block identity", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  let posts = 0;
  p.on("request", (r) => { if (r.url().endsWith("/api/carnet/asset") && r.method() === "POST") posts += 1; });
  const img = jpg(await makeImage(p, { w: 500, h: 400 }));
  await pickViaButton(p, "files", img);
  const input = p.locator('input[data-carnet-image-input="files"]');
  await input.setInputFiles(img); // the same choice delivered twice (double tap): no second origin -> refused
  await seeImage(p);
  await saved(p);
  check(posts === 1 && srv.assets().length === 1, `one upload for a double submit (posts=${posts}, files=${srv.assets().length})`);
  check(imgs(srv, "page-a").length === 1, "one image block");
  // replace
  const blockId = imgs(srv, "page-a")[0].id;
  await p.fill("#carnet-image-caption", "keep me");
  await p.evaluate(() => { const r = document.getElementById("carnet-image-width"); r.value = "45"; r.dispatchEvent(new Event("input", { bubbles: true })); });
  await saved(p);
  const chooser = p.waitForEvent("filechooser");
  await p.click("#btn-carnet-image-replace");
  (await chooser).setFiles(png(await makeImage(p, { w: 300, h: 600, type: "image/png" })));
  await until(() => srv.assets().length === 2, "replacement uploaded");
  await until(() => imgs(srv, "page-a")[0] && imgs(srv, "page-a")[0].asset.mime === "image/png", "the replacement was saved into the same block");
  await saved(p);
  const after = imgs(srv, "page-a");
  check(after.length === 1 && after[0].id === blockId && after[0].asset.mime === "image/png" && after[0].asset.caption === "keep me" && after[0].asset.width === 45, "same block id, new asset, caption and width kept");
  check(after[0].asset.w === 300 && after[0].asset.h === 600, "new dimensions recorded");
  check(srv.assets().length === 2, "the replaced asset stays on disk (orphan counted by the quota; no deletion API)");
  await ctx.close();
});

scenario("remove is deliberate (two steps), Backspace/Delete next to an image select it first, read-only pages", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 500, h: 400 })));
  await seeImage(p);
  await saved(p);
  await p.click("#btn-carnet-image-done");
  await until(async () => !(await p.locator("#hq-carnet-image-tools").isVisible()), "tools closed");
  // caret at the start of "one" (below the image): Backspace selects the image instead of deleting it
  await p.evaluate(() => { const ed = document.querySelector("#hq-carnet-editor"); ed.focus(); const t = ed.children[1].firstChild; const r = document.createRange(); r.setStart(t, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.keyboard.press("Backspace");
  await until(() => p.locator("#hq-carnet-image-tools").isVisible(), "Backspace next to the image selected it");
  check((await figs(p).count()) === 1 && imgs(srv, "page-a").length === 1, "nothing was deleted by the first Backspace");
  await p.click("#btn-carnet-image-remove");
  check((await p.textContent("#btn-carnet-image-remove")) === "Confirmer le retrait" && (await figs(p).count()) === 1, "first click only asks for confirmation");
  await p.click("#btn-carnet-image-remove");
  await until(async () => (await figs(p).count()) === 0, "second click removes the block");
  await saved(p);
  check(imgs(srv, "page-a").length === 0 && srv.assets().length === 1, "block gone from the page; the file stays stored");
  // keyboard: focus the figure and press Enter then Delete twice
  await select(p, 0, 0);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 500, h: 400 })));
  await seeImage(p);
  await p.click("#btn-carnet-image-done");
  await p.locator("#hq-carnet-editor figure").focus();
  await p.keyboard.press("Enter");
  await until(() => p.locator("#hq-carnet-image-tools").isVisible(), "Enter on a focused figure opens the tools");
  // trashed page: read-only, images still shown, tools unavailable
  await p.click("#btn-carnet-image-done");
  await saved(p);
  await openTools(p);
  await p.click("[data-carnet-trash]");
  await until(async () => (await p.locator("#hq-carnet-trashed").isVisible()) || (await p.locator("#hq-carnet-undo").isVisible()), "page trashed");
  // open the trashed page from the library (Corbeille filter): it is read-only but still shows its picture
  const libVisible = await p.evaluate(() => { const l = document.getElementById("hq-carnet-library"); return !!l && !l.hidden && getComputedStyle(l).display !== "none" && l.getBoundingClientRect().width > 0; });
  if (!libVisible) await p.click("#btn-carnet-library");
  await p.locator('[data-carnet-filter="trash"]').click({ timeout: 8000 });
  await p.locator("#carnet-library-list [data-carnet-page-id]").first().click({ timeout: 8000 });
  await until(() => p.locator("#hq-carnet-trashed").isVisible(), "trashed page opened read-only");
  await seeImage(p);
  check(await p.evaluate(() => document.querySelector("#hq-carnet-editor").getAttribute("contenteditable") !== "true"), "the editor is read-only");
  await p.locator("#hq-carnet-editor figure").click();
  await sleep(250);
  check(!(await p.locator("#hq-carnet-image-tools").isVisible()), "read-only: clicking the image does not open the tools");
  check(await p.locator("#btn-carnet-image").isDisabled(), "read-only: the insert control is disabled");
  await p.locator("#hq-carnet-editor figure").focus();
  await p.keyboard.press("Delete");
  await sleep(250);
  check((await figs(p).count()) === 1, "read-only: Delete on the picture removes nothing");
  await ctx.close();
});

scenario("tools follow the truth: another client's caption change refreshes them, a replaced asset closes them", async () => {
  const srv = await server(textNb());
  const ctxA = await context(srv);
  const A = await openPage(ctxA, srv);
  await pickViaButton(A, "files", jpg(await makeImage(A, { w: 500, h: 400 })));
  await seeImage(A);
  await A.click("#btn-carnet-image-done");
  await saved(A);
  const ctxB = await context(srv);
  const B = await openPage(ctxB, srv);
  await seeImage(B);
  await B.locator("#hq-carnet-editor figure").click();
  await until(() => B.locator("#hq-carnet-image-tools").isVisible(), "B tools open");
  const blockId = imgs(srv, "page-a")[0].id;
  // A: caption change -> B's tools show it (and stay open, bound to the same block/asset)
  await A.locator("#hq-carnet-editor figure").click();
  await A.fill("#carnet-image-caption", "changed by A");
  await saved(A);
  await until(async () => (await B.inputValue("#carnet-image-caption")) === "changed by A", "B: the caption input now shows the server's value", 15000);
  check(await B.locator("#hq-carnet-image-tools").isVisible(), "B: tools stay open for the same object");
  check(/ailleurs/.test(await B.textContent("#carnet-image-tools-msg")), "B: told that it changed elsewhere");
  // B edits on top of the refreshed state: applied to the SAME block, one clean save
  await B.fill("#carnet-image-caption", "then B");
  await saved(B);
  check(imgs(srv, "page-a")[0].asset.caption === "then B" && imgs(srv, "page-a")[0].id === blockId, "B's edit landed on the same block");
  // A replaces the asset -> B's bound asset no longer exists in that block: tools close
  await until(async () => (await A.inputValue("#carnet-image-caption")) === "then B", "A: sees B's caption", 15000);
  const chooser = A.waitForEvent("filechooser");
  await A.click("#btn-carnet-image-replace");
  (await chooser).setFiles(png(await makeImage(A, { w: 300, h: 300, type: "image/png" })));
  await until(() => srv.assets().length === 2, "A: replacement uploaded");
  await saved(A);
  await until(async () => !(await B.locator("#hq-carnet-image-tools").isVisible()), "B: tools closed, the asset they were bound to was replaced", 15000);
  await until(() => B.evaluate(() => document.querySelector("#hq-carnet-editor img").src.includes("asset-")), "B shows an image");
  const shown = await B.evaluate(() => document.querySelector("#hq-carnet-editor [data-carnet-asset]").getAttribute("data-carnet-asset"));
  check(shown === imgs(srv, "page-a")[0].asset.id, "B now shows the replacement asset");
  await ctxA.close(); await ctxB.close();
});

scenario("find/replace leaves image blocks intact; citation line next to an image survives caption edits", async () => {
  const asset = { id: "asset-" + "d".repeat(24), mime: "image/png", w: 40, h: 30, width: 50, layout: "inline", caption: "intact" };
  const cite = { type: "citation", start: 4, end: 14, cite: { src: "srce-aaaa", loc: { kind: "page", text: "417" }, pdf: null, ok: false, snap: { title: "Shigley" }, from: null } };
  const nb = notebook([page("page-a", 1, [para("See Shigley p.417 texte", { marks: [cite] }), { id: "block-i", type: "image", text: "", marks: [], asset }, para("texte after")])]);
  const srv = await server(nb);
  // the asset file must exist for the page to save: upload through the real endpoint first
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const real = jpg(await makeImage(p, { w: 40, h: 30 }));
  const res = await p.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const r = await fetch("/api/carnet/asset", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-Carnet-Mime": "image/jpeg" }, body: bin }); return r.json(); }, real.buffer ? real.buffer.toString("base64") : real.toString("base64"));
  check(res.ok && res.asset.id.startsWith("asset-"), "asset uploaded through the real endpoint");
  const nb2 = srv.nb();
  nb2.pages[0].content.blocks[1].asset = Object.assign({}, res.asset, { width: 50, layout: "inline", caption: "intact" });
  delete nb2.pages[0].content.blocks[1].asset.bytes;
  await p.evaluate(() => 0);
  srv.put(nb2);
  await p.reload(); await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await seeImage(p);
  await openTools(p);
  await p.click("#btn-carnet-find");
  await p.waitForSelector("#hq-carnet-find", { state: "visible" }).catch(() => {});
  const findInput = p.locator("#hq-carnet-find input[type=text], #hq-carnet-find-q, #hq-carnet-find input").first();
  await findInput.fill("texte");
  const rep = p.locator("#hq-carnet-replace, #hq-carnet-find-r, #hq-carnet-find input").nth(1);
  await rep.fill("TXT");
  await p.click("#btn-carnet-replace-all");
  await saved(p);
  const blocks = srv.pg("page-a").content.blocks;
  check(blocks[0].text === "See Shigley p.417 TXT" && blocks[2].text === "TXT after", "replace-all changed the text lines: " + blocks.map((b) => b.text));
  check(blocks[1].type === "image" && blocks[1].asset.caption === "intact" && blocks[1].asset.id === res.asset.id && blocks[1].id === "block-i", "the image block is identical (id, asset, caption)");
  check(blocks[0].marks.some((m) => m.type === "citation"), "the citation next to the image survived");
  // caption edit keeps the citation
  await p.locator("#hq-carnet-editor figure").click();
  await p.fill("#carnet-image-caption", "new caption");
  await saved(p);
  const b2 = srv.pg("page-a").content.blocks;
  check(b2[1].asset.caption === "new caption" && b2[0].marks.some((m) => m.type === "citation"), "caption edit leaves the citation untouched");
  await ctx.close();
});

scenario("export: Markdown package with relative assets, TXT labels, print layout keeps ratio and caption", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 4, 4);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 1200, h: 600 })));
  await seeImage(p);
  await p.fill("#carnet-image-caption", "Coupe A-A");
  await saved(p);
  // server copy (packaged)
  await openTools(p);
  await p.click("#btn-carnet-export");
  check(await p.locator("#carnet-export-images").isVisible(), "the export panel explains how images are exported");
  await p.click("#btn-carnet-export-copy");
  await p.fill("#hq-carnet-export-name", "note-images");
  await p.selectOption("#hq-carnet-export-format", "md");
  await p.click("#btn-carnet-export-save");
  await until(() => srv.files("Inbox").includes("note-images.md"), "markdown copy written");
  const md = srv.read("Inbox/note-images.md");
  check(/!\[Coupe A-A\]\(note-images\.assets\/figure-01\.jpg\)/.test(md) && md.includes("*Coupe A-A*"), "relative image link + caption: " + JSON.stringify(md.slice(0, 120)));
  check(!md.includes(srv.root) && !/\]\((\/|[A-Za-z]:|file:)/.test(md), "no absolute/local path in the Markdown");
  check(srv.files("Inbox/note-images.assets").join() === "figure-01.jpg", "package folder holds only the referenced image");
  check(dimsOf(srv.readBin("Inbox/note-images.assets/figure-01.jpg")).w === 1200, "packaged image is the stored one");
  await p.selectOption("#hq-carnet-export-format", "txt");
  await p.fill("#hq-carnet-export-name", "note-images");
  await p.click("#btn-carnet-export-save");
  await until(() => srv.files("Inbox").includes("note-images.txt"), "txt copy written");
  check(srv.read("Inbox/note-images.txt").includes("[Image : Coupe A-A]") && srv.files("Inbox").filter((n) => n.startsWith("note-images")).length === 3, "TXT has a caption label and no binary");
  // print path (stub window.print; measure the print snapshot under print media)
  await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  await p.click("#btn-carnet-export-print");
  await until(() => p.evaluate(() => window.__printed === 1), "print waited for the image and was invoked once");
  await p.emulateMedia({ media: "print" });
  const lay = await p.evaluate(() => {
    const host = document.getElementById("hq-carnet-print");
    const fig = host.querySelector("figure"); const img = fig.querySelector("img"); const cap = fig.querySelector("figcaption");
    const r = img.getBoundingClientRect(); const c = cap.getBoundingClientRect(); const f = fig.getBoundingClientRect();
    return { w: r.width, h: r.height, natural: [img.naturalWidth, img.naturalHeight], capBelow: c.top >= r.bottom - 1, capInside: c.bottom <= f.bottom + 1, text: cap.textContent, src: img.getAttribute("src"), complete: img.complete };
  });
  check(lay.complete && lay.text === "Coupe A-A" && lay.capBelow && lay.capInside, "print: caption stays below and inside the same figure");
  check(Math.abs(lay.w / lay.h - lay.natural[0] / lay.natural[1]) < 0.02, "print: aspect ratio preserved (" + (lay.w / lay.h).toFixed(3) + " vs " + (lay.natural[0] / lay.natural[1]).toFixed(3) + ")");
  check(lay.src.startsWith("/api/carnet/asset/asset-") && !lay.src.includes(":\\"), "print: same-origin asset URL, no local path");
  const pdf = await p.pdf({ format: "A4", printBackground: true });
  check(pdf.length > 1000 && pdf.includes("/Subtype /Image") || pdf.includes("/Subtype/Image"), "PDF contains the image object (" + pdf.length + " bytes)");
  await p.emulateMedia({ media: "screen" });
  await ctx.close();
});

for (const profile of ["ipad", "iphone"]) {
  scenario(`layout on ${profile} (Chromium device emulation; real WebKit/iOS UNVERIFIED): no overflow, tap targets, tools usable`, async () => {
    const srv = await server(textNb());
    const ctx = await context(srv, profile);
    const p = await openPage(ctx, srv);
    await pickViaButton(p, "photos", jpg(await makeImage(p, { w: 3000, h: 2000 })));
    await seeImage(p);
    const m = await p.evaluate(() => {
      const fig = document.querySelector("#hq-carnet-editor figure").getBoundingClientRect();
      const ed = document.querySelector("#hq-carnet-editor").getBoundingClientRect();
      const small = [...document.querySelectorAll("#hq-carnet-image-tools button, #hq-carnet-image-tools input")].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect()).filter((r) => r.height < 43.5);
      return { docW: document.documentElement.scrollWidth, inner: innerWidth, figRight: fig.right, edRight: ed.right, small: small.length, tools: !!document.querySelector("#hq-carnet-image-tools:not([hidden])") };
    });
    check(m.docW <= m.inner + 1, `${profile}: no horizontal page scroll (${m.docW} <= ${m.inner})`);
    check(m.figRight <= m.edRight + 1, `${profile}: the image stays inside the paper`);
    check(m.tools && m.small === 0, `${profile}: tools visible with >=44px tap targets (small=${m.small})`);
    await p.fill("#carnet-image-caption", "tap caption");
    await saved(p);
    check(imgs(srv, "page-a")[0].asset.caption === "tap caption", `${profile}: caption saved from the touch layout`);
    await ctx.close();
  });
}

scenario("large image: 6000x4000 source is processed without crashing the tab; memory stays bounded; work is timed", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const rss = () => { try { const out = execSync("ps -eo rss,args | grep -E 'pw-browsers|chrom' | grep -v grep | awk '{s+=$1} END {print s}'", { encoding: "utf8" }); return Number(out.trim() || 0) * 1024; } catch (_) { return 0; } };
  const big = await makeImage(p, { w: 6000, h: 4000, type: "image/jpeg", quality: 0.92 });
  check(big.length < 16 * 1024 * 1024, "24 Mpx source (" + (big.length / 1048576).toFixed(1) + " MiB) is under the 16 MiB source cap");
  const base = rss();
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, rss()); }, 100);
  const t0 = Date.now();
  await pickViaButton(p, "files", jpg(big));
  await until(() => srv.assets().length === 1, "processed and uploaded", 60000);
  clearInterval(timer);
  const ms = Date.now() - t0;
  const d = dimsOf(srv.asset(srv.assets()[0]));
  check(d.w === 2560 && d.h === 1707, `downscaled to ${d.w}x${d.h}`);
  console.log(`  INFO  24 Mpx source: ${ms} ms, browser RSS base ${(base / 1048576).toFixed(0)} MiB -> peak ${(peak / 1048576).toFixed(0)} MiB`);
  check(peak - base < 1536 * 1048576, "browser RSS growth stayed under 1.5 GiB while decoding a 24 Mpx source");
  await seeImage(p);
  await ctx.close();
});

scenario("quota exhaustion is explicit; orphans keep counting; nothing is stored past the limit", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 400, h: 300 })));
  await seeImage(p);
  await saved(p);
  // fill the budget with a SPARSE file named like an asset (only its size counts): ~249.9 MiB of accumulated orphans
  const { openSync, ftruncateSync, closeSync, mkdirSync } = await import("node:fs");
  mkdirSync(srv.adir, { recursive: true });
  const fd = openSync(path.join(srv.adir, "asset-" + "e".repeat(24) + ".png"), "w");
  ftruncateSync(fd, 250 * 1024 * 1024 - 1024);
  closeSync(fd);
  const before = srv.assets().length;
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 1600, h: 1200, quality: 0.95 })));
  await until(async () => /Quota des images atteint/.test(await msg(p)), "the quota message is shown in the panel");
  const text = await msg(p);
  check(/250,0 Mo sur 250 Mo|Mo sur 250 Mo/.test(text) && /nettoyage/.test(text), "it says how full the budget is and why space is not freed: " + text.slice(0, 160));
  check(srv.assets().length === before && srv.tmps().length === 0, "nothing was stored and no temp file remains");
  check((await figs(p).count()) === 1, "the page still shows only the first image");
  const usage = await (await ctx.request.get(srv.base + "/api/carnet/asset")).json();
  check(usage.bytes >= 250 * 1024 * 1024 - 1024 && usage.max_bytes === 250 * 1024 * 1024, "usage endpoint reports the budget: " + JSON.stringify(usage));
  await ctx.close();
});

scenario("editing safety: select-all delete then native undo; a pasted/dropped file that is not a real image is refused before any upload", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 5, 5);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 400, h: 300 })));
  await seeImage(p);
  await p.click("#btn-carnet-image-done");
  await saved(p);
  // UX pass: paste/drop of an image file now reaches the Stage-06 pipeline, which sniffs the BYTES and refuses this fake PNG before any upload
  let posts = 0;
  p.on("request", (r) => { if (r.url().endsWith("/api/carnet/asset") && r.method() === "POST") posts += 1; });
  await p.evaluate(() => {
    const ed = document.querySelector("#hq-carnet-editor");
    ed.focus();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }));
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    ed.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await sleep(300);
  check((await figs(p).count()) === 1 && posts === 0, "paste/drop of a fake image (bytes 1,2,3) changed nothing and uploaded nothing");
  // select all + Delete
  await p.click("#hq-carnet-editor p, #hq-carnet-editor [data-line-type='paragraph']");
  await p.keyboard.press("Control+a");
  await p.keyboard.press("Delete");
  await sleep(300);
  await saved(p);
  check(imgs(srv, "page-a").length === 0, "select-all + Delete removed the picture with the text (explicit selection)");
  const text = await p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
  check(text === "", "the page is one empty line: " + JSON.stringify(text));
  await p.keyboard.press("Control+z");
  await sleep(400);
  await saved(p);
  const back = await figs(p).count();
  console.log("  INFO  native undo after select-all delete restored " + back + " figure(s); server image blocks: " + imgs(srv, "page-a").length);
  check(back === imgs(srv, "page-a").length, "client DOM and saved state agree after the native undo");
  await ctx.close();
});

scenario("invariants: no external request, asset endpoint headers, no dangerous sinks in the new module", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await pickViaButton(p, "files", jpg(await makeImage(p, { w: 300, h: 200 })));
  await seeImage(p);
  const id = await p.evaluate(() => document.querySelector("#hq-carnet-editor [data-carnet-asset]").getAttribute("data-carnet-asset"));
  const res = await ctx.request.get(srv.base + "/api/carnet/asset/" + id);
  const h = res.headers();
  check(res.status() === 200 && h["content-type"] === "image/jpeg" && h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "DENY" && /frame-ancestors 'none'/.test(h["content-security-policy"]), "asset headers: type, nosniff, DENY, CSP");
  const anon = await (await browser.newContext()).request.get(srv.base + "/api/carnet/asset/" + id);
  check(anon.status() === 401, "no cookie -> 401");
  const src = readFileSync(path.join(here, "..", "assets", "hq-carnet-media.js"), "utf8");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "XMLHttpRequest", "sendBeacon", "WebSocket", "localStorage"]) check(!src.includes(bad), "media module has no " + bad);
  check(!/\bfetch\(/.test(src), "media module uses the shared api() transport only");
  check(external.length === 0, "no external request during the whole run: " + external.slice(0, 3));
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
