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
  };
  const SYMBOLS = ["Ø", "±", "°", "µ", "Δ", "×", "→", "≤", "≥", "²", "³"];

  // ------------------------------------------------------------------ pure helpers

  function deriveTitle(text) {
    const lines = String(text || "").split(/\r\n|\r|\n/);
    for (const line of lines) {
      const t = line.trim();
      if (t) return t.slice(0, 120);
    }
    return UNTITLED;
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
      };
    }

    function isDirty(e) {
      return e.generation !== e.savedGeneration;
    }

    function busy(e) {
      return isDirty(e) || !!e.inflight || !!e.conflict;
    }

    function draftRecord(e) {
      return {
        server_rev: e.serverRev,
        generation: e.generation,
        saved_generation: e.savedGeneration,
        updated_local_at: e.updatedLocalAt || now(),
        project_id: e.local.project_id,
        category_id: e.local.category_id,
        pinned: e.local.pinned,
        content: { version: 1, blocks: [{ id: e.blockId, type: "text", text: e.local.text, marks: [] }] },
      };
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
      if (e.conflict || e.orphan) return;
      e.timer = timers.set(() => {
        e.timer = null;
        flush(e.id);
      }, DEBOUNCE_MS);
    }

    function isActive(e) {
      return !e.server || e.server.deleted_at == null;
    }

    // ---------------------------------------------------------------- edits

    function edit(id, patch) {
      const e = st.entries.get(id);
      if (!e) return false;
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
      if (e.conflict || e.orphan || !isDirty(e)) return Promise.resolve();
      if (e.inflight) return e.inflight.promise; // one in-flight save per page; newer state follows on return
      if (e.retryTimer) {
        timers.clear(e.retryTimer);
        e.retryTimer = null;
      }
      const sent = Object.assign({}, e.local);
      const generation = e.generation;
      const expected = e.serverRev;
      const payload = {
        action: "page_save",
        id: e.id,
        expected_rev: expected,
        content: { version: 1, blocks: [{ id: e.blockId, type: "text", text: sent.text, marks: [] }] },
      };
      // Stage 02 never edits project/category: never send them (a stale client must not
      // resurrect a deleted category). Pin is sent only when it differs from the server.
      if (!e.server || sent.pinned !== !!e.server.pinned) payload.pinned = sent.pinned;
      let keepalive = !!(options && options.keepalive);
      if (keepalive) {
        try {
          if (utf8Bytes(JSON.stringify(payload)) > KEEPALIVE_MAX) keepalive = false; // browser keepalive cap is ~64 KiB
        } catch (_) {
          keepalive = false;
        }
      }
      const inflight = { generation, sent, expected, promise: null };
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
        if (remote.text === inflight.sent.text && remote.pinned === inflight.sent.pinned) {
          // The server already holds exactly what we sent (e.g. a keepalive flush from a
          // closed tab landed after reload): not a conflict — adopt it like a success.
          return onSaved(e, inflight, { page: data.page, notebook_rev: data.notebook_rev });
        }
        if (Number.isInteger(data.notebook_rev)) st.notebookRev = data.notebook_rev;
        e.conflict = { page: data.page };
        clearTimers(e);
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
      e.blockId = pageBlockId(page) || e.blockId;
      e.local = editableFromPage(page);
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
      if (!e || !e.conflict) return Promise.resolve();
      const page = e.conflict.page;
      e.conflict = null;
      e.server = page;
      e.serverRev = page.rev;
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
        if (busy(e)) continue; // dirty / saving / conflicted: never overwritten by a refresh
        if (p.rev > e.serverRev) {
          e.server = p;
          e.serverRev = p.rev;
          e.blockId = pageBlockId(p) || e.blockId;
          const next = editableFromPage(p);
          if (!sameEditable(next, e.local)) adopted.push(p.id);
          e.local = next;
        } else if (p.rev === e.serverRev) {
          e.server = p;
        }
      }
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
        if (isActive(e) || busy(e)) order.push(e.id);
      }
      for (const [id, e] of st.entries) if (e.orphan && !order.includes(id)) order.push(id);
      st.order = order;
      if (!st.currentId || !order.includes(st.currentId)) {
        const oldIdx = Math.max(0, prevOrder.indexOf(st.currentId));
        st.currentId = order.length ? order[Math.min(oldIdx, order.length - 1)] : null;
      }
      return adopted;
    }

    function applyDrafts(map) {
      for (const id of Object.keys(map)) {
        const d = map[id];
        if (d.generation <= d.saved_generation) continue;
        let e = st.entries.get(id);
        const block = d.content.blocks[0];
        const draftLocal = {
          text: block.text,
          pinned: !!d.pinned,
          project_id: optId(d.project_id),
          category_id: optId(d.category_id),
        };
        if (!e) {
          const page = {
            id,
            rev: d.server_rev,
            project_id: draftLocal.project_id,
            category_id: draftLocal.category_id,
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
          const server = editableFromPage(e.server);
          // Our own save already landed (tab closed before the draft was cleared).
          if (server.text === draftLocal.text && server.pinned === draftLocal.pinned) {
            drafts.drop(id, d.generation, draftLocal);
            continue;
          }
          if (!st.order.includes(id)) st.order.push(id);
        }
        e.local = draftLocal;
        e.serverRev = d.server_rev;
        e.generation = d.generation;
        e.savedGeneration = d.saved_generation;
        e.updatedLocalAt = Number(d.updated_local_at) || now();
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
        if (busy(e)) continue;
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
      const next = st.order[idx + delta];
      if (!next) return null;
      return select(next);
    }

    function select(id) {
      if (!st.entries.has(id) || id === st.currentId) return null;
      const prev = st.currentId;
      st.currentId = id;
      if (prev) flush(prev); // never waits: the page switch is local
      onChange({ type: "select", id, prev });
      return id;
    }

    async function createPage() {
      if (st.creating) return null;
      st.creating = true;
      try {
        if (st.currentId) flush(st.currentId);
        const cur = st.entries.get(st.currentId);
        const afterId = cur && !cur.orphan && isActive(cur) ? cur.id : null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const res = await request({
              action: "page_create",
              expected_notebook_rev: st.notebookRev,
              after_id: afterId,
            }, {});
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
      if (e && e.conflict) cur = { text: MSG.conflictStatus, kind: "warn" };
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
    deriveTitle,
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
  };

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
    const context = el("button", { type: "button", id: "btn-carnet-context", class: "carnet-pill", title: "Projet et catégorie" });
    const pin = iconButton("btn-carnet-pin", "Épingler", ICON.pin, { "aria-pressed": "false" });
    const library = iconButton("btn-carnet-library", "Bibliothèque", ICON.library);
    const more = iconButton("btn-carnet-more", "Symboles et outils", ICON.more, { "aria-expanded": "false", "aria-controls": "carnet-quick-tools" });
    const top = el("div", { class: "carnet-bar carnet-bar-top" }, [
      context,
      el("div", { class: "carnet-status-wrap" }, [status, attention, flash]),
      el("div", { class: "carnet-actions" }, [pin, library, more]),
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

    const conflict = el("div", { id: "hq-carnet-conflict", class: "carnet-conflict", role: "alert", hidden: true }, [
      el("p", { class: "carnet-conflict-msg", text: MSG.conflict }),
      el("div", { class: "carnet-conflict-actions" }, [
        el("button", { type: "button", id: "btn-carnet-conflict-remote", class: "secondary", text: "Charger la version distante" }),
        el("button", { type: "button", id: "btn-carnet-conflict-local", text: "Remplacer avec ma version" }),
      ]),
    ]);

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

    root.append(top, conflict, tools, stage, bottom);
    host.textContent = "";
    host.appendChild(root);

    ui.root = root;
    ui.editor = editor;
    ui.paper = paper;
    ui.statusEl = status;
    ui.flashEl = flash;

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
    add.addEventListener("click", () => {
      if (ui.core) ui.core.createPage().then((id) => {
        if (id) focusEditor(true);
      });
    });
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
    context.addEventListener("click", () => flashMsg("Classement : bientôt disponible"));
    library.addEventListener("click", () => flashMsg("Bibliothèque : bientôt disponible"));
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
    });
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
  }

  function isReadOnly(e) {
    return !!(e && e.server && e.server.deleted_at != null);
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
    doc.getElementById("carnet-page-indicator").textContent = total ? idx + 1 + " / " + total : "—";
    doc.getElementById("btn-carnet-prev").disabled = idx <= 0;
    doc.getElementById("btn-carnet-next").disabled = idx < 0 || idx >= total - 1;
    const pin = doc.getElementById("btn-carnet-pin");
    pin.setAttribute("aria-pressed", e && e.local.pinned ? "true" : "false");
    pin.disabled = !e || isReadOnly(e);
    const ctx = doc.getElementById("btn-carnet-context");
    ctx.textContent = metaLabel(e);
    const when = e && e.server ? fmtWhen(e.server.updated_at) : "";
    ctx.title = when ? "Projet et catégorie · modifiée " + when : "Projet et catégorie";
    const conflict = doc.getElementById("hq-carnet-conflict");
    conflict.hidden = !(e && e.conflict);
    ui.editor.readOnly = !e || isReadOnly(e);
    if (e) ui.editor.dataset.pageId = e.id;
    else delete ui.editor.dataset.pageId;
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

  function onKey(e) {
    if (ui.phase !== "ready" || !doc.body || doc.body.dataset.view !== "carnet") return;
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
      if (!me || me.role !== "admin") {
        ui.phase = "denied";
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
      if (ui.active && finePointer()) focusEditor(true);
      startPoll();
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
    }
  }

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
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
