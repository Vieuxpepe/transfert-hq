/* Transfert HQ — Carnet Phase 16D: sticky notes on a page.
 *
 * Small coloured notes pinned on the current Carnet page: add (top-bar button or Alt+Maj+N), write, drag anywhere on the page
 * (mouse, touch, pen, or the arrow keys on the grip), change colour, fold, copy the text, close (with "Annuler").
 *
 * They are NOT page content: they live in their own store (/api/carnet/stickies -> .hq-carnet/stickies.json, see
 * hq_carnet_stickies.py), never inside the editor DOM (the strict editor parser never sees them) and never in notebook.json.
 * Every device sees the same notes (polled while the Carnet is visible). Writes are revision-aware: a note changed on another
 * device is never overwritten — the newer version is shown and a message says so.
 *
 * Position: x = fraction of the page width (so a note keeps its place on a phone and on a wide PC page), y = CSS px from the top
 * of the page. Nothing here uses browser storage, builds HTML from strings or evaluates code.
 *
 * Plain ES2020, no build step. Pure helpers are exported for Node tests (tests/check_hq_carnet_stickies.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqCarnetStickies = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const COLORS = ["yellow", "pink", "blue", "green", "purple"];
  const COLOR_NAMES = { yellow: "jaune", pink: "rose", blue: "bleu", green: "vert", purple: "violet" };
  const TEXT_MAX = 4000;
  const W_MIN = 160;
  const W_MAX = 520;
  const W_DEFAULT = 230;
  const POLL_MS = 15000;
  const SAVE_MS = 700;

  // ------------------------------------------------------------------ pure helpers

  /** Left edge in px for a stored fraction, clamped so the whole note stays on the page. */
  function leftPx(x, pageW, noteW) {
    const max = Math.max(0, pageW - noteW);
    return Math.round(Math.max(0, Math.min(max, (Number(x) || 0) * pageW)));
  }

  /** Stored fraction (0..1, 4 decimals) for a left edge in px. */
  function fracX(left, pageW, noteW) {
    if (!(pageW > 0)) return 0;
    const max = Math.max(0, pageW - noteW);
    const l = Math.max(0, Math.min(max, left));
    return Math.round((l / pageW) * 10000) / 10000;
  }

  function clampY(y, pageH, noteH) {
    const max = Math.max(0, Math.min(200000, (pageH || 0) - Math.min(noteH || 0, 60)));
    return Math.round(Math.max(0, Math.min(max, y)));
  }

  function nextColor(c) {
    const i = COLORS.indexOf(c);
    return COLORS[(i + 1) % COLORS.length];
  }

  /** Where a new note goes: top-right of the visible part of the page, nudged down so it does not cover another one exactly. */
  function placement(pageW, visibleTop, existing, w) {
    const nw = Math.min(w || W_DEFAULT, Math.max(W_MIN, pageW - 16));
    let y = Math.max(16, Math.round(visibleTop + 24));
    const x = fracX(pageW - nw - 16, pageW, nw);
    const taken = (yy) => (existing || []).some((n) => Math.abs(n.x - x) < 0.03 && Math.abs(n.y - yy) < 24);
    let guard = 0;
    while (taken(y) && guard < 20) {
      y += 28;
      guard += 1;
    }
    return { x, y, w: nw };
  }

  /** First line of a note, for its folded label and its accessible name. */
  function label(text) {
    const line = String(text || "").split("\n").find((l) => l.trim()) || "";
    return line.trim().slice(0, 60) || "Note vide";
  }

  const pure = { leftPx, fracX, clampY, nextColor, placement, label, COLORS, TEXT_MAX };

  // ------------------------------------------------------------------ browser layer

  const S = {
    started: false, win: null, doc: null,
    editor: null, paper: null, layer: null, button: null, live: null,
    notes: new Map(), // id -> note (server shape)
    views: new Map(), // id -> view {el, ta, ...}
    rev: -1, pageId: "", loading: false, pollTimer: 0, attrMo: null, ro: null,
  };

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

  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(d) {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    const p = S.doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }
  const ICON = {
    note: "M5 4h14v10l-6 6H5zM13 20v-6h6M8 9h8M8 12h5",
    copy: "M9 9h10v11H9zM5 15V4h10",
    check: "M5 12.5l4.5 4.5L19 7",
    fold: "M6 12h12",
    unfold: "M6 9l6 6 6-6",
    close: "M6 6l12 12M18 6L6 18",
  };

  function buzz(ms) {
    const M = S.win.HqCarnetMotion;
    if (M && typeof M.buzz === "function") M.buzz(ms);
  }

  function anim(node, frames, opts) {
    if (!node || typeof node.animate !== "function" || calm()) return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }

  function calm() {
    try {
      return !!S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return true;
    }
  }

  function api(url, opts) {
    if (typeof S.win.api === "function") return S.win.api(url, opts);
    return Promise.reject(new Error("api() indisponible"));
  }

  function post(payload) {
    return api("/api/carnet/stickies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), timeoutMs: 15000 });
  }

  function say(text) {
    if (S.live) {
      S.live.textContent = "";
      S.win.setTimeout(() => {
        if (S.live) S.live.textContent = text;
      }, 30);
    }
  }

  function toast(text, action, onAction) {
    const M = S.win.HqCarnetMotion;
    if (M && typeof M.toast === "function") M.toast({ text, action, onAction });
    else say(text);
  }

  function editable() {
    return !!S.editor && S.editor.getAttribute("contenteditable") === "true";
  }

  function visible() {
    return S.doc.body && S.doc.body.dataset.view === "carnet" && S.doc.visibilityState !== "hidden";
  }

  // ---------------------------------------------------------------- attach to the (single) editor

  function watch() {
    const ed = S.doc.getElementById("hq-carnet-editor");
    if (ed && ed !== S.editor) attach(ed);
    if (S.editor) {
      ensureButton();
      const pid = S.editor.dataset.pageId || "";
      if (pid !== S.pageId) pageChanged(pid);
    }
  }

  function attach(ed) {
    if (S.attrMo) S.attrMo.disconnect();
    if (S.ro) S.ro.disconnect();
    S.editor = ed;
    S.paper = ed.closest(".carnet-paper") || ed.parentNode;
    S.layer = el("div", { class: "carnet-stickies", "data-carnet-stickies": "" });
    S.paper.appendChild(S.layer);
    S.views.clear();
    S.pageId = "";
    S.attrMo = new S.win.MutationObserver(() => {
      const pid = S.editor.dataset.pageId || "";
      if (pid !== S.pageId) pageChanged(pid);
      else render();
    });
    S.attrMo.observe(ed, { attributes: true, attributeFilter: ["data-page-id", "contenteditable"] });
    if (typeof S.win.ResizeObserver === "function") {
      S.ro = new S.win.ResizeObserver(() => layoutAll());
      S.ro.observe(S.paper);
    }
    ensureButton();
    pageChanged(ed.dataset.pageId || "");
    load(true);
  }

  function ensureButton() {
    if (S.button && S.button.isConnected) {
      S.button.disabled = !editable();
      return;
    }
    const bar = S.doc.querySelector(".carnet-bar-top .carnet-actions");
    if (!bar) return;
    S.button = el("button", {
      type: "button", id: "btn-carnet-sticky", class: "carnet-btn carnet-sticky-add",
      "aria-label": "Ajouter une note autocollante (Alt+Maj+N)", title: "Note autocollante (Alt+Maj+N)",
    }, [icon(ICON.note)]);
    S.button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor caret / iOS keyboard
    S.button.addEventListener("click", () => addNote());
    const anchor = bar.querySelector("#btn-carnet-outline") || bar.querySelector("#btn-carnet-library");
    bar.insertBefore(S.button, anchor || bar.firstChild);
    S.button.disabled = !editable();
  }

  function pageChanged(pid) {
    S.pageId = pid;
    for (const v of S.views.values()) v.el.remove();
    S.views.clear();
    if (S.button) S.button.disabled = !editable();
    render();
  }

  // ---------------------------------------------------------------- server sync

  async function load(force) {
    if (S.loading || !S.editor) return;
    S.loading = true;
    try {
      const out = await api("/api/carnet/stickies" + (force || S.rev < 0 ? "" : "?since=" + S.rev), { timeoutMs: 12000 });
      if (out && out.unchanged) return;
      if (!out || !Array.isArray(out.notes)) return;
      S.rev = out.rev;
      const seen = new Set();
      for (const n of out.notes) {
        seen.add(n.id);
        const v = S.views.get(n.id);
        if (v && (v.dirty || v.dragging || v.saving)) continue; // the local edit wins until it is saved (then the rev decides)
        S.notes.set(n.id, n);
      }
      for (const id of Array.from(S.notes.keys())) {
        const v = S.views.get(id);
        if (!seen.has(id) && !(v && v.creating)) S.notes.delete(id);
      }
      render();
    } catch (_) {
      /* offline / not admin: notes simply stay as they are */
    } finally {
      S.loading = false;
    }
  }

  function schedulePoll() {
    if (S.pollTimer) S.win.clearTimeout(S.pollTimer);
    S.pollTimer = S.win.setTimeout(() => {
      if (visible() && S.editor) {
        retryFailed(); // a write that failed offline is sent again on the next tick
        load(false);
      }
      schedulePoll();
    }, POLL_MS);
  }

  function retryFailed() {
    for (const v of S.views.values()) {
      if (v.retry && !v.saving) {
        const r = v.retry;
        v.retry = null;
        save(v.id, r);
      }
    }
  }

  function adopt(note, msg) {
    S.notes.set(note.id, note);
    const v = S.views.get(note.id);
    if (v) {
      v.dirty = false;
      fill(v, note, true);
      layout(v);
    }
    if (msg) say(msg);
  }

  /** One write at a time per note; later changes are merged into the next write. */
  async function save(id, fields) {
    const v = S.views.get(id);
    const n = S.notes.get(id);
    if (!v || !n || v.creating) {
      if (v) v.pending = Object.assign(v.pending || {}, fields);
      return;
    }
    if (v.saving) {
      v.pending = Object.assign(v.pending || {}, fields);
      return;
    }
    v.saving = true;
    v.el.setAttribute("data-state", "saving");
    try {
      const out = await post(Object.assign({ action: "update", id, rev: n.rev }, fields));
      if (out && out.note) {
        S.notes.set(id, out.note);
        if (typeof out.rev === "number") S.rev = Math.max(S.rev, out.rev);
        if (!v.dirty) fill(v, out.note, false);
      }
      v.el.removeAttribute("data-state");
    } catch (err) {
      if (err && err.status === 409 && err.data && err.data.note) {
        v.pending = null;
        adopt(err.data.note, "Note modifiée sur un autre appareil : version la plus récente affichée");
        toast("Note modifiée sur un autre appareil : la version la plus récente est affichée");
      } else if (err && err.status === 404) {
        S.notes.delete(id);
        removeView(id);
        toast("Cette note a été fermée sur un autre appareil");
      } else {
        v.el.setAttribute("data-state", "error");
        v.retry = Object.assign(v.retry || {}, fields);
        say("Note non enregistrée : " + ((err && err.message) || "erreur"));
      }
    } finally {
      v.saving = false;
      const more = v.pending;
      v.pending = null;
      if (more && S.notes.has(id)) save(id, more);
    }
  }

  // ---------------------------------------------------------------- views

  function render() {
    if (!S.layer || !S.editor) return;
    const pid = S.pageId;
    const want = new Set();
    for (const n of S.notes.values()) if (n.page_id === pid) want.add(n.id);
    for (const [id, v] of S.views) if (!want.has(id) && !v.creating) removeView(id);
    for (const id of want) {
      const n = S.notes.get(id);
      let v = S.views.get(id);
      if (!v) {
        v = build(n);
        S.views.set(id, v);
        S.layer.appendChild(v.el);
      } else if (!v.dirty && !v.dragging) fill(v, n, false);
      layout(v);
    }
    const ro = !editable();
    S.layer.toggleAttribute("data-readonly", ro);
    for (const v of S.views.values()) {
      v.ta.readOnly = ro;
      for (const b of [v.colorBtn, v.closeBtn]) b.disabled = ro;
    }
  }

  function removeView(id, animated) {
    const v = S.views.get(id);
    if (!v) return;
    S.views.delete(id);
    if (animated && !calm() && typeof v.el.animate === "function") {
      // 16I: the note crumples into a ball and drops away
      v.el.style.transformOrigin = "50% 50%";
      const a = v.el.animate([
        { opacity: 1, transform: "none", borderRadius: "10px", filter: "none" },
        { opacity: 1, transform: "scale(.82,.7) rotate(-6deg) skewX(4deg)", borderRadius: "28px", filter: "brightness(.94)", offset: 0.35 },
        { opacity: 1, transform: "scale(.34) rotate(14deg)", borderRadius: "50%", filter: "brightness(.9)", offset: 0.62 },
        { opacity: 0, transform: "translate3d(0,48px,0) scale(.18) rotate(32deg)", borderRadius: "50%", filter: "brightness(.9)" },
      ], { duration: 420, easing: "cubic-bezier(.4,0,.7,1)", fill: "forwards" });
      a.finished.then(() => v.el.remove(), () => v.el.remove());
    } else v.el.remove();
  }

  function build(n) {
    const grip = el("button", { type: "button", class: "carnet-sticky-grip", "aria-label": "Déplacer la note (flèches ; Maj pour aller plus vite)", title: "Glisser pour déplacer" }, [el("span", { "aria-hidden": "true", text: "⠿" })]);
    const colorBtn = el("button", { type: "button", class: "carnet-sticky-color", "aria-label": "Changer la couleur", title: "Couleur" }, [el("span", { class: "carnet-sticky-dot", "aria-hidden": "true" })]);
    const title = el("span", { class: "carnet-sticky-title", "aria-hidden": "true" });
    const foldBtn = el("button", { type: "button", class: "carnet-sticky-fold", "aria-expanded": "true" }, [icon(ICON.fold)]);
    const copyBtn = el("button", { type: "button", class: "carnet-sticky-copy", "aria-label": "Copier le texte de la note", title: "Copier" }, [icon(ICON.copy)]);
    const closeBtn = el("button", { type: "button", class: "carnet-sticky-close", "aria-label": "Fermer la note", title: "Fermer" }, [icon(ICON.close)]);
    const bar = el("div", { class: "carnet-sticky-bar" }, [grip, colorBtn, title, foldBtn, copyBtn, closeBtn]);
    const ta = el("textarea", { class: "carnet-sticky-text", rows: "3", maxlength: String(TEXT_MAX), placeholder: "Écris ta note…", spellcheck: "true", "aria-label": "Texte de la note" });
    const box = el("section", { class: "carnet-sticky", role: "group", "data-carnet-sticky": n.id }, [bar, ta]);
    const v = { id: n.id, el: box, bar, grip, colorBtn, title, foldBtn, copyBtn, closeBtn, ta, dirty: false, saving: false, dragging: false, timer: 0 };
    fill(v, n, true);
    if (S.popId === n.id) { // only a note you just added (or brought back) lands; notes already there simply are there
      S.popId = "";
      anim(box, [{ opacity: 0, transform: "translate3d(0,-14px,0) scale(.8) rotate(-4deg)" }, { opacity: 1, transform: "rotate(1deg) scale(1.02)", offset: 0.6 }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,1.1,.32,1)" });
    }
    // text
    ta.addEventListener("input", () => {
      v.dirty = true;
      autosize(v);
      updateTitle(v, ta.value);
      if (v.timer) S.win.clearTimeout(v.timer);
      v.timer = S.win.setTimeout(() => flushText(v), SAVE_MS);
    });
    ta.addEventListener("blur", () => flushText(v));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ta.blur();
        grip.focus({ preventScroll: true });
      }
      e.stopPropagation(); // editor / page shortcuts (Alt+arrows…) never fire from inside a note
    });
    box.addEventListener("focusin", () => front(v));
    // controls
    colorBtn.addEventListener("click", () => {
      const n2 = S.notes.get(v.id);
      if (!n2) return;
      const c = nextColor(v.el.getAttribute("data-color"));
      v.el.setAttribute("data-color", c);
      anim(v.el, [{ transform: "scale(1)" }, { transform: "scale(1.035)", offset: 0.35 }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,1.35,.35,1)" });
      anim(colorBtn.firstChild, [{ transform: "scale(.4) rotate(-90deg)" }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,1.35,.35,1)" });
      colorBtn.setAttribute("aria-label", "Couleur : " + COLOR_NAMES[c] + " (changer)");
      save(v.id, { color: c });
    });
    foldBtn.addEventListener("click", () => {
      const folded = !(v.wantFolded != null ? v.wantFolded : v.el.classList.contains("is-folded"));
      v.wantFolded = folded; // quick double taps follow the intent, not the half-finished animation
      if (v.foldAnim) v.foldAnim.cancel();
      save(v.id, { collapsed: folded });
      if (calm() || typeof ta.animate !== "function") {
        setFolded(v, folded);
        return;
      }
      if (folded) {
        const h = ta.offsetHeight;
        const a = ta.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" }], { duration: 200, easing: "cubic-bezier(.4,0,.2,1)" });
        v.foldAnim = a;
        const end = () => {
          if (v.foldAnim === a) v.foldAnim = null;
          if (v.wantFolded === true) setFolded(v, true);
        };
        a.finished.then(end, end);
      } else {
        setFolded(v, false);
        const h = ta.offsetHeight;
        v.foldAnim = ta.animate([{ height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" }, { height: h + "px", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    });
    copyBtn.addEventListener("click", () => copyText(v));
    closeBtn.addEventListener("click", () => closeNote(v));
    // drag (bar, not its buttons — except the grip, which is a handle)
    bar.addEventListener("pointerdown", (e) => startDrag(v, e));
    grip.addEventListener("keydown", (e) => keyMove(v, e));
    return v;
  }

  function fill(v, n, force) {
    v.el.setAttribute("data-color", n.color);
    v.colorBtn.setAttribute("aria-label", "Couleur : " + COLOR_NAMES[n.color] + " (changer)");
    if (force || S.doc.activeElement !== v.ta) {
      if (v.ta.value !== n.text) v.ta.value = n.text;
    }
    updateTitle(v, v.ta.value);
    v.el.style.width = n.w + "px";
    v.el.style.zIndex = String(10 + Math.min(1000, n.z));
    setFolded(v, n.collapsed);
    autosize(v);
  }

  function updateTitle(v, text) {
    const t = label(text);
    v.title.textContent = t;
    v.el.setAttribute("aria-label", "Note : " + t);
  }

  function setFolded(v, folded) {
    if (v.wantFolded != null && v.wantFolded !== folded && !v.foldAnim) v.wantFolded = null;
    v.el.classList.toggle("is-folded", folded);
    v.ta.hidden = folded;
    v.foldBtn.setAttribute("aria-expanded", folded ? "false" : "true");
    v.foldBtn.setAttribute("aria-label", folded ? "Déplier la note" : "Replier la note");
    v.foldBtn.setAttribute("title", folded ? "Déplier" : "Replier");
    v.foldBtn.replaceChildren(icon(folded ? ICON.unfold : ICON.fold));
  }

  function autosize(v) {
    const ta = v.ta;
    ta.style.height = "auto";
    ta.style.height = Math.min(420, Math.max(64, ta.scrollHeight + 2)) + "px";
  }

  function pageW() {
    return S.paper ? S.paper.clientWidth : 0;
  }

  function layout(v) {
    const n = S.notes.get(v.id);
    if (!n || v.dragging) return;
    const pw = pageW();
    const w = Math.min(n.w, Math.max(W_MIN, pw - 8));
    v.el.style.width = w + "px";
    v.el.style.left = leftPx(n.x, pw, w) + "px";
    v.el.style.top = n.y + "px";
  }

  function layoutAll() {
    for (const v of S.views.values()) layout(v);
  }

  function flushText(v) {
    if (v.timer) S.win.clearTimeout(v.timer);
    v.timer = 0;
    if (!v.dirty) return;
    v.dirty = false;
    const n = S.notes.get(v.id);
    if (n && n.text === v.ta.value) return;
    save(v.id, { text: v.ta.value });
  }

  function front(v) {
    const n = S.notes.get(v.id);
    if (!n || !editable()) return;
    let top = 0;
    let ties = 0;
    for (const m of S.notes.values()) {
      if (m.page_id !== n.page_id) continue;
      if (m.z > top) {
        top = m.z;
        ties = 1;
      } else if (m.z === top) ties += 1;
    }
    if (n.z === top && ties === 1) return;
    v.el.style.zIndex = String(10 + Math.min(1000, top + 1));
    save(v.id, { front: true });
  }

  // ---------------------------------------------------------------- moving

  function startDrag(v, e) {
    if (!editable() || v.dragging) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const onButton = e.target && e.target.closest && e.target.closest("button");
    if (onButton && onButton !== v.grip) return;
    const n = S.notes.get(v.id);
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    const pw = pageW();
    const ph = S.paper.scrollHeight || S.paper.clientHeight;
    const start = { x: e.clientX, y: e.clientY, left: v.el.offsetLeft, top: v.el.offsetTop, moved: false, id: e.pointerId };
    const guides = snapTargets(v, pw);
    v.dragging = true;
    v.el.classList.add("is-dragging");
    buzz(6);
    front(v);
    try {
      v.bar.setPointerCapture(e.pointerId);
    } catch (_) {}
    const move = (ev) => {
      if (ev.pointerId !== start.id) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      const w = v.el.offsetWidth;
      let left = Math.max(0, Math.min(pw - w, start.left + dx));
      let top = clampY(start.top + dy, ph, v.el.offsetHeight);
      // 16I: align with the page and the other notes (8 px), and show the guide that caught it
      const sx = bestSnap([left, left + w / 2, left + w], guides.xs);
      const sy = bestSnap([top, top + v.el.offsetHeight / 2, top + v.el.offsetHeight], guides.ys);
      if (sx) left = Math.max(0, Math.min(pw - w, left + sx.d));
      if (sy) top = clampY(top + sy.d, ph, v.el.offsetHeight);
      showGuides(sx ? sx.at : null, sy ? sy.at : null);
      v.el.style.left = left + "px";
      v.el.style.top = top + "px";
    };
    const end = (ev) => {
      if (ev && ev.pointerId !== start.id) return;
      v.bar.removeEventListener("pointermove", move);
      v.bar.removeEventListener("pointerup", end);
      v.bar.removeEventListener("pointercancel", end);
      v.dragging = false;
      v.el.classList.remove("is-dragging");
      showGuides(null, null);
      if (!start.moved) return;
      buzz(10);
      anim(v.el, [{ transform: "rotate(-1.2deg) scale(1.02)" }, { transform: "rotate(.9deg) scale(.995)", offset: 0.45 }, { transform: "rotate(-.3deg)", offset: 0.75 }, { transform: "none" }], { duration: 460, easing: "ease-out" });
      const w = v.el.offsetWidth;
      const x = fracX(v.el.offsetLeft, pw, w);
      const y = clampY(v.el.offsetTop, ph, v.el.offsetHeight);
      const cur = S.notes.get(v.id);
      if (cur) S.notes.set(v.id, Object.assign({}, cur, { x, y }));
      save(v.id, { x, y });
      say("Note déplacée");
    };
    v.bar.addEventListener("pointermove", move);
    v.bar.addEventListener("pointerup", end);
    v.bar.addEventListener("pointercancel", end);
  }

  /** Edges and centres a dragged note can align with: the page's and every other note's (layer coordinates). */
  function snapTargets(v, pw) {
    const xs = [0, pw / 2, pw];
    const ys = [];
    for (const o of S.views.values()) {
      if (o === v || !o.el.isConnected) continue;
      const l = o.el.offsetLeft;
      const t = o.el.offsetTop;
      const w = o.el.offsetWidth;
      const h = o.el.offsetHeight;
      xs.push(l, l + w / 2, l + w);
      ys.push(t, t + h / 2, t + h);
    }
    return { xs, ys };
  }

  /** The smallest correction (≤ 8 px) that puts one of `edges` on one of `targets`: {d, at} or null. */
  function bestSnap(edges, targets) {
    let best = null;
    for (const e of edges) for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= 8 && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
    return best;
  }

  function showGuides(x, y) {
    if (!S.layer) return;
    for (const [axis, val] of [["x", x], ["y", y]]) {
      let g = S.layer.querySelector(".carnet-sticky-guide[data-axis=\"" + axis + "\"]");
      if (val === null || val === undefined) {
        if (g) g.classList.remove("is-on");
        continue;
      }
      if (!g) {
        g = el("span", { class: "carnet-sticky-guide", "data-axis": axis, "aria-hidden": "true" });
        S.layer.appendChild(g);
      }
      const was = g.classList.contains("is-on") && g.__at === val;
      g.style.transform = axis === "x" ? "translate3d(" + val + "px,0,0)" : "translate3d(0," + val + "px,0)";
      g.__at = val;
      if (!g.classList.contains("is-on")) g.classList.add("is-on");
      if (!was) buzz(4);
    }
  }

  function keyMove(v, e) {
    const step = e.shiftKey ? 32 : 8;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (!editable()) return;
    const n = S.notes.get(v.id);
    if (!n) return;
    const pw = pageW();
    const w = v.el.offsetWidth;
    const x = fracX(v.el.offsetLeft + dx, pw, w);
    const y = clampY(v.el.offsetTop + dy, S.paper.scrollHeight || S.paper.clientHeight, v.el.offsetHeight);
    S.notes.set(v.id, Object.assign({}, n, { x, y }));
    layout(v);
    if (v.keyTimer) S.win.clearTimeout(v.keyTimer);
    v.keyTimer = S.win.setTimeout(() => save(v.id, { x: S.notes.get(v.id).x, y: S.notes.get(v.id).y }), 400);
  }

  // ---------------------------------------------------------------- add / copy / close

  async function addNote() {
    if (!S.editor || !editable() || !S.pageId) return;
    const pw = pageW();
    const pr = S.paper.getBoundingClientRect();
    const visTop = Math.max(0, -pr.top + 70);
    const existing = Array.from(S.notes.values()).filter((n) => n.page_id === S.pageId);
    const p = placement(pw, visTop, existing, W_DEFAULT);
    const color = existing.length ? COLORS[existing.length % COLORS.length] : "yellow";
    if (S.button) S.button.disabled = true;
    try {
      const out = await post({ action: "create", page_id: S.pageId, x: p.x, y: p.y, w: p.w, color });
      if (typeof out.rev === "number") S.rev = Math.max(S.rev, out.rev);
      S.notes.set(out.note.id, out.note);
      S.popId = out.note.id;
      render();
      const v = S.views.get(out.note.id);
      if (v) {
        v.ta.focus({ preventScroll: true });
        if (typeof v.el.scrollIntoView === "function") v.el.scrollIntoView({ block: "nearest", behavior: calm() ? "auto" : "smooth" });
      }
      buzz(8);
      say("Note ajoutée");
    } catch (err) {
      toast("Impossible d'ajouter la note : " + ((err && err.message) || "erreur"));
    } finally {
      if (S.button) S.button.disabled = !editable();
    }
  }

  async function copyText(v) {
    const text = v.ta.value;
    let ok = false;
    try {
      if (S.win.navigator.clipboard && S.win.isSecureContext) {
        await S.win.navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      // http on the LAN: no async clipboard API — select a hidden copy and use the legacy command
      const tmp = el("textarea", { class: "carnet-sticky-clip", "aria-hidden": "true", tabindex: "-1", readonly: true });
      tmp.value = text;
      S.doc.body.appendChild(tmp);
      tmp.select();
      try {
        ok = !!S.doc.execCommand("copy");
      } catch (_) {
        ok = false;
      }
      tmp.remove();
    }
    if (ok) {
      buzz(8);
      if (!calm()) {
        const r = v.copyBtn.getBoundingClientRect();
        const bub = el("span", { class: "carnet-sticky-bubble", "aria-hidden": "true", text: "Copié" });
        bub.style.left = (r.left + r.width / 2) + "px";
        bub.style.top = r.top + "px";
        S.doc.body.appendChild(bub);
        const a = anim(bub, [{ transform: "translate3d(-50%,0,0) scale(.7)", opacity: 0 }, { transform: "translate3d(-50%,-26px,0) scale(1)", opacity: 1, offset: 0.3 }, { transform: "translate3d(-50%,-38px,0)", opacity: 0 }], { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" });
        const rm = () => bub.remove();
        if (a) a.finished.then(rm, rm);
        else rm();
      }
      v.copyBtn.replaceChildren(icon(ICON.check));
      v.copyBtn.classList.add("is-done");
      say("Texte de la note copié");
      S.win.setTimeout(() => {
        v.copyBtn.replaceChildren(icon(ICON.copy));
        v.copyBtn.classList.remove("is-done");
      }, 1400);
    } else toast("Copie impossible sur cet appareil : sélectionne le texte de la note");
  }

  async function closeNote(v) {
    const n = S.notes.get(v.id);
    if (!n || !editable()) return;
    flushText(v);
    const snapshot = Object.assign({}, n, { text: v.ta.value });
    removeView(v.id, true);
    S.notes.delete(v.id);
    try {
      const out = await post({ action: "delete", id: n.id });
      if (typeof out.rev === "number") S.rev = Math.max(S.rev, out.rev);
    } catch (err) {
      if (!(err && err.status === 404)) {
        S.notes.set(n.id, n);
        render();
        toast("Impossible de fermer la note : " + ((err && err.message) || "erreur"));
        return;
      }
    }
    toast("Note fermée", "Annuler", () => {
      if (S.pageId !== snapshot.page_id) {
        toast("Reviens sur sa page pour rétablir la note");
        return false;
      }
      post({ action: "create", page_id: snapshot.page_id, text: snapshot.text, color: snapshot.color, x: snapshot.x, y: snapshot.y, w: snapshot.w, collapsed: snapshot.collapsed })
        .then((out) => {
          if (typeof out.rev === "number") S.rev = Math.max(S.rev, out.rev);
          S.notes.set(out.note.id, out.note);
          S.popId = out.note.id;
          render();
          say("Note rétablie");
        }, (err) => toast("Impossible de rétablir la note : " + ((err && err.message) || "erreur")));
      return true;
    });
  }

  // ---------------------------------------------------------------- start

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    const boot = () => {
      S.live = el("p", { class: "visually-hidden carnet-sticky-live", role: "status", "aria-live": "polite" });
      S.doc.body.appendChild(S.live);
      watch();
      win.setInterval(watch, 700);
      schedulePoll();
      S.doc.addEventListener("visibilitychange", () => {
        if (visible() && S.editor) load(false);
      });
      S.doc.addEventListener("keydown", (e) => {
        if (!visible() || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
        if (e.code !== "KeyN" && e.key !== "N" && e.key !== "n") return;
        e.preventDefault();
        addNote();
      });
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure, add: () => addNote(), reload: () => load(true) };
});
