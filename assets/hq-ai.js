/* Transfert HQ — the assistant panel (hq_ai.py behind /api/ai).
 *
 * The sparkle button in the top bar (or Ctrl+J) opens a panel with two tabs:
 *  « Demander »  ask about your own things; the answer cites numbered sources that open the right page of HQ.
 *  « Noter »     one sentence becomes up to three proposed actions (event, task, project note, stock, Carnet note) shown
 *                as cards you tick; nothing is written before « Enregistrer ».
 * The API key never reaches the browser. Never builds HTML from strings. Plain ES2020; pure helpers exported for Node tests
 * (tests/check_hq_ai.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqAi = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ pure helpers

  /** Answer text -> paragraphs and bullet lists of runs, [n] turned into source references. */
  function parseAnswer(text, maxSource) {
    const blocks = [];
    let list = null;
    for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/, "").trimEnd();
      if (!line.trim()) {
        list = null;
        continue;
      }
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      const runs = runsOf(bullet ? bullet[1] : line.trim(), maxSource);
      if (bullet) {
        if (!list) {
          list = { type: "list", items: [] };
          blocks.push(list);
        }
        list.items.push(runs);
      } else {
        list = null;
        blocks.push({ type: "p", runs });
      }
    }
    return blocks;
  }

  function runsOf(text, maxSource) {
    const runs = [];
    const re = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > at) runs.push({ text: text.slice(at, m.index) });
      for (const n of m[1].split(",").map((x) => Number(x.trim()))) {
        if (n >= 1 && n <= (maxSource || 0)) runs.push({ ref: n });
      }
      at = re.lastIndex;
    }
    if (at < text.length) runs.push({ text: text.slice(at) });
    return runs;
  }

  /** Which page of HQ a source opens: {view, hash} (hash only when it points inside the page). */
  function target(href) {
    const h = String(href || "");
    if (!/^#[a-z]+(\/[A-Za-z0-9_-]+){0,3}$/.test(h)) return null;
    const view = h.slice(1).split("/")[0];
    return { view, hash: h.indexOf("/") > 0 ? h : "" };
  }

  const KIND = {
    event: ["Agenda", "M5 6h14v14H5zM5 10h14M9 4v4M15 4v4"],
    task: ["Tâche", "M5 12.5l4 4L19 7"],
    project_note: ["Où j'en suis", "M6 4h9l3 3v13H6zM9 11h6M9 15h4"],
    stock: ["Inventaire", "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"],
    note: ["Carnet", "M7 3.5h7l4 4V20H7zM14 3.5V8h4M9.5 12h5M9.5 15.5h5"],
  };

  const SUGGEST = ["Qu'est-ce que je dois faire cette semaine ?", "Où en sont mes projets ?", "Qu'est-ce qui manque dans l'inventaire ?", "Résume mes notes récentes"];
  const EXAMPLES = ["Labo GIA1077 jeudi 14h", "Acheté 20 vis M3, rangées dans le tiroir B2", "Bras robot : prochaine étape imprimer le support", "Idée : un support de téléphone pour le bureau"];

  const pure = { parseAnswer, runsOf, target, KIND };

  // ------------------------------------------------------------------ browser layer

  const S = { win: null, doc: null, back: null, panel: null, tab: "ask", thread: [], busy: false, status: null, deep: false, proposals: null, ret: null };
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, kids) {
    const n = S.doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else if (k === "on") for (const ev of Object.keys(v)) n.addEventListener(ev, v[ev]);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids || []) if (c) n.appendChild(typeof c === "string" ? S.doc.createTextNode(c) : c);
    return n;
  }

  function icon(d, cls) {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "ai-ico" + (cls ? " " + cls : ""));
    const p = S.doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.8");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }
  const SPARK = "M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z";
  const calm = () => {
    try {
      return S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  };

  async function call(url, body) {
    const opts = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: 90000 } : { timeoutMs: 15000 };
    if (typeof S.win.api === "function") return S.win.api(url, opts);
    const { timeoutMs: _t, ...rest } = opts;
    const r = await S.win.fetch(url, Object.assign({ credentials: "same-origin" }, rest));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((d && d.error) || "Erreur " + r.status);
      e.status = r.status;
      throw e;
    }
    return d;
  }

  // ---- panel

  function build() {
    const back = el("div", { class: "ai-back", hidden: true });
    const panel = el("section", { class: "ai-panel", role: "dialog", "aria-modal": "true", "aria-label": "Assistant" });
    const tabs = el("div", { class: "ai-tabs", role: "tablist" });
    for (const [k, label] of [["ask", "Demander"], ["note", "Noter"]]) {
      const b = el("button", { type: "button", class: "ai-tab", role: "tab", "data-tab": k, text: label, on: { click: () => setTab(k) } });
      tabs.appendChild(b);
    }
    tabs.appendChild(el("span", { class: "ai-tab-ink", "aria-hidden": "true" }));
    const head = el("header", { class: "ai-head" }, [
      el("span", { class: "ai-orb", "aria-hidden": "true" }, [icon(SPARK)]),
      el("strong", { class: "ai-title", text: "Assistant" }),
      tabs,
      el("button", { type: "button", class: "ai-x", "aria-label": "Fermer", on: { click: close } }, [icon("M6 6l12 12M18 6L6 18")]),
    ]);
    S.body = el("div", { class: "ai-body" });
    S.foot = el("footer", { class: "ai-foot" });
    panel.append(head, S.body, S.foot);
    back.appendChild(panel);
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) close();
    });
    S.doc.body.appendChild(back);
    S.back = back;
    S.panel = panel;
    S.tabs = tabs;
  }

  function open(tab) {
    if (!S.back) build();
    S.ret = S.doc.activeElement;
    S.back.hidden = false;
    S.back.classList.remove("is-out");
    void S.back.offsetWidth;
    S.back.classList.add("is-in");
    setTab(tab || S.tab, true);
    loadStatus();
  }

  function close() {
    if (!S.back || S.back.hidden) return;
    S.back.classList.remove("is-in");
    S.back.classList.add("is-out");
    S.win.setTimeout(() => {
      if (S.back.classList.contains("is-out")) S.back.hidden = true;
    }, calm() ? 0 : 220);
    if (S.ret && S.ret.focus) {
      try {
        S.ret.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  function setTab(k, first) {
    S.tab = k;
    for (const b of S.tabs.querySelectorAll(".ai-tab")) b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === k));
    const on = S.tabs.querySelector('.ai-tab[aria-selected="true"]');
    const ink = S.tabs.querySelector(".ai-tab-ink");
    if (on && ink) {
      S.win.requestAnimationFrame(() => {
        ink.style.width = on.offsetWidth + "px";
        ink.style.transform = "translateX(" + on.offsetLeft + "px)";
      });
    }
    if (k === "ask") paintAsk();
    else paintNote();
    if (!first && !calm() && typeof S.body.animate === "function") S.body.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
    const f = S.body.querySelector("textarea");
    if (f) S.win.setTimeout(() => f.focus({ preventScroll: true }), first ? 120 : 0);
  }

  async function loadStatus() {
    try {
      S.status = await call("/api/ai");
    } catch (_) {
      S.status = null;
    }
    paintFoot();
  }

  function paintFoot(lastModel) {
    const f = S.foot;
    if (!f) return;
    f.textContent = "";
    const st = S.status;
    if (st && !st.configured) {
      f.appendChild(el("p", { class: "ai-warn", text: "Aucune clé : ajoute « gemini_api_key » dans bridge_config.json puis redémarre le pont." }));
      return;
    }
    if (!st) return;
    const pick = (id) => (st.models || []).find((m) => m.id === id);
    const show = [pick(lastModel || "gemini-3.1-flash-lite"), pick("gemma-4-26b-a4b-it")].filter(Boolean);
    for (const m of show) {
      const pct = Math.min(100, Math.round((100 * m.used) / m.per_day));
      const meter = el("span", { class: "ai-meter", title: m.used + " / " + m.per_day + " aujourd'hui" }, [el("i")]);
      meter.firstChild.style.width = pct + "%";
      f.appendChild(el("span", { class: "ai-quota" }, [el("span", { text: m.label }), meter, el("span", { class: "ai-n", text: m.used + "/" + m.per_day })]));
    }
  }

  // ---- « Demander »

  function paintAsk() {
    const b = S.body;
    b.textContent = "";
    const list = el("div", { class: "ai-thread", role: "log", "aria-live": "polite" });
    if (!S.thread.length) {
      const chips = el("div", { class: "ai-suggest" });
      SUGGEST.forEach((q, i) => {
        const c = el("button", { type: "button", class: "ai-chip", text: q, on: { click: () => send(q) } });
        c.style.setProperty("--i", String(i));
        chips.appendChild(c);
      });
      list.append(el("div", { class: "ai-hello" }, [el("span", { class: "ai-orb is-big", "aria-hidden": "true" }, [icon(SPARK)]),
        el("p", { class: "ai-hello-t", text: "Pose une question sur tes notes, ton agenda, tes projets, ton inventaire ou tes fichiers." }), chips]));
    }
    for (const m of S.thread) list.appendChild(bubble(m));
    S.list = list;
    const ta = el("textarea", { class: "ai-input", rows: "1", placeholder: "Demande à HQ…", "aria-label": "Question", maxlength: "2000" });
    ta.addEventListener("input", () => grow(ta));
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send(ta.value);
      }
    });
    const deep = el("button", { type: "button", class: "ai-deep", "aria-pressed": String(S.deep), title: "Approfondir : un modèle plus fort (20 par jour)", on: { click: () => {
      S.deep = !S.deep;
      deep.setAttribute("aria-pressed", String(S.deep));
    } } }, [icon("M12 3v18M3 12h18", "is-small"), el("span", { text: "Approfondir" })]);
    const go = el("button", { type: "button", class: "ai-send", "aria-label": "Envoyer", on: { click: () => send(ta.value) } }, [icon("M5 12h14M13 6l6 6-6 6")]);
    S.input = ta;
    S.sendBtn = go;
    b.append(list, el("div", { class: "ai-compose" }, [ta, el("div", { class: "ai-compose-row" }, [deep, go])]));
    list.scrollTop = list.scrollHeight;
  }

  function grow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(160, ta.scrollHeight) + "px";
  }

  function bubble(m) {
    if (m.role === "user") return el("div", { class: "ai-msg is-user" }, [el("p", { text: m.text })]);
    if (m.pending) return el("div", { class: "ai-msg is-ai is-pending", "aria-label": "Réflexion…" }, [el("span", { class: "ai-dots" }, [el("i"), el("i"), el("i")])]);
    if (m.error) return el("div", { class: "ai-msg is-ai is-error" }, [el("p", { text: m.error })]);
    const box = el("div", { class: "ai-msg is-ai" });
    for (const blk of parseAnswer(m.text, (m.sources || []).length)) {
      if (blk.type === "p") box.appendChild(paintRuns(el("p"), blk.runs, m.sources));
      else {
        const ul = el("ul");
        for (const it of blk.items) ul.appendChild(paintRuns(el("li"), it, m.sources));
        box.appendChild(ul);
      }
    }
    const cited = (m.cited && m.cited.length ? m.cited : []).map((n) => m.sources[n - 1]).filter(Boolean);
    if (cited.length) {
      const row = el("div", { class: "ai-sources" });
      cited.slice(0, 6).forEach((s, i) => {
        const c = sourceChip(s, true);
        c.style.setProperty("--i", String(i));
        row.appendChild(c);
      });
      box.appendChild(row);
    }
    if (m.model_label) box.appendChild(el("p", { class: "ai-by", text: m.model_label }));
    return box;
  }

  function paintRuns(node, runs, sources) {
    for (const r of runs) {
      if (r.text) node.appendChild(S.doc.createTextNode(r.text));
      else if (r.ref && sources[r.ref - 1]) node.appendChild(sourceChip(sources[r.ref - 1], false));
    }
    return node;
  }

  function sourceChip(s, full) {
    const b = el("button", { type: "button", class: "ai-ref" + (full ? " is-full" : ""), title: s.label, on: { click: () => go(s) } }, [el("span", { class: "ai-ref-n", text: String(s.n) })]);
    if (full) b.appendChild(el("span", { class: "ai-ref-l", text: s.label }));
    return b;
  }

  function go(s) {
    if (s.kind === "file" && s.rel && typeof S.win.navigate === "function") {
      close();
      const parts = s.rel.split("/");
      parts.pop();
      S.win.navigate(parts.join("/"));
      return;
    }
    const t = target(s.href);
    if (!t) return;
    close();
    if (typeof S.win.setView === "function") S.win.setView(t.view);
    if (t.hash) {
      try {
        if (S.win.location.hash === t.hash) S.win.dispatchEvent(new S.win.HashChangeEvent("hashchange"));
        else S.win.location.hash = t.hash;
      } catch (_) {}
    }
  }

  async function send(text) {
    const q = String(text || "").trim();
    if (!q || S.busy) return;
    S.busy = true;
    const history = S.thread.filter((m) => !m.pending && !m.error).slice(-6).map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text }));
    S.thread.push({ role: "user", text: q });
    const wait = { role: "ai", pending: true };
    S.thread.push(wait);
    paintAsk();
    try {
      const out = await call("/api/ai", { action: "ask", q, history, deep: S.deep });
      Object.assign(wait, { pending: false, text: out.answer, sources: out.sources || [], cited: out.cited || [], model_label: out.model_label });
      paintFoot(out.model);
      loadStatus();
    } catch (e) {
      Object.assign(wait, { pending: false, error: (e && e.message) || "L'assistant n'a pas pu répondre" });
    } finally {
      S.busy = false;
      paintAsk();
      const last = S.list && S.list.lastElementChild;
      if (last && !calm() && typeof last.animate === "function") last.animate([{ opacity: 0, transform: "translateY(8px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  // ---- « Noter »

  function paintNote() {
    const b = S.body;
    b.textContent = "";
    const ta = el("textarea", { class: "ai-input is-note", rows: "3", placeholder: "Dis-le en une phrase : un rendez-vous, une tâche, ce que tu as acheté, où tu en es…", "aria-label": "Phrase à noter", maxlength: "2000" });
    if (S.noteText) ta.value = S.noteText;
    ta.addEventListener("input", () => {
      S.noteText = ta.value;
      grow(ta);
    });
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        understand(ta.value);
      }
    });
    const ex = el("div", { class: "ai-suggest is-examples" });
    EXAMPLES.forEach((t, i) => {
      const c = el("button", { type: "button", class: "ai-chip", text: t, on: { click: () => {
        ta.value = t;
        S.noteText = t;
        ta.focus();
      } } });
      c.style.setProperty("--i", String(i));
      ex.appendChild(c);
    });
    const goBtn = el("button", { type: "button", class: "ai-primary", on: { click: () => understand(ta.value) } }, [icon(SPARK), el("span", { text: "Comprendre" })]);
    S.noteBtn = goBtn;
    S.results = el("div", { class: "ai-results", "aria-live": "polite" });
    b.append(el("div", { class: "ai-note" }, [ta, ex, el("div", { class: "ai-row" }, [goBtn])]), S.results);
    if (S.proposals) paintProposals(S.proposals);
  }

  async function understand(text) {
    const t = String(text || "").trim();
    if (!t || S.busy) return;
    S.busy = true;
    S.noteBtn.disabled = true;
    S.noteBtn.classList.add("is-busy");
    S.results.textContent = "";
    S.results.appendChild(el("div", { class: "ai-msg is-ai is-pending" }, [el("span", { class: "ai-dots" }, [el("i"), el("i"), el("i")])]));
    try {
      const out = await call("/api/ai", { action: "capture", text: t });
      S.proposals = out;
      paintProposals(out);
      paintFoot(out.model);
      loadStatus();
    } catch (e) {
      S.results.textContent = "";
      S.results.appendChild(el("p", { class: "ai-warn", text: (e && e.message) || "Je n'ai pas compris" }));
    } finally {
      S.busy = false;
      S.noteBtn.disabled = false;
      S.noteBtn.classList.remove("is-busy");
    }
  }

  function paintProposals(out) {
    const r = S.results;
    r.textContent = "";
    if (out.reply) r.appendChild(el("p", { class: "ai-reply", text: out.reply }));
    const props = out.proposals || [];
    if (!props.length) {
      r.appendChild(el("p", { class: "ai-warn", text: "Rien à enregistrer d'après cette phrase." + (out.refused && out.refused.length ? " (" + out.refused[0] + ")" : "") }));
      return;
    }
    const picks = props.map(() => true);
    const save = el("button", { type: "button", class: "ai-primary" });
    const paintSave = () => {
      const n = picks.filter(Boolean).length;
      save.textContent = "";
      save.append(icon("M5 12.5l4 4L19 7"), el("span", { text: n > 1 ? "Enregistrer (" + n + ")" : "Enregistrer" }));
      save.disabled = !n;
    };
    props.forEach((p, i) => {
      const [name, d] = KIND[p.kind] || ["Action", KIND.note[1]];
      const box = el("input", { type: "checkbox", checked: true, "aria-label": "Garder : " + p.label });
      box.addEventListener("change", () => {
        picks[i] = box.checked;
        card.classList.toggle("is-off", !box.checked);
        paintSave();
      });
      const card = el("label", { class: "ai-card", "data-kind": p.kind }, [box, el("span", { class: "ai-card-ico" }, [icon(d)]),
        el("span", { class: "ai-card-t" }, [el("span", { class: "ai-card-k", text: name }), el("span", { class: "ai-card-l", text: p.label.replace(/^[^·]+·\s*/, "") })])]);
      card.style.setProperty("--i", String(i));
      r.appendChild(card);
    });
    for (const why of out.refused || []) r.appendChild(el("p", { class: "ai-hint", text: "Ignoré : " + why }));
    save.addEventListener("click", async () => {
      const chosen = props.filter((_, i) => picks[i]);
      if (!chosen.length) return;
      save.disabled = true;
      save.classList.add("is-busy");
      try {
        const res = await call("/api/ai", { action: "apply", proposals: chosen });
        S.proposals = null;
        S.noteText = "";
        paintDone(res);
      } catch (e) {
        save.disabled = false;
        save.classList.remove("is-busy");
        r.appendChild(el("p", { class: "ai-warn", text: (e && e.message) || "Enregistrement impossible" }));
      }
    });
    paintSave();
    r.appendChild(el("div", { class: "ai-row" }, [el("button", { type: "button", class: "ai-ghost", text: "Annuler", on: { click: () => {
      S.proposals = null;
      paintNote();
    } } }), save]));
  }

  function paintDone(res) {
    const ta = S.body.querySelector("textarea");
    if (ta) ta.value = "";
    const r = S.results;
    r.textContent = "";
    for (const d of res.done || []) {
      const t = target(d.href);
      const row = el("div", { class: "ai-done" }, [icon("M5 12.5l4 4L19 7", "ai-tick"), el("span", { text: d.label }),
        t ? el("button", { type: "button", class: "ai-ghost is-small", text: "Ouvrir", on: { click: () => go({ href: d.href }) } }) : null]);
      r.appendChild(row);
    }
    for (const f of res.failed || []) r.appendChild(el("p", { class: "ai-warn", text: f.label + " : " + f.error }));
    if (typeof S.win.hqToast === "function" && (res.done || []).length) {
      try {
        S.win.hqToast("Noté ✓");
      } catch (_) {}
    }
    if (typeof S.win.refreshFiles === "function") S.win.refreshFiles().catch(() => {});
  }

  // ---- boot

  function start(win) {
    S.win = win;
    S.doc = win.document;
    const boot = () => {
      const btn = S.doc.getElementById("btn-ai");
      if (btn) btn.addEventListener("click", () => (S.back && !S.back.hidden ? close() : open()));
      S.doc.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && (ev.key === "j" || ev.key === "J")) {
          ev.preventDefault();
          if (S.back && !S.back.hidden) close();
          else open();
        } else if (ev.key === "Escape" && S.back && !S.back.hidden) {
          ev.preventDefault();
          ev.stopPropagation();
          close();
        }
      }, true);
      win.hqAiOpen = open;
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure };
});
