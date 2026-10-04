// Carnet product phase 12: decisions & assumptions register (what was chosen / what is taken as true for now; neither is evidence, every status change is explicit).
//
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
const SHOTS = process.env.P12_SHOTS || "";
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
const panelReady = (p) => until(async () => (await p.locator(ANN + " .carnet-ann-group").count()) > 0, "annotations panel loaded");
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

// ---------------------------------------------------------------- scenarios

scenario("01 Reader: quiet summary; 'Créer une décision' pre-attaches the opened citation as evidence; page and every other store stay byte-identical", async () => {
  const { srv, ctx, p } = await readerRsnWorld();
  check((await txt(p, RP + " [data-rsn=summary]")).includes("Aucun enregistrement"), "quiet summary when none");
  check((await p.getAttribute(RP + "-toggle", "aria-expanded")) === "false", "collapsed by default");
  check((await txt(p, RP + " .carnet-rsn-heading")).includes("Décisions et hypothèses"), "heading");
  const before = digestExcept(srv, ["reasoning"]);
  const pageBefore = JSON.stringify(srv.pg("page-a"));
  await p.click(RP + "-toggle");
  await p.click(RP + "-create-dec");
  await p.fill(RP + "-s", "Utiliser un DN80 pour la ligne de transfert.");
  await p.fill(RP + "-r", "Vitesse limitée à 1,5 m/s.");
  await p.click(RP + "-create-yes");
  await until(async () => (await txt(p, RP + " [data-rsn=summary]")).includes("1 décision"), "summary now says '1 décision'");
  check(rsnFiles(srv).length === 1, "one reasoning file");
  const rec = rsnRecs(srv)[0];
  check(rec.kind === DEC && rec.status === "active" && rec.history.length === 0 && rec.verification_ids.length === 0, "active decision, no history");
  check(rec.evidence.length === 1 && rec.evidence[0].ref.kind === "citation" && !("cite" in rec.evidence[0].ref), "the opened citation is pre-attached as evidence (identity only)");
  check(digestExcept(srv, ["reasoning"]) === before, "every other store is byte-identical");
  check(JSON.stringify(srv.pg("page-a")) === pageBefore, "page JSON unchanged");
  await reopen(p);
  await citationToReader(p, "block-c1");
  await rsnPanelReady(p);
  check((await txt(p, RP + " [data-rsn=summary]")).includes("1 décision"), "survives a reload");
  await shotEl(p, RP, "01-reader-register");
});

scenario("02 Reader: 'Créer une hypothèse' on the source; a register record never appears as a verification or as page content", async () => {
  const { srv, ctx, p } = await readerRsnWorld();
  await p.click(RP + "-toggle");
  await p.click(RP + "-create-asm");
  await p.check(RP + "-ref-source");
  await p.fill(RP + "-s", "La source est l'édition 3 de Machinery.");
  await p.click(RP + "-create-yes");
  await until(async () => rsnFiles(srv).length === 1, "created");
  const rec = rsnRecs(srv)[0];
  check(rec.kind === ASM && rec.evidence[0].ref.kind === "source", "assumption with the source as evidence");
  check(!existsSync(path.join(srv.root, ".hq-carnet", "verifications")) || readdirSync(path.join(srv.root, ".hq-carnet", "verifications")).length === 0, "no verification was created");
  check(!JSON.stringify(srv.nb()).includes("La source est l'édition 3"), "the notebook does not contain the statement");
});

