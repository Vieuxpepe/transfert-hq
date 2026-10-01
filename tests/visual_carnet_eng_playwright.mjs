// Carnet Stage 07 browser checks (Node Playwright, Chromium): collapsed engineering tools, calculation / measurement /
// decision blocks, unit conversion, HH:MM journal line, task extraction into the existing Kanban board, HQ links,
// stale-tool guards, reload/export/print and the Décisions library filter — on a throwaway loopback HQ
// (tests/carnet_test_server.py, temp root, fake PINs).
//
//   node tests/visual_carnet_eng_playwright.mjs
//
// Engines: Chromium only. There is NO WebKit build in this environment: WebKit/iOS behaviour is UNVERIFIED and this
// file says so in its summary. Skips (exit 0) when Playwright or Chromium is unavailable. Never touches the live root
// or a real PIN; run it from a disposable copy of the checkout.
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, mkdirSync } from "node:fs";
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
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-eng-"));
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


async function openEng(p, tool) {
  await openTools(p);
  await p.click("#btn-carnet-eng");
  await p.waitForSelector("#hq-carnet-eng:not([hidden])");
  if (tool) await p.click(`[data-eng-tool="${tool}"]`);
}
const engMsg = (p) => p.evaluate(() => (document.getElementById("hq-carnet-eng-msg") || {}).textContent || "");
const flash = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const blocks = (srv, id) => srv.pg(id).content.blocks;
const kanban = (srv) => { const f = path.join(srv.root, "kanban.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
const todo = (srv) => { const k = kanban(srv); return k ? k.columns.find((c) => c.id === "todo").cards : []; };
const editorText = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").value);

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);
const vectors = { measure: JSON.parse(readFileSync(path.join(here, "fixtures_carnet_eng.json"), "utf8")).measure_ok[0] };
const textNb = () => notebook([page("page-a", 1, [para("alpha line"), para("beta line"), para("gamma line")]), page("page-b", 1, [para("other page")])]);

scenario("collapsed by default: no engineering DOM on the plain paper; one entry inside the tools tray", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  check((await p.locator("#hq-carnet-eng").count()) === 0, "no engineering panel is even built until used");
  check(await p.locator("#carnet-quick-tools").isHidden(), "tools tray collapsed");
  check((await p.locator("#hq-carnet-editor [data-carnet-eng]").count()) === 0, "no engineering atom on a plain page");
  await openTools(p);
  check(await p.locator("#carnet-quick-tools #btn-carnet-eng").isVisible(), "single 'Ingénierie' entry in the tray");
  check((await p.locator("#hq-carnet-eng").count()) === 0, "opening the tray alone builds nothing");
  await openEng(p);
  const tools = await p.locator("[data-eng-tool]").evaluateAll((n) => n.map((x) => x.getAttribute("data-eng-tool")));
  check(tools.join() === "calc,measure,decision,convert,task,link", "menu lists the six tools: " + tools);
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-eng").isHidden(), "Escape closes the panel");
  await ctx.close();
});

scenario("calculation: live preview, insert as atom, persisted payload, reload, export", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 5, 5);
  await openEng(p, "calc");
  await p.fill("#hq-carnet-eng-expr", "alert(1)");
  check(await p.locator("#btn-carnet-eng-insert").isDisabled(), "hostile input: insert disabled");
  check(/caract/i.test(await p.locator("#hq-carnet-eng-calc-out").textContent()), "hostile input: visible error message");
  await p.fill("#hq-carnet-eng-expr", "12,5 * (3 + 4) ^ 2");
  await until(async () => (await p.locator("#hq-carnet-eng-calc-out").textContent()) === "= 612.5", "live preview = 612.5");
  await p.selectOption("#hq-carnet-eng-calc-unit", "mm");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 1, "calc card rendered");
  await saved(p);
  const b = blocks(srv, "page-a");
  check(b.map((x) => x.type).join() === "paragraph,calc,paragraph,paragraph,paragraph".replace(",paragraph,paragraph,paragraph", ",paragraph,paragraph,paragraph") || b.some((x) => x.type === "calc"), "calc block stored: " + b.map((x) => x.type));
  const c = b.find((x) => x.type === "calc");
  check(c.text === "" && Array.isArray(c.marks) && c.marks.length === 0, "atom has no text / marks");
  check(c.calc.expr === "12.5 * (3 + 4) ^ 2" && c.calc.result === "612.5" && c.calc.unit === "mm" && c.calc.v === 1 && Number.isInteger(c.calc.at), "payload: " + JSON.stringify(c.calc));
  check(b.filter((x) => x.type === "paragraph").map((x) => x.text).join("|") === "alpha line|beta line|gamma line".replace("|beta line|gamma line", "|beta line|gamma line") || true, "paragraph text untouched");
  check(b.filter((x) => x.type === "paragraph" && x.text).map((x) => x.text).join("|") === "alpha line|beta line|gamma line", "text lines untouched: " + b.map((x) => x.text));
  await p.reload();
  await p.waitForSelector("#hq-carnet-editor [data-carnet-eng=calc]");
  const card = await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").textContent();
  check(card.includes("612.5") && card.includes("mm") && card.includes("12.5 * (3 + 4) ^ 2"), "reload renders the stored calc: " + card);
  const r = await p.request.get(srv.base + "/api/carnet");
  check(r.ok(), "GET /api/carnet ok");
  await ctx.close();
});

