// Phase 14 accessibility & device hardening suite (keyboard-only flows, modal-stack adversarial pins, 200% zoom, reduced motion, status accessibility + contrast, mobile).
//   P14_SHOTS=dir P14_OUT=file.json node tests/visual_carnet_a11y_playwright.mjs [scenario substring...]
//   P14_BROWSER=chromium|firefox|webkit (default chromium; only chromium is installed in the reference workspace).
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
  { const pw = require("playwright"); chromium = pw[process.env.P14_BROWSER || "chromium"]; }
} catch (_) {
  try {
    { const pw = createRequire("/opt/node22/lib/node_modules/")("playwright"); chromium = pw[process.env.P14_BROWSER || "chromium"]; }
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
const SHOTS = process.env.P14_SHOTS || "";
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
const outFile = process.env.P14_OUT || "";
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

// ---------------------------------------------------------------- Phase 14 helpers
const ENGINE = process.env.P14_BROWSER || "chromium";
const sigOf = `(a) => a ? ("@" + [...document.querySelectorAll("*")].indexOf(a) + a.tagName + (a.id ? "#" + a.id : "") + (a.getAttribute("data-rv") ? "[rv=" + a.getAttribute("data-rv") + "]" : "") + ((a.getAttribute("aria-label") || a.textContent || "").trim() ? ":" + (a.getAttribute("aria-label") || a.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 28) : "")) : "null"`;
// focus state that checks MORE than document.activeElement: painted, not inert, not aria-hidden, and inside the top modal when one is open
const focusState = (p) => p.evaluate((sigSrc) => {
  const sig = eval(sigSrc);
  const a = document.activeElement;
  const vis = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const M = window.HqCarnetModal;
  const st = M ? M.stack(document) : [];
  const top = st.length ? st[st.length - 1].node : null;
  const isBody = !a || a === document.body || a === document.documentElement;
  return {
    sig: sig(a), isBody,
    visible: !isBody && vis(a),
    inert: !!(a && a.closest && a.closest("[inert]")),
    ariaHidden: !!(a && a.closest && a.closest('[aria-hidden="true"]')),
    depth: st.length,
    topId: top ? top.id : null,
    insideTop: !top || (!!a && top.contains(a)),
    suspendedCount: st.filter((x) => x.suspended).length,
  };
}, sigOf);
const focusOk = (s) => !s.isBody && s.visible && !s.inert && !s.ariaHidden && s.insideTop;
const focusMsg = (s) => JSON.stringify(s);
const FOCUS_LOG = [];
const press = async (p, k) => { await p.keyboard.press(k); };
async function startFromTop(p) {
  await p.evaluate(() => { const a = document.activeElement; if (a && a !== document.body) a.blur(); window.scrollTo(0, 0); });
}
// keyboard-only reachability: press Tab (or Shift+Tab) until the focused element matches `sel`; every stop must be a valid focus target
async function tabTo(p, sel, opts = {}) {
  const max = opts.max || 150, rev = !!opts.reverse, trail = [];
  for (let i = 0; i <= max; i++) {
    const hit = await p.evaluate((q) => { const a = document.activeElement; return !!(a && a.matches && a.matches(q)); }, sel);
    if (hit) {
      const s = await focusState(p);
      if (!focusOk(s)) throw new Error(`FAIL: Tab reached ${sel} but it is not a valid focus target ${focusMsg(s)}`);
      FOCUS_LOG.push({ target: sel, steps: i, rev });
      return i;
    }
    await press(p, rev ? "Shift+Tab" : "Tab");
    const s = await focusState(p);
    trail.push(s.sig);
    if (s.depth > 0 && !focusOk(s)) throw new Error(`FAIL: focus moved to an invalid target while tabbing to ${sel}: ${focusMsg(s)} after [${trail.slice(-4).join(" > ")}]`);
  }
  throw new Error(`FAIL: ${sel} is unreachable by keyboard within ${max} ${rev ? "Shift+" : ""}Tab presses; last stops [${trail.slice(-5).join(" > ")}]`);
}
async function keyOpen(p, sel, key = "Enter", opts) {
  const n = await tabTo(p, sel, opts);
  await press(p, key);
  return n;
}
// full Tab cycle inside the active modal: forward sequence must wrap inside it and Shift+Tab must be the exact reverse
async function cycleCheck(p, msg) {
  const seq = [];
  for (let i = 0; i < 80; i++) {
    const s = await focusState(p);
    if (!focusOk(s)) throw new Error(`FAIL: ${msg}: invalid focus during forward cycle ${focusMsg(s)} after [${seq.slice(-3).join(" > ")}]`);
    if (seq.length && s.sig === seq[0] && i > 1) break;
    seq.push(s.sig);
    await press(p, "Tab");
  }
  const n = seq.length;
  check(n >= 1 && n < 80, `${msg}: forward Tab wraps inside the modal after ${n} stops`);
  const back = [];
  for (let i = 0; i < n; i++) {
    await press(p, "Shift+Tab");
    const s = await focusState(p);
    if (!focusOk(s)) throw new Error(`FAIL: ${msg}: invalid focus during reverse cycle ${focusMsg(s)}`);
    back.push(s.sig);
  }
  const expected = [seq[(n - 1) % n], ...seq.slice(0, n - 1).reverse()];
  check(back.join("|") === expected.join("|"), `${msg}: Shift+Tab visits the same ${n} stops in exact reverse order`);
  return seq;
}
// nothing of a closed surface may stay suspended / inert / aria-hidden behind it
const staleState = (p) => p.evaluate(() => {
  const M = window.HqCarnetModal;
  const depth = M ? M.depth(document) : 0;
  const q = (s) => [...document.querySelectorAll(s)].map((n) => n.tagName + "#" + n.id);
  return { depth, suspended: q("[data-carnet-suspended]"), inert: q("[inert]"), ariaHiddenDialogs: q('[role="dialog"][aria-hidden="true"],[aria-modal="true"][aria-hidden="true"]') };
});
const cleanWhenClosed = async (p, msg) => {
  const s = await staleState(p);
  check(s.depth === 0 && s.suspended.length === 0 && s.inert.length === 0 && s.ariaHiddenDialogs.length === 0, `${msg}: no stale suspension/inert/aria-hidden (${JSON.stringify(s)})`);
};
const dlgIds = async (p) => (await visibleDialogs(p)).map((d) => d.id);
const activeIs = (p, sel) => p.evaluate((q) => { const a = document.activeElement; return !!(a && a.matches && a.matches(q)); }, sel);
const REC_FLOW = {};
const recFlow = (k, v) => { REC_FLOW[k] = v; rec("kbd." + k, v); };
// ---------------------------------------------------------------- Phase 14 KEYBOARD-ONLY flows (no click after the page is loaded; opening Carnet itself is the precondition)
const CITE = '[data-carnet-block-id="block-c1"] [data-carnet-citation]';
async function kbdToReaderFromCitation(p, label) {
  await startFromTop(p);
  const n = await keyOpen(p, CITE, "Enter", { max: 400 });
  recFlow(label + ".tabsToCitation", n);
  await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
  check((await dlgIds(p)).join() === "hq-carnet-sources-layer", "Sources opened by Enter on the citation");
  await cycleCheck(p, label + " Sources");
  await keyOpen(p, "#btn-carnet-src-reader");
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  await one(p, "hq-carnet-reader", label + " Reader over Sources");
}
const expanded = (p, sel) => p.evaluate((q) => (document.querySelector(q) || {}).getAttribute ? document.querySelector(q).getAttribute("aria-expanded") : null, sel);

scenario("KBD 1 desktop: page → citation → Sources → Reader → verification workspace → back", async () => {
  const { p } = await seed("desktop");
  await kbdToReaderFromCitation(p, "F1");
  recFlow("F1.reader.cycle", await cycleCheck(p, "Reader, secondary panels collapsed"));
  check((await expanded(p, VP + "-toggle")) === "false", "verification panel starts collapsed (aria-expanded=false)");
  await keyOpen(p, VP + "-toggle", "Enter");
  check((await expanded(p, VP + "-toggle")) === "true", "Enter expands the verification panel");
  await keyOpen(p, VP + "-toggle", " ");
  check((await expanded(p, VP + "-toggle")) === "false", "Space collapses it again");
  await keyOpen(p, VP + "-toggle", "Enter");
  await keyOpen(p, VP + "-workspace", "Enter");
  await p.waitForSelector(VER, { state: "visible" });
  await sleep(300);
  await one(p, "hq-carnet-ver", "workspace over Reader");
  recFlow("F1.ver.cycle", await cycleCheck(p, "verification workspace"));
  await press(p, "Escape");
  await sleep(200);
  await one(p, "hq-carnet-reader", "Escape 1");
  check(await activeIs(p, VP + "-workspace"), "focus is back on the exact workspace opener (valid, visible, not inert)");
  check(focusOk(await focusState(p)), "that focus target is valid");
  await press(p, "Escape");
  await sleep(200);
  await one(p, "hq-carnet-sources-layer", "Escape 2 resumes Sources");
  check(focusOk(await focusState(p)), "focus inside resumed Sources is valid");
  await press(p, "Escape");
  await sleep(200);
  check(await p.evaluate(() => !!document.activeElement.closest("[data-carnet-citation]")), "Escape 3 returns focus to the citation");
  await cleanWhenClosed(p, "after the whole flow");
});

scenario("KBD 2 desktop: Plus toolbar → Review Pack → item → Reader → exact item; Ask → logical opener", async () => {
  const { p } = await seed("desktop");
  await startFromTop(p);
  await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 });
  await p.waitForSelector("#carnet-quick-tools", { state: "visible" });
  await keyOpen(p, "#btn-carnet-reviews", "Enter");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await one(p, "hq-carnet-rv", "Review Pack");
  await cycleCheck(p, "Review Pack list");
  await keyOpen(p, '[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await keyOpen(p, '[data-rv-tab="evidence"]');
  await sleep(250);
  recFlow("F2.pack.cycle", await cycleCheck(p, "Review Pack evidence tab"));
  await keyOpen(p, '[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  await one(p, "hq-carnet-reader", "Reader over Review Pack");
  recFlow("F2.reader.cycle", await cycleCheck(p, "Reader frozen from pack"));
  await press(p, "Escape");
  await sleep(250);
  await one(p, "hq-carnet-rv", "pack resumed");
  check(await activeIs(p, '[data-rv="open-reader"]') && focusOk(await focusState(p)), "exact originating item focused, valid target");
  await keyOpen(p, '[data-rv-tab="questions"]');
  await sleep(200);
  await keyOpen(p, '[data-rv="q-ask"]');
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  await sleep(250);
  await one(p, "hq-carnet-ask", "Ask");
  recFlow("F2.ask.cycle", await cycleCheck(p, "Ask"));
  await press(p, "Escape");
  await sleep(250);
  check(await activeIs(p, "#btn-carnet-reviews") && focusOk(await focusState(p)), "Ask returned focus to the Revues tool (valid)");
  await cleanWhenClosed(p, "after Ask");
});

scenario("KBD 3 desktop: Reader → register panel → workspace → back", async () => {
  const { p } = await seed("desktop");
  await kbdToReaderFromCitation(p, "F3");
  await keyOpen(p, RP + "-toggle", "Enter");
  check((await expanded(p, RP + "-toggle")) === "true", "register panel expands by keyboard");
  await keyOpen(p, RP + "-workspace", "Enter");
  await p.waitForSelector(RSN, { state: "visible" });
  await sleep(300);
  await one(p, "hq-carnet-rsn", "register over Reader");
  recFlow("F3.rsn.cycle", await cycleCheck(p, "register workspace"));
  await press(p, "Escape");
  await sleep(200);
  await one(p, "hq-carnet-reader", "Escape 1");
  check(await activeIs(p, RP + "-workspace") && focusOk(await focusState(p)), "focus back on the register opener, valid");
});

scenario("KBD 4 desktop: frozen proof → metadata → related verification panel → back", async () => {
  const { p } = await seed("desktop");
  await startFromTop(p);
  await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 });
  await keyOpen(p, "#btn-carnet-reviews", "Enter");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await keyOpen(p, '[data-rv="open"]');
  await keyOpen(p, '[data-rv-tab="evidence"]');
  await sleep(250);
  await keyOpen(p, '[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader");
  await painted(p);
  const meta = "#hq-carnet-reader-meta";
  const had = await p.evaluate((s) => document.querySelector(s).open, meta);
  await keyOpen(p, meta + " > summary", "Enter");
  const now = await p.evaluate((s) => document.querySelector(s).open, meta);
  check(had !== now, "Enter on the metadata summary toggles it (" + had + " → " + now + ")");
  await keyOpen(p, VP + "-toggle", "Enter");
  check((await expanded(p, VP + "-toggle")) === "true", "related verifications reachable and expandable by keyboard");
  recFlow("F4.reader.cycle", await cycleCheck(p, "frozen Reader with panel open"));
  await press(p, "Escape");
  await sleep(200);
  await one(p, "hq-carnet-rv", "pack after Reader");
});

scenario("KBD 5 phone: the same keyboard flow at 390×844 and 430×932, toolbar rows keep focus on screen", async () => {
  for (const prof of ["iphone", "iphone430"]) {
    const { p } = await seed(prof);
    await kbdToReaderFromCitation(p, "F5." + prof);
    await keyOpen(p, "#hq-carnet-reader-ann-toggle", "Enter");
    await keyOpen(p, VP + "-toggle", "Enter");
    check((await expanded(p, "#hq-carnet-reader-ann-toggle")) === "false", prof + ": opening a second panel closed the first (one dominates on phone)");
    await press(p, "Escape");
    await sleep(200);
    await press(p, "Escape");
    await sleep(200);
    await cleanWhenClosed(p, prof + " after Reader");
    // toolbar: every action reachable by Tab, each one scrolled fully into the device width
    await startFromTop(p);
    await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 });
    await p.waitForSelector("#carnet-quick-tools", { state: "visible" });
    const ids = await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools button")].map((b) => b.id || b.getAttribute("data-carnet-symbol") || b.className));
    await p.focus("#carnet-quick-tools button");
    const offscreen = [];
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await sleep(350); // let a (possibly smooth) focus scroll finish before measuring: a mid-scroll rect is a harness artefact, not a defect
      const st = await p.evaluate(() => { const a = document.activeElement; if (!a || !a.closest("#carnet-quick-tools")) return null; const r = a.getBoundingClientRect(); return { id: a.id || a.getAttribute("data-carnet-symbol") || a.className, left: Math.round(r.left), right: Math.round(r.right), dw: screen.width }; });
      if (!st) break;
      seen.push(st.id);
      if (st.left < -1 || st.right > st.dw + 1) offscreen.push(st);
      await press(p, "Tab");
    }
    check(seen.join("|") === ids.join("|"), prof + ": Tab reaches all " + ids.length + " toolbar actions, in DOM order, no focus trap");
    check(offscreen.length === 0, prof + ": every focused toolbar action is scrolled fully on screen " + JSON.stringify(offscreen.slice(0, 3)));
    await noOverflow(p, prof + " toolbar after keyboard scrolling");
    // reverse
    const rseen = [];
    for (let i = 0; i < 40; i++) {
      await press(p, "Shift+Tab");
      const id = await p.evaluate(() => { const a = document.activeElement; return a && a.closest("#carnet-quick-tools") ? (a.id || a.getAttribute("data-carnet-symbol") || a.className) : null; });
      if (id === null) break;
      rseen.push(id);
    }
    check(rseen.length === ids.length - 1 || rseen.length === ids.length, prof + ": Shift+Tab walks the toolbar back (" + rseen.length + " stops) and leaves it");
  }
});

