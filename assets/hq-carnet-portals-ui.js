/* Transfert HQ — Carnet Phase 8: portal blocks UI.
 *
 * A portal block shows another HQ object (source / file / model / media / snapshot / review) read-only. The page stores the
 * reference only; the state shown here is the live answer of the read-only batched resolver (POST portal_resolve), held in memory
 * for this page view and never written back. "Actualiser" only reruns the resolver: it never saves, dirties or versions the page.
 * Removing a portal never touches its target. DOM is built with createElement / textContent only: no embedded frame, no HTML injection.
 * Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetPortalsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const P = node ? require("./hq-carnet-portals.js") : global.HqCarnetPortals;
  const M = node ? require("./hq-carnet-modal.js") : global.HqCarnetModal;
  const PICK_MSG = {
    title: "Insérer un portail",
    replaceTitle: "Remplacer la cible du portail",
    intro: "Le portail affiche l’objet en lecture seule. Le carnet ne garde que la référence.",
    none: "Aucun objet de ce type disponible.",
    unavailable: "Liste indisponible.",
    pathLabel: "Chemin dans HQ",
    pathHint: "Ex. Inbox/Models/pièce.glb",
    check: "Vérifier et choisir",
    notFound: "Objet introuvable : le portail n’est pas créé.",
    invalid: "Chemin invalide.",
    cancel: "Annuler",
  };

  function el(doc, tag, attrs, text) {
    const n = doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function mount(host) {
    const doc = host.doc;
    const cards = new Set();
    const rows = new Map(); // last loaded row per reference (memory only; never persisted)
    const pending = new Map();
    let timer = null;
    let layer = null;

    const keyOf = (ref) => ref.kind + "\u0000" + ref.id;

    function offline() {
      return typeof host.online === "function" && !host.online();
    }

    /** One flush = the pending references of the whole page, deduplicated, in batches of at most 100. */
    async function flush() {
      timer = null;
      const wanted = new Map(pending);
      pending.clear();
      const refs = P.uniqueRefs(Array.from(wanted.values()).map((ref) => ({ ref })));
      for (const body of P.batchBodies(refs)) {
        let res = null;
        let failed = false;
        try {
          if (offline()) throw new Error("offline");
          res = await host.api.post(body);
        } catch (_) {
          failed = true;
        }
        const got = failed ? null : P.rowsFor(body.refs, res);
        body.refs.forEach((ref, i) => {
          const k = keyOf(ref);
          if (got) rows.set(k, got[i]);
          for (const c of Array.from(cards)) {
            if (!c.box.isConnected) {
              cards.delete(c);
              continue;
            }
            if (keyOf(c.payload.ref) === k) c.paint(failed);
          }
        });
      }
    }

    function request(ref) {
      pending.set(keyOf(ref), { kind: ref.kind, id: ref.id });
      if (timer === null) timer = host.timeout ? host.timeout(flush, 0) : setTimeout(flush, 0);
    }

    function refreshAll() {
      for (const c of Array.from(cards)) {
        if (!c.box.isConnected) cards.delete(c);
        else request(c.payload.ref);
      }
    }

    // ------------------------------------------------------------------ picker (insert / replace)

    // ---- modal containment: the ONE shared Carnet utility (Tab / Shift+Tab wrap, focus cannot leave, exact focus return)
    let modal = null;

    function openModal(node, trigger, initial) {
      closeModal(false);
      modal = { node, handle: M.open(doc, node, { layer: "sheet", trigger, initial, mount: () => host.root().appendChild(node) }) };
    }

    /** Removes the open modal. ``refocus`` returns focus to the control that opened it (when it still exists). */
    function closeModal(refocus) {
      if (!modal) return false;
      const m = modal;
      modal = null;
      return m.handle.close(refocus); // true only when the exact opener took focus: the caller falls back otherwise
    }

    function closeLayer() {
      layer = null;
      closeModal(false);
    }

    function openPicker(opts) {
      const active = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      const opener = opts.trigger || active;
      const rootEl = host.root();
      layer = el(doc, "div", { class: "carnet-pb-picker", role: "dialog", "aria-modal": "true", "aria-label": opts.title, id: "hq-carnet-portal-picker" });
      const form = el(doc, "div", { class: "carnet-pb-picker-body" });
      form.appendChild(el(doc, "h2", {}, opts.title));
      form.appendChild(el(doc, "p", { class: "hint" }, PICK_MSG.intro));
      const kindSel = el(doc, "select", { id: "carnet-pb-kind", "aria-label": "Type d’objet" });
      for (const k of P.KINDS) kindSel.appendChild(el(doc, "option", { value: k }, P.KIND_LABEL[k]));
      if (opts.current) kindSel.value = opts.current.kind;
      const viewSel = el(doc, "select", { id: "carnet-pb-view", "aria-label": "Présentation" });
      viewSel.appendChild(el(doc, "option", { value: "card" }, "Carte"));
      viewSel.appendChild(el(doc, "option", { value: "compact" }, "Compacte"));
      if (opts.view) viewSel.value = opts.view;
      const msg = el(doc, "p", { class: "carnet-pb-msg", role: "status", "aria-live": "polite" });
      const body = el(doc, "div", { class: "carnet-pb-picker-list" });
      const pick = (kind, id) => {
        const ref = { kind, id };
        const view = viewSel.value;
        // The target must exist: a portal to nothing is never created from the picker.
        host.api
          .post({ action: "portal_resolve", refs: [ref] })
          .then((res) => {
            const row = P.rowsFor([ref], res)[0];
            if (row.state === "missing" || row.state === "unknown") {
              msg.textContent = PICK_MSG.notFound;
              return;
            }
            layer = null;
            closeModal(false);
            opts.onPick({ ref, view });
          })
          .catch(() => {
            msg.textContent = PICK_MSG.unavailable;
          });
      };
      const paintList = (items) => {
        body.textContent = "";
        if (!items.length) {
          body.appendChild(el(doc, "p", { class: "hint" }, PICK_MSG.none));
          return;
        }
        for (const it of items.slice(0, 200)) {
          const b = el(doc, "button", { type: "button", class: "carnet-pb-choice", "data-pb-id": it.id }, it.label);
          b.addEventListener("click", () => pick(kindSel.value, it.id));
          body.appendChild(b);
        }
      };
      const paintPath = () => {
        body.textContent = "";
        const input = el(doc, "input", { type: "text", id: "carnet-pb-path", "aria-label": PICK_MSG.pathLabel, placeholder: PICK_MSG.pathHint, autocomplete: "off", spellcheck: "false" });
        const go = el(doc, "button", { type: "button", class: "carnet-pb-go" }, PICK_MSG.check);
        go.addEventListener("click", () => {
          const id = input.value.trim();
          if (!host.checkRef({ kind: kindSel.value, id })) {
            msg.textContent = PICK_MSG.invalid;
            return;
          }
          pick(kindSel.value, id);
        });
        body.appendChild(el(doc, "label", { for: "carnet-pb-path" }, PICK_MSG.pathLabel));
        body.appendChild(input);
        body.appendChild(go);
      };
      let seq = 0;
      const load = async () => {
        const my = ++seq;
        msg.textContent = "";
        const kind = kindSel.value;
        if (kind === "file" || kind === "model" || kind === "media") return paintPath();
        body.textContent = "";
        try {
          const items = await host.list(kind);
          if (my === seq) paintList(items);
        } catch (_) {
          if (my === seq) {
            body.textContent = "";
            msg.textContent = PICK_MSG.unavailable;
          }
        }
      };
      kindSel.addEventListener("change", load);
      const cancel = el(doc, "button", { type: "button", class: "carnet-pb-cancel" }, PICK_MSG.cancel);
      cancel.addEventListener("click", () => {
        layer = null;
        const back = closeModal(true); // exact opener (the Replace button / the Insert control) when it still exists
        if (!back && opts.onCancel) opts.onCancel();
      });
      layer.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          cancel.click();
        }
      });
      form.appendChild(kindSel);
      form.appendChild(viewSel);
      form.appendChild(msg);
      form.appendChild(body);
      form.appendChild(cancel);
      layer.appendChild(form);
      void rootEl;
      openModal(layer, opener, kindSel);
      load();
    }

    // ------------------------------------------------------------------ inspector (read-only; one live detailed lookup, never stored)

    let inspector = null;

    function closeInspector(refocus) {
      if (!inspector) return;
      const mine = inspector;
      inspector = null;
      if (modal && modal.node === mine.node) closeModal(refocus);
      else mine.node.remove();
    }

    function inspectPanel(ref, row, trigger) {
      closeInspector(false);
      if (layer) closeLayer();
      const node = el(doc, "div", { class: "carnet-pb-inspector", role: "dialog", "aria-modal": "true", "aria-label": "Inspecter le portail : " + P.KIND_LABEL[ref.kind], id: "hq-carnet-portal-inspector" });
      const body = el(doc, "div", { class: "carnet-pb-picker-body" });
      body.appendChild(el(doc, "h2", {}, P.KIND_LABEL[ref.kind] + " — " + ((row && row.title) || ref.id)));
      body.appendChild(el(doc, "p", { class: "hint" }, P.MSG.live));
      const dl = el(doc, "dl", { class: "carnet-pb-meta" });
      const fill = (r) => {
        dl.textContent = "";
        const add = (k, v) => {
          dl.appendChild(el(doc, "dt", {}, k));
          dl.appendChild(el(doc, "dd", {}, String(v)));
        };
        add("Référence stockée", ref.id);
        if (r) {
          add("État", r.state_label);
          for (const m of r.metadata) add(m.label, m.value);
        }
      };
      fill(row);
      const msg = el(doc, "p", { class: "carnet-pb-msg", role: "status", "aria-live": "polite" });
      const close = el(doc, "button", { type: "button", class: "carnet-pb-cancel" }, "Fermer");
      close.addEventListener("click", () => closeInspector(true));
      node.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeInspector(true);
        }
      });
      body.appendChild(dl);
      body.appendChild(msg);
      body.appendChild(close);
      node.appendChild(body);
      inspector = { node, trigger };
      openModal(node, trigger, close);
      const one = { kind: ref.kind, id: ref.id };
      host.api
        .post({ action: "portal_resolve", refs: [one], detail: true })
        .then((res) => {
          if (!inspector || inspector.node !== node) return;
          fill(P.rowsFor([one], res)[0]);
        })
        .catch(() => {
          if (inspector && inspector.node === node) msg.textContent = P.MSG.stale;
        });
    }

    // ------------------------------------------------------------------ the block

    function button(text, cls, fn, aria) {
      const b = el(doc, "button", { type: "button", class: cls }, text);
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", fn);
      return b;
    }

    function render(wrapper, payload, idx, box, ro, api) {
      const entry = { box, payload, paint: null };
      const card = el(doc, "div", { class: "carnet-pb", "data-kind": payload.ref.kind, "data-view": payload.view, "data-state": "loading", role: "group" });
      const kindLine = el(doc, "div", { class: "carnet-pb-kind" }, P.KIND_LABEL[payload.ref.kind]);
      const title = el(doc, "div", { class: "carnet-pb-title" });
      const sub = el(doc, "div", { class: "carnet-pb-sub" });
      const state = el(doc, "div", { class: "carnet-pb-state", role: "status", "aria-live": "polite" });
      const meta = el(doc, "dl", { class: "carnet-pb-meta" });
      const thumbHost = el(doc, "div", { class: "carnet-pb-thumb" });
      const bar = el(doc, "div", { class: "carnet-struct-bar carnet-pb-bar", role: "toolbar" });
      const note = el(doc, "div", { class: "carnet-pb-note" }, P.MSG.live);
      let lastRow = rows.get(keyOf(payload.ref)) || null;

      const openBtn = button(payload.ref.kind === "source" ? P.MSG.openReader : P.MSG.open, "carnet-pb-open", () => host.open(payload.ref, lastRow, { trigger: openBtn, wrapper }), null);
      const inspectBtn = button(P.MSG.inspect, "carnet-pb-inspect", () => inspectPanel(payload.ref, lastRow, inspectBtn), null);
      const refreshBtn = button(P.MSG.refresh, "carnet-pb-refresh", () => {
        state.textContent = P.MSG.loading;
        request(payload.ref);
      }, "Actualiser l’état du portail (lecture seule, la page n’est pas enregistrée)");
      bar.appendChild(openBtn);
      bar.appendChild(inspectBtn);
      bar.appendChild(refreshBtn);
      if (!ro) {
        const replaceBtn = button(P.MSG.replace, "carnet-pb-replace", () => {
          openPicker({
            trigger: replaceBtn,
            title: PICK_MSG.replaceTitle,
            current: payload.ref,
            view: payload.view,
            onPick: (next) => api.commit(wrapper, { ref: next.ref, view: next.view }, { rerender: true }),
          });
        });
        bar.appendChild(replaceBtn);
        const view = payload.view === "card" ? "compact" : "card";
        bar.appendChild(button(view === "compact" ? "Vue compacte" : "Vue carte", "carnet-pb-view", () => api.commit(wrapper, { ref: payload.ref, view }, { rerender: true })));
      }

      entry.paint = (failed, cachedOnly) => {
        lastRow = rows.get(keyOf(payload.ref)) || null;
        const m = P.cardModel(payload, lastRow, { stale: !!((failed || cachedOnly) && lastRow), failed: !!(failed && !lastRow) });
        card.setAttribute("data-state", m.state);
        card.setAttribute("data-stale", m.stale ? "1" : "0");
        kindLine.textContent = m.kindLabel;
        title.textContent = m.title;
        sub.textContent = m.subtitle && m.subtitle !== m.title ? m.subtitle : "";
        state.textContent = m.stateLabel;
        card.setAttribute("aria-label", m.kindLabel + " : " + m.title + " — " + m.stateLabel);
        meta.textContent = "";
        for (const r of m.metadata) {
          meta.appendChild(el(doc, "dt", {}, r.label));
          meta.appendChild(el(doc, "dd", {}, String(r.value)));
        }
        thumbHost.textContent = "";
        if (m.thumb) {
          const img = el(doc, "img", { src: m.thumb, alt: "", loading: "lazy", decoding: "async", draggable: "false" });
          thumbHost.appendChild(img);
        }
        thumbHost.hidden = !m.thumb;
        openBtn.hidden = m.actions.indexOf("open") < 0;
        inspectBtn.hidden = m.actions.indexOf("inspect") < 0;
        note.hidden = m.compact;
      };

      card.appendChild(thumbHost);
      const head = el(doc, "div", { class: "carnet-pb-head" });
      head.appendChild(kindLine);
      head.appendChild(title);
      head.appendChild(sub);
      head.appendChild(state);
      card.appendChild(head);
      card.appendChild(meta);
      card.appendChild(note);
      card.appendChild(bar);
      box.appendChild(card);
      cards.add(entry);
      entry.paint(false, true);
      request(payload.ref);
    }

    return { render, refreshAll, closeInspector, openPicker, close: () => closeModal(false), rows: () => rows, size: () => cards.size };
  }

  return { PICK_MSG, mount };
});
