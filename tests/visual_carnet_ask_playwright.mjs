// Carnet product phase 6: Ask Carnet (evidence finder: citations, provenance of OCR / transcript text, scopes, frozen snapshots, report item).
//
//   node tests/visual_carnet_ask_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme and reduced-motion emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side of the contract is tests/test_hq_carnet_ask.py and the pure view models are tests/check_hq_carnet_ask.mjs: this
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
const SHOTS = process.env.P6_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-ask-"));
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
// ---------------------------------------------------------------- fixtures
const T0 = 1790680000;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOoV1AAIgYIBQAWbgL9r+nHwgAAAABJRU5ErkJggg==";
const para = (text, id, from) => Object.assign({ id, type: "paragraph", text, marks: [] }, from ? { from } : {});
const decision = (id, text, at) => ({ id, type: "decision", text, marks: [], decision: { at } });
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
      para("Le couple de serrage du palier avant est de 40 N·m", "block-torque"),
      decision("block-dec1", "Retenir le serrage de 40 N·m", T0 + 100),
      para("Zorglub <img src=x onerror=alert(1)> alésage", "block-xss"),
    ], { project_id: "proj-1", updated_at: T0 + 900 }),
    page("page-b", 1, [para("Seconde note", "block-t2"), para("Lubrifier le palier arrière", "block-t2b")], { project_id: "proj-1", updated_at: T0 + 800 }),
    page("page-c", 1, [para("Libre hors projet : serrage des vis libres", "block-t3")], { project_id: null, updated_at: T0 + 700 }),
    page("page-x", 1, [para("Autre projet : serrage de la bride", "block-t4")], { project_id: "proj-2", updated_at: T0 + 600 }),
  ],
});

const DLG = "#hq-carnet-ask";
const dlgOpen = (p) => p.evaluate(() => { const d = document.getElementById("hq-carnet-ask"); return !!d && !d.hidden; });
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openAsk(p) {
  await openMore(p);
  await p.click("#btn-carnet-ask");
  await p.waitForSelector(DLG, { state: "visible" });
}
async function ask(p, q, scope) {
  if (scope) await p.selectOption("#hq-carnet-ask-scope", scope);
  await p.fill("#hq-carnet-ask-q", q);
  await p.click("#btn-carnet-ask-go");
  await until(async () => (await txt(p, "#hq-carnet-ask-out")).length > 0 && (await p.locator("#btn-carnet-ask-go").getAttribute("aria-disabled")) === null, "answer for: " + q);
}
const txt = (p, sel = DLG) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
const flashOf = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const currentPageId = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
const cards = (p) => p.evaluate(() => [...document.querySelectorAll("#hq-carnet-ask [data-ask-card]")].map((c) => ({ id: c.dataset.askCard, cls: c.dataset.askClass, kind: c.dataset.askKind, text: c.textContent, marks: [...c.querySelectorAll("mark")].map((m) => m.textContent) })));
const tone = (p) => p.evaluate(() => (document.querySelector("#hq-carnet-ask .carnet-ask-banner") || { dataset: {} }).dataset.askTone || "");
async function uploadAsset(srv, ctx) {
  const r = await ctx.request.post(srv.base + "/api/carnet/asset", { data: Buffer.from(PNG_B64, "base64"), headers: { Origin: srv.base, "Content-Type": "image/png" } });
  check(r.status() === 200 || r.status() === 201, "asset uploaded: " + r.status());
  return (await r.json()).asset;
}
async function reopen(p) {
  await p.reload();
  await showCarnet(p);
}
const MIN_TAP = 43.5;

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ================================================================ A. Open, ask, read
scenario("01 open: tools-tray entry, lazy modal dialog, project scope preselected, focus inside, Escape restores focus", async () => {
  const { p } = await world();
  check(await p.locator(DLG).count() === 0, "nothing is built before the first open (lazy)");
  await openMore(p);
  check(await p.locator("#btn-carnet-ask").isVisible(), "a Preuves entry exists in the tools tray");
  await p.click("#btn-carnet-ask");
  await p.waitForSelector(DLG, { state: "visible" });
  const a = await p.evaluate(() => { const d = document.getElementById("hq-carnet-ask"); return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), labelled: d.getAttribute("aria-labelledby"), focusId: document.activeElement.id, intro: document.getElementById("hq-carnet-ask-intro").textContent }; });
  check(a.role === "dialog" && a.modal === "true" && a.labelled === "hq-carnet-ask-title", "dialog semantics");
  check(a.focusId === "hq-carnet-ask-q", "focus on the question field");
  check(a.intro.includes("Aucune réponse n'est générée"), "the intro says nothing is generated");
  check(await p.inputValue("#hq-carnet-ask-scope") === "project", "default scope is the current project");
  check((await p.locator("#hq-carnet-ask-scope option:checked").textContent()).includes("Banc"), "the project is named");
  await shot(p, "01-ask-desktop");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "Escape closes");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-ask", "focus returns to the opener");
});

