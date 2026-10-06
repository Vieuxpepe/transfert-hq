/* Transfert HQ — Carnet Phase 11: verification tasks & evidence-backed signoff — PURE model (no DOM, no network, no storage, no clock).
 *
 * A verification says that a HUMAN performed a check against a SPECIFIC evidence state. It does not make the evidence true and it never
 * turns workflow state into evidence. "Vérifiée" exists only after an explicit "Enregistrer la vérification" action. There is no identity
 * system: nothing here names a reviewer, an assignee, a due date or a priority.
 *
 * This module builds request bodies, validates text exactly like the server, groups / filters the (≤100) loaded headers, and maps server
 * answers onto procedural wording. The server owns identity: the client never sends a fingerprint it computed itself (the signoff may
 * echo the server's own verification_fingerprint back so a changed definition is a conflict, never a silent re-sign).
 * Plain ES2020, UMD (browser global HqCarnetVerifications / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetVerifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const E = (typeof module === "object" && module && module.exports && typeof require === "function") ? require("./hq-carnet-errors.js") : globalThis.HqCarnetErrors; // Phase 13: typed fallback message

  const TEXT_MAX = 4000;
  const LIST_MAX = 100;
  const RELATED_MAX = 10;
  const RESOLVE_IDS_MAX = 25;
  const EVIDENCE_MAX = 100;
  const ID_RE = /^ver-[0-9a-f]{24}$/;
  const EVID_RE = /^ve-[0-9a-f]{16}$/;
  const REQ_RE = /^[0-9a-f]{32}$/;
  const SHA_RE = /^[0-9a-f]{64}$/;
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const EDITION_RE = /^srce-[A-Za-z0-9_-]{1,64}$/;
  const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const SNAP_RE = /^snap-[0-9a-f]{24}$/;
  const REVIEW_RE = /^rvw-[0-9a-f]{24}$/;
  const ITEM_RE = /^ri-[0-9a-f]{16}$/;

  const STATUSES = ["open", "ready", "verified", "needs_followup"];
  const KINDS = ["page", "block", "source", "citation", "drawing", "snapshot", "review_item"];
  const GROUPS = [
    { status: "open", label: "Ouvertes" },
    { status: "ready", label: "Prêtes à vérifier" },
    { status: "needs_followup", label: "À reprendre" },
    { status: "verified", label: "Vérifiées" },
  ];
  const STATUS_LABEL = { open: "Ouverte", ready: "Prête à vérifier", verified: "Vérifiée", needs_followup: "À reprendre" };
  const KIND_LABEL = { page: "Page", block: "Bloc", source: "Source", citation: "Citation", drawing: "Croquis", snapshot: "Jalon", review_item: "Élément de revue" };
  const EXISTS_LABEL = { ok: "Disponible", archived: "Archivée", missing: "Introuvable", unknown: "État inconnu", corrupt: "Altérée" };
  const FRESH_LABEL = {
    unchanged: "Inchangé depuis la vérification",
    changed: "Modifié depuis la vérification",
    changed_or_removed: "Citation modifiée ou retirée depuis la vérification",
    missing: "Introuvable depuis la vérification",
    unavailable: "Bloc ou page introuvable depuis la vérification",
    unknown: "État actuel inconnu",
    corrupt: "Altéré",
    integrity_anomaly: "Anomalie d'intégrité : mêmes nom, octets différents",
    added_since: "Preuve ajoutée après la vérification",
  };

  const MSG = {
    title: "Vérifications",
    intro: "Une vérification consigne qu'une personne a contrôlé un point précis contre un état précis des preuves. Elle ne rend pas la preuve vraie et ne la modifie jamais.",
    disclosure: "Vérification enregistrée localement ; aucune identité de relecteur authentifiée n'est associée.",
    noIdentity: "Aucune identité de relecteur n'est enregistrée.",
    loading: "Chargement des vérifications…",
    loadFailed: "Vérifications non disponibles pour le moment.",
    none: "Aucune vérification pour ce projet.",
    noneHere: "Aucune vérification liée à cette preuve.",
    noneFiltered: "Aucune vérification ne correspond aux filtres.",
    summaryNone: "Aucune vérification",
    questionLabel: "Question à vérifier",
    questionHelp: "Une question précise, par exemple « Le palier avant est-il usiné en H7 ? ».",
    create: "Créer une vérification",
    createDone: "Vérification créée (ouverte).",
    view: "Détails",
    addEvidence: "Ajouter cette preuve",
    addEvidenceTo: "Ajouter à la vérification",
    evidenceAdded: "Preuve ajoutée. Le statut n'a pas changé.",
    evidenceRemoved: "Preuve retirée.",
    save: "Enregistrer",
    cancel: "Annuler",
    saved: "Enregistré.",
    sections: { question: "Question", target: "Cible", evidence: "Preuves", current: "État actuel", history: "Historique des enregistrements", note: "Commentaire" },
    targetHelp: "Ce que la question vise. La cible n'est pas une preuve tant qu'elle n'est pas aussi ajoutée aux preuves.",
    evidenceHelp: "Preuves canoniques consultées pour répondre. L'ordre n'a pas de sens.",
    noEvidence: "Aucune preuve liée.",
    noteHelp: "Commentaire libre. Il n'est pas une preuve et ne change jamais un enregistrement passé.",
    ready: "Marquer prête à vérifier",
    reopen: "Rouvrir",
    followup: "À reprendre",
    followupLabel: "Motif de reprise",
    followupConfirm: "Marquer « À reprendre »",
    signoff: "Enregistrer la vérification",
    signoffConfirm: "Oui, enregistrer la vérification",
    signoffHelp: "Le serveur observe deux fois la cible et chaque preuve et n'enregistre que si les deux observations concordent. Ce n'est pas une transaction globale.",
    signoffDone: "Vérification enregistrée.",
    signoffReplayed: "Vérification déjà enregistrée : l'enregistrement d'origine est affiché.",
    signoffRace: "Les preuves ont changé pendant l'enregistrement. Rien n'a été enregistré ; réessaie.",
    unavailable: "Impossible d'enregistrer la vérification : certaines preuves ne peuvent pas être vérifiées actuellement.",
    needReady: "La vérification doit être « Prête à vérifier » avec au moins une preuve.",
    del: "Supprimer la vérification",
    delConfirm: "Supprimer définitivement cette vérification ? Elle n'a pas d'historique d'enregistrements ; les preuves ne sont pas touchées.",
    delConfirmYes: "Oui, supprimer la vérification",
    deleted: "Vérification supprimée. Les preuves ne sont pas touchées.",
    hasSignoff: "Suppression impossible : cette vérification a un historique d'enregistrements, conservé.",
    corrupt: "Cette vérification est altérée : lecture seule, rien n'est modifié ni supprimé.",
    invalid: "Fichier de vérification illisible : conservé tel quel.",
    conflict: "Cette vérification a changé ailleurs. La version du serveur est affichée ; ton texte est conservé, rien n'a été fusionné. Vérifie puis réessaie explicitement.",
    offline: "Hors ligne : les vérifications restent lisibles, mais aucune modification n'est possible.",
    full: "Limite atteinte.",
    stateInvalid: "Rouvre la vérification avant de modifier la question ou les preuves.",
    verifiedChanged: "Vérification enregistrée — les preuves actuelles ont changé depuis.",
    verifiedUnchanged: "Vérification enregistrée — les preuves actuelles sont inchangées depuis.",
    verifiedUnknown: "Vérification enregistrée — l'état actuel des preuves n'a pas pu être déterminé.",
    verifiedCorrupt: "Vérification enregistrée — au moins une preuve actuelle est altérée.",
    frozenHeading: "Vérifications actuelles — flux de travail créé après les preuves figées",
    liveHeading: "Vérifications",
    frozenNote: "Ces vérifications sont lues maintenant : elles ne font pas partie de la copie figée affichée.",
    truncated: "Les premières vérifications sont listées (limite atteinte).",
    untrusted: "fichier(s) altéré(s) ou illisible(s) non relié(s)",
    freshnessHint: "Filtre « fraîcheur » : appliqué aux seules lignes chargées (100 au plus). Évalue d'abord leur état actuel.",
    evaluate: "Évaluer l'état actuel des vérifiées",
    evaluated: "État actuel évalué pour les vérifiées chargées.",
    filterDisclosure: "Les filtres s'appliquent aux lignes chargées (100 au plus) ; le texte de la question n'est cherché que dans cette vue.",
    reportAdd: "Ajouter au rapport",
  };

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function codePoints(s) {
    let n = 0;
    for (const _ of String(s)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** Same rule as the server: ≤ 4000 code points, tab / newline allowed, no other control characters, no lone surrogates. */
  function validateText(value, required) {
    if (typeof value !== "string") return { ok: false, reason: "Texte invalide" };
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = value.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          i++;
          continue;
        }
        return { ok: false, reason: "Texte invalide" };
      }
      if (c >= 0xdc00 && c <= 0xdfff) return { ok: false, reason: "Texte invalide" };
      if ((c < 0x20 && c !== 9 && c !== 10) || (c >= 0x7f && c <= 0x9f)) return { ok: false, reason: "Caractères de contrôle interdits" };
    }
    if (!value.trim()) return required ? { ok: false, reason: "Le texte est vide" } : { ok: true, text: "" };
    if (codePoints(value) > TEXT_MAX) return { ok: false, reason: "Texte trop long (" + TEXT_MAX + " caractères maximum)" };
    return { ok: true, text: value };
  }

  function remaining(value) {
    return TEXT_MAX - codePoints(String(value || ""));
  }

  function newRequestId(cryptoLike) {
    const bytes = new Uint8Array(16);
    if (cryptoLike && typeof cryptoLike.getRandomValues === "function") cryptoLike.getRandomValues(bytes);
    else throw new Error("no secure random source");
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- identities (what the server needs to LOCATE the thing; it completes / fingerprints)

  const ref = {
    page: (pageId) => (PAGE_RE.test(String(pageId || "")) ? { kind: "page", page_id: pageId } : null),
    block: (pageId, blockId) => (PAGE_RE.test(String(pageId || "")) && BLOCK_RE.test(String(blockId || "")) ? { kind: "block", page_id: pageId, block_id: blockId } : null),
    source: (sourceId) => (EDITION_RE.test(String(sourceId || "")) ? { kind: "source", source_id: sourceId } : null),
    drawing: (stem) => (STEM_RE.test(String(stem || "")) ? { kind: "drawing", stem } : null),
    snapshot: (snapshotId) => (SNAP_RE.test(String(snapshotId || "")) ? { kind: "snapshot", snapshot_id: snapshotId } : null),
    reviewItem: (reviewId, itemId) => (REVIEW_RE.test(String(reviewId || "")) && ITEM_RE.test(String(itemId || "")) ? { kind: "review_item", review_id: reviewId, item_id: itemId } : null),
    /** The citation VALUE the person sees; the server validates it, finds it in the block and fingerprints it itself. */
    citation: (pageId, blockId, cite) => (PAGE_RE.test(String(pageId || "")) && BLOCK_RE.test(String(blockId || "")) && isObj(cite) ? { kind: "citation", page_id: pageId, block_id: blockId, cite } : null),
  };

  /** A stable key for a stored identity (a list / get answer): kind + the identifying fields. */
  function refKey(r) {
    if (!isObj(r)) return "";
    switch (r.kind) {
      case "page": return "page:" + r.page_id;
      case "block": return "block:" + r.page_id + ":" + r.block_id;
      case "source": return "source:" + r.source_id;
      case "citation": return "citation:" + r.page_id + ":" + r.block_id + ":" + (r.citation_fingerprint || "");
      case "drawing": return "drawing:" + r.stem;
      case "snapshot": return "snapshot:" + r.snapshot_id;
      case "review_item": return "review_item:" + r.review_id + ":" + r.item_id;
      default: return "";
    }
  }

  /** Human text for an identity: kind label + the identifying value. Never a copy of foreign state. */
  function refText(r) {
    if (!isObj(r)) return "";
    const k = KIND_LABEL[r.kind] || "";
    switch (r.kind) {
      case "page": return k + " · " + r.page_id;
      case "block": return k + " · " + r.page_id + " / " + r.block_id;
      case "source": return k + " · " + r.source_id;
      case "citation": return k + " · " + r.page_id + " / " + r.block_id + " · empreinte " + String(r.citation_fingerprint || "").slice(0, 12);
      case "drawing": return k + " · " + r.stem;
      case "snapshot": return k + " · " + r.snapshot_id;
      case "review_item": return k + " · " + r.review_id + " / " + r.item_id;
      default: return "";
    }
  }

  // ---------------------------------------------------------------- request bodies

  function listBody(f) {
    const body = { action: "verification_list" };
    const o = f || {};
    if (o.project_id) body.project_id = o.project_id;
    if (o.status) {
      if (STATUSES.indexOf(o.status) < 0) return null;
      body.status = o.status;
    }
    if (o.target_kind) {
      if (KINDS.indexOf(o.target_kind) < 0) return null;
      body.target_kind = o.target_kind;
    }
    return body;
  }

  function getBody(id) {
    return ID_RE.test(String(id || "")) ? { action: "verification_get", id } : null;
  }

  function resolveBody(ids) {
    const list = Array.isArray(ids) ? Array.from(new Set(ids)) : [ids];
    if (!list.length || list.length > RESOLVE_IDS_MAX || list.some((i) => !ID_RE.test(String(i || "")))) return null;
    return list.length === 1 && !Array.isArray(ids) ? { action: "verification_resolve", id: list[0] } : { action: "verification_resolve", ids: list };
  }

  function relatedBody(refs) {
    const seen = new Set();
    const out = [];
    for (const r of refs || []) {
      if (!isObj(r)) continue;
      const k = JSON.stringify(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.length && out.length <= RELATED_MAX ? { action: "verification_related", targets: out } : null;
  }

  function createBody(target, question, requestId, projectId) {
    const v = validateText(question, true);
    if (!v.ok || !isObj(target) || !REQ_RE.test(String(requestId || ""))) return null;
    const body = { action: "verification_create", request_id: requestId, question: v.text, target };
    if (projectId) body.project_id = projectId;
    return body;
  }

  function revOk(v) {
    return isObj(v) && ID_RE.test(String(v.id || "")) && Number.isInteger(v.rev) && v.rev >= 1;
  }

  function updateBody(v, patch) {
    if (!revOk(v) || !isObj(patch)) return null;
    const body = { action: "verification_update", id: v.id, expected_rev: v.rev };
    if (patch.question !== undefined) {
      const q = validateText(patch.question, true);
      if (!q.ok) return null;
      body.question = q.text;
    }
    if (patch.note !== undefined) {
      const n = validateText(patch.note, false);
      if (!n.ok) return null;
      body.note = n.text;
    }
    return body.question === undefined && body.note === undefined ? null : body;
  }

  function evidenceAddBody(v, r) {
    return revOk(v) && isObj(r) ? { action: "verification_evidence_add", id: v.id, expected_rev: v.rev, ref: r } : null;
  }

  function evidenceRemoveBody(v, evidenceId) {
    return revOk(v) && EVID_RE.test(String(evidenceId || "")) ? { action: "verification_evidence_remove", id: v.id, expected_rev: v.rev, evidence_id: evidenceId } : null;
  }

  /** "verified" can never be requested here: it is reachable only through signoffBody. */
  function statusBody(v, status, followupNote) {
    if (!revOk(v) || status === "verified" || STATUSES.indexOf(status) < 0) return null;
    const body = { action: "verification_status", id: v.id, expected_rev: v.rev, status };
    if (status === "needs_followup") {
      const f = validateText(followupNote, true);
      if (!f.ok) return null;
      body.followup_note = f.text;
    }
    return body;
  }

  function signoffBody(v, requestId) {
    if (!revOk(v) || !REQ_RE.test(String(requestId || ""))) return null;
    const body = { action: "verification_signoff", id: v.id, expected_rev: v.rev, request_id: requestId };
    if (SHA_RE.test(String(v.verification_fingerprint || ""))) body.verification_fingerprint = v.verification_fingerprint; // the SERVER's own value, echoed back
    return body;
  }

  function deleteBody(v, confirmed) {
    return confirmed === true && revOk(v) ? { action: "verification_delete", id: v.id, expected_rev: v.rev, confirm: true } : null;
  }

  // ---------------------------------------------------------------- answers / display

  /** "Vérification : À reprendre" — the prefix keeps it apart from any Review Pack status that can be on screen too. */
  function statusText(status) {
    return "Vérification : " + (STATUS_LABEL[status] || "");
  }

  function summaryText(counts) {
    const c = isObj(counts) ? counts : {};
    const parts = [];
    if (c.open) parts.push(c.open + (c.open > 1 ? " ouvertes" : " ouverte"));
    if (c.ready) parts.push(c.ready + (c.ready > 1 ? " prêtes à vérifier" : " prête à vérifier"));
    if (c.needs_followup) parts.push(c.needs_followup + " à reprendre");
    if (c.verified) parts.push(c.verified + (c.verified > 1 ? " vérifiées" : " vérifiée"));
    return parts.length ? parts.join(" · ") : MSG.summaryNone;
  }

  function group(rows) {
    const out = GROUPS.map((g) => ({ status: g.status, label: g.label, rows: [] }));
    const other = [];
    for (const r of rows || []) {
      const g = r.integrity === "ok" || r.integrity === undefined ? out.find((x) => x.status === r.status) : null;
      if (g) g.rows.push(r);
      else other.push(r); // corrupt / invalid files have no trusted status: listed apart, read-only
    }
    return { groups: out, other };
  }

  /** Client-side filters over the loaded rows only (disclosed in the UI). `fresh` maps id -> overall freshness once evaluated. */
  function filterRows(rows, f, fresh) {
    const o = f || {};
    const text = typeof o.text === "string" ? o.text.trim().toLowerCase() : "";
    return (rows || []).filter((r) => {
      if (o.project_id && r.project_id !== o.project_id) return false;
      if (o.status && r.status !== o.status) return false;
      if (o.target_kind && !(r.target && r.target.kind === o.target_kind)) return false;
      if (o.freshness) {
        const v = fresh && fresh[r.id];
        if (!v || v !== o.freshness) return false;
      }
      if (text && String(r.question || "").toLowerCase().indexOf(text) < 0) return false;
      return true;
    });
  }

  function freshText(state) {
    return FRESH_LABEL[state] || "";
  }

  function existsText(state) {
    return EXISTS_LABEL[state] || "";
  }

  /** The line shown for a signed item, from the aggregate freshness. */
  function overallText(overall) {
    if (overall === "unchanged") return MSG.verifiedUnchanged;
    if (overall === "changed" || overall === "integrity_anomaly") return overall === "integrity_anomaly" ? MSG.verifiedChanged + " (anomalie d'intégrité)" : MSG.verifiedChanged;
    if (overall === "corrupt") return MSG.verifiedCorrupt;
    return MSG.verifiedUnknown;
  }

  function fmtDate(ts) {
    if (!Number.isFinite(ts)) return "";
    try {
      return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    } catch (_) {
      return "";
    }
  }

  function errorInfo(err) {
    const d = err && isObj(err.data) ? err.data : {};
    const code = typeof d.code === "string" ? d.code : "";
    let message = E.message(err, 200);
    if (code === "verification_evidence_unavailable") message = MSG.unavailable;
    else if (code === "verification_capture_race") message = MSG.signoffRace;
    else if (code === "verification_has_signoff") message = MSG.hasSignoff;
    else if (code === "verification_state_invalid") message = MSG.stateInvalid;
    else if (code === "verification_not_ready" || code === "verification_no_evidence") message = MSG.needReady;
    return {
      code,
      status: err && Number.isInteger(err.status) ? err.status : 0,
      conflict: code === "verification_conflict",
      currentRev: Number.isInteger(d.current_rev) ? d.current_rev : null,
      corrupt: code === "verification_corrupt",
      full: code === "verification_limit",
      entries: Array.isArray(d.entries) ? d.entries : [],
      definite: !!code, // a coded refusal is a known outcome; a bare network error is not (the retry reuses the SAME request id)
      message,
    };
  }

  return {
    TEXT_MAX, LIST_MAX, RELATED_MAX, RESOLVE_IDS_MAX, EVIDENCE_MAX, STATUSES, KINDS, GROUPS, STATUS_LABEL, KIND_LABEL, EXISTS_LABEL, FRESH_LABEL, MSG,
    ID_RE, EVID_RE, REQ_RE,
    codePoints, validateText, remaining, newRequestId,
    ref, refKey, refText,
    listBody, getBody, resolveBody, relatedBody, createBody, updateBody, evidenceAddBody, evidenceRemoveBody, statusBody, signoffBody, deleteBody,
    statusText, summaryText, group, filterRows, freshText, existsText, overallText, fmtDate, errorInfo,
  };
});
