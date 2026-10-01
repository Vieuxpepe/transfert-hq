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

  /**
   * The four menu categories (display order). A command belongs to exactly one.
   * kind: "block" (re-types the current text block), "tool" (opens an existing tool), "format" (cite/time).
   * `hint` is the one-line description; `icon` is a stroke path (24x24, the Carnet icon system); `shortcut` is shown ONLY when
   * a real keyboard shortcut for that exact command exists (none does today: never invent one).
   */
  const CATEGORIES = [
    { id: "write", label: "Écrire", keys: ["ecrire", "écrire", "texte", "write"] },
    { id: "add", label: "Ajouter", keys: ["ajouter", "inserer", "insérer", "add"] },
    { id: "eng", label: "Ingénierie", keys: ["ingenierie", "ingénierie", "engineering", "atelier"] },
    { id: "project", label: "Projet", keys: ["projet", "project"] },
  ];

  const COMMANDS = [
    { id: "paragraph", cat: "write", kind: "block", type: "paragraph", label: "Texte", hint: "Paragraphe", icon: "M5 7h14M5 12h14M5 17h9", keys: ["texte", "paragraphe", "text", "p"] },
    { id: "heading", cat: "write", kind: "block", type: "heading", label: "Titre", hint: "Titre de section", icon: "M6 5v14M18 5v14M6 12h12", keys: ["titre", "heading", "h1", "h2", "section"] },
    { id: "bullet", cat: "write", kind: "block", type: "bullet", label: "Liste", hint: "Une puce par ligne", icon: "M9 7h10M9 12h10M9 17h10M5 7h.01M5 12h.01M5 17h.01", keys: ["liste", "puces", "puce", "bullet", "ul"] },
    { id: "number", cat: "write", kind: "block", type: "number", label: "Liste numérotée", hint: "1. 2. 3.", icon: "M10 7h9M10 12h9M10 17h9M5 6.5l1.2-1V10M4.6 15.2h2.6l-2.6 3h2.6", keys: ["liste", "numero", "numérotée", "numerotee", "numbered", "ol"] },
    { id: "check", cat: "write", kind: "block", type: "check", label: "Checklist", hint: "Cases à cocher", icon: "M4 7l2 2 3.5-3.5M12 7h8M4 16l2 2 3.5-3.5M12 16h8", keys: ["checklist", "cases", "cocher", "todo", "check", "liste de controle"] },
    { id: "image", cat: "add", kind: "tool", label: "Image", hint: "Depuis cet appareil", icon: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01", keys: ["image", "picture", "img", "galerie"] },
    { id: "camera", cat: "add", kind: "tool", label: "Photo", hint: "Prendre une photo", icon: "M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", keys: ["photo", "camera", "caméra", "appareil", "capture"] },
    { id: "table", cat: "add", kind: "tool", label: "Tableau", hint: "Lignes et colonnes de texte", icon: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14", keys: ["tableau", "table", "grille", "colonnes", "lignes"] },
    { id: "callout", cat: "add", kind: "tool", label: "Encadré", hint: "Note, info ou attention", icon: "M5 4h14v12H9l-4 4zM9 8h6M9 12h4", keys: ["encadre", "encadré", "note", "callout", "attention", "avertissement", "info"] },
    { id: "toggle", cat: "add", kind: "tool", label: "Section repliable", hint: "Contenu masquable", icon: "M8 6l8 6-8 6zM4 4v16", keys: ["section", "repliable", "toggle", "details", "détails", "masquer", "accordeon"] },
    { id: "imagegroup", cat: "add", kind: "tool", label: "Groupe d'images", hint: "2 ou 3 images, avant / après", icon: "M3 5h8v14H3zM13 5h8v14h-8zM3 15l3-3 3 3M13 15l3-3 3 3", keys: ["groupe", "images", "avant", "apres", "après", "comparer", "galerie", "cote a cote"] },
    { id: "file", cat: "add", kind: "tool", label: "Fichier", hint: "Lier un fichier", icon: "M7 3h7l5 5v13H7zM14 3v5h5", keys: ["fichier", "file", "lien", "piece"] },
    { id: "drawing", cat: "add", kind: "tool", label: "Dessin", hint: "Lier un dessin", icon: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM4 20h7", keys: ["dessin", "drawing", "croquis", "plan"] },
    { id: "measure", cat: "eng", kind: "tool", label: "Mesure", hint: "Valeur et tolérance", icon: "M3 15L15 3l6 6L9 21zM7 11l2 2M10 8l2 2M13 5l2 2", keys: ["mesure", "measure", "cote", "tolerance", "tolérance", "releve"] },
    { id: "calc", cat: "eng", kind: "tool", label: "Calcul", hint: "Expression et résultat", icon: "M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01", keys: ["calcul", "calc", "formule", "math"] },
    { id: "decision", cat: "eng", kind: "tool", label: "Décision", hint: "Marquer une décision", icon: "M12 3v6M12 9l-6 6M12 9l6 6M6 15v6M18 15v6", keys: ["decision", "décision", "choix"] },
    { id: "task", cat: "project", kind: "tool", label: "Tâche", hint: "Envoyer au tableau de tâches", icon: "M4 4h6v16H4zM14 4h6v10h-6z", keys: ["tache", "tâche", "task", "kanban", "carte", "tableau"] },
    { id: "cite", cat: "project", kind: "format", label: "Référence", hint: "Citer une source", icon: "M7 7h4v4H9a2 2 0 0 0 2 2M15 7h4v4h-2a2 2 0 0 0 2 2", keys: ["reference", "référence", "citation", "source", "cite"] },
    { id: "time", cat: "project", kind: "format", label: "Heure", hint: "Insérer l'heure", icon: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", keys: ["heure", "time", "date", "horodatage"] },
  ];

  const RECENTS_MAX = 4; // stored
  const RECENTS_SHOWN = 3; // shown at the top of the empty-query menu

  function byId(id) {
    return COMMANDS.find((c) => c.id === id) || null;
  }

  function category(id) {
    return CATEGORIES.find((c) => c.id === id) || null;
  }

  function fold(s) {
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  }

  /** In-order (not necessarily adjacent) match of every query character; returns a cost (smaller = tighter) or -1. */
  function subsequence(q, text) {
    if (q.length < 2) return -1;
    let at = 0;
    let last = -1;
    for (const ch of q) {
      const i = text.indexOf(ch, at);
      if (i < 0) return -1;
      last = i;
      at = i + 1;
    }
    return last; // end index of the match: a tight match near the start wins
  }

  /**
   * Score one command for a (folded, non-empty) query. Lower is better; -1 = no match.
   * 0 label prefix · 1 keyword prefix · 2 label substring · 3 keyword/category substring · 4 fuzzy (in-order letters).
   * The 0..3 ranks are the accepted behaviour; 4 is the fuzzy extension (so "chk" finds Checklist, "mesr" finds Mesure).
   */
  function score(q, c) {
    const label = fold(c.label);
    const keys = c.keys.map(fold);
    const cat = category(c.cat);
    if (label.indexOf(q) === 0) return { rank: 0, cost: 0 };
    if (keys.some((k) => k.indexOf(q) === 0)) return { rank: 1, cost: 0 };
    if (label.indexOf(q) > 0) return { rank: 2, cost: label.indexOf(q) };
    if (keys.some((k) => k.indexOf(q) > 0) || (cat && fold(cat.label).indexOf(q) >= 0) || fold(c.hint).indexOf(q) >= 0) return { rank: 3, cost: 0 };
    let best = -1;
    for (const t of [label].concat(keys)) {
      const v = subsequence(q, t);
      if (v >= 0 && (best < 0 || v < best)) best = v;
    }
    return best >= 0 ? { rank: 4, cost: best } : null;
  }

  /** Fuzzy, accent- and case-insensitive ranking. Stable among equals (registry order). Empty query: everything in order. */
  function filter(query, list) {
    const items = list || COMMANDS;
    const q = fold(query);
    if (!q) return items.slice();
    const scored = [];
    items.forEach((c, i) => {
      const sc = score(q, c);
      if (sc) scored.push({ c, rank: sc.rank, cost: sc.cost, i });
    });
    scored.sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.i - b.i);
    return scored.map((s) => s.c);
  }

  /** A clean recents list from untrusted input: known ids only, no duplicates, at most RECENTS_MAX. */
  function sanitizeRecents(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const id of raw) {
      if (typeof id === "string" && byId(id) && out.indexOf(id) < 0) out.push(id);
      if (out.length >= RECENTS_MAX) break;
    }
    return out;
  }

  /** Most recent first; a repeated command moves to the front; never grows past RECENTS_MAX. Pure (returns a new list). */
  function pushRecent(list, id) {
    if (!byId(id)) return sanitizeRecents(list);
    return sanitizeRecents([id].concat(sanitizeRecents(list).filter((x) => x !== id)));
  }

  /**
   * What the menu shows. Empty query: [Récents (if any)] + the four categories in order. A query: ONE flat "Résultats" group in
   * fuzzy order (every item still knows its category). `exclude` hides command ids that cannot apply (e.g. none today).
   */
  function catalog(opts) {
    const o = opts || {};
    const q = fold(o.query);
    const skip = new Set(o.exclude || []);
    const all = COMMANDS.filter((c) => !skip.has(c.id));
    if (q) {
      const hits = filter(o.query, all);
      return hits.length ? [{ id: "results", label: "Résultats", items: hits }] : [];
    }
    const groups = [];
    const recent = sanitizeRecents(o.recents).map(byId).filter((c) => c && !skip.has(c.id)).slice(0, RECENTS_SHOWN);
    if (recent.length) groups.push({ id: "recent", label: "Récents", items: recent });
    for (const cat of CATEGORIES) {
      const items = all.filter((c) => c.cat === cat.id);
      if (items.length) groups.push({ id: cat.id, label: cat.label, items });
    }
    return groups;
  }

  /** Flat command order of a catalog (the keyboard order). */
  function flatten(groups) {
    const out = [];
    for (const g of groups) for (const c of g.items) out.push(c);
    return out;
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
      else if (l.type === "imagegroup" && l.struct) images += l.struct.items.length; // group children are images too
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
    if (src.type === "imagegroup" && src.struct && c.images + src.struct.items.length > imax) return { error: "limit-images" };
    if (src.type === "decision" && c.decisions >= dmax) return { error: "limit-decisions" };
    const out = Rich.cloneLines(lines);
    const copy = Rich.cloneLines([src])[0];
    copy.id = null;
    out.splice(index + 1, 0, copy);
    if (Rich.structLimits && Rich.structLimits(out)) return { error: "limit-struct" }; // tables / notes / groups / structured text caps
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
    COMMANDS, CATEGORIES, RECENTS_MAX, RECENTS_SHOWN, TEXT_TYPES, IMAGES_MAX, DECISIONS_MAX, byId, category, catalog, flatten, score, sanitizeRecents, pushRecent, filter, fold, isTextType, slashEligible, titleIndex, counts,
    insertEmpty, move, moveTo, duplicate, remove, convert,
  };
});
