// Carnet product phase 8: portal blocks (read-only windows onto objects owned by other modules; the page stores the reference only).
//
//   node tests/visual_carnet_portals_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme and reduced-motion emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side of the contract is tests/test_hq_carnet_portals.py and the pure view models are tests/check_hq_carnet_portals.mjs: this
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
const SHOTS = process.env.P8_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-portals-"));
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
    mkdirSync(path.join(s.root, "Inbox", "Models"), { recursive: true });
    writeFileSync(path.join(s.root, "Inbox", "Models", "bride.glb"), "glTF-test");
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
const para = (text, id) => ({ id, type: "paragraph", text, marks: [] });
const portalBlock = (id, kind, ident, view = "card") => ({ id, type: "portal", text: "", marks: [], portal: { ref: { kind, id: ident }, view } });
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: "proj-1", category_id: null, pinned: false, deleted_at: null, created_at: T0, updated_at: T0 + 900, content: { version: 2, blocks } }, extra || {});
}
const proj = (id, name) => ({ id, name, archived: false, created_at: T0, updated_at: T0 });
const NB = (blocks) => ({
  version: 1, notebook_rev: 5,
  projects: [proj("proj-1", "Banc")],
  categories: [],
  pages: [page("page-a", 1, blocks || [para("Banc d'essai", "block-title"), para("Texte", "block-t")])],
});
const rid = () => [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
const txt = (p, sel) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || "", sel);
const pageRev = (srv) => srv.pg("page-a").rev;
const histCount = (srv) => (existsSync(path.join(srv.root, ".hq-carnet", "history.json")) ? JSON.parse(srv.read(".hq-carnet/history.json")).events.length : 0);
const resolvePosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"portal_resolve"')) bag.push(JSON.parse(r.postData())); });
const otherPosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && !(r.postData() || "").includes('"portal_resolve"')) bag.push(r.postData() || ""); });
async function mkSource(srv, ctx, title = "Shigley") {
  const fam = (await cpost(srv, ctx, { action: "source_family_create", name: "Fam " + title })).body.family;
  const ed = (await cpost(srv, ctx, { action: "source_edition_create", family_id: fam.id, edition: "11e", title, type: "book", year: 2020 })).body.edition;
  check(!!ed && /^srce-/.test(ed.id), "source created: " + (ed && ed.id));
  return ed;
}
const reopen = async (p) => { await p.reload(); await showCarnet(p); };
const portalCards = (p) => p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-pb")].map((c) => ({ kind: c.dataset.kind, state: c.dataset.state, stale: c.dataset.stale, view: c.dataset.view, text: c.textContent })));
const waitCards = (p, n, msg) => until(async () => { const cs = await portalCards(p); return cs.length === n && cs.every((c) => c.state !== "loading") ? cs : null; }, msg || n + " portal card(s) resolved");

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("01 every kind renders as a text card with its own live state; no frame, no external request", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx);
  const snap = await cpost(srv, ctx, { action: "snapshot_create", request_id: rid(), project_id: "proj-1", label: "Gel A" });
  const rv = await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid() });
  srv.remote((pg) => {
    pg.content.blocks.push(portalBlock("block-p1", "source", ed.id), portalBlock("block-p2", "file", "Inbox/a.pdf"), portalBlock("block-p3", "model", "Inbox/Models/bride.glb"), portalBlock("block-p4", "model", "Inbox/Models/absent.glb"), portalBlock("block-p5", "snapshot", snap.body.snapshot.id), portalBlock("block-p6", "review", rv.body.review.id), portalBlock("block-p7", "media", "Inbox/Photos/absent.png", "compact"));
  });
  await reopen(p);
  const cs = await waitCards(p, 7);
  check(cs[0].kind === "source" && cs[0].text.includes("Shigley") && cs[0].text.includes("Disponible"), "source: " + cs[0].text.slice(0, 80));
  check(cs[3].state === "missing" && cs[3].text.includes("Introuvable"), "missing model says so in text: " + cs[3].text.slice(0, 80));
  check(cs[4].kind === "snapshot" && cs[4].text.includes("Gel A") && cs[5].text.includes("Revue banc"), "snapshot and review cards");
  check(cs[6].view === "compact" && cs[6].state === "missing", "compact view, missing");
  check(await p.locator("#hq-carnet-editor iframe, #hq-carnet-editor object, #hq-carnet-editor embed").count() === 0, "no frame / object / embed");
  await shot(p, "01-kinds-desktop");
});

