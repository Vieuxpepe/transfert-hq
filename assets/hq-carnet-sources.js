/* Transfert HQ — Carnet Stage 05: engineering sources, citations, exact PDF location.
 *
 * Pure helpers (Node-testable) + `mount(host)`, the browser UI (picker, source manager, source view).
 *
 * Model (server: hq_carnet_sources.py, storage <ROOT>/.hq-carnet/sources.json, own `sources_rev`):
 *   family  : a work ("Shigley's Mechanical Engineering Design")
 *   edition : one concrete edition of a family (11e, 12e…) with its own PDF reference + calibration.
 *             An old edition is never mutated into a new one: a new edition is a new record and the old one
 *             is only annotated `superseded_by`. Archive is a tombstone, never a delete.
 *   citation: a structured mark inside a note (hq-carnet-rich.js) carrying a bounded snapshot of the edition,
 *             a semantic locator (printed page, section, clause…), an OPTIONAL actual PDF page, a `ok` flag
 *             (the LOCATION was checked by the user — never the truth of the content) and `from`
 *             (migration provenance).
 *
 * Never assumed: printed page == PDF page. The only mapping is an explicit user calibration
 * ("printed page N is PDF page M"), applied to numeric `page` locators only.
 *
 * The PDF view is the browser's own PDF viewer in a same-origin iframe (`/files/<rel>#page=N`). It is NOT
 * guaranteed to honour #page (notably iOS/Safari): the UI says so and always shows the expected page.
 *
 * Plain ES2020, DOM built with createElement/textContent only, no dynamic code, no network other than same-origin /api/carnet and /files/.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetSources = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const Rich = (function () {
    if (global && global.HqCarnetRich) return global.HqCarnetRich;
    if (typeof require === "function") return require("./hq-carnet-rich.js");
    throw new Error("hq-carnet-rich.js manquant");
  })();

  const M = (global && global.HqCarnetModal) || (typeof require === "function" ? (function () { try { return require("./hq-carnet-modal.js"); } catch (e) { return null; } })() : null);

  const TYPES = ["book", "standard", "article", "datasheet", "catalogue", "procedure", "web", "other"];
  const TYPE_LABEL = {
    book: "Livre", standard: "Norme", article: "Article", datasheet: "Fiche technique", catalogue: "Catalogue fabricant",
    procedure: "Procédure interne", web: "Web", other: "Autre",
  };
  const KIND_LABEL = { page: "Page", section: "Section", clause: "Article / clause", chapter: "Chapitre", figure: "Figure", table: "Tableau", custom: "Autre" };
  const PAGE_MAX = Rich.CITE_PAGE_MAX;
  const RECENT_MAX = 8;
  const RESULTS_MAX = 50;
  const ZOOMS = [50, 75, 100, 125, 150, 200, 300];
  const RECENT_PREFIX = "hq_carnet_recent_sources_v1:";

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  // ------------------------------------------------------------------ pure helpers

  /** Accent- and case-insensitive folding for search ("Élément" matches "element"). */
  function fold(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function editionTitle(ed) {
    return ed.title + (ed.edition ? " — " + ed.edition : "");
  }

  /** Bounded snapshot stored in a citation (same limits as the server). */
  function editionSnapshot(ed) {
    const snap = { title: ed.title };
    if (ed.author) snap.author = ed.author;
    if (ed.edition) snap.edition = ed.edition;
    if (ed.year) snap.year = ed.year;
    if (ed.identifier) snap.ident = ed.identifier;
    return snap;
  }

  /**
   * Build a citation payload for `ed`. loc = {kind, text}; pdf = int|null; ok = explicit user flag;
   * from = null | {src, loc, pdf, ok}. Returns null when the payload is not valid (never throws).
   */
  function buildCite(ed, loc, pdf, ok, from) {
    if (!ed || !isObj(loc)) return null;
    return Rich.checkCite({
      src: ed.id, loc: { kind: loc.kind, text: loc.text == null ? "" : loc.text }, pdf: pdf == null ? null : pdf, ok: !!ok,
      snap: editionSnapshot(ed), from: from || null,
    });
  }

  /** printed page -> PDF page through the explicit calibration. null when unknown (mirrors the server). */
  function resolvePdf(ed, loc, pdf) {
    if (pdf != null) return pdf;
    const cal = ed && ed.calibration;
    if (!cal || !loc || loc.kind !== "page") return null;
    const text = String(loc.text || "").trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const page = Number(text) + (cal.pdf - cal.printed);
    return Number.isSafeInteger(page) && page >= 1 && page <= PAGE_MAX ? page : null;
  }

  /** PDF page -> printed page (inverse of the calibration), or null. */
  function printedFor(ed, pdfPage) {
    const cal = ed && ed.calibration;
    if (!cal || !(pdfPage >= 1)) return null;
    const printed = pdfPage - (cal.pdf - cal.printed);
    return printed >= 1 && printed <= PAGE_MAX ? printed : null;
  }

  /** Safe same-origin URL of a confined PDF reference, or null. */
  function pdfUrl(fileRef, page, zoom) {
    if (typeof fileRef !== "string" || !fileRef.toLowerCase().endsWith(".pdf")) return null;
    const ref = Rich.checkRef({ kind: "file", id: fileRef });
    if (!ref) return null;
    let url = "/files/" + ref.id.split("/").map(encodeURIComponent).join("/");
    const frag = [];
    if (Number.isInteger(page) && page >= 1 && page <= PAGE_MAX) frag.push("page=" + page);
    if (Number.isInteger(zoom) && zoom >= 10 && zoom <= 800) frag.push("zoom=" + zoom);
    if (frag.length) url += "#" + frag.join("&");
    return url;
  }

  function byId(sources, id) {
    for (const e of sources.editions) if (e.id === id) return e;
    return null;
  }

  function familyOf(sources, ed) {
    for (const f of sources.families) if (f.id === ed.family_id) return f;
    return null;
  }

  /** The newest edition a citation's edition was superseded by (follows the chain, cycle-safe). */
  function newestEdition(sources, ed) {
    let cur = ed;
    const seen = new Set();
    while (cur && cur.superseded_by && !seen.has(cur.id)) {
      seen.add(cur.id);
      const next = byId(sources, cur.superseded_by);
      if (!next) break;
      cur = next;
    }
    return cur && cur.id !== ed.id ? cur : null;
  }

  function haystack(sources, ed) {
    const fam = familyOf(sources, ed);
    return fold([ed.title, ed.author, ed.edition, ed.publisher, ed.identifier, ed.year || "", TYPE_LABEL[ed.type] || ed.type, fam ? fam.name : ""].join(" "));
  }

  /**
   * Fast picker ordering: recent (most recent first), then project-preferred, then the rest; with a query,
   * the matching ones in that same order. Bounded, deterministic, archived hidden unless asked.
   * Returns [{edition, group}] where group is "recent" | "project" | "all".
   */
  function pickerList(sources, o) {
    const opts = o || {};
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    const tokens = fold(opts.query).split(" ").filter(Boolean);
    const pool = sources.editions.filter((e) => {
      if (e.archived && !opts.archived) return false;
      const fam = familyOf(sources, e);
      if (fam && fam.archived && !opts.archived) return false;
      if (!tokens.length) return true;
      const hay = haystack(sources, e);
      return tokens.every((t) => hay.indexOf(t) >= 0);
    });
    const used = new Set();
    const out = [];
    const take = (list, group) => {
      for (const e of list) {
        if (used.has(e.id)) continue;
        used.add(e.id);
        out.push({ edition: e, group });
      }
    };
    const rank = (a, b) => (a.superseded_by ? 1 : 0) - (b.superseded_by ? 1 : 0) || fold(a.title).localeCompare(fold(b.title)) || fold(b.edition).localeCompare(fold(a.edition), undefined, { numeric: true });
    const poolById = new Map(pool.map((e) => [e.id, e]));
    take(recent.map((id) => poolById.get(id)).filter(Boolean), "recent");
    take(pool.filter((e) => opts.projectId && Array.isArray(e.project_ids) && e.project_ids.indexOf(opts.projectId) >= 0).sort(rank), "project");
    take(pool.slice().sort(rank), "all");
    return out.slice(0, RESULTS_MAX);
  }

  function pushRecent(list, id) {
    const out = [id].concat((Array.isArray(list) ? list : []).filter((x) => x !== id));
    return out.slice(0, RECENT_MAX);
  }

  /**
   * Citation for the NEWER edition after supersession. The old locator and PDF page are NEVER carried over
   * (page numbers differ between editions): mode "verified" needs a locator the user typed for the new
   * edition; mode "todo" leaves the location empty ("à vérifier"). `from` keeps the old edition, locator,
   * PDF page and verified flag so the old citation stays reconstructible.
   */
  function migrateCite(oldCite, newEd, mode, loc, pdf) {
    const from = { src: oldCite.src, loc: { kind: oldCite.loc.kind, text: oldCite.loc.text }, pdf: oldCite.pdf, ok: oldCite.ok };
    if (mode === "todo") return buildCite(newEd, { kind: oldCite.loc.kind, text: "" }, null, false, from);
    if (!loc || !String(loc.text || "").trim()) return null;
    return buildCite(newEd, loc, pdf == null ? null : pdf, true, from);
  }

  /** Same citation with the location explicitly (un)verified. Needs something to have verified. */
  function withVerified(cite, ok) {
    return Rich.checkCite(Object.assign({}, cite, { ok: !!ok }));
  }

  /** Short human description of a citation for the source view. */
  function describeCite(cite, ed) {
    const parts = [cite.snap.title + (cite.snap.edition ? " (" + cite.snap.edition + ")" : "")];
    parts.push(cite.loc.text ? (KIND_LABEL[cite.loc.kind] || "") + " " + cite.loc.text : "emplacement à vérifier");
    const pdf = resolvePdf(ed || null, cite.loc, cite.pdf);
    if (pdf != null) parts.push("page PDF " + pdf + (cite.pdf == null ? " (calibrage)" : ""));
    return parts.join(" · ");
  }

  // ------------------------------------------------------------------ UI

  function mount(host) {
    const doc = host.doc;
    const state = { sources: null, view: null, page: null, zoom: 100, cite: null, edition: null, recent: [], busy: false, origin: null };
    let layer = null;

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
      for (const c of children || []) if (c) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
      return n;
    }

    const btn = (id, text, extra) => el("button", Object.assign({ type: "button", id, class: "carnet-small", text }, extra || {}));
    const input = (id, label, extra) => el("input", Object.assign({ type: "text", id, class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": label, placeholder: label }, extra || {}));
    const label = (text, child) => el("label", { class: "carnet-src-field" }, [el("span", { class: "carnet-src-lbl", text }), child]);

    // ---- storage of "recent" (per user, per device; never required)
    function recentKey() {
      return RECENT_PREFIX + (host.user() || "");
    }

    function loadRecent() {
      try {
        const raw = host.storage().getItem(recentKey());
        const arr = raw ? JSON.parse(raw) : [];
        state.recent = Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
      } catch (_) {
        state.recent = [];
      }
    }

    function touchRecent(id) {
      state.recent = pushRecent(state.recent, id);
      try {
        host.storage().setItem(recentKey(), JSON.stringify(state.recent));
      } catch (_) {
        /* "recent" is a convenience: never an error */
      }
    }

    // ---- data
    async function refresh() {
      const data = await host.api.get("/api/carnet?sources=1");
      if (!data || !Array.isArray(data.editions) || !Array.isArray(data.families)) throw new Error("Réponse inattendue");
      state.sources = data;
      return data;
    }

    async function mutate(payload) {
      state.busy = true;
      try {
        let res;
        try {
          res = await host.api.post(payload);
        } catch (err) {
          if (err && err.status === 409) {
            try {
              await refresh(); // a conflict means the list is stale: show the newer record
            } catch (_) {
              /* the message below still tells the user to retry */
            }
          }
          throw err;
        }
        await refresh();
        return res;
      } finally {
        state.busy = false;
      }
    }

    function errText(err) {
      if (err && err.status === 409) return "Modifié ailleurs — la liste a été rechargée, recommence.";
      return err && err.message ? String(err.message).slice(0, 200) : (global && global.HqCarnetErrors ? global.HqCarnetErrors.message(err, 200) : "Échec inattendu : rien n'est confirmé.");
    }

    // ---- shell
    function ensureLayer() {
      if (layer) return layer;
      layer = el("div", { id: "hq-carnet-sources-layer", class: "carnet-src-layer", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-carnet-sources-title", hidden: true });
      host.root.appendChild(layer);
      return layer;
    }

    let modal = null; // handle of the shared modal utility while the dialog is open (the layer node itself is kept, only hidden)

    function show(view, title, nodes) {
      const l = ensureLayer();
      const active = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      const opener = modal ? null : state.pendingTrigger && state.pendingTrigger.isConnected ? state.pendingTrigger : active; // exact opener, captured on first open only
      if (!modal) state.pendingTrigger = null;
      state.view = view;
      l.textContent = "";
      l.setAttribute("data-view", view);
      const head = el("div", { class: "carnet-src-head" }, [
        el("h2", { class: "carnet-src-title", id: "hq-carnet-sources-title", text: title }),
        btn("btn-carnet-src-close", view === "view" ? "Retour à la note" : "Fermer", { "aria-label": view === "view" ? "Retour à la note" : "Fermer" }),
      ]);
      head.lastChild.addEventListener("click", () => close(true));
      l.appendChild(head);
      for (const n of nodes) l.appendChild(n);
      l.hidden = false;
      if (host.onOpen) host.onOpen();
      if (M) {
        if (!modal) modal = M.open(doc, l, { layer: "sources", trigger: opener, keep: true, onEscape: () => close(true) });
        else modal.focus(); // a view switch inside the open dialog: focus moves into the new content, never stays on a removed node
      }
    }

    function close(refocus) {
      let restored = false;
      if (layer) layer.hidden = true;
      if (modal) {
        const m = modal;
        modal = null;
        restored = m.close(!!refocus); // true only when the exact opener took focus
      }
      if (layer) layer.textContent = "";
      state.view = null;
      if (host.onClose) host.onClose(!!refocus && !restored);
    }

    function msgBox() {
      return el("p", { class: "carnet-msg carnet-src-msg", role: "alert" });
    }

    /**
     * A citation action (verify / edit / migrate) only ever applies to the page the citation was opened on and
     * only while the citation at the stored range is still the same one. Anything else aborts and touches nothing.
     * Returns the fresh selection/lines, or null after closing the overlay.
     */
    function bound(hit) {
      const cur = host.editor.entry();
      if (!cur || !hit || cur.id !== hit.pageId) {
        host.flash("La page a changé — action annulée");
        close(false);
        return null;
      }
      const sel = host.editor.sel();
      const at = Rich.citationAt(sel.lines, hit.start);
      if (!at || at.start !== hit.start || at.end !== hit.end || Rich.citeKey(at.mark.cite) !== Rich.citeKey(hit.cite)) {
        host.flash("La référence a changé — action annulée");
        close(false);
        return null;
      }
      return sel;
    }

    // ---- picker ("Référence")
    async function openPicker(edit) {
      const entry = host.editor.entry();
      if (!entry) {
        host.flash("Page en lecture seule");
        return;
      }
      if (edit && !bound(edit)) return;
      state.origin = { id: edit ? edit.pageId : entry.id, sel: edit ? { start: edit.start, end: edit.end } : null, edit: edit || null };
      loadRecent();
      const q = input("hq-carnet-src-q", "Rechercher une source", { type: "search", enterkeyhint: "search" });
      const list = el("div", { id: "hq-carnet-src-list", class: "carnet-src-list", role: "list" });
      const msg = msgBox();
      const showArchived = el("input", { type: "checkbox", id: "hq-carnet-src-archived" });
      const tools = el("div", { class: "carnet-panel-row" }, [
        btn("btn-carnet-src-manage", "Gérer les sources"),
        el("label", { class: "carnet-src-inline" }, [showArchived, " Archivées"]),
      ]);
      tools.firstChild.addEventListener("click", () => openManage());
      show("picker", edit ? "Modifier la référence" : "Référence", [q, tools, msg, list]);
      const render = () => {
        list.textContent = "";
        if (!state.sources) return;
        const items = pickerList(state.sources, { query: q.value, recent: state.recent, projectId: host.editor.projectId(), archived: showArchived.checked });
        if (!items.length) {
          list.appendChild(el("p", { class: "hint", text: state.sources.editions.length ? "Aucune source ne correspond." : "Aucune source. Crée-en une avec « Gérer les sources »." }));
          return;
        }
        let group = "";
        const titles = { recent: "Récentes", project: "Préférées pour ce projet", all: "Toutes les sources" };
        for (const it of items) {
          if (it.group !== group) {
            group = it.group;
            list.appendChild(el("h3", { class: "carnet-src-group", text: titles[group] }));
          }
          const e = it.edition;
          const b = el("button", { type: "button", class: "carnet-src-item", role: "listitem", "data-edition": e.id }, [
            el("span", { class: "carnet-src-item-title", text: editionTitle(e) }),
            el("span", { class: "carnet-src-item-sub", text: [TYPE_LABEL[e.type] || e.type, e.author, e.year || "", e.superseded_by ? "remplacée" : "", e.archived ? "archivée" : ""].filter(Boolean).join(" · ") }),
          ]);
          list.appendChild(b);
        }
      };
      q.addEventListener("input", render);
      showArchived.addEventListener("change", render);
      list.addEventListener("click", (ev) => {
        const b = ev.target && ev.target.closest ? ev.target.closest("[data-edition]") : null;
        const ed = b && state.sources ? byId(state.sources, b.getAttribute("data-edition")) : null;
        if (ed) openLocator(ed);
      });
      try {
        await refresh();
        render();
        q.focus({ preventScroll: true });
      } catch (err) {
        msg.textContent = "Sources indisponibles : " + errText(err);
      }
    }

    // ---- locator form (insert / edit a citation)
    function openLocator(ed, preset) {
      const edit = state.origin && state.origin.edit;
      const base = preset || (edit ? edit.cite : null);
      const kind = el("select", { id: "hq-carnet-cite-kind", class: "carnet-input", "aria-label": "Type d'emplacement" }, Rich.LOCATOR_KINDS.map((k) => el("option", { value: k, text: KIND_LABEL[k] })));
      kind.value = base && base.src === ed.id ? base.loc.kind : "page";
      const text = input("hq-carnet-cite-text", "Emplacement (p. imprimée, §, article…)", { maxlength: String(Rich.LOCATOR_TEXT_MAX) });
      text.value = base && base.src === ed.id ? base.loc.text : "";
      const pdf = input("hq-carnet-cite-pdf", "Page PDF (facultatif)", { inputmode: "numeric", maxlength: "6" });
      pdf.value = base && base.src === ed.id && base.pdf != null ? String(base.pdf) : "";
      const hint = el("p", { class: "hint carnet-src-hint", id: "hq-carnet-cite-hint" });
      const ok = el("input", { type: "checkbox", id: "hq-carnet-cite-ok" });
      ok.checked = !!(base && base.src === ed.id && base.ok);
      const msg = msgBox();
      const upd = () => {
        const loc = { kind: kind.value, text: text.value };
        const sug = resolvePdf(ed, loc, null);
        pdf.placeholder = sug != null && !pdf.value ? "Page PDF (calibrage : " + sug + ")" : "Page PDF (facultatif)";
        hint.textContent = ed.calibration
          ? "Calibrage : page imprimée " + ed.calibration.printed + " = page PDF " + ed.calibration.pdf + (sug != null ? " → PDF " + sug : "")
          : "Aucun calibrage : la page imprimée n'est jamais supposée égale à la page PDF.";
      };
      kind.addEventListener("change", upd);
      text.addEventListener("input", upd);
      const go = btn("btn-carnet-cite-insert", edit ? "Enregistrer" : "Insérer");
      const back = btn("btn-carnet-cite-back", "Changer de source");
      const view = btn("btn-carnet-cite-view", "Ouvrir le PDF", { disabled: !ed.file_ref || ed.file_state !== "ok" });
      show("locator", editionTitle(ed), [
        el("p", { class: "hint", text: [TYPE_LABEL[ed.type], ed.author, ed.year || ""].filter(Boolean).join(" · ") }),
        label("Type d'emplacement", kind), label("Emplacement", text), label("Page PDF", pdf), hint,
        el("label", { class: "carnet-src-inline" }, [ok, " Emplacement vérifié (je l'ai contrôlé dans la source)"]),
        el("div", { class: "carnet-panel-row" }, [go, view, back]), msg,
      ]);
      upd();
      back.addEventListener("click", () => openPicker(edit || null));
      view.addEventListener("click", () => {
        const loc = { kind: kind.value, text: text.value };
        openView(ed, resolvePdf(ed, loc, toPdf(pdf.value)) || 1, null);
      });
      go.addEventListener("click", () => {
        const loc = { kind: kind.value, text: text.value };
        const n = toPdf(pdf.value);
        if (n === undefined) {
          msg.textContent = "Page PDF invalide.";
          return;
        }
        const pdfPage = n != null ? n : resolvePdf(ed, loc, null);
        if (ok.checked && !String(loc.text).trim() && pdfPage == null) {
          msg.textContent = "Saisis un emplacement ou une page PDF pour le marquer vérifié.";
          return;
        }
        const from = edit && edit.cite.src !== ed.id ? { src: edit.cite.src, loc: edit.cite.loc, pdf: edit.cite.pdf, ok: edit.cite.ok } : edit ? edit.cite.from : null;
        const cite = buildCite(ed, loc, pdfPage, ok.checked, from);
        if (!cite) {
          msg.textContent = "Emplacement invalide.";
          return;
        }
        insert(cite);
      });
      text.focus({ preventScroll: true });
    }

    function toPdf(raw) {
      const s = String(raw).trim();
      if (!s) return null;
      if (!/^[0-9]{1,6}$/.test(s)) return undefined;
      const n = Number(s);
      return n >= 1 && n <= PAGE_MAX ? n : undefined;
    }

    /** Commit a citation into the note the picker was opened for (same state machine path as typing). */
    function insert(cite, range) {
      const cur = host.editor.entry();
      const origin = state.origin;
      if (!cur || !origin || cur.id !== origin.id) {
        host.flash("La page a changé — référence non insérée");
        return false;
      }
      const sel = host.editor.sel();
      const r = range || origin.sel || { start: sel.start, end: sel.end };
      const total = Rich.flat(sel.lines).length;
      const res = Rich.insertCitation(sel.lines, Math.min(r.start, total), Math.min(r.end, total), cite);
      if (!res) {
        host.flash("Référence impossible ici");
        return false;
      }
      if (!host.editor.commit(res.lines, { start: res.caret, end: res.caret })) return false;
      touchRecent(cite.src);
      close(true);
      return true;
    }

    // ---- source view (a citation, or a PDF opened from the picker)
    function openCitation(hit) {
      hit.pageId = (host.editor.current() || {}).id || null; // every later action is bound to THIS page
      state.pendingTrigger = hit.trigger || null; // the citation element the person used (the editor takes focus while the dialog loads)
      state.origin = { id: hit.pageId, sel: null, edit: hit.readonly ? null : hit };
      loadRecent();
      refresh().then(
        () => {
          const ed = byId(state.sources, hit.cite.src);
          renderCitation(hit, ed);
        },
        (err) => renderCitation(hit, null, errText(err)),
      );
    }

    const pdfPage = (ed, cite) => resolvePdf(ed, cite.loc, cite.pdf);

    function renderCitation(hit, ed, problem) {
      const cite = hit.cite;
      const writable = !!host.editor.entry() && !hit.readonly;
      const nodes = [el("p", { class: "carnet-src-cite", id: "hq-carnet-src-desc", text: describeCite(cite, ed) })];
      const msg = msgBox();
      if (problem) msg.textContent = "Source indisponible : " + problem;
      else if (!ed) msg.textContent = "Source introuvable (supprimée ou archivée ailleurs). La citation reste lisible.";
      nodes.push(msg);
      if (cite.ok) nodes.push(el("p", { class: "carnet-src-verified", id: "hq-carnet-src-verified", text: "✓ Emplacement vérifié (l'emplacement seulement, pas le contenu)" }));
      else nodes.push(el("p", { class: "hint", id: "hq-carnet-src-unverified", text: "Emplacement non vérifié" }));
      if (cite.from) {
        const old = state.sources ? byId(state.sources, cite.from.src) : null;
        nodes.push(el("p", { class: "hint", id: "hq-carnet-src-from", text: "Migrée depuis " + (old ? editionTitle(old) : "une édition précédente") + " — " + (cite.from.loc.text ? (KIND_LABEL[cite.from.loc.kind] || "") + " " + cite.from.loc.text : "sans emplacement") + (cite.from.pdf ? ", PDF " + cite.from.pdf : "") + (cite.from.ok ? " (vérifié)" : "") }));
      }
      const row = el("div", { class: "carnet-panel-row" });
      // Reader = inspection only. It opens ABOVE this dialog (never nested in it) and returns focus to the exact button used here.
      const readerOpen = (b) => {
        if (typeof host.openReader !== "function") return;
        host.openReader({ sourceId: cite.src, citation: cite, origin: hit.origin || null, trigger: b });
      };
      if (typeof host.openReader === "function") {
        const rb = btn("btn-carnet-src-reader", "Lire la preuve");
        rb.addEventListener("click", () => readerOpen(rb));
        row.appendChild(rb);
      }
      if (ed && ed.file_ref && ed.file_state === "ok") {
        // Phase 13: with the Reader available, "Lire la preuve" IS the way to see the PDF (the old "Voir le PDF" opened the very same Reader: a duplicate entry).
        if (typeof host.openReader !== "function") {
          const b = btn("btn-carnet-src-open", "Ouvrir le PDF");
          b.addEventListener("click", () => openView(ed, pdfPage(ed, cite) || 1, hit));
          row.appendChild(b);
        }
        // Management stays here: the in-dialog viewer is where "Citer cette page" lives (the Reader only inspects).
        const vb = btn("btn-carnet-src-view", "Citer depuis le PDF");
        vb.addEventListener("click", () => openView(ed, pdfPage(ed, cite) || 1, hit));
        row.appendChild(vb);
      } else if (ed && ed.file_ref) {
        nodes.push(el("p", { class: "hint", text: ed.file_state === "unsafe" ? "Le PDF lié n'est pas utilisable." : "Le PDF lié est introuvable sur ce PC." }));
      } else if (ed) nodes.push(el("p", { class: "hint", text: "Aucun PDF lié à cette édition." }));
      if (ed && ed.url) {
        const safe = Rich.safeHref(ed.url);
        if (safe) {
          const a = el("a", { id: "btn-carnet-src-url", class: "carnet-small", href: safe, target: "_blank", rel: "noopener noreferrer", text: "Ouvrir le lien" });
          row.appendChild(a);
        }
      }
      if (writable && ed) {
        const edit = btn("btn-carnet-src-edit", "Modifier l'emplacement");
        edit.addEventListener("click", () => {
          if (!bound(hit)) return;
          state.origin = { id: hit.pageId, sel: { start: hit.start, end: hit.end }, edit: hit };
          openLocator(ed, cite);
        });
        row.appendChild(edit);
        const ver = btn("btn-carnet-src-verify", cite.ok ? "Retirer « vérifié »" : "Marquer l'emplacement vérifié");
        ver.addEventListener("click", () => {
          const next = withVerified(cite, !cite.ok);
          if (!next) {
            msg.textContent = "Saisis d'abord un emplacement ou une page PDF.";
            return;
          }
          const sel = bound(hit);
          if (!sel) return;
          const res = Rich.setCitationPayload(sel.lines, hit.start, next);
          if (!res || !host.editor.commit(res, { start: sel.start, end: sel.end })) {
            msg.textContent = "Modification impossible.";
            return;
          }
          hit.cite = next;
          renderCitation(hit, ed);
        });
        row.appendChild(ver);
      }
      nodes.push(row);
      const newer = ed && state.sources ? newestEdition(state.sources, ed) : null;
      if (newer) nodes.push(migrationBox(hit, ed, newer, writable));
      show("citation", "Référence", nodes);
    }

    /** Supersession: the old citation stays correct; nothing is carried over automatically. */
    function migrationBox(hit, ed, newer, writable) {
      const box = el("div", { class: "carnet-src-migrate", id: "hq-carnet-src-migrate" }, [
        el("p", { class: "carnet-src-warn", text: "Une édition plus récente existe : " + editionTitle(newer) + ". Les numéros de page changent d'une édition à l'autre : rien n'est repris automatiquement." }),
      ]);
      if (!writable) return box;
      const kind = el("select", { id: "hq-carnet-mig-kind", class: "carnet-input", "aria-label": "Type d'emplacement" }, Rich.LOCATOR_KINDS.map((k) => el("option", { value: k, text: KIND_LABEL[k] })));
      kind.value = hit.cite.loc.kind;
      const text = input("hq-carnet-mig-text", "Emplacement dans la nouvelle édition");
      const pdf = input("hq-carnet-mig-pdf", "Page PDF (facultatif)", { inputmode: "numeric" });
      const msg = msgBox();
      const keep = btn("btn-carnet-mig-keep", "Garder l'ancienne édition");
      const todo = btn("btn-carnet-mig-todo", "Nouvelle édition — à vérifier");
      const verified = btn("btn-carnet-mig-verified", "Nouvelle édition — emplacement vérifié");
      keep.addEventListener("click", () => close(true));
      const apply = (mode) => {
        const n = toPdf(pdf.value);
        if (n === undefined) {
          msg.textContent = "Page PDF invalide.";
          return;
        }
        const cite = migrateCite(hit.cite, newer, mode, { kind: kind.value, text: text.value }, n);
        if (!cite) {
          msg.textContent = "Saisis l'emplacement dans la nouvelle édition pour le marquer vérifié.";
          return;
        }
        if (!bound(hit)) return;
        state.origin = { id: hit.pageId, sel: null, edit: hit };
        insert(cite, { start: hit.start, end: hit.end });
      };
      todo.addEventListener("click", () => apply("todo"));
      verified.addEventListener("click", () => apply("verified"));
      for (const n of [label("Type d'emplacement", kind), label("Emplacement", text), label("Page PDF", pdf), el("div", { class: "carnet-panel-row" }, [keep, todo, verified]), msg]) box.appendChild(n);
      return box;
    }

    function openView(ed, page, hit) {
      state.edition = ed;
      state.page = Math.max(1, page || 1);
      state.zoom = 100;
      state.cite = hit;
      renderView();
    }

    function renderView() {
      const ed = state.edition;
      const url = pdfUrl(ed.file_ref, state.page, state.zoom);
      const frame = url ? el("iframe", { id: "hq-carnet-src-frame", class: "carnet-src-frame", title: "PDF : " + ed.title, src: url, referrerpolicy: "no-referrer" }) : el("p", { class: "hint", text: "PDF indisponible." });
      const pageIn = input("hq-carnet-src-page", "Page PDF", { inputmode: "numeric", maxlength: "6" });
      pageIn.value = String(state.page);
      const printed = printedFor(ed, state.page);
      const info = el("p", { class: "hint carnet-src-hint", id: "hq-carnet-src-info", text: "Page PDF " + state.page + (printed != null ? " · page imprimée " + printed : " · page imprimée inconnue (aucun calibrage)") + ` · zoom ${state.zoom} %` });
      const warn = el("p", { class: "hint carnet-src-hint", id: "hq-carnet-src-warn", text: "Le lecteur PDF du navigateur peut ignorer la page demandée (surtout sur iPhone/iPad) : vérifie la page affichée." });
      const go = (p) => {
        const n = Math.max(1, Math.min(PAGE_MAX, p));
        state.page = n;
        renderView();
      };
      const prev = btn("btn-carnet-src-prev", "◀ Page précédente");
      const next = btn("btn-carnet-src-next", "Page suivante ▶");
      const apply = btn("btn-carnet-src-goto", "Aller");
      const zin = btn("btn-carnet-src-zoom-in", "Zoom +");
      const zout = btn("btn-carnet-src-zoom-out", "Zoom −");
      prev.addEventListener("click", () => go(state.page - 1));
      next.addEventListener("click", () => go(state.page + 1));
      apply.addEventListener("click", () => {
        const n = toPdf(pageIn.value);
        if (n) go(n);
      });
      pageIn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          apply.click();
        }
      });
      const zoom = (d) => {
        const i = ZOOMS.indexOf(state.zoom);
        state.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 2 : i) + d))];
        renderView();
      };
      zin.addEventListener("click", () => zoom(1));
      zout.addEventListener("click", () => zoom(-1));
      const cite = btn("btn-carnet-src-cite-page", "Citer cette page", { disabled: !host.editor.entry() });
      cite.addEventListener("click", () => {
        const pr = printedFor(ed, state.page);
        const c = buildCite(ed, { kind: "page", text: pr != null ? String(pr) : "" }, state.page, false, null); // never auto-verified
        if (!c) return;
        const pageId = state.cite ? state.cite.pageId : state.origin ? state.origin.id : null; // never "whatever page is current now"
        state.origin = { id: pageId, sel: null, edit: null };
        insert(c);
      });
      const tab = url ? el("a", { id: "btn-carnet-src-tab", class: "carnet-small", href: url, target: "_blank", rel: "noopener", text: "Ouvrir le PDF dans un onglet" }) : null;
      show("view", editionTitle(ed), [
        el("div", { class: "carnet-panel-row carnet-src-bar" }, [prev, pageIn, apply, next, zout, zin]),
        info, warn,
        el("div", { class: "carnet-panel-row" }, [cite, tab]),
        frame,
      ]);
    }

    // ---- manager
    async function openManage() {
      const msg = msgBox();
      const body = el("div", { id: "hq-carnet-src-manage", class: "carnet-src-manage" });
      show("manage", "Sources", [msg, body]);
      try {
        await refresh();
      } catch (err) {
        msg.textContent = "Sources indisponibles : " + errText(err);
        return;
      }
      renderManage(body, msg);
    }

    function renderManage(body, msg) {
      body.textContent = "";
      const s = state.sources;
      const name = input("hq-carnet-fam-name", "Nouvelle famille (ex. Shigley)", { maxlength: "120" });
      const create = btn("btn-carnet-fam-create", "Créer");
      create.addEventListener("click", async () => {
        try {
          msg.textContent = "";
          await mutate({ action: "source_family_create", name: name.value });
          renderManage(body, msg);
        } catch (err) {
          msg.textContent = errText(err);
          if (err && err.status === 409) renderManage(body, msg);
        }
      });
      body.appendChild(el("div", { class: "carnet-panel-row" }, [name, create]));
      if (!s.families.length) body.appendChild(el("p", { class: "hint", text: "Aucune source. Crée une famille (un ouvrage), puis ses éditions." }));
      for (const fam of s.families) {
        const sec = el("section", { class: "carnet-src-family", "data-family": fam.id }, [
          el("h3", { class: "carnet-src-fam-name", text: fam.name + (fam.archived ? " (archivée)" : "") }),
        ]);
        const row = el("div", { class: "carnet-panel-row" });
        const add = btn("btn-carnet-ed-add-" + fam.id, "Ajouter une édition");
        add.addEventListener("click", () => editionForm(body, msg, fam, null));
        const arch = btn("btn-carnet-fam-arch-" + fam.id, fam.archived ? "Restaurer" : "Archiver");
        arch.addEventListener("click", async () => {
          try {
            await mutate({ action: "source_family_archive", id: fam.id, expected_rev: fam.rev, archived: !fam.archived });
            renderManage(body, msg);
          } catch (err) {
            msg.textContent = errText(err);
            if (err && err.status === 409) renderManage(body, msg);
          }
        });
        row.appendChild(add);
        row.appendChild(arch);
        sec.appendChild(row);
        for (const ed of s.editions.filter((e) => e.family_id === fam.id)) {
          const b = el("button", { type: "button", class: "carnet-src-item", "data-edition": ed.id }, [
            el("span", { class: "carnet-src-item-title", text: editionTitle(ed) }),
            el("span", { class: "carnet-src-item-sub", text: [TYPE_LABEL[ed.type], ed.year || "", ed.file_ref ? (ed.file_state === "ok" ? "PDF lié" : "PDF introuvable") : "", ed.superseded_by ? "remplacée" : "", ed.archived ? "archivée" : ""].filter(Boolean).join(" · ") }),
          ]);
          b.addEventListener("click", () => editionForm(body, msg, fam, ed));
          sec.appendChild(b);
        }
        body.appendChild(sec);
      }
    }

    function editionForm(body, msg, fam, ed) {
      body.textContent = "";
      const f = {
        type: el("select", { id: "hq-carnet-ed-type", class: "carnet-input", "aria-label": "Type" }, TYPES.map((t) => el("option", { value: t, text: TYPE_LABEL[t] }))),
        title: input("hq-carnet-ed-title", "Titre", { maxlength: "200" }),
        author: input("hq-carnet-ed-author", "Auteur", { maxlength: "120" }),
        edition: input("hq-carnet-ed-edition", "Édition (ex. 12e)", { maxlength: "40" }),
        year: input("hq-carnet-ed-year", "Année", { inputmode: "numeric", maxlength: "4" }),
        publisher: input("hq-carnet-ed-publisher", "Éditeur", { maxlength: "120" }),
        identifier: input("hq-carnet-ed-ident", "Identifiant (ISBN, n° de norme…)", { maxlength: "60" }),
        url: input("hq-carnet-ed-url", "Lien web (http/https)", { inputmode: "url" }),
        file_ref: input("hq-carnet-ed-file", "PDF local (ex. Uni/Shigley/12e.pdf)"),
        notes: el("textarea", { id: "hq-carnet-ed-notes", class: "carnet-input", rows: "2", maxlength: "2000", "aria-label": "Notes", placeholder: "Notes" }),
      };
      f.type.value = ed ? ed.type : "book";
      f.title.value = ed ? ed.title : fam.name;
      f.author.value = ed ? ed.author : "";
      f.edition.value = ed ? ed.edition : "";
      f.year.value = ed && ed.year ? String(ed.year) : "";
      if (ed) {
        f.edition.readOnly = true; // an edition's label and year are identity: a new edition is a new record
        f.year.readOnly = true;
      }
      f.publisher.value = ed ? ed.publisher : "";
      f.identifier.value = ed ? ed.identifier : "";
      f.url.value = ed ? ed.url : "";
      f.file_ref.value = ed ? ed.file_ref : "";
      f.notes.value = ed ? ed.notes : "";
      const pid = host.editor.projectId();
      const pref = el("input", { type: "checkbox", id: "hq-carnet-ed-pref" });
      pref.checked = !!(ed && pid && ed.project_ids.indexOf(pid) >= 0);
      const fields = [label("Type", f.type), label("Titre", f.title), label("Auteur", f.author), label("Édition", f.edition), label("Année", f.year), label("Éditeur", f.publisher), label("Identifiant", f.identifier), label("Lien web", f.url), label("PDF local", f.file_ref), label("Notes", f.notes)];
      const save = btn("btn-carnet-ed-save", "Enregistrer");
      const cancel = btn("btn-carnet-ed-cancel", "Annuler");
      cancel.addEventListener("click", () => renderManage(body, msg));
      save.addEventListener("click", async () => {
        const payload = { type: f.type.value, title: f.title.value, author: f.author.value, publisher: f.publisher.value, identifier: f.identifier.value, url: f.url.value, file_ref: f.file_ref.value.trim(), notes: f.notes.value };
        if (pid) {
          const ids = (ed ? ed.project_ids : []).filter((x) => x !== pid);
          if (pref.checked) ids.push(pid);
          payload.project_ids = ids;
        }
        try {
          msg.textContent = "";
          if (ed) await mutate(Object.assign({ action: "source_edition_update", id: ed.id, expected_rev: ed.rev }, payload));
          else {
            const yr = f.year.value.trim();
            if (yr && !/^[0-9]{4}$/.test(yr)) {
              msg.textContent = "Année invalide.";
              return;
            }
            await mutate(Object.assign({ action: "source_edition_create", family_id: fam.id, edition: f.edition.value, year: yr ? Number(yr) : null }, payload));
          }
          renderManage(body, msg);
        } catch (err) {
          msg.textContent = errText(err);
          if (err && err.status === 409) renderManage(body, msg);
        }
      });
      body.appendChild(el("h3", { class: "carnet-src-fam-name", text: (ed ? "Modifier : " : "Nouvelle édition : ") + fam.name }));
      for (const n of fields) body.appendChild(n);
      if (pid) body.appendChild(el("label", { class: "carnet-src-inline" }, [pref, " Préférée pour le projet de cette page"]));
      body.appendChild(el("div", { class: "carnet-panel-row" }, [save, cancel]));
      if (ed) editionExtras(body, msg, fam, ed);
    }

    function editionExtras(body, msg, fam, ed) {
      const s = state.sources;
      const again = async (fn) => {
        try {
          msg.textContent = "";
          await fn();
          renderManage(body, msg);
        } catch (err) {
          msg.textContent = errText(err);
          if (err && err.status === 409) renderManage(body, msg);
        }
      };
      const arch = btn("btn-carnet-ed-archive", ed.archived ? "Restaurer l'édition" : "Archiver l'édition");
      arch.addEventListener("click", () => again(() => mutate({ action: "source_edition_archive", id: ed.id, expected_rev: ed.rev, archived: !ed.archived })));
      const newer = s.editions.filter((e) => e.family_id === ed.family_id && e.id !== ed.id && !e.archived);
      const sel = el("select", { id: "hq-carnet-ed-newer", class: "carnet-input", "aria-label": "Remplacée par" }, [el("option", { value: "", text: "— non remplacée —" })].concat(newer.map((e) => el("option", { value: e.id, text: editionTitle(e) }))));
      sel.value = ed.superseded_by || "";
      const sup = btn("btn-carnet-ed-supersede", "Enregistrer le remplacement");
      sup.addEventListener("click", () => again(() => mutate({ action: "source_edition_supersede", id: ed.id, expected_rev: ed.rev, newer_id: sel.value || null })));
      const cp = input("hq-carnet-cal-printed", "Page imprimée", { inputmode: "numeric", maxlength: "6" });
      const cq = input("hq-carnet-cal-pdf", "= page PDF", { inputmode: "numeric", maxlength: "6" });
      if (ed.calibration) {
        cp.value = String(ed.calibration.printed);
        cq.value = String(ed.calibration.pdf);
      }
      const calSave = btn("btn-carnet-cal-save", "Enregistrer le calibrage");
      calSave.addEventListener("click", () => {
        const a = toPdf(cp.value);
        const b = toPdf(cq.value);
        if (!a || !b) {
          msg.textContent = "Calibrage : deux numéros de page valides.";
          return;
        }
        again(() => mutate({ action: "source_edition_calibrate", id: ed.id, expected_rev: ed.rev, calibration: { printed: a, pdf: b } }));
      });
      const calClear = btn("btn-carnet-cal-clear", "Retirer le calibrage", { disabled: !ed.calibration });
      calClear.addEventListener("click", () => again(() => mutate({ action: "source_edition_calibrate", id: ed.id, expected_rev: ed.rev, calibration: null })));
      body.appendChild(el("div", { class: "carnet-panel-row" }, [arch]));
      body.appendChild(el("div", { class: "carnet-panel-row" }, [sel, sup]));
      body.appendChild(el("p", { class: "hint", text: "Calibrage explicite : la page imprimée N est la page PDF M (jamais supposé)." }));
      body.appendChild(el("div", { class: "carnet-panel-row" }, [cp, cq]));
      body.appendChild(el("div", { class: "carnet-panel-row" }, [calSave, calClear]));
    }

    const isOpen = () => !!(layer && !layer.hidden);
    return { openPicker, openManage, openCitation, close, refresh, isOpen, state };
  }

  return {
    TYPES, TYPE_LABEL, KIND_LABEL, RECENT_MAX, RESULTS_MAX,
    fold, editionTitle, editionSnapshot, buildCite, resolvePdf, printedFor, pdfUrl, newestEdition, pickerList, pushRecent, migrateCite, withVerified, describeCite,
    mount,
  };
});
