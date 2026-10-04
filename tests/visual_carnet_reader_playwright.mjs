// Carnet product phase 9: Reader (inspection and navigation of evidence only; nothing is written, nothing is persisted).
//
//   node tests/visual_carnet_reader_playwright.mjs [scenario substring...]
//
// Engines: Chromium only (touch/mobile EMULATION, colour-scheme and reduced-motion emulation; no physical device). WebKit / Firefox: UNVERIFIED.
// Runs on a throwaway loopback HQ (tests/carnet_test_server.py, temp root, fake PINs); run it from a disposable copy of the checkout.
// The Python side of the contract is tests/test_hq_carnet_reader.py and the pure view models are tests/check_hq_carnet_reader.mjs: this
// file only covers what needs a browser. Scenario filters are SUBSTRINGS of the scenario name: use the numbers ("12 diff").
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
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
const SHOTS = process.env.P9_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

class Server {
  static async start(seed, env) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-reader-"));
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
// Phase 11: likewise the read-only batched verification_related lookup (never a write; the Reader panel is lazy about everything else).
// Phase 12: likewise the read-only batched reasoning_related lookup (the decisions & assumptions register panel; never a write, one request).
// Phase 10: the Reader hosts a SEPARATE annotations panel whose only open-time request is the read-only batched annotation_list. It is a read of commentary,
// not of evidence, so it is excluded here; every WRITE (and any other POST) must still be absent. tests/visual_carnet_annotations_playwright.mjs pins the panel itself.
const otherPosts = (p, bag) => p.on("request", (r) => { const d = r.postData() || ""; if (r.method() === "POST" && r.url().endsWith("/api/carnet") && !d.includes('"reader_resolve"') && !d.includes('"annotation_list"') && !d.includes('"verification_related"') && !d.includes('"reasoning_related"')) bag.push(d); });
const pdfGets = (p, bag) => p.on("request", (r) => { if (r.method() === "GET" && /\/files\/Uni\/.*\.pdf/.test(r.url())) bag.push(r.url()); });
async function withCites(srv, ctx, specs, extraBlocks = []) {
  // specs: [{ed, o, id}] -> citation blocks appended to page-a (another "device" edit), then the browser reloads
  srv.remote((pg) => { for (const s of specs) pg.content.blocks.push(citeBlock(s.id, cite(s.ed, s.o))); pg.content.blocks.push(...extraBlocks); });
}
const iframeSrc = (p) => p.evaluate(() => { const f = document.querySelector("#hq-carnet-reader-frame"); return f ? f.getAttribute("src") : null; });

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("01 Sources dialog hardening: dialog semantics, Tab / Shift+Tab containment, Escape returns to the exact citation", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  await reopen(p);
  await p.waitForSelector('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
  await p.focus('[data-carnet-block-id="block-c1"] [data-carnet-citation]');
  await p.keyboard.press("Enter");
  await p.waitForSelector(SL, { state: "visible" });
  await p.waitForSelector("#btn-carnet-src-reader");
  const attrs = await p.evaluate((s) => { const l = document.querySelector(s); return { role: l.getAttribute("role"), modal: l.getAttribute("aria-modal"), lab: l.getAttribute("aria-labelledby"), title: (document.getElementById(l.getAttribute("aria-labelledby")) || {}).textContent }; }, SL);
  check(attrs.role === "dialog" && attrs.modal === "true" && attrs.title === "Référence", "role=dialog, aria-modal, labelled by its title: " + JSON.stringify(attrs));
  check((await activeInfo(p, SL)).inside, "focus moved inside the dialog");
  for (let i = 0; i < 12; i += 1) await p.keyboard.press("Tab");
  check((await activeInfo(p, SL)).inside, "Tab x12 never leaves the dialog");
  for (let i = 0; i < 12; i += 1) await p.keyboard.press("Shift+Tab");
  check((await activeInfo(p, SL)).inside, "Shift+Tab x12 never leaves the dialog");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(SL).isHidden()), "Escape closes the dialog");
  const a = await activeInfo(p, "#hq-carnet-editor");
  check(a.cite, "focus returned to the exact citation that opened it: " + a.tag + "." + a.cls);
});

scenario("02 Sources → Voir le PDF opens the Reader ABOVE the dialog; Escape returns to the exact 'Voir le PDF' button; locator and PDF page 417 are separate", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { loc: { kind: "page", text: "412" }, pdf: 417, ok: true } }]);
  await reopen(p);
  const posts = [];
  readerPosts(p, posts);
  await citationToReader(p, "block-c1", "#btn-carnet-src-open");
  check((await rtxt(p, "#hq-carnet-reader-line-locator")).includes("Page 412") && (await rtxt(p, "#hq-carnet-reader-line-pdf")).includes("417"), "locator 'Page 412' and PDF page 417 on separate lines");
  check((await iframeSrc(p)) === "/files/Uni/" + ed._name + "#page=417", "the viewer opens PDF page 417 exactly: " + (await iframeSrc(p)));
  check((await rtxt(p, "#hq-carnet-reader-page")).includes("Page PDF 417"), "announcement 'Page PDF 417'");
  const at = await p.evaluate(() => ({ role: document.getElementById("hq-carnet-reader").getAttribute("role"), modal: document.getElementById("hq-carnet-reader").getAttribute("aria-modal") }));
  check(at.role === "dialog" && at.modal === "true", "Reader is a modal dialog");
  check(await p.locator(SL).isVisible(), "the Sources dialog is still open underneath (never nested in it)");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "Escape closes the Reader only");
  check((await activeInfo(p, SL)).id === "btn-carnet-src-open", "focus is back on the exact 'Voir le PDF' opener: " + (await activeInfo(p, SL)).id);
  check(await p.locator(SL).isVisible(), "Sources dialog still open");
  await p.keyboard.press("Escape");
  await until(async () => await p.locator(SL).isHidden(), "second Escape closes Sources");
  check((await activeInfo(p, "#hq-carnet-editor")).cite, "and focus returns to the citation");
  check(posts.length === 1 && Object.keys(posts[0]).sort().join() === "action,entries" && posts[0].entries.length === 1, "exactly one identities-only reader_resolve (the page list reuses the answer it already holds)");
  await shot(p, "02-reader-desktop");
});