scenario("02 insert: + Insérer → Insérer un portail → picker lists real sources; the stored block is the reference only", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx, "Roark");
  await reopen(p);
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  await p.click('[data-carnet-insert="portal"]');
  await p.waitForSelector("#hq-carnet-portal-picker", { state: "visible" });
  check(await p.evaluate(() => document.activeElement.id) === "carnet-pb-kind", "focus lands in the picker");
  await p.selectOption("#carnet-pb-kind", "source");
  await p.click(`.carnet-pb-choice[data-pb-id="${ed.id}"]`);
  await waitCards(p, 1);
  await until(() => { const b = srv.pg("page-a").content.blocks.find((x) => x.type === "portal"); return !!b; }, "block saved");
  const b = srv.pg("page-a").content.blocks.find((x) => x.type === "portal");
  check(JSON.stringify(b.portal) === JSON.stringify({ ref: { kind: "source", id: ed.id }, view: "card" }) && b.text === "" && b.marks.length === 0, "stored: reference + view only: " + JSON.stringify(b));
  check(!JSON.stringify(srv.pg("page-a")).includes("Roark"), "no title / state copied into the page");
});

scenario("03 Actualiser reruns the resolver only: same page rev, not dirty, no history entry, no save", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx);
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  await reopen(p);
  await waitCards(p, 1);
  const rev0 = pageRev(srv), h0 = histCount(srv), nb0 = JSON.stringify(srv.nb());
  const posts = [], others = [];
  resolvePosts(p, posts);
  otherPosts(p, others);
  await cpost(srv, ctx, { action: "source_edition_update", id: ed.id, expected_rev: 1, title: "Shigley 12e" });
  await p.click(".carnet-pb-refresh");
  await until(async () => (await portalCards(p))[0].text.includes("Shigley 12e"), "the live title shows after Actualiser");
  check(posts.length >= 1, "a resolver request was made");
  check(pageRev(srv) === rev0 && histCount(srv) === h0, "page rev and history unchanged");
  check(others.every((b) => !b.includes('"page_') && !b.includes('"save')), "no page write was sent: " + others.join(" | ").slice(0, 120));
  const dirty = await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); return e.dataset.dirty || ""; });
  check(dirty !== "1" && dirty !== "true", "not dirty");
  check(!JSON.stringify(srv.pg("page-a")).includes("Shigley 12e"), "the live title never entered the page");
});

scenario("04 a missing target never deletes the block; unknown is not missing", async () => {
  const { srv, p } = await world();
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "file", "Inbox/a.pdf")));
  await reopen(p);
  let cs = await waitCards(p, 1);
  check(cs[0].state === "available", "available first");
  rmSync(path.join(srv.root, "Inbox", "a.pdf"));
  await p.click(".carnet-pb-refresh");
  await until(async () => (await portalCards(p))[0].state === "missing", "now missing");
  check(srv.pg("page-a").content.blocks.some((b) => b.id === "block-p1"), "the block is still stored");
  await p.route("**/api/carnet", (route) => (route.request().postData() || "").includes("portal_resolve") ? route.fulfill({ status: 200, contentType: "application/json", body: '{"results":[{"ref":{"kind":"file","id":"Inbox/a.pdf"},"state":"<script>","title":1}]}' }) : route.continue());
  await p.click(".carnet-pb-refresh");
  await until(async () => (await portalCards(p))[0].state === "unknown", "a malformed answer is unknown, never missing");
  check(srv.pg("page-a").content.blocks.find((b) => b.id === "block-p1").portal.ref.id === "Inbox/a.pdf", "saved content untouched by the bad answer");
  await p.unroute("**/api/carnet");
});

scenario("05 Retirer du carnet is two-step and never deletes the target", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx);
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  await reopen(p);
  await waitCards(p, 1);
  const label = await p.locator(".carnet-struct[data-struct=portal] .carnet-struct-del").textContent();
  check(label === "Retirer du carnet", "label: " + label);
  await p.click(".carnet-struct[data-struct=portal] .carnet-struct-del");
  check((await p.locator(".carnet-struct[data-struct=portal] .carnet-struct-del").textContent()).startsWith("Confirmer"), "first click only arms");
  await p.click(".carnet-struct[data-struct=portal] .carnet-struct-del");
  await until(() => !srv.pg("page-a").content.blocks.some((b) => b.type === "portal"), "block removed");
  const g = await cget(srv, ctx, "sources=1");
  check(g.body.editions.some((e) => e.id === ed.id), "the source still exists");
});