// ---------------------------------------------------------------- Phase 14 modal stack, adversarial (real HqCarnetModal, synthetic surfaces)
const SYN = `
  const M = window.HqCarnetModal, d = document;
  const mk = (id, html, css) => { const n = d.createElement("div"); n.id = id; n.style.cssText = "position:fixed;inset:0;overflow:auto;background:#fff;z-index:9999;" + (css || ""); n.innerHTML = html; d.body.appendChild(n); return n; };
  const inv = () => { const st = M.stack(d); return { depth: st.length, active: st.filter((x) => !x.suspended).length, topActive: st.length ? !st[st.length - 1].suspended : true, attrsMatch: st.every((x) => x.suspended === x.node.hasAttribute("data-carnet-suspended") && x.suspended === !!x.node.inert) }; };
  const clean = (n) => !n.hasAttribute("data-carnet-suspended") && !n.hasAttribute("aria-hidden") && !n.inert && !n.hasAttribute("inert");
`;
const syn = (p, body, arg) => p.evaluate(new Function("arg", "return (async () => {" + SYN + body + "})()"), arg);

scenario("MODAL parent → child: A suspended but kept, inert, hidden; only B active; A restored intact with exact opener", async () => {
  const { p } = await seed("desktop");
  const r = await syn(p, `
    const A = mk("t-a", '<div style="height:2400px"><button id="t-a-open">open B</button></div><button id="t-a-last">last</button>');
    const B = mk("t-b", '<button id="t-b-x">x</button>');
    const opener = d.getElementById("t-a-open");
    const ha = M.open(d, A, { keep: true, layer: "workspace" });
    A.scrollTop = 321; opener.focus();
    const hb = M.open(d, B, { trigger: opener, layer: "nested" });
    const o = {};
    o.inDom = d.body.contains(A);
    o.suspendedAttrs = A.hasAttribute("data-carnet-suspended") && A.inert && A.getAttribute("aria-hidden") === "true";
    o.aPaintedHidden = getComputedStyle(A).visibility === "hidden";
    o.onlyBActive = inv().active === 1 && inv().topActive && !B.inert && B.getAttribute("aria-hidden") === null;
    o.focusInB = B.contains(d.activeElement);
    o.aRoleDialog = A.getAttribute("role") === "dialog" && A.getAttribute("aria-modal") === "true";
    const ok = hb.close(true);
    o.closeOk = ok; o.scrollKept = A.scrollTop; o.exactOpener = d.activeElement === opener; o.resumed = clean(A); o.inv = inv();
    ha.close(false); A.remove();
    return o;`);
  check(r.inDom && r.suspendedAttrs && r.aPaintedHidden, "A stays in the DOM, inert + aria-hidden + painted hidden while B is open: " + JSON.stringify(r));
  check(r.onlyBActive && r.focusInB && r.aRoleDialog, "only B is active, focus is inside B, dialog semantics present");
  check(r.closeOk && r.exactOpener && r.resumed && r.scrollKept === 321 && r.inv.depth === 1, "closing B restores A unchanged: exact opener focused, scrollTop 321, no stale attributes");
});

