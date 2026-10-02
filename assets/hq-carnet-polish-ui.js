/* Transfert HQ — Carnet Product Phase 3.5: interaction polish UI (DOM layer over the pure HqCarnetNav core).
 *
 *   - save pill            visual state is immediate, the live region is debounced (no Enregistré → Enregistrement… → Enregistré spam)
 *   - "Plan de la page"    outline + asset navigator, a view over the parsed lines (never the DOM), rebuilt only when its signature changes
 *   - inspector            INSPECTION-ONLY slide-over (zoom / pan / fit, exact stem, parent, open in Dessiner, use an existing offer,
 *                          before/after compare). It never draws, saves, creates a stem or touches the notebook. While open the rest of the
 *                          page is inert (aria-modal is only set once that is true); focus is trapped and restored to the trigger.
 *
 * Nothing here persists anything. Plain ES2020, no network of its own (everything goes through the host object).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetPolishUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LIVE_DEBOUNCE_MS = 1500;
  const OUTLINE_DEBOUNCE_MS = 160;
  const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function mount(host) {
    const N = host.nav;
    const doc = host.doc;

    function el(tag, attrs, kids) {
      const n = doc.createElement(tag);
      for (const k of Object.keys(attrs || {})) {
        const v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === "text") n.textContent = v;
        else if (k === "class") n.className = v;
        else n.setAttribute(k, v === true ? "" : String(v));
      }
      for (const c of [].concat(kids === undefined ? [] : kids)) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
      return n;
    }

    // ------------------------------------------------------------------ save pill
    const S = { pill: null, live: null, pop: null, last: "", timer: null, announced: "", state: "idle", detail: "" };

    function saveNodes() {
      if (S.pill) return { pill: S.pill, live: S.live, pop: S.pop };
      S.pill = el("button", { type: "button", id: "hq-carnet-savepill", class: "carnet-savepill", hidden: true, "aria-expanded": "false", "aria-controls": "hq-carnet-savepop" });
      S.live = el("span", { id: "hq-carnet-savelive", class: "carnet-vh", role: "status", "aria-live": "polite" });
      S.pop = el("div", { id: "hq-carnet-savepop", class: "carnet-savepop", hidden: true });
      S.pill.addEventListener("click", () => {
        const open = S.pop.hidden;
        S.pop.hidden = !open;
        S.pill.setAttribute("aria-expanded", open ? "true" : "false");
      });
      // Escape closes the popover from the pill or from inside it (no document-level listener: the page keeps ONE global keydown)
      const esc = (ev) => {
        if (ev.key === "Escape" && !S.pop.hidden) {
          ev.stopPropagation();
          S.pop.hidden = true;
          S.pill.setAttribute("aria-expanded", "false");
          S.pill.focus();
        }
      };
      S.pill.addEventListener("keydown", esc);
      S.pop.addEventListener("keydown", esc);
      return { pill: S.pill, live: S.live, pop: S.pop };
    }

    function announce(text) {
      S.live.textContent = "";
      S.live.textContent = text;
    }

    /** snap: HqCarnetNav.deriveSave input. errText: the existing error text (shown, and announced for a hard failure). */
    function saveUpdate(snap, errText) {
      saveNodes();
      const r = N.deriveSave(snap);
      S.state = r.state;
      S.pill.hidden = !r.label;
      S.pill.textContent = r.label;
      S.pill.dataset.state = r.state;
      S.pill.dataset.kind = r.kind;
      S.pill.setAttribute("aria-label", r.label ? "État de l'enregistrement : " + r.label : "");
      S.pop.textContent = r.detail || "";
      if (!r.label) S.pop.hidden = true;
      if (r.label && S.pill.getAttribute("aria-expanded") === "true") S.pop.hidden = false;
      const text = r.state === "failed" && errText ? r.label + " — " + errText : r.label;
      if (S.timer) {
        host.clearTimer(S.timer);
        S.timer = null;
      }
      if (r.state === S.announced) return r;
      if (N.announceNow(r.state)) {
        S.announced = r.state;
        announce(text);
      } else {
        // saved / saving flicker quickly while typing: only the state that is still current after the pause is spoken
        S.timer = host.setTimer(() => {
          S.timer = null;
          if (S.state !== S.announced) {
            S.announced = S.state;
            announce(N.SAVE_LABEL[S.state] || "");
          }
        }, LIVE_DEBOUNCE_MS);
      }
      return r;
    }

    // ------------------------------------------------------------------ outline ("Plan de la page")
    const O = { panel: null, button: null, groups: null, sig: null, open: false, timer: null, rebuilds: 0, lastMs: 0 };

    function outlineNodes() {
      if (O.panel) return { button: O.button, panel: O.panel };
      O.button = el("button", { type: "button", id: "btn-carnet-outline", class: "carnet-btn carnet-outline-btn", "aria-label": "Plan de la page", title: "Plan de la page", "aria-expanded": "false", "aria-controls": "hq-carnet-outline" });
      O.button.appendChild(el("span", { class: "carnet-outline-btn-text", text: "Plan" }));
      O.panel = el("section", { id: "hq-carnet-outline", class: "carnet-outline", "aria-label": "Plan de la page", hidden: true });
      const head = el("div", { class: "carnet-outline-head" }, [
        el("h2", { class: "carnet-outline-title", text: "Plan de la page" }),
        el("button", { type: "button", class: "carnet-outline-close", "aria-label": "Fermer le plan", text: "Fermer" }),
      ]);
      O.groups = el("div", { class: "carnet-outline-body" });
      O.panel.appendChild(head);
      O.panel.appendChild(O.groups);
      O.button.addEventListener("click", () => (O.open ? outlineClose(true) : outlineOpen()));
      head.querySelector("button").addEventListener("click", () => outlineClose(true));
      O.panel.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          outlineClose(true);
        }
      });
      O.groups.addEventListener("click", (ev) => {
        const b = ev.target.closest && ev.target.closest("[data-carnet-outline-index]");
        if (!b) return;
        const index = Number(b.getAttribute("data-carnet-outline-index"));
        const ok = host.reveal(index, b.getAttribute("data-carnet-outline-id") || "");
        if (!ok) host.flash("Bloc introuvable");
        if (host.mobile()) outlineClose(false);
      });
      return { button: O.button, panel: O.panel };
    }

    function outlineBuild(force) {
      if (!O.panel) return;
      const t0 = host.now();
      const lines = host.lines();
      const model = N.buildOutline(lines, { drawingLabel: host.drawingLabel, untitled: "Page sans titre", titleIndex: host.titleIndex });
      if (!force && model.sig === O.sig) return;
      O.sig = model.sig;
      O.rebuilds += 1;
      O.groups.textContent = "";
      const groups = [["text", "Structure"], ["asset", "Éléments"]];
      let any = false;
      for (const g of groups) {
        const items = model.items.filter((i) => i.group === g[0]);
        if (!items.length) continue;
        any = true;
        const ul = el("ul", { class: "carnet-outline-list", "aria-label": g[1] });
        for (const it of items) {
          const b = el("button", {
            type: "button",
            class: "carnet-outline-item",
            "data-kind": it.kind,
            "data-carnet-outline-index": it.index,
            "data-carnet-outline-id": it.id || false,
            text: it.label,
          });
          ul.appendChild(el("li", {}, b));
        }
        O.groups.appendChild(el("h3", { class: "carnet-outline-sub", text: g[1] }));
        O.groups.appendChild(ul);
      }
      if (!any) O.groups.appendChild(el("p", { class: "carnet-outline-empty", text: "Aucun titre ni élément pour l'instant." }));
      O.lastMs = host.now() - t0;
    }

    function outlineOpen() {
      outlineNodes();
      O.open = true;
      O.panel.hidden = false;
      O.button.setAttribute("aria-expanded", "true");
      outlineBuild(true);
      const first = O.panel.querySelector(".carnet-outline-item") || O.panel.querySelector(".carnet-outline-close");
      if (first) first.focus();
    }

    function outlineClose(restore) {
      if (!O.panel) return;
      const had = O.open;
      O.open = false;
      O.panel.hidden = true;
      O.button.setAttribute("aria-expanded", "false");
      if (restore && had && O.button.isConnected) O.button.focus();
    }

    /** Called on every render: cheap when closed, debounced + signature-gated when open. */
    function outlineSchedule() {
      if (!O.open) return;
      if (O.timer) return;
      O.timer = host.setTimer(() => {
        O.timer = null;
        outlineBuild(false);
      }, OUTLINE_DEBOUNCE_MS);
    }

    // ------------------------------------------------------------------ inspector
    const I = { root: null, open: false, trigger: null, restore: null, inerted: [], view: null, spec: null, vp: null, stage: null, imgs: [], dims: null, pointers: new Map(), cmp: 50, ro: null, openedAt: 0, probeAt: 0, blockId: "", stem: "" };

    function inspectorBuild() {
      if (I.root) return;
      const backdrop = el("div", { class: "carnet-insp-backdrop" });
      const title = el("h2", { id: "hq-carnet-insp-title", class: "carnet-insp-title", text: "Inspection" });
      const closeBtn = el("button", { type: "button", class: "carnet-insp-close", "aria-label": "Fermer l'inspection", text: "Fermer" });
      const head = el("div", { class: "carnet-insp-head" }, [title, closeBtn]);
      const vp = el("div", { class: "carnet-insp-viewport", tabindex: "0", role: "group", "aria-label": "Aperçu : flèches pour déplacer, + et - pour zoomer, 0 pour ajuster" });
      const stage = el("div", { class: "carnet-insp-stage" });
      vp.appendChild(stage);
      const gone = el("div", { class: "carnet-insp-gone", role: "note", hidden: true });
      vp.appendChild(gone);
      const tools = el("div", { class: "carnet-insp-tools", role: "toolbar", "aria-label": "Zoom" }, [
        el("button", { type: "button", "data-insp": "out", "aria-label": "Zoom arrière", text: "−" }),
        el("span", { class: "carnet-insp-zoom", "aria-live": "off", text: "100 %" }),
        el("button", { type: "button", "data-insp": "in", "aria-label": "Zoom avant", text: "+" }),
        el("button", { type: "button", "data-insp": "fit", "aria-label": "Ajuster à la fenêtre", text: "Ajuster" }),
        el("button", { type: "button", "data-insp": "prev", "aria-label": "Image précédente", text: "‹", hidden: true }),
        el("button", { type: "button", "data-insp": "next", "aria-label": "Image suivante", text: "›", hidden: true }),
      ]);
      const meta = el("dl", { class: "carnet-insp-meta" });
      const actions = el("div", { class: "carnet-insp-actions" });
      const root = el("div", { id: "hq-carnet-inspector", class: "carnet-inspector", role: "dialog", "aria-labelledby": "hq-carnet-insp-title", hidden: true }, [backdrop, el("div", { class: "carnet-insp-panel" }, [head, vp, tools, meta, actions])]);
      I.root = root;
      I.vp = vp;
      I.stage = stage;
      I.gone = gone;
      I.title = title;
      I.meta = meta;
      I.actions = actions;
      I.tools = tools;
      I.zoomEl = tools.querySelector(".carnet-insp-zoom");
      closeBtn.addEventListener("click", () => inspectClose());
      // the click that ends the double-tap which opened the inspector lands on the backdrop: ignore it for a moment
      backdrop.addEventListener("click", () => {
        if (host.now() - I.openedAt > 500) inspectClose();
      });
      tools.addEventListener("click", (ev) => {
        const b = ev.target.closest && ev.target.closest("[data-insp]");
        if (!b) return;
        const a = b.getAttribute("data-insp");
        if (a === "in") zoomBy(1.4);
        else if (a === "out") zoomBy(1 / 1.4);
        else if (a === "fit") viewReset();
        else if (a === "prev" || a === "next") step(a === "next" ? 1 : -1);
      });
      root.addEventListener("keydown", onInspectKey);
      vp.addEventListener("wheel", onWheel, { passive: false });
      vp.addEventListener("pointerdown", onPointerDown);
      vp.addEventListener("pointermove", onPointerMove);
      vp.addEventListener("pointerup", onPointerUp);
      vp.addEventListener("pointercancel", onPointerUp);
      vp.addEventListener("dblclick", (ev) => {
        if (ev.target.closest && ev.target.closest(".carnet-insp-handle")) return;
        if (I.view.z > 1.01) viewReset();
        else zoomBy(2.5, ev);
      });
      doc.body.appendChild(root);
    }

    function dims() {
      const vw = I.vp.clientWidth || 1;
      const vh = I.vp.clientHeight || 1;
      const im = I.imgs[0];
      const nw = (im && im.naturalWidth) || vw;
      const nh = (im && im.naturalHeight) || vh;
      const ar = nw / nh;
      const dw = ar > vw / vh ? vw : vh * ar;
      const dh = ar > vw / vh ? vw / ar : vh;
      return { vw, vh, dw, dh };
    }

    function paint() {
      const d = dims();
      I.view = N.viewClamp(I.view, d.vw, d.vh, d.dw, d.dh);
      const v = I.view;
      I.stage.style.width = d.dw + "px";
      I.stage.style.height = d.dh + "px";
      I.stage.style.marginLeft = -d.dw / 2 + "px";
      I.stage.style.marginTop = -d.dh / 2 + "px";
      I.stage.style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.z + ")";
      I.stage.style.setProperty("--z", String(v.z));
      I.root.dataset.zoom = String(Math.round(v.z * 100));
      I.zoomEl.textContent = Math.round(v.z * 100) + " %";
      I.vp.style.cursor = v.z > 1 ? "grab" : "default";
    }

    function viewReset() {
      I.view = N.viewInit();
      paint();
    }

    function zoomBy(f, ev) {
      const d = dims();
      let cx = 0;
      let cy = 0;
      if (ev && typeof ev.clientX === "number") {
        const r = I.vp.getBoundingClientRect();
        cx = ev.clientX - (r.left + r.width / 2);
        cy = ev.clientY - (r.top + r.height / 2);
      }
      I.view = N.viewZoomAt(I.view, f, cx, cy, d.vw, d.vh, d.dw, d.dh);
      paint();
    }

    function onWheel(ev) {
      if (!I.open) return;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev);
    }

    function pdist() {
      const p = [...I.pointers.values()];
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }

    function onPointerDown(ev) {
      if (ev.target.closest && ev.target.closest(".carnet-insp-handle")) return;
      I.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try {
        I.vp.setPointerCapture(ev.pointerId);
      } catch (_) {}
      I.pinch = I.pointers.size === 2 ? pdist() : 0;
    }

    function onPointerMove(ev) {
      const p = I.pointers.get(ev.pointerId);
      if (!p) return;
      const dx = ev.clientX - p.x;
      const dy = ev.clientY - p.y;
      p.x = ev.clientX;
      p.y = ev.clientY;
      const d = dims();
      if (I.pointers.size === 2 && I.pinch) {
        const nd = pdist();
        const pts = [...I.pointers.values()];
        const r = I.vp.getBoundingClientRect();
        const mid = { clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 };
        void r;
        zoomBy(nd / I.pinch, mid);
        I.pinch = nd;
      } else if (I.pointers.size === 1 && I.view.z > 1) {
        I.view = N.viewPan(I.view, dx, dy, d.vw, d.vh, d.dw, d.dh);
        paint();
      }
    }

    function onPointerUp(ev) {
      I.pointers.delete(ev.pointerId);
      I.pinch = I.pointers.size === 2 ? pdist() : 0;
    }

    function step(dir) {
      if (!I.spec || I.spec.kind !== "imagegroup" || !I.group) return;
      const n = I.group.ids.length;
      I.group.index = (I.group.index + dir + n) % n;
      inspectOpen(Object.assign({}, I.input, { index: I.group.index }), I.trigger, { keep: true });
    }

    function onInspectKey(ev) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        inspectClose();
        return;
      }
      if (ev.key === "Tab") {
        const list = [...I.root.querySelectorAll(TABBABLE)].filter((n) => !n.hidden && !n.closest("[hidden]") && n.offsetParent !== null);
        if (!list.length) {
          ev.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const a = doc.activeElement;
        if (!I.root.contains(a)) {
          ev.preventDefault();
          first.focus();
        } else if (ev.shiftKey && a === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && a === last) {
          ev.preventDefault();
          first.focus();
        }
        return;
      }
      if (ev.target && ev.target.closest && ev.target.closest(".carnet-insp-handle")) return; // the compare slider owns its arrow keys
      if (ev.target && ev.target.closest && ev.target.closest("button,select,input,textarea") && ev.key !== "+" && ev.key !== "-" && ev.key !== "0") return;
      const d = dims();
      if (ev.key === "+" || ev.key === "=") zoomBy(1.4);
      else if (ev.key === "-" || ev.key === "_") zoomBy(1 / 1.4);
      else if (ev.key === "0") viewReset();
      else if (ev.key.indexOf("Arrow") === 0 && ev.target === I.vp) {
        const k = 40;
        const dx = ev.key === "ArrowLeft" ? k : ev.key === "ArrowRight" ? -k : 0;
        const dy = ev.key === "ArrowUp" ? k : ev.key === "ArrowDown" ? -k : 0;
        I.view = N.viewPan(I.view, dx, dy, d.vw, d.vh, d.dw, d.dh);
        paint();
        ev.preventDefault();
      }
    }

    function makeInert() {
      I.inerted = [];
      const canInert = "inert" in doc.documentElement;
      for (const n of [...doc.body.children]) {
        if (n === I.root || n.tagName === "SCRIPT") continue;
        I.inerted.push({ n, inert: n.inert === true, aria: n.getAttribute("aria-hidden") });
        if (canInert) n.inert = true;
        n.setAttribute("aria-hidden", "true");
      }
      I.root.setAttribute("aria-modal", "true"); // only now: the rest of the document really is out of reach
    }

    function restoreInert() {
      for (const r of I.inerted) {
        if ("inert" in doc.documentElement) r.n.inert = r.inert;
        if (r.aria === null) r.n.removeAttribute("aria-hidden");
        else r.n.setAttribute("aria-hidden", r.aria);
      }
      I.inerted = [];
      if (I.root) I.root.removeAttribute("aria-modal");
    }

    function metaRow(k, v, cls) {
      I.meta.appendChild(el("dt", { text: k }));
      I.meta.appendChild(el("dd", { class: cls || false, text: v }));
    }

    function showGone(msg) {
      I.gone.hidden = false;
      I.gone.textContent = msg;
      I.stage.hidden = true;
      I.root.dataset.state = "missing";
      I.tools.querySelectorAll('[data-insp="in"],[data-insp="out"],[data-insp="fit"]').forEach((b) => (b.disabled = true));
      const open = I.actions.querySelector("[data-insp-open]");
      if (open) open.hidden = true; // an Open action only exists while the drawing still resolves
    }

    function fillActions(spec, input) {
      I.actions.textContent = "";
      if (spec.kind === "drawing") {
        const open = el("button", { type: "button", "data-insp-open": "", class: "carnet-insp-open", text: "Ouvrir dans Dessiner", "aria-label": "Ouvrir dans Dessiner : " + host.drawingLabel(spec.stem) });
        open.addEventListener("click", () => {
          const blockId = I.blockId;
          const stem = spec.stem;
          inspectClose(true);
          host.openDrawing(stem, blockId);
        });
        I.actions.appendChild(open);
        const offer = I.blockId ? host.offer(I.blockId) : null;
        if (offer && offer.from === spec.stem && !host.readOnly()) {
          const use = el("button", { type: "button", class: "carnet-insp-use", text: "Utiliser cette version", "aria-label": "Utiliser cette version : " + host.drawingLabel(offer.to) });
          use.addEventListener("click", () => {
            const ok = host.useOffer(I.blockId);
            inspectClose(true);
            if (!ok) host.flash("Cette version n'est plus proposée");
          });
          I.actions.appendChild(use);
        }
      }
    }

    function buildCompare(spec) {
      I.stage.textContent = "";
      I.imgs = [];
      const before = el("img", { class: "carnet-insp-img", src: spec.compare.before, alt: "Avant", draggable: "false" });
      const after = el("img", { class: "carnet-insp-img carnet-insp-after", src: spec.compare.after, alt: "Après", draggable: "false" });
      const handle = el("div", { class: "carnet-insp-handle", tabindex: "0", role: "slider", "aria-label": "Comparaison avant / après", "aria-orientation": "horizontal", "aria-valuemin": "0", "aria-valuemax": "100" });
      handle.appendChild(el("span", { class: "carnet-insp-thumb", "aria-hidden": "true", text: "⇆" }));
      I.stage.appendChild(before);
      I.stage.appendChild(after);
      I.stage.appendChild(handle);
      I.imgs = [before, after];
      I.cmp = 50;
      const apply = () => {
        const p = N.compareClamp(I.cmp);
        I.cmp = p;
        after.style.clipPath = "inset(0 0 0 " + p + "%)";
        handle.style.left = p + "%";
        handle.setAttribute("aria-valuenow", String(p));
        handle.setAttribute("aria-valuetext", "Avant à gauche, après à droite : séparation à " + p + " %");
      };
      handle.addEventListener("keydown", (ev) => {
        const n = N.compareKey(I.cmp, ev.key);
        if (n === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        I.cmp = n;
        apply();
      });
      let drag = false;
      const move = (ev) => {
        if (!drag) return;
        const r = I.stage.getBoundingClientRect();
        I.cmp = ((ev.clientX - r.left) / r.width) * 100;
        apply();
      };
      handle.addEventListener("pointerdown", (ev) => {
        drag = true;
        try {
          handle.setPointerCapture(ev.pointerId);
        } catch (_) {}
        ev.stopPropagation();
      });
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", () => (drag = false));
      handle.addEventListener("pointercancel", () => (drag = false));
      apply();
    }

    /**
     * input: {kind:"drawing", stem} | {kind:"image", assetId} | {kind:"imagegroup", assetIds, layout, index}; blockId optional.
     * trigger: the element that opened it (focus returns there; if it was removed meanwhile, opts.restore()/the host fallback is used).
     */
    function inspectOpen(input, trigger, opts) {
      const spec = N.inspectSpec(input);
      if (!spec) {
        host.flash("Aperçu indisponible");
        return false;
      }
      const t0 = host.now();
      inspectorBuild();
      const keep = !!(opts && opts.keep);
      I.input = input;
      I.spec = spec;
      I.blockId = (input && typeof input.blockId === "string" && N.BLOCK_RE.test(input.blockId)) ? input.blockId : "";
      I.group = spec.kind === "imagegroup" && !spec.compare ? { ids: input.assetIds, index: Math.max(0, input.index | 0) } : null;
      if (!keep) {
        I.trigger = trigger || null;
        I.restore = opts && typeof opts.restore === "function" ? opts.restore : null;
      }
      I.root.dataset.state = "loading";
      I.root.dataset.kind = spec.kind;
      I.root.dataset.compare = spec.compare ? "1" : "0";
      I.gone.hidden = true;
      I.stage.hidden = false;
      I.tools.querySelectorAll("button").forEach((b) => (b.disabled = false));
      I.tools.querySelector('[data-insp="prev"]').hidden = !I.group || I.group.ids.length < 2;
      I.tools.querySelector('[data-insp="next"]').hidden = !I.group || I.group.ids.length < 2;
      I.view = N.viewInit();
      I.meta.textContent = "";
      I.title.textContent = spec.kind === "drawing" ? "Croquis : " + host.drawingLabel(spec.stem) : spec.compare ? "Avant / après" : "Image";
      if (spec.kind === "drawing") {
        I.stem = spec.stem;
        metaRow("Version (stem exact)", spec.stem, "carnet-insp-stem");
        const parentEl = el("dd", { class: "carnet-insp-parent", text: "…" });
        I.meta.appendChild(el("dt", { text: "Version parente" }));
        I.meta.appendChild(parentEl);
        const stem = spec.stem;
        host.api("/api/drawings/open?stem=" + encodeURIComponent(stem)).then(
          (doc2) => {
            if (!I.open || I.stem !== stem) return;
            const p = doc2 && doc2.meta && typeof doc2.meta.parent === "string" ? doc2.meta.parent : "";
            parentEl.textContent = p || "Première version (aucun parent)";
            if (p) parentEl.setAttribute("data-parent", p);
          },
          () => {
            if (I.open && I.stem === stem) parentEl.textContent = "Inconnue";
          },
        );
      }
      if (spec.compare) buildCompare(spec);
      else {
        I.stage.textContent = "";
        const img = el("img", { class: "carnet-insp-img", src: spec.src, alt: spec.kind === "drawing" ? "Croquis : " + host.drawingLabel(spec.stem) : "Image", draggable: "false" });
        I.stage.appendChild(img);
        I.imgs = [img];
      }
      fillActions(spec, input);
      for (const im of I.imgs) {
        im.addEventListener("load", () => {
          if (!I.open) return;
          I.root.dataset.state = "ok";
          I.root.dataset.loadMs = String(Math.round(host.now() - t0));
          paint();
        });
        im.addEventListener("error", () => {
          if (!I.open) return;
          showGone(spec.kind === "drawing" ? "Croquis indisponible" : "Image indisponible");
        });
      }
      if (!I.open) {
        I.open = true;
        I.openedAt = host.now();
        I.root.hidden = false;
        makeInert();
        if (!I.ro && typeof host.win.ResizeObserver === "function") {
          I.ro = new host.win.ResizeObserver(() => {
            if (I.open && I.imgs.length) paint();
          });
          I.ro.observe(I.vp);
        }
      }
      paint();
      if (!keep) {
        const target = I.root.querySelector(".carnet-insp-close");
        if (target) target.focus();
      }
      I.root.dataset.openMs = String(Math.round(host.now() - t0));
      return true;
    }

    function inspectClose(skipRestore) {
      if (!I.open) return;
      I.open = false;
      I.pointers.clear();
      I.root.hidden = true;
      I.root.dataset.state = "";
      I.stage.textContent = "";
      I.imgs = [];
      restoreInert();
      if (skipRestore) return;
      let target = I.trigger && I.trigger.isConnected && !I.trigger.closest("[hidden]") ? I.trigger : null;
      if (!target && I.restore) {
        try {
          target = I.restore();
        } catch (_) {
          target = null;
        }
      }
      if (!target || !target.isConnected) target = host.fallbackFocus();
      I.trigger = null;
      I.restore = null;
      if (target && typeof target.focus === "function") target.focus();
    }

    /** Throttled re-check while open: a drawing that stops resolving flips to the explicit unavailable state (the block keeps its ref). */
    function inspectRecheck() {
      if (!I.open || !I.spec || I.spec.kind !== "drawing" || I.root.dataset.state === "missing") return;
      const now = host.now();
      if (now - I.probeAt < 4000) return;
      I.probeAt = now;
      const probe = new host.win.Image();
      const stem = I.stem;
      probe.onerror = () => {
        if (I.open && I.stem === stem) showGone("Croquis indisponible");
      };
      probe.src = I.spec.src + "&r=" + now;
    }

    return {
      saveNodes, saveUpdate,
      outlineNodes, outlineSchedule, outlineBuild, outlineOpen, outlineClose,
      outlineState: () => ({ open: O.open, sig: O.sig, rebuilds: O.rebuilds, lastMs: O.lastMs }),
      inspectOpen, inspectClose, inspectRecheck,
      inspectorOpen: () => I.open,
      saveState: () => ({ state: S.state, announced: S.announced }),
    };
  }

  return { mount, LIVE_DEBOUNCE_MS, OUTLINE_DEBOUNCE_MS };
});
