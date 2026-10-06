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
const SHOTS = process.env.P11_SHOTS || "";
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


// ---------------------------------------------------------------- scenarios

scenario("01 Reader: quiet summary, create a verification from the opened citation; page, sources and every other store stay byte-identical", async () => {
  const { srv, ctx, p, ed } = await readerVerWorld();
  check((await txt(p, VP + " [data-ver=summary]")).includes("Aucune vérification"), "quiet summary when none");
  check((await p.getAttribute(VP + "-toggle", "aria-expanded")) === "false", "collapsed by default");
  check((await txt(p, VP + " .carnet-ver-heading")).includes("Vérifications"), "heading says 'Vérifications'");
  const before = digestExcept(srv, ["verifications"]);
  const pageBefore = JSON.stringify(srv.pg("page-a"));
  await p.click(VP + "-toggle");
  await p.click(VP + "-create");
  await p.fill(VP + "-q", "La clause 412 s'applique-t-elle à ce palier ?");
  await p.click(VP + "-create-yes");
  await until(async () => (await txt(p, VP + " [data-ver=summary]")).includes("1 ouverte"), "summary now says '1 ouverte'");
  check(verFiles(srv).length === 1, "one verification file");
  const rec = verRecs(srv)[0];
  check(rec.status === "open" && rec.evidence.length === 0 && rec.signoffs.length === 0, "open, no evidence, no signoff");
  check(rec.target.kind === "citation" && !!rec.target.citation_fingerprint && !("cite" in rec.target), "target is the citation, fingerprinted by the server");
  check(digestExcept(srv, ["verifications"]) === before, "every other store is byte-identical");
  check(JSON.stringify(srv.pg("page-a")) === pageBefore, "page JSON (content, rev) unchanged");
  await reopen(p);
  await citationToReader(p, "block-c1");
  await verPanelReady(p);
  check((await txt(p, VP + " [data-ver=summary]")).includes("1 ouverte"), "survives a reload");
  await shotEl(p, VP, "01-reader-verifications");
});

scenario("02 frozen Reader (Review Pack item): panel labelled current workflow created after the frozen evidence; the pack file is untouched", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue gelée", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  await vcreate(srv, ctx, sourceT(ed), "La source est-elle la bonne édition ?");
  const packBefore = readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8");
  await reopen(p);
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.click('[data-rv="open-reader"]');
  await p.waitForSelector(R);
  await painted(p);
  await verPanelReady(p);
  check((await txt(p, VP + " .carnet-ver-heading")).includes("créé après les preuves figées"), "heading: workflow created after the frozen evidence");
  await p.click(VP + "-toggle");
  check((await p.locator(VP + ' [data-ver="not-frozen"]').count()) === 1, "explicit note that these are not part of the frozen copy");
  check((await p.locator(VP + " .carnet-ver-q").allTextContents()).includes("La source est-elle la bonne édition ?"), "the current verification is shown, separately");
  check(readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8") === packBefore, "the Review Pack file is byte-identical");
  check(!(await rtxt(p, "#hq-carnet-reader-table")).includes("La source est-elle"), "the frozen metadata table does not contain it");
  await shotEl(p, VP, "02-frozen-reader-verifications");
});

