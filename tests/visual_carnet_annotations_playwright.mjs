// Carnet product phase 10: live evidence annotations + Review Pack comments (commentary only; evidence is never touched).
//
//   node tests/visual_carnet_annotations_playwright.mjs [scenario substring...]
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

scenario("01 Reader panel: add an annotation to the opened citation; it is commentary — the page, sources and every other file stay byte-identical", async () => {
  const { srv, ctx, p, ed, c } = await readerOnCitation();
  check((await txt(p, ANN + " h3")).includes("Annotations actuelles"), "panel heading says current");
  check((await p.locator(ANN + " [data-ann-target]").count()) === 2, "two groups: this citation, this source");
  const before = digestExcept(srv, ["annotations"]);
  const pageBefore = JSON.stringify(srv.pg("page-a"));
  await addAnn(p, "Vérifier la clause avec le fournisseur");
  check(annFiles(srv).length === 1, "one shard file written");
  const raw = annRaw(srv);
  check(raw.includes("citation_fingerprint") && !raw.includes("Machinery"), "only the server fingerprint is stored, never the citation value");
  check(digestExcept(srv, ["annotations"]) === before, "every other file under .hq-carnet is byte-identical");
  check(JSON.stringify(srv.pg("page-a")) === pageBefore, "page JSON (content, rev) is unchanged");
  const group = await p.locator(`${ANN} [data-ann-target="citation"] [data-ann]`).count();
  check(group === 1, "the annotation sits under 'Cette citation' (default target = the opened citation)");
  await reopen(p);
  await citationToReader(p, "block-c1");
  await panelReady(p);
  check((await p.locator(`${ANN} [data-ann-target="citation"] [data-ann]`).count()) === 1, "it survives a reload");
  await shotEl(p, ANN, "01-reader-annotation");
});

scenario("02 source-level annotation with an explicit PDF page anchor; 'Lire la preuve' moves the viewer; the anchor never changes the target", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await addAnn(p, "Table 5 à relire", { target: "source", page: true });
  check((await rtxt(p, "#hq-carnet-reader-page")).includes("417"), "viewer is on the cited page");
  check((await txt(p, ANN + " [data-ann-anchor]")).includes("page PDF 417"), "anchor shown as 'page PDF 417'");
  await addAnn(p, "Autre page", { target: "source" });
  check(annFiles(srv).length === 1, "two annotations on the source, ONE shard (anchor is not identity)");
  const res = await apiList(srv, ctx, [srcTarget(ed)]);
  check(res[0].annotations.length === 2 && res[0].annotations.some((a) => a.anchor && a.anchor.pdf === 417) && res[0].annotations.some((a) => a.anchor === null || a.anchor.pdf === null), "anchor lives in the record: " + JSON.stringify(res[0].annotations.map((a) => a.anchor)));
  await p.click(`${R} #btn-carnet-reader-next`);
  check((await rtxt(p, "#hq-carnet-reader-page")).includes("418"), "moved to PDF page 418");
  await p.click(`${ANN} [data-ann-target="source"] [data-ann]:has([data-ann-anchor]:has-text("page PDF 417")) [data-ann-act="view"]`);
  await until(async () => (await rtxt(p, "#hq-carnet-reader-page")).includes("417"), "Lire la preuve returns to PDF page 417");
});

scenario("03 hostile text is text: <script>, <img onerror>, javascript: links are shown literally and never run", async () => {
  const { srv, ctx, p } = await readerOnCitation();
  const hostile = '<script>window.__pwn=1</script><img src=x onerror="window.__pwn=2"> [x](javascript:window.__pwn=3)';
  await addAnn(p, hostile);
  check((await p.evaluate(() => window.__pwn)) === undefined, "nothing executed");
  check((await p.locator(ANN + " img, " + ANN + " script, " + ANN + " a").count()) === 0, "no element was created from the text");
  check((await p.locator(ANN + " .carnet-ann-body").first().textContent()) === hostile, "shown verbatim");
  await reopen(p);
  check((await p.evaluate(() => window.__pwn)) === undefined, "and after a reload");
});

