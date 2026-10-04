// Carnet product phase 7: review packs (evidence workflows: add evidence, freshness vs stored copy, checklist, questions, 409, delete confirmation, export).
//
//   node tests/visual_carnet_reviews_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme and reduced-motion emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side of the contract is tests/test_hq_carnet_reviews.py and the pure view models are tests/check_hq_carnet_reviews.mjs: this
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
const SHOTS = process.env.P7_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-reviews-"));
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

const DLG = "#hq-carnet-rv";
const dlgOpen = (p) => p.evaluate(() => { const d = document.getElementById("hq-carnet-rv"); return !!d && !d.hidden; });
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openReviews(p) {
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector(DLG, { state: "visible" });
  await until(async () => (await p.locator("#hq-carnet-rv-none, #hq-carnet-rv-list").count()) > 0, "review list loaded");
}
const txt = (p, sel = DLG) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
const flashOf = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const rvFiles = (srv) => { const d = path.join(srv.root, ".hq-carnet", "reviews"); return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith("rvw-")).sort() : []; };
const rvRead = (srv, name) => JSON.parse(readFileSync(path.join(srv.root, ".hq-carnet", "reviews", name), "utf8"));
const rid = () => [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
async function createViaApi(srv, ctx, title = "Revue banc", extra = {}) {
  const r = await cpost(srv, ctx, Object.assign({ action: "review_create", project_id: "proj-1", title, request_id: rid() }, extra));
  check(r.status === 200, "review created via API: " + r.status);
  return r.body.review;
}
async function addViaApi(srv, ctx, pack, item) {
  const r = await cpost(srv, ctx, { action: "review_item_add", id: pack.id, expected_rev: pack.rev, item });
  check(r.status === 200, "item added via API (" + item.kind + "): " + r.status + " " + JSON.stringify(r.body).slice(0, 120));
  return r.body.review;
}
async function createInUi(p, title) {
  await p.fill("#hq-carnet-rv-new-title", title);
  await p.click("#btn-carnet-rv-create");
  await p.waitForSelector("#hq-carnet-rv-name");
}
async function openPack(p, title) {
  await p.click(`[data-rv="open"][aria-label="Ouvrir la revue « ${title} »"]`);
  await p.waitForSelector("#hq-carnet-rv-name");
}
async function tab(p, key) {
  await p.click(`[data-rv-tab="${key}"]`);
  await p.waitForSelector(`[data-rv-panel="${key}"]`);
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const MIN_TAP = 43.5;
async function reopen(p) {
  await p.reload();
  await showCarnet(p);
}
async function openIntelTab(p, key) {
  await openMore(p);
  await p.click("#btn-carnet-intel");
  await p.waitForSelector("#hq-carnet-intel", { state: "visible" });
  await p.waitForFunction(() => !document.querySelector("#hq-carnet-intel .carnet-ix-body").textContent.includes("Chargement"), null, { timeout: 15000 });
  await p.click(`[data-ix-tab="${key}"]`);
  await p.waitForFunction(() => !document.querySelector("#hq-carnet-intel .carnet-ix-body").textContent.includes("Chargement…"), null, { timeout: 15000 });
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ================================================================ A. Open, create
scenario("01 open: tools-tray + library entries, lazy modal dialog on the shared shell, focus inside, Escape restores focus", async () => {
  const { p } = await world();
  check(await p.locator(DLG).count() === 0, "nothing is built before the first open (lazy)");
  await openMore(p);
  check(await p.locator("#btn-carnet-reviews").isVisible(), "a Revues entry exists in the tools tray");
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector(DLG, { state: "visible" });
  const a = await p.evaluate(() => { const d = document.getElementById("hq-carnet-rv"); return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), labelled: d.getAttribute("aria-labelledby"), shell: d.classList.contains("carnet-hx"), n: document.querySelectorAll(".carnet-hx:not([hidden])").length }; });
  check(a.role === "dialog" && a.modal === "true" && a.labelled === "hq-carnet-rv-title" && a.shell, "dialog semantics on the .carnet-hx shell");
  check(a.n === 1, "no second shell is open");
  await until(async () => (await txt(p, "#hq-carnet-rv-intro")).includes("Il ne conclut rien"), "the intro says it concludes nothing");
  check((await txt(p)).includes("Aucune revue pour ce projet"), "empty state");
  await shot(p, "01-reviews-desktop");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "Escape closes");
  check(await p.evaluate(() => document.activeElement && document.activeElement.id) === "btn-carnet-reviews", "focus returns to the opener");
});

