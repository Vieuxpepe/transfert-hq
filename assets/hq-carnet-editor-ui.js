/* Transfert HQ — Carnet editor UI: floating selection toolbar, "/" command menu, block rail and between-block "+".
 *
 * Everything here is TRANSIENT presentation: floating elements that live next to the editor (never inside it), so the strict
 * editor parser never sees them. Nothing is persisted by this module and nothing is written on pointer/keyboard navigation:
 * an action ends in ONE host call (host.format / host.commit / host.command ...) that goes through the normal Carnet edit
 * path (draft, debounced autosave, revision checks).
 *
 * Stale protection: every floating UI captures a stamp {page, revision, editor generation} (+ block id / text / offsets). It is
 * re-checked when the action is applied; when anything changed the action FAILS CLOSED (nothing is applied, a message says so,
 * no automatic retry). A "/" that was swallowed by the menu is re-inserted (once, literally) only when the original context is
 * still valid on a normal dismissal; if the page switched or the block changed, nothing is mutated.
 *
 * Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetEditorUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SEL_ACTIONS = [
    ["bold", "G", "Gras"],
    ["italic", "I", "Italique"],
    ["underline", "S", "Souligné"],
    ["highlight", "Surligné", "Surligné"],
    ["code", "Code", "Code"],
    ["link", "Lien", "Lien"],
    ["cite", "Référence", "Référence"],
    ["clear", "Effacer", "Effacer la mise en forme"],
  ];

  const CMD_SEL = "[data-carnet-cmd],[data-carnet-cmd-recent],[data-carnet-cmd-suggest]";

  const MSG = {
    stale: "Le contexte a changé : action annulée, rien n'a été modifié",
    readonly: "Cette page est en lecture seule",
    edge: "Déjà au bout de la page",
    limitBlocks: "Limite de blocs atteinte",
    limitImages: "Limite d'images atteinte pour cette page",
    limitStruct: "Limite de blocs structur\u00e9s atteinte pour cette page",
    limitDecisions: "Limite de décisions atteinte pour cette page",
    refused: "Modification refusée",
  };

  /** Pure: clamp a floating box of size (w, h) near an anchor rect into the viewport. `below` chooses the preferred side. */
  function place(anchor, size, view, below, gap) {
    const g = gap == null ? 8 : gap;
    const margin = 8;
    let top = below ? anchor.bottom + g : anchor.top - size.h - g;
    if (below && top + size.h > view.h - margin) top = anchor.top - size.h - g;
    if (!below && top < margin) top = anchor.bottom + g;
    top = Math.max(margin, Math.min(top, Math.max(margin, view.h - size.h - margin)));
    let left = anchor.left + (anchor.right - anchor.left) / 2 - size.w / 2;
    left = Math.max(margin, Math.min(left, Math.max(margin, view.w - size.w - margin)));
    return { top: Math.round(top), left: Math.round(left) };
  }

  /**
   * One command row, shared by the "/" menu, the between-block "+" and the "+ Insérer" popover: icon, label, concise description, and
   * (only when a REAL shortcut exists for that exact command) a key hint. Pure DOM construction, no HTML strings.
   */
  function commandRow(doc, c, opts) {
    const o = opts || {};
    const frag = doc.createDocumentFragment();
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "carnet-cmd-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", c.icon || "M5 12h14");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    frag.appendChild(svg);
    const text = doc.createElement("span");
    text.className = "carnet-cmd-text";
    const label = doc.createElement("span");
    label.className = "carnet-cmd-label";
    label.textContent = c.label;
    const hint = doc.createElement("span");
    hint.className = "carnet-cmd-hint";
    hint.textContent = c.hint;
    text.appendChild(label);
    text.appendChild(hint);
    frag.appendChild(text);
    if (o.category) {
      const tag = doc.createElement("span");
      tag.className = "carnet-cmd-cat";
      tag.textContent = o.category;
      frag.appendChild(tag);
    }
    if (c.shortcut) {
      const k = doc.createElement("kbd");
      k.className = "carnet-cmd-kbd";
      k.textContent = c.shortcut;
      frag.appendChild(k);
    }
    return frag;
  }

  function mount(host) {
    const doc = host.doc;
    const win = host.win || (doc && doc.defaultView);
    const C = host.commands;
    const Rich = host.rich;
    const S = {
      tb: null, tbStamp: null, tbDismissed: null, composing: false, literal: false, raf: 0,
      menuState: null, rail: null, blockMenu: null, hideTimer: 0, armed: null,
    };

    function el(tag, attrs, kids) {
      const n = doc.createElement(tag);
      for (const k of Object.keys(attrs || {})) {
        if (k === "text") n.textContent = attrs[k];
        else if (attrs[k] === true) n.setAttribute(k, "");
        else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, String(attrs[k]));
      }
      for (const c of kids || []) n.appendChild(c);
      return n;
    }
    const say = (t, err) => host.status && host.status(t, !!err);
    const editor = () => host.editor();
    const view = () => ({ w: win.innerWidth || doc.documentElement.clientWidth, h: win.innerHeight || doc.documentElement.clientHeight });
    const stamp = () => {
      const s = host.state();
      return s ? { pageId: s.pageId, rev: s.rev, gen: s.gen } : null;
    };
    // {page, generation}: the generation bumps on every local edit AND on every adopted remote/restored version; an own autosave
    // (revision bump, temporary id -> real id) does not, so it never makes a still-valid context look stale.
    const sameStamp = (a, b) => !!a && !!b && a.pageId === b.pageId && a.gen === b.gen;
    const sameId = (was, now) => (was || null) === (now || null) || !was || Rich.isTmpId(was);
    const nextFrame = (fn) => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 16));
    const keepFocus = (b) => b.addEventListener("mousedown", (e) => e.preventDefault());

    function position(node, anchor, below) {
      node.style.visibility = "hidden";
      node.hidden = false;
      const size = { w: node.offsetWidth, h: node.offsetHeight };
      const p = place(anchor, size, view(), below);
      node.style.top = p.top + "px";
      node.style.left = p.left + "px";
      node.style.visibility = "";
    }

    function rectOf(r) {
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }

    // ------------------------------------------------------------------ selection toolbar

    function buildToolbar() {
      const tb = el("div", { id: "carnet-sel-toolbar", class: "carnet-sel-toolbar", role: "toolbar", "aria-label": "Mise en forme de la sélection", "aria-orientation": "horizontal", hidden: true });
      for (const [kind, label, name] of SEL_ACTIONS) {
        const b = el("button", { type: "button", class: "carnet-sel-btn carnet-sel-" + kind, "data-carnet-sel": kind, "aria-label": name, title: name, text: label, tabindex: "-1" });
        if (kind !== "link" && kind !== "cite" && kind !== "clear") b.setAttribute("aria-pressed", "false");
        keepFocus(b);
        b.addEventListener("click", () => applySel(kind));
        tb.appendChild(b);
      }
      tb.addEventListener("keydown", (e) => {
        const list = Array.prototype.slice.call(tb.querySelectorAll("button"));
        const at = list.indexOf(doc.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeToolbar(true);
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          list[(at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length].focus({ preventScroll: true });
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          list[e.key === "Home" ? 0 : list.length - 1].focus({ preventScroll: true });
        }
      });
      host.root.appendChild(tb);
      S.tb = tb;
    }

    function selKey(sel) {
      return sel.start + ":" + sel.end;
    }

    /** Cheap gate first (no parsing): only a non-collapsed range inside the editor reaches the parser. */
    function rangeInEditor() {
      const gs = win.getSelection ? win.getSelection() : null;
      if (!gs || !gs.rangeCount || gs.isCollapsed) return null;
      const r = gs.getRangeAt(0);
      const ed = editor();
      return ed && ed.contains(r.startContainer) && ed.contains(r.endContainer) ? r : null;
    }

    function refreshToolbar() {
      S.raf = 0;
      if (!S.tb) return;
      const inside = S.tb.contains(doc.activeElement);
      const r = !S.composing && !(S.menuState && S.menuState.open) && !host.dragging() ? rangeInEditor() : null;
      const st = r ? stamp() : null;
      if (!r || !st) {
        if (!inside) hideToolbar();
        return;
      }
      const sel = host.sel();
      if (!sel || sel.start === sel.end) {
        if (!inside) hideToolbar();
        return;
      }
      if (S.tbDismissed === selKey(sel) + "@" + st.gen) return;
      S.tbStamp = Object.assign({ start: sel.start, end: sel.end }, st);
      for (const b of S.tb.querySelectorAll("[aria-pressed]")) b.setAttribute("aria-pressed", host.isOn(b.getAttribute("data-carnet-sel"), sel) ? "true" : "false");
      const rects = r.getClientRects();
      const below = !host.fine();
      const pick = rects.length ? (below ? rects[rects.length - 1] : rects[0]) : r.getBoundingClientRect();
      position(S.tb, rectOf(pick), below);
      S.tb.setAttribute("data-side", below ? "below" : "above");
    }

    function hideToolbar() {
      if (S.tb && !S.tb.hidden) S.tb.hidden = true;
      S.tbStamp = null;
    }

    function closeToolbar(refocus) {
      const t = S.tbStamp;
      hideToolbar();
      if (t) S.tbDismissed = t.start + ":" + t.end + "@" + t.gen;
      if (refocus) {
        host.focusEditor();
        if (t && sameStamp(stamp(), t)) host.setSel(t.start, t.end);
      }
    }

    function applySel(kind) {
      const t = S.tbStamp;
      const now = stamp();
      const live = host.sel();
      if (!t || !sameStamp(now, t) || !live || live.start !== t.start || live.end !== t.end) {
        hideToolbar();
        say(MSG.stale, true);
        return;
      }
      if (kind === "clear") host.clearFormat(t.start, t.end);
      else if (kind === "cite") host.cite();
      else host.format(kind);
      nextFrame(() => {
        S.raf = 0;
        refreshToolbar();
      });
    }

    function focusToolbar() {
      if (!S.tb || S.tb.hidden) return false;
      const first = S.tb.querySelector("button");
      if (first) first.focus({ preventScroll: true });
      return !!first;
    }

    function scheduleToolbar() {
      if (S.raf) return;
      S.raf = nextFrame(refreshToolbar);
    }

    // ------------------------------------------------------------------ command menu ("/" and between-block "+")

    function buildMenu() {
      const input = el("input", {
        type: "text", id: "carnet-cmd-input", class: "carnet-cmd-input", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false",
        "aria-controls": "carnet-cmd-list", "aria-label": "Rechercher une commande", placeholder: "Rechercher…", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "go",
      });
      const list = el("div", { id: "carnet-cmd-list", class: "carnet-cmd-list", role: "listbox", "aria-label": "Commandes" });
      const live = el("div", { class: "carnet-sr", role: "status", "aria-live": "polite" });
      // the footer lists only keys the menu really handles (↑↓ Enter Escape); hidden on touch devices
      const foot = el("div", { class: "carnet-cmd-footer", "aria-hidden": "true" }, [el("span", { text: "↑↓ naviguer" }), el("span", { text: "⏎ choisir" }), el("span", { text: "Échap fermer" })]);
      const box = el("div", { id: "carnet-cmd-menu", class: "carnet-cmd-menu", hidden: true }, [input, list, live, foot]);
      host.root.appendChild(box);
      const M = { box, input, list, live, open: false, items: [], active: 0, ctx: null, origin: "", closing: false };
      input.addEventListener("input", () => renderMenu(M));
      input.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return; // an IME confirming its text must never choose a command
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (M.items.length) moveActive(M, (M.active + (e.key === "ArrowDown" ? 1 : -1) + M.items.length) % M.items.length);
        } else if (e.key === "PageDown" || e.key === "PageUp") {
          // jump to the first command of the next group (PageDown) / the start of this group, then the previous one (PageUp)
          e.preventDefault();
          const opts = Array.prototype.slice.call(M.list.querySelectorAll(CMD_SEL));
          if (opts.length) {
            const groupOf = (i) => opts[i].getAttribute("data-carnet-group");
            const start = (i) => opts.findIndex((o) => o.getAttribute("data-carnet-group") === groupOf(i));
            let to;
            if (e.key === "PageDown") {
              to = opts.findIndex((o, i) => i > M.active && groupOf(i) !== groupOf(M.active));
              if (to < 0) to = opts.length - 1;
            } else {
              const s0 = start(M.active);
              to = s0 < M.active ? s0 : s0 > 0 ? start(s0 - 1) : 0;
            }
            moveActive(M, to);
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          const c = M.items[M.active];
          if (c) choose(M, c);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeMenu(M, "dismiss");
        } else if (e.key === "Tab") {
          e.preventDefault();
          closeMenu(M, "dismiss");
        }
      });
      list.addEventListener("mousedown", (e) => e.preventDefault());
      list.addEventListener("click", (e) => {
        const opt = e.target && e.target.closest ? e.target.closest(CMD_SEL) : null;
        if (!opt) return;
        const at = Array.prototype.indexOf.call(M.list.querySelectorAll(CMD_SEL), opt);
        const c = M.items[at];
        if (c) choose(M, c);
      });
      box.addEventListener("focusout", (e) => {
        if (M.open && !M.closing && !(e.relatedTarget && box.contains(e.relatedTarget))) nextFrame(() => {
          if (M.open && !M.closing && !box.contains(doc.activeElement)) closeMenu(M, "dismiss");
        });
      });
      return M;
    }

    function menuState() {
      return S.menuState || (S.menuState = buildMenu());
    }

    /** Deterministic suggestions for the insertion point (pure rules in HqCarnetNav.suggestFor; the host supplies them). */
    function suggestionsFor(M) {
      M.prevIndex = -1;
      if (!host.suggest || !M.ctx) return [];
      const lines = host.lines();
      const where = M.ctx.where || (M.origin === "slash" ? "slash" : "below");
      const at = where === "below" ? M.ctx.lineIndex : M.ctx.lineIndex - 1;
      const l = lines[at];
      if (!l) return [];
      let list = [];
      try {
        list = host.suggest({ type: l.type, assetId: l.asset && l.asset.id ? l.asset.id : "" }) || [];
      } catch (_) {
        list = [];
      }
      M.prevIndex = at;
      const out = [];
      for (const sgst of list) {
        if (sgst.action === "annotate") {
          if (host.annotate) out.push({ id: "annotate", label: sgst.label, hint: "Dessiner par-dessus l'image dans Dessiner", cat: "", _annotate: true });
        } else {
          const c = C.byId(sgst.id);
          if (c) out.push(c);
        }
      }
      return out;
    }

    function renderMenu(M) {
      const query = M.input.value;
      const groups = C.catalog({ query, recents: host.recents ? host.recents() : [] });
      // Phase 3.5: an ADDITIVE "Suggéré" group above the catalog (empty query only). It never removes / reorders commands, never
      // touches recents and never changes ranking: the catalog below is exactly what it was.
      const sugg = query ? [] : suggestionsFor(M);
      if (sugg.length) groups.unshift({ id: "suggest", label: "Suggéré", items: sugg });
      const items = C.flatten(groups); // the keyboard order (a command may appear in Récents AND in its category)
      M.items = items;
      M.active = Math.min(M.active, Math.max(0, items.length - 1));
      while (M.list.firstChild) M.list.removeChild(M.list.firstChild);
      let n = 0;
      for (const g of groups) {
        const gid = "carnet-cmd-g-" + g.id;
        const box = el("div", { class: "carnet-cmd-group", role: "group", "aria-labelledby": gid, "data-carnet-group": g.id }, [
          el("div", { id: gid, class: "carnet-cmd-group-label", text: g.label }),
        ]);
        for (const c of g.items) {
          // a command repeated under "Récents" carries data-carnet-cmd-recent so [data-carnet-cmd="id"] stays unique (the category row)
          const opt = el("div", { id: "carnet-cmd-" + n, class: "carnet-cmd-item", role: "option", [g.id === "recent" ? "data-carnet-cmd-recent" : g.id === "suggest" ? "data-carnet-cmd-suggest" : "data-carnet-cmd"]: c.id, "data-carnet-group": g.id, "aria-selected": n === M.active ? "true" : "false" });
          opt.appendChild(commandRow(doc, c, { category: g.id === "results" ? (C.category(c.cat) || {}).label : "" }));
          box.appendChild(opt);
          n += 1;
        }
        M.list.appendChild(box);
      }
      if (!items.length) M.list.appendChild(el("div", { class: "carnet-cmd-empty", text: "Aucune commande" }));
      M.input.setAttribute("aria-activedescendant", items.length ? "carnet-cmd-" + M.active : "");
      M.live.textContent = items.length ? items.length + (items.length > 1 ? " commandes" : " commande") : "Aucune commande";
    }

    function moveActive(M, i) {
      M.active = i;
      const opts = M.list.querySelectorAll(CMD_SEL);
      opts.forEach((o, k) => o.setAttribute("aria-selected", k === i ? "true" : "false"));
      const cur = opts[i];
      if (cur) {
        M.input.setAttribute("aria-activedescendant", cur.id);
        if (cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
      }
    }

    function openMenu(origin, ctx, anchor) {
      const M = menuState();
      if (M.open) closeMenu(M, "stale");
      M.origin = origin;
      M.ctx = ctx;
      M.open = true;
      M.closing = false;
      M.active = 0;
      M.input.value = "";
      hideToolbar();
      M.box.classList.toggle("is-sheet", !host.fine());
      renderMenu(M);
      M.input.setAttribute("aria-expanded", "true");
      if (host.fine()) position(M.box, anchor, true);
      else {
        M.box.style.top = "";
        M.box.style.left = "";
        M.box.hidden = false;
      }
      M.input.focus({ preventScroll: true });
    }

    /** Is the context the menu was opened for still the live one? (page, revision, generation, block, text.) */
    function ctxValid(ctx) {
      if (!ctx || !sameStamp(stamp(), ctx.stamp)) return false;
      const lines = host.lines();
      const l = lines[ctx.lineIndex];
      if (!l) return false;
      if (!sameId(ctx.blockId, l.id)) return false;
      return ctx.text == null || l.text === ctx.text;
    }

    /**
     * Close the menu. reason: "command" (the command consumed the slash), "dismiss" (ordinary dismissal: the swallowed "/"
     * is restored ONCE if the original context is still valid), "stale" (page switched / block changed: nothing is touched).
     */
    function closeMenu(M, reason) {
      if (!M || !M.open) return false;
      M.closing = true;
      const ctx = M.ctx;
      const origin = M.origin;
      M.open = false;
      M.box.hidden = true;
      M.input.setAttribute("aria-expanded", "false");
      M.input.value = "";
      M.ctx = null;
      if (reason === "dismiss" && origin === "slash") {
        if (ctxValid(ctx)) restoreSlash(ctx);
        else say(MSG.stale, true);
      } else if (reason === "dismiss") {
        host.focusEditor();
      }
      M.closing = false;
      return true;
    }

    function restoreSlash(ctx) {
      host.focusEditor();
      host.setSel(ctx.offset, ctx.offset);
      S.literal = true;
      try {
        host.insertText("/");
      } finally {
        S.literal = false;
      }
    }

    function choose(M, cmd) {
      const ctx = M.ctx;
      const origin = M.origin;
      M.closing = true;
      M.open = false;
      M.box.hidden = true;
      M.input.setAttribute("aria-expanded", "false");
      M.ctx = null;
      let ok = true;
      if (cmd._annotate) {
        // Annoter: the Phase-3 annotation path on the image just before the insertion point. No block is inserted here.
        const valid = origin === "slash" ? ctxValid(ctx) : blockValid(ctx);
        const idx = M.prevIndex;
        M.closing = false;
        if (!valid || idx < 0) {
          say(MSG.stale, true);
          return false;
        }
        host.focusEditor();
        host.annotate(idx);
        return true;
      }
      if (origin === "slash") {
        if (!ctxValid(ctx)) {
          say(MSG.stale, true);
          M.closing = false;
          return;
        }
        host.focusEditor();
        host.setSel(ctx.offset, ctx.offset); // the "/" never entered the document: only the command result does
        host.command(cmd.id);
      } else {
        // between-block "+": ONE new empty block after/before the anchor block, then the command runs inside it
        if (!blockValid(ctx)) {
          say(MSG.stale, true);
          M.closing = false;
          return;
        }
        ok = insertBlock(ctx, ctx.where || "below", true);
        if (ok && cmd.id !== "paragraph") host.command(cmd.id);
        else if (ok && host.noteRecent) host.noteRecent(cmd.id);
      }
      M.closing = false;
      return ok;
    }

    /** Called by the host from beforeinput for a typed "/". Returns true when the keystroke was taken (cancelled). */
    function slashKey(ev) {
      if (S.literal || S.composing || ev.isComposing) return false;
      const st = stamp();
      if (!st) return false;
      const sel = host.sel();
      if (!sel || sel.start !== sel.end) return false;
      const at = Rich.locate(sel.lines, sel.start);
      const line = sel.lines[at.line];
      if (!C.slashEligible(line, at.off, { composing: false })) return false;
      ev.preventDefault();
      const ctx = { stamp: st, lineIndex: at.line, blockId: line.id || null, text: line.text, offset: sel.start };
      const r = win.getSelection().rangeCount ? win.getSelection().getRangeAt(0).getBoundingClientRect() : null;
      const ed = editor().children[at.line];
      const base = r && (r.width || r.height) ? r : ed ? ed.getBoundingClientRect() : editor().getBoundingClientRect();
      openMenu("slash", ctx, rectOf(base));
      return true;
    }

    // ------------------------------------------------------------------ blocks: validity, ops

    function blockCtx(line, idx, where) {
      const lines = host.lines();
      const l = lines[idx];
      return { stamp: stamp(), lineIndex: idx, blockId: l ? l.id || null : null, text: null, where: where || "below", line };
    }

    function blockValid(ctx) {
      return !!ctx && ctxValid(Object.assign({}, ctx, { text: null }));
    }

    function commitBlocks(res, opts) {
      if (res.error) {
        say(res.error === "limit-blocks" ? MSG.limitBlocks : res.error === "limit-images" ? MSG.limitImages : res.error === "limit-struct" ? MSG.limitStruct : res.error === "limit-decisions" ? MSG.limitDecisions : res.error === "edge" ? MSG.edge : MSG.stale, true);
        return false;
      }
      const starts = Rich.lineStarts(res.lines);
      const o = opts || {};
      const into = Math.min(o.off || 0, res.lines[res.index] ? res.lines[res.index].text.length : 0);
      if (!host.commit(res.lines, o.noSel ? null : { start: starts[res.index] + into, end: starts[res.index] + into })) return false;
      if (o.focus) host.focusEditor();
      return true;
    }

    function insertBlock(ctx, where, focus) {
      const lines = host.lines();
      return commitBlocks(C.insertEmpty(Rich, lines, ctx.lineIndex, where), { focus: focus !== false });
    }

    function blockAct(ctx, id, arg, opts) {
      if (!blockValid(ctx)) {
        say(MSG.stale, true);
        return false;
      }
      const lines = host.lines();
      const i = ctx.lineIndex;
      switch (id) {
        case "up":
        case "down": {
          const ok = commitBlocks(C.move(Rich, lines, i, id === "up" ? -1 : 1), opts && opts.caret ? { off: opts.off, focus: true } : { noSel: true });
          if (ok) say(id === "up" ? "Bloc déplacé vers le haut" : "Bloc déplacé vers le bas");
          return ok;
        }
        case "dup": {
          const ok = commitBlocks(C.duplicate(Rich, lines, i), { noSel: true });
          if (ok) say("Bloc dupliqué");
          return ok;
        }
        case "above":
          return insertBlock(ctx, "above", true);
        case "delete": {
          const ok = commitBlocks(C.remove(Rich, lines, i), { noSel: true });
          if (ok) say("Bloc supprimé");
          return ok;
        }
        case "convert": {
          const ok = commitBlocks(C.convert(Rich, lines, i, arg), { noSel: true });
          return ok;
        }
        default:
          return false;
      }
    }

    // ------------------------------------------------------------------ block rail (drag handle, "+", "⋯") and gap "+"

    function buildRail() {
      const drag = el("button", { type: "button", class: "carnet-rail-btn carnet-rail-drag", "data-carnet-rail": "drag", "aria-label": "Déplacer le bloc (glisser, ou Alt+Maj+flèches)", title: "Glisser pour déplacer", tabindex: "-1" }, [
        el("span", { "aria-hidden": "true", text: "⠿" }),
      ]);
      const plus = el("button", { type: "button", class: "carnet-rail-btn carnet-rail-plus", "data-carnet-rail": "plus", "aria-label": "Insérer un bloc en dessous", title: "Insérer en dessous", tabindex: "-1" }, [
        el("span", { "aria-hidden": "true", text: "+" }),
      ]);
      const more = el("button", { type: "button", class: "carnet-rail-btn carnet-rail-more", "data-carnet-rail": "more", "aria-label": "Actions du bloc", title: "Actions du bloc", "aria-haspopup": "menu", "aria-expanded": "false", tabindex: "-1" }, [
        el("span", { "aria-hidden": "true", text: "⋯" }),
      ]);
      const rail = el("div", { id: "carnet-block-rail", class: "carnet-block-rail", role: "group", "aria-label": "Bloc", hidden: true }, [drag, plus, more]);
      host.root.appendChild(rail);
      const gap = el("button", { type: "button", id: "carnet-gap-plus", class: "carnet-gap-plus", "aria-label": "Insérer un bloc ici", title: "Insérer ici", tabindex: "-1", hidden: true }, [el("span", { "aria-hidden": "true", text: "+" })]);
      host.root.appendChild(gap);
      const R = { rail, drag, plus, more, gap, line: null, ctx: null, gapAfter: -1 };
      S.rail = R;
      for (const b of [drag, plus, more, gap]) keepFocus(b);
      plus.addEventListener("click", () => {
        const c = railCtx();
        if (c) openMenu("gap", Object.assign(c, { where: "below" }), rectOf(plus.getBoundingClientRect()));
      });
      gap.addEventListener("click", () => {
        if (R.gapAfter < 0) return;
        const c = blockCtx(null, R.gapAfter, "below");
        openMenu("gap", c, rectOf(gap.getBoundingClientRect()));
      });
      more.addEventListener("click", () => openBlockMenu(more));
      more.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openBlockMenu(more);
        }
      });
      drag.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const c = railCtx();
        if (c) blockAct(c, e.key === "ArrowUp" ? "up" : "down");
      });
      if (host.bindMove) host.bindMove(drag, () => (R.line && editor().contains(R.line) ? R.line : null));
      rail.addEventListener("pointerenter", () => clearHide());
      rail.addEventListener("pointerleave", scheduleHide);
      gap.addEventListener("pointerenter", () => clearHide());
      gap.addEventListener("pointerleave", scheduleHide);
      return R;
    }

    function railState() {
      return S.rail || buildRail();
    }

    function railCtx() {
      const R = S.rail;
      if (!R || !R.line || !editor().contains(R.line)) return null;
      const idx = Array.prototype.indexOf.call(editor().children, R.line);
      return idx < 0 ? null : blockCtx(R.line, idx);
    }

    function childOf(node) {
      const ed = editor();
      let n = node && node.nodeType === 3 ? node.parentNode : node;
      while (n && n.parentNode !== ed) n = n.parentNode;
      return n && n.parentNode === ed && n.hasAttribute && n.hasAttribute("data-line-type") ? n : null;
    }

    function clearHide() {
      if (S.hideTimer) win.clearTimeout(S.hideTimer);
      S.hideTimer = 0;
    }

    function scheduleHide() {
      clearHide();
      S.hideTimer = win.setTimeout(() => {
        S.hideTimer = 0;
        if (S.blockMenu && S.blockMenu.open) return;
        hideRail();
      }, 280);
    }

    function hideRail() {
      const R = S.rail;
      if (!R) return;
      if (R.rail.contains(doc.activeElement)) return;
      R.rail.hidden = true;
      R.gap.hidden = true;
      R.line = null;
    }

    function showRail(line) {
      if (!line || !stamp()) return;
      const R = railState();
      R.line = line;
      const rect = line.getBoundingClientRect();
      const er = editor().getBoundingClientRect();
      const v = view();
      if (rect.bottom < 0 || rect.top > v.h) {
        R.rail.hidden = true;
        return;
      }
      R.rail.hidden = false;
      R.rail.classList.toggle("is-touch", !host.fine());
      R.drag.hidden = !host.fine(); // coarse pointers reorder with the block menu: 44px targets do not fit three across
      const w = R.rail.offsetWidth;
      const h = R.rail.offsetHeight;
      if (host.fine()) {
        // a vertical stack that lives in the paper's left margin gutter (never over the library dock, never over text)
        const min = er.top + 2;
        R.rail.style.left = Math.round(er.left + 3) + "px";
        R.rail.style.top = Math.round(Math.max(min, Math.min(rect.top + Math.min(rect.height, 30) / 2 - h / 2, er.bottom - h - 2, v.h - h - 4))) + "px";
      } else {
        R.rail.style.left = Math.max(8, Math.round(Math.min(v.w - w - 8, er.right - w - 8))) + "px";
        R.rail.style.top = Math.max(8, Math.min(Math.round(rect.bottom + 4), v.h - h - 8)) + "px";
      }
    }

    function showGap(afterIdx, y) {
      const R = railState();
      const er = editor().getBoundingClientRect();
      R.gapAfter = afterIdx;
      R.rail.hidden = true; // the margin gutter hosts one control at a time: the seam's "+" wins while the pointer is on the seam
      R.gap.hidden = false;
      R.gap.style.left = Math.round(er.left + 10) + "px";
      R.gap.style.top = Math.round(y - R.gap.offsetHeight / 2) + "px";
    }

    function onPointerMove(ev) {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      if (!host.fine() || !stamp() || host.dragging()) return;
      clearHide();
      const line = childOf(ev.target);
      const ed = editor();
      if (line) showRail(line);
      // boundary "+": pointer within 7px of the seam between two blocks, in the left gutter
      const er = ed.getBoundingClientRect();
      let seam = -1;
      let seamY = 0;
      if (ev.clientX - er.left < 64) {
        const kids = ed.children;
        for (let i = 0; i < kids.length; i += 1) {
          const k = kids[i];
          if (!k.hasAttribute || !k.hasAttribute("data-line-type")) continue;
          const b = k.getBoundingClientRect().bottom;
          if (Math.abs(ev.clientY - b) <= 7) {
            seam = i;
            seamY = b;
            break;
          }
        }
      }
      const R = railState();
      if (seam >= 0) showGap(seam, seamY);
      else if (!R.gap.hidden && !R.gap.matches(":hover")) R.gap.hidden = true;
    }

    function onCaretBlock() {
      if (host.fine() || !stamp()) return;
      const gs = win.getSelection ? win.getSelection() : null;
      if (!gs || !gs.rangeCount) return;
      const line = childOf(gs.getRangeAt(0).startContainer);
      if (line && editor().contains(line)) showRail(line);
      else hideRail();
    }

    // ---- block menu ("⋯", Alt+Shift+B)

    function buildBlockMenu() {
      const menu = el("div", { id: "carnet-block-menu", class: "carnet-block-menu", role: "menu", "aria-label": "Actions du bloc", hidden: true });
      host.root.appendChild(menu);
      const B = { menu, open: false, ctx: null, opener: null, armed: false };
      menu.addEventListener("keydown", (e) => {
        const list = Array.prototype.slice.call(menu.querySelectorAll("[role=menuitem]"));
        const at = list.indexOf(doc.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeBlockMenu(true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus({ preventScroll: true });
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          list[e.key === "Home" ? 0 : list.length - 1].focus({ preventScroll: true });
        } else if (e.key === "Tab") closeBlockMenu(false);
      });
      menu.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-carnet-block]") : null;
        if (!b || b.disabled) return;
        runBlockItem(B, b);
      });
      S.blockMenu = B;
      return B;
    }

    function blockItems(ctx) {
      const lines = host.lines();
      const l = lines[ctx.lineIndex];
      const items = [
        ["up", "Monter", ctx.lineIndex === 0],
        ["down", "Descendre", ctx.lineIndex >= lines.length - 1],
        ["dup", "Dupliquer", false],
        ["above", "Insérer au-dessus", false],
        ["below", "Insérer en dessous", false],
      ];
      if (l && C.isTextType(l.type)) {
        for (const id of C.TEXT_TYPES) {
          const cmd = C.byId(id);
          items.push(["convert:" + id, "Convertir : " + cmd.label, l.type === id]);
        }
      }
      // Phase 3.5: a block deep link needs a real (saved) block id; an unsaved block has none yet
      if (host.copyBlockLink) items.push(["link", "Copier le lien vers ce bloc", !(l && typeof l.id === "string" && /^block-/.test(l.id))]);
      items.push(["delete", "Supprimer", false]);
      return items;
    }

    function openBlockMenu(opener, ctxIn) {
      const ctx = ctxIn || railCtx();
      if (!ctx) return;
      const B = S.blockMenu || buildBlockMenu();
      if (B.open) closeBlockMenu(false);
      B.ctx = ctx;
      B.opener = opener || null;
      B.armed = false;
      while (B.menu.firstChild) B.menu.removeChild(B.menu.firstChild);
      for (const [id, label, disabled] of blockItems(ctx)) {
        const b = el("button", { type: "button", role: "menuitem", class: "carnet-block-item" + (id === "delete" ? " is-danger" : ""), "data-carnet-block": id, tabindex: "-1", text: label, disabled: !!disabled });
        keepFocus(b);
        B.menu.appendChild(b);
      }
      B.open = true;
      if (opener) opener.setAttribute("aria-expanded", "true");
      B.menu.classList.toggle("is-sheet", !host.fine());
      const anchor = opener ? rectOf(opener.getBoundingClientRect()) : rectOf((editor().children[ctx.lineIndex] || editor()).getBoundingClientRect());
      if (host.fine()) position(B.menu, anchor, true);
      else B.menu.hidden = false;
      const first = B.menu.querySelector("[role=menuitem]:not(:disabled)");
      if (first) first.focus({ preventScroll: true });
    }

    function closeBlockMenu(refocus) {
      const B = S.blockMenu;
      if (!B || !B.open) return;
      B.open = false;
      B.menu.hidden = true;
      B.armed = false;
      if (B.opener) B.opener.setAttribute("aria-expanded", "false");
      const opener = B.opener;
      B.ctx = null;
      if (refocus) {
        if (opener && opener.isConnected && !opener.closest("[hidden]")) opener.focus({ preventScroll: true });
        else host.focusEditor();
      }
    }

    function runBlockItem(B, btn) {
      const id = btn.getAttribute("data-carnet-block");
      const ctx = B.ctx;
      if (id === "delete") {
        const lines = host.lines();
        const l = lines[ctx.lineIndex];
        const empty = l && C.isTextType(l.type) && !l.text;
        if (!empty && !B.armed) {
          B.armed = true; // no editor-level Undo yet: a non-empty block needs a second, explicit confirmation
          btn.textContent = "Confirmer la suppression";
          btn.setAttribute("data-armed", "true");
          return;
        }
      }
      closeBlockMenu(false);
      if (id === "below") {
        if (blockValid(ctx)) openMenu("gap", Object.assign({}, ctx, { where: "below" }), rectOf((editor().children[ctx.lineIndex] || editor()).getBoundingClientRect()));
        else say(MSG.stale, true);
        return;
      }
      if (id === "link") {
        if (blockValid(ctx) && host.copyBlockLink) host.copyBlockLink(ctx.lineIndex);
        else say(MSG.stale, true);
        return;
      }
      if (id.indexOf("convert:") === 0) blockAct(ctx, "convert", id.slice(8));
      else blockAct(ctx, id);
      if (id === "up" || id === "down") {
        host.focusRailSoon && host.focusRailSoon();
      }
    }

    // ------------------------------------------------------------------ block drag (host side supplies token / validity / commit)

    function dragHost() {
      return {
        doc, editor: () => editor(), status: (t, e) => say(t, e),
        raf: (fn) => win.requestAnimationFrame(fn), cancelRaf: (id) => win.cancelAnimationFrame(id),
        token(lineEl) {
          const st = stamp();
          const idx = Array.prototype.indexOf.call(editor().children, lineEl);
          if (!st || idx < 0) return null;
          const l = host.lines()[idx];
          return l ? { stamp: st, lineEl, blockId: l.id || null, index: idx } : null;
        },
        valid(t) {
          if (!t || !sameStamp(stamp(), t.stamp) || !editor().contains(t.lineEl)) return false;
          const idx = Array.prototype.indexOf.call(editor().children, t.lineEl);
          const l = host.lines()[idx];
          return idx === t.index && !!l && sameId(t.blockId, l.id);
        },
        commitMove(t, to) {
          if (!this.valid(t)) {
            say(MSG.stale, true);
            return false;
          }
          const ok = commitBlocks(C.moveTo(Rich, host.lines(), t.index, to), { noSel: true });
          if (ok) say("Bloc déplacé : position " + (to + 1));
          return ok;
        },
        nudge() {},
        commitWidth() {},
        widthOf: () => 100,
        layoutOf: () => "inline",
      };
    }

    // ------------------------------------------------------------------ editor keyboard / lifecycle

    /** Editor keydown. Returns true when handled. */
    function onKeydown(ev) {
      if (ev.isComposing || ev.keyCode === 229) return false;
      if (ev.altKey && ev.key === "F10") {
        if (focusToolbar()) {
          ev.preventDefault();
          return true;
        }
        return false;
      }
      if (ev.altKey && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          const c = caretCtx();
          if (!c) return false;
          ev.preventDefault();
          const cur = host.sel();
          const off = cur ? cur.start - Rich.lineStarts(cur.lines)[Rich.locate(cur.lines, cur.start).line] : 0;
          blockAct(c, ev.key === "ArrowUp" ? "up" : "down", null, { caret: true, off });
          return true;
        }
        if (ev.key === "B" || ev.key === "b") {
          const c = caretCtx();
          if (!c) return false;
          ev.preventDefault();
          openBlockMenu(null, c);
          return true;
        }
      }
      if (ev.key === "Escape" && S.tb && !S.tb.hidden) {
        ev.preventDefault();
        closeToolbar(false);
        return true;
      }
      return false;
    }

    function caretCtx() {
      if (!stamp()) return null;
      const gs = win.getSelection ? win.getSelection() : null;
      if (!gs || !gs.rangeCount) return null;
      const line = childOf(gs.getRangeAt(0).startContainer);
      if (!line) return null;
      return blockCtx(line, Array.prototype.indexOf.call(editor().children, line));
    }

    /** Page switch / re-render from outside: transient UIs close WITHOUT touching the document. */
    function invalidate() {
      if (S.menuState && S.menuState.open) closeMenu(S.menuState, "stale");
      closeBlockMenu(false);
      hideToolbar();
      const R = S.rail;
      if (R) {
        R.rail.hidden = true;
        R.gap.hidden = true;
        R.line = null;
      }
    }

    const ed0 = editor();
    buildToolbar();
    // No document/window listener is registered here: the host owns the ONE global listener per event type and forwards
    // to onSelectionChange / onViewport / onPointerDown (so a re-mount can never accumulate listeners).
    function onSelectionChange() {
      scheduleToolbar();
      if (!host.fine()) onCaretBlock();
    }
    function onViewport() {
      if (S.rail && S.rail.line && !S.rail.rail.hidden) showRail(S.rail.line);
      if (S.tb && !S.tb.hidden) scheduleToolbar();
    }
    // Only a WIDTH change (rotation, window resize) invalidates: a height-only resize is the on-screen keyboard appearing,
    // which must never close the menu the user is typing in.
    S.lastW = win.innerWidth;
    function onResize() {
      const w = win.innerWidth;
      if (w === S.lastW) return;
      S.lastW = w;
      invalidate();
    }
    function onPointerDown(e) {
      const M = S.menuState;
      if (M && M.open && !M.box.contains(e.target)) closeMenu(M, "dismiss");
      const B = S.blockMenu;
      if (B && B.open && !B.menu.contains(e.target) && !(B.opener && B.opener.contains(e.target))) closeBlockMenu(false);
    }
    ed0.addEventListener("compositionstart", () => {
      S.composing = true;
      hideToolbar();
    });
    ed0.addEventListener("compositionend", () => {
      S.composing = false;
      scheduleToolbar();
    });
    ed0.addEventListener("pointermove", onPointerMove);
    ed0.addEventListener("pointerleave", scheduleHide);

    return {
      slashKey, onKeydown, invalidate, dragHost, onSelectionChange, onViewport, onResize, onPointerDown, closeMenus: () => invalidate(),
      toolbar: () => S.tb, menu: () => (S.menuState ? S.menuState.box : null), rail: () => (S.rail ? S.rail.rail : null),
      openBlockMenuForCaret: () => openBlockMenu(null, caretCtx()),
      refresh: scheduleToolbar,
    };
  }

  return { mount, place, commandRow, SEL_ACTIONS, MSG };
});
