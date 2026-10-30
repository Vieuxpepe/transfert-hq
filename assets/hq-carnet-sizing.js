/* Transfert HQ — Carnet Phase 16G: page width, text size and library width, per device.
 *
 *   - Page width (PC, ≥ 900 px, mouse): a handle on the right edge of the page. Drag it; it snaps to Étroite / Normale /
 *     Large / Pleine largeur, double-click (or Échap while dragging) goes back. Arrow keys on the handle, Home / End.
 *   - Text size (every device): A− / A+ in the « ⋯ » tools, Ctrl+< and Ctrl+> on a keyboard. Font and line height move
 *     together in whole pixels, so the ruled lines keep lining up with the text.
 *   - Library width (PC, docked library): drag the line between the library and the page; double-click resets.
 *
 * These are this device's view preferences, kept in this browser only (localStorage, best effort: if storage is refused the
 * settings simply last until the page is reloaded). Nothing is sent to HQ and no note is touched.
 *
 * Plain ES2020, no build step. Pure helpers exported for Node tests (tests/check_hq_carnet_sizing.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqCarnetSizing = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const KEY = "hq_carnet_sizing_v1";
  const PAGE_MIN = 520;
  const PRESETS = [
    { id: "narrow", label: "Étroite", w: 640 },
    { id: "normal", label: "Normale", w: 820 },
    { id: "wide", label: "Large", w: 1080 },
    { id: "full", label: "Pleine largeur", w: 0 }, // 0 = all the room there is
  ];
  const SNAP = 28;
  const SIDE_MIN = 220;
  const SIDE_MAX = 440;
  const SIDE_DEFAULT = 280;
  const FONT_STEPS = [0.82, 0.9, 1, 1.1, 1.2, 1.32, 1.46];
  const FONT_DEFAULT = 2;

  // ------------------------------------------------------------------ pure helpers

  /** Clamp a dragged page width and snap it to a preset when close. Returns {w, preset} (w = 0 means full width). */
  function snapPage(w, avail) {
    const max = Math.max(PAGE_MIN, avail);
    if (w >= max - SNAP) return { w: 0, preset: "full" };
    const c = Math.round(Math.max(PAGE_MIN, Math.min(max, w)));
    for (const p of PRESETS) if (p.w && Math.abs(c - p.w) <= SNAP && p.w <= max) return { w: p.w, preset: p.id };
    return { w: c, preset: "" };
  }

  function presetLabel(w) {
    const p = PRESETS.find((x) => x.w === w);
    return p ? p.label : w + " px";
  }

  function clampSide(w) {
    return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w)));
  }

  /** Font size and line height (whole px) for a step, from this screen's base values. */
  function fontFor(step, baseFs, baseLh) {
    const i = Math.max(0, Math.min(FONT_STEPS.length - 1, step));
    const f = FONT_STEPS[i];
    return { fs: Math.round(baseFs * f), lh: Math.round(baseLh * f), pct: Math.round(f * 100) };
  }

  /** Stored settings, defensively read. */
  function parse(raw) {
    const out = { page: null, font: FONT_DEFAULT, side: null };
    try {
      const d = JSON.parse(raw || "{}");
      if (d && Number.isInteger(d.page) && (d.page === 0 || (d.page >= PAGE_MIN && d.page <= 4000))) out.page = d.page;
      if (d && Number.isInteger(d.font) && d.font >= 0 && d.font < FONT_STEPS.length) out.font = d.font;
      if (d && Number.isInteger(d.side) && d.side >= SIDE_MIN && d.side <= SIDE_MAX) out.side = d.side;
    } catch (_) {
      /* defaults */
    }
    return out;
  }

  const pure = { snapPage, presetLabel, clampSide, fontFor, parse, PRESETS, FONT_STEPS, FONT_DEFAULT, PAGE_MIN, SIDE_MIN, SIDE_MAX };

  // ------------------------------------------------------------------ browser layer

  const S = { started: false, win: null, doc: null, prefs: { page: null, font: FONT_DEFAULT, side: null }, root: null, pageGrip: null, sideGrip: null, tip: null, fontBox: null, ro: null };

  function el(tag, attrs, kids) {
    const n = S.doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids || []) n.appendChild(c);
    return n;
  }

  function store() {
    try {
      S.win.localStorage.setItem(KEY, JSON.stringify(S.prefs));
    } catch (_) {
      /* private mode / refused: the setting lasts for this page only */
    }
  }

  function load() {
    try {
      S.prefs = parse(S.win.localStorage.getItem(KEY));
    } catch (_) {
      S.prefs = parse("");
    }
  }

  function mq(q) {
    try {
      return !!S.win.matchMedia(q).matches;
    } catch (_) {
      return false;
    }
  }

  const desktop = () => mq("(min-width:900px) and (hover:hover) and (pointer:fine)");

  function buzz(ms) {
    const M = S.win.HqCarnetMotion;
    if (M && typeof M.buzz === "function") M.buzz(ms);
  }

  // ---------------------------------------------------------------- apply

  function applyPage() {
    const body = S.doc.body;
    const w = S.prefs.page;
    const on = w != null && desktop();
    body.classList.toggle("carnet-sized", on);
    if (on) body.style.setProperty("--carnet-page-w", w === 0 ? "none" : w + "px");
    else body.style.removeProperty("--carnet-page-w");
    if (S.pageGrip) {
      S.pageGrip.hidden = !desktop();
      S.pageGrip.setAttribute("aria-valuetext", w == null ? "Largeur par défaut" : presetLabel(w));
    }
  }

  function applySide() {
    const body = S.doc.body;
    const on = S.prefs.side != null;
    body.classList.toggle("carnet-side-sized", on);
    if (on) body.style.setProperty("--carnet-side-w", S.prefs.side + "px");
    else body.style.removeProperty("--carnet-side-w");
    placeSideGrip();
  }

  function baseFont() {
    const host = S.doc.querySelector(".hq-carnet");
    if (!host) return null;
    const had = [host.style.getPropertyValue("--carnet-fs"), host.style.getPropertyValue("--carnet-lh")];
    host.style.removeProperty("--carnet-fs");
    host.style.removeProperty("--carnet-lh");
    const cs = S.win.getComputedStyle(host);
    const fs = parseFloat(cs.getPropertyValue("--carnet-fs")) || 17;
    const lh = parseFloat(cs.getPropertyValue("--carnet-lh")) || 28;
    if (had[0]) host.style.setProperty("--carnet-fs", had[0]);
    if (had[1]) host.style.setProperty("--carnet-lh", had[1]);
    return { host, fs, lh };
  }

  function applyFont() {
    const b = baseFont();
    if (!b) return;
    const f = fontFor(S.prefs.font, b.fs, b.lh);
    if (S.prefs.font === FONT_DEFAULT) {
      b.host.style.removeProperty("--carnet-fs");
      b.host.style.removeProperty("--carnet-lh");
    } else {
      b.host.style.setProperty("--carnet-fs", f.fs + "px");
      b.host.style.setProperty("--carnet-lh", f.lh + "px");
    }
    if (S.fontBox) {
      S.fontBox.value.textContent = f.pct + " %";
      S.fontBox.minus.disabled = S.prefs.font <= 0;
      S.fontBox.plus.disabled = S.prefs.font >= FONT_STEPS.length - 1;
      S.fontBox.reset.disabled = S.prefs.font === FONT_DEFAULT;
    }
  }

  function setFont(step, announce) {
    const next = Math.max(0, Math.min(FONT_STEPS.length - 1, step));
    if (next === S.prefs.font) return;
    S.prefs.font = next;
    store();
    applyFont();
    buzz(5);
    if (announce) tipAt(null, "Texte " + Math.round(FONT_STEPS[next] * 100) + " %");
  }

  // ---------------------------------------------------------------- floating label while resizing

  function tipAt(x, text) {
    if (!S.tip) {
      S.tip = el("div", { class: "carnet-size-tip", "aria-hidden": "true" });
      S.doc.body.appendChild(S.tip);
    }
    S.tip.textContent = text;
    const r = S.root ? S.root.getBoundingClientRect() : { left: 0, width: S.win.innerWidth };
    S.tip.style.left = (x == null ? r.left + r.width / 2 : x) + "px";
    S.tip.classList.add("is-on");
    if (S.tipTimer) S.win.clearTimeout(S.tipTimer);
    S.tipTimer = S.win.setTimeout(() => S.tip && S.tip.classList.remove("is-on"), 900);
  }

  // ---------------------------------------------------------------- page width handle

  function availPage() {
    // all the room the page could take once the 1180 px HQ column limit is lifted: from the column's left edge (after the
    // docked library) to the window edge, less the usual 16 px margin
    const wrap = (S.root && S.root.closest(".wrap")) || S.doc.body;
    const cs = S.win.getComputedStyle(wrap);
    const left = wrap.getBoundingClientRect().left + (parseFloat(cs.paddingLeft) || 0);
    const lib = S.root && S.root.classList.contains("lib-dock") ? S.root.querySelector(".carnet-library") : null;
    const libW = lib && !lib.hidden ? lib.getBoundingClientRect().width + 16 : 0;
    const vw = S.doc.documentElement.clientWidth;
    return Math.max(PAGE_MIN, Math.round(vw - 16 - left - libW));
  }

  function ensurePageGrip() {
    const stage = S.root && S.root.querySelector(".carnet-stage");
    if (!stage) return;
    if (S.pageGrip && S.pageGrip.isConnected && S.pageGrip.parentNode === stage) return;
    const g = el("div", {
      class: "carnet-page-grip", role: "separator", tabindex: "0", "aria-orientation": "vertical",
      "aria-label": "Largeur de la page (glisser, flèches ; double-clic : par défaut)", title: "Glisser pour changer la largeur de la page · double-clic : par défaut",
    }, [el("span", { class: "carnet-grip-bar", "aria-hidden": "true" })]);
    stage.appendChild(g);
    S.pageGrip = g;
    g.addEventListener("pointerdown", (e) => dragPage(e));
    g.addEventListener("dblclick", () => {
      S.prefs.page = null;
      store();
      applyPage();
      tipAt(null, "Largeur par défaut");
    });
    g.addEventListener("keydown", (e) => {
      const main = S.root.querySelector(".carnet-main");
      const cur = main ? main.getBoundingClientRect().width : 820;
      let w = null;
      if (e.key === "ArrowRight") w = cur + (e.shiftKey ? 120 : 40);
      else if (e.key === "ArrowLeft") w = cur - (e.shiftKey ? 120 : 40);
      else if (e.key === "End") w = 99999;
      else if (e.key === "Home") w = PAGE_MIN;
      else if (e.key === "Enter" || e.key === "Escape") {
        S.prefs.page = null;
        store();
        applyPage();
        tipAt(null, "Largeur par défaut");
        e.preventDefault();
        return;
      }
      if (w == null) return;
      e.preventDefault();
      const s = snapPage(w, availPage());
      S.prefs.page = s.w;
      store();
      applyPage();
      tipAt(null, s.preset ? presetLabel(s.w) : s.w + " px");
    });
    applyPage();
  }

  function dragPage(e) {
    if (e.button > 0) return;
    e.preventDefault();
    const main = S.root.querySelector(".carnet-main");
    if (!main) return;
    const g = S.pageGrip;
    const start = { x: e.clientX, w: main.getBoundingClientRect().width, id: e.pointerId, before: S.prefs.page, last: "" };
    const avail = availPage();
    try {
      g.setPointerCapture(e.pointerId);
    } catch (_) {}
    S.doc.body.classList.add("carnet-resizing");
    g.classList.add("is-active");
    const move = (ev) => {
      if (ev.pointerId !== start.id) return;
      // the page is centred: the edge moves half as much as the width changes
      const s = snapPage(start.w + (ev.clientX - start.x) * 2, avail);
      S.prefs.page = s.w;
      applyPage();
      if (s.preset !== start.last) {
        if (s.preset) buzz(6);
        start.last = s.preset;
      }
      tipAt(ev.clientX, s.preset ? presetLabel(s.w) : s.w + " px");
    };
    const end = (ev, cancel) => {
      if (ev && ev.pointerId != null && ev.pointerId !== start.id) return;
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("pointercancel", cancelFn);
      S.doc.removeEventListener("keydown", esc, true);
      S.doc.body.classList.remove("carnet-resizing");
      g.classList.remove("is-active");
      if (cancel) {
        S.prefs.page = start.before;
        applyPage();
        return;
      }
      store();
    };
    const up = (ev) => end(ev, false);
    const cancelFn = (ev) => end(ev, true);
    const esc = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        end(null, true);
      }
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", cancelFn);
    S.doc.addEventListener("keydown", esc, true);
  }

  // ---------------------------------------------------------------- library width handle

  function ensureSideGrip() {
    if (!S.root) return;
    if (!S.sideGrip || !S.sideGrip.isConnected) {
      const g = el("div", {
        class: "carnet-side-grip", role: "separator", tabindex: "0", "aria-orientation": "vertical",
        "aria-label": "Largeur de la bibliothèque (glisser, flèches ; double-clic : par défaut)", title: "Glisser pour élargir ou réduire la bibliothèque · double-clic : par défaut",
      }, [el("span", { class: "carnet-grip-bar", "aria-hidden": "true" })]);
      S.root.appendChild(g);
      S.sideGrip = g;
      g.addEventListener("pointerdown", (e) => dragSide(e));
      g.addEventListener("dblclick", () => {
        S.prefs.side = null;
        store();
        applySide();
        tipAt(null, "Bibliothèque : largeur par défaut");
      });
      g.addEventListener("keydown", (e) => {
        const lib = S.root.querySelector(".carnet-library");
        const cur = S.prefs.side != null ? S.prefs.side : lib ? Math.round(lib.getBoundingClientRect().width) : SIDE_DEFAULT;
        let w = null;
        if (e.key === "ArrowRight") w = cur + (e.shiftKey ? 60 : 20);
        else if (e.key === "ArrowLeft") w = cur - (e.shiftKey ? 60 : 20);
        else if (e.key === "Home") w = SIDE_MIN;
        else if (e.key === "End") w = SIDE_MAX;
        else if (e.key === "Enter") {
          S.prefs.side = null;
          store();
          applySide();
          e.preventDefault();
          return;
        }
        if (w == null) return;
        e.preventDefault();
        S.prefs.side = clampSide(w);
        store();
        applySide();
      });
    }
    placeSideGrip();
  }

  function placeSideGrip() {
    const g = S.sideGrip;
    if (!g || !S.root) return;
    const lib = S.root.querySelector(".carnet-library");
    const show = S.root.classList.contains("lib-dock") && lib && !lib.hidden && desktop() && !S.root.classList.contains("is-focus");
    g.hidden = !show;
    if (!show) return;
    const rr = S.root.getBoundingClientRect();
    const lr = lib.getBoundingClientRect();
    const main = S.root.querySelector(".carnet-main");
    const mr = main ? main.getBoundingClientRect() : { left: lr.right + 16 };
    g.style.left = Math.round((lr.right + Math.min(mr.left, lr.right + 16)) / 2 - rr.left - 7) + "px";
    g.style.top = Math.round(lr.top - rr.top) + "px";
    g.style.height = Math.round(lr.height) + "px";
  }

  function dragSide(e) {
    if (e.button > 0) return;
    e.preventDefault();
    const lib = S.root.querySelector(".carnet-library");
    if (!lib) return;
    const g = S.sideGrip;
    const start = { x: e.clientX, w: lib.getBoundingClientRect().width, id: e.pointerId, before: S.prefs.side };
    try {
      g.setPointerCapture(e.pointerId);
    } catch (_) {}
    S.doc.body.classList.add("carnet-resizing");
    g.classList.add("is-active");
    const move = (ev) => {
      if (ev.pointerId !== start.id) return;
      S.prefs.side = clampSide(start.w + ev.clientX - start.x);
      applySide();
      tipAt(ev.clientX, "Bibliothèque · " + S.prefs.side + " px");
    };
    const end = (ev, cancel) => {
      if (ev && ev.pointerId != null && ev.pointerId !== start.id) return;
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("pointercancel", cancelFn);
      S.doc.removeEventListener("keydown", esc, true);
      S.doc.body.classList.remove("carnet-resizing");
      g.classList.remove("is-active");
      if (cancel) {
        S.prefs.side = start.before;
        applySide();
        return;
      }
      store();
    };
    const up = (ev) => end(ev, false);
    const cancelFn = (ev) => end(ev, true);
    const esc = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        end(null, true);
      }
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", cancelFn);
    S.doc.addEventListener("keydown", esc, true);
  }

  // ---------------------------------------------------------------- text size controls (in the « ⋯ » tools)

  function ensureFontControls() {
    const tools = S.doc.getElementById("carnet-quick-tools");
    if (!tools) return;
    if (S.fontBox && S.fontBox.group.isConnected && tools.contains(S.fontBox.group)) return;
    const mk = (cls, label, text) => {
      const b = el("button", { type: "button", class: "carnet-sym carnet-size-btn " + cls, "aria-label": label, title: label, text });
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor caret / iOS keyboard
      return b;
    };
    const minus = mk("carnet-size-minus", "Texte plus petit (Ctrl+<)", "A−");
    const value = el("span", { class: "carnet-size-value", "aria-live": "polite" });
    const plus = mk("carnet-size-plus", "Texte plus grand (Ctrl+>)", "A+");
    const reset = mk("carnet-size-reset", "Taille du texte par défaut", "100 %");
    reset.textContent = "Défaut";
    const widths = el("div", { class: "carnet-size-widths", role: "group", "aria-label": "Largeur de la page" });
    for (const p of PRESETS) {
      const b = mk("carnet-size-width", "Largeur de la page : " + p.label, p.label === "Pleine largeur" ? "Pleine" : p.label);
      b.setAttribute("data-carnet-width", String(p.w));
      b.addEventListener("click", () => {
        S.prefs.page = p.w;
        store();
        applyPage();
        markWidths();
        tipAt(null, p.label);
      });
      widths.appendChild(b);
    }
    const group = el("div", { class: "carnet-tool-group carnet-size-group", role: "group", "aria-label": "Affichage" }, [
      el("span", { class: "carnet-tool-group-label", "aria-hidden": "true", text: "Affichage" }),
      minus, value, plus, reset, widths,
    ]);
    minus.addEventListener("click", () => setFont(S.prefs.font - 1, false));
    plus.addEventListener("click", () => setFont(S.prefs.font + 1, false));
    reset.addEventListener("click", () => setFont(FONT_DEFAULT, false));
    tools.appendChild(group);
    S.fontBox = { group, minus, value, plus, reset, widths };
    applyFont();
    markWidths();
  }

  function markWidths() {
    if (!S.fontBox) return;
    S.fontBox.widths.hidden = !desktop();
    for (const b of S.fontBox.widths.children) b.setAttribute("aria-pressed", String(S.prefs.page) === b.getAttribute("data-carnet-width") ? "true" : "false");
  }

  // ---------------------------------------------------------------- start

  function watch() {
    const root = S.doc.querySelector(".hq-carnet .carnet");
    if (root !== S.root) {
      S.root = root;
      if (S.ro) S.ro.disconnect();
      if (root && typeof S.win.ResizeObserver === "function") {
        S.ro = new S.win.ResizeObserver(() => placeSideGrip());
        S.ro.observe(root);
        const lib = root.querySelector(".carnet-library");
        if (lib) S.ro.observe(lib);
      }
    }
    if (!S.root) return;
    ensurePageGrip();
    ensureSideGrip();
    ensureFontControls();
  }

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    load();
    const boot = () => {
      applyPage();
      applySide();
      watch();
      applyFont();
      win.setInterval(watch, 800);
      let t = 0;
      win.addEventListener("resize", () => {
        if (t) win.clearTimeout(t);
        t = win.setTimeout(() => {
          applyPage();
          applyFont(); // the base size depends on the screen size
          placeSideGrip();
          markWidths();
        }, 120);
      });
      win.addEventListener("scroll", () => placeSideGrip(), { passive: true });
      S.doc.addEventListener("keydown", (e) => {
        if (!S.doc.body || S.doc.body.dataset.view !== "carnet" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.key === ">") { // AZERTY: Ctrl+Maj+<  ·  QWERTY: Ctrl+Shift+.
          e.preventDefault();
          setFont(S.prefs.font + 1, true);
        } else if (e.key === "<") {
          e.preventDefault();
          setFont(S.prefs.font - 1, true);
        }
      });
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure, prefs: () => Object.assign({}, S.prefs) };
});
