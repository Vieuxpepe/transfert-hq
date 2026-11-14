/* Transfert HQ — Dessiner's floating action bubble: the few fields and buttons that matter for what is selected
 * (a line's length, a circle's radius, constraints, « Extruder », « Percer », a congé…), right next to it, so nothing
 * needs a scroll down to the panel. Enter applies the main action, Escape closes it. On a narrow stage it docks at the
 * bottom. The bubble is rebuilt only when the context changes (typed values survive redraws) and repositioned on every
 * draw. DOM built with createElement; placement is a pure helper exported for Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HqSketchFloat = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const GAP = 14, MARGIN = 8, DOCK_BELOW = 600, ARM_MS = 400;

  /** On a narrow stage the bubble is docked: at the bottom, or at the top when the selection sits in the lower half
   * (it never covers what the finger just touched). */
  function dockSide(anchor, stageH) {
    if (!anchor) return "bottom";
    return (anchor.y0 + anchor.y1) / 2 > stageH / 2 ? "top" : "bottom";
  }

  /** Where the bubble goes: above the selection when there is room, else below, else clamped inside the stage.
   * anchor {x0, y0, x1, y1} and the result are in stage pixels. Never covers the anchor when it can avoid it. */
  function place(anchor, size, stage) {
    const W = stage.w, H = stage.h, w = Math.min(size.w, W - 2 * MARGIN), h = size.h;
    if (!anchor) return { left: W - w - MARGIN, top: MARGIN, side: "corner" };
    const cx = (anchor.x0 + anchor.x1) / 2;
    const left = Math.max(MARGIN, Math.min(W - w - MARGIN, cx - w / 2));
    const above = anchor.y0 - GAP - h, below = anchor.y1 + GAP;
    if (above >= MARGIN) return { left, top: above, side: "above" };
    if (below + h <= H - MARGIN) return { left, top: below, side: "below" };
    // no room on either side: beside the selection if possible, else the stage's top edge
    const right = anchor.x1 + GAP, leftSide = anchor.x0 - GAP - w;
    const top = Math.max(MARGIN, Math.min(H - h - MARGIN, (anchor.y0 + anchor.y1) / 2 - h / 2));
    if (right + w <= W - MARGIN) return { left: right, top, side: "right" };
    if (leftSide >= MARGIN) return { left: leftSide, top, side: "left" };
    return { left, top: MARGIN, side: "top" };
  }

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids || []) if (kid) n.appendChild(kid);
    return n;
  }

  /**
   * mount(win, stage, handlers) → { show(spec, anchor), place(anchor), hide(), visible() }
   * spec: { sig, title, note?, fields: [{ key, label, type: "number"|"select", value, unit?, step?, min?, max?, options?, action? }],
   *         actions: [{ key, label, primary?, kind? }] }  — handlers.onAction(key, values), handlers.onClose()
   */
  function mount(win, stage, handlers) {
    const doc = win.document;
    const box = el(doc, "div", { class: "sk-bubble", role: "dialog", "aria-label": "Actions rapides", hidden: true });
    stage.appendChild(box);
    const S = { sig: null, dismissed: null, anchor: null, spec: null, shownAt: 0 };

    function values() {
      const out = {};
      box.querySelectorAll("[data-key]").forEach((f) => { out[f.dataset.key] = f.type === "checkbox" ? f.checked : f.value; });
      return out;
    }
    // a tap that selects something also sends a click a moment later, at the same spot: if the new bubble is there,
    // that click must not press one of its buttons
    function act(key, viaClick) {
      if (viaClick && Date.now() - S.shownAt < ARM_MS) return;
      if (handlers && handlers.onAction) handlers.onAction(key, values());
    }

    function build(spec) {
      box.replaceChildren();
      const head = el(doc, "div", { class: "sk-bubble-head" }, [
        el(doc, "strong", { text: spec.title }),
        el(doc, "button", { type: "button", class: "sk-bubble-x", "aria-label": "Fermer les actions rapides", text: "✕" }),
      ]);
      head.lastChild.addEventListener("click", () => { if (Date.now() - S.shownAt < ARM_MS) return; S.dismissed = S.sig; hide(); if (handlers && handlers.onClose) handlers.onClose(); });
      box.appendChild(head);
      const field = (f) => {
        let input;
        if (f.type === "select") {
          input = el(doc, "select", { "data-key": f.key, "aria-label": f.label || f.key });
          for (const [v, t] of f.options || []) input.appendChild(el(doc, "option", { value: v, text: t, selected: String(v) === String(f.value) }));
        } else if (f.type === "range") {
          input = el(doc, "input", { type: "range", min: f.min, max: f.max, step: f.step || "any", value: f.value, "data-key": f.key, "aria-label": f.label, class: "sk-bubble-range" });
        } else {
          input = el(doc, "input", { type: "number", inputmode: "decimal", step: f.step || "any", min: f.min, max: f.max, value: f.value, "data-key": f.key, "aria-label": f.label + (f.unit ? " (" + f.unit + ")" : "") });
        }
        return el(doc, "label", { class: "sk-bubble-field" }, [f.label ? el(doc, "span", { text: f.label }) : null, input, f.unit ? el(doc, "span", { class: "sk-bubble-unit", text: f.unit }) : null]);
      };
      const button = (a) => {
        const b = el(doc, "button", { type: "button", class: "sk-bubble-btn" + (a.primary ? " is-primary" : "") + (a.kind ? " is-" + a.kind : ""), "data-act-key": a.key, text: a.label, disabled: a.disabled });
        b.addEventListener("click", () => act(a.key, true));
        return b;
      };
      // each field sits on one line with the button it feeds (length → Appliquer, height → Extruder);
      // buttons that take no field (constraint chips…) share a last line
      const used = new Set(), order = [];
      for (const f of spec.fields || []) if (!order.includes(f.action || "")) order.push(f.action || "");
      for (const key of order) {
        const row = el(doc, "div", { class: "sk-bubble-row" });
        (spec.fields || []).filter((f) => (f.action || "") === key).forEach((f) => row.appendChild(field(f)));
        const a = (spec.actions || []).find((x) => x.key === key);
        if (a) { row.appendChild(button(a)); used.add(a.key); }
        box.appendChild(row);
      }
      const rest = (spec.actions || []).filter((a) => !used.has(a.key));
      if (rest.length) {
        const row = el(doc, "div", { class: "sk-bubble-row sk-bubble-chips" });
        rest.forEach((a) => row.appendChild(button(a)));
        box.appendChild(row);
      }
      if (spec.note) box.appendChild(el(doc, "p", { class: "sk-bubble-note", text: spec.note }));
    }

    // live fields: previews while typing, push / pull while dragging a slider
    box.addEventListener("input", (e) => {
      const key = e.target && e.target.dataset && e.target.dataset.key;
      const f = key && (S.spec.fields || []).find((x) => x.key === key);
      if (f && f.live && handlers && handlers.onInput) handlers.onInput(key, values());
    });
    box.addEventListener("change", (e) => {
      const key = e.target && e.target.dataset && e.target.dataset.key;
      const f = key && (S.spec.fields || []).find((x) => x.key === key);
      if (f && f.type === "range" && f.action) act(f.action); // releasing the slider applies
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); S.dismissed = S.sig; hide(); return; }
      if (e.key === "Enter" && e.target.matches("input,select")) {
        e.preventDefault();
        // the focused field's own action first (length → Appliquer, height → Extruder), else the primary one
        const own = (S.spec.fields || []).find((f) => f.key === e.target.dataset.key && f.action);
        const primary = (S.spec.actions || []).find((a) => a.primary && !a.disabled) || (S.spec.actions || [])[0];
        const key = own ? own.action : primary && primary.key;
        if (key) act(key);
      }
    });
    // the bubble's own pointer events never reach the canvas underneath
    for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick"]) box.addEventListener(t, (e) => e.stopPropagation());

    function position() {
      if (box.hidden) return;
      const r = stage.getBoundingClientRect();
      const docked = r.width < DOCK_BELOW && S.anchor;
      box.classList.toggle("is-docked", !!docked);
      if (docked) {
        box.style.left = ""; box.style.top = "";
        box.dataset.side = "dock-" + dockSide(S.anchor, r.height);
        return;
      }
      const p = place(S.anchor, { w: box.offsetWidth, h: box.offsetHeight }, { w: r.width, h: r.height });
      box.style.left = Math.round(p.left) + "px";
      box.style.top = Math.round(p.top) + "px";
      box.dataset.side = p.side;
    }
    function show(spec, anchor) {
      S.anchor = anchor || null;
      if (!spec) { hide(); return; }
      if (spec.sig === S.dismissed) { hide(); return; } // closed by the user: stays closed until the selection changes
      S.dismissed = null;
      if (spec.sig !== S.sig) { S.sig = spec.sig; S.spec = spec; build(spec); S.shownAt = Date.now(); }
      if (box.hidden) S.shownAt = Date.now();
      box.hidden = false;
      position();
    }
    function place2(anchor) { S.anchor = anchor || S.anchor; position(); }
    function hide() { box.hidden = true; }
    function focus(key) { const f = box.querySelector('[data-key="' + key + '"]'); if (f) { f.focus(); if (f.select) f.select(); return true; } return false; }
    function setValue(key, v) { const f = box.querySelector('[data-key="' + key + '"]'); if (f && f !== doc.activeElement) f.value = v; }
    return { show, place: place2, hide, focus, setValue, visible: () => !box.hidden, element: box, reset() { S.sig = null; S.dismissed = null; } };
  }

  /** Where the ring's labels go: an ellipse wide enough that neighbouring labels never overlap, its centre moved
   * just enough that every label stays inside the stage. lengths: label lengths in characters. */
  function ringLayout(lengths, at, stage) {
    const n = lengths.length, H = 19; // half a label's height (px)
    const half = lengths.map((l) => Math.min(110, 8 + 4.2 * l)); // half each label's width (px)
    const offsets = (rx, ry) => half.map((_, i) => { const t = 2 * Math.PI * i / n; return { x: rx * Math.sin(t), y: -ry * Math.cos(t) }; });
    const clash = (o) => o.some((p, i) => o.some((q, k) => k > i && Math.abs(p.x - q.x) < half[i] + half[k] + 4 && Math.abs(p.y - q.y) < 2 * H + 4));
    let ry = n <= 4 ? 60 : 60 + 8 * (n - 4), rx = ry * 1.25, o = offsets(rx, ry);
    for (let k = 0; k < 24 && clash(o); k++) { rx *= 1.12; ry *= 1.06; o = offsets(rx, ry); } // grow until the labels part
    const left = Math.max(...o.map((p, i) => half[i] - p.x)), right = Math.max(...o.map((p, i) => p.x + half[i]));
    const top = Math.max(...o.map((p) => H - p.y)), bottom = Math.max(...o.map((p) => p.y + H));
    const fit = (v, lo, hi, size) => (lo > size - hi ? (lo + size - hi) / 2 : Math.max(lo, Math.min(size - hi, v)));
    const cx = fit(at.x, left + 4, right + 4, stage.w), cy = fit(at.y, top + 4, bottom + 4, stage.h);
    return { cx, cy, rx, ry, half, items: o.map((p) => ({ x: cx + p.x, y: cy + p.y })) };
  }

  /** A ring of actions around a point (right click, long press): tap one to run it. Closes on Escape or a tap
   * elsewhere. items [{key, label}] (8 at most), at {x, y} in stage pixels. */
  function ring(win, stage, at, items, onPick) {
    const doc = win.document;
    const old = stage.querySelector(".sk-ring");
    if (old) old.remove();
    if (!items || !items.length) return null;
    const list = items.slice(0, 8);
    const r = stage.getBoundingClientRect();
    const lay = ringLayout(list.map((it) => String(it.label).length), at, { w: r.width, h: r.height });
    const box = el(doc, "div", { class: "sk-ring", role: "menu", "aria-label": "Actions" });
    const cx = lay.cx, cy = lay.cy;
    box.appendChild(el(doc, "span", { class: "sk-ring-hub", "aria-hidden": "true" }));
    box.firstChild.style.left = cx + "px"; box.firstChild.style.top = cy + "px";
    const opened = Date.now();
    list.forEach((it, i) => {
      const p = lay.items[i];
      const b = el(doc, "button", { type: "button", class: "sk-ring-item", role: "menuitem", "data-ring-key": it.key, text: it.label });
      b.style.left = p.x + "px"; b.style.top = p.y + "px";
      b.addEventListener("click", (e) => { e.stopPropagation(); if (Date.now() - opened < ARM_MS) return; close(); onPick(it.key); });
      box.appendChild(b);
    });
    const close = () => { box.remove(); doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", esc, true); };
    const outside = (e) => { if (!box.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    for (const t of ["pointerdown", "pointerup", "wheel"]) box.addEventListener(t, (e) => e.stopPropagation());
    stage.appendChild(box);
    win.setTimeout(() => { doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", esc, true); }, 0);
    return { close, element: box };
  }

  return { place, dockSide, mount, ring, ringLayout, GAP, MARGIN, DOCK_BELOW, ARM_MS };
});
