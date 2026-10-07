// Phase 14.1 desktop library geometry suite: long French page titles, focus/selection geometry, bottom-row reach, sidebar overflow, empty journal marks, Capture FAB placement.
//   P141_SHOTS=dir P141_OUT=file.json node tests/visual_carnet_library_geometry_playwright.mjs [scenario substring...]
//   P141_MODE=probe  -> measure and record only (never throws on a geometry finding); default = assert.
// Engines: Chromium only (desktop emulation). Runs on a throwaway loopback HQ (tests/carnet_test_server.py).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  const require = createRequire(process.env.PLAYWRIGHT_NODE_PATH ? process.env.PLAYWRIGHT_NODE_PATH.replace(/\/?$/, "/") : import.meta.url);
  chromium = require("playwright").chromium;
} catch (_) {
  try { chromium = createRequire("/opt/node22/lib/node_modules/")("playwright").chromium; } catch (e) { console.log("SKIP: Playwright not available"); process.exit(0); }
}
const PROBE = process.env.P141_MODE === "probe";
let passed = 0;
const failures = [];
const findings = [];
function check(cond, msg) {
  if (!cond) {
    if (PROBE) { findings.push(msg); console.log("  FIND ", msg); return; }
    throw new Error("FAIL: " + msg);
  }
  passed += 1;
  console.log("  OK  ", msg);
}
const SHOTS = process.env.P141_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);
const OUT = { rows: {}, fab: {}, marks: {}, scroll: {} };
const outFile = process.env.P141_OUT || "";
const errors = [];

class Server {
  static async start(seed) {
    const s = new Server();
    s.root = mkdtempSync(path.join(tmpdir(), "hq-carnet-geom-"));
    const seedPath = path.join(tmpdir(), "hq-carnet-seed-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".json");
    writeFileSync(seedPath, JSON.stringify(seed));
    s.proc = spawn(process.env.PYTHON || "python3", [path.join(here, "carnet_test_server.py"), s.root, seedPath], { stdio: ["pipe", "pipe", "inherit"] });
    const info = await new Promise((res, rej) => { s.proc.once("error", rej); s.proc.stdout.once("data", (d) => res(JSON.parse(String(d)))); });
    rmSync(seedPath, { force: true });
    Object.assign(s, info);
    return s;
  }
  close() { try { this.proc.stdin.end(); } catch (_) {} rmSync(this.root, { recursive: true, force: true }); }
}
let browser;
const started = [];

// ---------------------------------------------------------------- fixtures
const T0 = Math.floor(Date.now() / 1000) - 3600;
const TITLES = [
  "Journal d'ingénierie — 2026-10-01",
  "Inspection générale des systèmes — 2026-10-01",
  "Compte rendu de vérification structurelle — bâtiment principal",
  "Rapport préliminaire de vérification des charges admissibles et des contraintes de fatigue sur l'ensemble des assemblages boulonnés de la structure secondaire du bâtiment principal — révision C",
  "Motifs_de_vérification_sans_espaces_très_longs_pour_forcer_le_débordement_horizontal_du_titre_2026",
];
const para = (text, id) => ({ id, type: "paragraph", text, marks: [] });
const blk = (type, text, id) => ({ id, type, text, marks: [] });
function page(id, title, n, extra) {
  return Object.assign({ id, rev: 1, project_id: "proj-1", category_id: null, pinned: false, deleted_at: null, created_at: T0, updated_at: T0 - n * 60, content: { version: 2, blocks: [Object.assign(para(title, "block-" + id.slice(5) + "-t"), { type: "heading" }), para("Contenu " + n, "block-" + id.slice(5) + "-p")] } }, extra || {});
}
function NB(count) {
  const pages = TITLES.map((t, i) => page("page-long-" + i, t, i + 1));
  for (let i = 0; i < count; i++) pages.push(page("page-n-" + i, "Page de travail " + (i + 1), i + 10));
  // a journal-template page: empty bullet / checklist blocks under headings
  pages.push(page("page-journal", "Journal d'ingénierie — 2026-10-02", 0, { content: { version: 2, blocks: [
    Object.assign(para("Journal d'ingénierie — 2026-10-02", "block-j0"), { type: "heading" }),
    Object.assign(para("Contexte", "block-j1"), { type: "heading" }), para("", "block-j2"),
    Object.assign(para("Travail effectué", "block-j3"), { type: "heading" }), blk("bullet", "", "block-j4"),
    Object.assign(para("Observations", "block-j5"), { type: "heading" }), blk("bullet", "", "block-j6"),
    Object.assign(para("Prochaines étapes", "block-j7"), { type: "heading" }), Object.assign(blk("check", "", "block-j8"), { checked: false }),
  ] } }));
  return { version: 1, notebook_rev: 5, projects: [{ id: "proj-1", name: "Banc", archived: false, created_at: T0, updated_at: T0 }], categories: [], pages };
}
async function world(vp, count = 30, extra = {}) {
  const srv = await Server.start(NB(count));
  started.push(srv);
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true, viewport: vp }, extra));
  const r = await ctx.request.post(srv.base + "/login", { form: { pin: srv.admin_pin }, headers: { Origin: srv.base }, maxRedirects: 0 });
  check(r.status() === 303, `login ${vp.width}x${vp.height}`);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push("pageerror " + e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console " + m.text()); });
  await p.goto(srv.base + "/");
  await p.locator('.bottom-nav [data-nav="carnet"]').click();
  await p.waitForSelector("#hq-carnet-editor", { state: "visible", timeout: 15000 });
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId);
  await p.waitForSelector("#carnet-library-list .carnet-card");
  return { srv, ctx, p };
}
const SIZES = [[1280, 800], [1366, 768], [1440, 900], [1600, 900], [1920, 1080]];