scenario("03 Reader → Retour à la citation leaves no stranded dialog or focus trap; the editor is usable again", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  await p.click("#btn-carnet-reader-back");
  await until(async () => (await p.locator(R).count()) === 0 && (await p.locator(SL).isHidden()), "Reader and Sources dialog both gone");
  check(await p.evaluate(() => window.HqCarnetModal.depth(document)) === 0, "modal stack is empty (no nested / stranded trap)");
  check((await activeInfo(p, "#hq-carnet-editor")).cite, "deep-link return focuses the original citation block");
  check((await flashOf(p)).includes("Bloc atteint"), "block reached: " + (await flashOf(p)));
  await p.click("#hq-carnet-editor");
  await p.keyboard.press("End");
  await p.keyboard.type("x");
  check((await txt(p, "#hq-carnet-editor")).endsWith("x"), "typing works again: nothing traps focus");
});

scenario("04 deleted citation block: the return falls back to the page with the usual 'Bloc introuvable'", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  await p.evaluate(() => document.querySelector('[data-carnet-block-id="block-c1"]').remove());
  await p.click("#btn-carnet-reader-back");
  await until(async () => (await flashOf(p)).includes("Bloc introuvable"), "existing 'block gone' behaviour");
  check((await p.locator(R).count()) === 0 && (await p.locator(SL).isHidden()), "dialogs closed, page still open");
  check(!!(await p.locator("#hq-carnet-editor").getAttribute("data-page-id")), "the page stays open");
});

scenario("05 captured vs current: a renamed source keeps the captured snapshot and shows the current one separately", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx, "Spec A");
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  const rev = (await cget(srv, ctx, "sources=1")).body.editions.find((e) => e.id === ed.id).rev;
  const up = await cpost(srv, ctx, { action: "source_edition_update", id: ed.id, expected_rev: rev, title: "Spec B" });
  check(up.status === 200, "source renamed");
  await reopen(p);
  await citationToReader(p, "block-c1");
  const row = await p.evaluate(() => { const tr = document.querySelector('#hq-carnet-reader-table tr[data-field="title"]'); return tr ? { cap: tr.querySelector(".carnet-reader-cap").textContent, cur: tr.querySelector(".carnet-reader-cur").textContent, differs: tr.dataset.differs, flag: tr.querySelector(".carnet-reader-flag").textContent } : null; });
  check(row && row.cap === "Spec A" && row.cur === "Spec B" && row.differs === "true" && row.flag === "Diffère", "captured 'Spec A' | current 'Spec B' | Diffère: " + JSON.stringify(row));
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Spec A", "the captured title leads");
});

scenario("06 'ok' says only 'Emplacement vérifié'; opening the Reader never toggles ok or any source-editing state", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }, { ed, id: "block-c2", o: { ok: false, loc: { kind: "section", text: "5.2" } } }]);
  await reopen(p);
  const before = carnetDigest(srv);
  const others = [];
  otherPosts(p, others);
  await citationToReader(p, "block-c1");
  const v = await rtxt(p, "#hq-carnet-reader-verified");
  check(v.includes("Emplacement vérifié") && v.includes("pas le contenu"), "wording (location only): " + v);
  check(!/source vérifiée|information vérifiée|contenu vérifié|affirmation vérifiée/i.test(await rtxt(p)), "never 'source/information/claim verified'");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.waitForSelector(SL, { state: "hidden" });
  await citationToReader(p, "block-c2");
  check((await rtxt(p, "#hq-carnet-reader-verified")).includes("Emplacement non vérifié"), "unverified wording");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.waitForSelector(SL, { state: "hidden" });
  check(carnetDigest(srv) === before, "notebook, sources, history: byte-identical after open/close");
  check(others.length === 0, "no write request at all: " + others.length);
  check(JSON.stringify(srv.pg("page-a").content.blocks.find((b) => b.id === "block-c1").marks[0].cite.ok) === "true", "citation ok untouched");
});

scenario("07 missing / archived source, missing file, unknown file: distinct states, the citation stays visible", async () => {
  const { srv, ctx, p } = await world();
  const live = await mkEd(srv, ctx, "Live");
  const arch = await mkEd(srv, ctx, "Archived");
  const nofile = await mkEd(srv, ctx, "NoFile");
  const gone = "srce-gone-1";
  const rev = (await cget(srv, ctx, "sources=1")).body.editions.find((e) => e.id === arch.id).rev;
  check((await cpost(srv, ctx, { action: "source_edition_archive", id: arch.id, expected_rev: rev, archived: true })).status === 200, "archived");
  rmSync(path.join(srv.root, "Uni", nofile._name));
  await withCites(srv, ctx, [{ ed: live, id: "block-l" }, { ed: arch, id: "block-a" }, { ed: nofile, id: "block-n" }, { ed: { id: gone, title: "Vanished", edition: "1e" }, id: "block-g", o: { snap: { title: "Vanished" } } }]);
  await reopen(p);
  const state = async () => ({ src: await rtxt(p, "#hq-carnet-reader-source-state"), file: await rtxt(p, "#hq-carnet-reader-file-state"), frame: await p.locator("#hq-carnet-reader-frame").count(), name: await rtxt(p, "#hq-carnet-reader-name") });
  const close2 = async () => { await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await p.waitForSelector(SL, { state: "hidden" }); };
  await citationToReader(p, "block-a");
  let s = await state();
  check(s.src.includes("archivée") && s.file.includes("disponible") && s.frame === 1, "archived but file present: readable. " + JSON.stringify(s));
  await close2();
  await citationToReader(p, "block-n");
  s = await state();
  check(s.src.includes("Source disponible") && s.file.includes("introuvable") && s.frame === 0, "missing FILE is not a missing SOURCE. " + JSON.stringify(s));
  await close2();
  await citationToReader(p, "block-g");
  s = await state();
  check(s.src.includes("Source introuvable — la citation est conservée") && s.name === "Vanished" && (await rtxt(p, "#hq-carnet-reader-line-locator")).includes("304.1.2"), "missing source: the citation and its snapshot remain. " + JSON.stringify(s));
  await close2();
  // unknown file state (the answer the server gives for a redirected / non-canonical target) is shown as unknown, never as missing
  await p.route("**/api/carnet", async (route) => {
    if (!(route.request().postData() || "").includes('"reader_resolve"')) return route.continue();
    const body = JSON.parse(route.request().postData());
    const e = body.entries[0];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, read_only: true, results: [{ source_id: e.source_id, captured: null, current: { state: "available", metadata: { title: "Live" }, file: { state: "unknown", route: null } }, differs: [], integrity: { state: "not_applicable", route: null, sealed_sha256: null }, frozen: null }], resolved: 1, limits: { entries: 100 } }) });
  });
  await citationToReader(p, "block-l");
  s = await state();
  check(s.file.includes("inconnu") && !s.file.includes("introuvable"), "unknown file state is not 'introuvable': " + s.file);
});

