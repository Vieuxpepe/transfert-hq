/* Transfert HQ — Carnet Phase 5: Engineering Intelligence — PURE view models (no DOM, no network, no storage, no clock).
 *
 * The server derives everything (cockpit, decision trail, measurement series, diff, snapshots) from canonical Carnet data. This file
 * only turns those responses into what the browser shows, deterministically, so the whole contract is checked in Node
 * (tests/check_hq_carnet_intel.mjs):
 *
 *   1. filters      filterDecisions / filterSeries            client-side, never a request, never a mutation
 *   2. series       bandOf / chartModel / tableRows           coordinates for an SVG + the accessible table that carries the SAME facts
 *   3. cockpit      cockpitModel                              counts with the tab that explains each of them; unavailable things say so
 *   4. diff         diffModel / overlayOf / changeLabel       text labels for every state (never colour alone)
 *   5. snapshots    snapshotRows / verifyModel                integrity wording that never overclaims
 *   6. report       reportItem                                the wire shape of a project-overview report item
 *
 * Nothing is inferred: no status, author, rationale or conclusion exists here. No unit is ever converted.
 * Plain ES2020, UMD (browser global HqCarnetIntel / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetIntel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PAGE_RE = /^page-[A-Za-z0-9_-]{1,64}$/;
  const BLOCK_RE = /^block-[A-Za-z0-9_-]{1,64}$/;
  const PROJ_RE = /^proj-[A-Za-z0-9_-]{1,64}$/;
  const SNAP_RE = /^snap-[0-9a-f]{24}$/;
  const EVENT_RE = /^hev-[0-9a-f]{24}$/;
  const NUM_RE = /^-?\d+(\.\d+)?$/;
  const LABEL_MAX = 80;
  const NOTE_MAX = 400;

  const VERDICT_LABEL = { in: "Dans la tolérance", out: "Hors tolérance", none: "Sans tolérance", incompatible: "Unités incompatibles" };
  const VERDICT_MARK = { in: "●", out: "◆", none: "○", incompatible: "▲" }; // distinct shapes: a verdict is never colour alone
  const VERDICTS = ["in", "out", "none", "incompatible"];
  const STATE_LABEL = { ok: "Disponible", missing: "Introuvable", unknown: "État inconnu" };
  const INTEGRITY_LABEL = { ok: "Intègre", corrupt: "Altéré", invalid: "Invalide" };
  const VERIFY_LABEL = {
    unchanged: "Inchangé depuis le jalon",
    modified: "Modifié depuis le jalon",
    missing: "Introuvable (existait au jalon)",
    still_missing: "Déjà introuvable au jalon",
    appeared: "Présent maintenant (absent au jalon)",
  };
  const TAG_LABEL = {
    text: "Texte modifié", checked: "Case cochée ou décochée", type: "Type de bloc changé", format: "Mise en forme modifiée", ref: "Lien modifié",
    source: "Source ou citation modifiée", provenance: "Provenance modifiée", decision: "Décision modifiée", measure: "Mesure modifiée", calc: "Calcul modifié",
    drawing_version: "Version du croquis changée", image: "Image modifiée", image_group: "Groupe d'images modifié", voice: "Note vocale modifiée",
    table: "Tableau modifié", callout: "Encadré modifié", toggle: "Bloc repliable modifié", other: "Modifié",
  };
  const FIELD_LABEL = { label: "libellé", value: "valeur", nominal: "cote nominale", tolerance: "tolérance", link: "lien", date: "date" };
  const STATE_WORD = { added: "Ajouté", changed: "Modifié", removed: "Supprimé" };
  const PAGE_STATUS = { changed: "Modifiée", added: "Ajoutée au projet", removed: "Absente maintenant", unchanged: "Inchangée" };
  const REMOVED_REASON = { trashed: "à la corbeille", moved: "déplacée hors du projet", deleted: "supprimée", absent: "absente du jalon comparé" };
  const KIND_LABEL = { note: "Note", file: "Fichier", drawing: "Croquis", model: "Modèle", media: "Média", source: "Source", project: "Projet" };

  // ------------------------------------------------------------------ helpers

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /** NFC, trimmed, inner whitespace collapsed, case-folded: the series identity of a label (mirrors the server). */
  function normLabel(s) {
    return String(s == null ? "" : s).normalize("NFC").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  }

  function num(v) {
    if (typeof v !== "string" || !NUM_RE.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  const pad = (n) => (n < 10 ? "0" : "") + n;

  /** Timezone-free "YYYY-MM-DD HH:MM" (UTC) of epoch seconds: the same text on every device and in every test. */
  function fmtDate(sec) {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }

  /** "YYYY-MM-DD" (UTC day) -> epoch seconds at its start, or null. */
  function dayStart(text) {
    if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const t = Date.parse(text + "T00:00:00Z");
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  function inRange(at, from, to) {
    const a = dayStart(from);
    const b = dayStart(to);
    if (a !== null && at < a) return false;
    if (b !== null && at >= b + 86400) return false;
    return true;
  }

  /** {pageId, blockId|null} for a navigation target; null when an id is not canonical (nothing navigates). */
  function target(pageId, blockId) {
    if (typeof pageId !== "string" || !PAGE_RE.test(pageId)) return null;
    if (blockId == null) return { pageId, blockId: null };
    if (typeof blockId !== "string" || !BLOCK_RE.test(blockId)) return null;
    return { pageId, blockId };
  }

  // ------------------------------------------------------------------ 1. filters (client-side only)

  /** f: {query, page, from, to, evidence}. Order is preserved; the input is never mutated. */
  function filterDecisions(list, f) {
    f = f || {};
    const q = normLabel(f.query || "");
    return (Array.isArray(list) ? list : []).filter((d) => {
      if (!isObj(d)) return false;
      if (f.page && d.page_id !== f.page) return false;
      if (f.evidence && !(Array.isArray(d.evidence) && d.evidence.length)) return false;
      if (!inRange(d.at, f.from, f.to)) return false;
      if (q && normLabel(d.text + " " + d.page_title).indexOf(q) < 0) return false;
      return true;
    });
  }

  /** "in" if every present bound is the same exact pair, "none" without any bound, else "variable" (never a guessed band). */
  function bandOf(points) {
    const pts = Array.isArray(points) ? points : [];
    const bounded = pts.filter((p) => p.lo != null && p.hi != null);
    if (!bounded.length) return { state: "none" };
    const first = bounded[0];
    if (bounded.length === pts.length && bounded.every((p) => p.lo === first.lo && p.hi === first.hi)) return { state: "exact", lo: first.lo, hi: first.hi, unit: first.unit };
    return { state: "variable" };
  }

  /** f: {verdict: "all"|"out"|"in"|"none"|"incompatible", unit, query, from, to}. Series with no remaining point disappear. */
  function filterSeries(series, f) {
    f = f || {};
    const q = normLabel(f.query || "");
    const out = [];
    for (const s of Array.isArray(series) ? series : []) {
      if (!isObj(s) || !Array.isArray(s.points)) continue;
      if (f.unit && s.unit !== f.unit) continue;
      if (q && normLabel(s.label).indexOf(q) < 0) continue;
      const pts = s.points.filter((p) => (!f.verdict || f.verdict === "all" || p.verdict === f.verdict) && inRange(p.at, f.from, f.to));
      if (!pts.length) continue;
      out.push(Object.assign({}, s, { points: pts, band: bandOf(pts), out: pts.filter((p) => p.verdict === "out").length, filtered: pts.length !== s.points.length }));
    }
    return out;
  }

  function unitsOf(series) {
    const set = new Set();
    for (const s of Array.isArray(series) ? series : []) set.add(s.unit);
    return Array.from(set).sort();
  }

  // ------------------------------------------------------------------ 2. series: chart + table

  /**
   * Coordinates for an SVG line chart of ONE series (one unit, never mixed). Only points whose value parses as a finite number are
   * plotted (the table lists every point). The tolerance band is drawn only when the series band is exact.
   * Returns null when nothing can be plotted.
   */
  function chartModel(series, dims) {
    const W = (dims && dims.w) || 320;
    const H = (dims && dims.h) || 160;
    const m = { l: 44, r: 12, t: 12, b: 28 };
    const pts = (series && Array.isArray(series.points) ? series.points : []).map((p, i) => ({ p, i, v: num(p.value) })).filter((x) => x.v !== null);
    if (!pts.length) return null;
    const band = series.band && series.band.state === "exact" ? { lo: num(series.band.lo), hi: num(series.band.hi) } : null;
    const withBand = band && band.lo !== null && band.hi !== null;
    const vals = pts.map((x) => x.v).concat(withBand ? [band.lo, band.hi] : []);
    let lo = Math.min.apply(null, vals);
    let hi = Math.max.apply(null, vals);
    if (hi === lo) {
      lo -= 1;
      hi += 1;
    }
    const pad8 = (hi - lo) * 0.08;
    lo -= pad8;
    hi += pad8;
    const ts = pts.map((x) => x.p.at);
    const t0 = Math.min.apply(null, ts);
    const t1 = Math.max.apply(null, ts);
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const X = (x) => (pts.length === 1 || t1 === t0 ? m.l + (pts.length === 1 ? iw / 2 : (x.i / Math.max(1, pts.length - 1)) * iw) : m.l + ((x.p.at - t0) / (t1 - t0)) * iw);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const round = (n) => Math.round(n * 100) / 100;
    const points = pts.map((x) => ({
      x: round(X(x)), y: round(Y(x.v)), v: x.v, verdict: x.p.verdict, mark: VERDICT_MARK[x.p.verdict] || "○", index: x.i,
      pageId: x.p.page_id, blockId: x.p.block_id, at: x.p.at, text: pointText(series, x.p),
    }));
    const ticks = [lo + pad8, (lo + hi) / 2, hi - pad8].map((v) => ({ y: round(Y(v)), label: String(Math.round(v * 1000) / 1000) }));
    return {
      w: W, h: H, margin: m, points, ticks,
      band: withBand ? { y1: round(Y(band.hi)), y2: round(Y(band.lo)), lo: series.band.lo, hi: series.band.hi } : null,
      path: points.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" "),
      plotted: points.length, total: series.points.length,
    };
  }

  function tolText(p) {
    if (p.mode === "none" || !p.tol) return "sans tolérance";
    if (p.mode === "sym") return "± " + p.tol.t + (p.tol.u ? " " + p.tol.u : "");
    if (p.mode === "pct") return "± " + p.tol.p + " %";
    return p.tol.lo + " à " + p.tol.hi + (p.tol.u ? " " + p.tol.u : "");
  }

  function pointText(series, p) {
    const unit = series.unit ? " " + series.unit : "";
    return fmtDate(p.at) + " — " + p.value + unit + " — " + VERDICT_LABEL[p.verdict];
  }

  /** The accessible table carries EVERY point with its own nominal, tolerance, mode and verdict: nothing exists only in the chart. */
  function tableRows(series) {
    return (series && Array.isArray(series.points) ? series.points : []).map((p) => ({
      date: fmtDate(p.at), value: p.value + (series.unit ? " " + series.unit : ""),
      nominal: p.nominal ? p.nominal.v + (p.nominal.u ? " " + p.nominal.u : "") : "—",
      tolerance: tolText(p), verdict: VERDICT_LABEL[p.verdict] || "", mark: VERDICT_MARK[p.verdict] || "",
      page: p.page_title, pageId: p.page_id, blockId: p.block_id,
    }));
  }

  function bandText(series) {
    const b = series && series.band;
    if (!b || b.state === "none") return "Sans tolérance";
    if (b.state === "variable") return "Tolérance variable";
    return "Tolérance : " + b.lo + " à " + b.hi + (b.unit ? " " + b.unit : "");
  }

  function seriesSummary(series) {
    const total = series.points.length;
    const out = series.points.filter((p) => p.verdict === "out").length;
    const last = series.points[total - 1];
    return (
      series.label + (series.unit ? " (" + series.unit + ")" : "") + " — " + total + " mesure" + (total > 1 ? "s" : "") +
      (out ? ", " + out + " hors tolérance" : "") + (last ? ", dernière : " + last.value + (series.unit ? " " + series.unit : "") + " — " + VERDICT_LABEL[last.verdict] : "") + ". " + bandText(series)
    );
  }

  // ------------------------------------------------------------------ 3. cockpit

  function cockpitModel(r) {
    if (!isObj(r) || !isObj(r.counts)) return null;
    const c = r.counts;
    const tiles = [
      { key: "pages", label: "Notes", value: c.pages, tab: "overview" },
      { key: "decisions", label: "Décisions", value: c.decisions, tab: "decisions" },
      { key: "measurements", label: "Mesures", value: c.measurements, tab: "measures", note: c.out_of_tolerance ? c.out_of_tolerance + " hors tolérance" : "" },
      { key: "images", label: "Images", value: c.images, tab: "overview" },
      { key: "drawings", label: "Croquis", value: c.drawings, tab: "overview" },
      { key: "sources", label: "Sources", value: c.sources, tab: "overview" },
      { key: "files", label: "Fichiers référencés", value: c.files, tab: "overview" },
    ];
    const notes = [];
    if (r.tasks && r.tasks.available === false) notes.push("Tâches non disponibles : aucune association canonique entre une note ou un projet et une tâche.");
    if (r.history_available === false) notes.push("Historique indisponible : les points de restauration ne figurent pas dans l'activité.");
    if (r.snapshots_available === false) notes.push("Jalons indisponibles.");
    const tr = r.truncated || {};
    if (tr.pages) notes.push("Projet très volumineux : seules les " + r.limits.pages_scanned + " premières notes sont analysées.");
    if (tr.decisions) notes.push("Journal des décisions limité aux " + r.limits.decisions + " plus récentes (" + r.decisions_total + " au total).");
    if (tr.series) notes.push("Séries limitées à " + r.limits.series + " (" + r.series_total + " au total).");
    if (tr.points) notes.push("Chaque série est limitée à ses " + r.limits.points_per_series + " mesures les plus récentes.");
    return {
      title: r.project && r.project.name ? r.project.name : "Sans projet", archived: !!(r.project && r.project.archived), tiles, notes,
      empty: !c.pages, outOfTolerance: c.out_of_tolerance || 0, fingerprint: r.fingerprint,
    };
  }

  function refRow(kind, row) {
    const label = kind === "drawing" ? row.stem : kind === "source" ? row.title || row.edition_id : row.path;
    const first = Array.isArray(row.refs) && row.refs[0] ? row.refs[0] : null;
    return {
      kind, label, state: row.state, stateLabel: STATE_LABEL[row.state] || STATE_LABEL.unknown, archived: !!row.archived, count: row.refs_total || 0,
      first: first ? target(first.page_id, first.block_id) : null, firstTitle: first ? first.page_title : "",
      kindLabel: kind === "file" || kind === "model" || kind === "media" ? KIND_LABEL[row.kind] || "Fichier" : KIND_LABEL[kind],
    };
  }

  function refRows(r) {
    const out = [];
    for (const d of r.drawings || []) out.push(refRow("drawing", d));
    for (const s of r.sources || []) out.push(refRow("source", s));
    for (const f of r.files || []) out.push(refRow("file", f));
    return out;
  }

  // ------------------------------------------------------------------ 4. diff

  function changeLabel(change) {
    const tags = Array.isArray(change.tags) ? change.tags : [];
    const parts = tags.map((t) => TAG_LABEL[t] || TAG_LABEL.other);
    if (change.detail && Array.isArray(change.detail.fields) && change.detail.fields.length) parts.push("(" + change.detail.fields.map((f) => FIELD_LABEL[f] || f).join(", ") + ")");
    if (change.detail && change.detail.from_stem) parts.push(change.detail.from_stem + " → " + change.detail.to_stem);
    return parts.join(" · ");
  }

  /** Per-block overlay of ONE page diff: states for the blocks still on the page and the removed blocks that cannot be shown there. */
  function overlayOf(pageDiff) {
    const states = {};
    const ghosts = [];
    if (!isObj(pageDiff) || pageDiff.mode !== "blocks") return { states, ghosts, available: false };
    for (const a of pageDiff.added || []) states[a.id] = { state: "added", label: STATE_WORD.added };
    for (const c of pageDiff.changed || []) states[c.id] = { state: "changed", label: STATE_WORD.changed + " — " + changeLabel(c) };
    for (const g of pageDiff.removed || []) ghosts.push({ id: g.id, type: g.type, summary: g.summary, afterId: g.after_id || null, label: STATE_WORD.removed });
    return { states, ghosts, available: true };
  }

  function pageDiffSummary(d) {
    if (!isObj(d) || !isObj(d.counts)) return "";
    const n = d.counts;
    if (!n.added && !n.removed && !n.changed) return "Aucun changement";
    const parts = [];
    if (n.added) parts.push(n.added + " ajouté" + (n.added > 1 ? "s" : ""));
    if (n.changed) parts.push(n.changed + " modifié" + (n.changed > 1 ? "s" : ""));
    if (n.removed) parts.push(n.removed + " supprimé" + (n.removed > 1 ? "s" : ""));
    return parts.join(", ");
  }

  function sideText(side) {
    if (!isObj(side)) return "";
    if (side.kind === "checkpoint") return "Checkpoint « " + side.label + " » — " + fmtDate(side.at);
    if (side.kind === "snapshot") return "Jalon « " + side.label + " » — " + fmtDate(side.at);
    return "Version actuelle";
  }

  function diffModel(r) {
    if (!isObj(r) || (r.scope !== "page" && r.scope !== "project")) return null;
    const base = sideText(r.base);
    const to = sideText(r.to);
    if (r.scope === "page") {
      return { scope: "page", base, to, note: r.note || "", pages: [{ pageId: r.page_id, title: "", status: pageDiffSummary(r.diff) === "Aucun changement" ? "unchanged" : "changed", summary: pageDiffSummary(r.diff), diff: r.diff }], counts: null };
    }
    return {
      scope: "project", base, to, note: r.note || "", counts: r.counts,
      pages: (r.pages || []).map((p) => ({
        pageId: p.page_id, title: p.title, status: p.status, statusLabel: PAGE_STATUS[p.status] || p.status,
        reason: p.reason ? REMOVED_REASON[p.reason] || "" : "", summary: p.diff ? pageDiffSummary(p.diff) : "", diff: p.diff || null,
      })),
    };
  }

  /** Options for the baseline pickers: explicit ids only. A date NEVER becomes a baseline by itself (see resolvedText). */
  function baselineChoices(r) {
    const cps = (r && Array.isArray(r.checkpoints) ? r.checkpoints : []).filter((x) => EVENT_RE.test(x.id));
    const sn = (r && Array.isArray(r.snapshots) ? r.snapshots : []).filter((x) => SNAP_RE.test(x.id));
    return {
      checkpoints: cps.map((x) => ({ id: x.id, text: (x.label || "Point de restauration") + " — " + fmtDate(x.at) })),
      snapshots: sn.map((x) => ({ id: x.id, text: x.label + " — " + fmtDate(x.at) + (x.integrity && x.integrity !== "ok" ? " (" + INTEGRITY_LABEL[x.integrity] + ")" : ""), integrity: x.integrity || "ok" })),
      latestCheckpoint: cps[0] ? cps[0].id : null,
      latestSnapshot: sn[0] ? sn[0].id : null,
    };
  }

  /** What a date resolved to — shown BEFORE any diff. */
  function resolvedText(r, kind) {
    const x = r && r.resolved ? r.resolved[kind] : null;
    if (!x) return "Aucun " + (kind === "snapshot" ? "jalon" : "checkpoint") + " à cette date ou avant : rien à comparer.";
    return "Baseline disponible la plus proche avant cette date : " + (kind === "snapshot" ? "jalon « " : "checkpoint « ") + x.label + " » — " + fmtDate(x.at) + ".";
  }

  // ------------------------------------------------------------------ 5. snapshots

  function snapshotRows(r) {
    return (r && Array.isArray(r.snapshots) ? r.snapshots : []).map((s) => ({
      id: s.id, label: s.label, note: s.note || "", date: fmtDate(s.created_at), pages: s.pages, integrity: s.integrity || "ok",
      integrityLabel: INTEGRITY_LABEL[s.integrity || "ok"] || INTEGRITY_LABEL.invalid, ok: (s.integrity || "ok") === "ok",
    }));
  }

  function verifyModel(r) {
    if (!isObj(r) || !isObj(r.counts)) return null;
    const rows = [];
    for (const bucket of ["drawings", "assets", "voices", "files", "sources"]) {
      for (const x of (r.refs && r.refs[bucket]) || []) rows.push({ bucket, ref: x.ref, status: x.status, label: VERIFY_LABEL[x.status] || x.status, changed: x.status === "modified" || x.status === "missing" });
    }
    const c = r.counts;
    const drift = c.modified + c.missing;
    return {
      rows, counts: c, drift, integrity: r.integrity, integrityLabel: INTEGRITY_LABEL[r.integrity] || "",
      summary: drift ? drift + " référence(s) ont changé depuis le jalon." : "Toutes les références présentes au jalon sont inchangées.",
    };
  }

  function validSnapshotInput(label, note) {
    const l = String(label == null ? "" : label).trim();
    if (!l) return { ok: false, error: "Donne un nom au jalon." };
    if (l.length > LABEL_MAX) return { ok: false, error: "Nom trop long (" + LABEL_MAX + " caractères au plus)." };
    const n = String(note == null ? "" : note).trim();
    if (n.length > NOTE_MAX) return { ok: false, error: "Note trop longue (" + NOTE_MAX + " caractères au plus)." };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(l + n)) return { ok: false, error: "Caractères invalides." };
    return { ok: true, label: l, note: n };
  }

  const SNAPSHOT_CLAIM =
    "Un jalon fige l'état des notes du projet et enregistre l'empreinte (SHA-256) des fichiers qu'elles référencent. " +
    "Les fichiers ne sont pas copiés : s'ils changent plus tard, le jalon le signale, il ne les restitue pas.";

  // ------------------------------------------------------------------ 6. report

  function reportItem(cockpit) {
    if (!isObj(cockpit)) return null;
    if (isObj(cockpit.snapshot) && cockpit.snapshot.integrity !== "ok") return null; // a broken seal is never offered as trusted frozen state
    if (isObj(cockpit.snapshot) && SNAP_RE.test(cockpit.snapshot.id)) return { kind: "project_overview", snapshot_id: cockpit.snapshot.id, label: "Jalon « " + cockpit.snapshot.label + " »" };
    const pid = cockpit.project && cockpit.project.id ? cockpit.project.id : "none";
    if (pid !== "none" && !PROJ_RE.test(pid)) return null;
    if (typeof cockpit.fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(cockpit.fingerprint)) return null;
    return { kind: "project_overview", project_id: pid, fingerprint: cockpit.fingerprint, label: "Synthèse — " + (cockpit.project && cockpit.project.name ? cockpit.project.name : "Sans projet") };
  }

  return {
    VERDICT_LABEL, VERDICT_MARK, VERDICTS, STATE_LABEL, INTEGRITY_LABEL, VERIFY_LABEL, TAG_LABEL, STATE_WORD, PAGE_STATUS, SNAPSHOT_CLAIM, LABEL_MAX, NOTE_MAX,
    normLabel, num, fmtDate, dayStart, target,
    filterDecisions, filterSeries, bandOf, unitsOf,
    chartModel, tableRows, bandText, seriesSummary, tolText,
    cockpitModel, refRows,
    changeLabel, overlayOf, pageDiffSummary, diffModel, baselineChoices, resolvedText,
    snapshotRows, verifyModel, validSnapshotInput,
    reportItem,
  };
});
