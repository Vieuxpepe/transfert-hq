/* Transfert HQ — Carnet Phase 6: Ask Carnet UI (evidence finder).
 *
 * NOTHING here is visible on the default paper. One modal dialog (#hq-carnet-ask) is created lazily the first time it is opened
 * ("Preuves" in the library header or the editor's tools tray). The question is sent to POST /api/carnet {action: "ask"}; the server
 * returns passages of the notebook exactly as written. This file generates, summarises, infers and saves NOTHING: no answer text,
 * no author / status / approval, no history. The question and the result live in this dialog only and are dropped on close.
 * The only way a result leaves is the explicit "Ajouter au rapport" button (a report item that keeps its citations).
 *
 * Text that was derived (OCR / transcript) is always shown with the relation to its source, and says so when the source is missing.
 * DOM is built with createElement / textContent only. No HTML string injection, no dynamic code evaluation. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetAskUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const A = node ? require("./hq-carnet-ask.js") : global.HqCarnetAsk;
  const R = node ? require("./hq-carnet-reviews.js") : global.HqCarnetReviews;
  const MSG = {
    title: "Preuves du carnet",
    intro: "Trouve les passages du carnet qui contiennent les termes de ta question, tels qu'ils sont écrits. Aucune réponse n'est générée.",
    placeholder: "Ex. couple de serrage palier avant",
    go: "Chercher les preuves",
    busy: "Recherche en cours…",
    failed: "Recherche impossible.",
    gone: "Source introuvable.",
    reportAdded: "Preuves ajoutées au rapport.",
    snapFailed: "Jalons indisponibles.",
  };
  const LINK_PARTS = /^#carnet\/(page-[A-Za-z0-9_-]+)\/(block-[A-Za-z0-9_-]+)$/;

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

  function errText(err) {
    const d = err && isObj(err.data) ? err.data : {};
    return String(d.error || (err && err.message) || "Erreur").slice(0, 200);
  }

  function mount(host) {
    const doc = host.doc;
    const state = { open: false, opener: null, scopeValue: "", question: "", busy: false, token: 0, result: null, resultScope: null, error: "", snaps: [], choices: [] };
    let dlg = null;
    let form = null;
    let out = null;
    let live = null;
    let input = null;
    let select = null;
    let goBtn = null;

    function build() {
      live = el(doc, "p", { id: "hq-carnet-ask-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      input = el(doc, "input", { id: "hq-carnet-ask-q", type: "search", class: "carnet-input", maxlength: String(A.QUESTION_MAX), autocomplete: "off", enterkeyhint: "search", placeholder: MSG.placeholder, "aria-describedby": "hq-carnet-ask-intro" });
      select = el(doc, "select", { id: "hq-carnet-ask-scope", class: "carnet-input" });
      goBtn = el(doc, "button", { type: "submit", id: "btn-carnet-ask-go", class: "carnet-btn carnet-primary", text: MSG.go });
      form = el(doc, "form", { class: "carnet-hx-row carnet-ask-form", novalidate: "" }, [
        el(doc, "label", { class: "carnet-hx-field carnet-ask-qf" }, [el(doc, "span", { text: "Question" }), input]),
        el(doc, "label", { class: "carnet-hx-field" }, [el(doc, "span", { text: "Où chercher" }), select]),
        goBtn,
      ]);
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        run();
      });
      select.addEventListener("change", () => {
        state.scopeValue = select.value;
        clearResult();
      });
      input.addEventListener("input", () => {
        state.question = input.value;
      });
      out = el(doc, "div", { class: "carnet-hx-body carnet-ask-out", id: "hq-carnet-ask-out" });
      const close = el(doc, "button", { type: "button", id: "btn-carnet-ask-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-ask-title", text: MSG.title }), close]);
      const intro = el(doc, "p", { id: "hq-carnet-ask-intro", class: "hint", text: MSG.intro });
      dlg = el(doc, "div", { id: "hq-carnet-ask", class: "carnet-hx carnet-ask", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-ask-title", tabindex: "-1", hidden: "" }, [head, intro, form, live, out]);
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("keydown", onKey);
      host.root.appendChild(dlg);
    }

    function say(text) {
      if (live) live.textContent = text || "";
    }

    function focusables() {
      return Array.prototype.filter.call(dlg.querySelectorAll("button, input, select, a[href], [tabindex]"), (n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && !n.closest("[hidden]"));
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

    // ------------------------------------------------------------ scope

    function context() {
      const cur = host.currentPage ? host.currentPage() : null;
      const list = host.projects() || [];
      const pid = (cur && cur.project_id) || (host.currentProjectId ? host.currentProjectId() : null);
      return { page: cur ? { id: cur.id } : null, projects: list, projectId: pid || (cur ? "none" : list.length ? null : "none"), snapshots: state.snaps };
    }

    function paintScopes() {
      state.choices = A.scopeChoices(context());
      if (state.prefillScope) {
        // opened from a review ("Rechercher dans Ask Carnet"): the scope the review recorded, when it still exists as a choice
        const want = JSON.stringify(state.prefillScope);
        const hit = state.choices.find((c) => JSON.stringify(c.scope) === want);
        if (hit) {
          state.scopeValue = hit.value;
          state.prefillScope = null;
        }
      }
      if (!state.choices.some((c) => c.value === state.scopeValue)) state.scopeValue = A.defaultScope(state.choices);
      select.textContent = "";
      for (const c of state.choices) select.appendChild(el(doc, "option", { value: c.value, text: c.label, selected: c.value === state.scopeValue }));
      select.value = state.scopeValue;
    }

    async function loadSnaps() {
      const c = context();
      const pid = c.projectId && c.projectId !== "none" ? c.projectId : null;
      if (!pid) return;
      const tok = state.token;
      try {
        const r = await host.api.get("/api/carnet?snapshots=1&project=" + encodeURIComponent(pid));
        if (tok !== state.token || !state.open) return;
        state.snaps = isObj(r) && Array.isArray(r.snapshots) ? r.snapshots : [];
        paintScopes();
      } catch (_) {
        if (tok === state.token && state.open) say(MSG.snapFailed);
      }
    }

    function currentScope() {
      const c = state.choices.find((x) => x.value === state.scopeValue);
      return c ? c.scope : null;
    }

    // ------------------------------------------------------------ lifecycle

    function open(opener, prefill) {
      if (!dlg) build();
      state.opener = opener || doc.activeElement || null;
      state.open = true;
      state.token += 1;
      state.snaps = [];
      state.question = "";
      state.scopeValue = "";
      state.result = null;
      state.error = "";
      input.value = "";
      state.prefillScope = null;
      if (prefill && typeof prefill.question === "string") {
        // a prefill only fills the form: nothing is searched until the user presses the button
        state.question = prefill.question.slice(0, A.QUESTION_MAX);
        input.value = state.question;
        state.prefillScope = isObj(prefill.scope) ? prefill.scope : null;
      }
      dlg.hidden = false;
      paintScopes();
      renderOut();
      say("");
      loadSnaps();
      input.focus({ preventScroll: true });
    }

    function close(refocus) {
      if (!dlg || !state.open) return;
      state.open = false;
      state.token += 1;
      // nothing is kept: the question and the result vanish with the dialog
      state.result = null;
      state.question = "";
      state.error = "";
      input.value = "";
      out.textContent = "";
      dlg.hidden = true;
      say("");
      const o = state.opener;
      state.opener = null;
      if (refocus && o && typeof o.focus === "function" && doc.contains(o)) o.focus({ preventScroll: true });
      if (typeof host.onClose === "function") host.onClose(!!refocus);
    }

    function clearResult() {
      state.result = null;
      state.error = "";
      renderOut();
      say("");
    }

    async function run() {
      if (state.busy) return;
      const scope = currentScope();
      const body = A.requestBody(input.value, scope);
      if (!body) {
        const q = A.validQuestion(input.value);
        state.result = null;
        state.error = q.ok ? MSG.failed : q.error;
        renderOut();
        say(state.error);
        return;
      }
      state.busy = true;
      goBtn.setAttribute("aria-disabled", "true"); // not `disabled`: a disabled button drops keyboard focus out of the dialog (Escape / Tab trap would stop working)
      state.error = "";
      say(MSG.busy);
      const tok = ++state.token;
      try {
        const res = await host.api.post(body);
        if (tok !== state.token || !state.open) return;
        state.result = res;
        state.resultScope = scope;
        state.error = "";
      } catch (err) {
        if (tok !== state.token || !state.open) return;
        state.result = null;
        state.error = errText(err);
      } finally {
        if (tok === state.token || !state.open) {
          state.busy = false;
          goBtn.removeAttribute("aria-disabled");
        }
      }
      if (!state.open) return;
      renderOut();
      const m = A.resultModel(state.result);
      say(state.error || (m ? m.status.title + (m.status.text ? ". " + m.status.text : "") : ""));
    }

    // ------------------------------------------------------------ rendering

    function segs(node, segments) {
      for (const s of segments) node.appendChild(s.hit ? el(doc, "mark", { class: "carnet-ask-hit", text: s.text }) : doc.createTextNode(s.text));
      return node;
    }

    function gotoBtn(link, label, extra) {
      const m = LINK_PARTS.exec(link || "");
      if (!m) return null;
      return el(doc, "button", { type: "button", class: "carnet-btn carnet-ask-goto", "data-ask": "goto", "data-page": m[1], "data-block": m[2], "data-href": link, text: label, ...(extra || {}) });
    }

    function provenanceBlock(pv) {
      const box = el(doc, "div", { class: "carnet-ask-prov", "data-ask-prov": pv.kind, "data-ask-source-state": pv.state }, [
        el(doc, "p", { class: "carnet-ask-prov-label" }, [el(doc, "strong", { text: pv.label }), doc.createTextNode(" — " + pv.text)]),
        el(doc, "p", { class: "carnet-ask-prov-state", text: "Source : " + pv.sourceWord + " — " + pv.stateLabel + (pv.currentLabel ? " (" + pv.currentLabel + ")" : "") }),
      ]);
      const b = gotoBtn(pv.sourceLink, "Voir la source d'origine", { "data-ask-role": "source" });
      if (b) box.appendChild(b);
      else box.appendChild(el(doc, "p", { class: "carnet-ask-prov-missing", text: pv.sourceFound ? "Bloc source non accessible." : "Aucun bloc source dans ce périmètre." }));
      return box;
    }

    function cardNode(c) {
      const li = el(doc, "li", { class: "carnet-hx-item carnet-ask-card", "data-ask-card": c.id, "data-ask-class": c.derived ? "derived" : "primary", "data-ask-kind": c.kind });
      li.appendChild(el(doc, "p", { class: "carnet-ask-meta" }, [
        el(doc, "span", { class: "carnet-chip", text: c.kindLabel }),
        el(doc, "span", { class: "carnet-chip" + (c.derived ? " carnet-ask-derived" : ""), text: c.classLabel }),
        el(doc, "span", { class: "carnet-ask-page", text: c.pageTitle || "Note sans titre" }),
      ]));
      li.appendChild(segs(el(doc, "p", { class: "carnet-ask-excerpt" }), c.segments));
      if (c.measure) li.appendChild(el(doc, "p", { class: "carnet-ask-extra", text: c.measure.label + " = " + c.measure.value + " — " + c.measure.verdictLabel }));
      if (c.drawing) li.appendChild(el(doc, "p", { class: "carnet-ask-extra", text: "Croquis « " + c.drawing.stem + " » — " + c.drawing.stateLabel + (c.drawing.currentLabel ? " (" + c.drawing.currentLabel + ")" : "") }));
      if (c.date) li.appendChild(el(doc, "p", { class: "carnet-ask-extra", text: c.date }));
      li.appendChild(el(doc, "p", { class: "carnet-ask-extra", text: "Termes trouvés : " + c.matched.join(", ") + " (" + c.coverage + " %)" }));
      if (c.provenance) li.appendChild(provenanceBlock(c.provenance));
      if (c.liveState) li.appendChild(el(doc, "p", { class: "carnet-ask-live", "data-ask-live": c.liveState, text: c.liveLabel }));
      const row = el(doc, "div", { class: "carnet-hx-row" });
      const b = gotoBtn(c.link || c.liveLink, c.link ? "Aller au bloc" : "Aller au bloc actuel", { "data-ask-role": "block" });
      if (b) row.appendChild(b);
      else if (c.liveState) row.appendChild(el(doc, "span", { class: "hint", text: "Pas de lien : le bloc actuel diffère du jalon." }));
      if (row.firstChild) li.appendChild(row);
      return li;
    }

    function sourceNode(s) {
      const li = el(doc, "li", { class: "carnet-hx-item carnet-ask-card", "data-ask-card": s.id, "data-ask-kind": "source" });
      li.appendChild(el(doc, "p", { class: "carnet-ask-meta" }, [el(doc, "span", { class: "carnet-chip", text: "Source" }), el(doc, "span", { class: "carnet-ask-page", text: s.meta })]));
      li.appendChild(segs(el(doc, "p", { class: "carnet-ask-excerpt" }), s.segments));
      li.appendChild(el(doc, "p", { class: "carnet-ask-extra", text: "Métadonnées de la source seulement — " + s.stateLabel + (s.currentLabel ? " (" + s.currentLabel + ")" : "") + ". Citée dans " + s.total + " bloc(s)." }));
      for (const c of s.citedIn) {
        const b = gotoBtn(c.link, "Citée dans : " + (c.pageTitle || "note"), { "data-ask-role": "cited" });
        if (b) li.appendChild(b);
      }
      return li;
    }

    function renderOut() {
      if (!out) return;
      out.textContent = "";
      if (state.error) {
        out.appendChild(el(doc, "p", { class: "carnet-ask-banner", "data-ask-tone": "error", role: "alert", text: state.error }));
        return;
      }
      const m = A.resultModel(state.result);
      if (!m) return;
      const st = m.status;
      const banner = el(doc, "div", { class: "carnet-ask-banner", "data-ask-tone": st.tone }, [
        el(doc, "p", { class: "carnet-ask-banner-title" }, [el(doc, "span", { "aria-hidden": "true", text: st.mark + " " }), el(doc, "strong", { text: st.title })]),
      ]);
      if (st.text) banner.appendChild(el(doc, "p", { text: st.text }));
      for (const n of st.notes) banner.appendChild(el(doc, "p", { class: "hint", text: n }));
      banner.appendChild(el(doc, "p", { class: "hint", "data-ask-notgenerated": "1", text: m.note }));
      out.appendChild(banner);
      if (m.frozen) out.appendChild(el(doc, "p", { class: "carnet-hx-warn carnet-ask-frozen", text: "Jalon figé « " + m.frozen.label + " » (" + m.frozen.date + ") — lecture seule, jamais l'état actuel. Sources et références : état au moment du jalon." }));
      if (m.cards.length) {
        const ul = el(doc, "ul", { class: "carnet-hx-list carnet-ask-list", "aria-label": "Preuves" });
        for (const c of m.cards) ul.appendChild(cardNode(c));
        out.appendChild(ul);
      }
      if (m.sources.length) {
        out.appendChild(el(doc, "h4", { text: "Sources citées dont les métadonnées correspondent" }));
        const ul = el(doc, "ul", { class: "carnet-hx-list carnet-ask-list", "aria-label": "Sources" });
        for (const s of m.sources) ul.appendChild(sourceNode(s));
        out.appendChild(ul);
      }
      if (m.canReport) {
        const row = el(doc, "div", { class: "carnet-hx-row" }, [el(doc, "button", { type: "button", id: "btn-carnet-ask-report", class: "carnet-btn", "data-ask": "report", text: "Ajouter au rapport" })]);
        if (typeof host.addToReview === "function" && R && A.reportItem(state.result, state.resultScope)) row.appendChild(el(doc, "button", { type: "button", id: "btn-carnet-ask-review", class: "carnet-btn", "data-ask": "review", text: "Ajouter au dossier de revue" }));
        out.appendChild(row);
      }
    }

    async function gotoTarget(pageId, blockId) {
      close(false);
      let ok = true;
      try {
        ok = await host.goto(pageId, blockId);
      } catch (_) {
        ok = false;
      }
      if (ok === false) host.flash(MSG.gone, 3000);
    }

    function onClick(ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-ask], #btn-carnet-ask-close") : null;
      if (!t) return;
      if (t.id === "btn-carnet-ask-close") return close(true);
      const act = t.getAttribute("data-ask");
      if (act === "goto") gotoTarget(t.getAttribute("data-page"), t.getAttribute("data-block"));
      else if (act === "report") {
        const item = A.reportItem(state.result, state.resultScope);
        if (item && host.addToReport(item)) host.flash(MSG.reportAdded, 2500);
      } else if (act === "review") {
        const item = R.askSpec(state.result, state.resultScope, 10);
        if (!item) return;
        const opener = state.opener;
        close(false);
        const sc = state.resultScope;
        const pid = sc && sc.kind === "project" && sc.id !== "none" ? sc.id : null;
        if (!host.addToReview(Object.assign({ projectId: pid }, item), opener)) host.flash("Revues indisponibles.", 3000);
      }
    }

    return { open, close, isOpen: () => state.open, el: () => dlg };
  }

  return { MSG, mount };
});