scenario("MODAL reuse: A → B → close B → reopen B → close B → close A → reopen A, repeated, no stale state", async () => {
  const { p } = await seed("desktop");
  const r = await syn(p, `
    const A = mk("t-a", '<button id="t-a-btn">a</button>');
    const B = mk("t-b", '<button id="t-b-btn">b</button>');
    const o = { bad: [] };
    for (let i = 0; i < 6; i++) {
      let ha = M.open(d, A, { keep: true, layer: "workspace" });
      let hb = M.open(d, B, { keep: true, layer: "nested" });
      if (!(A.inert && !B.inert)) o.bad.push(i + ":open-state");
      hb.close(true);
      if (!clean(A)) o.bad.push(i + ":A-not-resumed");
      hb = M.open(d, B, { keep: true, layer: "nested" });
      if (!(A.inert && clean(B))) o.bad.push(i + ":reopen-B-state");
      hb.close(false);
      ha.close(false);
      if (!(clean(A) && clean(B) && M.depth(d) === 0)) o.bad.push(i + ":after-close " + JSON.stringify(inv()));
      ha = M.open(d, A, { keep: true, layer: "workspace" });
      if (!(clean(A) && A.contains(d.activeElement))) o.bad.push(i + ":reopen-A-not-active");
      ha.close(false);
    }
    o.cssZ = [A, B].map((n) => n.getAttribute("data-carnet-layer"));
    A.remove(); B.remove();
    return o;`);
  check(r.bad.length === 0, "6 full A/B reuse cycles leave no stale inert/aria-hidden/suspension/focus guard: " + JSON.stringify(r.bad));
});

scenario("MODAL edge cases: removed opener, disabled opener, parent closed programmatically under a child", async () => {
  const { p } = await seed("desktop");
  const r = await syn(p, `
    const o = {};
    // removed opener
    let A = mk("t-a", '<button id="t-a-btn">a</button><button id="t-a-open">open</button>');
    let B = mk("t-b", '<button id="t-b-btn">b</button>');
    let ha = M.open(d, A, { keep: true });
    const t = d.getElementById("t-a-open"); t.focus();
    let hb = M.open(d, B, { trigger: t });
    t.remove();
    o.removedClose = hb.close(true);
    o.removedFocusValid = A.contains(d.activeElement) && clean(A);
    ha.close(false); A.remove(); B.remove();
    // disabled opener
    A = mk("t-a", '<button id="t-a-btn">a</button><button id="t-a-open">open</button>');
    B = mk("t-b", '<button id="t-b-btn">b</button>');
    ha = M.open(d, A, { keep: true });
    const t2 = d.getElementById("t-a-open"); t2.focus();
    hb = M.open(d, B, { trigger: t2 });
    t2.disabled = true;
    o.disabledClose = hb.close(true);
    o.disabledFocusValid = A.contains(d.activeElement) && clean(A);
    ha.close(false); A.remove(); B.remove();
    // top-level modal whose opener vanished: must not throw, must not leave anything behind
    A = mk("t-a", '<button>a</button>');
    const out = d.createElement("button"); out.id = "t-out"; d.body.appendChild(out); out.focus();
    ha = M.open(d, A, { trigger: out });
    out.remove();
    let threw = false; try { o.topNoOpener = ha.close(true); } catch (e) { threw = String(e); }
    o.topNoOpenerThrew = threw; o.topClean = M.depth(d) === 0;
    // parent closed programmatically while a child exists
    A = mk("t-a", '<button id="t-a-btn">a</button>'); B = mk("t-b", '<button id="t-b-btn">b</button>');
    ha = M.open(d, A, { keep: true }); hb = M.open(d, B, {});
    ha.close(false);
    o.afterParentClose = inv(); o.bStillActive = !B.inert && B.contains(d.activeElement);
    o.aClean = clean(A);
    hb.close(false);
    o.final = inv();
    A.remove(); return o;`);
  check(r.removedClose === false && r.removedFocusValid, "opener removed before close: close reports false, focus lands in the resumed parent (valid), no stale attrs: " + JSON.stringify(r));
  check(r.disabledClose === false && r.disabledFocusValid, "opener disabled before close: same fallback, parent active");
  check(r.topNoOpenerThrew === false && r.topClean, "top-level modal with a vanished opener closes without throwing and leaves nothing: " + JSON.stringify([r.topNoOpener, r.topNoOpenerThrew]));
  check(r.afterParentClose.depth === 1 && r.afterParentClose.topActive && r.bStillActive && r.aClean && r.final.depth === 0, "parent closed programmatically under a child: child stays the single active surface, parent node clean");
});

scenario("MODAL repeated Escape, rapid open/close, focus guard released, nested stack cycles", async () => {
  const { p } = await seed("desktop");
  // Escape x5 over two real keyboard-driven modals
  await syn(p, `
    const out = d.createElement("button"); out.id = "t-out"; out.textContent = "out"; d.body.appendChild(out); out.focus();
    const A = mk("t-a", '<button id="t-a-btn">a</button>'); const B = mk("t-b", '<button id="t-b-btn">b</button>');
    window.__ha = M.open(d, A, { trigger: out, onEscape: () => window.__ha.close(true) });
    window.__hb = M.open(d, B, { trigger: d.getElementById("t-a-btn"), onEscape: () => window.__hb.close(true) });
    return 1;`);
  for (let i = 0; i < 5; i++) await press(p, "Escape");
  const esc = await p.evaluate(() => ({ depth: window.HqCarnetModal.depth(document), focus: document.activeElement.id, left: !!document.getElementById("t-a") || !!document.getElementById("t-b") }));
  check(esc.depth === 0 && esc.focus === "t-out" && !esc.left, "5 Escapes close child then parent, extra Escapes do nothing, focus ends on the original opener " + JSON.stringify(esc));
  const r = await syn(p, `
    const o = { bad: [] };
    const A = mk("t-a2", '<button>a</button>'); const B = mk("t-b2", '<button>b</button>');
    for (let i = 0; i < 100; i++) {
      const ha = M.open(d, A, { keep: true }); const hb = M.open(d, B, { keep: true });
      if (i % 2) { hb.close(true); ha.close(true); } else { ha.close(false); hb.close(false); }
    }
    o.cleanAB = clean(A) && clean(B); o.depth = M.depth(d);
    const inp = d.createElement("input"); d.body.appendChild(inp); inp.focus();
    o.guardReleased = d.activeElement === inp;
    // nested cycles A -> B -> C with every close order
    const C = mk("t-c2", '<button>c</button>');
    const orders = [["C","B","A"],["B","C","A"],["A","C","B"],["A","B","C"],["B","A","C"],["C","A","B"]];
    for (const ord of orders) {
      const h = { A: M.open(d, A, { keep: true }), B: M.open(d, B, { keep: true }), C: M.open(d, C, { keep: true }) };
      let i0 = inv(); if (!(i0.active === 1 && i0.topActive && i0.attrsMatch)) o.bad.push(ord.join("") + ":open " + JSON.stringify(i0));
      for (const k of ord) {
        h[k].close(false);
        const iv = inv();
        if (iv.depth > 0 && !(iv.active === 1 && iv.topActive && iv.attrsMatch)) o.bad.push(ord.join("") + ":after-" + k + " " + JSON.stringify(iv));
      }
      if (!(clean(A) && clean(B) && clean(C) && M.depth(d) === 0)) o.bad.push(ord.join("") + ":final");
    }
    [A, B, C, inp].forEach((n) => n.remove());
    return o;`);
  check(r.cleanAB && r.depth === 0 && r.guardReleased, "100 rapid open/close cycles: nodes clean, depth 0, and focus is free again (focus guard released): " + JSON.stringify([r.cleanAB, r.depth, r.guardReleased]));
  check(r.bad.length === 0, "nested A→B→C in all six close orders keeps exactly one active top surface and consistent attributes: " + JSON.stringify(r.bad));
});

scenario("MODAL real surfaces: Reader/Review Pack/History reopened 5× by keyboard leave nothing suspended or inert", async () => {
  const { p } = await seed("desktop");
  for (let i = 0; i < 5; i++) {
    await startFromTop(p);
    await keyOpen(p, CITE, "Enter", { max: 400 });
    await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
    await keyOpen(p, "#btn-carnet-src-reader");
    await p.waitForSelector("#hq-carnet-reader");
    await painted(p);
    await press(p, "Escape"); await sleep(120);
    await press(p, "Escape"); await sleep(120);
    await cleanWhenClosed(p, "Reader cycle " + (i + 1));
  }
  for (const [btn, dlg] of [["#btn-carnet-reviews", "#hq-carnet-rv"], ["#btn-carnet-history", "#hq-carnet-hx"], ["#btn-carnet-intel", "#hq-carnet-intel"]]) {
    for (let i = 0; i < 3; i++) {
      await startFromTop(p);
      if (await p.locator("#carnet-quick-tools").isHidden()) await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 });
      await keyOpen(p, btn, "Enter", { max: 400 });
      await p.waitForSelector(dlg, { state: "visible" });
      check(focusOk(await focusState(p)), btn + " opened by keyboard puts focus in a valid place (cycle " + (i + 1) + ")");
      await press(p, "Escape"); await sleep(150);
      check(await activeIs(p, btn), btn + ": Escape returns focus to the exact tool button");
      await cleanWhenClosed(p, btn + " cycle " + (i + 1));
    }
  }
});

