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

  /* The next thing, as a card in the welcome header: a ring that fills over its last two hours. */
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
    let when;
    let fill = 0;
    if (next.all_day) {
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
    card.className = "home-next cat-" + (next.category || "other") + (left <= 15 * 60000 && !next.all_day ? " is-soon" : "");
    card.dataset.day = String(next.start).slice(0, 10);
    card.querySelector(".home-next-title").textContent = next.title || "Sans titre";
    card.querySelector(".home-next-when").textContent = when;
    card.setAttribute("aria-label", "Prochain : " + (next.title || "Sans titre") + ", " + when + ". Ouvrir dans le calendrier");
    const circle = card.querySelector(".hq-cal-ring .fill");
    const C = 2 * Math.PI * 16;
    circle.style.strokeDasharray = C.toFixed(2);
    circle.style.strokeDashoffset = (C * (1 - Math.max(0.02, fill))).toFixed(2);
    card.hidden = false;
  }

  window.hqPaintHomeNext = function (cal) {
    next = (cal && cal.next) || null;
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

  function boot() {
    if (!$("hq-banner") || !document.querySelector(".home-v2")) return;
    paintHello();
    bindActions();
    bindDrop();
    bindFeed();
    bindDevices();
    setInterval(() => {
      if (document.hidden || document.body.dataset.view !== "accueil") return;
      paintHello();
      paintNext();
    }, 20000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