scenario("02 create in the UI: the pack is a file on the server, defaults to draft, status is only what the user picks", async () => {
  const { srv, p } = await world();
  await openReviews(p);
  await createInUi(p, "Revue conception");
  check(rvFiles(srv).length === 1, "one file under .hq-carnet/reviews");
  const f = rvRead(srv, rvFiles(srv)[0]);
  check(f.status === "draft" && f.rev === 1 && f.title === "Revue conception" && f.baseline.kind === "live", "draft, rev 1, live context");
  check((await txt(p, "#hq-carnet-rv-notverdict")).includes("Il ne conclut rien"), "overview repeats that nothing is concluded");
  await p.selectOption("#hq-carnet-rv-status", "reviewed");
  await until(async () => rvRead(srv, rvFiles(srv)[0]).status === "reviewed", "status changed only by the explicit selection");
  check(rvRead(srv, rvFiles(srv)[0]).rev === 2, "revision bumped");
  await shot(p, "02-pack-overview");
});

scenario("03 hostile text is data: title, note, checklist and questions render as text, never as HTML", async () => {
  const { srv, p } = await world();
  await openReviews(p);
  await createInUi(p, "<img src=x onerror=alert(1)> **titre**");
  check(await p.locator("#hq-carnet-rv-name img").count() === 0, "no element was created from the title");
  check((await txt(p, "#hq-carnet-rv-name")).includes("<img src=x onerror=alert(1)>"), "the title is shown literally");
  await tab(p, "checklist");
  await p.fill("#hq-carnet-rv-new-check", "<script>window.__x=1</script> vérifier");
  await p.click("#btn-carnet-rv-check-add");
  await until(async () => (await p.locator("[data-rv-check-row]").count()) === 1, "check added");
  check(await p.evaluate(() => window.__x === undefined), "no script ran");
  check((await txt(p, "#hq-carnet-rv-checks")).includes("<script>"), "literal text");
  check(rvRead(srv, rvFiles(srv)[0]).checklist[0].text.includes("<script>"), "stored exactly as typed");
});

// ================================================================ B. Evidence
scenario("04 cockpit → 'Ajouter au dossier de revue': a decision is added with a server seal and a captured copy", async () => {
  const { srv, p } = await world();
  await openIntelTab(p, "decisions");
  await p.waitForSelector('[data-ix="review"][data-rkind="decision"]');
  await p.click('[data-ix="review"][data-rkind="decision"]');
  await p.waitForSelector("#hq-carnet-rv-add", { state: "visible" });
  check(!(await p.locator("#hq-carnet-intel").isVisible()), "the cockpit closed, one dialog at a time");
  await p.fill("#hq-carnet-rv-new-title", "Revue décisions");
  await p.click("#btn-carnet-rv-create");
  await until(async () => rvFiles(srv).length === 1 && rvRead(srv, rvFiles(srv)[0]).items.length === 1, "the decision was added");
  const it = rvRead(srv, rvFiles(srv)[0]).items[0];
  check(it.kind === "decision" && it.key.block_id === "block-dec1" && /^[0-9a-f]{64}$/.test(it.seal.block_sha256), "server-sealed identity: " + JSON.stringify(it.seal).slice(0, 80));
  check(it.copy.text.includes("Retenir le serrage"), "captured copy");
  check((await flashOf(p)).includes("Ajouté à la revue"), "confirmation");
  check(!(await dlgOpen(p)), "dialog closed after adding");
});

scenario("05 evidence tab: stored copy and current observation are separate blocks; a change only changes the observation", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-a" });
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "evidence");
  await until(async () => (await p.locator('[data-rv-item] [data-rv-obs="unchanged"]').count()) === 1, "observed unchanged");
  const before = await txt(p, "[data-rv-item] .carnet-rv-copy");
  srv.remote((pg) => { pg.content.blocks[1].text = "Le couple de serrage du palier avant est de 45 N·m"; });
  await p.click("#btn-carnet-rv-back");
  await openPack(p, "Revue banc");
  await tab(p, "evidence");
  await until(async () => (await p.locator('[data-rv-item] [data-rv-obs="changed"]').count()) === 1, "observation says changed");
  check((await txt(p, "[data-rv-item] .carnet-rv-state")).includes("Modifié depuis la sélection"), "in words, not colour only");
  check(await txt(p, "[data-rv-item] .carnet-rv-copy") === before, "the stored copy is untouched");
  check(await txt(p, "[data-rv-item] .carnet-rv-copy").then((t) => t.includes("jamais actualisée")), "the copy says it is never refreshed");
  check(canon(rvRead(srv, rvFiles(srv)[0]).items) === canon(pk.items), "the file on disk was not rewritten by the observation");
  await shot(p, "05-evidence-changed");
});

