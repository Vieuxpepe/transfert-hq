// Phase 13 pre-edit probe: runs on the untouched Phase 12 tip. Captures BEFORE screenshots and records click/focus/scroll baselines (JSON), no assertions about new behaviour.
//   P13_SHOTS=dir P13_OUT=file.json node tests/phase13_probe.mjs
//   node tests/visual_carnet_reasoning_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side is tests/test_hq_carnet_reasoning.py, the pure client contract is tests/check_hq_carnet_reasoning.mjs.
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
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
const SHOTS = process.env.P13_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-reasoning-"));
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
const PDF = "%PDF-1.4\n%%EOF\n";
const PDF_B = "%PDF-1.4\n%other bytes\n%%EOF\n";
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
const flashOf = (p) => p.evaluate(() => (document.querySelector(".carnet-flash") || {}).textContent || "");
const reopen = async (p) => { await p.reload(); await showCarnet(p); };
const activeInfo = (p, sel) => p.evaluate((q) => { const a = document.activeElement; const m = document.querySelector(q); return { inside: !!(m && a && m.contains(a)), cls: a ? a.className : "", id: a ? a.id : "", tag: a ? a.tagName : "", cite: !!(a && a.hasAttribute && a.hasAttribute("data-carnet-citation")) }; }, sel);

function treeDigest(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, n.name);
      h.update(path.relative(dir, f));
      if (n.isDirectory()) walk(f);
      else h.update(readFileSync(f));
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest("hex");
}
const carnetDigest = (srv) => treeDigest(path.join(srv.root, ".hq-carnet"));

async function mkEd(srv, ctx, title = "Machinery", opts = {}) {
  const name = opts.name || "b" + Math.random().toString(16).slice(2, 8) + ".pdf";
  const fam = (await cpost(srv, ctx, { action: "source_family_create", name: "Fam " + title + " " + name })).body.family;
  const payload = { action: "source_edition_create", family_id: fam.id, edition: "3e", title, type: "book", year: 2012, author: "Oberg" };
  if (opts.file !== false) {
    writeFileSync(path.join(srv.root, "Uni", name), opts.data || PDF);
    payload.file_ref = "Uni/" + name;
  }
  const ed = (await cpost(srv, ctx, payload)).body.edition;
  check(!!ed && /^srce-/.test(ed.id), "source created: " + (ed && ed.id));
  ed._name = name;
  return ed;
}
const cite = (ed, o = {}) => ({
  src: typeof ed === "string" ? ed : ed.id,
  loc: o.loc === undefined ? { kind: "clause", text: "304.1.2" } : o.loc,
  pdf: o.pdf === undefined ? null : o.pdf,
  ok: !!o.ok,
  snap: Object.assign({ title: ed.title || "Source", edition: ed.edition || "3e" }, o.snap || {}),
  from: o.from || null,
});
function citeBlock(id, c, before = "Voir ", after = " ici") {
  const label = "[" + c.snap.title + ", " + (c.loc && c.loc.text ? "art. " + c.loc.text : "p. PDF " + c.pdf) + "]";
  return { id, type: "paragraph", text: before + label + after, marks: [{ type: "citation", start: before.length, end: before.length + label.length, cite: c }] };
}
const R = "#hq-carnet-reader";
const SL = "#hq-carnet-sources-layer";
const rtxt = (p, sel = "") => txt(p, R + (sel ? " " + sel : ""));
const painted = (p) => until(async () => (await p.locator(R + " #hq-carnet-reader-body").getAttribute("aria-busy")) === "false", "reader painted");
async function citationToReader(p, blockId, opener = "#btn-carnet-src-reader") {
  await p.click(`[data-carnet-block-id="${blockId}"] [data-carnet-citation]`);
  await p.waitForSelector(SL, { state: "visible" });
  await p.waitForSelector(opener);
  await p.click(opener);
  await p.waitForSelector(R);
  await painted(p);
}
const readerPosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && (r.postData() || "").includes('"reader_resolve"')) bag.push(JSON.parse(r.postData())); });
const otherPosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && !(r.postData() || "").includes('"reader_resolve"')) bag.push(r.postData() || ""); });
const pdfGets = (p, bag) => p.on("request", (r) => { if (r.method() === "GET" && /\/files\/Uni\/.*\.pdf/.test(r.url())) bag.push(r.url()); });
async function withCites(srv, ctx, specs, extraBlocks = []) {
  // specs: [{ed, o, id}] -> citation blocks appended to page-a (another "device" edit), then the browser reloads
  srv.remote((pg) => { for (const s of specs) pg.content.blocks.push(citeBlock(s.id, cite(s.ed, s.o))); pg.content.blocks.push(...extraBlocks); });
}
const iframeSrc = (p) => p.evaluate(() => { const f = document.querySelector("#hq-carnet-reader-frame"); return f ? f.getAttribute("src") : null; });

