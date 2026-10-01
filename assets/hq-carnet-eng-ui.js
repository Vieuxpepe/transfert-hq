/* Transfert HQ — Carnet Stage 07: engineering tools UI (collapsed, contextual).
 *
 * NOTHING here is visible on the default paper. One panel (#hq-carnet-eng) is created lazily the first time a tool is
 * opened from the editor's "Ingénierie" entry (inside the already-collapsed "Symboles et outils" tray) or by activating
 * a calculation / measurement atom. A user who only writes notes never meets any of it.
 *
 * Every tool is BOUND to the object it was opened against: page id + the editor generation + the canonical content
 * signature (+ selection / block id / payload where relevant). Before anything is applied the binding is re-checked
 * against the live editor; any drift (page switched, text typed, remote change adopted) fails closed with a visible
 * message and nothing is modified. Nothing is ever retried against a newer revision.
 *
 * The single editor state machine stays the only writer: all edits go through host.editor.commit (draft + generation +
 * autosave + conflict handling), exactly like typing. No second notebook state, no second editor, no second task
 * store (task extraction calls the server's `task_extract`, which uses the existing Kanban board).
 *
 * DOM is built with createElement/textContent only. No HTML string injection, no dynamic code evaluation. Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetEngUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const Eng = node ? require("./hq-carnet-eng.js") : global.HqCarnetEng;
  const Rich = node ? require("./hq-carnet-rich.js") : global.HqCarnetRich;

  const MSG = {
    stale: "La page a changé pendant que l'outil était ouvert — rien n'a été modifié. Rouvre l'outil.",
    readonly: "Page en lecture seule",
    refused: "Modification refusée",
    missing: "Cible introuvable (déplacée ou supprimée)",
    unavailable: "Cible indisponible pour le moment",
    disclaimer: "Aide de carnet — non certifié (pas de la métrologie).",
    taskDirty: "Enregistrement en cours — réessaie dans un instant.",
    taskStale: "La note a changé — aucune tâche créée. Sélectionne à nouveau le texte.",
    taskDown: "Tâches indisponibles — rien n'a été créé.",
    taskNeedSel: "Sélectionne du texte (sur une seule ligne) pour en faire une tâche.",
    taskUnsaved: "Cette ligne n'est pas encore enregistrée — réessaie dans un instant.",
    taskDone: "Tâche ajoutée à « À faire ». Le texte de la note est inchangé.",
    taskDup: "Tâche déjà créée.",
    linkNeedSel: "Sélectionne le texte à lier.",
    nothing: "Rien à lier",
  };

  const MENU = [
    ["calc", "Calcul"],
    ["measure", "Mesure"],
    ["decision", "Décision"],
    ["convert", "Convertir"],
    ["task", "Tâche"],
    ["link", "Lien HQ"],
  ];

  const LINK_KINDS_UI = [
    ["note", "Note"],
    ["project", "Projet"],
    ["media", "Lecteur (média / modèle 3D)"],
    ["drawing", "Dessin (Dessiner)"],
    ["file", "Fichier"],
  ];

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "text") n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (kids) for (const c of kids) n.appendChild(c);
    return n;
  }

  function sigOf(e) {
    return String(e.local.text) + "\u0001" + String(e.local.fmt);
  }

  function requestId() {
    const bytes = new Uint8Array(12);
    if (global.crypto && typeof global.crypto.getRandomValues === "function") global.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return "tk-" + Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
  }

  function mount(host) {
    const doc = host.doc;
    const now = typeof host.now === "function" ? host.now : () => Date.now();
    const S = { panel: null, body: null, title: null, msg: null, kind: null, bound: null, token: 0, busy: false, rid: null, confirm: false };

    const nowSec = () => Math.floor(now() / 1000);

    // ------------------------------------------------------------ shell

    function ensurePanel() {
      if (S.panel) return S.panel;
      S.title = el(doc, "strong", { class: "carnet-eng-title" });
      const close = el(doc, "button", { type: "button", id: "btn-carnet-eng-close", class: "carnet-small", text: "Fermer" });
      close.addEventListener("click", () => closePanel(true));
      S.body = el(doc, "div", { class: "carnet-eng-form" });
      S.msg = el(doc, "p", { id: "hq-carnet-eng-msg", class: "carnet-msg", role: "alert" });
      S.panel = el(doc, "div", { id: "hq-carnet-eng", class: "carnet-panel carnet-eng-panel", role: "group", "aria-label": "Outils d'ingénierie", hidden: "" }, [
        el(doc, "div", { class: "carnet-panel-row carnet-eng-headrow" }, [S.title, close]),
        S.body,
        S.msg,
      ]);
      S.panel.setAttribute("tabindex", "-1");
      S.panel.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          closePanel(true);
        }
      });
      host.root.appendChild(S.panel);
      return S.panel;
    }

    function show(kind, title) {
      ensurePanel();
      S.token += 1; // anything still loading for the previous tool is ignored
      S.kind = kind;
      S.busy = false;
      S.confirm = false;
      S.body.textContent = "";
      S.msg.textContent = "";
      S.title.textContent = title;
      S.panel.hidden = false;
      S.panel.setAttribute("data-eng-kind", kind);
      S.panel.focus({ preventScroll: true }); // Escape / Tab act inside the panel (tools then focus their first field)
    }

    function closePanel(refocus) {
      if (!S.panel) return;
      S.token += 1;
      S.panel.hidden = true;
      S.panel.removeAttribute("data-eng-kind");
      S.body.textContent = "";
      S.msg.textContent = "";
      S.kind = null;
      S.bound = null;
      S.busy = false;
      S.rid = null;
      if (typeof host.onClose === "function") host.onClose(!!refocus);
    }

    function say(text, bad) {
      if (!S.msg) return;
      S.msg.textContent = text || "";
      if (bad) S.msg.setAttribute("data-bad", "true");
      else S.msg.removeAttribute("data-bad");
    }

    function field(label, id, attrs) {
      const input = el(doc, "input", Object.assign({ type: "text", id, class: "carnet-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": label, placeholder: label }, attrs || {}));
      return { input, wrap: el(doc, "label", { class: "carnet-eng-field" }, [el(doc, "span", { class: "carnet-eng-label", text: label }), input]) };
    }

    function select(label, id, options, value) {
      const sel = el(doc, "select", { id, class: "carnet-input", "aria-label": label });
      for (const [v, t] of options) sel.appendChild(el(doc, "option", { value: v, text: t }));
      if (value !== undefined) sel.value = value;
      return { input: sel, wrap: el(doc, "label", { class: "carnet-eng-field" }, [el(doc, "span", { class: "carnet-eng-label", text: label }), sel]) };
    }

    function button(id, text, cls) {
      return el(doc, "button", { type: "button", id, class: cls || "carnet-small", text });
    }

    function row(kids) {
      return el(doc, "div", { class: "carnet-panel-row" }, kids);
    }

    const UNIT_OPTIONS = [["", "— sans unité —"]].concat(Eng.UNITS.map((u) => [u, u]));

    // ------------------------------------------------------------ binding

    function capture(kind) {
      const e = host.editor.entry();
      if (!e) {
        host.flash(MSG.readonly);
        return null;
      }
      const sel = host.editor.sel();
      return { kind, pageId: e.id, gen: e.generation, sig: sigOf(e), start: sel.start, end: sel.end, rev: e.serverRev };
    }

    function still(b) {
      const e = host.editor.entry();
      return !!e && !!b && e.id === b.pageId && e.generation === b.gen && sigOf(e) === b.sig;
    }

    function capOut(text) {
      say(text, true);
      return false;
    }

    function staleOut() {
      say(MSG.stale, true);
      return false;
    }

    /** Insert one atom line after the caret line (a blank caret line stays BELOW it, so typing continues there). */
    function insertLine(b, line, replaceBlank) {
      const e = host.editor.entry();
      if (!e || !still(b)) return staleOut();
      const lines = host.editor.lines(e);
      if (line.type === "calc" || line.type === "measure") {
        if (lines.filter((l) => l.type === "calc" || l.type === "measure").length >= Eng.ATOMS_PER_PAGE_MAX) return capOut("Trop de calculs/mesures sur la page (max " + Eng.ATOMS_PER_PAGE_MAX + ")");
      } else if (line.type === "decision" && lines.filter((l) => l.type === "decision").length >= Eng.DECISIONS_PER_PAGE_MAX) {
        return capOut("Trop de décisions sur la page (max " + Eng.DECISIONS_PER_PAGE_MAX + ")");
      }
      const at = Rich.locate(lines, b.end);
      const cur = lines[at.line];
      const blank = cur.type === "paragraph" && cur.text === "" && !cur.marks.length;
      let idx = at.line + 1;
      if (blank) idx = at.line;
      else if (!Rich.isAtom(cur) && at.off === 0 && cur.text !== "" && !replaceBlank) idx = at.line;
      if (blank && replaceBlank) lines.splice(at.line, 1, line);
      else lines.splice(idx, 0, line);
      if (!replaceBlank) {
        const after = lines[idx + 1];
        if (!after || Rich.isAtom(after)) lines.splice(idx + 1, 0, Rich.newLine("", "paragraph"));
      } else if (!lines[idx + 1]) lines.push(Rich.newLine("", "paragraph"));
      Rich.ensureKeys(lines);
      const caret = Rich.lineStarts(lines)[Math.min(idx + 1, lines.length - 1)];
      if (!host.editor.commit(lines, { start: caret, end: caret })) {
        say(MSG.refused, true);
        return false;
      }
      return true;
    }

    function insertTextAt(b, pos, text, expectSel) {
      const e = host.editor.entry();
      if (!e || !still(b)) return staleOut();
      const lines = host.editor.lines(e);
      if (expectSel !== undefined && Rich.flat(lines).slice(b.start, b.end) !== expectSel) return staleOut();
      const res = Rich.replaceRange(lines, pos, pos, text);
      if (!host.editor.commit(res.lines, { start: res.caret, end: res.caret })) {
        say(MSG.refused, true);
        return false;
      }
      return true;
    }

    /** Replace the payload of an EXISTING atom/decision: the block id, type and payload must be exactly what was opened. */
    function changeBlock(b, mutate) {
      const e = host.editor.entry();
      if (!e || !still(b)) return staleOut();
      const lines = host.editor.lines(e);
      const idx = lines.findIndex((l) => l.id === b.blockId);
      if (idx < 0 || lines[idx].type !== b.type || JSON.stringify(lines[idx].eng) !== b.payloadJson) return staleOut();
      const res = mutate(lines, idx);
      if (!res) return false;
      Rich.ensureKeys(lines);
      const caret = Rich.lineStarts(lines)[Math.min(idx, lines.length - 1)];
      if (!host.editor.commit(lines, { start: caret, end: caret })) {
        say(MSG.refused, true);
        return false;
      }
      return true;
    }

    function selectedText(b) {
      const e = host.editor.entry();
      if (!e) return "";
      const flat = Rich.flat(host.editor.lines(e));
      return b.end > b.start ? flat.slice(b.start, b.end) : "";
    }

    // ------------------------------------------------------------ menu

    function openMenu() {
      const e = host.editor.entry();
      if (!e) {
        host.flash(MSG.readonly);
        return;
      }
      const sel = host.editor.sel();
      S.menuSel = { start: sel.start, end: sel.end };
      show("menu", "Ingénierie");
      const grid = el(doc, "div", { class: "carnet-eng-menu", role: "group", "aria-label": "Outils" });
      for (const [key, label] of MENU) {
        const b = button("btn-carnet-eng-" + key, label, "carnet-small carnet-eng-tool");
        b.setAttribute("data-eng-tool", key);
        b.addEventListener("click", () => openTool(key));
        grid.appendChild(b);
      }
      S.body.appendChild(grid);
      S.panel.focus({ preventScroll: true }); // Escape / Tab now act inside the panel
    }

    function openTool(kind, preset) {
      if (kind === "calc") return toolCalc();
      if (kind === "measure") return toolMeasure();
      if (kind === "decision") return toolDecision();
      if (kind === "convert") return toolConvert();
      if (kind === "task") return toolTask();
      if (kind === "link") return toolLink(preset);
      return openMenu();
    }

    // ------------------------------------------------------------ calculation

    function unitSelectValue(u) {
      return u === null || u === undefined ? "" : u;
    }

    function toolCalc() {
      const b = capture("calc");
      if (!b) return;
      show("calc", "Calcul");
      S.bound = b;
      const expr = field("Expression (+ − * / ^ et parenthèses)", "hq-carnet-eng-expr", { inputmode: "text", maxlength: String(Eng.EXPR_MAX) });
      const unit = select("Unité (facultatif)", "hq-carnet-eng-calc-unit", UNIT_OPTIONS, "");
      const out = el(doc, "p", { id: "hq-carnet-eng-calc-out", class: "carnet-eng-out", role: "status", "aria-live": "polite" });
      const ins = button("btn-carnet-eng-insert", "Insérer le calcul");
      const sel = selectedText(b);
      if (sel && sel.length <= Eng.EXPR_MAX && Eng.calculate(sel).ok) expr.input.value = sel;
      const refresh = () => {
        const r = Eng.calculate(expr.input.value);
        out.textContent = expr.input.value.trim() ? (r.ok ? "= " + r.result : r.message) : "";
        out.setAttribute("data-bad", r.ok ? "false" : expr.input.value.trim() ? "true" : "false");
        ins.disabled = !r.ok;
      };
      expr.input.addEventListener("input", refresh);
      expr.input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ins.disabled) {
          ev.preventDefault();
          ins.click();
        }
      });
      ins.addEventListener("click", () => {
        const r = Eng.calculate(expr.input.value); // recomputed from the text: the preview is never trusted
        if (!r.ok) return say(r.message, true);
        const line = Rich.engLine("calc", { expr: r.expr, result: r.result, unit: unit.input.value || null, at: nowSec(), v: Eng.CALC_VERSION });
        if (!line) return say("Calcul invalide", true);
        if (insertLine(b, line, false)) closePanel(true);
      });
      S.body.append(expr.wrap, unit.wrap, out, row([ins]));
      refresh();
      expr.input.focus({ preventScroll: true });
    }

    function atomHead(b, title) {
      S.body.appendChild(el(doc, "p", { class: "hint", text: title }));
    }

    function openCalcAtom(b, payload) {
      show("calc-edit", "Calcul");
      S.bound = b;
      const expr = field("Expression", "hq-carnet-eng-expr", { maxlength: String(Eng.EXPR_MAX) });
      expr.input.value = payload.expr;
      const unit = select("Unité (facultatif)", "hq-carnet-eng-calc-unit", UNIT_OPTIONS, unitSelectValue(payload.unit));
      const stored = el(doc, "p", { class: "carnet-eng-out", id: "hq-carnet-eng-calc-stored", text: "Résultat enregistré : " + payload.result + (payload.unit ? " " + payload.unit : "") });
      const now2 = el(doc, "p", { class: "carnet-eng-out", id: "hq-carnet-eng-calc-new", role: "status", "aria-live": "polite" });
      const recalc = button("btn-carnet-eng-recalc", "Recalculer");
      const apply = button("btn-carnet-eng-apply", "Remplacer par ce résultat");
      const del = button("btn-carnet-eng-delete", "Supprimer", "carnet-small carnet-danger");
      apply.hidden = true;
      let fresh = null;
      const doRecalc = () => {
        const r = Eng.calculate(expr.input.value);
        fresh = r.ok ? r : null;
        if (!r.ok) {
          now2.textContent = r.message;
          apply.hidden = true;
          return;
        }
        const same = r.expr === payload.expr && r.result === payload.result && (unit.input.value || null) === payload.unit;
        now2.textContent = same ? "Même résultat : " + r.result : "Nouveau résultat : " + r.result + " (enregistré : " + payload.result + ")";
        apply.hidden = same;
      };
      recalc.addEventListener("click", doRecalc);
      apply.addEventListener("click", () => {
        if (!fresh) return;
        const next = Rich.engPayload("calc", { expr: fresh.expr, result: fresh.result, unit: unit.input.value || null, at: nowSec(), v: Eng.CALC_VERSION });
        if (!next) return say("Calcul invalide", true);
        if (changeBlock(b, (lines, idx) => ((lines[idx].eng = next), true))) closePanel(true);
      });
      del.addEventListener("click", () => confirmDelete(b, del));
      S.body.append(stored, expr.wrap, unit.wrap, now2, row([recalc, apply, del]));
      atomHead(b, "Le résultat enregistré ne change jamais tout seul : « Recalculer » le compare, tu choisis de le remplacer.");
    }

    function confirmDelete(b, btn) {
      if (!S.confirm) {
        S.confirm = true;
        btn.textContent = "Confirmer la suppression";
        return;
      }
      if (changeBlock(b, (lines, idx) => (lines.splice(idx, 1), lines.length || lines.push(Rich.newLine("", "paragraph")), true))) closePanel(true);
    }

    // ------------------------------------------------------------ measurement

    const MODE_OPTIONS = [
      ["none", "Sans tolérance"],
      ["sym", "± symétrique"],
      ["bounds", "Bornes basse / haute"],
      ["pct", "± pourcentage du nominal"],
    ];
    const LINK_OPTIONS = [
      ["", "Aucun lien"],
      ["media", "Photo"],
      ["drawing", "Dessin"],
      ["file", "Fichier"],
      ["source", "Source"],
    ];

    function toolMeasure() {
      const b = capture("measure");
      if (!b) return;
      buildMeasureForm(b, null);
    }

    function openMeasureAtom(b, payload) {
      buildMeasureForm(b, payload);
    }

    function buildMeasureForm(b, existing) {
      show(existing ? "measure-edit" : "measure", "Mesure");
      S.bound = b;
      const f = {
        label: field("Libellé (ex. alésage A)", "hq-carnet-eng-m-label", { maxlength: String(Eng.LABEL_MAX) }),
        obs: field("Valeur observée", "hq-carnet-eng-m-obs", { inputmode: "decimal" }),
        unit: select("Unité", "hq-carnet-eng-m-unit", UNIT_OPTIONS, ""),
        mode: select("Tolérance", "hq-carnet-eng-m-mode", MODE_OPTIONS, "none"),
        nom: field("Valeur nominale (facultatif)", "hq-carnet-eng-m-nom", { inputmode: "decimal" }),
        t: field("± valeur", "hq-carnet-eng-m-t", { inputmode: "decimal" }),
        lo: field("Borne basse", "hq-carnet-eng-m-lo", { inputmode: "decimal" }),
        hi: field("Borne haute", "hq-carnet-eng-m-hi", { inputmode: "decimal" }),
        p: field("± pourcentage (0–100)", "hq-carnet-eng-m-p", { inputmode: "decimal" }),
        linkKind: select("Lien (facultatif)", "hq-carnet-eng-m-link-kind", LINK_OPTIONS, ""),
        linkTarget: select("Cible du lien", "hq-carnet-eng-m-link-target", [["", "—"]], ""),
      };
      f.linkTarget.wrap.hidden = true;
      const verdict = el(doc, "p", { id: "hq-carnet-eng-m-verdict", class: "carnet-eng-out", role: "status", "aria-live": "polite" });
      const note = el(doc, "p", { class: "hint carnet-eng-note", text: MSG.disclaimer });
      const ins = button("btn-carnet-eng-insert", existing ? "Enregistrer" : "Insérer la mesure");
      const del = button("btn-carnet-eng-delete", "Supprimer", "carnet-small carnet-danger");
      del.hidden = !existing;
      const show3 = () => {
        const m = f.mode.input.value;
        f.t.wrap.hidden = m !== "sym";
        f.lo.wrap.hidden = m !== "bounds";
        f.hi.wrap.hidden = m !== "bounds";
        f.p.wrap.hidden = m !== "pct";
      };
      const collect = () => {
        const dec = (input, what) => {
          const v = Eng.parseDecimalInput(input.value);
          return v === null ? { err: what + " invalide" } : { v };
        };
        const obs = dec(f.obs.input, "Valeur observée");
        if (obs.err) return obs;
        const u = f.unit.input.value;
        let nominal = null;
        if (f.nom.input.value.trim() !== "") {
          const n = dec(f.nom.input, "Nominal");
          if (n.err) return n;
          nominal = { v: n.v, u };
        }
        const mode = f.mode.input.value;
        let tol = null;
        if (mode === "sym") {
          const t = dec(f.t.input, "Tolérance");
          if (t.err) return t;
          tol = { t: t.v, u };
        } else if (mode === "bounds") {
          const lo = dec(f.lo.input, "Borne basse");
          const hi = dec(f.hi.input, "Borne haute");
          if (lo.err) return lo;
          if (hi.err) return hi;
          tol = { lo: lo.v, hi: hi.v, u };
        } else if (mode === "pct") {
          const p = dec(f.p.input, "Pourcentage");
          if (p.err) return p;
          tol = { p: p.v };
        }
        if ((mode === "sym" || mode === "pct") && !nominal) return { err: "Nominal requis pour cette tolérance" };
        const kind = f.linkKind.input.value;
        let link = null;
        if (kind) {
          if (!f.linkTarget.input.value) return { err: "Choisis la cible du lien" };
          link = { kind: targetKinds.get(f.linkTarget.input.value) || kind, id: f.linkTarget.input.value };
        }
        const payload = { label: f.label.input.value.trim(), observed: { v: obs.v, u }, mode, nominal, tol, at: existing ? existing.at : nowSec(), link };
        const clean = Rich.engPayload("measure", payload);
        return clean ? { payload: clean } : { err: "Mesure invalide (libellé 1–" + Eng.LABEL_MAX + " caractères, valeurs ≤ 15 chiffres)" };
      };
      const refresh = () => {
        show3();
        const r = collect();
        if (r.err) {
          verdict.textContent = r.err;
          verdict.setAttribute("data-bad", "true");
          ins.disabled = true;
          return;
        }
        const v = Eng.evaluate(r.payload);
        const bits = [];
        if (v.deviation !== null) bits.push("écart " + (v.deviation !== "0" && v.deviation.charAt(0) !== "-" ? "+" : "") + v.deviation + (r.payload.observed.u ? " " + r.payload.observed.u : ""));
        if (Eng.STATUS_TEXT[v.status]) bits.push(Eng.STATUS_TEXT[v.status]);
        verdict.textContent = bits.join(" · ");
        verdict.setAttribute("data-bad", "false");
        if (v.status) verdict.setAttribute("data-status", v.status);
        ins.disabled = false;
      };
      const token = S.token;
      let targetKinds = new Map(); // picked value -> the exact reference kind (a 3D file is a "model", a photo/clip is "media")
      const loadLinkTargets = async () => {
        const kind = f.linkKind.input.value;
        f.linkTarget.wrap.hidden = !kind;
        f.linkTarget.input.textContent = "";
        f.linkTarget.input.appendChild(el(doc, "option", { value: "", text: kind ? "Chargement…" : "—" }));
        if (!kind) return refresh();
        let items = [];
        try {
          items = await listTargets(kind);
        } catch (_) {
          items = [];
        }
        if (token !== S.token) return; // tool closed / replaced while loading
        f.linkTarget.input.textContent = "";
        f.linkTarget.input.appendChild(el(doc, "option", { value: "", text: items.length ? "— choisir —" : "Aucune cible disponible" }));
        targetKinds = new Map();
        for (const it of items) {
          targetKinds.set(it.value, it.refKind || kind);
          f.linkTarget.input.appendChild(el(doc, "option", { value: it.value, text: it.label }));
        }
        if (existing && existing.link) f.linkTarget.input.value = existing.link.id;
        refresh();
      };
      for (const k of ["label", "obs", "nom", "t", "lo", "hi", "p"]) f[k].input.addEventListener("input", refresh);
      f.unit.input.addEventListener("change", refresh);
      f.mode.input.addEventListener("change", refresh);
      f.linkKind.input.addEventListener("change", loadLinkTargets);
      f.linkTarget.input.addEventListener("change", refresh);
      ins.addEventListener("click", () => {
        const r = collect();
        if (r.err) return say(r.err, true);
        if (existing) {
          if (changeBlock(b, (lines, idx) => ((lines[idx].eng = r.payload), true))) closePanel(true);
          return;
        }
        const line = Rich.engLine("measure", r.payload);
        if (!line) return say("Mesure invalide", true);
        if (insertLine(b, line, false)) closePanel(true);
      });
      del.addEventListener("click", () => confirmDelete(b, del));
      if (existing) {
        f.label.input.value = existing.label;
        f.obs.input.value = existing.observed.v;
        f.unit.input.value = existing.observed.u;
        f.mode.input.value = existing.mode;
        if (existing.nominal) f.nom.input.value = existing.nominal.v;
        if (existing.mode === "sym") f.t.input.value = existing.tol.t;
        if (existing.mode === "bounds") {
          f.lo.input.value = existing.tol.lo;
          f.hi.input.value = existing.tol.hi;
        }
        if (existing.mode === "pct") f.p.input.value = existing.tol.p;
        if (existing.link) {
          f.linkKind.input.value = existing.link.kind === "model" ? "media" : existing.link.kind;
          loadLinkTargets();
        }
      }
      S.body.append(f.label.wrap, row([f.obs.wrap, f.unit.wrap]), f.nom.wrap, f.mode.wrap, f.t.wrap, f.lo.wrap, f.hi.wrap, f.p.wrap, f.linkKind.wrap, f.linkTarget.wrap, verdict, note, row([ins, del]));
      refresh();
      f.label.input.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------ decision

    function toolDecision() {
      const b = capture("decision");
      if (!b) return;
      show("decision", "Décision");
      S.bound = b;
      const e = host.editor.entry();
      const lines = e ? host.editor.lines(e) : [];
      const at = Rich.locate(lines, b.end);
      const cur = lines[at.line];
      const text = field("Décision (une ligne)", "hq-carnet-eng-d-text", { maxlength: "300" });
      const ins = button("btn-carnet-eng-insert", "Insérer la décision");
      const kids = [text.wrap, row([ins])];
      const sel = selectedText(b);
      if (sel && sel.indexOf("\n") < 0 && sel.length <= 300) text.input.value = sel;
      ins.addEventListener("click", () => {
        const t = text.input.value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
        if (!t) return say("Écris la décision", true);
        const line = Rich.decisionLine(t, nowSec());
        if (!line) return say("Décision invalide", true);
        if (insertLine(b, line, true)) closePanel(true);
      });
      text.input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ins.click();
        }
      });
      if (cur && cur.type === "decision") {
        const drop = button("btn-carnet-eng-undecide", "Retirer le statut de décision (le texte reste)");
        const bb = Object.assign({}, b, { blockId: cur.id, type: "decision", payloadJson: JSON.stringify(cur.eng) });
        drop.addEventListener("click", () => {
          if (changeBlock(bb, (ls, idx) => ((ls[idx].type = "paragraph"), (ls[idx].eng = null), true))) closePanel(true);
        });
        kids.push(row([drop]));
      }
      S.body.append.apply(S.body, kids);
      text.input.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------ conversion

    function targetsFor(unit) {
      return Eng.PAIRS.filter((p) => p.split(">")[0] === unit).map((p) => p.split(">")[1]);
    }

    function toolConvert() {
      const b = capture("convert");
      if (!b) return;
      show("convert", "Convertir");
      S.bound = b;
      const sel = selectedText(b);
      const q = field("Valeur et unité (ex. 25,4 mm)", "hq-carnet-eng-c-q", { inputmode: "text" });
      const to = select("Vers", "hq-carnet-eng-c-to", [["", "—"]], "");
      const out = el(doc, "p", { id: "hq-carnet-eng-c-out", class: "carnet-eng-out", role: "status", "aria-live": "polite" });
      const ins = button("btn-carnet-eng-insert", "Insérer à côté");
      const note = el(doc, "p", { class: "hint carnet-eng-note", text: "Le texte d'origine reste tel quel : le résultat (≈, arrondi) est ajouté juste après." });
      let origin = null; // the selected text the quantity came from (kept verbatim)
      if (sel && Eng.parseQuantity(sel)) {
        q.input.value = sel;
        origin = sel;
      }
      const refresh = () => {
        const qty = Eng.parseQuantity(q.input.value);
        const prev = to.input.value;
        if (!qty) {
          to.input.textContent = "";
          to.input.appendChild(el(doc, "option", { value: "", text: "—" }));
          out.textContent = q.input.value.trim() ? "Valeur ou unité non reconnue" : "";
          out.setAttribute("data-bad", q.input.value.trim() ? "true" : "false");
          ins.disabled = true;
          return;
        }
        const list = targetsFor(qty.unit);
        to.input.textContent = "";
        for (const u of list) to.input.appendChild(el(doc, "option", { value: u, text: u }));
        to.input.value = list.indexOf(prev) >= 0 ? prev : list[0];
        const r = Eng.convert(qty.value, qty.unit, to.input.value);
        out.textContent = r.ok ? qty.value + " " + qty.unit + " ≈ " + r.value + " " + r.from.replace(qty.unit, to.input.value) : r.message;
        if (r.ok) out.textContent = qty.value + " " + qty.unit + " ≈ " + r.value + " " + to.input.value;
        out.setAttribute("data-bad", r.ok ? "false" : "true");
        ins.disabled = !r.ok;
      };
      q.input.addEventListener("input", () => {
        origin = null; // typed text is no longer "the selection"
        refresh();
      });
      to.input.addEventListener("change", refresh);
      ins.addEventListener("click", () => {
        const qty = Eng.parseQuantity(q.input.value);
        if (!qty) return say("Valeur ou unité non reconnue", true);
        const r = Eng.convert(qty.value, qty.unit, to.input.value);
        if (!r.ok) return say(r.message, true);
        const text = " ≈ " + r.value + " " + to.input.value;
        // selection used as-is: the result goes right AFTER it (never replaces it); typed input: whole statement at the caret
        const ok = origin !== null ? insertTextAt(b, b.end, text, origin) : insertTextAt(b, b.end, qty.value + " " + qty.unit + text, undefined);
        if (ok) closePanel(true);
      });
      S.body.append(q.wrap, to.wrap, out, note, row([ins]));
      refresh();
      q.input.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------ task extraction

    function toolTask() {
      const b = capture("task");
      if (!b) return;
      show("task", "Tâche");
      S.bound = b;
      S.rid = requestId();
      const e = host.editor.entry();
      const lines = e ? host.editor.lines(e) : [];
      const text = selectedText(b);
      const s = Rich.locate(lines, b.start);
      const t = Rich.locate(lines, b.end);
      const single = b.end > b.start && s.line === t.line && lines[s.line] && !Rich.isAtom(lines[s.line]);
      if (!single || !text.trim()) {
        S.body.appendChild(el(doc, "p", { class: "hint", text: MSG.taskNeedSel }));
        return;
      }
      b.blockId = lines[s.line].id;
      b.off = { start: s.off, end: t.off };
      b.text = text;
      const title = field("Titre de la tâche", "hq-carnet-eng-t-title", { maxlength: "120" });
      title.input.value = Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim()).slice(0, 120).join("");
      const ins = button("btn-carnet-eng-task", "Créer la tâche");
      S.body.append(
        el(doc, "p", { class: "carnet-eng-out", id: "hq-carnet-eng-t-src", text: "« " + (text.length > 160 ? text.slice(0, 160) + "…" : text) + " »" }),
        title.wrap,
        el(doc, "p", { class: "hint carnet-eng-note", text: "Ajoutée au tableau « À faire » existant. Le texte de la note reste inchangé ; aucun lien retour n'est enregistré." }),
        row([ins])
      );
      ins.addEventListener("click", async () => {
        if (S.busy) return; // double click / double tap: one request only
        const e2 = host.editor.entry();
        if (!e2 || !still(b)) return staleOut();
        if (e2.generation !== e2.savedGeneration || e2.inflight) return say(MSG.taskDirty, true);
        if (!Rich.isRealId(b.blockId)) return say(MSG.taskUnsaved, true);
        const name = title.input.value.trim();
        if (!name) return say("Titre requis", true);
        S.busy = true;
        ins.disabled = true;
        say("Création…", false);
        const token = S.token;
        try {
          const res = await host.api.post({
            action: "task_extract", page_id: b.pageId, expected_rev: e2.serverRev, block_id: b.blockId,
            start: b.off.start, end: b.off.end, text: b.text, title: name, request_id: S.rid,
          });
          host.flash(res && res.duplicate ? MSG.taskDup : MSG.taskDone);
          if (token === S.token) closePanel(true);
        } catch (err) {
          const code = err && err.data && err.data.code;
          const msg = code === "stale_selection" || code === "revision_conflict" ? MSG.taskStale : code === "tasks_unavailable" ? MSG.taskDown : (err && err.message) || MSG.taskDown;
          if (token === S.token) {
            say(msg, true);
            S.busy = false;
            ins.disabled = false;
          } else host.flash(msg);
        }
      });
    }

    // ------------------------------------------------------------ HQ links

    async function listTargets(kind) {
      const out = [];
      if (kind === "note") {
        for (const n of host.notes()) out.push({ value: n.id, label: n.title || "Page sans titre" });
      } else if (kind === "project") {
        for (const p of host.projects()) out.push({ value: p.id, label: p.name + (p.archived ? " (archivé)" : "") });
      } else if (kind === "media" || kind === "model") {
        const d = await host.api.get("/api/media/library");
        for (const it of (d && d.items) || []) {
          const k = it && typeof it.rel === "string" && Rich.checkRef({ kind: "model", id: it.rel }) ? "model" : "media";
          if (it && typeof it.rel === "string" && Rich.checkRef({ kind: k, id: it.rel })) out.push({ value: it.rel, label: it.rel, refKind: k });
        }
      } else if (kind === "drawing") {
        const d = await host.api.get("/api/drawings");
        for (const it of (d && (d.items || d.drawings)) || []) if (it && Rich.checkRef({ kind: "drawing", id: it.stem })) out.push({ value: it.stem, label: it.stem });
      } else if (kind === "file") {
        const d = await host.api.get("/api/files");
        for (const it of (d && d.files) || []) if (it && typeof it.rel === "string" && Rich.checkRef({ kind: "file", id: it.rel })) out.push({ value: it.rel, label: it.rel });
      } else if (kind === "source") {
        const d = await host.api.get("/api/carnet?sources=1");
        for (const it of (d && d.editions) || []) if (it && !it.archived && Eng.linkShape({ kind: "source", id: it.id })) out.push({ value: it.id, label: String(it.title || it.id).slice(0, 80) });
      }
      return out.slice(0, 300);
    }

    function toolLink(preset) {
      const b = capture("link");
      if (!b) return;
      show("link", "Lien HQ");
      S.bound = b;
      if (b.end <= b.start) {
        S.body.appendChild(el(doc, "p", { class: "hint", text: MSG.linkNeedSel }));
        return;
      }
      const kind = select("Type", "hq-carnet-eng-l-kind", LINK_KINDS_UI, LINK_KINDS_UI.some((k) => k[0] === preset) ? preset : "note");
      const target = select("Cible", "hq-carnet-eng-l-target", [["", "—"]], "");
      const ins = button("btn-carnet-eng-link", "Lier");
      ins.disabled = true;
      const token = S.token;
      const load = async () => {
        target.input.textContent = "";
        target.input.appendChild(el(doc, "option", { value: "", text: "Chargement…" }));
        ins.disabled = true;
        let items = [];
        try {
          items = await listTargets(kind.input.value);
        } catch (_) {
          items = [];
          say(MSG.unavailable, true);
        }
        if (token !== S.token) return;
        target.input.textContent = "";
        target.input.appendChild(el(doc, "option", { value: "", text: items.length ? "— choisir —" : MSG.nothing }));
        S.linkItems = new Map();
        for (const it of items) {
          S.linkItems.set(it.value, it);
          target.input.appendChild(el(doc, "option", { value: it.value, text: it.label }));
        }
      };
      kind.input.addEventListener("change", () => {
        say("");
        load();
      });
      target.input.addEventListener("change", () => {
        ins.disabled = !target.input.value;
      });
      ins.addEventListener("click", () => {
        const e = host.editor.entry();
        if (!e || !still(b)) return staleOut();
        const picked = S.linkItems && S.linkItems.get(target.input.value);
        const refKind = picked && picked.refKind ? picked.refKind : kind.input.value === "media" ? "media" : kind.input.value;
        const ref = Rich.checkRef({ kind: refKind, id: target.input.value });
        if (!ref) return say("Référence invalide", true);
        const next = Rich.setLink(host.editor.lines(e), b.start, b.end, { ref });
        if (!next) return say("Lien impossible ici", true);
        if (host.editor.commit(next, { start: b.start, end: b.end })) closePanel(true);
        else say(MSG.refused, true);
      });
      S.body.append(kind.wrap, target.wrap, row([ins]));
      load();
    }

    /**
     * Open a stored HQ reference through the EXISTING navigation. Missing / moved targets fail safe with a message.
     * Notes and projects are local to Carnet; Lecteur uses hqPlayerOpen; a drawing only switches to Dessiner
     * (the existing UI cannot open one exact drawing) and names the stem.
     */
    async function openRef(kind, id) {
      const ref = Rich.checkRef({ kind, id });
      if (!ref) {
        host.flash(MSG.missing);
        return false;
      }
      try {
        if (kind === "note") {
          if (host.openNote(id)) return true;
          host.flash(MSG.missing);
          return false;
        }
        if (kind === "project") {
          if (host.projects().some((p) => p.id === id)) {
            host.openProject(id);
            return true;
          }
          host.flash(MSG.missing);
          return false;
        }
        if (kind === "drawing") {
          const d = await host.api.get("/api/drawings");
          const list = (d && (d.items || d.drawings)) || [];
          if (!list.some((it) => it && it.stem === id)) {
            host.flash(MSG.missing);
            return false;
          }
          host.setView("dessiner");
          host.flash("Dessin « " + id + " » — ouvre-le depuis Dessiner");
          return true;
        }
        const parts = id.split("/");
        const base = parts.pop();
        const d = await host.api.get("/api/files?folder=" + encodeURIComponent(parts.join("/")) + "&q=" + encodeURIComponent(base));
        const found = ((d && d.files) || []).some((it) => it && it.rel === id);
        if (!found) {
          host.flash(MSG.missing);
          return false;
        }
        if ((kind === "media" || kind === "model") && typeof host.playerOpen === "function") {
          host.playerOpen(id);
          return true;
        }
        host.openFile(id);
        return true;
      } catch (_) {
        host.flash(MSG.unavailable);
        return false;
      }
    }

    // ------------------------------------------------------------ atoms / decisions already in the page

    function openAtomByIndex(idx) {
      const e = host.editor.entry();
      if (!e) return false;
      const lines = host.editor.lines(e);
      const l = lines[idx];
      if (!l || !Rich.isAtom(l) || !l.eng || l.type === "image") return false;
      const sel = host.editor.sel();
      const b = { kind: l.type, pageId: e.id, gen: e.generation, sig: sigOf(e), start: sel.start, end: sel.end, rev: e.serverRev, blockId: l.id, type: l.type, payloadJson: JSON.stringify(l.eng) };
      if (!Rich.isRealId(l.id) && !Rich.isTmpId(l.id)) return false;
      if (l.type === "calc") openCalcAtom(b, l.eng);
      else openMeasureAtom(b, l.eng);
      return true;
    }

    function openAtom(lineEl) {
      const idx = Array.prototype.indexOf.call(host.editorEl().children, lineEl);
      return idx >= 0 && openAtomByIndex(idx);
    }

    /** Backspace/Delete next to a calculation/measurement OPENS it (a second, deliberate action deletes): no accidental loss. */
    function keyAdjacent(ev) {
      const sel = host.editor.sel();
      if (!sel || sel.start !== sel.end) return false;
      const e = host.editor.entry();
      if (!e) return false;
      const lines = host.editor.lines(e);
      const at = Rich.locate(lines, sel.start);
      const back = ev.inputType === "deleteContentBackward";
      const fwd = ev.inputType === "deleteContentForward";
      let target = -1;
      const isEngAtom = (l) => !!l && Rich.isEngAtom(l);
      if (back && at.off === 0 && at.line > 0 && isEngAtom(lines[at.line - 1])) target = at.line - 1;
      else if (fwd && at.off === lines[at.line].text.length && at.line + 1 < lines.length && isEngAtom(lines[at.line + 1])) target = at.line + 1;
      if (target < 0) return false;
      ev.preventDefault();
      return openAtomByIndex(target);
    }

    function onPageChange(pageId) {
      if (S.bound && S.bound.pageId !== pageId) closePanel(false);
    }

    return {
      openMenu, openTool, openAtom, openAtomByIndex, keyAdjacent, openRef, onPageChange,
      close: closePanel,
      isOpen: () => !!S.panel && !S.panel.hidden,
      state: S,
    };
  }

  return { mount, MSG, MENU };
});