// Everything we know about one library row, measured from layout (not from pixels).
const measureRows = (p) => p.evaluate(() => {
  const lib = document.querySelector(".carnet-library");
  const sc = lib;
  const sr = sc.getBoundingClientRect();
  const rows = [...document.querySelectorAll("#carnet-library-list .carnet-card")].map((card) => {
    const main = card.querySelector(".carnet-card-main");
    const t = card.querySelector(".carnet-card-title");
    const cs = getComputedStyle(t);
    const cr = card.getBoundingClientRect(), mr = main.getBoundingClientRect(), tr = t.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const range = document.createRange(); range.selectNodeContents(t);
    const textRect = range.getBoundingClientRect();
    return {
      id: main.dataset.carnetPageId, text: t.textContent, cardH: Math.round(cr.height), mainH: Math.round(mr.height), contentClippedY: mr.bottom > cr.bottom + 1, current: card.classList.contains("is-current"),
      card: [cr.left, cr.top, cr.right, cr.bottom].map(Math.round), main: [mr.left, mr.top, mr.right, mr.bottom].map(Math.round),
      title: [tr.left, tr.top, tr.right, tr.bottom].map(Math.round), textW: Math.round(textRect.width), textRight: Math.round(textRect.right),
      scrollW: t.scrollWidth, clientW: t.clientWidth, clipped: t.scrollWidth > t.clientWidth + 1,
      overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, lineH: lh, lines: Math.round(tr.height / lh),
      wraps: tr.height > lh * 1.6, ellipsis: cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap" && cs.overflow === "hidden",
      titleAttr: t.getAttribute("title"), ariaLabel: main.getAttribute("aria-label"), nameFromContent: (main.textContent || "").includes(t.textContent),
    };
  });
  return {
    lib: [sr.left, sr.top, sr.right, sr.bottom].map(Math.round), libScrollH: sc.scrollHeight, libClientH: sc.clientHeight, libScrollTop: sc.scrollTop,
    libScrollW: sc.scrollWidth, libClientW: sc.clientWidth, docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
    list: (() => { const r = document.getElementById("carnet-library-list").getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); })(),
    libPad: getComputedStyle(lib).padding, libMaxH: getComputedStyle(lib).maxHeight, rows,
  };
});
// Focus ring geometry of the focused row: outline box expanded from the button, against the card clip box and the scroller.
const focusGeom = (p) => p.evaluate(() => {
  const a = document.activeElement;
  if (!a || !a.classList.contains("carnet-card-main")) return { ok: false, tag: a && a.tagName };
  const card = a.closest(".carnet-card");
  const cs = getComputedStyle(a);
  // the indicator may be drawn by the button itself or by its row (card); take the one that is actually painted
  const ccs = getComputedStyle(card);
  const own = { w: parseFloat(cs.outlineWidth) || 0, off: parseFloat(cs.outlineOffset) || 0, on: cs.outlineStyle !== "none" && (parseFloat(cs.outlineWidth) || 0) > 0, box: a };
  const row = { w: parseFloat(ccs.outlineWidth) || 0, off: parseFloat(ccs.outlineOffset) || 0, on: ccs.outlineStyle !== "none" && (parseFloat(ccs.outlineWidth) || 0) > 0, box: card };
  const src = row.on ? row : own;
  const w = src.w, off = src.off;
  const visible = own.on || row.on;
  const r = src.box.getBoundingClientRect(), c = card.getBoundingClientRect();
  const ext = src.on ? w + off : 0;
  const ring = [r.left - ext, r.top - ext, r.right + ext, r.bottom + ext];
  const lib = document.querySelector(".carnet-library").getBoundingClientRect();
  // the ring must survive the nearest overflow clip above its owner: a ring drawn by the button is cut by the card's padding box; one drawn by the row is cut by the scrolling library's
  const clipEl = src.box === a ? card : document.querySelector(".carnet-library");
  const cr0 = clipEl.getBoundingClientRect();
  const cb = { left: cr0.left + clipEl.clientLeft, top: cr0.top + clipEl.clientTop, right: cr0.left + clipEl.clientLeft + clipEl.clientWidth, bottom: cr0.top + clipEl.clientTop + clipEl.clientHeight };
  const clipByCard = Math.max(0, cb.left - ring[0], cb.top - ring[1], ring[2] - cb.right, ring[3] - cb.bottom);
  const t = card.querySelector(".carnet-card-title"); const tr = t.getBoundingClientRect();
  // the ring band (outline width) is drawn from the box edge outwards by `offset`; negative offsets draw it inside the box
  const bandIn = src.on && src.off < 0 ? Math.abs(src.off) : 0;   // how far the band intrudes inside the painted box
  const boxR = src.box.getBoundingClientRect();
  const innerEdge = { left: boxR.left + bandIn, right: boxR.right - bandIn, top: boxR.top + bandIn, bottom: boxR.bottom - bandIn };
  const ps = getComputedStyle(a); const padL = parseFloat(ps.paddingLeft), padT = parseFloat(ps.paddingTop);
  const rng = document.createRange(); rng.selectNodeContents(t); const gr = rng.getBoundingClientRect();
  const inset = src.box === a ? bandIn : 0;
  const overText = src.on && src.off < 0 && (inset > padL || inset > padT);
  const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bg = (() => { let n = document.querySelector(".carnet-library"); const c = getComputedStyle(n).backgroundColor; return rgb(c).length ? rgb(c) : [255, 255, 255]; })();
  const ringCol = rgb(src.on ? (row.on ? ccs.outlineColor : cs.outlineColor) : "rgb(0,0,0)");
  const L1 = lum(ringCol), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  return {
    ok: true, cardH: Math.round(c.height), id: a.dataset.carnetPageId, matchesFV: a.matches(":focus-visible"), outline: row.on ? `row ${ccs.outlineStyle} ${ccs.outlineWidth} off ${ccs.outlineOffset} ${ccs.outlineColor}` : `button ${cs.outlineStyle} ${cs.outlineWidth} off ${cs.outlineOffset} ${cs.outlineColor}`, outlineOn: own.on ? "button" : row.on ? "row" : "none", visible,
    ring: ring.map(Math.round), card: [c.left, c.top, c.right, c.bottom].map(Math.round), clipByCard: Math.round(clipByCard * 10) / 10,
    rowFullyInLib: c.top >= lib.top - 0.5 && c.bottom <= lib.bottom + 0.5, ringInPanel: ring[1] >= lib.top - 0.5 && ring[3] <= lib.bottom + 0.5 && ring[0] >= lib.left - 0.5 && ring[2] <= lib.right + 0.5, rowInViewport: c.top >= -0.5 && c.bottom <= innerHeight + 0.5, rowTop: Math.round(c.top), rowBottom: Math.round(c.bottom), libTop: Math.round(lib.top), libBottom: Math.round(lib.bottom),
    boxShadow: getComputedStyle(card).boxShadow, borderLeft: getComputedStyle(card).borderLeftWidth, textRightInsideRing: tr.right <= ring[2] + 0.5,
    clipped: t.scrollWidth > t.clientWidth + 1, ellipsis: cs.textOverflow,
    overText, overTextInfo: `inset ${bandIn}px vs padding ${padL}/${padT}px`, ringContrast: Math.round(ratio * 100) / 100, ringContrastOk: ratio >= 3,
  };
});
const logRow = (r) => `${r.text.slice(0, 40)}… clipped=${r.clipped} ellipsis=${r.ellipsis} lines=${r.lines} sw/cw=${r.scrollW}/${r.clientW} title=${r.titleAttr ? "yes" : "no"}`;

