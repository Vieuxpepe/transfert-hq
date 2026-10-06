// Carnet product phase 12 — PERFORMANCE measurements for the decisions & assumptions register (Chromium, throwaway loopback HQ). Prints PERF lines; asserts only generous ceilings and request counts (N+1).
//
//   node tests/perf_carnet_reasoning_playwright.mjs [scenario substring...]
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
const SHOTS = process.env.P12_PERF_SHOTS || "";
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

// ---------------------------------------------------------------- performance scenarios
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const timed = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
const apiMs = async (srv, ctx, payload, n = 5) => { const xs = []; for (let i = 0; i < n; i++) xs.push((await timed(() => cpost(srv, ctx, payload)))[0]); return med(xs); };
const PERF = (label, text) => console.log("PERF " + label + " " + text);
const manyBlocks = (n) => Array.from({ length: n }, (_, i) => para("Paragraphe " + i, "block-p" + i));
async function seedRecords(srv, ctx, n, kind = DEC) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: i % 2 ? ASM : kind, project_id: "proj-1", statement: "Enregistrement de mesure " + i, rationale: "Justification " + i })).body.record);
  return out;
}

scenario("P1 list latency and workspace render with 1 / 25 / 100 records; the workspace opens with ONE request", async () => {
  for (const n of [1, 25, 100]) {
    const { srv, ctx, p } = await world("desktop");
    await seedRecords(srv, ctx, n);
    const list = await apiMs(srv, ctx, { action: "reasoning_list" });
    await reopen(p);
    const bag = [];
    rposts(p, bag);
    const [render] = await timed(() => openWorkspace(p));
    const rows = await p.locator(RSN + " [data-rsn-row]").count();
    PERF("list n=" + n, `api_median=${list.toFixed(1)} ms; workspace open→rows ${render.toFixed(0)} ms; rows=${rows}; requests=${bag.length}`);
    check(rows === Math.min(n, 100) && bag.length === 1, `n=${n}: rows rendered, one request (no N+1)`);
    check(list < 2000, "list under the generous ceiling");
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
});

scenario("P2 one record with 100 evidence refs: detail resolve is ONE request; render time", async () => {
  const { srv, ctx, p } = await world("desktop", NB(manyBlocks(100)));
  const r = await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: DEC, project_id: "proj-1", statement: "Beaucoup de preuves", rationale: "" });
  let rec = r.body.record;
  const [fill] = await timed(async () => {
    for (let i = 0; i < 100; i++) rec = (await ract(srv, ctx, "reasoning_evidence_add", rec, { ref: { kind: "block", page_id: "page-a", block_id: "block-p" + i } })).body.record;
  });
  PERF("evidence-fill 100", `${fill.toFixed(0)} ms total (${(fill / 100).toFixed(1)} ms per add, revision-bound)`);
  check(rec.evidence.length === 100, "100 evidence refs stored");
  check((await ract(srv, ctx, "reasoning_evidence_add", rec, { ref: { kind: "page", page_id: "page-a" } })).status === 409, "the 101st is refused");
  const resolve = await apiMs(srv, ctx, { action: "reasoning_resolve", id: rec.id }, 5);
  PERF("resolve 100 evidence", `api_median=${resolve.toFixed(1)} ms`);
  await reopen(p);
  await openWorkspace(p);
  const bag = [];
  rposts(p, bag);
  const [render] = await timed(() => openDetail(p, rec.id));
  PERF("detail 100 evidence", `open→resolved ${render.toFixed(0)} ms; requests=${bag.map((b) => b.action).join(",")}`);
  check(bag.filter((b) => b.action === "reasoning_resolve").length === 1 && bag.length === 2, "one get + one resolve (no per-evidence request)");
  check((await p.locator(RSN + " [data-rsn-evidence]").count()) === 100, "100 evidence rows rendered");
});