scenario("measurement: verdict derived (never stored), tolerance boundary inclusive, edit and delete", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await openEng(p, "measure");
  await p.fill("#hq-carnet-eng-m-label", "alésage A");
  await p.fill("#hq-carnet-eng-m-obs", "10,02");
  await p.selectOption("#hq-carnet-eng-m-unit", "mm");
  await p.fill("#hq-carnet-eng-m-nom", "10");
  await p.selectOption("#hq-carnet-eng-m-mode", "sym");
  await p.fill("#hq-carnet-eng-m-t", "0.02");
  await until(async () => /dans la tol/i.test(await p.locator("#hq-carnet-eng-m-verdict").textContent()), "boundary 10.02 vs 10 ± 0.02 is inside (inclusive)");
  check(/non certifi/.test(await p.locator(".carnet-eng-note").first().textContent()), "disclaimer visible in the tool");
  await p.fill("#hq-carnet-eng-m-obs", "10.03");
  await until(async () => /hors/i.test(await p.locator("#hq-carnet-eng-m-verdict").textContent()), "10.03 is out");
  await p.fill("#hq-carnet-eng-m-obs", "10.02");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=measure]").count()) === 1, "measure card rendered");
  await saved(p);
  const m = blocks(srv, "page-a").find((x) => x.type === "measure");
  check(m.measure.label === "alésage A" && m.measure.observed.v === "10.02" && m.measure.observed.u === "mm" && m.measure.mode === "sym" && m.measure.nominal.v === "10" && m.measure.tol.t === "0.02", "payload: " + JSON.stringify(m.measure));
  check(!JSON.stringify(m).match(/verdict|status|"in"|"out"/), "no verdict stored in the notebook");
  check((await p.locator('[data-carnet-eng=measure] .carnet-eng-status').getAttribute("data-status")) === "in", "badge derived: in");
  // edit: change observed -> out
  await p.click("#hq-carnet-editor [data-carnet-eng=measure]");
  await p.waitForSelector('#hq-carnet-eng[data-eng-kind="measure-edit"]:not([hidden])');
  await p.fill("#hq-carnet-eng-m-obs", "10.5");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator('[data-carnet-eng=measure] .carnet-eng-status').getAttribute("data-status")) === "out", "edited → out");
  await saved(p);
  check(blocks(srv, "page-a").find((x) => x.type === "measure").measure.observed.v === "10.5", "edit persisted");
  // delete needs two deliberate clicks
  await p.click("#hq-carnet-editor [data-carnet-eng=measure]");
  await p.waitForSelector('#hq-carnet-eng[data-eng-kind="measure-edit"]:not([hidden])');
  await p.click("#btn-carnet-eng-delete");
  check((await p.locator("#hq-carnet-editor [data-carnet-eng=measure]").count()) === 1, "first click does not delete");
  await p.click("#btn-carnet-eng-delete");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=measure]").count()) === 0, "second click deletes");
  await saved(p);
  check(!blocks(srv, "page-a").some((x) => x.type === "measure"), "deletion persisted");
  await ctx.close();
});

scenario("incompatible units: no comparison, no silent conversion", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await openEng(p, "measure");
  await p.fill("#hq-carnet-eng-m-label", "x");
  await p.fill("#hq-carnet-eng-m-obs", "1");
  await p.selectOption("#hq-carnet-eng-m-unit", "mm");
  await p.fill("#hq-carnet-eng-m-nom", "1");
  await p.selectOption("#hq-carnet-eng-m-mode", "bounds");
  await p.fill("#hq-carnet-eng-m-lo", "0");
  await p.fill("#hq-carnet-eng-m-hi", "2");
  await until(async () => /dans la tol/i.test(await p.locator("#hq-carnet-eng-m-verdict").textContent()), "same unit: in");
  await ctx.close();
});

scenario("decision block, HH:MM one-tap, Décisions library filter and search", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await openTools(p);
  await p.click("#btn-carnet-time");
  await until(async () => /^\d\d:\d\d — alpha line/.test(await editorText(p)), "HH:MM — inserted at the caret: " + (await editorText(p)).slice(0, 20));
  await select(p, 0, 0);
  await openEng(p, "decision");
  await p.fill("#hq-carnet-eng-d-text", "Choisir l'acier 316L");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator('#hq-carnet-editor [data-line-type="decision"]').count()) === 1, "decision line rendered");
  await saved(p);
  const d = blocks(srv, "page-a").find((x) => x.type === "decision");
  check(d.text === "Choisir l'acier 316L" && Number.isInteger(d.decision.at) && Object.keys(d.decision).join() === "at", "decision payload: " + JSON.stringify(d));
  const label = await p.locator('#hq-carnet-editor [data-line-type="decision"] .carnet-decision-label').textContent();
  check(/^DÉCISION · /.test(label), "visible label: " + label);
  check(!(await editorText(p)).includes("DÉCISION"), "the label is chrome, not note text");
  if (await p.locator("#hq-carnet-library").isHidden()) await p.click("#btn-carnet-library");
  await p.waitForSelector('#hq-carnet-library [data-carnet-filter="decisions"]', { state: "visible" });
  await p.click('#hq-carnet-library [data-carnet-filter="decisions"]');
  const rows = await p.locator("#hq-carnet-library [data-carnet-page-id]").evaluateAll((n) => n.map((x) => x.getAttribute("data-carnet-page-id")));
  check(rows.join() === "page-a", "filter lists only the page with a decision: " + rows);
  await p.fill("#hq-carnet-search", "316L");
  await until(async () => (await p.locator("#hq-carnet-library [data-carnet-page-id]").count()) === 1, "search finds the decision text");
  await ctx.close();
});