scenario("04 stale EDIT: the other device wins with 409, the server never stores the losing text, the typed text stays for an explicit retry", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await addAnn(p, "version A", { target: "source" });
  const a = (await apiList(srv, ctx, [srcTarget(ed)]))[0].annotations[0];
  const other = await cpost(srv, ctx, { action: "annotation_update", id: a.id, target: a.target, expected_rev: a.rev, body: "version B (autre appareil)" });
  check(other.status === 200, "another device edits first");
  await p.click(`${ANN} [data-ann="${a.id}"] [data-ann-act="edit"]`);
  await p.fill(`#hq-ann-edit-${a.id}`, "ma modification perdante");
  await p.click(`${ANN} [data-ann-act="save"]`);
  await until(async () => (await txt(p, ANN + ' [data-ann="error"]')).includes("a changé ailleurs"), "conflict message shown");
  check(!annText(srv).includes("ma modification perdante"), "the losing text is NOT in the store");
  check(annText(srv).includes("version B (autre appareil)"), "the winner is intact");
  check((await p.inputValue(`#hq-ann-edit-${a.id}`)) === "ma modification perdante", "the typed text is still in the box");
  await p.click(`${ANN} [data-ann-act="save"]`);
  await until(async () => annText(srv).includes("ma modification perdante"), "an EXPLICIT retry against the fresh revision succeeds");
});

scenario("05 stale DELETE confirmation never becomes a refreshed delete", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await addAnn(p, "à ne pas perdre", { target: "source" });
  const a = (await apiList(srv, ctx, [srcTarget(ed)]))[0].annotations[0];
  await p.click(`${ANN} [data-ann="${a.id}"] [data-ann-act="delete"]`);
  await p.waitForSelector(`${ANN} [data-ann-act="confirm-delete"]`);
  check((await p.evaluate(() => document.activeElement.id)) === "hq-ann-confirm-" + a.id, "focus moves to the confirmation");
  await cpost(srv, ctx, { action: "annotation_update", id: a.id, target: a.target, expected_rev: a.rev, status: "resolved" });
  await p.click(`${ANN} [data-ann-act="confirm-delete"]`);
  await until(async () => (await txt(p, ANN + ' [data-ann="error"]')).includes("suppression n'a pas été faite"), "refusal explained");
  check(annText(srv).includes("à ne pas perdre"), "the annotation is still there");
  check((await p.locator(`${ANN} [data-ann-act="confirm-delete"]`).count()) === 0, "the confirmation is gone: the person must ask again");
});

scenario("06 delete: confirmed once, removes only that annotation; the evidence and the neighbour are untouched", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await addAnn(p, "garder", { target: "source" });
  await addAnn(p, "supprimer", { target: "source" });
  const before = digestExcept(srv, ["annotations"]);
  const victim = await p.locator(`${ANN} [data-ann]`).filter({ has: p.locator(".carnet-ann-body", { hasText: /^supprimer$/ }) }).getAttribute("data-ann");
  await p.click(`${ANN} [data-ann="${victim}"] [data-ann-act="delete"]`);
  check((await txt(p, ANN + " .carnet-ann-confirm")).includes("La preuve n'est pas touchée"), "the confirmation says the evidence is untouched");
  await p.click(`${ANN} [data-ann-act="confirm-delete"]`);
  await until(async () => (await p.locator(`${ANN} [data-ann="${victim}"]`).count()) === 0, "annotation removed");
  check((await p.locator(`${ANN} [data-ann] .carnet-ann-body`, { hasText: /^garder$/ }).count()) === 1, "neighbour kept");
  check(digestExcept(srv, ["annotations"]) === before, "nothing else changed");
});