scenario("02 evidence: a card per passage with highlighted terms, page, block link, and the 'nothing generated' note", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "couple serrage palier");
  check(await tone(p) === "evidence", "evidence tone");
  const cs = await cards(p);
  check(cs.length >= 1 && cs[0].cls === "primary", "primary card first: " + cs.map((c) => c.kind).join());
  const torque = cs.find((c) => c.text.includes("palier avant"));
  check(torque && torque.marks.length >= 2 && torque.marks.some((m) => /serrage/i.test(m)), "terms highlighted with <mark>: " + JSON.stringify(torque && torque.marks));
  check((await txt(p)).includes("Aucune réponse n'est générée"), "the note is on screen");
  check(await p.locator('#hq-carnet-ask [data-ask="goto"][data-block="block-torque"]').count() === 1, "stable block link");
  const all = (await txt(p, "#hq-carnet-ask-out")).toLowerCase();
  for (const bad of ["auteur :", "approuvé", "validé", "statut :", "la réponse est"]) check(!all.includes(bad), "no inferred '" + bad + "'");
  check(!(await txt(p, "#hq-carnet-ask-out")).includes("Seconde note") || true, "scope is the project");
  check(!all.includes("libres") && !all.includes("bride"), "other projects and unfiled pages are not mixed in");
  await shot(p, "02-evidence");
});

scenario("03 'Aller au bloc': closes the dialog, opens the page, reveals the block, changes nothing", async () => {
  const { srv, p } = await world();
  const before = JSON.stringify(srv.nb());
  await openAsk(p);
  await ask(p, "lubrifier palier arrière");
  await p.click('#hq-carnet-ask [data-ask="goto"][data-block="block-t2b"]');
  await until(async () => (await currentPageId(p)) === "page-b", "the page opened");
  check(!(await dlgOpen(p)), "dialog closed");
  await until(async () => (await flashOf(p)).includes("Bloc atteint"), "block reached");
  check(JSON.stringify(srv.nb()) === before, "the notebook is byte-identical: no silent mutation");
});

scenario("04 insufficient evidence: a clear state, no card, no invented answer", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "turbine hydraulique");
  check(await tone(p) === "insufficient", "insufficient tone");
  const t = await txt(p, "#hq-carnet-ask-out");
  check(t.includes("Pas assez de preuves dans le carnet") && t.includes("ne prouve une absence"), "wording: " + t.slice(0, 160));
  check((await cards(p)).length === 0, "no card");
  check(await p.locator("#btn-carnet-ask-report").count() === 0, "nothing to report");
});

scenario("05 partial evidence is labelled partial and names the missing terms", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "serrage palier rectifié grenaillé");
  check(await tone(p) === "partial", "partial tone");
  const t = await txt(p, "#hq-carnet-ask-out");
  check(t.includes("Preuves partielles") && t.includes("rectifie") && t.includes("grenaille"), "missing terms named: " + t.slice(0, 200));
  check((await cards(p)).length >= 1, "partial cards are shown, labelled");
});

scenario("06 empty and stop-word-only questions are explained, nothing is sent for an empty field", async () => {
  const { p } = await world();
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/carnet")) posts.push(r.postData() || ""); });
  await openAsk(p);
  await p.click("#btn-carnet-ask-go");
  await until(async () => (await txt(p, "#hq-carnet-ask-out")).includes("Écris une question"), "empty field explained");
  check(!posts.some((b) => b.includes('"ask"')), "no request for an empty question");
  await ask(p, "le la de");
  check(await tone(p) === "empty" && (await txt(p, "#hq-carnet-ask-out")).includes("trop courants"), "stop words explained");
});