// A real pointer click proves the row is reachable; the probe-mode fallback clicks programmatically so a squeezed (unclickable) baseline can still be measured.
const selectRow = (p, sel) => (PROBE ? p.evaluate((q) => document.querySelector(q).click(), sel) : p.click(sel));
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// ---------------------------------------------------------------- 1. title contract
scenario("L1 long French titles: one-line ellipsis, nothing raw-clipped, full text exposed", async () => {
  for (const [w, h] of SIZES) {
    const { p } = await world({ width: w, height: h });
    const m = await measureRows(p);
    OUT.rows[`${w}x${h}`] = { lib: m.lib, libScrollH: m.libScrollH, libClientH: m.libClientH, rows: m.rows.filter((r) => /^page-long-|^page-journal/.test(r.id)) };
    await shot(p, `title-${w}x${h}`);
    const longs = m.rows.filter((r) => /^page-long-/.test(r.id));
    check(longs.length === TITLES.length, `${w}: ${longs.length} long-title rows present`);
    for (const r of longs) {
      console.log("      " + logRow(r));
      const overflowing = r.clipped;
      if (overflowing) check(r.ellipsis, `${w}: "${r.text.slice(0, 32)}…" overflows and carries a clean ellipsis`);
      check(r.title[2] <= r.card[2] + 0.5 && r.title[0] >= r.card[0] - 0.5, `${w}: "${r.text.slice(0, 32)}…" title box inside its row`);
      check(r.textRight <= r.card[2] + 0.5 || r.ellipsis, `${w}: "${r.text.slice(0, 32)}…" painted text never leaves the row`);
      check(r.lines <= 1 || r.wraps, `${w}: "${r.text.slice(0, 32)}…" is a single line (or deliberate wrap)`);
      check(!r.contentClippedY, `${w}: "${r.text.slice(0, 32)}…" row not squeezed (card ${r.cardH}px holds its ${r.mainH}px content)`);
      check(!!r.titleAttr && r.titleAttr === r.text, `${w}: "${r.text.slice(0, 32)}…" full title exposed via title attribute`);
      check(r.nameFromContent, `${w}: "${r.text.slice(0, 32)}…" accessible name still carries the full title`);
    }
    check(m.libScrollW <= m.libClientW + 1, `${w}: sidebar has no horizontal overflow (${m.libScrollW}/${m.libClientW})`);
    check(m.docScrollW <= m.docClientW + 1, `${w}: page has no horizontal overflow (${m.docScrollW}/${m.docClientW})`);
    await p.context().close();
  }
});

