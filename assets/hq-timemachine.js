/* Transfert HQ — Time machine (assets/hq-timemachine.css, server: hq_timeline.py via GET /api/timeline).
 *
 * A thin scrub bar you can open from anywhere (the clock button in the view bar, or Alt+T). Drag it back and HQ replays
 * the day or the week: Forge images land in their lane, Carnet pages appear as you edited them, files arrive, calendar
 * events pass, the sky behind turns from night to dawn to day. Tap a card to open the real thing (same routes as Ctrl+K).
 *
 * Two layers: pure helpers (Node-testable: visibleAt, phaseFor, stepFor, ticks, clamp) and the DOM sheet (mount).
 * Nothing is kept in browser storage; nothing goes into a URL. Plain ES2020, no HTML-string sinks.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqTimeMachine = api;
    if (root.document) api.boot(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const LANES = [
    { id: "forge", label: "Forge", icon: "M4 17l5-6 4 4 3-3 4 5M4 5h16v14H4z" },
    { id: "carnet", label: "Carnet", icon: "M6 3h10l3 3v15H6zM9 9h7M9 13h7M9 17h4" },
    { id: "fichiers", label: "Fichiers", icon: "M3 7h6l2 2h10v10H3z" },
    { id: "calendrier", label: "Calendrier", icon: "M4 6h16v14H4zM4 10h16M9 3v5M15 3v5" },
    { id: "systeme", label: "Système", icon: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" },
  ];
  const SPAN_SEC = { day: 86400, week: 7 * 86400 };
  const CARDS_PER_LANE = 6;
  const PLAY_MS = 14000;
  const PLAY_D = "M8 5v14l11-7z";
  const PAUSE_D = "M7 5h4v14H7zM13 5h4v14h-4z";

  // ------------------------------------------------------------------ pure helpers
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Moments of one lane at or before `cursor`, newest first, at most `n`. Each gets `age` (seconds before the cursor). */
  function visibleAt(moments, cursor, lane, n) {
    const out = [];
    for (let i = moments.length - 1; i >= 0 && out.length < n; i--) {
      const m = moments[i];
      if (m.lane === lane && m.at <= cursor) out.push(Object.assign({ age: cursor - m.at }, m));
    }
    return out;
  }

  /** How many moments of each lane happened at or before the cursor. */
  function countsAt(moments, cursor) {
    const c = {};
    for (const m of moments) if (m.at <= cursor) c[m.lane] = (c[m.lane] || 0) + 1;
    return c;
  }

  /** The sky's phase for a local hour (0–24, fractional): night, dawn, day, dusk. Same rhythm as the Accueil light. */
  function phaseFor(hour) {
    const h = ((hour % 24) + 24) % 24;
    if (h < 5.5 || h >= 21.5) return "night";
    if (h < 8) return "dawn";
    if (h < 18) return "day";
    return "dusk";
  }

  /** Keyboard step in seconds: 5 min over a day, 1 h over a week; Shift multiplies by 6. */
  function stepFor(span, big) {
    const base = span === "week" ? 3600 : 300;
    return big ? base * 6 : base;
  }

  /** Axis labels for [since, now]: every 3 h over a day, each midnight over a week. `fmt(date)` names them. */
  function ticks(since, now, span, fmt) {
    const out = [];
    const d = new Date(since * 1000);
    if (span === "week") {
      d.setHours(24, 0, 0, 0);
      for (let t = d.getTime() / 1000; t < now; t += 86400) out.push({ at: t, label: fmt(new Date(t * 1000), "day") });
    } else {
      d.setMinutes(0, 0, 0);
      if (d.getTime() < since * 1000) d.setHours(d.getHours() + 1);
      while (d.getHours() % 3) d.setHours(d.getHours() + 1);
      for (; d.getTime() < now * 1000; d.setHours(d.getHours() + 3)) out.push({ at: d.getTime() / 1000, label: fmt(new Date(d.getTime()), "hour") });
    }
    return out;
  }

  /** Index of the moment nearest to `at` within `tol` seconds, or -1 (snapping the playhead on release). */
  function nearest(moments, at, tol) {
    let best = -1, bestD = tol;
    for (let i = 0; i < moments.length; i++) {
      const d = Math.abs(moments[i].at - at);
      if (d <= bestD) { best = i; bestD = d; }
    }
    return best;
  }

  // ------------------------------------------------------------------ DOM
  function boot(win) {
    const doc = win.document;
    const go = () => { try { mount(win); } catch (e) { if (win.console) win.console.error(e); } };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go);
    else go();
  }

  function mount(win) {
    const doc = win.document;
    if (doc.getElementById("hq-tm")) return null;
    const reduced = () => !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const fmtClock = new Intl.DateTimeFormat("fr-CA", { hour: "2-digit", minute: "2-digit" });
    const fmtDay = new Intl.DateTimeFormat("fr-CA", { weekday: "long", day: "numeric", month: "long" });
    const fmtShortDay = new Intl.DateTimeFormat("fr-CA", { weekday: "short", day: "numeric" });
    const fmtHour = new Intl.DateTimeFormat("fr-CA", { hour: "2-digit" });
    const fmt = (d, kind) => (kind === "day" ? fmtShortDay.format(d) : fmtHour.format(d).replace(/\s/g, ""));

    const el = (tag, attrs, kids) => {
      const n = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else n.setAttribute(k, v === true ? "" : String(v));
      }
      for (const kid of kids || []) if (kid) n.appendChild(kid);
      return n;
    };
    const svgIcon = (d, cls) => {
      const ns = "http://www.w3.org/2000/svg";
      const s = doc.createElementNS(ns, "svg");
      s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", cls || "tm-ico");
      const p = doc.createElementNS(ns, "path");
      p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.8"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
      s.appendChild(p);
      return s;
    };

    const S = { open: false, span: "day", data: null, cursor: 0, loading: false, loadedAt: 0, playing: false, raf: 0, shown: new Set(), drag: null, lastTick: -1, from: null };

    // ---- skeleton
    const sky = el("div", { class: "tm-sky", "aria-hidden": "true" }, [el("div", { class: "tm-stars" })]);
    const dayEl = el("span", { class: "tm-day" });
    const clockEl = el("span", { class: "tm-clock" });
    const liveEl = el("span", { class: "tm-live", text: "maintenant" });
    const when = el("div", { class: "tm-when", "aria-live": "polite" }, [dayEl, clockEl, liveEl]);
    const segDay = el("button", { type: "button", class: "tm-seg-btn", "data-span": "day", role: "radio", "aria-checked": "true", text: "Jour" });
    const segWeek = el("button", { type: "button", class: "tm-seg-btn", "data-span": "week", role: "radio", "aria-checked": "false", text: "Semaine" });
    const seg = el("div", { class: "tm-seg", role: "radiogroup", "aria-label": "Période" }, [segDay, segWeek]);
    const playBtn = el("button", { type: "button", class: "tm-btn tm-play", "aria-label": "Rejouer", title: "Rejouer (Espace)" }, [svgIcon(PLAY_D)]);
    const nowBtn = el("button", { type: "button", class: "tm-btn tm-now", "aria-label": "Revenir à maintenant", title: "Maintenant (Fin)" }, [svgIcon("M5 5v14M9 12h10M15 8l4 4-4 4")]);
    const closeBtn = el("button", { type: "button", class: "tm-btn", "aria-label": "Fermer", title: "Fermer (Échap)" }, [svgIcon("M6 6l12 12M18 6 6 18")]);
    const head = el("header", { class: "tm-head" }, [
      el("div", { class: "tm-title" }, [svgIcon("M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2", "tm-ico tm-ico-lg"), el("span", { text: "Machine à remonter le temps" })]),
      when, el("div", { class: "tm-actions" }, [seg, playBtn, nowBtn, closeBtn]),
    ]);
    const lanesEl = el("div", { class: "tm-lanes" });
    const laneEls = {};
    for (const lane of LANES) {
      const count = el("span", { class: "tm-lane-n", text: "0" });
      const list = el("ol", { class: "tm-cards", "aria-label": lane.label });
      const box = el("section", { class: "tm-lane", "data-lane": lane.id }, [
        el("h3", { class: "tm-lane-h" }, [svgIcon(lane.icon), el("span", { text: lane.label }), count]),
        list,
        el("p", { class: "tm-empty", text: "Rien encore" }),
      ]);
      laneEls[lane.id] = { box, list, count };
      lanesEl.appendChild(box);
    }
    const status = el("p", { class: "tm-status", role: "status" });
    const canvas = el("canvas", { class: "tm-density", "aria-hidden": "true" });
    const labels = el("div", { class: "tm-labels", "aria-hidden": "true" });
    const playhead = el("div", { class: "tm-head-line", "aria-hidden": "true" }, [el("span", { class: "tm-knob" })]);
    const track = el("div", {
      class: "tm-track", role: "slider", tabindex: "0", "aria-label": "Moment affiché",
      "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "100",
    }, [canvas, labels, playhead]);
    const legend = el("div", { class: "tm-legend", "aria-hidden": "true" }, LANES.map((l) => el("span", { "data-lane": l.id, text: l.label })));
    const bar = el("div", { class: "tm-bar" }, [track, legend]);
    const sheet = el("div", { id: "hq-tm", class: "tm", role: "dialog", "aria-modal": "true", "aria-label": "Machine à remonter le temps", hidden: true }, [
      sky, el("div", { class: "tm-inner" }, [head, status, lanesEl, bar]),
    ]);
    doc.body.appendChild(sheet);

    // ---- launcher in the view bar (next to the search button)
    const launcher = el("button", {
      type: "button", class: "view-search tm-launch", id: "btn-timemachine", "aria-label": "Machine à remonter le temps",
      "data-help": "Machine à remonter le temps : rejoue ta journée ou ta semaine dans HQ. Alt+T.",
    }, [svgIcon("M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2")]);
    const tools = doc.querySelector(".view-bar .view-tools, .home-hero-head .view-tools");
    if (tools) tools.insertBefore(launcher, doc.getElementById("btn-search-bar") || tools.firstChild);

    // ---- data
    const since = () => (S.data ? S.data.since : Date.now() / 1000 - SPAN_SEC[S.span]);
    const until = () => (S.data ? S.data.now : Date.now() / 1000);
    const moments = () => (S.data ? S.data.moments : []);

    async function load(force) {
      if (S.loading) return;
      if (!force && S.data && S.data.span === S.span && Date.now() - S.loadedAt < 30000) return;
      S.loading = true;
      status.textContent = "Chargement…";
      sheet.classList.add("is-loading");
      try {
        if (typeof win.api !== "function") throw new Error("HQ indisponible");
        const data = await win.api("/api/timeline?span=" + S.span, { timeoutMs: 15000 });
        S.data = data;
        S.loadedAt = Date.now();
        S.cursor = data.now;
        S.shown = new Set();
        const n = (data.moments || []).length;
        const missing = (data.missing || []).length ? "Certaines sources sont indisponibles." : "";
        status.textContent = n ? missing : ("Rien à rejouer sur cette période. " + missing).trim();
      } catch (e) {
        S.data = null;
        status.textContent = (e && e.message) || "Chargement impossible";
      } finally {
        S.loading = false;
        sheet.classList.remove("is-loading");
        drawDensity();
        render(true);
      }
    }

    // ---- rendering
    function cardFor(m) {
      const li = el("li", { class: "tm-card" + (m.thumb ? " has-thumb" : "") + (m.level === "warn" ? " is-warn" : ""), "data-kind": m.kind });
      const btn = el("button", { type: "button", class: "tm-card-btn", disabled: m.open ? null : true });
      if (m.thumb) {
        const img = el("img", { class: "tm-thumb", src: m.thumb, alt: "", loading: "lazy", decoding: "async" });
        img.addEventListener("error", () => { img.remove(); li.classList.remove("has-thumb"); });
        btn.appendChild(img);
      }
      const t = new Date(m.at * 1000);
      btn.appendChild(el("span", { class: "tm-card-body" }, [
        el("span", { class: "tm-card-t", text: m.title }),
        el("span", { class: "tm-card-m", text: (S.span === "week" ? fmtShortDay.format(t) + " · " : "") + fmtClock.format(t) + (m.sub ? " · " + m.sub : "") }),
      ]));
      if (m.open) btn.addEventListener("click", () => openMoment(m));
      li.appendChild(btn);
      return li;
    }

    const keyOf = (m) => m.lane + "|" + m.kind + "|" + m.at + "|" + m.title;

    function render(fresh) {
      const cursor = S.cursor;
      const all = moments();
      const a = since(), b = until();
      const pct = b > a ? clamp((cursor - a) / (b - a), 0, 1) : 1;
      playhead.style.setProperty("--x", (pct * 100).toFixed(3) + "%");
      track.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
      const d = new Date(cursor * 1000);
      dayEl.textContent = fmtDay.format(d);
      clockEl.textContent = fmtClock.format(d);
      track.setAttribute("aria-valuetext", dayEl.textContent + " " + clockEl.textContent);
      const atNow = b - cursor < 60;
      liveEl.hidden = !atNow;
      sheet.classList.toggle("is-past", !atNow);
      sheet.dataset.phase = phaseFor(d.getHours() + d.getMinutes() / 60);
      const counts = countsAt(all, cursor);
      const freshWindow = S.span === "week" ? 6 * 3600 : 45 * 60;
      const nextShown = new Set();
      for (const lane of LANES) {
        const L = laneEls[lane.id];
        const items = visibleAt(all, cursor, lane.id, CARDS_PER_LANE);
        L.count.textContent = String(counts[lane.id] || 0);
        L.box.classList.toggle("is-empty", !items.length);
        const frag = doc.createDocumentFragment();
        items.forEach((m, i) => {
          const card = cardFor(m);
          const k = keyOf(m);
          nextShown.add(k);
          if (!fresh && !S.shown.has(k) && !reduced()) card.classList.add("tm-in");
          if (m.age <= freshWindow) card.classList.add("is-fresh");
          card.style.setProperty("--i", String(i));
          frag.appendChild(card);
        });
        L.list.replaceChildren(frag);
      }
      if (!fresh && typeof win.hqPolishHaptic === "function") {
        for (const k of nextShown) if (!S.shown.has(k)) { win.hqPolishHaptic("tick"); break; }
      }
      S.shown = nextShown;
    }

    function drawDensity() {
      const r = track.getBoundingClientRect();
      const dpr = Math.min(win.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const c = canvas.getContext && canvas.getContext("2d");
      labels.replaceChildren();
      if (!c) return;
      c.clearRect(0, 0, w, h);
      const a = since(), b = until();
      if (!(b > a)) return;
      const cs = win.getComputedStyle(sheet);
      const colors = {};
      for (const lane of LANES) colors[lane.id] = cs.getPropertyValue("--tm-" + lane.id).trim() || "#7dd3fc";
      const rows = LANES.length, pad = 6 * dpr, rowH = (h - pad * 2) / rows;
      for (const m of moments()) {
        const x = ((m.at - a) / (b - a)) * w;
        const row = LANES.findIndex((l) => l.id === m.lane);
        if (row < 0) continue;
        c.fillStyle = colors[m.lane];
        c.globalAlpha = 0.85;
        c.beginPath();
        c.roundRect ? c.roundRect(x - 1.5 * dpr, pad + row * rowH + rowH * 0.15, 3 * dpr, rowH * 0.7, 1.5 * dpr) : c.rect(x - 1.5 * dpr, pad + row * rowH + rowH * 0.15, 3 * dpr, rowH * 0.7);
        c.fill();
      }
      c.globalAlpha = 1;
      for (const t of ticks(a, b, S.span, fmt)) {
        const x = (t.at - a) / (b - a);
        labels.appendChild(el("span", { class: "tm-label", style: "left:" + (x * 100).toFixed(3) + "%", text: t.label }));
      }
    }

    // ---- scrubbing
    function setCursor(at, opts) {
      S.cursor = clamp(at, since(), until());
      render(false);
      if (!(opts && opts.keepPlay)) stopPlay();
    }
    function atX(clientX) {
      const r = track.getBoundingClientRect();
      const pct = r.width ? clamp((clientX - r.left) / r.width, 0, 1) : 1;
      return since() + pct * (until() - since());
    }
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      track.focus({ preventScroll: true });
      S.drag = { id: e.pointerId };
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      sheet.classList.add("is-scrubbing");
      setCursor(atX(e.clientX));
    });
    track.addEventListener("pointermove", (e) => {
      if (!S.drag || S.drag.id !== e.pointerId) return;
      setCursor(atX(e.clientX));
    });
    const endDrag = (e) => {
      if (!S.drag || S.drag.id !== e.pointerId) return;
      S.drag = null;
      sheet.classList.remove("is-scrubbing");
      // Snap to a moment a few pixels away, so a release lands exactly on what you aimed at.
      const r = track.getBoundingClientRect();
      const tol = r.width ? (8 / r.width) * (until() - since()) : 0;
      const i = nearest(moments(), S.cursor, tol);
      if (i >= 0) setCursor(moments()[i].at);
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    track.addEventListener("keydown", (e) => {
      const step = stepFor(S.span, e.shiftKey);
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setCursor(S.cursor - step); }
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setCursor(S.cursor + step); }
      else if (e.key === "Home") { e.preventDefault(); setCursor(since()); }
      else if (e.key === "End") { e.preventDefault(); setCursor(until()); }
      else if (e.key === "PageUp" || e.key === "PageDown") {
        // jump to the previous / next moment
        e.preventDefault();
        const all = moments();
        const next = e.key === "PageDown" ? all.find((m) => m.at > S.cursor + 1) : [...all].reverse().find((m) => m.at < S.cursor - 1);
        if (next) setCursor(next.at);
      }
    });

    // ---- replay
    function stopPlay() {
      if (!S.playing) return;
      S.playing = false;
      if (S.raf) win.cancelAnimationFrame(S.raf);
      S.raf = 0;
      sheet.classList.remove("is-playing");
      playBtn.setAttribute("aria-label", "Rejouer");
      playBtn.querySelector("path").setAttribute("d", PLAY_D);
    }
    function play() {
      if (S.playing) { stopPlay(); return; }
      const a = since(), b = until();
      if (!(b > a)) return;
      if (b - S.cursor < 60) setCursor(a);
      S.playing = true;
      sheet.classList.add("is-playing");
      playBtn.setAttribute("aria-label", "Pause");
      playBtn.querySelector("path").setAttribute("d", PAUSE_D);
      const startAt = S.cursor, startT = win.performance.now();
      const dur = PLAY_MS * ((b - startAt) / (b - a));
      const tick = (t) => {
        if (!S.playing) return;
        const k = dur > 0 ? clamp((t - startT) / dur, 0, 1) : 1;
        setCursor(startAt + (b - startAt) * k, { keepPlay: true });
        if (k >= 1) { stopPlay(); return; }
        S.raf = win.requestAnimationFrame(tick);
      };
      S.raf = win.requestAnimationFrame(tick);
    }

    // ---- open / close
    async function openMoment(m) {
      close();
      const o = m.open;
      if (!o) return;
      if (o.kind === "file") {
        if (/^(audio|video)$/.test(m.kind) && typeof win.hqPlayerOpen === "function") { win.hqPlayerOpen(o.id, false); return; }
        if (typeof win.navigate === "function") { await win.navigate(o.dir); return; }
      }
      if (typeof win.hqOpenHit === "function") {
        const got = await win.hqOpenHit(o);
        if (got === "fail" && typeof win.toast === "function") win.toast("Impossible d'ouvrir cet élément", "err");
      }
    }

    function open() {
      if (S.open) return;
      S.open = true;
      S.from = doc.activeElement;
      sheet.hidden = false;
      doc.documentElement.classList.add("tm-open");
      win.requestAnimationFrame(() => { sheet.classList.add("is-open"); drawDensity(); });
      if (S.data) { S.cursor = until(); render(true); }
      load(false).then(() => track.focus({ preventScroll: true }));
    }
    function close() {
      if (!S.open) return;
      S.open = false;
      stopPlay();
      sheet.classList.remove("is-open");
      doc.documentElement.classList.remove("tm-open");
      const done = () => { if (!S.open) sheet.hidden = true; };
      if (reduced()) done(); else win.setTimeout(done, 260);
      if (S.from && typeof S.from.focus === "function") { try { S.from.focus({ preventScroll: true }); } catch (_) {} }
    }
    function setSpan(span) {
      if (span === S.span) return;
      S.span = span;
      segDay.setAttribute("aria-checked", String(span === "day"));
      segWeek.setAttribute("aria-checked", String(span === "week"));
      stopPlay();
      load(true);
    }

    launcher.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    nowBtn.addEventListener("click", () => setCursor(until()));
    playBtn.addEventListener("click", play);
    seg.addEventListener("click", (e) => { const b = e.target.closest("[data-span]"); if (b) setSpan(b.dataset.span); });
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === " " && e.target === track) { e.preventDefault(); play(); }
    });
    sky.addEventListener("click", close);
    doc.addEventListener("keydown", (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "t" || e.key === "T" || e.code === "KeyT")) {
        e.preventDefault();
        if (S.open) close(); else open();
      }
    });
    win.addEventListener("resize", () => { if (S.open) drawDensity(); });

    const h = { open, close, toggle: () => (S.open ? close() : open()), state: () => ({ open: S.open, span: S.span, cursor: S.cursor, playing: S.playing, count: moments().length }), setCursor, setSpan, play };
    win.hqTimeMachine = h;
    return h;
  }

  return { LANES, SPAN_SEC, clamp, visibleAt, countsAt, phaseFor, stepFor, ticks, nearest, boot, mount };
});
