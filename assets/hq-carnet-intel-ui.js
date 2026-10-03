/* Transfert HQ — Carnet Phase 5: Engineering Intelligence UI (cockpit, decision trail, measurement trends, "what changed", snapshots).
 *
 * NOTHING here is visible on the default paper. One modal dialog (#hq-carnet-intel) is created lazily the first time it is opened
 * ("Cockpit" in the library header or the editor's tools tray). Every number comes from the server (GET /api/carnet?cockpit=…,
 * ?snapshots=…, ?diff=…): this file holds NO second project state, derives nothing from prose, infers no status / author / conclusion
 * and never converts a unit. Filters are client-side views over the response already loaded.
 *
 * "Since last review" compares against an EXPLICIT baseline only (a checkpoint or a snapshot). A date resolves to the nearest surviving
 * baseline at or before it and the resolved baseline is shown BEFORE any comparison. The on-page overlay is display-only: it sets
 * attributes on blocks that already exist and never touches the draft, the revision or the selection.
 *
 * Nothing is stored in the browser. DOM is built with createElement / createElementNS / textContent only. No HTML string injection,
 * no dynamic code evaluation. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetIntelUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const I = node ? require("./hq-carnet-intel.js") : global.HqCarnetIntel;
  const RV = node ? require("./hq-carnet-reviews.js") : global.HqCarnetReviews;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const TABS = [
    ["overview", "Vue d'ensemble"],
    ["decisions", "Décisions"],
    ["measures", "Mesures"],
    ["changes", "Changements"],
    ["snaps", "Jalons"],
  ];
  const ACTIVITY_SHOWN = 20;
  const KIND_WORD = { page: "Note", decision: "Décision", measure: "Mesure", checkpoint: "Point de restauration" };
  const MSG = {
    title: "Cockpit du projet",
    loading: "Chargement…",
    failed: "Impossible de charger le cockpit.",
    noProject: "Choisis un projet.",
    empty: "Ce projet ne contient aucune note.",
    noDecisions: "Aucune décision dans ce projet.",
    noMeasures: "Aucune mesure dans ce projet.",
    noMatch: "Aucun résultat avec ces filtres.",
    utc: "Heures affichées en UTC.",
    pinned: "Jalon figé — lecture seule",
    needProject: "Un jalon fige un projet : choisis un projet (pas « Sans projet »).",
    created: "Jalon créé.",
    replayed: "Jalon déjà créé par cette requête (rien de nouveau n'a été écrit).",
    creating: "Création du jalon (calcul des empreintes)…",
    gone: "Source introuvable.",
    draft: "Cette page contient un brouillon local non enregistré : la comparaison porte sur la dernière version enregistrée.",
    noPage: "Ouvre une page pour la comparer à un checkpoint.",
    resolveFirst: "Choisis une baseline avant de comparer.",
    overlayOn: "Changements affichés sur la page. Rien n'a été modifié.",
    overlayOff: "Changements masqués.",
    reportAdded: "Synthèse ajoutée au rapport.",
    notText: "Ce contenu n'a pas d'identifiants de bloc stables : seul le texte est comparé, sans surcouche.",
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

  function sv(doc, tag, attrs, kids) {
    const n = doc.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, String(attrs[k]));
    if (kids) for (const c of kids) if (c) n.appendChild(c);
    return n;
  }

  function errText(err) {
    const d = err && isObj(err.data) ? err.data : {};
    return String(d.error || (err && err.message) || "Erreur").slice(0, 200);
  }

  function errCode(err) {
    const d = err && isObj(err.data) ? err.data : {};
    return typeof d.code === "string" ? d.code : "";
  }

  function mount(host) {
    const doc = host.doc;
    const state = {
      open: false, tab: "overview", opener: null, project: null, token: 0,
      cockpit: null, loading: false, error: "", snapView: null, verify: null,
      filters: { dec: { query: "", page: "", from: "", to: "", evidence: false }, mes: { verdict: "all", unit: "", query: "", from: "", to: "" } },
      sheet: null, showAllActivity: false,
      snaps: null, snapsError: "", snapBusy: false, snapReq: null, snapResult: null, snapForm: { label: "", note: "" },
      base: { kind: "latest_checkpoint", id: "", date: "", target: "" }, baselines: null, baselinesError: "", resolved: null, diff: null, diffError: "", diffBusy: false,
    };
    let dlg = null;
    let body = null;
    let live = null;
    let overlay = null;

    // ------------------------------------------------------------ shell

    function build() {
      live = el(doc, "p", { id: "hq-carnet-ix-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      const tabs = el(doc, "div", { class: "carnet-hx-tabs", role: "group", "aria-label": "Sections du cockpit" });
      for (const [key, label] of TABS) tabs.appendChild(el(doc, "button", { type: "button", class: "carnet-chip carnet-hx-tab", "data-ix-tab": key, "aria-pressed": "false", text: label }));
      body = el(doc, "div", { class: "carnet-hx-body carnet-ix-body" });
      const close = el(doc, "button", { type: "button", id: "btn-carnet-ix-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-ix-title", text: MSG.title }), close]);
      dlg = el(doc, "div", { id: "hq-carnet-intel", class: "carnet-hx carnet-ix", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-ix-title", tabindex: "-1", hidden: "" }, [head, tabs, live, body]);
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("input", onInput);
      dlg.addEventListener("change", onInput);
      dlg.addEventListener("keydown", onKey);
      host.root.appendChild(dlg);
    }

    function say(text) {
      if (live) live.textContent = text || "";
    }

    function focusables(scope) {
      return Array.prototype.filter.call((scope || dlg).querySelectorAll("button, input, select, textarea, summary, a[href], [tabindex]"), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
    }

    function onKey(ev) {
      const tg = ev.target;
      if ((ev.key === "Enter" || ev.key === " ") && tg && tg.getAttribute && tg.getAttribute("role") === "link" && tg.getAttribute("data-ix")) {
        ev.preventDefault();
        onClick({ target: tg });
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.sheet) closeSheet(true);
        else close(true);
        return;
      }
      if (ev.key !== "Tab") return;
      const scope = state.sheet ? dlg.querySelector(".carnet-ix-sheet") || dlg : dlg;
      const list = focusables(scope);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (ev.shiftKey && (doc.activeElement === first || !scope.contains(doc.activeElement))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (doc.activeElement === last || !scope.contains(doc.activeElement))) {
        ev.preventDefault();
        first.focus();
      }
    }

    function initialProject() {
      const list = host.projects() || [];
      const want = host.currentProjectId ? host.currentProjectId() : null;
      if (want && list.some((p) => p.id === want)) return want;
      return list.length ? list[0].id : "none";
    }

    function open(tab, opener, projectId) {
      if (!dlg) build();
      state.opener = opener || doc.activeElement || null;
      state.open = true;
      state.sheet = null;
      state.snapView = null;
      state.verify = null;
      state.diff = null;
      state.diffError = "";
      state.resolved = null;
      state.snapResult = null;
      state.project = projectId || initialProject();
      dlg.hidden = false;
      setTab(tab || "overview", true);
      loadAll();
      const f = focusables().find((n) => n.id !== "btn-carnet-ix-close");
      (f || dlg).focus({ preventScroll: true });
    }

    function close(refocus) {
      if (!dlg || !state.open) return;
      state.open = false;
      state.sheet = null;
      state.token += 1;
      dlg.hidden = true;
      say("");
      const o = state.opener;
      state.opener = null;
      if (refocus && o && typeof o.focus === "function" && doc.contains(o)) o.focus({ preventScroll: true });
      if (typeof host.onClose === "function") host.onClose(!!refocus);
    }

    function setTab(tab, silent) {
      state.tab = tab;
      for (const b of dlg.querySelectorAll("[data-ix-tab]")) b.setAttribute("aria-pressed", b.getAttribute("data-ix-tab") === tab ? "true" : "false");
      if (!silent) render();
      else render();
      if (tab === "snaps" && state.snaps === null) loadSnaps();
      if (tab === "changes" && state.baselines === null) loadBaselines();
    }

    // ------------------------------------------------------------ data (server is the only authority)

    function pidParam() {
      return state.project === "none" ? "none" : state.project;
    }

    async function loadAll() {
      state.cockpit = null;
      state.snaps = null;
      state.baselines = null;
      state.error = "";
      state.loading = true;
      render();
      const tok = ++state.token;
      try {
        const r = await host.api.get("/api/carnet?cockpit=" + encodeURIComponent(pidParam()));
        if (tok !== state.token) return;
        state.cockpit = r;
        state.error = "";
      } catch (err) {
        if (tok !== state.token) return;
        state.cockpit = null;
        state.error = errText(err);
      }
      state.loading = false;
      if (state.open) render();
      if (state.open && state.tab === "snaps") loadSnaps();
      if (state.open && state.tab === "changes") loadBaselines();
    }

    async function loadSnaps() {
      if (state.project === "none") {
        state.snaps = { snapshots: [] };
        return render();
      }
      const tok = state.token;
      try {
        const r = await host.api.get("/api/carnet?snapshots=1&project=" + encodeURIComponent(state.project));
        if (tok !== state.token) return;
        state.snaps = r;
        state.snapsError = "";
      } catch (err) {
        if (tok !== state.token) return;
        state.snaps = { snapshots: [] };
        state.snapsError = errText(err);
      }
      if (state.open && (state.tab === "snaps" || state.tab === "changes")) render();
    }

    async function loadBaselines() {
      const tok = state.token;
      const cur = host.currentPage ? host.currentPage() : null;
      const q = ["baselines=1"];
      if (state.project !== "none") q.push("project=" + encodeURIComponent(state.project));
      if (cur) q.push("page=" + encodeURIComponent(cur.id));
      if (q.length === 1) {
        state.baselines = { checkpoints: [], snapshots: [] };
        return render();
      }
      try {
        const r = await host.api.get("/api/carnet?" + q.join("&"));
        if (tok !== state.token) return;
        state.baselines = r;
        state.baselinesError = "";
      } catch (err) {
        if (tok !== state.token) return;
        state.baselines = { checkpoints: [], snapshots: [] };
        state.baselinesError = errText(err);
      }
      if (state.open && state.tab === "changes") render();
    }

    function view() {
      return state.snapView || state.cockpit;
    }

    // ------------------------------------------------------------ rendering

    function render() {
      if (!dlg) return;
      const keepId = doc.activeElement && dlg.contains(doc.activeElement) && doc.activeElement.id ? doc.activeElement.id : "";
      body.textContent = "";
      body.appendChild(projectBar());
      if (state.snapView) body.appendChild(pinnedBanner());
      if (state.loading) body.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      else if (state.error) body.appendChild(failure(state.error, "retry"));
      else if (state.tab === "overview") renderOverview();
      else if (state.tab === "decisions") renderDecisions();
      else if (state.tab === "measures") renderMeasures();
      else if (state.tab === "changes") renderChanges();
      else renderSnaps();
      if (state.sheet) body.appendChild(sheetNode());
      const again = keepId ? dlg.querySelector("#" + keepId) : null;
      if (again && !dlg.contains(doc.activeElement)) again.focus({ preventScroll: true });
      if (state.open && !dlg.contains(doc.activeElement)) dlg.focus({ preventScroll: true });
    }

    function failure(text, act) {
      const kids = [el(doc, "p", { text: MSG.failed + " " + text })];
      if (act) kids.push(btn("Réessayer", { "data-ix": act }));
      return el(doc, "div", { class: "carnet-banner carnet-ix-error", role: "alert" }, kids);
    }

    /** "Ajouter au dossier de revue": identity only (the server seals); hidden when the host has no review store. */
    function reviewBtn(kind, ident, label) {
      if (typeof host.addToReview !== "function" || !RV) return null;
      const attrs = { "data-ix": "review", "data-rkind": kind, "data-rlabel": String(label || "").slice(0, 120), class: "carnet-small carnet-hx-btn carnet-ix-review-btn", "aria-label": "Ajouter au dossier de revue : " + String(label || kind).slice(0, 80) };
      for (const k of Object.keys(ident || {})) attrs["data-r" + k] = ident[k];
      return btn("Ajouter au dossier de revue", attrs);
    }

    function btn(text, attrs) {
      return el(doc, "button", Object.assign({ type: "button", class: "carnet-small carnet-hx-btn", text }, attrs || {}));
    }

    function projectBar() {
      const sel = el(doc, "select", { id: "hq-carnet-ix-project", class: "carnet-input", "aria-label": "Projet" });
      for (const p of host.projects() || []) sel.appendChild(el(doc, "option", { value: p.id, text: p.name }));
      sel.appendChild(el(doc, "option", { value: "none", text: "Sans projet" }));
      sel.value = state.project;
      const row = el(doc, "div", { class: "carnet-panel-row carnet-ix-projectbar" }, [
        el(doc, "label", { class: "carnet-hx-field" }, [el(doc, "span", { text: "Projet" }), sel]),
        btn("Actualiser", { "data-ix": "refresh", id: "btn-carnet-ix-refresh" }),
      ]);
      return row;
    }

    function pinnedBanner() {
      const s = state.snapView.snapshot;
      const item = I.reportItem(state.snapView);
      return el(doc, "div", { class: "carnet-banner carnet-ix-pinned", id: "hq-carnet-ix-pinned", role: "status" }, [
        el(doc, "p", { class: "carnet-banner-msg", text: MSG.pinned + " — « " + s.label + " » — " + I.fmtDate(s.created_at) + (s.integrity !== "ok" ? " — " + I.INTEGRITY_LABEL[s.integrity] : "") }),
        s.note ? el(doc, "p", { class: "hint", text: s.note }) : null,
        el(doc, "div", { class: "carnet-banner-actions" }, [
          btn("Revenir à l'état actuel", { "data-ix": "unpin", id: "btn-carnet-ix-unpin" }),
          btn("Vérifier les références", { "data-ix": "verify", id: "btn-carnet-ix-verify" }),
          s.integrity === "ok" ? btn("Comparer à l'actuel", { "data-ix": "snap-diff", "data-id": s.id }) : null,
          item ? btn("Ajouter au rapport", { "data-ix": "report" }) : null,
        ]),
        state.verify ? verifyNode() : null,
      ]);
    }

    function verifyNode() {
      const v = I.verifyModel(state.verify);
      if (!v) return null;
      const list = el(doc, "ul", { class: "carnet-hx-list", "aria-label": "Références du jalon" });
      for (const r of v.rows) list.appendChild(el(doc, "li", { class: "carnet-hx-item", "data-ix-verify": r.status }, [el(doc, "span", { class: "carnet-hx-event-text", text: r.ref + " — " + r.label })]));
      return el(doc, "section", { class: "carnet-panel", id: "hq-carnet-ix-verify", "aria-label": "Vérification des références" }, [
        el(doc, "h4", { text: "Références : " + v.integrityLabel }),
        el(doc, "p", { role: "status", class: v.drift ? "carnet-hx-warn" : "hint", text: v.summary }),
        list,
      ]);
    }

    // ---- overview

    function tileButton(t) {
      return el(doc, "button", { type: "button", class: "carnet-ix-tile", "data-ix": "tab", "data-tab": t.tab, "data-tile": t.key, "aria-label": t.label + " : " + t.value + (t.note ? " (" + t.note + ")" : "") }, [
        el(doc, "span", { class: "carnet-ix-tile-n", text: String(t.value) }),
        el(doc, "span", { class: "carnet-ix-tile-l", text: t.label }),
        t.note ? el(doc, "span", { class: "carnet-ix-tile-note", text: t.note }) : null,
      ]);
    }

    function linkBtn(text, t, label) {
      return el(doc, "button", { type: "button", class: "carnet-small carnet-ix-link", "data-ix": "goto", "data-page": t.pageId, "data-block": t.blockId || "", "aria-label": label || "Ouvrir : " + text, text });
    }

    function renderOverview() {
      const r = view();
      const m = I.cockpitModel(r);
      if (!m) return;
      if (m.empty) body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ix-empty", text: MSG.empty }));
      const tiles = el(doc, "div", { class: "carnet-ix-tiles", id: "hq-carnet-ix-tiles" });
      for (const t of m.tiles) tiles.appendChild(tileButton(t));
      body.appendChild(tiles);
      if (m.outOfTolerance) {
        body.appendChild(el(doc, "div", { class: "carnet-banner", role: "status", id: "hq-carnet-ix-oot" }, [
          el(doc, "p", { class: "carnet-hx-warn", text: m.outOfTolerance + " mesure" + (m.outOfTolerance > 1 ? "s" : "") + " hors tolérance." }),
          btn("Voir les mesures hors tolérance", { "data-ix": "oot", id: "btn-carnet-ix-oot" }),
        ]));
      }
      for (const n of m.notes) body.appendChild(el(doc, "p", { class: "hint carnet-ix-note", text: n }));
      const sections = [];
      sections.push(section("Notes récentes", [list(r.recent_notes.slice(0, 10).map((n) => row([linkBtn(n.title || "(sans titre)", { pageId: n.page_id, blockId: null }), el(doc, "span", { class: "hint", text: I.fmtDate(n.updated_at) })]))), r.recent_notes.length ? null : el(doc, "p", { class: "hint", text: "Aucune note." })]));
      const act = r.activity || [];
      const shown = state.showAllActivity ? act : act.slice(0, ACTIVITY_SHOWN);
      const actNodes = shown.map((a) => row([
        a.page_id ? linkBtn((KIND_WORD[a.kind] || a.kind) + " — " + (a.label || "(sans titre)"), { pageId: a.page_id, blockId: a.block_id || null }) : el(doc, "span", { text: (KIND_WORD[a.kind] || a.kind) + " — " + a.label }),
        el(doc, "span", { class: "hint", text: I.fmtDate(a.at) }),
      ]));
      sections.push(section("Activité récente", [list(actNodes), act.length > ACTIVITY_SHOWN && !state.showAllActivity ? btn("Afficher les " + act.length + " éléments", { "data-ix": "more-activity" }) : null, act.length ? el(doc, "p", { class: "hint", text: MSG.utc }) : el(doc, "p", { class: "hint", text: "Aucune activité." })]));
      const refs = I.refRows(r);
      sections.push(section("Croquis, sources et fichiers référencés", [
        refs.length ? list(refs.map(refNode)) : el(doc, "p", { class: "hint", text: "Aucune référence." }),
      ]));
      for (const s of sections) body.appendChild(s);
      const item = I.reportItem(r);
      if (item && !state.snapView) body.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [btn("Ajouter la synthèse au rapport", { "data-ix": "report", id: "btn-carnet-ix-report" })]));
      if (state.project && state.project !== "none") body.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [reviewBtn("overview", {}, "Vue d'ensemble du projet")]));
    }

    function refNode(r) {
      const kids = [el(doc, "span", { class: "carnet-hx-event-text", text: r.kindLabel + " — " + r.label })];
      kids.push(el(doc, "span", { class: "carnet-ix-state", "data-state": r.state, text: r.stateLabel + (r.archived ? " (archivée)" : "") }));
      kids.push(el(doc, "span", { class: "hint", text: r.count + " référence" + (r.count > 1 ? "s" : "") }));
      if (r.first) kids.push(linkBtn("Ouvrir la source", r.first, "Ouvrir la source de " + r.label + " dans « " + r.firstTitle + " »"));
      if (r.kind === "drawing" || r.kind === "source") kids.push(reviewBtn(r.kind, r.kind === "drawing" ? { stem: r.id } : { edition: r.id }, r.label));
      return row(kids);
    }

    function section(title, kids) {
      return el(doc, "section", { class: "carnet-panel carnet-hx-sec" }, [el(doc, "h4", { text: title })].concat(kids.filter(Boolean)));
    }

    function list(items) {
      return el(doc, "ul", { class: "carnet-hx-list" }, items);
    }

    function row(kids) {
      return el(doc, "li", { class: "carnet-hx-event" }, kids);
    }

    // ---- filters (desktop inline; mobile bottom sheet)

    function narrow() {
      try {
        return !!(global.matchMedia && global.matchMedia("(max-width: 700px)").matches);
      } catch (_) {
        return false;
      }
    }

    function field(label, input) {
      return el(doc, "label", { class: "carnet-hx-field" }, [el(doc, "span", { text: label }), input]);
    }

    function decFilters() {
      const f = state.filters.dec;
      const r = view();
      const pages = [];
      const seen = new Set();
      for (const d of r ? r.decisions : []) if (!seen.has(d.page_id)) (seen.add(d.page_id), pages.push(d));
      const page = el(doc, "select", { id: "hq-carnet-ix-dpage", class: "carnet-input", "data-ix-filter": "dec.page" }, [el(doc, "option", { value: "", text: "Toutes les notes" })]);
      for (const d of pages) page.appendChild(el(doc, "option", { value: d.page_id, text: d.page_title }));
      page.value = f.page;
      const ev = el(doc, "input", { type: "checkbox", id: "hq-carnet-ix-dev", "data-ix-filter": "dec.evidence" });
      ev.checked = !!f.evidence;
      return el(doc, "div", { class: "carnet-ix-filters", id: "hq-carnet-ix-dfilters" }, [
        field("Rechercher", el(doc, "input", { type: "search", id: "hq-carnet-ix-dq", class: "carnet-input", "data-ix-filter": "dec.query", value: f.query, "aria-label": "Rechercher dans les décisions", autocomplete: "off" })),
        field("Note", page),
        field("Du", el(doc, "input", { type: "date", id: "hq-carnet-ix-dfrom", class: "carnet-input", "data-ix-filter": "dec.from", value: f.from })),
        field("Au", el(doc, "input", { type: "date", id: "hq-carnet-ix-dto", class: "carnet-input", "data-ix-filter": "dec.to", value: f.to })),
        el(doc, "label", { class: "carnet-hx-check" }, [ev, el(doc, "span", { text: "Avec preuves liées" })]),
        btn("Réinitialiser", { "data-ix": "reset-dec" }),
      ]);
    }

    function mesFilters() {
      const f = state.filters.mes;
      const r = view();
      const verdict = el(doc, "select", { id: "hq-carnet-ix-mverdict", class: "carnet-input", "data-ix-filter": "mes.verdict" }, [
        el(doc, "option", { value: "all", text: "Tous les verdicts" }),
        el(doc, "option", { value: "out", text: "Hors tolérance" }),
        el(doc, "option", { value: "in", text: "Dans la tolérance" }),
        el(doc, "option", { value: "none", text: "Sans tolérance" }),
        el(doc, "option", { value: "incompatible", text: "Unités incompatibles" }),
      ]);
      verdict.value = f.verdict;
      const unit = el(doc, "select", { id: "hq-carnet-ix-munit", class: "carnet-input", "data-ix-filter": "mes.unit" }, [el(doc, "option", { value: "", text: "Toutes les unités" })]);
      for (const u of I.unitsOf(r ? r.series : [])) unit.appendChild(el(doc, "option", { value: u, text: u || "(sans unité)" }));
      unit.value = f.unit;
      return el(doc, "div", { class: "carnet-ix-filters", id: "hq-carnet-ix-mfilters" }, [
        field("Verdict", verdict), field("Unité", unit),
        field("Mesure", el(doc, "input", { type: "search", id: "hq-carnet-ix-mq", class: "carnet-input", "data-ix-filter": "mes.query", value: f.query, "aria-label": "Rechercher une mesure", autocomplete: "off" })),
        field("Du", el(doc, "input", { type: "date", id: "hq-carnet-ix-mfrom", class: "carnet-input", "data-ix-filter": "mes.from", value: f.from })),
        field("Au", el(doc, "input", { type: "date", id: "hq-carnet-ix-mto", class: "carnet-input", "data-ix-filter": "mes.to", value: f.to })),
        btn("Réinitialiser", { "data-ix": "reset-mes" }),
      ]);
    }

    function activeFilterCount(kind) {
      const f = state.filters[kind];
      if (kind === "dec") return [f.query, f.page, f.from, f.to, f.evidence].filter(Boolean).length;
      return [f.verdict !== "all" ? f.verdict : "", f.unit, f.query, f.from, f.to].filter(Boolean).length;
    }

    function filterZone(kind) {
      const zone = el(doc, "div", { class: "carnet-ix-filterzone" });
      if (narrow()) {
        const n = activeFilterCount(kind);
        zone.appendChild(btn("Filtres" + (n ? " (" + n + ")" : ""), { "data-ix": "sheet", "data-kind": kind, id: "btn-carnet-ix-filters", "aria-haspopup": "dialog", "aria-expanded": state.sheet === kind ? "true" : "false" }));
      } else zone.appendChild(kind === "dec" ? decFilters() : mesFilters());
      return zone;
    }

    function sheetNode() {
      const kind = state.sheet;
      const close = btn("Terminé", { "data-ix": "sheet-close", id: "btn-carnet-ix-sheet-close" });
      const sheet = el(doc, "div", { class: "carnet-ix-sheet", id: "hq-carnet-ix-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Filtres" }, [
        el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h4", { text: "Filtres" }), close]),
        kind === "dec" ? decFilters() : mesFilters(),
      ]);
      return el(doc, "div", { class: "carnet-ix-sheet-wrap" }, [el(doc, "div", { class: "carnet-ix-scrim", "data-ix": "sheet-close" }), sheet]);
    }

    function openSheet(kind) {
      state.sheet = kind;
      render();
      const first = focusables(dlg.querySelector(".carnet-ix-sheet"))[0];
      if (first) first.focus({ preventScroll: true });
    }

    function closeSheet(refocus) {
      const kind = state.sheet;
      state.sheet = null;
      render();
      if (refocus) {
        const b = dlg.querySelector("#btn-carnet-ix-filters");
        if (b) b.focus({ preventScroll: true });
      }
      return kind;
    }

    // ---- decisions

    function renderDecisions() {
      const r = view();
      if (!r) return;
      body.appendChild(el(doc, "p", { class: "hint", text: "Journal tiré des blocs Décision. Aucun statut, auteur ni justification n'est déduit : seuls le texte, la date, la note et les liens déjà présents sur la ligne figurent ici." }));
      if (!r.decisions.length) return body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ix-nodec", text: MSG.noDecisions }));
      body.appendChild(filterZone("dec"));
      const host2 = el(doc, "div", { id: "hq-carnet-ix-dlist" });
      body.appendChild(host2);
      paintDecisions(host2);
    }

    function paintDecisions(node) {
      const r = view();
      const rows = I.filterDecisions(r.decisions, state.filters.dec);
      node.textContent = "";
      node.appendChild(el(doc, "p", { class: "hint", role: "status", id: "hq-carnet-ix-dcount", text: rows.length + " décision" + (rows.length > 1 ? "s" : "") + (rows.length !== r.decisions.length ? " sur " + r.decisions.length : "") + (r.decisions_total > r.decisions.length ? " (journal limité : " + r.decisions_total + " au total)" : "") }));
      if (!rows.length) return node.appendChild(el(doc, "p", { class: "hint", text: MSG.noMatch }));
      node.appendChild(el(doc, "ol", { class: "carnet-hx-list carnet-ix-trail", "aria-label": "Journal des décisions" }, rows.map(decisionNode)));
      node.appendChild(el(doc, "p", { class: "hint", text: MSG.utc }));
    }

    function decisionNode(d) {
      const ev = d.evidence || [];
      const kids = [
        el(doc, "span", { class: "carnet-ix-when", text: I.fmtDate(d.at) }),
        linkBtn(d.text || "(décision vide)", { pageId: d.page_id, blockId: d.block_id }, "Aller à la décision : " + d.text),
        el(doc, "span", { class: "hint", text: d.page_title }),
        reviewBtn("decision", { page: d.page_id, block: d.block_id }, d.text || "Décision"),
      ];
      if (ev.length) {
        const evl = el(doc, "ul", { class: "carnet-ix-evidence", "aria-label": "Preuves liées sur cette ligne" });
        for (const e of ev) evl.appendChild(el(doc, "li", { text: kindWord(e.kind) + " — " + (e.title || e.id) + (e.state === "ok" ? "" : " (" + (I.STATE_LABEL[e.state] || "").toLowerCase() + ")") }));
        kids.push(evl);
      }
      return el(doc, "li", { class: "carnet-hx-event carnet-ix-decision", "data-block": d.block_id }, kids);
    }

    function kindWord(kind) {
      return { note: "Note", file: "Fichier", drawing: "Croquis", model: "Modèle", media: "Média", source: "Source", project: "Projet" }[kind] || kind;
    }

    // ---- measurement trends

    function renderMeasures() {
      const r = view();
      if (!r) return;
      const mm = r.measurements || {};
      body.appendChild(el(doc, "p", { class: "hint", text: "Une série = même libellé (casse et espaces ignorés) et même unité exacte. Aucune conversion : mm et in restent séparés. Chaque point garde sa propre tolérance." }));
      if (!r.series.length) return body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ix-nomes", text: MSG.noMeasures }));
      body.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ix-msum", text: mm.total + " mesure" + (mm.total > 1 ? "s" : "") + " — " + mm.out + " hors tolérance, " + mm.in + " dans la tolérance, " + mm.none + " sans tolérance, " + mm.incompatible + " en unités incompatibles." }));
      body.appendChild(filterZone("mes"));
      const host2 = el(doc, "div", { id: "hq-carnet-ix-mlist" });
      body.appendChild(host2);
      paintMeasures(host2);
    }

    function paintMeasures(node) {
      const r = view();
      const rows = I.filterSeries(r.series, state.filters.mes);
      node.textContent = "";
      node.appendChild(el(doc, "p", { class: "hint", role: "status", id: "hq-carnet-ix-mcount", text: rows.length + " série" + (rows.length > 1 ? "s" : "") + (rows.length !== r.series.length ? " sur " + r.series.length : "") }));
      if (!rows.length) return node.appendChild(el(doc, "p", { class: "hint", text: MSG.noMatch }));
      rows.forEach((s, i) => node.appendChild(seriesNode(s, i)));
      node.appendChild(el(doc, "p", { class: "hint", text: MSG.utc }));
    }

    function legend() {
      const items = ["in", "out", "none", "incompatible"].map((v) => el(doc, "li", { text: I.VERDICT_MARK[v] + " " + I.VERDICT_LABEL[v] }));
      return el(doc, "ul", { class: "carnet-ix-legend", "aria-label": "Légende des verdicts" }, items);
    }

    function marker(p) {
      const cls = "carnet-ix-pt carnet-ix-pt-" + p.verdict;
      const x = p.x;
      const y = p.y;
      if (p.verdict === "out") return sv(doc, "polygon", { class: cls, points: [x, y - 6, x + 6, y, x, y + 6, x - 6, y].join(" ") });
      if (p.verdict === "incompatible") return sv(doc, "polygon", { class: cls, points: [x, y - 6, x + 6, y + 5, x - 6, y + 5].join(" ") });
      return sv(doc, "circle", { class: cls, cx: x, cy: y, r: 5 });
    }

    function chartNode(s, id) {
      const m = I.chartModel(s, { w: 360, h: 170 });
      if (!m) return el(doc, "p", { class: "hint", text: "Valeurs non numériques : voir le tableau." });
      const svg = sv(doc, "svg", { class: "carnet-ix-chart", viewBox: "0 0 " + m.w + " " + m.h, role: "img", "aria-label": I.seriesSummary(s), "aria-describedby": id + "-table", focusable: "false" });
      if (m.band) svg.appendChild(sv(doc, "rect", { class: "carnet-ix-band", x: m.margin.l, y: m.band.y1, width: m.w - m.margin.l - m.margin.r, height: Math.max(1, m.band.y2 - m.band.y1) }));
      for (const t of m.ticks) {
        svg.appendChild(sv(doc, "line", { class: "carnet-ix-grid", x1: m.margin.l, x2: m.w - m.margin.r, y1: t.y, y2: t.y }));
        const lab = sv(doc, "text", { class: "carnet-ix-tick", x: m.margin.l - 4, y: t.y + 4, "text-anchor": "end" });
        lab.textContent = t.label;
        svg.appendChild(lab);
      }
      if (m.points.length > 1) svg.appendChild(sv(doc, "path", { class: "carnet-ix-line", d: m.path, fill: "none" }));
      for (const p of m.points) {
        const t = I.target(p.pageId, p.blockId);
        const title = sv(doc, "title");
        title.textContent = p.text;
        const g = sv(doc, "g", { class: "carnet-ix-ptg", tabindex: "0", role: "link", "aria-label": "Aller à la mesure : " + p.text, "data-ix": "goto", "data-page": t ? t.pageId : "", "data-block": t && t.blockId ? t.blockId : "" }, [title, marker(p)]);
        g.setAttribute("data-ix", "goto");
        svg.appendChild(g);
      }
      return svg;
    }

    function tableNode(s, id) {
      const rows = I.tableRows(s);
      const head = el(doc, "tr", null, ["Date (UTC)", "Valeur", "Nominal", "Tolérance", "Verdict", "Source"].map((h) => el(doc, "th", { scope: "col", text: h })));
      const trs = rows.map((r) => {
        const t = I.target(r.pageId, r.blockId);
        return el(doc, "tr", { "data-verdict": r.mark }, [
          el(doc, "td", { text: r.date }), el(doc, "td", { text: r.value }), el(doc, "td", { text: r.nominal }), el(doc, "td", { text: r.tolerance }),
          el(doc, "td", { text: r.mark + " " + r.verdict }),
          el(doc, "td", null, [t ? linkBtn(r.page || "Ouvrir", t, "Aller à la mesure du " + r.date + " dans « " + r.page + " »") : null, reviewBtn("measurement", { page: r.pageId, block: r.blockId }, s.label + " " + r.date)]),
        ]);
      });
      const table = el(doc, "table", { class: "carnet-ix-table", id: id + "-table" }, [el(doc, "caption", { text: "Mesures de « " + s.label + " »" + (s.unit ? " en " + s.unit : "") }), el(doc, "thead", null, [head]), el(doc, "tbody", null, trs)]);
      return el(doc, "div", { class: "carnet-ix-tablewrap", tabindex: "0", role: "region", "aria-label": "Tableau des mesures de " + s.label }, [table]);
    }

    function seriesNode(s, i) {
      const id = "hq-carnet-ix-s" + i;
      const sec = el(doc, "section", { class: "carnet-panel carnet-ix-series", "data-series": s.key, "aria-labelledby": id + "-h" });
      sec.appendChild(el(doc, "h4", { id: id + "-h", text: s.label + (s.unit ? " (" + s.unit + ")" : "") }));
      sec.appendChild(el(doc, "p", { class: "carnet-ix-band-text" + (s.band.state === "variable" ? " carnet-ix-variable" : ""), "data-band": s.band.state, text: I.bandText(s) + " — " + s.points.length + " mesure" + (s.points.length > 1 ? "s" : "") + (s.out ? ", " + s.out + " hors tolérance" : "") + (s.truncated ? " (les plus récentes sur " + s.points_total + ")" : "") }));
      sec.appendChild(chartNode(s, id));
      sec.appendChild(legend());
      const det = el(doc, "details", { class: "carnet-ix-details" }, [el(doc, "summary", { text: "Tableau des " + s.points.length + " mesure" + (s.points.length > 1 ? "s" : "") }), tableNode(s, id)]);
      if (s.points.length <= 12) det.setAttribute("open", "");
      sec.appendChild(det);
      return sec;
    }

    // ---- changes ("what changed since last review")

    function baseSpec() {
      const b = state.base;
      const bl = state.baselines || {};
      const choices = I.baselineChoices(bl);
      if (b.kind === "latest_checkpoint") return choices.latestCheckpoint ? { id: choices.latestCheckpoint, text: textOf(choices.checkpoints, choices.latestCheckpoint, "checkpoint") } : null;
      if (b.kind === "latest_snapshot") return choices.latestSnapshot ? { id: choices.latestSnapshot, text: textOf(choices.snapshots, choices.latestSnapshot, "jalon") } : null;
      if (b.kind === "pick_checkpoint") return b.id && choices.checkpoints.some((c) => c.id === b.id) ? { id: b.id, text: textOf(choices.checkpoints, b.id, "checkpoint") } : null;
      if (b.kind === "pick_snapshot") return b.id && choices.snapshots.some((c) => c.id === b.id) ? { id: b.id, text: textOf(choices.snapshots, b.id, "jalon") } : null;
      if (b.kind === "date" && state.resolved) {
        const x = nearest(state.resolved);
        return x ? { id: x.id, text: (x.kind === "snapshot" ? "jalon « " : "checkpoint « ") + x.label + " » — " + I.fmtDate(x.at) } : null;
      }
      return null;
    }

    /** The single nearest surviving baseline of a resolved date (ties go to the snapshot, which is immutable). */
    function nearest(res) {
      const a = res && res.snapshot;
      const c = res && res.checkpoint;
      if (a && c) return a.at >= c.at ? a : c;
      return a || c || null;
    }

    function textOf(list2, id, word) {
      const f = list2.find((c) => c.id === id);
      return f ? word + " « " + f.text.replace(" — ", " » — ") : word;
    }

    function renderChanges() {
      body.appendChild(el(doc, "p", { class: "hint", text: "Compare l'état actuel à une baseline EXPLICITE : un checkpoint ou un jalon. Les comparaisons sont exactes (identifiant de bloc et contenu), sans auteur et sans correspondance approximative." }));
      if (state.baselines === null) return body.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      if (state.baselinesError) body.appendChild(failure(state.baselinesError, null));
      const choices = I.baselineChoices(state.baselines);
      const cur = host.currentPage ? host.currentPage() : null;
      const b = state.base;
      const group = el(doc, "fieldset", { class: "carnet-ix-bases", id: "hq-carnet-ix-bases" }, [el(doc, "legend", { text: "Baseline" })]);
      const opt = (kind, label, extra, disabled) => {
        const input = el(doc, "input", { type: "radio", name: "hq-ix-base", value: kind, id: "hq-carnet-ix-b-" + kind, "data-ix-base": kind, disabled: disabled ? "" : null });
        input.checked = b.kind === kind;
        return el(doc, "div", { class: "carnet-hx-pick" }, [input, el(doc, "label", { for: "hq-carnet-ix-b-" + kind, text: label }), extra || null]);
      };
      group.appendChild(opt("latest_checkpoint", "Dernier checkpoint de la page ouverte", null, !choices.checkpoints.length));
      group.appendChild(opt("latest_snapshot", "Dernier jalon du projet", null, !choices.snapshots.length));
      const cpSel = el(doc, "select", { id: "hq-carnet-ix-cp", class: "carnet-input", "aria-label": "Choisir un checkpoint", "data-ix-pick": "pick_checkpoint" }, [el(doc, "option", { value: "", text: "— choisir —" })].concat(choices.checkpoints.map((c) => el(doc, "option", { value: c.id, text: c.text }))));
      cpSel.value = b.kind === "pick_checkpoint" ? b.id : "";
      group.appendChild(opt("pick_checkpoint", "Choisir un checkpoint", cpSel, !choices.checkpoints.length));
      const snSel = el(doc, "select", { id: "hq-carnet-ix-sn", class: "carnet-input", "aria-label": "Choisir un jalon", "data-ix-pick": "pick_snapshot" }, [el(doc, "option", { value: "", text: "— choisir —" })].concat(choices.snapshots.map((c) => el(doc, "option", { value: c.id, text: c.text }))));
      snSel.value = b.kind === "pick_snapshot" ? b.id : "";
      group.appendChild(opt("pick_snapshot", "Choisir un jalon", snSel, !choices.snapshots.length));
      const date = el(doc, "input", { type: "date", id: "hq-carnet-ix-date", class: "carnet-input", "aria-label": "Date", value: b.date });
      group.appendChild(opt("date", "Baseline la plus proche avant une date", el(doc, "span", { class: "carnet-ix-datepick" }, [date, btn("Trouver", { "data-ix": "resolve", id: "btn-carnet-ix-resolve" })])));
      body.appendChild(group);
      if (!cur) body.appendChild(el(doc, "p", { class: "hint", text: MSG.noPage }));
      if (b.kind === "date" && state.resolved) {
        const near = nearest(state.resolved);
        body.appendChild(el(doc, "p", { class: "carnet-ix-resolved", id: "hq-carnet-ix-resolved", role: "status", text: near ? I.resolvedText({ resolved: { [near.kind]: near } }, near.kind) : "Aucun checkpoint ni jalon à cette date ou avant : rien à comparer." }));
      }
      const spec = baseSpec();
      const isSnap = spec && /^snap-/.test(spec.id);
      const resolved = el(doc, "p", { class: "carnet-ix-baseline", id: "hq-carnet-ix-baseline", role: "status", text: spec ? "Baseline : " + spec.text : MSG.resolveFirst });
      body.appendChild(resolved);
      if (isSnap) {
        const to = el(doc, "select", { id: "hq-carnet-ix-to", class: "carnet-input", "aria-label": "Comparer à" }, [el(doc, "option", { value: "", text: "Version actuelle" })]);
        for (const c of choices.snapshots) if (c.id !== spec.id) to.appendChild(el(doc, "option", { value: c.id, text: "Jalon — " + c.text }));
        to.value = state.base.target;
        body.appendChild(field("Comparer à", to));
      }
      body.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [btn(state.diffBusy ? "Comparaison…" : "Comparer", { "data-ix": "diff", id: "btn-carnet-ix-diff", disabled: !spec || state.diffBusy ? "" : null })]));
      if (cur && cur.dirty) body.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.draft }));
      if (state.diffError) body.appendChild(failure(state.diffError, null));
      if (state.diff) body.appendChild(diffNode());
    }

    function changeLi(kind, c) {
      const kids = [el(doc, "span", { class: "carnet-ix-state-word", "data-diff-state": kind, text: I.STATE_WORD[kind] })];
      if (kind === "changed") {
        kids.push(el(doc, "span", { class: "carnet-hx-event-text", text: I.changeLabel(c) }));
        kids.push(el(doc, "span", { class: "hint carnet-ix-ba", text: "Avant : " + (c.before || "∅") + " → Après : " + (c.after || "∅") }));
      } else kids.push(el(doc, "span", { class: "carnet-hx-event-text", text: (c.summary || c.type) + " (" + c.type + ")" }));
      return kids;
    }

    function pageDiffNode(pageId, d, title) {
      const wrap = el(doc, "div", { class: "carnet-ix-pagediff", "data-page": pageId });
      if (title) wrap.appendChild(el(doc, "h5", { text: title }));
      wrap.appendChild(el(doc, "p", { class: "carnet-ix-summary", text: I.pageDiffSummary(d) + (d.unchanged ? " — " + d.unchanged + " inchangé" + (d.unchanged > 1 ? "s" : "") : "") }));
      if (d.mode === "text_only") {
        wrap.appendChild(el(doc, "p", { class: "hint", text: d.note || MSG.notText }));
        return wrap;
      }
      if (d.truncated) wrap.appendChild(el(doc, "p", { class: "hint", text: "Liste limitée : seuls les premiers éléments sont affichés." }));
      const items = [];
      for (const a of d.added) items.push(el(doc, "li", { class: "carnet-hx-event", "data-block": a.id, "data-diff-state": "added" }, changeLi("added", a).concat([linkBtn("Aller au bloc", { pageId, blockId: a.id }, "Aller au bloc ajouté : " + a.summary)])));
      for (const c of d.changed) items.push(el(doc, "li", { class: "carnet-hx-event", "data-block": c.id, "data-diff-state": "changed" }, changeLi("changed", c).concat([linkBtn("Aller au bloc", { pageId, blockId: c.id }, "Aller au bloc modifié : " + c.after)])));
      for (const g of d.removed) items.push(el(doc, "li", { class: "carnet-hx-event", "data-block": g.id, "data-diff-state": "removed" }, changeLi("removed", g)));
      if (items.length) wrap.appendChild(el(doc, "ul", { class: "carnet-hx-list carnet-ix-changes", "aria-label": "Changements" }, items));
      return wrap;
    }

    function diffNode() {
      const dm = I.diffModel(state.diff);
      if (!dm) return null;
      const wrap = el(doc, "section", { class: "carnet-panel carnet-ix-diff", id: "hq-carnet-ix-diff", "aria-label": "Résultat de la comparaison" });
      wrap.appendChild(el(doc, "h4", { text: "Depuis : " + dm.base + " → " + dm.to }));
      wrap.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ix-idnote", text: dm.note }));
      const dsp = diffReviewSpec();
      if (dsp) wrap.appendChild(reviewBtn("diff", {}, dsp.label));
      if (dm.scope === "page") {
        const d = dm.pages[0].diff;
        wrap.appendChild(pageDiffNode(dm.pages[0].pageId, d, null));
        const ob = overlayButton(dm.pages[0].pageId, d);
        if (ob) wrap.appendChild(ob);
      } else {
        const c = dm.counts || {};
        wrap.appendChild(el(doc, "p", { class: "carnet-ix-summary", id: "hq-carnet-ix-pcounts", text: (c.changed || 0) + " modifiée(s), " + (c.added || 0) + " ajoutée(s), " + (c.removed || 0) + " absente(s), " + (c.unchanged || 0) + " inchangée(s)" }));
        for (const p of dm.pages) {
          const head = el(doc, "div", { class: "carnet-ix-pagehead" }, [el(doc, "strong", { text: p.title }), el(doc, "span", { class: "carnet-ix-state-word", "data-page-status": p.status, text: p.statusLabel + (p.reason ? " — " + p.reason : "") }), p.summary ? el(doc, "span", { class: "hint", text: p.summary }) : null]);
          const kids = [head];
          if (p.diff) {
            kids.push(pageDiffNode(p.pageId, p.diff, null));
            kids.push(overlayButton(p.pageId, p.diff));
          }
          wrap.appendChild(el(doc, "div", { class: "carnet-ix-pagerow", "data-page": p.pageId }, kids));
        }
      }
      return wrap;
    }

    function diffReviewSpec() {
      const d = state.diff;
      if (!d || !d.base || typeof d.base.id !== "string") return null;
      const to = d.to && d.to.kind === "snapshot" ? d.to.id : null;
      return RV.diffSpec(d.base.id, to, null, null, "Comparaison — " + (d.base.label || "jalon") + " → " + (to ? "jalon" : "état actuel"));
    }

    function overlayButton(pageId, d) {
      const cur = host.currentPage ? host.currentPage() : null;
      const ov = I.overlayOf(d);
      if (!ov.available) return el(doc, "p", { class: "hint", text: MSG.notText });
      if (!(d.counts.added || d.counts.changed || d.counts.removed)) return null;
      const here = cur && cur.id === pageId;
      return btn(here ? "Afficher les changements sur la page" : "Ouvrir la page avec les changements", { "data-ix": "overlay", "data-page": pageId, class: "carnet-small carnet-hx-btn carnet-ix-overlay-btn" });
    }

    // ---- snapshots

    function renderSnaps() {
      body.appendChild(el(doc, "p", { class: "hint carnet-ix-claim", id: "hq-carnet-ix-claim", text: I.SNAPSHOT_CLAIM }));
      if (state.project === "none") return body.appendChild(el(doc, "p", { class: "hint", text: MSG.needProject }));
      const label = el(doc, "input", { type: "text", id: "hq-carnet-ix-slabel", class: "carnet-input", maxlength: String(I.LABEL_MAX), "aria-label": "Nom du jalon", placeholder: "Nom du jalon (ex. Gel conception)", value: state.snapForm.label, autocomplete: "off" });
      const note = el(doc, "textarea", { id: "hq-carnet-ix-snote", class: "carnet-input", maxlength: String(I.NOTE_MAX), rows: "2", "aria-label": "Note du jalon (facultative)", placeholder: "Note (facultative)" });
      note.value = state.snapForm.note;
      body.appendChild(section("Figer le projet", [
        field("Nom", label), field("Note", note),
        el(doc, "div", { class: "carnet-panel-row" }, [btn(state.snapBusy ? "Création…" : "Figer le projet", { "data-ix": "snap-create", id: "btn-carnet-ix-snap-create", disabled: state.snapBusy ? "" : null })]),
        state.snapResult ? el(doc, "p", { role: "status", id: "hq-carnet-ix-snap-result", class: "carnet-ix-snap-result", text: state.snapResult }) : null,
      ]));
      if (state.snaps === null) return body.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      if (state.snapsError) body.appendChild(failure(state.snapsError, null));
      const rows = I.snapshotRows(state.snaps);
      const lis = rows.map((s) => el(doc, "li", { class: "carnet-hx-event carnet-ix-snap", "data-snap": s.id }, [
        el(doc, "span", { class: "carnet-hx-event-text", text: "« " + s.label + " » — " + s.date + " — " + s.pages + " note" + (s.pages > 1 ? "s" : "") }),
        el(doc, "span", { class: "carnet-ix-state", "data-state": s.ok ? "ok" : "missing", text: s.integrityLabel }),
        s.note ? el(doc, "span", { class: "hint", text: s.note }) : null,
        btn("Ouvrir", { "data-ix": "snap-open", "data-id": s.id, "aria-label": "Ouvrir le jalon « " + s.label + " »", disabled: s.ok ? null : "" }),
        btn("Comparer à l'actuel", { "data-ix": "snap-diff", "data-id": s.id, "aria-label": "Comparer le jalon « " + s.label + " » à l'état actuel", disabled: s.ok ? null : "" }),
        s.ok ? reviewBtn("snapshot", { snapshot: s.id }, "Jalon « " + s.label + " »") : null,
      ]));
      body.appendChild(section("Jalons du projet", [rows.length ? el(doc, "ul", { class: "carnet-hx-list", id: "hq-carnet-ix-snaplist", "aria-label": "Jalons" }, lis) : el(doc, "p", { class: "hint", id: "hq-carnet-ix-nosnap", text: "Aucun jalon. Un jalon n'est créé que sur demande." }), el(doc, "p", { class: "hint", text: MSG.utc })]));
    }

    // ------------------------------------------------------------ overlay on the open page (display-only)

    function overlayClear(announce) {
      if (!overlay) return;
      if (overlay.observer) overlay.observer.disconnect();
      const ed = host.editorEl ? host.editorEl() : null;
      if (ed) for (const n of ed.querySelectorAll("[data-carnet-diff]")) {
        n.removeAttribute("data-carnet-diff");
        n.removeAttribute("data-carnet-diff-label");
      }
      if (overlay.bar && overlay.bar.parentNode) overlay.bar.parentNode.removeChild(overlay.bar);
      overlay = null;
      if (announce) host.flash(MSG.overlayOff, 1800);
    }

    function overlayPaint() {
      if (!overlay) return;
      const ed = host.editorEl ? host.editorEl() : null;
      const cur = host.currentPage ? host.currentPage() : null;
      if (!ed || !cur || cur.id !== overlay.pageId) return overlayClear(false);
      for (const n of Array.prototype.slice.call(ed.children)) {
        const id = n.getAttribute("data-carnet-block-id");
        const s = id ? overlay.model.states[id] : null;
        if (s) {
          if (n.getAttribute("data-carnet-diff") !== s.state) n.setAttribute("data-carnet-diff", s.state);
          if (n.getAttribute("data-carnet-diff-label") !== s.label) n.setAttribute("data-carnet-diff-label", s.label);
        } else if (n.hasAttribute("data-carnet-diff")) {
          n.removeAttribute("data-carnet-diff");
          n.removeAttribute("data-carnet-diff-label");
        }
      }
    }

    function overlayShow(pageId, d, baseText) {
      overlayClear(false);
      const ed = host.editorEl ? host.editorEl() : null;
      if (!ed || !ed.parentNode) return false;
      const model = I.overlayOf(d);
      if (!model.available) return false;
      const bar = el(doc, "div", { id: "hq-carnet-diffbar", class: "carnet-banner carnet-ix-bar", role: "region", "aria-label": "Changements depuis la baseline" });
      bar.appendChild(el(doc, "p", { class: "carnet-banner-msg", text: "Changements depuis : " + baseText + " — " + I.pageDiffSummary(d) }));
      bar.appendChild(el(doc, "p", { class: "hint", text: "Affichage seulement : la note n'est pas modifiée." }));
      if (model.ghosts.length) {
        const ul = el(doc, "ul", { class: "carnet-ix-ghosts", "aria-label": "Blocs supprimés" });
        for (const g of model.ghosts) {
          const after = g.afterId ? el(doc, "button", { type: "button", class: "carnet-small carnet-ix-link", "data-ix": "goto", "data-page": pageId, "data-block": g.afterId, text: "Aller au bloc précédent" }) : el(doc, "span", { class: "hint", text: "en début de page" });
          ul.appendChild(el(doc, "li", { class: "carnet-ix-ghost", "data-diff-state": "removed" }, [el(doc, "span", { class: "carnet-ix-state-word", text: g.label }), el(doc, "span", { text: " " + (g.summary || g.type) + " " }), after]));
        }
        bar.appendChild(ul);
      }
      bar.appendChild(el(doc, "button", { type: "button", class: "carnet-small carnet-hx-btn", id: "btn-carnet-diffbar-hide", text: "Masquer les changements" }));
      bar.addEventListener("click", (ev) => {
        const t = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if (!t) return;
        if (t.id === "btn-carnet-diffbar-hide") {
          overlayClear(true);
          return;
        }
        if (t.getAttribute("data-ix") === "goto") {
          const tg = I.target(t.getAttribute("data-page"), t.getAttribute("data-block") || null);
          if (tg && host.goto) host.goto(tg.pageId, tg.blockId);
        }
      });
      ed.parentNode.insertBefore(bar, ed);
      overlay = { pageId, model, bar, observer: null };
      if (typeof global.MutationObserver === "function") {
        overlay.observer = new global.MutationObserver(() => overlayPaint());
        overlay.observer.observe(ed, { childList: true });
      }
      overlayPaint();
      host.flash(MSG.overlayOn, 2500);
      return true;
    }

    // ------------------------------------------------------------ actions

    async function gotoTarget(pageId, blockId) {
      const t = I.target(pageId, blockId || null);
      if (!t) return;
      close(false);
      let ok = true;
      try {
        ok = t.blockId ? await host.goto(t.pageId, t.blockId) : host.openNote(t.pageId);
      } catch (_) {
        ok = false;
      }
      if (ok === false) host.flash(MSG.gone, 3000);
    }

    function newRequestId() {
      const bytes = new Uint8Array(16);
      const w = doc.defaultView;
      if (w && w.crypto && typeof w.crypto.getRandomValues === "function") w.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      return Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
    }

    async function createSnapshot() {
      if (state.snapBusy) return;
      const l = dlg.querySelector("#hq-carnet-ix-slabel");
      const n = dlg.querySelector("#hq-carnet-ix-snote");
      state.snapForm = { label: l ? l.value : "", note: n ? n.value : "" };
      const v = I.validSnapshotInput(state.snapForm.label, state.snapForm.note);
      if (!v.ok) {
        state.snapResult = v.error;
        return render();
      }
      state.snapBusy = true;
      state.snapResult = MSG.creating;
      say(MSG.creating);
      render();
      try {
        // A retry of the SAME request after an uncertain outcome (lost response, timeout) re-sends the SAME request_id: the server then
        // answers with the snapshot it already wrote instead of freezing a second, undeletable one. Any change of payload gets a new id.
        const key = [state.project, v.label, v.note].join("\u0000");
        if (!state.snapReq || state.snapReq.key !== key) state.snapReq = { key, id: newRequestId() };
        const out = await host.api.post({ action: "snapshot_create", project_id: state.project, label: v.label, note: v.note, request_id: state.snapReq.id });
        state.snapReq = null;
        const refs = out.refs || {};
        const missing = ["drawings", "assets", "voices", "files", "sources"].reduce((a, k) => a + ((refs[k] && refs[k].missing) || 0), 0);
        state.snapResult = (out.replayed ? MSG.replayed : MSG.created) + " « " + out.snapshot.label + " »" + (missing ? " — " + missing + " référence(s) déjà introuvable(s) au moment du jalon." : "");
        state.snapForm = { label: "", note: "" };
        state.baselines = null;
        state.snaps = null;
        await loadSnaps();
      } catch (err) {
        state.snapResult = errText(err);
      }
      state.snapBusy = false;
      say(state.snapResult || "");
      if (state.open) render();
    }

    async function openSnapshot(id) {
      try {
        const r = await host.api.get("/api/carnet?snapshot=" + encodeURIComponent(id));
        state.snapView = r;
        state.verify = null;
        state.filters = { dec: { query: "", page: "", from: "", to: "", evidence: false }, mes: { verdict: "all", unit: "", query: "", from: "", to: "" } };
        setTab("overview");
        say(MSG.pinned + " : " + r.snapshot.label);
      } catch (err) {
        say(errText(err));
        host.flash(errText(err), 3500);
      }
    }

    async function verifySnapshot() {
      if (!state.snapView) return;
      say("Vérification des références…");
      try {
        state.verify = await host.api.get("/api/carnet?snapshot=" + encodeURIComponent(state.snapView.snapshot.id) + "&verify=1");
        say("Vérification terminée.");
      } catch (err) {
        state.verify = null;
        say(errText(err));
        host.flash(errText(err), 3500);
      }
      if (state.open) render();
    }

    async function runDiff(forced) {
      const spec = forced || baseSpec();
      if (!spec || state.diffBusy) return;
      state.diffBusy = true;
      state.diffError = "";
      state.diff = null;
      render();
      const q = ["diff=1", "base=" + encodeURIComponent(spec.id)];
      if (/^snap-/.test(spec.id) && state.base.target) q.push("to=" + encodeURIComponent(state.base.target));
      try {
        state.diff = await host.api.get("/api/carnet?" + q.join("&"));
        state.diffBase = spec.text;
        say("Comparaison terminée.");
      } catch (err) {
        state.diffError = errText(err);
        say(state.diffError);
      }
      state.diffBusy = false;
      if (state.open) render();
      const out = dlg.querySelector("#hq-carnet-ix-diff");
      if (out) out.scrollIntoView({ block: "nearest" });
    }

    async function resolveDate() {
      const input = dlg.querySelector("#hq-carnet-ix-date");
      state.base.date = input ? input.value : state.base.date;
      const start = I.dayStart(state.base.date);
      if (start === null) {
        state.resolved = null;
        say("Date invalide.");
        return render();
      }
      const cur = host.currentPage ? host.currentPage() : null;
      const q = ["baselines=1", "at=" + (start + 86399)];
      if (state.project !== "none") q.push("project=" + encodeURIComponent(state.project));
      if (cur) q.push("page=" + encodeURIComponent(cur.id));
      try {
        const r = await host.api.get("/api/carnet?" + q.join("&"));
        state.resolved = r.resolved || { checkpoint: null, snapshot: null };
      } catch (err) {
        state.resolved = null;
        say(errText(err));
      }
      render();
    }

    function addToReview(t) {
      const kind = t.getAttribute("data-rkind");
      const label = t.getAttribute("data-rlabel") || "";
      let item = null;
      if (kind === "overview") item = RV.overviewSpec();
      else if (kind === "decision" || kind === "measurement") item = RV.blockSpec(kind, t.getAttribute("data-rpage"), t.getAttribute("data-rblock"), label);
      else if (kind === "drawing") item = RV.drawingSpec(t.getAttribute("data-rstem"));
      else if (kind === "source") item = RV.sourceSpec(t.getAttribute("data-redition"), label);
      else if (kind === "snapshot") item = RV.snapshotSpec(t.getAttribute("data-rsnapshot"), label);
      else if (kind === "diff") item = diffReviewSpec();
      if (!item) return host.flash("Cette preuve ne peut pas être ajoutée.", 3000);
      const opener = state.opener;
      const pid = state.project && state.project !== "none" ? state.project : null;
      close(false);
      if (!host.addToReview(Object.assign({ projectId: pid }, item), opener)) host.flash("Revues indisponibles.", 3000);
    }

    function addToReport() {
      const item = I.reportItem(view());
      if (!item) return;
      if (host.addToReport(item)) host.flash(MSG.reportAdded, 2500);
    }

    function setFilter(path, value) {
      const [kind, key] = path.split(".");
      state.filters[kind][key] = key === "evidence" ? !!value : value;
      const node = dlg.querySelector(kind === "dec" ? "#hq-carnet-ix-dlist" : "#hq-carnet-ix-mlist");
      if (node) (kind === "dec" ? paintDecisions : paintMeasures)(node);
      const fb = dlg.querySelector("#btn-carnet-ix-filters");
      if (fb) fb.textContent = "Filtres" + (activeFilterCount(kind) ? " (" + activeFilterCount(kind) + ")" : "");
    }

    function onInput(ev) {
      const t = ev.target;
      if (!t || !t.getAttribute) return;
      const f = t.getAttribute("data-ix-filter");
      if (f) {
        setFilter(f, t.type === "checkbox" ? t.checked : t.value);
        return;
      }
      if (t.id === "hq-carnet-ix-project" && ev.type === "change") {
        state.project = t.value;
        state.snapView = null;
        state.verify = null;
        state.diff = null;
        state.resolved = null;
        state.snapResult = null;
        loadAll();
        return;
      }
      if (t.getAttribute("data-ix-base")) {
        state.base.kind = t.value;
        state.diff = null;
        state.resolved = null;
        if (t.value === "latest_checkpoint" || t.value === "latest_snapshot" || t.value === "date") state.base.id = "";
        render();
        return;
      }
      if (t.getAttribute("data-ix-pick") && ev.type === "change") {
        state.base.kind = t.getAttribute("data-ix-pick");
        state.base.id = t.value;
        state.diff = null;
        render();
        return;
      }
      if (t.id === "hq-carnet-ix-to" && ev.type === "change") {
        state.base.target = t.value;
        state.diff = null;
        render();
        return;
      }
      if (t.id === "hq-carnet-ix-date" && ev.type === "change") {
        state.base.date = t.value;
        state.resolved = null;
        state.diff = null;
        return;
      }
      if (t.id === "hq-carnet-ix-slabel") state.snapForm.label = t.value;
      else if (t.id === "hq-carnet-ix-snote") state.snapForm.note = t.value;
    }

    function onClick(ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-ix], #btn-carnet-ix-close, [data-ix-tab]") : null;
      if (!t) return;
      if (t.id === "btn-carnet-ix-close") return close(true);
      if (t.hasAttribute("data-ix-tab")) {
        state.sheet = null;
        return setTab(t.getAttribute("data-ix-tab"));
      }
      const act = t.getAttribute("data-ix");
      if (act === "goto") {
        const tg = I.target(t.getAttribute("data-page"), t.getAttribute("data-block") || null);
        if (tg) gotoTarget(tg.pageId, tg.blockId);
        else host.flash(MSG.gone, 3000);
      } else if (act === "tab") setTab(t.getAttribute("data-tab"));
      else if (act === "refresh" || act === "retry") loadAll();
      else if (act === "oot") {
        state.filters.mes = { verdict: "out", unit: "", query: "", from: "", to: "" };
        setTab("measures");
      } else if (act === "more-activity") {
        state.showAllActivity = true;
        render();
      } else if (act === "reset-dec") {
        state.filters.dec = { query: "", page: "", from: "", to: "", evidence: false };
        render();
      } else if (act === "reset-mes") {
        state.filters.mes = { verdict: "all", unit: "", query: "", from: "", to: "" };
        render();
      } else if (act === "sheet") openSheet(t.getAttribute("data-kind"));
      else if (act === "sheet-close") closeSheet(true);
      else if (act === "report") addToReport();
      else if (act === "review") addToReview(t);
      else if (act === "snap-create") createSnapshot();
      else if (act === "snap-open") openSnapshot(t.getAttribute("data-id"));
      else if (act === "unpin") {
        state.snapView = null;
        state.verify = null;
        render();
        say("État actuel.");
      } else if (act === "verify") verifySnapshot();
      else if (act === "snap-diff") {
        const id = t.getAttribute("data-id");
        state.base = { kind: "pick_snapshot", id, date: "", target: "" };
        state.diff = null;
        setTab("changes");
        runDiff({ id, text: "jalon" });
      } else if (act === "resolve") resolveDate();
      else if (act === "diff") runDiff();
      else if (act === "overlay") {
        const pageId = t.getAttribute("data-page");
        showOverlayFor(pageId);
      }
    }

    async function showOverlayFor(pageId) {
      if (!state.diff) return;
      const d = state.diff.scope === "page" ? state.diff.diff : ((state.diff.pages || []).find((p) => p.page_id === pageId) || {}).diff;
      if (!d) return;
      const baseText = I.diffModel(state.diff).base;
      close(false);
      const cur = host.currentPage ? host.currentPage() : null;
      if (!cur || cur.id !== pageId) {
        try {
          await host.goto(pageId, null);
        } catch (_) {}
      }
      if (!overlayShow(pageId, d, baseText)) host.flash(MSG.notText, 3500);
    }

    return {
      open, close, isOpen: () => state.open, el: () => dlg,
      overlayActive: () => !!overlay, overlayClear: () => overlayClear(false),
      state: () => ({ tab: state.tab, project: state.project, pinned: !!state.snapView, sheet: state.sheet, overlay: !!overlay }),
    };
  }

  return { MSG, TABS, mount };
});