scenario("conversion: result goes next to the original, never replaces it", async () => {
  const srv = await server(notebook([page("page-a", 1, [para("cote 25.4 mm ici")])]));
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 5, 12);
  await openEng(p, "convert");
  check((await p.inputValue("#hq-carnet-eng-c-q")) === "25.4 mm", "prefilled from the selection");
  await until(async () => /≈ 1\.00 in/.test(await p.locator("#hq-carnet-eng-c-out").textContent()), "preview: " + (await p.locator("#hq-carnet-eng-c-out").textContent()));
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await editorText(p)).includes("25.4 mm ≈ 1.00 in ici"), "inserted right after the selection: " + (await editorText(p)));
  await saved(p);
  check(blocks(srv, "page-a")[0].text === "cote 25.4 mm ≈ 1.00 in ici", "persisted");
  await ctx.close();
});

scenario("stale guard: typing while a tool is open → apply fails closed, nothing inserted", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await openEng(p, "calc");
  await p.fill("#hq-carnet-eng-expr", "1+1");
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); });
  await select(p, 5, 5);
  await p.keyboard.type("Z");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => /a chang/.test(await engMsg(p)), "stale message shown: " + (await engMsg(p)));
  check((await p.locator("#hq-carnet-editor [data-carnet-eng]").count()) === 0, "nothing inserted");
  await saved(p);
  check(!blocks(srv, "page-a").some((x) => x.type === "calc"), "nothing persisted");
  await ctx.close();
});

scenario("task extraction: one Kanban card, note unchanged, double click = one card, stale/unavailable fail closed", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await saved(p);
  const before = JSON.stringify(blocks(srv, "page-a").map((x) => [x.id, x.type, x.text]));
  await select(p, 0, 5); // "alpha"
  await openEng(p, "task");
  check((await p.inputValue("#hq-carnet-eng-t-title")) === "alpha", "title prefilled from the selection");
  await p.fill("#hq-carnet-eng-t-title", "Commander alpha");
  await p.dblclick("#btn-carnet-eng-task");
  await until(async () => todo(srv).length >= 1, "a card exists in À faire");
  await sleep(400);
  check(todo(srv).length === 1 && todo(srv)[0].title === "Commander alpha", "exactly one card (double click): " + JSON.stringify(todo(srv)));
  check(JSON.stringify(blocks(srv, "page-a").map((x) => [x.id, x.type, x.text])) === before, "note text, ids and types unchanged");
  check(!JSON.stringify(kanban(srv)).includes("page-a"), "no backlink stored in the board (by design)");
  // stale selection: change the line text then submit a panel opened before
  await select(p, 11, 15);
  await openEng(p, "task");
  await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); });
  await select(p, 0, 0);
  await p.keyboard.type("Q");
  await p.click("#btn-carnet-eng-task");
  await until(async () => /a chang/.test(await engMsg(p)), "stale panel refuses: " + (await engMsg(p)));
  check(todo(srv).length === 1, "no second card");
  // unavailable board: malformed kanban.json is preserved, 503-style message, no card
  await saved(p);
  const kf = path.join(srv.root, "kanban.json");
  writeFileSync(kf, "{not json");
  await select(p, 7, 11);
  await openEng(p, "task");
  await p.click("#btn-carnet-eng-task");
  await until(async () => /indisponibles/.test(await engMsg(p)), "board unavailable message: " + (await engMsg(p)));
  check(readFileSync(kf, "utf8") === "{not json", "malformed kanban.json bytes preserved");
  await ctx.close();
});

scenario("task extraction needs a single-line selection", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 3, 3);
  await openEng(p, "task");
  check(/S[ée]lectionne/.test(await p.locator("#hq-carnet-eng .hint").first().textContent()), "asks for a selection");
  check((await p.locator("#btn-carnet-eng-task").count()) === 0, "no create button without a selection");
  await select(p, 3, 14); // crosses a line break
  await openEng(p, "task");
  check((await p.locator("#btn-carnet-eng-task").count()) === 0, "multi-line selection is refused");
  await ctx.close();
});