scenario("07 frozen Reader (Review Pack item): the panel is labelled current / non-frozen; live annotations do not enter the pack", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  const live = await cpost(srv, ctx, { action: "annotation_create", request_id: rid(), target: srcTarget(ed), anchor: null, body: "NOTE-VIVANTE-42" });
  check(live.status === 200, "a live annotation exists on the source");
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue gelée", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
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
  await panelReady(p);
  check((await txt(p, ANN + " h3")).includes("non incluses dans la preuve figée"), "heading: 'Annotations actuelles — non incluses dans la preuve figée'");
  check((await p.locator(ANN + ' [data-ann="not-frozen"]').count()) === 1, "explicit note that these are not part of the frozen copy");
  check((await p.locator(ANN + " .carnet-ann-body").allTextContents()).includes("NOTE-VIVANTE-42"), "the live annotation is shown (current), separately");
  check(readFileSync(path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json"), "utf8") === packBefore, "the Review Pack file is byte-identical: no annotation entered it");
  check(!(await rtxt(p, "#hq-carnet-reader-table")).includes("NOTE-VIVANTE-42"), "the frozen metadata table does not contain it");
  await shotEl(p, ANN, "07-frozen-reader-annotations");
});

scenario("08 citation changed: the annotation stays on the OLD citation, is flagged 'modifiée ou retirée', and is never retargeted", async () => {
  const { srv, ctx, p, ed, c } = await readerOnCitation();
  await addAnn(p, "sur la 412", { target: "citation" });
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  const c2 = cite(ed, { ok: true, pdf: 418, loc: { kind: "page", text: "999" } });
  srv.remote((pg) => { const i = pg.content.blocks.findIndex((b) => b.id === "block-c1"); pg.content.blocks[i] = citeBlock("block-c1", c2); });
  const t = (await apiList(srv, ctx, [{ kind: "citation", page_id: "page-a", block_id: "block-c1", cite: c }]))[0];
  check(t.target_state === "changed_or_removed" && t.annotations.length === 1, "old value: " + t.target_state + ", annotation kept");
  const t2 = (await apiList(srv, ctx, [{ kind: "citation", page_id: "page-a", block_id: "block-c1", cite: c2 }]))[0];
  check(t2.annotations.length === 0, "the new citation owns nothing (no fuzzy match)");
  srv.remote((pg) => { pg.content.blocks = pg.content.blocks.filter((b) => b.id !== "block-c1"); });
  const t3 = (await apiList(srv, ctx, [{ kind: "citation", page_id: "page-a", block_id: "block-c1", cite: c }]))[0];
  check(t3.target_state === "unavailable" && t3.annotations.length === 1, "block gone: unavailable, annotation kept");
});

scenario("09 create retried after a lost answer: the SAME request id, one annotation; a changed text gets a new id", async () => {
  const { srv, ctx, p } = await readerOnCitation();
  const bodies = [];
  let first = true;
  await p.route("**/api/carnet", async (route) => {
    const post = route.request().postData() || "";
    if (route.request().method() === "POST" && post.includes('"annotation_create"')) {
      bodies.push(JSON.parse(post));
      if (first) {
        first = false;
        await route.fetch();
        await route.abort("failed"); // the server DID create it; the browser never hears
        return;
      }
    }
    await route.continue();
  });
  await p.fill(ANN + "-new", "créée une fois");
  await p.click(ANN + "-add");
  await until(async () => (await txt(p, ANN + ' [data-ann="error"]')).length > 0, "network error surfaced; draft kept");
  check((await p.inputValue(ANN + "-new")) === "créée une fois", "the typed text is kept");
  await p.click(ANN + "-add");
  await until(async () => (await p.locator(ANN + " [data-ann]").count()) === 1, "listed once");
  check(bodies.length === 2 && bodies[0].request_id === bodies[1].request_id, "same request id on the retry");
  check(annText(srv).split("créée une fois").length - 1 === 1, "exactly one stored record");
  await p.unroute("**/api/carnet");
});

scenario("10 modal behaviour with the panel: Tab / Shift+Tab containment, Escape returns to the opener, iframe still out of the tab order", async () => {
  const { srv, ctx, p } = await readerOnCitation();
  check((await p.getAttribute("#hq-carnet-reader-frame", "tabindex")) === "-1", "Phase 9: PDF iframe is still tabindex=-1");
  const inside = () => p.evaluate(() => { const r = document.querySelector("#hq-carnet-reader"); return !!(r && r.contains(document.activeElement)); });
  for (let i = 0; i < 30; i += 1) await p.keyboard.press("Tab");
  check(await inside(), "Tab x30 never leaves the Reader");
  for (let i = 0; i < 30; i += 1) await p.keyboard.press("Shift+Tab");
  check(await inside(), "Shift+Tab x30 never leaves the Reader");
  await p.focus(ANN + "-new");
  check(await inside(), "the annotation box is reachable by keyboard");
  const label = await p.getAttribute(ANN + "-new", "aria-label");
  check(label === "Annotation", "the textarea is labelled 'Annotation'");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "Escape closes the Reader");
});

scenario("11 batching: one annotation_list per view for 25 annotations, never a request per annotation", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  for (let i = 0; i < 25; i += 1) await cpost(srv, ctx, { action: "annotation_create", request_id: rid(), target: srcTarget(ed), anchor: null, body: "n" + i });
  const bag = [];
  annPosts(p, bag);
  await citationToReader(p, "block-c1");
  await panelReady(p);
  check((await p.locator(ANN + " [data-ann]").count()) === 25, "25 annotations rendered");
  const lists = bag.filter((b) => b.action === "annotation_list");
  check(lists.length === 1 && lists[0].targets.length === 2 && bag.length === 1, "exactly ONE annotation_list (2 targets) and nothing else: " + bag.length);
});