scenario("06 missing evidence: item says 'Introuvable', the pack stays usable, other items are unaffected", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-b" });
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-a" });
  srv.remote((pg) => { pg.deleted_at = T0 + 5000; }, "page-b");
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "freshness");
  await until(async () => (await p.locator("#hq-carnet-rv-counts [data-rv-count='missing']").textContent()).includes(": 1"), "one missing");
  check((await p.locator("#hq-carnet-rv-counts [data-rv-count='unchanged']").textContent()).includes(": 1"), "one unchanged");
  await tab(p, "checklist");
  await p.fill("#hq-carnet-rv-new-check", "encore éditable");
  await p.click("#btn-carnet-rv-check-add");
  await until(async () => (await p.locator("[data-rv-check-row]").count()) === 1, "the pack still accepts edits");
});

scenario("07 snapshot context: items are evaluated on the frozen state and say so; the live difference is reported separately", async () => {
  const { srv, ctx, p } = await world();
  const s = await cpost(srv, ctx, { action: "snapshot_create", request_id: rid(), project_id: "proj-1", label: "Gel conception" });
  check(s.status === 200, "snapshot created");
  const pk0 = await createViaApi(srv, ctx, "Revue gelée", { baseline: { kind: "snapshot", snapshot_id: s.body.snapshot.id } });
  await addViaApi(srv, ctx, pk0, { kind: "page", page_id: "page-a" });
  srv.remote((pg) => { pg.content.blocks[1].text = "modifié après le gel"; });
  await openReviews(p);
  await openPack(p, "Revue gelée");
  check((await txt(p, "#hq-carnet-rv-baseline-text")).includes("Gel conception"), "context shown");
  await tab(p, "evidence");
  await until(async () => (await txt(p, "[data-rv-item]")).includes("L'état actuel diffère de l'état figé"), "current differs, in words");
  check((await txt(p, "[data-rv-item] .carnet-rv-state")).includes("Inchangé"), "frozen evidence is unchanged");
  check((await txt(p, "[data-rv-item]")).includes("Évalué sur l'état figé"), "frozen is stated");
});

// ================================================================ C. Ask integration
scenario("08 Ask → 'Ajouter au dossier de revue' stores the evidence AS SHOWN; a later page change makes the pack's observation 'changed', not the stored copy", async () => {
  const { srv, p } = await world();
  await openMore(p);
  await p.click("#btn-carnet-ask");
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  await p.fill("#hq-carnet-ask-q", "couple serrage palier");
  await p.click("#btn-carnet-ask-go");
  await p.waitForSelector("#btn-carnet-ask-review");
  await p.click("#btn-carnet-ask-review");
  await p.waitForSelector("#hq-carnet-rv-add", { state: "visible" });
  await p.fill("#hq-carnet-rv-new-title", "Revue Ask");
  await p.click("#btn-carnet-rv-create");
  await until(async () => rvFiles(srv).length === 1 && rvRead(srv, rvFiles(srv)[0]).items.length === 1, "the Ask result was added");
  const it = rvRead(srv, rvFiles(srv)[0]).items[0];
  check(it.kind === "ask_result" && /^[0-9a-f]{32}$/.test(it.seal.fingerprint) && it.copy.cards.length >= 1, "exact payload + fingerprint stored");
  srv.remote((pg) => { pg.content.blocks[1].text = "Le couple de serrage du palier avant est de 99 N·m"; });
  await openReviews(p);
  await openPack(p, "Revue Ask");
  await tab(p, "evidence");
  await until(async () => (await p.locator('[data-rv-item] [data-rv-obs="changed"]').count()) === 1, "Ask evidence is now 'changed'");
  check(JSON.stringify(rvRead(srv, rvFiles(srv)[0]).items[0].copy) === JSON.stringify(it.copy), "stored payload identical on disk");
  check((await txt(p, "[data-rv-item] .carnet-rv-copy")).includes("40 N"), "the reviewed passage is still displayed");
});

