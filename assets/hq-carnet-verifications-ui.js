/* Transfert HQ — Carnet Phase 11: verifications workspace + related-verifications panel (DOM).
 *
 *   workspace  — ONE shared-modal list grouped Ouvertes / Prêtes à vérifier / À reprendre / Vérifiées (≤100 headers, one list request),
 *                a detail view split into QUESTION / TARGET / EVIDENCE / CURRENT STATE / SIGNOFF HISTORY / COMMENTAIRE.
 *   panel      — a quiet summary ("2 ouvertes · 1 vérifiée") for the Reader and the Review Pack: ONE batched related-lookup for ≤10
 *                identities; expanding lists the rows; actions: Créer une vérification / Voir / Ajouter cette preuve.
 *
 * "Vérifiée" is reached ONLY through the explicit "Enregistrer la vérification" action. Nothing here names a reviewer. Every user text is
 * rendered with textContent (a hostile "<script>" is text). A stale write (409) reloads the server version, KEEPS the typed text and never
 * retries by itself; a create / signoff retried after a lost answer reuses the SAME request id. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetVerificationsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const V = node ? require("./hq-carnet-verifications.js") : global.HqCarnetVerifications;
  const M = node ? require("./hq-carnet-modal.js") : global.HqCarnetModal;
  const MSG = V.MSG;

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
    const online = () => (typeof host.online === "function" ? !!host.online() : true);
    const rid = () => V.newRequestId(host.crypto || (doc.defaultView && doc.defaultView.crypto));
    const rootNode = () => (typeof host.root === "function" ? host.root() : host.root) || doc.body;

    // ============================================================ workspace (shared modal)

    const ws = {
      handle: null, dlg: null, body: null, live: null, opener: null, token: 0,
      list: { rows: [], counts: {}, total: 0, unavailable: 0, truncated: false, loading: false, failed: false },
      filters: { project_id: "", status: "", target_kind: "", freshness: "", text: "" },
      fresh: {}, detail: null, busy: false, notice: "", error: "", pendingSign: null, drafts: { question: null, note: null, followup: "" }, confirm: null,
      sign: false, followOpen: false,
    };

    function say(text) {
      if (ws.live) ws.live.textContent = text || "";
    }

    function setNotice(text, isError) {
      ws.notice = isError ? "" : text;
      ws.error = isError ? text : "";
      say(text);
    }

    function isOpen() {
      return !!(ws.handle && !ws.handle.closed);
    }

    function close(refocus) {
      if (!isOpen()) return false;
      ws.token++;
      const h = ws.handle;
      ws.handle = null;
      ws.detail = null;
      const ok = h.close(!!refocus);
      if (typeof host.onClose === "function") host.onClose(!!refocus);
      return ok;
    }

    function open(opener, opts) {
      if (isOpen()) {
        if (opts && opts.id) openDetail(opts.id);
        return true;
      }
      ws.opener = opener || null;
      ws.live = el(doc, "p", { id: "hq-carnet-ver-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      ws.body = el(doc, "div", { class: "carnet-hx-body carnet-ver-body", id: "hq-carnet-ver-body" });
      const closeBtn = el(doc, "button", { type: "button", id: "btn-carnet-ver-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      closeBtn.addEventListener("click", () => close(true));
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-ver-title", text: MSG.title }), closeBtn]);
      ws.dlg = el(doc, "div", { id: "hq-carnet-ver", class: "carnet-hx carnet-ver", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-ver-title" }, [head, ws.live, ws.body]);
      ws.handle = M.open(doc, ws.dlg, { layer: "workspace", trigger: opener || null, initial: closeBtn, mount: (n) => rootNode().appendChild(n), onEscape: onEscape });
      ws.detail = null;
      ws.notice = ws.error = "";
      if (opts && opts.id) openDetail(opts.id);
      else loadList();
      return true;
    }

    function onEscape() {
      if (ws.confirm || ws.sign || ws.followOpen) {
        ws.confirm = null;
        ws.sign = false;
        ws.followOpen = false;
        paint();
        return;
      }
      if (ws.detail) {
        backToList();
        return;
      }
      close(true);
    }

    function backToList() {
      ws.detail = null;
      ws.confirm = null;
      ws.sign = false;
      ws.followOpen = false;
      ws.notice = ws.error = "";
      loadList();
    }

    // ------------------------------------------------------------ list

    async function loadList() {
      const mine = ++ws.token;
      ws.list.loading = true;
      ws.list.failed = false;
      paint();
      const body = V.listBody({ project_id: ws.filters.project_id, status: ws.filters.status, target_kind: ws.filters.target_kind });
      let res = null;
      try {
        res = body ? await host.api.post(body) : null;
      } catch (_) {
        res = null;
      }
      if (mine !== ws.token || !isOpen()) return;
      ws.list.loading = false;
      if (!res || !Array.isArray(res.verifications)) {
        ws.list.failed = true;
        paint();
        return;
      }
      ws.list.rows = res.verifications;
      ws.list.counts = res.counts || {};
      ws.list.total = res.total || 0;
      ws.list.unavailable = res.unavailable || 0;
      ws.list.truncated = !!res.truncated;
      ws.fresh = {};
      paint();
    }

    /** ONE batched, read-only request per ≤25 verified rows. Nothing is written. */
    async function evaluate() {
      const ids = ws.list.rows.filter((r) => r.status === "verified" && r.integrity === "ok").map((r) => r.id);
      const mine = ws.token;
      const fresh = {};
      for (let at = 0; at < ids.length; at += V.RESOLVE_IDS_MAX) {
        const body = V.resolveBody(ids.slice(at, at + V.RESOLVE_IDS_MAX));
        let res = null;
        try {
          res = body ? await host.api.post(body) : null;
        } catch (_) {
          res = null;
        }
        if (mine !== ws.token || !isOpen()) return;
        for (const r of (res && res.results) || []) fresh[r.id] = r.resolved ? r.resolved.overall || "unknown" : "unknown";
      }
      ws.fresh = fresh;
      setNotice(MSG.evaluated, false);
      paint();
    }

    function projectName(id) {
      const list = typeof host.projects === "function" ? host.projects() || [] : [];
      const p = list.find((x) => x.id === id);
      return p ? p.name : id || "Sans projet";
    }

    function select(id, label, options, value, onChange) {
      const s = el(doc, "select", { id, "aria-label": label });
      for (const [v, t] of options) {
        const o = el(doc, "option", { value: v, text: t });
        if (v === value) o.setAttribute("selected", "");
        s.appendChild(o);
      }
      s.value = value;
      s.addEventListener("change", () => onChange(s.value));
      return el(doc, "label", { class: "carnet-hx-field", for: id }, [el(doc, "span", { text: label }), s]);
    }

    function btn(text, attrs, onClick) {
      const b = el(doc, "button", Object.assign({ type: "button", class: "carnet-small", text }, attrs || {}));
      if (onClick) b.addEventListener("click", onClick);
      return b;
    }

    function listView() {
      const L = ws.list;
      const sec = el(doc, "div", { class: "carnet-ver-list-view" });
      sec.appendChild(el(doc, "p", { class: "hint", text: MSG.intro }));
      sec.appendChild(el(doc, "p", { class: "hint", "data-ver": "disclosure", text: MSG.disclosure }));
      const projects = Array.from(new Set(L.rows.map((r) => r.project_id).filter(Boolean)));
      if (ws.filters.project_id && projects.indexOf(ws.filters.project_id) < 0) projects.push(ws.filters.project_id);
      const bar = el(doc, "div", { class: "carnet-ix-projectbar carnet-ver-filters", role: "group", "aria-label": "Filtres" }, [
        select("hq-carnet-ver-f-project", "Projet", [["", "Tous"], ...projects.map((p) => [p, projectName(p)])], ws.filters.project_id, (v) => { ws.filters.project_id = v; loadList(); }),
        select("hq-carnet-ver-f-status", "Statut", [["", "Tous"], ...V.STATUSES.map((s) => [s, V.statusText(s)])], ws.filters.status, (v) => { ws.filters.status = v; loadList(); }),
        select("hq-carnet-ver-f-kind", "Type de cible", [["", "Tous"], ...V.KINDS.map((k) => [k, V.KIND_LABEL[k]])], ws.filters.target_kind, (v) => { ws.filters.target_kind = v; loadList(); }),
        select("hq-carnet-ver-f-fresh", "Fraîcheur (lignes chargées)", [["", "Toutes"], ["unchanged", "Inchangée"], ["changed", "Modifiée"], ["unknown", "Inconnue"], ["corrupt", "Altérée"], ["integrity_anomaly", "Anomalie d'intégrité"]], ws.filters.freshness, (v) => { ws.filters.freshness = v; paint(); }),
      ]);
      const txt = el(doc, "input", { type: "search", id: "hq-carnet-ver-f-text", "aria-label": "Rechercher dans les questions chargées", maxlength: "200", placeholder: "Dans les questions chargées…" });
      txt.value = ws.filters.text;
      txt.addEventListener("input", () => {
        ws.filters.text = txt.value;
        paintRowsOnly();
      });
      sec.appendChild(bar);
      sec.appendChild(el(doc, "div", { class: "carnet-hx-field" }, [el(doc, "span", { text: "Texte (vue chargée uniquement)" }), txt]));
      sec.appendChild(el(doc, "p", { class: "hint", "data-ver": "filter-disclosure", text: MSG.filterDisclosure }));
      if (ws.filters.freshness && !Object.keys(ws.fresh).length) sec.appendChild(el(doc, "p", { class: "hint", text: MSG.freshnessHint }));
      sec.appendChild(btn(MSG.evaluate, { id: "btn-carnet-ver-evaluate", "data-ver-act": "evaluate" }, evaluate));
      sec.appendChild(el(doc, "div", { id: "hq-carnet-ver-rows" }));
      return sec;
    }

    function rowsInto(box) {
      box.textContent = "";
      const L = ws.list;
      if (L.loading && !L.rows.length) return void box.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      if (L.failed) {
        box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: MSG.loadFailed }));
        box.appendChild(btn("Réessayer", { "data-ver-act": "retry" }, loadList));
        return;
      }
      const shown = V.filterRows(L.rows, { text: ws.filters.text, freshness: ws.filters.freshness }, ws.fresh);
      box.appendChild(el(doc, "p", { class: "hint", "data-ver": "summary", text: V.summaryText(L.counts) + (L.total ? " · " + L.total + " au total" : "") }));
      if (L.unavailable) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: L.unavailable + " " + MSG.untrusted }));
      if (L.truncated) box.appendChild(el(doc, "p", { class: "hint", text: MSG.truncated }));
      if (!shown.length) return void box.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ver-none", text: L.rows.length ? MSG.noneFiltered : MSG.none }));
      const g = V.group(shown);
      for (const grp of g.groups) {
        if (!grp.rows.length) continue;
        const s = el(doc, "section", { class: "carnet-ver-group", "data-ver-group": grp.status, "aria-labelledby": "hq-carnet-ver-g-" + grp.status });
        s.appendChild(el(doc, "h4", { id: "hq-carnet-ver-g-" + grp.status, text: grp.label + " (" + grp.rows.length + ")" }));
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": grp.label });
        for (const r of grp.rows) ul.appendChild(rowNode(r));
        s.appendChild(ul);
        box.appendChild(s);
      }
      if (g.other.length) {
        const s = el(doc, "section", { class: "carnet-ver-group", "data-ver-group": "unavailable" }, [el(doc, "h4", { text: "Lecture seule (altérées ou illisibles)" })]);
        const ul = el(doc, "ul", { class: "carnet-hx-list" });
        for (const r of g.other) ul.appendChild(rowNode(r));
        s.appendChild(ul);
        box.appendChild(s);
      }
    }

    function rowNode(r) {
      const bad = r.integrity !== "ok";
      const kids = [
        el(doc, "p", { class: "carnet-ask-meta" }, [
          el(doc, "span", { class: "carnet-chip", "data-ver-status": r.status || "invalid", text: bad ? (r.integrity === "corrupt" ? "Altérée" : "Illisible") : V.statusText(r.status) }),
          r.target ? el(doc, "span", { class: "carnet-chip", text: V.KIND_LABEL[r.target.kind] || "" }) : null,
          r.updated_at ? el(doc, "span", { class: "hint", text: "modifiée " + V.fmtDate(r.updated_at) }) : null,
        ]),
        el(doc, "p", { class: "carnet-ver-q", text: r.question || r.id }), // textContent
      ];
      if (r.signoff_count) kids.push(el(doc, "p", { class: "hint", text: "Vérification enregistrée : " + V.fmtDate(r.last_signoff_at) + (ws.fresh[r.id] ? " — " + V.overallText(ws.fresh[r.id]) : "") }));
      const open = btn(MSG.view, { "data-ver-act": "view", "data-id": r.id, "aria-label": MSG.view + " : " + (r.question || r.id).slice(0, 80) }, () => openDetail(r.id));
      kids.push(el(doc, "div", { class: "carnet-panel-row" }, [open]));
      return el(doc, "li", { class: "carnet-hx-item carnet-ver-row", "data-ver-row": r.id, "data-integrity": r.integrity }, kids);
    }

    function paintRowsOnly() {
      const box = ws.body && ws.body.querySelector("#hq-carnet-ver-rows");
      if (box) rowsInto(box);
    }

    // ------------------------------------------------------------ detail

    async function openDetail(id) {
      const mine = ++ws.token;
      ws.detail = { id, v: null, resolved: null, loading: true, failed: false };
      ws.confirm = null;
      ws.sign = false;
      ws.followOpen = false;
      ws.drafts = { question: null, note: null, followup: "" };
      ws.notice = ws.error = "";
      ws.pendingSign = null;
      paint();
      await reloadDetail(mine);
    }

    async function reloadDetail(mineArg) {
      const mine = mineArg || ++ws.token;
      const d = ws.detail;
      if (!d) return;
      const gb = V.getBody(d.id);
      let got = null;
      try {
        got = gb ? await host.api.post(gb) : null;
      } catch (_) {
        got = null;
      }
      if (mine !== ws.token || !isOpen() || ws.detail !== d) return;
      if (!got || !got.verification) {
        d.loading = false;
        d.failed = true;
        paint();
        return;
      }
      d.v = got.verification;
      d.loading = false;
      d.failed = false;
      paint();
      const rb = V.resolveBody(d.id);
      let res = null;
      try {
        res = rb ? await host.api.post(rb) : null;
      } catch (_) {
        res = null;
      }
      if (mine !== ws.token || !isOpen() || ws.detail !== d) return;
      d.resolved = res && res.resolved ? res.resolved : null;
      paint();
    }

    /** Exactly one mutation at a time; typed text is never discarded by a failure. */
    async function run(bodyObj, onOk) {
      if (ws.busy) return null;
      if (!bodyObj) {
        setNotice("Saisie invalide : rien n'a été envoyé.", true);
        paint();
        return null;
      }
      if (!online()) {
        setNotice(MSG.offline, true);
        paint();
        return null;
      }
      ws.busy = true;
      paint();
      try {
        const res = await host.api.post(bodyObj);
        ws.busy = false;
        if (res && res.verification && ws.detail) ws.detail.v = res.verification;
        onOk(res);
        paint();
        await reloadDetail();
        return res;
      } catch (err) {
        ws.busy = false;
        const info = V.errorInfo(err);
        if (info.conflict) {
          ws.confirm = null;
          ws.sign = false;
          setNotice(MSG.conflict, true);
          await reloadDetail();
        } else {
          if (info.definite) ws.pendingSign = null;
          setNotice(info.corrupt ? MSG.corrupt : info.full ? MSG.full : info.message, true);
          paint();
        }
        return null;
      }
    }

    function section(id, title, help) {
      const s = el(doc, "section", { class: "carnet-ver-block", id: "hq-carnet-ver-b-" + id, "data-ver-block": id, "aria-labelledby": "hq-carnet-ver-" + id + "-h" });
      s.appendChild(el(doc, "h4", { id: "hq-carnet-ver-" + id + "-h", text: title }));
      if (help) s.appendChild(el(doc, "p", { class: "hint", text: help }));
      return s;
    }

    function textarea(id, label, value, onInput) {
      const ta = el(doc, "textarea", { id, class: "carnet-ann-text", rows: "3", "aria-label": label });
      ta.value = value;
      const left = el(doc, "span", { class: "hint", "aria-live": "off", text: String(V.remaining(value)) });
      ta.addEventListener("input", () => {
        onInput(ta.value);
        left.textContent = String(V.remaining(ta.value));
      });
      return [ta, left];
    }

    function detailView() {
      const d = ws.detail;
      const box = el(doc, "div", { class: "carnet-ver-detail", "data-ver-detail": d.id });
      const back = btn("← Retour à la liste", { id: "btn-carnet-ver-back", "data-ver-act": "back" }, backToList);
      box.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [back]));
      if (d.loading) {
        box.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
        return box;
      }
      if (d.failed || !d.v) {
        box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: MSG.loadFailed }));
        return box;
      }
      const v = d.v;
      const corrupt = v.integrity !== "ok";
      const res = d.resolved;
      const editable = !corrupt && (v.status === "open" || v.status === "needs_followup");
      box.appendChild(el(doc, "p", { class: "carnet-ask-meta" }, [
        el(doc, "span", { class: "carnet-chip", id: "hq-carnet-ver-status", "data-ver-status": v.status, text: V.statusText(v.status) }),
        el(doc, "span", { class: "hint", text: "révision " + v.rev + " · modifiée " + V.fmtDate(v.updated_at) }),
      ]));
      if (corrupt) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-ver": "corrupt", text: MSG.corrupt }));
      if (ws.notice) box.appendChild(el(doc, "p", { class: "hint", role: "status", "data-ver": "notice", text: ws.notice }));
      if (ws.error) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-ver": "error", text: ws.error }));
      if (v.status === "needs_followup" && v.followup_note) box.appendChild(el(doc, "p", { class: "carnet-ver-followup", "data-ver": "followup", text: MSG.followupLabel + " : " + v.followup_note }));

      // ---- QUESTION
      const q = section("question", MSG.sections.question, editable ? MSG.questionHelp : null);
      if (editable) {
        const draft = ws.drafts.question === null ? v.question : ws.drafts.question;
        const [ta, left] = textarea("hq-carnet-ver-question", MSG.questionLabel, draft, (t) => { ws.drafts.question = t; });
        q.appendChild(ta);
        q.appendChild(left);
        q.appendChild(btn(MSG.save, { id: "btn-carnet-ver-q-save", "data-ver-act": "question-save", "aria-disabled": ws.busy || !online() ? "true" : null }, () => {
          const val = V.validateText(ws.drafts.question === null ? v.question : ws.drafts.question, true);
          if (!val.ok) { setNotice(val.reason, true); paint(); return; }
          run(V.updateBody(v, { question: val.text }), () => { ws.drafts.question = null; setNotice(MSG.saved, false); });
        }));
      } else q.appendChild(el(doc, "p", { class: "carnet-ver-q", "data-ver": "question", text: v.question }));
      box.appendChild(q);

      // ---- TARGET
      const t = section("target", MSG.sections.target, MSG.targetHelp);
      t.appendChild(el(doc, "p", { "data-ver": "target", text: V.refText(v.target) }));
      if (res) t.appendChild(el(doc, "p", { class: "hint", "data-ver": "target-state", text: res.has_signoff ? V.freshText(res.target.freshness) : V.existsText(res.target.exists) }));
      if (v.target.kind === "source" && typeof host.openReader === "function") t.appendChild(btn("Lire la preuve", { "data-ver-act": "reader", "aria-label": "Lire la source cible dans le lecteur" }, (ev) => host.openReader({ sourceId: v.target.source_id, trigger: ev.currentTarget })));
      box.appendChild(t);

      // ---- EVIDENCE
      const e = section("evidence", MSG.sections.evidence + " (" + v.evidence.length + ")", MSG.evidenceHelp);
      if (!v.evidence.length) e.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-ver-noevidence", text: MSG.noEvidence }));
      else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.sections.evidence });
        for (const ev of v.evidence) {
          const row = res ? res.evidence.find((x) => x.evidence_id === ev.id) : null;
          const li = el(doc, "li", { class: "carnet-hx-item carnet-ver-evidence", "data-ver-evidence": ev.id, "data-state": row ? (row.freshness || row.exists) : "" }, [
            el(doc, "span", { class: "carnet-chip", text: V.KIND_LABEL[ev.ref.kind] || "" }),
            el(doc, "span", { class: "carnet-hx-event-text", text: V.refText(ev.ref) }),
          ]);
          if (row) li.appendChild(el(doc, "span", { class: "hint", "data-ver": "evidence-state", "data-fresh": row.freshness || row.exists || "", text: res.has_signoff ? V.freshText(row.freshness) : V.existsText(row.exists) }));
          if (ev.ref.kind === "source" && typeof host.openReader === "function") li.appendChild(btn("Lire", { "data-ver-act": "reader", "aria-label": "Lire cette source dans le lecteur" }, (evn) => host.openReader({ sourceId: ev.ref.source_id, trigger: evn.currentTarget })));
          if (editable) li.appendChild(btn("Retirer la preuve", { "data-ver-act": "evidence-remove", "data-id": ev.id, "aria-label": "Retirer cette preuve : " + V.refText(ev.ref), "aria-disabled": ws.busy || !online() ? "true" : null }, () => run(V.evidenceRemoveBody(v, ev.id), () => setNotice(MSG.evidenceRemoved, false))));
          ul.appendChild(li);
        }
        e.appendChild(ul);
      }
      if (!editable && !corrupt) e.appendChild(el(doc, "p", { class: "hint", "data-ver": "frozen-edit", text: MSG.stateInvalid }));
      box.appendChild(e);

      // ---- CURRENT STATE
      const c = section("current", MSG.sections.current);
      if (!res) c.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      else if (res.has_signoff) {
        c.appendChild(el(doc, "p", { class: "carnet-ver-overall", "data-ver-overall": res.overall || "unknown", "data-ver": "overall", text: V.overallText(res.overall) }));
        if (res.definition_changed) c.appendChild(el(doc, "p", { class: "hint", "data-ver": "definition-changed", text: "La question ou les preuves ont été modifiées depuis le dernier enregistrement." }));
      } else c.appendChild(el(doc, "p", { class: "hint", text: "Aucun enregistrement : seule l'existence des éléments est indiquée." }));
      c.appendChild(btn("Actualiser l'état actuel", { id: "btn-carnet-ver-refresh", "data-ver-act": "refresh" }, () => { ws.detail.resolved = null; paint(); reloadDetail(); }));
      box.appendChild(c);

      // ---- SIGNOFF HISTORY
      const h = section("history", MSG.sections.history + " (" + v.signoffs.length + ")");
      h.appendChild(el(doc, "p", { class: "hint", "data-ver": "no-identity", text: MSG.disclosure }));
      if (!v.signoffs.length) h.appendChild(el(doc, "p", { class: "hint", text: "Aucune vérification enregistrée : rien n'a encore été consigné contre l'état de ces preuves." }));
      else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.sections.history });
        for (const s of v.signoffs.slice().reverse()) {
          ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-ver-signoff", "data-ver-signoff": s.id }, [
            el(doc, "strong", { text: "Vérification enregistrée : " + V.fmtDate(s.signed_at) }),
            el(doc, "span", { class: "hint", text: " · " + s.evidence.length + " preuve(s) · empreinte " + String(s.verification_fingerprint).slice(0, 12) + " · révision " + s.verification_rev }),
          ]));
        }
        h.appendChild(ul);
      }
      box.appendChild(h);

      // ---- COMMENTAIRE (note)
      const n = section("note", MSG.sections.note, MSG.noteHelp);
      if (!corrupt) {
        const draft = ws.drafts.note === null ? v.note : ws.drafts.note;
        const [ta, left] = textarea("hq-carnet-ver-note", MSG.sections.note, draft, (t) => { ws.drafts.note = t; });
        n.appendChild(ta);
        n.appendChild(left);
        n.appendChild(btn(MSG.save, { id: "btn-carnet-ver-note-save", "data-ver-act": "note-save", "aria-disabled": ws.busy || !online() ? "true" : null }, () => {
          const val = V.validateText(ws.drafts.note === null ? v.note : ws.drafts.note, false);
          if (!val.ok) { setNotice(val.reason, true); paint(); return; }
          run(V.updateBody(v, { note: val.text }), () => { ws.drafts.note = null; setNotice(MSG.saved, false); });
        }));
      } else n.appendChild(el(doc, "p", { class: "carnet-ver-q", text: v.note }));
      box.appendChild(n);

      if (!corrupt) box.appendChild(actions(v));
      return box;
    }

    function actions(v) {
      const a = el(doc, "section", { class: "carnet-ver-actions", id: "hq-carnet-ver-actions", "aria-label": "Actions" });
      const dis = ws.busy || !online() ? "true" : null;
      const row = el(doc, "div", { class: "carnet-panel-row" });
      if (v.status === "open") {
        row.appendChild(btn(MSG.ready, { id: "btn-carnet-ver-ready", "data-ver-act": "ready", "aria-disabled": dis || (v.evidence.length ? null : "true") }, () => run(V.statusBody(v, "ready"), () => setNotice(MSG.saved, false))));
      }
      if (v.status === "ready") {
        row.appendChild(btn(MSG.signoff, { id: "btn-carnet-ver-signoff", "data-ver-act": "signoff", "aria-disabled": dis || (v.evidence.length ? null : "true") }, () => { ws.sign = true; paint(); focusId("btn-carnet-ver-signoff-yes"); }));
      }
      if (v.status === "verified" || v.status === "needs_followup" || v.status === "ready") {
        row.appendChild(btn(MSG.reopen, { id: "btn-carnet-ver-reopen", "data-ver-act": "reopen", "aria-disabled": dis }, () => run(V.statusBody(v, "open"), () => setNotice(MSG.saved, false))));
      }
      row.appendChild(btn(MSG.followup, { id: "btn-carnet-ver-followup", "data-ver-act": "followup", "aria-disabled": dis }, () => { ws.followOpen = true; paint(); focusId("hq-carnet-ver-followup-text"); }));
      if (!v.signoffs.length) row.appendChild(btn(MSG.del, { id: "btn-carnet-ver-delete", "data-ver-act": "delete", "aria-disabled": dis }, () => { ws.confirm = { id: v.id, rev: v.rev }; paint(); focusId("btn-carnet-ver-delete-yes"); }));
      else row.appendChild(el(doc, "span", { class: "hint", "data-ver": "has-signoff", text: MSG.hasSignoff }));
      a.appendChild(row);
      if (ws.followOpen) {
        const [ta, left] = textarea("hq-carnet-ver-followup-text", MSG.followupLabel, ws.drafts.followup, (t) => { ws.drafts.followup = t; });
        a.appendChild(el(doc, "div", { class: "carnet-ver-confirm", role: "group", "aria-label": MSG.followup }, [ta, left,
          btn(MSG.followupConfirm, { id: "btn-carnet-ver-followup-yes", "data-ver-act": "followup-confirm" }, () => {
            const val = V.validateText(ws.drafts.followup, true);
            if (!val.ok) { setNotice(val.reason, true); paint(); return; }
            run(V.statusBody(v, "needs_followup", val.text), () => { ws.followOpen = false; ws.drafts.followup = ""; setNotice(MSG.saved, false); });
          }),
          btn(MSG.cancel, { "data-ver-act": "followup-cancel" }, () => { ws.followOpen = false; paint(); })]));
      }
      if (ws.sign && v.status === "ready") {
        const key = v.id + ":" + v.rev;
        const yes = btn(MSG.signoffConfirm, { id: "btn-carnet-ver-signoff-yes", "data-ver-act": "signoff-confirm", "aria-disabled": dis }, () => {
          if (!ws.pendingSign || ws.pendingSign.key !== key) ws.pendingSign = { key, requestId: rid() }; // same intent after a lost answer => same id
          run(V.signoffBody(v, ws.pendingSign.requestId), (res) => {
            ws.sign = false;
            ws.pendingSign = null;
            setNotice(res && res.replayed ? MSG.signoffReplayed : MSG.signoffDone, false);
          });
        });
        a.appendChild(el(doc, "div", { class: "carnet-ver-confirm", role: "alertdialog", "aria-label": MSG.signoff }, [
          el(doc, "p", { text: MSG.signoffHelp }), el(doc, "p", { class: "hint", text: MSG.disclosure }),
          el(doc, "div", { class: "carnet-panel-row" }, [yes, btn(MSG.cancel, { "data-ver-act": "signoff-cancel" }, () => { ws.sign = false; paint(); })]),
        ]));
      }
      if (ws.confirm && ws.confirm.id === v.id) {
        const yes = btn(MSG.delConfirmYes, { id: "btn-carnet-ver-delete-yes", "data-ver-act": "delete-confirm" }, () => {
          const seen = { id: ws.confirm.id, rev: ws.confirm.rev, signoffs: v.signoffs };
          run(V.deleteBody(seen, true), () => { ws.confirm = null; ws.detail = null; setNotice(MSG.deleted, false); loadList(); });
        });
        a.appendChild(el(doc, "div", { class: "carnet-ver-confirm", role: "alertdialog", "aria-label": MSG.delConfirm }, [el(doc, "p", { text: MSG.delConfirm }),
          el(doc, "div", { class: "carnet-panel-row" }, [yes, btn(MSG.cancel, { "data-ver-act": "delete-cancel" }, () => { ws.confirm = null; paint(); })])]));
      }
      return a;
    }

    function focusId(id) {
      const n = ws.body && ws.body.querySelector("#" + id);
      if (n) n.focus({ preventScroll: true });
    }

    function paint() {
      if (!isOpen()) return;
      const had = ws.dlg.contains(doc.activeElement) ? doc.activeElement : null;
      const hadId = had && had.id ? had.id : null;
      const scroll = ws.body.scrollTop;
      ws.body.textContent = "";
      if (ws.detail) ws.body.appendChild(detailView());
      else {
        if (ws.notice) ws.body.appendChild(el(doc, "p", { class: "hint", role: "status", text: ws.notice }));
        if (ws.error) ws.body.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: ws.error }));
        const lv = listView();
        ws.body.appendChild(lv);
        rowsInto(lv.querySelector("#hq-carnet-ver-rows"));
      }
      ws.body.scrollTop = scroll;
      if (hadId) {
        const again = ws.body.querySelector("#" + hadId.replace(/([^\w-])/g, "\\$1"));
        if (again && again !== doc.activeElement) again.focus({ preventScroll: true });
      }
    }

    // ============================================================ related-verifications panel (Reader, Review Pack)

    /**
     * spec: {id, refs:[{key,label,ref}], frozen, say?, onChange?}. `ref` is what the server needs to LOCATE the identity (a citation as its value, a review item as its ids).
     * ONE batched `verification_related` for every ref shown. Returns {node, reload, destroy}.
     */
    function panel(spec) {
      const pid = spec.id || "hq-carnet-ver-panel";
      const st = {
        results: new Map(), loading: true, failed: false, truncated: false, unavailable: 0, expanded: !!spec.expanded, busy: false, notice: "", error: "",
        draft: "", choice: spec.refs[0] && spec.refs[0].key, pending: null, createOpen: false, addOpen: false, candidates: null, candidate: "", alive: true,
      };
      const rootEl = el(doc, "section", { class: "carnet-ver-panel", id: pid, "aria-labelledby": pid + "-h", "data-frozen": spec.frozen ? "1" : "0" });
      let token = 0;
      const sayIt = (t) => { if (typeof spec.say === "function") spec.say(t); };

      async function load() {
        const mine = ++token;
        st.loading = true;
        st.failed = false;
        paint();
        const body = V.relatedBody(spec.refs.map((r) => r.ref));
        let res = null;
        try {
          res = body ? await host.api.post(body) : null;
        } catch (_) {
          res = null;
        }
        if (mine !== token || !st.alive) return;
        st.loading = false;
        if (!res || !Array.isArray(res.results)) {
          st.failed = true;
          paint();
          return;
        }
        st.truncated = !!res.truncated;
        st.unavailable = res.unavailable || 0;
        st.results = new Map();
        const deduped = [];
        spec.refs.forEach((r) => { if (!deduped.find((x) => JSON.stringify(x.ref) === JSON.stringify(r.ref))) deduped.push(r); });
        res.results.forEach((r, i) => { if (deduped[i]) st.results.set(deduped[i].key, r); });
        paint();
      }

      function allRows() {
        const seen = new Map();
        for (const r of st.results.values()) for (const x of r.verifications) if (!seen.has(x.id)) seen.set(x.id, x);
        return Array.from(seen.values());
      }

      function counts() {
        const c = { open: 0, ready: 0, verified: 0, needs_followup: 0 };
        for (const x of allRows()) if (c[x.status] !== undefined) c[x.status]++;
        return c;
      }

      async function act(bodyObj, okText) {
        if (st.busy) return false;
        if (!bodyObj) { st.error = "Saisie invalide : rien n'a été envoyé."; paint(); return false; }
        if (!online()) { st.error = MSG.offline; paint(); return false; }
        st.busy = true;
        paint();
        try {
          await host.api.post(bodyObj);
          st.busy = false;
          st.error = "";
          st.notice = okText;
          sayIt(okText);
          if (typeof spec.onChange === "function") spec.onChange();
          await load();
          return true;
        } catch (err) {
          st.busy = false;
          const info = V.errorInfo(err);
          if (info.definite) st.pending = null;
          st.error = info.conflict ? MSG.conflict : info.corrupt ? MSG.corrupt : info.full ? MSG.full : info.message;
          sayIt(st.error);
          paint();
          return false;
        }
      }

      function create() {
        const r = spec.refs.find((x) => x.key === st.choice) || spec.refs[0];
        const val = V.validateText(st.draft, true);
        if (!val.ok) { st.error = val.reason; paint(); return; }
        const sig = JSON.stringify([r.key, st.draft]);
        if (!st.pending || st.pending.sig !== sig) st.pending = { sig, requestId: rid() };
        act(V.createBody(r.ref, st.draft, st.pending.requestId, spec.projectId || null), MSG.createDone).then((ok) => {
          if (ok) { st.draft = ""; st.pending = null; st.createOpen = false; paint(); }
        });
      }

      async function loadCandidates() {
        st.candidates = [];
        const rows = [];
        for (const status of ["open", "needs_followup"]) {
          try {
            const res = await host.api.post(V.listBody({ status }));
            if (res && Array.isArray(res.verifications)) rows.push(...res.verifications.filter((x) => x.integrity === "ok"));
          } catch (_) { /* a failed candidate list leaves the select empty; nothing is written */ }
        }
        if (!st.alive) return;
        st.candidates = rows;
        st.candidate = rows[0] ? rows[0].id : "";
        paint();
      }

      async function addEvidence() {
        const r = spec.refs.find((x) => x.key === st.choice) || spec.refs[0];
        const cand = (st.candidates || []).find((x) => x.id === st.candidate);
        if (!cand) { st.error = "Choisis une vérification ouverte."; paint(); return; }
        const ok = await act(V.evidenceAddBody(cand, r.ref), MSG.evidenceAdded);
        if (ok) { st.addOpen = false; paint(); }
      }

      function rowNode(x) {
        const kids = [
          el(doc, "p", { class: "carnet-ask-meta" }, [
            el(doc, "span", { class: "carnet-chip", "data-ver-status": x.status, text: V.statusText(x.status) }),
            el(doc, "span", { class: "hint", text: x.role === "target" ? "cible" : "preuve" }),
          ]),
          el(doc, "p", { class: "carnet-ver-q", text: x.question }), // textContent
        ];
        if (x.signoff_count) kids.push(el(doc, "p", { class: "hint", text: "Vérification enregistrée : " + V.fmtDate(x.last_signoff_at) }));
        kids.push(el(doc, "div", { class: "carnet-panel-row" }, [btn(MSG.view, { "data-ver-act": "view", "data-id": x.id, "aria-label": MSG.view + " : " + x.question.slice(0, 80) }, (ev) => open(ev.currentTarget, { id: x.id }))]));
        return el(doc, "li", { class: "carnet-ver-row", "data-ver-row": x.id }, kids);
      }

      function paint() {
        if (!st.alive) return;
        const had = rootEl.contains(doc.activeElement) ? doc.activeElement : null;
        const hadId = had && had.id ? had.id : null;
        rootEl.textContent = "";
        const rows = allRows();
        const label = st.loading && !st.results.size ? MSG.loading : st.failed ? MSG.loadFailed : V.summaryText(counts());
        const toggle = el(doc, "button", { type: "button", class: "carnet-small carnet-ver-toggle", id: pid + "-toggle", "data-reader-panel": "ver", "aria-expanded": st.expanded ? "true" : "false", "aria-controls": pid + "-body" });
        toggle.appendChild(el(doc, "span", { id: pid + "-h", class: "carnet-ver-heading", text: (spec.frozen ? MSG.frozenHeading : MSG.liveHeading) + " : " }));
        toggle.appendChild(el(doc, "span", { "data-ver": "summary", text: label }));
        toggle.addEventListener("click", () => { st.expanded = !st.expanded; paint(); });
        rootEl.appendChild(toggle);
        if (!st.expanded) { restoreFocus(hadId); return; }
        const bodyEl = el(doc, "div", { class: "carnet-ver-panel-body", id: pid + "-body" });
        bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.intro }));
        if (spec.frozen) bodyEl.appendChild(el(doc, "p", { class: "hint", "data-ver": "not-frozen", text: MSG.frozenNote }));
        if (st.notice) bodyEl.appendChild(el(doc, "p", { class: "hint", role: "status", "data-ver": "notice", text: st.notice }));
        if (st.error) bodyEl.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-ver": "error", text: st.error }));
        if (st.failed) bodyEl.appendChild(btn("Réessayer", { "data-ver-act": "retry" }, load));
        if (st.unavailable) bodyEl.appendChild(el(doc, "p", { class: "hint", text: st.unavailable + " " + MSG.untrusted }));
        if (!st.loading && !st.failed && !rows.length) bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.noneHere }));
        if (rows.length) {
          const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.liveHeading });
          for (const x of rows) ul.appendChild(rowNode(x));
          bodyEl.appendChild(ul);
        }
        if (st.truncated) bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.truncated }));
        // ---- actions
        const bar = el(doc, "div", { class: "carnet-panel-row" });
        bar.appendChild(btn(MSG.create, { id: pid + "-create", "data-ver-act": "create-open", "aria-expanded": st.createOpen ? "true" : "false", "aria-disabled": st.busy || !online() ? "true" : null }, () => { st.createOpen = !st.createOpen; st.addOpen = false; paint(); if (st.createOpen) focusIn(pid + "-q"); }));
        bar.appendChild(btn(MSG.addEvidence, { id: pid + "-add", "data-ver-act": "add-open", "aria-expanded": st.addOpen ? "true" : "false", "aria-disabled": st.busy || !online() ? "true" : null }, () => { st.addOpen = !st.addOpen; st.createOpen = false; if (st.addOpen && st.candidates === null) loadCandidates(); paint(); }));
        bar.appendChild(btn("Ouvrir les vérifications", { id: pid + "-workspace", "data-ver-act": "workspace" }, (ev) => open(ev.currentTarget, null)));
        bodyEl.appendChild(bar);
        if (spec.refs.length > 1 && (st.createOpen || st.addOpen)) {
          const fs = el(doc, "fieldset", { class: "carnet-ann-target" }, [el(doc, "legend", { text: "Cible / preuve" })]);
          for (const r of spec.refs) {
            const id = pid + "-ref-" + r.key;
            const inp = el(doc, "input", { type: "radio", name: pid + "-ref", id, value: r.key });
            if (st.choice === r.key) inp.setAttribute("checked", "checked");
            inp.addEventListener("change", () => { st.choice = r.key; });
            fs.appendChild(el(doc, "label", { for: id }, [inp, doc.createTextNode(" " + r.label)]));
          }
          bodyEl.appendChild(fs);
        }
        if (st.createOpen) {
          const ta = el(doc, "textarea", { id: pid + "-q", class: "carnet-ann-text", rows: "3", "aria-label": MSG.questionLabel });
          ta.value = st.draft;
          const left = el(doc, "span", { class: "hint", text: String(V.remaining(st.draft)) });
          ta.addEventListener("input", () => { st.draft = ta.value; left.textContent = String(V.remaining(st.draft)); });
          bodyEl.appendChild(el(doc, "div", { class: "carnet-ver-form" }, [ta, left, el(doc, "p", { class: "hint", text: MSG.questionHelp }),
            btn(MSG.create, { id: pid + "-create-yes", "data-ver-act": "create", "aria-disabled": st.busy || !online() ? "true" : null }, create)]));
        }
        if (st.addOpen) {
          const f = el(doc, "div", { class: "carnet-ver-form" });
          if (st.candidates === null) f.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
          else if (!st.candidates.length) f.appendChild(el(doc, "p", { class: "hint", text: "Aucune vérification ouverte ou à reprendre : crées-en une d'abord." }));
          else {
            f.appendChild(select(pid + "-cand", MSG.addEvidenceTo, st.candidates.map((x) => [x.id, x.question.slice(0, 80)]), st.candidate, (v) => { st.candidate = v; }));
            f.appendChild(btn(MSG.addEvidence, { id: pid + "-add-yes", "data-ver-act": "add", "aria-disabled": st.busy || !online() ? "true" : null }, addEvidence));
          }
          bodyEl.appendChild(f);
        }
        rootEl.appendChild(bodyEl);
        restoreFocus(hadId);
      }

      function focusIn(id) {
        const n = rootEl.querySelector("#" + id);
        if (n) n.focus({ preventScroll: true });
      }

      function restoreFocus(hadId) {
        if (!hadId) return;
        const again = rootEl.querySelector("#" + hadId.replace(/([^\w-])/g, "\\$1"));
        if (again && again !== doc.activeElement) again.focus({ preventScroll: true });
      }

      paint();
      load();
      return { node: rootEl, reload: load, destroy: () => { st.alive = false; token++; }, state: () => st };
    }

    return { open, close, isOpen, panel, openDetail: (id, trigger) => open(trigger || null, { id }), state: () => ws };
  }

  return { mount, el };
});