scenario("03 workspace: shared modal, grouped Ouvertes / Prêtes / À reprendre / Vérifiées, server filters, client text filter disclosed, Tab containment, Escape", async () => {
  const { srv, ctx, p, ed } = await verWorld();
  const a = await vcreate(srv, ctx, blockT(srv), "Question ouverte ?");
  let b = await vcreate(srv, ctx, sourceT(ed), "Question prête ?");
  b = (await vact(srv, ctx, "verification_evidence_add", b, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  b = (await vact(srv, ctx, "verification_status", b, { status: "ready" })).body.verification;
  let c = await vcreate(srv, ctx, { kind: "drawing", stem: "plan-1" }, "Question à reprendre ?");
  await vact(srv, ctx, "verification_status", c, { status: "needs_followup", followup_note: "Mesurer encore" });
  let d = await vcreate(srv, ctx, blockT(srv, 0), "Question vérifiée ?");
  d = (await vact(srv, ctx, "verification_evidence_add", d, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  d = (await vact(srv, ctx, "verification_status", d, { status: "ready" })).body.verification;
  check((await vact(srv, ctx, "verification_signoff", d, { request_id: rid() })).status === 200, "one verified via the explicit signoff action");
  await reopen(p);
  const opener = "#btn-carnet-verifications";
  await openWorkspace(p);
  const groups = await p.locator(VER + " [data-ver-group] h4").allTextContents();
  check(JSON.stringify(groups.map((g) => g.replace(/ \(\d+\)/, ""))) === JSON.stringify(["Ouvertes", "Prêtes à vérifier", "À reprendre", "Vérifiées"]), "groups in order: " + groups.join(" | "));
  check((await txt(p, VER + " [data-ver=summary]")).includes("1 ouverte · 1 prête à vérifier · 1 à reprendre · 1 vérifiée"), "summary line");
  check((await txt(p, VER + " [data-ver=disclosure]")).includes("aucune identité de relecteur authentifiée"), "no-identity disclosure on screen");
  check((await txt(p, VER + " [data-ver=filter-disclosure]")).includes("100 au plus"), "client-side filtering disclosed");
  await p.selectOption(VER + " #hq-carnet-ver-f-status", "ready");
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 1, "server-side status filter: one row");
  check((await txt(p, VER + " .carnet-ver-q")) === "Question prête ?", "the ready one");
  await p.selectOption(VER + " #hq-carnet-ver-f-status", "");
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 4, "all four again");
  await p.fill(VER + " #hq-carnet-ver-f-text", "vérifiée");
  check((await p.locator(VER + " .carnet-ver-row").count()) === 1, "client text filter over loaded rows");
  await p.fill(VER + " #hq-carnet-ver-f-text", "");
  await p.selectOption(VER + " #hq-carnet-ver-f-kind", "drawing");
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 1, "target-kind filter");
  await p.selectOption(VER + " #hq-carnet-ver-f-kind", "");
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 4, "unfiltered");
  const inside = () => p.evaluate(() => { const r = document.querySelector("#hq-carnet-ver"); return !!(r && r.contains(document.activeElement)); });
  for (let i = 0; i < 40; i += 1) await p.keyboard.press("Tab");
  check(await inside(), "Tab x40 never leaves the workspace");
  for (let i = 0; i < 40; i += 1) await p.keyboard.press("Shift+Tab");
  check(await inside(), "Shift+Tab x40 never leaves the workspace");
  check((await p.getAttribute(VER, "role")) === "dialog" && (await p.getAttribute(VER, "aria-modal")) === "true" && !!(await p.getAttribute(VER, "aria-labelledby")), "dialog semantics");
  await shotEl(p, VER, "03-workspace-list");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(VER).count()) === 0, "Escape closes the workspace");
  check((await p.evaluate(() => document.activeElement && document.activeElement.id)) === "btn-carnet-verifications", "focus returns to the opener");
});