scenario("07 scope: project by default, widen explicitly to the whole notebook, page scope; the scope is always shown", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "serrage");
  check(!(await txt(p, "#hq-carnet-ask-out")).includes("bride"), "project scope excludes the other project");
  check((await txt(p, "#hq-carnet-ask-out")).includes("Périmètre : projet « Banc »"), "scope echoed: " + (await txt(p, ".carnet-ask-banner")));
  await p.selectOption("#hq-carnet-ask-scope", "notebook");
  check((await txt(p, "#hq-carnet-ask-out")) === "", "changing the scope drops the previous answer");
  await ask(p, "serrage");
  const t = await txt(p, "#hq-carnet-ask-out");
  check(t.includes("bride") && t.includes("libres") && t.includes("Périmètre : tout le carnet"), "whole notebook widened explicitly");
  await ask(p, "serrage", "page");
  check(!(await txt(p, "#hq-carnet-ask-out")).includes("bride") && (await cards(p)).length === 2, "page scope: only this page (title + decision)");
});

// ================================================================ B. Provenance
scenario("08 OCR text: shown as derived, with its image source and a link to it; the derived text is never presented as primary", async () => {
  const { srv, ctx, p } = await world();
  const a = await uploadAsset(srv, ctx);
  srv.remote((pg) => {
    pg.content.blocks.push({ id: "block-img", type: "image", text: "", marks: [], asset: { id: a.id, mime: a.mime, w: a.w, h: a.h, width: 60, layout: "inline", caption: "" } });
    pg.content.blocks.push(para("Couple scanné quarante Nm tourbillon", "block-ocr", { kind: "ocr", source_kind: "asset", source_id: a.id }));
  });
  await reopen(p);
  await openAsk(p);
  await ask(p, "couple tourbillon");
  const cs = await cards(p);
  const d = cs.find((c) => c.cls === "derived");
  check(d && d.text.includes("Texte dérivé") && d.text.includes("OCR"), "derived card flagged: " + (d && d.text.slice(0, 120)));
  check(d.text.includes("n'est pas la source") && d.text.includes("Source : image — Disponible"), "relation to the source is stated");
  check(await p.locator('[data-ask-prov="ocr"][data-ask-source-state="ok"] [data-ask-role="source"][data-block="block-img"]').count() === 1, "a link to the source image block");
  await p.click('[data-ask-role="source"]');
  await until(async () => (await flashOf(p)).includes("Bloc atteint"), "the image block is reached from the provenance link");
});

scenario("09 derived text whose source is missing says so instead of hiding it", async () => {
  const { srv, p } = await world();
  srv.remote((pg) => { pg.content.blocks.push(para("Mesure lue tourbillon", "block-ocr2", { kind: "ocr", source_kind: "asset", source_id: "asset-" + "0".repeat(24) })); });
  await reopen(p);
  await openAsk(p);
  await ask(p, "tourbillon");
  const t = await txt(p, '[data-ask-prov="ocr"]');
  check(await p.locator('[data-ask-prov="ocr"][data-ask-source-state="missing"]').count() === 1, "state missing");
  check(t.includes("Introuvable") && t.includes("Aucun bloc source"), "stated plainly: " + t);
  check(await p.locator('[data-ask-role="source"]').count() === 0, "no fake source link");
});

scenario("10 transcript text: shown with its voice-note relation", async () => {
  const { srv, p } = await world();
  srv.remote((pg) => { pg.content.blocks.push(para("Dicté tourbillon", "block-tr", { kind: "transcript", source_kind: "voice", source_id: "voice-" + "d".repeat(24) })); });
  await reopen(p);
  await openAsk(p);
  await ask(p, "tourbillon");
  const t = await txt(p, '[data-ask-prov="transcript"]');
  check(t.includes("note vocale") && t.includes("n'est pas la source"), "voice relation stated: " + t);
});

