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
    legend: false,
    userMoved: false,
    synced: false,
    data: null,
    editing: null,
    /* One-shot motion for the next render, set only by the owner's own moves ("next", "prev", "view").
       Background refreshes leave it empty, so nothing moves on its own. */
    anim: "",
    prevView: "",
  };
  const VIEW_ORDER = ["day", "week", "month", "agenda"];
  const HINT_KEY = "hq_cal_hint_done";

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
      const start = weekStart(anchor);
      return { from: dateKey(start), to: dateKey(addLocalDays(start, weekSpan())) };
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
      const start = weekStart(anchor);
      return fmtShort(start) + " – " + fmtShort(addLocalDays(start, weekSpan() - 1));
    }
    if (state.view === "month") return fmtMonth(anchor);
    return "Dès le " + fmtShort(anchor);
  }

  /* Phone: the week view shows three days from the chosen one (no sideways scrolling); wider screens
     keep the Monday-to-Sunday week. */
  function threeDay() {
    return window.matchMedia("(max-width: 600px)").matches;
  }

  function weekSpan() {
    return threeDay() ? 3 : 7;
  }

  function weekStart(anchor) {
    return threeDay() ? makeLocalDate(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate()) : startOfLocalWeek(anchor);
  }

  function fmtShort(date) {
    return new Intl.DateTimeFormat("fr-CA", { day: "numeric", month: "short" }).format(date);
  }

  /* Is today inside the period on screen? Then "Aujourd'hui" has nothing to do and stays hidden. */
  function showsToday() {
    const today = serverToday();
    const anchor = state.anchor || todayLocal();
    if (state.view === "day") return sameDay(anchor, today);
    if (state.view === "week") {
      const start = weekStart(anchor);
      return today >= start && today < addLocalDays(start, weekSpan());
    }
    if (state.view === "month") return anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth();
    return sameDay(anchor, today);
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
    const legend = legendPanel();
    legend.hidden = !state.legend;
    root.appendChild(legend);
    if (state.data && state.data.malformed) {
      root.appendChild(h("p", { class: "hint", text: "Fichier calendrier illisible — il n'a pas été écrasé." }));
    }
    const stage = h("div", { class: "hq-cal-stage" + (state.anim ? " is-" + state.anim : "") });
    if (state.view === "day") stage.appendChild(dayView());
    else if (state.view === "week") {
      const first = weekStart(state.anchor);
      const hint = threeDay() ? dayHint([0, 1, 2].map((n) => addLocalDays(first, n))) : null;
      if (hint) stage.appendChild(hint);
      stage.appendChild(weekView());
    }
    else if (state.view === "month") stage.appendChild(monthView());
    else stage.appendChild(agendaView());
    root.appendChild(stage);
    root.appendChild(conditionalBlock());
    state.anim = "";
    state.prevView = state.view;
  }

  /* Previous / next period, from the arrows, a swipe or the arrow keys. */
  function go(dir) {
    state.userMoved = true;
    state.anim = dir > 0 ? "next" : "prev";
    if (state.view === "day") state.anchor = addLocalDays(state.anchor, dir);
    else if (state.view === "week") state.anchor = addLocalDays(state.anchor, dir * weekSpan());
    else if (state.view === "month") state.anchor = addMonths(state.anchor, dir);
    else state.anchor = addLocalDays(state.anchor, dir * 30);
    refresh(state.view === "day" && sameDay(state.anchor, serverToday()) ? "snap" : undefined);
  }

  function goToday() {
    const today = serverToday();
    state.userMoved = true;
    state.anim = state.anchor && today < state.anchor ? "prev" : "next";
    state.anchor = today;
    refresh("snap");
  }

  function hintDone() {
    try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
  }

  function hintSeen() {
    try { return localStorage.getItem(HINT_KEY) === "1"; } catch (_) { return true; }
  }

  /* Under the day strip: an empty day says so (and how to add); otherwise, until the owner has once
     swiped or tapped an hour, one quiet line says those two gestures exist. */
  function dayHint(days) {
    const empty = days.every((day) => !items().some((item) => overlapsDay(item, day)));
    if (empty) {
      return h("p", { class: "hq-cal-hint is-empty", text: coarsePointer()
        ? "Rien de prévu. Touche une heure pour ajouter quelque chose."
        : "Rien de prévu. Clique sur une heure pour ajouter quelque chose." });
    }
    if (hintSeen()) return null;
    return h("p", { class: "hq-cal-hint", text: coarsePointer()
      ? "Touche une heure pour ajouter · glisse pour changer de jour"
      : "Clique sur une heure pour ajouter · ← → pour changer de période" });
  }

  function paintTz() {
    const node = document.getElementById("hq-cal-tz");
    if (!node || !state.data) return;
    const browser = -new Date().getTimezoneOffset();
    // Only worth a line when HQ's clock and this device disagree; otherwise the header stays quiet.
    const differs = browser !== Number(state.data.server_utc_offset_min);
    node.textContent = differs ? "Heure HQ · " + (state.data.server_now || "") : "";
    node.hidden = !differs;
  }

  /* Header: ‹ period › on one line, the four views as one segmented row, then a row with the two
     display toggles (Activité, Légende) on the left and Aujourd'hui / + Événement on the right. */
  function toolbar() {
    const bar = h("div", { class: "hq-cal-bar" });
    const index = Math.max(0, VIEW_ORDER.indexOf(state.view));
    const from = VIEW_ORDER.indexOf(state.prevView);
    const moving = state.anim === "view" && from >= 0 && from !== index;
    const views = h("div", {
      class: "hq-cal-views" + (moving ? " is-moving" : ""),
      role: "group",
      "aria-label": "Affichage",
      style: "--i:" + index + ";--from:" + (moving ? from : index),
    });
    VIEWS.forEach(([id, label, help]) => {
      views.appendChild(
        h("button", {
          type: "button",
          class: "hq-cal-view",
          "data-cal": "view",
          "data-view": id,
          "data-help": help,
          "aria-pressed": state.view === id ? "true" : "false",
          text: id === "week" && threeDay() ? "3 jours" : label,
        })
      );
    });
    const navCopy = {
      day: ["Jour précédent", "Jour suivant", "Recule d'un jour.", "Avance d'un jour."],
      week: threeDay()
        ? ["Trois jours plus tôt", "Trois jours plus tard", "Recule de trois jours.", "Avance de trois jours."]
        : ["Semaine précédente", "Semaine suivante", "Recule d'une semaine.", "Avance d'une semaine."],
      month: ["Mois précédent", "Mois suivant", "Recule d'un mois.", "Avance d'un mois."],
      agenda: ["Agenda précédent", "Agenda suivant", "Recule de trente jours.", "Avance de trente jours."],
    }[state.view] || ["Période précédente", "Période suivante", "Recule.", "Avance."];
    const head = h("div", { class: "hq-cal-head" });
    head.appendChild(h("button", { type: "button", class: "hq-cal-step", "data-cal": "prev", "aria-label": navCopy[0], "data-help": navCopy[2], text: "‹" }));
    head.appendChild(h("h3", { class: "hq-cal-title", "aria-live": "polite", text: titleText() }));
    head.appendChild(h("button", { type: "button", class: "hq-cal-step", "data-cal": "next", "aria-label": navCopy[1], "data-help": navCopy[3], text: "›" }));
    const tools = h("div", { class: "hq-cal-tools" });
    const actions = h("div", { class: "hq-cal-actions" });
    if (!showsToday()) {
      actions.appendChild(h("button", { type: "button", class: "secondary hq-cal-today", "data-cal": "today", "data-help": "Revient à aujourd'hui.", text: "Aujourd'hui" }));
    }
    actions.appendChild(h("button", {
      type: "button",
      class: "hq-cal-create",
      "data-cal": "create",
      "aria-label": "Nouvel événement",
      "data-help": "Crée un événement manuel dans le calendrier.",
      text: "+ Événement",
    }));
    bar.appendChild(head);
    bar.appendChild(views);
    if (state.view !== "month") {
      tools.appendChild(
        h("button", {
          type: "button",
          class: "hq-cal-toggle",
          "data-cal": "activity",
          "data-help": "Affiche l'activité récente sur la grille. Lecture seule.",
          "aria-pressed": state.activity ? "true" : "false",
          text: "Activité",
        })
      );
    }
    tools.appendChild(h("button", {
      type: "button",
      class: "hq-cal-toggle",
      "data-cal": "legend",
      "aria-expanded": state.legend ? "true" : "false",
      "aria-controls": "hq-cal-legend",
      "data-help": "Formes et couleurs des catégories, du planning et de l'activité.",
      text: "Légende",
    }));
    tools.appendChild(actions);
    bar.appendChild(tools);
    return bar;
  }

  function legendPanel() {
    const panel = h("div", {
      id: "hq-cal-legend",
      class: "hq-cal-legend",
      role: "region",
      "aria-label": "Légende du calendrier",
    });
    const cats = h("ul", { class: "hq-cal-legend-cats" });
    CATS.forEach(([id, label]) => {
      const item = h("li", { class: "hq-cal-legend-item" });
      item.appendChild(h("span", { class: "hq-cal-legend-mark cat-" + id, "aria-hidden": "true" }));
      item.appendChild(h("span", { text: label }));
      cats.appendChild(item);
    });
    panel.appendChild(cats);
    const notes = h("ul", { class: "hq-cal-legend-notes" });
    const schedule = h("li", { class: "hq-cal-legend-note" });
    schedule.appendChild(h("span", { class: "hq-cal-legend-mark is-schedule", "aria-hidden": "true" }));
    schedule.appendChild(h("span", { text: "Planning HQ · lecture seule" }));
    const activity = h("li", { class: "hq-cal-legend-note" });
    activity.appendChild(h("span", { class: "hq-cal-legend-activity", "aria-hidden": "true" }));
    activity.appendChild(h("span", { text: "Activité observée" }));
    notes.appendChild(schedule);
    notes.appendChild(activity);
    panel.appendChild(notes);
    return panel;
  }

  function dayView() {
    const wrap = h("div", {});
    wrap.appendChild(weekStrip());
    const hint = dayHint([state.anchor]);
    if (hint) wrap.appendChild(hint);
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
        "aria-label": fmtDay(day),
      }, [h("span", { class: "hq-cal-strip-dow", text: DOW[i] }), h("span", { class: "hq-cal-strip-num", text: String(day.getDate()) })]);
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
    if (!rows.length) return lane; // empty: hidden by CSS, no filler line
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

  function narrowMonth() {
    return window.matchMedia("(max-width: 520px)").matches;
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

  function coarsePointer() {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  function columnPx() {
    return (state.view === "week" ? 44 : 48) * 24;
  }

  function assignHitSlop(placed) {
    const pxPerMin = columnPx() / 1440;
    const targetPx = 44;
    const gapPx = 2;
    const groups = new Map();
    placed.forEach((entry) => {
      const list = groups.get(entry.col) || [];
      list.push(entry);
      groups.set(entry.col, list);
    });
    groups.forEach((rows) => {
      rows.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
      rows.forEach((entry, index) => {
        const prevEnd = index > 0 ? rows[index - 1].endMin : 0;
        const nextStart = index + 1 < rows.length ? rows[index + 1].startMin : 1440;
        const aboveRoom = Math.max(0, ((entry.startMin - prevEnd) * pxPerMin) / 2 - (index > 0 ? gapPx / 2 : 0));
        const belowRoom = Math.max(0, ((nextStart - entry.endMin) * pxPerMin) / 2 - (index + 1 < rows.length ? gapPx / 2 : 0));
        const visualPx = Math.max(1, (entry.endMin - entry.startMin) * pxPerMin);
        const need = Math.max(0, targetPx - visualPx);
        let above = Math.min(aboveRoom, need / 2);
        let below = Math.min(belowRoom, need - above);
        const leftover = need - above - below;
        if (leftover > 0) {
          const addAbove = Math.min(Math.max(0, aboveRoom - above), leftover);
          above += addAbove;
          below += Math.min(Math.max(0, belowRoom - below), leftover - addAbove);
        }
        entry.hitAbovePx = above;
        entry.hitBelowPx = below;
        entry.visualPx = visualPx;
      });
    });
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
    const coarse = coarsePointer();
    if (coarse) assignHitSlop(placed);
    const colPx = columnPx();
    const now = serverNow();
    placed.forEach((entry, order) => {
      const width = 100 / entry.cols;
      const spanMin = Math.max(1, entry.endMin - entry.startMin);
      const top = (entry.startMin / 1440) * 100;
      const height = (spanMin / 1440) * 100;
      let hitTop = top;
      let hitHeight = coarse ? height : Math.max(height, 1.6);
      const past = !!(now && itemEnd(entry.item) && itemEnd(entry.item) <= now);
      const button = h("button", {
        type: "button",
        class: "hq-cal-event" + (coarse ? "" : " " + catClass(entry.item)) + (past ? " is-past" : ""),
        "data-cal": "open",
        "data-id": entry.item.id,
        "data-help": previewHelp(entry.item),
      });
      if (coarse) {
        const abovePct = ((entry.hitAbovePx || 0) / colPx) * 100;
        const belowPct = ((entry.hitBelowPx || 0) / colPx) * 100;
        hitTop = top - abovePct;
        hitHeight = height + abovePct + belowPct;
        const face = h("span", { class: "hq-cal-face " + catClass(entry.item) }, eventLabel(entry));
        face.style.top = (abovePct / hitHeight) * 100 + "%";
        face.style.height = (height / hitHeight) * 100 + "%";
        button.appendChild(face);
      } else {
        eventLabel(entry).forEach((node) => button.appendChild(node));
      }
      button.style.top = hitTop + "%";
      button.style.height = hitHeight + "%";
      button.style.left = entry.col * width + "%";
      button.style.width = width + "%";
      button.style.setProperty("--n", String(Math.min(order, 12)));
      col.appendChild(button);
    });
    return columns;
  }

  /* What an event block says: its start time (when it starts on this day), then its title. */
  function eventLabel(entry) {
    const title = h("span", { class: "hq-cal-ev-title", text: entry.item.title || "Sans titre" });
    if (entry.startMin <= 0) return [title];
    const time = h("span", { class: "hq-cal-ev-time", text: pad(Math.floor(entry.startMin / 60)) + ":" + pad(entry.startMin % 60) });
    return [time, title];
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
    const span = weekSpan();
    const board = h("div", { class: "hq-cal-week" + (span === 3 ? " is-three" : "") });
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
    const start = weekStart(state.anchor);
    const today = serverToday();
    for (let i = 0; i < span; i += 1) {
      const day = addLocalDays(start, i);
      const headBtn = h("button", {
        type: "button",
        "data-cal": "pick-day",
        "data-day": dateKey(day),
        "aria-label": fmtDay(day),
      }, [h("span", { class: "hq-cal-strip-dow", text: DOW[(day.getDay() + 6) % 7] }), h("span", { class: "hq-cal-strip-num", text: String(day.getDate()) })]);
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
      if (narrowMonth()) {
        // Phone: a cell is too narrow for titles. Coloured marks (category shapes, as in the legend)
        // say "something here"; tapping the day opens it.
        if (rows.length) {
          const dots = h("span", { class: "hq-cal-dots", "aria-hidden": "true" });
          const shown = rows.length > 3 ? 2 : rows.length; // 3 marks fit one line; past that, 2 marks and "+n"
          rows.slice(0, shown).forEach((item) => dots.appendChild(h("span", { class: "hq-cal-dot " + catClass(item) })));
          if (rows.length > shown) dots.appendChild(h("span", { class: "hq-cal-dot-more", text: "+" + (rows.length - shown) }));
          cell.appendChild(dots);
          cell.querySelector(".hq-cal-mday").setAttribute("aria-label", fmtDay(day) + " · " + (rows.length === 1 ? "1 élément" : rows.length + " éléments"));
        }
        wrap.appendChild(cell);
        continue;
      }
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
    let order = 0; // first rows arrive one after another (motion only after the owner moved)
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
        button.style.setProperty("--n", String(Math.min(order++, 12)));
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
    if (!rows.length) return document.createTextNode(""); // nothing conditional: no empty box under the grid
    const block = h("section", { class: "hq-cal-cond" });
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
      if ((button.dataset.view || "week") === state.view) return;
      state.anim = "view";
      state.view = button.dataset.view || "week";
      try { localStorage.setItem("hq_cal_view", state.view); } catch (_) {}
      refresh(state.view === "day" && sameDay(state.anchor, serverToday()) ? "snap" : undefined);
      return;
    }
    if (kind === "prev" || kind === "next") {
      go(kind === "next" ? 1 : -1);
      return;
    }
    if (kind === "today") {
      goToday();
      return;
    }
    if (kind === "activity") {
      state.activity = !state.activity;
      try { localStorage.setItem("hq_cal_activity", state.activity ? "1" : "0"); } catch (_) {}
      refresh();
      return;
    }
    if (kind === "legend") {
      state.legend = !state.legend;
      render();
      const again = document.querySelector('#hq-cal-app [data-cal="legend"]');
      if (again) again.focus();
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
      state.anim = state.view === "day" ? (day < state.anchor ? "prev" : "next") : "view";
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
      hintDone();
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

  let sheetOpener = null;
  let sheetRelease = null;

  function rememberOpener() {
    if (sheetOpener && document.contains(sheetOpener) && !(sheetOpener.closest && sheetOpener.closest(".hq-sheet"))) return;
    const active = document.activeElement;
    if (!active || active === document.body) return;
    if (active.closest && active.closest(".hq-sheet, dialog")) return;
    sheetOpener = active;
  }

  function releaseSheet() {
    if (sheetRelease) sheetRelease();
    sheetRelease = null;
  }

  function sheet(id) {
    if (window.hqHideHelp) window.hqHideHelp();
    rememberOpener();
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

  /* Left / right arrows change period and T comes back to today, on the calendar view only, never
     while typing or while a sheet, dialog or the search palette is open. */
  function navKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || !document.body || document.body.dataset.view !== "calendrier") return;
    const target = ev.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (document.querySelector("dialog[open]") || [...document.querySelectorAll(".hq-sheet")].some((s) => !s.hidden)) return;
    const palette = document.getElementById("hq-palette");
    if (palette && !palette.hidden) return;
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      go(ev.key === "ArrowRight" ? 1 : -1);
    } else if (ev.key === "t" || ev.key === "T") {
      ev.preventDefault();
      goToday();
    }
  }

  /* Swipe left / right on the calendar (touch only) to change period. Vertical moves stay scrolls. */
  function bindSwipe(root) {
    let start = null;
    root.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch" || ev.target.closest(".hq-cal-bar, .hq-sheet")) { start = null; return; }
      start = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    }, { passive: true });
    root.addEventListener("pointercancel", () => { start = null; }, { passive: true });
    root.addEventListener("pointerup", (ev) => {
      if (!start || ev.pointerType !== "touch") return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const quick = Date.now() - start.t < 700;
      start = null;
      if (!quick || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      hintDone();
      suppressClick();
      go(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  /* The pointerup of a swipe must not also count as a tap on the slot or event under the finger. */
  function suppressClick() {
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => document.removeEventListener("click", stop, { capture: true }), 400);
  }

  function closeSheets() {
    ["hq-cal-detail", "hq-cal-editor"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) {
        node.hidden = true;
        node.textContent = "";
      }
    });
    releaseSheet();
    const opener = sheetOpener;
    sheetOpener = null;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
  }

  function openDetail(item) {
    const root = sheet("hq-cal-detail");
    const card = h("div", { class: "hq-sheet-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-detail-title" });
    card.appendChild(h("h3", { id: "hq-cal-detail-title", text: item.title || "Sans titre" }));
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
    card.tabIndex = -1;
    root.appendChild(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus();
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

  async function busy(label, fn) {
    if (typeof withBusy === "function") return withBusy(label, fn);
    return fn();
  }

  async function runTarget(item, target) {
    const catalog = (state.data && state.data.catalog) || {};
    const label = target === "scene" ? labelFor(catalog.scenes, item.scene_id) : labelFor(catalog.actions, item.action_id);
    const noun = target === "scene" ? "la scène" : "l'action";
    if (!window.confirm("Lancer " + noun + " « " + label + " » ?")) return;
    try {
      await busy("Lancement…", () => api("/api/calendar/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, target: target }),
      }));
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
      await busy("Suppression…", () => api("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: item.id, expected_rev: item.rev }),
      }));
      closeSheets();
      if (typeof toast === "function") toast("Événement supprimé");
      refresh();
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Suppression impossible", "err");
    }
  }

  function openEditor(item) {
    const root = sheet("hq-cal-editor");
    const card = h("form", { class: "hq-sheet-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-editor-title" });
    card.appendChild(h("h3", { id: "hq-cal-editor-title", text: item.id ? "Modifier" : "Nouvel événement" }));
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
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
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
      await busy("Enregistrement…", () => api("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", expected_rev: item.id ? item.rev : 0, event: payload }),
      }));
      closeSheets();
      if (typeof toast === "function") toast("Événement enregistré");
      refresh();
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
    }
  }

  function onKey(ev) {
    if (ev.key !== "Escape") {
      navKey(ev);
      return;
    }
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
    paintNext(cal);
  }

  function fmtNextDay(date) {
    return new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(date);
  }

  function nextParts(cal) {
    const next = cal && cal.next;
    if (!next) return { when: "", title: "Rien à venir." };
    const title = next.title || "Sans titre";
    if (next.all_day) {
      const start = parseLocalDateKey(next.start);
      const same = !!(start && cal.server_date && dateKey(start) === cal.server_date);
      return { when: !start || same ? "Journée" : fmtNextDay(start) + " · Journée", title: title };
    }
    const start = parseLocalDateTime(next.start);
    if (!start) return { when: "", title: title };
    const same = !!(cal.server_date && dateKey(start) === cal.server_date);
    return { when: same ? fmtTime(start) : fmtNextDay(start) + " · " + fmtTime(start), title: title };
  }

  function paintNext(cal) {
    const nextLine = document.getElementById("hq-cal-next");
    if (!nextLine) return;
    nextLine.textContent = "";
    const parts = nextParts(cal);
    const next = cal && cal.next;
    if (next) nextLine.appendChild(h("span", { class: "hq-next-label", text: "Prochain" }));
    if (parts.when) {
      if (next) nextLine.appendChild(h("span", { class: "hq-next-sep", "aria-hidden": "true", text: "·" }));
      nextLine.appendChild(h("span", { class: "hq-next-when", text: parts.when }));
    }
    if (next) nextLine.appendChild(h("span", { class: "hq-next-sep", "aria-hidden": "true", text: "·" }));
    nextLine.appendChild(h("span", { class: "hq-next-title", text: parts.title }));
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
    bindSwipe(root);
    const narrow = window.matchMedia("(max-width: 600px)");
    const onWidth = () => { if (state.data && state.view === "week") refresh(); };
    if (narrow.addEventListener) narrow.addEventListener("change", onWidth);
    else if (narrow.addListener) narrow.addListener(onWidth);
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
    // Global search: open the day of an event found in the palette (same as picking that day).
    window.hqCalendarOpenDay = function (key) {
      const day = parseLocalDateKey(key);
      if (!day) return;
      state.userMoved = true;
      state.anchor = day;
      state.view = "day";
      refresh(sameDay(day, serverToday()) ? "snap" : undefined);
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