// ---------------------------------------------------------------- Phase 12 helpers
const RSN = "#hq-carnet-rsn";
const RP = "#hq-carnet-reader-rsn";
const rsnDir = (srv) => path.join(srv.root, ".hq-carnet", "reasoning");
const rsnFiles = (srv) => (existsSync(rsnDir(srv)) ? readdirSync(rsnDir(srv)).filter((n) => /^(dec|asm)-/.test(n)).sort() : []);
const rsnRecs = (srv) => rsnFiles(srv).map((n) => JSON.parse(readFileSync(path.join(rsnDir(srv), n), "utf8")));
const rsnText = (srv) => rsnFiles(srv).map((n) => readFileSync(path.join(rsnDir(srv), n), "utf8")).join("\n");
const DLG = "#hq-carnet-rv";
const DEC = "reasoning_decision";
const ASM = "reasoning_assumption";
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
const rcreate = async (srv, ctx, kind, statement, extra = {}) => {
  const r = await cpost(srv, ctx, Object.assign({ action: "reasoning_create", request_id: rid(), kind, project_id: "proj-1", statement, rationale: "" }, extra));
  check(r.status === 200, "record created via API: " + statement.slice(0, 30));
  return r.body.record;
};
const ract = async (srv, ctx, action, r, extra = {}) => cpost(srv, ctx, Object.assign({ action, id: r.id, expected_rev: r.rev }, extra));
const rget = async (srv, ctx, r) => (await cpost(srv, ctx, { action: "reasoning_get", id: r.id })).body.record;
const blockT = (srv, i = 1) => ({ kind: "block", page_id: "page-a", block_id: srv.pg("page-a").content.blocks[i].id });
const sourceT = (ed) => ({ kind: "source", source_id: ed.id });
const rposts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && /"reasoning_/.test(r.postData() || "")) bag.push(JSON.parse(r.postData())); });
const rsnPanelReady = (p) => until(async () => (await p.locator(RP + " [data-rsn=summary]").count()) > 0 && !(await txt(p, RP + " [data-rsn=summary]")).includes("Chargement"), "register panel loaded");
async function openWorkspace(p) {
  await openMore(p);
  await p.click("#btn-carnet-reasoning");
  await p.waitForSelector(RSN, { state: "visible" });
  await until(async () => (await p.locator(RSN + " #hq-carnet-rsn-rows").count()) === 1 && !(await txt(p, RSN + " #hq-carnet-rsn-rows")).includes("Chargement"), "workspace list loaded");
}
async function openDetail(p, id) {
  await p.click(`${RSN} [data-rsn-act="view"][data-id="${id}"]`);
  await p.waitForSelector(`${RSN} [data-rsn-detail="${id}"] #hq-carnet-rsn-status`);
  await until(async () => (await p.locator(RSN + " #hq-carnet-rsn-b-current [data-rsn=overall], " + RSN + " #hq-carnet-rsn-b-current .hint").count()) > 1 || (await p.locator(RSN + " #hq-carnet-rsn-b-current [data-rsn=live-label]").count()) > 0, "detail resolved");
  await sleep(150);
}
const statusOf = (p) => txt(p, RSN + " #hq-carnet-rsn-status");
async function rsnWorld(profile = "desktop") {
  const w = await world(profile);
  const ed = await mkEd(w.srv, w.ctx, "Machinery");
  return Object.assign(w, { ed });
}
async function readerRsnWorld(profile = "desktop") {
  const w = await readerOnCitation(profile);
  await rsnPanelReady(w.p);
  return w;
}