scenario("04 detail: QUESTION / TARGET / EVIDENCE / CURRENT STATE / SIGNOFF HISTORY / COMMENTAIRE are separate blocks; hostile text stays text", async () => {
  const { srv, ctx, p, ed } = await verWorld();
  const hostile = '<img src=x onerror="window.__pwned=1"> **gras** [x](javascript:alert(1))';
  let v = await vcreate(srv, ctx, blockT(srv), hostile);
  v = (await vact(srv, ctx, "verification_update", v, { note: "<script>window.__pwned=2</script>" })).body.verification;
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, v.id);
  const order = await p.locator(VER + " [data-ver-block]").evaluateAll((n) => n.map((x) => x.getAttribute("data-ver-block")));
  check(JSON.stringify(order) === JSON.stringify(["question", "target", "evidence", "current", "history", "note"]), "six blocks in order: " + order.join(","));
  check((await p.inputValue(VER + " #hq-carnet-ver-question")) === hostile, "question shown literally (editable while open)");
  check((await p.inputValue(VER + " #hq-carnet-ver-note")).includes("<script>"), "note shown literally");
  check((await p.evaluate(() => window.__pwned)) === undefined, "nothing ran");
  check((await p.locator(VER + " img, " + VER + " script, " + VER + " a[href^=javascript]").count()) === 0, "no element was created from the text");
  check((await txt(p, VER + " [data-ver=target]")).includes("Bloc"), "target shown by identity");
  check((await txt(p, VER + " #hq-carnet-ver-b-history")).includes("aucune identité de relecteur authentifiée"), "history block carries the no-identity disclosure");
  for (const id of ["question", "target", "evidence", "current", "history", "note"]) check((await p.locator(`${VER} #hq-carnet-ver-${id}-h`).count()) === 1, "heading " + id);
  await shotEl(p, VER, "04-detail");
});

scenario("05 full flow in the UI: create → add evidence → prête → enregistrer; verified only by the explicit confirmation; evidence change later shows 'ont changé depuis' while status stays Vérifiée", async () => {
  const { srv, ctx, p, ed } = await readerVerWorld();
  const pageRev = srv.pg("page-a").rev;
  await p.click(VP + "-toggle");
  await p.click(VP + "-create");
  await p.fill(VP + "-q", "Cette clause couvre-t-elle ce palier ?");
  await p.click(VP + "-create-yes");
  await until(async () => verFiles(srv).length === 1, "created");
  // attach the SOURCE as evidence from the Reader: the status must not move
  await p.click(VP + "-add");
  await p.check(VP + "-ref-source");
  await until(async () => (await p.locator(VP + "-cand option").count()) === 1, "candidate verification offered");
  await p.click(VP + "-add-yes");
  await until(async () => verRecs(srv)[0].evidence.length === 1, "evidence attached");
  check(verRecs(srv)[0].status === "open", "attaching evidence never changes the status");
  await p.click(VP + "-workspace");
  await p.waitForSelector(VER);
  await openDetail(p, verRecs(srv)[0].id);
  check((await statusOf(p)) === "Vérification : Ouverte", "status chip is prefixed: " + (await statusOf(p)));
  check((await p.locator(VER + " #btn-carnet-ver-signoff").count()) === 0, "no signoff button while open");
  await p.click(VER + " #btn-carnet-ver-ready");
  await until(async () => (await statusOf(p)) === "Vérification : Prête à vérifier", "ready");
  check(verRecs(srv)[0].signoffs.length === 0, "ready does not verify");
  await p.click(VER + " #btn-carnet-ver-signoff");
  check((await txt(p, VER + " .carnet-ver-confirm")).includes("aucune identité de relecteur authentifiée"), "the confirmation states there is no reviewer identity");
  check(verRecs(srv)[0].signoffs.length === 0, "still nothing recorded before the explicit confirmation");
  await p.click(VER + " #btn-carnet-ver-signoff-yes");
  await until(async () => (await statusOf(p)) === "Vérification : Vérifiée", "verified after the explicit confirmation");
  const rec = verRecs(srv)[0];
  check(rec.signoffs.length === 1 && rec.signoffs[0].evidence.length === 1, "one signoff with the captured evidence");
  check(!JSON.stringify(rec).match(/signed_by|author|user/), "no identity anywhere in the record");
  await until(async () => (await txt(p, VER + " [data-ver=overall]")).includes("inchangées"), "current state: unchanged");
  check((await p.locator(VER + " [data-ver-signoff]").count()) === 1, "history lists the signoff");
  // the evidence (the source metadata) changes later
  const fam = await cget(srv, ctx, "sources=1");
  const e0 = fam.body.editions.find((x) => x.id === ed.id);
  check((await cpost(srv, ctx, { action: "source_edition_update", id: ed.id, expected_rev: e0.rev, title: "Machinery (rév. B)" })).status === 200, "source metadata changed");
  await p.click(VER + " #btn-carnet-ver-refresh");
  await until(async () => (await txt(p, VER + " [data-ver=overall]")).includes("ont changé depuis"), "current state: 'les preuves actuelles ont changé depuis'");
  check((await statusOf(p)) === "Vérification : Vérifiée", "status stays Vérifiée");
  check(verRecs(srv)[0].signoffs.length === 1 && verRecs(srv)[0].status === "verified", "the stored signoff and status are untouched by the change");
  check(srv.pg("page-a").rev === pageRev, "the page revision never moved");
  await shotEl(p, VER, "05-verified-changed");
  await p.click(VER + " #btn-carnet-ver-reopen");
  await until(async () => (await statusOf(p)) === "Vérification : Ouverte", "reopened");
  check(verRecs(srv)[0].signoffs.length === 1, "reopening keeps the signoff history");
});

