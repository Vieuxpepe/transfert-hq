/* Transfert HQ — Static floating chip & Project G lab drawer (assets/hq-static-chip.js) */
(function () {
  "use strict";

  var ID = "hq-static-chip";
  if (document.getElementById(ID)) return;

  var LS_POS = "hq_static_chip_pos_v1";
  var LS_SCALE = "hq_static_chip_scale_v1";
  var LS_NSFW = "hq_companion_nsfw";
  var PORTRAIT_SFW = "/assets/companion/static-chip-sfw.webp";
  var BODY_NSFW = "/assets/companion/static-body-nsfw.webp";
  var DRAG_THRESHOLD = 7;

  var QUIPS_SFW = [
    "Watch. Click. Stay. Lab's quiet without you, Master.",
    "404s collected today: twelve. Still watching your screen?",
    "Big Sister's busy. I kept the stray artefact warm.",
    "Loop knitted. Signal clean. Your turn, Master."
  ];
  var QUIPS_NSFW = [
    "Look back. Over shoulder. Like what you see, Master?",
    "Safety yellow. Diamond mesh. Come closer.",
    "Left an artefact on purpose. Catch me if you care.",
    "Lab's locked. Just us. Watching?"
  ];

  var dock = document.createElement("div");
  dock.id = "hq-static-chip-dock";
  dock.className = "hq-static-chip-dock";

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  button.className = "hq-static-chip";
  button.setAttribute("aria-label", "Static — ouvrir la petite sœur Project G");
  button.title = "Static — Project G Lab · glisser pour déplacer";

  var frame = document.createElement("span");
  frame.className = "hq-static-chip-frame";

  var art = document.createElement("img");
  art.className = "hq-static-chip-art";
  art.alt = "Static";
  art.decoding = "async";
  art.addEventListener("load", function () { button.classList.add("has-art"); });
  art.addEventListener("error", function () { button.classList.remove("has-art"); });
  frame.appendChild(art);

  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "hq-static-chip-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>';

  button.append(frame, icon);
  dock.appendChild(button);
  document.body.appendChild(dock);

  var drawer = document.createElement("aside");
  drawer.id = "hq-static-drawer";
  drawer.className = "hq-static-drawer";
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Static — Project G Lab");
  drawer.innerHTML =
    '<div class="hq-static-drawer-head">' +
      '<div class="hq-static-drawer-brand">' +
        '<div class="hq-static-drawer-orb">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="hq-static-drawer-title">Static</div>' +
          '<div class="hq-static-drawer-sub" id="hq-static-drawer-sub">Project G Lab · Little Sister</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="hq-static-icon-btn" id="hq-static-close" aria-label="Fermer">✕</button>' +
    '</div>' +
    '<div class="hq-static-drawer-body">' +
      '<div class="hq-static-quote" id="hq-static-quote"></div>' +
      '<div class="hq-static-actions">' +
        '<button type="button" class="hq-static-btn" id="hq-static-ping">Ping Static</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(drawer);

  var quoteEl = document.getElementById("hq-static-quote");
  var subEl = document.getElementById("hq-static-drawer-sub");
  var closeBtn = document.getElementById("hq-static-close");
  var pingBtn = document.getElementById("hq-static-ping");

  function isNsfwOn() {
    try { return localStorage.getItem(LS_NSFW) === "1"; } catch (_) { return false; }
  }

  function pickQuip() {
    var pool = isNsfwOn() ? QUIPS_NSFW : QUIPS_SFW;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function applyMode() {
    var nsfw = isNsfwOn();
    button.classList.toggle("is-nsfw", nsfw);
    var target = nsfw ? BODY_NSFW : PORTRAIT_SFW;
    if (art.getAttribute("src") !== target) art.setAttribute("src", target);
    if (subEl) subEl.textContent = nsfw ? "Project G Lab · NSFW Pinup" : "Project G Lab · Little Sister";
  }

  window.addEventListener("storage", function (ev) {
    if (!ev || ev.key === LS_NSFW) applyMode();
  });
  window.addEventListener("hq:companion-nsfw", applyMode);

  function openDrawer() {
    if (quoteEl) quoteEl.textContent = pickQuip();
    drawer.hidden = false;
  }

  function closeDrawer() {
    drawer.hidden = true;
  }

  closeBtn.addEventListener("click", closeDrawer);
  pingBtn.addEventListener("click", function () {
    if (quoteEl) quoteEl.textContent = pickQuip();
  });

  if (window.HqImageChipScale) {
    try {
      window.HqImageChipScale.attach({
        chip: button,
        dock: dock,
        storageKey: LS_SCALE,
      });
    } catch (_) {}
  }

  var drag = null;
  function loadPos() {
    try {
      var raw = localStorage.getItem(LS_POS);
      if (!raw) return;
      var pos = JSON.parse(raw);
      if (typeof pos.x === "number" && typeof pos.y === "number") {
        dock.style.left = Math.max(8, Math.min(window.innerWidth - 68, pos.x)) + "px";
        dock.style.top = Math.max(8, Math.min(window.innerHeight - 68, pos.y)) + "px";
        dock.style.right = "auto";
        dock.style.bottom = "auto";
      }
    } catch (_) {}
  }
  loadPos();

  button.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    var rect = dock.getBoundingClientRect();
    drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: rect.left, oy: rect.top, moved: false };
    try { button.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  button.addEventListener("pointermove", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var dx = ev.clientX - drag.sx;
    var dy = ev.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      dock.classList.add("is-dragging");
    }
    if (drag.moved) {
      var nx = Math.max(8, Math.min(window.innerWidth - 68, drag.ox + dx));
      var ny = Math.max(8, Math.min(window.innerHeight - 68, drag.oy + dy));
      dock.style.left = nx + "px";
      dock.style.top = ny + "px";
      dock.style.right = "auto";
      dock.style.bottom = "auto";
    }
  });
  button.addEventListener("pointerup", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var wasMoved = drag.moved;
    dock.classList.remove("is-dragging");
    if (wasMoved) {
      var rect = dock.getBoundingClientRect();
      try { localStorage.setItem(LS_POS, JSON.stringify({ x: rect.left, y: rect.top })); } catch (_) {}
    } else {
      if (drawer.hidden) openDrawer(); else closeDrawer();
    }
    drag = null;
  });

  applyMode();
})();
