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
  let categoryRows = CATS;
  /* Shown in the guide (desktop only): every key listed here is handled by navKey below. */
  const KEY_ROWS = [
    ["←  →", "Jour ou période précédente / suivante"],
    ["↑  ↓", "Heure ou ligne précédente / suivante"],
    ["Page ↑ ↓", "Période précédente / suivante"],
    ["Entrée", "Ouvrir le jour ou l’événement"],
    ["E", "Parcourir les événements (Maj : arrière)"],
    ["Échap", "Fermer, ou revenir au titre"],
    ["T", "Aujourd’hui"],
    ["N", "Nouvel événement"],
    ["F", "Rechercher"],
    ["G", "Aller à une date"],
    ["1 – 4", "Jour, semaine, mois, agenda"],
    ["Ctrl + Entrée", "Enregistrer depuis l’éditeur"],
    ["Ctrl + Z", "Annuler la dernière modification"],
    ["H", "Ce guide"],
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
    optionsOpen: false,
    categories: new Set(),
    slotPreview: null,
    selectedEvent: "",
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
  const UNDO_MS = 12000;
  const UNDO_LIMIT = 5;
  const undoHistory = [];
  let undoBusy = false;
  const pendingMoves = new Map();
  const dropEffects = new Map();
  const DROP_GLIDE_MS = 600;   // a slow engine may take a few hundred ms to redraw the dropped event
  const DROP_EFFECT_MS = 780;   // how long the drop glow itself plays
  const DROP_MEMORY_MS = 2400;  // a confirming refresh this soon still belongs to the same drop
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
  let lastWhen = { id: "", text: "" }; // the countdown, so a tick can roll its number
  let morphFrom = "";        // id of the event the open detail sheet grew out of
  let sheetSeq = 0;          // bumped by every close: a morph still on its way does not reopen a closed sheet
  let peekOpen = null;       // the long-press day preview
  let pendingGridFocus = null; // an hour cell to focus once the period it lives in has been drawn
  const gridCursor = new Map(); // dayKey -> hour: the one tab stop each timeline column keeps
  const pressed = new Set(); // pointers held on the calendar: a rebuild under them would eat the click
  let pressAt = 0;           // when the oldest of them went down, so a lost pointerup cannot stall the app
  let pressFlush = 0;        // the render deferred until the last finger or mouse button lifts
  let scrubbing = false;     // the day strip is being slid: that drag draws under the finger, on purpose
  let lastSignature = "";    // what the stage was drawn from: an identical refresh touches nothing
  const MAGNET = 8;          // minutes: a dragged edge clicks onto a neighbour's edge or the now line
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 2.4;
  const VIEW_ORDER = ["day", "week", "month", "agenda"];
  const CALENDAR_SHEETS = ["hq-cal-detail", "hq-cal-editor", "hq-cal-date-jump", "hq-cal-search", "hq-cal-free-slots", "hq-cal-transfer", "hq-cal-history", "hq-cal-gestures", "hq-cal-categories", "hq-cal-category-manager"];

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

  function categoryKey(item) {
    const key = item.read_only ? (state.data?.schedule_category || "hq") : item.category;
    return categoryRows.some(([id]) => id === key) ? key : "other";
  }

  function catClass(item) {
    return "cat-" + categoryKey(item) + (item.read_only ? " is-schedule" : "");
  }

  function syncCategoryCatalog() {
    categoryRows = state.data?.categories?.map(({ id, label, color }) => [id, label, color]) || CATS;
    const selected = validCategories([...state.categories]);
    if (selected.size !== state.categories.size) {
      state.categories = selected;
      try { localStorage.setItem("hq_cal_categories", JSON.stringify([...selected])); } catch (_) {}
    }
    let style = document.getElementById("hq-cal-category-colors");
    if (!style) {
      style = h("style", { id: "hq-cal-category-colors" });
      document.head.appendChild(style);
    }
    const rules = categoryRows.filter(([, , color]) => /^#[a-f0-9]{6}$/i.test(color || ""))
      .map(([key, , color]) => ":where(.hq-cal,.hq-sheet,.hq-cal-peekday) .cat-" + CSS.escape(key) + "{--cat:" + color + "}").join("\n");
    if (style.textContent !== rules) style.textContent = rules;
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

  function matchesCategory(item) {
    return !state.categories.size || state.categories.has(categoryKey(item));
  }

  function visibleItems() {
    return items().filter(matchesCategory);
  }

  function findItem(id) {
    const all = items().concat((state.data && state.data.conditional) || []);
    return all.find((item) => item.id === id) || null;
  }

  /* A projected occurrence is read as a normal event, but writes always target the
     one stored series record. */
  function seriesRecord(item) {
    if (!item || !item.series_id) return item;
    const record = Object.assign({}, item, {
      id: item.series_id,
      start: item.series_start || item.start,
      end: item.series_end || item.end,
    });
    delete record.series_id;
    delete record.series_start;
    delete record.series_end;
    return record;
  }

  function isRecurring(item) {
    return !!(item && (item.series_id || item.recurrence));
  }

  function recurrenceLabel(recurrence) {
    if (!recurrence) return "";
    let label = WHEN[recurrence.frequency] || "Récurrent";
    if (recurrence.frequency === "weekly" && (recurrence.weekdays || []).length) {
      label += " · " + recurrence.weekdays.map((day) => DOW[day]).join(", ");
    }
    if (recurrence.count) label += " · " + recurrence.count + " occurrences";
    else if (recurrence.until) {
      const until = parseLocalDateKey(recurrence.until);
      label += " · jusqu’au " + (until ? fmtDay(until) : recurrence.until);
    } else label += " · sans fin";
    return label;
  }

  function occurrenceIdFor(event, startHint) {
    if (!event || !event.id || !event.recurrence) return event && event.id;
    const raw = String(startHint || event.start || "");
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return event.id;
    const day = raw.slice(0, 10);
    const time = String(event.start || "").slice(11, 16) || raw.slice(11, 16);
    const suffix = event.all_day ? day.replace(/-/g, "") : day.replace(/-/g, "") + "T" + time.replace(":", "");
    return event.id + "@" + suffix;
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
  /* The last input was the keyboard. A period change made that way hands the cursor to the new
     period's grid instead of leaving focus on the document. */
  let keyboardIntent = false;
  /* The last hour a grid cell held: a keyboard switch made after a refresh dropped focus still lands there. */
  let lastGridHour = 9;
  /* The hour the cursor had when the date jump was opened: a keyboard jump carries it. */
  let dateJumpHour = null;

  function dayScroll() {
    const node = document.querySelector("#hq-cal-app .hq-cal-scroll");
    return node || null;
  }

  function positionTimeline(mode, smooth = false) {
    const scroll = dayScroll();
    if (!scroll || (state.view !== "day" && state.view !== "week")) return;
    const minutes = date => date.getHours() * 60 + date.getMinutes();
    const now = liveNow();
    const events = visibleItems().filter(item => !item.all_day && itemStart(item) && itemEnd(item));
    const starts = events.map(itemStart).filter(day => state.view === "day" ? sameDay(day, state.anchor) : dayVisible(day));
    const first = starts.length ? Math.min(...starts.map(minutes)) : 8 * 60;
    const current = now && showsToday();
    const showNow = current && (mode === "snap" || (minutes(now) >= 7 * 60 && minutes(now) <= 20 * 60));
    const target = showNow ? minutes(now) : first;
    const slot = scroll.querySelector(".hq-cal-slot");
    if (slot) scroll.scrollTo({
      top: Math.max(0, (target - 60) / 60 * slot.getBoundingClientRect().height),
      behavior: smooth ? "smooth" : "instant",
    });
  }

  function revealTimelineEvent(id) {
    const scroll = dayScroll();
    const event = timelineEvent(scroll, id);
    if (!event) return;
    if (document.body.dataset.view === "calendrier" && document.activeElement === document.body
      && !document.querySelector(".hq-sheet:not([hidden]):not(.is-closing)")) {
      event.focus({ preventScroll: true });
    }
    revealTimelineNode(scroll, event);
  }

  function timelineEvent(scroll, id) {
    return scroll?.querySelector(".hq-cal-event[data-id='" + CSS.escape(id) + "']");
  }

  function revealTimelineNode(scroll, node, align = false) {
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const header = scroll.querySelector(".hq-cal-week-top")?.offsetHeight || 0;
    const rect = node.getBoundingClientRect();
    const top = bounds.top + header + 12;
    const bottom = bounds.bottom - 12;
    if (!align && rect.top >= top && rect.top < bottom && rect.bottom <= bottom) return;
    scroll.scrollTo({
      top: scroll.scrollTop + rect.top - top - Math.min(36, (bottom - top) / 4),
      behavior: calm() ? "auto" : "smooth",
    });
  }

  function paintEventSelection(root) {
    for (const button of root.querySelectorAll('[data-cal="open"][data-id]')) {
      button.classList.toggle("is-selected", button.dataset.id === state.selectedEvent);
    }
  }

  function selectEvent(id) {
    state.selectedEvent = id;
    const stage = document.querySelector(".hq-cal-stage");
    if (stage) paintEventSelection(stage);
  }

  async function jumpToNextEvent(id, dayKey) {
    const item = findItem(id) || state.data?.next;
    const now = liveNow();
    const inProgress = item?.id === id && now && itemStart(item) <= now && itemEnd(item) > now;
    const day = inProgress ? parseLocalDateKey(dateKey(now)) : parseLocalDateKey(dayKey);
    if (!day) return;
    selectEvent(id);
    if (state.view !== "day" || !sameDay(day, state.anchor)) {
      state.view = "day";
      await goToDate(day);
    }
    if (state.selectedEvent !== id || state.view !== "day" || !sameDay(state.anchor, day)
      || document.body.dataset.view !== "calendrier") return;
    const scroll = dayScroll();
    const event = timelineEvent(scroll, id);
    if (!event) return;
    revealTimelineNode(scroll, event, true);
    if (scroll.getBoundingClientRect().top + 150 > window.innerHeight) {
      scroll.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" });
    }
    event.focus({ preventScroll: true });
  }

  async function refresh(mode, staged) {
    const root = document.getElementById("hq-cal-app");
    if (!root || typeof api !== "function") return;
    root.dataset.busy = "1"; // the app is waiting on HQ: the suites wait on this, never on a clock
    const gen = ++refreshGen;
    const samePeriod = state.prevView === state.view && sameDay(state.prevAnchor, state.anchor);
    const previous = mode === "keep" || (!mode && samePeriod) ? dayScroll() : null;
    const kept = previous ? previous.scrollTop : null;
    const requested = { anchor: state.anchor, view: state.view };
    const range = rangeFor();
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (state.activity && state.view !== "month") params.set("include_activity", "1");
    try {
      const data = await api("/api/calendar?" + params.toString());
      if (gen !== refreshGen) return;
      for (const item of data.items || []) {
        const pending = pendingMoves.get(item.id);
        if (pending && item.rev <= pending.rev) {
          item.start = pending.start;
          item.end = pending.end;
        }
      }
      state.data = data;
      if (!data.malformed) syncCategoryCatalog();
      state.fetchedAt = Date.now();
      if (!state.synced && data.server_date && !state.userMoved) {
        state.synced = true;
        const serverDay = parseLocalDateKey(data.server_date);
        if (serverDay && !sameDay(serverDay, state.anchor)) {
          state.anchor = serverDay;
          return refresh(mode);
        }
      }
      // A refresh that brings back exactly what is already on screen is a no-op: nothing under the
      // pointer or the keyboard is replaced, the live bits are repainted, and the clock is re-based.
      const signature = dataSignature(data);
      if ((mode === "keep" || mode === "start") && signature === lastSignature
        && root.querySelector(".hq-cal-stage")) {
        state.landed = "";
        settle(root);
        paintTz();
        paintLive();
        markIdle(root);
        return;
      }
      lastSignature = signature;
      const landed = state.landed;
      render(!!staged && !root.querySelector(".hq-cal-stage"), () => {
        if (kept != null) {
          const next = dayScroll();
          if (next) next.scrollTop = kept;
        } else positionTimeline(mode);
        if (landed) revealTimelineEvent(landed);
      });
    } catch (err) {
      if (gen !== refreshGen) return;
      markIdle(root);
      root.querySelector(".hq-cal-load-error")?.remove();
      const retry = h("button", { type: "button", class: "secondary", text: "Réessayer" });
      retry.addEventListener("click", () => {
        Object.assign(state, requested);
        refresh(mode, staged);
      });
      if (!state.data) root.textContent = "";
      else if (state.prevAnchor && state.prevView) {
        state.anchor = state.prevAnchor;
        state.view = state.prevView;
        state.anim = "";
      }
      root.prepend(h("div", { class: "hq-cal-load-error", role: "status" }, [
        h("span", { text: (err && err.message) || "Calendrier indisponible" }), retry,
      ]));
    }
  }

  /* ---- the next thing: a card with a countdown ring ---- */
  function nextUpItem() {
    const now = liveNow();
    if (!now) return null;
    const list = visibleItems().filter((item) => !item.read_only && !item.all_day && itemStart(item) && itemEnd(item) && itemEnd(item) > now);
    const far = state.data && state.data.next;
    if (far && matchesCategory(far) && !list.some((item) => item.id === far.id) && parseLocalDateTime(far.start) && parseLocalDateTime(far.end) > now) list.push(far);
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
      h("span", { class: "hq-cal-nextup-meta" }, [
        h("time", { class: "hq-cal-nextup-start", datetime: item.start, text: fmtTime(itemStart(item)) }),
        h("span", { class: "hq-cal-nextup-when" }),
      ]),
      h("span", { class: "hq-cal-nextup-arrow", "aria-hidden": "true", text: "›" }),
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
    const whenEl = card.querySelector(".hq-cal-nextup-when");
    // Phones spend one short word on the countdown: « reste » instead of « encore ».
    const short = live && window.matchMedia("(max-width:600px)").matches ? when.replace(/^encore\s+/, "reste ") : when;
    if (whenEl.dataset.text !== short) {
      rollWords(whenEl, short, lastWhen.id === item.id ? lastWhen.text : "", -1);
      whenEl.dataset.text = short;
    }
    lastWhen = { id: item.id, text: short };
    card.setAttribute("aria-label", "Voir sur la grille · " + label + " · " + (item.title || "Sans titre") +
      " · " + fmtDay(a) + " à " + fmtTime(a) + " · " + when);
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

  /* ---- end of day: how it went, and a little party when everything finished got done ---- */
  function todayStats() {
    const now = liveNow();
    const today = serverToday();
    if (!now) return null;
    const mine = items().filter((item) => !item.read_only && !item.all_day && !isRecurring(item)
      && itemStart(item) && itemEnd(item) && sameDay(itemStart(item), today));
    const ended = mine.filter((item) => itemEnd(item) <= now);
    return { now, ended, remaining: mine.length - ended.length, done: ended.filter((item) => item.done).length };
  }

  function recapCard() {
    if (state.categories.size || nextUpItem()) return document.createTextNode(""); // one status line at a time
    const today = serverToday();
    const onScreen = (state.view === "day" && sameDay(state.anchor, today)) || (state.view === "week" && dayVisible(today));
    const stats = onScreen ? todayStats() : null;
    if (!stats || !stats.ended.length || (stats.now.getHours() < 18 && stats.remaining)) return document.createTextNode("");
    const all = stats.done === stats.ended.length;
    const run = (state.data && state.data.streak && state.data.streak.days) || 0;
    const card = h("div", { class: "hq-cal-recap" + (all ? " is-complete" : ""), role: "status" }, [
      h("span", { class: "hq-cal-recap-mark", "aria-hidden": "true", text: all ? "✓" : String(stats.done) }),
      h("span", { class: "hq-cal-recap-text" }, [
        h("strong", { text: all ? "Journée bouclée" : "Ce soir" }),
        h("span", { text: stats.done + " sur " + stats.ended.length + " fait" + (stats.done > 1 ? "s" : "") + (run >= 2 ? " · 🔥 " + run + " jours d'affilée" : "") }),
      ]),
    ]);
    return card;
  }

  function maybeCelebrate() {
    const card = document.querySelector("#hq-cal-app .hq-cal-recap.is-complete");
    if (!card) return;
    const key = dateKey(serverToday());
    let seen = key;
    try { seen = localStorage.getItem("hq_cal_cheer"); } catch (_) {}
    if (seen === key) return; // once a day
    try { localStorage.setItem("hq_cal_cheer", key); } catch (_) {}
    card.classList.add("is-cheer");
    confetti(card);
    chime("fanfare");
    buzz(24);
  }

  function confetti(from) {
    if (calm()) return;
    const canvas = h("canvas", { class: "hq-cal-confetti", "aria-hidden": "true" });
    document.body.appendChild(canvas);
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas.remove();
    ctx.scale(dpr, dpr);
    const r = from.getBoundingClientRect();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2bb673";
    const colors = ["#7aa2ff", "#3dbe7a", "#e6b450", "#e85d4c", accent];
    const parts = Array.from({ length: 110 }, () => ({
      x: r.left + r.width * (0.3 + Math.random() * 0.4), y: r.top + r.height / 2,
      vx: (Math.random() - 0.5) * 10, vy: -4 - Math.random() * 9, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.35,
      w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    const frame = (t) => {
      const k = (t - t0) / 1800;
      ctx.clearRect(0, 0, w, hgt);
      parts.forEach((p) => {
        p.vy += 0.3;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.a += p.va;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - k * k);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 2)) + 1);
        ctx.restore();
      });
      if (k < 1) requestAnimationFrame(frame);
      else canvas.remove();
    };
    requestAnimationFrame(frame);
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
    let ended = false;
    root.querySelectorAll(".hq-cal-event.is-live").forEach((el) => {
      const fill = liveFill(el, now);
      el.style.setProperty("--fill", fill.toFixed(4));
      if (fill >= 1) ended = true;
    });
    const card = document.getElementById("hq-cal-nextup");
    const item = nextUpItem();
    if (ended || (card ? card.dataset.id : "") !== (item ? item.id : "")) {
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
    if (item.recurrence) parts.push("Série · " + recurrenceLabel(item.recurrence));
    if (item.read_only) parts.push(item.source === "icloud" ? "iCloud, lecture seule" : "Horaire HQ, lecture seule");
    else {
      const cat = categoryRows.find((row) => row[0] === (item.category || "other"));
      if (cat) parts.push(cat[1]);
    }
    if (item.scene_id || item.action_id) parts.push("Lié");
    return parts.join(" · ");
  }

  /* What a render draws from: view, period, filters and the events themselves. When a refresh
     brings the same signature, the DOM is already right and is not touched at all. */
  function dataSignature(data) {
    if (!data) return "";
    const items = (data.items || []).map((item) => [item.id, item.rev, item.done ? 1 : 0, item.start, item.end,
      item.title, item.category, item.location, item.read_only ? 1 : 0].join("~")).join("|");
    const conditional = (data.conditional || []).map((item) => [item.id, item.rev, item.done ? 1 : 0, item.title].join("~")).join("|");
    const next = data.next ? [data.next.id, data.next.start].join("~") : "";
    const catalog = (data.categories || []).map((row) => [row.id, row.label, row.color].join("~")).join("|");
    return [data.server_date || "", data.schedule_category || "", data.malformed ? 1 : 0,
      (data.streak && data.streak.days) || 0, items, conditional, next, catalog,
      state.view, dateKey(state.anchor || todayLocal()), threeDay() ? 3 : 7,
      [...state.categories].sort().join(","), state.activity && state.view !== "month" ? 1 : 0].join("::");
  }

  function markIdle(root) {
    const node = root || document.getElementById("hq-cal-app");
    if (node) delete node.dataset.busy;
  }

  /* Empty the app for a rebuild, but leave the quick-add form exactly where it is: detaching a
     focused input is how a refresh eats what someone was in the middle of typing. */
  function keepQuick(root) {
    const form = quickForm && quickForm.parentNode === root ? quickForm : null;
    for (const node of [...root.childNodes]) if (node !== form) node.remove();
    return form;
  }

  /* A genuine data change keeps the stage: its slots, its scroll and the node holding focus stay
     put. Only the leaves the data owns are diffed — an event keeps its node, a deleted one leaves. */
  function keepForRebuild(root, stage) {
    const form = quickForm && quickForm.parentNode === root ? quickForm : null;
    const bar = root.querySelector(".hq-cal-bar");
    for (const node of [...root.childNodes]) if (node !== form && node !== stage && node !== bar) node.remove();
    return form;
  }

  function stageViewOf(stage) {
    if (!stage) return "";
    if (stage.querySelector(".hq-cal-day")) return "day";
    if (stage.querySelector(".hq-cal-week")) return "week";
    if (stage.querySelector(".hq-cal-month")) return "month";
    if (stage.querySelector(".hq-cal-agenda")) return "agenda";
    return "";
  }

  function allDayRows(day) {
    return visibleItems().filter((item) => item.all_day && overlapsDay(item, day));
  }

  function weekDays() {
    const start = weekStart(state.anchor);
    return Array.from({ length: weekSpan() }, (_, index) => addLocalDays(start, index));
  }

  function paintChipInPlace(node, item) {
    node.className = "hq-cal-chip " + catClass(item) + landedClass(item) + (isRecurring(item) ? " is-series" : "");
    node.dataset.help = previewHelp(item);
    node.textContent = item.title || "Sans titre";
  }

  /* Chips keep their nodes across a data change; only a gone chip leaves and a new one arrives. */
  function reconcileChips(lane, rows) {
    const existing = new Map([...lane.children]
      .filter((node) => node.classList && node.classList.contains("hq-cal-chip") && node.dataset.id)
      .map((node) => [node.dataset.id, node]));
    const kept = new Set();
    rows.forEach((item) => {
      const node = existing.get(item.id);
      if (node) paintChipInPlace(node, item);
      else lane.appendChild(chip(item));
      kept.add(item.id);
    });
    existing.forEach((node, id) => { if (!kept.has(id)) node.remove(); });
  }

  function reconcileAllCell(cell, rows) {
    reconcileChips(cell, rows.slice(0, 2));
    cell.querySelectorAll(".hq-cal-more").forEach((node) => node.remove());
    if (rows.length > 2) cell.appendChild(allMore(parseLocalDateKey(cell.dataset.allday), rows.length - 2));
  }

  function reconcileTimed(col, day) {
    col.querySelectorAll(".hq-cal-now, .hq-cal-marker").forEach((node) => node.remove());
    placeTimed(col, day, 1, true);
    placeNow(col, day);
    if (state.activity) placeMarkers(col, day);
  }

  function reconcileStrip(stage) {
    const old = stage.querySelector(".hq-cal-weekstrip");
    if (!old) return;
    const active = document.activeElement?.closest?.(".hq-cal-weekstrip button");
    const day = active ? active.dataset.day : "";
    old.replaceWith(weekStrip());
    if (day) stage.querySelector('.hq-cal-weekstrip button[data-day="' + CSS.escape(day) + '"]')?.focus({ preventScroll: true });
  }

  function reconcileTools(stage) {
    const old = stage.querySelector(".hq-cal-timeline-controls");
    if (old) old.replaceWith(timelineTools());
  }

  function reconcileHint(stage, days) {
    const old = stage.querySelector(".hq-cal-hint");
    const next = dayHint(days);
    if (old && next) {
      if (old.outerHTML !== next.outerHTML) old.replaceWith(next);
      return;
    }
    if (old) { old.remove(); return; }
    if (!next) return;
    const before = stage.querySelector(".hq-cal-allday") || stage.querySelector(".hq-cal-scroll");
    if (before && before.parentNode) before.parentNode.insertBefore(next, before);
  }

  function reconcileWeekHead(head, day) {
    const today = sameDay(day, serverToday());
    head.classList.toggle("is-today", today);
    if (today) head.setAttribute("aria-current", "date"); else head.removeAttribute("aria-current");
    head.classList.remove("has-ring", "is-complete");
    head.style.removeProperty("--p");
    head.setAttribute("aria-label", fmtDay(day));
    markRing(head, day);
  }

  function reconcileWeekAllRow(stage, days) {
    const top = stage.querySelector(".hq-cal-week-top");
    if (!top) return;
    const has = days.some((day) => visibleItems().some((item) => item.all_day && overlapsDay(item, day)));
    const old = top.querySelector(".hq-cal-allweek");
    if (has && !old) top.appendChild(allWeekRow(days));
    else if (!has && old) old.remove();
  }

  function reconcileMonth(stage) {
    const wrap = stage.querySelector(".hq-cal-month");
    if (!wrap) return false;
    const today = serverToday();
    const narrow = narrowMonth();
    [...wrap.querySelectorAll(".hq-cal-mcell")].forEach((cell) => {
      const mday = cell.querySelector(".hq-cal-mday");
      const day = mday && parseLocalDateKey(mday.dataset.day);
      if (!day) return;
      const rows = visibleItems().filter((item) => overlapsDay(item, day));
      const isToday = sameDay(day, today);
      cell.classList.toggle("is-today", isToday);
      cell.classList.toggle("is-anchor", sameDay(day, state.anchor));
      if (isToday) mday.setAttribute("aria-current", "date"); else mday.removeAttribute("aria-current");
      mday.setAttribute("aria-label", fmtDay(day) + (rows.length ? " · " + rows.length + (rows.length === 1 ? " élément" : " éléments") : ""));
      cell.querySelectorAll(".hq-cal-dots").forEach((node) => node.remove());
      if (narrow) {
        cell.querySelectorAll(".hq-cal-chip, .hq-cal-more").forEach((node) => node.remove());
        if (rows.length) {
          const dots = h("span", { class: "hq-cal-dots", "aria-hidden": "true" });
          const shown = rows.length > 3 ? 2 : rows.length;
          rows.slice(0, shown).forEach((item) => dots.appendChild(h("span", { class: "hq-cal-dot " + catClass(item) + landedClass(item) })));
          if (rows.length > shown) dots.appendChild(h("span", { class: "hq-cal-dot-more", text: "+" + (rows.length - shown) }));
          cell.appendChild(dots);
        }
        return;
      }
      const limit = monthChipLimit();
      reconcileChips(cell, rows.slice(0, limit));
      cell.querySelectorAll(".hq-cal-more").forEach((node) => node.remove());
      if (rows.length > limit) {
        const extra = rows.length - limit;
        cell.appendChild(h("button", { type: "button", class: "hq-cal-more", "data-cal": "pick-day", "data-day": dateKey(day),
          "aria-label": extra === 1 ? "1 autre" : extra + " autres", text: "+" + extra }));
      }
    });
    return true;
  }

  function adoptAgendaRows(next, old) {
    const keyOf = (node) => node.classList && node.classList.contains("hq-cal-row") && node.dataset.id
      ? (node.dataset.day || "") + "|" + node.dataset.id : "";
    const keep = new Map();
    [...old.querySelectorAll(".hq-cal-row[data-id]")].forEach((node) => keep.set(keyOf(node), node));
    [...next.querySelectorAll(".hq-cal-row[data-id]")].forEach((node) => {
      const prev = keep.get(keyOf(node));
      if (prev) node.replaceWith(prev);
    });
  }

  function reconcileAgenda(stage) {
    const wrap = stage.querySelector(".hq-cal-agenda");
    if (!wrap) return false;
    const active = document.activeElement?.closest?.(".hq-cal-agenda .hq-cal-row");
    const key = active ? (active.dataset.day || "") + "|" + active.dataset.id : "";
    const fresh = agendaView();
    adoptAgendaRows(fresh, wrap);
    wrap.replaceChildren(...fresh.childNodes);
    if (key) {
      const [day, id] = key.split("|");
      wrap.querySelector('.hq-cal-row[data-day="' + CSS.escape(day) + '"][data-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
    }
    return true;
  }

  function reconcileStage(stage) {
    if (!stage) return false;
    if (state.view === "day") {
      const key = dateKey(state.anchor);
      const col = stage.querySelector('[data-col-day="' + key + '"]');
      if (!col) return false;
      reconcileTimed(col, state.anchor);
      const lane = stage.querySelector('[data-allday="' + key + '"]');
      if (lane) reconcileChips(lane, allDayRows(state.anchor));
      reconcileHint(stage, [state.anchor]);
      reconcileStrip(stage);
      reconcileTools(stage);
      return true;
    }
    if (state.view === "week") {
      const days = weekDays();
      days.forEach((day) => {
        const key = dateKey(day);
        const col = stage.querySelector('[data-col-day="' + key + '"]');
        if (col) reconcileTimed(col, day);
        const head = stage.querySelector('.hq-cal-weekhead [data-day="' + key + '"]');
        if (head) reconcileWeekHead(head, day);
        const cell = stage.querySelector('.hq-cal-allcell[data-allday="' + key + '"]');
        if (cell) reconcileAllCell(cell, allDayRows(day));
      });
      reconcileWeekAllRow(stage, days);
      reconcileHint(stage, days);
      reconcileTools(stage);
      return true;
    }
    if (state.view === "month") return reconcileMonth(stage);
    if (state.view === "agenda") return reconcileAgenda(stage);
    return false;
  }

  /* A refresh that draws nothing new still ends whatever entrance was playing, rather than
     rebuilding the stage just to drop one class. */
  function settle(root) {
    const stage = root.querySelector(".hq-cal-stage");
    if (stage) stage.classList.remove("is-next", "is-prev", "is-view", "is-zoom", "is-scrub", "is-swipe-next", "is-swipe-prev");
    root.querySelectorAll(".is-moving").forEach((node) => node.classList.remove("is-moving"));
    state.anim = "";
  }

  /* A pointer is up. If a render was asked for while it was held (a tick, a visibility change),
     draw once now — unless a refresh is already on its way, which will draw the fresher state. */
  function releasePress(ev) {
    pressed.delete(ev.pointerId);
    if (!pressed.size) scrubbing = false;
    if (pressed.size) return;
    clearTimeout(pressFlush);
    pressFlush = setTimeout(() => {
      const root = document.getElementById("hq-cal-app");
      if (!renderPending || !root || root.dataset.busy || drag || (swipe && swipe.locked)) return;
      renderKeep();
    }, 0);
  }

  function render(staged, done) {
    const root = document.getElementById("hq-cal-app");
    if (!root) return;
    if (pressed.size && performance.now() - pressAt > 30000) pressed.clear(); // a pointerup lost on the way out
    if (drag || (swipe && swipe.locked) || (pressed.size && !scrubbing)) {
      renderPending = true; // never rebuild the grid under a press, a drag or a swipe
      lastSignature = ""; // the screen still shows older data: the next refresh must draw it
      return;
    }
    renderPending = false;
    if (window.hqHideHelp) window.hqHideHelp();
    for (const [id, effect] of dropEffects) {
      const elapsed = performance.now() - effect.started;
      if (elapsed >= DROP_MEMORY_MS) dropEffects.delete(id);
      else if (effect.painted && elapsed < DROP_GLIDE_MS) {
        const face = dropFace(root, id, effect.day);
        if (face) effect.from = face.getBoundingClientRect();
      }
    }
    // Same view, same period, no slide: whatever moved glides from where it was.
    const before = !state.anim && state.prevView === state.view && sameDay(state.prevAnchor, state.anchor) ? snapshot(root) : null;
    // A genuine data change repaints in place: the stage, its scroll and the cell holding focus stay;
    // only the leaves the data owns are diffed.
    const oldStage = root.querySelector(".hq-cal-stage");
    const inPlace = !!oldStage && !staged && !state.anim
      && state.prevView === state.view && sameDay(state.prevAnchor, state.anchor)
      && stageViewOf(oldStage) === state.view;
    const keptScroll = inPlace ? oldStage.querySelector(".hq-cal-scroll") : null;
    const keptTop = keptScroll ? keptScroll.scrollTop : null;
    const active = document.activeElement;
    const control = active?.closest(".hq-cal-bar [data-cal]");
    const toolbarFocus = control && root.contains(control) ? control : null;
    const timelineFocus = active?.closest(".hq-cal-timeline-controls") ? active : null;
    const gridFocus = captureGridFocus(active, root); // a refresh must not drop the cell you were on
    // A keyboard day/period change: carry the cursor into the new period's grid, at the hour the
    // old cell had or the 09:00 default.
    const switched = !!state.prevView && (state.prevView !== state.view || !sameDay(state.prevAnchor, state.anchor));
    const hourNow = focusedHour();
    if (Number.isInteger(hourNow)) lastGridHour = hourNow;
    const activeInStage = !!(active && oldStage && oldStage.contains(active));
    // Carry the cursor on a keyboard period change. If a refresh already dropped focus to the body,
    // the last grid hour is still the right place: the next key must move inside the new period, not
    // from nowhere. Escape leaves focus on the title (not the body), so it keeps its behavior.
    let switchFocus = null;
    if (switched && keyboardIntent && !pendingGridFocus) {
      if (activeInStage) switchFocus = { hour: Number.isInteger(hourNow) ? hourNow : 9 };
      else if (active === document.body || !active) switchFocus = { hour: lastGridHour };
    }
    // The quick-add field is built once and stays connected through every refresh: a rebuild must
    // not take the sentence (or the caret) out from under the person typing it. The toolbar is the
    // same surface: a background refresh may repaint its state, never replace the bar or a control
    // under a pointer, so a click in flight has nowhere to fall.
    const keptBar = inPlace ? root.querySelector(".hq-cal-bar") : null;
    const form = inPlace ? keepForRebuild(root, oldStage) : keepQuick(root);
    paintTz();
    const bar = keptBar || toolbar();
    if (keptBar) syncToolbar(keptBar);
    else root.insertBefore(bar, form || oldStage); // before the field, so the order is still bar → quick add → grid
    if (!form && quickForm) root.appendChild(quickForm); // a failed first load detached it
    if (toolbarFocus && (!bar.contains(toolbarFocus) || !toolbarFocus.offsetParent)) {
      const replacement = toolbarFocus.closest(".hq-cal-options") ? bar.querySelector(".hq-cal-options-trigger")
        : [...bar.querySelectorAll("[data-cal]")].find(node => node.dataset.cal === toolbarFocus.dataset.cal && node.dataset.view === toolbarFocus.dataset.view);
      (replacement || bar.querySelector(".hq-cal-date-trigger"))?.focus({ preventScroll: true });
    }
    if (state.categories.size) {
      const summary = categorySummary();
      if (inPlace) root.insertBefore(summary, oldStage); else root.appendChild(summary);
    }
    const legend = legendPanel();
    legend.hidden = !state.legend;
    if (inPlace) root.insertBefore(legend, oldStage); else root.appendChild(legend);
    const next = nextUp();
    const glances = state.view === "day" || state.view === "week"; // the status line rides beside the grid tools there
    if (!glances) {
      if (inPlace) root.insertBefore(next, oldStage); else root.appendChild(next);
    }
    const recap = recapCard();
    if (!glances) {
      if (inPlace) root.insertBefore(recap, oldStage); else root.appendChild(recap);
    }
    if (state.data && state.data.malformed) {
      const bad = h("p", { class: "hint", text: "Fichier calendrier illisible — il n'a pas été écrasé." });
      if (inPlace) root.insertBefore(bad, oldStage); else root.appendChild(bad);
    }
    // The status line is rebuilt below: free its old wrapper but keep the tools node it borrowed.
    if (inPlace && glances) {
      const row = oldStage.querySelector(".hq-cal-glance");
      if (row) {
        const controls = row.querySelector(".hq-cal-timeline-controls");
        if (controls) row.replaceWith(controls); else row.remove();
      }
    }
    const finish = () => {
      if (!root.isConnected || (staged && document.body.dataset.view !== "calendrier")) return markIdle(root);
      const stage = inPlace ? oldStage : h("div", { class: "hq-cal-stage" + (state.anim ? " is-" + state.anim : ""),
      role: "region", "aria-label": stageLabel() });
      if (!inPlace) {
        if (state.anim === "zoom" && state.zoomFrom) stage.style.transformOrigin = state.zoomFrom.x + "px " + state.zoomFrom.y + "px";
        if (state.view === "day") stage.appendChild(dayView());
        else if (state.view === "week") {
          const first = weekStart(state.anchor);
          const hint = threeDay() || state.categories.size
            ? dayHint(Array.from({ length: weekSpan() }, (_, index) => addLocalDays(first, index))) : null;
          if (hint) stage.appendChild(hint);
          stage.append(timelineTools(), weekView());
        }
        else if (state.view === "month") stage.appendChild(monthView());
        else stage.appendChild(agendaView());
        root.appendChild(stage);
      } else {
        settle(root);
        reconcileStage(stage);
      }
      if (glances) {
        const controls = stage.querySelector(".hq-cal-timeline-controls");
        const status = next.nodeType === 1 ? next : recap.nodeType === 1 ? recap : null;
        if (controls) {
          const row = h("div", { class: "hq-cal-glance" });
          controls.parentNode.insertBefore(row, controls);
          if (status) row.appendChild(status);
          row.appendChild(controls);
        } else if (status) {
          root.insertBefore(status, stage);
        }
      }
      if (timelineFocus?.dataset.cal) {
        stage.querySelector('.hq-cal-timeline-tools [data-cal="' + timelineFocus.dataset.cal + '"]')?.focus({ preventScroll: true });
      }
      paintEventSelection(stage);
      root.appendChild(conditionalBlock());
      state.anim = "";
      state.prevView = state.view;
      state.prevAnchor = state.anchor;
      state.zoomFrom = null;
      state.landed = "";
      state.burst = "";
      paintPreview();
      paintFreeSlotBands(stage);
      paintRecent();
      paintLive();
      if (before) requestAnimationFrame(() => glide(before)); // after the caller has put the scroll back
      maybeCelebrate();
      if (keptScroll && keptTop != null) keptScroll.scrollTop = keptTop;
      if (done) done();
      if (pendingGridFocus) {
        const pending = pendingGridFocus;
        pendingGridFocus = null;
        moveGridFocus(pending.day, pending.hour);
      } else if (switchFocus) {
        focusSwitchedPeriod(switchFocus.hour);
      } else if (gridFocus) restoreGridFocus(gridFocus);
      // A keyboard-driven rebuild must never strand focus on the body: if the usual captures found
      // nothing (a refresh landed mid-switch), put the cursor back in the timeline at the last hour.
      if (document.activeElement === document.body && keyboardIntent && (state.view === "day" || state.view === "week")) {
        focusSwitchedPeriod(lastGridHour);
      }
      for (const [id, effect] of dropEffects) paintDrop(root, id, effect);
      announcePeriod();
      markIdle(root);
    };
    if (staged) requestAnimationFrame(finish);
    else finish();
  }

  function calm() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ---- glide: elements that moved animate from their old box to the new one (FLIP) ---- */
  const GLIDE = ".hq-cal-stage .hq-cal-event[data-id], .hq-cal-stage .hq-cal-chip[data-id], .hq-cal-stage .hq-cal-row[data-id]";

  function glideKeys(root) {
    const seen = new Map();
    return [...root.querySelectorAll(GLIDE)].map((el) => {
      const n = seen.get(el.dataset.id) || 0; // a multi-day event appears once per day
      seen.set(el.dataset.id, n + 1);
      return [el.dataset.id + "#" + n, el];
    });
  }

  function snapshot(root) {
    if (calm()) return null;
    const map = new Map();
    glideKeys(root).forEach(([key, el]) => map.set(key, el.getBoundingClientRect()));
    return map.size ? map : null;
  }

  function glide(before) {
    const root = document.getElementById("hq-cal-app");
    if (!root || !before) return;
    glideKeys(root).forEach(([key, el]) => {
      const old = before.get(key);
      if (!old || el.classList.contains("is-landed") || dropEffects.has(el.dataset.id) || typeof el.animate !== "function") return;
      const now = el.getBoundingClientRect();
      if (!now.width || !now.height) return;
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      const sx = old.width / now.width;
      const sy = old.height / now.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      el.animate([
        { transformOrigin: "0 0", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" },
        { transformOrigin: "0 0", transform: "none" },
      ], { duration: 360, easing: "cubic-bezier(.2,1.12,.32,1)" });
    });
  }

  function dropFace(root, id, day) {
    const event = root.querySelector('[data-col-day="' + day + '"] .hq-cal-event[data-id="' + CSS.escape(id) + '"]');
    return event?.querySelector(".hq-cal-face") || event;
  }

  function paintDrop(root, id, effect) {
    const face = dropFace(root, id, effect.day);
    if (!face || typeof face.animate !== "function") return;
    const elapsed = performance.now() - effect.started;
    if (elapsed >= DROP_MEMORY_MS) return;
    effect.painted = true;
    const end = face.getBoundingClientRect();
    const from = effect.from;
    if (from && end.width && end.height && elapsed < DROP_GLIDE_MS) {
      const dx = from.left - end.left;
      const dy = from.top - end.top;
      face.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / end.width}, ${from.height / end.height})`, transformOrigin: "top left" },
        { transform: "none", transformOrigin: "top left" },
      ], { duration: DROP_GLIDE_MS - elapsed, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    const color = getComputedStyle(face).getPropertyValue("--cat").trim() || "var(--accent)";
    const glow = `0 0 0 2px color-mix(in srgb, ${color} 48%, transparent)`;
    face.animate([
      { boxShadow: glow, offset: 0 },
      { boxShadow: glow, offset: 0.35 },
      { boxShadow: "0 0 0 5px transparent", offset: 1 },
    ], { duration: DROP_EFFECT_MS, delay: -elapsed, easing: "ease-out" });
  }

  /* ---- rolling words: what changed rolls in, what stayed stays put ---- */
  function rollWords(el, text, before, dir) {
    if (!before || before === text || calm()) {
      el.textContent = text;
      return;
    }
    const a = before.split(" ");
    const b = text.split(" ");
    el.textContent = "";
    b.forEach((word, i) => {
      if (i) el.appendChild(document.createTextNode(" "));
      const old = a.length === b.length ? a[i] : "";
      if (old === word) {
        el.appendChild(document.createTextNode(word));
        return;
      }
      el.appendChild(h("span", { class: "hq-roll " + (dir < 0 ? "is-down" : "is-up"), "data-old": old }, [h("span", { class: "hq-roll-new", text: word })]));
    });
  }

  /* Redraw without losing the grid's scroll position. */
  function renderKeep() {
    const before = dayScroll();
    const top = before ? before.scrollTop : null;
    render(false, () => {
      const after = dayScroll();
      if (after && top != null) after.scrollTop = top;
    });
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
    magnet: [[1250, 0, 0.05, 0.03], [1875, 0.025, 0.07, 0.025]],
    fanfare: [[523.25, 0, 0.2, 0.05], [659.25, 0.1, 0.2, 0.05], [783.99, 0.2, 0.24, 0.05], [1046.5, 0.32, 0.5, 0.05]],
    peek: [[600, 0, 0.08, 0.03], [900, 0.035, 0.1, 0.025]],
    pull: [[480, 0, 0.07, 0.025], [720, 0.04, 0.09, 0.02]],
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
  function landOn(event, focusStart) {
    if (!event || !event.id) return refresh("keep");
    const hint = focusStart || event.start;
    const day = parseLocalDateKey(String(hint || "").slice(0, 10));
    state.landed = occurrenceIdFor(event, hint);
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

  function goToDate(day) {
    state.userMoved = true;
    state.anim = state.anchor && day < state.anchor ? "prev" : "next";
    state.anchor = day;
    return refresh(sameDay(day, serverToday()) ? "snap" : undefined);
  }

  function goToday() {
    return goToDate(serverToday());
  }

  /* Keep the empty state where it can guide someone to the grid. */
  function dayHint(days) {
    const events = visibleItems();
    const empty = days.every((day) => !events.some((item) => overlapsDay(item, day)));
    if (empty) {
      if (state.categories.size) return h("p", { class: "hq-cal-hint", text: "Aucun événement dans les catégories sélectionnées." });
      return h("div", { class: "hq-cal-hint is-empty" }, [
        freeScene(),
        h("div", { class: "hq-cal-free-copy" }, [
          h("p", { class: "hq-cal-free-title", text: days.length > 1 ? "Jours libres" : "Journée libre" }),
          h("p", { class: "hq-cal-free-hint", text: coarsePointer()
            ? "Touche une heure pour ajouter un événement."
            : "Clique sur une heure pour ajouter un événement." }),
        ]),
      ]);
    }
    return null;
  }

  /* A small sky for a free day, at the hour it is now: sun rising, high, setting, or a moon and stars. */
  function freeScene() {
    const now = liveNow() || new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const phase = hour < 6 || hour >= 21 ? "night" : hour < 10 ? "dawn" : hour < 17 ? "day" : "dusk";
    const t = phase === "night" ? ((hour + 3) % 24) / 9 : Math.max(0, Math.min(1, (hour - 6) / 15));
    const scene = h("div", { class: "hq-cal-free is-" + phase, "aria-hidden": "true" });
    scene.style.setProperty("--sx", (10 + t * 80).toFixed(1) + "%");
    scene.style.setProperty("--sy", (80 - Math.sin(t * Math.PI) * 55).toFixed(1) + "%");
    scene.appendChild(h("span", { class: "hq-cal-free-orb" }));
    if (phase === "night") {
      [[12, 22], [26, 58], [38, 18], [55, 40], [68, 14], [82, 52], [91, 26]].forEach(([x, y], i) => {
        const star = h("span", { class: "hq-cal-free-star" });
        star.style.left = x + "%";
        star.style.top = y + "%";
        star.style.setProperty("--d", (i * 0.37).toFixed(2) + "s");
        scene.appendChild(star);
      });
    } else {
      scene.appendChild(h("span", { class: "hq-cal-free-cloud is-a" }));
      scene.appendChild(h("span", { class: "hq-cal-free-cloud is-b" }));
    }
    scene.appendChild(h("span", { class: "hq-cal-free-hill" }));
    return scene;
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
  function todayShortcut() {
    return h("button", { type: "button", class: "secondary hq-cal-today", "data-cal": "today",
      "aria-keyshortcuts": "t", "data-help": "Revient à aujourd'hui.", text: "Aujourd'hui" });
  }

  /* Repaint the stable toolbar in place: only its state changes, never its identity. */
  function syncToolbar(bar) {
    const index = Math.max(0, VIEW_ORDER.indexOf(state.view));
    const from = VIEW_ORDER.indexOf(state.prevView);
    const moving = state.anim === "view" && from >= 0 && from !== index;
    const views = bar.querySelector(".hq-cal-views");
    if (views) {
      views.classList.toggle("is-moving", moving);
      if (views.style.getPropertyValue("--i") !== String(index)) views.style.setProperty("--i", String(index));
      const fromValue = String(moving ? from : index);
      if (views.style.getPropertyValue("--from") !== fromValue) views.style.setProperty("--from", fromValue);
    }
    const labels = new Map(VIEWS.map(([id, label]) => [id, label]));
    for (const button of bar.querySelectorAll(".hq-cal-view")) {
      const id = button.dataset.view;
      const text = id === "week" && threeDay() ? "3 jours" : labels.get(id) || button.textContent;
      if (button.textContent !== text) button.textContent = text;
      const pressed = state.view === id ? "true" : "false";
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    const navCopy = {
      day: ["Jour précédent", "Jour suivant", "Recule d'un jour.", "Avance d'un jour."],
      week: threeDay()
        ? ["Trois jours plus tôt", "Trois jours plus tard", "Recule de trois jours.", "Avance de trois jours."]
        : ["Semaine précédente", "Semaine suivante", "Recule d'une semaine.", "Avance d'une semaine."],
      month: ["Mois précédent", "Mois suivant", "Recule d'un mois.", "Avance d'un mois."],
      agenda: ["Agenda précédent", "Agenda suivant", "Recule de trente jours.", "Avance de trente jours."],
    }[state.view] || ["Période précédente", "Période suivante", "Recule.", "Avance."];
    [["prev", 0], ["next", 1]].forEach(([kind, i]) => {
      const button = bar.querySelector('[data-cal="' + kind + '"]');
      if (!button) return;
      if (button.getAttribute("aria-label") !== navCopy[i]) button.setAttribute("aria-label", navCopy[i]);
      if (button.getAttribute("data-help") !== navCopy[i + 2]) button.setAttribute("data-help", navCopy[i + 2]);
    });
    const period = titleText();
    const anchor = state.anchor || todayLocal();
    const accessible = state.view === "day" ? period + " " + anchor.getFullYear() : period;
    const trigger = bar.querySelector(".hq-cal-date-trigger");
    if (trigger) {
      const label = "Aller à une date · " + accessible;
      if (trigger.getAttribute("aria-label") !== label) trigger.setAttribute("aria-label", label);
      const texts = [period, compactPeriod(anchor)];
      trigger.querySelectorAll(".hq-cal-date-label").forEach((span, i) => {
        if (span.textContent !== texts[i]) span.textContent = texts[i];
      });
    }
    const optionsTrigger = bar.querySelector(".hq-cal-options-trigger");
    if (optionsTrigger) {
      const expanded = String(state.optionsOpen);
      if (optionsTrigger.getAttribute("aria-expanded") !== expanded) optionsTrigger.setAttribute("aria-expanded", expanded);
    }
    const list = bar.querySelector(".hq-cal-option-list");
    if (list && list.hidden !== !state.optionsOpen) list.hidden = !state.optionsOpen;
    const cat = bar.querySelector('[data-cal="categories"]');
    if (cat) {
      const text = state.categories.size ? "Catégories (" + state.categories.size + ")" : "Catégories";
      if (cat.textContent !== text) cat.textContent = text;
    }
    const activity = bar.querySelector('[data-cal="activity"]');
    if (activity) {
      const pressed = state.activity ? "true" : "false";
      if (activity.getAttribute("aria-pressed") !== pressed) activity.setAttribute("aria-pressed", pressed);
    }
    const legend = bar.querySelector('[data-cal="legend"]');
    if (legend) {
      const expanded = state.legend ? "true" : "false";
      if (legend.getAttribute("aria-expanded") !== expanded) legend.setAttribute("aria-expanded", expanded);
    }
    const sound = bar.querySelector('[data-cal="sound"]');
    if (sound) {
      const pressed = state.sound ? "true" : "false";
      if (sound.getAttribute("aria-pressed") !== pressed) sound.setAttribute("aria-pressed", pressed);
    }
    const viewsRow = bar.querySelector(".hq-cal-views-row");
    const today = bar.querySelector(".hq-cal-today");
    if (showsToday()) {
      if (today) today.remove();
    } else if (viewsRow && !today) viewsRow.appendChild(todayShortcut());
  }

  function toolbar() {
    const bar = h("div", { class: "hq-cal-bar", role: "toolbar", "aria-label": "Calendrier : navigation et vues" });
    const index = Math.max(0, VIEW_ORDER.indexOf(state.view));
    const from = VIEW_ORDER.indexOf(state.prevView);
    const moving = state.anim === "view" && from >= 0 && from !== index;
    const views = h("div", {
      class: "hq-cal-views" + (moving ? " is-moving" : ""),
      role: "group",
      "aria-label": "Affichage",
      style: "--i:" + index + ";--from:" + (moving ? from : index),
    });
    VIEWS.forEach(([id, label, help], i) => {
      views.appendChild(
        h("button", {
          type: "button",
          class: "hq-cal-view",
          "data-cal": "view",
          "data-view": id,
          "data-help": help,
          "aria-keyshortcuts": String(i + 1),
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
    const title = h("h3", { class: "hq-cal-title", "aria-live": "polite" });
    const period = titleText();
    const anchor = state.anchor || todayLocal();
    const accessiblePeriod = state.view === "day" ? period + " " + anchor.getFullYear() : period;
    const dateTrigger = h("button", { type: "button", class: "hq-cal-date-trigger", "data-cal": "jump-date",
      "aria-label": "Aller à une date · " + accessiblePeriod, "aria-haspopup": "dialog", "aria-controls": "hq-cal-date-jump",
      "aria-keyshortcuts": "g" });
    dateTrigger.appendChild(h("span", { class: "hq-cal-date-label has-short-date", text: period }));
    dateTrigger.appendChild(h("span", { class: "hq-cal-date-label hq-cal-short-date", text: compactPeriod(anchor), "aria-hidden": "true" }));
    dateTrigger.appendChild(h("span", { class: "hq-cal-date-chevron", "aria-hidden": "true" }));
    title.appendChild(dateTrigger);
    head.appendChild(title);
    head.appendChild(h("button", { type: "button", class: "hq-cal-step", "data-cal": "next", "aria-label": navCopy[1], "data-help": navCopy[3], text: "›" }));
    const top = h("div", { class: "hq-cal-top" });
    top.appendChild(head);
    const actions = h("div", { class: "hq-cal-actions" });
    const options = h("div", { class: "hq-cal-options" });
    const optionList = h("div", { id: "hq-cal-option-list", class: "hq-cal-option-list", hidden: state.optionsOpen ? null : "hidden" });
    options.append(h("button", { type: "button", class: "hq-cal-toggle hq-cal-icon hq-cal-options-trigger", "data-cal": "options",
      "aria-controls": "hq-cal-option-list", "aria-expanded": String(state.optionsOpen), "aria-label": "Options du calendrier",
      "data-help": "Affichage, catégories, légende, sons et historique.", text: "⋯" }), optionList);
    optionList.appendChild(h("button", {
      type: "button", class: "hq-cal-toggle", "data-cal": "categories", "aria-haspopup": "dialog",
      text: state.categories.size ? "Catégories (" + state.categories.size + ")" : "Catégories",
    }));
    if (state.view !== "month") {
      optionList.appendChild(
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
    optionList.appendChild(h("button", {
      type: "button", class: "hq-cal-toggle", "data-cal": "history", "aria-haspopup": "dialog", text: "Historique des modifications",
    }));
    optionList.appendChild(h("button", {
      type: "button", class: "hq-cal-toggle", "data-cal": "gestures", "aria-haspopup": "dialog",
      text: coarsePointer() ? "Gestes" : "Gestes et raccourcis",
    }));
    optionList.appendChild(h("button", {
      type: "button",
      class: "hq-cal-toggle",
      "data-cal": "legend",
      "aria-expanded": state.legend ? "true" : "false",
      "aria-controls": "hq-cal-legend",
      "data-help": "Formes et couleurs des catégories, du planning et de l'activité.",
      text: "Légende",
    }));
    optionList.appendChild(h("button", {
      type: "button",
      class: "hq-cal-toggle",
      "data-cal": "sound",
      "aria-pressed": state.sound ? "true" : "false",
      "data-help": "Petits sons doux : glisser, déposer, enregistrer, cocher.",
      text: "Sons",
    }));
    const search = h("button", { type: "button", class: "hq-cal-toggle hq-cal-icon hq-cal-search-trigger", "data-cal": "search",
      "aria-label": "Rechercher un événement", "aria-keyshortcuts": "f", "aria-haspopup": "dialog" },
      [h("span", { text: "Rechercher" })]);
    actions.append(options, search, h("button", {
      type: "button",
      class: "hq-cal-create",
      "data-cal": "create",
      "aria-label": "Nouvel événement",
      "aria-keyshortcuts": "n",
      "data-help": "Crée un événement manuel dans le calendrier.",
      text: "+ Événement",
    }));
    top.appendChild(actions);
    const viewsRow = h("div", { class: "hq-cal-views-row" });
    viewsRow.appendChild(views);
    if (!showsToday()) viewsRow.appendChild(todayShortcut());
    bar.append(top, viewsRow);
    return bar;
  }

  /* A shorter period for a phone header: same information, fewer characters. */
  function compactPeriod(anchor) {
    if (state.view === "month") {
      const sameYear = anchor.getFullYear() === todayLocal().getFullYear();
      return new Intl.DateTimeFormat("fr-CA", sameYear ? { month: "short" } : { month: "short", year: "numeric" }).format(anchor);
    }
    if (state.view === "week") {
      const first = weekStart(anchor);
      const last = addLocalDays(first, weekSpan() - 1);
      return fmtShort(first) + " – " + fmtShort(last);
    }
    return fmtShort(anchor);
  }

  function legendPanel() {
    const panel = h("div", {
      id: "hq-cal-legend",
      class: "hq-cal-legend",
      role: "region",
      "aria-label": "Légende du calendrier",
    });
    const cats = h("ul", { class: "hq-cal-legend-cats" });
    categoryRows.forEach(([id, label]) => {
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
    for (const [style, label] of [["free", "Créneau libre"], ["conflict", "Chevauchement"]]) {
      notes.appendChild(h("li", { class: "hq-cal-legend-note" }, [
        h("span", { class: "hq-cal-legend-key is-" + style, "aria-hidden": "true" }),
        h("span", { text: label }),
      ]));
    }
    panel.appendChild(notes);
    return panel;
  }

  function dayView() {
    const wrap = h("div", { role: "group", "aria-label": "Vue jour · " + fmtDay(state.anchor) });
    wrap.appendChild(weekStrip());
    wrap.appendChild(timelineTools());
    const hint = dayHint([state.anchor]);
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(allDayLane(state.anchor));
    wrap.appendChild(dayTimeline(state.anchor));
    return wrap;
  }

  function timelineTools() {
    const actions = h("div", { class: "hq-cal-timeline-tools", role: "group", "aria-label": "Outils de la grille horaire" });
    if (showsToday()) actions.appendChild(h("button", {
      type: "button", class: "secondary", "data-cal": "now", "aria-label": "Maintenant",
      "data-help": "Ramène la grille à l’heure actuelle.",
    }, [
      h("span", { class: "hq-cal-tool-glyph", "aria-hidden": "true", text: "◷" }),
      h("span", { text: "Maintenant" }),
    ]));
    actions.appendChild(h("button", {
      type: "button", class: "secondary", "data-cal": "free-slots", "aria-label": "Créneau libre",
      "aria-haspopup": "dialog", "data-help": "Propose des heures libres pour la date sélectionnée.",
    }, [
      h("span", { class: "hq-cal-tool-glyph", "aria-hidden": "true", text: "▦" }),
      h("span", { class: "hq-cal-tool-long", text: "Créneau libre" }),
      h("span", { class: "hq-cal-tool-short", text: "Créneaux" }),
    ]));
    if (state.slotPreview && dayVisible(parseLocalDateKey(state.slotPreview.day))) {
      actions.appendChild(h("button", { type: "button", class: "secondary", "data-cal": "clear-slots", "aria-label": "Masquer les créneaux" }, [
        h("span", { class: "hq-cal-tool-long", text: "Masquer les créneaux" }),
        h("span", { class: "hq-cal-tool-short", text: "Masquer" }),
      ]));
    }
    return h("div", { class: "hq-cal-timeline-controls" }, [actions]);
  }

  function openGestureGuide() {
    const touch = coarsePointer();
    const root = sheet("hq-cal-gestures");
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    const card = h("div", { class: "hq-sheet-card hq-cal-picker", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-gestures-title", tabindex: "-1" }, [
      h("h3", { id: "hq-cal-gestures-title", text: touch ? "Gestes du calendrier" : "Gestes et raccourcis" }),
      h("div", { class: "hq-cal-gesture-steps" }, [
        h("div", {}, [h("strong", { text: "Créer" }), h("span", { text: touch ? "Touche une heure libre. Maintiens puis glisse pour choisir la durée." : "Clique ou glisse sur une heure libre." })]),
        h("div", {}, [h("strong", { text: "Déplacer" }), h("span", { text: touch ? "Glisse la poignée à points. Sur un bloc étroit, maintiens le bloc puis glisse." : "Glisse le bloc vers l’heure ou le jour voulu." })]),
        h("div", {}, [h("strong", { text: "Durée" }), h("span", { text: "Tire la barre au bas du bloc." })]),
        touch ? h("p", { text: "Balaye la grille pour changer de jour." }) : null,
        h("p", { text: "Tu peux aussi ouvrir un événement et choisir « Changer l’horaire »." }),
      ]),
      touch ? null : h("section", { class: "hq-cal-keys", "aria-label": "Raccourcis clavier" }, [
        h("h4", { class: "hq-cal-keys-title", text: "Clavier" }),
        ...KEY_ROWS.map(([keys, label]) => h("div", { class: "hq-cal-key-row" }, [
          h("kbd", { class: "hq-cal-key", text: keys }),
          h("span", { text: label }),
        ])),
      ]),
      close,
    ]);
    close.addEventListener("click", closeSheets);
    root.appendChild(card);
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function weekStrip() {
    const start = startOfLocalWeek(state.anchor);
    const index = Math.round((startOfDayMs(state.anchor) - startOfDayMs(start)) / 86400000);
    const prev = state.prevAnchor ? Math.round((startOfDayMs(state.prevAnchor) - startOfDayMs(start)) / 86400000) : index;
    const slide = /^(swipe-)?(next|prev)$|^scrub$/.test(state.anim) && prev >= 0 && prev < 7 && prev !== index;
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
      if (sameDay(day, today)) {
        button.classList.add("is-today");
        const run = (state.data && state.data.streak && state.data.streak.days) || 0;
        if (run >= 2) {
          button.appendChild(h("span", { class: "hq-cal-streak", "aria-hidden": "true", text: String(run) }));
          button.setAttribute("aria-label", fmtDay(day) + " · série de " + run + " jours");
        }
      }
      markRing(button, day);
      strip.appendChild(button);
    }
    return strip;
  }

  /* How much of a day the owner got through: finished events marked done, out of finished events. */
  function dayRing(day) {
    const now = liveNow();
    if (!now) return null;
    const ended = visibleItems().filter((item) => !item.read_only && !item.all_day && overlapsDay(item, day) && itemEnd(item) && itemEnd(item) <= now);
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
    const lane = h("div", { class: "hq-cal-allday", "data-allday": dateKey(day), role: "group",
      "aria-label": "Journée entière · " + fmtDay(day) });
    const rows = visibleItems().filter((item) => item.all_day && overlapsDay(item, day));
    if (!rows.length) return lane; // empty: hidden by CSS, no filler line
    rows.forEach((item) => lane.appendChild(chip(item)));
    return lane;
  }

  function chip(item) {
    const title = item.title || "Sans titre";
    const node = h("button", {
      type: "button",
      class: "hq-cal-chip " + catClass(item) + landedClass(item) + (isRecurring(item) ? " is-series" : ""),
      "data-cal": "open",
      "data-id": item.id,
      "data-help": previewHelp(item),
      "aria-label": title + (item.all_day ? " · journée" : item.start && String(item.start).includes("T") ? " · " + spanLabel(item) : "")
        + (isRecurring(item) ? " · série" : ""),
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
    const scroll = h("div", { class: "hq-cal-scroll", role: "group", "aria-label": "Grille horaire · " + fmtDay(day) });
    const grid = h("div", { class: "hq-cal-day" });
    const labels = h("div", { class: "hq-cal-hours" });
    const col = h("div", { class: "hq-cal-col", "data-col-day": dateKey(day) });
    const cursor = cursorHour(day);
    for (let hour = 0; hour < 24; hour += 1) {
      labels.appendChild(h("div", { class: "hq-cal-hourlabel", text: pad(hour) + ":00" }));
      col.appendChild(
        h("button", {
          type: "button",
          class: "hq-cal-slot",
          "data-cal": "slot",
          "data-day": dateKey(day),
          "data-hour": String(hour),
          "tabindex": hour === cursor ? "0" : "-1",
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
    const cal = document.querySelector(".hq-cal");
    const hour = cal ? parseFloat(getComputedStyle(cal).getPropertyValue("--cal-hh")) : NaN;
    return (Number.isFinite(hour) && hour > 0 ? hour : 48) * 24 * state.zoom;
  }

  /* A short event keeps its true visual height, but its button gets a 44 px halo centred on the block.
     Only the painted face and explicit handles take pointers; the halo itself lets empty slot rims
     underneath keep their own action. */
  function assignHitSlop(placed) {
    const colPx = columnPx();
    const pxPerMin = colPx / 1440;
    placed.forEach((entry) => {
      const visualPx = Math.max(1, (entry.endMin - entry.startMin) * pxPerMin);
      const targetPx = Math.max(44, visualPx);
      const topPx = entry.startMin * pxPerMin;
      const centered = topPx - (targetPx - visualPx) / 2;
      entry.visualPx = visualPx;
      entry.hitHeightPx = targetPx;
      entry.hitTopPx = Math.max(0, Math.min(colPx - targetPx, centered));
    });
  }

  function placeTimed(col, day, columns, reuse) {
    const dayStart = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate());
    const dayEnd = addLocalDays(dayStart, 1);
    const placed = layoutOverlaps(
      timedOn(day).filter(matchesCategory).map((item) => {
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
    assignHitSlop(placed);
    const colPx = columnPx();
    const now = liveNow();
    // reuse: the same event keeps the very node it had; only what differs is painted into it.
    const existing = reuse
      ? new Map([...col.children].filter((node) => node.classList && node.classList.contains("hq-cal-event") && node.dataset.id)
        .map((node) => [node.dataset.id, node]))
      : null;
    const kept = new Set();
    placed.forEach(entry => {
      const width = 100 / entry.cols;
      const top = (entry.startMin / 1440) * 100;
      const visualPx = entry.visualPx;
      const visualHeight = (visualPx / colPx) * 100;
      const hitTop = (entry.hitTopPx / colPx) * 100;
      const hitHeight = (entry.hitHeightPx / colPx) * 100;
      const faceTop = Math.max(0, Math.min(hitHeight, top - hitTop));
      const short = visualPx + 0.5 < entry.hitHeightPx;
      const faceLayout = coarse || short;
      const sliver = visualPx < 22;
      const compact = visualPx < 35;
      const openable = short && !sliver;
      const past = !!(now && itemEnd(entry.item) && itemEnd(entry.item) <= now);
      const live = !!(now && !past && itemStart(entry.item) <= now);
      const checkable = canCheck(entry.item, now);
      const canDrag = movable(entry.item);
      let button = existing ? existing.get(entry.item.id) : null;
      if (!button) button = h("button", { type: "button" });
      button.className = "hq-cal-event " + catClass(entry.item) + (faceLayout ? " is-halo" : "")
        + (past ? " is-past" : "") + landedClass(entry.item)
        + (canDrag ? " is-movable" : "") + (entry.item.done ? " is-done" : "") + (checkable ? " has-check" : "")
        + (state.burst === entry.item.id ? " is-burst" : "") + (live ? " is-live" : "") + (compact ? " is-compact" : "")
        + (openable ? " is-openable" : "");
      button.dataset.cal = "open";
      button.dataset.id = entry.item.id;
      button.dataset.help = previewHelp(entry.item);
      button.setAttribute("aria-label", previewHelp(entry.item));
      button.replaceChildren();
      if (faceLayout) {
        const face = h("span", {
          class: "hq-cal-face " + catClass(entry.item) + (sliver ? " is-sliver" : ""),
        }, [eventLabel(entry)]);
        face.style.top = (faceTop / hitHeight) * 100 + "%";
        face.style.height = (visualHeight / hitHeight) * 100 + "%";
        if (openable) face.appendChild(h("span", { class: "hq-cal-short-open", "aria-hidden": "true" }));
        button.appendChild(face);
      } else {
        button.appendChild(eventLabel(entry));
      }
      button.style.top = hitTop + "%";
      button.style.height = hitHeight + "%";
      button.style.left = entry.col * width + "%";
      button.style.width = width + "%";
      if (live) {
        // An event in progress fills with its colour from top to bottom as its time passes.
        button.dataset.from = String(itemStart(entry.item).getTime());
        button.dataset.to = String(itemEnd(entry.item).getTime());
        button.style.setProperty("--fill", liveFill(button, now).toFixed(4));
      } else {
        delete button.dataset.from;
        delete button.dataset.to;
        button.style.removeProperty("--fill");
      }
      if (canDrag) {
        const handle = h("span", { class: "hq-cal-move-grip", "data-grip": "move", "aria-hidden": "true" });
        if (faceLayout) handle.style.top = (faceTop / hitHeight) * 100 + "%";
        button.appendChild(handle);
        // Bottom edge: drag to change the end. On touch it sits at the bottom of the visible face.
        const grip = h("span", { class: "hq-cal-resize", "data-grip": "end", "aria-hidden": "true" });
        if (faceLayout) grip.style.top = "calc(" + (((faceTop + visualHeight) / hitHeight) * 100) + "% - 14px)";
        button.appendChild(grip);
      }
      if (checkable) {
        const check = checkMark(entry.item);
        if (faceLayout) check.style.top = (faceTop / hitHeight) * 100 + "%";
        button.appendChild(check);
      }
      if (!button.isConnected) col.appendChild(button);
      if (existing) kept.add(entry.item.id);
    });
    if (existing) existing.forEach((node, id) => { if (!kept.has(id)) node.remove(); });
    return columns;
  }

  function liveFill(el, now) {
    const a = Number(el.dataset.from);
    const b = Number(el.dataset.to);
    return Math.max(0, Math.min(1, (now.getTime() - a) / Math.max(1, b - a)));
  }

  /* A started event the owner wrote can be ticked off. */
  function canCheck(item, now) {
    const start = itemStart(item);
    return !!(item && !item.read_only && !isRecurring(item) && start && now && start <= now);
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

  function eventLabel(entry) {
    return h("span", { class: "hq-cal-event-labels" }, [
      h("span", { class: "hq-cal-ev-title", text: entry.item.title || "Sans titre" }),
      h("span", { class: "hq-cal-ev-time", text: hhmm(entry.startMin) }),
    ]);
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

  /* The all-day row of the week, built the same way for its first paint and for a later data change. */
  function allWeekRow(days) {
    const all = h("div", { class: "hq-cal-allweek", role: "group", "aria-label": "Journées entières de la semaine" });
    all.appendChild(h("div", { class: "hq-cal-hourlabel", text: "Jour" }));
    days.forEach((day) => {
      const cell = h("div", { class: "hq-cal-allcell" + (sameDay(day, serverToday()) ? " is-today" : ""), "data-allday": dateKey(day) });
      const rows = visibleItems().filter((item) => item.all_day && overlapsDay(item, day));
      rows.slice(0, 2).forEach((item) => cell.appendChild(chip(item)));
      if (rows.length > 2) cell.appendChild(allMore(day, rows.length - 2));
      all.appendChild(cell);
    });
    return all;
  }

  function allMore(day, extra) {
    return h("button", { type: "button", class: "hq-cal-more", "data-cal": "pick-day", "data-day": dateKey(day),
      "aria-label": "Voir les événements du " + fmtDay(day), text: "+" + extra });
  }

  function weekView() {
    const span = weekSpan();
    const first = weekStart(state.anchor);
    const scroll = h("div", { class: "hq-cal-scroll", role: "group",
      "aria-label": "Vue semaine · " + fmtDay(first) + " au " + fmtDay(addLocalDays(first, span - 1)) });
    const board = h("div", { class: "hq-cal-week" + (span === 3 ? " is-three" : "") });
    const head = h("div", { class: "hq-cal-weekhead" });
    const grid = h("div", { class: "hq-cal-weekgrid" });
    head.appendChild(h("div", {}));
    const labels = h("div", { class: "hq-cal-hours" });
    for (let hour = 0; hour < 24; hour += 1) {
      labels.appendChild(h("div", { class: "hq-cal-hourlabel", text: pad(hour) + ":00" }));
    }
    grid.appendChild(labels);
    const start = weekStart(state.anchor);
    const today = serverToday();
    for (let i = 0; i < span; i += 1) {
      const day = addLocalDays(start, i);
      const current = sameDay(day, today);
      const headBtn = h("button", {
        type: "button",
        "data-cal": "pick-day",
        "data-day": dateKey(day),
        "aria-label": fmtDay(day),
      }, [h("span", { class: "hq-cal-strip-dow", text: DOW[(day.getDay() + 6) % 7] }), h("span", { class: "hq-cal-strip-num", text: String(day.getDate()) })]);
      if (current) {
        headBtn.classList.add("is-today");
        headBtn.setAttribute("aria-current", "date");
      }
      markRing(headBtn, day);
      head.appendChild(headBtn);
      const col = h("div", { class: "hq-cal-weekcol" + (current ? " is-today" : ""), "data-col-day": dateKey(day) });
      const cursor = cursorHour(day);
      for (let hour = 0; hour < 24; hour += 1) {
        col.appendChild(
          h("button", {
            type: "button",
            class: "hq-cal-slot",
            "data-cal": "slot",
            "data-day": dateKey(day),
            "data-hour": String(hour),
            "tabindex": hour === cursor ? "0" : "-1",
            "aria-label": "Créer le " + dateKey(day) + " à " + pad(hour) + ":00",
          })
        );
      }
      placeTimed(col, day, 1);
      placeNow(col, day);
      if (state.activity) placeMarkers(col, day);
      grid.appendChild(col);
    }
    const days = Array.from({ length: span }, (_, index) => addLocalDays(start, index));
    const hasAllDay = days.some((day) => visibleItems().some((item) => item.all_day && overlapsDay(item, day)));
    board.append(h("div", { class: "hq-cal-week-top" }, [head, hasAllDay ? allWeekRow(days) : null]), grid);
    scroll.appendChild(board);
    return scroll;
  }

  function monthView() {
    const wrap = h("div", { class: "hq-cal-month", role: "group", "aria-label": "Vue mois · " + titleText() });
    DOW.forEach((label) => wrap.appendChild(h("div", { class: "hq-cal-dow", text: label })));
    const first = makeLocalDate(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
    const start = startOfLocalWeek(first);
    const today = serverToday();
    for (let i = 0; i < 42; i += 1) {
      const day = addLocalDays(start, i);
      const cell = h("div", { class: "hq-cal-mcell" + (day.getMonth() === state.anchor.getMonth() ? "" : " is-out") });
      if (sameDay(day, today)) cell.classList.add("is-today");
      if (sameDay(day, state.anchor)) cell.classList.add("is-anchor");
      const rows = visibleItems().filter((item) => overlapsDay(item, day));
      const label = fmtDay(day) + (rows.length ? " · " + rows.length + (rows.length === 1 ? " élément" : " éléments") : "");
      cell.appendChild(h("button", { type: "button", class: "hq-cal-mday", "data-cal": "pick-day",
        "data-day": dateKey(day), "aria-label": label, "aria-current": sameDay(day, today) ? "date" : null, text: String(day.getDate()) }));
      if (narrowMonth()) {
        // Phone: a cell is too narrow for titles. Coloured marks (category shapes, as in the legend)
        // say "something here"; tapping the day opens it.
        if (rows.length) {
          const dots = h("span", { class: "hq-cal-dots", "aria-hidden": "true" });
          const shown = rows.length > 3 ? 2 : rows.length; // 3 marks fit one line; past that, 2 marks and "+n"
          rows.slice(0, shown).forEach((item) => dots.appendChild(h("span", { class: "hq-cal-dot " + catClass(item) + landedClass(item) })));
          if (rows.length > shown) dots.appendChild(h("span", { class: "hq-cal-dot-more", text: "+" + (rows.length - shown) }));
          cell.appendChild(dots);
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
    const wrap = h("div", { class: "hq-cal-agenda", role: "group", "aria-label": "Vue agenda · 30 prochains jours" });
    let any = false;
    for (let i = 0; i < 30; i += 1) {
      const day = addLocalDays(state.anchor, i);
      const rows = visibleItems().filter((item) => overlapsDay(item, day));
      if (!rows.length) continue;
      any = true;
      const heading = sameDay(day, serverToday()) ? "Aujourd’hui · " + fmtShort(day) : fmtDay(day);
      wrap.appendChild(h("h3", {}, [h("button", {
        type: "button", class: "hq-cal-agenda-day", "data-cal": "pick-day", "data-day": dateKey(day),
        "aria-label": "Ouvrir la journée du " + fmtDay(day),
      }, [h("span", { text: heading }), h("span", { class: "hq-cal-agenda-count", "aria-hidden": "true", text: String(rows.length) }),
        h("span", { "aria-hidden": "true", text: "›" })])]));
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
          "data-day": dateKey(day),
          "data-help": previewHelp(item),
        });
        button.appendChild(h("time", { text: when }));
        const body = h("span", {});
        body.appendChild(h("strong", { text: item.title || "Sans titre" }));
        if (item.location) body.appendChild(h("div", { class: "hint", text: item.location }));
        if (item.read_only) body.appendChild(h("div", { class: "hint", text: "Lecture seule" }));
        else {
          const cat = categoryRows.find((row) => row[0] === (item.category || "other"));
          if (cat) body.appendChild(h("div", { class: "hint", text: cat[1] }));
        }
        button.appendChild(body);
        if (canCheck(item, now)) button.appendChild(checkMark(item));
        wrap.appendChild(button);
      });
    }
    if (!any) wrap.appendChild(h("p", { class: "hint", text: state.categories.size
      ? "Aucun événement dans les catégories sélectionnées." : "Rien de prévu sur les 30 prochains jours." }));
    return wrap;
  }

  function spanLabel(item) {
    const start = itemStart(item);
    const end = itemEnd(item);
    if (!start || !end) return "";
    return fmtTime(start) + "–" + fmtTime(end);
  }

  function conditionalBlock() {
    const rows = (state.data?.conditional || []).filter(matchesCategory);
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

  function setOptionsOpen(open) {
    state.optionsOpen = open;
    document.querySelector(".hq-cal-options-trigger")?.setAttribute("aria-expanded", String(open));
    const options = document.getElementById("hq-cal-option-list");
    if (options) options.hidden = !open;
  }

  function validCategories(keys) {
    const selected = categoryRows.filter(([id]) => keys.includes(id)).map(([id]) => id);
    return new Set(selected.length === categoryRows.length ? [] : selected);
  }

  function setCategoryFilters(keys) {
    state.categories = validCategories(keys);
    try { localStorage.setItem("hq_cal_categories", JSON.stringify([...state.categories])); } catch (_) {}
    renderKeep();
  }

  function categorySummary() {
    const labels = categoryRows.filter(([id]) => state.categories.has(id)).map(([, label]) => label);
    return h("div", { class: "hq-cal-filter-summary", role: "group", "aria-label": "Catégories affichées" }, [
      h("button", { type: "button", class: "secondary hq-cal-filter-current", "data-cal": "categories", "aria-haspopup": "dialog",
        text: labels.join(" · "), "aria-label": "Modifier les catégories affichées · " + labels.join(", ") }),
      h("button", { type: "button", class: "secondary hq-cal-filter-clear", "data-cal": "clear-categories",
        text: "Tout afficher" }),
    ]);
  }

  function openCategoryFilters() {
    const root = sheet("hq-cal-categories");
    const card = h("div", { class: "hq-sheet-card hq-cal-picker", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-categories-title", tabindex: "-1" });
    const tags = h("div", { class: "hq-cal-category-tags", role: "group", "aria-label": "Catégories à afficher" });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    const all = h("button", { type: "button", class: "hq-cal-category-tag", text: "Toutes" });
    const buttons = categoryRows.map(([id, label]) => {
      const button = h("button", { type: "button", class: "hq-cal-category-tag cat-" + id, text: label });
      button.addEventListener("click", () => {
        const selected = new Set(state.categories);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        setCategoryFilters([...selected]);
        paint();
      });
      return [id, button];
    });
    function paint() {
      all.setAttribute("aria-pressed", String(!state.categories.size));
      for (const [id, button] of buttons) button.setAttribute("aria-pressed", String(state.categories.has(id)));
    }
    all.addEventListener("click", () => {
      setCategoryFilters([]);
      paint();
    });
    close.addEventListener("click", closeSheets);
    tags.append(all, ...buttons.map(([, button]) => button));
    const manage = h("button", { type: "button", text: "Gérer les catégories" });
    manage.addEventListener("click", () => {
      root.hidden = true;
      openCategoryManager();
    });
    card.append(h("h3", { id: "hq-cal-categories-title", text: "Filtrer par catégorie" }), tags,
      h("div", { class: "hq-cal-picker-actions" }, [manage, close]));
    root.appendChild(card);
    paint();
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function openCategoryManager() {
    const root = sheet("hq-cal-category-manager");
    const card = h("div", { class: "hq-sheet-card hq-cal-picker", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-manager-title", tabindex: "-1" });
    const body = h("div", { class: "hq-cal-category-manager" });
    const error = h("p", { class: "hq-cal-editor-error", role: "alert" });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    close.addEventListener("click", closeSheets);
    card.append(h("h3", { id: "hq-cal-manager-title", text: "Gérer les catégories" }), error, body, close);
    root.appendChild(card);

    async function save(action, category, revision) {
      if (body.inert) return;
      body.inert = true;
      error.textContent = "";
      try {
        const result = await api("/api/calendar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, category, expected_rev: revision }),
        });
        Object.assign(state.data, result);
        syncCategoryCatalog();
        await refresh("keep");
        if (!root.hidden && !root.classList.contains("is-closing") && card.isConnected) {
          overview();
          body.inert = false;
          body.querySelector("button")?.focus({ preventScroll: true });
        }
      } catch (err) {
        if (err?.status === 409) {
          await refresh("keep");
          overview();
          error.textContent = "Les catégories ont changé. Rouvre la catégorie pour réessayer.";
        } else error.textContent = err?.message || "Enregistrement impossible.";
      } finally {
        body.inert = false;
      }
    }

    function overview() {
      const revision = state.data.categories_rev;
      const add = h("button", { type: "button", text: "Ajouter une catégorie" });
      add.addEventListener("click", () => edit([], revision));
      const list = h("ul", { class: "hq-cal-category-list" });
      for (const row of categoryRows) {
        const [id, label] = row;
        const button = h("button", { type: "button", class: "secondary", text: "Modifier", "aria-label": "Modifier " + label });
        button.addEventListener("click", () => edit(row, revision));
        list.appendChild(h("li", {}, [h("strong", { class: "hq-cal-category-name cat-" + id, text: label }), button]));
      }
      body.replaceChildren(add, list);
    }

    function backButton() {
      const back = h("button", { type: "button", class: "secondary", text: "Retour" });
      back.addEventListener("click", () => {
        error.textContent = "";
        overview();
        body.querySelector("button")?.focus({ preventScroll: true });
      });
      return back;
    }

    function edit(row, revision) {
      const [id, label = "", color = "#9274cf"] = row;
      const form = h("form", { class: "hq-cal-category-manager" });
      const name = h("input", { id: "hq-cal-category-name", value: label, maxlength: 32, required: true });
      const shade = h("input", { id: "hq-cal-category-color", type: "color", value: color });
      form.append(field("Nom", name), field("Couleur", shade), h("div", { class: "hq-cal-picker-actions" }, [
        h("button", { type: "submit", text: "Enregistrer" }), backButton(),
      ]));
      if (id && id !== "other") {
        const remove = h("button", { type: "button", class: "danger", text: "Supprimer cette catégorie" });
        remove.addEventListener("click", () => removeCategory(row, revision));
        form.appendChild(remove);
      }
      form.addEventListener("submit", event => {
        event.preventDefault();
        save("category_save", { id, label: name.value, color: shade.value }, revision);
      });
      body.replaceChildren(form);
      name.focus({ preventScroll: true });
    }

    function removeCategory([id, label], revision) {
      const destination = h("select", { id: "hq-cal-category-destination" });
      for (const [key, title] of categoryRows) {
        if (key !== id) destination.appendChild(h("option", { value: key, text: title }));
      }
      destination.value = "other";
      const remove = h("button", { type: "button", class: "danger", text: "Réaffecter et supprimer" });
      remove.addEventListener("click", () => save("category_delete", { id, replacement: destination.value }, revision));
      body.replaceChildren(h("p", { text: "Choisis la nouvelle catégorie des événements « " + label + " »." }),
        field("Catégorie de destination", destination), h("div", { class: "hq-cal-picker-actions" }, [remove, backButton()]));
      destination.focus({ preventScroll: true });
    }

    if (Number.isInteger(state.data?.categories_rev) && !state.data.malformed) overview();
    else body.appendChild(h("p", { class: "hint", text: "La gestion des catégories est indisponible sur ce serveur." }));
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function onClick(ev) {
    let button = ev.target.closest("[data-cal]");
    if (!button || !button.closest("#hq-cal-app")) return;
    const kind = button.dataset.cal;
    if (kind === "options") {
      setOptionsOpen(!state.optionsOpen);
      return;
    }
    if (kind === "categories") {
      document.querySelector(".hq-cal-options-trigger")?.focus({ preventScroll: true });
      setOptionsOpen(false);
      openCategoryFilters();
      return;
    }
    if (kind === "clear-categories") {
      setCategoryFilters([]);
      document.querySelector(".hq-cal-options-trigger")?.focus({ preventScroll: true });
      return;
    }
    if (kind === "view") {
      switchView(button.dataset.view || "week");
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
    if (kind === "now") {
      positionTimeline("snap", true);
      const scroll = dayScroll();
      if (scroll && scroll.getBoundingClientRect().top + 120 > window.innerHeight) {
        scroll.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" });
      }
      const line = scroll?.querySelector(".hq-cal-now");
      if (line) {
        line.classList.remove("is-focused");
        void line.offsetWidth;
        line.classList.add("is-focused");
      }
      return;
    }
    if (kind === "free-slots") {
      openFreeSlots(button);
      return;
    }
    if (kind === "clear-slots") {
      state.slotPreview = null;
      renderKeep();
      document.querySelector('#hq-cal-app [data-cal="free-slots"]')?.focus({ preventScroll: true });
      return;
    }
    if (kind === "choose-slot") {
      openEditor({ ...blankDraft(parseLocalDateKey(button.dataset.start.slice(0, 10)), 0),
        start: button.dataset.start, end: button.dataset.end });
      return;
    }
    if (kind === "history" || kind === "gestures") {
      document.querySelector(".hq-cal-options-trigger")?.focus({ preventScroll: true });
      setOptionsOpen(false);
      if (kind === "history") openUndoHistory();
      else openGestureGuide();
      return;
    }
    if (kind === "jump-date") {
      openDateJump(button);
      return;
    }
    if (kind === "search") {
      openCalendarSearch(button);
      return;
    }
    if (kind === "activity") {
      state.activity = !state.activity;
      try { localStorage.setItem("hq_cal_activity", state.activity ? "1" : "0"); } catch (_) {}
      refresh("keep");
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
      jumpToNextEvent(button.dataset.id, button.dataset.day);
      return;
    }
    if (kind === "legend") {
      state.legend = !state.legend;
      renderKeep();
      const again = document.querySelector("#hq-cal-app .hq-cal-options-trigger");
      if (again) again.focus();
      return;
    }
    if (kind === "create") {
      newEvent();
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
      openEditor(blankDraft(day, hour));
      return;
    }
    if (kind === "open") {
      const item = findItem(button.dataset.id);
      if (item) openDetail(item, button);
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
  let liveTimer = 0;
  let lastPeriodNotice = "";

  /* One live region for keyboard users: period changes, focus moves, saves and deletes. */
  function announce(message) {
    const node = document.getElementById("hq-cal-live");
    if (!node || !message) return;
    node.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { node.textContent = message; }, 20);
  }

  function viewName(view = state.view) {
    return { day: "Vue jour", week: "Vue semaine", month: "Vue mois", agenda: "Vue agenda" }[view] || "Calendrier";
  }

  function stageLabel(view = state.view) {
    const anchor = state.anchor || todayLocal();
    const period = titleText();
    return viewName(view) + " · " + (view === "day" ? period + " " + anchor.getFullYear() : period);
  }

  function announcePeriod() {
    const anchor = state.anchor || todayLocal();
    const key = state.view + "|" + dateKey(anchor) + "|" + weekSpan();
    if (key === lastPeriodNotice) return;
    lastPeriodNotice = key;
    announce(stageLabel());
  }

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

  function freeSlots(day, duration, events = items(), excludeId) {
    const opening = new Date(day).setHours(8, 0, 0, 0);
    const closing = new Date(day).setHours(22, 0, 0, 0);
    const now = liveNow() || new Date();
    const step = SNAP_MIN * 60000;
    const length = duration * 60000;
    const earliest = sameDay(day, now) ? Math.max(opening, now.getTime()) : opening;
    const roundUp = time => opening + Math.ceil((time - opening) / step) * step;
    // An all-day event owns the whole date, including every date of a multi-day span.
    if (events.some(item => item.id !== excludeId && item.all_day && overlapsDay(item, day))) return [];
    const busy = events.filter(item => item.id !== excludeId && !item.all_day && overlapsDay(item, day))
      .map(item => [itemStart(item).getTime(), itemEnd(item).getTime()]).sort((a, b) => a[0] - b[0]);
    const slots = [];
    const windows = [opening, new Date(day).setHours(12, 0, 0, 0), new Date(day).setHours(17, 0, 0, 0), closing];
    for (let i = 0; i < windows.length - 1; i += 1) {
      let start = roundUp(Math.max(earliest, windows[i]));
      for (const [from, to] of busy) {
        if (start + length <= from) break;
        if (start < to) start = roundUp(to);
      }
      if (start < windows[i + 1] && start + length <= closing) slots.push(new Date(start));
    }
    return slots;
  }

  function openFreeSlots(trigger) {
    trigger.focus({ preventScroll: true });
    const day = state.anchor || serverToday();
    const root = sheet("hq-cal-free-slots");
    const card = h("div", { class: "hq-sheet-card hq-cal-free-slots", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-free-slots-title", tabindex: "-1" });
    const durations = h("div", { class: "hq-cal-durations", role: "group", "aria-label": "Durée du créneau" });
    const status = h("p", { class: "hint", role: "status" });
    const results = h("div", { class: "hq-cal-free-slot-results" });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    const showGrid = h("button", { type: "button", text: "Voir sur la grille" });
    const choices = [[30, "30 min"], [60, "1 h"], [90, "1 h 30"]];
    const maxRows = Math.max(...choices.map(([duration]) => freeSlots(day, duration).length));
    results.style.setProperty("--slot-rows", String(Math.max(0, maxRows)));
    let selected = 0;
    let visibleList = null;
    function show(duration) {
      if (selected === duration) return;
      selected = duration;
      durations.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(Number(button.value) === duration)));
      const slots = freeSlots(day, duration);
      showGrid.disabled = !slots.length;
      const list = h("div", { class: "hq-cal-free-slot-list" });
      status.textContent = slots.length ? (slots.length === 1 ? "1 créneau proposé" : slots.length + " créneaux proposés")
        : "Aucun créneau à cette durée.";
      slots.forEach(start => {
        const end = new Date(start.getTime() + duration * 60000);
        const option = h("button", { type: "button", class: "secondary hq-cal-free-slot" }, [
          h("strong", { text: fmtTime(start) + " – " + fmtTime(end) }),
          h("span", { text: "Choisir", "aria-hidden": "true" }),
        ]);
        option.addEventListener("click", () => {
          const draft = blankDraft(day, start.getHours());
          draft.start = minuteKey(start);
          draft.end = minuteKey(end);
          openEditor(draft);
        });
        list.appendChild(option);
      });
      const outgoing = visibleList;
      visibleList = list;
      if (!outgoing || typeof list.animate !== "function") {
        results.replaceChildren(list);
        return;
      }
      outgoing.inert = true;
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.classList.add("is-outgoing");
      results.replaceChildren(outgoing, list);
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" })
        .finished.then(() => outgoing.remove(), () => outgoing.remove());
      list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }
    choices.forEach(([duration, label]) => {
      const button = h("button", { type: "button", class: "hq-cal-chipbtn", value: duration, text: label });
      button.addEventListener("click", () => show(duration));
      durations.appendChild(button);
    });
    close.addEventListener("click", closeSheets);
    showGrid.addEventListener("click", async () => {
      state.slotPreview = { day: dateKey(day), duration: selected };
      closeSheets();
      if (!dayVisible(day) || (state.view !== "day" && state.view !== "week")) {
        state.view = "day";
        await goToDate(day);
      } else renderKeep();
      const first = document.querySelector(".hq-cal-slot-band");
      if (first) {
        const scroll = dayScroll();
        revealTimelineNode(scroll, first);
        if (scroll && scroll.getBoundingClientRect().top + 100 > window.innerHeight) {
          scroll.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" });
        }
        first.focus({ preventScroll: true });
      }
    });
    card.append(
      h("h3", { id: "hq-cal-free-slots-title", text: "Trouver un créneau libre" }),
      h("p", { class: "hq-cal-free-slot-date", text: fmtDay(day) }),
      h("p", { class: "hint", text: "De 8 h à 22 h, hors journées déjà occupées." }),
      durations, status, results, h("div", { class: "hq-cal-picker-actions" }, [showGrid, close])
    );
    root.appendChild(card);
    show(30);
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function paintFreeSlotBands(stage) {
    // The stage now survives a data change, so bands from the previous paint must leave first.
    stage.querySelectorAll(".hq-cal-slot-band").forEach((node) => node.remove());
    const preview = state.slotPreview;
    if (!preview) return;
    const col = stage.querySelector('[data-col-day="' + preview.day + '"]');
    if (!col) return;
    const day = parseLocalDateKey(preview.day);
    for (const start of freeSlots(day, preview.duration)) {
      const end = new Date(start.getTime() + preview.duration * 60000);
      const time = fmtTime(start) + " – " + fmtTime(end);
      const minutes = start.getHours() * 60 + start.getMinutes();
      col.appendChild(h("button", { type: "button", class: "hq-cal-slot-band", "data-cal": "choose-slot",
        "data-start": minuteKey(start), "data-end": minuteKey(end), "aria-label": "Créer dans le créneau " + time,
        style: "top:" + (minutes / 1440) * 100 + "%;height:" + (preview.duration / 1440) * 100 + "%",
      }, [h("span", { text: time })]));
    }
  }

  function openDateJump(trigger) {
    dateJumpHour = focusedHour(); // read before the trigger takes focus
    trigger?.focus?.({ preventScroll: true });
    const root = sheet("hq-cal-date-jump");
    const card = h("form", { class: "hq-sheet-card hq-cal-date-jump", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-date-jump-title" });
    const input = h("input", { id: "hq-cal-jump-input", type: "date", value: dateKey(state.anchor || serverToday()), required: true });
    const today = h("button", { type: "button", class: "secondary", text: "Aujourd’hui" });
    const close = h("button", { type: "button", class: "secondary", text: "Annuler" });
    card.append(
      h("h3", { id: "hq-cal-date-jump-title", text: "Aller à une date" }),
      h("div", { class: "field" }, [h("label", { for: input.id, text: "Date" }), input]),
      h("div", { class: "hq-cal-date-jump-actions" }, [today, close, h("button", { type: "submit", text: "Aller à cette date" })])
    );
    async function jump(day) {
      const hour = Number.isInteger(dateJumpHour) ? dateJumpHour : 9;
      const keyboard = keyboardIntent;
      dateJumpHour = null;
      closeSheets();
      if (keyboard) {
        // A keyboard jump lands in the day's grid at the carried hour, or 09:00.
        state.userMoved = true;
        state.anim = state.view === "day" ? (state.anchor && day < state.anchor ? "prev" : "next") : "view";
        state.view = "day";
        try { localStorage.setItem("hq_cal_view", "day"); } catch (_) {}
        state.anchor = day;
        pendingGridFocus = { day, hour };
        refresh(sameDay(day, serverToday()) ? "snap" : undefined);
        return;
      }
      // Pointer: keep the view and wait for the very render this jump started, so the sheet's
      // focus restoration cannot interleave with it.
      await goToDate(day);
      if (document.body.dataset.view === "calendrier" && document.activeElement === document.body) {
        document.querySelector(".hq-cal-date-trigger")?.focus({ preventScroll: true });
      }
    }
    today.addEventListener("click", () => jump(serverToday()));
    close.addEventListener("click", closeSheets);
    input.addEventListener("input", () => input.setCustomValidity(""));
    card.addEventListener("submit", (event) => {
      event.preventDefault();
      const day = parseLocalDateKey(input.value);
      if (day) jump(day);
      else {
        input.setCustomValidity("Choisis une date valide.");
        input.reportValidity();
      }
    });
    root.appendChild(card);
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    input.focus({ preventScroll: true });
  }

  function openCalendarSearch(trigger) {
    trigger?.focus?.({ preventScroll: true });
    const root = sheet("hq-cal-search");
    const card = h("div", { class: "hq-sheet-card hq-cal-search", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-search-title" });
    const input = h("input", { id: "hq-cal-search-input", type: "search", autocomplete: "off", placeholder: "Titre ou lieu",
      "aria-label": "Titre ou lieu", "aria-describedby": "hq-cal-search-range" });
    const anchor = state.anchor || serverToday();
    const first = addLocalDays(anchor, -183);
    const last = addLocalDays(anchor, 183);
    const dateFormat = new Intl.DateTimeFormat("fr-CA", { day: "numeric", month: "short", year: "numeric" });
    const status = h("p", { class: "hint", role: "status" });
    const rows = h("div", { class: "hq-cal-search-results" });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    let events = [];
    let loaded = false;
    const fold = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

    function paint() {
      rows.textContent = "";
      if (!loaded) return;
      const words = fold(input.value).trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        status.textContent = "Saisis un titre ou un lieu.";
        return;
      }
      const results = events.filter(item => {
        const label = fold((item.title || "") + " " + (item.location || ""));
        return matchesCategory(item) && words.every(word => label.includes(word));
      });
      status.textContent = results.length === 0 ? (state.categories.size
        ? "Aucun résultat dans les catégories sélectionnées." : "Aucun événement trouvé.") : results.length === 1
        ? "1 événement trouvé" : results.length > 40 ? "40 événements affichés sur " + results.length : results.length + " événements trouvés";
      for (const item of results.slice(0, 40)) {
        const start = itemStart(item);
        const date = dateFormat.format(start) + (item.all_day ? " · Toute la journée" : " · " + fmtTime(start));
        const row = h("button", { type: "button", class: "hq-cal-search-result " + catClass(item) }, [
          h("strong", { text: item.title || "Sans titre" }),
          h("span", { text: date + (item.location ? " · " + item.location : "") + (item.series_id ? " · Série" : "") }),
        ]);
        row.addEventListener("click", () => {
          root.hidden = true;
          closeSheets();
          openDetail(item);
        });
        rows.appendChild(row);
      }
    }

    async function load() {
      status.textContent = "Chargement…";
      rows.textContent = "";
      try {
        const data = await api("/api/calendar?from=" + dateKey(first) + "&to=" + dateKey(last));
        if (root.hidden || !card.isConnected) return;
        events = (data.items || []).filter(item => !item.read_only && itemStart(item)).sort((a, b) =>
          Math.abs(itemStart(a) - anchor) - Math.abs(itemStart(b) - anchor));
        loaded = true;
        paint();
      } catch (error) {
        if (root.hidden || !card.isConnected) return;
        status.textContent = error?.message || "Recherche indisponible.";
        const retry = h("button", { type: "button", class: "secondary", text: "Réessayer" });
        retry.addEventListener("click", load);
        rows.appendChild(retry);
      }
    }

    card.append(
      h("h3", { id: "hq-cal-search-title", text: "Rechercher un événement" }), input,
      h("p", { id: "hq-cal-search-range", class: "hint", text: "Du " + dateFormat.format(first) + " au " + dateFormat.format(addLocalDays(last, -1)) }),
      status, rows, close
    );
    close.addEventListener("click", closeSheets);
    input.addEventListener("input", paint);
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        const result = rows.querySelector(".hq-cal-search-result");
        if (!result) return;
        event.preventDefault();
        if (event.key === "Enter") result.click();
        else result.focus();
      }
    });
    // Inside the results: ↑ ↓ walk the list (↑ from the first comes back to the field),
    // Home / End jump to its ends, Enter opens the focused one as any button does.
    rows.addEventListener("keydown", (event) => {
      const results = [...rows.querySelectorAll(".hq-cal-search-result")];
      const index = results.indexOf(document.activeElement);
      if (index < 0) return;
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        results[event.key === "Home" ? 0 : results.length - 1].focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const next = results[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) next.focus();
      else if (event.key === "ArrowUp") input.focus();
    });
    root.appendChild(card);
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    input.focus({ preventScroll: true });
    load();
  }

  /* Give the sheet a short entrance from the direction of the triggering control. */
  function present(card) {
    const rect = card.getBoundingClientRect();
    const recent = lastPoint && Date.now() - lastPoint.t < 1500;
    const ox = recent ? lastPoint.x : rect.left + rect.width / 2;
    const oy = recent ? lastPoint.y : rect.top + rect.height;
    card.style.setProperty("--dx", Math.round(Math.max(-12, Math.min(12, ox - (rect.left + rect.width / 2)))) + "px");
    card.style.setProperty("--dy", Math.round(Math.max(-16, Math.min(16, oy - (rect.top + rect.height / 2)))) + "px");
    card.classList.add("is-morph");
  }

  /* Switching view from the segmented control or a number key: one path, one animation. */
  function switchView(id) {
    if (!id || id === state.view) return;
    setOptionsOpen(false);
    state.anim = "view";
    state.view = id;
    try { localStorage.setItem("hq_cal_view", id); } catch (_) {}
    refresh();
  }

  /* One new event, from the toolbar button or N: the focused cell's day and hour when there is one,
     otherwise the anchor day at 9:00. The title is focused. */
  function newEvent() {
    setOptionsOpen(false);
    const day = focusedDay() || state.anchor || serverToday();
    const hour = focusedHour();
    openEditor(blankDraft(day, Number.isInteger(hour) ? hour : 9));
  }

  /* One tab stop per timeline column (roving tabindex): Tab enters at the cursor hour, arrows move it. */
  function cursorHour(day) {
    const saved = gridCursor.get(dateKey(day));
    if (Number.isInteger(saved)) return saved;
    const now = sameDay(day, serverToday()) ? serverNow() : null;
    return now ? now.getHours() : 8;
  }

  function slotNode(day, hour) {
    const col = document.querySelector('#hq-cal-app [data-col-day="' + CSS.escape(dateKey(day)) + '"]');
    return col ? col.querySelector('.hq-cal-slot[data-hour="' + hour + '"]') : null;
  }

  /* Focus an hour cell and make it its column's tab stop, scrolling the grid (never the page) to it. */
  function moveGridFocus(day, hour) {
    const slot = slotNode(day, hour);
    if (!slot) return false;
    gridCursor.set(dateKey(day), hour);
    for (const node of slot.closest("[data-col-day]").querySelectorAll(".hq-cal-slot")) {
      node.setAttribute("tabindex", node === slot ? "0" : "-1");
    }
    slot.focus({ preventScroll: true });
    revealTimelineNode(slot.closest(".hq-cal-scroll"), slot);
    announce("Créneau · " + fmtDay(day) + " · " + pad(hour) + ":00");
    return true;
  }

  /* The day the focused control belongs to: an hour cell, an all-day chip, a timeline event,
     an agenda row, a month day or a strip day. */
  function focusedDay() {
    const active = document.activeElement;
    if (!active || active === document.body || !active.closest) return null;
    const pick = active.closest('[data-cal="pick-day"][data-day]');
    if (pick) return parseLocalDateKey(pick.dataset.day);
    const cell = active.closest("[data-col-day], [data-allday]");
    if (cell) return parseLocalDateKey(cell.dataset.colDay || cell.dataset.allday);
    const row = active.closest(".hq-cal-row[data-day]");
    if (row) return parseLocalDateKey(row.dataset.day);
    const item = active.dataset && active.dataset.id ? findItem(active.dataset.id) : null;
    const start = item ? itemStart(item) : null;
    return start || null;
  }

  function focusedHour() {
    const slot = document.activeElement?.closest?.(".hq-cal-slot");
    return slot ? Number(slot.dataset.hour) : null;
  }

  /* Keyboard path onto an event: E cycles the events covering the focused day (or the anchor
     when no day owns the cursor), announces the title, and leaves the native button in charge
     of Enter/Space opening its sheet. */
  function focusDayEvent(direction = 1) {
    const stage = document.querySelector("#hq-cal-app .hq-cal-stage");
    if (!stage) return false;
    const day = focusedDay() || state.anchor || serverToday();
    const nodes = [...stage.querySelectorAll('[data-cal="open"][data-id]')].filter((node) => {
      const item = findItem(node.dataset.id);
      if (!item) return false;
      if (node.classList.contains("hq-cal-row") && node.dataset.day) {
        return sameDay(parseLocalDateKey(node.dataset.day), day);
      }
      return overlapsDay(item, day);
    });
    if (!nodes.length) {
      announce("Aucun événement le " + fmtDay(day) + ". N pour en créer un.");
      return false;
    }
    const at = nodes.indexOf(document.activeElement);
    const node = nodes[at < 0 ? 0 : (at + direction + nodes.length) % nodes.length];
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest" });
    const item = findItem(node.dataset.id);
    announce((item?.title || "Sans titre") + " · " + (item ? whenText(item) : fmtDay(day)));
    return true;
  }

  function captureGridFocus(active, root) {
    if (!active || active === document.body || !root.contains(active) || !active.closest) return null;
    const slot = active.closest(".hq-cal-slot");
    if (slot) return { kind: "slot", day: slot.dataset.day, hour: Number(slot.dataset.hour) };
    const mday = active.closest(".hq-cal-mday");
    if (mday) return { kind: "day", day: mday.dataset.day };
    const row = active.closest(".hq-cal-row[data-id]");
    if (row) return { kind: "row", day: row.dataset.day, id: row.dataset.id };
    const node = active.closest(".hq-cal-event[data-id], .hq-cal-chip[data-id]");
    return node ? { kind: "item", id: node.dataset.id } : null;
  }

  function restoreGridFocus(saved) {
    let node = null;
    if (saved.kind === "slot") node = slotNode(parseLocalDateKey(saved.day), saved.hour);
    else if (saved.kind === "day") node = document.querySelector('#hq-cal-app .hq-cal-mday[data-day="' + CSS.escape(saved.day) + '"]');
    else if (saved.kind === "row") node = document.querySelector('#hq-cal-app .hq-cal-agenda .hq-cal-row[data-day="' + CSS.escape(saved.day || "") + '"][data-id="' + CSS.escape(saved.id) + '"]');
    else node = document.querySelector('#hq-cal-app .hq-cal-stage [data-id="' + CSS.escape(saved.id) + '"]');
    if (node) node.focus({ preventScroll: true });
  }

  /* A keyboard day or period change lands on the new period's grid: the hour the cursor had, or
     09:00. The period title is the last resort — focus never falls to the document. */
  function focusMonthDay(day) {
    const node = document.querySelector('#hq-cal-app .hq-cal-mday[data-day="' + CSS.escape(dateKey(day)) + '"]');
    if (!node) return false;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest" });
    announce("Jour · " + fmtDay(day));
    return true;
  }

  function focusAgendaDay(day) {
    const row = document.querySelector('#hq-cal-app .hq-cal-agenda .hq-cal-row[data-day="' + CSS.escape(dateKey(day)) + '"]')
      || document.querySelector("#hq-cal-app .hq-cal-agenda .hq-cal-row");
    if (!row) return false;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
    announce("Agenda · " + (row.innerText || "").split("\n").slice(0, 2).join(" · "));
    return true;
  }

  /* Focus a day in whichever view is active; used after a delete or a save when the old
     chip no longer exists. */
  function focusCalendarDate(day, hour) {
    if (!day) return false;
    const targetHour = Number.isInteger(hour) ? hour : 9;
    if (state.view === "day" || state.view === "week") return moveGridFocus(day, targetHour);
    if (state.view === "month") return focusMonthDay(day);
    return focusAgendaDay(day);
  }

  function focusSavedEvent(event, hint) {
    if (!event) return false;
    const id = occurrenceIdFor(event, hint || event.start);
    const stage = document.querySelector("#hq-cal-app .hq-cal-stage");
    const selector = [".hq-cal-event", ".hq-cal-chip", ".hq-cal-row"]
      .map((cls) => cls + '[data-id="' + CSS.escape(id) + '"]').join(",");
    const node = stage?.querySelector(selector)
      || document.querySelector('#hq-cal-app [data-cal="open"][data-id="' + CSS.escape(id) + '"]');
    if (node) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: "nearest" });
      return true;
    }
    const day = parseLocalDateKey(String(hint || event.start || "").slice(0, 10));
    const start = itemStart(event);
    return focusCalendarDate(day, start ? start.getHours() : 9);
  }

  function focusSwitchedPeriod(hour) {
    const target = Number.isInteger(hour) ? hour : 9;
    const anchor = state.anchor || serverToday();
    let landed = false;
    if (state.view === "day" || state.view === "week") {
      landed = moveGridFocus(anchor, target);
      if (!landed) {
        const col = document.querySelector("#hq-cal-app [data-col-day]");
        landed = !!col && moveGridFocus(parseLocalDateKey(col.dataset.colDay), target);
      }
    } else if (state.view === "month") landed = focusMonthDay(anchor);
    else landed = focusAgendaDay(anchor);
    if (!landed) document.querySelector("#hq-cal-app .hq-cal-date-trigger")?.focus({ preventScroll: true });
  }

  /* The grid is a keyboard surface: ↑ ↓ walk the hours, ← → the days (a day off screen slides in and
     keeps its hour), Enter / Space open the cell, Esc hands focus back to the period title. Agenda
     rows take ↑ ↓ the same way, and the month board walks its 6 × 7 cells. */
  function onGridKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    if (!target || !target.closest) return;
    if ([...document.querySelectorAll(".hq-sheet")].some((node) => !node.hidden && !node.classList.contains("is-closing"))) return;
    const slot = target.closest("#hq-cal-app .hq-cal-slot");
    const row = target.closest("#hq-cal-app .hq-cal-agenda .hq-cal-row");
    const mday = target.closest("#hq-cal-app .hq-cal-mcell .hq-cal-mday");
    if (!slot && !row && !mday) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      document.querySelector("#hq-cal-app .hq-cal-date-trigger")?.focus({ preventScroll: true });
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") return; // the button opens its day or event on its own
    const step = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (slot) {
      const day = parseLocalDateKey(slot.dataset.day);
      const hour = Number(slot.dataset.hour);
      if (!day) return;
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        moveGridFocus(day, Math.max(0, Math.min(23, hour + step)));
        return;
      }
      const cols = [...document.querySelectorAll("#hq-cal-app [data-col-day]")];
      const next = cols[cols.indexOf(slot.closest("[data-col-day]")) + step];
      if (next) {
        moveGridFocus(parseLocalDateKey(next.dataset.colDay), hour);
        return;
      }
      // the neighbour is off screen: slide the period to it, then focus the same hour there
      const away = addLocalDays(day, step);
      pendingGridFocus = { day: away, hour };
      state.userMoved = true;
      state.anim = step > 0 ? "next" : "prev";
      state.anchor = away;
      refresh(sameDay(away, serverToday()) ? "snap" : undefined);
      return;
    }
    if (row) {
      const rows = [...document.querySelectorAll("#hq-cal-app .hq-cal-agenda .hq-cal-row")];
      const next = rows[rows.indexOf(row) + step];
      if (next) {
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: "nearest" });
      } else {
        document.querySelector("#hq-cal-app .hq-cal-date-trigger")?.focus({ preventScroll: true });
      }
      return;
    }
    const cells = [...document.querySelectorAll("#hq-cal-app .hq-cal-mcell .hq-cal-mday")];
    const across = step * (ev.key === "ArrowUp" || ev.key === "ArrowDown" ? 7 : 1);
    const next = cells[cells.indexOf(mday) + across];
    if (next) focusMonthDay(parseLocalDateKey(next.dataset.day));
  }

  /* Keys on the calendar view only, never while typing or while a sheet, a dialog or the palette
     is open: ← → change period, T is today, N a new event, F searches, G jumps to a date,
     1–4 pick the view, Ctrl+Z undoes, H opens the guide. (« / » and « ? » belong to the app-wide palette.) */
  function navKey(ev) {
    if (!document.body || document.body.dataset.view !== "calendrier") return;
    const target = ev.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const openSheet = [...document.querySelectorAll(".hq-sheet")]
      .some((node) => !node.hidden && !node.classList.contains("is-closing"));
    if (openSheet || document.querySelector("dialog[open]")) return;
    const palette = document.getElementById("hq-palette");
    if (palette && !palette.hidden) return;
    const key = ev.key;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (key === "z" || key === "Z")) {
      if (!undoHistory.length || undoBusy) return;
      ev.preventDefault();
      undoLatest();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (key === "PageUp" || key === "PageDown") {
      ev.preventDefault();
      go(key === "PageDown" ? 1 : -1);
      return;
    }
    if (key === "e" || key === "E") {
      ev.preventDefault();
      focusDayEvent(ev.shiftKey ? -1 : 1);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      ev.preventDefault();
      go(key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (key === "t" || key === "T") {
      ev.preventDefault();
      goToday();
      return;
    }
    const view = ["day", "week", "month", "agenda"][Number(key) - 1];
    if (view) {
      ev.preventDefault();
      switchView(view);
      return;
    }
    if (!["n", "N", "f", "F", "g", "G", "h", "H"].includes(key)) return;
    ev.preventDefault();
    if (state.optionsOpen) setOptionsOpen(false);
    if (key === "n" || key === "N") newEvent();
    else if (key === "g" || key === "G") openDateJump(document.querySelector(".hq-cal-date-trigger"));
    else if (key === "h" || key === "H") openGestureGuide();
    else openCalendarSearch(document.querySelector('#hq-cal-app [data-cal="search"]'));
  }

  /* ---- quick add: one sentence, Entrée, done ---- */
  function fmtQuickDay(date) {
    return new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(date);
  }

  function quickDraft(text) {
    const parser = window.HQCalendarQuick;
    if (!parser) return null;
    const draft = parser.parse(text, serverNow() || new Date(), state.anchor || todayLocal());
    if (draft) draft.category = categoryKey(draft);
    return draft;
  }

  function paintQuick(keepGhost) {
    const input = document.getElementById("hq-cal-quick-input");
    const preview = document.getElementById("hq-cal-quick-preview");
    const more = document.getElementById("hq-cal-quick-more");
    const submit = document.getElementById("hq-cal-quick-submit");
    if (!input || !preview) return;
    const text = input.value.trim();
    const draft = text ? quickDraft(text) : null;
    if (submit) submit.disabled = !draft || input.form.classList.contains("is-saving");
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
    const cat = categoryRows.find((row) => row[0] === draft.category);
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
    if (pressed.size) return; // a chip must not vanish under the finger that is tapping it
    const box = document.getElementById("hq-cal-quick-recent");
    const input = document.getElementById("hq-cal-quick-input");
    if (!box || !input) return;
    const rows = ((state.data && state.data.recent) || []).slice(0, 6);
    box.hidden = !!input.value.trim() || !rows.length || !input.form.contains(document.activeElement);
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

  function offerUndo(label, before, after) {
    undoHistory.push({ label, before: before ? { ...before } : null, after: after ? { ...after } : null });
    if (undoHistory.length > UNDO_LIMIT) undoHistory.shift();
    paintUndoHistory();
    showUndo();
  }

  function showUndo() {
    let bar = document.getElementById("hq-cal-undo");
    clearTimeout(undoTimer);
    const entry = undoHistory.at(-1);
    if (!entry) {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      bar = h("div", { id: "hq-cal-undo", class: "hq-cal-undo", role: "status", "aria-live": "polite" });
      document.body.appendChild(bar);
    }
    const button = h("button", { type: "button", class: "hq-cal-undo-btn", "aria-keyshortcuts": "Control+Z", text: "Annuler" });
    button.disabled = undoBusy;
    button.addEventListener("click", undoLatest);
    bar.replaceChildren(h("span", { class: "hq-cal-undo-copy" }, [
      h("span", { class: "hq-cal-undo-text", text: entry.label + " · " + ((entry.after || entry.before).title || "Sans titre") }),
      h("span", { class: "hq-cal-undo-when", text: whenText(entry.after || entry.before) }),
    ]), button, h("span", { class: "hq-cal-undo-time", "aria-hidden": "true" }));
    bar.hidden = false;
    bar.classList.remove("is-in", "is-out");
    bar.style.setProperty("--hq-cal-undo-duration", UNDO_MS + "ms");
    void bar.offsetWidth;
    bar.classList.add("is-in");
    const hide = () => {
      clearTimeout(undoTimer);
      bar.classList.add("is-out");
      undoTimer = setTimeout(() => { bar.hidden = true; bar.classList.remove("is-in", "is-out"); }, 200);
    };
    undoTimer = setTimeout(hide, UNDO_MS);
  }

  async function undoLatest() {
    const entry = undoHistory.at(-1);
    if (!entry || undoBusy) return;
    const { before, after } = entry;
    const id = (after || before).id;
    const focused = document.activeElement;
    const fromHistory = focused?.matches(".hq-cal-history-undo");
    const fromBar = focused?.matches(".hq-cal-undo-btn");
    undoBusy = true;
    for (const button of document.querySelectorAll(".hq-cal-undo-btn, .hq-cal-history-undo")) button.disabled = true;
    let restored;
    try {
      if (before) {
        const payload = eventPayload(before, { id: after?.id || "" });
        restored = (await saveCall(payload, after?.rev || 0)).event;
      } else await deleteCall(id, after.rev);

      const index = undoHistory.indexOf(entry);
      const earlier = index < 0 ? [] : undoHistory.slice(0, index);
      if (index >= 0) undoHistory.splice(index, 1);
      if (restored) {
        const sameEvent = earlier.filter(row => (row.after || row.before).id === id);
        const previous = sameEvent.at(-1);
        if (previous?.after?.rev === before.rev) {
          for (const row of sameEvent) {
            if (row.before) row.before.id = restored.id;
            if (row.after) row.after.id = restored.id;
          }
          previous.after.rev = restored.rev;
        } else {
          // An external edit broke the chain. Older snapshots must not overwrite it.
          for (const row of sameEvent) undoHistory.splice(undoHistory.indexOf(row), 1);
        }
      }
      dropEffects.delete(id);
      chime("undo");
      buzz(8);
      await landOn(restored);
      const title = (restored || before || after)?.title || "Sans titre";
      if (restored) {
        const day = parseLocalDateKey(String(restored.start || "").slice(0, 10));
        const start = itemStart(restored);
        if (!focusSavedEvent(restored) && day) focusCalendarDate(day, start ? start.getHours() : 9);
        announce((before && !after ? "Suppression annulée" : "Modification annulée") + " : " + title);
      } else if (after) {
        const start = itemStart(after);
        if (start) focusCalendarDate(parseLocalDateKey(dateKey(start)), start.getHours());
        announce("Ajout annulé : " + title);
      }
    } catch (err) {
      if (err?.status === 409 || err?.message === "Événement introuvable") {
        for (let i = undoHistory.length - 1; i >= 0; i -= 1) {
          if ((undoHistory[i].after || undoHistory[i].before).id === id) undoHistory.splice(i, 1);
        }
      }
      if (typeof toast === "function") toast(err?.message || "Annulation impossible", "err");
      refresh("keep");
    } finally {
      undoBusy = false;
      paintUndoHistory();
      showUndo();
      if (document.activeElement === document.body || document.activeElement === focused) {
        if (fromHistory) {
          const history = document.querySelector("#hq-cal-history:not([hidden]):not(.is-closing)");
          (history?.querySelector(".hq-cal-history-undo") || history?.querySelector(".hq-cal-picker > button"))?.focus({ preventScroll: true });
        } else if (fromBar) document.querySelector("#hq-cal-undo:not([hidden]) .hq-cal-undo-btn")?.focus({ preventScroll: true });
      }
    }
  }

  function openUndoHistory() {
    const root = sheet("hq-cal-history");
    const card = h("div", { class: "hq-sheet-card hq-cal-picker", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-history-title", tabindex: "-1" });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    close.addEventListener("click", closeSheets);
    card.append(h("h3", { id: "hq-cal-history-title", text: "Historique des modifications" }),
      h("div", { class: "hq-cal-history-content" }), close);
    root.appendChild(card);
    paintUndoHistory();
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function paintUndoHistory() {
    const content = document.querySelector("#hq-cal-history:not([hidden]) .hq-cal-history-content");
    if (!content) return;
    const hadFocus = content.contains(document.activeElement);
    if (!undoHistory.length) {
      content.replaceChildren(h("p", { class: "hint", text: "Aucune modification à annuler." }));
      if (hadFocus) content.parentElement.querySelector("button")?.focus({ preventScroll: true });
      return;
    }
    const list = h("ol", { class: "hq-cal-history-list" });
    [...undoHistory].reverse().forEach(({ label, before, after }) => {
      const event = after || before;
      list.appendChild(h("li", {}, [h("strong", { text: label + " · " + event.title }),
        h("span", { class: "hint", text: whenText(event) })]));
    });
    const undo = h("button", { type: "button", class: "hq-cal-history-undo", text: "Annuler la dernière modification" });
    undo.disabled = undoBusy;
    undo.addEventListener("click", undoLatest);
    content.replaceChildren(list, undo);
    if (hadFocus && !undo.disabled) undo.focus({ preventScroll: true });
  }

  /* Tick an event off (or back): the check bursts, the day's ring fills. */
  async function toggleDone(item) {
    if (!item || item.read_only) return;
    if (isRecurring(item)) {
      if (typeof toast === "function") toast("Un événement récurrent ne se coche pas occurrence par occurrence.", "err");
      return;
    }
    const original = { ...item };
    const before = !!item.done;
    item.done = !before;
    state.burst = item.done ? item.id : "";
    renderKeep();
    if (item.done) {
      chime("done");
      buzz(14);
    }
    try {
      const saved = await saveCall(eventPayload(item), item.rev);
      if (saved?.event) offerUndo(item.done ? "Marqué comme fait" : "Marqué à faire", original, saved.event);
      refresh("keep");
    } catch (err) {
      item.done = before;
      renderKeep();
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
      refresh("keep");
    }
  }

  function eventPayload(source, over) {
    const item = Object.assign({}, seriesRecord(source), over || {});
    const payload = {
      title: item.title || "",
      all_day: !!item.all_day,
      start: item.start,
      end: item.end,
      category: categoryKey(item),
      notes: item.notes || "",
      location: item.location || "",
      scene_id: item.scene_id || "",
      action_id: item.action_id || "",
      device_id: item.device_id || "",
      reminders_min: Array.isArray(item.reminders_min) ? item.reminders_min : [],
      done: !!item.done,
    };
    if (item.id) payload.id = item.id;
    if (item.recurrence) payload.recurrence = item.recurrence;
    return payload;
  }

  async function quickSave(form) {
    if (form.classList.contains("is-saving")) return;
    const input = document.getElementById("hq-cal-quick-input");
    const text = input.value;
    const draft = quickDraft(text.trim());
    if (!draft) {
      shake(form);
      input.focus();
      return;
    }
    form.classList.add("is-saving");
    document.getElementById("hq-cal-quick-submit").disabled = true;
    if (preview.ghost) preview.ghost.classList.add("is-solid");
    try {
      const saved = await saveCall(eventPayload(draft), 0);
      if (input.value === text) input.value = "";
      paintQuick(true); // the solid ghost stays until the saved event lands in its place
      form.classList.remove("is-done");
      void form.offsetWidth; // restart the check animation
      form.classList.add("is-done");
      setTimeout(() => form.classList.remove("is-done"), 900);
      buzz(10);
      chime("save");
      const ev = saved && saved.event;
      if (ev) offerUndo("Ajouté", null, ev);
      landOn(ev);
    } catch (err) {
      shake(form);
      if (preview.ghost) preview.ghost.classList.remove("is-solid");
      if (typeof toast === "function") toast((err && err.message) || "Enregistrement impossible", "err");
    } finally {
      form.classList.remove("is-saving");
      document.getElementById("hq-cal-quick-submit").disabled = !quickDraft(input.value.trim());
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
  let quickForm = null;

  function mountQuick(root) {
    if (document.getElementById("hq-cal-quick")) return;
    const form = h("form", { class: "hq-cal-quick", id: "hq-cal-quick", autocomplete: "off" });
    const row = h("div", { class: "hq-cal-quick-row" });
    row.appendChild(h("button", { type: "submit", id: "hq-cal-quick-submit", class: "hq-cal-quick-plus",
      "aria-label": "Enregistrer la saisie rapide", disabled: "disabled" }));
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
    quickForm = form; // render() puts it back after the toolbar, before the grid
    root.appendChild(form);
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
    form.addEventListener("focusin", paintRecent);
    form.addEventListener("focusout", () => requestAnimationFrame(paintRecent));
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
      openEditor(Object.assign(blankDraft(state.anchor, 9), draft), input.value);
    });
  }

  /* ---- drag on the grid: create (empty hours), move (event), resize (bottom edge) ---- */
  function movable(item) {
    if (!item || item.read_only || item.all_day) return false;
    const a = itemStart(item);
    const b = itemEnd(item);
    return !!(a && b && sameDay(a, new Date(b.getTime() - 1))); // one day only
  }

  function minuteRaw(col, clientY) {
    const rect = col.getBoundingClientRect();
    return Math.max(0, Math.min(1440, ((clientY - rect.top) / Math.max(1, rect.height)) * 1440));
  }

  /* Edges a dragged event clicks onto: its neighbours' starts and ends, and the now line. */
  function magnetEdges(col, excludeId) {
    const day = parseLocalDateKey(col.dataset.colDay);
    if (!day) return [];
    const dayStart = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate());
    const edges = [];
    timedOn(day).forEach((item) => {
      if (item.id === excludeId) return;
      const a = itemStart(item);
      const b = itemEnd(item);
      if (a > dayStart) edges.push(a.getHours() * 60 + a.getMinutes());
      if (b < addLocalDays(dayStart, 1)) edges.push(b.getHours() * 60 + b.getMinutes());
    });
    const now = liveNow();
    if (now && sameDay(now, day)) edges.push(now.getHours() * 60 + now.getMinutes());
    return edges;
  }

  function magnetFor(col, a, b, excludeId, endOnly) {
    let best = null;
    magnetEdges(col, excludeId).forEach((edge) => {
      const ds = Math.abs(a - edge);
      if (!endOnly && ds <= MAGNET && (!best || ds < best.d)) best = { edge, start: true, d: ds };
      const de = Math.abs(b - edge);
      if (de <= MAGNET && (!best || de < best.d)) best = { edge, start: false, d: de };
    });
    return best;
  }

  /* Events the dragged range would overlap glow amber, and so does the ghost. */
  function markClash(col, a, b, excludeId) {
    const root = document.getElementById("hq-cal-app");
    root.querySelectorAll(".hq-cal-event.is-clash").forEach((el) => el.classList.remove("is-clash"));
    const day = parseLocalDateKey(col.dataset.colDay);
    let hit = false;
    if (day) {
      const dayStart = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate());
      timedOn(day).forEach((item) => {
        if (item.id === excludeId) return;
        const s0 = Math.max(0, (itemStart(item) - dayStart) / 60000);
        const e0 = Math.min(1440, (itemEnd(item) - dayStart) / 60000);
        if (a < e0 && b > s0) {
          hit = true;
          col.querySelectorAll('.hq-cal-event[data-id="' + item.id + '"]').forEach((el) => el.classList.add("is-clash"));
        }
      });
    }
    if (drag && drag.ghost) {
      drag.clash = hit;
      drag.ghost.classList.toggle("is-clash", hit);
    }
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

  /* The ghost: at [a, b]. With `land`, the ghost follows the finger freely and a soft footprint shows
     the snapped slot it will land in (its times are the ones shown). */
  function ghostAt(col, a, b, title, cat, land) {
    if (!drag.ghost) {
      drag.ghost = h("div", { class: "hq-cal-ghost " + (cat ? "cat-" + cat : "cat-hq"), "aria-hidden": "true" }, [
        h("span", { class: "hq-cal-ghost-time" }), h("span", { class: "hq-cal-ghost-title", text: title || "" }),
      ]);
    }
    if (drag.ghost.parentNode !== col) col.appendChild(drag.ghost);
    drag.ghost.style.top = (a / 1440) * 100 + "%";
    drag.ghost.style.height = (Math.max(SNAP_MIN, b - a) / 1440) * 100 + "%";
    const shown = land || [a, b];
    drag.ghost.firstChild.textContent = hhmm(shown[0]) + "–" + hhmm(shown[1]);
    if (land) {
      if (!drag.foot) drag.foot = h("div", { class: "hq-cal-footprint " + (cat ? "cat-" + cat : "cat-hq"), "aria-hidden": "true" });
      if (drag.foot.parentNode !== col) col.insertBefore(drag.foot, drag.ghost);
      drag.foot.style.top = (land[0] / 1440) * 100 + "%";
      drag.foot.style.height = (Math.max(SNAP_MIN, land[1] - land[0]) / 1440) * 100 + "%";
    }
  }

  function dragUpdate(x, y) {
    dragStep(x, y);
    updateDragReadout(x, y);
    const key = drag.range ? drag.range.join("-") + (drag.target ? drag.target.dataset.colDay : "") : "";
    if (key && key !== drag.lastKey) {
      if (drag.lastKey) {
        const magnetic = drag.magnet != null && drag.magnet !== drag.lastMagnet;
        chime(magnetic ? "magnet" : "snap");
        buzz(magnetic ? 14 : 4);
      }
      drag.lastKey = key;
    }
    drag.lastMagnet = drag.magnet;
    // Weight: the ghost leans with the hand's speed and straightens when it stops.
    if (drag.mode === "move" && drag.ghost) {
      const t = performance.now();
      if (drag.pt) {
        const dt = Math.max(1, t - drag.pt);
        const lean = Math.max(-6, Math.min(6, ((x - drag.px) / dt) * 9)) + Math.max(-2, Math.min(2, ((y - drag.py) / dt) * 1.6));
        drag.ghost.style.setProperty("--tilt", lean.toFixed(2) + "deg");
        clearTimeout(drag.tiltTimer);
        const ghost = drag.ghost;
        drag.tiltTimer = setTimeout(() => ghost.style.setProperty("--tilt", "0deg"), 90);
      }
      drag.pt = t;
      drag.px = x;
      drag.py = y;
    }
  }

  function updateDragReadout(x, y) {
    if (!drag.range || !drag.target) return;
    const day = parseLocalDateKey(drag.target.dataset.colDay);
    const [start, end] = drag.range;
    const valid = !!colAt(x, y);
    const label = drag.mode === "create" ? "Nouvel événement" : drag.mode === "resize" ? "Nouvelle durée" : "Nouvel horaire";
    const title = valid ? label + " · " + fmtShort(day) + " · " + hhmm(start) + "–" + hhmm(end) : "Relâche ici pour annuler";
    const hint = valid && drag.clash ? "Chevauchement avec un autre événement" : valid ? "Relâche pour appliquer" : "";
    if (drag.readout.firstChild.textContent !== title) drag.readout.firstChild.textContent = title;
    if (drag.readout.lastChild.textContent !== hint) drag.readout.lastChild.textContent = hint;
    drag.readout.classList.toggle("is-clash", valid && drag.clash);
  }

  function scheduleDragScroll(x, y) {
    drag.point = { x, y };
    if (drag.scrollFrame) return;
    const step = (now) => {
      if (!drag?.active) return;
      drag.scrollFrame = 0;
      const scroll = dayScroll();
      if (!scroll) return;
      const point = drag.point;
      const bounds = scroll.getBoundingClientRect();
      const top = Math.max(0, bounds.top + (scroll.querySelector(".hq-cal-week-top")?.offsetHeight || 0));
      const nav = window.innerWidth < 900 ? document.querySelector(".bottom-nav")?.getBoundingClientRect() : null;
      const bottom = Math.min(nav?.height ? nav.top : window.innerHeight, bounds.bottom);
      const inside = point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top - 8 && point.y <= bottom + 8;
      const speed = !inside ? 0 : point.y < top + 32 ? -7 : point.y > bottom - 32 ? 7 : 0;
      if (speed !== drag.scrollSpeed) {
        drag.scrollSpeed = speed;
        drag.scrollSince = now;
      }
      if (!speed) return;
      if (now - drag.scrollSince < 200) {
        drag.scrollFrame = requestAnimationFrame(step);
        return;
      }
      const before = scroll.scrollTop;
      scroll.scrollTop += speed;
      if (scroll.scrollTop !== before) {
        dragUpdate(point.x, point.y);
        drag.scrollFrame = requestAnimationFrame(step);
      }
    };
    drag.scrollFrame = requestAnimationFrame(step);
  }

  function dragStep(x, y) {
    drag.magnet = null;
    if (drag.mode === "create") {
      const now = minuteIn(drag.col, y);
      let a = Math.min(drag.anchorMin, now);
      let b = Math.max(drag.anchorMin + SNAP_MIN, now);
      if (now < drag.anchorMin) b = drag.anchorMin + SNAP_MIN;
      if (b - a < 30) b = Math.min(1440, a + 30);
      drag.range = [a, b];
      drag.target = drag.col;
      ghostAt(drag.col, a, b, "", "hq");
      markClash(drag.col, a, b, "");
    } else if (drag.mode === "move") {
      const col = colAt(x, y) || drag.target || drag.col;
      const dur = drag.endMin - drag.startMin;
      const fit = (v) => Math.max(0, Math.min(1440 - dur, v));
      const raw = fit(minuteRaw(col, y) - drag.grabOffset);
      let a = fit(Math.round(raw / SNAP_MIN) * SNAP_MIN);
      const pull = magnetFor(col, raw, raw + dur, drag.item.id, false);
      if (pull) {
        a = fit(Math.round(pull.start ? pull.edge : pull.edge - dur));
        drag.magnet = pull.edge;
      }
      drag.range = [a, a + dur];
      drag.target = col;
      ghostAt(col, raw, raw + dur, drag.item.title, drag.item.category, drag.range);
      markClash(col, a, a + dur, drag.item.id);
    } else {
      const rawEnd = minuteRaw(drag.col, y) - drag.grabOffset;
      let b = Math.min(1440, Math.max(drag.startMin + SNAP_MIN, Math.round(rawEnd / SNAP_MIN) * SNAP_MIN));
      const pull = magnetFor(drag.col, drag.startMin, rawEnd, drag.item.id, true);
      if (pull && pull.edge > drag.startMin) {
        b = Math.round(pull.edge);
        drag.magnet = pull.edge;
      }
      drag.range = [drag.startMin, b];
      drag.target = drag.col;
      ghostAt(drag.col, drag.startMin, b, drag.item.title, drag.item.category);
      markClash(drag.col, drag.startMin, b, drag.item.id);
    }
  }

  function dragActivate(x, y) {
    drag.active = true;
    document.getElementById("hq-cal-app").classList.add("is-dragging");
    if (drag.source) drag.source.classList.add("is-lifted");
    drag.readout = h("div", { class: "hq-cal-drag-readout", role: "status" }, [h("strong", {}), h("span", {})]);
    document.body.appendChild(drag.readout);
    buzz(12);
    chime("lift");
    dragUpdate(x, y);
  }

  function dragEnd(commit) {
    const finished = drag;
    drag = null;
    clearTimeout(finished.timer);
    clearTimeout(finished.tiltTimer);
    if (finished.scrollFrame) cancelAnimationFrame(finished.scrollFrame);
    finished.readout?.remove();
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
    const from = commit ? finished.ghost?.getBoundingClientRect() : null;
    if (finished.ghost) finished.ghost.remove();
    if (finished.foot) finished.foot.remove();
    if (root) root.querySelectorAll(".hq-cal-event.is-clash").forEach((el) => el.classList.remove("is-clash"));
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
    commitMove(finished.item, startKey, endKey, finished.mode === "resize" ? "Durée changée" : "Déplacé", from);
  }

  async function commitMove(item, startKey, endKey, label, from) {
    if (pendingMoves.has(item.id)) return;
    pendingMoves.set(item.id, { start: startKey, end: endKey, rev: item.rev });
    const before = { start: item.start, end: item.end };
    const snapshot = Object.assign({}, item);
    const payload = eventPayload(item, { start: startKey, end: endKey });
    item.start = startKey; // show it in place at once; the server answer confirms it
    item.end = endKey;
    dropEffects.set(item.id, { day: startKey.slice(0, 10), from, started: performance.now() });
    renderKeep();
    chime("drop");
    try {
      const saved = await saveCall(payload, item.rev);
      buzz(10);
      const ev = saved && saved.event;
      if (ev) {
        Object.assign(findItem(item.id) || item, ev);
        offerUndo(label || "Déplacé", snapshot, ev);
      }
      refresh("keep");
    } catch (err) {
      dropEffects.delete(item.id);
      const current = findItem(item.id);
      if (current && current.rev === item.rev) Object.assign(current, before);
      renderKeep();
      if (typeof toast === "function") toast((err && err.message) || "Déplacement impossible", "err");
      refresh("keep");
    } finally {
      pendingMoves.delete(item.id);
    }
  }

  function bindDrag(root) {
    const LONG_PRESS = 380;
    let chipPress = null;
    root.addEventListener("pointerdown", (ev) => {
      lastPoint = { x: ev.clientX, y: ev.clientY, t: Date.now() };
      if (drag || (ev.pointerType === "mouse" && ev.button !== 0) || ev.target.closest(".hq-sheet, .hq-cal-check")) return;
      const seriesChip = ev.target.closest(".hq-cal-chip.is-series");
      if (seriesChip) {
        // An all-day chip has no time grid to drag in; a normal tap still opens its sheet.
        chipPress = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, told: false };
        return;
      }
      const slot = ev.target.closest(".hq-cal-slot");
      const grip = ev.target.closest("[data-grip]");
      const eventBtn = ev.target.closest(".hq-cal-event.is-movable");
      let next = null;
      if (eventBtn) {
        const item = findItem(eventBtn.dataset.id);
        if (isRecurring(item)) {
          // A normal tap must still open the occurrence; an explicit grip press gets the reason.
          if (grip && typeof toast === "function") toast("Cette occurrence fait partie d’une série. Modifie la série depuis sa fiche.", "err");
          return;
        }
        const col = eventBtn.closest("[data-col-day]");
        if (!item || !col || !movable(item) || pendingMoves.has(item.id)) return;
        const startDate = itemStart(item);
        const endDate = itemEnd(item);
        const startMin = startDate.getHours() * 60 + startDate.getMinutes();
        const endMin = sameDay(startDate, endDate) ? endDate.getHours() * 60 + endDate.getMinutes() : 1440;
        const resize = !!grip && grip.dataset.grip === "end" && eventBtn.contains(grip);
        next = { mode: resize ? "resize" : "move", item, col, source: eventBtn, startMin, endMin,
          grabOffset: minuteRaw(col, ev.clientY) - (resize ? endMin : startMin) };
      } else if (slot) {
        const col = slot.closest("[data-col-day]");
        if (!col) return;
        next = { mode: "create", col, anchorMin: Math.floor(minuteIn(col, ev.clientY - 1) / SNAP_MIN) * SNAP_MIN };
      }
      if (!next) return;
      drag = Object.assign(next, { id: ev.pointerId, type: ev.pointerType, x0: ev.clientX, y0: ev.clientY, active: false, ghost: null });
      drag.directGrip = !!grip;
      if (ev.pointerType !== "mouse" && !grip) {
        // Touch: a press held still turns into a drag; moving first stays a scroll or a swipe.
        drag.timer = setTimeout(() => { if (drag && !drag.active) dragActivate(drag.x0, drag.y0); }, LONG_PRESS);
      }
    });
    window.addEventListener("pointermove", (ev) => {
      if (chipPress && ev.pointerId === chipPress.id) {
        if (!chipPress.told && Math.hypot(ev.clientX - chipPress.x, ev.clientY - chipPress.y) > 10) {
          chipPress.told = true;
          suppressClick();
          if (typeof toast === "function") toast("Cette occurrence fait partie d’une série. Modifie la série depuis sa fiche.", "err");
        }
        return;
      }
      if (!drag || ev.pointerId !== drag.id) return;
      const moved = Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0);
      if (!drag.active) {
        if ((drag.type === "mouse" || drag.directGrip) && moved > 5) {
          dragActivate(ev.clientX, ev.clientY);
          scheduleDragScroll(ev.clientX, ev.clientY);
        } else if (drag.type !== "mouse" && moved > 8) dragEnd(false); // it was a scroll
        return;
      }
      dragUpdate(ev.clientX, ev.clientY);
      scheduleDragScroll(ev.clientX, ev.clientY);
    });
    window.addEventListener("pointerup", (ev) => {
      if (chipPress && ev.pointerId === chipPress.id) { chipPress = null; return; }
      if (!drag || ev.pointerId !== drag.id) return;
      const target = !!colAt(ev.clientX, ev.clientY);
      if (drag.active && target) dragUpdate(ev.clientX, ev.clientY);
      dragEnd(target);
    });
    window.addEventListener("pointercancel", (ev) => {
      if (chipPress && ev.pointerId === chipPress.id) { chipPress = null; return; }
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
    const SKIP = ".hq-cal-bar, .hq-sheet, .hq-cal-row[data-id]:not(.is-schedule), .hq-cal-nextup, .hq-cal-weekstrip, [data-grip], .hq-cal-timeline-controls, .hq-cal-chip.is-series";
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
      const item = row && findItem(row.dataset.id);
      if (isRecurring(item)) return; // open the series from its detail sheet; never delete one occurrence by swipe
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

  /* Slide along the day strip: the day follows the finger, one tap per day. The strip's week is
     already loaded, so nothing waits on the network. */
  function bindScrub(root) {
    let sc = null;
    root.addEventListener("pointerdown", (ev) => {
      if (state.view !== "day" || !ev.target.closest(".hq-cal-weekstrip") || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      sc = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, active: false };
    });
    window.addEventListener("pointermove", (ev) => {
      if (!sc || ev.pointerId !== sc.id) return;
      const dx = ev.clientX - sc.x;
      const dy = ev.clientY - sc.y;
      if (!sc.active) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sc = null; return; }
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
        sc.active = true;
        scrubbing = true; // a slide redraws the day it passes over, unlike a click that must not move
      }
      const strip = root.querySelector(".hq-cal-weekstrip");
      if (!strip) return;
      const r = strip.getBoundingClientRect();
      const x = Math.max(r.left + 2, Math.min(r.right - 2, ev.clientX));
      const el = document.elementFromPoint(x, r.top + r.height / 2);
      const btn = el && el.closest(".hq-cal-weekstrip [data-day]");
      const day = btn && parseLocalDateKey(btn.dataset.day);
      if (!day || sameDay(day, state.anchor)) return;
      state.userMoved = true;
      state.anim = "scrub";
      state.anchor = day;
      renderKeep();
      chime("snap");
      buzz(5);
    });
    const end = (ev) => {
      if (!sc || ev.pointerId !== sc.id) return;
      if (sc.active) suppressClick();
      sc = null;
      scrubbing = false;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  /* Pull the hours down past their top (a touch that starts with them at the top): a rubber band offers
     « Aujourd'hui · maintenant »; let go past the line and it springs to today, at the current hour.
     The page still scrolls from anywhere outside the hours. */
  function bindPull(root) {
    let pl = null;
    const reset = (g) => {
      const calmNow = calm();
      g.scroll.style.transition = calmNow ? "" : "transform .45s var(--hq-spring)";
      g.scroll.style.transform = "";
      if (g.label) {
        g.label.style.opacity = "0";
        setTimeout(() => g.label.remove(), calmNow ? 0 : 300);
      }
      setTimeout(() => { g.scroll.style.transition = ""; }, calmNow ? 0 : 460);
    };
    root.addEventListener("touchstart", (ev) => {
      pl = null;
      if (ev.touches.length !== 1 || (state.view !== "day" && state.view !== "week")) return;
      if (ev.target.closest("[data-grip]")) return;
      const scroll = ev.target.closest(".hq-cal-stage .hq-cal-scroll");
      if (!scroll || scroll.scrollTop > 0) return;
      pl = { scroll, x: ev.touches[0].clientX, y: ev.touches[0].clientY, active: false, d: 0, label: null };
    }, { passive: true });
    root.addEventListener("touchmove", (ev) => {
      if (!pl || ev.touches.length !== 1 || (drag && drag.active) || (swipe && swipe.locked)) { pl = null; return; }
      const dy = ev.touches[0].clientY - pl.y;
      const dx = ev.touches[0].clientX - pl.x;
      if (!pl.active) {
        if (dy < -4 || Math.abs(dx) > 14) { pl = null; return; }
        if (dy < 10 || Math.abs(dx) > dy) return;
        pl.active = true;
        pl.label = h("div", { class: "hq-cal-pull", "aria-hidden": "true" }, [h("span", { class: "hq-cal-pull-arrow", text: "↓" }), h("span", { text: "Aujourd'hui · maintenant" })]);
        pl.label.style.top = pl.scroll.offsetTop + "px";
        root.appendChild(pl.label);
      }
      ev.preventDefault();
      pl.d = Math.min(130, (dy - 10) * 0.5);
      pl.scroll.style.transform = "translateY(" + pl.d.toFixed(1) + "px)";
      pl.label.style.opacity = String(Math.min(1, pl.d / 40));
      const armed = pl.d >= 64;
      if (armed !== pl.label.classList.contains("is-armed")) {
        pl.label.classList.toggle("is-armed", armed);
        if (armed) {
          buzz(8);
          chime("pull");
        }
      }
    }, { passive: false });
    const end = () => {
      const g = pl;
      pl = null;
      if (!g || !g.active) return;
      const armed = g.d >= 64;
      reset(g);
      if (armed) {
        suppressClick();
        goToday();
      }
    };
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", () => { if (pl && pl.active) reset(pl); pl = null; });
  }

  /* Long-press a day (strip, week head, month) to peek at it over a blurred calendar. Lift to close,
     or slide up to open it. */
  function bindPeek(root) {
    let pk = null;
    const SEL = ".hq-cal-weekstrip [data-day], .hq-cal-weekhead [data-day], .hq-cal-mcell .hq-cal-mday";
    root.addEventListener("pointerdown", (ev) => {
      const btn = ev.target.closest(SEL);
      if (!btn || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      pk = { btn, day: btn.dataset.day, id: ev.pointerId, x: ev.clientX, y: ev.clientY };
      pk.timer = setTimeout(() => { if (pk) pk.node = openPeek(pk.btn, pk.day); }, 450);
    });
    window.addEventListener("pointermove", (ev) => {
      if (!pk || ev.pointerId !== pk.id) return;
      const dy = ev.clientY - pk.y;
      if (!pk.node) {
        if (Math.hypot(ev.clientX - pk.x, dy) > 10) {
          clearTimeout(pk.timer);
          pk = null;
        }
        return;
      }
      pk.node.classList.toggle("is-go", dy < -40);
    });
    const end = (ev, ok) => {
      if (!pk || ev.pointerId !== pk.id) return;
      const g = pk;
      pk = null;
      clearTimeout(g.timer);
      if (!g.node) return;
      suppressClick();
      const go = ok && ev.clientY - g.y < -40;
      closePeek();
      if (go) {
        const day = parseLocalDateKey(g.day);
        if (!day) return;
        state.userMoved = true;
        state.anim = state.view === "day" ? (day < state.anchor ? "prev" : "next") : "view";
        state.anchor = day;
        state.view = "day";
        try { localStorage.setItem("hq_cal_view", "day"); } catch (_) {}
        refresh(sameDay(day, serverToday()) ? "snap" : undefined);
      }
    };
    window.addEventListener("pointerup", (ev) => end(ev, true));
    window.addEventListener("pointercancel", (ev) => end(ev, false));
  }

  function openPeek(btn, key) {
    const day = parseLocalDateKey(key);
    if (!day) return null;
    closePeek();
    const rows = visibleItems().filter((item) => overlapsDay(item, day))
      .sort((a, b) => (a.all_day === b.all_day ? String(a.start).localeCompare(String(b.start)) : a.all_day ? -1 : 1));
    const list = h("ul", { class: "hq-cal-peekday-list" });
    rows.slice(0, 8).forEach((item) => {
      list.appendChild(h("li", { class: catClass(item) + (item.done ? " is-done" : "") }, [
        h("time", { text: item.all_day ? "Journée" : spanLabel(item) }),
        h("strong", { text: item.title || "Sans titre" }),
      ]));
    });
    if (rows.length > 8) list.appendChild(h("li", { class: "hq-cal-peekday-more", text: "+" + (rows.length - 8) }));
    const card = h("div", { class: "hq-cal-peekday-card" }, [
      h("h3", { text: fmtDay(day) }),
      rows.length ? list : h("p", { class: "hint", text: state.categories.size ? "Aucun événement dans la sélection" : "Journée libre" }),
      h("p", { class: "hq-cal-peekday-hint", text: "↑ Glisse vers le haut pour ouvrir" }),
    ]);
    const node = h("div", { class: "hq-cal-peekday", role: "dialog", "aria-label": fmtDay(day) }, [card]);
    const r = btn.getBoundingClientRect();
    card.style.transformOrigin = Math.round(r.left + r.width / 2) + "px " + Math.round(r.top + r.height / 2) + "px";
    document.body.appendChild(node);
    const cr = card.getBoundingClientRect();
    card.style.transformOrigin = Math.round(r.left + r.width / 2 - cr.left) + "px " + Math.round(r.top + r.height / 2 - cr.top) + "px";
    peekOpen = node;
    buzz(12);
    chime("peek");
    return node;
  }

  function closePeek() {
    const node = peekOpen;
    peekOpen = null;
    if (!node) return;
    if (calm()) return node.remove();
    node.classList.add("is-closing");
    setTimeout(() => node.remove(), 180);
  }

  /* The pointerup of a swipe must not also count as a tap on the slot or event under the finger. */
  function suppressClick() {
    const clear = () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("click", stop, true);
    };
    const stop = (e) => {
      if (e.detail === 0 || e.target.closest?.(".hq-cal-haptic")) return;
      e.stopPropagation();
      e.preventDefault();
      clear();
    };
    // An intentional new press may follow the gesture immediately, for example to undo it.
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("click", stop, true);
    const timer = setTimeout(clear, 400);
  }

  function closeSheets() {
    sheetSeq += 1;
    if (morphBack()) return;
    CALENDAR_SHEETS.forEach((id) => {
      const node = document.getElementById(id);
      if (!node || node.hidden || node.classList.contains("is-closing")) return;
      const finish = () => {
        node.hidden = true;
        node.textContent = "";
        node.classList.remove("is-closing", "is-morphing");
      };
      node.classList.add("is-closing"); // shrink away, then hide (reopening cancels this)
      node.closeTimer = setTimeout(finish, 170);
    });
    releaseSheet();
    const opener = sheetOpener;
    sheetOpener = null;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    else if (opener?.matches(".hq-cal-options-trigger") && document.body.dataset.view === "calendrier") {
      document.querySelector(".hq-cal-options-trigger")?.focus({ preventScroll: true });
    }
  }

  function canMorph() {
    return typeof document.startViewTransition === "function" && !calm();
  }

  /** Marks HQ nav to skip a root view transition while a calendar morph runs. */
  function calViewTransition(update) {
    const w = typeof window !== "undefined" ? window : null;
    const release = () => {
      if (!w) return;
      w.hqViewTransitionHold = Math.max(0, (w.hqViewTransitionHold || 0) - 1);
    };
    if (w) w.hqViewTransitionHold = (w.hqViewTransitionHold || 0) + 1;
    try {
      const vt = document.startViewTransition(update);
      if (vt && vt.finished) vt.finished.finally(release);
      else release();
      return vt;
    } catch (err) {
      release();
      throw err;
    }
  }

  function openDetail(item, source) {
    selectEvent(item.id);
    const shape = source && source.closest("#hq-cal-app") ? source.querySelector(".hq-cal-face") || source : null;
    if (!shape || !canMorph()) {
      morphFrom = "";
      return buildDetail(item, true);
    }
    shape.style.viewTransitionName = "hq-cal-pick";
    let card = null;
    const seq = sheetSeq;
    try {
      const vt = calViewTransition(() => {
        shape.style.viewTransitionName = "";
        if (seq !== sheetSeq) return; // closed before it arrived
        card = buildDetail(item, false);
        card.style.viewTransitionName = "hq-cal-pick";
        morphFrom = item.id;
      });
      // a quick second tap skips this morph: its promises reject, which is expected, not an error
      vt.ready.catch(() => {});
      vt.finished.catch(() => {}).finally(() => { if (card) card.style.viewTransitionName = ""; });
    } catch (_) {
      shape.style.viewTransitionName = "";
      buildDetail(item, true);
    }
  }

  function buildDetail(item, animate) {
    const root = sheet("hq-cal-detail");
    const recurring = isRecurring(item);
    const card = h("div", { class: "hq-sheet-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-detail-title" });
    card.appendChild(h("h3", { id: "hq-cal-detail-title", text: item.title || "Sans titre" }));
    card.appendChild(h("p", { class: "hint", text: whenText(item) }));
    if (recurring) {
      card.appendChild(h("p", { class: "hint hq-cal-series-note", text: "Série · " + recurrenceLabel(item.recurrence) + ". Toute modification ou suppression s’applique à toutes les occurrences." }));
    }
    if (item.location) card.appendChild(h("p", { text: item.location }));
    if (item.notes) card.appendChild(h("p", { class: "hq-cal-note", text: item.notes }));
    if (item.read_only && item.source === "icloud") {
      card.appendChild(h("p", { class: "hint", text: "iCloud · lecture seule" }));
    } else if (item.read_only) {
      card.appendChild(h("p", { class: "hint", text: "Planification HQ · lecture seule. " + (WHEN[item.when] || "") }));
      card.appendChild(h("button", { type: "button", "data-sheet": "schedules", text: "Ouvrir les horaires" }));
    } else {
      const cat = categoryRows.find((row) => row[0] === item.category);
      if (cat) card.appendChild(h("p", { class: "hint", text: cat[1] }));
      if (canCheck(item, liveNow())) {
        card.appendChild(h("button", { type: "button", class: "secondary hq-cal-donebtn", "data-sheet": "done", "data-id": item.id,
          "aria-pressed": item.done ? "true" : "false", text: item.done ? "Fait ✓ — annuler" : "Marquer comme fait" }));
      }
      const editActions = h("div", { class: "hq-cal-detail-actions" });
      if (itemStart(item) && itemEnd(item)) {
        editActions.appendChild(h("button", { type: "button", "data-sheet": "schedule", text: recurring ? "Horaire de la série" : "Changer l’horaire" }));
      }
      editActions.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "edit", "data-id": item.id, text: recurring ? "Modifier la série" : "Modifier" }));
      card.appendChild(editActions);
      if (itemStart(item) && itemEnd(item) && !recurring) {
        card.appendChild(h("div", { class: "hq-cal-detail-actions" }, [
          h("button", { type: "button", class: "secondary", "data-sheet": "move", text: "Déplacer vers…" }),
          h("button", { type: "button", class: "secondary", "data-sheet": "duplicate", text: "Dupliquer" }),
        ]));
      }
      if (item.scene_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "run", "data-id": item.id, "data-target": "scene", text: "Lancer la scène" }));
      if (item.action_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "run", "data-id": item.id, "data-target": "action", text: "Lancer l'action" }));
      if (item.device_id) card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "device", "data-id": item.id, text: "Voir l'appareil" }));
      card.appendChild(h("button", { type: "button", class: "danger", "data-sheet": "delete", "data-id": item.id, text: recurring ? "Supprimer la série" : "Supprimer" }));
    }
    card.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "close", text: "Fermer" }));
    card.addEventListener("click", (ev) => onSheetClick(ev, item));
    card.tabIndex = -1;
    root.appendChild(card);
    if (animate) present(card);
    else root.classList.add("is-morphing"); // the view transition draws the card's arrival
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus();
    return card;
  }

  /* Closing the detail sheet of an event that grew out of the grid: it shrinks back into its block. */
  function morphBack() {
    const id = morphFrom;
    morphFrom = "";
    const detail = document.getElementById("hq-cal-detail");
    const editor = document.getElementById("hq-cal-editor");
    if (!id || !canMorph() || !detail || detail.hidden || (editor && !editor.hidden)) return false;
    const card = detail.querySelector(".hq-sheet-card");
    const block = document.querySelector('#hq-cal-app [data-id="' + id + '"]');
    const shape = block && (block.querySelector(".hq-cal-face") || block);
    if (!card || !shape) return false;
    card.style.viewTransitionName = "hq-cal-pick";
    const opener = sheetOpener;
    sheetOpener = null;
    releaseSheet();
    try {
      const vt = calViewTransition(() => {
        card.style.viewTransitionName = "";
        detail.hidden = true;
        detail.textContent = "";
        detail.classList.remove("is-closing", "is-morphing");
        shape.style.viewTransitionName = "hq-cal-pick";
      });
      vt.ready.catch(() => {});
      vt.finished.catch(() => {}).finally(() => { shape.style.viewTransitionName = ""; });
    } catch (_) {
      detail.hidden = true;
      detail.textContent = "";
    }
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    return true;
  }

  function whenText(item) {
    if (!item.start) return WHEN[item.when] || "Conditionnel";
    const start = itemStart(item);
    const end = itemEnd(item);
    if (!start || !end) return item.start;
    if (item.all_day) {
      const last = addLocalDays(end, -1);
      return "Toute la journée · " + fmtDay(start) + (sameDay(start, last) ? "" : " au " + fmtDay(last));
    }
    return fmtDay(start) + " · " + fmtTime(start) + " – " + (sameDay(start, end) ? "" : fmtDay(end) + " · ") + fmtTime(end);
  }

  function shiftedBounds(item, day) {
    const original = itemStart(item);
    const end = itemEnd(item);
    if (item.all_day) {
      const utc = value => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
      const days = (utc(end) - utc(original)) / 86400000;
      return { start: dateKey(day), end: dateKey(addLocalDays(day, days)) };
    }
    const start = makeLocalDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), original.getHours(), original.getMinutes());
    return { start: minuteKey(start), end: minuteKey(new Date(start.getTime() + (end - original))) };
  }

  function transferCard(title, item) {
    morphFrom = "";
    const root = sheet("hq-cal-transfer");
    const detail = document.getElementById("hq-cal-detail");
    if (detail) detail.hidden = true;
    const card = h("div", { class: "hq-sheet-card hq-cal-picker", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "hq-cal-transfer-title", tabindex: "-1" }, [
      h("h3", { id: "hq-cal-transfer-title", text: title }),
      h("p", { class: "hq-cal-schedule-name", text: item.title || "Sans titre" }),
    ]);
    root.appendChild(card);
    return card;
  }

  function focusTransfer(card) {
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    card.focus({ preventScroll: true });
  }

  function openDuplicate(item) {
    if (isRecurring(item)) {
      if (typeof toast === "function") toast("Duplique la série depuis sa fiche après l’avoir modifiée, pas une seule occurrence.", "err");
      return;
    }
    const card = transferCard("Dupliquer l’événement", item);
    const today = serverToday();
    const weekday = (itemStart(item).getDay() + 6) % 7;
    const choices = [
      ["Demain", addLocalDays(today, 1)],
      ["La semaine prochaine", addLocalDays(startOfLocalWeek(today), 7 + weekday)],
    ];
    for (const [label, day] of choices) {
      const button = h("button", { type: "button", class: "secondary hq-cal-choice" }, [
        h("strong", { text: label }), h("span", { text: fmtDay(day) }),
      ]);
      button.addEventListener("click", () => openEditor({
        title: item.title, location: item.location, notes: item.notes, category: item.category,
        all_day: item.all_day, ...shiftedBounds(item, day),
      }));
      card.appendChild(button);
    }
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    close.addEventListener("click", closeSheets);
    card.appendChild(close);
    focusTransfer(card);
  }

  function openMove(item) {
    if (isRecurring(item)) {
      if (typeof toast === "function") toast("Une occurrence ne se déplace pas seule. Modifie l’horaire de la série.", "err");
      return;
    }
    const card = transferCard("Déplacer vers une autre date", item);
    const start = itemStart(item);
    const duration = (itemEnd(item) - start) / 60000;
    const today = serverToday();
    const date = h("input", { type: "date", id: "hq-cal-move-date",
      value: dateKey(addLocalDays(start > today ? start : today, 1)) });
    const status = h("p", { class: "hint", role: "status" });
    const choices = h("div", { class: "hq-cal-free-slot-list", role: "group", "aria-label": "Créneaux" });
    const preview = h("p", { class: "hq-cal-move-preview", role: "status", hidden: true });
    const error = h("p", { class: "hq-cal-editor-error", role: "alert" });
    const confirm = h("button", { type: "button", text: "Confirmer le déplacement", disabled: true });
    const close = h("button", { type: "button", class: "secondary", text: "Fermer" });
    let generation = 0;
    let selected = null;
    let requestedDate = "";

    function choice(label, bounds, overlaps = false) {
      const button = h("button", { type: "button", class: "secondary hq-cal-choice", "aria-pressed": "false", text: label });
      button.addEventListener("click", () => {
        selected = bounds;
        const unchanged = bounds.start === item.start && bounds.end === item.end;
        for (const candidate of choices.querySelectorAll("button")) {
          candidate.setAttribute("aria-pressed", String(candidate === button));
        }
        preview.hidden = false;
        preview.textContent = whenText({ ...item, ...bounds }) + (unchanged ? " · Horaire actuel."
          : overlaps ? " · Chevauche un autre événement." : "");
        confirm.disabled = unchanged;
        error.textContent = "";
      });
      choices.appendChild(button);
      return button;
    }

    async function load() {
      const token = ++generation;
      requestedDate = date.value;
      const day = parseLocalDateKey(date.value);
      selected = null;
      confirm.disabled = true;
      preview.hidden = true;
      choices.replaceChildren();
      error.textContent = "";
      if (!day) {
        status.textContent = "Choisis une date.";
        return;
      }
      const shifted = shiftedBounds(item, day);
      if (item.all_day) {
        status.textContent = "";
        choice("Garder la durée", shifted).click();
        return;
      }
      if (duration > 14 * 60) {
        status.textContent = "L’événement dure plus que la plage de recherche de 8 h à 22 h.";
        choice("Garder l’heure · " + fmtTime(itemStart({ ...item, ...shifted })), shifted).click();
        return;
      }
      status.textContent = "Recherche des créneaux…";
      const last = itemEnd({ ...item, ...shifted });
      const queryEnd = dateKey(addLocalDays(last, 1));
      try {
        const query = new URLSearchParams({ from: dateKey(day), to: queryEnd });
        const data = await api("/api/calendar?" + query);
        if (token !== generation || !card.isConnected || card.parentElement.hidden) return;
        const events = data.items || [];
        const slots = freeSlots(day, duration, events, item.id);
        status.textContent = slots.length ? "Choisis un créneau pour voir le nouvel horaire."
          : "Aucun créneau de cette durée entre 8 h et 22 h.";
        for (const time of slots) {
          const end = new Date(time.getTime() + duration * 60000);
          choice(fmtTime(time) + " – " + fmtTime(end), { start: minuteKey(time), end: minuteKey(end) });
        }
        if (!slots.some(time => minuteKey(time) === shifted.start)) {
          const from = itemStart({ ...item, ...shifted });
          const conflict = events.some(event => event.id !== item.id && !event.all_day && itemStart(event) < last && itemEnd(event) > from);
          choice("Garder l’heure · " + fmtTime(from), shifted, conflict);
        }
      } catch (err) {
        if (token !== generation || !card.isConnected || card.parentElement.hidden) return;
        status.textContent = err?.message || "Créneaux indisponibles.";
        const retry = h("button", { type: "button", class: "secondary", text: "Réessayer" });
        retry.addEventListener("click", load);
        choices.appendChild(retry);
      }
    }

    const dateChanged = () => { if (date.value !== requestedDate) load(); };
    date.addEventListener("input", dateChanged);
    date.addEventListener("change", dateChanged);
    close.addEventListener("click", closeSheets);
    confirm.addEventListener("click", async () => {
      if (!selected || confirm.disabled) return;
      confirm.disabled = true;
      date.disabled = true;
      choices.inert = true;
      try {
        const saved = (await saveCall(eventPayload(item, selected), item.rev)).event;
        if (card.isConnected && !card.parentElement.classList.contains("is-closing")) closeSheets();
        offerUndo("Déplacé", item, saved);
        buzz(10);
        chime("save");
        await landOn(saved);
      } catch (err) {
        error.textContent = err?.message || "Déplacement impossible.";
      } finally {
        confirm.disabled = false;
        date.disabled = false;
        choices.inert = false;
      }
    });
    card.append(field("Date de destination", date), status, choices, preview, error,
      h("div", { class: "hq-cal-picker-actions" }, [confirm, close]));
    focusTransfer(card);
    load();
  }

  function onSheetClick(ev, item) {
    const button = ev.target.closest("[data-sheet]");
    if (!button) return;
    const kind = button.dataset.sheet;
    if (kind === "close") closeSheets();
    else if (kind === "edit") openEditor(item);
    else if (kind === "schedule") openEditor(item, "", "schedule");
    else if (kind === "move") openMove(item);
    else if (kind === "duplicate") openDuplicate(item);
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
        body: JSON.stringify({ id: seriesRecord(item).id, target: target }),
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

  /* One delete path for every event: remove immediately, keep the same Annuler offer, and
     put the keyboard cursor back on the day when the trigger no longer exists. */
  async function removeEvent(item, quiet) {
    const recurring = isRecurring(item);
    const original = { ...seriesRecord(item) };
    const at = itemStart(item);
    const day = at ? parseLocalDateKey(dateKey(at)) : state.anchor;
    const hour = at ? at.getHours() : 9;
    try {
      await deleteCall(original.id, original.rev);
      closeSheets();
      if (!quiet) {
        chime("delete");
        buzz(10);
      }
      offerUndo(recurring ? "Série supprimée" : "Supprimé", original, null);
      await refresh("keep");
      // The chip that opened the sheet is gone: land the keyboard cursor on its day instead.
      if (!quiet) focusCalendarDate(day, hour);
      announce((recurring ? "Série supprimée" : "Événement supprimé") + " : " + (original.title || "Sans titre")
        + " · Ctrl+Z pour annuler");
    } catch (err) {
      if (typeof toast === "function") toast((err && err.message) || "Suppression impossible", "err");
      refresh("keep");
    }
  }

  /* The editor shows what most events need (title, when, category, place); notes, scene, action,
     device and reminders wait under "Plus d'options". Duration chips set the end in one tap. */
  function openEditor(item, quickText = "", mode = "full") {
    const scheduleOnly = mode === "schedule";
    morphFrom = ""; // the editor closes the ordinary way
    const sourceStart = item && item.start;
    item = seriesRecord(item);
    const recurringEdit = !!(item && item.recurrence);
    const original = Object.assign({}, item); // what Annuler goes back to
    const root = sheet("hq-cal-editor");
    for (const id of ["hq-cal-detail", "hq-cal-free-slots", "hq-cal-transfer"]) {
      const source = document.getElementById(id);
      if (source) source.hidden = true;
    }
    const card = h("form", { class: "hq-sheet-card hq-cal-editor", role: "dialog", "aria-modal": "true", "aria-labelledby": "hq-cal-editor-title" });
    const heading = scheduleOnly ? (recurringEdit ? "Horaire de la série" : "Changer l’horaire")
      : recurringEdit ? "Modifier la série" : item.id ? "Modifier" : "Nouvel événement";
    card.appendChild(h("h3", { id: "hq-cal-editor-title", text: heading }));
    if (recurringEdit) card.appendChild(h("p", { class: "hint hq-cal-series-note", text: "Toutes les occurrences de cette série seront modifiées." }));
    const title = h("input", { id: "hq-cal-title", class: "hq-cal-title-input", name: "title", maxlength: "120", required: "required",
      placeholder: "Titre", "aria-label": "Titre", autocomplete: "off", value: item.title || "" });
    card.appendChild(scheduleOnly ? h("p", { class: "hq-cal-schedule-name", text: item.title || "Sans titre" }) : title);
    const allDay = h("input", { id: "cal-all-day", type: "checkbox" });
    allDay.checked = !!item.all_day;
    const start = h("input", { id: "cal-start", required: "required", "aria-label": "Début" });
    const end = h("input", { id: "cal-end", required: "required", "aria-label": "Fin" });
    const startField = field("Début", start);
    const endField = field("Fin", end);
    let previousStart = null;
    let hours = ["09:00", "10:00"];
    let endsAtMidnight = false;
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
    function setBounds(first, last) {
      const day = allDay.checked;
      start.type = day ? "date" : "datetime-local";
      end.type = day ? "date" : "datetime-local";
      start.value = first;
      end.value = last;
      startField.querySelector("label").textContent = day ? "Premier jour" : "Début";
      endField.querySelector("label").textContent = day ? "Dernier jour" : "Fin";
      start.setAttribute("aria-label", day ? "Premier jour" : "Début");
      end.setAttribute("aria-label", day ? "Dernier jour" : "Fin");
      previousStart = parseLocalDateTime(first);
      markDuration();
    }
    allDay.addEventListener("change", () => {
      if (allDay.checked) {
        const first = parseLocalDateTime(start.value);
        const last = parseLocalDateTime(end.value);
        if (first && last) hours = [minuteKey(first).slice(11), minuteKey(last).slice(11)];
        endsAtMidnight = !!(first && last && last > first && hours[1] === "00:00");
        const firstDay = dateKey(first || state.anchor);
        const lastDay = last && first && last > first ? dateKey(new Date(last.getTime() - 1)) : firstDay;
        setBounds(firstDay, lastDay);
      } else {
        const firstDay = parseLocalDateKey(start.value) || state.anchor || serverToday();
        const first = parseLocalDateTime(dateKey(firstDay) + "T" + hours[0]);
        const lastDay = parseLocalDateKey(end.value) || first;
        const last = parseLocalDateTime(dateKey(endsAtMidnight ? addLocalDays(lastDay, 1) : lastDay) + "T" + hours[1]);
        setBounds(minuteKey(first), minuteKey(last && last > first ? last : new Date(first.getTime() + 3600000)));
      }
    });
    function startChanged() {
      if (allDay.checked) {
        if (start.value && (!end.value || end.value < start.value)) end.value = start.value;
        return;
      }
      const next = parseLocalDateTime(start.value);
      if (!next) return;
      const last = parseLocalDateTime(end.value);
      if (previousStart && last && last > previousStart) {
        end.value = minuteKey(new Date(next.getTime() + (last - previousStart)));
      }
      previousStart = next;
      markDuration();
    }
    for (const event of ["input", "change"]) {
      start.addEventListener(event, startChanged);
      end.addEventListener(event, markDuration);
    }
    durations.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-mins]");
      const a = parseLocalDateTime(start.value);
      if (!btn || !a) return;
      end.value = toLocalInput(minuteKey(new Date(a.getTime() + Number(btn.dataset.mins) * 60000)), false);
      markDuration();
    });
    if (allDay.checked) {
      const exclusive = parseLocalDateKey(item.end);
      setBounds(item.start, exclusive ? dateKey(addLocalDays(exclusive, -1)) : item.start);
    } else setBounds(toLocalInput(item.start, false), toLocalInput(item.end, false));
    const allWrap = h("label", { class: "hq-cal-switch" });
    allWrap.appendChild(allDay);
    allWrap.appendChild(h("span", { text: "Toute la journée" }));
    if (!scheduleOnly) card.appendChild(allWrap);
    else if (!item.all_day) card.appendChild(h("p", { class: "hint", text: "Si tu changes le début, la durée reste la même." }));
    card.append(h("div", { class: "hq-cal-when" }, [startField, endField]), durations);
    const repeat = scheduleOnly ? null : appendRecurrence(card, item, start);
    const category = scheduleOnly ? null : appendEditorDetails(card, item);
    const error = h("p", { class: "hq-cal-editor-error", role: "alert" });
    card.appendChild(error);
    const row = h("div", { class: "hq-cal-sheet-actions" });
    const submit = h("button", { type: "submit", "aria-keyshortcuts": "Control+Enter Meta+Enter", text: "Enregistrer" });
    row.appendChild(submit);
    row.appendChild(h("button", { type: "button", class: "secondary", "data-sheet": "close", text: "Fermer" }));
    card.appendChild(row);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-sheet='close']")) closeSheets();
    });
    card.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!submit.disabled) saveEditor(item, { card, allDay, start, end, category, repeat, original, error, submit, quickText, scheduleOnly, sourceStart });
    });
    // Ctrl / Cmd + Entrée saves from anywhere in the form, so the footer never has to be scrolled to.
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !submit.disabled) {
        ev.preventDefault();
        saveEditor(item, { card, allDay, start, end, category, repeat, original, error, submit, quickText, scheduleOnly, sourceStart });
      }
    });
    card.addEventListener("input", () => { error.textContent = ""; });
    root.appendChild(card);
    present(card);
    releaseSheet();
    sheetRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    (scheduleOnly ? start : title).focus();
  }

  /* Recurrence is a small structured pattern, not a sentence parser: frequency,
     optional weekdays for weekly, and one end condition. */
  function appendRecurrence(card, item, startInput) {
    const initial = item.recurrence || null;
    const chosen = new Set((initial && initial.weekdays) || []);
    const repeat = h("select", { id: "cal-repeat", "aria-label": "Répétition" });
    [["", "Ne se répète pas"], ["daily", "Chaque jour"], ["weekdays", "Jours ouvrés (lun.–ven.)"],
      ["weekly", "Chaque semaine"]].forEach(([value, label]) => {
      const option = h("option", { value: value, text: label });
      if ((initial?.frequency || "") === value) option.selected = true;
      repeat.appendChild(option);
    });
    const days = h("div", { class: "hq-cal-repeat-days", role: "group", "aria-label": "Jours de la semaine" });
    DOW.forEach((label, index) => {
      const button = h("button", { type: "button", class: "hq-cal-repeat-day", "data-day": String(index),
        "aria-pressed": chosen.has(index) ? "true" : "false", "aria-label": label, title: label, text: label });
      button.addEventListener("click", () => {
        if (chosen.has(index)) chosen.delete(index);
        else chosen.add(index);
        button.setAttribute("aria-pressed", chosen.has(index) ? "true" : "false");
        sync();
      });
      days.appendChild(button);
    });
    const end = h("div", { class: "hq-cal-repeat-end" });
    const endMode = h("select", { id: "cal-repeat-end", "aria-label": "Fin de la répétition" });
    [["never", "Ne se termine jamais"], ["until", "Jusqu’à une date"], ["count", "Après un nombre d’occurrences"]].forEach(([value, label]) => {
      const option = h("option", { value: value, text: label });
      if ((initial?.count ? "count" : initial?.until ? "until" : "never") === value) option.selected = true;
      endMode.appendChild(option);
    });
    const until = h("input", { id: "cal-repeat-until", type: "date", "aria-label": "Date de fin de la répétition" });
    if (initial?.until) until.value = initial.until;
    const count = h("input", { id: "cal-repeat-count", type: "number", min: "1", max: "1000", step: "1",
      inputmode: "numeric", "aria-label": "Nombre d’occurrences", value: initial?.count ? String(initial.count) : "10" });
    const untilWrap = field("Dernière occurrence", until);
    const countWrap = field("Nombre d’occurrences", count);
    const note = h("p", { class: "hint hq-cal-repeat-note", "aria-live": "polite" });
    const endModeField = field("Fin de la série", endMode);
    const startDay = () => String(startInput.value || "").slice(0, 10);
    let syncing = false;
    function sync() {
      if (syncing) return;
      syncing = true;
      const weekly = repeat.value === "weekly";
      if (weekly && !chosen.size) {
        const start = parseLocalDateTime(startInput.value) || parseLocalDateKey(startDay());
        if (start) {
          const weekday = (start.getDay() + 6) % 7;
          chosen.add(weekday);
          const button = days.querySelector('[data-day="' + weekday + '"]');
          if (button) button.setAttribute("aria-pressed", "true");
        }
      }
      days.hidden = !weekly;
      end.hidden = !repeat.value;
      const mode = endMode.value;
      untilWrap.hidden = mode !== "until";
      countWrap.hidden = mode !== "count";
      if (mode === "until") {
        until.min = startDay();
        if (!until.value) until.value = startDay();
      }
      note.hidden = !repeat.value;
      if (repeat.value) {
        const sample = { frequency: repeat.value, weekdays: [...chosen].sort((a, b) => a - b), until: null, count: null };
        if (mode === "until" && until.value) sample.until = until.value;
        if (mode === "count") sample.count = Number(count.value) || null;
        note.textContent = "Série : " + recurrenceLabel(sample) + ". La première occurrence compte.";
      }
      syncing = false;
    }
    repeat.addEventListener("change", sync);
    endMode.addEventListener("change", sync);
    until.addEventListener("input", sync);
    count.addEventListener("input", sync);
    startInput.addEventListener("input", sync);
    startInput.addEventListener("change", sync);
    card.append(field("Répétition", repeat), days, end);
    end.append(endModeField, untilWrap, countWrap);
    card.appendChild(note);
    sync();
    return {
      validate() {
        if (!repeat.value) return { ok: true, value: null };
        if (repeat.value === "weekly" && !chosen.size) {
          return { ok: false, message: "Choisis au moins un jour pour la répétition hebdomadaire." };
        }
        const start = startDay();
        if (endMode.value === "until") {
          if (!until.value) return { ok: false, message: "Choisis une date de fin de série." };
          if (until.value < start) return { ok: false, message: "La fin de la série doit suivre son début." };
        }
        let number = null;
        if (endMode.value === "count") {
          number = Number(count.value);
          if (!Number.isInteger(number) || number < 1 || number > 1000) {
            return { ok: false, message: "Choisis entre 1 et 1000 occurrences." };
          }
        }
        return { ok: true, value: {
          frequency: repeat.value,
          weekdays: repeat.value === "weekly" ? [...chosen].sort((a, b) => a - b) : [],
          until: endMode.value === "until" ? until.value : null,
          count: number,
        } };
      },
    };
  }

  function appendEditorDetails(card, item) {
    const initialCategory = categoryKey(item);
    const category = h("input", { id: "cal-category", type: "hidden", value: initialCategory });
    const cats = h("div", { class: "hq-cal-cats", role: "radiogroup", "aria-label": "Catégorie" });
    categoryRows.forEach(([id, label]) => {
      cats.appendChild(h("button", { type: "button", role: "radio", class: "hq-cal-catbtn cat-" + id, "data-cat": id,
        "aria-checked": initialCategory === id ? "true" : "false", text: label }));
    });
    cats.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-cat]");
      if (!btn) return;
      category.value = btn.dataset.cat;
      cats.querySelectorAll("[data-cat]").forEach((b) => b.setAttribute("aria-checked", b === btn ? "true" : "false"));
    });
    card.append(h("span", { class: "hq-cal-field-label", text: "Catégorie" }), cats);
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
    card.appendChild(more);
    return category;
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
    return h("div", { class: "field" }, [h(control.id ? "label" : "span", { for: control.id || null, class: "hq-cal-field-label", text: label }), control]);
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
    box.addEventListener("change", event => {
      const checked = box.querySelectorAll("input:checked");
      if (checked.length > 3) {
        event.target.checked = false;
        if (typeof toast === "function") toast("Trois rappels maximum", "err");
      }
    });
    return field("Rappels", box);
  }

  async function saveEditor(item, refs) {
    const { card, submit, error, repeat, sourceStart } = refs;
    const value = id => card.querySelector("#" + id).value;
    const reminders = [...card.querySelectorAll(".hq-reminders input:checked")].map(input => Number(input.value));
    const allDay = refs.allDay.checked;
    const parse = allDay ? parseLocalDateKey : parseLocalDateTime;
    const start = parse(normalizeBound(refs.start.value, allDay));
    const end = parse(normalizeBound(refs.end.value, allDay));
    if (!start || !end || (allDay ? end < start : end <= start)) {
      error.textContent = allDay ? "Le dernier jour doit être le premier jour ou une date ultérieure." : "La fin doit être après le début.";
      refs.end.focus();
      return;
    }
    const bounds = {
      all_day: allDay,
      start: allDay ? dateKey(start) : minuteKey(start),
      end: allDay ? dateKey(addLocalDays(end, 1)) : minuteKey(end),
    };
    let recurrence = null;
    if (repeat) {
      const checked = repeat.validate();
      if (!checked.ok) {
        error.textContent = checked.message;
        card.querySelector("#cal-repeat")?.focus();
        return;
      }
      recurrence = checked.value;
    }
    const payload = refs.scheduleOnly ? eventPayload(item, bounds) : {
      ...bounds,
      title: value("hq-cal-title"),
      category: refs.category.value,
      notes: value("cal-notes"),
      location: value("cal-location"),
      scene_id: value("cal-scene"),
      action_id: value("cal-action"),
      device_id: value("cal-device"),
      reminders_min: reminders,
      done: !!item.done,
    };
    if (!refs.scheduleOnly && recurrence) payload.recurrence = recurrence;
    if (item.id) payload.id = item.id;
    if (!payload.title.trim()) {
      error.textContent = "Titre requis.";
      card.querySelector("#hq-cal-title")?.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Enregistrement…";
    card.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      const saved = await saveCall(payload, item.id ? item.rev : 0);
      if (card.isConnected && !card.parentElement.classList.contains("is-closing")) closeSheets();
      const quick = document.getElementById("hq-cal-quick-input");
      if (refs.quickText && quick && quick.value === refs.quickText) {
        quick.value = "";
        paintQuick();
      }
      buzz(10);
      chime("save");
      const ev = saved && saved.event;
      const original = refs.original || {};
      const label = refs.scheduleOnly ? (original.recurrence ? "Horaire de la série modifié" : "Horaire modifié")
        : original.recurrence ? "Série modifiée" : original.id ? "Modifié" : "Ajouté";
      if (ev) offerUndo(label, original.id ? original : null, ev);
      const focusHint = item.recurrence && sourceStart ? sourceStart : "";
      await landOn(ev, focusHint);
      if (ev) focusSavedEvent(ev, focusHint || ev.start);
      announce(label + " : " + ((refs.scheduleOnly ? item.title : payload.title) || "Sans titre"));
    } catch (err) {
      error.textContent = err?.message || "Enregistrement impossible.";
    } finally {
      submit.disabled = false;
      submit.textContent = "Enregistrer";
      card.removeAttribute("aria-busy");
    }
  }

  function onKey(ev) {
    if (ev.key !== "Escape") {
      navKey(ev);
      return;
    }
    const open = CALENDAR_SHEETS.some((id) => {
      const node = document.getElementById(id);
      return node && !node.hidden;
    });
    if (!open) {
      if (!state.optionsOpen) return;
      setOptionsOpen(false);
      document.querySelector("#hq-cal-app .hq-cal-options-trigger")?.focus();
      ev.stopPropagation();
      return;
    }
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
    if (today.length) {
      const list = h("ul", { class: "hq-list" });
      today.slice(0, 5).forEach((item) => {
        const li = h("li", { class: item.category ? "cat-" + item.category : "cat-other" });
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

  /* The owner's own next event first; an HQ schedule only when there is none. */
  function nextOf(cal) {
    const mine = cal && cal.next_mine;
    const start = mine && (mine.all_day ? parseLocalDateKey(mine.start) : parseLocalDateTime(mine.start));
    const now = cal && parseLocalDateTime(cal.server_now);
    if (mine && start && (!now || start >= now)) return mine;
    return (cal && cal.next) || null;
  }

  function nextParts(cal) {
    const next = nextOf(cal);
    if (!next) return { when: "", title: (cal && cal.today && cal.today.length) ? "" : "Rien de prévu aujourd’hui." };
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
    if (!parts.title) return;
    const next = nextOf(cal);
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
    if (window.hqPaintHomeNext) window.hqPaintHomeNext(cal); // Accueil's countdown card (hq-home.js)
  };

  function boot() {
    const root = document.getElementById("hq-cal-app");
    if (!root) return;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Calendrier");
    if (!document.getElementById("hq-cal-live")) {
      document.body.appendChild(h("p", { id: "hq-cal-live", class: "visually-hidden", role: "status",
        "aria-live": "polite", "aria-atomic": "true" }));
    }
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
      const categories = JSON.parse(localStorage.getItem("hq_cal_categories"));
      if (Array.isArray(categories)) state.categories = new Set(categories.filter(key => typeof key === "string"));
    } catch (_) {}
    setZoom(state.zoom);
    state.anchor = todayLocal();
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onGridKey);
    document.addEventListener("keydown", () => { keyboardIntent = true; }, true);
    document.addEventListener("pointerdown", () => { keyboardIntent = false; }, true);
    // A rebuild never happens under a held pointer: the click it was about to become would vanish.
    root.addEventListener("pointerdown", (ev) => { pressed.add(ev.pointerId); pressAt = performance.now(); }, true);
    window.addEventListener("pointerup", releasePress, true);
    window.addEventListener("pointercancel", releasePress, true);
    mountQuick(root);
    bindDrag(root);
    bindSwipe(root);
    bindPinch(root);
    bindRowSwipe(root);
    bindScrub(root);
    bindPull(root);
    bindPeek(root);
    setInterval(() => {
      if (document.hidden || !document.body || document.body.dataset.view !== "calendrier") return;
      paintLive();
    }, 20000);
    const narrow = window.matchMedia("(max-width: 600px)");
    const onWidth = () => { if (state.data && state.view === "week") refresh(); };
    if (narrow.addEventListener) narrow.addEventListener("change", onWidth);
    else if (narrow.addListener) narrow.addListener(onWidth);
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", event => {
      if (state.optionsOpen && !event.target.closest(".hq-cal-options")) setOptionsOpen(false);
    });
    const openHome = document.getElementById("hq-cal-open");
    if (openHome) {
      openHome.addEventListener("click", () => {
        if (typeof setView === "function") setView("calendrier");
      });
    }
    window.hqCalendarShow = function () {
      refresh("start", true);
    };
    // Global search: open the day of an event found in the palette (same as picking that day).
    window.hqCalendarOpenDay = function (key) {
      const day = parseLocalDateKey(key);
      if (!day) return;
      const hour = focusedHour(); // the palette restores focus to the cell it was opened from
      state.userMoved = true;
      state.anchor = day;
      state.view = "day";
      if (keyboardIntent) pendingGridFocus = { day, hour: Number.isInteger(hour) ? hour : 9 };
      refresh(sameDay(day, serverToday()) ? "snap" : undefined);
    };
    if (document.body && document.body.dataset.view === "calendrier") window.hqCalendarShow();
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
