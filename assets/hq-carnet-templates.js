/* Transfert HQ — Carnet page templates (product phase 1).
 *
 * A template is a DECLARATIVE composition of EXISTING canonical block types (paragraph / heading / bullet / number / check).
 * It owns no persisted type, no schema and no storage: choosing one builds ordinary lines that the host sends through the normal
 * page-creation action (the page is born with that content, atomically), after which it is an ordinary page.
 *
 * Authoring rules (tested):
 *   - only canonical text blocks: never an image / calculation / measurement / decision atom (those carry data the author must supply);
 *   - nothing is pre-written but structure: headings and EMPTY fill-in lines. No measurement, no verdict, no conclusion;
 *   - the only substitutions are {date} and {time} (device local clock) in headings;
 *   - ids are never generated here: every line leaves with id = null and the server assigns fresh, unique `block-…` ids.
 *
 * Pure and DOM-free (Node-testable). Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetTemplates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TEXT_TYPES = ["paragraph", "heading", "bullet", "number", "check"];
  const LINE_MAX = 200; // a template line is a short heading, never prose
  const PLACEHOLDER = /\{([a-z]+)\}/g;
  const KNOWN = { date: true, time: true };

  // [type, text] rows. Short codes keep each template readable as a plain outline.
  const H = "heading";
  const P = "paragraph";
  const B = "bullet";
  const N = "number";
  const C = "check";

  const TEMPLATES = [
    {
      id: "blank", label: "Note vide", hint: "Une page vierge",
      icon: "M7 3h7l5 5v13H7zM14 3v5h5",
      blocks: [[P, ""]],
    },
    {
      id: "journal", label: "Journal d'ingénierie", hint: "Contexte, travail, observations, suite",
      icon: "M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6zM6 3.5v17M9.5 8h5.5M9.5 11.5h5.5",
      blocks: [[H, "Journal d'ingénierie — {date}"], [H, "Contexte"], [P, ""], [H, "Travail effectué"], [B, ""], [H, "Observations"], [B, ""], [H, "Problèmes et risques"], [B, ""], [H, "Prochaines étapes"], [C, ""]],
    },
    {
      id: "inspection", label: "Inspection", hint: "Objet, conditions, mesures, photos",
      icon: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l5 5",
      blocks: [[H, "Inspection — {date}"], [H, "Objet"], [P, ""], [H, "Conditions"], [P, ""], [H, "Mesures"], [P, ""], [H, "Photos"], [P, ""], [H, "Observations"], [B, ""], [H, "Décision"], [P, ""]],
    },
    {
      id: "test", label: "Test / expérience", hint: "Objectif, procédure, résultats",
      icon: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9",
      blocks: [[H, "Test — {date}"], [H, "Objectif"], [P, ""], [H, "Hypothèse"], [P, ""], [H, "Montage et conditions"], [B, ""], [H, "Procédure"], [N, ""], [H, "Résultats"], [P, ""], [H, "Conclusion"], [P, ""]],
    },
    {
      id: "meeting", label: "Réunion", hint: "Participants, notes, décisions, actions",
      icon: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M18 14.5A6 6 0 0 1 21 20",
      blocks: [[H, "Réunion — {date}"], [H, "Participants"], [B, ""], [H, "Ordre du jour"], [N, ""], [H, "Notes"], [P, ""], [H, "Décisions"], [B, ""], [H, "Actions"], [C, ""]],
    },
    {
      id: "decision", label: "Registre de décision", hint: "Contexte, options, décision, suivi",
      icon: "M12 3v6M12 9l-6 6M12 9l6 6M6 15v6M18 15v6",
      blocks: [[H, "Décision — {date}"], [H, "Contexte"], [P, ""], [H, "Options considérées"], [B, ""], [H, "Critères"], [B, ""], [H, "Décision"], [P, ""], [H, "Justification"], [P, ""], [H, "Responsable et échéance"], [P, ""], [H, "Suivi"], [C, ""]],
    },
    {
      id: "project", label: "Journal de projet", hint: "Avancement, jalons, risques",
      icon: "M4 4h6v16H4zM14 4h6v10h-6z",
      blocks: [[H, "Journal de projet — {date}"], [H, "Avancement"], [P, ""], [H, "Jalons"], [C, ""], [H, "Risques"], [B, ""], [H, "Blocages"], [B, ""], [H, "Prochaines étapes"], [C, ""]],
    },
  ];

  function list() {
    return TEMPLATES.slice();
  }

  function byId(id) {
    return TEMPLATES.find((t) => t.id === id) || null;
  }

  function two(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** Local calendar date as YYYY-MM-DD (unambiguous, sortable, no locale surprises). */
  function dateStamp(now) {
    const d = now instanceof Date ? now : new Date();
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
  }

  function timeStamp(now) {
    const d = now instanceof Date ? now : new Date();
    return two(d.getHours()) + ":" + two(d.getMinutes());
  }

  /** Substitute {date} / {time}. Unknown placeholders are left as typed (the tests forbid them in the catalogue). */
  function fill(text, now) {
    return String(text).replace(PLACEHOLDER, (m, k) => (k === "date" ? dateStamp(now) : k === "time" ? timeStamp(now) : m));
  }

  /** Plain rows [{type, text}] for a template id, or null for an unknown id. */
  function expand(id, now) {
    const t = byId(id);
    return t ? t.blocks.map(([type, text]) => ({ type, text: fill(text, now) })) : null;
  }

  /**
   * Declarative check of one template definition (used by the tests AND before every build): canonical text types only, single-line,
   * bounded, known placeholders, at least one block, and the first line is the page title (a heading, or the only empty paragraph).
   */
  function problems(t, blocksMax) {
    const out = [];
    if (!t || typeof t.id !== "string" || !t.id) return ["no id"];
    if (!Array.isArray(t.blocks) || !t.blocks.length) out.push("no blocks");
    const max = blocksMax || 8192;
    if (Array.isArray(t.blocks) && t.blocks.length > max) out.push("too many blocks");
    for (const [i, row] of (Array.isArray(t.blocks) ? t.blocks : []).entries()) {
      if (!Array.isArray(row) || row.length !== 2) {
        out.push("row " + i + " is not [type, text]");
        continue;
      }
      const [type, text] = row;
      if (TEXT_TYPES.indexOf(type) < 0) out.push("row " + i + ": non-canonical type " + type);
      if (typeof text !== "string" || text.indexOf("\n") >= 0 || text.length > LINE_MAX) out.push("row " + i + ": bad text");
      else {
        let m;
        PLACEHOLDER.lastIndex = 0;
        while ((m = PLACEHOLDER.exec(text))) if (!KNOWN[m[1]]) out.push("row " + i + ": unknown placeholder " + m[0]);
      }
    }
    return out;
  }

  /**
   * Lines for the host. `Rich` supplies newLine / BLOCKS_MAX. Atomic: returns {lines} or {error} and never a partial result;
   * every line has id = null (the server assigns the real, unique ids).
   */
  function build(Rich, id, now) {
    const t = byId(id);
    if (!t) return { error: "unknown" };
    const bad = problems(t, Rich && Rich.BLOCKS_MAX);
    if (bad.length) return { error: "invalid", details: bad };
    const rows = expand(id, now);
    const lines = rows.map((r) => Rich.newLine(r.text, r.type, false, [], null));
    return { lines, template: t };
  }

  return { TEMPLATES, TEXT_TYPES, LINE_MAX, list, byId, dateStamp, timeStamp, fill, expand, problems, build };
});