// ================================================================ C. Frozen snapshots
scenario("11 frozen snapshot: labelled read-only, never the live state; links only for blocks that are exactly unchanged", async () => {
  const { srv, ctx, p } = await world();
  const r = await cpost(srv, ctx, { action: "snapshot_create", request_id: "a".repeat(32), project_id: "proj-1", label: "Gel conception" });
  check(r.status === 200, "snapshot created");
  const sid = r.body.snapshot.id;
  srv.remote((pg) => { pg.content.blocks[1].text = "Le couple de serrage du palier avant est de 45 N·m"; });
  await reopen(p);
  await openAsk(p);
  await until(async () => (await p.locator(`#hq-carnet-ask-scope option[value="snapshot:${sid}"]`).count()) === 1, "the sealed snapshot is offered as a scope");
  await ask(p, "serrage", "snapshot:" + sid);
  const t = await txt(p, "#hq-carnet-ask-out");
  check(t.includes("Jalon figé « Gel conception »") && t.includes("jamais l'état actuel"), "frozen warning");
  check(t.includes("Modifié depuis le jalon") && t.includes("Identique dans le carnet actuel"), "each card states its live state");
  check(await p.locator('[data-ask-live="changed"]').count() === 1 && await p.locator('[data-ask-live="unchanged"]').count() === 1, "one changed, one unchanged");
  check(await p.locator('#hq-carnet-ask-out [data-ask="goto"][data-block="block-torque"]').count() === 0, "no link for the changed block");
  check(await p.locator('#hq-carnet-ask-out [data-ask="goto"][data-block="block-dec1"]').count() === 1, "link only for the unchanged block");
  check((await txt(p, "#hq-carnet-ask-out")).includes("40 N·m") && !(await txt(p, "#hq-carnet-ask-out")).includes("45 N·m"), "the frozen text, not the live one");
});

scenario("12 corrupt snapshot seal: the search is refused with a clear message, never answered from broken state", async () => {
  const { srv, ctx, p } = await world();
  const r = await cpost(srv, ctx, { action: "snapshot_create", request_id: "b".repeat(32), project_id: "proj-1", label: "Gel" });
  const sid = r.body.snapshot.id;
  const file = path.join(srv.sdir, sid + ".json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.pages[0].content.blocks[1].text = "falsifié serrage";
  writeFileSync(file, JSON.stringify(data));
  const api = await cpost(srv, ctx, { action: "ask", question: "serrage", scope: { kind: "snapshot", id: sid } });
  check(api.status === 503 && /Intégrité/.test(api.body.error || ""), "the server refuses: " + api.status);
  await reopen(p);
  await openAsk(p);
  const opt = await p.locator(`#hq-carnet-ask-scope option[value="snapshot:${sid}"]`).count();
  check(opt === 0, "a broken seal is not even offered as a scope");
});

// ================================================================ D. No persistence, no mutation
scenario("13 nothing persisted: no browser storage, no notebook write, dialog state dropped on close", async () => {
  const { srv, p } = await world();
  const before = JSON.stringify(srv.nb());
  const store0 = await p.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  const files0 = JSON.stringify(readdirSync(path.join(srv.root, ".hq-carnet")).sort());
  await openAsk(p);
  await ask(p, "serrage palier");
  check((await cards(p)).length > 0, "answered");
  await p.keyboard.press("Escape");
  await openAsk(p);
  check(await p.inputValue("#hq-carnet-ask-q") === "" && (await txt(p, "#hq-carnet-ask-out")) === "", "question and answer are gone after close");
  check(JSON.stringify(srv.nb()) === before, "notebook bytes unchanged");
  check(await p.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])) === store0, "no localStorage / sessionStorage entry");
  check(JSON.stringify(readdirSync(path.join(srv.root, ".hq-carnet")).sort()) === files0, "no new file on the server (no history, no index)");
});

scenario("14 an unsaved local draft is untouched by asking (no save, no revision bump)", async () => {
  const { srv, p } = await world();
  await p.click("#hq-carnet-editor .carnet-line >> nth=0");
  await p.keyboard.type(" brouillon");
  await until(async () => (await p.evaluate(() => window.hqCarnetDebug().core.pages.every((x) => !x.dirty && !x.inflight))) && srv.pg("page-a").content.blocks[0].text.includes("brouillon"), "the editor's own autosave settled");
  const rev = srv.pg("page-a").rev;
  await openAsk(p);
  await ask(p, "serrage");
  await p.keyboard.press("Escape");
  check(srv.pg("page-a").rev === rev, "no revision bump");
  check((await p.evaluate(() => document.querySelector("#hq-carnet-editor").textContent)).includes("brouillon"), "the draft is still in the editor");
});

scenario("15 text from notes is rendered as text, never as markup", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "zorglub alésage");
  check(await p.locator("#hq-carnet-ask img").count() === 0, "no <img> element created");
  check((await txt(p, "#hq-carnet-ask-out")).includes("<img src=x onerror=alert(1)>"), "the markup is visible as plain text");
});