scenario("06 needs_followup requires a reason, keeps the reason when reopened; the Vérification: prefix is used", async () => {
  const { srv, ctx, p } = await verWorld();
  const v = await vcreate(srv, ctx, blockT(srv));
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, v.id);
  await p.click(VER + " #btn-carnet-ver-followup");
  await p.click(VER + " #btn-carnet-ver-followup-yes");
  check((await txt(p, VER + " [data-ver=error]")).length > 0, "a reason is required: refused client-side");
  check(verRecs(srv)[0].status === "open", "nothing stored");
  await p.fill(VER + " #hq-carnet-ver-followup-text", "Refaire la mesure avec le calibre");
  await p.click(VER + " #btn-carnet-ver-followup-yes");
  await until(async () => (await statusOf(p)) === "Vérification : À reprendre", "À reprendre");
  check((await txt(p, VER + " [data-ver=followup]")).includes("Refaire la mesure"), "reason shown");
  await p.click(VER + " #btn-carnet-ver-reopen");
  await until(async () => (await statusOf(p)) === "Vérification : Ouverte", "reopened");
  check(verRecs(srv)[0].followup_note === "Refaire la mesure avec le calibre", "the reason is kept");
});

scenario("07 stale edit: the other device wins with 409, the losing text is never stored and stays in the box for an explicit retry", async () => {
  const { srv, ctx, p } = await verWorld();
  const v = await vcreate(srv, ctx, blockT(srv));
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, v.id);
  const bumped = (await vact(srv, ctx, "verification_update", v, { note: "écrite ailleurs" })).body.verification;
  await p.fill(VER + " #hq-carnet-ver-question", "Question réécrite localement ?");
  await p.click(VER + " #btn-carnet-ver-q-save");
  await until(async () => (await txt(p, VER + " [data-ver=error]")).includes("a changé ailleurs"), "conflict notice");
  check(verRecs(srv)[0].question === v.question && verRecs(srv)[0].note === "écrite ailleurs", "the server never stored the losing text");
  check((await p.inputValue(VER + " #hq-carnet-ver-question")) === "Question réécrite localement ?", "the typed text is kept");
  check(bumped.rev === verRecs(srv)[0].rev, "nothing was retried or merged");
  await p.click(VER + " #btn-carnet-ver-q-save");
  await until(async () => verRecs(srv)[0].question === "Question réécrite localement ?", "explicit retry succeeds on the fresh revision");
});

