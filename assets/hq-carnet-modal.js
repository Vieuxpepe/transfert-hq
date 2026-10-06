/* Transfert HQ — Carnet: ONE shared modal / focus-containment utility (no network, no storage, no clock).
 *
 * Used by the Carnet dialogs (portal picker / inspector, Sources dialog, Reader, workspaces, Review Pack, Ask, History, Cockpit).
 * Behaviour, per document:
 *   - a stack of open modals; only the TOP one is active (Tab / Shift+Tab wrap inside it, focus cannot move outside it);
 *   - Phase 13: a modal opened over another SUSPENDS it (inert, aria-hidden, data-carnet-suspended, painted hidden but kept in the DOM so its
 *     view / selection / scroll survive); closing the child resumes the parent untouched. There is never more than one ACTIVE surface, so the
 *     z-index of a parent can no longer hide a child. ``layer`` names the surface class (sheet | workspace | reader | nested), see the CSS scale.
 *   - Escape on the top modal calls its ``onEscape`` (default: nothing — the owner decides what closing means);
 *   - ``close(refocus)`` returns focus to the exact trigger, and reports true ONLY if that trigger really took focus
 *     (a hidden / detached opener cannot), so the caller can fall back.
 *   - closing a modal that is not on top never disturbs the one above it; closing the top one re-activates the one below.
 * Plain ES2020, UMD (browser global HqCarnetModal / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetModal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FOCUSABLE = "button, input, select, textarea, summary, a[href], [tabindex]";
  const stacks = new WeakMap(); // document -> {list: handle[], onFocusIn}

  function focusables(node) {
    return Array.prototype.filter.call(node.querySelectorAll(FOCUSABLE), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
  }

  function stackOf(doc) {
    let s = stacks.get(doc);
    if (!s) {
      s = { list: [], onFocusIn: null, onDocKey: null, onPointer: null, mo: null, kbd: false };
      stacks.set(doc, s);
    }
    return s;
  }

  function top(doc) {
    const s = stacks.get(doc);
    return s && s.list.length ? s.list[s.list.length - 1] : null;
  }

  function focusInside(h) {
    const list = focusables(h.node);
    (h.initial && h.node.contains(h.initial) ? h.initial : list[0] || h.node).focus({ preventScroll: true });
  }


  // Phase 14: a re-rendered control must not drop keyboard focus to <body> inside an open modal. The identity of the focused control
  // (id, else tag + data-* attributes) is remembered; when focus is lost to <body> in keyboard modality the equivalent control is refocused.
  function sigOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return "#" + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id);
    let q = el.tagName.toLowerCase();
    let n = 0;
    for (const a of Array.prototype.slice.call(el.attributes)) {
      if (/^data-/.test(a.name) && a.name !== "data-carnet-pulse") {
        q += "[" + a.name + '="' + String(a.value).replace(/["\\]/g, "\\$&") + '"]';
        n++;
      }
    }
    return n ? q : null;
  }

  function rescue(doc) {
    const s = stacks.get(doc);
    const t = top(doc);
    if (!s || !t || !s.kbd) return;
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== doc.documentElement) return; // focus is somewhere: nothing was lost
    let target = null;
    if (t.lastSig) {
      try { target = t.node.querySelector(t.lastSig); } catch (_) { target = null; }
      if (target && focusables(t.node).indexOf(target) < 0) target = null;
    }
    (target || focusables(t.node)[0] || t.node).focus({ preventScroll: true });
  }

  function watch(doc) {
    const s = stacks.get(doc);
    if (!s) return;
    if (s.mo) { s.mo.disconnect(); s.mo = null; }
    const t = top(doc);
    if (!t || typeof MutationObserver !== "function") return;
    s.mo = new MutationObserver(() => rescue(doc));
    s.mo.observe(t.node, { childList: true, subtree: true });
  }

  /**
   * Opens ``node`` as the active modal. ``opts``: trigger (the control to return focus to), initial (first focus target),
   * mount(node) (attaches the node; default: the caller already attached it), onEscape(ev), keep (do not remove the node on close).
   * Returns the handle {node, trigger, close(refocus), focus()}.
   */
  function open(doc, node, opts) {
    const o = opts || {};
    const s = stackOf(doc);
    node.setAttribute("tabindex", "-1");
    clearSuspension(node); // a reused (keep:true) node must never carry a stale suspension from an earlier life
    const h = { node, trigger: o.trigger || null, initial: o.initial || null, keep: !!o.keep, onEscape: typeof o.onEscape === "function" ? o.onEscape : null, closed: false, onKey: null, doc, layer: o.layer || null, suspended: false };
    if (!node.hasAttribute("role")) node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    if (o.labelledby && !node.hasAttribute("aria-labelledby")) node.setAttribute("aria-labelledby", o.labelledby);
    else if (o.label && !node.hasAttribute("aria-label") && !node.hasAttribute("aria-labelledby")) node.setAttribute("aria-label", o.label);
    if (h.layer) node.setAttribute("data-carnet-layer", h.layer);
    h.onKey = (ev) => {
      if (top(doc) !== h) return;
      if (ev.key === "Escape") {
        if (h.onEscape) {
          ev.preventDefault();
          ev.stopPropagation();
          h.onEscape(ev);
        }
        return;
      }
      if (ev.key !== "Tab") return;
      const list = focusables(node);
      if (!list.length) {
        ev.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const act = doc.activeElement;
      const out = !node.contains(act);
      if (ev.shiftKey && (act === first || act === node || out)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (act === last || out)) {
        ev.preventDefault();
        first.focus();
      }
    };
    h.close = (refocus) => close(h, refocus);
    h.focus = () => focusInside(h);
    node.addEventListener("keydown", h.onKey);
    if (!s.onFocusIn) {
      s.onFocusIn = (ev) => {
        const t = top(doc);
        if (!t) return;
        if (!t.node.contains(ev.target)) focusInside(t); // focus can never move into the editor / library behind an open modal
        else t.lastSig = sigOf(ev.target);
      };
      doc.addEventListener("focusin", s.onFocusIn, true);
      // keyboard modality (the user last pressed a key, not a pointer) + Escape that reaches the document because focus sits on <body>
      s.onDocKey = (ev) => {
        s.kbd = true;
        const t = top(doc);
        if (!t || ev.key !== "Escape" || ev.defaultPrevented || t.node.contains(ev.target)) return;
        if (t.onEscape) {
          ev.preventDefault();
          t.onEscape(ev);
        }
      };
      s.onPointer = () => { s.kbd = false; };
      doc.addEventListener("keydown", s.onDocKey, false);
      doc.addEventListener("pointerdown", s.onPointer, true);
    }
    const below = top(doc);
    if (below && o.suspend !== false) suspend(below);
    s.list.push(h);
    if (typeof o.mount === "function") o.mount(node);
    focusInside(h);
    h.lastSig = sigOf(doc.activeElement);
    watch(doc);
    return h;
  }

  function suspend(h) {
    if (h.suspended) return;
    h.suspended = true;
    h.node.setAttribute("data-carnet-suspended", "");
    h.node.setAttribute("aria-hidden", "true");
    h.node.inert = true;
    h.node.setAttribute("inert", "");
  }

  function clearSuspension(node) {
    node.removeAttribute("data-carnet-suspended");
    node.removeAttribute("aria-hidden");
    node.inert = false;
    node.removeAttribute("inert");
  }

  function resume(h) {
    if (!h.suspended) return;
    h.suspended = false;
    clearSuspension(h.node);
  }

  /** Closes one modal. Returns true only when ``refocus`` was asked for AND the exact trigger took focus. */
  function close(h, refocus) {
    if (!h || h.closed) return false;
    h.closed = true;
    const doc = h.doc;
    const s = stackOf(doc);
    const wasTop = top(doc) === h;
    const i = s.list.indexOf(h);
    if (i >= 0) s.list.splice(i, 1);
    h.node.removeEventListener("keydown", h.onKey);
    if (h.suspended) resume(h); // closed while suspended (not on top): leave a kept node reusable, without activating or focusing it
    if (!s.list.length && s.onFocusIn) {
      doc.removeEventListener("focusin", s.onFocusIn, true);
      s.onFocusIn = null;
      doc.removeEventListener("keydown", s.onDocKey, false);
      doc.removeEventListener("pointerdown", s.onPointer, true);
      s.onDocKey = s.onPointer = null;
    }
    if (!s.list.length && s.mo) { s.mo.disconnect(); s.mo = null; }
    if (wasTop) {
      const t = top(doc);
      if (t) resume(t); // the parent is active again BEFORE focus is returned (an inert node cannot take focus)
    }
    if (!h.keep) h.node.remove();
    if (wasTop) watch(doc);
    if (!refocus) {
      if (wasTop) {
        const t = top(doc);
        if (t && !t.node.contains(doc.activeElement)) focusInside(t); // the modal below becomes active again with focus inside it
      }
      return false;
    }
    const trigger = h.trigger;
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    const ok = !!(trigger && doc.activeElement === trigger);
    if (!ok && wasTop) {
      const t = top(doc);
      if (t && !t.node.contains(doc.activeElement)) focusInside(t);
    }
    return ok;
  }

  /** Number of modals open in this document (tests / diagnostics). */
  function depth(doc) {
    const s = stacks.get(doc);
    return s ? s.list.length : 0;
  }

  /** The open modals, bottom to top (tests / diagnostics). */
  function stack(doc) {
    const s = stacks.get(doc);
    return s ? s.list.map((h) => ({ node: h.node, layer: h.layer, suspended: h.suspended, handle: h })) : [];
  }

  return { open, close, top, depth, stack, focusables };
});