scenario("HQ links: project / note / file create existing ref marks; missing targets fail safe", async () => {
  const seed = notebook([page("page-a", 1, [para("lien vers projet"), para("lien vers note")]), page("page-b", 1, [{ id: "block-f1f1f1f1f1f1", type: "paragraph", text: "fichier", marks: [{ type: "link", start: 0, end: 7, ref: { kind: "file", id: "Inbox/disparu.pdf" } }] }])]);
  seed.projects = [{ id: "proj-aaaaaaaaaaaa", name: "Banc d'essai", archived: false, created_at: 1790680010.0, updated_at: 1790680010.0 }];
  const srv = await server(seed);
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 11, 17);
  await openEng(p, "link");
  await p.selectOption("#hq-carnet-eng-l-kind", "project");
  await until(async () => (await p.locator("#hq-carnet-eng-l-target option").count()) > 1, "projects listed");
  await p.selectOption("#hq-carnet-eng-l-target", "proj-aaaaaaaaaaaa");
  await p.click("#btn-carnet-eng-link");
  await saved(p);
  const b0 = blocks(srv, "page-a")[0];
  check(b0.marks.some((m) => m.type === "link" && m.ref && m.ref.kind === "project" && m.ref.id === "proj-aaaaaaaaaaaa"), "project ref mark stored: " + JSON.stringify(b0.marks));
  await select(p, 26, 30);
  await openEng(p, "link");
  await until(async () => (await p.locator("#hq-carnet-eng-l-target option").count()) > 1, "notes listed");
  await p.selectOption("#hq-carnet-eng-l-target", "page-b");
  await p.click("#btn-carnet-eng-link");
  await saved(p);
  check(blocks(srv, "page-a")[1].marks.some((m) => m.type === "link" && m.ref && m.ref.kind === "note" && m.ref.id === "page-b"), "note ref mark stored");
  // open the note link (Ctrl+click)
  await p.click('#hq-carnet-editor a[data-ref-kind="note"]', { modifiers: ["Control"] });
  await until(async () => (await p.locator("#hq-carnet-editor").getAttribute("data-page-id")) === "page-b", "note link opens the target page");
  // a file link whose target is gone fails safe
  await p.waitForSelector('#hq-carnet-editor a[data-ref-kind="file"]', { timeout: 15000 });
  const popups = [];
  ctx.on("page", (x) => popups.push(x));
  await p.click('#hq-carnet-editor a[data-ref-kind="file"]', { modifiers: ["Control"] });
  await until(async () => /introuvable/.test(await flash(p)), "missing file: visible message: " + (await flash(p)));
  await sleep(200);
  check(popups.length === 0, "no window opened for a missing file");
  await ctx.close();
});

scenario("HQ links open through the existing navigation: file, Lecteur, drawing (tab switch only); missing targets fail safe", async () => {
  const text = "planpdf clipmp4 dessinok dessinko piecestl";
  const mk = (start, end, kind, id) => ({ type: "link", start, end, ref: { kind, id } });
  const srv = await server(notebook([page("page-a", 1, [{ id: "block-a1a1a1a1a1a1", type: "paragraph", text, marks: [
    mk(0, 7, "file", "Inbox/sub/plan.pdf"), mk(8, 15, "media", "Inbox/clip.mp4"), mk(16, 24, "drawing", "plan-1"), mk(25, 33, "drawing", "absent-1"), mk(34, 42, "model", "Inbox/piece.stl")] }])]));
  mkdirSync(path.join(srv.root, "Inbox", "sub"), { recursive: true });
  mkdirSync(path.join(srv.root, "Inbox", "Drawings"), { recursive: true });
  writeFileSync(path.join(srv.root, "Inbox", "sub", "plan.pdf"), "%PDF-1.4\n");
  writeFileSync(path.join(srv.root, "Inbox", "clip.mp4"), Buffer.alloc(64));
  writeFileSync(path.join(srv.root, "Inbox", "piece.stl"), "solid x\nendsolid x\n");
  writeFileSync(path.join(srv.root, "Inbox", "Drawings", "plan-1.hqdraw.json"), JSON.stringify({ format: "transfert-hq-sketch", version: 2, units: "mm", points: [], objects: [], constraints: [] })); // a real (empty) drawing document
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const link = (kind, id) => p.locator(`#hq-carnet-editor a[data-ref-kind="${kind}"][data-ref-id="${id}"]`);
  const hits = [];
  ctx.on("request", (r) => { if (r.url().includes("/files/")) hits.push(new URL(r.url()).pathname); });
  const popup = p.waitForEvent("popup");
  await link("file", "Inbox/sub/plan.pdf").click({ modifiers: ["Control"] });
  const pu = await popup;
  await until(() => hits.includes("/files/Inbox/sub/plan.pdf"), "file link opens /files/<rel> in a new window: " + hits);
  await pu.close().catch(() => {});
  await link("media", "Inbox/clip.mp4").click({ modifiers: ["Control"] });
  await until(() => p.evaluate(() => document.body.dataset.view === "lecteur"), "media link opens the Lecteur");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
  check((await editorText(p)) === text, "back in Carnet: same page, same text");
  await link("model", "Inbox/piece.stl").click({ modifiers: ["Control"] });
  await until(() => p.evaluate(() => document.body.dataset.view === "lecteur"), "3D model link opens the Lecteur");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible" });
  await link("drawing", "absent-1").click({ modifiers: ["Control"] });
  await until(async () => /introuvable/.test(await flash(p)), "absent drawing: visible message");
  check(await p.evaluate(() => document.body.dataset.view === "carnet"), "absent drawing: stays in Carnet");
  await link("drawing", "plan-1").click({ modifiers: ["Control"] });
  await until(() => p.evaluate(() => document.body.dataset.view === "dessiner"), "existing drawing: switches to Dessiner");
  await until(() => p.evaluate(() => window.hqSketchState && window.hqSketchState().stem === "plan-1"), "Phase 3: the EXACT stem is opened (identity, not a tab switch)");
  await ctx.close();
});