scenario("12 corrupt record: shown read-only and flagged, the neighbours stay usable", async () => {
  const { srv, ctx, p, ed } = await readerOnCitation();
  await addAnn(p, "intacte", { target: "source" });
  await addAnn(p, "à altérer", { target: "source" });
  const f = path.join(annDir(srv), annFiles(srv)[0]);
  const doc = JSON.parse(readFileSync(f, "utf8"));
  doc.records.find((r) => r.body === "à altérer").body = "falsifiée";
  writeFileSync(f, JSON.stringify(doc));
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape").catch(() => {});
  await citationToReader(p, "block-c1");
  await panelReady(p);
  check((await p.locator(`${ANN} [data-integrity="corrupt"]`).count()) === 1, "one corrupt record flagged");
  check((await txt(p, `${ANN} [data-integrity="corrupt"]`)).includes("altérée"), "in words");
  check((await p.locator(`${ANN} [data-integrity="corrupt"] [data-ann-act="edit"]`).count()) === 0, "no edit button on the corrupt record");
  check((await p.locator(`${ANN} [data-integrity="ok"] [data-ann-act="edit"]`).count()) === 1, "the intact neighbour is still editable");
});

// ---- Review Pack comments
const DLG = "#hq-carnet-rv";
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function reviewWorld(profile = "desktop") {
  const { srv, ctx, p } = await world(profile);
  const ed = await mkEd(srv, ctx, "Machinery");
  let pk = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid() })).body.review;
  pk = (await cpost(srv, ctx, { action: "review_item_add", id: pk.id, expected_rev: pk.rev, item: { kind: "source", edition_id: ed.id } })).body.review;
  await reopen(p);
  await openMore(p);
  await p.click("#btn-carnet-reviews");
  await p.waitForSelector(DLG, { state: "visible" });
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.waitForSelector('[data-rv-comments] [data-rv="c-toggle"]');
  return { srv, ctx, p, ed, pk, item: pk.items[0] };
}
const addComment = async (p, itemId, text) => {
  if ((await p.getAttribute(`#hq-carnet-rv-ctoggle-${itemId}`, "aria-expanded")) !== "true") await p.click(`#hq-carnet-rv-ctoggle-${itemId}`);
  await p.fill(`#hq-carnet-rv-cnew-${itemId}`, text);
  await p.click(`[data-rv="c-add"][data-id="${itemId}"]`);
  await until(async () => (await p.locator(`[data-rv-comments="${itemId}"] .carnet-rv-comment-body`).allTextContents()).includes(text), "comment listed: " + text.slice(0, 30));
};

scenario("13 review comment: append under the exact item, count shown, the pack file is untouched, text is plain", async () => {
  const { srv, ctx, p, pk, item } = await reviewWorld();
  const packFile = path.join(srv.root, ".hq-carnet", "reviews", pk.id + ".json");
  const before = readFileSync(packFile, "utf8");
  check((await txt(p, `#hq-carnet-rv-ctoggle-${item.id}`)).includes("Commentaires (0)"), "count 0 shown");
  await addComment(p, item.id, "Vérifié contre la révision C");
  await addComment(p, item.id, '<img src=x onerror="window.__pwn=9"><script>window.__pwn=8</script>');
  check((await p.evaluate(() => window.__pwn)) === undefined && (await p.locator(`[data-rv-comments] img, [data-rv-comments] script`).count()) === 0, "hostile comment is text");
  check((await txt(p, `#hq-carnet-rv-ctoggle-${item.id}`)).includes("Commentaires (2)"), "count 2");
  check(readFileSync(packFile, "utf8") === before, "the Review Pack file (rev, seal) is byte-identical");
  check(rcFiles(srv).length === 1, "one thread file in the separate store");
  check((await p.getAttribute(`#hq-carnet-rv-cnew-${item.id}`, "aria-label")) === "Commentaire de revue", "textarea labelled 'Commentaire de revue'");
  check((await p.locator(`[data-rv="c-edit"], [data-rv="c-delete"]`).count()) === 0, "append-only: no edit / delete control");
  check(annFiles(srv).length === 0, "a review comment is never a live annotation");
  await shotEl(p, `[data-rv-comments="${item.id}"]`, "13-review-comments");
});