scenario("08 hostile <script> title is rendered as text (no script, no dialog, no markup)", async () => {
  const { srv, ctx, p } = await world();
  const evil = "<script>window.__pwn=1</script><img src=x onerror=window.__pwn=2>";
  const ed = await mkEd(srv, ctx, evil);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { snap: { title: evil } } }]);
  let dialogs = 0;
  p.on("dialog", (d) => { dialogs += 1; d.dismiss(); });
  await reopen(p);
  await citationToReader(p, "block-c1");
  check((await rtxt(p, "#hq-carnet-reader-name")) === evil, "title is the literal text");
  check((await p.locator(R + " script, " + R + " img").count()) === 0, "no element created from the title");
  check((await p.evaluate(() => window.__pwn)) === undefined && dialogs === 0, "nothing executed");
});

scenario("09 the Reader never accepts a path or a URL from the client; only identities travel", async () => {
  const { srv, ctx } = await world();
  const ed = await mkEd(srv, ctx);
  for (const bad of [{ source_id: "/etc/passwd" }, { source_id: "file:///etc/passwd" }, { source_id: "https://evil.example/x.pdf" }, { source_id: ed.id, file_ref: "/etc/passwd" }, { source_id: ed.id, url: "https://evil.example" }, { source_id: ed.id, path: "Uni/x.pdf" }]) {
    const r = await cpost(srv, ctx, { action: "reader_resolve", entries: [bad] });
    check(r.status === 400 && r.body.code === "validation_error", "refused: " + JSON.stringify(bad));
  }
  const ok = await cpost(srv, ctx, { action: "reader_resolve", entries: [{ source_id: ed.id }] });
  const out = JSON.stringify(ok.body);
  check(ok.status === 200 && out.includes("/files/Uni/") && !out.includes(srv.root) && !out.includes("file://"), "the only file reference is a confined /files route");
  const anon = await (await browserCtxAnon(srv)).request.post(srv.base + "/api/carnet", { data: { action: "reader_resolve", entries: [{ source_id: ed.id }] }, headers: { Origin: srv.base } });
  check([401, 403].includes(anon.status()), "unauthenticated: " + anon.status());
});
async function browserCtxAnon(srv) { return browser.newContext(); }

scenario("10 a locator without a PDF page never guesses one; a PDF page without a locator never invents one; a calibrated edition is not used to guess", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  const rev = (await cget(srv, ctx, "sources=1")).body.editions.find((e) => e.id === ed.id).rev;
  const cal = await cpost(srv, ctx, { action: "source_edition_calibrate", id: ed.id, expected_rev: rev, calibration: { printed: 1, pdf: 13 } });
  check(cal.status === 200, "edition calibrated (printed 1 = PDF 13)");
  await withCites(srv, ctx, [{ ed, id: "block-l", o: { loc: { kind: "page", text: "400" }, pdf: null, ok: true } }, { ed, id: "block-p", o: { loc: { kind: "page", text: "" }, pdf: 417, ok: false } }]);
  await reopen(p);
  await citationToReader(p, "block-l");
  check((await rtxt(p, "#hq-carnet-reader-line-pdf")).includes("Aucune page PDF enregistrée"), "locator only: " + (await rtxt(p, "#hq-carnet-reader-line-pdf")));
  check((await iframeSrc(p)) === "/files/Uni/" + ed._name, "no #page= fragment is invented: " + (await iframeSrc(p)));
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.waitForSelector(SL, { state: "hidden" });
  await citationToReader(p, "block-p");
  check((await rtxt(p, "#hq-carnet-reader-line-locator")).includes("Aucun emplacement source enregistré") && (await rtxt(p, "#hq-carnet-reader-line-pdf")).includes("417"), "PDF page only: no locator invented");
});

scenario("11 migration provenance is shown separately and never replaces the citation", async () => {
  const { srv, ctx, p } = await world();
  const old = await mkEd(srv, ctx, "Old");
  const neu = await mkEd(srv, ctx, "New");
  await withCites(srv, ctx, [{ ed: neu, id: "block-c1", o: { from: { src: old.id, loc: { kind: "page", text: "12" }, pdf: 20, ok: true }, ok: false } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  const prov = await rtxt(p, "#hq-carnet-reader-provenance");
  check(prov.startsWith("Provenance de migration") && prov.includes("Page 12") && prov.includes("Page PDF 20"), prov);
  check((await rtxt(p, "#hq-carnet-reader-line-locator")).includes("304.1.2"), "the current locator is untouched");
});

scenario("12 Ask source card → Reader: the answer is not mutated, no other request, exact focus return", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  await reopen(p);
  await p.click("#btn-carnet-more").catch(() => {});
  await p.click("#btn-carnet-ask");
  await p.waitForSelector("#hq-carnet-ask", { state: "visible" });
  await p.fill("#hq-carnet-ask-q", "Machinery");
  await p.click("#btn-carnet-ask-go");
  await until(async () => (await p.locator('#hq-carnet-ask [data-ask-role="reader"]').count()) >= 1, "a source card with an 'Ouvrir dans le lecteur' action");
  const before = await txt(p, "#hq-carnet-ask-out");
  const posts = [];
  const others = [];
  readerPosts(p, posts);
  otherPosts(p, others);
  const dig = carnetDigest(srv);
  await p.click('#hq-carnet-ask [data-ask-role="reader"]');
  await p.waitForSelector(R);
  await painted(p);
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Machinery", "Reader shows the source");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "closed");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-ask-role"))) === "reader", "focus back on the exact source-card button");
  check((await txt(p, "#hq-carnet-ask-out")) === before, "the Ask result is unchanged");
  check(posts.length === 1 && others.length === 0 && carnetDigest(srv) === dig, "one read-only reader_resolve, nothing else, nothing written");
});