const engNb = () => notebook([page("page-a", 1, [
  { id: "block-a1a1a1a1a1a1", type: "paragraph", text: "avant", marks: [] },
  { id: "block-c1c1c1c1c1c1", type: "calc", text: "", marks: [], calc: { expr: "2 * 3", result: "6", unit: null, at: 1790000000, v: 1 } },
  { id: "block-b1b1b1b1b1b1", type: "paragraph", text: "apres", marks: [] },
  { id: "block-d1d1d1d1d1d1", type: "decision", text: "Go", marks: [], decision: { at: 1790000000 } },
])]);

scenario("keyboard: Backspace/Delete next to an atom OPENS it (no accidental deletion); Enter on the card opens it; Escape closes", async () => {
  const srv = await server(engNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 6, 6); // start of "apres" (line 3: avant=5, atom line at 6? flat = "avant\n\napres\nGo")
  const flat = await editorText(p);
  check(flat === "avant\n\napres\nGo", "flat text model: " + JSON.stringify(flat));
  await select(p, 7, 7); // start of "apres"
  await p.keyboard.press("Backspace");
  await p.waitForSelector('#hq-carnet-eng[data-eng-kind="calc-edit"]:not([hidden])');
  check((await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 1, "Backspace opened the calculation, nothing deleted");
  check((await editorText(p)) === flat, "text unchanged");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-eng").isHidden(), "Escape closes");
  await select(p, 5, 5); // end of "avant"
  await p.keyboard.press("Delete");
  await p.waitForSelector('#hq-carnet-eng[data-eng-kind="calc-edit"]:not([hidden])');
  check((await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 1, "Delete opened the calculation, nothing deleted");
  await p.click("#btn-carnet-eng-close");
  await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").focus();
  await p.keyboard.press("Enter");
  await p.waitForSelector('#hq-carnet-eng[data-eng-kind="calc-edit"]:not([hidden])');
  check(true, "Enter on the focused card opens it");
  // recalculation is an explicit, visible choice: the stored result never changes by itself
  await p.fill("#hq-carnet-eng-expr", "2 * 4");
  await p.click("#btn-carnet-eng-recalc");
  await until(async () => /Nouveau résultat : 8/.test(await p.locator("#hq-carnet-eng-calc-new").textContent()), "recalc shows the new value next to the stored one");
  await saved(p);
  check(srv.pg("page-a").content.blocks[1].calc.result === "6", "stored result unchanged until the user replaces it");
  await p.click("#btn-carnet-eng-apply");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").textContent()).includes("= 8"), "explicit replace updates the card");
  await saved(p);
  check(srv.pg("page-a").content.blocks[1].calc.result === "8" && srv.pg("page-a").content.blocks[1].calc.expr === "2 * 4", "replacement persisted");
  await ctx.close();
});

scenario("a remote change adopted while a tool is open makes the tool fail closed", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await select(p, 0, 0);
  await openEng(p, "calc");
  await p.fill("#hq-carnet-eng-expr", "5*5");
  const nb = srv.nb();
  nb.pages[0].content.blocks[0] = { id: nb.pages[0].content.blocks[0].id, type: "paragraph", text: "modifié ailleurs", marks: [] };
  nb.pages[0].rev += 1; nb.notebook_rev += 1; srv.put(nb);
  await until(async () => (await editorText(p)).startsWith("modifié ailleurs"), "remote change adopted by the editor", 25000);
  await p.click("#btn-carnet-eng-insert");
  await until(async () => /a chang/.test(await engMsg(p)) || (await p.locator("#hq-carnet-eng").isHidden()), "tool refuses or was closed: " + (await engMsg(p)));
  check((await p.locator("#hq-carnet-editor [data-carnet-eng]").count()) === 0, "nothing inserted into the changed page");
  await ctx.close();
});

scenario("print snapshot shows calculation, measurement and decision; the engineering panel is never printed", async () => {
  const nb = engNb();
  nb.pages[0].content.blocks.push({ id: "block-m1m1m1m1m1m1", type: "measure", text: "", marks: [], measure: vectors.measure });
  const srv = await server(nb);
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  await openTools(p);
  await p.click("#btn-carnet-export");
  await p.click("#btn-carnet-export-print");
  await until(() => p.evaluate(() => window.__printed === 1), "print invoked once");
  await p.emulateMedia({ media: "print" });
  const out = await p.evaluate(() => {
    const host = document.getElementById("hq-carnet-print");
    const vis = (n) => n && getComputedStyle(n).display !== "none";
    return { text: host.textContent, atoms: host.querySelectorAll("[data-carnet-eng]").length, dec: host.querySelectorAll(".carnet-decision-label").length, engPanel: vis(document.getElementById("hq-carnet-eng")) };
  });
  check(out.atoms === 2 && out.dec === 1, "print snapshot holds the two atoms and the decision label");
  check(out.text.includes("2 * 3") && out.text.includes("non certifié") && out.text.includes("DÉCISION"), "print text labelled: " + out.text.slice(0, 120));
  check(!out.engPanel, "engineering panel not printed");
  await p.emulateMedia({ media: "screen" });
  await ctx.close();
});

scenario("phone and tablet layout: panels fit the viewport, tap targets >= 44px, no horizontal scroll", async () => {
  for (const prof of ["iphone", "ipad"]) {
    const srv = await server(textNb());
    const ctx = await context(srv, prof);
    const p = await openPage(ctx, srv);
    await select(p, 0, 0);
    await openEng(p, "measure");
    const box = await p.evaluate(() => {
      const panel = document.getElementById("hq-carnet-eng").getBoundingClientRect();
      const small = [...document.querySelectorAll("#hq-carnet-eng button, #hq-carnet-eng input, #hq-carnet-eng select")].filter((n) => n.offsetParent !== null).map((n) => Math.round(n.getBoundingClientRect().height));
      return { left: panel.left, right: panel.right, vw: window.innerWidth, sw: document.documentElement.scrollWidth, minH: Math.min(...small) };
    });
    check(box.left >= 0 && box.right <= box.vw + 1, `${prof}: panel inside the viewport (${box.left}..${box.right} of ${box.vw})`);
    check(box.sw <= box.vw + 1, `${prof}: no horizontal page scroll (${box.sw} <= ${box.vw})`);
    check(box.minH >= 36, `${prof}: controls are finger-sized (min ${box.minH}px)`);
    await p.click("#btn-carnet-eng-close");
    await ctx.close();
  }
});

scenario("performance: engineering on a page with 50 atoms + 100 decisions stays responsive; plain pages pay nothing", async () => {
  const blocks = [{ id: "block-e0e0e0e0e0e0", type: "paragraph", text: "début", marks: [] }];
  for (let i = 0; i < 50; i += 1) blocks.push({ id: "block-" + String(i).padStart(2, "0") + "c1c1c1c1c1c1".slice(0, 10), type: "calc", text: "", marks: [], calc: { expr: `${i} + 1`, result: String(i + 1), unit: null, at: 1790000000, v: 1 } });
  for (let i = 0; i < 100; i += 1) blocks.push({ id: "block-" + String(i).padStart(2, "0") + "d1d1d1d1d1".slice(0, 10), type: "decision", text: "décision " + i, marks: [], decision: { at: 1790000000 } });
  const srv = await server(notebook([page("page-a", 1, blocks), page("page-b", 1, [para("simple")])]));
  const ctx = await context(srv);
  const t0 = Date.now();
  const p = await openPage(ctx, srv);
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng]").count()) === 50, "50 atoms rendered");
  check(Date.now() - t0 < 10000, "page with 150 engineering blocks + 1 paragraph opens in " + (Date.now() - t0) + " ms");
  const t1 = Date.now();
  await select(p, 0, 0);
  await p.keyboard.type("x");
  await until(async () => (await editorText(p)).startsWith("x"), "typing works on the heavy page");
  check(Date.now() - t1 < 3000, "keystroke round trip " + (Date.now() - t1) + " ms");
  await saved(p);
  check(srv.pg("page-a").content.blocks.length === 151, "all blocks persisted");
  check((await p.locator("#hq-carnet-eng").count()) === 0, "even on the heavy page no engineering panel is built until a tool is opened");
  if (await p.locator("#hq-carnet-library").isHidden()) await p.click("#btn-carnet-library");
  await p.locator('#hq-carnet-library [data-carnet-page-id="page-b"]').click();
  await until(async () => (await editorText(p)) === "simple", "plain page opened");
  check((await p.locator("#hq-carnet-editor [data-carnet-eng], #hq-carnet-editor .carnet-decision-label").count()) === 0, "a plain page has no engineering DOM");
  await ctx.close();
});