// ---------------------------------------------------------------- 2. selected / focused geometry
scenario("L2 selected, focused and selected+focused long rows keep text and ring inside the row", async () => {
  for (const [w, h] of [[1280, 800], [1920, 1080]]) {
    const { p } = await world({ width: w, height: h }, 4);
    const row = (id) => `#carnet-library-list [data-carnet-page-id="${id}"]`;
    const rowOf = async (id) => (await measureRows(p)).rows.find((r) => r.id === id);
    // 1. mouse-selected row (a pointer click never shows the keyboard ring; the row itself must still be whole)
    await selectRow(p, row("page-long-0"));
    await p.waitForFunction((s) => document.querySelector(s).closest(".carnet-card").classList.contains("is-current"), row("page-long-0"));
    await p.mouse.move(2, 2);
    const cur = await rowOf("page-long-0");
    OUT.rows[`${w}-mouse-selected`] = cur;
    await shot(p, `selected-${w}x${h}`);
    check(!!cur && cur.current, `${w}: mouse-selected row is current`);
    check(cur.ellipsis || !cur.clipped, `${w}: selected row text is never raw-clipped`);
    check(cur.title[2] <= cur.card[2] + 0.5 && cur.title[0] >= cur.card[0] - 0.5, `${w}: selected row title stays inside the row (${cur.title[0]}..${cur.title[2]} in ${cur.card[0]}..${cur.card[2]})`);
    check(!cur.contentClippedY, `${w}: selected row is not squeezed (card ${cur.cardH}px, content ${cur.mainH}px)`);
    // 2. selected + keyboard focus on the same row
    await p.focus(row("page-long-0"));
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
    const g1 = await focusGeom(p);
    OUT.rows[`${w}-selected-focused`] = g1;
    await shot(p, `selected-focused-${w}x${h}`);
    check(g1.ok && g1.id === "page-long-0" && g1.matchesFV, `${w}: keyboard focus lands on the selected row with :focus-visible`);
    check(g1.visible, `${w}: selected+focused row shows a focus indicator (${g1.outline})`);
    check(g1.clipByCard <= 0.5, `${w}: selected+focused ring is not clipped by the row (clip ${g1.clipByCard}px; ${g1.outline})`);
    check(g1.ringInPanel && g1.rowFullyInLib, `${w}: selected+focused row and ring are inside the sidebar viewport`);
    // 3. focused but not selected
    await p.focus(row("page-long-2"));
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
    const g2 = await focusGeom(p);
    OUT.rows[`${w}-focused-not-selected`] = g2;
    await shot(p, `focused-${w}x${h}`);
    check(g2.ok && g2.id === "page-long-2" && g2.matchesFV, `${w}: keyboard focus reaches a non-selected long row with :focus-visible`);
    check(g2.visible, `${w}: keyboard-focused row has a visible focus indicator (${g2.outline})`);
    check(g2.clipByCard <= 0.5, `${w}: keyboard-focus ring is not clipped by the row (clip ${g2.clipByCard}px; ${g2.outline})`);
    check(g2.rowFullyInLib, `${w}: keyboard-focused row is fully visible in the sidebar`);
    check(g2.ringContrastOk, `${w}: focus ring colour contrasts with the panel (${g2.ringContrast})`);
    // text is never painted under the ring: the ring sits outside the row box or inside its padding, never over the title glyphs
    const grow = await rowOf("page-long-2");
    check(!g2.overText, `${w}: focus ring does not overlap the title text (${g2.overTextInfo})`);
    check(grow.title[2] <= grow.card[2] + 0.5, `${w}: focused long title stays inside its row`);
    // 4. keyboard-selected (Enter) and still focused
    await p.keyboard.press("Enter");
    await p.waitForFunction((s) => document.querySelector(s).closest(".carnet-card").classList.contains("is-current"), row("page-long-2"));
    await p.focus(row("page-long-2"));
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
    const g3 = await focusGeom(p);
    OUT.rows[`${w}-keyboard-selected-focused`] = g3;
    check(g3.ok && g3.visible && g3.clipByCard <= 0.5, `${w}: keyboard-selected + focused row keeps an unclipped ring (clip ${g3.clipByCard}px)`);
    check(!g3.overText, `${w}: keyboard-selected + focused ring does not overlap the title text`);
    await p.context().close();
  }
});

