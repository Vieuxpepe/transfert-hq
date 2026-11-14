/* Transfert HQ — long-press radial menu for touch screens (assets/hq-radial.css).
 *
 * Long-press an empty spot anywhere in HQ (≈0.45 s, finger still) and a ring of quick actions blooms under the finger,
 * with a short vibration where the phone allows it. Slide toward an action and lift to run it (a marking menu), or lift in
 * the middle and tap one. It is the touch version of Ctrl+K: photo, note, Forge prompt, voice memo, time machine, second
 * screen, search.
 *
 * It stays out of the way of anything that already owns a long press or a drag: text fields and editable text, buttons
 * and links, canvases and media, Fichiers tiles, calendar grids, the companions, and the Dessiner / Tête-à-tête views.
 * Anything can opt out with [data-no-radial]. Plain ES2020; pure helpers (layout, pickIndex, eligible) are Node-testable.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqRadial = api;
    if (root.document) api.boot(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const HOLD_MS = 450;
  const MOVE_TOL = 10;
  const RADIUS = 96;
  const DEAD = 30; // finger this close to the centre picks nothing
  const BLOCK = [
    "input", "textarea", "select", "button", "a[href]", "label", "summary", "video", "audio", "canvas", "iframe",
    "[contenteditable]", "[contenteditable=\"\"]", "[draggable=\"true\"]", "[role=\"button\"]", "[role=\"option\"]", "[role=\"slider\"]",
    "[role=\"grid\"]", "[role=\"gridcell\"]", "[role=\"listbox\"]", "[role=\"menu\"]", "[role=\"dialog\"]", "dialog",
    "[data-no-radial]", "#hq-debug-panel", ".fx-item", "#hq-companion", "#hq-else", "#hq-inventoria", ".hq-dangling-member-mount",
    ".hq-companions-picker", "#hq-tm", "#hq-sky", "#hq-desk", ".rad", ".palette", ".sk-root",
  ].join(",");
  const BLOCK_VIEWS = new Set(["dessiner", "intime", "calendrier"]);

  // ------------------------------------------------------------------ pure helpers
  /** Item centres on a ring around (cx, cy), starting at the top, clockwise. The ring is pushed inside the viewport
   * (w × h, with `margin`) so every item stays reachable near an edge. */
  function layout(n, cx, cy, w, h, radius, margin) {
    const r = radius, m = margin + 28;
    const x = Math.min(Math.max(cx, r + m), Math.max(r + m, w - r - m));
    const y = Math.min(Math.max(cy, r + m), Math.max(r + m, h - r - m));
    const items = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      items.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, a });
    }
    return { cx: x, cy: y, items };
  }

  /** Which item a finger at (px, py) points to: by angle once it is past the dead zone, else -1. */
  function pickIndex(n, cx, cy, px, py, dead) {
    const dx = px - cx, dy = py - cy;
    if (Math.hypot(dx, dy) < dead) return -1;
    let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at the top, clockwise
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.round(a / ((Math.PI * 2) / n)) % n;
  }

  /** May a long press on `target` open the ring? `view` is document.body.dataset.view. */
  function eligible(target, view) {
    if (BLOCK_VIEWS.has(view)) return false;
    if (!target || typeof target.closest !== "function") return false;
    return !target.closest(BLOCK);
  }

  // ------------------------------------------------------------------ actions
  function actions(win) {
    const doc = win.document;
    const click = (id) => { const b = doc.getElementById(id); if (b) { b.click(); return true; } return false; };
    const recording = () => { const b = doc.getElementById("btn-voice"); return !!(b && /stop/i.test(b.textContent || "")); };
    return [
      { id: "photo", label: "Photo", icon: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", run: () => pickPhoto(win) },
      { id: "note", label: "Note", icon: "M6 3h9l4 4v14H6zM9 12h7M9 16h5", run: () => newNote(win) },
      { id: "forge", label: "Forge", icon: "M12 3l1.9 4.9 4.9 1.9-4.9 1.9L12 17l-1.9-5.4L5 9.8l5.1-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z", run: () => forgePrompt(win) },
      { id: "voice", label: () => (recording() ? "Arrêter" : "Mémo vocal"), icon: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3", run: () => click("btn-voice") },
      { id: "time", label: "Le temps", icon: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2", run: () => win.hqTimeMachine && win.hqTimeMachine.open() },
      { id: "desk", label: "2e écran", icon: "M3 5h13v10H3zM8 19h3M18 8h3v11h-5", run: () => win.hqDesk && win.hqDesk.openPanel() },
      { id: "search", label: "Chercher", icon: "M10.5 16.5a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM15 15l5 5", run: () => click("btn-search-bar") },
    ];
  }

  function pickPhoto(win) {
    const doc = win.document;
    const input = doc.createElement("input");
    input.type = "file"; input.accept = "image/*"; input.multiple = true; input.hidden = true;
    input.addEventListener("change", () => {
      if (input.files && input.files.length && typeof win.uploadFiles === "function") win.uploadFiles(input.files);
      input.remove();
    }, { once: true });
    doc.body.appendChild(input);
    input.click();
  }

  async function newNote(win) {
    try {
      if (!win.hqCapture && typeof win.hqCarnetLoad === "function") await win.hqCarnetLoad();
    } catch (_) {}
    for (let i = 0; i < 20 && !win.hqCapture; i++) await new Promise((r) => win.setTimeout(r, 100)); // capture boots after /api/me
    if (win.hqCapture && typeof win.hqCapture.open === "function") win.hqCapture.open();
    else if (typeof win.setView === "function") win.setView("carnet");
  }

  async function forgePrompt(win) {
    if (typeof win.setView === "function") win.setView("forge");
    try { if (typeof win.hqForgeLoad === "function") await win.hqForgeLoad(); } catch (_) {}
    const box = win.document.getElementById("forge-prompt");
    if (box) { try { box.scrollIntoView({ block: "center" }); } catch (_) {} box.focus(); }
  }

  // ------------------------------------------------------------------ DOM
  function boot(win) {
    const doc = win.document;
    const go = () => { try { mount(win); } catch (e) { if (win.console) win.console.error(e); } };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go);
    else go();
  }

  function mount(win) {
    const doc = win.document;
    if (doc.querySelector(".rad")) return null;
    const coarse = () => !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
    const reduced = () => !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const haptic = (k) => { if (typeof win.hqPolishHaptic === "function") win.hqPolishHaptic(k); else { try { win.navigator.vibrate && win.navigator.vibrate(10); } catch (_) {} } };
    const ACTS = actions(win);
    const labelOf = (a) => (typeof a.label === "function" ? a.label() : a.label);

    const ns = "http://www.w3.org/2000/svg";
    const icon = (d) => {
      const s = doc.createElementNS(ns, "svg");
      s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
      const p = doc.createElementNS(ns, "path");
      p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.9"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
      s.appendChild(p);
      return s;
    };
    const ring = doc.createElement("div");
    ring.className = "rad";
    ring.hidden = true;
    ring.setAttribute("role", "menu");
    ring.setAttribute("aria-label", "Actions rapides");
    const hub = doc.createElement("div");
    hub.className = "rad-hub";
    hub.setAttribute("aria-hidden", "true");
    ring.appendChild(hub);
    const btns = ACTS.map((a, i) => {
      const b = doc.createElement("button");
      b.type = "button"; b.className = "rad-item"; b.setAttribute("role", "menuitem"); b.dataset.act = a.id;
      b.style.setProperty("--i", String(i));
      const lab = doc.createElement("span"); lab.className = "rad-label";
      b.append(icon(a.icon), lab);
      b.addEventListener("click", (e) => { e.stopPropagation(); choose(i); });
      ring.appendChild(b);
      return b;
    });
    doc.body.appendChild(ring);

    const S = { timer: 0, start: null, open: false, tracking: false, sel: -1, geo: null, swallowUntil: 0 };

    function place(x, y) {
      const geo = layout(ACTS.length, x, y, win.innerWidth, win.innerHeight, RADIUS, 8);
      S.geo = geo;
      hub.style.transform = "translate(" + geo.cx + "px," + geo.cy + "px)";
      ring.style.setProperty("--cx", geo.cx + "px");
      ring.style.setProperty("--cy", geo.cy + "px");
      geo.items.forEach((p, i) => {
        btns[i].style.setProperty("--x", p.x + "px");
        btns[i].style.setProperty("--y", p.y + "px");
        btns[i].style.setProperty("--fx", (geo.cx - p.x) + "px");
        btns[i].style.setProperty("--fy", (geo.cy - p.y) + "px");
        btns[i].querySelector(".rad-label").textContent = labelOf(ACTS[i]);
        btns[i].setAttribute("aria-label", labelOf(ACTS[i]));
      });
    }
    function highlight(i) {
      if (i === S.sel) return;
      S.sel = i;
      btns.forEach((b, j) => b.classList.toggle("is-hot", j === i));
      if (i >= 0) haptic("tick");
    }
    function openAt(x, y) {
      S.open = true; S.tracking = true; S.sel = -1;
      place(x, y);
      btns.forEach((b) => b.classList.remove("is-hot"));
      ring.hidden = false;
      doc.documentElement.classList.add("rad-open");
      try { const sel = win.getSelection && win.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (_) {}
      if (reduced()) ring.classList.add("is-open");
      else win.requestAnimationFrame(() => ring.classList.add("is-open"));
      haptic("drop");
    }
    function close() {
      if (!S.open) return;
      S.open = false; S.tracking = false;
      ring.classList.remove("is-open");
      doc.documentElement.classList.remove("rad-open");
      const done = () => { if (!S.open) ring.hidden = true; };
      if (reduced()) done(); else win.setTimeout(done, 180);
    }
    function choose(i) {
      const a = ACTS[i];
      close();
      S.swallowUntil = Date.now() + 450;
      if (!a) return;
      haptic("done");
      try { const r = a.run(); if (r && r.catch) r.catch(() => {}); } catch (e) { if (win.console) win.console.error(e); }
    }
    function cancelHold() { if (S.timer) { win.clearTimeout(S.timer); S.timer = 0; } S.start = null; }

    // Touch events (not pointer events): once the ring is open, a non-passive touchmove can stop the page from scrolling,
    // so the finger keeps steering the ring instead of the browser cancelling the gesture.
    doc.addEventListener("touchstart", (e) => {
      if (S.open) {
        if (!ring.contains(e.target)) { e.preventDefault(); close(); S.swallowUntil = Date.now() + 450; }
        return;
      }
      if (e.touches.length !== 1 || !coarse()) { cancelHold(); return; }
      const t = e.touches[0];
      if (!eligible(e.target, doc.body.dataset.view || "")) return;
      S.start = { x: t.clientX, y: t.clientY };
      S.timer = win.setTimeout(() => { S.timer = 0; if (S.start) openAt(S.start.x, S.start.y); }, HOLD_MS);
    }, { passive: false, capture: true });
    doc.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (S.open && S.tracking) {
        e.preventDefault();
        highlight(pickIndex(ACTS.length, S.geo.cx, S.geo.cy, t.clientX, t.clientY, DEAD));
        return;
      }
      if (S.start && Math.hypot(t.clientX - S.start.x, t.clientY - S.start.y) > MOVE_TOL) cancelHold();
    }, { passive: false, capture: true });
    const end = (e) => {
      cancelHold();
      if (!S.open || !S.tracking) return;
      S.tracking = false;
      e.preventDefault(); // no synthetic click on what was under the finger
      S.swallowUntil = Date.now() + 450;
      if (e.type === "touchend" && S.sel >= 0) choose(S.sel);
      // lifted in the middle: the ring stays open for a tap
    };
    doc.addEventListener("touchend", end, { passive: false, capture: true });
    doc.addEventListener("touchcancel", end, { passive: false, capture: true });
    doc.addEventListener("scroll", cancelHold, { passive: true, capture: true });
    doc.addEventListener("contextmenu", (e) => { if (S.open) e.preventDefault(); }, true);
    doc.addEventListener("click", (e) => {
      if (Date.now() < S.swallowUntil && !ring.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    doc.addEventListener("keydown", (e) => { if (S.open && e.key === "Escape") close(); });
    win.addEventListener("resize", close);

    const h = { openAt, close, state: () => ({ open: S.open, sel: S.sel, items: ACTS.map((a) => a.id) }) };
    win.hqRadial = h;
    return h;
  }

  return { HOLD_MS, RADIUS, layout, pickIndex, eligible, boot, mount };
});
