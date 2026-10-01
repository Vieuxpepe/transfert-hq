/* Transfert HQ — Carnet Stage 04: structured content model (pure) + editor DOM bridge.
 *
 * A page is a list of one-line blocks ("lines"): {type, checked, text, marks}.
 *   type  : paragraph | heading | bullet | number | check | image (Stage 06)
 *   marks : [{type: bold|italic|underline|highlight|code|link, start, end, href?|ref?}]
 *           offsets are UTF-16 code units inside the line (same unit as the server).
 *   link  : href is http(s) only; ref = {kind: note|file|drawing|model|media, id}.
 *   citation (Stage 05): an ATOM over the visible label text. cite = {src, loc:{kind,text}, pdf, ok,
 *           snap:{title,author?,edition?,year?,ident?}, from}. Never merged, never overlapping another
 *           citation or a link; part of canonical equality (fmt) so two citations with the same label but
 *           another edition / locator / PDF page / verified flag / provenance are different content.
 *   image (Stage 06): an ATOM line with `asset` = {id: asset-<24 hex>, mime, w, h, width: 30..100 (%), layout:
 *           "inline", caption}. Its `text` is always "" and it never has marks: it occupies no text offset,
 *           so marks, find/replace, offsets and titles never touch it. The bytes live on the server
 *           (/api/carnet/asset/<id>); a page only ever carries this bounded metadata.
 *   calc / measure (Stage 07): ATOM lines like an image (text "", no marks, no caret inside) carrying a bounded declarative
 *           payload in `eng` (see hq-carnet-eng.js): never executable, never recomputed silently.
 *   decision (Stage 07): an ordinary text line (text + marks) with `eng` = {at}; shown as "DÉCISION · time".
 * Flat page text = lines.map(l => l.text).join("\n").
 * Every line may carry an `id`: a server block id (block-…, authoritative, kept through typing,
 * Enter/split, insertion, deletion and formatting) or a client-only temporary key (tmp-N) for a
 * block the server has not seen yet. Ids never take part in equality (fmt/text only); the server
 * assigns real ids to new blocks and the client adopts them after a save.
 *
 * The whole editable structure (everything except the flat text) is summarised by ONE canonical
 * string, `fmt` (fmtOf): "" for plain paragraphs, else a JSON array built from fixed-order
 * arrays (never object keys), so equality is a plain string compare and never depends on key
 * order. text + fmt fully determine the content; ids are server-owned and ignored.
 *
 * Canonical marks mirror hq_carnet_rich.canonical_marks: same-type/same-target ranges that
 * overlap or touch merge; sorted by (start, end, type order). Two different links never overlap.
 *
 * Never HTML: the DOM is built with createElement/textContent/setAttribute only, and read back
 * through a strict whitelist (parseEditor). Plain ES2020, no build step.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetRich = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  // Stage 07 engineering core (pure). In a browser it is loaded before this file; without it the three engineering
  // block types are simply unknown (their pages fail closed instead of being rewritten).
  const Eng = typeof module === "object" && module && module.exports ? require("./hq-carnet-eng.js") : global.HqCarnetEng || null;
  const ENG_TYPES = Eng ? Eng.ENG_TYPES.slice() : [];
  const BLOCK_TYPES = ["paragraph", "heading", "bullet", "number", "check", "image"].concat(ENG_TYPES);
  const TYPE_CODE = { paragraph: "p", heading: "h", bullet: "b", number: "n", check: "c", image: "i", calc: "k", measure: "m", decision: "d" };
  const CODE_TYPE = { p: "paragraph", h: "heading", b: "bullet", n: "number", c: "check", i: "image", k: "calc", m: "measure", d: "decision" };
  const ASSET_ID = /^asset-[0-9a-f]{24}$/;
  const ASSET_MIMES = ["image/jpeg", "image/png", "image/webp"];
  const ASSET_LONG_SIDE_MAX = 2560; // server: hq_carnet_media.MAX_LONG_SIDE
  const ASSET_WIDTH_MIN = 30;
  const ASSET_WIDTH_MAX = 100;
  const ASSET_CAPTION_MAX = 300;
  const IMAGES_PER_PAGE_MAX = 32;
  const ASSET_URL = "/api/carnet/asset/";
  const INLINE = ["bold", "italic", "underline", "highlight", "code"];
  const MARK_ORDER = INLINE.concat(["link", "citation"]);
  const LOCATOR_KINDS = ["page", "section", "clause", "chapter", "figure", "table", "custom"];
  const LOCATOR_TEXT_MAX = 120;
  const CITE_PAGE_MAX = 100000;
  const EDITION_ID = /^srce-[A-Za-z0-9_-]{1,64}$/;
  const REF_KINDS = ["note", "file", "drawing", "model", "media", "project"];
  const BLOCKS_MAX = 8192; // structured lines per page (server: hq_carnet_rich.BLOCKS_MAX)
  const MARKS_PER_BLOCK_MAX = 128;
  const MARKS_TOTAL_MAX = 4000;
  const HREF_MAX = 2048;
  const MODEL_EXT = [".glb", ".stl", ".obj", ".3mf"];
  const MEDIA_EXT = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav"];
  const ROOTS = ["Inbox", "Uni", "Print"];

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function isInt(v) {
    return typeof v === "number" && Number.isInteger(v);
  }

  // ------------------------------------------------------------------ links

  /** Returns the URL when it is a plain http(s) URL with a host, else null (never throws). */
  function safeHref(value) {
    if (typeof value !== "string" || !value || value.length > HREF_MAX) return null;
    if (/[\u0000- \u007f\\<>"'`]/.test(value)) return null;
    if (!/^https?:\/\/[^\/?#]+/i.test(value)) return null; // a non-empty authority right after "//" (parity with the server)
    let u;
    try {
      u = new URL(value);
    } catch (_) {
      return null;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    if (u.username || u.password) return null;
    return value;
  }

  function checkRef(ref) {
    if (!isObj(ref) || Object.keys(ref).sort().join(",") !== "id,kind") return null;
    const kind = ref.kind;
    const id = ref.id;
    if (REF_KINDS.indexOf(kind) < 0 || typeof id !== "string") return null;
    if (kind === "note") {
      if (!/^page-[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    } else if (kind === "project") {
      if (!/^proj-[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    } else if (kind === "drawing") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)) return null;
    } else {
      if (!id || id.length > 512 || /[\\%\u0000-\u001f\u007f]/.test(id)) return null;
      const parts = id.split("/");
      if (parts.length < 2 || ROOTS.indexOf(parts[0]) < 0) return null;
      for (const p of parts) {
        if (!p || p === "." || p === ".." || p[0] === "." || p !== p.trim() || p.indexOf(":") >= 0 || p[p.length - 1] === ".") return null;
      }
      const low = id.toLowerCase();
      if (kind === "model" && !MODEL_EXT.some((x) => low.endsWith(x))) return null;
      if (kind === "media" && !MEDIA_EXT.some((x) => low.endsWith(x))) return null;
    }
    return { kind, id };
  }

  // ------------------------------------------------------------------ citations (mirror hq_carnet_rich.check_cite)

  const CITE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\t\r\n]/;
  // Explicit whitespace set, identical to hq_carnet_rich.WS_CHARS (never the language default: \s and str.split disagree).
  const WS = /[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/;

  // An unpaired UTF-16 surrogate is not text (the server cannot encode it as UTF-8): refused here too; valid pairs pass.
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  function citeText(v, limit, required) {
    if (typeof v !== "string" || CITE_CTRL.test(v) || LONE_SURROGATE.test(v)) return null;
    const out = v.split(WS).filter(Boolean).join(" ");
    if ((required && !out) || out.length > limit) return null;
    return out;
  }

  function checkLocator(loc) {
    if (!isObj(loc) || Object.keys(loc).sort().join(",") !== "kind,text" || LOCATOR_KINDS.indexOf(loc.kind) < 0) return null;
    const text = citeText(loc.text, LOCATOR_TEXT_MAX, false);
    return text == null ? null : { kind: loc.kind, text };
  }

  function checkPdf(v) {
    if (v === null) return null;
    return isInt(v) && v >= 1 && v <= CITE_PAGE_MAX ? v : undefined; // undefined = invalid
  }

  /** Canonical citation payload (fixed key order) or null. Never throws. */
  function checkCite(c) {
    if (!isObj(c) || Object.keys(c).sort().join(",") !== "from,loc,ok,pdf,snap,src") return null;
    if (typeof c.src !== "string" || !EDITION_ID.test(c.src) || typeof c.ok !== "boolean") return null;
    const loc = checkLocator(c.loc);
    const pdf = checkPdf(c.pdf);
    if (!loc || pdf === undefined) return null;
    if (c.ok && !loc.text && pdf === null) return null;
    const si = c.snap;
    if (!isObj(si) || !("title" in si) || Object.keys(si).some((k) => ["title", "author", "edition", "year", "ident"].indexOf(k) < 0)) return null;
    const title = citeText(si.title, 200, true);
    if (title == null) return null;
    const snap = { title };
    for (const [key, limit] of [["author", 120], ["edition", 40], ["ident", 60]]) {
      if (key in si) {
        const t = citeText(si[key], limit, true);
        if (t == null) return null;
        snap[key] = t;
      }
    }
    if ("year" in si) {
      if (!isInt(si.year) || si.year < 1400 || si.year > 2200) return null;
      snap.year = si.year;
    }
    let from = c.from;
    if (from !== null) {
      if (!isObj(from) || Object.keys(from).sort().join(",") !== "loc,ok,pdf,src") return null;
      if (typeof from.src !== "string" || !EDITION_ID.test(from.src) || typeof from.ok !== "boolean") return null;
      const floc = checkLocator(from.loc);
      const fpdf = checkPdf(from.pdf);
      if (!floc || fpdf === undefined) return null;
      from = { src: from.src, loc: floc, pdf: fpdf, ok: from.ok };
    }
    return { src: c.src, loc, pdf, ok: c.ok, snap, from };
  }

  function cloneCite(c) {
    return checkCite(c) || c;
  }

  /** Canonical, order-independent identity of a citation payload (used in equality and as a Map key). */
  function citeKey(c) {
    const s = c.snap;
    const f = c.from;
    return JSON.stringify([c.src, c.loc.kind, c.loc.text, c.pdf, c.ok ? 1 : 0,
      [s.title, s.author == null ? null : s.author, s.edition == null ? null : s.edition, s.year == null ? null : s.year, s.ident == null ? null : s.ident],
      f ? [f.src, f.loc.kind, f.loc.text, f.pdf, f.ok ? 1 : 0] : null]);
  }

  function citeFromKey(arr) {
    if (!Array.isArray(arr) || arr.length !== 7 || !Array.isArray(arr[5]) || arr[5].length !== 5) return null;
    const s = arr[5];
    const snap = { title: s[0] };
    if (s[1] !== null) snap.author = s[1];
    if (s[2] !== null) snap.edition = s[2];
    if (s[3] !== null) snap.year = s[3];
    if (s[4] !== null) snap.ident = s[4];
    let from = arr[6];
    if (from !== null) {
      if (!Array.isArray(from) || from.length !== 5) return null;
      from = { src: from[0], loc: { kind: from[1], text: from[2] }, pdf: from[3], ok: from[4] === 1 };
    }
    if (arr[4] !== 0 && arr[4] !== 1) return null;
    const c = checkCite({ src: arr[0], loc: { kind: arr[1], text: arr[2] }, pdf: arr[3], ok: arr[4] === 1, snap, from });
    return c && citeKey(c) === JSON.stringify(arr) ? c : null; // strictly canonical only
  }

  const LOC_PREFIX = { page: "p. ", section: "§ ", clause: "art. ", chapter: "chap. ", figure: "fig. ", table: "tab. ", custom: "" };

  function locatorLabel(loc, pdf) {
    if (loc && loc.text) return (LOC_PREFIX[loc.kind] || "") + loc.text;
    return pdf ? "p. PDF " + pdf : "à vérifier";
  }

  /** Visible text inserted in the note: "[Titre édition, p. 417]" (or "à vérifier" when no location yet). */
  function citationLabel(c) {
    const s = c.snap;
    return "[" + s.title + (s.edition ? " " + s.edition : "") + ", " + locatorLabel(c.loc, c.pdf) + "]";
  }

  function targetKey(m) {
    if (m.type === "citation") return "c\u0000" + citeKey(m.cite);
    if (m.type !== "link") return "";
    return m.href != null ? "h\u0000" + m.href : "r\u0000" + m.ref.kind + "\u0000" + m.ref.id;
  }

  // ------------------------------------------------------------------ marks

  function markKey(m) {
    return m.type + "\u0001" + targetKey(m);
  }

  function copyMark(m, start, end) {
    const out = { type: m.type, start, end };
    if (m.type === "citation") out.cite = cloneCite(m.cite);
    if (m.type === "link") {
      if (m.href != null) out.href = m.href;
      else out.ref = { kind: m.ref.kind, id: m.ref.id };
    }
    return out;
  }

  /** Canonical marks (input marks are structurally valid). Returns null on overlapping links. */
  function canonicalMarks(marks) {
    const groups = new Map();
    const cites = [];
    for (const m of marks) {
      if (!(m.end > m.start)) continue;
      if (m.type === "citation") {
        cites.push(copyMark(m, m.start, m.end)); // an atom: never merged
        continue;
      }
      const k = markKey(m);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const merged = [];
    for (const list of groups.values()) {
      list.sort((a, b) => a.start - b.start || a.end - b.end);
      let cur = null;
      for (const m of list) {
        if (cur && m.start <= cur.end) {
          if (m.end > cur.end) cur.end = m.end;
          continue;
        }
        if (cur) merged.push(cur);
        cur = copyMark(m, m.start, m.end);
      }
      if (cur) merged.push(cur);
    }
    for (const c of cites) merged.push(c);
    merged.sort((a, b) => a.start - b.start || a.end - b.end || MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type) ||
      (targetKey(a) < targetKey(b) ? -1 : targetKey(a) > targetKey(b) ? 1 : 0));
    let lastLinkEnd = -1;
    for (const m of merged) {
      if (m.type !== "link") continue;
      if (m.start < lastLinkEnd) return null;
      lastLinkEnd = m.end;
    }
    const atoms = merged.filter((m) => m.type === "citation");
    for (let i = 1; i < atoms.length; i += 1) if (atoms[i].start < atoms[i - 1].end) return null;
    for (const a of atoms) {
      for (const m of merged) if (m.type === "link" && a.start < m.end && m.start < a.end) return null;
    }
    return merged;
  }

  // ------------------------------------------------------------------ lines

  const REAL_ID = /^block-[A-Za-z0-9_-]{1,64}$/;
  const TMP_ID = /^tmp-[0-9]{1,12}$/;
  let tmpSeq = 0;

  function isRealId(id) {
    return typeof id === "string" && REAL_ID.test(id);
  }

  function isTmpId(id) {
    return typeof id === "string" && TMP_ID.test(id);
  }

  function tmpKey() {
    tmpSeq += 1;
    return "tmp-" + tmpSeq;
  }

  function cleanId(id) {
    return isRealId(id) || isTmpId(id) ? id : null;
  }

  const CAPTION_CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/; // C0 (tab, CR, LF), DEL, C1 (NEL), U+2028/U+2029: one line
  const CAPTION_LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  /** Caption rule, identical to hq_carnet_rich.check_caption: string, no control, no unpaired surrogate, <= 300 UTF-16 units. */
  function captionOk(c) {
    return typeof c === "string" && c.length <= ASSET_CAPTION_MAX && !CAPTION_CTRL.test(c) && !CAPTION_LONE_SURROGATE.test(c);
  }

  /** Make arbitrary input satisfy captionOk (controls -> space, unpaired surrogates dropped, cut at 300 units on a pair boundary). */
  function cleanCaptionText(v) {
    let t = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
    if (t.length > ASSET_CAPTION_MAX) {
      t = t.slice(0, ASSET_CAPTION_MAX);
      if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
    }
    return t;
  }

  /** Strict image metadata check (mirrors hq_carnet_rich.check_asset). Returns a clean copy or null. */
  function checkAsset(a) {
    if (!isObj(a) || Object.keys(a).sort().join(",") !== "caption,h,id,layout,mime,w,width") return null;
    if (typeof a.id !== "string" || !ASSET_ID.test(a.id) || ASSET_MIMES.indexOf(a.mime) < 0) return null;
    if (!isInt(a.w) || !isInt(a.h) || a.w < 1 || a.h < 1 || a.w > ASSET_LONG_SIDE_MAX || a.h > ASSET_LONG_SIDE_MAX) return null;
    if (!isInt(a.width) || a.width < ASSET_WIDTH_MIN || a.width > ASSET_WIDTH_MAX || a.layout !== "inline") return null;
    if (!captionOk(a.caption)) return null;
    return { id: a.id, mime: a.mime, w: a.w, h: a.h, width: a.width, layout: "inline", caption: a.caption };
  }

  function isEngType(type) {
    return ENG_TYPES.indexOf(type) >= 0;
  }

  /** An atom line has no text, no marks and no caret inside: an image, a calculation or a measurement. */
  function isAtomType(type) {
    return type === "image" || (!!Eng && Eng.ATOM_TYPES.indexOf(type) >= 0);
  }

  function isAtom(l) {
    return !!l && isAtomType(l.type);
  }

  function cloneEng(p) {
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  /** Optional link of a measurement: a Stage-05 source edition, or a stable HQ reference (media / drawing / file). */
  function measureLink(link) {
    if (!isObj(link) || Object.keys(link).sort().join(",") !== "id,kind" || !Eng || Eng.LINK_KINDS.indexOf(link.kind) < 0) return null;
    if (link.kind === "source") return Eng.linkShape(link);
    return checkRef(link);
  }

  /** Strict payload check of a Stage-07 block (mirrors hq_carnet_rich.check_eng). Clean copy or null. */
  function engPayload(type, p) {
    return Eng && isEngType(type) ? Eng.checkPayload(type, p, measureLink) : null;
  }

  function newLine(text, type, checked, marks, id, asset, eng) {
    const image = type === "image";
    const atom = isAtomType(type);
    return {
      type: type || "paragraph", checked: type === "check" ? !!checked : false, text: atom ? "" : text || "", marks: atom ? [] : marks || [],
      id: cleanId(id), asset: image && asset ? Object.assign({}, asset) : null, eng: isEngType(type) && eng ? cloneEng(eng) : null,
    };
  }

  function cloneLine(l) {
    return {
      type: l.type, checked: l.checked, text: l.text, marks: l.marks.map((m) => copyMark(m, m.start, m.end)), id: l.id || null,
      asset: l.asset ? Object.assign({}, l.asset) : null, eng: l.eng ? cloneEng(l.eng) : null,
    };
  }

  /** A new calculation / measurement atom (no id yet). null when the payload is not valid. */
  function engLine(type, payload) {
    const clean = Eng && Eng.ATOM_TYPES.indexOf(type) >= 0 ? engPayload(type, payload) : null;
    return clean ? newLine("", type, false, [], null, null, clean) : null;
  }

  /** A new decision line carrying `text` (one line) and the decision time (epoch seconds). */
  function decisionLine(text, at) {
    const clean = engPayload("decision", { at });
    return clean && typeof text === "string" && text.indexOf("\n") < 0 ? newLine(text, "decision", false, [], null, null, clean) : null;
  }

  function engOf(lines) {
    return lines.filter((l) => isEngType(l.type) && l.eng).map((l) => ({ type: l.type, payload: l.eng }));
  }

  /** Local display time of a decision/calculation: HH:MM today, else DD/MM HH:MM (device time zone, UI only). */
  function localTimeLabel(at, nowMs) {
    const d = new Date(at * 1000);
    const n = new Date(nowMs === undefined ? Date.now() : nowMs);
    const p2 = (x) => (x < 10 ? "0" + x : String(x));
    const hm = p2(d.getHours()) + ":" + p2(d.getMinutes());
    const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return same ? hm : p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " + hm;
  }

  /** A new image line (no id yet: the editor gives it a temporary key, the server the real id). */
  function imageLine(asset) {
    const clean = checkAsset(asset);
    return clean ? newLine("", "image", false, [], null, clean) : null;
  }

  function assetsOf(lines) {
    return lines.filter((l) => l.type === "image" && l.asset).map((l) => l.asset);
  }

  /** Give every line without an id a temporary key; a repeated id keeps its first line only. Mutates. */
  function ensureKeys(lines) {
    const seen = new Set();
    for (const l of lines) {
      if (l.id && !seen.has(l.id)) {
        seen.add(l.id);
        continue;
      }
      l.id = tmpKey();
      seen.add(l.id);
    }
    return lines;
  }

  function idsOf(lines) {
    return lines.map((l) => l.id || null);
  }

  function cloneLines(lines) {
    return lines.map(cloneLine);
  }

  function flat(lines) {
    return lines.map((l) => l.text).join("\n");
  }

  function plainLines(text) {
    return String(text).split("\n").map((t) => newLine(t));
  }

  function isPlain(lines) {
    return lines.every((l) => l.type === "paragraph" && !l.marks.length);
  }

  function normalizeLine(l) {
    let type = BLOCK_TYPES.indexOf(l.type) >= 0 ? l.type : "paragraph";
    if (type === "image") {
      const asset = checkAsset(l.asset);
      if (asset) return { type, checked: false, text: "", marks: [], id: cleanId(l.id), asset };
      type = "paragraph"; // an image without valid metadata is not an image
    }
    let eng = null;
    if (isEngType(type)) {
      eng = engPayload(type, l.eng);
      if (!eng) type = "paragraph"; // an engineering block without a valid payload is not one
      else if (isAtomType(type)) return { type, checked: false, text: "", marks: [], id: cleanId(l.id), asset: null, eng };
    }
    const marks = canonicalMarks(l.marks || []);
    return { type, checked: type === "check" ? !!l.checked : false, text: l.text, marks: marks || [], id: cleanId(l.id), asset: null, eng };
  }

  function fmtOf(lines) {
    if (isPlain(lines)) return "";
    return JSON.stringify(lines.map((l) => {
      const row = [
        TYPE_CODE[l.type],
        l.checked ? 1 : 0,
        l.marks.map((m) => {
          if (m.type === "citation") return [m.type, m.start, m.end, "c", JSON.parse(citeKey(m.cite))];
          if (m.type !== "link") return [m.type, m.start, m.end];
          return m.href != null ? [m.type, m.start, m.end, "h", m.href] : [m.type, m.start, m.end, "r", m.ref.kind, m.ref.id];
        }),
      ];
      // Only image rows carry a 4th element (fixed order, never object keys): every other row is
      // byte-identical to the pre-Stage-06 encoding, so existing drafts/bases stay comparable.
      if (l.type === "image") row.push([l.asset.id, l.asset.mime, l.asset.w, l.asset.h, l.asset.width, l.asset.caption]);
      else if (isEngType(l.type)) row.push(Eng.encode(l.type, l.eng)); // Stage 07: same 4th-element rule, fixed-order arrays
      return row;
    }));
  }

  /** Rebuild lines from (text, fmt). Returns null when fmt is malformed or does not fit the text. */
  function linesFromTextFmt(text, fmt, ids) {
    const base = String(text).split("\n");
    const idAt = (i) => (Array.isArray(ids) && ids.length === base.length ? ids[i] : null);
    if (fmt === "" || fmt == null) return base.map((t, i) => newLine(t, "paragraph", false, [], idAt(i)));
    let arr;
    try {
      arr = JSON.parse(fmt);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(arr) || arr.length !== base.length || arr.length > BLOCKS_MAX) return null;
    const out = [];
    let total = 0;
    let images = 0;
    let atoms = 0;
    let decisions = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const row = arr[i];
      if (!Array.isArray(row) || (row.length !== 3 && row.length !== 4)) return null;
      const type = CODE_TYPE[row[0]];
      if (!type || (row[1] !== 0 && row[1] !== 1) || (row[1] === 1 && type !== "check") || !Array.isArray(row[2])) return null;
      if (row[2].length > MARKS_PER_BLOCK_MAX) return null;
      if ((row.length === 4) !== (type === "image" || isEngType(type))) return null;
      let payload = null;
      if (isEngType(type)) {
        payload = Eng.decode(type, row[3], measureLink);
        if (!payload) return null;
        if (isAtomType(type)) {
          if (base[i] !== "" || row[2].length) return null;
          atoms += 1;
          if (atoms > Eng.ATOMS_PER_PAGE_MAX) return null;
          out.push(newLine("", type, false, [], idAt(i), null, payload));
          continue;
        }
        decisions += 1;
        if (decisions > Eng.DECISIONS_PER_PAGE_MAX) return null;
      }
      if (type === "image") {
        const a = row[3];
        if (base[i] !== "" || row[2].length || !Array.isArray(a) || a.length !== 6) return null;
        const asset = checkAsset({ id: a[0], mime: a[1], w: a[2], h: a[3], width: a[4], layout: "inline", caption: a[5] });
        if (!asset) return null;
        images += 1;
        if (images > IMAGES_PER_PAGE_MAX) return null;
        out.push(newLine("", "image", false, [], idAt(i), asset));
        continue;
      }
      const marks = [];
      for (const r of row[2]) {
        if (!Array.isArray(r) || r.length < 3 || MARK_ORDER.indexOf(r[0]) < 0 || !isInt(r[1]) || !isInt(r[2])) return null;
        if (!(r[1] >= 0 && r[1] < r[2] && r[2] <= base[i].length)) return null;
        if (r[0] === "citation") {
          const c = r.length === 5 && r[3] === "c" ? citeFromKey(r[4]) : null;
          if (!c) return null;
          marks.push({ type: "citation", start: r[1], end: r[2], cite: c });
        } else if (r[0] !== "link") {
          if (r.length !== 3) return null;
          marks.push({ type: r[0], start: r[1], end: r[2] });
        } else if (r[3] === "h" && r.length === 5) {
          const href = safeHref(r[4]);
          if (!href) return null;
          marks.push({ type: "link", start: r[1], end: r[2], href });
        } else if (r[3] === "r" && r.length === 6) {
          const ref = checkRef({ kind: r[4], id: r[5] });
          if (!ref) return null;
          marks.push({ type: "link", start: r[1], end: r[2], ref });
        } else return null;
      }
      total += marks.length;
      if (total > MARKS_TOTAL_MAX) return null;
      const canon = canonicalMarks(marks);
      if (!canon) return null;
      out.push(newLine(base[i], type, row[1] === 1, canon, idAt(i), null, payload));
    }
    return out;
  }

  /** Server/draft content (V1 legacy or V2) -> lines. null when unusable. */
  function linesFromContent(content) {
    if (!isObj(content) || !Array.isArray(content.blocks) || !content.blocks.length) return null;
    if (content.version === 1) {
      const b = content.blocks[0];
      if (content.blocks.length !== 1 || !isObj(b) || typeof b.text !== "string") return null;
      const lines = plainLines(b.text); // any length: a valid legacy page is always readable
      if (isRealId(b.id)) lines[0].id = b.id;
      return lines;
    }
    if (content.version !== 2) return null; // no read-side line cap: the server enforces writes
    const out = [];
    for (const b of content.blocks) {
      if (!isObj(b) || typeof b.text !== "string" || b.text.indexOf("\n") >= 0 || BLOCK_TYPES.indexOf(b.type) < 0) return null;
      if (b.type === "image") {
        const asset = checkAsset(b.asset);
        if (!asset || b.text !== "" || (Array.isArray(b.marks) && b.marks.length) || b.checked !== undefined) return null;
        out.push(newLine("", "image", false, [], isRealId(b.id) ? b.id : null, asset));
        continue;
      }
      if (b.asset !== undefined) return null;
      let payload = null;
      if (Eng) for (const k of ENG_TYPES) if (b[k] !== undefined && k !== b.type) return null; // a payload only under its own type
      if (isEngType(b.type)) {
        payload = engPayload(b.type, b[b.type]);
        if (!payload || b.checked !== undefined) return null;
        if (isAtomType(b.type)) {
          if (b.text !== "" || (Array.isArray(b.marks) && b.marks.length)) return null;
          out.push(newLine("", b.type, false, [], isRealId(b.id) ? b.id : null, null, payload));
          continue;
        }
      }
      const marks = [];
      for (const m of Array.isArray(b.marks) ? b.marks : []) {
        if (!isObj(m) || MARK_ORDER.indexOf(m.type) < 0 || !isInt(m.start) || !isInt(m.end)) return null;
        if (!(m.start >= 0 && m.start < m.end && m.end <= b.text.length)) return null;
        if (m.type === "citation") {
          const c = Object.keys(m).sort().join(",") === "cite,end,start,type" ? checkCite(m.cite) : null;
          if (!c) return null;
          marks.push({ type: "citation", start: m.start, end: m.end, cite: c });
        } else if (m.type !== "link") marks.push({ type: m.type, start: m.start, end: m.end });
        else if (m.href != null) {
          const href = safeHref(m.href);
          if (!href) return null;
          marks.push({ type: "link", start: m.start, end: m.end, href });
        } else {
          const ref = checkRef(m.ref);
          if (!ref) return null;
          marks.push({ type: "link", start: m.start, end: m.end, ref });
        }
      }
      const canon = canonicalMarks(marks);
      if (!canon) return null;
      out.push(newLine(b.text, b.type, b.checked === true, canon, isRealId(b.id) ? b.id : null, null, payload));
    }
    return ensureUnique(out);
  }

  /** A repeated id is only meaningful on its first line. */
  function ensureUnique(lines) {
    const seen = new Set();
    for (const l of lines) {
      if (l.id && seen.has(l.id)) l.id = null;
      else if (l.id) seen.add(l.id);
    }
    return lines;
  }

  /**
   * Lines -> V2 content for the wire/drafts. A block id is included only when it is a real server id
   * (never a temporary key) and, when `allowed` (a Set of the page's current block ids) is given,
   * only if it belongs to that set. Blocks without an id are new: the server generates the id.
   */
  function contentFromLines(lines, allowed) {
    const used = new Set();
    return {
      version: 2,
      blocks: lines.map((l) => {
        const b = { type: l.type, text: l.text, marks: l.marks.map((m) => copyMark(m, m.start, m.end)) };
        if (l.type === "check") b.checked = !!l.checked;
        if (l.type === "image") b.asset = Object.assign({}, l.asset);
        if (isEngType(l.type)) b[l.type] = cloneEng(l.eng);
        if (isRealId(l.id) && (!allowed || allowed.has(l.id)) && !used.has(l.id)) {
          used.add(l.id);
          b.id = l.id;
        }
        return b;
      }),
    };
  }

  function contentFromTextFmt(text, fmt, ids, allowed) {
    const lines = linesFromTextFmt(text, fmt, ids);
    return lines ? contentFromLines(lines, allowed) : null;
  }

  /**
   * Content to SEND. A plain page longer than BLOCKS_MAX lines is sent as one legacy V1 text block
   * (`firstId` = the page's existing first block id): the server keeps it compact instead of
   * exploding it into thousands of blocks. Everything else is V2.
   */
  function wireContent(lines, allowed, firstId) {
    if (lines.length > BLOCKS_MAX && isPlain(lines)) {
      const b = { type: "text", text: flat(lines), marks: [] };
      if (isRealId(firstId)) b.id = firstId;
      return { version: 1, blocks: [b] };
    }
    return contentFromLines(lines, allowed);
  }

  // ------------------------------------------------------------------ offsets (flat <-> line)

  function lineStarts(lines) {
    const out = [];
    let pos = 0;
    for (const l of lines) {
      out.push(pos);
      pos += l.text.length + 1;
    }
    return out;
  }

  /** flat offset -> {line, off}. Offsets past the end clamp to the end of the last line. */
  function locate(lines, pos) {
    let rest = Math.max(0, pos);
    for (let i = 0; i < lines.length; i += 1) {
      if (rest <= lines[i].text.length) return { line: i, off: rest };
      rest -= lines[i].text.length + 1;
    }
    const last = lines.length - 1;
    return { line: last, off: lines[last].text.length };
  }

  // ------------------------------------------------------------------ editing primitives

  /** Never split a surrogate pair: move an offset to the nearest boundary (dir < 0 down, else up). */
  function snapOff(text, off, dir) {
    if (off > 0 && off < text.length) {
      const lo = text.charCodeAt(off);
      const hi = text.charCodeAt(off - 1);
      if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return dir < 0 ? off - 1 : off + 1;
    }
    return off;
  }

  /**
   * Replace flat range [s, e) by `rep` (may contain "\n"). Returns {lines, caret} where caret is
   * the flat offset after the inserted text. Marks: the ones before/after are kept (shifted);
   * a mark covering the first replaced character (for a pure insertion: strictly around the
   * point) is inherited by the replacement; marks entirely inside the removed range vanish.
   * Never produces empty, negative or out-of-bounds ranges.
   */
  function replaceRange(lines, s, e, rep) {
    if (!lines.some(isAtom)) return replaceRangeText(lines, s, e, rep);
    return replaceRangeAround(lines, s, e, rep);
  }

  /**
   * replaceRange on a page that holds image atoms. An image has no text and never merges with a text line:
   * - an insertion AT an image goes into a new paragraph ABOVE it (the image keeps its identity);
   * - a range ending exactly at an image's start leaves that image untouched;
   * - an image fully inside the range (or starting it) is removed with the range, like any selected atom.
   */
  function replaceRangeAround(lines, s, e, rep) {
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    const a = locate(lines, lo);
    if (lo === hi) {
      if (!isAtom(lines[a.line])) return replaceRangeText(lines, lo, hi, rep);
      const work = lines.slice(0, a.line).map(cloneLine).concat([newLine("", "paragraph")], lines.slice(a.line).map(cloneLine));
      const at = lineStarts(work)[a.line];
      return replaceRangeText(work, at, at, rep);
    }
    const b = locate(lines, hi);
    const endRetained = b.line > a.line && isAtom(lines[b.line]); // the range stops right before this atom
    const last = endRetained ? b.line - 1 : b.line;
    const mid = [];
    for (let i = a.line; i <= last; i += 1) {
      const l = lines[i];
      if (!isAtom(l)) mid.push(cloneLine(l));
      else if (i === a.line || i === last) mid.push(newLine("", "paragraph")); // an endpoint needs a line to sit in
    }
    const work = lines.slice(0, a.line).map(cloneLine).concat(mid, lines.slice(last + 1).map(cloneLine));
    const starts = lineStarts(work);
    const startOff = isAtom(lines[a.line]) ? 0 : a.off;
    const endLine = a.line + mid.length - 1;
    const endOff = endRetained ? (isAtom(lines[last]) ? 0 : lines[last].text.length) : b.off;
    return replaceRangeText(work, starts[a.line] + startOff, starts[endLine] + endOff, rep);
  }

  function replaceRangeText(lines, s, e, rep) {
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    const a = locate(lines, lo);
    const b = locate(lines, hi);
    a.off = snapOff(lines[a.line].text, a.off, -1);
    b.off = lo === hi ? a.off : snapOff(lines[b.line].text, b.off, 1);
    // A citation is an atom: a range touching its inside covers all of it; an insertion inside goes after it.
    for (const m of lines[a.line].marks) {
      if (m.type === "citation" && m.start < a.off && a.off < m.end) a.off = lo === hi ? m.end : m.start;
    }
    if (lo === hi) b.off = a.off;
    else {
      for (const m of lines[b.line].marks) if (m.type === "citation" && m.start < b.off && b.off < m.end) b.off = m.end;
    }
    const first = lines[a.line];
    const last = lines[b.line];
    const insertion = a.line === b.line && a.off === b.off;
    const pieces = String(rep).split("\n");
    const inherit = [];
    for (const m of first.marks) {
      const covers = insertion ? m.start < a.off && m.end > a.off : m.start <= a.off && m.end > a.off;
      if (covers && m.type !== "citation") inherit.push(m);
    }
    const built = [];
    const pre = first.text.slice(0, a.off);
    const suf = last.text.slice(b.off);
    // Identity: the block keeps its id on the piece that keeps its content. Splitting at the very
    // start of a non-empty line (pre empty, first piece empty) inserts a NEW block above it and the
    // original block (id, checked state) stays with its text.
    const idToLast = pieces.length > 1 && pre === "" && pieces[0] === "" && suf !== "";
    const takeLast = a.line !== b.line && pre === "" && pieces.length === 1 && pieces[0] === "" && suf !== "";
    for (let k = 0; k < pieces.length; k += 1) {
      const piece = pieces[k];
      const text = (k === 0 ? pre : "") + piece + (k === pieces.length - 1 ? suf : "");
      const marks = [];
      const pieceStart = k === 0 ? pre.length : 0;
      const pieceEnd = pieceStart + piece.length;
      if (k === 0) {
        for (const m of first.marks) if (m.start < a.off) marks.push(copyMark(m, m.start, Math.min(m.end, a.off)));
      }
      if (piece.length) for (const m of inherit) marks.push(copyMark(m, pieceStart, pieceEnd));
      if (k === pieces.length - 1) {
        const base = text.length - suf.length;
        for (const m of last.marks) {
          if (m.end > b.off) marks.push(copyMark(m, base + Math.max(m.start, b.off) - b.off, base + m.end - b.off));
        }
      }
      // A middle/last piece of a multi-line replacement is a new line: it takes the type of the
      // first line (callers such as Enter adjust list continuation afterwards).
      // Deleting everything before the survivor's own text (e.g. a selection from the start of one line
      // through the newline of the next) leaves the LAST line's content: it keeps that block's identity.
      const owner = takeLast ? last : first;
      const keeps = idToLast ? k === pieces.length - 1 : k === 0;
      built.push(normalizeLine({ type: owner.type, checked: keeps ? owner.checked : false, text, marks, id: keeps ? owner.id : null, eng: keeps ? owner.eng : null }));
    }
    const out = lines.slice(0, a.line).map(cloneLine).concat(built, lines.slice(b.line + 1).map(cloneLine));
    const starts = lineStarts(out);
    const lastBuilt = a.line + built.length - 1;
    const caret = starts[lastBuilt] + (built.length === 1 ? pre.length + pieces[0].length : pieces[pieces.length - 1].length);
    return { lines: out, caret, idToLast };
  }

  /** Character coverage: does every char of [s, e) in one line carry mark `type`? */
  function coverage(line, s, e, type) {
    if (e <= s) return false;
    let pos = s;
    const ms = line.marks.filter((m) => m.type === type).sort((x, y) => x.start - y.start);
    for (const m of ms) {
      if (m.end <= pos) continue;
      if (m.start > pos) return false;
      pos = m.end;
      if (pos >= e) return true;
    }
    return pos >= e;
  }

  function perLine(lines, s, e) {
    const out = [];
    const starts = lineStarts(lines);
    for (let i = 0; i < lines.length; i += 1) {
      const a = snapOff(lines[i].text, Math.max(s, starts[i]) - starts[i], -1);
      const b = snapOff(lines[i].text, Math.min(e, starts[i] + lines[i].text.length) - starts[i], 1);
      if (b > a) out.push({ i, a, b });
    }
    return out;
  }

  /** Toggle inline mark `type` over [s, e): remove when fully covered, else add. */
  function toggleMark(lines, s, e, type) {
    if (INLINE.indexOf(type) < 0 || e <= s) return lines;
    const parts = perLine(lines, s, e);
    if (!parts.length) return lines;
    const remove = parts.every((p) => coverage(lines[p.i], p.a, p.b, type));
    const out = cloneLines(lines);
    for (const p of parts) {
      const line = out[p.i];
      if (remove) {
        const next = [];
        for (const m of line.marks) {
          if (m.type !== type || m.end <= p.a || m.start >= p.b) next.push(m);
          else {
            if (m.start < p.a) next.push(copyMark(m, m.start, p.a));
            if (m.end > p.b) next.push(copyMark(m, p.b, m.end));
          }
        }
        line.marks = canonicalMarks(next) || line.marks;
      } else {
        line.marks = canonicalMarks(line.marks.concat([{ type, start: p.a, end: p.b }])) || line.marks;
      }
    }
    return out;
  }

  /** Force inline mark `type` on (or off) over [s, e) (unlike toggleMark, never depends on current coverage). */
  function setMark(lines, s, e, type, on) {
    if (INLINE.indexOf(type) < 0 || e <= s) return lines;
    const has = hasMark(lines, s, e, type);
    return has === !!on ? lines : toggleMark(lines, s, e, type);
  }

  function hasMark(lines, s, e, type) {
    const parts = perLine(lines, s, e);
    return parts.length > 0 && parts.every((p) => coverage(lines[p.i], p.a, p.b, type));
  }

  /** Set (or with null clear) the link over [s, e). Any overlapping link is replaced/trimmed. */
  function setLink(lines, s, e, target) {
    if (e <= s) return lines;
    let mark = null;
    if (target) {
      if (typeof target.href === "string") {
        const href = safeHref(target.href);
        if (!href) return null;
        mark = { type: "link", href };
      } else {
        const ref = checkRef(target.ref);
        if (!ref) return null;
        mark = { type: "link", ref };
      }
    }
    const out = cloneLines(lines);
    for (const p of perLine(lines, s, e)) {
      const line = out[p.i];
      if (mark && line.marks.some((m) => m.type === "citation" && m.start < p.b && p.a < m.end)) return null; // a citation is not linkable
      const next = [];
      for (const m of line.marks) {
        if (m.type !== "link" || m.end <= p.a || m.start >= p.b) next.push(m);
        else {
          if (m.start < p.a) next.push(copyMark(m, m.start, p.a));
          if (m.end > p.b) next.push(copyMark(m, p.b, m.end));
        }
      }
      if (mark) next.push(Object.assign({ start: p.a, end: p.b }, mark.href != null ? { type: "link", href: mark.href } : { type: "link", ref: mark.ref }));
      const canon = canonicalMarks(next);
      if (!canon) return null;
      line.marks = canon;
    }
    return out;
  }

  /** Link covering flat position `pos` (caret or selection start), or null. */
  function linkAt(lines, pos) {
    const at = locate(lines, pos);
    const line = lines[at.line];
    for (const m of line.marks) if (m.type === "link" && m.start <= at.off && at.off < m.end) return { mark: m, line: at.line };
    return null;
  }

  /** Citation covering flat position `pos` (caret inside or at its start, or selection start), or null. */
  function citationAt(lines, pos) {
    const at = locate(lines, pos);
    for (const m of lines[at.line].marks) if (m.type === "citation" && m.start <= at.off && at.off < m.end) return { mark: m, line: at.line, start: lineStarts(lines)[at.line] + m.start, end: lineStarts(lines)[at.line] + m.end };
    return null;
  }

  function citationsOf(lines) {
    const out = [];
    lines.forEach((l, i) => l.marks.forEach((m) => {
      if (m.type === "citation") out.push({ line: i, start: m.start, end: m.end, cite: m.cite });
    }));
    return out;
  }

  /**
   * Insert a citation: its label text replaces [s, e) (a range touching a citation covers all of it) and
   * the label carries the citation mark. Any link over the label is removed (no link/citation overlap).
   * Returns {lines, caret, start, end} or null when the payload is invalid.
   */
  function insertCitation(lines, s, e, cite) {
    const c = checkCite(cite);
    if (!c) return null;
    const label = citationLabel(c);
    const res = replaceRange(lines, s, e, label);
    const start = res.caret - label.length;
    const at = locate(res.lines, start);
    const line = res.lines[at.line];
    const kept = [];
    for (const m of line.marks) {
      if (m.type !== "link" || m.end <= at.off || m.start >= at.off + label.length) kept.push(m);
      else {
        if (m.start < at.off) kept.push(copyMark(m, m.start, at.off));
        if (m.end > at.off + label.length) kept.push(copyMark(m, at.off + label.length, m.end));
      }
    }
    kept.push({ type: "citation", start: at.off, end: at.off + label.length, cite: c });
    const canon = canonicalMarks(kept);
    if (!canon) return null;
    line.marks = canon;
    return { lines: res.lines, caret: res.caret, start, end: res.caret };
  }

  /** Same text, new payload (verify / unverify, PDF page): the label is untouched. */
  function setCitationPayload(lines, pos, cite) {
    const c = checkCite(cite);
    const at = citationAt(lines, pos);
    if (!c || !at) return null;
    const out = cloneLines(lines);
    const line = out[at.line];
    const next = line.marks.map((m) => (m === at.mark || (m.type === "citation" && m.start === at.mark.start && m.end === at.mark.end) ? { type: "citation", start: m.start, end: m.end, cite: c } : m));
    const canon = canonicalMarks(next);
    if (!canon) return null;
    line.marks = canon;
    return out;
  }

  /** Set block type of every line touched by [s, e]; same type on all lines toggles back to paragraph. */
  function setBlockType(lines, s, e, type) {
    if (BLOCK_TYPES.indexOf(type) < 0 || type === "image" || isEngType(type)) return lines; // atoms and decisions are made by their own tools
    const a = locate(lines, Math.min(s, e)).line;
    const b = locate(lines, Math.max(s, e)).line;
    let all = true;
    let any = false;
    for (let i = a; i <= b; i += 1) {
      if (isAtom(lines[i])) continue; // an atom is never re-typed
      any = true;
      if (lines[i].type !== type) all = false;
    }
    if (!any) return lines;
    const target = all ? "paragraph" : type;
    const out = cloneLines(lines);
    for (let i = a; i <= b; i += 1) {
      if (isAtom(out[i])) continue;
      out[i].type = target;
      out[i].eng = null; // a decision re-typed to a plain block stops being a decision
      if (target !== "check") out[i].checked = false;
    }
    return out;
  }

  function toggleChecked(lines, index) {
    if (!lines[index] || lines[index].type !== "check") return lines;
    const out = cloneLines(lines);
    out[index].checked = !out[index].checked;
    return out;
  }

  /** Enter: split at [s, e). Lists continue; an Enter on an empty list line exits the list. */
  function splitAt(lines, s, e) {
    const at = locate(lines, Math.min(s, e));
    const cur = lines[at.line];
    const collapsed = s === e;
    if (collapsed && isAtom(cur)) {
      // Enter on an image atom opens ONE empty paragraph above it; the image keeps its place and identity
      const out = cloneLines(lines);
      out.splice(at.line, 0, newLine("", "paragraph"));
      return { lines: out, caret: lineStarts(out)[at.line], idToLast: false };
    }
    if (collapsed && cur.text === "" && (cur.type === "bullet" || cur.type === "number" || cur.type === "check")) {
      const out = cloneLines(lines);
      out[at.line].type = "paragraph";
      out[at.line].checked = false;
      return { lines: out, caret: lineStarts(out)[at.line] };
    }
    const res = replaceRange(lines, s, e, "\n");
    const idx = locate(res.lines, res.caret).line;
    if (res.idToLast) {
      // caret at the start of a non-empty line: the new block is the one ABOVE it
      const above = res.lines[idx - 1];
      above.type = cur.type === "heading" || cur.type === "decision" ? "paragraph" : cur.type;
      above.checked = false;
      return res;
    }
    const next = res.lines[idx];
    if (cur.type === "heading" || cur.type === "decision") next.type = "paragraph"; // a heading / a decision is one line
    else next.type = cur.type;
    next.checked = false;
    return res;
  }

  // ------------------------------------------------------------------ find / replace

  function foldSame(s) {
    let out = "";
    for (const ch of s) {
      const l = ch.toLowerCase();
      out += l.length === ch.length ? l : ch;
    }
    return out;
  }

  function isWordChar(ch) {
    return !!ch && /[\p{L}\p{N}_]/u.test(ch);
  }

  function charBefore(text, i) {
    if (i <= 0) return "";
    const lo = text.charCodeAt(i - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) return text.slice(i - 2, i);
    return text[i - 1];
  }

  function charAt(text, i) {
    if (i >= text.length) return "";
    const cp = text.codePointAt(i);
    return String.fromCodePoint(cp);
  }

  /** Non-overlapping matches, per line, as flat ranges [{start, end}]. No regex: literal query. */
  function findAll(lines, query, opts) {
    const o = opts || {};
    const out = [];
    if (typeof query !== "string" || !query || query.indexOf("\n") >= 0) return out;
    const q = o.caseSensitive ? query : foldSame(query);
    const starts = lineStarts(lines);
    for (let li = 0; li < lines.length; li += 1) {
      const text = lines[li].text;
      const hay = o.caseSensitive ? text : foldSame(text);
      let from = 0;
      while (from <= hay.length - q.length) {
        const at = hay.indexOf(q, from);
        if (at < 0) break;
        const end = at + q.length;
        if (snapOff(text, at, -1) !== at || snapOff(text, end, -1) !== end) {
          from = at + 1;
          continue;
        }
        if (o.wholeWord && (isWordChar(charBefore(text, at)) || isWordChar(charAt(text, end)))) {
          from = at + 1;
          continue;
        }
        if (lines[li].marks.some((m) => m.type === "citation" && at < m.end && m.start < end)) {
          from = at + 1; // a citation label is a reference, not editable text: never matched, never replaced
          continue;
        }
        out.push({ start: starts[li] + at, end: starts[li] + end });
        from = end;
      }
    }
    return out;
  }

  /** Replace matches (non-overlapping, ascending). Empty replacement deletes them. */
  function replaceMatches(lines, matches, replacement) {
    const rep = String(replacement == null ? "" : replacement).replace(/\n/g, " ");
    let cur = lines;
    for (let i = matches.length - 1; i >= 0; i -= 1) cur = replaceRange(cur, matches[i].start, matches[i].end, rep).lines;
    return cur;
  }

  // ------------------------------------------------------------------ export renderers (mirror hq_carnet_rich.py)

  function numberLabels(lines) {
    let n = 0;
    return lines.map((l) => {
      if (l.type === "number") {
        n += 1;
        return n;
      }
      n = 0;
      return 0;
    });
  }

  function renderTxt(lines) {
    const labels = numberLabels(lines);
    const out = lines.map((l, i) => {
      if (l.type === "image") return l.asset.caption ? "[Image : " + l.asset.caption + "]" : "[Image]";
      if (l.type === "calc") return "[" + Eng.describeCalc(l.eng) + "]";
      if (l.type === "measure") return "[" + Eng.describeMeasure(l.eng) + "]";
      let text = l.text;
      const links = l.marks.filter((m) => m.type === "link" && m.href != null).sort((x, y) => x.start - y.start);
      if (links.length) {
        let s = "";
        let pos = 0;
        for (const m of links) {
          s += l.text.slice(pos, m.end) + " (" + m.href + ")";
          pos = m.end;
        }
        text = s + l.text.slice(pos);
      }
      if (l.type === "decision") return Eng.decisionLabel(l.eng) + (text ? " \u2014 " + text : "");
      if (l.type === "bullet") return "- " + text;
      if (l.type === "number") return labels[i] + ". " + text;
      if (l.type === "check") return (l.checked ? "[x] " : "[ ] ") + text;
      return text;
    });
    return out.join("\n") + "\n";
  }

  function mdEscape(t) {
    return t.replace(/([\\`*_\[\]<>&|~])/g, "\\$1");
  }

  function mdLineStart(t) {
    return /^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>|={3,}|-{3,}|\|)/.test(t) ? "\\" + t : t;
  }

  function mdWrap(chunk, active) {
    if (!chunk) return "";
    const lead = chunk.slice(0, chunk.length - chunk.trimStart().length);
    const trail = chunk.slice(chunk.trimEnd().length);
    let core = chunk.trim();
    if (!core) return chunk;
    const kinds = active.map((m) => m.type);
    if (kinds.indexOf("code") >= 0) {
      let fence = "`";
      while (core.indexOf(fence) >= 0) fence += "`";
      const pad = core[0] === "`" || core[core.length - 1] === "`" ? " " : "";
      core = fence + pad + core + pad + fence;
    } else core = mdEscape(core);
    if (kinds.indexOf("bold") >= 0) core = "**" + core + "**";
    if (kinds.indexOf("italic") >= 0) core = "*" + core + "*";
    if (kinds.indexOf("underline") >= 0) core = "<u>" + core + "</u>";
    if (kinds.indexOf("highlight") >= 0) core = "<mark>" + core + "</mark>";
    const link = active.find((m) => m.type === "link" && m.href != null);
    if (link) core = "[" + core + "](" + link.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20") + ")";
    return lead + core + trail;
  }

  function mdInline(l) {
    if (!l.text) return "";
    const cuts = new Set([0, l.text.length]);
    for (const m of l.marks) {
      cuts.add(m.start);
      cuts.add(m.end);
    }
    const edges = Array.from(cuts).sort((x, y) => x - y);
    let out = "";
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const a = edges[i];
      const b = edges[i + 1];
      out += mdWrap(l.text.slice(a, b), l.marks.filter((m) => m.start <= a && m.end >= b));
    }
    return out;
  }

  /** Percent-encode a package-relative path (mirrors hq_carnet_rich._md_path): only [A-Za-z0-9._~/-] stay literal. */
  function mdPath(rel) {
    return rel.replace(/[^A-Za-z0-9._~/-]/gu, (ch) => encodeURIComponent(ch).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()));
  }

  function mdAlt(t) {
    return t.replace(/([\\\[\]])/g, "\\$1");
  }

  /**
   * `assetPaths` (optional {assetId: path relative to the export package}) turns an image into a relative
   * Markdown image; without an entry the image is a text placeholder (no dangling link, no binary).
   */
  function renderMarkdown(lines, assetPaths) {
    const labels = numberLabels(lines);
    const parts = [];
    let gap = false;
    lines.forEach((l, i) => {
      if (l.type === "image") {
        const cap = l.asset.caption;
        const relPath = assetPaths && assetPaths[l.asset.id];
        let text;
        if (relPath) {
          text = "![" + mdAlt(cap) + "](" + mdPath(relPath) + ")";
          if (cap) text += "\n\n*" + mdEscape(cap) + "*";
        } else text = cap ? "*\\[Image : " + mdEscape(cap) + "\\]*" : "*\\[Image\\]*";
        parts.push(["img", text, gap]);
        gap = false;
        return;
      }
      if (l.type === "calc" || l.type === "measure") {
        const inner = l.type === "calc" ? Eng.describeCalc(l.eng) : Eng.describeMeasure(l.eng);
        parts.push([l.type, "*\\[" + mdEscape(inner) + "\\]*", gap]);
        gap = false;
        return;
      }
      if (l.type === "decision") {
        const body = mdInline(l);
        parts.push(["decision", "**" + mdEscape(Eng.decisionLabel(l.eng)) + "**" + (body ? " \u2014 " + body : ""), gap]);
        gap = false;
        return;
      }
      if ((l.type === "paragraph" || l.type === "heading") && !l.text.trim()) {
        gap = true; // a blank line ends any list: numbering restarts, like the TXT export
        return;
      }
      const text = mdInline(l);
      if (l.type === "paragraph") parts.push(["p", mdLineStart(text), gap]);
      else if (l.type === "heading") parts.push(["h", "## " + text, gap]);
      else if (l.type === "bullet") parts.push(["bullet", "- " + text, gap]);
      else if (l.type === "number") parts.push(["number", labels[i] + ". " + text, gap]);
      else parts.push(["bullet", (l.checked ? "- [x] " : "- [ ] ") + text, gap]);
      gap = false;
    });
    let out = "";
    let prev = null;
    for (const [kind, text, afterGap] of parts) {
      if (prev !== null) out += kind === prev && (kind === "bullet" || kind === "number") && !afterGap ? "\n" : "\n\n";
      out += text;
      prev = kind;
    }
    return out + "\n";
  }

  /** Safe filename stem/extension (mirrors hq_carnet_rich.export_filename; the server re-sanitises). */
  function exportFilename(name, title, fmt) {
    const ext = fmt === "md" ? ".md" : ".txt";
    let stem = typeof name === "string" && name.trim() ? name : title;
    const low = stem.toLowerCase();
    for (const known of [".txt", ".md"]) {
      if (low.endsWith(known)) {
        stem = stem.slice(0, -known.length);
        break;
      }
    }
    let s = String(stem || title || "").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-");
    s = s.split(/\s+/).filter(Boolean).join(" ").replace(/^[ .-]+|[ .-]+$/g, "").replace(/-{2,}/g, "-");
    if (s.length > 80) s = s.slice(0, 80).replace(/[ .-]+$/g, "");
    if (!s) s = "note";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s.split(".")[0])) s = "_" + s;
    return s + ext;
  }

  // ------------------------------------------------------------------ editor DOM bridge

  const NS_SKIP = "data-carnet-skip";
  const BLOCK_TAGS = { DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1 };

  function el(doc, tag, attrs) {
    const n = doc.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    return n;
  }

  function markAttrs(active) {
    return active.filter((m) => m.type !== "link").map((m) => m.type).join(" ");
  }

  const CITE_KEY_ATTR = "data-cite-key";
  const REGISTRIES = new WeakMap(); // editor root -> Map(cite key -> payload). No user text goes into attributes.
  const ASSET_KEY_ATTR = "data-asset-key";
  const ASSET_REGS = new WeakMap(); // editor root -> Map(asset key -> image metadata). Attributes only carry the opaque asset id.
  const ENG_KEY_ATTR = "data-eng-key";
  const ENG_REGS = new WeakMap(); // editor root -> Map(eng key -> {type, payload}). Payloads never travel in attributes or text.

  function segNodes(doc, l, from, to) {
    const out = [];
    const cuts = new Set([from, to]);
    for (const m of l.marks) {
      if (m.type === "citation") continue;
      if (m.start > from && m.start < to) cuts.add(m.start);
      if (m.end > from && m.end < to) cuts.add(m.end);
    }
    const edges = Array.from(cuts).sort((x, y) => x - y);
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const a = edges[i];
      const b = edges[i + 1];
      const active = l.marks.filter((m) => m.type !== "citation" && m.start <= a && m.end >= b);
      const text = doc.createTextNode(l.text.slice(a, b));
      const link = active.find((m) => m.type === "link");
      const tokens = markAttrs(active);
      let node = text;
      if (tokens) {
        const span = el(doc, "span", { "data-m": tokens });
        span.appendChild(node);
        node = span;
      }
      if (link) {
        const a2 = el(doc, "a", { "data-carnet-link": link.href != null ? "external" : link.ref.kind });
        if (link.href != null) {
          a2.setAttribute("href", link.href);
          a2.setAttribute("rel", "noopener noreferrer");
          a2.setAttribute("target", "_blank");
          a2.setAttribute("data-href", link.href);
        } else {
          a2.setAttribute("data-ref-kind", link.ref.kind);
          a2.setAttribute("data-ref-id", link.ref.id);
        }
        a2.appendChild(node);
        node = a2;
      }
      out.push(node);
    }
    return out;
  }

  /** An image atom: <div.carnet-line contenteditable=false><figure><img><figcaption></figure></div>. Safe DOM only. */
  function renderImage(doc, l, idx, reg) {
    const a = l.asset;
    const div = el(doc, "div", { class: "carnet-line carnet-image-line", "data-carnet-line": String(idx), "data-line-type": "image", "data-carnet-asset": a.id, contenteditable: "false" });
    if (isRealId(l.id)) div.setAttribute("data-carnet-block-id", l.id);
    else if (isTmpId(l.id)) div.setAttribute("data-carnet-tmp", l.id);
    if (reg) {
      reg.an += 1;
      const key = "a" + reg.an;
      reg.assets.set(key, Object.assign({}, a));
      div.setAttribute(ASSET_KEY_ATTR, key);
    }
    const fig = el(doc, "figure", { class: "carnet-figure", tabindex: "0", "data-carnet-image": "", "aria-label": "Image" + (a.caption ? " : " + a.caption : "") });
    fig.style.width = a.width + "%";
    const img = el(doc, "img", { class: "carnet-img", src: ASSET_URL + a.id, alt: a.caption || "", width: String(a.w), height: String(a.h), draggable: "false", decoding: "async" });
    fig.appendChild(img);
    if (a.caption) {
      const cap = el(doc, "figcaption", { class: "carnet-caption" });
      cap.appendChild(doc.createTextNode(a.caption));
      fig.appendChild(cap);
    }
    div.appendChild(fig);
    return div;
  }

  function textEl(doc, tag, cls, value) {
    const n = el(doc, tag, cls ? { class: cls } : null);
    n.appendChild(doc.createTextNode(value));
    return n;
  }

  function engKey(reg, l, div) {
    if (!reg || !reg.engs) return;
    reg.en += 1;
    const key = "e" + reg.en;
    reg.engs.set(key, { type: l.type, payload: cloneEng(l.eng) });
    div.setAttribute(ENG_KEY_ATTR, key);
  }

  const STATUS_LABEL = { in: "Dans la tol\u00e9rance", out: "Hors tol\u00e9rance", incompatible: "Unit\u00e9s incompatibles \u2014 non compar\u00e9", none: "" };

  /** A calculation / measurement atom: <div.carnet-line contenteditable=false> with a readable summary. Safe DOM only. */
  function renderEngAtom(doc, l, idx, reg) {
    const p = l.eng;
    const div = el(doc, "div", {
      class: "carnet-line carnet-eng-line", "data-carnet-line": String(idx), "data-line-type": l.type, "data-carnet-eng": l.type, contenteditable: "false",
      tabindex: "0", role: "group", "aria-label": l.type === "calc" ? "Calcul" : "Mesure",
    });
    if (isRealId(l.id)) div.setAttribute("data-carnet-block-id", l.id);
    else if (isTmpId(l.id)) div.setAttribute("data-carnet-tmp", l.id);
    engKey(reg, l, div);
    const box = el(doc, "div", { class: "carnet-eng-card" });
    if (l.type === "calc") {
      box.appendChild(textEl(doc, "div", "carnet-eng-head", "Calcul \u00b7 " + localTimeLabel(p.at)));
      const body = el(doc, "div", { class: "carnet-eng-body" });
      body.appendChild(textEl(doc, "span", "carnet-eng-expr", p.expr));
      body.appendChild(textEl(doc, "span", "carnet-eng-eq", " = "));
      body.appendChild(textEl(doc, "strong", "carnet-eng-result", p.result + (p.unit ? " " + p.unit : "")));
      box.appendChild(body);
    } else {
      const v = Eng.evaluate(p);
      box.appendChild(textEl(doc, "div", "carnet-eng-head", "Mesure \u00b7 " + p.label + " \u00b7 " + localTimeLabel(p.at)));
      box.appendChild(textEl(doc, "div", "carnet-eng-body", p.observed.v + (p.observed.u ? " " + p.observed.u : "")));
      const bits = [];
      if (p.nominal) bits.push("nominal " + p.nominal.v + (p.nominal.u ? " " + p.nominal.u : ""));
      if (p.mode === "sym") bits.push("\u00b1" + p.tol.t + (p.tol.u ? " " + p.tol.u : ""));
      else if (p.mode === "pct") bits.push("\u00b1" + p.tol.p + " %");
      else if (p.mode === "bounds") bits.push("limites " + p.tol.lo + " \u2026 " + p.tol.hi + (p.tol.u ? " " + p.tol.u : ""));
      if (v.deviation !== null) bits.push("\u00e9cart " + (v.deviation !== "0" && v.deviation.charAt(0) !== "-" ? "+" : "") + v.deviation + (p.observed.u ? " " + p.observed.u : ""));
      if (bits.length) box.appendChild(textEl(doc, "div", "carnet-eng-meta", bits.join(" \u00b7 ")));
      if (STATUS_LABEL[v.status]) {
        const badge = textEl(doc, "span", "carnet-eng-status", STATUS_LABEL[v.status]);
        badge.setAttribute("data-status", v.status);
        box.appendChild(badge);
      }
      box.appendChild(textEl(doc, "div", "carnet-eng-note", "Aide de carnet \u2014 non certifi\u00e9 (pas de la m\u00e9trologie)"));
    }
    div.appendChild(box);
    return div;
  }

  function renderLine(doc, l, idx, num, reg) {
    if (l.type === "image") return renderImage(doc, l, idx, reg);
    if (isAtomType(l.type)) return renderEngAtom(doc, l, idx, reg);
    const div = el(doc, "div", { class: "carnet-line", "data-carnet-line": String(idx), "data-line-type": l.type });
    if (l.type === "decision") {
      engKey(reg, l, div);
      div.appendChild(el(doc, "span", { class: "carnet-decision-label", contenteditable: "false", [NS_SKIP]: "" })).appendChild(doc.createTextNode("D\u00c9CISION \u00b7 " + localTimeLabel(l.eng.at)));
    }
    if (l.type === "number") div.setAttribute("data-num", String(num));
    if (isRealId(l.id)) div.setAttribute("data-carnet-block-id", l.id);
    else if (isTmpId(l.id)) div.setAttribute("data-carnet-tmp", l.id);
    if (l.type === "check") {
      div.setAttribute("data-checked", l.checked ? "true" : "false");
      const box = el(doc, "span", {
        class: "carnet-check", contenteditable: "false", role: "checkbox", tabindex: "-1", "aria-checked": l.checked ? "true" : "false",
        "aria-label": "Case à cocher", "data-carnet-check": "", [NS_SKIP]: "",
      });
      div.appendChild(box);
    }
    if (!l.text) {
      div.appendChild(el(doc, "br"));
      return div;
    }
    const cites = reg ? l.marks.filter((m) => m.type === "citation").sort((x, y) => x.start - y.start) : [];
    let pos = 0;
    for (const c of cites) {
      if (c.start > pos) for (const n of segNodes(doc, l, pos, c.start)) div.appendChild(n);
      reg.n += 1;
      const key = "c" + reg.n;
      reg.map.set(key, cloneCite(c.cite));
      const wrap = el(doc, "span", {
        class: "carnet-citation", "data-carnet-citation": c.cite.src, [CITE_KEY_ATTR]: key, contenteditable: "false", role: "button", tabindex: "0",
        "aria-label": "Référence : " + l.text.slice(c.start, c.end),
      });
      if (c.cite.ok) wrap.setAttribute("data-cite-ok", "true");
      if (!c.cite.loc.text && c.cite.pdf === null) wrap.setAttribute("data-cite-todo", "true");
      for (const n of segNodes(doc, l, c.start, c.end)) wrap.appendChild(n);
      div.appendChild(wrap);
      pos = c.end;
    }
    if (pos < l.text.length) for (const n of segNodes(doc, l, pos, l.text.length)) div.appendChild(n);
    return div;
  }

  function renumber(rootEl) {
    let n = 0;
    for (const div of rootEl.children) {
      if (div.getAttribute("data-line-type") === "number") {
        n += 1;
        div.setAttribute("data-num", String(n));
      } else n = 0;
    }
  }

  /** Replace the editor content with `lines` (safe DOM only). */
  function renderInto(rootEl, lines) {
    const doc = rootEl.ownerDocument;
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    const labels = numberLabels(lines);
    ensureKeys(lines);
    const reg = { map: new Map(), n: 0, assets: new Map(), an: 0, engs: new Map(), en: 0 };
    REGISTRIES.set(rootEl, reg.map);
    ASSET_REGS.set(rootEl, reg.assets);
    ENG_REGS.set(rootEl, reg.engs);
    lines.forEach((l, i) => rootEl.appendChild(renderLine(doc, l, i, labels[i], reg)));
  }

  /**
   * In-place update of ONE image atom (width, caption, alt, even the asset): the <img> element is reused so a
   * caption keystroke never re-requests the picture. The registry entry is replaced; returns false when that
   * DOM line is not an image (or the metadata is invalid): the caller then falls back to a full render.
   */
  function patchImage(rootEl, index, asset) {
    const lineEl = rootEl.children[index];
    const clean = checkAsset(asset);
    const areg = ASSET_REGS.get(rootEl);
    if (!lineEl || !clean || !areg || lineEl.getAttribute("data-line-type") !== "image") return false;
    const key = lineEl.getAttribute(ASSET_KEY_ATTR);
    const fig = lineEl.querySelector("figure");
    const img = fig ? fig.querySelector("img") : null;
    if (!areg.has(key) || !fig || !img) return false;
    areg.set(key, Object.assign({}, clean));
    lineEl.setAttribute("data-carnet-asset", clean.id);
    fig.style.width = clean.width + "%";
    fig.setAttribute("aria-label", "Image" + (clean.caption ? " : " + clean.caption : ""));
    if (img.getAttribute("src") !== ASSET_URL + clean.id) {
      img.setAttribute("src", ASSET_URL + clean.id);
      img.setAttribute("width", String(clean.w));
      img.setAttribute("height", String(clean.h));
    }
    img.setAttribute("alt", clean.caption || "");
    let cap = fig.querySelector("figcaption");
    if (clean.caption) {
      if (!cap) {
        cap = lineEl.ownerDocument.createElement("figcaption");
        cap.setAttribute("class", "carnet-caption");
        fig.appendChild(cap);
      }
      cap.textContent = clean.caption;
    } else if (cap) cap.remove();
    return true;
  }

  /**
   * After a save / keep-local / late response: replace obsolete ids in the live DOM with the
   * server-adopted ones ({old id or tmp-N: block-…}). Attributes only: no re-render, the caret and
   * selection are untouched.
   */
  function adoptIds(rootEl, map) {
    for (const div of rootEl.children) {
      const cur = div.getAttribute("data-carnet-block-id") || div.getAttribute("data-carnet-tmp");
      if (cur && map[cur] && isRealId(map[cur])) {
        div.setAttribute("data-carnet-block-id", map[cur]);
        div.removeAttribute("data-carnet-tmp");
      }
    }
  }

  /**
   * Align the live DOM's block identities with `ids` (the authoritative local ids) when the DOM shows
   * exactly the same lines. Returns true when something changed. Attributes only.
   */
  function syncIds(rootEl, lines, ids) {
    const kids = rootEl.children;
    if (!Array.isArray(ids) || ids.length !== kids.length || lines.length !== kids.length) return false;
    let changed = false;
    for (let i = 0; i < kids.length; i += 1) {
      const want = ids[i];
      if (!want || lines[i].id === want) continue;
      if (isRealId(want)) {
        kids[i].setAttribute("data-carnet-block-id", want);
        kids[i].removeAttribute("data-carnet-tmp");
      } else if (isTmpId(want)) {
        kids[i].setAttribute("data-carnet-tmp", want);
        kids[i].removeAttribute("data-carnet-block-id");
      } else continue;
      changed = true;
    }
    return changed;
  }

  function elementMarks(node, cur) {
    const next = cur.slice();
    const tag = node.nodeName;
    const add = (t) => {
      if (next.every((m) => m.type !== t)) next.push({ type: t });
    };
    if (tag === "B" || tag === "STRONG") add("bold");
    else if (tag === "I" || tag === "EM") add("italic");
    else if (tag === "U") add("underline");
    else if (tag === "MARK") add("highlight");
    else if (tag === "CODE" || tag === "TT") add("code");
    const dm = node.getAttribute ? node.getAttribute("data-m") : null;
    if (dm) for (const t of dm.split(" ")) if (INLINE.indexOf(t) >= 0) add(t);
    if (tag === "A" && node.getAttribute("data-carnet-link")) {
      const kind = node.getAttribute("data-carnet-link");
      if (kind === "external") {
        const href = safeHref(node.getAttribute("data-href"));
        if (href) next.push({ type: "link", href });
      } else {
        const ref = checkRef({ kind: node.getAttribute("data-ref-kind"), id: node.getAttribute("data-ref-id") });
        if (ref) next.push({ type: "link", ref });
      }
    }
    return next;
  }

  /**
   * Strict read-back of the editor DOM into lines. Only whitelisted structure is honoured; any
   * other element contributes its text only. `map` (optional Map) receives Text -> {line, off}.
   */
  function parseEditor(rootEl, map) {
    const reg = REGISTRIES.get(rootEl) || null;
    const areg = ASSET_REGS.get(rootEl) || null;
    const ereg = ENG_REGS.get(rootEl) || null;
    const engUsed = new Set(); // a payload key is honoured once: a line the browser cloned natively never duplicates a payload
    const lines = [];
    let cur = null;
    const open = (type, checked, el) => {
      const real = el ? el.getAttribute("data-carnet-block-id") : null;
      const tmp = el ? el.getAttribute("data-carnet-tmp") : null;
      cur = { type: BLOCK_TYPES.indexOf(type) >= 0 ? type : "paragraph", checked: type === "check" && checked, text: "", marks: [], id: isRealId(real) ? real : isTmpId(tmp) ? tmp : null, el, asset: null, eng: null };
      lines.push(cur);
    };
    const close = () => {
      cur = null;
    };
    function addText(node, active) {
      const t = node.nodeValue || "";
      if (!t) return;
      if (!cur) open("paragraph", false);
      const start = cur.text.length;
      // A newline never lives inside a line: fold it to a space (a real break is a new block).
      const clean = t.replace(/[\r\n]+/g, " ");
      cur.text += clean;
      if (map) map.set(node, { line: lines.length - 1, off: start });
      for (const m of active) {
        if (clean.length) cur.marks.push(Object.assign({}, m, { start, end: start + clean.length }));
      }
    }
    function walk(node, active, topLevel) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          addText(child, active);
        } else if (child.nodeType === 1) {
          if (child.hasAttribute("data-carnet-citation") && !child.hasAttribute(NS_SKIP)) {
            const payload = reg ? reg.get(child.getAttribute(CITE_KEY_ATTR)) : null;
            if (!cur) open("paragraph", false);
            const at = cur.text.length;
            walk(child, active, false); // the label text (and its inner formatting) is ordinary content
            if (payload && cur.text.length > at) cur.marks.push({ type: "citation", start: at, end: cur.text.length, cite: payload });
            continue;
          }
          if (child.parentNode === rootEl && child.getAttribute("data-line-type") === "image" && BLOCK_TAGS[child.nodeName]) {
            // image atom: metadata comes from the registry built by renderInto, never from attributes/text;
            // a line whose metadata is unknown (foreign/duplicated markup) is not an image and is dropped
            close();
            const meta = areg ? areg.get(child.getAttribute(ASSET_KEY_ATTR)) : null;
            if (meta) {
              open("image", false, child);
              cur.asset = Object.assign({}, meta);
              close();
            }
            continue;
          }
          if (child.parentNode === rootEl && child.hasAttribute("data-carnet-eng") && BLOCK_TAGS[child.nodeName]) {
            // calculation / measurement atom: the payload comes from the registry built by renderInto, never from attributes/text
            close();
            const key = child.getAttribute(ENG_KEY_ATTR);
            const meta = ereg && !engUsed.has(key) ? ereg.get(key) : null;
            if (meta && isAtomType(meta.type)) {
              engUsed.add(key);
              open(meta.type, false, child);
              cur.eng = cloneEng(meta.payload);
              close();
            }
            continue;
          }
          if (child.hasAttribute(NS_SKIP) || child.getAttribute("contenteditable") === "false") continue;
          const tag = child.nodeName;
          if (tag === "BR") continue;
          if (BLOCK_TAGS[tag]) {
            close();
            const type = child.getAttribute("data-line-type") || "paragraph";
            open(type, child.getAttribute("data-checked") === "true", child);
            if (type === "decision") {
              const key = child.getAttribute(ENG_KEY_ATTR);
              const meta = ereg && !engUsed.has(key) ? ereg.get(key) : null;
              if (meta && meta.type === "decision") {
                engUsed.add(key);
                cur.eng = cloneEng(meta.payload);
              }
            }
            walk(child, active, false);
            close();
          } else {
            walk(child, elementMarks(child, active), false);
          }
        }
      }
    }
    walk(rootEl, [], true);
    if (!lines.length) lines.push({ type: "paragraph", checked: false, text: "", marks: [], id: null, el: null, eng: null });
    // Identity of DOM lines: keep server ids / temporary keys; a line the browser created natively
    // (or a duplicated id) gets a fresh temporary key, written back so it stays stable.
    const seen = new Set();
    const out = lines.map((l) => {
      const n = normalizeLine(l);
      if (!n.id || seen.has(n.id)) {
        n.id = tmpKey();
        if (l.el) {
          l.el.removeAttribute("data-carnet-block-id");
          l.el.setAttribute("data-carnet-tmp", n.id);
        }
      }
      seen.add(n.id);
      return n;
    });
    return out;
  }

  /** DOM point -> flat offset, using the Text map produced by parseEditor over the same DOM. */
  function pointToOffset(rootEl, node, off, lines, map) {
    const starts = lineStarts(lines);
    if (node && node.nodeType === 3 && map.has(node)) {
      const p = map.get(node);
      return starts[p.line] + Math.min(off, node.nodeValue.length) + p.off;
    }
    // Element container: locate the line element, then sum the text that lies before the point.
    let lineEl = node;
    while (lineEl && lineEl.parentNode !== rootEl) lineEl = lineEl.parentNode;
    if (node === rootEl) {
      const idx = Math.max(0, Math.min(off, rootEl.children.length));
      if (idx >= rootEl.children.length) return starts[starts.length - 1] + lines[lines.length - 1].text.length;
      return starts[Math.min(idx, starts.length - 1)];
    }
    if (!lineEl) return 0;
    const idx = Array.prototype.indexOf.call(rootEl.children, lineEl);
    const doc = rootEl.ownerDocument;
    const r = doc.createRange();
    r.selectNodeContents(lineEl);
    try {
      r.setEnd(node, off);
    } catch (_) {
      return starts[Math.min(idx, starts.length - 1)];
    }
    let count = 0;
    for (const [t, p] of map) {
      if (p.line !== idx || !lineEl.contains(t)) continue;
      let inside = false;
      try {
        inside = r.comparePoint(t, t.nodeValue.length) <= 0 && r.comparePoint(t, 0) >= 0;
      } catch (_) {
        inside = false;
      }
      if (inside) count += t.nodeValue.length;
    }
    return starts[Math.min(idx, starts.length - 1)] + count;
  }

  function offsetToPoint(rootEl, lines, pos, map) {
    const at = locate(lines, pos);
    const lineEl = rootEl.children[at.line];
    if (!lineEl) return { node: rootEl, off: rootEl.childNodes.length };
    if (isAtom(lines[at.line])) return { node: rootEl, off: at.line }; // never a caret INSIDE an atom
    let best = null;
    for (const [t, p] of map || []) {
      if (p.line !== at.line || !lineEl.contains(t)) continue;
      const len = t.nodeValue.length;
      if (at.off >= p.off && at.off <= p.off + len) {
        best = { node: t, off: at.off - p.off };
        break;
      }
    }
    if (best) {
      // A caret never lives INSIDE a citation atom (typing there is swallowed): put it just before/after the wrapper.
      let w = best.node;
      while (w && w !== lineEl && !(w.nodeType === 1 && w.hasAttribute("data-carnet-citation"))) w = w.parentNode;
      if (w && w !== lineEl && w.parentNode) {
        let end = -1;
        for (const [t, p] of map || []) if (p.line === at.line && w.contains(t)) end = Math.max(end, p.off + t.nodeValue.length);
        const idx = Array.prototype.indexOf.call(w.parentNode.childNodes, w);
        return { node: w.parentNode, off: at.off >= end ? idx + 1 : idx };
      }
      return best;
    }
    return { node: lineEl, off: 0 };
  }

  return {
    BLOCK_TYPES, INLINE, MARK_ORDER, REF_KINDS, BLOCKS_MAX, MARKS_PER_BLOCK_MAX, MARKS_TOTAL_MAX,
    LOCATOR_KINDS, LOCATOR_TEXT_MAX, CITE_PAGE_MAX,
    checkCite, citeKey, citationLabel, locatorLabel, citationAt, citationsOf, insertCitation, setCitationPayload,
    safeHref, checkRef, canonicalMarks, newLine, cloneLines, ensureKeys, idsOf, isRealId, isTmpId, wireContent, adoptIds, syncIds, flat, plainLines, isPlain, fmtOf,
    linesFromTextFmt, linesFromContent, contentFromLines, contentFromTextFmt, lineStarts, locate,
    Eng, ENG_TYPES, isAtom, isEngType, engPayload, engLine, decisionLine, engOf, localTimeLabel, measureLink,
    checkAsset, captionOk, cleanCaptionText, imageLine, assetsOf, patchImage, ASSET_URL, ASSET_LONG_SIDE_MAX, ASSET_WIDTH_MIN, ASSET_WIDTH_MAX, ASSET_CAPTION_MAX, IMAGES_PER_PAGE_MAX, ASSET_MIMES,
    replaceRange, toggleMark, setMark, hasMark, setLink, linkAt, setBlockType, toggleChecked, splitAt, findAll, replaceMatches,
    renderTxt, renderMarkdown, exportFilename, renderInto, renumber, parseEditor, pointToOffset, offsetToPoint,
  };
});