scenario("13 Review Pack frozen evidence: sealed hash match → normal viewing; mismatch → live PDF NOT auto-loaded, explicit labelled action; sealed file gone → frozen bytes unavailable", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx, "Frozen title");
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  const snap = await cpost(srv, ctx, { action: "snapshot_create", request_id: rid(), project_id: "proj-1", label: "Gel A" });
  check(snap.status === 200, "snapshot created (seals the PDF hash)");
  const rv = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid(), baseline: { kind: "snapshot", snapshot_id: snap.body.snapshot.id } })).body.review;
  const add = await cpost(srv, ctx, { action: "review_item_add", id: rv.id, expected_rev: rv.rev, item: { kind: "source", edition_id: ed.id } });
  check(add.status === 200, "frozen source evidence added");
  await reopen(p);
  const gets = [];
  pdfGets(p, gets);
  const openIt = async () => {
    if (await p.locator("#hq-carnet-rv").isHidden().catch(() => true)) {
      if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
      await p.click("#btn-carnet-reviews");
      await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
      await p.click('[data-rv="open"]');
      await p.waitForSelector("#hq-carnet-rv-name");
      await p.click('[data-rv-tab="evidence"]');
    }
    await p.click('[data-rv="open-reader"]');
    await p.waitForSelector(R);
    await painted(p);
  };
  const verified = [];
  p.on("response", async (r) => { if (r.url().includes("/api/carnet/reader-pdf")) verified.push({ status: r.status(), type: r.headers()["content-type"] || "", ranges: r.headers()["accept-ranges"] || null, xfo: r.headers()["x-frame-options"] || "" }); });
  await openIt();
  check((await rtxt(p, "#hq-carnet-reader-banner")) === "Fichier actuel identique au fichier scellé", "match banner: " + (await rtxt(p, "#hq-carnet-reader-banner")));
  check((await p.locator("#hq-carnet-reader-frame").count()) === 1 && !(await p.locator("#hq-carnet-reader-viewer-label").count()), "hash match: normal frozen viewing, unlabelled");
  check(/^\/api\/carnet\/reader-pdf\?review=rvw-[0-9a-f]{24}&item=ri-[0-9a-f]{16}&source=srce-/.test((await iframeSrc(p)) || ""), "the matched seal is shown through the VERIFIED route, not /files: " + (await iframeSrc(p)));
  check(!/Uni\//.test((await iframeSrc(p)) || ""), "the verified route carries identities, never a path");
  await until(async () => verified.length >= 1, "verified PDF requested");
  check(verified[0].status === 200 && verified[0].type === "application/pdf", "stable file: the frame request was answered 200 application/pdf");
  const fetched = await p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, text: await r.text() }; }, await iframeSrc(p));
  check(fetched.status === 200 && fetched.text === PDF, "stable file: the verified route serves exactly the sealed PDF bytes");
  check(verified[0].ranges === null && verified[0].xfo === "SAMEORIGIN", "no false Accept-Ranges; frameable same-origin only");
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Frozen title", "frozen metadata shown");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "closed");
  check((await p.evaluate(() => document.activeElement.getAttribute("data-rv"))) === "open-reader", "focus back on the exact Reader opener");
  // TOCTOU (r2): the resolver says "matches", then the PDF is replaced BEFORE the browser's own GET of the frame
  verified.length = 0;
  await p.route("**/api/carnet/reader-pdf*", async (route) => {
    writeFileSync(path.join(srv.root, "Uni", ed._name), PDF_B);
    await route.continue();
  });
  await openIt();
  await until(async () => verified.length >= 1, "verified PDF requested after the swap");
  check(verified[0].status === 409 && verified[0].type.startsWith("application/json") && true, "replaced file: the server REFUSES (409) with JSON, never a PDF");
  const refused = await p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, text: await r.text() }; }, await iframeSrc(p));
  check(refused.status === 409 && !refused.text.includes("%PDF") && !refused.text.includes("other bytes"), "replaced file: no byte of the replacement is sent: " + refused.status);
  await until(async () => (await p.locator("#hq-carnet-reader-autherr").isVisible()), "refusal shown");
  check((await rtxt(p, "#hq-carnet-reader-autherr")) === "Le fichier a changé depuis le scellé : l’évidence figée n’est pas affichée.", "the frozen viewer says it refused");
  check(await p.locator("#hq-carnet-reader-frame").isHidden(), "the replacement is not displayed");
  check((await rtxt(p, "#hq-carnet-reader-banner")) === "Le fichier a changé depuis le scellé : l’évidence figée n’est pas affichée.", "the 'identique' banner is replaced, never left contradicting the refusal");
  await p.unroute("**/api/carnet/reader-pdf*");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "closed");
  // the live file changes after the seal (PDF_B is already on disk)
  gets.length = 0;
  await openIt();
  check((await rtxt(p, "#hq-carnet-reader-banner")) === "Le fichier actuel diffère du fichier scellé lors de cette revue / de ce jalon.", "differs banner");
  check((await p.locator("#hq-carnet-reader-frame").count()) === 0, "the live PDF is NOT auto-loaded");
  check(gets.length === 0, "no request for the live PDF was made: " + gets.length);
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Frozen title", "frozen metadata remains authoritative");
  check((await rtxt(p, "#btn-carnet-reader-open-current")) === "Ouvrir le fichier actuel (différent)", "explicit action offered");
  await shot(p, "13-frozen-differs-desktop");
  await p.click("#btn-carnet-reader-open-current");
  await p.waitForSelector("#hq-carnet-reader-frame");
  check((await rtxt(p, "#hq-carnet-reader-viewer-label")) === "Fichier actuel — différent de l’évidence figée", "unmistakable label");
  await shot(p, "13-frozen-open-current-labelled");
  check(gets.length >= 1 || (await iframeSrc(p)) === "/files/Uni/" + ed._name, "now the current file loads");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "closed");
  // sealed bytes gone
  rmSync(path.join(srv.root, "Uni", ed._name));
  await openIt();
  check((await rtxt(p, "#hq-carnet-reader-banner")).includes("octets figés ne sont plus disponibles"), "sealed file missing: frozen bytes unavailable");
  check((await p.locator("#hq-carnet-reader-frame").count()) === 0 && (await p.locator("#btn-carnet-reader-open-current").count()) === 0, "nothing to open, nothing reconstructed");
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Frozen title", "frozen metadata remains");
});