scenario("03 frozen Reader (Review Pack item): panel labelled current register created after the frozen evidence; the pack file is untouched", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue gelée", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  await rcreate(srv, ctx, DEC, "Garder cette édition.", { evidence: [sourceT(ed)] });
  const packBefore = readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8");
  await reopen(p);
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector(DLG, { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.click('[data-rv="open-reader"]');
  await p.waitForSelector(R);
  await painted(p);
  await rsnPanelReady(p);
  check((await txt(p, RP + " .carnet-rsn-heading")).includes("créées après la copie figée"), "heading: created after the frozen copy");
  await p.click(RP + "-toggle");
  check((await p.locator(RP + ' [data-rsn="not-frozen"]').count()) === 1, "explicit note that these are not part of the frozen copy");
  check((await p.locator(RP + " .carnet-rsn-q").allTextContents()).includes("Garder cette édition."), "the current record is shown, separately");
  check(readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8") === packBefore, "the Review Pack file is byte-identical");
  await shotEl(p, RP, "03-frozen-reader-register");
});

scenario("04 workspace: shared modal, grouped by kind and status, server filters, client text filter disclosed, journal distinction stated, Tab containment, Escape", async () => {
  const { srv, ctx, p, ed } = await rsnWorld();
  const d1 = await rcreate(srv, ctx, DEC, "Décision active");
  const d2 = await rcreate(srv, ctx, DEC, "Décision retirée");
  await ract(srv, ctx, "reasoning_status", d2, { status: "withdrawn" });
  const a1 = await rcreate(srv, ctx, ASM, "Hypothèse active");
  let a2 = await rcreate(srv, ctx, ASM, "Hypothèse confirmée", { evidence: [sourceT(ed)] });
  a2 = (await ract(srv, ctx, "reasoning_status", a2, { status: "confirmed" })).body.record;
  const a3 = await rcreate(srv, ctx, ASM, "Hypothèse retirée");
  await ract(srv, ctx, "reasoning_status", a3, { status: "retired" });
  await reopen(p);
  await openWorkspace(p);
  check((await txt(p, RSN + " h3")).includes("Registre des décisions et hypothèses"), "title");
  const groups = await p.locator(RSN + " [data-rsn-group]").evaluateAll((n) => n.map((x) => x.getAttribute("data-rsn-group")));
  check(["dec-active", "dec-history", "asm-active", "asm-confirmed", "asm-retired"].every((g) => groups.includes(g)), "groups: " + groups.join(","));
  check((await p.locator(RSN + ' [data-rsn="journal-distinct"]').count()) === 1, "states it is distinct from the journal Decision block");
  check((await p.locator(RSN + ' [data-rsn="disclosure"]').count()) >= 1, "no-identity disclosure");
  check((await p.locator(RSN + " [data-rsn-row]").count()) === 5, "five rows");
  await p.selectOption(RSN + " #hq-carnet-rsn-f-kind", ASM);
  await until(async () => (await p.locator(RSN + " [data-rsn-row]").count()) === 3, "server kind filter");
  await p.selectOption(RSN + " #hq-carnet-rsn-f-kind", "");
  await until(async () => (await p.locator(RSN + " [data-rsn-row]").count()) === 5, "filter cleared");
  await p.fill(RSN + " #hq-carnet-rsn-f-text", "retirée");
  await until(async () => (await p.locator(RSN + " [data-rsn-row]").count()) === 2, "client text filter");
  check((await p.locator(RSN + ' [data-rsn="filter-disclosure"]').count()) === 1, "text filter disclosed as loaded-only");
  await p.fill(RSN + " #hq-carnet-rsn-f-text", "");
  const kinds = await p.locator(RSN + " [data-rsn-act]").evaluateAll((n) => n.map((x) => x.textContent).join("|"));
  check(!/kanban|priorit|assign|échéance|confiance/i.test(kinds + (await txt(p, RSN))), "no Kanban, priority, assignee, due date or confidence anywhere");
  for (let i = 0; i < 40; i++) await p.keyboard.press("Tab");
  check(await p.evaluate(() => document.querySelector("#hq-carnet-rsn").contains(document.activeElement)), "Tab stays inside the modal");
  await shotEl(p, RSN, "04-workspace");
  await p.keyboard.press("Escape");
  await p.waitForSelector(RSN, { state: "detached" });
  check(d1 && a1, "closed with Escape");
});

scenario("05 detail: STATEMENT / RATIONALE / EVIDENCE / VERIFICATIONS / CURRENT EVIDENCE STATE / HISTORY are separate blocks; hostile text stays text", async () => {
  const { srv, ctx, p, ed } = await rsnWorld();
  const hostile = '<img src=x onerror="window.__x=1"> <script>window.__x=2</script> **gras** ../../etc/passwd';
  const r = await rcreate(srv, ctx, DEC, hostile, { rationale: hostile, evidence: [sourceT(ed)] });
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, r.id);
  for (const b of ["statement", "rationale", "evidence", "verifications", "current", "history"]) check((await p.locator(`${RSN} [data-rsn-block="${b}"]`).count()) === 1, "block " + b);
  const stm = await p.inputValue(RSN + " #hq-carnet-rsn-statement");
  check(stm === hostile, "statement stored and shown exactly as text");
  check((await p.evaluate(() => window.__x)) === undefined, "nothing executed");
  check((await p.locator(RSN + " img, " + RSN + " script").count()) === 0, "no element was created from the text");
  check((await p.locator(RSN + " [data-rsn=live-label]").count()) === 1, "current evidence state is labelled as read now");
  await shotEl(p, RSN, "05-detail");
});

scenario("06 assumption flow: confirm needs evidence; the dialog shows 'N vérifications liées · M vérifiée' without gating; evidence change later shows 'Modifié' while the status stays Confirmée", async () => {
  const { srv, ctx, p } = await rsnWorld();
  let a = await rcreate(srv, ctx, ASM, "Masse volumique = 998 kg/m³ à 20 °C");
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, a.id);
  await p.click(RSN + " #btn-carnet-rsn-confirmed");
  await p.click(RSN + " #btn-carnet-rsn-status-yes");
  await until(async () => (await txt(p, RSN + " [data-rsn=error]")).includes("Au moins une preuve"), "no evidence → refused with the procedural message");
  check((await rget(srv, ctx, a)).status === "active", "status unchanged");
  a = (await ract(srv, ctx, "reasoning_evidence_add", await rget(srv, ctx, a), { ref: blockT(srv) })).body.record;
  const v = (await cpost(srv, ctx, { action: "verification_create", request_id: rid(), question: "Valeur confirmée ?", target: { kind: "page", page_id: "page-a" } })).body.verification;
  a = (await ract(srv, ctx, "reasoning_verification_link", a, { verification_id: v.id })).body.record;
  await p.click(RSN + " #btn-carnet-rsn-back");
  await openWorkspace(p).catch(() => {});
  await until(async () => (await p.locator(RSN + " [data-rsn-row]").count()) === 1, "list");
  await openDetail(p, a.id);
  await p.click(RSN + " #btn-carnet-rsn-confirmed");
  check((await txt(p, RSN + ' [data-rsn="confirm-verifications"]')) === "1 vérification liée · 0 vérifiée", "dialog displays the linked verification summary");
  await p.click(RSN + " #btn-carnet-rsn-status-yes");
  await until(async () => (await statusOf(p)) === "Confirmée", "confirmed (the unverified link did not gate it)");
  const rec = rsnRecs(srv)[0];
  check(rec.status === "confirmed" && rec.history.length === 1 && rec.history[0].event === "confirmed" && rec.history[0].evidence.length === 1, "one sealed confirm event with its capture");
  check((await p.locator(RSN + " #hq-carnet-rsn-statement[type], " + RSN + " textarea#hq-carnet-rsn-statement").count()) === 0, "statement is no longer editable (historical)");
  check((await p.locator(RSN + ' [data-rsn="historical"]').count()) === 1, "read-only banner");
  srv.remote((pg) => { pg.content.blocks[1].text = "Texte modifié ailleurs"; });
  await p.click(RSN + " #btn-carnet-rsn-refresh");
  await until(async () => (await txt(p, RSN + " [data-rsn=overall]")).includes("Modifié depuis la transition"), "live freshness: modified since the transition");
  check((await statusOf(p)) === "Confirmée" && rsnRecs(srv)[0].history[0].evidence[0].state === "ok", "status and stored capture are unchanged");
  await shotEl(p, RSN, "06-confirmed-changed");
});