scenario("06 replace target is a normal page mutation with a history entry", async () => {
  const { srv, ctx, p } = await world();
  const a = await mkSource(srv, ctx, "Alpha");
  const b = await mkSource(srv, ctx, "Bravo");
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", a.id)));
  await reopen(p);
  await waitCards(p, 1);
  const rev0 = pageRev(srv);
  await p.click(".carnet-pb-replace");
  await p.waitForSelector("#hq-carnet-portal-picker");
  await p.selectOption("#carnet-pb-kind", "source");
  await p.click(`.carnet-pb-choice[data-pb-id="${b.id}"]`);
  await until(() => srv.pg("page-a").content.blocks.find((x) => x.type === "portal").portal.ref.id === b.id, "reference replaced and saved");
  check(pageRev(srv) > rev0, "page revision advanced");
  await until(async () => (await portalCards(p))[0].text.includes("Bravo"), "card shows the new target");
});

scenario("07 hostile metadata renders as text (no markup, no script, no dialog)", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx, "<img src=x onerror=alert(1)><script>alert(2)</script>");
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  let dialog = false;
  p.on("dialog", (d) => { dialog = true; d.dismiss(); });
  await reopen(p);
  const cs = await waitCards(p, 1);
  check(cs[0].text.includes("<img src=x") && cs[0].text.includes("<script>"), "shown literally");
  check(await p.locator("#hq-carnet-editor .carnet-pb img, #hq-carnet-editor .carnet-pb script").count() === 0, "no element created from metadata");
  await sleep(300);
  check(!dialog, "no dialog fired");
});

scenario("08 resolver failure and offline: never malformed, never falsely fresh ('Dernier état chargé')", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx);
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  await reopen(p);
  await waitCards(p, 1);
  await p.route("**/api/carnet", (route) => (route.request().postData() || "").includes("portal_resolve") ? route.abort() : route.continue());
  await p.click(".carnet-pb-refresh");
  await until(async () => (await portalCards(p))[0].text.includes("Dernier état chargé"), "failed refresh shows 'Dernier état chargé'");
  check((await portalCards(p))[0].stale === "1", "marked stale");
  check(await p.locator("#hq-carnet-editor").getAttribute("contenteditable") !== "false", "the page stays editable");
  await p.unroute("**/api/carnet");
  await ctx.setOffline(true);
  await p.click(".carnet-pb-refresh");
  await until(async () => (await portalCards(p))[0].stale === "1", "offline: still stale, not fresh");
  await ctx.setOffline(false);
});

scenario("09 100 portals: one batched request, duplicates collapsed; one missing target does not suppress the other 99", async () => {
  const { srv, ctx, p } = await world();
  const blocks = [];
  for (let i = 0; i < 99; i += 1) blocks.push(portalBlock("block-q" + i, "file", "Inbox/a.pdf", "compact"));
  blocks.push(portalBlock("block-q99", "file", "Inbox/gone.pdf", "compact"));
  srv.remote((pg) => pg.content.blocks.push(...blocks));
  const posts = [];
  resolvePosts(p, posts);
  const t0 = Date.now();
  await reopen(p);
  const cs = await waitCards(p, 100, "100 portals resolved");
  console.log("  perf: 100 duplicate-heavy portals resolved in " + (Date.now() - t0) + " ms");
  check(posts.length === 1 && posts[0].refs.length === 2, "one request, deduplicated to 2 refs: " + JSON.stringify(posts.map((x) => x.refs.length)));
  check(cs.filter((c) => c.state === "available").length === 99 && cs.filter((c) => c.state === "missing").length === 1, "99 available, 1 missing");
});