// ---------------------------------------------------------------- 3. bottom of list
// The dock is position:sticky; the window is scrolled just far enough that the panel is pinned at top:12px, then the panel itself is scrolled to its true bottom.
const pinPanel = (p) => p.evaluate(async () => {
  const l = document.querySelector(".carnet-library");
  window.scrollTo(0, Math.max(0, Math.round(window.scrollY + l.getBoundingClientRect().top - 12)));
  await new Promise((r) => setTimeout(r, 120));
});
scenario("L3 bottom row: list reaches its true bottom, last row fully visible with breathing room", async () => {
  for (const [w, h] of SIZES) {
    const { p } = await world({ width: w, height: h }, 40);
    await pinPanel(p);
    const before = await measureRows(p);
    OUT.scroll[`${w}x${h}`] = { libScrollH: before.libScrollH, libClientH: before.libClientH, libMaxH: before.libMaxH, libPad: before.libPad, lib: before.lib, listH: before.list[3] - before.list[1] };
    check(before.libScrollH > before.libClientH, `${w}x${h}: sidebar scrolls (${before.libScrollH}>${before.libClientH})`);
    check(before.list[3] - before.list[1] >= before.rows.length * 40, `${w}x${h}: page list keeps its own height instead of being squeezed (${before.list[3] - before.list[1]}px for ${before.rows.length} rows)`);
    check(before.rows.every((r) => r.cardH >= 40 && !r.contentClippedY), `${w}x${h}: every row keeps its full height (min card ${Math.min(...before.rows.map((r) => r.cardH))}px)`);
    await p.evaluate(() => { const l = document.querySelector(".carnet-library"); l.scrollTop = l.scrollHeight; });
    await p.waitForTimeout(80);
    const m = await measureRows(p);
    const last = m.rows[m.rows.length - 1];
    const gap = m.lib[3] - last.card[3];
    OUT.scroll[`${w}x${h}`].bottom = { lastCard: last.card, lib: m.lib, gapBelowLastRow: gap, scrollTop: m.libScrollTop, atBottom: Math.abs(m.libScrollTop + m.libClientH - m.libScrollH) <= 1 };
    await shot(p, `bottom-${w}x${h}`);
    check(last.card[3] <= m.lib[3] - 1, `${w}x${h}: last row not cut by the panel (row bottom ${last.card[3]}, panel bottom ${m.lib[3]})`);
    check(gap >= 8, `${w}x${h}: last row has breathing room (gap ${gap}px)`);
    check(m.lib[3] <= h + 0.5 && m.lib[1] >= -0.5, `${w}x${h}: pinned sidebar panel fits the viewport (${m.lib[1]}..${m.lib[3]} of ${h})`);
    // keyboard navigation to the last row reveals it entirely (ring included)
    await p.evaluate(() => { document.querySelector(".carnet-library").scrollTop = 0; });
    await p.focus('#carnet-library-list [data-carnet-page-id="' + last.id + '"]');
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
    await p.waitForTimeout(80);
    const g = await focusGeom(p);
    OUT.scroll[`${w}x${h}`].focusLast = g;
    check(g.ok && g.rowFullyInLib, `${w}x${h}: keyboard-focused last row is fully inside the panel (row ${g.rowTop}..${g.rowBottom}, panel ${g.libTop}..${g.libBottom})`);
    check(g.ringInPanel, `${w}x${h}: its focus ring is fully inside the panel viewport (ring ${g.ring[1]}..${g.ring[3]}, panel ${g.libTop}..${g.libBottom})`);
    check(g.rowInViewport, `${w}x${h}: and fully inside the browser viewport (${g.rowTop}..${g.rowBottom} of ${h})`);
    await p.context().close();
  }
});

