/* Transfert HQ — Carnet Product Phase 2: structured blocks core (PURE: no DOM, no network, no storage).
 *
 * Four ATOM block types, each with ONE bounded payload under its own key (byte-for-byte the rules of
 * hq_carnet_rich.py, checked by the shared vectors tests/fixtures_carnet_structured.json):
 *   table      {header: bool, rows: [[cell,...],...]}                       1-20 rows x 1-10 cols, rectangular, text cells
 *   callout    {kind: note|info|warning, title, body}                       icon derived in the UI, never stored
 *   toggle     {summary, body}                                              plain text body, nesting depth 0, open/closed is UI state
 *   imagegroup {layout: two|three|compare, items: [{id,mime,w,h,caption}]}  2-3 DISTINCT Stage-06 assets
 *   drawing    {id}                                                         (Phase 3) ONE immutable Dessiner stem; Dessiner owns the drawing
 * Every string is one line (no C0/DEL/C1 control, no U+2028/9, no unpaired surrogate) except the multi-line `body`
 * fields ("\n" only). Offsets, marks, find/replace, titles and previews never touch these blocks. No HTML anywhere.
 *
 * Also: the deterministic TSV codec (copy / bounded atomic paste), the pure table edit operations, the compact draft
 * encoding (`fmt` 4th element), and the readable TXT / Markdown renderers (same words as the server).
 *
 * Plain ES2020, UMD (browser global HqCarnetStruct / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetStruct = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TYPES = ["table", "callout", "toggle", "imagegroup", "drawing"];
  const KEY = { table: "table", callout: "callout", toggle: "toggle", imagegroup: "group", drawing: "drawing" };
  const DRAWINGS_PER_PAGE_MAX = 32;
  const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const DRAWING_SUFFIX_RE = /_HQWeb(?:-Mobile|-Desktop)?$/;
  const TABLE_ROWS_MAX = 20;
  const TABLE_COLS_MAX = 10;
  const CELL_U16_MAX = 200;
  const CELL_BYTES_MAX = 800;
  const TABLE_BYTES_MAX = 16 * 1024;
  const TABLES_PER_PAGE_MAX = 20;
  const CALLOUT_KINDS = ["note", "info", "warning"];
  const CALLOUT_TITLE_MAX = 120;
  const CALLOUT_BODY_MAX = 2000;
  const CALLOUT_BODY_LINES_MAX = 20;
  const TOGGLE_SUMMARY_MAX = 160;
  const TOGGLE_BODY_MAX = 4000;
  const TOGGLE_BODY_LINES_MAX = 50;
  const NOTES_PER_PAGE_MAX = 100;
  const GROUP_LAYOUTS = { two: 2, three: 3, compare: 2 };
  const GROUP_LAYOUT_ORDER = ["two", "three", "compare"];
  const GROUPS_PER_PAGE_MAX = 16;
  const STRUCT_BYTES_MAX = 96 * 1024;
  const CALLOUT_LABEL = { note: "Note", info: "Info", warning: "Attention" };
  const GROUP_ITEM_LABEL = { compare: ["Avant", "Après"] };
  const GROUP_ITEM_KEYS = "caption,h,id,mime,w";

  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  }

  /** One line of visible structured text (mirror hq_carnet_rich._struct_line). Returns the string or null. */
  function oneLine(v, limit, allowEmpty) {
    if (typeof v !== "string" || CTRL.test(v) || LONE.test(v) || v.length > limit || (allowEmpty === false && !v)) return null;
    return v;
  }

  /** Several lines separated by "\n" only (mirror _struct_body). */
  function bodyText(v, limit, maxLines) {
    if (typeof v !== "string" || v.length > limit) return null;
    const lines = v.split("\n");
    if (lines.length > maxLines) return null;
    for (const l of lines) if (oneLine(l, limit) === null) return null;
    return v;
  }

  function checkTable(t) {
    if (!isObj(t) || Object.keys(t).sort().join(",") !== "header,rows" || typeof t.header !== "boolean" || !Array.isArray(t.rows)) return null;
    if (t.rows.length < 1 || t.rows.length > TABLE_ROWS_MAX) return null;
    let width = -1;
    let total = 0;
    const rows = [];
    for (const row of t.rows) {
      if (!Array.isArray(row) || row.length < 1 || row.length > TABLE_COLS_MAX || (width >= 0 && row.length !== width)) return null;
      width = row.length;
      const clean = [];
      for (const cell of row) {
        const s = oneLine(cell, CELL_U16_MAX);
        if (s === null) return null;
        const n = utf8Len(s);
        if (n > CELL_BYTES_MAX) return null;
        total += n;
        clean.push(s);
      }
      rows.push(clean);
    }
    return total > TABLE_BYTES_MAX ? null : { header: t.header, rows };
  }

  function checkCallout(c) {
    if (!isObj(c) || Object.keys(c).sort().join(",") !== "body,kind,title" || CALLOUT_KINDS.indexOf(c.kind) < 0) return null;
    const title = oneLine(c.title, CALLOUT_TITLE_MAX);
    const body = bodyText(c.body, CALLOUT_BODY_MAX, CALLOUT_BODY_LINES_MAX);
    return title === null || body === null ? null : { kind: c.kind, title, body };
  }

  function checkToggle(t) {
    if (!isObj(t) || Object.keys(t).sort().join(",") !== "body,summary") return null;
    const summary = oneLine(t.summary, TOGGLE_SUMMARY_MAX, false);
    const body = bodyText(t.body, TOGGLE_BODY_MAX, TOGGLE_BODY_LINES_MAX);
    return summary === null || body === null ? null : { summary, body };
  }

  /** `checkAsset` is the Stage-06 single-image check of hq-carnet-rich.js (the SAME validation for every child). */
  function checkGroup(g, checkAsset) {
    if (!isObj(g) || Object.keys(g).sort().join(",") !== "items,layout" || !(g.layout in GROUP_LAYOUTS) || !Array.isArray(g.items)) return null;
    if (g.items.length !== GROUP_LAYOUTS[g.layout]) return null;
    const seen = new Set();
    const items = [];
    for (const it of g.items) {
      if (!isObj(it) || Object.keys(it).sort().join(",") !== GROUP_ITEM_KEYS) return null;
      const full = checkAsset({ id: it.id, mime: it.mime, w: it.w, h: it.h, caption: it.caption, width: 100, layout: "inline" });
      if (!full || seen.has(full.id)) return null;
      seen.add(full.id);
      items.push({ id: full.id, mime: full.mime, w: full.w, h: full.h, caption: full.caption });
    }
    return { layout: g.layout, items };
  }

  /** Drawing reference: EXACTLY {id: <canonical Dessiner stem>}. Nothing else is ever stored (no name, path, URL, preview). */
  function checkDrawing(d) {
    if (!isObj(d) || Object.keys(d).join(",") !== "id" || typeof d.id !== "string" || !STEM_RE.test(d.id)) return null;
    return { id: d.id };
  }

  /** Readable name derived from the stem itself (never stored). */
  function drawingLabel(stem) {
    return stem.replace(DRAWING_SUFFIX_RE, "") || stem;
  }

  /** Strict payload check of one structured block. Clean copy or null. */
  function checkPayload(type, p, checkAsset) {
    if (type === "table") return checkTable(p);
    if (type === "callout") return checkCallout(p);
    if (type === "toggle") return checkToggle(p);
    if (type === "imagegroup") return checkGroup(p, checkAsset);
    if (type === "drawing") return checkDrawing(p);
    return null;
  }

  function clone(p) {
    return JSON.parse(JSON.stringify(p));
  }

  /** Visible user text of a block in reading order (cells, titles, bodies, captions). */
  function strings(type, p) {
    if (type === "table") return [].concat(...p.rows);
    if (type === "callout") return [p.title, p.body].filter(Boolean);
    if (type === "toggle") return [p.summary, p.body].filter(Boolean);
    if (type === "imagegroup") return p.items.map((a) => a.caption).filter(Boolean);
    return []; // a drawing contributes no text of its own
  }

  function bytesOf(type, p) {
    return strings(type, p).reduce((n, s) => n + utf8Len(s), 0);
  }

  // ------------------------------------------------------------------ compact draft encoding (fixed-order arrays)

  function encode(type, p) {
    if (type === "table") return [p.header ? 1 : 0, p.rows];
    if (type === "callout") return [CALLOUT_KINDS.indexOf(p.kind), p.title, p.body];
    if (type === "toggle") return [p.summary, p.body];
    if (type === "drawing") return [p.id];
    return [GROUP_LAYOUT_ORDER.indexOf(p.layout), p.items.map((a) => [a.id, a.mime, a.w, a.h, a.caption])];
  }

  function decode(type, a, checkAsset) {
    if (!Array.isArray(a)) return null;
    if (type === "table") return a.length === 2 && (a[0] === 0 || a[0] === 1) ? checkTable({ header: a[0] === 1, rows: a[1] }) : null;
    if (type === "callout") return a.length === 3 && CALLOUT_KINDS[a[0]] ? checkCallout({ kind: CALLOUT_KINDS[a[0]], title: a[1], body: a[2] }) : null;
    if (type === "toggle") return a.length === 2 ? checkToggle({ summary: a[0], body: a[1] }) : null;
    if (type === "drawing") return a.length === 1 ? checkDrawing({ id: a[0] }) : null;
    if (type === "imagegroup") {
      if (a.length !== 2 || !GROUP_LAYOUT_ORDER[a[0]] || !Array.isArray(a[1])) return null;
      const items = [];
      for (const r of a[1]) {
        if (!Array.isArray(r) || r.length !== 5) return null;
        items.push({ id: r[0], mime: r[1], w: r[2], h: r[3], caption: r[4] });
      }
      return checkGroup({ layout: GROUP_LAYOUT_ORDER[a[0]], items }, checkAsset);
    }
    return null;
  }

  // ------------------------------------------------------------------ table edits (pure; each returns a new rows array or null)

  function blankRow(width) {
    return new Array(width).fill("");
  }

  function addRow(rows, at) {
    if (rows.length >= TABLE_ROWS_MAX) return null;
    const i = Math.max(0, Math.min(rows.length, at === undefined ? rows.length : at));
    const out = rows.map((r) => r.slice());
    out.splice(i, 0, blankRow(rows[0].length));
    return out;
  }

  function removeRow(rows, at) {
    if (rows.length <= 1 || at < 0 || at >= rows.length) return null;
    const out = rows.map((r) => r.slice());
    out.splice(at, 1);
    return out;
  }

  function addCol(rows, at) {
    if (rows[0].length >= TABLE_COLS_MAX) return null;
    const i = Math.max(0, Math.min(rows[0].length, at === undefined ? rows[0].length : at));
    return rows.map((r) => {
      const c = r.slice();
      c.splice(i, 0, "");
      return c;
    });
  }

  function removeCol(rows, at) {
    if (rows[0].length <= 1 || at < 0 || at >= rows[0].length) return null;
    return rows.map((r) => {
      const c = r.slice();
      c.splice(at, 1);
      return c;
    });
  }

  /** Keep only what a one-line cell may hold (controls -> space, unpaired surrogates dropped). Never truncates. */
  function cleanCell(v) {
    return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(new RegExp(LONE.source, "g"), "");
  }

  // ------------------------------------------------------------------ TSV

  /** Deterministic TSV of a table: rows joined by "\n", cells by "\t", no trailing newline, no header marker, no metadata. */
  function formatTsv(rows) {
    return rows.map((r) => r.join("\t")).join("\n");
  }

  /**
   * Parse pasted text as a grid: rows by CRLF / LF / CR, cells by TAB (no quoting rules). One trailing empty line is dropped
   * (spreadsheets add it), short rows are padded with empty cells, cells are cleaned. Returns {rows} or {error}.
   * Nothing is clamped: more than 20 rows, 10 columns, a cell over 200 units or the table size cap rejects the WHOLE paste.
   */
  function parseTsv(text) {
    if (typeof text !== "string" || !text) return { error: "empty" };
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > TABLE_ROWS_MAX) return { error: "rows" };
    let width = 0;
    const grid = lines.map((l) => {
      const cells = l.split("\t");
      width = Math.max(width, cells.length);
      return cells;
    });
    if (width > TABLE_COLS_MAX) return { error: "cols" };
    const rows = [];
    let total = 0;
    for (const g of grid) {
      const row = [];
      for (let c = 0; c < width; c += 1) {
        const s = cleanCell(c < g.length ? g[c] : "");
        if (s.length > CELL_U16_MAX) return { error: "cell" };
        total += utf8Len(s);
        row.push(s);
      }
      rows.push(row);
    }
    return total > TABLE_BYTES_MAX ? { error: "size" } : { rows };
  }

  /**
   * Paste a parsed grid into `rows` with its top-left corner at (r, c). The table grows to fit, but never beyond its bounds:
   * the result is validated as a whole and the paste is rejected atomically (null) when it does not fit.
   */
  function pasteGrid(rows, r, c, grid) {
    const h = Math.max(rows.length, r + grid.length);
    const w = Math.max(rows[0].length, c + grid[0].length);
    if (h > TABLE_ROWS_MAX || w > TABLE_COLS_MAX) return null;
    const out = [];
    for (let i = 0; i < h; i += 1) {
      const row = [];
      for (let j = 0; j < w; j += 1) {
        const inGrid = i >= r && i < r + grid.length && j >= c && j < c + grid[0].length;
        row.push(inGrid ? grid[i - r][j - c] : i < rows.length && j < rows[0].length ? rows[i][j] : "");
      }
      out.push(row);
    }
    const ok = checkTable({ header: false, rows: out });
    return ok ? ok.rows : null;
  }

  // ------------------------------------------------------------------ image group edits (pure; each returns a NEW group or null)
  // A group always holds exactly its layout's number of DISTINCT children: an edit that would leave 1 child (or a
  // duplicate) is refused here, never persisted. The caller validates the result with checkGroup.

  function child(a) {
    return { id: a.id, mime: a.mime, w: a.w, h: a.h, caption: a.caption || "" };
  }

  /** Layout for n children: 2 -> "two" (or keep "compare"), 3 -> "three". null for any other count. */
  function layoutFor(n, keep) {
    if (n === 3) return "three";
    if (n === 2) return keep === "compare" ? "compare" : "two";
    return null;
  }

  /** Build a group from 2-3 distinct assets (the first keeps its caption). */
  function groupFrom(assets, layout) {
    const lay = layout && GROUP_LAYOUTS[layout] === assets.length ? layout : layoutFor(assets.length, layout);
    if (!lay || new Set(assets.map((a) => a.id)).size !== assets.length) return null;
    return { layout: lay, items: assets.map(child) };
  }

  function groupAdd(g, asset) {
    if (g.items.length >= 3 || g.items.some((a) => a.id === asset.id)) return null;
    return groupFrom(g.items.concat([child(asset)]), "three");
  }

  function groupRemove(g, i) {
    if (g.items.length <= 2 || i < 0 || i >= g.items.length) return null;
    return groupFrom(g.items.filter((_, k) => k !== i), g.layout);
  }

  function groupMove(g, i, dir) {
    const j = i + dir;
    if (i < 0 || j < 0 || i >= g.items.length || j >= g.items.length) return null;
    const items = g.items.map(child);
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
    return { layout: g.layout, items };
  }

  /** Replace child i with another asset (its caption is kept); the new asset must not already be in the group. */
  function groupReplace(g, i, asset) {
    if (i < 0 || i >= g.items.length || g.items.some((a, k) => k !== i && a.id === asset.id)) return null;
    const items = g.items.map(child);
    items[i] = { id: asset.id, mime: asset.mime, w: asset.w, h: asset.h, caption: items[i].caption };
    return { layout: g.layout, items };
  }

  /** two <-> compare only (same child count); "three" has no alternative. */
  function groupSetLayout(g, layout) {
    if (GROUP_LAYOUTS[layout] !== g.items.length) return null;
    return { layout, items: g.items.map(child) };
  }

  // ------------------------------------------------------------------ readable exports (same words as the server)

  function txtLines(type, p) {
    if (type === "table") return ["[Tableau]"].concat(p.rows.map((r) => r.join(" | ")));
    if (type === "callout") return ["[" + CALLOUT_LABEL[p.kind] + "]" + (p.title ? " " + p.title : "")].concat(p.body ? p.body.split("\n") : []);
    if (type === "toggle") return ["[Section] " + p.summary].concat(p.body ? p.body.split("\n") : []);
    if (type === "drawing") return ["[Croquis : " + drawingLabel(p.id) + "]"];
    const labels = GROUP_ITEM_LABEL[p.layout];
    return p.items.map((a, n) => {
      const label = labels ? labels[n] : "Image";
      return a.caption ? "[" + label + " : " + a.caption + "]" : "[" + label + "]";
    });
  }

  /** `h` = {esc, lineStart, alt, path} (the Markdown helpers of hq-carnet-rich.js). */
  function mdBlock(type, p, assetPaths, h) {
    if (type === "table") {
      const width = p.rows[0].length;
      const head = p.header ? p.rows[0] : new Array(width).fill("");
      const body = p.header ? p.rows.slice(1) : p.rows;
      const line = (r) => "| " + r.map(h.esc).join(" | ") + " |";
      return [line(head), "|" + new Array(width).fill("---").join("|") + "|"].concat(body.map(line)).join("\n");
    }
    if (type === "callout") {
      const lines = ["> **" + CALLOUT_LABEL[p.kind] + "**" + (p.title ? " — " + h.esc(p.title) : "")];
      for (const l of p.body ? p.body.split("\n") : []) if (l.trim()) lines.push(">", "> " + h.lineStart(h.esc(l)));
      return lines.join("\n");
    }
    if (type === "toggle") {
      const parts = ["**" + h.esc(p.summary) + "**"];
      for (const l of p.body.split("\n")) if (l.trim()) parts.push(h.lineStart(h.esc(l)));
      return parts.join("\n\n");
    }
    if (type === "drawing") return "*\\[Croquis : " + h.esc(drawingLabel(p.id)) + "\\]*"; // a text label only: no path, URL or preview asset
    const labels = GROUP_ITEM_LABEL[p.layout];
    return p.items.map((a, n) => {
      const rel = assetPaths && assetPaths[a.id];
      const label = labels ? labels[n] : "Image";
      const piece = [];
      if (labels) piece.push("**" + label + "**");
      if (rel) {
        piece.push("![" + h.alt(a.caption) + "](" + h.path(rel) + ")");
        if (a.caption) piece.push("*" + h.esc(a.caption) + "*");
      } else piece.push(a.caption ? "*\\[" + label + " : " + h.esc(a.caption) + "\\]*" : "*\\[" + label + "\\]*");
      return piece.join("\n\n");
    }).join("\n\n");
  }

  return {
    TYPES, KEY, TABLE_ROWS_MAX, TABLE_COLS_MAX, CELL_U16_MAX, CELL_BYTES_MAX, TABLE_BYTES_MAX, TABLES_PER_PAGE_MAX, CALLOUT_KINDS, CALLOUT_TITLE_MAX,
    CALLOUT_BODY_MAX, CALLOUT_BODY_LINES_MAX, TOGGLE_SUMMARY_MAX, TOGGLE_BODY_MAX, TOGGLE_BODY_LINES_MAX, NOTES_PER_PAGE_MAX, GROUP_LAYOUTS,
    GROUP_LAYOUT_ORDER, GROUPS_PER_PAGE_MAX, DRAWINGS_PER_PAGE_MAX, STEM_RE, STRUCT_BYTES_MAX, CALLOUT_LABEL, GROUP_ITEM_LABEL,
    checkPayload, checkTable, checkCallout, checkToggle, checkGroup, checkDrawing, drawingLabel, clone, strings, bytesOf, utf8Len, encode, decode,
    addRow, removeRow, addCol, removeCol, cleanCell, groupFrom, groupAdd, groupRemove, groupMove, groupReplace, groupSetLayout, layoutFor, formatTsv, parseTsv, pasteGrid, txtLines, mdBlock,
  };
});
