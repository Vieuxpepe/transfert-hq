/* Transfert HQ — Carnet (Stage 02): paper-first editor, local drafts, autosave, conflicts.
 *
 * One editor/state machine for PC, iPad and iPhone. Plain ES2020, no build step,
 * no external dependency. Note text is only ever written with textContent/value,
 * never parsed as HTML, and never put into URLs, logs, IDs or error messages.
 *
 * Save invariants (docs/carnet-agents/CONTRACTS.md):
 * - every input bumps generation and synchronously writes a per-user, per-page draft;
 * - one in-flight save per page; each save captures generation + exact editable
 *   state + expected rev;
 * - a success clears dirty/draft only when generation AND editable state still
 *   equal what was sent; otherwise the newest state is sent at once on the new rev;
 * - 409 keeps the local editor/draft untouched and pauses autosave for that page;
 * - polling never overwrites a dirty, in-flight or conflicted page.
 *
 * Organization metadata (Stage 03) — server is authoritative:
 * - project_id / category_id are never owned by a local draft. The displayed value is the
 *   newest authoritative server value unless the user made an explicit choice ("intent").
 * - an intent is {value, base}: base = the server value the choice was made against.
 * - every authoritative server page (initial load, save success, 409, clean/dirty refresh,
 *   draft recovery, reload) reconciles intents: satisfied -> dropped; server changed
 *   underneath (base differs, e.g. category deleted elsewhere) -> dropped; target missing
 *   or archived -> dropped. Only surviving intents are ever sent in page_save, so a stale
 *   draft can never resurrect a deleted category/project assignment.
 * - legacy Stage-02 drafts carried project_id/category_id snapshots: they are ignored.
 */
(function (global) {
  "use strict";

  // Stage 04: structured content model (pure) lives in hq-carnet-rich.js, loaded first.
  const Rich = (function () {
    if (global && global.HqCarnetRich) return global.HqCarnetRich;
    if (typeof require === "function") return require("./hq-carnet-rich.js");
    throw new Error("hq-carnet-rich.js manquant");
  })();

  /** Phase 13: a failed request without a server message says WHAT KIND of failure it was (HqCarnetErrors), never the bare word « Erreur ». */
  function typedFallback(err) {
    return global.HqCarnetErrors ? global.HqCarnetErrors.message(err, 160) : "Échec inattendu : rien n'est confirmé.";
  }
  const DRAFT_PREFIX = "hq_carnet_drafts_v1:";
  const DEBOUNCE_MS = 450;
  const POLL_MS = 5000;
  const RETRY_MS = [2000, 5000, 10000, 20000, 30000];
  const SWIPE_MIN = 60;
  const SWIPE_RATIO = 1.4;
  const SWIPE_MAX_MS = 900;
  const KEEPALIVE_MAX = 60000;
  const FLIP_MS = 220;
  const UNTITLED = "Page sans titre";
  const MSG = {
    storage: "Sauvegarde locale indisponible — ne ferme pas cette page.",
    offline: "Hors ligne — conservé sur cet appareil",
    offlineClean: "Hors ligne",
    conflict: "Modifié ailleurs. Ta saisie est conservée sur cet appareil.",
    conflictStatus: "Conflit — choisis une version",
    saved: "Enregistré",
    saving: "Enregistrement…",
    copied: "Copié",
    copyFail: "Copie impossible",
    session: "Session expirée — conservé sur cet appareil",
    orphan: "Page introuvable sur le serveur — ta saisie est conservée sur cet appareil.",
    denied: "Carnet réservé à l'administrateur.",
    attentionOne: "1 autre page à vérifier",
    attentionMany: " autres pages à vérifier",
    failTitle: "Le carnet n'a pas pu s'ouvrir.",
    retry: "Réessayer",
    unfiled: "À classer",
    trashConflict: "Résous d'abord le conflit de cette page.",
    trashPending: "Enregistrement en attente — réessaie dans un instant.",
    trashed: "Page mise à la corbeille.",
    undo: "Annuler",
    trashedBanner: "Dans la corbeille — lecture seule.",
    restore: "Restaurer",
    restored: "Page restaurée",
    deletePermanent: "Supprimer définitivement",
    deleteWord: "SUPPRIMER",
    deleted: "Supprimée définitivement",
    deleteStale: "Cette note a changé depuis ta confirmation — vérifie-la puis confirme à nouveau.",
    trashedDraft: "Brouillon local conservé — page dans la corbeille",
    noPages: "Aucune page",
    noResults: "Aucun résultat",
    linkBad: "Lien non autorisé — adresses http ou https uniquement.",
    linkNeedSel: "Sélectionne d'abord le texte à lier.",
    linkMissing: "Note introuvable.",
    findNone: "Aucun résultat",
    exportStale: "Modifié depuis l'export",
    exportDirty: "Enregistrement en cours — réessaie dans un instant.",
    exportSaved: "Copie enregistrée",
    exportExists: "Un fichier du même nom existe déjà — choisis un autre nom.",
    exportFail: "Copie impossible",
    tooManyLines: "Trop de lignes pour la mise en forme (max 8192) — réduis la page.",
  };
  const IMG_MSG = {
    prep: "Préparation de l'image…",
    up: "Téléversement…",
    stalePage: "La page a changé pendant l'envoi — image non insérée (elle reste stockée dans le carnet).",
    staleAnchor: "L'emplacement a changé pendant l'envoi — image non insérée (elle reste stockée dans le carnet).",
    staleTool: "Cette image a changé ailleurs — vérifie-la puis recommence.",
    busy: "Une image est déjà en cours d'envoi.",
    tooMany: "Trop d'images sur cette page (max 32).",
    unavailable: "Images indisponibles (module non chargé).",
    readonly: "Page en lecture seule.",
    removed: "Image retirée de la page (le fichier reste stocké dans le carnet).",
    inserted: "Image insérée",
    replaced: "Image remplacée",
    confirmRemove: "Confirmer le retrait",
    remove: "Retirer",
  };
  const FORMATS = [
    ["bold", "G", "Gras (Ctrl+B)"],
    ["italic", "I", "Italique (Ctrl+I)"],
    ["underline", "S", "Souligné (Ctrl+U)"],
    ["highlight", "Ab", "Surligné"],
    ["code", "</>", "Monospace"],
    ["heading", "T", "Titre"],
    ["bullet", "•", "Liste à puces"],
    ["number", "1.", "Liste numérotée"],
    ["check", "☐", "Liste de cases à cocher (Ctrl+Entrée coche)"],
    ["link", "🔗", "Lien (Ctrl+K)"],
  ];
  const EXPORT_ROOTS = ["Inbox", "Uni", "Print"];
  const EXPORT_PREFIX = "hq_carnet_exports_v1:";
  const SYMBOLS = ["Ø", "±", "°", "µ", "Δ", "×", "→", "≤", "≥", "²", "³"];
  const ORG = ["project_id", "category_id"];
  const FILTERS = [
    ["all", "Toutes"],
    ["pinned", "Épinglées"],
    ["recent", "Récentes"],
    ["unfiled", "À classer"],
    ["decisions", "Décisions"],
  ];
  const BUCKETS = [
    ["today", "Aujourd'hui"],
    ["yesterday", "Hier"],
    ["week", "Cette semaine"],
    ["older", "Plus ancien"],
  ];
  const PREVIEW_MAX = 160;
  const PAGE_TEXT_BYTES = 48 * 1024; // server contract (hq_carnet.PAGE_TEXT_BYTES)
  const PAGE_FMT_CHARS = 1024 * 1024; // hard bound on a persisted structure string (marks are also count-limited)

  // ------------------------------------------------------------------ pure helpers

  function deriveTitle(text) {
    const lines = String(text || "").split(/\r\n|\r|\n/);
    for (const line of lines) {
      const t = line.trim();
      if (t) return t.slice(0, 120);
    }
    return UNTITLED;
  }

  function nonEmptyLines(text) {
    return String(text || "").split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  }

  /** Mirrors hq_carnet.derive_preview: lines after the title, whitespace collapsed. */
  function derivePreview(text) {
    return nonEmptyLines(text).slice(1).join(" ").split(/\s+/).filter(Boolean).join(" ").slice(0, PREVIEW_MAX);
  }

  function bodyText(text) {
    return nonEmptyLines(text).slice(1).join("\n");
  }

  const FOLD_EXTRA = { "œ": "oe", "æ": "ae", "ß": "ss" };
  /** Lowercase + accent folding ("Ébauche" -> "ebauche"). */
  function fold(s) {
    let t = String(s == null ? "" : s);
    try {
      t = t.normalize("NFD");
    } catch (_) {}
    return t.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[œæß]/g, (c) => FOLD_EXTRA[c]);
  }

  function queryTokens(q) {
    return fold(q).split(/\s+/).filter(Boolean);
  }

  /** 3 = every token in title, 2 = in title/body text, 1 = needs context, -1 = no match. */
  function matchKind(item, toks) {
    const title = fold(item.title);
    const body = fold(item.body);
    const ctx = fold(item.context);
    let inTitle = true;
    let inText = true;
    for (const t of toks) {
      const a = title.includes(t);
      const b = body.includes(t);
      if (!a && !b && !ctx.includes(t)) return -1;
      if (!a) inTitle = false;
      if (!a && !b) inText = false;
    }
    return inTitle ? 3 : inText ? 2 : 1;
  }

  function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /**
   * Deterministic local search. Ranking: title match > pinned > body match > context match,
   * then recency (newer first), then id.
   */
  function searchPages(items, query) {
    const toks = queryTokens(query);
    if (!toks.length) return [];
    const hits = [];
    for (const it of items) {
      const k = matchKind(it, toks);
      if (k > 0) hits.push({ it, k });
    }
    hits.sort((a, b) =>
      (b.k === 3) - (a.k === 3) ||
      (b.it.pinned ? 1 : 0) - (a.it.pinned ? 1 : 0) ||
      (b.k === 2) - (a.k === 2) ||
      (Number(b.it.updated) || 0) - (Number(a.it.updated) || 0) ||
      byId(a.it, b.it));
    return hits.map((h) => h.it);
  }

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Recency bucket of a server timestamp (seconds) in the device's local calendar.
   * Boundaries are local midnights built with calendar setters (DST-safe); the week starts
   * Monday. Every timestamp lands in exactly one bucket (future skew counts as today).
   */
  function recencyBucket(tsSec, nowMs) {
    const t = Number(tsSec) * 1000;
    if (!isFinite(t) || t <= 0) return "older";
    const today = localMidnight(nowMs);
    if (t >= today.getTime()) return "today";
    const yesterday = new Date(today.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    if (t >= yesterday.getTime()) return "yesterday";
    const week = new Date(today.getTime());
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
    week.setHours(0, 0, 0, 0);
    if (t >= week.getTime()) return "week";
    return "older";
  }

  function byRecency(a, b) {
    return (Number(b.updated) || 0) - (Number(a.updated) || 0) || byId(a, b);
  }

  function groupRecents(items, nowMs) {
    const map = new Map(BUCKETS.map(([k]) => [k, []]));
    for (const it of items.slice().sort(byRecency)) map.get(recencyBucket(it.updated, nowMs)).push(it);
    return BUCKETS.filter(([k]) => map.get(k).length).map(([key, label]) => ({ key, label, items: map.get(key) }));
  }

  /**
   * Library selection. sel = {filter: all|pinned|recent|unfiled|trash|project|category, id, query}.
   * Trash is a separate state; every other view lists active pages only.
   */
  function selectPages(items, sel, nowMs) {
    const s = sel || {};
    const f = s.filter || "all";
    let pool = items.filter((it) => (f === "trash" ? it.deleted : !it.deleted));
    if (f === "project") pool = pool.filter((it) => it.project_id === s.id);
    else if (f === "category") pool = pool.filter((it) => it.category_id === s.id);
    else if (f === "pinned") pool = pool.filter((it) => it.pinned);
    else if (f === "unfiled") pool = pool.filter((it) => !it.project_id && !it.category_id);
    else if (f === "decisions") pool = pool.filter((it) => it.hasDecision);
    if (queryTokens(s.query).length) return { searching: true, groups: [{ key: "results", label: "", items: searchPages(pool, s.query) }] };
    if (f === "recent") return { searching: false, groups: groupRecents(pool, nowMs) };
    if (f === "trash") {
      pool.sort((a, b) => (Number(b.deleted_at) || 0) - (Number(a.deleted_at) || 0) || byId(a, b));
    } else {
      pool.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byRecency(a, b));
    }
    return { searching: false, groups: [{ key: f, label: "", items: pool }] };
  }

  function draftKey(user) {
    return DRAFT_PREFIX + encodeURIComponent(String(user == null ? "" : user));
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function timeMarker(date) {
    const d = date || new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " — ";
  }

  function isSwipe(dx, dy) {
    return Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > SWIPE_RATIO * Math.abs(dy);
  }

  /** -1 / +1 for Alt+Left / Alt+Right (no other modifier), else 0. */
  function pageNavDelta(e) {
    if (!e || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0;
    if (e.key === "ArrowLeft") return -1;
    if (e.key === "ArrowRight") return 1;
    return 0;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(str).length;
    return unescape(encodeURIComponent(str)).length;
  }

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function optId(v) {
    return v === null || typeof v === "string" ? v : null;
  }

  /** Lines of a server page (content V1 legacy or V2), or null when unusable. Never throws. */
  function pageLines(page) {
    try {
      return Rich.linesFromContent(page.content);
    } catch (_) {
      return null;
    }
  }

  function pageText(page) {
    try {
      const c = page.content;
      if (c && c.version === 1 && Array.isArray(c.blocks) && c.blocks.length === 1 && typeof c.blocks[0].text === "string") return c.blocks[0].text; // cheap for huge legacy pages
    } catch (_) {}
    const l = pageLines(page);
    return l ? Rich.flat(l) : "";
  }

  /** Canonical structure string of a page (see hq-carnet-rich.js fmtOf); "" = plain paragraphs. */
  function pageFmt(page) {
    try {
      const c = page.content;
      if (c && c.version === 1 && Array.isArray(c.blocks) && c.blocks.length === 1) return ""; // a V1 page is plain by definition
    } catch (_) {}
    const l = pageLines(page);
    return l ? Rich.fmtOf(l) : "";
  }

  /**
   * The ordered vector of real block ids of a page (V1: its single legacy id). Cheap: never builds
   * lines. Two pages have the same block identity only if these vectors are EXACTLY equal.
   */
  function pageIdVector(page) {
    try {
      const c = page.content;
      if (c && Array.isArray(c.blocks)) return c.blocks.map((b) => (b && Rich.isRealId(b.id) ? b.id : null)).filter((x) => x !== null);
    } catch (_) {}
    return [];
  }

  /** Real server block ids of a page (a Set) — the only ids a save may claim. */
  function pageBlockIds(page) {
    const l = pageLines(page);
    return new Set(l ? Rich.idsOf(l).filter((id) => Rich.isRealId(id)) : []);
  }

  /** {text, fmt} of a persisted local draft, or null when its content is unusable. */
  function draftEditable(d) {
    try {
      const l = Rich.linesFromContent(d.content);
      return l ? { text: Rich.flat(l), fmt: Rich.fmtOf(l), ids: Rich.idsOf(l) } : null;
    } catch (_) {
      return null;
    }
  }

  function pageBlockId(page) {
    try {
      const id = page.content.blocks[0].id;
      return typeof id === "string" ? id : null;
    } catch (_) {
      return null;
    }
  }

  function validPage(p) {
    return isObj(p) && typeof p.id === "string" && Number.isInteger(p.rev) && isObj(p.content) && pageLines(p) !== null;
  }

  function validDraft(d) {
    return isObj(d) && Number.isInteger(d.server_rev) && Number.isInteger(d.generation) &&
      Number.isInteger(d.saved_generation) && isObj(d.content) && draftEditable(d) !== null;
  }

  // ------------------------------------------------------------------ local drafts

  /**
   * Per-user draft map. Read-modify-write on every change so two tabs editing
   * different pages do not erase each other's drafts. Any storage exception marks
   * the store failed (persistent warning) until a later write succeeds — memory state
   * keeps the edit. Independently, a page whose latest local state could not be stored
   * stays "memory-only" (warning kept) until that page itself is stored or saved on
   * the server: a successful write of ANOTHER page does not make it safe.
   */
  function createDraftStore(storage, user) {
    const key = draftKey(user);
    let broken = false;
    const memoryOnly = new Set();

    function sameContent(cur, sent) {
      if (!validDraft(cur)) return false;
      const c = draftEditable(cur);
      return c.text === sent.text && c.fmt === sent.fmt && !!cur.pinned === !!sent.pinned;
    }

    function readAll() {
      const raw = storage.getItem(key);
      if (!raw) return {};
      let v = null;
      try {
        v = JSON.parse(raw);
      } catch (_) {
        return {};
      }
      return isObj(v) && v.version === 1 && isObj(v.pages) ? v.pages : {};
    }

    function writeAll(pages) {
      if (Object.keys(pages).length) storage.setItem(key, JSON.stringify({ version: 1, pages }));
      else storage.removeItem(key);
    }

    return {
      key,
      get failed() {
        return broken || memoryOnly.size > 0;
      },
      load() {
        try {
          const all = readAll();
          const out = {};
          for (const id of Object.keys(all)) if (validDraft(all[id])) out[id] = all[id];
          return out;
        } catch (_) {
          broken = true;
          return {};
        }
      },
      put(id, rec) {
        try {
          const all = readAll();
          all[id] = rec;
          writeAll(all);
          memoryOnly.delete(id);
          broken = false;
          return true;
        } catch (_) {
          memoryOnly.add(id);
          broken = true;
          return false;
        }
      },
      /**
       * The page is clean (saved on the server, or remote explicitly loaded). Remove only
       * the draft this client wrote (same generation AND same content), never a newer one
       * or another tab's draft that happens to carry the same generation number.
       */
      drop(id, generation, sent) {
        memoryOnly.delete(id);
        try {
          const all = readAll();
          const cur = all[id];
          if (!cur) return true;
          if (generation != null && cur.generation !== generation) return true;
          if (generation != null && sent && !sameContent(cur, sent)) return true;
          delete all[id];
          writeAll(all);
          return true;
        } catch (_) {
          broken = true; // content is on the server; a stale draft is detected on the next load
          return false;
        }
      },
    };
  }

  // ------------------------------------------------------------------ core state machine

  /**
   * opts.request(payload, {keepalive}) -> Promise<json>; rejects with err.status/err.data
   * opts.fetchNotebook(meta:boolean) -> Promise<json>
   * opts.drafts: createDraftStore(...)
   * opts.timers: {set, clear}; opts.now(); opts.onChange(evt)
   */
  function createCore(opts) {
    const request = opts.request;
    const fetchNotebook = opts.fetchNotebook;
    const drafts = opts.drafts;
    const timers = opts.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
    const now = opts.now || (() => Date.now());
    const onChange = opts.onChange || (() => {});

    const st = {
      notebookRev: 0,
      order: [],
      entries: new Map(),
      currentId: null,
      offline: false,
      savedOnce: false,
      categories: [],
      projects: [],
      polling: false,
      creating: false,
      notice: "",
    };

    function editableFromPage(p) {
      const lines = pageLines(p) || Rich.plainLines("");
      return {
        text: Rich.flat(lines),
        fmt: Rich.fmtOf(lines),
        ids: Rich.idsOf(lines), // block identity (never part of equality)
        pinned: !!p.pinned,
        project_id: optId(p.project_id),
        category_id: optId(p.category_id),
      };
    }

    function sameEditable(a, b) {
      return a.text === b.text && a.fmt === b.fmt && a.pinned === b.pinned && a.project_id === b.project_id && a.category_id === b.category_id;
    }

    function newEntry(page) {
      return {
        id: page.id,
        server: page,
        latest: page, // newest authoritative server copy seen (may be newer than serverRev while dirty)
        intent: {}, // explicit organization choices not yet on the server: {field: {value, base}}
        serverRev: page.rev,
        blockId: pageBlockId(page),
        local: editableFromPage(page),
        generation: 0,
        savedGeneration: 0,
        updatedLocalAt: 0,
        inflight: null,
        conflict: null,
        timer: null,
        retryTimer: null,
        retries: 0,
        error: "",
        orphan: false,
        alias: {}, // obsolete block id / temporary key -> server-adopted id (keeps a stale DOM from re-sending it)
        draftBase: null, // recovered draft: EXACT {text, pinned} its base rev held (null = unknown)
      };
    }

    function isDirty(e) {
      return e.generation !== e.savedGeneration;
    }

    function busy(e) {
      return isDirty(e) || !!e.inflight || !!e.conflict;
    }

    // ------------------------------------------------------------ organization (server wins)

    function has(o, k) {
      return Object.prototype.hasOwnProperty.call(o, k);
    }

    function serverOf(e) {
      return e.latest || e.server || {};
    }

    /** Can `value` be assigned for field f? Unknown targets never; archived projects only if already set. */
    function orgTargetOk(f, value, serverValue) {
      if (value === null) return true;
      const list = f === "project_id" ? st.projects : st.categories;
      const item = list.find((x) => x && x.id === value);
      if (!item) return false;
      if (f === "project_id" && item.archived && value !== serverValue) return false;
      return true;
    }

    /** Effective local org = intent value, else newest authoritative server value. */
    function syncOrg(e) {
      const srv = serverOf(e);
      const next = Object.assign({}, e.local);
      for (const f of ORG) next[f] = e.intent[f] ? e.intent[f].value : optId(srv[f]);
      e.local = next;
    }

    /**
     * Reconcile intents against an authoritative server page. `own` maps fields this client
     * just wrote (confirmed by that page) to the values sent.
     */
    function reconcileOrg(e, page, own) {
      if (!isObj(page)) return;
      for (const f of ORG) {
        const it = e.intent[f];
        if (!it) continue;
        const sv = optId(page[f]);
        if (own && has(own, f) && own[f] === sv) {
          if (it.value === sv) delete e.intent[f]; // our choice landed
          else it.base = sv; // newer choice, rebased on our own confirmed write
        } else if (it.value === sv) {
          delete e.intent[f]; // already true on the server
        } else if (it.base !== sv) {
          delete e.intent[f]; // changed elsewhere (e.g. category deleted): server wins
        }
      }
      validateIntents(e);
    }

    function validateIntents(e) {
      const srv = serverOf(e);
      let dropped = false;
      for (const f of ORG) {
        const it = e.intent[f];
        if (it && !orgTargetOk(f, it.value, optId(srv[f]))) {
          delete e.intent[f];
          dropped = true;
        }
      }
      return dropped;
    }

    function noteLatest(e, page) {
      if (!e.latest || page.rev >= e.latest.rev) e.latest = page;
    }

    function readDraftOrg(org) {
      const out = {};
      if (!isObj(org)) return out;
      for (const f of ORG) {
        const it = org[f];
        if (!isObj(it)) continue;
        const okV = it.value === null || typeof it.value === "string";
        const okB = it.base === null || typeof it.base === "string";
        if (okV && okB) out[f] = { value: it.value, base: it.base };
      }
      return out;
    }

    /**
     * Local draft content. Same strategy as the wire: a plain page longer than the structured block
     * limit is persisted as ONE compact legacy text block (never one object per newline: that could
     * exhaust the browser draft quota); everything else is V2. Real server ids only, never temporary keys.
     */
    function draftContent(local) {
      const lines = Rich.linesFromTextFmt(local.text, local.fmt, local.ids) || Rich.plainLines(local.text);
      return Rich.wireContent(lines, null, Rich.isRealId(lines[0].id) ? lines[0].id : null);
    }

    function draftRecord(e) {
      const rec = {
        server_rev: e.serverRev,
        generation: e.generation,
        saved_generation: e.savedGeneration,
        updated_local_at: e.updatedLocalAt || now(),
        pinned: e.local.pinned,
        content: draftContent(e.local),
      };
      // Exact content of the save base (not a hash): lets a restore rebase only on proven
      // equality. It changes only when the base does (never per keystroke). Stage 04: the
      // base carries the canonical structure string too (version 2).
      const base = baseContent(e);
      // A plain base keeps the accepted version-1 shape (text + pin) so older readers still
      // understand it; only a structured base needs the version-2 shape.
      if (base) {
        if (base.legacy && base.fmt === "") rec.base = { version: 1, text: base.text, pinned: base.pinned }; // legacy single-block page: accepted shape
        else if (Array.isArray(base.ids)) rec.base = { version: 3, text: base.text, fmt: base.fmt, pinned: base.pinned, ids: base.ids.slice() };
        else rec.base = { version: 2, text: base.text, fmt: base.fmt, pinned: base.pinned }; // no vector known (recovered pre-id base)
      }
      // Never a snapshot of project/category: only explicit, reconcilable choices.
      const org = {};
      for (const f of ORG) if (e.intent[f]) org[f] = { value: e.intent[f].value, base: e.intent[f].base };
      if (Object.keys(org).length) rec.org = org;
      return rec;
    }

    function persist(e) {
      return drafts.put(e.id, draftRecord(e));
    }

    function clearTimers(e) {
      if (e.timer) timers.clear(e.timer);
      if (e.retryTimer) timers.clear(e.retryTimer);
      e.timer = null;
      e.retryTimer = null;
    }

    function schedule(e) {
      if (e.timer) timers.clear(e.timer);
      e.timer = null;
      if (e.conflict || e.orphan || isTrashed(e)) return;
      e.timer = timers.set(() => {
        e.timer = null;
        flush(e.id);
      }, DEBOUNCE_MS);
    }

    // Lifecycle (active vs trashed) is SERVER-AUTHORITATIVE and always read from the newest
    // authoritative copy (e.latest), even while local text/pin are dirty. e.server/serverRev
    // remain the optimistic-save BASE (the copy the local edits were made against).
    function isActive(e) {
      const srv = serverOf(e);
      return srv.deleted_at == null;
    }

    function isTrashed(e) {
      return !!e && serverOf(e).deleted_at != null;
    }

    /** Exact content (text + structure + pin) of the save base, or null when it is not known exactly. */
    function baseContent(e) {
      if (e.server && e.server.rev === e.serverRev) {
        // ids: the exact authoritative block-id vector of the base (the proof of identity for a fast rebase)
        return { text: pageText(e.server), fmt: pageFmt(e.server), pinned: !!e.server.pinned, ids: pageIdVector(e.server), legacy: !!(e.server.content && e.server.content.version === 1) };
      }
      return e.draftBase || null;
    }

    /** Persisted exact base snapshot; anything malformed, legacy or impossible fails CLOSED (null). */
    function readDraftBase(b) {
      if (!isObj(b)) return null;
      const keys = Object.keys(b).sort().join(",");
      let fmt = "";
      let ids = null; // the base's authoritative block-id vector, when it was persisted (version 3)
      let legacy = false;
      if (keys === "pinned,text,version" && b.version === 1) {
        fmt = ""; // Stage 02/03 base: text + pin only, so it can equal only a plain (unstructured) page
        legacy = true; // no id vector: identity is only provable against a single-block legacy page
      } else if (keys === "fmt,pinned,text,version" && b.version === 2 && typeof b.fmt === "string") {
        fmt = b.fmt;
        legacy = true; // Stage 04 pre-id base: no id vector
      } else if (keys === "fmt,ids,pinned,text,version" && b.version === 3 && typeof b.fmt === "string" && Array.isArray(b.ids)) {
        fmt = b.fmt;
        ids = b.ids;
      } else return null;
      if (typeof b.text !== "string" || typeof b.pinned !== "boolean") return null;
      try {
        if (utf8Bytes(b.text) > PAGE_TEXT_BYTES || fmt.length > PAGE_FMT_CHARS) return null;
      } catch (_) {
        return null;
      }
      const lines = Rich.linesFromTextFmt(b.text, fmt);
      if (lines === null) return null; // structure must fit the text exactly
      if (ids !== null) {
        // strict: one real, unique id per line, bounded by the structured block limit
        if (ids.length !== lines.length || ids.length > Rich.BLOCKS_MAX || ids.some((x) => !Rich.isRealId(x)) || new Set(ids).size !== ids.length) return null;
      }
      return { text: b.text, fmt, pinned: b.pinned, ids, legacy };
    }

    /**
     * A newer authoritative copy whose text/pin equal the save base only changed lifecycle or
     * organization: the local save may be rebased onto it without hiding any remote content.
     * Otherwise the base is kept and the ordinary 409 conflict protection applies.
     */
    function rebaseIfContentUnchanged(e, page) {
      if (!validPage(page) || page.rev <= e.serverRev || e.inflight || e.conflict) return false;
      const base = baseContent(e);
      if (!base || base.text !== pageText(page) || base.fmt !== pageFmt(page) || base.pinned !== (page.pinned === true)) return false;
      // Block identity must be provable too: text + structure + pin can be restored while the blocks
      // were re-created or re-associated. A fast rebase is only for a newer revision that changed
      // lifecycle/organization, so the block-id vector must be EXACTLY the OLD AUTHORITATIVE BASE's
      // (same ids, same order). Never inferred from the dirty local ids (local insertions/deletions).
      // - in memory the old authoritative page is known; a recovered v3 base carries its vector;
      // - a legacy base without a vector (Stage 02/03 shape) is provable only against a single-block
      //   legacy page (one block: nothing to re-associate); anything else fails CLOSED: no rebase, the
      //   save meets the ordinary revision conflict, remote ids/content and the local draft stay untouched.
      const newIds = pageIdVector(page);
      if (Array.isArray(base.ids)) {
        if (base.ids.length !== newIds.length || base.ids.some((id, i) => id !== newIds[i])) return false;
      } else if (!(page.content && page.content.version === 1 && newIds.length === 1)) return false;
      e.server = page;
      e.serverRev = page.rev;
      e.draftBase = null;
      e.blockId = pageBlockId(page) || e.blockId;
      return true;
    }

    /** Explicit organization choice for a page: saved through the ordinary page queue. */
    function setContext(id, patch) {
      const e = st.entries.get(id);
      if (!e || e.orphan || e.conflict || isTrashed(e) || !isObj(patch)) return false;
      const srv = serverOf(e);
      let changed = false;
      for (const f of ORG) {
        if (!has(patch, f)) continue;
        const v = patch[f] === "" || patch[f] == null ? null : String(patch[f]);
        const sv = optId(srv[f]);
        if (!orgTargetOk(f, v, sv)) return false;
        if (v === e.local[f]) continue;
        if (v === sv) delete e.intent[f];
        else e.intent[f] = { value: v, base: sv };
        changed = true;
      }
      if (!changed) return false;
      syncOrg(e);
      e.generation += 1;
      e.updatedLocalAt = now();
      persist(e);
      e.error = "";
      onChange({ type: "edit", id });
      flush(id); // discrete choice: send now (still one in-flight save per page)
      return true;
    }

    // ---------------------------------------------------------------- edits

    function edit(id, patch) {
      const e = st.entries.get(id);
      if (!e || isTrashed(e)) return false; // trashed pages are read-only until restored
      const next = Object.assign({}, e.local);
      if (typeof patch.text === "string") next.text = patch.text;
      if (typeof patch.fmt === "string") next.fmt = patch.fmt;
      if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
      // text and structure must always describe the same lines; never store a mismatched pair
      if (typeof patch.text === "string" || typeof patch.fmt === "string") {
        const lines = Rich.linesFromTextFmt(next.text, next.fmt);
        if (lines === null) return false;
        const n = lines.length;
        // block ids: the caller's (the editor tracks them through every edit), else the previous ones
        // when the line count is unchanged, else all-new blocks
        if (Array.isArray(patch.ids) && patch.ids.length === n) next.ids = patch.ids.map((x) => (Rich.isRealId(x) || Rich.isTmpId(x) ? x : null));
        else if (Array.isArray(e.local.ids) && e.local.ids.length === n) next.ids = e.local.ids;
        else next.ids = new Array(n).fill(null);
        // a caller holding a stale id (e.g. a live DOM that has not seen the adoption yet) never re-sends it
        next.ids = next.ids.map((x) => (x && e.alias[x]) || x);
      }
      e.local = next;
      e.generation += 1; // 1. generation++
      e.updatedLocalAt = now();
      persist(e); // 2. synchronous local draft before any network work
      e.error = e.orphan ? MSG.orphan : ""; // 3. dirty (generation != savedGeneration)
      schedule(e); // 4. debounce
      onChange({ type: "edit", id });
      return true;
    }

    // ---------------------------------------------------------------- saves

    function flush(id, options) {
      const e = st.entries.get(id);
      if (!e) return Promise.resolve();
      if (e.timer) {
        timers.clear(e.timer);
        e.timer = null;
      }
      if (e.conflict || e.orphan || !isDirty(e) || isTrashed(e)) return Promise.resolve();
      if (e.inflight) return e.inflight.promise; // one in-flight save per page; newer state follows on return
      if (e.retryTimer) {
        timers.clear(e.retryTimer);
        e.retryTimer = null;
      }
      if (validateIntents(e)) syncOrg(e);
      const sent = Object.assign({}, e.local, { ids: (e.local.ids || []).slice() });
      const generation = e.generation;
      const expected = e.serverRev;
      // A save may only claim block ids that exist in the page revision it is based on; anything
      // else (a block deleted elsewhere, a temporary key) is sent as a NEW block.
      const allowed = pageBlockIds(e.server);
      const baseLines = pageLines(e.server);
      const firstBaseId = baseLines && baseLines[0] ? baseLines[0].id : null;
      const payload = {
        action: "page_save",
        id: e.id,
        expected_rev: expected,
        content: Rich.wireContent(Rich.linesFromTextFmt(sent.text, sent.fmt, sent.ids) || Rich.plainLines(sent.text), allowed, firstBaseId),
      };
      // Pin is sent only when it differs from the server. project/category are sent ONLY as
      // surviving explicit intents (never a draft snapshot): a stale client must not
      // resurrect a deleted category/project.
      if (!e.server || sent.pinned !== !!e.server.pinned) payload.pinned = sent.pinned;
      const org = {};
      for (const f of ORG) {
        if (e.intent[f]) {
          payload[f] = e.intent[f].value;
          org[f] = e.intent[f].value;
        }
      }
      let keepalive = !!(options && options.keepalive);
      if (keepalive) {
        try {
          if (utf8Bytes(JSON.stringify(payload)) > KEEPALIVE_MAX) keepalive = false; // browser keepalive cap is ~64 KiB
        } catch (_) {
          keepalive = false;
        }
      }
      const inflight = { generation, sent, expected, org, allowed, promise: null };
      e.inflight = inflight;
      inflight.promise = Promise.resolve()
        .then(() => request(payload, { keepalive }))
        .then(
          (res) => onSaved(e, inflight, res),
          (err) => onSaveError(e, inflight, err)
        );
      onChange({ type: "saving", id: e.id });
      return inflight.promise;
    }

    function onSaved(e, inflight, res) {
      if (e.inflight === inflight) e.inflight = null;
      st.offline = false;
      e.retries = 0;
      if (res && Number.isInteger(res.notebook_rev)) st.notebookRev = res.notebook_rev;
      const page = res && res.page;
      if (validPage(page) && page.id === e.id && page.rev >= e.serverRev) {
        e.server = page;
        e.serverRev = page.rev;
        noteLatest(e, page);
        reconcileOrg(e, page, inflight.org);
        if (e.latest !== page) reconcileOrg(e, e.latest, null);
        syncOrg(e);
      }
      // Adopt the server-generated block ids (positional: the server stores exactly the lines it was
      // sent). This is not a user edit: no generation bump, equality ignores ids.
      let adopted = null;
      const saved = validPage(page) && page.id === e.id ? pageLines(page) : null;
      if (saved && saved.length === inflight.sent.ids.length) {
        const pids = Rich.idsOf(saved);
        adopted = {};
        inflight.sent.ids.forEach((sid, i) => {
          if (sid && !inflight.allowed.has(sid) && Rich.isRealId(pids[i])) adopted[sid] = pids[i];
        });
        Object.assign(e.alias, adopted);
        const exact = e.generation === inflight.generation && sameEditable(e.local, inflight.sent);
        if (exact) e.local = Object.assign({}, e.local, { ids: pids });
        else if (Array.isArray(e.local.ids)) e.local = Object.assign({}, e.local, { ids: e.local.ids.map((x) => (x && adopted[x]) || x) });
      }
      if (e.generation === inflight.generation && sameEditable(e.local, inflight.sent)) {
        e.savedGeneration = inflight.generation;
        drafts.drop(e.id, inflight.generation, inflight.sent);
        e.error = "";
        st.savedOnce = true;
        onChange({ type: "saved", id: e.id, adopted });
        return;
      }
      // Late success: newer typing exists. Keep dirty + draft, record the new base rev,
      // and send the newest state immediately against it.
      persist(e);
      onChange({ type: "saved-stale", id: e.id, adopted });
      if (!e.conflict) return flush(e.id);
    }

    function onSaveError(e, inflight, err) {
      if (e.inflight === inflight) e.inflight = null;
      const status = err && Number.isInteger(err.status) ? err.status : 0;
      const data = err && isObj(err.data) ? err.data : null;
      if (status === 409 && data && data.code === "revision_conflict" && validPage(data.page)) {
        const remote = editableFromPage(data.page);
        const orgSame = ORG.every((f) => !has(inflight.org, f) || remote[f] === inflight.org[f]);
        if (remote.text === inflight.sent.text && remote.fmt === inflight.sent.fmt && remote.pinned === inflight.sent.pinned && orgSame) {
          // The server already holds exactly what we sent (e.g. a keepalive flush from a
          // closed tab landed after reload): not a conflict — adopt it like a success.
          return onSaved(e, inflight, { page: data.page, notebook_rev: data.notebook_rev });
        }
        if (Number.isInteger(data.notebook_rev)) st.notebookRev = data.notebook_rev;
        if (data.page.deleted_at != null) {
          // Trashed elsewhere while we were saving: the lifecycle advances (read-only, Corbeille),
          // the local text stays as a protected draft, and autosave stops until a restore.
          noteLatest(e, data.page);
          reconcileOrg(e, data.page, null);
          syncOrg(e);
          clearTimers(e);
          persist(e);
          onChange({ type: "lifecycle", id: e.id });
          return;
        }
        e.conflict = { page: data.page };
        clearTimers(e);
        // Organization: the conflicting server page is authoritative.
        noteLatest(e, data.page);
        reconcileOrg(e, data.page, null);
        syncOrg(e);
        persist(e); // local text stays exactly as typed
        onChange({ type: "conflict", id: e.id });
        return;
      }
      if (!status || status >= 500 || status === 408 || status === 429) {
        st.offline = true;
        scheduleRetry(e);
        onChange({ type: "offline", id: e.id });
        return;
      }
      if (status === 401) e.error = MSG.session;
      else e.error = String((data && data.error) || typedFallback(err)).slice(0, 160);
      onChange({ type: "error", id: e.id });
      if ((status === 400 || status === 404) && Object.keys(inflight.org).length) {
        // A project/category target vanished or was archived meanwhile: refresh the
        // authoritative structure; retry only if that actually dropped a stale intent.
        const before = JSON.stringify(e.intent);
        refreshFull().then(() => {
          if (JSON.stringify(e.intent) !== before && !e.conflict && isDirty(e)) {
            e.error = "";
            flush(e.id);
          }
        }, () => {});
      }
    }

    function scheduleRetry(e) {
      if (e.retryTimer) timers.clear(e.retryTimer);
      const ms = RETRY_MS[Math.min(e.retries, RETRY_MS.length - 1)];
      e.retries += 1;
      e.retryTimer = timers.set(() => {
        e.retryTimer = null;
        flush(e.id);
      }, ms);
    }

    function flushAll(options) {
      const out = [];
      for (const e of st.entries.values()) if (isDirty(e)) out.push(flush(e.id, options));
      return Promise.all(out);
    }

    function retryAll() {
      for (const e of st.entries.values()) {
        if (isDirty(e) && !e.inflight && !e.conflict && !e.orphan) {
          e.retries = 0;
          flush(e.id);
        }
      }
    }

    // ---------------------------------------------------------------- conflict resolution

    function loadRemote(id) {
      const e = st.entries.get(id);
      if (!e || !e.conflict) return false;
      const page = e.conflict.page;
      clearTimers(e);
      e.conflict = null;
      e.server = page;
      e.serverRev = page.rev;
      noteLatest(e, page);
      e.intent = {}; // explicit choice: the remote version wins entirely
      e.alias = {};
      e.blockId = pageBlockId(page) || e.blockId;
      e.local = editableFromPage(page);
      syncOrg(e);
      e.generation += 1;
      e.savedGeneration = e.generation;
      e.error = "";
      drafts.drop(e.id);
      onChange({ type: "remote", id: e.id, reload: true });
      return true;
    }

    /** Replace the server copy with the CURRENT local state against the latest remote rev. */
    function keepLocal(id) {
      const e = st.entries.get(id);
      if (!e || !e.conflict || isTrashed(e)) return Promise.resolve();
      const page = e.conflict.page;
      e.conflict = null;
      e.server = page;
      e.serverRev = page.rev;
      noteLatest(e, page);
      reconcileOrg(e, e.latest, null); // "my version" = my text/pin; never stale organization
      syncOrg(e);
      if (!isDirty(e)) e.generation += 1;
      e.error = "";
      persist(e);
      onChange({ type: "keep-local", id: e.id });
      return flush(e.id);
    }

    // ---------------------------------------------------------------- notebook merge

    function applyNotebook(nb) {
      if (!isObj(nb) || !Array.isArray(nb.pages)) throw new Error("Réponse carnet invalide");
      if (Number.isInteger(nb.notebook_rev)) st.notebookRev = nb.notebook_rev;
      if (Array.isArray(nb.categories)) st.categories = nb.categories;
      if (Array.isArray(nb.projects)) st.projects = nb.projects;
      const seen = new Set();
      const adopted = [];
      const resume = [];
      for (const p of nb.pages) {
        if (!validPage(p)) continue;
        seen.add(p.id);
        const e = st.entries.get(p.id);
        if (!e) {
          st.entries.set(p.id, newEntry(p));
          continue;
        }
        if (e.orphan) {
          e.orphan = false;
          e.error = "";
        }
        if (busy(e)) {
          // dirty / saving / conflicted: text, pin and base rev are never overwritten by a
          // refresh — but organization metadata AND the trash lifecycle are authoritative.
          // While a save is in flight, org reconciliation waits for its response (which
          // identifies our own write).
          const wasTrashed = isTrashed(e);
          noteLatest(e, p);
          if (!e.inflight) reconcileOrg(e, e.latest, null);
          syncOrg(e);
          if (isTrashed(e)) {
            clearTimers(e); // trashed elsewhere: read-only, no autosave; the draft is kept
          } else if (wasTrashed && isDirty(e) && !e.inflight && !e.conflict) {
            // restored elsewhere: resume the protected draft (rebased only if the remote
            // content is exactly our base; otherwise the save meets the normal 409 guard)
            rebaseIfContentUnchanged(e, e.latest);
            resume.push(e.id);
          }
          continue;
        }
        if (p.rev > e.serverRev) {
          e.server = p;
          e.latest = p;
          e.serverRev = p.rev;
          e.intent = {};
          e.blockId = pageBlockId(p) || e.blockId;
          const next = editableFromPage(p);
          if (!sameEditable(next, e.local)) adopted.push(p.id);
          e.local = next;
        } else if (p.rev === e.serverRev) {
          e.server = p;
          e.latest = p;
          e.intent = {};
          e.local = Object.assign({}, e.local, { project_id: optId(p.project_id), category_id: optId(p.category_id) });
        }
      }
      for (const e of st.entries.values()) if (validateIntents(e)) syncOrg(e);
      for (const [id, e] of st.entries) {
        if (seen.has(id)) continue;
        if (busy(e)) {
          e.orphan = true;
          e.error = MSG.orphan;
          clearTimers(e);
        } else {
          st.entries.delete(id);
        }
      }
      const prevOrder = st.order.slice();
      const order = [];
      for (const p of nb.pages) {
        const e = st.entries.get(p && p.id);
        if (!e) continue;
        if (isActive(e)) order.push(e.id); // trashed pages (even with a local draft) live in Corbeille
      }
      for (const [id, e] of st.entries) if (e.orphan && !order.includes(id)) order.push(id);
      st.order = order;
      const viewingTrash = st.currentId && isTrashed(st.entries.get(st.currentId));
      if (!st.currentId || (!order.includes(st.currentId) && !viewingTrash)) {
        const oldIdx = Math.max(0, prevOrder.indexOf(st.currentId));
        st.currentId = order.length ? order[Math.min(oldIdx, order.length - 1)] : null;
      }
      for (const id of resume) {
        persist(st.entries.get(id));
        flush(id);
      }
      return adopted;
    }

    function applyDrafts(map) {
      for (const id of Object.keys(map)) {
        const d = map[id];
        if (d.generation <= d.saved_generation) continue;
        let e = st.entries.get(id);
        const content = draftEditable(d);
        const block0 = isObj(d.content.blocks[0]) ? d.content.blocks[0] : {};
        // The draft owns text + structure + pin only. Legacy project_id/category_id snapshots are ignored;
        // explicit organization intents are re-validated against the fresh server page.
        const draftLocal = { text: content.text, fmt: content.fmt, ids: content.ids, pinned: !!d.pinned };
        if (!e) {
          const page = {
            id,
            rev: d.server_rev,
            project_id: null,
            category_id: null,
            pinned: draftLocal.pinned,
            deleted_at: null,
            content: { version: 1, blocks: [{ id: typeof block0.id === "string" ? block0.id : null, type: "text", text: "", marks: [] }] },
          };
          e = newEntry(page);
          e.orphan = true;
          e.error = MSG.orphan;
          st.entries.set(id, e);
          st.order.push(id);
        } else {
          e.intent = readDraftOrg(d.org);
          reconcileOrg(e, serverOf(e), null);
          const server = editableFromPage(e.server);
          // Our own save already landed (tab closed before the draft was cleared).
          if (server.text === draftLocal.text && server.fmt === draftLocal.fmt && server.pinned === draftLocal.pinned && !Object.keys(e.intent).length) {
            drafts.drop(id, d.generation, draftLocal);
            continue;
          }
          if (!st.order.includes(id) && !isTrashed(e)) st.order.push(id); // a trashed page's draft waits in Corbeille
        }
        e.local = Object.assign({}, e.local, draftLocal);
        syncOrg(e);
        e.serverRev = d.server_rev;
        e.draftBase = readDraftBase(d.base); // legacy base_sig is never trusted
        e.generation = d.generation;
        e.savedGeneration = d.saved_generation;
        e.updatedLocalAt = Number(d.updated_local_at) || now();
        // The server may have moved on while this browser was closed (e.g. trashed then
        // restored elsewhere) without changing the content the draft descends from: rebase on
        // the already-known authoritative copy before the first save, on EXACT equality only.
        if (!e.orphan && !isTrashed(e) && rebaseIfContentUnchanged(e, serverOf(e))) persist(e);
      }
    }

    async function load() {
      const nb = await fetchNotebook(false);
      applyNotebook(nb);
      applyDrafts(drafts.load());
      onChange({ type: "loaded" });
      retryAll();
    }

    function needsFull(meta) {
      if (!isObj(meta) || !Array.isArray(meta.pages)) return true;
      if (meta.notebook_rev !== st.notebookRev) return true;
      const ids = new Set();
      for (const m of meta.pages) {
        if (!isObj(m) || typeof m.id !== "string") continue;
        ids.add(m.id);
        const e = st.entries.get(m.id);
        if (!e) {
          if (m.deleted_at == null) return true;
          continue;
        }
        if (busy(e)) {
          // protected local edits: never overwritten, but lifecycle/rev news must be fetched
          const latest = serverOf(e);
          if ((m.deleted_at == null) !== (latest.deleted_at == null) || (Number.isInteger(m.rev) && m.rev > latest.rev)) return true;
          continue;
        }
        if (m.rev !== e.serverRev) return true;
      }
      for (const [id, e] of st.entries) if (!ids.has(id) && !busy(e) && !e.orphan) return true;
      return false;
    }

    async function poll() {
      if (st.polling) return [];
      st.polling = true;
      const wasOffline = st.offline;
      try {
        const meta = await fetchNotebook(true);
        let adopted = [];
        if (needsFull(meta)) adopted = applyNotebook(await fetchNotebook(false));
        else if (Number.isInteger(meta.notebook_rev)) st.notebookRev = meta.notebook_rev;
        st.offline = false;
        st.pollOk = true;
        onChange({ type: "poll", adopted });
        if (wasOffline) retryAll();
        return adopted;
      } catch (err) {
        st.pollOk = false;
        const status = err && Number.isInteger(err.status) ? err.status : 0;
        if (!status || status >= 500) {
          st.offline = true;
          onChange({ type: "offline" });
        }
        return [];
      } finally {
        st.polling = false;
      }
    }

    // ---------------------------------------------------------------- navigation

    function go(delta) {
      const idx = st.order.indexOf(st.currentId);
      if (idx < 0) return null; // viewing a trashed page: no page flipping
      const next = st.order[idx + delta];
      if (!next) return null;
      return select(next);
    }

    function select(id) {
      if (!st.entries.has(id) || id === st.currentId) return null;
      const prev = st.currentId;
      st.currentId = id;
      if (prev && !isTrashed(st.entries.get(prev))) st.lastActiveId = prev;
      if (prev) flush(prev); // never waits: the page switch is local
      onChange({ type: "select", id, prev });
      return id;
    }

    /**
     * New page after the current one. Global creation stays "À classer"; opts.project_id /
     * opts.category_id (create while filtered in that context) are inherited when valid.
     */
    async function createPage(opts) {
      if (st.creating) return null;
      st.creating = true;
      try {
        if (st.currentId) flush(st.currentId);
        const cur = st.entries.get(st.currentId);
        const afterId = cur && !cur.orphan && isActive(cur) ? cur.id : null;
        const ctx = {};
        for (const f of ORG) {
          const v = opts && typeof opts[f] === "string" ? opts[f] : null;
          if (v && orgTargetOk(f, v, null)) ctx[f] = v;
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const body = Object.assign({
              action: "page_create",
              expected_notebook_rev: st.notebookRev,
              after_id: afterId,
            }, ctx);
            // Templates: the page is created WITH its content in this one request (server-validated, atomic): a refusal leaves no page.
            if (opts && opts.content) body.content = opts.content;
            if (opts && typeof opts.requestId === "string") body.request_id = opts.requestId;
            const res = await request(body, {});
            if (!validPage(res && res.page)) throw new Error("Réponse carnet invalide");
            if (Number.isInteger(res.notebook_rev)) st.notebookRev = res.notebook_rev;
            const e = st.entries.get(res.page.id) || newEntry(res.page);
            if (!st.entries.has(e.id)) {
              st.entries.set(e.id, e);
              const at = afterId ? st.order.indexOf(afterId) + 1 : st.order.length;
              st.order.splice(at > 0 ? at : st.order.length, 0, e.id);
            }
            st.offline = false;
            const prev = st.currentId;
            st.currentId = e.id;
            onChange({ type: "select", id: e.id, prev, created: true });
            return e.id;
          } catch (err) {
            const data = err && isObj(err.data) ? err.data : null;
            if (attempt === 0 && err && err.status === 409 && data && data.code === "notebook_revision_conflict") {
              applyNotebook(await fetchNotebook(false));
              continue;
            }
            const status = err && Number.isInteger(err.status) ? err.status : 0;
            st.lastCode = data && typeof data.code === "string" ? data.code : "";
            if (!status || status >= 500) st.offline = true;
            st.notice = !status || status >= 500 ? MSG.offlineClean + " — nouvelle page impossible" :
              String((data && data.error) || typedFallback(err)).slice(0, 160);
            onChange({ type: "notice" });
            return null;
          }
        }
        return null;
      } finally {
        st.creating = false;
      }
    }

    // ---------------------------------------------------------------- structural actions

    function errInfo(err) {
      return {
        status: err && Number.isInteger(err.status) ? err.status : 0,
        data: err && isObj(err.data) ? err.data : null,
      };
    }

    function userMessage(err) {
      const { status, data } = errInfo(err);
      if (!status || status >= 500) return MSG.offlineClean;
      return String((data && data.error) || typedFallback(err)).slice(0, 160);
    }

    function userError(msg) {
      const err = new Error(msg);
      err.status = 400;
      err.data = { error: msg, code: "client" };
      return err;
    }

    /** Authoritative full refresh (never overwrites dirty text; org reconciled). */
    async function refreshFull() {
      const adopted = applyNotebook(await fetchNotebook(false));
      onChange({ type: "poll", adopted });
      return adopted;
    }

    /** One structural request; a stale notebook/page rev refreshes once and retries. */
    /**
     * One structural request. By default a stale notebook/page rev refreshes once and retries
     * (reversible actions only). opts.retry === false never retries: the stale 409 refreshes
     * the authoritative state and is rethrown (irreversible actions need a new human decision).
     */
    async function structural(build, opts) {
      const retry = !(opts && opts.retry === false);
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await request(build(), {});
          if (res && Number.isInteger(res.notebook_rev)) st.notebookRev = res.notebook_rev;
          st.offline = false;
          return res || {};
        } catch (err) {
          const { status, data } = errInfo(err);
          const stale = status === 409 && data && (data.code === "notebook_revision_conflict" || data.code === "revision_conflict");
          if (stale && (!retry || attempt > 0)) {
            try {
              await refreshFull();
            } catch (_) {}
            throw err;
          }
          if (attempt === 0 && stale) {
            await refreshFull();
            continue;
          }
          if (!status || status >= 500) st.offline = true;
          throw err;
        }
      }
    }

    /** Wait until a page has no pending local change (bounded). */
    async function settle(e) {
      for (let i = 0; i < 4 && !e.conflict && !e.orphan && (isDirty(e) || e.inflight); i += 1) {
        if (e.inflight) await e.inflight.promise;
        else await flush(e.id);
      }
    }

    /** Adopt a structural result: lifecycle always; the save base only when nothing is pending. */
    function adoptStructuralPage(e, page) {
      if (!validPage(page) || page.id !== e.id) return;
      noteLatest(e, page);
      if (!isDirty(e) && !e.inflight && !e.conflict) {
        e.server = page;
        e.serverRev = page.rev;
        e.draftBase = null;
        e.intent = {};
        e.local = editableFromPage(page);
      } else {
        rebaseIfContentUnchanged(e, page);
      }
      syncOrg(e);
    }

    /** Soft delete. Returns true on success; throws a user-facing Error otherwise. */
    async function trashPage(id) {
      const e = st.entries.get(id);
      if (!e || e.orphan) throw userError("Page introuvable");
      if (isTrashed(e)) throw userError("Page déjà dans la corbeille");
      if (e.conflict) throw userError(MSG.trashConflict);
      await settle(e);
      if (e.conflict) throw userError(MSG.trashConflict);
      if (isDirty(e) || e.inflight) throw userError(MSG.trashPending);
      clearTimers(e);
      const res = await structural(() => {
        if (busy(e)) throw userError(MSG.trashPending);
        return { action: "page_trash", id, expected_rev: serverOf(e).rev, expected_notebook_rev: st.notebookRev };
      });
      adoptStructuralPage(e, res.page);
      const idx = st.order.indexOf(id);
      st.order = st.order.filter((x) => x !== id);
      let repl = null;
      if (validPage(res.replacement_page)) {
        // Final-active-page invariant: the server created a blank page.
        const r = newEntry(res.replacement_page);
        st.entries.set(r.id, r);
        st.order.push(r.id);
        repl = r.id;
      }
      if (st.currentId === id) {
        const next = repl || st.order[Math.min(Math.max(idx, 0), st.order.length - 1)] || null;
        const prev = st.currentId;
        st.currentId = next;
        onChange({ type: "select", id: next, prev });
      }
      onChange({ type: "trashed", id, replacement: repl });
      return true;
    }

    async function restorePage(id, options) {
      const e = st.entries.get(id);
      if (!e || !isTrashed(e)) throw userError("Page non supprimée");
      let res = null;
      try {
        res = await structural(() => {
          if (!isTrashed(e)) throw userError("already_active"); // restored elsewhere meanwhile
          return { action: "page_restore", id, expected_rev: serverOf(e).rev, expected_notebook_rev: st.notebookRev };
        });
      } catch (err) {
        if (!(err && err.message === "already_active")) throw err;
      }
      if (res) adoptStructuralPage(e, res.page);
      try {
        await refreshFull(); // authoritative order
      } catch (_) {
        if (!st.order.includes(id)) st.order.push(id);
      }
      if (!st.order.includes(id)) st.order.push(id);
      if (isDirty(e) && !e.inflight && !e.conflict && !isTrashed(e)) {
        // A recovered/protected draft resumes through the ordinary save queue right away,
        // on the rebased rev when only the lifecycle changed, else it meets the 409 guard.
        e.error = "";
        persist(e);
        flush(e.id);
      }
      if (!options || options.select !== false) {
        if (st.currentId === id) onChange({ type: "select", id, prev: id });
        else select(id);
      }
      onChange({ type: "restored", id });
      return true;
    }

    function staleDelete() {
      const err = userError(MSG.deleteStale);
      err.data.code = "delete_stale";
      return err;
    }

    /**
     * Irreversible: only from trash, only for the exact revision the human confirmed
     * (`confirmedRev`), and NEVER retried across a revision conflict. A stale confirmation
     * refreshes the authoritative state, leaves the page intact and throws `delete_stale`:
     * the UI must ask for a new confirmation of the current revision.
     */
    async function deletePermanent(id, confirmedRev) {
      const e = st.entries.get(id);
      if (!e || !isTrashed(e)) throw userError("Mets d'abord la page à la corbeille");
      if (!Number.isInteger(confirmedRev)) throw userError("Confirmation requise");
      if (serverOf(e).rev !== confirmedRev) throw staleDelete();
      try {
        await structural(() => ({
          action: "page_delete_permanent", id, expected_rev: confirmedRev, expected_notebook_rev: st.notebookRev,
        }), { retry: false });
      } catch (err) {
        const { status, data } = errInfo(err);
        if (status === 409 && data && (data.code === "revision_conflict" || data.code === "notebook_revision_conflict")) throw staleDelete();
        throw err;
      }
      clearTimers(e);
      st.entries.delete(id);
      drafts.drop(id);
      st.order = st.order.filter((x) => x !== id);
      if (st.currentId === id) {
        const back = st.lastActiveId && st.order.includes(st.lastActiveId) ? st.lastActiveId : st.order[0] || null;
        st.currentId = back;
        onChange({ type: "select", id: back, prev: id });
      }
      onChange({ type: "deleted", id });
      return true;
    }

    function replaceIn(list, item) {
      if (!isObj(item) || typeof item.id !== "string") return list;
      const out = list.filter((x) => !(x && x.id === item.id));
      const at = list.findIndex((x) => x && x.id === item.id);
      out.splice(at < 0 ? out.length : at, 0, item);
      return out;
    }

    function structureChanged() {
      for (const e of st.entries.values()) if (validateIntents(e)) syncOrg(e);
      onChange({ type: "structure" });
    }

    async function createProject(name) {
      const res = await structural(() => ({ action: "project_create", expected_notebook_rev: st.notebookRev, name }));
      st.projects = replaceIn(st.projects, res.project);
      structureChanged();
      return res.project;
    }

    async function renameProject(id, name) {
      const res = await structural(() => ({ action: "project_update", id, expected_notebook_rev: st.notebookRev, name }));
      st.projects = replaceIn(st.projects, res.project);
      structureChanged();
      return res.project;
    }

    async function archiveProject(id, archived) {
      const res = await structural(() => ({ action: "project_archive", id, expected_notebook_rev: st.notebookRev, archived: !!archived }));
      st.projects = replaceIn(st.projects, res.project);
      structureChanged();
      return res.project;
    }

    async function createCategory(name, color) {
      const res = await structural(() => ({ action: "category_create", expected_notebook_rev: st.notebookRev, name, color }));
      st.categories = replaceIn(st.categories, res.category);
      structureChanged();
      return res.category;
    }

    async function updateCategory(id, patch) {
      const res = await structural(() => Object.assign({ action: "category_update", id, expected_notebook_rev: st.notebookRev }, patch || {}));
      st.categories = replaceIn(st.categories, res.category);
      structureChanged();
      return res.category;
    }

    /** Pages lose the category server-side (rev bump). Pending edits are sent first. */
    async function deleteCategory(id) {
      await flushAll();
      const res = await structural(() => ({ action: "category_delete", id, expected_notebook_rev: st.notebookRev }));
      st.categories = st.categories.filter((x) => !(x && x.id === id));
      structureChanged();
      try {
        await refreshFull();
      } catch (_) {}
      return res;
    }

    // ---------------------------------------------------------------- library view model

    /** Visible text of tables / callouts / toggles / image captions: searchable (never replaceable), never title or preview. */
    function structExtra(fmt) {
      return Rich.structSearchText(fmt);
    }

    function libraryItems() {
      const projects = new Map();
      for (const p of st.projects) if (isObj(p)) projects.set(p.id, p);
      const categories = new Map();
      for (const c of st.categories) if (isObj(c)) categories.set(c.id, c);
      const out = [];
      for (const e of st.entries.values()) {
        if (e.orphan) continue;
        const srv = serverOf(e);
        const text = e.local.text;
        const proj = projects.get(e.local.project_id);
        const cat = categories.get(e.local.category_id);
        const pname = proj && typeof proj.name === "string" ? proj.name : "";
        const cname = cat && typeof cat.name === "string" ? cat.name : "";
        const localTs = isDirty(e) && e.updatedLocalAt ? e.updatedLocalAt / 1000 : 0;
        out.push({
          id: e.id,
          title: deriveTitle(text),
          preview: derivePreview(text),
          body: bodyText(text) + (structExtra(e.local.fmt) ? "\n" + structExtra(e.local.fmt) : ""),
          pinned: !!e.local.pinned,
          project_id: e.local.project_id,
          category_id: e.local.category_id,
          project: pname,
          projectArchived: !!(proj && proj.archived),
          category: cname,
          color: cat && typeof cat.color === "string" ? cat.color : "",
          context: [pname, cname].filter(Boolean).join(" "),
          deleted: isTrashed(e),
          deleted_at: Number(srv.deleted_at) || 0,
          updated: Math.max(Number(srv.updated_at) || 0, localTs),
          conflict: !!e.conflict,
          dirty: busy(e),
          hasDecision: typeof e.local.fmt === "string" && e.local.fmt.indexOf('["d",0,') >= 0,
        });
      }
      return out;
    }

    /**
     * Status of the CURRENT page only (never "saving" because another page is stuck),
     * plus the other pages that need a decision (conflict / orphan / error), in order.
     */
    function status() {
      const e = st.entries.get(st.currentId);
      const attention = [];
      for (const id of st.order) {
        const x = st.entries.get(id);
        if (x && x !== e && (x.conflict || x.orphan || x.error)) attention.push(id);
      }
      let cur = { text: "", kind: "" };
      if (e && isTrashed(e) && (isDirty(e) || e.inflight)) cur = { text: MSG.trashedDraft, kind: "warn" };
      else if (e && e.conflict) cur = { text: MSG.conflictStatus, kind: "warn" };
      else if (e && e.error) cur = { text: e.error, kind: "err" };
      else if (e && (isDirty(e) || e.inflight)) cur = st.offline ? { text: MSG.offline, kind: "warn" } : { text: MSG.saving, kind: "busy" };
      else if (st.offline) {
        const pending = [...st.entries.values()].some((x) => isDirty(x) || !!x.inflight);
        cur = { text: pending ? MSG.offline : MSG.offlineClean, kind: "warn" };
      } else if (st.notice) cur = { text: st.notice, kind: "err" };
      else if (e && st.savedOnce) cur = { text: MSG.saved, kind: "ok" };
      return { text: cur.text, kind: cur.kind, attention };
    }

    function snapshot() {
      return {
        currentId: st.currentId,
        order: st.order.slice(),
        notebookRev: st.notebookRev,
        offline: st.offline,
        pages: st.order.map((id) => {
          const e = st.entries.get(id);
          return {
            id,
            serverRev: e.serverRev,
            generation: e.generation,
            savedGeneration: e.savedGeneration,
            dirty: isDirty(e),
            inflight: !!e.inflight,
            conflict: !!e.conflict,
            orphan: e.orphan,
            pinned: !!e.local.pinned,
            project_id: e.local.project_id,
            category_id: e.local.category_id,
            intent: JSON.parse(JSON.stringify(e.intent)),
            trashed: isTrashed(e),
          };
        }),
      };
    }

    return {
      st,
      load,
      poll,
      edit,
      flush,
      flushAll,
      retryAll,
      loadRemote,
      keepLocal,
      applyNotebook,
      go,
      select,
      createPage,
      setContext,
      trashPage,
      restorePage,
      deletePermanent,
      createProject,
      renameProject,
      archiveProject,
      createCategory,
      updateCategory,
      deleteCategory,
      refreshFull,
      libraryItems,
      userMessage,
      isTrashed,
      isDirty,
      status,
      snapshot,
      entry: (id) => st.entries.get(id),
      current: () => st.entries.get(st.currentId),
      anyDirty: () => [...st.entries.values()].some((e) => isDirty(e) || !!e.inflight),
    };
  }

  const api = {
    MSG,
    SYMBOLS,
    POLL_MS,
    DEBOUNCE_MS,
    SWIPE_MIN,
    SWIPE_RATIO,
    UNTITLED,
    FILTERS,
    BUCKETS,
    deriveTitle,
    derivePreview,
    fold,
    searchPages,
    recencyBucket,
    groupRecents,
    selectPages,
    draftKey,
    timeMarker,
    isSwipe,
    pageNavDelta,
    createDraftStore,
    createCore,
    Rich,
    pageFmt,
    pageLines,
    EXPORT_PREFIX,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!global || typeof global.document === "undefined") return;

  // ================================================================== browser UI

  const doc = global.document;
  const ui = {
    phase: "idle", // idle | booting | ready | denied | failed
    active: false,
    core: null,
    eng: null,
    drafts: null,
    host: null,
    root: null,
    editor: null,
    paper: null,
    statusEl: null,
    flashEl: null,
    pollTimer: null,
    flashTimer: null,
    listeners: false,
    toolsOpen: false,
    swipe: null,
    role: null, // confirmed /api/me role (drives Home privacy)
    lib: { open: false, collapsed: false, fold: { projects: false, categories: false }, manage: false, sel: { filter: "all", id: null }, query: "", timer: null, sig: "", scopeSig: "" },
    libEl: null,
    ctxOpen: false,
    focus: false,
    undo: null, // {id, timer}
    confirmId: null, // page awaiting permanent-delete confirmation
    confirmRev: null, // the exact authoritative revision the human is confirming
    deleteNotice: null, // {id, text}: a stale confirmation was invalidated
    pending: null, // Home launcher request processed once the editor is ready
    pendingAnchor: null, // Phase 3.5: a validated #carnet/<page>/<block> waiting for the editor
    portalKnown: new Map(), // Phase 3.5: session-local "kind:id" -> "ok" | "missing" (never persisted)
    polish: null,
    home: { busy: false, timer: null },
    mqBound: false,
    fmtOpen: false,
    selCache: null, // last editor selection {start, end} (flat offsets): toolbar taps may blur the editor
    pendingMarks: null, // {pos, types:Set}: inline styles armed at a collapsed caret
    linkOpen: false,
    linkRange: null,
    linkMark: null,
    user: "", // confirmed /api/me username (namespaces local exports memory like drafts)
    find: { open: false, q: "", r: "", caseSensitive: false, wholeWord: false, index: -1, matches: [], undo: null },
    exportOpen: false,
    printNode: null,
    // Stage 06: {panelOpen, busy, origin: {pageId, mode, anchorId, replace}, sel: {pageId, blockId, assetId, rev, sig}, confirm, timer}
    image: { panelOpen: false, busy: false, origin: null, sel: null, confirm: false, timer: null, inputs: null },
    tpl: null, // template picker {box, back, list, open, ctx, from}
    recents: null, // recent command ids (validated; see recentsList)
  };

  function el(tag, attrs, children) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "text") n.textContent = String(v);
        else if (k === "class") n.className = v;
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children || []) if (c) n.appendChild(c);
    return n;
  }

  function svgIcon(d) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "carnet-ico");
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  const ICON = {
    prev: "M15 5l-7 7 7 7",
    next: "M9 5l7 7-7 7",
    plus: "M12 5v14M5 12h14",
    copy: "M9 9h10v11H9zM5 15V4h10",
    pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
    library: "M5 4h4v16H5zM11 4h4v16h-4zM17 5l3 .8-3.6 14.4-3-.8",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    focus: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    unfocus: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
    close: "M6 6l12 12M18 6L6 18",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  };
  // 16F: library icons (filters and tools)
  const LIB_ICON = {
    all: "M4 6h16M4 12h16M4 18h16",
    pinned: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
    recent: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    unfiled: "M4 13l2.5-7h11l2.5 7v5H4zM4 13h5l1 2h4l1-2h5",
    decisions: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
    bulk: "M4 6h11M4 12h11M4 18h11M18 5l2 2-2 2M18 11l2 2-2 2",
    cockpit: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    ask: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
    reviews: "M6 3h9l4 4v14H6zM14 3v5h5M9 13l2 2 4-4",
  };
  const COLORS = { blue: "Bleu", green: "Vert", amber: "Ambre", coral: "Corail", violet: "Violet", pink: "Rose", teal: "Sarcelle", graphite: "Graphite" };

  function iconButton(id, label, icon, extra) {
    const b = el("button", Object.assign({ type: "button", id, class: "carnet-btn", "aria-label": label, title: label }, extra || {}));
    b.appendChild(svgIcon(icon));
    return b;
  }

  function keepFocus(btn) {
    // Toolbar taps must not steal focus from the editor (keeps the iOS keyboard + caret).
    btn.addEventListener("mousedown", (e) => e.preventDefault());
  }

  function reducedMotion() {
    try {
      return global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function finePointer() {
    try {
      return global.matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch (_) {
      return false;
    }
  }

  function carnetVisible() {
    return doc.body && doc.body.dataset.view === "carnet" && doc.visibilityState !== "hidden";
  }

  function safeStorage() {
    try {
      const s = global.localStorage;
      if (s) return s;
    } catch (_) {}
    const fail = () => {
      throw new Error("storage unavailable");
    };
    return { getItem: fail, setItem: fail, removeItem: fail };
  }

  function apiCall(url, opts) {
    if (typeof global.api === "function") return global.api(url, opts);
    return Promise.reject(new Error("api() indisponible"));
  }

  function request(payload, o) {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    };
    if (o && o.keepalive) init.keepalive = true;
    return apiCall("/api/carnet", init);
  }

  function fetchNotebook(meta) {
    return apiCall(meta ? "/api/carnet?meta=1" : "/api/carnet", { timeoutMs: 12000 });
  }

  // ---------------------------------------------------------------- shell / failure

  function renderFail(reason) {
    const host = doc.getElementById("hq-carnet-app");
    if (!host) return;
    const box = el("div", { class: "carnet-fail", role: "alert" }, [
      el("p", { class: "carnet-fail-title", text: MSG.failTitle }),
      el("p", { class: "hint carnet-fail-reason", text: String(reason || "erreur").slice(0, 120) }),
    ]);
    const btn = el("button", { type: "button", class: "secondary carnet-retry", text: MSG.retry });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      ui.phase = "idle";
      show();
    });
    box.appendChild(btn);
    host.textContent = "";
    host.appendChild(box);
  }

  function renderDenied() {
    const host = doc.getElementById("hq-carnet-app");
    if (!host) return;
    host.textContent = "";
    host.appendChild(el("p", { class: "hint carnet-denied", text: MSG.denied }));
  }

  function build(host) {
    const root = el("div", { class: "carnet" });

    // Phase 3.5: the visible save state is the pill; this element keeps the full (instant) text for tests / failures / notices and
    // never speaks (the debounced live region next to the pill does).
    const status = el("p", { id: "hq-carnet-status", class: "carnet-status", role: "status", "aria-live": "off" });
    const flash = el("span", { class: "carnet-flash", role: "status", "aria-live": "polite" });
    const attention = el("button", { type: "button", id: "btn-carnet-attention", class: "carnet-attention", hidden: true });
    const exportFlag = el("span", { id: "carnet-export-flag", class: "carnet-export-flag", hidden: true, text: MSG.exportStale });
    const context = el("button", {
      type: "button", id: "btn-carnet-context", class: "carnet-pill", title: "Projet et catégorie",
      "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "hq-carnet-context",
    });
    const pin = iconButton("btn-carnet-pin", "Épingler", ICON.pin, { "aria-pressed": "false" });
    const library = iconButton("btn-carnet-library", "Bibliothèque", ICON.library, { "aria-expanded": "false", "aria-controls": "hq-carnet-library" });
    const focusBtn = iconButton("btn-carnet-focus", "Mode concentration", ICON.focus, { "aria-pressed": "false" });
    const more = iconButton("btn-carnet-more", "Plus d'outils (symboles, recherche, export, historique…)", ICON.more, { "aria-expanded": "false", "aria-controls": "carnet-quick-tools" });
    const P = polishUi();
    const saveN = P ? P.saveNodes() : null;
    const outN = P ? P.outlineNodes() : null;
    const top = el("div", { class: "carnet-bar carnet-bar-top" }, [
      context,
      el("div", { class: "carnet-status-wrap" }, saveN ? [saveN.pill, saveN.pop, saveN.live, status, attention, exportFlag, flash] : [status, attention, exportFlag, flash]),
      el("div", { class: "carnet-actions" }, outN ? [pin, outN.button, library, focusBtn, more] : [pin, library, focusBtn, more]),
    ]);

    const tools = el("div", { id: "carnet-quick-tools", class: "carnet-tools", role: "toolbar", "aria-label": "Symboles", hidden: true });
    const mkGroup = (label) => { const g = el("div", { class: "carnet-tool-group", role: "group", "aria-label": label }, [el("span", { class: "carnet-tool-group-label", "aria-hidden": "true", text: label })]); tools.appendChild(g); return g; };
    let grp = mkGroup("Insérer");
    const strip = el("div", { class: "carnet-sym-strip" }); // phone: one scrollable line instead of three wrapped rows
    for (const sym of SYMBOLS) {
      const b = el("button", { type: "button", class: "carnet-sym", "data-carnet-symbol": sym, "aria-label": "Insérer " + sym, text: sym });
      keepFocus(b);
      strip.appendChild(b);
    }
    grp.appendChild(strip);
    const time = el("button", { type: "button", id: "btn-carnet-time", class: "carnet-sym carnet-time", "aria-label": "Insérer l'heure" });
    time.appendChild(svgIcon(ICON.clock));
    time.appendChild(el("span", { text: "Heure" }));
    keepFocus(time);
    grp.appendChild(time);
    const toolBtn = (id, label, text) => {
      const b = el("button", { type: "button", id, class: "carnet-sym carnet-tool", "data-carnet-tool": "", "aria-label": label, "aria-expanded": "false" });
      b.appendChild(el("span", { text }));
      keepFocus(b);
      return b;
    };
    grp.appendChild(toolBtn("btn-carnet-format", "Aa : mise en forme", "Aa"));
    grp.appendChild(toolBtn("btn-carnet-cite", "Insérer une référence (source, page)", "Référence"));
    grp.appendChild(toolBtn("btn-carnet-image", "Insérer une image (appareil photo, photos, fichiers)", "Image"));
    grp.appendChild(toolBtn("btn-carnet-eng", "Outils d'ingénierie (calcul, mesure, décision, conversion, tâche, lien)", "Ingénierie"));
    grp.appendChild(toolBtn("btn-carnet-templates", "Modèles : nouvelle page depuis un modèle", "Modèles"));
    grp = mkGroup("Page");
    grp.appendChild(toolBtn("btn-carnet-find", "Rechercher et remplacer dans la page", "Rechercher"));
    grp.appendChild(toolBtn("btn-carnet-export", "Exporter la page", "Exporter"));
    grp.appendChild(toolBtn("btn-carnet-history", "Historique, rapport et liens entrants (Liée depuis)", "Historique"));
    const trash = el("button", { type: "button", class: "carnet-sym carnet-trash-btn", "data-carnet-trash": "", "aria-label": "Mettre la page à la corbeille" });
    trash.appendChild(svgIcon(ICON.trash));
    trash.appendChild(el("span", { text: "Corbeille" }));
    grp.appendChild(trash);
    grp = mkGroup("Modules");
    grp.appendChild(toolBtn("btn-carnet-intel", "Cockpit du projet : décisions, mesures, changements et jalons", "Cockpit"));
    grp.appendChild(toolBtn("btn-carnet-ask", "Preuves du carnet : retrouver les passages qui répondent à une question (aucune réponse générée)", "Preuves"));
    grp.appendChild(toolBtn("btn-carnet-reviews", "Revues : dossiers de preuves à relire, liste de contrôle et questions (rien n'est déduit)", "Revues"));
    grp.appendChild(toolBtn("btn-carnet-verifications", "Vérifications : contrôles consignés contre un état précis des preuves (aucune identité n'est enregistrée)", "Vérifications"));
    grp.appendChild(toolBtn("btn-carnet-reasoning", "Registre des décisions et hypothèses : ce qui a été choisi, ce qui est tenu pour vrai pour l'instant (ni l'un ni l'autre n'est une preuve)", "Registre"));

    const conflict = el("div", { id: "hq-carnet-conflict", class: "carnet-conflict", role: "alert", hidden: true }, [
      el("p", { class: "carnet-conflict-msg", text: MSG.conflict }),
      el("div", { class: "carnet-conflict-actions" }, [
        el("button", { type: "button", id: "btn-carnet-conflict-remote", class: "secondary", text: "Charger la version distante" }),
        el("button", { type: "button", id: "btn-carnet-conflict-local", text: "Remplacer avec ma version" }),
      ]),
    ]);

    // Trashed page: read-only banner (restore / deep permanent delete).
    const trashed = el("div", { id: "hq-carnet-trashed", class: "carnet-banner carnet-trashed", role: "status", hidden: true }, [
      el("p", { class: "carnet-banner-msg", text: MSG.trashedBanner }),
      el("p", { id: "hq-carnet-trashed-note", class: "carnet-banner-note", role: "alert", hidden: true }),
      el("div", { class: "carnet-banner-actions" }, [
        el("button", { type: "button", class: "secondary", "data-carnet-restore": "", text: MSG.restore }),
        el("button", { type: "button", class: "danger carnet-danger", "data-carnet-delete-permanent": "", text: MSG.deletePermanent + "…" }),
      ]),
    ]);
    const confirmInput = el("input", {
      type: "text", id: "hq-carnet-delete-word", class: "carnet-input", autocomplete: "off", autocapitalize: "characters",
      spellcheck: "false", "aria-label": "Tape " + MSG.deleteWord + " pour confirmer", placeholder: MSG.deleteWord,
    });
    const confirmBtn = el("button", { type: "button", id: "btn-carnet-delete-confirm", class: "danger carnet-danger", disabled: true, text: MSG.deletePermanent });
    const confirmTitle = el("strong", { class: "carnet-confirm-title" });
    const confirm = el("div", { id: "hq-carnet-delete-confirm", class: "carnet-banner carnet-confirm", role: "alertdialog", "aria-labelledby": "carnet-confirm-q", hidden: true }, [
      el("p", { id: "carnet-confirm-q", class: "carnet-banner-msg" }, [
        doc.createTextNode("Supprimer définitivement « "), confirmTitle, doc.createTextNode(" » ? Cette action est irréversible."),
      ]),
      el("p", { class: "hint carnet-confirm-hint", text: "Tape " + MSG.deleteWord + " pour confirmer." }),
      el("div", { class: "carnet-banner-actions" }, [
        confirmInput,
        confirmBtn,
        el("button", { type: "button", id: "btn-carnet-delete-cancel", class: "secondary", text: "Annuler" }),
      ]),
    ]);
    const undo = el("div", { id: "hq-carnet-undo", class: "carnet-banner carnet-undo", role: "status", "aria-live": "polite", hidden: true }, [
      el("p", { class: "carnet-banner-msg", text: MSG.trashed }),
      el("button", { type: "button", id: "btn-carnet-undo", class: "secondary", text: MSG.undo }),
    ]);

    // Compact context popover: project + category, 1–2 taps from the pill.
    const ctxPanel = el("div", { id: "hq-carnet-context", class: "carnet-context", role: "dialog", "aria-label": "Classement de la page", hidden: true });
    const ctxBackdrop = el("div", { class: "carnet-ctx-backdrop", "aria-hidden": "true", hidden: true });

    // Stage 04: one contenteditable surface (structured lines/marks) instead of a textarea. It
    // keeps native typing, IME and iOS selection; its content is only ever read back through the
    // strict parser in hq-carnet-rich.js and written with createElement/textContent.
    const editor = el("div", {
      id: "hq-carnet-editor",
      class: "carnet-editor",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": "Page du carnet",
      contenteditable: "true",
      spellcheck: "true",
      autocapitalize: "sentences",
      autocorrect: "on",
      "data-placeholder": "Commence à écrire… ou glisse une image",
    });
    installEditorShim(editor);
    const formatBar = buildFormatBar();
    const linkPanel = buildLinkPanel();
    const findPanel = buildFindPanel();
    const exportPanel = buildExportPanel();
    const imagePanel = buildImagePanel();
    const imageTools = buildImageTools();
    const paper = el("div", { class: "carnet-paper" }, [editor]);
    const stage = el("div", { class: "carnet-stage" }, [paper]);

    const prev = iconButton("btn-carnet-prev", "Page précédente (Alt+←)", ICON.prev);
    const next = iconButton("btn-carnet-next", "Page suivante (Alt+→)", ICON.next);
    const indicator = el("span", { id: "carnet-page-indicator", class: "carnet-indicator", "aria-live": "polite" });
    const add = iconButton("btn-carnet-new", "Nouvelle page", ICON.plus);
    const copy = iconButton("btn-carnet-copy", "Copier la sélection ou la page", ICON.copy);
    keepFocus(copy);
    const bottom = el("div", { class: "carnet-bar carnet-bar-bottom" }, [
      el("div", { class: "carnet-nav" }, [prev, indicator, next]),
      el("div", { class: "carnet-actions" }, [copy, add]),
    ]);
    const focusExit = iconButton("btn-carnet-focus-exit", "Quitter le mode concentration (Échap)", ICON.unfocus, { class: "carnet-btn carnet-focus-exit" });

    const insertRow = buildInsertRow();
    // 16H: « + Insérer » lives in the top bar (one calm row on PC, two on a phone) instead of on a row of its own.
    top.insertBefore(insertRow, top.children[1] || null);
    const main = el("div", { class: "carnet-main" }, [top, ctxBackdrop, ctxPanel, conflict, trashed, confirm, undo, tools, formatBar, linkPanel, findPanel, exportPanel, imagePanel, imageTools, stage, bottom, focusExit]);
    const lib = buildLibrary();
    const libBackdrop = el("div", { class: "carnet-lib-backdrop", "aria-hidden": "true", hidden: true });
    root.append(lib, libBackdrop, main);
    if (outN) root.appendChild(outN.panel);
    host.textContent = "";
    host.appendChild(root);

    ui.root = root;
    wireImageDrop(root);
    ui.editor = editor;
    ui.paper = paper;
    ui.statusEl = status;
    ui.flashEl = flash;
    ui.libEl = lib;
    ui.libBackdrop = libBackdrop;
    ui.ctxEl = ctxPanel;
    ui.ctxBackdrop = ctxBackdrop;
    ui.lib.sig = "";
    ui.lib.scopeSig = "";

    structUi(); // before the first render: the editor draws structured blocks through it
    bindEditor(editor);
    ui.eui = mountEditorUi();
    const fu = fieldUi();
    if (fu) {
      fu.mountHud(main);
      fu.recover(main);
    }
    prev.addEventListener("click", () => navigate(-1));
    next.addEventListener("click", () => navigate(1));
    add.addEventListener("click", () => newPage(null)); // global New: always "À classer"
    copy.addEventListener("click", copyAction);
    pin.addEventListener("click", () => {
      const c = ui.core;
      const e = c && c.current();
      if (!e || isReadOnly(e)) return;
      c.edit(e.id, { pinned: !e.local.pinned });
    });
    attention.addEventListener("click", () => {
      const c = ui.core;
      const first = c && c.status().attention[0];
      if (first) c.select(first); // shows that page's own conflict / orphan / error status
    });
    context.addEventListener("click", () => (ui.ctxOpen ? closeContext(true) : openContext()));
    ctxBackdrop.addEventListener("click", () => closeContext(false));
    ctxPanel.addEventListener("click", onContextClick);
    library.addEventListener("click", toggleLibrary);
    libBackdrop.addEventListener("click", () => closeLibrary(true));
    focusBtn.addEventListener("click", () => (ui.focus ? exitFocus() : enterFocus()));
    focusExit.addEventListener("click", exitFocus);
    more.addEventListener("click", () => {
      ui.toolsOpen = !ui.toolsOpen;
      tools.hidden = !ui.toolsOpen;
      more.setAttribute("aria-expanded", ui.toolsOpen ? "true" : "false");
    });
    tools.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      if (b.id === "btn-carnet-time") insertText(timeMarker(new Date()));
      else if (b.dataset.carnetSymbol) insertText(b.dataset.carnetSymbol);
      else if (b.hasAttribute("data-carnet-trash")) trashCurrent();
      else if (b.id === "btn-carnet-format") toggleFormatBar();
      else if (b.id === "btn-carnet-find") toggleFind();
      else if (b.id === "btn-carnet-cite") openCitePicker();
      else if (b.id === "btn-carnet-export") toggleExport();
      else if (b.id === "btn-carnet-templates") openTemplates({}, b);
      else if (b.id === "btn-carnet-image") toggleImagePanel();
      else if (b.id === "btn-carnet-eng") openEngMenu();
      else if (b.id === "btn-carnet-history") openHistory("history", b);
      else if (b.id === "btn-carnet-intel") openIntel("overview", b);
      else if (b.id === "btn-carnet-ask") openAsk(b);
      else if (b.id === "btn-carnet-reviews") openReviews(b);
      else if (b.id === "btn-carnet-verifications") openVerifications(b);
      else if (b.id === "btn-carnet-reasoning") openReasoning(b);
    });
    trashed.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button") : null;
      const cur = ui.core && ui.core.current();
      if (!b || !cur) return;
      if (b.hasAttribute("data-carnet-restore")) restore(cur.id);
      else if (b.hasAttribute("data-carnet-delete-permanent")) openDeleteConfirm(cur.id);
    });
    confirmInput.addEventListener("input", () => {
      confirmBtn.disabled = confirmInput.value.trim().toUpperCase() !== MSG.deleteWord;
    });
    confirmInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click();
    });
    confirmBtn.addEventListener("click", confirmDelete);
    confirm.querySelector("#btn-carnet-delete-cancel").addEventListener("click", closeDeleteConfirm);
    undo.querySelector("#btn-carnet-undo").addEventListener("click", undoTrash);
    conflict.querySelector("#btn-carnet-conflict-remote").addEventListener("click", () => {
      if (ui.core && ui.core.st.currentId) ui.core.loadRemote(ui.core.st.currentId);
    });
    conflict.querySelector("#btn-carnet-conflict-local").addEventListener("click", () => {
      if (ui.core && ui.core.st.currentId) ui.core.keepLocal(ui.core.st.currentId);
    });

    // Touch swipe: horizontal-dominant >= 60px only; vertical scroll and text selection never flip.
    stage.addEventListener("touchstart", (e) => {
      if (!e.touches || e.touches.length !== 1) {
        ui.swipe = null;
        return;
      }
      const t = e.touches[0];
      // Phase 3.5: a gesture that starts over a table, image, group, drawing or an open sheet belongs to that element (scroll / pan /
      // slider), never to the page flip.
      const over = e.target && e.target.closest ? e.target.closest(FLIP_EXCLUDE) : null;
      if (over) {
        ui.swipe = null;
        return;
      }
      ui.swipe = { x: t.clientX, y: t.clientY, t: Date.now(), multi: false, lock: 0, dx: 0, dy: 0, v: 0, lx: t.clientX, lt: Date.now() };
    }, { passive: true });
    // 16C: not passive, so that once the gesture is a horizontal page drag the page does not also scroll vertically. A gesture that
    // is not (yet) a page drag is never prevented, so scrolling, text selection and the iOS magnifier are untouched.
    stage.addEventListener("touchmove", (e) => {
      const s = ui.swipe;
      if (!s) return;
      if (e.touches && e.touches.length > 1) {
        s.multi = true;
        if (s.lock === 1) flipRelease(Object.assign(s, { dx: 0, v: 0 }));
        s.lock = -1;
        return;
      }
      const t = e.touches && e.touches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!s.lock) {
        if (Math.abs(dx) < FLIP_LOCK_PX && Math.abs(dy) < FLIP_LOCK_PX) return;
        const selecting = editor.selectionStart !== editor.selectionEnd;
        s.lock = Math.abs(dx) > SWIPE_RATIO * Math.abs(dy) && !selecting && Date.now() - s.t < FLIP_HOLD_MS ? 1 : -1;
        if (s.lock === 1) flipStop(ui.paper);
      }
      if (s.lock !== 1) return;
      if (e.cancelable) e.preventDefault();
      const now = Date.now();
      const step = Math.max(1, now - s.lt);
      s.v = s.v * 0.4 + ((t.clientX - s.lx) / step) * 0.6;
      s.lx = t.clientX;
      s.lt = now;
      s.dx = dx;
      s.dy = dy;
      flipFollow(s);
    }, { passive: false });
    stage.addEventListener("touchcancel", () => {
      const s = ui.swipe;
      ui.swipe = null;
      if (s && s.lock === 1) flipRelease(Object.assign(s, { dx: 0, v: 0 }));
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      const s = ui.swipe;
      ui.swipe = null;
      if (s && s.lock === 1) {
        flipRelease(s);
        return;
      }
      if (s && s.lock === -1) return; // decided early: a scroll, a selection or a multi-finger gesture, never a page turn
      if (!s || s.multi || !e.changedTouches || !e.changedTouches.length) return;
      if (Date.now() - s.t > SWIPE_MAX_MS) return; // long press = selection / caret placement
      if (editor.selectionStart !== editor.selectionEnd) return; // selecting text
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!isSwipe(dx, dy)) return;
      navigate(dx < 0 ? 1 : -1);
    }, { passive: true });

    bindTrackpadFlip(stage);
    bindMedia();
    ui.lib.open = false;
  }

  // ---------------------------------------------------------------- library (Bibliothèque)

  // ---- visible "+ Insérer" (UX pass): the primary way to add content; advanced tools stay behind "Plus" (…)

  // Recent commands: ids only, validated, at most RECENTS_MAX, kept in a tiny preference key (never note data, never the drafts store).
  // Written ONLY when a command is run; falls back to memory when the browser store is unavailable.
  const RECENTS_KEY = "hq_carnet_recent_cmds_v1";

  function recentsList() {
    const R = global.HqCarnetCommands;
    if (!R) return [];
    if (!ui.recents) {
      let raw = null;
      try {
        raw = JSON.parse(safeStorage().getItem(RECENTS_KEY) || "null");
      } catch (_) {
        raw = null;
      }
      ui.recents = R.sanitizeRecents(raw);
    }
    return ui.recents.slice();
  }

  function recentsNote(id) {
    const R = global.HqCarnetCommands;
    if (!R || !R.byId(id)) return;
    ui.recents = R.pushRecent(recentsList(), id);
    try {
      safeStorage().setItem(RECENTS_KEY, JSON.stringify(ui.recents));
    } catch (_) {
      // memory only: the menu still shows them for this page load
    }
  }

  /** ONE registry (hq-carnet-commands.js) feeds "+ Insérer", the "/" menu, the between-block "+" and the block menu. */
  function fillInsertMenu(menu) {
    const R = global.HqCarnetCommands;
    const M = global.HqCarnetEditorUi;
    menu.textContent = "";
    if (!R || !M) return;
    for (const g of R.catalog({ recents: recentsList() })) {
      const gid = "carnet-insert-g-" + g.id;
      const box = el("div", { class: "carnet-insert-group", role: "group", "aria-labelledby": gid }, [el("div", { id: gid, class: "carnet-cmd-group-label", text: g.label })]);
      for (const c of g.items) {
        const it = el("button", { type: "button", role: "menuitem", class: "carnet-insert-item", [g.id === "recent" ? "data-carnet-insert-recent" : "data-carnet-insert"]: c.id, tabindex: "-1" });
        it.appendChild(M.commandRow(doc, c, null));
        keepFocus(it);
        box.appendChild(it);
      }
      menu.appendChild(box);
    }
  }

  const INSERT_SEL = "[data-carnet-insert],[data-carnet-insert-recent]";

  function buildInsertRow() {
    const btn = el("button", {
      type: "button", id: "btn-carnet-insert", class: "carnet-small carnet-primary carnet-insert-btn",
      "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "hq-carnet-insert-menu",
    });
    btn.appendChild(el("span", { class: "carnet-insert-plus", "aria-hidden": "true", text: "+" }));
    btn.appendChild(el("span", { text: "Insérer" }));
    keepFocus(btn);
    const menu = el("div", { id: "hq-carnet-insert-menu", class: "carnet-insert-menu", role: "menu", "aria-label": "Insérer", hidden: true });
    fillInsertMenu(menu);
    const row = el("div", { class: "carnet-insert-row" }, [btn, menu]);
    const items = () => Array.prototype.slice.call(menu.querySelectorAll(INSERT_SEL));
    const close = (refocus) => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (refocus) btn.focus({ preventScroll: true });
    };
    const open = () => {
      if (!curEntry()) {
        flashMsg(IMG_MSG.readonly);
        return;
      }
      const sel = currentSel(); // the caret BEFORE the menu takes focus: new content goes there
      ui.selCache = { start: sel.start, end: sel.end };
      fillInsertMenu(menu); // recents may have changed since the last time
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      const first = items()[0];
      if (first) first.focus({ preventScroll: true });
    };
    btn.addEventListener("click", () => (menu.hidden ? open() : close(true)));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && menu.hidden) {
        e.preventDefault();
        open();
      }
    });
    menu.addEventListener("keydown", (e) => {
      const list = items();
      const at = list.indexOf(doc.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next].focus({ preventScroll: true });
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        list[e.key === "Home" ? 0 : list.length - 1].focus({ preventScroll: true });
      } else if (e.key === "Tab") close(false);
    });
    menu.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest(INSERT_SEL) : null;
      if (!b) return;
      const key = b.getAttribute("data-carnet-insert") || b.getAttribute("data-carnet-insert-recent");
      close(false);
      runInsert(key);
    });
    doc.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !row.contains(e.target)) close(false);
      if (ui.eui) ui.eui.onPointerDown(e); // the editor's floating menus dismiss on an outside press (same single listener)
    });
    return row;
  }

  /** The single insertion path: every menu (Insérer, "/", "+", block menu) ends here. */
  function runInsert(key) {
    if (!curEntry()) return flashMsg(IMG_MSG.readonly);
    const R = global.HqCarnetCommands;
    const cmd = R ? R.byId(key) : null;
    if (cmd) recentsNote(key); // every menu ends here: the recents list is fed from the single path
    if (cmd && cmd.kind === "block") return runBlockCommand(cmd);
    if (key === "cite") return openCitePicker();
    if (key === "time") return insertText(timeMarker(new Date()));
    if (key === "image") return pickImage("photos", null);
    if (key === "camera") return pickImage("camera", null);
    if (key === "table" || key === "callout" || key === "toggle" || key === "imagegroup") return structInsert(key);
    if (key === "portal") return portalInsert();
    if (key === "sketch") return dessinerNew();
    if (key === "scan" || key === "voice" || key === "ocr") return fieldRun(key);
    const eu = engUi();
    if (!eu) return;
    if (key === "file" || key === "drawing") return eu.openTool("link", key);
    eu.openTool(key); // measure / calc / decision / task
  }

  /** Re-type the caret's text block to the command's type (never an atom; never toggles back to a paragraph). */
  function runBlockCommand(cmd) {
    const R = global.HqCarnetCommands;
    const sel = currentSel();
    const at = Rich.locate(sel.lines, sel.start);
    const res = R.convert(Rich, sel.lines, at.line, cmd.type);
    if (res.error) return flashMsg("Ce bloc ne peut pas être converti");
    if (commitLines(res.lines, { start: sel.start, end: sel.start }) && doc.activeElement !== ui.editor) focusEditor(false);
  }


  // ---- editor UI host (selection toolbar, "/" menu, block rail): thin adapters over the normal edit path
  function mountEditorUi() {
    const M = global.HqCarnetEditorUi;
    const R = global.HqCarnetCommands;
    const I = global.HqCarnetImageUi;
    if (!M || !R) return null;
    const host = {
      doc, win: global, root: ui.root, rich: Rich, commands: R,
      editor: () => ui.editor,
      fine: finePointer,
      state: () => {
        const e = curEntry();
        return e ? { pageId: e.id, rev: e.serverRev, gen: e.generation } : null;
      },
      sel: readSel,
      setSel,
      lines: () => Rich.parseEditor(ui.editor),
      focusEditor: () => focusEditor(false),
      insertText,
      commit: (lines, sel) => commitLines(lines, sel),
      status: (t, isErr) => flashMsg(t, isErr),
      format: (kind) => applyFormat(kind),
      cite: () => openCitePicker(),
      command: (id) => runInsert(id),
      recents: recentsList,
      noteRecent: recentsNote,
      isOn: (kind, sel) => {
        if (Rich.INLINE.indexOf(kind) >= 0) return Rich.hasMark(sel.lines, sel.start, sel.end, kind);
        return false;
      },
      clearFormat: (start, end) => {
        let lines = Rich.cloneLines(Rich.parseEditor(ui.editor));
        for (const t of Rich.INLINE) lines = Rich.setMark(lines, start, end, t, false);
        const unlinked = Rich.setLink(lines, start, end, null);
        if (unlinked) lines = unlinked;
        commitLines(lines, { start, end });
      },
      dragging: () => false,
      copyBlockLink: (index) => copyBlockLink(index),
      suggest: (prev) => {
        const N = nav();
        return N ? N.suggestFor(prev) : [];
      },
      annotate: (index) => dessinerAnnotateAt(index),
      offerUndo: (label, before) => offerBlockUndo(label, before),
    };
    const api = M.mount(host);
    if (I && typeof I.mount === "function") {
      const dm = I.mount(api.dragHost());
      host.bindMove = dm.bindMove;
      host.dragging = dm.active;
      api.drag = dm;
    }
    // 16C: long-press on a block (touch) opens that block's menu (hq-carnet-motion.js calls this; nothing else does).
    global.hqCarnetBlockMenu = (line) => !!(api && typeof api.openBlockMenuForLine === "function" && api.openBlockMenuForLine(line));
    return api;
  }

  function buildLibrary() {
    const aside = el("aside", { id: "hq-carnet-library", class: "carnet-library", "aria-label": "Bibliothèque", hidden: true });
    // Structure (not font size) keeps the header from colliding: the title (+ close) owns row 1, the actions own row 2.
    const head = el("div", { class: "carnet-lib-head" }, [
      el("h3", { class: "carnet-lib-title", text: "Bibliothèque" }),
      iconButton("btn-carnet-lib-close", "Fermer la bibliothèque", ICON.close, { class: "carnet-btn carnet-lib-close" }),
      el("div", { class: "carnet-lib-actions" }, [
        el("button", { type: "button", id: "btn-carnet-lib-new", class: "carnet-small carnet-primary", text: "+ Nouvelle page" }),
        el("button", { type: "button", id: "btn-carnet-lib-templates", class: "carnet-small carnet-quiet", "aria-haspopup": "dialog", text: "Modèles" }),
      ]),
    ]);
    // 16F: the four tools live in one quiet footer (pinned to the bottom of the panel) instead of crowding the header.
    const toolBtn = (id, label, text, icon, popup) => {
      const b = el("button", { type: "button", id, class: "carnet-small carnet-quiet carnet-lib-tool", "aria-label": label, title: label, "aria-haspopup": popup ? "dialog" : null });
      b.appendChild(svgIcon(icon));
      b.appendChild(el("span", { text }));
      return b;
    };
    const tools = el("div", { class: "carnet-lib-tools", role: "group", "aria-label": "Outils" }, [
      el("span", { class: "carnet-lib-label", "aria-hidden": "true", text: "Outils" }),
      el("div", { class: "carnet-lib-tools-grid" }, [
        toolBtn("btn-carnet-lib-bulk", "Opérations groupées sur les pages affichées", "Opérations", LIB_ICON.bulk, false),
        toolBtn("btn-carnet-lib-intel", "Cockpit du projet : décisions, mesures, changements et jalons", "Cockpit", LIB_ICON.cockpit, true),
        toolBtn("btn-carnet-lib-ask", "Preuves du carnet : retrouver les passages qui répondent à une question", "Preuves", LIB_ICON.ask, true),
        toolBtn("btn-carnet-lib-reviews", "Revues : dossiers de preuves à relire", "Revues", LIB_ICON.reviews, true),
      ]),
    ]);
    const search = el("input", {
      type: "search", id: "hq-carnet-search", class: "carnet-input carnet-search", placeholder: "Rechercher…",
      "aria-label": "Rechercher dans le carnet", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
    });
    const filters = el("div", { class: "carnet-filters", role: "group", "aria-label": "Filtres" });
    for (const [key, label] of FILTERS.concat([["trash", "Corbeille"]])) {
      if (key === "trash") filters.appendChild(el("span", { class: "carnet-filter-sep", role: "separator", "aria-orientation": "horizontal" }));
      filters.appendChild(el("button", { type: "button", class: "carnet-chip" + (key === "trash" ? " carnet-chip-trash" : ""), "data-carnet-filter": key, "aria-pressed": "false" }, [
        svgIcon(LIB_ICON[key] || LIB_ICON.all),
        el("span", { class: "carnet-chip-name", text: label }),
        el("span", { class: "carnet-count", "data-carnet-fcount": key, text: "" }),
      ]));
    }
    const scopes = el("div", { class: "carnet-lib-scopes" });
    const list = el("div", { id: "carnet-library-list", class: "carnet-lib-list", role: "list", "aria-label": "Pages" });
    const scopeLabel = el("p", { class: "carnet-lib-scope", "aria-live": "polite" });
    aside.append(head, search, filters, scopes, scopeLabel, list, tools);

    search.addEventListener("input", () => {
      ui.lib.query = search.value;
      scheduleLibrary(60);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // The click below moves focus to the editor during this keydown; without this the same Enter would then be
        // delivered to the editor and insert a newline (an autosaved, unintended edit of the opened note).
        e.preventDefault();
        const first = list.querySelector("[data-carnet-page-id]");
        if (first) first.click();
      }
    });
    aside.addEventListener("click", onLibraryClick);
    aside.addEventListener("submit", (e) => e.preventDefault());
    return aside;
  }

  function mq(q) {
    try {
      return global.matchMedia(q).matches;
    } catch (_) {
      return false;
    }
  }

  // Responsive library modes (capability-aware, no UA sniffing):
  // - dock   : persistent collapsible sidebar. Any width >= 1100px, OR a desktop-usable width
  //            (>= 1000px) whose primary input is a fine hover-capable pointer (a 1024x768
  //            Windows browser is a desktop workspace, not a tablet).
  // - drawer : 600–1099px touch/coarse (e.g. iPad portrait, even ~1024px) and narrow desktops.
  // - sheet  : phones (< 600px).
  const MQ_WIDE = "(min-width: 1100px)";
  const MQ_DESK = "(min-width: 1000px) and (hover: hover) and (pointer: fine)";
  const MQ_TABLET = "(min-width: 600px)";
  function libMode() {
    if (mq(MQ_WIDE) || mq(MQ_DESK)) return "dock";
    if (mq(MQ_TABLET)) return "drawer";
    return "sheet";
  }

  function libVisible() {
    if (ui.focus) return false;
    return libMode() === "dock" ? !ui.lib.collapsed : ui.lib.open;
  }

  function bindMedia() {
    if (ui.mqBound || typeof global.matchMedia !== "function") return;
    ui.mqBound = true;
    for (const q of [MQ_WIDE, MQ_DESK, MQ_TABLET]) {
      let m = null;
      try {
        m = global.matchMedia(q);
      } catch (_) {
        m = null;
      }
      if (!m) continue;
      const fn = () => {
        ui.lib.open = false; // never let an overlay appear by itself after a resize/rotation
        layoutLibrary();
      };
      if (m.addEventListener) m.addEventListener("change", fn);
      else if (m.addListener) m.addListener(fn);
    }
  }

  function layoutLibrary() {
    if (!ui.root || !ui.libEl) return;
    const mode = libMode();
    const vis = libVisible();
    const wasHidden = ui.libEl.hidden;
    ui.libEl.hidden = !vis;
    ui.libEl.dataset.mode = mode;
    ui.root.classList.toggle("lib-dock", vis && mode === "dock");
    ui.root.classList.toggle("lib-overlay", vis && mode !== "dock");
    ui.libBackdrop.hidden = !(vis && mode !== "dock");
    // Overlay (phone sheet / tablet drawer) = modal dialog: the paper behind it is inert and
    // Tab stays inside (see trapTab). The docked desktop sidebar is never modal.
    const modal = mode !== "dock" && vis;
    if (modal) {
      ui.libEl.setAttribute("role", "dialog");
      ui.libEl.setAttribute("aria-modal", "true");
    } else {
      ui.libEl.removeAttribute("role");
      ui.libEl.removeAttribute("aria-modal");
    }
    const main = ui.root.querySelector(".carnet-main");
    if (main) {
      main.inert = modal;
      if (modal) main.setAttribute("aria-hidden", "true");
      else main.removeAttribute("aria-hidden");
    }
    const btn = doc.getElementById("btn-carnet-library");
    if (btn) btn.setAttribute("aria-expanded", vis ? "true" : "false");
    if (vis && wasHidden) {
      ui.lib.sig = "";
      ui.lib.scopeSig = "";
      renderLibrary();
    }
  }

  function openLibrary() {
    if (ui.focus) exitFocus();
    closeContext(false);
    if (libMode() === "dock") ui.lib.collapsed = false;
    else ui.lib.open = true;
    layoutLibrary();
    const s = doc.getElementById("hq-carnet-search");
    if (finePointer() && s) {
      try {
        s.focus({ preventScroll: true });
      } catch (_) {}
    } else if (libMode() !== "dock") {
      const x = doc.getElementById("btn-carnet-lib-close");
      if (x) x.focus({ preventScroll: true });
    }
  }

  function closeLibrary(returnFocus) {
    if (libMode() === "dock") ui.lib.collapsed = true;
    else ui.lib.open = false;
    layoutLibrary();
    if (returnFocus) {
      const b = doc.getElementById("btn-carnet-library");
      if (b) b.focus({ preventScroll: true });
    }
  }

  function toggleLibrary() {
    if (libVisible()) closeLibrary(false);
    else openLibrary();
  }

  function scheduleLibrary(ms) {
    if (!ui.libEl || ui.libEl.hidden) return;
    if (ui.lib.timer) return;
    ui.lib.timer = setTimeout(() => {
      ui.lib.timer = null;
      renderLibrary();
    }, ms == null ? 60 : ms);
  }

  function nameOf(list, id) {
    const x = list.find((i) => i && i.id === id);
    return x && typeof x.name === "string" ? x.name : "";
  }

  function scopeCreateContext() {
    const c = ui.core;
    const s = ui.lib.sel;
    if (!c) return null;
    if (s.filter === "project") {
      const p = c.st.projects.find((x) => x && x.id === s.id);
      return p && !p.archived ? { project_id: p.id } : null;
    }
    if (s.filter === "category" && c.st.categories.some((x) => x && x.id === s.id)) return { category_id: s.id };
    return null;
  }

  function renderLibrary() {
    const c = ui.core;
    const lib = ui.libEl;
    if (!c || !lib || lib.hidden) return;
    const s = ui.lib.sel;
    // selection may point to a project/category deleted elsewhere
    if (s.filter === "project" && !c.st.projects.some((x) => x && x.id === s.id)) ui.lib.sel = { filter: "all", id: null };
    if (s.filter === "category" && !c.st.categories.some((x) => x && x.id === s.id)) ui.lib.sel = { filter: "all", id: null };
    const sel = ui.lib.sel;
    for (const b of lib.querySelectorAll("[data-carnet-filter]")) {
      b.setAttribute("aria-pressed", b.dataset.carnetFilter === sel.filter ? "true" : "false");
    }
    const search = doc.getElementById("hq-carnet-search");
    if (search && search.value !== ui.lib.query && doc.activeElement !== search) search.value = ui.lib.query;
    const newBtn = doc.getElementById("btn-carnet-lib-new");
    const inherit = scopeCreateContext();
    newBtn.textContent = inherit ? "+ Nouvelle page ici" : "+ Nouvelle page";
    newBtn.hidden = sel.filter === "trash";
    const tplBtn = doc.getElementById("btn-carnet-lib-templates");
    if (tplBtn) tplBtn.hidden = sel.filter === "trash";
    const items = c.libraryItems();
    renderFilterCounts(items);
    renderScopes(items);
    const label = lib.querySelector(".carnet-lib-scope");
    let scopeText = "";
    if (sel.filter === "project") scopeText = "Projet : " + nameOf(c.st.projects, sel.id);
    else if (sel.filter === "category") scopeText = "Catégorie : " + nameOf(c.st.categories, sel.id);
    label.textContent = scopeText;
    label.hidden = !scopeText;
    renderList(items);
  }

  /** Derived counts beside the filters (one pass; nothing stored). */
  function renderFilterCounts(items) {
    const n = { all: 0, pinned: 0, unfiled: 0, decisions: 0, trash: 0, recent: 0 };
    for (const it of items) {
      if (it.deleted) {
        n.trash += 1;
        continue;
      }
      n.all += 1;
      if (it.pinned) n.pinned += 1;
      if (!it.project_id && !it.category_id) n.unfiled += 1;
      if (it.hasDecision) n.decisions += 1;
    }
    n.recent = selectPages(items, { filter: "recent" }, Date.now()).groups.reduce((a, g) => a + g.items.length, 0);
    for (const node of ui.libEl.querySelectorAll("[data-carnet-fcount]")) {
      const v = String(n[node.getAttribute("data-carnet-fcount")] || 0);
      if (node.textContent !== v) node.textContent = v;
    }
  }

  function countBy(items, key) {
    const m = new Map();
    for (const it of items) if (!it.deleted && it[key]) m.set(it[key], (m.get(it[key]) || 0) + 1);
    return m;
  }

  function renderScopes(items) {
    const c = ui.core;
    const box = ui.libEl.querySelector(".carnet-lib-scopes");
    const sel = ui.lib.sel;
    const pc = countBy(items, "project_id");
    const cc = countBy(items, "category_id");
    const sig = JSON.stringify([c.st.projects, c.st.categories, sel, ui.lib.manage, ui.lib.fold, [...pc], [...cc]]);
    if (sig === ui.lib.scopeSig) return;
    if (box.contains(doc.activeElement) && doc.activeElement.tagName !== "BUTTON") return; // never rebuild under typing
    ui.lib.scopeSig = sig;
    box.textContent = "";
    const manage = ui.lib.manage;
    const active = c.st.projects.filter((p) => isObj(p) && !p.archived);
    const archived = c.st.projects.filter((p) => isObj(p) && p.archived);

    // Collapsing is a view preference kept in memory for this page only (never in the draft store, never persisted).
    // A section that holds the active filter keeps showing that one chip, so the filter state stays visible.
    const foldP = ui.lib.fold.projects && !manage;
    const foldC = ui.lib.fold.categories && !manage;
    const projHead = el("div", { class: "carnet-lib-sec-head" }, [
      foldButton("projects", "Projets", active.length, foldP),
      el("button", { type: "button", class: "carnet-small carnet-quiet", "data-carnet-act": "manage", "aria-pressed": manage ? "true" : "false", text: manage ? "Terminé" : "Gérer" }),
    ]);
    const projList = el("div", { class: "carnet-chips", id: "carnet-sec-projects", hidden: false });
    for (const p of active) if (!foldP || (sel.filter === "project" && sel.id === p.id)) projList.appendChild(scopeChip("project", p, pc.get(p.id) || 0, sel));
    if (!active.length && !manage) projList.appendChild(el("p", { class: "hint carnet-empty", text: "Aucun projet" }));
    box.append(projHead, projList);
    if (manage) {
      for (const p of active.concat(archived)) box.appendChild(projectRow(p));
      box.appendChild(createForm("project"));
    }
    if (archived.length) {
      const det = el("details", { class: "carnet-archived" }, [el("summary", { text: "Projets archivés (" + archived.length + ")" })]);
      if (sel.filter === "project" && archived.some((p) => p.id === sel.id)) det.open = true;
      const al = el("div", { class: "carnet-chips" });
      for (const p of archived) al.appendChild(scopeChip("project", p, pc.get(p.id) || 0, sel));
      det.appendChild(al);
      box.appendChild(det);
    }

    const catHead = el("div", { class: "carnet-lib-sec-head" }, [foldButton("categories", "Catégories", c.st.categories.filter(isObj).length, foldC)]);
    const catList = el("div", { class: "carnet-chips", id: "carnet-sec-categories" });
    for (const k of c.st.categories.filter(isObj)) if (!foldC || (sel.filter === "category" && sel.id === k.id)) catList.appendChild(scopeChip("category", k, cc.get(k.id) || 0, sel));
    if (!c.st.categories.length && !manage) catList.appendChild(el("p", { class: "hint carnet-empty", text: "Aucune catégorie" }));
    box.append(catHead, catList);
    if (manage) {
      for (const k of c.st.categories.filter(isObj)) box.appendChild(categoryRow(k));
      box.appendChild(createForm("category"));
    }
  }

  function foldButton(key, label, n, folded) {
    const b = el("button", { type: "button", class: "carnet-fold", "data-carnet-fold": key, "aria-expanded": folded ? "false" : "true", "aria-controls": "carnet-sec-" + key });
    b.appendChild(el("span", { class: "carnet-fold-chev", "aria-hidden": "true", text: folded ? "▸" : "▾" }));
    b.appendChild(el("span", { class: "carnet-fold-name", text: label }));
    b.appendChild(el("span", { class: "carnet-count", text: String(n) }));
    return el("h4", { class: "carnet-fold-h" }, [b]);
  }

  function scopeChip(kind, item, count, sel) {
    const attrs = { type: "button", class: "carnet-chip carnet-scope", "aria-pressed": sel.filter === kind && sel.id === item.id ? "true" : "false" };
    attrs["data-carnet-" + kind] = item.id;
    const b = el("button", attrs);
    if (kind === "category") b.appendChild(el("span", { class: "carnet-dot", "data-color": COLORS[item.color] ? item.color : "graphite", "aria-hidden": "true" }));
    b.appendChild(el("span", { class: "carnet-chip-name", text: String(item.name || "") }));
    b.appendChild(el("span", { class: "carnet-count", text: String(count) }));
    return b;
  }

  function colorSelect(value) {
    const s = el("select", { class: "carnet-input carnet-color", "aria-label": "Couleur" });
    for (const k of Object.keys(COLORS)) {
      const o = el("option", { value: k, text: COLORS[k] });
      if (k === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  function projectRow(p) {
    const name = el("input", { type: "text", class: "carnet-input", value: String(p.name || ""), maxlength: "60", "aria-label": "Nom du projet" });
    name.value = String(p.name || "");
    return el("div", { class: "carnet-manage-row", "data-row-kind": "project", "data-row-id": p.id }, [
      name,
      el("button", { type: "button", class: "carnet-small", "data-carnet-act": "project-rename", text: "Renommer" }),
      el("button", { type: "button", class: "carnet-small", "data-carnet-act": "project-archive", text: p.archived ? "Désarchiver" : "Archiver" }),
    ]);
  }

  function categoryRow(k) {
    const name = el("input", { type: "text", class: "carnet-input", maxlength: "40", "aria-label": "Nom de la catégorie" });
    name.value = String(k.name || "");
    const row = el("div", { class: "carnet-manage-row", "data-row-kind": "category", "data-row-id": k.id }, [
      name,
      colorSelect(k.color),
      el("button", { type: "button", class: "carnet-small", "data-carnet-act": "category-save", text: "Enregistrer" }),
      el("button", { type: "button", class: "carnet-small carnet-danger-text", "data-carnet-act": "category-delete", text: "Supprimer" }),
    ]);
    return row;
  }

  function createForm(kind) {
    const input = el("input", {
      type: "text", class: "carnet-input", maxlength: kind === "project" ? "60" : "40",
      placeholder: kind === "project" ? "Nouveau projet" : "Nouvelle catégorie",
      "aria-label": kind === "project" ? "Nom du nouveau projet" : "Nom de la nouvelle catégorie",
    });
    const kids = [input];
    if (kind === "category") kids.push(colorSelect("blue"));
    kids.push(el("button", { type: "button", class: "carnet-small", "data-carnet-act": kind + "-create", text: "Ajouter" }));
    const form = el("div", { class: "carnet-manage-row carnet-create", "data-row-kind": kind }, kids);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") form.querySelector("[data-carnet-act]").click();
    });
    return form;
  }

  function fmtClock(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function fmtShort(ts) {
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
    const d = new Date(ts * 1000);
    const b = recencyBucket(ts, Date.now());
    if (b === "today") return fmtClock(d);
    if (b === "yesterday") return "Hier " + fmtClock(d);
    try {
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return new Intl.DateTimeFormat("fr-FR", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  function card(it, current, trash) {
    const main = el("button", { type: "button", class: "carnet-card-main", "data-carnet-page-id": it.id, "aria-current": current ? "true" : null });
    const top = el("span", { class: "carnet-card-top" }, [el("span", { class: "carnet-card-title", text: it.title, title: it.title })]);
    if (it.pinned) {
      const pinMark = el("span", { class: "carnet-card-pin", title: "Épinglée" });
      pinMark.appendChild(svgIcon(ICON.pin));
      pinMark.appendChild(el("span", { class: "visually-hidden", text: "Épinglée" }));
      top.appendChild(pinMark);
    }
    main.appendChild(top);
    if (it.preview) main.appendChild(el("span", { class: "carnet-card-preview", text: it.preview }));
    const ctx = [it.project, it.category].filter(Boolean).join(" · ") || MSG.unfiled;
    const when = trash ? fmtShort(it.deleted_at) : fmtShort(it.updated);
    const meta = el("span", { class: "carnet-card-meta" });
    if (it.color) meta.appendChild(el("span", { class: "carnet-dot", "data-color": COLORS[it.color] ? it.color : "graphite", "aria-hidden": "true" }));
    meta.appendChild(el("span", { class: "carnet-card-ctx", text: ctx }));
    if (when) meta.appendChild(el("span", { class: "carnet-card-when", text: (trash ? "Supprimée " : "") + when }));
    if (it.conflict) meta.appendChild(el("span", { class: "carnet-card-flag", text: "Conflit" }));
    else if (it.dirty) meta.appendChild(el("span", { class: "carnet-card-flag", text: "Non enregistrée" }));
    main.appendChild(meta);
    const box = el("div", { class: "carnet-card" + (current ? " is-current" : ""), role: "listitem" }, [main]);
    if (trash) {
      box.appendChild(el("div", { class: "carnet-card-actions" }, [
        el("button", { type: "button", class: "carnet-small", "data-carnet-restore": it.id, text: MSG.restore }),
        el("button", { type: "button", class: "carnet-small carnet-danger-text", "data-carnet-delete-permanent": it.id, text: MSG.deletePermanent + "…" }),
      ]));
    }
    return box;
  }

  function renderList(items) {
    const c = ui.core;
    const list = doc.getElementById("carnet-library-list");
    const sel = Object.assign({}, ui.lib.sel, { query: ui.lib.query });
    const result = selectPages(items, sel, Date.now());
    const trash = sel.filter === "trash";
    const cur = c.st.currentId;
    const sig = JSON.stringify([trash, cur, result.groups.map((g) => [g.label, g.items.map((i) =>
      [i.id, i.title, i.preview, i.pinned, i.project, i.category, i.color, i.conflict, i.dirty, Math.floor((trash ? i.deleted_at : i.updated) / 60)])])]);
    if (sig === ui.lib.sig) return;
    ui.lib.sig = sig;
    const focusedId = list.contains(doc.activeElement) && doc.activeElement.dataset ? doc.activeElement.dataset.carnetPageId : null;
    list.textContent = "";
    let count = 0;
    for (const g of result.groups) {
      if (g.label) list.appendChild(el("h4", { class: "carnet-lib-group", role: "presentation", text: g.label }));
      for (const it of g.items) {
        list.appendChild(card(it, it.id === cur, trash));
        count += 1;
      }
    }
    if (!count) {
      list.appendChild(el("p", { class: "hint carnet-empty", text: result.searching ? MSG.noResults : trash ? "Corbeille vide" : MSG.noPages }));
      const more = result.searching ? "Essaie un autre mot, ou vide la recherche." : trash ? "Les pages supprimées apparaissent ici ; tu peux les restaurer." : sel.filter === "all" ? "Crée ta première page avec + Nouvelle page." : "Choisis « Toutes » pour voir toutes les pages.";
      list.appendChild(el("p", { class: "hint carnet-empty-hint", text: more }));
    }
    if (focusedId) {
      const again = list.querySelector('[data-carnet-page-id="' + (global.CSS && CSS.escape ? CSS.escape(focusedId) : focusedId) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  function rowName(row) {
    const i = row && row.querySelector("input");
    return i ? i.value : "";
  }

  async function libAction(fn, okMsg) {
    try {
      await fn();
      if (okMsg) flashMsg(okMsg);
    } catch (err) {
      flashMsg(ui.core ? ui.core.userMessage(err) : typedFallback(err));
    }
    ui.lib.scopeSig = "";
    ui.lib.sig = "";
    render();
    renderLibrary();
  }

  function onLibraryClick(e) {
    const c = ui.core;
    const b = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!c || !b || !ui.libEl.contains(b)) return;
    if (b.id === "btn-carnet-lib-close") return closeLibrary(true);
    if (b.id === "btn-carnet-lib-new") return newPage(scopeCreateContext() || {});
    if (b.id === "btn-carnet-lib-templates") return openTemplates(scopeCreateContext() || {}, b);
    if (b.id === "btn-carnet-lib-bulk") return openHistory("bulk", b);
    if (b.id === "btn-carnet-lib-ask") {
      const opener = libMode() === "dock" ? b : doc.getElementById("btn-carnet-library");
      if (libMode() !== "dock") closeLibrary(false);
      return openAsk(opener);
    }
    if (b.id === "btn-carnet-lib-reviews") {
      const opener = libMode() === "dock" ? b : doc.getElementById("btn-carnet-library");
      if (libMode() !== "dock") closeLibrary(false);
      return openReviews(opener);
    }
    if (b.id === "btn-carnet-lib-intel") {
      // The sheet/drawer library sits above the cockpit (z-index) and would swallow its taps: close it, focus returns to the Bibliothèque button.
      const opener = libMode() === "dock" ? b : doc.getElementById("btn-carnet-library");
      if (libMode() !== "dock") closeLibrary(false);
      return openIntel("overview", opener);
    }
    if (b.dataset.carnetFold) {
      const k = b.dataset.carnetFold;
      if (k === "projects" || k === "categories") {
        ui.lib.fold[k] = !ui.lib.fold[k];
        ui.lib.scopeSig = "";
        renderLibrary();
        const again = ui.libEl.querySelector('[data-carnet-fold="' + k + '"]');
        if (again) again.focus({ preventScroll: true });
      }
      return;
    }
    if (b.dataset.carnetFilter) {
      ui.lib.sel = { filter: b.dataset.carnetFilter, id: null };
      return renderLibrary();
    }
    if (b.hasAttribute("data-carnet-project") || b.hasAttribute("data-carnet-category")) {
      const kind = b.hasAttribute("data-carnet-project") ? "project" : "category";
      const id = b.getAttribute("data-carnet-" + kind);
      const same = ui.lib.sel.filter === kind && ui.lib.sel.id === id;
      ui.lib.sel = same ? { filter: "all", id: null } : { filter: kind, id };
      return renderLibrary();
    }
    if (b.hasAttribute("data-carnet-restore")) return restore(b.getAttribute("data-carnet-restore"));
    if (b.hasAttribute("data-carnet-delete-permanent")) {
      const id = b.getAttribute("data-carnet-delete-permanent");
      openPage(id);
      return openDeleteConfirm(id);
    }
    if (b.dataset.carnetPageId) return openPage(b.dataset.carnetPageId);
    const act = b.dataset.carnetAct;
    if (!act) return;
    const row = b.closest(".carnet-manage-row");
    const id = row && row.dataset.rowId;
    if (act === "manage") {
      ui.lib.manage = !ui.lib.manage;
      ui.lib.scopeSig = "";
      return renderLibrary();
    }
    if (act === "project-create") {
      const name = rowName(row);
      if (!name.trim()) return flashMsg("Nom du projet requis");
      return libAction(() => c.createProject(name), "Projet créé");
    }
    if (act === "project-rename") return libAction(() => c.renameProject(id, rowName(row)), "Projet renommé");
    if (act === "project-archive") {
      const p = c.st.projects.find((x) => x && x.id === id);
      return libAction(() => c.archiveProject(id, !(p && p.archived)), p && p.archived ? "Projet désarchivé" : "Projet archivé");
    }
    if (act === "category-create") {
      const name = rowName(row);
      if (!name.trim()) return flashMsg("Nom de la catégorie requis");
      return libAction(() => c.createCategory(name, row.querySelector("select").value), "Catégorie créée");
    }
    if (act === "category-save") {
      return libAction(() => c.updateCategory(id, { name: rowName(row), color: row.querySelector("select").value }), "Catégorie enregistrée");
    }
    if (act === "category-delete") {
      if (b.dataset.armed !== "1") {
        // Two explicit clicks: the pages keep their text but lose this category.
        b.dataset.armed = "1";
        b.textContent = "Confirmer la suppression";
        return undefined;
      }
      return libAction(() => c.deleteCategory(id), "Catégorie supprimée");
    }
    return undefined;
  }

  /** Open a page in THE editor (same state machine on every device). */
  function openPage(id) {
    const c = ui.core;
    if (!c || !c.entry(id)) return;
    closeDeleteConfirm();
    if (c.st.currentId !== id) c.select(id);
    else showCurrent();
    if (libMode() !== "dock") closeLibrary(false);
    render();
    if (finePointer()) focusEditor(false);
  }

  async function newPage(ctx) {
    const c = ui.core;
    if (!c) return null;
    const id = await c.createPage(ctx || null);
    if (id) {
      if (libMode() !== "dock" && libVisible()) closeLibrary(false);
      focusEditor(true);
    }
    return id;
  }

  // ---------------------------------------------------------------- templates (product phase 1)

  const TPL_MSG = {
    unavailable: "Modèles indisponibles",
    invalid: "Modèle invalide : aucune page créée",
    stale: "Le carnet a changé : modèle non appliqué, rien n'a été créé",
  };

  /**
   * A template page: ordinary lines built by the pure template module, sent in ONE page_create (born with its content, server-validated).
   * Any failure (invalid template, limits, offline, stale notebook) creates nothing and leaves the page list untouched.
   */
  async function newPageFromTemplate(id, ctx) {
    const c = ui.core;
    const T = global.HqCarnetTemplates;
    if (!c || !T) return flashMsg(TPL_MSG.unavailable, true), null;
    const built = T.build(Rich, id, new Date());
    if (built.error) return flashMsg(TPL_MSG.invalid, true), null;
    const content = Rich.wireContent(built.lines, null, null);
    c.st.notice = "";
    // One request_id per (template, scope, content): pressing the same template again after an uncertain failure re-sends it, and the
    // server answers with the page it already created instead of making a second one.
    const key = JSON.stringify([id, ctx || {}, content]);
    if (!ui.tplAttempt || ui.tplAttempt.key !== key) ui.tplAttempt = { key, requestId: "tpl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) };
    const pageId = await c.createPage(Object.assign({}, ctx || {}, { content, requestId: ui.tplAttempt.requestId }));
    if (!pageId) {
      if (c.st.lastCode === "request_result_gone") ui.tplAttempt = null; // created then deleted elsewhere: the next click is a new, explicit attempt
      flashMsg(c.st.notice || TPL_MSG.stale, true);
      return null;
    }
    ui.tplAttempt = null;
    if (libMode() !== "dock" && libVisible()) closeLibrary(false);
    openPage(pageId);
    // the caret goes to the first fill-in line (the first empty one after the title), ready to type
    const lines = Rich.parseEditor(ui.editor);
    const at = lines.findIndex((l, i) => i > 0 && !l.text);
    const starts = Rich.lineStarts(lines);
    focusEditor(false);
    const pos = at >= 0 ? starts[at] : starts[starts.length - 1] + lines[lines.length - 1].text.length;
    setSel(pos, pos);
    return pageId;
  }

  function closeTemplates(refocus) {
    const T = ui.tpl;
    if (!T || !T.open) return;
    T.open = false;
    T.box.hidden = true;
    T.back.hidden = true;
    const from = T.from;
    T.from = null;
    if (refocus && from && from.isConnected) from.focus({ preventScroll: true });
  }

  function openTemplates(ctx, from) {
    const c = ui.core;
    const Tm = global.HqCarnetTemplates;
    if (!c || !Tm || !ui.root) return flashMsg(TPL_MSG.unavailable, true);
    if (!ui.tpl) {
      const back = el("div", { class: "carnet-tpl-backdrop", "aria-hidden": "true", hidden: true });
      const list = el("div", { class: "carnet-tpl-list", role: "group", "aria-label": "Modèles" });
      const box = el("div", { id: "hq-carnet-templates", class: "carnet-tpl", role: "dialog", "aria-modal": "true", "aria-labelledby": "carnet-tpl-title", hidden: true }, [
        el("div", { class: "carnet-tpl-head" }, [
          el("h3", { id: "carnet-tpl-title", class: "carnet-tpl-title", text: "Nouvelle page depuis un modèle" }),
          iconButton("btn-carnet-tpl-close", "Fermer", ICON.close, { class: "carnet-btn" }),
        ]),
        list,
        el("p", { class: "hint carnet-tpl-note", text: "Une page ordinaire : tu écris par-dessus, rien n'est rempli à ta place." }),
      ]);
      ui.root.append(back, box);
      ui.tpl = { box, back, list, open: false, ctx: {}, from: null };
      back.addEventListener("click", () => closeTemplates(true));
      box.querySelector("#btn-carnet-tpl-close").addEventListener("click", () => closeTemplates(true));
      box.addEventListener("keydown", (e) => {
        const items = Array.prototype.slice.call(box.querySelectorAll("button"));
        const at = items.indexOf(doc.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeTemplates(true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus({ preventScroll: true });
        } else if (e.key === "Tab") {
          // the dialog is modal: Tab cycles inside it
          e.preventDefault();
          items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus({ preventScroll: true });
        }
      });
      list.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-carnet-template]") : null;
        if (!b || b.disabled) return;
        const T = ui.tpl;
        for (const x of list.querySelectorAll("button")) x.disabled = true; // one choice, one request
        newPageFromTemplate(b.getAttribute("data-carnet-template"), T.ctx).then((id) => {
          for (const x of list.querySelectorAll("button")) x.disabled = false;
          if (id) closeTemplates(false);
        });
      });
    }
    const T = ui.tpl;
    T.ctx = ctx || {};
    T.from = from || null;
    while (T.list.firstChild) T.list.removeChild(T.list.firstChild);
    for (const t of Tm.list()) {
      const b = el("button", { type: "button", class: "carnet-tpl-item", "data-carnet-template": t.id });
      b.appendChild(svgIcon(t.icon));
      b.appendChild(el("span", { class: "carnet-tpl-text" }, [el("span", { class: "carnet-tpl-label", text: t.label }), el("span", { class: "carnet-tpl-hint", text: t.hint })]));
      T.list.appendChild(b);
    }
    T.open = true;
    T.back.hidden = false;
    T.box.hidden = false;
    const first = T.list.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- context popover

  function renderContext() {
    const c = ui.core;
    const box = ui.ctxEl;
    if (!c || !box || box.hidden) return;
    const e = c.current();
    box.textContent = "";
    if (!e) return;
    const ro = isReadOnly(e) || !!e.conflict || e.orphan;
    const head = el("div", { class: "carnet-ctx-head" }, [
      el("strong", { text: "Classement" }),
      iconButton("btn-carnet-context-close", "Fermer", ICON.close, { class: "carnet-btn carnet-ctx-close" }),
    ]);
    box.appendChild(head);
    if (ro) box.appendChild(el("p", { class: "hint", text: e.conflict ? MSG.trashConflict : "Page en lecture seule." }));
    const srvProject = (e.latest || e.server || {}).project_id || null;
    const projects = el("div", { class: "carnet-chips", role: "group", "aria-label": "Projet" });
    const opt = (kind, id, label, color) => {
      const cur = kind === "project" ? e.local.project_id : e.local.category_id;
      const attrs = { type: "button", class: "carnet-chip carnet-opt", "aria-pressed": (cur || "") === (id || "") ? "true" : "false", disabled: ro };
      attrs["data-carnet-" + kind] = id || "";
      const b = el("button", attrs);
      if (color) b.appendChild(el("span", { class: "carnet-dot", "data-color": COLORS[color] ? color : "graphite", "aria-hidden": "true" }));
      b.appendChild(el("span", { text: label }));
      return b;
    };
    projects.appendChild(opt("project", null, "Aucun projet"));
    for (const p of c.st.projects) {
      if (!isObj(p)) continue;
      if (p.archived && p.id !== e.local.project_id && p.id !== srvProject) continue; // archived: not offered for new assignment
      projects.appendChild(opt("project", p.id, String(p.name || "") + (p.archived ? " (archivé)" : "")));
    }
    const cats = el("div", { class: "carnet-chips", role: "group", "aria-label": "Catégorie" });
    cats.appendChild(opt("category", null, "Aucune catégorie"));
    for (const k of c.st.categories) if (isObj(k)) cats.appendChild(opt("category", k.id, String(k.name || ""), k.color));
    box.append(el("p", { class: "carnet-ctx-label", text: "Projet" }), projects, el("p", { class: "carnet-ctx-label", text: "Catégorie" }), cats);
    if (!c.st.projects.length && !c.st.categories.length) {
      box.appendChild(el("p", { class: "hint", text: "Crée des projets et catégories dans la Bibliothèque (Gérer)." }));
    }
  }

  function openContext() {
    if (!ui.ctxEl) return;
    ui.ctxOpen = true;
    ui.ctxEl.hidden = false;
    ui.ctxBackdrop.hidden = false;
    doc.getElementById("btn-carnet-context").setAttribute("aria-expanded", "true");
    renderContext();
    const first = ui.ctxEl.querySelector('.carnet-opt[aria-pressed="true"]:not(:disabled)') || ui.ctxEl.querySelector("button");
    if (first && finePointer()) first.focus({ preventScroll: true });
  }

  function closeContext(returnFocus) {
    if (!ui.ctxEl || !ui.ctxOpen) return;
    ui.ctxOpen = false;
    ui.ctxEl.hidden = true;
    ui.ctxBackdrop.hidden = true;
    const b = doc.getElementById("btn-carnet-context");
    if (b) {
      b.setAttribute("aria-expanded", "false");
      if (returnFocus) b.focus({ preventScroll: true });
    }
  }

  function onContextClick(ev) {
    const c = ui.core;
    const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
    const e = c && c.current();
    if (!b || !e) return;
    if (b.id === "btn-carnet-context-close") return closeContext(true);
    if (b.disabled) return;
    if (b.hasAttribute("data-carnet-project")) c.setContext(e.id, { project_id: b.getAttribute("data-carnet-project") || null });
    else if (b.hasAttribute("data-carnet-category")) c.setContext(e.id, { category_id: b.getAttribute("data-carnet-category") || null });
    renderContext();
    const again = ui.ctxEl.querySelector(b.hasAttribute("data-carnet-project") ? '[data-carnet-project][aria-pressed="true"]' : '[data-carnet-category][aria-pressed="true"]');
    if (again && finePointer()) again.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- trash / undo / permanent delete

  function showUndo(id) {
    hideUndo();
    const box = doc.getElementById("hq-carnet-undo");
    if (!box) return;
    ui.undo = { id, timer: setTimeout(hideUndo, 10000) };
    box.hidden = false;
  }

  function hideUndo() {
    if (ui.undo && ui.undo.timer) clearTimeout(ui.undo.timer);
    ui.undo = null;
    const box = doc.getElementById("hq-carnet-undo");
    if (box) box.hidden = true;
  }

  async function trashCurrent() {
    const c = ui.core;
    const e = c && c.current();
    if (!e || isReadOnly(e)) return;
    const id = e.id;
    try {
      await c.trashPage(id);
      showUndo(id);
      ui.toolsOpen = false;
      const tools = doc.getElementById("carnet-quick-tools");
      if (tools) tools.hidden = true;
      doc.getElementById("btn-carnet-more").setAttribute("aria-expanded", "false");
    } catch (err) {
      flashMsg(c.userMessage(err));
    }
    render();
  }

  async function undoTrash() {
    const u = ui.undo;
    if (!u || !ui.core) return;
    hideUndo();
    await restore(u.id);
  }

  async function restore(id) {
    const c = ui.core;
    if (!c) return;
    try {
      await c.restorePage(id);
      flashMsg(MSG.restored);
    } catch (err) {
      flashMsg(c.userMessage(err));
    }
    render();
  }

  function openDeleteConfirm(id) {
    const c = ui.core;
    const e = c && c.entry(id);
    const box = doc.getElementById("hq-carnet-delete-confirm");
    if (!e || !c.isTrashed(e) || !box) return;
    ui.confirmId = id;
    ui.confirmRev = (e.latest || e.server).rev; // the confirmation is bound to THIS revision
    ui.deleteNotice = null;
    box.querySelector(".carnet-confirm-title").textContent = deriveTitle(e.local.text);
    const input = doc.getElementById("hq-carnet-delete-word");
    input.value = "";
    doc.getElementById("btn-carnet-delete-confirm").disabled = true;
    box.hidden = false;
    try {
      input.focus({ preventScroll: false });
    } catch (_) {}
  }

  function closeDeleteConfirm() {
    ui.confirmId = null;
    ui.confirmRev = null;
    const box = doc.getElementById("hq-carnet-delete-confirm");
    if (box) box.hidden = true;
  }

  async function confirmDelete() {
    const c = ui.core;
    const id = ui.confirmId;
    const input = doc.getElementById("hq-carnet-delete-word");
    const rev = ui.confirmRev;
    if (!c || !id || !input || input.value.trim().toUpperCase() !== MSG.deleteWord) return;
    closeDeleteConfirm();
    try {
      await c.deletePermanent(id, rev);
      flashMsg(MSG.deleted);
    } catch (err) {
      const data = err && err.data;
      if (data && data.code === "delete_stale") {
        // Never retried: the page is intact, its refreshed state is shown, and a NEW
        // explicit confirmation of the current revision is required.
        ui.deleteNotice = { id, text: MSG.deleteStale };
        if (c.st.currentId === id) showCurrent();
      } else {
        flashMsg(c.userMessage(err));
      }
    }
    render();
  }

  // ---------------------------------------------------------------- Focus mode

  function enterFocus() {
    if (!ui.root || ui.focus) return;
    const hadFocus = doc.activeElement === ui.editor;
    ui.focus = true;
    closeContext(false);
    ui.lib.open = false;
    ui.root.classList.add("is-focus");
    if (doc.body) doc.body.classList.add("carnet-focus");
    doc.getElementById("btn-carnet-focus").setAttribute("aria-pressed", "true");
    layoutLibrary();
    if (hadFocus || finePointer()) focusEditor(false);
    else doc.getElementById("btn-carnet-focus-exit").focus({ preventScroll: true });
  }

  function exitFocus() {
    if (!ui.focus) return;
    const onExit = doc.activeElement && doc.activeElement.id === "btn-carnet-focus-exit";
    ui.focus = false;
    if (ui.root) ui.root.classList.remove("is-focus");
    if (doc.body) doc.body.classList.remove("carnet-focus");
    const b = doc.getElementById("btn-carnet-focus");
    if (b) b.setAttribute("aria-pressed", "false");
    layoutLibrary();
    if (onExit && b) b.focus({ preventScroll: true });
  }

  /** Escape closes the innermost transient layer; returns true when it handled something. */
  function handleEscape() {
    if (ui.confirmId) {
      closeDeleteConfirm();
      return true;
    }
    if (ui.ctxOpen) {
      closeContext(true);
      return true;
    }
    if (ui.linkOpen) {
      closeLink(true);
      return true;
    }
    if (ui.find.open) {
      toggleFind(false);
      focusEditor(false);
      return true;
    }
    if (ui.exportOpen) {
      toggleExport(false);
      return true;
    }
    const s = doc.getElementById("hq-carnet-search");
    if (s && doc.activeElement === s && s.value) {
      s.value = "";
      ui.lib.query = "";
      renderLibrary();
      return true;
    }
    if (libMode() !== "dock" && ui.lib.open) {
      closeLibrary(true);
      return true;
    }
    if (ui.focus) {
      exitFocus();
      return true;
    }
    return false;
  }

  /** Read-only = trashed per the AUTHORITATIVE lifecycle (same accessor as the core). */
  function isReadOnly(e) {
    return !!(e && ui.core && ui.core.isTrashed(e));
  }

  // ---------------------------------------------------------------- rendering

  function metaLabel(e) {
    const c = ui.core;
    if (!e || !c) return "À classer";
    const cat = c.st.categories.find((x) => x && x.id === e.local.category_id);
    const proj = c.st.projects.find((x) => x && x.id === e.local.project_id);
    const parts = [];
    if (proj && typeof proj.name === "string") parts.push(proj.name);
    if (cat && typeof cat.name === "string") parts.push(cat.name);
    return parts.length ? parts.join(" · ") : "À classer";
  }

  function statusFor() {
    const c = ui.core;
    const s = c ? c.status() : { text: "", kind: "", attention: [] };
    if (ui.drafts && ui.drafts.failed) return { text: MSG.storage, kind: "warn", attention: s.attention };
    return s;
  }

  function fmtWhen(ts) {
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts * 1000));
    } catch (_) {
      return "";
    }
  }

  function render() {
    const c = ui.core;
    if (!c || !ui.root) return;
    const e = c.current();
    const s = statusFor();
    ui.statusEl.textContent = s.text;
    ui.statusEl.dataset.kind = s.kind;
    const P = polishUi();
    if (P) {
      const r = P.saveUpdate(saveSnapshot(), e && e.error ? String(e.error) : "");
      // the pill carries the state; the full text stays visible only where it adds information (a hard failure, a notice)
      ui.statusEl.classList.toggle("carnet-vh", !!r.label && s.kind !== "err");
      P.outlineSchedule();
      P.inspectRecheck();
    }
    const att = doc.getElementById("btn-carnet-attention");
    const n = s.attention.length;
    att.hidden = !n;
    att.textContent = n === 1 ? MSG.attentionOne : n ? n + MSG.attentionMany : "";
    const idx = c.st.order.indexOf(c.st.currentId);
    const total = c.st.order.length;
    const ro = !!e && isReadOnly(e);
    doc.getElementById("carnet-page-indicator").textContent = ro ? "Corbeille" : total ? idx + 1 + " / " + total : "—";
    doc.getElementById("btn-carnet-prev").disabled = idx <= 0;
    doc.getElementById("btn-carnet-next").disabled = idx < 0 || idx >= total - 1;
    const pin = doc.getElementById("btn-carnet-pin");
    pin.setAttribute("aria-pressed", e && e.local.pinned ? "true" : "false");
    pin.disabled = !e || isReadOnly(e);
    const ctx = doc.getElementById("btn-carnet-context");
    ctx.textContent = metaLabel(e);
    const when = e && (e.latest || e.server) ? fmtWhen((e.latest || e.server).updated_at) : "";
    ctx.title = when ? "Projet et catégorie · modifiée " + when : "Projet et catégorie";
    const conflict = doc.getElementById("hq-carnet-conflict");
    conflict.hidden = !(e && e.conflict) || (!!e && isReadOnly(e));
    ui.editor.readOnly = !e || ro;
    if (e) ui.editor.dataset.pageId = e.id;
    else delete ui.editor.dataset.pageId;
    ctx.disabled = !e;
    ctx.setAttribute("aria-expanded", ui.ctxOpen ? "true" : "false");
    const trashBtn = ui.root.querySelector("[data-carnet-trash]");
    trashBtn.setAttribute("data-carnet-trash", e ? e.id : "");
    trashBtn.disabled = !e || ro || !!e.orphan;
    const tb = doc.getElementById("hq-carnet-trashed");
    tb.hidden = !ro;
    if (ro) {
      for (const b of tb.querySelectorAll("[data-carnet-restore]")) b.setAttribute("data-carnet-restore", e.id);
      for (const b of tb.querySelectorAll("[data-carnet-delete-permanent]")) b.setAttribute("data-carnet-delete-permanent", e.id);
    }
    if (ui.confirmId && e && e.id === ui.confirmId && ro && (e.latest || e.server).rev !== ui.confirmRev) {
      // the page changed under an open confirmation: invalidate it
      ui.deleteNotice = { id: e.id, text: MSG.deleteStale };
      closeDeleteConfirm();
    }
    if (ui.confirmId && (!e || e.id !== ui.confirmId || !ro)) closeDeleteConfirm();
    const note = doc.getElementById("hq-carnet-trashed-note");
    const showNote = !!(ro && ui.deleteNotice && e && ui.deleteNotice.id === e.id);
    note.hidden = !showNote;
    note.textContent = showNote ? ui.deleteNotice.text : "";
    doc.getElementById("btn-carnet-focus").setAttribute("aria-pressed", ui.focus ? "true" : "false");
    if (ui.ctxOpen) renderContext();
    renderExportState();
    refreshFormatState();
    refreshImageUi();
    if (ui.find.open) findUpdateUi();
  }

  /** Lines of a core entry's editable state (never null: falls back to plain text). */
  function localLines(local) {
    return Rich.linesFromTextFmt(local.text, local.fmt, local.ids) || Rich.plainLines(local.text);
  }

  /** Show `local` in the editor unless it already matches; keep the caret when asked and focused. */
  function setEditorContent(local, keepCaret) {
    const ed = ui.editor;
    const cur = Rich.parseEditor(ed);
    if (Rich.flat(cur) === local.text && Rich.fmtOf(cur) === local.fmt) return;
    const sel = keepCaret && doc.activeElement === ed ? readSel() : null;
    renderEditor(localLines(local));
    if (ui.eui) ui.eui.invalidate(); // a remote/restored version replaced the text: floating UIs never act on the old one
    if (sel) setSel(Math.min(sel.start, local.text.length), Math.min(sel.end, local.text.length));
  }

  function showCurrent() {
    const e = ui.core && ui.core.current();
    renderEditor(e ? localLines(e.local) : Rich.plainLines(""));
    try {
      ui.editor.scrollTop = 0;
    } catch (_) {}
    ui.pendingMarks = null;
    findRefresh();
    closeLink();
    closeImageTools();
    if (ui.eui) ui.eui.invalidate();
    if (ui.fieldUi) ui.fieldUi.refreshHud();
    if (ui.eng) ui.eng.onPageChange(e ? e.id : null);
  }

  /**
   * The live DOM's block identities follow the authoritative local ids whenever the DOM shows exactly
   * the same lines (a poll/rebase/restore can change ids without changing text). Not a user edit.
   */
  function syncDomIds() {
    const c = ui.core;
    const e = c && c.current();
    if (!e || !ui.editor || !Array.isArray(e.local.ids)) return;
    const lines = Rich.parseEditor(ui.editor);
    if (Rich.flat(lines) !== e.local.text || Rich.fmtOf(lines) !== e.local.fmt) return;
    Rich.syncIds(ui.editor, lines, e.local.ids);
  }

  function onCoreChange(evt) {
    if (!ui.root) return;
    const c = ui.core;
    if (evt && evt.type === "select") {
      showCurrent();
      structRevealForQuery();
    } else if (evt && evt.type === "remote" && evt.id === c.st.currentId) {
      setEditorContent(c.current().local, true);
    } else if (evt && (evt.type === "poll" || evt.type === "loaded")) {
      const e = c.current();
      if (e && !ui.editor.dataset.pageId) showCurrent();
      else if (e && ui.editor.dataset.pageId !== e.id) showCurrent();
      else if (e && evt.adopted && evt.adopted.includes(e.id) && !c.isDirty(e)) setEditorContent(e.local, true);
    }
    if (evt && evt.type === "edit") c.st.notice = "";
    if (evt && evt.adopted && evt.id === c.st.currentId) Rich.adoptIds(ui.editor, evt.adopted); // server ids replace obsolete ids / temporary keys
    if (evt && evt.type !== "edit" && evt.type !== "saving") syncDomIds();
    render();
    if (evt && evt.type === "edit") findEdited();
    const t = evt && evt.type;
    if (t === "edit") scheduleLibrary(300);
    else if (t !== "saving") scheduleLibrary(40);
    if (t && t !== "edit" && t !== "saving") scheduleHome();
  }

  function flashMsg(text, ms) {
    if (!ui.flashEl) return;
    ui.flashEl.textContent = text;
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(() => {
      ui.flashTimer = null;
      if (ui.flashEl) ui.flashEl.textContent = "";
    }, typeof ms === "number" && ms > 0 ? ms : 1800);
  }

  // ---------------------------------------------------------------- actions

  function flipGhost(dir, oldText) {
    if (!ui.paper) return;
    for (const g of ui.paper.querySelectorAll(".carnet-page-ghost")) g.remove();
    if (reducedMotion()) return; // no 3D flip at all
    const ghost = el("div", { class: "carnet-page-ghost " + (dir > 0 ? "is-next" : "is-prev"), "aria-hidden": "true" });
    ghost.textContent = String(oldText || "").slice(0, 4000);
    ui.paper.appendChild(ghost);
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      ghost.remove();
    };
    ghost.addEventListener("animationend", cleanup, { once: true });
    setTimeout(cleanup, FLIP_MS + 200);
  }

  function navigate(delta, opts) {
    const c = ui.core;
    if (!c) return false;
    const old = ui.editor ? ui.editor.value : "";
    const hadFocus = doc.activeElement === ui.editor;
    if (c.go(delta)) {
      if (!(opts && opts.dragged)) {
        flipGhost(delta, old); // a finger-driven flip already moved the page itself
        flipSlideIn(delta); // 16C (PC): buttons and Alt+arrows get the same arrival as a swipe
      }
      if (hadFocus) focusEditor(false);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 16C: page flip that follows the finger
  // The paper moves with a horizontal drag (rubber band when there is no page that way); released past a third of its width,
  // or flicked, it slides out, the neighbouring page is shown and slides in. Only CSS transforms on .carnet-paper: nothing is
  // saved by the gesture itself (navigation is the same c.go() as the buttons). Reduced motion: no movement, a swipe still turns.
  const FLIP_LOCK_PX = 10;
  // a gesture that starts over one of these belongs to it (scroll / pan / slider / sticky note), never to the page flip
  const FLIP_EXCLUDE = "table,[data-carnet-struct=table],.carnet-table-scroll,[data-carnet-image],.carnet-group,.carnet-drawing,.carnet-insp-viewport,.carnet-outline,.carnet-inspector,.carnet-sticky";

  function flipSlideIn(dir) {
    const paper = ui.paper;
    if (!paper || reducedMotion() || !paper.animate) return;
    flipAnimate(paper, [{ transform: "translate3d(" + dir * 28 + "px,0,0)", opacity: 0.55 }, { transform: "none", opacity: 1 }], 300, "cubic-bezier(.2,1.1,.32,1)").then((a) => a && a.cancel && a.cancel());
  }

  /** 16C (PC): a two-finger horizontal trackpad swipe drives the same finger-following flip. Mouse wheels (vertical) and
   *  Shift+wheel (horizontal scrolling) are left alone; a horizontally scrollable element under the pointer keeps the gesture. */
  function bindTrackpadFlip(stage) {
    let w = null;
    let lastEvt = 0;
    let lastEnd = 0;
    const finish = () => {
      const s = w;
      w = null;
      lastEnd = Date.now();
      if (s && s.started) flipRelease(s);
    };
    stage.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.shiftKey || e.metaKey || e.deltaMode !== 0) return;
      const ax = Math.abs(e.deltaX);
      const ay = Math.abs(e.deltaY);
      const t = Date.now();
      const tail = !w && lastEnd && t - lastEvt < 220; // the trackpad's momentum after a turn: never a second turn
      lastEvt = t;
      if (tail) {
        if (e.cancelable && ax > ay) e.preventDefault();
        return;
      }
      if (!w) {
        if (ax < 4 || ax < 1.4 * ay) return;
        if (e.target && e.target.closest && e.target.closest(FLIP_EXCLUDE)) return;
        if (ui.editor && ui.editor.selectionStart !== ui.editor.selectionEnd) return;
        w = { dx: 0, dy: 0, v: 0, lt: Date.now(), started: false, timer: 0 };
        flipStop(ui.paper);
      }
      if (e.cancelable) e.preventDefault(); // no browser back/forward swipe while the page is being turned
      const now = Date.now();
      const step = -e.deltaX;
      w.v = w.v * 0.5 + (step / Math.max(1, now - w.lt)) * 0.5;
      w.lt = now;
      w.dx += step;
      w.dy += -e.deltaY;
      w.started = true;
      flipFollow(w);
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(finish, 120);
    }, { passive: false });
  }
  const FLIP_HOLD_MS = 450; // held before moving = selecting text, never a page turn
  const FLIP_FLICK = 0.45; // px/ms

  function flipCanGo(dir) {
    const b = doc.getElementById(dir > 0 ? "btn-carnet-next" : "btn-carnet-prev");
    return !!b && !b.disabled;
  }

  function flipBuzz(ms) {
    const M = global.HqCarnetMotion;
    if (M && typeof M.buzz === "function") M.buzz(ms);
  }

  function flipStop(paper) {
    if (paper && paper.getAnimations) for (const a of paper.getAnimations()) if (a.id === "c16-flip") a.cancel();
  }

  function flipFollow(s) {
    const paper = ui.paper;
    if (!paper || reducedMotion()) return;
    const w = Math.max(1, paper.clientWidth);
    const dir = s.dx < 0 ? 1 : -1;
    let x = s.dx;
    if (!flipCanGo(dir)) x = Math.sign(x) * Math.min(64, Math.abs(x) * 0.25); // rubber band: nothing that way
    s.px = x;
    paper.classList.add("c16-dragging");
    paper.style.transform = "translate3d(" + x.toFixed(1) + "px,0,0) rotate(" + ((x / w) * 1.6).toFixed(3) + "deg)";
    paper.style.opacity = String(Math.max(0.55, 1 - (Math.abs(x) / w) * 0.45).toFixed(3));
    paper.style.setProperty("--c16-curl", Math.min(1, Math.abs(x) / (w * 0.5)).toFixed(3)); // the lifting edge darkens as it turns
    paper.setAttribute("data-c16-dir", x < 0 ? "next" : "prev");
    const armed = flipCanGo(dir) && Math.abs(x) >= Math.max(SWIPE_MIN, w * 0.3);
    if (armed !== !!s.armed) {
      s.armed = armed;
      if (armed) flipBuzz(8);
    }
  }

  function flipAnimate(paper, frames, ms, easing) {
    flipStop(paper);
    if (!paper.animate) return Promise.resolve();
    const a = paper.animate(frames, { duration: ms, easing, fill: "forwards" });
    a.id = "c16-flip";
    return a.finished.then(() => a, () => a);
  }

  function flipRelease(s) {
    const paper = ui.paper;
    if (!paper) return;
    const dx = s.dx || 0;
    const dir = dx < 0 ? 1 : -1;
    const w = Math.max(1, paper.clientWidth);
    const flick = Math.abs(s.v || 0) >= FLIP_FLICK && Math.abs(dx) > 30 && Math.sign(s.v) === Math.sign(dx);
    const go = flipCanGo(dir) && (Math.abs(dx) >= Math.max(SWIPE_MIN, w * 0.3) || flick);
    if (reducedMotion()) {
      if (go || isSwipe(dx, s.dy || 0)) navigate(dir);
      return;
    }
    const from = paper.style.transform || "none";
    const fromOp = paper.style.opacity || "1";
    paper.classList.remove("c16-dragging");
    paper.style.transform = "";
    paper.style.opacity = "";
    paper.style.removeProperty("--c16-curl");
    paper.removeAttribute("data-c16-dir");
    if (!go) {
      flipAnimate(paper, [{ transform: from, opacity: fromOp }, { transform: "none", opacity: 1 }], 340, "cubic-bezier(.2,1.35,.35,1)").then((a) => a && a.cancel && a.cancel());
      return;
    }
    const out = -dir * w * 1.04;
    flipAnimate(paper, [{ transform: from, opacity: fromOp }, { transform: "translate3d(" + out + "px,0,0) rotate(" + (-dir * 1.6) + "deg)", opacity: 0 }], 150, "cubic-bezier(.4,0,1,1)").then(() => {
      const moved = navigate(dir, { dragged: true });
      const inFrom = moved ? dir * w * 0.32 : 0;
      return flipAnimate(paper, [{ transform: "translate3d(" + inFrom + "px,0,0)", opacity: moved ? 0 : 1 }, { transform: "none", opacity: 1 }], 360, "cubic-bezier(.2,1.1,.32,1)");
    }).then((a) => a && a.cancel && a.cancel());
  }

  // ---------------------------------------------------------------- 16C: block Undo (move / delete / duplicate)
  function linesSig(lines) {
    try {
      return JSON.stringify([Rich.flat(lines), Rich.fmtOf(lines), Rich.idsOf(lines)]);
    } catch (_) {
      return "";
    }
  }

  /** Offer "Annuler" for a block operation that was just committed. Undo applies ONLY when the same page is still exactly what the
   *  operation produced (same text, formats and ids); otherwise nothing is touched and a message says so (fails closed). */
  function offerBlockUndo(label, before) {
    const M = global.HqCarnetMotion;
    const e = curEntry();
    if (!M || typeof M.toast !== "function" || !e || !ui.editor || !Array.isArray(before)) return;
    const pageId = e.id;
    const snapshot = Rich.cloneLines(before);
    const sig = linesSig(Rich.parseEditor(ui.editor));
    M.toast({
      text: label,
      action: "Annuler",
      onAction: () => {
        const cur = curEntry();
        if (!cur || cur.id !== pageId || linesSig(Rich.parseEditor(ui.editor)) !== sig) {
          flashMsg("La page a changé depuis : rien n'a été annulé", true);
          return false;
        }
        if (commitLines(Rich.cloneLines(snapshot), null)) {
          flashMsg("Annulé");
          return true;
        }
        return false;
      },
    });
  }

  function focusEditor(atEnd) {
    const ed = ui.editor;
    if (!ed || ed.readOnly) return;
    try {
      ed.focus({ preventScroll: true });
      if (atEnd) ed.setSelectionRange(ed.value.length, ed.value.length);
    } catch (_) {}
  }

  function insertText(text) {
    const ed = ui.editor;
    const e = ui.core && ui.core.current();
    if (!ed || !e || ed.readOnly) return;
    if (doc.activeElement !== ed) {
      const cached = ui.selCache;
      ed.focus({ preventScroll: true });
      if (cached) setSel(cached.start, cached.end);
    }
    let ok = false;
    const before = ed.value;
    try {
      ok = doc.execCommand && doc.execCommand("insertText", false, text); // keeps native undo
    } catch (_) {
      ok = false;
    }
    if (!ok || ed.value === before) {
      const sel = readSel() || { start: before.length, end: before.length };
      const res = Rich.replaceRange(Rich.parseEditor(ed), sel.start, sel.end, text);
      commitLines(res.lines, { start: res.caret, end: res.caret });
    }
  }

  function legacyCopy(text) {
    const tmp = el("textarea", { readonly: true, "aria-hidden": "true", class: "carnet-copy-buffer" });
    tmp.value = text;
    doc.body.appendChild(tmp);
    let ok = false;
    try {
      tmp.select();
      tmp.setSelectionRange(0, text.length);
      ok = !!doc.execCommand("copy");
    } catch (_) {
      ok = false;
    }
    tmp.remove();
    return ok;
  }

  async function copyAction() {
    const ed = ui.editor;
    if (!ed) return;
    const s = ed.selectionStart;
    const t = ed.selectionEnd;
    const hadFocus = doc.activeElement === ed;
    const text = s !== t ? ed.value.slice(s, t) : ed.value;
    let ok = false;
    try {
      if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
        await global.navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) ok = legacyCopy(text);
    if (hadFocus || s !== t) {
      try {
        ed.focus({ preventScroll: true });
        ed.setSelectionRange(s, t);
      } catch (_) {}
    }
    flashMsg(ok ? MSG.copied : MSG.copyFail);
  }

  // ---------------------------------------------------------------- Stage 04: editor surface

  /**
   * The editor is a contenteditable div, but callers (and the accepted browser tests) keep using
   * the textarea vocabulary: value, selectionStart/End, setSelectionRange, readOnly. Selection
   * offsets are flat text offsets (lines joined by "\\n"), exactly like a textarea's.
   */
  function installEditorShim(ed) {
    const define = (name, desc) => Object.defineProperty(ed, name, Object.assign({ configurable: true }, desc));
    define("value", {
      get() {
        return Rich.flat(Rich.parseEditor(ed));
      },
      set(v) {
        Rich.renderInto(ed, Rich.plainLines(String(v)));
        markEmpty(ed);
      },
    });
    define("selectionStart", { get: () => (readSel() || { start: 0 }).start });
    define("selectionEnd", { get: () => (readSel() || { end: 0 }).end });
    define("readOnly", {
      get() {
        return ed.getAttribute("contenteditable") !== "true";
      },
      set(v) {
        const want = v ? "false" : "true";
        if (ed.getAttribute("contenteditable") !== want) ed.setAttribute("contenteditable", want);
        if (v) ed.setAttribute("aria-readonly", "true");
        else ed.removeAttribute("aria-readonly");
      },
    });
    ed.setSelectionRange = (a, b) => setSel(a, b);
  }

  function markEmpty(ed, parsed) {
    const e = ed || ui.editor;
    if (!e) return;
    const first = e.children.length === 1 && e.firstChild && e.firstChild.getAttribute("data-line-type") === "paragraph" && !e.firstChild.textContent;
    if (first) e.setAttribute("data-empty", "true");
    else e.removeAttribute("data-empty");
    decorateTitle(e, parsed);
  }

  /**
   * Visual page-title treatment ONLY: a non-persisted attribute on the first block when it is an editable text-like block.
   * derive_title() stays authoritative (first non-empty line, unchanged); nothing is stored or exported for this.
   * The input is the real parsed model (the same parser that feeds every save), never text synthesised from rendered DOM:
   * presentation text (a decision's "DÉCISION · time" label, an image caption, a calculation result) is not block text.
   * The whole page is scanned (it is bounded by BLOCKS_MAX) and the scan stops at the first non-empty model line.
   */
  function decorateTitle(e, parsed) {
    const R = global.HqCarnetCommands;
    let want = null;
    if (R) {
      const lines = parsed || Rich.parseEditor(e);
      const at = R.titleIndex(lines);
      // parseEditor normalises lines (no element reference) but guarantees a unique id per line, written back on the block
      const id = at >= 0 && lines[at] ? lines[at].id : null;
      if (id) {
        for (const k of e.children) {
          if (k.getAttribute("data-carnet-block-id") === id || k.getAttribute("data-carnet-tmp") === id) {
            want = k;
            break;
          }
        }
      }
    }
    for (const n of e.querySelectorAll(":scope > [data-title]")) if (n !== want) n.removeAttribute("data-title");
    if (want && !want.hasAttribute("data-title")) want.setAttribute("data-title", "true");
  }

  function renderEditor(lines) {
    Rich.renderInto(ui.editor, lines);
    markEmpty();
    // a full re-render rebuilt every line: a selected image that is still the same block keeps its selected look and tools
    if (ui.image && ui.image.sel) refreshImageUi();
  }

  /** {start, end, lines} for the selection inside the editor, or null when it lies elsewhere. */
  function readSel() {
    const ed = ui.editor;
    const sel = global.getSelection ? global.getSelection() : null;
    if (!ed || !sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer) || !ed.contains(r.endContainer)) return null;
    const map = new Map();
    const lines = Rich.parseEditor(ed, map);
    const a = Rich.pointToOffset(ed, r.startContainer, r.startOffset, lines, map);
    const b = Rich.pointToOffset(ed, r.endContainer, r.endOffset, lines, map);
    return { start: Math.min(a, b), end: Math.max(a, b), lines };
  }

  function setSel(start, end) {
    const ed = ui.editor;
    const sel = global.getSelection ? global.getSelection() : null;
    if (!ed || !sel) return;
    const map = new Map();
    const lines = Rich.parseEditor(ed, map);
    const total = Rich.flat(lines).length;
    const a = Math.max(0, Math.min(start, total));
    const b = Math.max(0, Math.min(end, total));
    const p = Rich.offsetToPoint(ed, lines, a, map);
    const q = b === a ? p : Rich.offsetToPoint(ed, lines, b, map);
    const range = doc.createRange();
    try {
      range.setStart(p.node, p.off);
      range.setEnd(q.node, q.off);
    } catch (_) {
      return;
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** The selection to act on: the live one, else the last cached one, else the end of the page. */
  function currentSel() {
    const live = readSel();
    if (live) return live;
    const lines = Rich.parseEditor(ui.editor);
    const total = Rich.flat(lines).length;
    const c = ui.selCache;
    if (c) return { start: Math.min(c.start, total), end: Math.min(c.end, total), lines };
    return { start: total, end: total, lines };
  }

  /**
   * One structural edit: state machine first (draft + generation, same path as typing), then the
   * DOM is rebuilt from the same lines and the selection restored.
   */
  function commitLines(lines, sel) {
    const c = ui.core;
    const e = c && c.current();
    if (!e || isReadOnly(e)) return false;
    if (lines.length > Rich.BLOCKS_MAX && !Rich.isPlain(lines)) {
      flashMsg(MSG.tooManyLines); // visible, and nothing changes: never truncate or flatten the page
      return false;
    }
    Rich.ensureKeys(lines);
    if (!c.edit(e.id, { text: Rich.flat(lines), fmt: Rich.fmtOf(lines), ids: Rich.idsOf(lines) })) {
      flashMsg("Modification refusée");
      return false;
    }
    renderEditor(lines);
    if (sel) setSel(sel.start, sel.end);
    ui.pendingMarks = null;
    refreshFormatState();
    return true;
  }

  function curEntry() {
    const c = ui.core;
    const e = c && c.current();
    return e && !isReadOnly(e) ? e : null;
  }

  function onEditorInput() {
    const c = ui.core;
    if (!c || !c.st.currentId) return;
    const lines = Rich.parseEditor(ui.editor);
    Rich.renumber(ui.editor);
    markEmpty(ui.editor, lines);
    ui.pendingMarks = null;
    if (!c.edit(c.st.currentId, { text: Rich.flat(lines), fmt: Rich.fmtOf(lines), ids: Rich.idsOf(lines) })) {
      const e = c.current();
      if (e && !isReadOnly(e)) {
        flashMsg(lines.length > Rich.BLOCKS_MAX ? MSG.tooManyLines : "Modification refusée");
        showCurrent();
      }
    }
  }

  function typeWithPending(data) {
    const sel = readSel();
    const pend = ui.pendingMarks;
    if (!sel || !pend) return false;
    const res = Rich.replaceRange(sel.lines, sel.start, sel.end, data);
    let lines = res.lines;
    const from = res.caret - data.length;
    // A pending style flips what native typing would have produced here (the mark covering the
    // character before the caret continues by default).
    for (const t of pend.types) {
      const native = sel.start === sel.end && Rich.hasMark(sel.lines, Math.max(0, sel.start - 1), sel.start, t);
      lines = Rich.setMark(lines, from, res.caret, t, !native);
    }
    return commitLines(lines, { start: res.caret, end: res.caret });
  }

  function onBeforeInput(ev) {
    const e = curEntry();
    if (!e || ev.isComposing) return;
    const t = ev.inputType || "";
    if (t === "insertParagraph" || t === "insertLineBreak") {
      ev.preventDefault();
      doEnter();
    } else if (t === "formatBold" || t === "formatItalic" || t === "formatUnderline") {
      ev.preventDefault();
      applyFormat(t === "formatBold" ? "bold" : t === "formatItalic" ? "italic" : "underline");
    } else if (t.indexOf("format") === 0 || t === "insertFromDrop" || t === "insertFromPaste" || t === "insertFromPasteAsQuotation") {
      ev.preventDefault(); // never let the browser create its own formatting/HTML
    } else if ((t === "deleteContentBackward" || t === "deleteContentForward") && imgKeyAdjacent(ev)) {
      return; // next to an image: Backspace/Delete selected it instead of deleting it
    } else if ((t === "deleteContentBackward" || t === "deleteContentForward") && engKeyAdjacent(ev)) {
      return; // next to a calculation/measurement: Backspace/Delete opened it instead of deleting it
    } else if (t === "deleteContentBackward") {
      const sel = readSel();
      if (sel && sel.start === sel.end) {
        const at = Rich.locate(sel.lines, sel.start);
        if (at.off === 0 && sel.lines[at.line].type !== "paragraph") {
          ev.preventDefault();
          commitLines(Rich.setBlockType(sel.lines, sel.start, sel.start, sel.lines[at.line].type), sel);
        }
      }
    } else if (t === "insertText" && ev.data === "/" && ui.eui && ui.eui.slashKey(ev)) {
      return; // the menu took the keystroke: no "/" enters the document unless it is dismissed in a still-valid context
    } else if (t === "insertText" && ev.data && ui.pendingMarks && ev.data.indexOf("\n") < 0) {
      const sel = readSel();
      if (sel && ui.pendingMarks.pos === sel.start) {
        ev.preventDefault();
        typeWithPending(ev.data);
      }
    }
  }

  function doEnter() {
    const sel = readSel();
    if (!sel) return;
    const res = Rich.splitAt(sel.lines, sel.start, sel.end);
    commitLines(res.lines, { start: res.caret, end: res.caret });
  }

  function cleanPasted(text) {
    return String(text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  }

  // ---- image drop / paste (UX pass): both routes end in imageFromFile() = the accepted Stage-06 pipeline (prepare -> upload -> edit)

  /** The routing hint only (`type`): Media.prepare re-reads the real bytes and refuses anything that is not JPEG/PNG/WebP. */
  function firstImageFile(dt) {
    if (!dt) return null;
    for (const f of dt.files || []) if (f && /^image\//i.test(f.type || "")) return f;
    for (const it of dt.items || []) {
      if (it && it.kind === "file" && /^image\//i.test(it.type || "")) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    return null;
  }

  function hasFiles(dt) {
    return !!dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0;
  }

  function setDropState(on) {
    if (ui.paper) {
      if (on) ui.paper.setAttribute("data-drop", "true");
      else ui.paper.removeAttribute("data-drop");
    }
  }

  /** Where a dropped image goes: the block slot under the pointer (decided NOW, re-checked when the upload lands). */
  function imgDropTarget(e, clientY) {
    const lines = Rich.parseEditor(ui.editor);
    const kids = ui.editor.children;
    let slot = 0;
    for (let i = 0; i < kids.length; i += 1) {
      const r = kids[i].getBoundingClientRect();
      if (clientY > r.top + r.height / 2) slot = i + 1;
    }
    if (!lines.length) return null;
    const idx = Math.max(0, Math.min(lines.length - 1, slot === 0 ? 0 : slot - 1));
    return { pageId: e.id, mode: slot === 0 ? "before" : "after", anchorId: lines[idx].id, replace: null };
  }

  function insertImageFile(file, origin) {
    const I = ui.image;
    if (!Media) return imgNote(IMG_MSG.unavailable, true);
    const e = curEntry();
    if (!e) return imgNote(IMG_MSG.readonly, true);
    if (I.busy) return imgNote(IMG_MSG.busy, true);
    if (Rich.assetsOf(localLines(e.local)).length >= Rich.IMAGES_PER_PAGE_MAX) return imgNote(IMG_MSG.tooMany, true);
    imageFromFile(file, origin || imgCaptureTarget(e));
  }

  function wireImageDrop(root) {
    let depth = 0;
    root.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      depth += 1;
      ev.preventDefault();
      if (curEntry()) setDropState(true);
    });
    root.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault(); // otherwise the browser would navigate to the dropped file
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = curEntry() ? "copy" : "none";
    });
    root.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDropState(false);
    });
    root.addEventListener("drop", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      depth = 0;
      setDropState(false);
      const e = curEntry();
      if (!e) return imgNote(IMG_MSG.readonly, true);
      const file = firstImageFile(ev.dataTransfer);
      if (!file) return flashMsg("Seules les images JPEG, PNG ou WebP peuvent être déposées.");
      insertImageFile(file, imgDropTarget(e, ev.clientY));
    });
    root.addEventListener("dragend", () => {
      depth = 0;
      setDropState(false);
    });
  }

  function onPaste(ev) {
    ev.preventDefault(); // plain text only: no clipboard HTML ever reaches the note
    const e = curEntry();
    if (!e) return;
    const pic = firstImageFile(ev.clipboardData);
    if (pic) {
      insertImageFile(pic, null);
      return;
    }
    const data = ev.clipboardData && ev.clipboardData.getData ? ev.clipboardData.getData("text/plain") : "";
    const text = cleanPasted(data);
    const sel = readSel();
    if (!text || !sel) return;
    const res = Rich.replaceRange(sel.lines, sel.start, sel.end, text);
    commitLines(res.lines, { start: res.caret, end: res.caret });
  }

  function onEditorKey(ev) {
    if (ui.eui && ui.eui.onKeydown(ev)) return;
    if (onImageKey(ev)) return;
    const attEl = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-attach-open]") : null;
    if (attEl && ui.editor.contains(attEl) && (ev.key === "Enter" || ev.key === " ") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      portalActivate(attEl);
      return;
    }
    const dEl = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-derived-open]") : null;
    if (dEl && ui.editor.contains(dEl) && (ev.key === "Enter" || ev.key === " ") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      derivedOpen(dEl);
      return;
    }
    const atomEl = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-eng]") : null;
    if (atomEl && ui.editor.contains(atomEl) && (ev.key === "Enter" || ev.key === " ") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      if (curEntry()) {
        const eu = engUi();
        if (eu) eu.openAtom(atomEl);
      }
      return;
    }
    if ((ev.key === "Enter" || ev.key === " ") && ev.target && ev.target.closest && ev.target.closest("[data-carnet-citation]") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const w = ev.target.closest("[data-carnet-citation]");
      if (w && ui.editor.contains(w)) {
        ev.preventDefault();
        openCitationElement(w);
        return;
      }
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod || ev.altKey) return;
    const k = String(ev.key || "").toLowerCase();
    if (!curEntry()) return;
    if (!ev.shiftKey && (k === "b" || k === "i" || k === "u")) {
      ev.preventDefault();
      applyFormat(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
    } else if (!ev.shiftKey && k === "k") {
      ev.preventDefault();
      openLinkPanel();
    } else if (k === "enter" && !ev.shiftKey) {
      const sel = readSel();
      if (sel) {
        const at = Rich.locate(sel.lines, sel.start);
        if (sel.lines[at.line].type === "check") {
          ev.preventDefault();
          commitLines(Rich.toggleChecked(sel.lines, at.line), sel);
        }
      }
    }
  }

  /**
   * Double-click / double-tap on an image opens the inspector. Detected on pointerdown (before the first click re-lays the page out
   * by opening the image tools), keyed by the block, not the element. Presentation only: nothing is selected, resized or saved.
   */
  function onEditorPointerDown(ev) {
    if (!ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    const now = Date.now();
    const tap = ui.lastImgTap;
    // the second press counts by TIME and DISTANCE only: the first click opens the image tools, which may move the page under the pointer
    if (tap && now - tap.at < 380 && Math.abs(ev.clientX - tap.x) < 32 && Math.abs(ev.clientY - tap.y) < 32 && ui.editor.contains(ev.target)) {
      ui.lastImgTap = null;
      const line = tap.id ? ui.editor.querySelector('[data-carnet-block-id="' + tap.id + '"]') : tap.line;
      if (line && line.isConnected) {
        ev.preventDefault();
        inspectImageLine(line, line.querySelector("[data-carnet-image]"));
        return;
      }
    }
    ui.lastImgTap = null;
    const fig = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-image]") : null;
    if (!fig || !ui.editor.contains(fig)) return;
    const line = fig.closest("[data-carnet-line]");
    if (!line) return;
    ui.lastImgTap = { id: line.getAttribute("data-carnet-block-id") || "", line, at: now, x: ev.clientX, y: ev.clientY };
  }

  function onEditorClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    const fig = t.closest("[data-carnet-image]");
    if (fig && ui.editor.contains(fig)) {
      ev.preventDefault();
      selectImageLine(fig.closest("[data-carnet-line]"));
      return;
    }
    const att = t.closest("[data-carnet-attach-open]");
    if (att && ui.editor.contains(att)) {
      ev.preventDefault();
      portalActivate(att);
      return;
    }
    const atom = t.closest("[data-carnet-eng]");
    if (atom && ui.editor.contains(atom)) {
      ev.preventDefault();
      if (curEntry()) {
        const eu = engUi();
        if (eu) eu.openAtom(atom);
      } else flashMsg("Page en lecture seule");
      return;
    }
    const dOpen = t.closest("[data-carnet-derived-open]");
    if (dOpen && ui.editor.contains(dOpen)) {
      ev.preventDefault();
      derivedOpen(dOpen);
      return;
    }
    if (ui.image.sel) closeImageTools(""); // a click in the text leaves the image
    const box = t.closest("[data-carnet-check]");
    if (box && ui.editor.contains(box)) {
      ev.preventDefault();
      const e = curEntry();
      const line = box.closest("[data-carnet-line]");
      if (!e || !line) return;
      const idx = Array.prototype.indexOf.call(ui.editor.children, line);
      const lines = Rich.parseEditor(ui.editor);
      const sel = readSel();
      commitLines(Rich.toggleChecked(lines, idx), sel && { start: sel.start, end: sel.end });
      return;
    }
    const cw = t.closest("[data-carnet-citation]");
    if (cw && ui.editor.contains(cw)) {
      ev.preventDefault();
      openCitationElement(cw);
      return;
    }
    const a = t.closest("a[data-carnet-link]");
    if (a && ui.editor.contains(a)) {
      ev.preventDefault(); // caret placement wins over navigation; Ctrl/Cmd+click or read-only opens
      if (ev.ctrlKey || ev.metaKey || !curEntry()) openLinkElement(a);
    }
  }

  function bindEditor(ed) {
    ed.addEventListener("input", onEditorInput);
    ed.addEventListener("beforeinput", onBeforeInput);
    ed.addEventListener("paste", onPaste);
    ed.addEventListener("drop", (ev) => ev.preventDefault()); // (the root-level handler inserts dropped images)
    ed.addEventListener("keydown", onEditorKey);
    ed.addEventListener("click", onEditorClick);
    ed.addEventListener("pointerdown", onEditorPointerDown);
    ed.addEventListener("error", onImageError, true); // <img> errors do not bubble: capture
    ed.addEventListener("mousedown", (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest("[data-carnet-check]")) ev.preventDefault();
    });
    ed.addEventListener("blur", () => {
      const sel = readSel();
      if (sel) ui.selCache = { start: sel.start, end: sel.end };
      if (ui.core && ui.core.st.currentId) ui.core.flush(ui.core.st.currentId);
    });
  }

  /** One global scroll/resize listener (registered once in init): floating UIs re-anchor, nothing else. */
  function onViewportChange(ev) {
    if (ui.phase !== "ready" || !ui.editor) return;
    const I = ui.image;
    if (I && I.sel) {
      const b = imgBound(false);
      if (b) placeImageTools(ui.editor.children[b.idx]);
    }
    if (ui.eui) {
      if (ev && ev.type === "resize") ui.eui.onResize();
      ui.eui.onViewport();
    }
  }

  function onSelectionChange() {
    if (ui.eui && ui.phase === "ready") ui.eui.onSelectionChange();
    if (ui.phase !== "ready" || !ui.editor) return;
    const sel = global.getSelection ? global.getSelection() : null;
    if (!sel || !sel.rangeCount || !ui.editor.contains(sel.getRangeAt(0).startContainer)) return;
    if (!(ui.fmtOpen || ui.find.open || ui.linkOpen || ui.pendingMarks || ui.exportOpen)) return;
    const cur = readSel();
    if (!cur) return;
    ui.selCache = { start: cur.start, end: cur.end };
    if (ui.pendingMarks && (cur.start !== cur.end || ui.pendingMarks.pos !== cur.start)) ui.pendingMarks = null;
    refreshFormatState();
  }

  // ---------------------------------------------------------------- formatting controls

  function buildFormatBar() {
    const bar = el("div", { id: "carnet-format-bar", class: "carnet-format", role: "toolbar", "aria-label": "Mise en forme", hidden: true });
    for (const [kind, glyph, title] of FORMATS) {
      const b = el("button", { type: "button", class: "carnet-fmt", "data-carnet-format": kind, "aria-label": title, title, "aria-pressed": "false" });
      b.appendChild(el("span", { class: "carnet-fmt-glyph", "data-glyph": kind, text: glyph }));
      keepFocus(b);
      bar.appendChild(b);
    }
    bar.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-format]") : null;
      if (b && !b.disabled) applyFormat(b.getAttribute("data-carnet-format"));
    });
    return bar;
  }

  function toggleFormatBar(force) {
    ui.fmtOpen = typeof force === "boolean" ? force : !ui.fmtOpen;
    const bar = doc.getElementById("carnet-format-bar");
    if (bar) bar.hidden = !ui.fmtOpen;
    const btn = doc.getElementById("btn-carnet-format");
    if (btn) btn.setAttribute("aria-expanded", ui.fmtOpen ? "true" : "false");
    refreshFormatState();
  }

  function armMark(kind, sel) {
    const pend = ui.pendingMarks && ui.pendingMarks.pos === sel.start ? ui.pendingMarks : { pos: sel.start, types: new Set() };
    if (pend.types.has(kind)) pend.types.delete(kind);
    else pend.types.add(kind);
    ui.pendingMarks = pend.types.size ? pend : null;
  }

  function applyFormat(kind) {
    const e = curEntry();
    if (!e) return;
    if (kind === "link") {
      openLinkPanel();
      return;
    }
    const sel = currentSel();
    if (Rich.INLINE.indexOf(kind) >= 0) {
      if (sel.start === sel.end) {
        armMark(kind, sel);
        refreshFormatState();
        return;
      }
      commitLines(Rich.toggleMark(sel.lines, sel.start, sel.end, kind), sel);
    } else if (Rich.BLOCK_TYPES.indexOf(kind) >= 0) {
      commitLines(Rich.setBlockType(sel.lines, sel.start, sel.end, kind), sel);
    }
    if (doc.activeElement !== ui.editor && finePointer()) focusEditor(false);
  }

  function refreshFormatState() {
    const bar = doc.getElementById("carnet-format-bar");
    if (!bar || !ui.core) return;
    const e = ui.core.current();
    const ro = !e || isReadOnly(e);
    const sel = ui.fmtOpen ? currentSel() : null;
    for (const b of bar.querySelectorAll("[data-carnet-format]")) {
      b.disabled = ro;
      if (!sel) continue;
      const kind = b.getAttribute("data-carnet-format");
      let on = false;
      if (Rich.INLINE.indexOf(kind) >= 0) {
        if (sel.start !== sel.end) on = Rich.hasMark(sel.lines, sel.start, sel.end, kind);
        else {
          on = Rich.hasMark(sel.lines, Math.max(0, sel.start - 1), sel.start, kind);
          if (ui.pendingMarks && ui.pendingMarks.pos === sel.start && ui.pendingMarks.types.has(kind)) on = !on;
        }
      } else if (kind === "link") on = !!Rich.linkAt(sel.lines, sel.start);
      else on = sel.lines[Rich.locate(sel.lines, sel.start).line].type === kind;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // ---------------------------------------------------------------- links

  function buildLinkPanel() {
    const url = el("input", {
      type: "text", id: "hq-carnet-link-url", class: "carnet-input", inputmode: "url", autocomplete: "off", autocapitalize: "off",
      spellcheck: "false", placeholder: "Adresse du lien", "aria-label": "Adresse du lien (http ou https)",
    });
    const note = el("select", { id: "hq-carnet-link-note", class: "carnet-input", "aria-label": "Lier une note du carnet" });
    const msg = el("p", { id: "carnet-link-msg", class: "carnet-msg", role: "alert" });
    const panel = el("div", { id: "hq-carnet-link", class: "carnet-panel", role: "group", "aria-label": "Lien", hidden: true }, [
      url,
      note,
      el("div", { class: "carnet-panel-row" }, [
        el("button", { type: "button", id: "btn-carnet-link-apply", class: "carnet-small", text: "Lier" }),
        el("button", { type: "button", id: "btn-carnet-link-open", class: "carnet-small", text: "Ouvrir" }),
        el("button", { type: "button", id: "btn-carnet-link-remove", class: "carnet-small", text: "Retirer" }),
        el("button", { type: "button", id: "btn-carnet-link-close", class: "carnet-small", text: "Fermer" }),
      ]),
      msg,
    ]);
    panel.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!b) return;
      if (b.id === "btn-carnet-link-apply") applyLink(false);
      else if (b.id === "btn-carnet-link-remove") applyLink(true);
      else if (b.id === "btn-carnet-link-open") openLinkFromPanel();
      else if (b.id === "btn-carnet-link-close") closeLink(true);
    });
    url.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyLink(false);
      }
    });
    return panel;
  }

  function fillNoteChoices(selected) {
    const sel = doc.getElementById("hq-carnet-link-note");
    if (!sel) return;
    sel.textContent = "";
    sel.appendChild(el("option", { value: "", text: "— Lier une note —" }));
    const cur = ui.core && ui.core.st.currentId;
    for (const it of ui.core ? ui.core.libraryItems() : []) {
      if (it.deleted || it.id === cur) continue;
      const opt = el("option", { value: it.id });
      opt.textContent = it.title; // note text only via textContent
      sel.appendChild(opt);
    }
    sel.value = selected || "";
  }

  function openLinkPanel() {
    const e = curEntry();
    if (!e) return;
    const sel = currentSel();
    let range = { start: sel.start, end: sel.end };
    let mark = null;
    if (sel.start === sel.end) {
      const hit = Rich.linkAt(sel.lines, sel.start);
      if (hit) {
        const base = Rich.lineStarts(sel.lines)[hit.line];
        range = { start: base + hit.mark.start, end: base + hit.mark.end };
        mark = hit.mark;
      }
    } else {
      const hit = Rich.linkAt(sel.lines, sel.start);
      if (hit) mark = hit.mark;
    }
    const panel = doc.getElementById("hq-carnet-link");
    const msg = doc.getElementById("carnet-link-msg");
    if (range.start === range.end) {
      msg.textContent = MSG.linkNeedSel;
      panel.hidden = false;
      ui.linkOpen = true;
      ui.linkRange = null;
      return;
    }
    ui.linkRange = range;
    ui.linkOpen = true;
    panel.hidden = false;
    msg.textContent = "";
    fillNoteChoices(mark && mark.ref && mark.ref.kind === "note" ? mark.ref.id : "");
    const input = doc.getElementById("hq-carnet-link-url");
    input.value = mark && mark.href ? mark.href : "";
    doc.getElementById("btn-carnet-link-remove").disabled = !mark;
    doc.getElementById("btn-carnet-link-open").disabled = !mark;
    ui.linkMark = mark;
    input.focus({ preventScroll: true });
  }

  function closeLink(refocus) {
    const panel = doc.getElementById("hq-carnet-link");
    if (panel) panel.hidden = true;
    ui.linkOpen = false;
    ui.linkRange = null;
    ui.linkMark = null;
    if (refocus) focusEditor(false);
  }

  function applyLink(remove) {
    const e = curEntry();
    const msg = doc.getElementById("carnet-link-msg");
    const range = ui.linkRange;
    if (!e || !range) return;
    const lines = Rich.parseEditor(ui.editor);
    if (range.end > Rich.flat(lines).length) {
      msg.textContent = MSG.linkNeedSel;
      return;
    }
    let target = null;
    if (!remove) {
      const noteId = doc.getElementById("hq-carnet-link-note").value;
      const raw = doc.getElementById("hq-carnet-link-url").value.trim();
      if (raw) {
        const href = Rich.safeHref(raw);
        if (!href) {
          msg.textContent = MSG.linkBad;
          return;
        }
        target = { href };
      } else if (noteId) target = { ref: { kind: "note", id: noteId } };
      else {
        msg.textContent = MSG.linkBad;
        return;
      }
    }
    const next = Rich.setLink(lines, range.start, range.end, target);
    if (!next) {
      msg.textContent = MSG.linkBad;
      return;
    }
    msg.textContent = "";
    commitLines(next, { start: range.start, end: range.end });
    closeLink(true);
  }

  function openLinkTarget(kind, value) {
    if (kind === "external") {
      const href = Rich.safeHref(value);
      if (href) global.open(href, "_blank", "noopener,noreferrer");
    } else if (kind === "note") {
      if (ui.core && ui.core.entry(value) && !ui.core.isTrashed(ui.core.entry(value))) openPage(value);
      else flashMsg(MSG.linkMissing);
    } else if (kind === "project" || kind === "media" || kind === "model" || kind === "drawing" || kind === "file") {
      const eu = engUi();
      if (eu) eu.openRef(kind, value); // existence is verified at open time; a missing target fails safe
    }
  }

  function openLinkElement(a) {
    const kind = a.getAttribute("data-carnet-link");
    if (kind === "external") openLinkTarget("external", a.getAttribute("data-href"));
    else openLinkTarget(a.getAttribute("data-ref-kind"), a.getAttribute("data-ref-id"));
  }

  function openLinkFromPanel() {
    const m = ui.linkMark;
    if (!m) return;
    if (m.href) openLinkTarget("external", m.href);
    else openLinkTarget(m.ref.kind, m.ref.id);
  }

  // ---------------------------------------------------------------- engineering tools (Stage 07)

  /** Lazily mounts the engineering UI (hq-carnet-eng-ui.js). Nothing is built until a tool is opened. */
  function engUi() {
    if (ui.eng) return ui.eng;
    const U = global.HqCarnetEngUi;
    if (!U || typeof U.mount !== "function") {
      flashMsg("Module ingénierie non chargé");
      return null;
    }
    const core = () => ui.core;
    ui.eng = U.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      now: () => Date.now(),
      editorEl: () => ui.editor,
      api: { get: (url) => apiCall(url, { timeoutMs: 12000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      editor: {
        entry: curEntry,
        sel: currentSel,
        lines: (e) => localLines(e.local),
        commit: commitLines,
      },
      notes: () => {
        const c = core();
        const out = [];
        if (c) for (const e of c.st.entries.values()) if (!e.orphan && !c.isTrashed(e)) out.push({ id: e.id, title: deriveTitle(e.local.text) });
        return out;
      },
      projects: () => {
        const c = core();
        return c ? c.st.projects.filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string") : [];
      },
      openNote: (id) => {
        const c = core();
        if (c && c.entry(id) && !c.isTrashed(c.entry(id))) {
          openPage(id);
          return true;
        }
        return false;
      },
      openProject: (id) => {
        ui.lib.sel = { filter: "project", id };
        ui.lib.query = "";
        openLibrary();
        renderLibrary();
      },
      openDrawing: async (stem) => {
        // An inline drawing link has no block to come back to: Dessiner opens the exact stem with a plain "back to Carnet" bar.
        if (typeof global.hqSketchOpenExact !== "function" || !Rich.Struct.STEM_RE.test(String(stem))) return false;
        if (typeof global.setView === "function") global.setView("dessiner");
        const res = await global.hqSketchOpenExact(stem, { label: "Croquis ouvert depuis le carnet", ret: () => goCarnet() });
        if (!res || !res.ok) {
          goCarnet();
          flashMsg((res && res.error) || "Dessiner indisponible", DESSINER_FLASH_MS);
          return false;
        }
        return true;
      },
      openFile: (rel) => {
        const ref = Rich.checkRef({ kind: "file", id: rel });
        if (ref) global.open("/files/" + ref.id.split("/").map(encodeURIComponent).join("/"), "_blank", "noopener,noreferrer");
      },
      playerOpen: (rel) => {
        if (typeof global.hqPlayerOpen === "function") global.hqPlayerOpen(rel, false);
        else if (Rich.checkRef({ kind: "file", id: rel })) global.open("/files/" + rel.split("/").map(encodeURIComponent).join("/"), "_blank", "noopener,noreferrer");
      },
      setView: (v) => {
        if (typeof global.setView === "function") global.setView(v);
      },
      onClose: (refocus) => {
        if (refocus && finePointer()) focusEditor(false);
      },
    });
    return ui.eng;
  }

  function openEngMenu() {
    const eu = engUi();
    if (!eu) return;
    const sel = currentSel(); // the caret/selection BEFORE the panel takes focus
    ui.selCache = { start: sel.start, end: sel.end };
    eu.openMenu();
  }

  function engKeyAdjacent(ev) {
    if (!ui.eng) {
      // the module is only built on demand: check cheaply whether an atom is even adjacent before building it
      const sel = readSel();
      if (!sel || sel.start !== sel.end) return false;
      const at = Rich.locate(sel.lines, sel.start);
      const back = ev.inputType === "deleteContentBackward";
      const prev = back && at.off === 0 && at.line > 0 ? sel.lines[at.line - 1] : null;
      const next = !back && at.off === sel.lines[at.line].text.length ? sel.lines[at.line + 1] : null;
      const a = prev || next;
      if (!a || !Rich.isEngAtom(a)) return false;
    }
    const eu = engUi();
    return !!eu && eu.keyAdjacent(ev);
  }

  // ---------------------------------------------------------------- history / bulk / report / backlinks (Stage 08)

  /** Lazily mounts the history UI (hq-carnet-history-ui.js). Nothing is built until it is opened; the server stays the authority. */
  function historyUi() {
    if (ui.hx) return ui.hx;
    const H = global.HqCarnetHistoryUi;
    if (!H || typeof H.mount !== "function") {
      flashMsg("Module historique non chargé");
      return null;
    }
    const core = () => ui.core;
    const curInfo = (e) => (e ? { id: e.id, rev: e.serverRev, dirty: !!(core().isDirty(e) || e.inflight || e.conflict), trashed: core().isTrashed(e) } : null);
    ui.hx = H.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { get: (url) => apiCall(url, { timeoutMs: 12000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      roots: EXPORT_ROOTS,
      storage: safeStorage,
      draftPrefix: DRAFT_PREFIX,
      current: () => {
        const c = core();
        return c ? curInfo(c.current()) : null;
      },
      pageRev: (id) => {
        const c = core();
        return c ? curInfo(c.entry(id)) : null;
      },
      scope: () => {
        const c = core();
        if (!c) return { label: "", items: [] };
        const sel = Object.assign({}, ui.lib.sel, { query: ui.lib.query });
        const res = selectPages(c.libraryItems(), sel, Date.now());
        const items = [];
        for (const g of res.groups) for (const i of g.items) items.push({ id: i.id, title: i.title, dirty: !!i.dirty, deleted: !!i.deleted });
        let label = "";
        if (sel.filter === "project") label = nameOf(c.st.projects, sel.id);
        else if (sel.filter === "category") label = nameOf(c.st.categories, sel.id);
        else if (sel.filter === "trash") label = "Corbeille";
        return { label, items };
      },
      projects: () => (core() ? core().st.projects.filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string" && !p.archived) : []),
      categories: () => (core() ? core().st.categories.filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string") : []),
      blocks: () => {
        const c = core();
        const e = c && c.current();
        const content = e && e.latest ? e.latest.content : null;
        const out = [];
        if (content && content.version === 2 && Array.isArray(content.blocks)) {
          for (const b of content.blocks) {
            if (!isObj(b) || typeof b.id !== "string") continue;
            if (b.type === "measure" && isObj(b.measure)) out.push({ id: b.id, type: "measure", label: String(b.measure.label || "mesure").slice(0, 60) });
            else if (b.type === "decision") out.push({ id: b.id, type: "decision", label: String(b.text || "décision").slice(0, 60) });
            else if (b.type === "image" && isObj(b.asset)) out.push({ id: b.id, type: "photo", label: String(b.asset.caption || "image").slice(0, 60) });
            else if (b.type === "drawing" && isObj(b.drawing) && typeof b.drawing.id === "string") out.push({ id: b.id, type: "drawing", label: Rich.Struct.drawingLabel(b.drawing.id).slice(0, 60) });
            else if (b.type === "imagegroup" && isObj(b.group) && Array.isArray(b.group.items)) out.push({ id: b.id, type: "photo", label: ("groupe de " + b.group.items.length + " images").slice(0, 60) });
          }
        }
        return out.slice(0, 100);
      },
      refresh: () => (core() ? core().refreshFull() : Promise.resolve([])),
      openNote: (id) => {
        const c = core();
        if (c && c.entry(id) && !c.isTrashed(c.entry(id))) {
          openPage(id);
          return true;
        }
        return false;
      },
      onClose: () => {}, // focus returns to the control that opened the dialog (never stolen by the editor)
    });
    return ui.hx;
  }

  function openHistory(tab, opener) {
    const h = historyUi();
    if (h) h.open(tab, opener || null);
  }

  // ---------------------------------------------------------------- engineering intelligence (Phase 5)

  /** Navigation only (never a mutation): opens the page through the library's own openPage and reveals the block. Resolves false when it is gone. */
  async function gotoBlock(pageId, blockId) {
    if (!blockId) {
      const c = ui.core;
      if (c && c.entry(pageId) && !c.isTrashed(c.entry(pageId))) {
        openPage(pageId);
        return true;
      }
      flashMsg(POLISH_MSG.pageGone, 3500);
      return false;
    }
    const r = await applyAnchor({ pageId, blockId });
    return r === "ok";
  }

  /** Lazily mounts the Phase-5 cockpit UI (hq-carnet-intel-ui.js). The server derives every number; this holds no project state. */
  function intelUi() {
    if (ui.intel) return ui.intel;
    const M = global.HqCarnetIntelUi;
    if (!M || typeof M.mount !== "function") {
      flashMsg("Module cockpit non chargé");
      return null;
    }
    const core = () => ui.core;
    ui.intel = M.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { get: (url) => apiCall(url, { timeoutMs: 20000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      projects: () => (core() ? core().st.projects.filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string" && !p.archived) : []),
      currentProjectId: () => {
        const c = core();
        if (!c) return null;
        const e = c.current();
        const pid = e ? (e.latest || e.server || {}).project_id || null : null;
        if (pid) return pid;
        return ui.lib && ui.lib.sel && ui.lib.sel.filter === "project" ? ui.lib.sel.id : null;
      },
      currentPage: () => {
        const c = core();
        const e = c && c.current();
        if (!e) return null;
        return { id: e.id, rev: e.serverRev, project_id: (e.latest || e.server || {}).project_id || null, dirty: !!(c.isDirty(e) || e.inflight || e.conflict) };
      },
      editorEl: () => ui.editor || null,
      goto: gotoBlock,
      openNote: (id) => {
        const c = core();
        if (c && c.entry(id) && !c.isTrashed(c.entry(id))) {
          openPage(id);
          return true;
        }
        return false;
      },
      addToReport: (item) => {
        const h = historyUi();
        return !!(h && h.addExternal && h.addExternal(item));
      },
      addToReview: (item, opener) => addToReview(item, opener),
      onClose: () => {},
    });
    return ui.intel;
  }

  function openIntel(tab, opener) {
    const m = intelUi();
    if (m) m.open(tab, opener || null);
  }

  /** Lazily mounts Ask Carnet (hq-carnet-ask-ui.js): an evidence finder. Holds no state beyond the open dialog; saves nothing. */
  function askUi() {
    if (ui.ask) return ui.ask;
    const M = global.HqCarnetAskUi;
    if (!M || typeof M.mount !== "function") {
      flashMsg("Module preuves non chargé");
      return null;
    }
    const core = () => ui.core;
    ui.ask = M.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { get: (url) => apiCall(url, { timeoutMs: 20000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      projects: () => (core() ? core().st.projects.filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string" && !p.archived) : []),
      currentProjectId: () => {
        const c = core();
        if (!c) return null;
        const e = c.current();
        const pid = e ? (e.latest || e.server || {}).project_id || null : null;
        if (pid) return pid;
        return ui.lib && ui.lib.sel && ui.lib.sel.filter === "project" ? ui.lib.sel.id : null;
      },
      currentPage: () => {
        const c = core();
        const e = c && c.current();
        return e ? { id: e.id, project_id: (e.latest || e.server || {}).project_id || null } : null;
      },
      goto: gotoBlock,
      openReader: (spec) => openReader(spec),
      addToReport: (item) => {
        const h = historyUi();
        return !!(h && h.addExternal && h.addExternal(item));
      },
      addToReview: (item, opener) => addToReview(item, opener),
      onClose: () => {},
    });
    return ui.ask;
  }

  function openAsk(opener, prefill) {
    const m = askUi();
    if (m) m.open(opener || null, prefill || null);
  }

  /** Lazily mounts the Phase-7 review packs UI (hq-carnet-reviews-ui.js). Packs live on the server; this holds only the open dialog. */
  function reviewsUi() {
    if (ui.reviews) return ui.reviews;
    const M = global.HqCarnetReviewsUi;
    if (!M || typeof M.mount !== "function") {
      flashMsg("Module revues non chargé");
      return null;
    }
    const core = () => ui.core;
    ui.reviews = M.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { get: (url) => apiCall(url, { timeoutMs: 20000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      storage: safeStorage,
      online: () => !(global.navigator && global.navigator.onLine === false),
      rng: () => {
        const bytes = new Uint8Array(16);
        if (global.crypto && typeof global.crypto.getRandomValues === "function") global.crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        return bytes;
      },
      currentProjectId: () => {
        const c = core();
        if (!c) return null;
        const e = c.current();
        const pid = e ? (e.latest || e.server || {}).project_id || null : null;
        if (pid) return pid;
        return ui.lib && ui.lib.sel && ui.lib.sel.filter === "project" ? ui.lib.sel.id : null;
      },
      openAsk: (question, scope, opener) => openAsk(opener || null, { question, scope }),
      openReader: (spec) => openReader(spec),
      verifications: verificationsUi(),
      reasoning: reasoningUi(),
      addToReport: (item) => {
        const h = historyUi();
        return !!(h && h.addExternal && h.addExternal(item));
      },
      onClose: () => {},
    });
    return ui.reviews;
  }

  function openReviews(opener) {
    const m = reviewsUi();
    if (m) m.open(opener || null, null);
  }

  /** "Ajouter au dossier de revue" from the cockpit / Ask: ``item`` = {spec, label} built by HqCarnetReviews (identity only). */
  function addToReview(item, opener) {
    const m = reviewsUi();
    return !!(m && m.addItem(item, opener || null));
  }

  // ---------------------------------------------------------------- sources / citations (Stage 05)

  /** Lazily mounts the sources UI (hq-carnet-sources.js). The editor state machine stays the single writer. */
  function sourcesUi() {
    if (ui.sources) return ui.sources;
    const S = global.HqCarnetSources;
    if (!S || typeof S.mount !== "function") {
      flashMsg("Module sources non chargé");
      return null;
    }
    ui.sources = S.mount({
      doc,
      root: (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      user: () => ui.user,
      storage: safeStorage,
      api: { get: (url) => apiCall(url, { timeoutMs: 12000 }), post: (payload) => request(payload) },
      flash: flashMsg,
      editor: {
        entry: curEntry,
        current: () => (ui.core ? ui.core.current() : null),
        sel: currentSel,
        commit: commitLines,
        projectId: () => {
          const e = ui.core && ui.core.current();
          return e && e.local && e.local.project_id ? e.local.project_id : null;
        },
      },
      openReader: (spec) => openReader(spec),
      onClose: (refocus) => {
        if (refocus && finePointer()) focusEditor(false);
      },
    });
    return ui.sources;
  }

  // ---------------------------------------------------------------- Reader (Phase 9): inspection + navigation only, nothing persisted

  /** The page the Reader was opened from, as parsed from the editor (real block ids only): citations + portal payloads. Read-only. */
  function readerPage() {
    const e = ui.core && ui.core.current();
    if (!e || !ui.editor) return null;
    const lines = Rich.parseEditor(ui.editor);
    return {
      id: e.id,
      blocks: lines.filter((l) => Rich.isRealId(l.id)).map((l) => ({ id: l.id, type: l.type, marks: l.marks, portal: l.type === "portal" && l.struct ? { ref: l.struct.ref } : null })),
    };
  }

  /** Live annotations panel factory (Phase 10): commentary attached to evidence. Optional: the Reader works without it. */
  function annotationsUi() {
    if (ui.annotations) return ui.annotations;
    const M = global.HqCarnetAnnotationsUi;
    if (!M || typeof M.mount !== "function") return null;
    ui.annotations = M.mount({ doc, api: { post: (payload) => request(payload) }, online: () => !(global.navigator && global.navigator.onLine === false), crypto: global.crypto });
    return ui.annotations;
  }

  /** Verification workspace + related-verifications panel (Phase 11). Optional: the Reader and the Review Pack work without it. Workflow records only: nothing here edits evidence. */
  function verificationsUi() {
    if (ui.verifications) return ui.verifications;
    const M = global.HqCarnetVerificationsUi;
    if (!M || typeof M.mount !== "function") return null;
    ui.verifications = M.mount({
      doc,
      root: () => (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { post: (payload) => request(payload) },
      online: () => !(global.navigator && global.navigator.onLine === false),
      crypto: global.crypto,
      projects: () => {
        const c = ui.core;
        return c && c.st && Array.isArray(c.st.projects) ? c.st.projects.filter((p) => isObj(p)).map((p) => ({ id: p.id, name: p.name })) : [];
      },
      openReader: (spec) => openReader(spec),
      onClose: () => {},
    });
    return ui.verifications;
  }

  function openVerifications(opener) {
    const m = verificationsUi();
    if (!m) {
      flashMsg("Module vérifications non chargé");
      return;
    }
    m.open(opener || null, null);
  }

  /** Decisions & assumptions register (Phase 12). Optional: the Reader and the Review Pack work without it. A record is never evidence and never edits evidence. */
  function reasoningUi() {
    if (ui.reasoning) return ui.reasoning;
    const M = global.HqCarnetReasoningUi;
    if (!M || typeof M.mount !== "function") return null;
    ui.reasoning = M.mount({
      doc,
      root: () => (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { post: (payload) => request(payload) },
      online: () => !(global.navigator && global.navigator.onLine === false),
      crypto: global.crypto,
      projects: () => {
        const c = ui.core;
        return c && c.st && Array.isArray(c.st.projects) ? c.st.projects.filter((p) => isObj(p)).map((p) => ({ id: p.id, name: p.name })) : [];
      },
      openReader: (spec) => openReader(spec),
      openVerification: (spec) => {
        const v = verificationsUi();
        if (v) v.openDetail(spec.id, spec.trigger || null);
      },
      onClose: () => {},
    });
    return ui.reasoning;
  }

  function openReasoning(opener) {
    const m = reasoningUi();
    if (!m) {
      flashMsg("Module registre non chargé");
      return;
    }
    m.open(opener || null, null);
  }

  /** The project of what is on screen, for creating a register record from the Reader. */
  function currentProjectNow() {
    const c = ui.core;
    if (!c) return null;
    const e = c.current();
    const pid = e ? (e.latest || e.server || {}).project_id || null : null;
    if (pid) return pid;
    return ui.lib && ui.lib.sel && ui.lib.sel.filter === "project" ? ui.lib.sel.id : null;
  }

  function readerUi() {
    if (ui.reader) return ui.reader;
    const M = global.HqCarnetReaderUi;
    if (!M || typeof M.mount !== "function") {
      flashMsg("Lecteur non chargé");
      return null;
    }
    ui.reader = M.mount({
      doc,
      annotations: annotationsUi(),
      verifications: verificationsUi(),
      reasoning: reasoningUi(),
      currentProjectId: () => currentProjectNow(),
      root: () => (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { post: (payload) => request(payload) },
      page: readerPage,
      goto: async (pageId, blockId) => {
        const s = ui.sources;
        if (s && s.isOpen && s.isOpen()) s.close(false); // the Sources dialog that opened the Reader is left too: no stranded dialog
        const ok = await gotoBlock(pageId, blockId); // navigation only; a gone block falls back to the page with the usual message
        const w = ok && ui.editor ? ui.editor.querySelector('[data-carnet-block-id="' + blockId + '"] [data-carnet-citation], [data-carnet-block-id="' + blockId + '"][data-carnet-citation]') : null;
        if (w && typeof w.focus === "function") w.focus({ preventScroll: true });
      },
    });
    return ui.reader;
  }

  /** Opens the Reader for ONE piece of evidence ({sourceId, citation?, context?, origin?, trigger?}). Never mutates anything. */
  function openReader(spec) {
    const r = readerUi();
    return !!(r && r.open(spec));
  }

  function openCitePicker() {
    const s = sourcesUi();
    if (!s) return;
    const sel = currentSel(); // the caret/selection BEFORE the picker takes focus
    ui.selCache = { start: sel.start, end: sel.end };
    s.openPicker(null);
  }

  /** Citation under a rendered wrapper: {cite, start, end, readonly} from the parsed model (never from the DOM payload). */
  function openCitationElement(node) {
    const s = sourcesUi();
    if (!s) return;
    const map = new Map();
    const lines = Rich.parseEditor(ui.editor, map);
    const first = doc.createTreeWalker(node, 4).nextNode();
    if (!first || !map.has(first)) return;
    const p = map.get(first);
    const hit = Rich.citationAt(lines, Rich.lineStarts(lines)[p.line] + p.off);
    if (!hit) return;
    ui.selCache = { start: hit.end, end: hit.end }; // a new citation made from the viewer goes AFTER this one, never over it
    if (curEntry()) setSel(hit.end, hit.end);
    const cur = ui.core && ui.core.current();
    const bid = lines[p.line] && Rich.isRealId(lines[p.line].id) ? lines[p.line].id : null;
    s.openCitation({ cite: hit.mark.cite, start: hit.start, end: hit.end, readonly: !curEntry(), origin: cur && bid ? { kind: "citation", pageId: cur.id, blockId: bid } : null, trigger: node });
  }

  // ---------------------------------------------------------------- find / replace (current note only)

  function buildFindPanel() {
    const q = el("input", {
      type: "search", id: "hq-carnet-find-input", class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      "aria-label": "Rechercher dans la page", placeholder: "Rechercher", enterkeyhint: "search",
    });
    const r = el("input", {
      type: "text", id: "hq-carnet-replace-input", class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      "aria-label": "Remplacer par (vide = supprimer)", placeholder: "Remplacer par (vide = supprimer)", enterkeyhint: "done",
    });
    const count = el("span", { id: "carnet-find-count", class: "carnet-find-count", role: "status", "aria-live": "polite" });
    const btn = (id, text, label) => el("button", { type: "button", id, class: "carnet-small", "aria-label": label || text, text });
    const caseBtn = el("button", { type: "button", id: "btn-carnet-find-case", class: "carnet-small", "aria-pressed": "false", "aria-label": "Respecter la casse", title: "Respecter la casse", text: "Aa" });
    const wordBtn = el("button", { type: "button", id: "btn-carnet-find-word", class: "carnet-small", "aria-pressed": "false", "aria-label": "Mot entier", title: "Mot entier", text: "Mot" });
    const undo = el("button", { type: "button", id: "btn-carnet-replace-undo", class: "carnet-small", hidden: true, text: "Annuler" });
    const panel = el("div", { id: "hq-carnet-find", class: "carnet-panel", role: "search", "aria-label": "Rechercher et remplacer", hidden: true }, [
      el("div", { class: "carnet-panel-row" }, [q, caseBtn, wordBtn]),
      el("div", { class: "carnet-panel-row" }, [
        btn("btn-carnet-find-prev", "‹", "Résultat précédent"),
        btn("btn-carnet-find-next", "›", "Résultat suivant"),
        count,
      ]),
      el("div", { class: "carnet-panel-row" }, [r]),
      el("div", { class: "carnet-panel-row" }, [
        btn("btn-carnet-replace-one", "Remplacer"),
        btn("btn-carnet-replace-all", "Tout remplacer"),
        undo,
        btn("btn-carnet-find-close", "Fermer"),
      ]),
    ]);
    q.addEventListener("input", () => {
      ui.find.q = q.value;
      ui.find.index = -1;
      findRefresh();
      findStep(1, true);
    });
    r.addEventListener("input", () => {
      ui.find.r = r.value;
    });
    q.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        findStep(ev.shiftKey ? -1 : 1);
      }
    });
    panel.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!b) return;
      const id = b.id;
      if (id === "btn-carnet-find-next") findStep(1);
      else if (id === "btn-carnet-find-prev") findStep(-1);
      else if (id === "btn-carnet-find-case") {
        ui.find.caseSensitive = !ui.find.caseSensitive;
        b.setAttribute("aria-pressed", ui.find.caseSensitive ? "true" : "false");
        ui.find.index = -1;
        findRefresh();
      } else if (id === "btn-carnet-find-word") {
        ui.find.wholeWord = !ui.find.wholeWord;
        b.setAttribute("aria-pressed", ui.find.wholeWord ? "true" : "false");
        ui.find.index = -1;
        findRefresh();
      } else if (id === "btn-carnet-replace-one") replaceOne();
      else if (id === "btn-carnet-replace-all") replaceAll();
      else if (id === "btn-carnet-replace-undo") undoReplaceAll();
      else if (id === "btn-carnet-find-close") toggleFind(false);
    });
    return panel;
  }

  function toggleFind(force) {
    const f = ui.find;
    f.open = typeof force === "boolean" ? force : !f.open;
    const panel = doc.getElementById("hq-carnet-find");
    if (panel) panel.hidden = !f.open;
    const btn = doc.getElementById("btn-carnet-find");
    if (btn) btn.setAttribute("aria-expanded", f.open ? "true" : "false");
    if (f.open) {
      const sel = readSel();
      const input = doc.getElementById("hq-carnet-find-input");
      if (sel && sel.start !== sel.end && sel.lines && Rich.flat(sel.lines).slice(sel.start, sel.end).indexOf("\n") < 0 && sel.end - sel.start <= 100) {
        f.q = Rich.flat(sel.lines).slice(sel.start, sel.end);
        input.value = f.q;
      }
      findRefresh();
      input.focus({ preventScroll: true });
    } else {
      findPaint([]);
    }
  }

  function findLines() {
    const e = ui.core && ui.core.current();
    return e ? localLines(e.local) : Rich.plainLines("");
  }

  /** Recompute matches against the current editable state (never against stale DOM). */
  function findRefresh() {
    const f = ui.find;
    if (!f.open && !f.q) return;
    const lines = findLines();
    f.matches = f.open && f.q ? Rich.findAll(lines, f.q, { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord }) : [];
    if (f.index >= f.matches.length) f.index = f.matches.length - 1;
    findUpdateUi();
    findPaint(f.matches);
  }

  function findUpdateUi() {
    const f = ui.find;
    const n = f.matches.length;
    const count = doc.getElementById("carnet-find-count");
    if (!count) return;
    if (!f.q) count.textContent = "";
    else if (!n) count.textContent = MSG.findNone;
    else count.textContent = (f.index >= 0 ? f.index + 1 + " / " : "") + n + (n > 1 ? " occurrences" : " occurrence");
    const all = doc.getElementById("btn-carnet-replace-all");
    const one = doc.getElementById("btn-carnet-replace-one");
    const e = ui.core && ui.core.current();
    const ro = !e || isReadOnly(e);
    if (all) {
      all.textContent = n > 1 ? "Tout remplacer (" + n + ")" : "Tout remplacer";
      all.disabled = ro || !n;
    }
    if (one) one.disabled = ro || !n;
    const u = f.undo;
    const undo = doc.getElementById("btn-carnet-replace-undo");
    if (undo) undo.hidden = !u;
  }

  function findPaint(matches) {
    // CSS Custom Highlight API where available (no DOM change); the current match also becomes the selection.
    try {
      if (!global.CSS || !global.CSS.highlights || typeof global.Highlight !== "function") return;
      global.CSS.highlights.delete("carnet-find");
      global.CSS.highlights.delete("carnet-find-current");
      if (!matches.length || !ui.editor) return;
      const map = new Map();
      const lines = Rich.parseEditor(ui.editor, map);
      const all = [];
      let cur = null;
      matches.forEach((m, i) => {
        const a = Rich.offsetToPoint(ui.editor, lines, m.start, map);
        const b = Rich.offsetToPoint(ui.editor, lines, m.end, map);
        const r = doc.createRange();
        r.setStart(a.node, a.off);
        r.setEnd(b.node, b.off);
        if (i === ui.find.index) cur = r;
        else all.push(r);
      });
      if (all.length) global.CSS.highlights.set("carnet-find", new global.Highlight(...all));
      if (cur) global.CSS.highlights.set("carnet-find-current", new global.Highlight(cur));
    } catch (_) {}
  }

  function findStep(dir, quiet) {
    const f = ui.find;
    findRefresh();
    const n = f.matches.length;
    if (!n) return;
    f.index = f.index < 0 ? (dir > 0 ? 0 : n - 1) : (f.index + dir + n) % n;
    findUpdateUi();
    findPaint(f.matches);
    const m = f.matches[f.index];
    if (!quiet || finePointer()) {
      // Bring the match into view and select it. The caret is only moved when the editor already owns focus.
      const focused = doc.activeElement === ui.editor;
      if (focused || !global.CSS || !global.CSS.highlights) setSel(m.start, m.end);
      try {
        const map = new Map();
        const lines = Rich.parseEditor(ui.editor, map);
        const p = Rich.offsetToPoint(ui.editor, lines, m.start, map);
        const node = p.node.nodeType === 3 ? p.node.parentElement : p.node;
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
      } catch (_) {}
    }
  }

  function replaceOne() {
    const f = ui.find;
    const e = curEntry();
    if (!e) return;
    findRefresh();
    if (!f.matches.length) return;
    const at = f.index >= 0 ? f.index : 0;
    const m = f.matches[at];
    const next = Rich.replaceMatches(findLines(), [m], f.r);
    f.undo = null;
    if (commitLines(next, null)) {
      f.index = at - 1; // the next occurrence becomes current
      findRefresh();
      findStep(1);
    }
  }

  function replaceAll() {
    const f = ui.find;
    const e = curEntry();
    if (!e) return;
    findRefresh();
    const n = f.matches.length;
    if (!n) return;
    const lines = findLines();
    const before = { text: Rich.flat(lines), fmt: Rich.fmtOf(lines) };
    const next = Rich.replaceMatches(lines, f.matches, f.r);
    if (!commitLines(next, null)) return;
    f.undo = { id: e.id, before, after: { text: Rich.flat(next), fmt: Rich.fmtOf(next) }, count: n };
    f.index = -1;
    findRefresh();
    const count = doc.getElementById("carnet-find-count");
    if (count) count.textContent = n + (n > 1 ? " occurrences " : " occurrence ") + (f.r ? "remplacées" : "supprimées");
    const undo = doc.getElementById("btn-carnet-replace-undo");
    if (undo) undo.hidden = false;
  }

  function undoReplaceAll() {
    const f = ui.find;
    const u = f.undo;
    const c = ui.core;
    const e = c && c.current();
    f.undo = null;
    if (!u || !e || e.id !== u.id || isReadOnly(e) || e.local.text !== u.after.text || e.local.fmt !== u.after.fmt) {
      findUpdateUi();
      return;
    }
    if (c.edit(e.id, { text: u.before.text, fmt: u.before.fmt })) renderEditor(localLines(e.local));
    f.index = -1;
    findRefresh();
    flashMsg("Remplacement annulé");
  }

  /** Any edit that is not the replace-all itself invalidates its Undo (never overwrite newer work). */
  function findEdited() {
    const f = ui.find;
    const e = ui.core && ui.core.current();
    if (f.undo && (!e || e.id !== f.undo.id || e.local.text !== f.undo.after.text || e.local.fmt !== f.undo.after.fmt)) f.undo = null;
    findRefresh();
  }

  // ---------------------------------------------------------------- export

  function exportUser() {
    return ui.user || "";
  }

  function readExports() {
    try {
      const raw = safeStorage().getItem(EXPORT_PREFIX + encodeURIComponent(exportUser()));
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" && v.version === 1 && v.pages && typeof v.pages === "object" ? v.pages : {};
    } catch (_) {
      return {};
    }
  }

  function rememberExport(id, rec) {
    try {
      const pages = readExports();
      pages[id] = rec;
      safeStorage().setItem(EXPORT_PREFIX + encodeURIComponent(exportUser()), JSON.stringify({ version: 1, pages }));
    } catch (_) {} // remembering is a convenience only
  }

  /** "Modifié depuis l'export": the page moved past the exported revision, or has unsaved edits. */
  function exportIsStale(e) {
    if (!e) return false;
    const rec = readExports()[e.id];
    if (!rec || !Number.isInteger(rec.rev)) return false;
    const srv = e.latest || e.server || {};
    return srv.rev !== rec.rev || ui.core.isDirty(e);
  }

  function buildExportPanel() {
    const msg = el("p", { id: "carnet-export-msg", class: "carnet-msg", role: "status", "aria-live": "polite" });
    const stale = el("p", { id: "carnet-export-stale", class: "carnet-msg carnet-export-stale", hidden: true, text: MSG.exportStale });
    const root = el("select", { id: "hq-carnet-export-root", class: "carnet-input", "aria-label": "Dossier Transfert" });
    for (const r of EXPORT_ROOTS) root.appendChild(el("option", { value: r, text: r }));
    const sub = el("input", {
      type: "text", id: "hq-carnet-export-sub", class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      placeholder: "Sous-dossier (facultatif)", "aria-label": "Sous-dossier facultatif",
    });
    const name = el("input", {
      type: "text", id: "hq-carnet-export-name", class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      "aria-label": "Nom du fichier",
    });
    const fmt = el("select", { id: "hq-carnet-export-format", class: "carnet-input", "aria-label": "Format" }, [
      el("option", { value: "md", text: "Markdown (.md)" }),
      el("option", { value: "txt", text: "Texte (.txt)" }),
    ]);
    const form = el("div", { id: "hq-carnet-export-form", class: "carnet-export-form", hidden: true }, [
      el("div", { class: "carnet-panel-row" }, [root, sub]),
      el("div", { class: "carnet-panel-row" }, [name, fmt]),
      el("div", { class: "carnet-panel-row" }, [
        el("button", { type: "button", id: "btn-carnet-export-save", class: "carnet-small", text: "Enregistrer la copie" }),
      ]),
    ]);
    const copy = el("button", { type: "button", id: "btn-carnet-export-copy", class: "carnet-small", "aria-expanded": "false", text: "Enregistrer une copie dans Transfert…" });
    const panel = el("div", { id: "hq-carnet-export", class: "carnet-panel", role: "group", "aria-label": "Exporter", hidden: true }, [
      el("div", { class: "carnet-panel-row" }, [
        el("button", { type: "button", id: "btn-carnet-export-txt", class: "carnet-small", "data-carnet-export": "txt", text: "Télécharger .txt" }),
        el("button", { type: "button", id: "btn-carnet-export-md", class: "carnet-small", "data-carnet-export": "md", text: "Télécharger .md" }),
        el("button", { type: "button", id: "btn-carnet-export-print", class: "carnet-small", "data-carnet-export": "print", text: "Imprimer / PDF" }),
      ]),
      el("div", { class: "carnet-panel-row" }, [copy]),
      form,
      stale,
      el("p", { id: "carnet-export-images", class: "hint carnet-export-images", hidden: true, text: "Cette page contient des images : « Enregistrer une copie dans Transfert » (Markdown) les joint dans un dossier .assets ; le .md téléchargé les remplace par un libellé, le .txt aussi." }),
      msg,
      el("div", { class: "carnet-panel-row" }, [el("button", { type: "button", id: "btn-carnet-export-close", class: "carnet-small", text: "Fermer" })]),
    ]);
    let nameTouched = false;
    name.addEventListener("input", () => {
      nameTouched = true;
    });
    fmt.addEventListener("change", () => {
      if (!nameTouched) name.value = exportName("");
    });
    panel.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!b) return;
      const kind = b.getAttribute("data-carnet-export");
      if (kind === "txt" || kind === "md") downloadExport(kind);
      else if (kind === "print") printPage();
      else if (b.id === "btn-carnet-export-copy") {
        form.hidden = !form.hidden;
        b.setAttribute("aria-expanded", form.hidden ? "false" : "true");
        if (!form.hidden && !nameTouched) name.value = exportName("");
      } else if (b.id === "btn-carnet-export-save") exportCopy();
      else if (b.id === "btn-carnet-export-close") toggleExport(false);
    });
    return panel;
  }

  function exportTitle() {
    const e = ui.core && ui.core.current();
    return e ? deriveTitle(e.local.text) : UNTITLED;
  }

  function exportName(typed) {
    const fmtSel = doc.getElementById("hq-carnet-export-format");
    return Rich.exportFilename(typed, exportTitle(), fmtSel ? fmtSel.value : "md");
  }

  function toggleExport(force) {
    ui.exportOpen = typeof force === "boolean" ? force : !ui.exportOpen;
    const panel = doc.getElementById("hq-carnet-export");
    if (panel) panel.hidden = !ui.exportOpen;
    const btn = doc.getElementById("btn-carnet-export");
    if (btn) btn.setAttribute("aria-expanded", ui.exportOpen ? "true" : "false");
    renderExportState();
  }

  function renderExportState() {
    const e = ui.core && ui.core.current();
    const stale = !!e && exportIsStale(e);
    const s = doc.getElementById("carnet-export-stale");
    if (s) s.hidden = !(stale && ui.exportOpen);
    const flag = doc.getElementById("carnet-export-flag");
    if (flag) flag.hidden = !stale;
    const hint = doc.getElementById("carnet-export-images");
    if (hint) hint.hidden = !(ui.exportOpen && e && Rich.assetsOf(localLines(e.local)).length > 0);
  }

  // ---------------------------------------------------------------- Stage 06: note images
  //
  // Every image mutation goes through the SAME path as typing: lines -> c.edit() (draft + generation +
  // autosave + revision/conflict handling). The tools are bound to {page, block, asset}; each mutation
  // re-reads the CURRENT state and refuses when that exact object is gone or was changed elsewhere.
  // The browser resizes/re-encodes (hq-carnet-media.js); the server only validates and bounds.

  const Media = global.HqCarnetMedia || null;

  function imgSig(a) {
    return a.id + "|" + a.width + "|" + a.layout + "|" + a.caption;
  }

  function imgFind(lines, blockId, e) {
    const alias = (e && e.alias) || {};
    const want = [blockId, alias[blockId]].filter(Boolean);
    return lines.findIndex((l) => l.id && want.indexOf(l.id) >= 0);
  }

  function imgNote(text, isError) {
    const n = doc.getElementById("carnet-image-msg");
    if (n) {
      n.textContent = text || "";
      n.setAttribute("data-kind", isError ? "error" : "info");
    }
    if (text && !(ui.image.panelOpen && n)) flashMsg(text);
  }

  function buildImagePanel() {
    const I = ui.image;
    const msg = el("p", { id: "carnet-image-msg", class: "carnet-msg", role: "status", "aria-live": "polite" });
    const mkInput = (kind, accept, capture) => {
      const attrs = { type: "file", class: "carnet-file-input", accept, tabindex: "-1", "aria-hidden": "true", "data-carnet-image-input": kind };
      if (capture) attrs.capture = capture; // standards-based: a hint that mobile browsers may honour (desktop: plain file dialog)
      const input = el("input", attrs);
      input.addEventListener("change", onImageInput);
      return input;
    };
    const Mm = Media || { ACCEPT: "image/jpeg,image/png,image/webp", ACCEPT_FILES: ".jpg,.jpeg,.png,.webp" };
    I.inputs = {
      camera: mkInput("camera", Mm.ACCEPT, "environment"),
      photos: mkInput("photos", Mm.ACCEPT),
      files: mkInput("files", Mm.ACCEPT_FILES),
    };
    const src = (id, kind, label) => {
      const b = el("button", { type: "button", id, class: "carnet-small", "data-carnet-image-source": kind, text: label });
      keepFocus(b);
      return b;
    };
    const panel = el("div", { id: "hq-carnet-image-panel", class: "carnet-panel", role: "group", "aria-label": "Insérer une image", hidden: true }, [
      el("div", { class: "carnet-panel-row" }, [
        src("btn-carnet-image-camera", "camera", "Appareil photo"),
        src("btn-carnet-image-photos", "photos", "Photos"),
        src("btn-carnet-image-files", "files", "Fichiers"),
      ]),
      el("p", { class: "hint carnet-image-hint", text: "JPEG, PNG ou WebP · réduite à 2560 px · 12 Mo max après réduction." }),
      msg,
      el("div", { class: "carnet-panel-row" }, [el("button", { type: "button", id: "btn-carnet-image-close", class: "carnet-small", text: "Fermer" })]),
      I.inputs.camera, I.inputs.photos, I.inputs.files,
    ]);
    panel.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!b) return;
      if (b.id === "btn-carnet-image-close") toggleImagePanel(false);
      else if (b.hasAttribute("data-carnet-image-source")) pickImage(b.getAttribute("data-carnet-image-source"), null);
    });
    return panel;
  }

  function buildImageTools() {
    const range = el("input", {
      type: "range", id: "carnet-image-width", min: String(Rich.ASSET_WIDTH_MIN), max: String(Rich.ASSET_WIDTH_MAX), step: "5", value: "100", "aria-label": "Largeur de l'image",
    });
    const out = el("output", { id: "carnet-image-width-out", class: "carnet-image-width-out", text: "100 %" });
    const caption = el("input", {
      type: "text", id: "carnet-image-caption", class: "carnet-input", maxlength: String(Rich.ASSET_CAPTION_MAX), autocomplete: "off", spellcheck: "true",
      placeholder: "Légende", "aria-label": "Légende de l'image",
    });
    const btn = (id, text, extra) => el("button", Object.assign({ type: "button", id, class: "carnet-small", text }, extra || {}));
    const ctl = (id, text, label, extra) => el("button", Object.assign({ type: "button", id, class: "carnet-small carnet-touch", text, "aria-label": label, "data-carnet-image-act": id.replace("btn-carnet-image-", "") }, extra || {}));
    const tools = el("div", { id: "hq-carnet-image-tools", class: "carnet-panel carnet-image-tools", role: "group", "aria-label": "Outils de l'image", "data-carnet-image-tools": "", hidden: true }, [
      el("div", { class: "carnet-panel-row carnet-image-act-row", role: "group", "aria-label": "Position" }, [
        ctl("btn-carnet-image-up", "↑ Monter", "Déplacer l'image vers le haut"),
        ctl("btn-carnet-image-down", "↓ Descendre", "Déplacer l'image vers le bas"),
        ctl("btn-carnet-image-smaller", "− Plus petite", "Réduire l'image"),
        ctl("btn-carnet-image-larger", "+ Plus grande", "Agrandir l'image"),
      ]),
      el("div", { class: "carnet-panel-row carnet-image-act-row", role: "group", "aria-label": "Alignement" }, [
        ctl("btn-carnet-image-left", "Gauche", "Aligner l'image à gauche", { "aria-pressed": "false" }),
        ctl("btn-carnet-image-center", "Centre", "Centrer l'image", { "aria-pressed": "false" }),
        ctl("btn-carnet-image-right", "Droite", "Aligner l'image à droite", { "aria-pressed": "false" }),
      ]),
      el("div", { class: "carnet-panel-row carnet-image-width-row" }, [
        el("label", { class: "carnet-image-width-label", for: "carnet-image-width", text: "Largeur" }), range, out,
      ]),
      el("div", { class: "carnet-panel-row" }, [caption]),
      el("div", { class: "carnet-panel-row" }, [
        ctl("btn-carnet-image-caption-focus", "Légende", "Modifier la légende de l'image"),
        btn("btn-carnet-image-replace", "Remplacer…", { "aria-label": "Remplacer l'image" }),
        btn("btn-carnet-image-group", "Grouper…", { "aria-label": "Grouper avec une ou deux autres images" }),
        ctl("btn-carnet-image-inspect", "Agrandir", "Agrandir l'image (zoom et déplacement, sans rien modifier)"),
        ctl("btn-carnet-image-annotate", "Annoter…", "Annoter l'image dans Dessiner (l'image d'origine reste inchangée)"),
        btn("btn-carnet-image-ocr", "Lire le texte…", { "aria-label": "Extraire le texte de l'image (reconnaissance locale)" }),
        btn("btn-carnet-image-remove", IMG_MSG.remove, { class: "carnet-small carnet-danger" }),
        btn("btn-carnet-image-done", "Terminé"),
      ]),
      el("p", { id: "carnet-image-tools-msg", class: "carnet-msg", role: "status", "aria-live": "polite" }),
    ]);
    range.addEventListener("input", () => imgMutate((a) => Object.assign({}, a, { width: clampWidth(range.value) })));
    caption.addEventListener("input", () => imgMutate((a) => Object.assign({}, a, { caption: cleanCaption(caption.value) })));
    caption.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        closeImageTools("", true);
      }
    });
    tools.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeImageTools("", true);
      }
    });
    tools.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!b) return;
      if (b.id === "btn-carnet-image-done") closeImageTools("", true);
      else if (b.id === "btn-carnet-image-replace") replaceSelectedImage();
      else if (b.id === "btn-carnet-image-group") structGroupSelected();
      else if (b.id === "btn-carnet-image-inspect") {
        const bnd = imgBound();
        if (bnd) inspectOpen({ kind: "image", assetId: bnd.lines[bnd.idx].asset.id, blockId: bnd.lines[bnd.idx].id || "" }, b);
      } else if (b.id === "btn-carnet-image-annotate") dessinerAnnotateSelected();
      else if (b.id === "btn-carnet-image-ocr") fieldRun("ocr", b);
      else if (b.id === "btn-carnet-image-remove") removeSelectedImage();
      else if (b.id === "btn-carnet-image-caption-focus") {
        caption.focus();
      } else if (b.id === "btn-carnet-image-up") imgNudge(-1);
      else if (b.id === "btn-carnet-image-down") imgNudge(1);
      else if (b.id === "btn-carnet-image-smaller") imgStep(-5);
      else if (b.id === "btn-carnet-image-larger") imgStep(5);
      else if (b.id === "btn-carnet-image-left") imgAlign("inline");
      else if (b.id === "btn-carnet-image-center") imgAlign("center");
      else if (b.id === "btn-carnet-image-right") imgAlign("right");
    });
    return tools;
  }

  function clampWidth(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return Rich.ASSET_WIDTH_MAX;
    return Math.max(Rich.ASSET_WIDTH_MIN, Math.min(Rich.ASSET_WIDTH_MAX, n));
  }

  function cleanCaption(v) {
    return Rich.cleanCaptionText(v);
  }

  function toggleImagePanel(force) {
    const I = ui.image;
    I.panelOpen = typeof force === "boolean" ? force : !I.panelOpen;
    const panel = doc.getElementById("hq-carnet-image-panel");
    if (panel) panel.hidden = !I.panelOpen;
    const btn = doc.getElementById("btn-carnet-image");
    if (btn) btn.setAttribute("aria-expanded", I.panelOpen ? "true" : "false");
    if (!I.panelOpen) I.origin = null;
    const msg = doc.getElementById("carnet-image-msg");
    if (msg && !I.busy) msg.textContent = "";
    refreshImageUi();
  }

  /** Where a new image goes, decided NOW (before any native picker/upload delay) and re-checked when it lands. */
  function imgCaptureTarget(e) {
    const lines = Rich.parseEditor(ui.editor);
    const total = Rich.flat(lines).length;
    const live = readSel();
    const c = ui.selCache;
    const pos = live ? live.end : c ? Math.min(c.end, total) : total;
    const at = Rich.locate(lines, pos);
    const line = lines[at.line];
    let mode = "after";
    if (line.type === "paragraph" && line.text === "") mode = "before"; // the blank line stays BELOW the image: keep typing there
    else if (line.type !== "image" && at.off === 0 && line.text !== "") mode = "before";
    return { pageId: e.id, mode, anchorId: line.id, replace: null };
  }

  function pickImage(kind, replace) {
    const I = ui.image;
    if (!Media) return imgNote(IMG_MSG.unavailable, true);
    const e = curEntry();
    if (!e) return imgNote(IMG_MSG.readonly, true);
    if (I.busy) return imgNote(IMG_MSG.busy, true);
    const origin = imgCaptureTarget(e);
    if (replace) {
      origin.replace = replace;
      origin.pageId = replace.pageId;
    } else if (Rich.assetsOf(localLines(e.local)).length >= Rich.IMAGES_PER_PAGE_MAX) {
      return imgNote(IMG_MSG.tooMany, true);
    }
    I.origin = origin;
    const input = I.inputs && I.inputs[kind];
    if (input) input.click();
  }

  function onImageInput(ev) {
    const input = ev.target;
    const file = input && input.files && input.files[0];
    if (input) input.value = ""; // the same file can be chosen again; the File object stays valid
    const origin = ui.image.origin;
    ui.image.origin = null;
    if (!file) return;
    imageFromFile(file, origin);
  }

  async function imageFromFile(file, origin) {
    const I = ui.image;
    if (!Media) return imgNote(IMG_MSG.unavailable, true);
    if (I.busy) return imgNote(IMG_MSG.busy, true);
    const e0 = curEntry();
    if (!origin || !e0 || e0.id !== origin.pageId) return imgNote(IMG_MSG.stalePage, true);
    I.busy = true;
    refreshImageUi();
    let asset;
    try {
      imgNote(IMG_MSG.prep);
      const prepared = await Media.prepare(file);
      imgNote(IMG_MSG.up);
      asset = await Media.upload(prepared.blob, apiCall);
    } catch (err) {
      I.busy = false;
      imgNote(Media.describeError(err), true);
      refreshImageUi();
      return;
    }
    I.busy = false;
    // Everything below re-reads the CURRENT state: nothing from before the await is trusted.
    const e = curEntry();
    if (!e || e.id !== origin.pageId) {
      imgNote(IMG_MSG.stalePage, true);
      refreshImageUi();
      return;
    }
    const lines = localLines(e.local);
    if (origin.replace) {
      const idx = imgFind(lines, origin.replace.blockId, e);
      if (idx < 0 || !lines[idx].asset || lines[idx].asset.id !== origin.replace.assetId) {
        imgNote(IMG_MSG.staleTool, true);
        refreshImageUi();
        return;
      }
      lines[idx].asset = Object.assign({}, lines[idx].asset, { id: asset.id, mime: asset.mime, w: asset.w, h: asset.h });
      const bound = ui.image.sel;
      const before = bound ? { sig: bound.sig, assetId: bound.assetId } : null;
      if (bound) {
        bound.assetId = asset.id;
        bound.sig = imgSig(lines[idx].asset);
      }
      if (imgCommit(lines, idx)) imgNote(IMG_MSG.replaced);
      else if (bound && before) Object.assign(bound, before);
      refreshImageUi();
      return;
    }
    const idx = imgFind(lines, origin.anchorId, e);
    if (idx < 0) {
      imgNote(IMG_MSG.staleAnchor, true);
      refreshImageUi();
      return;
    }
    if (Rich.assetsOf(lines).length >= Rich.IMAGES_PER_PAGE_MAX) {
      imgNote(IMG_MSG.tooMany, true);
      refreshImageUi();
      return;
    }
    const line = Rich.imageLine({ id: asset.id, mime: asset.mime, w: asset.w, h: asset.h, width: 100, layout: "inline", caption: "" });
    if (!line) {
      imgNote("Réponse du serveur invalide", true);
      refreshImageUi();
      return;
    }
    const at = origin.mode === "before" ? idx : idx + 1;
    lines.splice(at, 0, line);
    const after = lines[at + 1];
    if (!after || after.type === "image") lines.splice(at + 1, 0, Rich.newLine("", "paragraph")); // always a place to keep typing
    if (imgCommit(lines, null, true)) {
      imgNote(IMG_MSG.inserted);
      const dom = ui.editor.children[at];
      if (dom) selectImageLine(dom);
    }
    refreshImageUi();
  }

  /** One image edit = one state-machine edit. `index` set -> patch that image in place (no <img> churn). */
  function imgCommit(lines, index, forceRender) {
    const c = ui.core;
    const e = c && c.current();
    if (!e || isReadOnly(e)) return false;
    Rich.ensureKeys(lines);
    if (lines.length > Rich.BLOCKS_MAX && !Rich.isPlain(lines)) {
      flashMsg(MSG.tooManyLines);
      return false;
    }
    if (!c.edit(e.id, { text: Rich.flat(lines), fmt: Rich.fmtOf(lines), ids: Rich.idsOf(lines) })) {
      flashMsg("Modification refusée");
      return false;
    }
    let patched = false;
    if (!forceRender && index != null && ui.editor.children.length === lines.length) {
      patched = Rich.patchImage(ui.editor, index, lines[index].asset);
      if (patched && Rich.fmtOf(Rich.parseEditor(ui.editor)) !== Rich.fmtOf(lines)) patched = false;
    }
    if (!patched) renderEditor(lines);
    ui.pendingMarks = null;
    return true;
  }

  /** Validate the bound {page, block, asset} against the CURRENT entry. Returns {e, lines, idx} or null (tools are then closed). */
  function imgBound(notify) {
    const I = ui.image;
    const sel = I.sel;
    if (!sel) return null;
    const e = curEntry();
    if (!e || e.id !== sel.pageId) {
      closeImageTools("");
      return null;
    }
    const lines = localLines(e.local);
    const idx = imgFind(lines, sel.blockId, e);
    if (idx < 0 || !lines[idx].asset || lines[idx].asset.id !== sel.assetId) {
      closeImageTools(notify === false ? "" : IMG_MSG.staleTool);
      return null;
    }
    sel.blockId = lines[idx].id || sel.blockId;
    return { e, lines, idx };
  }

  function imgMutate(change) {
    const I = ui.image;
    const b = imgBound();
    if (!b) return false;
    const current = b.lines[b.idx].asset;
    if (imgSig(current) !== I.sel.sig) {
      // changed elsewhere since the tools last showed it: show the truth, apply nothing
      imgTools(b, true);
      imgToolsNote(IMG_MSG.staleTool);
      return false;
    }
    const next = Rich.checkAsset(change(Object.assign({}, current)));
    if (!next || next.id !== current.id) return false;
    b.lines[b.idx].asset = next;
    I.sel.sig = imgSig(next);
    I.sel.rev = b.e.serverRev;
    const ok = imgCommit(b.lines, b.idx);
    if (!ok) I.sel.sig = imgSig(current);
    return ok;
  }

  /** One-step controls (also the keyboard alternative to the pointer gestures). */
  function imgStep(delta) {
    const b = imgBound();
    if (!b) return;
    const w = b.lines[b.idx].asset.width;
    const next = clampWidth(w + delta);
    if (next === w) {
      imgToolsNote(delta < 0 ? "Taille minimale atteinte" : "Taille maximale atteinte");
      return;
    }
    if (imgMutate((a) => Object.assign({}, a, { width: next }))) imgToolsNote("Largeur : " + next + " %");
  }

  function imgAlign(layout) {
    const b = imgBound();
    if (!b) return;
    if (b.lines[b.idx].asset.layout === layout) return;
    if (imgMutate((a) => Object.assign({}, a, { layout }))) imgToolsNote(layout === "inline" ? "Aligné à gauche" : layout === "center" ? "Centré" : "Aligné à droite");
  }

  /** Reorder whole blocks: ids and content are untouched, only the order changes (one normal edit). */
  function imgMoveTo(toIndex, token) {
    const I = ui.image;
    const b = imgBound();
    if (!b) return false;
    if (token && !imgTokenValid(token)) return false;
    const to = Math.max(0, Math.min(b.lines.length - 1, toIndex));
    if (to === b.idx) return false;
    if (imgSig(b.lines[b.idx].asset) !== I.sel.sig) {
      imgTools(b, true);
      imgToolsNote(IMG_MSG.staleTool);
      return false;
    }
    const moved = b.lines.splice(b.idx, 1)[0];
    b.lines.splice(to, 0, moved);
    if (!imgCommit(b.lines, null, true)) return false;
    I.sel.rev = b.e.serverRev;
    imgToolsNote("Image déplacée : bloc " + (to + 1) + " sur " + b.lines.length);
    refreshImageUi();
    return true;
  }

  function imgNudge(dir) {
    const b = imgBound();
    if (!b) return;
    const to = b.idx + dir;
    if (to < 0 || to >= b.lines.length) {
      imgToolsNote(dir < 0 ? "Déjà en haut de la page" : "Déjà en bas de la page");
      return;
    }
    if (imgMoveTo(to, null)) {
      const fig = ui.editor.children[to] && ui.editor.children[to].querySelector("figure");
      const btn = doc.getElementById(dir < 0 ? "btn-carnet-image-up" : "btn-carnet-image-down");
      if (btn && !btn.disabled) btn.focus({ preventScroll: true });
      else if (fig) fig.focus({ preventScroll: true });
    }
  }

  /** A gesture's proof of "same state": page, revision, editor generation and the very DOM line. */
  function imgToken(lineEl) {
    const I = ui.image;
    const e = curEntry();
    if (!e || !I.sel || e.id !== I.sel.pageId || !ui.editor.contains(lineEl) || isReadOnly(e)) return null;
    const b = imgBound(false);
    if (!b || ui.editor.children[b.idx] !== lineEl) return null;
    return { pageId: e.id, rev: e.serverRev, gen: e.generation, lineEl, blockId: I.sel.blockId, assetId: I.sel.assetId, sig: I.sel.sig };
  }

  function imgTokenValid(t) {
    const e = curEntry();
    const I = ui.image;
    if (!t || !e || !I.sel || e.id !== t.pageId || e.serverRev !== t.rev || e.generation !== t.gen) return false;
    if (!t.lineEl.isConnected || !ui.editor.contains(t.lineEl)) return false;
    const b = imgBound(false);
    return !!b && ui.editor.children[b.idx] === t.lineEl && imgSig(b.lines[b.idx].asset) === t.sig;
  }

  // ---------------------------------------------------------------- Product Phase 4: Field Capture (HUD, scanner, OCR, voice)
  // The host side is thin: it owns the page, the single edit path and the target of an insertion. The capture surfaces live in
  // hq-carnet-field-ui.js; their pure decisions in hq-carnet-field.js. A capture never writes anything by itself: it ends in fieldInsert().

  /** Subscribers of network recovery (module UIs that mount lazily): the ONE global "online" listener below fans out to them. */
  const onlineSubs = [];

  function fieldUi() {
    if (ui.fieldUi) return ui.fieldUi;
    const M = global.HqCarnetFieldUi;
    const F = global.HqCarnetField;
    if (!M || typeof M.mount !== "function" || !F || !ui.root) return null;
    ui.fieldUi = M.mount({
      win: global,
      doc,
      onOnline: (fn) => onlineSubs.push(fn),
      field: F,
      rich: Rich,
      media: Media,
      api: (url, init) => apiCall(url, init),
      editable: () => !!curEntry(),
      status: (t, isErr) => flashMsg(t, isErr ? 4200 : 2600),
      focusEditor: () => focusEditor(false),
      command: (id) => runInsert(id),
      captureTarget: () => {
        const e = curEntry();
        return e ? imgCaptureTarget(e) : null;
      },
      afterTarget: (blockId) => {
        const e = curEntry();
        return e && blockId ? { pageId: e.id, mode: "after", anchorId: blockId, replace: null } : e ? imgCaptureTarget(e) : null;
      },
      selectedImage: () => {
        const b = imgBound(false);
        if (!b) return null;
        const l = b.lines[b.idx];
        return l && l.asset ? { asset: l.asset, blockId: l.id } : null;
      },
      limits: () => ({ page_blocks: Rich.BLOCKS_MAX, page_text_bytes: PAGE_TEXT_BYTES, derived_blocks_per_page: Rich.DERIVED_BLOCKS_PER_PAGE_MAX }),
      used: (extraBlocks) => {
        const e = curEntry();
        const lines = e ? localLines(e.local) : [];
        let derived = 0;
        for (const l of lines) if (l.from) derived += 1;
        return { blocks: lines.length + (extraBlocks | 0), bytes: utf8Bytes(Rich.flat(lines)), derived };
      },
      insert: (items, target) => fieldInsert(items, target),
    });
    return ui.fieldUi;
  }

  /** The three field commands (insert menu, "/", HUD). OCR needs a selected image; scan and voice need an editable page. */
  function fieldRun(key, opener) {
    const f = fieldUi();
    if (!f) return flashMsg("Capture terrain indisponible");
    if (!curEntry()) return flashMsg(IMG_MSG.readonly);
    const op = opener || doc.activeElement;
    if (key === "scan") f.openScanner(op);
    else if (key === "voice") f.openVoice(op);
    else f.openOcr(op);
  }

  /**
   * ONE logical mutation for a capture: every item (image, image group, voice block, derived paragraphs with provenance) is checked
   * and spliced in, then committed through the normal edit path ONCE. Any refusal (stale page, invalid item, a page limit)
   * changes nothing. Returns {ok} or {ok:false, reason, message}.
   */
  function fieldInsert(items, target) {
    const e = curEntry();
    if (!e || !target || e.id !== target.pageId) return { ok: false, reason: "stale" };
    const lines = localLines(e.local);
    const idx = imgFind(lines, target.anchorId, e);
    if (idx < 0) return { ok: false, reason: "stale" };
    const add = [];
    for (const it of items || []) {
      if (it.type === "image") add.push(Rich.imageLine(it.asset));
      else if (it.type === "imagegroup") add.push(it.payload ? Rich.structLine("imagegroup", it.payload) : null);
      else if (it.type === "voice") add.push(Rich.structLine("voice", it.payload));
      else if (it.type === "derived" && it.from && Array.isArray(it.chunks) && it.chunks.length) {
        for (const text of it.chunks) add.push(Rich.newLine(text, "paragraph", false, [], null, null, null, null, it.from));
      } else add.push(null);
    }
    if (!add.length || add.some((l) => !l)) return { ok: false, reason: "invalid", message: "Contenu invalide : rien n'a été inséré" };
    const at = target.mode === "before" ? idx : idx + 1;
    lines.splice(at, 0, ...add);
    const after = lines[at + add.length];
    if (!after || Rich.isAtom(after)) lines.splice(at + add.length, 0, Rich.newLine("", "paragraph"));
    const lim = Rich.structLimits(lines);
    if (lim) return { ok: false, reason: "limit", message: (STRUCT_LIMIT_MSG[lim] || "Limite de la page atteinte") + " : rien n'a été inséré" };
    if (lines.length > Rich.BLOCKS_MAX) return { ok: false, reason: "limit", message: MSG.tooManyLines + " : rien n'a été inséré" };
    if (utf8Bytes(Rich.flat(lines)) > PAGE_TEXT_BYTES) return { ok: false, reason: "limit", message: "La page deviendrait trop volumineuse : rien n'a été inséré" };
    return commitLines(lines, null) ? { ok: true } : { ok: false, reason: "refused", message: "Modification refusée : rien n'a été inséré" };
  }

  /** A derived paragraph's badge opened its source: the scan (OCR) or the voice note (transcript), by canonical identity only. */
  function derivedOpen(node) {
    const f = fieldUi();
    if (!f) return;
    const kind = node.getAttribute("data-carnet-derived-open");
    const id = node.getAttribute("data-carnet-source-id");
    if (kind === "ocr" || kind === "transcript") f.openSource(kind, id, node);
  }

  function imageUi() {
    if (ui.imageUi) return ui.imageUi;
    const M = global.HqCarnetImageUi;
    if (!M || typeof M.mount !== "function") return null;
    const cur = (t) => {
      const b = imgBound(false);
      return b ? b.lines[b.idx].asset : null;
    };
    ui.imageUi = M.mount({
      doc,
      editor: () => ui.editor,
      token: (lineEl) => imgToken(lineEl),
      valid: (t) => imgTokenValid(t),
      widthOf: (t) => (cur(t) ? cur(t).width : 100),
      layoutOf: (t) => (cur(t) ? cur(t).layout : "inline"),
      status: (text, isError) => {
        imgToolsNote(text);
        if (isError) flashMsg(text);
      },
      commitWidth: (t, width) => {
        if (imgTokenValid(t) && imgMutate((a) => Object.assign({}, a, { width: clampWidth(width) }))) imgToolsNote("Largeur : " + clampWidth(width) + " %");
        else refreshImageUi();
      },
      commitMove: (t, to) => {
        if (!imgMoveTo(to, t)) refreshImageUi();
      },
      nudge: (dir) => imgNudge(dir),
      raf: (fn) => (global.requestAnimationFrame ? global.requestAnimationFrame(fn) : setTimeout(fn, 16)),
      cancelRaf: (h) => (global.cancelAnimationFrame ? global.cancelAnimationFrame(h) : clearTimeout(h)),
    });
    return ui.imageUi;
  }


  // ---------------------------------------------------------------- Product Phase 2: structured blocks (table / callout / toggle / image group)

  const STRUCT_LIMIT_MSG = {
    tables: "Trop de tableaux sur la page (20 au maximum)",
    notes: "Trop d'encadrés et de sections sur la page (100 au maximum)",
    groups: "Trop de groupes d'images sur la page (16 au maximum)",
    images: "Trop d'images sur la page (32 au maximum)",
    bytes: "Trop de texte structuré sur la page",
    drawings: "Trop de croquis sur la page (32 au maximum)",
    voices: "Trop de notes vocales sur la page (32 au maximum)",
    portals: "Trop de portails sur la page (100 au maximum)",
    derived: "Trop de blocs de texte dérivé sur la page (600 au maximum)",
  };

  function structUi() {
    if (ui.structUi) return ui.structUi;
    const M = global.HqCarnetStructuredUi;
    if (!M || typeof M.mount !== "function" || !Rich.Struct) return null;
    ui.structUi = M.mount({
      doc,
      rich: Rich,
      editor: () => ui.editor,
      readOnly: () => !curEntry(),
      flash: flashMsg,
      timeout: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h),
      pageKey: () => {
        const e = ui.core && ui.core.current();
        return e ? e.id : "";
      },
      changed: (wrapper, opts) => structChanged(wrapper, opts || {}),
      remove: (wrapper) => structRemove(wrapper),
      ungroup: (wrapper, payload) => structUngroup(wrapper, payload),
      pickImages: (req) => structPick(req || {}),
      renderVoice: (w, p, i, b, ro) => {
        const f = fieldUi();
        if (f) f.renderVoice(w, p, i, b, ro);
      },
      renderPortal: (w, p, i, b, ro, api) => {
        const pu = portalsUi();
        if (pu) pu.render(w, p, i, b, ro, api);
      },
      openDrawing: (wrapper, stem) => dessinerOpen(wrapper, stem),
      inspect: (input, trigger) => inspectOpen(input, trigger),
      listDrawings: async () => {
        const d = await apiCall("/api/drawings", { timeoutMs: 12000 });
        return ((d && d.items) || []).map((it) => it && it.stem).filter((x) => typeof x === "string" && Rich.Struct.STEM_RE.test(x));
      },
    });
    Rich.setStructRenderer((d, w, type, payload, idx) => ui.structUi.render(d, w, type, payload, idx));
    return ui.structUi;
  }

  /** Phase 8: portal blocks (read-only windows onto objects owned by other modules). Lazy mount; keeps nothing but an in-memory last-state map. */
  function portalsUi() {
    if (ui.portals) return ui.portals;
    const M = global.HqCarnetPortalsUi;
    if (!M || typeof M.mount !== "function") {
      flashMsg("Module portails non chargé");
      return null;
    }
    ui.portals = M.mount({
      doc,
      root: () => (ui.root && ui.root.querySelector(".carnet-main")) || ui.root,
      api: { post: (payload) => request(payload) },
      online: () => !(global.navigator && global.navigator.onLine === false),
      timeout: (fn, ms) => global.setTimeout(fn, ms),
      checkRef: (ref) => !!Rich.checkRef(ref),
      list: async (kind) => {
        if (kind === "source") {
          const d = await apiCall("/api/carnet?sources=1", { timeoutMs: 12000 });
          return ((d && d.editions) || []).filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: (x.title || x.id) + (x.archived ? " (archivée)" : "") }));
        }
        const e = ui.core && ui.core.current();
        const pid = e ? (e.latest || e.server || {}).project_id || null : null;
        if (!pid) return [];
        if (kind === "snapshot") {
          const d = await apiCall("/api/carnet?snapshots=1&project=" + encodeURIComponent(pid), { timeoutMs: 12000 });
          return ((d && d.snapshots) || []).filter((x) => x && x.integrity === "ok").map((x) => ({ id: x.id, label: x.label || x.id }));
        }
        const d = await apiCall("/api/carnet?reviews=1&project=" + encodeURIComponent(pid), { timeoutMs: 12000 });
        return ((d && d.reviews) || []).filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: x.title || x.id }));
      },
      open: (ref, row, ctx) => {
        if (ref.kind === "file") return openAttachment(ref.id);
        if (ref.kind === "source") {
          const cur = ui.core && ui.core.current();
          const bid = ctx && ctx.wrapper ? ctx.wrapper.getAttribute("data-carnet-block-id") : null;
          return openReader({ sourceId: ref.id, origin: cur && Rich.isRealId(bid) ? { kind: "portal", pageId: cur.id, blockId: bid } : null, trigger: ctx && ctx.trigger ? ctx.trigger : null });
        }
        if (ref.kind === "snapshot") {
          const m = intelUi();
          return m && m.openSnapshotById(ref.id, null);
        }
        if (ref.kind === "review") {
          const m = reviewsUi();
          return m && m.openPack(ref.id, null);
        }
        const eu = engUi();
        if (eu) eu.openRef(ref.kind, ref.id);
      },
    });
    return ui.portals;
  }

  /** "Insérer un portail": pick an existing object first, then insert ONE normal block holding only the reference. */
  function portalInsert() {
    if (!curEntry()) return flashMsg(IMG_MSG.readonly);
    if (!structUi()) return flashMsg("Blocs structurés indisponibles");
    const pu = portalsUi();
    if (!pu) return;
    pu.openPicker({ title: "Insérer un portail", onPick: (p) => structInsertBlock("portal", p), onCancel: () => focusEditor(false) });
  }

  /** One logical edit from a structured block: typing = draft only (no re-render); a structural change = one re-render. */
  function structChanged(wrapper, opts) {
    const c = ui.core;
    const e = curEntry();
    if (!c || !e || !ui.editor.contains(wrapper)) return false;
    const lines = Rich.parseEditor(ui.editor);
    const lim = Rich.structLimits(lines);
    if (lim) {
      flashMsg(STRUCT_LIMIT_MSG[lim]);
      showCurrent(); // the refused edit never reaches the draft: the block returns to its saved state
      return false;
    }
    if (opts.rerender) return commitLines(lines, null);
    Rich.ensureKeys(lines);
    ui.pendingMarks = null;
    if (!c.edit(e.id, { text: Rich.flat(lines), fmt: Rich.fmtOf(lines), ids: Rich.idsOf(lines) })) {
      flashMsg("Modification refusée");
      showCurrent();
      return false;
    }
    return true;
  }

  function structIndex(wrapper) {
    return Array.prototype.indexOf.call(ui.editor.children, wrapper);
  }

  function structRemove(wrapper) {
    if (!curEntry() || !ui.editor.contains(wrapper)) return;
    const lines = Rich.parseEditor(ui.editor);
    const idx = structIndex(wrapper);
    if (idx < 0 || !lines[idx] || !Rich.isStructType(lines[idx].type)) return;
    lines.splice(idx, 1);
    if (!lines.length || lines[lines.length - 1].type !== "paragraph") lines.push(Rich.newLine("", "paragraph"));
    if (commitLines(lines, null)) focusEditor(false);
  }

  /** Ungroup: the children become independent images (width 100 %, inline); the first keeps the block id. Asset identity is untouched. */
  function structUngroup(wrapper, payload) {
    if (!curEntry() || !ui.editor.contains(wrapper)) return;
    const lines = Rich.parseEditor(ui.editor);
    const idx = structIndex(wrapper);
    if (idx < 0 || !lines[idx] || lines[idx].type !== "imagegroup") return;
    const imgs = payload.items.map((a, n) => {
      const l = Rich.imageLine({ id: a.id, mime: a.mime, w: a.w, h: a.h, width: 100, layout: "inline", caption: a.caption });
      if (l && n === 0) l.id = lines[idx].id;
      return l;
    });
    if (imgs.some((l) => !l)) return flashMsg("Modification refusée");
    lines.splice(idx, 1, ...imgs);
    if (lines[lines.length - 1].type !== "paragraph") lines.push(Rich.newLine("", "paragraph"));
    commitLines(lines, null);
  }

  /**
   * Choose image file(s) and upload them through the ONE Stage-06 pipeline. Resolves with [{id,mime,w,h}] or null (cancelled, failed,
   * too many). Nothing in the page is touched here: the caller re-validates the CURRENT state and then makes ONE edit.
   * req: {multiple, min, max, grow} — grow = the images ADD to the page (the 32-image cap is checked first).
   */
  function structPick(req) {
    const I = ui.image;
    if (!Media) {
      flashMsg(IMG_MSG.unavailable);
      return Promise.resolve(null);
    }
    const e = curEntry();
    if (!e) {
      flashMsg(IMG_MSG.readonly);
      return Promise.resolve(null);
    }
    if (I.busy) {
      flashMsg(IMG_MSG.busy);
      return Promise.resolve(null);
    }
    const have = Rich.assetsOf(localLines(e.local)).length;
    const need = req.min || 1;
    if (req.grow && have + need > Rich.IMAGES_PER_PAGE_MAX) {
      flashMsg(IMG_MSG.tooMany);
      return Promise.resolve(null);
    }
    const S = ui.structPick || (ui.structPick = { input: null, resolve: null });
    if (S.resolve) S.resolve(null);
    if (!S.input) {
      S.input = el("input", { type: "file", class: "carnet-file-input", accept: Media.ACCEPT, tabindex: "-1", "aria-hidden": "true", "data-carnet-struct-input": "" });
      (ui.root || doc.body).appendChild(S.input);
    }
    const input = S.input;
    if (req.multiple) input.setAttribute("multiple", "");
    else input.removeAttribute("multiple");
    return new Promise((resolve) => {
      S.resolve = resolve;
      const done = (v) => {
        if (S.resolve === resolve) S.resolve = null;
        input.onchange = null;
        input.oncancel = null;
        resolve(v);
      };
      input.oncancel = () => done(null);
      input.onchange = async () => {
        const files = Array.prototype.slice.call(input.files || []);
        input.value = "";
        if (!files.length) return done(null);
        const max = req.max || 1;
        if (files.length < need || files.length > max) {
          flashMsg(need === max ? "Choisissez " + need + (need > 1 ? " images" : " image") : "Choisissez entre " + need + " et " + max + " images");
          return done(null);
        }
        if (req.grow && have + files.length > Rich.IMAGES_PER_PAGE_MAX) {
          flashMsg(IMG_MSG.tooMany);
          return done(null);
        }
        I.busy = true;
        refreshImageUi();
        const out = [];
        try {
          for (const f of files) {
            flashMsg(IMG_MSG.prep);
            const prepared = await Media.prepare(f);
            flashMsg(IMG_MSG.up);
            const a = await Media.upload(prepared.blob, apiCall);
            out.push({ id: a.id, mime: a.mime, w: a.w, h: a.h, caption: "" });
          }
        } catch (err) {
          I.busy = false;
          refreshImageUi();
          flashMsg(Media.describeError(err));
          return done(null);
        }
        I.busy = false;
        refreshImageUi();
        done(out);
      };
      input.click();
    });
  }

  /** Opening a page from a library search whose words are only found inside a structured block: scroll to, open and highlight that block. */
  function structRevealForQuery() {
    const U = ui.structUi;
    if (!U || !ui.lib || !ui.lib.query) return;
    const toks = queryTokens(ui.lib.query);
    if (!toks.length) return;
    const lines = Rich.parseEditor(ui.editor);
    const flatFold = fold(Rich.flat(lines));
    if (toks.some((t) => flatFold.indexOf(t) >= 0)) return; // the ordinary text matches: normal behaviour
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      if (!Rich.isStructType(l.type) || !l.struct) continue;
      const hay = fold(Rich.Struct.strings(l.type, l.struct).join("\n"));
      if (toks.some((t) => hay.indexOf(t) >= 0)) {
        U.reveal(i);
        return;
      }
    }
  }

  function structFirstFocus(idx) {
    const w = ui.editor.children[idx];
    const f = w && w.querySelector("input:not([type=checkbox]),textarea,select,button");
    if (f) f.focus();
  }

  /** Insert a new structured block at the caret (an empty paragraph is replaced; a place to keep typing always follows). */
  function structInsertBlock(type, payload) {
    const e = curEntry();
    if (!e) return flashMsg(IMG_MSG.readonly);
    const sel = currentSel();
    const lines = sel.lines;
    const at = Rich.locate(lines, sel.start);
    const line = Rich.structLine(type, payload);
    if (!line) return flashMsg("Modification refusée");
    const cur = lines[at.line];
    let idx = at.line + 1;
    if (cur && cur.type === "paragraph" && cur.text === "") {
      lines.splice(at.line, 1, line);
      idx = at.line;
    } else lines.splice(idx, 0, line);
    const after = lines[idx + 1];
    if (!after || Rich.isAtom(after)) lines.splice(idx + 1, 0, Rich.newLine("", "paragraph"));
    const lim = Rich.structLimits(lines);
    if (lim) return flashMsg(STRUCT_LIMIT_MSG[lim]);
    if (commitLines(lines, null)) structFirstFocus(idx);
  }

  async function structInsert(key) {
    const U = global.HqCarnetStructuredUi;
    if (!structUi() || !curEntry()) return curEntry() ? flashMsg("Blocs structurés indisponibles") : flashMsg(IMG_MSG.readonly);
    if (key !== "imagegroup") return structInsertBlock(key, U.blank(key));
    const sel = currentSel();
    const lines = sel.lines;
    const e = curEntry();
    const pageId = e.id;
    const got = await structPick({ multiple: true, min: 2, max: 3, grow: true });
    if (!got) return;
    const e2 = curEntry();
    if (!e2 || e2.id !== pageId) return flashMsg(IMG_MSG.stalePage);
    const group = Rich.Struct.groupFrom(got, null);
    if (!group) return flashMsg("Choisissez des images différentes");
    void lines;
    structInsertBlock("imagegroup", group);
  }

  /** Selected single image + 1-2 more images -> ONE atomic edit turning that block into a group (never a 1-image group). */
  async function structGroupSelected() {
    const b = imgBound();
    if (!b) return;
    const first = b.lines[b.idx].asset;
    const blockId = b.lines[b.idx].id;
    const pageId = b.e.id;
    if (!structUi()) return;
    const got = await structPick({ multiple: true, min: 1, max: 2, grow: true });
    if (!got) return; // cancelled or failed: the original image is unchanged
    const b2 = imgBound();
    if (!b2 || b2.e.id !== pageId || b2.lines[b2.idx].id !== blockId || b2.lines[b2.idx].asset.id !== first.id) return flashMsg(IMG_MSG.staleTool);
    const group = Rich.Struct.groupFrom([first].concat(got), null);
    if (!group) return flashMsg("Image déjà présente dans le groupe");
    const line = Rich.structLine("imagegroup", group);
    if (!line) return flashMsg("Modification refusée");
    line.id = blockId; // same block identity; width / alignment of the single image are not carried (the group owns the layout)
    b2.lines.splice(b2.idx, 1, line);
    const lim = Rich.structLimits(b2.lines);
    if (lim) return flashMsg(STRUCT_LIMIT_MSG[lim]);
    closeImageTools("");
    commitLines(b2.lines, null);
  }

  // ---------------------------------------------------------------- Product Phase 3: Dessiner (orchestration; Dessiner owns the drawing)

  const DESSINER_FLASH_MS = 6000;


  // ================================================================== Product Phase 3.5: interaction polish (host side)
  //
  // Pure rules live in hq-carnet-nav.js (checked in Node); the DOM pieces in hq-carnet-polish-ui.js. Nothing here persists anything:
  // anchors are read-only navigation, the outline is a view over the parsed lines, the inspector is inspection-only and portal
  // cards are live renderers over canonical refs.

  const POLISH_MSG = {
    pageGone: "Page introuvable",
    blockGone: "Bloc introuvable",
    reached: "Bloc atteint",
    linkCopied: "Lien du bloc copié",
    linkNeedsSave: "Enregistre d'abord la page : ce bloc n'a pas encore d'identifiant",
    previewGone: "Aperçu indisponible",
  };
  const PULSE_MS = 1800;

  function nav() {
    return global.HqCarnetNav || null;
  }

  function saveSnapshot() {
    const c = ui.core;
    const e = c && c.current();
    return {
      hasEntry: !!e,
      trashed: !!e && isReadOnly(e),
      conflict: !!(e && e.conflict),
      error: !!(e && e.error),
      storageFailed: !!(ui.drafts && ui.drafts.failed),
      dirty: !!(e && c.isDirty(e)),
      inflight: !!(e && e.inflight),
      offline: !!(c && c.st.offline),
      savedOnce: !!(c && c.st.savedOnce),
      notice: c && c.st.notice ? String(c.st.notice) : "",
    };
  }

  function polishUi() {
    if (ui.polish) return ui.polish;
    const M = global.HqCarnetPolishUi;
    const N = nav();
    if (!M || typeof M.mount !== "function" || !N) return null;
    ui.polish = M.mount({
      doc, win: global, nav: N,
      now: () => (global.performance && typeof global.performance.now === "function" ? global.performance.now() : Date.now()),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      lines: () => {
        const e = ui.core && ui.core.current();
        return e ? localLines(e.local) : null;
      },
      titleIndex: (lines) => (global.HqCarnetCommands ? global.HqCarnetCommands.titleIndex(lines) : -1),
      reveal: (index, blockId) => revealBlock(blockId, index, false),
      api: (path) => apiCall(path, { timeoutMs: 12000 }),
      drawingLabel: (stem) => (Rich.Struct && Rich.Struct.drawingLabel ? Rich.Struct.drawingLabel(stem) : stem),
      openDrawing: (stem, blockId) => {
        const w = blockId && ui.editor ? ui.editor.querySelector('[data-carnet-block-id="' + blockId + '"][data-carnet-struct="drawing"]') : null;
        if (w) dessinerOpen(w, stem);
        else flashMsg(POLISH_MSG.previewGone);
      },
      offer: (id) => (ui.structUi && ui.structUi.offerFor ? ui.structUi.offerFor(id) : null),
      useOffer: (id) => (ui.structUi && ui.structUi.useOffer ? ui.structUi.useOffer(id) : false),
      readOnly: () => !curEntry(),
      flash: (t) => flashMsg(t, 2600),
      mobile: () => libMode() === "sheet",
      fallbackFocus: () => (finePointer() && ui.editor && ui.editor.isConnected ? ui.editor : doc.getElementById("btn-carnet-outline")),
    });
    if (Rich.setPortalRenderer) Rich.setPortalRenderer(portalCard);
    return ui.polish;
  }

  function inspectOpen(input, trigger) {
    const P = polishUi();
    if (!P) return flashMsg(POLISH_MSG.previewGone);
    const blockId = input && input.blockId;
    const restore = () => {
      if (!ui.editor) return null;
      const w = blockId ? ui.editor.querySelector('[data-carnet-block-id="' + blockId + '"]') : null;
      return (w && w.querySelector(".carnet-drawing-inspect,.carnet-group-inspect,[data-carnet-image]")) || (finePointer() ? ui.editor : doc.getElementById("btn-carnet-outline"));
    };
    return P.inspectOpen(input, trigger, { restore });
  }

  /** Inspect the image of an editor line (single image figure). */
  function inspectImageLine(lineEl, trigger) {
    if (!lineEl) return;
    const assetId = lineEl.getAttribute("data-carnet-asset") || "";
    inspectOpen({ kind: "image", assetId, blockId: lineEl.getAttribute("data-carnet-block-id") || "" }, trigger || lineEl.querySelector("[data-carnet-image]"));
  }

  /**
   * Scroll to a block and give it a brief pulse (never a permanent highlight, never a focus / selection / content change).
   * strict: only the real block id counts (deep links). Otherwise an outline item may fall back to its line index.
   */
  function revealBlock(blockId, index, strict) {
    const ed = ui.editor;
    if (!ed) return false;
    let node = blockId ? ed.querySelector('[data-carnet-block-id="' + blockId + '"]') : null;
    if (!node && !strict && typeof index === "number" && index >= 0) node = ed.children[index] || null;
    if (!node) return false;
    const idx = Array.prototype.indexOf.call(ed.children, node);
    if (ui.structUi && node.hasAttribute("data-carnet-struct") && idx >= 0) ui.structUi.reveal(idx); // opens a toggle (UI state only)
    try {
      node.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    } catch (_) {}
    for (const old of ed.querySelectorAll("[data-carnet-pulse]")) old.removeAttribute("data-carnet-pulse");
    node.setAttribute("data-carnet-pulse", "1");
    setTimeout(() => node.removeAttribute("data-carnet-pulse"), PULSE_MS);
    return true;
  }

  // ---- block anchors: #carnet/<pageId>/<blockId>

  /** Resolve a validated anchor. Navigation only: through the library's own openPage (drafts stay safe), never a mutation. */
  async function applyAnchor(a) {
    const c = ui.core;
    if (!a || !c || ui.phase !== "ready") return "ignored";
    let e = c.entry(a.pageId);
    if (!e) {
      try {
        await c.poll(); // the page may simply not be known yet
      } catch (_) {}
      e = c.entry(a.pageId);
    }
    if (!e) {
      flashMsg(POLISH_MSG.pageGone, 3500);
      return "missing-page";
    }
    if (c.st.currentId !== a.pageId) openPage(a.pageId);
    if (!revealBlock(a.blockId, -1, true)) {
      flashMsg(POLISH_MSG.blockGone, 3500);
      return "missing-block";
    }
    flashMsg(POLISH_MSG.reached, 1400);
    return "ok";
  }

  function processAnchor() {
    const a = ui.pendingAnchor;
    if (!a || ui.phase !== "ready" || !ui.core) return;
    ui.pendingAnchor = null;
    applyAnchor(a).then(() => {}, (err) => console.error(err));
  }

  function currentHashAnchor() {
    const N = nav();
    return N && global.location ? N.parseAnchor(global.location.hash) : null;
  }

  /** Initial load, hashchange, Back / Forward: a malformed fragment is ignored whole (no partial navigation). */
  function onHashChange() {
    const a = currentHashAnchor();
    if (!a) return;
    ui.pendingAnchor = a;
    if (doc.body && doc.body.dataset.view !== "carnet") goCarnet();
    else processAnchor();
  }

  /** Copy the deep link of the block at editor line `index`. Never touches history, selection or the notebook. */
  async function copyBlockLink(index) {
    const N = nav();
    const e = ui.core && ui.core.current();
    const l = e ? Rich.parseEditor(ui.editor)[index] : null;
    const url = N && e && l && l.id ? N.makeUrl(global.location, e.id, l.id) : null;
    if (!url) return flashMsg(POLISH_MSG.linkNeedsSave, 3000);
    let ok = false;
    try {
      if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
        await global.navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) ok = legacyCopy(url);
    flashMsg(ok ? POLISH_MSG.linkCopied : MSG.copyFail, 2000);
  }

  // ---- portal cards (file / drawing / model / media): live renderers over the canonical ref

  function portalKey(ref) {
    return ref.kind + ":" + ref.id;
  }

  function portalCard(d, ref) {
    const N = nav();
    if (!N) return null;
    const known = ui.portalKnown.get(portalKey(ref)) || "unknown";
    const m = N.portalModel(ref, known, { drawingLabel: (stem) => (Rich.Struct && Rich.Struct.drawingLabel ? Rich.Struct.drawingLabel(stem) : stem) });
    if (!m) return null;
    const mk = (tag, cls, text) => {
      const n = d.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    const badge = mk("span", "carnet-attach-badge carnet-portal-badge");
    badge.setAttribute("contenteditable", "false");
    badge.setAttribute("data-carnet-skip", "");
    badge.setAttribute("data-portal-kind", m.kind);
    badge.setAttribute("data-portal-key", portalKey(ref));
    badge.setAttribute("data-state", m.unavailable ? "missing" : "ok");
    badge.appendChild(mk("span", "carnet-attach-chip", m.chip));
    if (m.preview) {
      const img = mk("img", "carnet-portal-thumb");
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      img.setAttribute("draggable", "false");
      img.setAttribute("src", m.preview);
      img.addEventListener("load", () => {
        if (!ui.portalKnown.has(portalKey(ref))) ui.portalKnown.set(portalKey(ref), "ok");
      });
      img.addEventListener("error", () => portalSet(ref, "missing"));
      badge.appendChild(img);
    }
    if (m.subtitle) badge.appendChild(mk("span", "carnet-attach-dir", m.subtitle));
    if (m.unavailable) {
      const note = mk("span", "carnet-portal-gone", m.message);
      note.setAttribute("role", "note");
      badge.appendChild(note);
    }
    const open = mk("span", "carnet-attach-open", m.unavailable ? "Réessayer" : m.openLabel);
    open.setAttribute("role", "button");
    open.setAttribute("tabindex", "0");
    open.setAttribute("data-carnet-attach-open", ref.id);
    open.setAttribute("data-carnet-portal-kind", m.kind);
    open.setAttribute("aria-label", (m.unavailable ? "Réessayer : " : "") + (m.openAria || "Ouvrir dans Dessiner : " + m.title));
    badge.appendChild(open);
    return badge;
  }

  /** Learn a target's availability for this session and repaint the matching cards in place (the ref itself is never touched). */
  function portalSet(ref, state) {
    const key = portalKey(ref);
    if (ui.portalKnown.get(key) === state) return;
    ui.portalKnown.set(key, state);
    if (!ui.editor) return;
    const had = doc.activeElement;
    let refocus = null;
    for (const old of ui.editor.querySelectorAll('[data-portal-key="' + key.replace(/"/g, "") + '"]')) {
      const fresh = portalCard(doc, ref);
      if (!fresh) continue;
      if (old.contains(had)) refocus = fresh;
      old.replaceWith(fresh);
    }
    if (refocus) {
      const b = refocus.querySelector("[data-carnet-attach-open]");
      if (b) b.focus({ preventScroll: true });
    }
  }

  async function portalExists(kind, id) {
    if (kind === "drawing") {
      const d = await apiCall("/api/drawings", { timeoutMs: 12000 });
      const list = (d && (d.items || d.drawings)) || [];
      return list.some((it) => it && it.stem === id);
    }
    const parts = id.split("/");
    const base = parts.pop();
    const d = await apiCall("/api/files?folder=" + encodeURIComponent(parts.join("/")) + "&q=" + encodeURIComponent(base), { timeoutMs: 12000 });
    return ((d && d.files) || []).some((it) => it && it.rel === id);
  }

  /** Open a portal card's target. A target that disappeared since the render is reported, the card flips to its unavailable state. */
  async function portalActivate(node) {
    const id = node.getAttribute("data-carnet-attach-open");
    const kind = node.getAttribute("data-carnet-portal-kind");
    if (!kind) return openAttachment(id); // Phase-2 file card (no portal renderer)
    const ref = Rich.checkRef({ kind, id });
    if (!ref) return flashMsg("Référence invalide");
    let ok = false;
    try {
      ok = await portalExists(kind, id);
    } catch (_) {
      flashMsg("Vérification impossible : réessaie");
      return;
    }
    if (!ok) {
      portalSet(ref, "missing");
      flashMsg(kind === "drawing" ? "Croquis indisponible" : "Fichier indisponible", 2600);
      return;
    }
    portalSet(ref, "ok");
    if (kind === "file") return openAttachment(id);
    if (kind === "drawing") {
      const D = dessinerUi();
      const w = node.closest("[data-carnet-block-id]");
      void w;
      const eu = engUi();
      if (eu) eu.openRef("drawing", id);
      else if (D) flashMsg("Ouvre le croquis depuis Dessiner");
      return;
    }
    const eu = engUi();
    if (eu) eu.openRef(kind, id);
  }

  /** Annoter (suggested after an image): the Phase-3 annotation path on the image line at `index`. */
  function dessinerAnnotateAt(index) {
    const D = dessinerUi();
    if (!D) return flashMsg("Dessiner indisponible");
    const l = Rich.parseEditor(ui.editor)[index];
    if (!l || l.type !== "image" || !l.asset || !l.asset.id) return flashMsg(POLISH_MSG.previewGone);
    D.start("annotate", { anchorIndex: index, assetId: l.asset.id }).then(() => {}, () => {});
  }

  function dessinerUi() {
    if (ui.dessinerUi) return ui.dessinerUi;
    const M = global.HqCarnetDessiner;
    if (!M || typeof M.mount !== "function") return null;
    const flash = (text) => flashMsg(text, DESSINER_FLASH_MS);
    ui.dessinerUi = M.mount({
      storage: () => global.sessionStorage,
      now: () => Date.now(),
      flash,
      sketch: () => (typeof global.hqSketchOpenExact === "function" && typeof global.hqSketchStartBlank === "function" && typeof global.hqSketchStartUnderlay === "function"
        ? { openExact: global.hqSketchOpenExact, startBlank: global.hqSketchStartBlank, startUnderlay: global.hqSketchStartUnderlay } : null),
      clearSketchLink: () => {
        if (typeof global.hqSketchClearLink === "function") global.hqSketchClearLink();
      },
      setView: (name) => {
        if (name === "carnet") return goCarnet();
        if (typeof global.setView === "function") global.setView(name);
      },
      current: () => {
        const e = ui.core && ui.core.current();
        if (!e) return null;
        return { pageId: e.id, rev: e.serverRev, dirty: !!(ui.core.isDirty(e) || e.inflight), conflict: !!e.conflict, readOnly: isReadOnly(e) };
      },
      flushCurrent: async () => {
        const c = ui.core;
        const e = c && c.current();
        if (!e) return false;
        for (let i = 0; i < 4 && !e.conflict && !e.orphan && (c.isDirty(e) || e.inflight); i += 1) {
          if (e.inflight) await e.inflight.promise;
          else await c.flush(e.id);
        }
        return !c.isDirty(e) && !e.inflight && !e.conflict && !e.orphan;
      },
      blockAt: (i) => {
        const e = ui.core && ui.core.current();
        const l = e && Number.isInteger(i) && i >= 0 ? localLines(e.local)[i] : null;
        if (!l) return null;
        return { id: l.id && Rich.isRealId(l.id) ? l.id : "", type: l.type, stem: l.type === "drawing" && l.struct ? l.struct.id : "", assetId: l.type === "image" && l.asset ? l.asset.id : "" };
      },
      findBlock: (id) => {
        const e = ui.core && ui.core.current();
        const l = e ? localLines(e.local).find((x) => x.id === id) : null;
        if (!l) return null;
        return { type: l.type, stem: l.type === "drawing" && l.struct ? l.struct.id : "", assetId: l.type === "image" && l.asset ? l.asset.id : "" };
      },
      refreshRemote: async () => {
        // TRUE only when an authoritative poll of the notebook succeeded just now. poll() returns at once while another poll is in
        // flight (wait for it) and swallows failures (it records st.pollOk), so success is read from the result, never assumed.
        try {
          if (!ui.core || !ui.core.st) return false;
          for (let i = 0; i < 50 && ui.core.st.polling; i += 1) await new Promise((r) => setTimeout(r, 60));
          if (ui.core.st.polling) return false;
          ui.core.st.pollOk = null;
          await ui.core.poll();
          return ui.core.st.pollOk === true;
        } catch (_) {
          return false;
        }
      },
      pageState: (id) => {
        const c = ui.core;
        const e = c && c.entry(id);
        if (!e || e.orphan) return null;
        return { trashed: c.isTrashed(e), rev: e.serverRev, dirty: !!(c.isDirty(e) || e.inflight), conflict: !!e.conflict };
      },
      openPage: async (id) => {
        const c = ui.core;
        if (!c || !c.entry(id) || c.isTrashed(c.entry(id))) return false;
        openPage(id);
        return c.st.currentId === id;
      },
      reveal: (blockId) => {
        const w = ui.editor && ui.editor.querySelector('[data-carnet-block-id="' + blockId + '"]');
        if (!w) return false;
        if (w.scrollIntoView) w.scrollIntoView({ block: "center", behavior: "auto" });
        w.setAttribute("data-struct-hit", "true");
        setTimeout(() => w.removeAttribute("data-struct-hit"), 2500);
        const f = w.querySelector("button,input,textarea,select");
        if (f && finePointer()) f.focus({ preventScroll: true });
        return true;
      },
      refreshPreviews: () => {
        if (structUi()) ui.structUi.refreshPreviews();
      },
      offerVersion: (blockId, from, to) => (structUi() ? ui.structUi.offerVersion(blockId, from, to) : false),
      insertDrawing: (o) => dessinerInsert(o),
    });
    return ui.dessinerUi;
  }

  /** ONE normal draft edit: the reference goes after its anchor (an empty paragraph anchor is replaced), through the ordinary commit path. */
  function dessinerInsert(o) {
    const e = curEntry();
    if (!e || !structUi()) return -1;
    const lines = Rich.parseEditor(ui.editor);
    const line = Rich.structLine("drawing", { id: o.stem });
    if (!line) return -1;
    let idx = lines.length;
    if (o.anchorId) {
      const at = lines.findIndex((l) => l.id === o.anchorId);
      if (at < 0) return -1;
      idx = at + 1;
      if (o.replaceEmpty && lines[at].type === "paragraph" && lines[at].text === "") {
        lines.splice(at, 1, line);
        idx = at;
      } else lines.splice(idx, 0, line);
    } else {
      const last = lines[lines.length - 1];
      if (o.replaceEmpty && last && last.type === "paragraph" && last.text === "") {
        lines.splice(lines.length - 1, 1, line);
        idx = lines.length - 1;
      } else lines.push(line);
    }
    const after = lines[idx + 1];
    if (!after || Rich.isAtom(after)) lines.splice(idx + 1, 0, Rich.newLine("", "paragraph"));
    const lim = Rich.structLimits(lines);
    if (lim) {
      flashMsg(STRUCT_LIMIT_MSG[lim], DESSINER_FLASH_MS);
      return -1;
    }
    return commitLines(lines, null) ? idx : -1;
  }

  /** "Croquis" from + Insérer: the caret line is the anchor (resolved against the SAVED state once the page is saved). */
  function dessinerNew() {
    const D = dessinerUi();
    if (!D) return flashMsg("Dessiner indisponible");
    if (!curEntry()) return flashMsg(IMG_MSG.readonly);
    const sel = currentSel();
    const caret = Rich.locate(sel.lines, sel.start).line;
    D.start("new", { anchorIndex: caret }).then(() => {}, () => {});
  }

  function dessinerOpen(wrapper, stem) {
    const D = dessinerUi();
    if (!D) return flashMsg("Dessiner indisponible");
    const id = wrapper && wrapper.getAttribute("data-carnet-block-id");
    if (!id) return flashMsg("Enregistre d'abord la page", DESSINER_FLASH_MS);
    D.start("open", { blockId: id, stem }).then(() => {}, () => {});
  }

  function dessinerAnnotateSelected() {
    const D = dessinerUi();
    if (!D) return flashMsg("Dessiner indisponible");
    const b = imgBound();
    if (!b) return;
    const assetId = b.lines[b.idx].asset.id;
    const anchorIndex = b.idx;
    closeImageTools("");
    D.start("annotate", { anchorIndex, assetId }).then(() => {}, () => {});
  }

  function openAttachment(refId) {
    const ref = Rich.checkRef({ kind: "file", id: String(refId) });
    if (ref) global.open("/files/" + ref.id.split("/").map(encodeURIComponent).join("/"), "_blank", "noopener,noreferrer");
  }

  function imgToolsNote(text) {
    const n = doc.getElementById("carnet-image-tools-msg");
    if (n) n.textContent = text || "";
  }

  /** Fill the tools from the CURRENT asset (the source of truth is the entry, never the last thing the inputs showed). */
  function imgTools(b, force) {
    const I = ui.image;
    const a = b.lines[b.idx].asset;
    const range = doc.getElementById("carnet-image-width");
    const cap = doc.getElementById("carnet-image-caption");
    const out = doc.getElementById("carnet-image-width-out");
    if (force || doc.activeElement !== range) range.value = String(a.width);
    if (force || doc.activeElement !== cap) cap.value = a.caption;
    out.textContent = a.width + " %";
    I.sel.sig = imgSig(a);
    imgPressed(a);
  }

  /** Alignment buttons expose the CURRENT layout (aria-pressed), refreshed on every state change. */
  function imgPressed(a) {
    const setPressed = (id, on) => {
      const n = doc.getElementById(id);
      if (n) n.setAttribute("aria-pressed", on ? "true" : "false");
    };
    setPressed("btn-carnet-image-left", a.layout === "inline");
    setPressed("btn-carnet-image-center", a.layout === "center");
    setPressed("btn-carnet-image-right", a.layout === "right");
  }

  function selectImageLine(lineEl) {
    const e = curEntry();
    if (!e || !lineEl || !ui.editor.contains(lineEl)) return;
    const idx = Array.prototype.indexOf.call(ui.editor.children, lineEl);
    const lines = localLines(e.local);
    const l = lines[idx];
    if (!l || l.type !== "image") return;
    const I = ui.image;
    I.sel = { pageId: e.id, blockId: l.id, assetId: l.asset.id, rev: e.serverRev, sig: imgSig(l.asset) };
    I.confirm = false;
    imgToolsNote("");
    const b = { e, lines, idx };
    imgTools(b, true);
    refreshImageUi();
  }

  function closeImageTools(note, refocus) {
    const I = ui.image;
    if (!I) return;
    const had = !!I.sel;
    I.sel = null;
    I.confirm = false;
    if (I.timer) clearTimeout(I.timer);
    I.timer = null;
    const tools = doc.getElementById("hq-carnet-image-tools");
    if (tools) tools.hidden = true;
    if (ui.editor) for (const n of ui.editor.querySelectorAll("[data-selected]")) n.removeAttribute("data-selected");
    if (ui.imageUi) {
      ui.imageUi.abort();
      ui.imageUi.clearHandles();
    }
    const rm = doc.getElementById("btn-carnet-image-remove");
    if (rm) rm.textContent = IMG_MSG.remove;
    if (had && note) flashMsg(note);
    if (had && refocus && ui.editor) {
      try {
        ui.editor.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  function refreshImageUi() {
    const I = ui.image;
    if (!I || !ui.editor) return;
    const e = ui.core && ui.core.current();
    if (I.panelOpen && I.origin && (!e || e.id !== I.origin.pageId)) I.origin = null; // a picker opened against another page is dead
    const can = !!curEntry();
    const panel = doc.getElementById("hq-carnet-image-panel");
    if (panel) {
      for (const b of panel.querySelectorAll("[data-carnet-image-source]")) b.disabled = I.busy || !can;
      panel.setAttribute("aria-busy", I.busy ? "true" : "false");
    }
    const btn = doc.getElementById("btn-carnet-image");
    if (btn) btn.disabled = !can;
    if (!I.sel) return;
    const b = imgBound();
    const tools = doc.getElementById("hq-carnet-image-tools");
    if (!b) return;
    if (tools) tools.hidden = false;
    const a = b.lines[b.idx].asset;
    if (imgSig(a) !== I.sel.sig) {
      imgTools(b, true); // another client / a rebase changed this image: show the current values
      imgToolsNote(IMG_MSG.staleTool);
    }
    for (let i = 0; i < ui.editor.children.length; i += 1) {
      const n = ui.editor.children[i];
      if (i === b.idx) n.setAttribute("data-selected", "true");
      else if (n.hasAttribute("data-selected")) n.removeAttribute("data-selected");
    }
    const replace = doc.getElementById("btn-carnet-image-replace");
    if (replace) replace.disabled = I.busy;
    const dis = (id, v) => {
      const n = doc.getElementById(id);
      if (n) n.disabled = !!v;
    };
    imgPressed(a);
    dis("btn-carnet-image-up", b.idx === 0);
    dis("btn-carnet-image-down", b.idx === b.lines.length - 1);
    dis("btn-carnet-image-smaller", a.width <= Rich.ASSET_WIDTH_MIN);
    dis("btn-carnet-image-larger", a.width >= Rich.ASSET_WIDTH_MAX);
    const iu = imageUi();
    if (iu && !iu.active()) iu.decorate(ui.editor.children[b.idx], a.layout);
    const fig = ui.editor.children[b.idx].querySelector("figure");
    if (fig) {
      // presentation only (not part of the content model): the selected image states its width and alignment
      const label = a.width + " % · " + (a.layout === "center" ? "centré" : a.layout === "right" ? "à droite" : "à gauche");
      if (fig.getAttribute("data-badge") !== label) fig.setAttribute("data-badge", label);
    }
    for (const f of ui.editor.querySelectorAll("figure[data-badge]")) if (f !== fig) f.removeAttribute("data-badge");
    placeImageTools(ui.editor.children[b.idx]);
  }

  /**
   * The image toolbar floats next to the selected image (below it, else above it, else docked at the bottom of the viewport),
   * clamped to the viewport; on coarse pointers it is a bottom sheet. Pure presentation: no state, nothing persisted.
   */
  function placeImageTools(lineEl) {
    const tools = doc.getElementById("hq-carnet-image-tools");
    if (!tools || tools.hidden || !lineEl) return;
    const vw = global.innerWidth || doc.documentElement.clientWidth;
    const vh = global.innerHeight || doc.documentElement.clientHeight;
    if (!finePointer() || vw < 600) {
      tools.setAttribute("data-float", "sheet");
      tools.style.top = "";
      tools.style.left = "";
      return;
    }
    const fig = lineEl.querySelector("figure") || lineEl;
    const r = fig.getBoundingClientRect();
    const w = Math.min(560, vw - 16);
    tools.style.width = w + "px";
    const h = tools.offsetHeight;
    const margin = 8;
    const nav = 72;
    let top = r.bottom + 10;
    let mode = "below";
    if (top + h > vh - nav) {
      top = r.top - h - 10;
      mode = "above";
    }
    if (top < margin) {
      top = Math.max(margin, vh - nav - h);
      mode = "dock";
    }
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, vw - w - margin));
    tools.setAttribute("data-float", mode);
    tools.style.top = Math.round(top) + "px";
    tools.style.left = Math.round(left) + "px";
  }

  function replaceSelectedImage() {
    const b = imgBound();
    if (!b) return;
    pickImage("files", { pageId: b.e.id, blockId: ui.image.sel.blockId, assetId: ui.image.sel.assetId });
  }

  function removeSelectedImage() {
    const I = ui.image;
    const btn = doc.getElementById("btn-carnet-image-remove");
    if (!I.confirm) {
      const b0 = imgBound();
      if (!b0) return;
      I.confirm = true;
      if (btn) btn.textContent = IMG_MSG.confirmRemove;
      if (I.timer) clearTimeout(I.timer);
      I.timer = setTimeout(() => {
        I.confirm = false;
        I.timer = null;
        const r = doc.getElementById("btn-carnet-image-remove");
        if (r) r.textContent = IMG_MSG.remove;
      }, 5000);
      return;
    }
    const b = imgBound();
    if (!b) return;
    if (imgSig(b.lines[b.idx].asset) !== I.sel.sig) {
      imgTools(b, true);
      imgToolsNote(IMG_MSG.staleTool);
      I.confirm = false;
      if (btn) btn.textContent = IMG_MSG.remove;
      return;
    }
    b.lines.splice(b.idx, 1);
    if (!b.lines.length) b.lines.push(Rich.newLine("", "paragraph"));
    const ok = imgCommit(b.lines, null, true);
    closeImageTools("");
    if (ok) flashMsg(IMG_MSG.removed);
  }

  /** Backspace/Delete next to an image SELECTS it first (a second deliberate action removes it): no accidental loss. */
  function imgKeyAdjacent(ev) {
    const sel = readSel();
    if (!sel || sel.start !== sel.end) return false;
    const at = Rich.locate(sel.lines, sel.start);
    const back = ev.inputType === "deleteContentBackward";
    const fwd = ev.inputType === "deleteContentForward";
    let target = -1;
    if (back && at.off === 0 && at.line > 0 && sel.lines[at.line - 1].type === "image") target = at.line - 1;
    else if (fwd && at.off === sel.lines[at.line].text.length && at.line + 1 < sel.lines.length && sel.lines[at.line + 1].type === "image") target = at.line + 1;
    if (target < 0) {
      // Phase 2: Backspace/Delete next to a table / callout / toggle / group focuses it instead of deleting it (it has its own named delete)
      let st = -1;
      if (back && at.off === 0 && at.line > 0 && Rich.isStructType(sel.lines[at.line - 1].type)) st = at.line - 1;
      else if (fwd && at.off === sel.lines[at.line].text.length && at.line + 1 < sel.lines.length && Rich.isStructType(sel.lines[at.line + 1].type)) st = at.line + 1;
      if (st < 0) return false;
      ev.preventDefault();
      structFirstFocus(st);
      return true;
    }
    ev.preventDefault();
    selectImageLine(ui.editor.children[target]);
    return true;
  }

  function onImageKey(ev) {
    const fig = ev.target && ev.target.closest ? ev.target.closest("[data-carnet-image]") : null;
    if (!fig || !ui.editor.contains(fig)) return false;
    const line = fig.closest("[data-carnet-line]");
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      selectImageLine(line);
      return true;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      selectImageLine(line);
      removeSelectedImage();
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeImageTools("", true);
      return true;
    }
    return false;
  }

  function onImageError(ev) {
    const t = ev.target;
    if (t && t.tagName === "IMG" && ui.editor && ui.editor.contains(t)) {
      const fig = t.closest("figure");
      if (fig) fig.setAttribute("data-broken", "true"); // missing/unreadable file: a visible placeholder, never a silent blank
    }
  }

  function downloadExport(fmt) {
    const e = ui.core && ui.core.current();
    if (!e) return;
    const lines = localLines(e.local);
    const text = fmt === "md" ? Rich.renderMarkdown(lines) : Rich.renderTxt(lines);
    const name = Rich.exportFilename("", deriveTitle(e.local.text), fmt);
    const blob = new global.Blob([text], { type: (fmt === "md" ? "text/markdown" : "text/plain") + ";charset=utf-8" });
    const url = global.URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name, class: "carnet-copy-buffer", "aria-hidden": "true", tabindex: "-1" });
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => global.URL.revokeObjectURL(url), 4000);
  }

  function clearPrint() {
    if (ui.printNode) ui.printNode.remove();
    ui.printNode = null;
    if (doc.body) doc.body.classList.remove("carnet-printing");
  }

  /** Print/PDF through the browser: a read-only structured snapshot in a print-only container. */
  function printPage() {
    const e = ui.core && ui.core.current();
    if (!e) return;
    clearPrint();
    const host = el("div", { id: "hq-carnet-print", "aria-hidden": "true" });
    Rich.renderInto(host, localLines(e.local), { print: true }); // static structured blocks: a toggle is always expanded, no inputs
    host.removeAttribute("contenteditable");
    doc.body.appendChild(host);
    doc.body.classList.add("carnet-printing");
    ui.printNode = host;
    global.addEventListener("afterprint", clearPrint, { once: true });
    const go = () => {
      if (ui.printNode !== host) return; // cancelled / replaced while images were loading
      try {
        global.print();
      } finally {
        setTimeout(clearPrint, 1500);
      }
    };
    // Stage 06: print only once the pictures are decoded (bounded wait), so the layout is the final one.
    const pending = Array.prototype.slice.call(host.querySelectorAll("img")).filter((i) => !i.complete).map((i) => new Promise((resolve) => {
      i.addEventListener("load", resolve, { once: true });
      i.addEventListener("error", resolve, { once: true });
    }));
    if (!pending.length) go();
    else Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 6000))]).then(go, go);
  }

  async function exportCopy() {
    const c = ui.core;
    const e = c && c.current();
    const msg = doc.getElementById("carnet-export-msg");
    if (!e || isReadOnly(e)) return;
    msg.textContent = "";
    if (e.conflict || e.orphan) {
      msg.textContent = MSG.trashConflict;
      return;
    }
    await c.flush(e.id);
    if (c.isDirty(e) || e.inflight || e.conflict || e.error) {
      msg.textContent = MSG.exportDirty;
      return;
    }
    const root = doc.getElementById("hq-carnet-export-root").value;
    const sub = doc.getElementById("hq-carnet-export-sub").value.trim().replace(/^\/+|\/+$/g, "");
    const fmt = doc.getElementById("hq-carnet-export-format").value;
    const filename = doc.getElementById("hq-carnet-export-name").value.trim();
    const payload = { action: "page_export", id: e.id, expected_rev: e.serverRev, format: fmt, dir: sub ? root + "/" + sub : root };
    if (filename) payload.filename = filename;
    try {
      const res = await request(payload);
      rememberExport(e.id, { path: String(res.path || ""), rev: Number(res.rev) || e.serverRev, at: Number(res.exported_at) || Date.now() / 1000, format: fmt });
      msg.textContent = MSG.exportSaved + " : " + String(res.path || "");
      doc.getElementById("hq-carnet-export-name").value = String(res.name || filename);
    } catch (err) {
      const data = err && err.data && typeof err.data === "object" ? err.data : {};
      if (err && err.status === 409 && data.code === "export_exists") msg.textContent = MSG.exportExists;
      else msg.textContent = String(data.error || (err && err.message) || MSG.exportFail).slice(0, 160);
    }
    renderExportState();
  }

  // ---------------------------------------------------------------- polling / lifecycle

  function startPoll() {
    if (ui.pollTimer || ui.phase !== "ready" || !ui.active || !carnetVisible()) return;
    ui.pollTimer = setInterval(() => {
      if (!carnetVisible()) {
        stopPoll();
        return;
      }
      ui.core.poll();
    }, POLL_MS);
  }

  function stopPoll() {
    if (ui.pollTimer) clearInterval(ui.pollTimer);
    ui.pollTimer = null;
  }

  function libModal() {
    return !!(ui.libEl && !ui.libEl.hidden && ui.libEl.getAttribute("aria-modal") === "true");
  }

  /** Keep keyboard focus inside the modal library overlay. */
  function trapTab(e) {
    const items = [...ui.libEl.querySelectorAll("button, input, select, summary, [tabindex]:not([tabindex='-1'])")]
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = ui.libEl.contains(doc.activeElement);
    if (e.shiftKey && (!inside || doc.activeElement === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || doc.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKey(e) {
    if (ui.phase !== "ready" || !doc.body || doc.body.dataset.view !== "carnet") return;
    if (ui.hx && ui.hx.isOpen()) {
      // The history / operations dialog is modal: nothing runs behind it (its own handler owns Tab and Escape).
      if (pageNavDelta(e)) e.preventDefault();
      if (e.key === "Escape") {
        e.preventDefault();
        ui.hx.close(true);
      }
      return;
    }
    if (ui.sources && ui.sources.isOpen()) {
      // The sources overlay is modal too: page navigation never runs behind it (its actions are bound to the page it was opened on).
      if (pageNavDelta(e)) e.preventDefault();
      if (e.key !== "Escape") return;
    }
    if (libModal()) {
      // Modal overlay: only the dialog's own keys act. Tab is trapped, Escape closes, and
      // editor/page shortcuts (Alt+Left/Right) never operate on the page behind it.
      if (e.key === "Tab") {
        trapTab(e);
        return;
      }
      if (e.key !== "Escape") {
        if (pageNavDelta(e)) e.preventDefault();
        return;
      }
    }
    if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (doc.querySelector("dialog[open]")) return;
      if (handleEscape()) e.preventDefault();
      return;
    }
    const d = pageNavDelta(e);
    if (!d) return;
    const dlg = doc.querySelector("dialog[open]");
    if (dlg) return;
    e.preventDefault();
    navigate(d);
  }

  /**
   * Keyboard focus is never left clipped (WCAG 2.4.11 / 2.4.7 in practice): when focus moves by keyboard and the control is only partly
   * visible inside a scroller (phone toolbar rows, modal bodies, wrap-around), it is scrolled into view, instantly (no smooth scrolling, so
   * prefers-reduced-motion is respected by construction). Pointer focus is never touched; text editing surfaces keep the browser's own caret scrolling.
   */
  function bindKeyboardFocusReveal() {
    let kbd = false;
    doc.addEventListener("keydown", (e) => { if (e.key === "Tab" || e.key === "Enter" || e.key === " " || /^Arrow|^Home$|^End$|^Page/.test(e.key)) kbd = true; }, true);
    doc.addEventListener("pointerdown", () => { kbd = false; }, true);
    doc.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!kbd || !t || t.nodeType !== 1 || typeof t.scrollIntoView !== "function") return;
      if (t.matches("textarea, input[type='text'], input[type='search'], [contenteditable], [contenteditable] *") || (ui.editor && ui.editor.contains(t))) return;
      try {
        t.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      } catch (_) {}
    }, true);
  }

  function bindGlobal() {
    if (ui.listeners) return;
    ui.listeners = true;
    doc.addEventListener("keydown", onKey);
    bindKeyboardFocusReveal();
    doc.addEventListener("selectionchange", onSelectionChange);
    global.addEventListener("scroll", onViewportChange, true);
    global.addEventListener("resize", onViewportChange);
    doc.addEventListener("visibilitychange", () => {
      if (ui.phase !== "ready") return;
      if (doc.visibilityState === "hidden") {
        stopPoll();
        ui.core.flushAll({ keepalive: true });
      } else if (ui.active && carnetVisible()) {
        ui.core.poll();
        startPoll();
      }
    });
    global.addEventListener("pagehide", () => {
      if (ui.phase === "ready") ui.core.flushAll({ keepalive: true });
    });
    global.addEventListener("online", () => {
      if (ui.phase === "ready") {
        ui.core.retryAll();
        if (ui.active) ui.core.poll();
      }
      for (const fn of onlineSubs.slice()) {
        try {
          fn();
        } catch (_) {
          /* one subscriber never blocks the others */
        }
      }
    });
    if (typeof MutationObserver === "function" && doc.body) {
      new MutationObserver(() => {
        if (doc.body.dataset.view === "carnet") return;
        if (ui.active) {
          ui.active = false;
          exitFocus(); // Focus mode never leaks HQ chrome state into other views
          closeContext(false);
          stopPoll();
          if (ui.phase === "ready") ui.core.flushAll({ keepalive: true });
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ["data-view"] });
    }
  }

  async function boot() {
    ui.phase = "booting";
    const host = doc.getElementById("hq-carnet-app");
    ui.host = host;
    try {
      const me = await apiCall("/api/me", { timeoutMs: 8000 });
      ui.role = me && typeof me.role === "string" ? me.role : null;
      ui.user = me && typeof me.user === "string" ? me.user : "";
      if (!me || me.role !== "admin") {
        ui.phase = "denied";
        clearHome();
        renderDenied();
        return;
      }
      // Only now, with admin identity confirmed, may local drafts be read.
      ui.drafts = createDraftStore(safeStorage(), me.user);
      ui.core = createCore({
        request,
        fetchNotebook,
        drafts: ui.drafts,
        onChange: onCoreChange,
      });
      await ui.core.load();
      build(host);
      ui.phase = "ready";
      bindGlobal();
      showCurrent();
      render();
      layoutLibrary();
      if (ui.active && finePointer()) focusEditor(true);
      startPoll();
      processPending();
      processAnchor();
      dessinerResume();
      scheduleHome();
    } catch (err) {
      ui.phase = "failed";
      ui.core = null;
      ui.root = null;
      renderFail(err && err.message ? err.message : "erreur");
    }
  }

  function show() {
    ui.active = true;
    if (ui.phase === "idle" || ui.phase === "failed") {
      boot();
      return;
    }
    if (ui.phase === "ready") {
      ui.core.poll();
      startPoll();
      layoutLibrary();
      processPending();
      processAnchor();
      dessinerResume();
    }
  }

  /** Back from Dessiner: navigation first; the context is single-shot and validated (see hq-carnet-dessiner.js). */
  function dessinerResume() {
    const D = dessinerUi();
    if (D && D.hasContext()) D.resume().then(() => {}, (err) => console.error(err));
  }

  /** Home launcher requests run once the (single) editor is ready. */
  function processPending() {
    const p = ui.pending;
    const c = ui.core;
    if (!p || ui.phase !== "ready" || !c) return;
    ui.pending = null;
    if (p.create) {
      newPage(null); // Home "Nouvelle note" = global New: À classer
      return;
    }
    if (p.id && c.entry(p.id)) openPage(p.id);
  }

  function goCarnet() {
    if (doc.body && doc.body.dataset.view === "carnet") {
      show();
      return;
    }
    if (typeof global.setView === "function") global.setView("carnet");
    else show();
  }

  // ================================================================== Home summary (admin only)
  //
  // Privacy: nothing is fetched or rendered until /api/me confirms the admin role. Upload
  // users never trigger a Carnet request, never get titles/counts/previews, and never read
  // drafts (Home never touches local drafts at all).

  function homeHost() {
    return doc.getElementById("hq-carnet-home");
  }

  function clearHome() {
    const host = homeHost();
    if (!host) return;
    host.textContent = "";
    host.hidden = true;
  }

  function homeFromItems(items) {
    const active = items.filter((it) => !it.deleted);
    const pins = active.filter((it) => it.pinned).sort(byRecency);
    const rest = active.filter((it) => !it.pinned).sort(byRecency);
    const latest = active.slice().sort(byRecency)[0] || null;
    return { pages: active.length, pinned: pins.length, top: pins.concat(rest).slice(0, 3), latest };
  }

  function homeFromMeta(meta) {
    const items = [];
    for (const m of (meta && Array.isArray(meta.pages) ? meta.pages : [])) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      items.push({ id: m.id, title: typeof m.title === "string" && m.title ? m.title : UNTITLED, pinned: !!m.pinned, deleted: m.deleted_at != null, updated: Number(m.updated_at) || 0 });
    }
    return homeFromItems(items);
  }

  function agoText(tsSec) {
    const mins = Math.max(0, Math.round((Date.now() - Number(tsSec) * 1000) / 60000));
    if (mins < 1) return "à l'instant";
    if (mins < 60) return "il y a " + mins + " min";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return "il y a " + hrs + " h";
    const days = Math.round(hrs / 24);
    return days === 1 ? "hier" : "il y a " + days + " jours";
  }

  function renderHome(data) {
    const host = homeHost();
    if (!host || ui.role !== "admin") return;
    host.textContent = "";
    const counts = data.pages + (data.pages > 1 ? " pages" : " page") + " · " + data.pinned + (data.pinned > 1 ? " épinglées" : " épinglée");
    host.appendChild(el("div", { class: "sec-head" }, [
      el("h2", { id: "carnet-home-title", text: "Carnet" }),
      el("p", { class: "sec-hint", id: "carnet-home-counts", text: counts }),
    ]));
    // « Reprendre »: the page edited last, big; then the pinned pages as chips.
    if (data.latest) {
      const resume = el("button", { type: "button", class: "carnet-home-item carnet-home-resume", "data-carnet-page-id": data.latest.id });
      resume.appendChild(el("span", { class: "carnet-home-kicker", text: "Reprendre" }));
      resume.appendChild(el("span", { class: "carnet-home-title", text: data.latest.title }));
      if (data.latest.updated) resume.appendChild(el("span", { class: "carnet-home-when", text: agoText(data.latest.updated) }));
      host.appendChild(resume);
    }
    const chips = data.top.filter((it) => !data.latest || it.id !== data.latest.id);
    const list = el("ul", { class: "hq-list carnet-home-list" });
    for (const it of chips) {
      const b = el("button", { type: "button", class: "carnet-home-item carnet-home-chip", "data-carnet-page-id": it.id });
      b.appendChild(el("span", { class: "carnet-home-title", text: it.title }));
      if (it.pinned) b.appendChild(el("span", { class: "carnet-home-pin", text: "Épinglée" }));
      list.appendChild(el("li", null, [b]));
    }
    if (chips.length) host.appendChild(list);
    host.appendChild(el("div", { class: "row carnet-home-actions" }, [
      el("button", { type: "button", id: "btn-home-carnet-open", text: "Ouvrir le carnet" }),
      el("button", { type: "button", id: "btn-home-carnet-new", class: "secondary", text: "Nouvelle note" }),
    ]));
    host.setAttribute("aria-labelledby", "carnet-home-title");
    host.hidden = false;
  }

  function onHomeClick(ev) {
    const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;
    if (!b || ui.role !== "admin") return;
    if (b.id === "btn-home-carnet-open") ui.pending = null;
    else if (b.id === "btn-home-carnet-new") ui.pending = { create: true };
    else if (b.dataset.carnetPageId) ui.pending = { id: b.dataset.carnetPageId };
    else return;
    goCarnet();
  }

  function homeVisible() {
    return !!(doc.body && doc.body.dataset.view === "accueil" && homeHost());
  }

  function scheduleHome() {
    if (ui.role !== "admin" || !homeVisible() || !ui.core) return;
    if (ui.home.timer) return;
    ui.home.timer = setTimeout(() => {
      ui.home.timer = null;
      if (ui.core && ui.role === "admin") renderHome(homeFromItems(ui.core.libraryItems()));
    }, 80);
  }

  async function refreshHome() {
    const host = homeHost();
    if (!host) return;
    if (!host.dataset.bound) {
      host.dataset.bound = "1";
      host.addEventListener("click", onHomeClick);
    }
    if (ui.role && ui.role !== "admin") {
      clearHome();
      return;
    }
    if (ui.home.busy) return;
    ui.home.busy = true;
    try {
      if (ui.phase === "ready" && ui.core) {
        renderHome(homeFromItems(ui.core.libraryItems()));
        await ui.core.poll(); // one-shot freshness; the Carnet poll timer stays Carnet-only
        renderHome(homeFromItems(ui.core.libraryItems()));
        return;
      }
      if (!ui.role) {
        const me = await apiCall("/api/me", { timeoutMs: 8000 });
        ui.role = me && typeof me.role === "string" ? me.role : "upload";
      }
      if (ui.role !== "admin") {
        clearHome();
        return;
      }
      const meta = await apiCall("/api/carnet?meta=1", { timeoutMs: 8000 });
      if (ui.phase === "ready" && ui.core) renderHome(homeFromItems(ui.core.libraryItems()));
      else renderHome(homeFromMeta(meta));
    } catch (_) {
      // Quiet: Home stays usable; the summary simply does not appear.
    } finally {
      ui.home.busy = false;
    }
  }

  global.hqCarnetHome = function () {
    try {
      refreshHome();
    } catch (e) {
      console.error(e);
    }
  };

  /** Quick Capture hooks (hq-carnet-capture.js): adopt a page created elsewhere, and open it in the Carnet view. No state of its own. */
  global.hqCarnetRefresh = function () {
    try {
      return ui.phase === "ready" && ui.core ? ui.core.poll() : Promise.resolve([]);
    } catch (_) {
      return Promise.resolve([]);
    }
  };
  global.hqCarnetOpen = async function (id) {
    if (typeof id !== "string" || !id) return;
    try {
      if (ui.phase === "ready" && ui.core) await ui.core.poll(); // the page was created by another request: make it known first
    } catch (_) {}
    ui.pending = { id };
    goCarnet();
  };

  global.hqCarnetShow = function () {
    try {
      show();
    } catch (e) {
      console.error(e);
      ui.phase = "failed";
      renderFail("erreur d'initialisation");
    }
  };
  global.hqCarnetDebug = function () {
    return {
      phase: ui.phase,
      active: ui.active,
      pollActive: !!ui.pollTimer,
      storageFailed: !!(ui.drafts && ui.drafts.failed),
      attention: ui.core ? ui.core.status().attention.length : 0,
      core: ui.core ? ui.core.snapshot() : null,
      focus: ui.focus,
      library: ui.libEl ? { mode: libMode(), visible: !ui.libEl.hidden } : null,
      role: ui.role,
      polish: ui.polish ? { outline: ui.polish.outlineState(), save: ui.polish.saveState() } : null,
    };
  };
  // Phase 3.5: block deep links (#carnet/<pageId>/<blockId>): initial load, hashchange, Back / Forward. Zero authority: the normal
  // admin check still decides everything, and a malformed fragment is ignored whole.
  if (global.addEventListener) {
    global.addEventListener("hashchange", () => {
      try {
        onHashChange();
      } catch (e) {
        console.error(e);
      }
    });
    const initial = currentHashAnchor();
    if (initial) {
      ui.pendingAnchor = initial;
      const go = () => {
        if (ui.pendingAnchor) goCarnet();
      };
      if (doc.readyState === "complete") setTimeout(go, 0);
      else global.addEventListener("load", () => setTimeout(go, 0), { once: true });
    }
  }
  if (doc.body && doc.body.dataset.view === "accueil") global.hqCarnetHome();
})(typeof window !== "undefined" ? window : globalThis);