scenario("07 confirm refused when evidence is missing (fail closed) and withdraw still works under the same condition", async () => {
  const { srv, ctx, p } = await rsnWorld();
  mkdirSync(path.join(srv.root, "Inbox", "Drawings"), { recursive: true });
  writeFileSync(path.join(srv.root, "Inbox", "Drawings", "g1.hqdraw.json"), '{"v":1}');
  const a = await rcreate(srv, ctx, ASM, "Le croquis est à jour", { evidence: [{ kind: "drawing", stem: "g1" }] });
  const d = await rcreate(srv, ctx, DEC, "Garder le croquis", { evidence: [{ kind: "drawing", stem: "g1" }] });
  rmSync(path.join(srv.root, "Inbox", "Drawings", "g1.hqdraw.json"));
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, a.id);
  await p.click(RSN + " #btn-carnet-rsn-confirmed");
  await p.click(RSN + " #btn-carnet-rsn-status-yes");
  await until(async () => (await txt(p, RSN + " [data-rsn=error]")).includes("Impossible de confirmer l'hypothèse"), "confirm refused with the procedural message");
  check((await rget(srv, ctx, a)).status === "active", "still active");
  await p.click(RSN + " #btn-carnet-rsn-back");
  await until(async () => (await p.locator(RSN + " [data-rsn-row]").count()) === 2, "list");
  await openDetail(p, d.id);
  await p.click(RSN + " #btn-carnet-rsn-withdrawn");
  await p.click(RSN + " #btn-carnet-rsn-status-yes");
  await until(async () => (await statusOf(p)) === "Retirée", "withdrawn although the evidence is unavailable");
  const rec = rsnRecs(srv).find((x) => x.id === d.id);
  check(rec.history[0].evidence[0].state === "missing" && rec.history[0].evidence[0].seal === null, "missing recorded, not blocking");
});

