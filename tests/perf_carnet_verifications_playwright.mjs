// Carnet product phase 11: verification tasks & evidence-backed signoff (a recorded human check; evidence is never touched, 'verified' only by explicit signoff).
//
//   node tests/visual_carnet_verifications_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side is tests/test_hq_carnet_verifications.py, the pure client contract is tests/check_hq_carnet_verifications.mjs.
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
const SHOTS = process.env.P11_PERF_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-verifications-"));
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

// ---------------------------------------------------------------- Phase 10 helpers
const ANN = "#hq-carnet-reader-ann";
const annDir = (srv) => path.join(srv.root, ".hq-carnet", "annotations");
const annFiles = (srv) => (existsSync(annDir(srv)) ? readdirSync(annDir(srv)).filter((n) => n.startsWith("ant-")).sort() : []);
// decoded (the store writes ASCII-escaped canonical JSON): compare real text, never escaped bytes
const annText = (srv) => annFiles(srv).map((n) => JSON.parse(readFileSync(path.join(annDir(srv), n), "utf8")).records.map((r) => r.body).join("\n")).join("\n");
const annRaw = (srv) => annFiles(srv).map((n) => readFileSync(path.join(annDir(srv), n), "utf8")).join("\n");
const rcDir = (srv) => path.join(srv.root, ".hq-carnet", "review-comments");
const rcFiles = (srv) => (existsSync(rcDir(srv)) ? readdirSync(rcDir(srv)).filter((n) => n.startsWith("rvw-")).sort() : []);
function digestExcept(srv, skip) {
  const h = createHash("sha256");
  const base = path.join(srv.root, ".hq-carnet");
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, n.name);
      const rel = path.relative(base, f);
      if (skip.includes(rel.split(path.sep)[0])) continue;
      h.update(rel);
      if (n.isDirectory()) walk(f);
      else h.update(readFileSync(f));
    }
  };
  walk(base);
  return h.digest("hex");
}
const annPosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && /"(annotation|rcomment)_/.test(r.postData() || "")) bag.push(JSON.parse(r.postData())); });
// Phase 13: the annotations panel is a quiet collapsed summary (count) until opened: wait for the summary, open it, then wait for the groups
const panelReady = async (p) => {
  await until(async () => (await p.locator(ANN + "-toggle").count()) > 0 && !(await p.locator(ANN + ' [data-ann-summary]').textContent()).includes("Chargement"), "annotations summary loaded");
  if ((await p.locator(ANN + "-toggle").getAttribute("aria-expanded")) === "false") await p.click(ANN + "-toggle");
  return until(async () => (await p.locator(ANN + " .carnet-ann-group").count()) > 0, "annotations panel loaded");
};
async function readerOnCitation(profile = "desktop", titleOpts) {
  const { srv, ctx, p } = await world(profile);
  const ed = await mkEd(srv, ctx, "Machinery");
  const c = cite(ed, { ok: true, pdf: 417, loc: { kind: "page", text: "412" } });
  srv.remote((pg) => { pg.content.blocks.push(citeBlock("block-c1", c)); });
  await reopen(p);
  await citationToReader(p, "block-c1");
  await panelReady(p);
  return { srv, ctx, p, ed, c };
}
function spawnSyncPy(buf) {
  const code = "import sys,zipfile,io\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(''.join(z.read(n).decode('utf-8','replace') for n in z.namelist()))";
  const r = spawnSync(process.env.PYTHON || "python3", ["-c", code], { input: buf, encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout || "";
}
const addAnn = async (p, text, opts = {}) => {
  if (opts.page) await p.check(ANN + "-page");
  if (opts.target) await p.check(`#hq-ann-target-${opts.target}`);
  await p.fill(ANN + "-new", text);
  await p.click(ANN + "-add");
  await until(async () => (await p.locator(`${ANN} [data-ann] .carnet-ann-body`).allTextContents()).includes(text), "annotation listed: " + text.slice(0, 30));
};
const apiList = async (srv, ctx, targets) => (await cpost(srv, ctx, { action: "annotation_list", targets })).body.results;
const srcTarget = (ed) => ({ kind: "source", source_id: ed.id });

// ---------------------------------------------------------------- scenarios
// the panel / thread sits below the fold of a long modal: screenshot the element itself, scrolled into view
const shotEl = async (p, sel, name) => { if (!SHOTS) return null; const l = p.locator(sel).first(); await l.scrollIntoViewIfNeeded(); return l.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ---------------------------------------------------------------- Phase 11 helpers
const VER = "#hq-carnet-ver";
const VP = "#hq-carnet-reader-ver";
const verDir = (srv) => path.join(srv.root, ".hq-carnet", "verifications");
const verFiles = (srv) => (existsSync(verDir(srv)) ? readdirSync(verDir(srv)).filter((n) => n.startsWith("ver-")).sort() : []);
const verRecs = (srv) => verFiles(srv).map((n) => JSON.parse(readFileSync(path.join(verDir(srv), n), "utf8")));
const verText = (srv) => verFiles(srv).map((n) => readFileSync(path.join(verDir(srv), n), "utf8")).join("\n");
const DLG = "#hq-carnet-rv";
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
const vcreate = async (srv, ctx, target, question = "Le palier avant est-il usiné en H7 ?", extra = {}) => {
  const r = await cpost(srv, ctx, Object.assign({ action: "verification_create", request_id: rid(), question, target }, extra));
  check(r.status === 200, "verification created via API: " + question.slice(0, 30));
  return r.body.verification;
};
const vact = async (srv, ctx, action, v, extra = {}) => cpost(srv, ctx, Object.assign({ action, id: v.id, expected_rev: v.rev }, extra));
const blockT = (srv, i = 1) => ({ kind: "block", page_id: "page-a", block_id: srv.pg("page-a").content.blocks[i].id });
const sourceT = (ed) => ({ kind: "source", source_id: ed.id });
const vposts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && /"verification_/.test(r.postData() || "")) bag.push(JSON.parse(r.postData())); });
const verPanelReady = (p) => until(async () => (await p.locator(VP + " [data-ver=summary]").count()) > 0 && !(await txt(p, VP + " [data-ver=summary]")).includes("Chargement"), "verifications panel loaded");
async function openWorkspace(p) {
  await openMore(p);
  await p.click("#btn-carnet-verifications");
  await p.waitForSelector(VER, { state: "visible" });
  await until(async () => (await p.locator(VER + " #hq-carnet-ver-rows").count()) === 1 && !(await txt(p, VER + " #hq-carnet-ver-rows")).includes("Chargement"), "workspace list loaded");
}
async function openDetail(p, id) {
  await p.click(`${VER} [data-ver-act="view"][data-id="${id}"]`);
  await p.waitForSelector(`${VER} [data-ver-detail="${id}"] #hq-carnet-ver-status`);
  await until(async () => (await p.locator(VER + " #hq-carnet-ver-b-current [data-ver=overall], " + VER + " #hq-carnet-ver-b-current .hint").count()) > 0, "detail resolved");
  await sleep(150);
}
const statusOf = (p) => txt(p, VER + " #hq-carnet-ver-status");
async function verWorld(profile = "desktop") {
  const w = await world(profile);
  const ed = await mkEd(w.srv, w.ctx, "Machinery");
  return Object.assign(w, { ed });
}
async function readerVerWorld(profile = "desktop") {
  const w = await readerOnCitation(profile);
  await verPanelReady(w.p);
  return w;
}
const spawnZip = spawnSyncPy;



const PERF = [];
const rec = (name, ms, extra = "") => { PERF.push([name, Math.round(ms), extra]); console.log(`  PERF ${name}: ${Math.round(ms)} ms ${extra}`); };
const tm = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
async function seed(srv, ctx, n, sign = false) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let v = await vcreate(srv, ctx, blockT(srv, i % 2), "Perf " + i + " ?");
    if (sign) {
      v = (await vact(srv, ctx, "verification_evidence_add", v, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
      v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
      v = (await vact(srv, ctx, "verification_signoff", v, { request_id: rid() })).body.verification;
    }
    out.push(v);
  }
  return out;
}

for (const n of [1, 25, 100]) {
  scenario(`P1 ${n} verification(s): list latency (API), workspace render, row count`, async () => {
    const { srv, ctx, p } = await verWorld();
    await seed(srv, ctx, n);
    const [lat] = await tm(() => cpost(srv, ctx, { action: "verification_list" }));
    rec(`list API (${n})`, lat);
    const [lat2] = await tm(() => cpost(srv, ctx, { action: "verification_list" }));
    rec(`list API warm (${n})`, lat2);
    await reopen(p);
    const [r] = await tm(async () => { await openWorkspace(p); });
    rec(`workspace open+render (${n} rows)`, r, `rows=${await p.locator(VER + " .carnet-ver-row").count()}`);
    check((await p.locator(VER + " .carnet-ver-row").count()) === n, "rows rendered: " + n);
  });
}

scenario("P2 one verification with 100 evidence refs: detail resolution is ONE request; render time", async () => {
  const { srv, ctx, p } = await verWorld();
  let v = await vcreate(srv, ctx, blockT(srv, 0));
  const blocks = srv.pg("page-a").content.blocks;
  // 100 distinct refs: pages' blocks via many pages is heavy; use blocks of one page + sources + pages
  const refs = [];
  for (const b of blocks) refs.push({ kind: "block", page_id: "page-a", block_id: b.id });
  refs.push({ kind: "page", page_id: "page-a" });
  let k = 0;
  while (refs.length < 100) { const e = await mkEd(srv, ctx, "Perf-src-" + (k++)); refs.push({ kind: "source", source_id: e.id }); }
  for (const ref of refs) {
    const r = await vact(srv, ctx, "verification_evidence_add", v, { ref });
    check(r.status === 200, "evidence add " + refs.indexOf(ref));
    v = r.body.verification;
  }
  check(v.evidence.length === 100, "100 evidence refs");
  const [lat] = await tm(() => cpost(srv, ctx, { action: "verification_resolve", id: v.id }));
  rec("resolve detail, 100 evidence (API)", lat);
  await reopen(p);
  await openWorkspace(p);
  const bag = [];
  vposts(p, bag);
  const [r] = await tm(async () => { await openDetail(p, v.id); });
  rec("detail open+resolve+render, 100 evidence", r, `requests=${bag.length}`);
  check(bag.filter((b) => b.action === "verification_resolve").length <= 1 && bag.length <= 2, "no request per evidence: " + bag.map((b) => b.action).join(","));
  const [ready, rr] = await tm(() => vact(srv, ctx, "verification_status", v, { status: "ready" }));
  rec("status → ready (100 evidence, API)", ready);
  const rdy = rr.body.verification;
  const [sg, sr] = await tm(() => vact(srv, ctx, "verification_signoff", rdy, { request_id: rid() }));
  rec("signoff capture, 100 evidence (API)", sg, `status=${sr.status}`);
  check(sr.status === 200, "signoff with 100 evidence succeeds");
});

scenario("P3 one verification with 25 signoffs: detail latency and history render", async () => {
  const { srv, ctx, p } = await verWorld();
  let v = await vcreate(srv, ctx, blockT(srv, 0));
  v = (await vact(srv, ctx, "verification_evidence_add", v, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  for (let i = 0; i < 25; i += 1) {
    v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
    const [ms, r] = await tm(() => vact(srv, ctx, "verification_signoff", v, { request_id: rid() }));
    if (i === 0 || i === 24) rec(`signoff #${i + 1} (API)`, ms);
    v = r.body.verification;
    v = (await vact(srv, ctx, "verification_status", v, { status: "open" })).body.verification;
  }
  check(v.signoffs.length === 25, "25 signoffs");
  const [lat] = await tm(() => cpost(srv, ctx, { action: "verification_get", id: v.id }));
  rec("get, 25 signoffs (API)", lat);
  await reopen(p);
  await openWorkspace(p);
  const [r] = await tm(async () => { await openDetail(p, v.id); });
  rec("detail open+render, 25 signoffs", r, `history=${await p.locator(VER + " [data-ver-signoff]").count()}`);
  check((await p.locator(VER + " [data-ver-signoff]").count()) === 25, "25 signoffs listed");
});

scenario("P4 Reader related-load: cold (first lookup, index empty) vs warm (cached headers), 100 verifications present", async () => {
  const { srv, ctx, p, ed } = await readerVerWorld();
  await seed(srv, ctx, 100);
  await vcreate(srv, ctx, sourceT(ed), "Liée à la source ?");
  const spec = { action: "verification_related", targets: [{ kind: "source", source_id: ed.id }] };
  const [cold] = await tm(() => cpost(srv, ctx, spec));
  rec("related first call after seeding (index warmed by the creates; NOT a true cold start)", cold);
  const [warm] = await tm(() => cpost(srv, ctx, spec));
  rec("related warm (API)", warm);
  await reopen(p);
  await citationToReader(p, "block-c1");
  const [ui] = await tm(async () => { await verPanelReady(p); });
  rec("Reader panel loaded (UI)", ui);
  check((await txt(p, VP + " [data-ver=summary]")).includes("1 ouverte"), "panel shows the one linked verification");
});

scenario("P5 signoff capture time vs evidence count (1, 10, 50)", async () => {
  const { srv, ctx } = await verWorld();
  for (const n of [1, 10, 50]) {
    let v = await vcreate(srv, ctx, blockT(srv, 0), "Capture " + n);
    for (let i = 0; i < n; i += 1) {
      const e = await mkEd(srv, ctx, "Cap-" + n + "-" + i);
      v = (await vact(srv, ctx, "verification_evidence_add", v, { ref: { kind: "source", source_id: e.id } })).body.verification;
    }
    v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
    const [ms, r] = await tm(() => vact(srv, ctx, "verification_signoff", v, { request_id: rid() }));
    rec(`signoff capture, ${n} evidence (API)`, ms);
    check(r.status === 200, "signoff ok " + n);
  }
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
      console.log("  FAIL ", e.message.split("\n").slice(0, 12).join(" | "));
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
