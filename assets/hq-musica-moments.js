/* Musica, outside the Musique tab: a short, dismissible nudge now and then.
   It reads the compact /api/musica/dj/station payload every few minutes (never on the Musique view, where the chip
   already lives) and may say one thing: a show that is ready, the daily challenge still unplayed in the evening, a
   show about to start, or a suggestion after a long stretch on one work view. Rules: one bubble per kind per day,
   at least 45 minutes between two bubbles, nothing while a tab is hidden, and two off switches (the server setting
   `moments`, and « Plus de nudges » on the bubble itself). Any error stops the polling for the session. */
(() => {
  "use strict";

  const POLL_MS = 5 * 60 * 1000;
  const FIRST_MS = 25 * 1000;
  const MIN_GAP_MS = 45 * 60 * 1000;
  const FOCUS_MIN = 90;
  const WORK_VIEWS = ["carnet", "forge", "dessiner", "calendrier", "projets", "budget", "repas", "inventaire"];
  const STORE = "hq_musica_moments";

  let timer = 0;
  let stopped = false;
  let focusView = "";
  let focusMinutes = 0;
  let bubble = null;
  let hideTimer = 0;

  function read() {
    try { return JSON.parse(window.localStorage.getItem(STORE) || "{}") || {}; } catch (_) { return {}; }
  }

  function write(data) {
    try { window.localStorage.setItem(STORE, JSON.stringify(data)); } catch (_) { /* private mode: no memory, still fine */ }
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const view = () => (document.body && document.body.dataset.view) || "";

  /* ---- the bubble ---- */
  function close() {
    window.clearTimeout(hideTimer);
    if (bubble) bubble.remove();
    bubble = null;
  }

  function say(kind, key, text, tab) {
    const memory = read();
    if (memory.off || (memory.last && Date.now() - memory.last < MIN_GAP_MS) || (memory.kinds || {})[kind] === key) return false;
    close();
    const node = document.createElement("aside");
    node.className = "hq-musica-moment";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    const words = document.createElement("p");
    words.textContent = "🎧 " + text;
    node.appendChild(words);
    const actions = document.createElement("div");
    actions.className = "hq-musica-moment-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", () => {
      try { window.sessionStorage.setItem("hq_music_tab", tab || "lecture"); } catch (_) {}
      close();
      const nav = document.querySelector('[data-nav="musique"]');
      if (nav) nav.click();
    });
    const later = document.createElement("button");
    later.type = "button";
    later.className = "is-quiet";
    later.textContent = "Later";
    later.addEventListener("click", close);
    const off = document.createElement("button");
    off.type = "button";
    off.className = "is-quiet";
    off.textContent = "No more nudges";
    off.addEventListener("click", () => {
      write({ ...read(), off: true });
      setMomentsServer(false);
      close();
    });
    actions.append(open, later, off);
    node.appendChild(actions);
    document.body.appendChild(node);
    bubble = node;
    hideTimer = window.setTimeout(close, 14000);
    write({ ...memory, last: Date.now(), kinds: { ...(memory.kinds || {}), [kind]: key } });
    return true;
  }

  function setMomentsServer(on) {
    const headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      const tok = window.hqCsrfToken();
      if (tok) headers["X-CSRF-Token"] = tok;
    }
    fetch("/api/musica/dj/settings", { method: "POST", credentials: "same-origin", headers, body: JSON.stringify({ moments: !!on }) }).catch(() => {});
  }

  /* ---- what to say ---- */
  function decide(data) {
    if (!data || data.ok === false || data.moments === false) return;
    const air = data.on_air;
    const ready = (data.ready || [])[0];
    if (ready && say("ready", ready.id + today(), (ready.label || "A show") + " is ready: come and listen.", "lecture")) return;
    const daily = data.daily || {};
    if (daily.done_today === false && new Date().getHours() >= 17 &&
        say("daily", today(), "Your daily challenge is waiting" + (daily.streak ? ": keep your " + daily.streak + "-day streak going." : "."), "quiz")) return;
    const next = (data.upcoming || [])[0];
    if (next && next.today) {
      const mins = Math.round((next.ts * 1000 - Date.now()) / 60000);
      if (mins > 0 && mins <= 15 && say("soon", next.id + next.at, (next.label || "A show") + " starts in " + mins + " min.", "lecture")) return;
    }
    if (!air && focusMinutes >= FOCUS_MIN && say("focus", today() + focusView, "You've been on this page for a while. A focus session?", "lecture")) {
      focusMinutes = 0;
    }
  }

  async function poll() {
    window.clearTimeout(timer);
    if (stopped) return;
    timer = window.setTimeout(poll, POLL_MS);
    if (document.hidden || view() === "musique" || typeof window.api !== "function") return;
    try {
      decide(await window.api("/api/musica/dj/station", { timeoutMs: 8000 }));
    } catch (_) {
      stopped = true;  // not allowed (upload role) or the module is absent: stay silent for the session
      window.clearTimeout(timer);
    }
  }

  /* One minute at a time on the same work view while the page is visible. */
  window.setInterval(() => {
    const now = view();
    if (document.hidden || !WORK_VIEWS.includes(now)) {
      if (!WORK_VIEWS.includes(now)) focusMinutes = 0;
      focusView = WORK_VIEWS.includes(now) ? now : "";
      return;
    }
    if (now !== focusView) { focusView = now; focusMinutes = 0; return; }
    focusMinutes += 1;
  }, 60 * 1000);

  window.addEventListener("hashchange", close);
  timer = window.setTimeout(poll, FIRST_MS);  // the script is deferred: the page is already parsed

  window.HqMusicaMoments = { enable() { write({ ...read(), off: false }); setMomentsServer(true); } };
})();
