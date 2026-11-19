/* Transfert HQ — Atelier 3D (assets/hq-print3d.js)
 * Printers + built-in cameras, model library, MakerWorld stats, settings. Elsea runs the chat (hq-elsea-chip.js).
 * Lazy-loaded by setView('atelier3d'); exports window.HqPrint3d = { show, hide }.
 *
 * Polling: only while the printers tab is on screen, one /api/print3d/state at a time, self-scheduling
 * (never setInterval), 4 s while a job runs, 10 s idle. Another tab clears the timer; coming back
 * fetches at once. A reply updates the cards in place: the node holding a live
 * camera <img> is never rebuilt, so the MJPEG session is not restarted by a poll. */
(function () {
  "use strict";

  var POLL_PRINTING_MS = 4000;    // a job is running: the card has numbers to follow
  var POLL_IDLE_MS = 10000;       // nothing printing: the state barely moves
  var POLL_BACKOFF_MS = [5000, 15000, 30000];
  var STL_PREVIEW_MAX = 60 * 1024 * 1024;
  var STL_MAX_TRIANGLES = 300000; // hq-model-view refuses more: never download them
  var STL_PROBE_BYTES = 84;       // a binary STL carries its triangle count in the first 84 bytes
  var BED_PRESETS = [             // used only when the printer has no explicit plate size
    { re: /\ba1\s*mini\b/i, x: 180, y: 180, z: 180 },
    { re: /\ba1\b/i, x: 256, y: 256, z: 256 },
    { re: /\b(p1p|p1s|x1c?|x1e)\b/i, x: 256, y: 256, z: 256 },
    { re: /\bcreator\s*5\b/i, x: 256, y: 256, z: 256 },
    { re: /\b(ad5m|ad5x)\b/i, x: 220, y: 220, z: 220 },
  ];
  var FAMILY_MODELS = {
    bambu: ["A1", "A1 mini", "P1S", "X1C"],
    flashforge: ["Creator 5", "AD5X", "AD5M"],
  };
  var MODEL_CAPS = {
    "A1": { bed: { x: 256, y: 256, z: 256 }, origin: { x: 0, y: 0 }, nozzles: ["0.2", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 4, station_kind: "ams_lite", supports_prime_tower: true },
    "A1 mini": { bed: { x: 180, y: 180, z: 180 }, origin: { x: 0, y: 0 }, nozzles: ["0.2", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 4, station_kind: "ams_lite", supports_prime_tower: true },
    "P1S": { bed: { x: 256, y: 256, z: 256 }, origin: { x: 0, y: 0 }, nozzles: ["0.2", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 16, station_kind: "ams", supports_prime_tower: true },
    "X1C": { bed: { x: 256, y: 256, z: 256 }, origin: { x: 0, y: 0 }, nozzles: ["0.2", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 16, station_kind: "ams", supports_prime_tower: true },
    "Creator 5": { bed: { x: 256, y: 256, z: 256 }, origin: { x: 0, y: 0 }, nozzles: ["0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 4, max_tools: 4, station_kind: "physical_toolheads", supports_prime_tower: true },
    "AD5X": { bed: { x: 220, y: 220, z: 220 }, origin: { x: 0, y: 0 }, nozzles: ["0.25", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 4, station_kind: "ifs", supports_prime_tower: true },
    "AD5M": { bed: { x: 220, y: 220, z: 220 }, origin: { x: -110, y: -110 }, nozzles: ["0.25", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 1, station_kind: "external_spool", supports_prime_tower: false },
  };
  function printerCaps(p) {
    if (p && p.capabilities && p.capabilities.nozzles) return p.capabilities;
    var cat = data.config && data.config.printer_catalog;
    var model = p && p.model ? String(p.model) : "";
    if (cat && model && cat[model]) return cat[model];
    if (model && MODEL_CAPS[model]) return MODEL_CAPS[model];
    return null;
  }
  var FILAMENT_DENSITY = { PLA: 1.24 };  // g/cm³; the estimate is a solid PLA upper bound
  var CAM_FPS = 5;                // the card's budget: 5 fps is smooth on a thumbnail at a fifth of the bytes
  var FADE_KEY = "p3d.crossfade"; // opt-in: the cameras send < 1 fps, so a blend is a choice, never the default
  var FADE_MS = 380;              // how long two frames overlap: ~27 % of the A1's 1.4 s gap
  var activeFades = [];           // running crossfade streams, stopped when their view goes away
  var LOOK_KEY = "p3d.look";      // one number drives brightness/contrast/saturation, for both themes
  var lookLevel = null;           // 0–100, read lazily from localStorage (50 = the discreet default)
  var lookInputs = [];            // the room and fullscreen sliders share one grade
  var MODELS_TTL_MS = 60000;      // the library list is reused for a minute across tabs
  var WATCH_GRACE_SEC = 90;       // a healthy background tick may be a little late: only call it stale past this
  var STALE_AFTER_MS = 15000;     // waking/showing older data marks it before the new /state lands
  var PANES = [["printers", "Imprimantes"], ["studio", "Studio"], ["models", "Modèles"], ["filament", "Filament"],
    ["makerworld", "MakerWorld"], ["settings", "Réglages"]];
  var ORIGIN_LABEL = { owned: "Possédé", designed: "Modélisé par moi", downloaded: "Téléchargé" };
  var STATE_LABEL = { idle: "Au repos", preparing: "Préparation", printing: "Impression", paused: "En pause",
    finished: "Terminé", failed: "Échec", offline: "Hors ligne", unknown: "Inconnu" };
  var KIND_LABEL = { bambu: "Bambu Lab (LAN)", flashforge: "Flashforge" };

  var ui = null;           // built once
  var tabFadeObserver = null;  // kept: an unretained ResizeObserver can be collected
  var api = null;
  var timer = 0;           // poll timeout id
  var statePromise = null; // the one in-flight /state request; every trigger joins it
  var stateToken = 0;      // the newest /state reply wins
  var pollFailures = 0;
  var sse = null;
  var visible = false;
  var data = { printers: [], config: { printers: [], makerworld: {} }, makerworld: {}, history: [] };
  var loaded = { printers: false, models: false, filament: false, makerworld: false };
  var models = { list: [], tags: [], q: "", origin: "", tag: "", sort: "recent", key: "", at: 0, total: 0, indexed: 0 };
  var modelsToken = 0;
  var modelsShell = null;  // the toolbar and grid: built once, then updated
  var modelTiles = {};     // model id -> { el, sig }: a grid pass reuses unchanged tiles
  var stateEtag = "";      // the last /state validator
  var etagOk = true;       // a helper that cannot see a 304 must stop asking for one
  var stateAt = 0;         // when /state last confirmed what is on screen (ms)
  var stale = false;       // old progress must not look live after sleep/reconnect
  var staleWhy = "";
  var uploadCtl = null;    // the running upload, so Annuler can stop it
  var uploadBusy = false;
  var pollStats = { at: 0, n: 0, ms: 0 };
  var authDead = false;    // 401: only a reload can mint a new session, so stop asking
  var tab = "printers";
  var liveCams = {};       // printer id -> true while the MJPEG <img> is open
  var printerViews = {};   // printer id -> { el, update }: a poll updates, it never rebuilds
  var printerShellRef = null;
  var historySig = "";
  var historyTop = null;   // the newest job already drawn (null before the first paint)
  var shownTab = "";       // the pane currently faded in: setTab animates only a real switch
  var viewer = null;       // 3D preview viewer in modal overlay, disposed when its overlay closes
  var previewToken = 0;
  var studioViewer = null; // 3D G-code viewer in Studio Aperçu, disposed on tab/mode switch or hide
  var studioPrepareViewport = null; // Phase 3 WebGL Prepare viewport (disposed on mode/tab/overlay/hide)
  var studioMeshStore = null;       // Ref-counted STL parse/buffer cache for Préparer 3D
  var studioPreviewToken = 0;
  var overlayReturn = null;
  var uploadEls = null;
  var shell = null;        // current filament pane parts
  var mwAt = 0;            // when the MakerWorld tab last fetched its snapshot
  var activity = { items: [], seq: 0, known: {}, seeded: false, sig: "", ages: [], nodes: {} };
  var activityMax = 24;
  var printerRoom = null;  // { id, refs }: the focused, read-only printer sheet
  var camChoice = null;    // the operator's camera choice in the focus room (null: open it for a printing printer)
  var miniSync = null;     // recomputes whether the slim floor line has taken over (bound once, on scroll)
  var shots = {};          // printer id → { img, at, broken }: the card's still frame, refreshed by the poll
  var progressWatch = {};  // printer id → { sig, since, stalled }: a job that reports printing but stops moving
  var jobIndex = null;     // job name → { n, fails } over the last 50 recorded rows
  var lastRoomId = "";     // the machine the operator looked at last, preferred by the strip shortcuts
  var STALL_SEC = 360;     // six silent minutes on a running job is the failure a green pill hides
  var SHOT_IDLE_SEC = 60;  // an idle printer's still is refreshed a minute apart, not every poll

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  function toast(msg, kind) { if (typeof window.toast === "function") window.toast(msg, kind || "ok"); }
  function post(url, body) {
    return api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v.toFixed(d || 0).replace(".", ",") : "–"; }
  function fmtInt(v) { return typeof v === "number" ? v.toLocaleString("fr-CA") : "–"; }
  function fmtBytes(n) {
    if (!(n >= 0)) return "";
    var u = ["o", "Ko", "Mo", "Go"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + " " + u[i];
  }
  // A non-breaking space keeps "30 min", "1 h 30" and "2 h" on one line in a narrow card.
  function fmtDur(sec) {
    if (!(sec > 0)) return "";
    var m = Math.round(sec / 60), hh = Math.floor(m / 60);
    return hh ? hh + "\u00A0h\u00A0" + String(m % 60).padStart(2, "0") : m + "\u00A0min";
  }
  // The bare span ("2 h", never "il y a 2 h"): a caller that names the situation can say "depuis".
  function fmtSpan(ts) {
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return "à l'instant";
    if (s < 3600) return Math.round(s / 60) + "\u00A0min";
    if (s < 86400) return Math.round(s / 3600) + "\u00A0h";
    return Math.round(s / 86400) + "\u00A0j";
  }
  function fmtSince(ts) {
    var s = Math.max(0, Date.now() / 1000 - ts);
    return s < 90 ? "moins d'une minute" : fmtSpan(ts);
  }
  function fmtAgo(ts) {
    if (!ts) return "jamais";
    var span = fmtSpan(ts);
    return span === "à l'instant" ? span : "il y a " + span;
  }
  function fmtCountdown(sec) {
    if (!(sec > 0)) return "maintenant";
    return sec < 60 ? Math.ceil(sec) + "\u00A0s" : fmtDur(sec);
  }
  function fmtAt(ts) {       // wall-clock stamp for a past/future epoch
    var d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function fmtClock(sec) {   // wall-clock end of the running job, e.g. "vers 14:32"
    if (!(sec > 0)) return "";
    var d = new Date(Date.now() + sec * 1000);
    return "vers " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // ── shell ──
  function build(host) {
    host.innerHTML = "";
    var root = h("div", { class: "p3d" });
    var head = h("header", { class: "p3d-head" }, [
      h("img", { class: "p3d-elsea", src: "/assets/companion/elsea-chip-sfw.webp", alt: "Elsea" }),
      h("div", { class: "p3d-head-text" }, [
        h("h2", { text: "Atelier 3D" }),
        h("p", { class: "p3d-sub", id: "p3d-sub", role: "status", "aria-live": "polite",
          text: "Elsea veille sur tes imprimantes." }),
        h("p", { class: "p3d-say", hidden: true }),   /* Elsea's own line: the state, in her voice */
        h("p", { class: "p3d-age", hidden: true, role: "status", "aria-live": "polite" }),
      ]),
      h("button", { type: "button", class: "p3d-btn is-primary", text: "Parler à Elsea",
        onclick: function () { if (window.hqElseaOpen) window.hqElseaOpen(); } }),
    ]);
    var tabs = h("nav", { class: "p3d-tabs", role: "tablist", "aria-label": "Sections de l'atelier" });
    var panes = {};
    PANES.forEach(function (t) {
      panes[t[0]] = h("section", { class: "p3d-pane", id: "p3d-pane-" + t[0], role: "tabpanel",
        "data-pane": t[0], "aria-labelledby": "p3d-tab-" + t[0], tabindex: "-1", hidden: true });
      tabs.append(h("button", { type: "button", role: "tab", id: "p3d-tab-" + t[0], "data-tab": t[0],
        "aria-controls": "p3d-pane-" + t[0], "aria-selected": "false", tabindex: "-1",
        onclick: function () { setTab(t[0]); } }, [h("span", { text: t[1] })]));
    });
    var tabline = h("span", { class: "p3d-tabline", "aria-hidden": "true" });
    tabs.append(tabline);
    tabs.addEventListener("keydown", tabKey);
    tabs.addEventListener("scroll", syncTabFade, { passive: true });
    if (typeof ResizeObserver === "function") {
      if (tabFadeObserver) tabFadeObserver.disconnect();
      tabFadeObserver = new ResizeObserver(syncTabFade);
      tabFadeObserver.observe(tabs);
    }
    root.append(head, tabs);
    PANES.forEach(function (t) { root.append(panes[t[0]]); });
    host.append(root);
    var overlay = h("div", { class: "p3d-overlay", hidden: true, role: "dialog", "aria-modal": "true",
      "aria-label": "Atelier 3D", onclick: function (e) { if (e.target === overlay) closeOverlay(); } });
    document.body.append(overlay);
    ui = { host: host, root: root, tabs: tabs, tabline: tabline, panes: panes, overlay: overlay,
      sub: head.querySelector("#p3d-sub"), age: head.querySelector(".p3d-age"),
      say: head.querySelector(".p3d-say") };
    applyCamLook();
    if (stale) updateAgeBadge();
    printerViews = {};
    printerShellRef = null;
    modelsShell = null;
    modelTiles = {};
    shell = null;
    historySig = "";
    historyTop = null;
    activity = { items: [], seq: 0, known: {}, seeded: false, sig: "", ages: [], nodes: {} };
    printerRoom = null;
    shownTab = "";
    syncTabFade();
  }

  function updateAgeBadge() {
    if (!ui || !ui.age) return;
    if (!stale) { ui.age.hidden = true; ui.age.textContent = ""; return; }
    var ago = stateAt ? fmtAgo(Math.floor(stateAt / 1000)) : "jamais";
    ui.age.textContent = "Dernières données " + ago + (staleWhy ? " · " + staleWhy : "");
    ui.age.title = stateAt ? "Reçues à " + fmtAt(stateAt / 1000) : "";
    ui.age.hidden = false;
    ui.age.classList.toggle("is-old", !!stateAt && Date.now() - stateAt > 60000);
  }
  function setStale(on, why) {
    stale = !!on;
    staleWhy = stale ? (why || staleWhy || "") : "";
    if (ui && ui.root) ui.root.classList.toggle("is-stale", stale);
    updateAgeBadge();
  }

  // A moving underline: one element carries the active tab, so a switch glides instead of cutting.
  function moveTabline() {
    if (!ui || !ui.tabline) return;
    var b = ui.tabs.querySelector('[data-tab="' + tab + '"]');
    if (!b) return;
    ui.tabline.style.width = (b.offsetWidth || 0) + "px";
    ui.tabline.style.transform = "translateX(" + (b.offsetLeft || 0) + "px)";
    syncTabFade();
  }
  // The fade marks tabs hidden to the right; it is a mask, so it never catches a tap.
  function syncTabFade() {
    if (!ui || !ui.tabs) return;
    var nav = ui.tabs;
    var over = (nav.scrollWidth || 0) - (nav.clientWidth || 0) > 1;
    var more = over && (nav.scrollLeft || 0) + (nav.clientWidth || 0) < (nav.scrollWidth || 0) - 1;
    nav.classList.toggle("is-overflowing", more);
  }

  // A slow action owns its button: a second click is a no-op while the first still runs.
  function busyRun(btn, label, fn) {
    if (!btn || btn.getAttribute("data-busy") === "1") return Promise.resolve();
    var old = btn.textContent;
    btn.setAttribute("data-busy", "1");
    btn.disabled = true;
    btn.classList.add("is-busy");
    btn.textContent = label;
    function done() {
      btn.classList.remove("is-busy");
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      btn.textContent = old;
    }
    var work;
    try { work = fn(); } catch (e) { done(); return Promise.reject(e); }
    return Promise.resolve(work).then(function (v) { done(); return v; },
      function (e) { done(); throw e; });
  }
  function busyForm(e, label, fn) {
    e.preventDefault();
    var form = e.currentTarget || e.target;
    return busyRun(form && form.querySelector ? form.querySelector('button[type="submit"]') : null, label, fn);
  }

  function setTab(name, skipPoll) {
    if (!ui || !ui.panes[name]) return;
    tab = name;
    ui.tabs.querySelectorAll("[data-tab]").forEach(function (b) {
      var on = b.dataset.tab === name;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    moveTabline();
    Object.keys(ui.panes).forEach(function (k) {
      ui.panes[k].hidden = k !== name;
      if (k !== name) ui.panes[k].classList.remove("is-enter");
    });
    if (name !== shownTab) {                     // a real switch fades the pane in, a re-entry does not
      var pane = ui.panes[name];
      pane.classList.remove("is-enter");
      void pane.offsetWidth;
      pane.classList.add("is-enter");
      shownTab = name;
    }
    if (name !== "printers") { closeAllCams(); if (ui.overlay && !ui.overlay.hidden) closeOverlay(); }
    if (name !== "studio") disposeStudioViewer();
    if (name === "models") loadModels();
    else if (name === "studio") renderStudio();
    else if (name === "makerworld") loadMakerworld();
    else if (name === "filament") loadFilament();
    else if (name === "settings") renderSettings();
    else renderPrinters();
    // The poll only exists for the printers card: another tab clears it, coming back fetches at once.
    if (!visible || skipPoll) return;
    // A reply that lands after a tab switch schedules nothing: off the printers tab the delay is 0.
    if (name === "printers") refresh().then(afterPoll);
    else schedulePoll(0);
  }

  function tabKey(e) {
    if (!ui) return;
    var step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    var jump = e.key === "Home" ? "first" : e.key === "End" ? "last" : "";
    if (!step && !jump) return;
    var buttons = [].slice.call(ui.tabs.querySelectorAll("[data-tab]"));
    var i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var next = jump === "first" ? 0 : jump === "last" ? buttons.length - 1
      : (i + step + buttons.length) % buttons.length;
    buttons[next].focus();
    setTab(buttons[next].dataset.tab);
  }

  function skeletonRows(n) {
    var wrap = h("div", { class: "p3d-skeleton", "aria-hidden": "true" });
    for (var i = 0; i < (n || 2); i++) {
      wrap.append(h("div", { class: "p3d-skel-card" }, [
        h("span", { class: "p3d-skel-bar" }), h("span", { class: "p3d-skel-bar is-short" }),
        h("span", { class: "p3d-skel-bar" })]));
    }
    return wrap;
  }

  function openOverlay(content, boxClass) {
    disposeViewer();              // opening a different sheet must not leave the previous GL context alive
    disposeStudioViewer();        // keep at most 1 active WebGL context (iPhone Safari context limit)
    ui.overlay.innerHTML = "";
    var box = h("div", { class: "p3d-modal" + (boxClass ? " " + boxClass : "") }, [
      h("button", { type: "button", class: "p3d-close", "aria-label": "Fermer", text: "✕", onclick: closeOverlay }),
      content,
    ]);
    ui.overlay.append(box);
    if (!overlayReturn) overlayReturn = document.activeElement;
    ui.overlay.hidden = false;
    var first = box.querySelector("input, textarea, select, a.p3d-btn, button.p3d-btn");
    try { (first || box.querySelector(".p3d-close")).focus({ preventScroll: true }); } catch (_) {}
  }
  function closeOverlay() {
    if (!ui) return;
    stopFadesIn(ui.overlay);
    previewToken += 1;              // a preview or detail still in flight must not reopen the sheet
    printerRoom = null;
    disposeViewer();
    ui.overlay.querySelectorAll("img[data-live]").forEach(function (img) { img.removeAttribute("src"); });
    ui.overlay.hidden = true;
    ui.overlay.innerHTML = "";
    ui.overlay.setAttribute("aria-label", "Atelier 3D");
    if (overlayReturn && document.contains(overlayReturn)) {
      try { overlayReturn.focus({ preventScroll: true }); } catch (_) {}
    }
    overlayReturn = null;
  }
  function disposeViewer() {
    var v = viewer;
    viewer = null;
    if (!v) return;
    try { if (typeof v.dispose === "function") v.dispose(); } catch (_) {}
  }
  function disposeStudioPrepareViewport() {
    studioRefreshLive = null;
    var vp = studioPrepareViewport;
    studioPrepareViewport = null;
    if (!vp) return;
    try {
      if (typeof vp.getCamera === "function") studio.camera = vp.getCamera();
      if (typeof vp.dispose === "function") vp.dispose();
    } catch (_) {}
  }
  function disposeStudioViewer() {
    studioPreviewToken += 1;
    disposeStudioPrepareViewport();
    var v = studioViewer;
    studioViewer = null;
    if (!v) return;
    try { if (typeof v.dispose === "function") v.dispose(); } catch (_) {}
  }
  function trapFocus(e) {
    var box = ui.overlay.querySelector(".p3d-modal");
    if (!box) return;
    var items = [].slice.call(box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), '
      + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ── state polling ──
  // Requests per minute and average duration, in the existing client-debug HUD: the audit's
  // "how much does the poll cost" question answered by the app itself, not by devtools.
  function notePoll(ms) {
    if (!pollStats.n) pollStats.at = Date.now();
    pollStats.n += 1;
    pollStats.ms += Math.max(0, ms || 0);
  }
  function flushPollStats() {
    if (!pollStats.n) return;
    var span = Math.max(1, Date.now() - pollStats.at);
    if (typeof window.hqPerfMark === "function") {
      window.hqPerfMark("print3d", { op: "poll-min", ms: Math.round(pollStats.ms / pollStats.n), polls: pollStats.n,
        per_min: Math.round(pollStats.n * 60000 / span), tab: tab }, { force: true });
    }
    pollStats = { at: Date.now(), n: 0, ms: 0 };
  }
  function refresh() {
    if (authDead) return Promise.resolve(false);   // no session: a reload is the only cure
    if (statePromise) return statePromise;         // a slow backend never gets two /state requests
    if (stateAt && !stale && Date.now() - stateAt > STALE_AFTER_MS) setStale(true, "actualisation…");
    var token = ++stateToken;       // a late reply from an older request is dropped
    var t0 = Date.now();
    var opts = { timeoutMs: 12000 };
    if (stateEtag && etagOk) opts.headers = { "If-None-Match": stateEtag };
    var request = api("/api/print3d/state", opts).then(function (res) {
      notePoll(Date.now() - t0);
      if (token !== stateToken) return true;      // a newer request already answered
      if (!res || !Array.isArray(res.printers)) {
        stateAt = Date.now(); setStale(false);                 // 304 behind a helper that parses an empty body
        return true;
      }
      if (res.etag) stateEtag = res.etag;
      authDead = false;
      stateAt = Date.now(); setStale(false);
      var previous = data;
      data = res;
      loaded.printers = true;
      noteActivity(previous, res);
      var printers = res.printers || [];
      var printing = printers.filter(function (p) { return p.status && p.status.state === "printing"; });
      ui.sub.textContent = !printers.length
        ? ((res.config && (res.config.printers || []).length)
          ? "Aucune imprimante joignable — vérifie Réglages." : "Aucune imprimante — ajoute-les dans Réglages.")
        : printing.length ? printing.length + " impression(s) en cours"
          : (printers.length + " imprimante(s) · au repos");
      if (tab === "printers") renderPrinters();
      return true;
    }).catch(function (e) {
      notePoll(Date.now() - t0);
      if (token !== stateToken) return true;      // superseded: not a failure of this poll
      if (e && e.status === 304) { stateAt = Date.now(); setStale(false); return true; }   // unchanged is still current
      if (stateEtag && !(e && e.status) && /304/.test(String(e && e.message))) {
        etagOk = false; stateEtag = "";          // this api() lost the 304: stop asking, retry plainly
        if (statePromise === request) statePromise = null;
        return refresh();
      }
      if (e && e.status === 401) {
        authDead = true;
        ui.sub.textContent = "Session expirée — recharge la page pour te reconnecter.";
        if (stateAt) setStale(true, "session expirée");
        stopPolling();
        return false;
      }
      ui.sub.textContent = "Atelier injoignable : " + e.message;
      if (stateAt) setStale(true, "actualisation impossible");
      return false;
    });
    statePromise = request;
    request.then(function () {
      if (statePromise === request) statePromise = null;
    }, function () {
      if (statePromise === request) statePromise = null;
    });
    return request;
  }

  function printingNow() {
    return (data.printers || []).some(function (p) { return p.status && p.status.state === "printing"; });
  }
  function pollDelay() {
    if (tab !== "printers") return 0;      // nothing on screen to keep fresh
    if (pollFailures >= 2) return POLL_BACKOFF_MS[Math.min(pollFailures - 2, POLL_BACKOFF_MS.length - 1)];
    if (sse && sse.readyState === 1) return 30000;
    return printingNow() ? POLL_PRINTING_MS : POLL_IDLE_MS;
  }
  function startSse() {
    if (sse || typeof window.EventSource !== "function" || authDead || tab !== "printers" || !visible) return;
    try {
      sse = new window.EventSource("/api/print3d/events");
      sse.addEventListener("state", function (ev) {
        try {
          var next = JSON.parse(ev.data);
          if (!next || !Array.isArray(next.printers)) return;
          ++stateToken;
          data = next;
          stateAt = Date.now();
          setStale(false);
          loaded.printers = true;
          if (tab === "printers") renderPrinters();
          if (printerRoom) {
            var cur = (data.printers || []).find(function (x) { return x.id === printerRoom.id; });
            if (cur) updatePrinterRoom(cur);
          }
        } catch (_) { }
      });
    } catch (_) { sse = null; }
  }
  function stopSse() {
    if (sse) { try { sse.close(); } catch (_) { } sse = null; }
  }
  function schedulePoll(wait) {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!visible || document.hidden || authDead) { stopSse(); return; }
    if (!wait) { stopSse(); return; }                      // off the printers tab: no timer at all
    startSse();
    timer = setTimeout(pollOnce, wait);
  }
  function afterPoll(ok) {
    if (!visible) return;
    pollFailures = ok ? 0 : pollFailures + 1;
    if (stale) updateAgeBadge();          // the age keeps moving while a fetch is failing/backing off
    if (pollStats.n && Date.now() - pollStats.at >= 60000) flushPollStats();
    schedulePoll(pollDelay());
  }
  function pollOnce() {
    timer = 0;
    if (!visible || document.hidden || tab !== "printers") return;
    if (statePromise) {                          // a tab/visibility refresh already owns this one
      statePromise.then(function (ok) {
        if (!visible || tab !== "printers" || timer) return;
        afterPoll(ok);
      });
      return;
    }
    refresh().then(afterPoll);
  }
  function stopPolling() { stopSse(); if (timer) clearTimeout(timer); timer = 0; }

  // What the slots can prove, and nothing else: which materials are loaded, which slots are empty,
  // and — only when the sliced file names them — whether the running job's materials are missing.
  // No remaining-filament figure is ever derived: on AMS Lite the printer does not measure it.
  function amsCheck(s) {
    var slots = Array.isArray(s.ams) ? s.ams : [];
    if (!slots.length && !s.external_spool) return null;
    var loaded = slots.filter(function (x) { return x.loaded !== false && !!x.material; });
    var req = s.required && s.required.job === s.job ? (s.required.materials || []) : [];
    var active = s.state === "printing" || s.state === "paused" || s.state === "preparing";
    var missing = active ? req.filter(function (m) {
      return !loaded.some(function (x) { return String(x.material).toUpperCase() === String(m).toUpperCase(); });
    }) : [];
    if (missing.length) {
      var have = loaded.map(function (x) { return x.material; });
      return { warn: true, text: missing.join(", ") + (missing.length > 1 ? " demandés" : " demandé")
        + " par la pièce, " + (missing.length > 1 ? "non chargés" : "non chargé")
        + (have.length ? " — chargé : " + have.join(", ") : "") };
    }
    if (!loaded.length && slots.length) return { warn: true, text: "Aucune bobine chargée dans l'AMS." };
    return null;
  }

  // ── camera look ──
  // A chamber is dark and the cameras are fixed: one numeric grade, applied to the live frame, the
  // still and the crossfade canvases. It is a filter string, never a theme token, so light and dark
  // get exactly the same picture.
  function camLook() {
    if (lookLevel == null) {
      var saved = null;
      try { saved = window.localStorage.getItem(LOOK_KEY); } catch (e) { }
      lookLevel = saved == null || saved === "" ? 50 : Number(saved);
      if (!(lookLevel >= 0 && lookLevel <= 100)) lookLevel = 50;
    }
    return lookLevel;
  }
  function lookFilter(level) {
    var t = (level == null ? camLook() : level) / 100;
    return "brightness(" + (1 + 0.22 * t).toFixed(3) + ") contrast(" + (1 + 0.14 * t).toFixed(3)
      + ") saturate(" + (1 + 0.10 * t).toFixed(3) + ")";
  }
  function applyCamLook() {
    try { document.documentElement.style.setProperty("--p3d-look", lookFilter()); } catch (e) { }
  }
  function setCamLook(v) {
    lookLevel = Math.max(0, Math.min(100, Math.round(v)));
    try { window.localStorage.setItem(LOOK_KEY, String(lookLevel)); } catch (e) { }
    lookInputs = lookInputs.filter(function (el) { return el.isConnected !== false; });
    lookInputs.forEach(function (el) { if (Number(el.value) !== lookLevel) el.value = String(lookLevel); });
    applyCamLook();
  }
  function lookControl() {
    var input = h("input", { type: "range", min: "0", max: "100", step: "5",
      value: String(camLook()), class: "p3d-look-range",
      "aria-label": "Correction d'image : luminosité, contraste et saturation" });
    lookInputs.push(input);
    input.addEventListener("input", function () { setCamLook(Number(input.value)); });
    return h("label", { class: "p3d-look", title: "Éclaircit l'intérieur : luminosité, contraste et saturation" }, [
      h("span", { text: "Image" }), input]);
  }

  // ── printers ──
  function camTile(p, onRetry) {
    if (liveCams[p.id] && camFade()) {
      var fw = fadeCam(p, onRetry);
      fw.append(h("div", { class: "p3d-cam-actions" }, [
        fadeToggle(function () { if (onRetry) onRetry(); }),
        h("button", { type: "button", class: "p3d-btn is-small", text: "Fermer la caméra",
          onclick: function () { delete liveCams[p.id]; if (onRetry) onRetry(); } }),
      ]));
      return fw;
    }
    var wrap = h("div", { class: "p3d-cam" });
    if (liveCams[p.id]) {
      // The shimmer runs until the stream's first frame, the pulse marks a live picture: both follow
      // the stream's state, never a per-frame callback.
      var view = h("div", { class: "p3d-cam-view" });
      var liveDot = h("span", { class: "p3d-cam-live", "aria-hidden": "true" });
      // fps: the card is a thumbnail, so it takes CAM_FPS frames a second; the full screen asks for none and gets all.
      var img = h("img", { "data-live": "1", alt: "Caméra " + p.name, src: "/api/print3d/camera/" + encodeURIComponent(p.id) + "?fps=" + CAM_FPS,
        onclick: function () { fullscreenCam(p); },
        onload: function () { wrap.classList.remove("is-connecting"); wrap.classList.add("is-live"); },
        onerror: function () {
          wrap.classList.remove("is-connecting");
          wrap.classList.remove("is-live");
          wrap.classList.add("is-error");
          if (!wrap.querySelector(".p3d-warn")) wrap.append(
            h("p", { class: "p3d-warn", text: "Caméra occupée ou injoignable : elle n'accepte qu'un seul client à la fois (Flash Studio, Bambu Studio ou l'app mobile l'ont peut-être ouverte)." }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Réessayer",
              onclick: function () { if (onRetry) onRetry(); } }));
        } });
      wrap.classList.add("is-connecting");
      view.append(img, liveDot);
      wrap.append(view, h("button", { type: "button", class: "p3d-btn is-small", text: "Fermer la caméra",
        onclick: function () { img.removeAttribute("src"); delete liveCams[p.id]; if (onRetry) onRetry(); } }));
    } else {
      // The proof, not a promise: a still refreshed by the poll, one tap from the live stream.
      var shot = h("img", { class: "p3d-cam-img", alt: "",
        onerror: function () { still.classList.add("is-missing"); } });
      var still = h("button", { type: "button", class: "p3d-cam-still",
        "aria-label": "Ouvrir la caméra de " + p.name + " en direct",
        onclick: function () { liveCams[p.id] = true; if (onRetry) onRetry(); } }, [
        shot, h("span", { class: "p3d-cam-still-tag", text: "📷 En direct" })]);
      wrap.append(still);
      shots[p.id] = { img: shot, at: 0, broken: false };
      refreshShot(p);
    }
    return wrap;
  }
  // ── crossfade camera (prototype, opt-in) ──
  // The A1 camera sends ~0.7 fps: a hard cut every 1.4 s reads as a slideshow. Two stacked canvases
  // blend one frame into the next; the compositor does the work, so a phone pays one opacity
  // transition per frame. The price is ghosting: both frames stay visible while the blend lasts.
  function camFade() { try { return window.localStorage.getItem(FADE_KEY) === "1"; } catch (e) { return false; } }
  function setCamFade(on) { try { window.localStorage.setItem(FADE_KEY, on ? "1" : "0"); } catch (e) { } }
  function fadeToggle(rerender) {
    return h("button", { type: "button", class: "p3d-fade-toggle", text: "Fondu",
      "aria-pressed": camFade() ? "true" : "false",
      title: "Fondu entre deux images — plus doux, mais deux positions visibles pendant le mélange",
      onclick: function () { setCamFade(!camFade()); rerender(); } });
  }
  function stopFadesIn(container) {
    activeFades = activeFades.filter(function (f) {
      if (!f.el.isConnected || (container && container.contains(f.el))) { f.stop(); return false; }
      return true;
    });
  }
  var HEAD_END = [13, 10, 13, 10];
  function joinBytes(a, b) {
    if (!a.length) return b;
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function findBytes(buf, pat) {
    outer: for (var i = 0; i + pat.length <= buf.length; i++) {
      for (var j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }
  function textOf(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function asBitmap(jpeg) {
    var blob = new Blob([jpeg], { type: "image/jpeg" });
    if (window.createImageBitmap) return window.createImageBitmap(blob);
    return new Promise(function (res, rej) {          // older Safari: decode through an <img>
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res(img); URL.revokeObjectURL(url); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function fadeCam(p, onRetry) {
    var wrap = h("div", { class: "p3d-cam is-fading" });
    var view = h("div", { class: "p3d-cam-view p3d-fade" });
    var front = h("canvas", { class: "p3d-fade-layer" });
    var back = h("canvas", { class: "p3d-fade-layer is-back" });
    front.style.zIndex = "2";
    back.style.zIndex = "1";
    view.append(back, front, h("span", { class: "p3d-cam-live", "aria-hidden": "true" }));
    wrap.classList.add("is-connecting");
    wrap.append(view);
    var stop = false, timer = 0, reader = null;
    var ctl = { el: wrap, stop: function () {
      stop = true; clearTimeout(timer);
      try { if (reader) reader.cancel(); } catch (e) { }
    } };
    activeFades.push(ctl);
    wrap._frame = function () { return front; };   // lets "Enregistrer l'image" work without an <img>

    function fail() {
      wrap.classList.remove("is-connecting");
      wrap.classList.add("is-error");
      if (!wrap.querySelector(".p3d-warn")) wrap.append(
        h("p", { class: "p3d-warn", text: "Caméra occupée ou injoignable." }),
        h("button", { type: "button", class: "p3d-btn is-small", text: "Réessayer",
          onclick: function () { if (onRetry) onRetry(); } }));
    }
    function draw(bmp) {
      if (stop) return;
      var w = Math.min(960, bmp.width || 960), hgt = Math.round((bmp.height || 540) * w / (bmp.width || 960));
      [front, back].forEach(function (c) { if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; } });
      back.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
      if (typeof bmp.close === "function") bmp.close();
      wrap.classList.remove("is-connecting");
      wrap.classList.add("is-live");
      back.style.transition = "none";
      back.style.opacity = "1";            // drawn under the opaque older frame: invisible until the fade
      front.style.transition = "opacity " + FADE_MS + "ms linear";
      front.style.opacity = "0";
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (stop) return;
        var old = front;
        front = back; back = old;
        front.style.transition = "none";
        front.style.opacity = "1";
        front.style.zIndex = "2";
        back.style.zIndex = "1";
      }, FADE_MS + 40);
    }
    (function pump() {
      fetch("/api/print3d/camera/" + encodeURIComponent(p.id) + "?fps=0", { cache: "no-store", credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok || !res.body || !res.body.getReader) throw new Error("stream");
          reader = res.body.getReader();
          var buf = new Uint8Array(0);
          function step() {
            if (stop) { try { reader.cancel(); } catch (e) { } return; }
            reader.read().then(function (r) {
              if (r.done || stop) return;
              buf = joinBytes(buf, r.value);
              for (;;) {
                var cut = findBytes(buf, HEAD_END);
                if (cut < 0) break;
                var m = /Content-Length:\s*(\d+)/i.exec(textOf(buf.subarray(0, cut)));
                if (!m) { buf = buf.subarray(cut + 4); continue; }
                var len = Number(m[1]), from = cut + 4;
                if (!(len > 0) || buf.length < from + len) break;
                var jpeg = buf.slice(from, from + len);
                buf = buf.subarray(from + len);
                asBitmap(jpeg).then(draw).catch(function () { });
              }
              step();
            }).catch(function () { if (!stop) fail(); });
          }
          step();
        })
        .catch(function () { if (!stop) fail(); });
    })();
    return wrap;
  }
  function refreshShot(p) {
    var s = shots[p.id];
    if (!s || !s.img || s.broken || liveCams[p.id] || !(p.link && p.link.online)) return;
    var now = Math.floor(Date.now() / 1000);
    var st = (p.status && p.status.state) || "";
    var active = st === "printing" || st === "paused" || st === "preparing";
    if (now - s.at < (active ? 0 : SHOT_IDLE_SEC)) return;   // a still costs a request: only when the scene may have moved
    s.at = now;
    s.img.src = "/api/print3d/snapshot/" + encodeURIComponent(p.id) + "?t=" + now;
  }
  function fullscreenCam(p) {
    var reopen = function () { closeOverlay(); fullscreenCam(p); };
    var body = camFade()
      ? h("div", { class: "p3d-cam" }, [fadeCam(p, reopen),
        h("div", { class: "p3d-cam-actions" }, [lookControl(), fadeToggle(reopen)])])
      : h("div", { class: "p3d-cam" }, [
        h("img", { "data-live": "1", alt: "Caméra " + p.name, src: "/api/print3d/camera/" + encodeURIComponent(p.id) }),
        h("div", { class: "p3d-cam-actions" }, [lookControl()])]);
    openOverlay(h("div", { class: "p3d-cam-full" }, [h("h3", { text: p.name }), body]));
  }
  function closeAllCams() {
    if (!ui) return;
    ui.root.querySelectorAll("img[data-live]").forEach(function (img) { img.removeAttribute("src"); });
    activeFades.forEach(function (f) { f.stop(); });
    activeFades = [];
    liveCams = {};
    Object.keys(printerViews).forEach(function (id) { printerViews[id].resetCam(); });
  }

  // A printer card is built once and then updated in place. The camera tile lives in its own
  // node that a poll never touches, so an open MJPEG session survives every state refresh.
  function printerView(first) {
    var dot = h("span", { class: "p3d-dot" });
    var title = h("strong");
    var kind = h("span", { class: "p3d-kind" });
    var pill = h("span", { class: "p3d-pill" });
    var art = h("span", { class: "p3d-card-art", "aria-hidden": "true" }, [printerArt(first.kind)]);
    var head = h("div", { class: "p3d-card-head" }, [dot, art, title, kind, pill]);
    var warn = h("p", { class: "p3d-warn", hidden: true });
    var stall = h("p", { class: "p3d-stall", hidden: true });
    var job = h("p", { class: "p3d-job", hidden: true });
    var rel = h("p", { class: "p3d-meta p3d-reliability", hidden: true });
    var plateHost = h("div", { class: "p3d-plate-host", hidden: true });
    var watchLine = h("p", { class: "p3d-meta p3d-watch" });
    var fill = h("span");
    var meta = h("p", { class: "p3d-meta" });
    var progress = h("div", { class: "p3d-progress-wrap", hidden: true }, [
      h("div", { class: "p3d-progress" }, [fill]), meta]);
    var nozzle = h("span"), bed = h("span"), light = h("span", { hidden: true });
    var temps = h("div", { class: "p3d-temps" }, [nozzle, bed, light]);
    var ams = h("div", { class: "p3d-ams" });
    var amsNote = h("p", { class: "p3d-ams-note", hidden: true });
    var alerts = h("div", { class: "p3d-alerts", role: "status", "aria-live": "polite" });
    var camHost = h("div", { class: "p3d-cam-host" });
    var roomBtn = h("button", { type: "button", class: "p3d-btn is-small p3d-room-open", text: "Voir le poste",
      onclick: function () { openPrinterRoom(latest); } });
    var el = h("article", { class: "p3d-card" }, [head, warn, stall, job, rel, plateHost, watchLine, progress, temps, ams, amsNote, alerts, camHost, roomBtn]);
    el.dataset.printer = first.id;

    var latest = first, amsSig = "", alertsSig = "", camSig = null, plateSig = "";

    function renderPlate(p) {
      var plate = p.plate;
      plateHost.hidden = !plate;
      if (!plate) { plateHost.innerHTML = ""; plateSig = ""; return; }
      var sig = [plate.id, plate.name, plate.ext, plate.has_thumb ? 1 : ""].join("¦");
      if (sig === plateSig) return;
      plateSig = sig;
      plateHost.innerHTML = "";
      plateHost.append(platePreview(plate));
    }

    function renderCam() {
      camSig = liveCams[latest.id] ? "live " + latest.name : "idle";
      if (liveCams[latest.id]) delete shots[latest.id];   // the stream replaces the still
      stopFadesIn(camHost);
      camHost.innerHTML = "";
      camHost.append(camTile(latest, renderCam));
    }

    function renderSlots(s) {
      var slots = Array.isArray(s.ams) && s.ams.length ? s.ams : null;
      var sig = slots ? slots.map(function (x) {
        return [x.slot, x.material, x.colour, x.loaded, x.active].join("¦");
      }).join("§") : s.external_spool
        ? "ext¦" + (s.external_spool.material || "") + "¦" + (s.external_spool.colour || "") : "";
      if (sig === amsSig) return;                  // nothing moved: keep the nodes
      amsSig = sig;
      ams.innerHTML = "";
      if (slots) {
        slots.forEach(function (slot) {
          var empty = slot.loaded === false || !slot.material;
          ams.append(h("span", { class: "p3d-slot" + (slot.active ? " is-active" : "") + (empty ? " is-empty" : ""),
            title: "Fente " + slot.slot + " · " + (empty ? "vide" : slot.material + (slot.colour ? " · " + slot.colour : "")) }, [
            h("i", { style: "background:" + (slot.colour || "transparent") }), empty ? "vide" : slot.material]));
        });
      } else if (s.external_spool) {
        ams.append(h("span", { class: "p3d-slot" }, [
          h("i", { style: "background:" + (s.external_spool.colour || "transparent") }),
          s.external_spool.material || "Bobine externe"]));
      }
    }

    function renderAlerts(s) {
      var items = [];
      (s.problems || []).forEach(function (pr) {
        items.push("p¦" + pr.code + "¦" + (pr.severity || "") + "¦" + pr.text);
      });
      var wa = s.watch && s.watch.alarm;
      if (wa) items.push("w¦" + wa.level + "¦" + wa.reason + "¦" + (wa.paused ? 1 : 0));
      var sig = items.join("§");
      if (sig === alertsSig) return;               // an unchanged alarm is never re-announced
      alertsSig = sig;
      alerts.innerHTML = "";
      (s.problems || []).forEach(function (pr) {
        alerts.append(h("div", { class: "p3d-problem is-" + (pr.severity || "common") + (pr.known ? "" : " is-unknown") }, [
          h("strong", { text: pr.code }), h("span", { text: pr.text })]));
      });
      if (wa) {
        alerts.append(h("div", { class: "p3d-problem is-" + (wa.level === "failure" ? "serious" : "common") }, [
          h("strong", { text: wa.level === "failure" ? "ÉCHEC PROBABLE" : "À VÉRIFIER" }),
          h("span", { text: wa.reason + (wa.paused ? " — imprimante mise en pause automatiquement." : "") })]));
      }
    }

    // No alarm and a stopped watcher must not look alike: always say when it last looked and when
    // the next look is due. A next look more than WATCH_GRACE_SEC late is flagged as overdue.
    function renderWatch(s, state) {
      var cfg = (data.config && data.config.watch) || {};
      var w = s.watch;
      var watching = state === "printing" || state === "paused";
      var txt, hint = "", overdue = false;
      if (cfg.enabled !== true) {
        txt = "Surveillance désactivée";
      } else if (!watching || !w) {
        txt = "Surveillance active · en attente " + (watching ? "du premier regard" : "d'une impression");
      } else {
        var looked = w.looked || w.checked || 0;
        var next = w.next || 0;
        var last = looked ? "dernière vérification " + fmtAgo(looked) : "pas encore vérifié";
        var nxt;
        if (state === "paused") nxt = "en pause avec l'imprimante";
        else if (!next) nxt = "prochaine vérification à planifier";
        else {
          var left = next - Date.now() / 1000;
          if (left > 0) nxt = "prochaine dans " + fmtCountdown(left);
          else if (left > -WATCH_GRACE_SEC) nxt = "prochaine vérification imminente";
          else { nxt = "prochaine vérification dépassée depuis " + fmtSince(next); overdue = true; }
        }
        txt = "Surveillance · " + last + " · " + nxt;
        hint = "Dernière vérification : " + (looked ? fmtAt(looked) : "jamais")
          + " · Prochaine : " + (next ? fmtAt(next) : "à planifier");
      }
      if (watchLine.textContent !== txt) watchLine.textContent = txt;
      watchLine.classList.toggle("is-overdue", overdue);
      watchLine.title = hint;
      watchLine.hidden = cfg.enabled !== true;   /* one mention is enough: the sheet keeps it */
    }

    function update(p) {
      latest = p;
      var s = p.status || {}, link = p.link || {};
      var state = s.state || "unknown";
      // A reported <code>offline</code> state already carries the class: appending it again would duplicate it.
      el.className = "p3d-card is-" + state + (link.online || state === "offline" ? "" : " is-offline");
      dot.className = "p3d-dot" + (link.online ? " is-on" : "");
      dot.title = link.online ? "En ligne" : (link.error || "Hors ligne");
      title.textContent = p.name;
      kind.textContent = KIND_LABEL[p.kind] || p.kind;
      pill.className = "p3d-pill is-" + state;
      pill.textContent = STATE_LABEL[state] || state;

      if (!link.online) {
        warn.hidden = false;
        // link.since is when this outage started; link.at moves on every retry (3-60 s), not useful here.
        warn.textContent = (link.error || "Hors ligne")
          + ((link.since || link.at) ? " · depuis " + fmtSince(link.since || link.at) : "");
      } else warn.hidden = true;

      job.hidden = !s.job;
      job.textContent = s.job || "";
      renderPlate(p);

      var showBar = typeof s.progress === "number"
        && (state === "printing" || state === "paused" || state === "preparing");
      progress.hidden = !showBar;
      if (showBar) {
        var pct = Math.max(0, Math.min(100, s.progress));
        fill.style.width = pct.toFixed(1) + "%";  // CSS glides this width between polls
        var txt = num(pct, pct % 1 ? 1 : 0) + " %"
          + (s.total_layers ? " · couche " + num(s.layer) + "/" + num(s.total_layers) : "")
          + (s.remaining_sec ? " · reste " + fmtDur(s.remaining_sec) + " (" + fmtClock(s.remaining_sec) + ")" : "");
        if (meta.textContent !== txt) {            // the number ticks only when it truly changes
          meta.textContent = txt;
          meta.classList.remove("is-tick");
          void meta.offsetWidth;
          meta.classList.add("is-tick");
        } else meta.classList.remove("is-tick");
      }

      nozzle.textContent = "Buse " + num(s.nozzle) + "°" + (s.nozzle_target ? " → " + num(s.nozzle_target) + "°" : "");
      bed.textContent = "Plateau " + num(s.bed) + "°" + (s.bed_target ? " → " + num(s.bed_target) + "°" : "");
      light.hidden = s.light == null;
      light.textContent = s.light ? "Lumière allumée" : "Lumière éteinte";

      renderSlots(s);
      var amsInfo = amsCheck(s);
      amsNote.hidden = !amsInfo;
      if (amsInfo) {
        amsNote.textContent = amsInfo.text;
        amsNote.classList.toggle("is-warn", !!amsInfo.warn);
      }
      renderAlerts(s);
      renderWatch(s, state);
      // A job that says printing while its progress and layer have not moved for minutes is exactly the
      // failure a green pill hides: name it, in amber, instead of letting the bar sit there.
      var watch = progressWatch[p.id] || (progressWatch[p.id] = { sig: "", since: Date.now() });
      if (state === "printing") {
        var psig = String(s.progress) + "¦" + (s.layer == null ? "" : s.layer);
        if (psig !== watch.sig) { watch.sig = psig; watch.since = Date.now(); }
      } else { watch.sig = ""; watch.since = Date.now(); }
      var stalled = isStalled(p);
      stall.hidden = !stalled;
      if (stalled) stall.textContent = "Pas de progrès depuis " + fmtDur((Date.now() - watch.since) / 1000);

      var stat = s.job && jobIndex ? jobIndex[s.job] : null;
      rel.hidden = !(stat && stat.n > 1);
      if (!rel.hidden) rel.textContent = stat.n + " impressions de cette pièce · " + stat.fails + (stat.fails === 1 ? " échec" : " échecs");
      refreshShot(p);
      var want = liveCams[p.id] ? "live " + p.name : "idle";
      if (camSig !== want) renderCam();
    }

    function resetCam() { camSig = null; renderCam(); }

    return { el: el, update: update, resetCam: resetCam };
  }

  // ── activity rail ──
  // The rail is a small, capped view of this session: recent history seeds it once, then only
  // real transitions are appended (one event per change, never one per poll).
  function activityNow() { return Math.floor(Date.now() / 1000); }
  function addActivity(item) {
    item.id = ++activity.seq;
    activity.items.unshift(item);
    if (activity.items.length > activityMax) activity.items.length = activityMax;
  }
  function addJobActivity(j) {
    var label = { finished: "terminé", failed: "échec", stopped: "arrêté" }[j.outcome] || j.outcome || "terminé";
    var grams = j.filament && typeof j.filament.g === "number" ? " · " + fmtGrams(j.filament.g) : "";
    addActivity({ kind: j.outcome === "failed" ? "problem" : j.outcome === "stopped" ? "stop" : "finish",
      printer: j.printer_name || "Atelier", text: (j.job || "Impression") + " · " + label + grams,
      at: j.at || activityNow(), job: j.job || "" });
  }
  function seedActivity(jobs) {
    activity.items = [];
    activity.seq = 0;
    activity.sig = "";
    activity.ages = [];
    activity.nodes = {};
    activity.known = {};
    (jobs || []).forEach(function (j) { activity.known[j.id] = true; });
    (jobs || []).slice(0, 4).reverse().forEach(addJobActivity);
    activity.seeded = true;
  }
  function noteActivity(prev, res) {
    var jobs = res.history || [];
    if (!activity.seeded) { seedActivity(jobs); return; }

    // A completed job is a history event, not a second status event: the figure is on the row.
    var fresh = jobs.filter(function (j) { return !activity.known[j.id]; });
    for (var j = fresh.length - 1; j >= 0; j--) addJobActivity(fresh[j]);
    activity.known = {};
    jobs.forEach(function (j) { activity.known[j.id] = true; });

    var old = {};
    ((prev && prev.printers) || []).forEach(function (p) { old[p.id] = p; });
    (res.printers || []).forEach(function (p) {
      var before = old[p.id];
      if (!before) return;                       // a newly configured printer is not a transition
      var wasLink = before.link || {}, nowLink = p.link || {};
      if (!!wasLink.online !== !!nowLink.online) {
        addActivity({ kind: nowLink.online ? "online" : "offline", printer: p.name || p.id,
          text: nowLink.online ? "reconnectée" : ("hors ligne" + (nowLink.error ? " · " + nowLink.error : "")),
          at: activityNow() });
      }
      var wasState = (before.status && before.status.state) || "unknown";
      var nowState = (p.status && p.status.state) || "unknown";
      if (wasState !== nowState) {
        var jobName = (p.status && p.status.job) || "";
        if (nowState === "printing" || nowState === "preparing") {
          addActivity({ kind: "start", printer: p.name || p.id,
            text: (wasState === "paused" ? "reprise" : "impression lancée") + (jobName ? " · " + jobName : ""),
            at: activityNow(), job: jobName });
        } else if (nowState === "paused" && wasState !== "paused") {
          addActivity({ kind: "pause", printer: p.name || p.id,
            text: "mise en pause" + (jobName ? " · " + jobName : ""), at: activityNow(), job: jobName });
        }
      }
      var known = {};
      ((before.status && before.status.problems) || []).forEach(function (pr) { known[pr.code] = true; });
      ((p.status && p.status.problems) || []).forEach(function (pr) {
        if (!known[pr.code]) addActivity({ kind: "problem", printer: p.name || p.id,
          text: pr.code + (pr.text ? " — " + pr.text : ""), at: activityNow() });
      });
    });
  }
  function renderActivity(s) {
    var list = s.events;
    var sig = activity.items.map(function (e) { return e.id; }).join("¦");
    if (sig !== activity.sig || (!activity.items.length && !list.querySelector(".p3d-events-empty"))) {
      activity.sig = sig;
      if (!activity.items.length) {
        Object.keys(activity.nodes).forEach(function (id) { activity.nodes[id].remove(); delete activity.nodes[id]; });
        if (!list.querySelector(".p3d-events-empty")) {
          list.append(h("li", { class: "p3d-events-empty", text: "Aucun événement depuis l'ouverture." }));
        }
      } else {
        var empty = list.querySelector(".p3d-events-empty");
        if (empty) empty.remove();
        var wanted = {};
        activity.items.forEach(function (e) { wanted[e.id] = true; });
        Object.keys(activity.nodes).forEach(function (id) {
          if (wanted[id]) return;
          activity.nodes[id].remove();
          delete activity.nodes[id];
        });
        // Re-use the existing rows: a new event must not make a screen reader announce the old ones again.
        activity.items.slice().reverse().forEach(function (e) {
          var row = activity.nodes[e.id];
          if (!row) {
            row = h("li", { class: "p3d-event is-" + e.kind, title: new Date(e.at * 1000).toLocaleString() }, [
              h("time", { datetime: new Date(e.at * 1000).toISOString(), text: fmtAt(e.at) }),
              h("span", { class: "p3d-event-printer", text: e.printer || "Atelier" }),
              h("span", { class: "p3d-event-text", text: e.text || "" }),
              h("span", { class: "p3d-event-age" }),
            ]);
            activity.nodes[e.id] = row;
          }
          if (list.firstChild !== row) list.insertBefore(row, list.firstChild);
        });
      }
      activity.ages = activity.items.map(function (e) {
        var row = activity.nodes[e.id];
        return { el: row && row.querySelector(".p3d-event-age"), at: e.at };
      }).filter(function (a) { return !!a.el; });
    }
    activity.ages.forEach(function (a) { a.el.textContent = fmtAgo(a.at); });
  }

  // ── floor strip ──
  function floorCell(refs, key, label, action) {
    var strong = h("strong", { text: "–" });
    var el = h("button", { type: "button", class: "p3d-floor-cell is-" + key, "data-floor": key,
      onclick: function () { focusFloor(key); } }, [strong, h("span", { class: "p3d-floor-label", text: label })]);
    refs[key] = { el: el, strong: strong, label: label, action: action };
    return el;
  }
  // A figure is a shortcut, not a second dashboard: a cell takes you to the card it names.
  function floorPrinter(key) {
    var list = data.printers || [];
    if (key === "next") {
      var best = null, sec = null;
      list.forEach(function (p) {
        var st = (p.status && p.status.state) || "";
        var left = p.status && p.status.remaining_sec;
        if (st !== "printing" || typeof left !== "number" || left <= 0) return;
        if (sec == null || left < sec) { sec = left; best = p; }
      });
      return best;
    }
    var want = key === "printing" ? function (p) { return (p.status && p.status.state) === "printing"; }
      : key === "offline" ? function (p) { return !(p.link && p.link.online); }
      : function (p) { return !!(p.link && p.link.online); };
    var matches = list.filter(want);
    return matches.find(function (p) { return p.id === lastRoomId; }) || matches[0] || null;
  }
  function scrollSoft(el) {
    if (!el || typeof el.scrollIntoView !== "function") return;
    var calm = false;
    try { calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
    el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }
  function focusFloor(key) {
    var s = printerShellRef;
    if (!s) return;
    if (key === "today") { if (!s.hist.hidden) scrollSoft(s.hist); return; }
    var p = floorPrinter(key);
    if (!p) return;
    var card = null;
    [].forEach.call(s.grid.children, function (el) {
      if (!card && el.dataset && el.dataset.printer === p.id) card = el;
    });
    if (!card) return;
    card.classList.add("is-target");
    setTimeout(function () { card.classList.remove("is-target"); }, 1600);
    scrollSoft(card);
  }
  function buildFloor() {
    var refs = {};
    // The title lives in the grid so it shares the section's inset and lines up with the cells at every width.
    var title = h("h3", { class: "p3d-h3 p3d-floor-title", id: "p3d-floor-title", text: "Atelier maintenant" });
    var el = h("section", { class: "p3d-floor", hidden: true, "aria-labelledby": "p3d-floor-title" }, [
      title,
      floorCell(refs, "online", "En ligne", "Voir les imprimantes"),
      floorCell(refs, "printing", "Impression", "Voir l'impression en cours"),
      floorCell(refs, "offline", "Hors ligne", "Voir l'imprimante qui ne répond pas"),
      floorCell(refs, "next", "Fin prévue", "Voir l'impression qui finit en premier"),
      floorCell(refs, "today", "Aujourd'hui", "Voir les dernières impressions"),
    ]);
    return { el: el, refs: refs, title: title };
  }
  // IntersectionObserver is not dependable in an occluded window, and a wrong "hidden" here would hide the
  // numbers for good: a cheap rectangle test on scroll is enough for a 24 px line.
  // The floating Elsea chip is fixed at the right edge; on a phone it lands on the at-a-glance strip.
  // While their boxes meet, the chip steps aside instead of covering a figure — and comes back once
  // the strip is scrolled away. A chip the operator dragged out of the way never meets it.
  function clearChipOverFloor() {
    if (!document.body || !document.body.classList) return;
    var chip = typeof document.getElementById === "function" ? document.getElementById("hq-elsea-chip-dock") : null;
    var s = printerShellRef, on = false;
    if (chip && s && s.floor && !s.floor.hidden) {
      var a = s.floor.getBoundingClientRect(), b = chip.getBoundingClientRect();
      on = b.width > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top;
    }
    document.body.classList.toggle("is-p3d-under-floor", on);
  }
  function bindMiniScroll() {
    if (miniSync) return;
    miniSync = function () {
      var s = printerShellRef;
      clearChipOverFloor();
      if (!s || !s.mini || !s.floor) return;
      if (!loaded.printers || !(data.printers || []).length) { s.mini.hidden = true; return; }
      var box = s.floor.getBoundingClientRect();
      s.mini.hidden = box.height === 0 || box.bottom > 4;
    };
    window.addEventListener("scroll", miniSync, { passive: true });
    window.addEventListener("resize", miniSync, { passive: true });
  }
  function renderFloor(s, list) {
    var online = 0, printing = 0, offline = 0, next = null, nextName = "";
    list.forEach(function (p) {
      if (p.link && p.link.online) online += 1; else offline += 1;
      var st = (p.status && p.status.state) || "unknown";
      if (st === "printing") {
        printing += 1;
        var left = p.status && p.status.remaining_sec;
        if (typeof left === "number" && left > 0 && (next == null || left < next)) { next = left; nextName = p.name; }
      }
    });
    s.floorRefs.online.strong.textContent = online + " / " + list.length;
    s.floorRefs.printing.strong.textContent = String(printing);
    s.floorRefs.offline.strong.textContent = String(offline);
    s.floorRefs.offline.el.title = offline ? "Une ou plusieurs imprimantes ne répondent pas" : "Toutes les imprimantes répondent";
    s.floorRefs.next.strong.textContent = next != null ? fmtClock(next) : "—";
    s.floorRefs.next.el.title = next != null ? "Fin estimée de " + nextName : "Aucune impression en cours";
    var midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    var today = 0, measured = false;
    (data.history || []).forEach(function (j) {
      if (!j.at || j.at * 1000 < midnight.getTime()) return;
      if (j.filament && typeof j.filament.g === "number") { today += j.filament.g; measured = true; }
    });
    s.floorRefs.today.strong.textContent = measured ? fmtGrams(today) : fmtGrams(0);
    s.floorRefs.today.el.title = "Somme des impressions d'aujourd'hui dans les 10 dernières affichées";
    // A zero is not a warning: green/pink/amber only when there is something behind the figure.
    s.floorRefs.printing.el.classList.toggle("is-quiet", printing === 0);
    s.floorRefs.offline.el.classList.toggle("is-quiet", offline === 0);
    s.floorRefs.next.el.classList.toggle("is-quiet", next == null);
    s.floorRefs.today.el.classList.toggle("is-quiet", !measured);
    // The button says what it does, not only what it counts.
    ["online", "printing", "offline", "next", "today"].forEach(function (k) {
      var ref = s.floorRefs[k];
      ref.el.setAttribute("aria-label", ref.label + " : " + ref.strong.textContent + ". " + ref.action);
    });
    if (s.miniSpan) s.miniSpan.textContent = online + "/" + list.length + " en ligne · " + printing + " en impression"
      + (offline ? " · " + offline + " hors ligne" : "");
  }

  function platePreview(plate) {
    var media;
    if (plate.has_thumb) {
      media = h("img", { loading: "lazy", decoding: "async", alt: "Aperçu de " + plate.name,
        src: "/api/print3d/models/thumb?id=" + encodeURIComponent(plate.id),
        onerror: function () { this.replaceWith(h("span", { class: "p3d-ext", text: (plate.ext || "?").toUpperCase() })); } });
    } else media = h("span", { class: "p3d-ext", text: (plate.ext || "?").toUpperCase() });
    return h("div", { class: "p3d-plate" }, [
      h("div", { class: "p3d-plate-visual" }, [media]),
      h("div", { class: "p3d-plate-copy" }, [h("span", { class: "p3d-kicker", text: "Fichier source" }),
        h("strong", { text: plate.name })]),
    ]);
  }

  // ── art: one silhouette per workshop model ──
  var SVG_NS = "http://www.w3.org/2000/svg";
  // document.createElement("svg") yields an inert HTMLUnknownElement: every shape has to be made in the SVG namespace.
  function s(tag, attrs, kids) {
    var el = typeof document.createElementNS === "function"
      ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) el.append(c); });
    return el;
  }
  // A card should be recognised before its name is read: the open-frame bedslinger and the closed cube
  // are drawn as outlines, so they follow the theme instead of shipping two bitmaps.
  function printerArt(kind, cls) {
    var shapes = kind === "flashforge" ? [
      s("rect", { x: 14, y: 14, width: 68, height: 42, rx: 5 }),                 // enclosure
      s("rect", { x: 25, y: 22, width: 46, height: 24, rx: 2, class: "p3d-art-glass" }),   // door
      s("path", { d: "M25 52 H71", class: "p3d-art-glass" }),                  // bed seen through the door
      s("circle", { cx: 48, cy: 9, r: 6, class: "p3d-art-print" }),             // spool on top
      s("path", { d: "M58 9 H66", class: "p3d-art-spool-arm" }),
    ] : [
      s("path", { d: "M20 56 V12 H74", class: "p3d-art-frame" }),               // upright and top beam
      s("path", { d: "M20 32 H74", class: "p3d-art-frame" }),                   // X gantry
      s("rect", { x: 54, y: 24, width: 12, height: 8, rx: 2 }),                  // toolhead on it
      s("path", { d: "M28 44 H84 L78 54 H34 Z" }),                              // bed
      s("path", { d: "M56 36 h10 v8 h-10 z", class: "p3d-art-print" }),          // the print, under the nozzle
    ];
    return s("svg", { class: "p3d-art" + (cls ? " " + cls : ""), viewBox: "0 0 96 64",
      "aria-hidden": "true", focusable: "false" }, shapes);
  }

  // ── focused printer room ──
  function roomWatchText(p) {
    var cfg = (data.config && data.config.watch) || {};
    var st = (p.status && p.status.state) || "unknown";
    var w = p.status && p.status.watch;
    if (cfg.enabled !== true) return "Surveillance désactivée";
    if ((st !== "printing" && st !== "paused") || !w) return "Surveillance active · en attente";
    if (st === "paused") return "Surveillance en pause avec l'imprimante";
    if (w.next) return "Dernière " + fmtAgo(w.looked || w.checked) + " · prochaine " + (w.next > Date.now() / 1000 ? "dans " + fmtCountdown(w.next - Date.now() / 1000) : "imminente");
    return "Surveillance · pas encore vérifié";
  }
  function renderRoomSpark(room) {
    var samples = room.samples, d = "";
    if (samples.length) {
      d = samples.map(function (v, i) {
        var x = samples.length === 1 ? 0 : (i / (samples.length - 1)) * 100;
        var y = 34 - Math.max(0, Math.min(100, v.pct)) * 0.32;
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" ");
    }
    room.spark.setAttribute("d", d);
    room.refs.history.hidden = !samples.length;   /* no sample yet: the empty card would be a blank block */
  }
  function updateRoomCam() {
    if (!printerRoom || !printerRoom.p) return;
    var p = printerRoom.p, host = printerRoom.refs.camHost;
    stopFadesIn(host);
    host.innerHTML = "";
    if (!printerRoom.camOpen) {
      host.append(h("button", { type: "button", class: "p3d-cam-open", text: "📷 Ouvrir la caméra",
        onclick: function () { camChoice = true; printerRoom.camOpen = true; updateRoomCam(); } }));
      return;
    }
    if (camFade()) {
      var fade = fadeCam(p, updateRoomCam);
      fade.append(h("div", { class: "p3d-cam-actions" }, [
        lookControl(), fadeToggle(updateRoomCam),
        h("button", { type: "button", class: "p3d-btn is-small", text: "Enregistrer l'image",
          onclick: function () { saveCameraFrame(fade._frame(), p.name); } }),
        h("button", { type: "button", class: "p3d-btn is-small", text: "Fermer la caméra",
          onclick: function () { camChoice = false; printerRoom.camOpen = false; updateRoomCam(); } }),
      ]));
      host.append(fade);
      return;
    }
    var wrap = h("div", { class: "p3d-cam" });
    var view = h("div", { class: "p3d-cam-view" });
    var img = h("img", { "data-live": "1", alt: "Caméra " + p.name,
      src: "/api/print3d/camera/" + encodeURIComponent(p.id) + "?fps=" + CAM_FPS,
      onload: function () { wrap.classList.remove("is-connecting"); wrap.classList.add("is-live"); },
      onerror: function () {
        wrap.classList.remove("is-connecting"); wrap.classList.remove("is-live"); wrap.classList.add("is-error");
        if (!wrap.querySelector(".p3d-warn")) wrap.append(
          h("p", { class: "p3d-warn", text: "Caméra occupée ou injoignable." }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Réessayer",
            onclick: function () { updateRoomCam(); } }));
      } });
    wrap.classList.add("is-connecting");
    view.append(img, h("span", { class: "p3d-cam-live", "aria-hidden": "true" }));
    wrap.append(view, h("div", { class: "p3d-cam-actions" }, [
      lookControl(),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Enregistrer l'image",
        onclick: function () { saveCameraFrame(img, p.name); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Fermer la caméra",
        onclick: function () { img.removeAttribute("src"); camChoice = false; printerRoom.camOpen = false; updateRoomCam(); } }),
    ]));
    host.append(wrap);
  }
  function updatePrinterRoom(p) {
    if (!printerRoom) return;
    printerRoom.p = p;
    var refs = printerRoom.refs, s = p.status || {}, link = p.link || {}, st = s.state || "unknown";
    refs.name.textContent = p.name;
    refs.pill.className = "p3d-pill is-" + st;
    refs.pill.textContent = STATE_LABEL[st] || st;
    refs.job.textContent = s.job || (st === "idle" ? "Aucune impression en cours" : "");
    refs.job.hidden = !refs.job.textContent;   /* an offline printer has nothing to announce: no stray dash under the name */
    var said = roomSays(p, s, link);
    refs.say.hidden = !said;
    refs.say.textContent = said;
    var stat = s.job && jobIndex ? jobIndex[s.job] : null;
    refs.relRow.hidden = !(stat && stat.n > 1);
    if (!refs.relRow.hidden) refs.rel.textContent = stat.n + " impressions · " + stat.fails + (stat.fails === 1 ? " échec" : " échecs");
    var active = st === "printing" || st === "preparing" || st === "paused";
    var pct = active && typeof s.progress === "number" ? Math.max(0, Math.min(100, s.progress)) : null;
    refs.progress.textContent = pct == null ? "–" : num(pct, pct % 1 ? 1 : 0) + " %"
      + (s.total_layers ? " · couche " + num(s.layer) + "/" + num(s.total_layers) : "")
      + (s.remaining_sec ? " · reste " + fmtDur(s.remaining_sec) + " (" + fmtClock(s.remaining_sec) + ")" : "")
      + (s.stage_label ? " · " + s.stage_label : "");
    var fans = s.fans && (s.fans.part != null || s.fans.aux != null || s.fans.chamber != null)
      ? " · vent. " + [s.fans.part, s.fans.aux, s.fans.chamber].map(function (v) { return v == null ? "–" : v + "%"; }).join("/") : "";
    refs.temps.textContent = "Buse " + num(s.nozzle) + "°" + (s.nozzle_target ? " → " + num(s.nozzle_target) + "°" : "")
      + " · plateau " + num(s.bed) + "°" + (s.bed_target ? " → " + num(s.bed_target) + "°" : "") + fans;
    refs.light.textContent = s.light == null ? "–" : (s.light ? "Allumée" : "Éteinte");
    refs.watch.textContent = roomWatchText(p);
    refs.link.textContent = link.online ? "En ligne" : ("Hors ligne" + (link.since ? " · depuis " + fmtSince(link.since) : ""));
    refs.link.classList.toggle("is-bad", !link.online);
    // Offline, a row of dashes is noise: the sheet keeps what is known and the line that explains the silence.
    refs.progRow.hidden = !link.online && pct == null;
    refs.tempsRow.hidden = !link.online && s.nozzle == null && s.bed == null;
    refs.lightRow.hidden = !link.online && s.light == null;
    var currentJob = s.job || "";
    if (currentJob !== printerRoom.sampleJob) { printerRoom.samples = []; printerRoom.sampleJob = currentJob; }
    if (active && pct != null) {
      var sample = { at: activityNow(), pct: pct };
      var last = printerRoom.samples[printerRoom.samples.length - 1];
      if (!last || last.pct !== pct || sample.at - last.at >= 1) {
        printerRoom.samples.push(sample);
        if (printerRoom.samples.length > 36) printerRoom.samples.shift();
      }
    }
    renderRoomSpark(printerRoom);
    refs.trend.textContent = active && pct != null ? roomTrend(printerRoom.samples) : "";
    var plateSig = p.plate ? [p.plate.id, p.plate.name, p.plate.has_thumb ? 1 : 0].join("¦") : "";
    if (plateSig !== printerRoom.plateSig) {
      printerRoom.plateSig = plateSig;
      refs.plate.innerHTML = "";
      if (p.plate) refs.plate.append(plateShortcut(p.plate));
      else refs.plate.append(h("p", { class: "p3d-help", text: "Aucun fichier source associé à ce travail." }));
    }
    var slots = Array.isArray(s.ams) && s.ams.length ? s.ams : null;
    var slotSig = slots ? slots.map(function (x) { return [x.slot, x.material, x.colour, x.loaded, x.active].join("¦"); }).join("§")
      : s.external_spool ? "ext¦" + (s.external_spool.material || "") + "¦" + (s.external_spool.colour || "") : "";
    if (slotSig !== printerRoom.slotSig) {
      printerRoom.slotSig = slotSig;
      refs.slots.innerHTML = "";
      if (slots) slots.forEach(function (slot) {
        var empty = slot.loaded === false || !slot.material;
        refs.slots.append(h("span", { class: "p3d-slot" + (slot.active ? " is-active" : "") + (empty ? " is-empty" : ""),
          title: "Fente " + slot.slot + " · " + (empty ? "vide" : slot.material + (slot.colour ? " · " + slot.colour : "")) }, [
          h("i", { style: "background:" + (slot.colour || "transparent") }), empty ? "vide" : slot.material]));
      });
      else if (s.external_spool) refs.slots.append(h("span", { class: "p3d-slot" }, [
        h("i", { style: "background:" + (s.external_spool.colour || "transparent") }),
        s.external_spool.material || "Bobine externe"]));
    }
    refs.amsH3.hidden = refs.slots.hidden = !(slots || s.external_spool);   /* no AMS and no spool: no empty section left behind */
    var amsInfo = amsCheck(s);
    refs.amsNote.hidden = !amsInfo || refs.amsH3.hidden;
    if (amsInfo) { refs.amsNote.textContent = amsInfo.text; refs.amsNote.classList.toggle("is-warn", !!amsInfo.warn); }
    var alertsSig = (s.problems || []).map(function (pr) { return pr.code + "¦" + pr.text; }).join("§");
    if (alertsSig !== printerRoom.alertSig) {
      printerRoom.alertSig = alertsSig;
      refs.alerts.innerHTML = "";
      (s.problems || []).forEach(function (pr) {
        refs.alerts.append(h("div", { class: "p3d-problem is-" + (pr.severity || "common") }, [
          h("strong", { text: pr.code }), h("span", { text: pr.text })]));
      });
    }
  }
  // ── focus-room helpers ──
  // The plate is the job's source file: one tap lands on the model sheet instead of a dead thumbnail.
  function plateShortcut(plate) {
    return h("button", { type: "button", class: "p3d-plate-btn", title: "Ouvrir la fiche de " + plate.name,
      onclick: function () { printerRoom = null; openModel(plate.id); } }, [platePreview(plate)]);
  }
  // Percent per second across the session's own samples: the printer's estimate can be stale, the trace is measured.
  function roomTrend(samples) {
    if (!samples || samples.length < 2) return "";
    var a = samples[0], b = samples[samples.length - 1];
    var dt = b.at - a.at;
    if (!(dt >= 45) || b.pct - a.pct <= 0) return "";
    var sec = (100 - b.pct) / ((b.pct - a.pct) / dt);
    if (!(sec > 45) || sec > 86400) return "";
    return "≈ " + fmtDur(sec) + " à ce rythme";
  }
  function stepRoom(dir) {
    if (!printerRoom) return;
    var list = data.printers || [];
    var i = -1;
    list.forEach(function (p, k) { if (p.id === printerRoom.id) i = k; });
    var next = i >= 0 ? list[i + dir] : null;
    if (next) openPrinterRoom(next);
  }
  function bindRoomSwipe(body) {
    var sx = 0, sy = 0, down = false;
    body.addEventListener("touchstart", function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      down = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    body.addEventListener("touchend", function (e) {
      if (!down) return;
      down = false;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;   // a vertical scroll is not a page turn
      stepRoom(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  // The MJPEG frame is same-origin, so the canvas is not tainted: the picture of a failed print can be kept.
  function saveCameraFrame(img, name) {
    var w = img.naturalWidth || img.width || 0, ht = img.naturalHeight || img.height || 0;
    if (!w || !ht) { toast("Aucune image à enregistrer pour l'instant.", "err"); return; }
    try {
      var c = document.createElement("canvas");
      c.width = w; c.height = ht;
      c.getContext("2d").drawImage(img, 0, 0, w, ht);
      if (typeof c.toBlob !== "function") throw new Error("no blob");
      c.toBlob(function (b) {
        if (!b) { toast("Image indisponible.", "err"); return; }
        var a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = (name || "poste").replace(/[^a-z0-9._-]+/gi, "_") + "-"
          + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + ".png";
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }, "image/png");
    } catch (_) { toast("Image non capturable.", "err"); }
  }
  function buildRoomControls(p) {
    var box = h("div", { class: "p3d-room-ctl" });
    function send(action, extra, msg) {
      var body = Object.assign({ id: p.id, action: action }, extra || {});
      return post("/api/print3d/printer/control", body)
        .then(function () { toast(msg || "Commande envoyée"); return refresh(); })
        .catch(function (e) { toast(e.message, "err"); });
    }
    var stopArm = false;
    var stopBtn = h("button", { type: "button", class: "p3d-btn is-small", text: "Arrêter",
      onclick: function () {
        if (!stopArm) {
          stopArm = true;
          stopBtn.textContent = "Confirmer l'arrêt";
          setTimeout(function () { stopArm = false; stopBtn.textContent = "Arrêter"; }, 4000);
          return;
        }
        stopArm = false; stopBtn.textContent = "Arrêter";
        send("stop", null, "Arrêt envoyé");
      } });
    var row1 = h("div", { class: "p3d-ctl-row" }, [
      h("button", { type: "button", class: "p3d-btn is-small", text: "Pause", onclick: function () { send("pause", null, "Pause envoyée"); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Reprendre", onclick: function () { send("resume", null, "Reprise envoyée"); } }),
      stopBtn,
      h("button", { type: "button", class: "p3d-btn is-small", text: "Lumière ON", onclick: function () { send("light_on", null, "Lumière allumée"); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Lumière OFF", onclick: function () { send("light_off", null, "Lumière éteinte"); } }),
    ]);
    box.append(h("span", { class: "p3d-kicker", text: "Contrôles directs" }), row1);
    if (p.kind === "bambu") {
      var spdRow = h("div", { class: "p3d-ctl-row" }, [
        h("span", { class: "p3d-meta", text: "Vitesse :" })
      ].concat([[1, "Silencieux"], [2, "Standard"], [3, "Sport"], [4, "Ludicrous"]].map(function (sp) {
        return h("button", { type: "button", class: "p3d-tag", text: sp[1],
          onclick: function () { send("speed", { level: sp[0] }, "Vitesse : " + sp[1]); } });
      })));
      var nozIn = h("input", { class: "p3d-input p3d-ctl-num", type: "number", min: "0", max: "300", placeholder: "Buse °C" });
      var bedIn = h("input", { class: "p3d-input p3d-ctl-num", type: "number", min: "0", max: "110", placeholder: "Plateau °C" });
      var tempRow = h("div", { class: "p3d-ctl-row" }, [
        nozIn, h("button", { type: "button", class: "p3d-btn is-small", text: "Buse",
          onclick: function () { if (nozIn.value !== "") send("nozzle_temp", { temp: Number(nozIn.value) }, "Buse → " + nozIn.value + "°C"); } }),
        bedIn, h("button", { type: "button", class: "p3d-btn is-small", text: "Plateau",
          onclick: function () { if (bedIn.value !== "") send("bed_temp", { temp: Number(bedIn.value) }, "Plateau → " + bedIn.value + "°C"); } }),
      ]);
      var skipIn = h("input", { class: "p3d-input p3d-ctl-num", placeholder: "IDs objets (ex: 1, 2)" });
      var sdList = h("div", { class: "p3d-sd-list", hidden: true });
      var advRow = h("div", { class: "p3d-ctl-row" }, [
        skipIn,
        h("button", { type: "button", class: "p3d-btn is-small", text: "Ignorer objets",
          onclick: function () {
            var ids = skipIn.value.split(",").map(function (x) { return parseInt(x.trim(), 10); }).filter(function (n) { return !isNaN(n); });
            if (!ids.length) { toast("Entre au moins un ID d'objet.", "err"); return; }
            send("skip_objects", { ids: ids }, "Objets ignorés : " + ids.join(", "));
          } }),
        h("button", { type: "button", class: "p3d-btn is-small", text: "Carte SD",
          onclick: function () {
            sdList.hidden = false; sdList.textContent = "Lecture de la carte SD…";
            api("/api/print3d/printer/sd?id=" + encodeURIComponent(p.id)).then(function (res) {
              sdList.innerHTML = "";
              var files = res.files || [];
              if (!files.length) { sdList.textContent = "Aucun fichier imprimable sur la carte SD."; return; }
              files.slice(0, 20).forEach(function (f) {
                sdList.append(h("button", { type: "button", class: "p3d-tag", text: "▶ " + f.name,
                  onclick: function () {
                    post("/api/print3d/printer/start_sd", { printer_id: p.id, file: f.name, plate: 1 })
                      .then(function () { toast("Impression SD lancée : " + f.name); return refresh(); })
                      .catch(function (e) { toast(e.message, "err"); });
                  } }));
              });
            }).catch(function (e) { sdList.textContent = e.message; });
          } }),
      ]);
      box.append(spdRow, tempRow, advRow, sdList);
      var objs = Array.isArray(p.plate_objects) ? p.plate_objects : [];
      var skipped = Array.isArray(p.status && p.status.skipped_objects) ? p.status.skipped_objects : [];
      if (objs.length) {
        box.append(h("div", { class: "p3d-ctl-row" }, [
          h("span", { class: "p3d-meta", text: "Objets plateau :" })
        ].concat(objs.map(function (o) {
          var isOff = skipped.indexOf(o.id) !== -1;
          return h("button", { type: "button", class: "p3d-tag" + (isOff ? " is-off" : ""),
            disabled: isOff, text: (isOff ? "✕ " : "") + o.name + " (#" + o.id + ")",
            onclick: function () { send("skip_objects", { ids: [o.id] }, "Objet exclu : " + o.name); } });
        }))));
      }
    }
    return box;
  }

  function openPrinterRoom(p) {
    if (!p) return;
    lastRoomId = p.id;
    var refs = {};
    refs.name = h("h3", { text: p.name });
    refs.pill = h("span", { class: "p3d-pill" });
    refs.job = h("p", { class: "p3d-job" });
    refs.say = h("p", { class: "p3d-say p3d-room-say", hidden: true });
    refs.rel = h("strong", { text: "–" });
    refs.relRow = h("div", { class: "p3d-room-line" }, [h("span", { text: "Fiabilité" }), refs.rel]);
    refs.plate = h("div", { class: "p3d-room-plate" });
    refs.camHost = h("div", { class: "p3d-room-cam" });
    refs.progress = h("strong", { text: "–" });
    refs.temps = h("strong", { text: "–" });
    refs.light = h("strong", { text: "–" });
    refs.watch = h("strong", { text: "–" });
    refs.link = h("strong", { text: "–" });
    refs.trend = h("small", { class: "p3d-room-trend" });
    refs.progRow = h("div", { class: "p3d-room-line" }, [h("span", { text: "Progression / fin" }), refs.progress, refs.trend]);
    refs.tempsRow = h("div", { class: "p3d-room-line" }, [h("span", { text: "Températures" }), refs.temps]);
    refs.lightRow = h("div", { class: "p3d-room-line" }, [h("span", { text: "Lumière" }), refs.light]);
    refs.slots = h("div", { class: "p3d-room-slots" });
    refs.amsNote = h("p", { class: "p3d-ams-note", hidden: true });
    refs.amsH3 = h("h4", { class: "p3d-h3", text: "AMS / bobines" });
    refs.alerts = h("div", { class: "p3d-alerts", role: "status", "aria-live": "polite" });
    var spark = s("path", { d: "" });
    refs.history = h("div", { class: "p3d-room-history" }, [
      h("span", { class: "p3d-kicker", text: "Progression · session" }),
      s("svg", { class: "p3d-spark", viewBox: "0 0 100 36", preserveAspectRatio: "none", "aria-hidden": "true" }, [spark]),
    ]);
    var body = h("div", { class: "p3d-room" }, [
      h("div", { class: "p3d-card-head is-room-head" }, [refs.name,
        h("span", { class: "p3d-room-art", "aria-hidden": "true" }, [printerArt(p.kind)]), refs.pill]),
      refs.job, refs.say,
      h("div", { class: "p3d-room-top" }, [refs.plate, refs.camHost]),
      h("div", { class: "p3d-room-grid" }, [
        refs.progRow, refs.tempsRow, refs.lightRow,
        h("div", { class: "p3d-room-line" }, [h("span", { text: "Surveillance" }), refs.watch]),
        h("div", { class: "p3d-room-line" }, [h("span", { text: "Liaison" }), refs.link]),
        refs.relRow,
      ]),
      refs.history,
      buildRoomControls(p),
      refs.amsH3, refs.slots, refs.amsNote,
      refs.alerts,
    ]);
    bindRoomSwipe(body);
    openOverlay(body, "is-room");
    ui.overlay.setAttribute("aria-label", "Poste " + p.name);
    // A printing printer is why the sheet was opened: show its camera unless the operator closed it before.
    var autoCam = camChoice !== false && (p.status && p.status.state) === "printing" && !!(p.link && p.link.online);
    printerRoom = { id: p.id, p: p, refs: refs, camOpen: autoCam, plateSig: null, slotSig: "", alertSig: "",   /* null so a printer without a plate still renders the empty-state line */
      spark: spark, samples: [], sampleJob: (p.status && p.status.job) || "" };
    refs.name.textContent = p.name;
    updatePrinterRoom(p);
    updateRoomCam();
  }

  function printerShell() {
    var pane = ui.panes.printers;
    if (printerShellRef && pane.contains(printerShellRef.grid)) return printerShellRef;
    pane.innerHTML = "";
    var skel = skeletonRows(2);
    var empty = h("div", { class: "p3d-empty", hidden: true }, [
      h("p", { text: "Aucune imprimante configurée." }),
      h("button", { type: "button", class: "p3d-btn is-primary", text: "Ajouter mes imprimantes",
        onclick: function () { setTab("settings"); } }),
    ]);
    var floor = buildFloor();
    var miniSpan = h("span");
    var mini = h("div", { class: "p3d-mini", hidden: true, "aria-hidden": "true" }, [miniSpan]);
    var grid = h("div", { class: "p3d-grid", hidden: true });
    var events = h("ol", { class: "p3d-events", role: "log", "aria-live": "polite", "aria-label": "Activité récente" });
    var rail = h("section", { class: "p3d-rail", hidden: true, "aria-label": "Activité récente" }, [
      h("div", { class: "p3d-rail-head" }, [h("h3", { class: "p3d-h3", text: "Activité" }),
        h("span", { class: "p3d-meta", text: "Historique récent et transitions de cette session" })]), events]);
    var hist = h("div", { class: "p3d-hist-block", hidden: true }, [
      h("h3", { class: "p3d-h3", text: "Dernières impressions" }),
      h("ul", { class: "p3d-history" })]);
    pane.append(skel, empty, floor.el, mini, grid, rail, hist);
    printerShellRef = { skel: skel, empty: empty, floor: floor.el, floorRefs: floor.refs,
      mini: mini, miniSpan: miniSpan,
      grid: grid, rail: rail, events: events, hist: hist, list: hist.querySelector("ul") };
    // The slim line only takes over once the banner has scrolled away, so nothing is said twice on screen.
    bindMiniScroll();
    return printerShellRef;
  }

  // Elsea's own line: the workshop state said the way she would say it, not a second status readout.
  function elseaMood(list) {
    if (!list.length) return "";
    var bad = list.some(function (p) {
      var st = (p.status && p.status.state) || "";
      return st === "failed" || !(p.link && p.link.online);
    });
    if (bad) return "warn";
    if (stalledPrinter(list)) return "warn";
    return list.some(function (p) { return (p.status && p.status.state) === "printing"; }) ? "live" : "";
  }
  // Derived from the clock, not from a flag the card happens to have set: the strip may render first.
  function isStalled(p) {
    var w = progressWatch[p.id];
    return !!(p.status && p.status.state === "printing" && w && w.since
      && Date.now() - w.since >= STALL_SEC * 1000);
  }
  function stalledPrinter(list) {
    for (var i = 0; i < list.length; i++) {
      if (isStalled(list[i])) return { p: list[i], sec: (Date.now() - progressWatch[list[i].id].since) / 1000 };
    }
    return null;
  }
  // The sheet is where a number becomes advice — and where silence must stay the default.
  function roomSays(p, s, link) {
    if (!link.online) return "";                       // the link row already explains the silence
    var st = s.state || "unknown";
    if (st === "printing" && isStalled(p))
      return "Ça n'avance plus depuis " + fmtDur((Date.now() - progressWatch[p.id].since) / 1000) + " — jette un œil à la buse et au plateau.";
    if ((st === "printing" || st === "preparing") && typeof s.nozzle === "number"
      && typeof s.nozzle_target === "number" && s.nozzle_target - s.nozzle > 25)
      return "La buse est encore à " + num(s.nozzle) + "° — elle monte en température avant d'attaquer.";
    if (st === "idle" && typeof s.bed === "number" && s.bed >= 35)
      return "Le plateau est encore à " + num(s.bed) + "° — laisse-le descendre avant de décoller la pièce.";
    return "";
  }
  function dayStats() {
    var midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    var n = 0, fails = 0, sec = 0;
    (data.history || []).forEach(function (j) {
      if (!j.at || j.at * 1000 < midnight.getTime()) return;
      n += 1;
      if (j.outcome === "failed") fails += 1;
      if (typeof j.duration_sec === "number") sec += j.duration_sec;
    });
    return { n: n, fails: fails, sec: sec };
  }
  // A job name is the only join the history offers: two versions of a piece still look like two pieces.
  function loadJobs() {
    if (!(data.history || []).length) { jobIndex = {}; return Promise.resolve(); }   // nothing recorded, nothing to ask
    return api("/api/print3d/history?limit=50").then(function (res) {
      var idx = {};
      ((res && res.jobs) || []).forEach(function (j) {
        var name = j.job || "";
        if (!name) return;
        var row = idx[name] || (idx[name] = { n: 0, fails: 0 });
        row.n += 1;
        if (j.outcome === "failed") row.fails += 1;
      });
      jobIndex = idx;
      if (ui && loaded.printers) renderPrinters();
    }).catch(function () { jobIndex = null; });
  }
  function elseaSays(list) {
    if (!list.length) return "Aucune machine sous la main. Ajoute-en une, je m'occupe du reste.";
    var printing = list.filter(function (p) { return (p.status && p.status.state) === "printing"; });
    var failed = list.filter(function (p) { return (p.status && p.status.state) === "failed"; });
    var offline = list.filter(function (p) { return !(p.link && p.link.online); });
    if (failed.length) return failed[0].name + " a échoué. Le poste a le détail, je peux t'y emmener.";
    var stalled = stalledPrinter(list);
    if (stalled) return "Ça n'avance plus sur " + stalled.p.name + " depuis " + fmtDur(stalled.sec) + ". Va voir la buse et le plateau.";
    if (printing.length) {
      var p = printing[0], st = p.status || {}, bits = [];
      if (typeof st.progress === "number") bits.push(num(st.progress, 0) + " %");
      if (st.remaining_sec) bits.push("reste " + fmtDur(st.remaining_sec));
      return p.name + " travaille" + (bits.length ? " · " + bits.join(" · ") : "") + ". Je te préviens quand ça se termine.";
    }
    if (offline.length) return offline[0].name + " ne répond plus"
      + (offline[0].link && offline[0].link.since ? " depuis " + fmtSince(offline[0].link.since) : "")
      + ". Je garde un œil dessus.";
    var day = dayStats();
    if (day.n) return (day.n === 1 ? "Une pièce aujourd'hui" : day.n + " pièces aujourd'hui")
      + (day.sec ? " · " + fmtDur(day.sec) + " d'impression" : "")
      + (day.fails ? " · " + (day.fails === 1 ? "un échec" : day.fails + " échecs") : "")
      + ". Tout est calme maintenant.";
    return "Rien ne tourne. Les plateaux sont libres — profites-en.";
  }

  function renderPrinters() {
    var s = printerShell();
    if (!loaded.printers) {
      s.skel.hidden = false; s.empty.hidden = true; s.floor.hidden = true; s.rail.hidden = true;
      if (s.mini) s.mini.hidden = true;
      if (ui.say) ui.say.hidden = true;
      return;
    }
    s.skel.hidden = true;
    var list = data.printers || [];
    s.empty.hidden = list.length > 0;
    s.grid.hidden = list.length === 0;
    s.floor.hidden = list.length === 0;
    s.rail.hidden = list.length === 0;
    if (s.mini && list.length === 0) s.mini.hidden = true;
    if (list.length) { renderFloor(s, list); renderActivity(s); }
    if (ui.say) {
      var mood = elseaMood(list);
      ui.say.hidden = false;
      ui.say.textContent = elseaSays(list);
      ui.say.className = "p3d-say" + (mood ? " is-" + mood : "");
    }
    var farm = s.farm || (s.farm = h("div", { class: "p3d-farm" }));
    if (!farm.isConnected) ui.panes.printers.append(farm);
    farm.innerHTML = "";
    var queue = Array.isArray(data.queue) ? data.queue : [];
    var maint = Array.isArray(data.maintenance) ? data.maintenance : [];
    if (queue.length) {
      var qBox = h("div", { class: "p3d-printbox" }, [h("span", { class: "p3d-kicker", text: "File d'atelier (" + queue.length + ")" })]);
      queue.forEach(function (q) {
        qBox.append(h("div", { class: "p3d-spool-row" }, [
          h("span", { text: q.name + " · plateau " + q.plate + (q.printer_id && q.printer_id !== "auto" ? " · " + q.printer_id : " · auto") }),
          h("div", { class: "p3d-ctl-row" }, [
            h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Lancer maintenant", onclick: function () {
              post("/api/print3d/queue/dispatch", { id: q.id }).then(function () { toast("Job lancé depuis la file"); return refresh(); }).catch(function (e) { toast(e.message, "err"); });
            } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Retirer", onclick: function () {
              post("/api/print3d/queue/delete", { id: q.id }).then(refresh).catch(function (e) { toast(e.message, "err"); });
            } }),
          ]),
        ]));
      });
      farm.append(qBox);
    }
    if (maint.length && maint.some(function (m) { return m.total_hours > 0 || (m.due && m.due.length); })) {
      var mBox = h("div", { class: "p3d-printbox" }, [h("span", { class: "p3d-kicker", text: "Entretien machines" })]);
      maint.forEach(function (m) {
        mBox.append(h("div", { class: "p3d-spool-row" }, [
          h("span", { text: m.printer_name + " · " + m.total_hours + " h total (buse " + m.nozzle_hours + "h · axes " + m.lube_hours + "h · plateau " + m.clean_hours + "h)" }),
          m.due && m.due.length ? h("strong", { class: "p3d-warn", text: m.due.join(" · ") }) : null,
          h("div", { class: "p3d-ctl-row" }, [
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Plateau", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "clean" }).then(refresh); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Axes", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "lube" }).then(refresh); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Buse", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "nozzle" }).then(refresh); } }),
          ]),
        ]));
      });
      farm.append(mBox);
    }
    var seen = {};
    list.forEach(function (p, i) {
      seen[p.id] = true;
      var v = printerViews[p.id];
      if (!v) { v = printerView(p); printerViews[p.id] = v; }
      v.update(p);
      var at = s.grid.children[i];
      if (at !== v.el) s.grid.insertBefore(v.el, at || null);
    });
    Object.keys(printerViews).forEach(function (id) {
      if (seen[id]) return;
      printerViews[id].el.remove();
      delete printerViews[id];
      delete liveCams[id];
    });
    if (printerRoom) {
      var focused = list.find(function (p) { return p.id === printerRoom.id; });
      if (focused) updatePrinterRoom(focused); else closeOverlay();
    }
    renderHistory(s);
    if (miniSync) miniSync();
  }

  function renderHistory(s) {
    var jobs = data.history || [];
    var sig = jobs.map(function (j) {
      return [j.id, j.outcome, j.at, j.filament && j.filament.g, j.problems && j.problems.length].join("¦");
    }).join("§");
    s.hist.hidden = !jobs.length;
    if (sig === historySig) return;               // a poll that changed nothing touches nothing
    historySig = sig;
    var top = jobs[0] ? jobs[0].id : "";
    var fresh = !!top && historyTop != null && top !== historyTop;   // only a newly recorded job slides in
    historyTop = top;
    if (fresh) loadJobs();                                           // a finished job changes the reliability count
    s.list.innerHTML = "";
    jobs.forEach(function (j, i) {
      s.list.append(h("li", { class: "is-" + j.outcome + (i === 0 && fresh ? " is-new" : "") }, [
        h("strong", { text: j.job || "Impression" }),
        " · " + (j.printer_name || "") + " · " + ({ finished: "terminé", failed: "échec", stopped: "arrêté" }[j.outcome] || j.outcome)
          + (j.duration_sec ? " · " + fmtDur(j.duration_sec) : "")
          + (j.filament ? " · ≈ " + fmtGrams(j.filament.g) + (typeof j.filament.cost === "number" ? " · " + money(j.filament.cost, (data.config.filament || {}).currency) : "") : "")
          + " · " + fmtAgo(j.at),
        (j.problems && j.problems.length) ? h("div", { class: "p3d-why", text: j.problems[0].code + " — " + j.problems[0].text }) : null,
      ]));
    });
  }

  // ── models ──
  var searchTimer = 0;
  function modelsQuery() {
    var q = new URLSearchParams();
    if (models.q) q.set("q", models.q);
    if (models.origin) q.set("origin", models.origin);
    if (models.tag) q.set("tag", models.tag);
    return q.toString();
  }
  function loadModels(force, more) {
    var qs = modelsQuery();
    var offset = more ? models.list.length : 0;
    if (!force && !more && loaded.models && models.key === qs && Date.now() - models.at < MODELS_TTL_MS) {
      modelsToken += 1;                           // a reply for an older query must not land on this cached view
      renderModels();                             // same query, still fresh: no request
      return Promise.resolve();
    }
    var token = ++modelsToken;
    return api("/api/print3d/models?" + qs + (offset ? "&offset=" + offset : "")).then(function (res) {
      if (token !== modelsToken) return;          // a newer query already answered
      var rows = res.models || [];
      models.list = more ? models.list.concat(rows) : rows;
      syncStudioSourceVersions(rows);
      models.tags = res.tags || [];
      models.total = res.total;
      models.indexed = res.indexed;
      models.key = qs;
      models.at = Date.now();
      if (!rows.length) models.total = models.list.length;   // a page asked past the end
      loaded.models = true;
      renderModels();
    }).catch(function (e) {
      if (token !== modelsToken) return;
      ui.panes.models.textContent = "Bibliothèque illisible : " + e.message;
    });
  }

  var MODEL_ACCEPT = ".stl,.glb,.3mf,.gcode,.gx,.step,.stp,.obj,.f3d,.scad,.fcstd,.blend";
  var MODEL_ALLOWED_EXT = { stl: 1, glb: 1, "3mf": 1, gcode: 1, gx: 1, step: 1, stp: 1, obj: 1, f3d: 1, scad: 1, fcstd: 1, blend: 1 };
  function extOfName(name) {
    var s = String(name || "").trim();
    var dot = s.lastIndexOf(".");
    return dot >= 0 ? s.slice(dot + 1).toLowerCase() : "";
  }

  function showUpload(text, pct) {
    if (!uploadEls || !uploadEls.bar.parentNode) return;
    uploadEls.bar.hidden = false;
    uploadEls.bar.classList.remove("is-error");
    uploadEls.fill.style.width = Math.max(0, Math.min(100, pct || 0)).toFixed(1) + "%";
    uploadEls.label.textContent = text;
    if (uploadEls.cancel) uploadEls.cancel.hidden = false;
  }
  function hideUpload() {
    if (!uploadEls) return;
    uploadEls.bar.hidden = true;
    uploadEls.bar.classList.remove("is-error");
    uploadEls.label.textContent = "";
    if (uploadEls.cancel) uploadEls.cancel.hidden = true;
  }
  function cancelUpload() { if (uploadCtl) uploadCtl.abort(); }

  function uploadFiles(files, opts) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (uploadBusy) { toast("Un envoi est déjà en cours", "err"); return; }
    uploadBusy = true;
    uploadCtl = typeof AbortController === "function" ? new AbortController() : null;
    var signal = uploadCtl ? uploadCtl.signal : undefined;
    var uploadedInfos = [];
    function reportProgress(msg, pct) {
      showUpload(msg, pct);
      if (opts && typeof opts.onProgress === "function") opts.onProgress(msg, pct);
    }
    function aborted() { return !!(signal && signal.aborted); }
    function cancelError() { var e = new Error("Téléversement annulé"); e.name = "AbortError"; return e; }
    var chain = Promise.resolve();
    list.forEach(function (file, i) {
      chain = chain.then(function () {
        if (aborted()) throw cancelError();
        reportProgress("Envoi " + (i + 1) + "/" + list.length + " · " + file.name, 0);
        return post("/api/upload/init", { name: file.name, size: file.size, folder: "Print" }).then(function (init) {
          var size = init.chunk || 2 * 1024 * 1024, offset = 0, index = 0;
          function sendChunk(buf, idx, tries) {
            tries = tries || 0;
            return fetch("/api/upload/chunk", { method: "POST", credentials: "same-origin", signal: signal,
              headers: { "Content-Type": "application/octet-stream", "X-Upload-Id": init.id, "X-Chunk-Index": String(idx) },
              body: buf }).then(function (r) {
              if (r.ok) return null;
              return r.json().catch(function () { return {}; }).then(function (d) {
                var e = new Error(d.error || "Envoi échoué"); e.status = r.status; throw e;
              });
            }).catch(function (e) {
              // A 300 MB file is 150 chunks: one dropped connection must not throw the whole upload away.
              // Only a transport failure or a gateway blip retries: 4xx and 507 (disk full) are answers.
              var retryable = !e || !e.status || e.status === 502 || e.status === 503 || e.status === 504;
              if (aborted() || tries >= 1 || !retryable) throw e;
              return new Promise(function (res) { setTimeout(res, 400); }).then(function () { return sendChunk(buf, idx, tries + 1); });
            });
          }
          function next() {
            if (aborted()) throw cancelError();
            if (offset >= file.size) {
              return post("/api/upload/complete", { id: init.id }).then(function (done) {
                uploadedInfos.push({
                  fileName: file.name,
                  name: (done && done.name) || file.name,
                  rel: (done && done.rel) || "",
                });
                return done;
              });
            }
            var share = file.size ? offset / file.size : 0;
            reportProgress("Envoi " + (i + 1) + "/" + list.length + " · " + file.name + " · "
              + Math.round(share * 100) + " %", share * 100);
            return file.slice(offset, offset + size).arrayBuffer().then(function (buf) {
              return sendChunk(buf, index).then(function () {
                offset += buf.byteLength; index += 1;
                return next();
              });
            });
          }
          return next();
        });
      });
    });
    chain.then(function () {
      uploadBusy = false; uploadCtl = null;
      hideUpload();
      toast(list.length + " fichier(s) ajouté(s) dans Print");
      if (opts && typeof opts.onDone === "function") return opts.onDone(uploadedInfos);
      return loadModels(true);
    }).catch(function (e) {
      // Keep the bar on screen with the reason: a big file that fails must say why, not just toast.
      uploadBusy = false; uploadCtl = null;
      var stopped = e && e.name === "AbortError";
      if (uploadEls && uploadEls.bar.parentNode) {
        uploadEls.bar.hidden = false;
        uploadEls.bar.classList.toggle("is-error", !stopped);
        uploadEls.fill.style.width = "0%";
        uploadEls.label.textContent = stopped ? "Téléversement annulé" : "Échec : " + e.message;
        if (uploadEls.cancel) uploadEls.cancel.hidden = true;
      }
      if (opts && typeof opts.onError === "function") opts.onError(e, stopped);
      toast(stopped ? "Téléversement annulé" : e.message, stopped ? "ok" : "err");
    });
  }

  // One tile per model, reused while its content signature holds: a search that returns the same
  // models moves nodes instead of rebuilding them (and their thumbnails).
  function modelTile(m) {
    var sig = [m.name, m.size, m.folder, m.origin || "", (m.tags || []).join("|"), m.has_thumb ? 1 : 0,
      m.mw ? m.mw.downloads + "," + m.mw.prints + "," + (m.mw.change_7d || [])[0] : ""].join("\u0001");
    var old = modelTiles[m.id];
    if (old && old.sig === sig) return old.el;
    var visual = m.has_thumb
      ? h("img", { loading: "lazy", decoding: "async", alt: "", src: "/api/print3d/models/thumb?id=" + encodeURIComponent(m.id),
        onerror: function () { this.replaceWith(h("span", { class: "p3d-ext", text: m.ext.toUpperCase() })); } })
      : h("span", { class: "p3d-ext", text: m.ext.toUpperCase() });
    var tagsOnCard = (m.tags || []).slice(0, 3);
    var el = h("button", { type: "button", class: "p3d-model", "data-id": m.id, onclick: function () { openModel(m.id); } }, [
      h("div", { class: "p3d-model-visual" }, [visual]),
      h("strong", { text: m.name }),
      h("span", { class: "p3d-meta", text: (m.folder ? m.folder + " · " : "") + fmtBytes(m.size) }),
      m.origin ? h("span", { class: "p3d-origin is-" + m.origin, text: ORIGIN_LABEL[m.origin] }) : null,
      tagsOnCard.length ? h("span", { class: "p3d-modeltags", text: tagsOnCard.join(" · ") }) : null,
      m.mw ? h("span", { class: "p3d-meta p3d-mwline", text: "MakerWorld · ↓ " + fmtInt(m.mw.downloads) + " · ⎙ " + fmtInt(m.mw.prints) + (m.mw.change_7d && m.mw.change_7d[0] > 0 ? " · +" + m.mw.change_7d[0] + " / 7 j" : "") }) : null,
    ]);
    modelTiles[m.id] = { el: el, sig: sig };
    return el;
  }

  function buildModelsShell(pane) {
    var fileInput = h("input", { type: "file", multiple: true, hidden: true,
      accept: MODEL_ACCEPT,
      onchange: function () { uploadFiles(fileInput.files); fileInput.value = ""; } });
    var search = h("input", { id: "p3d-q", type: "search", class: "p3d-input",
      placeholder: "Chercher un modèle, un dossier, une étiquette…", value: models.q,
      oninput: function () {
        models.q = search.value; clearTimeout(searchTimer); searchTimer = setTimeout(function () { loadModels(); }, 250);
      } });
    var origin = h("select", { class: "p3d-input", onchange: function () { models.origin = origin.value; loadModels(); } }, [
      h("option", { value: "", text: "Toutes origines" }),
    ].concat(Object.keys(ORIGIN_LABEL).map(function (k) { return h("option", { value: k, text: ORIGIN_LABEL[k] }); })));
    origin.value = models.origin;
    var sort = h("select", { class: "p3d-input", "aria-label": "Tri", onchange: function () { models.sort = sort.value; renderModels(); } }, [
      h("option", { value: "recent", text: "Récents" }), h("option", { value: "name", text: "Nom" })]);
    sort.value = models.sort;
    var upFill = h("span");
    var upLabel = h("span", { class: "p3d-meta" });
    var upCancel = h("button", { type: "button", class: "p3d-btn is-small", hidden: true, text: "Annuler", onclick: cancelUpload });
    var uploadBar = h("div", { class: "p3d-upload", hidden: true }, [
      h("div", { class: "p3d-upload-track" }, [upFill]),
      h("div", { class: "p3d-upload-row" }, [upLabel, upCancel])]);
    uploadEls = { bar: uploadBar, fill: upFill, label: upLabel, cancel: upCancel };
    var tags = h("div", { class: "p3d-tags", hidden: true });
    var meta = h("p", { class: "p3d-meta" });
    var grid = h("div", { class: "p3d-models" });
    var empty = h("p", { class: "p3d-empty", hidden: true,
      text: "Aucun modèle. Dépose des .stl / .3mf dans Print ou ajoute un dossier dans Réglages." });
    var more = h("button", { type: "button", class: "p3d-btn p3d-more", hidden: true,
      onclick: function () { loadModels(false, true); } });
    pane.innerHTML = "";
    pane.append(h("div", { class: "p3d-toolbar" }, [search, origin, sort,
      h("button", { type: "button", class: "p3d-btn", text: "Ajouter des fichiers", onclick: function () { fileInput.click(); } }),
      h("button", { type: "button", class: "p3d-btn", text: "Réindexer", onclick: function (e) {
        busyRun(e.target, "Réindexation…", function () {
          return post("/api/print3d/models/rescan").then(function () { return loadModels(true); });
        }).catch(function (err) { toast(err.message, "err"); });
      } }),
      uploadBar, fileInput]), tags, meta, grid, empty, more);
    modelsShell = { pane: pane, grid: grid, tags: tags, meta: meta, more: more, empty: empty, tagsSig: "" };
  }

  function renderModels() {
    var pane = ui.panes.models;
    if (!loaded.models && !models.list.length) {
      pane.innerHTML = "";
      modelsShell = null;
      pane.append(skeletonRows(4));
      return;
    }
    if (!modelsShell || modelsShell.pane !== pane) buildModelsShell(pane);
    var list = models.list.slice();
    list.sort(models.sort === "name"
      ? function (a, b) { return a.name.localeCompare(b.name, "fr-CA"); }
      : function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    var grid = modelsShell.grid;
    var kids = Array.prototype.slice.call(grid.children);
    var farm = s.farm || (s.farm = h("div", { class: "p3d-farm" }));
    if (!farm.isConnected) ui.panes.printers.append(farm);
    farm.innerHTML = "";
    var queue = Array.isArray(data.queue) ? data.queue : [];
    var maint = Array.isArray(data.maintenance) ? data.maintenance : [];
    if (queue.length) {
      var qBox = h("div", { class: "p3d-printbox" }, [h("span", { class: "p3d-kicker", text: "File d'atelier (" + queue.length + ")" })]);
      queue.forEach(function (q) {
        qBox.append(h("div", { class: "p3d-spool-row" }, [
          h("span", { text: q.name + " · plateau " + q.plate + (q.printer_id && q.printer_id !== "auto" ? " · " + q.printer_id : " · auto") }),
          h("div", { class: "p3d-ctl-row" }, [
            h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Lancer maintenant", onclick: function () {
              post("/api/print3d/queue/dispatch", { id: q.id }).then(function () { toast("Job lancé depuis la file"); return refresh(); }).catch(function (e) { toast(e.message, "err"); });
            } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Retirer", onclick: function () {
              post("/api/print3d/queue/delete", { id: q.id }).then(refresh).catch(function (e) { toast(e.message, "err"); });
            } }),
          ]),
        ]));
      });
      farm.append(qBox);
    }
    if (maint.length && maint.some(function (m) { return m.total_hours > 0 || (m.due && m.due.length); })) {
      var mBox = h("div", { class: "p3d-printbox" }, [h("span", { class: "p3d-kicker", text: "Entretien machines" })]);
      maint.forEach(function (m) {
        mBox.append(h("div", { class: "p3d-spool-row" }, [
          h("span", { text: m.printer_name + " · " + m.total_hours + " h total (buse " + m.nozzle_hours + "h · axes " + m.lube_hours + "h · plateau " + m.clean_hours + "h)" }),
          m.due && m.due.length ? h("strong", { class: "p3d-warn", text: m.due.join(" · ") }) : null,
          h("div", { class: "p3d-ctl-row" }, [
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Plateau", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "clean" }).then(refresh); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Axes", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "lube" }).then(refresh); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "RAZ Buse", onclick: function () { post("/api/print3d/maintenance/reset", { printer_id: m.printer_id, kind: "nozzle" }).then(refresh); } }),
          ]),
        ]));
      });
      farm.append(mBox);
    }
    var seen = {};
    list.forEach(function (m, i) {
      var el = modelTile(m);
      seen[m.id] = true;
      if (kids[i] !== el) grid.insertBefore(el, kids[i] || null);
    });
    kids.forEach(function (el) {
      if (!seen[el.getAttribute("data-id")] && el.parentNode === grid) grid.removeChild(el);
    });
    Object.keys(modelTiles).forEach(function (id) { if (!seen[id]) delete modelTiles[id]; });
    modelsShell.empty.hidden = list.length > 0;
    var tsig = models.tags.slice(0, 30).map(function (t) { return t[0] + ":" + t[1]; }).join("|") + "#" + models.tag;
    if (tsig !== modelsShell.tagsSig) {
      modelsShell.tagsSig = tsig;
      modelsShell.tags.innerHTML = "";
      models.tags.slice(0, 30).forEach(function (t) {
        modelsShell.tags.append(h("button", { type: "button", class: "p3d-tag" + (models.tag === t[0] ? " is-on" : ""),
          text: t[0] + " · " + t[1],
          onclick: function () { models.tag = models.tag === t[0] ? "" : t[0]; loadModels(); } }));
      });
      modelsShell.tags.hidden = !models.tags.length;
    }
    modelsShell.meta.textContent = (models.total || 0) + " modèle(s) sur " + (models.indexed || 0) + " indexé(s)"
      + (models.list.length < (models.total || 0) ? " · " + models.list.length + " affiché(s)" : "")
      + " · dossier Print et dossier supplémentaire";
    var rest = (models.total || 0) - models.list.length;
    modelsShell.more.hidden = rest <= 0;
    if (rest > 0) modelsShell.more.textContent = "Afficher plus (" + rest + " restant(s))";
  }

  // The list is brief (no notes): the sheet reads the full record once it knows which model it shows.
  function openModel(id) {
    var token = ++previewToken;
    var brief = models.list.find(function (x) { return x.id === id; }) || { id: id, name: "Modèle", ext: "" };
    openOverlay(h("div", { class: "p3d-model-detail" }, [
      h("h3", { text: brief.name }),
      h("p", { class: "p3d-meta", text: "Chargement…" })]));
    api("/api/print3d/models/get?id=" + encodeURIComponent(id)).then(function (res) {
      if (token !== previewToken) return;
      openOverlay(modelDetail(res.model || brief, token));
    }).catch(function (e) {
      if (token !== previewToken) return;
      // Never open the editor on a partial record: saving it would blank the notes.
      openOverlay(h("div", { class: "p3d-model-detail" }, [
        h("h3", { text: brief.name }),
        h("p", { class: "p3d-warn", text: e.status === 404
          ? "Éditeur indisponible : ce pont n'a pas encore la route du modèle. Redémarre le pont, puis rouvre l'atelier."
          : e.message })]));
    });
  }

  // Read only what is needed to decide: a binary STL states its triangle count in the first 84 bytes,
  // so a model the viewer will refuse is never downloaded in full.
  function probeStl(chunks) {
    var head = new Uint8Array(STL_PROBE_BYTES), at = 0;
    for (var i = 0; i < chunks.length && at < STL_PROBE_BYTES; i++) {
      var take = Math.min(chunks[i].length, STL_PROBE_BYTES - at);
      head.set(chunks[i].subarray(0, take), at);
      at += take;
    }
    if (at < STL_PROBE_BYTES) return null;
    var ascii = head[0] === 0x73 && head[1] === 0x6f && head[2] === 0x6c && head[3] === 0x69 && head[4] === 0x64; // "solid"
    var count = new DataView(head.buffer).getUint32(80, true);
    if (ascii) return null;                       // text STL: let the parser decide
    return count > STL_MAX_TRIANGLES ? "too-many" : null;
  }
  function tooManyStl() {
    return new Error("Aperçu ignoré : plus de " + fmtInt(STL_MAX_TRIANGLES)
      + " triangles (téléchargement interrompu). Le fichier reste téléchargeable.");
  }
  function extractResponseModelVersion(r) {
    if (!r || !r.headers || typeof r.headers.get !== "function") return "";
    var hdr = r.headers.get("X-Model-Sha256") || r.headers.get("ETag") || "";
    return String(hdr).replace(/^["']+|["']+$/g, "").trim();
  }
  function attachBufferVersion(buf, ver) {
    if (ver && buf && typeof buf === "object") {
      try { Object.defineProperty(buf, "_hqVersion", { value: ver, configurable: true }); } catch (_) {}
    }
    return buf;
  }
  function readStlBody(r, probe, opts) {
    var signal = opts && opts.signal;
    var onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    var lenHdr = r.headers && typeof r.headers.get === "function" ? Number(r.headers.get("Content-Length") || 0) : 0;
    var modelVer = extractResponseModelVersion(r);
    if (!r.body || typeof r.body.getReader !== "function") {
      return r.arrayBuffer().then(function (buf) {
        if (onProgress) onProgress({ loaded: buf.byteLength, total: buf.byteLength });
        return attachBufferVersion(buf, modelVer);
      });
    }
    var reader = r.body.getReader(), chunks = [], size = 0, probed = !probe;
    function pull() {
      if (signal && signal.aborted) {
        try { reader.cancel(); } catch (_) {}
        var ab = new Error("Aborted"); ab.name = "AbortError";
        return Promise.reject(ab);
      }
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(size), at = 0;
          chunks.forEach(function (c) { out.set(c, at); at += c.length; });
          return attachBufferVersion(out.buffer, modelVer);
        }
        chunks.push(step.value);
        size += step.value.length;
        if (onProgress) onProgress({ loaded: size, total: lenHdr > 0 ? lenHdr : 0 });
        if (!probed && size >= STL_PROBE_BYTES) {
          probed = true;
          if (probeStl(chunks) === "too-many") {
            try { reader.cancel(); } catch (_) {}
            throw tooManyStl();
          }
        }
        return pull();
      });
    }
    return pull();
  }
  function fetchFullStl(url, opts) {
    var fetchOpts = { credentials: "same-origin", cache: "no-store" };
    if (opts && opts.signal) fetchOpts.signal = opts.signal;
    return fetch(url, fetchOpts).then(function (r) {
      if (!r.ok) throw new Error("Fichier illisible");
      return readStlBody(r, false, opts);
    });
  }
  function fetchStl(url, opts) {
    // Ask for the header before the body. A Range-capable server sends 84 bytes, so an
    // oversized model is refused without a full transfer; a server that ignores Range
    // returns 200 and the streaming fallback still stops after the same probe.
    var range = "bytes=0-" + (STL_PROBE_BYTES - 1);
    var fetchOpts = { credentials: "same-origin", cache: "no-store", headers: { "Range": range } };
    if (opts && opts.signal) fetchOpts.signal = opts.signal;
    return fetch(url, fetchOpts).then(function (r) {
      if (r.status === 416) return fetchFullStl(url, opts);
      if (!r.ok) throw new Error("Fichier illisible");
      if (r.status === 206) {
        if (typeof r.arrayBuffer !== "function") return fetchFullStl(url, opts);
        return r.arrayBuffer().then(function (head) {
          if (probeStl([new Uint8Array(head)]) === "too-many") throw tooManyStl();
          return fetchFullStl(url, opts);
        });
      }
      return readStlBody(r, true, opts);
    });
  }

  function positiveNumber(v) { return typeof v === "number" && isFinite(v) && v > 0; }
  function fmtMm(v) { return Math.abs(v - Math.round(v)) < 0.05 ? num(v, 0) : num(v, 1); }

  // A printer's plate, from Réglages when the Master entered one, else a known default. The
  // model detail only compares dimensions: it never claims the part is placed correctly.
  function printerBed(p) {
    if (!p) return null;
    var b = p.bed;
    if (b && typeof b === "object" && positiveNumber(Number(b.x)) && positiveNumber(Number(b.y))
        && positiveNumber(Number(b.z))) return { x: Number(b.x), y: Number(b.y), z: Number(b.z) };
    var caps = printerCaps(p);
    if (caps && caps.bed) return { x: Number(caps.bed.x), y: Number(caps.bed.y), z: Number(caps.bed.z) };
    var text = (String(p.model || "") + " " + String(p.name || "") + " " + String(p.kind || "")).trim();
    for (var i = 0; i < BED_PRESETS.length; i++) {
      if (BED_PRESETS[i].re.test(text)) return { x: BED_PRESETS[i].x, y: BED_PRESETS[i].y, z: BED_PRESETS[i].z };
    }
    return null;
  }

  function configuredBeds() {
    var out = [], seen = {};
    ((data.config || {}).printers || []).forEach(function (p) {
      var b = printerBed(p);
      if (!b) return;
      var key = b.x + "/" + b.y + "/" + b.z;
      if (seen[key]) return;                    // two A1 minis do not need two identical lines
      seen[key] = true;
      out.push({ name: p.name || "Imprimante", bed: b });
    });
    return out;
  }

  // Pure preflight: dimensions from the parsed bounds, solid volume from the parsed mesh. The
  // cost uses the configured PLA price; no slicer, infill, supports or purge is modelled.
  function meshPreflight(parsed, bed, fil) {
    var b = parsed && parsed.bounds;
    if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) return null;
    var dims = [0, 1, 2].map(function (i) { return Number(b.max[i]) - Number(b.min[i]); });
    if (!dims.every(function (v) { return isFinite(v) && v >= 0; })) return null;
    var volume = positiveNumber(parsed.volume_mm3) ? parsed.volume_mm3 : 0;
    var f = fil || {}, material = "PLA";
    var grams = volume > 0 ? (volume / 1000) * FILAMENT_DENSITY[material] : null;
    var prices = f.prices || {};
    var priceKg = positiveNumber(Number(prices[material])) ? Number(prices[material]) : null;
    if (priceKg == null && positiveNumber(Number(f.default_price_kg))) priceKg = Number(f.default_price_kg);
    var cost = grams != null && priceKg != null ? grams / 1000 * priceKg : null;
    var fit = null;
    if (bed && positiveNumber(Number(bed.x)) && positiveNumber(Number(bed.y)) && positiveNumber(Number(bed.z))) {
      var bx = Number(bed.x), by = Number(bed.y), bz = Number(bed.z);
      var flat = dims[0] <= bx + 1e-6 && dims[1] <= by + 1e-6;
      var turned = dims[0] <= by + 1e-6 && dims[1] <= bx + 1e-6;  // a 90° turn around Z is free
      var height = dims[2] <= bz + 1e-6;
      var over = "";
      if (!height) over = "Z " + fmtMm(dims[2]) + " > " + fmtMm(bz) + " mm";
      else if (!flat && !turned) over = "X/Y " + fmtMm(dims[0]) + " × " + fmtMm(dims[1])
        + " > " + fmtMm(Math.max(bx, by)) + " × " + fmtMm(Math.min(bx, by)) + " mm";
      fit = { ok: (flat || turned) && height, rotated: !flat && turned, over: over };
    }
    return { dims: dims, volume_mm3: volume, grams: grams, cost: cost, material: material,
      price_kg: priceKg, currency: f.currency || "$", fit: fit };
  }

  function renderPreflight(box, parsed) {
    var beds = configuredBeds(), choice = null, body = h("div", { class: "p3d-preflight-body" });
    box.innerHTML = "";
    box.append(h("h4", { text: "Préflight du maillage" }));
    if (beds.length > 1) {
      choice = h("select", { class: "p3d-input", "aria-label": "Plateau de référence" },
        beds.map(function (r, i) {
          return h("option", { value: String(i), text: r.name + " · " + fmtMm(r.bed.x) + " × " + fmtMm(r.bed.y) + " × " + fmtMm(r.bed.z) + " mm" });
        }));
      choice.addEventListener("change", paint);
      box.append(h("label", { class: "p3d-preflight-bed" }, ["Plateau de référence", choice]));
    }
    box.append(body);
    function paint() {
      var index = choice ? Number(choice.value) || 0 : 0;
      var ref = beds[index] || null;
      var bed = ref ? ref.bed : null;
      var info = meshPreflight(parsed, bed, (data.config || {}).filament);
      body.innerHTML = "";
      if (!info) { body.append(h("p", { class: "p3d-warn", text: "Préflight impossible : dimensions du maillage illisibles." })); return; }
      body.append(h("p", { class: "p3d-preflight-dims",
        text: "Encombrement : " + info.dims.map(fmtMm).join(" × ") + " mm" }));
      if (ref) {
        var fit = info.fit;
        body.append(h("p", { class: "p3d-preflight-fit" + (fit && fit.ok ? " is-ok" : fit ? " is-over" : ""),
          text: "Plateau " + ref.name + " · " + fmtMm(bed.x) + " × " + fmtMm(bed.y) + " × " + fmtMm(bed.z) + " mm : "
            + (fit ? (fit.ok ? "tient" : "dépasse") + (fit.over ? " (" + fit.over + ")" : "") : "non vérifiable") }));
      } else {
        body.append(h("p", { class: "p3d-warn", text: "Aucun plateau configuré : ajoute X/Y/Z dans Réglages." }));
      }
      var estimate = "Estimation matière : ";
      if (info.grams == null) estimate += "volume intérieur non calculable (maillage ouvert ou dégénéré).";
      else estimate += "≈ " + num(info.grams, 1) + " g " + info.material + " (volume plein, sans supports)";
      if (info.cost != null) estimate += " · coût ≈ " + money(info.cost, info.currency);
      else if (info.grams != null) estimate += " · coût non estimé (prix du PLA à renseigner dans Filament)";
      body.append(h("p", { class: "p3d-preflight-est", text: estimate }));
      body.append(h("p", { class: "p3d-preflight-help",
        text: "Estimation seulement : dimensions du maillage (mm supposés), volume plein sans supports ni purge ; orientation et position sur le plateau ne sont pas vérifiées." }));
    }
    paint();
    box.hidden = false;
  }

  function mountGcode2dFallback(wrap, modelId, plate, bed, reasonMsg, onRetry3d) {
    wrap.replaceChildren();
    if (reasonMsg) {
      wrap.append(h("p", { class: "p3d-gcode-notice", text: reasonMsg }));
    }
    var status = h("p", { class: "p3d-meta", text: "Chargement de l'aperçu 2D échantillonné…" });
    wrap.append(status);
    if (onRetry3d) {
      wrap.append(h("div", { class: "p3d-ctl-row" }, [
        h("button", { type: "button", class: "p3d-btn is-small", text: "Revenir à la vue 3D", onclick: onRetry3d }),
      ]));
    }
    var cancelled = false;
    api("/api/print3d/models/layers?id=" + encodeURIComponent(modelId) + "&plate=" + encodeURIComponent(String(plate || 1)))
      .then(function (lr) {
        if (cancelled) return;
        status.remove();
        var layers = lr.layers || [], bounds = lr.bounds || [0, 0, (bed && bed.x) || 256, (bed && bed.y) || 256];
        if (!layers.length) {
          wrap.append(h("p", { class: "p3d-help", text: "Aucune couche détectée dans ce fichier." }));
          return;
        }
        var cvs = h("canvas", { class: "p3d-gcode-cvs", width: "480", height: "360" });
        var lbl = h("span", { class: "p3d-meta" });
        var slider = h("input", { type: "range", class: "p3d-gcode-slider", min: "0", max: String(layers.length - 1), value: String(layers.length - 1), "aria-label": "Couche 2D" });
        var colorMode2d = "type";
        function drawLayer(idx) {
          var lay = layers[idx];
          lbl.textContent = "Couche " + (idx + 1) + " / " + layers.length + " · Z = " + lay.z + " mm (aperçu 2D échantillonné)";
          if (typeof cvs.getContext !== "function") return;
          var ctx = cvs.getContext("2d");
          ctx.clearRect(0, 0, cvs.width, cvs.height);
          var span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 10);
          var pad = 20, scale = (Math.min(cvs.width, cvs.height) - pad * 2) / span;
          var ox = (cvs.width - (bounds[2] - bounds[0]) * scale) / 2;
          var oy = (cvs.height + (bounds[3] - bounds[1]) * scale) / 2;
          ctx.lineWidth = 1.6;
          (lay.paths || []).forEach(function (seg) {
            var pts = Array.isArray(seg) ? seg : (seg && seg.pts) || [];
            if (pts.length < 2) return;
            if (colorMode2d === "tool") {
              var eIdx = (seg && typeof seg.e === "number") ? seg.e : 0;
              ctx.strokeStyle = (studio.tools[eIdx] && studio.tools[eIdx].color) || "#38bdf8";
            } else {
              var t = seg && seg.t;
              ctx.strokeStyle = t === "outer" ? "#f97316" : t === "inner" ? "#fbbf24" : t === "support" ? "#22c55e" : t === "infill" ? "#8b5cf6" : "#06b6d4";
            }
            ctx.beginPath();
            ctx.moveTo(ox + (pts[0][0] - bounds[0]) * scale, oy - (pts[0][1] - bounds[1]) * scale);
            for (var i = 1; i < pts.length; i++) {
              ctx.lineTo(ox + (pts[i][0] - bounds[0]) * scale, oy - (pts[i][1] - bounds[1]) * scale);
            }
            ctx.stroke();
          });
        }
        slider.addEventListener("input", function () { drawLayer(Number(slider.value)); });
        var btnType = h("button", { type: "button", class: "p3d-tag is-on", text: "Type de ligne" });
        var btnTool = h("button", { type: "button", class: "p3d-tag", text: "Outils (T0–T3)" });
        btnType.addEventListener("click", function () {
          colorMode2d = "type"; btnType.classList.add("is-on"); btnTool.classList.remove("is-on"); drawLayer(Number(slider.value));
        });
        btnTool.addEventListener("click", function () {
          colorMode2d = "tool"; btnTool.classList.add("is-on"); btnType.classList.remove("is-on"); drawLayer(Number(slider.value));
        });
        wrap.append(cvs, h("div", { class: "p3d-ctl-row" }, [btnType, btnTool]), h("div", { class: "p3d-gcode-layer-row" }, [slider, lbl]));
        drawLayer(layers.length - 1);
      })
      .catch(function (e) {
        if (cancelled) return;
        status.textContent = e.message || "Aperçu 2D indisponible.";
      });
    return { dispose: function () { cancelled = true; } };
  }

  function mountGcodePreviewPanel(container, cfg) {
    var modelId = cfg.modelId;
    var plate = Number(cfg.plate || 1);
    var inspectInfo = cfg.inspectInfo || null;
    var printer = cfg.printer || null;
    var bed = cfg.bed || printerBed(printer) || { x: 256, y: 256, z: 256 };
    var toolColors = cfg.toolColors || studio.tools.map(function (t) { return t.color; });
    var isCompact = !!cfg.compact;
    var force2d = !!cfg.force2d || !window.HQGcode || typeof window.HQGcode.createGcodeViewer !== "function";

    var panel = h("div", { class: "p3d-gcode-panel" + (isCompact ? " is-compact" : "") });
    container.replaceChildren(panel);

    var fallbackCtl = null;
    var activeViewer = null;
    var panelDisposed = false;
    var panelSeq = 0;

    function cleanupCurrent() {
      if (fallbackCtl) { try { fallbackCtl.dispose(); } catch (_) {} fallbackCtl = null; }
      if (activeViewer) {
        try { activeViewer.dispose(); } catch (_) {}
        activeViewer = null;
      }
      if (typeof cfg.registerViewer === "function") cfg.registerViewer(null);
    }

    function show2d(reasonMsg, allowRetry) {
      cleanupCurrent();
      if (panelDisposed) return;
      fallbackCtl = mountGcode2dFallback(panel, modelId, plate, bed, reasonMsg, allowRetry ? function () {
        force2d = false;
        if (typeof cfg.onModeSwitch === "function") cfg.onModeSwitch(false);
        start3d();
      } : null);
      if (typeof cfg.registerViewer === "function") cfg.registerViewer(fallbackCtl);
    }

    function start3d() {
      cleanupCurrent();
      if (panelDisposed) return;
      if (!window.HQGcode || typeof window.HQGcode.createGcodeViewer !== "function") {
        show2d("Module 3D G-code non disponible — affichage 2D échantillonné.", false);
        return;
      }
      panel.replaceChildren();
      var seq = ++panelSeq;

      // View & plate toolbar
      var plateSel = null;
      var platesInfo = (inspectInfo && Array.isArray(inspectInfo.plates_info)) ? inspectInfo.plates_info : [];
      if (platesInfo.length > 1) {
        plateSel = h("select", { class: "p3d-input p3d-ctl-num", "aria-label": "Plateau G-code" }, platesInfo.map(function (pl) {
          return h("option", { value: String(pl.plate), text: "Plateau " + pl.plate });
        }));
        plateSel.value = String(plate);
        plateSel.addEventListener("change", function () {
          plate = Number(plateSel.value) || 1;
          if (typeof cfg.onPlateChange === "function") cfg.onPlateChange(plate);
          loadPlate(plate);
        });
      }

      var btnIso = h("button", { type: "button", class: "p3d-btn is-small", text: "Iso", onclick: function () { if (activeViewer) activeViewer.setView("iso"); } });
      var btnTop = h("button", { type: "button", class: "p3d-btn is-small", text: "Dessus", onclick: function () { if (activeViewer) activeViewer.setView("top"); } });
      var btnFront = h("button", { type: "button", class: "p3d-btn is-small", text: "Face", onclick: function () { if (activeViewer) activeViewer.setView("front"); } });
      var btnReset = h("button", { type: "button", class: "p3d-btn is-small", text: "Réinitialiser", onclick: function () { if (activeViewer) activeViewer.resetCamera(); } });
      var btn2d = h("button", { type: "button", class: "p3d-btn is-small", text: "Vue 2D (secours)", onclick: function () {
        if (typeof cfg.onModeSwitch === "function") cfg.onModeSwitch(true);
        show2d("Mode 2D échantillonné actif.", true);
      } });

      var camBar = h("div", { class: "p3d-gcode-toolbar" }, [
        plateSel,
        h("div", { class: "p3d-gcode-cam-btns" }, [btnIso, btnTop, btnFront, btnReset]),
        btn2d,
      ]);

      // Viewport
      var viewport = h("div", { class: "p3d-gcode-viewport" });
      var stageHost = h("div", { class: "p3d-gcode-stage-host" });
      var loaderBadge = h("div", { class: "p3d-gcode-loading", role: "status", "aria-live": "polite", text: "Chargement du G-code…" });
      var noticeBanner = h("p", { class: "p3d-gcode-notice", hidden: true });
      viewport.append(stageHost, loaderBadge);

      // Layer navigation controls
      var accumulated = true;
      var curStart = 0;
      var curEnd = 0;
      var totalLayers = 0;
      var btnAccum = h("button", { type: "button", class: "p3d-tag is-on", text: "Cumulé (0 → N)" });
      var btnSingle = h("button", { type: "button", class: "p3d-tag", text: "Couche seule" });
      var btnPrev = h("button", { type: "button", class: "p3d-btn is-small p3d-gcode-step", text: "−", "aria-label": "Couche précédente", disabled: true });
      var btnNext = h("button", { type: "button", class: "p3d-btn is-small p3d-gcode-step", text: "+", "aria-label": "Couche suivante", disabled: true });
      var layerSlider = h("input", { type: "range", class: "p3d-gcode-slider", min: "0", max: "0", value: "0", "aria-label": "Sélecteur de couche" });
      var layerLbl = h("span", { class: "p3d-meta p3d-gcode-layer-lbl", text: "Couche – / –" });

      var startInput = h("input", { type: "number", class: "p3d-input p3d-gcode-range-in", min: "1", max: "1", value: "1", "aria-label": "Couche de début" });
      var endInput = h("input", { type: "number", class: "p3d-input p3d-gcode-range-in", min: "1", max: "1", value: "1", "aria-label": "Couche de fin" });
      var rangeWrap = h("div", { class: "p3d-gcode-range-row" }, [
        h("label", {}, ["De", startInput]),
        h("label", {}, ["À", endInput]),
      ]);

      // Optional move-by-move segment scrubber
      var scrubChk = h("input", { type: "checkbox" });
      var scrubSlider = h("input", { type: "range", class: "p3d-gcode-slider", min: "0", max: "0", value: "0", disabled: true, "aria-label": "Progression des segments" });
      var scrubLbl = h("span", { class: "p3d-meta", text: "Tous les segments" });
      var scrubWrap = h("div", { class: "p3d-gcode-scrub-row", hidden: true }, [
        h("label", { class: "p3d-chk" }, [scrubChk, " Pas à pas"]),
        scrubSlider,
        scrubLbl,
      ]);

      function syncLayerUi() {
        if (!totalLayers) return;
        var maxIdx = totalLayers - 1;
        curEnd = Math.max(0, Math.min(maxIdx, curEnd));
        curStart = accumulated ? Math.max(0, Math.min(curEnd, curStart)) : curEnd;
        layerSlider.max = String(maxIdx);
        layerSlider.value = String(curEnd);
        startInput.max = String(totalLayers);
        endInput.max = String(totalLayers);
        startInput.value = String(curStart + 1);
        endInput.value = String(curEnd + 1);
        rangeWrap.hidden = !accumulated;
        btnPrev.disabled = curEnd <= 0;
        btnNext.disabled = curEnd >= maxIdx;
        var zVal = activeViewer ? activeViewer.getLayerZ(curEnd) : null;
        var zTxt = (typeof zVal === "number" && isFinite(zVal)) ? (" · Z = " + zVal.toFixed(2) + " mm") : "";
        var spanTxt = accumulated && curStart > 0
          ? ("Couches " + (curStart + 1) + "–" + (curEnd + 1) + " / " + totalLayers)
          : ("Couche " + (curEnd + 1) + " / " + totalLayers);
        layerLbl.textContent = spanTxt + zTxt;
        if (activeViewer) activeViewer.setLayerRange(curStart, curEnd);
      }

      btnAccum.addEventListener("click", function () {
        accumulated = true;
        curStart = 0;
        btnAccum.classList.add("is-on");
        btnSingle.classList.remove("is-on");
        syncLayerUi();
      });
      btnSingle.addEventListener("click", function () {
        accumulated = false;
        curStart = curEnd;
        btnSingle.classList.add("is-on");
        btnAccum.classList.remove("is-on");
        syncLayerUi();
      });
      btnPrev.addEventListener("click", function () {
        if (curEnd > 0) { curEnd -= 1; syncLayerUi(); }
      });
      btnNext.addEventListener("click", function () {
        if (curEnd < totalLayers - 1) { curEnd += 1; syncLayerUi(); }
      });
      layerSlider.addEventListener("input", function () {
        curEnd = Number(layerSlider.value) || 0;
        if (accumulated && curStart > curEnd) curStart = curEnd;
        syncLayerUi();
      });
      startInput.addEventListener("change", function () {
        var v = Math.max(1, Math.min(totalLayers || 1, Number(startInput.value) || 1)) - 1;
        curStart = Math.min(v, curEnd);
        syncLayerUi();
      });
      endInput.addEventListener("change", function () {
        var v = Math.max(1, Math.min(totalLayers || 1, Number(endInput.value) || 1)) - 1;
        curEnd = Math.max(curStart, v);
        syncLayerUi();
      });

      scrubChk.addEventListener("change", function () {
        scrubSlider.disabled = !scrubChk.checked;
        if (!activeViewer) return;
        if (!scrubChk.checked) {
          activeViewer.setScrub(null);
          scrubLbl.textContent = "Tous les segments";
        } else {
          var v = Number(scrubSlider.value) || 0;
          activeViewer.setScrub(v);
          scrubLbl.textContent = "Segment " + fmtInt(v + 1) + " / " + fmtInt(Number(scrubSlider.max) + 1);
        }
      });
      scrubSlider.addEventListener("input", function () {
        if (!activeViewer || !scrubChk.checked) return;
        var v = Number(scrubSlider.value) || 0;
        activeViewer.setScrub(v);
        scrubLbl.textContent = "Segment " + fmtInt(v + 1) + " / " + fmtInt(Number(scrubSlider.max) + 1);
      });

      var layerBox = h("div", { class: "p3d-gcode-layers" }, [
        h("div", { class: "p3d-gcode-layer-modes" }, [btnAccum, btnSingle, layerLbl]),
        h("div", { class: "p3d-gcode-layer-row" }, [btnPrev, layerSlider, btnNext]),
        rangeWrap,
        scrubWrap,
      ]);

      // Color mode & visibility controls
      var colorSel = h("select", { class: "p3d-input", "aria-label": "Mode de coloration" }, [
        h("option", { value: "feature", text: "Type de ligne (fonctions)" }),
        h("option", { value: "filament", text: "Couleurs du fichier" }),
        h("option", { value: "feedrate", text: "Vitesse d'avance" }),
        h("option", { value: "moveKind", text: "Extrusion vs Déplacements" }),
        h("option", { value: "tool", text: "Outils logiques (T0–T3+)" }),
      ]);
      var chkTravel = h("input", { type: "checkbox", checked: false });
      var chkRetract = h("input", { type: "checkbox", checked: false });
      var retractLbl = h("label", { class: "p3d-chk", hidden: true }, [chkRetract, " Rétractions"]);
      var chkSkirtBrim = h("input", { type: "checkbox", checked: true });
      var skirtLbl = h("label", { class: "p3d-chk", hidden: true }, [chkSkirtBrim, " Jupe / Bordure"]);
      var chkCage = h("input", { type: "checkbox", checked: true });

      var legendBox = h("div", { class: "p3d-gcode-legend" });
      var metaBox = h("div", { class: "p3d-gcode-meta" });

      function renderLegend(modeName, summary) {
        legendBox.replaceChildren();
        if (!summary) return;
        if (modeName === "feature") {
          if ((summary.availableColorModes || []).indexOf("feature") === -1) {
            legendBox.append(h("span", { class: "p3d-meta", text: "Annotations de fonction absentes dans ce G-code (non devinées)." }));
            return;
          }
          window.HQGcode.FEATURE_LEGEND.forEach(function (item) {
            var sw = h("span", { class: "p3d-gcode-swatch" });
            sw.style.background = item.hex;
            legendBox.append(h("span", { class: "p3d-gcode-legend-item" }, [sw, item.label]));
          });
        } else if (modeName === "feedrate") {
          var fr = summary.feedrateRange;
          var minS = fr && fr[0] > 0 ? Math.round(fr[0] / 60) : 0;
          var maxS = fr && fr[1] > 0 ? Math.round(fr[1] / 60) : 0;
          var bar = h("span", { class: "p3d-gcode-ramp" });
          var unkSw = h("span", { class: "p3d-gcode-swatch" });
          unkSw.style.background = "#94a3b8";
          legendBox.append(
            h("span", { class: "p3d-gcode-legend-item" }, [minS + " mm/s", bar, maxS + " mm/s"]),
            h("span", { class: "p3d-gcode-legend-item" }, [unkSw, "Inconnu"])
          );
        } else if (modeName === "moveKind") {
          var swE = h("span", { class: "p3d-gcode-swatch" }); swE.style.background = "#38bdf8";
          var swT = h("span", { class: "p3d-gcode-swatch" }); swT.style.background = "#f43f5e";
          legendBox.append(
            h("span", { class: "p3d-gcode-legend-item" }, [swE, "Extrusion déposée"]),
            h("span", { class: "p3d-gcode-legend-item" }, [swT, "Déplacement à vide"])
          );
        } else if (modeName === "filament" || modeName === "tool") {
          var tools = summary.tools || [{ id: 0 }];
          var fils = summary.filaments || [];
          if (modeName === "filament" && summary.colorSource === "none") {
            legendBox.append(h("span", { class: "p3d-meta", text: "Aucune couleur filament déclarée dans le fichier (neutre)." }));
          }
          tools.forEach(function (t) {
            var fil = fils.find(function (f) { return f.slot === t.id; }) || fils[t.id] || null;
            var hex = modeName === "tool"
              ? ((toolColors && toolColors[t.id]) || window.HQGcode.TOOL_PALETTE_HEX[t.id % window.HQGcode.TOOL_PALETTE_HEX.length])
              : ((fil && fil.colour) || t.colorHex || "#adb6c2");
            var sw = h("span", { class: "p3d-gcode-swatch" });
            sw.style.background = hex;
            var mat = (fil && fil.type) || t.material || "matériau non précisé";
            var suffix = modeName === "tool" ? " (palette outils)" : (summary.colorSource === "none" ? " (non déclaré)" : "");
            legendBox.append(h("span", { class: "p3d-gcode-legend-item" }, [sw, "T" + t.id + " · " + mat + suffix]));
          });
        }
      }

      function renderMetadata(summary) {
        metaBox.replaceChildren();
        if (!summary) return;
        var rows = [];
        if (summary.totalTimeMs != null && summary.totalTimeMs > 0) {
          var durTxt = fmtDur(summary.totalTimeMs / 1000);
          var srcTxt = summary.timeEstimateSource === "slicer" ? "trancheur" : "approx. cinématique";
          rows.push(h("div", { class: "p3d-gcode-stat" }, [
            h("span", { class: "p3d-meta", text: "Durée (" + srcTxt + ")" }),
            h("strong", { text: durTxt }),
          ]));
        }
        rows.push(h("div", { class: "p3d-gcode-stat" }, [
          h("span", { class: "p3d-meta", text: "Couches / Segments" }),
          h("strong", { text: fmtInt(summary.layerCount) + " / " + fmtInt(summary.segmentCount) }),
        ]));
        if (summary.dimensionsMm) {
          var dSrc = summary.dimensionsSource === "model" ? "modèle" : (summary.dimensionsSource === "object" ? "objet" : "extrusion");
          rows.push(h("div", { class: "p3d-gcode-stat" }, [
            h("span", { class: "p3d-meta", text: "Dimensions (" + dSrc + ")" }),
            h("strong", { text: summary.dimensionsMm[0] + " × " + summary.dimensionsMm[1] + " × " + summary.dimensionsMm[2] + " mm" }),
          ]));
        }
        var activePlateInfo = platesInfo.find(function (pl) { return pl.plate === plate; }) || inspectInfo || {};
        var weightG = activePlateInfo.weight_g || (summary.filamentUsage && summary.filamentUsage.weightG);
        var lengthM = summary.filamentUsage && summary.filamentUsage.lengthMm ? +(summary.filamentUsage.lengthMm / 1000).toFixed(2) : null;
        if (weightG != null || lengthM != null) {
          var fTxt = [weightG != null ? (weightG + " g") : "", lengthM != null ? (lengthM + " m") : ""].filter(Boolean).join(" · ");
          rows.push(h("div", { class: "p3d-gcode-stat" }, [
            h("span", { class: "p3d-meta", text: "Filament utilisé" }),
            h("strong", { text: fTxt }),
          ]));
        }
        rows.push(h("div", { class: "p3d-gcode-stat" }, [
          h("span", { class: "p3d-meta", text: "Plateau sélectionné" }),
          h("strong", { text: "Plateau " + plate + " · " + bed.x + "×" + bed.y + "×" + bed.z + " mm" }),
        ]));

        var grid = h("div", { class: "p3d-gcode-stats" }, rows);
        metaBox.append(grid);

        // Multi-toolhead & AMS/station honest breakdown
        var toolSection = h("div", { class: "p3d-gcode-tools-card" });
        var tools = summary.tools || [{ id: 0 }];
        var fils = summary.filaments || [];
        var toolChips = tools.map(function (t) {
          var fil = fils.find(function (f) { return f.slot === t.id; }) || fils[t.id] || null;
          var dot = h("span", { class: "p3d-gcode-swatch" });
          var colHex = (fil && fil.colour) || t.colorHex || "";
          dot.style.background = colHex || "#94a3b8";
          var parts = ["T" + t.id];
          if (fil && fil.type) parts.push(fil.type);
          if (fil && fil.g != null) parts.push(fil.g + " g");
          else if (fil && fil.m != null) parts.push(fil.m + " m");
          if (!colHex) parts.push("couleur non déclarée");
          return h("span", { class: "p3d-tag" }, [dot, parts.join(" · ")]);
        });
        toolSection.append(h("p", { class: "p3d-meta", text: "Outils G-code logiques & matériaux du fichier :" }), h("div", { class: "p3d-ctl-row" }, toolChips));

        if (printer) {
          var amsSlots = (printer.status && Array.isArray(printer.status.ams)) ? printer.status.ams : [];
          var pLabel = printer.name + " (" + (KIND_LABEL[printer.kind] || printer.kind) + ")";
          if (amsSlots.length) {
            var amsChips = amsSlots.map(function (sl) {
              var dot = h("span", { class: "p3d-gcode-swatch" });
              dot.style.background = sl.colour || "#94a3b8";
              var txt = "Slot " + sl.slot + " : " + (sl.material || "?") + (sl.loaded === false ? " (vide)" : "");
              return h("span", { class: "p3d-tag" }, [dot, txt]);
            });
            toolSection.append(
              h("p", { class: "p3d-meta", text: "Bobines chargées sur " + pLabel + " (AMS / Station — indépendant des couleurs Studio) :" }),
              h("div", { class: "p3d-ctl-row" }, amsChips)
            );
          } else {
            toolSection.append(h("p", { class: "p3d-meta", text: "Imprimante : " + pLabel + " · aucune bobine AMS/station remontée (la correspondance physique est vérifiée au lancement)." }));
          }
        }
        metaBox.append(toolSection);
      }

      colorSel.addEventListener("change", function () {
        if (!activeViewer) return;
        var ok = activeViewer.setColorMode(colorSel.value, { toolColors: toolColors });
        if (!ok) {
          toast("Ce mode de coloration n'est pas disponible pour ce fichier.", "err");
          return;
        }
        renderLegend(colorSel.value, activeViewer.getSummary());
      });
      chkTravel.addEventListener("change", function () {
        if (activeViewer) activeViewer.setShowTravel(chkTravel.checked);
      });
      chkRetract.addEventListener("change", function () {
        if (activeViewer) activeViewer.setShowRetractions(chkRetract.checked);
      });
      chkSkirtBrim.addEventListener("change", function () {
        if (!activeViewer) return;
        // FeatureRole.Skirt = 6, FeatureRole.Brim = 7
        activeViewer.setFeatureRoleVisible(6, chkSkirtBrim.checked);
        activeViewer.setFeatureRoleVisible(7, chkSkirtBrim.checked);
      });
      chkCage.addEventListener("change", function () {
        if (activeViewer) activeViewer.setShowVolumeCage(chkCage.checked);
      });

      var ctlRow = h("div", { class: "p3d-gcode-controls" }, [
        h("label", { class: "p3d-gcode-color-lbl" }, ["Coloration", colorSel]),
        h("label", { class: "p3d-chk" }, [chkTravel, " Déplacements à vide"]),
        retractLbl,
        skirtLbl,
        h("label", { class: "p3d-chk" }, [chkCage, " Cage"]),
      ]);

      panel.append(camBar, viewport, noticeBanner, layerBox, ctlRow, legendBox, metaBox);

      activeViewer = window.HQGcode.createGcodeViewer(stageHost, {
        buildVolume: bed ? { x: bed.x, y: bed.y, z: bed.z, min: { x: 0, y: 0 }, grid: 10 } : null,
        colorMode: "feature",
        showTravel: false,
        showVolumeCage: true,
        toolColors: toolColors,
        onProgress: function (p) {
          if (panelDisposed || seq !== panelSeq) return;
          if (p.phase === "download") {
            var pct = p.total > 0 ? (" " + Math.min(100, Math.round((p.loaded / p.total) * 100)) + "%") : (" " + fmtBytes(p.loaded));
            loaderBadge.textContent = "Téléchargement G-code…" + pct;
          } else if (p.phase === "parsing" || p.phase === "classifying") {
            var pp = typeof p.fraction === "number" ? (" " + Math.min(100, Math.round(p.fraction * 100)) + "%") : "";
            loaderBadge.textContent = "Analyse des trajectoires (worker)…" + pp;
          } else if (p.phase === "building-geometry") {
            var gp = typeof p.fraction === "number" ? (" " + Math.min(100, Math.round(p.fraction * 100)) + "%") : "";
            loaderBadge.textContent = "Construction 3D…" + gp;
          } else if (p.phase === "ready") {
            loaderBadge.hidden = true;
          }
        },
        onStatus: function (st) {
          if (panelDisposed || seq !== panelSeq) return;
          if (st.kind === "mismatch" || st.kind === "buildComplete") {
            var s = activeViewer ? activeViewer.getSummary() : null;
            var msgs = [];
            if (s && s.machineMismatch) msgs.push(s.machineMismatch);
            if (s && s.disclosure) msgs.push("Rendu adapté : " + s.disclosure);
            if (s && s.complete === false) msgs.push("Aperçu partiel (limite de ressources atteinte : " + (s.stopReason || "tronqué") + ").");
            if (msgs.length) {
              noticeBanner.textContent = msgs.join(" · ");
              noticeBanner.hidden = false;
            }
          } else if (st.kind === "contextlost") {
            loaderBadge.hidden = false;
            loaderBadge.textContent = st.message || "Contexte WebGL interrompu…";
          } else if (st.kind === "restored") {
            loaderBadge.hidden = true;
          }
        },
        onFallback: function (info) {
          if (panelDisposed || seq !== panelSeq) return;
          show2d("WebGL indisponible (" + ((info && info.message) || "repli automatique") + ") — aperçu 2D échantillonné.", false);
        },
      });
      if (typeof cfg.registerViewer === "function") cfg.registerViewer(activeViewer);

      function loadPlate(pNum) {
        if (panelDisposed || !activeViewer) return;
        var loadSeqThis = ++panelSeq;
        loaderBadge.hidden = false;
        loaderBadge.textContent = "Chargement du G-code (plateau " + pNum + ")…";
        noticeBanner.hidden = true;
        noticeBanner.textContent = "";

        var plateMeta = inspectInfo;
        if (platesInfo.length) {
          var found = platesInfo.find(function (pl) { return pl.plate === pNum; });
          if (found) plateMeta = found;
        }

        activeViewer.load({ modelId: modelId, plate: pNum, meta: plateMeta }).then(function (res) {
          if (panelDisposed || loadSeqThis !== panelSeq || (typeof cfg.tokenCheck === "function" && !cfg.tokenCheck())) return;
          if (!res || res.cancelled) return;
          loaderBadge.hidden = true;
          var summary = res.summary;
          totalLayers = summary.layerCount || 0;
          curStart = 0;
          curEnd = Math.max(0, totalLayers - 1);
          accumulated = true;
          btnAccum.classList.add("is-on");
          btnSingle.classList.remove("is-on");
          syncLayerUi();

          if (summary.segmentCount > 0) {
            scrubWrap.hidden = false;
            scrubSlider.max = String(summary.segmentCount - 1);
            scrubSlider.value = String(summary.segmentCount - 1);
            scrubChk.checked = false;
            scrubSlider.disabled = true;
            scrubLbl.textContent = "Tous les segments";
          } else {
            scrubWrap.hidden = true;
          }

          // Capability-gate color options cleanly
          var avail = summary.availableColorModes || [];
          var featOpt = colorSel.querySelector('option[value="feature"]');
          var speedOpt = colorSel.querySelector('option[value="feedrate"]');
          if (featOpt) {
            featOpt.disabled = avail.indexOf("feature") === -1;
            featOpt.textContent = featOpt.disabled ? "Type de ligne (non annoté)" : "Type de ligne (fonctions)";
          }
          if (speedOpt) {
            speedOpt.disabled = avail.indexOf("feedrate") === -1;
          }
          colorSel.value = res.colorMode || "moveKind";
          retractLbl.hidden = !summary.hasRetractions;
          skirtLbl.hidden = avail.indexOf("feature") === -1;

          var notices = [];
          if (summary.machineMismatch) notices.push(summary.machineMismatch);
          if (summary.disclosure) notices.push("Rendu adapté : " + summary.disclosure);
          if (summary.complete === false) notices.push("Aperçu partiel (limite de ressources atteinte).");
          if (notices.length) {
            noticeBanner.textContent = notices.join(" · ");
            noticeBanner.hidden = false;
          }

          renderLegend(colorSel.value, summary);
          renderMetadata(summary);
          activeViewer.resize();
        }).catch(function (err) {
          if (panelDisposed || loadSeqThis !== panelSeq || (typeof cfg.tokenCheck === "function" && !cfg.tokenCheck())) return;
          if (err && (err.code === "too_large" || err.code === "E_LIMIT_INPUT_BYTES" || err.code === "E_LIMIT_SEGMENTS" || err.code === "E_LIMIT_BUFFER_BYTES")) {
            show2d((err.message || "Fichier hors budget 3D") + " — bascule vers la vue 2D échantillonnée.", false);
            return;
          }
          loaderBadge.hidden = false;
          loaderBadge.textContent = (err && err.message) || "Impossible d'afficher l'aperçu 3D.";
          noticeBanner.textContent = "Utilise « Vue 2D (secours) » si le fichier est trop lourd pour cet appareil.";
          noticeBanner.hidden = false;
        });
      }

      loadPlate(plate);
    }

    if (force2d) {
      show2d(window.HQGcode ? "" : "Module 3D indisponible — aperçu 2D échantillonné.", !!window.HQGcode);
    } else {
      start3d();
    }

    return {
      setPlate: function (pNum) {
        plate = Number(pNum || 1);
        if (force2d) show2d("", !!window.HQGcode);
        else start3d();
      },
      dispose: function () {
        panelDisposed = true;
        panelSeq += 1;
        cleanupCurrent();
      },
    };
  }

  function modelDetail(m, token) {
    var preview = h("div", { class: "p3d-preview" });
    var preflight = h("div", { class: "p3d-preflight", hidden: true });
    var ext = String(m.ext || "").toLowerCase();
    if ((ext === "stl" || ext === "glb") && m.size <= STL_PREVIEW_MAX && window.HQModel) {
      var canvas = h("canvas", { class: "p3d-canvas" });
      var note = h("p", { class: "p3d-meta", text: "Chargement de l'aperçu…" });
      preview.append(canvas, note);
      var url = "/api/print3d/models/file?id=" + encodeURIComponent(m.id);
      (ext === "glb" ? fetchFullStl(url) : fetchStl(url))
        .then(function (buf) {
          if (token !== previewToken) return;
          var parsed = window.HQModel.parse(m.name, buf);
          // The dimensions and estimate only need the parsed mesh: keep them even when this
          // browser's viewer cannot draw it (no WebGL, or its 2D triangle cap).
          renderPreflight(preflight, parsed);
          viewer = window.HQModel.viewer(canvas);
          viewer.setModel(parsed);
          note.textContent = fmtInt(parsed.triangles) + " triangles · glisser pour tourner";
        }).catch(function (e) {
          if (token !== previewToken) return;
          canvas.remove();
          note.textContent = e.message;
        });
    } else if (m.has_thumb) {
      preview.append(h("img", { alt: "", src: "/api/print3d/models/thumb?id=" + encodeURIComponent(m.id) }));
    } else {
      preview.append(h("span", { class: "p3d-ext is-big", text: (m.ext || "?").toUpperCase() }));
    }
    var tags = h("input", { class: "p3d-input", value: (m.tags || []).join(", "), placeholder: "étiquettes, séparées par des virgules" });
    var notes = h("textarea", { class: "p3d-input", rows: "4", placeholder: "Notes (réglages, filament, retouches…)" });
    notes.value = m.notes || "";
    var origin = h("select", { class: "p3d-input" }, [h("option", { value: "", text: "Origine ?" })]
      .concat(Object.keys(ORIGIN_LABEL).map(function (k) { return h("option", { value: k, text: ORIGIN_LABEL[k] }); })));
    origin.value = m.origin || "";
    var printed = h("input", { class: "p3d-input", type: "number", min: "0", value: String(m.printed_count || 0) });
    var mwid = h("input", { class: "p3d-input", type: "number", min: "0", value: m.makerworld_design_id ? String(m.makerworld_design_id) : "", placeholder: "ID MakerWorld" });
    var mwBox = h("div", { class: "p3d-mwbox" });
    var matches = h("div", { class: "p3d-tags p3d-mwmatch", hidden: true });
    if (m.mw) {
      var c = m.mw.change_7d || [];
      mwBox.append(h("a", { class: "p3d-mwtitle", href: m.mw.url, target: "_blank", rel: "noopener noreferrer", text: m.mw.title }),
        h("p", { class: "p3d-meta", text: "↓ " + fmtInt(m.mw.downloads) + " téléchargements · ⎙ " + fmtInt(m.mw.prints) + " impressions · ♥ " + fmtInt(m.mw.likes) + " · 💬 " + fmtInt(m.mw.comments)
          + (c.length ? " · 7 j : " + (c[0] >= 0 ? "+" : "") + c[0] + " / " + (c[1] >= 0 ? "+" : "") + c[1] + " / " + (c[2] >= 0 ? "+" : "") + c[2] : "") }));
    } else if (m.makerworld_design_id) {
      mwBox.append(h("p", { class: "p3d-meta", text: "Lié au modèle " + m.makerworld_design_id + " — pas dans le dernier relevé (actualise MakerWorld)." }));
    }
    var matchBtn = h("button", { type: "button", class: "p3d-btn", text: "Retrouver sur MakerWorld", onclick: function () {
      matchBtn.disabled = true;
      api("/api/print3d/models/match?id=" + encodeURIComponent(m.id)).then(function (res) {
        matches.hidden = false;
        matches.innerHTML = "";                    // one list per click, not a growing stack
        if (!res.candidates.length) matches.append(h("span", { class: "p3d-meta", text: "Aucun modèle publié ne ressemble à ce nom (relevé MakerWorld à jour ?)." }));
        res.candidates.forEach(function (cd) {
          matches.append(h("button", { type: "button", class: "p3d-tag", text: cd.title + " · " + cd.score + " %", onclick: function () {
            mwid.value = String(cd.id);
            toast("Lien choisi — enregistre pour le garder");
          } }));
        });
      }).catch(function (e) { toast(e.message, "err"); }).then(function () { matchBtn.disabled = false; });
    } });
    mwBox.append(matchBtn, matches);
    var printBox = h("div", { class: "p3d-printbox", hidden: true });
    if (ext === "3mf" || ext === "gcode" || ext === "gx") {
      api("/api/print3d/models/inspect?id=" + encodeURIComponent(m.id)).then(function (res) {
        if (token !== previewToken) return;
        var info = res.info || {};
        if (!info.kind) return;
        printBox.hidden = false;
        printBox.innerHTML = "";
        var selectedPlate = (info.plates && info.plates[0]) || 1;
        var platesInfo = info.plates_info || [];
        if (platesInfo.length > 1) {
          var pSel = h("select", { class: "p3d-input", "aria-label": "Plateau" }, platesInfo.map(function (pl) {
            return h("option", { value: String(pl.plate),
              text: "Plateau " + pl.plate + (pl.weight_g ? " · " + pl.weight_g + " g" : "") + (pl.prediction_sec ? " · " + fmtDur(pl.prediction_sec) : "") });
          }));
          pSel.addEventListener("change", function () {
            selectedPlate = Number(pSel.value) || 1;
            var img = preview.querySelector("img");
            if (img) img.src = "/api/print3d/models/thumb?id=" + encodeURIComponent(m.id) + "&plate=" + selectedPlate;
          });
          printBox.append(h("label", {}, ["Plateau à imprimer", pSel]));
        }
        var layerWrap = h("div", { class: "p3d-gcode-wrap", hidden: true });
        var gcodePanel = null;
        function openDetailGcodePreview() {
          layerWrap.hidden = false;
          disposeViewer();
          var selPrinter = printers.find(function (pr) { return pr.id === prSel.value; }) || printers[0] || null;
          gcodePanel = mountGcodePreviewPanel(layerWrap, {
            modelId: m.id,
            plate: selectedPlate,
            inspectInfo: info,
            printer: selPrinter,
            bed: printerBed(selPrinter) || { x: 256, y: 256, z: 256 },
            compact: true,
            tokenCheck: function () { return token === previewToken; },
            registerViewer: function (v) { viewer = v; },
            onPlateChange: function (newP) {
              selectedPlate = newP;
              var pSelEl = printBox.querySelector('select[aria-label="Plateau"]');
              if (pSelEl) pSelEl.value = String(newP);
              var img = preview.querySelector("img");
              if (img) img.src = "/api/print3d/models/thumb?id=" + encodeURIComponent(m.id) + "&plate=" + selectedPlate;
            },
          });
        }
        var layerBtn = h("button", { type: "button", class: "p3d-btn is-small", text: "Aperçu G-code 3D (couches)",
          onclick: openDetailGcodePreview });
        if (platesInfo.length > 1) {
          var pSelNode = printBox.querySelector('select[aria-label="Plateau"]');
          if (pSelNode) {
            pSelNode.addEventListener("change", function () {
              if (!layerWrap.hidden && gcodePanel) gcodePanel.setPlate(selectedPlate);
            });
          }
        }
        var printers = (data.config && data.config.printers) || [];
        var prSel = h("select", { class: "p3d-input" }, printers.map(function (pr) {
          return h("option", { value: pr.id, text: pr.name + " (" + (KIND_LABEL[pr.kind] || pr.kind) + ")" });
        }));
        var cbLevel = h("input", { type: "checkbox", checked: true });
        var cbFlow = h("input", { type: "checkbox" });
        var cbVib = h("input", { type: "checkbox" });
        var cbTl = h("input", { type: "checkbox" });
        var optsRow = h("div", { class: "p3d-ctl-row" }, [
          h("label", { class: "p3d-chk" }, [cbLevel, " Nivellement"]),
          h("label", { class: "p3d-chk" }, [cbFlow, " Débit"]),
          h("label", { class: "p3d-chk" }, [cbVib, "Vibrations"]),
          h("label", { class: "p3d-chk" }, [cbTl, " Timelapse"]),
        ]);
        var goBtn = h("button", { type: "button", class: "p3d-btn is-primary is-small", text: "Lancer l'impression",
          onclick: function () {
            if (!prSel.value) { toast("Configure une imprimante dans Réglages.", "err"); return; }
            busyRun(goBtn, "Envoi…", function () {
              return post("/api/print3d/printer/start", {
                printer_id: prSel.value, model_id: m.id, plate: selectedPlate,
                bed_levelling: cbLevel.checked, flow_cali: cbFlow.checked,
                vibration_cali: cbVib.checked, timelapse: cbTl.checked,
              }).then(function () { toast("Impression lancée"); closeOverlay(); refresh(); });
            }).catch(function (e) { toast(e.message, "err"); });
          } });
        var qBtn = h("button", { type: "button", class: "p3d-btn is-small", text: "Mettre en file",
          onclick: function () {
            post("/api/print3d/queue/add", {
              model_id: m.id, plate: selectedPlate, printer_id: prSel.value || "auto",
              options: { bed_levelling: cbLevel.checked, flow_cali: cbFlow.checked,
                vibration_cali: cbVib.checked, timelapse: cbTl.checked },
            }).then(function () { toast("Ajouté à la file d'atelier"); return refresh(); })
              .catch(function (e) { toast(e.message, "err"); });
          } });
        printBox.append(h("h4", { class: "p3d-h3", text: "Impression directe" }), layerBtn, layerWrap,
          h("label", {}, ["Imprimante", prSel]), optsRow, h("div", { class: "p3d-ctl-row" }, [goBtn, qBtn]));
      }).catch(function () { });
    }
    var sliceWrap = h("div", { class: "p3d-printbox", hidden: !(ext === "stl" || ext === "3mf" || ext === "obj" || ext === "step" || ext === "stp") });
    var cfgPrinters = ((data.config && data.config.printers) || []);
    var slPr = h("select", { class: "p3d-input p3d-ctl-num", "aria-label": "Imprimante cible" },
      cfgPrinters.length
        ? cfgPrinters.map(function (pr) {
            return h("option", { value: pr.id, text: pr.name + (pr.model ? " (" + pr.model + ")" : " (modèle non configuré)") });
          })
        : [h("option", { value: "", text: "Aucune imprimante configurée" })]);
    if (studio.printerId && cfgPrinters.some(function (pr) { return pr.id === studio.printerId; })) slPr.value = studio.printerId;
    var slLayer = h("select", { class: "p3d-input p3d-ctl-num" }, [
      h("option", { value: "", text: "Couche défaut" }),
      h("option", { value: "0.12", text: "0.12 mm (Fin)" }),
      h("option", { value: "0.20", text: "0.20 mm (Standard)" }),
      h("option", { value: "0.28", text: "0.28 mm (Rapide)" }),
    ]);
    var slMat = h("select", { class: "p3d-input p3d-ctl-num", "aria-label": "Matériau" },
      ["PLA", "PETG", "ABS", "TPU"].map(function (mt) { return h("option", { value: mt, text: mt }); }));
    slMat.value = studio.cfg.material || "PLA";
    var slInfill = h("input", { class: "p3d-input p3d-ctl-num", type: "number", min: "0", max: "100", placeholder: "Remplissage %" });
    var slSup = h("input", { type: "checkbox" });
    var slBrim = h("input", { type: "checkbox" });
    var meshNote = h("p", { class: "p3d-meta", hidden: true });
    var sliceRow = [
      slPr, slMat, slLayer, slInfill,
      h("label", { class: "p3d-chk" }, [slSup, " Supports"]),
      h("label", { class: "p3d-chk" }, [slBrim, " Bordure"]),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Trancher (OrcaSlicer)", onclick: function (e) {
        var targetPr = cfgPrinters.find(function (pr) { return pr.id === slPr.value; }) || null;
        if (!targetPr || !targetPr.model) {
          toast("Configure une imprimante avec son modèle dans Réglages.", "err");
          return;
        }
        busyRun(e.target, "Tranchage…", function () {
          return post("/api/print3d/models/slice", {
            id: m.id,
            printer_id: targetPr.id,
            printer_model: targetPr.model,
            material: slMat.value || "PLA",
            plate_type: studio.cfg.plate_type || "textured_pei",
            nozzle: (printerCaps(targetPr) && printerCaps(targetPr).default_nozzle) || "0.4",
            layer_height: slLayer.value || null,
            infill: slInfill.value || null,
            supports: slSup.checked,
            brim: slBrim.checked,
          }).then(function (r) { toast("Tranché : " + ((r.model && r.model.name) || "OK")); closeOverlay(); loadModels(true); });
        }).catch(function (err) { toast(err.message, "err"); });
      } }),
    ];
    if (ext === "stl") {
      sliceRow.push(h("button", { type: "button", class: "p3d-btn is-small", text: "Vérifier / Orienter STL", onclick: function () {
        meshNote.hidden = false; meshNote.textContent = "Analyse du maillage…";
        api("/api/print3d/models/mesh_check?id=" + encodeURIComponent(m.id)).then(function (r) {
          meshNote.textContent = (r.watertight ? "Maillage étanche" : "Bords ouverts : " + r.open_edges + " · non-manifold : " + r.non_manifold_edges)
            + " · meilleure base : " + r.best_orientation.toUpperCase();
          if (r.best_orientation !== "xy") {
            post("/api/print3d/models/orient", { id: m.id }).then(function (orRes) {
              if (orRes.oriented_model) { toast("Copie orientée créée : " + orRes.oriented_model.name); loadModels(true); }
            }).catch(function () { });
          }
        }).catch(function (e) { meshNote.textContent = e.message; });
      } }));
    }
    sliceWrap.append(h("span", { class: "p3d-kicker", text: "Préparation & Tranchage" }), h("div", { class: "p3d-ctl-row" }, sliceRow), meshNote);
    return h("div", { class: "p3d-model-detail" }, [
      h("h3", { text: m.name }),
      h("p", { class: "p3d-meta", text: (m.root === "print" ? "Print/" : "Dossier supplémentaire/") + (m.folder ? m.folder + "/" : "") + " · " + fmtBytes(m.size) }),
      preview,
      preflight,
      printBox,
      sliceWrap,
      h("label", {}, ["Étiquettes", tags]),
      h("label", {}, ["Origine", origin]),
      h("label", {}, ["Imprimé (fois)", printed]),
      h("label", {}, ["Modèle MakerWorld", mwid]), mwBox,
      h("label", {}, ["Notes", notes]),
      h("div", { class: "p3d-actions" }, [
        h("button", { type: "button", class: "p3d-btn", text: "Ouvrir dans Studio", onclick: function () { closeOverlay(); addToStudio(m); } }),
        h("a", { class: "p3d-btn", href: "/api/print3d/models/file?id=" + encodeURIComponent(m.id), text: "Télécharger" }),
        h("button", { type: "button", class: "p3d-btn is-primary", text: "Enregistrer", onclick: function (e) {
          busyRun(e.target, "Enregistrement…", function () {
            return post("/api/print3d/models/meta", { id: m.id, tags: tags.value, notes: notes.value, origin: origin.value,
              printed_count: Number(printed.value || 0), makerworld_design_id: Number(mwid.value || 0) })
              .then(function () { toast("Modèle enregistré"); closeOverlay(); loadModels(true); });
          }).catch(function (err) { toast(err.message, "err"); });
        } }),
      ]),
    ]);
  }

  // ── MakerWorld ──
  function loadMakerworld() {
    if (loaded.makerworld && Date.now() - mwAt < MODELS_TTL_MS && ui.panes.makerworld.querySelector(".p3d-kpis")) {
      return Promise.resolve();
    }
    return api("/api/print3d/makerworld").then(function (mw) {
      loaded.makerworld = true;
      mwAt = Date.now();
      renderMakerworld(mw);
    }).catch(function (e) { ui.panes.makerworld.textContent = "Statistiques illisibles : " + e.message; });
  }

  function sparkline(points, key) {
    var vals = points.map(function (p) { return p[key]; }).filter(function (v) { return typeof v === "number"; });
    if (vals.length < 2) return null;
    var w = 280, hgt = 56, min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = (max - min) || 1;
    var d = vals.map(function (v, i) {
      return (i ? "L" : "M") + (i * w / (vals.length - 1)).toFixed(1) + " " + (hgt - 4 - (v - min) / span * (hgt - 8)).toFixed(1);
    }).join(" ");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + hgt);
    svg.setAttribute("class", "p3d-spark");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Évolution des téléchargements, de " + fmtInt(min) + " à " + fmtInt(max));
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  function deltaOver(points, key, days) {
    if (points.length < 2) return null;
    var cur = points[points.length - 1], since = Date.now() / 1000 - days * 86400;
    var base = points.find(function (p) { return p.at >= since; }) || points[0];
    if (base === cur || typeof cur[key] !== "number" || typeof base[key] !== "number") return null;
    return cur[key] - base[key];
  }

  function sparkSummary(points, key) {
    var vals = points.map(function (p) { return p[key]; }).filter(function (v) { return typeof v === "number"; });
    if (vals.length < 2) return "";
    return "min " + fmtInt(Math.min.apply(null, vals)) + " · max " + fmtInt(Math.max.apply(null, vals))
      + " · depuis " + fmtAgo(points[0].at);
  }

  function renderMakerworld(mw) {
    var pane = ui.panes.makerworld;
    pane.innerHTML = "";
    if (!mw.configured) {
      pane.append(h("div", { class: "p3d-empty" }, [
        h("p", { text: "Indique ton pseudo MakerWorld (et ton cookie de session) dans Réglages." }),
        h("button", { type: "button", class: "p3d-btn is-primary", text: "Réglages", onclick: function () { setTab("settings"); } }),
      ]));
      return;
    }
    var last = mw.last || {}, profile = last.profile || {}, totals = last.totals || {}, hist = mw.history || [];
    var status = h("div", { class: "p3d-toolbar" }, [
      h("span", { class: "p3d-meta", text: "@" + mw.handle + " · actualisé " + fmtAgo(last.at) + (mw.has_cookie ? " · cookie enregistré" : " · sans cookie") }),
      h("button", { type: "button", class: "p3d-btn", text: mw.refreshing ? "Actualisation…" : "Actualiser", disabled: mw.refreshing,
        onclick: function (e) {
          busyRun(e.target, "Actualisation…", function () {
            return post("/api/print3d/makerworld/refresh").then(renderMakerworld);
          }).catch(function (err) { toast(err.message, "err"); loadMakerworld(); });
        } }),
    ]);
    pane.append(status);
    if (mw.last_error) pane.append(h("p", { class: "p3d-warn", text: mw.last_error.message + (mw.last_error.code === "makerworld_blocked"
      ? " — recolle un cookie frais (et le User-Agent de ton navigateur) dans Réglages." : "") }));
    if ((mw.alerts || []).length) {
      var al = h("div", { class: "p3d-alerts" });
      mw.alerts.slice().reverse().slice(0, 5).forEach(function (a) {
        al.append(h("p", { class: "p3d-problem is-info" }, [h("strong", { text: a.kind === "spike" ? "PIC" : "COMMENTAIRES" }), h("span", { text: a.text + " · " + fmtAgo(a.at) })]));
      });
      pane.append(al);
    }
    var tiles = [
      ["Téléchargements", totals.downloads, "downloads"], ["Impressions", totals.prints, "prints"],
      ["J'aime", totals.likes, "likes"], ["Collections", totals.collections, "collections"],
      ["Abonnés", profile.followers, "followers"], ["Boosts reçus", profile.boosts_gained, "boosts"],
      ["Points", profile.points, "points"], ["Modèles", last.design_total, null],
    ];
    var kpis = h("div", { class: "p3d-kpis" });
    tiles.forEach(function (t) {
      var d = t[2] ? deltaOver(hist, t[2], 7) : null;
      kpis.append(h("div", { class: "p3d-kpi" }, [
        h("span", { class: "p3d-kpi-label", text: t[0] }),
        h("strong", { text: fmtInt(t[1]) }),
        d ? h("span", { class: "p3d-delta" + (d < 0 ? " is-down" : ""), text: (d > 0 ? "+" : "") + fmtInt(d) + " / 7 j" }) : null,
      ]));
    });
    pane.append(kpis);
    var spark = sparkline(hist, "downloads");
    if (spark) {
      pane.append(h("div", { class: "p3d-chart" }, [
        h("span", { class: "p3d-kpi-label", text: "Téléchargements dans le temps" }),
        spark,
        h("span", { class: "p3d-meta", text: sparkSummary(hist, "downloads") })]));
    }
    var designs = (last.designs || []).slice().sort(function (a, b) { return b.downloads - a.downloads; });
    if (designs.length) {
      var deltas = mw.design_deltas || {};
      var table = h("table", { class: "p3d-table" }, [h("thead", {}, [h("tr", {}, [
        h("th", { text: "Modèle" }), h("th", { text: "Télécharg." }), h("th", { text: "Impr." }), h("th", { text: "J'aime" }), h("th", { text: "7 j" }),
      ])])]);
      var body = h("tbody");
      designs.forEach(function (d) {
        var dd = deltas[String(d.id)];
        body.append(h("tr", {}, [
          h("td", {}, [h("a", { href: "https://makerworld.com/en/models/" + d.id, target: "_blank", rel: "noopener noreferrer", text: d.title })]),
          h("td", { text: fmtInt(d.downloads) }), h("td", { text: fmtInt(d.prints) }), h("td", { text: fmtInt(d.likes) }),
          h("td", { class: dd && dd[0] > 0 ? "is-up" : "", text: dd ? (dd[0] > 0 ? "+" : "") + dd[0] : "–" }),
        ]));
      });
      table.append(body);
      pane.append(h("div", { class: "p3d-table-wrap" }, [table]));
    }
  }

  // ── filament usage and cost ──
  var fil = { period: "30d", data: null };
  var SOURCE_LABEL = { slice: "fichier tranché", printer: "estimation imprimante", ams: "bobines AMS (≈)",
    counter: "compteur imprimante (≈, à confirmer)", manual: "saisi" };
  var OUTCOME_LABEL = { finished: "terminé", failed: "échec", stopped: "arrêté" };
  function money(v, cur) { return typeof v === "number" ? v.toFixed(2).replace(".", ",") + " " + (cur || "$") : "–"; }
  function fmtGrams(g) { return typeof g !== "number" ? "–" : g >= 1000 ? (g / 1000).toFixed(2).replace(".", ",") + " kg" : Math.round(g) + " g"; }
  function fmtMetres(m) { return typeof m !== "number" ? "–" : m >= 1000 ? (m / 1000).toFixed(2).replace(".", ",") + " km" : m.toFixed(1).replace(".", ",") + " m"; }

  function loadFilament() {
    return api("/api/print3d/filament?period=" + encodeURIComponent(fil.period)).then(function (res) {
      fil.data = res;
      loaded.filament = true;
      renderFilament();
    }).catch(function (e) { ui.panes.filament.textContent = "Filament illisible : " + e.message; });
  }

  function barChart(days) {
    if (!days.length) return null;
    var rows = days.slice(-30), w = 560, hgt = 90, max = Math.max.apply(null, rows.map(function (d) { return d.g; })) || 1;
    var bw = w / rows.length;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + hgt);
    svg.setAttribute("class", "p3d-bars");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Filament par jour, jusqu'à " + Math.round(max) + " g");
    rows.forEach(function (d, i) {
      var bh = Math.max(2, d.g / max * (hgt - 16));
      var r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", (i * bw + 1).toFixed(1)); r.setAttribute("y", (hgt - bh).toFixed(1));
      r.setAttribute("width", Math.max(1, bw - 2).toFixed(1)); r.setAttribute("height", bh.toFixed(1)); r.setAttribute("rx", "2");
      var t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = d.day + " · " + Math.round(d.g) + " g";
      r.append(t);
      svg.append(r);
    });
    return svg;
  }

  function editJob(job) {
    var grams = h("input", { class: "p3d-input", type: "number", min: "1", max: "20000", step: "0.1",
      value: String(Math.round((job.filament && job.filament.g) || 0) || "") });
    openOverlay(h("div", { class: "p3d-model-detail" }, [
      h("h3", { text: "Corriger le poids" }),
      h("p", { class: "p3d-meta", text: (job.job || "Impression") + " · " + (job.printer_name || "") + " · estimation actuelle " + fmtGrams(job.filament && job.filament.g) }),
      h("label", {}, ["Poids réel (g) — pèse la pièce + supports", grams]),
      h("div", { class: "p3d-actions" }, [
        h("button", { type: "button", class: "p3d-btn is-danger", text: "Supprimer cette impression", onclick: function () {
          if (!confirm("Supprimer cette impression de l'historique ?")) return;
          post("/api/print3d/history/delete", { id: job.id }).then(function () { closeOverlay(); loadFilament(); })
            .catch(function (e) { toast(e.message, "err"); });
        } }),
        h("button", { type: "button", class: "p3d-btn is-primary", text: "Enregistrer", onclick: function (e) {
          busyRun(e.target, "Enregistrement…", function () {
            return post("/api/print3d/history/edit", { id: job.id, grams: Number(grams.value) })
              .then(function () { toast("Poids corrigé"); closeOverlay(); loadFilament(); });
          }).catch(function (err) { toast(err.message, "err"); });
        } }),
      ]),
    ]));
  }

  function filamentShell() {
    var pane = ui.panes.filament;
    if (shell && shell.body && pane.contains(shell.body)) return shell;
    pane.innerHTML = "";
    var bar = h("div", { class: "p3d-toolbar" });
    var body = h("div", { class: "p3d-fil-body" });
    var price = h("div", { class: "p3d-fil-price" });
    pane.append(bar, body, price);
    shell = { bar: bar, body: body, price: price, priceSet: false };
    return shell;
  }

  function renderFilament() {
    var d = fil.data;
    if (!d) { ui.panes.filament.innerHTML = ""; ui.panes.filament.append(skeletonRows(3)); return; }
    var s = filamentShell(), cur = d.currency || "$", t = d.totals || {};
    s.bar.innerHTML = "";
    [["7d", "7 jours"], ["30d", "30 jours"], ["90d", "90 jours"], ["all", "Tout"]].forEach(function (p) {
      s.bar.append(h("button", { type: "button", class: "p3d-tag" + (fil.period === p[0] ? " is-on" : ""), text: p[1],
        onclick: function () { fil.period = p[0]; loadFilament(); } }));
    });
    s.body.innerHTML = "";
    var tiles = [
      ["Filament utilisé", fmtGrams(t.g)], ["Longueur", fmtMetres(t.m)], ["Coût estimé", money(t.cost, cur)],
      ["Impressions", fmtInt(t.jobs) + (t.without_data ? " (" + t.without_data + " sans chiffre)" : "")],
      ["Perdu (échecs / arrêts)", fmtGrams(t.wasted_g) + " · " + money(t.wasted_cost, cur)],
      ["Coût moyen", t.with_data ? money(t.cost / t.with_data, cur) : "–"],
    ];
    var kpis = h("div", { class: "p3d-kpis" });
    tiles.forEach(function (x) { kpis.append(h("div", { class: "p3d-kpi" }, [h("span", { class: "p3d-kpi-label", text: x[0] }), h("strong", { text: x[1] })])); });
    s.body.append(kpis);
    if (!t.jobs) s.body.append(h("p", { class: "p3d-help", text: "Aucune impression enregistrée sur cette période. Les prochaines s'ajoutent toutes seules : HQ lit les chiffres du fichier tranché (grammes et mètres par filament), ou l'estimation de l'imprimante, et réduit selon l'avancement si elle s'arrête." }));
    var chart = barChart(d.by_day || []);
    if (chart) s.body.append(h("div", { class: "p3d-chart" }, [h("span", { class: "p3d-kpi-label", text: "Grammes par jour" }), chart]));

    function table(head, rows) {
      var tb = h("tbody");
      rows.forEach(function (r) { tb.append(h("tr", {}, r.map(function (c) { return h("td", { text: c }); }))); });
      return h("div", { class: "p3d-table-wrap" }, [h("table", { class: "p3d-table" }, [
        h("thead", {}, [h("tr", {}, head.map(function (x) { return h("th", { text: x }); }))]), tb])]);
    }
    if ((d.by_material || []).length) {
      s.body.append(h("h3", { class: "p3d-h3", text: "Par matériau" }), table(["Matériau", "Poids", "Longueur", "Prix / kg", "Coût"],
        d.by_material.map(function (m) { return [m.material, fmtGrams(m.g), fmtMetres(m.m), money(m.price_kg, cur), money(m.cost, cur)]; })));
    }
    if ((d.by_printer || []).length) {
      s.body.append(h("h3", { class: "p3d-h3", text: "Par imprimante" }), table(["Imprimante", "Impressions", "Poids", "Longueur", "Coût"],
        d.by_printer.map(function (m) { return [m.printer, String(m.jobs), fmtGrams(m.g), fmtMetres(m.m), money(m.cost, cur)]; })));
    }
    if ((d.recent || []).length) {
      var tb = h("tbody");
      d.recent.forEach(function (j) {
        var f = j.filament;
        var actBtns = [h("button", { type: "button", class: "p3d-btn is-small", text: f ? "Corriger" : "Saisir", onclick: function () { editJob(j); } })];
        if (j.curve && j.curve.length) {
          actBtns.push(h("button", { type: "button", class: "p3d-btn is-small", text: "Courbe", onclick: function () {
            var w = 320, ht = 120, n = j.curve.length;
            function pathOf(key, maxV) {
              return j.curve.map(function (c, i) {
                var x = n === 1 ? 0 : (i / (n - 1)) * w;
                var val = typeof c[key] === "number" ? c[key] : 0;
                var y = ht - 8 - Math.max(0, Math.min(1, val / maxV)) * (ht - 16);
                return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
              }).join(" ");
            }
            var svg = s("svg", { class: "p3d-spark", viewBox: "0 0 " + w + " " + ht, role: "img", "aria-label": "Courbe buse, plateau et progression" }, [
              s("path", { d: pathOf("nozzle", 300), fill: "none", stroke: "#f59e0b", "stroke-width": "2" }),
              s("path", { d: pathOf("bed", 120), fill: "none", stroke: "#06b6d4", "stroke-width": "2" }),
              s("path", { d: pathOf("pct", 100), fill: "none", stroke: "#8b5cf6", "stroke-width": "1.6", "stroke-dasharray": "4 3" }),
            ]);
            openOverlay(h("div", { class: "p3d-model-detail" }, [
              h("h3", { text: "Télémétrie · " + (j.job || "Impression") }),
              h("p", { class: "p3d-meta", text: n + " points · Ambre = Buse (0–300°C) · Cyan = Plateau (0–120°C) · Violet = %" }),
              svg,
            ]));
          } }));
        }
        actBtns.push(h("button", { type: "button", class: "p3d-btn is-small",
          text: j.cost_breakdown ? ("Total " + money(j.cost_breakdown.total, cur)) : "Comptabiliser",
          onclick: function () {
            post("/api/print3d/history/log_cost", { id: j.id })
              .then(function (res) { toast("Coût total : " + money(res.job.cost_breakdown.total, cur)); loadFilament(); })
              .catch(function (e) { toast(e.message, "err"); });
          } }));
        if (j.timelapse) {
          actBtns.push(h("a", { class: "p3d-btn is-small", href: "/api/print3d/timelapse/" + encodeURIComponent(j.timelapse), target: "_blank", text: "Timelapse" }));
        }
        tb.append(h("tr", {}, [
          h("td", { text: (j.job || "Impression") + " · " + (j.printer_name || "") + " · " + fmtAgo(j.at) }),
          h("td", { text: OUTCOME_LABEL[j.outcome] || j.outcome }),
          h("td", { text: f ? fmtGrams(f.g) : "–" }), h("td", { text: f ? fmtMetres(f.m) : "–" }),
          h("td", { text: f ? money(f.cost, cur) : "–" }),
          h("td", { class: "p3d-src", text: f ? (SOURCE_LABEL[f.source] || f.source) : "pas de chiffre" }),
          // A job with no figure is exactly the one worth correcting: never hide the button here.
          h("td", { class: "p3d-ctl-row" }, actBtns),
        ]));
      });
      s.body.append(h("h3", { class: "p3d-h3", text: "Dernières impressions" }), h("div", { class: "p3d-table-wrap" }, [
        h("table", { class: "p3d-table" }, [h("thead", {}, [h("tr", {}, ["Impression", "Résultat", "Poids", "Longueur", "Coût", "Source", ""].map(function (x) { return h("th", { text: x }); }))]), tb])]));
    }
    var spoolBox = h("div", { class: "p3d-spools" });
    s.body.append(h("h3", { class: "p3d-h3", text: "Registre des bobines" }), spoolBox);
    api("/api/print3d/spools").then(function (sr) {
      spoolBox.innerHTML = "";
      var list = sr.spools || [];
      if (!list.length) spoolBox.append(h("p", { class: "p3d-help", text: "Aucune bobine enregistrée. Ajoute une bobine pour suivre les grammes restants automatiquement." }));
      list.forEach(function (sp) {
        spoolBox.append(h("div", { class: "p3d-spool-row" }, [
          h("span", { class: "p3d-slot" }, [h("i", { style: "background:" + sp.colour }), sp.name + " (" + sp.material + ")"]),
          h("strong", { text: num(sp.remaining_g, 0) + " / " + num(sp.initial_g, 0) + " g" }),
          sp.inventoria_id ? h("span", { class: "p3d-meta", text: "Inv: " + sp.inventoria_id }) : null,
          h("button", { type: "button", class: "p3d-btn is-small", text: "Supprimer", onclick: function () {
            post("/api/print3d/spools/delete", { id: sp.id }).then(renderFilament).catch(function (e) { toast(e.message, "err"); });
          } }),
        ]));
      });
      var spName = h("input", { class: "p3d-input", placeholder: "Nom bobine (ex: Bambu Matte Noir)" });
      var spMat = h("input", { class: "p3d-input p3d-ctl-num", value: "PLA", placeholder: "Matériau" });
      var spRem = h("input", { class: "p3d-input p3d-ctl-num", type: "number", value: "1000", placeholder: "g restants" });
      var spInv = h("input", { class: "p3d-input p3d-ctl-num", placeholder: "ID Inventoria (opt.)" });
      spoolBox.append(h("div", { class: "p3d-ctl-row" }, [
        spName, spMat, spRem, spInv,
        h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Ajouter bobine", onclick: function () {
          post("/api/print3d/spools/save", { name: spName.value, material: spMat.value, remaining_g: Number(spRem.value || 1000), inventoria_id: spInv.value })
            .then(function () { toast("Bobine enregistrée"); renderFilament(); })
            .catch(function (e) { toast(e.message, "err"); });
        } }),
      ]));
    }).catch(function () { });
    renderPrices(s, d.settings || {});
  }

  // Built once: a period switch must not throw away prices that were typed but not saved yet.
  function renderPrices(s, set) {
    if (s.priceSet) return;
    s.priceSet = true;
    var rowsEl = h("div", { class: "p3d-price-rows" });
    function priceRow(name, price) {
      var n = h("input", { class: "p3d-input", value: name || "", placeholder: "PLA", maxlength: "16" });
      var v = h("input", { class: "p3d-input", type: "number", min: "0", max: "1000", step: "0.01", value: price == null ? "" : String(price), placeholder: "prix / kg" });
      var row = h("div", { class: "p3d-price-row" }, [n, v, h("button", { type: "button", class: "p3d-btn is-small", "aria-label": "Retirer", text: "✕", onclick: function () { row.remove(); } })]);
      row._get = function () { return [n.value.trim().toUpperCase(), v.value]; };
      return row;
    }
    Object.keys(set.prices || {}).forEach(function (k) { rowsEl.append(priceRow(k, set.prices[k])); });
    var currency = h("input", { class: "p3d-input", value: set.currency || "$", maxlength: "4" });
    var defPrice = h("input", { class: "p3d-input", type: "number", min: "0", max: "1000", step: "0.01", value: String(set.default_price_kg == null ? 25 : set.default_price_kg) });
    var spool = h("input", { class: "p3d-input", type: "number", min: "100", max: "10000", step: "10", value: String(set.spool_g || 1000) });
    s.price.append(h("h3", { class: "p3d-h3", text: "Prix du filament" }), h("form", { class: "p3d-form", onsubmit: function (e) {
      var prices = {};
      [].slice.call(rowsEl.children).forEach(function (r) { var kv = r._get(); if (kv[0] && kv[1] !== "") prices[kv[0]] = Number(kv[1]); });
      busyForm(e, "Enregistrement…", function () {
        return post("/api/print3d/settings", { filament: { currency: currency.value, default_price_kg: Number(defPrice.value), spool_g: Number(spool.value), prices: prices } })
          .then(function () { toast("Prix enregistrés"); return refresh(); }).then(loadFilament);
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("p", { class: "p3d-help", text: "Le coût est recalculé avec ces prix à chaque lecture : changer un prix met aussi l'historique à jour. Mets ce que tu paies vraiment par kilo ; un matériau absent de la liste utilise le prix par défaut." }),
      h("label", {}, ["Devise", currency]), h("label", {}, ["Prix par défaut ($ / kg)", defPrice]),
      h("label", {}, ["Poids d'une bobine (g) — sert aux bobines AMS", spool]), rowsEl,
      h("div", { class: "p3d-actions" }, [
        h("button", { type: "button", class: "p3d-btn", text: "＋ Matériau", onclick: function () { rowsEl.append(priceRow("", null)); } }),
        h("button", { type: "submit", class: "p3d-btn is-primary", text: "Enregistrer" }),
      ]),
    ]));
  }

  // ── Studio (Préparer / Aperçu) ──
  var studio = {
    mode: "prepare",
    previewMode: "type",
    use2d: false,
    plate: 1,
    printerId: "",
    items: [],
    selected: -1,
    slicedModel: null,
    slicedInfo: null,
    slicedFingerprint: "",
    slicedSettings: null,
    slicedIsExternal: false,
    layersData: null,
    layerIdx: 0,
    yaw: 0.72,
    pitch: 0.56,
    camera: null,
    interactionMode: "auto",
    uidSeq: 1,
    history: { past: [], future: [], max: 50 },
    advancedOpen: false,
    mobileFocus: "prepare",
    project: { id: "", title: "Nouveau plateau", revision: 0, dirty: false, schema_version: 1, warnings: [] },
    loadedMaterials: null,
    schemaByKey: Object.create(null),
    tools: [
      { material: "PLA", color: "#38bdf8", preset: "", station_slot: null, spool_id: "" },
      { material: "PLA", color: "#f97316", preset: "", station_slot: null, spool_id: "" },
      { material: "PLA", color: "#22c55e", preset: "", station_slot: null, spool_id: "" },
      { material: "PLA", color: "#a855f7", preset: "", station_slot: null, spool_id: "" },
    ],
    cfg: {
      quality_preset: "standard",
      speed_preset: "standard",
      plate_type: "textured_pei",
      nozzle: "0.4",
      material: "PLA",
      layer_height: "0.20",
      first_layer_height: "",
      wall_loops: 2,
      top_shell_layers: 5,
      bottom_shell_layers: 3,
      infill: 15,
      infill_pattern: "gyroid",
      seam_position: "aligned",
      ironing_type: "no_ironing",
      wall_generator: "classic",
      outer_wall_speed: "",
      inner_wall_speed: "",
      sparse_infill_speed: "",
      initial_layer_speed: "",
      travel_speed: "",
      default_acceleration: "",
      outer_wall_acceleration: "",
      supports: false,
      support_type: "tree",
      support_on_build_plate_only: false,
      support_threshold_angle: 30,
      support_base_pattern_spacing: 2.5,
      support_interface_top_layers: 2,
      support_interface_filament: 0,
      brim: false,
      brim_type: "outer_only",
      brim_width: 5,
      skirt_loops: 0,
      raft_layers: 0,
      nozzle_temperature_initial_layer: "",
      nozzle_temperature: "",
      bed_temperature_initial_layer: "",
      bed_temperature: "",
      fan_min_speed: "",
      fan_max_speed: "",
      close_fan_the_first_x_layers: "",
      filament_max_volumetric_speed: "",
      prime_tower_enabled: true,
      prime_tower_width: 35,
      prime_tower_x: "",
      prime_tower_y: "",
      flush_multiplier: 1.0,
      flush_into_infill: false,
      flush_into_support: false,
    },
  };

  function qualityPresetDefaults(nozzleStr, preset) {
    var d = Math.max(0.1, Number(nozzleStr || 0.4));
    var minL = Math.max(0.04, Math.round(d * 0.2 * 100) / 100);
    var maxL = Math.round(d * 0.75 * 100) / 100;
    function clampLh(v) { return Math.max(minL, Math.min(maxL, Math.round(v * 100) / 100)).toFixed(2); }
    if (preset === "draft") {
      return { layer_height: clampLh(d * 0.7), first_layer_height: clampLh(d * 0.6), wall_loops: 2, top_shell_layers: 4, bottom_shell_layers: 3, infill: 12 };
    }
    if (preset === "fine") {
      return { layer_height: clampLh(d * 0.3), first_layer_height: clampLh(d * 0.45), wall_loops: 3, top_shell_layers: 6, bottom_shell_layers: 4, infill: 20 };
    }
    return { layer_height: clampLh(d * 0.5), first_layer_height: clampLh(d * 0.5), wall_loops: 2, top_shell_layers: 5, bottom_shell_layers: 3, infill: 15 };
  }

  var STUDIO_TOOL_PALETTE = [
    "#38bdf8", "#f97316", "#22c55e", "#a855f7",
    "#eab308", "#ec4899", "#14b8a6", "#ef4444",
    "#6366f1", "#84cc16", "#f43f5e", "#06b6d4",
    "#d97706", "#8b5cf6", "#10b981", "#64748b",
  ];

  function finiteOr(val, fallback) {
    if (val === null || val === undefined || val === "") return fallback;
    var n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function ensureStudioToolsLen(minCount) {
    var target = Math.max(4, Math.min(16, Number(minCount) || 4));
    while (studio.tools.length < target) {
      var idx = studio.tools.length;
      studio.tools.push({
        material: "PLA",
        color: STUDIO_TOOL_PALETTE[idx % STUDIO_TOOL_PALETTE.length],
        preset: "",
        station_slot: null,
        spool_id: "",
      });
    }
    return studio.tools;
  }

  function studioBuildProjectPayload(selPr, availToolsCount) {
    var maxSavedTools = Math.max(1, Math.min(16, Number(availToolsCount) || 4));
    studio.items.forEach(function (it) {
      var ti = Number(it && it.tool || 0);
      if (Number.isFinite(ti) && ti + 1 > maxSavedTools) maxSavedTools = Math.min(16, ti + 1);
    });
    ensureStudioToolsLen(maxSavedTools);
    return {
      id: (studio.project && studio.project.id) || "",
      title: (studio.project && studio.project.title) || "Nouveau plateau",
      expected_revision: (studio.project && studio.project.revision) ? studio.project.revision : undefined,
      target: {
        printer_model: (selPr && selPr.model) || "",
        printer_id: (selPr && selPr.id) || "",
        nozzle: String(studio.cfg.nozzle || "0.4"),
        plate_type: String(studio.cfg.plate_type || "textured_pei"),
      },
      settings: Object.assign({}, studio.cfg),
      tools: studio.tools.slice(0, maxSavedTools).map(function (t, i) {
        return { slot_label: "T" + i, material: t.material, color: t.color, preset: t.preset || "", station_slot: t.station_slot, spool_id: t.spool_id || "" };
      }),
      prime_tower: {
        enabled: !!studio.cfg.prime_tower_enabled,
        width: Number(studio.cfg.prime_tower_width || 35),
        x: studio.cfg.prime_tower_x === "" ? "" : Number(studio.cfg.prime_tower_x),
        y: studio.cfg.prime_tower_y === "" ? "" : Number(studio.cfg.prime_tower_y),
        flush_multiplier: Number(studio.cfg.flush_multiplier == null ? 1.0 : studio.cfg.flush_multiplier),
        flush_into_infill: !!studio.cfg.flush_into_infill,
        flush_into_support: !!studio.cfg.flush_into_support,
      },
      items: studio.items.map(function (it) {
        return {
          uid: it.uid,
          model_id: it.model_id,
          model_name: it.name,
          local_name: it.localName || it.name,
          ext: it.ext || "stl",
          source_sha256: _SHA256_HEX_RE.test(String(it.sourceVersion || "")) ? String(it.sourceVersion).toLowerCase() : "",
          x: finiteOr(it.x, 128), y: finiteOr(it.y, 128), z: finiteOr(it.z, 0),
          rot_x: finiteOr(it.rot_x, 0), rot_y: finiteOr(it.rot_y, 0), rot_z: finiteOr(it.rot_z, 0),
          scale: finiteOr(it.scale, 1),
          tool: Math.max(0, Math.min(15, Math.trunc(finiteOr(it.tool, 0)))),
          visible: it.visible !== false,
          overrides: it.overrides ? Object.assign({}, it.overrides) : {},
          custom_meta: it.custom_meta ? Object.assign({}, it.custom_meta) : undefined,
        };
      }),
      camera: studio.camera ? Object.assign({}, studio.camera) : null,
      slice_ref: (studio.slicedModel && studio.slicedModel.id) ? {
        sliced_model_id: studio.slicedModel.id,
        fingerprint: studio.slicedFingerprint || "",
      } : null,
    };
  }

  function studioApplyLoadedProject(resp) {
    var prj = resp && resp.project;
    if (!prj) return;
    var integ = (resp && resp.integrity) || {};
    var tgt = prj.target || {};
    var printers = (data.config && data.config.printers) || [];
    if (tgt.printer_id && printers.some(function (p) { return p.id === tgt.printer_id; })) {
      studio.printerId = tgt.printer_id;
    } else if (tgt.printer_model) {
      var byMod = printers.find(function (p) { return p.model === tgt.printer_model; });
      if (byMod) studio.printerId = byMod.id;
    }
    if (prj.settings && typeof prj.settings === "object") {
      studio.cfg = Object.assign({}, studio.cfg, prj.settings);
    }
    if (Array.isArray(prj.tools)) {
      ensureStudioToolsLen(prj.tools.length);
      prj.tools.slice(0, 16).forEach(function (t, i) {
        if (t && studio.tools[i]) {
          studio.tools[i] = Object.assign({}, studio.tools[i], {
            material: t.material || "PLA",
            color: t.color || studio.tools[i].color,
            preset: t.preset || "",
            station_slot: t.station_slot != null ? t.station_slot : null,
            spool_id: t.spool_id || "",
          });
        }
      });
    }
    var store = ensureMeshStore();
    var warnings = [];
    studio.items = (prj.items || []).map(function (it, idx) {
      var mid = it.resolved_model_id || it.model_id;
      var status = it.source_status || "ok";
      var shaNow = it.current_sha256 || it.source_sha256 || "";
      if (status === "replaced") {
        warnings.push((it.local_name || it.model_name || mid) + " : fichier source remplacé sur disque (géométrie rechargée).");
        if (store && typeof store.invalidate === "function") store.invalidate(mid);
        delete stlDimsCache[mid];
      } else if (status === "unverifiable") {
        warnings.push((it.local_name || it.model_name || mid) + " : empreinte SHA-256 source absente ou non vérifiable (géométrie rechargée).");
        if (store && typeof store.invalidate === "function") store.invalidate(mid);
        delete stlDimsCache[mid];
      } else if (status === "missing") {
        warnings.push((it.local_name || it.model_name || mid) + " : modèle introuvable dans la bibliothèque.");
      }
      var dims = Array.isArray(it.current_bounds_mm) && it.current_bounds_mm.length >= 3 ? it.current_bounds_mm : null;
      return {
        uid: Number(it.uid || (studio.uidSeq++) || (idx + 1)),
        model_id: mid,
        sourceVersion: shaNow,
        name: it.model_name || mid,
        localName: it.local_name || it.model_name || mid,
        ext: it.ext || "stl",
        x: finiteOr(it.x, 128), y: finiteOr(it.y, 128), z: finiteOr(it.z, 0),
        rot_x: finiteOr(it.rot_x, 0), rot_y: finiteOr(it.rot_y, 0), rot_z: finiteOr(it.rot_z, 0),
        scale: finiteOr(it.scale, 1),
        tool: Math.max(0, Math.min(15, Math.trunc(finiteOr(it.tool, 0)))),
        dx: dims ? Number(dims[0]) : 36, dy: dims ? Number(dims[1]) : 36, dz: dims ? Number(dims[2]) : 24,
        visible: it.visible !== false,
        loadState: status === "missing" ? "error" : (String(it.ext || "stl").toLowerCase() === "stl" ? "loading" : "unsupported"),
        loadError: status === "missing" ? "Modèle introuvable" : "",
        boundsReady: !!dims,
        sourceStatus: status,
        overrides: it.overrides ? Object.assign({}, it.overrides) : {},
        custom_meta: it.custom_meta ? Object.assign({}, it.custom_meta) : undefined,
      };
    });
    studio.selected = studio.items.length ? 0 : -1;
    studio.camera = prj.camera || null;
    studio.project = {
      id: prj.id || "",
      title: prj.title || "Projet",
      revision: Number(prj.revision || 1),
      dirty: false,
      schema_version: Number(prj.schema_version || 1),
      warnings: warnings,
    };
    studio.history.past = [];
    studio.history.future = [];
    // Never mark reopened project print-ready without server provenance confirmation
    studio.slicedModel = null;
    studio.slicedInfo = null;
    studio.slicedFingerprint = "";
    studio.slicedSettings = null;
    studio.slicedIsExternal = false;
    studio.mode = "prepare";
    if (!integ.slice_valid && (prj.slice_ref && prj.slice_ref.sliced_model_id)) {
      warnings.push("Ancien tranchage invalidé (" + (integ.slice_reason || "ré-tranchage requis") + ").");
    }
    var seenLoadingIds = Object.create(null);
    studio.items.forEach(function (row) {
      if (row.loadState !== "loading" || !row.model_id || seenLoadingIds[row.model_id]) return;
      seenLoadingIds[row.model_id] = true;
      var m = (data.models || []).find(function (x) { return x && x.id === row.model_id; }) || {
        id: row.model_id,
        name: row.name,
        ext: row.ext,
        sha256: row.sourceVersion || "",
      };
      reacquireStudioStl(m, row.sourceVersion || "", row.sourceStatus === "replaced" || row.sourceStatus === "unverifiable");
    });
  }

  function getPrepareApi() {
    return (typeof window !== "undefined" && window.HQPrepare) ? window.HQPrepare : null;
  }

  function ensureMeshStore() {
    if (studioMeshStore) return studioMeshStore;
    var prep = getPrepareApi();
    if (prep && typeof prep.createMeshStore === "function") {
      studioMeshStore = prep.createMeshStore({ fetchStl: fetchStl });
    }
    return studioMeshStore;
  }

  function cloneStudioItems(list) {
    return (list || []).map(function (it) {
      var copy = Object.assign({}, it);
      if (it && it.overrides && typeof it.overrides === "object") copy.overrides = Object.assign({}, it.overrides);
      if (it && it.custom_meta && typeof it.custom_meta === "object") copy.custom_meta = Object.assign({}, it.custom_meta);
      return copy;
    });
  }

  function pushStudioHistory(label) {
    var snap = {
      items: cloneStudioItems(studio.items),
      selected: studio.selected,
      label: label || "Modification",
    };
    studio.history.past.push(snap);
    if (studio.history.past.length > studio.history.max) {
      studio.history.past.shift();
    }
    studio.history.future = [];
  }

  function invalidateStudioSliceGlobal() {
    studio.sliceSeq = (studio.sliceSeq || 0) + 1;
    if (studio.project) studio.project.dirty = true;
    if (studio.slicedIsExternal) return;
    studio.slicedModel = null;
    studio.slicedInfo = null;
    studio.slicedFingerprint = "";
    studio.slicedSettings = null;
    studio.layersData = null;
  }

  function applyHistorySnapshot(fromArr, toArr) {
    if (!fromArr || !fromArr.length) return false;
    toArr.push({ items: cloneStudioItems(studio.items), selected: studio.selected, label: "" });
    if (toArr.length > studio.history.max) toArr.shift();
    var snap = fromArr.pop();
    studio.items = cloneStudioItems(snap.items);
    studio.selected = studio.items.length ? Math.min(snap.selected, studio.items.length - 1) : -1;
    var store = ensureMeshStore();
    if (store) {
      studio.items.forEach(function (it) {
        if (it.model_id && !store.getCached(it.model_id, it.sourceVersion || undefined) && String(it.ext || "").toLowerCase() === "stl") {
          store.acquire({ id: it.model_id, name: it.name, ext: it.ext || "stl", source_sha256: it.sourceVersion || "" }, { version: it.sourceVersion || "" }).catch(function () {});
        }
      });
    }
    invalidateStudioSliceGlobal();
    if (tab === "studio") renderStudio();
    return true;
  }

  function undoStudio() {
    return applyHistorySnapshot(studio.history.past, studio.history.future);
  }

  function redoStudio() {
    return applyHistorySnapshot(studio.history.future, studio.history.past);
  }

  var studioUploadEls = null;
  var studioUploadStatus = null;

  function renderStudioUploadBar() {
    if (!studioUploadEls || !studioUploadEls.bar) return;
    if (!studioUploadStatus || studioUploadStatus.hidden) {
      studioUploadEls.bar.hidden = true;
      studioUploadEls.bar.classList.remove("is-error");
      return;
    }
    studioUploadEls.bar.hidden = false;
    studioUploadEls.bar.classList.toggle("is-error", !!studioUploadStatus.error);
    studioUploadEls.fill.style.width = Math.max(0, Math.min(100, studioUploadStatus.pct || 0)).toFixed(1) + "%";
    studioUploadEls.label.textContent = studioUploadStatus.label || "";
    if (studioUploadEls.cancel) studioUploadEls.cancel.hidden = !studioUploadStatus.canCancel;
  }

  function hasDragFiles(ev) {
    var dt = ev && ev.dataTransfer;
    if (!dt) return false;
    if (!dt.types) return !!(dt.files && dt.files.length);
    return Array.prototype.indexOf.call(dt.types, "Files") !== -1;
  }

  function openFilesInStudio(fileList) {
    var raw = Array.prototype.slice.call(fileList || []);
    if (!raw.length) return;
    var accepted = raw.filter(function (f) { return !!MODEL_ALLOWED_EXT[extOfName(f && f.name)]; });
    if (!accepted.length) {
      toast("Format non supporté — dépose un .stl, .glb, .3mf, .gcode ou .gx.", "err");
      return;
    }
    if (uploadBusy) { toast("Un envoi est déjà en cours", "err"); return; }
    var preferPreview = studio.mode === "preview";
    studioUploadStatus = { hidden: false, error: false, pct: 0, label: "Préparation…", canCancel: true };
    renderStudioUploadBar();
    uploadFiles(accepted, {
      onProgress: function (msg, pct) {
        studioUploadStatus = { hidden: false, error: false, pct: pct || 0, label: msg, canCancel: true };
        renderStudioUploadBar();
      },
      onDone: function (uploadedInfos) {
        studioUploadStatus = { hidden: false, error: false, pct: 100, label: "Indexation dans le Studio…", canCancel: false };
        renderStudioUploadBar();
        return post("/api/print3d/models/rescan").catch(function () { return null; }).then(function () {
          return api("/api/print3d/models?limit=500").then(function (res) {
            var rows = (res && res.models) || [];
            models.list = rows;
            syncStudioSourceVersions(rows);
            models.tags = (res && res.tags) || models.tags;
            models.total = (res && res.total) || rows.length;
            models.indexed = (res && res.indexed) || rows.length;
            models.key = "";
            models.at = Date.now();
            loaded.models = true;
            studioUploadStatus = null;
            renderStudioUploadBar();
            var matched = [];
            (uploadedInfos || []).forEach(function (info) {
              var found = rows.find(function (m) {
                if (info.rel && m.rel && ("Print/" + m.rel === info.rel || m.rel === info.rel)) return true;
                return m.name === info.name || m.name === info.fileName;
              });
              if (found && matched.indexOf(found) === -1) matched.push(found);
            });
            if (!matched.length) {
              toast("Fichier ajouté dans Modèles ; clique sur « + Ajouter » pour le charger.");
              return;
            }
            matched.forEach(function (m, idx) {
              addToStudio(m, { preferPreview: preferPreview || (idx === 0 && matched.length === 1 && studio.mode === "preview") });
            });
          });
        }).catch(function (err) {
          studioUploadStatus = { hidden: false, error: true, pct: 0, label: "Échec indexation : " + err.message, canCancel: false };
          renderStudioUploadBar();
        });
      },
      onError: function (err, stopped) {
        studioUploadStatus = {
          hidden: false,
          error: !stopped,
          pct: 0,
          label: stopped ? "Téléversement annulé" : ("Échec : " + err.message),
          canCancel: false,
        };
        renderStudioUploadBar();
      },
    });
  }

  function bindStudioDrop(pane) {
    if (!pane || pane._p3dDropBound) return;
    pane._p3dDropBound = true;
    var dragDepth = 0;
    pane.classList.add("p3d-studio-pane");
    pane.addEventListener("dragenter", function (ev) {
      if (!hasDragFiles(ev)) return;
      ev.preventDefault();
      dragDepth += 1;
      pane.classList.add("is-dragover");
    });
    pane.addEventListener("dragover", function (ev) {
      if (!hasDragFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      pane.classList.add("is-dragover");
    });
    pane.addEventListener("dragleave", function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) pane.classList.remove("is-dragover");
    });
    pane.addEventListener("drop", function (ev) {
      dragDepth = 0;
      pane.classList.remove("is-dragover");
      ev.preventDefault();
      ev.stopPropagation();
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) openFilesInStudio(files);
    });
  }

  var stlDimsCache = Object.create(null);

  var _SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

  function modelSourceVersion(m) {
    if (!m || typeof m !== "object") return "";
    if (m.source_sha256) return String(m.source_sha256).trim();
    if (m.version) return String(m.version).trim();
    if (m.size != null && m.mtime != null) return String(m.size) + ":" + String(m.mtime);
    return "";
  }

  function getCachedDims(modelId, ver) {
    var entry = stlDimsCache[modelId];
    if (!entry) return null;
    if (Array.isArray(entry)) return ver ? null : entry;
    if (ver && entry.version && entry.version !== ver) {
      delete stlDimsCache[modelId];
      return null;
    }
    return entry.dims || null;
  }

  function setCachedDims(modelId, dims, ver) {
    if (!dims || dims.length < 3) return;
    stlDimsCache[modelId] = { version: ver || "", dims: dims.slice(0, 3) };
  }

  function extractParsedDims(parsed) {
    if (!parsed) return null;
    if (parsed.bounds && Array.isArray(parsed.bounds.min) && Array.isArray(parsed.bounds.max)) {
      return [
        Math.max(0.5, Number(parsed.bounds.max[0]) - Number(parsed.bounds.min[0])),
        Math.max(0.5, Number(parsed.bounds.max[1]) - Number(parsed.bounds.min[1])),
        Math.max(0.5, Number(parsed.bounds.max[2]) - Number(parsed.bounds.min[2])),
      ];
    }
    if (Array.isArray(parsed.size) && parsed.size.length >= 3) {
      return [
        Math.max(0.5, Number(parsed.size[0])),
        Math.max(0.5, Number(parsed.size[1])),
        Math.max(0.5, Number(parsed.size[2])),
      ];
    }
    if (Array.isArray(parsed.dims_mm) && parsed.dims_mm.length >= 3) {
      return [
        Math.max(0.5, Number(parsed.dims_mm[0])),
        Math.max(0.5, Number(parsed.dims_mm[1])),
        Math.max(0.5, Number(parsed.dims_mm[2])),
      ];
    }
    return null;
  }

  function itemFootprintCorners(it) {
    var prep = getPrepareApi();
    if (prep) return prep.itemFootprintCorners(it);
    var hw = (Number(it.dx || 20) * Number(it.scale || 1)) * 0.5;
    var hd = (Number(it.dy || 20) * Number(it.scale || 1)) * 0.5;
    var rad = (Number(it.rot_z || 0) * Math.PI) / 180;
    var cs = Math.cos(rad), sn = Math.sin(rad);
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(function (pt) {
      return [it.x + pt[0] * cs - pt[1] * sn, it.y + pt[0] * sn + pt[1] * cs];
    });
  }

  function itemRotatedSpan(it) {
    var prep = getPrepareApi();
    if (prep) return prep.itemRotatedSpan(it);
    var rad = (Number(it.rot_z || 0) * Math.PI) / 180;
    var ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    var w = Number(it.dx || 20) * Number(it.scale || 1);
    var d = Number(it.dy || 20) * Number(it.scale || 1);
    return [w * ca + d * sa, w * sa + d * ca];
  }

  function itemBelowPlate(it) {
    var prep = getPrepareApi();
    if (prep && typeof prep.itemBelowPlate === "function") return prep.itemBelowPlate(it);
    return Number(it && it.z || 0) < -0.01;
  }

  function itemElevated(it) {
    var prep = getPrepareApi();
    if (prep && typeof prep.itemElevated === "function") return prep.itemElevated(it);
    return Number(it && it.z || 0) > 0.01;
  }

  function itemOutOfBounds(it, bed) {
    var prep = getPrepareApi();
    if (prep) return prep.itemOutOfBounds(it, bed);
    var corners = itemFootprintCorners(it);
    var hz = Math.max(0, Number(it.z || 0)) + Number(it.dz || 20) * Number(it.scale || 1);
    if (hz > Number(bed.z || 256) + 0.25) return true;
    for (var i = 0; i < corners.length; i++) {
      if (corners[i][0] < -0.25 || corners[i][0] > bed.x + 0.25 || corners[i][1] < -0.25 || corners[i][1] > bed.y + 0.25) {
        return true;
      }
    }
    return false;
  }

  function itemsCollide(a, b) {
    var prep = getPrepareApi();
    if (prep) return prep.itemsCollide(a, b);
    var c1 = itemFootprintCorners(a);
    var c2 = itemFootprintCorners(b);
    var polys = [c1, c2];
    for (var p = 0; p < 2; p++) {
      var poly = polys[p];
      for (var i = 0; i < 4; i++) {
        var q0 = poly[i], q1 = poly[(i + 1) % 4];
        var ex = q1[0] - q0[0], ey = q1[1] - q0[1];
        var el = Math.hypot(ex, ey);
        if (el <= 1e-6) continue;
        var nx = -ey / el, ny = ex / el;
        var min1 = 1e9, max1 = -1e9, min2 = 1e9, max2 = -1e9;
        for (var k = 0; k < 4; k++) {
          var v1 = c1[k][0] * nx + c1[k][1] * ny;
          if (v1 < min1) min1 = v1;
          if (v1 > max1) max1 = v1;
          var v2 = c2[k][0] * nx + c2[k][1] * ny;
          if (v2 < min2) min2 = v2;
          if (v2 > max2) max2 = v2;
        }
        var overlap = Math.min(max1, max2) - Math.max(min1, min2);
        if (overlap <= 0.5) return false;
      }
    }
    return true;
  }

  function syncItemTiltedDims(it, meshData) {
    var prep = getPrepareApi();
    if (!it || !meshData || !meshData.positions || !prep) return null;
    var stats = prep.computeTiltedStats(meshData.positions, meshData.rawBounds, 1.0, it.rot_x || 0, it.rot_y || 0, meshData);
    it.dx = Math.max(0.5, stats.dims[0]);
    it.dy = Math.max(0.5, stats.dims[1]);
    it.dz = Math.max(0.5, stats.dims[2]);
    it.boundsReady = true;
    return prep.computeTiltedStats(meshData.positions, meshData.rawBounds, it.scale || 1.0, it.rot_x || 0, it.rot_y || 0, meshData);
  }

  function studioPlacementIssues(bed) {
    var oob = [];
    var belowPlate = [];
    var elevated = [];
    var unsupported = [];
    var collideSet = Object.create(null);
    var pairs = [];
    for (var i = 0; i < studio.items.length; i++) {
      var it = studio.items[i];
      if (it.ext && String(it.ext).toLowerCase() !== "stl" && (studio.items.length > 1 || Math.abs(Number(it.rot_z || 0)) > 1e-3 || Math.abs(Number(it.rot_x || 0)) > 1e-3 || Math.abs(Number(it.rot_y || 0)) > 1e-3 || Math.abs(Number(it.scale || 1) - 1) > 1e-3)) {
        unsupported.push(i);
      }
      if (itemBelowPlate(it)) belowPlate.push(i);
      if (itemElevated(it)) elevated.push(i);
      if (itemOutOfBounds(it, bed)) oob.push(i);
      for (var j = i + 1; j < studio.items.length; j++) {
        if (itemsCollide(it, studio.items[j])) {
          collideSet[i] = true;
          collideSet[j] = true;
          pairs.push([i, j]);
        }
      }
    }
    return { oob: oob, belowPlate: belowPlate, elevated: elevated, unsupported: unsupported, collideSet: collideSet, pairs: pairs };
  }

  function autoArrangeStudioItems(bed) {
    if (!studio.items.length) return { fitsAll: true, overflowCount: 0 };
    var gap = 10, margin = 10;
    var usableW = Math.max(20, Number(bed.x || 256) - margin * 2);
    var usableD = Math.max(20, Number(bed.y || 256) - margin * 2);
    var entries = studio.items.map(function (it, idx) {
      var sp = itemRotatedSpan(it);
      return { it: it, idx: idx, w: sp[0], d: sp[1] };
    });
    // Deterministic stable sort: taller rows first, break ties by original order
    entries.sort(function (a, b) { return (b.d - a.d) || (b.w - a.w) || (a.idx - b.idx); });
    var rows = [], curRow = { items: [], w: 0, h: 0 };
    entries.forEach(function (e) {
      var addW = curRow.items.length ? (e.w + gap) : e.w;
      if (curRow.items.length && (curRow.w + addW) > usableW) {
        rows.push(curRow);
        curRow = { items: [], w: 0, h: 0 };
      }
      curRow.items.push(e);
      curRow.w += (curRow.items.length > 1 ? gap : 0) + e.w;
      if (e.d > curRow.h) curRow.h = e.d;
    });
    if (curRow.items.length) rows.push(curRow);
    var totalH = rows.reduce(function (s, r) { return s + r.h; }, 0) + Math.max(0, rows.length - 1) * gap;
    var overflowCount = 0;
    var curY = Math.max(margin, (bed.y - totalH) * 0.5);
    rows.forEach(function (r) {
      var curX = Math.max(margin, (bed.x - r.w) * 0.5);
      r.items.forEach(function (entry) {
        entry.it.x = Math.round((curX + entry.w * 0.5) * 10) / 10;
        entry.it.y = Math.round((curY + r.h * 0.5) * 10) / 10;
        entry.it.z = Math.max(0, Number(entry.it.z || 0));
        if (itemOutOfBounds(entry.it, bed)) overflowCount += 1;
        curX += entry.w + gap;
      });
      curY += r.h + gap;
    });
    return { fitsAll: overflowCount === 0 && totalH <= usableD + 0.5, overflowCount: overflowCount };
  }

  var studioRefreshLive = null;

  function reacquireStudioStl(m, newVer, forceFetch) {
    var store = ensureMeshStore();
    if (!m || !m.id || !store || !window.HQModel) return Promise.resolve(null);
    var reqVer = newVer || modelSourceVersion(m) || "";
    return store.acquire(m, {
      version: reqVer,
      force: !!forceFetch,
    }).then(function (parsedMesh) {
      if (!parsedMesh || !parsedMesh.rawBounds) return null;
      var effectiveVer = (parsedMesh && parsedMesh.sourceVersion) || reqVer;
      setCachedDims(m.id, parsedMesh.rawBounds.dims, effectiveVer);
      var anyUpdated = false;
      studio.items.forEach(function (row) {
        if (row.model_id === m.id) {
          row.loadState = "ready";
          row.loadError = "";
          if (effectiveVer) row.sourceVersion = effectiveVer;
          syncItemTiltedDims(row, parsedMesh);
          anyUpdated = true;
        }
      });
      if (anyUpdated && tab === "studio" && studio.mode === "prepare") {
        if (typeof studioRefreshLive === "function") studioRefreshLive();
        else renderStudio();
      }
      return parsedMesh;
    }).catch(function (err) {
      if (err && err.name === "AbortError") return null;
      studio.items.forEach(function (row) {
        if (row.model_id === m.id && row.loadState === "loading") {
          row.loadState = "error";
          row.loadError = (err && err.message) || "Erreur chargement STL";
        }
      });
      if (typeof studioRefreshLive === "function" && tab === "studio" && studio.mode === "prepare") {
        studioRefreshLive();
      }
      return null;
    });
  }

  function syncStudioSourceVersions(rows, opts) {
    if (!Array.isArray(rows) || !studio.items.length) return false;
    var byId = Object.create(null);
    rows.forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    var store = ensureMeshStore();
    var invalidatedIds = Object.create(null);
    var changedAny = false;
    var toReacquire = [];
    studio.items.forEach(function (it) {
      var m = byId[it.model_id];
      if (!m) return;
      var newVer = modelSourceVersion(m);
      var oldVer = String(it.sourceVersion || "");
      var forceReload = !!(opts && opts.forceInvalidation && newVer && oldVer !== newVer);
      if (newVer && !oldVer) {
        it.sourceVersion = newVer;
      } else if ((newVer && oldVer && newVer !== oldVer) || forceReload) {
        changedAny = true;
        it.sourceVersion = newVer;
        it.boundsReady = false;
        if (Array.isArray(m.bounds_mm) && m.bounds_mm.length >= 3) {
          it.dx = Math.max(0.5, Number(m.bounds_mm[0]));
          it.dy = Math.max(0.5, Number(m.bounds_mm[1]));
          it.dz = Math.max(0.5, Number(m.bounds_mm[2]));
          setCachedDims(m.id, m.bounds_mm, newVer);
        }
        if (!invalidatedIds[m.id]) {
          invalidatedIds[m.id] = true;
          delete stlDimsCache[m.id];
          if (store && typeof store.invalidate === "function") store.invalidate(m.id);
          if (String(it.ext || "").toLowerCase() === "stl") toReacquire.push({ m: m, ver: newVer });
        }
        if (String(it.ext || "").toLowerCase() === "stl") {
          it.loadState = "loading";
          it.loadError = "";
        }
      }
    });
    if (changedAny) {
      invalidateStudioSliceGlobal();
      toReacquire.forEach(function (entry) { reacquireStudioStl(entry.m, entry.ver, true); });
      if (tab === "studio" && studio.mode === "prepare") {
        if (typeof studioRefreshLive === "function") studioRefreshLive();
        else renderStudio();
      }
    }
    return changedAny;
  }

  function addToStudio(m, opts) {
    var preferPreview = !!(opts && opts.preferPreview);
    var ext = String(m.ext || "").toLowerCase();
    if (ext === "gcode" || ext === "gx") {
      studio.slicedModel = m;
      studio.slicedInfo = null;
      studio.slicedFingerprint = "";
      studio.slicedSettings = null;
      studio.slicedIsExternal = true;
      studio.plate = 1;
      studio.use2d = false;
      studio.mode = "preview";
      setTab("studio");
      api("/api/print3d/models/inspect?id=" + encodeURIComponent(m.id)).then(function (res) {
        if (studio.slicedModel && studio.slicedModel.id === m.id && res && res.info) {
          studio.slicedInfo = res.info;
          if (tab === "studio" && studio.mode === "preview") renderStudio();
        }
      }).catch(function () { });
      return;
    }
    studio.slicedModel = null;
    studio.slicedInfo = null;
    studio.slicedFingerprint = "";
    studio.slicedSettings = null;
    studio.slicedIsExternal = false;
    var bed = studioBed();
    var srcVer = modelSourceVersion(m);
    var store = ensureMeshStore();
    var hadMismatch = false;
    studio.items.forEach(function (existing) {
      if (existing.model_id === m.id && srcVer && existing.sourceVersion && existing.sourceVersion !== srcVer) {
        hadMismatch = true;
      }
    });
    if (hadMismatch) {
      delete stlDimsCache[m.id];
      if (store && typeof store.invalidate === "function") store.invalidate(m.id);
      studio.items.forEach(function (existing) {
        if (existing.model_id === m.id) {
          existing.sourceVersion = srcVer;
          existing.boundsReady = false;
          if (ext === "stl") existing.loadState = "loading";
        }
      });
      invalidateStudioSliceGlobal();
    }
    var knownDims = (Array.isArray(m.bounds_mm) && m.bounds_mm.length >= 3)
      ? m.bounds_mm
      : getCachedDims(m.id, srcVer);
    if (knownDims && srcVer) setCachedDims(m.id, knownDims, srcVer);
    var initDx = knownDims ? Math.max(0.5, Number(knownDims[0])) : 36;
    var initDy = knownDims ? Math.max(0.5, Number(knownDims[1])) : 36;
    var initDz = knownDims ? Math.max(0.5, Number(knownDims[2])) : 24;
    pushStudioHistory("Ajout " + m.name);
    var idx = studio.items.length;
    var spanX = Math.max(initDx + 10, 45);
    var off = (idx % 3 - 1) * Math.min(spanX, Math.max(20, bed.x * 0.25));
    var newItem = {
      uid: studio.uidSeq++,
      model_id: m.id,
      sourceVersion: srcVer,
      name: m.name,
      localName: m.name,
      ext: ext || "stl",
      x: Math.round(bed.x / 2 + off),
      y: Math.round(bed.y / 2 + (Math.floor(idx / 3) * Math.max(initDy + 10, 45))),
      z: 0,
      rot_x: 0,
      rot_y: 0,
      rot_z: 0,
      scale: 1.0,
      tool: 0,
      dx: initDx,
      dy: initDy,
      dz: initDz,
      visible: true,
      overrides: {},
      loadState: ext === "stl" ? "loading" : "unsupported",
      loadError: ext === "stl" ? "" : ("Format ." + (ext || "?") + " non éditable en STL multi-objets."),
      boundsReady: !!knownDims,
    };
    studio.items.push(newItem);
    studio.selected = studio.items.length - 1;
    studio.mode = (ext === "3mf" && preferPreview) ? studio.mode : "prepare";
    setTab("studio");

    function applyDimsForModel(dims, ver) {
      if (!dims || dims.length < 3) return;
      var effVer = ver || srcVer || "";
      setCachedDims(m.id, dims, effVer);
      var changed = false;
      studio.items.forEach(function (it) {
        if (it.model_id === m.id) {
          it.dx = Math.max(0.5, Number(dims[0]));
          it.dy = Math.max(0.5, Number(dims[1]));
          it.dz = Math.max(0.5, Number(dims[2]));
          if (effVer) it.sourceVersion = effVer;
          it.boundsReady = true;
          changed = true;
        }
      });
      if (changed && tab === "studio" && studio.mode === "prepare") {
        if (typeof studioRefreshLive === "function") studioRefreshLive();
        else renderStudio();
      }
    }

    if (ext === "stl") {
      if (window.HQModel && store) {
        var cached = store.getCached(m.id, srcVer || undefined);
        if (cached) {
          store.retain(m.id);
          newItem.loadState = "ready";
          if (cached.sourceVersion && !newItem.sourceVersion) newItem.sourceVersion = cached.sourceVersion;
          applyDimsForModel(cached.rawBounds.dims, cached.sourceVersion || srcVer);
        } else {
          store.acquire(m, {
            version: srcVer,
            force: hadMismatch,
            onProgress: function (prog) {
              if (prog && prog.total > 0) {
                newItem.loadProgress = Math.round((prog.loaded / prog.total) * 100);
              }
            },
          }).then(function (parsedMesh) {
            if (!parsedMesh || !parsedMesh.rawBounds) return;
            var actualVer = (parsedMesh && parsedMesh.sourceVersion) || srcVer || "";
            studio.items.forEach(function (it) {
              if (it.model_id === m.id) {
                it.loadState = "ready";
                it.loadError = "";
                if (actualVer) it.sourceVersion = actualVer;
                syncItemTiltedDims(it, parsedMesh);
              }
            });
            applyDimsForModel(parsedMesh.rawBounds.dims, actualVer);
            if (typeof studioRefreshLive === "function" && tab === "studio" && studio.mode === "prepare") {
              studioRefreshLive();
            }
          }).catch(function (err) {
            if (err && err.name === "AbortError") return;
            studio.items.forEach(function (it) {
              if (it.model_id === m.id && it.loadState === "loading") {
                it.loadState = "error";
                it.loadError = (err && err.message) || "Erreur chargement STL";
              }
            });
            if (!knownDims) {
              api("/api/print3d/models/mesh_check?id=" + encodeURIComponent(m.id)).then(function (res) {
                applyDimsForModel(extractParsedDims(res), srcVer);
              }).catch(function () { });
            } else if (typeof studioRefreshLive === "function" && tab === "studio") {
              studioRefreshLive();
            }
          });
        }
      } else if (!knownDims) {
        newItem.loadState = "ready";
        api("/api/print3d/models/mesh_check?id=" + encodeURIComponent(m.id)).then(function (res) {
          applyDimsForModel(extractParsedDims(res), srcVer);
        }).catch(function () { });
      } else {
        newItem.loadState = "ready";
      }
    } else if (ext === "3mf") {
      api("/api/print3d/models/inspect?id=" + encodeURIComponent(m.id)).then(function (res) {
        if (res && res.info && res.info.kind === "bambu3mf") {
          studio.slicedModel = m;
          studio.slicedInfo = res.info;
          studio.slicedFingerprint = "";
          studio.slicedSettings = null;
          studio.slicedIsExternal = true;
          studio.plate = (res.info.plates && res.info.plates[0]) || 1;
          studio.use2d = false;
          if (preferPreview) studio.mode = "preview";
          if (tab === "studio" && studio.mode === "preview") renderStudio();
        } else if (preferPreview) {
          studio.mode = "prepare";
          if (tab === "studio") renderStudio();
        }
      }).catch(function () { });
    }
  }

  function studioBed() {
    var printers = (data.config && data.config.printers) || [];
    var p = printers.find(function (x) { return x.id === studio.printerId; }) || printers[0];
    if (p && !studio.printerId) studio.printerId = p.id;
    return printerBed(p) || { x: 256, y: 256, z: 256 };
  }

  function renderStudio() {
    var pane = ui.panes.studio;
    if (!pane) return;
    disposeStudioViewer();
    pane.innerHTML = "";
    bindStudioDrop(pane);
    var printers = (data.config && data.config.printers) || [];
    var selPr = printers.find(function (x) { return x.id === studio.printerId; }) || printers[0] || null;
    var bed = studioBed();
    var prep = getPrepareApi();
    var store = ensureMeshStore();

    // Top Studio Toolbar + File Picker
    var studioFileInput = h("input", {
      type: "file",
      multiple: true,
      hidden: true,
      class: "p3d-studio-file",
      accept: MODEL_ACCEPT,
      onchange: function () {
        openFilesInStudio(studioFileInput.files);
        studioFileInput.value = "";
      },
    });
    var stUpFill = h("span");
    var stUpLabel = h("span", { class: "p3d-meta" });
    var stUpCancel = h("button", { type: "button", class: "p3d-btn is-small", hidden: true, text: "Annuler", onclick: cancelUpload });
    var studioUploadBar = h("div", { class: "p3d-upload p3d-studio-upload", hidden: true }, [
      h("div", { class: "p3d-upload-track" }, [stUpFill]),
      h("div", { class: "p3d-upload-row" }, [stUpLabel, stUpCancel]),
    ]);
    studioUploadEls = { bar: studioUploadBar, fill: stUpFill, label: stUpLabel, cancel: stUpCancel };
    renderStudioUploadBar();

    var prSel = h("select", { class: "p3d-input p3d-ctl-num", "aria-label": "Imprimante Studio" },
      printers.length
        ? printers.map(function (pr) {
            return h("option", { value: pr.id, text: pr.name + (pr.model ? " (" + pr.model + ")" : " (modèle requis)") });
          })
        : [h("option", { value: "", disabled: true, text: "Aucune imprimante configurée" })]);

    function currentFingerprint(targetPr, nTools) {
      var mName = (targetPr && targetPr.model) || "";
      var maxT = Math.max(1, Number(nTools || 1));
      return JSON.stringify({
        project_id: (studio.project && studio.project.id) || "",
        printer_id: (targetPr && targetPr.id) || "",
        printer_model: mName,
        cfg: studio.cfg,
        tools: studio.tools.slice(0, maxT).map(function (t) { return { material: t.material, color: t.color, preset: t.preset || "" }; }),
        items: studio.items.map(function (it) {
          return {
            model_id: it.model_id,
            source_version: it.sourceVersion || "",
            x: Number(it.x), y: Number(it.y), z: Number(it.z || 0),
            rot_x: Number(it.rot_x || 0), rot_y: Number(it.rot_y || 0), rot_z: Number(it.rot_z || 0),
            scale: Number(it.scale),
            tool: Math.min(maxT - 1, Math.max(0, Number(it.tool || 0))),
            overrides: it.overrides ? Object.assign({}, it.overrides) : {},
          };
        }),
      });
    }
    var caps = printerCaps(selPr);
    var availNozzles = (caps && caps.nozzles && caps.nozzles.length) ? caps.nozzles : ["0.4"];
    if (availNozzles.indexOf(String(studio.cfg.nozzle)) < 0) {
      studio.cfg.nozzle = (caps && caps.default_nozzle) || availNozzles[0];
    }
    var availTools = caps ? Math.max(1, Math.min(Number(caps.max_tools) || 1, 16)) : 4;
    ensureStudioToolsLen(availTools);
    if (studio.tools[0] && studio.cfg.material && studio.tools[0].material !== studio.cfg.material) {
      studio.tools[0].material = studio.cfg.material;
    }
    function isSliceReady() {
      if (!studio.slicedModel || !studio.slicedModel.id) return false;
      if (studio.slicedIsExternal) return true;
      return !!studio.slicedFingerprint && studio.slicedFingerprint === currentFingerprint(selPr, availTools);
    }
    var printBtnRef = null;
    function invalidateStudioSlice() {
      invalidateStudioSliceGlobal();
      if (printBtnRef) {
        printBtnRef.disabled = true;
        printBtnRef.hidden = true;
      }
    }
    if (studio.sliceSeq == null) studio.sliceSeq = 0;
    if (studio.printerId && printers.some(function (pr) { return pr.id === studio.printerId; })) prSel.value = studio.printerId;
    prSel.addEventListener("change", function () {
      studio.printerId = prSel.value;
      invalidateStudioSlice();
      renderStudio();
    });

    function openStudioPrintConfirm(targetPr, _targetCaps) {
      if (!targetPr || !targetPr.id) { toast("Configure une imprimante dans Réglages.", "err"); return; }
      if (!targetPr.model) { toast("Définis le modèle exact de l'imprimante dans Réglages.", "err"); return; }
      if (!isSliceReady()) { toast("Le plateau ou les réglages ont changé : tranche d'abord.", "err"); return; }
      var plateLabels = { textured_pei: "Textured PEI Plate", cool: "Cool Plate", smooth_pei: "Smooth PEI / High Temp Plate" };
      var snap = studio.slicedSettings || {};
      var snapPrinterName = snap.printer_name || targetPr.name;
      var snapPrinterModel = snap.printer_model || (studio.slicedInfo && studio.slicedInfo.printer_model) || targetPr.model;
      var snapPlate = snap.plate_type || (studio.slicedIsExternal ? "—" : studio.cfg.plate_type);
      var snapNozzle = snap.nozzle || "—";
      var snapLayer = snap.layer_height || "—";
      var snapInfill = snap.infill != null ? snap.infill : "—";
      var activeFils = snap.filaments_label
        || ((studio.slicedInfo && studio.slicedInfo.filaments && studio.slicedInfo.filaments.length)
          ? studio.slicedInfo.filaments.map(function (f, i) { return "T" + (Number(f.id || (i + 1)) - 1) + ": " + (f.type || "?"); }).join(", ")
          : "—");
      var cbLevel = h("input", { type: "checkbox", checked: true });
      var cbFlow = h("input", { type: "checkbox", checked: false });
      var cbVib = h("input", { type: "checkbox", checked: false });
      var cbTl = h("input", { type: "checkbox", checked: false });
      var cancelBtn = h("button", { type: "button", class: "p3d-btn", text: "Annuler", onclick: closeOverlay });
      var confirmBtn = h("button", { type: "button", class: "p3d-btn is-primary", text: "Confirmer et lancer", onclick: function (e) {
        busyRun(e.target, "Envoi…", function () {
          return post("/api/print3d/printer/start", {
            printer_id: targetPr.id,
            model_id: studio.slicedModel.id,
            plate: studio.plate || 1,
            bed_levelling: cbLevel.checked,
            flow_cali: targetPr.kind === "bambu" ? cbFlow.checked : false,
            vibration_cali: targetPr.kind === "bambu" ? cbVib.checked : false,
            timelapse: cbTl.checked,
          }).then(function () {
            closeOverlay();
            toast("Impression lancée depuis Studio");
            setTab("printers");
          });
        }).catch(function (err) { toast(err.message, "err"); });
      } });
      var sheet = h("div", { class: "p3d-model-detail p3d-print-confirm" }, [
        h("h3", { text: "Confirmer l'impression Studio" }),
        h("dl", { class: "p3d-facts" }, [
          h("dt", { text: "Imprimante" }), h("dd", { text: snapPrinterName + " (" + snapPrinterModel + ")" }),
          h("dt", { text: "Fichier tranché" }), h("dd", { text: studio.slicedModel.name + " · Plateau " + (studio.plate || 1) }),
          h("dt", { text: "Surface plateau" }), h("dd", { text: plateLabels[snapPlate] || snapPlate }),
          h("dt", { text: "Matériaux / outils" }), h("dd", { text: activeFils }),
          h("dt", { text: "Profil / Buse" }), h("dd", { text: "Buse " + snapNozzle + " mm · couche " + snapLayer + " mm · remplissage " + snapInfill + (String(snapInfill).indexOf("%") < 0 && snapInfill !== "—" ? "%" : "") }),
        ]),
        h("div", { class: "p3d-ctl-row" }, [
          h("label", { class: "p3d-chk" }, [cbLevel, " Nivellement plateau"]),
          targetPr.kind === "bambu" ? h("label", { class: "p3d-chk" }, [cbFlow, " Calibration débit"]) : null,
          targetPr.kind === "bambu" ? h("label", { class: "p3d-chk" }, [cbVib, " Calibration vibrations"]) : null,
          h("label", { class: "p3d-chk" }, [cbTl, " Timelapse"]),
        ]),
        h("div", { class: "p3d-actions" }, [cancelBtn, confirmBtn]),
      ]);
      openOverlay(sheet);
    }

    var addPick = h("div", { class: "p3d-studio-pick", hidden: true });
    function openAddPicker() {
      addPick.hidden = !addPick.hidden;
      if (addPick.hidden) return;
      addPick.innerHTML = "Chargement…";
      var ready = models.list.length ? Promise.resolve({ models: models.list }) : api("/api/print3d/models?limit=60");
      ready.then(function (res) {
        var rows = res.models || models.list || [];
        addPick.innerHTML = "";
        if (!rows.length) {
          addPick.append(
            h("span", { class: "p3d-meta", text: "Aucun modèle dans Print/. " }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Ouvrir un fichier…", onclick: function () { studioFileInput.click(); } })
          );
          return;
        }
        rows.slice(0, 30).forEach(function (m) {
          addPick.append(h("button", { type: "button", class: "p3d-tag", text: m.name,
            onclick: function () { addPick.hidden = true; addToStudio(m, { preferPreview: studio.mode === "preview" }); } }));
        });
      }).catch(function (e) { addPick.textContent = e.message; });
    }

    function duplicateItemAt(idx) {
      var cur = studio.items[idx];
      if (!cur) return;
      pushStudioHistory("Dupliquer " + (cur.localName || cur.name));
      var sp = itemRotatedSpan(cur);
      var shift = Math.max(15, Math.round(sp[0] + 10));
      var nx = cur.x + shift, ny = cur.y;
      if (nx + sp[0] * 0.5 > bed.x - 4) {
        nx = Math.max(sp[0] * 0.5 + 4, cur.x - shift);
        if (itemsCollide(cur, Object.assign({}, cur, { x: nx, y: ny }))) {
          nx = cur.x;
          ny = Math.min(bed.y - sp[1] * 0.5 - 4, cur.y + Math.max(15, Math.round(sp[1] + 10)));
        }
      }
      if (store && cur.model_id) store.retain(cur.model_id);
      var copy = Object.assign({}, cur, {
        uid: studio.uidSeq++,
        x: Math.round(nx),
        y: Math.round(ny),
        overrides: cur.overrides ? Object.assign({}, cur.overrides) : {},
        custom_meta: cur.custom_meta ? Object.assign({}, cur.custom_meta) : undefined,
      });
      studio.items.push(copy);
      studio.selected = studio.items.length - 1;
      invalidateStudioSlice();
      renderStudio();
    }

    function removeItemAt(idx) {
      if (idx < 0 || idx >= studio.items.length) return;
      var rem = studio.items[idx];
      pushStudioHistory("Retirer " + (rem.localName || rem.name));
      if (store && rem.model_id) store.release(rem.model_id);
      studio.items.splice(idx, 1);
      studio.selected = studio.items.length ? Math.min(idx, studio.items.length - 1) : -1;
      invalidateStudioSlice();
      renderStudio();
    }

    function centerItemAt(idx) {
      var cur = studio.items[idx];
      if (!cur) return;
      pushStudioHistory("Centrer");
      cur.x = Math.round((bed.x * 0.5) * 10) / 10;
      cur.y = Math.round((bed.y * 0.5) * 10) / 10;
      invalidateStudioSlice();
      if (studio.mode === "prepare" && liveSync) liveSync(); else renderStudio();
    }

    function resetItemTransforms(idx) {
      var cur = studio.items[idx];
      if (!cur) return;
      pushStudioHistory("Réinitialiser transforms");
      cur.x = Math.round((bed.x * 0.5) * 10) / 10;
      cur.y = Math.round((bed.y * 0.5) * 10) / 10;
      cur.z = 0;
      cur.rot_x = 0;
      cur.rot_y = 0;
      cur.rot_z = 0;
      cur.scale = 1.0;
      var md = store ? store.getCached(cur.model_id, cur.sourceVersion || undefined) : null;
      if (md) syncItemTiltedDims(cur, md);
      invalidateStudioSlice();
      if (studio.mode === "prepare" && liveSync) liveSync(); else renderStudio();
    }

    function dropToPlateAt(idx) {
      var cur = studio.items[idx];
      if (!cur) return;
      pushStudioHistory("Poser à Z = 0");
      cur.z = 0;
      invalidateStudioSlice();
      if (studio.mode === "prepare" && liveSync) liveSync(); else renderStudio();
    }

    function layFlatAutoAt(idx) {
      var cur = studio.items[idx];
      if (!cur) return;
      var md = store ? store.getCached(cur.model_id, cur.sourceVersion || undefined) : null;
      if (!md || !md.positions || !prep) {
        toast("Charge d'abord la géométrie STL pour poser à plat.", "err");
        return;
      }
      var angles = prep.bestLayFlatAngles(md.positions);
      pushStudioHistory("Poser à plat");
      cur.rot_x = angles[0];
      cur.rot_y = angles[1];
      cur.z = 0;
      syncItemTiltedDims(cur, md);
      invalidateStudioSlice();
      if (studio.mode === "prepare" && liveSync) liveSync(); else renderStudio();
    }

    function quickSaveProject(forceNew, customTitle) {
      var payload = studioBuildProjectPayload(selPr, availTools);
      if (forceNew) {
        payload.id = "";
        delete payload.expected_revision;
      }
      if (customTitle && String(customTitle).trim()) payload.title = String(customTitle).trim();
      return post("/api/print3d/projects/save", payload).then(function (res) {
        if (res && res.project) {
          studio.project.id = res.project.id;
          studio.project.title = res.project.title;
          studio.project.revision = Number(res.project.revision || 1);
          studio.project.dirty = false;
          toast("Projet « " + res.project.title + " » enregistré (v" + studio.project.revision + ")");
          renderStudio();
        }
        return res;
      }).catch(function (err) {
        toast((err && err.message) || "Échec enregistrement projet", "err");
        throw err;
      });
    }

    function openProjectsModal() {
      var titleIn = h("input", { class: "p3d-input", value: (studio.project && studio.project.title) || "Nouveau plateau", maxlength: "80", placeholder: "Titre du projet" });
      var listHost = h("div", { class: "p3d-project-list" }, [h("p", { class: "p3d-meta", text: "Chargement des projets…" })]);
      var sheet = h("div", { class: "p3d-model-detail p3d-projects-sheet" }, [
        h("div", { class: "p3d-sheet-head" }, [
          h("h3", { class: "p3d-h3", text: "Projets Studio (.hq3d)" }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Fermer", onclick: closeOverlay }),
        ]),
        h("p", { class: "p3d-help", text: "Sauvegarde et rouvre tes plateaux entre ordinateur et iPhone sans jamais lancer d'impression." }),
        h("label", {}, ["Titre du projet actif", titleIn]),
        h("div", { class: "p3d-actions" }, [
          h("button", { type: "button", class: "p3d-btn is-small", text: "Nouveau projet", onclick: function () {
            studio.items.forEach(function (it) { if (store && it.model_id) store.release(it.model_id); });
            studio.items = [];
            studio.selected = -1;
            studio.history = { past: [], future: [], max: 50 };
            studio.project = { id: "", title: "Nouveau plateau", revision: 0, dirty: false, schema_version: 1, warnings: [] };
            invalidateStudioSlice();
            closeOverlay();
            renderStudio();
          } }),
          h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Enregistrer", onclick: function () {
            quickSaveProject(false, titleIn.value).then(function () { closeOverlay(); }).catch(function () {});
          } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Enregistrer sous (nouveau)", onclick: function () {
            quickSaveProject(true, titleIn.value).then(function () { closeOverlay(); }).catch(function () {});
          } }),
        ]),
        h("h4", { class: "p3d-h3", text: "Projets récents" }),
        listHost,
      ]);

      function loadProjectList() {
        api("/api/print3d/projects?limit=50").then(function (res) {
          var rows = (res && res.projects) || [];
          listHost.innerHTML = "";
          if (!rows.length) {
            listHost.append(h("p", { class: "p3d-meta", text: "Aucun projet enregistré pour l'instant." }));
            return;
          }
          rows.forEach(function (prRow) {
            var isCur = studio.project && studio.project.id === prRow.id;
            listHost.append(h("div", { class: "p3d-project-row" + (isCur ? " is-selected" : "") }, [
              h("div", { class: "p3d-project-info" }, [
                h("strong", { text: prRow.title + (isCur ? " (ouvert)" : "") }),
                h("span", { class: "p3d-meta", text: (prRow.printer_model || "Sans imprimante") + " · " + prRow.item_count + " objet(s) · rev " + prRow.revision }),
              ]),
              h("div", { class: "p3d-studio-objrow-acts" }, [
                h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Ouvrir", onclick: function () {
                  api("/api/print3d/projects/get?id=" + encodeURIComponent(prRow.id)).then(function (openRes) {
                    studioApplyLoadedProject(openRes);
                    closeOverlay();
                    renderStudio();
                    if (studio.project.warnings && studio.project.warnings.length) {
                      toast(studio.project.warnings[0], "err");
                    } else {
                      toast("Projet « " + prRow.title + " » ouvert");
                    }
                  }).catch(function (err) { toast(err.message, "err"); });
                } }),
                h("button", { type: "button", class: "p3d-btn is-small", text: "Dupliquer", onclick: function () {
                  post("/api/print3d/projects/duplicate", { id: prRow.id }).then(function () {
                    toast("Projet dupliqué");
                    loadProjectList();
                  }).catch(function (err) { toast(err.message, "err"); });
                } }),
                h("button", { type: "button", class: "p3d-btn is-small", text: "Renommer", onclick: function () {
                  var nextT = typeof window.prompt === "function" ? window.prompt("Nouveau titre :", prRow.title) : null;
                  if (nextT && nextT.trim()) {
                    post("/api/print3d/projects/rename", { id: prRow.id, title: nextT.trim(), expected_revision: prRow.revision }).then(function (renRes) {
                      var updatedPrj = (renRes && renRes.project) || null;
                      if (isCur && studio.project) {
                        studio.project.title = (updatedPrj && updatedPrj.title) || nextT.trim();
                        if (updatedPrj && updatedPrj.revision != null) {
                          studio.project.revision = Number(updatedPrj.revision);
                        } else {
                          studio.project.revision = Number(prRow.revision || 1) + 1;
                        }
                        titleIn.value = studio.project.title;
                      }
                      toast("Projet renommé");
                      loadProjectList();
                    }).catch(function (err) { toast(err.message, "err"); });
                  }
                } }),
                h("button", { type: "button", class: "p3d-btn is-small is-danger", text: "Supprimer", onclick: function () {
                  if (typeof window.confirm === "function" && !window.confirm("Supprimer le projet « " + prRow.title + " » ?")) return;
                  post("/api/print3d/projects/delete", { id: prRow.id, expected_revision: prRow.revision }).then(function () {
                    if (isCur) studio.project = { id: "", title: "Nouveau plateau", revision: 0, dirty: false, schema_version: 1, warnings: [] };
                    toast("Projet supprimé");
                    loadProjectList();
                  }).catch(function (err) { toast(err.message, "err"); });
                } }),
              ]),
            ]));
          });
        }).catch(function (err) {
          listHost.innerHTML = "";
          listHost.append(h("p", { class: "p3d-meta", text: "Erreur chargement projets : " + err.message }));
        });
      }
      loadProjectList();
      openOverlay(sheet);
    }

    var undoBtn = h("button", { type: "button", class: "p3d-btn is-small", text: "↶ Annuler", title: "Ctrl+Z",
      disabled: !studio.history.past.length, onclick: function () { undoStudio(); } });
    var redoBtn = h("button", { type: "button", class: "p3d-btn is-small", text: "↷ Rétablir", title: "Ctrl+Y",
      disabled: !studio.history.future.length, onclick: function () { redoStudio(); } });

    var toolbar = h("div", { class: "p3d-studio-bar" }, [
      h("div", { class: "p3d-studio-modes" }, [
        h("button", { type: "button", class: "p3d-tag" + (studio.mode === "prepare" ? " is-on" : ""), text: "1. Préparer",
          onclick: function () { studio.mode = "prepare"; studio.mobileFocus = "prepare"; renderStudio(); } }),
        h("button", { type: "button", class: "p3d-tag" + (studio.mode === "preview" ? " is-on" : ""), text: "2. Aperçu",
          onclick: function () { studio.mode = "preview"; studio.mobileFocus = "preview"; renderStudio(); } }),
      ]),
      prSel,
      h("button", { type: "button", class: "p3d-btn is-small", text: "Ouvrir un fichier…", onclick: function () { studioFileInput.click(); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "+ Ajouter", onclick: openAddPicker }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Projets", title: (studio.project && studio.project.title) || "Projets Studio", onclick: openProjectsModal }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Enregistrer", onclick: function () { quickSaveProject(false).catch(function () {}); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Auto-placer", onclick: function () {
        if (!studio.items.length) return;
        pushStudioHistory("Auto-placer");
        var res = autoArrangeStudioItems(bed);
        invalidateStudioSlice();
        if (!res.fitsAll) {
          toast("Attention : tous les objets ne tiennent pas dans le plateau (" + res.overflowCount + " hors limites).", "err");
        }
        renderStudio();
      } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Dupliquer", disabled: studio.selected < 0, onclick: function () { duplicateItemAt(studio.selected); } }),
      h("button", { type: "button", class: "p3d-btn is-small", text: "Retirer", disabled: studio.selected < 0, onclick: function () { removeItemAt(studio.selected); } }),
      undoBtn,
      redoBtn,
      h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Trancher", onclick: function (e) {
        if (!studio.items.length) { toast("Ajoute d'abord un modèle sur le plateau.", "err"); return; }
        var issues = studioPlacementIssues(bed);
        if (issues.belowPlate.length) {
          toast("Objet sous le plateau (Z < 0 mm) : remonte " + studio.items[issues.belowPlate[0]].name + ".", "err");
          return;
        }
        if (issues.elevated && issues.elevated.length) {
          toast("Objet surélevé (Z > 0 mm non supporté) : pose " + studio.items[issues.elevated[0]].name + " à Z = 0 mm.", "err");
          return;
        }
        if (issues.oob.length) {
          toast("Objet hors plateau (" + studio.items[issues.oob[0]].name + ") : ajuste la position ou l'échelle.", "err");
          return;
        }
        if (issues.pairs.length) {
          var p0 = issues.pairs[0];
          toast("Collision entre " + studio.items[p0[0]].name + " et " + studio.items[p0[1]].name + " : espace-les ou clique Auto-placer.", "err");
          return;
        }
        if (issues.unsupported.length) {
          toast("Format non supporté pour assemblage/transformation : utilise un fichier .stl.", "err");
          return;
        }
        var activePr = printers.find(function (x) { return x.id === studio.printerId; }) || null;
        if (!activePr || !activePr.model) {
          toast("Configure d'abord le modèle exact de l'imprimante dans Réglages.", "err");
          return;
        }
        var activeCaps = printerCaps(activePr);
        var activeToolsCount = activeCaps ? Math.max(1, Math.min(Number(activeCaps.max_tools) || 1, 16)) : 4;
        ensureStudioToolsLen(activeToolsCount);
        var maxTool = Math.max(0, activeToolsCount - 1);
        var sendItems = studio.items.map(function (it) {
          var out = Object.assign({}, it, { tool: Math.min(maxTool, Math.max(0, Number(it.tool || 0))) });
          if (it.sourceVersion && /^[0-9a-f]{64}$/i.test(String(it.sourceVersion))) {
            out.expected_sha256 = String(it.sourceVersion).toLowerCase();
          }
          return out;
        });
        var snapCfg = Object.assign({}, studio.cfg, { tools: studio.tools.slice(0, activeToolsCount).map(function (t) { return Object.assign({}, t); }) });
        var reqFingerprint = currentFingerprint(activePr, activeToolsCount);
        var mySliceSeq = (studio.sliceSeq = (studio.sliceSeq || 0) + 1);
        var filSummary = activeToolsCount > 1
          ? snapCfg.tools.map(function (tl, i) { return "T" + i + ": " + tl.material; }).join(", ")
          : snapCfg.material;
        busyRun(e.target, "Tranchage…", function () {
          return post("/api/print3d/studio/slice", {
            items: sendItems,
            printer_id: activePr.id,
            printer_model: activePr.model,
            settings: snapCfg,
          }).then(function (res) {
            if (mySliceSeq !== studio.sliceSeq) return;
            var curPr = printers.find(function (x) { return x.id === studio.printerId; }) || null;
            var curCaps = printerCaps(curPr);
            var curTools = curCaps ? Math.max(1, Math.min(Number(curCaps.max_tools) || 1, 16)) : 4;
            if (reqFingerprint !== currentFingerprint(curPr, curTools)) return;
            var ss = (res.model && res.model.slice_settings) || {};
            studio.slicedModel = res.model || null;
            studio.slicedInfo = res.info || null;
            studio.slicedFingerprint = reqFingerprint;
            studio.slicedIsExternal = false;
            studio.slicedSettings = {
              printer_name: activePr.name,
              printer_model: activePr.model,
              plate_type: snapCfg.plate_type,
              nozzle: snapCfg.nozzle,
              layer_height: snapCfg.layer_height,
              infill: snapCfg.infill != null ? snapCfg.infill : ss.infill,
              filaments_label: (res.info && res.info.filaments && res.info.filaments.length)
                ? res.info.filaments.map(function (f, i) { return "T" + (Number(f.id || (i + 1)) - 1) + ": " + (f.type || "?"); }).join(", ")
                : filSummary,
            };
            studio.plate = 1;
            studio.use2d = false;
            studio.layersData = null;
            if (studio.slicedModel && studio.slicedModel.id) {
              studio.mode = "preview";
            }
            toast("Plateau tranché !");
            renderStudio();
          });
        }).catch(function (err) {
          var msg = (err && err.message) || "Erreur de tranchage";
          if (err && (err.code === "source_changed" || err.status === 409 || /source_changed|modifié sur le disque/i.test(msg))) {
            invalidateStudioSlice();
            studio.items.forEach(function (it) {
              delete stlDimsCache[it.model_id];
              if (store && typeof store.invalidate === "function") store.invalidate(it.model_id);
              if (String(it.ext || "").toLowerCase() === "stl") {
                it.loadState = "loading";
                reacquireStudioStl({ id: it.model_id, name: it.name, ext: "stl" }, "", true);
              }
            });
            api("/api/print3d/models?limit=500").then(function (r) {
              if (r && Array.isArray(r.models)) {
                models.list = r.models;
                syncStudioSourceVersions(r.models, { forceInvalidation: true });
              }
            }).catch(function () {});
            if (typeof liveSync === "function") liveSync();
          }
          toast(msg, "err");
        });
      } }),
      (printBtnRef = isSliceReady() ? h("button", { type: "button", class: "p3d-btn is-small is-primary", text: "Imprimer", onclick: function () {
        var activePr = printers.find(function (x) { return x.id === studio.printerId; }) || null;
        openStudioPrintConfirm(activePr, caps);
      } }) : null),
    ]);

    // Slicer Settings Sidebar (Right on desktop, collapsible drawers on mobile)
    function sel(opts, val, onChg) {
      var el = h("select", { class: "p3d-input" }, opts.map(function (o) {
        var v = Array.isArray(o) ? o[0] : String(o), t = Array.isArray(o) ? o[1] : String(o);
        return h("option", { value: v, text: t });
      }));
      el.value = String(val);
      el.addEventListener("change", function () { onChg(el.value); });
      return el;
    }
    function numIn(val, minV, maxV, stepV, ph, onChg) {
      var el = h("input", { class: "p3d-input", type: "number", min: String(minV), max: String(maxV), step: String(stepV), value: val == null ? "" : String(val), placeholder: ph || "" });
      el.addEventListener("change", function () { onChg(el.value); });
      return el;
    }
    var cbSup = h("input", { type: "checkbox", checked: studio.cfg.supports });
    cbSup.addEventListener("change", function () { studio.cfg.supports = cbSup.checked; invalidateStudioSlice(); });
    var cbBrim = h("input", { type: "checkbox", checked: studio.cfg.brim });
    cbBrim.addEventListener("change", function () { studio.cfg.brim = cbBrim.checked; invalidateStudioSlice(); });
    var inInf = h("input", { class: "p3d-input", type: "number", min: "0", max: "100", value: String(studio.cfg.infill) });
    inInf.addEventListener("change", function () { studio.cfg.infill = Number(inInf.value || 15); studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); });
    var inWalls = h("input", { class: "p3d-input", type: "number", min: "1", max: "16", value: String(studio.cfg.wall_loops) });
    inWalls.addEventListener("change", function () { studio.cfg.wall_loops = Number(inWalls.value || 2); studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); });

    var MAT_CHOICES = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC"];
    var matGlobalSel = sel(MAT_CHOICES, studio.cfg.material, function (v) {
      studio.cfg.material = v;
      if (studio.tools[0]) studio.tools[0].material = v;
      invalidateStudioSlice();
      renderStudio();
    });
    var visibleTools = studio.tools.slice(0, availTools);
    var liveSync = null;
    var stationKind = (caps && caps.station_kind) || "external_spool";
    var rolePrefix = (caps && caps.physical_extruders > 1) ? "Extrudeur T" : (availTools > 1 ? "Fente station T" : "Bobine T");
    var loadedSlotInfo = (studio.loadedMaterials && Array.isArray(studio.loadedMaterials.slots)) ? studio.loadedMaterials.slots : [];

    function checkMultiMatThermalWarning() {
      if (!caps || Number(caps.physical_extruders || 1) > 1 || visibleTools.length < 2) return "";
      var approxTemp = { PLA: 220, TPU: 225, PETG: 245, ABS: 260, ASA: 260, PA: 280, PC: 280 };
      var activeSet = [];
      studio.items.forEach(function (it) {
        var ti = Math.min(visibleTools.length - 1, Math.max(0, Number(it.tool || 0)));
        if (visibleTools[ti]) activeSet.push(visibleTools[ti].material || "PLA");
      });
      if (activeSet.length < 2) activeSet = visibleTools.map(function (t) { return t.material || "PLA"; });
      var temps = activeSet.map(function (m) { return approxTemp[String(m).toUpperCase()] || 220; });
      if (Math.max.apply(null, temps) - Math.min.apply(null, temps) > 55) {
        return "⚠ Écart thermique élevé entre matériaux sur buse unique (" + activeSet.join(" / ") + ").";
      }
      return "";
    }

    var toolRows = visibleTools.map(function (tl, ti) {
      var colIn = h("input", { type: "color", value: tl.color, "aria-label": "Couleur T" + ti });
      colIn.addEventListener("input", function () {
        tl.color = colIn.value;
        invalidateStudioSlice();
        if (studio.mode === "prepare" && liveSync) liveSync();
      });
      var matSel = sel(MAT_CHOICES, tl.material, function (v) {
        tl.material = v;
        tl.preset = "";
        if (ti === 0) {
          studio.cfg.material = v;
          matGlobalSel.value = v;
        }
        invalidateStudioSlice();
        renderStudio();
      });
      var matchedSlot = loadedSlotInfo.find(function (sl) { return Number(sl.slot) === ti + 1 || sl.loaded !== false && String(sl.material || "").toUpperCase() === String(tl.material || "").toUpperCase(); });
      var slotTxt = (tl.station_slot ? ("Fente " + tl.station_slot) : (matchedSlot ? ("Station #" + (matchedSlot.slot || ti + 1) + (matchedSlot.loaded === false ? " (vide)" : "")) : (caps && caps.physical_extruders > 1 ? "Buse directe" : (availTools > 1 ? stationKind.toUpperCase() : "Externe"))));
      var preIn = h("input", { class: "p3d-input p3d-mat-preset", value: tl.preset || "", placeholder: "Profil auto (" + tl.material + ")", "aria-label": "Profil filament T" + ti });
      preIn.addEventListener("change", function () { tl.preset = preIn.value.trim(); invalidateStudioSlice(); });
      return h("div", { class: "p3d-ctl-row p3d-mat-card" }, [
        h("strong", { text: rolePrefix + ti }),
        colIn,
        matSel,
        preIn,
        h("span", { class: "p3d-meta p3d-mat-slot", text: slotTxt }),
      ]);
    });
    var toolsTitle = (caps && caps.physical_extruders > 1)
      ? ("Extrudeurs physiques (T0–T" + (availTools - 1) + ")")
      : (availTools > 1 ? ("Station " + (stationKind === "ifs" ? "IFS" : "AMS") + " (T0–T" + (availTools - 1) + ")") : "Extrudeur unique (T0)");

    function importLoadedMaterialsReadOnly() {
      if (!selPr || !selPr.id) { toast("Sélectionne d'abord une imprimante.", "err"); return; }
      api("/api/print3d/studio/loaded_materials?printer_id=" + encodeURIComponent(selPr.id)).then(function (res) {
        studio.loadedMaterials = res;
        if (!res.available || !Array.isArray(res.slots) || !res.slots.length) {
          var reasonLabel = res.reason === "offline" ? "Imprimante hors ligne ou état indisponible." : "Aucune station AMS/IFS détectée (mode bobine externe).";
          toast(reasonLabel, "err");
          renderStudio();
          return;
        }
        var loadedOnly = res.slots.filter(function (s) { return s.loaded !== false; });
        if (!loadedOnly.length) { toast("Aucune fente chargée signalée.", "err"); renderStudio(); return; }
        var hasCustom = studio.tools.slice(0, availTools).some(function (t, i) { return i > 0 && t.material !== "PLA"; });
        if (hasCustom && typeof window.confirm === "function" && !window.confirm("Remplacer les assignations T0–T" + (availTools - 1) + " actuelles par les bobines chargées détectées ?")) {
          renderStudio();
          return;
        }
        loadedOnly.slice(0, availTools).forEach(function (sl, i) {
          studio.tools[i].material = String(sl.material || "PLA").toUpperCase();
          if (sl.colour && /^#[0-9a-f]{6}$/i.test(sl.colour)) studio.tools[i].color = sl.colour;
          studio.tools[i].station_slot = Number(sl.slot || (i + 1));
        });
        if (studio.tools[0]) studio.cfg.material = studio.tools[0].material;
        invalidateStudioSlice();
        toast(loadedOnly.length + " matériau(x) importé(s) (lecture seule).");
        renderStudio();
      }).catch(function (err) { toast((err && err.message) || "Lecture matériaux impossible", "err"); });
    }

    var isNarrowViewport = (typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth <= 820);
    var advFold = h("details", { class: "p3d-studio-fold p3d-studio-adv", open: !!studio.advancedOpen }, [
      h("summary", { text: "Paramètres avancés" }),
      h("div", { class: "p3d-studio-fold-body" }, [
        h("h4", { class: "p3d-h3", text: "Qualité & Peaux" }),
        h("label", {}, ["Hauteur de couche (mm)", sel([["0.08", "0.08 mm"], ["0.12", "0.12 mm"], ["0.16", "0.16 mm"], ["0.20", "0.20 mm"], ["0.24", "0.24 mm"], ["0.28", "0.28 mm"], ["0.32", "0.32 mm"], ["0.40", "0.40 mm"]], studio.cfg.layer_height, function (v) { studio.cfg.layer_height = v; studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Première couche (mm)", sel([["", "Auto (profil)"], ["0.12", "0.12 mm"], ["0.16", "0.16 mm"], ["0.20", "0.20 mm"], ["0.24", "0.24 mm"], ["0.28", "0.28 mm"]], studio.cfg.first_layer_height || "", function (v) { studio.cfg.first_layer_height = v; studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Couches supérieures", numIn(studio.cfg.top_shell_layers, 0, 30, 1, "5", function (v) { studio.cfg.top_shell_layers = v === "" ? 5 : Number(v); studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Couches inférieures", numIn(studio.cfg.bottom_shell_layers, 0, 30, 1, "3", function (v) { studio.cfg.bottom_shell_layers = v === "" ? 3 : Number(v); studio.cfg.quality_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Motif remplissage", sel([["gyroid", "Gyroïde"], ["grid", "Grille"], ["rectilinear", "Rectiligne"], ["cubic", "Cubique"], ["honeycomb", "Nid d'abeille"], ["triangles", "Triangles"]], studio.cfg.infill_pattern, function (v) { studio.cfg.infill_pattern = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Couture (Seam)", sel([["aligned", "Alignée"], ["nearest", "Plus proche"], ["back", "Arrière"], ["random", "Aléatoire"]], studio.cfg.seam_position || "aligned", function (v) { studio.cfg.seam_position = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Repassage (Ironing)", sel([["no_ironing", "Désactivé"], ["top", "Surfaces supérieures"], ["topmost", "Dernière couche"], ["solid", "Toutes couches pleines"]], studio.cfg.ironing_type || "no_ironing", function (v) { studio.cfg.ironing_type = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Générateur de parois", sel([["classic", "Classique"], ["arachne", "Arachne"]], studio.cfg.wall_generator || "classic", function (v) { studio.cfg.wall_generator = v; invalidateStudioSlice(); })]),

        h("h4", { class: "p3d-h3", text: "Vitesses & Accélération" }),
        h("label", {}, ["Mode vitesse", sel([["standard", "Standard (1.0×)"], ["quiet", "Silencieux (0.65×)"], ["fast", "Rapide (1.25×)"], ["custom", "Personnalisé"]], studio.cfg.speed_preset || "standard", function (v) { studio.cfg.speed_preset = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Paroi externe (mm/s)", numIn(studio.cfg.outer_wall_speed, 10, 600, 10, "Auto", function (v) { studio.cfg.outer_wall_speed = v; studio.cfg.speed_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Paroi interne (mm/s)", numIn(studio.cfg.inner_wall_speed, 10, 600, 10, "Auto", function (v) { studio.cfg.inner_wall_speed = v; studio.cfg.speed_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["Remplissage (mm/s)", numIn(studio.cfg.sparse_infill_speed, 10, 600, 10, "Auto", function (v) { studio.cfg.sparse_infill_speed = v; studio.cfg.speed_preset = "custom"; invalidateStudioSlice(); })]),
        h("label", {}, ["1re couche (mm/s)", numIn(studio.cfg.initial_layer_speed, 5, 200, 5, "Auto", function (v) { studio.cfg.initial_layer_speed = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Déplacement (mm/s)", numIn(studio.cfg.travel_speed, 20, 1000, 25, "Auto", function (v) { studio.cfg.travel_speed = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Accélération défaut (mm/s²)", numIn(studio.cfg.default_acceleration, 200, 30000, 500, "Auto", function (v) { studio.cfg.default_acceleration = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Accél. paroi ext. (mm/s²)", numIn(studio.cfg.outer_wall_acceleration, 200, 25000, 500, "Auto", function (v) { studio.cfg.outer_wall_acceleration = v; invalidateStudioSlice(); })]),

        h("h4", { class: "p3d-h3", text: "Supports & Adhérence avancés" }),
        h("label", {}, ["Type de support", sel([["tree", "Arbre (Tree)"], ["normal", "Normal"]], studio.cfg.support_type, function (v) { studio.cfg.support_type = v; invalidateStudioSlice(); })]),
        (function () {
          var cbPlatOnly = h("input", { type: "checkbox", checked: !!studio.cfg.support_on_build_plate_only });
          cbPlatOnly.addEventListener("change", function () { studio.cfg.support_on_build_plate_only = cbPlatOnly.checked; invalidateStudioSlice(); });
          return h("label", { class: "p3d-chk" }, [cbPlatOnly, " Supports sur plateau uniquement"]);
        })(),
        h("label", {}, ["Angle porte-à-faux (°)", numIn(studio.cfg.support_threshold_angle, 5, 80, 1, "30", function (v) { studio.cfg.support_threshold_angle = v === "" ? 30 : Number(v); invalidateStudioSlice(); })]),
        h("label", {}, ["Espacement support (mm)", numIn(studio.cfg.support_base_pattern_spacing, 0.5, 10, 0.5, "2.5", function (v) { studio.cfg.support_base_pattern_spacing = v === "" ? 2.5 : Number(v); invalidateStudioSlice(); })]),
        h("label", {}, ["Couches d'interface support", numIn(studio.cfg.support_interface_top_layers, 0, 6, 1, "2", function (v) { studio.cfg.support_interface_top_layers = v === "" ? 2 : Number(v); invalidateStudioSlice(); })]),
        availTools > 1 ? h("label", {}, ["Matériau interface support", sel([["0", "Auto (outil objet)"]].concat(visibleTools.map(function (t, i) { return [String(i + 1), "T" + i + " (" + t.material + ")"]; })), studio.cfg.support_interface_filament || 0, function (v) { studio.cfg.support_interface_filament = Number(v || 0); invalidateStudioSlice(); })]) : null,
        h("label", {}, ["Type de bordure", sel([["no_brim", "Aucune"], ["outer_only", "Extérieure"], ["inner_only", "Intérieure"], ["outer_and_inner", "Ext. + Int."], ["auto_brim", "Auto"]], studio.cfg.brim ? (studio.cfg.brim_type || "outer_only") : "no_brim", function (v) { studio.cfg.brim = v !== "no_brim"; studio.cfg.brim_type = v; cbBrim.checked = studio.cfg.brim; invalidateStudioSlice(); })]),
        h("label", {}, ["Largeur bordure (mm)", numIn(studio.cfg.brim_width, 0, 30, 0.5, "5", function (v) { studio.cfg.brim_width = v === "" ? 5 : Number(v); invalidateStudioSlice(); })]),
        h("label", {}, ["Jupe / Skirt (boucles)", numIn(studio.cfg.skirt_loops, 0, 10, 1, "0", function (v) { studio.cfg.skirt_loops = v === "" ? 0 : Number(v); invalidateStudioSlice(); })]),
        h("label", {}, ["Radeau / Raft (couches)", numIn(studio.cfg.raft_layers, 0, 6, 1, "0", function (v) { studio.cfg.raft_layers = v === "" ? 0 : Number(v); invalidateStudioSlice(); })]),

        h("h4", { class: "p3d-h3", text: "Températures & Refroidissement (tranchage)" }),
        h("label", {}, ["Buse 1re couche (°C)", numIn(studio.cfg.nozzle_temperature_initial_layer, 150, 320, 5, "Profil", function (v) { studio.cfg.nozzle_temperature_initial_layer = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Buse autres couches (°C)", numIn(studio.cfg.nozzle_temperature, 150, 320, 5, "Profil", function (v) { studio.cfg.nozzle_temperature = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Plateau 1re couche (°C)", numIn(studio.cfg.bed_temperature_initial_layer, 0, 120, 5, "Profil", function (v) { studio.cfg.bed_temperature_initial_layer = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Plateau autres couches (°C)", numIn(studio.cfg.bed_temperature, 0, 120, 5, "Profil", function (v) { studio.cfg.bed_temperature = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Ventilateur min. (%)", numIn(studio.cfg.fan_min_speed, 0, 100, 5, "Profil", function (v) { studio.cfg.fan_min_speed = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Ventilateur max. (%)", numIn(studio.cfg.fan_max_speed, 0, 100, 5, "Profil", function (v) { studio.cfg.fan_max_speed = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Couches sans ventilateur", numIn(studio.cfg.close_fan_the_first_x_layers, 0, 10, 1, "Profil", function (v) { studio.cfg.close_fan_the_first_x_layers = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Débit volumique max (mm³/s)", numIn(studio.cfg.filament_max_volumetric_speed, 0.5, 50, 0.5, "Profil", function (v) { studio.cfg.filament_max_volumetric_speed = v; invalidateStudioSlice(); })]),

        (caps && caps.supports_prime_tower !== false && availTools > 1) ? h("div", { class: "p3d-studio-tower-cfg" }, [
          h("h4", { class: "p3d-h3", text: "Tour de purge & Transitions" }),
          (function () {
            var cbPt = h("input", { type: "checkbox", checked: studio.cfg.prime_tower_enabled !== false });
            cbPt.addEventListener("change", function () { studio.cfg.prime_tower_enabled = cbPt.checked; invalidateStudioSlice(); });
            return h("label", { class: "p3d-chk" }, [cbPt, " Tour de purge active"]);
          })(),
          h("label", {}, ["Largeur tour (mm)", numIn(studio.cfg.prime_tower_width, 10, 80, 1, "35", function (v) { studio.cfg.prime_tower_width = v === "" ? 35 : Number(v); invalidateStudioSlice(); })]),
          h("label", {}, ["Position X tour (mm)", numIn(studio.cfg.prime_tower_x, -200, 400, 5, "Auto", function (v) { studio.cfg.prime_tower_x = v; invalidateStudioSlice(); })]),
          h("label", {}, ["Position Y tour (mm)", numIn(studio.cfg.prime_tower_y, -200, 400, 5, "Auto", function (v) { studio.cfg.prime_tower_y = v; invalidateStudioSlice(); })]),
          h("label", {}, ["Multiplicateur purge", numIn(studio.cfg.flush_multiplier, 0, 2, 0.1, "1.0", function (v) { studio.cfg.flush_multiplier = v === "" ? 1.0 : Number(v); invalidateStudioSlice(); })]),
          (function () {
            var cbFi = h("input", { type: "checkbox", checked: !!studio.cfg.flush_into_infill });
            cbFi.addEventListener("change", function () { studio.cfg.flush_into_infill = cbFi.checked; invalidateStudioSlice(); });
            return h("label", { class: "p3d-chk" }, [cbFi, " Purger dans le remplissage"]);
          })(),
        ]) : null,
      ]),
    ]);
    advFold.addEventListener("toggle", function () { studio.advancedOpen = !!advFold.open; });

    var settingsFold = h("details", { class: "p3d-studio-fold p3d-studio-settings-fold", open: !isNarrowViewport || studio.mobileFocus === "settings" }, [
      h("summary", { text: "Réglages de tranchage" }),
      h("div", { class: "p3d-studio-fold-body" }, [
        // Preserve [0: plate_type, 1: nozzle, 2: material] select indices and [0: walls, 1: infill] number input indices!
        h("h4", { class: "p3d-h3", text: "Plateau & Buse" }),
        h("label", {}, ["Type de plateau", sel([["textured_pei", "Textured PEI"], ["cool", "Cool Plate"], ["smooth_pei", "Smooth PEI"]], studio.cfg.plate_type, function (v) { studio.cfg.plate_type = v; invalidateStudioSlice(); })]),
        h("label", {}, ["Buse (mm)", sel(availNozzles, studio.cfg.nozzle, function (v) {
          studio.cfg.nozzle = v;
          if (studio.cfg.quality_preset && studio.cfg.quality_preset !== "custom") {
            var qd = qualityPresetDefaults(v, studio.cfg.quality_preset);
            Object.assign(studio.cfg, qd);
          }
          invalidateStudioSlice();
          renderStudio();
        })]),
        h("label", {}, ["Matériau", matGlobalSel]),
        h("h4", { class: "p3d-h3", text: "Qualité & Force" }),
        h("label", {}, ["Préréglage qualité", sel([["draft", "Brouillon (rapide)"], ["standard", "Standard"], ["fine", "Fin (détaillé)"], ["custom", "Personnalisé"]], studio.cfg.quality_preset || "standard", function (v) {
          studio.cfg.quality_preset = v;
          if (v !== "custom") Object.assign(studio.cfg, qualityPresetDefaults(studio.cfg.nozzle, v));
          invalidateStudioSlice();
          renderStudio();
        })]),
        h("label", {}, ["Périmètres (murs)", inWalls]),
        h("label", {}, ["Remplissage (%)", inInf]),
        h("h4", { class: "p3d-h3", text: "Supports & Adhérence" }),
        h("label", { class: "p3d-chk" }, [cbSup, " Activer les supports"]),
        h("label", { class: "p3d-chk" }, [cbBrim, " Bordure (Brim)"]),
        advFold,
      ]),
    ]);

    var thermalWarnTxt = checkMultiMatThermalWarning();
    var materialsFold = h("details", { class: "p3d-studio-fold p3d-studio-materials-fold", open: !isNarrowViewport || studio.mobileFocus === "materials" }, [
      h("summary", { text: toolsTitle }),
      h("div", { class: "p3d-studio-fold-body" }, [
        h("div", { class: "p3d-studio-tools" }, toolRows),
        thermalWarnTxt ? h("p", { class: "p3d-studio-warn", text: thermalWarnTxt }) : null,
        h("button", { type: "button", class: "p3d-btn is-small", text: "Importer chargés (lecture seule)", onclick: importLoadedMaterialsReadOnly }),
      ]),
    ]);

    var sidebar = h("aside", { class: "p3d-studio-side" }, [
      settingsFold,
      materialsFold,
    ]);

    // Left Object List Panel (synchronized bidirectionally with 3D viewport)
    var objListWrap = h("div", { class: "p3d-studio-objlist" });
    var objCountSummary = h("summary", { text: "Objets (" + studio.items.length + ")" });
    var objectsPanel = h("aside", { class: "p3d-studio-objects" }, [
      h("details", { class: "p3d-studio-fold", open: !isNarrowViewport }, [
        objCountSummary,
        h("div", { class: "p3d-studio-fold-body" }, [objListWrap]),
      ]),
    ]);

    // Center Stage
    var stage = h("div", { class: "p3d-studio-stage" });
    if (studio.mode === "prepare") {
      var modeBtns = {};
      function setInteractionMode(modeKey) {
        studio.interactionMode = modeKey;
        Object.keys(modeBtns).forEach(function (k) {
          modeBtns[k].classList.toggle("is-on", k === modeKey);
        });
        if (studioPrepareViewport) studioPrepareViewport.setState({ interactionMode: modeKey });
        if (liveSync) liveSync();
      }
      [["auto", "Auto"], ["camera", "Caméra"], ["move", "Déplacer"], ["layflat", "Face à plat"]].forEach(function (pair) {
        modeBtns[pair[0]] = h("button", {
          type: "button",
          class: "p3d-tag" + (studio.interactionMode === pair[0] ? " is-on" : ""),
          text: pair[1],
          onclick: function () { setInteractionMode(pair[0]); },
        });
      });

      var camBar = h("div", { class: "p3d-studio-cam-bar" }, [
        h("div", { class: "p3d-studio-cam-group" }, [
          modeBtns.auto, modeBtns.camera, modeBtns.move, modeBtns.layflat,
        ]),
        h("div", { class: "p3d-studio-cam-group" }, [
          h("button", { type: "button", class: "p3d-btn is-small", text: "Iso", onclick: function () { if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("iso"); } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Dessus", onclick: function () { if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("top"); } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Face", onclick: function () { if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("front"); } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Côté", onclick: function () { if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("side"); } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Focus", onclick: function () {
            var cur = studio.items[studio.selected];
            if (cur && studioPrepareViewport) studioPrepareViewport.focusItem(cur);
            else if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("reset");
          } }),
          h("button", { type: "button", class: "p3d-btn is-small", text: "Réinit. vue", onclick: function () { if (studioPrepareViewport) studioPrepareViewport.setCameraPreset("reset"); } }),
        ]),
      ]);

      var cvs = h("canvas", { class: "p3d-studio-cvs", width: "640", height: "460" });
      var stageStatus = h("div", { class: "p3d-studio-status", hidden: true });
      var canvasWrap = h("div", { class: "p3d-studio-cvs-wrap" }, [cvs, stageStatus]);
      var warnBox = h("p", { class: "p3d-studio-warn", hidden: true });
      var objInspectorHost = h("div", { class: "p3d-studio-inspector" });
      var hint = h("p", { class: "p3d-meta", text: "Plateau " + bed.x + " × " + bed.y + " × " + bed.z + " mm · Clic = sélectionner · Glisser = déplacer (sélectionné) ou orbiter · Molette = zoom · Double-clic = focus" });
      stage.append(camBar, canvasWrap, warnBox, objInspectorHost, hint);

      var lastBuiltSel = -99;
      var inspectorInputs = null;

      function refreshPlacementBanner() {
        var iss = studioPlacementIssues(bed);
        var msgs = [];
        if (iss.belowPlate.length) {
          msgs.push("⚠ Sous plateau (Z < 0) : " + iss.belowPlate.map(function (i) { return studio.items[i].localName || studio.items[i].name; }).join(", "));
        }
        if (iss.elevated && iss.elevated.length) {
          msgs.push("⚠ Surélevé (Z > 0 mm non supporté : pose l'objet à Z = 0 mm) : " + iss.elevated.map(function (i) { return studio.items[i].localName || studio.items[i].name; }).join(", "));
        }
        if (iss.oob.length) {
          msgs.push("⚠ Hors plateau : " + iss.oob.map(function (i) { return studio.items[i].localName || studio.items[i].name; }).join(", "));
        }
        if (iss.pairs.length) {
          var pair = iss.pairs[0];
          msgs.push("⚠ Collision détectée : " + (studio.items[pair[0]].localName || studio.items[pair[0]].name) + " ↔ " + (studio.items[pair[1]].localName || studio.items[pair[1]].name) + " (utilise Auto-placer ou déplace-les)");
        }
        if (iss.unsupported.length) {
          msgs.push("⚠ Format non éditable (.stl requis pour transformations / multi-objets) : " + iss.unsupported.map(function (i) { return studio.items[i].name; }).join(", "));
        }
        if (msgs.length) {
          warnBox.hidden = false;
          warnBox.textContent = msgs.join(" · ");
        } else {
          warnBox.hidden = true;
          warnBox.textContent = "";
        }
        return iss;
      }

      function renderObjectList(iss) {
        objCountSummary.textContent = "Objets (" + studio.items.length + ")";
        objListWrap.innerHTML = "";
        if (!studio.items.length) {
          objListWrap.append(h("p", { class: "p3d-meta", text: "Plateau vide. Clique + Ajouter ou dépose un .stl." }));
          return;
        }
        studio.items.forEach(function (it, idx) {
          var isSel = idx === studio.selected;
          var tIdx = Math.max(0, Math.min(studio.tools.length - 1, Number(it.tool || 0)));
          var tCol = (studio.tools[tIdx] && studio.tools[tIdx].color) || "#38bdf8";
          var hasErr = iss.oob.indexOf(idx) >= 0 || iss.belowPlate.indexOf(idx) >= 0 || (iss.elevated && iss.elevated.indexOf(idx) >= 0) || !!iss.collideSet[idx] || iss.unsupported.indexOf(idx) >= 0;
          var dimsTxt = (it.dx * it.scale).toFixed(1) + " × " + (it.dy * it.scale).toFixed(1) + " × " + (it.dz * it.scale).toFixed(1) + " mm" + (it.visible === false ? " · (masqué)" : "");
          var stateBadge = iss.belowPlate.indexOf(idx) >= 0 ? "Sous Z0"
            : ((iss.elevated && iss.elevated.indexOf(idx) >= 0) ? "Surélevé Z>0"
            : (iss.oob.indexOf(idx) >= 0 ? "Hors plateau"
            : (iss.collideSet[idx] ? "Collision"
            : (it.loadState === "loading" ? "Chargement…"
            : (it.loadState === "unsupported" ? "Non .stl"
            : (it.loadState === "error" ? "Erreur STL" : (it.visible === false ? "Masqué (tranché)" : "")))))));
          objListWrap.append(h("div", {
            class: "p3d-studio-objrow" + (isSel ? " is-selected" : "") + (hasErr ? " is-warn" : "") + (it.visible === false ? " is-hidden" : ""),
            onclick: function () {
              studio.selected = idx;
              if (liveSync) liveSync();
            },
          }, [
            h("div", { class: "p3d-studio-objrow-top" }, [
              h("span", { class: "p3d-studio-swatch", style: "background:" + tCol, "aria-hidden": "true" }),
              h("strong", { class: "p3d-studio-objname", text: "[T" + tIdx + "] " + (it.localName || it.name) }),
              stateBadge ? h("span", { class: "p3d-studio-badge", text: stateBadge }) : null,
            ]),
            h("div", { class: "p3d-studio-objrow-meta" }, [
              h("span", { class: "p3d-meta", text: dimsTxt }),
              h("div", { class: "p3d-studio-objrow-acts" }, [
                h("button", { type: "button", class: "p3d-btn is-small", title: "Focus caméra", "aria-label": "Focus", text: "⌖", onclick: function (ev) { ev.stopPropagation(); studio.selected = idx; if (liveSync) liveSync(); if (studioPrepareViewport) studioPrepareViewport.focusItem(it); } }),
                h("button", { type: "button", class: "p3d-btn is-small", title: "Renommer", "aria-label": "Renommer", text: "✎", onclick: function (ev) {
                  ev.stopPropagation();
                  var nextName = (typeof window.prompt === "function") ? window.prompt("Nom local de l'objet :", it.localName || it.name) : null;
                  if (nextName && nextName.trim()) {
                    pushStudioHistory("Renommer");
                    it.localName = nextName.trim().slice(0, 60);
                    if (liveSync) liveSync();
                  }
                } }),
                h("button", { type: "button", class: "p3d-btn is-small",
                  title: it.visible === false ? "Afficher dans la vue (toujours tranché)" : "Masquer dans la vue (toujours tranché)",
                  "aria-label": it.visible === false ? "Afficher dans la vue (toujours tranché)" : "Masquer dans la vue (toujours tranché)",
                  text: it.visible === false ? "◌" : "👁", onclick: function (ev) {
                  ev.stopPropagation();
                  it.visible = it.visible === false;
                  if (liveSync) liveSync();
                } }),
                h("button", { type: "button", class: "p3d-btn is-small", title: "Dupliquer", "aria-label": "Dupliquer", text: "❐", onclick: function (ev) { ev.stopPropagation(); duplicateItemAt(idx); } }),
                h("button", { type: "button", class: "p3d-btn is-small", title: "Retirer", "aria-label": "Retirer", text: "✕", onclick: function (ev) { ev.stopPropagation(); removeItemAt(idx); } }),
              ]),
            ]),
          ]));
        });
      }

      function buildInspectorForSelected() {
        objInspectorHost.innerHTML = "";
        inspectorInputs = null;
        lastBuiltSel = studio.selected;
        var selItem = studio.selected >= 0 ? studio.items[studio.selected] : null;
        if (!selItem) {
          if (!studio.items.length) {
            objInspectorHost.append(h("p", { class: "p3d-meta", text: "Glisse-dépose un .stl, .3mf, .gcode ou .gx ici, clique sur « Ouvrir un fichier… » ou « + Ajouter »." }));
          } else {
            objInspectorHost.append(h("p", { class: "p3d-meta", text: "Clique un objet sur le plateau ou dans la liste pour modifier sa position, rotation ou échelle." }));
          }
          return;
        }
        // Preserve input order [0:X, 1:Y, 2:Rot Z, 3:Scale %] for downstream compatibility, followed by [4:Z, 5:Rot X, 6:Rot Y]
        var inX = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "1", value: String(selItem.x) });
        var inY = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "1", value: String(selItem.y) });
        var inR = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "15", value: String(selItem.rot_z || 0) });
        var inS = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "10", min: "10", max: "500", value: String(Math.round((selItem.scale || 1) * 100)) });
        var inZ = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "1", min: "-50", max: "500", value: String(selItem.z || 0) });
        var inRx = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "15", value: String(selItem.rot_x || 0) });
        var inRy = h("input", { class: "p3d-input p3d-ctl-num", type: "number", step: "15", value: String(selItem.rot_y || 0) });
        var dimLbl = h("span", { class: "p3d-meta p3d-studio-dims", text: "" });
        var itemToolOpts = visibleTools.map(function (_t, i) { return [String(i), "T" + i + " (" + visibleTools[i].material + ")"]; });
        var inT = sel(itemToolOpts, Math.min(availTools - 1, selItem.tool || 0), function (v) {
          pushStudioHistory("Changer outil");
          selItem.tool = Number(v || 0);
          invalidateStudioSlice();
          if (liveSync) liveSync();
        });

        function applyNumericEdits() {
          pushStudioHistory("Transformer " + (selItem.localName || selItem.name));
          selItem.x = Number(inX.value || 0);
          selItem.y = Number(inY.value || 0);
          selItem.z = Number(inZ.value || 0);
          selItem.rot_z = Number(inR.value || 0);
          selItem.rot_x = Number(inRx.value || 0);
          selItem.rot_y = Number(inRy.value || 0);
          selItem.scale = Math.max(0.1, Math.min(10, Number(inS.value || 100) / 100));
          var md = store ? store.getCached(selItem.model_id) : null;
          if (md) syncItemTiltedDims(selItem, md);
          invalidateStudioSlice();
          if (liveSync) liveSync();
        }
        [inX, inY, inR, inS, inZ, inRx, inRy].forEach(function (inp) {
          inp.addEventListener("change", applyNumericEdits);
        });
        function nudgeRot(delta) {
          pushStudioHistory("Rotation Z");
          selItem.rot_z = Math.round(Number(selItem.rot_z || 0) + delta);
          invalidateStudioSlice();
          if (liveSync) liveSync();
        }
        function nudgeScale(deltaPct) {
          pushStudioHistory("Échelle");
          var pct = Math.max(10, Math.min(500, Math.round(Number(selItem.scale || 1) * 100 + deltaPct)));
          selItem.scale = pct / 100;
          invalidateStudioSlice();
          if (liveSync) liveSync();
        }
        function countObjOverrides(ov) {
          if (!ov || typeof ov !== "object") return 0;
          return Object.keys(ov).filter(function (k) { return ov[k] !== "" && ov[k] != null; }).length;
        }
        function setObjOverride(key, rawVal) {
          pushStudioHistory("Surcharge objet (" + key + ")");
          if (!selItem.overrides || typeof selItem.overrides !== "object") selItem.overrides = {};
          if (rawVal === "" || rawVal == null) delete selItem.overrides[key];
          else selItem.overrides[key] = rawVal;
          invalidateStudioSlice();
          buildInspectorForSelected();
          if (liveSync) liveSync();
        }
        var ov = (selItem.overrides && typeof selItem.overrides === "object") ? selItem.overrides : {};
        var ovCount = countObjOverrides(ov);
        var ovFold = h("details", { class: "p3d-studio-fold p3d-studio-obj-slicing", open: ovCount > 0 }, [
          h("summary", { text: "Paramètres de tranche objet (" + (ovCount ? (ovCount + " modifié(s)") : "hérités du plateau") + ")" }),
          h("div", { class: "p3d-studio-fold-body p3d-studio-obj-ov" }, [
            h("label", {}, [
              "Remplissage % " + (ov.infill != null ? "(Modifié)" : "(Hérité : " + studio.cfg.infill + "%)"),
              numIn(ov.infill != null ? ov.infill : "", 0, 100, 5, "Hérité (" + studio.cfg.infill + "%)", function (v) {
                setObjOverride("infill", v === "" ? "" : Number(v));
              }),
            ]),
            h("label", {}, [
              "Parois " + (ov.wall_loops != null ? "(Modifié)" : "(Hérité : " + studio.cfg.wall_loops + ")"),
              numIn(ov.wall_loops != null ? ov.wall_loops : "", 1, 16, 1, "Hérité (" + studio.cfg.wall_loops + ")", function (v) {
                setObjOverride("wall_loops", v === "" ? "" : Number(v));
              }),
            ]),
            h("label", {}, [
              "Supports " + (ov.supports != null ? "(Modifié)" : "(Hérité)"),
              sel([["", "Hériter plateau"], ["1", "Forcer activés"], ["0", "Forcer désactivés"]], ov.supports === true ? "1" : (ov.supports === false ? "0" : ""), function (v) {
                setObjOverride("supports", v === "" ? "" : (v === "1"));
              }),
            ]),
            h("label", {}, [
              "Couture " + (ov.seam_position ? "(Modifié)" : "(Hérité)"),
              sel([["", "Hériter plateau"], ["aligned", "Alignée"], ["nearest", "Plus proche"], ["back", "Arrière"], ["random", "Aléatoire"]], ov.seam_position || "", function (v) {
                setObjOverride("seam_position", v);
              }),
            ]),
            h("label", {}, [
              "Repassage " + (ov.ironing_type ? "(Modifié)" : "(Hérité)"),
              sel([["", "Hériter plateau"], ["no_ironing", "Désactivé"], ["top", "Surfaces supérieures"], ["topmost", "Dernière couche"]], ov.ironing_type || "", function (v) {
                setObjOverride("ironing_type", v);
              }),
            ]),
            h("label", {}, [
              "Vitesse paroi ext. " + (ov.outer_wall_speed != null ? "(Modifié)" : "(Hérité)"),
              numIn(ov.outer_wall_speed != null ? ov.outer_wall_speed : "", 10, 600, 10, "Hérité", function (v) {
                setObjOverride("outer_wall_speed", v === "" ? "" : Number(v));
              }),
            ]),
            ovCount > 0 ? h("button", { type: "button", class: "p3d-btn is-small", text: "↺ Réinitialiser au plateau", onclick: function () {
              pushStudioHistory("Réinitialiser surcharges objet");
              selItem.overrides = {};
              invalidateStudioSlice();
              buildInspectorForSelected();
              if (liveSync) liveSync();
            } }) : null,
          ]),
        ]);

        inspectorInputs = { inX: inX, inY: inY, inZ: inZ, inR: inR, inRx: inRx, inRy: inRy, inS: inS, dimLbl: dimLbl, inT: inT };
        objInspectorHost.append(h("div", { class: "p3d-studio-obj" }, [
          h("div", { class: "p3d-studio-obj-head" }, [
            h("strong", { text: selItem.localName || selItem.name }),
            dimLbl,
          ]),
          h("label", {}, ["Extrudeur", inT]),
          h("label", {}, ["X (mm)", inX]),
          h("label", {}, ["Y (mm)", inY]),
          h("label", {}, ["Rot Z (°)", inR,
            h("button", { type: "button", class: "p3d-btn is-small", text: "-15°", onclick: function () { nudgeRot(-15); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "+15°", onclick: function () { nudgeRot(15); } }),
          ]),
          h("label", {}, ["Échelle (%)", inS,
            h("button", { type: "button", class: "p3d-btn is-small", text: "-10%", onclick: function () { nudgeScale(-10); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "+10%", onclick: function () { nudgeScale(10); } }),
          ]),
          h("label", {}, ["Z (mm)", inZ]),
          h("label", {}, ["Rot X (°)", inRx]),
          h("label", {}, ["Rot Y (°)", inRy]),
          h("div", { class: "p3d-studio-obj-acts" }, [
            h("button", { type: "button", class: "p3d-btn is-small", text: "Centrer", onclick: function () { centerItemAt(studio.selected); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Pose Z = 0", onclick: function () { dropToPlateAt(studio.selected); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Poser à plat", onclick: function () { layFlatAutoAt(studio.selected); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Choisir face", onclick: function () { setInteractionMode(studio.interactionMode === "layflat" ? "auto" : "layflat"); } }),
            h("button", { type: "button", class: "p3d-btn is-small", text: "Réinitialiser", onclick: function () { resetItemTransforms(studio.selected); } }),
          ]),
        ]), ovFold);
      }

      liveSync = function () {
        var iss = refreshPlacementBanner();
        undoBtn.disabled = !studio.history.past.length;
        redoBtn.disabled = !studio.history.future.length;
        renderObjectList(iss);
        if (lastBuiltSel !== studio.selected) buildInspectorForSelected();
        var curSel = studio.selected >= 0 ? studio.items[studio.selected] : null;
        if (curSel && inspectorInputs) {
          inspectorInputs.inX.value = String(curSel.x);
          inspectorInputs.inY.value = String(curSel.y);
          inspectorInputs.inZ.value = String(curSel.z || 0);
          inspectorInputs.inR.value = String(curSel.rot_z || 0);
          inspectorInputs.inRx.value = String(curSel.rot_x || 0);
          inspectorInputs.inRy.value = String(curSel.rot_y || 0);
          inspectorInputs.inS.value = String(Math.round((curSel.scale || 1) * 100));
          var sx = (curSel.dx * curSel.scale).toFixed(1);
          var sy = (curSel.dy * curSel.scale).toFixed(1);
          var sz = (curSel.dz * curSel.scale).toFixed(1);
          inspectorInputs.dimLbl.textContent = sx + " × " + sy + " × " + sz + " mm" + (curSel.boundsReady === false ? " (est.)" : "");
        }

        // Update floating stage status badge (loading, context loss, or layflat prompt)
        var loadingItem = studio.items.find(function (x) { return x.loadState === "loading"; });
        if (studio.interactionMode === "layflat") {
          stageStatus.hidden = false;
          stageStatus.textContent = "Mode « Face à plat » : clique directement sur la face d'un modèle STL pour la poser sur le plateau (Échap pour annuler).";
        } else if (loadingItem) {
          stageStatus.hidden = false;
          stageStatus.textContent = "Chargement 3D de " + loadingItem.name + (loadingItem.loadProgress ? " (" + loadingItem.loadProgress + "%)" : "…");
        } else {
          stageStatus.hidden = true;
          stageStatus.textContent = "";
        }

        var meshesMap = Object.create(null);
        var statsMap = Object.create(null);
        if (store && prep) {
          studio.items.forEach(function (it, idx) {
            var md = store.getCached(it.model_id, it.sourceVersion || undefined);
            if (md) {
              meshesMap[it.model_id] = md;
              statsMap[idx] = syncItemTiltedDims(it, md);
            }
          });
        }
        if (studioPrepareViewport) {
          studioPrepareViewport.setState({
            bed: bed,
            items: studio.items,
            selected: studio.selected,
            tools: studio.tools,
            issues: iss,
            meshes: meshesMap,
            statsMap: statsMap,
            interactionMode: studio.interactionMode,
          });
        }
      };

      studioRefreshLive = liveSync;

      if (prep && typeof prep.createViewport === "function") {
        var dragChanged = false;
        studioPrepareViewport = prep.createViewport(cvs, {
          initialCamera: studio.camera,
          onSelect: function (idx) {
            studio.selected = idx;
            liveSync();
          },
          onDragStart: function (idx) {
            dragChanged = false;
            studio.selected = idx;
            pushStudioHistory("Déplacer " + ((studio.items[idx] && (studio.items[idx].localName || studio.items[idx].name)) || "objet"));
          },
          onDragMove: function (idx, nx, ny) {
            var it = studio.items[idx];
            if (!it) return;
            if (it.x !== nx || it.y !== ny) dragChanged = true;
            it.x = nx;
            it.y = ny;
            liveSync();
          },
          onDragEnd: function (_idx, cancelled) {
            if (cancelled && dragChanged) {
              undoStudio();
              return;
            }
            if (!dragChanged && studio.history.past.length) {
              studio.history.past.pop(); // no-op drag produces 0 history clutter
            } else if (dragChanged) {
              invalidateStudioSlice();
              liveSync();
            }
          },
          onFacePick: function (idx, localNorm) {
            var it = studio.items[idx];
            if (!it || !localNorm || !prep) return;
            var ang = prep.layFlatAnglesForNormal(localNorm[0], localNorm[1], localNorm[2]);
            pushStudioHistory("Face à plat");
            it.rot_x = ang[0];
            it.rot_y = ang[1];
            it.z = 0;
            var md = store ? store.getCached(it.model_id, it.sourceVersion || undefined) : null;
            if (md) syncItemTiltedDims(it, md);
            studio.selected = idx;
            setInteractionMode("auto");
            invalidateStudioSlice();
            liveSync();
          },
          onCameraChange: function (c) {
            studio.camera = c;
          },
          onContextChange: function (lost) {
            stageStatus.hidden = !lost;
            if (lost) stageStatus.textContent = "Contexte WebGL interrompu — restauration automatique…";
          },
        });
      }

      // Kick off any STL mesh loads that were added before WebGL was open (or with cached bounds_mm)
      if (store && window.HQModel) {
        studio.items.forEach(function (it) {
          if (String(it.ext || "").toLowerCase() === "stl" && !store.getCached(it.model_id, it.sourceVersion || undefined)) {
            var e = store.getEntry(it.model_id);
            if (!e || e.status === "error" || e.status === "cancelled" || (it.sourceVersion && e.version && e.version !== it.sourceVersion)) {
              reacquireStudioStl({ id: it.model_id, name: it.name, ext: "stl", source_sha256: it.sourceVersion || "" }, it.sourceVersion || "", !!(it.sourceVersion && e && e.version && e.version !== it.sourceVersion));
            }
          }
        });
      }
      liveSync();
    } else {
      // Aperçu Mode (3D G-code toolpath viewer with explicit 2D sampled fallback)
      if (!studio.slicedModel || !studio.slicedModel.id) {
        stage.append(h("div", { class: "p3d-studio-empty-drop" }, [
          h("strong", { text: "Aucun G-code tranché en mémoire" }),
          h("p", { class: "p3d-help", text: "Glisse-dépose un .gcode, .gx ou .3mf tranché ici, ouvre un fichier depuis cet appareil, ou clique sur « Trancher » dans Préparer." }),
          h("div", { class: "p3d-actions" }, [
            h("button", { type: "button", class: "p3d-btn is-primary", text: "Ouvrir un fichier…", onclick: function () { studioFileInput.click(); } }),
            h("button", { type: "button", class: "p3d-btn", text: "Choisir depuis Modèles", onclick: openAddPicker }),
          ]),
        ]));
      } else {
        var sToken = studioPreviewToken;
        mountGcodePreviewPanel(stage, {
          modelId: studio.slicedModel.id,
          plate: studio.plate || 1,
          inspectInfo: studio.slicedInfo,
          printer: selPr,
          bed: bed,
          toolColors: studio.tools.map(function (t) { return t.color; }),
          force2d: !!studio.use2d,
          compact: false,
          tokenCheck: function () { return sToken === studioPreviewToken; },
          registerViewer: function (v) { studioViewer = v; },
          onPlateChange: function (newPlate) { studio.plate = newPlate; },
          onModeSwitch: function (is2d) { studio.use2d = !!is2d; },
        });
      }
    }

    var dropOverlay = h("div", { class: "p3d-studio-dropoverlay", "aria-hidden": "true" }, [
      h("strong", { text: "Déposer des fichiers ici" }),
      h("span", { class: "p3d-meta", text: ".stl · .glb · .3mf · .gcode · .gx pour ouvrir dans le Studio" }),
    ]);

    var subnav = h("div", { class: "p3d-studio-subnav" }, [
      h("button", { type: "button", class: "p3d-tag" + (studio.mode === "prepare" && studio.mobileFocus === "prepare" ? " is-on" : ""), text: "Préparer", onclick: function () { studio.mode = "prepare"; studio.mobileFocus = "prepare"; renderStudio(); } }),
      h("button", { type: "button", class: "p3d-tag" + (studio.mode === "prepare" && studio.mobileFocus === "settings" ? " is-on" : ""), text: "Réglages", onclick: function () { studio.mode = "prepare"; studio.mobileFocus = "settings"; renderStudio(); } }),
      h("button", { type: "button", class: "p3d-tag" + (studio.mode === "prepare" && studio.mobileFocus === "materials" ? " is-on" : ""), text: "Matériaux", onclick: function () { studio.mode = "prepare"; studio.mobileFocus = "materials"; renderStudio(); } }),
      h("button", { type: "button", class: "p3d-tag" + (studio.mode === "preview" ? " is-on" : ""), text: "Aperçu", onclick: function () { studio.mode = "preview"; studio.mobileFocus = "preview"; renderStudio(); } }),
      h("span", { class: "p3d-meta p3d-studio-proj-badge", text: "Projet : " + ((studio.project && studio.project.title) || "Nouveau plateau") + (studio.project && studio.project.dirty ? " *" : "") }),
    ]);

    pane.append(studioFileInput, toolbar, subnav, studioUploadBar, addPick, dropOverlay,
      h("div", { class: "p3d-studio-layout" }, [objectsPanel, stage, sidebar]));
  }

  // ── settings ──
  function printerForm(p) {
    p = p || {};
    var f = {
      name: h("input", { class: "p3d-input", value: p.name || "", placeholder: "A1 mini (AMS Lite)", maxlength: "40" }),
      kind: h("select", { class: "p3d-input" }, [h("option", { value: "bambu", text: KIND_LABEL.bambu }), h("option", { value: "flashforge", text: KIND_LABEL.flashforge })]),
      model: h("select", { class: "p3d-input", "aria-label": "Modèle", "data-field": "model" }),
      ip: h("input", { class: "p3d-input", value: p.ip || "", placeholder: "192.168.1.50", inputmode: "decimal" }),
      serial: h("input", { class: "p3d-input", value: p.serial || "", placeholder: "Numéro de série" }),
      code: h("input", { class: "p3d-input", type: "password", autocomplete: "off", placeholder: p.has_code ? "•••••• (inchangé)" : "Code d'accès / check code" }),
      bedX: h("input", { class: "p3d-input", type: "number", min: "20", max: "2000", step: "1", value: p.bed ? String(p.bed.x) : "", placeholder: "X" }),
      bedY: h("input", { class: "p3d-input", type: "number", min: "20", max: "2000", step: "1", value: p.bed ? String(p.bed.y) : "", placeholder: "Y" }),
      bedZ: h("input", { class: "p3d-input", type: "number", min: "20", max: "2000", step: "1", value: p.bed ? String(p.bed.z) : "", placeholder: "Z" }),
    };
    f.kind.value = p.kind || "bambu";
    function fillModels(chosen) {
      var list = FAMILY_MODELS[f.kind.value] || FAMILY_MODELS.bambu;
      f.model.innerHTML = "";
      list.forEach(function (mName) { f.model.append(h("option", { value: mName, text: mName })); });
      f.model.value = (chosen && list.indexOf(chosen) >= 0) ? chosen : list[0];
      var c = MODEL_CAPS[f.model.value];
      if (c && c.bed && !p.bed) {
        f.bedX.placeholder = String(c.bed.x);
        f.bedY.placeholder = String(c.bed.y);
        f.bedZ.placeholder = String(c.bed.z);
      }
    }
    fillModels(p.model || "");
    var help = h("p", { class: "p3d-help" });
    function helpText() {
      help.textContent = f.kind.value === "bambu"
        ? "Bambu : sur l'écran de l'imprimante → Réglages → LAN Only + Developer Mode. Le code d'accès et l'IP y sont affichés ; le numéro de série est dans Réglages → Appareil."
        : "Flashforge : écran → Réglages → Réseau, active le mode LAN ; le numéro de série et le check code y sont affichés.";
    }
    f.kind.addEventListener("change", function () { fillModels(""); helpText(); });
    f.model.addEventListener("change", function () {
      var c = MODEL_CAPS[f.model.value];
      if (c && c.bed) {
        f.bedX.value = String(c.bed.x);
        f.bedY.value = String(c.bed.y);
        f.bedZ.value = String(c.bed.z);
      }
    });
    helpText();
    return h("form", { class: "p3d-form", onsubmit: function (e) {
      busyForm(e, "Enregistrement…", function () {
        var body = { id: p.id || "", name: f.name.value, kind: f.kind.value, model: f.model.value,
          ip: f.ip.value, serial: f.serial.value, code: f.code.value };
        if (f.bedX.value !== "" && f.bedY.value !== "" && f.bedZ.value !== "")
          body.bed = { x: Number(f.bedX.value), y: Number(f.bedY.value), z: Number(f.bedZ.value) };
        return post("/api/print3d/printer/save", body)
          .then(function () { toast("Imprimante enregistrée"); return refresh(); })
          .then(renderSettings);
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("label", {}, ["Nom", f.name]), h("label", {}, ["Type", f.kind]), h("label", {}, ["Modèle", f.model]),
      h("label", {}, ["Adresse IP locale", f.ip]),
      h("label", {}, ["Numéro de série", f.serial]), h("label", {}, ["Code", f.code]), help,
      h("label", {}, ["Plateau X / Y / Z (mm) — pour le préflight des modèles",
        h("div", { class: "p3d-bed-row" }, [f.bedX, f.bedY, f.bedZ])]),
      h("div", { class: "p3d-actions" }, [
        p.id ? h("button", { type: "button", class: "p3d-btn is-danger", text: "Retirer", onclick: function () {
          if (!confirm("Retirer " + p.name + " de l'atelier ?")) return;
          post("/api/print3d/printer/delete", { id: p.id }).then(refresh).then(renderSettings).catch(function (err) { toast(err.message, "err"); });
        } }) : null,
        h("button", { type: "submit", class: "p3d-btn is-primary", text: p.id ? "Enregistrer" : "Ajouter" }),
      ]),
    ]);
  }

  function renderSettings() {
    var pane = ui.panes.settings;
    if (!loaded.printers) {                       // no half-empty form flashing before the first payload
      pane.innerHTML = "";
      pane.append(skeletonRows(3));
      return;
    }
    var cfg = data.config || { printers: [], makerworld: {} };
    pane.innerHTML = "";
    pane.append(h("h3", { class: "p3d-h3", text: "Imprimantes" }));
    (cfg.printers || []).forEach(function (p) {
      pane.append(h("details", { class: "p3d-details" }, [h("summary", { text: p.name + " · " + (KIND_LABEL[p.kind] || p.kind) + " · " + p.ip }), printerForm(p)]));
    });
    pane.append(h("details", { class: "p3d-details", open: !(cfg.printers || []).length }, [h("summary", { text: "＋ Ajouter une imprimante" }), printerForm(null)]));

    var mw = cfg.makerworld || {};
    var handle = h("input", { class: "p3d-input", value: mw.handle || "", placeholder: "ton pseudo (sans @)" });
    var uid = h("input", { class: "p3d-input", type: "number", min: "0", value: mw.uid ? String(mw.uid) : "", placeholder: "trouvé automatiquement si possible" });
    var cookie = h("textarea", { class: "p3d-input", rows: "3", autocomplete: "off", placeholder: mw.has_cookie ? "Cookie enregistré — colle-en un nouveau pour le remplacer" : "Colle ici l'en-tête Cookie de makerworld.com" });
    var ua = h("input", { class: "p3d-input", autocomplete: "off", placeholder: mw.has_ua ? "User-Agent enregistré" : "User-Agent du navigateur (navigator.userAgent)" });
    pane.append(h("h3", { class: "p3d-h3", text: "MakerWorld" }), h("form", { class: "p3d-form", onsubmit: function (e) {
      busyForm(e, "Enregistrement…", function () {
        return post("/api/print3d/settings", { handle: handle.value, uid: Number(uid.value || 0), cookie: cookie.value, ua: ua.value })
          .then(function () { toast("MakerWorld enregistré"); cookie.value = ""; ua.value = ""; return refresh(); })
          .then(renderSettings);
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("label", {}, ["Pseudo", handle]), h("label", {}, ["uid (optionnel)", uid]),
      h("label", {}, ["Cookie de session", cookie]), h("label", {}, ["User-Agent", ua]),
      h("p", { class: "p3d-help", text: "Les statistiques par modèle passent sans cookie. Le profil (abonnés, boosts, points) est protégé par Cloudflare : connecte-toi à makerworld.com, ouvre les outils de développement → Réseau, copie l'en-tête « Cookie » d'une requête et ton User-Agent. Ils restent dans .hq-agent-state, jamais renvoyés ni journalisés. L'uid est le nombre dans l'URL de ton avatar." }),
      h("div", { class: "p3d-actions" }, [
        mw.has_cookie ? h("button", { type: "button", class: "p3d-btn is-danger", text: "Oublier le cookie", onclick: function () {
          post("/api/print3d/settings", { clear_cookie: true, clear_ua: true }).then(refresh).then(renderSettings)
            .catch(function (err) { toast(err.message, "err"); });
        } }) : null,
        h("button", { type: "submit", class: "p3d-btn is-primary", text: "Enregistrer" }),
      ]),
    ]));

    var wcfg = cfg.watch || {};
    var wOn = h("input", { type: "checkbox" }), wPause = h("input", { type: "checkbox" });
    wOn.checked = !!wcfg.enabled; wPause.checked = !!wcfg.auto_pause;
    var wEvery = h("input", { class: "p3d-input", type: "number", min: "120", max: "900", step: "30", value: String(wcfg.interval_sec || 180) });
    pane.append(h("h3", { class: "p3d-h3", text: "Surveillance des impressions" }), h("form", { class: "p3d-form", onsubmit: function (e) {
      busyForm(e, "Enregistrement…", function () {
        return post("/api/print3d/settings", { watch: { enabled: wOn.checked, auto_pause: wPause.checked, interval_sec: Number(wEvery.value || 180) } })
          .then(function () { toast("Surveillance enregistrée"); return refresh(); }).then(renderSettings);
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("p", { class: "p3d-help", text: "Pendant qu'une impression tourne, HQ envoie une image de la caméra au modèle de vision (Gemini) à intervalle régulier pour repérer un spaghetti, une pièce décollée ou tombée. Un seul doute ne déclenche rien : il faut deux avis négatifs d'affilée. L'alerte apparaît sur la carte, Elsea la murmure et, si les notifications sont activées, ton téléphone sonne. L'image n'est pas conservée. Ce n'est pas infaillible : des fausses alertes et des échecs manqués restent possibles." }),
      h("label", { class: "p3d-check" }, [wOn, " Surveiller les impressions en cours"]),
      h("label", { class: "p3d-check" }, [wPause, " Mettre en pause automatiquement après un échec confirmé (jamais d'arrêt ; une seule fois par impression)"]),
      h("label", {}, ["Intervalle entre deux regards (secondes, 120–900)", wEvery]),
      h("p", { class: "p3d-help", text: "Regards aujourd'hui : " + (wcfg.checks_today || 0) + " / " + (wcfg.max_per_day || 300) + " (le quota Google est partagé avec le chat)." }),
      h("div", { class: "p3d-actions" }, [h("button", { type: "submit", class: "p3d-btn is-primary", text: "Enregistrer" })]),
    ]));

    var acfg = cfg.mw_alerts || {};
    var aOn = h("input", { type: "checkbox" }), aPush = h("input", { type: "checkbox" });
    aOn.checked = acfg.enabled !== false; aPush.checked = !!acfg.push;
    var aJump = h("input", { class: "p3d-input", type: "number", min: "1", max: "5000", value: String(acfg.min_jump || 10) });
    var aRatio = h("input", { class: "p3d-input", type: "number", min: "5", max: "1000", value: String(acfg.ratio_pct || 50) });
    pane.append(h("h3", { class: "p3d-h3", text: "Alertes MakerWorld" }), h("form", { class: "p3d-form", onsubmit: function (e) {
      busyForm(e, "Enregistrement…", function () {
        return post("/api/print3d/settings", { mw_alerts: { enabled: aOn.checked, push: aPush.checked, min_jump: Number(aJump.value || 10), ratio_pct: Number(aRatio.value || 50) } })
          .then(function () { toast("Alertes enregistrées"); return refresh(); }).then(renderSettings);
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("p", { class: "p3d-help", text: "À chaque relevé (toutes les 6 h) : un modèle qui gagne beaucoup de téléchargements ou d'impressions en environ un jour, ou de nouveaux commentaires (le nombre seulement, pas le texte). Elsea le murmure." }),
      h("label", { class: "p3d-check" }, [aOn, " Alerter pour les pics et les commentaires"]),
      h("label", { class: "p3d-check" }, [aPush, " Envoyer aussi une notification sur le téléphone"]),
      h("label", {}, ["Gain minimum (téléchargements ou impressions)", aJump]),
      h("label", {}, ["…et au moins ce pourcentage du total d'hier", aRatio]),
      h("div", { class: "p3d-actions" }, [h("button", { type: "submit", class: "p3d-btn is-primary", text: "Enregistrer" })]),
    ]));

    var extra = h("input", { class: "p3d-input", value: cfg.models_extra_root || "", placeholder: "C:\\Users\\…\\Documents\\CAD" });
    pane.append(h("h3", { class: "p3d-h3", text: "Bibliothèque" }), h("form", { class: "p3d-form", onsubmit: function (e) {
      busyForm(e, "Enregistrement…", function () {
        return post("/api/print3d/settings", { models_extra_root: extra.value })
          .then(function () { toast("Dossier enregistré"); return refresh(); });
      }).catch(function (err) { toast(err.message, "err"); });
    } }, [
      h("p", { class: "p3d-help", text: "Le dossier Print de Fichiers est toujours indexé. Ajoute un dossier de plus (tes sources CAO, par exemple) : lu seulement, jamais modifié, liens symboliques ignorés." }),
      h("label", {}, ["Dossier supplémentaire", extra]),
      h("div", { class: "p3d-actions" }, [h("button", { type: "submit", class: "p3d-btn is-primary", text: "Enregistrer" })]),
    ]));
  }

  // ── public ──
  function show(host, apiFn, section) {
    api = apiFn;
    if (!ui || ui.host !== host || !host.contains(ui.root)) build(host);
    if (stateAt && Date.now() - stateAt > STALE_AFTER_MS) setStale(true, "actualisation…");
    setTab(section && ui.panes[section] ? section : tab, true);   // show() does its own refresh
    visible = true;
    pollFailures = 0;
    refresh().then(function (ok) {
      if (!visible) return;
      afterPoll(ok);
      if (ok) loadJobs();   /* after the state, never before: the first request of a view is its state */
      if (tab === "settings") renderSettings();
    });
  }

  function hide() {
    visible = false;
    flushPollStats();
    stopPolling();
    closeAllCams();
    disposeStudioViewer();
    if (studioMeshStore) {
      try { studioMeshStore.dispose(); } catch (_) {}
      studioMeshStore = null;
    }
    if (ui) closeOverlay();
    setStale(false);
    if (document.body && document.body.classList) document.body.classList.remove("is-p3d-under-floor");
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", moveTabline);   // the underline follows a reflowed tablist
  }
  document.addEventListener("visibilitychange", function () {
    if (!visible) return;
    if (document.hidden) {
      closeAllCams();
      stopPolling();
      return;
    }
    // Back on screen: refresh now instead of waiting out the current delay. refresh() marks old
    // data as stale before its request, so the wake-up age is visible while the fetch runs.
    refresh().then(afterPoll);
  });

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", function () {
      if (!visible) return;
      if (stateAt) setStale(true, "reconnexion…");
      refresh().then(afterPoll);
    });
    window.addEventListener("offline", function () {
      if (visible && stateAt) setStale(true, "hors ligne");
    });
  }

  document.addEventListener("keydown", function (e) {
    if (!visible || !ui) return;
    if (!ui.overlay.hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeOverlay(); return; }
      if (e.key === "Tab") trapFocus(e);
      return;
    }
    if (tab !== "studio" || studio.mode !== "prepare") return;
    var active = document.activeElement;
    var tag = active && active.tagName ? active.tagName.toLowerCase() : "";
    var editingText = tag === "input" || tag === "textarea" || tag === "select" || (active && active.isContentEditable);
    if (editingText) return;
    var mod = e.ctrlKey || e.metaKey;
    var k = String(e.key || "").toLowerCase();
    if (mod && !e.shiftKey && k === "z") {
      e.preventDefault();
      undoStudio();
    } else if ((mod && e.shiftKey && k === "z") || (mod && k === "y")) {
      e.preventDefault();
      redoStudio();
    } else if ((e.key === "Delete" || e.key === "Backspace") && studio.selected >= 0 && studio.items[studio.selected]) {
      e.preventDefault();
      var rem = studio.items[studio.selected];
      pushStudioHistory("Retirer " + (rem.localName || rem.name));
      if (studioMeshStore && rem.model_id) studioMeshStore.release(rem.model_id);
      studio.items.splice(studio.selected, 1);
      studio.selected = studio.items.length ? Math.min(studio.selected, studio.items.length - 1) : -1;
      invalidateStudioSliceGlobal();
      renderStudio();
    } else if (e.key === "Escape") {
      if (studio.interactionMode && studio.interactionMode !== "auto") {
        studio.interactionMode = "auto";
        renderStudio();
      } else if (studio.selected >= 0) {
        studio.selected = -1;
        if (typeof studioRefreshLive === "function") studioRefreshLive();
      }
    }
  });

  // Read-only test hooks, same convention as canvas.hqModelView in hq-model-view.js.
  window.HqPrint3d = { show: show, hide: hide,
    _hooks: { probeStl: probeStl, fetchStl: fetchStl, pollOnce: pollOnce, flushPollStats: flushPollStats,
      meshPreflight: meshPreflight, printerBed: printerBed, mountGcodePreviewPanel: mountGcodePreviewPanel,
      openFilesInStudio: openFilesInStudio, undoStudio: undoStudio, redoStudio: redoStudio,
      autoArrangeStudioItems: autoArrangeStudioItems, studio: studio,
      modelSourceVersion: modelSourceVersion, syncStudioSourceVersions: syncStudioSourceVersions,
      stlDimsCache: stlDimsCache, qualityPresetDefaults: qualityPresetDefaults,
      studioApplyLoadedProject: studioApplyLoadedProject,
      studioBuildProjectPayload: studioBuildProjectPayload } };
})();