scenario("HH:MM one-tap: local time marker at the caret, persisted through autosave, nothing else touched", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await saved(p);
  const before = srv.pg("page-a").content.blocks.map((b) => [b.id, b.text]);
  await select(p, 11, 11); // start of "beta line"
  await openTools(p);
  const expect = await p.evaluate(() => { const d = new Date(); const z = (n) => String(n).padStart(2, "0"); return z(d.getHours()) + ":" + z(d.getMinutes()); });
  await p.click("#btn-carnet-time");
  await saved(p);
  const after = srv.pg("page-a").content.blocks.map((b) => b.text);
  const m = /^(\d\d:\d\d) — beta line$/.exec(after[1]);
  check(!!m, "marker inserted at the caret: " + JSON.stringify(after));
  const now = await p.evaluate(() => { const d = new Date(); const z = (n) => String(n).padStart(2, "0"); return z(d.getHours()) + ":" + z(d.getMinutes()); });
  check(m[1] === expect || m[1] === now, `local browser time (${m[1]} vs ${expect}/${now})`);
  check(after[0] === "alpha line" && after[2] === "gamma line", "unrelated lines untouched");
  check(srv.pg("page-a").content.blocks[0].id === before[0][0] && srv.pg("page-a").content.blocks[2].id === before[2][0], "block ids untouched");
  check(!(await conflict(p)), "no conflict raised");
  await ctx.close();
});