// ---------------------------------------------------------------- probe helpers
const ANN = "#hq-carnet-reader-ann";
const VER = "#hq-carnet-ver";
const VP = "#hq-carnet-reader-ver";
const OUT = {};
const outFile = process.env.P13_OUT || "";
const rec = (k, v) => { OUT[k] = v; console.log("  REC ", k, JSON.stringify(v).slice(0, 400)); };
const shotEl = async (p, sel, name) => { if (!SHOTS) return null; const l = p.locator(sel).first(); await l.scrollIntoViewIfNeeded().catch(() => {}); return l.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);
const vcreate = async (srv, ctx, target, question, extra = {}) => {
  const r = await cpost(srv, ctx, Object.assign({ action: "verification_create", request_id: rid(), question, target }, extra));
  check(r.status === 200, "verification created: " + question.slice(0, 30));
  return r.body.verification;
};
const vact = (srv, ctx, action, v, extra = {}) => cpost(srv, ctx, Object.assign({ action, id: v.id, expected_rev: v.rev }, extra));
// what is really on top, who has focus, how many dialogs claim to be modal and are painted
const probe = (p) => p.evaluate(() => {
  const vis = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(vis).map((n) => ({ id: n.id, z: getComputedStyle(n).zIndex, modal: n.getAttribute("aria-modal") }));
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const top = document.elementFromPoint(cx, cy);
  const topDlg = top ? top.closest('[role="dialog"],[aria-modal="true"]') : null;
  const a = document.activeElement;
  const actDlg = a ? a.closest('[role="dialog"],[aria-modal="true"]') : null;
  return { dialogs, topAtCenter: topDlg ? topDlg.id : (top ? top.tagName : null), focusIn: actDlg ? actDlg.id : (a ? a.tagName + "#" + a.id : null), focusLabel: a ? (a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 40) : null, docOverflow: document.documentElement.scrollWidth - innerWidth };
});
const closeAll = async (p) => { for (let i = 0; i < 6; i++) { const n = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter((x) => x.getBoundingClientRect().width > 0 && getComputedStyle(x).visibility !== 'hidden').length); if (!n) return; await p.keyboard.press("Escape"); await sleep(250); if (i >= 2) { await p.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter((x) => x.getBoundingClientRect().width > 0).pop(); const b = d && [...d.querySelectorAll("button")].find((x) => /^Fermer/.test(x.getAttribute("aria-label") || x.textContent || "")); if (b) b.click(); }); await sleep(250); } } };
const PL = { desktop: "d", iphone: "p" };
async function seed(profile) {
  const srv = await server(NB([para("Banc d'essai", "block-title"), para("Texte", "block-t")]));
  const ctx = await context(srv, profile);
  const p = await openPage(ctx, srv);
  const ed = await mkEd(srv, ctx, "Machinery");
  const c = cite(ed, { ok: true, pdf: 417, loc: { kind: "page", text: "412" } });
  srv.remote((pg) => { pg.content.blocks.push(citeBlock("block-c1", c)); pg.content.blocks.push(portalBlock("block-po1", "source", ed.id)); });
  const dec = (await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: "reasoning_decision", project_id: "proj-1", statement: "Retenir le palier à billes", rationale: "Charge axiale", evidence: [{ kind: "source", source_id: ed.id }] })).body.record;
  const asm = (await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: "reasoning_assumption", project_id: "proj-1", statement: "Température ambiante < 40 °C", rationale: "", evidence: [{ kind: "page", page_id: "page-a" }] })).body.record;
  const ver = await vcreate(srv, ctx, { kind: "source", source_id: ed.id }, "La source est-elle la bonne édition ?");
  let v2 = await vcreate(srv, ctx, { kind: "block", page_id: "page-a", block_id: "block-t" }, "Texte relu ?");
  v2 = (await vact(srv, ctx, "verification_evidence_add", v2, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  v2 = (await vact(srv, ctx, "verification_status", v2, { status: "ready" })).body.verification;
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_question_add", id: pk.id, expected_rev: pk.rev, text: "Quel palier avant serrage ?" })).body.review;
  await reopen(p);
  return { srv, ctx, p, ed, dec, asm, ver, v2, pk };
}
const openReaderFromCitation = async (p) => {
  await p.click('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
  await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
  await p.click("#btn-carnet-src-reader");
  await p.waitForSelector("#hq-carnet-reader");
  await until(async () => (await p.locator("#hq-carnet-reader #hq-carnet-reader-body").getAttribute("aria-busy")) === "false", "reader painted");
};

for (const prof of ["desktop", "iphone"]) {
  const k = PL[prof];
  scenario(`BEFORE ${prof}: surfaces`, async () => {
    const { srv, ctx, p, ed, dec, ver, pk } = await seed(prof);
    rec(`${k}.carnet.overflow`, await probe(p));
    await shot(p, `${k}-01-carnet`);
    await openMore(p);
    await shot(p, `${k}-02-carnet-tools-row`);
    rec(`${k}.toolbar.buttons`, await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools button")].length));
    // portal card + inspector
    await p.locator('[data-carnet-block-id="block-po1"]').scrollIntoViewIfNeeded();
    await shot(p, `${k}-03-portal-card`);
    // sources dialog
    await p.click('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
    await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
    await sleep(300);
    await shot(p, `${k}-04-sources-dialog`);
    rec(`${k}.sources`, await probe(p));
    await p.click("#btn-carnet-src-reader");
    await p.waitForSelector("#hq-carnet-reader");
    await until(async () => (await p.locator("#hq-carnet-reader #hq-carnet-reader-body").getAttribute("aria-busy")) === "false", "reader painted");
    await sleep(500);
    await shot(p, `${k}-05-reader`);
    rec(`${k}.reader`, await probe(p));
    rec(`${k}.reader.buttons`, await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-reader button, #hq-carnet-reader a.carnet-small")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 40))));
    await p.click("#hq-carnet-reader-ann-toggle").catch(() => {});
    await p.click(VP + "-toggle").catch(() => {});
    await p.click("#hq-carnet-reader-rsn-toggle").catch(() => {});
    await sleep(300);
    await shot(p, `${k}-06-reader-panels-open`);
    await closeAll(p);
    // review pack
    await openMore(p);
    await p.click("#btn-carnet-reviews");
    await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
    await sleep(300);
    await shot(p, `${k}-07-review-list`);
    await p.click('[data-rv="open"]');
    await p.waitForSelector("#hq-carnet-rv-name");
    await p.click('[data-rv-tab="evidence"]');
    await sleep(400);
    await shot(p, `${k}-08-review-pack-evidence`);
    await p.click('[data-rv="open-reader"]');
    await p.waitForSelector("#hq-carnet-reader");
    await until(async () => (await p.locator("#hq-carnet-reader #hq-carnet-reader-body").getAttribute("aria-busy")) === "false", "reader painted");
    await sleep(500);
    await shot(p, `${k}-09-reader-frozen-from-review`);
    await closeAll(p);
    // verification workspace
    await openMore(p);
    await p.click("#btn-carnet-verifications");
    await p.waitForSelector(VER, { state: "visible" });
    await sleep(500);
    await shot(p, `${k}-10-verification-list`);
    await p.click(`${VER} [data-ver-act="view"][data-id="${ver.id}"]`).catch(() => {});
    await sleep(600);
    await shot(p, `${k}-11-verification-detail`);
    await closeAll(p);
    // reasoning
    await openWorkspace(p);
    await sleep(300);
    await shot(p, `${k}-12-register-list`);
    await openDetail(p, dec.id);
    await shot(p, `${k}-13-register-detail`);
    // corrupt state
    await closeAll(p);
    const f = path.join(srv.root, ".hq-carnet", "reasoning", dec.id + ".json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.seal = "0".repeat(64);
    writeFileSync(f, JSON.stringify(j));
    await reopen(p);
    await openWorkspace(p);
    await sleep(300);
    await shot(p, `${k}-14-register-corrupt-row`);
    await p.keyboard.press("Escape");
  });
}

// ---- P1 + flow baselines (desktop)
scenario("BASELINE P1: Reader opened from a verification workspace", async () => {
  const { srv, ctx, p, ed, ver } = await seed("desktop");
  await openMore(p);
  await p.click("#btn-carnet-verifications");
  await p.waitForSelector(VER, { state: "visible" });
  await sleep(400);
  await p.click(`${VER} [data-ver-act="view"][data-id="${ver.id}"]`);
  await sleep(500);
  const before = await probe(p);
  await p.click(`${VER} [data-ver-act="reader"]`);
  await sleep(1200);
  const after = await probe(p);
  rec("P1.ver.beforeOpen", before);
  rec("P1.ver.afterReaderClick", after);
  rec("P1.ver.readerExists", await p.locator("#hq-carnet-reader").count());
  await shot(p, "d-P1-ver-then-reader");
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("P1.ver.afterEscape1", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("P1.ver.afterEscape2", await probe(p));
});

scenario("BASELINE P1: Reader opened from the reasoning workspace", async () => {
  const { srv, ctx, p, dec } = await seed("desktop");
  await openWorkspace(p);
  await openDetail(p, dec.id);
  const before = await probe(p);
  await p.click(`${RSN} [data-rsn-act="reader"]`);
  await sleep(1200);
  rec("P1.rsn.beforeOpen", before);
  rec("P1.rsn.afterReaderClick", await probe(p));
  rec("P1.rsn.readerExists", await p.locator("#hq-carnet-reader").count());
  await shot(p, "d-P1-rsn-then-reader");
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("P1.rsn.afterEscape1", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("P1.rsn.afterEscape2", await probe(p));
});

scenario("BASELINE nesting: Reader -> workspace, Review Pack -> Reader -> Escape, Ask from reviews, Sources -> Reader", async () => {
  const { srv, ctx, p, ed, pk } = await seed("desktop");
  // Reader -> verification workspace
  await openReaderFromCitation(p);
  await p.click(VP + "-toggle").catch(() => {});
  await sleep(300);
  await p.click(VP + "-workspace");
  await p.waitForSelector(VER, { state: "visible" });
  await sleep(500);
  rec("N.reader-to-ver", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.reader-to-ver.esc1", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.reader-to-ver.esc2", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  // Review Pack -> Reader -> Escape -> focus
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.click('[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader");
  await sleep(800);
  rec("N.review-to-reader", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.review-to-reader.esc1", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.review-to-reader.esc2", await probe(p));
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.review-to-reader.esc3", await probe(p));
  // Sources -> Reader -> Escape: where does focus land?
  await p.click('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
  await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
  await p.click("#btn-carnet-src-reader");
  await p.waitForSelector("#hq-carnet-reader");
  await sleep(800);
  await p.keyboard.press("Escape");
  await sleep(300);
  rec("N.sources-to-reader.esc1", await probe(p));
  rec("N.sources-to-reader.sourcesLayerVisible", await p.locator("#hq-carnet-sources-layer").isVisible().catch(() => false));
});

scenario("BASELINE local capture discard (no confirmation today?)", async () => {
  // recorded statically in the audit (field-ui:1478/1796); this only records the label set of the pending-capture UI when reachable
  rec("capture.note", "static: stash.del path has no confirm in field-ui; browser path needs a stashed capture, verified in the Phase 13 flow suite");
});

// ---------------------------------------------------------------- runner
async function main() {
  try { browser = await chromium.launch(); } catch (e) { console.log("SKIP: Chromium unavailable"); process.exit(0); }
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const [name, fn] of scenarios) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    console.log("\n# " + name);
    try { await fn(); } catch (e) { failures.push([name, e]); console.log("  FAIL ", e.message.split("\n").slice(0, 12).join(" | ")); }
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
  await browser.close();
  for (const s of started) s.close();
  if (outFile) writeFileSync(outFile, JSON.stringify(OUT, null, 2));
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s)`);
  for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
  if (errors.length) console.log("BROWSER ERRORS:\n" + errors.slice(0, 10).join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
