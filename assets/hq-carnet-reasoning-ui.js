/* Transfert HQ — Carnet Phase 12: decisions & assumptions register workspace + related panel (DOM).
 *
 *   workspace — ONE shared-modal list grouped Décisions actives / historiques, Hypothèses actives / confirmées / invalidées / retirées / remplacées
 *               (≤100 headers, one list request), a detail view split into STATEMENT / RATIONALE / EVIDENCE / VERIFICATIONS / CURRENT EVIDENCE STATE / HISTORY.
 *   panel     — a quiet summary for the Reader and the Review Pack: ONE batched related-lookup for ≤10 identities; "Créer une décision / hypothèse"
 *               pre-attaches the opened source or citation as evidence.
 *
 * A record is not evidence and a status changes ONLY through an explicit action. No Kanban, priority, due date, assignee, confidence or reviewer name
 * exists here. Every user text is rendered with textContent (a hostile "<script>" is text). A stale write (409) reloads the server version, KEEPS the
 * typed text and never retries by itself; a create / supersede retried after a lost answer reuses the SAME request id. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReasoningUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const R = node ? require("./hq-carnet-reasoning.js") : global.HqCarnetReasoning;
  const M = node ? require("./hq-carnet-modal.js") : global.HqCarnetModal;
  const MSG = R.MSG;

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
    const rid = () => R.newRequestId(host.crypto || (doc.defaultView && doc.defaultView.crypto));
    const rootNode = () => (typeof host.root === "function" ? host.root() : host.root) || doc.body;
    const projects = () => (typeof host.projects === "function" ? host.projects() || [] : []);

    // ============================================================ workspace (shared modal)

    const ws = {
      handle: null, dlg: null, body: null, live: null, opener: null, token: 0,
      list: { rows: [], counts: {}, total: 0, unavailable: 0, truncated: false, loading: false, failed: false },
      filters: { project_id: "", kind: "", status: "", freshness: "", verification: "", text: "" },
      fresh: {}, detail: null, busy: false, notice: "", error: "",
      drafts: { statement: null, rationale: null, sStatement: "", sRationale: "" },
      confirm: null, // {type:"status", status} | {type:"supersede"} | {type:"delete"} | {type:"link"}
      pendingSup: null, createForm: null, pendingCreate: null, linkChoices: null, linkChoice: "",
    };

    const say = (text) => { if (ws.live) ws.live.textContent = text || ""; };

    function setNotice(text, isError) {
      ws.notice = isError ? "" : text;
      ws.error = isError ? text : "";
      say(text);
    }

    const isOpen = () => !!(ws.handle && !ws.handle.closed);

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
      ws.live = el(doc, "p", { id: "hq-carnet-rsn-live", class: "carnet-msg", role: "status", "aria-live": "polite" });
      ws.body = el(doc, "div", { class: "carnet-hx-body carnet-rsn-body", id: "hq-carnet-rsn-body" });
      const closeBtn = el(doc, "button", { type: "button", id: "btn-carnet-rsn-close", class: "carnet-btn carnet-hx-close", "aria-label": "Fermer", text: "✕" });
      closeBtn.addEventListener("click", () => close(true));
      const head = el(doc, "div", { class: "carnet-hx-head" }, [el(doc, "h3", { id: "hq-carnet-rsn-title", text: MSG.title }), closeBtn]);
      ws.dlg = el(doc, "div", { id: "hq-carnet-rsn", class: "carnet-hx carnet-rsn", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-rsn-title" }, [head, ws.live, ws.body]);
      ws.handle = M.open(doc, ws.dlg, { trigger: opener || null, initial: closeBtn, mount: (n) => rootNode().appendChild(n), onEscape });
      ws.detail = null;
      ws.createForm = null;
      ws.notice = ws.error = "";
      if (opts && opts.id) openDetail(opts.id);
      else loadList();
      return true;
    }

    function onEscape() {
      if (ws.confirm || ws.createForm) {
        ws.confirm = null;
        ws.createForm = null;
        paint();
        return;
      }
      if (ws.detail) return void backToList();
      close(true);
    }

    function backToList() {
      ws.detail = null;
      ws.confirm = null;
      ws.notice = ws.error = "";
      loadList();
    }

    // ------------------------------------------------------------ list

    async function loadList() {
      const mine = ++ws.token;
      ws.list.loading = true;
      ws.list.failed = false;
      paint();
      const body = R.listBody({ project_id: ws.filters.project_id, kind: ws.filters.kind, status: ws.filters.status });
      let res = null;
      try {
        res = body ? await host.api.post(body) : null;
      } catch (_) {
        res = null;
      }
      if (mine !== ws.token || !isOpen()) return;
      ws.list.loading = false;
      if (!res || !Array.isArray(res.records)) {
        ws.list.failed = true;
        paint();
        return;
      }
      ws.list.rows = res.records;
      ws.list.counts = res.counts || {};
      ws.list.total = res.total || res.records.length;
      ws.list.unavailable = res.unavailable || 0;
      ws.list.truncated = !!res.truncated;
      ws.fresh = {};
      paint();
    }

    /** ONE batched, read-only request per ≤25 historical rows. Nothing is written. */
    async function evaluate() {
      const ids = ws.list.rows.filter((r) => r.integrity === "ok" && R.isHistorical(r)).map((r) => r.id);
      const mine = ws.token;
      const fresh = {};
      for (let at = 0; at < ids.length; at += R.RESOLVE_IDS_MAX) {
        const body = R.resolveBody(ids.slice(at, at + R.RESOLVE_IDS_MAX));
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
      const p = projects().find((x) => x.id === id);
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

    function textarea(id, label, value, max, onInput) {
      const ta = el(doc, "textarea", { id, class: "carnet-ann-text", rows: "3", "aria-label": label });
      ta.value = value;
      const left = el(doc, "span", { class: "hint", "aria-live": "off", text: String(R.remaining(value, max)) });
      ta.addEventListener("input", () => {
        onInput(ta.value);
        left.textContent = String(R.remaining(ta.value, max));
      });
      return [ta, left];
    }

    function listView() {
      const L = ws.list;
      const sec = el(doc, "div", { class: "carnet-rsn-list-view" });
      sec.appendChild(el(doc, "p", { class: "hint", text: MSG.intro }));
      sec.appendChild(el(doc, "p", { class: "hint", "data-rsn": "disclosure", text: MSG.disclosure }));
      sec.appendChild(el(doc, "p", { class: "hint", "data-rsn": "journal-distinct", text: MSG.journalDistinct }));
      const ids = Array.from(new Set(L.rows.map((r) => r.project_id).filter(Boolean)));
      if (ws.filters.project_id && ids.indexOf(ws.filters.project_id) < 0) ids.push(ws.filters.project_id);
      const statuses = R.ALL_STATUSES.concat(["supersession_pending", "supersession_indeterminate"]);
      const bar = el(doc, "div", { class: "carnet-ix-projectbar carnet-rsn-filters", role: "group", "aria-label": "Filtres" }, [
        select("hq-carnet-rsn-f-project", "Projet", [["", "Tous"], ...ids.map((p) => [p, projectName(p)])], ws.filters.project_id, (v) => { ws.filters.project_id = v; loadList(); }),
        select("hq-carnet-rsn-f-kind", "Type", [["", "Tous"], ...R.KINDS.map((k) => [k, R.KIND_LABEL[k]])], ws.filters.kind, (v) => { ws.filters.kind = v; loadList(); }),
        select("hq-carnet-rsn-f-status", "Statut", [["", "Tous"], ...statuses.map((s) => [s, R.STATUS_LABEL[s]])], ws.filters.status, (v) => { ws.filters.status = v; loadList(); }),
        select("hq-carnet-rsn-f-fresh", "Fraîcheur (lignes chargées)", [["", "Toutes"], ["unchanged", "Inchangée"], ["changed", "Modifiée"], ["unknown", "Inconnue"], ["corrupt", "Altérée"], ["integrity_anomaly", "Anomalie d'intégrité"]], ws.filters.freshness, (v) => { ws.filters.freshness = v; paint(); }),
        select("hq-carnet-rsn-f-ver", "Vérifications liées", [["", "Toutes"], ["linked", "Avec vérification"], ["none", "Sans vérification"]], ws.filters.verification, (v) => { ws.filters.verification = v; paint(); }),
      ]);
      const txt = el(doc, "input", { type: "search", id: "hq-carnet-rsn-f-text", "aria-label": "Rechercher dans les énoncés chargés", maxlength: "200", placeholder: "Dans les énoncés chargés…" });
      txt.value = ws.filters.text;
      txt.addEventListener("input", () => {
        ws.filters.text = txt.value;
        paintRowsOnly();
      });
      const make = el(doc, "div", { class: "carnet-panel-row" }, [
        btn(MSG.createDecision, { id: "btn-carnet-rsn-new-dec", "data-rsn-act": "new-decision" }, () => openCreate(R.KIND_DECISION)),
        btn(MSG.createAssumption, { id: "btn-carnet-rsn-new-asm", "data-rsn-act": "new-assumption" }, () => openCreate(R.KIND_ASSUMPTION)),
      ]);
      sec.appendChild(make);
      if (ws.createForm) sec.appendChild(createForm());
      sec.appendChild(bar);
      sec.appendChild(el(doc, "div", { class: "carnet-hx-field" }, [el(doc, "span", { text: "Texte (vue chargée uniquement)" }), txt]));
      sec.appendChild(el(doc, "p", { class: "hint", "data-rsn": "filter-disclosure", text: MSG.filterDisclosure }));
      if (ws.filters.freshness && !Object.keys(ws.fresh).length) sec.appendChild(el(doc, "p", { class: "hint", text: MSG.freshnessHint }));
      sec.appendChild(btn(MSG.evaluate, { id: "btn-carnet-rsn-evaluate", "data-rsn-act": "evaluate" }, evaluate));
      sec.appendChild(el(doc, "div", { id: "hq-carnet-rsn-rows" }));
      return sec;
    }

    // ------------------------------------------------------------ create (workspace)

    function openCreate(kind) {
      const list = projects();
      ws.createForm = { kind, project_id: ws.filters.project_id || (list[0] && list[0].id) || "", statement: "", rationale: "" };
      ws.pendingCreate = null;
      paint();
      focusId("hq-carnet-rsn-new-statement");
    }

    function createForm() {
      const f = ws.createForm;
      const box = el(doc, "div", { class: "carnet-rsn-form", id: "hq-carnet-rsn-new", role: "group", "aria-label": f.kind === R.KIND_DECISION ? MSG.createDecision : MSG.createAssumption });
      const list = projects();
      if (!list.length) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: "Aucun projet : crée un projet avant d'enregistrer une décision ou une hypothèse." }));
      else box.appendChild(select("hq-carnet-rsn-new-project", "Projet", list.map((p) => [p.id, p.name]), f.project_id, (v) => { f.project_id = v; }));
      const help = f.kind === R.KIND_DECISION ? MSG.statementHelpDecision : MSG.statementHelpAssumption;
      const [ta, left] = textarea("hq-carnet-rsn-new-statement", MSG.statementLabel, f.statement, R.STATEMENT_MAX, (t) => { f.statement = t; });
      const [tr, leftR] = textarea("hq-carnet-rsn-new-rationale", MSG.rationaleLabel, f.rationale, R.RATIONALE_MAX, (t) => { f.rationale = t; });
      box.appendChild(el(doc, "p", { class: "hint", text: help }));
      box.appendChild(ta);
      box.appendChild(left);
      box.appendChild(el(doc, "p", { class: "hint", text: MSG.rationaleHelp }));
      box.appendChild(tr);
      box.appendChild(leftR);
      box.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [
        btn(MSG.create, { id: "btn-carnet-rsn-new-yes", "data-rsn-act": "create", "aria-disabled": ws.busy || !online() ? "true" : null }, submitCreate),
        btn(MSG.cancel, { "data-rsn-act": "create-cancel" }, () => { ws.createForm = null; paint(); }),
      ]));
      return box;
    }

    async function submitCreate() {
      const f = ws.createForm;
      if (!f) return;
      const s = R.validateStatement(f.statement);
      if (!s.ok) return void (setNotice(s.reason, true), paint());
      const rr = R.validateRationale(f.rationale);
      if (!rr.ok) return void (setNotice(rr.reason, true), paint());
      const sig = JSON.stringify([f.kind, f.project_id, f.statement, f.rationale]);
      if (!ws.pendingCreate || ws.pendingCreate.sig !== sig) ws.pendingCreate = { sig, requestId: rid() }; // same intent after a lost answer => same id
      const res = await run(R.createBody(f.kind, f.project_id, f.statement, f.rationale, ws.pendingCreate.requestId), () => {}, true);
      if (res && res.record) {
        ws.createForm = null;
        ws.pendingCreate = null;
        setNotice(MSG.createDone, false);
        openDetail(res.record.id);
      }
    }

    function rowsInto(box) {
      box.textContent = "";
      const L = ws.list;
      if (L.loading && !L.rows.length) return void box.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      if (L.failed) {
        box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: MSG.loadFailed }));
        box.appendChild(btn("Réessayer", { "data-rsn-act": "retry" }, loadList));
        return;
      }
      const shown = R.filterRows(L.rows, { text: ws.filters.text, freshness: ws.filters.freshness, verification: ws.filters.verification }, ws.fresh);
      box.appendChild(el(doc, "p", { class: "hint", "data-rsn": "summary", text: R.summaryText(L.counts) + (L.total ? " · " + L.total + " au total" : "") }));
      if (L.unavailable) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: L.unavailable + " " + MSG.untrusted }));
      if (L.truncated) box.appendChild(el(doc, "p", { class: "hint", text: MSG.truncated }));
      if (!shown.length) return void box.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rsn-none", text: L.rows.length ? MSG.noneFiltered : MSG.none }));
      const g = R.group(shown);
      if (g.other.length) {
        const s = el(doc, "section", { class: "carnet-rsn-group", "data-rsn-group": "unavailable" }, [el(doc, "h4", { text: "Lecture seule (altérés ou illisibles) (" + g.other.length + ")" })]);
        const ul = el(doc, "ul", { class: "carnet-hx-list" });
        for (const r of g.other) ul.appendChild(rowNode(r));
        s.appendChild(ul);
        box.appendChild(s);
      }
      if (g.pending.length) {
        const s = el(doc, "section", { class: "carnet-rsn-group", "data-rsn-group": "pending" }, [el(doc, "h4", { text: "Remplacement non terminé (" + g.pending.length + ")" })]);
        const ul = el(doc, "ul", { class: "carnet-hx-list" });
        for (const r of g.pending) ul.appendChild(rowNode(r));
        s.appendChild(ul);
        box.appendChild(s);
      }
      for (const grp of g.groups) {
        if (!grp.rows.length) continue;
        const s = el(doc, "section", { class: "carnet-rsn-group", "data-rsn-group": grp.id, "aria-labelledby": "hq-carnet-rsn-g-" + grp.id });
        s.appendChild(el(doc, "h4", { id: "hq-carnet-rsn-g-" + grp.id, text: grp.label + " (" + grp.rows.length + ")" }));
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": grp.label });
        for (const r of grp.rows) ul.appendChild(rowNode(r));
        s.appendChild(ul);
        box.appendChild(s);
      }
    }

    function rowNode(r) {
      const bad = r.integrity !== "ok";
      const eff = r.effective_status || r.status;
      const kids = [
        el(doc, "p", { class: "carnet-ask-meta" }, [
          el(doc, "span", { class: "carnet-chip", "data-rsn-kind": r.kind, text: R.KIND_LABEL[r.kind] || "" }),
          el(doc, "span", { class: "carnet-chip", "data-rsn-status": bad ? r.integrity : eff, text: bad ? (r.integrity === "corrupt" ? "Altéré" : "Illisible") : R.statusText(r) }),
          r.updated_at ? el(doc, "span", { class: "hint", text: "modifié " + R.fmtDate(r.updated_at) }) : null,
        ]),
        el(doc, "p", { class: "carnet-rsn-q", text: r.statement || r.id }), // textContent
      ];
      if (!bad) kids.push(el(doc, "p", { class: "hint", text: (r.evidence_count || 0) + " preuve(s) · " + (r.verification_count || 0) + " vérification(s) liée(s)" + (ws.fresh[r.id] ? " — " + R.freshText(ws.fresh[r.id]) : "") }));
      const open = btn(MSG.view, { "data-rsn-act": "view", "data-id": r.id, "aria-label": MSG.view + " : " + (r.statement || r.id).slice(0, 80) }, () => openDetail(r.id));
      kids.push(el(doc, "div", { class: "carnet-panel-row" }, [open]));
      return el(doc, "li", { class: "carnet-hx-item carnet-rsn-row", "data-rsn-row": r.id, "data-integrity": r.integrity }, kids);
    }

    function paintRowsOnly() {
      const box = ws.body && ws.body.querySelector("#hq-carnet-rsn-rows");
      if (box) rowsInto(box);
    }

    // ------------------------------------------------------------ detail

    async function openDetail(id) {
      const mine = ++ws.token;
      ws.detail = { id, r: null, resolved: null, loading: true, failed: false };
      ws.confirm = null;
      ws.createForm = null;
      ws.drafts = { statement: null, rationale: null, sStatement: "", sRationale: "" };
      ws.pendingSup = null;
      ws.linkChoices = null;
      ws.notice = ws.error = "";
      paint();
      await reloadDetail(mine);
    }

    async function reloadDetail(mineArg) {
      const mine = mineArg || ++ws.token;
      const d = ws.detail;
      if (!d) return;
      const gb = R.getBody(d.id);
      let got = null;
      try {
        got = gb ? await host.api.post(gb) : null;
      } catch (err) {
        got = err && err.data && err.data.code === "reasoning_corrupt" ? { corrupt: true } : null;
      }
      if (mine !== ws.token || !isOpen() || ws.detail !== d) return;
      if (!got || (!got.record && !got.corrupt)) {
        d.loading = false;
        d.failed = true;
        paint();
        return;
      }
      d.r = got.record || { id: d.id, integrity: "corrupt", kind: d.id.indexOf("asm-") === 0 ? R.KIND_ASSUMPTION : R.KIND_DECISION, status: null, statement: "", rationale: "", evidence: [], verification_ids: [], history: [], rev: 0 };
      d.loading = false;
      d.failed = false;
      paint();
      if (d.r.integrity !== "ok") return;
      const rb = R.resolveBody(d.id);
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

    /** Exactly one mutation at a time; typed text is never discarded by a failure. Returns the answer or null. */
    async function run(bodyObj, onOk, quiet) {
      if (ws.busy) return null;
      if (!bodyObj) {
        setNotice("Action impossible.", true);
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
        if (res && res.record && ws.detail && res.record.id === ws.detail.id) ws.detail.r = res.record;
        onOk(res);
        paint();
        if (ws.detail && !quiet) await reloadDetail();
        return res;
      } catch (err) {
        ws.busy = false;
        const info = R.errorInfo(err);
        if (info.conflict) {
          ws.confirm = null;
          setNotice(MSG.conflict, true);
          if (ws.detail) await reloadDetail();
          else paint();
        } else {
          setNotice(info.corrupt ? MSG.corrupt : info.full ? MSG.full : info.message, true);
          if (info.code === "reasoning_supersession_pending" || info.code === "reasoning_supersession_indeterminate" || info.code === "reasoning_state_invalid") {
            ws.confirm = null;
            if (ws.detail) await reloadDetail();
            else paint();
          } else paint();
        }
        return null;
      }
    }

    function section(id, title, help) {
      const s = el(doc, "section", { class: "carnet-rsn-block", id: "hq-carnet-rsn-b-" + id, "data-rsn-block": id, "aria-labelledby": "hq-carnet-rsn-" + id + "-h" });
      s.appendChild(el(doc, "h4", { id: "hq-carnet-rsn-" + id + "-h", text: title }));
      if (help) s.appendChild(el(doc, "p", { class: "hint", text: help }));
      return s;
    }

    function detailView() {
      const d = ws.detail;
      const box = el(doc, "div", { class: "carnet-rsn-detail", "data-rsn-detail": d.id });
      box.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [btn("← Retour à la liste", { id: "btn-carnet-rsn-back", "data-rsn-act": "back" }, backToList)]));
      if (d.loading) {
        box.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
        return box;
      }
      if (d.failed || !d.r) {
        box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", text: MSG.loadFailed }));
        return box;
      }
      const r = d.r;
      const corrupt = r.integrity !== "ok";
      const eff = r.effective_status || r.status;
      const res = d.resolved;
      const active = !corrupt && eff === "active";
      const blocked = !corrupt && (eff === "supersession_pending" || eff === "supersession_indeterminate");
      const assumption = r.kind === R.KIND_ASSUMPTION;
      box.appendChild(el(doc, "p", { class: "carnet-ask-meta" }, [
        el(doc, "span", { class: "carnet-chip", "data-rsn-kind": r.kind, text: R.KIND_LABEL[r.kind] || "" }),
        el(doc, "span", { class: "carnet-chip", id: "hq-carnet-rsn-status", "data-rsn-status": corrupt ? "corrupt" : eff, text: corrupt ? "Altéré" : R.statusText(r) }),
        el(doc, "span", { class: "hint", text: corrupt ? r.id : "révision " + r.rev + " · modifié " + R.fmtDate(r.updated_at) + " · " + projectName(r.project_id) }),
      ]));
      box.appendChild(el(doc, "p", { class: "hint", "data-rsn": "disclosure", text: MSG.disclosure }));
      if (corrupt) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-rsn": "corrupt", text: MSG.corrupt }));
      if (eff === "supersession_pending") box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-rsn": "pending", text: MSG.pending }));
      if (eff === "supersession_indeterminate") {
        box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-rsn": "indeterminate", text: MSG.indeterminate }));
        box.appendChild(el(doc, "p", { class: "hint", text: MSG.indeterminateHelp }));
      }
      if (!corrupt && !active && !blocked) box.appendChild(el(doc, "p", { class: "hint", "data-rsn": "historical", text: MSG.historical }));
      if (ws.notice) box.appendChild(el(doc, "p", { class: "hint", role: "status", "data-rsn": "notice", text: ws.notice }));
      if (ws.error) box.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-rsn": "error", text: ws.error }));
      if (r.supersedes) box.appendChild(relationRow("Remplace", r.supersedes, "supersedes"));
      if (r.superseded_by) box.appendChild(relationRow("Remplacé par", r.superseded_by, "superseded-by", r.successor_state));

      // ---- STATEMENT
      const st = section("statement", MSG.sections.statement, active ? (assumption ? MSG.statementHelpAssumption : MSG.statementHelpDecision) : null);
      if (active) {
        const draft = ws.drafts.statement === null ? r.statement : ws.drafts.statement;
        const [ta, left] = textarea("hq-carnet-rsn-statement", MSG.statementLabel, draft, R.STATEMENT_MAX, (t) => { ws.drafts.statement = t; });
        st.appendChild(ta);
        st.appendChild(left);
        st.appendChild(btn(MSG.save, { id: "btn-carnet-rsn-s-save", "data-rsn-act": "statement-save", "aria-disabled": ws.busy || !online() ? "true" : null }, () => {
          const val = R.validateStatement(ws.drafts.statement === null ? r.statement : ws.drafts.statement);
          if (!val.ok) return void (setNotice(val.reason, true), paint());
          run(R.updateBody(r, { statement: val.text }), () => { ws.drafts.statement = null; setNotice(MSG.saved, false); });
        }));
      } else st.appendChild(el(doc, "p", { class: "carnet-rsn-q", "data-rsn": "statement", text: r.statement }));
      box.appendChild(st);

      // ---- RATIONALE
      const ra = section("rationale", MSG.sections.rationale, active ? MSG.rationaleHelp : null);
      if (active) {
        const draft = ws.drafts.rationale === null ? r.rationale : ws.drafts.rationale;
        const [ta, left] = textarea("hq-carnet-rsn-rationale", MSG.rationaleLabel, draft, R.RATIONALE_MAX, (t) => { ws.drafts.rationale = t; });
        ra.appendChild(ta);
        ra.appendChild(left);
        ra.appendChild(btn(MSG.save, { id: "btn-carnet-rsn-r-save", "data-rsn-act": "rationale-save", "aria-disabled": ws.busy || !online() ? "true" : null }, () => {
          const val = R.validateRationale(ws.drafts.rationale === null ? r.rationale : ws.drafts.rationale);
          if (!val.ok) return void (setNotice(val.reason, true), paint());
          run(R.updateBody(r, { rationale: val.text }), () => { ws.drafts.rationale = null; setNotice(MSG.saved, false); });
        }));
      } else ra.appendChild(el(doc, "p", { class: "carnet-rsn-q", "data-rsn": "rationale", text: r.rationale || "—" }));
      box.appendChild(ra);

      // ---- EVIDENCE
      const ev = section("evidence", MSG.sections.evidence + " (" + r.evidence.length + ")", MSG.evidenceHelp);
      if (!r.evidence.length) ev.appendChild(el(doc, "p", { class: "hint", id: "hq-carnet-rsn-noevidence", text: MSG.noEvidence }));
      else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.sections.evidence });
        for (const e of r.evidence) {
          const row = res ? res.evidence.find((x) => x.evidence_id === e.id) : null;
          const li = el(doc, "li", { class: "carnet-hx-item carnet-rsn-evidence", "data-rsn-evidence": e.id, "data-state": row ? row.freshness || row.exists : "" }, [
            el(doc, "span", { class: "carnet-chip", text: R.EV_LABEL[e.ref.kind] || "" }),
            el(doc, "span", { class: "carnet-hx-event-text", text: R.refText(e.ref) }),
          ]);
          if (row) li.appendChild(el(doc, "span", { class: "hint", "data-rsn": "evidence-state", text: res.has_capture ? R.freshText(row.freshness) : R.existsText(row.exists) }));
          if (e.ref.kind === "source" && typeof host.openReader === "function") li.appendChild(btn("Lire", { "data-rsn-act": "reader", "aria-label": "Lire cette source dans le lecteur" }, (evn) => host.openReader({ sourceId: e.ref.source_id, trigger: evn.currentTarget })));
          if (active) li.appendChild(btn(MSG.removeEvidence, { "data-rsn-act": "evidence-remove", "data-id": e.id, "aria-label": "Retirer cette preuve : " + R.refText(e.ref), "aria-disabled": ws.busy || !online() ? "true" : null }, () => run(R.evidenceRemoveBody(r, e.id), () => setNotice(MSG.evidenceRemoved, false))));
          ul.appendChild(li);
        }
        ev.appendChild(ul);
      }
      box.appendChild(ev);

      // ---- VERIFICATIONS (links, never evidence)
      const vs = section("verifications", MSG.sections.verifications + " (" + r.verification_ids.length + ")", MSG.verificationsHelp);
      if (res) vs.appendChild(el(doc, "p", { class: "hint", "data-rsn": "verification-summary", text: R.verificationSummaryText(res.verification_summary) }));
      if (!r.verification_ids.length) vs.appendChild(el(doc, "p", { class: "hint", text: MSG.noVerifications }));
      else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.sections.verifications });
        for (const link of r.verification_ids) {
          const row = res ? res.verifications.find((x) => x.id === link.id) : null;
          const label = row ? (row.state === "ok" ? "Vérification : " + (row.status === "verified" ? "Vérifiée" : row.status === "ready" ? "Prête à vérifier" : row.status === "needs_followup" ? "À reprendre" : "Ouverte") : R.existsText(row.state) || row.state) : "";
          const li = el(doc, "li", { class: "carnet-hx-item carnet-rsn-vlink", "data-rsn-vlink": link.id, "data-state": row ? row.state : "" }, [
            el(doc, "span", { class: "carnet-hx-event-text", text: row && row.question ? row.question : link.id }),
            label ? el(doc, "span", { class: "hint", "data-rsn": "vlink-state", text: label }) : null,
          ]);
          if (typeof host.openVerification === "function" && row && row.state === "ok") li.appendChild(btn(MSG.view, { "data-rsn-act": "verification-open", "aria-label": MSG.view + " la vérification liée" }, (evn) => host.openVerification({ id: link.id, trigger: evn.currentTarget })));
          if (active) li.appendChild(btn(MSG.unlink, { "data-rsn-act": "verification-unlink", "data-id": link.id, "aria-disabled": ws.busy || !online() ? "true" : null }, () => run(R.unlinkBody(r, link.id), () => setNotice(MSG.unlinked, false))));
          ul.appendChild(li);
        }
        vs.appendChild(ul);
      }
      if (active) {
        vs.appendChild(btn(MSG.linkVerification, { id: "btn-carnet-rsn-link", "data-rsn-act": "link-open", "aria-expanded": ws.confirm && ws.confirm.type === "link" ? "true" : "false" }, () => { ws.confirm = { type: "link" }; loadLinkChoices(r); paint(); }));
        if (ws.confirm && ws.confirm.type === "link") vs.appendChild(linkForm(r));
      }
      box.appendChild(vs);

      // ---- CURRENT EVIDENCE STATE
      const cur = section("current", MSG.sections.current);
      if (corrupt) cur.appendChild(el(doc, "p", { class: "hint", text: MSG.corrupt }));
      else if (!res) cur.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      else {
        cur.appendChild(el(doc, "p", { class: "hint", "data-rsn": "live-label", text: MSG.liveLabel }));
        if (res.has_capture) cur.appendChild(el(doc, "p", { class: "carnet-rsn-overall", "data-rsn-overall": res.overall || "unknown", "data-rsn": "overall", text: R.freshText(res.overall || "unknown") + " (comparé à la capture « " + (R.EVENT_LABEL[res.captured_event] || res.captured_event) + " » du " + R.fmtDate(res.captured_at) + ")" }));
        else cur.appendChild(el(doc, "p", { class: "hint", text: MSG.activeNoCapture }));
      }
      if (!corrupt) cur.appendChild(btn("Actualiser l'état actuel", { id: "btn-carnet-rsn-refresh", "data-rsn-act": "refresh" }, () => { ws.detail.resolved = null; paint(); reloadDetail(); }));
      box.appendChild(cur);

      // ---- HISTORY
      const h = section("history", MSG.sections.history + " (" + r.history.length + ")");
      if (!r.history.length) h.appendChild(el(doc, "p", { class: "hint", text: "Aucun changement de statut." }));
      else {
        const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.sections.history });
        for (const e of r.history.slice().reverse()) {
          ul.appendChild(el(doc, "li", { class: "carnet-hx-item carnet-rsn-event", "data-rsn-event": e.id }, [
            el(doc, "strong", { text: (R.EVENT_LABEL[e.event] || e.event) + " · " + R.fmtDate(e.at) }),
            el(doc, "span", { class: "hint", text: " · " + (e.evidence ? e.evidence.length : 0) + " preuve(s) consignée(s) · empreinte " + String(e.content_sha256 || "").slice(0, 12) + " · révision avant " + e.rev_before + (e.successor_id ? " · successeur " + e.successor_id : "") }),
          ]));
        }
        h.appendChild(ul);
        h.appendChild(el(doc, "p", { class: "hint", "data-rsn": "capture-note", text: "La capture consignée à chaque transition est historique : elle ne change jamais ; l'état actuel est lu à part." }));
      }
      box.appendChild(h);

      if (!corrupt && !blocked) box.appendChild(actions(r));
      return box;
    }

    function relationRow(label, id, key, state) {
      const kids = [el(doc, "span", { text: label + " : " }), el(doc, "code", { text: id })];
      if (state && state !== "ok") kids.push(el(doc, "span", { class: "carnet-hx-warn", "data-rsn": "successor-state", text: " (" + (state === "corrupt" ? "successeur altéré" : "successeur " + state) + ")" }));
      kids.push(btn(MSG.view, { "data-rsn-act": "relation-open", "data-id": id, "aria-label": MSG.view + " : " + id }, () => openDetail(id)));
      return el(doc, "p", { class: "carnet-rsn-relation", "data-rsn": key }, kids);
    }

    async function loadLinkChoices(r) {
      ws.linkChoices = null;
      let rows = [];
      try {
        const res = await host.api.post({ action: "verification_list", project_id: r.project_id });
        if (res && Array.isArray(res.verifications)) rows = res.verifications.filter((x) => x.integrity === "ok" && !r.verification_ids.some((l) => l.id === x.id));
      } catch (_) { /* an empty choice list; nothing is written */ }
      if (!isOpen() || !ws.detail) return;
      ws.linkChoices = rows;
      ws.linkChoice = rows[0] ? rows[0].id : "";
      paint();
    }

    function linkForm(r) {
      const f = el(doc, "div", { class: "carnet-rsn-form", id: "hq-carnet-rsn-link-form", role: "group", "aria-label": MSG.linkVerification });
      if (ws.linkChoices === null) f.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
      else if (!ws.linkChoices.length) f.appendChild(el(doc, "p", { class: "hint", text: "Aucune vérification du même projet à lier." }));
      else {
        f.appendChild(select("hq-carnet-rsn-link-choice", MSG.linkVerification, ws.linkChoices.map((x) => [x.id, String(x.question || x.id).slice(0, 80)]), ws.linkChoice, (v) => { ws.linkChoice = v; }));
        f.appendChild(btn(MSG.linkVerificationYes, { id: "btn-carnet-rsn-link-yes", "data-rsn-act": "link-confirm", "aria-disabled": ws.busy || !online() ? "true" : null }, () => run(R.linkBody(r, ws.linkChoice), () => { ws.confirm = null; setNotice(MSG.linked, false); })));
      }
      f.appendChild(btn(MSG.cancel, { "data-rsn-act": "link-cancel" }, () => { ws.confirm = null; paint(); }));
      return f;
    }

    function actions(r) {
      const a = el(doc, "section", { class: "carnet-rsn-actions", id: "hq-carnet-rsn-actions", "aria-label": "Actions" });
      const dis = ws.busy || !online() ? "true" : null;
      const row = el(doc, "div", { class: "carnet-panel-row" });
      for (const t of R.targetsFor(r)) {
        const label = t === "confirmed" ? MSG.confirm : t === "invalidated" ? MSG.invalidate : t === "withdrawn" ? MSG.withdraw : MSG.retire;
        row.appendChild(btn(label, { id: "btn-carnet-rsn-" + t, "data-rsn-act": "status-" + t, "aria-disabled": dis }, () => { ws.confirm = { type: "status", status: t }; paint(); focusId("btn-carnet-rsn-status-yes"); }));
      }
      if (R.canSupersede(r)) row.appendChild(btn(MSG.supersede, { id: "btn-carnet-rsn-supersede", "data-rsn-act": "supersede", "aria-disabled": dis }, () => { ws.confirm = { type: "supersede" }; ws.drafts.sStatement = r.statement; ws.drafts.sRationale = ""; paint(); focusId("hq-carnet-rsn-sup-statement"); }));
      if (R.canDelete(r)) row.appendChild(btn(MSG.del, { id: "btn-carnet-rsn-delete", "data-rsn-act": "delete", "aria-disabled": dis }, () => { ws.confirm = { type: "delete" }; paint(); focusId("btn-carnet-rsn-delete-yes"); }));
      else if ((r.history && r.history.length) || r.supersedes || r.superseded_by) row.appendChild(el(doc, "span", { class: "hint", "data-rsn": "has-history", text: MSG.hasHistory }));
      a.appendChild(row);
      const c = ws.confirm;
      if (c && c.type === "status") {
        const summary = ws.detail.resolved ? R.verificationSummaryText(ws.detail.resolved.verification_summary) : "";
        const kids = [el(doc, "p", { text: c.status === "confirmed" ? MSG.confirmHelp : MSG.terminalHelp })];
        if (c.status === "confirmed") kids.push(el(doc, "p", { class: "hint", "data-rsn": "confirm-verifications", text: summary }));
        kids.push(el(doc, "div", { class: "carnet-panel-row" }, [
          btn(c.status === "confirmed" ? MSG.confirmYes : MSG.terminalYes, { id: "btn-carnet-rsn-status-yes", "data-rsn-act": "status-confirm", "aria-disabled": dis }, () => run(R.statusBody(r, c.status), () => { ws.confirm = null; setNotice(c.status === "confirmed" ? MSG.confirmDone : MSG.terminalDone, false); })),
          btn(MSG.cancel, { "data-rsn-act": "status-cancel" }, () => { ws.confirm = null; paint(); }),
        ]));
        a.appendChild(el(doc, "div", { class: "carnet-rsn-confirm", role: "alertdialog", "aria-label": "Confirmation" }, kids));
      }
      if (c && c.type === "supersede") {
        const [ta, left] = textarea("hq-carnet-rsn-sup-statement", MSG.supersedeStatement, ws.drafts.sStatement, R.STATEMENT_MAX, (t) => { ws.drafts.sStatement = t; });
        const [tr, leftR] = textarea("hq-carnet-rsn-sup-rationale", MSG.supersedeRationale, ws.drafts.sRationale, R.RATIONALE_MAX, (t) => { ws.drafts.sRationale = t; });
        const yes = btn(MSG.supersedeYes, { id: "btn-carnet-rsn-sup-yes", "data-rsn-act": "supersede-confirm", "aria-disabled": dis }, async () => {
          const s = R.validateStatement(ws.drafts.sStatement);
          if (!s.ok) return void (setNotice(s.reason, true), paint());
          const key = JSON.stringify([r.id, r.rev, ws.drafts.sStatement, ws.drafts.sRationale]);
          if (!ws.pendingSup || ws.pendingSup.key !== key) ws.pendingSup = { key, requestId: rid() }; // same intent after a lost answer => same id
          const res = await run(R.supersedeBody(r, ws.drafts.sStatement, ws.drafts.sRationale, ws.pendingSup.requestId), () => {}, true);
          if (res && res.successor) {
            ws.confirm = null;
            ws.pendingSup = null;
            setNotice(res.replayed ? MSG.supersedeReplayed : MSG.supersedeDone, false);
            openDetail(res.successor.id);
          }
        });
        a.appendChild(el(doc, "div", { class: "carnet-rsn-confirm", role: "alertdialog", "aria-label": MSG.supersede }, [
          el(doc, "p", { text: MSG.supersedeHelp }), ta, left, tr, leftR,
          el(doc, "div", { class: "carnet-panel-row" }, [yes, btn(MSG.cancel, { "data-rsn-act": "supersede-cancel" }, () => { ws.confirm = null; paint(); })]),
        ]));
      }
      if (c && c.type === "delete") {
        const yes = btn(MSG.delConfirmYes, { id: "btn-carnet-rsn-delete-yes", "data-rsn-act": "delete-confirm", "aria-disabled": dis }, () => run(R.deleteBody(r, true), () => { ws.confirm = null; ws.detail = null; setNotice(MSG.deleted, false); loadList(); }, true));
        a.appendChild(el(doc, "div", { class: "carnet-rsn-confirm", role: "alertdialog", "aria-label": MSG.delConfirm }, [el(doc, "p", { text: MSG.delConfirm }),
          el(doc, "div", { class: "carnet-panel-row" }, [yes, btn(MSG.cancel, { "data-rsn-act": "delete-cancel" }, () => { ws.confirm = null; paint(); })])]));
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
        rowsInto(lv.querySelector("#hq-carnet-rsn-rows"));
      }
      ws.body.scrollTop = scroll;
      if (hadId) {
        const again = ws.body.querySelector("#" + hadId.replace(/([^\w-])/g, "\\$1"));
        if (again && again !== doc.activeElement) again.focus({ preventScroll: true });
      }
    }

    // ============================================================ related panel (Reader, Review Pack)

    /**
     * spec: {id, refs:[{key,label,ref}], frozen, projectId, say?, onChange?}. `ref` is what the server needs to LOCATE the identity (a citation as its value,
     * a review item as its ids). ONE batched `reasoning_related` for every ref shown. Returns {node, reload, destroy}.
     */
    function panel(spec) {
      const pid = spec.id || "hq-carnet-rsn-panel";
      const st = {
        results: new Map(), loading: true, failed: false, truncated: false, unavailable: 0, expanded: !!spec.expanded, busy: false, notice: "", error: "",
        statement: "", rationale: "", kind: R.KIND_DECISION, choice: spec.refs[0] && spec.refs[0].key, pending: null, createOpen: false, addOpen: false,
        candidates: null, candidate: "", alive: true,
      };
      const rootEl = el(doc, "section", { class: "carnet-rsn-panel", id: pid, "aria-labelledby": pid + "-h", "data-frozen": spec.frozen ? "1" : "0" });
      let token = 0;
      const sayIt = (t) => { if (typeof spec.say === "function") spec.say(t); };

      async function load() {
        const mine = ++token;
        st.loading = true;
        st.failed = false;
        paint();
        const body = R.relatedBody(spec.refs.map((r) => r.ref));
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
        for (const r of st.results.values()) for (const x of r.records) if (!seen.has(x.id)) seen.set(x.id, x);
        return Array.from(seen.values());
      }

      function counts() {
        const c = { [R.KIND_DECISION]: {}, [R.KIND_ASSUMPTION]: {} };
        for (const x of allRows()) c[x.kind][x.effective_status] = (c[x.kind][x.effective_status] || 0) + 1;
        return c;
      }

      async function act(bodyObj, okText) {
        if (st.busy) return false;
        if (!bodyObj) { st.error = "Action impossible."; paint(); return false; }
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
          const info = R.errorInfo(err);
          st.error = info.conflict ? MSG.conflict : info.corrupt ? MSG.corrupt : info.full ? MSG.full : info.message;
          sayIt(st.error);
          paint();
          return false;
        }
      }

      function create() {
        const r = spec.refs.find((x) => x.key === st.choice) || spec.refs[0];
        if (!spec.projectId) { st.error = "Projet inconnu : ouvre le registre pour choisir un projet."; paint(); return; }
        const s = R.validateStatement(st.statement);
        if (!s.ok) { st.error = s.reason; paint(); return; }
        const rr = R.validateRationale(st.rationale);
        if (!rr.ok) { st.error = rr.reason; paint(); return; }
        const sig = JSON.stringify([st.kind, r.key, st.statement, st.rationale]);
        if (!st.pending || st.pending.sig !== sig) st.pending = { sig, requestId: rid() };
        act(R.createBody(st.kind, spec.projectId, st.statement, st.rationale, st.pending.requestId, [r.ref]), MSG.createDone).then((ok) => {
          if (ok) { st.statement = ""; st.rationale = ""; st.pending = null; st.createOpen = false; paint(); }
        });
      }

      async function loadCandidates() {
        st.candidates = [];
        let rows = [];
        try {
          const res = await host.api.post(R.listBody({ status: "active", project_id: spec.projectId || "" }));
          if (res && Array.isArray(res.records)) rows = res.records.filter((x) => x.integrity === "ok" && x.effective_status === "active");
        } catch (_) { /* a failed candidate list leaves the select empty; nothing is written */ }
        if (!st.alive) return;
        st.candidates = rows;
        st.candidate = rows[0] ? rows[0].id : "";
        paint();
      }

      async function addEvidence() {
        const r = spec.refs.find((x) => x.key === st.choice) || spec.refs[0];
        const cand = (st.candidates || []).find((x) => x.id === st.candidate);
        if (!cand) { st.error = "Choisis un enregistrement actif."; paint(); return; }
        const ok = await act(R.evidenceAddBody(cand, r.ref), MSG.evidenceAdded);
        if (ok) { st.addOpen = false; st.candidates = null; paint(); }
      }

      function rowNode(x) {
        const kids = [
          el(doc, "p", { class: "carnet-ask-meta" }, [
            el(doc, "span", { class: "carnet-chip", "data-rsn-kind": x.kind, text: R.KIND_LABEL[x.kind] }),
            el(doc, "span", { class: "carnet-chip", "data-rsn-status": x.effective_status, text: R.statusText(x) }),
          ]),
          el(doc, "p", { class: "carnet-rsn-q", text: x.statement }), // textContent
        ];
        if (x.verification_summary) kids.push(el(doc, "p", { class: "hint", text: R.verificationSummaryText(x.verification_summary) }));
        kids.push(el(doc, "div", { class: "carnet-panel-row" }, [btn(MSG.view, { "data-rsn-act": "view", "data-id": x.id, "aria-label": MSG.view + " : " + x.statement.slice(0, 80) }, (ev) => open(ev.currentTarget, { id: x.id }))]));
        return el(doc, "li", { class: "carnet-rsn-row", "data-rsn-row": x.id }, kids);
      }

      function paint() {
        if (!st.alive) return;
        const had = rootEl.contains(doc.activeElement) ? doc.activeElement : null;
        const hadId = had && had.id ? had.id : null;
        rootEl.textContent = "";
        const rows = allRows();
        const label = st.loading && !st.results.size ? MSG.loading : st.failed ? MSG.loadFailed : R.summaryText(counts());
        const toggle = el(doc, "button", { type: "button", class: "carnet-small carnet-rsn-toggle", id: pid + "-toggle", "aria-expanded": st.expanded ? "true" : "false", "aria-controls": pid + "-body" });
        toggle.appendChild(el(doc, "span", { id: pid + "-h", class: "carnet-rsn-heading", text: (spec.frozen ? MSG.frozenHeading : MSG.liveHeading) + " : " }));
        toggle.appendChild(el(doc, "span", { "data-rsn": "summary", text: label }));
        toggle.addEventListener("click", () => { st.expanded = !st.expanded; paint(); });
        rootEl.appendChild(toggle);
        if (!st.expanded) { restoreFocus(hadId); return; }
        const bodyEl = el(doc, "div", { class: "carnet-rsn-panel-body", id: pid + "-body" });
        bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.intro }));
        if (spec.frozen) bodyEl.appendChild(el(doc, "p", { class: "hint", "data-rsn": "not-frozen", text: MSG.frozenNote }));
        if (st.notice) bodyEl.appendChild(el(doc, "p", { class: "hint", role: "status", "data-rsn": "notice", text: st.notice }));
        if (st.error) bodyEl.appendChild(el(doc, "p", { class: "carnet-hx-warn", role: "alert", "data-rsn": "error", text: st.error }));
        if (st.failed) bodyEl.appendChild(btn("Réessayer", { "data-rsn-act": "retry" }, load));
        if (st.unavailable) bodyEl.appendChild(el(doc, "p", { class: "hint", text: st.unavailable + " " + MSG.untrusted }));
        if (!st.loading && !st.failed && !rows.length) bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.none }));
        if (rows.length) {
          const ul = el(doc, "ul", { class: "carnet-hx-list", "aria-label": MSG.liveHeading });
          for (const x of rows) ul.appendChild(rowNode(x));
          bodyEl.appendChild(ul);
        }
        if (st.truncated) bodyEl.appendChild(el(doc, "p", { class: "hint", text: MSG.truncated }));
        const bar = el(doc, "div", { class: "carnet-panel-row" });
        bar.appendChild(btn(MSG.createDecision, { id: pid + "-create-dec", "data-rsn-act": "create-open-decision", "aria-expanded": st.createOpen && st.kind === R.KIND_DECISION ? "true" : "false", "aria-disabled": st.busy || !online() ? "true" : null }, () => { st.kind = R.KIND_DECISION; st.createOpen = true; st.addOpen = false; paint(); focusIn(pid + "-s"); }));
        bar.appendChild(btn(MSG.createAssumption, { id: pid + "-create-asm", "data-rsn-act": "create-open-assumption", "aria-expanded": st.createOpen && st.kind === R.KIND_ASSUMPTION ? "true" : "false", "aria-disabled": st.busy || !online() ? "true" : null }, () => { st.kind = R.KIND_ASSUMPTION; st.createOpen = true; st.addOpen = false; paint(); focusIn(pid + "-s"); }));
        bar.appendChild(btn(MSG.addEvidence, { id: pid + "-add", "data-rsn-act": "add-open", "aria-expanded": st.addOpen ? "true" : "false", "aria-disabled": st.busy || !online() ? "true" : null }, () => { st.addOpen = !st.addOpen; st.createOpen = false; if (st.addOpen && st.candidates === null) loadCandidates(); paint(); }));
        bar.appendChild(btn(MSG.openWorkspace, { id: pid + "-workspace", "data-rsn-act": "workspace" }, (ev) => open(ev.currentTarget, null)));
        bodyEl.appendChild(bar);
        if (spec.refs.length > 1 && (st.createOpen || st.addOpen)) {
          const fs = el(doc, "fieldset", { class: "carnet-ann-target" }, [el(doc, "legend", { text: "Preuve à joindre" })]);
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
          const [ta, left] = textarea(pid + "-s", MSG.statementLabel, st.statement, R.STATEMENT_MAX, (t) => { st.statement = t; });
          const [tr, leftR] = textarea(pid + "-r", MSG.rationaleLabel, st.rationale, R.RATIONALE_MAX, (t) => { st.rationale = t; });
          bodyEl.appendChild(el(doc, "div", { class: "carnet-rsn-form" }, [
            el(doc, "p", { class: "hint", text: st.kind === R.KIND_DECISION ? MSG.statementHelpDecision : MSG.statementHelpAssumption }), ta, left,
            el(doc, "p", { class: "hint", text: MSG.rationaleHelp }), tr, leftR,
            btn(st.kind === R.KIND_DECISION ? MSG.createDecision : MSG.createAssumption, { id: pid + "-create-yes", "data-rsn-act": "create", "aria-disabled": st.busy || !online() ? "true" : null }, create),
          ]));
        }
        if (st.addOpen) {
          const f = el(doc, "div", { class: "carnet-rsn-form" });
          if (st.candidates === null) f.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
          else if (!st.candidates.length) f.appendChild(el(doc, "p", { class: "hint", text: "Aucune décision ni hypothèse active : crées-en une d'abord." }));
          else {
            f.appendChild(select(pid + "-cand", "Ajouter à l'enregistrement", st.candidates.map((x) => [x.id, R.KIND_LABEL[x.kind] + " · " + x.statement.slice(0, 70)]), st.candidate, (v) => { st.candidate = v; }));
            f.appendChild(btn(MSG.addEvidence, { id: pid + "-add-yes", "data-rsn-act": "add", "aria-disabled": st.busy || !online() ? "true" : null }, addEvidence));
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
