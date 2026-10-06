/* Transfert HQ — Carnet Phase 7: review packs — PURE view models (no DOM, no network, no storage, no clock).
 *
 * A review pack ORGANIZES evidence for a human review. It never decides what the evidence means: no status, approval, risk,
 * completion or resolution is inferred here or anywhere else. The stored item ("what was reviewed") and the freshness observation
 * ("what exists now") are two separate objects all the way through this file.
 *
 *   1. wire        request bodies (the exact shapes the server accepts; identity only — the server computes every seal)
 *   2. specs       evidence selection specs built from cockpit / Ask / diff data, strictly validated
 *   3. models      list rows, pack model (items with stored copy + separate observation, checklist, questions)
 *   4. conflicts   409 handling data (reload, keep the user's unsaved text — never merge or retry)
 *
 * Plain ES2020, UMD (browser global HqCarnetReviews / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReviews = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const E = (typeof module === "object" && module && module.exports && typeof require === "function") ? require("./hq-carnet-errors.js") : globalThis.HqCarnetErrors; // Phase 13: typed fallback message

  const LIMITS = { title: 120, note: 2000, check: 500, question: 1000, resolution: 1000, refs: 20, items: 250, checklist: 100, questions: 100, packs: 100 };
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const PROJ_RE = /^proj-[A-Za-z0-9_-]{1,64}$/;
  const SNAP_RE = /^snap-[0-9a-f]{24}$/;
  const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const EDITION_RE = /^[A-Za-z0-9_-]{1,80}$/;
  const REVIEW_RE = /^rvw-[0-9a-f]{24}$/;
  const ITEM_RE = /^ri-[0-9a-f]{16}$/;
  const CHECK_RE = /^rc-[0-9a-f]{16}$/;
  const QUESTION_RE = /^rq-[0-9a-f]{16}$/;
  const FP_RE = /^[0-9a-f]{32}$/;
  const EVENT_RE = /^hev-[0-9a-f]{24}$/;
  const STATUS_LABEL = { draft: "Brouillon", in_review: "En revue", needs_followup: "À suivre", reviewed: "Revue terminée" };
  const STATUSES = ["draft", "in_review", "needs_followup", "reviewed"];
  const STATE_LABEL = { unchanged: "Inchangé", changed: "Modifié depuis la sélection", missing: "Introuvable", unknown: "Non vérifiable" };
  const STATE_MARK = { unchanged: "=", changed: "≠", missing: "∅", unknown: "?" };
  const KIND_LABEL = { page: "Note", block: "Bloc", decision: "Décision", measurement: "Mesure", drawing: "Dessin", source: "Source", snapshot: "Jalon", project_overview: "Vue d'ensemble", ask_result: "Résultat Ask Carnet", diff: "Comparaison" };
  const REASON_LABEL = {
    absent: "n'existe plus à cet endroit",
    sources_unavailable: "le fichier des sources est illisible",
    drawing_unreadable: "le fichier du dessin est illisible",
    resolver_error: "vérification impossible",
    notebook_unavailable: "le carnet est illisible",
    ask_unavailable: "la recherche n'a pas pu être relancée",
    diff_unavailable: "la comparaison n'a pas pu être relancée",
    frozen_snapshot_missing: "le jalon figé n'existe plus",
    frozen_snapshot_corrupt: "le jalon figé est altéré",
    frozen_snapshot_unavailable: "les jalons sont illisibles",
    frozen_snapshot_seal_changed: "le jalon figé a changé",
    snapshot_corrupt: "le jalon est altéré",
    snapshot_unavailable: "les jalons sont illisibles",
  };
  const ANOMALY_LABEL = {
    drawing_bytes_changed: "Anomalie d'intégrité : les octets de ce dessin ont changé sous le même nom (un dessin enregistré est une version immuable).",
    snapshot_seal_changed: "Anomalie d'intégrité : le sceau de ce jalon a changé.",
  };
  const NOT_VERDICT = "Un dossier de revue organise des preuves pour une relecture humaine. Il ne conclut rien : le statut, la liste de contrôle et les questions sont ceux que tu y inscris.";
  const COPY_NOTE = "Copie capturée à la sélection — jamais actualisée.";

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtDate(sec) {
    if (typeof sec !== "number" || !isFinite(sec)) return "";
    const d = new Date(sec * 1000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }

  /** 32 hex chars from caller-provided random bytes (no clock, no Math.random here). */
  function hex32(bytes) {
    if (!bytes || bytes.length < 16) return null;
    let s = "";
    for (let i = 0; i < 16; i++) s += pad2(bytes[i] & 255);
    return s;
  }

  function pad2(n) {
    return (n < 16 ? "0" : "") + n.toString(16);
  }

  // ------------------------------------------------------------------ 1. text validation + wire

  function text(raw, limit, required, multiline) {
    const s = String(raw == null ? "" : raw);
    const bad = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
    if (s.length > limit || bad.test(s)) return { ok: false, error: "Texte invalide (" + limit + " caractères au plus, sans caractère de contrôle)." };
    const t = s.trim();
    if (required && !t) return { ok: false, error: "Texte requis." };
    return { ok: true, text: t };
  }

  const validTitle = (raw) => text(raw, LIMITS.title, true, false);
  const validNote = (raw) => text(raw, LIMITS.note, false, true);
  const validCheck = (raw) => text(raw, LIMITS.check, true, false);
  const validQuestion = (raw) => text(raw, LIMITS.question, true, true);
  const validResolution = (raw) => text(raw, LIMITS.resolution, false, true);

  function createBody(projectId, title, note, requestId, baselineSnapshotId) {
    const t = validTitle(title);
    const n = validNote(note);
    if (!t.ok || !n.ok || !PROJ_RE.test(String(projectId || "")) || !/^[0-9a-f]{32}$/.test(String(requestId || ""))) return null;
    const body = { action: "review_create", project_id: projectId, title: t.text, note: n.text, request_id: requestId };
    if (baselineSnapshotId) {
      if (!SNAP_RE.test(baselineSnapshotId)) return null;
      body.baseline = { kind: "snapshot", snapshot_id: baselineSnapshotId };
    }
    return body;
  }

  // One create attempt = one request id, bound to the normalized creation intent. A retry of the SAME form after an uncertain outcome
  // (lost response, network drop) re-sends the SAME id so the server replays the original pack; a changed form is a new attempt.
  function createSignature(projectId, title, note, baselineSnapshotId) {
    const t = validTitle(title);
    const n = validNote(note);
    return JSON.stringify([String(projectId || ""), t.ok ? t.text : null, n.ok ? n.text : null, baselineSnapshotId || null]);
  }

  function createAttempt(pending, projectId, title, note, baselineSnapshotId, mint) {
    const sig = createSignature(projectId, title, note, baselineSnapshotId);
    if (isObj(pending) && pending.sig === sig && /^[0-9a-f]{32}$/.test(String(pending.rid || ""))) return pending;
    return { sig, rid: mint() };
  }

  function base(action, pack) {
    if (!isObj(pack) || !REVIEW_RE.test(String(pack.id || "")) || !Number.isInteger(pack.rev) || pack.rev < 1) return null;
    return { action, id: pack.id, expected_rev: pack.rev };
  }

  function updateBody(pack, fields) {
    const b = base("review_update", pack);
    if (!b || !isObj(fields)) return null;
    if ("title" in fields) {
      const t = validTitle(fields.title);
      if (!t.ok) return null;
      b.title = t.text;
    }
    if ("note" in fields) {
      const n = validNote(fields.note);
      if (!n.ok) return null;
      b.note = n.text;
    }
    if ("status" in fields) {
      if (!STATUSES.includes(fields.status)) return null;
      b.status = fields.status;
    }
    return Object.keys(b).length > 3 ? b : null;
  }

  /** Permanent delete: needs the revision the CONFIRMATION was opened on. A stale confirmation is refused by the server (409). */
  function deleteBody(pack, confirmedRev) {
    const b = base("review_delete", pack);
    if (!b || !Number.isInteger(confirmedRev)) return null;
    b.expected_rev = confirmedRev;
    b.confirm = true;
    return b;
  }

  function itemAddBody(pack, spec) {
    const b = base("review_item_add", pack);
    return b && isObj(spec) ? Object.assign(b, { item: spec }) : null;
  }

  function itemReplaceBody(pack, itemId, spec) {
    const b = base("review_item_replace", pack);
    return b && ITEM_RE.test(String(itemId || "")) && isObj(spec) ? Object.assign(b, { item_id: itemId, item: spec }) : null;
  }

  function itemRemoveBody(pack, itemId) {
    const b = base("review_item_remove", pack);
    return b && ITEM_RE.test(String(itemId || "")) ? Object.assign(b, { item_id: itemId }) : null;
  }

  function refsOf(pack, refs) {
    const ids = new Set((pack.items || []).map((i) => i.id));
    const out = [];
    for (const r of refs || []) if (ids.has(r) && !out.includes(r) && out.length < LIMITS.refs) out.push(r);
    return out;
  }

  function checkAddBody(pack, raw, refs) {
    const b = base("review_check_add", pack);
    const t = validCheck(raw);
    return b && t.ok ? Object.assign(b, { text: t.text, refs: refsOf(pack, refs) }) : null;
  }

  function checkUpdateBody(pack, id, fields) {
    const b = base("review_check_update", pack);
    if (!b || !CHECK_RE.test(String(id || "")) || !isObj(fields)) return null;
    b.check_id = id;
    if ("text" in fields) {
      const t = validCheck(fields.text);
      if (!t.ok) return null;
      b.text = t.text;
    }
    if ("checked" in fields) {
      if (typeof fields.checked !== "boolean") return null;
      b.checked = fields.checked;
    }
    if ("refs" in fields) b.refs = refsOf(pack, fields.refs);
    return Object.keys(b).length > 4 ? b : null;
  }

  function checkRemoveBody(pack, id) {
    const b = base("review_check_remove", pack);
    return b && CHECK_RE.test(String(id || "")) ? Object.assign(b, { check_id: id }) : null;
  }

  function questionAddBody(pack, raw, refs) {
    const b = base("review_question_add", pack);
    const t = validQuestion(raw);
    return b && t.ok ? Object.assign(b, { text: t.text, refs: refsOf(pack, refs) }) : null;
  }

  function questionUpdateBody(pack, id, fields) {
    const b = base("review_question_update", pack);
    if (!b || !QUESTION_RE.test(String(id || "")) || !isObj(fields)) return null;
    b.question_id = id;
    if ("text" in fields) {
      const t = validQuestion(fields.text);
      if (!t.ok) return null;
      b.text = t.text;
    }
    if ("state" in fields) {
      if (fields.state !== "open" && fields.state !== "resolved") return null;
      b.state = fields.state;
    }
    if ("resolution_note" in fields) {
      const n = validResolution(fields.resolution_note);
      if (!n.ok) return null;
      b.resolution_note = n.text;
    }
    if ("refs" in fields) b.refs = refsOf(pack, fields.refs);
    return Object.keys(b).length > 4 ? b : null;
  }

  function questionRemoveBody(pack, id) {
    const b = base("review_question_remove", pack);
    return b && QUESTION_RE.test(String(id || "")) ? Object.assign(b, { question_id: id }) : null;
  }

  // ------------------------------------------------------------------ 2. evidence specs (identity only)

  const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

  function pageSpec(pageId, label) {
    return PAGE_RE.test(String(pageId || "")) ? { spec: { kind: "page", page_id: pageId }, label: clip(label || "Note", 120) } : null;
  }

  function blockSpec(kind, pageId, blockId, label) {
    if (!["block", "decision", "measurement"].includes(kind) || !PAGE_RE.test(String(pageId || "")) || !BLOCK_RE.test(String(blockId || ""))) return null;
    return { spec: { kind, page_id: pageId, block_id: blockId }, label: clip(label || KIND_LABEL[kind], 120) };
  }

  function drawingSpec(stem) {
    return STEM_RE.test(String(stem || "")) ? { spec: { kind: "drawing", stem }, label: "Dessin " + stem } : null;
  }

  function sourceSpec(editionId, label) {
    return EDITION_RE.test(String(editionId || "")) ? { spec: { kind: "source", edition_id: editionId }, label: clip(label || "Source", 120) } : null;
  }

  function snapshotSpec(snapId, label) {
    return SNAP_RE.test(String(snapId || "")) ? { spec: { kind: "snapshot", snapshot_id: snapId }, label: clip(label || "Jalon", 120) } : null;
  }

  function overviewSpec() {
    return { spec: { kind: "project_overview" }, label: "Vue d'ensemble du projet" };
  }

  function scopeOk(scope) {
    if (!isObj(scope)) return false;
    if (scope.kind === "notebook") return Object.keys(scope).length === 1;
    if (!["page", "project", "snapshot"].includes(scope.kind) || typeof scope.id !== "string") return false;
    return Object.keys(scope).length === 2;
  }

  /** The Ask result AS SHOWN: the server refuses (409) when its own re-run no longer gives the fingerprint the user saw. */
  function askSpec(res, scope, limit) {
    if (!isObj(res) || !(res.status === "evidence" || res.status === "partial") || !FP_RE.test(String(res.fingerprint || "")) || !scopeOk(scope)) return null;
    const q = clip(res.question, 300);
    if (!q) return null;
    const lim = Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 10;
    return { spec: { kind: "ask_result", question: q, scope: scope.kind === "notebook" ? { kind: "notebook" } : { kind: scope.kind, id: scope.id }, limit: lim, fingerprint: res.fingerprint }, label: "Ask Carnet — " + q.slice(0, 80) };
  }

  /** A comparison already computed in the cockpit: base id (hev-… or snap-…), optional target snapshot / null (= current). */
  function diffSpec(baseId, toId, pageId, projectId, label) {
    if (!(SNAP_RE.test(String(baseId || "")) || EVENT_RE.test(String(baseId || "")) || STEM_RE.test(String(baseId || "")))) return null;
    if (toId != null && !(SNAP_RE.test(String(toId)) || STEM_RE.test(String(toId)))) return null;
    if (pageId != null && !PAGE_RE.test(String(pageId))) return null;
    if (projectId != null && !PROJ_RE.test(String(projectId))) return null;
    return { spec: { kind: "diff", base: baseId, to: toId == null ? null : toId, page_id: pageId == null ? null : pageId, project_id: projectId == null ? null : projectId }, label: clip(label || "Comparaison", 120) };
  }

  // ------------------------------------------------------------------ 3. models

  function headerModel(h) {
    if (!isObj(h) || !REVIEW_RE.test(String(h.id || ""))) return null;
    const bad = h.integrity !== "ok";
    return {
      id: h.id, rev: h.rev, title: h.title, status: h.status, statusLabel: STATUS_LABEL[h.status] || "?", updated: fmtDate(h.updated_at), integrity: h.integrity, readOnly: bad,
      integrityLabel: bad ? "Fichier altéré — lecture seule" : "",
      counts: h.items + " preuve" + (h.items > 1 ? "s" : "") + " · " + h.checked + " point" + (h.checked > 1 ? "s" : "") + " coché" + (h.checked > 1 ? "s" : "") + " sur " + h.checklist + " · " + h.open_questions + " question" + (h.open_questions > 1 ? "s" : "") + " ouverte" + (h.open_questions > 1 ? "s" : ""),
      baseline: h.baseline === "snapshot" ? "Contexte figé (jalon)" : "État courant",
    };
  }

  function listModel(res) {
    if (!isObj(res) || !Array.isArray(res.reviews)) return null;
    return { rows: res.reviews.map(headerModel).filter(Boolean), unavailable: Array.isArray(res.unavailable) ? res.unavailable.length : 0, limits: res.limits || {} };
  }

  /** Stored copy lines — ALWAYS the historical capture, never mixed with the observation. */
  function copyLines(item) {
    const c = isObj(item.copy) ? item.copy : {};
    const out = [];
    const put = (k, v) => {
      if (v !== null && v !== undefined && v !== "") out.push(k + " : " + v);
    };
    switch (item.kind) {
      case "page":
        put("Titre", c.title);
        put("Révision", c.rev);
        put("Extrait", c.excerpt);
        break;
      case "block":
        put("Note", c.page_title);
        put("Type", c.type);
        put("Texte", c.text || c.summary);
        if (isObj(c.portal)) put("Portail (référence capturée)", String(c.portal.kind) + " " + String(c.portal.id));
        break;
      case "decision":
        put("Note", c.page_title);
        put("Décision", c.text);
        put("Date", fmtDate(c.at));
        break;
      case "measurement":
        put("Note", c.page_title);
        put("Résumé", c.summary);
        break;
      case "drawing":
        put("Dessin", c.stem);
        put("Taille", c.size);
        break;
      case "source":
        put("Titre", c.title);
        put("Auteur", c.author);
        put("Édition", c.edition);
        put("Année", c.year);
        break;
      case "snapshot":
        put("Jalon", c.label);
        put("Notes", c.pages);
        put("Créé", fmtDate(c.created_at));
        break;
      case "project_overview":
        if (isObj(c.counts)) for (const k of Object.keys(c.counts)) put(k, c.counts[k]);
        break;
      case "ask_result":
        put("Question", item.key && item.key.question);
        for (const card of (c.cards || []).slice(0, 10)) put("Passage", clip((card.page_title || "") + " — " + (card.excerpt || card.text || ""), 240));
        break;
      case "diff":
        if (Array.isArray(c.pair)) for (const p of c.pair) put("Dessin", p.stem + " (" + p.state + ")");
        else {
          for (const r of (c.rows || []).slice(0, 200)) put(r.change, clip((r.type || "") + " " + (r.summary || ""), 160));
          if (!(c.rows || []).length && !c.truncated) out.push("Aucune différence au moment de la sélection.");
          if (c.truncated) out.push("Extrait tronqué : " + (c.rows || []).length + " lignes affichées sur " + c.rows_total + ".");
        }
        break;
      default:
        break;
    }
    return out;
  }

  function observationModel(obs, scope) {
    if (!isObj(obs)) return { state: "unknown", mark: STATE_MARK.unknown, label: "Non observé", reason: "", anomaly: "", frozen: "", target: null, currentDiffers: "" };
    const st = STATE_LABEL[obs.state] ? obs.state : "unknown";
    const snap = isObj(scope) && scope.kind === "snapshot";
    return {
      state: st,
      mark: STATE_MARK[st],
      label: STATE_LABEL[st],
      reason: obs.reason ? REASON_LABEL[obs.reason] || "raison inconnue" : "",
      anomaly: obs.anomaly ? ANOMALY_LABEL[obs.anomaly] || "Anomalie d'intégrité." : "",
      frozen: snap ? (obs.frozen === "ok" ? "Évalué sur l'état figé du jalon" : "Jalon figé indisponible") : "",
      target: isObj(obs.target) && typeof obs.target.state === "string" ? { state: obs.target.state, label: "Cible du portail : " + String(obs.target.state_label || "").slice(0, 80) + (obs.target.title ? " (" + String(obs.target.title).slice(0, 120) + ")" : "") } : null,
      currentDiffers: snap ? (obs.current_differs === true ? "L'état actuel diffère de l'état figé" : obs.current_differs === false ? "L'état actuel est identique à l'état figé" : "État actuel non vérifiable") : "",
    };
  }

  function packModel(review, freshness, integrity) {
    if (!isObj(review) || !Array.isArray(review.items)) return null;
    const obsById = isObj(freshness) && isObj(freshness.items) ? freshness.items : {};
    const ids = new Set(review.items.map((i) => i.id));
    const items = review.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      kindLabel: KIND_LABEL[i.kind] || i.kind,
      label: i.label,
      added: fmtDate(i.added_at),
      scopeLabel: i.scope && i.scope.kind === "snapshot" ? "Jalon figé " + i.scope.id : "État courant",
      copy: copyLines(i),
      copyNote: COPY_NOTE,
      supersedes: (i.supersedes || []).map((s) => ({ fingerprint: s.fingerprint, replaced: fmtDate(s.replaced_at) })),
      observation: observationModel(obsById[i.id], i.scope),
      sourceId: i.kind === "source" && isObj(i.key) && typeof i.key.edition_id === "string" ? i.key.edition_id : null,
      replaceable: i.kind === "ask_result",
      question: i.kind === "ask_result" && i.key ? i.key.question : null,
      askScope: i.kind === "ask_result" && i.key ? i.key.scope : null,
    }));
    const refLabel = (r) => ({ id: r, dangling: !ids.has(r), label: ids.has(r) ? (items.find((x) => x.id === r) || {}).label : "Preuve retirée" });
    const checklist = (review.checklist || []).map((c) => ({ id: c.id, text: c.text, checked: !!c.checked, refs: (c.refs || []).map(refLabel), updated: fmtDate(c.updated_at) }));
    const questions = (review.questions || []).map((q) => ({
      id: q.id, text: q.text, state: q.state, stateLabel: q.state === "resolved" ? "Marquée résolue par toi" : "Ouverte", note: q.resolution_note || "", refs: (q.refs || []).map(refLabel), updated: fmtDate(q.updated_at),
    }));
    const counts = isObj(freshness) && isObj(freshness.counts) ? freshness.counts : null;
    return {
      id: review.id, rev: review.rev, title: review.title, note: review.note, status: review.status, statusLabel: STATUS_LABEL[review.status] || "?",
      created: fmtDate(review.created_at), updated: fmtDate(review.updated_at), seal: review.content_sha256,
      readOnly: integrity !== "ok", integrityLabel: integrity === "ok" ? "Fichier vérifié" : "Fichier altéré — lecture seule, rien n'est modifié",
      baseline: review.baseline && review.baseline.kind === "snapshot" ? { frozen: true, label: "Contexte figé : jalon « " + review.baseline.label + " »", id: review.baseline.snapshot_id } : { frozen: false, label: "Contexte : état courant (non figé)", id: null },
      items, checklist, questions,
      checkedCount: checklist.filter((c) => c.checked).length,
      openQuestions: questions.filter((q) => q.state === "open").length,
      freshnessCounts: counts && Object.keys(STATE_LABEL).map((k) => ({ state: k, label: STATE_LABEL[k], mark: STATE_MARK[k], n: counts[k] || 0 })),
      notVerdict: NOT_VERDICT,
      atLimits: { items: review.items.length >= LIMITS.items, checklist: checklist.length >= LIMITS.checklist, questions: questions.length >= LIMITS.questions },
    };
  }

  // ------------------------------------------------------------------ 4. conflicts

  /** What the UI needs after a failed mutation. A 409 `review_conflict` means: reload the server version, keep the user's text visible, retry NOTHING. */
  function conflictInfo(err) {
    const d = err && isObj(err.data) ? err.data : {};
    const code = typeof d.code === "string" ? d.code : "";
    return {
      code,
      conflict: code === "review_conflict" || code === "review_corrupt" || code === "review_baseline_locked",
      reload: code === "review_conflict",
      evidenceChanged: code === "review_evidence_changed",
      message: E.message(err, 200),
    };
  }

  return {
    LIMITS, STATUSES, STATUS_LABEL, STATE_LABEL, STATE_MARK, KIND_LABEL, REASON_LABEL, ANOMALY_LABEL, NOT_VERDICT, COPY_NOTE,
    PAGE_RE, REVIEW_RE, ITEM_RE, CHECK_RE, QUESTION_RE,
    fmtDate, hex32, validTitle, validNote, validCheck, validQuestion, validResolution,
    createBody, createSignature, createAttempt, updateBody, deleteBody, itemAddBody, itemReplaceBody, itemRemoveBody, checkAddBody, checkUpdateBody, checkRemoveBody, questionAddBody, questionUpdateBody, questionRemoveBody,
    pageSpec, blockSpec, drawingSpec, sourceSpec, snapshotSpec, overviewSpec, askSpec, diffSpec,
    headerModel, listModel, copyLines, observationModel, packModel, conflictInfo,
  };
});
