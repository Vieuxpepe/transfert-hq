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
  };
  const SYMBOLS = ["Ø", "±", "°", "µ", "Δ", "×", "→", "≤", "≥", "²", "³"];
  const ORG = ["project_id", "category_id"];
  const FILTERS = [
    ["all", "Toutes"],
    ["pinned", "Épinglées"],
    ["recent", "Récentes"],
    ["unfiled", "À classer"],
  ];
  const BUCKETS = [
    ["today", "Aujourd'hui"],
    ["yesterday", "Hier"],
    ["week", "Cette semaine"],
    ["older", "Plus ancien"],
  ];
  const PREVIEW_MAX = 160;
  const PAGE_TEXT_BYTES = 48 * 1024; // server contract (hq_carnet.PAGE_TEXT_BYTES)

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

  function pageText(page) {
    try {
      const t = page.content.blocks[0].text;
      return typeof t === "string" ? t : "";
    } catch (_) {
      return "";
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
    return isObj(p) && typeof p.id === "string" && Number.isInteger(p.rev) && isObj(p.content) &&
      Array.isArray(p.content.blocks) && p.content.blocks.length === 1 && typeof pageText(p) === "string";
  }

  function validDraft(d) {
    return isObj(d) && Number.isInteger(d.server_rev) && Number.isInteger(d.generation) &&
      Number.isInteger(d.saved_generation) && isObj(d.content) && Array.isArray(d.content.blocks) &&
      d.content.blocks.length === 1 && isObj(d.content.blocks[0]) && typeof d.content.blocks[0].text === "string";
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
      return validDraft(cur) && cur.content.blocks[0].text === sent.text && !!cur.pinned === !!sent.pinned;
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
      return {
        text: pageText(p),
        pinned: !!p.pinned,
        project_id: optId(p.project_id),
        category_id: optId(p.category_id),
      };
    }

    function sameEditable(a, b) {
      return a.text === b.text && a.pinned === b.pinned && a.project_id === b.project_id && a.category_id === b.category_id;
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

    function draftRecord(e) {
      const rec = {
        server_rev: e.serverRev,
        generation: e.generation,
        saved_generation: e.savedGeneration,
        updated_local_at: e.updatedLocalAt || now(),
        pinned: e.local.pinned,
        content: { version: 1, blocks: [{ id: e.blockId, type: "text", text: e.local.text, marks: [] }] },
      };
      // Exact content of the save base (not a hash): lets a restore rebase only on proven
      // equality. It changes only when the base does (never per keystroke).
      const base = baseContent(e);
      if (base) rec.base = { version: 1, text: base.text, pinned: base.pinned };
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

    /** Exact content (text + pin) of the save base, or null when it is not known exactly. */
    function baseContent(e) {
      if (e.server && e.server.rev === e.serverRev) return { text: pageText(e.server), pinned: !!e.server.pinned };
      return e.draftBase || null;
    }

    /** Persisted exact base snapshot; anything malformed, legacy or impossible fails CLOSED (null). */
    function readDraftBase(b) {
      if (!isObj(b)) return null;
      const keys = Object.keys(b).sort().join(",");
      if (keys !== "pinned,text,version" || b.version !== 1) return null;
      if (typeof b.text !== "string" || typeof b.pinned !== "boolean") return null;
      try {
        if (utf8Bytes(b.text) > PAGE_TEXT_BYTES) return null;
      } catch (_) {
        return null;
      }
      return { text: b.text, pinned: b.pinned };
    }

    /**
     * A newer authoritative copy whose text/pin equal the save base only changed lifecycle or
     * organization: the local save may be rebased onto it without hiding any remote content.
     * Otherwise the base is kept and the ordinary 409 conflict protection applies.
     */
    function rebaseIfContentUnchanged(e, page) {
      if (!validPage(page) || page.rev <= e.serverRev || e.inflight || e.conflict) return false;
      const base = baseContent(e);
      if (!base || base.text !== pageText(page) || base.pinned !== (page.pinned === true)) return false;
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
      if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
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
      const sent = Object.assign({}, e.local);
      const generation = e.generation;
      const expected = e.serverRev;
      const payload = {
        action: "page_save",
        id: e.id,
        expected_rev: expected,
        content: { version: 1, blocks: [{ id: e.blockId, type: "text", text: sent.text, marks: [] }] },
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
      const inflight = { generation, sent, expected, org, promise: null };
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
      if (e.generation === inflight.generation && sameEditable(e.local, inflight.sent)) {
        e.savedGeneration = inflight.generation;
        drafts.drop(e.id, inflight.generation, inflight.sent);
        e.error = "";
        st.savedOnce = true;
        onChange({ type: "saved", id: e.id });
        return;
      }
      // Late success: newer typing exists. Keep dirty + draft, record the new base rev,
      // and send the newest state immediately against it.
      persist(e);
      onChange({ type: "saved-stale", id: e.id });
      if (!e.conflict) return flush(e.id);
    }

    function onSaveError(e, inflight, err) {
      if (e.inflight === inflight) e.inflight = null;
      const status = err && Number.isInteger(err.status) ? err.status : 0;
      const data = err && isObj(err.data) ? err.data : null;
      if (status === 409 && data && data.code === "revision_conflict" && validPage(data.page)) {
        const remote = editableFromPage(data.page);
        const orgSame = ORG.every((f) => !has(inflight.org, f) || remote[f] === inflight.org[f]);
        if (remote.text === inflight.sent.text && remote.pinned === inflight.sent.pinned && orgSame) {
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
      else e.error = String((data && data.error) || (err && err.message) || "Erreur").slice(0, 160);
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
        const block = d.content.blocks[0];
        // The draft owns text + pin only. Legacy project_id/category_id snapshots are ignored;
        // explicit organization intents are re-validated against the fresh server page.
        const draftLocal = { text: block.text, pinned: !!d.pinned };
        if (!e) {
          const page = {
            id,
            rev: d.server_rev,
            project_id: null,
            category_id: null,
            pinned: draftLocal.pinned,
            deleted_at: null,
            content: { version: 1, blocks: [{ id: typeof block.id === "string" ? block.id : null, type: "text", text: "", marks: [] }] },
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
          if (server.text === draftLocal.text && server.pinned === draftLocal.pinned && !Object.keys(e.intent).length) {
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
        onChange({ type: "poll", adopted });
        if (wasOffline) retryAll();
        return adopted;
      } catch (err) {
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
            const res = await request(Object.assign({
              action: "page_create",
              expected_notebook_rev: st.notebookRev,
              after_id: afterId,
            }, ctx), {});
            if (!validPage(res && res.page)) throw new Error("Réponse carnet invalide");
            if (Number.isInteger(res.notebook_rev)) st.notebookRev = res.notebook_rev;
            const e = newEntry(res.page);
            st.entries.set(e.id, e);
            const at = afterId ? st.order.indexOf(afterId) + 1 : st.order.length;
            st.order.splice(at > 0 ? at : st.order.length, 0, e.id);
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
            if (!status || status >= 500) st.offline = true;
            st.notice = !status || status >= 500 ? MSG.offlineClean + " — nouvelle page impossible" :
              String((data && data.error) || (err && err.message) || "Erreur").slice(0, 160);
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
      return String((data && data.error) || (err && err.message) || "Erreur").slice(0, 160);
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
          body: bodyText(text),
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
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!global || typeof global.document === "undefined") return;

  // ================================================================== browser UI

  const doc = global.document;
  const ui = {
    phase: "idle", // idle | booting | ready | denied | failed
    active: false,
    core: null,
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
    lib: { open: false, collapsed: false, manage: false, sel: { filter: "all", id: null }, query: "", timer: null, sig: "", scopeSig: "" },
    libEl: null,
    ctxOpen: false,
    focus: false,
    undo: null, // {id, timer}
    confirmId: null, // page awaiting permanent-delete confirmation
    confirmRev: null, // the exact authoritative revision the human is confirming
    deleteNotice: null, // {id, text}: a stale confirmation was invalidated
    pending: null, // Home launcher request processed once the editor is ready
    home: { busy: false, timer: null },
    mqBound: false,
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

    const status = el("p", { id: "hq-carnet-status", class: "carnet-status", role: "status", "aria-live": "polite" });
    const flash = el("span", { class: "carnet-flash", role: "status", "aria-live": "polite" });
    const attention = el("button", { type: "button", id: "btn-carnet-attention", class: "carnet-attention", hidden: true });
    const context = el("button", {
      type: "button", id: "btn-carnet-context", class: "carnet-pill", title: "Projet et catégorie",
      "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "hq-carnet-context",
    });
    const pin = iconButton("btn-carnet-pin", "Épingler", ICON.pin, { "aria-pressed": "false" });
    const library = iconButton("btn-carnet-library", "Bibliothèque", ICON.library, { "aria-expanded": "false", "aria-controls": "hq-carnet-library" });
    const focusBtn = iconButton("btn-carnet-focus", "Mode concentration", ICON.focus, { "aria-pressed": "false" });
    const more = iconButton("btn-carnet-more", "Symboles et outils", ICON.more, { "aria-expanded": "false", "aria-controls": "carnet-quick-tools" });
    const top = el("div", { class: "carnet-bar carnet-bar-top" }, [
      context,
      el("div", { class: "carnet-status-wrap" }, [status, attention, flash]),
      el("div", { class: "carnet-actions" }, [pin, library, focusBtn, more]),
    ]);

    const tools = el("div", { id: "carnet-quick-tools", class: "carnet-tools", role: "toolbar", "aria-label": "Symboles", hidden: true });
    for (const sym of SYMBOLS) {
      const b = el("button", { type: "button", class: "carnet-sym", "data-carnet-symbol": sym, "aria-label": "Insérer " + sym, text: sym });
      keepFocus(b);
      tools.appendChild(b);
    }
    const time = el("button", { type: "button", id: "btn-carnet-time", class: "carnet-sym carnet-time", "aria-label": "Insérer l'heure" });
    time.appendChild(svgIcon(ICON.clock));
    time.appendChild(el("span", { text: "Heure" }));
    keepFocus(time);
    tools.appendChild(time);
    const trash = el("button", { type: "button", class: "carnet-sym carnet-trash-btn", "data-carnet-trash": "", "aria-label": "Mettre la page à la corbeille" });
    trash.appendChild(svgIcon(ICON.trash));
    trash.appendChild(el("span", { text: "Corbeille" }));
    tools.appendChild(trash);

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

    const editor = el("textarea", {
      id: "hq-carnet-editor",
      class: "carnet-editor",
      "aria-label": "Page du carnet",
      spellcheck: "true",
      autocapitalize: "sentences",
      autocomplete: "off",
      placeholder: "Écris…",
    });
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

    const main = el("div", { class: "carnet-main" }, [top, ctxBackdrop, ctxPanel, conflict, trashed, confirm, undo, tools, stage, bottom, focusExit]);
    const lib = buildLibrary();
    const libBackdrop = el("div", { class: "carnet-lib-backdrop", "aria-hidden": "true", hidden: true });
    root.append(lib, libBackdrop, main);
    host.textContent = "";
    host.appendChild(root);

    ui.root = root;
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

    editor.addEventListener("input", () => {
      const c = ui.core;
      if (!c || !c.st.currentId) return;
      c.edit(c.st.currentId, { text: editor.value });
    });
    editor.addEventListener("blur", () => {
      if (ui.core && ui.core.st.currentId) ui.core.flush(ui.core.st.currentId);
    });
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
      ui.swipe = { x: t.clientX, y: t.clientY, t: Date.now(), multi: false };
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      if (ui.swipe && e.touches && e.touches.length > 1) ui.swipe.multi = true;
    }, { passive: true });
    stage.addEventListener("touchcancel", () => {
      ui.swipe = null;
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      const s = ui.swipe;
      ui.swipe = null;
      if (!s || s.multi || !e.changedTouches || !e.changedTouches.length) return;
      if (Date.now() - s.t > SWIPE_MAX_MS) return; // long press = selection / caret placement
      if (editor.selectionStart !== editor.selectionEnd) return; // selecting text
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!isSwipe(dx, dy)) return;
      navigate(dx < 0 ? 1 : -1);
    }, { passive: true });

    bindMedia();
    ui.lib.open = false;
  }

  // ---------------------------------------------------------------- library (Bibliothèque)

  function buildLibrary() {
    const aside = el("aside", { id: "hq-carnet-library", class: "carnet-library", "aria-label": "Bibliothèque", hidden: true });
    const head = el("div", { class: "carnet-lib-head" }, [
      el("h3", { class: "carnet-lib-title", text: "Bibliothèque" }),
      el("button", { type: "button", id: "btn-carnet-lib-new", class: "carnet-small", text: "+ Nouvelle page" }),
      iconButton("btn-carnet-lib-close", "Fermer la bibliothèque", ICON.close, { class: "carnet-btn carnet-lib-close" }),
    ]);
    const search = el("input", {
      type: "search", id: "hq-carnet-search", class: "carnet-input carnet-search", placeholder: "Rechercher…",
      "aria-label": "Rechercher dans le carnet", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
    });
    const filters = el("div", { class: "carnet-filters", role: "group", "aria-label": "Filtres" });
    for (const [key, label] of FILTERS.concat([["trash", "Corbeille"]])) {
      filters.appendChild(el("button", { type: "button", class: "carnet-chip" + (key === "trash" ? " carnet-chip-trash" : ""), "data-carnet-filter": key, "aria-pressed": "false", text: label }));
    }
    const scopes = el("div", { class: "carnet-lib-scopes" });
    const list = el("div", { id: "carnet-library-list", class: "carnet-lib-list", role: "list", "aria-label": "Pages" });
    const scopeLabel = el("p", { class: "carnet-lib-scope", "aria-live": "polite" });
    aside.append(head, search, filters, scopes, scopeLabel, list);

    search.addEventListener("input", () => {
      ui.lib.query = search.value;
      scheduleLibrary(60);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
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
    const items = c.libraryItems();
    renderScopes(items);
    const label = lib.querySelector(".carnet-lib-scope");
    let scopeText = "";
    if (sel.filter === "project") scopeText = "Projet : " + nameOf(c.st.projects, sel.id);
    else if (sel.filter === "category") scopeText = "Catégorie : " + nameOf(c.st.categories, sel.id);
    label.textContent = scopeText;
    label.hidden = !scopeText;
    renderList(items);
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
    const sig = JSON.stringify([c.st.projects, c.st.categories, sel, ui.lib.manage, [...pc], [...cc]]);
    if (sig === ui.lib.scopeSig) return;
    if (box.contains(doc.activeElement) && doc.activeElement.tagName !== "BUTTON") return; // never rebuild under typing
    ui.lib.scopeSig = sig;
    box.textContent = "";
    const manage = ui.lib.manage;
    const active = c.st.projects.filter((p) => isObj(p) && !p.archived);
    const archived = c.st.projects.filter((p) => isObj(p) && p.archived);

    const projHead = el("div", { class: "carnet-lib-sec-head" }, [
      el("h4", { text: "Projets" }),
      el("button", { type: "button", class: "carnet-small", "data-carnet-act": "manage", "aria-pressed": manage ? "true" : "false", text: manage ? "Terminé" : "Gérer" }),
    ]);
    const projList = el("div", { class: "carnet-chips" });
    for (const p of active) projList.appendChild(scopeChip("project", p, pc.get(p.id) || 0, sel));
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

    const catHead = el("div", { class: "carnet-lib-sec-head" }, [el("h4", { text: "Catégories" })]);
    const catList = el("div", { class: "carnet-chips" });
    for (const k of c.st.categories.filter(isObj)) catList.appendChild(scopeChip("category", k, cc.get(k.id) || 0, sel));
    if (!c.st.categories.length && !manage) catList.appendChild(el("p", { class: "hint carnet-empty", text: "Aucune catégorie" }));
    box.append(catHead, catList);
    if (manage) {
      for (const k of c.st.categories.filter(isObj)) box.appendChild(categoryRow(k));
      box.appendChild(createForm("category"));
    }
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
    const top = el("span", { class: "carnet-card-top" }, [el("span", { class: "carnet-card-title", text: it.title })]);
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
    if (!count) list.appendChild(el("p", { class: "hint carnet-empty", text: result.searching ? MSG.noResults : trash ? "Corbeille vide" : MSG.noPages }));
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
      flashMsg(ui.core ? ui.core.userMessage(err) : "Erreur");
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
  }

  function setEditorText(text, keepCaret) {
    const ed = ui.editor;
    if (ed.value === text) return;
    const s = ed.selectionStart;
    const t = ed.selectionEnd;
    ed.value = text;
    if (keepCaret && doc.activeElement === ed) {
      try {
        ed.setSelectionRange(Math.min(s, text.length), Math.min(t, text.length));
      } catch (_) {}
    }
  }

  function showCurrent() {
    const e = ui.core && ui.core.current();
    setEditorText(e ? e.local.text : "", false);
    try {
      ui.editor.scrollTop = 0;
    } catch (_) {}
  }

  function onCoreChange(evt) {
    if (!ui.root) return;
    const c = ui.core;
    if (evt && evt.type === "select") {
      showCurrent();
    } else if (evt && evt.type === "remote" && evt.id === c.st.currentId) {
      setEditorText(c.current().local.text, true);
    } else if (evt && (evt.type === "poll" || evt.type === "loaded")) {
      const e = c.current();
      if (e && !ui.editor.dataset.pageId) showCurrent();
      else if (e && ui.editor.dataset.pageId !== e.id) showCurrent();
      else if (e && evt.adopted && evt.adopted.includes(e.id) && !c.isDirty(e)) setEditorText(e.local.text, true);
    }
    if (evt && evt.type === "edit") c.st.notice = "";
    render();
    const t = evt && evt.type;
    if (t === "edit") scheduleLibrary(300);
    else if (t !== "saving") scheduleLibrary(40);
    if (t && t !== "edit" && t !== "saving") scheduleHome();
  }

  function flashMsg(text) {
    if (!ui.flashEl) return;
    ui.flashEl.textContent = text;
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(() => {
      ui.flashTimer = null;
      if (ui.flashEl) ui.flashEl.textContent = "";
    }, 1800);
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

  function navigate(delta) {
    const c = ui.core;
    if (!c) return;
    const old = ui.editor ? ui.editor.value : "";
    const hadFocus = doc.activeElement === ui.editor;
    if (c.go(delta)) {
      flipGhost(delta, old);
      if (hadFocus) focusEditor(false);
    }
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
    if (doc.activeElement !== ed) ed.focus({ preventScroll: true });
    let ok = false;
    try {
      ok = doc.execCommand && doc.execCommand("insertText", false, text); // keeps native undo
    } catch (_) {
      ok = false;
    }
    if (!ok || ed.value !== ui.core.current().local.text) {
      if (!ok) {
        ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, "end");
      }
      ed.dispatchEvent(new Event("input", { bubbles: true }));
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

  function bindGlobal() {
    if (ui.listeners) return;
    ui.listeners = true;
    doc.addEventListener("keydown", onKey);
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
      if (ui.phase !== "ready") return;
      ui.core.retryAll();
      if (ui.active) ui.core.poll();
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
    }
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
    return { pages: active.length, pinned: pins.length, top: pins.concat(rest).slice(0, 3) };
  }

  function homeFromMeta(meta) {
    const items = [];
    for (const m of (meta && Array.isArray(meta.pages) ? meta.pages : [])) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      items.push({ id: m.id, title: typeof m.title === "string" && m.title ? m.title : UNTITLED, pinned: !!m.pinned, deleted: m.deleted_at != null, updated: Number(m.updated_at) || 0 });
    }
    return homeFromItems(items);
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
    const list = el("ul", { class: "hq-list carnet-home-list" });
    for (const it of data.top) {
      const b = el("button", { type: "button", class: "carnet-home-item", "data-carnet-page-id": it.id });
      b.appendChild(el("span", { class: "carnet-home-title", text: it.title }));
      if (it.pinned) b.appendChild(el("span", { class: "carnet-home-pin", text: "Épinglée" }));
      list.appendChild(el("li", null, [b]));
    }
    if (data.top.length) host.appendChild(list);
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
    };
  };
  if (doc.body && doc.body.dataset.view === "accueil") global.hqCarnetHome();
})(typeof window !== "undefined" ? window : globalThis);
