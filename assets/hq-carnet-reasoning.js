/* Transfert HQ — Carnet Phase 12: decisions & assumptions register — PURE model (no DOM, no network, no storage, no clock).
 *
 * A decision records what was CHOSEN. An assumption records what is being taken as true FOR NOW. Neither is evidence: evidence tells us what we
 * know, assumptions what we temporarily accept, decisions what we chose. Every status change is an explicit human action; evidence, linked
 * verifications and time never change a status. There is no identity, no confidence, no priority, no assignee, no due date.
 *
 * Kinds are namespaced `reasoning_decision` / `reasoning_assumption`: the bare word "decision" always means the Phase 5 journal block.
 * This module builds request bodies, validates text like the server, groups / filters the (≤100) loaded headers and maps answers onto
 * procedural wording. The server owns identity, seals and captures. Plain ES2020, UMD (browser global HqCarnetReasoning / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReasoning = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const E = (typeof module === "object" && module && module.exports && typeof require === "function") ? require("./hq-carnet-errors.js") : globalThis.HqCarnetErrors; // Phase 13: typed fallback message

  const STATEMENT_MAX = 4000;
  const RATIONALE_MAX = 8000;
  const LIST_MAX = 100;
  const RELATED_MAX = 10;
  const RESOLVE_IDS_MAX = 25;
  const EVIDENCE_MAX = 100;
  const ID_RE = /^(?:dec|asm)-[0-9a-f]{24}$/;
  const VER_RE = /^ver-[0-9a-f]{24}$/;
  const EVID_RE = /^re-[0-9a-f]{16}$/;
  const REQ_RE = /^[0-9a-f]{32}$/;
  const PROJECT_RE = /^proj-[A-Za-z0-9_-]{1,64}$/;
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const EDITION_RE = /^srce-[A-Za-z0-9_-]{1,64}$/;
  const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  const SNAP_RE = /^snap-[0-9a-f]{24}$/;
  const REVIEW_RE = /^rvw-[0-9a-f]{24}$/;
  const ITEM_RE = /^ri-[0-9a-f]{16}$/;

  const KIND_DECISION = "reasoning_decision";
  const KIND_ASSUMPTION = "reasoning_assumption";
  const KINDS = [KIND_DECISION, KIND_ASSUMPTION];
  const KIND_LABEL = { reasoning_decision: "Décision", reasoning_assumption: "Hypothèse" };
  const STATUSES = { reasoning_decision: ["active", "superseded", "withdrawn"], reasoning_assumption: ["active", "confirmed", "invalidated", "retired", "superseded"] };
  const ALL_STATUSES = ["active", "confirmed", "invalidated", "retired", "withdrawn", "superseded"];
  const EFFECTIVE_EXTRA = ["supersession_pending", "supersession_indeterminate"];
  const STATUS_LABEL = {
    active: "Active", confirmed: "Confirmée", invalidated: "Invalidée", retired: "Hypothèse retirée", withdrawn: "Décision retirée", superseded: "Remplacée",
    supersession_pending: "Remplacement en cours", supersession_indeterminate: "Remplacement indéterminé",
  };
  const DEC_STATUS_LABEL = { active: "Active", withdrawn: "Décision retirée", superseded: "Remplacée" };
  const GROUPS = [
    { id: "dec-active", kind: KIND_DECISION, label: "Décisions actives", statuses: ["active"] },
    { id: "dec-history", kind: KIND_DECISION, label: "Décisions historiques", statuses: ["withdrawn", "superseded"] },
    { id: "asm-active", kind: KIND_ASSUMPTION, label: "Hypothèses actives", statuses: ["active"] },
    { id: "asm-confirmed", kind: KIND_ASSUMPTION, label: "Hypothèses confirmées", statuses: ["confirmed"] },
    { id: "asm-invalidated", kind: KIND_ASSUMPTION, label: "Hypothèses invalidées", statuses: ["invalidated"] },
    { id: "asm-retired", kind: KIND_ASSUMPTION, label: "Hypothèses retirées", statuses: ["retired"] },
    { id: "asm-superseded", kind: KIND_ASSUMPTION, label: "Hypothèses remplacées", statuses: ["superseded"] },
  ];
  const EVIDENCE_KINDS = ["page", "block", "source", "citation", "drawing", "snapshot", "review_item"];
  const EV_LABEL = { page: "Page", block: "Bloc", source: "Source", citation: "Citation", drawing: "Croquis", snapshot: "Jalon", review_item: "Élément de revue" };
  const EXISTS_LABEL = { ok: "Disponible", archived: "Archivée", missing: "Introuvable", unknown: "État inconnu", corrupt: "Altérée" };
  const FRESH_LABEL = {
    unchanged: "Inchangé depuis la transition",
    changed: "Modifié depuis la transition",
    changed_or_removed: "Citation modifiée ou retirée depuis la transition",
    missing: "Introuvable depuis la transition",
    unavailable: "Bloc ou page introuvable depuis la transition",
    unknown: "État actuel inconnu",
    corrupt: "Altéré",
    integrity_anomaly: "Anomalie d'intégrité : mêmes nom, octets différents",
    not_captured: "Non capturé lors de la transition",
  };
  const EVENT_LABEL = { confirmed: "Confirmée", invalidated: "Invalidée", retired: "Hypothèse retirée du raisonnement", withdrawn: "Décision retirée", superseded: "Remplacée" };

  const MSG = {
    title: "Registre des décisions et hypothèses",
    intro: "Une décision consigne ce qui a été choisi ; une hypothèse, ce qui est tenu pour vrai pour l'instant. Ni l'une ni l'autre n'est une preuve.",
    disclosure: "Registre local : une décision ou une hypothèse n'est pas une preuve ; aucune identité d'auteur authentifiée n'est associée.",
    journalDistinct: "Distinct des blocs « Décision » du journal : ceux-ci sont du contenu de page, ce registre est un objet de gouvernance.",
    loading: "Chargement du registre…",
    loadFailed: "Registre non disponible pour le moment.",
    none: "Aucune décision ni hypothèse pour ce projet.",
    noneHere: "Aucune décision ni hypothèse liée à cette preuve.",
    noneFiltered: "Aucun enregistrement ne correspond aux filtres.",
    summaryNone: "Aucun enregistrement",
    statementLabel: "Énoncé",
    rationaleLabel: "Justification",
    statementHelpDecision: "Ce qui a été choisi, par exemple « Utiliser un DN80 pour la ligne de transfert ».",
    statementHelpAssumption: "Ce qui est tenu pour vrai pour l'instant, par exemple « Masse volumique = 998 kg/m³ à 20 °C ».",
    rationaleHelp: "Pourquoi. Texte libre : ce n'est pas une preuve et il n'est jamais lu par la recherche ni par « Demander au carnet ».",
    createDecision: "Créer une décision",
    createAssumption: "Créer une hypothèse",
    create: "Créer",
    createDone: "Enregistrement créé (actif).",
    view: "Détails",
    save: "Enregistrer",
    cancel: "Annuler",
    saved: "Enregistré.",
    sections: { statement: "Énoncé", rationale: "Justification", evidence: "Preuves", verifications: "Vérifications liées", current: "État actuel des preuves", history: "Historique" },
    evidenceHelp: "Preuves canoniques qui éclairent cet enregistrement. L'ordre n'a pas de sens ; un enregistrement n'est jamais lui-même une preuve.",
    noEvidence: "Aucune preuve liée.",
    verificationsHelp: "Les vérifications liées restent des objets distincts : leur statut ne change jamais celui de cet enregistrement.",
    noVerifications: "Aucune vérification liée.",
    linkVerification: "Lier une vérification",
    linkVerificationYes: "Lier",
    unlink: "Délier",
    addEvidence: "Ajouter cette preuve",
    removeEvidence: "Retirer la preuve",
    evidenceAdded: "Preuve ajoutée. Le statut n'a pas changé.",
    evidenceRemoved: "Preuve retirée.",
    linked: "Vérification liée. Le statut n'a pas changé.",
    unlinked: "Vérification déliée.",
    confirm: "Confirmer l'hypothèse",
    confirmYes: "Oui, confirmer l'hypothèse",
    confirmHelp: "Le serveur observe deux fois chaque preuve et ne confirme que si toutes sont actuellement lisibles et concordantes. Ce n'est pas une transaction globale.",
    confirmDone: "Hypothèse confirmée.",
    unavailable: "Impossible de confirmer l'hypothèse : certaines preuves ne peuvent pas être vérifiées actuellement.",
    noEvidenceConfirm: "Au moins une preuve est nécessaire pour confirmer une hypothèse.",
    race: "Les preuves ont changé pendant la confirmation. Rien n'a été enregistré ; réessaie.",
    invalidate: "Invalider",
    retire: "Retirer l'hypothèse",
    withdraw: "Retirer la décision",
    terminalHelp: "Cette transition est définitive. L'hypothèse restera consultable dans l'historique et ne pourra plus être modifiée. L'état des preuves est consigné au mieux, sans bloquer.",
    terminalHelpDecision: "Cette transition est définitive. La décision restera consultable dans l'historique et ne pourra plus être modifiée. L'état des preuves est consigné au mieux, sans bloquer.",
    terminalYes: "Oui, continuer",
    terminalDone: "Enregistrement mis à jour.",
    supersede: "Remplacer",
    supersedeHelp: "Crée un nouvel enregistrement actif du même type et marque celui-ci « Remplacé ». Rien n'est lié automatiquement ; les preuves ne sont pas copiées.",
    supersedeYes: "Oui, remplacer",
    supersedeDone: "Enregistrement remplacé : le successeur est créé.",
    supersedeReplayed: "Remplacement déjà effectué : le résultat d'origine est affiché.",
    supersedeStatement: "Énoncé du successeur",
    supersedeRationale: "Justification du successeur",
    pending: "Remplacement en cours : le successeur existe mais ce prédécesseur n'a pas été mis à jour. Rejoue la même demande pour terminer ; rien d'autre n'est possible.",
    indeterminate: "État de supersession indéterminé — successeur altéré",
    requestCorrupt: "Une requête portant ce numéro existe déjà dans un enregistrement altéré : réutilisation refusée, rien n'a été créé ni réparé.",
    indeterminateHelp: "Le successeur est altéré : aucune modification ni nouveau remplacement tant que le fichier n'est pas traité hors des chemins normaux.",
    del: "Supprimer l'enregistrement",
    delConfirm: "Supprimer définitivement cet enregistrement ? Il n'a jamais changé de statut ni été remplacé ; les preuves ne sont pas touchées.",
    delConfirmYes: "Oui, supprimer",
    deleted: "Enregistrement supprimé. Les preuves ne sont pas touchées.",
    hasHistory: "Suppression impossible : cet enregistrement a un historique (statut, remplacement), conservé.",
    historical: "Enregistrement historique : énoncé, justification, preuves et liens sont en lecture seule. Une prémisse qui change devient un nouvel enregistrement.",
    corrupt: "Cet enregistrement est altéré : lecture seule, rien n'est modifié ni supprimé.",
    invalid: "Fichier illisible : conservé tel quel.",
    conflict: "Cet enregistrement a changé ailleurs. La version du serveur est affichée ; ton texte est conservé, rien n'a été fusionné. Vérifie puis réessaie explicitement.",
    offline: "Hors ligne : le registre reste lisible, mais aucune modification n'est possible.",
    full: "Limite atteinte.",
    projectMismatch: "Cette preuve ou cette vérification appartient à un autre projet : refus.",
    liveHeading: "Décisions et hypothèses",
    frozenHeading: "Décisions et hypothèses actuelles — créées après la copie figée",
    frozenNote: "Ces enregistrements sont lus maintenant : ils ne font pas partie de la copie figée affichée.",
    truncated: "Les premiers enregistrements sont listés (limite atteinte).",
    untrusted: "fichier(s) altéré(s) ou illisible(s) non relié(s)",
    filterDisclosure: "Les filtres s'appliquent aux lignes chargées (100 au plus) ; le texte de l'énoncé n'est cherché que dans cette vue.",
    freshnessHint: "Filtre « fraîcheur » : appliqué aux seules lignes chargées. Évalue d'abord leur état actuel.",
    evaluate: "Évaluer l'état actuel des enregistrements historiques",
    evaluated: "État actuel évalué pour les enregistrements historiques chargés.",
    openWorkspace: "Ouvrir le registre",
    reportAdd: "Ajouter au rapport",
    activeNoCapture: "Enregistrement actif : seule l'existence des preuves est indiquée.",
    liveLabel: "État actuel (lu maintenant)",
  };

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function codePoints(s) {
    let n = 0;
    for (const _ of String(s)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** Same rule as the server: code points ≤ max, tab / newline allowed, no other control characters, no lone surrogates. */
  function validateText(value, required, max) {
    const limit = max || STATEMENT_MAX;
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
    if (codePoints(value) > limit) return { ok: false, reason: "Texte trop long (" + limit + " caractères maximum)" };
    return { ok: true, text: value };
  }

  const validateStatement = (v) => validateText(v, true, STATEMENT_MAX);
  const validateRationale = (v) => validateText(v, false, RATIONALE_MAX);
  const remaining = (value, max) => (max || STATEMENT_MAX) - codePoints(String(value || ""));

  function newRequestId(cryptoLike) {
    const bytes = new Uint8Array(16);
    if (cryptoLike && typeof cryptoLike.getRandomValues === "function") cryptoLike.getRandomValues(bytes);
    else throw new Error("no secure random source");
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- identities (what the server needs to LOCATE the thing)

  const ref = {
    page: (pageId) => (PAGE_RE.test(String(pageId || "")) ? { kind: "page", page_id: pageId } : null),
    block: (pageId, blockId) => (PAGE_RE.test(String(pageId || "")) && BLOCK_RE.test(String(blockId || "")) ? { kind: "block", page_id: pageId, block_id: blockId } : null),
    source: (sourceId) => (EDITION_RE.test(String(sourceId || "")) ? { kind: "source", source_id: sourceId } : null),
    drawing: (stem) => (STEM_RE.test(String(stem || "")) ? { kind: "drawing", stem } : null),
    snapshot: (snapshotId) => (SNAP_RE.test(String(snapshotId || "")) ? { kind: "snapshot", snapshot_id: snapshotId } : null),
    reviewItem: (reviewId, itemId) => (REVIEW_RE.test(String(reviewId || "")) && ITEM_RE.test(String(itemId || "")) ? { kind: "review_item", review_id: reviewId, item_id: itemId } : null),
    citation: (pageId, blockId, cite) => (PAGE_RE.test(String(pageId || "")) && BLOCK_RE.test(String(blockId || "")) && isObj(cite) ? { kind: "citation", page_id: pageId, block_id: blockId, cite } : null),
  };

  function refText(r) {
    if (!isObj(r)) return "";
    const k = EV_LABEL[r.kind] || "";
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
    const body = { action: "reasoning_list" };
    const o = f || {};
    if (o.project_id) {
      if (!PROJECT_RE.test(String(o.project_id))) return null;
      body.project_id = o.project_id;
    }
    if (o.kind) {
      if (KINDS.indexOf(o.kind) < 0) return null;
      body.kind = o.kind;
    }
    if (o.status) {
      if (ALL_STATUSES.concat(EFFECTIVE_EXTRA).indexOf(o.status) < 0) return null;
      body.status = o.status;
    }
    return body;
  }

  const getBody = (id) => (ID_RE.test(String(id || "")) ? { action: "reasoning_get", id } : null);

  function resolveBody(ids) {
    const list = Array.isArray(ids) ? Array.from(new Set(ids)) : [ids];
    if (!list.length || list.length > RESOLVE_IDS_MAX || list.some((i) => !ID_RE.test(String(i || "")))) return null;
    return list.length === 1 && !Array.isArray(ids) ? { action: "reasoning_resolve", id: list[0] } : { action: "reasoning_resolve", ids: list };
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
    return out.length && out.length <= RELATED_MAX ? { action: "reasoning_related", targets: out } : null;
  }

  /** `evidence` (optional, ≤10) is part of the replay intent. The Reader pre-attaches the opened source / citation here. */
  function createBody(kind, projectId, statement, rationale, requestId, evidence) {
    const s = validateStatement(statement);
    const r = validateRationale(rationale || "");
    if (KINDS.indexOf(kind) < 0 || !PROJECT_RE.test(String(projectId || "")) || !s.ok || !r.ok || !REQ_RE.test(String(requestId || ""))) return null;
    const body = { action: "reasoning_create", request_id: requestId, kind, project_id: projectId, statement: s.text, rationale: r.text };
    if (Array.isArray(evidence) && evidence.length) {
      if (evidence.length > 10 || evidence.some((e) => !isObj(e))) return null;
      body.evidence = evidence;
    }
    return body;
  }

  const revOk = (v) => isObj(v) && ID_RE.test(String(v.id || "")) && Number.isInteger(v.rev) && v.rev >= 1;

  function updateBody(v, patch) {
    if (!revOk(v) || !isObj(patch)) return null;
    const body = { action: "reasoning_update", id: v.id, expected_rev: v.rev };
    if (patch.statement !== undefined) {
      const s = validateStatement(patch.statement);
      if (!s.ok) return null;
      body.statement = s.text;
    }
    if (patch.rationale !== undefined) {
      const r = validateRationale(patch.rationale);
      if (!r.ok) return null;
      body.rationale = r.text;
    }
    return body.statement === undefined && body.rationale === undefined ? null : body;
  }

  const evidenceAddBody = (v, r) => (revOk(v) && isObj(r) ? { action: "reasoning_evidence_add", id: v.id, expected_rev: v.rev, ref: r } : null);
  const evidenceRemoveBody = (v, evidenceId) => (revOk(v) && EVID_RE.test(String(evidenceId || "")) ? { action: "reasoning_evidence_remove", id: v.id, expected_rev: v.rev, evidence_id: evidenceId } : null);
  const linkBody = (v, verificationId) => (revOk(v) && VER_RE.test(String(verificationId || "")) ? { action: "reasoning_verification_link", id: v.id, expected_rev: v.rev, verification_id: verificationId } : null);
  const unlinkBody = (v, verificationId) => (revOk(v) && VER_RE.test(String(verificationId || "")) ? { action: "reasoning_verification_unlink", id: v.id, expected_rev: v.rev, verification_id: verificationId } : null);

  /** Legal explicit targets per kind. "superseded" is NEVER a status request: it only exists through supersedeBody. */
  /** assumptions: active → confirmed|invalidated|retired; confirmed → invalidated|retired. */
  function targetsFor(rec) {
    if (!isObj(rec) || rec.integrity !== "ok") return [];
    const eff = rec.effective_status || rec.status;
    if (rec.kind === KIND_DECISION) return eff === "active" ? ["withdrawn"] : [];
    if (rec.kind === KIND_ASSUMPTION) return eff === "active" ? ["confirmed", "invalidated", "retired"] : eff === "confirmed" ? ["invalidated", "retired"] : [];
    return [];
  }

  function statusBody(v, status) {
    if (!revOk(v) || targetsFor(v).indexOf(status) < 0) return null;
    return { action: "reasoning_status", id: v.id, expected_rev: v.rev, status };
  }

  function canSupersede(rec) {
    return targetsFor(rec).length > 0 && !rec.superseded_by && (rec.effective_status || rec.status) !== "supersession_pending";
  }

  function supersedeBody(v, statement, rationale, requestId) {
    const s = validateStatement(statement);
    const r = validateRationale(rationale || "");
    if (!revOk(v) || !canSupersede(v) || !s.ok || !r.ok || !REQ_RE.test(String(requestId || ""))) return null;
    return { action: "reasoning_supersede", predecessor_id: v.id, expected_rev: v.rev, request_id: requestId, statement: s.text, rationale: r.text };
  }

  /** Delete is offered only while active with no predecessor, no successor and no status transition. The server decides; this only hides the button. */
  function canDelete(rec) {
    return isObj(rec) && rec.integrity === "ok" && rec.status === "active" && rec.effective_status === "active" && !rec.supersedes && !rec.superseded_by && !rec.claimed_by_count && (!Array.isArray(rec.history) || rec.history.length === 0) && !(Array.isArray(rec.claimed_by) && rec.claimed_by.length);
  }

  const deleteBody = (v, confirmed) => (confirmed === true && revOk(v) ? { action: "reasoning_delete", id: v.id, expected_rev: v.rev, confirm: true } : null);

  function isHistorical(rec) {
    return isObj(rec) && ["confirmed", "invalidated", "retired", "withdrawn", "superseded"].indexOf(rec.status) >= 0;
  }

  // ---------------------------------------------------------------- answers / display

  function statusText(rec) {
    const eff = typeof rec === "string" ? rec : rec.effective_status || rec.status;
    const kind = typeof rec === "string" ? null : rec.kind;
    const label = kind === KIND_DECISION ? DEC_STATUS_LABEL[eff] || STATUS_LABEL[eff] : STATUS_LABEL[eff];
    return (label || "") ;
  }

  function summaryText(counts) {
    const c = isObj(counts) ? counts : {};
    const dec = isObj(c[KIND_DECISION]) ? c[KIND_DECISION] : {};
    const asm = isObj(c[KIND_ASSUMPTION]) ? c[KIND_ASSUMPTION] : {};
    const n = (o) => Object.keys(o).reduce((a, k) => a + (o[k] || 0), 0);
    const parts = [];
    if (n(dec)) parts.push(n(dec) + (n(dec) > 1 ? " décisions" : " décision") + (dec.active ? " (" + dec.active + " active" + (dec.active > 1 ? "s" : "") + ")" : ""));
    if (n(asm)) parts.push(n(asm) + (n(asm) > 1 ? " hypothèses" : " hypothèse") + (asm.active ? " (" + asm.active + " active" + (asm.active > 1 ? "s" : "") + ")" : ""));
    return parts.length ? parts.join(" · ") : MSG.summaryNone;
  }

  /** "N vérifications liées · M vérifiée(s)" — a DISPLAY only, never a gate. */
  function verificationSummaryText(sm) {
    const s = isObj(sm) ? sm : {};
    const n = s.count || 0;
    if (!n) return MSG.noVerifications;
    const m = s.verified || 0;
    return n + (n > 1 ? " vérifications liées" : " vérification liée") + " · " + m + (m > 1 ? " vérifiées" : " vérifiée");
  }

  function group(rows) {
    const out = GROUPS.map((g) => ({ id: g.id, kind: g.kind, label: g.label, rows: [] }));
    const pending = [];
    const other = [];
    for (const r of rows || []) {
      if (r.integrity !== "ok") {
        other.push(r); // corrupt / invalid: no trusted status, listed apart first, read-only
        continue;
      }
      const eff = r.effective_status || r.status;
      if (eff === "supersession_pending" || eff === "supersession_indeterminate") {
        pending.push(r);
        continue;
      }
      const g = out.find((x) => x.kind === r.kind && GROUPS.find((y) => y.id === x.id).statuses.indexOf(eff) >= 0);
      if (g) g.rows.push(r);
      else other.push(r);
    }
    return { groups: out, pending, other };
  }

  function filterRows(rows, f, fresh) {
    const o = f || {};
    const text = typeof o.text === "string" ? o.text.trim().toLowerCase() : "";
    return (rows || []).filter((r) => {
      if (o.project_id && r.project_id !== o.project_id) return false;
      if (o.kind && r.kind !== o.kind) return false;
      if (o.status && (r.effective_status || r.status) !== o.status) return false;
      if (o.freshness) {
        const v = fresh && fresh[r.id];
        if (!v || v !== o.freshness) return false;
      }
      if (o.verification) {
        const vs = r.verification_summary;
        if (o.verification === "none" ? (r.verification_count || 0) !== 0 : o.verification === "linked" ? (r.verification_count || 0) === 0 : !(vs && vs.verified > 0)) return false;
      }
      if (text && String(r.statement || "").toLowerCase().indexOf(text) < 0) return false;
      return true;
    });
  }

  const freshText = (state) => FRESH_LABEL[state] || "";
  const existsText = (state) => EXISTS_LABEL[state] || "";

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
    if (code === "reasoning_evidence_unavailable") message = MSG.unavailable;
    else if (code === "reasoning_capture_race") message = MSG.race;
    else if (code === "reasoning_no_evidence") message = MSG.noEvidenceConfirm;
    else if (code === "reasoning_has_history") message = MSG.hasHistory;
    else if (code === "reasoning_state_invalid") message = MSG.historical;
    else if (code === "reasoning_supersession_pending") message = MSG.pending;
    else if (code === "reasoning_supersession_indeterminate") message = MSG.indeterminate;
    else if (code === "reasoning_project_mismatch") message = MSG.projectMismatch;
    else if (code === "reasoning_request_corrupt") message = MSG.requestCorrupt;
    return {
      code,
      status: err && Number.isInteger(err.status) ? err.status : 0,
      conflict: code === "reasoning_conflict",
      currentRev: Number.isInteger(d.current_rev) ? d.current_rev : null,
      corrupt: code === "reasoning_corrupt",
      full: code === "reasoning_limit",
      requestConflict: code === "decision_request_conflict" || code === "assumption_request_conflict",
      requestCorrupt: code === "reasoning_request_corrupt",
      entries: Array.isArray(d.entries) ? d.entries : [],
      definite: !!code, // a coded refusal is a known outcome; a bare network error is not (the retry reuses the SAME request id)
      message,
    };
  }

  return {
    STATEMENT_MAX, RATIONALE_MAX, LIST_MAX, RELATED_MAX, RESOLVE_IDS_MAX, EVIDENCE_MAX, KIND_DECISION, KIND_ASSUMPTION, KINDS, KIND_LABEL, STATUSES, ALL_STATUSES,
    STATUS_LABEL, GROUPS, EVIDENCE_KINDS, EV_LABEL, EXISTS_LABEL, FRESH_LABEL, EVENT_LABEL, MSG, ID_RE, VER_RE, EVID_RE, REQ_RE,
    codePoints, validateText, validateStatement, validateRationale, remaining, newRequestId,
    ref, refText,
    listBody, getBody, resolveBody, relatedBody, createBody, updateBody, evidenceAddBody, evidenceRemoveBody, linkBody, unlinkBody, statusBody, supersedeBody, deleteBody,
    targetsFor, canSupersede, canDelete, isHistorical,
    statusText, summaryText, verificationSummaryText, group, filterRows, freshText, existsText, fmtDate, errorInfo,
  };
});
