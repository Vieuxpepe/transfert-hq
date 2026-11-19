/* Transfert HQ — Lecteur+ : queue, resume, lock-screen controls, speed / A-B loop / sleep timer,
   synced lyrics, subtitles, tags + covers, smarter library, playlists, visualizer, 3D tools.
   Loaded after the inline player (iphone_bridge.py) and assets/hq-lecteur.js. It wraps the inline
   hqPlayer* functions instead of rewriting them. Server state: /api/lecteur/state (.hq-lecteur). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqLecteurPlus = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  /* ---------------------------------------------------------------- pure helpers (unit-tested) */

  function fmtTime(sec) {
    if (!(sec >= 0) || !isFinite(sec)) return "–:––";
    const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const two = (n) => (n < 10 ? "0" : "") + n;
    return h ? h + ":" + two(m) + ":" + two(r) : m + ":" + two(r);
  }

  // "[mm:ss.xx] text" (several stamps per line allowed, [offset:ms] honoured) -> [{t, text}] sorted by time.
  function parseLrc(text) {
    const lines = [];
    let offset = 0;
    String(text || "").split(/\r?\n/).forEach((raw) => {
      const off = /^\s*\[offset:\s*(-?\d+)\s*\]/i.exec(raw);
      if (off) { offset = Number(off[1]) / 1000; return; }
      const stamps = [];
      let rest = raw;
      let m;
      while ((m = /^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
        const frac = m[3] ? Number("0." + m[3]) : 0;
        stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
        rest = rest.slice(m[0].length);
      }
      if (!stamps.length) return;
      const line = rest.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "").trim();
      stamps.forEach((t) => lines.push({ t: Math.max(0, t - offset), text: line }));
    });
    return lines.sort((a, b) => a.t - b.t);
  }

  // Index of the last line whose time <= t, or -1 before the first one.
  function activeLine(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // "Artist - Title.mp3" -> {title, artist}; anything else keeps the whole stem as the title.
  function guessTitle(name) {
    const stem = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").trim();
    const m = /^(.{1,80}?)\s+[-–—]\s+(.+)$/.exec(stem);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: stem };
  }

  // Keep items[0..pos], shuffle the rest (Fisher-Yates). rnd() in [0,1) is injectable for tests.
  function shuffleAfter(items, pos, rnd) {
    const rand = rnd || Math.random;
    const head = items.slice(0, pos + 1), tail = items.slice(pos + 1);
    for (let i = tail.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = tail[i]; tail[i] = tail[j]; tail[j] = t;
    }
    return head.concat(tail);
  }

  const natural = (a, b) => String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });

  function parentOf(rel) { const i = String(rel).lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); }

  // items: library rows {rel,name,kind,size,mtime}; ctx: {tags, positions, recents(Map rel->rank), favorites(Set)}
  function sortItems(items, mode, ctx) {
    const tag = (f, k) => String((ctx.tags[f.rel] && ctx.tags[f.rel][k]) || "");
    const dur = (f) => Number((ctx.tags[f.rel] && ctx.tags[f.rel].duration) || (ctx.positions[f.rel] && ctx.positions[f.rel].d) || 0);
    const out = items.slice();
    const by = {
      recent: (a, b) => b.mtime - a.mtime,
      played: (a, b) => (ctx.recents.has(a.rel) ? ctx.recents.get(a.rel) : 1e9) - (ctx.recents.has(b.rel) ? ctx.recents.get(b.rel) : 1e9),
      name: (a, b) => natural(a.name, b.name),
      size: (a, b) => b.size - a.size,
      duration: (a, b) => dur(b) - dur(a),
      artist: (a, b) => natural(tag(a, "artist") || "￿", tag(b, "artist") || "￿") || natural(tag(a, "album"), tag(b, "album")) || natural(tag(a, "track").padStart(3, "0"), tag(b, "track").padStart(3, "0")),
    };
    out.sort(by[mode] || by.recent);
    return out;
  }

  function groupLabel(f, mode, ctx) {
    if (mode === "folder") return parentOf(f.rel).split("/").join(" / ") || "Racine";
    const t = ctx.tags[f.rel] || {};
    if (mode === "artist") return t.artist || (f.kind === "audio" ? "Artiste inconnu" : "Autres fichiers");
    if (mode === "album") return t.album ? (t.artist ? t.artist + " — " + t.album : t.album) : (f.kind === "audio" ? "Album inconnu" : "Autres fichiers");
    return "";
  }

  function dimsText(model, locale) {
    if (!model || !model.bounds) return "";
    const b = model.bounds, d = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
    const n = (v) => v.toLocaleString(locale || "fr-CA", { maximumFractionDigits: v >= 100 ? 0 : 1 });
    const mm = model.format !== "GLB";
    let text = n(d[0]) + " × " + n(d[1]) + " × " + n(d[2]) + (mm ? " mm" : " (unités du fichier)");
    if (mm && model.volume_mm3 > 0) text += " · ≈ " + n(model.volume_mm3 / 1000) + " cm³";
    return text;
  }

  /* ------------------------------------------------------------------------------ browser part */

  const PAGE = 80;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const SLEEP_CHOICES = [["0", "Minuteur : aucun"], ["15", "15 min"], ["30", "30 min"], ["45", "45 min"], ["60", "60 min"], ["end", "Fin du morceau"]];
  const doc = () => global.document;
  const $ = (sel) => doc().querySelector(sel);

  const S = {
    srv: { playlists: [], favorites: [], positions: {}, recents: [], prefs: {} }, srvLoaded: false,
    tags: {}, tagReq: new Set(), tagBusy: false,
    q: { items: [], pos: -1, orig: null }, ctxList: null,
    shuffle: false, repeat: "off", rate: 1, loop: { a: null, b: null },
    sleep: { until: 0, endOfTrack: false, timer: 0 },
    lyrics: { on: false, rel: "", lines: [], idx: -1, state: "" },
    subs: { rel: "", tracks: [], delay: 0 },
    viz: { on: false, ctx: null, an: null, src: null, raf: 0 },
    ui: { kind: "all", sort: "recent", group: "none", page: 1, playlist: "", filterKey: "" },
    built: false, recentLogged: false, lastPost: 0, lastSession: 0, resumeDismissed: {}, errSkips: 0, menu: null,
  };
  const el = {};  // cached DOM nodes

  function h(tag, attrs, ...kids) {
    const node = doc().createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "style") node.style.cssText = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    kids.flat().forEach((kid) => { if (kid != null && kid !== false) node.append(kid.nodeType ? kid : doc().createTextNode(String(kid))); });
    return node;
  }
  const btn = (text, help, onclick, extra) => h("button", Object.assign({ type: "button", class: "secondary lp-btn", "data-help": help, "aria-label": help, onclick }, extra || {}), text);

  const player = () => (typeof hqPlayer !== "undefined" ? hqPlayer : null);  // eslint-disable-line no-undef
  const lsGet = (k) => { try { return global.localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { global.localStorage.setItem(k, v); } catch (_) {} };
  const isIOS = () => (typeof global.hqIsIOS === "function" ? global.hqIsIOS() : /iPhone|iPad|iPod/.test(global.navigator.userAgent || ""));
  const calm = () => !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const toast = (msg, kind) => { if (typeof global.toast === "function") global.toast(msg, kind || "ok"); };
  const nameOf = (rel) => String(rel).split("/").pop() || rel;
  const kindOf = (rel) => (typeof global.hqMediaKind === "function" ? global.hqMediaKind(nameOf(rel)) : "");
  const libItem = (rel) => { const P = player(); return P ? P.lib.find((f) => f.rel === rel) : null; };
  const encRel = (rel) => String(rel).split("/").map(encodeURIComponent).join("/");
  const mediaEl = (kind) => doc().getElementById(kind === "video" ? "player-video" : "player-audio");

  function cur() {
    const P = player();
    if (!P || !P.rel) return null;
    const kind = kindOf(P.rel);
    if (kind !== "audio" && kind !== "video") return kind === "model" ? { rel: P.rel, kind, el: null } : null;
    const e = mediaEl(kind);
    return e && !e.hidden ? { rel: P.rel, kind, el: e } : null;
  }

  /* ------------------------------------------------------------------------------- server state */

  function post(url, body) {
    const headers = { "Content-Type": "application/json" };
    if (typeof global.hqCsrfToken === "function") { const t = global.hqCsrfToken(); if (t) headers["X-CSRF-Token"] = t; }
    return global.api(url, { method: "POST", headers, body: JSON.stringify(body || {}) });
  }
  async function srvOp(body) {
    try {
      const d = await post("/api/lecteur/state", body);
      if (d && d.state) S.srv = d.state;
      return S.srv;
    } catch (_) { return null; }
  }
  async function loadSrv() {
    try {
      const d = await global.api("/api/lecteur/state");
      if (d && d.state) {
        S.srv = d.state; S.srvLoaded = true;
        const p = S.srv.prefs || {};
        if (typeof p.rate === "number") S.rate = p.rate;
        if (typeof p.shuffle === "boolean") S.shuffle = p.shuffle;
        if (p.repeat) S.repeat = p.repeat;
        syncControls();
        applyRate();
        maybeResume();
        renderLibrary();
        renderPlaylists();
      }
    } catch (_) { /* old bridge or signed-out: the tab still works without shared state */ }
  }
  const favSet = () => new Set(S.srv.favorites || []);
  const prefsSave = () => srvOp({ op: "prefs", prefs: { rate: S.rate, shuffle: S.shuffle, repeat: S.repeat } });

  /* ------------------------------------------------------------------------------------- queue */

  function setQueue(items, pos) {
    S.q = { items: items.slice(), pos, orig: null };
    if (S.shuffle) { S.q.orig = items.slice(); S.q.items = shuffleAfter(S.q.items, pos); }
    renderQueue();
  }
  function contextQueue(rel) {
    const kind = kindOf(rel), P = player();
    let list = S.ctxList;
    S.ctxList = null;
    if (!list || list.indexOf(rel) < 0) {
      const dir = parentOf(rel);
      list = (P ? P.lib : []).filter((f) => f.kind === kind && parentOf(f.rel) === dir).map((f) => f.rel).sort((a, b) => natural(nameOf(a), nameOf(b)));
    }
    list = list.filter((r) => kindOf(r) === kind);
    if (list.indexOf(rel) < 0) list = [rel];
    setQueue(list, list.indexOf(rel));
  }
  function playQueue(items, start) {
    const list = items.filter(Boolean);
    if (!list.length) return;
    const first = Math.max(0, Math.min(start || 0, list.length - 1));
    setQueue(list, first);
    openRel(list[S.q.pos]);
  }
  function openRel(rel) {
    if (typeof global.hqPlayerOpen === "function") global.hqPlayerOpen(rel, true);
  }
  // Auto-advance / lock-screen next: load in place, never yank the user to the Lecteur tab.
  function loadInPlace(rel) { if (typeof global.hqPlayerLoad === "function") global.hqPlayerLoad(rel, true); }
  function advance(dir) {
    const q = S.q;
    if (!q.items.length) return false;
    let pos = q.pos + dir;
    if (pos >= q.items.length) {
      if (S.repeat !== "all") return false;
      if (S.shuffle) q.items = shuffleAfter(q.items, -1);
      pos = 0;
    }
    if (pos < 0) { if (S.repeat !== "all") return false; pos = q.items.length - 1; }
    q.pos = pos;
    loadInPlace(q.items[pos]);
    return true;
  }
  function enqueue(rel, next) {
    const c = cur();
    if (!c) { playQueue([rel], 0); return; }  // nothing playing: "add" simply starts it
    if (rel === c.rel) { toast("Déjà en cours de lecture."); return; }
    if (S.q.items[S.q.pos] !== c.rel) setQueue([c.rel], 0);
    const q = S.q;
    q.items = q.items.filter((r) => r !== rel);
    const at = q.items.indexOf(c.rel);
    if (next) q.items.splice(at + 1, 0, rel); else q.items.push(rel);
    q.pos = q.items.indexOf(c.rel);
    if (q.orig) q.orig.push(rel);
    renderQueue();
    toast(next ? "Lu ensuite." : "Ajouté à la file.");
  }
  function toggleShuffle() {
    S.shuffle = !S.shuffle;
    if (S.shuffle) { S.q.orig = S.q.items.slice(); S.q.items = shuffleAfter(S.q.items, S.q.pos); }
    else if (S.q.orig) { const now = S.q.items[S.q.pos]; S.q.items = S.q.orig.filter((r) => S.q.items.indexOf(r) >= 0); S.q.pos = Math.max(0, S.q.items.indexOf(now)); S.q.orig = null; }
    syncControls(); renderQueue(); prefsSave();
  }
  function cycleRepeat() { S.repeat = S.repeat === "off" ? "all" : S.repeat === "all" ? "one" : "off"; syncControls(); prefsSave(); }

  /* ----------------------------------------------------------------------------- playback hooks */

  function applyRate() {
    ["player-audio", "player-video"].forEach((id) => {
      const m = doc().getElementById(id);
      if (!m) return;
      try { m.defaultPlaybackRate = S.rate; m.playbackRate = S.rate; m.preservesPitch = true; m.webkitPreservesPitch = true; } catch (_) {}
    });
  }

  function onLoaded(rel) {
    const kind = kindOf(rel);
    S.loop = { a: null, b: null };
    S.recentLogged = false;
    S.errSkips = S.errSkips || 0;
    if (S.q.items[S.q.pos] !== rel) contextQueue(rel); else renderQueue();
    applyRate();
    if (el.wrap) el.wrap.dataset.kind = kind || "";
    hideResume();
    syncControls();
    if (kind === "audio") loadTags([rel], true).then(() => { if (player() && player().rel === rel) { renderNow(); updateSession(); } });
    renderNow();
    updateSession();
    S.subs = { rel: "", tracks: [], delay: 0 };
    renderSubs();
    if (kind === "video") loadSubs(rel);
    S.lyrics = { on: S.lyrics.on, rel: "", lines: [], idx: -1, state: "" };
    renderLyrics();
    if (kind === "audio" && S.lyrics.on) ensureLyrics();
    maybeResume();
    syncModelButtons();
  }

  function bindMedia(m) {
    if (!m || m.__lp) return;
    m.__lp = true;
    m.addEventListener("loadedmetadata", () => { maybeResume(); renderNow(); });
    m.addEventListener("play", () => {
      const c = cur();
      if (c && c.el === m && !S.recentLogged) { S.recentLogged = true; srvOp({ op: "recent", rel: c.rel }); if (S.ui.kind === "recent") renderLibrary(); }
      S.errSkips = 0;
      syncControls(); vizStart(); setSessionState("playing");
    });
    m.addEventListener("pause", () => { if (cur() && cur().el === m) recordPos(true); syncControls(); setSessionState("paused"); });
    m.addEventListener("ratechange", syncControls);
    m.addEventListener("timeupdate", () => onTime(m));
    m.addEventListener("ended", () => onEnded(m));
    m.addEventListener("error", () => onMediaError(m));
  }

  function onTime(m) {
    const c = cur();
    if (!c || c.el !== m) return;
    const { a, b } = S.loop;
    if (a != null && b != null && m.currentTime >= b) { m.currentTime = a; return; }
    if (S.lyrics.lines.length) highlightLyric(m.currentTime);
    if (!m.paused) recordPos(false);
    const now = Date.now();
    if (now - S.lastSession > 1000) { S.lastSession = now; updatePosition(m); }
    if (el.seekLabel) el.seekLabel.textContent = fmtTime(m.currentTime) + " / " + fmtTime(m.duration);
  }

  function onEnded(m) {
    const c = cur();
    if (!c || c.el !== m) return;
    srvOp({ op: "position", rel: c.rel, done: true, d: Math.floor(m.duration || 0) });
    if (S.sleep.endOfTrack) { clearSleep(); toast("Minuteur : lecture terminée."); return; }
    if (S.repeat === "one") { m.currentTime = 0; const p = m.play(); if (p && p.catch) p.catch(() => {}); return; }
    if (!advance(1)) syncControls();
  }

  // A file in the queue that cannot play (moved, codec): skip it instead of stalling the whole queue.
  function onMediaError(m) {
    const c = cur();
    if (!c || c.el !== m || S.q.items.length < 2 || S.errSkips >= S.q.items.length) return;
    S.errSkips++;
    advance(1);
  }

  function recordPos(force) {
    const c = cur();
    if (!c || !c.el) return;
    const m = c.el, d = m.duration, t = m.currentTime;
    if (!(d > 0) || !isFinite(d) || !(t >= 5) || (c.kind === "audio" && d < 120)) return;
    S.srv.positions[c.rel] = { t, d, at: Math.floor(Date.now() / 1000), done: false };
    const now = Date.now();
    if (!force && now - S.lastPost < 15000) return;
    S.lastPost = now;
    srvOp({ op: "position", rel: c.rel, t: Math.floor(t), d: Math.floor(d) });
  }

  /* ----------------------------------------------------------------------------------- resume */

  function hideResume() { if (el.resume) el.resume.hidden = true; }
  function maybeResume() {
    const c = cur();
    if (!c || !c.el || !el.resume || !S.srvLoaded) return;
    const p = S.srv.positions[c.rel];
    const d = c.el.duration > 0 && isFinite(c.el.duration) ? c.el.duration : (p ? p.d : 0);
    if (!p || p.done || p.t < 10 || d - p.t < 15 || S.resumeDismissed[c.rel]) { hideResume(); return; }
    if (!(c.kind === "video" || d >= 300)) { hideResume(); return; }
    if (c.el.currentTime >= p.t - 5) { hideResume(); return; }
    el.resumeText.textContent = "Reprendre à " + fmtTime(p.t) + " ?";
    el.resume.hidden = false;
  }
  function doResume(fromStart) {
    const c = cur();
    if (!c || !c.el) return;
    S.resumeDismissed[c.rel] = true;
    hideResume();
    if (!fromStart) {
      const p = S.srv.positions[c.rel];
      if (p) { try { c.el.currentTime = p.t; } catch (_) {} }
      const pr = c.el.play(); if (pr && pr.catch) pr.catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------ transport controls */

  function togglePlay() {
    const c = cur();
    if (!c || !c.el) return;
    if (c.el.paused) { const p = c.el.play(); if (p && p.catch) p.catch(() => {}); } else c.el.pause();
  }
  function seekBy(sec) {
    const c = cur();
    if (!c || !c.el) return;
    const d = c.el.duration;
    c.el.currentTime = Math.max(0, Math.min(isFinite(d) ? d : 1e9, c.el.currentTime + sec));
  }
  function prevTrack() {
    const c = cur();
    if (c && c.el && c.el.currentTime > 3) { c.el.currentTime = 0; return; }
    if (!advance(-1) && c && c.el) c.el.currentTime = 0;
  }
  function setRate(v) {
    S.rate = Math.max(0.5, Math.min(2.5, Number(v) || 1));
    applyRate(); syncControls(); prefsSave();
  }
  function cycleLoop() {
    const c = cur();
    if (!c || !c.el) return;
    const t = c.el.currentTime;
    if (S.loop.a == null) S.loop = { a: t, b: null };
    else if (S.loop.b == null) { if (t - S.loop.a < 0.5) { S.loop = { a: null, b: null }; } else S.loop.b = t; }
    else S.loop = { a: null, b: null };
    syncControls();
  }

  function clearSleep() {
    if (S.sleep.timer) global.clearInterval(S.sleep.timer);
    S.sleep = { until: 0, endOfTrack: false, timer: 0 };
    if (el.sleepSel) el.sleepSel.value = "0";
    if (el.sleepLabel) el.sleepLabel.textContent = "";
  }
  function setSleep(choice) {
    clearSleep();
    if (choice === "end") { S.sleep.endOfTrack = true; el.sleepSel.value = "end"; el.sleepLabel.textContent = "⏾ fin du morceau"; return; }
    const min = Number(choice);
    if (!(min > 0)) return;
    el.sleepSel.value = String(min);
    S.sleep.until = Date.now() + min * 60000;
    const tick = () => {
      const left = S.sleep.until - Date.now();
      if (left <= 0) { fadeOutAndPause(); return; }
      el.sleepLabel.textContent = "⏾ " + fmtTime(left / 1000);
    };
    S.sleep.timer = global.setInterval(tick, 1000);
    tick();
  }
  function fadeOutAndPause() {
    clearSleep();
    const c = cur();
    if (!c || !c.el || c.el.paused) return;
    const m = c.el, v0 = m.volume;
    if (isIOS() || calm()) { m.pause(); return; }  // iOS ignores programmatic volume
    let step = 0;
    const iv = global.setInterval(() => {
      step++;
      try { m.volume = Math.max(0, v0 * (1 - step / 20)); } catch (_) {}
      if (step >= 20) { global.clearInterval(iv); m.pause(); try { m.volume = v0; } catch (_) {} toast("Minuteur : bonne nuit."); }
    }, 200);
  }

  async function togglePip() {
    const v = doc().getElementById("player-video");
    if (!v || v.hidden) return;
    try {
      if (doc().pictureInPictureElement) await doc().exitPictureInPicture();
      else if (doc().pictureInPictureEnabled && !v.disablePictureInPicture) await v.requestPictureInPicture();
      else if (typeof v.webkitSetPresentationMode === "function") v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      else toast("Image dans l'image indisponible ici.", "err");
    } catch (_) { toast("Image dans l'image indisponible ici.", "err"); }
  }
  function airplay() {
    const c = cur();
    if (c && c.el && typeof c.el.webkitShowPlaybackTargetPicker === "function") c.el.webkitShowPlaybackTargetPicker();
  }
  function fullscreen() {
    const v = doc().getElementById("player-video");
    if (!v || v.hidden) return;
    try {
      if (doc().fullscreenElement) doc().exitFullscreen();
      else if (v.requestFullscreen) v.requestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    } catch (_) {}
  }

  /* -------------------------------------------------------------------------------- mediaSession */

  const ms = () => (global.navigator && global.navigator.mediaSession) || null;
  function bindSession() {
    const s = ms();
    if (!s) return;
    const set = (a, fn) => { try { s.setActionHandler(a, fn); } catch (_) {} };
    set("play", () => { const c = cur(); if (c && c.el) { const p = c.el.play(); if (p && p.catch) p.catch(() => {}); } });
    set("pause", () => { const c = cur(); if (c && c.el) c.el.pause(); });
    set("previoustrack", prevTrack);
    set("nexttrack", () => { advance(1); });
    set("seekbackward", (d) => seekBy(-((d && d.seekOffset) || 15)));
    set("seekforward", (d) => seekBy((d && d.seekOffset) || 15));
    set("seekto", (d) => { const c = cur(); if (c && c.el && d && typeof d.seekTime === "number") c.el.currentTime = d.seekTime; });
    set("stop", () => { const c = cur(); if (c && c.el) c.el.pause(); });
  }
  function setSessionState(state) { const s = ms(); if (s) { try { s.playbackState = state; } catch (_) {} } }
  function updatePosition(m) {
    const s = ms();
    if (!s || !s.setPositionState || !(m.duration > 0) || !isFinite(m.duration)) return;
    try { s.setPositionState({ duration: m.duration, playbackRate: m.playbackRate || 1, position: Math.min(m.currentTime, m.duration) }); } catch (_) {}
  }
  function updateSession() {
    const s = ms(), c = cur();
    if (!s || !c || !global.MediaMetadata || !c.el) return;
    const t = S.tags[c.rel] || {}, g = guessTitle(nameOf(c.rel));
    const art = t.has_art ? [{ src: "/api/media/art?rel=" + encodeURIComponent(c.rel), sizes: "512x512" }] : [];
    try {
      s.metadata = new global.MediaMetadata({ title: t.title || g.title, artist: t.artist || g.artist, album: t.album || parentOf(c.rel).split("/").pop() || "Transfert", artwork: art });
    } catch (_) {}
  }

  /* ----------------------------------------------------------------------------- tags and covers */

  async function loadTags(rels, urgent) {
    const need = rels.filter((r) => kindOf(r) === "audio" && (urgent ? !S.tags[r] : !S.tags[r] && !S.tagReq.has(r)));
    if (!need.length) return;
    need.forEach((r) => S.tagReq.add(r));
    for (let i = 0; i < need.length; i += 40) {
      try {
        const d = await post("/api/media/meta", { rels: need.slice(i, i + 40) });
        Object.keys((d && d.tags) || {}).forEach((r) => { S.tags[r] = d.tags[r] || {}; });
      } catch (_) { break; }
    }
  }
  let tagTimer = 0;
  // Sorting / grouping by tags needs them for every audio file: read them in the background, in batches.
  function scheduleTagFill() {
    if (tagTimer || S.tagBusy) return;
    const wantAll = S.ui.group === "artist" || S.ui.group === "album" || S.ui.sort === "artist" || S.ui.sort === "duration";
    tagTimer = global.setTimeout(async () => {
      tagTimer = 0;
      const P = player();
      if (!P) return;
      const pool = wantAll ? P.lib : visibleItems.slice(0, PAGE * S.ui.page);
      const batch = pool.filter((f) => f.kind === "audio" && !S.tags[f.rel] && !S.tagReq.has(f.rel)).slice(0, 120).map((f) => f.rel);
      if (!batch.length) return;
      S.tagBusy = true;
      await loadTags(batch, false);
      S.tagBusy = false;
      renderLibrary(true);
    }, 250);
  }

  /* --------------------------------------------------------------------------------- now playing */

  function renderNow() {
    if (!el.now) return;
    const c = cur();
    const show = !!(c && c.kind === "audio");
    el.now.hidden = !show;
    if (!show) return;
    const t = S.tags[c.rel] || {}, g = guessTitle(nameOf(c.rel));
    el.nowTitle.textContent = t.title || g.title;
    const sub = [t.artist || g.artist, t.album].filter(Boolean).join(" — ");
    el.nowSub.textContent = sub || parentOf(c.rel).split("/").join(" / ");
    const artUrl = t.has_art ? "/api/media/art?rel=" + encodeURIComponent(c.rel) : "";
    el.cover.hidden = !artUrl;
    if (artUrl && el.cover.getAttribute("data-src") !== artUrl) { el.cover.src = artUrl; el.cover.setAttribute("data-src", artUrl); }
    el.now.style.setProperty("--lp-art", artUrl ? 'url("' + artUrl + '")' : "none");
    el.now.classList.toggle("has-art", !!artUrl);
    syncControls();
  }

  /* ------------------------------------------------------------------------------------- lyrics */

  const LRC_KEY = "tf_hq_lp_lrc_v1";
  function lrcCache() { try { return JSON.parse(lsGet(LRC_KEY) || "{}") || {}; } catch (_) { return {}; } }
  function lrcStore(rel, lrc) {
    const all = lrcCache();
    all[rel] = { lrc, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 40);
    const trimmed = {};
    keys.forEach((k) => { trimmed[k] = all[k]; });
    lsSet(LRC_KEY, JSON.stringify(trimmed));
  }
  async function ensureLyrics() {
    const c = cur();
    if (!c || c.kind !== "audio" || !S.lyrics.on || S.lyrics.rel === c.rel) return;
    S.lyrics.rel = c.rel; S.lyrics.lines = []; S.lyrics.idx = -1;
    const cached = lrcCache()[c.rel];
    const fresh = cached && (cached.lrc ? true : Date.now() - cached.at < 7 * 864e5);
    if (fresh) { S.lyrics.lines = parseLrc(cached.lrc); S.lyrics.state = S.lyrics.lines.length ? "" : "none"; renderLyrics(); return; }
    S.lyrics.state = "loading"; renderLyrics();
    await loadTags([c.rel], true);
    const t = S.tags[c.rel] || {}, g = guessTitle(nameOf(c.rel));
    const dur = (c.el && c.el.duration > 0 && isFinite(c.el.duration)) ? c.el.duration : (t.duration || 0);
    try {
      const d = await post("/api/musica/lyrics", { title: t.title || g.title, artist: t.artist || g.artist, duration: Math.round(dur) });
      if (S.lyrics.rel !== c.rel) return;
      const lrc = (d && d.lrc) || "";
      lrcStore(c.rel, lrc);
      S.lyrics.lines = parseLrc(lrc);
      S.lyrics.state = S.lyrics.lines.length ? "" : "none";
    } catch (_) {
      if (S.lyrics.rel !== c.rel) return;
      S.lyrics.state = "error";
      S.lyrics.rel = "";  // let the next toggle retry
    }
    renderLyrics();
  }
  function renderLyrics() {
    if (!el.lyrics) return;
    const c = cur();
    const show = !!(S.lyrics.on && c && c.kind === "audio");
    el.lyrics.hidden = !show;
    if (!show) return;
    el.lyrics.textContent = "";
    if (S.lyrics.state === "loading") { el.lyrics.append(h("p", { class: "hint", text: "Recherche des paroles (LRCLIB)…" })); return; }
    if (S.lyrics.state === "none") { el.lyrics.append(h("p", { class: "hint", text: "Aucune parole synchronisée trouvée pour ce titre." })); return; }
    if (S.lyrics.state === "error") { el.lyrics.append(h("p", { class: "hint", text: "Recherche des paroles indisponible pour l'instant." })); return; }
    S.lyrics.lines.forEach((ln, i) => {
      el.lyrics.append(h("p", { class: "lp-line", "data-i": i, onclick: () => { const cc = cur(); if (cc && cc.el) cc.el.currentTime = ln.t; } }, ln.text || "♪"));
    });
    S.lyrics.idx = -1;
    if (c.el) highlightLyric(c.el.currentTime);
  }
  function highlightLyric(t) {
    const i = activeLine(S.lyrics.lines, t + 0.15);
    if (i === S.lyrics.idx || !el.lyrics || el.lyrics.hidden) return;
    const prev = el.lyrics.querySelector(".is-active");
    if (prev) prev.classList.remove("is-active");
    S.lyrics.idx = i;
    const line = i >= 0 ? el.lyrics.querySelector('[data-i="' + i + '"]') : null;
    if (!line) return;
    line.classList.add("is-active");
    const top = line.offsetTop - el.lyrics.clientHeight / 2 + line.clientHeight / 2;
    try { el.lyrics.scrollTo({ top: Math.max(0, top), behavior: calm() ? "auto" : "smooth" }); } catch (_) { el.lyrics.scrollTop = Math.max(0, top); }
  }

  /* ------------------------------------------------------------------------------------ subtitles */

  async function loadSubs(rel) {
    try {
      const d = await global.api("/api/media/subs?rel=" + encodeURIComponent(rel));
      const P = player();
      if (!P || P.rel !== rel) return;
      S.subs = { rel, tracks: (d && d.tracks) || [], delay: 0 };
      attachTracks();
      renderSubs();
    } catch (_) { /* no subtitles route: plain video */ }
  }
  function attachTracks() {
    const v = doc().getElementById("player-video");
    if (!v) return;
    Array.from(v.querySelectorAll("track")).forEach((t) => t.remove());
    const dir = parentOf(S.subs.rel);
    S.subs.tracks.forEach((tr, i) => {
      const node = h("track", { kind: "subtitles", label: tr.label, srclang: tr.lang || "und", src: "/api/media/sub?rel=" + encodeURIComponent((dir ? dir + "/" : "") + tr.name), "data-i": i });
      v.append(node);
    });
    global.setTimeout(() => pickSub(S.subs.tracks.length ? 0 : -1), 0);
  }
  function pickSub(index) {
    const v = doc().getElementById("player-video");
    if (!v) return;
    S.subs.delay = 0;
    Array.from(v.textTracks || []).forEach((tt, i) => { tt.mode = i === index ? "showing" : "disabled"; });
    if (el.subSel) el.subSel.value = String(index);
    syncSubDelay();
  }
  // Shift every cue of the shown track by the chosen delay (originals remembered once).
  function shiftSubs(delta) {
    const v = doc().getElementById("player-video");
    if (!v) return;
    S.subs.delay = Math.round((S.subs.delay + delta) * 10) / 10;
    Array.from(v.textTracks || []).forEach((tt) => {
      if (tt.mode !== "showing" || !tt.cues) return;
      Array.from(tt.cues).forEach((cue) => {
        if (cue.__t0 == null) { cue.__t0 = cue.startTime; cue.__t1 = cue.endTime; }
        cue.startTime = Math.max(0, cue.__t0 + S.subs.delay);
        cue.endTime = Math.max(0.1, cue.__t1 + S.subs.delay);
      });
    });
    syncSubDelay();
  }
  function syncSubDelay() { if (el.subDelay) el.subDelay.textContent = (S.subs.delay > 0 ? "+" : "") + S.subs.delay.toFixed(1).replace(".", ",") + " s"; }
  function renderSubs() {
    if (!el.subBox) return;
    const has = S.subs.tracks.length > 0;
    el.subBox.hidden = !has;
    if (!has) return;
    el.subSel.textContent = "";
    el.subSel.append(h("option", { value: "-1", text: "Sous-titres : aucun" }));
    S.subs.tracks.forEach((tr, i) => el.subSel.append(h("option", { value: String(i), text: "Sous-titres : " + tr.label })));
    syncSubDelay();
  }

  /* --------------------------------------------------------------------------------- visualizer */

  function vizEnable() {
    if (isIOS()) { toast("Le visualiseur est réservé au PC (il couperait la lecture écran verrouillé sur iPhone).", "err"); return false; }
    const a = doc().getElementById("player-audio");
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!a || !AC) { toast("Visualiseur indisponible dans ce navigateur.", "err"); return false; }
    if (!S.viz.ctx) {
      try {
        S.viz.ctx = new AC();
        S.viz.src = S.viz.ctx.createMediaElementSource(a);
        S.viz.an = S.viz.ctx.createAnalyser();
        S.viz.an.fftSize = 256; S.viz.an.smoothingTimeConstant = 0.78;
        S.viz.src.connect(S.viz.an); S.viz.an.connect(S.viz.ctx.destination);
      } catch (_) { S.viz.ctx = null; toast("Visualiseur indisponible dans ce navigateur.", "err"); return false; }
    }
    try { if (S.viz.ctx.state === "suspended") S.viz.ctx.resume(); } catch (_) {}
    return true;
  }
  function toggleViz() {
    if (S.viz.on) S.viz.on = false;
    else if (vizEnable()) S.viz.on = true;
    syncControls(); vizStart();
  }
  function vizStart() {
    const c = cur();
    if (!S.viz.on || !S.viz.an || S.viz.raf || !c || c.kind !== "audio" || !el.viz) return;
    if (S.viz.ctx && S.viz.ctx.state === "suspended") { try { S.viz.ctx.resume(); } catch (_) {} }
    const cv = el.viz, g = cv.getContext("2d"), data = new Uint8Array(S.viz.an.frequencyBinCount);
    const accent = (global.getComputedStyle(cv).getPropertyValue("--accent") || "#3dffb5").trim() || "#3dffb5";
    const loop = () => {
      S.viz.raf = 0;
      const cc = cur();
      const m = cc && cc.el;
      if (!S.viz.on || !m || m.paused || doc().body.dataset.view !== "lecteur") { g.clearRect(0, 0, cv.width, cv.height); return; }
      const w = cv.clientWidth * (global.devicePixelRatio || 1), hh = cv.clientHeight * (global.devicePixelRatio || 1);
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
      S.viz.an.getByteFrequencyData(data);
      g.clearRect(0, 0, w, hh);
      g.fillStyle = accent;
      const bars = 40, gap = w / bars;
      for (let i = 0; i < bars; i++) {
        const bin = Math.min(data.length - 1, Math.floor(Math.pow(i / bars, 1.7) * data.length));
        const v = data[bin] / 255, bh = Math.max(2, v * hh);
        g.globalAlpha = 0.35 + v * 0.65;
        g.fillRect(i * gap + gap * 0.15, hh - bh, gap * 0.7, bh);
      }
      S.viz.raf = global.requestAnimationFrame(loop);
    };
    loop();
  }

  /* ------------------------------------------------------------------------------------ 3D extras */

  const modelState = () => { const m = typeof hqModel !== "undefined" ? hqModel : null; return m && m.viewer ? m.viewer : null; };  // eslint-disable-line no-undef
  function syncModelButtons() {
    const v = modelState();
    if (el.wire) el.wire.setAttribute("aria-pressed", v && v.wireframe ? "true" : "false");
    if (el.spin) el.spin.setAttribute("aria-pressed", v && v.autoRotate ? "true" : "false");
  }
  async function captureModel() {
    const v = modelState(), P = player();
    if (!v || !v.snapshot) return;
    const blob = await v.snapshot();
    if (!blob) { toast("Capture impossible.", "err"); return; }
    const url = global.URL.createObjectURL(blob);
    const a = h("a", { href: url, download: nameOf(P ? P.rel : "modele").replace(/\.[a-z0-9]+$/i, "") + ".png" });
    doc().body.append(a); a.click(); a.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(url), 4000);
  }
  // The Atelier 3D tab only exists on builds that register the view: hide the hand-off elsewhere.
  function atelierAvailable() {
    return typeof VIEW_LABELS !== "undefined" && !!(VIEW_LABELS && VIEW_LABELS.atelier3d);  // eslint-disable-line no-undef
  }
  async function sendToAtelier(rel) {
    try {
      const r = await global.fetch("/media/" + encRel(rel), { credentials: "same-origin" });
      if (!r.ok) throw new Error("fetch");
      const file = new global.File([await r.blob()], nameOf(rel));
      global.setView("atelier3d");
      for (let i = 0; i < 40; i++) {
        const P3 = global.HqPrint3d;
        const open = P3 && (P3.openFiles || (P3._hooks && P3._hooks.openFilesInStudio));
        if (open) { open([file]); return; }
        await new Promise((res) => global.setTimeout(res, 150));
      }
      toast("Atelier 3D ouvert : ajoute le fichier avec « Ouvrir un fichier… ».", "err");
    } catch (_) { toast("Envoi à l'Atelier impossible.", "err"); }
  }
  // Dimensions under the model: appended whenever the inline code writes the "N triangles" line.
  function wrapModelInfo() {
    if (typeof global.hqModelInfo !== "function" || global.hqModelInfo.__lp) return;
    const orig = global.hqModelInfo;
    const w = function (text) {
      let out = text;
      const v = modelState();
      if (text && /triangles/.test(text) && v && v.model) { const dims = dimsText(v.model); if (dims) out = text + " · " + dims; }
      orig(out);
      syncModelButtons();
    };
    w.__lp = true;
    global.hqModelInfo = w;
  }

  /* ----------------------------------------------------------------------------------- library */

  let visibleItems = [];  // filtered + sorted rows (before paging), used for "play from here"

  function effectiveItems() {
    const P = player();
    if (!P) return [];
    const q = ((doc().getElementById("player-filter") || {}).value || "").trim().toLowerCase();
    const favs = favSet();
    const recents = new Map((S.srv.recents || []).map((r, i) => [r.rel, i]));
    let items = P.lib.slice();
    const u = S.ui;
    if (u.playlist) {
      const pl = S.srv.playlists.find((p) => p.id === u.playlist);
      const byRel = new Map(items.map((f) => [f.rel, f]));
      items = pl ? pl.items.map((r) => byRel.get(r)).filter(Boolean) : [];
    } else if (u.kind === "fav") items = items.filter((f) => favs.has(f.rel));
    else if (u.kind === "recent") items = items.filter((f) => recents.has(f.rel));
    else if (u.kind !== "all") items = items.filter((f) => f.kind === u.kind);
    if (q) {
      items = items.filter((f) => {
        const t = S.tags[f.rel] || {};
        return (f.rel + " " + (t.title || "") + " " + (t.artist || "") + " " + (t.album || "")).toLowerCase().includes(q);
      });
    }
    const mode = u.playlist ? "manual" : u.kind === "recent" ? "played" : u.sort;
    if (mode !== "manual") items = sortItems(items, mode, { tags: S.tags, positions: S.srv.positions, recents, favorites: favs });
    return items;
  }

  function itemMeta(f) {
    const t = S.tags[f.rel] || {}, p = S.srv.positions[f.rel];
    const dur = t.duration || (p && p.d) || 0;
    const parts = [];
    if (f.kind === "audio" && (t.artist || t.album)) parts.push([t.artist, t.album].filter(Boolean).join(" — "));
    else parts.push(parentOf(f.rel).split("/").join(" / "));
    if (dur) parts.push(fmtTime(dur));
    parts.push(f.size_h, f.mtime_h);
    return parts.filter(Boolean).join(" · ");
  }

  function renderLibrary(keepPage) {
    const P = player(), list = $("#player-list");
    if (!P || !list) return;
    ensureLibUI();
    const filterKey = [(($("#player-filter") || {}).value || ""), S.ui.kind, S.ui.sort, S.ui.group, S.ui.playlist].join("|");
    if (!keepPage && filterKey !== S.ui.filterKey) S.ui.page = 1;
    S.ui.filterKey = filterKey;
    const countEl = $("#player-count");
    if (countEl) countEl.textContent = String(P.lib.length);
    visibleItems = effectiveItems();
    syncChips();
    list.textContent = "";
    if (!visibleItems.length) {
      if (!S.libLoaded && !P.libError) { list.append(h("li", { class: "hint", text: "Chargement…" })); if (el.more) el.more.hidden = true; return; }
      const empty = P.libError || (S.ui.playlist ? "Cette playlist est vide pour l'instant." : S.ui.kind === "fav" ? "Aucun favori : touche ♡ à côté d'un fichier." : S.ui.kind === "recent" ? "Rien lu récemment." : (($("#player-filter") || {}).value ? "Aucun résultat" : "Aucune musique, vidéo ni modèle 3D dans Transfert pour l'instant."));
      list.append(h("li", { class: "hint", text: empty }));
      if (el.more) el.more.hidden = true;
      return;
    }
    const shown = visibleItems.slice(0, PAGE * S.ui.page);
    const favs = favSet(), mode = S.ui.playlist ? "none" : S.ui.group;
    let lastGroup = null;
    shown.forEach((f) => {
      if (mode !== "none") {
        const label = groupLabel(f, mode, { tags: S.tags });
        if (label !== lastGroup) { list.append(h("li", { class: "lp-group", text: label })); lastGroup = label; }
      }
      const isCur = f.rel === P.rel, pos = S.srv.positions[f.rel];
      const pct = pos && pos.d > 0 && !pos.done ? Math.min(100, Math.round((pos.t / pos.d) * 100)) : 0;
      list.append(h("li", { class: "player-item" + (isCur ? " is-current" : ""), "data-rel": f.rel },
        h("button", { type: "button", class: "player-pick", "data-help": "Lire ce fichier.", "data-play": f.rel, "aria-current": isCur ? "true" : null },
          h("span", { class: "player-ico", "aria-hidden": "true", text: typeof global.hqMediaIcon === "function" ? global.hqMediaIcon(f.kind) : "" }),
          h("span", { class: "player-item-body" },
            h("span", { class: "fname", text: (S.tags[f.rel] && S.tags[f.rel].title) || f.name }),
            h("span", { class: "meta", text: itemMeta(f) }),
            pct ? h("span", { class: "lp-prog", "aria-label": "Avancement " + pct + " %" }, h("i", { style: "width:" + pct + "%" })) : null,
            pos && pos.done ? h("span", { class: "lp-done", text: "✓ terminé" }) : null)),
        h("button", { type: "button", class: "lp-fav" + (favs.has(f.rel) ? " is-on" : ""), "data-lp-fav": f.rel, "data-help": "Favori.", "aria-label": favs.has(f.rel) ? "Retirer des favoris" : "Ajouter aux favoris", "aria-pressed": favs.has(f.rel) ? "true" : "false", text: favs.has(f.rel) ? "♥" : "♡" }),
        h("button", { type: "button", class: "lp-more-btn", "data-lp-menu": f.rel, "data-help": "Plus d'actions.", "aria-label": "Plus d'actions pour " + f.name, "aria-haspopup": "menu", text: "⋯" })));
    });
    if (P.libTruncated && shown.length >= visibleItems.length) list.append(h("li", { class: "hint", text: "Liste limitée aux " + P.lib.length + " fichiers les plus récents." }));
    if (el.more) {
      const left = visibleItems.length - shown.length;
      el.more.hidden = left <= 0;
      el.more.textContent = "Afficher " + Math.min(PAGE, left) + " de plus (" + left + " restants)";
    }
    scheduleTagFill();
  }

  function installRenderHooks() {
    if (typeof global.hqPlayerRenderList === "function" && !global.hqPlayerRenderList.__lp) {
      let first = true;
      const w = function () {
        renderLibrary();
        if (global.HqLecteur && global.HqLecteur.staggerList) { try { global.HqLecteur.staggerList(first); } catch (_) {} }
        first = false;
      };
      w.__lp = true; w.__lecteur = true;
      global.hqPlayerRenderList = w;
    }
    if (typeof global.hqPlayerLibrary === "function" && !global.hqPlayerLibrary.__lp) {
      const lib = async function (force) {
        const P = player();
        if (!P) return;
        if (!force && P.libAt && Date.now() - P.libAt < 30000) { global.hqPlayerRenderList(); return; }
        P.libAt = Date.now();
        try {
          const d = await global.api("/api/media/library?limit=2000");
          P.lib = d.items || []; P.libTruncated = !!d.truncated; P.libError = "";
        } catch (e) { P.lib = []; P.libError = (e && e.message) || "Liste indisponible"; P.libAt = 0; }
        S.libLoaded = true;
        const c = cur();
        if (c && S.q.items.length <= 1) contextQueue(c.rel);  // restored file: now that the library is known, queue its folder
        global.hqPlayerRenderList();
      };
      lib.__lp = true;
      global.hqPlayerLibrary = lib;
    }
  }

  function syncChips() {
    if (!el.chips) return;
    Array.from(el.chips.querySelectorAll("[data-kind]")).forEach((b) => {
      const on = !S.ui.playlist && b.dataset.kind === S.ui.kind;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (el.sortSel) el.sortSel.value = S.ui.sort;
    if (el.groupSel) { el.groupSel.value = S.ui.group; el.groupSel.disabled = !!S.ui.playlist; }
    if (el.plBanner) {
      const pl = S.ui.playlist && S.srv.playlists.find((p) => p.id === S.ui.playlist);
      el.plBanner.hidden = !pl;
      if (pl) el.plBannerText.textContent = "Playlist : " + pl.name + " (" + pl.items.length + ")";
    }
  }
  function uiSave() { lsSet("tf_hq_lp_ui", JSON.stringify({ kind: S.ui.kind, sort: S.ui.sort, group: S.ui.group })); }

  /* ------------------------------------------------------------------------------------- menu */

  function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; } }
  function openMenu(anchor, rel) {
    closeMenu();
    const kind = kindOf(rel), pls = S.srv.playlists;
    const item = (label, fn) => h("button", { type: "button", role: "menuitem", class: "lp-menu-item", onclick: () => { closeMenu(); fn(); } }, label);
    const pos = S.srv.positions[rel];
    const entries = [
      item("Lire maintenant", () => playQueue(visibleItems.filter((f) => f.kind === kind).map((f) => f.rel), Math.max(0, visibleItems.filter((f) => f.kind === kind).findIndex((f) => f.rel === rel)))),
      item("Lire ensuite", () => enqueue(rel, true)),
      item("Ajouter à la file", () => enqueue(rel, false)),
      h("div", { class: "lp-menu-sep", role: "separator" }),
      ...pls.map((p) => item("➕ " + p.name, () => addToPlaylist(p.id, [rel]))),
      item("➕ Nouvelle playlist…", () => newPlaylist([rel])),
    ];
    if (S.ui.playlist) entries.push(item("Retirer de cette playlist", () => removeFromPlaylist(S.ui.playlist, rel)));
    entries.push(h("div", { class: "lp-menu-sep", role: "separator" }));
    if (kind === "audio" || kind === "video") entries.push(item(pos && pos.done ? "Marquer comme non vu" : "Marquer comme terminé", () => {
      srvOp(pos && pos.done ? { op: "position", rel, t: 0, d: pos.d || 0 } : { op: "position", rel, done: true, d: (pos && pos.d) || 0 }).then(() => renderLibrary(true));
    }));
    if (kind === "model" && atelierAvailable()) entries.push(item("Envoyer à l'Atelier 3D", () => sendToAtelier(rel)));
    entries.push(item("Afficher dans Fichiers", () => { if (typeof global.navigate === "function") global.navigate(parentOf(rel)); }));  // navigate() switches to Fichiers itself
    const menu = h("div", { class: "lp-menu", role: "menu", "aria-label": "Actions" }, entries);
    doc().body.append(menu);
    const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(global.innerWidth - mw - 8, r.right - mw));
    const top = r.bottom + mh + 8 > global.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    menu.style.left = left + "px"; menu.style.top = top + "px";
    S.menu = menu;
    const first = menu.querySelector("button"); if (first) first.focus();
  }

  /* --------------------------------------------------------------------------------- playlists */

  async function newPlaylist(items) {
    const name = (global.prompt("Nom de la playlist ?", "") || "").trim();
    if (!name) return;
    const st = await srvOp({ op: "playlist_save", playlist: { name, items: items || [] } });
    if (st) { toast("Playlist « " + name.slice(0, 40) + " » créée."); renderPlaylists(); renderLibrary(true); } else toast("Playlist non enregistrée.", "err");
  }
  async function addToPlaylist(id, rels) {
    const pl = S.srv.playlists.find((p) => p.id === id);
    if (!pl) return;
    const items = pl.items.concat(rels.filter((r) => pl.items.indexOf(r) < 0));
    const st = await srvOp({ op: "playlist_save", playlist: { id, name: pl.name, items } });
    if (st) { toast("Ajouté à « " + pl.name.slice(0, 40) + " »."); renderPlaylists(); } else toast("Playlist non enregistrée.", "err");
  }
  async function removeFromPlaylist(id, rel) {
    const pl = S.srv.playlists.find((p) => p.id === id);
    if (!pl) return;
    await srvOp({ op: "playlist_save", playlist: { id, name: pl.name, items: pl.items.filter((r) => r !== rel) } });
    renderPlaylists(); renderLibrary(true);
  }
  async function renamePlaylist(id) {
    const pl = S.srv.playlists.find((p) => p.id === id);
    if (!pl) return;
    const name = (global.prompt("Nouveau nom ?", pl.name) || "").trim();
    if (!name || name === pl.name) return;
    await srvOp({ op: "playlist_save", playlist: { id, name, items: pl.items } });
    renderPlaylists(); renderLibrary(true);
  }
  async function deletePlaylist(id) {
    const pl = S.srv.playlists.find((p) => p.id === id);
    if (!pl || !global.confirm("Supprimer la playlist « " + pl.name + " » ? Les fichiers ne sont pas touchés.")) return;
    await srvOp({ op: "playlist_delete", id });
    if (S.ui.playlist === id) S.ui.playlist = "";
    renderPlaylists(); renderLibrary(true);
  }
  function renderPlaylists() {
    if (!el.plList) return;
    el.plList.textContent = "";
    const P = player(), known = new Set((P ? P.lib : []).map((f) => f.rel));
    if (!S.srv.playlists.length) el.plList.append(h("li", { class: "hint", text: "Aucune playlist. Enregistre la file en cours ou utilise ⋯ sur un fichier." }));
    S.srv.playlists.forEach((pl) => {
      const present = pl.items.filter((r) => known.has(r)).length;
      el.plList.append(h("li", { class: "lp-pl" },
        h("button", { type: "button", class: "lp-pl-open", "data-help": "Voir la playlist.", onclick: () => { S.ui.playlist = pl.id; renderLibrary(); } },
          h("span", { class: "fname", text: pl.name }), h("span", { class: "meta", text: present + " / " + pl.items.length + " fichiers disponibles" })),
        btn("▶", "Lire la playlist " + pl.name, () => playQueue(pl.items.filter((r) => known.has(r)), 0)),
        btn("✎", "Renommer " + pl.name, () => renamePlaylist(pl.id)),
        btn("🗑", "Supprimer " + pl.name, () => deletePlaylist(pl.id))));
    });
  }

  /* -------------------------------------------------------------------------------------- queue UI */

  function renderQueue() {
    if (!el.queueList) return;
    const q = S.q;
    el.queueCount.textContent = String(q.items.length);
    el.queueList.textContent = "";
    if (!q.items.length) { el.queueList.append(h("li", { class: "hint", text: "File vide : lance un fichier ou ajoute-en avec ⋯." })); return; }
    q.items.forEach((rel, i) => {
      const t = S.tags[rel] || {};
      el.queueList.append(h("li", { class: "lp-q" + (i === q.pos ? " is-current" : "") },
        h("button", { type: "button", class: "lp-q-pick", "data-help": "Lire ce titre.", onclick: () => { S.q.pos = i; loadInPlace(rel); } },
          h("span", { class: "lp-q-n", text: String(i + 1) }), h("span", { class: "fname", text: t.title || nameOf(rel) })),
        btn("↑", "Monter", () => moveQ(i, -1), { disabled: i === 0 ? "" : null }),
        btn("↓", "Descendre", () => moveQ(i, 1), { disabled: i === q.items.length - 1 ? "" : null }),
        btn("✕", "Retirer de la file", () => removeQ(i))));
    });
  }
  function moveQ(i, d) {
    const q = S.q, j = i + d;
    if (j < 0 || j >= q.items.length) return;
    const t = q.items[i]; q.items[i] = q.items[j]; q.items[j] = t;
    if (q.pos === i) q.pos = j; else if (q.pos === j) q.pos = i;
    q.orig = null; renderQueue();
  }
  function removeQ(i) {
    const q = S.q;
    q.items.splice(i, 1);
    if (i < q.pos) q.pos--; else if (i === q.pos) q.pos = Math.min(q.pos, q.items.length - 1);
    q.orig = null; renderQueue();
  }

  /* ------------------------------------------------------------------------------------- controls */

  function syncControls() {
    if (!el.bar) return;
    const c = cur();
    const playing = !!(c && c.el && !c.el.paused && !c.el.ended);
    if (el.play) { el.play.textContent = playing ? "⏸" : "▶"; el.play.setAttribute("aria-label", playing ? "Pause" : "Lecture"); }
    if (el.shuffle) el.shuffle.setAttribute("aria-pressed", S.shuffle ? "true" : "false");
    if (el.repeat) {
      el.repeat.textContent = S.repeat === "one" ? "🔂" : "🔁";
      el.repeat.setAttribute("aria-pressed", S.repeat === "off" ? "false" : "true");
      el.repeat.setAttribute("aria-label", "Répéter : " + (S.repeat === "off" ? "non" : S.repeat === "all" ? "la file" : "ce titre"));
    }
    if (el.rateSel) el.rateSel.value = String(SPEEDS.indexOf(S.rate) >= 0 ? S.rate : 1);
    if (el.loopBtn) {
      const { a, b } = S.loop;
      el.loopBtn.textContent = a == null ? "A↔B" : b == null ? "A " + fmtTime(a) + " → B ?" : fmtTime(a) + " ↔ " + fmtTime(b) + " ✕";
      el.loopBtn.setAttribute("aria-pressed", a != null ? "true" : "false");
    }
    if (el.favBtn) {
      const on = !!(c && favSet().has(c.rel));
      el.favBtn.textContent = on ? "♥" : "♡";
      el.favBtn.setAttribute("aria-pressed", on ? "true" : "false");
      el.favBtn.setAttribute("aria-label", on ? "Retirer des favoris" : "Ajouter aux favoris");
    }
    if (el.vizBtn) { el.vizBtn.setAttribute("aria-pressed", S.viz.on ? "true" : "false"); el.vizBtn.hidden = isIOS(); }
    if (el.lyricsBtn) el.lyricsBtn.setAttribute("aria-pressed", S.lyrics.on ? "true" : "false");
    if (el.pipBtn) el.pipBtn.hidden = !(doc().pictureInPictureEnabled || (doc().getElementById("player-video") || {}).webkitSetPresentationMode);
    if (el.airBtn) el.airBtn.hidden = !(global.WebKitPlaybackTargetAvailabilityEvent && c && c.el && c.el.webkitShowPlaybackTargetPicker);
    if (el.seekLabel && c && c.el) el.seekLabel.textContent = fmtTime(c.el.currentTime) + " / " + fmtTime(c.el.duration);
    if (el.bar) { el.bar.hidden = !c; el.bar2.hidden = !(c && c.el); }
  }

  /* -------------------------------------------------------------------------------------- build UI */

  function buildPlayerUI() {
    const stage = $(".player-stage");
    if (!stage || el.wrap) return;
    el.resumeText = h("span", { class: "lp-resume-text" });
    el.resume = h("div", { class: "lp-resume", role: "status", hidden: true }, el.resumeText,
      btn("Reprendre", "Reprendre là où tu t'étais arrêté", () => doResume(false)), btn("Depuis le début", "Recommencer au début", () => doResume(true)));
    el.cover = h("img", { class: "lp-cover", alt: "Pochette", hidden: true, decoding: "async" });
    el.nowTitle = h("p", { class: "lp-now-title" });
    el.nowSub = h("p", { class: "lp-now-sub" });
    el.viz = h("canvas", { class: "lp-viz", "aria-hidden": "true" });
    el.now = h("div", { class: "lp-now lp-only-audio", hidden: true }, el.cover, h("div", { class: "lp-now-text" }, el.nowTitle, el.nowSub, el.viz));

    el.play = btn("▶", "Lecture", togglePlay, { class: "secondary lp-btn lp-only-av" });
    el.shuffle = btn("🔀", "Mélanger la file", toggleShuffle, { "aria-pressed": "false" });
    el.repeat = btn("🔁", "Répéter", cycleRepeat, { class: "secondary lp-btn lp-only-av", "aria-pressed": "false" });
    el.favBtn = btn("♡", "Favori", () => { const c = cur(); if (c) srvOp({ op: "favorite", rel: c.rel, on: !favSet().has(c.rel) }).then(() => { syncControls(); renderLibrary(true); }); });
    el.seekLabel = h("span", { class: "lp-time lp-only-av", "aria-live": "off" });
    el.bar = h("div", { class: "lp-bar", role: "toolbar", "aria-label": "Commandes de lecture", hidden: true },
      btn("⏮", "Titre précédent (P)", prevTrack), btn("−15", "Reculer de 15 secondes", () => seekBy(-15), { class: "secondary lp-btn lp-only-av" }),
      el.play, btn("+15", "Avancer de 15 secondes", () => seekBy(15), { class: "secondary lp-btn lp-only-av" }), btn("⏭", "Titre suivant (N)", () => { advance(1); }),
      el.shuffle, el.repeat, el.favBtn, el.seekLabel);

    el.rateSel = h("select", { class: "lp-sel", "aria-label": "Vitesse de lecture", "data-help": "Vitesse de lecture (la hauteur de la voix est conservée).", onchange: (e) => setRate(e.target.value) },
      SPEEDS.map((s) => h("option", { value: String(s), text: s + "×" })));
    el.loopBtn = btn("A↔B", "Boucle entre deux points : touche pour marquer A, puis B", cycleLoop, { "aria-pressed": "false" });
    el.sleepSel = h("select", { class: "lp-sel", "aria-label": "Minuteur de sommeil", "data-help": "Arrête la lecture après un délai.", onchange: (e) => setSleep(e.target.value) },
      SLEEP_CHOICES.map((c) => h("option", { value: c[0], text: c[1] })));
    el.sleepLabel = h("span", { class: "lp-sleep-label", "aria-live": "off" });
    el.lyricsBtn = btn("Paroles", "Afficher les paroles synchronisées (recherche sur LRCLIB)", () => {
      S.lyrics.on = !S.lyrics.on; lsSet("tf_hq_lp_lyrics", S.lyrics.on ? "1" : "0");
      if (S.lyrics.on) ensureLyrics(); else renderLyrics();
      syncControls(); renderLyrics();
    }, { class: "secondary lp-btn lp-only-audio", "aria-pressed": "false" });
    el.vizBtn = btn("Visualiseur", "Visualiseur de spectre (PC)", toggleViz, { class: "secondary lp-btn lp-only-audio", "aria-pressed": "false" });
    el.pipBtn = btn("PiP", "Image dans l'image", togglePip, { class: "secondary lp-btn lp-only-video" });
    el.airBtn = btn("AirPlay", "Envoyer vers un appareil AirPlay", airplay, { class: "secondary lp-btn lp-only-av", hidden: true });
    el.fsBtn = btn("Plein écran", "Plein écran (F)", fullscreen, { class: "secondary lp-btn lp-only-video" });
    el.bar2 = h("div", { class: "lp-bar2", hidden: true }, el.rateSel, el.loopBtn, el.sleepSel, el.sleepLabel, el.lyricsBtn, el.vizBtn, el.pipBtn, el.airBtn, el.fsBtn);

    el.subSel = h("select", { class: "lp-sel", "aria-label": "Sous-titres", onchange: (e) => pickSub(Number(e.target.value)) });
    el.subDelay = h("span", { class: "lp-time", text: "0,0 s" });
    el.subBox = h("div", { class: "lp-sub lp-only-video", hidden: true }, el.subSel,
      btn("−0,5 s", "Sous-titres plus tôt", () => shiftSubs(-0.5)), el.subDelay, btn("+0,5 s", "Sous-titres plus tard", () => shiftSubs(0.5)));
    el.lyrics = h("div", { class: "lp-lyrics lp-only-audio", "aria-label": "Paroles", hidden: true });

    el.queueCount = h("span", { class: "badge", text: "0" });
    el.queueList = h("ul", { class: "hq-list lp-queue-list" });
    el.queue = h("details", { class: "lp-queue" },
      h("summary", {}, "À suivre ", el.queueCount),
      h("div", { class: "lp-queue-actions" },
        btn("Mélanger", "Mélanger la suite de la file", () => { S.q.orig = null; S.q.items = shuffleAfter(S.q.items, S.q.pos); renderQueue(); }),
        btn("Enregistrer en playlist", "Enregistrer la file comme playlist", () => newPlaylist(S.q.items)),
        btn("Vider", "Vider la file", () => { const c = cur(); setQueue(c ? [c.rel] : [], c ? 0 : -1); })),
      el.queueList);

    el.wrap = h("div", { class: "lp-wrap", "data-kind": "" }, el.resume, el.now, el.bar, el.bar2, el.subBox, el.lyrics, el.queue);
    stage.after(el.wrap);

    // 3D toolbar
    const bar = $(".player-model-bar");
    if (bar) {
      el.wire = btn("Fil de fer", "Afficher le maillage (W)", () => { const v = modelState(); if (v) { const on = v.setWireframe(!v.wireframe); if (on === false && !v.wireframe) toast("Trop de triangles pour le fil de fer.", "err"); } syncModelButtons(); }, { "aria-pressed": "false" });
      el.spin = btn("Rotation", "Faire tourner le modèle (R)", () => { const v = modelState(); if (v) v.setAutoRotate(!v.autoRotate); syncModelButtons(); }, { "aria-pressed": "false" });
      el.shot = btn("Capture PNG", "Enregistrer la vue en image", captureModel);
      bar.insertBefore(el.shot, bar.querySelector(".hint"));
      bar.insertBefore(el.spin, el.shot);
      bar.insertBefore(el.wire, el.spin);
      if (atelierAvailable()) {
        const b = btn("→ Atelier 3D", "Envoyer ce modèle à l'Atelier 3D", () => { const P = player(); if (P && P.rel) sendToAtelier(P.rel); });
        bar.insertBefore(b, bar.querySelector(".hint"));
      }
    }
    renderQueue(); syncControls();
  }

  function buildLibUI() {
    const filter = $("#player-filter");
    if (!filter || el.chips) return;
    filter.setAttribute("placeholder", "Filtrer (nom, titre, artiste, album)…");
    filter.setAttribute("aria-label", "Filtrer la musique, les vidéos et les modèles 3D par nom, titre, artiste ou album");
    const chip = (kind, text) => h("button", { type: "button", class: "lp-chip", "data-kind": kind, "aria-pressed": "false", onclick: () => { S.ui.kind = kind; S.ui.playlist = ""; uiSave(); renderLibrary(); } }, text);
    el.chips = h("div", { class: "lp-chips", role: "group", "aria-label": "Type de fichier" },
      chip("all", "Tout"), chip("audio", "Musique"), chip("video", "Vidéos"), chip("model", "3D"), chip("fav", "♥ Favoris"), chip("recent", "Récents"));
    el.sortSel = h("select", { class: "lp-sel", "aria-label": "Trier", onchange: (e) => { S.ui.sort = e.target.value; uiSave(); renderLibrary(); } },
      [["recent", "Plus récents"], ["played", "Dernière lecture"], ["name", "Nom"], ["size", "Taille"], ["duration", "Durée"], ["artist", "Artiste / album"]].map((o) => h("option", { value: o[0], text: "Tri : " + o[1] })));
    el.groupSel = h("select", { class: "lp-sel", "aria-label": "Regrouper", onchange: (e) => { S.ui.group = e.target.value; uiSave(); renderLibrary(); } },
      [["none", "Sans groupe"], ["folder", "Par dossier"], ["artist", "Par artiste"], ["album", "Par album"]].map((o) => h("option", { value: o[0], text: o[1] })));
    el.plBannerText = h("span");
    el.plBanner = h("div", { class: "lp-pl-banner", hidden: true }, el.plBannerText,
      btn("▶ Lire", "Lire cette playlist", () => { const P = player(), pl = S.srv.playlists.find((p) => p.id === S.ui.playlist); if (pl && P) playQueue(pl.items.filter((r) => P.lib.some((f) => f.rel === r)), 0); }),
      btn("Quitter la playlist", "Revenir à toute la bibliothèque", () => { S.ui.playlist = ""; renderLibrary(); }));
    filter.before(el.chips);
    filter.after(h("div", { class: "lp-tools" }, el.sortSel, el.groupSel), el.plBanner);
    el.more = h("button", { type: "button", class: "secondary lp-more", hidden: true, onclick: () => { S.ui.page++; renderLibrary(true); } });
    const list = $("#player-list");
    list.after(el.more);
    el.plList = h("ul", { class: "hq-list lp-pl-list" });
    const section = list.closest("section");
    if (section) section.after(h("section", { class: "hq", "aria-labelledby": "lp-pl-title" },
      h("div", { class: "sec-head" }, h("h2", { id: "lp-pl-title", text: "Playlists" }), h("p", { class: "sec-hint", text: "Partagées entre tes appareils" })),
      h("div", { class: "row" }, btn("+ Nouvelle playlist", "Créer une playlist vide", () => newPlaylist([]))), el.plList));
    try {
      const saved = JSON.parse(lsGet("tf_hq_lp_ui") || "{}");
      if (saved.kind) S.ui.kind = saved.kind;
      if (saved.sort) S.ui.sort = saved.sort;
      if (saved.group) S.ui.group = saved.group;
    } catch (_) {}
    list.addEventListener("click", (e) => {
      const fav = e.target.closest("[data-lp-fav]"), more = e.target.closest("[data-lp-menu]");
      if (fav) { const rel = fav.dataset.lpFav; srvOp({ op: "favorite", rel, on: !favSet().has(rel) }).then(() => { renderLibrary(true); syncControls(); }); return; }
      if (more) { openMenu(more, more.dataset.lpMenu); return; }
    });
    // Capture phase, before the inline handler opens the file: remember the list the click came from.
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-play]");
      if (!b) return;
      const kind = kindOf(b.dataset.play);
      S.ctxList = visibleItems.filter((f) => f.kind === kind).map((f) => f.rel);
    }, true);
  }
  function ensureLibUI() { buildLibUI(); }

  /* ------------------------------------------------------------------------------------ keyboard */

  function onKey(e) {
    if (doc().body.dataset.view !== "lecteur" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape" && S.menu) { closeMenu(); return; }
    const t = e.target;
    if (t && t.closest && t.closest("input, select, textarea, [contenteditable], audio, video, button, summary, a")) return;
    const c = cur(), key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const stop = () => e.preventDefault();
    if (c && c.kind === "model") {
      const v = modelState();
      if (key === "w" && v) { stop(); v.setWireframe(!v.wireframe); syncModelButtons(); }
      else if (key === "r" && v) { stop(); v.setAutoRotate(!v.autoRotate); syncModelButtons(); }
      else if (key === "f" && v) { stop(); v.fit(); }
      else if (key === "n") { stop(); advance(1); } else if (key === "p") { stop(); advance(-1); }
      return;
    }
    if (!c || !c.el) return;
    const m = c.el;
    if (key === " " || key === "k") { stop(); togglePlay(); }
    else if (key === "ArrowLeft") { stop(); seekBy(e.shiftKey ? -15 : -5); }
    else if (key === "ArrowRight") { stop(); seekBy(e.shiftKey ? 15 : 5); }
    else if (key === "ArrowUp") { stop(); m.volume = Math.min(1, m.volume + 0.05); }
    else if (key === "ArrowDown") { stop(); m.volume = Math.max(0, m.volume - 0.05); }
    else if (key === "m") { stop(); m.muted = !m.muted; }
    else if (key === "f" && c.kind === "video") { stop(); fullscreen(); }
    else if (key === "n") { stop(); advance(1); }
    else if (key === "p") { stop(); prevTrack(); }
    else if (key === "<" || key === ",") { stop(); setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(S.rate) - 1)] || 1); }
    else if (key === ">" || key === ".") { stop(); setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.rate) + 1)] || 1); }
    else if (key === "s") { stop(); toggleShuffle(); }
  }

  /* ----------------------------------------------------------------------------------------- start */

  function hook(name, wrapper) {
    const orig = global[name];
    if (typeof orig !== "function" || orig.__lp) return;
    const w = function () { return wrapper(orig, this, arguments); };
    w.__lp = true;
    global[name] = w;
  }

  function init() {
    if (S.built) return;
    S.built = true;
    S.lyrics.on = lsGet("tf_hq_lp_lyrics") === "1";
    S.viz.on = false;  // the audio context needs a user gesture: only the toggle starts it
    buildPlayerUI();
    buildLibUI();
    installRenderHooks();
    wrapModelInfo();
    bindMedia(doc().getElementById("player-audio"));
    bindMedia(doc().getElementById("player-video"));
    bindSession();
    hook("hqPlayerLoad", (orig, self, args) => { const r = orig.apply(self, args); try { onLoaded(args[0]); } catch (e) { global.console.error(e); } return r; });
    hook("hqPlayerClear", (orig, self, args) => { const r = orig.apply(self, args); renderNow(); syncControls(); renderLyrics(); return r; });
    hook("hqPlayerView", (orig, self, args) => {
      const r = orig.apply(self, args);
      if (args[0] === "lecteur") { loadSrv(); syncControls(); renderNow(); } else { recordPos(true); closeMenu(); }
      return r;
    });
    doc().addEventListener("keydown", onKey);
    doc().addEventListener("click", (e) => { if (S.menu && !e.target.closest(".lp-menu") && !e.target.closest("[data-lp-menu]")) closeMenu(); });
    doc().addEventListener("visibilitychange", () => { if (doc().visibilityState === "hidden") recordPos(true); });
    global.addEventListener("pagehide", () => recordPos(true));
    if (player() && player().libAt) renderLibrary();
    renderPlaylists();
    if ((doc().body.dataset || {}).view === "lecteur") loadSrv();
  }

  function start(win) {
    const go = () => { try { init(); } catch (e) { win.console.error("Lecteur+", e); } };
    if (win.document.readyState === "loading") win.document.addEventListener("DOMContentLoaded", () => win.setTimeout(go, 0), { once: true });
    else win.setTimeout(go, 0);
  }

  return { start, init, fmtTime, parseLrc, activeLine, guessTitle, shuffleAfter, sortItems, groupLabel, dimsText, parentOf, natural, SPEEDS, PAGE };
});