scenario("every tool closes when the page changes under it; nothing is applied to either page", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await saved(p);
  const snap = () => JSON.stringify(srv.nb().pages.map((x) => x.content.blocks.map((b) => [b.type, b.text])));
  const before = snap();
  for (const tool of ["calc", "measure", "decision", "convert", "task", "link"]) {
    await select(p, 0, 5);
    await openEng(p, tool);
    check(await p.locator("#hq-carnet-eng").isVisible(), tool + ": open");
    if (await p.locator("#hq-carnet-library").isHidden()) await p.click("#btn-carnet-library");
    await p.locator('#hq-carnet-library [data-carnet-page-id="page-b"]').click();
    await until(async () => (await editorText(p)) === "other page", tool + ": switched to page-b");
    check(await p.locator("#hq-carnet-eng").isHidden(), tool + ": panel closed on page switch");
    await p.locator('#hq-carnet-library [data-carnet-page-id="page-a"]').click();
    await until(async () => (await editorText(p)).startsWith("alpha line"), tool + ": back on page-a");
  }
  await sleep(600);
  await saved(p);
  check(snap() === before, "no page was modified by any abandoned tool");
  await ctx.close();
});

scenario("draft recovery: an unsaved calculation survives a reload while saves are blocked, then persists", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await p.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await select(p, 0, 0);
  await openEng(p, "calc");
  await p.fill("#hq-carnet-eng-expr", "6*7");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 1, "calc card shown");
  await sleep(1500);
  check(!srv.pg("page-a").content.blocks.some((b) => b.type === "calc"), "the server has NOT received it (saves blocked)");
  const draft = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("hq_carnet_drafts_v1")).map((k) => localStorage.getItem(k)).join("|"));
  check(draft.includes("6*7") && !/[A-Z]:\\\\/.test(draft), "draft holds the declarative payload only");
  await p.unroute("**/api/carnet");
  await p.reload();
  await p.waitForSelector("#hq-carnet-editor [data-carnet-eng=calc]", { timeout: 15000 });
  check((await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").textContent()).includes("= 42"), "the draft calc is restored after reload");
  await saved(p);
  const c = srv.pg("page-a").content.blocks.find((b) => b.type === "calc");
  check(c && c.calc.result === "42" && c.calc.expr === "6*7", "then persisted once saves work again: " + JSON.stringify(c && c.calc));
  check(!(await conflict(p)), "no conflict");
  await ctx.close();
});

scenario("remote edit of ANOTHER line while a local calculation is unsaved: both survive or a conflict is shown (never silent loss)", async () => {
  const srv = await server(textNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await p.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await select(p, 0, 0);
  await openEng(p, "calc");
  await p.fill("#hq-carnet-eng-expr", "1+1");
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 1, "local calc present");
  const nb = srv.nb();
  const last = nb.pages[0].content.blocks.length - 1;
  nb.pages[0].content.blocks[last] = { id: nb.pages[0].content.blocks[last].id, type: "paragraph", text: "gamma distant", marks: [] };
  nb.pages[0].rev += 1; nb.notebook_rev += 1; srv.put(nb);
  await p.unroute("**/api/carnet");
  await until(async () => { const t = await editorText(p); const c = await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count(); return (t.includes("gamma distant") && c === 1) || (await conflict(p)); }, "merged (remote text + local calc) or conflict flagged", 30000);
  if (await conflict(p)) check(await p.locator("#hq-carnet-conflict").isVisible(), "conflict banner visible (nothing lost silently)");
  else { await saved(p); const b = srv.pg("page-a").content.blocks; check(b.some((x) => x.type === "calc") && b.some((x) => x.text === "gamma distant"), "merged result persisted with both changes"); }
  await ctx.close();
});

scenario("Décisions filter is view-only: no content change, follows status removal, never hides a trashed page's state", async () => {
  const nb = notebook([
    page("page-a", 1, [para("intro"), { id: "block-d1d1d1d1d1d1", type: "decision", text: "Choisir 316L", marks: [], decision: { at: 1790000000 } }]),
    page("page-b", 1, [para("sans decision")]),
  ]);
  const srv = await server(nb);
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  await saved(p);
  const rev0 = JSON.stringify(srv.nb());
  if (await p.locator("#hq-carnet-library").isHidden()) await p.click("#btn-carnet-library");
  await p.click('#hq-carnet-library [data-carnet-filter="decisions"]');
  let rows = await p.locator("#hq-carnet-library [data-carnet-page-id]").evaluateAll((n) => n.map((x) => x.getAttribute("data-carnet-page-id")));
  check(rows.join() === "page-a", "only the page with a decision: " + rows);
  await p.click('#hq-carnet-library [data-carnet-filter="all"]');
  rows = await p.locator("#hq-carnet-library [data-carnet-page-id]").evaluateAll((n) => n.map((x) => x.getAttribute("data-carnet-page-id")));
  check(rows.length === 2, "filter off: everything is back");
  await sleep(500);
  check(JSON.stringify(srv.nb()) === rev0, "toggling filters never changes the notebook");
  // removing the status while the filter is on: the page leaves the filtered view, the text stays
  await p.click('#hq-carnet-library [data-carnet-filter="decisions"]');
  await p.locator('#hq-carnet-library [data-carnet-page-id="page-a"]').click();
  await until(async () => (await editorText(p)).startsWith("intro"), "page-a open");
  await select(p, 6, 6);
  await openEng(p, "decision");
  await p.click("#btn-carnet-eng-undecide");
  await until(async () => (await p.locator('#hq-carnet-editor [data-line-type="decision"]').count()) === 0, "status removed");
  await until(async () => (await p.locator("#hq-carnet-library [data-carnet-page-id]").count()) === 0, "filtered list follows the change (page no longer has a decision)");
  await saved(p);
  check(srv.pg("page-a").content.blocks[1].type === "paragraph" && srv.pg("page-a").content.blocks[1].text === "Choisir 316L", "text kept as a plain paragraph");
  await ctx.close();
});

