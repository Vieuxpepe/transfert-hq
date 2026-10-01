/* Transfert HQ — Carnet editor commands: ONE registry shared by "+ Insérer", the "/" menu, the between-block "+" and the block menu.
 *
 * Pure and DOM-free (Node-testable). It owns: the command list (ids, labels, keywords, kinds), filtering/ranking, the eligibility of
 * the "/" trigger, and the safe whole-block line transforms (insert / move / duplicate / delete / convert). It never touches the
 * DOM, the network or storage: the host applies a result through its normal edit path (draft + autosave + revision checks).
 *
 * Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetCommands = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TEXT_TYPES = ["paragraph", "heading", "bullet", "number", "check"];
  const IMAGES_MAX = 32; // mirrors Rich.IMAGES_PER_PAGE_MAX (the host's value wins when present)
  const DECISIONS_MAX = 100; // mirrors Rich.Eng.DECISIONS_PER_PAGE_MAX

  /** kind: "block" (re-types the current text block), "tool" (opens an existing tool), "format" (cite/time). */
  const COMMANDS = [
    { id: "paragraph", kind: "block", type: "paragraph", label: "Texte", hint: "Paragraphe simple", keys: ["texte", "paragraphe", "text", "p"] },
    { id: "heading", kind: "block", type: "heading", label: "Titre", hint: "Titre de section", keys: ["titre", "heading", "h1", "h2", "section"] },
    { id: "bullet", kind: "block", type: "bullet", label: "Liste à puces", hint: "Une puce par ligne", keys: ["liste", "puces", "puce", "bullet", "ul"] },
    { id: "number", kind: "block", type: "number", label: "Liste numérotée", hint: "1. 2. 3.", keys: ["liste", "numero", "numérotée", "numbered", "ol"] },
    { id: "check", kind: "block", type: "check", label: "Cases à cocher", hint: "Liste de tâches", keys: ["cases", "cocher", "tache", "tâche", "todo", "check"] },
    { id: "image", kind: "tool", label: "Image", hint: "Photos et fichiers de cet appareil", keys: ["image", "photo", "picture", "img"] },
    { id: "camera", kind: "tool", label: "Appareil photo", hint: "Prendre une photo", keys: ["camera", "caméra", "appareil", "photo"] },
    { id: "file", kind: "tool", label: "Fichier", hint: "Lien vers un fichier du carnet (sélectionner du texte)", keys: ["fichier", "file", "lien", "piece"] },
    { id: "drawing", kind: "tool", label: "Dessin", hint: "Lien vers un dessin (sélectionner du texte)", keys: ["dessin", "drawing", "croquis", "plan"] },
    { id: "measure", kind: "tool", label: "Mesure", hint: "Valeur mesurée et tolérance", keys: ["mesure", "measure", "cote", "tolerance", "tolérance"] },
    { id: "calc", kind: "tool", label: "Calcul", hint: "Expression avec résultat", keys: ["calcul", "calc", "formule", "math"] },
    { id: "decision", kind: "tool", label: "Décision", hint: "Marquer la ligne comme décision", keys: ["decision", "décision", "choix"] },
    { id: "cite", kind: "format", label: "Référence", hint: "Citer une source de la bibliothèque", keys: ["reference", "référence", "citation", "source", "cite"] },
    { id: "time", kind: "format", label: "Heure", hint: "Insérer l'heure actuelle", keys: ["heure", "time", "date", "horodatage"] },
  ];

  /** The items "+ Insérer" shows (everything except the slash-only text conversions and format shortcuts stays in one order). */
  const INSERT_IDS = ["image", "camera", "file", "drawing", "measure", "calc", "decision"];

  function byId(id) {
    return COMMANDS.find((c) => c.id === id) || null;
  }

  function insertItems() {
    return INSERT_IDS.map(byId);
  }

  function fold(s) {
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  }

  /** Rank: 0 label prefix, 1 keyword prefix, 2 label substring, 3 keyword substring; others excluded. Stable. */
  function filter(query, list) {
    const items = list || COMMANDS;
    const q = fold(query);
    if (!q) return items.slice();
    const scored = [];
    items.forEach((c, i) => {
      const label = fold(c.label);
      let rank = -1;
      if (label.indexOf(q) === 0) rank = 0;
      else if (c.keys.some((k) => fold(k).indexOf(q) === 0)) rank = 1;
      else if (label.indexOf(q) > 0) rank = 2;
      else if (c.keys.some((k) => fold(k).indexOf(q) > 0)) rank = 3;
      if (rank >= 0) scored.push({ c, rank, i });
    });
    scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
    return scored.map((s) => s.c);
  }

  function isTextType(type) {
    return TEXT_TYPES.indexOf(type) >= 0;
  }

  /**
   * May a typed "/" open the menu? Only at the start of an empty line or right after whitespace, in a text-like block, never while
   * an IME composition is running, never with a range selection, and never inside an atom.
   */
  function slashEligible(line, offset, opts) {
    const o = opts || {};
    if (o.composing || o.readOnly || o.rangeSelection) return false;
    if (!line || !isTextType(line.type)) return false;
    const text = String(line.text || "");
    if (!(offset >= 0 && offset <= text.length)) return false;
    if (offset === 0) return true;
    return /\s/.test(text.charAt(offset - 1));
  }

  /**
   * The block that wears the (purely visual) page-title treatment: the SAME first non-empty text line derive_title() picks,
   * but only when it is prose (paragraph / heading) — a list item, a decision or an atom is never styled as the title.
   * Atoms carry no text, so they are skipped exactly as derive_title skips them. An entirely empty page offers the
   * treatment to its first block when that is a paragraph (the empty-state affordance). Never persisted.
   */
  function titleIndex(lines) {
    if (!lines || !lines.length) return -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (String(lines[i].text || "").trim()) return lines[i].type === "paragraph" || lines[i].type === "heading" ? i : -1;
    }
    return lines[0].type === "paragraph" ? 0 : -1;
  }

  function counts(lines) {
    let images = 0;
    let decisions = 0;
    for (const l of lines) {
      if (l.type === "image") images += 1;
      else if (l.type === "decision") decisions += 1;
    }
    return { images, decisions };
  }

  // ---- whole-block transforms: each returns { lines, index } (a NEW array; inputs untouched) or { error } and never mutates its input

  function ctx(Rich, lines, index) {
    return Rich && Array.isArray(lines) && index >= 0 && index < lines.length;
  }

  function insertEmpty(Rich, lines, index, where) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    if (lines.length >= Rich.BLOCKS_MAX) return { error: "limit-blocks" };
    const out = Rich.cloneLines(lines);
    const at = where === "above" ? index : index + 1;
    out.splice(at, 0, Rich.newLine("", "paragraph"));
    return { lines: out, index: at };
  }

  function move(Rich, lines, index, dir) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    const to = index + (dir < 0 ? -1 : 1);
    if (to < 0 || to >= lines.length) return { error: "edge" };
    const out = Rich.cloneLines(lines);
    const m = out.splice(index, 1)[0];
    out.splice(to, 0, m);
    return { lines: out, index: to };
  }

  /** Move a block to a final index (drag): same ids, same content, only the order changes. */
  function moveTo(Rich, lines, index, to) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    const dest = Math.max(0, Math.min(lines.length - 1, to));
    if (dest === index) return { error: "edge" };
    const out = Rich.cloneLines(lines);
    const m = out.splice(index, 1)[0];
    out.splice(dest, 0, m);
    return { lines: out, index: dest };
  }

  /** Duplicate with a NEW identity (id null: the host gives a temporary key, the server the real id); caps are respected. */
  function duplicate(Rich, lines, index) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    if (lines.length >= Rich.BLOCKS_MAX) return { error: "limit-blocks" };
    const src = lines[index];
    const c = counts(lines);
    const imax = Rich.IMAGES_PER_PAGE_MAX || IMAGES_MAX;
    const dmax = (Rich.Eng && Rich.Eng.DECISIONS_PER_PAGE_MAX) || DECISIONS_MAX;
    if (src.type === "image" && c.images >= imax) return { error: "limit-images" };
    if (src.type === "decision" && c.decisions >= dmax) return { error: "limit-decisions" };
    const out = Rich.cloneLines(lines);
    const copy = Rich.cloneLines([src])[0];
    copy.id = null;
    out.splice(index + 1, 0, copy);
    return { lines: out, index: index + 1 };
  }

  /** Delete one block; a page never ends up with zero blocks (the last block becomes an empty paragraph). */
  function remove(Rich, lines, index) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    const out = Rich.cloneLines(lines);
    out.splice(index, 1);
    if (!out.length) out.push(Rich.newLine("", "paragraph"));
    return { lines: out, index: Math.min(index, out.length - 1) };
  }

  /** Convert among text block types only; atoms, images and decisions are never re-typed. */
  function convert(Rich, lines, index, type) {
    if (!ctx(Rich, lines, index)) return { error: "invalid" };
    if (!isTextType(type) || !isTextType(lines[index].type)) return { error: "not-text" };
    const out = Rich.cloneLines(lines);
    out[index].type = type;
    out[index].checked = type === "check" ? out[index].checked : false;
    return { lines: out, index };
  }

  return {
    COMMANDS, TEXT_TYPES, IMAGES_MAX, DECISIONS_MAX, byId, insertItems, filter, fold, isTextType, slashEligible, titleIndex, counts,
    insertEmpty, move, moveTo, duplicate, remove, convert,
  };
});
