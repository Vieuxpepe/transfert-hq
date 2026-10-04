/* Transfert HQ — Carnet Phase 9: Reader modal.
 *
 * The Reader VIEWS evidence (a source edition, a PDF-backed source, a citation, frozen Review Pack / snapshot evidence). It never
 * transforms, summarises or reinterprets it, never writes anything (its only request is the read-only POST reader_resolve) and
 * keeps nothing: the origin context, the page being viewed and the answers live in memory for this view only.
 *
 *   - ONE active Reader (a new open replaces the content; never nested). Escape / Tab containment / exact focus return come from the
 *     shared HqCarnetModal utility, like the portal dialogs and the Sources dialog.
 *   - The PDF is the existing authenticated, same-origin, path-confined /files/<rel>#page=N browser viewer in an iframe (a frozen file whose seal matched comes from the verified /api/carnet/reader-pdf route: hash bound to the streamed bytes). A browser
 *     that ignores #page= is told so; the requested page is never presented as reached. A frozen file that differs from its seal is
 *     NEVER loaded on its own: only through an explicit, prominently labelled action.
 *   - The PDF frame is visual-only for the keyboard (tabindex -1; focus it receives is returned to the Reader), so Escape / Tab always
 *     belong to the Reader. Navigation is the Reader's own page controls; "Ouvrir dans un onglet" gives full native PDF interaction.
 *   - DOM is built with createElement / textContent only: no HTML passthrough, no raw path, no URL typed by the client.
 * Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReaderUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const R = node ? require("./hq-carnet-reader.js") : global.HqCarnetReader;
  const M = node ? require("./hq-carnet-modal.js") : global.HqCarnetModal;
  const MSG = R.MSG;
  const LIST_MAX = 100;

  /** Safari / iOS / iPadOS ignore a PDF "#page=" fragment: the Reader then says so instead of pretending the page was reached. */
  function pageJumpSupported(global_) {
    const nav = global_ && global_.navigator;
    const ua = (nav && nav.userAgent) || "";
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && !!nav && nav.maxTouchPoints > 1);
    const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
    return !(ios || safari);
  }

  function el(doc, tag, attrs, text) {
    const n = doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (Array.isArray(text)) for (const c of text) n.appendChild(c);
    else if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function mount(host) {
    const doc = host.doc;
    let layer = null;
    let handle = null;
    let token = 0; // every open / replace bumps it: a late answer for a previous view never paints
    let st = null; // {spec, result, plan, page, loaded, trigger}

    const isOpen = () => !!(handle && !handle.closed && layer);

    // ------------------------------------------------------------------ keyboard model of the embedded PDF
    // The PDF frame is VISUAL-ONLY for the app's keyboard: a native PDF viewer swallows Tab / Escape once it holds focus and the parent
    // cannot observe or trap that. So the frame is out of the tab order (tabindex -1), and any focus it receives (a click into the page)
    // is handed straight back to the Reader. The Reader's own Previous / Next / cited-page controls navigate; "Ouvrir dans un onglet"
    // is the way to full native PDF keyboard interaction.
    let lastInside = null;
    let unguard = null;

    function reclaim() {
      if (!isOpen()) return;
      const frame = layer.querySelector("#hq-carnet-reader-frame");
      if (!frame || doc.activeElement !== frame) return;
      const back = lastInside && lastInside.isConnected && layer.contains(lastInside) && lastInside !== frame ? lastInside : layer.querySelector("#btn-carnet-reader-close");
      (back || layer).focus({ preventScroll: true });
    }

    function guard() {
      const view = doc.defaultView;
      const onFocus = (ev) => {
        if (layer && ev.target && ev.target.id !== "hq-carnet-reader-frame" && layer.contains(ev.target)) lastInside = ev.target;
      };
      const onBlur = () => view.setTimeout(reclaim, 0); // the window blurs when focus enters a frame
      const onFrame = (ev) => {
        if (ev.target && ev.target.id === "hq-carnet-reader-frame") reclaim();
      };
      layer.addEventListener("focusin", onFocus);
      layer.addEventListener("focus", onFrame, true);
      view.addEventListener("blur", onBlur);
      unguard = () => {
        view.removeEventListener("blur", onBlur);
        if (layer) {
          layer.removeEventListener("focusin", onFocus);
          layer.removeEventListener("focus", onFrame, true);
        }
        lastInside = null;
        unguard = null;
      };
    }

    function btn(id, text, extra) {
      const b = el(doc, "button", Object.assign({ type: "button", id, class: "carnet-small" }, extra || {}), text);
      return b;
    }

    // ------------------------------------------------------------------ batched resolution (identities only)

    const known = new Map(); // answers already read in THIS Reader session (memory only; cleared on every fresh open, never stored)

    async function resolveAll(entries) {
      const unique = R.uniqueEntries(entries);
      const byKey = new Map();
      const todo = [];
      for (const e of unique) {
        const k = R.entryKey(e);
        if (known.has(k)) byKey.set(k, known.get(k));
        else todo.push(e);
      }
      for (const body of R.batchBodies(todo)) {
        let res = null;
        try {
          res = await host.api.post(body);
        } catch (e) {
          res = null; // this body only: the other bodies and the cards already resolved are kept
        }
        const rows = R.resultsFor(body.entries, res);
        body.entries.forEach((e, i) => {
          const k = R.entryKey(e);
          byKey.set(k, rows[i]);
          if (res && rows[i].reason !== "Réponse inattendue") known.set(k, rows[i]);
        });
      }
      return byKey;
    }

    // ------------------------------------------------------------------ the page the Reader was opened from (current page only)

    function pageBlocks(origin) {
      if (!origin || !origin.pageId || typeof host.page !== "function") return null;
      const pg = host.page();
      return pg && pg.id === origin.pageId && Array.isArray(pg.blocks) ? pg.blocks : null;
    }

    function pageCitations(blocks) {
      const out = [];
      for (const b of blocks) {
        if (!b || typeof b.id !== "string" || !Array.isArray(b.marks)) continue;
        for (const m of b.marks) {
          if (m && m.type === "citation" && m.cite && typeof m.cite.src === "string") out.push({ blockId: b.id, cite: m.cite });
        }
      }
      return out;
    }

    /** Exact rule: a portal block of kind "source" with the SAME edition id, on the origin page. No fuzzy match, nothing created. */
    function sourcePortals(blocks, sourceId) {
      return blocks.filter((b) => b && b.type === "portal" && b.portal && b.portal.ref && b.portal.ref.kind === "source" && b.portal.ref.id === sourceId && typeof b.id === "string").map((b) => b.id);
    }

    function gotoBlock(origin, blockId) {
      const pageId = origin.pageId;
      close(false);
      host.goto(pageId, blockId);
    }

    // ------------------------------------------------------------------ viewer

    function viewerBox(box, model) {
      box.textContent = "";
      const plan = st.plan;
      if (plan.mode === "none") {
        box.appendChild(el(doc, "p", { class: "hint carnet-reader-noviewer", id: "hq-carnet-reader-noviewer" }, plan.why || model.file.text));
        return;
      }
      if (plan.mode === "explicit" && !st.loaded) {
        box.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-reader-explicit-why" }, plan.why));
        const go = btn("btn-carnet-reader-open-current", plan.action);
        go.addEventListener("click", () => {
          st.loaded = true;
          viewerBox(box, model);
          const f = box.querySelector("#hq-carnet-reader-viewer-label"); // never the frame itself: an embedded viewer swallows Escape and Tab
          if (f) f.focus({ preventScroll: true });
        });
        box.appendChild(go);
        return;
      }
      if (plan.label) box.appendChild(el(doc, "p", { class: "carnet-reader-viewer-label", id: "hq-carnet-reader-viewer-label", role: "status", tabindex: "-1" }, plan.label));
      const url = R.viewerUrl(plan.route, st.page);
      const info = el(doc, "p", { class: "hint", id: "hq-carnet-reader-page", role: "status", "aria-live": "polite" }, st.page ? MSG.pdfPage + " " + st.page : "Début du document");
      const prev = btn("btn-carnet-reader-prev", "◀ Page précédente", { "aria-label": "Page PDF précédente" });
      const next = btn("btn-carnet-reader-next", "Page suivante ▶", { "aria-label": "Page PDF suivante" });
      const nav = [prev, next];
      const cited = plan.page;
      if (cited && st.page !== cited) {
        const back = btn("btn-carnet-reader-cited", "Page citée (" + cited + ")", { "aria-label": "Revenir à la page PDF citée " + cited });
        back.addEventListener("click", () => step(box, model, cited));
        nav.push(back);
      }
      prev.addEventListener("click", () => step(box, model, R.stepPage(st.page, -1)));
      next.addEventListener("click", () => step(box, model, R.stepPage(st.page, 1)));
      box.appendChild(el(doc, "div", { class: "carnet-panel-row carnet-reader-bar" }, nav));
      box.appendChild(info);
      if (st.page && !(typeof host.pageJump === "function" ? host.pageJump() : pageJumpSupported(global))) box.appendChild(el(doc, "p", { class: "hint carnet-reader-warn", id: "hq-carnet-reader-nojump", role: "note" }, MSG.pageJumpUnavailable));
      const err = el(doc, "p", { class: "carnet-reader-warn", id: "hq-carnet-reader-autherr", role: "alert", hidden: true }, MSG.authError);
      const frame = el(doc, "iframe", { id: "hq-carnet-reader-frame", class: "carnet-src-frame carnet-reader-frame", title: "PDF : " + model.title, src: url, referrerpolicy: "no-referrer", tabindex: "-1" });
      frame.addEventListener("load", () => {
        try {
          const d = frame.contentDocument; // same-origin: an error page (401 / 403 / 404) is not a PDF document
          const type = d && d.contentType;
          if (type === "application/json" && R.isVerifiedRoute(plan.route)) {
            // the server refused to serve the sealed file; its error CODE decides the wording (changed / gone / cannot verify / too large /
            // unavailable / access) — never "changed" by default. The frame is hidden and no "identique" banner is left standing.
            const refusal = R.verifiedRefusal(R.refusalCode(d.body ? d.body.textContent : ""));
            err.textContent = refusal.text;
            err.hidden = false;
            frame.hidden = true;
            const banner = layer && layer.querySelector("#hq-carnet-reader-banner");
            if (banner) {
              banner.textContent = refusal.text;
              banner.setAttribute("data-state", refusal.key);
            }
          } else if (type && type !== "application/pdf" && type !== "text/html") err.hidden = false;
        } catch (e) {
          /* cross-origin / sandboxed PDF viewer: nothing to read, the file is assumed fine */
        }
      });
      box.appendChild(err);
      box.appendChild(frame);
      box.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [el(doc, "a", { id: "btn-carnet-reader-tab", class: "carnet-small", href: url, target: "_blank", rel: "noopener noreferrer" }, MSG.openTab)]));
    }

    function step(box, model, page) {
      st.page = page;
      viewerBox(box, model); // a FRESH iframe per navigation: the page is requested again, never assumed reached
      const focus = box.querySelector("#btn-carnet-reader-next");
      if (focus) focus.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------------ body

    function paint(body, model) {
      body.textContent = "";
      body.appendChild(el(doc, "h3", { class: "carnet-reader-name", id: "hq-carnet-reader-name" }, model.title));
      if (model.reason) body.appendChild(el(doc, "p", { class: "carnet-src-warn", id: "hq-carnet-reader-reason", role: "alert" }, model.reason));
      if (model.verified) {
        const v = el(doc, "p", { class: "carnet-src-verified", id: "hq-carnet-reader-verified", "data-ok": String(model.verified.ok) }, (model.verified.ok ? "✓ " : "○ ") + model.verified.text + (model.verified.note ? " — " + model.verified.note : ""));
        body.appendChild(v);
      }
      for (const l of model.lines) body.appendChild(el(doc, "p", { class: "carnet-reader-line", id: "hq-carnet-reader-line-" + l.key }, l.label + " : " + l.text));
      if (model.provenance) body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-reader-provenance" }, model.provenance.heading + " : " + model.provenance.text));
      const stat = el(doc, "div", { class: "carnet-reader-status", id: "hq-carnet-reader-status" });
      stat.appendChild(el(doc, "p", { class: "carnet-reader-src", id: "hq-carnet-reader-source-state", "data-state": model.source.key }, "Source : " + model.source.text));
      stat.appendChild(el(doc, "p", { class: "carnet-reader-file", id: "hq-carnet-reader-file-state", "data-state": model.file.key }, "Fichier : " + model.file.text));
      body.appendChild(stat);
      if (model.banner) body.appendChild(el(doc, "p", { class: "carnet-reader-banner", id: "hq-carnet-reader-banner", "data-state": model.banner.key, role: "status" }, model.banner.text));
      if (model.rows.length) {
        const table = el(doc, "table", { class: "carnet-reader-table", id: "hq-carnet-reader-table" });
        table.appendChild(el(doc, "caption", { class: "hint" }, "Métadonnées : ce qui était enregistré, et la source actuelle"));
        const head = el(doc, "tr");
        for (const h of ["", model.hasCaptured ? model.capturedHeading : "", model.currentHeading, ""]) head.appendChild(el(doc, "th", { scope: "col" }, h));
        table.appendChild(head);
        for (const r of model.rows) {
          const tr = el(doc, "tr", { "data-field": r.field, "data-differs": String(r.differs) });
          tr.appendChild(el(doc, "th", { scope: "row" }, r.label));
          tr.appendChild(el(doc, "td", { class: "carnet-reader-cap" }, r.captured));
          tr.appendChild(el(doc, "td", { class: "carnet-reader-cur" }, r.current));
          tr.appendChild(el(doc, "td", { class: "carnet-reader-flag" }, model.hasCaptured ? (r.differs ? MSG.differs : MSG.same) : ""));
          table.appendChild(tr);
        }
        body.appendChild(table);
      }
      const origin = st.spec.origin || null;
      const blocks = pageBlocks(origin);
      const actions = el(doc, "div", { class: "carnet-panel-row carnet-reader-actions", id: "hq-carnet-reader-actions" });
      if (origin && origin.pageId && origin.blockId && (origin.kind === "citation" || origin.kind === "portal")) {
        const back = btn("btn-carnet-reader-back", origin.kind === "portal" ? MSG.backToPortal : MSG.backToCitation);
        back.addEventListener("click", () => gotoBlock(origin, origin.blockId));
        actions.appendChild(back);
      }
      if (blocks && origin.kind !== "portal") {
        const portals = sourcePortals(blocks, st.spec.sourceId);
        portals.forEach((blockId, i) => {
          const b = btn("btn-carnet-reader-portal" + (portals.length > 1 ? "-" + (i + 1) : ""), MSG.seePortal + (portals.length > 1 ? " (" + (i + 1) + "/" + portals.length + ")" : ""));
          b.addEventListener("click", () => gotoBlock(origin, blockId));
          actions.appendChild(b);
        });
      }
      if (actions.childNodes.length) body.appendChild(actions);
      const viewer = el(doc, "div", { class: "carnet-reader-viewer", id: "hq-carnet-reader-viewer" });
      body.appendChild(viewer);
      viewerBox(viewer, model);
      if (blocks) citationList(body, origin, blocks);
    }

    // ------------------------------------------------------------------ "Citations de cette page" (one batched, bounded request)

    function citationList(body, origin, blocks) {
      const all = pageCitations(blocks);
      if (!all.length) return;
      const shown = all.slice(0, LIST_MAX);
      const sec = el(doc, "section", { class: "carnet-reader-cites", id: "hq-carnet-reader-cites", "aria-labelledby": "hq-carnet-reader-cites-h" });
      sec.appendChild(el(doc, "h3", { id: "hq-carnet-reader-cites-h" }, MSG.citationsHere + " (" + all.length + ")"));
      if (all.length > LIST_MAX) sec.appendChild(el(doc, "p", { class: "hint" }, "Les " + LIST_MAX + " premières citations sont listées."));
      const list = el(doc, "ul", { class: "carnet-reader-cite-list" });
      const items = shown.map((c) => {
        const li = el(doc, "li", { class: "carnet-reader-cite", "data-block": c.blockId, "data-src": c.cite.src });
        const text = (c.cite.snap && c.cite.snap.title ? c.cite.snap.title : c.cite.src) + (c.cite.loc && c.cite.loc.text ? " · " + R.locatorText(c.cite.loc) : "") + (c.cite.pdf ? " · " + MSG.pdfPage + " " + c.cite.pdf : "");
        li.appendChild(el(doc, "span", { class: "carnet-reader-cite-text" }, text));
        const state = el(doc, "span", { class: "hint carnet-reader-cite-state" }, MSG.loading);
        li.appendChild(state);
        const read = btn("", "Lire", { "aria-label": "Lire cette citation : " + text, class: "carnet-small carnet-reader-cite-read" });
        read.addEventListener("click", () => replace({ sourceId: c.cite.src, citation: c.cite, origin: { kind: "citation", pageId: origin.pageId, blockId: c.blockId } }));
        const go = btn("", "Aller au bloc", { "aria-label": "Aller au bloc de cette citation : " + text, class: "carnet-small carnet-reader-cite-goto" });
        go.addEventListener("click", () => gotoBlock(origin, c.blockId));
        li.appendChild(read);
        li.appendChild(go);
        list.appendChild(li);
        return { c, state, entry: R.entryFor({ sourceId: c.cite.src, citation: c.cite }) };
      });
      sec.appendChild(list);
      body.appendChild(sec);
      const mine = token;
      resolveAll(items.map((i) => i.entry).filter(Boolean)).then((byKey) => {
        if (mine !== token || !isOpen()) return;
        for (const it of items) {
          const row = it.entry ? byKey.get(R.entryKey(it.entry)) : null;
          if (!row) {
            it.state.textContent = MSG.failed;
            continue;
          }
          const m = R.cardModel(row);
          it.state.textContent = m.source.text + " · " + m.file.text;
          it.state.setAttribute("data-state", m.source.key);
        }
      });
    }

    // ------------------------------------------------------------------ open / replace / close

    function buildLayer() {
      const l = el(doc, "div", { id: "hq-carnet-reader", class: "carnet-reader", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-reader-title" });
      const head = el(doc, "div", { class: "carnet-src-head" });
      head.appendChild(el(doc, "h2", { class: "carnet-src-title", id: "hq-carnet-reader-title" }, MSG.title));
      const x = btn("btn-carnet-reader-close", "Fermer", { "aria-label": MSG.close });
      x.addEventListener("click", () => close(true));
      head.appendChild(x);
      l.appendChild(head);
      l.appendChild(el(doc, "div", { class: "carnet-reader-body", id: "hq-carnet-reader-body", "aria-busy": "true" }));
      return l;
    }

    async function load(spec) {
      const mine = ++token;
      const body = layer.querySelector("#hq-carnet-reader-body");
      body.textContent = "";
      body.setAttribute("aria-busy", "true");
      body.appendChild(el(doc, "p", { class: "hint", role: "status" }, MSG.loading));
      const entry = R.entryFor(spec);
      let result = null;
      if (entry) {
        const key = R.entryKey(entry);
        const got = await resolveAll([entry]);
        result = got.get(key) || null;
        if (result && result.reason === "Réponse inattendue") result = R.offlineResult(spec); // the answer was unusable: show what was stored
      }
      if (mine !== token || !isOpen()) return;
      if (!result) result = R.offlineResult(spec);
      st = { spec, result, plan: R.viewerPlan(result), page: R.viewerPlan(result).page, loaded: false };
      body.setAttribute("aria-busy", "false");
      paint(body, R.cardModel(result));
      const x = layer.querySelector("#btn-carnet-reader-close");
      if (x && !layer.contains(doc.activeElement)) x.focus({ preventScroll: true });
    }

    /** Opens the Reader for ONE piece of evidence. ``spec``: {sourceId, citation?, context?, origin?, trigger?}. Replaces any open Reader. */
    function open(spec) {
      if (!spec || typeof spec.sourceId !== "string") return false;
      let trigger = spec.trigger || (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null);
      if (isOpen()) {
        const prev = handle;
        handle = null;
        token++;
        if (prev.trigger && !spec.trigger) trigger = prev.trigger;
        if (unguard) unguard();
        prev.close(false);
      }
      known.clear();
      layer = buildLayer();
      guard();
      st = { spec, result: null, plan: null, page: null, loaded: false };
      handle = M.open(doc, layer, { trigger, initial: layer.querySelector("#btn-carnet-reader-close"), mount: (n) => host.root().appendChild(n), onEscape: () => close(true) });
      load(spec);
      return true;
    }

    /** A different evidence inside the SAME Reader (the "Citations de cette page" list): same modal, same opener, never nested. */
    function replace(spec) {
      if (!isOpen()) return open(spec);
      load(spec);
      const x = layer.querySelector("#btn-carnet-reader-close");
      if (x) x.focus({ preventScroll: true });
      return true;
    }

    /** Closes the Reader. ``refocus`` returns focus to the exact opener; the result tells whether it really took focus. */
    function close(refocus) {
      if (!handle) return false;
      const h = handle;
      handle = null;
      token++;
      if (unguard) unguard();
      const ok = h.close(!!refocus);
      layer = null;
      st = null;
      return ok;
    }

    return { open, replace, close, isOpen, state: () => (st ? { sourceId: st.spec.sourceId, page: st.page, loaded: st.loaded, mode: st.plan && st.plan.mode } : null) };
  }

  return { mount, LIST_MAX };
});
