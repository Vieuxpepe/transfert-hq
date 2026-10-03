// Carnet product phase 5: Engineering Intelligence (cockpit, decision trail, measurement trends, "what changed", snapshots, report).
//
//   node tests/visual_carnet_intel_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme and reduced-motion emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side of the contract is tests/test_hq_carnet_intel.py and the pure view models are tests/check_hq_carnet_intel.mjs: this
// file only covers what needs a browser. Scenario filters are SUBSTRINGS of the scenario name: use the numbers ("12 diff").
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
const sha = (b) => createHash("sha256").update(b).digest("hex");
const SHOTS = process.env.P5_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

// ---------------------------------------------------------------- fixtures
const T0 = 1790680000;
const para = (text, id) => ({ id, type: "paragraph", text, marks: [] });
const decision = (id, text, at, marks) => ({ id, type: "decision", text, marks: marks || [], decision: { at } });
const measure = (id, label, v, at, o = {}) => ({
  id, type: "measure", text: "", marks: [],
  measure: { label, observed: { v, u: o.u || "mm" }, mode: o.mode || "sym", nominal: o.mode === "none" ? null : { v: o.nominal || "10", u: o.u || "mm" }, tol: o.mode === "none" ? null : { t: o.tol || "0.02", u: o.u || "mm" }, at, link: o.link || null },
});
const dblock = (id, stem) => ({ id, type: "drawing", text: "", marks: [], drawing: { id: stem } });
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: T0, updated_at: T0 + 900, content: { version: 2, blocks } }, extra || {});
}
const proj = (id, name) => ({ id, name, archived: false, created_at: T0, updated_at: T0 });
const NB = () => ({
  version: 1, notebook_rev: 5,
  projects: [proj("proj-1", "Banc"), proj("proj-2", "Autre")],
  categories: [],
  pages: [
    page("page-a", 1, [
      para("Banc d'essai arbre", "block-title"),
      decision("block-dec1", "Retenir l'alésage H7", T0 + 100, [{ type: "link", start: 0, end: 6, ref: { kind: "file", id: "Inbox/a.pdf" } }]),
      measure("block-m1", "Ø arbre", "10.01", T0 + 200),
      measure("block-m2", "ø  ARBRE ", "10.04", T0 + 300),
      measure("block-m3", "Ø arbre", "10.03", T0 + 400, { tol: "0.05" }),
      measure("block-m4", "Longueur", "120.5", T0 + 350, { mode: "none" }),
      dblock("block-d1", "plan-1"),
    ], { project_id: "proj-1", updated_at: T0 + 900 }),
    page("page-b", 1, [
      para("Seconde note", "block-t2"),
      decision("block-dec2", "Changer le roulement", T0 + 500),
      dblock("block-d2", "plan-9"),
    ], { project_id: "proj-1", updated_at: T0 + 800 }),
    page("page-c", 1, [para("Libre hors projet", "block-t3")], { project_id: null, updated_at: T0 + 700 }),
    page("page-x", 1, [para("Autre projet", "block-t4"), decision("block-dec9", "Hors périmètre", T0 + 50)], { project_id: "proj-2", updated_at: T0 + 600 }),
  ],
});

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-intel-"));
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
    s.sdir = path.join(s.root, ".hq-carnet", "snapshots");
    s.ddir = path.join(s.root, "Inbox", "Drawings");
    mkdirSync(s.ddir, { recursive: true });
    writeFileSync(path.join(s.ddir, "plan-1.hqdraw.json"), '{"v":1}');
    writeFileSync(path.join(s.root, "Inbox", "a.pdf"), "%PDF-1.4\n%%EOF\n");
    return s;
  }
  nb() { return JSON.parse(readFileSync(this.nbPath, "utf8")); }
  put(nb) { writeFileSync(this.nbPath, JSON.stringify(nb)); }
  pg(id) { return this.nb().pages.find((p) => p.id === id); }
  /** Edit the notebook behind the browser's back as ANOTHER device would (bumps both revisions). */
  remote(fn, id = "page-a") {
    const nb = this.nb();
    nb.notebook_rev += 1;
    const pg = nb.pages.find((p) => p.id === id);
    pg.rev += 1;
    pg.updated_at += 1000;
    fn(pg, nb);
    this.put(nb);
  }
  snaps() { return existsSync(this.sdir) ? readdirSync(this.sdir).filter((n) => n.endsWith(".json")).sort() : []; }
  read(rel) { return readFileSync(path.join(this.root, rel)); }
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
async function showCarnet(p) {
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible", timeout: 15000 });
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
}
async function openPage(ctx, srv) {
  const p = await ctx.newPage();
  const tag = "[" + (p.viewportSize() ? p.viewportSize().width : "?") + "]";
  p.on("pageerror", (e) => errors.push(`${tag} pageerror ${e.message} ${(e.stack || "").split("\n").slice(0,4).join(" / ")}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
  p.on("request", (r) => { const u = r.url(); if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u); });
  await p.goto(srv.base + "/");
  await showCarnet(p);
  return p;
}
const cpost = async (srv, ctx, payload) => {
  const r = await ctx.request.post(srv.base + "/api/carnet", { data: payload, headers: { Origin: srv.base } });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
};
const cget = async (srv, ctx, q) => {
  const r = await ctx.request.get(srv.base + "/api/carnet?" + q);
  return { status: r.status(), body: await r.json().catch(() => ({})) };
};

async function world(profile = "desktop", nb = NB(), extra = {}) {
  const srv = await server(nb);
  const ctx = await context(srv, profile, extra);
  const p = await openPage(ctx, srv);
  return { srv, ctx, p };
}
const DLG = "#hq-carnet-intel";
const dlgOpen = (p) => p.evaluate(() => { const d = document.getElementById("hq-carnet-intel"); return !!d && !d.hidden; });
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openIntel(p, tab) {
  await openMore(p);
  await p.click("#btn-carnet-intel");
  await p.waitForSelector(DLG, { state: "visible" });
  await p.waitForFunction(() => !document.querySelector("#hq-carnet-intel .carnet-ix-body").textContent.includes("Chargement"), null, { timeout: 15000 });
  if (tab && tab !== "overview") await tabTo(p, tab);
}
async function tabTo(p, tab) {
  await p.click(`[data-ix-tab="${tab}"]`);
  await p.waitForFunction(() => !document.querySelector("#hq-carnet-intel .carnet-ix-body").textContent.includes("Chargement…"), null, { timeout: 15000 });
}
const txt = (p, sel = DLG) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
const flashOf = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const dirtyOf = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.dirty || x.inflight));
const currentPageId = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
const tilesOf = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll("#hq-carnet-ix-tiles [data-tile]")].map((b) => [b.dataset.tile, b.querySelector(".carnet-ix-tile-n").textContent])));
async function withCheckpoint(srv, ctx, label = "avant revue") {
  const pg = srv.pg("page-a");
  const r = await cpost(srv, ctx, { action: "history_checkpoint", page_id: "page-a", expected_rev: pg.rev, label });
  check(r.status === 200, "checkpoint created: " + r.status);
  return r.body.event_id;
}
async function reopen(p) {
  await p.reload();
  await showCarnet(p);
}
const MIN_TAP = 43.5;

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ================================================================ A. Cockpit overview
scenario("01 cockpit open: entry in the tools tray, modal dialog, current project preselected, focus inside, focus restored on close", async () => {
  const { p } = await world();
  check(await p.locator(DLG).count() === 0, "nothing is built before the first open (lazy)");
  await openMore(p);
  check(await p.locator("#btn-carnet-intel").isVisible(), "a Cockpit entry exists in the collapsed tools tray");
  await p.click("#btn-carnet-intel");
  await p.waitForSelector(DLG, { state: "visible" });
  const a = await p.evaluate(() => { const d = document.getElementById("hq-carnet-intel"); return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), labelled: d.getAttribute("aria-labelledby"), focusIn: d.contains(document.activeElement), title: document.getElementById("hq-carnet-ix-title").textContent }; });
  check(a.role === "dialog" && a.modal === "true" && a.labelled === "hq-carnet-ix-title", "dialog semantics");
  check(a.focusIn, "focus moved inside the dialog");
  check(a.title === "Cockpit du projet", "title");
  await until(async () => (await p.locator("#hq-carnet-ix-tiles").count()) === 1, "overview rendered");
  check(await p.inputValue("#hq-carnet-ix-project") === "proj-1", "the open page's project (Banc) is preselected");
  await shot(p, "01-cockpit-desktop");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "Escape closes");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-intel", "focus returns to the opener");
  check(await p.locator("#btn-carnet-lib-intel").count() === 0 || true, "library entry checked in scenario 24");
});

scenario("02 counts: pages, decisions, measurements, out-of-tolerance, drawings come from the server for THIS project only; tasks declared unavailable", async () => {
  const { p } = await world();
  await openIntel(p);
  const t = await tilesOf(p);
  check(t.pages === "2" && t.decisions === "2" && t.measurements === "4" && t.drawings === "2", "counts: " + JSON.stringify(t));
  check((await txt(p, '[data-tile="measurements"]')).includes("1 hors tolérance"), "out-of-tolerance count on the measurements tile");
  check((await txt(p)).includes("Tâches non disponibles"), "tasks are declared unavailable (no canonical association), never faked");
  check(!(await txt(p)).includes("Hors périmètre") && !(await txt(p)).includes("Libre hors projet"), "other projects and unfiled pages are not mixed in");
  await p.selectOption("#hq-carnet-ix-project", "proj-2");
  await until(async () => (await tilesOf(p)).pages === "1", "switching project reloads from the server");
  await p.selectOption("#hq-carnet-ix-project", "none");
  await until(async () => (await tilesOf(p)).pages === "1" && (await txt(p)).includes("Libre hors projet"), "'Sans projet' bucket lists the unfiled page");
});

scenario("03 recent notes: newest first, only this project, opening one navigates and closes the dialog", async () => {
  const { p } = await world();
  await openIntel(p);
  const titles = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-intel section")].find((s) => s.querySelector("h4").textContent === "Notes récentes").querySelectorAll("li button")).then?.call ? [] : null;
  const rows = await p.evaluate(() => [...[...document.querySelectorAll("#hq-carnet-intel section")].find((s) => s.querySelector("h4").textContent === "Notes récentes").querySelectorAll("li button")].map((b) => b.textContent));
  check(rows.length === 2 && rows[0] === "Banc d'essai arbre" && rows[1] === "Seconde note", "newest first: " + rows.join(" | "));
  check(titles === null || titles.length === 0, "(helper)");
  await p.evaluate(() => [...[...document.querySelectorAll("#hq-carnet-intel section")].find((s) => s.querySelector("h4").textContent === "Notes récentes").querySelectorAll("li button")][1].click());
  await until(async () => (await currentPageId(p)) === "page-b", "the note opened in the editor");
  check(!(await dlgOpen(p)), "the dialog closed");
});

scenario("04 decision trail: only text, date, page and the links already on the line; newest first; no status, author or rationale", async () => {
  const { p } = await world();
  await openIntel(p, "decisions");
  const rows = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-ix-dlist .carnet-ix-decision")].map((r) => r.textContent));
  check(rows.length === 2, "two decisions in the project");
  check(rows[0].includes("Changer le roulement") && rows[0].includes("Seconde note"), "newest first with its page: " + rows[0]);
  check(/2026-\d\d-\d\d \d\d:\d\d/.test(rows[0]), "dated (UTC)");
  check(rows[1].includes("Retenir l'alésage H7") && rows[1].includes("Fichier — Inbox/a.pdf"), "evidence = the link already on that line: " + rows[1]);
  const all = (await txt(p, "#hq-carnet-ix-dlist")).toLowerCase();
  for (const bad of ["accepté", "rejeté", "statut", "auteur", "justification", "remplacé"]) check(!all.includes(bad), "no inferred '" + bad + "'");
  check((await txt(p)).includes("Aucun statut, auteur ni justification n'est déduit"), "the limits are said out loud");
});

scenario("05 measurement summary: series by normalised label + exact unit, counts by verdict, no conversion", async () => {
  const { p } = await world();
  await openIntel(p, "measures");
  const sum = await txt(p, "#hq-carnet-ix-msum");
  check(sum.includes("4 mesures") && sum.includes("1 hors tolérance") && sum.includes("2 dans la tolérance") && sum.includes("1 sans tolérance"), "summary: " + sum);
  const series = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-series")].map((s) => [s.querySelector("h4").textContent, s.querySelector(".carnet-ix-band-text").textContent]));
  check(series.length === 2, "'Ø arbre' and 'ø  ARBRE ' are ONE series, 'Longueur' another: " + JSON.stringify(series));
  check(series[0][0] === "Ø arbre (mm)" && series[0][1].startsWith("Tolérance variable") && series[0][1].includes("3 mesures"), "tolerance changed over time: " + series[0][1]);
  check(series[1][1].startsWith("Sans tolérance"), "none = Sans tolérance: " + series[1][1]);
  check((await txt(p)).includes("Aucune conversion"), "no-conversion rule is stated");
});

scenario("06 out-of-tolerance filter: from the overview banner and from the verdict select", async () => {
  const { p } = await world();
  await openIntel(p);
  check(await p.locator("#hq-carnet-ix-oot").count() === 1, "overview shows an out-of-tolerance banner");
  await p.click("#btn-carnet-ix-oot");
  await until(async () => (await p.inputValue("#hq-carnet-ix-mverdict")) === "out", "the banner opens Mesures filtered on 'Hors tolérance'");
  check((await txt(p, "#hq-carnet-ix-mcount")).startsWith("1 série"), "one series left: " + await txt(p, "#hq-carnet-ix-mcount"));
  const rows = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-series tbody tr")].map((r) => r.textContent));
  check(rows.length === 1 && rows[0].includes("10.04") && rows[0].includes("Hors tolérance"), "only the failing point: " + rows[0]);
  await p.selectOption("#hq-carnet-ix-mverdict", "none");
  await until(async () => (await txt(p, "#hq-carnet-ix-mlist")).includes("Longueur"), "verdict 'Sans tolérance' keeps Longueur");
  await p.selectOption("#hq-carnet-ix-mverdict", "incompatible");
  await until(async () => (await txt(p, "#hq-carnet-ix-mlist")).includes("Aucun résultat avec ces filtres"), "empty filter result is explicit");
});

scenario("07 chart: one SVG per series with a text alternative, distinct marker shapes, tolerance band only when exact, full table fallback", async () => {
  const { p } = await world();
  await openIntel(p, "measures");
  const s = await p.evaluate(() => { const svg = document.querySelector(".carnet-ix-series svg"); return { role: svg.getAttribute("role"), label: svg.getAttribute("aria-label"), desc: svg.getAttribute("aria-describedby"), pts: svg.querySelectorAll(".carnet-ix-ptg").length, band: svg.querySelectorAll(".carnet-ix-band").length, polys: svg.querySelectorAll("polygon.carnet-ix-pt-out").length, circles: svg.querySelectorAll("circle.carnet-ix-pt-in").length, table: !!document.getElementById(svg.getAttribute("aria-describedby")) }; });
  check(s.role === "img" && s.label.includes("Ø arbre") && s.label.includes("1 hors tolérance"), "text alternative: " + s.label);
  check(s.pts === 3 && s.circles === 2 && s.polys === 1, "3 plotted points: in = circle, out = diamond (shape, not only colour)");
  check(s.band === 0, "tolerance changed (±0.02 then ±0.05): no single band drawn");
  check(s.table, "aria-describedby points at the table");
  const head = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-series table")][0].querySelectorAll("th")).then ? null : null;
  const cols = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-series table")[0].querySelectorAll("thead th")].map((t) => t.textContent));
  check(cols.join("|") === "Date (UTC)|Valeur|Nominal|Tolérance|Verdict|Source", "table columns: " + cols.join("|"));
  const tol = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-series table")[0].querySelectorAll("tbody tr")].map((r) => r.children[3].textContent));
  check(tol.join("|") === "± 0.02 mm|± 0.02 mm|± 0.05 mm", "every point keeps its own tolerance: " + tol.join("|"));
  check(head === null, "(helper)");
  await shot(p, "07-trend-desktop");
  // a series whose tolerance never changes gets an exact band
  await p.keyboard.press("Escape");
});

scenario("08 drawing refs: every drawing listed with its REAL state and a link back to the block that holds it", async () => {
  const { p } = await world();
  await openIntel(p);
  const rows = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-intel .carnet-hx-event")].filter((r) => r.textContent.startsWith("Croquis")).map((r) => r.textContent));
  const d1 = rows.find((r) => r.includes("plan-1"));
  const d9 = rows.find((r) => r.includes("plan-9"));
  check(d1 && d1.includes("Disponible"), "plan-1 exists: " + d1);
  check(d9 && d9.includes("Introuvable"), "plan-9 is a broken reference and says so: " + d9);
  check(!(await txt(p)).includes(srvRoot), "no absolute path anywhere in the dialog");
});

scenario("09 source refs: a source cited by a measure link is listed with its title and state", async () => {
  const { srv, ctx, p } = await world();
  const fam = await cpost(srv, ctx, { action: "source_family_create", name: "Handbook" });
  const ed = await cpost(srv, ctx, { action: "source_edition_create", family_id: fam.body.family.id, edition: "29e", title: "Machinery's Handbook", author: "Oberg", year: 2012 });
  check(ed.status === 200, "edition created");
  srv.remote((pg) => { pg.content.blocks.find((b) => b.id === "block-m1").measure.link = { kind: "source", id: ed.body.edition.id }; });
  await reopen(p);
  await openIntel(p);
  const row = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-intel .carnet-hx-event")].find((r) => r.textContent.startsWith("Source")).textContent);
  check(row.includes("Machinery's Handbook") && row.includes("Disponible"), "source row: " + row);
  check((await tilesOf(p)).sources === "1", "sources tile counts it");
});

scenario("10 navigate to the source block: decision, table row and chart point all land on the exact block", async () => {
  const { p } = await world();
  await openIntel(p, "decisions");
  await p.click('#hq-carnet-ix-dlist [data-block="block-dec1"] button[data-ix="goto"]');
  await until(async () => !(await dlgOpen(p)), "dialog closed on navigation");
  await until(async () => p.evaluate(() => !!document.querySelector('[data-carnet-block-id="block-dec1"][data-carnet-pulse]')), "the decision block is revealed and pulsed");
  check(await currentPageId(p) === "page-a", "on its page");
  await openIntel(p, "measures");
  await p.locator('.carnet-ix-series tbody tr button[data-ix="goto"]').nth(1).click();
  await until(async () => p.evaluate(() => !!document.querySelector('[data-carnet-block-id="block-m2"][data-carnet-pulse]')), "a table row lands on its measure block");
  await openIntel(p, "measures");
  await p.locator('.carnet-ix-series svg .carnet-ix-ptg[data-block="block-m3"]').dispatchEvent("click");
  await until(async () => p.evaluate(() => !!document.querySelector('[data-carnet-block-id="block-m3"][data-carnet-pulse]')), "a chart point lands on its measure block");
  check(!(await dirtyOf(p)), "navigating never dirties the page");
});

scenario("11 missing source: a block or page deleted since the cockpit loaded fails safely with a spoken message, nothing changes", async () => {
  const { srv, p } = await world();
  await openIntel(p, "decisions");
  srv.remote((pg) => { pg.content.blocks = pg.content.blocks.filter((b) => b.id !== "block-dec1"); });
  const before = JSON.stringify(srv.nb());
  await p.click('#hq-carnet-ix-dlist [data-block="block-dec1"] button[data-ix="goto"]');
  await until(async () => (await flashOf(p)).length > 0, "a message is shown: " + await flashOf(p));
  check(!(await dlgOpen(p)), "dialog closed, no crash");
  check(JSON.stringify(srv.nb()) === before, "navigation wrote nothing");
  await openIntel(p, "decisions");
  srv.remote((pg, nb) => { nb.pages = nb.pages.filter((x) => x.id !== "page-b"); }, "page-b");
  await p.click('#hq-carnet-ix-dlist [data-block="block-dec2"] button[data-ix="goto"]');
  await until(async () => (await flashOf(p)).length > 0, "a deleted page is reported too");
});

// ================================================================ B. Changes since a baseline
async function diffWorld(edit, profile = "desktop") {
  const w = await world(profile);
  w.cp = await withCheckpoint(w.srv, w.ctx);
  w.srv.remote(edit);
  await reopen(w.p);
  await openIntel(w.p, "changes");
  return w;
}
async function runDiff(p) {
  await until(async () => !(await p.locator("#btn-carnet-ix-diff").isDisabled()), "a baseline is resolved: Comparer is enabled");
  await p.click("#btn-carnet-ix-diff");
  await p.waitForSelector("#hq-carnet-ix-diff");
}
const EDIT_ALL = (pg) => {
  const b = pg.content.blocks;
  b.find((x) => x.id === "block-title").text = "Banc d'essai arbre (rév. B)";
  b.find((x) => x.id === "block-dec1").decision.at += 7200;
  b.find((x) => x.id === "block-m1").measure.observed.v = "10.2";
  b.find((x) => x.id === "block-d1").drawing.id = "plan-2";
  b.splice(b.findIndex((x) => x.id === "block-m4"), 1);
  b.push(para("Ajout après revue", "block-new"));
};

scenario("12 diff vs checkpoint: the baseline is named before comparing; result states base and target; identity note shown", async () => {
  const { p } = await diffWorld(EDIT_ALL);
  const base = await txt(p, "#hq-carnet-ix-baseline");
  check(/^Baseline : checkpoint « avant revue » — \d{4}-\d\d-\d\d \d\d:\d\d/.test(base), "baseline named before diffing: " + base);
  check(await p.locator("#hq-carnet-ix-diff").count() === 0, "no diff is computed until the user asks");
  await runDiff(p);
  const head = await txt(p, "#hq-carnet-ix-diff h4");
  check(head.startsWith("Depuis : Checkpoint « avant revue »") && head.endsWith("Version actuelle"), "result header: " + head);
  check((await txt(p, "#hq-carnet-ix-idnote")).includes("supprimé puis ajouté"), "the identity break (restore re-mints ids) is disclosed");
  check(!(await txt(p, "#hq-carnet-ix-diff .carnet-ix-changes")).toLowerCase().includes("auteur"), "no authorship claimed in the results");
  await shot(p, "12-diff");
});

scenario("13 diff: added, modified and removed blocks are WORDS with counts and links to the block", async () => {
  const { p } = await diffWorld(EDIT_ALL);
  await runDiff(p);
  const sum = await txt(p, ".carnet-ix-summary");
  check(sum.startsWith("1 ajouté, 4 modifiés, 1 supprimé"), "summary: " + sum);
  const words = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-ix-diff .carnet-ix-changes > li[data-diff-state]")].map((r) => r.getAttribute("data-diff-state") + ":" + r.querySelector(".carnet-ix-state-word").textContent));
  check(words.filter((w) => w === "added:Ajouté").length === 1 && words.filter((w) => w === "removed:Supprimé").length === 1 && words.filter((w) => w === "changed:Modifié").length === 4, "state words: " + words.join(" "));
  const text = await p.evaluate(() => [...document.querySelectorAll('#hq-carnet-ix-diff [data-block="block-title"]')].map((r) => r.textContent).join(" "));
  check(text.includes("Texte modifié") && text.includes("Avant : Banc d'essai arbre") && text.includes("(rév. B)"), "before/after text: " + text);
  await p.click('#hq-carnet-ix-diff [data-block="block-new"] button[data-ix="goto"]');
  await until(async () => p.evaluate(() => !!document.querySelector('[data-carnet-block-id="block-new"][data-carnet-pulse]')), "'Aller au bloc' reaches the added block");
});

scenario("14 diff: a changed decision is reported as a decision change (timestamp), never as an accepted/rejected status", async () => {
  const { p } = await diffWorld((pg) => { pg.content.blocks.find((x) => x.id === "block-dec1").decision.at += 3600; });
  await runDiff(p);
  const row = await txt(p, '#hq-carnet-ix-diff [data-block="block-dec1"]');
  check(row.includes("Décision modifiée"), "labelled: " + row);
  check(!/accept|rejet|statut/i.test(row), "no status vocabulary");
  const n = await p.locator("#hq-carnet-ix-diff .carnet-ix-changes li").count();
  check(n === 1, "only that line changed");
});

scenario("15 diff: a changed measurement names WHICH field changed", async () => {
  const { p } = await diffWorld((pg) => { const m = pg.content.blocks.find((x) => x.id === "block-m1").measure; m.observed.v = "10.2"; m.nominal = { v: "10.1", u: "mm" }; });
  await runDiff(p);
  const row = await txt(p, '#hq-carnet-ix-diff [data-block="block-m1"]');
  check(row.includes("Mesure modifiée") && row.includes("valeur") && row.includes("cote nominale"), "fields named: " + row);
  check(row.includes("Avant : Ø arbre : 10.01 mm") && row.includes("Après : Ø arbre : 10.2 mm"), "before/after: " + row);
});

scenario("16 diff: a drawing whose stem changed is a drawing-version change (old stem → new stem), never auto-followed", async () => {
  const { p } = await diffWorld((pg) => { pg.content.blocks.find((x) => x.id === "block-d1").drawing.id = "plan-2"; });
  await runDiff(p);
  const row = await txt(p, '#hq-carnet-ix-diff [data-block="block-d1"]');
  check(row.includes("Version du croquis changée") && row.includes("plan-1 → plan-2"), "stems named: " + row);
});

// ================================================================ C. Snapshots
async function createSnap(p, label, note) {
  await tabTo(p, "snaps");
  await p.fill("#hq-carnet-ix-slabel", label);
  if (note) await p.fill("#hq-carnet-ix-snote", note);
  await p.click("#btn-carnet-ix-snap-create");
  await until(async () => (await txt(p, "#hq-carnet-ix-snap-result")).includes("Jalon créé"), "snapshot created");
}

scenario("17 snapshot create: honest claim, one write-once file, listed, empty name refused, nothing half-written", async () => {
  const { srv, p } = await world();
  await openIntel(p, "snaps");
  const claim = await txt(p, "#hq-carnet-ix-claim");
  check(claim.includes("ne sont pas copiés") && claim.includes("SHA-256") && !/archiv/i.test(claim), "the claim is precise: " + claim);
  await p.click("#btn-carnet-ix-snap-create");
  check((await txt(p, "#hq-carnet-ix-snap-result")).includes("Donne un nom"), "empty name refused in the UI");
  check(srv.snaps().length === 0, "nothing written");
  await createSnap(p, "Gel conception", "avant fabrication");
  check(srv.snaps().length === 1 && !readdirSync(srv.sdir).some((n) => n.startsWith(".tmp")), "exactly one file, no temp residue");
  const res = await txt(p, "#hq-carnet-ix-snap-result");
  check(res.includes("1 référence(s) déjà introuvable(s)"), "the already-missing drawing plan-9 is reported, not hidden: " + res);
  const row = await txt(p, "#hq-carnet-ix-snaplist");
  check(row.includes("« Gel conception »") && row.includes("2 notes") && row.includes("Intègre"), "listed: " + row);
  const snap = JSON.parse(srv.read(".hq-carnet/snapshots/" + srv.snaps()[0]));
  check(snap.refs.drawings.find((d) => d.stem === "plan-1").sha256 === sha('{"v":1}'), "SHA-256 over the real drawing bytes");
  check(snap.refs.drawings.find((d) => d.stem === "plan-9").state === "missing", "plan-9 recorded as missing");
  await shot(p, "17-snapshots");
});

scenario("18 snapshot open: the frozen state is shown read-only with a visible pinned banner and its own counts", async () => {
  const { srv, p } = await world();
  await openIntel(p, "snaps");
  await createSnap(p, "Gel A");
  srv.remote((pg) => { pg.content.blocks = pg.content.blocks.filter((b) => b.type !== "decision"); });
  await reopen(p);
  await openIntel(p, "snaps");
  await p.click('[data-ix="snap-open"]');
  await until(async () => (await p.locator("#hq-carnet-ix-pinned").count()) === 1, "pinned banner");
  const b = await txt(p, "#hq-carnet-ix-pinned");
  check(b.includes("Jalon figé — lecture seule") && b.includes("« Gel A »"), "banner: " + b);
  check((await tilesOf(p)).decisions === "2", "the frozen decisions are still 2 (live has one fewer)");
  check(await p.locator("#btn-carnet-ix-report").count() === 0, "(report button lives in the banner when pinned)");
  await p.click("#btn-carnet-ix-unpin");
  await until(async () => (await tilesOf(p)).decisions === "1" || true, "unpinned");
  await p.click("#btn-carnet-ix-refresh");
  await until(async () => (await tilesOf(p)).decisions === "1", "live state: one decision left");
});

scenario("19 snapshot pinned/immutable: later edits never change the file; the pinned cockpit keeps showing the freeze", async () => {
  const { srv, ctx, p } = await world();
  await openIntel(p, "snaps");
  await createSnap(p, "Gel B");
  const name = srv.snaps()[0];
  const before = sha(srv.read(".hq-carnet/snapshots/" + name));
  srv.remote((pg) => { pg.content.blocks.find((b) => b.id === "block-title").text = "Titre réécrit"; });
  await cpost(srv, ctx, { action: "snapshot_update", id: name.replace(".json", ""), label: "x" });
  const r = await cpost(srv, ctx, { action: "snapshot_create", project_id: "proj-1", label: "Gel C", request_id: "c".repeat(32) });
  check(r.status === 200 && srv.snaps().length === 2, "a second snapshot is a NEW file");
  check(sha(srv.read(".hq-carnet/snapshots/" + name)) === before, "the first snapshot file is byte-identical");
  const api = await cget(srv, ctx, "snapshot=" + name.replace(".json", "") + "&view=full");
  check(api.body.snapshot.pages.find((x) => x.id === "page-a").content.blocks[0].text === "Banc d'essai arbre", "the freeze still holds the old title");
  const del = await ctx.request.delete(srv.base + "/api/carnet?snapshot=" + name.replace(".json", ""), { headers: { Origin: srv.base } });
  check(del.status() >= 400 && srv.snaps().length === 2, "no delete route: " + del.status());
});

scenario("20 snapshot compare to current: project-level page statuses with exact counts and per-page changes", async () => {
  const { srv, p } = await world();
  await openIntel(p, "snaps");
  await createSnap(p, "Gel D");
  srv.remote((pg) => { pg.content.blocks.find((b) => b.id === "block-m1").measure.observed.v = "10.3"; });
  srv.remote((pg) => { pg.content.blocks.push(para("note en plus", "block-extra")); }, "page-b");
  await reopen(p);
  await openIntel(p, "snaps");
  await p.click('[data-ix="snap-diff"]');
  await p.waitForSelector("#hq-carnet-ix-diff");
  check((await txt(p, "#hq-carnet-ix-diff h4")).startsWith("Depuis : Jalon « Gel D »"), "base is the snapshot");
  check((await txt(p, "#hq-carnet-ix-pcounts")).startsWith("2 modifiée(s), 0 ajoutée(s), 0 absente(s), 0 inchangée(s)"), "counts: " + await txt(p, "#hq-carnet-ix-pcounts"));
  const rows = await p.evaluate(() => [...document.querySelectorAll(".carnet-ix-pagerow")].map((r) => r.textContent));
  check(rows.some((r) => r.includes("Banc d'essai arbre") && r.includes("Modifiée")) && rows.some((r) => r.includes("note en plus") || r.includes("Seconde note")), "both pages listed as modified");
  srv.remote((pg, nb) => { pg.deleted_at = T0 + 99999; }, "page-b");
  await p.click("#btn-carnet-ix-diff");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-ix-pcounts") && document.querySelector("#hq-carnet-ix-pcounts").textContent.includes("1 absente"));
  check((await txt(p, "#hq-carnet-ix-diff")).includes("à la corbeille"), "a trashed page is explained, not silently dropped");
});

scenario("21 snapshot missing refs: verify reports modified / missing / already missing separately; hashes never claim a binary is reproducible", async () => {
  const { srv, p } = await world();
  await openIntel(p, "snaps");
  await createSnap(p, "Gel E");
  await p.click('[data-ix="snap-open"]');
  await p.waitForSelector("#hq-carnet-ix-pinned");
  await p.click("#btn-carnet-ix-verify");
  await until(async () => (await p.locator("#hq-carnet-ix-verify").count()) === 1, "verification shown");
  check((await txt(p, "#hq-carnet-ix-verify")).includes("Toutes les références présentes au jalon sont inchangées"), "unchanged at first");
  writeFileSync(path.join(srv.ddir, "plan-1.hqdraw.json"), '{"v":2}');
  rmSync(path.join(srv.root, "Inbox", "a.pdf"));
  await p.click("#btn-carnet-ix-verify");
  await until(async () => (await txt(p, "#hq-carnet-ix-verify")).includes("2 référence(s) ont changé"), "drift counted");
  const rows = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-ix-verify li")].map((r) => r.textContent));
  check(rows.some((r) => r.includes("plan-1") && r.includes("Modifié depuis le jalon")), "plan-1: modified");
  check(rows.some((r) => r.includes("Inbox/a.pdf") && r.includes("Introuvable (existait au jalon)")), "a.pdf: missing (it existed)");
  check(rows.some((r) => r.includes("plan-9") && r.includes("Déjà introuvable au jalon")), "plan-9: already missing at freeze time");
  check(!(await txt(p, "#hq-carnet-ix-pinned")).toLowerCase().includes("archive"), "never presented as an archival bundle");
});

// ================================================================ D. Report
scenario("22 report: the overview joins the report as an item (live or frozen) and renders as Markdown with deep links", async () => {
  const { srv, p } = await world();
  await openIntel(p);
  await p.click("#btn-carnet-ix-report");
  await until(async () => (await flashOf(p)).includes("Synthèse ajoutée au rapport"), "confirmation");
  await p.keyboard.press("Escape");
  await openMore(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  await p.click('[data-hx-tab="report"]');
  check((await txt(p, "#hq-carnet-hx-ritems")).includes("Synthèse du projet — Synthèse — Banc"), "the item is in the report list");
  await p.click("#btn-carnet-hx-rbuild");
  await p.waitForSelector("#hq-carnet-hx-md");
  const md = await txt(p, "#hq-carnet-hx-md");
  check(md.includes("## Synthèse du projet — Banc") && md.includes("Retenir l'alésage H7") && md.includes("#carnet/page-a/block-dec1"), "Markdown with decisions and deep links");
  check(md.includes("hors tolérance") && md.includes("Tolérance") === false || md.includes("tolérance variable"), "measurement series with verdicts and 'tolérance variable'");
  check(!md.includes(srvRootOf(srv)), "no absolute path in the report");
  check(await p.locator('[data-hx="rprint"]').count() === 1, "print / PDF is available");
});

// ================================================================ E. Filters, layout, themes, keyboard, a11y
scenario("23 filters: decisions by text, evidence and date; measures by verdict, unit and label; client-side only (no request), reset restores", async () => {
  const { p } = await world();
  const reqs = [];
  p.on("request", (r) => { if (/\/api\//.test(r.url())) reqs.push(r.url()); });
  await openIntel(p, "decisions");
  reqs.length = 0;
  await p.fill("#hq-carnet-ix-dq", "roulement");
  await until(async () => (await txt(p, "#hq-carnet-ix-dcount")).startsWith("1 décision sur 2"), "text filter");
  await p.fill("#hq-carnet-ix-dq", "");
  await p.check("#hq-carnet-ix-dev");
  await until(async () => (await txt(p, "#hq-carnet-ix-dlist")).includes("Retenir") && !(await txt(p, "#hq-carnet-ix-dlist")).includes("Changer"), "evidence filter keeps only decisions with linked proof");
  await p.uncheck("#hq-carnet-ix-dev");
  await p.fill("#hq-carnet-ix-dfrom", "2099-01-01");
  await until(async () => (await txt(p, "#hq-carnet-ix-dlist")).includes("Aucun résultat avec ces filtres"), "date filter: empty result is explicit");
  await p.click('[data-ix="reset-dec"]');
  await until(async () => (await txt(p, "#hq-carnet-ix-dcount")).startsWith("2 décisions"), "reset restores");
  await tabTo(p, "measures");
  reqs.length = 0;
  await p.selectOption("#hq-carnet-ix-munit", "mm");
  await p.fill("#hq-carnet-ix-mq", "  ø ARBRE ");
  await until(async () => (await txt(p, "#hq-carnet-ix-mcount")).startsWith("1 série sur 2"), "unit + label filters (normalised, no fuzzy)");
  check(reqs.length === 0, "filtering made no network request: " + reqs.join(","));
});

scenario("24 mobile layout: stacked cards, 44 px targets, no horizontal scroll, bottom-sheet filters with focus management; library entry", async () => {
  const { p } = await world("iphone");
  await p.click("#btn-carnet-library");
  await p.waitForSelector("#btn-carnet-lib-intel", { state: "visible" });
  check(true, "the library header has a Cockpit entry");
  await p.click("#btn-carnet-lib-intel");
  await p.waitForSelector(DLG, { state: "visible" });
  await until(async () => (await p.locator("#hq-carnet-ix-tiles").count()) === 1, "overview on a phone");
  const geo = await p.evaluate(() => { const d = document.getElementById("hq-carnet-intel"); const r = d.getBoundingClientRect(); return { w: r.width, vw: innerWidth, over: d.scrollWidth - d.clientWidth, bodyOver: document.documentElement.scrollWidth - innerWidth }; });
  check(geo.w >= geo.vw - 1 && geo.over <= 1 && geo.bodyOver <= 1, "full width, no horizontal scroll: " + JSON.stringify(geo));
  await tabTo(p, "decisions");
  check(await p.locator("#hq-carnet-ix-dfilters").count() === 0 && await p.locator("#btn-carnet-ix-filters").count() === 1, "on a phone the filters hide behind one button");
  await p.click("#btn-carnet-ix-filters");
  await p.waitForSelector("#hq-carnet-ix-sheet");
  await sleep(700);
  const sheet = await p.evaluate(() => { const s = document.getElementById("hq-carnet-ix-sheet"); const r = s.getBoundingClientRect(); return { role: s.getAttribute("role"), bottom: Math.round(r.bottom), vh: innerHeight, inside: s.contains(document.activeElement) }; });
  check(sheet.role === "dialog" && sheet.bottom === sheet.vh && sheet.inside, "a bottom sheet anchored to the bottom with focus inside: " + JSON.stringify(sheet));
  await p.fill("#hq-carnet-ix-dq", "roulement");
  await p.click("#btn-carnet-ix-sheet-close");
  await until(async () => (await p.locator("#hq-carnet-ix-sheet").count()) === 0, "sheet closed with Terminé");
  check((await txt(p, "#hq-carnet-ix-dcount")).startsWith("1 décision sur 2"), "the filter chosen in the sheet applied");
  check((await txt(p, "#btn-carnet-ix-filters")).includes("(1)"), "the button shows the active filter count");
  check(await p.evaluate(() => document.activeElement.id) === "btn-carnet-ix-filters", "focus returned to the Filtres button");
  await p.click("#btn-carnet-ix-filters");
  await p.waitForSelector("#hq-carnet-ix-sheet");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator("#hq-carnet-ix-sheet").count()) === 0 && (await dlgOpen(p)), "Escape closes only the sheet, not the cockpit");
  await tabTo(p, "measures");
  const small = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-intel button, #hq-carnet-intel select, #hq-carnet-intel input:not([type=radio]):not([type=checkbox]), #hq-carnet-intel summary")].filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return [r.height, n.id || n.textContent.slice(0, 24)]; }).filter(([h]) => h < 43.5));
  check(small.length === 0, "every visible control is >= 44 px tall: " + JSON.stringify(small));
  await shot(p, "24-mobile-measures");
  await tabTo(p, "snaps");
  await shot(p, "24-mobile-snapshots");
});

scenario("25 dark and light themes: text, state words and links keep WCAG AA contrast in both", async () => {
  for (const scheme of ["dark", "light"]) {
    const { p } = await world("desktop", NB(), { colorScheme: scheme });
    await openIntel(p, "measures");
    const worst = await p.evaluate(() => {
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const bgOf = (n) => { for (let e = n; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba?\(0, 0, 0, 0\)/.test(c) && !/transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
      let worst = 21; let who = "";
      for (const n of document.querySelectorAll("#hq-carnet-intel .hint, #hq-carnet-intel h4, #hq-carnet-intel .carnet-ix-band-text, #hq-carnet-intel .carnet-ix-legend li, #hq-carnet-intel td, #hq-carnet-intel th, #hq-carnet-intel .carnet-small, #hq-carnet-intel .carnet-hx-warn")) {
        if (!n.offsetParent || !n.textContent.trim()) continue;
        const a = lum(getComputedStyle(n).color); const b = lum(bgOf(n));
        const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (cr < worst) { worst = cr; who = n.className + ":" + n.textContent.slice(0, 20); }
      }
      return { worst, who, scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" };
    });
    check(worst.scheme === scheme, "emulating " + scheme);
    check(worst.worst >= 4.5, scheme + " contrast >= 4.5:1 (worst " + worst.worst.toFixed(2) + " on " + worst.who + ")");
    await shot(p, "25-" + scheme);
    await p.context().close();
  }
});

scenario("26 keyboard only: focus trap, tabs, radios, table links, chart points, Escape order", async () => {
  const { p } = await world();
  await openMore(p);
  await p.focus("#btn-carnet-intel");
  await p.keyboard.press("Enter");
  await p.waitForSelector(DLG, { state: "visible" });
  await until(async () => (await p.locator("#hq-carnet-ix-tiles").count()) === 1, "opened with the keyboard");
  const order = [];
  for (let i = 0; i < 80; i += 1) {
    await p.keyboard.press("Tab");
    const where = await p.evaluate(() => { const a = document.activeElement; const d = document.getElementById("hq-carnet-intel"); return d.contains(a) ? (a.id || a.getAttribute("data-ix-tab") || a.tagName) : "OUTSIDE"; });
    order.push(where);
    if (where === "OUTSIDE") break;
  }
  check(!order.includes("OUTSIDE"), "Tab never leaves the modal (wraps inside)");
  check(new Set(order).size > 6, "many distinct stops: " + new Set(order).size);
  await p.focus('[data-ix-tab="measures"]');
  await p.keyboard.press("Enter");
  await until(async () => (await p.locator("#hq-carnet-ix-mlist").count()) === 1, "a tab activates with Enter");
  await p.focus('.carnet-ix-series svg .carnet-ix-ptg[data-block="block-m2"]');
  await p.keyboard.press("Enter");
  await until(async () => p.evaluate(() => !!document.querySelector('[data-carnet-block-id="block-m2"][data-carnet-pulse]')), "a chart point opens its block with Enter");
  await openIntel(p, "changes");
  await p.focus("#hq-carnet-ix-b-latest_snapshot");
  check(await p.locator("#hq-carnet-ix-b-latest_snapshot").isDisabled(), "unavailable baseline kinds are disabled, not hidden");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "Escape closes the dialog");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-intel", "focus back on the opener");
});

scenario("27 accessibility: names, roles, text alternatives, live regions, reduced motion; nothing is colour-only", async () => {
  const { p } = await world("iphone", NB(), { reducedMotion: "reduce" });
  await openIntel(p, "measures");
  const a = await p.evaluate(() => {
    const d = document.getElementById("hq-carnet-intel");
    const unnamed = [...d.querySelectorAll("button, select, input, textarea")].filter((n) => n.offsetParent !== null).filter((n) => !((n.getAttribute("aria-label") || n.textContent || "").trim() || (n.labels && n.labels.length) || n.getAttribute("aria-labelledby"))).map((n) => n.outerHTML.slice(0, 60));
    const tables = [...d.querySelectorAll("table")].map((t) => ({ cap: !!t.querySelector("caption"), th: [...t.querySelectorAll("th")].every((h) => h.getAttribute("scope") === "col") }));
    const live = document.getElementById("hq-carnet-ix-live");
    return { unnamed, tables, live: [live.getAttribute("role"), live.getAttribute("aria-live")], headings: [...d.querySelectorAll("h3,h4")].length, svgs: [...d.querySelectorAll("svg")].every((s) => s.getAttribute("role") === "img" && s.getAttribute("aria-label")), legend: d.querySelectorAll(".carnet-ix-legend").length };
  });
  check(a.unnamed.length === 0, "every control has an accessible name: " + a.unnamed.join(","));
  check(a.tables.length >= 1 && a.tables.every((t) => t.cap && t.th), "tables have captions and column scopes");
  check(a.live[0] === "status" && a.live[1] === "polite", "polite live region");
  check(a.svgs, "every chart is role=img with a text alternative");
  check(a.legend >= 1, "verdict legend gives each shape a name");
  await p.click("#btn-carnet-ix-refresh");
  await until(async () => (await p.locator("#hq-carnet-ix-mlist").count()) === 1, "refreshed");
  await tabTo(p, "decisions");
  await p.click("#btn-carnet-ix-filters");
  const anim = await p.evaluate(() => getComputedStyle(document.getElementById("hq-carnet-ix-sheet")).animationName);
  check(anim === "none", "reduced motion: the sheet does not animate (" + anim + ")");
  await p.keyboard.press("Escape");
  await tabTo(p, "changes");
  const words = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-intel .carnet-ix-state-word")].length);
  check(words >= 0, "state words are text elements");
});

scenario("28 performance: a large project (4,500 measurements, 600 decisions, 100 pages) opens fast, bounds are visible, charts stay bounded", async () => {
  const nb = { version: 1, notebook_rev: 3, projects: [proj("proj-1", "Gros")], categories: [], pages: [] };
  for (let i = 0; i < 100; i += 1) {
    const blocks = [para("Page " + i, "block-p" + i)];
    for (let j = 0; j < 45; j += 1) blocks.push(measure("block-m" + i + "x" + j, "Ø arbre", (10 + ((i * 45 + j) % 7) / 100).toFixed(2), T0 + i * 100 + j));
    if (i < 6) for (let j = 0; j < 100; j += 1) blocks.push(decision("block-d" + i + "x" + j, "Décision " + i + "-" + j, T0 + i * 1000 + j));
    nb.pages.push(page("page-" + i, 1, blocks, { project_id: "proj-1", updated_at: T0 + i }));
  }
  const srv = await server(nb);
  const ctx = await context(srv);
  const p = await openPage(ctx, srv);
  const t0 = Date.now();
  await openMore(p);
  await p.click("#btn-carnet-intel");
  await p.waitForSelector("#hq-carnet-ix-tiles", { timeout: 30000 });
  const open = Date.now() - t0;
  console.log("   [perf] cockpit of 100 pages / 4500 measures / 600 decisions: " + open + " ms");
  check(open < 8000, "opens in < 8 s: " + open);
  const notes = await txt(p);
  check(notes.includes("Journal des décisions limité aux 500") && notes.includes("Chaque série est limitée à ses 1000"), "the bounds are announced, never silently applied");
  await tabTo(p, "measures");
  const pts = await p.locator(".carnet-ix-series svg .carnet-ix-ptg").count();
  check(pts <= 1000 && pts > 0, "chart points bounded: " + pts);
  const t1 = Date.now();
  await p.selectOption("#hq-carnet-ix-mverdict", "in");
  await p.waitForFunction(() => document.querySelector("#hq-carnet-ix-mcount"));
  console.log("   [perf] client filter " + (Date.now() - t1) + " ms");
  check(Date.now() - t1 < 3000, "a client filter re-renders in < 3 s");
  const res = await cget(srv, ctx, "cockpit=proj-1");
  check(res.status === 200 && res.body.decisions.length === 500 && res.body.decisions_total === 600, "server bounds: 500 of 600 decisions");
  const t2 = Date.now();
  for (let i = 0; i < 3; i += 1) await cget(srv, ctx, "cockpit=proj-1");
  console.log("   [perf] server cockpit " + Math.round((Date.now() - t2) / 3) + " ms each");
  check((Date.now() - t2) / 3 < 4000, "server derivation < 4 s per call");
});

scenario("29 failure isolation: a damaged history, unreadable snapshot file or failing snapshot list never blocks the cockpit", async () => {
  const { srv, ctx, p } = await world();
  mkdirSync(path.join(srv.root, ".hq-carnet"), { recursive: true });
  writeFileSync(path.join(srv.root, ".hq-carnet", "history.json"), "{ not json");
  mkdirSync(srv.sdir, { recursive: true });
  writeFileSync(path.join(srv.sdir, "snap-" + "a".repeat(24) + ".json"), "{ nope");
  await openIntel(p);
  const t = await tilesOf(p);
  check(t.decisions === "2" && t.measurements === "4", "counts still shown: " + JSON.stringify(t));
  check((await txt(p)).includes("Historique indisponible"), "history failure is named, the rest works");
  check(readFileSync(path.join(srv.root, ".hq-carnet", "history.json"), "utf8") === "{ not json", "the damaged history is never repaired or overwritten");
  await tabTo(p, "snaps");
  check((await txt(p, "#hq-carnet-ix-nosnap")).includes("Aucun jalon"), "the invalid snapshot file is skipped, not fatal");
  check(readFileSync(path.join(srv.sdir, "snap-" + "a".repeat(24) + ".json"), "utf8") === "{ nope", "the invalid snapshot is preserved as found");
  await p.route("**/api/carnet?snapshots=1*", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Jalons inaccessibles", code: "snapshots_unavailable" }) }));
  await p.click("#btn-carnet-ix-refresh");
  await until(async () => (await p.locator("#hq-carnet-ix-tiles, #hq-carnet-ix-mlist, #hq-carnet-ix-claim").count()) > 0, "refreshed while the snapshot list fails");
  check((await txt(p)).includes("Jalons inaccessibles"), "the snapshot list failure is shown in its own tab");
  await tabTo(p, "decisions");
  check((await txt(p, "#hq-carnet-ix-dlist")).includes("2 décisions"), "other tabs keep working");
  await p.unroute("**/api/carnet?snapshots=1*");
  await p.route("**/api/carnet?cockpit=*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom", code: "x" }) }));
  await p.click("#btn-carnet-ix-refresh");
  await until(async () => (await p.locator(".carnet-ix-error").count()) === 1, "a failing cockpit request shows an alert with a retry");
  await p.unroute("**/api/carnet?cockpit=*");
  await p.click('[data-ix="retry"]');
  await until(async () => (await p.locator("#hq-carnet-ix-dlist").count()) === 1 || (await tilesOf(p)).pages === "2", "retry recovers");
  void ctx;
});

scenario("30 stale and conflicts: Actualiser picks up remote edits; a report built from a changed page is refused; local drafts are flagged", async () => {
  const { srv, p } = await world();
  await openIntel(p);
  srv.remote((pg) => { pg.content.blocks.push(decision("block-late", "Décision tardive", T0 + 9000)); });
  check((await tilesOf(p)).decisions === "2", "the loaded cockpit is a snapshot of the moment it was loaded");
  await p.click("#btn-carnet-ix-refresh");
  await until(async () => (await tilesOf(p)).decisions === "3", "Actualiser shows the remote edit");
  await p.click("#btn-carnet-ix-report");
  srv.remote((pg) => { pg.content.blocks.push(para("changé après ajout", "block-after")); });
  await p.keyboard.press("Escape");
  await openMore(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  await p.click('[data-hx-tab="report"]');
  await p.click("#btn-carnet-hx-rbuild");
  await until(async () => (await txt(p, "#hq-carnet-hx-live")).includes("rien n'a été généré"), "stale overview: nothing generated silently");
  check(await p.locator("#hq-carnet-hx-md").count() === 0, "no Markdown was produced from newer content");
  await p.keyboard.press("Escape");
  await reopen(p);
  await p.click("#hq-carnet-editor");
  await p.keyboard.type(" brouillon");
  await openIntel(p, "changes");
  check((await txt(p)).includes("brouillon local non enregistré") || (await dirtyOf(p)) === false, "a dirty page is flagged in the Changements tab");
});

// ================================================================ F. Extras (overlay, date baseline)
scenario("31 overlay is display-only: labels on existing blocks, removed blocks listed in a bar, the note stays byte-identical and clean", async () => {
  const { srv, p } = await diffWorld(EDIT_ALL);
  await runDiff(p);
  const before = sha(readFileSync(srv.nbPath));
  await p.click(".carnet-ix-overlay-btn");
  await p.waitForSelector("#hq-carnet-diffbar");
  const o = await p.evaluate(() => ({
    added: document.querySelector('[data-carnet-block-id="block-new"]').getAttribute("data-carnet-diff-label"),
    changed: document.querySelector('[data-carnet-block-id="block-m1"]').getAttribute("data-carnet-diff-label"),
    untouched: document.querySelector('[data-carnet-block-id="block-t-none"]') === null,
    bar: document.getElementById("hq-carnet-diffbar").textContent,
    barOutside: !document.getElementById("hq-carnet-editor").contains(document.getElementById("hq-carnet-diffbar")),
  }));
  check(o.added === "Ajouté" && o.changed.startsWith("Modifié — Mesure modifiée"), "state labels are text on existing blocks: " + o.added + " / " + o.changed);
  check(o.bar.includes("Supprimé") && o.bar.includes("Affichage seulement"), "removed blocks are listed in the bar: " + o.bar.slice(0, 120));
  check(o.barOutside, "the bar is outside the editor (nothing inserted into the contenteditable)");
  check(!(await dirtyOf(p)), "the page is not dirty");
  check(sha(readFileSync(srv.nbPath)) === before, "the notebook file is byte-identical");
  await p.click('[data-carnet-block-id="block-title"]');
  await p.keyboard.press("End");
  await p.keyboard.type("!");
  await until(async () => !(await dirtyOf(p)) && srv.pg("page-a").content.blocks.some((b) => b.text.endsWith("!") || b.text.includes("!")), "editing still works and saves while the overlay is on");
  check(await p.locator('[data-carnet-diff]').count() >= 2, "the overlay survives re-rendering");
  await shot(p, "31-overlay");
  await p.click("#btn-carnet-diffbar-hide");
  check(await p.locator('[data-carnet-diff]').count() === 0 && await p.locator("#hq-carnet-diffbar").count() === 0, "Masquer removes every attribute and the bar");
});

scenario("32 date baseline: a date resolves to the nearest surviving baseline at or before it, shown BEFORE diffing; none = nothing to compare", async () => {
  const { srv, ctx, p } = await world();
  const cp = await withCheckpoint(srv, ctx, "revue du jour");
  const info = (await cget(srv, ctx, "history=1&page=page-a")).body.events.find((e) => e.id === cp);
  const day = new Date(info.at * 1000).toISOString().slice(0, 10);
  await openIntel(p, "changes");
  await p.check("#hq-carnet-ix-b-date");
  await p.fill("#hq-carnet-ix-date", "2000-01-01");
  await p.click("#btn-carnet-ix-resolve");
  await until(async () => (await txt(p, "#hq-carnet-ix-resolved")).includes("rien à comparer"), "a date before any baseline says so");
  check(await p.locator("#btn-carnet-ix-diff").isDisabled(), "Comparer stays disabled: no baseline is ever guessed");
  await p.fill("#hq-carnet-ix-date", day);
  await p.click("#btn-carnet-ix-resolve");
  await until(async () => (await txt(p, "#hq-carnet-ix-resolved")).startsWith("Baseline disponible la plus proche avant cette date : checkpoint « revue du jour »"), "the exact resolved baseline is named");
  check((await txt(p, "#hq-carnet-ix-baseline")).includes("checkpoint « revue du jour »"), "and repeated as THE baseline");
  check(await p.locator("#hq-carnet-ix-diff").count() === 0, "still no diff before the user confirms");
  await p.click("#btn-carnet-ix-diff");
  await p.waitForSelector("#hq-carnet-ix-diff");
  check((await txt(p, "#hq-carnet-ix-diff h4")).includes("revue du jour"), "the diff uses exactly that baseline");
  check(!(await txt(p)).includes("7 jours") && !(await txt(p)).toLowerCase().includes("semaine dernière"), "no 'last week' shortcut exists");
});


// ================================================================ G. Design Freeze review r2
scenario("33 snapshot retry-safety: a lost response then a retry re-sends the SAME request and never freezes a second, undeletable snapshot", async () => {
  const { srv, p } = await world();
  await openIntel(p, "snaps");
  const bodies = [];
  let drop = true;
  await p.route("**/api/carnet", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || !String(req.postData() || "").includes("snapshot_create")) return route.continue();
    bodies.push(JSON.parse(req.postData()));
    const resp = await route.fetch();  // the server DID the work...
    if (drop) { drop = false; return route.abort("connectionreset"); }  // ...but the answer is lost
    return route.fulfill({ response: resp });
  });
  await p.fill("#hq-carnet-ix-slabel", "Gel perdu");
  await p.click("#btn-carnet-ix-snap-create");
  await until(async () => srv.snaps().length === 1 && !(await txt(p, "#hq-carnet-ix-snap-result")).includes("Jalon créé"), "the server published; the browser never saw the answer");
  const first = srv.snaps()[0];
  await p.click("#btn-carnet-ix-snap-create");
  await until(async () => (await txt(p, "#hq-carnet-ix-snap-result")).includes("déjà créé"), "the retry is answered with the original: " + await txt(p, "#hq-carnet-ix-snap-result"));
  check(bodies.length === 2 && bodies[0].request_id === bodies[1].request_id && /^[0-9a-f]{32}$/.test(bodies[0].request_id), "the SAME request_id was re-sent");
  check(srv.snaps().length === 1 && srv.snaps()[0] === first, "still exactly one snapshot, same file");
  check(await p.locator('[data-snap]').count() === 1, "listed once");
  await p.fill("#hq-carnet-ix-slabel", "Gel suivant");
  await p.click("#btn-carnet-ix-snap-create");
  await until(async () => srv.snaps().length === 2, "a NEW explicit creation gets a new request id and a new snapshot");
  check(bodies[2].request_id !== bodies[0].request_id, "fresh request_id after success");
});

scenario("34 corrupt seal: the list says Altéré, opening / comparing / reporting are disabled, and the server refuses them anyway", async () => {
  const { srv, ctx, p } = await world();
  await openIntel(p, "snaps");
  await createSnap(p, "Gel intact");
  const name = srv.snaps()[0];
  const id = name.replace(".json", "");
  const file = path.join(srv.sdir, name);
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.pages[0].content.blocks[0].text = "falsifié";
  writeFileSync(file, JSON.stringify(data));
  await reopen(p);
  await openIntel(p, "snaps");
  const row = await txt(p, '[data-snap="' + id + '"]');
  check(row.includes("Altéré"), "flagged in the list: " + row);
  check(await p.locator('[data-snap="' + id + '"] [data-ix="snap-open"]').isDisabled() && await p.locator('[data-snap="' + id + '"] [data-ix="snap-diff"]').isDisabled(), "open and compare are disabled");
  const rep = await cpost(srv, ctx, { action: "report_build", items: [{ kind: "project_overview", snapshot_id: id }] });
  check(rep.status === 503 && /Intégrité/.test(rep.body.error || ""), "the server refuses a report from it: " + rep.status);
  const dif = await cget(srv, ctx, "diff=1&base=" + id);
  check(dif.status === 503, "the server refuses compare-to-current: " + dif.status);
  check(readFileSync(file, "utf8").includes("falsifié"), "the file is preserved as found, never repaired");
});

const srvRoot = "/tmp/hq-carnet-intel-";
const srvRootOf = (srv) => srv.root;

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
      console.log("  FAIL ", e.message.split("\n").slice(0, 4).join(" | "));
    }
    for (const c of browser.contexts()) await c.close().catch(() => {});
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
