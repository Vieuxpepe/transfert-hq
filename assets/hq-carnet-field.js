/* Transfert HQ — Carnet Field Capture core (product phase 4). PURE and DOM-free (Node-testable).
 *
 * Owns the decisions of the field surfaces, never their pixels:
 *   - the Field HUD action list and its enabled state (a launcher only: it persists nothing),
 *   - the scanner: crop geometry (corner order / validity / output size), the perspective solve + bilinear warp over RGBA
 *     buffers, quarter-turn rotation, the three image treatments, the page/state machine and the page -> block plan,
 *   - OCR: text cleaning, chunking into paragraph lines and the ONE logical insertion plan (all chunks or nothing, each chunk
 *     carrying provenance),
 *   - the voice recorder and transcript state machines, MediaRecorder format choice, elapsed-time text,
 *   - the bounded recovery stash policy (byte / item / TTL), plus an in-memory stash store for tests.
 *
 * The scan and the audio are CANONICAL; OCR text and transcripts are derived text that always point back at their source by
 * canonical identity ({kind, source_kind, source_id}) - never a path, URL or filename. Nothing here touches the network,
 * storage, the camera or the microphone: the DOM layer (hq-carnet-field-ui.js) does, and only after a direct user action.
 *
 * Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetField = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ limits (the server is authoritative; these mirror it)
  const LIMITS = {
    scanLongSide: 2560,
    scanPagesMax: 20,
    imageFileMax: 12 * 1024 * 1024,
    voiceMsMax: 10 * 60 * 1000,
    voiceFileMax: 16 * 1024 * 1024,
    voiceStoreFiles: 256,
    voiceStoreBytes: 250 * 1024 * 1024,
    ocrPagesMax: 10,
    transcriptCharsMax: 20000,
    ocrBlockChars: 1200, // one inserted paragraph never exceeds this (readable, bounded)
    ocrBlocksMax: 400, // one run never inserts more than this many chunks
    voiceBitrate: 32000, // requested bits/s: 10 min ~ 2.4 MB, far under the 16 MiB asset limit
    voiceSafeBytes: 15 * 1024 * 1024, // the recorder stops itself before the server limit
  };

  const STASH_LIMITS = { bytes: 64 * 1024 * 1024, items: 40, ttlMs: 24 * 60 * 60 * 1000 };

  // ------------------------------------------------------------------ Field HUD
  /**
   * The HUD is a LAUNCHER: five actions, each ending in an existing insert path (host `command(id)`). No state of its own.
   * `needs` names what the action requires: "editor" = an editable page.
   */
  const HUD_ACTIONS = [
    { id: "camera", label: "Photo", hint: "Prendre une photo", command: "camera", needs: "editor", icon: "M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" },
    { id: "scanner", label: "Scanner", hint: "Numériser un document", command: "scan", needs: "editor", icon: "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9h8M8 12h8M8 15h5" },
    { id: "voice", label: "Voix", hint: "Enregistrer une note vocale", command: "voice", needs: "editor", icon: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" },
    { id: "measure", label: "Mesure", hint: "Relever une mesure", command: "measure", needs: "editor", icon: "M3 15L15 3l6 6L9 21zM7 11l2 2M10 8l2 2M13 5l2 2" },
    { id: "sketch", label: "Croquis", hint: "Nouveau croquis", command: "sketch", needs: "editor", icon: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM4 20h7M13.5 7l3.5 3.5" },
  ];

  /** The HUD view-model: always the same five actions in the same order; `enabled` only says whether the page can take them now. */
  function hudState(o) {
    const editable = !!(o && o.editable);
    const busy = !!(o && o.busy);
    return HUD_ACTIONS.map((a) => ({
      id: a.id, label: a.label, hint: a.hint, command: a.command, icon: a.icon,
      enabled: editable && !busy,
      reason: !editable ? "Ouvrez une page modifiable" : busy ? "Une capture est déjà en cours" : "",
    }));
  }

  // ------------------------------------------------------------------ scanner geometry
  /** Corners are [{x,y} x4] in image pixels, clockwise from top-left once ordered. */
  function orderCorners(pts) {
    if (!Array.isArray(pts) || pts.length !== 4) return null;
    for (const p of pts) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const c = { x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4, y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 };
    const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
    // sorted by angle from -pi: starts at the left/top side; rotate so the first is the top-left (min x+y)
    let tl = 0;
    for (let i = 1; i < 4; i += 1) if (sorted[i].x + sorted[i].y < sorted[tl].x + sorted[tl].y) tl = i;
    const out = [];
    for (let i = 0; i < 4; i += 1) out.push({ x: sorted[(tl + i) % 4].x, y: sorted[(tl + i) % 4].y });
    return out; // atan2 ascending in screen coordinates (y down) is clockwise
  }

  /** Default crop: the whole image, inset by `inset` of each side (manual workflow: the user drags the corners from here). */
  function defaultCorners(w, h, inset) {
    const k = typeof inset === "number" ? inset : 0.06;
    const dx = Math.round(w * k);
    const dy = Math.round(h * k);
    return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
  }

  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function polyArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /**
   * Validity of an ORDERED quad inside a w x h image: every corner inside the image, strictly convex, no side shorter than
   * `minSide`, area at least `minArea` of the image. Returns "" when valid, else a short machine reason.
   */
  function quadProblem(q, w, h, o) {
    const minSide = (o && o.minSide) || 24;
    const minArea = (o && o.minArea) || 0.02;
    if (!Array.isArray(q) || q.length !== 4) return "shape";
    for (const p of q) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return "shape";
      if (p.x < -0.5 || p.y < -0.5 || p.x > w + 0.5 || p.y > h + 0.5) return "outside";
    }
    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
      const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (c === 0) return "degenerate";
      const s = c > 0 ? 1 : -1;
      if (sign && s !== sign) return "concave";
      sign = s;
    }
    for (let i = 0; i < 4; i += 1) if (dist(q[i], q[(i + 1) % 4]) < minSide) return "small";
    if (polyArea(q) < minArea * w * h) return "area";
    return "";
  }

  /** Output size of the rectified page: averaged opposite sides, then scaled DOWN to `longSide` (never up). */
  function outputSize(q, longSide) {
    const top = dist(q[0], q[1]);
    const bottom = dist(q[3], q[2]);
    const left = dist(q[0], q[3]);
    const right = dist(q[1], q[2]);
    let w = (top + bottom) / 2;
    let h = (left + right) / 2;
    const cap = longSide || LIMITS.scanLongSide;
    const k = Math.min(1, cap / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    return { w, h };
  }

  /** Solve the 8 homography coefficients mapping the DESTINATION rectangle (0..dw, 0..dh) back onto the source quad. */
  function homography(q, dw, dh) {
    const dst = [[0, 0], [dw, 0], [dw, dh], [0, dh]];
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = dst[i];
      const u = q[i].x;
      const v = q[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
      b.push(v);
    }
    // Gaussian elimination with partial pivoting
    const n = 8;
    for (let i = 0; i < n; i += 1) {
      let p = i;
      for (let r = i + 1; r < n; r += 1) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r += 1) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c += 1) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let s = b[i];
      for (let c = i + 1; c < n; c += 1) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /**
   * Perspective-correct `src` (RGBA, sw x sh) into a dw x dh RGBA buffer (bilinear). Pure: returns a new Uint8ClampedArray.
   * `maskOutside` pixels sampled outside the source become opaque white.
   */
  function warpPerspective(src, sw, sh, q, dw, dh) {
    const H = homography(q, dw, dh);
    if (!H) return null;
    const out = new Uint8ClampedArray(dw * dh * 4);
    const [a, b, c, d, e, f, g, h] = H;
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const den = g * px + h * py + 1;
        const sx = (a * px + b * py + c) / den - 0.5;
        const sy = (d * px + e * py + f) / den - 0.5;
        const o = (y * dw + x) * 4;
        if (!(sx > -1 && sy > -1 && sx < sw && sy < sh)) {
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
          continue;
        }
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const xa = Math.max(0, x0);
        const ya = Math.max(0, y0);
        for (let k = 0; k < 3; k += 1) {
          const v00 = src[(ya * sw + xa) * 4 + k];
          const v10 = src[(ya * sw + x1) * 4 + k];
          const v01 = src[(y1 * sw + xa) * 4 + k];
          const v11 = src[(y1 * sw + x1) * 4 + k];
          out[o + k] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  /** Rotate an RGBA buffer by a multiple of 90 degrees clockwise. Returns {data, w, h}. */
  function rotateRGBA(src, w, h, quarterTurns) {
    const t = ((quarterTurns % 4) + 4) % 4;
    if (t === 0) return { data: src.slice(), w, h };
    const nw = t === 2 ? w : h;
    const nh = t === 2 ? h : w;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let nx;
        let ny;
        if (t === 1) {
          nx = h - 1 - y;
          ny = x;
        } else if (t === 2) {
          nx = w - 1 - x;
          ny = h - 1 - y;
        } else {
          nx = y;
          ny = w - 1 - x;
        }
        const s = (y * w + x) * 4;
        const o = (ny * nw + nx) * 4;
        out[o] = src[s];
        out[o + 1] = src[s + 1];
        out[o + 2] = src[s + 2];
        out[o + 3] = src[s + 3];
      }
    }
    return { data: out, w: nw, h: nh };
  }

  /** Rotating the SOURCE by `turns` maps a point in an w x h image: used to keep the crop frame on the same paper corners. */
  function rotateQuad(q, w, h, quarterTurns) {
    const t = ((quarterTurns % 4) + 4) % 4;
    const map = (p) => (t === 0 ? { x: p.x, y: p.y } : t === 1 ? { x: h - p.y, y: p.x } : t === 2 ? { x: w - p.x, y: h - p.y } : { x: p.y, y: w - p.x });
    return orderCorners(q.map(map));
  }

  // ------------------------------------------------------------------ image treatments (colour / grayscale / document)
  const FILTERS = [
    { id: "color", label: "Couleur" },
    { id: "gray", label: "Gris" },
    { id: "document", label: "Document" },
  ];
  const FILTER_IDS = FILTERS.map((f) => f.id);

  function luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  /**
   * "color" leaves the pixels untouched, "gray" desaturates, "document" is a high-contrast black-on-white treatment: grayscale,
   * local-mean threshold (integral image, window ~ 1/16 of the long side), softened so text stays smooth. In place on `rgba`.
   */
  function applyFilter(rgba, w, h, kind) {
    if (kind === "color") return rgba;
    if (kind === "gray") {
      for (let i = 0; i < rgba.length; i += 4) {
        const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
        rgba[i] = rgba[i + 1] = rgba[i + 2] = y;
      }
      return rgba;
    }
    if (kind !== "document") return rgba;
    const n = w * h;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i += 1) g[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    const W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y += 1) {
      let row = 0;
      for (let x = 0; x < w; x += 1) {
        row += g[y * w + x];
        I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.max(w, h) / 32));
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const cnt = (x1 - x0) * (y1 - y0);
        const mean = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / cnt;
        const d = g[y * w + x] - (mean - 10); // pixels well below the local mean are ink
        const v = d >= 0 ? 255 : Math.max(0, 255 + d * 6);
        const o = (y * w + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  // ------------------------------------------------------------------ scanner session (state machine)
  /**
   * states: idle -> editing (a captured page is being framed) -> idle (pages kept) ... -> review -> processing -> done
   * Any state -> cancelled (nothing was inserted; the session is dropped). processing -> failed (nothing inserted).
   * The session keeps only references to page records; the DOM layer owns the pixel buffers.
   */
  function scanNew() {
    return { state: "idle", pages: [], editing: -1, error: "", inserted: false };
  }

  function scanReduce(s, ev) {
    const t = ev && ev.type;
    const next = (patch) => Object.assign({}, s, patch);
    switch (t) {
      case "capture": // a source image is available: start framing it (a new page, or a retake of `index`)
        if (s.state !== "idle" && s.state !== "review") return s;
        if (typeof ev.index === "number") return ev.index >= 0 && ev.index < s.pages.length ? next({ state: "editing", editing: ev.index, error: "" }) : s;
        if (s.pages.length >= LIMITS.scanPagesMax) return next({ error: "limit" });
        return next({ state: "editing", editing: -1, error: "" });
      case "accept": { // the framed page is kept
        if (s.state !== "editing") return s;
        const pages = s.pages.slice();
        if (s.editing >= 0) pages[s.editing] = ev.page;
        else if (pages.length < LIMITS.scanPagesMax) pages.push(ev.page);
        else return next({ state: "idle", editing: -1, error: "limit" });
        return next({ state: "review", pages, editing: -1, error: "" });
      }
      case "discard-edit":
        return s.state === "editing" ? next({ state: s.pages.length ? "review" : "idle", editing: -1 }) : s;
      case "remove": {
        if (s.state !== "review" || ev.index < 0 || ev.index >= s.pages.length) return s;
        const pages = s.pages.filter((_, i) => i !== ev.index);
        return next({ pages, state: pages.length ? "review" : "idle" });
      }
      case "move": {
        if (s.state !== "review") return s;
        const from = ev.index;
        const to = ev.index + ev.delta;
        if (from < 0 || to < 0 || from >= s.pages.length || to >= s.pages.length) return s;
        const pages = s.pages.slice();
        const [p] = pages.splice(from, 1);
        pages.splice(to, 0, p);
        return next({ pages });
      }
      case "process":
        return s.state === "review" && s.pages.length ? next({ state: "processing", error: "" }) : s;
      case "done":
        return s.state === "processing" ? next({ state: "done", inserted: true }) : s;
      case "fail":
        return s.state === "processing" ? next({ state: "review", error: String(ev.reason || "failed") }) : s;
      case "cancel":
        return s.state === "done" ? s : { state: "cancelled", pages: [], editing: -1, error: "", inserted: false };
      default:
        return s;
    }
  }

  /**
   * Blocks for N uploaded scan pages: ONE page -> an image; several -> image groups of 2 or 3 (the existing imagegroup contract),
   * never a group of one. 4 -> 2+2, 5 -> 3+2, 7 -> 3+2+2.
   */
  function pageGroups(n) {
    if (!Number.isInteger(n) || n < 1) return [];
    if (n === 1) return [1];
    const out = [];
    let left = n;
    if (n % 3 === 1) {
      out.push(2, 2);
      left -= 4;
    } else if (n % 3 === 2) {
      out.push(2);
      left -= 2;
    }
    while (left > 0) {
      out.push(3);
      left -= 3;
    }
    return out.sort((a, b) => b - a); // longer groups first: 3,3,2 reads better than 2,3,3
  }

  // ------------------------------------------------------------------ OCR text -> chunks -> one logical insertion
  const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

  /** Clean raw OCR text: NFC, newlines normalised, control chars removed, runs of blanks collapsed, hyphenated line breaks joined. */
  function cleanOcrText(raw) {
    let t = typeof raw === "string" ? raw : "";
    try {
      t = t.normalize("NFC");
    } catch (_) {
      /* keep as is */
    }
    t = t.replace(/\r\n?/g, "\n").replace(CTRL, "").replace(/[ \t ]+/g, " ");
    t = t.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2"); // "docu-\nment" -> "document"
    t = t.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  /** Split cleaned text into paragraph chunks (blank-line separated; single newlines inside a paragraph become spaces). */
  function chunkOcrText(raw, o) {
    const max = (o && o.blockChars) || LIMITS.ocrBlockChars;
    const text = cleanOcrText(raw);
    if (!text) return [];
    const out = [];
    for (const para of text.split(/\n\n+/)) {
      let p = para.replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();
      while (p.length > max) {
        let cut = p.lastIndexOf(" ", max);
        if (cut < max * 0.5) cut = max; // no good break point: hard cut (never mid-surrogate)
        const code = p.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        out.push(p.slice(0, cut).trim());
        p = p.slice(cut).trim();
      }
      if (p) out.push(p);
    }
    return out;
  }

  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  }

  /**
   * The ONE insertion plan for derived text. `kind` ocr|transcript, `sourceId` the canonical asset / voice id, `chunks` strings.
   * Returns {ok:true, count, chars} for the preview (shown BEFORE inserting) or {ok:false, reason}. Pure: nothing is inserted here.
   * `limits` = {page_blocks, page_text_bytes, derived_blocks_per_page}; `used` = {blocks, bytes, derived} of the page now.
   */
  function planDerived(kind, sourceId, chunks, limits, used) {
    if (kind !== "ocr" && kind !== "transcript") return { ok: false, reason: "kind" };
    if (!Array.isArray(chunks) || !chunks.length) return { ok: false, reason: "empty" };
    if (kind === "ocr" && chunks.length > LIMITS.ocrBlocksMax) return { ok: false, reason: "too_many" };
    const lim = limits || {};
    const u = used || { blocks: 0, bytes: 0, derived: 0 };
    let bytes = 0;
    let chars = 0;
    for (const c of chunks) {
      if (typeof c !== "string" || !c) return { ok: false, reason: "empty" };
      bytes += utf8Len(c) + 1;
      chars += c.length;
    }
    if (kind === "transcript" && chars > LIMITS.transcriptCharsMax) return { ok: false, reason: "transcript_too_long" };
    if (lim.page_blocks && u.blocks + chunks.length > lim.page_blocks) return { ok: false, reason: "page_blocks" };
    if (lim.derived_blocks_per_page && u.derived + chunks.length > lim.derived_blocks_per_page) return { ok: false, reason: "derived_blocks" };
    if (lim.page_text_bytes && u.bytes + bytes > lim.page_text_bytes) return { ok: false, reason: "page_text" };
    return { ok: true, count: chunks.length, chars, bytes, sourceKind: kind === "ocr" ? "asset" : "voice", sourceId };
  }

  const PLAN_MESSAGES = {
    empty: "Aucun texte à insérer",
    kind: "Type de contenu dérivé inconnu",
    too_many: "Texte trop long pour une seule insertion",
    transcript_too_long: "Transcription trop longue (maximum 20 000 caractères)",
    page_blocks: "La page est trop longue : rien n'a été inséré",
    derived_blocks: "Trop de blocs de texte dérivé sur cette page : rien n'a été inséré",
    page_text: "La page deviendrait trop volumineuse : rien n'a été inséré",
  };

  // ------------------------------------------------------------------ OCR run (sequential, one worker, cancellable)
  function ocrNew(pageCount) {
    const n = Math.max(0, Math.min(LIMITS.ocrPagesMax, pageCount | 0));
    return { state: pageCount > LIMITS.ocrPagesMax ? "refused" : "idle", pages: n, page: 0, texts: [], error: pageCount > LIMITS.ocrPagesMax ? "too_many_pages" : "" };
  }

  function ocrReduce(s, ev) {
    switch (ev && ev.type) {
      case "start":
        return s.state === "idle" ? Object.assign({}, s, { state: "running", page: 1, texts: [], error: "" }) : s;
      case "page-done": {
        if (s.state !== "running") return s;
        const texts = s.texts.concat([String(ev.text || "")]);
        return texts.length >= s.pages ? Object.assign({}, s, { state: "review", texts, page: s.pages }) : Object.assign({}, s, { texts, page: texts.length + 1 });
      }
      case "fail":
        return s.state === "running" ? Object.assign({}, s, { state: "failed", error: String(ev.reason || "failed") }) : s;
      case "cancel":
        return s.state === "running" || s.state === "idle" || s.state === "review" || s.state === "failed" ? Object.assign({}, s, { state: "cancelled" }) : s;
      case "retry":
        return s.state === "failed" || s.state === "cancelled" ? Object.assign({}, s, { state: "idle", page: 0, texts: [], error: "" }) : s;
      default:
        return s;
    }
  }

  function ocrStatusText(s) {
    switch (s.state) {
      case "running": return "Reconnaissance du texte : page " + s.page + " sur " + s.pages;
      case "review": return "Texte reconnu";
      case "failed": return "La reconnaissance du texte a échoué";
      case "cancelled": return "Reconnaissance du texte annulée";
      case "refused": return "Trop de pages pour une seule reconnaissance (maximum " + LIMITS.ocrPagesMax + ")";
      default: return "Prêt à reconnaître le texte";
    }
  }

  // ------------------------------------------------------------------ voice recorder
  /** Container preference: WebM/Opus (Chromium, Firefox) then MP4/AAC (Safari). `supported(type)` = MediaRecorder.isTypeSupported. */
  const VOICE_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

  function pickVoiceType(supported) {
    if (typeof supported !== "function") return "";
    for (const t of VOICE_TYPES) {
      try {
        if (supported(t)) return t;
      } catch (_) {
        /* next */
      }
    }
    return "";
  }

  /** "m:ss" elapsed time (also announced as text, never colour only). */
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function fmtSpoken(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (m ? m + (m > 1 ? " minutes " : " minute ") : "") + r + (r > 1 ? " secondes" : " seconde");
  }

  /**
   * idle -> requesting (permission prompt after a direct user action) -> recording -> stopped (a recorded blob awaits keep / discard)
   * -> uploading -> done. denied / unavailable / failed are terminal until `reset`.
   */
  function recNew() {
    return { state: "idle", ms: 0, bytes: 0, type: "", error: "", reason: "" };
  }

  function recReduce(s, ev) {
    switch (ev && ev.type) {
      case "request":
        return s.state === "idle" ? Object.assign({}, recNew(), { state: "requesting" }) : s;
      case "granted":
        return s.state === "requesting" ? Object.assign({}, s, { state: "recording", type: String(ev.mime || ""), ms: 0, bytes: 0 }) : s;
      case "denied":
        return s.state === "requesting" ? Object.assign({}, s, { state: "denied" }) : s;
      case "unavailable":
        return s.state === "requesting" || s.state === "idle" ? Object.assign({}, s, { state: "unavailable", reason: String(ev.reason || "") }) : s;
      case "tick": {
        if (s.state !== "recording") return s;
        const ms = Math.min(LIMITS.voiceMsMax, Math.max(s.ms, ev.ms | 0));
        const bytes = Math.max(s.bytes, ev.bytes | 0);
        return Object.assign({}, s, { ms, bytes });
      }
      case "stop":
        return s.state === "recording" ? Object.assign({}, s, { state: "stopped", reason: ev.reason === "limit" ? "limit" : ev.reason === "size" ? "size" : "" }) : s;
      case "discard":
        return s.state === "stopped" || s.state === "recording" || s.state === "requesting" ? recNew() : s;
      case "upload":
        return s.state === "stopped" ? Object.assign({}, s, { state: "uploading" }) : s;
      case "uploaded":
        return s.state === "uploading" ? Object.assign({}, s, { state: "done" }) : s;
      case "fail":
        return s.state === "uploading" ? Object.assign({}, s, { state: "stopped", error: String(ev.reason || "failed") }) : Object.assign({}, s, { state: "failed", error: String(ev.reason || "failed") });
      case "reset":
        return recNew();
      default:
        return s;
    }
  }

  /** Why the recorder must stop itself now ("" = keep going). */
  function recShouldStop(s) {
    if (s.state !== "recording") return "";
    if (s.ms >= LIMITS.voiceMsMax) return "limit";
    if (s.bytes >= LIMITS.voiceSafeBytes) return "size";
    return "";
  }

  function recStatusText(s) {
    switch (s.state) {
      case "requesting": return "Autorisez le microphone pour enregistrer";
      case "recording": return "Enregistrement en cours : " + fmtSpoken(s.ms);
      case "stopped": return (s.reason === "limit" ? "Durée maximale atteinte. " : s.reason === "size" ? "Taille maximale atteinte. " : "") + "Enregistrement terminé : " + fmtSpoken(s.ms);
      case "uploading": return "Enregistrement de la note vocale";
      case "done": return "Note vocale insérée";
      case "denied": return "Accès au microphone refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.";
      case "unavailable": return "Enregistrement audio indisponible sur cet appareil";
      case "failed": return "L'enregistrement a échoué";
      default: return "Prêt à enregistrer";
    }
  }

  // ------------------------------------------------------------------ transcript
  /** idle -> preparing -> running -> editing (a transcript to review) ; failed / unconfigured / deferred are explicit. */
  function trNew() {
    return { state: "idle", text: "", error: "" };
  }

  function trReduce(s, ev) {
    switch (ev && ev.type) {
      case "start":
        return s.state === "idle" || s.state === "failed" || s.state === "deferred" ? { state: "preparing", text: "", error: "" } : s;
      case "running":
        return s.state === "preparing" ? Object.assign({}, s, { state: "running" }) : s;
      case "done":
        return s.state === "running" ? { state: "editing", text: String(ev.text || ""), error: "" } : s;
      case "edit":
        return s.state === "editing" ? Object.assign({}, s, { text: String(ev.text || "") }) : s;
      case "unconfigured":
        return s.state === "preparing" || s.state === "running" ? { state: "unconfigured", text: "", error: "" } : s;
      case "fail":
        return s.state === "preparing" || s.state === "running" ? { state: "failed", text: "", error: String(ev.reason || "failed") } : s;
      case "defer": // "Traiter plus tard": nothing runs now, the voice note stays as it is
        return s.state === "idle" || s.state === "failed" || s.state === "unconfigured" ? { state: "deferred", text: "", error: "" } : s;
      case "cancel":
        return s.state === "preparing" || s.state === "running" ? { state: "idle", text: "", error: "" } : s;
      case "reset":
        return trNew();
      default:
        return s;
    }
  }

  function trStatusText(s) {
    switch (s.state) {
      case "preparing": return "Préparation de l'audio";
      case "running": return "Transcription en cours";
      case "editing": return "Transcription prête à relire";
      case "failed": return "La transcription a échoué";
      case "unconfigured": return "Transcription non configurée sur ce serveur";
      case "deferred": return "Transcription reportée";
      default: return "Transcription non lancée";
    }
  }

  /** Transcript text -> chunks (paragraphs by blank line; a single long paragraph is split like OCR text). */
  function chunkTranscript(text) {
    return chunkOcrText(text, { blockChars: LIMITS.ocrBlockChars });
  }

  // ------------------------------------------------------------------ recovery stash (policy only; IndexedDB is the UI layer's)
  /**
   * Bounded recovery stash for UNCOMMITTED captures (scan source pages, audio): hard byte / item limit, TTL, no sync semantics.
   * An item: {id, kind: "scan"|"voice", bytes, at, ...}. Pure helpers over the item list (metadata only).
   */
  function stashPrune(items, now, lim) {
    const l = Object.assign({}, STASH_LIMITS, lim || {});
    const live = items.filter((i) => i && typeof i.at === "number" && now - i.at < l.ttlMs && now >= i.at - 60000);
    return { keep: live, drop: items.filter((i) => live.indexOf(i) < 0) };
  }

  /**
   * Can `item` be added? NEVER evicts another capture to make room (silently losing a field capture is worse than refusing):
   * returns {ok:true} or {ok:false, reason:"items"|"bytes"|"too_big"}. Expired items are pruned first by the caller.
   */
  function stashAdmit(items, item, lim) {
    const l = Object.assign({}, STASH_LIMITS, lim || {});
    if (!item || !(item.bytes >= 0)) return { ok: false, reason: "too_big" };
    if (item.bytes > l.bytes) return { ok: false, reason: "too_big" };
    if (items.length + 1 > l.items) return { ok: false, reason: "items" };
    let total = item.bytes;
    for (const i of items) total += i.bytes || 0;
    if (total > l.bytes) return { ok: false, reason: "bytes" };
    return { ok: true };
  }

  const STASH_MESSAGES = {
    items: "Trop de captures en attente : insérez ou supprimez-en avant d'en garder d'autres",
    bytes: "Espace de récupération plein : insérez ou supprimez des captures en attente",
    too_big: "Capture trop volumineuse pour être gardée en réserve",
  };

  /** In-memory stash store (tests; the UI layer provides an IndexedDB one with the same async interface). */
  function memoryStash() {
    const m = new Map();
    return {
      async list() { return Array.from(m.values()).map((v) => ({ id: v.id, kind: v.kind, bytes: v.bytes, at: v.at, meta: v.meta })); },
      async put(rec) { m.set(rec.id, rec); },
      async get(id) { return m.get(id) || null; },
      async del(id) { m.delete(id); },
      async clear() { m.clear(); },
    };
  }

  /** Mono 16-bit PCM WAV (RIFF) bytes from Float32 samples in [-1, 1]. Bounded by the caller (10 min at 16 kHz ~ 19 MB). */
  function encodeWav(samples, rate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i += 1) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  return {
    LIMITS, STASH_LIMITS, HUD_ACTIONS, FILTERS, FILTER_IDS, VOICE_TYPES, PLAN_MESSAGES, STASH_MESSAGES,
    hudState,
    orderCorners, defaultCorners, quadProblem, outputSize, homography, warpPerspective, rotateRGBA, rotateQuad, applyFilter,
    scanNew, scanReduce, pageGroups,
    cleanOcrText, chunkOcrText, planDerived, utf8Len, ocrNew, ocrReduce, ocrStatusText,
    pickVoiceType, fmtElapsed, fmtSpoken, recNew, recReduce, recShouldStop, recStatusText,
    trNew, trReduce, trStatusText, chunkTranscript, encodeWav,
    stashPrune, stashAdmit, memoryStash,
  };
});
