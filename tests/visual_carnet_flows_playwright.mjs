// Phase 13 end-to-end FLOW suite + acceptance pins (Chromium emulation only; WebKit/Firefox/physical devices UNVERIFIED).
//   P13_SHOTS=dir node tests/visual_carnet_flows_playwright.mjs [scenario substring...]
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

// ---------------------------------------------------------------- Phase 13 flows + acceptance pins
PROFILES.iphone430 = { viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };
const visibleDialogs = async (p) => (await probe(p)).dialogs;
const one = async (p, id, msg) => {
  const d = await visibleDialogs(p);
  check(d.length === 1 && d[0].id === id, `${msg}: exactly one active modal (${d.map((x) => x.id).join(",") || "none"})`);
};
const focusIs = (p, sel) => p.evaluate((q) => document.activeElement === document.querySelector(q), sel);
const overflowOf = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: Math.min(innerWidth, screen.width), bw: document.body.scrollWidth })); // isMobile emulation grows innerWidth to fit overflowing content, so compare with the device width
const noOverflow = async (p, msg) => {
  const o = await overflowOf(p);
  check(o.sw <= o.iw && o.bw <= o.iw, `${msg}: zero horizontal document overflow (${o.sw}/${o.bw} <= ${o.iw})`);
};
const badLabels = (p) => p.evaluate(() => {
  const vis = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const out = [];
  const BAD = /^(Supprimer|Retirer|Effacer|Écarter|Erreur)\.?$/;
  for (const n of document.querySelectorAll("button, [role=alert], [role=status], h2, h3, strong, .carnet-chip")) {
    if (!vis(n)) continue;
    const t = (n.getAttribute("aria-label") || n.textContent || "").trim();
    if (BAD.test(t)) out.push(n.tagName + ":" + t);
  }
  return out;
});
const evidenceWord = (p, sel) => p.evaluate((q) => /évidence/i.test((document.querySelector(q) || {}).textContent || ""), sel);