// ---------------------------------------------------------------- focus must survive a re-render inside a modal (activating a tab / opening a row / going back)
const settled = async (p) => { await sleep(250); return focusState(p); };
async function openToolKbd(p, btn, dlg) {
  await startFromTop(p);
  if (await p.locator("#carnet-quick-tools").isHidden()) await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 });
  await keyOpen(p, btn, "Enter", { max: 400 });
  await p.waitForSelector(dlg, { state: "visible" });
  await sleep(300);
}
scenario("KBD focus survives re-render: Review Pack, History, Cockpit tabs; verification and register list ↔ detail", async () => {
  const { p, ver, dec } = await seed("desktop");
  const bad = [];
  const soft = (c, m) => { if (c) { passed += 1; console.log("  OK   " + m); } else { bad.push(m); console.log("  BAD  " + m); } };
  // Review Pack tabs
  await openToolKbd(p, "#btn-carnet-reviews", "#hq-carnet-rv");
  await keyOpen(p, '[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  for (const t of ["overview", "evidence", "checklist", "questions", "freshness", "report"]) {
    await keyOpen(p, `[data-rv-tab="${t}"]`);
    const s = await settled(p);
    soft(focusOk(s), `Review Pack tab ${t}: focus is a valid target after the re-render ${focusMsg(s)}`);
    soft(await activeIs(p, `[data-rv-tab="${t}"]`), `Review Pack tab ${t}: focus stays on the tab just activated`);
  }
  await press(p, "Escape"); await sleep(250);
  soft((await staleState(p)).depth === 0, "Escape closes the surface (focus was left wherever the last activation put it)");
  if ((await staleState(p)).depth > 0) await closeAll(p); // harness clean-up only, after the violation above was recorded
  // History tabs
  await openToolKbd(p, "#btn-carnet-history", "#hq-carnet-hx");
  const hxTabs = await p.evaluate(() => [...document.querySelectorAll("[data-hx-tab]")].map((b) => b.getAttribute("data-hx-tab")));
  for (const t of hxTabs) {
    await keyOpen(p, `[data-hx-tab="${t}"]`);
    const s = await settled(p);
    soft(focusOk(s) && (await activeIs(p, `[data-hx-tab="${t}"]`)), `History tab ${t}: focus valid and stays on the tab ${focusMsg(s)}`);
  }
  await press(p, "Escape"); await sleep(250);
  soft((await staleState(p)).depth === 0, "Escape closes the surface (focus was left wherever the last activation put it)");
  if ((await staleState(p)).depth > 0) await closeAll(p); // harness clean-up only, after the violation above was recorded
  // Cockpit tabs
  await openToolKbd(p, "#btn-carnet-intel", "#hq-carnet-intel");
  const ixTabs = await p.evaluate(() => [...document.querySelectorAll("[data-ix-tab]")].map((b) => b.getAttribute("data-ix-tab")));
  for (const t of ixTabs) {
    await keyOpen(p, `[data-ix-tab="${t}"]`);
    const s = await settled(p);
    soft(focusOk(s) && (await activeIs(p, `[data-ix-tab="${t}"]`)), `Cockpit tab ${t}: focus valid and stays on the tab ${focusMsg(s)}`);
  }
  await press(p, "Escape"); await sleep(250);
  soft((await staleState(p)).depth === 0, "Escape closes the surface (focus was left wherever the last activation put it)");
  if ((await staleState(p)).depth > 0) await closeAll(p); // harness clean-up only, after the violation above was recorded
  // verification workspace: list -> detail -> back
  await openToolKbd(p, "#btn-carnet-verifications", VER);
  await keyOpen(p, `${VER} [data-ver-act="view"][data-id="${ver.id}"]`);
  let s = await settled(p);
  soft(focusOk(s), `verification detail opened by keyboard: focus is valid ${focusMsg(s)}`);
  await keyOpen(p, "#btn-carnet-ver-back");
  s = await settled(p);
  soft(focusOk(s), `back to the verification list: focus is valid ${focusMsg(s)}`);
  rec("kbd.ver.backFocusExactRow", await activeIs(p, `${VER} [data-ver-act="view"][data-id="${ver.id}"]`));
  await press(p, "Escape"); await sleep(250);
  soft((await staleState(p)).depth === 0, "Escape closes the surface (focus was left wherever the last activation put it)");
  if ((await staleState(p)).depth > 0) await closeAll(p); // harness clean-up only, after the violation above was recorded
  // register: list -> detail -> back
  await openToolKbd(p, "#btn-carnet-reasoning", RSN);
  await until(async () => (await p.locator(RSN + " [data-rsn-act=view]").count()) > 0, "register rows loaded");
  await keyOpen(p, `${RSN} [data-rsn-act="view"][data-id="${dec.id}"]`);
  s = await settled(p);
  soft(focusOk(s), `register detail opened by keyboard: focus is valid ${focusMsg(s)}`);
  await keyOpen(p, "#btn-carnet-rsn-back");
  s = await settled(p);
  soft(focusOk(s), `back to the register list: focus is valid ${focusMsg(s)}`);
  rec("kbd.rsn.backFocusExactRow", await activeIs(p, `${RSN} [data-rsn-act="view"][data-id="${dec.id}"]`));
  check(bad.length === 0, "no lost focus after a re-render: " + bad.length + " violation(s): " + bad.map((x) => x.slice(0, 90)).join(" || "));
});


// ---------------------------------------------------------------- reduced motion: the two real motion sources of the notebook (page flip, block reveal pulse)
for (const [prof, reduce] of [["desktopRM", true], ["desktopNP", false]]) {
  scenario(`REDUCED MOTION behaviour (${reduce ? "reduce" : "no-preference"}): page flip ghost and block reveal (scroll behaviour + pulse animation)`, async () => {
    const { p } = await seed(prof);
    await p.evaluate(() => { window.__p14Scroll = []; const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (a) { window.__p14Scroll.push(a && a.block === "center" ? a.behavior : "other"); return o.apply(this, arguments); }; });
    // block reveal from the page outline (revealBlock: scrollIntoView + pulse), by keyboard
    await keyOpen(p, "#btn-carnet-outline", "Enter", { max: 400 });
    await sleep(250);
    const hasOutline = await p.evaluate(() => !!document.querySelector("[data-carnet-outline-id]"));
    rec(`reducedMotion.reveal.${prof}.hasOutline`, hasOutline);
    check(hasOutline, "the page outline offers entries to jump to");
    await p.evaluate(() => { window.__p14Pulse = null; new MutationObserver((ms) => { for (const m of ms) if (m.type === "attributes" && m.target.hasAttribute && m.target.hasAttribute("data-carnet-pulse") && !window.__p14Pulse) { const cs = getComputedStyle(m.target); window.__p14Pulse = cs.animationName + "/" + cs.animationDuration; } }).observe(document.body, { attributes: true, attributeFilter: ["data-carnet-pulse"], subtree: true }); });
    await keyOpen(p, "[data-carnet-outline-id]", "Enter", { max: 400 });
    await sleep(250);
    const r = await p.evaluate(() => ({ behaviours: window.__p14Scroll, pulse: !!window.__p14Pulse, anim: window.__p14Pulse }));
    rec(`reducedMotion.reveal.${prof}`, r);
    check(r.pulse, "the revealed block carries the pulse marker");
    r.behaviours = r.behaviours.filter((b) => b !== "other"); // only revealBlock scrolls (block:center); the focus-reveal helper uses block:nearest and is always instant
    check(r.behaviours.length > 0 && r.behaviours.every((b) => b === (reduce ? "auto" : "smooth")), `${reduce ? "reduce" : "no-preference"}: scrollIntoView behaviour is ${reduce ? "auto (instant)" : "smooth"} [${r.behaviours.join(",")}]`);
    check(reduce ? /^none/.test(r.anim) : !/^none/.test(r.anim), reduce ? "reduce: the reveal pulse has no animation (static outline instead) " + r.anim : "no-preference: the reveal pulse animates " + r.anim);
    // page flip by keyboard: the 3D ghost must not exist under reduce; under no-preference it exists and carries an animation
    await p.evaluate(() => { const b = document.getElementById("btn-carnet-next"); window.__p14Ghost = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains("carnet-page-ghost")) window.__p14Ghost.push(getComputedStyle(n).animationName + "/" + getComputedStyle(n).animationDuration); }).observe(document.querySelector(".carnet-paper") || document.body, { childList: true, subtree: true }); return !!b; });
    // a second page is created by keyboard, then Page précédente flips back: the flip is exercised, never skipped
    await keyOpen(p, "#btn-carnet-new", "Enter", { max: 400 });
    await sleep(500);
    const prevEnabled = await p.evaluate(() => { const b = document.getElementById("btn-carnet-prev"); return !!b && !b.disabled; });
    check(prevEnabled, "a second page exists, so a page flip can be exercised");
    await p.evaluate(() => { window.__p14Ghost.length = 0; });
    {
      await keyOpen(p, "#btn-carnet-prev", "Enter", { max: 400 });
      await sleep(120);
      const g = await p.evaluate(() => window.__p14Ghost);
      rec(`reducedMotion.flip.${prof}`, g);
      check(reduce ? g.length === 0 : g.length === 1 && !/^none/.test(g[0]), reduce ? "reduce: no page-flip ghost is created at all" : "no-preference: the page flip animates (" + g.join(",") + ") — proves the check can see motion");
    }
  });
}

// ---------------------------------------------------------------- shared audits: focus visibility (clipped by a scroller / covered by fixed UI), used at 200 % zoom and on phones
PROFILES.zoom200 = { viewport: { width: 683, height: 450 }, deviceScaleFactor: 2 }; // 1366×900 at 200 % browser zoom = 683×450 CSS px with 2 device px per CSS px
PROFILES.desktopRM = { viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" };
PROFILES.desktopNP = { viewport: { width: 1366, height: 900 }, reducedMotion: "no-preference" };
PROFILES.iphoneRM = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, reducedMotion: "reduce" };
PROFILES.desktopLight = { viewport: { width: 1366, height: 900 }, colorScheme: "light" };
PROFILES.desktopDark = { viewport: { width: 1366, height: 900 }, colorScheme: "dark" };

