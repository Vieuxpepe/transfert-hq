/* Transfert HQ — Carnet Phase 7: review packs UI ("Revues").
 *
 * NOTHING here is visible on the default paper. One modal dialog (#hq-carnet-rv), created lazily, on the shared `.carnet-hx` shell.
 * A review pack organizes evidence for a human review; it never decides what the evidence means. The status, the checklist and the
 * questions are exactly what the user typed or ticked — nothing is inferred, completed or resolved for them.
 *
 * Stored items ("Copie capturée") and the freshness observation ("Observation actuelle") are rendered as two separate blocks.
 * A 409 reloads the server version and keeps the user's unsaved text visible; nothing is merged or retried. Mutations need a
 * connection; a loaded pack stays readable offline.
 *
 * DOM is built with createElement / textContent only. No HTML string injection, no dynamic code evaluation. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReviewsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const R = node ? require("./hq-carnet-reviews.js") : global.HqCarnetReviews;
  const LAST_KEY = "hq.carnet.review.last";
  const TABS = [["overview", "Vue d'ensemble"], ["evidence", "Preuves"], ["checklist", "Liste de contrôle"], ["questions", "Questions"], ["freshness", "Fraîcheur"], ["report", "Rapport"]];
  const MSG = {
    title: "Revues",
    needProject: "Les revues sont liées à un projet : ouvre une note d'un projet ou choisis un projet dans la bibliothèque.",
    offline: "Hors ligne : la revue reste lisible, mais aucune modification n'est possible.",
    loading: "Chargement…",
    failed: "Action impossible.",
    conflict: "La revue a changé ailleurs : la version du serveur est affichée. Ton texte non enregistré est conservé ci-dessous ; rien n'a été fusionné.",
    deleted: "Revue supprimée définitivement.",
    added: "Ajouté à la revue",
    reportAdded: "Dossier de revue ajouté au rapport.",
  };

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
        if (k === "text") n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
      }
    }
    if (kids) for (const c of kids) if (c) n.appendChild(c);
    return n;
  }

  function mount(host) {
    const doc = host.doc;
    const state = {
      open: false, opener: null, projectId: null, mode: "list", tab: "overview", token: 0, busy: false, error: "", notice: "",
      list: null, snaps: [], pack: null, integrity: "ok", fresh: null, freshBusy: false, confirmDelete: null, pendingCreate: null, definiteError: false,
      adding: null, draft: { title: "", note: "", baseline: "", check: "", question: "", resolution: {}, edit: {} },
    };
    let dlg = null;
    let body = null;
    let live = null;

    // ------------------------------------------------------------ shell

    function build() {
      live = el(doc, "p", { id: "hq-carnet-rv-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      body = el(doc, "div", { class: "carnet-hx-body carnet-rv-body", id: "hq-carnet-rv-body" });
      const close = el(doc, "button", { type: "button", id: "btn-carnet-rv-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-rv-title", text: MSG.title }), close]);
      dlg = el(doc, "div", { id: "hq-carnet-rv", class: "carnet-hx carnet-rv", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-rv-title", tabindex: "-1", hidden: "" }, [head, live, body]);
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("keydown", onKey);
      dlg.addEventListener("input", onInput);
      dlg.addEventListener("change", onChange);
      dlg.addEventListener("submit", onSubmit);
      host.root.appendChild(dlg);
    }

    function say(text) {
      if (live) live.textContent = text || "";
    }

    function focusables() {
      return Array.prototype.filter.call(dlg.querySelectorAll("button, input, select, textarea, a[href], [tabindex]"), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
    }

    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.confirmDelete) {
          state.confirmDelete = null;
          render();
          const d = doc.getElementById("btn-carnet-rv-delete");
          if (d) d.focus({ preventScroll: true });
          return;
        }
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

    const online = () => (typeof host.online === "function" ? !!host.online() : true);
    const btn = (label, attrs) => el(doc, "button", Object.assign({ type: "button", class: "carnet-btn", text: label }, attrs || {}));
    const mut = (label, attrs) => btn(label, Object.assign({ "aria-disabled": state.busy || !online() || (state.pack && state.pack.readOnly) ? "true" : null }, attrs || {}));

    // ------------------------------------------------------------ data

    function pidNow() {
      const p = host.currentProjectId ? host.currentProjectId() : null;
      return p && p !== "none" ? p : null;
    }

    function recall() {
      try {
        return (host.storage && host.storage().getItem(LAST_KEY)) || null;
      } catch (_) {
        return null;
      }
    }

    function remember(id) {
      try {
        if (host.storage) host.storage().setItem(LAST_KEY, id);
      } catch (_) {
        /* a convenience only */
      }
    }

    async function loadList() {
      if (!state.projectId) return;
      const tok = state.token;
      try {
        const res = await host.api.get("/api/carnet?reviews=1&project=" + encodeURIComponent(state.projectId));
        if (tok !== state.token || !state.open) return;
        state.list = R.listModel(res);
        state.error = state.list ? "" : MSG.failed;
      } catch (err) {
        if (tok !== state.token || !state.open) return;
        state.error = R.conflictInfo(err).message;
      }
      render();
    }

    async function loadSnaps() {
      if (!state.projectId) return;
      try {
        const res = await host.api.get("/api/carnet?snapshots=1&project=" + encodeURIComponent(state.projectId));
        state.snaps = isObj(res) && Array.isArray(res.snapshots) ? res.snapshots.filter((s) => s.integrity === "ok") : [];
      } catch (_) {
        state.snaps = [];
      }
      if (state.open && state.mode === "list") render();
    }

    async function loadPack(id) {
      const tok = ++state.token;
      state.busy = true;
      try {
        const res = await host.api.get("/api/carnet?review=" + encodeURIComponent(id));
        if (tok !== state.token || !state.open) return false;
        state.pack = R.packModel(res.review, null, res.integrity);
        state.raw = res.review;
        state.integrity = res.integrity;
        state.mode = "pack";
        state.error = "";
        remember(id);
        loadFreshness();
        return true;
      } catch (err) {
        if (tok === state.token) state.error = R.conflictInfo(err).message;
        return false;
      } finally {
        if (tok === state.token) state.busy = false;
        if (state.open) render();
      }
    }

    async function loadFreshness() {
      if (!state.raw || state.freshBusy) return;
      const id = state.raw.id;
      const rev = state.raw.rev;
      state.freshBusy = true;
      render();
      try {
        const res = await host.api.get("/api/carnet?review=" + encodeURIComponent(id) + "&freshness=1");
        if (state.raw && state.raw.id === id && res.rev === rev) {
          state.fresh = res.freshness;
          state.pack = R.packModel(state.raw, state.fresh, state.integrity);
        }
      } catch (_) {
        state.fresh = null;
        say("Fraîcheur non vérifiable pour le moment.");
      }
      state.freshBusy = false;
      if (state.open) render();
    }

    /** Runs ONE mutation. A 409 reloads the server version and keeps every draft; nothing is retried. */
    async function act(bodyObj, after) {
      if (state.busy) return null;
      if (!bodyObj) {
        say(MSG.failed);
        return null;
      }
      if (!online()) {
        state.error = MSG.offline;
        render();
        say(MSG.offline);
        return null;
      }
      state.busy = true;
      state.error = "";
      render();
      try {
        const res = await host.api.post(bodyObj);
        state.busy = false;
        if (isObj(res) && res.review) {
          state.raw = res.review;
          state.integrity = res.integrity || "ok";
          state.pack = R.packModel(res.review, null, state.integrity);
          state.fresh = null;
          state.mode = "pack";
        }
        if (after) after(res);
        render();
        loadFreshness();
        return res;
      } catch (err) {
        state.busy = false;
        const info = R.conflictInfo(err);
        state.definiteError = !!info.code;  // a coded server refusal is a known outcome; a bare network error is not
        state.error = info.message;
        state.confirmDelete = null;
        if (info.reload && state.raw) {
          state.notice = MSG.conflict;
          await loadPack(state.raw.id);
        } else {
          render();
        }
        say(state.error);
        return null;
      }
    }

    // ------------------------------------------------------------ lifecycle

    function resetDraft() {
      state.draft = { title: "", note: "", baseline: "", check: "", question: "", resolution: {}, edit: {} };
    }

    function open(opener, opts) {
      if (!dlg) build();
      state.opener = opener || doc.activeElement || null;
      state.open = true;
      state.token += 1;
      state.projectId = (opts && opts.projectId) || pidNow();
      state.mode = "list";
      state.tab = "overview";
      state.list = null;
      state.pack = null;
      state.raw = null;
      state.fresh = null;
      state.error = "";
      state.notice = "";
      state.adding = null;
      state.confirmDelete = null;
      resetDraft();
      dlg.hidden = false;
      render();
      if (state.projectId) {
        loadList();
        loadSnaps();
      }
      focusFirst();
    }

    function focusFirst() {
      const h = dlg.querySelector("[data-rv-focus]") || dlg.querySelector("#btn-carnet-rv-close");
      if (h) h.focus({ preventScroll: true });
    }

    function close(refocus) {
      if (!dlg || !state.open) return;
      state.open = false;
      state.token += 1;
      state.adding = null;
      state.confirmDelete = null;
      state.pack = null;
      state.raw = null;
      state.fresh = null;
      body.textContent = "";
      dlg.hidden = true;
      say("");
      const o = state.opener;
      state.opener = null;
      if (refocus && o && typeof o.focus === "function" && doc.contains(o)) o.focus({ preventScroll: true });
      if (typeof host.onClose === "function") host.onClose(!!refocus);
    }

    /** Called from the cockpit / Ask: choose a pack (or create one) and add ONE piece of evidence. Identity only is sent. */
    function addItem(item, opener) {
      if (!isObj(item) || !isObj(item.spec)) return false;
      if (!dlg) build();
      open(opener, { projectId: item.projectId || null });
      state.adding = { spec: item.spec, label: item.label || "", step: "choose", target: null };
      render();
      focusFirst();
      return true;
    }

    // ------------------------------------------------------------ rendering

    function render() {
      if (!body || !state.open) return;
      const active = doc.activeElement && dlg.contains(doc.activeElement) ? doc.activeElement.id || null : null;
      body.textContent = "";
      if (!state.projectId) {
        body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-need", text: MSG.needProject }));
        return;
      }
      if (!online()) body.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "status", "data-rv": "offline", text: MSG.offline }));
      if (state.notice) body.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", id: "hq-carnet-rv-notice", text: state.notice }));
      if (state.error) body.appendChild(el(doc, "p", { class: "carnet-ask-banner", "data-ask-tone": "error", role: "alert", id: "hq-carnet-rv-error", text: state.error }));
      if (state.adding) renderAdding();
      else if (state.mode === "pack" && state.pack) renderPack();
      else renderList();
      if (active) {
        const n = doc.getElementById(active);
        if (n && dlg.contains(n)) n.focus({ preventScroll: true });
        else dlg.focus({ preventScroll: true }); // the focused control vanished: keep key events (Escape / Tab) inside the dialog
      }
    }

    function field(label, input) {
      return el(doc, "label", { class: "carnet-hx-field" }, [el(doc, "span", { text: label }), input]);
    }

    function textInput(id, value, max, label, dataKey) {
      const i = el(doc, "input", { type: "text", id, class: "carnet-input", maxlength: String(max), autocomplete: "off", "data-rv-draft": dataKey });
      i.value = value;
      return field(label, i);
    }

    function textArea(id, value, max, label, dataKey, rows) {
      const t = el(doc, "textarea", { id, class: "carnet-input", maxlength: String(max), rows: String(rows || 2), "data-rv-draft": dataKey });
      t.value = value;
      return field(label, t);
    }

    function newForm() {
      const sel = el(doc, "select", { id: "hq-carnet-rv-baseline", class: "carnet-input", "data-rv-draft": "baseline" }, [el(doc, "option", { value: "", text: "État courant (non figé)" })]);
      for (const s of state.snaps) sel.appendChild(el(doc, "option", { value: s.id, text: "Jalon figé — " + s.label }));
      sel.value = state.draft.baseline;
      return el(doc, "form", { class: "carnet-hx-col carnet-rv-new", id: "hq-carnet-rv-new", novalidate: "", "data-rv": "create" }, [
        textInput("hq-carnet-rv-new-title", state.draft.title, R.LIMITS.title, "Titre de la revue", "title"),
        textArea("hq-carnet-rv-new-note", state.draft.note, R.LIMITS.note, "Note (facultative)", "note", 2),
        field("Contexte", sel),
        el(doc, "p", { class: "hint", text: "Le contexte (état courant ou jalon figé) ne peut plus changer une fois des preuves ajoutées." }),
        mut("Créer la revue", { type: "submit", id: "btn-carnet-rv-create", class: "carnet-btn carnet-primary" }),
      ]);
    }

    function renderList() {
      const l = state.list;
      body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-intro", text: R.NOT_VERDICT }));
      if (!l) {
        body.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      } else if (!l.rows.length) {
        body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-none", text: "Aucune revue pour ce projet." }));
      } else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-rv-list", "aria-label": "Revues du projet" });
        for (const r of l.rows) {
          ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-rv-row", "data-rv-id": r.id, "data-rv-integrity": r.integrity }, [
            el(doc, "strong", { text: r.title }),
            el(doc, "span", { class: "carnet-chip", text: r.statusLabel }),
            el(doc, "span", { class: "hint", text: r.counts + " · " + r.baseline + " · " + r.updated }),
            r.integrityLabel ? el(doc, "span", { class: "carnet-hx-warn", text: r.integrityLabel }) : null,
            btn("Ouvrir", { "data-rv": "open", "data-id": r.id, "aria-label": "Ouvrir la revue « " + r.title + " »" }),
          ]));
        }
        body.appendChild(ul);
        if (l.unavailable) body.appendChild(el(doc, "p", { class: "carnet-hx-warn", text: l.unavailable + " fichier(s) de revue illisible(s) conservé(s) tel(s) quel(s)." }));
      }
      body.appendChild(el(doc, "h4", { text: "Nouvelle revue" }));
      body.appendChild(newForm());
    }

    function chooser() {
      const a = state.adding;
      const l = state.list;
      const box = el(doc, "section", { class: "carnet-panel", id: "hq-carnet-rv-add", "aria-label": "Ajouter au dossier de revue" });
      box.appendChild(el(doc, "h4", { text: "Ajouter au dossier de revue" }));
      box.appendChild(el(doc, "p", { class: "hint", "data-rv": "adding-label", text: a.label || "Preuve" }));
      if (a.step === "choose") {
        if (!l) box.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
        else {
          const last = recall();
          const rows = l.rows.filter((r) => !r.readOnly);
          if (!rows.length) box.appendChild(el(doc, "p", { class: "hint", text: "Aucune revue modifiable pour ce projet : crées-en une." }));
          const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Choisir la revue" });
          for (const r of rows) {
            ul.appendChild(el(doc, "li", { class: "carnet-hx-item", "data-rv-id": r.id }, [
              el(doc, "span", { text: r.title + (r.id === last ? " (dernière utilisée)" : "") }),
              el(doc, "span", { class: "hint", text: r.statusLabel + " · " + r.counts }),
              mut("Choisir", { "data-rv": "pick", "data-id": r.id, "aria-label": "Ajouter à « " + r.title + " »" }),
            ]));
          }
          box.appendChild(ul);
        }
        box.appendChild(el(doc, "h5", { text: "Ou créer une revue" }));
        box.appendChild(newForm());
      } else if (a.step === "mode" && state.raw) {
        const same = state.pack.items.filter((i) => i.replaceable && a.spec.kind === "ask_result" && i.question === a.spec.question);
        box.appendChild(el(doc, "p", { text: "Revue : « " + state.pack.title + " »" }));
        box.appendChild(mut("Ajouter comme nouvelle preuve", { "data-rv": "add-new", id: "btn-carnet-rv-add-new", class: "carnet-btn carnet-primary" }));
        for (const i of same) {
          box.appendChild(mut("Remplacer « " + i.label + " » (l'ancienne empreinte est conservée)", { "data-rv": "add-replace", "data-id": i.id }));
        }
      }
      box.appendChild(btn("Annuler", { "data-rv": "add-cancel", id: "btn-carnet-rv-add-cancel" }));
      return box;
    }

    function renderAdding() {
      body.appendChild(chooser());
    }

    function statusSelect(p) {
      const s = el(doc, "select", { id: "hq-carnet-rv-status", class: "carnet-input", "data-rv-status": "1", "aria-disabled": p.readOnly || state.busy ? "true" : null });
      for (const k of R.STATUSES) s.appendChild(el(doc, "option", { value: k, text: R.STATUS_LABEL[k] }));
      s.value = p.status;
      return field("Statut (défini par toi)", s);
    }

    function renderPack() {
      const p = state.pack;
      const head = el(doc, "div", { class: "carnet-rv-head" }, [
        btn("← Revues", { "data-rv": "back", id: "btn-carnet-rv-back", "data-rv-focus": "1" }),
        el(doc, "h4", { id: "hq-carnet-rv-name", text: p.title }),
        el(doc, "span", { class: "carnet-chip", "data-rv": "integrity", text: p.integrityLabel }),
      ]);
      body.appendChild(head);
      if (p.readOnly) body.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", id: "hq-carnet-rv-corrupt", text: p.integrityLabel + "." }));
      const tabs = el(doc, "div", { class: "carnet-hx-tabs", role: "tablist", "aria-label": "Sections de la revue" });
      for (const t of TABS) tabs.appendChild(el(doc, "button", { type: "button", role: "tab", class: "carnet-btn carnet-hx-tab", "data-rv-tab": t[0], "aria-selected": state.tab === t[0] ? "true" : "false", text: t[1] }));
      body.appendChild(tabs);
      const sec = el(doc, "div", { class: "carnet-rv-sec", role: "tabpanel", "data-rv-panel": state.tab });
      body.appendChild(sec);
      if (state.tab === "overview") renderOverview(sec, p);
      else if (state.tab === "evidence") renderEvidence(sec, p);
      else if (state.tab === "checklist") renderChecklist(sec, p);
      else if (state.tab === "questions") renderQuestions(sec, p);
      else if (state.tab === "freshness") renderFreshness(sec, p);
      else renderReport(sec, p);
    }

    function renderOverview(sec, p) {
      sec.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-notverdict", text: p.notVerdict }));
      sec.appendChild(statusSelect(p));
      sec.appendChild(el(doc, "dl", { class: "carnet-rv-meta" }, [
        el(doc, "dt", { text: "Contexte" }), el(doc, "dd", { id: "hq-carnet-rv-baseline-text", text: p.baseline.label }),
        el(doc, "dt", { text: "Créée" }), el(doc, "dd", { text: p.created }),
        el(doc, "dt", { text: "Mise à jour" }), el(doc, "dd", { text: p.updated + " · révision " + p.rev }),
        el(doc, "dt", { text: "Preuves" }), el(doc, "dd", { text: String(p.items.length) }),
        el(doc, "dt", { text: "Liste de contrôle" }), el(doc, "dd", { text: p.checkedCount + " point(s) coché(s) sur " + p.checklist.length }),
        el(doc, "dt", { text: "Questions ouvertes" }), el(doc, "dd", { text: String(p.openQuestions) }),
      ]));
      const edit = state.draft.edit;
      sec.appendChild(textInput("hq-carnet-rv-title-edit", edit.title !== undefined ? edit.title : p.title, R.LIMITS.title, "Titre", "edit.title"));
      sec.appendChild(textArea("hq-carnet-rv-note-edit", edit.note !== undefined ? edit.note : p.note, R.LIMITS.note, "Note", "edit.note", 3));
      sec.appendChild(el(doc, "div", { class: "carnet-hx-row" }, [mut("Enregistrer le titre et la note", { "data-rv": "save-meta", id: "btn-carnet-rv-save-meta" })]));
      if (state.confirmDelete) {
        sec.appendChild(el(doc, "div", { class: "carnet-banner", role: "alertdialog", id: "hq-carnet-rv-confirm", "aria-label": "Confirmer la suppression" }, [
          el(doc, "p", { class: "carnet-hx-warn", text: "Suppression définitive de « " + p.title + " » (révision " + state.confirmDelete.rev + "). Aucune restauration n'est possible depuis l'application." }),
          mut("Supprimer définitivement", { "data-rv": "delete-confirm", id: "btn-carnet-rv-delete-confirm", class: "carnet-btn carnet-danger" }),
          btn("Annuler", { "data-rv": "delete-cancel", id: "btn-carnet-rv-delete-cancel" }),
        ]));
      } else {
        sec.appendChild(el(doc, "div", { class: "carnet-hx-row" }, [mut("Supprimer…", { "data-rv": "delete-open", id: "btn-carnet-rv-delete" })]));
      }
    }

    function obsBlock(i) {
      const o = i.observation;
      const kids = [
        el(doc, "p", { class: "carnet-rv-obs-title" }, [el(doc, "strong", { text: "Observation actuelle" }), doc.createTextNode(" (calculée maintenant, jamais enregistrée)")]),
        el(doc, "p", { class: "carnet-rv-state", "data-rv-state": o.state, text: o.mark + " " + o.label + (o.reason ? " — " + o.reason : "") }),
      ];
      if (o.anomaly) kids.push(el(doc, "p", { class: "carnet-hx-warn", "data-rv": "anomaly", text: o.anomaly }));
      if (o.target) kids.push(el(doc, "p", { class: "carnet-rv-target", "data-rv": "portal-target", "data-rv-target": o.target.state, text: o.target.label + " — distinct de l'état du bloc" }));
      if (o.frozen) kids.push(el(doc, "p", { class: "hint", text: o.frozen }));
      if (o.currentDiffers) kids.push(el(doc, "p", { class: "hint", "data-rv": "current-differs", text: o.currentDiffers }));
      return el(doc, "div", { class: "carnet-rv-obs", "data-rv-obs": o.state }, kids);
    }

    function copyBlock(i) {
      const kids = [el(doc, "p", { class: "carnet-rv-copy-title" }, [el(doc, "strong", { text: "Copie capturée" }), doc.createTextNode(" — " + i.copyNote)])];
      if (i.copy.length) kids.push(el(doc, "ul", { class: "carnet-rv-copy-lines" }, i.copy.map((ln) => el(doc, "li", { text: ln }))));
      return el(doc, "div", { class: "carnet-rv-copy" }, kids);
    }

    function renderEvidence(sec, p) {
      if (!p.items.length) sec.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-noitems", text: "Aucune preuve. Ajoute-en depuis le cockpit (« Ajouter au dossier de revue ») ou depuis Preuves du carnet." }));
      const ul = el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-rv-items", "aria-label": "Preuves" });
      for (const i of p.items) {
        const kids = [
          el(doc, "p", { class: "carnet-ask-meta" }, [el(doc, "span", { class: "carnet-chip", text: i.kindLabel }), el(doc, "strong", { text: i.label }), el(doc, "span", { class: "hint", text: "ajoutée " + i.added + " · " + i.scopeLabel })]),
          copyBlock(i),
          obsBlock(i),
        ];
        for (const s of i.supersedes) kids.push(el(doc, "p", { class: "hint", "data-rv": "supersedes", text: "Remplace une recherche précédente (empreinte " + s.fingerprint + ", " + s.replaced + ")." }));
        const row = el(doc, "div", { class: "carnet-hx-row" });
        if (i.question) row.appendChild(btn("Rechercher dans Ask Carnet", { "data-rv": "ask-again", "data-id": i.id, "aria-label": "Relancer la recherche « " + i.question + " » dans Ask Carnet" }));
        if (i.sourceId && typeof host.openReader === "function") {
          // Reader = inspection only (read-only; reads the item's captured copy and, for a frozen scope, compares the seal). Not a mutation: never `aria-disabled` when offline-readonly.
          const rb = btn("Ouvrir dans le lecteur", { "data-rv": "open-reader", "data-id": i.id, "aria-label": "Ouvrir dans le lecteur : " + i.label });
          rb.addEventListener("click", () => host.openReader({ sourceId: i.sourceId, context: { kind: "review", id: state.pack.id, item_id: i.id }, trigger: rb }));
          row.appendChild(rb);
        }
        row.appendChild(mut("Retirer de la revue", { "data-rv": "item-remove", "data-id": i.id, "aria-label": "Retirer « " + i.label + " » de la revue" }));
        kids.push(row);
        ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-rv-item", "data-rv-item": i.id, "data-rv-kind": i.kind, "data-rv-state": i.observation.state }, kids));
      }
      sec.appendChild(ul);
    }

    function refsNode(refs) {
      if (!refs.length) return null;
      return el(doc, "ul", { class: "carnet-rv-refs", "aria-label": "Preuves liées" }, refs.map((r) => el(doc, "li", { "data-rv-dangling": r.dangling ? "1" : null, text: r.dangling ? "Preuve retirée (référence conservée)" : r.label })));
    }

    function refPicker(prefix, selected) {
      const p = state.pack;
      if (!p.items.length) return null;
      const set = el(doc, "fieldset", { class: "carnet-rv-picker" }, [el(doc, "legend", { text: "Preuves liées (facultatif)" })]);
      for (const i of p.items.slice(0, 40)) {
        const id = prefix + i.id;
        const cb = el(doc, "input", { type: "checkbox", id, "data-rv-ref": i.id, checked: selected.includes(i.id) ? "" : null });
        cb.checked = selected.includes(i.id);
        set.appendChild(el(doc, "div", { class: "carnet-hx-pick" }, [cb, el(doc, "label", { for: id, text: i.kindLabel + " — " + i.label })]));
      }
      return set;
    }

    function renderChecklist(sec, p) {
      sec.appendChild(el(doc, "p", { class: "hint", text: "Chaque point est coché par toi, jamais déduit des preuves. " + p.checkedCount + " point(s) coché(s) sur " + p.checklist.length + "." }));
      const ul = el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-rv-checks", "aria-label": "Liste de contrôle" });
      for (const c of p.checklist) {
        const cb = el(doc, "input", { type: "checkbox", id: "hq-carnet-rv-c-" + c.id, "data-rv-check": c.id, "aria-disabled": state.busy || !online() || p.readOnly ? "true" : null });
        cb.checked = c.checked;
        ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-rv-check", "data-rv-check-row": c.id, "data-checked": c.checked ? "1" : "0" }, [
          el(doc, "div", { class: "carnet-hx-pick" }, [cb, el(doc, "label", { for: "hq-carnet-rv-c-" + c.id, text: c.text }), el(doc, "span", { class: "hint", text: c.checked ? "Cochée" : "Non cochée" })]),
          refsNode(c.refs),
          mut("Retirer", { "data-rv": "check-remove", "data-id": c.id, "aria-label": "Retirer le point « " + c.text + " »" }),
        ]));
      }
      sec.appendChild(ul);
      if (p.atLimits.checklist) sec.appendChild(el(doc, "p", { class: "hint", text: "Limite atteinte : " + R.LIMITS.checklist + " points." }));
      sec.appendChild(textInput("hq-carnet-rv-new-check", state.draft.check, R.LIMITS.check, "Nouveau point de contrôle", "check"));
      const cp = refPicker("hq-carnet-rv-newcheck-", state.draft.checkRefs || []);
      if (cp) sec.appendChild(cp);
      sec.appendChild(el(doc, "div", { class: "carnet-hx-row" }, [mut("Ajouter le point", { "data-rv": "check-add", id: "btn-carnet-rv-check-add" })]));
    }

    function renderQuestions(sec, p) {
      sec.appendChild(el(doc, "p", { class: "hint", text: "Une question n'est « résolue » que si tu la marques ainsi ; rien ne la résout automatiquement." }));
      const ul = el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-rv-questions", "aria-label": "Questions" });
      for (const q of p.questions) {
        const res = state.draft.resolution[q.id] !== undefined ? state.draft.resolution[q.id] : q.note;
        const kids = [
          el(doc, "p", { class: "carnet-ask-meta" }, [el(doc, "span", { class: "carnet-chip", "data-rv-qstate": q.state, text: q.stateLabel }), el(doc, "span", { text: q.text })]),
          refsNode(q.refs),
          textArea("hq-carnet-rv-res-" + q.id, res, R.LIMITS.resolution, "Note de résolution (facultative)", "resolution." + q.id, 2),
        ];
        const row = el(doc, "div", { class: "carnet-hx-row" }, [
          mut(q.state === "open" ? "Marquer comme résolue" : "Rouvrir", { "data-rv": "q-toggle", "data-id": q.id }),
          mut("Enregistrer la note", { "data-rv": "q-note", "data-id": q.id }),
          btn("Rechercher dans Ask Carnet", { "data-rv": "q-ask", "data-id": q.id, "aria-label": "Rechercher « " + q.text.slice(0, 60) + " » dans Ask Carnet" }),
          mut("Retirer", { "data-rv": "q-remove", "data-id": q.id, "aria-label": "Retirer la question" }),
        ]);
        kids.push(row);
        ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-rv-question", "data-rv-question": q.id, "data-state": q.state }, kids));
      }
      sec.appendChild(ul);
      sec.appendChild(textArea("hq-carnet-rv-new-q", state.draft.question, R.LIMITS.question, "Nouvelle question", "question", 2));
      const qp = refPicker("hq-carnet-rv-newq-", state.draft.questionRefs || []);
      if (qp) sec.appendChild(qp);
      sec.appendChild(el(doc, "div", { class: "carnet-hx-row" }, [mut("Ajouter la question", { "data-rv": "q-add", id: "btn-carnet-rv-q-add" })]));
    }

    function renderFreshness(sec, p) {
      sec.appendChild(el(doc, "p", { class: "hint", text: "La fraîcheur compare chaque preuve à ce qui existe maintenant. Elle ne modifie jamais ce qui a été revu et ne dit pas si un changement est bon ou mauvais." }));
      sec.appendChild(mut(state.freshBusy ? "Vérification…" : "Vérifier maintenant", { "data-rv": "refresh", id: "btn-carnet-rv-refresh", "aria-disabled": state.freshBusy ? "true" : null }));
      if (!p.freshnessCounts) return sec.appendChild(el(doc, "p", { class: "hint", role: "status", text: state.freshBusy ? MSG.loading : "Fraîcheur non observée." }));
      sec.appendChild(el(doc, "ul", { class: "carnet-rv-counts", id: "hq-carnet-rv-counts", "aria-label": "Fraîcheur des preuves" }, p.freshnessCounts.map((c) => el(doc, "li", { "data-rv-count": c.state, text: c.mark + " " + c.label + " : " + c.n }))));
      const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Détail" });
      for (const i of p.items) ul.appendChild(el(doc, "li", { class: "carnet-hx-item", "data-rv-state": i.observation.state }, [el(doc, "span", { text: i.kindLabel + " — " + i.label }), obsBlock(i)]));
      sec.appendChild(ul);
    }

    function renderReport(sec, p) {
      sec.appendChild(el(doc, "p", { class: "hint", text: "Le rapport et le dossier exporté reprennent la revue telle qu'elle est enregistrée, avec l'observation de fraîcheur faite au moment de la génération. Aucune conclusion n'est ajoutée." }));
      sec.appendChild(el(doc, "div", { class: "carnet-hx-row" }, [
        btn("Ajouter la revue au rapport", { "data-rv": "report", id: "btn-carnet-rv-report" }),
        el(doc, "a", { class: "carnet-btn", id: "lnk-carnet-rv-export", href: "/api/carnet/review-export/" + encodeURIComponent(p.id), download: "carnet-review-" + p.id + "-r" + p.rev + ".zip", text: "Télécharger le dossier de revue (ZIP)" }),
      ]));
      sec.appendChild(el(doc, "p", { class: "hint", text: "Dossier de revue : review.json, review.md et manifest.json. Les fichiers référencés (images, dessins) ne sont pas inclus." }));
      sec.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rv-seal", text: "Sceau : " + p.seal }));
    }

    // ------------------------------------------------------------ events

    function setDraft(path, value) {
      const parts = path.split(".");
      let o = state.draft;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      o[parts[parts.length - 1]] = value;
    }

    function onInput(ev) {
      const t = ev.target;
      const key = t && t.getAttribute ? t.getAttribute("data-rv-draft") : null;
      if (key) setDraft(key, t.value);
    }

    function pickedRefs(prefixId) {
      return Array.prototype.map.call(dlg.querySelectorAll('input[data-rv-ref][id^="' + prefixId + '"]:checked'), (n) => n.getAttribute("data-rv-ref"));
    }

    function onChange(ev) {
      const t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.hasAttribute("data-rv-status")) {
        const b = R.updateBody(state.raw, { status: t.value });
        act(b);
      } else if (t.hasAttribute("data-rv-check")) {
        if (t.getAttribute("aria-disabled") === "true") {
          t.checked = !t.checked;
          return;
        }
        act(R.checkUpdateBody(state.raw, t.getAttribute("data-rv-check"), { checked: !!t.checked }));
      } else if (t.hasAttribute("data-rv-ref")) {
        const id = t.id || "";
        const key = id.startsWith("hq-carnet-rv-newcheck-") ? "checkRefs" : id.startsWith("hq-carnet-rv-newq-") ? "questionRefs" : null;
        if (key) state.draft[key] = pickedRefs(key === "checkRefs" ? "hq-carnet-rv-newcheck-" : "hq-carnet-rv-newq-");
      }
    }

    async function pickPack(id) {
      const ok = await loadPack(id);
      if (ok && state.adding) {
        if (state.adding.spec.kind === "ask_result" && state.pack.items.some((i) => i.replaceable && i.question === state.adding.spec.question)) {
          state.adding.step = "mode";
          render();
        } else await addNew();
      }
    }

    async function addNew(replaceId) {
      const a = state.adding;
      if (!a || !state.raw) return;
      const bodyObj = replaceId ? R.itemReplaceBody(state.raw, replaceId, a.spec) : R.itemAddBody(state.raw, a.spec);
      const title = state.pack.title;
      const res = await act(bodyObj, () => {
        state.adding = null;
      });
      if (res) {
        if (typeof host.flash === "function") host.flash(MSG.added + " « " + title + " »", 2500);
        say(MSG.added + " « " + title + " ».");
        if (host.afterAdd) host.afterAdd();
        close(true);
      } else if (state.open) {
        const info = state.error;
        a.step = "choose";
        state.error = info;
        render();
      }
    }

    async function createFromForm(forAdding) {
      const pid = state.projectId;
      const baseId = state.draft.baseline || null;
      const attempt = host.rng ? R.createAttempt(state.pendingCreate, pid, state.draft.title, state.draft.note, baseId, () => R.hex32(host.rng())) : null;
      const bodyObj = R.createBody(pid, state.draft.title, state.draft.note, attempt ? attempt.rid : null, baseId);
      if (!bodyObj) {
        state.error = "Titre requis (" + R.LIMITS.title + " caractères au plus).";
        render();
        return;
      }
      state.pendingCreate = attempt;  // kept until the outcome is KNOWN: an uncertain failure retries with the same id
      state.definiteError = false;
      const res = await act(bodyObj);
      if (!res && state.definiteError) state.pendingCreate = null;  // the server answered with a refusal: nothing was created
      if (res && res.review) {
        state.pendingCreate = null;
        remember(res.review.id);
        resetDraft();
        state.tab = "overview";
        if (forAdding && state.adding) await addNew();
        else render();
      }
    }

    function askAgain(question, scope) {
      if (typeof host.openAsk !== "function") return;
      close(false);
      host.openAsk(question, scope || null);
    }

    function onClick(ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-rv], [data-rv-tab], #btn-carnet-rv-close") : null;
      if (!t) return;
      if (t.id === "btn-carnet-rv-close") return close(true);
      if (t.hasAttribute("data-rv-tab")) {
        state.tab = t.getAttribute("data-rv-tab");
        render();
        return;
      }
      if (t.getAttribute("aria-disabled") === "true" && t.getAttribute("data-rv") !== "refresh") return;
      const a = t.getAttribute("data-rv");
      const id = t.getAttribute("data-id");
      const raw = state.raw;
      if (a === "open") loadPack(id);
      else if (a === "back") {
        state.mode = "list";
        state.pack = null;
        state.raw = null;
        state.fresh = null;
        state.confirmDelete = null;
        state.notice = "";
        render();
        loadList();
      } else if (a === "pick") pickPack(id);
      else if (a === "add-new") addNew();
      else if (a === "add-replace") addNew(id);
      else if (a === "add-cancel") close(true);
      else if (a === "save-meta") {
        const e = state.draft.edit;
        const f = {};
        if (e.title !== undefined) f.title = e.title;
        if (e.note !== undefined) f.note = e.note;
        act(R.updateBody(raw, f), () => {
          state.draft.edit = {};
        });
      } else if (a === "delete-open") {
        state.confirmDelete = { rev: raw.rev };
        render();
        const c = doc.getElementById("btn-carnet-rv-delete-confirm");
        if (c) c.focus({ preventScroll: true });
      } else if (a === "delete-cancel") {
        state.confirmDelete = null;
        render();
      } else if (a === "delete-confirm") {
        const rev = state.confirmDelete ? state.confirmDelete.rev : null;
        act(R.deleteBody(raw, rev), () => {
          state.confirmDelete = null;
        }).then((res) => {
          if (res && res.deleted) {
            state.pack = null;
            state.raw = null;
            state.mode = "list";
            state.notice = "";
            say(MSG.deleted);
            if (host.flash) host.flash(MSG.deleted, 2500);
            render();
            loadList();
          }
        });
      } else if (a === "item-remove") act(R.itemRemoveBody(raw, id));
      else if (a === "ask-again") {
        const it = state.pack.items.find((i) => i.id === id);
        if (it && it.question) askAgain(it.question, it.askScope);
      } else if (a === "check-add") {
        const refs = pickedRefs("hq-carnet-rv-newcheck-");
        act(R.checkAddBody(raw, state.draft.check, refs), () => {
          state.draft.check = "";
          state.draft.checkRefs = [];
        });
      } else if (a === "check-remove") act(R.checkRemoveBody(raw, id));
      else if (a === "q-add") {
        const refs = pickedRefs("hq-carnet-rv-newq-");
        act(R.questionAddBody(raw, state.draft.question, refs), () => {
          state.draft.question = "";
          state.draft.questionRefs = [];
        });
      } else if (a === "q-toggle") {
        const q = state.pack.questions.find((x) => x.id === id);
        if (q) act(R.questionUpdateBody(raw, id, { state: q.state === "open" ? "resolved" : "open" }));
      } else if (a === "q-note") {
        const v = state.draft.resolution[id];
        act(R.questionUpdateBody(raw, id, { resolution_note: v === undefined ? "" : v }), () => {
          delete state.draft.resolution[id];
        });
      } else if (a === "q-ask") {
        const q = state.pack.questions.find((x) => x.id === id);
        if (q) askAgain(q.text.slice(0, 300), null);
      } else if (a === "q-remove") act(R.questionRemoveBody(raw, id));
      else if (a === "refresh") loadFreshness();
      else if (a === "report") {
        if (host.addToReport && host.addToReport({ kind: "review_pack", review_id: raw.id, label: "Dossier de revue — " + state.pack.title.slice(0, 60) })) host.flash(MSG.reportAdded, 2500);
      }
    }

    function onSubmit(ev) {
      ev.preventDefault();
      if (state.busy) return;
      createFromForm(!!state.adding);
    }

    return {
      open, close, isOpen: () => state.open, addItem, el: () => dlg,
      openPack: (id, opener) => {
        open(opener || null, null);
        return loadPack(id);
      },
    };
  }

  return { MSG, mount };
});
