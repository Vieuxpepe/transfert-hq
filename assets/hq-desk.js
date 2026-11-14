/* Transfert HQ — phone as a second screen (assets/hq-desk.css, server relay: hq_desk.py via /api/desk/*).
 *
 * Every HQ tab on a computer quietly hosts: it tells the relay what is open (view, drawing canvas size, what the Lecteur
 * plays) and long-polls for the phone's messages. On the phone, the « 2e écran » sheet (radial menu, or the view-bar
 * button) offers three things:
 *   - Pad: draw with a finger or an Apple Pencil (iPad: palm rejection, hover cursor on the PC) and the stroke appears live
 *     on the PC's Dessiner canvas (a normal pen stroke, undoable);
 *   - Lecteur: play / pause, seek, skip, volume and pick from the library, on the PC;
 *   - Lancer: pick a photo and flick it up; it uploads to Inbox/Photos and lands on the PC screen with a little flight.
 * Admin sessions only (the relay refuses anything else). Nothing is stored in the browser; messages live 60 s in the
 * bridge's memory. Plain ES2020, no HTML-string sinks. Pure helpers (norm, mergeMove, isPhoneLike, penGate, flickOk) are Node-testable.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqDesk = api;
    if (root.document) api.boot(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const VIEWS = ["dessiner", "lecteur", "accueil", "fichiers"];
  const FLUSH_GAP_MS = 12; // points go out as soon as the line is free, at most one new message per 12 ms
  const SMOOTH_LEVELS = [1, 0.5, 0.28]; // « Lissage » : non, léger, fort (share of the way the line follows the pen)
  const VIEW_MS = 33; // ~30 view updates a second; the queue still coalesces them
  const THICK = { fine: 0.0035, med: 0.009, bold: 0.02 };
  const ASSET_RE = /^asset-[0-9a-f]{24}$/;
  const PHOTO_FOLDER = "Inbox/Photos";

  // ------------------------------------------------------------------ pure helpers
  /** A point in a w × h box as 0..1 fractions, rounded to 4 decimals (small messages, sub-pixel enough). */
  function norm(x, y, w, h) {
    const f = (v, d) => Math.round(Math.min(1, Math.max(0, d ? v / d : 0)) * 10000) / 10000;
    return [f(x, w), f(y, h)];
  }

  /** Queue coalescing: a 'move' joins the last queued (not yet sent) 'move' of the same stroke. Returns true if merged. */
  function mergeMove(queue, msg) {
    const last = queue[queue.length - 1];
    if (last && last.type === "pad" && msg.type === "pad" && last.data.op === "hover" && msg.data.op === "hover") {
      last.data.pts = msg.data.pts; // only the latest hover position matters
      return true;
    }
    if (last && last.type === "pad" && msg.type === "pad" && last.data.op === "lift" && msg.data.op === "lift" &&
        last.data.phase === "move" && msg.data.phase === "move") {
      last.data.h = msg.data.h; // only the latest height matters
      return true;
    }
    if (last && last.type === "pad" && msg.type === "pad" && last.data.op === "view" && msg.data.op === "view") {
      const r = (v) => Math.round(v * 10000) / 10000;
      last.data.dx = r((Number(last.data.dx) || 0) + (Number(msg.data.dx) || 0));
      last.data.dy = r((Number(last.data.dy) || 0) + (Number(msg.data.dy) || 0));
      last.data.z = r((Number(last.data.z) || 1) * (Number(msg.data.z) || 1));
      last.data.cx = msg.data.cx; last.data.cy = msg.data.cy;
      return true;
    }
    if (last && last.type === "pad" && msg.type === "pad" && last.data.op === "erase" && msg.data.op === "erase" && last.data.s === msg.data.s && !msg.data.final) {
      if ((last.data.pts || []).length + (msg.data.pts || []).length > 600) return false;
      last.data.pts = (last.data.pts || []).concat(msg.data.pts || []);
      return true;
    }
    if (!last || last.type !== "pad" || msg.type !== "pad" || last.data.op !== "move" || msg.data.op !== "move" || last.data.s !== msg.data.s) return false;
    if (last.data.pts.length + msg.data.pts.length > 600) return false; // keep each message well under the relay's size cap
    last.data.pts = last.data.pts.concat(msg.data.pts);
    return true;
  }

  /** Phones and tablets (iPad included, Apple Pencil or not) drive; computers host. The PRIMARY pointer decides: an iPad's
   * is the finger (coarse) even with a Pencil, a touch-screen laptop's is the trackpad / mouse (fine). */
  function isPhoneLike(win) {
    return !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
  }

  /** Apple Pencil palm rejection: once a pen has been seen, finger touches do not draw (unless « Pencil + doigt » is on),
   * and a pen that comes down while a finger/palm stroke is open takes over. Returns "ignore" | "start" | "takeover". */
  function penGate(kind, penSeen, fingerToo, strokeKind) {
    if (kind === "touch" && penSeen && !fingerToo) return "ignore";
    if (!strokeKind) return "start";
    return kind === "pen" && strokeKind !== "pen" ? "takeover" : "ignore";
  }

  /** Did a release count as a flick up? (dy < 0 is up; velocities in px/ms.) */
  function flickOk(dy, vy) {
    return dy < -110 || (dy < -30 && vy < -0.55);
  }

  /** Two-finger step. prev/next are two points in the same space. z is the distance ratio, dx/dy the centre shift. */
  function pinchStep(prev, next) {
    if (!prev || !next || prev.length < 2 || next.length < 2) return null;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const c0 = mid(prev[0], prev[1]), c1 = mid(next[0], next[1]);
    const d0 = d(prev[0], prev[1]) || 1e-6, d1 = d(next[0], next[1]) || 1e-6;
    const r = (v) => Math.round(v * 10000) / 10000;
    return { cx: r(c1[0]), cy: r(c1[1]), dx: r(c1[0] - c0[0]), dy: r(c1[1] - c0[1]), z: r(d1 / d0) };
  }

  /** Two-finger tap = undo, three-finger tap = redo. A gesture that travels or lingers is not a tap. */
  function fingerTap(count, dt, move) {
    if (count !== 2 && count !== 3) return null;
    if (!(dt >= 0) || dt > 250 || !(move >= 0) || move >= 10) return null;
    return count === 2 ? "undo" : "redo";
  }

  function pointWidth(thick, kind, pressure, gamma) {
    const base = THICK[thick] || THICK.med;
    const g = gamma >= 0.5 && gamma <= 2 ? gamma : 1;
    if (kind === "pen" && pressure > 0) {
      const shaped = Math.pow(Math.min(1, pressure), g);
      return Math.round(base * (0.35 + 0.65 * shaped) * 10000) / 10000;
    }
    return base;
  }

  /** Two fingers that moved together straight up (no pinch, little sideways drift) lift a shape into 3D.
   * start/now: [[x, y], [x, y]] in px. Returns "lift", "view" or "" (not decided yet). */
  function liftIntent(start, now, ready) {
    if (!start || !now || start.length < 2 || now.length < 2) return "";
    const mid = (a) => [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
    const m0 = mid(start), m1 = mid(now), dx = m1[0] - m0[0], dy = m1[1] - m0[1];
    const d0 = Math.hypot(start[0][0] - start[1][0], start[0][1] - start[1][1]), d1 = Math.hypot(now[0][0] - now[1][0], now[0][1] - now[1][1]);
    if (Math.hypot(dx, dy) < 14 && Math.abs(d1 - d0) < 12) return ""; // wait for a clear movement before deciding
    const ratio = d0 > 0 ? d1 / d0 : 1;
    if (ready && dy < -10 && Math.abs(dx) < Math.abs(dy) * 0.6 && ratio > 0.85 && ratio < 1.18) return "lift";
    return "view";
  }
  /** Lift height 0..1 from how far the fingers (or the pen) went up, over 80 % of the pad's height. */
  function liftHeight(dyUp, padH) {
    return Math.max(0, Math.min(1, dyUp / Math.max(1, padH * 0.8)));
  }

  /** Pressure eased over a few samples, so the width does not flicker with every reading. */
  function easePressure(prev, p, k) {
    const v = isFinite(p) && p > 0 ? Math.min(1, p) : 0;
    if (!(prev > 0)) return v;
    return prev + (v - prev) * (k == null ? 0.4 : k);
  }
  /** A tilted Pencil draws a broader line, like shading with a real pencil: ×1 upright, up to ×1.8 when laid low.
   * Uses altitudeAngle (Safari) or tiltX/tiltY in degrees; no tilt data → 1. */
  function tiltFactor(altitude, tiltX, tiltY) {
    let fromVertical = null;
    if (isFinite(altitude) && altitude > 0 && altitude <= Math.PI / 2 + 1e-6) fromVertical = Math.PI / 2 - altitude;
    else if ((isFinite(tiltX) && tiltX) || (isFinite(tiltY) && tiltY)) {
      const tx = Math.tan(((tiltX || 0) * Math.PI) / 180), ty = Math.tan(((tiltY || 0) * Math.PI) / 180);
      fromVertical = Math.atan(Math.hypot(tx, ty));
    }
    if (fromVertical == null) return 1;
    const u = Math.max(0, Math.min(1, (fromVertical - 0.5) / 0.6)); // nothing until ~29° of tilt, full at ~63°
    return 1 + 0.8 * u * u * (3 - 2 * u);
  }
  /** « Lissage »: the line follows the pen part of the way each sample. level 0 = exact. */
  function streamline(prev, raw, level) {
    const k = SMOOTH_LEVELS[level] || 1;
    if (!prev || k >= 1) return raw.slice();
    return [prev[0] + (raw[0] - prev[0]) * k, prev[1] + (raw[1] - prev[1]) * k];
  }
  /** How long to wait before sending queued points: 0 = now. */
  function flushWait(now, last, gap) {
    return Math.max(0, (gap == null ? FLUSH_GAP_MS : gap) - (now - (last || 0)));
  }
  /** Only plain colours from the PC are used on the pad. */
  function safeColor(v) {
    const t = typeof v === "string" ? v.trim() : "";
    return /^#[0-9a-fA-F]{3,8}$/.test(t) || /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)$/.test(t) ? t : null;
  }

  /** Smooth a burst's lateness into the replay delay. Always stays inside 20–150 ms. */
  function tuneDelay(delay, lateness) {
    const base = isFinite(delay) ? delay : 40;
    const late = isFinite(lateness) ? Math.max(0, lateness) : base;
    return Math.max(20, Math.min(150, base * 0.65 + late * 0.35));
  }

  /**
   * Release stroke events whose time has come. `state.events` items are
   * {op:"pt", t, p} (t null = untimed, released at once) or {op:"end"|"cancel"|"undo"|"redo"}.
   * An end never leaves ahead of the points queued before it. `immediate` skips the delay.
   */
  function replayStep(state, now) {
    const evs = (state && state.events) || [];
    const immediate = !!(state && state.immediate);
    const delay = immediate ? 0 : tuneDelay(state && state.delay != null ? state.delay : 40, state && state.delay != null ? state.delay : 40);
    const t0 = state && isFinite(state.t0) ? state.t0 : now;
    const release = [];
    let i = 0, wait = null;
    while (i < evs.length) {
      const e = evs[i];
      if (e.op === "pt" && !immediate && e.t != null && isFinite(e.t)) {
        const due = t0 + e.t + delay;
        if (now < due) { wait = due - now; break; }
      }
      release.push(e);
      i++;
    }
    return { release, rest: evs.slice(i), wait, delay };
  }

  /** Pad send retry: keep order, retry network failures, drop 4xx and anything older than 20 s. */
  function retryDecision(status, ageMs) {
    if (!(ageMs >= 0) || ageMs > 20000) return "drop";
    if (status >= 400 && status < 500) return "drop";
    return "retry";
  }
  function retryWait(tries) {
    const n = Math.max(1, tries || 1);
    return Math.min(2000, 250 * Math.pow(2, n - 1));
  }

  /** Fit pressure^gamma to a light→heavy stroke. samples: [{p, target}] in 0..1. */
  function fitGamma(samples) {
    const rows = (samples || []).filter((s) => s && s.p > 0.02 && s.p <= 1 && s.target >= 0 && s.target <= 1);
    if (rows.length < 3) return 1;
    let best = 1, err = Infinity;
    for (let i = 0; i <= 30; i++) {
      const g = 0.5 + (i / 30) * 1.5;
      let e = 0;
      for (const s of rows) {
        const d = Math.pow(s.p, g) - s.target;
        e += d * d;
      }
      if (e < err) { err = e; best = Math.round(g * 100) / 100; }
    }
    return Math.max(0.5, Math.min(2, best));
  }

  /** May a still finger open the tool ring? Palm, Pencil and a second finger never may. */
  function ringGuard(o) {
    const g = o || {};
    if (g.kind === "pen" || g.penDown) return false;
    if (g.sincePen >= 0 && g.sincePen < 600) return false;
    if ((g.width || 0) > 40 || (g.height || 0) > 40) return false;
    if ((g.fingers || 1) > 1) return false;
    if ((g.moved || 0) > 8) return false;
    return true;
  }

  function padMsgId() {
    const n = Math.floor(Math.random() * 1e9).toString(36);
    return ("p" + n).replace(/[^0-9a-z]/g, "").slice(0, 12) || "p1";
  }

  function padTargets() {
    const targets = new Map();
    let active = "sketch";
    return {
      register(t) { if (t && t.id) targets.set(t.id, t); },
      unregister(id) { targets.delete(id); },
      get(id) { return targets.get(id) || null; },
      setActive(id) { active = id; },
      active() { return targets.get(active) || null; },
      pick() {
        const inp = targets.get("inpaint");
        if (inp && inp.ready && inp.ready()) { active = "inpaint"; return; }
        const sk = targets.get("sketch");
        if (sk && sk.ready && sk.ready()) { active = "sketch"; return; }
        active = "sketch";
      },
    };
  }

  const registry = padTargets();
  if (global.document) global.hqPadTargets = registry;

  // ------------------------------------------------------------------ shared plumbing
  function boot(win) {
    const doc = win.document;
    const go = () => { start(win).catch((e) => { if (win.console) win.console.error(e); }); };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go);
    else go();
  }

  function makeId(win) {
    const b = new Uint8Array(8);
    try { win.crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256); }
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function link(win, role) {
    const id = makeId(win);
    const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));
    const post = (path, body) => win.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: 8000 });
    const L = { id, role, running: false, onMessage: null, onPeer: null, queue: [], sending: false, peer: null, gen: 0 };
    L.publish = (state) => post("/api/desk/state", { role, client: id, state }).then((d) => { if (d && d.peer) setPeer(d.peer); }).catch(() => {});
    function setPeer(p) {
      const prev = L.peer;
      L.peer = p;
      if (L.onPeer && JSON.stringify(prev) !== JSON.stringify(p)) L.onPeer(p, prev);
    }
    L.send = (to, type, data) => {
      if (type === "pad" && data && typeof data === "object" && !data.id) data.id = padMsgId();
      const msg = { to, type, data, client: id };
      // a message already handed to the network (sending, or waiting to retry) is frozen: the server may have it under its
      // id, so points merged into it now would be lost on success and dropped as a duplicate on retry
      const last = L.queue[L.queue.length - 1];
      if ((last && last._busy) || !mergeMove(L.queue, msg)) L.queue.push(msg);
      pump();
    };
    async function pump() {
      if (L.sending) return;
      L.sending = true;
      try {
        while (L.queue.length) {
          const msg = L.queue[0];
          msg._busy = true;
          try {
            // only the wire fields: _busy / _tries / _failAt are local bookkeeping, and the relay refuses unknown keys
            await post("/api/desk/send", { to: msg.to, type: msg.type, data: msg.data, client: msg.client });
            L.queue.shift();
            msg._tries = 0;
            if (L.onRetry) L.onRetry(false);
          } catch (err) {
            const st = err && err.status;
            if (msg.type !== "pad") { L.queue.shift(); continue; }
            if (!msg._failAt) msg._failAt = Date.now();
            const decision = retryDecision(st, Date.now() - msg._failAt);
            if (decision !== "retry") {
              L.queue.shift();
              if (L.onRetry) L.onRetry(false);
              if (L.onGiveUp) L.onGiveUp();
              continue;
            }
            msg._tries = (msg._tries || 0) + 1;
            if (L.onRetry) L.onRetry(true);
            L.sending = false;
            win.setTimeout(pump, retryWait(msg._tries));
            return;
          }
        }
      } finally {
        if (L.sending) L.sending = false;
      }
    }
    L.start = () => {
      if (L.running) return;
      L.running = true;
      const gen = ++L.gen;
      (async () => {
        let after = -1, fails = 0;
        while (L.running && gen === L.gen) {
          try {
            const d = await win.api("/api/desk/poll?role=" + role + "&client=" + id + "&after=" + after + "&wait=20", { timeoutMs: 26000 });
            if (!L.running || gen !== L.gen) break;
            after = d.seq; fails = 0;
            setPeer(d.peer);
            for (const m of d.messages || []) { try { if (L.onMessage) L.onMessage(m); } catch (e) { if (win.console) win.console.error(e); } }
          } catch (e) {
            if (e && (e.status === 403 || e.status === 401)) { L.running = false; break; }
            fails++;
            await sleep(Math.min(15000, 1500 * fails));
          }
        }
      })();
    };
    L.stop = () => {
      if (!L.running) return;
      L.running = false; L.gen++;
      post("/api/desk/leave", { role, client: id }).catch(() => {});
    };
    return L;
  }

  async function start(win) {
    if (typeof win.api !== "function") return null;
    try {
      const me = await win.api("/api/me", { timeoutMs: 8000 });
      if (!me || me.role !== "admin") return null;
    } catch (_) { return null; }
    const h = isPhoneLike(win) ? phone(win) : host(win);
    win.hqDesk = h;
    return h;
  }

  const el = (doc, tag, attrs, kids) => {
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
  const svg = (doc, d, cls) => {
    const ns = "http://www.w3.org/2000/svg";
    const s = doc.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", cls || "desk-ico");
    const p = doc.createElementNS(ns, "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.9"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  };
  const PHONE_D = "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2";
  const filesUrl = (rel) => "/files/" + String(rel).split("/").map(encodeURIComponent).join("/");

  // ------------------------------------------------------------------ PC: host
  function host(win) {
    const doc = win.document;
    const L = link(win, "pc");
    const player = () => { try { return hqPlayer; } catch (_) { return null; } }; // eslint-disable-line no-undef
    const media = () => {
      const v = doc.getElementById("player-video"), a = doc.getElementById("player-audio");
      if (v && !v.hidden && v.getAttribute("src")) return v;
      if (a && !a.hidden && a.getAttribute("src")) return a;
      return null;
    };
    let padStroke = null, padMeta = null, toldPhone = false, pubTimer = 0, lastTime = 0, snapTimer = 0, snapRev = 0;

    function tgt() {
      if (win.hqPadTargets) win.hqPadTargets.pick();
      const t = win.hqPadTargets && win.hqPadTargets.active();
      if (t && t.ready && t.ready()) return t;
      const R = win.hqSketchRemote;
      return R && R.ready && R.ready() ? R : null;
    }
    function ack(forWhat, ok, text, extra) {
      L.send("phone", "ack", Object.assign({ for: forWhat, ok: !!ok, text: String(text || "").slice(0, 80) }, extra || {}));
    }
    function state() {
      const m = media(), p = player();
      const t = tgt();
      const sk = win.hqSketchRemote && win.hqSketchRemote.ready() ? win.hqSketchRemote.size() : null;
      const sz = t && t.size ? t.size() : null;
      const hist = t && t.history ? t.history() : null;
      return {
        view: doc.body.dataset.view || "",
        sketch: sk,
        pad: sz ? { id: t.id || "sketch", label: t.label || "Dessiner", w: sz.w, h: sz.h, undo: !!(hist && hist.undo), redo: !!(hist && hist.redo),
          ink: t.inkColor ? safeColor(t.inkColor()) : null, has3d: !!(t.has3d && t.has3d()) } : null,
        snapshot_rev: snapRev || 0,
        player: m && p && p.rel ? {
          rel: p.rel, name: p.rel.split("/").pop(), kind: m.tagName === "VIDEO" ? "video" : "audio",
          playing: !m.paused && !m.ended, t: Math.round((m.currentTime || 0) * 10) / 10,
          d: isFinite(m.duration) ? Math.round(m.duration * 10) / 10 : 0, vol: Math.round((m.muted ? 0 : m.volume) * 100) / 100,
        } : null,
      };
    }
    function publishSoon() {
      if (pubTimer) return;
      pubTimer = win.setTimeout(() => { pubTimer = 0; if (L.running) L.publish(state()); }, 120);
    }
    async function uploadSnap() {
      const t = tgt();
      if (!t || typeof t.snapshot !== "function" || !L.running) return;
      let blob = null;
      try { blob = await t.snapshot(); } catch (_) { blob = null; }
      if (!blob || !blob.size || blob.size > 512 * 1024) return;
      const type = blob.type === "image/webp" || blob.type === "image/jpeg" ? blob.type : "";
      if (!type) return;
      try {
        const d = await win.api("/api/desk/snapshot?client=" + encodeURIComponent(L.id), { method: "POST", headers: { "Content-Type": type }, body: blob, timeoutMs: 15000 });
        if (d && d.rev && d.rev !== snapRev) { snapRev = d.rev; publishSoon(); }
      } catch (_) {}
    }
    win.hqDeskSnapshotSoon = () => {
      if (snapTimer) win.clearTimeout(snapTimer);
      snapTimer = win.setTimeout(() => { snapTimer = 0; uploadSnap(); }, 150);
    };

    // a small chip in the top bar while a phone is connected
    const chip = el(doc, "button", { type: "button", class: "desk-chip", hidden: true, title: "Téléphone connecté en second écran" }, [svg(doc, PHONE_D), el(doc, "span", { text: "2e écran" })]);
    const actionsBar = doc.querySelector(".topbar .topbar-actions");
    if (actionsBar) actionsBar.insertBefore(chip, doc.getElementById("status-chip"));
    chip.addEventListener("click", () => { if (typeof win.toast === "function") win.toast("Ton téléphone pilote ce PC : pad de dessin, Lecteur et photos lancées."); });

    L.onPeer = (peer) => {
      chip.hidden = !peer.online;
      if (peer.online && !toldPhone) { toldPhone = true; if (typeof win.toast === "function") win.toast("Téléphone connecté en second écran"); publishSoon(); }
      if (!peer.online) toldPhone = false;
    };

    L.onMessage = (m) => {
      if (m.type === "pad") return onPad(m.data || {});
      if (m.type === "remote") return onRemote(m.data || {});
      if (m.type === "flick") return onFlick(m.data || {});
    };

    let play = null, playGen = 0;
    const lats = [];
    function noteLatency(ms) {
      if (!isFinite(ms) || ms < 0 || ms > 5000) return;
      lats.push(ms);
      if (lats.length > 40) lats.shift();
    }
    win.hqDeskLatency = () => {
      if (!lats.length) return null;
      const sorted = lats.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    function reducedMotion() {
      return !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    function drainPlay() {
      if (!play) return;
      playGen++;
      play.immediate = true;
      const r = replayStep(play, (win.performance ? win.performance.now() : Date.now()) + 1e9);
      const done = play;
      play = null;
      applyRelease(r.release, done);
    }
    function applyRelease(evs, buf) {
      const R = tgt();
      if (!R || !buf) return;
      const now = win.performance ? win.performance.now() : Date.now();
      let batch = [];
      const flushPts = () => { if (batch.length && R.add) R.add(batch, buf.meta); batch = []; };
      for (const e of evs) {
        if (e.op === "pt") {
          // all of a frame's points go to the target in one call: one redraw per frame, not one per point
          if (e.t != null) noteLatency(now - buf.t0 - e.t);
          batch.push(e.p);
          continue;
        }
        flushPts();
        if (e.op === "end") {
          const res = R.end ? R.end(e.snap) : null;
          if (e.snap) ack("snap", !!(res && res.ok), (res && res.text) || (res && res.ok ? "Forme" : "Trait libre"), { closed: !!(res && res.closed) });
          ack("ink", true, "");
          padStroke = null; padMeta = null;
          publishSoon();
        } else if (e.op === "cancel") {
          if (R.cancel) R.cancel();
          padStroke = null; padMeta = null;
        } else if (e.op === "undo") { if (R.undo) R.undo(); publishSoon(); }
        else if (e.op === "redo") { if (R.redo) R.redo(); publishSoon(); }
      }
      flushPts();
    }
    function kickPlay() {
      if (!play || play.raf) return;
      const gen = ++playGen;
      const frame = (now) => {
        if (gen !== playGen || !play) return;
        play.raf = 0;
        const r = replayStep(play, now);
        play.delay = r.delay;
        const buf = play;
        play.events = r.rest;
        applyRelease(r.release, buf);
        if (gen !== playGen || !play) return;
        // an empty buffer stays until the next stroke: its clock (t0) must outlive the gap between two batches, or every
        // later batch would wait as long as the stroke has lasted
        if (play.events.length) play.raf = win.requestAnimationFrame(frame);
      };
      play.raf = win.requestAnimationFrame(frame);
    }
    function queuePlay(op, d) {
      const now = win.performance ? win.performance.now() : Date.now();
      if (!play || play.s !== d.s) {
        drainPlay();
        play = { s: d.s, t0: now, delay: 40, events: [], meta: padMeta, immediate: reducedMotion(), raf: 0 };
      }
      const pts = Array.isArray(d.pts) ? d.pts : [];
      for (const p of pts) {
        const t = Array.isArray(p) && p.length > 3 && isFinite(p[3]) ? Math.max(0, Math.min(600000, p[3])) : null;
        if (t != null) play.delay = tuneDelay(play.delay, now - play.t0 - t);
        play.events.push({ op: "pt", t: t, p: p });
      }
      if (op === "end" || op === "cancel") play.events.push({ op: op, snap: d.snap });
      if (play.immediate) drainPlay();
      else kickPlay();
    }
    function onPad(d) {
      const R = tgt();
      if (!R) return;
      if (d.op === "view") {
        if (typeof d.z === "number" && d.z > 0 && d.z !== 1 && R.zoom) R.zoom(d.z, Number(d.cx) || 0.5, Number(d.cy) || 0.5);
        if ((d.dx || d.dy) && R.pan) R.pan(Number(d.dx) || 0, Number(d.dy) || 0);
        return;
      }
      if (d.op === "hover") { if (R.hover) R.hover(Array.isArray(d.pts) && d.pts[0] ? d.pts[0] : null); return; }
      if (d.op === "lift") {
        const phase = ["start", "move", "end", "cancel"].includes(d.phase) ? d.phase : "cancel";
        const res = R.lift ? R.lift(phase, Number(d.h) || 0) : { ok: false, text: "Ce panneau ne sait pas extruder" };
        const now = Date.now();
        if (res && res.text && (phase !== "move" || now - (onPad.liftAckAt || 0) > 150)) {
          onPad.liftAckAt = now;
          ack("lift", res.ok, res.text, { phase: phase });
        }
        if (phase === "end") publishSoon();
        return;
      }
      if (d.op === "undo" || d.op === "redo") {
        if (play && play.events.length) { play.events.push({ op: d.op }); kickPlay(); return; }
        if (d.op === "undo" && R.undo) R.undo();
        if (d.op === "redo" && R.redo) R.redo();
        publishSoon();
        return;
      }
      if (d.op === "begin") {
        drainPlay();
        padMeta = { tool: d.tool === "erase" ? "erase" : "pen", thick: d.thick || "med" };
        padStroke = R.begin([], padMeta) ? d.s : null;
        if (padStroke) queuePlay("move", d);
        return;
      }
      if (d.s !== padStroke) return;
      if (d.op === "move" || d.op === "erase") queuePlay("move", d);
      else if (d.op === "end") queuePlay("end", d);
      else if (d.op === "cancel") queuePlay("cancel", d);
    }

    function openMedia(rel, autoplay) {
      if (typeof rel !== "string" || !rel || rel.length > 600 || rel.split("/").includes("..")) return;
      if (typeof win.hqPlayerOpen === "function") win.hqPlayerOpen(rel, autoplay);
    }
    function neighbour(dir) {
      const p = player();
      if (!p || !p.lib || !p.lib.length) return null;
      const list = p.lib.filter((f) => f.kind === "audio" || f.kind === "video");
      const i = list.findIndex((f) => f.rel === p.rel);
      const j = i < 0 ? 0 : (i + dir + list.length) % list.length;
      return list[j] ? list[j].rel : null;
    }
    function onRemote(d) {
      const m = media();
      switch (d.cmd) {
        case "view": if (VIEWS.includes(d.value) && typeof win.setView === "function") win.setView(d.value); break;
        case "toggle": if (m) { if (m.paused) { const pr = m.play(); if (pr && pr.catch) pr.catch(() => {}); } else m.pause(); } break;
        case "seek": if (m && isFinite(d.value)) m.currentTime = Math.max(0, Math.min(m.duration || 0, Number(d.value))); break;
        case "skip": if (m && isFinite(d.value)) m.currentTime = Math.max(0, Math.min(m.duration || 0, m.currentTime + Number(d.value))); break;
        case "vol": if (m && isFinite(d.value)) { m.muted = false; m.volume = Math.max(0, Math.min(1, Number(d.value))); } break;
        case "next": case "prev": { const rel = neighbour(d.cmd === "next" ? 1 : -1); if (rel) openMedia(rel, true); break; }
        case "open": openMedia(d.value, true); break;
        case "underlay": {
          const R = tgt();
          const r = R && R.setUnderlay ? R.setUnderlay(d.value) : { ok: false, text: "Pas de dessin ouvert" };
          ack("underlay", r.ok, r.text);
          break;
        }
        case "ar": {
          const R = tgt();
          if (!R || typeof R.ar !== "function") { ack("ar", false, "Pas de pièce 3D à montrer"); break; }
          Promise.resolve(R.ar()).then((r) => ack("ar", !!(r && r.ok), (r && r.text) || "", r && r.ok ? { url: r.url } : null))
            .catch(() => ack("ar", false, "Modèle AR indisponible"));
          break;
        }
        case "save": {
          const R = tgt();
          if (!R || typeof R.save !== "function") { ack("save", false, "Rien à enregistrer"); break; }
          Promise.resolve(R.save()).then((r) => { ack("save", r && r.ok, (r && r.text) || "Enregistré"); publishSoon(); }).catch(() => ack("save", false, "Enregistrement impossible"));
          return;
        }
        default: return;
      }
      publishSoon();
    }

    function onFlick(d) {
      if (typeof d.rel !== "string" || !d.rel.startsWith("Inbox/") || d.rel.split("/").includes("..")) return;
      const reduced = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const img = el(doc, "img", { alt: "", decoding: "async" });
      const name = String(d.name || d.rel.split("/").pop()).slice(0, 80);
      const card = el(doc, "button", { type: "button", class: "desk-flick", "aria-label": "Photo reçue du téléphone : " + name }, [
        img, el(doc, "span", { class: "desk-flick-cap" }, [svg(doc, PHONE_D), el(doc, "span", { text: name })]),
      ]);
      const dir = d.rel.split("/").slice(0, -1).join("/");
      let gone = false;
      const dismiss = (toFiles) => {
        if (gone) return; gone = true;
        const done = () => card.remove();
        if (reduced || !card.animate) { done(); return; }
        const r = card.getBoundingClientRect();
        const tx = toFiles ? -r.left - r.width / 2 + 60 : 0, ty = toFiles ? win.innerHeight - r.top - r.height / 2 - 40 : 40;
        card.animate([{ transform: "translate(-50%,-50%) rotate(var(--rot))", opacity: 1 },
          { transform: "translate(calc(-50% + " + tx + "px),calc(-50% + " + ty + "px)) rotate(0deg) scale(.15)", opacity: 0 }],
        { duration: 420, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).onfinish = done;
      };
      card.addEventListener("click", () => { dismiss(false); if (typeof win.navigate === "function") win.navigate(dir); });
      const land = () => {
        doc.body.appendChild(card);
        const rot = Math.max(-14, Math.min(14, (Number(d.vx) || 0) * 9)) - 3;
        card.style.setProperty("--rot", rot + "deg");
        if (!reduced && card.animate) {
          const fromX = Math.max(-0.45, Math.min(0.45, (Number(d.vx) || 0) * 0.3)) * win.innerWidth;
          card.animate([
            { transform: "translate(calc(-50% + " + fromX + "px)," + (win.innerHeight * 0.75) + "px) rotate(" + (rot * 4) + "deg) scale(.55)", opacity: 0.2 },
            { transform: "translate(-50%,calc(-50% - 26px)) rotate(" + (rot * 0.6) + "deg) scale(1.05)", opacity: 1, offset: 0.72 },
            { transform: "translate(-50%,-50%) rotate(" + rot + "deg) scale(1)", opacity: 1 },
          ], { duration: 760, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
        if (typeof win.hqPolishBurst === "function") win.setTimeout(() => { try { win.hqPolishBurst(card); } catch (_) {} }, 600);
        win.setTimeout(() => dismiss(true), 7000);
      };
      img.addEventListener("load", land, { once: true });
      img.addEventListener("error", () => { if (typeof win.toast === "function") win.toast("Photo reçue : " + name); }, { once: true });
      img.src = filesUrl(d.rel);
      if (typeof win.refreshFiles === "function" && doc.body.dataset.view === "fichiers") win.refreshFiles();
    }

    // follow what the PC shows
    new win.MutationObserver(publishSoon).observe(doc.body, { attributes: true, attributeFilter: ["data-view"] });
    for (const id of ["player-video", "player-audio"]) {
      const m = doc.getElementById(id);
      if (!m) continue;
      for (const ev of ["play", "pause", "ended", "loadedmetadata", "volumechange", "seeked", "emptied"]) m.addEventListener(ev, publishSoon);
      m.addEventListener("timeupdate", () => { const now = Date.now(); if (now - lastTime > 4000) { lastTime = now; publishSoon(); } });
    }
    win.addEventListener("resize", publishSoon);
    const live = () => {
      if (doc.visibilityState === "visible") { L.start(); L.publish(state()); }
      else { L.stop(); }
    };
    doc.addEventListener("visibilitychange", live);
    win.addEventListener("pagehide", () => L.stop());
    live();

    return { role: "pc", state, link: L, touch: publishSoon, openPanel: () => { if (typeof win.toast === "function") win.toast("Ouvre HQ sur ton téléphone : il deviendra le second écran de ce PC."); } };
  }

  // ------------------------------------------------------------------ phone: controller
  function phone(win) {
    const doc = win.document;
    const L = link(win, "phone");
    const S = { open: false, tab: "pad", peer: null, stroke: 0, pts: [], all: [], flushT: 0, lib: null, photo: null, from: null, tick: 0, tool: "pen", thick: "med", fingers: new Map() };
    const haptic = (k) => { if (typeof win.hqPolishHaptic === "function") win.hqPolishHaptic(k); };

    // ---- skeleton
    const statusDot = el(doc, "span", { class: "desk-dot" });
    const statusText = el(doc, "span", { class: "desk-status-t", text: "Recherche du PC…" });
    const closeBtn = el(doc, "button", { type: "button", class: "desk-btn", "aria-label": "Fermer" }, [svg(doc, "M6 6l12 12M18 6 6 18")]);
    const tabs = el(doc, "div", { class: "desk-tabs", role: "tablist" }, [
      ["pad", "Pad"], ["lecteur", "Lecteur"], ["lancer", "Lancer"],
    ].map(([id, label]) => el(doc, "button", { type: "button", role: "tab", class: "desk-tab", "data-tab": id, "aria-selected": String(id === "pad"), text: label })));

    // pad
    const padSnap = el(doc, "img", { class: "desk-snap", alt: "", hidden: true });
    const padCanvas = el(doc, "canvas", { class: "desk-pad-ink", "aria-hidden": "true" });
    const padHint = el(doc, "p", { class: "desk-pad-hint", text: "Dessine ici, le trait apparaît sur le PC" });
    const pad = el(doc, "div", { class: "desk-pad", "aria-label": "Surface de dessin : tes traits apparaissent sur le PC" }, [padSnap, padCanvas, padHint]);
    const undoBtn = el(doc, "button", { type: "button", class: "desk-pill", disabled: true }, [svg(doc, "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"), el(doc, "span", { text: "Annuler" })]);
    const redoBtn = el(doc, "button", { type: "button", class: "desk-pill", disabled: true }, [svg(doc, "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"), el(doc, "span", { text: "Rétablir" })]);
    const toolBtn = el(doc, "button", { type: "button", class: "desk-pill", "data-pad-tool": "pen", "aria-pressed": "false" }, [el(doc, "span", { text: "Stylo" })]);
    const thickOf = (id, label, size) => {
      const b = el(doc, "button", { type: "button", class: "desk-thick" + (id === "med" ? " is-on" : ""), "data-thick": id, "aria-label": label, "aria-pressed": String(id === "med") });
      const dot = el(doc, "i", { "aria-hidden": "true" });
      dot.style.width = size; dot.style.height = size;
      b.appendChild(dot);
      return b;
    };
    const thicks = el(doc, "div", { class: "desk-thicks", role: "group", "aria-label": "Épaisseur" }, [
      thickOf("fine", "Trait fin", "6px"), thickOf("med", "Trait moyen", "12px"), thickOf("bold", "Trait gras", "20px"),
    ]);
    const saveBtn = el(doc, "button", { type: "button", class: "desk-pill" }, [el(doc, "span", { text: "Enregistrer" })]);
    // AR Quick Look: the PC builds the model, the pad (an iPhone or iPad) opens it on the table
    const arBtn = el(doc, "button", { type: "button", class: "desk-pill desk-ar", hidden: true }, [el(doc, "span", { text: "Voir en AR" })]);
    const arLink = el(doc, "a", { class: "desk-pill desk-accent desk-ar-go", hidden: true, rel: "ar" }, [el(doc, "img", { alt: "", src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }), el(doc, "span", { text: "Ouvrir en AR" })]);
    const liftBtn = el(doc, "button", { type: "button", class: "desk-pill desk-lift", hidden: true, "aria-pressed": "false",
      title: "Donne de la hauteur à la forme : glisse vers le haut sur le pad (ou deux doigts vers le haut)" },
    [svg(doc, "M12 19V5M6 11l6-6 6 6"), el(doc, "span", { text: "Extruder" })]);
    const photoBtn = el(doc, "button", { type: "button", class: "desk-pill" }, [el(doc, "span", { text: "Photo à décalquer" })]);
    const photoIn = el(doc, "input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
    const ackLine = el(doc, "p", { class: "desk-ack", role: "status", text: "" });
    const openDraw = el(doc, "button", { type: "button", class: "desk-pill desk-accent", hidden: true }, [el(doc, "span", { text: "Ouvrir Dessiner sur le PC" })]);
    const penChip = el(doc, "button", { type: "button", class: "desk-pill desk-pen", hidden: true, "aria-pressed": "false",
      title: "Apple Pencil détecté : la paume et les doigts ne dessinent pas. Touche pour autoriser aussi le doigt." },
    [svg(doc, "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"), el(doc, "span", { text: "Pencil seul" })]);
    const padPane = el(doc, "section", { class: "desk-pane", "data-pane": "pad" }, [
      pad,
      el(doc, "div", { class: "desk-row" }, [toolBtn, thicks, undoBtn, redoBtn]),
      el(doc, "div", { class: "desk-row" }, [liftBtn, arBtn, arLink, saveBtn, photoBtn, penChip, openDraw]),
      ackLine, photoIn,
    ]);

    // lecteur
    const nowTitle = el(doc, "p", { class: "desk-now", text: "Rien en lecture sur le PC" });
    const seek = el(doc, "input", { type: "range", class: "desk-seek", min: "0", max: "1000", value: "0", "aria-label": "Position" });
    const tCur = el(doc, "span", { text: "0:00" }), tDur = el(doc, "span", { text: "0:00" });
    const playBtn = el(doc, "button", { type: "button", class: "desk-round desk-play", "aria-label": "Lecture / pause" }, [svg(doc, "M8 5v14l11-7z")]);
    const ctl = (cmd, value, d, label) => { const b = el(doc, "button", { type: "button", class: "desk-round", "aria-label": label }, [svg(doc, d)]); b.addEventListener("click", () => remote(cmd, value)); return b; };
    const vol = el(doc, "input", { type: "range", class: "desk-vol", min: "0", max: "100", value: "100", "aria-label": "Volume" });
    const libFilter = el(doc, "input", { type: "search", class: "desk-filter", placeholder: "Filtrer la bibliothèque…", "aria-label": "Filtrer" });
    const libList = el(doc, "ul", { class: "desk-lib" });
    const openPlayer = el(doc, "button", { type: "button", class: "desk-pill", hidden: true }, [el(doc, "span", { text: "Ouvrir le Lecteur sur le PC" })]);
    const lecteurPane = el(doc, "section", { class: "desk-pane", "data-pane": "lecteur", hidden: true }, [
      el(doc, "div", { class: "desk-player" }, [
        nowTitle, seek, el(doc, "div", { class: "desk-times" }, [tCur, tDur]),
        el(doc, "div", { class: "desk-controls" }, [
          ctl("prev", null, "M6 5v14M18 5 9 12l9 7z", "Précédent"), ctl("skip", -10, "M11 7 5 12l6 5M19 7l-6 5 6 5", "Reculer de 10 s"),
          playBtn, ctl("skip", 10, "M13 7l6 5-6 5M5 7l6 5-6 5", "Avancer de 10 s"), ctl("next", null, "M18 5v14M6 5l9 7-9 7z", "Suivant"),
        ]),
        el(doc, "label", { class: "desk-vol-row" }, [svg(doc, "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6"), vol]),
        openPlayer,
      ]),
      libFilter, libList,
    ]);

    // lancer
    const pickBtn = el(doc, "button", { type: "button", class: "desk-pill desk-accent" }, [svg(doc, "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"), el(doc, "span", { text: "Choisir une photo" })]);
    const fileIn = el(doc, "input", { type: "file", accept: "image/*", hidden: true });
    const flickImg = el(doc, "img", { alt: "" });
    const flickCard = el(doc, "div", { class: "desk-card", hidden: true }, [flickImg]);
    const flickHint = el(doc, "p", { class: "desk-hint", text: "Choisis une photo, puis lance-la vers le haut pour l'envoyer sur l'écran du PC." });
    const lancerPane = el(doc, "section", { class: "desk-pane", "data-pane": "lancer", hidden: true }, [el(doc, "div", { class: "desk-stage" }, [flickCard, flickHint]), el(doc, "div", { class: "desk-row" }, [pickBtn]), fileIn]);

    const sheet = el(doc, "div", { id: "hq-desk", class: "desk", role: "dialog", "aria-modal": "true", "aria-label": "Second écran", hidden: true }, [
      el(doc, "header", { class: "desk-head" }, [
        el(doc, "div", { class: "desk-title" }, [svg(doc, PHONE_D), el(doc, "strong", { text: "Second écran" })]),
        el(doc, "p", { class: "desk-status", role: "status" }, [statusDot, statusText]), closeBtn,
      ]),
      tabs, padPane, lecteurPane, lancerPane,
    ]);
    doc.body.appendChild(sheet);

    const launcher = el(doc, "button", { type: "button", class: "view-search desk-launch", id: "btn-desk", "aria-label": "Second écran",
      "data-help": "Second écran : ton téléphone devient le pad de dessin, la télécommande du Lecteur et le lanceur de photos du PC." }, [svg(doc, PHONE_D)]);
    const tools = doc.querySelector(".view-bar .view-tools, .home-hero-head .view-tools");
    if (tools) tools.insertBefore(launcher, doc.getElementById("btn-search-bar") || tools.firstChild);

    // ---- peer
    const pcState = () => (S.peer && S.peer.online && S.peer.state) || null;
    L.onPeer = (peer) => { S.peer = peer; renderPeer(); };
    L.onMessage = (m) => {
      if (!m || m.type !== "ack") return;
      const d = m.data || {};
      if (d.for === "ink") {
        // the PC has the stroke; its picture may not yet: wait for the next picture shown after this ack
        ink.held.forEach((h) => { if (!h.acked) { h.acked = true; h.need = S.snapShown || 0; } });
        armHeld();
        return;
      }
      if (d.for === "ar") {
        const ok = d.ok && typeof d.url === "string" && /^\/api\/drawings\/usdz\/usdz-[0-9a-f]{24}\.usdz$/.test(d.url);
        arLink.hidden = !ok;
        if (ok) arLink.setAttribute("href", d.url);
        ackLine.textContent = ok ? "Modèle prêt : touche « Ouvrir en AR » et pose la pièce sur la table" : String(d.text || "Modèle AR indisponible").slice(0, 80);
        haptic(ok ? "done" : "err");
        return;
      }
      if (d.for === "snap" && d.closed) {
        armLift(true);
        ackLine.textContent = String(d.text || "Forme").slice(0, 40) + " · deux doigts vers le haut pour l'extruder";
        haptic("done");
        return;
      }
      if (d.for === "lift") {
        ackLine.textContent = String(d.text || "").slice(0, 80);
        if (d.phase === "start" && d.ok === false) { endLift(false, true); haptic("err"); }
        else if (d.phase === "end") haptic(d.ok === false ? "err" : "done");
        return;
      }
      ackLine.textContent = String(d.text || "").slice(0, 80);
      haptic(d.ok === false ? "err" : "done");
    };
    // ---- sketch to 3D: after a closed shape, two fingers up (or « Extruder » then a drag up) give it height
    function armLift(on) {
      S.liftReady = !!on;
      liftBtn.hidden = !on && !S.lift;
      if (on) {
        if (S.liftT) win.clearTimeout(S.liftT);
        S.liftT = win.setTimeout(() => { if (!S.lift) armLift(false); }, 20000);
        ackLine.textContent = "Forme fermée : deux doigts vers le haut pour l'extruder";
      }
    }
    function beginLift() {
      S.lift = { h: 0, sentAt: 0 };
      pad.classList.add("is-lifting");
      liftBtn.setAttribute("aria-pressed", "true");
      L.send("pc", "pad", { op: "lift", phase: "start" });
      haptic("tick");
    }
    function moveLift(h) {
      if (!S.lift) return;
      S.lift.h = h;
      const now = Date.now();
      if (now - S.lift.sentAt >= VIEW_MS) { S.lift.sentAt = now; L.send("pc", "pad", { op: "lift", phase: "move", h: Math.round(h * 1000) / 1000 }); }
    }
    function endLift(keep, quiet) {
      const lift = S.lift;
      S.lift = null; S.liftArm = false;
      pad.classList.remove("is-lifting");
      liftBtn.setAttribute("aria-pressed", "false");
      if (!lift) return;
      if (!quiet) L.send("pc", "pad", { op: "lift", phase: keep ? "end" : "cancel", h: Math.round(lift.h * 1000) / 1000 });
      armLift(false);
    }
    arBtn.addEventListener("click", () => {
      if (!(S.peer && S.peer.online)) return;
      arLink.hidden = true;
      L.send("pc", "remote", { cmd: "ar" });
      sayAck("Préparation du modèle AR…", true);
    });
    liftBtn.addEventListener("click", () => {
      if (S.lift) { endLift(false); return; }
      S.liftArm = !S.liftArm;
      liftBtn.setAttribute("aria-pressed", String(S.liftArm));
      ackLine.textContent = S.liftArm ? "Glisse vers le haut sur le pad pour donner de la hauteur" : "";
      haptic("tick");
    });
    L.onRetry = (on) => {
      sheet.classList.toggle("is-retry", !!on);
      if (on) ackLine.textContent = "Reconnexion…";
    };
    L.onGiveUp = () => { ackLine.textContent = "Trait perdu, le réseau a lâché"; haptic("err"); };
    function surface() {
      const st = pcState();
      if (!st) return null;
      if (st.pad && st.pad.w > 0) return st.pad;
      if (st.sketch && st.sketch.w > 0) return { id: "sketch", label: "Dessiner", w: st.sketch.w, h: st.sketch.h, undo: true, redo: false };
      return null;
    }
    function renderPeer() {
      const st = pcState();
      const online = !!(S.peer && S.peer.online);
      sheet.classList.toggle("is-online", online);
      const surf = surface();
      const names = { dessiner: "Dessiner", lecteur: "Lecteur", accueil: "Accueil", fichiers: "Fichiers", carnet: "Carnet", forge: "Forge", calendrier: "Calendrier" };
      const where = surf ? surf.label : (st && st.view ? (names[st.view] || st.view) : "");
      statusText.textContent = online ? "PC connecté" + (where ? " · " + where : "") : "Aucun PC : ouvre HQ sur ton ordinateur";
      openDraw.hidden = !online || !!surf;
      pad.classList.toggle("is-off", !surf);
      if (surf && surf.w > 0 && surf.h > 0) {
        const ar = (surf.w / surf.h).toFixed(4);
        if (pad.style.getPropertyValue("--ar") !== ar) { pad.style.setProperty("--ar", ar); win.requestAnimationFrame(sizeInk); }
      }
      S.inkColor = surf ? safeColor(surf.ink) : null;
      pad.classList.toggle("has-ink", !!S.inkColor);
      arBtn.hidden = !(surf && surf.has3d);
      if (arBtn.hidden) arLink.hidden = true;
      undoBtn.disabled = !(surf && surf.undo);
      redoBtn.disabled = !(surf && surf.redo);
      if (st && st.snapshot_rev && st.snapshot_rev !== S.snapRev) {
        pullSnap(st.snapshot_rev); // held ink waits for that picture to be on screen (pullSnap → onload)
      }
      const p = st && st.player;
      openPlayer.hidden = !online || (st && st.view === "lecteur");
      nowTitle.textContent = p ? p.name : online ? "Rien en lecture sur le PC" : "PC hors ligne";
      sheet.classList.toggle("is-playing", !!(p && p.playing));
      playBtn.querySelector("path").setAttribute("d", p && p.playing ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5v14l11-7z");
      if (p && !seek.matches(":active")) { S.tick = Date.now(); paintTime(p); }
      if (p && !vol.matches(":active")) vol.value = String(Math.round((p.vol || 0) * 100));
    }
    const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
    function paintTime(p) {
      const t = Math.min(p.d || 0, (p.t || 0) + (p.playing ? (Date.now() - S.tick) / 1000 : 0));
      tCur.textContent = mmss(t); tDur.textContent = mmss(p.d);
      seek.value = String(p.d ? Math.round((t / p.d) * 1000) : 0);
    }
    win.setInterval(() => { const st = pcState(); if (S.open && S.tab === "lecteur" && st && st.player && st.player.playing && !seek.matches(":active")) paintTime(st.player); }, 500);

    const remote = (cmd, value) => { if (!(S.peer && S.peer.online)) return; L.send("pc", "remote", { cmd, value }); haptic("tick"); };
    playBtn.addEventListener("click", () => remote("toggle"));
    seek.addEventListener("change", () => { const p = pcState() && pcState().player; if (p && p.d) remote("seek", (Number(seek.value) / 1000) * p.d); });
    vol.addEventListener("change", () => remote("vol", Number(vol.value) / 100));
    openDraw.addEventListener("click", () => remote("view", "dessiner"));
    openPlayer.addEventListener("click", () => remote("view", "lecteur"));

    async function loadLib() {
      if (S.lib) return renderLib();
      libList.replaceChildren(el(doc, "li", { class: "desk-hint", text: "Chargement…" }));
      try { S.lib = ((await win.api("/api/media/library", { timeoutMs: 15000 })).items || []).filter((f) => f.kind === "audio" || f.kind === "video"); }
      catch (e) { S.lib = null; libList.replaceChildren(el(doc, "li", { class: "desk-hint", text: (e && e.message) || "Bibliothèque indisponible" })); return; }
      renderLib();
    }
    function renderLib() {
      const q = libFilter.value.trim().toLowerCase();
      const items = (S.lib || []).filter((f) => !q || f.rel.toLowerCase().includes(q)).slice(0, 120);
      const cur = pcState() && pcState().player ? pcState().player.rel : "";
      libList.replaceChildren(...(items.length ? items.map((f) => {
        const b = el(doc, "button", { type: "button", class: "desk-lib-item" + (f.rel === cur ? " is-current" : "") }, [
          el(doc, "span", { class: "desk-lib-k", text: f.kind === "video" ? "▶" : "♪" }), el(doc, "span", { class: "desk-lib-n", text: f.name }),
        ]);
        b.addEventListener("click", () => remote("open", f.rel));
        return el(doc, "li", null, [b]);
      }) : [el(doc, "li", { class: "desk-hint", text: "Aucune musique ni vidéo." })]));
    }
    libFilter.addEventListener("input", renderLib);

    // ---- pad
    // Local ink. The stroke being drawn is split in two: a finished part rasterised once into `ink.cache`, and a short
    // live tail redrawn each frame, so a long stroke costs the same per frame as a short one. Everything is painted
    // once per animation frame (not once per pen event), in CSS pixels on a canvas scaled for the screen density, with
    // the shared HqInk outline and the PC's ink colour, so the handoff to the PC's picture is invisible.
    const ink = { ctx: null, cache: null, cctx: null, tint: null, dpr: 1, trail: [], held: [], frozen: 0, preds: [], raf: 0, waitT: 0 };
    const nav = { x: 0, y: 0, z: 1 };
    function sizeInk() {
      // the canvas's own box (inside the pad's border), the same box every drawing call maps into
      const r = padCanvas.getBoundingClientRect(), dpr = Math.min(win.devicePixelRatio || 1, 3);
      ink.dpr = dpr;
      padCanvas.width = Math.max(1, Math.round(r.width * dpr)); padCanvas.height = Math.max(1, Math.round(r.height * dpr));
      ink.ctx = padCanvas.getContext("2d");
      if (!ink.cache) ink.cache = doc.createElement("canvas");
      ink.cache.width = padCanvas.width; ink.cache.height = padCanvas.height;
      ink.cctx = ink.cache.getContext("2d");
      ink.frozen = 0; // the cache is rebuilt at the new size on the next frame
      paint();
    }
    function resetNav() {
      nav.x = 0; nav.y = 0; nav.z = 1;
      padSnap.style.transform = "";
      padSnap.style.transformOrigin = "";
    }
    let snapUrl = "";
    async function pullSnap(rev) {
      if (!rev || rev === S.snapRev) return;
      S.snapRev = rev;
      try {
        const res = await win.api("/api/desk/snapshot?rev=" + rev, { timeoutMs: 15000 });
        if (!res || typeof res.blob !== "function") return;
        const blob = await res.blob();
        if (snapUrl) URL.revokeObjectURL(snapUrl);
        snapUrl = URL.createObjectURL(blob);
        padSnap.onload = () => { padSnap.hidden = false; S.snapShown = rev; if (!S.nav) resetNav(); armHeld(); };
        padSnap.src = snapUrl;
      } catch (_) { S.snapRev = 0; }
    }
    function inkBox() { return padCanvas.getBoundingClientRect(); }
    function accent() { return win.getComputedStyle(sheet).getPropertyValue("--accent").trim() || "#3dffb5"; }
    function inkColor() { return S.tool === "erase" ? accent() : (S.inkColor || accent()); }
    function onScreen(pts, box) {
      const short = Math.min(box.width, box.height);
      return pts.map((p) => ({ x: p.nx[0] * box.width, y: p.nx[1] * box.height, w: Math.max(1.2, (p.w || 0.009) * short) }));
    }
    function fillInk(c, pts, alpha, color, ends, range) {
      if (!c || !pts.length || alpha <= 0) return;
      c.save(); c.globalAlpha = Math.max(0, Math.min(1, alpha)); c.fillStyle = color;
      if (win.HqInk && range && win.HqInk.fillRange) win.HqInk.fillRange(c, pts, range[0], range[1], { ends: ends });
      else if (win.HqInk) win.HqInk.fill(c, pts, { ends: ends });
      else { c.beginPath(); for (const p of pts) { c.moveTo(p.x + p.w / 2, p.y); c.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2); } c.fill(); }
      c.restore();
    }
    function clear(c) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, c.canvas.width, c.canvas.height); c.restore(); }
    /** Move the part of the stroke that can no longer change (clear of both tapers) into the cache. */
    function freeze(box) {
      const t = ink.trail, n = t.length;
      if (!ink.cctx) return;
      if (ink.frozen === 0) clear(ink.cctx);
      if (n < 8) return;
      const scr = onScreen(t, box);
      const maxW = scr.reduce((m, p) => Math.max(m, p.w), 1);
      const guard = maxW * 3 + 8;
      let fromEnd = 0, j = n - 1;
      while (j > 0 && (fromEnd < guard || n - 1 - j < 4)) { fromEnd += Math.hypot(scr[j].x - scr[j - 1].x, scr[j].y - scr[j - 1].y); j--; }
      let fromStart = 0;
      for (let i = 1; i <= j; i++) fromStart += Math.hypot(scr[i].x - scr[i - 1].x, scr[i].y - scr[i - 1].y);
      if (j - ink.frozen < 6 || fromStart < guard) return;
      ink.cctx.setTransform(ink.dpr, 0, 0, ink.dpr, 0, 0);
      // smoothed with the neighbours on both sides as context, so this piece meets the next one without a seam
      fillInk(ink.cctx, scr, 1, "#000", { start: true, end: false }, [ink.frozen, j]); // the shape; tinted when shown
      ink.frozen = j;
    }
    function render() {
      const c = ink.ctx; if (!c) return;
      const box = inkBox();
      clear(c);
      c.setTransform(ink.dpr, 0, 0, ink.dpr, 0, 0);
      for (const h of ink.held) fillInk(c, onScreen(h.pts, box), h.alpha == null ? 1 : h.alpha, h.color || inkColor(), null);
      if (S.snapShape) { drawShape(S.snapShape); return; }
      const alpha = S.tool === "erase" ? 0.45 : 1, color = inkColor();
      if (ink.trail.length) {
        if (ink.frozen > 0) {
          // the cache holds the finished part's shape: tint it once on a scratch layer, then lay it down
          const tint = ink.tint || (ink.tint = doc.createElement("canvas"));
          if (tint.width !== ink.cache.width || tint.height !== ink.cache.height) { tint.width = ink.cache.width; tint.height = ink.cache.height; }
          const tc = tint.getContext("2d");
          clear(tc); tc.drawImage(ink.cache, 0, 0);
          tc.save(); tc.globalCompositeOperation = "source-in"; tc.fillStyle = color; tc.fillRect(0, 0, tint.width, tint.height); tc.restore();
          c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = alpha; c.drawImage(tint, 0, 0); c.restore(); // pixel for pixel
        }
        const scr = onScreen(ink.trail, box);
        fillInk(c, scr, alpha, color, { start: true, end: true }, [ink.frozen, scr.length - 1]);
      }
      if (ink.preds.length && ink.trail.length) {
        const last = ink.trail[ink.trail.length - 1];
        fillInk(c, onScreen([last].concat(ink.preds), box), 0.35, color, { start: false, end: true });
      }
    }
    /** One paint per animation frame, whatever the pen event rate. */
    function paint(preds) {
      if (preds !== undefined) ink.preds = preds || [];
      if (ink.raf) return;
      ink.raf = win.requestAnimationFrame(frame);
    }
    function frame() {
      ink.raf = 0;
      const now = Date.now();
      const reduced = win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let again = false;
      ink.held = ink.held.filter((h) => {
        if (!h.ready && (now - h.born > 1500 || (h.acked && (padSnap.hidden || (S.snapShown || 0) > h.need)))) h.ready = true;
        if (!h.ready) { again = true; return true; }
        if (reduced) return false;
        if (!h.fadeAt) h.fadeAt = now;
        h.alpha = 1 - (now - h.fadeAt) / 150;
        if (h.alpha > 0.04) again = true;
        return h.alpha > 0.04;
      });
      if (ink.trail.length) freeze(inkBox());
      render();
      if (again) {
        if (ink.held.some((h) => h.ready)) paint(); // a fade in progress: every frame
        else if (!ink.waitT) ink.waitT = win.setTimeout(() => { ink.waitT = 0; paint(); }, 100); // waiting for the PC: check now and then
      }
    }
    function armHeld() { paint(); }
    function parkTrail() {
      if (ink.trail.length >= 2) {
        ink.held.push({ pts: ink.trail.slice(), color: inkColor(), alpha: 1, born: Date.now(), need: S.snapShown || 0, acked: false, ready: false });
        if (ink.held.length > 8) ink.held.shift();
      }
      ink.trail = []; ink.frozen = 0; ink.preds = [];
      paint();
    }
    function drawShape(snap) {
      const c = ink.ctx, r = inkBox(); if (!c || !snap) return;
      c.save(); c.strokeStyle = accent();
      c.lineWidth = 2.5; c.setLineDash([5, 4]);
      const X = (nx) => nx * r.width, Y = (ny) => ny * r.height;
      c.beginPath();
      if (snap.kind === "line") { c.moveTo(X(snap.params.a[0]), Y(snap.params.a[1])); c.lineTo(X(snap.params.b[0]), Y(snap.params.b[1])); }
      else if (snap.kind === "circle") c.arc(X(snap.params.c[0]), Y(snap.params.c[1]), snap.params.r * r.width, 0, Math.PI * 2);
      else if (snap.kind === "rect") {
        const x0 = X(snap.params.a[0]), y0 = Y(snap.params.a[1]), x1 = X(snap.params.b[0]), y1 = Y(snap.params.b[1]);
        c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      c.stroke(); c.restore();
    }
    function sample(ev, r, live) {
      const kind = ev.pointerType;
      let pe = ev.pressure;
      if (kind === "pen") pe = easePressure(live ? S.pe : (S.pe || pe), ev.pressure);
      if (live && kind === "pen") S.pe = pe;
      const w = pointWidth(S.thick, kind, pe, S.gamma || 1) * (kind === "pen" ? tiltFactor(ev.altitudeAngle, ev.tiltX, ev.tiltY) : 1);
      const raw = norm(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
      let nx = raw;
      if (live) { nx = streamline(S.sm, raw, S.smooth || 0); S.sm = nx; }
      const t = S.t0 ? Math.max(0, Math.min(600000, Date.now() - S.t0)) : 0;
      return { x: nx[0] * r.width, y: nx[1] * r.height, nx: nx, raw: raw, w: Math.round(w * 10000) / 10000, t: t };
    }
    function flush(final) {
      if (S.flushT) { win.clearTimeout(S.flushT); S.flushT = 0; }
      if (!S.stroke) return;
      const pts = S.pts; S.pts = [];
      const body = { s: S.stroke, pts: pts, tool: S.tool, thick: S.thick };
      if (final) {
        if (S.snapShape) body.snap = S.snapShape;
        L.send("pc", "pad", Object.assign({ op: "end" }, body));
      } else if (pts.length) L.send("pc", "pad", Object.assign({ op: S.tool === "erase" ? "erase" : "move" }, body));
      S.lastFlush = Date.now();
    }
    /** Send now if the last message left long enough ago, otherwise as soon as it may. What piles up behind a message
     * on the wire merges into one queued message, so this never floods the relay. */
    function flushSoon() {
      const wait = flushWait(Date.now(), S.lastFlush);
      if (!wait) flush(false);
      else if (!S.flushT) S.flushT = win.setTimeout(() => { S.flushT = 0; flush(false); }, wait);
    }
    function armHold(x, y) {
      if (S.holdT) win.clearTimeout(S.holdT);
      S.holdT = 0;
      if (S.tool === "erase") return;
      S.still = { x: x, y: y, at: Date.now() };
      S.holdT = win.setTimeout(() => {
        S.holdT = 0;
        if (!S.stroke || !S.all.length) return;
        const r = pad.getBoundingClientRect();
        const snap = win.HqShapeSnap ? win.HqShapeSnap.recognise(S.all, r.width / Math.max(1, r.height)) : null;
        if (!snap) return;
        S.snapShape = snap;
        paint([]);
        haptic("tick");
      }, 450);
    }
    function beginStroke(e) {
      const r = inkBox();
      try { pad.setPointerCapture(e.pointerId); } catch (_) {}
      S.stroke = (Date.now() % 1e9) + 1; S.pointer = e.pointerId; S.strokeKind = e.pointerType || "mouse";
      S.t0 = Date.now();
      S.pe = 0; S.sm = null; S.lastFlush = 0;
      if (S.liftReady && !S.lift) armLift(false);
      S.all = []; S.snapShape = null; ink.trail = []; ink.frozen = 0; ink.preds = []; S.calibPts = S.calib ? [] : null;
      const s = sample(e, r, true);
      const pt = s.nx.concat([s.w, s.t]);
      S.all.push(s.nx); ink.trail.push(s);
      L.send("pc", "pad", { op: "begin", s: S.stroke, pts: [pt], tool: S.tool, thick: S.thick });
      pad.classList.add("is-drawing");
      if (S.hovering) S.hovering = false;
      armHold(s.x, s.y);
      paint([]);
    }
    function cancelStroke() {
      if (!S.stroke) return;
      if (S.flushT) { win.clearTimeout(S.flushT); S.flushT = 0; }
      if (S.holdT) { win.clearTimeout(S.holdT); S.holdT = 0; }
      S.pts = []; S.all = []; S.snapShape = null; ink.trail = []; ink.frozen = 0; ink.preds = [];
      L.send("pc", "pad", { op: "cancel", s: S.stroke });
      S.stroke = 0;
      paint([]);
    }
    const RING_ITEMS = [
      { id: "pen", label: "Stylo" }, { id: "erase", label: "Gomme" }, { id: "fine", label: "Fin" },
      { id: "med", label: "Moyen" }, { id: "bold", label: "Épais" }, { id: "undo", label: "Annuler" },
    ];
    const ringEl = el(doc, "div", { class: "desk-ring", hidden: true, "aria-hidden": "true" });
    sheet.appendChild(ringEl);
    function openRing(x, y, pid) {
      const sheetBox = sheet.getBoundingClientRect();
      const localX = x - sheetBox.left, localY = y - sheetBox.top;
      const lay = win.HqRadial && win.HqRadial.layout ? win.HqRadial.layout(RING_ITEMS.length, localX, localY, sheetBox.width, sheetBox.height, 78, 8) : null;
      ringEl.replaceChildren();
      const nodes = RING_ITEMS.map((item, i) => {
        const b = el(doc, "button", { type: "button", class: "desk-ring-item", text: item.label, "aria-label": item.label });
        if (lay) { b.style.left = lay.items[i].x + "px"; b.style.top = lay.items[i].y + "px"; }
        ringEl.appendChild(b);
        return b;
      });
      ringEl.hidden = false;
      S.ring = { pid: pid, pick: -1, nodes: nodes, lay: lay };
    }
    function moveRing(x, y) {
      if (!S.ring || !S.ring.lay || !win.HqRadial || !win.HqRadial.pickIndex) return;
      const sheetBox = sheet.getBoundingClientRect();
      const idx = win.HqRadial.pickIndex(RING_ITEMS.length, S.ring.lay.cx, S.ring.lay.cy, x - sheetBox.left, y - sheetBox.top, 28);
      S.ring.pick = idx;
      S.ring.nodes.forEach((n, i) => n.classList.toggle("is-on", i === idx));
    }
    function closeRing() {
      if (S.ringTimer) { win.clearTimeout(S.ringTimer); S.ringTimer = 0; }
      S.ring = null;
      ringEl.hidden = true;
      ringEl.replaceChildren();
    }
    function applyRing(idx) {
      const item = RING_ITEMS[idx];
      if (!item) return;
      haptic("tick");
      if (item.id === "pen" || item.id === "erase") {
        S.tool = item.id === "erase" ? "erase" : "pen";
        toolBtn.dataset.padTool = S.tool;
        toolBtn.setAttribute("aria-pressed", String(S.tool === "erase"));
        toolBtn.lastChild.textContent = S.tool === "erase" ? "Gomme" : "Stylo";
      } else if (item.id === "fine" || item.id === "med" || item.id === "bold") {
        S.thick = item.id;
        for (const kid of thicks.children) {
          const on = kid.dataset.thick === item.id;
          kid.classList.toggle("is-on", on);
          kid.setAttribute("aria-pressed", String(on));
        }
      } else if (item.id === "undo" && !undoBtn.disabled) L.send("pc", "pad", { op: "undo" });
    }
    function scratch(speed, pressure) {
      if (!S.sound) return;
      try {
        const AC = win.AudioContext || win.webkitAudioContext;
        if (!AC) return;
        if (!S.audio) S.audio = new AC();
        if (S.audio.state === "suspended") S.audio.resume();
        if (!speed) return;
        const ctx = S.audio;
        const buffer = ctx.createBuffer(1, 800, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 900 + Math.min(80, speed) * 30;
        filter.Q.value = 0.7;
        const gain = ctx.createGain();
        gain.gain.value = Math.min(0.04, 0.004 + pressure * 0.02);
        src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
        src.start();
      } catch (_) {}
    }
    async function holdWake() {
      if (!S.open || S.tab !== "pad" || doc.visibilityState !== "visible" || !win.navigator.wakeLock) return;
      try { S.wake = await win.navigator.wakeLock.request("screen"); } catch (_) {}
    }
    function dropWake() {
      const w = S.wake; S.wake = null;
      if (w) { try { w.release(); } catch (_) {} }
    }
    function touches() { return [...S.fingers.values()].filter((p) => p.type === "touch"); }
    function pencilNav() { return !!(S.penSeen && !S.fingerToo); }
    pad.addEventListener("touchstart", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    pad.addEventListener("touchmove", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    pad.addEventListener("pointerdown", (e) => {
      if (!surface()) return;
      if (S.liftArm && !S.lift) {
        e.preventDefault();
        try { pad.setPointerCapture(e.pointerId); } catch (_) {}
        S.liftPtr = { id: e.pointerId, y0: e.clientY };
        beginLift();
        return;
      }
      if (S.liftPtr && S.lift) return;
      S.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, t: Date.now(), type: e.pointerType || "mouse", moved: 0, w: e.width || 0, h: e.height || 0 });
      if (e.pointerType === "pen") { S.penDown = true; if (!S.penSeen) { S.penSeen = true; penChip.hidden = false; } closeRing(); }
      if (e.pointerType === "touch") {
        if (touches().length > 1) closeRing();
        else if (ringGuard({ kind: "touch", penDown: !!S.penDown, sincePen: S.penAt ? Date.now() - S.penAt : -1, width: e.width || 0, height: e.height || 0, fingers: 1, moved: 0 })) {
          const px = e.clientX, py = e.clientY, pid = e.pointerId;
          if (S.ringTimer) win.clearTimeout(S.ringTimer);
          S.ringTimer = win.setTimeout(() => {
            S.ringTimer = 0;
            const rec = S.fingers.get(pid);
            if (!rec || !ringGuard({ kind: "touch", penDown: !!S.penDown, sincePen: S.penAt ? Date.now() - S.penAt : -1, width: rec.w, height: rec.h, fingers: touches().length, moved: rec.moved })) return;
            if (S.stroke) cancelStroke();
            openRing(px, py, pid);
            haptic("tick");
          }, 450);
        }
      }
      const fingers = touches();
      if (e.pointerType === "touch" && pencilNav()) {
        e.preventDefault();
        if (S.stroke) cancelStroke();
        if (fingers.length >= 2) {
          const r = pad.getBoundingClientRect();
          const pts = fingers.slice(0, 2).map((p) => norm(p.x - r.left, p.y - r.top, r.width, r.height));
          if (!S.nav) S.nav = { prev: pts, t0: Math.min.apply(null, fingers.map((p) => p.t)), n: fingers.length, moved: 0, start: fingers.slice(0, 2).map((p) => [p.x, p.y]), mode: "" };
          else S.nav.n = fingers.length;
        }
        return;
      }
      const gate = penGate(e.pointerType, S.penSeen, S.fingerToo, S.stroke ? S.strokeKind : "");
      e.preventDefault();
      if (gate === "ignore") return;
      if (gate === "takeover") cancelStroke();
      beginStroke(e);
    });
    pad.addEventListener("pointermove", (e) => {
      const rec = S.fingers.get(e.pointerId);
      if (rec) {
        rec.moved = Math.max(rec.moved, Math.hypot(e.clientX - rec.ox, e.clientY - rec.oy));
        rec.x = e.clientX; rec.y = e.clientY;
      }
      const r = inkBox();
      if (S.ring) { moveRing(e.clientX, e.clientY); }
      if (S.ringTimer && rec && rec.moved > 8) { win.clearTimeout(S.ringTimer); S.ringTimer = 0; }
      if (S.liftPtr && S.lift && e.pointerId === S.liftPtr.id) { moveLift(liftHeight(S.liftPtr.y0 - e.clientY, r.height)); return; }
      if (S.nav && e.pointerType === "touch") {
        const fingers = touches();
        if (fingers.length >= 2 && S.nav.n === 2 && S.nav.mode !== "view") {
          const now2 = fingers.slice(0, 2).map((p) => [p.x, p.y]);
          if (!S.nav.mode) {
            S.nav.mode = liftIntent(S.nav.start, now2, S.liftReady);
            if (S.nav.mode === "lift") beginLift();
          }
          if (S.nav.mode === "lift") {
            const y0 = (S.nav.start[0][1] + S.nav.start[1][1]) / 2, y1 = (now2[0][1] + now2[1][1]) / 2;
            moveLift(liftHeight(y0 - y1, r.height));
            return;
          }
          if (!S.nav.mode) return; // not decided yet: neither lift nor move the view
        }
        if (fingers.length >= 2) {
          const pts = fingers.slice(0, 2).map((p) => norm(p.x - r.left, p.y - r.top, r.width, r.height));
          const step = pinchStep(S.nav.prev, pts);
          S.nav.n = Math.max(S.nav.n, fingers.length);
          S.nav.moved = Math.max(S.nav.moved, ...fingers.map((p) => p.moved));
          if (step && S.nav.n === 2 && S.nav.moved >= 10) {
            nav.z *= step.z || 1;
            nav.x += (step.dx || 0) * r.width;
            nav.y += (step.dy || 0) * r.height;
            padSnap.style.transformOrigin = ((step.cx || 0.5) * 100) + "% " + ((step.cy || 0.5) * 100) + "%";
            padSnap.style.transform = "translate(" + nav.x + "px," + nav.y + "px) scale(" + nav.z + ")";
            const now = Date.now();
            if (now - (S.viewAt || 0) >= VIEW_MS) { S.viewAt = now; L.send("pc", "pad", { op: "view", dx: step.dx, dy: step.dy, z: step.z, cx: step.cx, cy: step.cy }); }
          }
          S.nav.prev = pts;
        }
        return;
      }
      if (!S.stroke) {
        if (e.pointerType === "pen" && e.buttons === 0 && surface()) {
          const now = Date.now();
          if (now - (S.hoverAt || 0) > 50) { S.hoverAt = now; S.hovering = true; L.send("pc", "pad", { op: "hover", pts: [norm(e.clientX - r.left, e.clientY - r.top, r.width, r.height)] }); }
        }
        return;
      }
      if (e.pointerId !== S.pointer) return;
      const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      const preds = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        const prev = ink.trail[ink.trail.length - 1];
        const s = sample(ev, r, true);
        S.pts.push(s.nx.concat([s.w, s.t]));
        S.all.push(s.nx);
        ink.trail.push(s);
        if (S.calibPts && ev.pointerType === "pen") S.calibPts.push(ev.pressure > 0 ? ev.pressure : 0.15);
        if (S.sound && ev.pointerType === "pen" && Date.now() - (S.scratchAt || 0) >= 35) {
          S.scratchAt = Date.now(); // one grain every 35 ms is plenty; one per pen event (240 Hz) would stutter
          scratch(prev ? Math.hypot(s.x - prev.x, s.y - prev.y) * 3 : 0, ev.pressure || 0.3);
        }
        if (!S.still || Math.hypot(s.x - S.still.x, s.y - S.still.y) >= 4) {
          S.snapShape = null;
          armHold(s.x, s.y);
        }
      }
      // predictions lead the pen; with « Lissage » the line deliberately trails it, so they would only mislead
      paint(S.smooth ? [] : (preds || []).slice(0, 4).map((ev) => sample(ev, r, false)));
      flushSoon();
    });
    function endPointer(e) {
      const rec = S.fingers.get(e.pointerId);
      S.fingers.delete(e.pointerId);
      if (e.pointerType === "pen") S.penDown = false;
      if (S.ringTimer && e.pointerId) { win.clearTimeout(S.ringTimer); S.ringTimer = 0; }
      if (S.ring && e.pointerId === S.ring.pid) {
        const pick = S.ring.pick;
        closeRing();
        applyRing(pick);
        return;
      }
      if (S.liftPtr && e.pointerId === S.liftPtr.id) {
        S.liftPtr = null;
        endLift(e.type !== "pointercancel" && !!S.lift && S.lift.h > 0.01);
        return;
      }
      if (S.nav && S.nav.mode === "lift" && e.pointerType === "touch") {
        if (touches().length === 0) { S.nav = null; endLift(!!S.lift && S.lift.h > 0.01); }
        return;
      }
      if (S.nav && e.pointerType === "touch") {
        if (touches().length === 0) {
          const dt = Date.now() - S.nav.t0;
          const tap = fingerTap(S.nav.n, dt, S.nav.moved);
          S.nav = null;
          if (tap) { L.send("pc", "pad", { op: tap }); haptic("tick"); resetNav(); }
        }
        return;
      }
      if (!S.stroke || e.pointerId !== S.pointer) return;
      if (!S.snapShape && S.tool !== "erase" && S.still && Date.now() - S.still.at >= 450 && win.HqShapeSnap) {
        const box = pad.getBoundingClientRect();
        S.snapShape = win.HqShapeSnap.recognise(S.all, box.width / Math.max(1, box.height));
      }
      if (S.holdT) { win.clearTimeout(S.holdT); S.holdT = 0; }
      if (e.type === "pointercancel") cancelStroke();
      else {
        if (S.calibPts && S.calibPts.length > 4) {
          const g = fitGamma(S.calibPts.map((p, i) => ({ p: p, target: i / (S.calibPts.length - 1) })));
          S.gamma = g;
          try { win.localStorage.setItem("tf_pad_gamma", String(g)); } catch (_) {}
          S.calib = false;
          sayAck("Pression " + g.toFixed(2), true);
        }
        if (S.strokeKind === "pen") S.penAt = Date.now();
        if (S.smooth && S.sm) {
          // « Lissage » leaves the line a little behind the pen: finish it where the pen actually lifted
          const r = inkBox(), last = ink.trail[ink.trail.length - 1];
          const raw = norm(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
          if (last && Math.hypot((raw[0] - last.nx[0]) * r.width, (raw[1] - last.nx[1]) * r.height) > 0.5) {
            const tail = { x: raw[0] * r.width, y: raw[1] * r.height, nx: raw, raw: raw, w: last.w, t: S.t0 ? Math.min(600000, Date.now() - S.t0) : 0 };
            ink.trail.push(tail); S.all.push(raw); S.pts.push(raw.concat([tail.w, tail.t]));
          }
        }
        flush(true);
        parkTrail();
        S.stroke = 0; S.all = []; S.snapShape = null;
        if (S.sound && S.strokeKind === "pen") scratch(0, 0);
      }
      pad.classList.remove("is-drawing");
      paint([]);
    }
    pad.addEventListener("pointerup", endPointer);
    pad.addEventListener("pointercancel", endPointer);
    pad.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "pen" && S.hovering && !S.stroke) { S.hovering = false; L.send("pc", "pad", { op: "hover", pts: [] }); }
    });
    penChip.addEventListener("click", () => {
      S.fingerToo = !S.fingerToo;
      penChip.setAttribute("aria-pressed", String(S.fingerToo));
      penChip.lastChild.textContent = S.fingerToo ? "Pencil + doigt" : "Pencil seul";
      haptic("tick");
    });
    toolBtn.addEventListener("click", () => {
      S.tool = S.tool === "erase" ? "pen" : "erase";
      toolBtn.dataset.padTool = S.tool;
      toolBtn.setAttribute("aria-pressed", String(S.tool === "erase"));
      toolBtn.lastChild.textContent = S.tool === "erase" ? "Gomme" : "Stylo";
      haptic("tick");
    });
    thicks.addEventListener("click", (e) => {
      const b = e.target.closest("[data-thick]"); if (!b) return;
      S.thick = b.dataset.thick;
      for (const kid of thicks.children) { const on = kid === b; kid.classList.toggle("is-on", on); kid.setAttribute("aria-pressed", String(on)); }
      haptic("tick");
    });
    function sayAck(text, ok) { ackLine.textContent = text; haptic(ok === false ? "err" : "tick"); }
    saveBtn.addEventListener("click", () => { if (!(S.peer && S.peer.online)) return; L.send("pc", "remote", { cmd: "save" }); sayAck("Enregistrement…", true); });
    photoBtn.addEventListener("click", () => photoIn.click());
    photoIn.addEventListener("change", async () => {
      const f = photoIn.files && photoIn.files[0];
      photoIn.value = "";
      if (!f) return;
      sayAck("Préparation de la photo…", true);
      try {
        if (typeof win.hqCarnetLoad === "function") await win.hqCarnetLoad();
        const Media = win.HqCarnetMedia;
        if (!Media) throw new Error("Images indisponibles");
        const prepared = await Media.prepare(f);
        const asset = await Media.upload(prepared.blob, win.api);
        if (!asset || !ASSET_RE.test(asset.id)) throw new Error("Image invalide");
        if (!(S.peer && S.peer.online)) { sayAck("Photo gardée, aucun PC ouvert", false); return; }
        L.send("pc", "remote", { cmd: "underlay", value: asset.id });
        sayAck("Photo envoyée", true);
      } catch (err) {
        const Media = win.HqCarnetMedia;
        sayAck(Media && Media.describeError ? Media.describeError(err) : "Photo impossible", false);
      }
    });
    undoBtn.addEventListener("click", () => { if (undoBtn.disabled) return; L.send("pc", "pad", { op: "undo" }); haptic("tick"); });
    redoBtn.addEventListener("click", () => { if (redoBtn.disabled) return; L.send("pc", "pad", { op: "redo" }); haptic("tick"); });
    const curveBtn = el(doc, "button", { type: "button", class: "desk-pill", text: "Réglage du Pencil" });
    const curveReset = el(doc, "button", { type: "button", class: "desk-pill", text: "Réinitialiser", hidden: true });
    const soundBtn = el(doc, "button", { type: "button", class: "desk-pill", "aria-pressed": "false", text: "Son du crayon" });
    const SMOOTH_NAMES = ["non", "léger", "fort"];
    const smoothBtn = el(doc, "button", { type: "button", class: "desk-pill desk-smooth", text: "Lissage : non" });
    const homeHint = el(doc, "p", { class: "desk-home-hint", hidden: true });
    const homeText = el(doc, "span", { text: "Pour un pad plein écran : Partager, puis « Sur l'écran d'accueil »." });
    const homeClose = el(doc, "button", { type: "button", class: "desk-pill", text: "Compris", "aria-label": "Masquer l'astuce d'écran d'accueil" });
    homeHint.append(homeText, homeClose);
    padPane.append(el(doc, "div", { class: "desk-row" }, [curveBtn, curveReset, smoothBtn, soundBtn]), homeHint);
    try {
      const g = parseFloat(win.localStorage.getItem("tf_pad_gamma"));
      if (g >= 0.5 && g <= 2) S.gamma = g;
      S.sound = win.localStorage.getItem("tf_pad_sound") === "1";
      const sm = parseInt(win.localStorage.getItem("tf_pad_smooth"), 10);
      if (sm >= 0 && sm < SMOOTH_LEVELS.length) S.smooth = sm;
    } catch (_) {}
    function showSmooth() {
      const name = SMOOTH_NAMES[S.smooth || 0];
      smoothBtn.textContent = "Lissage : " + name;
      smoothBtn.setAttribute("aria-label", "Lissage du trait : " + name + ". Toucher pour changer.");
      smoothBtn.classList.toggle("is-on", !!S.smooth);
    }
    showSmooth();
    smoothBtn.addEventListener("click", () => {
      S.smooth = ((S.smooth || 0) + 1) % SMOOTH_LEVELS.length;
      try { win.localStorage.setItem("tf_pad_smooth", String(S.smooth)); } catch (_) {}
      showSmooth();
      haptic("tick");
    });
    soundBtn.setAttribute("aria-pressed", String(!!S.sound));
    curveBtn.addEventListener("click", () => { S.calib = true; curveReset.hidden = false; sayAck("Du léger au lourd, un seul trait", true); });
    curveReset.addEventListener("click", () => {
      S.gamma = 1; S.calib = false;
      try { win.localStorage.removeItem("tf_pad_gamma"); } catch (_) {}
      sayAck("Pression d'origine", true);
    });
    soundBtn.addEventListener("click", () => {
      S.sound = !S.sound;
      soundBtn.setAttribute("aria-pressed", String(S.sound));
      try { win.localStorage.setItem("tf_pad_sound", S.sound ? "1" : "0"); } catch (_) {}
      if (S.sound) scratch(0, 0);
      haptic("tick");
    });
    homeClose.addEventListener("click", () => { homeHint.hidden = true; });
    function maybeHomeHint() {
      const standalone = !!(win.navigator.standalone || (win.matchMedia && win.matchMedia("(display-mode: standalone)").matches));
      if (standalone || S.hinted) return;
      S.hinted = true;
      homeHint.hidden = false;
    }

    // ---- lancer (flick to send)
    pickBtn.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = "";
      if (!f) return;
      if (S.photo && S.photo.url) URL.revokeObjectURL(S.photo.url);
      const url = URL.createObjectURL(f);
      flickImg.src = url;
      flickCard.hidden = false; flickCard.className = "desk-card is-ready"; flickCard.style.transform = "";
      flickHint.textContent = "Lance-la vers le haut ↑";
      const fd = new FormData();
      fd.append("folder", PHOTO_FOLDER);
      fd.append("files", f, f.name || ("photo-" + Date.now() + ".jpg"));
      S.photo = { url, name: f.name, up: win.api("/api/upload", { method: "POST", body: fd, timeoutMs: 120000 }).then((d) => (d.files || [])[0] || null) };
      S.photo.up.catch(() => {});
    });
    let drag = null;
    flickCard.addEventListener("pointerdown", (e) => {
      if (!S.photo) return;
      e.preventDefault();
      try { flickCard.setPointerCapture(e.pointerId); } catch (_) {}
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: win.performance.now(), hx: [] };
      flickCard.classList.add("is-held");
    });
    flickCard.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.hx.push({ x: e.clientX, y: e.clientY, t: win.performance.now() }); if (drag.hx.length > 6) drag.hx.shift();
      flickCard.style.transform = "translate(" + dx + "px," + dy + "px) rotate(" + dx * 0.06 + "deg)";
    });
    const release = async (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const h = drag.hx, a = h[0], b = h[h.length - 1];
      const dt = a && b && b.t > a.t ? b.t - a.t : 1;
      const vx = a && b ? (b.x - a.x) / dt : 0, vy = a && b ? (b.y - a.y) / dt : 0;
      drag = null;
      flickCard.classList.remove("is-held");
      if (!flickOk(dy, vy)) { flickCard.style.transform = ""; return; }
      haptic("drop");
      flickCard.classList.add("is-thrown");
      flickCard.style.transform = "translate(" + (dx + vx * 300) + "px," + (-win.innerHeight) + "px) rotate(" + vx * 30 + "deg) scale(.6)";
      const photo = S.photo; S.photo = null;
      flickHint.textContent = "Envoi…";
      let rel = null;
      try { rel = await photo.up; } catch (err) { flickHint.textContent = (err && err.message) || "Envoi impossible"; }
      win.setTimeout(() => { flickCard.hidden = true; flickCard.className = "desk-card"; flickCard.style.transform = ""; URL.revokeObjectURL(photo.url); }, 450);
      if (!rel) return;
      if (S.peer && S.peer.online) { L.send("pc", "flick", { rel, name: photo.name || rel.split("/").pop(), vx: Math.round(vx * 100) / 100, vy: Math.round(vy * 100) / 100 }); flickHint.textContent = "Envoyée sur le PC ✓"; }
      else flickHint.textContent = "Envoyée dans " + PHOTO_FOLDER + " (aucun PC ouvert)";
      haptic("done");
    };
    flickCard.addEventListener("pointerup", release);
    flickCard.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.id) { drag = null; flickCard.classList.remove("is-held"); flickCard.style.transform = ""; } });

    // ---- tabs, open, close
    function setTab(id) {
      S.tab = id;
      for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === id));
      for (const p of [padPane, lecteurPane, lancerPane]) p.hidden = p.dataset.pane !== id;
      if (id === "pad") { win.requestAnimationFrame(sizeInk); if (S.open) holdWake(); }
      else dropWake();
      if (id === "lecteur") loadLib();
    }
    tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
    function openPanel(tab) {
      if (S.open) { if (tab) setTab(tab); return; }
      S.open = true; S.hinted = false; S.from = doc.activeElement;
      sheet.hidden = false;
      doc.documentElement.classList.add("desk-open");
      win.requestAnimationFrame(() => { sheet.classList.add("is-open"); sizeInk(); });
      L.start(); L.publish({ device: "phone" });
      setTab(tab || S.tab);
      renderPeer();
      if ((tab || S.tab) === "pad") { maybeHomeHint(); holdWake(); }
    }
    function close() {
      if (!S.open) return;
      S.open = false;
      dropWake();
      closeRing();
      L.stop();
      sheet.classList.remove("is-open");
      doc.documentElement.classList.remove("desk-open");
      win.setTimeout(() => { if (!S.open) sheet.hidden = true; }, 240);
      if (S.from && S.from.focus && S.from !== doc.body) { try { S.from.focus({ preventScroll: true }); } catch (_) {} }
    }
    closeBtn.addEventListener("click", close);
    launcher.addEventListener("click", () => openPanel());
    sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    doc.addEventListener("visibilitychange", () => {
      if (!S.open) return;
      if (doc.visibilityState === "visible") { L.start(); if (S.tab === "pad") holdWake(); }
      else { L.stop(); dropWake(); }
    });
    win.addEventListener("resize", () => {
      if (!(S.open && S.tab === "pad")) return;
      if (S.stroke) cancelStroke();
      closeRing();
      sizeInk();
    });
    try {
      const wantPad = new URLSearchParams(win.location.search).get("desk") === "pad" || win.sessionStorage.getItem("tf_desk") === "pad";
      if (wantPad) {
        try { win.sessionStorage.removeItem("tf_desk"); } catch (_) {}
        openPanel("pad");
      }
    } catch (_) {}

    return { role: "phone", openPanel, close, link: L, state: () => ({ open: S.open, tab: S.tab, peer: S.peer }) };
  }

  return { VIEWS, norm, mergeMove, isPhoneLike, penGate, flickOk, pinchStep, fingerTap, pointWidth, THICK, tuneDelay, replayStep, retryDecision, retryWait, fitGamma, ringGuard, link, easePressure, tiltFactor, streamline, flushWait, safeColor, SMOOTH_LEVELS, liftIntent, liftHeight, boot, start };
});