scenario("P3 one record with 100 verification links: detail is ONE get + ONE resolve", async () => {
  const { srv, ctx, p } = await world("desktop");
  let rec = (await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: ASM, project_id: "proj-1", statement: "Beaucoup de vérifications", rationale: "" })).body.record;
  const vids = [];
  for (let i = 0; i < 100; i++) vids.push((await cpost(srv, ctx, { action: "verification_create", request_id: rid(), question: "Vérification " + i + " ?", target: { kind: "page", page_id: "page-a" } })).body.verification.id);
  const [fill] = await timed(async () => { for (const id of vids) rec = (await ract(srv, ctx, "reasoning_verification_link", rec, { verification_id: id })).body.record; });
  PERF("link-fill 100", `${fill.toFixed(0)} ms total`);
  check(rec.verification_ids.length === 100, "100 links");
  const resolve = await apiMs(srv, ctx, { action: "reasoning_resolve", id: rec.id }, 5);
  PERF("resolve 100 links", `api_median=${resolve.toFixed(1)} ms`);
  await reopen(p);
  await openWorkspace(p);
  const bag = [];
  rposts(p, bag);
  const [render] = await timed(() => openDetail(p, rec.id));
  PERF("detail 100 links", `open→resolved ${render.toFixed(0)} ms; requests=${bag.map((b) => b.action).join(",")}`);
  check(bag.length === 2, "one get + one resolve");
  check((await p.locator(RSN + " [data-rsn-vlink]").count()) === 100, "100 link rows rendered");
});

scenario("P4 Reader related-load: one request, 100 records present; supersession mutation; freshness batch of 25; report render", async () => {
  const { srv, ctx, p, ed } = await (async () => { const w = await readerOnCitation(); return w; })();
  const recs = [];
  for (let i = 0; i < 100; i++) recs.push((await cpost(srv, ctx, { action: "reasoning_create", request_id: rid(), kind: i % 2 ? ASM : DEC, project_id: "proj-1", statement: "Enregistrement " + i, rationale: "", evidence: [{ kind: "source", source_id: ed.id }] })).body.record);
  const rel = await apiMs(srv, ctx, { action: "reasoning_related", targets: [{ kind: "source", source_id: ed.id }] }, 5);
  PERF("related 100 records", `api_median=${rel.toFixed(1)} ms`);
  await reopen(p);
  const bag = [];
  rposts(p, bag);
  await citationToReader(p, "block-c1");
  const [open] = await timed(() => rsnPanelReady(p));
  PERF("reader panel load", `ready ${open.toFixed(0)} ms; requests=${bag.map((b) => b.action).join(",")}`);
  check(bag.filter((b) => b.action === "reasoning_related").length === 1 && bag.length === 1, "ONE related request for the whole panel");
  const [sup] = await timed(() => cpost(srv, ctx, { action: "reasoning_supersede", predecessor_id: recs[0].id, expected_rev: recs[0].rev, request_id: rid(), statement: "Successeur", rationale: "" }));
  PERF("supersede mutation", `${sup.toFixed(1)} ms (two writes, one evidence observation, best-effort capture)`);
  for (const r of recs.slice(1, 26)) await ract(srv, ctx, "reasoning_status", r, { status: r.kind === DEC ? "withdrawn" : "retired" });
  const ids = recs.slice(1, 26).map((r) => r.id);
  const fresh = await apiMs(srv, ctx, { action: "reasoning_resolve", ids }, 3);
  PERF("freshness batch 25", `api_median=${fresh.toFixed(1)} ms (25 historical records, evidence compared with their captures)`);
  const rep = await apiMs(srv, ctx, { action: "report_build", items: recs.slice(1, 11).map((r) => ({ kind: "reasoning", reasoning_id: r.id })), include_sources: false }, 3);
  PERF("report render 10", `api_median=${rep.toFixed(1)} ms`);
  check(rel < 2000 && fresh < 5000 && rep < 3000, "generous ceilings");
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