scenario("08 supersede in the UI: explicit, successor created, predecessor read-only 'Remplacé par'; lost answer retried with the SAME request id creates ONE successor", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const d = await rcreate(srv, ctx, DEC, "Utiliser un DN80");
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, d.id);
  const bodies = [];
  let first = true;
  await p.route("**/api/carnet", async (route) => {
    const post = route.request().postData() || "";
    if (route.request().method() === "POST" && post.includes('"reasoning_supersede"')) {
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
  await p.click(RSN + " #btn-carnet-rsn-supersede");
  await p.fill(RSN + " #hq-carnet-rsn-sup-statement", "Utiliser un DN100");
  await p.click(RSN + " #btn-carnet-rsn-sup-yes");
  await until(async () => (await txt(p, RSN + " [data-rsn=error]")).length > 0, "network error surfaced");
  check(rsnFiles(srv).length === 2, "the server did record it once (predecessor + successor)");
  await p.click(RSN + " #btn-carnet-rsn-sup-yes").catch(() => {});
  await until(async () => bodies.length >= 2 || (await p.locator(RSN + ' [data-rsn="supersedes"]').count()) > 0, "retry performed or state refreshed");
  if (bodies.length >= 2) check(bodies[0].request_id === bodies[1].request_id, "same request id on the retry");
  check(rsnFiles(srv).length === 2, "still exactly two files (no duplicate successor)");
  await p.unroute("**/api/carnet");
  const recs = rsnRecs(srv);
  const pred = recs.find((x) => x.id === d.id);
  const succ = recs.find((x) => x.id !== d.id);
  check(pred.status === "superseded" && pred.superseded_by === succ.id && succ.supersedes === d.id && succ.status === "active", "canonical relation B.supersedes = A, A.superseded_by = B");
  await openDetail(p, d.id).catch(async () => { await p.click(RSN + " #btn-carnet-rsn-back"); await openDetail(p, d.id); });
  check((await statusOf(p)) === "Remplacée" && (await p.locator(RSN + ' [data-rsn="superseded-by"]').count()) === 1, "predecessor shows 'Remplacé par'");
  check((await p.locator(RSN + " #btn-carnet-rsn-supersede, " + RSN + " #btn-carnet-rsn-delete").count()) === 0, "no supersede / delete on a superseded record");
});

scenario("09 stale edit: the other device wins with 409, the losing text is never stored and stays in the box for an explicit retry", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const d = await rcreate(srv, ctx, DEC, "Version initiale");
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, d.id);
  await ract(srv, ctx, "reasoning_update", d, { statement: "Gagnant (autre appareil)" });
  await p.fill(RSN + " #hq-carnet-rsn-statement", "Perdant (cet appareil)");
  await p.click(RSN + " #btn-carnet-rsn-s-save");
  await until(async () => (await txt(p, RSN + " [data-rsn=error]")).includes("a changé ailleurs"), "conflict surfaced");
  check(rsnRecs(srv)[0].statement === "Gagnant (autre appareil)" && !rsnText(srv).includes("Perdant"), "the losing text was never stored");
  check((await p.inputValue(RSN + " #hq-carnet-rsn-statement")) === "Perdant (cet appareil)", "typed text kept in the box");
});

scenario("10 delete: never-transitioned active = confirmed once and revision-bound; any history = no delete button and the API refuses (409 reasoning_has_history)", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const a = await rcreate(srv, ctx, DEC, "À supprimer");
  const b = await rcreate(srv, ctx, DEC, "À conserver");
  const wb = (await ract(srv, ctx, "reasoning_status", b, { status: "withdrawn" })).body.record;
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, b.id);
  check((await p.locator(RSN + " #btn-carnet-rsn-delete").count()) === 0 && (await p.locator(RSN + ' [data-rsn="has-history"]').count()) === 1, "historical: no delete, reason shown");
  const refused = await ract(srv, ctx, "reasoning_delete", wb, { confirm: true });
  check(refused.status === 409 && refused.body.code === "reasoning_has_history", "API refuses: " + refused.body.code);
  await p.click(RSN + " #btn-carnet-rsn-back");
  await openDetail(p, a.id);
  await p.click(RSN + " #btn-carnet-rsn-delete");
  check(rsnFiles(srv).length === 2, "nothing deleted by the first click");
  await p.click(RSN + " #btn-carnet-rsn-delete-yes");
  await until(async () => rsnFiles(srv).length === 1, "deleted after explicit confirmation");
  check(rsnRecs(srv)[0].id === b.id, "the historical record is untouched");
});

