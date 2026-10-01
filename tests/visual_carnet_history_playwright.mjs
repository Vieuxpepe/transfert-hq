// Carnet Stage 08 browser checks (Node Playwright): history, restore, bulk operations + Undo, report, backlinks,
// accessibility, local-draft privacy and budgets — on a throwaway loopback HQ (tests/carnet_test_server.py).
//
//   node tests/visual_carnet_history_playwright.mjs
//
// Engines: Chromium (desktop) plus Chromium device emulation for iPad/iPhone-sized touch profiles.
// Real WebKit is not driven here (no WebKit build in this environment): the existing Python suite
// tests/visual_carnet_playwright.py owns the WebKit iPad/iPhone runs. Skips (exit 0) when
// Playwright or Chromium is unavailable. Never touches the live root or a real PIN; run it from a
// disposable copy of the checkout (the server imports the bridge).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
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
function check(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
  console.log("  OK  ", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, timeout = 9000) {
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
const line = (type, text, marks, extra) => Object.assign({ id: "block-" + Math.random().toString(16).slice(2, 14), type, text, marks: marks || [] }, extra || {});
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0, content: { version: 2, blocks } }, extra || {});
}
function v1(id, rev, text, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0,
    content: { version: 1, blocks: [{ id: "block-" + id.slice(5), type: "text", text, marks: [] }] } }, extra || {});
}
const notebook = (pages, rev = 4) => ({ version: 1, notebook_rev: rev, projects: [], categories: [], pages });

// ---------------------------------------------------------------- server
class Server {
  static async start(seed) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-history-"));
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
    return s;
  }
  nb() {
    return JSON.parse(readFileSync(this.nbPath, "utf8"));
  }
  put(nb) {
    writeFileSync(this.nbPath, JSON.stringify(nb));
  }
  pg(id) {
    return this.nb().pages.find((p) => p.id === id);
  }
  text(id) {
    return this.pg(id).content.blocks.map((b) => b.text).join("\n");
  }
  files(dir) {
    const d = path.join(this.root, dir);
    return existsSync(d) ? readdirSync(d) : [];
  }
  read(rel) {
    return readFileSync(path.join(this.root, rel), "utf8");
  }
  close() {
    try {
      this.proc.stdin.end();
    } catch (_) {}
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

async function context(srv, profile = "desktop", extra = {}) {
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, PROFILES[profile], extra));
  const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.admin_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(r.status() === 303, "login " + profile);
  return ctx;
}

async function openPage(ctx, srv, { carnet = true } = {}) {
  const page = await ctx.newPage();
  const tag = "[" + (page.viewportSize() ? page.viewportSize().width : "?") + "]";
  page.on("pageerror", (e) => errors.push(`${tag} pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`);
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
  });
  await page.goto(srv.base + "/");
  if (carnet) await showCarnet(page);
  return page;
}

async function showCarnet(page) {
  await page.locator('.bottom-nav [data-nav="carnet"]').click();
  try {
    await page.waitForSelector("#hq-carnet-editor", { timeout: 15000 });
  } catch (e) {
    const app = await page.evaluate(() => (document.getElementById("hq-carnet-app") || {}).textContent || "(no app host)");
    throw new Error("Carnet editor did not appear; panel says: " + app.slice(0, 200));
  }
  await page.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
}

const EDITOR = "#hq-carnet-editor";
const pid0 = (pg) => pg.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
const value = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
const dirty = (p) => p.evaluate(() => { const d = window.hqCarnetDebug(); return d.core.pages.some((x) => x.dirty || x.inflight); });
const conflict = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.conflict));
async function select(p, a, b) {
  await p.evaluate(([x, y]) => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(x, y); }, [a, b]);
}
const sel = (p) => p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); return [e.selectionStart, e.selectionEnd]; });
async function saved(p, srv, id, msg) {
  await until(async () => !(await dirty(p)), (msg || "saved") + " (client clean)");
}
/** Replace the server notebook once the client is clean (an unsaved draft would otherwise be recovered against it). */
async function reseed(p, srv, nb) {
  await until(async () => !(await dirty(p)), "client clean before reseed");
  srv.put(nb);
  await p.reload();
  await showCarnet(p);
}
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openFormat(p) {
  await openMore(p);
  if (await p.locator("#carnet-format-bar").isHidden()) await p.click("#btn-carnet-format");
  await p.waitForSelector("#carnet-format-bar", { state: "visible" });
}
/** Lines as the editor DOM shows them: [type, checked, text, [[mark, text]...]]. */
const domLines = (p) => p.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].map((d) => [
  d.getAttribute("data-line-type"), d.getAttribute("data-checked") === "true", d.textContent,
  [...d.querySelectorAll("[data-m],a[data-carnet-link]")].map((n) => [n.getAttribute("data-m") || n.getAttribute("data-carnet-link"), n.textContent]),
]));
const blocks = (srv, id) => srv.pg(id).content.blocks.map((b) => [b.type, !!b.checked, b.text, b.marks.map((m) => [m.type, m.start, m.end])]);