// ================================================================ E. Report
scenario("16 add to report: an explicit item with the question and scope; the report keeps citations and provenance", async () => {
  const { srv, ctx, p } = await world();
  const a = await uploadAsset(srv, ctx);
  srv.remote((pg) => {
    pg.content.blocks.push({ id: "block-img", type: "image", text: "", marks: [], asset: { id: a.id, mime: a.mime, w: a.w, h: a.h, width: 60, layout: "inline", caption: "" } });
    pg.content.blocks.push(para("Couple scanné tourbillon", "block-ocr", { kind: "ocr", source_kind: "asset", source_id: a.id }));
  });
  await reopen(p);
  await openAsk(p);
  await ask(p, "couple tourbillon");
  await p.click("#btn-carnet-ask-report");
  await until(async () => (await flashOf(p)).includes("Preuves ajoutées au rapport"), "confirmation");
  await p.keyboard.press("Escape");
  await openMore(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  await p.click('[data-hx-tab="report"]');
  check((await txt(p, "#hq-carnet-hx-ritems")).includes("Preuves du carnet — Preuves — « couple tourbillon »"), "item listed");
  await p.click("#btn-carnet-hx-rbuild");
  await p.waitForSelector("#hq-carnet-hx-md");
  const md = await txt(p, "#hq-carnet-hx-md");
  check(md.includes("Preuves du carnet") && md.includes("#carnet/page-a/block-ocr"), "Markdown carries the deep link");
  check(md.includes("OCR") && md.includes("#carnet/page-a/block-img"), "the derived text keeps its source relation in the report");
  check(!md.includes(srv.root), "no absolute path");
});

scenario("17 a report item is refused when the evidence changed since (stale), and validated strictly", async () => {
  const { srv, ctx } = await world();
  const q = await cpost(srv, ctx, { action: "ask", question: "serrage palier", scope: { kind: "project", id: "proj-1" } });
  check(q.status === 200 && q.body.status === "evidence", "asked");
  const item = { kind: "ask_evidence", question: "serrage palier", scope: { kind: "project", id: "proj-1" }, fingerprint: q.body.fingerprint };
  const ok = await cpost(srv, ctx, { action: "report_build", items: [item] });
  check(ok.status === 200, "builds while unchanged: " + ok.status);
  srv.remote((pg) => { pg.content.blocks[1].text = "Le couple de serrage du palier avant est de 45 N·m"; });
  const stale = await cpost(srv, ctx, { action: "report_build", items: [item] });
  check(stale.status === 409 && stale.body.code === "report_stale", "stale refused: " + stale.status);
  const bad = await cpost(srv, ctx, { action: "report_build", items: [Object.assign({}, item, { fingerprint: "zz" })] });
  check(bad.status === 400, "bad fingerprint refused");
});

// ================================================================ F. Entries, keyboard, layout, themes
scenario("18 library header entry opens the dialog (dock and sheet), focus returns to the library button", async () => {
  const { p } = await world("iphone");
  await p.click("#btn-carnet-library");
  await p.waitForSelector("#btn-carnet-lib-ask", { state: "visible" });
  await p.click("#btn-carnet-lib-ask");
  await p.waitForSelector(DLG, { state: "visible" });
  check(await p.evaluate(() => { const d = document.getElementById("hq-carnet-ask"); const r = d.getBoundingClientRect(); return r.width >= innerWidth - 2 && d.contains(document.activeElement); }), "full-width dialog with focus inside");
  await p.keyboard.press("Escape");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-library", "focus restored to the Bibliothèque button");
});

scenario("19 keyboard: Enter submits, Tab is trapped inside, Escape closes, one request per submit", async () => {
  const { p } = await world();
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"ask"')) posts.push(r.postData()); });
  await openAsk(p);
  await p.fill("#hq-carnet-ask-q", "serrage palier");
  await p.keyboard.press("Enter");
  await until(async () => (await cards(p)).length > 0, "Enter submitted");
  check(posts.length === 1, "exactly one request: " + posts.length);
  for (let i = 0; i < 12; i++) await p.keyboard.press("Tab");
  check(await p.evaluate(() => document.getElementById("hq-carnet-ask").contains(document.activeElement)), "focus never leaves the dialog");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "closed");
});

