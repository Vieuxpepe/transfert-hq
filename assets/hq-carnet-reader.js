/* Transfert HQ — Carnet Phase 9: Reader — PURE view models (no DOM, no network, no storage, no clock).
 *
 * The Reader VIEWS evidence; it never transforms, summarises or reinterprets it. Everything shown comes from the read-only batched
 * resolver (POST reader_resolve), which answers with three explicitly separate parts: captured (what was written THEN), current
 * (what is true NOW) and integrity (frozen contexts only). This module only maps that answer onto wording and decisions:
 *
 *   1. request   entryFor / uniqueEntries / batchBodies   identities only (edition id, citation as stored, frozen context), ≤100 per batch
 *   2. answer    sanitizeResult / resultsFor              a strict, text-only copy; anything off-schema becomes an "unknown" result
 *   3. card      cardModel                                lines, captured/current table, status wording, integrity banner
 *   4. viewer    viewerPlan                               which PDF (if any) may load automatically, and what must be labelled
 *
 * A locator is NOT a PDF page: neither is derived from the other. "ok" is always worded "Emplacement vérifié" (the LOCATION only).
 * Plain ES2020, UMD (browser global HqCarnetReader / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENTRIES_MAX = 100;
  const TEXT_MAX = 400;
  const PAGE_MAX = 100000;
  const EDITION_ID_RE = /^srce-[A-Za-z0-9_-]{1,64}$/;
  const SOURCE_STATES = ["available", "archived", "missing", "unknown"];
  const FILE_STATES = ["ok", "missing", "unknown", "none"];
  const INTEGRITY = ["not_applicable", "matches_seal", "differs_from_seal", "sealed_file_missing", "unknown"];
  const LOC_LABEL = { page: "Page", section: "Section", clause: "Article / clause", chapter: "Chapitre", figure: "Figure", table: "Tableau", custom: "Autre" };
  const FIELD_LABEL = { title: "Titre", author: "Auteur", edition: "Édition", year: "Année", publisher: "Éditeur", identifier: "Référence", type: "Type" };
  const FIELDS = ["title", "author", "edition", "year", "publisher", "identifier", "type"];
  const TYPE_LABEL = { book: "Livre", standard: "Norme", article: "Article", datasheet: "Fiche technique", catalogue: "Catalogue fabricant", procedure: "Procédure interne", web: "Web", other: "Autre" };

  const MSG = {
    title: "Lecteur de source",
    close: "Fermer le lecteur",
    locationOk: "Emplacement vérifié",
    locationOkNote: "L’emplacement seulement, pas le contenu.",
    locationNo: "Emplacement non vérifié",
    locator: "Emplacement source",
    pdfPage: "Page PDF",
    noPdfPage: "Aucune page PDF enregistrée pour cette citation.",
    noLocator: "Aucun emplacement source enregistré.",
    captured: "Enregistré dans la citation",
    capturedFrozen: "Preuve figée",
    current: "Source actuelle",
    differs: "Diffère",
    same: "Identique",
    migrated: "Provenance de migration",
    srcAvailable: "Source disponible",
    srcArchived: "Source archivée",
    srcMissing: "Source introuvable — la citation est conservée",
    srcUnknown: "État de la source inconnu",
    fileOk: "Fichier PDF disponible",
    fileMissing: "Fichier PDF introuvable",
    fileUnknown: "État du fichier inconnu",
    fileNone: "Aucun fichier PDF associé",
    sealMatches: "Fichier actuel identique au fichier scellé",
    sealDiffers: "Le fichier actuel diffère du fichier scellé lors de cette revue / de ce jalon.",
    sealMissing: "Les octets figés ne sont plus disponibles : seules les métadonnées figées restent affichées.",
    sealUnknown: "Intégrité du fichier scellé indéterminée.",
    sealNone: "Aucun fichier n’avait été scellé avec cette preuve.",
    liveScope: "Preuve en direct : le fichier affiché est le fichier actuel.",
    frozenUnavailable: "La preuve figée est illisible ou altérée : elle n’est pas affichée.",
    openCurrentDifferent: "Ouvrir le fichier actuel (différent)",
    openCurrentUnknown: "Ouvrir le fichier actuel (non comparé)",
    openCurrentUnsealed: "Ouvrir le fichier actuel (non scellé)",
    viewerDifferent: "Fichier actuel — différent de la preuve figée",
    viewerUnknown: "Fichier actuel — non comparé à la preuve figée",
    viewerUnsealed: "Fichier actuel — non scellé avec la preuve figée",
    pageJumpUnavailable: "Ce navigateur ignore la page demandée : le saut de page n’est pas disponible. Le document s’ouvre à son début.",
    openTab: "Ouvrir le PDF dans un onglet",
    loading: "Chargement de la source…",
    failed: "Lecture indisponible",
    backToCitation: "Retour à la citation",
    backToPortal: "Retour au portail",
    seePortal: "Voir le portail de cette source",
    citationsHere: "Citations de cette page",
    sealRefused: "Le fichier a changé depuis le scellé : la preuve figée n’est pas affichée.",
    sealGone: "Le fichier scellé n’est plus disponible : la preuve figée ne peut pas être affichée.",
    sealUnreadable: "Le fichier scellé ne peut être ni vérifié ni lu : la preuve figée n’est pas affichée.",
    sealTooLarge: "Le fichier scellé est trop volumineux pour être vérifié et affiché ici : la preuve figée n’est pas affichée.",
    sealUnavailable: "La preuve figée n’est pas disponible (instantané illisible ou sans fichier scellé) : aucun fichier n’est affiché.",
    authError: "Session expirée ou accès refusé : le document ne peut pas être affiché.",
  };

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function clip(v) {
    return typeof v === "string" ? v.slice(0, TEXT_MAX) : "";
  }

  function pageOk(v) {
    return Number.isInteger(v) && v >= 1 && v <= PAGE_MAX ? v : null;
  }

  // ------------------------------------------------------------------ 1. request

  function canon(v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (isObj(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }

  /** The wire entry for one piece of evidence. Identities only: never a path, a URL or a hash. */
  function entryFor(spec) {
    if (!isObj(spec) || typeof spec.sourceId !== "string" || !EDITION_ID_RE.test(spec.sourceId)) return null;
    const e = { source_id: spec.sourceId };
    if (isObj(spec.citation)) e.citation = spec.citation;
    if (isObj(spec.context)) e.context = spec.context;
    return e;
  }

  function entryKey(e) {
    return canon([e.source_id, e.citation || null, e.context || null]);
  }

  function uniqueEntries(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries || []) {
      if (!isObj(e) || typeof e.source_id !== "string") continue;
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  }

  /** One request body per 100 entries: {action:"reader_resolve", entries}. Nothing else is ever sent. A frozen context goes alone. */
  function batchBodies(entries) {
    const out = [];
    const plain = [];
    for (const e of entries) {
      if (e.context) out.push({ action: "reader_resolve", entries: [e] });
      else plain.push(e);
    }
    for (let i = 0; i < plain.length; i += ENTRIES_MAX) out.push({ action: "reader_resolve", entries: plain.slice(i, i + ENTRIES_MAX) });
    return out;
  }

  // ------------------------------------------------------------------ 2. answer

  function unknownResult(sourceId, reason) {
    return {
      source_id: clip(sourceId), captured: null, reason: clip(reason || ""),
      current: { state: "unknown", metadata: null, file: { state: "unknown", route: null } },
      differs: [], integrity: { state: "unknown", route: null }, frozen: null,
    };
  }

  function cleanMeta(raw) {
    if (!isObj(raw)) return null;
    const out = {};
    for (const k of FIELDS) {
      const v = raw[k];
      if (typeof v === "string" && v) out[k] = clip(v);
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }

  function cleanLocator(raw) {
    return isObj(raw) && typeof raw.kind === "string" && typeof raw.text === "string" && raw.text ? { kind: clip(raw.kind), text: clip(raw.text) } : null;
  }

  // The verified frozen-PDF route: identities only, exact shape (the server resolves the seal and binds the hash to the streamed bytes).
  const VERIFIED_ROUTE = /^\/api\/carnet\/reader-pdf\?(?:snapshot=snap-[0-9a-f]{24}|review=rvw-[0-9a-f]{24}&item=ri-[0-9a-f]{16})&source=srce-[A-Za-z0-9_-]{1,64}$/;

  /** The verified route's refusal ``code`` -> ONE state-specific message (changed / gone / cannot verify / too large / unavailable).
   *  Any other JSON on that route (no known code: a session or role refusal) is an access failure, never "changed". */
  function verifiedRefusal(code) {
    switch (code) {
      case "differs_from_seal": return { key: "differs", text: MSG.sealRefused };
      case "sealed_file_missing": return { key: "missing", text: MSG.sealGone };
      case "sealed_file_noncanonical":
      case "sealed_file_unreadable":
      case "storage_error": return { key: "unknown", text: MSG.sealUnreadable };
      case "sealed_file_too_large": return { key: "unknown", text: MSG.sealTooLarge };
      case "frozen_unavailable":
      case "no_sealed_file": return { key: "unavailable", text: MSG.sealUnavailable };
      default: return { key: "unknown", text: MSG.authError };
    }
  }

  /** The ``code`` of a refusal body (JSON text) or null. */
  function refusalCode(text) {
    try {
      const j = JSON.parse(String(text));
      return isObj(j) && typeof j.code === "string" ? j.code : null;
    } catch (e) {
      return null;
    }
  }

  function isVerifiedRoute(v) {
    return typeof v === "string" && VERIFIED_ROUTE.test(v);
  }

  function cleanRoute(v) {
    if (typeof v === "string" && VERIFIED_ROUTE.test(v)) return v;
    return typeof v === "string" && v.startsWith("/files/") && !v.includes("..") && !v.includes("\\") && !/[\u0000-\u001f]/.test(v) ? v : null;
  }

  function cleanCaptured(raw) {
    if (!isObj(raw)) return null;
    const prov = isObj(raw.provenance) && typeof raw.provenance.source_id === "string"
      ? { source_id: clip(raw.provenance.source_id), locator: cleanLocator(raw.provenance.locator), pdf: pageOk(raw.provenance.pdf), location_verified: raw.provenance.location_verified === true }
      : null;
    const out = {
      kind: ["citation", "snapshot", "review_item"].includes(raw.kind) ? raw.kind : "citation",
      metadata: cleanMeta(raw.metadata) || {}, missing: raw.missing === true,
      locator: cleanLocator(raw.locator), pdf: pageOk(raw.pdf),
      location_verified: typeof raw.location_verified === "boolean" ? raw.location_verified : null,
      provenance: prov,
    };
    if (isObj(raw.citation)) out.citation = cleanCaptured({ ...raw.citation, kind: "citation" });
    return out;
  }

  /** Strict, text-only copy of one resolver result. Anything off-schema yields "unknown" for the REQUESTED edition. */
  function sanitizeResult(raw, entry) {
    const sid = entry.source_id;
    if (!isObj(raw) || raw.source_id !== sid || !isObj(raw.current) || SOURCE_STATES.indexOf(raw.current.state) < 0) return unknownResult(sid, "Réponse inattendue");
    const file = isObj(raw.current.file) && FILE_STATES.indexOf(raw.current.file.state) >= 0 ? { state: raw.current.file.state, route: cleanRoute(raw.current.file.route) } : { state: "unknown", route: null };
    const integ = isObj(raw.integrity) && INTEGRITY.indexOf(raw.integrity.state) >= 0 ? { state: raw.integrity.state, route: cleanRoute(raw.integrity.route) } : { state: "unknown", route: null };
    const frozen = isObj(raw.frozen) && typeof raw.frozen.kind === "string" ? { kind: raw.frozen.kind === "review" ? "review" : "snapshot", available: raw.frozen.available === true, scope: raw.frozen.scope === "live" ? "live" : "snapshot" } : null;
    return {
      source_id: sid, reason: "", captured: cleanCaptured(raw.captured),
      current: { state: raw.current.state, metadata: cleanMeta(raw.current.metadata), file },
      differs: (Array.isArray(raw.differs) ? raw.differs : []).filter((k) => FIELDS.indexOf(k) >= 0), integrity: integ, frozen,
    };
  }

  /** Maps ONE resolver response onto the entries sent in that body (the server answers in request order; a length or identity mismatch is "unknown"). */
  function resultsFor(entries, res) {
    const list = isObj(res) && Array.isArray(res.results) ? res.results : [];
    return entries.map((entry, i) => sanitizeResult(list.length === entries.length ? list[i] : null, entry));
  }


  /**
   * When the resolver cannot be reached, the citation AS STORED is still shown (captured side only); the current side is "unknown",
   * never "missing". Mirrors the server's captured shape for a citation.
   */
  function offlineResult(spec) {
    const e = entryFor(spec);
    const sid = e ? e.source_id : "";
    const out = unknownResult(sid, MSG.failed);
    const c = isObj(spec) && isObj(spec.citation) ? spec.citation : null;
    if (c && isObj(c.snap) && typeof c.snap.title === "string") {
      const meta = { title: clip(c.snap.title) };
      if (typeof c.snap.author === "string") meta.author = clip(c.snap.author);
      if (typeof c.snap.edition === "string") meta.edition = clip(c.snap.edition);
      if (Number.isInteger(c.snap.year)) meta.year = c.snap.year;
      if (typeof c.snap.ident === "string") meta.identifier = clip(c.snap.ident);
      const o = isObj(c.from) && typeof c.from.src === "string" ? c.from : null;
      out.captured = {
        kind: "citation", metadata: meta, missing: false, locator: cleanLocator(c.loc), pdf: pageOk(c.pdf), location_verified: c.ok === true,
        provenance: o ? { source_id: clip(o.src), locator: cleanLocator(o.loc), pdf: pageOk(o.pdf), location_verified: o.ok === true } : null,
      };
    }
    return out;
  }

  // ------------------------------------------------------------------ 3. card

  function metaValue(field, v) {
    if (v === undefined || v === null || v === "") return "—";
    if (field === "type") return TYPE_LABEL[v] || String(v);
    return String(v);
  }

  function locatorText(loc) {
    return loc ? (LOC_LABEL[loc.kind] || "") + " " + loc.text : "";
  }

  function sourceStatus(state) {
    return state === "available" ? { key: "available", text: MSG.srcAvailable }
      : state === "archived" ? { key: "archived", text: MSG.srcArchived }
        : state === "missing" ? { key: "missing", text: MSG.srcMissing }
          : { key: "unknown", text: MSG.srcUnknown };
  }

  function fileStatus(state) {
    return state === "ok" ? { key: "ok", text: MSG.fileOk }
      : state === "missing" ? { key: "missing", text: MSG.fileMissing }
        : state === "none" ? { key: "none", text: MSG.fileNone }
          : { key: "unknown", text: MSG.fileUnknown };
  }

  function integrityBanner(result) {
    const f = result.frozen;
    if (!f) return null;
    if (!f.available) return { key: "unavailable", text: MSG.frozenUnavailable };
    switch (result.integrity.state) {
      case "matches_seal": return { key: "matches", text: MSG.sealMatches };
      case "differs_from_seal": return { key: "differs", text: MSG.sealDiffers };
      case "sealed_file_missing": return { key: "sealed_missing", text: MSG.sealMissing };
      case "unknown": return { key: "unknown", text: MSG.sealUnknown };
      default: return f.scope === "live" ? { key: "live", text: MSG.liveScope } : { key: "none", text: MSG.sealNone };
    }
  }

  /**
   * View model of one evidence card. The captured side and the current side are NEVER merged: the table has one column each and the
   * "differs" flag comes from the server. ``cap`` is the citation (or the frozen metadata) as it was written down then.
   */
  function cardModel(result) {
    const cap = result.captured && result.captured.citation ? result.captured.citation : result.captured;
    const frozenCap = result.captured && result.captured.kind !== "citation" ? result.captured : null;
    const base = frozenCap || cap;
    const curMeta = result.current.metadata;
    const capMeta = base ? base.metadata : null;
    const title = (capMeta && capMeta.title) || (curMeta && curMeta.title) || result.source_id;
    const rows = [];
    for (const f of FIELDS) {
      const c = capMeta ? capMeta[f] : undefined;
      const n = curMeta ? curMeta[f] : undefined;
      if ((c === undefined || c === null) && (n === undefined || n === null)) continue;
      rows.push({ field: f, label: FIELD_LABEL[f], captured: capMeta ? metaValue(f, c) : "", current: curMeta ? metaValue(f, n) : "", differs: result.differs.indexOf(f) >= 0 });
    }
    const lines = [];
    if (cap && cap.kind === "citation") {
      lines.push({ key: "locator", label: MSG.locator, text: cap.locator ? locatorText(cap.locator) : MSG.noLocator, announce: cap.locator ? MSG.locator + " : " + locatorText(cap.locator) : MSG.noLocator });
      lines.push({ key: "pdf", label: MSG.pdfPage, text: cap.pdf ? String(cap.pdf) : MSG.noPdfPage, announce: cap.pdf ? MSG.pdfPage + " " + cap.pdf : MSG.noPdfPage });
    }
    const verified = cap && typeof cap.location_verified === "boolean" ? { ok: cap.location_verified, text: cap.location_verified ? MSG.locationOk : MSG.locationNo, note: cap.location_verified ? MSG.locationOkNote : "" } : null;
    const prov = cap && cap.provenance ? cap.provenance : null;
    return {
      sourceId: result.source_id, title, capturedHeading: frozenCap ? MSG.capturedFrozen : MSG.captured, currentHeading: MSG.current,
      hasCaptured: !!base, rows, lines, verified,
      provenance: prov ? { heading: MSG.migrated, text: (prov.locator ? locatorText(prov.locator) : "sans emplacement") + (prov.pdf ? ", " + MSG.pdfPage + " " + prov.pdf : "") + (prov.location_verified ? " — " + MSG.locationOk : "") } : null,
      source: sourceStatus(result.current.state), file: fileStatus(result.current.file.state), banner: integrityBanner(result),
      frozen: !!result.frozen, reason: result.reason || "",
    };
  }

  // ------------------------------------------------------------------ 4. viewer

  /**
   * Which PDF may be shown, and how it must be labelled. ``page`` is ONLY the PDF page stored with the citation (never the locator).
   *   mode "auto"      the viewer loads on its own (no frozen context, a live-scope item, or a sealed hash that matches the current bytes)
   *   mode "explicit"  nothing loads until the person chooses ``action``; the viewer is then labelled with ``label`` (never unlabelled)
   *   mode "none"      no PDF can be shown (missing / unavailable / sealed bytes gone)
   */
  function viewerPlan(result) {
    const page = result.captured && (result.captured.citation ? result.captured.citation.pdf : result.captured.pdf) || null;
    const none = (why) => ({ mode: "none", route: null, page, label: null, action: null, why });
    const cur = result.current.file;
    if (!result.frozen) {
      if (cur.state === "ok" && cur.route) return { mode: "auto", route: cur.route, page, label: null, action: null, why: "" };
      return none(fileStatus(cur.state).text);
    }
    if (!result.frozen.available) return none(MSG.frozenUnavailable);
    const ig = result.integrity;
    if (ig.state === "matches_seal" && ig.route) return { mode: "auto", route: ig.route, page, label: null, action: null, why: "" };
    if (ig.state === "differs_from_seal" && ig.route) return { mode: "explicit", route: ig.route, page, label: MSG.viewerDifferent, action: MSG.openCurrentDifferent, why: MSG.sealDiffers };
    if (ig.state === "sealed_file_missing") return none(MSG.sealMissing);
    if (ig.state === "unknown") {
      return cur.state === "ok" && cur.route ? { mode: "explicit", route: cur.route, page, label: MSG.viewerUnknown, action: MSG.openCurrentUnknown, why: MSG.sealUnknown } : none(MSG.sealUnknown);
    }
    // not_applicable
    if (result.frozen.scope === "live") return cur.state === "ok" && cur.route ? { mode: "auto", route: cur.route, page, label: null, action: null, why: "" } : none(fileStatus(cur.state).text);
    return cur.state === "ok" && cur.route ? { mode: "explicit", route: cur.route, page, label: MSG.viewerUnsealed, action: MSG.openCurrentUnsealed, why: MSG.sealNone } : none(MSG.sealNone);
  }

  /** ``/files/...#page=N`` for a plan route. ``page`` is a PDF page index only; null leaves the document at its start. */
  function viewerUrl(route, page) {
    const r = cleanRoute(route);
    if (!r) return null;
    const p = pageOk(page);
    return p ? r + "#page=" + p : r;
  }

  /** Page navigation inside the viewer: always a PDF page index within 1..PAGE_MAX. */
  function stepPage(page, delta) {
    const p = pageOk(page) || 1;
    return Math.min(PAGE_MAX, Math.max(1, p + delta));
  }

  return {
    ENTRIES_MAX, PAGE_MAX, MSG, FIELDS, LOC_LABEL, SOURCE_STATES, FILE_STATES, INTEGRITY,
    entryFor, entryKey, uniqueEntries, batchBodies, unknownResult, offlineResult, sanitizeResult, resultsFor, cardModel, viewerPlan, viewerUrl, isVerifiedRoute, verifiedRefusal, refusalCode, stepPage, locatorText,
  };
});
