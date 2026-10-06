/* Transfert HQ — Carnet Phase 10: live annotations and Review Pack comments — PURE model (no DOM, no network, no storage, no clock).
 *
 * Evidence stays evidence. Commentary stays commentary. An annotation is commentary attached to evidence; it is never part of the evidence
 * and never changes the source, the page, a snapshot, an Ask answer or a report. A Review Pack comment belongs to the review discussion
 * around a captured item; it is NOT a live annotation, and live annotations never enter a pack on their own.
 *
 * This module only builds request bodies, validates text exactly like the server (Unicode code points, no control characters),
 * and maps server answers onto wording. The server owns identity: the client never sends a fingerprint it computed.
 * Plain ES2020, UMD (browser global HqCarnetAnnotations / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetAnnotations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const E = (typeof module === "object" && module && module.exports && typeof require === "function") ? require("./hq-carnet-errors.js") : globalThis.HqCarnetErrors; // Phase 13: typed fallback message

  const BODY_MAX = 4000;
  const TARGETS_PER_LIST_MAX = 10;
  const LIST_MAX = 100;
  const PER_TARGET_MAX = 100;
  const EDITION_RE = /^srce-[A-Za-z0-9_-]{1,64}$/;
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const REVIEW_RE = /^rvw-[0-9a-f]{24}$/;
  const ITEM_RE = /^ri-[0-9a-f]{16}$/;
  const ANN_RE = /^ant-[0-9a-f]{24}$|^ann-[0-9a-f]{16,24}$/;
  const COMMENT_RE = /^rcm-[0-9a-f]{16}$/;
  const REQ_RE = /^[0-9a-f]{32}$/;
  const PDF_MAX = 100000;
  const LOC_MAX = 120;

  const MSG = {
    section: "Annotations",
    sectionHelp: "Commentaire attaché à cette preuve. Il ne fait pas partie de la preuve et ne la modifie jamais.",
    frozenHeading: "Annotations actuelles — non incluses dans la preuve figée",
    liveHeading: "Annotations actuelles",
    none: "Aucune annotation pour cette preuve.",
    loading: "Chargement des annotations…",
    loadFailed: "Annotations non disponibles pour le moment.",
    label: "Annotation",
    add: "Ajouter l'annotation",
    save: "Enregistrer",
    cancel: "Annuler",
    edit: "Modifier",
    resolve: "Marquer comme résolue",
    reopen: "Rouvrir",
    del: "Supprimer l'annotation",
    confirmDelete: "Supprimer définitivement cette annotation ? La preuve n'est pas touchée.",
    confirmYes: "Oui, supprimer l'annotation",
    deleted: "Annotation supprimée. La preuve n'est pas touchée.",
    saved: "Annotation enregistrée.",
    conflict: "Cette annotation a changé ailleurs. La version du serveur est affichée ; ton texte est conservé ci-dessous, rien n'a été fusionné. Vérifie puis réessaie explicitement.",
    conflictDelete: "Cette annotation a changé ailleurs : la suppression n'a pas été faite. Relis-la avant de confirmer à nouveau.",
    corrupt: "Cette annotation est altérée : elle est affichée en lecture seule et n'est pas modifiable.",
    offline: "Hors ligne : les annotations restent lisibles, mais aucune modification n'est possible.",
    full: "Limite d'annotations atteinte pour cette preuve.",
    viewEvidence: "Lire la preuve",
    attachPage: "Attacher à la page PDF",
    noPage: "Sans page PDF",
    truncated: "Les premières annotations sont listées (limite atteinte).",
    unavailable: "annotation(s) illisible(s) non affichée(s)",
    commentsHeading: "Commentaires",
    commentLabel: "Commentaire de revue",
    commentAdd: "Ajouter le commentaire",
    commentHelp: "Les commentaires de revue sont conservés avec la revue : ils ne peuvent être ni modifiés ni supprimés. Pour corriger, ajoute un nouveau commentaire.",
    commentSupersedes: "Ce commentaire corrige un commentaire précédent",
    commentCorrects: "corrige",
    commentRemovedGroup: "Preuves retirées",
    commentRemovedNote: "Ces commentaires concernent une preuve qui n'est plus dans la revue. Ils sont conservés avec l'identité capturée.",
    commentDone: "Commentaire ajouté.",
    commentCorrupt: "Fil de commentaires altéré : lecture seule, rien n'est modifié.",
    commentInvalid: "Fil de commentaires illisible : lecture seule.",
    commentFull: "Limite de commentaires atteinte.",
    commentNotLive: "Distinct des annotations actuelles : un commentaire de revue n'est jamais une annotation.",
  };

  const CITATION_STATE = {
    unchanged: "Citation inchangée dans le bloc.",
    changed_or_removed: "Citation modifiée ou retirée du bloc (impossible de les distinguer). L'annotation reste attachée à l'ancienne citation.",
    unavailable: "Bloc ou page introuvable. L'annotation est conservée mais n'est rattachée à rien d'actuel.",
  };
  const SOURCE_STATE = {
    available: "Source disponible.",
    archived: "Source archivée.",
    missing: "Source introuvable. L'annotation est conservée.",
    unknown: "État de la source non vérifiable pour le moment.",
  };

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function codePoints(s) {
    let n = 0;
    for (const _ of String(s)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** Same rule as the server: non-empty after trim, ≤ 4000 code points, tab/newline allowed, no other control characters, no lone surrogates. */
  function validateBody(value) {
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
    if (!value.trim()) return { ok: false, reason: "Le texte est vide" };
    if (codePoints(value) > BODY_MAX) return { ok: false, reason: "Texte trop long (" + BODY_MAX + " caractères maximum)" };
    return { ok: true, text: value };
  }

  function remaining(value) {
    return BODY_MAX - codePoints(String(value || ""));
  }

  function newRequestId(cryptoLike) {
    const bytes = new Uint8Array(16);
    if (cryptoLike && typeof cryptoLike.getRandomValues === "function") cryptoLike.getRandomValues(bytes);
    else throw new Error("no secure random source");
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- targets (identity only: ownership, never the anchor)

  function sourceTarget(sourceId) {
    return typeof sourceId === "string" && EDITION_RE.test(sourceId) ? { kind: "source", source_id: sourceId } : null;
  }

  /** The citation VALUE the person sees; the server validates it, finds it in the block and computes the fingerprint itself. */
  function citationTarget(pageId, blockId, cite) {
    if (!PAGE_RE.test(String(pageId || "")) || !BLOCK_RE.test(String(blockId || "")) || !isObj(cite)) return null;
    return { kind: "citation", page_id: pageId, block_id: blockId, cite };
  }

  /** The stored form (what lists return): no cite value, only the server fingerprint. */
  function targetKey(t) {
    if (!isObj(t)) return "";
    if (t.kind === "source") return "source:" + t.source_id;
    if (t.kind === "citation") return "citation:" + t.page_id + ":" + t.block_id + ":" + (t.citation_fingerprint || "");
    return "";
  }

  /** The anchor is WHERE the person was looking (never identity): {loc, pdf} or null. */
  function anchorFor(pdf, loc) {
    const hasPdf = Number.isInteger(pdf) && pdf >= 1 && pdf <= PDF_MAX;
    const l = typeof loc === "string" && loc && loc.length <= LOC_MAX && !/[\u0000-\u001f\u007f]/.test(loc) ? loc : null;
    if (!hasPdf && !l) return null;
    return { loc: l, pdf: hasPdf ? pdf : null };
  }

  function anchorText(a) {
    if (!isObj(a)) return "";
    const parts = [];
    if (a.loc) parts.push(a.loc);
    if (a.pdf) parts.push("page PDF " + a.pdf);
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------- request bodies

  function listBody(targets) {
    const seen = new Set();
    const out = [];
    for (const t of targets || []) {
      if (!isObj(t)) continue;
      const k = JSON.stringify(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    if (!out.length || out.length > TARGETS_PER_LIST_MAX) return null;
    return { action: "annotation_list", targets: out };
  }

  function createBody(target, anchor, text, requestId) {
    const v = validateBody(text);
    if (!v.ok || !isObj(target) || !REQ_RE.test(String(requestId || ""))) return null;
    return { action: "annotation_create", request_id: requestId, target, anchor: anchor || null, body: v.text };
  }

  function stored(target) {
    // A stored target (from a list) is sent back exactly as returned: kind + ids + fingerprint. The server re-derives and compares.
    return Object.assign({}, target);
  }

  function updateBody(a, patch) {
    if (!isObj(a) || !isObj(patch) || !Number.isInteger(a.rev) || a.rev < 1) return null;
    const body = { action: "annotation_update", id: a.id, target: stored(a.target), expected_rev: a.rev };
    if (patch.body !== undefined) {
      const v = validateBody(patch.body);
      if (!v.ok) return null;
      body.body = v.text;
    }
    if (patch.status !== undefined) {
      if (patch.status !== "open" && patch.status !== "resolved") return null;
      body.status = patch.status;
    }
    return body.body === undefined && body.status === undefined ? null : body;
  }

  function deleteBody(a, confirmed) {
    if (confirmed !== true || !isObj(a) || !Number.isInteger(a.rev) || a.rev < 1) return null;
    return { action: "annotation_delete", id: a.id, target: stored(a.target), expected_rev: a.rev, confirm: true };
  }

  function commentBody(reviewId, itemId, text, requestId, supersedes) {
    const v = validateBody(text);
    if (!v.ok || !REVIEW_RE.test(String(reviewId || "")) || !ITEM_RE.test(String(itemId || "")) || !REQ_RE.test(String(requestId || ""))) return null;
    if (supersedes !== null && supersedes !== undefined && !COMMENT_RE.test(String(supersedes))) return null;
    return { action: "rcomment_add", review_id: reviewId, item_id: itemId, request_id: requestId, body: v.text, supersedes: supersedes || null };
  }

  function commentListBody(reviewId) {
    return REVIEW_RE.test(String(reviewId || "")) ? { action: "rcomment_list", review_id: reviewId } : null;
  }

  // ---------------------------------------------------------------- answers

  function targetStateText(result) {
    if (!isObj(result) || !isObj(result.target)) return "";
    const table = result.target.kind === "citation" ? CITATION_STATE : SOURCE_STATE;
    return table[result.target_state] || "";
  }

  function identicalNote(result) {
    const n = isObj(result) && Number.isInteger(result.identical_count) ? result.identical_count : 0;
    return n > 1 ? n + " citations identiques dans ce bloc" : "";
  }

  function errorInfo(err) {
    const d = err && isObj(err.data) ? err.data : {};
    const code = typeof d.code === "string" ? d.code : "";
    return {
      code,
      status: err && Number.isInteger(err.status) ? err.status : 0,
      conflict: code === "annotation_conflict",
      currentRev: Number.isInteger(d.current_rev) ? d.current_rev : null,
      corrupt: code === "annotation_corrupt" || code === "review_comment_corrupt" || code === "review_corrupt",
      full: code === "annotation_limit" || code === "review_comment_limit",
      definite: !!code, // a coded refusal is a known outcome; a bare network error is not (the retry then reuses the same request id)
      message: E.message(err, 200),
    };
  }

  /** Groups a comment thread by item: present items first (pack order), then removed items by captured identity. */
  function groupThread(thread, itemIds) {
    const comments = thread && Array.isArray(thread.comments) ? thread.comments : [];
    const byItem = new Map();
    const removed = new Map();
    for (const c of comments) {
      if (!isObj(c) || !isObj(c.item)) continue;
      const bucket = c.item_present ? byItem : removed;
      const k = c.item.item_id;
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(c);
    }
    return {
      byItem: (id) => byItem.get(id) || [],
      removed: Array.from(removed.entries()).map(([id, list]) => ({ item_id: id, item: list[0].item, comments: list })),
      count: comments.length,
      items: itemIds || [],
    };
  }

  return {
    BODY_MAX, TARGETS_PER_LIST_MAX, LIST_MAX, PER_TARGET_MAX, MSG, CITATION_STATE, SOURCE_STATE,
    EDITION_RE, PAGE_RE, BLOCK_RE, REVIEW_RE, ITEM_RE, ANN_RE, COMMENT_RE, REQ_RE,
    codePoints, validateBody, remaining, newRequestId,
    sourceTarget, citationTarget, targetKey, anchorFor, anchorText,
    listBody, createBody, updateBody, deleteBody, commentBody, commentListBody,
    targetStateText, identicalNote, errorInfo, groupThread,
  };
});