scenario("09 'Rechercher dans Ask Carnet' from an item and from a question opens Ask PREFILLED and runs nothing until the user presses the button", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = (await cpost(srv, ctx, { action: "review_question_add", id: pk.id, expected_rev: pk.rev, text: "palier avant serrage ?" })).body.review;
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"ask"')) posts.push(1); });
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "questions");
  await p.click('[data-rv="q-ask"]');
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  check(await p.inputValue("#hq-carnet-ask-q") === "palier avant serrage ?", "question prefilled");
  check(!(await dlgOpen(p)), "the review dialog closed");
  await sleep(400);
  check(posts.length === 0, "nothing was searched automatically");
});

scenario("10 explicit replacement: 'Remplacer' keeps the previous fingerprint in the item; nothing is replaced silently", async () => {
  const { srv, ctx, p } = await world();
  const ask1 = await cpost(srv, ctx, { action: "ask", question: "couple serrage palier", scope: { kind: "project", id: "proj-1" } });
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "ask_result", question: "couple serrage palier", scope: { kind: "project", id: "proj-1" }, limit: 10, fingerprint: ask1.body.fingerprint });
  srv.remote((pg) => { pg.content.blocks[1].text = "Le couple de serrage du palier avant est de 50 N·m"; });
  await openMore(p);
  await p.click("#btn-carnet-ask");
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  await p.fill("#hq-carnet-ask-q", "couple serrage palier");
  await p.click("#btn-carnet-ask-go");
  await p.waitForSelector("#btn-carnet-ask-review");
  await p.click("#btn-carnet-ask-review");
  await p.waitForSelector("#hq-carnet-rv-add");
  await until(async () => (await p.locator('[data-rv="pick"]').count()) === 1, "chooser lists the pack");
  await p.click('[data-rv="pick"]');
  await p.waitForSelector("#btn-carnet-rv-add-new");
  check(rvRead(srv, rvFiles(srv)[0]).items.length === 1, "choosing the pack changed nothing yet");
  await p.click('[data-rv="add-replace"]');
  await until(async () => rvRead(srv, rvFiles(srv)[0]).items[0].supersedes.length === 1, "replaced");
  const it = rvRead(srv, rvFiles(srv)[0]).items[0];
  check(it.supersedes[0].fingerprint === ask1.body.fingerprint && it.seal.fingerprint !== ask1.body.fingerprint, "the old fingerprint is kept in supersedes[]");
  check(rvRead(srv, rvFiles(srv)[0]).items.length === 1, "one item");
});

// ================================================================ D. Checklist / questions
scenario("11 checklist: ticking is the user's action; evidence disappearing leaves it ticked; the status never moves", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-b" });
  pk = (await cpost(srv, ctx, { action: "review_check_add", id: pk.id, expected_rev: pk.rev, text: "Lubrification vérifiée", refs: [pk.items[0].id] })).body.review;
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "checklist");
  check((await txt(p, "#hq-carnet-rv-checks")).includes("Non cochée"), "unticked in words");
  await p.click('[data-rv-check]');
  await until(async () => rvRead(srv, rvFiles(srv)[0]).checklist[0].checked === true, "ticked by the user");
  check(rvRead(srv, rvFiles(srv)[0]).status === "draft", "status unchanged by ticking");
  srv.remote((pg) => { pg.deleted_at = T0 + 6000; }, "page-b");
  await p.click("#btn-carnet-rv-back");
  await openPack(p, "Revue banc");
  await tab(p, "checklist");
  check((await txt(p, "#hq-carnet-rv-checks")).includes("Cochée"), "still ticked after the evidence vanished");
  await tab(p, "freshness");
  await until(async () => (await p.locator("#hq-carnet-rv-counts [data-rv-count='missing']").textContent()).includes(": 1"), "evidence missing");
  await tab(p, "overview");
  check(await p.inputValue("#hq-carnet-rv-status") === "draft", "status still draft");
});

