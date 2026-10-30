/* Transfert HQ — Carnet UX pass: direct manipulation of ONE selected image (resize handles + block drag handle).
 *
 * This module only turns pointer gestures into ONE logical host call at the END of a gesture:
 *   host.commitWidth(token, width)   -> a normal Carnet edit (draft + debounced autosave + revision checks)
 *   host.commitMove(token, toIndex)  -> the same, reordering whole blocks (ids are preserved by the host)
 * During a gesture nothing is persisted and nothing is sent: the preview is local CSS on the figure that is
 * thrown away when the gesture ends (the host then re-renders from the real state). No x/y position exists
 * anywhere: the only persisted values are the image `width` (30..100, 5% steps) and its block position.
 *
 * Stale protection: host.token() captures {page, revision, generation, line element}; host.valid(token) is checked on
 * release. If the page, revision, editor generation or the DOM line changed meanwhile, the gesture is DISCARDED with a
 * status message and never applied to the newer state (no automatic retry).
 *
 * Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetImageUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STEP = 5;
  const MIN = 30;
  const MAX = 100;

  /** Pure: width percent from a pointer travel. Snapped to STEP, clamped, never NaN. `factor` 2 when both sides move (centered). */
  function widthFromDrag(startWidth, dxPx, containerPx, factor) {
    if (!(containerPx > 0) || !isFinite(dxPx) || !isFinite(startWidth)) return clamp(startWidth);
    const raw = startWidth + ((dxPx * (factor || 1)) / containerPx) * 100;
    return clamp(Math.round(raw / STEP) * STEP);
  }

  function clamp(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return MAX;
    return Math.max(MIN, Math.min(MAX, n));
  }

  /** Pure: index of the slot (0..n) a vertical pointer position falls in, given the block midpoints. */
  function slotFromY(y, mids) {
    let slot = 0;
    for (let i = 0; i < mids.length; i += 1) if (y > mids[i]) slot = i + 1;
    return slot;
  }

  /** Pure: final index of the moved block once it is taken out of `from` and put into slot `slot` (0..n). */
  function targetIndex(from, slot) {
    return slot > from ? slot - 1 : slot;
  }

  function mount(host) {
    const doc = host.doc;
    const S = { gesture: null, handles: null, layout: null };

    function el(tag, attrs, text) {
      const n = doc.createElement(tag);
      for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
      if (text) n.textContent = text;
      return n;
    }

    function say(text, isError) {
      if (typeof host.status === "function") host.status(text, !!isError);
    }

    function clearHandles() {
      if (S.handles) {
        for (const n of S.handles) if (n.parentNode) n.parentNode.removeChild(n);
      }
      S.handles = null;
    }

    /**
     * Attach the handles to the selected figure (and only to it). Idempotent for the same layout.
     * Only handles whose edge actually follows the pointer exist: the alignment anchors one edge, so
     * "inline" (left) -> right handle, "right" -> left handle, "center" -> both (symmetric, x2).
     */
    function decorate(lineEl, layout) {
      const want = layout === "right" ? "w" : layout === "center" ? "we" : "e";
      if (S.handles && S.layout === want && S.handles.every((n) => lineEl && lineEl.contains(n))) return;
      clearHandles();
      const fig = lineEl ? lineEl.querySelector("figure") : null;
      if (!fig) return;
      S.layout = want;
      const drag = el("button", { type: "button", class: "carnet-handle carnet-handle-move", "data-carnet-handle": "move", contenteditable: "false",
        "aria-label": "Déplacer l'image (glisser, ou flèches haut et bas)" });
      drag.appendChild(el("span", { class: "carnet-handle-glyph", "aria-hidden": "true" }, "⠿"));
      fig.appendChild(drag);
      S.handles = [drag];
      drag.addEventListener("pointerdown", (ev) => beginMove(ev, lineEl, drag));
      drag.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
        ev.preventDefault();
        host.nudge(ev.key === "ArrowUp" ? -1 : 1);
      });
      const size = (cls, kind, side) => {
        const h = el("span", { class: "carnet-handle carnet-handle-size " + cls, "data-carnet-handle": kind, contenteditable: "false", "aria-hidden": "true" });
        fig.appendChild(h);
        S.handles.push(h);
        h.addEventListener("pointerdown", (ev) => beginSize(ev, lineEl, h, side));
      };
      if (want.indexOf("w") >= 0) size("carnet-handle-sw", "size-w", -1);
      if (want.indexOf("e") >= 0) size("carnet-handle-se", "size-e", 1);
    }

    function listen(h, name, fn) {
      h.addEventListener(name, fn);
      return () => h.removeEventListener(name, fn);
    }

    function startGesture(ev, lineEl, handle, kind) {
      if (S.gesture || (ev.pointerType === "mouse" && ev.button !== 0)) return null;
      const token = host.token(lineEl);
      if (!token) return null;
      ev.preventDefault();
      ev.stopPropagation();
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* synthetic pointers may not be capturable: the document listeners below still work */
      }
      const g = { kind, token, lineEl, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, off: [], raf: 0, last: null, moved: false };
      S.gesture = g;
      const end = (e2, cancel) => finish(e2, cancel);
      g.off.push(listen(handle, "pointermove", (e2) => onMove(e2)));
      g.off.push(listen(handle, "pointerup", (e2) => end(e2, false)));
      g.off.push(listen(handle, "pointercancel", (e2) => end(e2, true)));
      g.off.push(listen(handle, "lostpointercapture", (e2) => (S.gesture === g ? end(e2, true) : undefined)));
      g.off.push(listen(doc, "keydown", (e2) => {
        if (e2.key === "Escape") end(e2, true);
      }));
      return g;
    }

    function beginSize(ev, lineEl, handle, side) {
      const g = startGesture(ev, lineEl, handle, "size");
      if (!g) return;
      const fig = lineEl.querySelector("figure");
      const box = lineEl.getBoundingClientRect();
      g.fig = fig;
      g.side = side;
      g.container = box.width;
      g.start = host.widthOf(g.token);
      g.factor = host.layoutOf(g.token) === "center" ? 2 : 1;
      g.value = g.start;
      lineEl.setAttribute("data-gesture", "size");
      say("Redimensionnement : " + g.start + " %");
    }

    function beginMove(ev, lineEl, handle) {
      const g = startGesture(ev, lineEl, handle, "move");
      if (!g) return;
      g.from = Array.prototype.indexOf.call(host.editor().children, lineEl);
      g.slot = g.from;
      g.indicator = el("div", { class: "carnet-drop-indicator", "aria-hidden": "true", contenteditable: "false" });
      lineEl.setAttribute("data-gesture", "move");
      say("Déplacement : relâcher pour déposer");
    }

    /** The ONE per-pointer calculation (sync): used by the frame callback AND, with the very last event, on release. */
    function compute(g, e2) {
      if (!e2) return;
      if (g.kind === "size") {
        g.value = widthFromDrag(g.start, (e2.clientX - g.x0) * g.side, g.container, g.factor);
        g.moved = g.moved || g.value !== g.start;
      } else {
        const kids = Array.prototype.filter.call(host.editor().children, (k) => k !== g.indicator);
        // 16C: the lift preview translates blocks; the slot is always computed on the UNtranslated layout.
        const mids = kids.map((k) => {
          const r = k.getBoundingClientRect();
          return r.top + r.height / 2 - (g.shift && g.shift.has(k) ? g.shift.get(k) : 0);
        });
        g.slot = slotFromY(e2.clientY, mids);
        g.moved = g.moved || Math.abs(e2.clientY - g.y0) > 4;
        g.kids = kids;
      }
    }

    function onMove(ev) {
      const g = S.gesture;
      if (!g || ev.pointerId !== g.pointerId) return;
      g.last = ev;
      if (g.raf) return;
      const run = () => {
        g.raf = 0;
        if (!g.last || S.gesture !== g) return;
        compute(g, g.last);
        if (g.kind === "size") g.fig.style.width = g.value + "%"; // local preview only
        else {
          showIndicator(g, g.kids);
          liftPreview(g);
        }
      };
      if (typeof host.raf === "function") g.raf = host.raf(run);
      else run();
    }

    function showIndicator(g, kids) {
      const ed = host.editor();
      if (!g.indicator.parentNode) ed.appendChild(g.indicator);
      const ref = g.slot >= kids.length ? kids[kids.length - 1] : kids[g.slot];
      const r = ref.getBoundingClientRect();
      const er = ed.getBoundingClientRect();
      const y = (g.slot >= kids.length ? r.bottom : r.top) - er.top + ed.scrollTop;
      g.indicator.style.top = Math.max(0, y) + "px";
    }

    function calm() {
      try {
        return !!(doc.defaultView && doc.defaultView.matchMedia && doc.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches);
      } catch (_) {
        return true;
      }
    }

    /** 16C: the moved block follows the pointer and the others part to show where it will land. Local CSS transforms only, thrown
     *  away by cleanup(); the drop is still decided by compute() on the untranslated layout. Reduced motion: indicator line only. */
    function liftPreview(g) {
      if (!g.kids || !g.last || calm() || !g.lineEl.style || !g.lineEl.style.setProperty) return;
      const ed = host.editor();
      if (!g.shift) {
        g.shift = new Map();
        if (ed && ed.classList) ed.classList.add("c16-lifting");
      }
      const dy = g.last.clientY - g.y0;
      g.lineEl.style.setProperty("--c16-dy", dy.toFixed(1) + "px");
      g.shift.set(g.lineEl, dy);
      const h = g.lineEl.offsetHeight || 0;
      const to = targetIndex(g.from, g.slot);
      g.kids.forEach((k, i) => {
        if (k === g.lineEl || !k.style || !k.style.setProperty) return;
        let want = 0;
        if (g.from < to && i > g.from && i <= to) want = -h;
        else if (g.from > to && i >= to && i < g.from) want = h;
        if ((g.shift.get(k) || 0) === want) return;
        if (k.classList) k.classList.add("c16-parting");
        k.style.setProperty("--c16-dy", want + "px");
        g.shift.set(k, want);
      });
    }

    function cleanup(g) {
      if (g.shift) {
        for (const k of g.shift.keys()) {
          if (k.style && k.style.removeProperty) k.style.removeProperty("--c16-dy");
          if (k.classList) k.classList.remove("c16-parting");
        }
        g.shift = null;
        const ed = host.editor();
        if (ed && ed.classList) ed.classList.remove("c16-lifting");
      }
      for (const f of g.off) f();
      if (g.raf && typeof host.cancelRaf === "function") host.cancelRaf(g.raf);
      if (g.indicator && g.indicator.parentNode) g.indicator.parentNode.removeChild(g.indicator);
      if (g.lineEl) g.lineEl.removeAttribute("data-gesture");
      S.gesture = null;
    }

    function finish(ev, cancel) {
      const g = S.gesture;
      if (!g || (ev && ev.pointerId != null && g.pointerId != null && ev.pointerId !== g.pointerId && ev.type !== "keydown")) return;
      if (g.raf && typeof host.cancelRaf === "function") {
        host.cancelRaf(g.raf);
        g.raf = 0;
      }
      // The release position is authoritative: never depend on whether the last animation frame ran.
      if (!cancel) compute(g, ev && ev.clientX != null ? ev : g.last);
      const value = g.value;
      const slot = g.slot;
      const moved = g.moved;
      const kind = g.kind;
      const token = g.token;
      const fig = g.fig;
      const start = g.start;
      const from = g.from;
      cleanup(g);
      if (kind === "size" && fig) fig.style.width = start + "%"; // the preview is discarded; the host re-renders the real state
      if (cancel) {
        say("Geste annulé");
        return;
      }
      if (!moved) return;
      if (!host.valid(token)) {
        say("Modification abandonnée : la page a changé pendant le geste", true);
        return;
      }
      if (kind === "size") host.commitWidth(token, value);
      else if (targetIndex(from, slot) !== from) host.commitMove(token, targetIndex(from, slot));
    }

    function abort() {
      const g = S.gesture;
      if (!g) return;
      const fig = g.fig;
      const start = g.start;
      cleanup(g);
      if (fig && start != null) fig.style.width = start + "%";
    }

    /** Block-level drag for a handle owned by someone else (the editor's block rail): same gesture code, any block. */
    function bindMove(handle, getLine) {
      handle.addEventListener("pointerdown", (ev) => {
        const lineEl = getLine();
        if (lineEl) beginMove(ev, lineEl, handle);
      });
    }

    return { decorate, clearHandles, abort, bindMove, active: () => !!S.gesture };
  }

  return { mount, widthFromDrag, slotFromY, targetIndex, clamp, STEP, MIN, MAX };
});