scenario("14 source portal → Reader: portal stays live, 'Retour au portail', exact 'Voir le portail de cette source'", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  const other = await mkEd(srv, ctx, "Other");
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }, { ed: other, id: "block-c2", o: { ok: true } }], [portalBlock("block-p1", "source", ed.id)]);
  await reopen(p);
  await until(async () => (await p.locator("#hq-carnet-editor .carnet-pb").count()) === 1 && (await p.locator("#hq-carnet-editor .carnet-pb").getAttribute("data-state")) !== "loading", "portal resolved");
  const dig = carnetDigest(srv);
  check((await p.locator(".carnet-pb-open").textContent()) === "Ouvrir dans le lecteur", "portal action is named");
  await p.click(".carnet-pb-open");
  await p.waitForSelector(R);
  await painted(p);
  check((await rtxt(p, "#btn-carnet-reader-back")) === "Retour au portail", "opened from a portal: Retour au portail");
  check((await p.locator("#btn-carnet-reader-portal").count()) === 0, "no 'Voir le portail' when we came from it");
  await p.click("#btn-carnet-reader-back");
  await until(async () => (await p.locator(R).count()) === 0, "back to the portal");
  check((await flashOf(p)).includes("Bloc atteint"), "portal block reached");
  check((await p.locator("#hq-carnet-editor .carnet-pb-open").evaluate((n) => n.closest("[data-carnet-block-id]").dataset.carnetBlockId)) === "block-p1", "same block");
  // from the citation: exactly one portal with this edition -> offered; none for the other source -> omitted
  await citationToReader(p, "block-c1");
  check((await p.locator("#btn-carnet-reader-portal").count()) === 1 && (await rtxt(p, "#btn-carnet-reader-portal")) === "Voir le portail de cette source", "exactly one source portal for this edition: offered");
  await p.click("#btn-carnet-reader-portal");
  await until(async () => (await p.locator(R).count()) === 0, "deep-linked to the portal");
  check((await flashOf(p)).includes("Bloc atteint"), "portal block reached");
  await citationToReader(p, "block-c2");
  check((await p.locator("#btn-carnet-reader-portal, #btn-carnet-reader-portal-1").count()) === 0, "no portal for the other source: action omitted (no fuzzy match, nothing created)");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.waitForSelector(SL, { state: "hidden" });
  check(carnetDigest(srv) === dig, "no portal created, nothing written");
  // several portals for the same edition: an exact list, never a guess
  srv.remote((pg) => pg.content.blocks.push(portalBlock("block-p2", "source", ed.id)));
  await reopen(p);
  await citationToReader(p, "block-c1");
  check((await p.locator("#btn-carnet-reader-portal-1").count()) === 1 && (await p.locator("#btn-carnet-reader-portal-2").count()) === 1 && (await p.locator("#btn-carnet-reader-portal").count()) === 0, "two portals: a small exact list (1/2, 2/2)");
});

scenario("15 open/close changes nothing: notebook, source, Review Pack revisions and history are identical", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  const rv = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue", request_id: rid() })).body.review;
  await cpost(srv, ctx, { action: "review_item_add", id: rv.id, expected_rev: rv.rev, item: { kind: "source", edition_id: ed.id } });
  await reopen(p);
  const dig = carnetDigest(srv);
  const rev = srv.pg("page-a").rev;
  const ls = await p.evaluate(() => JSON.stringify([Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]));
  const sw = await p.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0));
  for (let i = 0; i < 3; i += 1) {
    await citationToReader(p, "block-c1");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.waitForSelector(SL, { state: "hidden" });
  }
  check(carnetDigest(srv) === dig, "the whole .hq-carnet tree is byte-identical (notebook, sources, reviews, snapshots, history)");
  check(srv.pg("page-a").rev === rev, "page revision unchanged");
  check((await p.evaluate(() => JSON.stringify([Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]))) === ls, "no browser storage key added");
  check((await p.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0))) === sw, "no service worker");
});

scenario("16 100 citations: one bounded batch for the list, duplicates collapsed, one broken source does not suppress the other cards", async () => {
  const { srv, ctx, p } = await world();
  const eds = [await mkEd(srv, ctx, "S0"), await mkEd(srv, ctx, "S1"), await mkEd(srv, ctx, "S2"), await mkEd(srv, ctx, "S3")];
  rmSync(path.join(srv.root, "Uni", eds[3]._name));
  const ghost = { id: "srce-ghost-9", title: "Ghost", edition: "1e" };
  const all = [...eds, ghost];
  const specs = [];
  for (let i = 0; i < 100; i += 1) specs.push({ ed: all[i % 5], id: "block-c" + i, o: { loc: { kind: "page", text: String(100 + i) }, ok: i % 2 === 0, snap: { title: all[i % 5].title } } });
  await withCites(srv, ctx, specs);
  await reopen(p);
  await p.waitForSelector('[data-carnet-block-id="block-c0"] [data-carnet-citation]');
  const posts = [];
  readerPosts(p, posts);
  const t0 = Date.now();
  await citationToReader(p, "block-c0");
  await until(async () => (await p.locator(R + " .carnet-reader-cite").count()) === 100, "100 citation cards listed");
  await until(async () => (await p.locator(R + " .carnet-reader-cite-state").evaluateAll((ns) => ns.every((n) => !n.textContent.includes("Chargement")))), "every card resolved");
  console.log("  perf: 100 citation cards (list + main) resolved in " + (Date.now() - t0) + " ms");
  check(posts.length === 2, "exactly two reader_resolve requests (the opened one + ONE batch for the rest of the list): " + posts.length);
  const list = posts.find((b) => b.entries.length > 1);
  check(list && list.entries.length === 99 && list.entries.every((e) => Object.keys(e).sort().join() === "citation,source_id"), "one batch of 99 identity entries (the 100th is the opened one, already answered)");
  const st = await p.locator(R + " .carnet-reader-cite").evaluateAll((ns) => ns.map((n) => ({ src: n.dataset.src, state: n.querySelector(".carnet-reader-cite-state").textContent })));
  check(st.filter((s) => s.src === "srce-ghost-9").every((s) => s.state.includes("introuvable")) && st.filter((s) => s.src === eds[3].id).every((s) => s.state.includes("Fichier PDF introuvable") && s.state.includes("Source disponible")), "the ghost source and the file-less source are reported each on its own cards");
  check(st.filter((s) => s.src === eds[0].id).every((s) => s.state.includes("Source disponible") && s.state.includes("Fichier PDF disponible")), "the other cards are intact");
  check((await p.locator(R + " .carnet-reader-cite").count()) <= 100, "bounded at 100");
});