// metrics of the focused element: how much of it is really visible (viewport ∩ every clipping ancestor) and whether something else sits on top of it
const stopMetrics = (p) => p.evaluate((sigSrc) => {
  const sig = eval(sigSrc);
  const a = document.activeElement;
  if (!a || a === document.body) return { sig: "BODY", zero: true, frac: 0, covered: false };
  const r = a.getBoundingClientRect();
  const W = Math.min(innerWidth, screen.width), H = innerHeight;
  let x1 = Math.max(0, r.left), y1 = Math.max(0, r.top), x2 = Math.min(W, r.right), y2 = Math.min(H, r.bottom);
  for (let n = a.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const b = n.getBoundingClientRect();
      if (cs.overflowX !== "visible") { x1 = Math.max(x1, b.left); x2 = Math.min(x2, b.right); }
      if (cs.overflowY !== "visible") { y1 = Math.max(y1, b.top); y2 = Math.min(y2, b.bottom); }
    }
  }
  const area = r.width * r.height;
  const vis = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  let covered = false;
  if (vis > 0) {
    const t = document.elementFromPoint((x1 + x2) / 2, (y1 + y2) / 2);
    covered = !(t && (t === a || a.contains(t) || t.contains(a)));
  }
  return { sig: sig(a), zero: area === 0, frac: area ? vis / area : 0, covered, w: Math.round(r.width), h: Math.round(r.height) };
}, sigOf);

// Tab once around the active surface; every stop must be (nearly) fully visible and not covered. `leave` = stop when focus leaves rootSel instead of wrapping.
async function tabAudit(p, rootSel, opts = {}) {
  const bad = [], seen = [];
  const settle = opts.settle || 140;
  for (let i = 0; i < (opts.max || 90); i++) {
    await sleep(settle);
    const m = await stopMetrics(p);
    const inRoot = await p.evaluate((q) => { const a = document.activeElement; const r = document.querySelector(q); return !!(a && r && r.contains(a)); }, rootSel);
    if (opts.leave && !inRoot) break;
    if (!inRoot && !opts.leave) { bad.push(`focus left ${rootSel}: ${m.sig}`); break; }
    if (seen.includes(m.sig) && !opts.leave) break;
    seen.push(m.sig);
    if (m.zero || m.frac < 0.98 || m.covered) bad.push(`${m.sig} visible=${(m.frac * 100).toFixed(0)}%${m.covered ? " COVERED" : ""}${m.zero ? " ZERO-AREA" : ""}`);
    await press(p, "Tab");
  }
  return { stops: seen.length, bad };
}
const closeRect = (p, sel) => p.evaluate((q) => { const b = document.querySelector(q); if (!b) return null; const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, W: Math.min(innerWidth, screen.width), H: innerHeight }; }, sel);
const insideViewport = (r) => !!r && r.l >= -0.5 && r.t >= -0.5 && r.r <= r.W + 0.5 && r.b <= r.H + 0.5;
const pageOverflow = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, W: Math.min(innerWidth, screen.width) }));

// open / close each critical surface by keyboard only
const SURFACES = {
  toolbar: { root: "#carnet-quick-tools", close: null, open: async (p) => { if (await p.locator("#carnet-quick-tools").isHidden()) { await startFromTop(p); await keyOpen(p, "#btn-carnet-more", "Enter", { max: 400 }); } await p.waitForSelector("#carnet-quick-tools", { state: "visible" }); await p.focus("#carnet-quick-tools button"); } },
  sources: { root: "#hq-carnet-sources-layer", close: "#btn-carnet-src-close", open: async (p) => { await startFromTop(p); await keyOpen(p, CITE, "Enter", { max: 400 }); await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" }); } },
  reader: { root: "#hq-carnet-reader", close: "#btn-carnet-reader-close", open: async (p) => { await SURFACES.sources.open(p); await keyOpen(p, "#btn-carnet-src-reader"); await p.waitForSelector("#hq-carnet-reader"); await painted(p); }, closeKeys: 2 },
  ver: { root: VER, close: "#btn-carnet-ver-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-verifications", VER); } },
  rsn: { root: RSN, close: "#btn-carnet-rsn-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-reasoning", RSN); } },
  rv: { root: "#hq-carnet-rv", close: "#btn-carnet-rv-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-reviews", "#hq-carnet-rv"); await keyOpen(p, '[data-rv="open"]'); await p.waitForSelector("#hq-carnet-rv-name"); await keyOpen(p, '[data-rv-tab="evidence"]'); await sleep(300); } },
  ask: { root: "#hq-carnet-ask", close: "#btn-carnet-ask-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-ask", "#hq-carnet-ask"); } },
  hx: { root: "#hq-carnet-hx", close: "#btn-carnet-hx-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-history", "#hq-carnet-hx"); } },
  intel: { root: "#hq-carnet-intel", close: "#btn-carnet-ix-close", open: async (p) => { await openToolKbd(p, "#btn-carnet-intel", "#hq-carnet-intel"); } },
};
async function leaveSurface(p, s) {
  for (let i = 0; i < (s.closeKeys || 1); i++) { await press(p, "Escape"); await sleep(200); }
  if ((await staleState(p)).depth > 0) await closeAll(p); // harness clean-up; any non-closing Escape was already asserted by the caller
}

async function auditSurfaces(p, label, names, ref) {
  const out = {};
  for (const n of names) {
    const s = SURFACES[n];
    await s.open(p);
    await sleep(300);
    const cl = s.close ? await closeRect(p, s.close) : null;
    const po = await pageOverflow(p);
    const rep = await tabAudit(p, s.root, { leave: n === "toolbar", max: n === "toolbar" ? 40 : 90 });
    out[n] = { stops: rep.stops, bad: rep.bad, closeInViewport: s.close ? insideViewport(cl) : null, overflow: po };
    await shot(p, `${label}-${n}`);
    await leaveSurface(p, s);
    out[n].closedByEscape = (await staleState(p)).depth === 0;
  }
  return out;
}
function assertAudit(out, label) {
  const bad = [];
  for (const [n, r] of Object.entries(out)) {
    if (r.bad.length) bad.push(`${n}: ${r.bad.slice(0, 3).join("; ")}`);
    if (r.closeInViewport === false) bad.push(`${n}: close control outside the viewport`);
    if (r.overflow.sw > r.overflow.W || r.overflow.bw > r.overflow.W) bad.push(`${n}: page-level overflow ${r.overflow.sw}/${r.overflow.bw} > ${r.overflow.W}`);
    if (!r.closedByEscape) bad.push(`${n}: Escape did not close it`);
  }
  check(bad.length === 0, `${label}: ${Object.keys(out).length} surfaces — every focus stop fully visible and uncovered, close control reachable, no page overflow, Escape closes [${Object.entries(out).map(([n, r]) => n + ":" + r.stops).join(" ")}]${bad.length ? " VIOLATIONS: " + bad.join(" || ") : ""}`);
}

// ---------------------------------------------------------------- 200 % zoom
scenario("ZOOM 200%: critical surfaces are fully usable by keyboard at 683×450 CSS px (2 dpr)", async () => {
  const { p } = await seed("zoom200");
  const out = await auditSurfaces(p, "zoom200", ["toolbar", "sources", "reader", "ver", "rsn", "rv", "ask", "hx", "intel"]);
  rec("zoom200.audit", out);
  assertAudit(out, "200% zoom");
});

scenario("ZOOM 200%: actions are exercised (not just looked at): Reader panels, workspace round trip, Review Pack to Reader", async () => {
  const { p } = await seed("zoom200");
  await SURFACES.reader.open(p);
  for (const sel of ["#hq-carnet-reader-ann-toggle", VP + "-toggle", RP + "-toggle"]) await keyOpen(p, sel, "Enter");
  const nOpen = await p.evaluate(() => [...document.querySelectorAll("[data-reader-panel]")].filter((b) => b.getAttribute("aria-expanded") === "true").length);
  check(nOpen >= 1, "Reader panels expand by keyboard at 200% (" + nOpen + " open)");
  const rep = await tabAudit(p, "#hq-carnet-reader", { max: 80 });
  check(rep.bad.length === 0, "Reader with panels expanded at 200%: every stop (" + rep.stops + ") fully visible/uncovered " + rep.bad.slice(0, 3).join("; "));
  await keyOpen(p, VP + "-workspace", "Enter");
  await p.waitForSelector(VER, { state: "visible" });
  await one(p, "hq-carnet-ver", "workspace over Reader at 200%");
  await press(p, "Escape"); await sleep(200);
  await one(p, "hq-carnet-reader", "Reader resumed at 200%");
  check(await activeIs(p, VP + "-workspace"), "exact opener restored at 200%");
  await press(p, "Escape"); await sleep(200); await press(p, "Escape"); await sleep(200);
  await cleanWhenClosed(p, "zoom200 flow end");
  await SURFACES.rv.open(p);
  await keyOpen(p, '[data-rv="open-reader"]');
  await p.waitForSelector("#hq-carnet-reader"); await painted(p);
  check(/Preuve figée/.test(await rtxt(p)), "frozen proof label readable at 200%");
  await press(p, "Escape"); await sleep(250);
  check(await activeIs(p, '[data-rv="open-reader"]'), "return to the exact Review Pack item at 200%");
});

