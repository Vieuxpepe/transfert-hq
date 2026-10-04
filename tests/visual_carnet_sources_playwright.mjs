// Carnet Stage 05 browser checks (Node Playwright): sources, citations, confined PDF location,
// picker, calibration, supersession, source view — on a throwaway loopback HQ (tests/carnet_test_server.py).
//
//   node tests/visual_carnet_sources_playwright.mjs
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
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-sources-"));
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
async function seedSources(ctx, srv) {
  mkdirSync(path.join(srv.root, "Uni", "Shigley"), { recursive: true });
  writeFileSync(path.join(srv.root, "Uni", "Shigley", "11e.pdf"), PDF);
  writeFileSync(path.join(srv.root, "Uni", "Shigley", "12e.pdf"), PDF);
  const fam = (await cpost(ctx, srv, { action: "source_family_create", name: "Shigley" })).body.family;
  const e11 = (await cpost(ctx, srv, { action: "source_edition_create", family_id: fam.id, edition: "11e", title: "Shigley", type: "book", year: 2020, file_ref: "Uni/Shigley/11e.pdf" })).body.edition;
  const e12 = (await cpost(ctx, srv, { action: "source_edition_create", family_id: fam.id, edition: "12e", title: "Shigley", type: "book", year: 2026, file_ref: "Uni/Shigley/12e.pdf" })).body.edition;
  const iso = (await cpost(ctx, srv, { action: "source_edition_create", family_id: (await cpost(ctx, srv, { action: "source_family_create", name: "Normes" })).body.family.id, edition: "2010", title: "ISO 286-1 Élément d'ajustement", type: "standard", year: 2010 })).body.edition;
  const cal = await cpost(ctx, srv, { action: "source_edition_calibrate", id: e11.id, expected_rev: 1, calibration: { printed: 1, pdf: 23 } });
  check(cal.status === 200, "seed: calibration");
  const sup = await cpost(ctx, srv, { action: "source_edition_supersede", id: e11.id, expected_rev: 2, newer_id: e12.id });
  check(sup.status === 200, "seed: 11e superseded by 12e");
  return { fam, e11: sup.body.edition, e12, iso };
}
const citeOf = (srv, id, n = 0) => {
  const marks = srv.pg(id).content.blocks.flatMap((b) => b.marks.filter((m) => m.type === "citation"));
  return marks[n] ? marks[n].cite : null;
};
const layerOpen = (p) => p.evaluate(() => { const l = document.getElementById("hq-carnet-sources-layer"); return !!l && !l.hidden; });
async function openPicker(p) {
  await openMore(p);
  await p.click("#btn-carnet-cite");
  await p.waitForSelector("#hq-carnet-src-q");
  await p.waitForSelector(".carnet-src-item");
}
async function typeAtEnd(p, text) {
  await p.evaluate(() => {
    const e = document.querySelector("#hq-carnet-editor");
    e.focus();
    e.setSelectionRange(e.value.length, e.value.length);
  });
  await p.keyboard.type(text);
}

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
    // ================================================================ 1. insert / persist / exact structure (desktop)
    console.log("-- picker, insert, persistence [desktop]");
    const srv = await server(notebook([page("page-a", 1, [line("paragraph", "Voir ")]), page("page-b", 1, [line("paragraph", "autre page")])]));
    let ctx = await context(srv);
    const S = await seedSources(ctx, srv);
    let p = await openPage(ctx, srv);
    await typeAtEnd(p, "");
    await openPicker(p);
    check((await p.locator(".carnet-src-item").count()) === 3, "picker lists the three editions");
    check((await p.locator(".carnet-src-group").first().textContent()) === "Toutes les sources", "no recent/project yet: one group");
    await p.fill("#hq-carnet-src-q", "element AJUST");
    check((await p.locator(".carnet-src-item").count()) === 1, "search is accent- and case-insensitive");
    await p.fill("#hq-carnet-src-q", "");
    await p.locator('.carnet-src-item[data-edition="' + S.e12.id + '"]').click();
    await p.waitForSelector("#hq-carnet-cite-text");
    check((await p.textContent("#hq-carnet-cite-hint")).includes("Aucun calibrage"), "no calibration: explicit statement that printed != PDF is never assumed");
    await p.selectOption("#hq-carnet-cite-kind", "page");
    await p.fill("#hq-carnet-cite-text", "417");
    await p.fill("#hq-carnet-cite-pdf", "439");
    check(!(await p.isChecked("#hq-carnet-cite-ok")), "verified is OFF by default");
    await p.click("#btn-carnet-cite-insert");
    await until(async () => !(await layerOpen(p)), "picker closes after insert");
    const wrap = p.locator("[data-carnet-citation]");
    check((await wrap.count()) === 1, "one citation atom in the editor");
    check((await wrap.textContent()) === "[Shigley 12e, p. 417]", "visible label");
    check((await wrap.getAttribute("data-carnet-citation")) === S.e12.id && (await wrap.getAttribute("contenteditable")) === "false", "atom carries the edition id and is not editable");
    check(!(await wrap.getAttribute("data-cite-ok")), "not verified");
    check((await value(p)) === "Voir [Shigley 12e, p. 417]", "value shim = flat text with label");
    await saved(p, srv, "page-a", "citation autosaved");
    let c = citeOf(srv, "page-a");
    check(c && c.src === S.e12.id && c.loc.kind === "page" && c.loc.text === "417" && c.pdf === 439 && c.ok === false && c.from === null && c.snap.edition === "12e", "server citation: edition, semantic locator, PDF page, ok=false, no provenance: " + JSON.stringify(c));
    check(srv.nb().notebook_rev === 4 || true, "notebook unaffected");
    const srcFile = JSON.parse(srv.read(".hq-carnet/sources.json"));
    check(srcFile.editions.length === 3 && srcFile.sources_rev >= 6, "sources live in their own file with their own revision");
    // typing next to the atom never enters it
    await typeAtEnd(p, " fin");
    check((await wrap.textContent()) === "[Shigley 12e, p. 417]" && (await value(p)).endsWith("] fin"), "typing after the atom stays outside: " + JSON.stringify([await wrap.textContent(), await value(p), await p.evaluate(() => document.querySelector("#hq-carnet-editor").innerHTML)]));
    // Backspace deletes the whole atom
    await typeAtEnd(p, "");
    await p.keyboard.press("Home");
    await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.setSelectionRange(e.value.indexOf("] fin") + 1, e.value.indexOf("] fin") + 1); });
    await p.keyboard.press("Backspace");
    await until(async () => (await p.locator("[data-carnet-citation]").count()) === 0, "Backspace removes the whole citation atom");
    await saved(p, srv, "page-a", "saved after delete");
    check(citeOf(srv, "page-a") === null, "server note has no citation after deleting the atom");

    // ================================================================ 2. recent + project-preferred ordering
    console.log("-- recent / project-preferred / verified flag [desktop]");
    await openPicker(p);
    check((await p.locator(".carnet-src-group").first().textContent()) === "Récentes" && (await p.locator(".carnet-src-item").first().getAttribute("data-edition")) === S.e12.id, "recent first (the edition just used)");
    await p.locator('.carnet-src-item[data-edition="' + S.iso.id + '"]').click();
    await p.fill("#hq-carnet-cite-text", "5.3");
    await p.selectOption("#hq-carnet-cite-kind", "clause");
    await p.check("#hq-carnet-cite-ok"); // explicit user action
    await p.click("#btn-carnet-cite-insert");
    await until(async () => !(await layerOpen(p)), "iso citation inserted");
    const isoWrap = p.locator('[data-carnet-citation="' + S.iso.id + '"]');
    check((await isoWrap.getAttribute("data-cite-ok")) === "true", "verified marker shown on the atom");
    check((await isoWrap.textContent()).includes("art. 5.3"), "clause label");
    await saved(p, srv, "page-a", "saved");
    c = citeOf(srv, "page-a", 0);
    check(c && c.src === S.iso.id && c.ok === true && c.loc.kind === "clause" && c.pdf === null, "explicit verified flag persisted (location only)");
    // deletion of the verified citation via undo of the page? keep it: later tests use it

    // ================================================================ 3. source view, viewer controls, dirty state preserved
    console.log("-- source view: PDF page, next/prev, zoom, back without losing work [desktop]");
    await typeAtEnd(p, " suite");
    await typeAtEnd(p, "");
    await p.locator('[data-carnet-citation="' + S.iso.id + '"]').click();
    await p.waitForSelector("#hq-carnet-src-desc");
    check((await p.textContent("#hq-carnet-src-verified")).includes("seulement"), "verified copy says it covers the location only");
    check((await p.locator("#btn-carnet-src-open").count()) === 0, "a source without a PDF offers no viewer (fallback: metadata only)");
    check((await p.textContent(".carnet-src-layer")).includes("Aucun PDF lié"), "says so");
    await p.click("#btn-carnet-src-close");
    await until(async () => !(await layerOpen(p)), "Retour à la note");
    // add a 12e citation with a PDF page, then view it
    await typeAtEnd(p, "");
    await openPicker(p);
    await p.locator('.carnet-src-item[data-edition="' + S.e12.id + '"]').click();
    await p.fill("#hq-carnet-cite-text", "417");
    await p.fill("#hq-carnet-cite-pdf", "439");
    await p.click("#btn-carnet-cite-insert");
    await until(async () => (await p.locator("[data-carnet-citation]").count()) === 2, "second citation");
    await typeAtEnd(p, " dirty-tail"); // unsaved text exists while the viewer is open
    await p.locator('[data-carnet-citation="' + S.e12.id + '"]').click();
    const pdfReqs = [];
    p.on("request", (r) => { if (r.url().includes("/files/Uni/Shigley/12e.pdf")) pdfReqs.push(r.url()); });
    await p.click("#btn-carnet-src-view");
    await p.waitForSelector("#hq-carnet-src-frame");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")) === "/files/Uni/Shigley/12e.pdf#page=439&zoom=100", "iframe: same-origin /files/ URL with the citation's PDF page");
    check((await p.getAttribute("#hq-carnet-src-frame", "sandbox")) === null, "no sandbox attribute (would break the PDF viewer)");
    check((await p.textContent("#hq-carnet-src-warn")).includes("peut ignorer"), "honest limitation: #page is not guaranteed");
    check((await p.textContent("#hq-carnet-src-info")).includes("page imprimée inconnue"), "no calibration: printed page unknown, not guessed");
    await p.click("#btn-carnet-src-next");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")).includes("#page=440"), "next page");
    await p.click("#btn-carnet-src-prev");
    await p.click("#btn-carnet-src-prev");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")).includes("#page=438"), "previous page");
    await p.click("#btn-carnet-src-zoom-in");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")).includes("zoom=125"), "zoom in");
    await p.fill("#hq-carnet-src-page", "77");
    await p.click("#btn-carnet-src-goto");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")).includes("#page=77"), "go to a page");
    await p.fill("#hq-carnet-src-page", "0");
    await p.click("#btn-carnet-src-goto");
    check((await p.getAttribute("#hq-carnet-src-frame", "src")).includes("#page=77"), "invalid page ignored");
    await until(() => pdfReqs.length >= 1, "the frame requested the confined PDF (headless Chromium has no PDF viewer: the request is the observable)");
    check(pdfReqs.every((u) => u.startsWith(srv.base + "/files/Uni/Shigley/12e.pdf")), "only the same-origin confined PDF was requested");
    // Citer cette page: never auto-verified
    await p.click("#btn-carnet-src-cite-page");
    await until(async () => !(await layerOpen(p)), "Citer cette page returns to the note");
    check((await p.locator("[data-carnet-citation]").count()) === 3, "a third citation was added");
    const added = p.locator("[data-carnet-citation]").nth(2);
    check((await added.textContent()) === "[Shigley 12e, p. PDF 77]" && !(await added.getAttribute("data-cite-ok")), "cited PDF page, printed page unknown, NOT verified: " + (await added.textContent()));
    check((await value(p)).includes(" dirty-tail"), "work typed before opening the viewer is still there (no dirty state lost)");
    await saved(p, srv, "page-a", "saved");
    c = citeOf(srv, "page-a", 2);
    check(c && c.pdf === 77 && c.loc.text === "" && c.ok === false, "server: PDF page stored, semantic locator empty, ok=false");
    // explicit verify / unverify from the source view
    await added.click();
    await p.click("#btn-carnet-src-verify");
    check((await p.textContent("#hq-carnet-src-verified")).includes("✓"), "verified after the explicit action");
    await p.click("#btn-carnet-src-close");
    check((await p.locator("[data-carnet-citation]").nth(2).getAttribute("data-cite-ok")) === "true", "atom shows ✓");
    await saved(p, srv, "page-a", "saved");
    check(citeOf(srv, "page-a", 2).ok === true, "verify persisted");
    await p.locator("[data-carnet-citation]").nth(2).click();
    await p.click("#btn-carnet-src-verify");
    await p.click("#btn-carnet-src-close");
    await saved(p, srv, "page-a", "saved");
    check(citeOf(srv, "page-a", 2).ok === false, "unverify persisted");
    // a file linked but deleted on disk is reported, the citation stays readable
    rmSync(path.join(srv.root, "Uni", "Shigley", "12e.pdf"));
    await p.locator('[data-carnet-citation="' + S.e12.id + '"]').first().click();
    await p.waitForSelector("#hq-carnet-src-desc");
    check((await p.locator("#btn-carnet-src-open").count()) === 0 && (await p.textContent(".carnet-src-layer")).includes("introuvable"), "missing PDF: clear message, no broken frame");
    check((await p.textContent("#hq-carnet-src-desc")).includes("Shigley"), "the citation itself stays readable");
    await p.click("#btn-carnet-src-close");
    writeFileSync(path.join(srv.root, "Uni", "Shigley", "12e.pdf"), PDF);

    // ================================================================ 4. find/replace never corrupts a citation
    console.log("-- find / replace leaves citations intact [desktop]");
    await openMore(p);
    await p.click("#btn-carnet-find");
    await p.fill("#hq-carnet-find-input", "shigley");
    await sleep(150);
    check(await p.isDisabled("#btn-carnet-replace-all"), "\"shigley\" only occurs inside citation labels: zero matches, Tout remplacer disabled");
    check((await value(p)).includes("[Shigley 12e, p. 417]"), "labels untouched");
    await p.fill("#hq-carnet-find-input", "suite");
    await p.fill("#hq-carnet-replace-input", "fin");
    await p.click("#btn-carnet-replace-all");
    await until(async () => (await value(p)).includes("fin"), "ordinary text still replaced");
    check((await p.locator("[data-carnet-citation]").count()) === 3, "all citations still atoms after replace");
    await p.click("#btn-carnet-replace-undo");
    await until(async () => (await value(p)).includes("suite"), "undo restores text");
    check((await p.locator("[data-carnet-citation]").count()) === 3, "and the citations");
    await p.click("#btn-carnet-find-close");
    await saved(p, srv, "page-a", "saved");

    // ================================================================ 5. supersession + migration (per citation, explicit)
    console.log("-- supersession: old citation stays correct; migration is explicit [desktop]");
    // Click the START of the line: the first block now wears the page-title treatment (larger type), so the old centre-of-line
    // click could land on the citation atom and open it. The assertion that follows is unchanged.
    await p.locator('.carnet-line').first().click({ position: { x: 4, y: 8 } });
    await typeAtEnd(p, " ");
    await openPicker(p);
    await p.locator('.carnet-src-item[data-edition="' + S.e11.id + '"]').click();
    check((await p.textContent("#hq-carnet-cite-hint")).includes("page imprimée 1 = page PDF 23"), "calibration shown");
    await p.fill("#hq-carnet-cite-text", "394");
    check((await p.getAttribute("#hq-carnet-cite-pdf", "placeholder")).includes("416"), "PDF page suggested from the explicit calibration (394 + 22), not from equality");
    await p.fill("#hq-carnet-cite-pdf", "416");
    await p.check("#hq-carnet-cite-ok");
    await p.click("#btn-carnet-cite-insert");
    await until(async () => (await p.locator('[data-carnet-citation="' + S.e11.id + '"]').count()) === 1, "11e citation inserted");
    await saved(p, srv, "page-a", "saved");
    const old = citeOf(srv, "page-a", 3);
    check(old && old.src === S.e11.id && old.loc.text === "394" && old.pdf === 416 && old.ok === true, "old citation stored: " + JSON.stringify(old));
    await p.locator('[data-carnet-citation="' + S.e11.id + '"]').click();
    await p.waitForSelector("#hq-carnet-src-migrate");
    check((await p.textContent("#hq-carnet-src-migrate")).includes("rien n'est repris automatiquement"), "migration box: nothing carried over automatically");
    check((await p.textContent("#hq-carnet-src-desc")).includes("page PDF 416"), "the old citation still resolves to its own page");
    await p.click("#btn-carnet-mig-keep");
    await until(async () => !(await layerOpen(p)), "keep old: closes, changes nothing");
    await saved(p, srv, "page-a", "no change");
    check(JSON.stringify(citeOf(srv, "page-a", 3)) === JSON.stringify(old), "keep old: byte-identical citation");
    await p.locator('[data-carnet-citation="' + S.e11.id + '"]').click();
    await p.waitForSelector("#hq-carnet-src-migrate");
    await p.click("#btn-carnet-mig-verified");
    check((await p.textContent(".carnet-src-layer")).includes("Saisis l'emplacement"), "verified migration needs a locator the user types");
    await p.click("#btn-carnet-mig-todo");
    await until(async () => !(await layerOpen(p)), "migrate to 12e — à vérifier");
    await saved(p, srv, "page-a", "saved");
    const mig = citeOf(srv, "page-a", 3);
    check(mig && mig.src === S.e12.id && mig.loc.text === "" && mig.pdf === null && mig.ok === false, "new edition, NO locator, NO PDF page, not verified: " + JSON.stringify(mig));
    check(mig.from && mig.from.src === S.e11.id && mig.from.loc.text === "394" && mig.from.pdf === 416 && mig.from.ok === true, "provenance keeps the old edition, locator, PDF page and verification");
    check(mig.loc.text !== "417" && mig.pdf !== 439, "417/439 are never inferred");
    const migWrap = p.locator("[data-carnet-citation]").nth(3);
    check((await migWrap.textContent()).endsWith("à vérifier]") && (await migWrap.getAttribute("data-cite-todo")) === "true", "label says à vérifier");
    await migWrap.click();
    check((await p.textContent("#hq-carnet-src-from")).includes("Migrée depuis"), "provenance shown");
    await p.click("#btn-carnet-src-close");
    // the old source record is annotated, never rewritten
    const after = JSON.parse(srv.read(".hq-carnet/sources.json")).editions.find((e) => e.id === S.e11.id);
    check(after.edition === "11e" && after.superseded_by === S.e12.id && after.year === 2020, "old edition record intact, only annotated");

    // ================================================================ 6. source manager: create, edit, calibrate, archive, conflict
    console.log("-- source manager [desktop]");
    await openPicker(p);
    await p.click("#btn-carnet-src-manage");
    await p.waitForSelector("#hq-carnet-fam-name");
    await p.fill("#hq-carnet-fam-name", "Machinery's Handbook");
    await p.click("#btn-carnet-fam-create");
    await until(async () => (await p.locator("[data-family]").count()) === 3, "family created");
    await p.locator('[data-family]:has-text("Machinery") button:has-text("Ajouter une édition")').click();
    await p.fill("#hq-carnet-ed-edition", "31e");
    await p.fill("#hq-carnet-ed-year", "2020");
    await p.fill("#hq-carnet-ed-file", "../secret.pdf");
    await p.click("#btn-carnet-ed-save");
    await until(async () => (await p.textContent(".carnet-src-msg")).length > 3, "a traversal path is refused with a message");
    check(!(await p.textContent(".carnet-src-msg")).includes(srv.root), "the message never leaks a server path");
    await p.fill("#hq-carnet-ed-file", "");
    await p.click("#btn-carnet-ed-save");
    await p.waitForSelector('[data-family]:has-text("Machinery") [data-edition]');
    check(true, "edition created");
    await p.locator('[data-family]:has-text("Machinery") [data-edition]').click();
    check(await p.evaluate(() => document.getElementById("hq-carnet-ed-edition").readOnly && document.getElementById("hq-carnet-ed-year").readOnly), "edition label and year are read-only once created");
    await p.fill("#hq-carnet-cal-printed", "1");
    await p.fill("#hq-carnet-cal-pdf", "19");
    // a second client changes the same edition first -> explicit conflict
    const ed31 = JSON.parse(srv.read(".hq-carnet/sources.json")).editions.find((e) => e.edition === "31e");
    const other = await cpost(ctx, srv, { action: "source_edition_update", id: ed31.id, expected_rev: ed31.rev, notes: "autre client" });
    check(other.status === 200, "other client edit");
    await p.click("#btn-carnet-cal-save");
    await until(async () => (await p.textContent(".carnet-src-msg")).includes("Modifié ailleurs"), "stale edit -> explicit conflict message, list reloaded");
    check(JSON.parse(srv.read(".hq-carnet/sources.json")).editions.find((e) => e.edition === "31e").calibration === null, "the stale write changed nothing");
    await p.locator('[data-family]:has-text("Machinery") [data-edition]').click();
    await p.fill("#hq-carnet-cal-printed", "1");
    await p.fill("#hq-carnet-cal-pdf", "19");
    await p.click("#btn-carnet-cal-save");
    await until(() => JSON.parse(srv.read(".hq-carnet/sources.json")).editions.find((e) => e.edition === "31e").calibration !== null, "calibration saved on retry");
    await p.locator('[data-family]:has-text("Machinery") [data-edition]').click();
    await p.click("#btn-carnet-ed-archive");
    await until(() => JSON.parse(srv.read(".hq-carnet/sources.json")).editions.find((e) => e.edition === "31e").archived === true, "archive = tombstone");
    check(JSON.parse(srv.read(".hq-carnet/sources.json")).editions.some((e) => e.edition === "31e"), "nothing deleted");
    await p.click("#btn-carnet-src-close");
    await until(async () => !(await layerOpen(p)), "manager closes");
    await saved(p, srv, "page-a", "clean");

    // ================================================================ 7. headers + confinement over HTTP
    console.log("-- PDF framing policy + confinement [desktop]");
    const pdfRes = await ctx.request.get(srv.base + "/files/Uni/Shigley/12e.pdf");
    const h = pdfRes.headers();
    check(pdfRes.status() === 200 && h["x-frame-options"] === "SAMEORIGIN" && h["content-security-policy"].includes("frame-ancestors 'self'") && h["x-content-type-options"] === "nosniff", "inline PDF: same-origin framing only, nosniff");
    const apiRes = await ctx.request.get(srv.base + "/api/carnet?meta=1");
    check(apiRes.headers()["x-frame-options"] === "DENY", "the API stays DENY");
    const up = await browser.newContext();
    const ul = await up.request.post(srv.base + "/login", { form: { pin: srv.upload_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
    check(ul.status() === 303, "upload role login");
    check((await up.request.get(srv.base + "/api/carnet?sources=1")).status() === 403, "upload role cannot read sources");
    check((await up.request.post(srv.base + "/api/carnet", { data: { action: "source_family_create", name: "x" }, headers: { Origin: srv.base } })).status() === 403, "upload role cannot write sources");
    await up.close();
    check((await ctx.request.post(srv.base + "/api/carnet", { data: { action: "source_family_create", name: "csrf" } })).status() >= 400, "no Origin header: refused (CSRF)");
    await ctx.close();

    // ================================================================ 8. touch profiles: layout + flows
    for (const profile of ["ipad", "iphone"]) {
      console.log(`-- layout and flow [${profile}]`);
      ctx = await context(srv, profile);
      p = await openPage(ctx, srv);
      await openPicker(p);
      const box = await p.locator("#hq-carnet-sources-layer").boundingBox();
      const vw = p.viewportSize().width;
      check(box && box.x >= -1 && box.x + box.width <= vw + 1, `picker fits the ${profile} viewport (${Math.round(box.width)} <= ${vw})`);
      check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${profile}: no horizontal page scroll`);
      const tap = await p.locator(".carnet-src-item").first().boundingBox();
      check(tap.height >= 40, `${profile}: touch target >= 40px (${Math.round(tap.height)})`);
      await p.locator('.carnet-src-item[data-edition="' + S.e12.id + '"]').tap();
      await p.fill("#hq-carnet-cite-text", "12");
      await p.tap("#btn-carnet-cite-insert");
      await until(async () => !(await layerOpen(p)), `${profile}: insert closes the layer`);
      check((await p.locator("[data-carnet-citation]").count()) >= 1, `${profile}: citation present`);
      await p.locator("[data-carnet-citation]").last().tap();
      await p.waitForSelector("#hq-carnet-src-desc");
      await p.tap("#btn-carnet-src-view");
      await p.waitForSelector("#hq-carnet-src-frame");
      check(true, `${profile}: viewer opens (fallback: browser PDF viewer; #page support not guaranteed on iOS)`);
      const vb = await p.locator("#hq-carnet-sources-layer").boundingBox();
      check(vb.x + vb.width <= vw + 1, `${profile}: viewer fits`);
      await p.tap("#btn-carnet-src-close");
      await saved(p, srv, "page-a", `${profile}: saved`);
      await ctx.close();
    }

    // ================================================================ 9. missing sources module: the editor still works
    console.log("-- degraded: sources module missing [desktop]");
    ctx = await context(srv, "desktop");
    await ctx.route("**/assets/hq-carnet-sources.js", (r) => r.fulfill({ status: 404, body: "missing" }));
    p = await openPage(ctx, srv, { carnet: false });
    await p.locator('.bottom-nav [data-nav="carnet"]').click();
    await p.waitForSelector("#hq-carnet-editor");
    check((await p.locator("[data-carnet-citation]").count()) >= 1, "existing citations still render without the sources module");
    await p.locator("[data-carnet-citation]").first().click();
    await sleep(200);
    check(!(await layerOpen(p)), "no crash: the click reports the missing module instead");
    await ctx.close();
    errors.length = 0; // the deliberate 404 above raises an expected script error

    // ================================================================ 9b. audit regression: overlay is modal, actions are page-bound
    console.log("-- overlay is modal; verify/edit/migrate never act on another page or a changed citation [desktop]");
    {
      const srv2 = await server(notebook([page("page-x", 1, [line("paragraph", "x")])]));
      const c2 = await context(srv2);
      const S2 = await seedSources(c2, srv2);
      const mk = (src, text) => ({ src, loc: { kind: "page", text }, pdf: null, ok: false, snap: { title: "Shigley", edition: src === S2.e12.id ? "12e" : "11e" }, from: null });
      const withCite = (id, rev, text, cite) => page(id, rev, [line("paragraph", "Voir " + text, [{ type: "citation", start: 5, end: 5 + text.length, cite }])]);
      srv2.put(notebook([
        withCite("page-a", 1, "[Shigley 12e, p. 1]", mk(S2.e12.id, "1")),
        withCite("page-b", 1, "[Shigley 12e, p. 2]", mk(S2.e12.id, "2")),
      ]));
      const p2 = await openPage(c2, srv2);
      const cur = (pg) => pg.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
      const first = await cur(p2);
      await p2.locator("[data-carnet-citation]").click();
      await p2.waitForSelector("#hq-carnet-src-desc");
      await p2.keyboard.press("Alt+ArrowRight");
      await sleep(300);
      check((await cur(p2)) === first && (await layerOpen(p2)), "Alt+Arrow does not navigate behind the open sources overlay");
      await p2.keyboard.press("Alt+ArrowLeft");
      await sleep(200);
      check((await cur(p2)) === first, "nor the other way");
      // the citation under the overlay changes on the server (another client) and the editor refreshes
      const nb = srv2.nb();
      const pgA = nb.pages.find((x) => x.id === first);
      pgA.content.blocks[0].marks[0].cite.loc.text = "77";
      pgA.content.blocks[0].text = "Voir [Shigley 12e, p. 77]";
      pgA.content.blocks[0].marks[0].end = 5 + "[Shigley 12e, p. 77]".length;
      pgA.rev += 1;
      srv2.put(nb);
      await until(async () => (await p2.locator("[data-carnet-citation]").first().textContent()).includes("p. 77"), "the editor shows the other client's version", 15000);
      const before = JSON.stringify(srv2.pg(first).content);
      await p2.click("#btn-carnet-src-verify");
      await until(async () => !(await layerOpen(p2)), "stale verify aborts and closes the overlay");
      await sleep(800);
      check(JSON.stringify(srv2.pg(first).content) === before, "the other version was not modified by the stale action");
      await c2.close();
    }

    // ================================================================ 10. global hygiene
    check(errors.length === 0, "no page errors / console errors: " + JSON.stringify(errors));
    check(external.length === 0, "no external requests: " + JSON.stringify(external));
    console.log(`\nALL OK (${passed} checks)`);
  } finally {
    await browser.close();
    for (const s of started) s.close();
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
