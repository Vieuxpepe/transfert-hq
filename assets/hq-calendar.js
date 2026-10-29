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
    prevAnchor: null,
    landed: "",      // id of the event that was just created or moved: it lands with a small bounce
    zoomFrom: null,  // month cell centre the day view zooms out of
    burst: "",       // id of the event just marked done: its check bursts once
    zoom: 1,         // hour height factor (pinch on touch, Ctrl + wheel or trackpad pinch on desktop)
    sound: false,    // soft sounds, off unless the owner turns them on
    fetchedAt: 0,    // when server_now was read: the live clock runs from there
  };
  const SNAP_MIN = 15;
  let drag = null;           // the grid drag in progress (create, move or resize)
  let renderPending = false; // a refresh arrived during a drag: draw once the drag ends
  let lastPoint = null;      // where the owner last pressed: sheets grow out of that point
  let swipe = null;          // the sideways swipe in progress (the period follows the finger)
  let undoTimer = null;
  let audio = null;
  let hapticLabel = null;
  let lastBuzz = 0;
  let nextUpShown = "";
  const preview = { ghost: null, spot: "" }; // quick add: the see-through event drawn while typing
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 2.4;
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
      const start = startOfLocalWeek(anchor); // the whole strip: its day rings need the week
      return { from: dateKey(start), to: dateKey(addLocalDays(start, 7)) };
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
      state.fetchedAt = Date.now();
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

  /* ---- the next thing: a card with a countdown ring ---- */
  function nextUpItem() {
    const now = liveNow();
    if (!now) return null;
    const list = items().filter((item) => !item.read_only && !item.all_day && itemStart(item) && itemEnd(item) && itemEnd(item) > now);
    const far = state.data && state.data.next;
    if (far && !list.some((item) => item.id === far.id) && parseLocalDateTime(far.start) && parseLocalDateTime(far.end) > now) list.push(far);
    list.sort((a, b) => itemStart(a) - itemStart(b));
    const first = list[0];
    return first && itemStart(first) - now < 24 * 3600000 ? first : null;
  }

  function fmtLeft(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60) return mins + " min";
    const rest = mins % 60;
    return Math.floor(mins / 60) + " h" + (rest ? " " + pad(rest) : "");
  }

  function nextUp() {
    const item = nextUpItem();
    if (!item) {
      nextUpShown = "";
      return document.createTextNode("");
    }
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
    const card = h("button", {
      type: "button",
      id: "hq-cal-nextup",
      class: "hq-cal-nextup " + catClass(item),
      "data-cal": "nextup",
      "data-id": item.id,
      "data-day": String(item.start).slice(0, 10),
    }, [
      svg,
      h("span", { class: "hq-cal-nextup-text" }, [
        h("span", { class: "hq-cal-nextup-label" }),
        h("span", { class: "hq-cal-nextup-title", text: item.title || "Sans titre" }),
      ]),
      h("span", { class: "hq-cal-nextup-when" }),
    ]);
    const fresh = nextUpShown !== item.id;
    nextUpShown = item.id;
    paintNextUp(card, item, fresh);
    return card;
  }

  function paintNextUp(card, item, fresh) {
    const now = liveNow();
    const a = itemStart(item);
    const b = itemEnd(item);
    if (!now || !a || !b) return;
    const live = a <= now;
    const left = a - now;
    const p = live ? (now - a) / Math.max(1, b - a) : 1 - Math.min(1, left / (120 * 60000)); // fills over the last two hours
    const label = live ? "En cours" : "Prochain";
    const when = live ? "encore " + fmtLeft(b - now) : left < 60000 ? "maintenant" : "dans " + fmtLeft(left);
    card.classList.toggle("is-now", live);
    card.classList.toggle("is-soon", !live && left <= 15 * 60000);
    card.querySelector(".hq-cal-nextup-label").textContent = label;
    card.querySelector(".hq-cal-nextup-when").textContent = when;
    card.setAttribute("aria-label", label + " : " + (item.title || "Sans titre") + ", " + when);
    const fill = card.querySelector(".hq-cal-ring .fill");
    const C = 2 * Math.PI * 16;
    fill.style.strokeDasharray = C.toFixed(2);
    const offset = (C * (1 - Math.max(0.02, Math.min(1, p)))).toFixed(2);
    if (fresh && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fill.style.strokeDashoffset = C.toFixed(2); // draws itself in once
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.strokeDashoffset = offset; }));
    } else {
      fill.style.strokeDashoffset = offset;
    }
  }

  /* Every 20 s: the now line moves, the countdown counts, the light shifts. No rebuild unless the
     next thing changed. */
  function paintLive() {
    const root = document.getElementById("hq-cal-app");
    const now = liveNow();
    if (!root || !now) return;
    const mins = now.getHours() * 60 + now.getMinutes();
    root.querySelectorAll(".hq-cal-now").forEach((line) => {
      line.style.top = (mins / 1440) * 100 + "%";
      const t = line.querySelector(".hq-cal-now-time");
      if (t) t.textContent = fmtTime(now);
    });
    const card = document.getElementById("hq-cal-nextup");
    const item = nextUpItem();
    if ((card ? card.dataset.id : "") !== (item ? item.id : "")) {
      if (!drag && !swipe && !document.querySelector(".hq-cal-row.is-leaving")) renderKeep();
      return;
    }
    if (card && item) paintNextUp(card, item, false);
    paintAmbient(now);
  }

  /* The calendar's light follows the hour: cool morning, bright day, warm evening, deep blue night. */
  const AMBIENT = [
    [0, [52, 60, 140]], [5, [70, 76, 160]], [7, [120, 176, 255]], [11, [140, 205, 255]], [14, [255, 222, 150]],
    [18, [255, 150, 96]], [20, [206, 104, 170]], [22, [80, 78, 170]], [24, [52, 60, 140]],
  ];

  function paintAmbient(now) {
    const root = document.getElementById("hq-cal-app");
    const section = root && root.closest(".hq-cal");
    if (!section || !now) return;
    const t = now.getHours() + now.getMinutes() / 60;
    let i = 0;
    while (i < AMBIENT.length - 2 && AMBIENT[i + 1][0] <= t) i += 1;
    const [t0, c0] = AMBIENT[i];
    const [t1, c1] = AMBIENT[i + 1];
    const k = (t - t0) / (t1 - t0);
    const rgb = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    section.classList.add("hq-cal-ambient");
    section.style.setProperty("--hq-amb", "rgb(" + rgb.join(",") + ")");
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
    if (drag || (swipe && swipe.locked)) {
      renderPending = true; // never rebuild the grid under a press, a drag or a swipe
      return;
    }
    if (window.hqHideHelp) window.hqHideHelp();
    root.textContent = "";
    paintTz();
    root.appendChild(toolbar());
    const legend = legendPanel();
    legend.hidden = !state.legend;
    root.appendChild(legend);
    root.appendChild(nextUp());
    if (state.data && state.data.malformed) {
      root.appendChild(h("p", { class: "hint", text: "Fichier calendrier illisible — il n'a pas été écrasé." }));
    }
    const stage = h("div", { class: "hq-cal-stage" + (state.anim ? " is-" + state.anim : "") });
    if (state.anim === "zoom" && state.zoomFrom) stage.style.transformOrigin = state.zoomFrom.x + "px " + state.zoomFrom.y + "px";
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
    state.prevAnchor = state.anchor;
    state.zoomFrom = null;
    state.landed = "";
    state.burst = "";
    paintPreview();
    paintRecent();
    paintLive();
  }

  /* Redraw without losing the grid's scroll position. */
  function renderKeep() {
    const before = dayScroll();
    const top = before ? before.scrollTop : null;
    render();
    const after = dayScroll();
    if (after && top != null) after.scrollTop = top;
  }

  /* HQ's clock, ticking on from the moment it was read. */
  function liveNow() {
    const base = serverNow();
    if (!base) return null;
    return new Date(base.getTime() + Math.max(0, Date.now() - (state.fetchedAt || Date.now())));
  }

  function landedClass(item) {
    return state.landed && item && item.id === state.landed ? " is-landed" : "";
  }

  /* A short tap of the phone. Android: vibrate. iPhone ignores vibrate, but Safari 18+ taps when a
     switch toggle changes, so a hidden one is toggled instead (a no-op elsewhere). */
  function buzz(ms) {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const t = Date.now();
      if (t - lastBuzz < 45) return; // snaps in a fast drag: one tap per step at most
      lastBuzz = t;
      if (navigator.vibrate) {
        navigator.vibrate(ms || 8);
        return;
      }
      if (!hapticLabel) {
        const input = h("input", { type: "checkbox", switch: "", tabindex: "-1" });
        hapticLabel = h("label", { class: "hq-cal-haptic", "aria-hidden": "true" }, [input]);
        document.body.appendChild(hapticLabel);
      }
      hapticLabel.click();
    } catch (_) {}
  }

  /* Soft sounds, made on the spot (no files). Off unless the owner turns them on. */
  const TONES = {
    snap: [[1900, 0, 0.02, 0.018]],
    lift: [[520, 0, 0.07, 0.03]],
    drop: [[210, 0, 0.13, 0.08], [630, 0, 0.07, 0.03]],
    save: [[880, 0, 0.16, 0.05], [1318.5, 0.08, 0.24, 0.05]],
    done: [[1046.5, 0, 0.12, 0.045], [1568, 0.06, 0.18, 0.045], [2093, 0.12, 0.26, 0.035]],
    delete: [[440, 0, 0.1, 0.05], [294, 0.06, 0.2, 0.05]],
    undo: [[660, 0, 0.1, 0.045], [880, 0.06, 0.16, 0.045]],
    swipe: [[700, 0, 0.06, 0.02]],
  };

  function chime(kind) {
    if (!state.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = audio || new Ctx();
      if (audio.state === "suspended") audio.resume();
      const t = audio.currentTime + 0.005;
      (TONES[kind] || []).forEach(([freq, at, dur, gain]) => {
        const osc = audio.createOscillator();
        const amp = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        amp.gain.setValueAtTime(0.0001, t + at);
        amp.gain.exponentialRampToValueAtTime(gain, t + at + 0.01);
        amp.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        osc.connect(amp);
        amp.connect(audio.destination);
        osc.start(t + at);
        osc.stop(t + at + dur + 0.03);
      });
    } catch (_) {}
  }

  /* Is this day on screen in the current view? */
  function dayVisible(day) {
    const anchor = state.anchor || todayLocal();
    if (state.view === "day") return sameDay(day, anchor);
    if (state.view === "week") {
      const start = weekStart(anchor);
      return day >= start && day < addLocalDays(start, weekSpan());
    }
    if (state.view === "month") return day.getFullYear() === anchor.getFullYear() && day.getMonth() === anchor.getMonth();
    return day >= anchor && day < addLocalDays(anchor, 30);
  }

  /* After a save: show the event's day if it is off screen, and let the event land there. */
  function landOn(event) {
    if (!event || !event.id) return refresh("keep");
    const day = parseLocalDateKey(String(event.start || "").slice(0, 10));
    state.landed = event.id;
    if (day && !dayVisible(day)) {
      state.userMoved = true;
      state.anim = day < state.anchor ? "prev" : "next";
      state.anchor = day;
      if (state.view === "day" && sameDay(day, serverToday())) return refresh("snap");
      return refresh();
    }
    return refresh("keep");
  }

  /* Previous / next period, from the arrows, a swipe or the arrow keys. */
  function go(dir, how) {
    state.userMoved = true;
    state.anim = (how === "swipe" ? "swipe-" : "") + (dir > 0 ? "next" : "prev");
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
    tools.appendChild(h("button", {
      type: "button",
      class: "hq-cal-toggle",
      "data-cal": "sound",
      "aria-pressed": state.sound ? "true" : "false",
      "data-help": "Petits sons doux : glisser, déposer, enregistrer, cocher.",
      text: "Sons",
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
    const start = startOfLocalWeek(state.anchor);
    const index = Math.round((startOfDayMs(state.anchor) - startOfDayMs(start)) / 86400000);
    const prev = state.prevAnchor ? Math.round((startOfDayMs(state.prevAnchor) - startOfDayMs(start)) / 86400000) : index;
    const slide = /^(swipe-)?(next|prev)$/.test(state.anim) && prev >= 0 && prev < 7 && prev !== index;
    const strip = h("div", {
      class: "hq-cal-weekstrip" + (slide ? " is-moving" : ""),
      style: "--i:" + index + ";--from:" + (slide ? prev : index),
    });
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
      markRing(button, day);
      strip.appendChild(button);
    }
    return strip;
  }

  /* How much of a day the owner got through: finished events marked done, out of finished events. */
  function dayRing(day) {
    const now = liveNow();
    if (!now) return null;
    const ended = items().filter((item) => !item.read_only && !item.all_day && overlapsDay(item, day) && itemEnd(item) && itemEnd(item) <= now);
    if (!ended.length) return null;
    const done = ended.filter((item) => item.done).length;
    return { done, total: ended.length, p: done / ended.length };
  }

  function markRing(button, day) {
    const ring = dayRing(day);
    if (!ring) return;
    button.classList.add("has-ring");
    if (ring.p >= 1) button.classList.add("is-complete");
    button.style.setProperty("--p", ring.p.toFixed(3));
    button.setAttribute("aria-label", fmtDay(day) + " · " + ring.done + " sur " + ring.total + " fait" + (ring.done > 1 ? "s" : ""));
  }

  function startOfDayMs(date) {
    return makeLocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate()).getTime();
  }

  function serverToday() {
    return (state.data && parseLocalDateKey(state.data.server_date)) || todayLocal();
  }

  function serverNow() {
    return state.data ? parseLocalDateTime(state.data.server_now) : null;
  }

  function allDayLane(day) {
    const lane = h("div", { class: "hq-cal-allday", "data-allday": dateKey(day) });
    const rows = items().filter((item) => item.all_day && overlapsDay(item, day));
    if (!rows.length) return lane; // empty: hidden by CSS, no filler line
    rows.forEach((item) => lane.appendChild(chip(item)));
    return lane;
  }

  function chip(item) {
    const title = item.title || "Sans titre";
    const node = h("button", {
      type: "button",
      class: "hq-cal-chip " + catClass(item) + landedClass(item),
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
    const col = h("div", { class: "hq-cal-col", "data-col-day": dateKey(day) });
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
    return (state.view === "week" ? 44 : 48) * 24 * state.zoom;
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
    const now = liveNow();
    placed.forEach((entry, order) => {
      const width = 100 / entry.cols;
      const spanMin = Math.max(1, entry.endMin - entry.startMin);
      const top = (entry.startMin / 1440) * 100;
      const height = (spanMin / 1440) * 100;
      let hitTop = top;
      let hitHeight = coarse ? height : Math.max(height, 1.6);
      const past = !!(now && itemEnd(entry.item) && itemEnd(entry.item) <= now);
      const checkable = canCheck(entry.item, now);
      const button = h("button", {
        type: "button",
        class: "hq-cal-event" + (coarse ? "" : " " + catClass(entry.item)) + (past ? " is-past" : "") + landedClass(entry.item)
          + (movable(entry.item) ? " is-movable" : "") + (entry.item.done ? " is-done" : "") + (checkable ? " has-check" : "")
          + (state.burst === entry.item.id ? " is-burst" : ""),
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
      if (movable(entry.item)) {
        // Bottom edge: drag to change the end. On touch it sits at the bottom of the visible face.
        const grip = h("span", { class: "hq-cal-resize", "data-grip": "end", "aria-hidden": "true" });
        if (coarse) grip.style.top = "calc(" + (((top - hitTop) + height) / hitHeight) * 100 + "% - 14px)";
        button.appendChild(grip);
      }
      if (checkable) {
        const check = checkMark(entry.item);
        if (coarse) check.style.top = ((top - hitTop) / hitHeight) * 100 + "%";
        button.appendChild(check);
      }
      col.appendChild(button);
    });
    return columns;
  }

  /* A started event the owner wrote can be ticked off. */
  function canCheck(item, now) {
    const start = itemStart(item);
    return !!(item && !item.read_only && start && now && start <= now);
  }

  function checkMark(item) {
    const check = h("span", {
      class: "hq-cal-check",
      "data-cal": "done",
      "data-id": item.id,
      "aria-hidden": "true",
      title: item.done ? "Fait — toucher pour annuler" : "Marquer comme fait",
    });
    if (state.burst === item.id) check.appendChild(h("span", { class: "hq-cal-burst" }));
    return check;
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
    const now = liveNow();
    if (!now || !sameDay(now, day)) return;
    const mins = now.getHours() * 60 + now.getMinutes();
    col.appendChild(
      h("div", { class: "hq-cal-now", style: "top:" + (mins / 1440) * 100 + "%" }, [
        h("span", { text: "Maintenant" }),
        h("span", { class: "hq-cal-now-time", "aria-hidden": "true", text: fmtTime(now) }),
      ])
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
      markRing(headBtn, day);
      head.appendChild(headBtn);
      const cell = h("div", { class: "hq-cal-allcell", "data-allday": dateKey(day) });
      items()
        .filter((item) => item.all_day && overlapsDay(item, day))
        .slice(0, 3)
        .forEach((item) => cell.appendChild(chip(item)));
      all.appendChild(cell);
      const col = h("div", { class: "hq-cal-weekcol", "data-col-day": dateKey(day) });
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
          rows.slice(0, shown).forEach((item) => dots.appendChild(h("span", { class: "hq-cal-dot " + catClass(item) + landedClass(item) })));
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
      const now = liveNow();
      allDay.concat(timed).forEach((item) => {
        const when = item.all_day ? "Journée" : spanLabel(item);
        const button = h("button", {
          type: "button",
          class: "hq-cal-row " + catClass(item) + landedClass(item) + (item.done ? " is-done" : "") + (state.burst === item.id ? " is-burst" : ""),
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
        if (canCheck(item, now)) button.appendChild(checkMark(item));
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
    if (kind === "sound") {
      state.sound = !state.sound;
      try { localStorage.setItem("hq_cal_sound", state.sound ? "1" : "0"); } catch (_) {}
      button.setAttribute("aria-pressed", state.sound ? "true" : "false");
      chime("save");
      return;
    }
    if (kind === "done") {
      toggleDone(findItem(button.dataset.id));
      return;
    }
    if (kind === "nextup") {
      const item = items().find((row) => row.id === button.dataset.id);
      if (item) openDetail(item);
      else {
        const day = parseLocalDateKey(button.dataset.day);
        if (!day) return;
        state.userMoved = true;
        state.anim = "view";
        state.view = "day";
        state.anchor = day;
        state.landed = button.dataset.id;
        refresh();
      }
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
      if (state.view === "month") {
        const app = document.getElementById("hq-cal-app").getBoundingClientRect();
        const cell = (button.closest(".hq-cal-mcell") || button).getBoundingClientRect();
        state.anim = "zoom";
        state.zoomFrom = { x: Math.round(cell.left + cell.width / 2 - app.left), y: Math.round(cell.top + cell.height / 2 - app.top) };
      }
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
    clearTimeout(node.closeTimer);
    node.classList.remove("is-closing");
    node.hidden = false;
    node.textContent = "";
    return node;
  }

  /* The card grows out of where the owner pressed (a slot, an event, a button), with a soft spring. */
  function present(card) {
    const rect = card.getBoundingClientRect();
    const recent = lastPoint && Date.now() - lastPoint.t < 1500;
    const ox = recent ? lastPoint.x : rect.left + rect.width / 2;
    const oy = recent ? lastPoint.y : rect.top + rect.height;
    card.style.setProperty("--dx", Math.round(ox - (rect.left + rect.width / 2)) + "px");
    card.style.setProperty("--dy", Math.round(oy - (rect.top + rect.height / 2)) + "px");
    card.classList.add("is-morph");
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

  /* ---- quick add: one sentence, Entrée, done ---- */
  function fmtQuickDay(date) {
    return new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(date);
  }

  function quickDraft(text) {
    const parser = window.HQCalendarQuick;
    if (!parser) return null;
    return parser.parse(text, serverNow() || new Date(), state.anchor || todayLocal());
  }

  function paintQuick(keepGhost) {
    const input = document.getElementById("hq-cal-quick-input");
    const preview = document.getElementById("hq-cal-quick-preview");
    const more = document.getElementById("hq-cal-quick-more");
    if (!input || !preview) return;
    const text = input.value.trim();
    const draft = text ? quickDraft(text) : null;
    preview.textContent = "";
    preview.hidden = !text;
    if (more) more.hidden = !text;
    paintRecent();
    if (!keepGhost) paintPreview();
    if (!text) return;
    if (!draft) {
      preview.appendChild(h("span", { class: "hint", text: "Ajoute un titre." }));
      return;
    }
    const day = parseLocalDateKey(draft.start.slice(0, 10));
    const cat = CATS.find((row) => row[0] === draft.category);
    const when = draft.all_day ? "Journée" : draft.start.slice(11, 16) + "–" + draft.end.slice(11, 16);
    preview.appendChild(h("span", { class: "hq-cal-quick-chip cat-" + draft.category }, [
      h("strong", { text: draft.title }),
      h("span", { text: " · " + (day ? fmtQuickDay(day) : "") + " · " + when + (cat && draft.category !== "other" ? " · " + cat[1] : "") }),
    ]));
  }

  /* While typing, the event appears see-through in its slot (when its day is on screen) and moves as
     the words change; Entrée makes it solid and the saved event lands there. */
  function paintPreview() {
    const root = document.getElementById("hq-cal-app");
    const input = document.getElementById("hq-cal-quick-input");
    if (!root) return;
    root.querySelectorAll(".hq-cal-chip.is-preview").forEach((node) => node.remove());
    const text = input ? input.value.trim() : "";
    const draft = text ? quickDraft(text) : null;
    const clear = () => {
      if (preview.ghost) preview.ghost.remove();
      preview.spot = "";
    };
    if (!draft) return clear();
    const key = draft.start.slice(0, 10);
    if (draft.all_day) {
      clear();
      const lane = root.querySelector('[data-allday="' + key + '"]');
      if (lane) lane.appendChild(h("span", { class: "hq-cal-chip is-preview cat-" + draft.category, "aria-hidden": "true", text: draft.title }));
      return;
    }
    const col = root.querySelector('[data-col-day="' + key + '"]');
    if (!col) return clear();
    const a = Number(draft.start.slice(11, 13)) * 60 + Number(draft.start.slice(14, 16));
    let b = draft.end.slice(0, 10) === key ? Number(draft.end.slice(11, 13)) * 60 + Number(draft.end.slice(14, 16)) : 1440;
    if (b <= a) b = 1440;
    if (!preview.ghost) {
      preview.ghost = h("div", { "aria-hidden": "true" }, [h("span", { class: "hq-cal-ghost-time" }), h("span", { class: "hq-cal-ghost-title" })]);
    }
    const ghost = preview.ghost;
    ghost.className = "hq-cal-ghost is-preview cat-" + draft.category;
    if (ghost.parentNode !== col) col.appendChild(ghost);
    ghost.style.top = (a / 1440) * 100 + "%";
    ghost.style.height = (Math.max(SNAP_MIN, b - a) / 1440) * 100 + "%";
    ghost.firstChild.textContent = hhmm(a) + "–" + hhmm(b);
    ghost.lastChild.textContent = draft.title;
    const spot = key + "/" + a;
    if (spot === preview.spot) return;
    preview.spot = spot;
    // Bring it into view inside the grid (never the page: the keyboard may be up).
    const scroll = col.closest(".hq-cal-scroll");
    if (!scroll || scroll.scrollHeight <= scroll.clientHeight + 1) return;
    const sr = scroll.getBoundingClientRect();
    const gr = col.getBoundingClientRect();
    const y = gr.top - sr.top + scroll.scrollTop + (a / 1440) * gr.height;
    if (y < scroll.scrollTop + 30 || y > scroll.scrollTop + scroll.clientHeight - 60) {
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scroll.scrollTo({ top: Math.max(0, y - scroll.clientHeight * 0.35), behavior: calm ? "auto" : "smooth" });
    }
  }

  /* Under the empty field: the owner's latest titles. One tap writes « Sport 18h » (their usual time). */
  function fmtDur(mins) {
    if (mins % 60 === 0) return mins / 60 + "h";
    if (mins > 60) return Math.floor(mins / 60) + "h" + pad(mins % 60);
    return mins + "min";
  }

  function quickText(row) {
    let text = row.title;
    if (row.time) {
      const [hh, mm] = row.time.split(":");
      text += " " + Number(hh) + "h" + (mm !== "00" ? mm : "");
      if (row.minutes && row.minutes !== 60) text += " pendant " + fmtDur(row.minutes);
    }
    return text + " ";
  }

  function paintRecent() {
    const box = document.getElementById("hq-cal-quick-recent");
    const input = document.getElementById("hq-cal-quick-input");
    if (!box || !input) return;
    const rows = ((state.data && state.data.recent) || []).slice(0, 6);
    box.hidden = !!input.value.trim() || !rows.length;
    const sig = JSON.stringify(rows);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = "";
    rows.forEach((row) => {
      box.appendChild(h("button", {
        type: "button",
        class: "hq-cal-recent-chip cat-" + (row.category || "other"),
        "data-quick": quickText(row),
        "aria-label": "Écrire « " + quickText(row).trim() + " »",
      }, [document.createTextNode(row.title), row.time ? h("span", { text: row.time }) : null]));
    });
  }

  function saveCall(event, rev) {
    return api("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", expected_rev: rev, event: event }),
    });
  }

  function deleteCall(id, rev) {
    return api("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: id, expected_rev: rev }),
    });
  }

  /* Every change can be taken back for five seconds: no confirmations, no fear. */
  function offerUndo(label, undo) {
    let bar = document.getElementById("hq-cal-undo");
    if (!bar) {
      bar = h("div", { id: "hq-cal-undo", class: "hq-cal-undo", role: "status", "aria-live": "polite" });
      bar.hidden = true;
      document.body.appendChild(bar);
    }
    clearTimeout(undoTimer);
    bar.textContent = "";
    const button = h("button", { type: "button", class: "hq-cal-undo-btn", text: "Annuler" });
    bar.appendChild(h("span", { class: "hq-cal-undo-text", text: label }));
    bar.appendChild(button);
    bar.appendChild(h("span", { class: "hq-cal-undo-time", "aria-hidden": "true" }));
    bar.hidden = false;
    bar.classList.remove("is-in", "is-out");
    void bar.offsetWidth;
    bar.classList.add("is-in");
    const hide = () => {
      clearTimeout(undoTimer);
      bar.classList.add("is-out");
      undoTimer = setTimeout(() => { bar.hidden = true; bar.classList.remove("is-in", "is-out"); }, 200);
    };
    button.addEventListener("click", async () => {
      hide();
      try {
        await undo();
        chime("undo");
        buzz(8);
      } catch (err) {
        if (typeof toast === "function") toast((err && err.message) || "Annulation impossible", "err");
        refresh("keep");
      }
    }, { once: true });
    undoTimer = setTimeout(hide, 5000);
  }

  /* Tick an event off (or back): the check bursts, the day's ring fills. */
  async function toggleDone(item) {
    if (!item || item.read_only) return;
    const before = !!item.done;
    item.done = !before;
    state.burst = item.done ? item.id : "";
    renderKeep();
    if (item.done) {
      chime("done");
      buzz(14);
    }
    try {
      await saveCall(eventPayload(item), item.rev);
      refresh("keep");
    } catch (err) {
      item.done = before;
      renderKeep();
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
      refresh("keep");
    }
  }

  function eventPayload(source, over) {
    const item = Object.assign({}, source, over || {});
    const payload = {
      title: item.title || "",
      all_day: !!item.all_day,
      start: item.start,
      end: item.end,
      category: item.category || "other",
      notes: item.notes || "",
      location: item.location || "",
      scene_id: item.scene_id || "",
      action_id: item.action_id || "",
      device_id: item.device_id || "",
      reminders_min: Array.isArray(item.reminders_min) ? item.reminders_min : [],
      done: !!item.done,
    };
    if (item.id) payload.id = item.id;
    return payload;
  }

  async function quickSave(form) {
    const input = document.getElementById("hq-cal-quick-input");
    const draft = quickDraft(input.value.trim());
    if (!draft) {
      shake(form);
      input.focus();
      return;
    }
    form.classList.add("is-saving");
    if (preview.ghost) preview.ghost.classList.add("is-solid");
    try {
      const saved = await saveCall(eventPayload(draft), 0);
      input.value = "";
      paintQuick(true); // the solid ghost stays until the saved event lands in its place
      form.classList.remove("is-done");
      void form.offsetWidth; // restart the check animation
      form.classList.add("is-done");
      setTimeout(() => form.classList.remove("is-done"), 900);
      buzz(10);
      chime("save");
      const ev = saved && saved.event;
      if (ev) offerUndo("Ajouté · " + ev.title, async () => { await deleteCall(ev.id, ev.rev); refresh("keep"); });
      landOn(ev);
    } catch (err) {
      shake(form);
      if (preview.ghost) preview.ghost.classList.remove("is-solid");
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
    } finally {
      form.classList.remove("is-saving");
    }
  }

  function shake(node) {
    if (!node) return;
    node.classList.remove("is-shake");
    void node.offsetWidth;
    node.classList.add("is-shake");
    setTimeout(() => node.classList.remove("is-shake"), 420);
  }

  /* Built once, outside the re-rendered grid, so typing survives every refresh. */
  function mountQuick(root) {
    if (document.getElementById("hq-cal-quick")) return;
    const form = h("form", { class: "hq-cal-quick", id: "hq-cal-quick", autocomplete: "off" });
    const row = h("div", { class: "hq-cal-quick-row" });
    row.appendChild(h("span", { class: "hq-cal-quick-plus", "aria-hidden": "true" }));
    row.appendChild(h("input", { id: "hq-cal-quick-input", type: "text", maxlength: "160", enterkeyhint: "done", autocapitalize: "sentences",
      spellcheck: "false", "aria-label": "Ajouter un événement",
      placeholder: "Ajouter… « Dentiste demain 14h »", "aria-describedby": "hq-cal-quick-preview" }));
    const more = h("button", { type: "button", id: "hq-cal-quick-more", class: "hq-cal-quick-more", text: "Détails" });
    more.hidden = true;
    row.appendChild(more);
    form.appendChild(row);
    const line = h("div", { class: "hq-cal-quick-preview", id: "hq-cal-quick-preview", "aria-live": "polite" });
    line.hidden = true;
    form.appendChild(line);
    const recent = h("div", { class: "hq-cal-quick-recent", id: "hq-cal-quick-recent", role: "group", "aria-label": "Titres récents" });
    recent.hidden = true;
    form.appendChild(recent);
    root.parentNode.insertBefore(form, root);
    recent.addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-quick]");
      if (!chip) return;
      input.value = chip.dataset.quick;
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      buzz(6);
      paintQuick();
    });
    const input = form.querySelector("input");
    input.addEventListener("input", () => paintQuick());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && input.value) {
        ev.stopPropagation();
        input.value = "";
        paintQuick();
      }
    });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      quickSave(form);
    });
    more.addEventListener("click", () => {
      const draft = quickDraft(input.value.trim()) || blankDraft(state.anchor, 9);
      openEditor(Object.assign(blankDraft(state.anchor, 9), draft));
      input.value = "";
      paintQuick();
    });
  }

  /* ---- drag on the grid: create (empty hours), move (event), resize (bottom edge) ---- */
  function movable(item) {
    if (!item || item.read_only || item.all_day) return false;
    const a = itemStart(item);
    const b = itemEnd(item);
    return !!(a && b && sameDay(a, new Date(b.getTime() - 1))); // one day only
  }

  function minuteIn(col, clientY) {
    const rect = col.getBoundingClientRect();
    const raw = ((clientY - rect.top) / Math.max(1, rect.height)) * 1440;
    return Math.max(0, Math.min(1440, Math.round(raw / SNAP_MIN) * SNAP_MIN));
  }

  function colAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest("#hq-cal-app [data-col-day]") : null;
  }

  function hhmm(mins) {
    const m = Math.max(0, Math.min(1440, mins));
    return pad(Math.floor(m / 60) % 24 === 0 && m === 1440 ? 24 : Math.floor(m / 60)) + ":" + pad(m % 60);
  }

  function ghostAt(col, a, b, title, cat) {
    if (!drag.ghost) {
      drag.ghost = h("div", { class: "hq-cal-ghost " + (cat ? "cat-" + cat : "cat-hq"), "aria-hidden": "true" }, [
        h("span", { class: "hq-cal-ghost-time" }), h("span", { class: "hq-cal-ghost-title", text: title || "" }),
      ]);
    }
    if (drag.ghost.parentNode !== col) col.appendChild(drag.ghost);
    drag.ghost.style.top = (a / 1440) * 100 + "%";
    drag.ghost.style.height = (Math.max(SNAP_MIN, b - a) / 1440) * 100 + "%";
    drag.ghost.firstChild.textContent = hhmm(a) + "–" + hhmm(b);
  }

  function dragUpdate(x, y) {
    dragStep(x, y);
    const key = drag.range ? drag.range.join("-") + (drag.target ? drag.target.dataset.colDay : "") : "";
    if (key && key !== drag.lastKey) {
      if (drag.lastKey) {
        chime("snap");
        buzz(4);
      }
      drag.lastKey = key;
    }
  }

  function dragStep(x, y) {
    if (drag.mode === "create") {
      const now = minuteIn(drag.col, y);
      let a = Math.min(drag.anchorMin, now);
      let b = Math.max(drag.anchorMin + SNAP_MIN, now);
      if (now < drag.anchorMin) b = drag.anchorMin + SNAP_MIN;
      if (b - a < 30) b = Math.min(1440, a + 30);
      drag.range = [a, b];
      drag.target = drag.col;
      ghostAt(drag.col, a, b, "", "hq");
    } else if (drag.mode === "move") {
      const col = colAt(x, y) || drag.target || drag.col;
      const dur = drag.endMin - drag.startMin;
      let a = Math.round((minuteIn(col, y) - drag.grabOffset) / SNAP_MIN) * SNAP_MIN;
      a = Math.max(0, Math.min(1440 - dur, a));
      drag.range = [a, a + dur];
      drag.target = col;
      ghostAt(col, a, a + dur, drag.item.title, drag.item.category);
    } else {
      const b = Math.max(drag.startMin + SNAP_MIN, minuteIn(drag.col, y));
      drag.range = [drag.startMin, b];
      drag.target = drag.col;
      ghostAt(drag.col, drag.startMin, b, drag.item.title, drag.item.category);
    }
  }

  function dragActivate(x, y) {
    drag.active = true;
    document.getElementById("hq-cal-app").classList.add("is-dragging");
    if (drag.source) drag.source.classList.add("is-lifted");
    buzz(12);
    chime("lift");
    dragUpdate(x, y);
  }

  function dragEnd(commit) {
    const finished = drag;
    drag = null;
    clearTimeout(finished.timer);
    const root = document.getElementById("hq-cal-app");
    if (root) root.classList.remove("is-dragging");
    if (finished.source) finished.source.classList.remove("is-lifted");
    const pending = renderPending;
    renderPending = false;
    if (!finished.active) {
      if (pending) setTimeout(render, 0); // after the click this press may still turn into
      return;
    }
    suppressClick();
    if (finished.ghost) finished.ghost.remove();
    if (!commit || !finished.range || !finished.target) {
      if (pending) render();
      return;
    }
    const day = parseLocalDateKey(finished.target.dataset.colDay);
    const [a, b] = finished.range;
    const at = (mins) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, mins);
    if (finished.mode === "create") {
      const draft = blankDraft(day, 0);
      draft.start = minuteKey(at(a));
      draft.end = minuteKey(at(b));
      if (pending) render();
      openEditor(draft);
      return;
    }
    const startKey = minuteKey(at(a));
    const endKey = minuteKey(at(b));
    if (startKey === finished.item.start && endKey === finished.item.end) {
      if (pending) render();
      return;
    }
    commitMove(finished.item, startKey, endKey, finished.mode === "resize" ? "Durée changée" : "Déplacé");
  }

  async function commitMove(item, startKey, endKey, label) {
    const before = { start: item.start, end: item.end };
    const snapshot = Object.assign({}, item);
    const payload = eventPayload(item, { start: startKey, end: endKey });
    item.start = startKey; // show it in place at once; the server answer confirms it
    item.end = endKey;
    state.landed = item.id;
    renderKeep();
    chime("drop");
    try {
      const saved = await saveCall(payload, item.rev);
      buzz(10);
      const ev = saved && saved.event;
      if (ev) {
        offerUndo((label || "Déplacé") + " · " + (ev.title || ""), async () => {
          const back = await saveCall(eventPayload(snapshot, before), ev.rev);
          state.landed = back && back.event ? back.event.id : "";
          refresh("keep");
        });
      }
      refresh("keep");
    } catch (err) {
      item.start = before.start;
      item.end = before.end;
      renderKeep();
      if (typeof toast === "function") toast((err && err.message) || "Déplacement impossible", "err");
      refresh("keep");
    }
  }

  function bindDrag(root) {
    const LONG_PRESS = 380;
    root.addEventListener("pointerdown", (ev) => {
      lastPoint = { x: ev.clientX, y: ev.clientY, t: Date.now() };
      if (drag || (ev.pointerType === "mouse" && ev.button !== 0) || ev.target.closest(".hq-sheet, .hq-cal-check")) return;
      const slot = ev.target.closest(".hq-cal-slot");
      const eventBtn = ev.target.closest(".hq-cal-event.is-movable");
      let next = null;
      if (eventBtn) {
        const item = findItem(eventBtn.dataset.id);
        const col = eventBtn.closest("[data-col-day]");
        if (!item || !col || !movable(item)) return;
        const startDate = itemStart(item);
        const endDate = itemEnd(item);
        const startMin = startDate.getHours() * 60 + startDate.getMinutes();
        const endMin = sameDay(startDate, endDate) ? endDate.getHours() * 60 + endDate.getMinutes() : 1440;
        const resize = !!ev.target.closest("[data-grip='end']");
        next = { mode: resize ? "resize" : "move", item, col, source: eventBtn, startMin, endMin,
          grabOffset: minuteIn(col, ev.clientY) - startMin };
      } else if (slot) {
        const col = slot.closest("[data-col-day]");
        if (!col) return;
        next = { mode: "create", col, anchorMin: Math.floor(minuteIn(col, ev.clientY - 1) / SNAP_MIN) * SNAP_MIN };
      }
      if (!next) return;
      drag = Object.assign(next, { id: ev.pointerId, type: ev.pointerType, x0: ev.clientX, y0: ev.clientY, active: false, ghost: null });
      if (ev.pointerType !== "mouse") {
        // Touch: a press held still turns into a drag; moving first stays a scroll or a swipe.
        drag.timer = setTimeout(() => { if (drag && !drag.active) dragActivate(drag.x0, drag.y0); }, LONG_PRESS);
      }
    });
    window.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const moved = Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0);
      if (!drag.active) {
        if (drag.type === "mouse" && moved > 5) dragActivate(ev.clientX, ev.clientY);
        else if (drag.type !== "mouse" && moved > 8) dragEnd(false); // it was a scroll
        return;
      }
      dragUpdate(ev.clientX, ev.clientY);
    });
    window.addEventListener("pointerup", (ev) => {
      if (drag && ev.pointerId === drag.id) dragEnd(true);
    });
    window.addEventListener("pointercancel", (ev) => {
      if (drag && ev.pointerId === drag.id) dragEnd(false);
    });
    // Once a touch drag is live, the page must not scroll under it.
    document.addEventListener("touchmove", (ev) => {
      if (drag && drag.active) ev.preventDefault();
    }, { passive: false });
    document.addEventListener("keydown", (ev) => {
      if (drag && drag.active && ev.key === "Escape") {
        ev.stopPropagation();
        dragEnd(false);
      }
    }, true);
  }

  /* What the next / previous period is called (shown at the edge while swiping). */
  function periodLabel(dir) {
    const anchor = state.anchor || todayLocal();
    if (state.view === "day") return fmtQuickDay(addLocalDays(anchor, dir));
    if (state.view === "week") {
      const first = addLocalDays(weekStart(anchor), dir * weekSpan());
      return fmtShort(first) + " – " + fmtShort(addLocalDays(first, weekSpan() - 1));
    }
    if (state.view === "month") return fmtMonth(addMonths(anchor, dir));
    return "Dès le " + fmtShort(addLocalDays(anchor, dir * 30));
  }

  /* Swipe left / right (touch): the period follows the finger, the next one is named at the edge,
     and letting go springs to it (far enough, or a flick) or back. Vertical moves stay scrolls. */
  function bindSwipe(root) {
    const SKIP = ".hq-cal-bar, .hq-sheet, .hq-cal-row[data-id]:not(.is-schedule), .hq-cal-nextup";
    const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function peek(dir) {
      const node = h("div", { class: "hq-cal-peek " + (dir > 0 ? "is-next" : "is-prev"), "aria-hidden": "true" }, [
        h("span", { class: "hq-cal-peek-arrow", text: dir > 0 ? "›" : "‹" }), h("span", { text: periodLabel(dir) }),
      ]);
      node.style.top = swipe.stage.offsetTop + Math.min(140, swipe.stage.offsetHeight / 3) + "px";
      root.appendChild(node);
      return node;
    }
    function clearPeeks() {
      root.querySelectorAll(".hq-cal-peek").forEach((node) => node.remove());
    }
    function follow(dx) {
      if (!swipe.stage.isConnected) swipe.stage = root.querySelector(".hq-cal-stage") || swipe.stage; // a refresh landed before the lock
      const w = swipe.w;
      const edge = w * 0.5;
      const x = Math.abs(dx) <= edge ? dx : Math.sign(dx) * (edge + (Math.abs(dx) - edge) * 0.3); // rubber band
      swipe.stage.style.transform = "translate3d(" + x.toFixed(1) + "px,0,0)";
      swipe.stage.style.opacity = String(1 - Math.min(0.35, (Math.abs(x) / w) * 0.5));
      const dir = dx < 0 ? 1 : -1;
      const show = dir > 0 ? swipe.next : swipe.prev;
      const hide = dir > 0 ? swipe.prev : swipe.next;
      show.style.opacity = String(Math.min(1, Math.abs(dx) / 90));
      hide.style.opacity = "0";
      const ready = Math.abs(dx) > w * 0.28;
      if (ready !== show.classList.contains("is-ready")) {
        show.classList.toggle("is-ready", ready);
        if (ready) buzz(5);
      }
    }
    function settle(commitDir) {
      const g = swipe;
      swipe = null;
      if (!g) return;
      if (g.locked) suppressClick();
      const stage = g.stage.isConnected ? g.stage : root.querySelector(".hq-cal-stage") || g.stage;
      if (commitDir) {
        hintDone();
        chime("swipe");
        if (calm() || !g.locked) {
          clearPeeks();
          renderPending = false;
          go(commitDir, "swipe");
          return;
        }
        stage.style.transition = "transform .16s cubic-bezier(.4,0,1,1), opacity .16s ease-in";
        stage.style.transform = "translate3d(" + (commitDir > 0 ? -g.w : g.w) + "px,0,0)";
        stage.style.opacity = "0";
        setTimeout(() => {
          clearPeeks();
          renderPending = false;
          go(commitDir, "swipe");
        }, 140);
        return;
      }
      stage.style.transition = calm() ? "" : "transform .5s var(--hq-spring), opacity .3s ease";
      stage.style.transform = "";
      stage.style.opacity = "";
      root.querySelectorAll(".hq-cal-peek").forEach((node) => { node.style.opacity = "0"; });
      setTimeout(() => {
        clearPeeks();
        stage.style.transition = "";
        stage.classList.remove("is-tracking");
        if (renderPending) {
          renderPending = false;
          renderKeep();
        }
      }, calm() ? 0 : 500);
    }
    root.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch") return;
      if (swipe) { settle(0); return; } // a second finger: a pinch, not a swipe
      if (ev.target.closest(SKIP)) return;
      const stage = root.querySelector(".hq-cal-stage");
      if (!stage) return;
      swipe = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), stage, locked: false, v: 0, lastX: ev.clientX, lastT: Date.now(), w: Math.max(1, stage.offsetWidth) };
    }, { passive: true });
    window.addEventListener("pointermove", (ev) => {
      if (!swipe || ev.pointerId !== swipe.id) return;
      if (drag && drag.active) { swipe = null; return; }
      const dx = ev.clientX - swipe.x;
      const dy = ev.clientY - swipe.y;
      if (!swipe.locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // a scroll
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        swipe.locked = true;
        swipe.x = ev.clientX - Math.sign(dx) * 10; // no jump at the lock
        swipe.stage.classList.add("is-tracking");
        swipe.prev = peek(-1);
        swipe.next = peek(1);
      }
      const t = Date.now();
      const v = (ev.clientX - swipe.lastX) / Math.max(1, t - swipe.lastT);
      swipe.v = v * 0.7 + swipe.v * 0.3;
      swipe.lastX = ev.clientX;
      swipe.lastT = t;
      follow(ev.clientX - swipe.x);
    }, { passive: true });
    window.addEventListener("pointerup", (ev) => {
      if (!swipe || ev.pointerId !== swipe.id) return;
      if (drag && drag.active) { swipe = null; return; }
      const dx = ev.clientX - swipe.x;
      const dy = ev.clientY - swipe.y;
      const v = Date.now() - swipe.lastT > 90 ? 0 : swipe.v; // the finger stopped before lifting: no throw
      const flick = Math.abs(v) > 0.45 && Math.abs(dx) > 30 && Math.sign(v) === Math.sign(dx);
      const far = Math.abs(dx) > swipe.w * 0.28;
      // A quick throw with no moves in between (some browsers, synthetic events) still counts.
      const thrown = !swipe.locked && Date.now() - swipe.t < 700 && Math.abs(dx) >= 60 && Math.abs(dy) <= Math.abs(dx) * 0.6;
      settle((swipe.locked && (far || flick)) || thrown ? (dx < 0 ? 1 : -1) : 0);
    });
    window.addEventListener("pointercancel", (ev) => {
      if (swipe && ev.pointerId === swipe.id) settle(0);
    });
  }

  /* Hour height: pinch on touch, Ctrl + wheel (or a trackpad pinch) on desktop. The minute under the
     fingers stays under the fingers. */
  function setZoom(z) {
    state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const root = document.getElementById("hq-cal-app");
    if (!root) return;
    root.style.setProperty("--hq-zoom", state.zoom.toFixed(3));
    root.classList.toggle("is-zoomed", state.zoom >= 1.5);
  }

  function saveZoom() {
    try { localStorage.setItem("hq_cal_zoom", state.zoom.toFixed(2)); } catch (_) {}
  }

  function zoomAround(scroll, z, clientY) {
    const grid = scroll.querySelector(".hq-cal-day, .hq-cal-weekgrid");
    if (!grid) return setZoom(z);
    const ratioFrom = state.zoom;
    const inner = scroll.scrollHeight > scroll.clientHeight + 1;
    const gr = grid.getBoundingClientRect();
    const y = clientY - gr.top; // hours-space position of the focus, in px
    setZoom(z);
    const shift = y * (state.zoom / ratioFrom) - y;
    if (inner) scroll.scrollTop += shift;
    else window.scrollBy(0, shift);
  }

  function bindPinch(root) {
    const touches = new Map();
    let pinch = null;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return { d: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)), y: (a.y + b.y) / 2 };
    };
    root.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch") return;
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touches.size !== 2 || (state.view !== "day" && state.view !== "week")) return;
      const scroll = root.querySelector(".hq-cal-stage .hq-cal-scroll");
      if (!scroll) return;
      if (drag && !drag.active) dragEnd(false);
      const s0 = spread();
      pinch = { scroll, d: s0.d };
    }, { passive: true });
    window.addEventListener("pointermove", (ev) => {
      if (!touches.has(ev.pointerId)) return;
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (!pinch || touches.size !== 2) return;
      const now = spread();
      zoomAround(pinch.scroll, state.zoom * (now.d / pinch.d), now.y);
      pinch.d = now.d;
    }, { passive: true });
    const lift = (ev) => {
      if (!touches.delete(ev.pointerId) || !pinch || touches.size >= 2) return;
      pinch = null; // no click guard: a two-finger pinch never ends in a click, and a guard would eat the next real tap
      saveZoom();
      buzz(6);
      if (coarsePointer()) renderKeep(); // touch hit areas are sized from the hour height
    };
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
    // iOS: keep its page zoom out of a pinch on the hours.
    root.addEventListener("gesturestart", (ev) => {
      if (ev.target.closest && ev.target.closest(".hq-cal-scroll")) ev.preventDefault();
    });
    let saveSoon = null;
    root.addEventListener("wheel", (ev) => {
      if (!ev.ctrlKey || (state.view !== "day" && state.view !== "week")) return;
      const scroll = ev.target.closest(".hq-cal-scroll");
      if (!scroll) return;
      ev.preventDefault();
      zoomAround(scroll, state.zoom * Math.exp(-ev.deltaY * 0.01), ev.clientY);
      clearTimeout(saveSoon);
      saveSoon = setTimeout(saveZoom, 300);
    }, { passive: false });
  }

  /* Agenda (touch): swipe a row left to delete it. It slides away, the list closes up, Annuler is there. */
  function bindRowSwipe(root) {
    let r = null;
    root.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch") return;
      const row = ev.target.closest(".hq-cal-row[data-id]:not(.is-schedule)");
      r = row ? { row, id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), locked: false, dx: 0 } : null;
    }, { passive: true });
    window.addEventListener("pointermove", (ev) => {
      if (!r || ev.pointerId !== r.id) return;
      const dx = ev.clientX - r.x;
      const dy = ev.clientY - r.y;
      if (!r.locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { r = null; return; }
        if (dx > -10 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        r.locked = true;
        r.row.classList.add("is-swiping");
      }
      r.dx = Math.min(0, dx);
      const w = r.row.offsetWidth;
      r.row.style.transform = "translateX(" + r.dx + "px)";
      r.row.style.setProperty("--reveal", Math.min(1, -r.dx / (w * 0.35)).toFixed(2));
      const armed = -r.dx > w * 0.35;
      if (armed !== r.row.classList.contains("is-armed")) {
        r.row.classList.toggle("is-armed", armed);
        if (armed) buzz(6);
      }
    }, { passive: true });
    const end = (ev, ok) => {
      if (!r || ev.pointerId !== r.id) return;
      const g = r;
      r = null;
      if (!g.locked) return;
      suppressClick();
      const row = g.row;
      row.classList.remove("is-swiping");
      const item = findItem(row.dataset.id);
      const fast = -g.dx > 60 && Date.now() - g.t < 260;
      if (!(ok && item && (-g.dx > row.offsetWidth * 0.35 || fast))) {
        row.style.transform = "";
        row.style.removeProperty("--reveal");
        row.classList.remove("is-armed");
        return;
      }
      chime("delete");
      buzz(12);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return removeEvent(item, true);
      row.classList.add("is-leaving");
      row.style.transform = "translateX(-115%)";
      setTimeout(() => {
        row.style.height = row.offsetHeight + "px";
        void row.offsetHeight;
        row.classList.add("is-collapsing");
        row.style.height = "0px";
      }, 170);
      setTimeout(() => removeEvent(item, true), 360);
    };
    window.addEventListener("pointerup", (ev) => end(ev, true));
    window.addEventListener("pointercancel", (ev) => end(ev, false));
  }

  /* The pointerup of a swipe must not also count as a tap on the slot or event under the finger. */
  function suppressClick() {
    const stop = (e) => {
      if (e.target && e.target.closest && e.target.closest(".hq-cal-haptic")) return; // the iPhone tap, not a tap
      e.stopPropagation();
      e.preventDefault();
      document.removeEventListener("click", stop, true);
    };
    document.addEventListener("click", stop, true);
    setTimeout(() => document.removeEventListener("click", stop, true), 400);
  }

  function closeSheets() {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ["hq-cal-detail", "hq-cal-editor"].forEach((id) => {
      const node = document.getElementById(id);
      if (!node || node.hidden) return;
      const finish = () => {
        node.hidden = true;
        node.textContent = "";
        node.classList.remove("is-closing");
      };
      if (calm) return finish();
      node.classList.add("is-closing"); // shrink away, then hide (reopening cancels this)
      node.closeTimer = setTimeout(finish, 170);
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
      if (canCheck(item, liveNow())) {
        card.appendChild(h("button", { type: "button", class: "secondary hq-cal-donebtn", "data-sheet": "done", "data-id": item.id,
          "aria-pressed": item.done ? "true" : "false", text: item.done ? "Fait ✓ — annuler" : "Marquer comme fait" }));
      }
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
    present(card);
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
    else if (kind === "done") {
      closeSheets();
      toggleDone(item);
    }
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

  /* No "are you sure?": it goes at once, and Annuler brings it back for five seconds. */
  async function removeEvent(item, quiet) {
    const restore = eventPayload(item);
    delete restore.id;
    try {
      await deleteCall(item.id, item.rev);
      closeSheets();
      if (!quiet) {
        chime("delete");
        buzz(10);
      }
      offerUndo("Supprimé · " + (item.title || "Sans titre"), async () => {
        const back = await saveCall(restore, 0);
        landOn(back && back.event);
      });
      refresh("keep");
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Suppression impossible", "err");
      refresh("keep");
    }
  }

  /* The editor shows what most events need (title, when, category, place); notes, scene, action,
     device and reminders wait under "Plus d'options". Duration chips set the end in one tap. */
  function openEditor(item) {
    const original = Object.assign({}, item); // what Annuler goes back to
    const root = sheet("hq-cal-editor");
    const card = h("form", { class: "hq-sheet-card hq-cal-editor", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-editor-title" });
    card.appendChild(h("h3", { id: "hq-cal-editor-title", text: item.id ? "Modifier" : "Nouvel événement" }));
    card.appendChild(h("input", { id: "hq-cal-title", class: "hq-cal-title-input", name: "title", maxlength: "120", required: "required",
      placeholder: "Titre", "aria-label": "Titre", autocomplete: "off", value: item.title || "" }));
    const allDay = h("input", { id: "cal-all-day", type: "checkbox" });
    allDay.checked = !!item.all_day;
    const start = h("input", { id: "cal-start", required: "required", "aria-label": "Début" });
    const end = h("input", { id: "cal-end", required: "required", "aria-label": "Fin" });
    const durations = h("div", { class: "hq-cal-durations", role: "group", "aria-label": "Durée" });
    [[30, "30 min"], [60, "1 h"], [90, "1 h 30"], [120, "2 h"]].forEach(([mins, label]) => {
      durations.appendChild(h("button", { type: "button", class: "hq-cal-chipbtn", "data-mins": String(mins), text: label }));
    });
    function markDuration() {
      const a = parseLocalDateTime(start.value);
      const b = parseLocalDateTime(end.value);
      const mins = a && b ? Math.round((b - a) / 60000) : -1;
      durations.querySelectorAll("button").forEach((btn) => btn.setAttribute("aria-pressed", Number(btn.dataset.mins) === mins ? "true" : "false"));
      durations.hidden = allDay.checked;
    }
    function syncTypes() {
      const day = allDay.checked;
      start.type = day ? "date" : "datetime-local";
      end.type = day ? "date" : "datetime-local";
      start.value = day ? String(item.start || "").slice(0, 10) : toLocalInput(item.start, false);
      end.value = day ? String(item.end || "").slice(0, 10) : toLocalInput(item.end, false);
      markDuration();
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
    start.addEventListener("change", () => {
      // Moving the start keeps the duration, like every calendar does.
      const a = parseLocalDateTime(toLocalInput(item.start, false));
      const b = parseLocalDateTime(toLocalInput(item.end, false));
      const next = parseLocalDateTime(start.value);
      if (!allDay.checked && a && b && next) {
        end.value = toLocalInput(minuteKey(new Date(next.getTime() + (b - a))), false);
        item.start = minuteKey(next);
        item.end = minuteKey(new Date(next.getTime() + (b - a)));
      }
      markDuration();
    });
    end.addEventListener("change", markDuration);
    durations.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-mins]");
      const a = parseLocalDateTime(start.value);
      if (!btn || !a) return;
      end.value = toLocalInput(minuteKey(new Date(a.getTime() + Number(btn.dataset.mins) * 60000)), false);
      markDuration();
    });
    syncTypes();
    const when = h("div", { class: "hq-cal-when" });
    when.appendChild(field("Début", start));
    when.appendChild(field("Fin", end));
    card.appendChild(when);
    card.appendChild(durations);
    const allWrap = h("label", { class: "hq-cal-switch" });
    allWrap.appendChild(allDay);
    allWrap.appendChild(h("span", { text: "Toute la journée" }));
    card.appendChild(allWrap);
    const category = h("input", { id: "cal-category", type: "hidden", value: item.category || "other" });
    const cats = h("div", { class: "hq-cal-cats", role: "radiogroup", "aria-label": "Catégorie" });
    CATS.forEach(([id, label]) => {
      cats.appendChild(h("button", { type: "button", role: "radio", class: "hq-cal-catbtn cat-" + id, "data-cat": id,
        "aria-checked": (item.category || "other") === id ? "true" : "false", text: label }));
    });
    cats.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-cat]");
      if (!btn) return;
      category.value = btn.dataset.cat;
      cats.querySelectorAll("[data-cat]").forEach((b) => b.setAttribute("aria-checked", b === btn ? "true" : "false"));
    });
    card.appendChild(cats);
    card.appendChild(category);
    card.appendChild(field("Lieu", h("input", { id: "cal-location", maxlength: "200", value: item.location || "" })));
    const more = h("details", { class: "hq-cal-moreopts" });
    if (item.notes || item.scene_id || item.action_id || item.device_id || (item.reminders_min || []).length) more.open = true;
    more.appendChild(h("summary", { text: "Plus d'options" }));
    more.appendChild(field("Notes", h("textarea", { id: "cal-notes", maxlength: "4000", text: item.notes || "" })));
    more.appendChild(reminderField(item.reminders_min || []));
    more.appendChild(selectField("Scène", "cal-scene", ((state.data || {}).catalog || {}).scenes, item.scene_id));
    more.appendChild(selectField("Action", "cal-action", ((state.data || {}).catalog || {}).actions, item.action_id));
    more.appendChild(selectField("Appareil (navigation)", "cal-device", ((state.data || {}).catalog || {}).devices, item.device_id));
    more.appendChild(h("p", { class: "hint", text: "Journée entière : la date de fin est exclue (le lendemain pour un seul jour)." }));
    card.appendChild(more);
    const row = h("div", { class: "hq-cal-sheet-actions" });
    row.appendChild(h("button", { type: "submit", text: "Enregistrer" }));
    row.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "close", text: "Fermer" }));
    card.appendChild(row);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-sheet='close']")) closeSheets();
    });
    card.addEventListener("submit", (ev) => {
      ev.preventDefault();
      saveEditor(item, { allDay, start, end, category, original });
    });
    root.appendChild(card);
    present(card);
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
      done: !!item.done,
    };
    if (item.id) payload.id = item.id;
    if (!payload.title.trim()) {
      if (typeof toast === "function") toast("Titre requis", "err");
      return;
    }
    try {
      const saved = await busy("Enregistrement…", () => api("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", expected_rev: item.id ? item.rev : 0, event: payload }),
      }));
      closeSheets();
      buzz(10);
      chime("save");
      const ev = saved && saved.event;
      const original = refs.original || {};
      if (ev) {
        offerUndo((original.id ? "Modifié · " : "Ajouté · ") + ev.title, async () => {
          if (original.id) {
            const back = await saveCall(eventPayload(original), ev.rev);
            state.landed = back && back.event ? back.event.id : "";
          } else {
            await deleteCall(ev.id, ev.rev);
          }
          refresh("keep");
        });
      }
      landOn(ev);
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
    try {
      state.zoom = Number(localStorage.getItem("hq_cal_zoom")) || 1;
      state.sound = localStorage.getItem("hq_cal_sound") === "1";
    } catch (_) {}
    setZoom(state.zoom);
    state.anchor = todayLocal();
    root.addEventListener("click", onClick);
    mountQuick(root);
    bindDrag(root);
    bindSwipe(root);
    bindPinch(root);
    bindRowSwipe(root);
    setInterval(() => {
      if (document.hidden || !document.body || document.body.dataset.view !== "calendrier") return;
      paintLive();
    }, 20000);
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
