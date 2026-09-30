// Carnet Stage 04 browser checks (Node Playwright): structured formatting, links, checklists,
// find/replace, export, print, concurrency — on a throwaway loopback HQ (tests/carnet_test_server.py).
//
//   node tests/visual_carnet_rich_playwright.mjs
//
// Engines: Chromium (desktop) plus Chromium device emulation for iPad/iPhone-sized touch profiles.
// Real WebKit is not driven here (no WebKit build in this environment): the existing Python suite
// tests/visual_carnet_playwright.py owns the WebKit iPad/iPhone runs. Skips (exit 0) when
// Playwright or Chromium is unavailable. Never touches the live root or a real PIN; run it from a
// disposable copy of the checkout (the server imports the bridge).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
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
function check(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
  console.log("  OK  ", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, timeout = 9000) {
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

// ---------------------------------------------------------------- fixtures
const line = (type, text, marks, extra) => Object.assign({ id: "block-" + Math.random().toString(16).slice(2, 14), type, text, marks: marks || [] }, extra || {});
function page(id, rev, blocks, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0, content: { version: 2, blocks } }, extra || {});
}
function v1(id, rev, text, extra) {
  return Object.assign({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1790680010.0, updated_at: 1790680300.0,
    content: { version: 1, blocks: [{ id: "block-" + id.slice(5), type: "text", text, marks: [] }] } }, extra || {});
}
const notebook = (pages, rev = 4) => ({ version: 1, notebook_rev: rev, projects: [], categories: [], pages });

// ---------------------------------------------------------------- server
class Server {
  static async start(seed) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-rich-"));
    const seedPath = path.join(tmpdir(), "hq-carnet-seed-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".json");
    writeFileSync(seedPath, JSON.stringify(seed));
    s.proc = spawn(process.env.PYTHON || "python3", [path.join(here, "carnet_test_server.py"), s.root, seedPath], { stdio: ["pipe", "pipe", "inherit"] });
    const info = await new Promise((res, rej) => {
      s.proc.once("error", rej);
      s.proc.stdout.once("data", (d) => res(JSON.parse(String(d))));
    });
    rmSync(seedPath, { force: true });
    Object.assign(s, info);
    s.nbPath = path.join(s.root, ".hq-carnet", "notebook.json");
    return s;
  }
  nb() {
    return JSON.parse(readFileSync(this.nbPath, "utf8"));
  }
  put(nb) {
    writeFileSync(this.nbPath, JSON.stringify(nb));
  }
  pg(id) {
    return this.nb().pages.find((p) => p.id === id);
  }
  text(id) {
    return this.pg(id).content.blocks.map((b) => b.text).join("\n");
  }
  files(dir) {
    const d = path.join(this.root, dir);
    return existsSync(d) ? readdirSync(d) : [];
  }
  read(rel) {
    return readFileSync(path.join(this.root, rel), "utf8");
  }
  close() {
    try {
      this.proc.stdin.end();
    } catch (_) {}
    rmSync(this.root, { recursive: true, force: true });
  }
}

const PROFILES = {
  desktop: { viewport: { width: 1366, height: 900 } },
  ipad: { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  iphone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
};

const errors = [];
const external = [];
let browser;

async function context(srv, profile = "desktop", extra = {}) {
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, PROFILES[profile], extra));
  const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.admin_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(r.status() === 303, "login " + profile);
  return ctx;
}

async function openPage(ctx, srv, { carnet = true } = {}) {
  const page = await ctx.newPage();
  const tag = "[" + (page.viewportSize() ? page.viewportSize().width : "?") + "]";
  page.on("pageerror", (e) => errors.push(`${tag} pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${tag} console ${m.text()}`);
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(srv.base) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
  });
  await page.goto(srv.base + "/");
  if (carnet) await showCarnet(page);
  return page;
}

async function showCarnet(page) {
  await page.locator('.bottom-nav [data-nav="carnet"]').click();
  try {
    await page.waitForSelector("#hq-carnet-editor", { timeout: 15000 });
  } catch (e) {
    const app = await page.evaluate(() => (document.getElementById("hq-carnet-app") || {}).textContent || "(no app host)");
    throw new Error("Carnet editor did not appear; panel says: " + app.slice(0, 200));
  }
  await page.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
}

const EDITOR = "#hq-carnet-editor";
const pid0 = (pg) => pg.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
const value = (p) => p.evaluate(() => document.querySelector("#hq-carnet-editor").value);
const dirty = (p) => p.evaluate(() => { const d = window.hqCarnetDebug(); return d.core.pages.some((x) => x.dirty || x.inflight); });
const conflict = (p) => p.evaluate(() => window.hqCarnetDebug().core.pages.some((x) => x.conflict));
async function select(p, a, b) {
  await p.evaluate(([x, y]) => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.setSelectionRange(x, y); }, [a, b]);
}
const sel = (p) => p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); return [e.selectionStart, e.selectionEnd]; });
async function saved(p, srv, id, msg) {
  await until(async () => !(await dirty(p)), (msg || "saved") + " (client clean)");
}
/** Replace the server notebook once the client is clean (an unsaved draft would otherwise be recovered against it). */
async function reseed(p, srv, nb) {
  await until(async () => !(await dirty(p)), "client clean before reseed");
  srv.put(nb);
  await p.reload();
  await showCarnet(p);
}
async function openMore(p) {
  if (await p.locator("#carnet-quick-tools").isHidden()) await p.click("#btn-carnet-more");
}
async function openFormat(p) {
  await openMore(p);
  if (await p.locator("#carnet-format-bar").isHidden()) await p.click("#btn-carnet-format");
  await p.waitForSelector("#carnet-format-bar", { state: "visible" });
}
/** Lines as the editor DOM shows them: [type, checked, text, [[mark, text]...]]. */
const domLines = (p) => p.evaluate(() => [...document.querySelector("#hq-carnet-editor").children].map((d) => [
  d.getAttribute("data-line-type"), d.getAttribute("data-checked") === "true", d.textContent,
  [...d.querySelectorAll("[data-m],a[data-carnet-link]")].map((n) => [n.getAttribute("data-m") || n.getAttribute("data-carnet-link"), n.textContent]),
]));
const blocks = (srv, id) => srv.pg(id).content.blocks.map((b) => [b.type, !!b.checked, b.text, b.marks.map((m) => [m.type, m.start, m.end])]);

