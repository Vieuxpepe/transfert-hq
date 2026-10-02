/* Transfert HQ — Carnet Product Phase 3.5: PURE interaction core (no DOM, no network, no storage).
 *
 * Everything here is a deterministic function of its arguments, so the browser layer stays thin and the whole contract is checked in
 * Node (tests/check_hq_carnet_polish.mjs):
 *
 *   1. block anchors      makeAnchor / parseAnchor / makeUrl        "#carnet/<pageId>/<blockId>", strict, zero authority
 *   2. page outline       buildOutline(lines)                       a VIEW over the parsed lines (never the DOM), signature = exactly what it shows
 *   3. save pill          deriveSave(snapshot)                      one pure mapping of the EXISTING draft / save state, explicit precedence
 *   4. inspector          inspectSource / view maths / compare      presentation only: URLs built from validated ids, nothing persisted
 *   5. suggestions        suggestFor(context)                       deterministic, additive, never touches ranking or recents
 *   6. portal cards       portalModel(ref, known)                   a renderer over an existing canonical ref (no copied state)
 *
 * Plain ES2020, UMD (browser global HqCarnetNav / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetNav = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ 1. block anchors
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const ANCHOR_PREFIX = "#carnet/";

  /** "#carnet/<pageId>/<blockId>" or null when either id is not a canonical id. */
  function makeAnchor(pageId, blockId) {
    if (typeof pageId !== "string" || typeof blockId !== "string" || !PAGE_RE.test(pageId) || !BLOCK_RE.test(blockId)) return null;
    return ANCHOR_PREFIX + encodeURIComponent(pageId) + "/" + encodeURIComponent(blockId);
  }

  /**
   * The WHOLE fragment is validated before anything navigates: exactly two path components, canonical ids, no query / extra
   * components / encoded separators / whitespace. Anything else => null (ignored safely, no partial navigation).
   */
  function parseAnchor(hash) {
    if (typeof hash !== "string" || hash.length > 200 || hash.indexOf(ANCHOR_PREFIX) !== 0) return null;
    const rest = hash.slice(ANCHOR_PREFIX.length);
    const parts = rest.split("/");
    if (parts.length !== 2) return null;
    let page;
    let block;
    try {
      page = decodeURIComponent(parts[0]);
      block = decodeURIComponent(parts[1]);
    } catch (_) {
      return null;
    }
    if (page !== parts[0] || block !== parts[1]) return null; // canonical ids never need escaping: an escape is junk
    if (!PAGE_RE.test(page) || !BLOCK_RE.test(block)) return null;
    return { pageId: page, blockId: block };
  }

  /** Absolute shareable URL from a location-like object ({origin, pathname, search}); null when the anchor is not valid. */
  function makeUrl(loc, pageId, blockId) {
    const a = makeAnchor(pageId, blockId);
    if (!a || !loc || typeof loc.origin !== "string" || typeof loc.pathname !== "string") return null;
    return loc.origin + loc.pathname + (typeof loc.search === "string" ? loc.search : "") + a;
  }

  // ------------------------------------------------------------------ 2. outline
  const LABEL_MAX = 80;
  const KIND_LABEL = { title: "Titre de la page", heading: "Titre", table: "Tableau", image: "Image", imagegroup: "Groupe d'images", drawing: "Croquis", decision: "Décision", measure: "Mesure" };

  function clip(s) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + "…" : t;
  }

  function nodeLabel(l, opts) {
    switch (l.type) {
      case "heading":
        return clip(l.text);
      case "table": {
        const cell = l.struct && Array.isArray(l.struct.rows) && l.struct.rows[0] ? clip(l.struct.rows[0][0]) : "";
        return cell ? "Tableau · " + cell : "Tableau";
      }
      case "image":
        return l.asset && l.asset.caption ? "Image · " + clip(l.asset.caption) : "Image";
      case "imagegroup": {
        const n = l.struct && Array.isArray(l.struct.items) ? l.struct.items.length : 0;
        return l.struct && l.struct.layout === "compare" ? "Avant / après" : "Groupe d'images" + (n ? " (" + n + ")" : "");
      }
      case "drawing": {
        const f = opts && typeof opts.drawingLabel === "function" && l.struct ? opts.drawingLabel(l.struct.id) : l.struct ? l.struct.id : "";
        return f ? "Croquis · " + clip(f) : "Croquis";
      }
      case "decision":
        return l.text && l.text.trim() ? "Décision · " + clip(l.text) : "Décision";
      case "measure":
        return l.eng && l.eng.label ? "Mesure · " + clip(l.eng.label) : "Mesure";
      default:
        return "";
    }
  }

  /**
   * The outline of a page, from the PARSED lines ({type, text, id, asset, eng, struct}). Text structure = the page title and the
   * headings; assets = tables, images, image groups, drawings, decisions, measurements. Paragraphs are never listed.
   * `sig` is built from exactly the data an item displays (position, id, kind, label): equal signature <=> identical outline,
   * so a label edit, a reorder or a delete changes it while typing in an ordinary paragraph does not.
   */
  function buildOutline(lines, opts) {
    const o = opts || {};
    const items = [];
    if (!Array.isArray(lines)) return { items, sig: "" };
    const untitled = typeof o.untitled === "string" ? o.untitled : "Page sans titre";
    // The title node follows Carnet's ACCEPTED title rule (first non-empty line, only when it is prose), injected from the editor's
    // own pure helper (HqCarnetCommands.titleIndex) so the rule is never duplicated here. Without it there is no title node.
    let titleAt = -1;
    if (typeof o.titleIndex === "function") {
      const t = o.titleIndex(lines);
      titleAt = Number.isInteger(t) ? t : -1;
    }
    lines.forEach((l, index) => {
      if (!l || typeof l !== "object") return;
      let kind = null;
      let label = "";
      if (index === titleAt && (l.type === "paragraph" || l.type === "heading")) {
        kind = "title";
        label = clip(l.text) || untitled;
      } else if (l.type === "heading") {
        label = clip(l.text);
        if (label) kind = "heading";
      } else if (["table", "image", "imagegroup", "drawing", "decision", "measure"].indexOf(l.type) >= 0) {
        kind = l.type;
        label = nodeLabel(l, o);
      }
      if (!kind) return;
      items.push({ index, id: typeof l.id === "string" && BLOCK_RE.test(l.id) ? l.id : "", kind, group: kind === "title" || kind === "heading" ? "text" : "asset", label });
    });
    const sig = items.map((i) => i.index + "\u0001" + i.id + "\u0001" + i.kind + "\u0001" + i.label).join("\u0002");
    return { items, sig };
  }

  // ------------------------------------------------------------------ 3. save pill
  const SAVE_LABEL = { idle: "", saved: "Enregistré", saving: "Enregistrement…", local: "Brouillon local", offline: "Hors ligne", conflict: "Conflit", failed: "Échec" };
  const SAVE_EXPLAIN = {
    saved: "Toutes tes modifications sont enregistrées sur le serveur.",
    saving: "Tes modifications partent vers le serveur.",
    local: "Tes modifications sont conservées sur cet appareil et partiront dès que la connexion revient. Elles ne sont pas encore sur le serveur.",
    offline: "Pas de connexion. Rien n'est en attente : la page affichée est celle du serveur.",
    conflict: "La page a changé ailleurs. Ta saisie est conservée sur cet appareil : choisis la version à garder.",
    failed: "L'enregistrement a échoué. Ta saisie reste sur cet appareil : ne ferme pas cette page avant de réessayer.",
    idle: "",
  };
  const SAVE_KIND = { idle: "", saved: "ok", saving: "busy", local: "warn", offline: "warn", conflict: "warn", failed: "err" };

  /**
   * ONE pure mapping of the existing draft / save state (no second state machine). Deterministic severity precedence:
   *   conflict > failed (hard save / storage error) > local draft (dirty offline, or a trashed page's kept draft) >
   *   offline (clean) > saving (dirty / in flight, online) > saved (clean AND confirmed) > idle.
   * "Enregistré" is returned ONLY when nothing is dirty, in flight, conflicted, failed or offline. A benign `notice` never turns
   * the pill red: it is carried as `notice` (shown in the explanation), never as a state.
   * snapshot: {hasEntry, trashed, conflict, error, storageFailed, dirty, inflight, offline, savedOnce, notice}
   */
  function deriveSave(snap) {
    const s = snap || {};
    let state;
    if (!s.hasEntry) state = "idle";
    else if (s.conflict) state = "conflict";
    else if (s.error || s.storageFailed) state = "failed";
    else if ((s.dirty || s.inflight) && (s.offline || s.trashed)) state = "local";
    else if (s.dirty || s.inflight) state = "saving";
    else if (s.offline) state = "offline";
    else if (s.savedOnce) state = "saved";
    else state = "idle";
    let detail = SAVE_EXPLAIN[state];
    if (s.notice && typeof s.notice === "string" && s.hasEntry) detail = (detail ? detail + " " : "") + s.notice;
    return { state, label: SAVE_LABEL[state], kind: SAVE_KIND[state], detail, notice: s.notice ? String(s.notice) : "" };
  }

  /** Should the live region announce this state at once? Quiet transient states (saving / saved) are debounced by the UI. */
  function announceNow(state) {
    return state === "conflict" || state === "failed" || state === "local" || state === "offline";
  }

  // ------------------------------------------------------------------ 4. inspector (presentation only)
  const ASSET_RE = /^asset-[0-9a-f]{24}$/;
  const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;

  /** URL of the canonical preview of ONE validated identity; null for anything else (no arbitrary URLs, no "latest"). */
  function inspectSource(kind, id) {
    if (kind === "drawing" && typeof id === "string" && STEM_RE.test(id)) return "/api/drawings/file?stem=" + encodeURIComponent(id) + "&kind=png";
    if (kind === "image" && typeof id === "string" && ASSET_RE.test(id)) return "/api/carnet/asset/" + id;
    return null;
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** The initial view: fit (zoom 1 = the image contained in the viewport), centred. */
  function viewInit() {
    return { z: 1, x: 0, y: 0 };
  }

  /** Pan limits for a zoom: the image (displayed size dw x dh at zoom 1) can never leave the viewport on an axis it overflows. */
  function panLimits(z, vw, vh, dw, dh) {
    return { x: Math.max(0, (dw * z - vw) / 2), y: Math.max(0, (dh * z - vh) / 2) };
  }

  function viewClamp(v, vw, vh, dw, dh) {
    const z = clamp(Number.isFinite(v.z) ? v.z : 1, ZOOM_MIN, ZOOM_MAX);
    const lim = panLimits(z, vw, vh, dw, dh);
    const nz = (n) => (n === 0 ? 0 : n); // never -0
    return { z, x: nz(clamp(Number.isFinite(v.x) ? v.x : 0, -lim.x, lim.x)), y: nz(clamp(Number.isFinite(v.y) ? v.y : 0, -lim.y, lim.y)) };
  }

  /** Zoom by `factor` keeping the point (cx, cy) — relative to the viewport centre — fixed under the pointer. */
  function viewZoomAt(v, factor, cx, cy, vw, vh, dw, dh) {
    const z = clamp(v.z * factor, ZOOM_MIN, ZOOM_MAX);
    const k = z / v.z;
    return viewClamp({ z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }, vw, vh, dw, dh);
  }

  function viewPan(v, dx, dy, vw, vh, dw, dh) {
    return viewClamp({ z: v.z, x: v.x + dx, y: v.y + dy }, vw, vh, dw, dh);
  }

  /** Compare slider value (percent of the width showing the "after" image): clamped, steps of 5 for the keyboard. */
  function compareClamp(p) {
    return clamp(Math.round(Number.isFinite(p) ? p : 50), 0, 100);
  }
  function compareKey(p, key) {
    if (key === "ArrowLeft" || key === "ArrowDown") return compareClamp(p - 5);
    if (key === "ArrowRight" || key === "ArrowUp") return compareClamp(p + 5);
    if (key === "Home") return 0;
    if (key === "End") return 100;
    if (key === "PageDown") return compareClamp(p - 20);
    if (key === "PageUp") return compareClamp(p + 20);
    return null;
  }

  /**
   * What the inspector may show for an element: only validated identities. The compare mode exists ONLY for an image group whose
   * layout is exactly "compare" with two valid assets; it is never persisted (position resets with every session).
   */
  function inspectSpec(input) {
    if (!input || typeof input !== "object") return null;
    if (input.kind === "drawing") {
      const src = inspectSource("drawing", input.stem);
      return src ? { kind: "drawing", stem: input.stem, src, compare: null } : null;
    }
    if (input.kind === "image") {
      const src = inspectSource("image", input.assetId);
      return src ? { kind: "image", assetId: input.assetId, src, compare: null } : null;
    }
    if (input.kind === "imagegroup") {
      const ids = Array.isArray(input.assetIds) ? input.assetIds : [];
      const srcs = ids.map((i) => inspectSource("image", i));
      if (!srcs.length || srcs.some((s) => !s)) return null;
      const compare = input.layout === "compare" && srcs.length === 2 ? { before: srcs[0], after: srcs[1] } : null;
      return { kind: "imagegroup", assetId: ids[Math.min(ids.length - 1, Math.max(0, input.index | 0))], src: srcs[Math.min(srcs.length - 1, Math.max(0, input.index | 0))], compare };
    }
    return null;
  }

  // ------------------------------------------------------------------ 5. contextual suggestions
  /**
   * Deterministic, additive suggestions for a menu opened right after `prev` (the nearest block before the insertion point):
   *   after a heading : Texte, Checklist, Tableau, Image
   *   after an image  : Annoter l'image (only for a valid canonical asset), Groupe d'images
   * They are shown as a separate "Suggéré" group; they never remove or reorder commands, never touch recents or fuzzy ranking.
   * An item is {id, label, action}: action "command" = an existing catalog command id, "annotate" = the Phase-3 annotation path.
   */
  function suggestFor(prev) {
    if (!prev || typeof prev !== "object") return [];
    if (prev.type === "heading") {
      return [
        { id: "paragraph", label: "Texte", action: "command" },
        { id: "check", label: "Checklist", action: "command" },
        { id: "table", label: "Tableau", action: "command" },
        { id: "image", label: "Image", action: "command" },
      ];
    }
    if (prev.type === "image") {
      const out = [];
      if (typeof prev.assetId === "string" && ASSET_RE.test(prev.assetId)) out.push({ id: "annotate", label: "Annoter l'image", action: "annotate" });
      out.push({ id: "imagegroup", label: "Groupe d'images", action: "command" });
      return out;
    }
    return [];
  }

  // ------------------------------------------------------------------ 6. portal cards
  const FILE_CHIP = { pdf: "PDF", doc: "DOC", docx: "DOC", xls: "XLS", xlsx: "XLS", csv: "CSV", txt: "TXT", md: "MD", zip: "ZIP", step: "CAO", stp: "CAO", stl: "STL", dxf: "DXF", dwg: "DWG", png: "IMG", jpg: "IMG", jpeg: "IMG", webp: "IMG" };
  const PORTAL_KINDS = ["file", "drawing", "model", "media"];

  function baseName(id) {
    const p = String(id).split("/");
    return p[p.length - 1];
  }

  /**
   * The card is a RENDERER over a canonical ref (kind, id): nothing here is stored, so a changed / missing target simply renders
   * differently next time. `known` is the session-local knowledge ("ok" | "missing" | "unknown"); the reference is never touched.
   * Only safe canonical metadata: base name, root-relative folder (a ref never holds an absolute path), a type chip.
   */
  function portalModel(ref, known, opts) {
    if (!ref || typeof ref !== "object" || PORTAL_KINDS.indexOf(ref.kind) < 0 || typeof ref.id !== "string") return null;
    const unavailable = known === "missing";
    if (ref.kind === "drawing") {
      if (!STEM_RE.test(ref.id)) return null;
      const label = opts && typeof opts.drawingLabel === "function" ? opts.drawingLabel(ref.id) : ref.id;
      return { kind: "drawing", title: label, subtitle: "", chip: "CROQUIS", openLabel: "Ouvrir dans Dessiner", preview: unavailable ? null : inspectSource("drawing", ref.id), unavailable, message: unavailable ? "Croquis indisponible" : "" };
    }
    if (/[\\\u0000-\u001f]/.test(ref.id) || ref.id.charAt(0) === "/" || /^[A-Za-z]:/.test(ref.id) || ref.id.split("/").indexOf("..") >= 0) return null; // never an absolute / escaping path
    const name = baseName(ref.id);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const chip = ref.kind === "model" ? "3D" : ref.kind === "media" ? "MÉDIA" : FILE_CHIP[ext] || (ext ? ext.slice(0, 4).toUpperCase() : "FICHIER");
    const parts = ref.id.split("/");
    const noun = ref.kind === "model" ? "le modèle" : ref.kind === "media" ? "le média" : "le fichier";
    return { kind: ref.kind, title: name, subtitle: parts.slice(0, -1).join("/"), chip, openLabel: "Ouvrir", openAria: "Ouvrir " + noun + " " + name, preview: null, unavailable, message: unavailable ? "Fichier indisponible" : "" };
  }

  return {
    PAGE_RE, BLOCK_RE, ANCHOR_PREFIX, makeAnchor, parseAnchor, makeUrl,
    LABEL_MAX, KIND_LABEL, buildOutline,
    SAVE_LABEL, SAVE_EXPLAIN, deriveSave, announceNow,
    ZOOM_MIN, ZOOM_MAX, inspectSource, inspectSpec, viewInit, panLimits, viewClamp, viewZoomAt, viewPan, compareClamp, compareKey,
    suggestFor, PORTAL_KINDS, portalModel,
  };
});
