/* Transfert HQ — Carnet Phase 16C: ergonomics + motion layer (presentation only).
 *
 * What this module owns (and nothing else):
 *   - the phone dock: on narrow screens the page bar's buttons (précédent / suivant / copier / nouvelle page) live in the field
 *     dock instead of a second bar hidden under it (DF-1). The SAME button elements are moved, so ids, labels and listeners stay.
 *   - the Capture button tucks away while you type or scroll in the Carnet and comes back when you stop (DF-3).
 *   - keyboard awareness: the line being typed stays above the software keyboard and the dock.
 *   - motion: menus grow from what was tapped, blocks slide aside on insert / delete / move, a ticked checkbox squishes and a
 *     finished checklist says so, the save pill turns into a check, a library card grows into its page, a drawing grows into the
 *     inspector, images shimmer until loaded.
 *   - the "Annuler" toast (swipe to dismiss, countdown) used by block operations, and haptic taps.
 *   - long-press on a block's margin or on an atom (image, card, drawing) opens that block's menu on touch.
 *   - pull down at the top of a page: "Plan de la page", pull further: "Bibliothèque".
 *
 * It never writes a note, never reads or stores user data, never touches the network or browser storage, and never builds HTML
 * from strings. Every animation is a CSS transform/opacity (or the Web Animations API on the same properties) and is skipped
 * when the person asked for reduced motion. Undo itself is decided by the host (hq-carnet.js), which fails closed.
 *
 * Plain ES2020, no build step. The pure helpers are exported for Node tests (tests/check_hq_carnet_motion.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqCarnetMotion = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  // ------------------------------------------------------------------ pure helpers (tested in Node)

  /** Share of the old keys still present in the new ones (0..1). A page switch is ~0, an edit is ~1. */
  function overlap(oldKeys, newKeys) {
    if (!oldKeys.length || !newKeys.length) return 0;
    const set = new Set(oldKeys);
    let n = 0;
    for (const k of newKeys) if (set.has(k)) n += 1;
    return n / Math.max(oldKeys.length, newKeys.length);
  }

  function sameSeq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  /** FLIP plan: which kept blocks moved (dy = old top - new top) and which are new. Capped so a huge paste never animates. */
  function flipPlan(oldTops, newTops, opts) {
    const o = opts || {};
    const maxMoves = o.maxMoves || 80;
    const maxDy = o.maxDy || 480;
    const moves = [];
    const added = [];
    for (const [k, top] of newTops) {
      if (oldTops.has(k)) {
        const dy = oldTops.get(k) - top;
        if (Math.abs(dy) >= 1 && Math.abs(dy) <= maxDy) moves.push({ key: k, dy });
      } else added.push(k);
    }
    return { moves: moves.length > maxMoves ? [] : moves, added: added.length > (o.maxAdded || 3) ? [] : added };
  }

  /** The contiguous run of checklist lines around `idx` in a list of {type, checked}. */
  function checklistRun(lines, idx) {
    if (!lines[idx] || lines[idx].type !== "check") return { done: 0, total: 0, from: idx, to: idx };
    let a = idx;
    let b = idx;
    while (a > 0 && lines[a - 1] && lines[a - 1].type === "check") a -= 1;
    while (lines[b + 1] && lines[b + 1].type === "check") b += 1;
    let done = 0;
    for (let i = a; i <= b; i += 1) if (lines[i].checked) done += 1;
    return { done, total: b - a + 1, from: a, to: b };
  }

  /** Pull-down stages: 0 nothing, 1 "Plan de la page", 2 "Bibliothèque". `d` is the damped pull distance. */
  const PULL_ARM = 64;
  const PULL_FAR = 128;
  function pullStage(d) {
    return d >= PULL_FAR ? 2 : d >= PULL_ARM ? 1 : 0;
  }

  /** transform-origin (px, relative to the box) for a menu that should grow out of `point`, clamped into the box. */
  function originFor(rect, point) {
    if (!rect || !point || !(rect.width > 0) || !(rect.height > 0)) return "50% 0";
    const x = Math.max(0, Math.min(rect.width, point.x - rect.left));
    const y = Math.max(0, Math.min(rect.height, point.y - rect.top));
    return Math.round(x) + "px " + Math.round(y) + "px";
  }

  /** Swipe-to-dismiss decision for the toast. */
  function dismissBySwipe(dx, v, width) {
    return Math.abs(dx) > Math.max(72, (width || 300) * 0.35) || (Math.abs(v) > 0.5 && Math.abs(dx) > 24);
  }

  /** Where the caret must be scrolled to stay visible: 0 when it already is, otherwise the (positive) distance to scroll down. */
  function caretScroll(caretBottom, visibleBottom, margin) {
    const m = margin == null ? 16 : margin;
    return caretBottom > visibleBottom - m ? Math.round(caretBottom - visibleBottom + m) : 0;
  }

  const pure = { overlap, sameSeq, flipPlan, checklistRun, pullStage, originFor, dismissBySwipe, caretScroll, PULL_ARM, PULL_FAR };

  // ------------------------------------------------------------------ browser layer

  const MENU_SEL = ".carnet-cmd-menu,.carnet-block-menu,.carnet-sel-toolbar,.carnet-insert-menu,.carnet-savepop,.carnet-context,.carnet-outline,.carnet-link-panel";
  const ATOM_SEL = ".carnet-figure,.carnet-eng-card,.carnet-drawing,.carnet-voice,.carnet-group,.carnet-derived-thumb";
  const NARROW = "(max-width:720px)";
  const S = {
    started: false, win: null, doc: null,
    editor: null, root: null, mo: null, rootMo: null, classMo: null, bodyMo: null,
    tops: new Map(), checked: new Map(), keys: [],
    lastPointer: null, lastCard: null, lastAtom: null,
    dock: null, fabTimer: 0, toast: null, haptic: null, lastBuzz: 0,
    snapRaf: 0, caretRaf: 0, savedKind: "",
  };

  function calm() {
    try {
      return !!S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return true;
    }
  }

  function narrow() {
    try {
      return !!S.win.matchMedia(NARROW).matches;
    } catch (_) {
      return false;
    }
  }

  function inCarnet() {
    return !!(S.doc.body && S.doc.body.dataset && S.doc.body.dataset.view === "carnet");
  }

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

  /** A short tap of the phone. Android: vibrate. iPhone ignores vibrate, but Safari 18+ taps when a switch toggle changes, so a
   *  hidden one is toggled instead (the same technique as the Calendar). Never with reduced motion. */
  function buzz(ms) {
    try {
      if (!S.win || calm()) return;
      const t = Date.now();
      if (t - S.lastBuzz < 45) return;
      S.lastBuzz = t;
      const nav = S.win.navigator;
      if (nav && typeof nav.vibrate === "function") {
        nav.vibrate(ms || 8);
        return;
      }
      if (!S.haptic) {
        const input = el("input", { type: "checkbox", switch: true, tabindex: "-1" });
        S.haptic = el("label", { class: "c16-haptic", "aria-hidden": "true" }, [input]);
        S.doc.body.appendChild(S.haptic);
      }
      S.haptic.click();
    } catch (_) {}
  }

  function animate(node, frames, opts) {
    if (!node || typeof node.animate !== "function" || calm()) return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------- attach / detach to the (single) Carnet editor

  function keyOf(node) {
    return node.getAttribute("data-carnet-block-id") || node;
  }

  function lineKids() {
    const ed = S.editor;
    if (!ed) return [];
    const out = [];
    for (const k of ed.children) if (k.hasAttribute && k.hasAttribute("data-line-type")) out.push(k);
    return out;
  }

  function snapshot() {
    S.snapRaf = 0;
    const kids = lineKids();
    S.tops = new Map();
    S.checked = new Map();
    S.keys = [];
    for (const k of kids) {
      const key = keyOf(k);
      S.keys.push(key);
      S.tops.set(key, k.offsetTop);
      if (k.getAttribute("data-line-type") === "check") S.checked.set(key, k.getAttribute("data-checked") === "true");
    }
  }

  function scheduleSnapshot() {
    if (S.snapRaf) return;
    S.snapRaf = S.win.requestAnimationFrame(snapshot);
  }

  function busyGesture() {
    const ed = S.editor;
    if (!ed) return true;
    if (ed.classList.contains("c16-lifting") || ed.querySelector("[data-gesture]")) return true;
    const paper = ed.parentNode;
    if (paper && paper.classList && paper.classList.contains("c16-dragging")) return true;
    return false;
  }

  function onEditorMutations() {
    const kids = lineKids();
    const newKeys = kids.map(keyOf);
    const ov = overlap(S.keys, newKeys);
    if (ov < 0.5) {
      pageChanged(kids);
      snapshot();
      return;
    }
    const newTops = new Map();
    kids.forEach((k, i) => newTops.set(newKeys[i], k.offsetTop));
    if (!sameSeq(S.keys, newKeys) && !busyGesture() && !calm()) {
      const plan = flipPlan(S.tops, newTops);
      const byKey = new Map();
      kids.forEach((k, i) => byKey.set(newKeys[i], k));
      const vh = S.win.innerHeight || 800;
      for (const m of plan.moves) {
        const n = byKey.get(m.key);
        if (!n) continue;
        const r = n.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) continue; // off screen: no work
        animate(n, [{ transform: "translate3d(0," + m.dy + "px,0)" }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      for (const k of plan.added) {
        const n = byKey.get(k);
        if (!n) continue;
        animate(n, [{ opacity: 0, transform: "translate3d(0,-6px,0) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
        if (!calm()) {
          n.classList.add("c16-new");
          S.win.setTimeout(() => n.classList.remove("c16-new"), 900);
        }
      }
    }
    // a checkbox that just became ticked (same block id, before: unticked)
    kids.forEach((k, i) => {
      if (k.getAttribute("data-line-type") !== "check") return;
      const key = newKeys[i];
      const now = k.getAttribute("data-checked") === "true";
      if (now && S.checked.has(key) && S.checked.get(key) === false) ticked(k, kids, i);
    });
    snapshot();
  }

  function attach(editor) {
    detach();
    S.editor = editor;
    S.root = editor.closest ? editor.closest(".carnet") : null;
    S.mo = new S.win.MutationObserver(onEditorMutations);
    S.mo.observe(editor, { childList: true });
    editor.addEventListener("input", scheduleSnapshot);
    editor.addEventListener("focusin", onEditorActivity);
    editor.addEventListener("keydown", onEditorActivity);
    editor.addEventListener("focusout", onEditorBlur);
    editor.addEventListener("pointerdown", onEditorPointerDown);
    editor.addEventListener("load", onMediaLoad, true);
    editor.addEventListener("error", onMediaLoad, true);
    if (S.root) {
      S.rootMo = new S.win.MutationObserver(onRootMutations);
      S.rootMo.observe(S.root, { attributes: true, subtree: true, attributeFilter: ["hidden", "data-kind"] });
      let wasFocus = S.root.classList.contains("is-focus");
      S.classMo = new S.win.MutationObserver(() => { // focus mode toggles a class on the root only
        syncDock();
        const f = S.root && S.root.classList.contains("is-focus");
        if (f !== wasFocus) {
          wasFocus = f;
          const paper = S.editor && S.editor.parentNode;
          animate(paper, [{ transform: "scale(" + (f ? 0.985 : 1.012) + ")", opacity: 0.7 }, { transform: "none", opacity: 1 }], { duration: 340, easing: "cubic-bezier(.2,1.1,.32,1)" });
        }
      });
      S.classMo.observe(S.root, { attributes: true, attributeFilter: ["class"] });
    }
    markLoading(editor);
    watchIndicator();
    snapshot();
    syncDock();
  }

  function detach() {
    if (S.mo) S.mo.disconnect();
    if (S.rootMo) S.rootMo.disconnect();
    if (S.classMo) S.classMo.disconnect();
    S.mo = null;
    S.rootMo = null;
    S.classMo = null;
    if (S.editor) {
      const ed = S.editor;
      ed.removeEventListener("input", scheduleSnapshot);
      ed.removeEventListener("focusin", onEditorActivity);
      ed.removeEventListener("keydown", onEditorActivity);
      ed.removeEventListener("focusout", onEditorBlur);
      wakeChrome();
      ed.removeEventListener("pointerdown", onEditorPointerDown);
      ed.removeEventListener("load", onMediaLoad, true);
      ed.removeEventListener("error", onMediaLoad, true);
    }
    S.editor = null;
    S.root = null;
    S.dock = null;
  }

  function watch() {
    const ed = S.doc.getElementById("hq-carnet-editor");
    if (ed && ed !== S.editor) attach(ed);
    else if (!ed && S.editor) detach();
    if (S.editor) syncDock();
  }

  // ---------------------------------------------------------------- page switch: a library card grows into the page

  function pageChanged(kids) {
    markLoading(S.editor);
    const card = S.lastCard;
    S.lastCard = null;
    if (!card || Date.now() - card.t > 900 || calm()) return;
    const paper = S.editor.parentNode;
    if (!paper || !paper.getBoundingClientRect) return;
    const to = paper.getBoundingClientRect();
    if (!(to.width > 0) || !(to.height > 0)) return;
    const h = Math.min(to.height, (S.win.innerHeight || 800) - Math.max(0, to.top));
    const ghost = el("div", { class: "c16-grow", "aria-hidden": "true" });
    ghost.style.left = to.left + "px";
    ghost.style.top = to.top + "px";
    ghost.style.width = to.width + "px";
    ghost.style.height = Math.max(80, h) + "px";
    S.doc.body.appendChild(ghost);
    const sx = card.r.width / to.width;
    const sy = card.r.height / Math.max(80, h);
    const a = animate(ghost, [
      { transform: "translate3d(" + (card.r.left - to.left) + "px," + (card.r.top - to.top) + "px,0) scale(" + sx + "," + sy + ")", opacity: 1 },
      { transform: "none", opacity: 1, offset: 0.75 },
      { transform: "none", opacity: 0 },
    ], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
    animate(paper, [{ opacity: 0.2 }, { opacity: 0.2, offset: 0.6 }, { opacity: 1 }], { duration: 380 });
    const done = () => ghost.remove();
    if (a) a.finished.then(done, done);
    else done();
  }

  // ---------------------------------------------------------------- checkbox tick + finished checklist

  function ticked(line, kids, i) {
    buzz(10);
    line.classList.remove("c16-ticked");
    void line.offsetWidth;
    line.classList.add("c16-ticked");
    S.win.setTimeout(() => line.classList.remove("c16-ticked"), 700);
    const lines = kids.map((k) => ({ type: k.getAttribute("data-line-type"), checked: k.getAttribute("data-checked") === "true" }));
    const run = checklistRun(lines, i);
    if (run.total >= 2 && run.done === run.total) celebrate(kids[run.to], run.total);
  }

  function celebrate(lastLine, total) {
    const paper = S.editor && S.editor.parentNode;
    if (!paper || !lastLine) return;
    for (const old of paper.querySelectorAll(".c16-done")) old.remove();
    const num = el("span", { class: "c16-done-num", text: calm() ? total + "/" + total : "0/" + total });
    const chip = el("div", { class: "c16-done", role: "status", "aria-live": "polite" }, [
      el("span", { class: "c16-done-mark", "aria-hidden": "true", text: "✓" }),
      el("span", { text: "Liste terminée" }),
      num,
    ]);
    chip.setAttribute("aria-label", "Liste terminée : " + total + " sur " + total);
    chip.style.top = (lastLine.offsetTop + lastLine.offsetHeight + (S.editor.offsetTop || 0) + 4) + "px";
    paper.appendChild(chip);
    buzz(14);
    burst(lastLine.querySelector(".carnet-check") || lastLine);
    if (!calm()) {
      const t0 = Date.now();
      const step = () => {
        const p = Math.min(1, (Date.now() - t0) / 520);
        num.textContent = Math.round(p * total) + "/" + total;
        if (p < 1) S.win.requestAnimationFrame(step);
      };
      S.win.requestAnimationFrame(step);
    }
    S.win.setTimeout(() => {
      chip.classList.add("is-out");
      S.win.setTimeout(() => chip.remove(), 320);
    }, 2200);
  }

  // ---------------------------------------------------------------- images shimmer until loaded

  function markLoading(ed) {
    if (!ed) return;
    for (const img of ed.querySelectorAll("img")) {
      if (!img.complete) img.classList.add("c16-loading");
    }
  }

  function onMediaLoad(ev) {
    const t = ev.target;
    if (t && t.tagName === "IMG") {
      if (t.classList.contains("c16-loading") && ev.type === "load") {
        animate(t, [{ opacity: 0, transform: "scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      t.classList.remove("c16-loading");
      scheduleSnapshot();
    }
  }

  // ---------------------------------------------------------------- menus grow from what was tapped; save pill check; inspector

  function onRootMutations(records) {
    for (const r of records) {
      const t = r.target;
      if (!t || !t.matches) continue;
      if (r.attributeName === "hidden" && !t.hidden && t.matches(MENU_SEL)) growFrom(t);
      else if (r.attributeName === "hidden" && !t.hidden && t.classList.contains("carnet-library")) libraryOpened(t);
      else if (r.attributeName === "data-kind" && t.id === "hq-carnet-savepill") savePill(t);
    }
  }

  function onBodyMutations(records) {
    for (const r of records) {
      if (r.type === "attributes") {
        const t = r.target;
        if (t && !t.hidden && t.matches && t.matches(MENU_SEL)) growFrom(t);
        if (t && !t.hidden && t.id === "hq-carnet-inspector") inspectorOpened(t);
        continue;
      }
      for (const n of r.addedNodes) {
        if (!n || n.nodeType !== 1 || !n.matches) continue;
        if (!n.hidden && n.matches(MENU_SEL)) growFrom(n);
        if (n.id === "hq-carnet-inspector" && !n.hidden) inspectorOpened(n);
      }
    }
  }

  function growFrom(node) {
    const p = S.lastPointer;
    let point = p && Date.now() - p.t < 1200 ? p : null;
    if (!point) {
      const a = S.doc.activeElement;
      if (a && a.getBoundingClientRect && a !== S.doc.body) {
        const r = a.getBoundingClientRect();
        point = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    try {
      node.style.setProperty("--c16-origin", originFor(node.getBoundingClientRect(), point));
    } catch (_) {}
    if (calm()) return;
    const items = node.querySelectorAll("[role=menuitem],.carnet-cmd-item,.carnet-block-item,.carnet-sel-btn,.carnet-insert-item,.carnet-outline-item,.carnet-outline-body button");
    for (let i = 0; i < items.length && i < 12; i += 1) {
      animate(items[i], [{ opacity: 0, transform: "translate3d(0,6px,0)" }, { opacity: 1, transform: "none" }], { duration: 220, delay: 40 + i * 16, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    }
    if (S.lastPointerType === "touch") buzz(5);
  }

  // ---------------------------------------------------------------- 16E: small pleasures (all transform / opacity, all skipped with reduced motion)

  const RIPPLE_SEL = ".hq-carnet button,.carnet-sticky button,.c16-toast button,.hq-carnet [role=menuitem],.carnet-block-menu button,.carnet-cmd-menu button,.carnet-sel-toolbar button";

  /** Ink that spreads from the exact point you pressed, inside the button you pressed. */
  function ripple(ev) {
    if (calm() || (ev.button != null && ev.button > 0)) return;
    const b = ev.target && ev.target.closest ? ev.target.closest(RIPPLE_SEL) : null;
    if (!b || b.disabled || b.getAttribute("aria-disabled") === "true" || b.classList.contains("carnet-check")) return;
    if (S.editor && S.editor.contains(b)) return; // never inside the page text
    const r = b.getBoundingClientRect();
    if (!(r.width > 0) || r.width > 560 || r.height > 160) return;
    const rel = S.win.getComputedStyle(b).position === "static";
    if (rel) b.classList.add("c16-rel");
    b.classList.add("c16-clip");
    const d = 2 * Math.hypot(Math.max(ev.clientX - r.left, r.right - ev.clientX), Math.max(ev.clientY - r.top, r.bottom - ev.clientY));
    const dot = el("span", { class: "c16-ripple", "aria-hidden": "true" });
    dot.style.width = d + "px";
    dot.style.height = d + "px";
    dot.style.left = (ev.clientX - r.left - d / 2) + "px";
    dot.style.top = (ev.clientY - r.top - d / 2) + "px";
    b.appendChild(dot);
    const a = animate(dot, [{ transform: "scale(0)", opacity: 0.3 }, { transform: "scale(1)", opacity: 0 }], { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)" });
    const done = () => {
      dot.remove();
      if (!b.querySelector(".c16-ripple")) {
        b.classList.remove("c16-clip");
        if (rel) b.classList.remove("c16-rel");
      }
    };
    if (a) a.finished.then(done, done);
    else done();
  }

  /** A few confetti dots from a point (a finished checklist). */
  function burst(from) {
    if (calm() || !from || !from.getBoundingClientRect) return;
    const r = from.getBoundingClientRect();
    const cx = r.left + Math.min(r.width, 32) / 2;
    const cy = r.top + r.height / 2;
    const colors = ["var(--accent)", "var(--ok)", "#ffcf5a", "#ff8fb3", "#7dd3fc"];
    const n = 16;
    for (let i = 0; i < n; i += 1) {
      const dot = el("span", { class: "c16-confetti", "aria-hidden": "true" });
      dot.style.left = cx + "px";
      dot.style.top = cy + "px";
      dot.style.background = colors[i % colors.length];
      if (i % 3 === 0) dot.style.borderRadius = "2px";
      S.doc.body.appendChild(dot);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 34 + Math.random() * 46;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist - 18;
      const a = animate(dot, [
        { transform: "translate3d(-50%,-50%,0) scale(1) rotate(0deg)", opacity: 1 },
        { transform: "translate3d(calc(-50% + " + dx.toFixed(1) + "px),calc(-50% + " + dy.toFixed(1) + "px),0) scale(.9) rotate(" + Math.round(dx * 4) + "deg)", opacity: 1, offset: 0.7 },
        { transform: "translate3d(calc(-50% + " + (dx * 1.1).toFixed(1) + "px),calc(-50% + " + (dy + 26).toFixed(1) + "px),0) scale(.2)", opacity: 0 },
      ], { duration: 720 + Math.random() * 240, easing: "cubic-bezier(.2,.8,.3,1)" });
      const rm = () => dot.remove();
      if (a) a.finished.then(rm, rm);
      else rm();
    }
  }

  /** "1 / 4" rolls up (next) or down (previous) when the page changes. */
  function watchIndicator() {
    const ind = S.doc.getElementById("carnet-page-indicator");
    if (!ind || ind.__c16) return;
    ind.__c16 = true;
    let last = ind.textContent;
    new S.win.MutationObserver(() => {
      const t = ind.textContent;
      if (t === last) return;
      const a = parseInt(last, 10);
      const b = parseInt(t, 10);
      last = t;
      if (!(a > 0) || !(b > 0) || a === b) return;
      const dir = b > a ? 1 : -1;
      animate(ind, [{ transform: "translate3d(0," + dir * 70 + "%,0)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2,1.1,.32,1)" });
    }).observe(ind, { childList: true, characterData: true, subtree: true });
  }

  /** The library's cards arrive one after the other when it opens. */
  function libraryOpened(lib) {
    if (calm()) return;
    const cards = lib.querySelectorAll(".carnet-card");
    for (let i = 0; i < cards.length && i < 14; i += 1) {
      animate(cards[i], [{ opacity: 0, transform: "translate3d(0,10px,0) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 30 + i * 22, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    }
  }

  /** Dropping a dragged block: measure where things LOOK (the lift preview moved them) so the settle starts from there. */
  function snapshotVisual() {
    S.tops = new Map();
    for (const k of lineKids()) {
      const dy = parseFloat(k.style.getPropertyValue("--c16-dy")) || 0;
      S.tops.set(keyOf(k), k.offsetTop + dy);
    }
  }

  function savePill(pill) {
    const kind = pill.getAttribute("data-kind") || "";
    const was = S.savedKind;
    S.savedKind = kind;
    if (kind === "ok" && was === "busy") {
      pill.classList.remove("c16-saved");
      void pill.offsetWidth;
      pill.classList.add("c16-saved");
      S.win.setTimeout(() => pill.classList.remove("c16-saved"), 1800);
    }
  }

  function inspectorOpened(insp) {
    const src = S.lastAtom;
    S.lastAtom = null;
    if (!src || Date.now() - src.t > 1500 || calm()) return;
    S.win.requestAnimationFrame(() => {
      const vp = insp.querySelector(".carnet-insp-viewport");
      if (!vp) return;
      const to = vp.getBoundingClientRect();
      if (!(to.width > 0) || !(to.height > 0)) return;
      const sx = src.r.width / to.width;
      const sy = src.r.height / to.height;
      const s = Math.max(0.05, Math.min(sx, sy));
      const dx = src.r.left + src.r.width / 2 - (to.left + to.width / 2);
      const dy = src.r.top + src.r.height / 2 - (to.top + to.height / 2);
      animate(vp, [{ transform: "translate3d(" + dx + "px," + dy + "px,0) scale(" + s + ")", opacity: 0.6 }, { transform: "none", opacity: 1 }], { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  }

  // ---------------------------------------------------------------- DF-1: the page bar folds into the field dock on phones

  function syncDock() {
    const rootEl = S.root;
    if (!rootEl) return;
    const hud = rootEl.querySelector("#hq-carnet-field-hud");
    const want = !!hud && narrow() && !rootEl.classList.contains("is-focus");
    const D = S.dock;
    if (want && !D) dockIn(rootEl, hud);
    else if (!want && D) dockOut();
  }

  function dockIn(rootEl, hud) {
    const prev = rootEl.querySelector("#btn-carnet-prev");
    const next = rootEl.querySelector("#btn-carnet-next");
    const ind = rootEl.querySelector("#carnet-page-indicator");
    const copy = rootEl.querySelector("#btn-carnet-copy");
    const add = rootEl.querySelector("#btn-carnet-new");
    const nav = rootEl.querySelector(".carnet-bar-bottom .carnet-nav");
    const actions = rootEl.querySelector(".carnet-bar-bottom .carnet-actions");
    if (!prev || !next || !ind || !copy || !add || !nav || !actions) return;
    const chip = el("div", { class: "carnet-dock-chip", role: "group", "aria-label": "Page" });
    chip.append(copy, ind, add);
    const live = hud.querySelector(".carnet-field-live");
    prev.classList.add("carnet-dock-edge");
    next.classList.add("carnet-dock-edge");
    hud.insertBefore(prev, hud.firstChild);
    hud.insertBefore(next, live || null);
    hud.appendChild(chip);
    rootEl.classList.add("carnet-docked");
    S.dock = { rootEl, hud, prev, next, ind, copy, add, nav, actions, chip };
  }

  function dockOut() {
    const D = S.dock;
    S.dock = null;
    if (!D) return;
    D.prev.classList.remove("carnet-dock-edge");
    D.next.classList.remove("carnet-dock-edge");
    D.nav.append(D.prev, D.ind, D.next);
    D.actions.append(D.copy, D.add);
    D.chip.remove();
    D.rootEl.classList.remove("carnet-docked");
  }

  // ---------------------------------------------------------------- DF-3: the Capture button tucks away while typing / scrolling

  function tuck() {
    const b = S.doc.body;
    if (!b || !inCarnet()) return;
    b.classList.add("hq-fab-tucked");
    if (S.fabTimer) S.win.clearTimeout(S.fabTimer);
    S.fabTimer = S.win.setTimeout(untuck, 1400);
  }

  function untuck() {
    if (S.fabTimer) S.win.clearTimeout(S.fabTimer);
    S.fabTimer = 0;
    if (S.doc.body) S.doc.body.classList.remove("hq-fab-tucked");
  }

  function onEditorActivity(ev) {
    tuck();
    scheduleCaret();
    if (ev && ev.type === "keydown") quietChrome(ev);
  }

  // 16H: on PC the page's chrome (bars, library) fades while you type and comes back as soon as the mouse moves a little,
  // you scroll up, or the editor loses focus. Hovering or tabbing into a bar always shows it at once (CSS).
  let quietTravel = 0;
  function quietChrome(ev) {
    if (!S.root || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key || "";
    if (!(k.length === 1 || k === "Enter" || k === "Backspace" || k === "Delete")) return;
    let fine = false;
    try {
      fine = S.win.matchMedia("(hover:hover) and (pointer:fine)").matches;
    } catch (_) {}
    if (!fine) return;
    quietTravel = 0;
    S.root.classList.add("c16-quiet");
  }

  function wakeChrome() {
    if (S.root && S.root.classList.contains("c16-quiet")) S.root.classList.remove("c16-quiet");
  }

  function onEditorBlur() {
    wakeChrome();
    if (S.fabTimer) S.win.clearTimeout(S.fabTimer);
    S.fabTimer = S.win.setTimeout(untuck, 350);
  }

  // ---------------------------------------------------------------- keyboard: keep the caret above the keyboard and the dock

  function keyboardHeight() {
    const vv = S.win.visualViewport;
    if (!vv) return 0;
    return Math.max(0, (S.win.innerHeight || 0) - vv.height - vv.offsetTop);
  }

  function onViewport() {
    const kb = keyboardHeight();
    if (S.root) {
      S.root.setAttribute("data-c16-kb", kb > 80 ? "open" : "closed");
      S.root.style.setProperty("--c16-kb", Math.round(kb) + "px");
    }
    scheduleCaret();
  }

  function scheduleCaret() {
    if (S.caretRaf) return;
    S.caretRaf = S.win.requestAnimationFrame(keepCaret);
  }

  function keepCaret() {
    S.caretRaf = 0;
    const ed = S.editor;
    const vv = S.win.visualViewport;
    if (!ed || !vv || S.doc.activeElement !== ed || keyboardHeight() < 80) return;
    const sel = S.win.getSelection && S.win.getSelection();
    if (!sel || !sel.rangeCount || !ed.contains(sel.focusNode)) return;
    let rect = null;
    try {
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(false);
      const rs = r.getClientRects();
      rect = rs && rs.length ? rs[rs.length - 1] : null;
      if (!rect || !(rect.height > 0)) {
        let n = sel.focusNode;
        while (n && n.parentNode !== ed) n = n.parentNode;
        rect = n && n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      }
    } catch (_) {
      rect = null;
    }
    if (!rect) return;
    let bottom = vv.offsetTop + vv.height;
    const hud = S.root && S.root.querySelector("#hq-carnet-field-hud");
    if (hud && hud.offsetParent !== null) {
      const hr = hud.getBoundingClientRect();
      if (hr.height > 0 && hr.top < bottom) bottom = hr.top;
      const chip = hud.querySelector(".carnet-dock-chip");
      if (chip && chip.offsetParent !== null) {
        const cr = chip.getBoundingClientRect();
        if (cr.height > 0 && cr.top < bottom) bottom = cr.top;
      }
    }
    const d = caretScroll(rect.bottom, bottom, 18);
    if (d > 0) S.win.scrollBy({ top: d, behavior: calm() ? "auto" : "smooth" });
  }

  /** The editor line under a pointer. In the margin the target is the editor itself (its padding), so the line is found by height. */
  function lineAt(t, y) {
    let line = t && t.nodeType === 1 ? t : t && t.parentNode;
    if (line === S.editor) {
      for (const k of S.editor.children) {
        if (!k.hasAttribute || !k.hasAttribute("data-line-type")) continue;
        const r = k.getBoundingClientRect();
        if (y >= r.top && y < r.bottom) return k;
      }
      return null;
    }
    while (line && line.parentNode !== S.editor) line = line.parentNode;
    return line && line.hasAttribute && line.hasAttribute("data-line-type") ? line : null;
  }

  // ---------------------------------------------------------------- long-press a block (touch): its menu

  let press = null;
  function onEditorPointerDown(ev) {
    press = null;
    if (ev.pointerType !== "touch" || !S.editor) return;
    const t = ev.target;
    const line = lineAt(t, ev.clientY);
    if (!line) return;
    const atom = t.closest ? t.closest(ATOM_SEL) : null;
    const er = S.editor.getBoundingClientRect();
    let gutter = 34;
    try {
      gutter = parseFloat(S.win.getComputedStyle(S.editor).getPropertyValue("--carnet-margin-x")) || 34;
    } catch (_) {}
    const inGutter = ev.clientX < er.left + gutter + 4;
    if (atom) S.lastAtom = { r: atom.getBoundingClientRect(), t: Date.now() };
    if (!atom && !inGutter) return; // inside the text a long-press belongs to the system (selection, magnifier)
    press = { x: ev.clientX, y: ev.clientY, line, fired: false };
    press.timer = S.win.setTimeout(() => {
      if (!press || press.line !== line || !line.isConnected) return;
      press.fired = true;
      if (typeof global.hqCarnetBlockMenu === "function" && global.hqCarnetBlockMenu(line)) {
        buzz(12);
        animate(line, [{ transform: "scale(.985)" }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,1.35,.35,1)" });
      }
    }, 520);
  }

  function pressCancel(ev) {
    if (!press) return;
    if (ev && ev.type === "pointermove" && (press.fired || Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 9)) return;
    S.win.clearTimeout(press.timer);
    if (press.fired && ev && ev.type === "pointerup") press.until = Date.now() + 450; // swallow only the click of this release
    else press = null;
  }

  function pressSwallow(ev) {
    if (!press || !press.until) return;
    const live = Date.now() < press.until;
    press = null;
    if (live) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  /** PC equivalent of the long-press: a right-click in the left margin of a block, or on an atom (image, card, drawing…), opens
   *  that block's menu. Inside the text the browser's own menu stays (spelling, copy / paste). */
  function rightClickBlock(ev) {
    if (!S.editor) return;
    const t = ev.target;
    if (!t || !S.editor.contains(t) || ev.shiftKey) return;
    const line = lineAt(t, ev.clientY);
    if (!line) return;
    const atom = t.closest ? t.closest(ATOM_SEL) : null;
    let gutter = 34;
    try {
      gutter = parseFloat(S.win.getComputedStyle(S.editor).getPropertyValue("--carnet-margin-x")) || 34;
    } catch (_) {}
    const inGutter = ev.clientX < S.editor.getBoundingClientRect().left + gutter + 4;
    if (!atom && !inGutter) return;
    if (typeof global.hqCarnetBlockMenu === "function" && global.hqCarnetBlockMenu(line)) ev.preventDefault();
  }

  // ---------------------------------------------------------------- the "Annuler" toast

  function toast(o) {
    if (!o || !S.doc || !S.doc.body) return null;
    if (S.toast) S.toast.close(true);
    const ttl = Math.max(2500, Math.min(15000, o.ttl || 6500));
    const text = el("span", { class: "c16-toast-text", text: o.text || "" });
    const act = el("button", { type: "button", class: "c16-toast-act", text: o.action || "Annuler" });
    const close = el("button", { type: "button", class: "c16-toast-close", "aria-label": "Fermer", text: "×" });
    const bar = el("span", { class: "c16-toast-bar", "aria-hidden": "true" });
    const box = el("div", { class: "c16-toast", role: o.onAction ? "group" : "status", "aria-label": o.text || "Action" }, o.onAction ? [text, act, close, bar] : [text, close, bar]);
    box.style.setProperty("--c16-ttl", ttl + "ms");
    S.doc.body.appendChild(box);
    const T = { box, closed: false, timer: 0, left: ttl, started: Date.now(), drag: null };
    const arm = () => {
      T.started = Date.now();
      T.timer = S.win.setTimeout(() => T.close(false), T.left);
      box.classList.remove("is-paused");
    };
    const pause = () => {
      if (!T.timer) return;
      S.win.clearTimeout(T.timer);
      T.timer = 0;
      T.left = Math.max(800, T.left - (Date.now() - T.started));
      box.classList.add("is-paused");
    };
    T.close = (instant, dir) => {
      if (T.closed) return;
      T.closed = true;
      if (T.timer) S.win.clearTimeout(T.timer);
      if (S.toast === T) S.toast = null;
      const a = instant ? null : animate(box, [{ opacity: 1 }, { opacity: 0, transform: dir ? "translate3d(" + dir * 120 + "%,0,0)" : "translate3d(-50%,14px,0)" }], { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
      const rm = () => box.remove();
      if (a) a.finished.then(rm, rm);
      else rm();
    };
    act.addEventListener("click", () => {
      let ok = false;
      try {
        ok = o.onAction ? o.onAction() !== false : true;
      } catch (_) {
        ok = false;
      }
      if (ok) buzz(10);
      T.close(false);
    });
    close.addEventListener("click", () => T.close(false));
    box.addEventListener("pointerenter", pause);
    box.addEventListener("pointerleave", () => {
      if (!T.closed && !box.contains(S.doc.activeElement)) arm();
    });
    box.addEventListener("focusin", pause);
    box.addEventListener("focusout", () => {
      S.win.setTimeout(() => {
        if (!T.closed && !box.contains(S.doc.activeElement)) arm();
      }, 0);
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") T.close(false);
    });
    // swipe to dismiss (touch / pen / mouse drag on the toast body)
    box.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      T.drag = { x: e.clientX, t: Date.now(), dx: 0, v: 0, lx: e.clientX, lt: Date.now() };
      pause();
      try {
        box.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    box.addEventListener("pointermove", (e) => {
      const d = T.drag;
      if (!d) return;
      const now = Date.now();
      d.v = (e.clientX - d.lx) / Math.max(1, now - d.lt);
      d.lx = e.clientX;
      d.lt = now;
      d.dx = e.clientX - d.x;
      box.style.setProperty("--c16-swipe", d.dx.toFixed(1) + "px");
      box.style.opacity = String(Math.max(0.2, 1 - Math.abs(d.dx) / 260));
    });
    const end = () => {
      const d = T.drag;
      T.drag = null;
      if (!d) return;
      if (dismissBySwipe(d.dx, d.v, box.offsetWidth)) {
        T.close(false, Math.sign(d.dx) || 1);
        return;
      }
      box.style.removeProperty("--c16-swipe");
      box.style.opacity = "";
      arm();
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    S.toast = T;
    arm();
    return T;
  }

  // ---------------------------------------------------------------- pull down at the top: outline, then library

  function bindPull() {
    const label = el("span", { class: "c16-pull-text", text: "Plan de la page" });
    const ind = el("div", { class: "c16-pull", "aria-hidden": "true" }, [el("span", { class: "c16-pull-arrow", text: "↓" }), label]);
    S.doc.body.appendChild(ind);
    let pull = null;
    const reset = () => {
      ind.classList.remove("is-on", "is-armed", "is-far");
      ind.style.removeProperty("--c16-pull");
    };
    S.doc.addEventListener("touchstart", (ev) => {
      pull = null;
      if (!inCarnet() || !S.root || (S.win.scrollY || 0) > 0 || !ev.touches || ev.touches.length !== 1) return;
      const t = ev.target;
      if (!t || !t.closest || !S.root.contains(t)) return;
      if (t.closest("input,textarea,select,table,.carnet-library,.carnet-outline,.carnet-field-hud,.carnet-sticky,[role=dialog]")) return;
      if (S.doc.activeElement === S.editor && keyboardHeight() > 80) return; // typing: the keyboard owns the gesture
      pull = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, d: 0, active: false, stage: 0 };
    }, { passive: true });
    S.doc.addEventListener("touchmove", (ev) => {
      if (!pull || !ev.touches || ev.touches.length !== 1) return;
      const dy = ev.touches[0].clientY - pull.y;
      const dx = ev.touches[0].clientX - pull.x;
      if (!pull.active) {
        if (dy < 0 || Math.abs(dx) > Math.abs(dy) || (S.win.scrollY || 0) > 0) {
          pull = null;
          return;
        }
        if (dy < 10) return;
        pull.active = true;
        ind.classList.add("is-on");
      }
      if (ev.cancelable) ev.preventDefault();
      pull.d = Math.min(170, (dy - 10) * 0.55);
      ind.style.setProperty("--c16-pull", pull.d.toFixed(1) + "px");
      const st = pullStage(pull.d);
      if (st !== pull.stage) {
        pull.stage = st;
        ind.classList.toggle("is-armed", st >= 1);
        ind.classList.toggle("is-far", st === 2);
        label.textContent = st === 2 ? "Bibliothèque" : "Plan de la page";
        if (st > 0) buzz(6);
      }
    }, { passive: false });
    // PC: the same gesture with a trackpad or wheel — scrolling UP while already at the very top of a page. Only a scroll that
    // STARTS at the top counts (momentum from scrolling up the page never opens anything).
    let wp = null;
    let lastWheel = 0;
    let atTopSince = 0;
    S.win.addEventListener("scroll", () => {
      atTopSince = (S.win.scrollY || 0) <= 0 ? Date.now() : 0;
    }, { passive: true });
    S.doc.addEventListener("wheel", (ev) => {
      const now = Date.now();
      const quiet = now - lastWheel > 350;
      lastWheel = now;
      if (!inCarnet() || !S.root || ev.ctrlKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
      const t = ev.target;
      if (!t || !t.closest || !S.root.contains(t) || t.closest("textarea,select,.carnet-library,.carnet-outline,.carnet-sticky,[role=dialog],.carnet-table-scroll")) return;
      if (!wp) {
        if (ev.deltaY >= 0 || (S.win.scrollY || 0) > 0 || !quiet || (atTopSince && now - atTopSince < 400)) return;
        wp = { d: 0, stage: 0, timer: 0 };
        ind.classList.add("is-on");
      }
      if (ev.deltaY > 0) {
        clearTimeout(wp.timer);
        wp = null;
        reset();
        return;
      }
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
      wp.d = Math.min(170, wp.d + Math.min(60, -ev.deltaY * unit) * 0.18);
      ind.style.setProperty("--c16-pull", wp.d.toFixed(1) + "px");
      const st = pullStage(wp.d);
      if (st !== wp.stage) {
        wp.stage = st;
        ind.classList.toggle("is-armed", st >= 1);
        ind.classList.toggle("is-far", st === 2);
        label.textContent = st === 2 ? "Bibliothèque" : "Plan de la page";
      }
      clearTimeout(wp.timer);
      wp.timer = setTimeout(() => {
        const g = wp;
        wp = null;
        reset();
        if (!g || !S.root) return;
        const id = g.stage === 2 ? "btn-carnet-library" : g.stage === 1 ? "btn-carnet-outline" : "";
        const b = id ? S.root.querySelector("#" + id) : null;
        if (b && !b.disabled && b.getAttribute("aria-expanded") !== "true") b.click();
      }, 260);
    }, { passive: true });
    const end = () => {
      const g = pull;
      pull = null;
      if (!g || !g.active) return;
      reset();
      if (!S.root) return;
      const id = g.stage === 2 ? "btn-carnet-library" : g.stage === 1 ? "btn-carnet-outline" : "";
      const b = id ? S.root.querySelector("#" + id) : null;
      if (b && !b.disabled && b.getAttribute("aria-expanded") !== "true") b.click();
    };
    S.doc.addEventListener("touchend", end, { passive: true });
    S.doc.addEventListener("touchcancel", () => {
      pull = null;
      reset();
    }, { passive: true });
  }

  // ---------------------------------------------------------------- start

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    const doc = S.doc;
    doc.addEventListener("pointerdown", (ev) => {
      S.lastPointer = { x: ev.clientX, y: ev.clientY, t: Date.now() };
      S.lastPointerType = ev.pointerType || "mouse";
      ripple(ev);
      const card = ev.target && ev.target.closest ? ev.target.closest(".carnet-library [data-carnet-page-id]") : null;
      if (card) S.lastCard = { r: card.getBoundingClientRect(), t: Date.now() };
      const atom = ev.target && ev.target.closest && S.editor && S.editor.contains(ev.target) ? ev.target.closest(ATOM_SEL) : null;
      if (atom) S.lastAtom = { r: atom.getBoundingClientRect(), t: Date.now() };
    }, true);
    doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        const card = ev.target && ev.target.closest ? ev.target.closest(".carnet-library [data-carnet-page-id]") : null;
        if (card) S.lastCard = { r: card.getBoundingClientRect(), t: Date.now() };
      }
    }, true);
    doc.addEventListener("pointermove", pressCancel, true);
    doc.addEventListener("mousemove", (ev) => {
      if (!S.root || !S.root.classList.contains("c16-quiet")) return;
      quietTravel += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0);
      if (quietTravel > 40) wakeChrome();
    }, { passive: true });
    let lastY = 0;
    win.addEventListener("scroll", () => {
      const y = win.scrollY || 0;
      if (y < lastY - 30) wakeChrome();
      lastY = y;
    }, { passive: true });
    doc.addEventListener("pointerup", () => {
      if (S.editor && S.editor.classList.contains("c16-lifting")) {
        snapshotVisual(); // before the drop is committed: the settle animation starts where the block was let go
        buzz(10);
      }
    }, true);
    doc.addEventListener("pointerup", pressCancel, true);
    doc.addEventListener("pointercancel", pressCancel, true);
    doc.addEventListener("click", pressSwallow, true);
    doc.addEventListener("contextmenu", (ev) => {
      if (press && press.fired) {
        ev.preventDefault(); // Android fires contextmenu on the same long-press
        return;
      }
      rightClickBlock(ev); // PC: right-click in the margin or on an image / card / drawing = the block menu
    }, true);
    doc.addEventListener("selectionchange", () => {
      if (S.editor && doc.activeElement === S.editor) scheduleCaret();
    });
    win.addEventListener("scroll", () => {
      if (inCarnet() && S.editor) tuck();
      pressCancel(null);
    }, { passive: true });
    win.addEventListener("resize", () => {
      syncDock();
      scheduleSnapshot();
    });
    if (win.visualViewport) {
      win.visualViewport.addEventListener("resize", onViewport);
      win.visualViewport.addEventListener("scroll", onViewport);
    }
    try {
      const mq = win.matchMedia(NARROW);
      if (mq.addEventListener) mq.addEventListener("change", syncDock);
    } catch (_) {}
    const boot = () => {
      if (!doc.body) return;
      S.bodyMo = new win.MutationObserver(onBodyMutations);
      S.bodyMo.observe(doc.body, { childList: true, attributes: true, attributeFilter: ["hidden"], subtree: false });
      // menus that live directly in <body> toggle `hidden` on themselves: watch those few nodes too
      const watchBodyKids = () => {
        for (const n of doc.body.children) {
          if (n.matches && (n.matches(MENU_SEL) || n.id === "hq-carnet-inspector") && !n.__c16) {
            n.__c16 = true;
            S.bodyMo.observe(n, { attributes: true, attributeFilter: ["hidden"] });
          }
        }
      };
      watchBodyKids();
      bindPull();
      watch();
      win.setInterval(() => {
        watch();
        watchBodyKids();
      }, 700);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, buzz, toast, pure };
});
