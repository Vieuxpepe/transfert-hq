/* Transfert HQ — Carnet constellation (assets/hq-constellation.css, server: GET /api/carnet?graph=1 in hq_carnet_links.graph).
 *
 * The notebook as a night sky: every page is a star, every link a faint line. Projects are bright stars that pull their
 * pages into clusters, the things pages cite (sources, files, drawings…) are small coloured stars, and orphan pages
 * (no project, no link) drift slowly on the outer edge. Wheel / pinch zooms around the pointer, drag pans, a star shows
 * its title and neighbours on hover, and a click flies into it and opens the page in the Carnet.
 *
 * Two layers: pure helpers (Node-testable: buildGraph, hueOf, step, settle, hitTest) and the DOM sheet (mount).
 * Read-only: nothing is written anywhere, nothing is kept in browser storage. Plain ES2020, no HTML-string sinks.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqConstellation = api;
    if (root.document) api.boot(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const KIND_COLOR = { source: "#fcd34d", file: "#7dd3fc", drawing: "#f9a8d4", model: "#86efac", media: "#c4b5fd" };
  const KIND_LABEL = { source: "Source", file: "Fichier", drawing: "Dessin", model: "Modèle 3D", media: "Média" };
  const RECENT_SEC = 7 * 86400;

  // ------------------------------------------------------------------ pure helpers
  /** Stable hue (0–359) for an id: a project keeps its colour from one visit to the next. */
  function hueOf(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 360);
  }

  /** Small seeded PRNG so the sky has the same shape every time it opens. */
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  }

  /** Nodes and links from the /api/carnet?graph=1 payload. Positions are seeded: projects on a ring, their pages around
   * them, orphans on the outer ring, everything else near the centre. */
  function buildGraph(data, now) {
    const nodes = [], byId = new Map(), links = [];
    const rand = rng(hueOf(String((data.pages || []).length) + ":" + String((data.projects || []).length)) + 7);
    const projects = (data.projects || []).filter((p) => p && typeof p.id === "string");
    const pr = 180 + 40 * Math.sqrt(projects.length);
    projects.forEach((p, i) => {
      const a = (i / Math.max(1, projects.length)) * Math.PI * 2 - Math.PI / 2;
      const n = { id: "project:" + p.id, type: "project", label: p.name, hue: hueOf(p.id), archived: !!p.archived,
        x: Math.cos(a) * pr, y: Math.sin(a) * pr, ax: Math.cos(a) * pr, ay: Math.sin(a) * pr, vx: 0, vy: 0, deg: 0, r: 6 };
      nodes.push(n); byId.set(n.id, n);
    });
    for (const p of data.pages || []) {
      if (!p || typeof p.id !== "string") continue;
      const proj = p.project_id ? byId.get("project:" + p.project_id) : null;
      const cx = proj ? proj.x : 0, cy = proj ? proj.y : 0;
      const n = { id: "note:" + p.id, pageId: p.id, type: "page", label: p.title || "Page sans titre", project: proj ? proj.id : null,
        hue: proj ? proj.hue : 210, pinned: !!p.pinned, recent: now - (p.updated_at || 0) < RECENT_SEC,
        x: cx + (rand() - 0.5) * 120, y: cy + (rand() - 0.5) * 120, vx: 0, vy: 0, deg: 0, r: 2 };
      nodes.push(n); byId.set(n.id, n);
    }
    for (const t of data.targets || []) {
      if (!t || typeof t.id !== "string") continue;
      const n = { id: t.id, type: "target", kind: t.kind, label: t.label || t.id, x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200, vx: 0, vy: 0, deg: 0, r: 1.6 };
      nodes.push(n); byId.set(n.id, n);
    }
    for (const e of data.edges || []) {
      const a = byId.get("note:" + e.from), b = byId.get(e.to);
      if (!a || !b || a === b) continue;
      links.push({ a, b, w: Math.min(3, e.count || 1) });
      a.deg++; b.deg++;
    }
    // Orphans: a page with no project and no line at all drifts on the outer ring.
    const orphans = nodes.filter((n) => n.type === "page" && !n.project && n.deg === 0);
    const or = pr + 260 + 6 * Math.sqrt(nodes.length);
    orphans.forEach((n, i) => {
      n.orphan = true;
      n.orbit = (i / Math.max(1, orphans.length)) * Math.PI * 2 + rand() * 0.3;
      n.orbitR = or + (rand() - 0.5) * 70;
      n.x = Math.cos(n.orbit) * n.orbitR; n.y = Math.sin(n.orbit) * n.orbitR;
    });
    for (const n of nodes) {
      if (n.type === "page") n.r = 2.2 + Math.sqrt(n.deg) * 1.3 + (n.pinned ? 1 : 0);
      else if (n.type === "project") n.r = 6 + Math.sqrt(nodes.filter((m) => m.project === n.id).length) * 0.9;
      else n.r = 1.6 + Math.sqrt(n.deg) * 0.7;
    }
    const neighbors = new Map(nodes.map((n) => [n, new Set()]));
    for (const l of links) { neighbors.get(l.a).add(l.b); neighbors.get(l.b).add(l.a); }
    for (const n of nodes) if (n.project) { const p = byId.get(n.project); neighbors.get(n).add(p); neighbors.get(p).add(n); }
    return { nodes, links, byId, neighbors, orphans: orphans.length, ringR: pr };
  }

  /** One force-simulation step (alpha = temperature, 1 → 0). Grid-bucketed repulsion keeps it near O(n). */
  function step(g, alpha) {
    const nodes = g.nodes, CELL = 90;
    const grid = new Map();
    for (const n of nodes) {
      if (n.orphan) continue;
      const k = Math.floor(n.x / CELL) + "," + Math.floor(n.y / CELL);
      let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(n);
    }
    for (const n of nodes) {
      if (n.orphan) continue;
      const gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b = grid.get((gx + dx) + "," + (gy + dy));
        if (!b) continue;
        for (const m of b) {
          if (m === n) continue;
          let ddx = n.x - m.x, ddy = n.y - m.y, d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) { ddx = (Math.random() - 0.5); ddy = (Math.random() - 0.5); d2 = 0.5; }
          if (d2 > CELL * CELL) continue;
          const f = (n.type === "project" || m.type === "project" ? 900 : 260) / d2;
          n.vx += ddx * f * alpha; n.vy += ddy * f * alpha;
        }
      }
    }
    for (const l of g.links) {
      if (l.a.orphan || l.b.orphan) continue;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const want = l.b.type === "target" ? 34 : 70;
      const f = ((d - want) / d) * 0.04 * l.w * alpha;
      l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f;
    }
    for (const n of nodes) {
      if (n.orphan) continue;
      if (n.type === "project") { n.vx += (n.ax - n.x) * 0.08 * alpha; n.vy += (n.ay - n.y) * 0.08 * alpha; }
      else if (n.project) {
        const p = g.byId.get(n.project), dx = p.x - n.x, dy = p.y - n.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 55) / d) * 0.05 * alpha; n.vx += dx * f; n.vy += dy * f;
      } else { n.vx -= n.x * 0.004 * alpha; n.vy -= n.y * 0.004 * alpha; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
    }
  }

  /** Run the simulation to rest without drawing (reduced motion, tests). */
  function settle(g, ticks) {
    for (let i = 0, n = ticks || 260; i < n; i++) step(g, 1 - i / n);
    return g;
  }

  /** Node under a world point within `tol` world units (plus the node's own radius), or null. */
  function hitTest(g, wx, wy, tol) {
    let best = null, bestD = Infinity;
    for (const n of g.nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy) - n.r;
      if (d <= tol && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /** World bounding box of the nodes (for « fit »). */
  function bounds(g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    if (!isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
    return { x0, y0, x1, y1 };
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
    if (doc.getElementById("hq-sky")) return null;
    const reduced = () => !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
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
    const icon = (d) => {
      const ns = "http://www.w3.org/2000/svg";
      const s = doc.createElementNS(ns, "svg");
      s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "sky-ico");
      const p = doc.createElementNS(ns, "path");
      p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.8"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
      s.appendChild(p);
      return s;
    };
    const STAR_D = "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z";

    const canvas = el("canvas", { class: "sky-canvas", "aria-hidden": "true" });
    const search = el("input", { type: "search", class: "sky-search", placeholder: "Trouver une étoile…", "aria-label": "Chercher une page", autocomplete: "off" });
    const stats = el("p", { class: "sky-stats", role: "status" });
    const fitBtn = el("button", { type: "button", class: "sky-btn", "aria-label": "Tout voir", title: "Tout voir (F)" }, [icon("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")]);
    const closeBtn = el("button", { type: "button", class: "sky-btn", "aria-label": "Fermer", title: "Fermer (Échap)" }, [icon("M6 6l12 12M18 6 6 18")]);
    const tip = el("div", { class: "sky-tip", role: "tooltip", hidden: true }, [el("strong"), el("span")]);
    const legend = el("div", { class: "sky-legend", "aria-hidden": "true" }, [
      el("span", { class: "sky-lg-page", text: "Page" }), el("span", { class: "sky-lg-project", text: "Projet" }),
      ...Object.keys(KIND_COLOR).map((k) => el("span", { "data-kind": k, text: KIND_LABEL[k] })),
      el("span", { class: "sky-lg-orphan", text: "Orpheline" }),
    ]);
    const head = el("header", { class: "sky-head" }, [
      el("div", { class: "sky-title" }, [icon(STAR_D), el("span", { text: "Constellation du Carnet" })]),
      search, el("div", { class: "sky-actions" }, [fitBtn, closeBtn]),
    ]);
    const sheet = el("div", { id: "hq-sky", class: "sky", role: "dialog", "aria-modal": "true", "aria-label": "Constellation du Carnet", hidden: true }, [
      canvas, head, stats, legend, tip,
    ]);
    doc.body.appendChild(sheet);

    const launcher = el("button", {
      type: "button", class: "view-search sky-launch", id: "btn-constellation", "aria-label": "Constellation du Carnet",
      "data-help": "Constellation : toutes les pages du Carnet comme un ciel étoilé, reliées par leurs liens.",
    }, [icon(STAR_D)]);
    const tools = doc.querySelector(".view-bar .view-tools, .home-hero-head .view-tools");
    if (tools) tools.insertBefore(launcher, doc.getElementById("btn-search-bar") || tools.firstChild);

    const S = { open: false, g: null, cam: { x: 0, y: 0, k: 1 }, alpha: 0, raf: 0, hover: null, focus: null, matches: null,
      pointers: new Map(), pinch: null, drag: null, fly: null, dust: [], dpr: 1, w: 0, h: 0, t0: 0, from: null };

    function makeDust() {
      const r = rng(1234567);
      S.dust = Array.from({ length: 260 }, () => ({ x: r(), y: r(), s: r() * 1.2 + 0.3, p: r() * Math.PI * 2 }));
    }
    makeDust();

    function resize() {
      const r = sheet.getBoundingClientRect();
      S.dpr = Math.min(win.devicePixelRatio || 1, 2);
      S.w = r.width; S.h = r.height;
      canvas.width = Math.max(1, Math.round(r.width * S.dpr));
      canvas.height = Math.max(1, Math.round(r.height * S.dpr));
    }
    const toScreen = (x, y) => ({ x: (x - S.cam.x) * S.cam.k + S.w / 2, y: (y - S.cam.y) * S.cam.k + S.h / 2 });
    const toWorld = (sx, sy) => ({ x: (sx - S.w / 2) / S.cam.k + S.cam.x, y: (sy - S.h / 2) / S.cam.k + S.cam.y });

    function fit(animate) {
      if (!S.g) return;
      const b = bounds(S.g), pad = 60;
      const k = Math.min((S.w - pad * 2) / Math.max(1, b.x1 - b.x0), (S.h - pad * 2 - 80) / Math.max(1, b.y1 - b.y0), 2.2);
      const target = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 + 20 / k, k: Math.max(0.12, k) };
      if (animate && !reduced()) flyTo(target, 500); else S.cam = target;
      kick();
    }

    function flyTo(target, ms, done) {
      S.fly = { from: Object.assign({}, S.cam), to: target, t0: win.performance.now(), ms, done };
      kick();
    }

    // ---- drawing
    function draw(t) {
      const c = canvas.getContext("2d");
      if (!c) return;
      const g = S.g, dpr = S.dpr, k = S.cam.k;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, S.w, S.h);
      // dust: a slow parallax layer behind everything
      const still = reduced();
      c.fillStyle = "#fff";
      for (const d of S.dust) {
        const px = ((d.x * S.w - S.cam.x * 0.05 * k) % S.w + S.w) % S.w, py = ((d.y * S.h - S.cam.y * 0.05 * k) % S.h + S.h) % S.h;
        c.globalAlpha = still ? 0.35 : 0.2 + 0.25 * (1 + Math.sin(t / 1300 + d.p)) / 2;
        c.fillRect(px, py, d.s, d.s);
      }
      c.globalAlpha = 1;
      if (!g) return;
      const hot = S.hover || S.focus;
      const near = hot ? g.neighbors.get(hot) : null;
      const match = S.matches;
      // links
      c.lineWidth = 1;
      for (const l of g.links) {
        const a = toScreen(l.a.x, l.a.y), b = toScreen(l.b.x, l.b.y);
        const lit = hot && (l.a === hot || l.b === hot);
        c.strokeStyle = lit ? "rgba(255,255,255,.7)" : "rgba(170,190,255," + (hot ? 0.05 : 0.13) + ")";
        c.lineWidth = lit ? 1.4 : 0.8 + (l.w - 1) * 0.3;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
      // faint threads from pages to their project
      c.setLineDash([2, 5]);
      for (const n of g.nodes) {
        if (!n.project) continue;
        const p = g.byId.get(n.project);
        const lit = hot && (hot === n || hot === p);
        if (!lit && k < 0.6) continue;
        const a = toScreen(n.x, n.y), b = toScreen(p.x, p.y);
        c.strokeStyle = "hsla(" + p.hue + ",80%,80%," + (lit ? 0.55 : hot ? 0.03 : 0.08) + ")";
        c.lineWidth = 1; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
      c.setLineDash([]);
      // stars
      for (const n of g.nodes) {
        const s = toScreen(n.x, n.y);
        if (s.x < -40 || s.y < -40 || s.x > S.w + 40 || s.y > S.h + 40) continue;
        const dim = (hot && n !== hot && !(near && near.has(n))) || (match && !match.has(n));
        const tw = still ? 1 : 0.85 + 0.15 * Math.sin(t / 700 + n.x * 0.05 + n.y * 0.03);
        const r = Math.max(1, n.r * Math.sqrt(k)) * (n === hot ? 1.6 : 1);
        let color;
        if (n.type === "project") color = "hsl(" + n.hue + ",90%,82%)";
        else if (n.type === "target") color = KIND_COLOR[n.kind] || "#cbd5e1";
        else if (n.orphan) color = "#9aa6c8";
        else color = "hsl(" + n.hue + "," + (n.project ? 70 : 25) + "%," + (n.recent ? 90 : 80) + "%)";
        c.globalAlpha = (dim ? 0.18 : 1) * tw;
        if (n.type === "project" || n.recent || n === hot || n.pinned) {
          const glow = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * (n.type === "project" ? 6 : 4));
          glow.addColorStop(0, color); glow.addColorStop(1, "rgba(0,0,0,0)");
          c.fillStyle = glow; c.globalAlpha *= n.type === "project" ? 0.55 : 0.35;
          c.beginPath(); c.arc(s.x, s.y, r * (n.type === "project" ? 6 : 4), 0, Math.PI * 2); c.fill();
          c.globalAlpha = (dim ? 0.18 : 1) * tw;
        }
        c.fillStyle = color;
        c.beginPath(); c.arc(s.x, s.y, r, 0, Math.PI * 2); c.fill();
        if (n.pinned || n.type === "project") { // a four-point sparkle
          c.strokeStyle = color; c.lineWidth = 1; const L = r * 2.6;
          c.beginPath(); c.moveTo(s.x - L, s.y); c.lineTo(s.x + L, s.y); c.moveTo(s.x, s.y - L); c.lineTo(s.x, s.y + L); c.stroke();
        }
      }
      c.globalAlpha = 1;
      // labels: projects always; pages when zoomed in or lit; never more than ~70
      c.textAlign = "center"; c.textBaseline = "top";
      let budget = 70;
      const label = (n, size, weight, alpha) => {
        if (budget-- <= 0) return;
        const s = toScreen(n.x, n.y), r = Math.max(1, n.r * Math.sqrt(k));
        const text = n.label.length > 42 ? n.label.slice(0, 40) + "…" : n.label;
        c.font = weight + " " + size + "px " + (n.type === "project" ? '"Fraunces HQ", Georgia, serif' : '"Inter HQ", system-ui, sans-serif');
        c.globalAlpha = alpha;
        c.fillStyle = "rgba(4,6,20,.65)";
        const w = c.measureText(text).width;
        c.fillRect(s.x - w / 2 - 4, s.y + r + 4, w + 8, size + 5);
        c.fillStyle = "#f5f7ff";
        c.fillText(text, s.x, s.y + r + 6);
      };
      for (const n of g.nodes) if (n.type === "project") label(n, 14, 600, hot && !(n === hot || (near && near.has(n))) ? 0.35 : 0.95);
      if (hot) { label(hot, 13, 600, 1); if (near) for (const m of near) if (m.type !== "project") label(m, 11, 500, 0.85); }
      if (match) for (const m of match) if (m !== hot) label(m, 11, 500, 0.9);
      const few = g.nodes.length <= 60; // a small sky is readable with every name on it
      if ((k > 1.5 || few) && !hot) for (const n of g.nodes) if (n.type === "page" && (n.deg >= 1 || few)) label(n, 11, 500, n.orphan ? 0.5 : 0.75);
      c.globalAlpha = 1;
    }

    function frame(t) {
      S.raf = 0;
      if (!S.open) return;
      let busy = false;
      if (S.g && S.alpha > 0.005) { step(S.g, S.alpha); S.alpha *= 0.985; busy = true; }
      if (S.g && !reduced()) {
        for (const n of S.g.nodes) if (n.orphan) { n.orbit += 0.00035; n.x = Math.cos(n.orbit) * n.orbitR; n.y = Math.sin(n.orbit) * n.orbitR; }
        busy = true; // the drift and the twinkle keep the sky alive
      }
      if (S.fly) {
        const f = S.fly, u = Math.min(1, (t - f.t0) / f.ms), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        const lk = Math.log(f.from.k) + (Math.log(f.to.k) - Math.log(f.from.k)) * e;
        S.cam = { x: f.from.x + (f.to.x - f.from.x) * e, y: f.from.y + (f.to.y - f.from.y) * e, k: Math.exp(lk) };
        if (u >= 1) { const done = f.done; S.fly = null; if (done) done(); } else busy = true;
      }
      draw(t);
      if (busy && doc.visibilityState !== "hidden") S.raf = win.requestAnimationFrame(frame);
    }
    function kick() { if (S.open && !S.raf) S.raf = win.requestAnimationFrame(frame); }

    // ---- data
    async function load() {
      stats.textContent = "Chargement du ciel…";
      try {
        if (typeof win.api !== "function") throw new Error("HQ indisponible");
        const data = await win.api("/api/carnet?graph=1", { timeoutMs: 15000 });
        S.g = buildGraph(data, Date.now() / 1000);
        const pages = S.g.nodes.filter((n) => n.type === "page").length;
        const projects = S.g.nodes.filter((n) => n.type === "project").length;
        stats.textContent = pages + " page" + (pages > 1 ? "s" : "") + " · " + projects + " projet" + (projects > 1 ? "s" : "") + " · " +
          S.g.links.length + " lien" + (S.g.links.length > 1 ? "s" : "") + " · " + S.g.orphans + " orpheline" + (S.g.orphans > 1 ? "s" : "") +
          (data.truncated ? " · ciel partiel" : "");
        if (!pages) stats.textContent = "Le Carnet est encore vide : pas d'étoile pour l'instant.";
        if (reduced()) { settle(S.g, 260); S.alpha = 0; } else { settle(S.g, 40); S.alpha = 0.9; }
        fit(false);
        if (!reduced()) { const k = S.cam.k; S.cam.k = k * 0.55; flyTo({ x: S.cam.x, y: S.cam.y, k }, 900); }
      } catch (e) {
        S.g = null;
        stats.textContent = (e && e.message) || "Ciel indisponible";
      }
      kick();
    }

    // ---- interaction
    function showTip(n, sx, sy) {
      if (!n) { tip.hidden = true; return; }
      tip.firstChild.textContent = n.label;
      const extra = n.type === "project" ? "Projet" + (n.archived ? " (archivé)" : "") :
        n.type === "target" ? (KIND_LABEL[n.kind] || n.kind) : n.orphan ? "Page orpheline" :
        (n.deg ? n.deg + " lien" + (n.deg > 1 ? "s" : "") : "Sans lien") + (n.project && S.g.byId.get(n.project) ? " · " + S.g.byId.get(n.project).label : "");
      tip.lastChild.textContent = extra;
      tip.hidden = false;
      const x = Math.min(S.w - 240, Math.max(8, sx + 14)), y = Math.min(S.h - 60, Math.max(8, sy + 14));
      tip.style.transform = "translate(" + x + "px," + y + "px)";
    }
    function pick(sx, sy, touch) {
      if (!S.g) return null;
      const w = toWorld(sx, sy);
      return hitTest(S.g, w.x, w.y, (touch ? 16 : 8) / S.cam.k);
    }
    function activate(n) {
      if (!n) return;
      if (n.type === "project") {
        const members = S.g.nodes.filter((m) => m.project === n.id).concat([n]);
        const b = bounds({ nodes: members });
        const k = Math.min(3, Math.min(S.w / Math.max(80, b.x1 - b.x0 + 160), S.h / Math.max(80, b.y1 - b.y0 + 200)));
        flyTo({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, k }, reduced() ? 1 : 650);
        return;
      }
      if (n.type === "target") {
        const id = n.id.slice(n.kind.length + 1);
        if (n.kind === "file" || n.kind === "media" || n.kind === "model") {
          const dir = id.split("/").slice(0, -1).join("/");
          go(n, () => { if (typeof win.navigate === "function") win.navigate(dir); });
        } else if (n.kind === "drawing") go(n, () => { if (typeof win.navigate === "function") win.navigate("Inbox/Drawings"); });
        else { S.focus = n; kick(); }
        return;
      }
      go(n, async () => {
        if (typeof win.hqOpenHit === "function") await win.hqOpenHit({ kind: "page", id: n.pageId });
        else if (typeof win.hqCarnetOpen === "function") await win.hqCarnetOpen(n.pageId);
      });
    }
    /** Fly into a star, flash, then close and open what it stands for. */
    function go(n, then) {
      S.focus = n;
      const finish = () => { close(); then(); };
      if (reduced()) { finish(); return; }
      sheet.classList.add("is-diving");
      flyTo({ x: n.x, y: n.y, k: Math.max(S.cam.k * 3, 6) }, 620, finish);
    }

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      S.fly = null;
      if (S.pointers.size === 2) {
        const [a, b] = [...S.pointers.values()];
        S.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.cam.k, mid: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
        S.drag = null;
      } else if (S.pointers.size === 1) {
        S.drag = { x: e.clientX, y: e.clientY, cx: S.cam.x, cy: S.cam.y, moved: false, touch: e.pointerType !== "mouse" };
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (S.pointers.has(e.pointerId)) S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (S.pinch && S.pointers.size === 2) {
        const [a, b] = [...S.pointers.values()];
        const k = Math.max(0.08, Math.min(12, S.pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, S.pinch.d)));
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        S.cam = { k, x: S.pinch.mid.x - (mx - S.w / 2) / k, y: S.pinch.mid.y - (my - S.h / 2) / k };
        kick(); return;
      }
      if (S.drag) {
        const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
        if (Math.hypot(dx, dy) > 5) S.drag.moved = true;
        if (S.drag.moved) { S.cam.x = S.drag.cx - dx / S.cam.k; S.cam.y = S.drag.cy - dy / S.cam.k; sheet.classList.add("is-panning"); showTip(null); kick(); }
        return;
      }
      if (e.pointerType === "mouse") {
        const n = pick(sx, sy, false);
        if (n !== S.hover) { S.hover = n; canvas.style.cursor = n ? "pointer" : "grab"; kick(); }
        showTip(n, sx, sy);
      }
    });
    const up = (e) => {
      const r = canvas.getBoundingClientRect();
      const wasDrag = S.drag;
      S.pointers.delete(e.pointerId);
      if (S.pointers.size < 2) S.pinch = null;
      if (S.pointers.size === 0) { S.drag = null; sheet.classList.remove("is-panning"); }
      if (e.type === "pointerup" && wasDrag && !wasDrag.moved) {
        const n = pick(e.clientX - r.left, e.clientY - r.top, wasDrag.touch);
        if (wasDrag.touch && n && n !== S.focus) { // first tap shows it, second tap flies in
          S.focus = n; showTip(n, e.clientX - r.left, e.clientY - r.top); kick();
        } else if (n) activate(n);
        else { S.focus = null; showTip(null); kick(); }
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && S.hover) { S.hover = null; showTip(null); kick(); } });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = toWorld(sx, sy);
      const k = Math.max(0.08, Math.min(12, S.cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      S.cam = { k, x: before.x - (sx - S.w / 2) / k, y: before.y - (sy - S.h / 2) / k };
      S.fly = null;
      kick();
    }, { passive: false });

    function runSearch(jump) {
      const q = search.value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (!S.g || !q) { S.matches = null; kick(); return; }
      const hits = S.g.nodes.filter((n) => n.label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(q));
      S.matches = new Set(hits);
      if (jump && hits.length) {
        const first = hits.find((n) => n.type === "page") || hits[0];
        if (hits.length === 1 || jump === "open") activate(first);
        else { S.focus = first; flyTo({ x: first.x, y: first.y, k: Math.max(S.cam.k, 2) }, reduced() ? 1 : 500); }
      }
      kick();
    }
    search.addEventListener("input", () => runSearch(false));
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(e.shiftKey ? true : "open"); } });

    // ---- open / close
    function open() {
      if (S.open) return;
      S.open = true;
      S.from = doc.activeElement;
      S.hover = S.focus = null; S.matches = null; search.value = "";
      sheet.hidden = false;
      sheet.classList.remove("is-diving");
      doc.documentElement.classList.add("sky-open");
      resize();
      win.requestAnimationFrame(() => sheet.classList.add("is-open"));
      load();
      win.setTimeout(() => { try { search.focus({ preventScroll: true }); } catch (_) {} }, 50);
    }
    function close() {
      if (!S.open) return;
      S.open = false;
      if (S.raf) win.cancelAnimationFrame(S.raf);
      S.raf = 0; S.fly = null;
      showTip(null);
      sheet.classList.remove("is-open");
      doc.documentElement.classList.remove("sky-open");
      const done = () => { if (!S.open) { sheet.hidden = true; sheet.classList.remove("is-diving"); } };
      if (reduced()) done(); else win.setTimeout(done, 280);
      if (S.from && typeof S.from.focus === "function" && S.from !== doc.body) { try { S.from.focus({ preventScroll: true }); } catch (_) {} }
    }

    launcher.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    fitBtn.addEventListener("click", () => fit(true));
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); if (search.value) { search.value = ""; runSearch(false); } else close(); }
      else if ((e.key === "f" || e.key === "F") && e.target !== search) { e.preventDefault(); fit(true); }
    });
    win.addEventListener("resize", () => { if (S.open) { resize(); kick(); } });
    doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible") kick(); });

    const h = { open, close, state: () => ({ open: S.open, nodes: S.g ? S.g.nodes.length : 0, links: S.g ? S.g.links.length : 0, cam: Object.assign({}, S.cam) }),
      graph: () => S.g, activate };
    win.hqConstellation = h;
    return h;
  }

  return { KIND_COLOR, hueOf, rng, buildGraph, step, settle, hitTest, bounds, boot, mount };
});
