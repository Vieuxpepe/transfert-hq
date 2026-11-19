/* Transfert HQ — status badges on the nav (assets/hq-nav-badges.js).
   Four sources, each one an endpoint the app already speaks, nothing new on the server:
     · Carnet     GET /api/carnet?meta=1     pages changed since this device last opened the notebook
     · Calendrier GET /api/calendar?from=…   events on today's calendar (read-only activity excluded)
     · Forge      GET /api/forge/jobs        jobs the GPU is actually working on right now
     · Sécurité   GET /api/securia/status    recent authentication failures (the chip's own count)
   Opening Carnet or Calendrier clears that day's badge; Forge and Sécurité are live state and clear by themselves.
   Under 900px, where the bar
   only shows five spaces, the spaces that are not in the bar collapse into one dot on Plus — the phone's "something
   wants you" cue. The Calendrier button's tooltip (data-help, the app's own bubble — never title) names the next event
   of the day, so the badge says something is waiting and the tooltip says what. */
(function () {
  "use strict";

  var REFRESH_MS = 60 * 1000;
  var SEEN_KEY = "hq_nav_seen_v1";
  var BAR = ["accueil", "carnet", "calendrier", "fichiers", "plus"];
  var ACTIVE = ["queued", "starting", "generating", "saving"];
  var nav = document.querySelector(".bottom-nav");
  if (!nav) return;

  var counts = { carnet: 0, calendrier: 0, forge: 0, securite: 0 };
  // The Calendrier tooltip answers "what is coming" on hover: the app's own tooltip reads data-help live, so the
  // next event is written there and the static description is put back when the day is empty.
  var nextEvent = null;
  var calendrierHelp = "";
  var busy = false;
  var timer = 0;

  function isAdmin() {
    return document.body.classList.contains("session-admin");
  }

  function seenAt(view) {
    try {
      var map = JSON.parse(localStorage.getItem(SEEN_KEY));
      return (map && typeof map === "object" && map[view]) || 0;
    } catch (_) {
      return 0;
    }
  }

  function markSeen(view) {
    if (!view) return;
    try {
      var map = JSON.parse(localStorage.getItem(SEEN_KEY));
      if (!map || typeof map !== "object") map = {};
      map[view] = Date.now() / 1000;
      localStorage.setItem(SEEN_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function getJSON(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var guard = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : 0;
    return fetch(url, { credentials: "same-origin", cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        if (guard) clearTimeout(guard);
        return data;
      });
  }

  // Carnet: a page counts as unread when it changed after the last time this browser opened the notebook.
  function carnetUnread(data) {
    var pages = data && Array.isArray(data.pages) ? data.pages : [];
    var since = seenAt("carnet");
    var n = 0;
    for (var i = 0; i < pages.length; i += 1) {
      var page = pages[i];
      if (!page || page.deleted_at) continue;
      if (typeof page.updated_at !== "number") continue;
      if (page.updated_at > since) n += 1;
    }
    return n;
  }

  function dayKey(date) {
    var month = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
  }

  // Calendrier: the endpoint is asked for exactly today → tomorrow (fin exclue), so every item it returns is today's.
  // Read-only activity rows are the calendar's own log lines, not things on the agenda. Like Carnet, the badge is
  // "things I have not looked at": opening the calendar today clears it until the next day.
  function calendarToday(data) {
    var midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    if (seenAt("calendrier") >= midnight.getTime() / 1000) return 0;
    var items = data && Array.isArray(data.items) ? data.items : [];
    var n = 0;
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!item || item.read_only) continue;
      n += 1;
    }
    return n;
  }

  // "2026-11-14T14:30" is local wall time, not UTC: build the Date by hand so a date-only value cannot slip a day.
  function startInfo(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ""));
    if (!m) return null;
    return {
      timed: m[4] != null,
      at: new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0).getTime(),
      hour: m[4] ? +m[4] : 0,
      minute: m[5] ? +m[5] : 0,
    };
  }

  // The next event still ahead today; when the only things left are all-day entries, name the first one without a time.
  function nextToday(data) {
    var items = data && Array.isArray(data.items) ? data.items : [];
    var now = Date.now();
    var best = null;
    var allDay = null;
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!item || item.read_only) continue;
      var info = startInfo(item.start);
      if (!info) continue;
      var row = { at: info.at, timed: info.timed, hour: info.hour, minute: info.minute, title: String(item.title || "").trim() };
      if (!info.timed) {
        if (!allDay) allDay = row;
        continue;
      }
      if (info.at < now) continue;
      if (!best || info.at < best.at) best = row;
    }
    return best || allDay;
  }

  function nextLabel(event) {
    var name = event.title || "Événement";
    if (!event.timed) return "Aujourd'hui : " + name;
    var hour = event.hour < 10 ? "0" + event.hour : String(event.hour);
    var minute = event.minute < 10 ? "0" + event.minute : String(event.minute);
    return "Prochain : " + name + " à " + hour + ":" + minute;
  }

  function paintHelp() {
    var button = nav.querySelector('button[data-nav="calendrier"]');
    if (!button) return;
    var help = nextEvent ? nextLabel(nextEvent) : calendrierHelp;
    if (help) button.setAttribute("data-help", help);
    else button.removeAttribute("data-help");
  }

  function forgeRunning(data) {
    var jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    var n = 0;
    for (var i = 0; i < jobs.length; i += 1) if (jobs[i] && ACTIVE.indexOf(jobs[i].state) >= 0) n += 1;
    return n;
  }

  function securiaAlerts(data) {
    var fails = data && typeof data.failures_recent === "number" ? data.failures_recent : 0;
    return fails > 0 ? fails : 0;
  }

  function paintButton(button, row, dot) {
    if (!button) return;
    var badge = button.querySelector(".hq-nav-badge");
    if (!row || !row.count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "hq-nav-badge";
      badge.setAttribute("role", "img");
      button.appendChild(badge);
    }
    badge.classList.toggle("is-warn", !!row.warn);
    badge.classList.toggle("is-dot", !!dot);
    badge.textContent = dot ? "" : (row.count > 9 ? "9+" : String(row.count));
    badge.setAttribute("aria-label", row.count + (row.count === 1 ? " nouveauté" : " nouveautés"));
  }

  function paint() {
    var wide = window.matchMedia("(min-width: 900px)").matches;
    var folded = { count: 0, warn: false };
    nav.querySelectorAll("button[data-nav]").forEach(function (button) {
      var view = button.dataset.nav;
      var n = counts[view] || 0;
      var warn = view === "securite" && n > 0;
      var inBar = wide || BAR.indexOf(view) >= 0;
      paintButton(button, inBar && n ? { count: n, warn: warn } : null, false);
      if (!inBar && n) {
        folded.count += n;
        folded.warn = folded.warn || warn;
      }
    });
    if (!wide) paintButton(nav.querySelector('button[data-nav="plus"]'), folded.count ? folded : null, true);
    paintHelp();
  }

  function refresh() {
    if (busy || !isAdmin()) return Promise.resolve();
    busy = true;
    var today = new Date();
    var tomorrow = new Date(today.getTime() + 864e5);
    return Promise.all([
      getJSON("/api/carnet?meta=1"),
      getJSON("/api/calendar?from=" + dayKey(today) + "&to=" + dayKey(tomorrow)),
      getJSON("/api/forge/jobs"),
      getJSON("/api/securia/status"),
    ]).then(function (data) {
      var carnet = data[0];
      if (carnet) counts.carnet = carnetUnread(carnet);
      if (data[1]) {
        counts.calendrier = calendarToday(data[1]);
        nextEvent = nextToday(data[1]);
      }
      if (data[2]) counts.forge = forgeRunning(data[2]);
      if (data[3]) counts.securite = securiaAlerts(data[3]);
      busy = false;
      paint();
    }, function () {
      busy = false;
    });
  }

  function schedule() {
    clearInterval(timer);
    timer = 0;
    if (!isAdmin()) return;
    refresh();
    timer = setInterval(function () {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
  }

  function boot() {
    var calendrierButton = nav.querySelector('button[data-nav="calendrier"]');
    calendrierHelp = calendrierButton ? String(calendrierButton.getAttribute("data-help") || "") : "";
    if (isAdmin()) schedule();
    window.addEventListener("hq:session-role", function () {
      if (isAdmin()) schedule();
      else {
        counts = { carnet: 0, calendrier: 0, forge: 0, securite: 0 };
        nextEvent = null;
        paint();
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refresh();
    });
    // Opening Carnet or Calendrier is what marks it read; the badge recomputes from the data we already hold.
    new MutationObserver(function () {
      var view = document.body.dataset.view;
      if (view === "carnet") {
        markSeen("carnet");
        counts.carnet = 0;
      }
      if (view === "calendrier") {
        markSeen("calendrier");
        counts.calendrier = 0;
      }
      paint();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
