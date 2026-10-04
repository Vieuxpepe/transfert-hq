/* Transfert HQ — Carnet: ONE shared modal / focus-containment utility (no network, no storage, no clock).
 *
 * Used by every Carnet dialog (portal picker / inspector, Sources dialog, Reader). Behaviour, per document:
 *   - a stack of open modals; only the TOP one is active (Tab / Shift+Tab wrap inside it, focus cannot move outside it);
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

  const FOCUSABLE = "button, input, select, textarea, a[href], [tabindex]";
  const stacks = new WeakMap(); // document -> {list: handle[], onFocusIn}

  function focusables(node) {
    return Array.prototype.filter.call(node.querySelectorAll(FOCUSABLE), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
  }

  function stackOf(doc) {
    let s = stacks.get(doc);
    if (!s) {
      s = { list: [], onFocusIn: null };
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

  /**
   * Opens ``node`` as the active modal. ``opts``: trigger (the control to return focus to), initial (first focus target),
   * mount(node) (attaches the node; default: the caller already attached it), onEscape(ev), keep (do not remove the node on close).
   * Returns the handle {node, trigger, close(refocus), focus()}.
   */
  function open(doc, node, opts) {
    const o = opts || {};
    const s = stackOf(doc);
    node.setAttribute("tabindex", "-1");
    const h = { node, trigger: o.trigger || null, initial: o.initial || null, keep: !!o.keep, onEscape: typeof o.onEscape === "function" ? o.onEscape : null, closed: false, onKey: null, doc };
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
        last.focus({ preventScroll: true });
      } else if (!ev.shiftKey && (act === last || out)) {
        ev.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    h.close = (refocus) => close(h, refocus);
    h.focus = () => focusInside(h);
    node.addEventListener("keydown", h.onKey);
    if (!s.onFocusIn) {
      s.onFocusIn = (ev) => {
        const t = top(doc);
        if (t && !t.node.contains(ev.target)) focusInside(t); // focus can never move into the editor / library behind an open modal
      };
      doc.addEventListener("focusin", s.onFocusIn, true);
    }
    s.list.push(h);
    if (typeof o.mount === "function") o.mount(node);
    focusInside(h);
    return h;
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
    if (!s.list.length && s.onFocusIn) {
      doc.removeEventListener("focusin", s.onFocusIn, true);
      s.onFocusIn = null;
    }
    if (!h.keep) h.node.remove();
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

  return { open, close, top, depth, focusables };
});
