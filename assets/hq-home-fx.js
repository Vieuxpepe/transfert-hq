/* Transfert HQ — Accueil, alive.
 *
 * Layers motion over the Accueil that hq-home.js builds, without changing what it shows:
 *  - a living sky in the welcome header: the sun (or the moon) on its arc for the hour, drifting clouds by day,
 *    twinkling stars and the odd shooting star by night, slow aurora light, a gentle parallax under the pointer;
 *  - the greeting arrives letter by letter (and waves when you point at it);
 *  - a clock whose digits roll like an odometer, with a seconds line;
 *  - the status dot breathes; the next-event card catches the light; actions tilt toward the pointer, light up under
 *    it, ripple and spark when pressed, each icon with its own little gesture;
 *  - every card has a soft spotlight that follows the pointer; lists deal their lines in one after another and new
 *    lines flash; device rings sweep to their level; this PC's icons act out what they do.
 * Everything is off with reduced motion. Never builds HTML from strings; fetches nothing. Plain ES2020; pure helpers
 * are exported for Node tests (tests/check_hq_home_fx.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqHomeFx = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  // ------------------------------------------------------------------ pure helpers

  /** night (21 h–5 h) · dawn (5 h–7 h) · day (7 h–18 h) · dusk (18 h–21 h) */
  function phase(hours) {
    const h = ((Number(hours) % 24) + 24) % 24;
    if (h < 5 || h >= 21) return "night";
    if (h < 7) return "dawn";
    if (h < 18) return "day";
    return "dusk";
  }

  /** The sun (6 h–20 h) or the moon (20 h–6 h) on its arc: ``p`` how far across (0 → 1), ``h`` how high (0 → 1). The
   * arc lives in the empty lower right of the header (x, y in % on a computer; the phone uses p and h its own way). */
  function orbAt(hours) {
    const t = ((Number(hours) % 24) + 24) % 24;
    const sun = t >= 6 && t < 20;
    const p = sun ? (t - 6) / 14 : (((t - 20) % 24) + 24) % 24 / 10;
    const h = Math.sin(Math.PI * p);
    const r = (v) => Math.round(v * 1000) / 1000;
    return { kind: sun ? "sun" : "moon", p: r(p), h: r(h), x: Math.round((58 + p * 38) * 10) / 10, y: Math.round((95 - h * 30) * 10) / 10 };
  }

  /** "HHMM" digits of a date, as four numbers. */
  function digits(date) {
    const h = date.getHours();
    const m = date.getMinutes();
    return [Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10];
  }

  /** A small seeded random (stars stay where they are between visits). */
  function seeded(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** Stable stars: [{x, y, size, delay, dur}] in % of the header. */
  function starField(n, seed) {
    const rnd = seeded(seed || 7);
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push({ x: Math.round(rnd() * 1000) / 10, y: Math.round(rnd() * 880) / 10, size: 1 + Math.round(rnd() * 20) / 10, delay: Math.round(rnd() * 60) / 10, dur: 2 + Math.round(rnd() * 40) / 10 });
    }
    return out;
  }

  /** The background is always a sunset, warmer or deeper with the hour: [sky, horizon glow, rose band, dusk shade]. */
  const PALETTES = {
    dark: {
      night: ["#33264f", "#a9553a", "#6e3150", "#1f1631"],
      dawn: ["#40335f", "#d0814f", "#9c5163", "#251c3a"],
      day: ["#463f6e", "#dc955a", "#ae6470", "#2a2442"],
      dusk: ["#432a60", "#e5843f", "#b54a64", "#26193b"],
    },
    light: {
      night: ["#e7ddf1", "#f4c6a6", "#efc3cd", "#f1e8f4"],
      dawn: ["#efe3f3", "#fbcfae", "#f5cad3", "#f7eff6"],
      day: ["#f3e7f2", "#fdd8b4", "#f9d0d6", "#fbf4f2"],
      dusk: ["#eadaf0", "#fdc296", "#f4b9c6", "#f6edf3"],
    },
  };

  /** Every page has its own sunset, so you know where you are at a glance: [sky, horizon glow, middle band, hills].
   * Accueil keeps the classic one (and follows the hour); the others have a fixed personality. */
  const PAGES = {
    carnet: { name: "Bibliothèque à l'heure dorée", dark: ["#3a2c3f", "#d39a4e", "#8a5a3c", "#241a22"], light: ["#f2e8dc", "#f8d7a4", "#ecd2b8", "#f6efe6"] },
    calendrier: { name: "Aube", dark: ["#2c3866", "#e59b78", "#7a5c8e", "#1b2140"], light: ["#dfe7f8", "#fcd2bd", "#e6d6ee", "#eef2fb"] },
    dessiner: { name: "Crépuscule d'atelier", dark: ["#1f3a4a", "#e07a5f", "#3d7a7a", "#14262f"], light: ["#d9ecee", "#fbcbbc", "#cfe8e4", "#edf6f6"] },
    forge: { name: "Braises", dark: ["#3b1a22", "#e8622c", "#9a2f2a", "#200f14"], light: ["#f6dcd6", "#ffc2a0", "#f3c0b4", "#fbeeea"] },
    intime: { name: "Chambre pourpre", dark: ["#381428", "#ff3377", "#8a244c", "#1f0914"], light: ["#fbe4ec", "#ff80ab", "#f8bbd0", "#fdf0f4"] },
    fichiers: { name: "Coucher sur la mer", dark: ["#1d2f52", "#e2a14a", "#2f6f86", "#10203a"], light: ["#d8e5f6", "#fdd9a8", "#c8e6ee", "#ecf3fa"] },
    projets: { name: "Plan au crépuscule", dark: ["#1a2a55", "#f0955a", "#2c5d9a", "#111b38"], light: ["#d7e1f7", "#fdd2b2", "#cfdcf5", "#edf1fb"] },
    inventaire: { name: "Forêt au soir", dark: ["#23352a", "#d8a04c", "#4f6b3a", "#16211a"], light: ["#e1ecdc", "#f7dcab", "#d8e6c8", "#f1f6ec"] },
    lecteur: { name: "Cinéma de nuit", dark: ["#2c1846", "#e0568f", "#5a2a7a", "#170c28"], light: ["#eadcf5", "#f9c6dc", "#e3cdf2", "#f6eefb"] },
    plus: { name: "Aurore boréale", dark: ["#152c3e", "#7fd6b4", "#2f5f7a", "#0d1a26"], light: ["#d9eaf2", "#cdeedd", "#d3e5ef", "#eef6f8"] },
    ops: { name: "Aurore boréale", dark: ["#152c3e", "#7fd6b4", "#2f5f7a", "#0d1a26"], light: ["#d9eaf2", "#cdeedd", "#d3e5ef", "#eef6f8"] },
  };

  function pagePalette(view, ph, light) {
    const p = PAGES[view];
    return p ? p[light ? "light" : "dark"].slice() : palette(ph, light);
  }

  function palette(ph, light) {
    const set = PALETTES[light ? "light" : "dark"];
    return (set[ph] || set.night).slice();
  }

  /** One gentle wave as a polyline across two screen widths (it slides by one width, so the loop is seamless). */
  function wavePath(width, height, amp, waves, phaseShift) {
    const pts = [];
    const steps = 96;
    for (let i = 0; i <= steps; i += 1) {
      const x = (2 * width * i) / steps;
      const y = height * 0.45 + amp * Math.sin((2 * Math.PI * waves * x) / width + (phaseShift || 0));
      pts.push((i ? "L" : "M") + Math.round(x * 10) / 10 + " " + Math.round(y * 10) / 10);
    }
    return pts.join(" ") + " L" + 2 * width + " " + height + " L0 " + height + " Z";
  }

  const pure = { phase, orbAt, digits, seeded, starField, palette, pagePalette, wavePath, PAGES };

  // ------------------------------------------------------------------ browser layer

  const SVG_NS = "http://www.w3.org/2000/svg";
  const S = { win: null, doc: null, hero: null, home: null, sky: null, orb: null, clock: null, cols: [], sec: null, last: "", splitting: false, shootTimer: 0, raf: 0 };

  function el(tag, cls, attrs) {
    const n = S.doc.createElement(tag);
    if (cls) n.className = cls;
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    return n;
  }

  const calm = () => {
    try {
      return S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  };
  const fine = () => {
    try {
      return S.win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch (_) {
      return false;
    }
  };
  const onHome = () => S.doc.body.dataset.view === "accueil";
  /** perf11: the CSS effects pause off Accueil, in a hidden tab, and (header) when scrolled out of view. */
  const syncPause = () => {
    if (!S.home) return;
    const motionOff = S.win.HqMotion && S.win.HqMotion.homeEffectsPaused();
    const off = S.doc.hidden || !onHome() || motionOff;
    S.home.classList.toggle("hf-paused", off);
    if (S.hero) S.hero.classList.toggle("hf-paused", off || S.heroOut === true);
    // The global background only animates on Accueil too (its frozen frame keeps each page's look); it resumes on return.
    if (S.bg) S.bg.classList.toggle("hf-paused", off);
  };
  /** The PC's time (hq-home.js corrects for this device's clock), so sky, clock and greeting always agree. */
  const hqNow = () => {
    try {
      if (typeof S.win.hqNow === "function") {
        const d = S.win.hqNow();
        if (d instanceof Date && !isNaN(d)) return d;
      }
    } catch (_) {}
    return new Date();
  };

  function anim(node, frames, opts) {
    if (!node || calm() || typeof node.animate !== "function") return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }

  // ---- sky

  function buildSky() {
    const sky = el("div", "home-sky", { "aria-hidden": "true" });
    const aurora = el("div", "home-aurora");
    aurora.append(el("span", "a1"), el("span", "a2"), el("span", "a3"));
    const stars = el("div", "home-stars");
    for (const st of starField(18, 1077)) { // perf11: 18 stars (was 46), the same first ones
      const s = el("span", "home-star");
      s.style.cssText = "left:" + st.x + "%;top:" + st.y + "%;width:" + st.size + "px;height:" + st.size + "px;animation-delay:" + st.delay + "s;animation-duration:" + st.dur + "s";
      stars.appendChild(s);
    }
    const shoot = el("span", "home-shoot");
    stars.appendChild(shoot);
    const clouds = el("div", "home-clouds");
    [[14, 1, 0], [36, 0.7, -34], [6, 0.55, -70]].forEach(([y, sc, delay], k) => {
      const c = el("span", "home-cloud c" + k);
      c.style.cssText = "top:" + y + "%;--s:" + sc + ";animation-delay:" + delay + "s";
      clouds.appendChild(c);
    });
    const orb = el("div", "home-orb");
    orb.append(el("span", "home-orb-rays"), el("span", "home-orb-core"));
    sky.append(aurora, stars, clouds, orb);
    S.hero.insertBefore(sky, S.hero.firstChild);
    S.sky = sky;
    S.orb = orb;
    S.shoot = shoot;
  }

  function paintSky(date) {
    if (!S.sky) return;
    const h = date.getHours() + date.getMinutes() / 60;
    const ph = phase(h);
    for (const k of ["night", "dawn", "day", "dusk"]) S.hero.classList.toggle("sky-" + k, k === ph);
    paintBackground(ph);
    const o = orbAt(h);
    S.orb.classList.toggle("is-sun", o.kind === "sun");
    S.orb.classList.toggle("is-moon", o.kind === "moon");
    S.orb.style.setProperty("--op", String(o.p));
    S.orb.style.setProperty("--oh", String(o.h));
  }

  function shootingStars() {
    S.win.clearTimeout(S.shootTimer);
    const again = () => {
      S.shootTimer = S.win.setTimeout(shootingStars, 6000 + Math.random() * 9000);
    };
    if (calm() || S.doc.hidden || !onHome() || !(S.hero.classList.contains("sky-night") || S.hero.classList.contains("sky-dusk"))) return again();
    const sh = S.shoot;
    sh.style.left = 20 + Math.random() * 60 + "%";
    sh.style.top = 4 + Math.random() * 30 + "%";
    sh.classList.remove("is-go");
    void sh.offsetWidth;
    sh.classList.add("is-go");
    again();
  }

  // ---- the background: slow glows in the colours of the hour, drifting lights, gentle waves, a little grain

  function buildBackground() {
    const doc = S.doc;
    const bg = el("div", "home-bg", { "aria-hidden": "true" });
    const mesh = el("div", "bg-mesh");
    for (let i = 1; i <= 3; i += 1) mesh.appendChild(el("span", "m" + i));
    const stars = el("div", "bg-stars");
    for (const st of starField(26, 2026)) {
      const s = el("span");
      s.style.cssText = "left:" + st.x + "%;top:" + st.y * 0.75 + "%;width:" + st.size + "px;height:" + st.size + "px;animation-delay:" + st.delay + "s;animation-duration:" + (st.dur + 2) + "s";
      stars.appendChild(s);
    }
    const lights = el("div", "bg-lights");
    const rnd = seeded(31);
    for (let i = 0; i < 7; i += 1) {
      const l = el("span");
      const size = 6 + Math.round(rnd() * 16);
      l.style.cssText = "left:" + Math.round(rnd() * 100) + "%;width:" + size + "px;height:" + size + "px;animation-duration:" + (70 + Math.round(rnd() * 60)) + "s," + (12 + Math.round(rnd() * 10)) + "s;animation-delay:-" + Math.round(rnd() * 90) + "s,-" + Math.round(rnd() * 10) + "s;--sway:" + (20 + Math.round(rnd() * 60)) + "px;--c:" + (i % 4);
      lights.appendChild(l);
    }
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "bg-waves");
    svg.setAttribute("viewBox", "0 0 2880 220");
    svg.setAttribute("preserveAspectRatio", "none");
    [[16, 1, 0, "w1"], [10, 2, 1.7, "w2"]].forEach(([amp, waves, ph, cls]) => {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", wavePath(1440, 220, amp, waves, ph));
      path.setAttribute("class", cls);
      svg.appendChild(path);
    });
    bg.append(mesh, stars, lights, svg, el("div", "bg-grain"), el("div", "bg-vignette"));
    doc.body.insertBefore(bg, doc.body.firstChild);
    S.bg = bg;
    // the glows lean a little toward the pointer
    let raf = 0;
    let last = null;
    S.win.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse" || !onHome() || calm()) return;
      last = ev;
      if (raf) return;
      raf = S.win.requestAnimationFrame(() => {
        raf = 0;
        bg.style.setProperty("--gx", (last.clientX / S.win.innerWidth - 0.5).toFixed(3));
        bg.style.setProperty("--gy", (last.clientY / S.win.innerHeight - 0.5).toFixed(3));
      });
    }, { passive: true });
  }

  function paintBackground(ph) {
    if (!S.bg) return;
    let light = false;
    try {
      light = S.win.matchMedia("(prefers-color-scheme: light)").matches;
    } catch (_) {}
    S.phase = ph || S.phase || "dusk";
    const view = S.doc.body.dataset.view || "accueil";
    const cols = pagePalette(view, S.phase, light);
    // on the page, so the header's sky shares the same warm light
    cols.forEach((c, i) => S.doc.documentElement.style.setProperty("--bg-" + "abcd"[i], c));
    S.bg.setAttribute("data-phase", S.phase);
    S.bg.setAttribute("data-view", view);
  }

  // ---- clock

  function buildClock() {
    const clock = el("div", "home-clock", { "aria-hidden": "true" });
    const face = el("span", "home-clock-face");
    S.cols = [];
    for (let i = 0; i < 4; i += 1) {
      if (i === 2) face.appendChild(Object.assign(el("span", "home-colon"), { textContent: ":" }));
      const odo = el("span", "home-odo");
      const col = el("span", "home-odo-col");
      for (let d = 0; d <= 9; d += 1) col.appendChild(Object.assign(el("span", "home-odo-d"), { textContent: String(d) }));
      col.style.setProperty("--k", String(i));
      odo.appendChild(col);
      face.appendChild(odo);
      S.cols.push(col);
    }
    const sec = el("span", "home-clock-sec");
    sec.appendChild(el("i"));
    clock.append(face, sec);
    S.sec = sec.firstChild;
    const head = S.hero.querySelector(".home-hero-head");
    const status = head && head.querySelector(".home-status");
    if (head) head.insertBefore(clock, status || null);
    else S.hero.appendChild(clock);
    S.clock = clock;
  }

  function paintClock(date, spin) {
    if (!S.clock) return;
    const ds = digits(date);
    const key = ds.join("");
    if (spin && !calm()) {
      // the odometer runs up from 00:00 to now
      for (const c of S.cols) {
        c.style.transition = "none";
        c.style.transform = "translateY(0)";
      }
      void S.clock.offsetWidth;
      for (const c of S.cols) c.style.transition = "";
    }
    if (key !== S.last || spin) {
      S.cols.forEach((c, i) => (c.style.transform = "translateY(" + -ds[i] * 1.2 + "em)")); // rows 1.2em apart: no neighbour peeks in
      if (S.last && key !== S.last && !spin) anim(S.clock, [{ filter: "brightness(1.6)" }, { filter: "none" }], { duration: 700 });
      S.last = key;
    }
    if (S.sec) {
      const s = date.getSeconds();
      S.sec.style.transition = s === 0 || calm() ? "none" : "";
      S.sec.style.transform = "scaleX(" + ((s + 1) / 60).toFixed(4) + ")"; // perf11: a transform, not width: no layout every frame
    }
  }

  // ---- greeting

  function splitGreeting(animate) {
    const g = S.doc.getElementById("home-greet");
    if (!g) return;
    const text = g.textContent;
    const mine = g.firstElementChild && g.firstElementChild.classList.contains("home-ch") && g.dataset.fxText === text;
    if (!mine) {
      S.splitting = true;
      const changed = g.dataset.fxText !== undefined && g.dataset.fxText !== text;
      g.dataset.fxText = text;
      g.setAttribute("aria-label", text);
      g.textContent = "";
      [...text].forEach((ch, i) => {
        const s = el("span", "home-ch" + (ch === " " ? " is-sp" : ""), { "aria-hidden": "true" });
        s.textContent = ch;
        s.style.setProperty("--c", String(i));
        g.appendChild(s);
      });
      S.splitting = false;
      if (changed) animate = true;
    }
    if (animate && !calm()) {
      g.classList.remove("is-in");
      void g.offsetWidth;
      g.classList.add("is-in");
    }
  }

  function watchGreeting() {
    const g = S.doc.getElementById("home-greet");
    if (!g) return;
    new S.win.MutationObserver(() => {
      if (!S.splitting) splitGreeting(false);
    }).observe(g, { childList: true, characterData: true, subtree: true });
  }

  // ---- pointer: spotlight, tilt, parallax

  const LIGHT = ".home-act, section.hq, .home-next, .icon-btn, .device-tile, .carnet-home-resume";

  function bindPointer() {
    let pending = null;
    let lit = null;
    const apply = () => {
      S.raf = 0;
      const ev = pending;
      if (!ev) return;
      const t = ev.target.closest && ev.target.closest(LIGHT);
      const tilt = ev.target.closest && ev.target.closest(".home-act, .home-next, .carnet-home-resume");
      for (const n of [t, tilt]) {
        if (!n) continue;
        const r = n.getBoundingClientRect();
        n.style.setProperty("--mx", ev.clientX - r.left + "px");
        n.style.setProperty("--my", ev.clientY - r.top + "px");
      }
      if (tilt && !calm()) {
        const r = tilt.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width - 0.5;
        const py = (ev.clientY - r.top) / r.height - 0.5;
        tilt.style.setProperty("--ry", (px * 12).toFixed(2) + "deg");
        tilt.style.setProperty("--rx", (-py * 12).toFixed(2) + "deg");
        tilt.classList.add("is-tilting");
      }
      if (lit && lit !== tilt) reset(lit);
      lit = tilt;
      // the sky drifts the other way
      if (S.sky && ev.target.closest && ev.target.closest("#hq-banner")) {
        const r = S.hero.getBoundingClientRect();
        S.sky.style.setProperty("--px", ((ev.clientX - r.left) / r.width - 0.5).toFixed(3));
        S.sky.style.setProperty("--py", ((ev.clientY - r.top) / r.height - 0.5).toFixed(3));
      }
    };
    const reset = (n) => {
      n.style.removeProperty("--rx");
      n.style.removeProperty("--ry");
      n.classList.remove("is-tilting");
    };
    S.home.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse") return;
      pending = ev;
      if (!S.raf) S.raf = S.win.requestAnimationFrame(apply);
    });
    S.home.addEventListener("pointerleave", () => {
      if (lit) reset(lit);
      lit = null;
      if (S.sky) {
        S.sky.style.setProperty("--px", "0");
        S.sky.style.setProperty("--py", "0");
      }
    });
  }

  // ---- press: ripple, sparks, the icon's gesture

  const RIPPLE = ".home-act, .icon-btn, .home-chip, .home-next, .carnet-home-resume, .carnet-home-chip, .chip, .home-status, #hq-quick-scenes button, #hq-scenes button, #hq-custom-actions button, .carnet-home-actions button";

  function sparks(x, y, n) {
    if (calm()) return;
    for (let i = 0; i < n; i += 1) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const d = 22 + Math.random() * 26;
      const p = el("span", "home-spark" + (i % 3 === 0 ? " is-dot" : ""), { "aria-hidden": "true" });
      p.style.left = x + "px";
      p.style.top = y + "px";
      S.doc.body.appendChild(p);
      const an = anim(p, [{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: "translate(" + Math.cos(a) * d + "px," + (Math.sin(a) * d - 8) + "px) scale(.9)", opacity: 1, offset: 0.55 },
        { transform: "translate(" + Math.cos(a) * d * 1.2 + "px," + (Math.sin(a) * d + 16) + "px) scale(.2)", opacity: 0 }], { duration: 560 + Math.random() * 300, easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards" });
      if (an) an.finished.then(() => p.remove(), () => p.remove());
      else p.remove();
    }
  }

  function bindPress() {
    S.home.addEventListener("pointerdown", (ev) => {
      const b = ev.target.closest && ev.target.closest(RIPPLE);
      if (!b || calm() || b.disabled) return;
      const r = b.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.2;
      const rip = el("span", "home-ripple", { "aria-hidden": "true" });
      rip.style.cssText = "left:" + (ev.clientX - r.left) + "px;top:" + (ev.clientY - r.top) + "px;width:" + size + "px;height:" + size + "px";
      b.classList.add("has-ripple");
      b.appendChild(rip);
      const a = anim(rip, [{ transform: "translate(-50%,-50%) scale(0)", opacity: 0.45 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 0 }], { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
      if (a) a.finished.then(() => rip.remove(), () => rip.remove());
      else rip.remove();
    });
    S.home.addEventListener("click", (ev) => {
      const b = ev.target.closest && ev.target.closest(".home-act, .home-pc .icon-btn");
      if (!b || calm()) return;
      b.classList.remove("is-fire");
      void b.offsetWidth;
      b.classList.add("is-fire");
      S.win.setTimeout(() => b.classList.remove("is-fire"), 900);
      const ico = b.querySelector(".home-act-ico, .ico");
      if (ico) {
        const r = ico.getBoundingClientRect();
        sparks(r.left + r.width / 2, r.top + r.height / 2, 10);
      }
    });
  }

  // ---- lists: lines are dealt in; new ones flash

  function watchList(id, sel, onNew) {
    const n = S.doc.getElementById(id);
    if (!n) return;
    const seen = new Set();
    let first = true;
    const run = () => {
      const items = [...n.querySelectorAll(sel)];
      let k = 0;
      let real = 0;
      for (const it of items) {
        if (it.classList.contains("home-skel-row") || it.classList.contains("device-skel") || it.classList.contains("visually-hidden")) continue;
        const key = (it.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!key) continue;
        real += 1;
        if (it.__fxSeen) continue;
        it.__fxSeen = true;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!calm()) {
          it.style.setProperty("--fxk", String(Math.min(k, 12)));
          k += 1;
          it.classList.add(first ? "fx-in" : "fx-new");
        }
        if (onNew) onNew(it, first);
      }
      if (real) first = false;
    };
    let queued = false;
    new S.win.MutationObserver(() => {
      if (queued) return;
      queued = true;
      S.win.requestAnimationFrame(() => {
        queued = false;
        run();
      });
    }).observe(n, { childList: true, subtree: true });
    run();
  }

  /** Opening Accueil again replays the lines of every list. */
  function replayLists() {
    if (calm()) return;
    for (const id of ["hq-recents", "hq-cal-today", "hq-since-list", "hq-devices"]) {
      const n = S.doc.getElementById(id);
      if (!n) continue;
      let k = 0;
      for (const it of n.querySelectorAll(":scope > li, .hq-list > li, .device-tile")) {
        if (!it.__fxSeen) continue;
        it.classList.remove("fx-in", "fx-new");
        it.style.setProperty("--fxk", String(Math.min(k, 12)));
        k += 1;
      }
      void n.offsetWidth;
      for (const it of n.querySelectorAll(":scope > li, .hq-list > li, .device-tile")) if (it.__fxSeen) it.classList.add("fx-in");
    }
    for (const r of S.doc.querySelectorAll("#hq-devices .device-ring")) {
      r.classList.remove("fx-ring");
      void r.offsetWidth;
      r.classList.add("fx-ring");
    }
  }

  // ---- entering Accueil

  function enter() {
    const now = hqNow();
    paintSky(now);
    paintClock(now, true);
    splitGreeting(true);
    if (calm()) return;
    if (S.orb) anim(S.orb, [{ transform: "translate(-50%,-50%) translateY(46px) scale(.6)", opacity: 0 }, { transform: "translate(-50%,-50%)", opacity: 1 }], { duration: 1200, easing: "cubic-bezier(.2,.8,.2,1)" });
    if (S.sky) anim(S.sky, [{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: "ease-out" });
    replayLists();
  }

  function start(win) {
    S.win = win;
    S.doc = win.document;
    const boot = () => {
      S.hero = S.doc.getElementById("hq-banner");
      S.home = S.doc.querySelector(".home-v2");
      if (!S.hero || !S.home || S.home.classList.contains("home-fx")) return;
      S.home.classList.add("home-fx");
      buildBackground();
      buildSky();
      buildClock();
      splitGreeting(false);
      watchGreeting();
      bindPointer();
      bindPress();
      watchList("hq-recents", ":scope > li");
      watchList("hq-since-list", ":scope > li");
      watchList("hq-cal-today", "li");
      watchList("hq-attention", ":scope > li");
      watchList("hq-devices", ".device-tile", (tile) => {
        const ring = tile.querySelector(".device-ring");
        if (ring && !calm()) ring.classList.add("fx-ring");
      });
      watchList("hq-carnet-home", ".carnet-home-resume, .carnet-home-list li");
      const now = hqNow();
      paintSky(now);
      paintClock(now, onHome());
      if (onHome()) splitGreeting(true);
      let last = S.doc.body.dataset.view;
      new win.MutationObserver(() => {
        const v = S.doc.body.dataset.view;
        if (v === last) return;
        last = v;
        syncPause();
        paintBackground(); // each page has its own sunset
        if (v === "accueil") enter();
      }).observe(S.doc.body, { attributes: true, attributeFilter: ["data-view"] });
      win.setInterval(() => {
        if (S.doc.hidden || !onHome()) return;
        const d = hqNow();
        paintClock(d, false);
        if (d.getSeconds() === 0) paintSky(d);
      }, 1000);
      shootingStars();
      S.home.classList.toggle("is-fine", fine());
      S.doc.addEventListener("visibilitychange", syncPause);
      if (typeof win.IntersectionObserver === "function") {
        new win.IntersectionObserver((es) => {
          S.heroOut = !es[es.length - 1].isIntersecting;
          if (S.win.HqMotion) S.win.HqMotion.setHomeSeen(!S.heroOut);
          syncPause();
        }).observe(S.hero);
      }
      syncPause();
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure };
});
