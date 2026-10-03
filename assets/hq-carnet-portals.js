/* Transfert HQ — Carnet Phase 8: portal blocks — PURE view models (no DOM, no network, no storage, no clock).
 *
 * A portal block is a read-only window onto a canonical object owned elsewhere. The page stores the REFERENCE only
 * ({ref:{kind,id}, view}); everything shown here is the live answer of the read-only batched resolver (POST portal_resolve),
 * never stored in the notebook. A malformed answer is treated as "unknown": it can never reach the canonical block.
 *
 *   1. request     batchBodies / uniqueRefs        the exact wire shape (max 100 refs, deduplicated)
 *   2. row         rowModel / sanitizeRow          a strict copy of one resolver row (text only), or an "unknown" row
 *   3. card        cardModel                       compact | card view model, with the "Dernier état chargé" (offline) wording
 * Plain ES2020, UMD (browser global HqCarnetPortals / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetPortals = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const REFS_MAX = 100;
  const KINDS = ["source", "file", "model", "media", "snapshot", "review"];
  const KIND_LABEL = { source: "Source", file: "Fichier", model: "Modèle", media: "Média", snapshot: "Jalon", review: "Dossier de revue" };
  const STATES = ["available", "missing", "unknown", "corrupt", "archived", "anomaly"];
  const STATE_FALLBACK = { available: "Disponible", missing: "Introuvable", unknown: "État inconnu", corrupt: "Altéré", archived: "Archivée", anomaly: "Anomalie d’intégrité" };
  const MSG = {
    stale: "Dernier état chargé",
    loading: "Chargement de l’état actuel…",
    failed: "État actuel indisponible",
    refresh: "Actualiser",
    open: "Ouvrir",
    inspect: "Inspecter",
    replace: "Remplacer la cible",
    remove: "Retirer du carnet",
    keep: "L’objet reste dans son module.",
    live: "État actuel, lu à l’affichage — rien n’est copié dans cette page.",
  };
  const TEXT_MAX = 240;

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function clip(v) {
    return typeof v === "string" ? v.slice(0, TEXT_MAX) : "";
  }

  function key(ref) {
    return ref.kind + "\u0000" + ref.id;
  }

  /** Distinct stored references, in first-seen order. */
  function uniqueRefs(payloads) {
    const seen = new Set();
    const out = [];
    for (const p of payloads || []) {
      if (!isObj(p) || !isObj(p.ref) || KINDS.indexOf(p.ref.kind) < 0 || typeof p.ref.id !== "string") continue;
      const k = key(p.ref);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: p.ref.kind, id: p.ref.id });
    }
    return out;
  }

  /** One request body per 100 references: {action:"portal_resolve", refs}. Nothing else is ever sent. */
  function batchBodies(refs) {
    const out = [];
    for (let i = 0; i < refs.length; i += REFS_MAX) out.push({ action: "portal_resolve", refs: refs.slice(i, i + REFS_MAX) });
    return out;
  }

  function unknownRow(ref, reason) {
    return {
      ref: { kind: ref.kind, id: ref.id }, kind_label: KIND_LABEL[ref.kind] || "", state: "unknown", state_label: STATE_FALLBACK.unknown,
      title: "", subtitle: clip(ref.id), metadata: reason ? [{ label: "Raison", value: clip(reason), type: "text" }] : [], actions: [], integrity: null, thumb_url: null, open_url: null,
    };
  }

  /** Strict, text-only copy of one resolver row. Anything off-schema yields an "unknown" row for the STORED reference. */
  function sanitizeRow(raw, ref) {
    if (!isObj(raw) || !isObj(raw.ref) || raw.ref.kind !== ref.kind || raw.ref.id !== ref.id || STATES.indexOf(raw.state) < 0) return unknownRow(ref, "Réponse inattendue");
    const meta = [];
    for (const m of Array.isArray(raw.metadata) ? raw.metadata.slice(0, 12) : []) {
      if (!isObj(m) || typeof m.label !== "string") continue;
      const v = m.value;
      meta.push({ label: clip(m.label), value: typeof v === "number" && Number.isFinite(v) ? v : clip(typeof v === "string" ? v : ""), type: typeof m.type === "string" ? clip(m.type) : "text" });
    }
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).filter((a) => a === "open" || a === "inspect");
    const thumb = typeof raw.thumb_url === "string" && raw.thumb_url.startsWith("/files/") ? raw.thumb_url : null;
    const open = typeof raw.open_url === "string" && raw.open_url.startsWith("/files/") ? raw.open_url : null;
    return {
      ref: { kind: ref.kind, id: ref.id }, kind_label: KIND_LABEL[ref.kind] || "", state: raw.state, state_label: clip(raw.state_label) || STATE_FALLBACK[raw.state],
      title: clip(raw.title), subtitle: clip(raw.subtitle), metadata: meta, actions, integrity: typeof raw.integrity === "string" ? clip(raw.integrity) : null, thumb_url: thumb, open_url: open,
    };
  }

  /** Maps a resolver response onto the requested references (by identity, never by position alone). */
  function rowsFor(refs, res) {
    const by = new Map();
    if (isObj(res) && Array.isArray(res.results)) {
      for (const r of res.results) if (isObj(r) && isObj(r.ref) && typeof r.ref.kind === "string" && typeof r.ref.id === "string") by.set(key(r.ref), r);
    }
    return refs.map((ref) => sanitizeRow(by.get(key(ref)), ref));
  }

  /**
   * View model of one portal block. ``row`` is the live resolver row (or null while loading); ``stale`` = the row is the last one
   * loaded and a refresh failed (offline): the state is shown as "Dernier état chargé", never as fresh.
   */
  function cardModel(payload, row, opts) {
    const o = opts || {};
    const ref = payload.ref;
    const kindLabel = KIND_LABEL[ref.kind] || ref.kind;
    const compact = payload.view === "compact";
    if (!row) {
      return { kind: ref.kind, kindLabel, id: ref.id, view: payload.view, compact, state: o.failed ? "unknown" : "loading", stateLabel: o.failed ? MSG.failed : MSG.loading, title: ref.id, subtitle: "", metadata: [], actions: [], stale: false, thumb: null, openUrl: null };
    }
    return {
      kind: ref.kind, kindLabel, id: ref.id, view: payload.view, compact, state: row.state,
      stateLabel: o.stale ? MSG.stale + " : " + row.state_label : row.state_label,
      title: row.title || ref.id, subtitle: row.subtitle, metadata: compact ? [] : row.metadata, actions: row.actions, stale: !!o.stale,
      thumb: compact ? null : row.thumb_url, openUrl: row.open_url,
    };
  }

  return { REFS_MAX, KINDS, KIND_LABEL, STATES, MSG, uniqueRefs, batchBodies, sanitizeRow, rowsFor, cardModel, unknownRow };
});
