/* Transfert HQ — shared visual polish (assets/hq-polish.css). Presentation only; exports for tests. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqPolish = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const HAPTIC = { tick: 6, drop: 12, play: 10, done: [8, 28, 10], stock: [6, 40, 14], fav: 14 };
  const SOUND_KEY = "hq_polish_sound";

  function calm(win) {
    try {
      return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function fine(win) {
    try {
      return win.matchMedia("(hover:hover) and (pointer:fine)").matches;
    } catch (_) {
      return false;
    }
  }

  function haptic(win, kind) {
    if (calm(win)) return;
    const map = { tick: HAPTIC.tick, drop: HAPTIC.drop, play: HAPTIC.play, done: HAPTIC.done, stock: HAPTIC.stock, fav: HAPTIC.fav };
    const v = map[kind] || HAPTIC.tick;
    try {
      if (win.navigator && typeof win.navigator.vibrate === "function") win.navigator.vibrate(v);
    } catch (_) {}
  }

  function soundOn(win) {
    try {
      return win.localStorage.getItem(SOUND_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function playTick(win) {
    if (!soundOn(win) || calm(win)) return;
    try {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.04;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.045);
      o.onended = () => ctx.close().catch(() => {});
    } catch (_) {}
  }

  function burstAt(win, x, y) {
    if (calm(win)) return;
    const b = win.document.createElement("span");
    b.className = "hq-burst";
    b.style.left = x + "px";
    b.style.top = y + "px";
    win.document.body.appendChild(b);
    b.classList.add("is-go");
    win.setTimeout(() => b.remove(), 700);
    playTick(win);
  }

  function successBurst(win, anchor) {
    if (!anchor) return;
    if (anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      burstAt(win, r.left + r.width / 2, r.top + r.height / 2);
    } else if (anchor.x != null) burstAt(win, anchor.x, anchor.y);
    haptic(win, "done");
  }

  function flashStatusChip(win) {
    const chip = win.document.getElementById("status-chip");
    if (!chip || calm(win)) return;
    chip.classList.remove("is-flash");
    void chip.offsetWidth;
    chip.classList.add("is-flash");
    win.setTimeout(() => chip.classList.remove("is-flash"), 800);
  }

  function navStreak(win, fromView, toView) {
    if (calm(win) || !fromView || fromView === toView) return;
    const nav = win.document.querySelector(".bottom-nav");
    if (!nav) return;
    const a = nav.querySelector('button[data-nav="' + fromView + '"]');
    const b = nav.querySelector('button[data-nav="' + toView + '"]');
    if (!a || !b) return;
    let streak = win.document.querySelector(".nav-streak");
    if (!streak) {
      streak = win.document.createElement("span");
      streak.className = "nav-streak";
      streak.setAttribute("aria-hidden", "true");
      win.document.body.appendChild(streak);
    }
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    streak.style.setProperty("--tx", Math.round(rb.left + rb.width / 2 - ra.left - ra.width / 2) + "px");
    streak.style.setProperty("--ty", Math.round(rb.top + rb.height / 2 - ra.top - ra.height / 2) + "px");
    streak.style.left = Math.round(ra.left + ra.width / 2 - 24) + "px";
    streak.style.top = Math.round(ra.top + ra.height / 2 - 1) + "px";
    streak.classList.remove("is-go");
    void streak.offsetWidth;
    streak.classList.add("is-go");
  }

  function setLecteurNavHint(win, on) {
    const btn = win.document.querySelector('.bottom-nav [data-nav="lecteur"]');
    if (btn) btn.classList.toggle("hq-nav-hint", !!on);
  }

  function hourTone(h) {
    const t = ((Number(h) % 24) + 24) % 24;
    if (t < 5 || t >= 21) return "night";
    if (t < 7) return "dawn";
    if (t < 18) return "day";
    return "dusk";
  }

  function syncAmbientHour(win) {
    const bg = win.document.querySelector(".home-bg");
    if (bg) bg.setAttribute("data-hour-tone", hourTone(new Date().getHours()));
  }

  function bindPointerLight(win) {
    if (!fine(win)) return;
    const sel = ".fx-card, .fx-tile, .device-tile, section.hq, .inv-drawer, .prj-card";
    win.document.querySelectorAll(sel).forEach((n) => n.classList.add("hq-spot"));
    win.document.addEventListener(
      "pointermove",
      (ev) => {
        if (ev.pointerType !== "mouse" || calm(win)) return;
        const t = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
        if (!t) return;
        const r = t.getBoundingClientRect();
        t.style.setProperty("--sx", ((ev.clientX - r.left) / r.width) * 100 + "%");
        t.style.setProperty("--sy", ((ev.clientY - r.top) / r.height) * 100 + "%");
      },
      { passive: true }
    );
  }

  function dealIn(container) {
    if (!container || calm(global)) return;
    container.classList.add("hq-deal-in");
    let i = 0;
    container.childNodes.forEach((n) => {
      if (n.nodeType === 1) {
        n.style.setProperty("--di", String(i));
        i += 1;
      }
    });
  }

  function upgradeSkeletons(win) {
    win.document.querySelectorAll("li.hint, p.hint").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (!/Chargement/i.test(t)) return;
      if (el.classList.contains("hq-skel")) return;
      el.classList.add("hq-skel");
      el.setAttribute("aria-busy", "true");
    });
  }

  function calTodayColumn(win) {
    if (win.document.body.dataset.view !== "calendrier") return;
    const app = win.document.getElementById("hq-cal-app");
    if (!app) return;
    app.querySelectorAll(".hq-cal-weekcol").forEach((c) => c.classList.remove("is-today-col"));
    const head = app.querySelector(".hq-cal-weekhead");
    if (!head) return;
    const buttons = [...head.querySelectorAll("button[data-day]")];
    const idx = buttons.findIndex((b) => b.classList.contains("is-today"));
    if (idx < 0) return;
    const cols = app.querySelectorAll(".hq-cal-weekgrid .hq-cal-weekcol");
    if (cols[idx]) cols[idx].classList.add("is-today-col");
  }

  function printSend(win, label) {
    if (calm(win)) return;
    const g = win.document.createElement("div");
    g.className = "hq-print-ghost";
    g.textContent = label || "Envoi…";
    g.style.left = "50%";
    g.style.top = "45%";
    g.style.transform = "translate(-50%,-50%)";
    win.document.body.appendChild(g);
    win.requestAnimationFrame(() => g.classList.add("is-go"));
    win.setTimeout(() => g.remove(), 600);
    haptic(win, "tick");
  }

  function onViewChange(win, fromView, toView) {
    navStreak(win, fromView, toView);
    if (toView !== "fichiers") setLecteurNavHint(win, false);
    if (toView === "calendrier") win.requestAnimationFrame(() => calTodayColumn(win));
  }

  function bindSoundToggle(win) {
    const box = win.document.getElementById("hq-polish-sound");
    if (!box || box.__hqPolishSound) return;
    box.__hqPolishSound = true;
    try {
      box.checked = soundOn(win);
    } catch (_) {}
    box.addEventListener("change", () => {
      try {
        win.localStorage.setItem(SOUND_KEY, box.checked ? "1" : "0");
      } catch (_) {}
    });
  }

  function start(win) {
    bindSoundToggle(win);
    syncAmbientHour(win);
    win.setInterval(() => syncAmbientHour(win), 60000);
    bindPointerLight(win);
    const app = win.document.getElementById("hq-cal-app");
    if (app && !app.__hqPolishCal) {
      app.__hqPolishCal = true;
      new win.MutationObserver(() => calTodayColumn(win)).observe(app, { childList: true, subtree: true });
    }
    win.document.querySelectorAll("details.hq").forEach((d) => d.classList.add("hq-acc"));
    new win.MutationObserver(() => upgradeSkeletons(win)).observe(win.document.body, { childList: true, subtree: true });
    upgradeSkeletons(win);
    win.hqPolishBurst = (el) => successBurst(win, el);
    win.hqPolishHaptic = (k) => haptic(win, k);
    win.hqPolishPrintSend = (l) => printSend(win, l);
    win.hqPolishFlashChip = () => flashStatusChip(win);
    win.hqPolishLecteurHint = (on) => setLecteurNavHint(win, on);
    win.hqPolishDealIn = (el) => dealIn(el);
  }

  return { start, onViewChange, successBurst, haptic, playTick, printSend, flashStatusChip, setLecteurNavHint, dealIn, calTodayColumn, pure: { calm, hourTone, haptic, soundOn } };
});