scenario("FLOW 1 desktop: page -> citation -> Reader -> verification workspace -> back, one modal at a time", async () => {
  const { srv, ctx, p, ver } = await seed("desktop");
  await p.click('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
  await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
  await one(p, "hq-carnet-sources-layer", "Sources");
  await p.click("#btn-carnet-src-reader");
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  await one(p, "hq-carnet-reader", "Reader over Sources");
  check((await p.locator("#hq-carnet-sources-layer[data-carnet-suspended]").count()) === 1, "Sources is suspended, not stacked");
  check(!(await evidenceWord(p, "#hq-carnet-reader")), "no 'évidence' wording in the Reader");
  check((await badLabels(p)).length === 0, "no bare Supprimer/Retirer/Erreur label in the Reader: " + (await badLabels(p)).join("|"));
  await shot(p, "d-F1-reader");
  await p.click(VP + "-toggle");
  await p.click(VP + "-workspace");
  await p.waitForSelector(VER, { state: "visible" });
  await sleep(300);
  await one(p, "hq-carnet-ver", "Verification workspace over Reader");
  check((await p.locator("#hq-carnet-reader[data-carnet-suspended]").count()) === 1, "Reader is suspended under the workspace");
  await p.keyboard.press("Escape");
  await sleep(250);
  check((await p.locator(VER).count()) === 0, "child Escape closed the workspace");
  check((await p.locator("#hq-carnet-reader").count()) === 1, "child Escape did NOT close the parent Reader");
  await one(p, "hq-carnet-reader", "after first Escape");
  check(await focusIs(p, VP + "-workspace"), "focus is back on the exact workspace opener");
  await p.keyboard.press("Escape");
  await sleep(250);
  check((await p.locator("#hq-carnet-reader").count()) === 0, "second Escape closes the Reader");
  await one(p, "hq-carnet-sources-layer", "Sources resumed");
  await p.keyboard.press("Escape");
  await sleep(250);
  check((await visibleDialogs(p)).length === 0, "third Escape closes Sources");
  check(await p.evaluate(() => !!document.activeElement.closest('[data-carnet-citation]')), "focus returned to the citation");
});

scenario("FLOW 1b desktop: Reader opened from the verification and reasoning workspaces; state restored after", async () => {
  const { srv, ctx, p, ver, dec } = await seed("desktop");
  // verification workspace
  await openMore(p);
  await p.click("#btn-carnet-verifications");
  await p.waitForSelector(VER, { state: "visible" });
  await sleep(400);
  await p.click(`${VER} [data-ver-act="view"][data-id="${ver.id}"]`);
  await sleep(500);
  await p.evaluate((s) => { const n = document.querySelector(s); n.scrollTop = 60; }, VER);
  const snapV = await p.evaluate((s) => ({ t: document.querySelector(s).innerText, y: document.querySelector(s).scrollTop }), VER);
  await p.click(`${VER} [data-ver-act="reader"]`);
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  await one(p, "hq-carnet-reader", "Reader from verification workspace");
  check(await focusIs(p, "#hq-carnet-reader") || await p.evaluate(() => !!document.activeElement.closest("#hq-carnet-reader")), "focus is inside the visible Reader");
  await shot(p, "d-F1b-ver-then-reader");
  await p.keyboard.press("Escape");
  await sleep(300);
  await one(p, "hq-carnet-ver", "workspace restored");
  const afterV = await p.evaluate((s) => ({ t: document.querySelector(s).innerText, y: document.querySelector(s).scrollTop }), VER);
  check(afterV.t === snapV.t, "the selected object / detail is unchanged");
  check(afterV.y === snapV.y, "workspace scroll restored: " + snapV.y);
  check(await p.evaluate(() => document.activeElement.matches('[data-ver-act="reader"]')), "focus is back on the exact Lire button");
  await p.keyboard.press("Escape");
  await sleep(250);
  // reasoning workspace
  await openWorkspace(p);
  await openDetail(p, dec.id);
  const snapR = await p.evaluate((s) => document.querySelector(s).innerText, RSN);
  await p.click(`${RSN} [data-rsn-act="reader"]`);
  await p.waitForSelector("#hq-carnet-reader");
  await sleep(600);
  await one(p, "hq-carnet-reader", "Reader from reasoning workspace");
  await p.keyboard.press("Escape");
  await sleep(300);
  await one(p, "hq-carnet-rsn", "register restored");
  check((await p.evaluate((s) => document.querySelector(s).innerText, RSN)) === snapR, "register detail unchanged after the Reader");
  check(await p.evaluate(() => document.activeElement.matches('[data-rsn-act="reader"]')), "focus is back on the exact Lire button (register)");
});

scenario("FLOW 2 desktop: Review Pack item -> Reader -> exact item; Ask from the pack has a logical opener", async () => {
  const { srv, ctx, p, pk } = await seed("desktop");
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await sleep(300);
  await p.click('[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  await one(p, "hq-carnet-reader", "Reader over Review Pack");
  check(/figée/i.test(await rtxt(p)), "the Reader says the proof is frozen (Preuve figée)");
  await shot(p, "d-F2-reader-from-review");
  await p.keyboard.press("Escape");
  await sleep(300);
  await one(p, "hq-carnet-rv", "Review Pack resumed");
  check(await p.evaluate(() => document.activeElement.matches('[data-rv="open-reader"]')), "focus is on the exact originating item button");
  await p.click('[data-rv-tab="questions"]');
  await sleep(250);
  check((await badLabels(p)).length === 0, "no bare destructive label in the Review Pack: " + (await badLabels(p)).join("|"));
  await p.click('[data-rv="q-ask"]');
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  await sleep(300);
  await one(p, "hq-carnet-ask", "Ask over Review Pack");
  await p.keyboard.press("Escape");
  await sleep(300);
  check((await visibleDialogs(p)).length === 0, "Ask replaces the pack (existing behaviour), nothing is left stacked");
  check(await focusIs(p, "#btn-carnet-reviews"), "Ask returned focus to a non-null logical opener: the Revues tool that opened the pack");
});

scenario("FLOW 3 desktop: Reader -> assumption/decision panel -> workspace -> back", async () => {
  const { srv, ctx, p, dec } = await seed("desktop");
  await openReaderFromCitation(p);
  await p.click(RP + "-toggle");
  await sleep(300);
  check((await txt(p, RP)).length > 0 && !/évidence/i.test(await txt(p, RP)), "the register panel is readable and uses 'preuve'");
  await p.click(RP + "-workspace");
  await p.waitForSelector(RSN, { state: "visible" });
  await sleep(400);
  await one(p, "hq-carnet-rsn", "register over Reader");
  await shot(p, "d-F3-register-over-reader");
  await p.keyboard.press("Escape");
  await sleep(250);
  await one(p, "hq-carnet-reader", "Reader after the register");
  check(await focusIs(p, RP + "-workspace"), "focus is back on the register opener");
  check((await badLabels(p)).length === 0, "no bare destructive label");
});

scenario("FLOW 4 desktop: frozen proof -> current difference -> related verification -> back", async () => {
  const { srv, ctx, p, ed, ver } = await seed("desktop");
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.click('[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  const t = await rtxt(p);
  check(/Preuve figée/.test(t), "frozen proof is named 'Preuve figée'");
  check(!/évidence/i.test(t), "no 'évidence'");
  check((await p.locator("#hq-carnet-reader-meta").count()) === 1, "the metadata comparison is a collapsible summary");
  check((await p.locator(VP + "-toggle").count()) === 1, "the related-verifications panel is reachable");
  await p.click(VP + "-toggle");
  await sleep(300);
  await shot(p, "d-F4-frozen-with-panel");
  await p.keyboard.press("Escape");
  await sleep(250);
  await one(p, "hq-carnet-rv", "pack after the Reader");
});

scenario("PIN secondary panels: collapsed summaries with counts; one dominates on phone, none forced on desktop", async () => {
  const d = await seed("desktop");
  await openReaderFromCitation(d.p);
  await until(async () => !/Chargement/.test(await txt(d.p, "[data-ann-summary]")), "annotations summary resolved");
  const summ = await txt(d.p, "[data-ann-summary]");
  check(/\d|Aucune/.test(summ), "annotations summary carries a count: " + summ.trim());
  for (const sel of ["#hq-carnet-reader-ann-toggle", VP + "-toggle", RP + "-toggle"]) await d.p.click(sel);
  const open = await d.p.evaluate(() => [...document.querySelectorAll("[data-reader-panel]")].filter((b) => b.getAttribute("aria-expanded") === "true").length);
  check(open === 3, "desktop: no accordion exclusivity (" + open + " open)");
  const m = await seed("iphone");
  await openReaderFromCitation(m.p);
  for (const sel of ["#hq-carnet-reader-ann-toggle", VP + "-toggle", RP + "-toggle"]) { await m.p.click(sel); await sleep(120); }
  const mo = await m.p.evaluate(() => [...document.querySelectorAll("[data-reader-panel]")].filter((b) => b.getAttribute("aria-expanded") === "true").length);
  check(mo === 1, "phone: only one secondary panel open at a time (" + mo + ")");
});

scenario("PIN modal stack: a suspended modal closed while not on top is reusable (synthetic + real History surface)", async () => {
  const { p } = await seed("desktop");
  const synth = await p.evaluate(() => {
    const M = window.HqCarnetModal, d = document;
    const mk = (id) => { const n = d.createElement("div"); n.id = id; n.innerHTML = '<button id="' + id + '-b">x</button>'; d.body.appendChild(n); return n; };
    const A = mk("t-a"), B = mk("t-b");
    const ha = M.open(d, A, { keep: true, layer: "sheet" });
    const hb = M.open(d, B, { keep: false, layer: "nested" });
    const suspended = A.hasAttribute("data-carnet-suspended") && A.inert;
    ha.close(false); // A is NOT on top
    hb.close(false);
    const ha2 = M.open(d, A, { keep: true, layer: "sheet" });
    const r = { suspended, visibleAttrs: A.hasAttribute("data-carnet-suspended"), ariaHidden: A.hasAttribute("aria-hidden"), inert: A.inert || A.hasAttribute("inert"), focusIn: A.contains(d.activeElement), depth: M.depth(d) };
    ha2.close(false); A.remove();
    return r;
  });
  check(synth.suspended, "A was suspended under B");
  check(!synth.visibleAttrs && !synth.ariaHidden && !synth.inert, "reopened A carries no suspension attributes");
  check(synth.focusIn && synth.depth === 1, "focus enters the reopened A");
  // real surface: History (keep:true)
  await openMore(p);
  await p.click("#btn-carnet-history");
  await p.waitForSelector("#hq-carnet-hx", { state: "visible" });
  const real = await p.evaluate(() => {
    const M = window.HqCarnetModal, d = document;
    const hist = d.querySelector("#hq-carnet-hx");
    const B = d.createElement("div"); B.innerHTML = '<button>y</button>'; d.body.appendChild(B);
    const hb = M.open(d, B, { keep: false, layer: "nested" });
    const was = hist.hasAttribute("data-carnet-suspended") && hist.inert;
    d.querySelector("#btn-carnet-hx-close").click(); // History closes through ITS OWN close path while a child is on top
    hb.close(false);
    return { was, still: hist.hasAttribute("data-carnet-suspended") || hist.inert || hist.hasAttribute("aria-hidden") };
  });
  check(real.was && !real.still, "History (real surface) is suspended under a child and clean after its own close");
  await sleep(200);
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
  await p.click("#btn-carnet-history");
  const again = await p.evaluate(() => { const n = document.querySelector("#hq-carnet-hx"); const r = n.getBoundingClientRect(); return { vis: getComputedStyle(n).visibility, w: r.width, inert: n.inert, ah: n.getAttribute("aria-hidden"), focusIn: n.contains(document.activeElement) }; });
  check(again.vis !== "hidden" && again.w > 0 && !again.inert && again.ah === null && again.focusIn, "History reopens visible, active and focused: " + JSON.stringify(again));
});

scenario("REC toolbar height (run on the baseline too)", async () => {
  for (const prof of ["desktop", "iphone"]) {
    const { p } = await seed(prof);
    await openMore(p);
    rec(`toolbar.height.${prof}`, await p.evaluate(() => Math.round(document.querySelector("#carnet-quick-tools").getBoundingClientRect().height)));
  }
});

scenario("PIN toolbar: grouped per the audit, every capability reachable, keyboard order deterministic, phone not taller", async () => {
  const { p } = await seed("desktop");
  await openMore(p);
  const grp = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll("#carnet-quick-tools [role=group]")].map((g) => [g.getAttribute("aria-label"), [...g.querySelectorAll("button")].filter((b) => !b.hasAttribute("data-carnet-symbol")).map((b) => b.id || "trash")])));
  check(Object.keys(grp).join(",") === "Insérer,Page,Modules", "three labelled groups: " + Object.keys(grp));
  check(grp["Insérer"].join(",") === "btn-carnet-time,btn-carnet-format,btn-carnet-cite,btn-carnet-image,btn-carnet-eng,btn-carnet-templates", "Insérer = symbols, Heure, Aa, Référence, Image, Ingénierie, Modèles");
  check(grp["Page"].join(",") === "btn-carnet-find,btn-carnet-export,btn-carnet-history,trash", "Page = Rechercher, Exporter, Historique, Corbeille");
  check(grp["Modules"].join(",") === "btn-carnet-intel,btn-carnet-ask,btn-carnet-reviews,btn-carnet-verifications,btn-carnet-reasoning", "Modules = Cockpit, Preuves, Revues, Vérifications, Registre");
  const ids = await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools button")].map((b) => b.id || b.getAttribute("data-carnet-symbol") || b.className));
  const must = ["btn-carnet-time", "btn-carnet-format", "btn-carnet-find", "btn-carnet-cite", "btn-carnet-image", "btn-carnet-eng", "btn-carnet-templates", "btn-carnet-export", "btn-carnet-history", "btn-carnet-intel", "btn-carnet-ask", "btn-carnet-reviews", "btn-carnet-verifications", "btn-carnet-reasoning"];
  check(must.every((m) => ids.includes(m)) && ids.some((i) => /trash/.test(i)) && ids.filter((i) => i.length === 1 || /^[^\w]/.test(i)).length >= 11, "every capability stays reachable from the toolbar (symbols, 14 tools, trash)");
  await p.focus("#carnet-quick-tools button");
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const cur = await p.evaluate(() => { const a = document.activeElement; return a && a.closest("#carnet-quick-tools") ? (a.id || a.getAttribute("data-carnet-symbol") || a.className) : null; });
    if (cur === null) break;
    seen.push(cur);
    await p.keyboard.press("Tab");
  }
  check(seen.join("|") === ids.join("|"), "Tab visits every action once, in DOM order (" + seen.length + " stops, no extra scroller stop)");
  const nm = await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools button[aria-label]")].filter((b) => { const v = (b.textContent || "").trim(); return v && !/^[\p{S}\p{P}]/u.test(v) && v.length > 1 && !(b.getAttribute("aria-label") || "").toLowerCase().includes(v.toLowerCase()) && !v.includes("Heure"); }).map((b) => b.id));
  check(nm.length === 0, "aria-labels contain their visible text: " + nm.join("|"));
  await shot(p, "d-toolbar-after");
  const m = await seed("iphone");
  await openMore(m.p);
  const h = await m.p.evaluate(() => Math.round(document.querySelector("#carnet-quick-tools").getBoundingClientRect().height));
  const base = Number(process.env.P13_BASE_PHONE_TOOLBAR_H || 0);
  rec("toolbar.height.iphone.pin", h);
  if (base) check(h <= base, `phone toolbar is not taller than Phase 12 (${h} <= ${base})`);
  check(await m.p.evaluate(() => { const s = document.querySelector(".carnet-sym-strip"); return !!s && getComputedStyle(s).overflowX === "auto"; }), "phone: symbols are one scrollable line");
  await noOverflow(m.p, "phone toolbar");
});

