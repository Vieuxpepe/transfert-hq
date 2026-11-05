/* Transfert HQ — Projets: long builds.
 *
 * Each project is a sheet with an engineering title block (status, dates, progress, revision), then five parts:
 * Tâches (the shared Kanban board, filtered to this project), Jalons, Pièces (parts list that can take stock from the
 * Inventaire), Liens (Carnet pages, Forge images, Dessiner drawings, files) and Journal (photo log).
 * Cards without a project — including those made from the Carnet — live under « Tâches libres ».
 *
 * Talks to /api/projects, reads /api/inventory, /api/carnet?meta=1, /api/forge/gallery and /api/drawings for pickers,
 * uploads photos to the Carnet image store. Never builds HTML from strings. Plain ES2020.
 * Pure helpers exported for Node tests (tests/check_hq_projects.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqProjects = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const STATUS = [
    ["active", "En cours"],
    ["idea", "Idée"],
    ["paused", "En pause"],
    ["done", "Terminé"],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUS);
  const COLS = [
    ["todo", "À faire"],
    ["doing", "En cours"],
    ["done", "Fait"],
  ];
  const BOM_LABEL = { need: "À commander", ordered: "Commandé", have: "En main" };
  const BOM_NEXT = { need: "ordered", ordered: "have", have: "need" };
  const LINK_LABEL = { carnet: "Page du Carnet", forge: "Image Forge", drawing: "Dessin", file: "Fichier" };
  const TABS = [
    ["tasks", "Tâches"],
    ["milestones", "Jalons"],
    ["bom", "Pièces"],
    ["links", "Liens"],
    ["log", "Journal"],
  ];
  const HASH_RE = /^#projets(?:\/(prj-[0-9a-f]{16}|libres)(?:\/(tasks|milestones|bom|links|log))?)?$/;
  const PHOTO_MAX_SIDE = 1600;
  const POLL_MS = 20000;

  // ------------------------------------------------------------------ pure helpers

  /** "2026-11-10" -> days from ``today`` ("2026-11-03" -> 7). Calendar dates only, never Date("YYYY-MM-DD") parsing. */
  function daysUntil(date, today) {
    const p = (s) => {
      const [y, m, d] = String(s).split("-").map(Number);
      return Date.UTC(y, m - 1, d);
    };
    return Math.round((p(date) - p(today)) / 86400000);
  }

  function isoToday(now) {
    const d = now instanceof Date ? now : new Date();
    const z = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
  }

  /** "dans 3 j", "aujourd'hui", "hier", "en retard de 5 j", "12 nov." */
  function dueLabel(date, today) {
    if (!date) return "";
    const n = daysUntil(date, today);
    if (n === 0) return "aujourd'hui";
    if (n === 1) return "demain";
    if (n === -1) return "hier";
    if (n < 0) return "en retard de " + -n + " j";
    if (n <= 14) return "dans " + n + " j";
    const [y, m, d] = date.split("-").map(Number);
    const mo = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."][m - 1];
    return d + " " + mo + (y !== Number(today.slice(0, 4)) ? " " + y : "");
  }

  /** "2026-10-01" -> "1 oct." (the year only when it is not this year). */
  function dateLabel(date, today) {
    if (!date) return "";
    const [y, m, d] = date.split("-").map(Number);
    const mo = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."][m - 1];
    return d + " " + mo + (y !== Number(String(today).slice(0, 4)) ? " " + y : "");
  }

  /** "à l'instant", "il y a 5 min", "il y a 3 h", "hier", "il y a 4 j", then a date. ``now`` and ``ts`` in seconds. */
  function ago(ts, now) {
    const s = Math.max(0, now - ts);
    if (s < 60) return "à l'instant";
    if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
    if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
    const d = Math.floor(s / 86400);
    if (d === 1) return "hier";
    if (d < 30) return "il y a " + d + " j";
    const t = new Date(ts * 1000);
    return "le " + t.getDate() + " " + ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."][t.getMonth()];
  }

  function progress(p, tasks) {
    const mine = tasks.filter((t) => t.project === p.id);
    const total = mine.length + p.milestones.length;
    const done = mine.filter((t) => t.column === "done").length + p.milestones.filter((m) => m.done).length;
    return { done, total, pct: total ? Math.round((100 * done) / total) : 0 };
  }

  /** The next milestone not done (by date, undated last). */
  function nextMilestone(p) {
    const open = p.milestones.filter((m) => !m.done);
    open.sort((a, b) => (a.due || "9999") .localeCompare(b.due || "9999"));
    return open[0] || null;
  }

  /** Parts list totals; ``stock`` maps inventory item id -> qty. Cost in cents. */
  function bomTotals(p, stock) {
    let cost = 0;
    let missing = 0;
    let priced = 0;
    for (const b of p.bom) {
      if (b.cost !== null) {
        cost += b.cost * b.qty;
        priced += 1;
      }
      if (b.status !== "have") {
        const have = b.item && stock && stock.has(b.item) ? stock.get(b.item) : 0;
        if (have < b.qty) missing += 1;
      }
    }
    return { cost, missing, priced, lines: p.bom.length };
  }

  function money(cents) {
    const v = (cents / 100).toFixed(2).replace(".", ",");
    return v.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " $";
  }

  /** "12,99" / "12.99 $" / "12" -> 1299 cents (null when empty, NaN when unreadable). */
  function parseMoney(s) {
    const t = String(s || "").replace(/[\s $€]/g, "").replace(",", ".");
    if (!t) return null;
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return NaN;
    return Math.round(Number(t) * 100);
  }

  /** Tasks of a board view: a project's, or the free ones (no project, or a project that no longer exists). */
  function tasksOf(tasks, pid, known) {
    if (pid === "libres") return tasks.filter((t) => !t.project || !known.has(t.project));
    return tasks.filter((t) => t.project === pid);
  }

  /** Link target for opening; null when it cannot be opened from here. */
  function linkHref(lk) {
    if (lk.kind === "forge") return "/api/forge/gallery/" + encodeURIComponent(lk.ref) + "/original";
    if (lk.kind === "drawing") return "/api/drawings/file?stem=" + encodeURIComponent(lk.ref) + "&kind=png";
    if (lk.kind === "file") return "/files/" + lk.ref.split("/").map(encodeURIComponent).join("/");
    return null;
  }

  const pure = { ago, daysUntil, isoToday, dueLabel, dateLabel, progress, nextMilestone, bomTotals, money, parseMoney, tasksOf, linkHref, HASH_RE };

  // ------------------------------------------------------------------ browser layer

  const S = {
    started: false, win: null, doc: null, app: null, data: null, rev: -1, loading: false, failed: "",
    sel: "", tab: "tasks", filter: "active", stock: new Map(), invItems: [], sheet: null, toastEl: null, toastTimer: 0,
    mainEl: null, pollTimer: 0, landed: "", phoneCol: "todo", drag: null,
    enter: true, tabDir: 0, ink: null, pct: new Map(), burst: "", pop: "", flip: "", taken: "", openFrom: null, resumeTimer: 0,
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON = {
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6L6 18",
    edit: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM4 20h7",
    trash: "M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13",
    back: "M15 6l-6 6 6 6",
    check: "M5 12.5l4.2 4.2L19 7",
    flag: "M5 21V4M5 4h11l-2 4 2 4H5",
    box: "M12 3.5l8 4v9l-8 4-8-4v-9zM4 7.5l8 4 8-4M12 11.5v9",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    camera: "M4 8h3l2-2.5h6L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    image: "M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 17l5-5 4 4 3-3 4 4",
    note: "M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6zM9.5 8h5.5M9.5 11.5h5.5",
    pen: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z",
    file: "M7 3.5h7l4 4V20H7zM14 3.5V8h4",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    left: "M15 6l-6 6 6 6",
    right: "M9 6l6 6-6 6",
    open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    take: "M12 4v12M7 11l5 5 5-5M5 20h14",
    tasks: "M4 6h16M4 12h16M4 18h10",
    pin: "M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5zM12 13v7.5",
  };
  const LINK_ICON = { carnet: "note", forge: "image", drawing: "pen", file: "file" };

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

  function icon(name, cls) {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.setAttribute("class", "prj-ico" + (cls ? " " + cls : ""));
    const p = S.doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICON[name] || ICON.box);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.8");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }

  function btn(label, o) {
    o = o || {};
    const b = el("button", { type: "button", class: o.cls || "prj-btn", "aria-label": o.aria || null, title: o.title || null, on: o.on ? { click: o.on } : null });
    if (o.icon) b.appendChild(icon(o.icon));
    if (label) b.appendChild(el("span", { text: label }));
    return b;
  }

  const calm = () => {
    try {
      return S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  };
  const today = () => isoToday(new Date());
  const projects = () => (S.data ? S.data.projects : []);
  const project = (id) => projects().find((p) => p.id === id) || null;
  const known = () => new Set(projects().map((p) => p.id));

  // ---------------------------------------------------------------- network

  async function call(url, opts) {
    if (typeof S.win.api === "function") return S.win.api(url, opts);
    const res = await S.win.fetch(url, Object.assign({ credentials: "same-origin" }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((data && data.error) || "Erreur " + res.status);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  const post = (body) => call("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function absorb(out) {
    if (!out || !S.data) return;
    if (out.project) {
      const k = S.data.projects.findIndex((p) => p.id === out.project.id);
      if (k >= 0) S.data.projects[k] = out.project;
      else S.data.projects.push(out.project);
    }
    if (out.deleted && out.deleted.id && out.deleted.id.startsWith("prj-")) S.data.projects = S.data.projects.filter((p) => p.id !== out.deleted.id);
    if (out.tasks) S.data.tasks = out.tasks;
    if (out.inventory_item) S.stock.set(out.inventory_item.id, out.inventory_item.qty);
  }

  async function load() {
    if (S.loading) return;
    S.loading = true;
    try {
      const out = await call("/api/projects");
      S.data = { projects: out.projects, tasks: out.tasks || [], tasksError: out.tasks_error || "" };
      S.failed = "";
      loadStock();
    } catch (e) {
      S.failed = (e && e.message) || "Projets indisponibles";
    } finally {
      S.loading = false;
    }
    render();
  }

  async function loadStock() {
    try {
      const out = await call("/api/inventory");
      if (out.items) {
        S.invItems = out.items;
        S.invPlaces = new Map((out.places || []).map((p) => [p.id, p]));
        S.stock = new Map(out.items.map((i) => [i.id, i.qty]));
        if (S.sel && S.tab === "bom") render();
      }
    } catch (_) {
      /* the Inventaire is optional here */
    }
  }

  /** One write: the reply replaces the record; a conflict shows the current version. Project writes carry its rev. */
  async function run(body, ok) {
    try {
      const out = await post(body);
      absorb(out);
      render();
      if (ok) toast(ok);
      return out;
    } catch (e) {
      if (e && e.status === 409 && e.data && e.data.project) {
        absorb({ project: e.data.project });
        render();
        toast("Modifié sur un autre appareil — version actuelle affichée");
      } else toast((e && e.message) || "Échec", null, null, true);
      return null;
    }
  }

  const prun = (p, action, extra, ok) => run(Object.assign({ action, id: p.id, rev: p.rev }, extra || {}), ok);

  // ---------------------------------------------------------------- toast / sheet (same behaviour as the Inventaire)

  function toast(text, action, onAction, bad) {
    const t = S.toastEl;
    if (!t) return;
    t.textContent = "";
    t.classList.toggle("is-bad", !!bad);
    t.appendChild(el("span", { text }));
    if (action && onAction) t.appendChild(btn(action, { cls: "prj-toast-act", on: () => {
      t.hidden = true;
      onAction();
    } }));
    t.hidden = false;
    t.classList.remove("is-in");
    void t.offsetWidth;
    t.classList.add("is-in");
    if (S.toastTimer) S.win.clearTimeout(S.toastTimer);
    S.toastTimer = S.win.setTimeout(() => (t.hidden = true), action ? 7000 : 3200);
  }

  function openSheet(title, body, foot) {
    closeSheet(true);
    const back = el("div", { class: "prj-sheet-back" });
    const box = el("div", { class: "prj-sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
    box.append(
      el("div", { class: "prj-sheet-head" }, [el("h3", { text: title }), btn("", { cls: "prj-x", icon: "close", aria: "Fermer", on: () => closeSheet() })]),
      el("div", { class: "prj-sheet-body" }, [body]),
    );
    if (foot) box.appendChild(el("div", { class: "prj-sheet-foot" }, foot));
    back.appendChild(box);
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) closeSheet();
    });
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab") {
        const f = Array.prototype.filter.call(box.querySelectorAll("button,input,select,textarea"), (n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        if (ev.shiftKey && S.doc.activeElement === f[0]) {
          ev.preventDefault();
          f[f.length - 1].focus();
        } else if (!ev.shiftKey && S.doc.activeElement === f[f.length - 1]) {
          ev.preventDefault();
          f[0].focus();
        }
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        const ok = box.querySelector(".prj-save");
        if (ok) ok.click();
      }
    });
    S.sheet = { back, box, ret: S.doc.activeElement };
    S.doc.body.appendChild(back);
    S.win.requestAnimationFrame(() => {
      const f = box.querySelector("input,select,textarea") || box.querySelector("button");
      try {
        f.focus({ preventScroll: true });
      } catch (_) {}
    });
    return box;
  }

  function closeSheet(instant) {
    const s = S.sheet;
    if (!s) return;
    S.sheet = null;
    const done = () => s.back.remove();
    if (instant || calm() || typeof s.box.animate !== "function") done();
    else {
      s.back.classList.add("is-out");
      s.box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0,16px,0) scale(.98)" }], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.then(done, done);
    }
    if (s.ret && s.ret.isConnected) {
      try {
        s.ret.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  function field(label, input, hint) {
    const id = "prj-f-" + Math.random().toString(36).slice(2, 9);
    input.id = id;
    return el("div", { class: "prj-field" }, [el("label", { for: id, text: label }), input, hint ? el("p", { class: "prj-hint", text: hint }) : null]);
  }

  // ---- photos (same pipeline as the Inventaire: downscale, then the Carnet image store)

  async function shrink(file) {
    if (typeof S.win.createImageBitmap !== "function") throw new Error("Photos non prises en charge sur ce navigateur");
    const bmp = await S.win.createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => S.win.createImageBitmap(file));
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = S.doc.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Photo illisible"))), "image/jpeg", 0.85));
  }

  async function uploadPhoto(file) {
    const blob = await shrink(file);
    const res = await S.win.fetch("/api/carnet/asset", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/jpeg", "X-Carnet-Mime": "image/jpeg" }, body: blob });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.asset) throw new Error(out.error || "Photo refusée");
    return out.asset.id;
  }

  function photoPicker(list, max, label) {
    const wrap = el("div", { class: "prj-photos" });
    const strip = el("div", { class: "prj-photo-strip" });
    const status = el("p", { class: "prj-hint", "aria-live": "polite" });
    const paint = () => {
      strip.textContent = "";
      list.forEach((id, k) => {
        const f = el("div", { class: "prj-photo" }, [el("img", { src: "/api/carnet/asset/" + id, alt: "Photo " + (k + 1), decoding: "async" })]);
        f.appendChild(btn("", { cls: "prj-photo-x", icon: "close", aria: "Retirer la photo " + (k + 1), on: () => {
          list.splice(k, 1);
          paint();
        } }));
        strip.appendChild(f);
      });
      cam.disabled = lib.disabled = list.length >= max;
    };
    const pick = (capture) => {
      const inp = el("input", { type: "file", accept: "image/*", capture: capture ? "environment" : null, multiple: capture ? null : true, hidden: true });
      inp.addEventListener("change", async () => {
        const files = Array.prototype.slice.call(inp.files || [], 0, max - list.length);
        inp.remove();
        for (const f of files) {
          strip.appendChild(el("div", { class: "prj-photo is-loading" }, [el("span", { class: "prj-spin", "aria-hidden": "true" })]));
          status.textContent = "Envoi de la photo…";
          try {
            list.push(await uploadPhoto(f));
            status.textContent = "";
          } catch (e) {
            status.textContent = (e && e.message) || "Photo refusée";
          }
          paint();
        }
      });
      S.doc.body.appendChild(inp);
      inp.click();
    };
    const cam = btn(label || "Photo", { icon: "camera", on: () => pick(true) });
    const lib = btn("Choisir", { icon: "image", on: () => pick(false) });
    wrap.append(strip, el("div", { class: "prj-photo-btns" }, [cam, lib]), status);
    paint();
    return wrap;
  }

  // ---------------------------------------------------------------- navigation

  function go(sel, tab, opts) {
    const was = { sel: S.sel, tab: S.tab };
    S.sel = sel || "";
    if (tab) S.tab = tab;
    else if (!S.sel) S.tab = "tasks";
    if (was.sel !== S.sel) {
      S.enter = true; // a new page: its entrance plays once
      S.ink = null;
      S.tabDir = 0;
    } else if (was.tab !== S.tab) {
      const idx = (k) => TABS.findIndex(([x]) => x === k);
      S.tabDir = Math.sign(idx(S.tab) - idx(was.tab));
    }
    const hash = S.sel ? "#projets/" + S.sel + (S.sel !== "libres" && S.tab !== "tasks" ? "/" + S.tab : "") : "#projets";
    try {
      if (S.win.location.hash !== hash && !(opts && opts.fromHash)) S.win.history.replaceState(null, "", hash);
    } catch (_) {}
    render();
    if (!(opts && opts.keepScroll)) {
      try {
        S.app.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" });
      } catch (_) {}
    }
  }

  function fromHash(h) {
    const m = HASH_RE.exec(h || "");
    if (!m) return false;
    if (typeof S.win.setView === "function" && S.doc.body.dataset.view !== "projets") S.win.setView("projets");
    S.pending = { sel: m[1] || "", tab: m[2] || "tasks" };
    if (S.data) applyPending();
    else show();
    return true;
  }

  function applyPending() {
    const p = S.pending;
    S.pending = null;
    if (!p) return false;
    if (p.sel && p.sel !== "libres" && !project(p.sel)) {
      toast("Ce projet n'existe plus");
      go("", null, { fromHash: true });
      return true;
    }
    S.landed = p.sel;
    go(p.sel, p.tab, { fromHash: true, keepScroll: true });
    return true;
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!S.app) return;
    if (!S.mainEl) build();
    if (S.pending && S.data && applyPending()) return;
    const m = S.mainEl;
    const before = S.enter ? null : flipCapture();
    m.textContent = "";
    m.classList.toggle("is-enter", !!S.enter && !calm());
    if (!S.data) {
      if (S.failed) m.appendChild(el("div", { class: "prj-empty" }, [el("p", { text: "Les projets n'ont pas pu se charger : " + S.failed }), btn("Réessayer", { on: () => load() })]));
      return;
    }
    if (S.sel && S.sel !== "libres" && !project(S.sel)) S.sel = "";
    if (!S.sel) renderList(m);
    else if (S.sel === "libres") renderFree(m);
    else renderProject(m, project(S.sel));
    afterRender(before);
    S.landed = "";
  }

  // ---------------------------------------------------------------- motion: everything that changes shows where it went

  function flipCapture() {
    const map = new Map();
    if (!S.mainEl || calm()) return map;
    for (const n of S.mainEl.querySelectorAll("[data-flip]")) map.set(n.getAttribute("data-flip"), n.getBoundingClientRect());
    return map;
  }

  function anim(node, frames, opts) {
    if (!node || calm() || typeof node.animate !== "function") return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }

  const EASE = "cubic-bezier(.2,.8,.2,1)";
  const SPRING = "cubic-bezier(.2,1.35,.35,1)";

  function afterRender(before) {
    const m = S.mainEl;
    if (before) {
      // cards, milestones, parts and links glide from where they were; new ones drop in
      for (const n of m.querySelectorAll("[data-flip]")) {
        const k = n.getAttribute("data-flip");
        const r = n.getBoundingClientRect();
        const was = before.get(k);
        if (was) {
          const dx = was.left - r.left;
          const dy = was.top - r.top;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) anim(n, [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: Math.min(560, 260 + Math.hypot(dx, dy) * 0.35), easing: SPRING });
        } else if (before.size) {
          anim(n, [{ opacity: 0, transform: "translate3d(0,-12px,0) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: SPRING });
        }
      }
    }
    inkGlide();
    if (S.tabDir && !S.enter) {
      const panel = m.querySelector(".prj-panel");
      anim(panel, [{ opacity: 0, transform: "translate3d(" + S.tabDir * 28 + "px,0,0)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
      S.tabDir = 0;
    }
    meters();
    if (S.openFrom) openFromCard();
    if (S.burst) burstFrom(m.querySelector('[data-flip="t:' + S.burst + '"]'));
    S.burst = "";
    S.pop = "";
    S.flip = "";
    S.taken = "";
    S.enter = false;
  }

  /** The tab underline glides from the previous tab to the chosen one. */
  function inkGlide() {
    const tabs = S.mainEl.querySelector(".prj-tabs");
    if (!tabs) return;
    const sel = tabs.querySelector('[aria-selected="true"]');
    let ink = tabs.querySelector(".prj-tab-ink");
    if (!ink) {
      ink = el("span", { class: "prj-tab-ink", "aria-hidden": "true" });
      tabs.prepend(ink);
    }
    if (!sel) return;
    const x = sel.offsetLeft;
    const w = sel.offsetWidth;
    ink.style.transform = "translate3d(" + x + "px,0,0)";
    ink.style.width = w + "px";
    if (S.ink && (S.ink.x !== x || S.ink.w !== w)) anim(ink, [{ transform: "translate3d(" + S.ink.x + "px,0,0)", width: S.ink.w + "px" }, { transform: "translate3d(" + x + "px,0,0)", width: w + "px" }], { duration: 380, easing: SPRING });
    S.ink = { x, w };
  }

  /** Progress bars grow from their last value, and the percentage counts along. */
  function meters() {
    for (const f of S.mainEl.querySelectorAll(".prj-meter-fill[data-pid]")) {
      const pid = f.getAttribute("data-pid");
      const to = Number(f.style.getPropertyValue("--p")) || 0;
      const from = S.pct.has(pid) ? S.pct.get(pid) : 0;
      if (Math.abs(to - from) > 0.001) anim(f, [{ transform: "scaleX(" + from + ")" }, { transform: "scaleX(" + to + ")" }], { duration: S.pct.has(pid) ? 620 : 900, easing: EASE, delay: S.pct.has(pid) ? 0 : 200 });
      S.pct.set(pid, to);
    }
    const v = S.mainEl.querySelector(".prj-tb-pct");
    if (v && !calm()) {
      const to = Number(v.getAttribute("data-to")) || 0;
      const from = Number(v.getAttribute("data-from")) || 0;
      if (to !== from) {
        const t0 = S.win.performance.now();
        const tail = v.textContent.replace(/^\d+ %/, "");
        const step = (now) => {
          const k = Math.min(1, (now - t0) / 700);
          v.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))) + " %" + tail;
          if (k < 1 && v.isConnected) S.win.requestAnimationFrame(step);
        };
        S.win.requestAnimationFrame(step);
      }
    }
  }

  /** Opening a project: its card grows into the blueprint header. */
  function openFromCard() {
    const from = S.openFrom;
    S.openFrom = null;
    const head = S.mainEl.querySelector(".prj-sheet-title");
    if (!from || !head || calm()) return;
    const to = head.getBoundingClientRect();
    if (!to.width) return;
    anim(head, [
      { transformOrigin: "0 0", transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scale(" + from.width / to.width + "," + from.height / to.height + ")", opacity: 0.7, borderRadius: "18px" },
      { transformOrigin: "0 0", transform: "none", opacity: 1, borderRadius: "20px" },
    ], { duration: 560, easing: EASE });
  }

  /** A small burst of the project's colour where a task was finished. */
  function burstFrom(node) {
    if (!node || calm()) return;
    const r = node.getBoundingClientRect();
    const cx = r.left + Math.min(28, r.width / 2);
    const cy = r.top + r.height / 2;
    const hueV = getComputedStyle(node).getPropertyValue("--hue") || "150";
    for (let k = 0; k < 14; k += 1) {
      const a = (Math.PI * 2 * k) / 14 + Math.random() * 0.4;
      const d = 34 + Math.random() * 46;
      const dot = el("span", { class: "prj-spark", "aria-hidden": "true" });
      dot.style.left = cx + "px";
      dot.style.top = cy + "px";
      dot.style.background = k % 3 ? "hsl(" + hueV + " 80% 62%)" : "var(--accent)";
      S.doc.body.appendChild(dot);
      const a2 = anim(dot, [{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: "translate(calc(-50% + " + Math.cos(a) * d + "px),calc(-50% + " + Math.sin(a) * d + "px)) scale(.3)", opacity: 0 }], { duration: 620 + Math.random() * 200, easing: "cubic-bezier(.1,.7,.3,1)" });
      if (a2) a2.finished.then(() => dot.remove(), () => dot.remove());
      else dot.remove();
    }
  }

  function build() {
    S.app.textContent = "";
    S.app.classList.add("prj");
    S.mainEl = el("div", { class: "prj-main" });
    S.toastEl = el("div", { class: "prj-toast", role: "status", hidden: true });
    S.app.append(S.mainEl, S.toastEl);
  }

  // ---- list of projects

  function renderList(m) {
    const all = projects();
    const counts = Object.fromEntries(STATUS.map(([k]) => [k, all.filter((p) => p.status === k).length]));
    const head = el("div", { class: "prj-list-head" }, [
      el("h3", { class: "prj-h1", text: "Projets" }),
      btn("Nouveau projet", { cls: "prj-btn is-primary", icon: "plus", on: () => editProject(null) }),
    ]);
    m.appendChild(head);
    const chips = el("div", { class: "prj-chips", role: "group", "aria-label": "Filtrer par statut" });
    for (const [k, lab] of STATUS.concat([["all", "Tous"]])) {
      const n = k === "all" ? all.length : counts[k];
      const c = el("button", { type: "button", class: "prj-chip", "aria-pressed": String(S.filter === k) }, [lab, n ? el("span", { class: "prj-n", text: String(n) }) : null]);
      c.addEventListener("click", () => {
        S.filter = k;
        render();
      });
      chips.appendChild(c);
    }
    m.appendChild(chips);
    const shown = all.filter((p) => S.filter === "all" || p.status === S.filter)
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || b.updated_at - a.updated_at);
    const grid = el("div", { class: "prj-cards" });
    shown.forEach((p, k) => grid.appendChild(projectCard(p, k)));
    const free = tasksOf(S.data.tasks, "libres", known()).filter((t) => t.column !== "done").length;
    grid.appendChild(freeCard(free, shown.length));
    m.appendChild(grid);
    if (!all.length) {
      m.appendChild(el("p", { class: "prj-empty", text: "Un projet réunit tout ce qu'une construction demande : les tâches, les jalons, les pièces à acheter ou à sortir de l'inventaire, les notes et dessins liés, et un journal en photos." }));
    }
    if (S.data.tasksError) m.appendChild(el("p", { class: "prj-hint is-warn", text: S.data.tasksError }));
  }

  function hue(p) {
    return String(p ? p.hue : 210);
  }

  function projectCard(p, k) {
    const pr = progress(p, S.data.tasks);
    const next = nextMilestone(p);
    const t = today();
    const card = el("button", { type: "button", class: "prj-card is-" + p.status, "data-prj": p.id, "data-flip": "p:" + p.id });
    card.style.setProperty("--hue", hue(p));
    card.style.setProperty("--k", String(Math.min(k, 12)));
    const cover = el("span", { class: "prj-card-cover", "aria-hidden": "true" });
    if (p.cover) cover.appendChild(el("img", { src: "/api/carnet/asset/" + p.cover, alt: "", loading: "lazy", decoding: "async" }));
    else cover.appendChild(el("span", { class: "prj-card-mono", text: (p.name.trim()[0] || "?").toUpperCase() }));
    const meta = [];
    if (next) meta.push(el("span", { class: "prj-card-next" }, [icon("flag"), next.title + (next.due ? " · " + dueLabel(next.due, t) : "")]));
    else if (p.due) meta.push(el("span", { class: "prj-card-next" + (daysUntil(p.due, t) < 0 && p.status !== "done" ? " is-late" : "") }, [icon("clock"), "Échéance " + dueLabel(p.due, t)]));
    card.append(
      cover,
      el("span", { class: "prj-card-body" }, [
        el("span", { class: "prj-card-top" }, [el("span", { class: "prj-status is-" + p.status, text: STATUS_LABEL[p.status] }), el("span", { class: "prj-card-pct", text: pr.total ? pr.pct + " %" : "" })]),
        el("span", { class: "prj-card-name", text: p.name }),
        p.resume
          ? el("span", { class: "prj-card-resume" }, [icon("pin"), el("span", { class: "prj-card-resume-text", text: p.resume }), p.resume_at ? el("span", { class: "prj-card-resume-at", text: ago(p.resume_at, Date.now() / 1000) }) : null])
          : p.goal ? el("span", { class: "prj-card-goal", text: p.goal }) : null,
        ...meta,
        meter(pr, p.id),
      ]),
    );
    card.addEventListener("click", () => {
      S.openFrom = card.getBoundingClientRect();
      go(p.id, "tasks");
    });
    tilt(card);
    return card;
  }

  /** PC: the card leans a little toward the pointer. */
  function tilt(card) {
    card.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse" || calm()) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--rx", (((ev.clientY - r.top) / r.height - 0.5) * -5).toFixed(2) + "deg");
      card.style.setProperty("--ry", (((ev.clientX - r.left) / r.width - 0.5) * 6).toFixed(2) + "deg");
      card.style.setProperty("--gx", (((ev.clientX - r.left) / r.width) * 100).toFixed(1) + "%");
    });
    card.addEventListener("pointerleave", () => {
      card.style.removeProperty("--rx");
      card.style.removeProperty("--ry");
    });
  }

  function freeCard(open, k) {
    const card = el("button", { type: "button", class: "prj-card is-free", "data-prj": "libres", "data-flip": "p:libres" });
    card.style.setProperty("--k", String(Math.min(k, 12)));
    card.append(
      el("span", { class: "prj-card-cover", "aria-hidden": "true" }, [icon("tasks", "prj-free-ico")]),
      el("span", { class: "prj-card-body" }, [
        el("span", { class: "prj-card-name", text: "Tâches libres" }),
        el("span", { class: "prj-card-goal", text: open ? open + (open > 1 ? " tâches ouvertes" : " tâche ouverte") + ", hors projet (dont celles du Carnet)" : "Les tâches hors projet, dont celles créées depuis le Carnet" }),
      ]),
    );
    card.addEventListener("click", () => go("libres"));
    return card;
  }

  function meter(pr, pid) {
    const m = el("span", { class: "prj-meter", role: "img", "aria-label": pr.total ? pr.done + " sur " + pr.total + " terminés" : "Rien à faire pour l'instant" });
    const f = el("span", { class: "prj-meter-fill", "data-pid": pid || null });
    f.style.setProperty("--p", String(pr.pct / 100));
    m.appendChild(f);
    return m;
  }

  // ---- one project

  function renderProject(m, p) {
    m.appendChild(btn("Tous les projets", { cls: "prj-back", icon: "back", on: () => go("") }));
    m.appendChild(titleBlock(p));
    m.appendChild(resumeNote(p));
    const tabs = el("div", { class: "prj-tabs", role: "tablist", "aria-label": "Parties du projet" });
    const counts = {
      tasks: tasksOf(S.data.tasks, p.id, known()).filter((t) => t.column !== "done").length,
      milestones: p.milestones.filter((x) => !x.done).length,
      bom: p.bom.filter((b) => b.status !== "have").length,
      links: p.links.length,
      log: p.timeline.length,
    };
    for (const [k, lab] of TABS) {
      const b = el("button", { type: "button", role: "tab", class: "prj-tab", id: "prj-tab-" + k, "aria-selected": String(S.tab === k), "aria-controls": "prj-panel", tabindex: S.tab === k ? "0" : "-1" }, [lab, counts[k] ? el("span", { class: "prj-n", text: String(counts[k]) }) : null]);
      b.addEventListener("click", () => go(p.id, k, { keepScroll: true }));
      b.addEventListener("keydown", (ev) => {
        const i = TABS.findIndex(([x]) => x === k);
        const j = ev.key === "ArrowRight" ? i + 1 : ev.key === "ArrowLeft" ? i - 1 : -9;
        if (j < -1) return;
        ev.preventDefault();
        const nk = TABS[(j + TABS.length) % TABS.length][0];
        go(p.id, nk, { keepScroll: true });
        const nb = S.doc.getElementById("prj-tab-" + nk);
        if (nb) nb.focus();
      });
      tabs.appendChild(b);
    }
    m.appendChild(tabs);
    const panel = el("div", { class: "prj-panel", id: "prj-panel", role: "tabpanel", "aria-labelledby": "prj-tab-" + S.tab });
    panel.style.setProperty("--hue", hue(p));
    if (S.tab === "tasks") panel.appendChild(board(p.id, p));
    else if (S.tab === "milestones") panel.appendChild(milestones(p));
    else if (S.tab === "bom") panel.appendChild(bomView(p));
    else if (S.tab === "links") panel.appendChild(linksView(p));
    else panel.appendChild(logView(p));
    m.appendChild(panel);
  }

  /** The drawing-sheet title block: name and goal on the left, the facts in ruled cells. */
  function titleBlock(p) {
    const pr = progress(p, S.data.tasks);
    const t = today();
    const sheet = el("header", { class: "prj-sheet-title" + (S.landed === p.id ? " is-landed" : "") });
    sheet.style.setProperty("--hue", hue(p));
    const left = el("div", { class: "prj-tb-main" }, [
      el("h3", { class: "prj-tb-name", text: p.name }),
      p.goal ? el("p", { class: "prj-tb-goal", text: p.goal }) : el("p", { class: "prj-tb-goal is-empty", text: "Pas encore d'objectif écrit." }),
    ]);
    if (p.cover) sheet.appendChild(el("img", { class: "prj-tb-cover", src: "/api/carnet/asset/" + p.cover, alt: "", decoding: "async" }));
    const cell = (k, v, cls) => el("div", { class: "prj-tb-cell" + (cls ? " " + cls : "") }, [el("span", { class: "prj-tb-k", text: k }), el("span", { class: "prj-tb-v", text: v })]);
    const late = p.due && p.status !== "done" && daysUntil(p.due, t) < 0;
    const totals = bomTotals(p, S.stock);
    const grid = el("div", { class: "prj-tb-grid" }, [
      cell("Statut", STATUS_LABEL[p.status], "is-status is-" + p.status),
      cell("Début", p.start ? dateLabel(p.start, t) : "—"),
      cell("Échéance", p.due ? dateLabel(p.due, t) + (p.status !== "done" && daysUntil(p.due, t) <= 14 ? " · " + dueLabel(p.due, t) : "") : "—", late ? "is-late" : ""),
      cell("Avancement", pr.total ? pr.pct + " % · " + pr.done + "/" + pr.total : "—", "is-pct"),
      cell("Pièces", totals.lines ? (totals.priced ? money(totals.cost) : totals.lines + " lignes") : "—", totals.missing ? "is-warn" : ""),
      cell("Rév.", String(p.rev)),
    ]);
    const acts = el("div", { class: "prj-tb-acts" }, [
      btn("Modifier", { icon: "edit", on: () => editProject(p) }),
      btn("", { icon: "trash", cls: "prj-btn is-danger", aria: "Supprimer le projet", title: "Supprimer", on: () => deleteProject(p) }),
    ]);
    sheet.append(left, grid, acts, meter(pr, p.id));
    const pv = grid.querySelector(".is-pct .prj-tb-v");
    if (pv && pr.total) {
      pv.classList.add("prj-tb-pct");
      pv.setAttribute("data-to", String(pr.pct));
      pv.setAttribute("data-from", String(S.pct.has(p.id) ? Math.round(S.pct.get(p.id) * 100) : 0));
    }
    return sheet;
  }

  /** « Où j'en suis » : a note pinned to the project, typed in place, saved as you go, shown again on the project card. */
  function resumeNote(p) {
    const box = el("section", { class: "prj-resume" + (p.resume ? "" : " is-empty"), "aria-labelledby": "prj-resume-h" });
    box.style.setProperty("--hue", hue(p));
    const state = el("span", { class: "prj-resume-state", "aria-live": "polite", text: p.resume_at ? "Mis à jour " + ago(p.resume_at, Date.now() / 1000) : "" });
    const ta = el("textarea", { class: "prj-resume-text", rows: "2", maxlength: "1000", "aria-labelledby": "prj-resume-h",
      placeholder: "Ce que tu faisais, la prochaine étape, où tu as posé les vis… Pour reprendre sans chercher." });
    ta.value = p.resume;
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight + 2, 320) + "px";
    };
    let saved = p.resume;
    const save = async () => {
      if (S.resumeTimer) S.win.clearTimeout(S.resumeTimer);
      S.resumeTimer = 0;
      const text = ta.value;
      if (text.trim() === saved.trim()) return;
      state.textContent = "Enregistrement…";
      state.classList.remove("is-saved");
      try {
        const out = await post({ action: "project.resume", id: p.id, text });
        saved = out.project.resume;
        const k = S.data.projects.findIndex((x) => x.id === p.id);
        if (k >= 0) S.data.projects[k] = out.project; // no re-render: the text you are typing stays where it is
        state.textContent = out.project.resume ? "Enregistré" : "Note effacée";
        state.classList.add("is-saved");
        box.classList.toggle("is-empty", !out.project.resume);
      } catch (e) {
        state.textContent = (e && e.message) || "Non enregistré";
      }
    };
    ta.addEventListener("input", () => {
      grow();
      box.classList.remove("is-empty");
      state.textContent = "…";
      state.classList.remove("is-saved");
      if (S.resumeTimer) S.win.clearTimeout(S.resumeTimer);
      S.resumeTimer = S.win.setTimeout(save, 900);
    });
    ta.addEventListener("blur", save);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ta.blur();
      }
    });
    box.append(
      el("div", { class: "prj-resume-head" }, [icon("pin"), el("h4", { id: "prj-resume-h", class: "prj-resume-title", text: "Où j'en suis" }), state]),
      ta,
    );
    S.win.requestAnimationFrame(grow);
    return box;
  }

  // ---- board (tasks)

  function renderFree(m) {
    m.appendChild(btn("Tous les projets", { cls: "prj-back", icon: "back", on: () => go("") }));
    m.appendChild(el("div", { class: "prj-free-head" }, [el("h3", { class: "prj-h1", text: "Tâches libres" }), el("p", { class: "prj-hint", text: "Les tâches hors projet, et celles créées depuis le Carnet. Ouvre une tâche pour la ranger dans un projet." })]));
    const panel = el("div", { class: "prj-panel" });
    panel.appendChild(board("libres", null));
    m.appendChild(panel);
  }

  function board(pid, p) {
    const list = tasksOf(S.data.tasks, pid, known());
    const wrap = el("div", { class: "prj-board", "data-phone-col": S.phoneCol });
    if (S.data.tasksError) {
      wrap.appendChild(el("p", { class: "prj-hint is-warn", text: S.data.tasksError }));
      return wrap;
    }
    const seg = el("div", { class: "prj-seg", role: "group", "aria-label": "Colonne affichée" });
    for (const [c, lab] of COLS) {
      const n = list.filter((t) => t.column === c).length;
      const b = el("button", { type: "button", class: "prj-seg-btn", "aria-pressed": String(S.phoneCol === c) }, [lab, el("span", { class: "prj-n", text: String(n) })]);
      b.addEventListener("click", () => {
        S.phoneCol = c;
        render();
      });
      seg.appendChild(b);
    }
    wrap.appendChild(seg);
    const cols = el("div", { class: "prj-cols" });
    for (const [c, lab] of COLS) {
      const items = list.filter((t) => t.column === c);
      const col = el("section", { class: "prj-col is-" + c, "data-col": c, "aria-label": lab });
      col.appendChild(el("h4", { class: "prj-col-h" }, [lab, el("span", { class: "prj-n", text: String(items.length) })]));
      if (c === "todo") col.appendChild(quickAdd(pid === "libres" ? null : pid));
      const ul = el("ul", { class: "prj-cards-col" });
      items.forEach((t, k) => ul.appendChild(taskCard(t, p, k)));
      if (!items.length) ul.appendChild(el("li", { class: "prj-col-empty", text: c === "done" ? "Rien de terminé pour l'instant" : c === "doing" ? "Glisse une tâche ici quand tu t'y mets" : "Rien à faire" }));
      col.appendChild(ul);
      dropZone(col, c);
      cols.appendChild(col);
    }
    wrap.appendChild(cols);
    return wrap;
  }

  function quickAdd(pid) {
    const form = el("form", { class: "prj-quick" });
    const inp = el("input", { type: "text", maxlength: "120", placeholder: "Nouvelle tâche…", "aria-label": "Nouvelle tâche", autocomplete: "off", enterkeyhint: "done" });
    form.append(inp, btn("", { cls: "prj-quick-go", icon: "plus", aria: "Ajouter la tâche" }));
    form.lastChild.type = "submit";
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const title = inp.value.trim();
      if (!title) return;
      inp.value = "";
      const out = await run({ action: "task.create", title, project: pid });
      if (out) {
        S.landed = out.task.id;
        render();
        const again = S.mainEl.querySelector(".prj-quick input");
        if (again) again.focus();
      }
    });
    return form;
  }

  function taskCard(t, p, k) {
    const li = el("li", { class: "prj-task" + (S.landed === t.id ? " is-landed" : "") + (S.burst === t.id ? " is-just-done" : ""), "data-task": t.id, "data-flip": "t:" + t.id, draggable: "true" });
    if (p) li.style.setProperty("--hue", hue(p));
    li.style.setProperty("--k", String(Math.min(k, 12)));
    const ms = p && t.milestone ? p.milestones.find((x) => x.id === t.milestone) : null;
    const tday = today();
    const open = el("button", { type: "button", class: "prj-task-open", "aria-label": "Ouvrir la tâche " + t.title }, [el("span", { class: "prj-task-title", text: t.title })]);
    const chips = el("span", { class: "prj-task-chips" });
    if (t.due) chips.appendChild(el("span", { class: "prj-chiplet" + (t.column !== "done" && daysUntil(t.due, tday) < 0 ? " is-late" : ""), text: dueLabel(t.due, tday) }));
    if (ms) chips.appendChild(el("span", { class: "prj-chiplet is-ms" }, [icon("flag"), ms.title]));
    if (t.note) chips.appendChild(el("span", { class: "prj-chiplet", title: "A une note" }, [icon("note")]));
    if (chips.childNodes.length) open.appendChild(chips);
    open.addEventListener("click", () => editTask(t));
    li.appendChild(open);
    const idx = COLS.findIndex(([c]) => c === t.column);
    const moves = el("span", { class: "prj-task-moves" });
    if (idx > 0) moves.appendChild(btn("", { cls: "prj-mini", icon: "left", aria: "Vers « " + COLS[idx - 1][1] + " »", on: () => moveTask(t, COLS[idx - 1][0]) }));
    if (idx < COLS.length - 1) moves.appendChild(btn("", { cls: "prj-mini" + (idx === COLS.length - 2 ? " is-finish" : ""), icon: idx === COLS.length - 2 ? "check" : "right", aria: "Vers « " + COLS[idx + 1][1] + " »", on: () => moveTask(t, COLS[idx + 1][0]) }));
    li.appendChild(moves);
    li.addEventListener("dragstart", (ev) => {
      S.drag = t.id;
      li.classList.add("is-dragging");
      try {
        ev.dataTransfer.setData("text/plain", t.id);
        ev.dataTransfer.effectAllowed = "move";
      } catch (_) {}
    });
    li.addEventListener("dragend", () => {
      S.drag = null;
      li.classList.remove("is-dragging");
      for (const c of S.mainEl.querySelectorAll(".prj-col.is-over")) c.classList.remove("is-over");
    });
    return li;
  }

  function dropZone(col, c) {
    col.addEventListener("dragover", (ev) => {
      if (!S.drag) return;
      ev.preventDefault();
      col.classList.add("is-over");
    });
    col.addEventListener("dragleave", (ev) => {
      if (!col.contains(ev.relatedTarget)) col.classList.remove("is-over");
    });
    col.addEventListener("drop", (ev) => {
      ev.preventDefault();
      col.classList.remove("is-over");
      const t = S.data.tasks.find((x) => x.id === S.drag);
      S.drag = null;
      if (!t) return;
      const cards = Array.prototype.slice.call(col.querySelectorAll(".prj-task:not(.is-dragging)"));
      let index = cards.length;
      for (let k = 0; k < cards.length; k += 1) {
        const r = cards[k].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          index = k;
          break;
        }
      }
      // the index counts every card of the column on the board (other projects' too): place it before the card we dropped on
      const before = cards[index] ? cards[index].getAttribute("data-task") : null;
      const all = S.data.tasks.filter((x) => x.column === c && x.id !== t.id);
      const at = before ? all.findIndex((x) => x.id === before) : all.length;
      moveTask(t, c, at < 0 ? 0 : at);
    });
  }

  async function moveTask(t, c, index) {
    if (t.column === c && index === undefined) return;
    const was = t.column;
    t.column = c; // optimistic
    S.landed = "";
    if (c === "done" && was !== "done") S.burst = t.id;
    render();
    const out = await run({ action: "task.move", id: t.id, column: c, index: index === undefined ? 0 : index });
    if (!out) {
      t.column = was;
      render();
    } else if (c === "done" && was !== "done") {
      celebrate(t.id);
    }
  }

  function celebrate() {
    try {
      if (S.win.navigator.vibrate) S.win.navigator.vibrate([8, 40, 14]);
    } catch (_) {}
  }

  function editTask(t) {
    const title = el("input", { type: "text", maxlength: "120", value: t.title, autocomplete: "off" });
    const projSel = el("select", {}, [el("option", { value: "", text: "Aucun (tâche libre)" })].concat(projects().map((p) => el("option", { value: p.id, text: p.name, selected: p.id === t.project }))));
    if (!t.project || !project(t.project)) projSel.value = "";
    const msSel = el("select", {});
    const paintMs = () => {
      msSel.textContent = "";
      msSel.appendChild(el("option", { value: "", text: "Aucun" }));
      const p = project(projSel.value);
      for (const ms of p ? p.milestones : []) msSel.appendChild(el("option", { value: ms.id, text: ms.title, selected: ms.id === t.milestone }));
      msSel.disabled = !p || !p.milestones.length;
    };
    projSel.addEventListener("change", paintMs);
    paintMs();
    const due = el("input", { type: "date", value: t.due || "" });
    const col = el("select", {}, COLS.map(([c, lab]) => el("option", { value: c, text: lab, selected: c === t.column })));
    const note = el("textarea", { rows: "4", maxlength: "2000", placeholder: "Détails, cotes, références…" });
    note.value = t.note || "";
    const body = el("div", { class: "prj-form" }, [
      field("Tâche", title),
      el("div", { class: "prj-row" }, [field("Projet", projSel), field("Jalon", msSel)]),
      el("div", { class: "prj-row" }, [field("Échéance", due), field("Colonne", col)]),
      field("Note", note),
    ]);
    const save = btn("Enregistrer", { cls: "prj-btn is-primary prj-save", on: async () => {
      if (!title.value.trim()) {
        title.focus();
        return;
      }
      save.disabled = true;
      const out = await run({ action: "task.update", id: t.id, title: title.value, project: projSel.value || null, milestone: msSel.value || null, due: due.value || null, note: note.value });
      if (out && col.value !== out.task.column) await run({ action: "task.move", id: t.id, column: col.value, index: 0 });
      save.disabled = false;
      if (out) closeSheet();
    } });
    const del = btn("Supprimer", { cls: "prj-btn is-danger", icon: "trash", on: async () => {
      closeSheet();
      const out = await run({ action: "task.delete", id: t.id });
      if (out) toast("Tâche supprimée", "Annuler", () => run({ action: "task.restore", task: out.deleted, index: out.deleted.index }, "Tâche rétablie"));
    } });
    openSheet("Tâche", body, [del, save]);
  }

  // ---- milestones

  function milestones(p) {
    const wrap = el("div", { class: "prj-ms" });
    const t = today();
    const tasks = tasksOf(S.data.tasks, p.id, known());
    const ol = el("ol", { class: "prj-ms-list" });
    p.milestones.forEach((ms, k) => {
      const mine = tasks.filter((x) => x.milestone === ms.id);
      const done = mine.filter((x) => x.column === "done").length;
      const late = !ms.done && ms.due && daysUntil(ms.due, t) < 0;
      const li = el("li", { class: "prj-ms-item" + (ms.done ? " is-done" : "") + (late ? " is-late" : "") + (S.pop === ms.id ? " is-just-done" : ""), "data-flip": "m:" + ms.id });
      const box = el("button", { type: "button", class: "prj-ms-check", role: "checkbox", "aria-checked": String(ms.done), "aria-label": (ms.done ? "Rouvrir « " : "Terminer « ") + ms.title + " »" }, [icon("check")]);
      box.addEventListener("click", () => {
        if (!ms.done) S.pop = ms.id;
        if (!ms.done) celebrate();
        prun(p, "milestone.update", { sub: ms.id, milestone: { done: !ms.done } }, ms.done ? null : "Jalon atteint");
      });
      const text = el("button", { type: "button", class: "prj-ms-text", "aria-label": "Modifier le jalon " + ms.title }, [
        el("span", { class: "prj-ms-title", text: ms.title }),
        el("span", { class: "prj-ms-meta", text: [ms.due ? (ms.done ? dateLabel(ms.due, t) : dueLabel(ms.due, t)) : "", mine.length ? done + "/" + mine.length + " tâches" : ""].filter(Boolean).join(" · ") || "Sans date" }),
      ]);
      text.addEventListener("click", () => editMilestone(p, ms));
      const order = el("span", { class: "prj-ms-order" }, [
        k > 0 ? btn("", { cls: "prj-mini", icon: "left", aria: "Monter", on: () => prun(p, "milestone.move", { sub: ms.id, index: k - 1 }) }) : null,
        k < p.milestones.length - 1 ? btn("", { cls: "prj-mini", icon: "right", aria: "Descendre", on: () => prun(p, "milestone.move", { sub: ms.id, index: k + 1 }) }) : null,
      ]);
      li.append(box, text, order);
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    if (!p.milestones.length) wrap.appendChild(el("p", { class: "prj-empty", text: "Les jalons découpent le projet en étapes visibles : châssis monté, premier test, version finale…" }));
    const form = el("form", { class: "prj-quick" });
    const inp = el("input", { type: "text", maxlength: "120", placeholder: "Nouveau jalon…", "aria-label": "Nouveau jalon", autocomplete: "off" });
    const date = el("input", { type: "date", "aria-label": "Date du jalon" });
    const go2 = btn("", { cls: "prj-quick-go", icon: "plus", aria: "Ajouter le jalon" });
    go2.type = "submit";
    form.append(inp, date, go2);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!inp.value.trim()) return;
      await prun(p, "milestone.add", { milestone: { title: inp.value, due: date.value || null } });
      const again = S.mainEl.querySelector(".prj-ms .prj-quick input");
      if (again) again.focus();
    });
    wrap.appendChild(form);
    return wrap;
  }

  function editMilestone(p, ms) {
    const title = el("input", { type: "text", maxlength: "120", value: ms.title });
    const due = el("input", { type: "date", value: ms.due || "" });
    const body = el("div", { class: "prj-form" }, [field("Jalon", title), field("Date", due)]);
    const save = btn("Enregistrer", { cls: "prj-btn is-primary prj-save", on: async () => {
      if (await prun(p, "milestone.update", { sub: ms.id, milestone: { title: title.value, due: due.value || null } })) closeSheet();
    } });
    const del = btn("Supprimer", { cls: "prj-btn is-danger", icon: "trash", on: async () => {
      closeSheet();
      await prun(p, "milestone.delete", { sub: ms.id }, "Jalon supprimé");
    } });
    openSheet("Jalon", body, [del, save]);
  }

  // ---- parts list

  function bomView(p) {
    const wrap = el("div", { class: "prj-bom" });
    const totals = bomTotals(p, S.stock);
    wrap.appendChild(el("div", { class: "prj-bom-sum" }, [
      el("span", {}, [el("strong", { text: String(totals.lines) }), totals.lines > 1 ? " pièces" : " pièce"]),
      totals.priced ? el("span", {}, ["Coût ", el("strong", { text: money(totals.cost) })]) : null,
      totals.missing ? el("span", { class: "is-warn" }, [el("strong", { text: String(totals.missing) }), " à trouver"]) : null,
      btn("Ajouter une pièce", { cls: "prj-btn is-primary", icon: "plus", on: () => editBom(p, null) }),
    ]));
    if (!p.bom.length) {
      wrap.appendChild(el("p", { class: "prj-empty", text: "La liste des pièces : ce qu'il faut acheter, ce qui est commandé, et ce que tu sors de l'inventaire." }));
      return wrap;
    }
    const ul = el("ul", { class: "prj-bom-list" });
    for (const b of p.bom) {
      const inStock = b.item && S.stock.has(b.item) ? S.stock.get(b.item) : null;
      const li = el("li", { class: "prj-bom-row is-" + b.status + (b.used ? " is-used" : "") + (S.taken === b.id ? " is-taken" : ""), "data-flip": "b:" + b.id });
      const name = el("button", { type: "button", class: "prj-bom-name", "aria-label": "Modifier " + b.name }, [
        el("span", { class: "prj-bom-title", text: b.name }),
        el("span", { class: "prj-bom-meta" }, [
          el("span", { class: "prj-qty", text: b.qty + (b.unit ? " " + b.unit : "") }),
          b.cost !== null ? el("span", { text: money(b.cost) + (b.qty > 1 ? " ch. · " + money(b.cost * b.qty) : "") }) : null,
          b.item ? el("span", { class: "prj-stock" + (b.used ? " is-used" : inStock === null ? " is-gone" : inStock >= b.qty ? " is-ok" : " is-short") },
            [icon("box"), b.used ? "sorti de l'inventaire" : inStock === null ? "objet introuvable" : "en stock : " + inStock]) : null,
        ]),
      ]);
      name.addEventListener("click", () => editBom(p, b));
      const state = el("button", { type: "button", class: "prj-bom-state is-" + b.status, title: "Changer l'état", "aria-label": "État : " + BOM_LABEL[b.status] + ". Passer à « " + BOM_LABEL[BOM_NEXT[b.status]] + " »", text: BOM_LABEL[b.status] });
      if (S.flip === b.id) state.classList.add("is-flip");
      state.addEventListener("click", () => {
        S.flip = b.id;
        prun(p, "bom.update", { sub: b.id, bom: { status: BOM_NEXT[b.status] } });
      });
      li.append(name, state);
      if (b.item && inStock !== null) {
        li.appendChild(btn("", { cls: "prj-mini prj-to-inv", icon: "box", aria: "Voir « " + b.name + " » dans l'inventaire", title: "Voir dans l'inventaire", on: () => {
          try {
            S.win.location.hash = "#inventaire/objet/" + b.item;
          } catch (_) {}
        } }));
      }
      if (b.item && !b.used && inStock !== null && inStock >= b.qty) {
        li.appendChild(btn("Sortir du stock", { cls: "prj-btn is-take", icon: "take", title: "Retire " + b.qty + " de l'inventaire", on: async () => {
          S.taken = b.id;
          const out = await prun(p, "bom.use", { sub: b.id });
          if (out) toast(b.qty + " × « " + b.name + " » sortis de l'inventaire (reste " + out.inventory_item.qty + ")");
        } }));
      }
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }

  function editBom(p, b) {
    const isNew = !b;
    const cur = b || { name: "", qty: 1, unit: "", cost: null, status: "need", note: "", item: null };
    const name = el("input", { type: "text", maxlength: "120", value: cur.name, placeholder: "Ex. Servo MG996R, profilé 20×20", autocomplete: "off" });
    const qty = el("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(cur.qty) });
    const unit = el("input", { type: "text", maxlength: "16", value: cur.unit, placeholder: "pcs, m…" });
    const cost = el("input", { type: "text", inputmode: "decimal", value: cur.cost === null ? "" : (cur.cost / 100).toFixed(2).replace(".", ","), placeholder: "0,00" });
    const status = el("select", {}, Object.keys(BOM_LABEL).map((k) => el("option", { value: k, text: BOM_LABEL[k], selected: k === cur.status })));
    const item = el("select", {});
    item.appendChild(el("option", { value: "", text: S.invItems.length ? "Aucun" : "Inventaire vide ou indisponible" }));
    const sorted = S.invItems.slice().sort((a, c) => a.name.localeCompare(c.name, "fr", { numeric: true }));
    for (const i of sorted) {
      const place = i.place && S.invPlaces && S.invPlaces.get(i.place);
      item.appendChild(el("option", { value: i.id, text: i.name + " — " + i.qty + (i.unit ? " " + i.unit : "") + (place ? " (" + place.name + ")" : ""), selected: i.id === cur.item }));
    }
    if (!cur.item) item.value = "";
    item.addEventListener("change", () => {
      const i = S.invItems.find((x) => x.id === item.value);
      if (i && !name.value.trim()) name.value = i.name;
      if (i && !unit.value.trim()) unit.value = i.unit;
    });
    const note = el("textarea", { rows: "2", maxlength: "2000", placeholder: "Fournisseur, lien, référence…" });
    note.value = cur.note;
    const body = el("div", { class: "prj-form" }, [
      field("Objet de l'inventaire", item, "Relie la pièce à ce que tu as déjà : tu pourras la sortir du stock en un geste."),
      field("Pièce", name),
      el("div", { class: "prj-row" }, [field("Quantité", qty), field("Unité", unit), field("Prix unitaire", cost)]),
      field("État", status),
      field("Note", note),
    ]);
    const save = btn(isNew ? "Ajouter" : "Enregistrer", { cls: "prj-btn is-primary prj-save", on: async () => {
      const c = parseMoney(cost.value);
      if (Number.isNaN(c)) {
        cost.focus();
        toast("Prix illisible (ex. 12,99)", null, null, true);
        return;
      }
      const fields = { name: name.value, qty: Math.max(1, parseInt(qty.value, 10) || 1), unit: unit.value, cost: c, status: status.value, note: note.value, item: item.value || null };
      const out = isNew ? await prun(p, "bom.add", { bom: fields }) : await prun(p, "bom.update", { sub: b.id, bom: fields });
      if (out) closeSheet();
    } });
    const foot = [save];
    if (!isNew) foot.unshift(btn("Supprimer", { cls: "prj-btn is-danger", icon: "trash", on: async () => {
      closeSheet();
      await prun(p, "bom.delete", { sub: b.id }, "Pièce retirée de la liste");
    } }));
    openSheet(isNew ? "Nouvelle pièce" : b.name, body, foot);
  }

  // ---- links

  function linksView(p) {
    const wrap = el("div", { class: "prj-links" });
    wrap.appendChild(el("div", { class: "prj-links-head" }, [btn("Lier quelque chose", { cls: "prj-btn is-primary", icon: "link", on: () => addLink(p) })]));
    if (!p.links.length) {
      wrap.appendChild(el("p", { class: "prj-empty", text: "Relie les pages du Carnet, les images de la Forge, les dessins cotés et les fichiers qui servent à ce projet." }));
      return wrap;
    }
    const ul = el("ul", { class: "prj-link-list" });
    for (const lk of p.links) {
      const li = el("li", { class: "prj-link is-" + lk.kind, "data-flip": "l:" + lk.id });
      const thumb = el("span", { class: "prj-link-thumb", "aria-hidden": "true" });
      if (lk.kind === "forge") thumb.appendChild(el("img", { src: "/api/forge/gallery/" + encodeURIComponent(lk.ref) + "/thumb", alt: "", loading: "lazy" }));
      else if (lk.kind === "drawing") thumb.appendChild(el("img", { src: "/api/drawings/file?stem=" + encodeURIComponent(lk.ref) + "&kind=png", alt: "", loading: "lazy" }));
      else thumb.appendChild(icon(LINK_ICON[lk.kind]));
      const open = el("button", { type: "button", class: "prj-link-open" }, [thumb, el("span", { class: "prj-link-text" }, [el("span", { class: "prj-link-title", text: lk.title || lk.ref }), el("span", { class: "prj-link-kind", text: LINK_LABEL[lk.kind] })])]);
      open.addEventListener("click", () => openLink(lk));
      li.append(open, btn("", { cls: "prj-mini", icon: "close", aria: "Retirer le lien " + (lk.title || lk.ref), on: () => prun(p, "link.delete", { sub: lk.id }, "Lien retiré") }));
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }

  function openLink(lk) {
    if (lk.kind === "carnet") {
      if (typeof S.win.setView === "function") S.win.setView("carnet");
      if (typeof S.win.hqCarnetOpen !== "function" && typeof S.win.hqCarnetLoad === "function") {
        S.win.hqCarnetLoad().then(() => { if (typeof S.win.hqCarnetOpen === "function") S.win.hqCarnetOpen(lk.ref); }).catch(() => {});
        return;
      }
      if (typeof S.win.hqCarnetOpen === "function") S.win.hqCarnetOpen(lk.ref);
      return;
    }
    const href = linkHref(lk);
    if (href) S.win.open(href, "_blank", "noopener");
  }

  async function addLink(p) {
    const kind = el("select", {}, Object.keys(LINK_LABEL).map((k) => el("option", { value: k, text: LINK_LABEL[k] })));
    const host = el("div", { class: "prj-pick" });
    let choice = null;
    let turn = 0;
    const paint = async () => {
      const mine = (turn += 1); // a slow list that arrives after the kind changed is dropped
      choice = null;
      host.textContent = "";
      host.appendChild(el("p", { class: "prj-hint", text: "Chargement…" }));
      const k = kind.value;
      const pickList = (rows) => {
        if (mine !== turn) return;
        host.textContent = "";
        if (!rows.length) {
          host.appendChild(el("p", { class: "prj-hint", text: "Rien à lier pour l'instant." }));
          return;
        }
        const grid = el("div", { class: "prj-pick-grid" + (k === "forge" ? " is-images" : "") });
        for (const r of rows) {
          if (p.links.some((x) => x.kind === k && x.ref === r.ref)) continue;
          const b = el("button", { type: "button", class: "prj-pick-item", "aria-pressed": "false" });
          if (r.thumb) b.appendChild(el("img", { src: r.thumb, alt: "", loading: "lazy" }));
          if (r.title) b.appendChild(el("span", { class: "prj-pick-title", text: r.title }));
          if (r.sub) b.appendChild(el("span", { class: "prj-pick-sub", text: r.sub }));
          b.addEventListener("click", () => {
            for (const x of grid.querySelectorAll("[aria-pressed=true]")) x.setAttribute("aria-pressed", "false");
            b.setAttribute("aria-pressed", "true");
            choice = r;
          });
          grid.appendChild(b);
        }
        host.appendChild(grid);
      };
      try {
        if (k === "carnet") {
          const nb = await call("/api/carnet?meta=1");
          pickList((nb.pages || []).filter((x) => !x.deleted_at).sort((a, b) => b.updated_at - a.updated_at).slice(0, 200).map((x) => ({ ref: x.id, title: x.title || "Sans titre", sub: x.preview || "" })));
        } else if (k === "forge") {
          const g = await call("/api/forge/gallery?limit=48");
          pickList((g.images || []).map((x) => ({ ref: x.id, thumb: x.thumb, title: "" })));
        } else if (k === "drawing") {
          const d = await call("/api/drawings");
          pickList((d.items || []).map((x) => ({ ref: x.stem, title: x.stem.replace(/_HQWeb-(Mobile|Desktop)$/, ""), sub: [x.dxf ? "DXF" : "", x.stl ? "STL" : ""].filter(Boolean).join(" · "), thumb: x.png ? "/api/drawings/file?stem=" + encodeURIComponent(x.stem) + "&kind=png" : "" })));
        } else {
          host.textContent = "";
          const path = el("input", { type: "text", placeholder: "Uni/GIA1077/plan.pdf", autocomplete: "off" });
          const title = el("input", { type: "text", maxlength: "120", placeholder: "Nom affiché (facultatif)" });
          path.addEventListener("input", () => {
            const v = path.value.trim().replace(/^\/+/, "").replace(/\\/g, "/");
            choice = v ? { ref: v, title: title.value.trim() || v.split("/").pop() } : null;
          });
          title.addEventListener("input", () => path.dispatchEvent(new Event("input")));
          host.append(field("Chemin dans Transfert", path, "Le chemin tel qu'il apparaît dans Fichiers."), field("Nom", title));
        }
      } catch (e) {
        if (mine !== turn) return;
        host.textContent = "";
        host.appendChild(el("p", { class: "prj-hint is-warn", text: (e && e.message) || "Liste indisponible" }));
      }
    };
    kind.addEventListener("change", paint);
    const body = el("div", { class: "prj-form" }, [field("Quoi", kind), host]);
    const save = btn("Lier", { cls: "prj-btn is-primary prj-save", on: async () => {
      if (!choice) {
        toast("Choisis d'abord ce que tu veux lier", null, null, true);
        return;
      }
      const out = await prun(p, "link.add", { link: { kind: kind.value, ref: choice.ref, title: (choice.title || "").slice(0, 120) } }, "Lien ajouté");
      if (out) closeSheet();
    } });
    openSheet("Lier au projet", body, [save]);
    paint();
  }

  // ---- journal (photo log)

  function logView(p) {
    const wrap = el("div", { class: "prj-log" });
    wrap.appendChild(composer(p));
    if (!p.timeline.length) {
      wrap.appendChild(el("p", { class: "prj-empty", text: "Le journal garde l'histoire du projet : une photo à chaque étape, un mot sur ce qui a marché ou cassé." }));
      return wrap;
    }
    const ol = el("ol", { class: "prj-log-list" });
    const fmt = (ts) => {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric", month: "long", year: "numeric" }) + " · " + d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
    };
    for (const e of p.timeline.slice().reverse()) {
      const li = el("li", { class: "prj-log-entry" + (S.landed === e.id ? " is-landed" : ""), "data-flip": "e:" + e.id });
      li.appendChild(el("time", { class: "prj-log-when", datetime: new Date(e.at * 1000).toISOString(), text: fmt(e.at) }));
      if (e.photos.length) {
        const g = el("div", { class: "prj-log-photos is-" + Math.min(e.photos.length, 3) });
        for (const id of e.photos) {
          const a = el("a", { href: "/api/carnet/asset/" + id, target: "_blank", rel: "noopener", class: "prj-log-photo" }, [el("img", { src: "/api/carnet/asset/" + id, alt: "", loading: "lazy", decoding: "async" })]);
          g.appendChild(a);
        }
        li.appendChild(g);
      }
      if (e.text) li.appendChild(el("p", { class: "prj-log-text", text: e.text }));
      li.appendChild(btn("", { cls: "prj-mini prj-log-del", icon: "trash", aria: "Supprimer cette entrée", on: async () => {
        const out = await prun(p, "entry.delete", { sub: e.id });
        if (out) toast("Entrée supprimée");
      } }));
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
    return wrap;
  }

  function composer(p) {
    const photos = [];
    const box = el("div", { class: "prj-compose" });
    const text = el("textarea", { rows: "2", maxlength: "2000", placeholder: "Où en est le projet ?", "aria-label": "Nouvelle entrée du journal" });
    const post2 = btn("Publier", { cls: "prj-btn is-primary prj-save", on: async () => {
      if (!text.value.trim() && !photos.length) {
        text.focus();
        return;
      }
      post2.disabled = true;
      const out = await prun(p, "entry.add", { entry: { text: text.value, photos: photos.slice() } });
      post2.disabled = false;
      if (out) {
        S.landed = out.entry.id;
        render();
      }
    } });
    box.append(text, el("div", { class: "prj-compose-row" }, [photoPicker(photos, 6, "Photo"), post2]));
    return box;
  }

  // ---- project editor

  function editProject(p) {
    const isNew = !p;
    const cur = p || { name: "", status: "active", goal: "", hue: Math.floor(Math.random() * 360), start: today(), due: null, cover: null };
    const name = el("input", { type: "text", maxlength: "120", value: cur.name, placeholder: "Ex. Bras robot 4 axes, étagère du garage", autocomplete: "off" });
    const status = el("select", {}, STATUS.map(([k, lab]) => el("option", { value: k, text: lab, selected: k === cur.status })));
    const goal = el("textarea", { rows: "3", maxlength: "4000", placeholder: "Ce que tu veux obtenir à la fin" });
    goal.value = cur.goal;
    const start = el("input", { type: "date", value: cur.start || "" });
    const due = el("input", { type: "date", value: cur.due || "" });
    let h = cur.hue;
    const swatches = el("div", { class: "prj-hues", role: "radiogroup", "aria-label": "Couleur" });
    for (const v of [4, 28, 46, 96, 152, 174, 200, 222, 262, 292, 322, 346]) {
      const s = el("button", { type: "button", class: "prj-hue", role: "radio", "aria-checked": String(Math.abs(v - h) < 8), "aria-label": "Teinte " + v });
      s.style.setProperty("--hue", String(v));
      s.addEventListener("click", () => {
        h = v;
        for (const x of swatches.children) x.setAttribute("aria-checked", String(x === s));
      });
      swatches.appendChild(s);
    }
    const cover = cur.cover ? [cur.cover] : [];
    const body = el("div", { class: "prj-form" }, [
      field("Nom", name),
      field("Objectif", goal),
      el("div", { class: "prj-row" }, [field("Statut", status), field("Début", start), field("Échéance", due)]),
      el("div", { class: "prj-field" }, [el("span", { class: "prj-flabel", text: "Couleur" }), swatches]),
      el("div", { class: "prj-field" }, [el("span", { class: "prj-flabel", text: "Photo de couverture" }), photoPicker(cover, 1, "Photo")]),
    ]);
    const save = btn(isNew ? "Créer le projet" : "Enregistrer", { cls: "prj-btn is-primary prj-save", on: async () => {
      if (!name.value.trim()) {
        name.focus();
        toast("Donne un nom au projet", null, null, true);
        return;
      }
      const fields = { name: name.value, status: status.value, goal: goal.value, hue: h, start: start.value || null, due: due.value || null, cover: cover[0] || null };
      save.disabled = true;
      const out = isNew ? await run(Object.assign({ action: "project.create" }, fields)) : await prun(p, "project.update", fields);
      save.disabled = false;
      if (out) {
        closeSheet();
        if (isNew) {
          S.landed = out.project.id;
          go(out.project.id, "tasks");
        }
      }
    } });
    openSheet(isNew ? "Nouveau projet" : p.name, body, [save]);
  }

  async function deleteProject(p) {
    const n = tasksOf(S.data.tasks, p.id, known()).length;
    const body = el("div", { class: "prj-form" }, [el("p", { text: "« " + p.name + " » et ses jalons, pièces, liens et journal seront supprimés." + (n ? " Ses " + n + " tâches restent sur le tableau, dans Tâches libres, et reviennent si tu annules." : "") })]);
    const ok = btn("Supprimer le projet", { cls: "prj-btn is-danger-fill prj-save", on: async () => {
      closeSheet();
      const out = await prun(p, "project.delete");
      if (out) {
        go("");
        toast("« " + p.name + " » supprimé", "Annuler", async () => {
          const back = await run({ action: "project.restore", project: out.deleted }, "Projet rétabli");
          if (back) go(back.project.id);
        });
      }
    } });
    openSheet("Supprimer « " + p.name + " » ?", body, [btn("Annuler", { on: () => closeSheet() }), ok]);
  }

  // ---------------------------------------------------------------- lifecycle

  function visible() {
    return S.doc.body && S.doc.body.dataset.view === "projets" && S.doc.visibilityState !== "hidden";
  }

  function poll() {
    if (S.pollTimer) S.win.clearTimeout(S.pollTimer);
    S.pollTimer = S.win.setTimeout(async () => {
      if (visible() && !S.sheet && !S.drag && !(S.doc.activeElement && S.doc.activeElement.closest && S.doc.activeElement.closest(".prj input,.prj textarea"))) await load();
      poll();
    }, POLL_MS);
  }

  function show() {
    S.enter = true;
    S.pct = new Map();
    if (!S.app) S.app = S.doc.getElementById("hq-prj-app");
    if (!S.app) return;
    if (!S.mainEl) build();
    load();
    poll();
  }

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    win.hqProjectsShow = show;
    win.addEventListener("hashchange", () => fromHash(win.location.hash));
    S.doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && S.sheet) {
        ev.preventDefault();
        ev.stopPropagation();
        closeSheet();
      }
    }, true);
    S.doc.addEventListener("visibilitychange", () => {
      if (visible()) load();
    });
    const boot = () => {
      S.app = S.doc.getElementById("hq-prj-app");
      if (HASH_RE.test(win.location.hash)) win.setTimeout(() => fromHash(win.location.hash), 0);
      else if (S.doc.body.dataset.view === "projets") show();
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure, show };
});