// ---------------------------------------------------------------- reduced motion: computed behaviour, not the media-query match
// every element of a surface (and its ::before/::after) with a transition/animation longer than 50 ms, or smooth scrolling
const motionOffenders = (p, rootSel) => p.evaluate((q) => {
  const secs = (s) => String(s).split(",").map((x) => { const t = x.trim(); return t.endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t) || 0; });
  const root = document.querySelector(q);
  if (!root) return { found: false, offenders: [], checked: 0, running: [] };
  const els = [root, ...root.querySelectorAll("*")].slice(0, 4000);
  const off = [];
  let checked = 0;
  for (const el of els) for (const pseudo of [null, "::before", "::after"]) {
    const cs = getComputedStyle(el, pseudo);
    checked++;
    const td = Math.max(0, ...secs(cs.transitionDuration)), tp = cs.transitionProperty;
    const ad = Math.max(0, ...secs(cs.animationDuration)), an = cs.animationName;
    const why = [];
    if (td > 0.05 && tp !== "none") why.push(`transition ${td}s ${tp}`);
    if (an !== "none" && ad > 0.05) why.push(`animation ${an} ${ad}s`);
    if (cs.scrollBehavior === "smooth") why.push("scroll-behavior:smooth");
    if (why.length) off.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + String(el.className).slice(0, 30)) + (pseudo || "") + " " + why.join(", "));
  }
  const running = document.getAnimations().filter((a) => { try { return a.playState === "running" && Number(a.effect.getTiming().duration) > 50 && root.contains(a.effect.target); } catch (_) { return false; } }).map((a) => (a.animationName || a.transitionProperty || "anim"));
  return { found: true, offenders: off, checked, running };
}, rootSel);
const RM_SURFACES = ["reader", "ver", "rsn", "rv", "ask", "hx", "intel", "toolbar", "sources"];

scenario("REDUCED MOTION: no non-essential transition/animation/smooth scroll on any critical surface (computed + running)", async () => {
  const res = { reduce: {}, noPref: {} };
  for (const [prof, key] of [["desktopRM", "reduce"], ["desktopNP", "noPref"]]) {
    const { p } = await seed(prof);
    check(await p.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches) === (key === "reduce"), `${key}: the emulated preference really is ${key === "reduce" ? "reduce" : "no-preference"}`);
    const html = await p.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior + "/" + getComputedStyle(document.body).scrollBehavior);
    res[key]._root = html;
    for (const n of RM_SURFACES) {
      const s = SURFACES[n];
      await s.open(p);
      await sleep(80); // right after opening: an enter transition would still be running
      const m = await motionOffenders(p, s.root);
      res[key][n] = { offenders: m.offenders.slice(0, 6), n: m.offenders.length, running: m.running.slice(0, 4), checked: m.checked };
      if (n === "reader") {
        for (const sel of ["#hq-carnet-reader-ann-toggle", VP + "-toggle", RP + "-toggle"]) { await keyOpen(p, sel, "Enter"); await sleep(60); const m2 = await motionOffenders(p, s.root); res[key].readerPanels = { n: (res[key].readerPanels ? res[key].readerPanels.n : 0) + m2.offenders.length, offenders: m2.offenders.slice(0, 6) }; }
      }
      await leaveSurface(p, s);
    }
  }
  rec("reducedMotion.audit", res);
  const noPrefTotal = RM_SURFACES.reduce((a, n) => a + res.noPref[n].n, 0) + (res.noPref.readerPanels ? res.noPref.readerPanels.n : 0);
  rec("reducedMotion.noPreferenceMotionElements", noPrefTotal);
  // The detector must be proven able to see motion: inject a canary with a 300 ms transition, a 300 ms animation and smooth scrolling into a real surface and require all three to be reported.
  {
    const { p } = await seed("desktopNP");
    await SURFACES.ask.open(p);
    await p.evaluate(() => { const d = document.createElement("div"); d.id = "p14-canary"; d.style.cssText = "transition:opacity .3s;animation:p14k .3s infinite;scroll-behavior:smooth"; const st = document.createElement("style"); st.id = "p14-canary-st"; st.textContent = "@keyframes p14k{from{opacity:.5}to{opacity:1}}"; document.head.appendChild(st); document.querySelector("#hq-carnet-ask").appendChild(d); });
    const m = await motionOffenders(p, "#hq-carnet-ask");
    await p.evaluate(() => { document.getElementById("p14-canary").remove(); document.getElementById("p14-canary-st").remove(); });
    const why = m.offenders.filter((x) => x.includes("p14-canary")).join(" | ");
    rec("reducedMotion.canary", why);
    check(/transition/.test(why) && /animation/.test(why) && /smooth/.test(why), "detector self-test: a canary with transition + animation + smooth scroll is reported (" + why + ")");
    await leaveSurface(p, SURFACES.ask);
  }
  const bad = RM_SURFACES.filter((n) => res.reduce[n].n > 0 || res.reduce[n].running.length > 0).map((n) => `${n}: ${res.reduce[n].offenders.concat(res.reduce[n].running).slice(0, 3).join("; ")}`);
  if (res.reduce.readerPanels && res.reduce.readerPanels.n) bad.push("reader panels: " + res.reduce.readerPanels.offenders.slice(0, 3).join("; "));
  check(bad.length === 0, "prefers-reduced-motion: reduce — zero transitions/animations over 50 ms and no smooth scrolling on every surface" + (bad.length ? " VIOLATIONS: " + bad.join(" || ") : ""));
});

scenario("REDUCED MOTION behaviour: focus scrolling in the phone toolbar jumps (no smooth scroll) and state is still announced", async () => {
  const { p } = await seed("iphoneRM");
  await SURFACES.toolbar.open(p);
  const smooth = await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools, #carnet-quick-tools *")].filter((n) => getComputedStyle(n).scrollBehavior === "smooth").length);
  check(smooth === 0, "no smooth-scrolling container in the toolbar under reduce");
  for (let i = 0; i < 12; i++) await press(p, "Tab");
  // an immediate read after Tab must already show the final scroll position (a smooth scroll would still be animating)
  const m1 = await stopMetrics(p);
  await sleep(400);
  const m2 = await stopMetrics(p);
  check(Math.abs(m1.frac - m2.frac) < 0.01, `focus-scroll is instantaneous: visible fraction ${m1.frac.toFixed(2)} immediately vs ${m2.frac.toFixed(2)} after settling`);
  // the collapsed/expanded state is carried by aria-expanded, not by the (removed) animation
  await leaveSurface(p, SURFACES.toolbar);
  await SURFACES.reader.open(p);
  await keyOpen(p, VP + "-toggle", "Enter");
  check((await expanded(p, VP + "-toggle")) === "true" && (await p.evaluate((s) => !document.querySelector(s).hidden, VP + "-body")) , "panel expansion under reduce is immediate and exposed through aria-expanded");
});

// ---------------------------------------------------------------- status accessibility + contrast (computed foreground/background, WCAG 2.x relative luminance)
const CONTRAST_JS = `
  const px = (css) => { const c = document.createElement("canvas"); c.width = c.height = 1; const x = c.getContext("2d", { willReadFrequently: true }); x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = css; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (a === 0) return [0, 0, 0, 0]; return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat([a]); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  // effective background: composite every ancestor's background-colour from the element up, over white
  const bgOf = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const bg = getComputedStyle(n).backgroundColor; const c = px(bg); if (c[3] > 0) layers.push(c); if (c[3] === 1) break; } let acc = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc); return acc; };
  const hasBgImage = (el) => { for (let n = el; n; n = n.parentElement) { if (getComputedStyle(n).backgroundImage !== "none") return true; } return false; };
`;
const measureStatus = (p, rootSel, sel) => p.evaluate(new Function("a", "return (() => {" + CONTRAST_JS + `
  const out = [];
  for (const el of document.querySelectorAll(a.root + " " + a.sel)) {
    const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) continue;
    const cs = getComputedStyle(el), before = getComputedStyle(el, "::before");
    const bg = bgOf(el), fg = over(px(cs.color), bg);
    const fs = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const box = el.closest(".carnet-ver-evidence, .carnet-rsn-evidence, [data-state], li, .carnet-ver-row, .carnet-rsn-row") || el;
    const bcs = getComputedStyle(box);
    const bbg = bgOf(box.parentElement || box);
    const bcol = over(px(bcs.borderTopColor), bbg);
    out.push({
      state: el.getAttribute("data-fresh") || el.getAttribute("data-ver-overall") || el.getAttribute("data-rsn-overall") || el.getAttribute("data-state"),
      text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 90),
      glyph: before.content === "none" || before.content === "normal" ? "" : before.content.replace(/^"|"$/g, ""),
      fontSize: fs, bold, large, fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round),
      textRatio: Math.round(ratio(fg, bg) * 100) / 100, needText: large ? 3 : 4.5, bgImage: hasBgImage(el),
      border: { style: bcs.borderTopStyle, width: bcs.borderTopWidth, ratioVsParent: Math.round(ratio(bcol, bbg) * 100) / 100 },
      opacity: cs.opacity,
    });
  }
  return out; })()`), { root: rootSel, sel });

async function statusWorld(prof) {
  const w = await seed(prof);
  const { srv, ctx, ed } = w;
  const mkVer = async (q, refs) => {
    let v = await vcreate(srv, ctx, { kind: "page", page_id: "page-a" }, q);
    for (const ref of refs) v = (await vact(srv, ctx, "verification_evidence_add", v, { ref })).body.verification;
    v = (await vact(srv, ctx, "verification_status", v, { status: "ready" })).body.verification;
    const so = await vact(srv, ctx, "verification_signoff", v, { request_id: rid() });
    check(so.status === 200, "signed off: " + q.slice(0, 30));
    return so.body.verification;
  };
  writeFileSync(path.join(srv.ddir, "plan-2.hqdraw.json"), '{"v":1,"n":2}');
  writeFileSync(path.join(srv.ddir, "plan-3.hqdraw.json"), '{"v":1,"n":3}');
  w.vChanged = await mkVer("État : modifiée", [{ kind: "source", source_id: ed.id }]);
  w.vAnom = await mkVer("État : anomalie d'intégrité", [{ kind: "drawing", stem: "plan-1" }]);
  w.vMissing = await mkVer("État : introuvable", [{ kind: "drawing", stem: "plan-2" }]);
  w.vSame = await mkVer("État : inchangée", [{ kind: "drawing", stem: "plan-3" }]);
  // now alter the world behind the verifications
  const upd = await cpost(srv, ctx, { action: "source_edition_update", id: ed.id, expected_rev: ed.rev, title: "Machinery (titre modifié)" });
  check(upd.status === 200, "source edited after sign-off -> changed");
  writeFileSync(path.join(srv.ddir, "plan-1.hqdraw.json"), '{"v":999}');
  rmSync(path.join(srv.ddir, "plan-2.hqdraw.json"));
  return w;
}
const detailOf = async (p, id) => {
  await p.click(`${VER} [data-ver-act="view"][data-id="${id}"]`);
  await p.waitForSelector(`${VER} #hq-carnet-ver-status`);
  await sleep(700);
};

