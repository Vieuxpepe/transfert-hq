/* Accueil > Activité récente > 'Depuis hier': one calm list of what happened in the last 24 h.
   Counts only (no file names or note text). Loaded while Accueil is on screen; refreshed every
   5 minutes while it stays there and the page is visible. A tap opens the matching view. */
(function () {
  "use strict";
  const REFRESH_MS = 5 * 60 * 1000;
  let timer = 0;
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const two = (n) => String(n).padStart(2, "0");

  function when(at) {
    const d = new Date(at * 1000);
    const time = two(d.getHours()) + ":" + two(d.getMinutes());
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return time;
    if (d.toDateString() === yesterday.toDateString()) return "hier " + time;
    return time;
  }

  function canOpen(nav) {
    if (!nav || typeof window.setView !== "function") return false;
    return !(nav === "ops" && document.body.classList.contains("mode-simple"));
  }

  function paint(data) {
    const box = $("hq-since");
    const list = $("hq-since-list");
    if (!box || !list) return;
    const items = (data && data.items) || [];
    list.replaceChildren();
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "hq-since-item";
      li.dataset.kind = item.kind;
      li.dataset.level = item.level === "warn" ? "warn" : "info";
      const time = document.createElement("span");
      time.className = "hq-since-time";
      time.textContent = when(item.at);
      let body;
      if (canOpen(item.nav)) {
        body = document.createElement("button");
        body.type = "button";
        body.className = "hq-since-open";
        body.addEventListener("click", () => window.setView(item.nav));
      } else {
        body = document.createElement("span");
      }
      body.classList.add("hq-since-text");
      body.textContent = item.text;
      li.append(time, body);
      list.appendChild(li);
    });
    $("hq-since-empty").hidden = items.length > 0;
    box.hidden = false;
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/api/today", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const box = $("hq-since");
        if (box) box.hidden = true; // e.g. an upload-only session: the section simply stays calendar-only
        return;
      }
      paint(await response.json());
    } catch (_) {
      /* offline: keep what is shown */
    } finally {
      busy = false;
    }
  }

  function isOpen() {
    return !!$("hq-since") && document.body.dataset.view === "accueil";
  }

  function schedule() {
    clearInterval(timer);
    timer = 0;
    if (!isOpen()) return;
    load();
    timer = setInterval(() => {
      if (document.visibilityState === "visible" && isOpen()) load();
    }, REFRESH_MS);
  }

  function boot() {
    if (!$("hq-since")) return;
    // Shown with Accueil (body[data-view]).
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && isOpen()) load();
    });
    schedule();
  }

  window.hqTodayRefresh = load; // test/debug hook
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