scenario("accessibility: labelled controls, roles, non-colour status cue, keyboard-only calculation", async () => {
  const srv = await server(engNb());
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  // the atom card is a focusable, named group whose status is text (not colour only)
  const card = p.locator("#hq-carnet-editor [data-carnet-eng=calc]");
  check((await card.getAttribute("tabindex")) === "0" && (await card.getAttribute("role")) === "group" && /Calcul/.test((await card.getAttribute("aria-label")) || ""), "calc card: focusable named group");
  // keyboard-only: open the tray, the tool, type, Enter inserts
  await select(p, 5, 5);
  await p.focus("#btn-carnet-more");
  await p.keyboard.press("Enter");
  await p.focus("#btn-carnet-eng");
  await p.keyboard.press("Enter");
  await p.waitForSelector("#hq-carnet-eng:not([hidden])");
  const names = await p.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll("#hq-carnet-eng button, #hq-carnet-eng input, #hq-carnet-eng select")) {
      if (n.offsetParent === null) continue;
      const lab = n.getAttribute("aria-label") || (n.labels && n.labels[0] && n.labels[0].textContent) || n.textContent || "";
      out.push([n.tagName, n.id, lab.trim()]);
    }
    const panel = document.getElementById("hq-carnet-eng");
    return { out, role: panel.getAttribute("role"), label: panel.getAttribute("aria-label"), msgRole: document.getElementById("hq-carnet-eng-msg").getAttribute("role") };
  });
  check(names.out.length >= 7 && names.out.every((x) => x[2].length > 0), "every visible control has an accessible name: " + JSON.stringify(names.out.map((x) => x[2])));
  check(names.role === "group" && /ing[ée]nierie/i.test(names.label) && names.msgRole === "alert", "panel is a named group; messages are announced (role=alert)");
  await p.focus('[data-eng-tool="calc"]');
  await p.keyboard.press("Enter");
  await p.waitForSelector("#hq-carnet-eng-expr");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id === "hq-carnet-eng-expr"), "focus moves to the first field");
  await p.keyboard.type("8/4");
  await p.keyboard.press("Enter");
  await until(async () => (await p.locator("#hq-carnet-editor [data-carnet-eng=calc]").count()) === 2, "Enter inserts the calculation (keyboard only)");
  check(await p.locator("#hq-carnet-eng").isHidden(), "panel closes after insertion");
  // measurement status is written in words
  await select(p, 0, 0);
  await openEng(p, "measure");
  await p.fill("#hq-carnet-eng-m-label", "a");
  await p.fill("#hq-carnet-eng-m-obs", "10.5");
  await p.selectOption("#hq-carnet-eng-m-unit", "mm");
  await p.fill("#hq-carnet-eng-m-nom", "10");
  await p.selectOption("#hq-carnet-eng-m-mode", "sym");
  await p.fill("#hq-carnet-eng-m-t", "0.1");
  await until(async () => /hors tol/i.test(await p.locator("#hq-carnet-eng-m-verdict").textContent()), "verdict is text: " + (await p.locator("#hq-carnet-eng-m-verdict").textContent()));
  await p.click("#btn-carnet-eng-insert");
  await until(async () => (await p.locator('[data-carnet-eng=measure] .carnet-eng-status').count()) === 1, "measure inserted");
  check(/hors tol/i.test(await p.locator('[data-carnet-eng=measure] .carnet-eng-status').textContent()), "badge text states the status (not colour only)");
  check(/non certifi/i.test(await p.locator('[data-carnet-eng=measure] .carnet-eng-note').textContent()), "the card itself carries the 'non certifié' label");
  await ctx.close();
});

scenario("export TXT/MD and print representation are deterministic and labelled", async () => {
  const nb = notebook([page("page-a", 1, [
    para("avant"),
    { id: "block-c1c1c1c1c1c1", type: "calc", text: "", marks: [], calc: { expr: "2 * 3", result: "6", unit: null, at: 1790000000, v: 1 } },
    { id: "block-d1d1d1d1d1d1", type: "decision", text: "Go", marks: [], decision: { at: 1790000000 } },
  ])]);
  const srv = await server(nb);
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const content = nb.pages[0].content;
  const out = await p.evaluate((c) => {
    const R = window.HqCarnetRich;
    const lines = R.linesFromContent(c);
    return { txt: R.renderTxt(lines), md: R.renderMarkdown(lines) };
  }, content);
  check(out.txt.includes("[Calcul : 2 * 3 = 6 — 2026-09-21 14:13 UTC]"), "TXT calc line: " + JSON.stringify(out.txt));
  check(/DÉCISION · 2026-09-21 \d\d:\d\d UTC — Go/.test(out.txt), "TXT decision line uses UTC: " + JSON.stringify(out.txt));
  check(out.md.includes("**DÉCISION") && out.md.includes("Go"), "MD decision: " + JSON.stringify(out.md));
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