scenario("12 questions: 'résolue' only when the user marks it; the note is the user's text; removing evidence leaves a visible dangling ref", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-b" });
  pk = (await cpost(srv, ctx, { action: "review_question_add", id: pk.id, expected_rev: pk.rev, text: "Quel lubrifiant ?", refs: [pk.items[0].id] })).body.review;
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "questions");
  check((await txt(p, "#hq-carnet-rv-questions")).includes("Ouverte"), "open in words");
  await p.fill('[id^="hq-carnet-rv-res-"]', "Graisse 2 confirmée par le BE");
  await p.click('[data-rv="q-toggle"]');
  await until(async () => rvRead(srv, rvFiles(srv)[0]).questions[0].state === "resolved", "marked resolved by the user");
  await until(async () => (await txt(p, "#hq-carnet-rv-questions")).includes("Marquée résolue par toi"), "wording says who resolved it");
  check(await p.inputValue('[id^="hq-carnet-rv-res-"]') === "Graisse 2 confirmée par le BE", "the unsaved note was kept across the re-render");
  await p.click('[data-rv="q-note"]');
  await until(async () => rvRead(srv, rvFiles(srv)[0]).questions[0].resolution_note === "Graisse 2 confirmée par le BE", "note saved");
  await tab(p, "evidence");
  await p.click('[data-rv="item-remove"]');
  await until(async () => rvRead(srv, rvFiles(srv)[0]).items.length === 0, "evidence removed");
  await tab(p, "questions");
  check(await p.locator('[data-rv-dangling="1"]').count() === 1, "a dangling reference stays visible");
  check(rvRead(srv, rvFiles(srv)[0]).questions[0].state === "resolved", "the resolved question was not touched");
});

// ================================================================ E. Concurrency
scenario("13 two clients: a stale write gets 409, the server version is reloaded, the user's unsaved text stays visible, nothing is merged or retried", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "checklist");
  await p.fill("#hq-carnet-rv-new-check", "mon point non enregistré");
  // another client edits first
  const other = await cpost(srv, ctx, { action: "review_update", id: pk.id, expected_rev: pk.rev, title: "Titre de l'autre client" });
  check(other.status === 200, "other client wrote rev 2");
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"action":"review_')) posts.push(r.postData()); }); // review_* actions only: the read-only rcomment_list thread read is a different store
  await p.click("#btn-carnet-rv-check-add");
  await until(async () => (await p.locator("#hq-carnet-rv-notice").count()) === 1, "conflict notice shown");
  check((await txt(p, "#hq-carnet-rv-notice")).includes("rien n'a été fusionné"), "says nothing was merged");
  check(await p.inputValue("#hq-carnet-rv-new-check") === "mon point non enregistré", "the user's text is still in the field");
  check((await txt(p, "#hq-carnet-rv-name")) === "Titre de l'autre client", "the server version is displayed");
  check(posts.length === 1, "exactly one write was attempted — no automatic retry: " + posts.length);
  check(rvRead(srv, rvFiles(srv)[0]).checklist.length === 0, "nothing was written");
});

scenario("14 delete: confirmation is bound to the revision it opened on — rev 3 → other client rev 4 → stale confirm 409, pack remains → reload → new confirm deletes", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx, "À supprimer");
  for (const t of ["a", "b"]) pk = (await cpost(srv, ctx, { action: "review_check_add", id: pk.id, expected_rev: pk.rev, text: t })).body.review;
  check(pk.rev === 3, "pack at rev 3");
  await openReviews(p);
  await openPack(p, "À supprimer");
  await p.click("#btn-carnet-rv-delete");
  await p.waitForSelector("#hq-carnet-rv-confirm");
  check((await txt(p, "#hq-carnet-rv-confirm")).includes("révision 3") && (await txt(p, "#hq-carnet-rv-confirm")).includes("définitive"), "confirmation names the revision and says permanent");
  const other = await cpost(srv, ctx, { action: "review_update", id: pk.id, expected_rev: 3, title: "À supprimer (modifié)" });
  check(other.status === 200 && other.body.review.rev === 4, "another client moved it to rev 4");
  await p.click("#btn-carnet-rv-delete-confirm");
  await until(async () => (await p.locator("#hq-carnet-rv-notice").count()) === 1, "409 → server version reloaded");
  check(rvFiles(srv).length === 1, "the pack remains");
  check(await p.locator("#hq-carnet-rv-confirm").count() === 0, "the stale confirmation was dropped");
  check((await txt(p, "#hq-carnet-rv-name")) === "À supprimer (modifié)", "reloaded rev 4 shown");
  await p.click("#btn-carnet-rv-delete");
  await p.waitForSelector("#hq-carnet-rv-confirm");
  check((await txt(p, "#hq-carnet-rv-confirm")).includes("révision 4"), "new confirmation at rev 4");
  await p.click("#btn-carnet-rv-delete-confirm");
  await until(async () => rvFiles(srv).length === 0, "deleted");
  await until(async () => (await p.locator("#hq-carnet-rv-none").count()) === 1, "back to the (empty) list");
});

