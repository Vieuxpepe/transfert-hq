// Carnet product phase 10: PERFORMANCE of live annotations and Review Pack comments (measurement, not a pass/fail benchmark).
//
//   node tests/perf_carnet_annotations_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side is tests/test_hq_carnet_annotations.py, the pure client contract is tests/check_hq_carnet_annotations.mjs.
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
const SHOTS = process.env.P10_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-annotations-"));
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

// ---------------------------------------------------------------- measurement
const ANN = "#hq-carnet-reader-ann";
const srcTarget = (ed) => ({ kind: "source", source_id: ed.id });
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const results = { annotations: [], review: null, env: { node: process.version, note: "Chromium headless, loopback server, single run machine; numbers are indicative, not a benchmark" } };
const annPosts = (p, bag) => p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/carnet") && /"(annotation|rcomment)_/.test(r.postData() || "")) bag.push(JSON.parse(r.postData())); });

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

for (const N of [1, 25, 100]) {
  scenario(`P${N} ${N} annotation(s) on one target: list latency, Reader render, request count`, async () => {
    const { srv, ctx, p } = await world();
    const ed = await mkEd(srv, ctx, "Machinery");
    const c = cite(ed, { ok: true, pdf: 417, loc: { kind: "page", text: "412" } });
    srv.remote((pg) => { pg.content.blocks.push(citeBlock("block-c1", c)); });
    const createMs = [];
    for (let i = 0; i < N; i += 1) {
      const t0 = Date.now();
      const r = await cpost(srv, ctx, { action: "annotation_create", request_id: rid(), target: srcTarget(ed), anchor: null, body: "annotation " + i + " " + "x".repeat(200) });
      createMs.push(Date.now() - t0);
      if (r.status !== 200) throw new Error("create failed " + JSON.stringify(r.body));
    }
    await reopen(p);
    // list latency measured from the page (real browser fetch, same origin, session cookie)
    const lat = await p.evaluate(async (target) => {
      const out = [];
      for (let i = 0; i < 7; i += 1) {
        const t0 = performance.now();
        const r = await fetch("/api/carnet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "annotation_list", targets: [target] }) });
        const j = await r.json();
        out.push({ ms: performance.now() - t0, n: j.results[0].annotations.length, bytes: JSON.stringify(j).length });
      }
      return out;
    }, srcTarget(ed));
    const listMs = median(lat.map((x) => x.ms));
    const bag = [];
    annPosts(p, bag);
    await p.click(`[data-carnet-block-id="block-c1"] [data-carnet-citation]`);
    await p.waitForSelector("#hq-carnet-sources-layer", { state: "visible" });
    await p.waitForSelector("#btn-carnet-src-reader");
    const t0 = Date.now();
    await p.click("#btn-carnet-src-reader");
    await p.waitForSelector(ANN + " .carnet-ann-group");
    await p.waitForFunction((n) => document.querySelectorAll("#hq-carnet-reader-ann [data-ann]").length >= n, Math.min(N, 100));
    const renderMs = Date.now() - t0;
    const shown = await p.locator(ANN + " [data-ann]").count();
    const row = { n: N, create_ms_median: median(createMs), create_ms_max: Math.max(...createMs), list_ms_median: Math.round(listMs * 10) / 10, list_response_bytes: lat[0].bytes, reader_open_to_annotations_ms: renderMs, rendered: shown, annotation_requests_on_open: bag.length, shard_files: readdirSync(path.join(srv.root, ".hq-carnet", "annotations")).length };
    results.annotations.push(row);
    console.log("  RESULT", JSON.stringify(row));
    check(shown === N && bag.length === 1, `all ${N} rendered with exactly one request`);
  });
}

scenario("PR Review Pack with 100 comments: render, thread read, append latency", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx, "Machinery");
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  const item = pk.items[0];
  const appendMs = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = Date.now();
    const r = await cpost(srv, ctx, { action: "rcomment_add", review_id: pk.id, item_id: item.id, request_id: rid(), body: "commentaire " + i + " " + "y".repeat(200), supersedes: null });
    appendMs.push(Date.now() - t0);
    if (r.status !== 200) throw new Error("append failed " + JSON.stringify(r.body));
  }
  const over = await cpost(srv, ctx, { action: "rcomment_add", review_id: pk.id, item_id: item.id, request_id: rid(), body: "101e", supersedes: null });
  check(over.status === 409 && over.body.code === "review_comment_limit", "the 101st comment on one item is refused (bounded): " + over.status + " " + over.body.code);
  await reopen(p);
  const lat = await p.evaluate(async (rid_) => {
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      const r = await fetch("/api/carnet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rcomment_list", review_id: rid_ }) });
      const j = await r.json();
      out.push({ ms: performance.now() - t0, n: j.comments.length, bytes: JSON.stringify(j).length });
    }
    return out;
  }, pk.id);
  const bag = [];
  annPosts(p, bag);
  await p.locator("#btn-carnet-more").click().catch(() => {});
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.waitForSelector('[data-rv="c-toggle"]');
  const t0 = Date.now();
  await p.click(`#hq-carnet-rv-ctoggle-${item.id}`);
  await p.waitForFunction((n) => document.querySelectorAll("[data-rv-comment]").length >= n, 100);
  const renderMs = Date.now() - t0;
  const t1 = Date.now();
  // one more append through the UI is refused at 100 per item; use a second item for the UI append latency
  const rowRes = { comments: 100, append_ms_median: median(appendMs), append_ms_max: Math.max(...appendMs), thread_list_ms_median: Math.round(median(lat.map((x) => x.ms)) * 10) / 10, thread_response_bytes: lat[0].bytes, expand_to_100_rendered_ms: renderMs, thread_requests_from_pack_open_to_100_rendered: bag.length, thread_file_bytes: readdirSync(path.join(srv.root, ".hq-carnet", "review-comments")).map((n) => readFileSync(path.join(srv.root, ".hq-carnet", "review-comments", n)).length)[0] };
  results.review = rowRes;
  console.log("  RESULT", JSON.stringify(rowRes));
  check((await p.locator("[data-rv-comment]").count()) === 100 && bag.length === 1 && bag[0].action === "rcomment_list", "100 comments rendered from ONE thread read (rcomment_list), no per-comment request: " + bag.length);
  void t1;
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
  console.log("\nPERF " + JSON.stringify(results));
  console.log("\nWebKit / Firefox / physical devices: UNVERIFIED (Chromium emulation only).");
  console.log(`\n${passed} checks passed, ${failures.length} scenario failure(s)`);
  if (failures.length) {
    for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