scenario("14 review comment: lost answer retried with the same request id adds ONE comment; a correction links to the earlier comment", async () => {
  const { srv, ctx, p, item } = await reviewWorld();
  const bodies = [];
  let first = true;
  await p.route("**/api/carnet", async (route) => {
    const post = route.request().postData() || "";
    if (route.request().method() === "POST" && post.includes('"rcomment_add"')) {
      bodies.push(JSON.parse(post));
      if (first) {
        first = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
    }
    await route.continue();
  });
  await p.click(`#hq-carnet-rv-ctoggle-${item.id}`);
  await p.fill(`#hq-carnet-rv-cnew-${item.id}`, "une seule fois");
  await p.click(`[data-rv="c-add"][data-id="${item.id}"]`);
  await until(async () => (await p.locator("#hq-carnet-rv-error").count()) > 0, "error shown, draft kept");
  check((await p.inputValue(`#hq-carnet-rv-cnew-${item.id}`)) === "une seule fois", "typed text kept");
  await p.click(`[data-rv="c-add"][data-id="${item.id}"]`);
  await until(async () => (await p.locator(`[data-rv-comments="${item.id}"] .carnet-rv-comment`).count()) === 1, "one comment");
  check(bodies.length === 2 && bodies[0].request_id === bodies[1].request_id, "same request id");
  await p.unroute("**/api/carnet");
  const cid = await p.locator(`[data-rv-comments="${item.id}"] .carnet-rv-comment`).first().getAttribute("data-rv-comment");
  await p.click(`[data-rv="c-correct"][data-id="${cid}"]`);
  check((await txt(p, `[data-rv="c-correcting"]`)).includes(cid), "the form says which comment is corrected");
  await p.fill(`#hq-carnet-rv-cnew-${item.id}`, "correction");
  await p.click(`[data-rv="c-add"][data-id="${item.id}"]`);
  await until(async () => (await p.locator(`[data-rv-comments="${item.id}"] [data-rv="c-supersedes"]`).count()) === 1, "correction shows 'corrige …'");
  check((await p.locator(`[data-rv-comments="${item.id}"] .carnet-rv-comment`).count()) === 2, "the earlier comment is still there, unedited");
});

scenario("15 item removed from the pack: its comments move to 'Preuves retirées' with the captured identity, never vanish", async () => {
  const { srv, ctx, p, pk, item } = await reviewWorld();
  await addComment(p, item.id, "à propos de la source");
  const rm = await cpost(srv, ctx, { action: "review_item_remove", id: pk.id, expected_rev: pk.rev, item_id: item.id });
  check(rm.status === 200, "item removed");
  await p.click("#btn-carnet-rv-back");
  await p.click('[data-rv="open"]');
  await p.waitForSelector("#hq-carnet-rv-name");
  await p.click('[data-rv-tab="evidence"]');
  await p.waitForSelector("#hq-carnet-rv-removed");
  check((await txt(p, "#hq-carnet-rv-removed")).includes("à propos de la source"), "the comment is still readable");
  check((await txt(p, "#hq-carnet-rv-removed")).includes(item.id), "with the captured item identity");
});

scenario("16 export boundary: the deterministic review export carries review comments and NEVER live annotations", async () => {
  const { srv, ctx, p, ed, pk, item } = await reviewWorld();
  await cpost(srv, ctx, { action: "annotation_create", request_id: rid(), target: srcTarget(ed), anchor: null, body: "ANNOTATION-VIVANTE-77" });
  await addComment(p, item.id, "COMMENTAIRE-DE-REVUE-55");
  const r = await ctx.request.get(srv.base + "/api/carnet/review-export/" + encodeURIComponent(pk.id));
  const status = r.status();
  const buf = await r.body();
  check(status === 200, "export served: " + status);
  check(!buf.includes("ANNOTATION-VIVANTE-77"), "live annotation text is nowhere in the export");
  // the zip stores files deflated; compare the contents through the Python reader instead of guessing
  const py = spawnSyncPy(buf);
  check(py.includes("COMMENTAIRE-DE-REVUE-55") && !py.includes("ANNOTATION-VIVANTE-77"), "export contains the comment, not the annotation");
});

scenario("17 iPhone profile: the panel fits the width, controls are tappable, no horizontal scroll", async () => {
  const { srv, ctx, p } = await readerOnCitation("iphone");
  await addAnn(p, "sur mobile", { target: "source" });
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, panel: document.querySelector("#hq-carnet-reader-ann").scrollWidth, rw: document.querySelector("#hq-carnet-reader").clientWidth, h: [...document.querySelectorAll("#hq-carnet-reader-ann button")].map((b) => b.getBoundingClientRect().height) }));
  check(m.sw <= m.iw + 1 && m.panel <= m.rw + 1, "no horizontal overflow: " + JSON.stringify({ sw: m.sw, iw: m.iw, panel: m.panel, rw: m.rw }));
  check(m.h.every((x) => x >= 32), "buttons are tall enough: min " + Math.min(...m.h));
  await shotEl(p, ANN, "17-iphone-annotations");
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