scenario("15 offline: a loaded pack stays readable; every mutation control is aria-disabled and nothing is sent", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-b" });
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "checklist");
  await ctx.setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event("offline")));
  const posts = [];
  p.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await p.fill("#hq-carnet-rv-new-check", "hors ligne");
  await p.click("#btn-carnet-rv-check-add", { force: true });
  check((await p.locator("#btn-carnet-rv-check-add").getAttribute("aria-disabled")) === "true", "aria-disabled, not removed");
  check(posts.length === 0, "nothing sent offline");
  await tab(p, "evidence");
  check((await p.locator("[data-rv-item]").count()) === 1, "evidence still readable");
  await ctx.setOffline(false);
});

// ================================================================ F. Integrity
scenario("16 corrupt pack file: listed 'altéré', opens read-only, mutation refused, file preserved byte for byte", async () => {
  const { srv, ctx, p } = await world();
  const pk = await createViaApi(srv, ctx, "Revue abîmée");
  const file = path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.title = "Revue falsifiée";
  writeFileSync(file, JSON.stringify(data));
  const raw = readFileSync(file);
  await openReviews(p);
  check((await txt(p, "#hq-carnet-rv-list")).includes("Fichier altéré"), "listed as altered");
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-corrupt");
  check((await txt(p, "#hq-carnet-rv-corrupt")).includes("lecture seule"), "read-only banner");
  await p.click('[data-rv-tab="checklist"]');
  await p.fill("#hq-carnet-rv-new-check", "x");
  await p.click("#btn-carnet-rv-check-add", { force: true });
  check((await p.locator("#btn-carnet-rv-check-add").getAttribute("aria-disabled")) === "true", "mutation control disabled");
  const r = await cpost(srv, ctx, { action: "review_check_add", id: pk.id, expected_rev: pk.rev, text: "x" });
  check(r.status === 409 && r.body.code === "review_corrupt", "server refuses too: " + r.status);
  check(sha(readFileSync(file)) === sha(raw), "file preserved byte for byte");
});

// ================================================================ G. Export / report
scenario("17 export: a ZIP download (attachment, no-store), identical bytes twice, with review.json / review.md / manifest.json", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-b" });
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "report");
  const href = await p.getAttribute("#lnk-carnet-rv-export", "href");
  check(href === "/api/carnet/review-export/" + pk.id, "export link");
  const a = await ctx.request.get(srv.base + href);
  const b = await ctx.request.get(srv.base + href);
  check(a.status() === 200 && a.headers()["content-type"] === "application/zip", "zip content type");
  check(/^attachment; filename="carnet-review-rvw-[0-9a-f]{24}-r2\.zip"$/.test(a.headers()["content-disposition"]), "attachment: " + a.headers()["content-disposition"]);
  check(a.headers()["cache-control"] === "no-store" && a.headers()["x-content-type-options"] === "nosniff", "no-store + nosniff");
  const ba = await a.body();
  const bb = await b.body();
  check(sha(ba) === sha(bb), "two exports are byte-identical");
  const names = [...ba.toString("latin1").matchAll(/(manifest\.json|review\.json|review\.md)/g)].map((m) => m[1]);
  check(["manifest.json", "review.json", "review.md"].every((n) => names.includes(n)), "three members present");
  const anon = await (await browser.newContext()).request.get(srv.base + href);
  check(anon.status() === 401 || anon.status() === 403 || anon.status() === 302 || anon.status() === 303, "admin-only: " + anon.status());
});

scenario("18 report: 'Ajouter la revue au rapport' queues a review_pack item; the report keeps changed evidence marked, never refuses it", async () => {
  const { srv, ctx, p } = await world();
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-a" });
  srv.remote((pg) => { pg.content.blocks[1].text = "autre"; });
  await openReviews(p);
  await openPack(p, "Revue banc");
  await tab(p, "report");
  await p.click("#btn-carnet-rv-report");
  await until(async () => (await flashOf(p)).includes("Dossier de revue ajouté au rapport"), "queued");
  const r = await cpost(srv, ctx, { action: "report_build", items: [{ kind: "review_pack", review_id: pk.id }] });
  check(r.status === 200 && r.body.markdown.includes("Modifié depuis la sélection"), "report marks the change instead of refusing");
});