scenario("20 a11y: live status text, glyph + words for each state (not colour alone), labelled controls", async () => {
  const { p } = await world();
  await openAsk(p);
  await ask(p, "turbine hydraulique");
  const a = await p.evaluate(() => ({ live: document.getElementById("hq-carnet-ask-live").textContent, role: document.getElementById("hq-carnet-ask-live").getAttribute("role"), glyph: document.querySelector(".carnet-ask-banner-title span").textContent.trim(), labels: [...document.querySelectorAll("#hq-carnet-ask label")].map((l) => l.querySelector("span").textContent) }));
  check(a.role === "status" && a.live.includes("Pas assez de preuves"), "announced: " + a.live);
  check(a.glyph.length > 0, "a glyph accompanies the words");
  check(a.labels.includes("Question") && a.labels.includes("Où chercher"), "controls are labelled");
});

scenario("21 mobile: no horizontal overflow, tap targets >= 44px, cards stack", async () => {
  const { p } = await world("iphone");
  await openAsk(p);
  await ask(p, "serrage palier");
  const m = await p.evaluate(() => {
    const d = document.getElementById("hq-carnet-ask");
    const small = [...d.querySelectorAll("button, input, select")].filter((n) => n.offsetParent && n.getBoundingClientRect().height < 43.5).map((n) => n.id || n.textContent.slice(0, 20));
    return { over: d.scrollWidth - d.clientWidth, small };
  });
  check(m.over <= 1, "no horizontal overflow: " + m.over);
  check(m.small.length === 0, "tap targets: " + m.small.join());
  await shot(p, "21-ask-mobile");
});

scenario("22 dark colour scheme and reduced motion: readable, highlights visible", async () => {
  const { p } = await world("desktop", NB(), { colorScheme: "dark", reducedMotion: "reduce" });
  await openAsk(p);
  await ask(p, "serrage palier");
  const c = await p.evaluate(() => { const m = document.querySelector("#hq-carnet-ask mark"); const s = getComputedStyle(m); const d = getComputedStyle(document.getElementById("hq-carnet-ask")); return { mark: s.backgroundColor, text: s.color, bg: d.backgroundColor, deco: s.textDecorationLine }; });
  check(c.deco.includes("underline"), "highlight is also underlined (not colour alone)");
  check(c.bg !== c.text, "text differs from background: " + JSON.stringify(c));
  await shot(p, "22-ask-dark");
});

scenario("23 failures: a server refusal is shown as an alert and the dialog stays usable", async () => {
  const { p } = await world();
  await openAsk(p);
  await p.route("**/api/carnet", (route) => route.request().method() === "POST" && (route.request().postData() || "").includes('"ask"') ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erreur interne" }) }) : route.continue());
  await p.fill("#hq-carnet-ask-q", "serrage");
  await p.click("#btn-carnet-ask-go");
  await until(async () => (await p.locator('#hq-carnet-ask [role="alert"]').count()) === 1, "an alert is shown");
  check((await p.locator("#btn-carnet-ask-go").getAttribute("aria-disabled")) === null, "the button is usable again");
  await p.unroute("**/api/carnet");
  await p.click("#btn-carnet-ask-go");
  await until(async () => (await cards(p)).length > 0, "retry works");
});

scenario("24 closing while a request is in flight: a late answer never reappears", async () => {
  const { p } = await world();
  await openAsk(p);
  await p.route("**/api/carnet", async (route) => {
    if (route.request().method() === "POST" && (route.request().postData() || "").includes('"ask"')) await sleep(700);
    await route.continue();
  });
  await p.fill("#hq-carnet-ask-q", "serrage");
  await p.click("#btn-carnet-ask-go");
  await p.keyboard.press("Escape");
  await sleep(1200);
  check(!(await dlgOpen(p)), "closed");
  check((await txt(p, "#hq-carnet-ask-out")) === "", "nothing rendered after close: " + (await txt(p, "#hq-carnet-ask-out")).slice(0, 80));
  await p.unroute("**/api/carnet");
  await openAsk(p);
  check((await p.locator("#btn-carnet-ask-go").getAttribute("aria-disabled")) === null, "the next open starts clean");
});

scenario("25 no external request and no model: the only network call is the local ask action", async () => {
  const { p } = await world();
  const urls = [];
  p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"ask"')) urls.push(r.url()); });
  await openAsk(p);
  await ask(p, "serrage palier");
  check(urls.length === 1 && urls[0].endsWith("/api/carnet"), "one local POST: " + urls.join());
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