scenario("11 corrupt record: listed apart and shown read-only, no action buttons, bytes preserved; the neighbour stays usable", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const good = await rcreate(srv, ctx, DEC, "Bonne décision");
  const bad = await rcreate(srv, ctx, DEC, "Décision à altérer");
  const f = path.join(rsnDir(srv), bad.id + ".json");
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.statement = "texte altéré";
  writeFileSync(f, JSON.stringify(raw));
  const bytes = readFileSync(f);
  await reopen(p);
  await openWorkspace(p);
  check((await p.locator(RSN + ' [data-rsn-group="unavailable"] [data-rsn-row]').count()) === 1, "corrupt record listed apart");
  await openDetail(p, bad.id).catch(() => null);
  await until(async () => (await p.locator(RSN + ' [data-rsn="corrupt"]').count()) === 1, "corrupt banner");
  check((await p.locator(RSN + " .carnet-rsn-actions button, " + RSN + " #btn-carnet-rsn-s-save").count()) === 0, "no action buttons");
  check(Buffer.compare(readFileSync(f), bytes) === 0, "bytes preserved");
  await p.click(RSN + " #btn-carnet-rsn-back");
  await openDetail(p, good.id);
  await p.fill(RSN + " #hq-carnet-rsn-statement", "Toujours utilisable");
  await p.click(RSN + " #btn-carnet-rsn-s-save");
  await until(async () => rsnRecs(srv).find((x) => x.id === good.id).statement === "Toujours utilisable", "the neighbour works");
});

scenario("12 batching: workspace = one list request, Reader panel = one related request, 'évaluer' = one resolve request per 25 historical rows; nothing per row", async () => {
  const { srv, ctx, p } = await rsnWorld();
  for (let i = 0; i < 30; i++) {
    const r = await rcreate(srv, ctx, DEC, "Décision " + i);
    await ract(srv, ctx, "reasoning_status", r, { status: "withdrawn" });
  }
  await reopen(p);
  const bag = [];
  rposts(p, bag);
  await openWorkspace(p);
  check(bag.filter((b) => b.action === "reasoning_list").length === 1 && bag.length === 1, "one list request: " + bag.map((b) => b.action).join(","));
  await p.click(RSN + " #btn-carnet-rsn-evaluate");
  await until(async () => bag.filter((b) => b.action === "reasoning_resolve").length === 2, "two resolve requests for 30 rows");
  check(bag.filter((b) => b.action === "reasoning_resolve").every((b) => (b.ids || []).length <= 25), "≤25 ids each");
  check(bag.length === 3, "nothing else was requested: " + bag.length);
});

scenario("13 offline: the list stays readable, every mutating control is aria-disabled and nothing is sent", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const d = await rcreate(srv, ctx, DEC, "Hors ligne");
  await reopen(p);
  await openWorkspace(p);
  await openDetail(p, d.id);
  await ctx.setOffline(true);
  const bag = [];
  rposts(p, bag);
  await p.evaluate(() => window.dispatchEvent(new Event("offline")));
  await p.fill(RSN + " #hq-carnet-rsn-statement", "Modifié hors ligne");
  await p.click(RSN + " #btn-carnet-rsn-s-save", { force: true });
  await until(async () => (await txt(p, RSN + " [data-rsn=error]")).includes("Hors ligne") || (await p.getAttribute(RSN + " #btn-carnet-rsn-s-save", "aria-disabled")) === "true", "offline refusal");
  await sleep(300);
  check(bag.length === 0, "nothing was sent: " + bag.length);
  check(rsnRecs(srv)[0].statement === "Hors ligne", "stored text unchanged");
  await ctx.setOffline(false);
});