// ================================================================ H. Accessibility / layout
scenario("19 keyboard: Tab is trapped in the dialog, tabs are reachable, Escape inside the delete confirmation cancels only the confirmation", async () => {
  const { srv, ctx, p } = await world();
  await createViaApi(srv, ctx);
  await openReviews(p);
  await openPack(p, "Revue banc");
  for (let i = 0; i < 30; i += 1) {
    await p.keyboard.press("Tab");
    check(await p.evaluate(() => document.getElementById("hq-carnet-rv").contains(document.activeElement)), "focus stays in the dialog (" + i + ")");
  }
  await p.click("#btn-carnet-rv-delete");
  await p.waitForSelector("#hq-carnet-rv-confirm");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-rv-confirm").count() === 0 && (await dlgOpen(p)), "Escape cancelled only the confirmation");
  await p.keyboard.press("Escape");
  check(!(await dlgOpen(p)), "second Escape closes");
});

scenario("20 iPhone: targets ≥ 44 px, no horizontal overflow, the state is text, the dialog fits the viewport", async () => {
  const { srv, ctx, p } = await world("iphone");
  let pk = await createViaApi(srv, ctx);
  pk = await addViaApi(srv, ctx, pk, { kind: "page", page_id: "page-a" });
  pk = (await cpost(srv, ctx, { action: "review_check_add", id: pk.id, expected_rev: pk.rev, text: "Contrôler", refs: [pk.items[0].id] })).body.review;
  await openReviews(p);
  await openPack(p, "Revue banc");
  for (const key of ["overview", "evidence", "checklist", "questions", "freshness", "report"]) {
    await tab(p, key);
    const small = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-rv button, #hq-carnet-rv select, #hq-carnet-rv input[type=text], #hq-carnet-rv a.carnet-btn")].filter((n) => n.offsetParent).map((n) => ({ id: n.id || n.textContent.slice(0, 20), h: n.getBoundingClientRect().height })).filter((x) => x.h < 43.5));
    check(small.length === 0, key + ": all targets ≥ 44px " + JSON.stringify(small.slice(0, 3)));
    const over = await p.evaluate(() => { const d = document.getElementById("hq-carnet-rv"); return d.scrollWidth - d.clientWidth; });
    check(over <= 1, key + ": no horizontal overflow (" + over + ")");
    await shot(p, "20-iphone-" + key);
  }
});

scenario("22 lost create response: the server wrote the pack, the response never arrived, a retry of the SAME form re-sends the same request id and creates no second pack", async () => {
  const { srv, p } = await world();
  await openReviews(p);
  const ids = [];
  let dropped = false;
  await p.route("**/api/carnet", async (route) => {
    const req = route.request();
    let body = null;
    try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = null; }
    if (req.method() === "POST" && body && body.action === "review_create") {
      ids.push(body.request_id);
      if (!dropped) {
        dropped = true;
        await route.fetch();  // the server processes it and writes the pack…
        await route.abort("failed");  // …but the response is lost
        return;
      }
    }
    await route.continue();
  });
  await p.fill("#hq-carnet-rv-new-title", "Revue réseau");
  await p.click("#btn-carnet-rv-create");
  await until(async () => rvFiles(srv).length === 1, "the first attempt wrote the pack");
  check(!(await p.locator("#hq-carnet-rv-name").count()), "the UI did not learn the outcome: still on the create form");
  check((await p.inputValue("#hq-carnet-rv-new-title")) === "Revue réseau", "the form is kept");
  await p.click("#btn-carnet-rv-create");
  await p.waitForSelector("#hq-carnet-rv-name");
  check(ids.length === 2 && ids[0] === ids[1], "the retry re-sent the SAME request id");
  check(rvFiles(srv).length === 1, "still exactly one pack on disk");
  check(rvRead(srv, rvFiles(srv)[0]).request_id === ids[0], "the stored request id is the one retried");
  await p.unroute("**/api/carnet");
});

scenario("21 no external request, no model call: only local /api/carnet traffic", async () => {
  const { srv, ctx, p } = await world();
  await createViaApi(srv, ctx);
  await openReviews(p);
  await openPack(p, "Revue banc");
  for (const key of ["evidence", "freshness", "report"]) await tab(p, key);
  await sleep(300);
  check(external.length === 0, "no external request: " + external.slice(0, 2).join());
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