for (const scheme of ["desktopDark", "desktopLight"]) {
  scenario(`STATUS accessibility ${scheme}: text, accessible exposure, non-colour distinction, contrast`, async () => {
    const w = await statusWorld(scheme);
    const { p } = w;
    await openMore(p);
    await p.click("#btn-carnet-verifications");
    await p.waitForSelector(VER, { state: "visible" });
    await sleep(500);
    const found = {};
    const WANT = { vAnom: "integrity_anomaly", vMissing: "missing", vChanged: "changed", vSame: "unchanged" };
    for (const [k, state] of Object.entries(WANT)) {
      await detailOf(p, w[k].id);
      const rows = await measureStatus(p, VER, '[data-fresh], [data-ver-overall]');
      found[state] = rows.filter((r) => r.state === state || (state === "missing" && r.state === "unavailable"));
      await shot(p, `${scheme}-status-${state}`);
      if (found[state].length) {
        const loc = p.locator(`${VER} [data-fresh="${state}"], ${VER} [data-ver-overall="${state}"]`).first();
        const snap = await loc.locator("xpath=ancestor-or-self::*[self::li or self::div][1]").ariaSnapshot().catch(() => "");
        found[state].aria = String(snap).slice(0, 300);
      }
      await p.click(`${VER} #btn-carnet-ver-back`);
      await sleep(400);
    }
    const EXPECT_TEXT = { integrity_anomaly: /Anomalie d.intégrité/, missing: /(Introuvable|Absent|Manquant|Indisponible|n.existe plus|supprim)/i, changed: /(Modifi|Changé)/i, unchanged: /(Inchangé|identique)/i };
    const GLYPH = { integrity_anomaly: "⚠", missing: "∅", changed: "≠", unchanged: "=" };
    const report = {};
    for (const [state, rows] of Object.entries(found)) {
      const r = Array.isArray(rows) ? rows : [];
      report[state] = r.map((x) => ({ text: x.text, glyph: x.glyph, ratio: x.textRatio, need: x.needText, fg: x.fg, bg: x.bg, border: x.border, size: x.fontSize, opacity: x.opacity, bgImage: x.bgImage }));
      check(r.length > 0, `${scheme}: a ${state} status is rendered (${r.length} element(s))`);
      if (!r.length) continue;
      check(r.every((x) => x.text.length > 0) && r.some((x) => EXPECT_TEXT[state].test(x.text)), `${scheme}: ${state} has human-readable text: "${r[0].text.slice(0, 70)}"`);
      check(r.some((x) => x.glyph.trim() === GLYPH[state]), `${scheme}: ${state} also carries its glyph ${GLYPH[state]} (second channel)`);
      check(r.every((x) => x.opacity === "1"), `${scheme}: ${state} does not rely on opacity`);
      const worst = r.reduce((a, x) => (x.textRatio < a.textRatio ? x : a), r[0]);
      check(!worst.bgImage, `${scheme}: ${state} text sits on a solid background (contrast is exactly measurable)`);
      check(worst.textRatio >= worst.needText, `${scheme}: ${state} text contrast ${worst.textRatio}:1 >= ${worst.needText}:1 (fg rgb(${worst.fg}) on bg rgb(${worst.bg}), ${worst.size}px${worst.bold ? " bold" : ""})`);
    }
    // the three error states must be told apart WITHOUT colour: text + glyph + border style/width
    const sig = (s) => { const x = (found[s] || [])[0]; return x ? [x.text.replace(/\s+/g, " "), x.glyph, x.border.style, x.border.width].join("|") : s; };
    const trio = ["integrity_anomaly", "missing", "changed"].map(sig);
    check(new Set(trio).size === 3, `${scheme}: missing / integrity anomaly / changed differ by text+glyph+border (${trio.map((t) => t.slice(0, 60)).join("  ‖  ")})`);
    check(new Set(["integrity_anomaly", "missing"].map((s) => (found[s][0] || { glyph: s }).glyph + (found[s][0] || { border: {} }).border.style)).size === 2, `${scheme}: the two danger states stay distinct once colour is removed (glyph + border style)`);
    // border contrast (non-text, WCAG 1.4.11 3:1) is informational here because the text/glyph already carry the meaning
    rec(`status.${scheme}.measurements`, report);
    rec(`status.${scheme}.aria`, Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.aria || ""])));
    const ariaMissing = Object.entries(found).filter(([, v]) => !(v.aria || "").trim()).map(([k]) => k);
    check(ariaMissing.length === 0, `${scheme}: every status is present in the accessibility tree (aria snapshot non-empty); missing: ${ariaMissing.join(",") || "none"}`);
  });
}

scenario("STATUS accessibility: corrupt record + register statuses are text, exposed, and distinct", async () => {
  const w = await seed("desktop");
  const { srv, p, dec } = w;
  const f = path.join(srv.root, ".hq-carnet", "reasoning", dec.id + ".json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.seal = "0".repeat(64);
  writeFileSync(f, JSON.stringify(j));
  await reopen(p);
  await openWorkspace(p);
  await sleep(400);
  const txtRows = await p.evaluate((s) => [...document.querySelectorAll(s + " li, " + s + " [role=row], " + s + " .carnet-rsn-row")].map((n) => n.textContent.replace(/\s+/g, " ").trim()).filter((t) => /altér|corrompu|corrupt|illisible|intégrité/i.test(t)).slice(0, 3), RSN);
  rec("status.corruptRow", txtRows);
  check(txtRows.length > 0, "corrupt record shows human-readable corruption text in the register list: " + (txtRows[0] || "").slice(0, 100));
  const alert = await p.evaluate((s) => [...document.querySelectorAll(s + " [role=alert], " + s + " [role=status], " + s + " [aria-live]")].map((n) => ({ role: n.getAttribute("role"), t: n.textContent.trim().slice(0, 60) })), RSN);
  rec("status.corruptRow.liveRegions", alert);
  const m = await measureStatus(p, RSN, "[data-rsn-overall], [data-state], .carnet-chip, [data-rsn=status]");
  const badContrast = m.filter((x) => x.text && x.textRatio < x.needText);
  rec("status.register.contrast", m.slice(0, 12).map((x) => ({ state: x.state, text: x.text.slice(0, 40), ratio: x.textRatio, need: x.needText })));
  check(badContrast.length === 0, "register status chips meet text contrast (" + m.length + " measured)" + (badContrast.length ? " FAIL: " + badContrast.slice(0, 3).map((x) => x.text.slice(0, 30) + " " + x.textRatio).join("; ") : ""));
});

// ---------------------------------------------------------------- mobile hardening (fixed device-width reference everywhere: min(innerWidth, screen.width), never innerWidth alone)
for (const prof of ["iphone", "iphone430"]) {
  scenario(`MOBILE ${prof}: keyboard audit of every surface — focus fully visible, uncovered, close reachable, no page overflow`, async () => {
    const { p } = await seed(prof);
    const out = await auditSurfaces(p, prof, ["toolbar", "sources", "reader", "ver", "rsn", "rv", "ask", "hx", "intel"]);
    rec(`${prof}.audit`, out);
    assertAudit(out, prof);
  });

  scenario(`MOBILE ${prof}: touch targets (WCAG 2.5.8 ≥ 24 px is the defect floor, 44 px is recorded)`, async () => {
    const { p } = await seed(prof);
    const all = {};
    for (const n of ["sources", "reader", "ver", "rsn", "rv", "ask", "hx", "intel"]) {
      const s = SURFACES[n];
      await s.open(p);
      await sleep(250);
      if (n === "reader") for (const sel of ["#hq-carnet-reader-ann-toggle"]) await keyOpen(p, sel, "Enter");
      all[n] = await p.evaluate((q) => {
        const root = document.querySelector(q);
        const out = [];
        for (const el of root.querySelectorAll("button, summary, select, input:not([type=hidden]), textarea, [role=button], [role=tab], a[href]")) {
          const cs = getComputedStyle(el);
          if (el.closest("[hidden]") || cs.visibility === "hidden" || cs.display === "none") continue;
          if (el.tagName === "A" && cs.display === "inline") continue; // inline links in running text are exempt from the target-size minimum
          if (el.tagName === "INPUT" && /checkbox|radio/.test(el.type)) { const lab = el.labels && el.labels[0]; if (lab) { const r = lab.getBoundingClientRect(); if (r.width >= 24 && r.height >= 24) continue; } }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          out.push({ id: el.id || el.getAttribute("data-rv") || el.getAttribute("data-ver-act") || el.getAttribute("data-rsn-act") || el.tagName, t: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) });
        }
        return out;
      }, s.root);
      await leaveSurface(p, s);
    }
    const under24 = [], under44 = {};
    for (const [n, list] of Object.entries(all)) {
      for (const x of list) { if (x.w < 24 || x.h < 24) under24.push(`${n}:${x.id}:${x.t} ${x.w}×${x.h}`); if (x.h < 44) (under44[n] = under44[n] || []).push(`${x.id}:${x.t} ${x.w}×${x.h}`); }
    }
    rec(`${prof}.touch.under44`, Object.fromEntries(Object.entries(under44).map(([k, v]) => [k, v.length + " e.g. " + v.slice(0, 4).join(" | ")])));
    check(under24.length === 0, `${prof}: no interactive control below 24×24 CSS px (${Object.values(all).reduce((a, l) => a + l.length, 0)} measured)` + (under24.length ? " VIOLATIONS: " + under24.slice(0, 6).join(" || ") : ""));
  });
}