scenario("17 perf: metadata-only, source + PDF, 25 citation cards", async () => {
  const { srv, ctx, p } = await world();
  const noPdf = await mkEd(srv, ctx, "Meta", { file: false });
  const withPdf = await mkEd(srv, ctx, "Pdf");
  const specs = [{ ed: noPdf, id: "block-m" }, { ed: withPdf, id: "block-w", o: { pdf: 7 } }];
  for (let i = 0; i < 25; i += 1) specs.push({ ed: withPdf, id: "block-k" + i, o: { loc: { kind: "page", text: String(i + 1) } } });
  await withCites(srv, ctx, specs);
  await reopen(p);
  await p.waitForSelector('[data-carnet-block-id="block-m"] [data-carnet-citation]');
  let t0 = Date.now();
  await citationToReader(p, "block-m");
  console.log("  perf: metadata-only Reader painted in " + (Date.now() - t0) + " ms");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.waitForSelector(SL, { state: "hidden" });
  t0 = Date.now();
  await citationToReader(p, "block-w");
  await p.waitForSelector("#hq-carnet-reader-frame");
  console.log("  perf: source + PDF Reader painted in " + (Date.now() - t0) + " ms");
  await until(async () => (await p.locator(R + " .carnet-reader-cite").count()) === 27, "27 citation cards (2 + 25)");
  t0 = Date.now();
  await until(async () => (await p.locator(R + " .carnet-reader-cite-state").evaluateAll((ns) => ns.every((n) => !n.textContent.includes("Chargement")))), "25+ cards resolved");
  console.log("  perf: 27 citation cards resolved " + (Date.now() - t0) + " ms after paint");
});

scenario("18 /files: no false Accept-Ranges; PDF is frameable same-origin only; an auth error is reported, never a blank frame", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 3, ok: true } }]);
  const r = await ctx.request.get(srv.base + "/files/Uni/" + ed._name);
  check(r.status() === 200 && !("accept-ranges" in r.headers()), "no Accept-Ranges on /files (the route serves whole files)");
  check(r.headers()["x-frame-options"] === "SAMEORIGIN", "still frameable same-origin only");
  await reopen(p);
  await p.route("**/files/Uni/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"auth"}' }));
  await citationToReader(p, "block-c1");
  await until(async () => await p.locator("#hq-carnet-reader-autherr").isVisible(), "401 from /files is reported in words");
  check((await rtxt(p, "#hq-carnet-reader-autherr")).includes("Session expirée"), "message: " + (await rtxt(p, "#hq-carnet-reader-autherr")));
  check((await p.locator("#btn-carnet-reader-tab").count()) === 1, "'Ouvrir dans un onglet' stays available");
});

scenario("19 Safari / iOS ignore #page=: the Reader says so and never pretends the page was reached", async () => {
  const srv = await server(NB());
  const ctx = await context(srv, "iphone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const p = await openPage(ctx, srv);
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 417, ok: true } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  check((await rtxt(p, "#hq-carnet-reader-nojump")).includes("saut de page n’est pas disponible"), "notice: " + (await rtxt(p, "#hq-carnet-reader-nojump")));
  check((await p.locator("#btn-carnet-reader-tab").getAttribute("href")) === "/files/Uni/" + ed._name + "#page=417", "'Ouvrir dans un onglet' offered");
});

scenario("20 offline / resolver failure: the citation as stored stays readable, the current side is 'inconnu' (never 'introuvable')", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 417, ok: true } }]);
  await reopen(p);
  await p.route("**/api/carnet", (route) => ((route.request().postData() || "").includes('"reader_resolve"') ? route.abort() : route.continue()));
  await citationToReader(p, "block-c1");
  check((await rtxt(p, "#hq-carnet-reader-name")) === "Machinery" && (await rtxt(p, "#hq-carnet-reader-line-pdf")).includes("417"), "the stored citation is shown");
  check((await rtxt(p, "#hq-carnet-reader-reason")).includes("Lecture indisponible") && (await rtxt(p, "#hq-carnet-reader-source-state")).includes("inconnu"), "failure stated plainly; source state unknown");
  check((await p.locator("#hq-carnet-reader-frame").count()) === 0, "no PDF frame without an answer");
});

scenario("21 keyboard on desktop: Tab / Shift+Tab containment and Escape", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 5, ok: true } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  check((await activeInfo(p, R)).inside, "focus starts inside the Reader");
  for (let i = 0; i < 25; i += 1) {
    await p.keyboard.press("Tab");
    if (!(await activeInfo(p, R)).inside) throw new Error("FAIL: focus left the Reader on Tab " + (i + 1));
  }
  check(true, "Tab x25 stays inside the Reader (the PDF frame may hold focus; the Close button stays reachable)");
  await p.evaluate(() => document.getElementById("btn-carnet-reader-close").focus());
  await p.keyboard.press("Shift+Tab");
  check((await activeInfo(p, R)).inside, "Shift+Tab stays inside");
  await p.evaluate(() => document.getElementById("hq-carnet-editor").focus());
  check((await activeInfo(p, R)).inside, "focus cannot be moved to the page behind");
  const labels = await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-reader button")].map((b) => b.getAttribute("aria-label") || b.textContent));
  check(labels.includes("Page PDF suivante") && labels.includes("Page PDF précédente"), "page buttons are labelled: " + labels.join(" | "));
  await p.click("#btn-carnet-reader-next");
  check((await rtxt(p, "#hq-carnet-reader-page")).includes("Page PDF 6") && (await iframeSrc(p)).endsWith("#page=6"), "next page = PDF page 6, fresh frame");
  await p.click("#btn-carnet-reader-cited");
  check((await iframeSrc(p)).endsWith("#page=5"), "'Page citée' returns to the cited PDF page");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "Escape closes the Reader");
});