scenario("14 iPhone profile: workspace, detail and the Reader panel fit the width, controls are tappable, no horizontal scroll", async () => {
  const { srv, ctx, p, ed } = await readerRsnWorld("iphone");
  await rcreate(srv, ctx, DEC, "Une décision assez longue pour passer à la ligne sur un écran étroit, avec un mot interminable : " + "x".repeat(60), { evidence: [sourceT(ed)] });
  await p.click(RP + "-toggle");
  await p.click(RP + "-workspace");
  await p.waitForSelector(RSN);
  await until(async () => (await p.locator(RSN + " .carnet-rsn-row").count()) === 1, "list");
  const m1 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.querySelector("#hq-carnet-rsn").scrollWidth, cw: document.querySelector("#hq-carnet-rsn").clientWidth, wide: [...document.querySelectorAll("#hq-carnet-rsn *")].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).slice(0, 5).map((e) => e.tagName + "." + e.className + "#" + e.id + ":" + e.scrollWidth + "/" + e.clientWidth), h: [...document.querySelectorAll("#hq-carnet-rsn button, #hq-carnet-rsn select")].map((b) => b.getBoundingClientRect().height) }));
  check(m1.sw <= m1.iw + 1 && m1.dw <= m1.cw + 1, "list: no horizontal overflow " + JSON.stringify({ sw: m1.sw, iw: m1.iw, dw: m1.dw, cw: m1.cw, wide: m1.wide }));
  check(m1.h.every((x) => x >= 40), "controls tall enough: min " + Math.min(...m1.h));
  const z = await p.evaluate(() => ({ reg: Number(getComputedStyle(document.querySelector("#hq-carnet-rsn")).zIndex), rd: Number(getComputedStyle(document.querySelector("#hq-carnet-reader")).zIndex) }));
  check(z.reg > z.rd, "the register opened from the Reader sits above it: " + JSON.stringify(z));
  await p.click(RSN + ' [data-rsn-act="view"]');
  await p.waitForSelector(RSN + " #hq-carnet-rsn-status");
  await sleep(300);
  const m2 = await p.evaluate(() => ({ dw: document.querySelector("#hq-carnet-rsn").scrollWidth, cw: document.querySelector("#hq-carnet-rsn").clientWidth, h: [...document.querySelectorAll("#hq-carnet-rsn button, #hq-carnet-rsn textarea")].map((b) => b.getBoundingClientRect().height) }));
  check(m2.dw <= m2.cw + 1, "detail: no horizontal overflow " + m2.dw + "/" + m2.cw);
  check(m2.h.every((x) => x >= 40), "detail controls tall enough: min " + Math.min(...m2.h));
  await shotEl(p, RSN, "14-iphone-detail");
});

scenario("15 reader panel expand: toggle semantics (aria-expanded/controls), keyboard operable, focus stays on the toggle", async () => {
  const { p } = await readerRsnWorld();
  await p.focus(RP + "-toggle");
  await p.keyboard.press("Enter");
  check((await p.getAttribute(RP + "-toggle", "aria-expanded")) === "true", "Enter expands");
  check((await p.getAttribute(RP + "-toggle", "aria-controls")) === "hq-carnet-reader-rsn-body" && (await p.locator(RP + "-body").count()) === 1, "aria-controls points at the body");
  check((await p.evaluate(() => document.activeElement.id)) === "hq-carnet-reader-rsn-toggle", "focus stays on the toggle");
  await p.keyboard.press("Space");
  check((await p.getAttribute(RP + "-toggle", "aria-expanded")) === "false", "Space collapses");
  check((await p.getAttribute(RP, "aria-labelledby")) === "hq-carnet-reader-rsn-h" && (await p.locator("#hq-carnet-reader-rsn-h").count()) === 1, "region labelled");
});

scenario("16 Ask never reads the register: a statement and a rationale are not evidence, search finds nothing, and Ask's fingerprint is unchanged", async () => {
  const { srv, ctx, p } = await rsnWorld();
  const ask = async (q) => (await cpost(srv, ctx, { action: "ask", question: q, scope: { kind: "project", id: "proj-1" } })).body;
  const before = await ask("banc");
  await rcreate(srv, ctx, DEC, "SECRET-ENONCE-XYZ banc", { rationale: "SECRET-JUSTIF-123 banc" });
  const after = await ask("banc");
  check(before.fingerprint === after.fingerprint, "Ask fingerprint unchanged");
  const hit = await ask("SECRET-ENONCE-XYZ");
  check(Array.isArray(hit.cards) && hit.cards.length === 0, "statement is not searchable evidence");
  const hit2 = await ask("SECRET-JUSTIF-123");
  check(Array.isArray(hit2.cards) && hit2.cards.length === 0, "rationale is not searchable evidence");
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
