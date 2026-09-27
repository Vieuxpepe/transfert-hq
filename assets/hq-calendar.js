/* Transfert HQ calendar. Date-only math never uses new Date("YYYY-MM-DD"). */
(function () {
  const VIEWS = [
    ["day", "Jour", "Vue Jour : la journée, heure par heure."],
    ["week", "Semaine", "Vue Semaine : sept jours. Sur téléphone, glisse horizontalement."],
    ["month", "Mois", "Vue Mois : aperçu du mois. Les titres longs sont coupés."],
    ["agenda", "Agenda", "Vue Agenda : la liste des trente prochains jours."],
  ];
  const CATS = [
    ["personal", "Personnel"],
    ["study", "Étude"],
    ["appointment", "Rendez-vous"],
    ["maintenance", "Maintenance"],
    ["hq", "HQ"],
    ["other", "Autre"],
  ];
  const REMINDERS = [
    [0, "À l'heure"],
    [5, "5 min"],
    [15, "15 min"],
    [30, "30 min"],
    [60, "1 h"],
    [120, "2 h"],
    [1440, "1 jour"],
  ];
  const DOW = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const WHEN = {
    daily: "Chaque jour",
    weekdays: "Jours ouvrés",
    weekly: "Chaque semaine",
    once: "Une fois",
    "on-online": "Au retour en ligne",
    online: "En ligne",
    wake: "Au réveil",
  };

  const state = {
    view: "week",
    anchor: null,
    activity: false,
    userMoved: false,
    synced: false,
    data: null,
    editing: null,
  };

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function makeLocalDate(y, m, d, hh, mm) {
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  }

  function parseLocalDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const date = makeLocalDate(y, m, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }

  function parseLocalDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    return makeLocalDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  }

  function dateKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function minuteKey(date) {
    return dateKey(date) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function addLocalDays(date, n) {
    return makeLocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate() + n, date.getHours(), date.getMinutes());
  }

  function startOfLocalWeek(date) {
    const delta = (date.getDay() + 6) % 7;
    return addLocalDays(makeLocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate()), -delta);
  }

  function addMonths(date, n) {
    const first = new Date(date.getFullYear(), date.getMonth() + n, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return makeLocalDate(first.getFullYear(), first.getMonth() + 1, Math.min(date.getDate(), last));
  }

  function todayLocal() {
    const now = new Date();
    return makeLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  function sameDay(a, b) {
    return !!a && !!b && dateKey(a) === dateKey(b);
  }

  function fmtDay(date) {
    return new Intl.DateTimeFormat("fr-CA", { weekday: "long", day: "numeric", month: "long" }).format(date);
  }

  function fmtMonth(date) {
    return new Intl.DateTimeFormat("fr-CA", { month: "long", year: "numeric" }).format(date);
  }

  function fmtTime(date) {
    return new Intl.DateTimeFormat("fr-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  }

  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((key) => {
      const value = attrs[key];
      if (value == null) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else node.setAttribute(key, String(value));
    });
    (kids || []).forEach((kid) => {
      if (kid) node.appendChild(kid);
    });
    return node;
  }

  function catClass(item) {
    return "cat-" + (item.category || "other") + (item.read_only ? " is-schedule" : "");
  }

  function itemStart(item) {
    return item.all_day ? parseLocalDateKey(item.start) : parseLocalDateTime(item.start);
  }

  function itemEnd(item) {
    return item.all_day ? parseLocalDateKey(item.end) : parseLocalDateTime(item.end);
  }

  function overlapsDay(item, day) {
    const start = itemStart(item);
    const end = itemEnd(item);
    if (!start || !end) return false;
    const dayStart = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate());
    const dayEnd = addLocalDays(dayStart, 1);
    return start < dayEnd && end > dayStart;
  }

  function items() {
    return (state.data && state.data.items) || [];
  }

  function findItem(id) {
    const all = items().concat((state.data && state.data.conditional) || []);
    return all.find((item) => item.id === id) || null;
  }

  function rangeFor() {
    const anchor = state.anchor || todayLocal();
    if (state.view === "day") {
      return { from: dateKey(anchor), to: dateKey(addLocalDays(anchor, 1)) };
    }
    if (state.view === "week") {
      const start = startOfLocalWeek(anchor);
      return { from: dateKey(start), to: dateKey(addLocalDays(start, 7)) };
    }
    if (state.view === "month") {
      const first = makeLocalDate(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      const start = startOfLocalWeek(first);
      return { from: dateKey(start), to: dateKey(addLocalDays(start, 42)) };
    }
    return { from: dateKey(anchor), to: dateKey(addLocalDays(anchor, 30)) };
  }

  function titleText() {
    const anchor = state.anchor || todayLocal();
    if (state.view === "day") return fmtDay(anchor);
    if (state.view === "week") {
      const start = startOfLocalWeek(anchor);
      return fmtDay(start) + " – " + fmtDay(addLocalDays(start, 6));
    }
    if (state.view === "month") return fmtMonth(anchor);
    return "Agenda · " + fmtDay(anchor);
  }

  let refreshGen = 0;

  function dayScroll() {
    const node = document.querySelector("#hq-cal-app .hq-cal-scroll");
    return node || null;
  }

  function scrollDayToNow() {
    if (state.view !== "day" || !sameDay(state.anchor, serverToday())) return;
    const nowLine = document.querySelector("#hq-cal-app .hq-cal-now");
    const scroll = dayScroll();
    const wall = serverNow();
    if (scroll && wall && scroll.scrollHeight > scroll.clientHeight + 24) {
      const slot = scroll.querySelector(".hq-cal-slot");
      const hourPx = slot ? slot.getBoundingClientRect().height : 48;
      if (hourPx) {
        const y = ((wall.getHours() * 60 + wall.getMinutes()) / 60) * hourPx;
        scroll.scrollTop = Math.max(0, y - scroll.clientHeight * 0.35);
      }
    }
    if (nowLine) nowLine.scrollIntoView({ block: "center", inline: "nearest" });
  }

  async function refresh(mode) {
    const root = document.getElementById("hq-cal-app");
    if (!root || typeof api !== "function") return;
    const gen = ++refreshGen;
    const previous = mode === "keep" ? dayScroll() : null;
    const kept = previous ? previous.scrollTop : null;
    const range = rangeFor();
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (state.activity && state.view !== "month") params.set("include_activity", "1");
    try {
      const data = await api("/api/calendar?" + params.toString());
      if (gen !== refreshGen) return;
      state.data = data;
      if (!state.synced && data.server_date && !state.userMoved) {
        state.synced = true;
        const serverDay = parseLocalDateKey(data.server_date);
        if (serverDay && !sameDay(serverDay, state.anchor)) {
          state.anchor = serverDay;
          return refresh(mode);
        }
      }
      render();
      if (mode === "snap") scrollDayToNow();
      else if (kept != null) {
        const next = dayScroll();
        if (next) next.scrollTop = kept;
      }
    } catch (err) {
      if (gen !== refreshGen || state.data) return;
      root.textContent = "";
      root.appendChild(h("p", { class: "hint", text: (err && err.message) || "Calendrier indisponible" }));
    }
  }

  function previewHelp(item) {
    const parts = [item.title || "Sans titre"];
    if (item.all_day) parts.push("Journée");
    else if (item.start && String(item.start).indexOf("T") !== -1) parts.push(spanLabel(item));
    else if (item.when) parts.push(WHEN[item.when] || "Conditionnel");
    if (item.read_only) parts.push("Horaire HQ, lecture seule");
    else {
      const cat = CATS.find((row) => row[0] === (item.category || "other"));
      if (cat) parts.push(cat[1]);
    }
    if (item.scene_id || item.action_id) parts.push("Lié");
    return parts.join(" · ");
  }

  function render() {
    const root = document.getElementById("hq-cal-app");
    if (!root) return;
    if (window.hqHideHelp) window.hqHideHelp();
    root.textContent = "";
    paintTz();
    root.appendChild(toolbar());
    if (state.data && state.data.malformed) {
      root.appendChild(h("p", { class: "hint", text: "Fichier calendrier illisible — il n'a pas été écrasé." }));
    }
    if (state.view === "day") root.appendChild(dayView());
    else if (state.view === "week") root.appendChild(weekView());
    else if (state.view === "month") root.appendChild(monthView());
    else root.appendChild(agendaView());
    root.appendChild(conditionalBlock());
  }

  function paintTz() {
    const node = document.getElementById("hq-cal-tz");
    if (!node || !state.data) return;
    const browser = -new Date().getTimezoneOffset();
    if (browser !== Number(state.data.server_utc_offset_min)) {
      node.textContent = "Heure HQ · " + (state.data.server_now || "");
    } else {
      node.textContent = "Ce qui se passe, ce qui est prévu, ce qui vient";
    }
  }

  function toolbar() {
    const bar = h("div", { class: "hq-cal-bar" });
    const views = h("div", { class: "hq-cal-views", role: "tablist" });
    VIEWS.forEach(([id, label, help]) => {
      views.appendChild(
        h("button", {
          type: "button",
          class: "secondary",
          "data-cal": "view",
          "data-view": id,
          "data-help": help,
          "aria-pressed": state.view === id ? "true" : "false",
          text: label,
        })
      );
    });
    bar.appendChild(views);
    const navCopy = {
      day: ["Jour précédent", "Jour suivant", "Recule d'un jour.", "Avance d'un jour."],
      week: ["Semaine précédente", "Semaine suivante", "Recule d'une semaine.", "Avance d'une semaine."],
      month: ["Mois précédent", "Mois suivant", "Recule d'un mois.", "Avance d'un mois."],
      agenda: ["Agenda précédent", "Agenda suivant", "Recule de trente jours.", "Avance de trente jours."],
    }[state.view] || ["Période précédente", "Période suivante", "Recule.", "Avance."];
    const nav = h("div", { class: "hq-cal-nav hq-cal-views" });
    nav.appendChild(h("button", { type: "button", class: "secondary", "data-cal": "prev", "aria-label": navCopy[0], "data-help": navCopy[2], text: "‹" }));
    nav.appendChild(h("button", { type: "button", class: "secondary", "data-cal": "today", "data-help": "Revient à la journée du pont.", text: "Aujourd'hui" }));
    nav.appendChild(h("button", { type: "button", class: "secondary", "data-cal": "next", "aria-label": navCopy[1], "data-help": navCopy[3], text: "›" }));
    bar.appendChild(nav);
    bar.appendChild(h("h3", { class: "hq-cal-title", text: titleText() }));
    if (state.view !== "month") {
      bar.appendChild(
        h("button", {
          type: "button",
          class: "secondary",
          "data-cal": "activity",
          "data-help": "Affiche l'activité récente sur la grille. Lecture seule.",
          "aria-pressed": state.activity ? "true" : "false",
          text: state.activity ? "Activité affichée" : "Activité",
        })
      );
    }
    bar.appendChild(h("button", {
      type: "button",
      "data-cal": "create",
      "data-help": "Crée un événement manuel dans le calendrier.",
      text: "Nouvel événement",
    }));
    return bar;
  }

  function dayView() {
    const wrap = h("div", {});
    wrap.appendChild(weekStrip());
    wrap.appendChild(allDayLane(state.anchor));
    wrap.appendChild(dayTimeline(state.anchor));
    return wrap;
  }

  function weekStrip() {
    const strip = h("div", { class: "hq-cal-weekstrip" });
    const start = startOfLocalWeek(state.anchor);
    const today = serverToday();
    for (let i = 0; i < 7; i += 1) {
      const day = addLocalDays(start, i);
      const button = h("button", {
        type: "button",
        "data-cal": "pick-day",
        "data-day": dateKey(day),
        "aria-pressed": sameDay(day, state.anchor) ? "true" : "false",
        text: DOW[i] + " " + day.getDate(),
      });
      if (sameDay(day, today)) button.classList.add("is-today");
      strip.appendChild(button);
    }
    return strip;
  }

  function serverToday() {
    return (state.data && parseLocalDateKey(state.data.server_date)) || todayLocal();
  }

  function serverNow() {
    return state.data ? parseLocalDateTime(state.data.server_now) : null;
  }

  function allDayLane(day) {
    const lane = h("div", { class: "hq-cal-allday" });
    const rows = items().filter((item) => item.all_day && overlapsDay(item, day));
    if (!rows.length) {
      lane.appendChild(h("span", { class: "hint", text: "Rien sur toute la journée." }));
      return lane;
    }
    rows.forEach((item) => lane.appendChild(chip(item)));
    return lane;
  }

  function chip(item) {
    const title = item.title || "Sans titre";
    const node = h("button", {
      type: "button",
      class: "hq-cal-chip " + catClass(item),
      "data-cal": "open",
      "data-id": item.id,
      "data-help": previewHelp(item),
      text: title,
    });
    return node;
  }

  function monthChipLimit() {
    return window.matchMedia("(max-width: 700px)").matches ? 1 : 2;
  }

  function dayTimeline(day) {
    const scroll = h("div", { class: "hq-cal-scroll" });
    const grid = h("div", { class: "hq-cal-day" });
    const labels = h("div", { class: "hq-cal-hours" });
    const col = h("div", { class: "hq-cal-col" });
    for (let hour = 0; hour < 24; hour += 1) {
      labels.appendChild(h("div", { class: "hq-cal-hourlabel", text: pad(hour) + ":00" }));
      col.appendChild(
        h("button", {
          type: "button",
          class: "hq-cal-slot",
          "data-cal": "slot",
          "data-day": dateKey(day),
          "data-hour": String(hour),
          "aria-label": "Créer à " + pad(hour) + ":00",
        })
      );
    }
    placeTimed(col, day, 1);
    placeNow(col, day);
    placeMarkers(col, day);
    grid.appendChild(labels);
    grid.appendChild(col);
    scroll.appendChild(grid);
    return scroll;
  }

  function timedOn(day) {
    return items().filter((item) => !item.all_day && overlapsDay(item, day));
  }

  function placeTimed(col, day, columns) {
    const dayStart = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate());
    const dayEnd = addLocalDays(dayStart, 1);
    const placed = layoutOverlaps(
      timedOn(day).map((item) => {
        const start = itemStart(item);
        const end = itemEnd(item);
        const startMin = start <= dayStart ? 0 : start.getHours() * 60 + start.getMinutes();
        let endMin = 1440;
        if (end < dayEnd) endMin = end.getHours() * 60 + end.getMinutes();
        if (endMin <= startMin) endMin = Math.min(1440, startMin + 30);
        return { item, startMin, endMin };
      })
    );
    placed.forEach((entry) => {
      const top = (entry.startMin / 1440) * 100;
      const height = Math.max(((entry.endMin - entry.startMin) / 1440) * 100, 1.6);
      const width = 100 / entry.cols;
      const button = h("button", {
        type: "button",
        class: "hq-cal-event " + catClass(entry.item),
        "data-cal": "open",
        "data-id": entry.item.id,
        "data-help": previewHelp(entry.item),
        style: "top:" + top + "%;height:" + height + "%;left:" + entry.col * width + "%;width:" + width + "%",
        text: entry.item.title || "Sans titre",
      });
      col.appendChild(button);
    });
    return columns;
  }

  function layoutOverlaps(entries) {
    const sorted = entries.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [];
    let clusterEnd = -1;
    const out = [];
    function flush() {
      const cols = [];
      cluster.forEach((entry) => {
        let col = 0;
        while (cols[col] > entry.startMin) col += 1;
        cols[col] = entry.endMin;
        entry.col = col;
      });
      const count = Math.max(1, cols.length);
      cluster.forEach((entry) => {
        entry.cols = count;
        out.push(entry);
      });
      cluster = [];
      clusterEnd = -1;
    }
    sorted.forEach((entry) => {
      if (cluster.length && entry.startMin >= clusterEnd) flush();
      cluster.push(entry);
      clusterEnd = Math.max(clusterEnd, entry.endMin);
    });
    if (cluster.length) flush();
    return out;
  }

  function placeNow(col, day) {
    const now = serverNow();
    if (!now || !sameDay(now, day)) return;
    const mins = now.getHours() * 60 + now.getMinutes();
    col.appendChild(
      h("div", { class: "hq-cal-now", style: "top:" + (mins / 1440) * 100 + "%" }, [h("span", { text: "Maintenant" })])
    );
  }

  function placeMarkers(col, day) {
    if (!state.activity || state.view === "month") return;
    const rows = (state.data && state.data.activity) || [];
    rows.forEach((marker) => {
      const when = markerTime(marker, day);
      if (!when) return;
      const mins = when.getHours() * 60 + when.getMinutes();
      const button = h("button", {
        type: "button",
        class: "hq-cal-marker",
        style: "top:" + (mins / 1440) * 100 + "%",
        "aria-label": "Activité",
        "data-help": marker.message || marker.kind || "Activité récente",
      });
      col.appendChild(button);
    });
  }

  function markerTime(marker, day) {
    const local = parseLocalDateTime(marker.local_at);
    if (local) return sameDay(local, day) ? local : null;
    const match = /^(\d{2}):(\d{2})/.exec(String(marker.at || ""));
    if (!match || state.view !== "day" || !sameDay(day, state.anchor)) return null;
    return makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), Number(match[1]), Number(match[2]));
  }

  function weekView() {
    const scroll = h("div", { class: "hq-cal-scroll" });
    const board = h("div", { class: "hq-cal-week" });
    const head = h("div", { class: "hq-cal-weekhead" });
    const all = h("div", { class: "hq-cal-allweek" });
    const grid = h("div", { class: "hq-cal-weekgrid" });
    head.appendChild(h("div", {}));
    all.appendChild(h("div", { class: "hq-cal-hourlabel", text: "Jour" }));
    const labels = h("div", { class: "hq-cal-hours" });
    for (let hour = 0; hour < 24; hour += 1) {
      labels.appendChild(h("div", { class: "hq-cal-hourlabel", text: pad(hour) + ":00" }));
    }
    grid.appendChild(labels);
    const start = startOfLocalWeek(state.anchor);
    const today = serverToday();
    for (let i = 0; i < 7; i += 1) {
      const day = addLocalDays(start, i);
      const headBtn = h("button", {
        type: "button",
        "data-cal": "pick-day",
        "data-day": dateKey(day),
        text: DOW[i] + " " + day.getDate(),
      });
      if (sameDay(day, today)) headBtn.classList.add("is-today");
      head.appendChild(headBtn);
      const cell = h("div", { class: "hq-cal-allcell" });
      items()
        .filter((item) => item.all_day && overlapsDay(item, day))
        .slice(0, 3)
        .forEach((item) => cell.appendChild(chip(item)));
      all.appendChild(cell);
      const col = h("div", { class: "hq-cal-weekcol" });
      for (let hour = 0; hour < 24; hour += 1) {
        col.appendChild(
          h("button", {
            type: "button",
            class: "hq-cal-slot",
            "data-cal": "slot",
            "data-day": dateKey(day),
            "data-hour": String(hour),
            "aria-label": "Créer le " + dateKey(day) + " à " + pad(hour) + ":00",
          })
        );
      }
      placeTimed(col, day, 1);
      placeNow(col, day);
      if (state.activity) placeMarkers(col, day);
      grid.appendChild(col);
    }
    board.appendChild(head);
    board.appendChild(all);
    board.appendChild(grid);
    scroll.appendChild(board);
    return scroll;
  }

  function monthView() {
    const wrap = h("div", { class: "hq-cal-month" });
    DOW.forEach((label) => wrap.appendChild(h("div", { class: "hq-cal-dow", text: label })));
    const first = makeLocalDate(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
    const start = startOfLocalWeek(first);
    const today = serverToday();
    for (let i = 0; i < 42; i += 1) {
      const day = addLocalDays(start, i);
      const cell = h("div", { class: "hq-cal-mcell" + (day.getMonth() === state.anchor.getMonth() ? "" : " is-out") });
      if (sameDay(day, today)) cell.classList.add("is-today");
      cell.appendChild(
        h("button", { type: "button", class: "hq-cal-mday", "data-cal": "pick-day", "data-day": dateKey(day), text: String(day.getDate()) })
      );
      const rows = items().filter((item) => overlapsDay(item, day));
      const limit = monthChipLimit();
      rows.slice(0, limit).forEach((item) => cell.appendChild(chip(item)));
      if (rows.length > limit) {
        const extra = rows.length - limit;
        const label = extra === 1 ? "1 autre" : extra + " autres";
        cell.appendChild(
          h("button", {
            type: "button",
            class: "hq-cal-more",
            "data-cal": "pick-day",
            "data-day": dateKey(day),
            "aria-label": label,
            text: "+" + extra,
          })
        );
      }
      wrap.appendChild(cell);
    }
    return wrap;
  }

  function agendaView() {
    const wrap = h("div", { class: "hq-cal-agenda" });
    let any = false;
    for (let i = 0; i < 30; i += 1) {
      const day = addLocalDays(state.anchor, i);
      const rows = items().filter((item) => overlapsDay(item, day));
      if (!rows.length) continue;
      any = true;
      wrap.appendChild(h("h3", { text: fmtDay(day) }));
      const allDay = rows.filter((item) => item.all_day);
      const timed = rows.filter((item) => !item.all_day).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      allDay.concat(timed).forEach((item) => {
        const when = item.all_day ? "Journée" : spanLabel(item);
        const button = h("button", {
          type: "button",
          class: "hq-cal-row " + catClass(item),
          "data-cal": "open",
          "data-id": item.id,
          "data-help": previewHelp(item),
        });
        button.appendChild(h("time", { text: when }));
        const body = h("span", {});
        body.appendChild(h("strong", { text: item.title || "Sans titre" }));
        if (item.location) body.appendChild(h("div", { class: "hint", text: item.location }));
        if (item.read_only) body.appendChild(h("div", { class: "hint", text: "Lecture seule" }));
        else {
          const cat = CATS.find((row) => row[0] === (item.category || "other"));
          if (cat) body.appendChild(h("div", { class: "hint", text: cat[1] }));
        }
        button.appendChild(body);
        wrap.appendChild(button);
      });
    }
    if (!any) wrap.appendChild(h("p", { class: "hint", text: "Rien de prévu sur les 30 prochains jours." }));
    return wrap;
  }

  function spanLabel(item) {
    const start = itemStart(item);
    const end = itemEnd(item);
    if (!start || !end) return "";
    return fmtTime(start) + "–" + fmtTime(end);
  }

  function conditionalBlock() {
    const rows = (state.data && state.data.conditional) || [];
    const block = h("section", { class: "hq-cal-cond" });
    if (!rows.length) return block;
    block.appendChild(h("h3", { text: "Conditionnel" }));
    block.appendChild(h("p", { class: "sec-hint", text: "Ces tâches ne sont pas sur la grille horaire." }));
    rows.forEach((item) => {
      const button = h("button", {
        type: "button",
        class: "hq-cal-row is-schedule",
        "data-cal": "open",
        "data-id": item.id,
        "data-help": previewHelp(item),
      });
      button.appendChild(h("strong", { text: item.title || "Conditionnel" }));
      button.appendChild(h("span", { class: "hint", text: WHEN[item.when] || item.when || "" }));
      block.appendChild(button);
    });
    return block;
  }

  function onClick(ev) {
    const button = ev.target.closest("[data-cal]");
    if (!button || !button.closest("#hq-cal-app")) return;
    const kind = button.dataset.cal;
    if (kind === "view") {
      state.view = button.dataset.view || "week";
      try { localStorage.setItem("hq_cal_view", state.view); } catch (_) {}
      refresh(state.view === "day" && sameDay(state.anchor, serverToday()) ? "snap" : undefined);
      return;
    }
    if (kind === "prev" || kind === "next") {
      state.userMoved = true;
      const dir = kind === "next" ? 1 : -1;
      if (state.view === "day") state.anchor = addLocalDays(state.anchor, dir);
      else if (state.view === "week") state.anchor = addLocalDays(state.anchor, dir * 7);
      else if (state.view === "month") state.anchor = addMonths(state.anchor, dir);
      else state.anchor = addLocalDays(state.anchor, dir * 30);
      refresh(state.view === "day" && sameDay(state.anchor, serverToday()) ? "snap" : undefined);
      return;
    }
    if (kind === "today") {
      state.userMoved = true;
      state.anchor = serverToday();
      refresh("snap");
      return;
    }
    if (kind === "activity") {
      state.activity = !state.activity;
      try { localStorage.setItem("hq_cal_activity", state.activity ? "1" : "0"); } catch (_) {}
      refresh();
      return;
    }
    if (kind === "create") {
      openEditor(blankDraft(state.anchor, 9));
      return;
    }
    if (kind === "pick-day") {
      const day = parseLocalDateKey(button.dataset.day);
      if (!day) return;
      state.userMoved = true;
      state.anchor = day;
      state.view = "day";
      try { localStorage.setItem("hq_cal_view", "day"); } catch (_) {}
      refresh(sameDay(day, serverToday()) ? "snap" : undefined);
      return;
    }
    if (kind === "slot") {
      const day = parseLocalDateKey(button.dataset.day);
      const hour = Number(button.dataset.hour);
      if (!day || Number.isNaN(hour)) return;
      openEditor(blankDraft(day, hour));
      return;
    }
    if (kind === "open") {
      const item = findItem(button.dataset.id);
      if (item) openDetail(item);
    }
  }

  function blankDraft(day, hour) {
    const start = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), hour, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + 60, 0, 0);
    return {
      title: "",
      all_day: false,
      start: minuteKey(start),
      end: minuteKey(end),
      category: "other",
      notes: "",
      location: "",
      reminders_min: [],
    };
  }

  function sheet(id) {
    if (window.hqHideHelp) window.hqHideHelp();
    let node = document.getElementById(id);
    if (!node) {
      node = h("div", { class: "hq-sheet", id: id, hidden: "hidden" });
      node.addEventListener("click", (ev) => {
        if (ev.target === node) closeSheets();
      });
      document.body.appendChild(node);
    }
    node.hidden = false;
    node.textContent = "";
    return node;
  }

  function closeSheets() {
    ["hq-cal-detail", "hq-cal-editor"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) {
        node.hidden = true;
        node.textContent = "";
      }
    });
  }

  function openDetail(item) {
    const root = sheet("hq-cal-detail");
    const card = h("div", { class: "hq-sheet-card", role: "dialog", "aria-modal": "true", "aria-label": "Détail" });
    card.appendChild(h("h3", { text: item.title || "Sans titre" }));
    card.appendChild(h("p", { class: "hint", text: whenText(item) }));
    if (item.location) card.appendChild(h("p", { text: item.location }));
    if (item.notes) card.appendChild(h("p", { class: "hq-cal-note", text: item.notes }));
    if (item.read_only) {
      card.appendChild(h("p", { class: "hint", text: "Planification HQ · lecture seule. " + (WHEN[item.when] || "") }));
      card.appendChild(h("button", { type: "button", "data-sheet": "schedules", text: "Ouvrir les horaires" }));
    } else {
      const cat = CATS.find((row) => row[0] === item.category);
      if (cat) card.appendChild(h("p", { class: "hint", text: cat[1] }));
      card.appendChild(h("button", { type: "button", "data-sheet": "edit", "data-id": item.id, text: "Modifier" }));
      if (item.scene_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "run", "data-id": item.id, "data-target": "scene", text: "Lancer la scène" }));
      if (item.action_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "run", "data-id": item.id, "data-target": "action", text: "Lancer l'action" }));
      if (item.device_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "device", "data-id": item.id, text: "Voir l'appareil" }));
      card.appendChild(h("button", { type: "button", class: "danger", "data-sheet": "delete", "data-id": item.id, text: "Supprimer" }));
    }
    card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "close", text: "Fermer" }));
    card.addEventListener("click", (ev) => onSheetClick(ev, item));
    root.appendChild(card);
  }

  function whenText(item) {
    if (!item.start) return WHEN[item.when] || "Conditionnel";
    if (item.all_day) return "Journée · " + item.start + " → " + item.end + " (fin exclue)";
    const start = itemStart(item);
    const end = itemEnd(item);
    if (!start || !end) return item.start;
    return fmtDay(start) + " · " + fmtTime(start) + "–" + fmtTime(end);
  }

  function onSheetClick(ev, item) {
    const button = ev.target.closest("[data-sheet]");
    if (!button) return;
    const kind = button.dataset.sheet;
    if (kind === "close") closeSheets();
    else if (kind === "edit") openEditor(item);
    else if (kind === "delete") removeEvent(item);
    else if (kind === "run") runTarget(item, button.dataset.target);
    else if (kind === "device") openDevice(item);
    else if (kind === "schedules") openSchedules();
  }

  function labelFor(list, id) {
    const found = (list || []).find((row) => row.id === id);
    return (found && found.label) || id;
  }

  async function runTarget(item, target) {
    const catalog = (state.data && state.data.catalog) || {};
    const label = target === "scene" ? labelFor(catalog.scenes, item.scene_id) : labelFor(catalog.actions, item.action_id);
    const noun = target === "scene" ? "la scène" : "l'action";
    if (!window.confirm("Lancer " + noun + " « " + label + " » ?")) return;
    try {
      await api("/api/calendar/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, target: target }),
      });
      if (typeof toast === "function") toast(target === "scene" ? "Scène lancée" : "Action lancée");
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Échec", "err");
    }
  }

  function openDevice(item) {
    closeSheets();
    if (typeof window.hqOpenDevice === "function") window.hqOpenDevice(item.device_id);
    else if (typeof toast === "function") toast("Appareil : " + item.device_id);
  }

  function openSchedules() {
    closeSheets();
    if (document.body.classList.contains("mode-simple")) {
      const toggle = document.getElementById("mode-toggle");
      if (toggle) toggle.click();
    }
    if (typeof setView === "function") setView("ops");
    const form = document.getElementById("hq-schedule-form");
    const details = form && form.closest("details");
    if (details) details.open = true;
    if (form) form.scrollIntoView({ block: "start" });
  }

  async function removeEvent(item) {
    if (!window.confirm("Supprimer « " + (item.title || "cet événement") + " » ?")) return;
    try {
      await api("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: item.id, expected_rev: item.rev }),
      });
      closeSheets();
      if (typeof toast === "function") toast("Événement supprimé");
      refresh();
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Suppression impossible", "err");
    }
  }

  function openEditor(item) {
    const root = sheet("hq-cal-editor");
    const card = h("form", { class: "hq-sheet-card", role: "dialog", "aria-modal": "true", "aria-label": "Événement" });
    card.appendChild(h("h3", { text: item.id ? "Modifier" : "Nouvel événement" }));
    card.appendChild(field("Titre", h("input", { id: "hq-cal-title", name: "title", maxlength: "120", required: "required", value: item.title || "" })));
    const allDay = h("input", { id: "cal-all-day", type: "checkbox" });
    allDay.checked = !!item.all_day;
    const allWrap = h("label", { text: "" });
    allWrap.appendChild(allDay);
    allWrap.appendChild(document.createTextNode(" Toute la journée"));
    card.appendChild(h("div", { class: "field" }, [allWrap]));
    const start = h("input", { id: "cal-start", required: "required" });
    const end = h("input", { id: "cal-end", required: "required" });
    function syncTypes() {
      const day = allDay.checked;
      start.type = day ? "date" : "datetime-local";
      end.type = day ? "date" : "datetime-local";
      start.value = day ? String(item.start || "").slice(0, 10) : toLocalInput(item.start, false);
      end.value = day ? String(item.end || "").slice(0, 10) : toLocalInput(item.end, false);
    }
    allDay.addEventListener("change", () => {
      item.all_day = allDay.checked;
      if (allDay.checked) {
        item.start = String(start.value || item.start || "").slice(0, 10);
        const endDay = parseLocalDateKey(String(end.value || "").slice(0, 10)) || parseLocalDateKey(item.start);
        item.end = endDay ? dateKey(addLocalDays(endDay, 1)) : item.end;
      } else {
        const day = parseLocalDateKey(String(start.value || "").slice(0, 10)) || state.anchor;
        item.start = minuteKey(makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), 9, 0));
        item.end = minuteKey(makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), 10, 0));
      }
      syncTypes();
    });
    syncTypes();
    card.appendChild(field("Début", start));
    card.appendChild(field("Fin", end));
    card.appendChild(h("p", { class: "hint", text: "Journée entière : la date de fin est exclue (le lendemain pour un seul jour)." }));
    const category = h("select", { id: "cal-category" });
    CATS.forEach(([id, label]) => {
      const option = h("option", { value: id, text: label });
      if ((item.category || "other") === id) option.selected = true;
      category.appendChild(option);
    });
    card.appendChild(field("Catégorie", category));
    card.appendChild(field("Lieu", h("input", { id: "cal-location", maxlength: "200", value: item.location || "" })));
    card.appendChild(field("Notes", h("textarea", { id: "cal-notes", maxlength: "4000", text: item.notes || "" })));
    card.appendChild(selectField("Scène", "cal-scene", ((state.data || {}).catalog || {}).scenes, item.scene_id));
    card.appendChild(selectField("Action", "cal-action", ((state.data || {}).catalog || {}).actions, item.action_id));
    card.appendChild(selectField("Appareil (navigation)", "cal-device", ((state.data || {}).catalog || {}).devices, item.device_id));
    card.appendChild(reminderField(item.reminders_min || []));
    const row = h("div", { class: "hq-cal-views" });
    row.appendChild(h("button", { type: "submit", text: "Enregistrer" }));
    row.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "close", text: "Fermer" }));
    card.appendChild(row);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-sheet='close']")) closeSheets();
    });
    card.addEventListener("submit", (ev) => {
      ev.preventDefault();
      saveEditor(item, { allDay, start, end, category });
    });
    root.appendChild(card);
    const title = card.querySelector("#hq-cal-title");
    if (title) title.focus();
  }

  function normalizeBound(value, allDay) {
    const raw = String(value || "");
    if (allDay) return raw.slice(0, 10);
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
    return match ? match[1] + "T" + match[2] + ":" + match[3] : raw;
  }

  function toLocalInput(value, allDay) {
    if (allDay) return String(value || "").slice(0, 10);
    const parsed = parseLocalDateTime(value) || parseLocalDateKey(String(value || "").slice(0, 10));
    return parsed ? minuteKey(parsed) : "";
  }

  function field(label, control) {
    return h("div", { class: "field" }, [h("label", { text: label }), control]);
  }

  function selectField(label, id, rows, current) {
    const select = h("select", { id: id });
    select.appendChild(h("option", { value: "", text: "Aucune" }));
    (rows || []).forEach((row) => {
      const option = h("option", { value: row.id, text: row.label || row.id });
      if (row.id === current) option.selected = true;
      select.appendChild(option);
    });
    return field(label, select);
  }

  function reminderField(selected) {
    const box = h("div", { class: "hq-reminders" });
    REMINDERS.forEach(([value, label]) => {
      const input = h("input", { type: "checkbox", value: String(value) });
      input.checked = selected.indexOf(value) !== -1;
      const wrap = h("label", {});
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(" " + label));
      box.appendChild(wrap);
    });
    box.addEventListener("change", () => {
      const checked = box.querySelectorAll("input:checked");
      if (checked.length > 3) {
        checked[checked.length - 1].checked = false;
        if (typeof toast === "function") toast("Trois rappels maximum", "err");
      }
    });
    return field("Rappels", box);
  }

  async function saveEditor(item, refs) {
    const title = document.getElementById("hq-cal-title");
    const notes = document.getElementById("cal-notes");
    const location = document.getElementById("cal-location");
    const scene = document.getElementById("cal-scene");
    const action = document.getElementById("cal-action");
    const device = document.getElementById("cal-device");
    const reminders = [];
    document.querySelectorAll(".hq-reminders input:checked").forEach((input) => reminders.push(Number(input.value)));
    const allDay = refs.allDay.checked;
    const payload = {
      title: title ? title.value : "",
      all_day: allDay,
      start: normalizeBound(refs.start.value, allDay),
      end: normalizeBound(refs.end.value, allDay),
      category: refs.category.value,
      notes: notes ? notes.value : "",
      location: location ? location.value : "",
      scene_id: scene ? scene.value : "",
      action_id: action ? action.value : "",
      device_id: device ? device.value : "",
      reminders_min: reminders,
    };
    if (item.id) payload.id = item.id;
    if (!payload.title.trim()) {
      if (typeof toast === "function") toast("Titre requis", "err");
      return;
    }
    try {
      await api("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", expected_rev: item.id ? item.rev : 0, event: payload }),
      });
      closeSheets();
      if (typeof toast === "function") toast("Événement enregistré");
      refresh();
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
    }
  }

  function onKey(ev) {
    if (ev.key !== "Escape") return;
    const open = ["hq-cal-editor", "hq-cal-detail"].some((id) => {
      const node = document.getElementById(id);
      return node && !node.hidden;
    });
    if (!open) return;
    ev.stopPropagation();
    closeSheets();
  }

  function homeWhen(item) {
    if (!item) return "";
    if (item.all_day) return "Journée";
    const start = parseLocalDateTime(item.start);
    if (!start) return item.when ? (WHEN[item.when] || "") : "";
    return fmtDay(start) + " · " + fmtTime(start);
  }

  function paintHome(cal) {
    const root = document.getElementById("hq-cal-today");
    if (!root) return;
    root.textContent = "";
    const today = (cal && cal.today) || [];
    if (!today.length) {
      root.appendChild(h("p", { class: "hint", text: "Rien de prévu aujourd'hui." }));
    } else {
      const list = h("ul", { class: "hq-list" });
      today.slice(0, 5).forEach((item) => {
        const li = h("li", {});
        li.appendChild(h("strong", { text: item.title || "Sans titre" }));
        li.appendChild(h("div", { class: "meta", text: homeWhen(item) }));
        list.appendChild(li);
      });
      root.appendChild(list);
    }
    if (cal && cal.next) {
      const line = h("p", {});
      line.appendChild(h("strong", { text: "Prochain" }));
      line.appendChild(h("span", { text: " · " + (cal.next.title || "Sans titre") + " · " + homeWhen(cal.next) }));
      root.appendChild(line);
    }
  }

  function paintWall(cal) {
    const root = document.getElementById("wb-next");
    if (!root) return;
    root.textContent = "";
    const next = cal && cal.next;
    if (!next) {
      root.appendChild(h("p", { class: "hint", text: "Rien à venir." }));
      return;
    }
    root.appendChild(h("strong", { text: next.title || "Sans titre" }));
    root.appendChild(h("div", { class: "hint", text: homeWhen(next) }));
  }

  window.hqPaintCalendarSummary = function (cal) {
    paintHome(cal);
    paintWall(cal);
  };

  function boot() {
    const root = document.getElementById("hq-cal-app");
    if (!root) return;
    try {
      state.activity = localStorage.getItem("hq_cal_activity") === "1";
      const saved = localStorage.getItem("hq_cal_view");
      const mobile = window.matchMedia("(max-width: 800px)").matches;
      state.view = ["day", "week", "month", "agenda"].includes(saved) ? saved : mobile ? "day" : "week";
    } catch (_) {
      state.view = "week";
    }
    state.anchor = todayLocal();
    root.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    const openHome = document.getElementById("hq-cal-open");
    if (openHome) {
      openHome.addEventListener("click", () => {
        if (typeof setView === "function") setView("calendrier");
      });
    }
    window.hqCalendarShow = function () {
      refresh("snap");
    };
    if (document.body && document.body.dataset.view === "calendrier") refresh("snap");
    setInterval(() => {
      if (document.hidden) return;
      if (!document.body || document.body.dataset.view !== "calendrier") return;
      refresh("keep");
    }, 45000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (!document.body || document.body.dataset.view !== "calendrier") return;
      refresh("keep");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