// ---------------------------------------------------------------- 4. keyboard walk reveals each row entirely
scenario("L4 keyboard Tab walk through the list keeps every focused row fully visible", async () => {
  const { p } = await world({ width: 1366, height: 768 }, 40);
  const first = await p.evaluate(() => document.querySelector("#carnet-library-list .carnet-card-main").dataset.carnetPageId);
  await p.focus('#carnet-library-list [data-carnet-page-id="' + first + '"]');
  await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
  let bad = 0, steps = 0, worst = 0;
  for (let i = 0; i < 46; i++) {
    const g = await focusGeom(p);
    if (!g.ok) break;
    steps++;
    if (!g.rowFullyInLib || !g.ringInPanel || g.clipByCard > 0.5 || g.cardH < 40 || !g.visible) { bad++; worst = Math.max(worst, g.rowBottom - g.libBottom, g.libTop - g.rowTop, g.clipByCard, g.cardH < 40 ? 40 - g.cardH : 0); }
    await p.keyboard.press("Tab");
  }
  OUT.scroll.walk = { steps, bad, worst };
  check(steps >= 30, `walk visited ${steps} rows`);
  check(bad === 0, `every keyboard-focused row whole, fully visible, with an unclipped visible ring (violations ${bad}, worst ${worst}px)`);
  await p.context().close();
});

// ---------------------------------------------------------------- 4b. dark scheme
scenario("L4b dark colour scheme: same title / ring contract", async () => {
  const { p } = await world({ width: 1366, height: 768 }, 6, { colorScheme: "dark" });
  const m = await measureRows(p);
  for (const r of m.rows.filter((x) => /^page-long-/.test(x.id))) {
    check(r.ellipsis && r.title[2] <= r.card[2] + 0.5 && !r.contentClippedY, `dark: "${r.text.slice(0, 28)}…" ellipsised inside a whole row`);
  }
  await p.focus('#carnet-library-list [data-carnet-page-id="page-long-1"]');
  await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab");
  const g = await focusGeom(p);
  OUT.rows["dark-focused"] = g;
  await shot(p, "dark-focused-1366x768");
  check(g.ok && g.visible && g.clipByCard <= 0.5, `dark: focus ring visible and unclipped (${g.outline})`);
  check(g.ringContrastOk, `dark: focus ring contrasts with the panel (${g.ringContrast})`);
  await p.context().close();
});

// ---------------------------------------------------------------- 5. empty journal marks
scenario("L5 empty journal marks are empty list-type blocks (investigation)", async () => {
  const { p } = await world({ width: 1366, height: 900 }, 3);
  await selectRow(p, '#carnet-library-list [data-carnet-page-id="page-journal"]');
  await p.waitForFunction(() => document.querySelector("#hq-carnet-editor").dataset.pageId === "page-journal");
  await p.waitForSelector('[data-carnet-block-id="block-j4"]');
  const info = await p.evaluate(() => {
    const ed = document.getElementById("hq-carnet-editor");
    return [...ed.querySelectorAll("[data-carnet-block-id]")].map((n) => {
      const b = getComputedStyle(n, "::before"), a = getComputedStyle(n, "::after");
      const cs = getComputedStyle(n);
      return { id: n.dataset.carnetBlockId, tag: n.tagName, type: n.dataset.lineType || n.dataset.carnetType || null, role: n.getAttribute("role"), text: n.textContent, empty: !n.textContent.trim(), before: b.content, beforeColor: b.color, beforeSize: b.fontSize, ariaHidden: n.getAttribute("aria-hidden"), padL: cs.paddingLeft, h: Math.round(n.getBoundingClientRect().height) };
    });
  });
  OUT.marks.blocks = info;
  for (const b of info) console.log("      " + JSON.stringify(b));
  await shot(p, "journal-empty-marks");
  const bullets = info.filter((b) => b.empty && b.before && b.before !== "none" && b.before !== "normal");
  check(bullets.length >= 2, `empty marks come from ::before on empty list-type blocks (${bullets.map((b) => b.id + ":" + b.before).join(", ")})`);
  // type text in an empty bullet: the mark stays (it is the list marker), content appears beside it
  await p.click('[data-carnet-block-id="block-j4"]');
  await p.keyboard.type("Mesure du jeu");
  const after = await p.evaluate(() => { const n = document.querySelector('[data-carnet-block-id="block-j4"]'); const b = getComputedStyle(n, "::before"); return { text: n.textContent, before: b.content }; });
  OUT.marks.afterTyping = after;
  check(after.text === "Mesure du jeu" && after.before === bullets.find((b) => b.id === "block-j4").before, "marker is the same list bullet before and after typing (a real empty bullet block, not a stray artifact)");
  await p.context().close();
});