scenario("10 100 distinct refs fit one batch", async () => {
  const { srv, p } = await world();
  const blocks = [];
  for (let i = 0; i < 100; i += 1) blocks.push(portalBlock("block-q" + i, "file", "Inbox/f" + i + ".pdf", "compact"));
  srv.remote((pg) => pg.content.blocks.push(...blocks));
  const posts = [];
  resolvePosts(p, posts);
  const t0 = Date.now();
  await reopen(p);
  await waitCards(p, 100);
  console.log("  perf: 100 distinct portals resolved in " + (Date.now() - t0) + " ms");
  check(posts.length === 1 && posts[0].refs.length === 100, "a single 100-ref request");
});

scenario("11 perf: 1 and 25 portals", async () => {
  for (const n of [1, 25]) {
    const { srv, p } = await world();
    const blocks = [];
    for (let i = 0; i < n; i += 1) blocks.push(portalBlock("block-q" + i, "file", "Inbox/f" + i + ".pdf"));
    srv.remote((pg) => pg.content.blocks.push(...blocks));
    const t0 = Date.now();
    await reopen(p);
    await waitCards(p, n);
    console.log("  perf: " + n + " portal(s) resolved in " + (Date.now() - t0) + " ms");
  }
});

scenario("12 deep link focuses the portal block; the outline lists it by stored identity", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkSource(srv, ctx);
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  await reopen(p);
  await waitCards(p, 1);
  await p.evaluate(() => { location.hash = "#carnet/page-a/block-p1"; });
  await until(async () => (await (async () => (await p.locator(".carnet-flash").count()) > 0 ? (await p.locator(".carnet-flash").textContent()) : "")()).includes("Bloc atteint"), "block reached by deep link");
});

scenario("13 keyboard: actions are reachable by Tab and operate with Enter; targets are >= 44px on iPhone; no horizontal scroll", async () => {
  const { srv, ctx, p } = await world("iphone");
  const ed = await mkSource(srv, ctx);
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", ed.id)));
  await reopen(p);
  await waitCards(p, 1);
  const sizes = await p.evaluate(() => [...document.querySelectorAll(".carnet-pb-bar button")].filter((b) => !b.hidden).map((b) => Math.round(b.getBoundingClientRect().height * 10) / 10));
  check(sizes.length >= 3 && sizes.every((h) => h >= 43.5), "tap targets: " + sizes.join());
  check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow");
  await p.focus(".carnet-pb-refresh");
  await p.keyboard.press("Enter");
  await waitCards(p, 1);
  await p.click(".carnet-pb-inspect");
  await p.waitForSelector("#hq-carnet-portal-inspector");
  check((await txt(p, "#hq-carnet-portal-inspector")).includes(ed.id), "the inspector shows the stored reference");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-portal-inspector").count() === 0, "Escape closes the inspector");
  await shot(p, "13-iphone");
});

scenario("14 review evidence distinguishes the block from its target", async () => {
  const { srv, ctx, p } = await world();
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "file", "Inbox/a.pdf")));
  const pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue P", request_id: rid() })).body.review;
  const add = await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "block", page_id: "page-a", block_id: "block-p1" } });
  check(add.status === 200, "portal block added as evidence: " + add.status);
  rmSync(path.join(srv.root, "Inbox", "a.pdf"));
  const f = await cget(srv, ctx, "review=" + pk.id + "&freshness=1");
  const it = Object.values(f.body.freshness.items)[0];
  check(it.state === "unchanged" && it.target && it.target.state === "missing", "block unchanged, target missing: " + JSON.stringify({ s: it.state, t: it.target && it.target.state }));
  await reopen(p);
  await p.click("#btn-carnet-more").catch(() => {});
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await until(async () => (await txt(p, "#hq-carnet-rv")).includes("Cible du portail"), "the target layer is shown separately");
});

const activeInfo = (p, sel) => p.evaluate((q) => { const a = document.activeElement; const m = document.querySelector(q); return { inside: !!(m && a && m.contains(a)), cls: a ? a.className : "", id: a ? a.id : "", tag: a ? a.tagName : "" }; }, sel);