scenario("22 phone: Reader fills the screen, targets >= 40px, no horizontal scroll, Tab / Shift+Tab containment, Escape and the Close button", async () => {
  const { srv, ctx, p } = await world("iphone");
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 5, ok: true } }]);
  await reopen(p);
  await citationToReader(p, "block-c1");
  const m = await p.evaluate(() => {
    const r = document.getElementById("hq-carnet-reader").getBoundingClientRect();
    const small = [...document.querySelectorAll("#hq-carnet-reader button, #hq-carnet-reader a.carnet-small")].filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 40).map((b) => b.id || b.textContent);
    return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, sx: document.documentElement.scrollWidth, small };
  });
  check(m.w >= m.vw - 1 && m.h >= m.vh - 1, "Reader covers the viewport: " + JSON.stringify([m.w, m.h, m.vw, m.vh]));
  check(m.sx <= m.vw + 1, "no horizontal scroll: " + m.sx + " <= " + m.vw);
  await shot(p, "22-reader-phone");
  check(m.small.length === 0, "tap targets >= 40px: " + JSON.stringify(m.small));
  for (let i = 0; i < 15; i += 1) {
    await p.keyboard.press("Tab");
    if (!(await activeInfo(p, R)).inside) throw new Error("FAIL: focus left the Reader on Tab " + (i + 1));
  }
  check(true, "Tab x15 stays inside on phone");
  await p.keyboard.press("Shift+Tab");
  check((await activeInfo(p, R)).inside, "Shift+Tab stays inside on phone");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "Escape closes it on phone (hardware keyboard)");
  check((await activeInfo(p, SL)).id === "btn-carnet-src-reader", "focus back on the exact opener after Escape");
  await p.tap("#btn-carnet-src-reader");
  await p.waitForSelector(R);
  await painted(p);
  await p.tap("#btn-carnet-reader-close");
  await until(async () => (await p.locator(R).count()) === 0, "Close button closes it");
  check((await activeInfo(p, SL)).id === "btn-carnet-src-reader", "focus back on the exact opener");
});

scenario("23 desktop screenshot: a plain citation after the source was renamed and its file replaced shows the current file (visual record)", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx, "Frozen title");
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  const snap = await cpost(srv, ctx, { action: "snapshot_create", request_id: rid(), project_id: "proj-1", label: "Gel A" });
  await cpost(srv, ctx, { action: "source_edition_update", id: ed.id, expected_rev: (await cget(srv, ctx, "sources=1")).body.editions.find((e) => e.id === ed.id).rev, title: "Renamed" });
  writeFileSync(path.join(srv.root, "Uni", ed._name), PDF_B);
  await reopen(p);
  await p.click(`[data-carnet-block-id="block-c1"] [data-carnet-citation]`);
  await p.waitForSelector(SL, { state: "visible" });
  await p.click("#btn-carnet-src-reader");
  await p.waitForSelector(R);
  await painted(p);
  check((await p.locator("#hq-carnet-reader-frame").count()) === 1, "a plain citation (no frozen context) shows the current file");
  await shot(p, "23-reader-current");
});

scenario("24 PDF frame is visual-only for the keyboard: focusable frame fixture, click / focus into it → the Reader reclaims focus, Escape closes, exact opener focused", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx);
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { pdf: 5, ok: true } }]);
  await reopen(p);
  // headless Chromium has no PDF viewer: stand in a focusable same-origin document that, like a native viewer, keeps keyboard focus
  await p.route("**/files/Uni/*.pdf*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><title>fixture</title><input id="fx" aria-label="fixture"><button id="fb">fixture button</button><script>document.addEventListener("keydown",function(e){e.stopPropagation()},true)</script>' }));
  await citationToReader(p, "block-c1");
  await p.waitForSelector("#hq-carnet-reader-frame");
  check((await p.getAttribute("#hq-carnet-reader-frame", "tabindex")) === "-1", "the frame is out of the tab order");
  const inFrame = () => p.evaluate(() => document.activeElement && document.activeElement.id === "hq-carnet-reader-frame");
  for (let i = 0; i < 25; i += 1) {
    await p.keyboard.press("Tab");
    if (await inFrame()) throw new Error("FAIL: Tab reached the PDF frame on press " + (i + 1));
  }
  check((await activeInfo(p, R)).inside, "Tab x25 never enters the frame; focus stays in the Reader");
  const f = p.frameLocator("#hq-carnet-reader-frame");
  await f.locator("#fx").waitFor();
  await f.locator("#fx").click(); // a real click into the embedded document
  await until(async () => !(await inFrame()), "the Reader reclaims focus from the frame");
  check((await activeInfo(p, R)).inside, "focus is back inside the Reader after clicking into the frame");
  await p.evaluate(() => document.getElementById("hq-carnet-reader-frame").focus()); // and a programmatic focus attempt
  await until(async () => !(await inFrame()), "the Reader reclaims a programmatic focus too");
  check((await activeInfo(p, R)).inside, "still inside the Reader");
  await p.keyboard.press("Escape");
  await until(async () => (await p.locator(R).count()) === 0, "Escape still closes the Reader after the frame was clicked");
  check((await activeInfo(p, SL)).id === "btn-carnet-src-reader", "the exact opener received focus: " + JSON.stringify(await activeInfo(p, SL)));
  await p.unroute("**/files/Uni/*.pdf*");
});

