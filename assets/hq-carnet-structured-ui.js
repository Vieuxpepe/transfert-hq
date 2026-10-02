/* Transfert HQ — Carnet Product Phase 2/3: editor UI of the structured blocks (table, callout, toggle, image group, drawing).
 *
 * Safe DOM only (createElement / textContent / setAttribute; no HTML-string sinks, no dynamic code). Every user action is
 * ONE logical edit through the host (the normal draft / revision / conflict path): a structural change (row, column, layout,
 * image) re-renders the block once, a keystroke in a field only updates the draft (no re-render, no per-pointermove write).
 * The payload lives in the editor's registry (hq-carnet-rich.js): the DOM only displays it. A wrapper that is no longer in the
 * editor, or a page that changed during an upload, makes the action fail closed with a message (never applied to newer state).
 *
 * Keyboard (table): Tab / Shift+Tab move between cells (and leave the table after the last / before the first cell);
 * Enter = same column, next row (a new row after the last one while under 20 rows; at the cap the caret stays and a limit message
 * is shown); Shift+Enter inserts nothing; Up / Down move by row; Left / Right at the edge of a cell move to the neighbour;
 * Escape leaves the grid. Ctrl/Cmd+C with no selected text copies the whole table as TSV. Pasting TSV fills a block from the
 * focused cell (the table grows within 20 x 10) or is rejected as a whole.
 *
 * Plain ES2020, UMD (browser global HqCarnetStructuredUi / CommonJS for the pure helpers).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetStructuredUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MSG = {
    readonly: "Page en lecture seule",
    stale: "Ce bloc a changé : action annulée",
    refused: "Modification refusée",
    rowsMax: "Limite de 20 lignes atteinte",
    colsMax: "Limite de 10 colonnes atteinte",
    rowMin: "Un tableau garde au moins une ligne",
    colMin: "Un tableau garde au moins une colonne",
    pasteBig: "Collage trop grand : 20 lignes × 10 colonnes, 200 caractères par cellule au maximum",
    pasteEmpty: "Rien à coller",
    cellBytes: "Tableau trop volumineux",
    copied: "Tableau copié (TSV)",
    copyFail: "Copie impossible",
    bodyLines: "Trop de lignes",
    groupMin: "Un groupe garde au moins deux images",
    groupMax: "Un groupe contient trois images au maximum",
    noMove: "Déplacement impossible",
    drawingGone: "Croquis indisponible",
    drawingRelinked: "Référence mise à jour",
    drawingNoList: "Aucun croquis enregistré",
    newVersion: "Nouvelle version enregistrée",
  };

  const KIND_LABEL = { note: "Note", info: "Info", warning: "Attention" };
  const KIND_GLYPH = { note: "✎", info: "ℹ", warning: "⚠" }; // derived from the kind, never stored
  const LAYOUT_LABEL = { two: "Deux images côte à côte", three: "Trois images", compare: "Avant / après" };
  const ASSET_URL = "/api/carnet/asset/";
  const DRAWING_FILE_URL = "/api/drawings/file?stem="; // the existing Dessiner preview route; a stem is immutable so a preview is never stale
  const ATTACH_EXT = { pdf: "PDF", doc: "DOC", docx: "DOC", xls: "XLS", xlsx: "XLS", csv: "CSV", txt: "TXT", md: "MD", zip: "ZIP", step: "CAO", stp: "CAO", stl: "STL", dxf: "DXF", dwg: "DWG", png: "IMG", jpg: "IMG", jpeg: "IMG", webp: "IMG", gif: "IMG", mp4: "VID", mov: "VID", mp3: "AUDIO" };

  /** Pure: type chip + safe display parts of a file ref id ("Inbox/Dir/file.pdf"). Never an absolute path: refs are root-relative by construction. */
  function attachmentParts(refId) {
    const parts = String(refId).split("/");
    const name = parts[parts.length - 1] || "";
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    return { name, dir: parts.slice(0, -1).join("/"), ext, chip: ATTACH_EXT[ext] || (ext ? ext.slice(0, 4).toUpperCase() : "FICHIER") };
  }

  function mount(host) {
    const doc = host.doc;
    const Rich = host.rich;
    const Struct = Rich.Struct;
    const S = { open: new Map(), focus: null, picker: null, offers: new Map() };

    function el(tag, attrs, text) {
      const n = doc.createElement(tag);
      for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
      if (text) n.textContent = text;
      return n;
    }

    function button(label, cls, onClick, extra) {
      const b = el("button", Object.assign({ type: "button", class: "carnet-small carnet-struct-btn " + (cls || ""), "aria-label": label }, extra || {}), label);
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        onClick(ev);
      });
      return b;
    }

    /** The island must not feed the text editor's own handlers (typing, paste, slash menu, clicks): it commits through the host. */
    function isolate(wrapper) {
      for (const t of ["beforeinput", "input", "change", "keydown", "keyup", "paste", "cut", "copy", "compositionstart", "compositionend", "click", "dblclick", "touchstart"]) {
        wrapper.addEventListener(t, (ev) => ev.stopPropagation());
      }
    }

    function editorRoot() {
      return host.editor();
    }

    /** The CURRENT payload of a wrapper, or null (and a message) when the block is no longer in the editor. */
    function current(wrapper) {
      const r = editorRoot();
      const p = r && r.contains(wrapper) ? Rich.getStructPayload(r, wrapper) : null;
      if (!p) host.flash(MSG.stale);
      return p;
    }

    function commit(wrapper, payload, opts) {
      if (host.readOnly()) {
        host.flash(MSG.readonly);
        return false;
      }
      const r = editorRoot();
      if (!r || !r.contains(wrapper) || !Rich.setStructPayload(r, wrapper, payload)) {
        host.flash(MSG.refused);
        return false;
      }
      return host.changed(wrapper, opts || { rerender: false });
    }

    function msgEl(box) {
      return box.querySelector(".carnet-struct-msg");
    }

    function say(box, text) {
      const m = msgEl(box);
      if (m) m.textContent = text || "";
      if (text) host.flash(text);
    }

    function lineIndex(wrapper) {
      return Array.prototype.indexOf.call(editorRoot().children, wrapper);
    }

    // ------------------------------------------------------------------ table

    function cellAt(wrapper, r, c) {
      return wrapper.querySelector('input[data-r="' + r + '"][data-c="' + c + '"]');
    }

    function focusCell(wrapper, r, c, select) {
      const inp = cellAt(wrapper, r, c);
      if (!inp) return false;
      inp.focus();
      if (select) inp.select();
      return true;
    }

    function buildTable(wrapper, p, idx, box) {
      const ro = host.readOnly();
      const pos = { r: 0, c: 0 };
      const scroll = el("div", { class: "carnet-table-scroll", tabindex: "0", role: "region", "aria-label": "Tableau, défilement horizontal" });
      const table = el("table", { class: "carnet-table", role: "grid", "aria-rowcount": String(p.rows.length), "aria-colcount": String(p.rows[0].length) });
      p.rows.forEach((row, r) => {
        const tr = el("tr", { role: "row", "aria-rowindex": String(r + 1) });
        row.forEach((val, c) => {
          const head = p.header && r === 0;
          const cell = el(head ? "th" : "td", head ? { scope: "col", role: "columnheader" } : { role: "gridcell" });
          const inp = el("input", {
            type: "text", class: "carnet-cell", "data-r": String(r), "data-c": String(c), maxlength: String(Struct.CELL_U16_MAX), autocomplete: "off", spellcheck: "false",
            "aria-label": (head ? "En-tête, colonne " : "Ligne " + (r + 1) + ", colonne ") + (c + 1),
          });
          inp.value = val;
          if (ro) inp.setAttribute("readonly", "");
          cell.appendChild(inp);
          tr.appendChild(cell);
        });
        table.appendChild(tr);
      });
      scroll.appendChild(table);
      box.appendChild(scroll);

      const rowsNow = () => {
        const cur = current(wrapper);
        return cur;
      };
      const apply = (rows, focus, header) => {
        const cur = current(wrapper);
        if (!cur) return false;
        S.focus = focus ? { idx, r: focus.r, c: focus.c } : null;
        return commit(wrapper, { header: header === undefined ? cur.header : header, rows }, { rerender: true });
      };

      wrapper.addEventListener("focusin", (ev) => {
        const t = ev.target;
        if (t && t.getAttribute && t.hasAttribute("data-r")) {
          pos.r = Number(t.getAttribute("data-r"));
          pos.c = Number(t.getAttribute("data-c"));
        }
      });

      table.addEventListener("input", (ev) => {
        const t = ev.target;
        if (!t || !t.hasAttribute || !t.hasAttribute("data-r") || host.readOnly()) return;
        const cur = rowsNow();
        if (!cur) return;
        const r = Number(t.getAttribute("data-r"));
        const c = Number(t.getAttribute("data-c"));
        const clean = Struct.cleanCell(t.value);
        if (clean !== t.value) t.value = clean;
        const rows = cur.rows.map((x) => x.slice());
        const old = rows[r][c];
        rows[r][c] = clean;
        if (!Struct.checkTable({ header: cur.header, rows })) {
          t.value = old;
          say(box, MSG.cellBytes);
          return;
        }
        commit(wrapper, { header: cur.header, rows }, { rerender: false });
      });

      table.addEventListener("keydown", (ev) => {
        const t = ev.target;
        if (!t || !t.hasAttribute || !t.hasAttribute("data-r")) return;
        const cur = rowsNow();
        if (!cur) return;
        const r = Number(t.getAttribute("data-r"));
        const c = Number(t.getAttribute("data-c"));
        const nr = cur.rows.length;
        const nc = cur.rows[0].length;
        const k = ev.key;
        if (k === "Tab") {
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
          const i = r * nc + c + (ev.shiftKey ? -1 : 1);
          if (i < 0 || i >= nr * nc) return; // leave the grid: Tab is never a trap
          ev.preventDefault();
          focusCell(wrapper, Math.floor(i / nc), i % nc, true);
        } else if (k === "Enter") {
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // no table meaning: unused
          ev.preventDefault();
          if (ev.shiftKey || ev.isComposing) return; // Shift+Enter: no newline, nothing
          if (r + 1 < nr) focusCell(wrapper, r + 1, c, true);
          else if (nr >= Struct.TABLE_ROWS_MAX) say(box, MSG.rowsMax); // stay in the cell: no wrap to row 1
          else {
            const rows = Struct.addRow(cur.rows, nr);
            if (rows) apply(rows, { r: nr, c });
          }
        } else if (k === "ArrowDown" || k === "ArrowUp") {
          if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
          const to = r + (k === "ArrowDown" ? 1 : -1);
          if (to >= 0 && to < nr) {
            ev.preventDefault();
            focusCell(wrapper, to, c, true);
          }
        } else if (k === "ArrowLeft" || k === "ArrowRight") {
          if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || t.selectionStart !== t.selectionEnd) return;
          const left = k === "ArrowLeft";
          if (left ? t.selectionStart === 0 && c > 0 : t.selectionStart === t.value.length && c + 1 < nc) {
            ev.preventDefault();
            focusCell(wrapper, r, c + (left ? -1 : 1), false);
          }
        } else if (k === "Escape") {
          ev.preventDefault();
          scroll.focus();
        }
      });

      table.addEventListener("copy", (ev) => {
        const t = ev.target;
        if (!t || !t.hasAttribute || !t.hasAttribute("data-r") || t.selectionStart !== t.selectionEnd) return; // a text selection copies natively
        const cur = rowsNow();
        if (!cur || !ev.clipboardData) return;
        ev.preventDefault();
        ev.clipboardData.setData("text/plain", Struct.formatTsv(cur.rows));
        say(box, MSG.copied);
      });

      table.addEventListener("paste", (ev) => {
        const t = ev.target;
        if (!t || !t.hasAttribute || !t.hasAttribute("data-r")) return;
        if (host.readOnly()) {
          ev.preventDefault();
          return;
        }
        const text = ev.clipboardData && ev.clipboardData.getData ? ev.clipboardData.getData("text/plain") : "";
        if (!text) {
          ev.preventDefault();
          say(box, MSG.pasteEmpty);
          return;
        }
        const cur = rowsNow();
        if (!cur) {
          ev.preventDefault();
          return;
        }
        const r = Number(t.getAttribute("data-r"));
        const c = Number(t.getAttribute("data-c"));
        if (!/[\t\r\n]/.test(text)) {
          // one value: native insertion unless it would overflow the cell (then it is rejected, never truncated)
          const start = t.selectionStart == null ? t.value.length : t.selectionStart;
          const end = t.selectionEnd == null ? start : t.selectionEnd;
          if ((t.value.slice(0, start) + Struct.cleanCell(text) + t.value.slice(end)).length > Struct.CELL_U16_MAX) {
            ev.preventDefault();
            say(box, MSG.pasteBig);
          }
          return;
        }
        ev.preventDefault();
        const parsed = Struct.parseTsv(text);
        if (!parsed.rows) {
          say(box, parsed.error === "empty" ? MSG.pasteEmpty : MSG.pasteBig);
          return;
        }
        const rows = Struct.pasteGrid(cur.rows, r, c, parsed.rows);
        if (!rows) {
          say(box, MSG.pasteBig);
          return;
        }
        apply(rows, { r, c });
      });

      // structural controls: always visible, named, 44 px targets (CSS)
      const bar = el("div", { class: "carnet-struct-bar", role: "toolbar", "aria-label": "Tableau" });
      const each = (fn) => () => {
        if (host.readOnly()) return host.flash(MSG.readonly);
        const cur = rowsNow();
        if (cur) fn(cur);
      };
      const rr = () => Math.min(pos.r, 1e9);
      const ctl = [
        ["Ajouter une ligne", each((cur) => {
          const rows = Struct.addRow(cur.rows, rr() + 1);
          if (!rows) return say(box, MSG.rowsMax);
          apply(rows, { r: Math.min(rr() + 1, rows.length - 1), c: pos.c });
        })],
        ["Supprimer la ligne", each((cur) => {
          const rows = Struct.removeRow(cur.rows, Math.min(pos.r, cur.rows.length - 1));
          if (!rows) return say(box, MSG.rowMin);
          apply(rows, { r: Math.min(pos.r, rows.length - 1), c: Math.min(pos.c, rows[0].length - 1) });
        })],
        ["Ajouter une colonne", each((cur) => {
          const rows = Struct.addCol(cur.rows, pos.c + 1);
          if (!rows) return say(box, MSG.colsMax);
          apply(rows, { r: Math.min(pos.r, rows.length - 1), c: Math.min(pos.c + 1, rows[0].length - 1) });
        })],
        ["Supprimer la colonne", each((cur) => {
          const rows = Struct.removeCol(cur.rows, Math.min(pos.c, cur.rows[0].length - 1));
          if (!rows) return say(box, MSG.colMin);
          apply(rows, { r: Math.min(pos.r, rows.length - 1), c: Math.min(pos.c, rows[0].length - 1) });
        })],
      ];
      for (const [label, fn] of ctl) bar.appendChild(button(label, "", fn, ro ? { disabled: "" } : null));
      const hid = "carnet-th-" + idx + "-" + Math.floor(Math.random() * 1e6);
      const hl = el("label", { class: "carnet-struct-check", for: hid });
      const hc = el("input", { type: "checkbox", id: hid });
      hc.checked = p.header;
      if (ro) hc.setAttribute("disabled", "");
      hc.addEventListener("change", () => {
        const cur = rowsNow();
        if (cur) apply(cur.rows, { r: Math.min(pos.r, cur.rows.length - 1), c: pos.c }, hc.checked);
      });
      hl.appendChild(hc);
      hl.appendChild(doc.createTextNode(" Première ligne = en-tête"));
      bar.appendChild(hl);
      bar.appendChild(button("Copier (TSV)", "", () => {
        const cur = rowsNow();
        if (!cur) return;
        const text = Struct.formatTsv(cur.rows);
        const nav = doc.defaultView && doc.defaultView.navigator;
        if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(() => say(box, MSG.copied), () => say(box, MSG.copyFail));
        else say(box, MSG.copyFail);
      }));
      return bar;
    }

    // ------------------------------------------------------------------ callout

    function normBody(value) {
      return value.replace(/\r\n?/g, "\n").split("\n").map(Struct.cleanCell).join("\n");
    }

    // Multi-line body: an edit that would exceed the line cap is REFUSED, never truncated. A paste is
    // intercepted before it mutates the textarea; any other over-limit input (typing Enter, fill, drop)
    // restores the last committed body from the draft. The committed state is always the exact previous valid body.
    function bindBody(inp, wrapper, max, box) {
      inp.addEventListener("paste", (ev) => {
        if (host.readOnly()) return;
        const data = ev.clipboardData && ev.clipboardData.getData("text");
        if (typeof data !== "string") return;
        const start = inp.selectionStart, end = inp.selectionEnd;
        const next = normBody(inp.value.slice(0, start) + data + inp.value.slice(end));
        if (next.split("\n").length > max) {
          ev.preventDefault();
          say(box, MSG.bodyLines);
        }
      });
      inp.addEventListener("input", () => {
        if (host.readOnly()) return;
        const cur = current(wrapper);
        if (!cur) return;
        const v = normBody(inp.value);
        if (v.split("\n").length > max) {
          inp.value = cur.body;
          say(box, MSG.bodyLines);
          return;
        }
        if (v !== inp.value) inp.value = v;
        commit(wrapper, Object.assign({}, cur, { body: v }), { rerender: false });
      });
    }

    function buildCallout(wrapper, p, idx, box) {
      const ro = host.readOnly();
      const card = el("div", { class: "carnet-callout", "data-kind": p.kind, role: "note", "aria-label": KIND_LABEL[p.kind] });
      const head = el("div", { class: "carnet-callout-head" });
      head.appendChild(el("span", { class: "carnet-callout-glyph", "aria-hidden": "true" }, KIND_GLYPH[p.kind]));
      head.appendChild(el("span", { class: "carnet-callout-kind" }, KIND_LABEL[p.kind]));
      const sel = el("select", { class: "carnet-callout-select", "aria-label": "Type d'encadré" });
      for (const k of Struct.CALLOUT_KINDS) {
        const o = el("option", { value: k }, KIND_LABEL[k]);
        if (k === p.kind) o.selected = true;
        sel.appendChild(o);
      }
      if (ro) sel.setAttribute("disabled", "");
      sel.addEventListener("change", () => {
        const cur = current(wrapper);
        if (cur) commit(wrapper, Object.assign({}, cur, { kind: sel.value }), { rerender: true });
      });
      head.appendChild(sel);
      card.appendChild(head);
      const title = el("input", { type: "text", class: "carnet-callout-title", maxlength: String(Struct.CALLOUT_TITLE_MAX), placeholder: "Titre (facultatif)", "aria-label": "Titre de l'encadré", autocomplete: "off" });
      title.value = p.title;
      const body = el("textarea", { class: "carnet-callout-body", rows: "3", maxlength: String(Struct.CALLOUT_BODY_MAX), placeholder: "Texte", "aria-label": "Texte de l'encadré" });
      body.value = p.body;
      if (ro) {
        title.setAttribute("readonly", "");
        body.setAttribute("readonly", "");
      }
      title.addEventListener("input", () => {
        if (host.readOnly()) return;
        const cur = current(wrapper);
        if (!cur) return;
        const v = Struct.cleanCell(title.value);
        if (v !== title.value) title.value = v;
        commit(wrapper, Object.assign({}, cur, { title: v }), { rerender: false });
      });
      bindBody(body, wrapper, Struct.CALLOUT_BODY_LINES_MAX, box);
      card.appendChild(title);
      card.appendChild(body);
      box.appendChild(card);
      return null;
    }

    // ------------------------------------------------------------------ toggle

    function stateKey(wrapper) {
      return wrapper.getAttribute("data-carnet-block-id") || wrapper.getAttribute("data-carnet-tmp") || "";
    }

    function buildToggle(wrapper, p, idx, box) {
      const ro = host.readOnly();
      const key = stateKey(wrapper);
      const open = key && S.open.has(key) ? S.open.get(key) : !p.body;
      const card = el("div", { class: "carnet-toggle", "data-open": open ? "true" : "false" });
      const bodyId = "carnet-tb-" + idx + "-" + Math.floor(Math.random() * 1e6);
      const head = el("div", { class: "carnet-toggle-head" });
      const chev = el("button", {
        type: "button", class: "carnet-small carnet-toggle-btn", "aria-expanded": open ? "true" : "false", "aria-controls": bodyId, "aria-label": "Afficher ou masquer la section",
      }, open ? "▾" : "▸");
      const summary = el("input", { type: "text", class: "carnet-toggle-summary", maxlength: String(Struct.TOGGLE_SUMMARY_MAX), placeholder: "Titre de la section", "aria-label": "Titre de la section repliable", autocomplete: "off" });
      summary.value = p.summary;
      const body = el("textarea", { class: "carnet-toggle-body", id: bodyId, rows: "4", maxlength: String(Struct.TOGGLE_BODY_MAX), placeholder: "Texte de la section", "aria-label": "Texte de la section" });
      body.value = p.body;
      body.hidden = !open;
      if (ro) {
        summary.setAttribute("readonly", "");
        body.setAttribute("readonly", "");
      }
      // UI state only: opening / closing never touches the draft, the revision or the content.
      chev.addEventListener("click", (ev) => {
        ev.preventDefault();
        const now = chev.getAttribute("aria-expanded") !== "true";
        chev.setAttribute("aria-expanded", now ? "true" : "false");
        chev.textContent = now ? "▾" : "▸";
        card.setAttribute("data-open", now ? "true" : "false");
        body.hidden = !now;
        if (key) S.open.set(key, now);
      });
      summary.addEventListener("input", () => {
        if (host.readOnly()) return;
        const cur = current(wrapper);
        if (!cur) return;
        const v = Struct.cleanCell(summary.value);
        if (v !== summary.value) summary.value = v;
        if (!v) {
          say(box, "Le titre de la section est obligatoire");
          return; // a toggle without a summary is not valid: the previous value stays in the draft
        }
        commit(wrapper, Object.assign({}, cur, { summary: v }), { rerender: false });
      });
      bindBody(body, wrapper, Struct.TOGGLE_BODY_LINES_MAX, box);
      head.appendChild(chev);
      head.appendChild(summary);
      card.appendChild(head);
      card.appendChild(body);
      box.appendChild(card);
      return null;
    }

    // ------------------------------------------------------------------ image group

    async function pick(wrapper, req) {
      if (host.readOnly()) {
        host.flash(MSG.readonly);
        return null;
      }
      const cur = current(wrapper);
      if (!cur) return null;
      const before = JSON.stringify(cur);
      const page = host.pageKey();
      const assets = await host.pickImages(req);
      if (!assets || !assets.length) return null;
      const r = editorRoot();
      const now = r && r.contains(wrapper) ? Rich.getStructPayload(r, wrapper) : null;
      if (host.pageKey() !== page || !now || JSON.stringify(now) !== before) {
        host.flash(MSG.stale); // the page or the block changed while the picture was uploading: nothing is applied
        return null;
      }
      return { cur: now, assets };
    }

    function buildGroup(wrapper, p, idx, box) {
      const ro = host.readOnly();
      const card = el("div", { class: "carnet-group", "data-layout": p.layout, role: "group", "aria-label": LAYOUT_LABEL[p.layout] });
      const labels = Struct.GROUP_ITEM_LABEL[p.layout];
      const apply = (next, focus) => {
        if (!next) return host.flash(MSG.noMove);
        S.focus = focus ? { idx, group: focus } : null;
        commit(wrapper, next, { rerender: true });
      };
      const grid = el("div", { class: "carnet-group-grid" });
      p.items.forEach((a, i) => {
        const fig = el("figure", { class: "carnet-group-item", "data-index": String(i) });
        if (labels) fig.appendChild(el("span", { class: "carnet-group-label" }, labels[i]));
        const img = el("img", { class: "carnet-img", src: ASSET_URL + a.id, alt: a.caption || "", width: String(a.w), height: String(a.h), draggable: "false", decoding: "async" });
        fig.appendChild(img);
        const cap = el("input", { type: "text", class: "carnet-group-caption", maxlength: String(Rich.ASSET_CAPTION_MAX), placeholder: "Légende", "aria-label": "Légende de l'image " + (i + 1), autocomplete: "off" });
        cap.value = a.caption;
        if (ro) cap.setAttribute("readonly", "");
        cap.addEventListener("input", () => {
          if (host.readOnly()) return;
          const cur = current(wrapper);
          if (!cur || !cur.items[i]) return;
          const v = Rich.cleanCaptionText(cap.value);
          if (v !== cap.value) cap.value = v;
          const items = cur.items.map((x, k) => (k === i ? Object.assign({}, x, { caption: v }) : x));
          commit(wrapper, { layout: cur.layout, items }, { rerender: false });
        });
        fig.appendChild(cap);
        if (!ro) {
          const row = el("div", { class: "carnet-group-item-bar" });
          row.appendChild(button("Remplacer", "", async () => {
            const got = await pick(wrapper, { multiple: false, max: 1 });
            if (got) apply(Struct.groupReplace(got.cur, i, got.assets[0]), { index: i });
          }, { "aria-label": "Remplacer l'image " + (i + 1) }));
          if (i > 0) row.appendChild(button("←", "", () => apply(Struct.groupMove(p2(wrapper) || p, i, -1), { index: i - 1 }), { "aria-label": "Déplacer l'image " + (i + 1) + " vers le début" }));
          if (i + 1 < p.items.length) row.appendChild(button("→", "", () => apply(Struct.groupMove(p2(wrapper) || p, i, 1), { index: i + 1 }), { "aria-label": "Déplacer l'image " + (i + 1) + " vers la fin" }));
          if (p.items.length > 2) row.appendChild(button("Retirer", "", () => apply(Struct.groupRemove(p2(wrapper) || p, i), { index: Math.max(0, i - 1) }), { "aria-label": "Retirer l'image " + (i + 1) + " du groupe" }));
          fig.appendChild(row);
        }
        grid.appendChild(fig);
      });
      card.appendChild(grid);
      // Phase 3.5: inspection (zoom / pan, and the before / after slider for a "compare" group). Presentation only: never persisted.
      const inspectGroup = (index, trigger) => {
        const cur = p2(wrapper) || p;
        if (host.inspect) host.inspect({ kind: "imagegroup", assetIds: cur.items.map((a) => a.id), layout: cur.layout, index, blockId: wrapper.getAttribute("data-carnet-block-id") || "" }, trigger);
      };
      let lastTap = { i: -1, t: 0 };
      grid.addEventListener("click", (ev) => {
        const im = ev.target && ev.target.closest ? ev.target.closest("img.carnet-img") : null;
        const f = im && im.closest(".carnet-group-item");
        if (!f) return;
        const i = Number(f.getAttribute("data-index"));
        const now = Date.now();
        if (lastTap.i === i && now - lastTap.t < 380) {
          lastTap = { i: -1, t: 0 };
          inspectGroup(i, card.querySelector(".carnet-group-inspect") || im);
        } else lastTap = { i, t: now };
      });
      if (host.inspect) {
        const ibar = el("div", { class: "carnet-struct-bar carnet-group-inspectbar" });
        ibar.appendChild(button(p.layout === "compare" ? "Inspecter (avant / après)" : "Inspecter", "carnet-group-inspect", (ev) => inspectGroup(0, ev && ev.currentTarget), { "aria-label": p.layout === "compare" ? "Inspecter le groupe : comparaison avant / après" : "Inspecter les images du groupe" }));
        card.appendChild(ibar);
      }
      if (!ro) {
        const bar = el("div", { class: "carnet-struct-bar", role: "toolbar", "aria-label": "Groupe d'images" });
        if (p.layout !== "three") {
          const other = p.layout === "two" ? "compare" : "two";
          bar.appendChild(button(p.layout === "two" ? "Mode avant / après" : "Mode côte à côte", "", () => {
            const cur = current(wrapper);
            if (cur) apply(Struct.groupSetLayout(cur, other), null);
          }));
        }
        if (p.layout === "two") {
          bar.appendChild(button("Ajouter une 3e image", "", async () => {
            const got = await pick(wrapper, { multiple: false, max: 1 });
            if (got) apply(Struct.groupAdd(got.cur, got.assets[0]), { index: 2 });
          }));
        }
        bar.appendChild(button("Dissocier", "", () => {
          const cur = current(wrapper);
          if (cur) host.ungroup(wrapper, cur);
        }, { title: "Chaque image redevient une image seule (largeur 100 %, dans le texte)" }));
        card.appendChild(bar);
      }
      box.appendChild(card);
      return null;
    }

    // ------------------------------------------------------------------ drawing (Phase 3)
    // The block is only a REFERENCE to one immutable Dessiner stem. Removing the block never deletes the drawing. A drawing that no
    // longer resolves keeps its block and shows an explicit "Croquis indisponible" state (remove / relink stay available).

    function paintOffer(wrapper, holder) {
      holder.textContent = "";
      const key = stateKey(wrapper);
      const offer = key ? S.offers.get(key) : null;
      holder.hidden = !offer;
      if (!offer) return;
      holder.appendChild(el("strong", {}, MSG.newVersion));
      holder.appendChild(el("span", { class: "carnet-drawing-offer-name" }, " " + Struct.drawingLabel(offer.to)));
      if (!host.readOnly()) {
        holder.appendChild(button("Utiliser cette version", "carnet-drawing-use", () => {
          const cur = current(wrapper);
          if (!cur || cur.id !== offer.from) return host.flash(MSG.stale);
          S.offers.delete(key);
          commit(wrapper, { id: offer.to }, { rerender: true });
          host.flash(MSG.drawingRelinked);
        }, { "aria-label": "Utiliser cette version : " + Struct.drawingLabel(offer.to) }));
      }
      holder.appendChild(button("Ignorer", "", () => {
        S.offers.delete(key);
        paintOffer(wrapper, holder);
      }, { "aria-label": "Ignorer la nouvelle version" }));
    }

    /** A new stem was saved in Dessiner from this block: offer it (never applied automatically). */
    function offerVersion(blockId, from, to) {
      const r = editorRoot();
      const w = r ? r.querySelector('[data-carnet-block-id="' + blockId + '"][data-carnet-struct="drawing"]') : null;
      if (!w) return false;
      S.offers.set(blockId, { from, to });
      const holder = w.querySelector(".carnet-drawing-offer");
      if (holder) paintOffer(w, holder);
      return !!holder;
    }

    /** Reload every preview (after returning from Dessiner): clears the unavailable state first. */
    function refreshPreviews() {
      const r = editorRoot();
      if (!r) return;
      r.querySelectorAll(".carnet-drawing").forEach((card) => {
        const img = card.querySelector("img.carnet-drawing-img");
        if (!img) return;
        const base = img.getAttribute("data-base") || img.getAttribute("src").split("&r=")[0];
        img.setAttribute("data-base", base);
        card.setAttribute("data-state", "loading");
        img.hidden = false;
        const gone = card.querySelector(".carnet-drawing-missing");
        if (gone) gone.hidden = true;
        img.setAttribute("src", base + "&r=" + Date.now());
      });
    }

    function buildDrawing(wrapper, p, idx, box) {
      const ro = host.readOnly();
      const name = Struct.drawingLabel(p.id);
      const card = el("figure", { class: "carnet-drawing", "data-state": "loading", "data-stem": p.id });
      const base = DRAWING_FILE_URL + encodeURIComponent(p.id) + "&kind=png";
      const img = el("img", { class: "carnet-drawing-img", src: base, "data-base": base, alt: "Croquis : " + name, loading: "lazy", decoding: "async", draggable: "false" });
      const gone = el("div", { class: "carnet-drawing-missing", role: "note", hidden: "" });
      gone.appendChild(el("strong", {}, MSG.drawingGone));
      gone.appendChild(el("span", { class: "carnet-drawing-missing-name" }, " " + name));
      const open = button("Ouvrir dans Dessiner", "carnet-drawing-open", () => host.openDrawing(wrapper, p.id), { "aria-label": "Ouvrir dans Dessiner : " + name, hidden: "" });
      const retry = button("Réessayer", "carnet-drawing-retry", () => refreshPreviews(), { "aria-label": "Réessayer l'aperçu : " + name, hidden: "" });
      // Phase 3.5: inspection-only slide-over (zoom / pan / exact stem / parent). Needs a loaded preview, like "Ouvrir".
      const inspect = button("Inspecter", "carnet-drawing-inspect", () => {
        const id = wrapper.getAttribute("data-carnet-block-id") || "";
        if (host.inspect) host.inspect({ kind: "drawing", stem: p.id, blockId: id }, inspect);
      }, { "aria-label": "Inspecter le croquis : " + name, hidden: "" });
      img.addEventListener("load", () => {
        card.setAttribute("data-state", "ok");
        gone.hidden = true;
        open.hidden = false;
        inspect.hidden = !host.inspect;
        retry.hidden = true;
      });
      img.addEventListener("error", () => {
        card.setAttribute("data-state", "missing");
        img.hidden = true;
        gone.hidden = false;
        open.hidden = true; // an Open action only exists while the drawing still resolves
        inspect.hidden = true;
        retry.hidden = false;
      });
      img.addEventListener("click", () => {
        if (card.getAttribute("data-state") === "ok") inspect.click();
      });
      card.appendChild(img);
      card.appendChild(gone);
      card.appendChild(el("figcaption", { class: "carnet-caption" }, "Croquis : " + name));
      const offerBox = el("div", { class: "carnet-drawing-offer", role: "status", "aria-live": "polite", hidden: "" });
      card.appendChild(offerBox);
      const bar = el("div", { class: "carnet-struct-bar carnet-drawing-bar", role: "toolbar", "aria-label": "Croquis : " + name });
      bar.appendChild(open);
      bar.appendChild(inspect);
      bar.appendChild(retry);
      if (!ro) {
        const pickerHost = el("div", { class: "carnet-drawing-picker", hidden: "" });
        bar.appendChild(button("Relier à un autre croquis", "", async () => {
          if (!pickerHost.hidden) {
            pickerHost.hidden = true;
            return;
          }
          pickerHost.textContent = "";
          let list = [];
          try {
            list = await host.listDrawings();
          } catch (_) {
            list = [];
          }
          if (!list.length) return say(box, MSG.drawingNoList);
          const sel = el("select", { class: "carnet-drawing-select", "aria-label": "Croquis à relier" });
          for (const stem of list) {
            const o = el("option", { value: stem }, stem);
            if (stem === p.id) o.selected = true;
            sel.appendChild(o);
          }
          pickerHost.appendChild(sel);
          pickerHost.appendChild(button("Utiliser", "", () => {
            const cur = current(wrapper);
            if (!cur) return;
            if (sel.value === cur.id) {
              pickerHost.hidden = true;
              return;
            }
            S.offers.delete(stateKey(wrapper));
            commit(wrapper, { id: sel.value }, { rerender: true });
            host.flash(MSG.drawingRelinked);
          }, { "aria-label": "Relier ce bloc au croquis choisi" }));
          pickerHost.hidden = false;
          sel.focus();
        }, { "aria-label": "Relier à un autre croquis : " + name }));
        card.appendChild(pickerHost);
      }
      card.appendChild(bar);
      box.appendChild(card);
      const key = stateKey(wrapper);
      if (key && S.offers.has(key)) {
        if (S.offers.get(key).from === p.id) paintOffer(wrapper, offerBox);
        else S.offers.delete(key);
      }
      return null;
    }

    function p2(wrapper) {
      const r = editorRoot();
      return r && r.contains(wrapper) ? Rich.getStructPayload(r, wrapper) : null;
    }

    // ------------------------------------------------------------------ block frame (installed as the editor's renderer)

    const TITLE = { table: "Tableau", callout: "Encadré", toggle: "Section repliable", imagegroup: "Groupe d'images", drawing: "Croquis" };

    function render(d, wrapper, type, payload, idx) {
      const box = el("div", { class: "carnet-struct", "data-struct": type });
      isolate(wrapper);
      let bar = null;
      if (type === "table") bar = buildTable(wrapper, payload, idx, box);
      else if (type === "callout") buildCallout(wrapper, payload, idx, box);
      else if (type === "toggle") buildToggle(wrapper, payload, idx, box);
      else if (type === "drawing") buildDrawing(wrapper, payload, idx, box);
      else buildGroup(wrapper, payload, idx, box);
      if (bar) box.appendChild(bar);
      const foot = el("div", { class: "carnet-struct-foot" });
      foot.appendChild(el("span", { class: "carnet-struct-msg", role: "status", "aria-live": "polite" }));
      if (!host.readOnly()) {
        let armed = null;
        // A drawing block only references a drawing: removing it NEVER deletes the drawing (it stays in Dessiner).
        const isDrawing = type === "drawing";
        const delLabel = isDrawing ? "Retirer du carnet" : "Supprimer le bloc";
        const delAria = isDrawing ? "Retirer la référence au croquis du carnet (le croquis reste dans Dessiner)" : "Supprimer le bloc";
        const del = button(delLabel, "carnet-struct-del", () => {
          if (!armed) {
            del.textContent = isDrawing ? "Confirmer le retrait" : "Confirmer la suppression";
            del.setAttribute("aria-label", (isDrawing ? "Confirmer le retrait : " : "Confirmer la suppression : ") + TITLE[type]);
            armed = host.timeout(() => {
              armed = null;
              del.textContent = delLabel;
              del.setAttribute("aria-label", delAria);
            }, 4000);
            return;
          }
          host.clear(armed);
          host.remove(wrapper);
        }, { "aria-label": delAria });
        foot.appendChild(del);
      }
      box.appendChild(foot);
      wrapper.appendChild(box);
      const f = S.focus;
      if (f && f.idx === idx) {
        S.focus = null;
        const run = () => {
          if (f.group) {
            const fig = wrapper.querySelector('figure[data-index="' + f.group.index + '"] input');
            if (fig) fig.focus();
          } else focusCell(wrapper, f.r, f.c, false);
        };
        if (typeof queueMicrotask === "function") queueMicrotask(run);
        else Promise.resolve().then(run);
      }
    }

    /** Focus the structured block at editor line `idx` and scroll it into view; a toggle is opened (UI state only). Returns the element or null. */
    function reveal(idx) {
      const w = editorRoot() && editorRoot().children[idx];
      if (!w || !w.hasAttribute("data-carnet-struct")) return null;
      const btn = w.querySelector(".carnet-toggle-btn");
      if (btn && btn.getAttribute("aria-expanded") !== "true") btn.click();
      if (w.scrollIntoView) w.scrollIntoView({ block: "center", behavior: "auto" });
      w.setAttribute("data-struct-hit", "true");
      host.timeout(() => w.removeAttribute("data-struct-hit"), 2500);
      return w;
    }

    /** The pending Phase-3 version offer of a drawing block (read-only accessor for the inspector). */
    function offerFor(blockId) {
      return blockId && S.offers.has(blockId) ? S.offers.get(blockId) : null;
    }

    /** "Utiliser cette version" from the inspector: exactly the card's own action (explicit, never automatic). */
    function useOffer(blockId) {
      const r = editorRoot();
      const w = r && blockId ? r.querySelector('[data-carnet-block-id="' + blockId + '"][data-carnet-struct="drawing"]') : null;
      const offer = offerFor(blockId);
      if (!w || !offer || host.readOnly()) return false;
      const cur = current(w);
      if (!cur || cur.id !== offer.from) return false;
      S.offers.delete(blockId);
      commit(w, { id: offer.to }, { rerender: true });
      host.flash(MSG.drawingRelinked);
      return true;
    }

    return { render, reveal, offerVersion, refreshPreviews, offerFor, useOffer, state: S };
  }

  /** A fresh payload for a new block (valid by construction). */
  function blank(type, rich) {
    if (type === "table") return { header: true, rows: [["", "", ""], ["", "", ""], ["", "", ""]] };
    if (type === "callout") return { kind: "note", title: "", body: "" };
    if (type === "toggle") return { summary: "Section", body: "" };
    return null;
  }

  return { mount, blank, attachmentParts, MSG, KIND_LABEL, LAYOUT_LABEL };
});
