/* Accueil: greeting and date over the hour's light, the next-event countdown, the action row, the
   page-wide drop zone, the short activity feed and the folded offline devices. Everything here only
   arranges what other modules already load; it fetches nothing of its own. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  // The same light as the calendar: cool morning, bright day, warm evening, deep blue night.
  const AMBIENT = [
    [0, [52, 60, 140]], [5, [70, 76, 160]], [7, [120, 176, 255]], [11, [140, 205, 255]], [14, [255, 222, 150]],
    [18, [255, 150, 96]], [20, [206, 104, 170]], [22, [80, 78, 170]], [24, [52, 60, 140]],
  ];
  let next = null;     // the calendar's next item (from /api/hq)
  let offsetMs = 0;    // HQ clock minus this device's clock

  function now() {
    return new Date(Date.now() + offsetMs);
  }
  window.hqNow = now; // the HQ clock, shared with hq-home-fx.js (sky and clock follow the PC, like the greeting)

  function parseMinute(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(text || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }

  function greeting(hour) {
    if (hour >= 5 && hour < 12) return "Bonjour";
    if (hour >= 12 && hour < 18) return "Bon après-midi";
    if (hour >= 18 && hour < 22) return "Bonsoir";
    return "Bonne nuit";
  }

  function ambient(date) {
    const t = date.getHours() + date.getMinutes() / 60;
    let i = 0;
    while (i < AMBIENT.length - 2 && AMBIENT[i + 1][0] <= t) i += 1;
    const [t0, c0] = AMBIENT[i];
    const [t1, c1] = AMBIENT[i + 1];
    const k = (t - t0) / (t1 - t0);
    return "rgb(" + c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",") + ")";
  }

  function paintHello() {
    const d = now();
    const date = $("home-date");
    const greet = $("home-greet");
    if (date) {
      const text = new Intl.DateTimeFormat("fr-CA", { weekday: "long", day: "numeric", month: "long" }).format(d);
      date.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    }
    if (greet) greet.textContent = greeting(d.getHours());
    const hero = $("hq-banner");
    if (hero) hero.style.setProperty("--home-amb", ambient(d));
  }

  function fmtLeft(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return "maintenant";
    if (mins < 60) return "dans " + mins + " min";
    const rest = mins % 60;
    return "dans " + Math.floor(mins / 60) + " h" + (rest ? " " + pad(rest) : "");
  }

  function ring() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("class", "hq-cal-ring");
    svg.setAttribute("aria-hidden", "true");
    ["track", "fill"].forEach((cls) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "20");
      c.setAttribute("cy", "20");
      c.setAttribute("r", "16");
      c.setAttribute("class", cls);
      svg.appendChild(c);
    });
    return svg;
  }

  /* The owner's next event (or the one under way) as a card in the welcome header: a ring that fills
     over its last two hours, then with the time that has passed. HQ schedules are left out. */
  function paintNext() {
    const card = $("home-next");
    if (!card) return;
    const start = next && parseMinute(next.start);
    if (!next || !start) {
      card.hidden = true;
      return;
    }
    const d = now();
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const left = start - d;
    const end = parseMinute(next.end);
    const live = !next.all_day && left <= 0 && end && end > d;
    let when;
    let fill = 0;
    if (live) {
      when = "encore " + fmtLeft(end - d).replace(/^dans /, "");
      fill = (d - start) / Math.max(1, end - start);
    } else if (next.all_day) {
      when = day.getTime() === today.getTime() ? "Aujourd'hui" : new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(start);
    } else if (left < 24 * 3600000) {
      when = fmtLeft(left);
      fill = 1 - Math.min(1, Math.max(0, left) / (120 * 60000));
    } else {
      when = new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(start);
    }
    if (!card.firstChild) {
      card.append(ring(), Object.assign(document.createElement("span"), { className: "home-next-text" }),
        Object.assign(document.createElement("span"), { className: "home-next-when" }));
      card.children[1].append(Object.assign(document.createElement("span"), { className: "home-next-label", textContent: "Prochain" }),
        Object.assign(document.createElement("span"), { className: "home-next-title" }));
      card.addEventListener("click", () => {
        if (typeof window.setView === "function") window.setView("calendrier");
        if (card.dataset.day && window.hqCalendarOpenDay) window.hqCalendarOpenDay(card.dataset.day);
      });
    }
    card.className = "home-next cat-" + (next.category || "other") + (left <= 15 * 60000 && !next.all_day ? " is-soon" : "") + (live ? " is-now" : "");
    card.querySelector(".home-next-label").textContent = live ? "En cours" : "Prochain";
    card.dataset.day = String(next.start).slice(0, 10);
    card.querySelector(".home-next-title").textContent = next.title || "Sans titre";
    card.querySelector(".home-next-when").textContent = when;
    card.setAttribute("aria-label", (live ? "En cours : " : "Prochain : ") + (next.title || "Sans titre") + ", " + when + ". Ouvrir dans le calendrier");
    const circle = card.querySelector(".hq-cal-ring .fill");
    const C = 2 * Math.PI * 16;
    circle.style.strokeDasharray = C.toFixed(2);
    circle.style.strokeDashoffset = (C * (1 - Math.max(0.02, fill))).toFixed(2);
    card.hidden = false;
  }

  window.hqPaintHomeNext = function (cal) {
    next = (cal && cal.next_mine) || null;
    const server = cal && parseMinute(String(cal.server_now || "").slice(0, 16));
    if (server) {
      // HQ reports whole minutes: only a real clock difference (another time zone, a wrong clock) counts.
      const diff = server.getTime() - Date.now();
      offsetMs = Math.abs(diff) > 90000 ? diff : 0;
    }
    paintNext();
    paintHello();
  };

  /* The action row. */
  function bindActions() {
    const note = $("home-act-note");
    if (note) {
      // The quick capture is admin-only and boots on its own; the tile shows once it is there.
      let tries = 0;
      const look = setInterval(() => {
        tries += 1;
        if (window.hqCapture && typeof window.hqCapture.open === "function") {
          note.hidden = false;
          clearInterval(look);
        } else if (tries > 40) clearInterval(look);
      }, 250);
      note.addEventListener("click", () => {
        if (window.hqCapture) window.hqCapture.open();
      });
    }
    const event = $("home-act-event");
    if (event) {
      event.addEventListener("click", () => {
        if (typeof window.setView === "function") window.setView("calendrier");
        const input = $("hq-cal-quick-input");
        if (input) input.focus(); // same tap: the phone keyboard opens
      });
    }
    const file = $("home-act-file");
    if (file) file.addEventListener("click", () => { const input = $("file-input"); if (input) input.click(); });
  }

  /* Drop a file anywhere on Accueil (desktop): the whole page becomes the drop zone. */
  function bindDrop() {
    const zone = $("drop-zone");
    if (!zone) return;
    let depth = 0;
    const hasFiles = (ev) => !!(ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes("Files"));
    const off = () => {
      depth = 0;
      zone.classList.remove("is-active", "drag");
    };
    window.addEventListener("dragenter", (ev) => {
      if (document.body.dataset.view !== "accueil" || !hasFiles(ev)) return;
      depth += 1;
      const select = $("upload-folder");
      const label = $("home-drop-folder");
      if (select && label) label.textContent = (select.options[select.selectedIndex] || {}).text || select.value || "Inbox";
      zone.classList.add("is-active");
    });
    window.addEventListener("dragleave", () => {
      depth -= 1;
      if (depth <= 0) off();
    });
    window.addEventListener("drop", off);
    window.addEventListener("dragend", off);
  }

  /* Activité récente: five lines, then « Tout voir ». */
  function bindFeed() {
    const list = $("hq-recents");
    const more = $("home-feed-more");
    if (!list || !more) return;
    const sync = () => {
      const rows = list.querySelectorAll(":scope > li:not(.hint)").length;
      more.hidden = rows <= 5;
      const all = list.classList.contains("is-all");
      more.textContent = all ? "Moins" : "Tout voir (" + rows + ")";
      more.setAttribute("aria-expanded", all ? "true" : "false");
    };
    new MutationObserver(sync).observe(list, { childList: true });
    more.addEventListener("click", () => {
      list.classList.toggle("is-all");
      sync();
    });
    sync();
  }

  /* Appareils: offline ones fold under « n hors ligne ». */
  function bindDevices() {
    const list = $("hq-devices");
    if (!list) return;
    list.addEventListener("click", (ev) => {
      const toggle = ev.target.closest && ev.target.closest("#home-devices-off");
      if (!toggle) return;
      const open = !list.classList.contains("show-off");
      list.classList.toggle("show-off", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- motion: the cards arrive one after another when Accueil opens ---- */
  function enter() {
    const home = document.querySelector(".home-v2");
    if (!home || calm()) return;
    const items = [$("hq-banner"), document.querySelector(".home-actions")]
      .concat(cardsInOrder().filter((el) => el.offsetParent !== null), [$("home-edit-row")]).filter(Boolean);
    items.forEach((el, i) => el.style.setProperty("--i", String(i)));
    home.classList.remove("is-entering");
    void home.offsetWidth;
    home.classList.add("is-entering");
    clearTimeout(enter.timer);
    enter.timer = setTimeout(() => home.classList.remove("is-entering"), 1100);
  }

  /* ---- pull down at the top of Accueil (touch) to refresh everything on it ---- */
  function refreshAll() {
    const jobs = [];
    if (typeof window.hqLoadSnapshot === "function") jobs.push(window.hqLoadSnapshot());
    if (typeof window.refreshHQ === "function") jobs.push(window.refreshHQ());
    if (typeof window.hqCarnetHome === "function") jobs.push(Promise.resolve(window.hqCarnetHome()));
    if (typeof window.hqTodayRefresh === "function") jobs.push(window.hqTodayRefresh());
    jobs.push(loadLayout());
    jobs.push(new Promise((r) => setTimeout(r, 650))); // long enough to see it happen
    return Promise.allSettled(jobs);
  }

  function bindPull() {
    const ind = document.createElement("div");
    ind.className = "home-ptr";
    ind.setAttribute("aria-hidden", "true");
    ind.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5"/></svg>';
    document.body.appendChild(ind);
    const status = document.createElement("p");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    document.body.appendChild(status);
    let pull = null;
    let busy = false;
    const ARM = 64;
    const reset = () => {
      ind.classList.remove("is-on", "is-armed", "is-spinning", "is-done");
      ind.style.transform = "";
      ind.style.opacity = "";
    };
    document.addEventListener("touchstart", (ev) => {
      pull = null;
      if (busy || document.body.dataset.view !== "accueil" || window.scrollY > 0 || ev.touches.length !== 1) return;
      if (document.querySelector(".home-v2.is-editing") || (ev.target.closest && ev.target.closest("input, textarea, select, .hq-sheet, dialog, .home-drop"))) return;
      pull = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, d: 0, active: false };
    }, { passive: true });
    document.addEventListener("touchmove", (ev) => {
      if (!pull || ev.touches.length !== 1) return;
      const dy = ev.touches[0].clientY - pull.y;
      const dx = ev.touches[0].clientX - pull.x;
      if (!pull.active) {
        if (dy < 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) { pull = null; return; }
        if (dy < 8) return;
        pull.active = true;
        ind.classList.add("is-on");
      }
      ev.preventDefault();
      pull.d = Math.min(120, (dy - 8) * 0.5);
      ind.style.transform = "translate(-50%," + (pull.d - 44).toFixed(1) + "px) rotate(" + (pull.d * 3).toFixed(0) + "deg)";
      ind.style.opacity = String(Math.min(1, pull.d / 40));
      const armed = pull.d >= ARM;
      if (armed !== ind.classList.contains("is-armed")) {
        ind.classList.toggle("is-armed", armed);
        if (armed && navigator.vibrate) navigator.vibrate(6);
      }
    }, { passive: false });
    document.addEventListener("touchend", async () => {
      const g = pull;
      pull = null;
      if (!g || !g.active) return;
      if (g.d < ARM) {
        reset();
        return;
      }
      busy = true;
      ind.classList.add("is-spinning");
      ind.style.transform = "translate(-50%," + (ARM - 44) + "px)";
      status.textContent = "Actualisation…";
      await refreshAll();
      ind.classList.remove("is-spinning");
      ind.classList.add("is-done");
      status.textContent = "Accueil à jour";
      enter();
      setTimeout(() => { reset(); busy = false; }, 450);
    });
    window.hqHomeRefresh = refreshAll; // test hook
  }

  /* ---- « Modifier l'accueil »: order, hide and (desktop) place the cards; saved on HQ for every device ---- */
  const CARDS = [
    ["carnet", "#hq-carnet-home", "Carnet"],
    ["today", "#hq-cal-home", "Aujourd'hui"],
    ["devices", ".home-devices", "Appareils"],
    ["pc", ".home-pc", "Ce PC"],
    ["send", ".home-send", "Envoyer"],
    ["feed", ".home-feed", "Activité récente"],
  ];
  const DEFAULT_LAYOUT = { order: CARDS.map((c) => c[0]), hidden: [], side: ["devices", "pc", "send"] };
  const LAYOUT_KEY = "hq_home_layout"; // a copy for an instant first paint; HQ keeps the real one
  let layout = null;
  let saveTimer = 0;

  function card(key) {
    const row = CARDS.find((c) => c[0] === key);
    return row ? document.querySelector(".home-v2 " + row[1]) : null;
  }

  function cardsInOrder() {
    return (layout || DEFAULT_LAYOUT).order.map(card).filter(Boolean);
  }

  function desktop() {
    return window.matchMedia("(min-width: 900px)").matches;
  }

  function clean(data) {
    const keys = CARDS.map((c) => c[0]);
    const order = [];
    ((data && Array.isArray(data.order)) ? data.order : []).forEach((k) => { if (keys.includes(k) && !order.includes(k)) order.push(k); });
    keys.forEach((k) => { if (!order.includes(k)) order.push(k); });
    const pick = (name, fallback) => {
      const raw = data && Array.isArray(data[name]) ? data[name] : fallback;
      return order.filter((k) => raw.includes(k));
    };
    return { order, hidden: pick("hidden", []), side: pick("side", DEFAULT_LAYOUT.side) };
  }

  function applyLayout(next, animate) {
    const main = document.querySelector(".home-v2 .home-col-main");
    const side = document.querySelector(".home-v2 .home-col-side");
    if (!main || !side) return;
    const before = animate && !calm() && layout ? new Map(cardsInOrder().map((el) => [el, el.getBoundingClientRect()])) : null;
    layout = clean(next);
    layout.order.forEach((key, i) => {
      const el = card(key);
      if (!el) return;
      (layout.side.includes(key) ? side : main).appendChild(el);
      el.style.order = String(3 + i); // phone: one list in this order
      el.classList.toggle("is-user-hidden", layout.hidden.includes(key));
      const bar = el.querySelector(":scope > .home-edit-bar");
      if (bar) paintBar(bar, key);
    });
    if (!before) return;
    before.forEach((old, el) => {
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if ((Math.abs(dx) > 1 || Math.abs(dy) > 1) && el.animate) {
        el.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,1.1,.32,1)" });
      }
    });
  }

  function storeLocal() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {}
  }

  async function loadLayout() {
    if (typeof window.api !== "function") return;
    try {
      const data = await window.api("/api/home-layout", { timeoutMs: 8000 });
      const row = $("home-edit-row");
      if (row) row.hidden = false; // the owner can arrange Accueil (an upload session gets 403 and never sees it)
      if (JSON.stringify(clean(data && data.layout)) !== JSON.stringify(layout)) {
        applyLayout(data && data.layout, false);
        storeLocal();
      }
    } catch (_) {
      /* upload role or offline: the arrangement on screen stays */
    }
  }

  function saveSoon() {
    storeLocal();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await window.api("/api/home-layout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout }),
        });
      } catch (err) {
        if (typeof window.toast === "function") window.toast((err && err.message) || "Disposition non enregistrée", "err");
      }
    }, 350);
  }

  function paintBar(bar, key) {
    const hidden = layout.hidden.includes(key);
    const hide = bar.querySelector("[data-edit=hide]");
    hide.textContent = hidden ? "Afficher" : "Masquer";
    hide.setAttribute("aria-pressed", hidden ? "true" : "false");
    const sideBtn = bar.querySelector("[data-edit=side]");
    const onSide = layout.side.includes(key);
    sideBtn.textContent = onSide ? "← Colonne" : "Colonne →";
    sideBtn.setAttribute("aria-label", (onSide ? "Mettre à gauche : " : "Mettre à droite : ") + bar.dataset.name);
  }

  function move(key, dir) {
    const order = layout.order.slice();
    // Desktop: up and down move within the card's column; phone: within the one list.
    const lane = desktop() ? order.filter((k) => layout.side.includes(k) === layout.side.includes(key)) : order;
    const other = lane[lane.indexOf(key) + dir];
    if (!other) return;
    const a = order.indexOf(key);
    const b = order.indexOf(other);
    order[a] = other;
    order[b] = key;
    applyLayout(Object.assign({}, layout, { order }), true);
    saveSoon();
  }

  let barWatch = null; // a card that redraws itself (the Carnet summary) gets its controls back

  function ensureBars() {
    CARDS.forEach(([key, , name]) => {
      const el = card(key);
      if (!el || el.querySelector(":scope > .home-edit-bar")) return;
      const bar = document.createElement("div");
      bar.className = "home-edit-bar";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", name + " : disposition");
      bar.dataset.name = name;
      bar.dataset.key = key;
      bar.innerHTML = '<span class="home-edit-name"></span>'
        + '<button type="button" class="home-edit-btn" data-edit="up">↑</button>'
        + '<button type="button" class="home-edit-btn" data-edit="down">↓</button>'
        + '<button type="button" class="home-edit-btn home-edit-side" data-edit="side"></button>'
        + '<button type="button" class="home-edit-btn home-edit-hide" data-edit="hide"></button>';
      bar.querySelector(".home-edit-name").textContent = name;
      bar.querySelector("[data-edit=up]").setAttribute("aria-label", "Monter : " + name);
      bar.querySelector("[data-edit=down]").setAttribute("aria-label", "Descendre : " + name);
      el.prepend(bar);
      paintBar(bar, key);
    });
  }

  function startEditing() {
    const home = document.querySelector(".home-v2");
    const btn = $("home-edit");
    if (!home || !btn || home.classList.contains("is-editing")) return;
    home.classList.add("is-editing");
    btn.setAttribute("aria-pressed", "true");
    btn.textContent = "Terminé";
    ensureBars();
    barWatch = new MutationObserver(() => { if (home.classList.contains("is-editing")) ensureBars(); });
    CARDS.forEach(([key]) => { const el = card(key); if (el) barWatch.observe(el, { childList: true }); });
    const tools = document.createElement("div");
    tools.className = "home-edit-tools";
    tools.innerHTML = '<span>Ordre, colonne et cartes visibles : enregistré pour tous tes appareils.</span>'
      + '<button type="button" class="ghost home-link" data-edit="reset">Par défaut</button>';
    $("home-edit-row").prepend(tools);
  }

  function stopEditing() {
    const home = document.querySelector(".home-v2");
    const btn = $("home-edit");
    if (!home || !btn || !home.classList.contains("is-editing")) return;
    home.classList.remove("is-editing");
    if (barWatch) barWatch.disconnect();
    barWatch = null;
    btn.setAttribute("aria-pressed", "false");
    btn.textContent = "Modifier l'accueil";
    document.querySelectorAll(".home-v2 .home-edit-bar, .home-v2 .home-edit-tools").forEach((el) => el.remove());
  }

  function bindEditing() {
    const home = document.querySelector(".home-v2");
    const btn = $("home-edit");
    if (!home || !btn) return;
    btn.addEventListener("click", () => (home.classList.contains("is-editing") ? stopEditing() : startEditing()));
    home.addEventListener("click", (ev) => {
      const b = ev.target.closest && ev.target.closest("[data-edit]");
      if (!b || !home.classList.contains("is-editing")) return;
      ev.preventDefault();
      ev.stopPropagation();
      const kind = b.dataset.edit;
      if (kind === "reset") {
        applyLayout(DEFAULT_LAYOUT, true);
        saveSoon();
        return;
      }
      const key = b.closest(".home-edit-bar").dataset.key;
      if (kind === "up" || kind === "down") move(key, kind === "up" ? -1 : 1);
      else if (kind === "hide") {
        const hidden = layout.hidden.includes(key) ? layout.hidden.filter((k) => k !== key) : layout.hidden.concat([key]);
        applyLayout(Object.assign({}, layout, { hidden }), true);
        saveSoon();
      } else if (kind === "side") {
        const side = layout.side.includes(key) ? layout.side.filter((k) => k !== key) : layout.side.concat([key]);
        applyLayout(Object.assign({}, layout, { side }), true);
        saveSoon();
      }
    }, true);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && home.classList.contains("is-editing")) stopEditing();
    });
  }

  function boot() {
    if (!$("hq-banner") || !document.querySelector(".home-v2")) return;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); } catch (_) {}
    applyLayout(cached || DEFAULT_LAYOUT, false);
    paintHello();
    bindActions();
    bindDrop();
    bindFeed();
    bindDevices();
    bindEditing();
    bindPull();
    loadLayout();
    let lastView = document.body.dataset.view;
    if (lastView === "accueil") enter();
    new MutationObserver(() => {
      const view = document.body.dataset.view;
      if (view === lastView) return; // the app re-sets the same view on resize: no replay
      lastView = view;
      if (view === "accueil") enter();
      else stopEditing();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
    setInterval(() => {
      if (document.hidden || document.body.dataset.view !== "accueil") return;
      paintHello();
      paintNext();
    }, 20000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
