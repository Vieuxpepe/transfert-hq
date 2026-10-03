/* Transfert HQ — Carnet Stage 08: history, bulk operations, report assembly and "Liée depuis…" (collapsed, contextual).
 *
 * NOTHING here is visible on the default paper. One modal dialog (#hq-carnet-hx) is created lazily the first time it is
 * opened: from the editor's collapsed tools tray ("Historique") or from the library header ("Opérations"). A user who
 * only writes notes never meets any of it, and this file is not even requested until a first page has been shown.
 *
 * The server is the only authority: every operation is a plain call to the existing /api/carnet endpoint (scope ->
 * affected count -> preview -> explicit confirm -> revision-aware apply -> Undo). This file holds NO second notebook
 * state: after a server-side change it asks the host to refresh the authoritative copy (never overwriting dirty text).
 * A page with unsaved local text is never touched: it is listed as "Brouillon local — ignorée" and reported to the server
 * as client_skipped so the result lists it honestly.
 *
 * Nothing is stored in the browser (no localStorage / sessionStorage / IndexedDB). DOM is built with createElement /
 * textContent only. No HTML string injection, no dynamic code evaluation. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetHistoryUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const Rich = node ? require("./hq-carnet-rich.js") : global.HqCarnetRich;

  const TARGETS_MAX = 64;
  const ITEMS_MAX = 200;

  const MSG = {
    title: "Historique et opérations",
    busy: "Enregistrement en cours — réessaie dans un instant.",
    nopage: "Aucune page ouverte.",
    histDown: "Historique indisponible — aucune opération d'historique n'est possible (les notes restent modifiables).",
    checkpointDone: "Point de restauration enregistré.",
    checkpointDup: "Identique au dernier point : rien de nouveau enregistré.",
    restoreDone: "Version restaurée (nouvelle révision). Rien n'a été supprimé de l'historique.",
    restoreStale: "La page a changé — rien n'a été restauré. Recharge puis réessaie.",
    confirmRestore: "Confirmer la restauration",
    noEvents: "Aucun événement pour cette page. Un point de restauration n'est créé que sur demande.",
    noBulk: "Aucune opération groupée récente.",
    needScope: "Sélectionne au moins une page.",
    previewFirst: "Lance l'aperçu avant d'appliquer.",
    stalePreview: "Le contenu a changé depuis l'aperçu — relance l'aperçu.",
    planGone: "L'aperçu a expiré ou ne correspond plus — relance l'aperçu avant d'appliquer.",
    ackCal: "Je confirme : le calage de cette édition sera effacé (aucun recalage automatique).",
    draft: "Brouillon local — ignorée",
    undone: "Annulé",
    reportEmpty: "Ajoute au moins un élément au rapport.",
    reportStale: "Une page a changé depuis la sélection — rien n'a été généré. Reconstruis le rapport.",
    reportNote: "Le rapport assemble tes notes dans l'ordre choisi. Rien n'est rédigé ni résumé à ta place.",
    backNone: "Aucune note ne renvoie ici.",
    printNote: "Les images sont jointes à l'export (.md + dossier .assets).",
  };

  const OPS = [
    ["replace", "Remplacer du texte dans plusieurs pages"],
    ["context_move", "Déplacer vers un projet / une catégorie"],
    ["trash", "Mettre à la corbeille / restaurer"],
    ["source_migrate", "Migrer les citations vers une autre édition"],
    ["file_replace", "Remplacer le fichier lié d'une édition"],
  ];

  const STATUS_LABEL = { applied: "Appliqué", skipped: "Ignoré", conflicted: "En conflit", failed: "Échec", will_apply: "Sera appliqué" };
  const OUTCOME_LABEL = { complete: "Terminé", partial: "Partiel — vérifie le détail ci-dessous", none: "Rien n'a été appliqué" };
  const KIND_LABEL = { checkpoint: "Point de restauration", restore: "Restauration", bulk: "Opération groupée", undo: "Annulation", lifecycle: "Corbeille / page" };
  const LIFE_LABEL = { trash: "mise à la corbeille", restore: "restaurée de la corbeille", delete: "supprimée définitivement" };

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "text") n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (kids) for (const c of kids) if (c) n.appendChild(c);
    return n;
  }

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function errText(err) {
    const d = err && isObj(err.data) ? err.data : {};
    return String(d.error || (err && err.message) || "Erreur").slice(0, 200);
  }

  function errCode(err) {
    const d = err && isObj(err.data) ? err.data : {};
    return typeof d.code === "string" ? d.code : "";
  }

  function when(sec) {
    const d = new Date(Number(sec) * 1000);
    if (!isFinite(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function requestId() {
    const bytes = new Uint8Array(9);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return "rq-" + Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- local-draft privacy audit (pure)

  const ABS_PATH = /(?:^|[\s"'(=:])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|\/(?:home|Users|root|etc|var|tmp|mnt|opt)\/)/;
  const SECRETISH = /(?:csrf|bearer\s+[A-Za-z0-9._-]{8,}|set-cookie|session[_-]?(?:id|token)|api[_-]?key|authorization|\bpin\b\s*[:=]|password|secret)/i;

  /**
   * Looks at what Carnet keeps in browser storage and reports COUNTS only (never the content). Keys other than the
   * namespaced draft store are reported; a stored value that looks like a token / absolute path is flagged.
   * `storage` is a Storage-like object; any failure is reported as unreadable, never thrown.
   */
  function auditStorage(storage, draftPrefix) {
    const out = { readable: true, keys: [], drafts: 0, bytes: 0, flagged: [], foreign: [] };
    try {
      const n = storage.length;
      for (let i = 0; i < n; i++) {
        const key = storage.key(i);
        if (typeof key !== "string") continue;
        const own = key.indexOf(draftPrefix) === 0;
        if (!own && !/^hq[_-]?carnet/i.test(key)) continue;
        const raw = storage.getItem(key) || "";
        out.keys.push(key.length > 60 ? key.slice(0, 60) : key);
        out.bytes += raw.length;
        if (own) {
          try {
            const v = JSON.parse(raw);
            out.drafts += isObj(v) && isObj(v.pages) ? Object.keys(v.pages).length : 0;
          } catch (_) {
            out.flagged.push({ key: "(draft store)", why: "illisible" });
          }
        } else out.foreign.push(key.slice(0, 60));
        if (SECRETISH.test(raw)) out.flagged.push({ key: own ? "(draft store)" : key.slice(0, 60), why: "jeton ou secret apparent" });
        if (ABS_PATH.test(raw)) out.flagged.push({ key: own ? "(draft store)" : key.slice(0, 60), why: "chemin absolu apparent" });
      }
    } catch (_) {
      out.readable = false;
    }
    return out;
  }

  // ---------------------------------------------------------------- mount

  /**
   * host = {
   *   doc, root, api:{get,post}, flash(msg),
   *   current(): {id, rev, dirty, trashed} | null,       // the open page (rev = last known SERVER revision)
   *   scope(): {label, items:[{id,title,dirty,deleted}]}, // the library's current list (active pages only are used)
   *   projects(), categories(),                            // [{id,name}]
   *   blocks(): [{id,type,label}] of the open page (measure/decision/image blocks),
   *   refresh(): Promise,                                  // adopt the authoritative server copy
   *   openNote(id): bool, roots: [..], storage(), draftPrefix, onClose(refocus)
   * }
   */
  function mount(host) {
    const doc = host.doc;
    const state = { open: false, tab: "history", opener: null, status: null, history: null, bulk: freshBulk(), report: freshReport(), back: { kind: "note", id: "" }, busy: false };
    let dlg = null;
    let body = null;
    let live = null;

    function freshBulk() {
      return { op: "replace", params: {}, picked: new Set(), preview: null, result: null, ack: false, events: null };
    }

    function freshReport() {
      return { items: [], title: "", result: null, includeSources: true };
    }

    function say(text) {
      if (live) live.textContent = text || "";
    }

    // ------------------------------------------------------------ shell

    function build() {
      live = el(doc, "p", { id: "hq-carnet-hx-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      const tabs = el(doc, "div", { class: "carnet-hx-tabs", role: "group", "aria-label": "Sections" });
      for (const [key, label] of [["history", "Historique"], ["bulk", "Opérations groupées"], ["report", "Rapport"], ["back", "Liée depuis…"]]) {
        tabs.appendChild(el(doc, "button", { type: "button", class: "carnet-chip carnet-hx-tab", "data-hx-tab": key, "aria-pressed": "false", text: label }));
      }
      body = el(doc, "div", { class: "carnet-hx-body" });
      const close = el(doc, "button", { type: "button", id: "btn-carnet-hx-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-hx-title", text: MSG.title }), close]);
      dlg = el(doc, "div", { id: "hq-carnet-hx", class: "carnet-hx", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-hx-title", hidden: "" }, [head, tabs, live, body]);
      dlg.hidden = true;
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("change", onChange);
      dlg.addEventListener("input", onInput);
      dlg.addEventListener("keydown", onKey);
      host.root.appendChild(dlg);
    }

    function focusables() {
      return Array.prototype.filter.call(dlg.querySelectorAll("button, input, select, textarea, summary, [tabindex]"), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
    }

    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        close(true);
        return;
      }
      if (ev.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (ev.shiftKey && (doc.activeElement === first || !dlg.contains(doc.activeElement))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (doc.activeElement === last || !dlg.contains(doc.activeElement))) {
        ev.preventDefault();
        first.focus();
      }
    }

    function open(tab, opener) {
      if (!dlg) build();
      state.opener = opener || doc.activeElement || null;
      state.open = true;
      state.status = null;
      state.bulk = freshBulk();
      dlg.hidden = false;
      setTab(tab || "history");
      const x = dlg.querySelector("#btn-carnet-hx-close");
      const f = focusables();
      (f.find((n) => n !== x) || x).focus({ preventScroll: true });
    }

    function close(refocus) {
      if (!dlg || !state.open) return;
      state.open = false;
      dlg.hidden = true;
      say("");
      const o = state.opener;
      state.opener = null;
      if (refocus && o && typeof o.focus === "function" && doc.contains(o)) o.focus({ preventScroll: true });
      if (typeof host.onClose === "function") host.onClose(!!refocus);
    }

    function setTab(tab) {
      state.tab = tab;
      for (const b of dlg.querySelectorAll("[data-hx-tab]")) b.setAttribute("aria-pressed", b.getAttribute("data-hx-tab") === tab ? "true" : "false");
      render();
    }

    function captureInputs() {
      if (state.tab === "bulk") readParams();
      const lab = dlg.querySelector("#hq-carnet-hx-label");
      if (lab) state.label = lab.value;
      const t = dlg.querySelector("#hq-carnet-hx-rtitle");
      if (t) state.report.title = t.value;
      const rs = dlg.querySelector("#hq-carnet-hx-rsrc");
      if (rs) state.report.includeSources = rs.checked;
    }

    function render() {
      const keepId = doc.activeElement && dlg.contains(doc.activeElement) && doc.activeElement.id ? doc.activeElement.id : "";
      captureInputs(); // an asynchronous re-render never loses what was typed or chosen
      body.textContent = "";
      if (state.tab === "history") renderHistory();
      else if (state.tab === "bulk") renderBulk();
      else if (state.tab === "report") renderReport();
      else renderBack();
      // A re-render removes the control that had focus: keep focus inside the modal (Escape / Tab keep working).
      const again = keepId ? dlg.querySelector("#" + keepId) : null;
      if (again && !dlg.contains(doc.activeElement)) again.focus({ preventScroll: true });
      if (state.open && !dlg.contains(doc.activeElement)) dlg.focus({ preventScroll: true });
    }

    function section(title, kids) {
      return el(doc, "section", { class: "carnet-panel carnet-hx-sec" }, [el(doc, "h4", { text: title })].concat(kids));
    }

    function btn(text, attrs) {
      return el(doc, "button", Object.assign({ type: "button", class: "carnet-small carnet-hx-btn", text }, attrs || {}));
    }

    function field(label, input) {
      return el(doc, "label", { class: "carnet-hx-field" }, [el(doc, "span", { text: label }), input]);
    }

    function input(id, attrs) {
      return el(doc, "input", Object.assign({ type: "text", id, class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }, attrs || {}));
    }

    async function call(fn) {
      if (state.busy) return null;
      state.busy = true;
      try {
        return await fn();
      } finally {
        state.busy = false;
      }
    }

    // ------------------------------------------------------------ history

    async function loadHistory() {
      const cur = host.current();
      if (!cur) {
        state.history = { events: [], error: MSG.nopage };
        return;
      }
      try {
        const out = await host.api.get("/api/carnet?history=1&page=" + encodeURIComponent(cur.id));
        state.history = { events: Array.isArray(out.events) ? out.events : [], pruned: out.pruned_total || 0 };
      } catch (err) {
        state.history = { events: [], error: errCode(err) === "history_unavailable" ? MSG.histDown : errText(err) };
      }
    }

    function renderHistory() {
      const cur = host.current();
      body.appendChild(el(doc, "p", { class: "hint", text: "Un point de restauration est créé uniquement sur demande (jamais à chaque frappe). Les opérations groupées et restaurations s'y ajoutent." }));
      if (!cur) {
        body.appendChild(el(doc, "p", { class: "hint", text: MSG.nopage }));
        return;
      }
      const label = input("hq-carnet-hx-label", { maxlength: "80", "aria-label": "Nom du point de restauration (facultatif)", placeholder: "Nom (facultatif)", value: state.label || "" });
      body.appendChild(section("Point de restauration", [
        el(doc, "div", { class: "carnet-panel-row" }, [label, btn("Enregistrer un point", { "data-hx": "checkpoint" })]),
      ]));
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Événements de la page" });
      const box = section("Événements de cette page", [list]);
      body.appendChild(box);
      body.appendChild(auditSection());
      if (!state.history) {
        list.appendChild(el(doc, "li", { class: "hint", text: "Chargement…" }));
        loadHistory().then(() => {
          if (state.open && state.tab === "history") render();
        });
        return;
      }
      if (state.history.error) {
        list.appendChild(el(doc, "li", { class: "carnet-msg", role: "alert", text: state.history.error }));
        return;
      }
      if (!state.history.events.length) list.appendChild(el(doc, "li", { class: "hint", text: MSG.noEvents }));
      for (const ev of state.history.events) list.appendChild(eventRow(ev, cur));
    }

    function eventRow(ev, cur) {
      const li = el(doc, "li", { class: "carnet-hx-event", "data-hx-event": ev.id });
      let line = (KIND_LABEL[ev.kind] || ev.kind) + " · " + when(ev.at);
      if (ev.kind === "checkpoint" && ev.label) line += " · " + ev.label;
      if (ev.kind === "lifecycle") line += " · " + (LIFE_LABEL[ev.action] || ev.action);
      if (ev.status && ev.status !== "applied") line += " · " + (ev.status === "pending" ? "interrompu" : "échec");
      li.appendChild(el(doc, "span", { class: "carnet-hx-event-text", text: line }));
      if (ev.summary && ev.kind !== "lifecycle") li.appendChild(el(doc, "span", { class: "hint", text: ev.summary }));
      if ((ev.kind === "checkpoint" || ev.kind === "restore") && ev.status === "applied" && !cur.trashed) {
        const confirming = state.confirmRestore === ev.id;
        li.appendChild(btn(confirming ? MSG.confirmRestore : (ev.kind === "restore" ? "Revenir avant cette restauration" : "Restaurer"), { "data-hx": confirming ? "restore-confirm" : "restore", "data-id": ev.id, "aria-label": (confirming ? MSG.confirmRestore : "Restaurer") + " — " + when(ev.at) }));
      }
      return li;
    }

    function auditSection() {
      const out = state.audit;
      const kids = [btn("Vérifier les brouillons locaux", { "data-hx": "audit" })];
      if (out) {
        let text;
        if (!out.readable) text = "Stockage local illisible.";
        else {
          text = out.drafts + " brouillon(s) en attente dans ce navigateur (" + out.bytes + " octets).";
          text += out.flagged.length ? " ⚠ À vérifier : " + out.flagged.map((f) => f.why).join(", ") + "." : " Aucun jeton ni chemin absolu détecté.";
        }
        kids.push(el(doc, "p", { class: "hint", role: "status", id: "hq-carnet-hx-audit", text }));
      }
      return section("Confidentialité locale", kids);
    }

    async function checkpoint() {
      const cur = host.current();
      if (!cur) return;
      if (cur.dirty) return say(MSG.busy);
      const lab = dlg.querySelector("#hq-carnet-hx-label");
      const payload = { action: "history_checkpoint", page_id: cur.id, expected_rev: cur.rev };
      if (lab && lab.value.trim()) payload.label = lab.value.trim();
      await call(async () => {
        try {
          const out = await host.api.post(payload);
          say(out.duplicate ? MSG.checkpointDup : MSG.checkpointDone);
          state.label = "";
          state.history = null;
        } catch (err) {
          say(errCode(err) === "revision_conflict" ? MSG.restoreStale : errCode(err) === "history_unavailable" ? MSG.histDown : errText(err));
          await refreshSafe();
        }
      });
      if (state.open) render();
    }

    async function restore(id) {
      const cur = host.current();
      if (!cur) return;
      if (cur.dirty) return say(MSG.busy);
      if (state.confirmRestore !== id) {
        state.confirmRestore = id;
        render();
        const b = dlg.querySelector('[data-hx="restore-confirm"]');
        if (b) b.focus({ preventScroll: true });
        return;
      }
      state.confirmRestore = null;
      await call(async () => {
        try {
          await host.api.post({ action: "history_restore", page_id: cur.id, event_id: id, expected_rev: cur.rev, confirm: true });
          say(MSG.restoreDone);
          state.history = null;
          await refreshSafe();
        } catch (err) {
          say(errCode(err) === "revision_conflict" ? MSG.restoreStale : errText(err));
          await refreshSafe();
        }
      });
      if (state.open) render();
    }

    async function refreshSafe() {
      try {
        await host.refresh();
      } catch (_) {
        /* the next poll will adopt it */
      }
    }

    // ------------------------------------------------------------ bulk

    function scopeItems() {
      const s = host.scope();
      const items = (s && Array.isArray(s.items) ? s.items : []).filter((i) => !i.deleted || state.bulk.op === "trash");
      return { label: s && s.label ? s.label : "", items: items.slice(0, TARGETS_MAX) };
    }

    function pageScoped(op) {
      return op === "replace" || op === "context_move" || op === "trash";
    }

    function renderBulk() {
      const b = state.bulk;
      const sel = el(doc, "select", { id: "hq-carnet-hx-op", class: "carnet-input", "aria-label": "Opération" });
      for (const [key, label] of OPS) sel.appendChild(el(doc, "option", { value: key, text: label }));
      sel.value = b.op;
      body.appendChild(section("1. Opération", [field("Opération", sel)].concat(paramFields(b))));
      if (pageScoped(b.op)) body.appendChild(scopeSection(b));
      else body.appendChild(el(doc, "p", { class: "hint", text: "Cette opération cible les pages qui citent l'édition choisie (liste calculée par le serveur)." }));
      const actions = [btn("Aperçu", { "data-hx": "preview", id: "btn-carnet-hx-preview" })];
      body.appendChild(section("2. Aperçu", [el(doc, "div", { class: "carnet-panel-row" }, actions)].concat(previewBlock(b))));
      if (b.result) body.appendChild(resultBlock(b.result));
      body.appendChild(recentBulk());
    }

    function paramFields(b) {
      const p = b.params;
      const out = [];
      if (b.op === "replace") {
        out.push(field("Texte à remplacer", input("hq-carnet-hx-find", { maxlength: "200", value: p.find || "" })));
        out.push(field("Remplacer par", input("hq-carnet-hx-replace", { maxlength: "200", value: p.replace || "" })));
        const cs = el(doc, "input", { type: "checkbox", id: "hq-carnet-hx-case" });
        cs.checked = !!p.case_sensitive;
        out.push(el(doc, "label", { class: "carnet-hx-check" }, [cs, el(doc, "span", { text: "Respecter la casse" })]));
        out.push(el(doc, "p", { class: "hint", text: "Les occurrences qui touchent une mise en forme, un lien ou une référence ne sont pas modifiées (elles sont comptées « ignorées »)." }));
      } else if (b.op === "context_move") {
        out.push(field("Projet", ctxSelect("hq-carnet-hx-project", host.projects(), p.project_id, "Aucun projet")));
        out.push(field("Catégorie", ctxSelect("hq-carnet-hx-category", host.categories(), p.category_id, "Aucune catégorie")));
      } else if (b.op === "trash") {
        const m = el(doc, "select", { id: "hq-carnet-hx-mode", class: "carnet-input", "aria-label": "Action" }, [
          el(doc, "option", { value: "trash", text: "Mettre à la corbeille" }),
          el(doc, "option", { value: "restore", text: "Restaurer de la corbeille" }),
        ]);
        m.value = p.mode || "trash";
        out.push(field("Action", m));
        out.push(el(doc, "p", { class: "hint", text: "La dernière page active n'est jamais mise à la corbeille." }));
      } else if (b.op === "source_migrate") {
        out.push(field("Depuis l'édition", editionSelect("hq-carnet-hx-from", p.from_edition)));
        out.push(field("Vers l'édition", editionSelect("hq-carnet-hx-to", p.to_edition)));
        out.push(el(doc, "p", { class: "hint", text: "Rien n'est repris de l'ancien emplacement : chaque nouvelle référence est « à vérifier » (pas de page, pas de calage)." }));
      } else if (b.op === "file_replace") {
        out.push(field("Édition", editionSelect("hq-carnet-hx-edition", p.edition_id)));
        out.push(field("Nouveau fichier (chemin relatif Inbox/, Uni/ ou Print/)", input("hq-carnet-hx-fileref", { maxlength: "300", value: p.file_ref || "", placeholder: "Uni/manuel-30e.pdf" })));
      }
      return out;
    }

    function ctxSelect(id, list, value, none) {
      const s = el(doc, "select", { id, class: "carnet-input" }, [
        el(doc, "option", { value: "", text: "— inchangé —" }),
        el(doc, "option", { value: "__none__", text: none }),
      ]);
      for (const x of list) if (isObj(x) && typeof x.id === "string") s.appendChild(el(doc, "option", { value: x.id, text: String(x.name || x.id) }));
      s.value = value === null ? "__none__" : typeof value === "string" ? value : "";
      return s;
    }

    function editionSelect(id, value) {
      const s = el(doc, "select", { id, class: "carnet-input" }, [el(doc, "option", { value: "", text: "— choisir —" })]);
      for (const e of state.editions || []) s.appendChild(el(doc, "option", { value: e.id, text: e.title + (e.edition ? " " + e.edition : "") }));
      s.value = typeof value === "string" ? value : "";
      return s;
    }

    async function loadEditions() {
      try {
        const out = await host.api.get("/api/carnet?sources=1");
        state.editions = (Array.isArray(out.editions) ? out.editions : []).filter((e) => isObj(e) && typeof e.id === "string" && !e.archived).slice(0, 200)
          .map((e) => ({ id: e.id, title: String(e.title || ""), edition: String(e.edition || "") }));
      } catch (_) {
        state.editions = [];
      }
      if (state.open && state.tab === "bulk") render();
    }

    function scopeSection(b) {
      const sc = scopeItems();
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Pages concernées" });
      const clean = sc.items.filter((i) => !i.dirty);
      for (const it of sc.items) {
        const cb = el(doc, "input", { type: "checkbox", "data-hx-pick": it.id, id: "hx-pick-" + it.id, "aria-label": it.title });
        cb.checked = b.picked.has(it.id);
        const li = el(doc, "li", { class: "carnet-hx-pick" }, [cb, el(doc, "label", { for: "hx-pick-" + it.id, text: it.title })]);
        if (it.dirty) li.appendChild(el(doc, "span", { class: "hint", text: MSG.draft }));
        list.appendChild(li);
      }
      const bar = el(doc, "div", { class: "carnet-panel-row" }, [
        btn("Tout sélectionner", { "data-hx": "pick-all" }), btn("Aucune", { "data-hx": "pick-none" }),
        el(doc, "span", { class: "hint", id: "hq-carnet-hx-count", text: b.picked.size + " page(s) sélectionnée(s) sur " + sc.items.length + (clean.length !== sc.items.length ? " — brouillons locaux inclus" : "") }),
      ]);
      return section("Portée" + (sc.label ? " — " + sc.label : " — pages de la bibliothèque"), [bar, list]);
    }

    function readParams() {
      const b = state.bulk;
      const node = (id) => dlg.querySelector("#" + id);
      const v = (id) => {
        const n = node(id);
        return n ? n.value : "";
      };
      if (b.op === "replace") {
        if (!node("hq-carnet-hx-find")) return;
        b.params = { find: v("hq-carnet-hx-find"), replace: v("hq-carnet-hx-replace"), case_sensitive: !!(node("hq-carnet-hx-case") || {}).checked };
      } else if (b.op === "context_move") {
        if (!node("hq-carnet-hx-project")) return;
        const p = {};
        const pr = v("hq-carnet-hx-project");
        const ca = v("hq-carnet-hx-category");
        if (pr) p.project_id = pr === "__none__" ? null : pr;
        if (ca) p.category_id = ca === "__none__" ? null : ca;
        b.params = p;
      } else if (b.op === "trash") {
        if (!node("hq-carnet-hx-mode")) return;
        b.params = { mode: v("hq-carnet-hx-mode") || "trash" };
      } else if (b.op === "source_migrate") {
        if (!node("hq-carnet-hx-from")) return;
        b.params = { from_edition: v("hq-carnet-hx-from"), to_edition: v("hq-carnet-hx-to") };
      } else if (b.op === "file_replace") {
        if (!node("hq-carnet-hx-edition")) return;
        b.params = { edition_id: v("hq-carnet-hx-edition"), file_ref: v("hq-carnet-hx-fileref").trim() };
      }
    }

    function previewBlock(b) {
      const pv = b.preview;
      if (!pv) return [el(doc, "p", { class: "hint", text: MSG.previewFirst })];
      const out = [];
      const applicable = pv.targets.filter((t) => t.status === "will_apply");
      out.push(el(doc, "p", { class: "carnet-hx-count", id: "hq-carnet-hx-affected", role: "status", text: applicable.length + " élément(s) seront modifiés" + (pv.total_changes != null ? " (" + pv.total_changes + " changement(s))" : "") + "." }));
      if (pv.info && pv.info.rule) out.push(el(doc, "p", { class: "hint", text: pv.info.rule }));
      for (const w of pv.warnings || []) out.push(el(doc, "p", { class: "carnet-msg carnet-hx-warn", role: "alert", text: (w.code === "calibration_cleared" ? "⚠ " : "") + String(w.text || w.message || w.code) }));
      if (pv.stats) out.push(el(doc, "p", { class: "hint", text: pv.stats.citations + " citation(s) dans les notes, dont " + pv.stats.pdf_page_citations + " avec une page PDF à revérifier." }));
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Aperçu par élément" });
      for (const t of pv.targets) list.appendChild(targetRow(t, true));
      out.push(list);
      if (pv.truncated) out.push(el(doc, "p", { class: "hint", text: pv.truncated + " élément(s) non listés (limite)." }));
      if (pv.requires_calibration_ack) {
        const cb = el(doc, "input", { type: "checkbox", id: "hq-carnet-hx-ack" });
        cb.checked = b.ack;
        out.push(el(doc, "label", { class: "carnet-hx-check" }, [cb, el(doc, "span", { text: MSG.ackCal })]));
      }
      const go = btn("Appliquer à " + applicable.length + " élément(s)", { "data-hx": "apply", id: "btn-carnet-hx-apply" });
      if (!applicable.length || (pv.requires_calibration_ack && !b.ack)) go.disabled = true;
      if (pv.history === false) {
        out.push(el(doc, "p", { class: "carnet-msg", role: "alert", text: MSG.histDown }));
        go.disabled = true;
      }
      out.push(go);
      return out;
    }

    function targetRow(t, preview) {
      const li = el(doc, "li", { class: "carnet-hx-target", "data-hx-status": t.status });
      let line = (t.title || t.id) + " — " + (STATUS_LABEL[t.status] || t.status);
      if (t.changes) line += " (" + t.changes + ")";
      if (t.skipped_occurrences) line += " · " + t.skipped_occurrences + " occurrence(s) mise(s) en forme ignorée(s)";
      li.appendChild(el(doc, "span", { text: line }));
      if (t.reason) li.appendChild(el(doc, "span", { class: "hint", text: t.reason }));
      if (preview && t.samples && t.samples[0]) {
        li.appendChild(el(doc, "span", { class: "carnet-hx-sample", text: String(t.samples[0].before).slice(0, 160) + "  →  " + String(t.samples[0].after).slice(0, 160) }));
      }
      return li;
    }

    function resultBlock(r) {
      const wrap = el(doc, "section", { class: "carnet-panel carnet-hx-result", id: "hq-carnet-hx-result", tabindex: "-1", "aria-label": "Résultat" });
      wrap.appendChild(el(doc, "h4", { text: r.title }));
      const c = r.counts || {};
      wrap.appendChild(el(doc, "p", { role: "status", class: "carnet-hx-outcome", "data-hx-outcome": r.outcome, text: (OUTCOME_LABEL[r.outcome] || r.outcome) + " — " + (c.applied || 0) + " appliqué(s), " + (c.skipped || 0) + " ignoré(s), " + (c.conflicted || 0) + " en conflit, " + (c.failed || 0) + " en échec." }));
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Résultat par élément" });
      for (const t of r.targets || []) list.appendChild(targetRow(t, false));
      wrap.appendChild(list);
      if (r.undoId && !r.undone && (c.applied || 0) > 0) wrap.appendChild(btn("Annuler cette opération", { "data-hx": "undo", "data-id": r.undoId, id: "btn-carnet-hx-undo" }));
      return wrap;
    }

    function paintRecent(holder) {
      const b = state.bulk;
      holder.textContent = "";
      if (!b.events) {
        holder.appendChild(el(doc, "p", { class: "hint", text: "Chargement…" }));
        return;
      }
      if (!b.events.length) {
        holder.appendChild(el(doc, "p", { class: "hint", text: MSG.noBulk }));
        return;
      }
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Opérations récentes" });
      for (const ev of b.events) {
        const li = el(doc, "li", { class: "carnet-hx-event" }, [el(doc, "span", { text: when(ev.at) + " · " + ev.summary + (ev.undone ? " · " + MSG.undone : "") })]);
        if (ev.undoable) li.appendChild(btn("Annuler", { "data-hx": "undo", "data-id": ev.id, "aria-label": "Annuler : " + ev.summary }));
        list.appendChild(li);
      }
      holder.appendChild(list);
    }

    function recentBulk() {
      const holder = el(doc, "div", { id: "hq-carnet-hx-recent" });
      paintRecent(holder);
      if (!state.bulk.events) loadBulkEvents();
      return section("Opérations récentes", [holder]);
    }

    async function loadBulkEvents() {
      const b = state.bulk;
      if (b.loading) return;
      b.loading = true;
      try {
        const out = await host.api.get("/api/carnet?history=1");
        b.events = (Array.isArray(out.events) ? out.events : []).filter((e) => e.kind === "bulk").slice(0, 10);
      } catch (err) {
        b.events = [];
        if (errCode(err) === "history_unavailable") say(MSG.histDown);
      } finally {
        b.loading = false;
      }
      const holder = dlg && dlg.querySelector("#hq-carnet-hx-recent");
      if (state.open && state.tab === "bulk" && holder) paintRecent(holder); // only this list: forms keep their values and focus
    }

    async function preview() {
      const b = state.bulk;
      readParams();
      const payload = { action: "bulk_preview", op: b.op, params: b.params };
      if (pageScoped(b.op)) {
        const ids = scopeItems().items.map((i) => i.id).filter((id) => b.picked.has(id));
        if (!ids.length) return say(MSG.needScope);
        payload.page_ids = ids;
      }
      b.result = null;
      b.ack = false;
      await call(async () => {
        try {
          b.preview = await host.api.post(payload);
          b.preview.payload = payload;
          const n = b.preview.targets.filter((t) => t.status === "will_apply").length;
          say(n + " élément(s) seront modifiés.");
        } catch (err) {
          b.preview = null;
          say(errText(err));
        }
      });
      if (state.open) render();
      const a = dlg.querySelector("#hq-carnet-hx-affected");
      if (a) a.setAttribute("tabindex", "-1");
    }

    async function apply() {
      const b = state.bulk;
      const pv = b.preview;
      if (!pv) return say(MSG.previewFirst);
      const dirty = new Set(scopeItems().items.filter((i) => i.dirty).map((i) => i.id));
      const rows = pv.targets.filter((t) => t.status === "will_apply");
      const targets = rows.filter((t) => !dirty.has(t.id)).map((t) => ({ id: t.id, rev: t.rev }));
      const skipped = rows.filter((t) => dirty.has(t.id) && t.kind !== "edition").map((t) => t.id);
      if (pv.requires_calibration_ack && !b.ack) return say(MSG.ackCal);
      const payload = {
        action: "bulk_apply", op: pv.payload.op, params: pv.params || pv.payload.params, targets, confirm: true,
        expected_count: targets.length, request_id: requestId(), plan: pv.plan,
      };
      if (skipped.length) payload.client_skipped = skipped;
      if (pv.requires_calibration_ack) payload.ack_calibration = true;
      await call(async () => {
        try {
          const out = await host.api.post(payload);
          b.result = { title: "Résultat", outcome: out.outcome, counts: out.counts, targets: out.targets, undoId: out.event_id, undone: false };
          say((OUTCOME_LABEL[out.outcome] || "") + ".");
        } catch (err) {
          const d = isObj(err && err.data) ? err.data : {};
          if (Array.isArray(d.targets)) b.result = { title: "Rien n'a été appliqué", outcome: "none", counts: d.counts || {}, targets: d.targets, undoId: null, undone: false };
          else b.result = null;
          say(errCode(err) === "plan_expired" || errCode(err) === "plan_mismatch" || errCode(err) === "plan_in_use" ? MSG.planGone : errCode(err) === "preview_stale" ? MSG.stalePreview : errCode(err) === "history_unavailable" ? MSG.histDown : errText(err));
        }
        b.preview = null;
        b.events = null;
        await refreshSafe();
      });
      if (state.open) render();
      focusResult();
    }

    async function undo(id) {
      const b = state.bulk;
      await call(async () => {
        try {
          const out = await host.api.post({ action: "bulk_undo", event_id: id, confirm: true });
          b.result = { title: "Annulation", outcome: out.outcome, counts: out.counts, targets: out.targets, undoId: null, undone: true };
          say("Annulation : " + (OUTCOME_LABEL[out.outcome] || "") + ".");
        } catch (err) {
          const d = isObj(err && err.data) ? err.data : {};
          b.result = Array.isArray(d.targets) ? { title: "Annulation impossible", outcome: "none", counts: d.counts || {}, targets: d.targets, undoId: null, undone: true } : null;
          say(errText(err));
        }
        b.events = null;
        await refreshSafe();
      });
      if (state.open) render();
      focusResult();
    }

    function focusResult() {
      const r = dlg && dlg.querySelector("#hq-carnet-hx-result");
      if (r) {
        r.setAttribute("tabindex", "-1");
        r.focus({ preventScroll: false });
      }
    }

    // ------------------------------------------------------------ report

    function renderReport() {
      const r = state.report;
      body.appendChild(el(doc, "p", { class: "hint", text: MSG.reportNote }));
      const title = input("hq-carnet-hx-rtitle", { maxlength: "120", value: r.title, placeholder: "Rapport", "aria-label": "Titre du rapport" });
      body.appendChild(section("Titre", [title]));
      body.appendChild(section("Éléments (dans l'ordre du rapport)", [itemsList(r)].concat(addControls())));
      const src = el(doc, "input", { type: "checkbox", id: "hq-carnet-hx-rsrc" });
      src.checked = r.includeSources;
      const actions = el(doc, "div", { class: "carnet-panel-row" }, [
        el(doc, "label", { class: "carnet-hx-check" }, [src, el(doc, "span", { text: "Ajouter « Sources citées »" })]),
        btn("Assembler", { "data-hx": "rbuild", id: "btn-carnet-hx-rbuild" }),
      ]);
      body.appendChild(section("Assembler", [actions]));
      if (r.result) body.appendChild(reportResult(r.result));
    }

    function itemLabel(it) {
      if (it.kind === "source") return "Source — " + (it.label || it.edition_id);
      if (it.kind === "project_overview") return "Synthèse du projet — " + (it.label || "");
      const k = { note: "Note", measure: "Mesure", decision: "Décision", photo: "Photo", drawing: "Croquis" }[it.kind];
      return k + " — " + (it.label || it.page_id);
    }

    function itemsList(r) {
      const list = el(doc, "ol", { class: "carnet-hx-list", "aria-label": "Éléments du rapport", id: "hq-carnet-hx-ritems" });
      if (!r.items.length) list.appendChild(el(doc, "li", { class: "hint", text: MSG.reportEmpty }));
      r.items.forEach((it, i) => {
        const li = el(doc, "li", { class: "carnet-hx-item", "data-hx-i": String(i) }, [el(doc, "span", { class: "carnet-hx-event-text", text: itemLabel(it) })]);
        li.appendChild(btn("↑", { "data-hx": "rup", "data-i": String(i), "aria-label": "Monter : " + itemLabel(it), disabled: i === 0 ? "" : null }));
        li.appendChild(btn("↓", { "data-hx": "rdown", "data-i": String(i), "aria-label": "Descendre : " + itemLabel(it), disabled: i === r.items.length - 1 ? "" : null }));
        li.appendChild(btn("Retirer", { "data-hx": "rdel", "data-i": String(i), "aria-label": "Retirer : " + itemLabel(it) }));
        for (const b of li.querySelectorAll("button")) if (b.getAttribute("disabled") === null || b.getAttribute("disabled") === "null") b.removeAttribute("disabled");
        list.appendChild(li);
      });
      return list;
    }

    function addControls() {
      const out = [];
      const pick = el(doc, "select", { id: "hq-carnet-hx-radd", class: "carnet-input", "aria-label": "Ajouter au rapport" }, [el(doc, "option", { value: "", text: "— ajouter —" })]);
      const sc = host.scope();
      for (const i of (sc && sc.items) || []) if (!i.deleted) pick.appendChild(el(doc, "option", { value: "note:" + i.id, text: "Note — " + i.title }));
      for (const b of host.blocks() || []) pick.appendChild(el(doc, "option", { value: b.type + ":" + b.id, text: ({ measure: "Mesure", decision: "Décision", photo: "Photo", drawing: "Croquis" }[b.type] || b.type) + " (page ouverte) — " + b.label }));
      for (const e of state.editions || []) pick.appendChild(el(doc, "option", { value: "source:" + e.id, text: "Source — " + e.title + (e.edition ? " " + e.edition : "") }));
      out.push(el(doc, "div", { class: "carnet-panel-row" }, [pick, btn("Ajouter", { "data-hx": "radd", id: "btn-carnet-hx-radd" })]));
      if (!state.editions) loadEditions();
      return out;
    }

    function addItem(value) {
      const r = state.report;
      if (!value || r.items.length >= ITEMS_MAX) return;
      const i = value.indexOf(":");
      const kind = value.slice(0, i);
      const id = value.slice(i + 1);
      const sc = host.scope();
      if (kind === "source") {
        const e = (state.editions || []).find((x) => x.id === id);
        r.items.push({ kind, edition_id: id, label: e ? e.title + (e.edition ? " " + e.edition : "") : id });
      } else if (kind === "note") {
        const it = ((sc && sc.items) || []).find((x) => x.id === id);
        const entry = host.pageRev(id);
        if (!entry) return say("Page introuvable.");
        if (entry.dirty) return say(MSG.busy);
        r.items.push({ kind, page_id: id, rev: entry.rev, label: it ? it.title : id });
      } else {
        const cur = host.current();
        const bl = (host.blocks() || []).find((x) => x.id === id);
        if (!cur || !bl) return;
        if (cur.dirty) return say(MSG.busy);
        r.items.push({ kind, page_id: cur.id, rev: cur.rev, block_id: id, label: bl.label });
      }
      r.result = null;
      render();
    }

    function wireItems(items) {
      return items.map((it) => (it.kind === "project_overview" ? (it.snapshot_id ? { kind: it.kind, snapshot_id: it.snapshot_id } : { kind: it.kind, project_id: it.project_id, fingerprint: it.fingerprint }) : it.kind === "source" ? { kind: "source", edition_id: it.edition_id } : it.kind === "note" ? { kind: "note", page_id: it.page_id, rev: it.rev } : { kind: it.kind, page_id: it.page_id, rev: it.rev, block_id: it.block_id }));
    }

    async function buildReport(exportOpts) {
      const r = state.report;
      if (!r.items.length) return say(MSG.reportEmpty);
      const t = dlg.querySelector("#hq-carnet-hx-rtitle");
      const s = dlg.querySelector("#hq-carnet-hx-rsrc");
      if (t) r.title = t.value;
      if (s) r.includeSources = s.checked;
      const payload = { action: "report_build", items: wireItems(r.items), include_sources: r.includeSources };
      if (r.title.trim()) payload.title = r.title.trim();
      if (exportOpts) payload.export = exportOpts;
      await call(async () => {
        try {
          const out = await host.api.post(payload);
          r.result = out;
          say(exportOpts ? "Rapport exporté : " + out.path : "Rapport assemblé (" + out.items + " élément(s)).");
        } catch (err) {
          r.result = null;
          say(errCode(err) === "report_stale" ? MSG.reportStale : errCode(err) === "export_exists" ? "Un fichier du même nom existe déjà — choisis un autre nom." : errText(err));
        }
      });
      if (state.open) render();
    }

    function reportResult(res) {
      const wrap = el(doc, "section", { class: "carnet-panel carnet-hx-result", id: "hq-carnet-hx-report", "aria-label": "Rapport assemblé" });
      wrap.appendChild(el(doc, "h4", { text: res.title }));
      if (res.markdown != null) {
        wrap.appendChild(el(doc, "pre", { class: "carnet-hx-md", id: "hq-carnet-hx-md", tabindex: "0", "aria-label": "Rapport (Markdown)", text: res.markdown }));
        if (res.assets && res.assets.length) wrap.appendChild(el(doc, "p", { class: "hint", text: res.assets.length + " image(s) : " + MSG.printNote }));
        const root = el(doc, "select", { id: "hq-carnet-hx-eroot", class: "carnet-input", "aria-label": "Dossier Transfert" });
        for (const r of host.roots) root.appendChild(el(doc, "option", { value: r, text: r }));
        const name = input("hq-carnet-hx-ename", { maxlength: "120", placeholder: "Nom du fichier (facultatif)", "aria-label": "Nom du fichier" });
        wrap.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [root, name, btn("Exporter en .md", { "data-hx": "rexport", id: "btn-carnet-hx-rexport" }), btn("Imprimer / PDF", { "data-hx": "rprint", id: "btn-carnet-hx-rprint" })]));
      } else {
        wrap.appendChild(el(doc, "p", { role: "status", text: "Exporté : " + res.path + (res.assets_dir ? " + " + res.assets_dir + " (" + res.assets_count + " image(s))" : "") }));
        wrap.appendChild(btn("Revenir à l'aperçu", { "data-hx": "rbuild" }));
      }
      return wrap;
    }

    function printOverview(hostEl, sec) {
      const ov = sec.overview || {};
      const c = ov.counts || {};
      hostEl.appendChild(el(doc, "h2", { text: sec.label + " — " + ((ov.project && ov.project.name) || "Sans projet") }));
      if (sec.snapshot) hostEl.appendChild(el(doc, "p", { text: "Jalon figé : " + sec.snapshot.label + " — " + when(sec.snapshot.created_at) }));
      hostEl.appendChild(el(doc, "p", { text: "Notes " + c.pages + " · Décisions " + c.decisions + " · Mesures " + c.measurements + " (hors tolérance : " + c.out_of_tolerance + ") · Images " + c.images + " · Croquis " + c.drawings + " · Sources " + c.sources }));
      if ((ov.decisions || []).length) {
        hostEl.appendChild(el(doc, "h3", { text: "Journal des décisions" }));
        hostEl.appendChild(el(doc, "ul", null, ov.decisions.map((d) => el(doc, "li", { text: when(d.at) + " — " + d.text + " · " + d.page_title }))));
      }
      for (const s of ov.series || []) {
        hostEl.appendChild(el(doc, "h3", { text: s.label + (s.unit ? " (" + s.unit + ")" : "") }));
        hostEl.appendChild(el(doc, "ul", null, s.points.map((p) => el(doc, "li", { text: when(p.at) + " — " + p.value + " — " + ({ in: "dans la tolérance", out: "hors tolérance", none: "sans tolérance", incompatible: "unités incompatibles" }[p.verdict] || "") }))));
      }
    }

    function printReport() {
      const res = state.report.result;
      if (!res || !Array.isArray(res.sections)) return;
      const old = doc.getElementById("hq-carnet-print");
      if (old) old.remove();
      const hostEl = el(doc, "div", { id: "hq-carnet-print", "aria-hidden": "true" });
      hostEl.appendChild(el(doc, "h1", { text: res.title }));
      for (const sec of res.sections) {
        if (sec.kind === "source") {
          const e = sec.edition || {};
          hostEl.appendChild(el(doc, "h2", { text: "Source — " + (e.title || "") }));
          hostEl.appendChild(el(doc, "p", { text: [e.author, e.edition, e.year, e.publisher].filter((x) => x).join(" · ") }));
          continue;
        }
        if (sec.kind === "project_overview") {
          printOverview(hostEl, sec);
          continue;
        }
        hostEl.appendChild(el(doc, "h2", { text: sec.label + " — " + sec.page_title }));
        const part = el(doc, "div");
        try {
          Rich.renderInto(part, Rich.linesFromContent({ version: 2, blocks: sec.blocks }), { print: true });
          part.removeAttribute("contenteditable");
        } catch (_) {
          part.appendChild(el(doc, "p", { text: "(contenu non affichable)" }));
        }
        hostEl.appendChild(part);
      }
      doc.body.appendChild(hostEl);
      doc.body.classList.add("carnet-printing");
      const done = () => {
        doc.body.classList.remove("carnet-printing");
        const n = doc.getElementById("hq-carnet-print");
        if (n) n.remove();
      };
      global.addEventListener("afterprint", done, { once: true });
      try {
        global.print();
      } finally {
        setTimeout(done, 1500);
      }
    }

    // ------------------------------------------------------------ backlinks

    async function loadBack() {
      const t = state.back;
      if (!t.id) {
        const cur = host.current();
        t.kind = "note";
        t.id = cur ? cur.id : "";
      }
      if (!t.id) return;
      try {
        t.data = await host.api.get("/api/carnet?backlinks=" + encodeURIComponent(t.kind) + "&id=" + encodeURIComponent(t.id));
        t.error = "";
      } catch (err) {
        t.data = null;
        t.error = errText(err);
      }
      if (state.open && state.tab === "back") render();
    }

    function renderBack() {
      const t = state.back;
      const kind = el(doc, "select", { id: "hq-carnet-hx-bkind", class: "carnet-input", "aria-label": "Type de cible" }, [
        el(doc, "option", { value: "note", text: "Note" }), el(doc, "option", { value: "source", text: "Source (édition)" }), el(doc, "option", { value: "project", text: "Projet" }),
      ]);
      kind.value = t.kind;
      const target = el(doc, "select", { id: "hq-carnet-hx-btarget", class: "carnet-input", "aria-label": "Cible" });
      const opts = t.kind === "note" ? ((host.scope() || {}).items || []).filter((i) => !i.deleted).map((i) => [i.id, i.title])
        : t.kind === "project" ? host.projects().map((p) => [p.id, p.name]) : (state.editions || []).map((e) => [e.id, e.title + (e.edition ? " " + e.edition : "")]);
      if (t.kind === "source" && !state.editions) loadEditions();
      for (const [id, text] of opts) target.appendChild(el(doc, "option", { value: id, text }));
      if (t.id && opts.some((o) => o[0] === t.id)) target.value = t.id;
      body.appendChild(section("Liée depuis…", [field("Type", kind), field("Cible", target)]));
      const list = el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-hx-blist", "aria-label": "Notes qui renvoient ici" });
      const box = section("Notes qui renvoient ici", [list]);
      body.appendChild(box);
      if (!t.data && !t.error) {
        list.appendChild(el(doc, "li", { class: "hint", text: "Chargement…" }));
        loadBack();
        return;
      }
      if (t.error) return void list.appendChild(el(doc, "li", { class: "carnet-msg", role: "alert", text: t.error }));
      const d = t.data;
      if (!d.items.length && !d.trashed_total) list.appendChild(el(doc, "li", { class: "hint", text: MSG.backNone }));
      for (const it of d.items) {
        const li = el(doc, "li", { class: "carnet-hx-event" }, [el(doc, "span", { text: it.title + (it.count > 1 ? " (" + it.count + " liens)" : "") })]);
        li.appendChild(btn("Ouvrir", { "data-hx": "open", "data-id": it.page_id, "aria-label": "Ouvrir la note : " + it.title }));
        list.appendChild(li);
      }
      if (d.total > d.items.length) list.appendChild(el(doc, "li", { class: "hint", text: (d.total - d.items.length) + " autre(s) non listée(s)." }));
      if (d.trashed_total) {
        const det = el(doc, "details", { class: "carnet-archived" }, [el(doc, "summary", { text: "Dans la corbeille (" + d.trashed_total + ")" })]);
        for (const it of d.trashed) det.appendChild(el(doc, "p", { class: "hint", text: it.title }));
        box.appendChild(det);
      }
      if (d.target_exists === false) box.appendChild(el(doc, "p", { class: "hint", text: "La cible n'existe plus ou est dans la corbeille." }));
    }

    // ------------------------------------------------------------ events

    function onInput(ev) {
      const n = ev.target;
      if (state.tab === "bulk" && n && n.id && n.id.indexOf("hq-carnet-hx-") === 0 && n.id !== "hq-carnet-hx-op" && n.id !== "hq-carnet-hx-ack") {
        state.bulk.preview = null; // any parameter change invalidates the preview
        state.bulk.result = null;
      }
    }

    function onChange(ev) {
      const n = ev.target;
      if (!n) return;
      if (n.id === "hq-carnet-hx-op") {
        readParams();
        state.bulk.op = n.value;
        state.bulk.params = {};
        state.bulk.preview = null;
        state.bulk.result = null;
        state.bulk.picked = new Set();
        if (n.value === "source_migrate" || n.value === "file_replace") loadEditions();
        render();
        const s = dlg.querySelector("#hq-carnet-hx-op");
        if (s) s.focus({ preventScroll: true });
      } else if (n.getAttribute && n.getAttribute("data-hx-pick")) {
        const id = n.getAttribute("data-hx-pick");
        if (n.checked) state.bulk.picked.add(id);
        else state.bulk.picked.delete(id);
        state.bulk.preview = null;
        const c = dlg.querySelector("#hq-carnet-hx-count");
        if (c) c.textContent = state.bulk.picked.size + " page(s) sélectionnée(s)";
        const pv = dlg.querySelector("#btn-carnet-hx-apply");
        if (pv) pv.disabled = true;
      } else if (n.id === "hq-carnet-hx-ack") {
        state.bulk.ack = n.checked;
        const go = dlg.querySelector("#btn-carnet-hx-apply");
        if (go) go.disabled = !n.checked || !state.bulk.preview || !state.bulk.preview.targets.some((t) => t.status === "will_apply");
      } else if (n.id === "hq-carnet-hx-bkind") {
        state.back = { kind: n.value, id: "" };
        const first = n.value === "note" ? ((host.scope() || {}).items || [])[0] : null;
        if (first) state.back.id = first.id;
        render();
      } else if (n.id === "hq-carnet-hx-btarget") {
        state.back = { kind: state.back.kind, id: n.value };
        render();
      } else if (n.id === "hq-carnet-hx-rsrc" || n.id === "hq-carnet-hx-rtitle") {
        state.report.result = null;
      }
    }

    function onClick(ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!t) return;
      if (t.id === "btn-carnet-hx-close") return close(true);
      const tab = t.getAttribute("data-hx-tab");
      if (tab) {
        if (tab === "history") state.history = null;
        if (tab === "back") state.back = { kind: "note", id: "" };
        if (tab === "bulk") state.bulk.events = null;
        return setTab(tab);
      }
      const act = t.getAttribute("data-hx");
      const id = t.getAttribute("data-id");
      if (act === "checkpoint") checkpoint();
      else if (act === "restore" || act === "restore-confirm") restore(id);
      else if (act === "audit") {
        state.audit = auditStorage(host.storage(), host.draftPrefix);
        render();
        say("Vérification terminée.");
      } else if (act === "pick-all") {
        for (const i of scopeItems().items) state.bulk.picked.add(i.id);
        state.bulk.preview = null;
        render();
      } else if (act === "pick-none") {
        state.bulk.picked = new Set();
        state.bulk.preview = null;
        render();
      } else if (act === "preview") preview();
      else if (act === "apply") apply();
      else if (act === "undo") undo(id);
      else if (act === "radd") {
        const s = dlg.querySelector("#hq-carnet-hx-radd");
        if (s) addItem(s.value);
      } else if (act === "rdel" || act === "rup" || act === "rdown") {
        const i = Number(t.getAttribute("data-i"));
        const items = state.report.items;
        if (act === "rdel") items.splice(i, 1);
        else {
          const j = act === "rup" ? i - 1 : i + 1;
          if (j >= 0 && j < items.length) [items[i], items[j]] = [items[j], items[i]];
        }
        state.report.result = null;
        render();
        const again = dlg.querySelector('[data-hx-i="' + (act === "rdel" ? Math.min(i, items.length - 1) : act === "rup" ? i - 1 : i + 1) + '"] [data-hx="' + (act === "rdel" ? "rdel" : act) + '"]') || dlg.querySelector("#hq-carnet-hx-radd");
        if (again) again.focus({ preventScroll: true });
      } else if (act === "rbuild") {
        if (state.report.result && state.report.result.markdown == null) {
          state.report.result = null;
          render();
        } else buildReport(null);
      } else if (act === "rexport") {
        const root = dlg.querySelector("#hq-carnet-hx-eroot");
        const name = dlg.querySelector("#hq-carnet-hx-ename");
        const opts = { dir: root ? root.value : host.roots[0] };
        if (name && name.value.trim()) opts.filename = name.value.trim();
        buildReport(opts);
      } else if (act === "rprint") printReport();
      else if (act === "open") {
        if (host.openNote(id)) close(false);
        else say("Note introuvable.");
      }
    }

    /** Phase 5: the cockpit adds a derived project overview (live, pinned by fingerprint, or a frozen snapshot) to the report. */
    function addExternal(item) {
      const r = state.report;
      if (!isObj(item) || item.kind !== "project_overview" || r.items.length >= ITEMS_MAX) return false;
      const key = item.snapshot_id ? "s:" + item.snapshot_id : "p:" + item.project_id + ":" + item.fingerprint;
      if (r.items.some((x) => x.kind === "project_overview" && (x.snapshot_id ? "s:" + x.snapshot_id : "p:" + x.project_id + ":" + x.fingerprint) === key)) return true;
      r.items.push({ kind: item.kind, snapshot_id: item.snapshot_id, project_id: item.project_id, fingerprint: item.fingerprint, label: String(item.label || "").slice(0, 100) });
      r.result = null;
      return true;
    }

    return {
      open,
      addExternal,
      close,
      isOpen: () => state.open,
      el: () => dlg,
    };
  }

  return { MSG, OPS, mount, auditStorage, TARGETS_MAX };
});
