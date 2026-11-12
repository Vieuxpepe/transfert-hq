/* Transfert HQ — Inventaire: what you own and where it is.
 *
 * Places nest (room > shelf > box); items have a quantity, a unit, an optional low-stock threshold, tags, a note and photos
 * (stored in the Carnet image store). Every place has a QR label: the iPhone Camera app opens /#inventaire/<place id>.
 *
 * Talks only to /api/inventory and the Carnet image endpoints (/api/carnet/asset). Never builds HTML from strings.
 * Plain ES2020. Pure helpers exported for Node tests (tests/check_hq_inventory.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqInventory = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const KINDS = [
    ["room", "Pièce"],
    ["furniture", "Meuble"],
    ["shelf", "Étagère"],
    ["drawer", "Tiroir"],
    ["box", "Boîte"],
    ["bag", "Sac"],
    ["other", "Autre"],
  ];
  const KIND_LABEL = Object.fromEntries(KINDS);
  // each kind of place has its own lid colour (hue on the HQ palette); everything else stays steel
  const KIND_HUE = { room: 168, furniture: 34, shelf: 262, drawer: 340, box: 205, bag: 96, other: 220 };
  const PLACE_RE = /^plc-[0-9a-f]{16}$/;
  const HASH_RE = /^#inventaire(?:\/(plc-[0-9a-f]{16}|sans-emplacement|objet\/itm-[0-9a-f]{16}))?$/;
  const PROJECT_LIVE = { active: 1, idea: 1, paused: 1 }; // a finished project no longer holds stock
  const PHOTO_MAX_SIDE = 1600;
  const POLL_MS = 20000;

  // ------------------------------------------------------------------ pure helpers

  function fold(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  /** Index: children per place (sorted by name), items per place (key "" = no place). */
  function index(doc) {
    const places = new Map();
    const kids = new Map();
    const items = new Map();
    for (const p of doc.places || []) places.set(p.id, p);
    const byName = (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" });
    for (const p of doc.places || []) {
      const k = p.parent && places.has(p.parent) ? p.parent : "";
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(p);
    }
    for (const i of doc.items || []) {
      const k = i.place && places.has(i.place) ? i.place : "";
      if (!items.has(k)) items.set(k, []);
      items.get(k).push(i);
    }
    for (const l of kids.values()) l.sort(byName);
    for (const l of items.values()) l.sort(byName);
    return { places, kids, items };
  }

  /** Root-first chain of places ending at ``pid``. */
  function pathOf(ix, pid) {
    const out = [];
    let cur = pid;
    const seen = new Set();
    while (cur && ix.places.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      out.push(ix.places.get(cur));
      cur = ix.places.get(cur).parent;
    }
    return out.reverse();
  }

  function pathText(ix, pid) {
    const p = pathOf(ix, pid);
    return p.length ? p.map((x) => x.name).join(" › ") : "Sans emplacement";
  }

  /** Every place under ``pid`` (not included), depth-first. */
  function descendants(ix, pid) {
    const out = [];
    const walk = (id) => {
      for (const k of ix.kids.get(id) || []) {
        out.push(k);
        walk(k.id);
      }
    };
    walk(pid);
    return out;
  }

  /** Items in ``pid`` and everything below it. */
  function countDeep(ix, pid) {
    let n = (ix.items.get(pid) || []).length;
    for (const d of descendants(ix, pid)) n += (ix.items.get(d.id) || []).length;
    return n;
  }

  const isLow = (i) => i.min !== null && i.min !== undefined && i.qty <= i.min;

  /** Search: every word must appear in the item's name, tags, note, unit or place path (accents and case ignored). */
  function search(doc, ix, q) {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return { items: [], places: [] };
    const items = [];
    for (const i of doc.items || []) {
      const hay = fold([i.name, i.tags.map((t) => "#" + t).join(" "), i.note, i.unit, pathText(ix, i.place)].join(" "));
      if (words.every((w) => hay.includes(w))) items.push(i);
    }
    const places = [];
    for (const p of doc.places || []) {
      const hay = fold([p.name, p.code, p.note, KIND_LABEL[p.kind] || ""].join(" "));
      if (words.every((w) => hay.includes(w))) places.push(p);
    }
    const score = (name) => (fold(name).startsWith(words[0]) ? 0 : 1);
    items.sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name, "fr", { numeric: true }));
    places.sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name, "fr", { numeric: true }));
    return { items: items.slice(0, 200), places: places.slice(0, 50) };
  }

  /** "vis, #M4  écrous" -> ["vis", "m4", "écrous"] (unique, lowercase). */
  function parseTags(s) {
    const out = [];
    for (const t of String(s || "").split(/[,;\s]+/)) {
      const v = t.replace(/^#+/, "").trim().toLowerCase().slice(0, 32);
      if (v && !out.includes(v)) out.push(v);
    }
    return out.slice(0, 12);
  }

  /** The link a printed label opens. ``base`` is a server-built URL (Serve / Tailscale / LAN) or this page's origin. */
  function labelUrl(base, pid) {
    const b = String(base || "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/?#]+$/.test(b) || !PLACE_RE.test(pid)) return "";
    return b + "/#inventaire/" + pid;
  }

  /** Place picker options: [{id, label, depth}] in tree order. ``exclude`` drops a place and its subtree (no cycles). */
  function placeOptions(ix, exclude) {
    const out = [];
    const walk = (id, depth) => {
      for (const k of ix.kids.get(id) || []) {
        if (k.id === exclude) continue;
        out.push({ id: k.id, label: k.name, depth });
        walk(k.id, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  function fmtQty(i) {
    return String(i.qty).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (i.unit ? " " + i.unit : "");
  }

  /** Where an item is used: [{project, line}] over every project's parts list. */
  function usage(projects, id) {
    const out = [];
    for (const p of projects || []) for (const b of p.bom || []) if (b.item === id) out.push({ project: p, line: b });
    return out;
  }

  /** How many are promised to live projects and not yet taken out of the stock. */
  function reserved(projects, id) {
    let n = 0;
    for (const u of usage(projects, id)) if (PROJECT_LIVE[u.project.status] && !u.line.used) n += u.line.qty;
    return n;
  }

  const pure = { usage, reserved, fold, index, pathOf, pathText, descendants, countDeep, isLow, search, parseTags, labelUrl, placeOptions, fmtQty, HASH_RE };

  // ------------------------------------------------------------------ browser layer

  const S = {
    started: false, win: null, doc: null, app: null,
    data: null, ix: null, rev: -1, loading: false, failed: "",
    sel: "", q: "", filter: "all", open: new Set(), pollTimer: 0,
    bodyEl: null, treeEl: null, mainEl: null, searchEl: null, chips: null, sheet: null, toastEl: null, toastTimer: 0,
    landed: "", bump: "", projects: null, enter: true, gauges: new Map(), justOpened: "", lowFlash: "", newPhoto: "",
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON = {
    room: "M4 10.5 12 4l8 6.5V20H4z",
    furniture: "M4 6h16v12H4zM4 12h16M12 6v12",
    shelf: "M4 5h16M4 12h16M4 19h16M6 5v14M18 5v14",
    drawer: "M4 6h16v12H4zM4 12h16M10 9h4M10 15h4",
    box: "M12 3.5l8 4v9l-8 4-8-4v-9zM4 7.5l8 4 8-4M12 11.5v9",
    bag: "M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2",
    other: "M5 5h14v14H5z",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.6-4.6",
    qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z",
    edit: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM4 20h7",
    trash: "M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13",
    move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
    camera: "M4 8h3l2-2.5h6L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    image: "M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 17l5-5 4 4 3-3 4 4",
    chevron: "M9 6l6 6-6 6",
    close: "M6 6l12 12M18 6L6 18",
    print: "M7 8V4h10v4M6 17H4v-7h16v7h-2M7 14h10v6H7z",
    warn: "M12 4l9 16H3zM12 10v4M12 17v.5",
    tag: "M4 4h7l9 9-7 7-9-9zM8 8h.01",
    project: "M14.5 6.5l3 3M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM4 4h6M4 8h3",
    open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    home: "M4 10.5 12 4l8 6.5V20H4z",
  };

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
    s.setAttribute("class", "inv-ico" + (cls ? " " + cls : ""));
    const p = S.doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICON[name] || ICON.other);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.8");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }

  function btn(label, opts) {
    const o = opts || {};
    const b = el("button", { type: "button", class: o.cls || "secondary", "aria-label": o.aria || null, title: o.title || null, on: o.on ? { click: o.on } : null });
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

  function buzz(ms) {
    try {
      if (S.win.navigator.vibrate) S.win.navigator.vibrate(ms);
    } catch (_) {}
  }

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

  async function post(body) {
    const out = await call("/api/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return out;
  }

  /** Merge one write's answer into the local copy so the screen updates at once. */
  function absorb(out) {
    if (!out || !S.data) return;
    const put = (list, rec) => {
      const k = list.findIndex((x) => x.id === rec.id);
      if (k >= 0) list[k] = rec;
      else list.push(rec);
    };
    if (out.place) put(S.data.places, out.place);
    if (out.item) put(S.data.items, out.item);
    if (out.items) for (const i of out.items) put(S.data.items, i);
    if (out.deleted) {
      const list = out.deleted.id.startsWith("plc-") ? S.data.places : S.data.items;
      const k = list.findIndex((x) => x.id === out.deleted.id);
      if (k >= 0) list.splice(k, 1);
    }
    if (out.moved) {
      for (const p of S.data.places) if (out.moved.places.includes(p.id)) p.parent = out.moved.to;
      for (const i of S.data.items) if (out.moved.items.includes(i.id)) i.place = out.moved.to;
    }
    // our own write moved the store one step: a later poll still sees any other device's change
    if (typeof out.rev === "number" && out.rev === S.rev + 1) S.rev = out.rev;
    S.ix = index(S.data);
  }

  async function load(force) {
    if (S.loading) return;
    S.loading = true;
    try {
      const out = await call("/api/inventory" + (!force && S.rev >= 0 ? "?since=" + S.rev : ""));
      if (!out.unchanged) {
        S.data = { places: out.places, items: out.items };
        S.ix = index(S.data);
        S.limits = out.limits || {};
      }
      S.rev = out.rev;
      S.failed = "";
      if (S.sel && S.sel !== "none" && !S.ix.places.has(S.sel)) S.sel = "";
    } catch (e) {
      S.failed = (e && e.message) || "Inventaire indisponible";
    } finally {
      S.loading = false;
    }
    render();
  }

  async function run(body, okMsg) {
    try {
      const out = await post(body);
      absorb(out);
      render();
      if (okMsg) toast(okMsg);
      return out;
    } catch (e) {
      if (e && e.status === 409 && e.data && (e.data.item || e.data.place)) {
        absorb({ item: e.data.item, place: e.data.place });
        render();
        toast("Modifié sur un autre appareil — version actuelle affichée");
      } else toast((e && e.message) || "Échec", null, null, true);
      return null;
    }
  }

  // ---------------------------------------------------------------- toast with optional undo

  function toast(text, action, onAction, bad) {
    if (!S.toastEl) return;
    const t = S.toastEl;
    t.textContent = "";
    t.classList.toggle("is-bad", !!bad);
    t.appendChild(el("span", { text }));
    if (action && onAction) {
      t.appendChild(btn(action, { cls: "inv-toast-act", on: () => {
        hideToast();
        onAction();
      } }));
    }
    t.hidden = false;
    t.classList.remove("is-in");
    void t.offsetWidth;
    t.classList.add("is-in");
    if (S.toastTimer) S.win.clearTimeout(S.toastTimer);
    S.toastTimer = S.win.setTimeout(hideToast, action ? 7000 : 3200);
  }

  function hideToast() {
    if (S.toastEl) S.toastEl.hidden = true;
  }

  // ---------------------------------------------------------------- navigation

  function go(sel, opts) {
    if ((sel || "") !== S.sel) S.enter = true;
    S.sel = sel || "";
    const o = opts || {};
    if (S.sel && S.sel !== "none") for (const p of pathOf(S.ix, S.sel)) if (p.id !== S.sel) S.open.add(p.id);
    if (!o.keepSearch && S.q) {
      S.q = "";
      if (S.searchEl) S.searchEl.value = "";
    }
    const hash = S.sel === "none" ? "#inventaire/sans-emplacement" : S.sel ? "#inventaire/" + S.sel : "#inventaire";
    try {
      if (S.win.location.hash !== hash && !o.fromHash) S.win.history.replaceState(null, "", hash);
    } catch (_) {}
    render();
    openFromDrawer();
    if (!o.noScroll && S.mainEl) {
      try {
        S.mainEl.scrollIntoView({ block: "nearest" });
      } catch (_) {}
    }
  }

  /** The one orchestrated moment: the drawer you tapped slides out and becomes the place's header. */
  function openFromDrawer() {
    const from = S.openFrom;
    S.openFrom = null;
    const head = S.mainEl && S.mainEl.querySelector(".inv-place-head");
    if (!from || !head || calm() || typeof head.animate !== "function") return;
    const to = head.getBoundingClientRect();
    if (!to.width) return;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    head.animate([
      { transformOrigin: "0 0", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")", opacity: 0.6 },
      { transformOrigin: "0 0", transform: "translate(0,6px) scale(1.01,1.02)", opacity: 1, offset: 0.7 },
      { transformOrigin: "0 0", transform: "none", opacity: 1 },
    ], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
    const rest = S.mainEl.querySelectorAll(".inv-place-head ~ *");
    Array.prototype.forEach.call(rest, (n, k) => n.animate([{ opacity: 0, transform: "translate3d(0,14px,0)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: 160 + k * 40, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  }

  function fromHash(h) {
    const m = HASH_RE.exec(h || "");
    if (!m) return false;
    if (typeof S.win.setView === "function" && S.doc.body.dataset.view !== "inventaire") S.win.setView("inventaire");
    let target = m[1] === "sans-emplacement" ? "none" : m[1] || "";
    if (target.startsWith("objet/")) {
      // a part of a project points here: open the item where it is stored
      const id = target.slice(6);
      S.openItem = id;
      const it = S.data && S.data.items.find((x) => x.id === id);
      target = it ? it.place || "none" : "";
      if (S.data && !it) {
        S.openItem = null;
        toast("Cet objet n'est plus dans l'inventaire");
      }
    }
    S.pendingSel = target;
    if (!S.data) show();
    else {
      S.pendingSel = null;
      if (target && target !== "none" && !S.ix.places.has(target)) {
        toast("Cet emplacement n'existe plus");
        go("", { fromHash: true });
      } else {
        S.landed = S.openItem || target;
        go(target, { fromHash: true });
        openPendingItem();
      }
    }
    return true;
  }

  function openPendingItem() {
    const id = S.openItem;
    S.openItem = null;
    const it = id && S.data && S.data.items.find((x) => x.id === id);
    if (it) S.win.setTimeout(() => editItem(it), calm() ? 0 : 420);
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!S.app) return;
    if (!S.bodyEl) build();
    if (S.failed && !S.data) {
      S.mainEl.textContent = "";
      S.mainEl.appendChild(el("div", { class: "inv-empty" }, [
        el("p", { text: "L'inventaire n'a pas pu se charger : " + S.failed }),
        btn("Réessayer", { on: () => load(true) }),
      ]));
      return;
    }
    if (!S.data) return;
    if (S.pendingSel !== null && S.pendingSel !== undefined) {
      let t = S.pendingSel;
      S.pendingSel = null;
      if (S.openItem) {
        const it = S.data.items.find((x) => x.id === S.openItem);
        if (it) t = it.place || "none";
        else {
          S.openItem = null;
          toast("Cet objet n'est plus dans l'inventaire");
        }
        S.win.setTimeout(openPendingItem, 0);
      }
      if (!t || t === "none" || S.ix.places.has(t)) {
        S.sel = t;
        S.landed = t;
        for (const p of pathOf(S.ix, t)) if (p.id !== t) S.open.add(p.id);
      }
    }
    for (const c of S.chips.querySelectorAll("[data-inv-filter]")) c.setAttribute("aria-pressed", String(c.getAttribute("data-inv-filter") === S.filter));
    const low = S.data.items.filter(isLow).length;
    const lowChip = S.chips.querySelector('[data-inv-filter="low"] .inv-count');
    if (lowChip) {
      lowChip.textContent = low ? String(low) : "";
      lowChip.hidden = !low;
    }
    renderTree();
    renderMain();
  }

  function build() {
    S.app.textContent = "";
    S.app.classList.add("inv");
    const top = el("div", { class: "inv-top" });
    const sb = el("label", { class: "inv-search" }, [icon("search")]);
    S.searchEl = el("input", { type: "search", placeholder: "Chercher un objet, une étiquette, une boîte…", "aria-label": "Chercher dans l'inventaire", autocomplete: "off", enterkeyhint: "search" });
    S.searchEl.addEventListener("input", () => {
      S.q = S.searchEl.value;
      renderMain();
    });
    S.searchEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && S.searchEl.value) {
        ev.preventDefault();
        S.searchEl.value = "";
        S.q = "";
        renderMain();
      }
    });
    sb.appendChild(S.searchEl);
    const actions = el("div", { class: "inv-actions" }, [
      btn("Objet", { cls: "inv-primary", icon: "plus", title: "Ajouter un objet ici", on: () => editItem(null) }),
      btn("Emplacement", { icon: "plus", title: "Ajouter un emplacement ici", on: () => editPlace(null) }),
    ]);
    top.append(sb, actions);
    S.chips = el("div", { class: "inv-chips", role: "group", "aria-label": "Filtre" });
    for (const [k, lab] of [["all", "Tout"], ["low", "Stock bas"], ["none", "Sans emplacement"]]) {
      const c = el("button", { type: "button", class: "inv-chip", "data-inv-filter": k, "aria-pressed": "false" }, [lab]);
      if (k === "low") {
        c.prepend(icon("warn"));
        c.appendChild(el("span", { class: "inv-count", hidden: true }));
      }
      c.addEventListener("click", () => {
        S.filter = k;
        if (k === "none") go("none");
        else if (S.sel === "none") go("");
        else render();
      });
      S.chips.appendChild(c);
    }
    S.bodyEl = el("div", { class: "inv-body" });
    S.treeEl = el("nav", { class: "inv-tree", "aria-label": "Emplacements" });
    S.mainEl = el("div", { class: "inv-main", "aria-live": "polite" });
    S.bodyEl.append(S.treeEl, S.mainEl);
    S.toastEl = el("div", { class: "inv-toast", role: "status", hidden: true });
    S.app.append(top, S.chips, S.bodyEl, S.toastEl);
    S.app.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && !ev.target.closest("input,textarea,select") && !S.sheet) {
        ev.preventDefault();
        S.searchEl.focus();
      }
    });
  }

  function renderTree() {
    const t = S.treeEl;
    t.textContent = "";
    const head = el("button", { type: "button", class: "inv-tree-row inv-tree-home" + (S.sel === "" ? " is-sel" : ""), on: { click: () => go("") } }, [icon("home"), el("span", { text: "Tout l'inventaire" }), el("span", { class: "inv-n", text: String(S.data.items.length) })]);
    t.appendChild(head);
    const ul = el("ul", { class: "inv-tree-list", role: "tree" });
    const walk = (pid, host, depth) => {
      for (const p of S.ix.kids.get(pid) || []) {
        const kids = S.ix.kids.get(p.id) || [];
        const open = S.open.has(p.id);
        const li = el("li", { role: "treeitem", "aria-expanded": kids.length ? String(open) : null, "aria-selected": String(S.sel === p.id) });
        const row = el("div", { class: "inv-tree-row" + (S.sel === p.id ? " is-sel" : ""), style: "--d:" + depth });
        const tw = el("button", { type: "button", class: "inv-twisty" + (open ? " is-open" : ""), "aria-label": (open ? "Replier " : "Déplier ") + p.name, tabindex: "-1", hidden: !kids.length }, [icon("chevron")]);
        tw.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (open) S.open.delete(p.id);
          else {
            S.open.add(p.id);
            S.justOpened = p.id;
          }
          renderTree();
          S.justOpened = "";
        });
        const main = el("button", { type: "button", class: "inv-tree-go", "data-inv-place": p.id }, [icon(p.kind), el("span", { class: "inv-tree-name", text: p.name }), el("span", { class: "inv-n", text: String(countDeep(S.ix, p.id)) })]);
        main.style.setProperty("--hue", String(KIND_HUE[p.kind] || 220));
        main.addEventListener("click", () => go(p.id));
        row.append(tw, main);
        li.appendChild(row);
        if (kids.length && open) {
          const sub = el("ul", { role: "group", class: S.justOpened === p.id ? "is-opening" : null });
          walk(p.id, sub, depth + 1);
          li.appendChild(sub);
        }
        host.appendChild(li);
      }
    };
    walk("", ul, 0);
    t.appendChild(ul);
    const none = (S.ix.items.get("") || []).length;
    t.appendChild(el("button", { type: "button", class: "inv-tree-row inv-tree-none" + (S.sel === "none" ? " is-sel" : ""), on: { click: () => go("none") } }, [icon("other"), el("span", { text: "Sans emplacement" }), el("span", { class: "inv-n", text: String(none) })]));
  }

  function crumbs() {
    const nav = el("nav", { class: "inv-crumbs", "aria-label": "Chemin" });
    nav.appendChild(btn("Tout", { cls: "inv-crumb", on: () => go("") }));
    if (S.sel === "none") {
      nav.append(icon("chevron", "inv-sep"), el("span", { class: "inv-crumb is-here", text: "Sans emplacement" }));
      return nav;
    }
    const chain = pathOf(S.ix, S.sel);
    chain.forEach((p, k) => {
      nav.appendChild(icon("chevron", "inv-sep"));
      if (k === chain.length - 1) nav.appendChild(el("span", { class: "inv-crumb is-here", "aria-current": "location", text: p.name }));
      else nav.appendChild(btn(p.name, { cls: "inv-crumb", on: () => go(p.id) }));
    });
    return nav;
  }

  function renderMain() {
    const m = S.mainEl;
    if (!m || !S.data) return;
    S.flipBefore = S.enter ? null : flipCapture();
    m.textContent = "";
    m.classList.toggle("is-enter", !!S.enter && !calm());
    if (S.q.trim()) {
      renderSearch(m);
      finishRender();
      return;
    }
    if (S.filter === "low") {
      const low = S.data.items.filter(isLow);
      m.appendChild(el("h3", { class: "inv-h", text: "À racheter" }));
      if (!low.length) m.appendChild(el("p", { class: "inv-empty", text: "Rien sous son seuil. Donne un seuil à un objet pour le surveiller." }));
      else m.appendChild(itemGrid(low, true));
      finishRender();
      return;
    }
    if (S.sel !== "") m.appendChild(crumbs());
    if (S.sel === "none") {
      const list = S.ix.items.get("") || [];
      m.appendChild(el("h3", { class: "inv-h", text: "Sans emplacement" }));
      if (!list.length) m.appendChild(el("p", { class: "inv-empty", text: "Tout est rangé." }));
      else m.appendChild(itemGrid(list, false));
      finishRender();
      return;
    }
    const kids = S.ix.kids.get(S.sel) || [];
    const items = S.ix.items.get(S.sel) || [];
    if (S.sel) m.appendChild(placeHead(S.ix.places.get(S.sel)));
    else if (kids.length || S.data.items.length) m.appendChild(hero());
    if (kids.length) {
      if (S.sel) m.appendChild(el("h3", { class: "inv-h", text: "Dedans" }));
      const g = el("div", { class: "inv-places" + (S.sel ? "" : " is-cabinet") });
      kids.forEach((p, k) => g.appendChild(placeTile(p, k)));
      m.appendChild(g);
    }
    if (items.length || S.sel) {
      m.appendChild(el("h3", { class: "inv-h" }, ["Objets", items.length ? el("span", { class: "inv-h-n", text: String(items.length) }) : null]));
      if (items.length) m.appendChild(itemGrid(items, false));
      else m.appendChild(el("p", { class: "inv-empty" }, ["Rien ici pour l'instant. ", btn("Ajouter un objet", { cls: "inv-link", on: () => editItem(null) })]));
    }
    if (!S.sel && !kids.length) {
      m.appendChild(el("div", { class: "inv-welcome" }, [
        cabinetArt(),
        el("h3", { class: "inv-welcome-title", text: "Un tiroir pour chaque chose" }),
        el("p", { text: "Commence par une pièce ou un meuble, puis range des boîtes dedans. Chaque emplacement reçoit son étiquette QR : colle-la, scanne-la avec l'appareil photo de l'iPhone, et son contenu s'ouvre ici." }),
        btn("Créer un premier emplacement", { cls: "inv-primary", icon: "plus", on: () => editPlace(null) }),
      ]));
    }
    if (!S.sel && (S.ix.items.get("") || []).length && !kids.length) m.appendChild(itemGrid(S.ix.items.get(""), false));
    finishRender();
  }

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

  /** Drawers and items glide to their new place; new ones drop in; gauges move from their last level. */
  function flipPlay() {
    const before = S.flipBefore;
    S.flipBefore = null;
    if (before) {
      for (const n of S.mainEl.querySelectorAll("[data-flip]")) {
        const was = before.get(n.getAttribute("data-flip"));
        const r = n.getBoundingClientRect();
        if (was) {
          const dx = was.left - r.left;
          const dy = was.top - r.top;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) anim(n, [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: Math.min(560, 260 + Math.hypot(dx, dy) * 0.35), easing: "cubic-bezier(.2,1.35,.35,1)" });
        } else if (before.size) {
          anim(n, [{ opacity: 0, transform: "translate3d(0,-10px,0) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,1.35,.35,1)" });
        }
      }
    }
    for (const g of S.mainEl.querySelectorAll(".inv-gauge-fill[data-id]")) {
      const id = g.getAttribute("data-id");
      const to = Number(g.style.getPropertyValue("--f")) || 0;
      const from = S.gauges.has(id) ? S.gauges.get(id) : 0;
      if (Math.abs(to - from) > 0.001) anim(g, [{ width: from * 100 + "%" }, { width: to * 100 + "%" }], { duration: S.gauges.has(id) ? 420 : 800, easing: "cubic-bezier(.2,.8,.2,1)", delay: S.gauges.has(id) ? 0 : 250 });
      S.gauges.set(id, to);
    }
  }

  function finishRender() {
    flipPlay();
    S.enter = false;
    S.lowFlash = "";
    S.landed = "";
    S.bump = "";
    S.bumpDir = 0;
    if (S.mainEl && S.mainEl.querySelector(".inv-hero")) countUp(S.mainEl.querySelectorAll(".inv-hero [data-count]"));
  }

  /** The cabinet's name plate: what is in the inventory, in one sentence. */
  function hero() {
    const items = S.data.items.length;
    const places = S.data.places.length;
    const low = S.data.items.filter(isLow).length;
    const units = S.data.items.reduce((t, i) => t + i.qty, 0);
    const line = el("p", { class: "inv-hero-line" }, [
      el("strong", { "data-count": String(items), text: String(items) }), items > 1 ? " objets rangés dans " : " objet rangé dans ",
      el("strong", { "data-count": String(places), text: String(places) }), places > 1 ? " emplacements" : " emplacement",
      units > items ? "," : ".",
      units > items ? el("span", {}, [" soit ", el("strong", { "data-count": String(units), text: String(units) }), " pièces au total."]) : null,
    ]);
    const plate = el("div", { class: "inv-hero", role: "group", "aria-label": "Résumé" }, [
      el("div", { class: "inv-hero-plate" }, [
        el("span", { class: "inv-rivet", "aria-hidden": "true" }), el("span", { class: "inv-rivet", "aria-hidden": "true" }),
        el("h3", { class: "inv-hero-title", text: "Inventaire" }),
        line,
      ]),
    ]);
    if (low) {
      const b = btn(low > 1 ? low + " objets à racheter" : "1 objet à racheter", { cls: "inv-hero-low", icon: "warn", on: () => {
        S.filter = "low";
        render();
      } });
      plate.firstChild.appendChild(b);
    }
    return plate;
  }

  function countUp(nodes) {
    if (calm() || S.counted) return;
    S.counted = true; // once per visit: the plate counts up when you arrive, never on every tap
    const t0 = S.win.performance.now();
    const list = Array.prototype.map.call(nodes, (n) => ({ n, to: Number(n.getAttribute("data-count")) || 0 }));
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 900);
      const e = 1 - Math.pow(1 - k, 4);
      for (const x of list) x.n.textContent = String(Math.round(x.to * e));
      if (k < 1) S.win.requestAnimationFrame(step);
    };
    S.win.requestAnimationFrame(step);
  }

  /** The empty-cabinet drawing for a brand-new inventory (SVG built node by node). */
  function cabinetArt() {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 240 150");
    s.setAttribute("class", "inv-art");
    s.setAttribute("aria-hidden", "true");
    const add = (tag, attrs) => {
      const n = S.doc.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      s.appendChild(n);
      return n;
    };
    add("rect", { x: 20, y: 14, width: 200, height: 128, rx: 10, class: "a-body" });
    const hues = [168, 34, 262, 205, 340, 96];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 2; c += 1) {
        const x = 32 + c * 92;
        const y = 24 + r * 38;
        const open = r === 1 && c === 1;
        const g = add("g", { class: "a-drawer" + (open ? " is-open" : ""), style: "--hue:" + hues[r * 2 + c] });
        const put = (tag, attrs) => {
          const n = S.doc.createElementNS(SVG_NS, tag);
          for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
          g.appendChild(n);
        };
        if (open) {
          put("rect", { x: x - 4, y: y + 4, width: 92, height: 28, rx: 4, class: "a-inside" });
          put("circle", { cx: x + 22, cy: y + 12, r: 5, class: "a-thing" });
          put("rect", { x: x + 36, y: y + 7, width: 16, height: 10, rx: 2, class: "a-thing" });
          put("path", { d: "M" + (x + 60) + " " + (y + 16) + "l8-8l8 8z", class: "a-thing" });
        }
        put("rect", { x: open ? x - 6 : x, y: open ? y + 12 : y, width: open ? 92 : 84, height: 30, rx: 4, class: "a-face" });
        put("rect", { x: (open ? x - 6 : x) + 26, y: (open ? y + 12 : y) + 6, width: 32, height: 11, rx: 2, class: "a-label" });
        put("rect", { x: (open ? x - 6 : x) + 32, y: (open ? y + 12 : y) + 21, width: 20, height: 4, rx: 2, class: "a-handle" });
      }
    }
    return s;
  }

  function hueOf(pid) {
    const p = pid && S.ix.places.get(pid);
    return p ? KIND_HUE[p.kind] || 220 : 220;
  }

  function placeHead(p) {
    const head = el("header", { class: "inv-place-head" + (S.landed === p.id ? " is-landed" : "") });
    head.style.setProperty("--hue", String(KIND_HUE[p.kind] || 220));
    const kids = (S.ix.kids.get(p.id) || []).length;
    const deep = countDeep(S.ix, p.id);
    const low = [p.id].concat(descendants(S.ix, p.id).map((d) => d.id)).reduce((t, id) => t + (S.ix.items.get(id) || []).filter(isLow).length, 0);
    const photo = p.photos[0]
      ? el("img", { class: "inv-place-photo", src: "/api/carnet/asset/" + p.photos[0], alt: "", loading: "lazy", decoding: "async" })
      : el("div", { class: "inv-place-badge" }, [icon(p.kind)]);
    const holder = el("div", { class: "inv-place-holder" }, [
      el("h3", { class: "inv-title", text: p.name }),
      el("p", { class: "inv-meta" }, [
        el("span", { class: "inv-kind", text: KIND_LABEL[p.kind] || "" }),
        el("span", { class: "inv-fact", text: deep + (deep > 1 ? " objets" : " objet") }),
        kids ? el("span", { class: "inv-fact", text: kids + (kids > 1 ? " emplacements" : " emplacement") }) : null,
        low ? el("span", { class: "inv-fact is-warn", text: low + " à racheter" }) : null,
      ]),
    ]);
    if (p.note) holder.appendChild(el("p", { class: "inv-note", text: p.note }));
    const tape = el("span", { class: "inv-tape is-big", title: "Code de l'étiquette QR", "aria-label": "Code d'étiquette " + p.code, text: p.code });
    const acts = el("div", { class: "inv-place-acts" }, [
      btn("Étiquette", { icon: "qr", on: () => openLabels([p.id]) }),
      btn("", { icon: "edit", aria: "Modifier l'emplacement", title: "Modifier", on: () => editPlace(p) }),
      btn("", { icon: "trash", aria: "Supprimer l'emplacement", title: "Supprimer", cls: "secondary inv-danger", on: () => deletePlace(p) }),
    ]);
    head.append(photo, holder, tape, acts);
    return head;
  }

  /** Photos of what is inside a place (its items first, then deeper), for the drawer window. */
  function photosInside(pid, max) {
    const out = [];
    const take = (id) => {
      for (const i of S.ix.items.get(id) || []) {
        if (i.photos[0] && out.length < max) out.push(i.photos[0]);
      }
    };
    take(pid);
    for (const d of descendants(S.ix, pid)) {
      if (out.length >= max) break;
      take(d.id);
    }
    return out;
  }

  function placeTile(p, k) {
    const n = countDeep(S.ix, p.id);
    const sub = (S.ix.kids.get(p.id) || []).length;
    const low = [p.id].concat(descendants(S.ix, p.id).map((d) => d.id)).some((id) => (S.ix.items.get(id) || []).some(isLow));
    const b = el("button", { type: "button", class: "inv-tile inv-drawer" + (low ? " has-low" : ""), "data-inv-place": p.id, "data-flip": "p:" + p.id, "aria-label": p.name + ", " + n + (n > 1 ? " objets" : " objet") });
    b.style.setProperty("--hue", String(KIND_HUE[p.kind] || 220));
    b.style.setProperty("--k", String(Math.min(k, 12)));
    const win = el("span", { class: "inv-drawer-window", "aria-hidden": "true" });
    const pics = p.photos[0] ? [p.photos[0]] : photosInside(p.id, 3);
    if (pics.length) {
      pics.forEach((id, j) => {
        const img = el("img", { class: "inv-peek", src: "/api/carnet/asset/" + id, alt: "", loading: "lazy", decoding: "async" });
        img.style.setProperty("--j", String(j));
        img.style.setProperty("--n", String(pics.length));
        win.appendChild(img);
      });
    } else win.appendChild(icon(p.kind, "inv-drawer-ghost"));
    const holder = el("span", { class: "inv-holder" }, [
      el("span", { class: "inv-holder-name", text: p.name }),
      el("span", { class: "inv-holder-meta" }, [
        el("span", { text: n + (n > 1 ? " objets" : " objet") }),
        sub ? el("span", { text: sub + (sub > 1 ? " emplacements" : " emplacement") }) : null,
      ]),
    ]);
    b.append(win, holder, el("span", { class: "inv-handle", "aria-hidden": "true" }), el("span", { class: "inv-tape inv-tile-code", text: p.code }));
    if (low) b.appendChild(el("span", { class: "inv-drawer-flag", title: "Un objet est à racheter", "aria-hidden": "true" }));
    b.addEventListener("click", () => {
      S.openFrom = b.getBoundingClientRect();
      go(p.id);
    });
    return b;
  }

  function itemGrid(items, withPath) {
    const g = el("ul", { class: "inv-items" });
    items.forEach((i, k) => g.appendChild(itemCard(i, withPath, k)));
    return g;
  }

  /** Text with the searched words wrapped in <mark> (text nodes only; innerText is unchanged). */
  function marked(text, cls) {
    const span = el("span", { class: cls });
    const words = fold(S.q).split(/\s+/).filter((w) => w && !w.startsWith("#"));
    const src = String(text);
    const f = fold(src);
    if (!words.length || f.length !== src.length) {
      span.textContent = src;
      return span;
    }
    const hit = new Array(src.length).fill(false);
    for (const w of words) {
      let at = f.indexOf(w);
      while (at >= 0) {
        for (let x = at; x < at + w.length; x += 1) hit[x] = true;
        at = f.indexOf(w, at + w.length);
      }
    }
    let k = 0;
    while (k < src.length) {
      let e = k;
      while (e < src.length && hit[e] === hit[k]) e += 1;
      const piece = src.slice(k, e);
      span.appendChild(hit[k] ? el("mark", { text: piece }) : S.doc.createTextNode(piece));
      k = e;
    }
    return span;
  }

  /** How full the bin looks: the threshold sits at a third of the gauge. */
  function fill(i) {
    if (i.min === null || i.min === undefined) return null;
    const ref = Math.max(1, i.min * 3);
    return Math.max(0, Math.min(1, i.qty / ref));
  }

  function itemCard(i, withPath, k) {
    const low = isLow(i);
    const li = el("li", { class: "inv-item" + (low ? " is-low" : "") + (S.landed === i.id ? " is-landed" : "") + (S.lowFlash === i.id ? " is-crossing" : ""), "data-inv-item": i.id, "data-flip": "i:" + i.id });
    li.style.setProperty("--k", String(Math.min(k || 0, 12)));
    li.style.setProperty("--hue", String(hueOf(i.place)));
    const open = el("button", { type: "button", class: "inv-item-open", "aria-label": "Ouvrir " + i.name });
    open.addEventListener("click", () => editItem(i));
    const resolved = (typeof globalThis !== "undefined" && globalThis.HqHouseholdIcons)
      ? (globalThis.HqHouseholdIcons.resolveItem || globalThis.HqHouseholdIcons.resolveIngredient)(i.name)
      : null;
    if (i.photos[0]) open.appendChild(el("img", { class: "inv-thumb", src: "/api/carnet/asset/" + i.photos[0], alt: "", loading: "lazy", decoding: "async" }));
    else if (resolved && resolved.matched) {
      li.setAttribute("data-hh-category", resolved.category);
      if (resolved.domain) li.setAttribute("data-hh-domain", resolved.domain);
      const thumb = el("span", { class: "inv-thumb is-empty is-hh-icon", "aria-hidden": "true" });
      const badge = globalThis.HqHouseholdIcons.badge(S.doc, resolved, "");
      if (badge) thumb.appendChild(badge);
      open.appendChild(thumb);
    } else open.appendChild(el("span", { class: "inv-thumb is-empty" }, [el("span", { class: "inv-initial", text: (i.name.trim()[0] || "?").toUpperCase() })]));
    const q = S.q.trim();
    const text = el("span", { class: "inv-item-text" }, [q ? marked(i.name, "inv-item-name") : el("span", { class: "inv-item-name", text: i.name })]);
    if (withPath) text.appendChild(q ? marked(pathText(S.ix, i.place), "inv-item-path") : el("span", { class: "inv-item-path", text: pathText(S.ix, i.place) }));
    if (i.tags.length) text.appendChild(el("span", { class: "inv-tags" }, i.tags.slice(0, 4).map((t) => el("span", { class: "inv-tag", text: "#" + t }))));
    const used = usage(S.projects, i.id);
    if (used.length) {
      const res = reserved(S.projects, i.id);
      const short = res - i.qty;
      const chip = el("span", { class: "inv-proj-chip" + (short > 0 ? " is-short" : ""), title: used.map((u) => u.project.name + " : " + u.line.qty).join(" · ") });
      const dots = el("span", { class: "inv-proj-dots", "aria-hidden": "true" });
      for (const u of used.slice(0, 4)) {
        const d = el("span", { class: "inv-proj-dot" });
        d.style.setProperty("--ph", String(u.project.hue));
        dots.appendChild(d);
      }
      chip.append(dots, used.length === 1 ? used[0].project.name : used.length + " projets");
      if (res) chip.appendChild(el("span", { class: "inv-proj-res", text: short > 0 ? "manque " + short : res + " réservé" + (res > 1 ? "s" : "") }));
      text.appendChild(chip);
    }
    open.appendChild(text);
    const f = fill(i);
    if (f !== null) {
      const g = el("span", { class: "inv-gauge" + (low ? " is-low" : ""), role: "img", "aria-label": "Seuil : " + i.min + (i.unit ? " " + i.unit : "") });
      const bar = el("span", { class: "inv-gauge-fill", "data-id": i.id });
      bar.style.setProperty("--f", f.toFixed(3));
      g.append(bar, el("span", { class: "inv-gauge-min", "aria-hidden": "true" }));
      li.appendChild(g);
    }
    const qty = el("div", { class: "inv-qty", role: "group", "aria-label": "Quantité de " + i.name });
    const minus = el("button", { type: "button", class: "inv-step", "aria-label": "Retirer un", disabled: i.qty <= 0 }, [icon("minus")]);
    const val = el("output", { class: "inv-qty-val" + (S.bump === i.id ? (S.bumpDir < 0 ? " is-down" : " is-up") : ""), "aria-live": "polite", text: fmtQty(i) });
    const plus = el("button", { type: "button", class: "inv-step", "aria-label": "Ajouter un" }, [icon("plus")]);
    minus.addEventListener("click", () => adjust(i, -1));
    plus.addEventListener("click", () => adjust(i, 1));
    qty.append(minus, val, plus);
    if (low) qty.appendChild(el("span", { class: "inv-low", title: "Seuil : " + i.min, text: "à racheter" }));
    li.prepend(open);
    li.appendChild(qty);
    return li;
  }

  function renderSearch(m) {
    const r = search(S.data, S.ix, S.q);
    if (!r.items.length && !r.places.length) {
      m.appendChild(el("p", { class: "inv-empty", text: "Rien ne correspond à « " + S.q.trim() + " »." }));
      return;
    }
    if (r.places.length) {
      m.appendChild(el("h3", { class: "inv-h", text: "Emplacements" }));
      const g = el("div", { class: "inv-places" });
      r.places.forEach((p, k) => g.appendChild(placeTile(p, k)));
      m.appendChild(g);
    }
    if (r.items.length) {
      m.appendChild(el("h3", { class: "inv-h" }, ["Objets", el("span", { class: "inv-h-n", text: String(r.items.length) })]));
      m.appendChild(itemGrid(r.items, true));
    }
  }

  // ---------------------------------------------------------------- quick quantity

  const pendingAdjust = new Map();

  function adjust(i, d) {
    const next = Math.max(0, i.qty + d);
    if (next === i.qty) return;
    const was = isLow(i);
    i.qty = next; // optimistic: the number moves under the finger, the server confirms
    S.bump = i.id;
    S.bumpDir = d;
    buzz(6);
    renderMain();
    if (!was && isLow(i)) {
      S.lowFlash = i.id;
      renderMain();
      toast("« " + i.name + " » passe sous son seuil (" + i.min + ")");
    }
    const p = pendingAdjust.get(i.id) || { delta: 0, timer: 0 };
    p.delta += d;
    if (p.timer) S.win.clearTimeout(p.timer);
    p.timer = S.win.setTimeout(async () => {
      pendingAdjust.delete(i.id);
      if (!p.delta) return;
      try {
        absorb(await post({ action: "item.adjust", id: i.id, delta: p.delta }));
      } catch (e) {
        toast((e && e.message) || "Quantité non enregistrée", null, null, true);
        await load(true);
        return;
      }
      render();
    }, 450); // taps in a row become one write
    pendingAdjust.set(i.id, p);
  }

  // ---------------------------------------------------------------- sheets (dialogs)

  function openSheet(title, body, foot) {
    closeSheet(true);
    const back = el("div", { class: "inv-sheet-back" });
    const box = el("div", { class: "inv-sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
    const head = el("div", { class: "inv-sheet-head" }, [el("h3", { text: title }), btn("", { cls: "inv-x", icon: "close", aria: "Fermer", on: () => closeSheet() })]);
    const scroll = el("div", { class: "inv-sheet-body" }, [body]);
    box.append(head, scroll);
    if (foot) box.appendChild(el("div", { class: "inv-sheet-foot" }, foot));
    back.appendChild(box);
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) closeSheet();
    });
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeSheet();
      } else if (ev.key === "Tab") {
        const f = Array.prototype.filter.call(box.querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex='-1'])"), (n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        if (ev.shiftKey && S.doc.activeElement === f[0]) {
          ev.preventDefault();
          f[f.length - 1].focus();
        } else if (!ev.shiftKey && S.doc.activeElement === f[f.length - 1]) {
          ev.preventDefault();
          f[0].focus();
        }
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        const ok = box.querySelector(".inv-save");
        if (ok) ok.click();
      }
    });
    S.sheet = { back, box, ret: S.doc.activeElement };
    S.doc.body.appendChild(back);
    const first = box.querySelector("input,select,textarea");
    S.win.requestAnimationFrame(() => {
      try {
        (first || box.querySelector("button")).focus({ preventScroll: true });
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
      const a = s.box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0,16px,0) scale(.98)" }], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
      a.finished.then(done, done);
    }
    if (s.ret && s.ret.isConnected) {
      try {
        s.ret.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  function field(label, input, hint) {
    const id = "inv-f-" + Math.random().toString(36).slice(2, 9);
    input.id = id;
    return el("div", { class: "inv-field" }, [el("label", { for: id, text: label }), input, hint ? el("p", { class: "inv-hint", text: hint }) : null]);
  }

  function placeSelect(current, exclude, noneLabel) {
    const s = el("select", {});
    s.appendChild(el("option", { value: "", text: noneLabel }));
    for (const o of placeOptions(S.ix, exclude)) {
      const opt = el("option", { value: o.id, text: " ".repeat(o.depth) + o.label });
      if (o.id === current) opt.selected = true;
      s.appendChild(opt);
    }
    if (!current) s.value = "";
    return s;
  }

  // ---- photos: downscale in the browser, upload to the Carnet image store

  async function shrink(file) {
    const bmp = await (typeof S.win.createImageBitmap === "function"
      ? S.win.createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => S.win.createImageBitmap(file))
      : Promise.reject(new Error("Photos non prises en charge sur ce navigateur")));
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const c = S.doc.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
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

  function photoEditor(list, max) {
    const wrap = el("div", { class: "inv-photos" });
    const strip = el("div", { class: "inv-photo-strip" });
    const status = el("p", { class: "inv-hint", "aria-live": "polite" });
    const paint = () => {
      strip.textContent = "";
      list.forEach((id, k) => {
        const fig = el("div", { class: "inv-photo" + (S.newPhoto === id ? " is-new" : "") }, [el("img", { src: "/api/carnet/asset/" + id, alt: "Photo " + (k + 1), decoding: "async" })]);
        fig.appendChild(btn("", { cls: "inv-photo-x", icon: "close", aria: "Retirer la photo " + (k + 1), on: () => {
          list.splice(k, 1);
          paint();
        } }));
        strip.appendChild(fig);
      });
      S.newPhoto = "";
      addCam.disabled = addLib.disabled = list.length >= max;
    };
    const pick = (capture) => {
      const inp = el("input", { type: "file", accept: "image/*", capture: capture ? "environment" : null, multiple: capture ? null : true, hidden: true });
      inp.addEventListener("change", async () => {
        const files = Array.prototype.slice.call(inp.files || [], 0, max - list.length);
        inp.remove();
        for (const f of files) {
          const ph = el("div", { class: "inv-photo is-loading" }, [el("span", { class: "inv-spin", "aria-hidden": "true" })]);
          strip.appendChild(ph);
          status.textContent = "Envoi de la photo…";
          try {
            const id = await uploadPhoto(f);
            list.push(id);
            S.newPhoto = id;
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
    const addCam = btn("Photo", { icon: "camera", on: () => pick(true) });
    const addLib = btn("Choisir", { icon: "image", on: () => pick(false) });
    wrap.append(strip, el("div", { class: "inv-photo-btns" }, [addCam, addLib]), status);
    paint();
    return wrap;
  }

  // ---- item editor

  function editItem(i) {
    const isNew = !i;
    const cur = i || { name: "", qty: 1, unit: "", min: null, tags: [], note: "", photos: [], place: S.sel && S.sel !== "none" ? S.sel : null };
    const name = el("input", { type: "text", maxlength: "120", value: cur.name, placeholder: "Ex. Vis M4×12, perceuse, Arduino Nano", autocomplete: "off", required: true });
    const qty = el("input", { type: "number", min: "0", max: "10000000", step: "1", inputmode: "numeric", value: String(cur.qty) });
    const qm = btn("", { cls: "inv-step", icon: "minus", aria: "Moins", on: () => {
      qty.value = String(Math.max(0, (parseInt(qty.value, 10) || 0) - 1));
    } });
    const qp = btn("", { cls: "inv-step", icon: "plus", aria: "Plus", on: () => {
      qty.value = String((parseInt(qty.value, 10) || 0) + 1);
    } });
    const unit = el("input", { type: "text", maxlength: "16", value: cur.unit, placeholder: "pcs, m, g…", list: "inv-units" });
    const units = el("datalist", { id: "inv-units" }, ["pcs", "paquet", "boîte", "m", "cm", "g", "kg", "L", "rouleau", "paire"].map((u) => el("option", { value: u })));
    const min = el("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: cur.min === null ? "" : String(cur.min), placeholder: "aucun" });
    const place = placeSelect(cur.place, null, "Sans emplacement");
    const tags = el("input", { type: "text", value: cur.tags.map((t) => "#" + t).join(" "), placeholder: "#visserie #m4", autocomplete: "off" });
    const note = el("textarea", { rows: "3", maxlength: "2000", placeholder: "Référence, fournisseur, prix, taille…" });
    note.value = cur.note;
    const photos = cur.photos.slice();
    const iconPreview = el("div", { class: "inv-hh-preview", "aria-hidden": "true" });
    function refreshIconPreview() {
      while (iconPreview.firstChild) iconPreview.removeChild(iconPreview.firstChild);
      if (photos.length) return;
      const api = globalThis.HqHouseholdIcons;
      if (!api) return;
      const resolved = (api.resolveItem || api.resolveIngredient)(name.value);
      if (!resolved || !resolved.matched) return;
      const badge = api.badge(S.doc, resolved, "is-lg");
      if (badge) iconPreview.appendChild(badge);
    }
    name.addEventListener("input", refreshIconPreview);
    refreshIconPreview();
    const body = el("div", { class: "inv-form" }, [
      field("Nom", name),
      iconPreview,
      el("div", { class: "inv-row" }, [
        el("div", { class: "inv-field inv-qty-field" }, [el("label", { text: "Quantité" }), el("div", { class: "inv-qty-edit" }, [qm, qty, qp])]),
        field("Unité", unit),
        field("Seuil bas", min, "Alerte quand il en reste autant ou moins."),
      ]),
      units,
      field("Emplacement", place),
      field("Étiquettes", tags),
      field("Note", note),
      el("div", { class: "inv-field" }, [el("span", { class: "inv-flabel", text: "Photos" }), photoEditor(photos, (S.limits && S.limits.photos) || 6)]),
    ]);
    if (!isNew) body.insertBefore(projectsPanel(i), body.children[5]); // right under « Emplacement »: where it is, then what it is for
    qty.setAttribute("aria-label", "Quantité");
    const save = btn(isNew ? "Ajouter" : "Enregistrer", { cls: "inv-primary inv-save", on: async () => {
      const q = parseInt(qty.value, 10);
      const mn = min.value.trim() === "" ? null : parseInt(min.value, 10);
      if (!name.value.trim()) {
        name.focus();
        toast("Donne un nom à l'objet", null, null, true);
        return;
      }
      const fields = { name: name.value, qty: isFinite(q) && q >= 0 ? q : 0, unit: unit.value, min: mn !== null && isFinite(mn) && mn >= 0 ? mn : null,
        place: place.value || null, tags: parseTags(tags.value), note: note.value, photos };
      save.disabled = true;
      const out = await run(isNew ? Object.assign({ action: "item.create" }, fields) : Object.assign({ action: "item.update", id: i.id, rev: i.rev }, fields));
      save.disabled = false;
      if (out) {
        S.landed = out.item.id;
        closeSheet();
        render();
        toast(isNew ? "Objet ajouté" : "Objet enregistré");
      }
    } });
    const foot = [save];
    if (!isNew) {
      foot.unshift(btn("Supprimer", { cls: "secondary inv-danger", icon: "trash", on: () => {
        closeSheet();
        deleteItem(i);
      } }));
    }
    const box = openSheet(isNew ? "Nouvel objet" : i.name, body, foot);
    if (isNew) box.querySelector("input").focus();
  }

  // ---- the link to Projets: where an item is used, and putting it in a project's parts list

  async function loadProjects() {
    try {
      const out = await call("/api/projects");
      S.projects = out.projects || [];
    } catch (_) {
      S.projects = S.projects || null; // Projets unavailable: the Inventaire works on its own
    }
  }

  function openProject(pid) {
    try {
      S.win.location.hash = "#projets/" + pid + "/bom";
    } catch (_) {}
  }

  function projectsPanel(i) {
    const box = el("section", { class: "inv-projects", "aria-label": "Projets" });
    const paint = () => {
      box.textContent = "";
      box.appendChild(el("span", { class: "inv-flabel", text: "Dans les projets" }));
      if (S.projects === null) {
        box.appendChild(el("p", { class: "inv-hint", text: "Projets indisponibles pour l'instant." }));
        return;
      }
      const used = usage(S.projects, i.id);
      if (used.length) {
        const ul = el("ul", { class: "inv-proj-list" });
        for (const u of used) {
          const row = el("li", { class: "inv-proj-row" + (u.line.used ? " is-used" : "") });
          row.style.setProperty("--ph", String(u.project.hue));
          row.append(
            el("span", { class: "inv-proj-dot", "aria-hidden": "true" }),
            el("span", { class: "inv-proj-name", text: u.project.name }),
            el("span", { class: "inv-proj-qty", text: u.line.qty + (u.line.unit ? " " + u.line.unit : "") + (u.line.used ? " · sorti" : "") }),
            btn("", { cls: "inv-x inv-proj-open", icon: "open", aria: "Ouvrir le projet " + u.project.name, on: () => {
              closeSheet(true);
              openProject(u.project.id);
            } }),
          );
          ul.appendChild(row);
        }
        box.appendChild(ul);
        const res = reserved(S.projects, i.id);
        if (res) box.appendChild(el("p", { class: "inv-hint" + (res > i.qty ? " is-warn" : ""), text: res > i.qty ? "Il en manque " + (res - i.qty) + " pour tous les projets." : res + " réservé" + (res > 1 ? "s" : "") + " sur " + i.qty + " : il en reste " + (i.qty - res) + " de libre." }));
      }
      const live = S.projects.filter((p) => p.status !== "done");
      if (!live.length) {
        box.appendChild(el("p", { class: "inv-hint", text: S.projects.length ? "Aucun projet en cours." : "Crée un projet dans Projets pour y ajouter cet objet." }));
        return;
      }
      const sel = el("select", { "aria-label": "Projet" }, live.map((p) => el("option", { value: p.id, text: p.name })));
      const n = el("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: "1", "aria-label": "Quantité pour le projet" });
      const add = btn("Ajouter au projet", { cls: "secondary inv-proj-add", icon: "project", on: async () => {
        const p = S.projects.find((x) => x.id === sel.value);
        if (!p) return;
        add.disabled = true;
        try {
          const out = await call("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "bom.add", id: p.id, rev: p.rev, bom: { name: i.name, item: i.id, qty: Math.max(1, parseInt(n.value, 10) || 1), unit: i.unit } }) });
          const k = S.projects.findIndex((x) => x.id === p.id);
          if (k >= 0) S.projects[k] = out.project;
          flyToProjects(box.closest(".inv-sheet"), i);
          paint();
          renderMain();
          toast("Ajouté à « " + p.name + " »", "Ouvrir", () => {
            closeSheet(true);
            openProject(p.id);
          });
        } catch (e) {
          if (e && e.status === 409) await loadProjects();
          toast((e && e.message) || "Ajout impossible", null, null, true);
          paint();
        } finally {
          add.disabled = false;
        }
      } });
      box.appendChild(el("div", { class: "inv-proj-form" }, [sel, n, add]));
    };
    paint();
    if (S.projects === null) loadProjects().then(paint);
    return box;
  }

  /** The item's picture flies to the Projets button: it is now in that project's parts list. */
  function flyToProjects(from, i) {
    if (calm() || !from) return;
    const target = S.doc.querySelector('.bottom-nav [data-nav="projets"]');
    const src = from.querySelector(".inv-photo img") || from.querySelector(".inv-sheet-head h3");
    if (!target || !src) return;
    const a = src.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const ghost = el("span", { class: "inv-fly", "aria-hidden": "true" });
    if (i.photos[0]) ghost.appendChild(el("img", { src: "/api/carnet/asset/" + i.photos[0], alt: "" }));
    else ghost.textContent = (i.name.trim()[0] || "?").toUpperCase();
    ghost.style.left = a.left + Math.min(a.width, 80) / 2 - 28 + "px";
    ghost.style.top = a.top + Math.min(a.height, 80) / 2 - 28 + "px";
    S.doc.body.appendChild(ghost);
    const dx = b.left + b.width / 2 - (a.left + Math.min(a.width, 80) / 2);
    const dy = b.top + b.height / 2 - (a.top + Math.min(a.height, 80) / 2);
    const run2 = anim(ghost, [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: "translate(" + dx * 0.5 + "px," + (dy * 0.5 - 90) + "px) scale(.8) rotate(-12deg)", opacity: 1, offset: 0.5 },
      { transform: "translate(" + dx + "px," + dy + "px) scale(.2) rotate(-20deg)", opacity: 0.2 },
    ], { duration: 760, easing: "cubic-bezier(.45,0,.2,1)" });
    const end = () => {
      ghost.remove();
      anim(target, [{ transform: "scale(1)" }, { transform: "scale(1.22)", offset: 0.4 }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,1.35,.35,1)" });
    };
    if (run2) run2.finished.then(end, end);
    else end();
    buzz(10);
  }

  async function deleteItem(i) {
    const card = S.mainEl && S.mainEl.querySelector('[data-inv-item="' + i.id + '"]');
    if (card) {
      // the card crumples before it goes
      const a = anim(card, [{ transform: "none", opacity: 1 }, { transform: "scale(.9,.8) rotate(-2deg)", opacity: 1, offset: 0.35 }, { transform: "translate3d(0,24px,0) scale(.3) rotate(8deg)", opacity: 0 }], { duration: 380, easing: "cubic-bezier(.4,0,.7,1)", fill: "forwards" });
      if (a) await a.finished.catch(() => {});
    }
    const out = await run({ action: "item.delete", id: i.id, rev: i.rev });
    if (out) {
      buzz(10);
      toast("« " + i.name + " » supprimé", "Annuler", () => run({ action: "item.restore", item: out.deleted }, "Objet rétabli"));
    }
  }

  // ---- place editor

  function editPlace(p) {
    const isNew = !p;
    const parentDefault = isNew ? (S.sel && S.sel !== "none" ? S.sel : null) : p.parent;
    const cur = p || { name: "", kind: parentDefault ? "box" : "room", note: "", photos: [] };
    const name = el("input", { type: "text", maxlength: "120", value: cur.name, placeholder: "Ex. Garage, Étagère 2, Boîte visserie", autocomplete: "off" });
    const kind = el("select", {}, KINDS.map(([k, lab]) => el("option", { value: k, text: lab, selected: k === cur.kind })));
    kind.value = cur.kind;
    const parent = placeSelect(parentDefault, p ? p.id : null, "— Au premier niveau —");
    const note = el("textarea", { rows: "2", maxlength: "2000", placeholder: "Où exactement, quoi y ranger…" });
    note.value = cur.note;
    const photos = cur.photos.slice();
    const body = el("div", { class: "inv-form" }, [
      field("Nom", name),
      el("div", { class: "inv-row" }, [field("Type", kind), field("Dans", parent)]),
      field("Note", note),
      el("div", { class: "inv-field" }, [el("span", { class: "inv-flabel", text: "Photo" }), photoEditor(photos, 1)]),
    ]);
    if (!isNew) body.appendChild(el("p", { class: "inv-hint", text: "Code d'étiquette : " + p.code + " (ne change jamais : une étiquette imprimée reste valable)." }));
    const save = btn(isNew ? "Créer" : "Enregistrer", { cls: "inv-primary inv-save", on: async () => {
      if (!name.value.trim()) {
        name.focus();
        toast("Donne un nom à l'emplacement", null, null, true);
        return;
      }
      const fields = { name: name.value, kind: kind.value, parent: parent.value || null, note: note.value, photos };
      save.disabled = true;
      const out = await run(isNew ? Object.assign({ action: "place.create" }, fields) : Object.assign({ action: "place.update", id: p.id, rev: p.rev }, fields));
      save.disabled = false;
      if (out) {
        closeSheet();
        if (isNew) {
          S.landed = out.place.id;
          if (out.place.parent) S.open.add(out.place.parent);
          render();
          toast("Emplacement créé", "Imprimer l'étiquette", () => openLabels([out.place.id]));
        } else render();
      }
    } });
    openSheet(isNew ? "Nouvel emplacement" : p.name, body, [save]);
  }

  async function deletePlace(p) {
    const kids = (S.ix.kids.get(p.id) || []).length;
    const items = (S.ix.items.get(p.id) || []).length;
    if (kids || items) {
      const where = p.parent ? "« " + S.ix.places.get(p.parent).name + " »" : "le premier niveau";
      const body = el("div", { class: "inv-form" }, [el("p", { text: "« " + p.name + " » contient " + [items ? items + (items > 1 ? " objets" : " objet") : "", kids ? kids + (kids > 1 ? " emplacements" : " emplacement") : ""].filter(Boolean).join(" et ") + ". Son contenu ira dans " + where + ". Rien n'est perdu, mais l'étiquette QR de « " + p.name + " » ne servira plus." })]);
      const ok = btn("Supprimer et remonter le contenu", { cls: "inv-primary inv-danger-fill inv-save", on: async () => {
        closeSheet();
        const out = await run({ action: "place.delete", id: p.id, rev: p.rev, contents: "parent" });
        if (out) go(p.parent || "");
      } });
      openSheet("Supprimer « " + p.name + " » ?", body, [btn("Annuler", { on: () => closeSheet() }), ok]);
      return;
    }
    const out = await run({ action: "place.delete", id: p.id, rev: p.rev });
    if (out) {
      go(p.parent || "");
      toast("« " + p.name + " » supprimé", "Annuler", async () => {
        const back = await run({ action: "place.restore", place: out.deleted }, "Emplacement rétabli");
        if (back) go(back.place.id);
      });
    }
  }

  // ---------------------------------------------------------------- QR labels

  function qrBases() {
    const d = S.app ? S.app.dataset : {};
    const out = [];
    const add = (label, url, hint) => {
      if (url && /^https?:\/\//.test(url) && !out.some((x) => x.url === url.replace(/\/+$/, ""))) out.push({ label, url: url.replace(/\/+$/, ""), hint });
    };
    add("Tailscale HTTPS", d.qrServe, "partout, même hors de la maison");
    add("Tailscale", d.qrTs, "partout où Tailscale est actif");
    add("Réseau local", d.qrLan, "seulement sur le Wi-Fi de la maison");
    if (S.win.location && /^https?:$/.test(S.win.location.protocol) && !/^(localhost|127\.|\[::1\])/.test(S.win.location.host)) add("Cette adresse", S.win.location.origin, "l'adresse affichée dans le navigateur");
    return out;
  }

  /** A crisp SVG QR code built from the vendored QRCode.js model (never its own drawing). */
  function qrSvg(text) {
    const Q = S.win.QRCode;
    if (typeof Q !== "function") return null;
    const host = S.doc.createElement("div");
    let model = null;
    try {
      const q = new Q(host, { text, width: 64, height: 64, correctLevel: Q.CorrectLevel ? Q.CorrectLevel.M : 0 });
      model = q._oQRCode;
    } catch (_) {
      return null;
    }
    if (!model || typeof model.getModuleCount !== "function") return null;
    const n = model.getModuleCount();
    const svg = S.doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "-4 -4 " + (n + 8) + " " + (n + 8)); // the 4-module quiet zone the QR spec asks for
    svg.setAttribute("class", "inv-qr");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Code QR");
    svg.setAttribute("shape-rendering", "crispEdges");
    let d = "";
    for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (model.isDark(r, c)) d += "M" + c + " " + r + "h1v1h-1z";
    const bg = S.doc.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", "-4");
    bg.setAttribute("y", "-4");
    bg.setAttribute("width", String(n + 8));
    bg.setAttribute("height", String(n + 8));
    bg.setAttribute("fill", "#fff");
    const path = S.doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#000");
    svg.append(bg, path);
    return svg;
  }

  function openLabels(ids) {
    const bases = qrBases();
    let base = bases[0] ? bases[0].url : "";
    let withKids = false;
    let size = "m";
    const preview = el("div", { class: "inv-labels-preview" });
    const sheetIds = () => {
      const out = [];
      for (const id of ids) {
        out.push(id);
        if (withKids) for (const d of descendants(S.ix, id)) if (!out.includes(d.id)) out.push(d.id);
      }
      return out.filter((id) => S.ix.places.has(id));
    };
    const paint = () => {
      preview.textContent = "";
      preview.setAttribute("data-size", size);
      for (const id of sheetIds()) preview.appendChild(labelCard(S.ix.places.get(id), base));
    };
    const controls = el("div", { class: "inv-form" });
    if (bases.length > 1) {
      const sel = el("select", {}, bases.map((b) => el("option", { value: b.url, text: b.label + " — " + b.hint })));
      sel.addEventListener("change", () => {
        base = sel.value;
        paint();
      });
      controls.appendChild(field("Adresse dans le QR", sel, "L'iPhone doit pouvoir joindre cette adresse quand tu scannes."));
    } else if (!bases.length) {
      controls.appendChild(el("p", { class: "inv-hint is-warn", text: "Aucune adresse joignable depuis l'iPhone n'est connue : les étiquettes n'auront que le code à saisir dans la recherche." }));
    }
    const sizeSel = el("select", {}, [["s", "Petites (3 cm)"], ["m", "Moyennes (4,5 cm)"], ["l", "Grandes (6 cm)"]].map(([v, t]) => el("option", { value: v, text: t, selected: v === size })));
    sizeSel.addEventListener("change", () => {
      size = sizeSel.value;
      paint();
    });
    controls.appendChild(field("Taille", sizeSel));
    const hasKids = ids.some((id) => (S.ix.kids.get(id) || []).length);
    if (hasKids) {
      const cb = el("input", { type: "checkbox" });
      cb.addEventListener("change", () => {
        withKids = cb.checked;
        paint();
      });
      controls.appendChild(el("label", { class: "inv-check" }, [cb, " Aussi tout ce qui est dedans"]));
    }
    const body = el("div", {}, [controls, preview]);
    paint();
    const print = btn("Imprimer", { cls: "inv-primary inv-save", icon: "print", on: () => printLabels(sheetIds(), base, size) });
    openSheet("Étiquettes QR", body, [print]);
  }

  function labelCard(p, base) {
    const url = labelUrl(base, p.id);
    const card = el("div", { class: "inv-label" });
    const q = url ? qrSvg(url) : null;
    if (q) card.appendChild(q);
    const path = pathOf(S.ix, p.parent).map((x) => x.name).join(" › ");
    card.appendChild(el("div", { class: "inv-label-text" }, [
      el("strong", { class: "inv-label-name", text: p.name }),
      path ? el("span", { class: "inv-label-path", text: path }) : null,
      el("span", { class: "inv-label-code", text: p.code }),
    ]));
    return card;
  }

  function printLabels(ids, base, size) {
    const sheet = el("div", { class: "inv-print", "data-size": size, "aria-hidden": "true" });
    for (const id of ids) sheet.appendChild(labelCard(S.ix.places.get(id), base));
    S.doc.body.appendChild(sheet);
    S.doc.body.classList.add("inv-printing");
    const done = () => {
      S.doc.body.classList.remove("inv-printing");
      sheet.remove();
      S.win.removeEventListener("afterprint", done);
    };
    S.win.addEventListener("afterprint", done);
    S.win.setTimeout(() => {
      try {
        S.win.print();
      } finally {
        S.win.setTimeout(() => {
          if (sheet.isConnected && !S.win.matchMedia("print").matches) done();
        }, 1500);
      }
    }, 60);
  }

  // ---------------------------------------------------------------- lifecycle

  function visible() {
    return S.doc.body && S.doc.body.dataset.view === "inventaire" && S.doc.visibilityState !== "hidden";
  }

  function poll() {
    if (S.pollTimer) S.win.clearTimeout(S.pollTimer);
    S.pollTimer = S.win.setTimeout(async () => {
      if (visible() && !S.sheet && !pendingAdjust.size) await load(false);
      poll();
    }, POLL_MS);
  }

  function show() {
    S.counted = false;
    S.enter = true;
    loadProjects().then(() => {
      if (S.data && !S.sheet) renderMain();
    });
    if (!S.app) S.app = S.doc.getElementById("hq-inv-app");
    if (!S.app) return;
    if (!S.bodyEl) build();
    load(!S.data);
    poll();
  }

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    win.hqInventoryShow = show;
    const boot = () => {
      S.app = S.doc.getElementById("hq-inv-app");
      // a QR label scanned before the PIN: the login page kept the link for us
      let back = "";
      try {
        back = win.sessionStorage.getItem("tf_return_hash") || "";
        win.sessionStorage.removeItem("tf_return_hash");
      } catch (_) {}
      if (back && HASH_RE.test(back) && !HASH_RE.test(win.location.hash)) {
        try {
          win.history.replaceState(null, "", back);
        } catch (_) {}
      }
      if (HASH_RE.test(win.location.hash)) win.setTimeout(() => fromHash(win.location.hash), 0);
      else if (S.doc.body.dataset.view === "inventaire") show();
    };
    win.addEventListener("hashchange", () => fromHash(win.location.hash));
    // Escape closes the open sheet even before focus has moved into it
    S.doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && S.sheet && !S.sheet.box.contains(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
        closeSheet();
      }
    }, true); // capture: an HQ-wide Escape handler further down must not swallow it
    S.doc.addEventListener("visibilitychange", () => {
      if (visible()) load(false);
    });
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure, show };
});