const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
async function cpost(ctx, srv, payload) {
  const r = await ctx.request.post(srv.base + "/api/carnet", { data: payload, headers: { Origin: srv.base } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body };
}
async function cget(ctx, srv, q) {
  const r = await ctx.request.get(srv.base + "/api/carnet?" + q);
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}
const hist = (srv) => (existsSync(path.join(srv.root, ".hq-carnet", "history.json")) ? JSON.parse(srv.read(".hq-carnet/history.json")) : { events: [] });
const DLG = "#hq-carnet-hx";
const dlgOpen = (p) => p.evaluate(() => { const d = document.getElementById("hq-carnet-hx"); return !!d && !d.hidden; });
async function openHistoryTab(p) {
  await openMore(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector(DLG, { state: "visible" });
}
async function openBulkTab(p) {
  const hidden = await p.evaluate(() => { const l = document.getElementById("hq-carnet-library"); return !l || l.hidden; });
  if (hidden) await p.click("#btn-carnet-library");
  await p.waitForSelector("#btn-carnet-lib-bulk", { state: "visible" });
  await p.click("#btn-carnet-lib-bulk");
  await p.waitForSelector(DLG, { state: "visible" });
}
const tab = (p, name) => p.click('[data-hx-tab="' + name + '"]');
const say = (p) => p.textContent("#hq-carnet-hx-live");
const seed3 = () => notebook([
  page("page-a", 1, [line("paragraph", "Alpha foo un", [], { id: "block-aaaaaaaaaaaa" })]),
  page("page-b", 1, [line("paragraph", "Beta foo deux", [], { id: "block-bbbbbbbbbbbb" })]),
  page("page-c", 1, [line("paragraph", "Gamma foo trois", [], { id: "block-cccccccccccc" })]),
]);

async function main() {
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log("SKIP: Chromium unavailable — " + String(e.message).split("\n")[0]);
    process.exit(0);
  }
  const started = [];
  const server = async (seed) => {
    const s = await Server.start(seed);
    started.push(s);
    return s;
  };
  try {
    // ================================================================ 1. invisible by default, accessible dialog, keyboard
    console.log("-- default paper, dialog a11y, focus, Escape [desktop]");
    const srv = await server(seed3());
    let ctx = await context(srv);
    let p = await openPage(ctx, srv);
    check((await p.locator(DLG).count()) === 0, "nothing of Stage 08 exists in the DOM on the plain paper");
    check((await p.locator("#btn-carnet-history").isHidden()), "the history entry is inside the collapsed tools tray");
    const tracked = [];
    p.on("request", (r) => { if (/history=|backlinks=|bulk_|report_build/.test(r.url() + (r.postData() || ""))) tracked.push(r.url()); });
    await typeAtEndShim(p, " tapé");
    await sleep(1200);
    check(tracked.length === 0, "typing and autosave never call history/backlinks/bulk/report: " + JSON.stringify(tracked));
    await openMore(p);
    await p.focus("#btn-carnet-history");
    await p.keyboard.press("Enter");
    await p.waitForSelector(DLG, { state: "visible" });
    check((await p.getAttribute(DLG, "role")) === "dialog" && (await p.getAttribute(DLG, "aria-modal")) === "true", "role=dialog aria-modal");
    const labelled = await p.getAttribute(DLG, "aria-labelledby");
    check(labelled && (await p.textContent("#" + labelled)).length > 0, "dialog is named");
    check(await p.evaluate(() => document.getElementById("hq-carnet-hx").contains(document.activeElement)), "focus moves inside the dialog");
    check((await p.getAttribute("#hq-carnet-hx-live", "aria-live")) === "polite" && (await p.getAttribute("#hq-carnet-hx-live", "role")) === "status", "status region announces results");
    // focus containment: Tab many times never leaves
    let escaped = false;
    for (let i = 0; i < 40; i++) {
      await p.keyboard.press("Tab");
      if (!(await p.evaluate(() => document.getElementById("hq-carnet-hx").contains(document.activeElement)))) escaped = true;
    }
    for (let i = 0; i < 40; i++) {
      await p.keyboard.press("Shift+Tab");
      if (!(await p.evaluate(() => document.getElementById("hq-carnet-hx").contains(document.activeElement)))) escaped = true;
    }
    check(!escaped, "Tab / Shift+Tab are trapped inside the modal");
    const nameless = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-hx button, #hq-carnet-hx input, #hq-carnet-hx select")].filter((n) => !(n.getAttribute("aria-label") || (n.labels && n.labels.length) || (n.textContent || "").trim())).length);
    check(nameless === 0, "every control has an accessible name");
    await p.keyboard.press("Escape");
    check(!(await dlgOpen(p)), "Escape closes");
    check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-history", "focus returns to the opener");
    await ctx.close();

    // ================================================================ 2. checkpoint, restore (confirm), history stays
    console.log("-- checkpoint / restore [desktop]");
    ctx = await context(srv);
    p = await openPage(ctx, srv);
    const id0 = await pid0(p);
    await openHistoryTab(p);
    await p.fill("#hq-carnet-hx-label", "avant essai");
    await p.click('[data-hx="checkpoint"]');
    await until(async () => (await p.locator(".carnet-hx-event").count()) === 1, "the checkpoint is listed");
    check(hist(srv).events.length === 1 && hist(srv).events[0].kind === "checkpoint", "one explicit checkpoint, nothing automatic");
    const textBefore = srv.text(id0);
    await p.keyboard.press("Escape");
    await typeAtEndShim(p, " modifié");
    await saved(p, srv, id0, "edited");
    check(srv.text(id0) !== textBefore, "the page changed after the checkpoint");
    await openHistoryTab(p);
    await p.click('[data-hx="restore"]');
    check((await p.textContent('[data-hx="restore-confirm"]')).includes("Confirmer"), "restore needs an explicit second step");
    check(srv.text(id0) !== textBefore, "nothing restored before the confirmation");
    await p.click('[data-hx="restore-confirm"]');
    await until(async () => srv.text(id0) === textBefore, "restored on the server");
    await until(async () => (await value(p)) === textBefore, "the open editor shows the restored text");
    check(hist(srv).events.some((e) => e.kind === "restore") && hist(srv).events.some((e) => e.kind === "checkpoint"), "restore appended; the checkpoint is still there");
    await p.keyboard.press("Escape");

    // ================================================================ 3. bulk replace -> preview -> apply -> Undo
    console.log("-- bulk replace / undo [desktop]");
    await openBulkTab(p);
    check((await p.locator("#hq-carnet-hx-op").count()) === 1, "wizard opens on the library scope");
    await p.click('[data-hx="pick-all"]');
    await p.fill("#hq-carnet-hx-find", "foo");
    await p.fill("#hq-carnet-hx-replace", "BAR");
    check(await p.isDisabled("#btn-carnet-hx-apply").catch(() => true), "nothing can be applied before a preview");
    await p.click("#btn-carnet-hx-preview");
    await p.waitForSelector("#hq-carnet-hx-affected");
    check((await p.textContent("#hq-carnet-hx-affected")).startsWith("3 élément(s)"), "affected count shown: " + (await p.textContent("#hq-carnet-hx-affected")));
    check(!srv.text("page-a").includes("BAR"), "preview wrote nothing");
    await p.click("#btn-carnet-hx-apply");
    await p.waitForSelector("#hq-carnet-hx-result");
    check((await p.getAttribute("#hq-carnet-hx-result .carnet-hx-outcome", "data-hx-outcome")) === "complete", "complete");
    check(["page-a", "page-b", "page-c"].every((i) => srv.text(i).includes("BAR") && !srv.text(i).includes("foo")), "all three pages replaced on the server");
    await until(async () => (await p.evaluate(() => document.activeElement && document.activeElement.id)) === "hq-carnet-hx-result", "focus moves to the result");
    check(hist(srv).events.filter((e) => e.kind === "bulk").length === 1, "one logical history event");
    await p.click("#btn-carnet-hx-undo");
    await until(async () => ["page-a", "page-b", "page-c"].every((i) => srv.text(i).includes("foo")), "Undo restored every page");
    await until(async () => (await p.textContent("#hq-carnet-hx-result h4")) === "Annulation", "undo reported in the result panel");
    check((await p.textContent("#hq-carnet-hx-result .carnet-hx-outcome")).startsWith("Terminé"), "undo completed");
    check((await p.locator('#hq-carnet-hx-result [data-hx="undo"]').count()) === 0, "no redo / second undo offered");
    await p.keyboard.press("Escape");

    // ================================================================ 4. partial: another client edits one target after preview
    console.log("-- partial apply / conflict [desktop]");
    await openBulkTab(p);
    await p.click('[data-hx="pick-all"]');
    await p.fill("#hq-carnet-hx-find", "foo");
    await p.fill("#hq-carnet-hx-replace", "ZED");
    await p.click("#btn-carnet-hx-preview");
    await p.waitForSelector("#hq-carnet-hx-affected");
    const r = await cpost(ctx, srv, { action: "page_save", id: "page-b", expected_rev: srv.pg("page-b").rev, content: { version: 2, blocks: [{ id: "block-bbbbbbbbbbbb", type: "paragraph", text: "Beta foo édité ailleurs", marks: [] }] } });
    check(r.status === 200, "another client edits page-b after the preview");
    await p.click("#btn-carnet-hx-apply");
    await p.waitForSelector("#hq-carnet-hx-result");
    check((await p.getAttribute("#hq-carnet-hx-result .carnet-hx-outcome", "data-hx-outcome")) === "partial", "outcome partial — never a global success");
    check((await p.locator('#hq-carnet-hx-result [data-hx-status="conflicted"]').count()) === 1 && (await p.locator('#hq-carnet-hx-result [data-hx-status="applied"]').count()) === 2, "per-target: 2 applied, 1 conflicted");
    check(srv.text("page-b") === "Beta foo édité ailleurs", "the newer work was never overwritten");
    await p.click("#btn-carnet-hx-undo");
    await until(async () => srv.text("page-a").includes("foo") && srv.text("page-c").includes("foo"), "undo reverts only what was applied");
    check(srv.text("page-b") === "Beta foo édité ailleurs", "undo leaves the conflicted page alone");
    await p.keyboard.press("Escape");

    // ================================================================ 5. local draft pages are skipped, never touched
    console.log("-- unsaved local draft is skipped [desktop]");
    let holdSaves = true; // the handler stays installed until the held save has completed (unroute() while a handler waits is racy)
    await p.route("**/api/carnet", async (route) => {
      const req = route.request();
      if (holdSaves && req.method() === "POST" && /"page_save"/.test(req.postData() || "")) await sleep(6000);
      await route.continue();
    });
    await typeAtEndShim(p, " brouillon");
    check(await dirty(p), "the open page is dirty (its save is held)");
    await openBulkTab(p);
    check((await p.locator(".carnet-hx-pick .hint", { hasText: "Brouillon local — ignorée" }).count()) >= 1, "the dirty page is labelled as skipped");
    await p.click('[data-hx="pick-all"]');
    await p.fill("#hq-carnet-hx-find", "foo");
    await p.fill("#hq-carnet-hx-replace", "DRAFT");
    await p.click("#btn-carnet-hx-preview");
    await p.waitForSelector("#hq-carnet-hx-affected");
    await p.click("#btn-carnet-hx-apply");
    await p.waitForSelector("#hq-carnet-hx-result");
    check((await p.locator('#hq-carnet-hx-result [data-hx-status="skipped"]').count()) >= 1, "the draft page is reported skipped, not applied");
    holdSaves = false;
    await p.keyboard.press("Escape");
    await until(async () => !(await dirty(p)), "the held save finally completes", 20000);
    await p.unroute("**/api/carnet");
    await ctx.close();

    // ================================================================ 6. sources: migration semantics, calibration ack
    console.log("-- source migration and linked-file replacement [desktop]");
    const srv2 = await server(seed3());
    ctx = await context(srv2);
    mkdirSync(path.join(srv2.root, "Uni"), { recursive: true });
    writeFileSync(path.join(srv2.root, "Uni", "a.pdf"), PDF);
    writeFileSync(path.join(srv2.root, "Uni", "b.pdf"), PDF);
    const fam = (await cpost(ctx, srv2, { action: "source_family_create", name: "Manuel" })).body.family;
    const e1 = (await cpost(ctx, srv2, { action: "source_edition_create", family_id: fam.id, edition: "29e", title: "Manuel", type: "book", year: 2012, file_ref: "Uni/a.pdf" })).body.edition;
    const e2 = (await cpost(ctx, srv2, { action: "source_edition_create", family_id: fam.id, edition: "30e", title: "Manuel", type: "book", year: 2016, file_ref: "Uni/b.pdf" })).body.edition;
    check((await cpost(ctx, srv2, { action: "source_edition_calibrate", id: e1.id, expected_rev: 1, calibration: { printed: 1, pdf: 12 } })).status === 200, "seed calibration");
    const cite = { src: e1.id, loc: { kind: "page", text: "417" }, pdf: 439, ok: true, snap: { title: "Manuel", edition: "29e", year: 2012 }, from: null };
    const label = "[Manuel 29e, p. 417]";
    const nb = srv2.nb();
    nb.pages.find((x) => x.id === "page-a").content.blocks[0] = { id: "block-aaaaaaaaaaaa", type: "paragraph", text: "Voir " + label, marks: [{ type: "citation", start: 5, end: 5 + label.length, cite }] };
    srv2.put(nb);
    p = await openPage(ctx, srv2);
    await openBulkTab(p);
    await p.selectOption("#hq-carnet-hx-op", "source_migrate");
    await p.waitForFunction(() => document.querySelectorAll("#hq-carnet-hx-from option").length > 2);
    await p.selectOption("#hq-carnet-hx-from", e1.id);
    await p.selectOption("#hq-carnet-hx-to", e2.id);
    await p.click("#btn-carnet-hx-preview");
    await p.waitForSelector("#hq-carnet-hx-affected");
    check((await p.textContent(".carnet-hx-sample")).includes("p. 417") && !(await p.textContent(".carnet-hx-sample")).split("→")[1].includes("417"), "the old locator is only DISPLAYED in the preview");
    await p.click("#btn-carnet-hx-apply");
    await p.waitForSelector("#hq-carnet-hx-result");
    const mc = srv2.pg("page-a").content.blocks[0].marks[0].cite;
    check(mc.src === e2.id && mc.loc.text === "" && mc.loc.kind === "page" && mc.pdf === null && mc.ok === false, "stored: new edition, empty locator, no PDF page, ok=false: " + JSON.stringify(mc));
    check(mc.from && mc.from.loc.text === "417" && mc.from.pdf === 439 && mc.from.ok === true, "old citation kept as provenance only");
    check(srv2.pg("page-a").content.blocks[0].text.includes("à vérifier"), "visible label says à vérifier");
    await p.click("#btn-carnet-hx-undo");
    await until(async () => JSON.stringify(srv2.pg("page-a").content.blocks[0].marks[0].cite) === JSON.stringify(cite), "Undo restores the exact original citation payload");
    await p.selectOption("#hq-carnet-hx-op", "file_replace");
    await p.waitForFunction(() => document.querySelectorAll("#hq-carnet-hx-edition option").length > 2);
    await p.selectOption("#hq-carnet-hx-edition", e1.id);
    await p.fill("#hq-carnet-hx-fileref", "Uni/b.pdf");
    await p.click("#btn-carnet-hx-preview");
    await p.waitForSelector("#hq-carnet-hx-ack");
    check((await p.textContent(".carnet-hx-warn")).includes("EFFACÉ"), "the preview prominently reports the calibration");
    check(await p.isDisabled("#btn-carnet-hx-apply"), "apply stays disabled until the explicit acknowledgement");
    await p.check("#hq-carnet-hx-ack");
    check(!(await p.isDisabled("#btn-carnet-hx-apply")), "acknowledged");
    await p.click("#btn-carnet-hx-apply");
    await p.waitForSelector("#hq-carnet-hx-result");
    const ed1 = JSON.parse(srv2.read(".hq-carnet/sources.json")).editions.find((x) => x.id === e1.id);
    check(ed1.file_ref === "Uni/b.pdf" && ed1.calibration === null, "file replaced, calibration cleared");
    await p.click("#btn-carnet-hx-undo");
    await until(async () => { const e = JSON.parse(srv2.read(".hq-carnet/sources.json")).editions.find((x) => x.id === e1.id); return e.file_ref === "Uni/a.pdf" && e.calibration && e.calibration.pdf === 12; }, "Undo restores the old file AND the old calibration");
    await p.keyboard.press("Escape");

    // ================================================================ 7. report: explicit order, inline, export
    console.log("-- report [desktop]");
    await openBulkTab(p);
    await tab(p, "report");
    await p.selectOption("#hq-carnet-hx-radd", "note:page-c");
    await p.click("#btn-carnet-hx-radd");
    await p.selectOption("#hq-carnet-hx-radd", "note:page-a");
    await p.click("#btn-carnet-hx-radd");
    check((await p.locator("#hq-carnet-hx-ritems li").count()) === 2, "two items");
    await p.click('[data-hx="rdown"][data-i="0"]');
    const order = await p.locator("#hq-carnet-hx-ritems .carnet-hx-event-text").allTextContents();
    check(order[0].includes("Voir") && order[1].includes("Gamma"), "explicit reorder (↓ on the first moves it second): " + JSON.stringify(order));
    await p.fill("#hq-carnet-hx-rtitle", "Rapport banc");
    await p.click("#btn-carnet-hx-rbuild");
    await p.waitForSelector("#hq-carnet-hx-md");
    const md = await p.textContent("#hq-carnet-hx-md");
    check(md.startsWith("# Rapport banc") && md.indexOf("Voir") >= 0 && md.indexOf("Voir") < md.indexOf("Gamma"), "inline markdown in the chosen order: " + md.slice(0, 120));
    check(!md.includes(srv2.root) && !md.includes("/tmp"), "no absolute path in the report");
    await p.selectOption("#hq-carnet-hx-eroot", "Print");
    await p.click("#btn-carnet-hx-rexport");
    await until(async () => srv2.files("Print").some((f) => f.endsWith(".md")), "report exported to Print/");
    check(srv2.read("Print/" + srv2.files("Print").find((f) => f.endsWith(".md"))).startsWith("# Rapport banc"), "the exported .md is the same report");
    await p.keyboard.press("Escape");

    // ================================================================ 8. backlinks
    console.log("-- backlinks [desktop]");
    const nb2 = srv2.nb();
    const target = "page-c";
    const pa = nb2.pages.find((x) => x.id === "page-b");
    pa.content.blocks[0] = { id: "block-bbbbbbbbbbbb", type: "paragraph", text: "voir gamma", marks: [{ type: "link", start: 5, end: 10, ref: { kind: "note", id: target } }] };
    pa.rev += 1;
    srv2.put(nb2);
    await p.reload();
    await showCarnet(p);
    await openHistoryTab(p);
    await tab(p, "back");
    await p.selectOption("#hq-carnet-hx-btarget", target);
    await p.waitForSelector("#hq-carnet-hx-blist .carnet-hx-event");
    check((await p.textContent("#hq-carnet-hx-blist")).includes("voir gamma"), "'Liée depuis…' lists the note that links here");
    const before = JSON.stringify(srv2.nb());
    await p.click('#hq-carnet-hx-blist [data-hx="open"]');
    check(!(await dlgOpen(p)) && JSON.stringify(srv2.nb()) === before, "opening a backlink navigates without mutating anything");
    await ctx.close();

    // ================================================================ 9. privacy audit, storage, mobile touch targets, reduced motion
    console.log("-- privacy / touch targets / reduced motion [iphone]");
    ctx = await context(srv2, "iphone", { reducedMotion: "reduce" });
    p = await openPage(ctx, srv2);
    await openHistoryTab(p);
    await p.click('[data-hx="audit"]');
    await p.waitForSelector("#hq-carnet-hx-audit");
    check((await p.textContent("#hq-carnet-hx-audit")).includes("Aucun jeton ni chemin absolu"), "draft audit reports clean");
    const keys = await p.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
    check(keys.every((k) => k.startsWith("hq_carnet_drafts_v1:") || !/carnet/i.test(k)), "the only Carnet storage key is the draft store: " + JSON.stringify(keys));
    const small = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-hx button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5 || r.width < 43.5); }).map((b) => (b.textContent || b.getAttribute("aria-label")).slice(0, 20)));
    check(small.length === 0, "all buttons are at least 44px: " + JSON.stringify(small));
    check(await p.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches && getComputedStyle(document.getElementById("hq-carnet-hx")).animationName === "none"), "reduced motion honoured");
    check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll on the phone");
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
    check(await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; }), "visible keyboard focus");
    await ctx.close();

    // ================================================================ 10. budgets: 128 pages, typing never pays for history
    console.log("-- 128 pages budget [desktop]");
    const many = [];
    for (let i = 0; i < 128; i++) many.push(page("page-p" + String(i).padStart(3, "0"), 1, [line("paragraph", "Page " + i + " foo " + "mot ".repeat(40), [], { id: "block-" + String(i).padStart(12, "0") })]));
    const srv3 = await server(notebook(many, 6));
    ctx = await context(srv3);
    p = await openPage(ctx, srv3);
    const t0 = Date.now();
    await openBulkTab(p);
    const opened = Date.now() - t0;
    check(opened < 4000, "bulk dialog opens fast with 128 pages: " + opened + "ms");
    check((await p.locator(".carnet-hx-pick").count()) <= 64, "the scope list is bounded to the 64-target limit");
    await p.keyboard.press("Escape");
    const net = [];
    p.on("request", (rq) => { if (/history=|backlinks=|report_build|bulk_/.test(rq.url() + (rq.postData() || ""))) net.push(rq.url()); });
    const lat = await p.evaluate(async () => {
      const e = document.querySelector("#hq-carnet-editor");
      e.focus();
      const t = performance.now();
      for (let i = 0; i < 40; i++) document.execCommand("insertText", false, "x");
      return (performance.now() - t) / 40;
    });
    await sleep(900);
    check(lat < 50, "per-keystroke cost stays small at 128 pages: " + lat.toFixed(1) + "ms");
    check(net.length === 0, "no history/backlink work per keystroke");
    await ctx.close();

    // ================================================================ 11. role + hygiene
    console.log("-- upload role / hygiene");
    const up = await browser.newContext();
    const lr = await up.request.post(srv.base + "/login", { form: { pin: srv.upload_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
    check(lr.status() === 303, "upload login");
    for (const body of [{ action: "history_checkpoint", page_id: "page-a", expected_rev: 1 }, { action: "bulk_preview", op: "replace", params: { find: "a" }, page_ids: ["page-a"] }, { action: "report_build", items: [] }]) {
      const rr = await up.request.post(srv.base + "/api/carnet", { data: body, headers: { Origin: srv.base } });
      check(rr.status() === 403, "upload role refused for " + body.action);
    }
    for (const q of ["history=1", "backlinks=note&id=page-a"]) check((await up.request.get(srv.base + "/api/carnet?" + q)).status() === 403, "upload role refused GET " + q);
    await up.close();
    check(errors.length === 0, "no page errors / console errors: " + JSON.stringify(errors));
    check(external.length === 0, "no external requests: " + JSON.stringify(external));
    console.log(`\nALL OK (${passed} checks)`);
  } finally {
    await browser.close();
    for (const s of started) s.close();
  }
}

async function typeAtEndShim(p, text) {
  await p.evaluate(() => {
    const e = document.querySelector("#hq-carnet-editor");
    e.focus();
    e.setSelectionRange(e.value.length, e.value.length);
  });
  await p.keyboard.type(text);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