scenario("25 verified frozen PDF: every refusal has its own wording (changed / gone / cannot verify / too large / unavailable / access); never 'changed' by default; no 'identique' banner survives", async () => {
  const { srv, ctx, p } = await world();
  const ed = await mkEd(srv, ctx, "Frozen title");
  await withCites(srv, ctx, [{ ed, id: "block-c1", o: { ok: true } }]);
  const snap = await cpost(srv, ctx, { action: "snapshot_create", request_id: rid(), project_id: "proj-1", label: "Gel A" });
  const rv = (await cpost(srv, ctx, { action: "review_create", project_id: "proj-1", title: "Revue banc", request_id: rid(), baseline: { kind: "snapshot", snapshot_id: snap.body.snapshot.id } })).body.review;
  check((await cpost(srv, ctx, { action: "review_item_add", id: rv.id, expected_rev: rv.rev, item: { kind: "source", edition_id: ed.id } })).status === 200, "frozen source evidence added");
  await reopen(p);
  const file = path.join(srv.root, "Uni", ed._name);
  const openIt = async () => {
    if (await p.locator("#hq-carnet-rv").isHidden().catch(() => true)) {
      if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
      await p.click("#btn-carnet-reviews");
      await p.waitForSelector("#hq-carnet-rv", { state: "visible" });
      await p.click('[data-rv="open"]');
      await p.waitForSelector("#hq-carnet-rv-name");
      await p.click('[data-rv-tab="evidence"]');
    }
    await p.click('[data-rv="open-reader"]');
    await p.waitForSelector(R);
    await painted(p);
  };
  const T = {
    changed: "Le fichier a changé depuis le scellé : l’évidence figée n’est pas affichée.",
    gone: "Le fichier scellé n’est plus disponible : l’évidence figée ne peut pas être affichée.",
    unreadable: "Le fichier scellé ne peut être ni vérifié ni lu : l’évidence figée n’est pas affichée.",
    large: "Le fichier scellé est trop volumineux pour être vérifié et affiché ici : l’évidence figée n’est pas affichée.",
    unavail: "L’évidence figée n’est pas disponible (instantané illisible ou sans fichier scellé) : aucun fichier n’est affiché.",
    access: "Session expirée ou accès refusé : le document ne peut pas être affiché.",
  };
  const upCtx = await browser.newContext();
  const upLogin = await upCtx.request.post(srv.base + "/login", { form: { pin: srv.upload_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(upLogin.status() === 303, "upload-role login");
  const upCookie = (await upCtx.storageState()).cookies.map((c) => c.name + "=" + c.value).join("; ");
  await upCtx.close();
  const cases = [
    { name: "real mismatch", want: T.changed, state: "differs", act: () => writeFileSync(file, PDF_B) },
    { name: "real: sealed file gone between resolve and GET", want: T.gone, state: "missing", act: () => rmSync(file) },
    { name: "real: target replaced by a symlink (non-canonical)", want: T.unreadable, state: "unknown", act: () => { rmSync(file); writeFileSync(file + ".real", PDF); symlinkSync(file + ".real", file); } },
    { name: "too large (413 sealed_file_too_large)", want: T.large, state: "unknown", fake: [413, '{"error":"x","code":"sealed_file_too_large"}'] },
    { name: "unreadable (409 sealed_file_unreadable)", want: T.unreadable, state: "unknown", fake: [409, '{"error":"x","code":"sealed_file_unreadable"}'] },
    { name: "storage error (503)", want: T.unreadable, state: "unknown", fake: [503, '{"error":"x","code":"storage_error"}'] },
    { name: "frozen evidence unavailable (404)", want: T.unavail, state: "unavailable", fake: [404, '{"error":"x","code":"frozen_unavailable"}'] },
    { name: "no sealed file (404)", want: T.unavail, state: "unavailable", fake: [404, '{"error":"x","code":"no_sealed_file"}'] },
    { name: "REAL gate: expired / no session → real 401 from the generic auth gate", want: T.access, state: "unknown", real: () => ({ cookie: "" }), status: 401 },
    { name: "REAL gate: authenticated upload role → real 403 from the admin guard", want: T.access, state: "unknown", real: () => ({ cookie: upCookie }), status: 403 },
    { name: "intercepted: 401 without a code", want: T.access, state: "unknown", fake: [401, '{"error":"PIN requis"}'] },
    { name: "intercepted: 403 without a code", want: T.access, state: "unknown", fake: [403, '{"error":"Réservé admin"}'] },
  ];
  for (const c of cases) {
    rmSync(file, { force: true }); // (a previous case may have left a symlink here)
    rmSync(file + ".real", { force: true });
    writeFileSync(file, PDF);
    await p.route("**/api/carnet/reader-pdf*", async (route) => {
      if (c.fake) await route.fulfill({ status: c.fake[0], contentType: "application/json", body: c.fake[1] });
      else if (c.real) {
        // the REAL server answers (generic auth gate / admin guard) to a request carrying another session; Playwright only relays it
        const resp = await route.fetch({ headers: Object.assign({}, route.request().headers(), c.real()) });
        c.seen = { status: resp.status(), xfo: resp.headers()["x-frame-options"] || "", type: resp.headers()["content-type"] || "", cache: resp.headers()["cache-control"] || "" };
        await route.fulfill({ response: resp });
      } else {
        c.act();
        await route.continue();
      }
    });
    await openIt();
    await until(async () => await p.locator("#hq-carnet-reader-autherr").isVisible(), c.name + ": refusal shown");
    const msg = await rtxt(p, "#hq-carnet-reader-autherr");
    check(msg === c.want, c.name + " → " + msg);
    check((await rtxt(p, "#hq-carnet-reader-banner")) === c.want && (await p.getAttribute("#hq-carnet-reader-banner", "data-state")) === c.state, c.name + ": banner carries the same state, no 'identique' left: " + (await rtxt(p, "#hq-carnet-reader-banner")));
    check(!(await rtxt(p, "#hq-carnet-reader-banner")).includes("identique") && (await p.locator("#hq-carnet-reader-frame").isHidden()), c.name + ": nothing is displayed");
    if (c.real) check(c.seen.status === c.status && c.seen.xfo === "SAMEORIGIN" && c.seen.type.startsWith("application/json") && c.seen.cache === "no-store", c.name + ": real response is frame-readable: " + JSON.stringify(c.seen));
    if (c.want !== T.changed) check(msg !== T.changed, c.name + ": never reported as 'changed'");
    await p.unroute("**/api/carnet/reader-pdf*");
    await p.keyboard.press("Escape");
    await until(async () => (await p.locator(R).count()) === 0, c.name + ": closed");
  }
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