for (const prof of ["iphone", "iphone430"]) {
  scenario(`FLOW 5 phone ${prof}: every surface fits, one modal, no overflow`, async () => {
    const { srv, ctx, p, ver, dec } = await seed(prof);
    await noOverflow(p, "carnet");
    await openMore(p);
    await noOverflow(p, "toolbar open");
    await shot(p, `${prof}-toolbar-after`);
    await p.click('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
    await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
    await noOverflow(p, "Sources");
    await p.click("#btn-carnet-src-reader");
    await p.waitForSelector("#hq-carnet-reader");
    await painted(p);
    await noOverflow(p, "Reader");
    await one(p, "hq-carnet-reader", "Reader (phone)");
    await shot(p, `${prof}-reader-after`);
    await p.click(VP + "-toggle");
    await p.click(VP + "-workspace");
    await p.waitForSelector(VER, { state: "visible" });
    await sleep(300);
    await noOverflow(p, "verification workspace");
    await one(p, "hq-carnet-ver", "workspace over Reader (phone)");
    await shot(p, `${prof}-ver-after`);
    await closeAll(p);
    await openMore(p);
    await p.click("#btn-carnet-reviews");
    await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
    await sleep(300);
    await noOverflow(p, "Review Pack");
    await p.click('[data-rv="open"]');
    await p.waitForSelector("#hq-carnet-rv-name");
    await p.click('[data-rv-tab="evidence"]');
    await sleep(300);
    await noOverflow(p, "Review Pack evidence");
    await p.click('[data-rv="open-reader"]');
    await p.waitForSelector("#hq-carnet-reader");
    await painted(p);
    await one(p, "hq-carnet-reader", "Reader from pack (phone)");
    await p.keyboard.press("Escape");
    await sleep(300);
    check(await p.evaluate(() => document.activeElement.matches('[data-rv="open-reader"]')), "phone: return lands on the exact item");
    await closeAll(p);
    await openWorkspace(p);
    await openDetail(p, dec.id);
    await noOverflow(p, "register detail");
    await shot(p, `${prof}-register-after`);
    const tiny = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-rsn button, #hq-carnet-rsn input, #hq-carnet-rsn select")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43; }).map((b) => (b.id || b.textContent || b.tagName).trim().slice(0, 24)));
    rec(`${prof}.register.smallTargets`, tiny);
    check(tiny.length === 0, "register controls are >= 44px tall: " + tiny.join("|"));
  });
}

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
  if (external.length) failures.push(["external requests", new Error("external: " + external.slice(0, 3).join(","))]);
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s)`);
  for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
  if (errors.length) { console.log("BROWSER ERRORS:\n" + errors.slice(0, 10).join("\n")); failures.push(["browser errors", new Error(errors[0])]); }
  console.log("\nWebKit / Firefox / physical devices: UNVERIFIED (Chromium emulation only).");
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