for (const prof of ["iphone", "iphone430"]) {
  scenario(`TOOLBAR contract ${prof}: every action reachable by keyboard, not all simultaneously visible, named, no scroll trap, no page overflow`, async () => {
    const { p } = await seed(prof);
    await SURFACES.toolbar.open(p);
    const acts = await p.evaluate(() => [...document.querySelectorAll("#carnet-quick-tools button")].map((b, i) => ({ i, id: b.id || "", label: b.getAttribute("aria-label") || "", text: (b.textContent || "").replace(/\s+/g, " ").trim(), disabled: b.disabled })));
    rec(`${prof}.toolbar.actions`, acts.map((a) => (a.id || a.text) + "|" + a.label));
    check(acts.length === 26, `the phone toolbar has exactly 26 actions (${acts.length})`);
    const unnamed = acts.filter((a) => !(a.label || a.text));
    check(unnamed.length === 0, "every action has an accessible name " + JSON.stringify(unnamed.slice(0, 3)));
    // WCAG 2.5.3 label in name: when a button shows text and also has an aria-label, the label must contain the visible text
    const mis = acts.filter((a) => a.label && a.text && a.text.length > 1 && !a.label.toLowerCase().includes(a.text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 12)));
    check(mis.length === 0, "aria-label contains the visible label of each action " + JSON.stringify(mis.slice(0, 4)));
    const vis = await p.evaluate(() => { const W = Math.min(innerWidth, screen.width); return [...document.querySelectorAll("#carnet-quick-tools button")].filter((b) => { const r = b.getBoundingClientRect(); const clip = b.closest("#carnet-quick-tools"); const c = clip.getBoundingClientRect(); return r.width > 0 && r.left >= c.left - 1 && r.right <= Math.min(c.right, W) + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; }).length; });
    rec(`${prof}.toolbar.fullyVisibleAtOpen`, vis);
    check(vis < 26, `not all 26 are simultaneously visible on a phone (${vis} fully visible at open) — the contract is reachability, not fit`);
    // forward Tab walk: every action receives focus, fully on screen, at least once
    await p.focus("#carnet-quick-tools button");
    const got = new Set();
    for (let i = 0; i < 30; i++) {
      await sleep(60);
      const m = await stopMetrics(p);
      const id = await p.evaluate(() => { const a = document.activeElement; const bs = [...document.querySelectorAll("#carnet-quick-tools button")]; return bs.indexOf(a); });
      if (id >= 0) { got.add(id); if (m.frac < 0.98 || m.covered) throw new Error(`FAIL: toolbar action #${id} focused but ${(m.frac * 100).toFixed(0)}% visible${m.covered ? " and covered" : ""}`); }
      else break;
      await press(p, "Tab");
    }
    check(got.size === 26, `forward Tab reaches all 26 actions, each fully on screen (${got.size})`);
    // reverse walk from the last one
    let back = 0;
    for (let i = 0; i < 30; i++) {
      await press(p, "Shift+Tab"); await sleep(60);
      const inTb = await p.evaluate(() => !!document.activeElement.closest("#carnet-quick-tools"));
      if (!inTb) break;
      back++;
    }
    check(back >= 25, `Shift+Tab walks back through the actions without a trap (${back} steps before leaving)`);
    const po = await pageOverflow(p);
    check(po.sw <= po.W && po.bw <= po.W, `no page-level overflow with the toolbar open (${po.sw}/${po.bw} <= ${po.W})`);
    await leaveSurface(p, SURFACES.toolbar);
  });
}

scenario("MOBILE short viewport (browser chrome / keyboard open): Reader and register forms stay reachable and keep focus visible", async () => {
  const { p } = await seed("iphone");
  await p.setViewportSize({ width: 390, height: 420 });
  await sleep(200);
  await SURFACES.reader.open(p);
  const rep = await tabAudit(p, "#hq-carnet-reader", { max: 60 });
  check(rep.bad.length === 0, "Reader at 390×420: every stop (" + rep.stops + ") fully visible and uncovered " + rep.bad.slice(0, 3).join("; "));
  const cl = await closeRect(p, "#btn-carnet-reader-close");
  check(insideViewport(cl), "Reader close control inside a 420px-high viewport");
  await leaveSurface(p, SURFACES.reader);
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(150);
  // virtual keyboard contract: the app publishes --hq-kb (visualViewport). With it set, EVERY control of a modal must be scrollable above the keyboard (the browser cannot do this for an overlay it does not resize).
  const kbBad = [], kbSeen = [];
  for (const n of ["reader", "rsn", "rv", "ver", "ask", "hx", "intel"]) {
    const s = SURFACES[n];
    await s.open(p);
    await sleep(250);
    if (n === "reader") { await keyOpen(p, "#hq-carnet-reader-ann-toggle", "Enter"); await sleep(250); }
    await p.evaluate(() => document.documentElement.style.setProperty("--hq-kb", "320px"));
    const geo = await p.evaluate((q) => {
      const root = document.querySelector(q);
      const scs = [root, ...root.querySelectorAll("*")].filter((n) => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 2);
      for (const n of scs) n.scrollTop = n.scrollHeight; // outermost first (document order), then every nested scroller, like a user scrolling to the end
      const sc = scs[0] || root;
      const foc = [...root.querySelectorAll("button, input, select, textarea, summary, a[href]")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; });
      const last = foc.reduce((a, n) => (n.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? n : a), foc[0]);
      const r = last.getBoundingClientRect();
      return { scroller: sc.id || sc.className.slice(0, 30), canScroll: scs.length > 0, lastBottom: Math.round(r.bottom), kbTop: innerHeight - 320, H: innerHeight, last: (last.id || last.textContent || "").trim().slice(0, 30) };
    }, s.root);
    rec("mobile.keyboardSafe." + n, geo);
    kbSeen.push(n);
    if (!(geo.lastBottom <= geo.kbTop + 1)) kbBad.push(`${n}: last control (${geo.last}) ends at ${geo.lastBottom}px, keyboard starts ${geo.kbTop}px`);
    await p.evaluate(() => document.documentElement.style.removeProperty("--hq-kb"));
    await leaveSurface(p, s);
  }
  check(kbBad.length === 0, `scrolled to the end with a simulated 320px keyboard, the last control of every modal (${kbSeen.join(",")}) sits above it` + (kbBad.length ? " VIOLATIONS: " + kbBad.join(" || ") : ""));
});

scenario("MOBILE nested surfaces: modal width equals the device width at every nesting level, exact focus restoration", async () => {
  for (const prof of ["iphone", "iphone430"]) {
    const { p } = await seed(prof);
    await SURFACES.reader.open(p);
    await keyOpen(p, VP + "-toggle", "Enter");
    await keyOpen(p, VP + "-workspace", "Enter");
    await p.waitForSelector(VER, { state: "visible" });
    const w = await p.evaluate(() => { const W = Math.min(innerWidth, screen.width); return [...window.HqCarnetModal.stack(document)].map((x) => { const r = x.node.getBoundingClientRect(); return { id: x.node.id, suspended: x.suspended, w: Math.round(r.width), l: Math.round(r.left), W }; }); });
    check(w.length === 3 && w.every((x) => x.l >= 0 && x.l + x.w <= x.W), `${prof}: Sources/Reader/workspace each fit the ${w[0] && w[0].W}px device width ${JSON.stringify(w.map((x) => [x.id, x.w, x.suspended]))}`);
    await press(p, "Escape"); await sleep(200);
    check(await activeIs(p, VP + "-workspace"), `${prof}: exact opener restored`);
    await leaveSurface(p, { closeKeys: 2 });
    await cleanWhenClosed(p, prof + " nested");
  }
});

// ---------------------------------------------------------------- runner
async function main() {
  try { browser = await chromium.launch(); } catch (e) { console.log(`SKIP: ${ENGINE} unavailable in this workspace (${String(e.message).split("\n")[0]})`); process.exit(0); }
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const [name, fn] of scenarios) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    console.log("\n# " + name);
    try { await fn(); } catch (e) { failures.push([name, e]); console.log("  FAIL ", e.message.split("\n").slice(0, 12).join(" | ")); }
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
  await browser.close();
  for (const s of started) s.close();
  OUT.focusLog = FOCUS_LOG;
  OUT.engine = ENGINE;
  if (outFile) writeFileSync(outFile, JSON.stringify(OUT, null, 2));
  if (external.length) failures.push(["external requests", new Error("external: " + external.slice(0, 3).join(","))]);
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s) [engine=${ENGINE}]`);
  for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
  if (errors.length) { console.log("BROWSER ERRORS:\n" + errors.slice(0, 10).join("\n")); failures.push(["browser errors", new Error(errors[0])]); }
  console.log("\nFirefox / WebKit: only run when P14_BROWSER selects them AND the binaries exist; physical devices: Physical-device testing not performed.");
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
