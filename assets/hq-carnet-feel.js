/* Transfert HQ — Carnet Phase 16I: how things leave, glide and settle (presentation only).
 *
 *   - Exits: menus, panels, the « ⋯ » tools, the format bar, the inspector and the phone sheets leave the way they came
 *     (a visual copy plays the exit; the real element is already hidden, so nothing waits on an animation).
 *   - Phone sheets (library, outline): slide up, follow the finger down, close past a quarter or with a flick.
 *   - Smooth caret (PC): the typing cursor glides between positions and blinks only when you pause.
 *   - Marker sweep when « Surligné » is applied; a stroke drawn across a ticked item.
 *   - A new page lands from the stack; a page sent to the Corbeille crumples and flies to it.
 *   - Library cards glide to their new place when the list changes; a pin drops in.
 *   - Outline: a marker follows the section you are reading.
 *   - Measurements and calculations count up when they come into view; the verdict badge pops.
 *   - Paper light (PC): the paper's shadow and sheen follow the mouse very slightly.
 *   - A newly inserted image opens from a ring.
 *
 * Never writes a note, never reads or writes storage, never touches the network, never builds HTML from strings, never
 * changes the text inside the editor (count-ups play on an overlay). Everything is skipped with reduced motion.
 * Plain ES2020. Pure helpers exported for Node tests (tests/check_hq_carnet_feel.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqCarnetFeel = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  // one motion vocabulary (the same curves as the Calendar and Accueil: --hq-spring / --hq-out)
  const EASE = {
    out: "cubic-bezier(.2,.8,.2,1)",
    in: "cubic-bezier(.4,0,1,1)",
    spring: "cubic-bezier(.2,1.35,.35,1)",
    soft: "cubic-bezier(.2,1.1,.32,1)",
  };
  const DUR = { fast: 140, base: 240, slow: 380 };

  // ------------------------------------------------------------------ pure helpers

  /** Number at the start of a displayed value ("12,034 mm", "−3.5", "1 250 N"): {n, decimals, comma, rest} or null. */
  function parseLeadingNumber(text) {
    const m = /^\s*([-−]?)(\d+(?:[   ]\d{3})*)(?:([.,])(\d+))?(.*)$/s.exec(String(text || ""));
    if (!m) return null;
    const int = m[2].replace(/[   ]/g, "");
    if (!int || int.length > 12) return null;
    const dec = m[4] || "";
    const n = Number(int + (dec ? "." + dec : "")) * (m[1] ? -1 : 1);
    if (!isFinite(n)) return null;
    return { n, decimals: dec.length, comma: m[3] === ",", neg: !!m[1], rest: m[5] || "", grouped: /[   ]/.test(m[2]) };
  }

  /** Format a counting value like the original. */
  function formatLike(v, p) {
    const s = Math.abs(v).toFixed(p.decimals);
    let [i, d] = s.split(".");
    if (p.grouped) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (v < 0 || (p.neg && v === 0 && p.n < 0) ? "−" : "") + i + (d ? (p.comma ? "," : ".") + d : "") + p.rest;
  }

  /** Snap a 1-D position to the nearest target within `r` px. Returns {v, at} (at = the target used, or null). */
  function snap1(v, targets, r) {
    let best = null;
    for (const t of targets) if (Math.abs(v - t) <= r && (best === null || Math.abs(v - t) < Math.abs(v - best))) best = t;
    return best === null ? { v, at: null } : { v: best, at: best };
  }

  /** Should a sheet dragged by `dy` px (of `h`) with velocity `v` px/ms close? */
  function sheetCloses(dy, h, v) {
    return dy > Math.max(80, h * 0.25) || (v > 0.6 && dy > 24);
  }

  /** The outline item to mark: the last one whose line top is above `line` px (else the first). */
  function activeIndex(tops, line) {
    let a = 0;
    for (let i = 0; i < tops.length; i += 1) if (tops[i] <= line) a = i;
    return a;
  }

  const pure = { parseLeadingNumber, formatLike, snap1, sheetCloses, activeIndex, EASE, DUR };

  // ------------------------------------------------------------------ browser layer

  const S = {
    started: false, win: null, doc: null, editor: null, paper: null, root: null,
    caret: null, caretOn: false, typingTimer: 0, caretRaf: 0, composing: false,
    hl: new Map(), checks: new Map(), keys: [], pageId: "",
    newAt: 0, trashSnap: null, lib: null, libTops: new Map(), pins: new Set(), libMo: null,
    outlineRaf: 0, lightRaf: 0, edMo: null, exitMo: null,
  };

  const EXIT_SEL = ".carnet-cmd-menu,.carnet-block-menu,.carnet-sel-toolbar,.carnet-insert-menu,.carnet-savepop,.carnet-context,.carnet-outline,.carnet-link-panel," +
    ".carnet-tools,.carnet-format,.carnet-library,.carnet-lib-backdrop,.carnet-inspector";

  function mq(q) {
    try {
      return !!S.win.matchMedia(q).matches;
    } catch (_) {
      return false;
    }
  }
  const calm = () => mq("(prefers-reduced-motion: reduce)");
  const fine = () => mq("(hover:hover) and (pointer:fine)");

  function el(tag, attrs) {
    const n = S.doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    return n;
  }

  function animate(node, frames, opts) {
    if (!node || typeof node.animate !== "function" || calm()) return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }

  function done(a, fn) {
    if (a) a.finished.then(fn, fn);
    else fn();
  }

  function buzz(ms) {
    const M = S.win.HqCarnetMotion;
    if (M && typeof M.buzz === "function") M.buzz(ms);
  }

  const lines = () => (S.editor ? Array.prototype.filter.call(S.editor.children, (k) => k.hasAttribute && k.hasAttribute("data-line-type")) : []);
  const keyOf = (k) => k.getAttribute("data-carnet-block-id") || k.getAttribute("data-carnet-tmp") || "";

  // ================================================================= exits

  /** Strip everything that makes a copy findable or focusable; keep classes, styles and look-related data. */
  function inertCopy(node) {
    const c = node.cloneNode(true);
    const scrub = (n) => {
      if (n.nodeType !== 1) return;
      for (const a of Array.prototype.slice.call(n.attributes)) {
        const k = a.name;
        if (k === "id" || k === "role" || k === "tabindex" || k === "name" || k === "for" || k === "contenteditable" || k.indexOf("aria-") === 0 || k.indexOf("data-carnet") === 0) n.removeAttribute(k);
      }
      for (const ch of n.children) scrub(ch);
    };
    scrub(c);
    c.setAttribute("aria-hidden", "true");
    c.setAttribute("inert", "");
    c.classList.add("c16-ghost");
    return c;
  }

  function onExitMutations(records) {
    if (calm()) return;
    const seen = new Set();
    for (const r of records) {
      const t = r.target;
      if (seen.has(t) || !t || t.nodeType !== 1 || !t.hidden || r.oldValue !== null) continue; // only visible -> hidden
      if (!t.matches || !t.matches(EXIT_SEL) || t.classList.contains("c16-ghost")) continue;
      if (t.classList.contains("carnet-library") && !/^(sheet|drawer)$/.test(t.getAttribute("data-mode") || "")) continue; // the docked library never "leaves"
      seen.add(t);
    }
    if (!seen.size) return;
    for (const t of seen) playExit(t);
    if (S.exitMo) S.exitMo.takeRecords(); // our own measuring toggles are not news
  }

  function playExit(t) {
    // measure while (briefly) shown — synchronously, before the browser paints anything
    t.hidden = false;
    const cs = S.win.getComputedStyle(t);
    const display = cs.display;
    const pos = cs.position;
    const rect = t.getBoundingClientRect();
    const scrollTop = t.scrollTop;
    const ghost = rect.width && rect.height && display !== "none" ? inertCopy(t) : null;
    t.hidden = true;
    if (!ghost) return;
    ghost.setAttribute("hidden", "");
    ghost.style.setProperty("display", display, "important");
    ghost.style.setProperty("pointer-events", "none", "important");
    t.parentNode.insertBefore(ghost, t.nextSibling);
    if (scrollTop) ghost.scrollTop = scrollTop;
    const mode = t.getAttribute("data-mode") || "";
    const phoneSheet = (t.classList.contains("carnet-outline") && pos === "fixed") || mode === "sheet";
    let a;
    if (phoneSheet) {
      const from = t.style.transform || "translate3d(0,0,0)";
      a = animate(ghost, [{ transform: from }, { transform: "translate3d(0,105%,0)" }], { duration: DUR.base, easing: EASE.in, fill: "forwards" });
    } else if (mode === "drawer") {
      a = animate(ghost, [{ transform: "none" }, { transform: "translate3d(-105%,0,0)" }], { duration: DUR.base, easing: EASE.in, fill: "forwards" });
    } else if (t.classList.contains("carnet-lib-backdrop") || t.classList.contains("carnet-inspector")) {
      a = animate(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.base, easing: "linear", fill: "forwards" });
    } else if (pos === "static" || pos === "relative") {
      // in the flow (the « ⋯ » tools, the format bar): fold up so what is below glides up instead of jumping
      ghost.style.overflow = "hidden";
      a = animate(ghost, [
        { height: rect.height + "px", opacity: 1 },
        { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" },
      ], { duration: DUR.base, easing: EASE.out, fill: "forwards" });
    } else {
      // floating menus: shrink back toward where they grew from
      a = animate(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.94)" }], { duration: DUR.fast, easing: EASE.in, fill: "forwards" });
    }
    done(a, () => ghost.remove());
    S.win.setTimeout(() => ghost.isConnected && ghost.remove(), 900); // never left behind
  }

  // ================================================================= phone sheets: follow the finger

  function bindSheets() {
    let g = null;
    S.doc.addEventListener("touchstart", (ev) => {
      g = null;
      if (!ev.touches || ev.touches.length !== 1) return;
      const t = ev.target;
      const sheet = t && t.closest ? t.closest('.carnet-library[data-mode="sheet"],.carnet-outline') : null;
      if (!sheet || S.win.getComputedStyle(sheet).position !== "fixed") return;
      if (t.closest("input,textarea,select,.carnet-lib-tools,.carnet-sticky")) return;
      const head = t.closest(".carnet-lib-head,.carnet-outline-head");
      if (!head && sheet.scrollTop > 0) return; // scrolling the list, not the sheet
      g = { sheet, y: ev.touches[0].clientY, x: ev.touches[0].clientX, dy: 0, v: 0, lt: Date.now(), ly: ev.touches[0].clientY, on: false, h: sheet.getBoundingClientRect().height };
    }, { passive: true });
    S.doc.addEventListener("touchmove", (ev) => {
      if (!g || !ev.touches || ev.touches.length !== 1) return;
      const y = ev.touches[0].clientY;
      const dy = y - g.y;
      if (!g.on) {
        if (Math.abs(ev.touches[0].clientX - g.x) > Math.abs(dy) || dy < 8) {
          if (dy < -4 || Math.abs(ev.touches[0].clientX - g.x) > 12) g = null;
          return;
        }
        g.on = true;
      }
      if (ev.cancelable) ev.preventDefault();
      const now = Date.now();
      g.v = g.v * 0.4 + ((y - g.ly) / Math.max(1, now - g.lt)) * 0.6;
      g.ly = y;
      g.lt = now;
      g.dy = Math.max(0, dy);
      g.sheet.style.transform = "translate3d(0," + g.dy.toFixed(1) + "px,0)";
      g.sheet.style.transition = "none";
      const bd = S.doc.querySelector(".carnet-lib-backdrop:not([hidden])");
      if (bd && g.sheet.classList.contains("carnet-library")) bd.style.opacity = String(Math.max(0, 1 - g.dy / g.h));
    }, { passive: false });
    const end = () => {
      const s = g;
      g = null;
      if (!s || !s.on) return;
      const bd = S.doc.querySelector(".carnet-lib-backdrop");
      if (sheetCloses(s.dy, s.h, s.v)) {
        buzz(8);
        const btn = s.sheet.querySelector("#btn-carnet-lib-close,.carnet-outline-close");
        if (btn) btn.click(); // the exit copy starts from where the finger left it
        S.win.requestAnimationFrame(() => {
          s.sheet.style.transform = "";
          s.sheet.style.transition = "";
          if (bd) bd.style.opacity = "";
        });
        return;
      }
      const a = animate(s.sheet, [{ transform: s.sheet.style.transform }, { transform: "translate3d(0,0,0)" }], { duration: DUR.slow, easing: EASE.soft });
      s.sheet.style.transform = "";
      s.sheet.style.transition = "";
      if (bd) bd.style.opacity = "";
      if (!a) return;
    };
    S.doc.addEventListener("touchend", end, { passive: true });
    S.doc.addEventListener("touchcancel", end, { passive: true });
  }

  // ================================================================= smooth caret (PC)

  function caretWanted() {
    return fine() && !calm() && S.editor && S.doc.activeElement === S.editor && !S.composing;
  }

  function caretHide() {
    if (S.caret) S.caret.classList.remove("is-on");
    if (S.editor) S.editor.classList.remove("c16-caret-on");
    S.caretOn = false;
  }

  function caretRect() {
    const sel = S.win.getSelection && S.win.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !S.editor.contains(sel.focusNode)) return null;
    const r = sel.getRangeAt(0);
    let rect = null;
    try {
      const rs = r.getClientRects();
      for (const x of rs) if (x.height > 0) rect = x;
      if (!rect) {
        const b = r.getBoundingClientRect();
        if (b && b.height > 0) rect = b;
      }
    } catch (_) {
      rect = null;
    }
    if (!rect) {
      // an empty line: the caret sits at the line's text start
      let n = sel.focusNode;
      if (n && n.nodeType === 3) n = n.parentNode;
      while (n && n.parentNode !== S.editor && n !== S.editor) n = n.parentNode;
      if (!n || n === S.editor || !n.getBoundingClientRect) return null;
      const b = n.getBoundingClientRect();
      const cs = S.win.getComputedStyle(n);
      const lh = parseFloat(cs.lineHeight) || b.height;
      rect = { left: b.left + (parseFloat(cs.paddingLeft) || 0), top: b.top + (parseFloat(cs.paddingTop) || 0), height: Math.min(lh, b.height || lh) };
    }
    return rect;
  }

  function caretUpdate() {
    S.caretRaf = 0;
    if (!caretWanted()) {
      caretHide();
      return;
    }
    const rect = caretRect();
    if (!rect) {
      caretHide();
      return;
    }
    if (!S.caret || !S.caret.isConnected) {
      S.caret = el("div", { class: "c16-caret", "aria-hidden": "true" });
      S.paper.appendChild(S.caret);
    }
    const pr = S.paper.getBoundingClientRect();
    const fs = parseFloat(S.win.getComputedStyle(S.editor).fontSize) || 17;
    const h = Math.max(fs * 1.15, Math.min(rect.height, fs * 1.6));
    const x = rect.left - pr.left;
    const y = rect.top - pr.top + (rect.height - h) / 2;
    const last = S.caret.__p;
    const jump = !last || Math.hypot(x - last.x, y - last.y) > 180 || !S.caretOn;
    S.caret.classList.toggle("no-glide", jump);
    S.caret.style.height = h.toFixed(1) + "px";
    S.caret.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
    S.caret.__p = { x, y };
    if (!S.caretOn) {
      S.caret.classList.add("is-on");
      S.editor.classList.add("c16-caret-on");
      S.caretOn = true;
    }
  }

  function caretSchedule() {
    if (!S.caretRaf && S.win) S.caretRaf = S.win.requestAnimationFrame(caretUpdate);
  }

  function caretTyping() {
    if (!S.caret) return;
    S.caret.classList.add("is-typing");
    if (S.typingTimer) S.win.clearTimeout(S.typingTimer);
    S.typingTimer = S.win.setTimeout(() => S.caret && S.caret.classList.remove("is-typing"), 520);
  }

  // ================================================================= editor changes: sweeps, strokes, images, count-ups, new pages

  function snapshotLines() {
    const hl = new Map();
    const ch = new Map();
    const keys = [];
    for (const k of lines()) {
      const key = keyOf(k);
      keys.push(key);
      let s = "";
      for (const sp of k.querySelectorAll('[data-m~="highlight"]')) s += sp.textContent;
      hl.set(key, s);
      if (k.getAttribute("data-line-type") === "check") ch.set(key, k.getAttribute("data-checked") === "true");
    }
    return { hl, ch, keys };
  }

  function overlap(a, b) {
    if (!a.length || !b.length) return 0;
    const s = new Set(a);
    let n = 0;
    for (const k of b) if (s.has(k)) n += 1;
    return n / Math.max(a.length, b.length);
  }

  function onEditorChange() {
    if (!S.editor) return;
    const now = snapshotLines();
    const pid = S.editor.dataset.pageId || "";
    const samePage = pid === S.pageId && overlap(S.keys, now.keys) >= 0.5;
    if (samePage && !calm()) {
      const byKey = new Map();
      for (const k of lines()) byKey.set(keyOf(k), k);
      for (const [key, s] of now.hl) {
        const before = S.hl.has(key) ? S.hl.get(key) : null;
        if (before !== null && s.length > before.length) sweep(byKey.get(key));
      }
      for (const [key, c] of now.ch) if (c && S.checks.get(key) === false) strike(byKey.get(key));
      const prevKeys = new Set(S.keys);
      let added = 0;
      for (const key of now.keys) {
        if (prevKeys.has(key) || added > 3) continue;
        added += 1;
        const line = byKey.get(key);
        if (!line) continue;
        if (line.querySelector("img")) ringReveal(line);
        if (line.hasAttribute("data-carnet-eng")) countUp(line);
      }
    }
    if (pid !== S.pageId) pageArrived(pid);
    S.hl = now.hl;
    S.checks = now.ch;
    S.keys = now.keys;
    S.pageId = pid;
    caretSchedule();
  }

  function sweep(line) {
    if (!line) return;
    for (const sp of line.querySelectorAll('[data-m~="highlight"]')) {
      const c = S.win.getComputedStyle(sp).backgroundColor;
      sp.style.setProperty("--c16-hl", c);
      sp.classList.add("c16-sweep");
      S.win.setTimeout(() => {
        sp.classList.remove("c16-sweep");
        sp.style.removeProperty("--c16-hl");
      }, 700);
    }
  }

  function strike(line) {
    if (!line) return;
    const r = S.doc.createRange();
    try {
      r.selectNodeContents(line);
    } catch (_) {
      return;
    }
    const lr = line.getBoundingClientRect();
    const box = line.querySelector(".carnet-check");
    const minLeft = box ? box.getBoundingClientRect().right - 1 : lr.left;
    const rects = Array.prototype.filter.call(r.getClientRects(), (x) => x.width > 3 && x.height > 0 && x.left >= minLeft - 1).slice(0, 6);
    if (!rects.length) return;
    line.classList.add("c16-striking");
    let i = 0;
    for (const x of rects) {
      const bar = el("span", { class: "c16-strike", "aria-hidden": "true" });
      bar.style.left = x.left + "px";
      bar.style.top = (x.top + x.height * 0.56) + "px";
      bar.style.width = x.width + "px";
      S.doc.body.appendChild(bar);
      const a = animate(bar, [{ transform: "scaleX(0)", opacity: 1 }, { transform: "scaleX(1)", opacity: 1, offset: 0.7 }, { transform: "scaleX(1)", opacity: 0 }], { duration: 520, delay: i * 70, easing: EASE.out, fill: "backwards" });
      done(a, () => bar.remove());
      i += 1;
    }
    S.win.setTimeout(() => line.classList.remove("c16-striking"), 300 + i * 70);
  }

  function ringReveal(line) {
    const fig = line.querySelector("figure,img");
    if (!fig) return;
    animate(fig, [{ clipPath: "circle(0% at 50% 50%)", opacity: 0.6 }, { clipPath: "circle(75% at 50% 50%)", opacity: 1 }], { duration: 560, easing: EASE.out });
    const r = fig.getBoundingClientRect();
    const ring = el("span", { class: "c16-ring", "aria-hidden": "true" });
    const d = Math.min(r.width, r.height) * 0.5;
    ring.style.left = (r.left + r.width / 2 - d / 2) + "px";
    ring.style.top = (r.top + r.height / 2 - d / 2) + "px";
    ring.style.width = d + "px";
    ring.style.height = d + "px";
    S.doc.body.appendChild(ring);
    const a = animate(ring, [{ transform: "scale(.2)", opacity: 0.9 }, { transform: "scale(2.6)", opacity: 0 }], { duration: 620, easing: EASE.out });
    done(a, () => ring.remove());
  }

  /** Values count up on an overlay; the editor's own text is never changed. */
  function countUp(line) {
    if (calm()) return;
    const vr = line.getBoundingClientRect();
    const vh = S.win.innerHeight || 800;
    if (vr.bottom < 0 || vr.top > vh) return;
    const target = line.querySelector(".carnet-eng-result") || line.querySelector(".carnet-eng-card > .carnet-eng-body");
    if (target) {
      const p = parseLeadingNumber(target.textContent);
      if (p && Math.abs(p.n) > 0) {
        const r = target.getBoundingClientRect();
        const cs = S.win.getComputedStyle(target);
        const o = el("span", { class: "c16-count", "aria-hidden": "true" });
        o.style.left = r.left + "px";
        o.style.top = r.top + "px";
        o.style.minWidth = r.width + "px";
        o.style.font = cs.font;
        o.style.color = cs.color;
        o.style.lineHeight = cs.lineHeight;
        S.doc.body.appendChild(o);
        target.style.visibility = "hidden";
        const t0 = S.win.performance ? S.win.performance.now() : Date.now();
        const dur = 620;
        const step = (now) => {
          const k = Math.min(1, ((now || Date.now()) - t0) / dur);
          const e = 1 - Math.pow(1 - k, 3);
          o.textContent = formatLike(p.n * e, p);
          if (k < 1 && o.isConnected) S.win.requestAnimationFrame(step);
          else {
            o.remove();
            target.style.visibility = "";
          }
        };
        S.win.requestAnimationFrame(step);
        S.win.setTimeout(() => {
          if (o.isConnected) o.remove();
          target.style.visibility = "";
        }, dur + 400);
      }
    }
    const badge = line.querySelector(".carnet-eng-status");
    if (badge) animate(badge, [{ transform: "scale(.5)", opacity: 0 }, { transform: "scale(1.12)", opacity: 1, offset: 0.65 }, { transform: "none" }], { duration: 420, delay: 380, easing: EASE.out, fill: "backwards" });
  }

  function pageArrived() {
    if (!S.paper) return;
    if (Date.now() - S.newAt < 2500) {
      S.newAt = 0;
      animate(S.paper, [
        { transform: "translate3d(0,-22px,0) rotate(-1.4deg) scale(.97)", opacity: 0 },
        { transform: "translate3d(0,4px,0) rotate(.3deg) scale(1.003)", opacity: 1, offset: 0.62 },
        { transform: "none", opacity: 1 },
      ], { duration: 520, easing: EASE.out });
      buzz(8);
    }
    S.win.requestAnimationFrame(() => {
      for (const l of lines()) if (l.hasAttribute("data-carnet-eng")) countUp(l);
    });
  }

  // ---------------------------------------------------------------- trash: the page crumples and flies to the Corbeille

  function snapTrash() {
    if (!S.paper) return;
    const r = S.paper.getBoundingClientRect();
    const vh = S.win.innerHeight || 800;
    S.trashSnap = {
      t: Date.now(),
      r: { left: r.left, top: Math.max(r.top, 0), width: r.width, height: Math.min(r.height, vh - Math.max(r.top, 0)) },
      text: (S.editor ? S.editor.innerText || "" : "").slice(0, 1200),
      bg: S.win.getComputedStyle(S.paper).backgroundColor,
      ink: S.editor ? S.win.getComputedStyle(S.editor).color : "",
    };
  }

  function flyToTrash() {
    const s = S.trashSnap;
    S.trashSnap = null;
    if (!s || Date.now() - s.t > 4000 || calm()) return;
    const target = [S.doc.querySelector('.carnet-library:not([hidden]) [data-carnet-filter="trash"]'), S.doc.getElementById("btn-carnet-library")]
      .find((n) => n && n.getBoundingClientRect().width > 0);
    const g = el("div", { class: "c16-trash-ghost", "aria-hidden": "true" });
    g.textContent = s.text;
    g.style.left = s.r.left + "px";
    g.style.top = s.r.top + "px";
    g.style.width = s.r.width + "px";
    g.style.height = s.r.height + "px";
    g.style.background = s.bg;
    g.style.color = s.ink;
    S.doc.body.appendChild(g);
    let tx = 0;
    let ty = (S.win.innerHeight || 800) - s.r.top;
    if (target) {
      const tr = target.getBoundingClientRect();
      tx = tr.left + tr.width / 2 - (s.r.left + s.r.width / 2);
      ty = tr.top + tr.height / 2 - (s.r.top + s.r.height / 2);
    }
    const a = animate(g, [
      { transform: "none", opacity: 1, borderRadius: "6px" },
      { transform: "scale(.92,.84) rotate(-2.5deg) skewX(2deg)", opacity: 1, borderRadius: "18px", offset: 0.28 },
      { transform: "translate3d(" + tx + "px," + ty + "px,0) scale(.05) rotate(-18deg)", opacity: 0.25, borderRadius: "50%" },
    ], { duration: 680, easing: "cubic-bezier(.55,0,.75,.2)", fill: "forwards" });
    done(a, () => {
      g.remove();
      if (target) animate(target, [{ transform: "scale(1)" }, { transform: "scale(1.18)", offset: 0.4 }, { transform: "none" }], { duration: 380, easing: EASE.spring });
      buzz(10);
    });
  }

  // ================================================================= library: cards glide, pins drop in

  function cardKey(card) {
    const b = card.querySelector("[data-carnet-page-id]");
    return b ? b.getAttribute("data-carnet-page-id") : "";
  }

  function libMeasure() {
    const list = S.lib;
    S.libTops = new Map();
    S.pins = new Set();
    if (!list) return;
    const lt = list.getBoundingClientRect().top;
    for (const c of list.querySelectorAll(".carnet-card")) {
      const k = cardKey(c);
      if (!k) continue;
      S.libTops.set(k, c.getBoundingClientRect().top - lt);
      if (c.querySelector(".carnet-card-pin")) S.pins.add(k);
    }
  }

  function onLibMutations() {
    const list = S.lib;
    if (!list || calm() || list.closest("[hidden]")) {
      libMeasure();
      return;
    }
    const lt = list.getBoundingClientRect().top;
    const vh = S.win.innerHeight || 800;
    let fresh = 0;
    for (const c of list.querySelectorAll(".carnet-card")) {
      const k = cardKey(c);
      if (!k) continue;
      const r = c.getBoundingClientRect();
      if (r.bottom < -40 || r.top > vh + 40) continue;
      const top = r.top - lt;
      if (S.libTops.has(k)) {
        const dy = S.libTops.get(k) - top;
        if (Math.abs(dy) >= 1 && Math.abs(dy) < 900) animate(c, [{ transform: "translate3d(0," + dy + "px,0)" }, { transform: "none" }], { duration: 300, easing: EASE.out });
      } else if (S.libTops.size && fresh < 10) {
        animate(c, [{ opacity: 0, transform: "translate3d(0,8px,0) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: fresh * 24, easing: EASE.out, fill: "backwards" });
        fresh += 1;
      }
      const pin = c.querySelector(".carnet-card-pin");
      if (pin && S.libTops.size && !S.pins.has(k)) animate(pin, [{ transform: "translate3d(0,-14px,0) scale(1.5) rotate(-20deg)", opacity: 0 }, { transform: "translate3d(0,2px,0) scale(.92)", opacity: 1, offset: 0.6 }, { transform: "none" }], { duration: 480, easing: EASE.out });
    }
    libMeasure();
  }

  // ================================================================= outline: a marker follows the section you are reading

  function outlineUpdate() {
    S.outlineRaf = 0;
    const o = S.doc.querySelector(".carnet-outline:not([hidden]):not(.c16-ghost)");
    if (!o || !S.editor) return;
    const items = Array.prototype.slice.call(o.querySelectorAll(".carnet-outline-list:first-of-type .carnet-outline-item[data-carnet-outline-index]"));
    if (!items.length) return;
    const kids = S.editor.children;
    const tops = items.map((b) => {
      const ln = kids[Number(b.getAttribute("data-carnet-outline-index"))];
      return ln ? ln.getBoundingClientRect().top : Infinity;
    });
    const i = activeIndex(tops, 140);
    const list = items[0].closest(".carnet-outline-list");
    let mark = list.querySelector(".c16-outline-mark");
    if (!mark) {
      mark = el("span", { class: "c16-outline-mark", "aria-hidden": "true" });
      list.insertBefore(mark, list.firstChild);
    }
    const li = items[i].closest("li") || items[i];
    mark.style.transform = "translate3d(0," + li.offsetTop + "px,0)";
    mark.style.height = li.offsetHeight + "px";
    for (const b of items) b.classList.toggle("c16-current", b === items[i]);
  }

  function outlineSchedule() {
    if (!S.outlineRaf && S.win) S.outlineRaf = S.win.requestAnimationFrame(outlineUpdate);
  }

  // ================================================================= paper light (PC)

  function bindLight() {
    S.doc.addEventListener("mousemove", (ev) => {
      if (!S.paper || !fine() || calm() || S.lightRaf) return;
      S.lightRaf = S.win.requestAnimationFrame(() => {
        S.lightRaf = 0;
        const r = S.paper.getBoundingClientRect();
        if (!(r.width > 0)) return;
        const nx = Math.max(-1, Math.min(1, (ev.clientX - (r.left + r.width / 2)) / (r.width / 2)));
        const ny = Math.max(-1, Math.min(1, (ev.clientY - (r.top + Math.min(r.height, S.win.innerHeight) / 2)) / (Math.min(r.height, S.win.innerHeight) / 2)));
        S.paper.style.setProperty("--c16-lx", (-nx * 4).toFixed(2) + "px");
        S.paper.style.setProperty("--c16-ly", (-ny * 3).toFixed(2) + "px");
        S.paper.style.setProperty("--c16-mx", (ev.clientX - r.left).toFixed(0) + "px");
        S.paper.style.setProperty("--c16-my", (ev.clientY - r.top).toFixed(0) + "px");
      });
    }, { passive: true });
  }

  // ================================================================= attach

  function attach(ed) {
    if (S.edMo) S.edMo.disconnect();
    S.editor = ed;
    S.paper = ed.closest(".carnet-paper") || ed.parentNode;
    S.root = ed.closest(".carnet");
    const snap = snapshotLines();
    S.hl = snap.hl;
    S.checks = snap.ch;
    S.keys = snap.keys;
    S.pageId = ed.dataset.pageId || "";
    S.edMo = new S.win.MutationObserver(() => {
      onEditorChange();
      outlineSchedule();
    });
    S.edMo.observe(ed, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-page-id", "data-checked"] });
    ed.addEventListener("focus", caretSchedule);
    ed.addEventListener("blur", () => caretHide());
    ed.addEventListener("keydown", () => {
      caretTyping();
      caretSchedule();
    });
    ed.addEventListener("input", caretSchedule);
    ed.addEventListener("compositionstart", () => {
      S.composing = true;
      caretHide();
    });
    ed.addEventListener("compositionend", () => {
      S.composing = false;
      caretSchedule();
    });
  }

  function watch() {
    const ed = S.doc.getElementById("hq-carnet-editor");
    if (ed && ed !== S.editor) attach(ed);
    const list = S.doc.getElementById("carnet-library-list");
    if (list && list !== S.lib) {
      if (S.libMo) S.libMo.disconnect();
      S.lib = list;
      libMeasure();
      S.libMo = new S.win.MutationObserver(onLibMutations);
      S.libMo.observe(list, { childList: true });
      list.addEventListener("scroll", () => libMeasure(), { passive: true });
    }
  }

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    const doc = S.doc;
    const boot = () => {
      S.exitMo = new win.MutationObserver(onExitMutations);
      S.exitMo.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
      bindSheets();
      bindLight();
      doc.addEventListener("selectionchange", caretSchedule);
      win.addEventListener("scroll", () => {
        caretSchedule();
        outlineSchedule();
      }, { passive: true });
      win.addEventListener("resize", () => {
        caretSchedule();
        outlineSchedule();
      });
      doc.addEventListener("click", (ev) => {
        const t = ev.target && ev.target.closest ? ev.target : null;
        if (!t) return;
        if (t.closest("#btn-carnet-new,#btn-carnet-lib-new")) S.newAt = Date.now();
        if (t.closest("[data-carnet-trash]")) snapTrash();
        if (t.closest("#btn-carnet-outline")) S.win.setTimeout(outlineSchedule, 30);
      }, true);
      // the Corbeille's undo banner appears exactly when a page was just sent there
      new win.MutationObserver(() => {
        const u = doc.getElementById("hq-carnet-undo");
        if (u && !u.hidden && S.trashSnap) flyToTrash();
      }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
      watch();
      win.setInterval(watch, 800);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure };
});