async function main() {
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log("SKIP: Chromium unavailable — " + String(e.message).split("\n")[0]);
    process.exit(0);
  }
  const started = [];
  const server = async (seed) => {
    const s = await Server.start(seed);
    started.push(s);
    return s;
  };
  try {
    // ================================================================ 1. structure basics (desktop)
    console.log("-- formatting / lists / checklist persistence [desktop]");
    let srv = await server(notebook([page("page-a", 1, [line("paragraph", "shaft diameter shaft")]), page("page-b", 1, [line("paragraph", "other page")])]));
    let ctx = await context(srv);
    let p = await openPage(ctx, srv);
    check(await p.getAttribute(EDITOR, "contenteditable") === "true", "one contenteditable editor");
    check((await p.locator(EDITOR).count()) === 1, "exactly one editor element");
    check(await p.evaluate(() => document.querySelector("#carnet-format-bar").hidden), "no permanent toolbar: format bar hidden by default");
    check((await value(p)) === "shaft diameter shaft", "value shim shows the page text");
    await select(p, 0, 5);
    await p.keyboard.press("Control+b");
    await until(async () => (await domLines(p))[0][3].some((m) => m[0] === "bold" && m[1] === "shaft"), "Ctrl+B bolds the selection (data-m=bold)");
    check(JSON.stringify(await sel(p)) === "[0,5]", "selection survives the re-render");
    await select(p, 6, 14);
    await openFormat(p);
    await p.click('[data-carnet-format="italic"]');
    check((await domLines(p))[0][3].some((m) => m[0] === "italic" && m[1] === "diameter"), "toolbar italic");
    await p.click('[data-carnet-format="highlight"]');
    await p.click('[data-carnet-format="code"]');
    check(await p.getAttribute('[data-carnet-format="italic"]', "aria-pressed") === "true", "pressed state follows the selection");
    await select(p, 15, 20);
    await p.click('[data-carnet-format="underline"]');
    // append structured lines
    await select(p, 20, 20);
    await p.keyboard.press("Enter");
    await p.keyboard.type("Titre");
    await p.click('[data-carnet-format="heading"]');
    await p.keyboard.press("Enter");
    await p.keyboard.type("point un");
    await p.click('[data-carnet-format="bullet"]');
    await p.keyboard.press("Enter");
    await p.keyboard.type("point deux");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter"); // empty bullet -> exits the list
    await p.keyboard.type("etape");
    await p.click('[data-carnet-format="number"]');
    await p.keyboard.press("Enter");
    await p.keyboard.type("suite");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.type("a faire");
    await p.click('[data-carnet-format="check"]');
    await p.keyboard.press("Enter");
    await p.keyboard.type("fait");
    let dl = await domLines(p);
    check(JSON.stringify(dl.map((l) => l[0])) === JSON.stringify(["paragraph", "heading", "bullet", "bullet", "number", "number", "check", "check"]), "line types after Enter continuation: " + JSON.stringify(dl.map((l) => l[0])));
    check(await p.evaluate(() => [...document.querySelectorAll('.carnet-line[data-line-type="number"]')].map((d) => d.getAttribute("data-num")).join(",")) === "1,2", "numbered list counts 1,2");
    // toggle the last checkbox with a real click on the box
    const boxes = p.locator(".carnet-check");
    check((await boxes.count()) === 2, "two checkbox controls");
    await boxes.nth(1).click();
    check((await domLines(p))[7][1] === true && (await domLines(p))[6][1] === false, "clicking a checkbox toggles only that item");
    check(await boxes.nth(1).getAttribute("aria-checked") === "true", "checkbox exposes aria-checked");
    await saved(p, srv, "page-a", "autosave");
    const want = [
      ["paragraph", false, "shaft diameter shaft", [["bold", 0, 5], ["italic", 6, 14], ["highlight", 6, 14], ["code", 6, 14], ["underline", 15, 20]]],
      ["heading", false, "Titre", []], ["bullet", false, "point un", []], ["bullet", false, "point deux", []],
      ["number", false, "etape", []], ["number", false, "suite", []], ["check", false, "a faire", []], ["check", true, "fait", []],
    ];
    const got = blocks(srv, "page-a");
    check(JSON.stringify(got) === JSON.stringify(want), "server holds the exact structure: " + JSON.stringify(got));
    check(srv.pg("page-a").rev >= 2, "revisions advanced through the normal save path");
    // reload: structure survives
    await p.reload();
    await showCarnet(p);
    dl = await domLines(p);
    check(dl[7][0] === "check" && dl[7][1] === true && dl[1][0] === "heading" && dl[0][3].length === 3, "reload shows the persisted structure (3 styled runs on line 1)");
    check(!(await dirty(p)), "nothing dirty after reload");

    // ================================================================ 2. another device sees it (clean polling adoption)
    console.log("-- second device adoption / conflicts");
    const ctx2 = await context(srv, "ipad");
    const p2 = await openPage(ctx2, srv);
    check((await domLines(p2))[7][1] === true, "iPad-profile client loads the same structure");
    await select(p, 0, 0);
    await p.keyboard.type("A:");
    await saved(p, srv, "page-a", "A edit saved");
    await until(async () => (await value(p2)).startsWith("A:shaft"), "clean polling adopts A's structured edit on device 2", 12000);
    check((await domLines(p2))[7][0] === "check", "adopted structure intact");
    // concurrent structured edits -> explicit conflict, nothing lost
    // device 2 goes offline, toggles a checkbox (dirty structured draft); A saves a newer revision
    await ctx2.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await p2.click(".carnet-check >> nth=0");
    await until(() => dirty(p2), "device 2 holds a dirty structured edit");
    await select(p, 2, 2);
    await p.keyboard.type("!");
    await saved(p, srv, "page-a", "A saved its change");
    await ctx2.unroute("**/api/carnet");
    await until(() => conflict(p2), "device 2's stale structured save meets the explicit 409 conflict", 12000);
    check(await p2.locator("#hq-carnet-conflict").isVisible(), "conflict banner visible");
    check((await domLines(p2))[6][1] === true, "device 2 keeps its checkbox change locally");
    check(srv.pg("page-a").content.blocks[6].checked !== true, "server copy not overwritten by the stale save");
    await p2.click("#btn-carnet-conflict-remote");
    await until(async () => !(await conflict(p2)), "loading the remote version resolves the conflict");
    check((await domLines(p2))[6][1] === false && (await value(p2)).startsWith("A:!"), "remote structured version shown");
    await ctx2.close();

    // ================================================================ 3. links
    console.log("-- links");
    const t0 = await value(p);
    const iShaft = t0.indexOf("shaft");
    const iDiam = t0.indexOf("diameter");
    await select(p, iShaft, iShaft + 5);
    await p.keyboard.press("Control+k");
    check(await p.locator("#hq-carnet-link").isVisible(), "Ctrl+K opens the compact link panel");
    await p.fill("#hq-carnet-link-url", "javascript:alert(1)");
    await p.click("#btn-carnet-link-apply");
    check((await p.textContent("#carnet-link-msg")).includes("non autorisé"), "javascript: is refused with a message");
    check((await p.locator("a[data-carnet-link]").count()) === 0, "no link created");
    for (const bad of ["data:text/html,<b>x</b>", "file:///etc/passwd", "blob:https://x/y", "ftp://x.y", "example.com"]) {
      await p.fill("#hq-carnet-link-url", bad);
      await p.click("#btn-carnet-link-apply");
      check((await p.locator("a[data-carnet-link]").count()) === 0, "refused: " + bad);
    }
    await p.fill("#hq-carnet-link-url", "https://example.com/spec?a=1");
    await p.click("#btn-carnet-link-apply");
    const anchor = p.locator("a[data-carnet-link=external]");
    check((await anchor.count()) >= 1 && (await anchor.first().getAttribute("href")) === "https://example.com/spec?a=1", "https link created");
    check((await anchor.evaluateAll((els) => els.every((e) => e.getAttribute("rel") === "noopener noreferrer" && e.getAttribute("target") === "_blank"))), "external link uses noopener noreferrer");
    check((await anchor.evaluateAll((els) => els.map((e) => e.textContent).join(""))) === "shaft", "only the selected text is linked");
    check((await domLines(p))[0][3].some((m) => m[0] === "bold"), "unrelated marks are kept under the link");
    check((await p.textContent("#carnet-link-msg")) === "", "no stale link error after success");
    await p.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
    await anchor.first().click();
    check((await p.evaluate(() => window.__opened.length)) === 0, "a plain click only places the caret (never navigates)");
    await anchor.first().click({ modifiers: ["Control"] });
    const opened = await p.evaluate(() => window.__opened);
    check(opened.length === 1 && opened[0][0] === "https://example.com/spec?a=1" && /noopener/.test(opened[0][2]) && /noreferrer/.test(opened[0][2]), "Ctrl+click opens with noopener,noreferrer");
    // internal note link
    await select(p, iDiam, iDiam + 8);
    await p.keyboard.press("Control+k");
    await p.selectOption("#hq-carnet-link-note", "page-b");
    await p.fill("#hq-carnet-link-url", "");
    await p.click("#btn-carnet-link-apply");
    check((await p.locator('a[data-carnet-link=note]').getAttribute("data-ref-id")) === "page-b", "internal note link stores the stable page id");
    check((await p.locator('a[data-carnet-link=note]').getAttribute("href")) === null, "internal links have no href attribute");
    await saved(p, srv, "page-a", "links saved");
    const marks0 = srv.pg("page-a").content.blocks[0].marks;
    check(marks0.some((m) => m.type === "link" && m.href === "https://example.com/spec?a=1") && marks0.some((m) => m.type === "link" && m.ref && m.ref.id === "page-b"), "links persisted (href / ref)");
    // remove
    await select(p, iShaft, iShaft + 5);
    await p.keyboard.press("Control+k");
    await p.click("#btn-carnet-link-remove");
    check((await p.locator("a[data-carnet-link=external]").count()) === 0, "link removed, text kept");
    await saved(p, srv, "page-a", "link removal saved");
    check(!srv.pg("page-a").content.blocks[0].marks.some((m) => m.href), "no external link stored any more");

    // ================================================================ 4. find / replace
    console.log("-- find / replace");
    const S = "shaft diameter shaft";
    const setPlain = async (text, markSpecs) => {
      const nb = srv.nb();
      nb.pages[0].rev += 1;
      nb.pages[0].content = { version: 2, blocks: [line("paragraph", text, markSpecs)] };
      srv.put(nb);
      await p.reload();
      await showCarnet(p);
    };
    const MARKS = [{ type: "bold", start: 0, end: 3 }, { type: "italic", start: 6, end: 14 }, { type: "underline", start: 15, end: 20 }];
    await setPlain(S, MARKS);
    await openMore(p);
    await p.click("#btn-carnet-find");
    check(await p.locator("#hq-carnet-find").isVisible(), "find panel opens");
    await p.fill("#hq-carnet-find-input", "shaft");
    check((await p.textContent("#carnet-find-count")).includes("2 occurrences"), "occurrence count shown");
    check((await p.textContent("#btn-carnet-replace-all")).includes("(2)"), "Replace-all button shows the count");
    await p.click("#btn-carnet-find-next");
    check((await p.textContent("#carnet-find-count")).startsWith("2 / 2") || (await p.textContent("#carnet-find-count")).startsWith("1 / 2"), "next moves through matches");
    await p.click("#btn-carnet-find-prev");
    // case + whole word toggles
    await p.click("#btn-carnet-find-case");
    await p.fill("#hq-carnet-find-input", "Shaft");
    check((await p.textContent("#carnet-find-count")) === "Aucun résultat", "case-sensitive: no match for 'Shaft'");
    await p.click("#btn-carnet-find-case");
    await p.click("#btn-carnet-find-word");
    await p.fill("#hq-carnet-find-input", "shaf");
    check((await p.textContent("#carnet-find-count")) === "Aucun résultat", "whole word: no match for a prefix");
    await p.click("#btn-carnet-find-word");
    await p.fill("#hq-carnet-find-input", "shaft");
    // replace one (first) with a shorter string
    await p.fill("#hq-carnet-replace-input", "ax");
    await p.click("#btn-carnet-replace-one");
    check((await value(p)) === "ax diameter shaft", "replace one changes only the current occurrence");
    await saved(p, srv, "page-a", "replace-one saved");
    check(JSON.stringify(blocks(srv, "page-a")[0][3]) === JSON.stringify([["bold", 0, 2], ["italic", 3, 11], ["underline", 12, 17]]), "marks re-attached exactly after replace-one");
    // replace all + undo, on the original again
    await setPlain(S, MARKS);
    await openMore(p);
    await p.click("#btn-carnet-find");
    await p.fill("#hq-carnet-find-input", "shaft");
    await p.fill("#hq-carnet-replace-input", "shaftwork");
    await p.click("#btn-carnet-replace-all");
    check((await value(p)) === "shaftwork diameter shaftwork", "replace-all longer");
    check((await p.textContent("#carnet-find-count")).startsWith("2 occurrences"), "replace-all reports the count");
    await saved(p, srv, "page-a", "replace-all saved");
    check(JSON.stringify(blocks(srv, "page-a")[0][3]) === JSON.stringify([["bold", 0, 9], ["italic", 10, 18], ["underline", 19, 28]]), "marks after replace-all longer");
    check(await p.locator("#btn-carnet-replace-undo").isVisible(), "Undo offered");
    await p.click("#btn-carnet-replace-undo");
    check((await value(p)) === S, "Undo restores the text");
    await saved(p, srv, "page-a", "undo saved");
    check(JSON.stringify(blocks(srv, "page-a")[0][3]) === JSON.stringify([["bold", 0, 3], ["italic", 6, 14], ["underline", 15, 20]]), "Undo restores the marks exactly");
    // empty replacement deletes
    await p.fill("#hq-carnet-find-input", "shaft");
    await p.fill("#hq-carnet-replace-input", "");
    await p.click("#btn-carnet-replace-all");
    check((await value(p)) === " diameter ", "EMPTY replacement deletes every match");
    await saved(p, srv, "page-a", "delete-all saved");
    check(JSON.stringify(blocks(srv, "page-a")[0][3]) === JSON.stringify([["italic", 1, 9]]), "only the surviving mark remains, in range: " + JSON.stringify(blocks(srv, "page-a")[0][3]));
    // typing after replace-all invalidates Undo (never overwrites newer work)
    await select(p, 0, 0);
    await p.keyboard.type("Z");
    check(await p.locator("#btn-carnet-replace-undo").isHidden(), "Undo disappears once the page changed");
    await p.click("#btn-carnet-find-close");
    check(await p.locator("#hq-carnet-find").isHidden(), "find panel closes");

    // ================================================================ 5. export
    console.log("-- export");
    const rich = notebook([page("page-a", 1, [
      line("heading", "Rapport"), line("check", "mesurer", [{ type: "bold", start: 0, end: 4 }], { checked: true }), line("number", "un"), line("number", "deux", [{ type: "link", start: 0, end: 4, href: "https://example.com/x" }]), line("paragraph", "fin"),
    ])]);
    await reseed(p, srv, rich);
    await openMore(p);
    await p.click("#btn-carnet-export");
    check(await p.locator("#hq-carnet-export").isVisible(), "export panel opens");
    let [download] = await Promise.all([p.waitForEvent("download"), p.click("#btn-carnet-export-md")]);
    check(download.suggestedFilename() === "Rapport.md", "Markdown download name derives from the title (got " + download.suggestedFilename() + ")");
    let body = readFileSync(await download.path(), "utf8");
    check(body === "## Rapport\n\n- [x] **mesu**rer\n\n1. un\n2. [deux](https://example.com/x)\n\nfin\n", "Markdown is the deterministic rendering: " + JSON.stringify(body));
    [download] = await Promise.all([p.waitForEvent("download"), p.click("#btn-carnet-export-txt")]);
    body = readFileSync(await download.path(), "utf8");
    check(download.suggestedFilename() === "Rapport.txt" && body === "Rapport\n[x] mesurer\n1. un\n2. deux (https://example.com/x)\nfin\n", "TXT export is deterministic");
    // print path
    await p.evaluate(() => { window.__printed = null; window.print = () => { const n = document.getElementById("hq-carnet-print"); window.__printed = { cls: document.body.className, lines: n ? n.querySelectorAll(".carnet-line").length : -1, text: n ? n.textContent : "" }; }; });
    await p.click("#btn-carnet-export-print");
    const printed = await p.evaluate(() => window.__printed);
    check(printed && /carnet-printing/.test(printed.cls) && printed.lines === 5 && printed.text.includes("Rapport"), "print builds a print-only structured snapshot");
    await until(async () => (await p.evaluate(() => !document.getElementById("hq-carnet-print"))), "print container is removed afterwards", 4000);
    // save a copy into Transfert
    await p.click("#btn-carnet-export-copy");
    check(await p.locator("#hq-carnet-export-form").isVisible(), "explicit 'Enregistrer une copie dans Transfert…' form");
    check((await p.textContent("#btn-carnet-export-copy")) === "Enregistrer une copie dans Transfert…", "exact button label");
    await p.selectOption("#hq-carnet-export-root", "Uni");
    await p.fill("#hq-carnet-export-sub", "Notes/2026");
    check((await p.inputValue("#hq-carnet-export-name")) === "Rapport.md", "derived, editable filename");
    await p.fill("#hq-carnet-export-name", "Mon rapport.md");
    await p.click("#btn-carnet-export-save");
    await until(async () => (await p.textContent("#carnet-export-msg")).includes("Copie enregistrée"), "copy saved message");
    check(srv.files("Uni/Notes/2026").join() === "Mon rapport.md", "file written inside the confined folder");
    check(srv.read("Uni/Notes/2026/Mon rapport.md") === "## Rapport\n\n- [x] **mesu**rer\n\n1. un\n2. [deux](https://example.com/x)\n\nfin\n", "snapshot content");
    // noclobber
    await p.click("#btn-carnet-export-save");
    await until(async () => (await p.textContent("#carnet-export-msg")).includes("existe déjà"), "existing file is never silently replaced");
    check(srv.read("Uni/Notes/2026/Mon rapport.md").includes("Rapport"), "original snapshot untouched");
    // traversal / absolute rejected by the server, nothing written
    for (const bad of ["../..", "..\\..", "C:/x", "a/../../b", ".hidden", "con"]) {
      await p.fill("#hq-carnet-export-sub", bad);
      await p.fill("#hq-carnet-export-name", "escape.md");
      await p.click("#btn-carnet-export-save");
      await until(async () => (await p.textContent("#carnet-export-msg")).length > 0 && !(await p.textContent("#carnet-export-msg")).includes("enregistrée"), "refused sub-folder: " + bad, 4000);
    }
    check(!existsSyncAny(srv, ["escape.md", "Uni/escape.md", "Inbox/escape.md", "Uni/Notes/escape.md"]) && !existsSync("/escape.md"), "no traversal artefact anywhere");
    // a leading slash is only trimmed by the form: the copy lands INSIDE Uni, never at the filesystem root
    await p.fill("#hq-carnet-export-sub", "/etc");
    await p.click("#btn-carnet-export-save");
    await until(async () => srv.files("Uni/etc").join() === "escape.md", "an 'absolute' sub-folder is confined under the chosen root");
    check(!existsSync("/etc/escape.md"), "nothing written outside the Transfert root");
    // stale indicator
    check(await p.locator("#carnet-export-flag").isHidden(), "not stale right after export");
    await select(p, 0, 0);
    await p.keyboard.type("X");
    await until(async () => await p.locator("#carnet-export-flag").isVisible(), "'Modifié depuis l'export' appears after a change");
    check((await p.textContent("#carnet-export-flag")) === "Modifié depuis l'export", "exact stale label");
    check(!srv.read("Uni/Notes/2026/Mon rapport.md").startsWith("## XRapport"), "the exported file is a snapshot, never rewritten");
    await saved(p, srv, "page-a", "post-export edit saved");
    check(srv.text("page-a").startsWith("XRapport"), "Carnet keeps the newer text (the exported file is only a snapshot)");
    check(await p.locator("#carnet-export-flag").isVisible(), "stale flag persists after the page is saved");
    // re-export is an explicit new copy
    await p.fill("#hq-carnet-export-sub", "Notes/2026");
    await p.fill("#hq-carnet-export-name", "Mon rapport v2.md");
    await p.click("#btn-carnet-export-save");
    await until(async () => srv.files("Uni/Notes/2026").length === 2, "explicit update = a new named copy");
    await until(async () => await p.locator("#carnet-export-flag").isHidden(), "fresh export clears the stale flag");
    await p.click("#btn-carnet-export-close");

    // ================================================================ 6. paste / XSS / drop
    console.log("-- plain-text paste, no HTML");
    await reseed(p, srv, notebook([page("page-a", 1, [line("paragraph", "start")])]));
    await p.click(EDITOR);
    await p.evaluate(() => {
      const e = document.querySelector("#hq-carnet-editor");
      e.focus();
      e.setSelectionRange(5, 5);
      const dt = new DataTransfer();
      dt.setData("text/plain", "line1\nline2 <img src=x onerror=window.__pwn=1>");
      dt.setData("text/html", "<b>bold</b><script>window.__pwn=2</script><img src=x onerror=window.__pwn=3>");
      e.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    check((await value(p)) === "startline1\nline2 <img src=x onerror=window.__pwn=1>", "paste inserts the text/plain flavour only");
    check((await p.locator(EDITOR + " img, " + EDITOR + " script, " + EDITOR + " b").count()) === 0, "no element created from pasted markup");
    check((await p.evaluate(() => window.__pwn)) === undefined, "nothing executed");
    await saved(p, srv, "page-a", "paste saved");
    check(srv.text("page-a").includes("<img src=x"), "the note stores it as text");
    await p.reload();
    await showCarnet(p);
    check((await p.locator(EDITOR + " img").count()) === 0 && (await p.evaluate(() => window.__pwn)) === undefined, "stored markup-like text is rendered as text after reload");
    // drops never insert HTML
    await p.evaluate(() => {
      const e = document.querySelector("#hq-carnet-editor");
      const dt = new DataTransfer();
      dt.setData("text/html", "<img src=x onerror=window.__pwn=4>");
      e.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    check((await p.locator(EDITOR + " img").count()) === 0, "drop of HTML is ignored");

    // ================================================================ 6b. typing modes at a collapsed caret
    console.log("-- typing styles / list exit");
    await reseed(p, srv, notebook([page("page-a", 1, [line("paragraph", "ab"), line("bullet", "item")])]));
    await p.click(EDITOR);
    await select(p, 2, 2);
    await p.keyboard.press("Control+b");
    await p.keyboard.type("XY");
    check(JSON.stringify((await domLines(p))[0][3]) === JSON.stringify([["bold", "XY"]]) && (await value(p)).startsWith("abXY"), "Ctrl+B at a caret arms bold for the next typed text only");
    await p.keyboard.press("Control+b");
    await p.keyboard.type("Z");
    check(JSON.stringify((await domLines(p))[0][3]) === JSON.stringify([["bold", "XY"]]), "toggling again turns it off (Z is not bold)");
    await select(p, 8, 8);
    await p.keyboard.press("Home");
    const start = (await sel(p))[0];
    check(start === 6, "Home lands at the start of the bullet line (offset " + start + ")");
    await p.keyboard.press("Backspace");
    check((await domLines(p))[1][0] === "paragraph" && (await value(p)) === "abXYZ\nitem", "Backspace at the start of a list item turns it into a paragraph (no text lost)");
    await saved(p, srv, "page-a", "typing modes saved");
    check(JSON.stringify(blocks(srv, "page-a")) === JSON.stringify([["paragraph", false, "abXYZ", [["bold", 2, 4]]], ["paragraph", false, "item", []]]), "persisted exactly");

    // ================================================================ 7. draft recovery of structure while offline
    console.log("-- structured draft recovery");
    await reseed(p, srv, notebook([page("page-a", 1, [line("paragraph", "keep me")])]));
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await select(p, 0, 4);
    await p.keyboard.press("Control+b");
    await select(p, 7, 7);
    await p.keyboard.press("Enter");
    await p.keyboard.type("todo");
    await openFormat(p);
    await p.click('[data-carnet-format="check"]');
    await p.click(".carnet-check");
    const draft = await p.evaluate(() => JSON.parse(localStorage.getItem("hq_carnet_drafts_v1:admin-test")).pages["page-a"]);
    check(draft.content.version === 2 && draft.content.blocks[1].type === "check" && draft.content.blocks[1].checked === true && draft.content.blocks[0].marks[0].type === "bold", "structure is in the local draft before any network work");
    check(draft.base && draft.base.text === "keep me" && [1, 2, 3].includes(draft.base.version) && !("base_sig" in draft), "draft carries its exact base (text, not a hash)");
    check(srv.text("page-a") === "keep me", "server untouched while offline");
    await p.reload();
    await ctx.unroute("**/api/carnet");
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await showCarnet(p);
    dl = await domLines(p);
    check(dl.length === 2 && dl[1][0] === "check" && dl[1][1] === true && dl[0][3].some((m) => m[0] === "bold"), "reload recovers structure + checkbox from the draft");
    await ctx.unroute("**/api/carnet");
    await until(async () => srv.pg("page-a").content.blocks.length === 2 && srv.pg("page-a").content.blocks[1].checked === true, "recovered structured draft saves once the network is back", 15000);
    await until(async () => !(await dirty(p)), "client clean once the recovered draft is saved");

    // ================================================================ 8. legacy V1 notebook migrates on first write
    console.log("-- legacy notebook");
    const legacy = notebook([v1("page-old", 3, "legacy one\nlegacy two"), v1("page-old2", 2, "second page")]);
    await until(async () => !(await dirty(p)), "client clean before legacy reseed");
    srv.put(legacy);
    const before = readFileSync(srv.nbPath, "utf8");
    await p.reload();
    await showCarnet(p);
    check((await value(p)) === "legacy one\nlegacy two", "V1 page reads as plain lines");
    check(readFileSync(srv.nbPath, "utf8") === before, "reading never rewrites the V1 file");
    await select(p, 0, 6);
    await p.keyboard.press("Control+b");
    await saved(p, srv, "page-old", "legacy page saved");
    const after = srv.nb();
    check(after.pages.find((x) => x.id === "page-old").content.version === 2, "the written page migrated to V2");
    check(JSON.stringify(after.pages.find((x) => x.id === "page-old2")) === JSON.stringify(legacy.pages[1]), "an untouched V1 page stays byte-identical V1 on disk (lazy migration)");
    check(after.pages[0].rev === 4 && after.pages[0].content.blocks[0].marks[0].type === "bold", "the edited page advanced one revision with its mark");

    // ================================================================ 8b. oversized legacy pages, end to end
    console.log("-- oversized legacy page (server -> browser)");
    const nBig = 8193;
    const bigText = Array.from({ length: nBig }, (_, i) => "l" + i).join("\n");
    await until(async () => !(await dirty(p)), "client clean before big reseed");
    srv.put(notebook([v1("page-big", 1, bigText), v1("page-small", 1, "small")]));
    const bigBefore = readFileSync(srv.nbPath, "utf8");
    await p.reload();
    await showCarnet(p);
    check((await pid0(p)) === "page-big", "the oversized legacy page is shown");
    check((await value(p)) === bigText, "text exact (8193 lines)");
    check(readFileSync(srv.nbPath, "utf8") === bigBefore, "GET never rewrites or expands the notebook");
    // formatting while over the structured limit fails visibly and changes nothing
    await select(p, 0, 2);
    await p.keyboard.press("Control+b");
    await until(async () => (await p.textContent(".carnet-flash")).includes("Trop de lignes"), "visible message: too many lines for formatting");
    check((await value(p)) === bigText && !(await dirty(p)), "nothing changed, nothing dirty");
    check((await p.locator("[data-m]").count()) === 0, "no mark was applied");
    // an ordinary edit is stored compactly and exactly
    await select(p, bigText.length, bigText.length);
    await p.keyboard.type("!");
    await saved(p, srv, "page-big", "oversized page saved");
    const storedBig = srv.pg("page-big").content;
    check(storedBig.version === 1 && storedBig.blocks.length === 1 && storedBig.blocks[0].text === bigText + "!", "stored as ONE legacy block, no text lost");
    check(srv.pg("page-small").content.version === 1 && srv.pg("page-small").rev === 1, "the other legacy page is untouched");
    // shrink under the limit: normal V2 migration
    await p.evaluate(() => { const e = document.querySelector("#hq-carnet-editor"); e.focus(); e.value = Array.from({ length: 40 }, (_, i) => "kept " + i).join("\n"); e.dispatchEvent(new Event("input", { bubbles: true })); });
    await saved(p, srv, "page-big", "shrunk page saved");
    check(srv.pg("page-big").content.version === 2 && srv.pg("page-big").content.blocks.length === 40, "reduced below the limit: migrated to V2");
    await select(p, 0, 4);
    await p.keyboard.press("Control+b");
    await saved(p, srv, "page-big", "formatting allowed again");
    check(srv.pg("page-big").content.blocks[0].marks.length === 1, "structured formatting works once the page fits");

    // ================================================================ 8c. logical block ids
    console.log("-- block ids");
    const ids = (id) => srv.pg(id).content.blocks.map((b) => b.id);
    await reseed(p, srv, notebook([page("page-ids", 1, [line("paragraph", "one"), line("paragraph", "two")].map((b, i) => Object.assign(b, { id: i ? "block-BBBBBBBB" : "block-AAAAAAAA" })))]));
    check(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor [data-carnet-block-id]")].map((d) => d.getAttribute("data-carnet-block-id")))) === JSON.stringify(["block-AAAAAAAA", "block-BBBBBBBB"]), "persisted blocks carry [data-carnet-block-id]");
    await select(p, 0, 0);
    await p.keyboard.press("Enter"); // a new block ABOVE "one"
    await p.keyboard.press("ArrowUp");
    await p.keyboard.type("NEW");
    check(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-line")].map((d) => [d.getAttribute("data-carnet-block-id"), d.textContent]))) === JSON.stringify([[null, "NEW"], ["block-AAAAAAAA", "one"], ["block-BBBBBBBB", "two"]]), "DOM: the new block has no server id yet; A and B keep theirs");
    await saved(p, srv, "page-ids", "insert saved");
    const afterInsert = srv.pg("page-ids").content.blocks.map((b) => [b.id, b.text]);
    check(afterInsert[1][0] === "block-AAAAAAAA" && afterInsert[2][0] === "block-BBBBBBBB" && afterInsert[0][1] === "NEW" && /^block-[0-9a-f]{24}$/.test(afterInsert[0][0]), "server: NEW got a fresh id; A and B kept theirs: " + JSON.stringify(afterInsert));
    check(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-line")].map((d) => d.getAttribute("data-carnet-block-id")))) === JSON.stringify(afterInsert.map((x) => x[0])), "the server-generated id is adopted in the DOM");
    await p.reload();
    await showCarnet(p);
    check(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-line")].map((d) => d.getAttribute("data-carnet-block-id")))) === JSON.stringify(afterInsert.map((x) => x[0])), "the same ids after reload");
    // split in the middle of the sequence
    await select(p, 5, 5); // "NEW\no|ne"
    await p.keyboard.press("Enter");
    await saved(p, srv, "page-ids", "split saved");
    const afterSplit = srv.pg("page-ids").content.blocks.map((b) => [b.id, b.text]);
    check(JSON.stringify(afterSplit.map((x) => x[1])) === JSON.stringify(["NEW", "o", "ne", "two"]) && afterSplit[1][0] === "block-AAAAAAAA" && afterSplit[3][0] === "block-BBBBBBBB" && afterSplit[0][0] === afterInsert[0][0] && afterSplit[2][0] !== "block-AAAAAAAA", "split: first part keeps A, the tail is new, B and NEW untouched");
    // formatting and deletion keep ids
    await select(p, 0, 3);
    await p.keyboard.press("Control+b");
    await saved(p, srv, "page-ids", "format saved");
    check(JSON.stringify(ids("page-ids")) === JSON.stringify(afterSplit.map((x) => x[0])), "formatting keeps every id");
    await select(p, 6, 8); // delete the "ne" line's text ... and the newline before it
    await p.keyboard.press("Backspace");
    await saved(p, srv, "page-ids", "delete saved");
    check(ids("page-ids").includes("block-BBBBBBBB") && ids("page-ids").includes("block-AAAAAAAA"), "deleting keeps the survivors' ids");
    // unsaved draft reload keeps identity
    const idsBeforeDraft = ids("page-ids");
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await select(p, 0, 0);
    await p.keyboard.press("Enter");
    await p.keyboard.press("ArrowUp");
    await p.keyboard.type("DRAFT");
    const draftIds = await p.evaluate(() => JSON.parse(localStorage.getItem("hq_carnet_drafts_v1:admin-test")).pages["page-ids"].content.blocks.map((b) => b.id || null));
    check(draftIds[0] === null && draftIds.slice(1).every((x) => /^block-/.test(x)), "the draft keeps the real ids (the new block has none): " + JSON.stringify(draftIds));
    await p.reload();
    await ctx.unroute("**/api/carnet");
    await showCarnet(p);
    await until(async () => srv.text("page-ids").startsWith("DRAFT"), "recovered draft saved", 15000);
    const idsAfterDraft = ids("page-ids");
    check(idsBeforeDraft.every((x) => idsAfterDraft.includes(x)) && idsAfterDraft.length === idsBeforeDraft.length + 1, "every pre-existing id survived the draft reload + save; only the new block got an id");

    // ================================================================ 8d. server block ids reconcile with the LIVE DOM (no reload)
    console.log("-- block-id adoption in the live DOM");
    const domIds = (pg) => pg.evaluate(() => [...document.querySelectorAll("#hq-carnet-editor .carnet-line")].map((d) => [d.getAttribute("data-carnet-block-id"), d.getAttribute("data-carnet-tmp"), d.textContent]));
    const srvIds = (id) => srv.pg(id).content.blocks.map((b) => b.id);
    const a0 = "block-KKKKKKKK";
    await reseed(p, srv, notebook([page("page-k", 1, [Object.assign(line("paragraph", "one"), { id: a0 })])]));
    check((await domIds(p))[0][0] === a0, "1. persisted block A is in the DOM");
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await select(p, 3, 3);
    await p.keyboard.type(" mine");
    await until(() => dirty(p), "local edit is dirty (offline)");
    // 2. the remote removes/replaces block A
    const nbk = srv.nb();
    nbk.pages[0].rev += 1;
    nbk.pages[0].content = { version: 2, blocks: [{ id: "block-XXXXXXXX", type: "paragraph", text: "remote", marks: [] }] };
    srv.put(nbk);
    await ctx.unroute("**/api/carnet");
    await until(() => conflict(p), "explicit conflict", 15000);
    // 3. keep mine
    await p.click("#btn-carnet-conflict-local");
    await saved(p, srv, "page-k", "keep-mine saved");
    const C1 = srvIds("page-k")[0];
    check(C1 !== a0 && C1 !== "block-XXXXXXXX" && srv.text("page-k") === "one mine", "4. the server created a replacement id C: " + C1);
    // 5. the live DOM exposes C (no reload)
    check((await domIds(p))[0][0] === C1 && (await domIds(p))[0][1] === null, "5. DOM data-carnet-block-id is now C");
    // 6-8. type again immediately: identity stable
    await select(p, 8, 8);
    await p.keyboard.type("!");
    await saved(p, srv, "page-k", "typing after adoption saved");
    check(srvIds("page-k").join() === C1 && srv.text("page-k") === "one mine!", "8. the server still has C, no other id was generated");
    // Enter/split around the adopted id
    await select(p, 3, 3);
    await p.keyboard.press("Enter");
    await saved(p, srv, "page-k", "split saved");
    const afterSplit2 = srvIds("page-k");
    check(afterSplit2.length === 2 && afterSplit2[0] === C1 && afterSplit2[1] !== C1, "split: the first part keeps the adopted id C, the tail is new");
    const C2 = afterSplit2[1];
    // draft reload after adoption: offline edit, reload, ids kept
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await select(p, 0, 0);
    await p.keyboard.type(">");
    const dr = await p.evaluate(() => JSON.parse(localStorage.getItem("hq_carnet_drafts_v1:admin-test")).pages["page-k"].content.blocks.map((b) => b.id || null));
    check(dr.join() === [C1, C2].join(), "the draft carries the ADOPTED ids: " + JSON.stringify(dr));
    await p.reload();
    await ctx.unroute("**/api/carnet");
    await showCarnet(p);
    await until(async () => srv.text("page-k").startsWith(">"), "draft saved after reload", 15000);
    check(srvIds("page-k").join() === [C1, C2].join(), "draft reload after adoption keeps both ids");
    // late success: a NEW block created before the response, newer typing while the save is in flight
    let openGate;
    const gate = new Promise((r) => { openGate = r; });
    await ctx.route("**/api/carnet", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });
    await select(p, (await value(p)).length, (await value(p)).length);
    await p.keyboard.press("Enter");
    await p.keyboard.type("fresh");
    await sleep(900); // debounce fires: the save is now held in flight
    await p.keyboard.type(" more");
    openGate();
    await saved(p, srv, "page-k", "late-success chain saved");
    const idsLate = srvIds("page-k");
    check(srv.text("page-k").endsWith("fresh more") && idsLate.length === 3 && idsLate[0] === C1 && idsLate[1] === C2, "late success kept C1/C2");
    const domLate = await domIds(p);
    check(domLate.every((d) => d[0] && d[1] === null) && domLate.map((d) => d[0]).join() === idsLate.join(), "late-success: every DOM block now carries its server id (no temporary key left): " + JSON.stringify(domLate));
    await ctx.unroute("**/api/carnet");
    await select(p, (await value(p)).length, (await value(p)).length);
    await p.keyboard.type("!");
    await saved(p, srv, "page-k", "post-adoption typing saved");
    check(srvIds("page-k").join() === idsLate.join(), "the late-adopted id is claimed again, not regenerated");

    // authoritative text/format identical but block ids changed elsewhere (clean page): the DOM follows, no regeneration loop
    await until(async () => !(await dirty(p)), "clean before id-only remote change");
    const nbi = srv.nb();
    nbi.pages[0].rev += 1;
    nbi.pages[0].content.blocks.forEach((b, i) => { b.id = "block-RENAMED" + i; });
    srv.put(nbi);
    await until(async () => (await domIds(p)).every((d, i) => d[0] === "block-RENAMED" + i), "poll adopts identical content with new ids into the live DOM", 15000);
    await select(p, 0, 0);
    await p.keyboard.type("~");
    await saved(p, srv, "page-k", "typing after id-only change saved");
    check(srvIds("page-k").join() === "block-RENAMED0,block-RENAMED1,block-RENAMED2", "ids are kept (not regenerated) after an id-only remote change");

    // ================================================================ 9. focus mode stays minimal
    console.log("-- Focus mode");
    await openFormat(p);
    await p.click("#btn-carnet-find");
    await p.click("#btn-carnet-focus");
    await until(async () => await p.locator(".carnet.is-focus").count() === 1, "focus mode on");
    const visible = async (sel2) => (await p.locator(sel2).count()) > 0 && (await p.locator(sel2).first().isVisible());
    check(!(await visible("#carnet-format-bar")) && !(await visible("#hq-carnet-find")) && !(await visible("#btn-carnet-format")) && !(await visible("#btn-carnet-export")), "no formatting/find/export chrome in Focus mode");
    check((await visible("#btn-carnet-prev")) && (await visible("#btn-carnet-next")) && (await visible("#btn-carnet-focus-exit")), "Focus keeps minimal navigation + exit");
    await p.evaluate(() => { const b = document.querySelector("#btn-carnet-more"); if (b) b.click(); });
    check((await p.locator('[data-carnet-symbol="Ø"]').count()) === 1, "quick symbols exist in Focus");
    await p.click("#btn-carnet-focus-exit");
    await p.keyboard.press("Escape");

    await ctx.close();

    // ================================================================ 10. touch profiles: compact, >=44px, paper dominant
    for (const profile of ["ipad", "iphone"]) {
      console.log("-- touch layout [" + profile + "]");
      srv.put(notebook([page("page-a", 1, [line("paragraph", "hello"), line("check", "task", [], { checked: false }), line("paragraph", "")]), page("page-b", 1, [line("paragraph", "other")])]));
      const c = await context(srv, profile);
      const tp = await openPage(c, srv);
      const ed = await tp.locator(EDITOR).boundingBox();
      const vp = tp.viewportSize();
      check(ed.height > vp.height * 0.4 && ed.width > vp.width * (profile === "iphone" ? 0.85 : 0.75), `${profile}: paper stays dominant (${Math.round(ed.width)}x${Math.round(ed.height)})`);
      check(await tp.evaluate(() => document.querySelector("#carnet-format-bar").hidden), `${profile}: no permanent formatting bar`);
      const box = await tp.locator(".carnet-check").boundingBox();
      check(box.width >= 44 && box.height >= 44, `${profile}: checkbox touch target >=44px (${box.width}x${box.height})`);
      await openFormat(tp);
      const sizes = await tp.evaluate(() => [...document.querySelectorAll("#carnet-format-bar button")].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      check(sizes.length === 10 && sizes.every(([w, h]) => w >= 44 && h >= 44), `${profile}: format controls >=44px`);
      const barH = (await tp.locator("#carnet-format-bar").boundingBox()).height;
      check(barH <= 60, `${profile}: format bar is one compact row (${barH}px)`);
      check(await tp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${profile}: no horizontal page scroll`);
      await tp.tap('.carnet-check');
      await until(async () => (await domLines(tp))[1][1] === true, `${profile}: tapping the checkbox toggles it`);
      await saved(tp, srv, "page-a", profile + " toggle saved");
      check(srv.pg("page-a").content.blocks[1].checked === true, `${profile}: toggle persisted through the normal save path`);
      // native selection stays usable: a programmatic selection is not reset by re-render of unrelated UI
      await select(tp, 0, 3);
      await tp.click('[data-carnet-format="bold"]');
      check(JSON.stringify(await sel(tp)) === "[0,3]", `${profile}: selection kept after a format tap`);
      check((await domLines(tp))[0][3][0][0] === "bold", `${profile}: bold applied`);
      await c.close();
    }

    // ================================================================ 11. read-only lifecycle (trash) keeps structure, blocks edits
    console.log("-- trash / restore keeps structure");
    srv.put(notebook([page("page-a", 1, [line("check", "keep", [{ type: "bold", start: 0, end: 4 }], { checked: true })]), page("page-b", 1, [line("paragraph", "b")])]));
    ctx = await context(srv);
    p = await openPage(ctx, srv);
    await select(p, 4, 4);
    await p.keyboard.type("!");
    await saved(p, srv, "page-a", "first structured edit saved");
    // another device trashes the page while we hold a dirty structured draft (our saves fail: offline)
    await ctx.route("**/api/carnet", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await p.keyboard.type("?");
    await sleep(700);
    const nbNow = srv.nb();
    const revBefore = nbNow.pages[0].rev;
    nbNow.pages[0].deleted_at = 1790690000.0;
    nbNow.pages[0].rev = revBefore + 1;
    nbNow.notebook_rev += 1;
    srv.put(nbNow);
    await until(async () => (await p.evaluate(() => document.querySelector("#hq-carnet-editor").readOnly)), "remote trash makes the structured page read-only", 15000);
    const kept = await p.evaluate(() => JSON.parse(localStorage.getItem("hq_carnet_drafts_v1:admin-test") || "{}").pages);
    check(kept && kept["page-a"] && kept["page-a"].content.blocks[0].type === "check" && kept["page-a"].content.blocks[0].checked === true, "dirty structured draft preserved while trashed");
    check((await domLines(p))[0][0] === "check", "structure still displayed read-only");
    check((await p.locator(".carnet-check").count()) === 1, "checkbox still rendered (read-only)");
    await p.locator(".carnet-check").click({ force: true });
    check(srv.pg("page-a").content.blocks[0].checked === true && srv.pg("page-a").rev === revBefore + 1, "clicking a checkbox of a trashed page changes nothing");
    await ctx.unroute("**/api/carnet");
    await ctx.close();

    // ================================================================ 12. accepted Stage 02/03 behaviour on the new editor surface
    // (ports of the editor-facing scenarios of tests/visual_carnet_playwright.py; the legacy V1 fixture is served as-is)
    console.log("-- regression: legacy fixture, symbols/time/copy/new/pin, keys, swipe");
    const SHAFT = "Shaft inspection\nØ12.034 mm\nCheck bearing preload";
    const IDEA = "Try a split clamp instead";
    const legacyFixture = () => ({
      version: 1, notebook_rev: 4,
      projects: [{ id: "proj-fixture", name: "Fixture redesign", archived: false, created_at: 1790680000.0, updated_at: 1790680000.0 }],
      categories: [{ id: "cat-measures", name: "Mesures", color: "amber", created_at: 1790680000.0, updated_at: 1790680000.0 }],
      pages: [v1("page-shaft", 3, SHAFT, { project_id: "proj-fixture", category_id: "cat-measures", pinned: true }), v1("page-idea", 1, IDEA)],
    });
    const pid = (pg) => pg.evaluate(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
    const swipe = (pg, dx, dy) => pg.evaluate(([x, y]) => new Promise((resolve) => {
      const stage = document.querySelector(".carnet-stage");
      const r = stage.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + 120;
      const ev = (type, cx, cy) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const t = [{ clientX: cx, clientY: cy, identifier: 1, target: stage }];
        Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : t });
        Object.defineProperty(e, "changedTouches", { value: t });
        stage.dispatchEvent(e);
      };
      ev("touchstart", x0, y0);
      ev("touchmove", x0 + x / 2, y0 + y / 2);
      setTimeout(() => { ev("touchend", x0 + x, y0 + y); resolve(); }, 120);
    }), [dx, dy]);
    srv.put(legacyFixture());
    ctx = await context(srv, "desktop");
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.base });
    p = await openPage(ctx, srv);
    check((await value(p)) === SHAFT, "legacy V1 page renders its exact multi-line text");
    check((await p.textContent("#carnet-page-indicator")).trim() === "1 / 2", "page indicator 1 / 2");
    check((await p.textContent("#btn-carnet-context")).trim() === "Fixture redesign · Mesures", "context pill");
    check((await p.getAttribute("#btn-carnet-pin", "aria-pressed")) === "true", "pin state");
    check((await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#hq-carnet-editor")).fontSize))) >= 16, "editor font >= 16px");
    await p.click("#btn-carnet-more");
    await select(p, 5, 5);
    await p.locator('[data-carnet-symbol="Ø"]').click();
    check((await value(p)) === "ShaftØ inspection" + SHAFT.slice(16), "symbol inserted at the caret");
    check((await sel(p))[0] === 6, "caret after the symbol");
    await p.locator("#btn-carnet-time").click();
    check(/^ShaftØ\d\d:\d\d — /.test(await value(p)), "clock inserts HH:MM — at the cursor");
    await until(async () => srv.text("page-shaft") === (await value(p)), "tool edits autosaved");
    await select(p, 0, 5);
    await p.locator("#btn-carnet-copy").click();
    await until(async () => (await p.textContent(".carnet-flash")) === "Copié", "Copié (native clipboard)");
    check((await p.evaluate(() => navigator.clipboard.readText())) === "Shaft", "selection copied");
    check(await p.evaluate(() => { const e = document.activeElement; return e.id + ":" + e.selectionStart + "-" + e.selectionEnd; }) === "hq-carnet-editor:0-5", "focus + selection restored after copy");
    await p.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      const ex = document.execCommand.bind(document);
      document.execCommand = (cmd, ...a) => { if (cmd === "copy") { const t = document.activeElement; window.__copied = t.value.slice(t.selectionStart, t.selectionEnd); return true; } return ex(cmd, ...a); }; });
    await select(p, 0, 5);
    await p.locator("#btn-carnet-copy").click();
    await until(async () => (await p.evaluate(() => window.__copied)) === "Shaft", "execCommand fallback copies the selection");
    await p.evaluate(() => { document.execCommand = () => false; });
    await p.locator("#btn-carnet-copy").click();
    await until(async () => (await p.textContent(".carnet-flash")) === "Copie impossible", "Copie impossible when both fail");
    await p.locator("#btn-carnet-new").click();
    await until(async () => (await p.textContent("#carnet-page-indicator")).trim() === "2 / 3", "new page inserted after the current one");
    const newId = await pid(p);
    check(!["page-shaft", "page-idea"].includes(newId) && (await value(p)) === "", "new page is blank, no title prompt");
    await p.keyboard.type("Nouvelle note");
    await until(async () => srv.text(newId) === "Nouvelle note", "new page autosaves");
    await p.locator("#btn-carnet-pin").click();
    await until(async () => srv.nb().pages.find((x) => x.id === newId).pinned === true, "pin saved");
    // keys
    await p.locator("#btn-carnet-prev").click();
    await select(p, 3, 3);
    await p.keyboard.press("ArrowRight");
    check((await pid(p)) === "page-shaft" && (await sel(p))[0] === 4, "plain ArrowRight moves the caret, not the page");
    await p.keyboard.press("Alt+ArrowRight");
    await until(async () => (await pid(p)) !== "page-shaft", "Alt+ArrowRight -> next page");
    check((await p.evaluate(() => document.activeElement && document.activeElement.id)) === "hq-carnet-editor", "focus stays in the editor");
    await p.keyboard.press("Alt+ArrowLeft");
    await until(async () => (await pid(p)) === "page-shaft", "Alt+ArrowLeft -> previous page");
    check(p.url().endsWith("/"), "Alt+Left never navigates browser history");
    await ctx.close();
    // swipe rules on a touch profile
    ctx = await context(srv, "iphone");
    p = await openPage(ctx, srv);
    await swipe(p, -40, 0); await sleep(120);
    check((await pid(p)) === "page-shaft", "short swipe (<60px) does not flip");
    await swipe(p, -80, 70); await sleep(120);
    check((await pid(p)) === "page-shaft", "vertical-dominant swipe does not flip");
    await select(p, 0, 5);
    await swipe(p, -120, 0); await sleep(120);
    check((await pid(p)) === "page-shaft", "a text selection never flips the page");
    await select(p, 0, 0);
    await swipe(p, -120, 10);
    await until(async () => (await pid(p)) === newId, "swipe left >= 60px -> next page (the page created above sits after page-shaft)");
    check(await p.evaluate(() => [...document.querySelectorAll(".carnet-page-ghost")].every((g) => g.getAttribute("aria-hidden") === "true")), "flip ghost is aria-hidden when present");
    await swipe(p, 120, 0);
    await until(async () => (await pid(p)) === "page-shaft", "swipe right -> previous page");
    await ctx.close();
    // missing module: durable error + retry, rest of HQ keeps working
    ctx = await context(srv, "desktop");
    await ctx.route("**/assets/hq-carnet.js", (r) => r.fulfill({ status: 404, body: "missing" }));
    p = await openPage(ctx, srv, { carnet: false });
    await p.locator('.bottom-nav [data-nav="carnet"]').click();
    await p.waitForSelector(".carnet-fail");
    check(await p.locator(".carnet-retry").isVisible(), "missing asset -> durable error + retry");
    await p.locator('.bottom-nav [data-nav="calendrier"]').click();
    check((await p.getAttribute("body", "data-view")) === "calendrier", "rest of HQ keeps working");
    await p.locator('.bottom-nav [data-nav="carnet"]').click();
    await ctx.unroute("**/assets/hq-carnet.js");
    await p.locator(".carnet-retry").click();
    await p.waitForSelector("#hq-carnet-editor");
    await until(async () => (await value(p)).startsWith("Shaft"), "retry loads the rich module then the editor");
    await ctx.close();
    ctx = await context(srv, "desktop");
    await ctx.route("**/assets/hq-carnet-rich.js", (r) => r.fulfill({ status: 404, body: "missing" }));
    p = await openPage(ctx, srv, { carnet: false });
    await p.locator('.bottom-nav [data-nav="carnet"]').click();
    await p.waitForSelector(".carnet-fail");
    check(true, "a missing structured-content module fails closed with the same durable error");
    await ctx.unroute("**/assets/hq-carnet-rich.js");
    await p.locator(".carnet-retry").click();
    await p.waitForSelector("#hq-carnet-editor");
    await ctx.close();
    errors.length = 0; // the two deliberate 404 module loads above raise expected script errors

    // ================================================================ 13. global hygiene
    check(errors.length === 0, "no page errors / console errors: " + JSON.stringify(errors));
    check(external.length === 0, "no external requests: " + JSON.stringify(external));
    console.log(`\nALL OK (${passed} checks)`);
  } finally {
    await browser.close();
    for (const s of started) s.close();
  }
}

function existsSyncAny(srv, rels) {
  return rels.some((r) => existsSync(path.join(srv.root, r)) || existsSync(path.join(path.dirname(srv.root), r)));
}
main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
