/* Transfert HQ — Carnet Product Phase 3: native Dessiner integration (orchestration only).
 *
 * Ownership: Dessiner owns the drawing (immutable stems, optional fixed image underlay); Carnet owns the notebook and stores only
 * `{"drawing": {"id": <stem>}}`. Nothing of Dessiner's document ever enters the notebook.
 *
 * This module holds (1) the PURE return-context codec / validator and (2) `mount(host)`, the create / open / annotate / return
 * flows. The context lives in sessionStorage (never in a URL), is bounded, single-shot and strictly validated on return.
 *
 * RETURN IS NAVIGATION ONLY for an existing drawing: it re-opens the page, re-finds the block by id, refreshes the preview and
 * (when Dessiner saved a NEW immutable stem) OFFERS "Utiliser cette version" — never applied automatically, no "latest" lookup.
 * For a NEW sketch / an annotation, a successful save may make ONE normal local draft edit (insert the reference) provided the
 * captured context is still valid; it enters the ordinary draft / revision / conflict path. Otherwise nothing is touched and the
 * saved drawing simply remains an independent Dessiner drawing (it is never deleted).
 *
 * Plain ES2020, UMD (browser global HqCarnetDessiner / CommonJS for the pure helpers).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetDessiner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CTX_KEY = "hq-carnet-dessiner-ctx-v1";
  const TTL_MS = 6 * 60 * 60 * 1000;
  const MODES = ["open", "new", "annotate"];
  const RE = {
    page: /^page-[A-Za-z0-9_-]{1,64}$/,
    block: /^block-[A-Za-z0-9_-]{1,64}$/,
    stem: /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/,
    asset: /^asset-[0-9a-f]{24}$/,
  };
  const KEYS = {
    open: ["v", "mode", "pageId", "rev", "t", "blockId", "stem"],
    new: ["v", "mode", "pageId", "rev", "t", "anchorId"],
    annotate: ["v", "mode", "pageId", "rev", "t", "anchorId", "assetId"],
  };

  const MSG = {
    unavailable: "Dessiner indisponible",
    readonly: "Page en lecture seule",
    saveFirst: "Enregistre d'abord la page",
    conflict: "Résous d'abord le conflit de la page",
    stale: "Le bloc a changé : action annulée",
    pageGone: "La page n'existe plus : rien n'a été modifié",
    pageTrashed: "La page est dans la corbeille : rien n'a été modifié",
    blockGone: "Le croquis a été retiré de la page : rien n'a été recréé",
    blockChanged: "Le bloc a changé pendant que Dessiner était ouvert : rien n'a été modifié",
    revAdvanced: "La page a changé pendant l'édition du croquis : la référence n'a pas été insérée. Le croquis reste disponible dans Dessiner.",
    dirty: "La page contient des modifications locales : la référence n'a pas été insérée. Le croquis reste disponible dans Dessiner.",
    anchorGone: "L'emplacement a disparu : la référence n'a pas été insérée. Le croquis reste disponible dans Dessiner.",
    refused: "Insertion refusée : la référence n'a pas été ajoutée. Le croquis reste disponible dans Dessiner.",
    unverified: "Impossible de vérifier le carnet : le croquis est enregistré. Rouvre le carnet pour terminer le retour.",
    inserted: "Croquis inséré",
    linkNew: "Nouveau croquis lié à ce carnet",
    linkOpen: "Croquis ouvert depuis le carnet",
    linkAnnotate: "Annotation d'une image du carnet",
  };

  function isInt(v) {
    return typeof v === "number" && Number.isInteger(v);
  }

  /** Strict validation of a stored / incoming context. Clean copy or null. Never trusts shape, size, age or ids. */
  function checkContext(raw, now) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1 || MODES.indexOf(raw.mode) < 0) return null;
    const allowed = KEYS[raw.mode].concat(["saved"]);
    for (const k of Object.keys(raw)) if (allowed.indexOf(k) < 0) return null;
    for (const k of KEYS[raw.mode]) if (k !== "anchorId" && raw[k] === undefined) return null;
    if (typeof raw.pageId !== "string" || !RE.page.test(raw.pageId) || !isInt(raw.rev) || raw.rev < 1 || !isInt(raw.t)) return null;
    const t = typeof now === "number" ? now : Date.now();
    if (t - raw.t > TTL_MS || raw.t - t > 60000) return null;
    const out = { v: 1, mode: raw.mode, pageId: raw.pageId, rev: raw.rev, t: raw.t };
    if (raw.mode === "open") {
      if (typeof raw.blockId !== "string" || !RE.block.test(raw.blockId) || typeof raw.stem !== "string" || !RE.stem.test(raw.stem)) return null;
      out.blockId = raw.blockId;
      out.stem = raw.stem;
    } else {
      if (raw.anchorId !== "" && (typeof raw.anchorId !== "string" || !RE.block.test(raw.anchorId))) return null;
      out.anchorId = raw.anchorId;
      if (raw.mode === "annotate") {
        if (typeof raw.assetId !== "string" || !RE.asset.test(raw.assetId) || raw.anchorId === "") return null;
        out.assetId = raw.assetId;
      }
    }
    if (raw.saved !== undefined) {
      if (typeof raw.saved !== "string" || !RE.stem.test(raw.saved)) return null;
      out.saved = raw.saved;
    }
    return out;
  }

  /** Build a context (null when any field is not valid). `anchorId` "" = append at the end of the page. */
  function makeContext(args, now) {
    const t = typeof now === "number" ? now : Date.now();
    const raw = Object.assign({ v: 1, t }, args);
    if (raw.mode !== "open" && raw.anchorId === undefined) raw.anchorId = "";
    return checkContext(raw, t);
  }

  function mount(host) {
    const store = () => {
      try {
        return host.storage();
      } catch (_) {
        return null;
      }
    };
    function read() {
      const s = store();
      if (!s) return null;
      try {
        const raw = s.getItem(CTX_KEY);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (_) {
          s.removeItem(CTX_KEY); // unreadable context: dropped, it can never become valid
          return null;
        }
      } catch (_) {
        return null;
      }
    }
    function write(ctx) {
      const s = store();
      if (!s) return false;
      try {
        s.setItem(CTX_KEY, JSON.stringify(ctx));
        return true;
      } catch (_) {
        return false;
      }
    }
    function clear() {
      const s = store();
      try {
        if (s) s.removeItem(CTX_KEY);
      } catch (_) {}
    }

    /** Dessiner reported a successful save of a NEW immutable stem: remember the latest one in the (still valid) context. */
    function onSaved(info) {
      const ctx = checkContext(read(), host.now());
      if (!ctx || !info || typeof info.stem !== "string" || !RE.stem.test(info.stem)) return;
      ctx.saved = info.stem;
      write(ctx);
    }

    /**
     * Leave Carnet for Dessiner. kind: "open" {blockId, stem} | "new" {anchorId} | "annotate" {anchorId, assetId}.
     * Everything is checked against the CURRENT page state after the page has been saved; any failure leaves Carnet untouched.
     */
    async function start(kind, args) {
      const sk = host.sketch();
      if (!sk) {
        host.flash(MSG.unavailable);
        return false;
      }
      let cur = host.current();
      if (!cur || cur.readOnly) {
        host.flash(MSG.readonly);
        return false;
      }
      if (cur.conflict) {
        host.flash(MSG.conflict);
        return false;
      }
      const flushed = await host.flushCurrent();
      cur = host.current();
      if (!flushed || !cur || cur.dirty || cur.conflict) {
        host.flash(MSG.saveFirst);
        return false;
      }
      let ctxArgs = { mode: kind, pageId: cur.pageId, rev: cur.rev };
      if (kind === "open") {
        const b = host.findBlock(args.blockId);
        if (!b || b.type !== "drawing" || b.stem !== args.stem) {
          host.flash(MSG.stale);
          return false;
        }
        ctxArgs = Object.assign(ctxArgs, { blockId: args.blockId, stem: args.stem });
      } else if (kind === "annotate") {
        // the image is looked up in the SAVED state (a fresh image only has its real id once the page is saved)
        const b = host.blockAt(args.anchorIndex);
        if (!b || b.type !== "image" || b.assetId !== args.assetId || !b.id) {
          host.flash(MSG.stale);
          return false;
        }
        ctxArgs = Object.assign(ctxArgs, { anchorId: b.id, assetId: args.assetId });
      } else {
        const b = typeof args.anchorIndex === "number" ? host.blockAt(args.anchorIndex) : null;
        ctxArgs.anchorId = b && b.id ? b.id : ""; // no real anchor yet = append at the end of the page
      }
      const ctx = makeContext(ctxArgs, host.now());
      if (!ctx || !write(ctx)) {
        host.flash(MSG.refused);
        return false;
      }
      const link = {
        label: kind === "open" ? MSG.linkOpen : kind === "annotate" ? MSG.linkAnnotate : MSG.linkNew,
        ret: () => host.setView("carnet"),
        onSaved,
      };
      host.setView("dessiner"); // Dessiner builds itself on first show; the exact entry point runs afterwards
      let res = null;
      try {
        res = kind === "open" ? await sk.openExact(args.stem, link) : kind === "annotate" ? sk.startUnderlay(args.assetId, link) : sk.startBlank(link);
      } catch (_) {
        res = null;
      }
      if (!res || !res.ok) {
        clear();
        host.setView("carnet");
        host.flash((res && res.error) || MSG.unavailable);
        return false;
      }
      return true;
    }

    let resuming = false;

    /**
     * Called when Carnet is shown again. Navigation first, at most one validated local insertion.
     * The context is consumed only at a TERMINAL state (done, definitively refused, or cancelled). When the authoritative refresh
     * of the notebook fails the context is KEPT (no decision is taken on cached state) so the next show of Carnet retries.
     */
    async function resume() {
      if (resuming) return;
      const raw = read();
      if (raw === null) return;
      resuming = true;
      try {
        const ctx = checkContext(raw, host.now());
        if (!ctx) {
          clear(); // expired, malformed or foreign: dropped silently, nothing is touched
          if (typeof host.clearSketchLink === "function") host.clearSketchLink();
          return;
        }
        if (typeof host.clearSketchLink === "function") host.clearSketchLink();
        const fresh = await host.refreshRemote();
        if (fresh !== true) return host.flash(MSG.unverified); // NOT terminal: context retained, nothing decided on cached state
        const end = (msg) => {
          clear();
          if (msg) host.flash(msg);
        };
        const ps = host.pageState(ctx.pageId);
        if (!ps) return end(MSG.pageGone);
        if (ps.trashed) return end(MSG.pageTrashed);
        if (!(await host.openPage(ctx.pageId))) return end(MSG.pageGone);
        if (ctx.mode === "open") {
          const b = host.findBlock(ctx.blockId);
          if (!b) return end(MSG.blockGone); // deleted meanwhile: never reinserted
          if (b.type !== "drawing" || b.stem !== ctx.stem) return end(MSG.blockChanged);
          end();
          host.refreshPreviews();
          host.reveal(ctx.blockId);
          if (ctx.saved && ctx.saved !== ctx.stem) host.offerVersion(ctx.blockId, ctx.stem, ctx.saved);
          return;
        }
        if (!ctx.saved) {
          // nothing was saved: cancelled. Go back to where the user was; nothing is created or changed.
          end();
          if (ctx.anchorId) host.reveal(ctx.anchorId);
          return;
        }
        // insertion: only when the page is exactly what it was when the user left
        if (ps.rev !== ctx.rev || ps.conflict) return end(MSG.revAdvanced);
        if (ps.dirty) return end(MSG.dirty);
        if (ctx.anchorId) {
          const a = host.findBlock(ctx.anchorId);
          if (!a) return end(MSG.anchorGone);
          if (ctx.mode === "annotate" && (a.type !== "image" || a.assetId !== ctx.assetId)) return end(MSG.blockChanged);
        }
        clear(); // consumed before the single edit: it can never run twice
        const at = host.insertDrawing({ anchorId: ctx.anchorId, stem: ctx.saved, replaceEmpty: ctx.mode === "new" });
        if (at === null || at === undefined || at < 0) return host.flash(MSG.refused);
        host.flash(MSG.inserted);
      } finally {
        resuming = false;
      }
    }

    return { start, resume, onSaved, hasContext: () => read() !== null };
  }

  return { CTX_KEY, TTL_MS, MODES, MSG, checkContext, makeContext, mount };
});