scenario("08 signoff retried after a lost answer: the SAME request id, ONE signoff recorded", async () => {
  const { srv, ctx, p } = await verWorld();
  let v = await vcreate(srv, ctx, blockT(srv));
  v = (await vact(srv, ctx, "verification_evidence_add", v, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, v.id);
  const bodies = [];
  let first = true;
  await p.route("**/api/carnet", async (route) => {
    const post = route.request().postData() || "";
    if (route.request().method() === "POST" && post.includes('"verification_signoff"')) {
      bodies.push(JSON.parse(post));
      if (first) {
        first = false;
        await route.fetch();
        await route.abort("failed"); // the server DID record it; the browser never hears
        return;
      }
    }
    await route.continue();
  });
  await p.click(VER + " #btn-carnet-ver-signoff");
  await p.click(VER + " #btn-carnet-ver-signoff-yes");
  await until(async () => (await txt(p, VER + " [data-ver=error]")).length > 0, "network error surfaced");
  check(verRecs(srv)[0].signoffs.length === 1, "the server did record it once");
  await p.click(VER + " #btn-carnet-ver-signoff-yes").catch(() => {});
  await until(async () => bodies.length >= 2 || (await statusOf(p)) === "Vérification : Vérifiée", "retry performed or state refreshed");
  if (bodies.length >= 2) check(bodies[0].request_id === bodies[1].request_id, "same request id on the retry");
  check(verRecs(srv)[0].signoffs.length === 1, "still exactly one signoff after the retry");
  await p.unroute("**/api/carnet");
});

scenario("09 delete: unsigned = confirmed once and revision-bound; any signoff = no delete button and the API refuses (409 verification_has_signoff)", async () => {
  const { srv, ctx, p } = await verWorld();
  const plain = await vcreate(srv, ctx, blockT(srv, 0), "À supprimer ?");
  let signed = await vcreate(srv, ctx, blockT(srv, 1), "À conserver ?");
  signed = (await vact(srv, ctx, "verification_evidence_add", signed, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
  signed = (await vact(srv, ctx, "verification_status", signed, { status: "ready" })).body.verification;
  signed = (await vact(srv, ctx, "verification_signoff", signed, { request_id: rid() })).body.verification;
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, signed.id);
  check((await p.locator(VER + " #btn-carnet-ver-delete").count()) === 0, "no delete button once a signoff exists");
  check((await txt(p, VER + " [data-ver=has-signoff]")).includes("Suppression impossible"), "the reason is stated");
  const r = await vact(srv, ctx, "verification_delete", signed, { confirm: true });
  check(r.status === 409 && r.body.code === "verification_has_signoff", "API refuses: " + r.body.code);
  await p.click(VER + " #btn-carnet-ver-back");
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 2, "list back");
  await openDetail(p, plain.id);
  await p.click(VER + " #btn-carnet-ver-delete");
  check(verFiles(srv).length === 2, "nothing deleted before the confirmation");
  await p.click(VER + " #btn-carnet-ver-delete-yes");
  await until(async () => verFiles(srv).length === 1, "deleted after confirmation");
  check(verRecs(srv)[0].id === signed.id, "the signed one survives");
});

scenario("10 corrupt record: listed and shown read-only, no action buttons, bytes preserved; the neighbour stays usable", async () => {
  const { srv, ctx, p } = await verWorld();
  const good = await vcreate(srv, ctx, blockT(srv, 0), "Saine ?");
  const bad = await vcreate(srv, ctx, blockT(srv, 1), "Altérée ?");
  const f = path.join(verDir(srv), bad.id + ".json");
  const data = JSON.parse(readFileSync(f, "utf8"));
  data.question = "texte altéré";
  const raw = JSON.stringify(data);
  writeFileSync(f, raw);
  await reopen(p);
  await openWorkspace(p);
  check((await p.locator(VER + ' [data-ver-group="unavailable"] .carnet-ver-row').count()) === 1, "listed apart, read-only");
  check((await txt(p, VER + ' [data-ver-group="unavailable"]')).includes("Altérée"), "flagged");
  await openDetail(p, bad.id);
  check((await p.locator(VER + " [data-ver=corrupt]").count()) === 1, "corrupt banner");
  check((await p.locator(VER + " #hq-carnet-ver-actions, " + VER + " #btn-carnet-ver-q-save, " + VER + " #btn-carnet-ver-note-save").count()) === 0, "no action buttons on a corrupt record");
  check(readFileSync(f, "utf8") === raw, "bytes preserved");
  const r = await vact(srv, ctx, "verification_delete", bad, { confirm: true });
  check(r.status === 409 && r.body.code === "verification_corrupt", "API refuses delete: " + r.body.code);
  await p.click(VER + " #btn-carnet-ver-back");
  await openDetail(p, good.id);
  check((await p.locator(VER + " #btn-carnet-ver-q-save").count()) === 1, "the healthy one is editable");
});

scenario("11 Review Pack item: 'Vérifications liées' is lazy (one related request on expand), creates a verification for the item, pack bytes untouched", async () => {
  const { srv, ctx, p, ed } = await verWorld();
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  const item = pk.items[0];
  const packBefore = readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8");
  await reopen(p);
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector(DLG, { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  const bag = [];
  vposts(p, bag);
  await p.waitForSelector(`#hq-carnet-rv-vtoggle-${item.id}`);
  await sleep(300);
  check(bag.length === 0, "no verification request until the person expands: " + bag.length);
  await p.click(`#hq-carnet-rv-vtoggle-${item.id}`);
  const P = `#hq-carnet-rv-ver-${item.id}`;
  await until(async () => (await p.locator(P + " [data-ver=summary]").count()) > 0 && !(await txt(p, P + " [data-ver=summary]")).includes("Chargement"), "panel loaded");
  check(bag.filter((b) => b.action === "verification_related").length === 1, "exactly one related request");
  check((await txt(p, P + " .carnet-ver-heading")).includes("créé après les preuves figées"), "labelled as workflow created after the captured evidence");
  await p.click(P + "-create");
  await p.fill(P + "-q", "Cet élément de revue est-il suffisant ?");
  await p.click(P + "-create-yes");
  await until(async () => verFiles(srv).length === 1, "created");
  const rec = verRecs(srv)[0];
  check(rec.target.kind === "review_item" && rec.target.item_id === item.id && !!rec.target.item_fingerprint, "target = the review item, fingerprint captured by the server");
  check(readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8") === packBefore, "the Review Pack file is byte-identical (no schema change, no reference stored in it)");
  await until(async () => (await txt(p, P + " [data-ver=summary]")).includes("1 ouverte"), "summary updated");
  await shotEl(p, `[data-rv-verifs="${item.id}"]`, "11-review-item-verifications");
});

scenario("12 batching: workspace = one list request, Reader panel = one related request, 'évaluer' = one resolve request per 25 verified rows; nothing per row", async () => {
  const { srv, ctx, p, ed } = await verWorld();
  for (let i = 0; i < 30; i += 1) {
    let v = await vcreate(srv, ctx, blockT(srv, i % 2), "Question " + i + " ?");
    if (i < 27) {
      v = (await vact(srv, ctx, "verification_evidence_add", v, { ref: { kind: "page", page_id: "page-a" } })).body.verification;
      v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
      await vact(srv, ctx, "verification_signoff", v, { request_id: rid() });
    }
  }
  await reopen(p);
  const bag = [];
  vposts(p, bag);
  await openWorkspace(p);
  check(bag.length === 1 && bag[0].action === "verification_list", "workspace: ONE request: " + bag.map((b) => b.action).join(","));
  check((await p.locator(VER + " .carnet-ver-row").count()) === 30, "30 rows rendered from it");
  bag.length = 0;
  await p.click(VER + " #btn-carnet-ver-evaluate");
  await until(async () => bag.length === 2, "two resolve requests for 27 verified rows (25 + 2): " + bag.length);
  check(bag.every((b) => b.action === "verification_resolve" && Array.isArray(b.ids) && b.ids.length <= 25), "batched, ≤25 ids each");
  await p.selectOption(VER + " #hq-carnet-ver-f-fresh", "unchanged");
  check((await p.locator(VER + " .carnet-ver-row").count()) === 27, "freshness filter over the evaluated rows");
  check(bag.length === 2, "the filter itself made no request");
});

scenario("13 offline: the list stays readable, every mutating control is aria-disabled and nothing is sent", async () => {
  const { srv, ctx, p } = await verWorld();
  const v = await vcreate(srv, ctx, blockT(srv));
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, v.id);
  await ctx.setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event("offline")));
  const bag = [];
  vposts(p, bag);
  await p.click(VER + " #btn-carnet-ver-note-save");
  check(bag.length === 0, "no request while offline");
  check((await p.getAttribute(VER + " #btn-carnet-ver-note-save", "aria-disabled")) === "true" || (await txt(p, VER + " [data-ver=error]")).includes("Hors ligne"), "refused with the offline message");
  check((await p.locator(VER + " #hq-carnet-ver-question").count()) === 1, "content still readable");
  await ctx.setOffline(false);
});

scenario("14 iPhone profile: workspace, detail and the Reader panel fit the width, controls are tappable, no horizontal scroll", async () => {
  const { srv, ctx, p, ed } = await readerVerWorld("iphone");
  await vcreate(srv, ctx, sourceT(ed), "Une question assez longue pour passer à la ligne sur un écran étroit, avec un mot interminable : " + "x".repeat(60));
  await p.click(VP + "-toggle");
  await p.click(VP + "-workspace");
  await p.waitForSelector(VER);
  await until(async () => (await p.locator(VER + " .carnet-ver-row").count()) === 1, "list");
  const m1 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.querySelector("#hq-carnet-ver").scrollWidth, cw: document.querySelector("#hq-carnet-ver").clientWidth, h: [...document.querySelectorAll("#hq-carnet-ver button, #hq-carnet-ver select")].map((b) => b.getBoundingClientRect().height) }));
  check(m1.sw <= m1.iw + 1 && m1.dw <= m1.cw + 1, "list: no horizontal overflow " + JSON.stringify({ sw: m1.sw, iw: m1.iw, dw: m1.dw, cw: m1.cw }));
  check(m1.h.every((x) => x >= 40), "controls tall enough: min " + Math.min(...m1.h));
  await p.click(VER + ' [data-ver-act="view"]');
  await p.waitForSelector(VER + " #hq-carnet-ver-status");
  await sleep(300);
  const m2 = await p.evaluate(() => ({ dw: document.querySelector("#hq-carnet-ver").scrollWidth, cw: document.querySelector("#hq-carnet-ver").clientWidth, h: [...document.querySelectorAll("#hq-carnet-ver button, #hq-carnet-ver textarea")].map((b) => b.getBoundingClientRect().height) }));
  check(m2.dw <= m2.cw + 1, "detail: no horizontal overflow " + JSON.stringify(m2.dw) + "/" + m2.cw);
  check(m2.h.every((x) => x >= 40), "detail controls tall enough: min " + Math.min(...m2.h));
  await shotEl(p, VER, "14-iphone-detail");
});

scenario("15 reader panel expand: toggle semantics (aria-expanded/controls), keyboard operable, focus stays on the toggle", async () => {
  const { srv, ctx, p } = await readerVerWorld();
  await p.focus(VP + "-toggle");
  await p.keyboard.press("Enter");
  check((await p.getAttribute(VP + "-toggle", "aria-expanded")) === "true", "Enter expands");
  check((await p.getAttribute(VP + "-toggle", "aria-controls")) === "hq-carnet-reader-ver-body" && (await p.locator(VP + "-body").count()) === 1, "aria-controls points at the body");
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-reader-ver-toggle", "focus stays on the toggle");
  await p.keyboard.press("Space");
  check((await p.getAttribute(VP + "-toggle", "aria-expanded")) === "false", "Space collapses");
  check((await p.getAttribute(VP, "aria-labelledby")) === "hq-carnet-reader-ver-h" && (await p.locator("#hq-carnet-reader-ver-h").count()) === 1, "region labelled");
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
