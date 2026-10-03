/* Transfert HQ — Carnet Phase 6: Ask Carnet — PURE view models (no DOM, no network, no storage, no clock).
 *
 * Ask Carnet is an EVIDENCE finder, not an answerer: the server lists the passages of the notebook that contain the terms of the
 * question, exactly as written, each with its page / block / deep link. Nothing is generated, summarised, inferred or saved here.
 *
 *   1. request     validQuestion / scopeChoices / requestBody   the exact wire shape (nothing else is ever sent)
 *   2. status      statusModel                                  evidence / partial / insufficient / empty — always a text, never colour alone
 *   3. cards       cardModel / highlight                        highlighted excerpt, provenance of OCR / transcript text, snapshot state
 *   4. report      reportItem                                   the wire shape of an explicit "ask_evidence" report item
 *
 * Derived text (OCR / transcript) is always shown WITH its source relation; when the canonical source cannot be found it says so.
 * Plain ES2020, UMD (browser global HqCarnetAsk / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetAsk = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const QUESTION_MAX = 300;
  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const PROJ_RE = /^proj-[A-Za-z0-9_-]{1,64}$/;
  const SNAP_RE = /^snap-[0-9a-f]{24}$/;
  const FP_RE = /^[0-9a-f]{32}$/;
  const LINK_RE = /^#carnet\/page-[A-Za-z0-9_-]{1,64}\/block-[A-Za-z0-9_-]{1,64}$/;
  const KIND_LABEL = { note: "Note", table: "Tableau", decision: "Décision", measure: "Mesure", drawing: "Croquis", callout: "Encadré", toggle: "Bloc repliable", image: "Image", source: "Source", portal: "Portail" };
  const STATE_LABEL = { ok: "Disponible", missing: "Introuvable", unknown: "État inconnu" };
  const LIVE_LABEL = { unchanged: "Identique dans le carnet actuel", changed: "Modifié depuis le jalon", gone: "Absent du carnet actuel" };
  const VERDICT_LABEL = { in: "Dans la tolérance", out: "Hors tolérance", none: "Sans tolérance", incompatible: "Unités incompatibles" };
  const SOURCE_WORD = { asset: "image", voice: "note vocale", drawing: "croquis", file: "fichier" };
  const REASON = {
    empty: "Écris une question.",
    stop_words_only: "La question ne contient que des mots trop courants : précise un terme.",
    scope_empty: "Ce périmètre ne contient aucune note.",
    no_match: "Aucun passage du carnet ne contient ces termes dans ce périmètre.",
    weak_match: "Aucun passage ne contient tous les termes.",
    source_metadata_only: "Seules des métadonnées de sources correspondent ; aucun passage de note.",
  };
  const NOT_PROOF = "Aucun résultat ne prouve une absence : la recherche porte sur les mots écrits, sans synonymes.";

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

  // ------------------------------------------------------------------ 1. request

  function validQuestion(raw) {
    const text = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, text, error: REASON.empty };
    if (text.length > QUESTION_MAX) return { ok: false, text, error: "Question trop longue (" + QUESTION_MAX + " caractères au plus)." };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return { ok: false, text, error: "Caractères non autorisés." };
    return { ok: true, text, error: "" };
  }

  /** Scope choices, narrowest first. The default is the current project; widening is always an explicit pick. */
  function scopeChoices(ctx) {
    const c = isObj(ctx) ? ctx : {};
    const out = [];
    if (isObj(c.page) && PAGE_RE.test(c.page.id)) out.push({ value: "page", label: "Cette note", scope: { kind: "page", id: c.page.id } });
    const projects = Array.isArray(c.projects) ? c.projects.filter((p) => isObj(p) && PROJ_RE.test(p.id)) : [];
    const cur = c.projectId && projects.find((p) => p.id === c.projectId);
    if (cur) out.push({ value: "project", label: "Ce projet : " + cur.name, scope: { kind: "project", id: cur.id } });
    else if (c.projectId === "none" || c.page) out.push({ value: "project", label: "Notes sans projet", scope: { kind: "project", id: "none" } });
    for (const p of projects) if (!cur || p.id !== cur.id) out.push({ value: "project:" + p.id, label: "Projet : " + p.name, scope: { kind: "project", id: p.id } });
    for (const s of Array.isArray(c.snapshots) ? c.snapshots : []) {
      if (isObj(s) && SNAP_RE.test(s.id) && (s.integrity || "ok") === "ok") out.push({ value: "snapshot:" + s.id, label: "Jalon figé : " + s.label, scope: { kind: "snapshot", id: s.id } });
    }
    out.push({ value: "notebook", label: "Tout le carnet", scope: { kind: "notebook" } });
    return out;
  }

  function defaultScope(choices) {
    const list = Array.isArray(choices) ? choices : [];
    return (list.find((x) => x.value === "project") || list.find((x) => x.value === "notebook") || list[0] || { value: "notebook" }).value;
  }

  function requestBody(question, scope, limit) {
    const q = validQuestion(question);
    if (!q.ok || !isObj(scope)) return null;
    const body = { action: "ask", question: q.text, scope: scope.kind === "notebook" ? { kind: "notebook" } : { kind: scope.kind, id: scope.id } };
    if (Number.isInteger(limit) && limit >= 1 && limit <= 20) body.limit = limit;
    return body;
  }

  // ------------------------------------------------------------------ 2. status

  function statusModel(res) {
    if (!isObj(res)) return { tone: "error", mark: "▲", title: "Recherche impossible", text: "", notes: [] };
    const c = isObj(res.counts) ? res.counts : {};
    const notes = [];
    if (res.terms_truncated) notes.push("Seuls les premiers termes de la question ont été utilisés.");
    if (res.incomplete) notes.push("Le périmètre dépasse les limites de recherche : tout n'a pas été parcouru. " + NOT_PROOF);
    if (res.status === "evidence") {
      notes.push(NOT_PROOF);
      return { tone: "evidence", mark: "●", title: (c.shown || 0) + " passage(s) pertinent(s) — termes trouvés indiqués sur chaque carte", text: "Périmètre : " + scopeText(res.scope) + ".", notes };
    }
    if (res.status === "partial") {
      const miss = Array.isArray(res.unmatched_terms) && res.unmatched_terms.length ? " Termes introuvables : " + res.unmatched_terms.join(", ") + "." : "";
      return { tone: "partial", mark: "◆", title: "Preuves partielles", text: "Aucun passage ne contient tous les termes ; voici ceux qui en contiennent une partie." + miss, notes };
    }
    if (res.status === "insufficient") {
      notes.push(NOT_PROOF);
      return { tone: "insufficient", mark: "○", title: "Pas assez de preuves dans le carnet", text: REASON[res.reason] || REASON.no_match, notes };
    }
    return { tone: "empty", mark: "○", title: "Question à préciser", text: REASON[res.reason] || REASON.empty, notes };
  }

  function scopeText(scope) {
    if (!isObj(scope)) return "";
    const base = { page: "cette note", project: "projet", notebook: "tout le carnet", snapshot: "jalon figé" }[scope.kind] || "";
    return scope.kind === "notebook" || scope.kind === "page" ? base + (scope.kind === "page" && scope.label ? " « " + scope.label + " »" : "") : base + " « " + (scope.label || "") + " »";
  }

  // ------------------------------------------------------------------ 3. cards

  /** ``[{text, hit}]`` from an excerpt and its [start, end) spans; spans are clamped, sorted and merged, never trusted blindly. */
  function highlight(excerpt, marks) {
    const s = String(excerpt == null ? "" : excerpt);
    const spans = (Array.isArray(marks) ? marks : [])
      .filter((m) => Array.isArray(m) && Number.isInteger(m[0]) && Number.isInteger(m[1]))
      .map((m) => [Math.max(0, Math.min(s.length, m[0])), Math.max(0, Math.min(s.length, m[1]))])
      .filter((m) => m[1] > m[0])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const m of spans) {
      const last = merged[merged.length - 1];
      if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
      else merged.push([m[0], m[1]]);
    }
    const out = [];
    let at = 0;
    for (const [a, b] of merged) {
      if (a > at) out.push({ text: s.slice(at, a), hit: false });
      out.push({ text: s.slice(a, b), hit: true });
      at = b;
    }
    if (at < s.length) out.push({ text: s.slice(at), hit: false });
    return out;
  }

  function safeLink(link) {
    return typeof link === "string" && LINK_RE.test(link) ? link : null;
  }

  /** In a frozen scope every state is the state SEALED at freeze; what exists now is said separately, only when it differs. */
  function currentLabel(sealed, now) {
    return typeof now === "string" && now !== sealed ? "Maintenant : " + (STATE_LABEL[now] || STATE_LABEL.unknown).toLowerCase() : "";
  }

  function provenanceModel(pv) {
    if (!isObj(pv) || !pv.derived) return null;
    const src = isObj(pv.source) ? pv.source : {};
    const blk = isObj(src.block) ? src.block : null;
    const word = SOURCE_WORD[src.kind] || "source";
    return {
      label: String(pv.label || ""),
      kind: pv.kind,
      sourceWord: word,
      state: src.state || "unknown",
      stateLabel: STATE_LABEL[src.state] || STATE_LABEL.unknown,
      currentLabel: currentLabel(src.state, src.current_state),
      sourceLink: blk ? safeLink(blk.link) : null,
      sourcePage: blk ? String(blk.page_title || "") : "",
      sourceFound: !!blk,
      text: blk
        ? "Texte dérivé de l'" + (word === "image" ? "image" : word) + " d'origine (" + (blk.page_title || "note") + "). Le texte ci-dessous n'est pas la source."
        : "Texte dérivé d'une " + word + " dont le bloc n'est pas dans ce périmètre (" + (STATE_LABEL[src.state] || STATE_LABEL.unknown).toLowerCase() + "). Le texte ci-dessous n'est pas la source.",
    };
  }

  function cardModel(card, res) {
    if (!isObj(card)) return null;
    const frozen = !!(isObj(res) && res.frozen);
    const m = isObj(card.measure) ? card.measure : null;
    const d = isObj(card.drawing) ? card.drawing : null;
    return {
      id: String(card.id || ""),
      kind: card.kind,
      kindLabel: KIND_LABEL[card.kind] || "Passage",
      derived: card.class === "derived",
      reference: card.class === "reference",
      classLabel: card.class === "derived" ? "Texte dérivé" : card.class === "reference" ? "Référence stockée (cible non lue)" : "Écrit dans le carnet",
      pageId: card.page_id,
      pageTitle: String(card.page_title || ""),
      blockId: card.block_id || null,
      link: frozen ? null : safeLink(card.link),
      liveLink: frozen ? safeLink(card.live_link) : null,
      liveState: frozen ? card.live_state || "gone" : null,
      liveLabel: frozen ? LIVE_LABEL[card.live_state] || LIVE_LABEL.gone : "",
      segments: highlight(card.excerpt, card.marks),
      matched: Array.isArray(card.matched) ? card.matched.slice() : [],
      coverage: typeof card.coverage === "number" ? Math.round(card.coverage * 100) : 0,
      date: typeof card.at === "number" ? fmtDate(card.at) : "",
      measure: m ? { label: String(m.label || ""), value: String(m.value == null ? "" : m.value) + (m.unit ? " " + m.unit : ""), verdict: m.verdict, verdictLabel: VERDICT_LABEL[m.verdict] || "" } : null,
      drawing: d ? { stem: d.stem, state: d.state, stateLabel: STATE_LABEL[d.state] || STATE_LABEL.unknown, currentLabel: currentLabel(d.state, d.current_state) } : null,
      provenance: provenanceModel(card.provenance),
      refs: Array.isArray(card.refs) ? card.refs.slice() : [],
    };
  }

  function sourceModel(s, res) {
    if (!isObj(s)) return null;
    const frozen = !!(isObj(res) && res.frozen);
    return {
      id: s.id, title: String(s.title || ""), meta: [s.author, s.edition, s.year].filter((x) => x).join(" · "),
      stateLabel: STATE_LABEL[s.state] || STATE_LABEL.unknown, currentLabel: currentLabel(s.state, s.current_state), matched: Array.isArray(s.matched) ? s.matched.slice() : [],
      segments: highlight(s.excerpt, s.marks), total: s.cited_total || 0,
      citedIn: (Array.isArray(s.cited_in) ? s.cited_in : []).map((c) => ({ pageTitle: String(c.page_title || ""), link: frozen ? null : safeLink(c.link) })),
    };
  }

  function resultModel(res) {
    if (!isObj(res)) return null;
    return {
      status: statusModel(res),
      note: String(res.note || ""),
      cards: (Array.isArray(res.cards) ? res.cards : []).map((c) => cardModel(c, res)).filter(Boolean),
      sources: (Array.isArray(res.sources) ? res.sources : []).map((s) => sourceModel(s, res)).filter(Boolean),
      frozen: isObj(res.frozen) ? { label: String(res.frozen.label || ""), date: fmtDate(res.frozen.created_at) } : null,
      canReport: (res.status === "evidence" || res.status === "partial") && FP_RE.test(String(res.fingerprint || "")),
    };
  }

  // ------------------------------------------------------------------ 4. report

  /** The wire item of an EXPLICIT "add to report": the report re-runs the search and is refused (report_stale) if the evidence changed. */
  function reportItem(res, scope) {
    if (!isObj(res) || !(res.status === "evidence" || res.status === "partial") || !FP_RE.test(String(res.fingerprint || ""))) return null;
    const q = validQuestion(res.question);
    if (!q.ok || !isObj(scope)) return null;
    return { kind: "ask_evidence", question: q.text, scope: scope.kind === "notebook" ? { kind: "notebook" } : { kind: scope.kind, id: scope.id }, fingerprint: res.fingerprint, label: "Preuves — « " + q.text.slice(0, 60) + " »" };
  }

  return {
    QUESTION_MAX, KIND_LABEL, STATE_LABEL, LIVE_LABEL, REASON, NOT_PROOF,
    validQuestion, scopeChoices, defaultScope, requestBody, statusModel, highlight, cardModel, sourceModel, resultModel, reportItem, fmtDate,
  };
});
