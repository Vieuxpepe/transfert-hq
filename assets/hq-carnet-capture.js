/* Transfert HQ — Quick Capture (product phase 1).
 *
 * A globally reachable HQ entry that drops a note / photo / measurement / decision into the Carnet in a few taps. It is NOT another
 * note store, editor or draft system: a capture is an ORDINARY Carnet page created through the existing endpoints —
 *   photo      -> the accepted Stage-06 pipeline (HqCarnetMedia.prepare + upload to /api/carnet/asset), no new upload route;
 *   the page   -> ONE existing `page_create` request that carries the page's content (server-validated, atomic: a refusal creates no page).
 * Defaults to "À classer" (no project, no category); project / category are optional. Nothing is stored in the browser and nothing is put
 * in a URL: closing the sheet drops the capture. Auth / CSRF are the page's own `api()` (same-origin cookie, browser-sent Origin).
 *
 * Two layers: a PURE builder (`buildCapture`, `measureFrom`, `decimal` … Node-testable) and the DOM sheet (`mount`).
 *
 * Plain ES2020, no build step, no HTML-string sinks, no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetCapture = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const MODES = [
    ["text", "Texte"],
    ["photo", "Photo"],
    ["measure", "Mesure"],
    ["decision", "Décision"],
  ];
  const TEXT_BYTES_MAX = 40 * 1024; // below the server's 48 KiB page limit: the server remains the authority
  const LINE_MAX = 4000;
  const DECISION_MAX = 400;
  const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

  const MSG = {
    empty: "Écris quelque chose avant d'enregistrer",
    tooLong: "Texte trop long pour une capture : utilise une page du carnet",
    noPhoto: "Choisis ou prends une photo",
    noLabel: "Donne un nom à la mesure",
    badValue: "Valeur invalide (exemple : 12,5)",
    badTol: "Tolérance invalide (valeur positive, avec une valeur nominale)",
    noDecision: "Écris la décision",
    invalid: "Capture invalide : rien n'a été créé",
    staleProject: "Ce projet n'existe plus ou est archivé : choisis à nouveau",
    staleCategory: "Cette catégorie n'existe plus : choisis à nouveau",
    stale: "Le carnet a changé : réessaie",
    offline: "Hors ligne : rien n'a été créé. Réessaie.",
    saved: "Capturé dans",
    unfiled: "À classer",
    abandon: "Appuie encore pour abandonner la capture",
  };

  // ------------------------------------------------------------------ pure builder

  function two(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** "2026-10-01 12:30" — local, unambiguous. */
  function stamp(now) {
    const d = now instanceof Date ? now : new Date();
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  /** Normalise newlines and strip control characters WITHOUT truncating (size limits are validated on the whole value). */
  function norm(text) {
    return String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(CTRL, " ");
  }

  /** Truncating variant: ONLY for single-value fields whose input already has a hard maxlength (caption, decision, label). */
  function clean(text, max) {
    return norm(text).slice(0, max == null ? LINE_MAX : max);
  }

  function utf8(text) {
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  }

  /** A French-keyboard decimal ("12,5", " 3 ", "+4") as the strict canonical string the engineering schema wants, or null. */
  function decimal(raw) {
    const t = String(raw == null ? "" : raw).trim().replace(/[   ]/g, "").replace(",", ".").replace(/^\+/, "");
    return /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(t) ? t : null;
  }

  /**
   * The measurement payload for the quick form, validated by the SAME checker as the engineering tool (Eng.checkPayload).
   * f = {label, value, unit, nominal, tol}: value required; tolerance only with a nominal (symmetric ±, same unit).
   * Returns {payload} or {error, field}.
   */
  function measureFrom(Eng, f, atSec) {
    const label = String(f.label == null ? "" : f.label).trim();
    if (!label) return { error: MSG.noLabel, field: "label" };
    const v = decimal(f.value);
    if (v === null) return { error: MSG.badValue, field: "value" };
    const unit = typeof f.unit === "string" ? f.unit : "";
    const hasNominal = String(f.nominal == null ? "" : f.nominal).trim() !== "";
    const hasTol = String(f.tol == null ? "" : f.tol).trim() !== "";
    let nominal = null;
    let tol = null;
    let mode = "none";
    if (hasNominal) {
      const n = decimal(f.nominal);
      if (n === null) return { error: MSG.badValue, field: "nominal" };
      nominal = { v: n, u: unit };
    }
    if (hasTol) {
      const t = decimal(f.tol);
      if (t === null || t.charAt(0) === "-" || !nominal) return { error: MSG.badTol, field: "tol" };
      mode = "sym";
      tol = { t, u: unit };
    }
    const payload = Eng.checkPayload("measure", { label, observed: { v, u: unit }, mode, nominal, tol, at: atSec, link: null }, null);
    return payload ? { payload } : { error: MSG.badValue, field: "value" };
  }

  /**
   * The ordinary lines of a capture. Rich = HqCarnetRich. input = {mode, text, asset, caption, measure:{...}}.
   * Always {lines} (never a partial result) or {error, field}. Every line has id = null: the server assigns the block ids.
   */
  function buildCapture(Rich, input, now) {
    const when = now instanceof Date ? now : new Date();
    const atSec = Math.floor(when.getTime() / 1000);
    const L = (text, type) => Rich.newLine(text, type || "paragraph", false, [], null);
    const tail = () => L("", "paragraph"); // somewhere to keep typing after an atom
    const mode = input && input.mode;
    if (mode === "text") {
      const body = norm(input.text).split("\n").map((x) => x.replace(/\s+$/, ""));
      while (body.length && !body[body.length - 1]) body.pop();
      while (body.length && !body[0]) body.shift();
      if (!body.length) return { error: MSG.empty, field: "text" };
      if (utf8(body.join("\n")) > TEXT_BYTES_MAX || body.length > Math.min(Rich.BLOCKS_MAX, 1000) || body.some((x) => x.length > LINE_MAX)) return { error: MSG.tooLong, field: "text" };
      return { lines: body.map((x) => L(x)) };
    }
    if (mode === "photo") {
      const asset = input.asset;
      if (!asset) return { error: MSG.noPhoto, field: "photo" };
      const caption = Rich.cleanCaptionText(clean(input.caption, 300)).trim();
      const img = Rich.imageLine({ id: asset.id, mime: asset.mime, w: asset.w, h: asset.h, width: 100, layout: "inline", caption });
      if (!img) return { error: MSG.invalid, field: "photo" };
      return { lines: [L("Photo — " + stamp(when)), img, tail()] };
    }
    if (mode === "measure") {
      const m = measureFrom(Rich.Eng, input.measure || {}, atSec);
      if (m.error) return m;
      const line = Rich.engLine("measure", m.payload);
      if (!line) return { error: MSG.invalid, field: "value" };
      return { lines: [L("Mesure — " + String(input.measure.label).trim().slice(0, 80)), line, tail()] };
    }
    if (mode === "decision") {
      const text = clean(input.text, DECISION_MAX).replace(/\n+/g, " ").trim();
      if (!text) return { error: MSG.noDecision, field: "text" };
      const line = Rich.decisionLine(text, atSec);
      if (!line) return { error: MSG.invalid, field: "text" };
      return { lines: [line, tail()] };
    }
    return { error: MSG.invalid };
  }

  /** The wire content of built lines (V2, no ids). */
  function contentOf(Rich, lines) {
    return Rich.wireContent(lines, null, null);
  }

  /** Is the chosen project / category still assignable per the freshly read notebook? Returns an error message or "". */
  function staleSelection(meta, projectId, categoryId) {
    if (projectId) {
      const p = (meta.projects || []).find((x) => x && x.id === projectId);
      if (!p || p.archived) return MSG.staleProject;
    }
    if (categoryId && !(meta.categories || []).some((x) => x && x.id === categoryId)) return MSG.staleCategory;
    return "";
  }

  // ------------------------------------------------------------------ DOM sheet

  function mount(env) {
    const doc = env.doc;
    const win = env.win;
    const Rich = env.Rich;
    const Media = env.Media;
    const callApi = env.api;
    const S = { open: false, mode: "text", busy: false, asset: null, file: null, previewUrl: "", armed: false, attempt: null, armTimer: 0, from: null, meta: null, toastTimer: 0 };

    function el(tag, attrs, kids) {
      const n = doc.createElement(tag);
      for (const k of Object.keys(attrs || {})) {
        if (k === "text") n.textContent = attrs[k];
        else if (attrs[k] === true) n.setAttribute(k, "");
        else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, String(attrs[k]));
      }
      for (const c of kids || []) n.appendChild(c);
      return n;
    }
    function svg(d) {
      const ns = "http://www.w3.org/2000/svg";
      const s = doc.createElementNS(ns, "svg");
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("aria-hidden", "true");
      s.setAttribute("focusable", "false");
      const p = doc.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      s.appendChild(p);
      return s;
    }
    function field(label, id, input, hint) {
      return el("label", { class: "hq-capture-field", for: id }, [el("span", { class: "hq-capture-label", text: label }), input].concat(hint ? [el("span", { class: "hq-capture-hint", text: hint })] : []));
    }
    function inputEl(id, attrs) {
      return el("input", Object.assign({ id, class: "hq-capture-input", type: "text", autocomplete: "off", spellcheck: "false" }, attrs || {}));
    }

    // -- the launcher
    const fab = el("button", { type: "button", id: "hq-capture-fab", class: "hq-capture-fab", "aria-haspopup": "dialog", "aria-label": "Capture rapide", title: "Capture rapide" }, [
      svg("M12 5v14M5 12h14"),
      el("span", { class: "hq-capture-fab-text", text: "Capturer" }),
    ]);

    // -- the sheet
    const title = el("h2", { id: "hq-capture-title", class: "hq-capture-title", text: "Capture rapide" });
    const closeBtn = el("button", { type: "button", id: "hq-capture-close", class: "hq-capture-close", "aria-label": "Fermer" }, [svg("M6 6l12 12M18 6L6 18")]);
    const modes = el("div", { class: "hq-capture-modes", role: "group", "aria-label": "Type de capture" });
    for (const [key, label] of MODES) {
      modes.appendChild(el("button", { type: "button", class: "hq-capture-mode", "data-capture-mode": key, "aria-pressed": key === "text" ? "true" : "false", text: label }));
    }

    const text = el("textarea", { id: "hq-capture-text", class: "hq-capture-input hq-capture-textarea", rows: "4", placeholder: "Écris ta note…", autocomplete: "off", enterkeyhint: "enter" });
    const paneText = el("div", { class: "hq-capture-pane", "data-capture-pane": "text" }, [field("Note", "hq-capture-text", text)]);

    const takeInput = el("input", { type: "file", class: "hq-capture-file", accept: "image/*", capture: "environment", tabindex: "-1", "aria-hidden": "true", "data-capture-input": "camera" });
    const pickInput = el("input", { type: "file", class: "hq-capture-file", accept: Media ? Media.ACCEPT : "image/jpeg,image/png,image/webp", tabindex: "-1", "aria-hidden": "true", "data-capture-input": "photos" });
    const takeBtn = el("button", { type: "button", id: "hq-capture-take", class: "hq-capture-big", text: "Prendre une photo" });
    const pickBtn = el("button", { type: "button", id: "hq-capture-pick", class: "hq-capture-big hq-capture-quiet", text: "Choisir une image" });
    const preview = el("img", { class: "hq-capture-preview", alt: "Aperçu de la photo", hidden: true });
    const caption = inputEl("hq-capture-caption", { maxlength: "300", placeholder: "Légende (facultatif)" });
    const paneModes = {
      photo: el("div", { class: "hq-capture-pane", "data-capture-pane": "photo", hidden: true }, [
        el("div", { class: "hq-capture-bigrow" }, [takeBtn, pickBtn]),
        preview, takeInput, pickInput,
        field("Légende", "hq-capture-caption", caption),
      ]),
    };
    const mLabel = inputEl("hq-capture-m-label", { maxlength: "80", placeholder: "Ex. Jeu axial" });
    const mValue = inputEl("hq-capture-m-value", { inputmode: "decimal", placeholder: "12,5" });
    const mUnit = el("select", { id: "hq-capture-m-unit", class: "hq-capture-input" }, [el("option", { value: "", text: "sans unité" })].concat((env.Eng ? env.Eng.UNITS : []).map((u) => el("option", { value: u, text: u }))));
    const mNominal = inputEl("hq-capture-m-nominal", { inputmode: "decimal", placeholder: "facultatif" });
    const mTol = inputEl("hq-capture-m-tol", { inputmode: "decimal", placeholder: "facultatif" });
    paneModes.measure = el("div", { class: "hq-capture-pane", "data-capture-pane": "measure", hidden: true }, [
      field("Mesure", "hq-capture-m-label", mLabel),
      el("div", { class: "hq-capture-row" }, [field("Valeur", "hq-capture-m-value", mValue), field("Unité", "hq-capture-m-unit", mUnit)]),
      el("div", { class: "hq-capture-row" }, [field("Nominal", "hq-capture-m-nominal", mNominal), field("± Tolérance", "hq-capture-m-tol", mTol)]),
    ]);
    const dText = inputEl("hq-capture-d-text", { maxlength: String(DECISION_MAX), placeholder: "Ex. On garde l'ajustement H7/g6", enterkeyhint: "done" });
    paneModes.decision = el("div", { class: "hq-capture-pane", "data-capture-pane": "decision", hidden: true }, [field("Décision", "hq-capture-d-text", dText)]);

    const projectSel = el("select", { id: "hq-capture-project", class: "hq-capture-input" });
    const categorySel = el("select", { id: "hq-capture-category", class: "hq-capture-input" });
    const where = el("div", { class: "hq-capture-where", role: "group", "aria-label": "Classement" }, [
      el("span", { class: "hq-capture-label", text: "Classement" }),
      el("div", { class: "hq-capture-row" }, [field("Projet", "hq-capture-project", projectSel), field("Catégorie", "hq-capture-category", categorySel)]),
    ]);
    const msg = el("p", { id: "hq-capture-msg", class: "hq-capture-msg", role: "status", "aria-live": "polite" });
    const saveBtn = el("button", { type: "button", id: "hq-capture-save", class: "hq-capture-save" }, [el("span", { text: "Enregistrer" }), el("kbd", { class: "hq-capture-kbd", "aria-hidden": "true", text: "Ctrl+Entrée" })]);
    const panes = el("div", { class: "hq-capture-panes" }, [paneText, paneModes.photo, paneModes.measure, paneModes.decision]);
    const box = el("div", { id: "hq-capture", class: "hq-capture", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-capture-title", hidden: true }, [
      el("div", { class: "hq-capture-head" }, [title, closeBtn]),
      modes, panes, where, msg, el("div", { class: "hq-capture-actions" }, [saveBtn]),
    ]);
    const back = el("div", { class: "hq-capture-backdrop", "aria-hidden": "true", hidden: true });
    const toastText = el("span", { class: "hq-capture-toast-text" });
    const openBtn = el("button", { type: "button", class: "hq-capture-toast-open", text: "Ouvrir" });
    const toast = el("div", { id: "hq-capture-toast", class: "hq-capture-toast", role: "status", "aria-live": "polite", hidden: true }, [toastText, openBtn]);
    doc.body.append(fab, back, box, toast);

    // ---- state helpers
    const say = (t, err) => {
      msg.textContent = t || "";
      msg.setAttribute("data-bad", err ? "true" : "false");
    };

    function inputs() {
      return Array.prototype.slice.call(box.querySelectorAll("input:not([type=file]), textarea, select, button"));
    }

    function setBusy(b) {
      S.busy = b;
      box.setAttribute("aria-busy", b ? "true" : "false");
      for (const n of inputs()) if (n !== closeBtn) n.disabled = b;
      saveBtn.firstChild.textContent = b ? "Enregistrement…" : "Enregistrer";
    }

    function dirty() {
      return !!(text.value.trim() || S.file || S.asset || caption.value.trim() || mLabel.value.trim() || mValue.value.trim() || mNominal.value.trim() || mTol.value.trim() || dText.value.trim());
    }

    function setMode(mode) {
      S.mode = mode;
      for (const b of modes.querySelectorAll("[data-capture-mode]")) b.setAttribute("aria-pressed", b.getAttribute("data-capture-mode") === mode ? "true" : "false");
      for (const k of Object.keys(paneModes)) paneModes[k].hidden = k !== mode;
      paneText.hidden = mode !== "text";
      say("");
      focusMode();
    }

    function focusMode() {
      const target = S.mode === "text" ? text : S.mode === "photo" ? takeBtn : S.mode === "measure" ? mLabel : dText;
      if (target) target.focus({ preventScroll: true });
    }

    function clearPreview() {
      if (S.previewUrl) {
        try {
          win.URL.revokeObjectURL(S.previewUrl);
        } catch (_) {}
      }
      S.previewUrl = "";
      preview.hidden = true;
      preview.removeAttribute("src");
    }

    function reset() {
      text.value = "";
      caption.value = "";
      mLabel.value = mValue.value = mNominal.value = mTol.value = dText.value = "";
      mUnit.value = "";
      S.file = null;
      S.asset = null;
      S.attempt = null;
      clearPreview();
      S.armed = false;
      win.clearTimeout(S.armTimer);
    }

    function fillSelects(meta) {
      const keepP = projectSel.value;
      const keepC = categorySel.value;
      projectSel.textContent = "";
      categorySel.textContent = "";
      projectSel.appendChild(el("option", { value: "", text: MSG.unfiled }));
      categorySel.appendChild(el("option", { value: "", text: "Aucune" }));
      for (const p of meta.projects || []) if (p && !p.archived) projectSel.appendChild(el("option", { value: p.id, text: String(p.name || "") }));
      for (const c of meta.categories || []) if (c) categorySel.appendChild(el("option", { value: c.id, text: String(c.name || "") }));
      projectSel.value = Array.prototype.some.call(projectSel.options, (o) => o.value === keepP) ? keepP : "";
      categorySel.value = Array.prototype.some.call(categorySel.options, (o) => o.value === keepC) ? keepC : "";
    }

    async function fetchMeta() {
      const m = await callApi("/api/carnet?meta=1", { timeoutMs: 12000 });
      if (!m || !Number.isInteger(m.notebook_rev) || !Array.isArray(m.pages)) throw new Error("Réponse carnet invalide");
      S.meta = m;
      return m;
    }

    // ---- open / close
    function open() {
      if (S.open) return;
      S.open = true;
      S.from = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : fab;
      setBusy(false);
      say("");
      back.hidden = false;
      box.hidden = false;
      doc.body.classList.add("hq-capture-open");
      fab.setAttribute("aria-expanded", "true");
      fillSelects({ projects: [], categories: [] });
      setMode(S.mode);
      // the organisation lists are read fresh on every open (never cached across opens)
      fetchMeta().then((m) => {
        if (S.open) fillSelects(m);
      }, () => {
        if (S.open) say("Projets et catégories indisponibles : la capture ira dans À classer", true);
      });
    }

    function close(force) {
      if (!S.open || (S.busy && !force)) return;
      if (!force && dirty() && !S.armed) {
        S.armed = true;
        say(MSG.abandon, true);
        win.clearTimeout(S.armTimer);
        S.armTimer = win.setTimeout(() => {
          S.armed = false;
          if (S.open && msg.textContent === MSG.abandon) say("");
        }, 4000);
        return;
      }
      S.open = false;
      box.hidden = true;
      back.hidden = true;
      doc.body.classList.remove("hq-capture-open");
      fab.setAttribute("aria-expanded", "false");
      reset();
      const from = S.from;
      S.from = null;
      if (from && from.isConnected && typeof from.focus === "function") from.focus({ preventScroll: true });
    }

    // ---- photo
    function chosen(input) {
      const f = input.files && input.files[0];
      input.value = "";
      if (!f) return;
      S.file = f;
      S.asset = null; // a new picture is a new upload
      clearPreview();
      try {
        S.previewUrl = win.URL.createObjectURL(f);
        preview.src = S.previewUrl;
        preview.hidden = false;
      } catch (_) {
        preview.hidden = true;
      }
      say("Photo prête");
      saveBtn.focus({ preventScroll: true });
    }
    takeBtn.addEventListener("click", () => takeInput.click());
    pickBtn.addEventListener("click", () => pickInput.click());
    takeInput.addEventListener("change", () => chosen(takeInput));
    pickInput.addEventListener("change", () => chosen(pickInput));

    // ---- submit
    function selection() {
      return { project: projectSel.value || null, category: categorySel.value || null };
    }

    function inputFor() {
      return {
        mode: S.mode,
        text: S.mode === "decision" ? dText.value : text.value,
        caption: caption.value,
        asset: S.asset,
        measure: { label: mLabel.value, value: mValue.value, unit: mUnit.value, nominal: mNominal.value, tol: mTol.value },
      };
    }

    function focusField(name) {
      const t = { text: S.mode === "decision" ? dText : text, photo: takeBtn, label: mLabel, value: mValue, nominal: mNominal, tol: mTol }[name];
      if (t) t.focus({ preventScroll: true });
    }

    async function create(content, sel, requestId) {
      let attempt = 0;
      for (;;) {
        const meta = await fetchMeta();
        const stale = staleSelection(meta, sel.project, sel.category);
        if (stale) {
          fillSelects(meta);
          const err = new Error(stale);
          err.local = true;
          throw err;
        }
        // request_id: the SAME id (and the same frozen content) is reused by every retry of this capture, so a lost response can
        // never produce a second page: the server returns the page it already created for that id.
        const body = { action: "page_create", expected_notebook_rev: meta.notebook_rev, content, request_id: requestId };
        if (sel.project) body.project_id = sel.project;
        if (sel.category) body.category_id = sel.category;
        try {
          const res = await callApi("/api/carnet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: 15000 });
          if (!res || !res.page || typeof res.page.id !== "string") throw new Error("Réponse carnet invalide");
          return res.page.id;
        } catch (err) {
          const status = err && Number.isInteger(err.status) ? err.status : 0;
          const data = err && err.data && typeof err.data === "object" ? err.data : null;
          if (status === 409 && data && data.code === "notebook_revision_conflict" && attempt === 0) {
            attempt += 1; // the notebook moved between the read and the write: one fresh read, one retry
            continue;
          }
          if (status === 409 && data && data.code === "request_result_gone") S.attempt = null; // it WAS created and then deleted: only an explicit new Save may create again
          if (!status || status >= 500) {
            // The outcome is unknown (the request may or may not have been applied). Nothing is guessed: the capture stays in the
            // sheet, and pressing Save again re-sends the SAME request_id, which the server answers with the original page.
            const e2 = new Error(MSG.offline);
            e2.local = true;
            throw e2;
          }
          throw err;
        }
      }
    }

    function newRequestId() {
      const a = new Uint8Array(12);
      if (win.crypto && win.crypto.getRandomValues) win.crypto.getRandomValues(a);
      else for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(Math.random() * 256);
      let h = "cap-";
      for (const b of a) h += (b < 16 ? "0" : "") + b.toString(16);
      return h;
    }

    async function submit() {
      if (S.busy || !S.open) return;
      say("");
      // 1. the pure builder validates what can be validated without the network (photo: after the upload)
      if (S.mode === "photo") {
        if (!S.file && !S.asset) {
          say(MSG.noPhoto, true);
          return focusField("photo");
        }
      } else {
        const probe = buildCapture(Rich, inputFor(), new Date());
        if (probe.error) {
          say(probe.error, true);
          return focusField(probe.field);
        }
      }
      const sel = selection();
      setBusy(true);
      try {
        if (S.mode === "photo" && !S.asset) {
          if (!Media) throw Object.assign(new Error("Images indisponibles"), { local: true });
          say("Préparation de la photo…");
          const prepared = await Media.prepare(S.file);
          say("Envoi de la photo…");
          S.asset = await Media.upload(prepared.blob, callApi); // kept: a retry never uploads the same photo twice
        }
        // One attempt = one request_id + one frozen clock. Editing anything (text, photo, selection) starts a new attempt.
        const fp = JSON.stringify([inputFor(), sel]);
        if (!S.attempt || S.attempt.fp !== fp) S.attempt = { fp, requestId: newRequestId(), now: new Date() };
        const built = buildCapture(Rich, inputFor(), S.attempt.now);
        if (built.error) {
          say(built.error, true);
          setBusy(false);
          return focusField(built.field);
        }
        const id = await create(contentOf(Rich, built.lines), sel, S.attempt.requestId);
        done(id, sel);
      } catch (err) {
        setBusy(false);
        const m = err && err.local ? err.message : S.mode === "photo" && !S.asset && Media ? Media.describeError(err) : err && err.data && typeof err.data.error === "string" ? err.data.error : err && err.message ? String(err.message).slice(0, 160) : MSG.invalid;
        say(m, true);
      }
    }

    function done(id, sel) {
      const meta = S.meta || {};
      let where2 = MSG.unfiled;
      const p = sel.project && (meta.projects || []).find((x) => x.id === sel.project);
      const c = sel.category && (meta.categories || []).find((x) => x.id === sel.category);
      if (p || c) where2 = [p && p.name, c && c.name].filter(Boolean).join(" · ");
      setBusy(false);
      close(true);
      if (typeof env.refresh === "function") Promise.resolve(env.refresh()).catch(() => {});
      showToast(id, where2);
    }

    function showToast(id, where2) {
      toastText.textContent = MSG.saved + " " + where2;
      toast.hidden = false;
      toast.setAttribute("data-page-id", id);
      win.clearTimeout(S.toastTimer);
      S.toastTimer = win.setTimeout(() => {
        toast.hidden = true;
      }, 7000);
    }

    openBtn.addEventListener("click", () => {
      const id = toast.getAttribute("data-page-id");
      toast.hidden = true;
      win.clearTimeout(S.toastTimer);
      if (id && typeof env.openPage === "function") env.openPage(id);
    });

    // ---- wiring
    fab.addEventListener("click", open);
    closeBtn.addEventListener("click", () => close(false));
    back.addEventListener("click", () => close(false));
    saveBtn.addEventListener("click", submit);
    modes.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("[data-capture-mode]") : null;
      if (b && !S.busy) setMode(b.getAttribute("data-capture-mode"));
    });
    box.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // an IME confirming its text never submits
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      } else if (e.key === "Enter" && e.target && e.target.tagName === "INPUT" && e.target.type === "text") {
        e.preventDefault(); // single-line fields: Enter saves
        submit();
      } else if (e.key === "Tab") {
        const list = inputs().filter((n) => !n.disabled && n.offsetParent !== null && !n.closest("[hidden]"));
        if (!list.length) return;
        const at = list.indexOf(doc.activeElement);
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          list[list.length - 1].focus();
        } else if (!e.shiftKey && at === list.length - 1) {
          e.preventDefault();
          list[0].focus();
        }
      }
    });

    return { fab, box, open, close, submit, setMode, state: () => ({ open: S.open, mode: S.mode, busy: S.busy, asset: S.asset }) };
  }

  /** Boot: admins only (the Carnet API is admin-only). Silent when anything it needs is missing. */
  async function boot(win) {
    const doc = win.document;
    if (!doc || !doc.body || doc.getElementById("hq-capture-fab")) return null;
    const Rich = win.HqCarnetRich;
    if (!Rich || !Rich.Eng || typeof win.api !== "function") return null;
    try {
      const me = await win.api("/api/me", { timeoutMs: 8000 });
      if (!me || me.role !== "admin") return null;
    } catch (_) {
      return null;
    }
    if (doc.getElementById("hq-capture-fab")) return null;
    const h = mount({
      doc, win, Rich, Eng: Rich.Eng, Media: win.HqCarnetMedia || null, api: win.api,
      refresh: () => (typeof win.hqCarnetRefresh === "function" ? win.hqCarnetRefresh() : null),
      openPage: (id) => (typeof win.hqCarnetOpen === "function" ? win.hqCarnetOpen(id) : null),
    });
    win.hqCapture = h;
    return h;
  }

  const api = { MODES, MSG, TEXT_BYTES_MAX, stamp, decimal, measureFrom, buildCapture, contentOf, staleSelection, mount, boot };
  if (global && global.document && global.document.body !== undefined && !global.HQ_CAPTURE_MANUAL) {
    const go = () => {
      boot(global);
    };
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", go);
    else go();
  }
  return api;
});