// ---------------------------------------------------------------- 6. FAB
// Placement is viewport-fixed on purpose (Quick Capture is global). What must hold: reachable, inside the viewport, and it must never cover the centre of
// another interactive control at any scroll position (the user can always scroll the page, so only a control that stays covered at its resting position counts).
const fabCover = (p) => p.evaluate(() => {
  const fab = document.querySelector(".hq-capture-fab");
  const fr = fab.getBoundingClientRect();
  const vis = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const hits = [];
  for (const n of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [tabindex='0']")) {
    if (n === fab || fab.contains(n) || !vis(n)) continue;
    const r = n.getBoundingClientRect();
    const ix = Math.max(0, Math.min(r.right, fr.right) - Math.max(r.left, fr.left)), iy = Math.max(0, Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top));
    if (!ix || !iy) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, cx)), Math.min(innerHeight - 1, Math.max(0, cy)));
    hits.push({ el: (n.id ? "#" + n.id : n.tagName.toLowerCase() + "." + String(n.className).split(" ")[0]) + " «" + (n.getAttribute("aria-label") || n.textContent || "").trim().slice(0, 18) + "»", pct: Math.round((ix * iy) / (r.width * r.height) * 100), centreCovered: !!top && (top === fab || fab.contains(top)) });
  }
  return { fab: [fr.left, fr.top, fr.right, fr.bottom].map(Math.round), scrollY: Math.round(scrollY), maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight), hits };
});
scenario("L6 Capture FAB placement across desktop widths (investigation)", async () => {
  // sidebar height changes where the bar rests at the end of the page: short (3), typical (30) and tall (80) lists at every asserted width
  const CASES = [...SIZES.flatMap(([w, h]) => [30, 3, 80].map((n) => [w, h, n])), [2560, 1080, 30], [3440, 1440, 30]];
  for (const [w, h, n] of CASES) {
    const { p } = await world({ width: w, height: h }, n);
    const f = await p.evaluate(() => {
      const fab = document.querySelector(".hq-capture-fab");
      const r = fab.getBoundingClientRect(), cs = getComputedStyle(fab);
      const shell = document.querySelector(".carnet.lib-dock") || document.querySelector(".carnet");
      const sr = shell.getBoundingClientRect();
      const main = document.querySelector(".carnet-main").getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav");
      const nr = nav ? nav.getBoundingClientRect() : null;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { vw: innerWidth, vh: innerHeight, fab: [r.left, r.top, r.right, r.bottom].map(Math.round), pos: cs.position, right: cs.right, bottom: cs.bottom, distRightEdge: Math.round(innerWidth - r.right), distBottomEdge: Math.round(innerHeight - r.bottom),
        shell: [sr.left, sr.right].map(Math.round), main: [main.left, main.right].map(Math.round), fabLeftMinusMainRight: Math.round(r.left - main.right), distFromShellRight: Math.round(sr.right - r.right),
        navSide: nr ? [Math.round(nr.left), Math.round(nr.right), Math.round(nr.top), Math.round(nr.bottom)] : null, hitIsFab: !!hit && (hit === fab || fab.contains(hit)) };
    });
    f.cover = {};
    for (const pos of ["top", "mid", "end"]) {
      await p.evaluate((q) => { const max = document.documentElement.scrollHeight - innerHeight; window.scrollTo(0, q === "top" ? 0 : q === "mid" ? Math.round(max / 2) : max); }, pos);
      await p.waitForTimeout(100);
      f.cover[pos] = await fabCover(p);
      if (pos === "end") await shot(p, `fab-end-${w}x${h}-${n}p`);
    }
    OUT.fab[`${w}x${h}-${n}pages`] = f;
    console.log("      " + JSON.stringify({ ...f, cover: undefined }));
    for (const pos of ["top", "mid", "end"]) console.log(`      cover@${pos} (scrollY ${f.cover[pos].scrollY}/${f.cover[pos].maxScroll}): ${JSON.stringify(f.cover[pos].hits)}`);
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, `fab-${w}x${h}-${n}p`);
    check(f.pos === "fixed", `${w}/${n}p: FAB is viewport-fixed`);
    check(f.hitIsFab, `${w}: FAB is reachable (topmost at its centre)`);
    check(f.distRightEdge >= 8 && f.distBottomEdge >= 8, `${w}: FAB keeps >=8px from viewport edges (${f.distRightEdge}/${f.distBottomEdge})`);
    check(f.fab[3] <= f.vh && f.fab[2] <= f.vw, `${w}: FAB fully inside the viewport`);
    // Resting-state contract: at the top and at the end of the page the FAB has ZERO intersection with every interactive control of the Carnet bottom bar.
    // (While scrolling, the bar leaving its pin necessarily travels under any fixed FAB for a moment: recorded as transient, not asserted.)
    const scan = await p.evaluate(async () => {
      const fab = document.querySelector(".hq-capture-fab"), bar = document.querySelector(".carnet-bar-bottom");
      const max = document.documentElement.scrollHeight - innerHeight; const out = { px: 0, at: 0, top: [], end: [], max: Math.round(max) };
      const hits = () => {
        const a = fab.getBoundingClientRect(); const r = [];
        for (const n of bar.querySelectorAll("button, a[href], input, select, textarea, [role=button], [tabindex]")) {
          const b = n.getBoundingClientRect(); if (!b.width || !b.height) continue;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0 && oy > 0) r.push((n.id ? "#" + n.id : n.tagName.toLowerCase()) + " " + Math.round(ox) + "x" + Math.round(oy) + "px");
        }
        return r;
      };
      for (let y = 0; y <= max + 20; y += 20) {
        window.scrollTo(0, Math.min(y, max)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const a = fab.getBoundingClientRect(), b = bar.getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const px = ox > 0 && oy > 0 ? Math.round(ox * oy) : 0;
        if (px > out.px) { out.px = px; out.at = Math.round(window.scrollY); }
        if (y === 0) out.top = hits();
        if (Math.min(y, max) === max) out.end = hits();
      }
      return out;
    });
    f.scan = scan;
    check(scan.top.length === 0, `${w}: top of page (${n} pages) — FAB intersects no bottom-bar control (${scan.top.join(", ") || "none"})`);
    check(scan.end.length === 0, `${w}: end of page (${n} pages) — FAB intersects no bottom-bar control (${scan.end.join(", ") || "none"}; transient worst while scrolling ${scan.px}px² at ${scan.at}/${scan.max})`);
    const resting = f.cover.end.hits.filter((x) => x.centreCovered);
    check(resting.length === 0, `${w}: at the end of the page the FAB covers the centre of no control (${resting.map((x) => x.el).join(", ") || "none"})`);
    const atTop = f.cover.top.hits.filter((x) => x.centreCovered);
    check(atTop.length === 0, `${w}: at the top of the page the FAB covers the centre of no control (${atTop.map((x) => x.el).join(", ") || "none"})`);
    await p.context().close();
  }
});

// ---------------------------------------------------------------- runner
async function main() {
  try { browser = await chromium.launch(); } catch (e) { console.log(`SKIP: chromium unavailable (${String(e.message).split("\n")[0]})`); process.exit(0); }
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const [name, fn] of scenarios) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    console.log("\n# " + name);
    try { await fn(); } catch (e) { failures.push([name, e]); console.log("  FAIL ", e.message.split("\n").slice(0, 8).join(" | ")); }
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
  await browser.close();
  for (const s of started) s.close();
  OUT.findings = findings;
  if (outFile) writeFileSync(outFile, JSON.stringify(OUT, null, 2));
  console.log(`\n${passed} checks passed, ${findings.length} probe finding(s), ${failures.length} scenario failure(s)`);
  for (const [n, e] of failures) console.log(" - " + n + ": " + e.message.split("\n")[0]);
  if (errors.length) { console.log("BROWSER ERRORS:\n" + errors.slice(0, 10).join("\n")); failures.push(["browser errors", new Error(errors[0])]); }
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