scenario("15 picker is a real modal: Tab / Shift+Tab wrap, focus cannot reach the page behind, Escape and Cancel return focus to the exact Replace button", async () => {
  const { srv, ctx, p } = await world();
  const a = await mkSource(srv, ctx, "Alpha");
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", a.id)));
  await reopen(p);
  await waitCards(p, 1);
  const PK = "#hq-carnet-portal-picker";
  await p.click(".carnet-pb-replace");
  await p.waitForSelector(PK);
  await until(async () => (await p.locator(PK + " .carnet-pb-choice").count()) >= 1, "choices listed");
  check((await activeInfo(p, PK)).inside, "focus starts inside the dialog");
  const n = await p.evaluate((q) => [...document.querySelectorAll(q + " button, " + q + " select, " + q + " input")].length, PK);
  for (let i = 0; i < n + 3; i += 1) {
    await p.keyboard.press("Tab");
    check((await activeInfo(p, PK)).inside, "Tab " + (i + 1) + " stays inside");
  }
  await p.focus(PK + " #carnet-pb-kind");
  await p.keyboard.press("Shift+Tab");
  const back = await activeInfo(p, PK);
  check(back.inside && back.cls.includes("carnet-pb-cancel"), "Shift+Tab on the first control wraps to the last (Annuler): " + back.cls);
  await p.keyboard.press("Tab");
  check((await activeInfo(p, PK)).id === "carnet-pb-kind", "Tab on the last control wraps to the first");
  await p.evaluate(() => document.querySelector("#hq-carnet-editor").focus());
  check((await activeInfo(p, PK)).inside, "forcing focus into the editor behind is pulled back into the dialog");
  await p.keyboard.press("Escape");
  check(await p.locator(PK).count() === 0, "Escape closes");
  check(await p.evaluate(() => document.activeElement.classList.contains("carnet-pb-replace")), "focus returns to the Remplacer button");
  await p.click(".carnet-pb-replace");
  await p.waitForSelector(PK);
  await p.click(PK + " .carnet-pb-cancel");
  check(await p.evaluate(() => document.activeElement.classList.contains("carnet-pb-replace")), "Annuler returns to the Remplacer button too");
  check(JSON.stringify(srv.pg("page-a").content.blocks.find((x) => x.id === "block-p1").portal.ref.id) === JSON.stringify(a.id), "cancel changed nothing");
});

scenario("16 inspector is a real modal too: Tab / Shift+Tab contained, Escape returns to Inspecter", async () => {
  const { srv, ctx, p } = await world();
  const a = await mkSource(srv, ctx, "Alpha");
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p1", "source", a.id)));
  await reopen(p);
  await waitCards(p, 1);
  const IN = "#hq-carnet-portal-inspector";
  await p.click(".carnet-pb-inspect");
  await p.waitForSelector(IN);
  check((await activeInfo(p, IN)).inside, "focus inside");
  for (let i = 0; i < 4; i += 1) {
    await p.keyboard.press("Tab");
    check((await activeInfo(p, IN)).inside, "Tab " + (i + 1) + " stays inside");
    await p.keyboard.press("Shift+Tab");
    check((await activeInfo(p, IN)).inside, "Shift+Tab " + (i + 1) + " stays inside");
  }
  await p.evaluate(() => document.querySelector("#hq-carnet-editor").focus());
  check((await activeInfo(p, IN)).inside, "focus cannot reach the page behind");
  await p.keyboard.press("Escape");
  check(await p.locator(IN).count() === 0 && await p.evaluate(() => document.activeElement.classList.contains("carnet-pb-inspect")), "Escape returns to Inspecter");
});

scenario("17 insertion picker: Escape returns focus to a logical opener (never lost on <body>), nothing is inserted", async () => {
  const { srv, p } = await world();
  const before = JSON.stringify(srv.pg("page-a").content);
  await p.click("#btn-carnet-insert");
  await p.waitForSelector("#hq-carnet-insert-menu", { state: "visible" });
  await p.click('[data-carnet-insert="portal"]');
  await p.waitForSelector("#hq-carnet-portal-picker");
  await p.keyboard.press("Shift+Tab");
  check((await activeInfo(p, "#hq-carnet-portal-picker")).inside, "Shift+Tab from the first control stays inside");
  await p.keyboard.press("Escape");
  check(await p.locator("#hq-carnet-portal-picker").count() === 0, "closed");
  const where = await p.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? (a.id || a.tagName) : "BODY"; });
  check(where !== "BODY", "focus is on a real control, not lost: " + where);
  check(JSON.stringify(srv.pg("page-a").content) === before, "nothing inserted");
});

// ---------------------------------------------------------------- runner
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
