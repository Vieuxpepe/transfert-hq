/* Transfert HQ — compact floating Musica chip.
   SFW: neutral music note. Adult mode: the full-body Musica portrait.
   Draggable; pinch / Ctrl+wheel resizes; position and scale persist locally. */
(function () {
  "use strict";

  var ID = "hq-musica-chip";
  if (document.getElementById(ID)) return;

  var ART = "/assets/companion/musica-chip-nsfw-notail-noears.webp?v=3";
  var BODY_PLATE = "/assets/companion/musica-chip-body-plate.webp";
  var ART_2X = "/assets/companion/musica-chip-nsfw-notail-noears@2x.webp?v=3";
  var TAIL_ART = "/assets/companion/musica-tail-overlay.webp?v=2";
  var TAIL_ART_2X = "/assets/companion/musica-tail-overlay@2x.webp?v=2";
  var LS_NSFW = "hq_companion_nsfw";
  var LS_POS = "hq_musica_chip_pos_v1";
  var LS_SCALE = "hq_musica_chip_scale_v1";
  var LS_MEM = "hq_musica_chip_mem_v1";
  var DRAG_THRESHOLD = 7;

  var chipMem = (function loadChipMemory() {
    var d = new Date();
    var dayKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    var base = { dayKey: dayKey, hits: 0, pets: 0, milestone: 0, greetedDay: "" };
    try {
      var raw = window.localStorage.getItem(LS_MEM);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.dayKey === dayKey) {
          base.hits = Number(parsed.hits) || 0;
          base.pets = Number(parsed.pets) || 0;
          base.milestone = Number(parsed.milestone) || 0;
          base.greetedDay = String(parsed.greetedDay || "");
        }
      }
    } catch (_) {}
    return base;
  })();

  function saveChipMemory() {
    try { window.localStorage.setItem(LS_MEM, JSON.stringify(chipMem)); } catch (_) {}
  }

  function lateNightHour() {
    var h = new Date().getHours();
    return h >= 22 || h < 5;
  }

  var dock = document.createElement("div");
  dock.id = "hq-musica-chip-dock";
  dock.className = "hq-musica-chip-dock";
  dock.hidden = true;
  function sfx(kind) { try { if (window.HqAssistantSfx) window.HqAssistantSfx.play("musica", kind); } catch (_) {} }
  try { if (window.HqAssistantSfx) window.HqAssistantSfx.register("musica", function () { return dock; }); } catch (_) {}

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  button.className = "hq-musica-chip";
  if (beatMissing) button.setAttribute("data-beat", "off"); // the degraded chip is visible to CSS and tests
  button.setAttribute("aria-label", "Musica — open the music steward");
  button.title = "Musica — drag · pinch or Ctrl+wheel = size · +/− on the keyboard";

  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "hq-musica-chip-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.innerHTML =
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M9 18V6l12-2v12"/>' +
    '<circle cx="7" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<circle cx="19" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>';

  var art = document.createElement("img");
  art.className = "hq-musica-chip-art";
  art.alt = "";
  art.decoding = "async";
  art.loading = "lazy";
  art.draggable = false;
  art.addEventListener("load", function () {
    button.classList.remove("is-art-error");
  });
  art.addEventListener("error", function () {
    button.classList.add("is-art-error");
  });

  var WAVE_BARS = 24;
  var wave = document.createElement("div");
  wave.className = "hq-musica-chip-wave";
  wave.setAttribute("aria-hidden", "true");
  for (var waveIndex = 0; waveIndex < WAVE_BARS; waveIndex += 1) {
    var waveBar = document.createElement("i");
    waveBar.style.setProperty("--a", (waveIndex * (360 / WAVE_BARS)).toFixed(2) + "deg");
    waveBar.style.setProperty("--wave-delay", (-(waveIndex * 0.045)).toFixed(3) + "s");
    wave.appendChild(waveBar);
  }

  var warpCanvas = document.createElement("canvas");
  warpCanvas.className = "hq-musica-chip-warp";
  warpCanvas.width = 512;
  warpCanvas.height = 512;
  warpCanvas.setAttribute("aria-hidden", "true");

  var tailTipArt = document.createElement("img");
  tailTipArt.className = "hq-musica-chip-tailtip";
  tailTipArt.alt = "";
  tailTipArt.decoding = "async";
  tailTipArt.loading = "lazy";
  tailTipArt.draggable = false;


  /* Tail: mesh-bent canvas. Each vertex of a coarse grid over the tail art swings around the tail root by an
     angle that grows with its arc length from the root (precomputed `tv`, 0..99), so the base stays put and
     merges with the back while the tip whips. Falls back to the static <img> (reduced motion / no canvas). */
  var TAIL_MESH = {
    C: 16, X0: 320, Y0: 64, COLS: 19, ROWS: 26, PX: 499, PY: 460,
    sh: [[495, 431, 4, 38, 44, 0.27], [507, 393, 12, 40, 49, 0.29],
      [479, 348, 21, 38, 42, 0.10]],
    tv: [69,69,69,68,69,70,71,73,74,75,78,79,80,80,85,85,86,86,86,87,67,69,69,69,68,69,70,73,74,75,76,78,79,81,83,86,86,86,87,87,67,67,69,69,68,68,69,70,71,72,74,75,77,80,82,85,86,87,87,88,67,67,67,69,68,67,66,67,69,70,71,73,76,78,81,84,87,87,88,88,67,67,67,66,66,65,63,65,66,67,69,72,74,77,80,83,86,88,88,88,66,66,66,64,63,62,61,62,63,64,68,71,74,78,81,83,86,89,90,90,61,62,62,61,60,59,58,59,61,62,66,71,80,80,82,85,87,90,91,93,59,59,60,58,57,56,55,56,57,61,62,81,81,83,84,86,89,91,93,93,57,57,57,56,54,53,52,53,53,57,87,87,87,87,87,88,90,93,93,93,55,55,54,53,52,50,49,50,50,50,87,87,90,90,90,91,92,94,94,94,51,52,51,50,49,48,47,49,49,49,92,92,92,92,93,94,95,96,96,95,51,51,48,47,46,45,44,43,41,39,94,94,94,94,95,97,98,98,97,96,51,47,46,44,43,42,41,39,38,35,31,94,96,96,98,99,99,98,98,97,44,44,44,42,40,39,38,37,35,33,29,28,96,98,98,99,99,99,98,98,44,43,41,40,38,36,35,34,33,31,28,27,25,98,98,99,99,99,99,98,41,41,40,39,36,34,32,31,30,29,28,25,25,24,22,99,99,99,99,99,40,40,37,36,34,32,30,29,27,26,25,24,24,22,21,20,20,19,99,99,37,37,35,35,33,30,28,26,25,23,22,21,21,21,20,19,19,19,18,18,35,35,35,31,31,30,27,24,22,21,19,18,19,20,19,19,18,18,18,18,35,35,31,31,30,27,25,22,20,18,17,15,16,17,18,18,18,18,18,18,35,31,31,30,30,27,24,20,19,16,14,13,13,14,15,15,15,15,15,15,31,31,30,30,27,24,22,20,16,13,11,10,10,11,13,13,15,15,15,15,31,30,30,30,24,24,20,16,10,10,10,7,7,8,10,12,13,13,15,15,30,30,30,27,24,22,20,10,10,10,4,4,5,6,6,8,10,12,13,13,30,30,30,24,24,20,0,0,0,0,0,1,1,2,4,6,6,6,10,12,30,30,24,24,0,0,0,0,0,0,0,0,0,0,0,2,4,6,6,6,30,30,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,6],
    flags: "00000001111111100000000011111111111000000011111111111110000111111111111111000111111111111111110001111111000111111001111111000011111100111111000001111110011111100000111111001111110000001111101111111000000111110011111100000011110001111111000000000000011111110000000000001111111100000000000111111111100000000001111111111000000000011111111110000000000111111111000000000000111111110000000000000111110000000000000001111000000000000000111000000000000000011100000000000000000000000000000000000000000000"
  };
  // Rest pose in portrait UVs. The pivot sits halfway between the two hip centers.
  var HIP_LEFT = [0.468, 0.265], HIP_RIGHT = [0.635, 0.305];
  var PELVIS_PIVOT = [(HIP_LEFT[0] + HIP_RIGHT[0]) / 2, (HIP_LEFT[1] + HIP_RIGHT[1]) / 2];
  var HIP_SPAN_X = HIP_RIGHT[0] - HIP_LEFT[0], HIP_SPAN_Y = HIP_RIGHT[1] - HIP_LEFT[1];
  var HIP_SPAN = Math.hypot(HIP_SPAN_X, HIP_SPAN_Y), HIP_ANGLE = Math.atan2(HIP_SPAN_Y, HIP_SPAN_X);
  var TAIL_ROOT = [TAIL_MESH.PX / 1024, TAIL_MESH.PY / 1024];
  var HEAD_PIVOT = [0.452, 0.710];
  var tailCanvas = document.createElement("canvas");
  tailCanvas.className = "hq-musica-chip-tailcanvas";
  tailCanvas.width = 512;
  tailCanvas.height = 512;
  tailCanvas.setAttribute("aria-hidden", "true");
  var tailSrc = new Image();
  tailSrc.decoding = "async";
  // Tail physics: a chain of 4 lagged springs (root -> tip). The base drive pushes segment 0, every next segment
  // chases the one before it, so a push travels up the tail as a wave and the tip overshoots a little.
  var TAIL_SEG = 4;
  var TAIL_K = [88, 54, 34, 22];
  var TAIL_C = [8.2, 5.4, 3.6, 2.4];
  var TAIL_G = [1, 0.55, 0.32, 0.18];
  var tailAnim = {
    verts: null, T: 0,
    a: [0, 0, 0, 0], v: [0, 0, 0, 0], p1: 0, p2: 0, nextKick: 0,
    quiver: 0, curl: 0, vcurl: 0, perk: 0, speed: 0, prevBlink: false,
    excite: 0, nextSwish: 0, swishAt: 0, swishSign: 1, nextTwirl: 0, prevBeat: 0,
    hook: 0, vhook: 0, sc: 0, droop: 0, shy: 0, prevHover: false, prevHappy: false, prevNear: false, prevFlush: 0,
    dragX: 0, dragY: 0, dragVX: 0, dragVY: 0, dragDX: 0, dragDY: 0, dragTargetX: 0, dragTargetY: 0,
    oc: null, skin: null, skinSrc: ""
  };
  // Fed by stepBooty each frame: the back's displacement (UV fractions), the twerk drive and the moods, so the
  // tail rides on her back and answers the booty without ever matching its amplitude.
  var tailLink = { rx: 0, ry: 0, rootAngle: 0, dx: 0, dy: 0, twerk: 0, phase: 0, ripple: 0, stretch: 0, blinking: false, beat: 0, music: 0, talk: 0, flush: 0,
    effort: 0, shy: 0, happy: 0, vx: 0, vy: 0, pdx: 0, pnear: 0, accent: 0, holding: false,
    curlPose: 0, heartPulse: 0, watchDir: 0, carryPull: 0,
    tailState: "idle", talkBurst: 0, cupTiltL: 0, cupTiltR: 0, humBeat: 0 };

  function tailResetPhys() {
    var A = tailAnim;
    for (var i = 0; i < TAIL_SEG; i++) { A.a[i] = 0; A.v[i] = 0; }
    A.quiver = 0; A.curl = 0; A.vcurl = 0; A.perk = 0; A.speed = 0; A.nextKick = 0;
    A.prevBlink = false;
    A.excite = 0; A.nextSwish = 0; A.swishAt = 0; A.nextTwirl = 0; A.prevBeat = tailLink.beat;
    A.hook = 0; A.vhook = 0; A.sc = 0; A.droop = 0; A.shy = 0;
    A.prevHover = false; A.prevHappy = false; A.prevNear = false; A.prevFlush = 0;
    A.dragX = A.dragY = A.dragVX = A.dragVY = A.dragDX = A.dragDY = 0;
    A.dragTargetX = A.dragTargetY = 0;
  }

  function tailStep(T, dt) {
    var A = tailAnim, L = tailLink, i;
    A.T = T;
    // Liveliness: she gets more animated when the Master hovers her and while music plays.
    var hovered = chipHover();
    var exT = Math.min(1.4, (hovered ? 0.8 : 0) + L.music * 0.55 + Math.min(1, L.twerk) * 0.3);
    A.excite += (exT - A.excite) * Math.min(1, dt * 2.5);
    var ex = A.excite;
    // Irregular idle: drifting speeds, a slow lazy<->lively envelope and random flicks (never a metronome).
    A.p1 += dt * (1.6 + 0.45 * Math.sin(T * 0.17)) * (1 + 0.55 * ex);
    A.p2 += dt * (3.1 + 0.8 * Math.sin(T * 0.11 + 1.3)) * (1 + 0.4 * ex);
    var env = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(T * 0.23 + 2.0 * Math.sin(T * 0.071)));
    var idle = env * (1 + 0.7 * ex) * (0.018 * Math.sin(A.p1) + 0.008 * Math.sin(A.p2 + 1.2));
    var lively = !L.holding && !gesture.kind && (L.music > 0.25 || hovered);
    if (!lively) {
      A.nextKick = A.nextSwish = A.swishAt = A.nextTwirl = 0;
    } else if (!A.nextKick) {
      A.nextKick = T + 2.5 + Math.random() * 2;
      A.nextSwish = T + 7 + Math.random() * 5;
      A.nextTwirl = T + 5 + Math.random() * 5;
    }
    if (lively && T >= A.nextKick) {
      A.v[0] += (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 1.0) * (1 + 0.5 * ex);
      A.nextKick = T + (1.6 + Math.random() * 3.0) / (1 + 0.6 * ex);
    }
    // Now and then a big lazy swish: sweep one way, then snap back the other (a cat telling you something).
    if (lively && T >= A.nextSwish) {
      A.swishSign = Math.random() < 0.5 ? -1 : 1;
      A.v[0] += A.swishSign * 2.2;
      A.swishAt = T + 0.42;
      A.nextSwish = T + 7 + Math.random() * 9;
    }
    if (A.swishAt && T >= A.swishAt) {
      A.v[0] -= A.swishSign * 2.6;
      A.swishAt = 0;
    }
    // Wag on the beat while music is playing.
    if (L.beat !== A.prevBeat) {
      A.prevBeat = L.beat;
      A.v[0] += (L.beat % 2 ? 1 : -1) * (0.45 + 0.45 * L.music);
    }
    A.v[0] -= L.accent * 1.15;
    // Moods (shared with the rest of her): effort droops and trembles it, shyness tucks it in, joy lifts it.
    A.droop += (L.effort - A.droop) * Math.min(1, dt * 1.5);
    A.shy += (L.shy - A.shy) * Math.min(1, dt * 4);
    var lazy = (1 - Math.min(1, ex)) * 0.008 * Math.sin(T * 0.55) * (1 - Math.min(1, L.twerk));
    var lean = L.pdx * L.pnear * 0.022;
    var drive = (L.holding ? 0 : idle * (1 - 0.45 * A.droop) + lazy + lean) +
      L.twerk * 0.03 * Math.sin(L.phase * 0.5) - L.dx * 1.6 + L.dy * 0.9 -
      0.05 * A.droop - 0.012 * Math.tanh(L.vx / 40) + 0.007 * Math.tanh(L.vy / 60) +
      A.droop * 0.010 * Math.sin(T * 23) * Math.min(1, A.droop * 1.6);
    if (dt > 0) {
      // Follow the dock's travel per second, with enough give to trail through reversals and overshoot on release.
      if (drag && drag.moved) {
        var follow = 1 - Math.exp(-dt * 24);
        A.dragTargetX += (-145 * Math.tanh(A.dragDX / (140 * dt)) - A.dragTargetX) * follow;
        A.dragTargetY += (-80 * Math.tanh(A.dragDY / (130 * dt)) - A.dragTargetY) * follow;
      } else {
        A.dragTargetX = A.dragTargetY = 0;
      }
      // Keep the tip's velocity through direction changes and release.
      A.dragVX += (76 * (A.dragTargetX - A.dragX) - 4.6 * A.dragVX) * dt;
      A.dragVY += (76 * (A.dragTargetY - A.dragY) - 4.6 * A.dragVY) * dt;
      A.dragX += A.dragVX * dt;
      A.dragY += A.dragVY * dt;
      A.dragDX = A.dragDY = 0;
    }
    var slack = (1 - 0.5 * Math.min(1, L.stretch)) * (1 - 0.35 * A.shy);
    var speed = 0;
    for (i = 0; i < TAIL_SEG; i++) {
      var tgt = i === 0 ? drive * slack : A.a[i - 1] * 0.9 + 0.012 * i * A.v[i - 1];
      var acc = -TAIL_K[i] * (A.a[i] - tgt) - TAIL_C[i] * A.v[i];
      A.v[i] += acc * dt;
      A.a[i] += A.v[i] * dt;
      A.a[i] = 0.15 * Math.tanh(A.a[i] / 0.15);   // soft limit: no hard stop at the end of the swing
      if (A.v[i] > 6) A.v[i] = 6; else if (A.v[i] < -6) A.v[i] = -6;
      speed += Math.abs(A.v[i]);
    }
    A.speed += (Math.min(1, speed / 2.2) - A.speed) * 0.25;

    // An impact can add a quiver. Dance accents travel from the root through the spring chain.
    if (L.ripple > A.quiver) A.quiver = Math.min(1, L.ripple);
    A.quiver *= Math.exp(-dt * 4.5);
    if (lively && L.blinking && !A.prevBlink) A.v[1] += (Math.random() < 0.5 ? -1 : 1) * 0.35;
    A.prevBlink = L.blinking;
    if (A.perk > 0) A.perk = Math.max(0, A.perk - dt);

    // Expressive multi-state tail physics: lazy idle curl, perked question-mark on start/skip,
    // wrapped/tucked curl during squeeze, and a sharp upward snap on spank or tail tug.
    var moodDrift = L.holding ? 0 : 0.14 * Math.sin(T * 0.35) + 0.06 * Math.sin(T * 0.13);
    if (lively && T >= A.nextTwirl) {   // a playful curl-uncurl of the tip
      A.vcurl += (Math.random() < 0.5 ? -1 : 1) * 3.2;
      A.nextTwirl = T + 6 + Math.random() * 8;
    }
    var stateCurl = L.tailState === "squeeze" ? 0.78 : (L.tailState === "perk" ? -0.58 : (L.tailState === "snap" ? -0.35 : 0));
    var stateHook = L.tailState === "squeeze" ? 0.55 : (L.tailState === "perk" ? -0.52 : (L.tailState === "snap" ? 0.85 : 0));
    if (L.tailState === "snap" && L.ripple > 0.35) A.v[0] += (L.strikeSide >= 0 ? -1 : 1) * 1.4;
    if (L.humBeat > 0.02) A.v[3] += Math.sin(T * 11) * 0.45 * L.humBeat;
    var curlT = moodDrift + stateCurl + L.twerk * 0.2 + Math.min(1, L.ripple) * 0.8 - L.stretch * 0.55 -
      0.45 * Math.min(1, A.perk / 0.5) - (hovered ? 0.35 : 0) + 0.65 * A.shy - 0.15 * A.droop - 0.25 * L.happy;
    A.vcurl += (-9 * (A.curl - curlT) - 4.2 * A.vcurl) * dt;
    A.curl += A.vcurl * dt;
    // Loose hook at the tip (spank / stretch / shy) and a gentle S through the body of the tail.
    var hookT = 0.55 * Math.min(1, L.ripple) + 0.45 * A.shy + 0.30 * L.stretch + stateHook;
    A.vhook += (-30 * (A.hook - hookT) - 5.5 * A.vhook) * dt;
    A.hook += A.vhook * dt;
    A.sc += ((0.7 * L.stretch + 0.3 * Math.min(1, L.ripple)) - A.sc) * Math.min(1, dt * 4);
    // Flicks: tip flick when she is hovered or turns happy, a curious twitch toward the cursor, one on a blush.
    if (hovered && !A.prevHover && !L.holding) A.vhook -= 3.2;
    A.prevHover = hovered;
    if (L.happy > 0.5 && !A.prevHappy) { A.vhook -= 3.6; A.v[3] += 0.6; }
    A.prevHappy = L.happy > 0.5;
    var near = !L.holding && L.pnear > 0.55;
    if (near && !A.prevNear) A.v[1] += (L.pdx >= 0 ? 1 : -1) * 0.9;
    A.prevNear = near;
    if (A.prevFlush < 0.5 && L.flush >= 0.5) { A.v[2] += 0.6; A.vhook += 2.0; }
    A.prevFlush = L.flush;
    earStep(T, dt, hovered);
    L.accent = 0;
  }

  // Cat ears: two rigid sprites cut out of the art (the base art no longer contains them). Each twitches on its own
  // spring around the middle of its base, follows the head, and its red core can glow (beat, talking, spank, hover).
  var EARS = [
    { side: -1, box: [262, 512, 398, 665], piv: [339, 615], disc: [330.4, 582.7, 15], src: new Image(), img: null, oc: null },
    { side: 1, box: [505, 509, 638, 664], piv: [557, 614], disc: [581.7, 581.3, 16.4], src: new Image(), img: null, oc: null }
  ];
  var EAR_ART = ["/assets/companion/musica-ear-left@2x.webp?v=1", "/assets/companion/musica-ear-right@2x.webp?v=1"];
  var earAnim = { th: [0, 0], v: [0, 0], next: 0, flat: 0, flash: 0, glow: 0, prevRipple: 0, prevBeat: 0 };
  EARS.forEach(function (ear) {
    ear.src.decoding = "async";
    var im = document.createElement("img");
    im.className = "hq-musica-chip-ear";
    im.alt = "";
    im.decoding = "async";
    im.draggable = false;
    im.style.left = (ear.box[0] / 10.24) + "%";
    im.style.top = (ear.box[1] / 10.24) + "%";
    im.style.width = ((ear.box[2] - ear.box[0]) / 10.24) + "%";
    im.style.height = ((ear.box[3] - ear.box[1]) / 10.24) + "%";
    ear.img = im;
  });

  function earReset() {
    var E = earAnim;
    E.th[0] = E.th[1] = 0; E.v[0] = E.v[1] = 0; E.next = 0;
    E.flat = 0; E.flash = 0; E.glow = 0; E.prevRipple = 0; E.prevBeat = tailLink.beat;
  }

  function earStep(T, dt, hovered) {
    var E = earAnim, L = tailLink, i;
    if (L.ripple - E.prevRipple > 0.3) {   // spank: ears flatten back, flash, asymmetric kick on struck side
      E.flat = 1; E.flash = 1;
      var sDir = L.strikeSide || 0;
      EARS.forEach(function (ear, k) {
        E.v[k] += ear.side * (ear.side === sDir ? 1.65 : 0.95);
      });
    }
    E.prevRipple = L.ripple;
    if (L.beat !== E.prevBeat) {   // wag: a tiny inward bob on every beat
      E.prevBeat = L.beat;
      EARS.forEach(function (ear, k) { E.v[k] -= ear.side * 0.16 * L.music; });
    }
    E.v[0] -= L.accent * 0.36;
    E.v[1] -= L.accent * 0.49;
    if (!E.next) E.next = T + 5 + Math.random() * 5;
    if (!L.holding && !gesture.kind && T >= E.next) {
      i = Math.random() < 0.5 ? 0 : 1;
      E.v[i] += EARS[i].side * (0.8 + Math.random() * 0.5);
      E.next = T + (7 + Math.random() * 7) / (1 + (hovered ? 0.6 : 0) + tailAnim.excite * 0.3);
    }
    E.flat = Math.max(0, E.flat - dt / 0.8);
    E.flash *= Math.exp(-dt * 3);
    var perk = Math.min(1, tailAnim.perk / 0.6);
    var flatAmt = E.flat * 0.16 + L.stretch * 0.08 + (L.pout || 0) * 0.14;
    var sway = -L.dx * 1.0 + (L.watchDir || 0) * 0.08;
    var petLean = (L.pet || 0) * 0.07;
    var age = T - gesture.at;
    for (i = 0; i < 2; i++) {
      var side = EARS[i].side;
      var watchPerk = L.watchDir ? Math.abs(L.watchDir) * 0.08 : 0;
      var cupTilt = i === 0 ? (L.cupTiltL || 0) : (L.cupTiltR || 0);
      var talkFlick = (L.talkBurst || 0) * 0.09 * side;
      var target = side * flatAmt - side * (0.05 * perk + (hovered ? 0.04 : 0) + petLean + watchPerk) + sway + side * cupTilt * 0.24 + talkFlick;
      var delay = side === gesture.side ? 0 : 0.11;
      if (gesture.kind === "listen") {
        target += gesture.side * (delay === 0 ? 0.23 : 0.10) *
          motionHold(age - delay, 0, 0.13, 0.93, 1.52);
      } else if (gesture.kind === "surprise") {
        target += side * 0.27 * motionHold(age - delay, 0, 0.08, 0.15, 0.76);
      }
      E.v[i] += (-95 * (E.th[i] - target) - 7.5 * E.v[i]) * dt;
      E.th[i] += E.v[i] * dt;
      if (E.th[i] > 0.3) E.th[i] = 0.3; else if (E.th[i] < -0.3) E.th[i] = -0.3;
    }
    var g = hovered ? 0.2 : 0;
    g = Math.max(g, L.music * (0.3 + 0.45 * (0.5 + 0.5 * Math.sin(L.phase))) * Math.min(1, L.twerk * 2));
    g = Math.max(g, L.talk * 0.7, E.flash, (L.arousal || 0) * 0.62, (L.pet || 0) * 0.35, (L.heartPulse || 0) * 0.32);
    if (gesture.kind === "listen") g = Math.max(g, 0.32 * motionHold(age, 0, 0.18, 0.95, 1.6));
    E.glow += (g - E.glow) * Math.min(1, dt * 10);
  }

  function earDraw(ctx, s) {
    var E = earAnim;
    for (var i = 0; i < 2; i++) {
      var ear = EARS[i];
      if (!ear.src.naturalWidth) continue;
      var bx = ear.box[0], by = ear.box[1];
      var ow = Math.max(1, Math.round((ear.box[2] - bx) * s)), oh = Math.max(1, Math.round((ear.box[3] - by) * s));
      var oc = ear.oc || (ear.oc = document.createElement("canvas"));
      if (oc.width !== ow || oc.height !== oh) { oc.width = ow; oc.height = oh; }
      var o = oc.getContext("2d");
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = "source-over";
      o.clearRect(0, 0, ow, oh);
      o.drawImage(ear.src, 0, 0, ow, oh);
      if (E.glow > 0.02) {
        var cx = (ear.disc[0] - bx) * s, cy = (ear.disc[1] - by) * s, r = ear.disc[2] * s;
        var g = o.createRadialGradient(cx, cy, 0, cx, cy, r * 2.6);
        g.addColorStop(0, "rgba(255,150,120," + (0.85 * E.glow).toFixed(3) + ")");
        g.addColorStop(0.35, "rgba(255,60,50," + (0.55 * E.glow).toFixed(3) + ")");
        g.addColorStop(1, "rgba(255,30,30,0)");
        o.globalCompositeOperation = "source-atop";
        o.fillStyle = g;
        o.fillRect(0, 0, ow, oh);
        o.globalCompositeOperation = "source-over";
      }
      if (tailLink.flush > 0.03) {
        o.globalCompositeOperation = "source-atop";
        o.fillStyle = "rgba(255,90,120," + (0.22 * tailLink.flush).toFixed(3) + ")";
        o.fillRect(0, 0, ow, oh);
        o.globalCompositeOperation = "source-over";
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var anchor = earAnchors[i];
      ctx.translate((ear.piv[0] + anchor.x * 1024) * s, (ear.piv[1] + anchor.y * 1024) * s);
      ctx.rotate(anchor.angle + E.th[i]);
      ctx.drawImage(oc, (bx - ear.piv[0]) * s, (by - ear.piv[1]) * s);
      ctx.restore();
    }
  }

  // Centre line of the tail (rest pose, px relative to the pivot) with its local width, from the mesh itself:
  // used to follow the bend with shading and a soft contact shadow.
  var TAIL_SPINE = null;
  function tailSpine() {
    if (TAIL_SPINE) return TAIL_SPINE;
    var M = TAIL_MESH, NB = 10, sx = [], sy = [], cn = [], b, r, c;
    for (b = 0; b < NB; b++) { sx[b] = 0; sy[b] = 0; cn[b] = 0; }
    for (r = 0; r < M.ROWS; r++) {
      for (c = 0; c < M.COLS; c++) {
        if (M.flags.charCodeAt(r * M.COLS + c) !== 49) continue;
        var k = r * (M.COLS + 1) + c;
        var vt = (M.tv[k] + M.tv[k + 1] + M.tv[k + M.COLS + 1] + M.tv[k + M.COLS + 2]) / 4 / 99;
        b = Math.max(0, Math.min(NB - 1, Math.floor(vt * NB)));
        sx[b] += M.X0 + (c + 0.5) * M.C - M.PX; sy[b] += M.Y0 + (r + 0.5) * M.C - M.PY; cn[b] += 1;
      }
    }
    var pts = [];
    for (b = 0; b < NB; b++) if (cn[b] > 0) pts.push({ x: sx[b] / cn[b], y: sy[b] / cn[b], t: (b + 0.5) / NB, n: cn[b] });
    for (b = 0; b < pts.length; b++) {
      var p0 = pts[Math.max(0, b - 1)], p1 = pts[Math.min(pts.length - 1, b + 1)];
      var tx = p1.x - p0.x, ty = p1.y - p0.y, len = Math.hypot(tx, ty) || 1;
      pts[b].nx = -ty / len; pts[b].ny = tx / len;
      var interior = b > 0 && b < pts.length - 1;
      pts[b].w = Math.max(14, Math.min(70, pts[b].n * M.C * M.C / Math.max(10, len / (interior ? 2 : 1))));
    }
    TAIL_SPINE = pts;
    return pts;
  }

  // Low-res skin mask of the base art (is there skin under this spot?), built once per art source.
  function tailSkinReady() {
    var A = tailAnim, src = art.currentSrc || art.src;
    if (!art.complete || !art.naturalWidth || !src) return false;
    if (A.skin && A.skinSrc === src) return true;
    try {
      var cv = document.createElement("canvas");
      cv.width = 128; cv.height = 128;
      var x = cv.getContext("2d", { willReadFrequently: true });
      x.drawImage(art, 0, 0, 128, 128);
      var d = x.getImageData(0, 0, 128, 128).data, m = new Uint8Array(128 * 128);
      for (var i = 0; i < 128 * 128; i++) {
        var R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
        m[i] = (R > 150 && G > 90 && B > 66 && R - G < 105 && R - G > 5) ? 1 : 0;
      }
      A.skin = m; A.skinSrc = src;
      return true;
    } catch (e) {
      A.skin = null; A.skinSrc = src;
      return false;
    }
  }
  function tailOnSkin(x1024, y1024) {
    var m = tailAnim.skin;
    if (!m) return 0;
    var i = Math.max(0, Math.min(127, Math.round(x1024 / 8))), j = Math.max(0, Math.min(127, Math.round(y1024 / 8)));
    return m[j * 128 + i];
  }

  function tailBend(t) {
    var A = tailAnim, th = tailLink.rootAngle * (1 - 0.72 * t), u = t * TAIL_SEG;
    for (var i = 0; i < TAIL_SEG; i++) {
      var w = u - i;
      w = w < 0 ? 0 : (w > 1 ? 1 : w);
      th += TAIL_G[i] * A.a[i] * (w * w * (3 - 2 * w));
    }
    th += A.curl * 0.30 * Math.pow(t, 1.5);
    th += A.hook * 0.55 * t * t * t;
    th += tailLink.curlPose * 0.47 * t * t * t;
    th += A.sc * 0.16 * Math.sin(t * 4.7);
    th += A.quiver * 0.035 * Math.sin(A.T * 38 - t * 7) * t * t;
    return th;
  }

  function tailDragWeight(t) {
    // Keep the root and its tangent attached while the outer tail trails behind.
    return t * t * (3 - 2 * t);
  }

  function tailTri(ctx, p, q, ks) {
    var ax = p[2] - p[0], ay = p[3] - p[1], bx = p[4] - p[0], by = p[5] - p[1];
    var ex = q[2] - q[0], ey = q[3] - q[1], fx = q[4] - q[0], fy = q[5] - q[1];
    var det = ax * by - ay * bx;
    if (!det) return;
    var m00 = (ex * by - fx * ay) / det, m01 = (-ex * bx + fx * ax) / det;
    var m10 = (ey * by - fy * ay) / det, m11 = (-ey * bx + fy * ax) / det;
    var cx = (q[0] + q[2] + q[4]) / 3, cy = (q[1] + q[3] + q[5]) / 3;
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i < 3; i++) {
      var vx = q[i * 2] - cx, vy = q[i * 2 + 1] - cy;
      var len = Math.sqrt(vx * vx + vy * vy) || 1;
      var X = q[i * 2] + vx / len * 0.7, Y = q[i * 2 + 1] + vy / len * 0.7;
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(m00, m10, m01, m11, q[0] - m00 * p[0] - m01 * p[1], q[1] - m10 * p[0] - m11 * p[1]);
    ctx.drawImage(tailSrc, 0, 0);
    ctx.restore();
  }

  function tailShadowLift(t) {
    // The root stays attached. The curl lifts the outer tail away from the portrait.
    return Math.min(1, t * t * (0.17 + 2.4 * tailLink.curlPose + 0.30 * Math.max(0, tailAnim.hook)));
  }

  function drawTailShadow(ctx, x, y, width, length, opacity, lift, scale) {
    var rx = (width + 14 * lift) * scale;
    var ry = (length + 22 * lift) * scale;
    ctx.save();
    ctx.translate(x + (23 + 15 * lift) * scale, y + (13 + 21 * lift) * scale);
    ctx.scale(rx, ry);
    var alpha = opacity * (1 - 0.82 * lift);
    var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, "rgba(10,52,49," + alpha.toFixed(3) + ")");
    grad.addColorStop(0.50, "rgba(10,52,49," + (alpha * 0.59).toFixed(3) + ")");
    grad.addColorStop(1, "rgba(10,52,49,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  function tailDraw(T, dt) {
    var nw = tailSrc.naturalWidth;
    tailStep(T, dt);
    if (!nw) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = Math.max(256, Math.min(1024, Math.round((portrait.clientWidth || 256) * dpr)));
    if (tailCanvas.width !== size) { tailCanvas.width = size; tailCanvas.height = size; }
    var ctx = tailCanvas.getContext("2d");
    if (!ctx) return false;
    var M = TAIL_MESH, s = size / 1024, ks = nw / 1024, n = (M.COLS + 1) * (M.ROWS + 1);
    var vx = tailAnim.verts || (tailAnim.verts = new Float32Array(n * 2));
    var offX = tailLink.rx * 1024 * s, offY = tailLink.ry * 1024 * s;
    var dragX = tailAnim.dragX * s, dragY = tailAnim.dragY * s;
    var rootCos = Math.cos(tailLink.rootAngle), rootSin = Math.sin(tailLink.rootAngle);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    var tOC = tailAnim.oc || (tailAnim.oc = document.createElement("canvas"));
    if (tOC.width !== size) { tOC.width = size; tOC.height = size; }
    var octx = tOC.getContext("2d");
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = "source-over";
    octx.clearRect(0, 0, size, size);
    var spine = tailSpine();
    tailSkinReady();
    // Keep the shadow under the root and the short section close to the back.
    for (var j = 0; j < M.sh.length; j++) {
      var q = M.sh[j], qt = q[2] / 99, qth = tailBend(qt);
      var qx = q[0] - M.PX, qy = q[1] - M.PY;
      var dragWeight = tailDragWeight(qt);
      var gx = (M.PX + qx * Math.cos(qth) - qy * Math.sin(qth)) * s + offX + dragX * dragWeight;
      var gy = (M.PY + qx * Math.sin(qth) + qy * Math.cos(qth)) * s + offY + dragY * dragWeight;
      drawTailShadow(ctx, gx, gy, q[3], q[4], q[5], tailShadowLift(qt), s);
    }
    var A = tailAnim;
    for (var r = 0; r <= M.ROWS; r++) {
      for (var c = 0; c <= M.COLS; c++) {
        var k = r * (M.COLS + 1) + c;
        var vt = M.tv[k] / 99;
        var x = M.X0 + c * M.C - M.PX, y = M.Y0 + r * M.C - M.PY;
        // Squash & stretch: the tail lengthens a touch at speed; the fur edge flutters, lagging the swing.
        var lf = 1 + (0.045 * A.speed + 0.02 * A.quiver) * vt;
        var fl = A.speed * 2.2 * vt * vt * Math.sin(T * 9 + k * 0.9);
        x = x * lf + fl;
        y = y * lf + fl * 0.6;
        var th = tailBend(vt), cs = Math.cos(th), sn = Math.sin(th);
        dragWeight = tailDragWeight(vt);
        vx[k * 2] = (M.PX + x * cs - y * sn) * s + offX + dragX * dragWeight;
        vx[k * 2 + 1] = (M.PY + x * sn + y * cs) * s + offY + dragY * dragWeight;
      }
    }
    for (r = 0; r < M.ROWS; r++) {
      for (c = 0; c < M.COLS; c++) {
        if (M.flags.charCodeAt(r * M.COLS + c) !== 49) continue;
        var i00 = r * (M.COLS + 1) + c, i10 = i00 + 1, i01 = i00 + M.COLS + 1, i11 = i01 + 1;
        var u0 = (M.X0 + c * M.C) * ks, v0 = (M.Y0 + r * M.C) * ks, u1 = u0 + M.C * ks, v1 = v0 + M.C * ks;
        // Source (image px) -> destination (canvas px); the image is drawn whole inside the clipped triangle.
        tailTri(octx, [u0, v0, u1, v0, u0, v1],
          [vx[i00 * 2], vx[i00 * 2 + 1], vx[i10 * 2], vx[i10 * 2 + 1], vx[i01 * 2], vx[i01 * 2 + 1]], ks);
        tailTri(octx, [u1, v0, u1, v1, u0, v1],
          [vx[i10 * 2], vx[i10 * 2 + 1], vx[i11 * 2], vx[i11 * 2 + 1], vx[i01 * 2], vx[i01 * 2 + 1]], ks);
      }
    }
    // Shading that follows the bend (outer side catches light, inner fold darkens), a glow that follows the beat,
    // and a slight darkening where the tail lies over her skin. source-atop keeps it inside the tail pixels.
    octx.globalCompositeOperation = "source-atop";
    var glowT = earAnim.glow;
    for (j = 0; j < spine.length; j++) {
      var q2 = spine[j], th2 = tailBend(q2.t), cs2 = Math.cos(th2), sn2 = Math.sin(th2);
      var kap = (tailBend(Math.min(1, q2.t + 0.05)) - tailBend(Math.max(0, q2.t - 0.05))) / 0.1;
      dragWeight = tailDragWeight(q2.t);
      var px = (M.PX + q2.x * cs2 - q2.y * sn2) * s + offX + dragX * dragWeight;
      var py = (M.PY + q2.x * sn2 + q2.y * cs2) * s + offY + dragY * dragWeight;
      var nx = q2.nx * cs2 - q2.ny * sn2, ny = q2.nx * sn2 + q2.ny * cs2;
      var rad = q2.w * 0.62 * s, sg = kap >= 0 ? 1 : -1, am = Math.min(0.17, Math.abs(kap) * 0.10) * (1 - 0.6 * Math.max(0, (q2.t - 0.7) / 0.3));
      if (am > 0.01) {
        var hx0 = px - sg * nx * q2.w * 0.30 * s, hy0 = py - sg * ny * q2.w * 0.30 * s;
        var hg = octx.createRadialGradient(hx0, hy0, 0, hx0, hy0, rad);
        hg.addColorStop(0, "rgba(255,255,255," + am.toFixed(3) + ")");
        hg.addColorStop(1, "rgba(255,255,255,0)");
        octx.fillStyle = hg;
        octx.fillRect(hx0 - rad, hy0 - rad, rad * 2, rad * 2);
        var dx0 = px + sg * nx * q2.w * 0.30 * s, dy0 = py + sg * ny * q2.w * 0.30 * s;
        var dg = octx.createRadialGradient(dx0, dy0, 0, dx0, dy0, rad);
        dg.addColorStop(0, "rgba(0,12,16," + (am * 1.1).toFixed(3) + ")");
        dg.addColorStop(1, "rgba(0,12,16,0)");
        octx.fillStyle = dg;
        octx.fillRect(dx0 - rad, dy0 - rad, rad * 2, rad * 2);
      }
      if (glowT > 0.03) {
        var gg = octx.createRadialGradient(px, py, 0, px, py, rad * 1.3);
        gg.addColorStop(0, "rgba(255,110,190," + (0.30 * glowT * (1 - q2.t * 0.4)).toFixed(3) + ")");
        gg.addColorStop(1, "rgba(255,110,190,0)");
        octx.fillStyle = gg;
        octx.fillRect(px - rad * 1.3, py - rad * 1.3, rad * 2.6, rad * 2.6);
      }
      var localX = (px - offX - dragX * dragWeight) / s - M.PX;
      var localY = (py - offY - dragY * dragWeight) / s - M.PY;
      if (tailOnSkin(M.PX + localX * rootCos + localY * rootSin, M.PY - localX * rootSin + localY * rootCos)) {
        var contact = 0.13 * (1 - tailShadowLift(q2.t));
        var kg = octx.createRadialGradient(px, py, 0, px, py, rad);
        kg.addColorStop(0, "rgba(0,12,16," + contact.toFixed(3) + ")");
        kg.addColorStop(1, "rgba(0,12,16,0)");
        octx.fillStyle = kg;
        octx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      }
    }
    octx.globalCompositeOperation = "source-over";
    ctx.drawImage(tOC, 0, 0);
    earDraw(ctx, s);
    return true;
  }

  function paintTail(T, dt) {
    if (tailDraw(T, dt)) {
      if (tailCanvas.style.display !== "block") tailCanvas.style.display = "block";
      if (tailTipArt.style.visibility !== "hidden") tailTipArt.style.visibility = "hidden";
      for (var i = 0; i < EARS.length; i++) {
        var ear = EARS[i];
        if (ear.src.naturalWidth && ear.img.style.visibility !== "hidden") ear.img.style.visibility = "hidden";
      }
    }
  }

  function stopTailAnim() {
    tailResetPhys();
    tailCanvas.style.display = "none";
    tailTipArt.style.visibility = "";
    EARS[0].img.style.visibility = "";
    EARS[1].img.style.visibility = "";
    earReset();
  }

  var portrait = document.createElement("div");
  portrait.className = "hq-musica-chip-portrait";
  portrait.setAttribute("aria-hidden", "true");
  // The stage carries the picture layers so the whole portrait can drift/zoom slowly (a living "camera").
  var stage = document.createElement("div");
  stage.className = "hq-musica-chip-stage";
  stage.append(art, warpCanvas, tailTipArt, EARS[0].img, EARS[1].img, tailCanvas);
  portrait.append(stage);

  button.append(wave, icon, portrait);
  var danceWrap = document.createElement("div");
  danceWrap.className = "hq-musica-chip-dance";
  danceWrap.appendChild(button);
  dock.appendChild(danceWrap);
  var tapButton = document.createElement("button");
  tapButton.type = "button";
  tapButton.className = "hq-musica-beat-tap";
  tapButton.textContent = "\u266a tempo";
  tapButton.title = "Tape le tempo (4 coups ou plus) pour caler sa danse";
  tapButton.setAttribute("aria-label", "Taper le tempo de la musique");
  tapButton.addEventListener("pointerdown", function (event) {
    if (event.button && event.button !== 0) return;
    event.stopPropagation();
    beatTapNow();   // on press, not release: release timing wobbles
  });
  tapButton.addEventListener("click", function (event) {
    event.stopPropagation();
    if (event.detail === 0) beatTapNow();   // keyboard activation
  });
  dock.appendChild(tapButton);
  document.body.appendChild(dock);

  function clampNum(value, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(min, Math.min(max, number));
  }

  function readPosition() {
    try {
      var parsed = JSON.parse(localStorage.getItem(LS_POS) || "{}");
      return {
        x: clampNum(parsed && parsed.x, -20000, 20000),
        y: clampNum(parsed && parsed.y, -20000, 20000)
      };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function persistPosition() {
    try {
      localStorage.setItem(LS_POS, JSON.stringify({
        x: Math.round(pos.x),
        y: Math.round(pos.y)
      }));
    } catch (_) {}
  }

  var pos = readPosition();
  var drag = null;
  var pinching = false;
  var suppressClick = false;
  var available = false;
  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (_) {}
  var playback = {
    playing: false,
    trackId: "",
    album: "",
    intensity: 0.78,
    volume: 1.0,
    progressMs: 0,
    durationMs: 0,
    progressAt: 0
  };
  var pollTimer = 0;
  var pollBusy = false;
  var pollFailures = 0;
  var lastPlaybackEventAt = 0;
  var beatCount = 0;
  var nextDanceBeat = 16;
  var danceStopTimer = 0;
  var entranceTimer = 0;
  var exitTimer = 0;

  // ---- Beat: one clock (hq-musica-beat.js) drives the twerk, the halo bars, the full-chip dance and the orbit.
  // Its tempo comes from his taps, a stored grid, or what she hears from local audio; a hash guess is the last resort.
  // The chip must still show, drag and resize without hq-musica-beat.js: same shapes, no beat.
  // Every call below keeps its return shape so the frame, the drag and the scale work, while the
  // beat-driven layers (halo bars, twerk, full-chip dance, orbit) read zero crossed beats and stay off.
  function beatlessEngine() {
    function idleClock() {
      return { beats: 0, beatSec: 0.55, targetSec: 0.55, offset: null, locked: false, source: "off", snapped: false, bpm: 60 / 0.55 };
    }
    function idleTracker(opts) {
      return { rate: (opts && opts.sampleRate) || 44100, fftSize: (opts && opts.fftSize) || 1024,
        bassMean: 0.45, meanN: 0, level: 0, onset: 0, flux: 0, drop: false,
        bpm: 0, offset: 0, confidence: 0, period: 0, energyStep: 0.5, drops: [], stableSince: -1 };
    }
    var noBeat = function () { return false; };
    return {
      foldBeat: function (sec) {
        if (!(sec > 0) || !isFinite(sec)) return 0.5;
        while (sec > 0.82) sec /= 2;
        while (sec < 0.32) sec *= 2;
        return sec;
      },
      createClock: idleClock,
      createTap: function () { return { times: [], songs: [] }; },
      setGuess: noBeat,
      setTempo: noBeat,
      stepClock: function () { return 0; },
      nextBar: function (beats, minBeats) { return (beats || 0) + (minBeats || 4) * 1e6; },
      toBar: function (beats) { return beats; },
      phaseError: function () { return 0; },
      tap: function () { return { bpm: 0, offset: 0 }; },
      createTracker: idleTracker,
      resetTracker: function () {},
      pushSpectrum: function () { return { onset: 0, flux: 0, bass: 0, level: 0, drop: false }; },
      estimate: function () { return { bpm: 0, offset: 0, confidence: 0, period: 0 }; },
      track: function () { return { bpm: 0, offset: 0, confidence: 0, period: 0, onset: 0, level: 0, drop: false, drops: [], energyStep: 0.5 }; },
      energyCurve: function () { return []; },
      curveRel: function () { return 1; },
      liveIntensity: function () { return 0.78; }
    };
  }

  // One identity for the beat grid and for what she says: hq-now-playing.js must load before this script.
  var SongUnit = window.HqNowPlaying;
  var songUnitMissing = !SongUnit;
  if (songUnitMissing) {
    console.error("hq-musica-chip: window.HqNowPlaying is missing — /assets/hq-now-playing.js must load before this script. She keeps quiet about the song.");
  } else {
    SongUnit.loadOverride();
  }

  var beatMissing = false;
  var Beat = window.HqMusicaBeat;
  if (!Beat) {
    console.error("hq-musica-chip: window.HqMusicaBeat is missing — /assets/hq-musica-beat.js must load before this script. The chip's dance layers stay off.");
    Beat = beatlessEngine();
    beatMissing = true;
  }
  var beatClock = Beat.createClock(0.55);
  var beatTap = Beat.createTap();
  var beatGrid = null;          // stored grid for this track: {bpm, offset, source, energy, energy_step, drops}
  var beatKey = "";
  var beatCssSec = 0;
  var boundAudio = {};          // view -> the <audio> the chip can hear (Lecteur, Studio)
  var hear = { ctx: null, el: null, an: null, buf: null, tracker: null,
    sources: typeof WeakMap === "function" ? new WeakMap() : null,
    intensity: 0.78, rel: 1, onset: 0, drop: false, savedAt: 0 };
  var BOUNCE_LEAD = 2.2;        // radians: the spring lags its push, so the push leads the beat to land the dip on it

  function localAudio() {
    var el = boundAudio[document.body.dataset.view];
    return el && el.isConnected && !el.hidden && !el.paused && !el.ended && el.currentSrc ? el : null;
  }

  function musicPlaying() {
    return !!((onMusiquePage() && playback.playing) || localAudio());
  }

  function songTime(el) {
    if (el) return el.currentTime;
    if (!playback.playing || !playback.progressAt) return NaN;
    return (playback.progressMs + (Date.now() - playback.progressAt)) / 1000;
  }

  function hashHex(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  // The key lives in hq-now-playing.js: the beat grid and the spoken identity must be the same value, and it
  // must exist before the dance loop's first frame.
  // A blind match hides the song everywhere; the shared module owns that flag (hq-music.js sets it).
  function concealedNow() {
    if (SongUnit) return SongUnit.isConcealed();
    return !!window.__hqBlindMatch;
  }

  // A blind duel hides the song on every view: poll the station flag so the chip stays quiet even when the Musique page
  // was never opened. Throttled; the module keeps the local (quiz) and server reasons separate.
  var concealAt = 0;
  function refreshConceal(force) {
    if (!SongUnit || typeof window.api !== "function") return;
    var now = Date.now();
    if (!force && now - concealAt < 15000) return;
    concealAt = now;
    window.api("/api/musica/conceal", { timeoutMs: 5000 }).then(function (data) {
      if (SongUnit) SongUnit.concealFromServer(data && data.concealed);
    }).catch(function () {});
  }

  // The owner's title is stored server-side (.hq-music/musica_song_titles.json): fetch it once per song so every device
  // shows the same title, and the prompt written on the server uses it too.
  var serverTitleFor = "";
  function syncServerTitle(key) {
    if (!key || key === serverTitleFor || !SongUnit || typeof window.api !== "function") return;
    serverTitleFor = key;
    window.api("/api/musica/song-titles/" + encodeURIComponent(key), { timeoutMs: 6000 }).then(function (data) {
      if (!SongUnit) return;
      SongUnit.setServerOverride(key, data && data.item);
      if (serverTitleFor === key && data && data.item && data.item.title) currentSong();
    }).catch(function () { serverTitleFor = ""; });
  }

  function postSongTitle(key, title, artist) {
    var headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var tok = window.hqCsrfToken();
      if (tok) headers["X-CSRF-Token"] = tok;
    }
    return fetch("/api/musica/song-titles", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: headers,
      body: JSON.stringify({ key: key, title: title, artist: artist })
    }).then(function (res) {
      if (!res.ok) throw new Error("title save failed");
      return res.json();
    }).then(function (data) {
      if (SongUnit) SongUnit.setServerOverride(key, data && data.item);
      return data;
    });
  }

  function musicKey(el) {
    if (!SongUnit) return "";
    return el ? SongUnit.localKey(el.currentSrc) : SongUnit.spotifyKey(playback.trackId);
  }

  function guessBeatSec() {
    var speed = playback.trackId ? parseFloat(trackSpeed(playback.trackId)) : 1.25;
    var intensity = Number.isFinite(playback.intensity) ? playback.intensity : 0.78;
    var tempoScale = intensity >= 0.95 ? 0.72 : (intensity < 0.60 ? 1.25 : 1.0);
    return Math.max(0.32, Math.min(0.82, speed * 0.5 * tempoScale));
  }

  function postBeat(body) {
    var headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var tok = window.hqCsrfToken();
      if (tok) headers["X-CSRF-Token"] = tok;
    }
    fetch("/api/musica/beats", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: headers, body: JSON.stringify(body)
    }).catch(function () {});
  }

  function fetchBeatGrid(key) {
    if (typeof window.api !== "function") return;
    window.api("/api/musica/beats/" + encodeURIComponent(key), { timeoutMs: 6000 }).then(function (data) {
      if (key !== beatKey || !data || !data.grid) return;
      beatGrid = data.grid;
      if (beatClock.source === "tap") return;   // he tapped while it loaded
      if (Beat.setTempo(beatClock, Number(beatGrid.bpm), Number(beatGrid.offset), beatGrid.source === "tap" ? "tap" : "grid")) {
        updateBeatCss(true);
      }
    }).catch(function () {});
  }

  // Keep what she heard (tempo, loudness curve, drops) so the next play of this file starts on the beat.
  function beatSaveLive(force) {
    var tr = hear.tracker;
    if (!tr || beatKey.indexOf("l-") !== 0 || !tr.bpm || tr.stableSince < 0 || !(tr.offset >= 0)) return;
    var now = Date.now();
    if (!force && now - hear.savedAt < 30000) return;
    hear.savedAt = now;
    postBeat({
      key: beatKey, source: "live",
      bpm: Math.round(tr.bpm * 100) / 100,
      offset: Math.round(Math.min(3600, tr.offset) * 1000) / 1000,
      confidence: Math.round(Math.min(1, Math.max(0, tr.confidence)) * 1000) / 1000,
      energy: Beat.energyCurve(tr), energy_step: tr.energyStep, drops: tr.drops.slice(0, 24)
    });
  }

  function syncBeatKey(el) {
    var key = musicKey(el);
    if (key === beatKey) return;
    beatSaveLive(true);
    beatKey = key;
    beatGrid = null;
    beatTap = Beat.createTap();
    if (hear.tracker) Beat.resetTracker(hear.tracker);
    hear.intensity = 0.78; hear.rel = 1; hear.onset = 0; hear.drop = false; hear.savedAt = 0;
    bootyPhys.progWinDone = 0;
    bootyPhys.lastGridDrop = -1;
    beatCount = 0;
    nextDanceBeat = 16;
    Beat.setGuess(beatClock, el ? 0.5 : guessBeatSec());
    updateBeatCss(true);
    if (key) fetchBeatGrid(key);
  }

  // The halo bars and the full-chip dance run on CSS: give them the clock's tempo and start them on its beat.
  function updateBeatCss(force) {
    var sec = beatClock.beatSec;
    if (!force && Math.abs(sec - beatCssSec) / sec < 0.02) return;
    beatCssSec = sec;
    wave.style.setProperty("--wave-speed", (sec * 2).toFixed(3) + "s");
    danceWrap.style.setProperty("--dance-duration", (sec * 4).toFixed(3) + "s");
    var into = ((beatClock.beats % 2) + 2) % 2;
    wave.style.setProperty("--wave-sync", (-(into * sec)).toFixed(3) + "s");
    dock.classList.toggle("is-beat-guess", beatClock.source === "guess");
  }

  // Live hearing: only for same-origin local audio on a desktop. On iPhone, routing the player through Web Audio
  // would silence it when the screen locks, so there she uses taps and stored grids.
  function canHear() {
    try {
      if (!window.matchMedia || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return false;
    } catch (_) { return false; }
    return !!hear.sources && !/iP(hone|ad|od)/.test(navigator.userAgent || "") &&
      !!(window.AudioContext || window.webkitAudioContext);
  }

  function hearAttach(el) {
    if (!canHear() || (hear.el === el && hear.an)) return;
    try {
      if (new URL(el.currentSrc || el.src, window.location.href).origin !== window.location.origin) return;
    } catch (_) { return; }
    try {
      if (!hear.ctx) hear.ctx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = hear.ctx;
      var connect = function () {
        // Never route the element through a context that is not running: it would play silence.
        if (ctx.state !== "running" || el.paused) return;
        var src = hear.sources.get(el);
        if (!src) {
          src = ctx.createMediaElementSource(el);
          src.connect(ctx.destination);
          hear.sources.set(el, src);
        }
        if (!hear.an) {
          hear.an = ctx.createAnalyser();
          hear.an.fftSize = 1024;
          hear.an.smoothingTimeConstant = 0;
          hear.buf = new Uint8Array(hear.an.frequencyBinCount);
        }
        if (hear.el && hear.el !== el) {
          var old = hear.sources.get(hear.el);
          try { if (old) old.disconnect(hear.an); } catch (_) {}
        }
        src.connect(hear.an);
        hear.el = el;
        hear.tracker = Beat.createTracker({ sampleRate: ctx.sampleRate, fftSize: hear.an.fftSize });
      };
      if (ctx.state === "running") connect();
      else ctx.resume().then(connect).catch(function () {});
    } catch (_) { /* playback stays as it was; she falls back to taps and grids */ }
  }

  // One frame of listening. Returns true when she really hears this element.
  function hearStep(el, t) {
    hear.onset = 0;
    hear.drop = false;
    if (!hear.an || hear.el !== el || !hear.tracker) return false;
    hear.an.getByteFrequencyData(hear.buf);
    var r = Beat.pushSpectrum(hear.tracker, hear.buf, t);
    if (!r) return false;
    hear.onset = r.onset;
    hear.drop = r.drop;
    hear.rel += (r.rel - hear.rel) * 0.1;
    var e = Beat.track(hear.tracker, t);
    if (e) {
      hear.intensity = Beat.liveIntensity(e.bpm, hear.tracker.bassMean);
      if (beatClock.source !== "tap" && Beat.setTempo(beatClock, e.bpm, e.offset, "live")) updateBeatCss(false);
      beatSaveLive(false);
    }
    return true;
  }

  function onLocalAudio(el, kind) {
    if (kind === "playing") hearAttach(el);
    else beatSaveLive(true);
    // The Lecteur announces local playback globally: the DJ show steps aside, and the chip already prefers the file.
    if (el && el.id === "player-audio") {
      try {
        window.dispatchEvent(new CustomEvent("hq:local-play", {
          detail: { playing: kind === "playing" && !el.paused && !el.ended, src: el.currentSrc || "" }
        }));
      } catch (_) {}
    }
    if (!available) return;
    setWaveLive(playback.playing);
    if (localAudio()) ensureBootyRaf();
  }

  // Tap tempo: four or more steady taps on the little pill (or "t" on the focused chip) set the beat and its
  // downbeat for this track, and the grid is kept for next time.
  var tapIdleTimer = 0;
  function beatTapNow() {
    if (!musicPlaying()) return;
    var el = localAudio();
    syncBeatKey(el);
    var t = (window.performance && performance.now ? performance.now() : Date.now()) / 1000;
    var res = Beat.tap(beatTap, t, songTime(el));
    tapButton.classList.add("is-tapping");
    if (tapIdleTimer) window.clearTimeout(tapIdleTimer);
    tapIdleTimer = window.setTimeout(function () {
      tapButton.classList.remove("is-tapping");
      tapButton.textContent = "\u266a tempo";
    }, 2600);
    if (!res) {
      tapButton.textContent = "\u266a " + beatTap.times.length + "\u2026";
      return;
    }
    Beat.setTempo(beatClock, res.bpm, res.offset, "tap");
    updateBeatCss(true);
    tapButton.textContent = "\u266a " + Math.round(res.bpm) + " BPM \u2713";
    if (beatKey && res.offset != null) {
      postBeat({ key: beatKey, source: "tap", bpm: res.bpm, offset: Math.round(Math.min(3600, res.offset) * 1000) / 1000, confidence: 1 });
    }
  }

  function applyPosition(save) {
    var pad = 10;
    var vw = document.documentElement.clientWidth || window.innerWidth || 800;
    var vh = document.documentElement.clientHeight || window.innerHeight || 640;
    if (!dock.hidden && dock.offsetWidth) {
      var fixed = getComputedStyle(dock);
      var right = parseFloat(fixed.right);
      var bottom = parseFloat(fixed.bottom);
      if (!Number.isFinite(right)) right = 0;
      if (!Number.isFinite(bottom)) bottom = 0;
      var baseLeft = vw - right - dock.offsetWidth;
      var baseTop = vh - bottom - dock.offsetHeight;
      var maxY = vh - pad - dock.offsetHeight - baseTop;
      pos.x = clampNum(pos.x, pad - baseLeft, vw - pad - dock.offsetWidth - baseLeft);
      pos.y = clampNum(pos.y, pad - baseTop, maxY);
      var edgeL = (baseLeft + pos.x) <= 38 ? -1 : 0;
      var edgeR = (baseLeft + pos.x + dock.offsetWidth) >= vw - 38 ? 1 : 0;
      fxSt.edgeBiasX = edgeL + edgeR;
      fxSt.edgeBiasY = (baseTop + pos.y + dock.offsetHeight) >= vh - 38 ? 1 : 0;
    }
    dock.style.transform = "translate3d(" + pos.x.toFixed(1) + "px," + pos.y.toFixed(1) + "px,0)";
    dock.classList.toggle("is-floated", Math.hypot(pos.x, pos.y) > 2);
    if (save) persistPosition();
  }

  function cancelDrag() {
    drag = null;
    dock.classList.remove("is-dragging");
  }

  function setBlocked(on) {
    if (on) {
      pinching = true;
      suppressClick = true;
      cancelDrag();
      stopDance();
      return;
    }
    pinching = false;
    window.setTimeout(function () { suppressClick = false; }, 320);
  }

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    var moved = drag.moved;
    drag = null;
    dock.classList.remove("is-dragging");
    fxSt.carryPull = 0;
    if (!moved) return;
    applyPosition(true);
    bootyPhys.vy += 32;
    if (fxSt.dizzy >= 0.65 && button.classList.contains("is-nsfw") && !reduceMotion) {
      var nowEd = performance.now() / 1000;
      fxSt.dizzyUntil = nowEd + 2.6;
      fxSt.dizzy = 0;
      fxSt.flush = Math.min(1, fxSt.flush + 0.35);
      mouthSt.flustered = Math.max(mouthSt.flustered, 1.8);
      showReaction("dizzy", NSFW_DIZZY_LINES, true, { type: true, voice: true });
    }
    fxSt.dizzy *= 0.4;
    ensureBootyRaf();
    suppressClick = true;
    window.setTimeout(function () { suppressClick = false; }, 0);
  }

  var bootyPhys = {
    x: 0, y: 0, vx: 0, vy: 0,
    dragX: 0, dragY: 0, dragVX: 0, dragVY: 0, dragDX: 0, dragDY: 0,
    twerkGain: 0, twerkPhase: 0,
    orbitGain: 0, fig8Gain: 0, fig8Beat: 0, fig8Direction: 1,
    dropGain: 0, dropTimer: 0, dropAge: -1, comboKind: "", comboGap: 0, comboSide: 1,
    comboCancelAt: -1, nextAccentCombo: "ripple", beatWraps: 0,
    ripple: 0, rippleTime: 0,
    blink: 0, blinkPhase: 0, blinking: false,
    // Soft-tissue jiggle: each cheek chases the body spring with its own stiffer, lightly damped spring.
    jlx: 0, jly: 0, jlvx: 0, jlvy: 0, jrx: 0, jry: 0, jrvx: 0, jrvy: 0, prevX: 0, prevY: 0,
    crestLag: new Float32Array(4), crestLagV: new Float32Array(4),
    cheekDrive: new Float32Array(4), cheekPress: new Float32Array(2), cheekLoad: 0,
    jLx: 0, jLy: 0, jRx: 0, jRy: 0,
    // Hips lag the body a little; the cheeks chase the hips (travelling wave). mL/mR: per-spank mass drift.
    hlx: 0, hly: 0, hlvx: 0, hlvy: 0, phx: 0, phy: 0, mL: 1, mR: 1,
    // Outward ripple from the cheeks to the thighs (amplitude + time since the hit).
    wave: 0, waveT: 0,
    // Choreography: anticipation coil, idle weight shifts, dance phrases (normal / half / double time / look / fig8 / iso).
    coilT: 0, coil: 0, prevPlaying: false, prevDrop: false, settleUntil: 0,
    freezeT: 0, freezeEnv: 0, lastFreezeAt: -10, lastDoubleBar: -1, depthPush: 0,
    spankHeatL: 0, spankHeatR: 0, spankPressL: 0, spankPressR: 0, spankTilt: 0, spankSwipeSide: 1,
    dent: 0, dentV: 0, dentU: 0.62, dentVpos: 0.25, dentDirX: 0, dentDirY: 0, dentSide: 1,
    thLx: 0, thLy: 0, thLvx: 0, thLvy: 0, thRx: 0, thRy: 0, thRvx: 0, thRvy: 0,
    phKind: 0, phUntil: 0, phRate: 1, phAmp: 1, phCount: 0, blinkDur: 0.28, bAs: 0, coilKind: "start", danceSince: 0,
    rollSide: 1, rollLead: 1, slowRoll: 0, holdSide: 0, hipWeight: 0, isoWeight: 0, cameraStill: 0,
    raf: 0, lastTs: 0,
    // Beat-aware extras: loudness against the track average, which drop window already fired, the last grid drop.
    energyMul: 1, progWinDone: 0, lastGridDrop: -1, lastGridDropPending: -1, lastPopBeat: -1,
    // Supple back: lower-back arch velocity, mid-back arch (+velocity), mid-back lag behind the pelvis (+velocity).
    bAv: 0, mAs: 0, mAv: 0, spx: 0, spy: 0, spvx: 0, spvy: 0
  };
  var NSFW_SPANK_LINES = [
    "Hii~! Master, warn me before you smack like that… ♡",
    "Ahn~! Did you really just spank me…?",
    "Mmh… don't do it too hard, or I'll lose the rhythm~",
    "Master! My cheeks are already burning… ♡",
    "Ooh~ that one stung a little… but I liked it ♡",
    "Hey! Ask nicely next time, Master~",
    "Hehe, you can't keep your hands to yourself, can you?",
    "Ahh~ again, and I might start dancing for real…"
  ];
  var NSFW_SHAKE_LINES = [
    "Mh~ easy on the bass, Master…",
    "You're only shaking me to see if it bounces, aren't you? ♡",
    "Again… I like it when you play with the tempo~",
    "Careful, you'll make my amp overload…",
    "Ahn~ keep that rhythm going a little longer, Master…",
    "Hehe, everything is wobbling when you do that~",
    "Mmh, you're making me dizzy… in a good way ♡"
  ];
  var NSFW_MODE_LINES = [
    "Private mode on… I'm all yours, Master ♡",
    "Shall we go backstage? Pick your track~",
    "Just the two of us now… what shall we play, Master? ♡"
  ];
  var NSFW_THIGH_LINES = [
    "Ahn~! Not the thighs, Master… they jiggle too easily ♡",
    "Mmh~ careful there, my legs are going to give out…",
    "Hehe, right on the thigh~ leaving a warm mark, Master?"
  ];
  var NSFW_ALT_CHEEK_LINES = [
    "The other cheek was starting to get jealous, Master~ ♡",
    "Left, then right… are you keeping rhythm on me?",
    "Match the pair, Master~ both are tingling now ♡"
  ];
  var NSFW_HIGH_COMBO_LINES = [
    "Haaah~ Master… s-slow down, I can't catch my breath ♡",
    "Mmh—again?! My whole body's buzzing now~",
    "Ahn~! You're completely spoiling the beat, Master… ♡"
  ];
  var NSFW_PET_LINES = [
    "Mmh… right between the ears~ don't stop, Master ♡",
    "Purr~ that's unfair when you pet me so gently…",
    "Hehe, you found my weak spot, Master~"
  ];
  var NSFW_TAIL_LINES = [
    "Eep—! Hands off the tail, it's sensitive~! ♡",
    "Mmh~ when you stroke there, it curls by itself…",
    "Hey~ Master, stop teasing my tail!"
  ];
  var NSFW_SQUEEZE_LINES = [
    "Mmh—! Holding right there feels so warm, Master… ♡",
    "Ahn~ when you let go like that it bounces right back…",
    "Hehe, checking how soft I am, Master? ♡"
  ];
  var NSFW_TEASE_HOVER_LINES = [
    "Just hovering there, Master…? Go on if you want to touch ♡",
    "Your cursor's teasing me… I can feel you circling~",
    "Mmm, stop staring so close unless you mean it, Master…"
  ];
  var NSFW_PAUSE_LINES = [
    "Eh?! You paused right in the middle of my groove, Master…",
    "Aww… no fair cutting the music like that~",
    "Quiet already? Look at my ears drooping, Master…"
  ];
  var NSFW_LOUD_LINES = [
    "Kyaa~! That volume rattled my headphones, Master! ♡",
    "Whoa—cranking it up?! My whole stage is shaking~!",
    "Ohhh yes, feel that bass punch straight through~!"
  ];
  var NSFW_DROP_SPANK_LINES = [
    "Ahn—right on the drop, Master!! ♡",
    "Timing that slap with the bass drop is SO unfair~!",
    "Double hit!! Beat plus Master's hand… mh~ ♡"
  ];
  var NSFW_AFTERGLOW_LINES = [
    "Mmh… still catching my breath after that, Master~ ♡",
    "My skin's still warm where you left your mark…",
    "Gentle right now, Master… I'm still shivering a little~"
  ];
  var NSFW_NEEDY_LINES = [
    "You warmed me up and just stopped, Master…? No fair ♡",
    "Don't leave me hanging like this… I can still feel it~",
    "Hey~ look back over here already, Master…"
  ];
  var NSFW_SKIP_STREAK_LINES = [
    "Three skips already?! Make up your mind, Master~!",
    "Stop teasing the queue and pick a real track already~ ♡",
    "You're skipping faster than I can catch the beat, Master…"
  ];
  var NSFW_DIZZY_LINES = [
    "Whoa—easy, Master… my head's spinning! ♡",
    "Did you just shake me on purpose…? Everything's tilting~",
    "Mmh—set me down gently next time, Master…"
  ];
  var NSFW_LATE_NIGHT_LINES = [
    "Still awake at this hour, Master…? Play something soft for us ♡",
    "Late-night private session with you feels extra quiet…",
    "Just the bass and you tonight, Master~ ♡"
  ];
  var NSFW_MILESTONE_LINES = [
    "Keeping count, Master…? That's {n} times tonight already ♡",
    "Mmh… {n} hits tonight—you really don't hold back on me~ ♡"
  ];
  var NSFW_ARC_CHAINS = [
    "Don't start something you won't finish, Master~",
    "N-no, wait—you're really keeping that pace up?!",
    "Okay, okay—you win, Master… keep going ♡"
  ];
  var NSFW_TRACK_VIBE_LINES = [
    "Ohh, « {t} »?! Now we're talking, Master~ ♡",
    "I love moving to « {t} » with you… keep watching me~"
  ];
  var NSFW_IDLE_TALK_LINES = [
    "It's awfully quiet right now… gonna pick a song for me, Master? ♡",
    "Mmm~ headphones are resting, just waiting for your next track~",
    "So quiet in here… come keep me company if you're not playing music ♡"
  ];

  function pickReactionLine(pool) {
    return pool[bubbleIdx++ % pool.length];
  }
  var lastBubbleAt = 0;
  var bubbleTimer = 0;
  var bubbleIdx = 0;

  // Keep a speech bubble inside the viewport (phones are narrow, and the chip can be dragged/scaled):
  // left of the chip by default, then right of it, then above it as a last resort.
  function keepBubbleOnScreen(b, dockEl) {
    try {
      var vw = document.documentElement.clientWidth || window.innerWidth || 390;
      var dr = dockEl.getBoundingClientRect();
      var w = b.offsetWidth;
      var lane = window.HQSpeechLane && window.HQSpeechLane();
      var laneLeft = lane ? lane.contentRight : 8;
      if (dr.left - 12 - w >= laneLeft) return;
      if (dr.right + 10 + w <= vw - 8) {
        b.style.right = "auto";
        b.style.left = "calc(100% + 10px)";
        b.classList.add("is-right");
        return;
      }
      b.style.left = "auto";
      b.style.right = "0";
      b.style.top = "auto";
      b.style.bottom = "calc(100% + 10px)";
      b.style.transform = "none";
      b.classList.add("is-above");
    } catch (_) {}
  }

  var bubbleTypeTimer = 0;

  // opts.type: the text is written out letter by letter (the box keeps its final size); opts.dance: compact style.
  function showNsfwBubble(text, allowSfw, force, opts) {
    if (!allowSfw && !button.classList.contains("is-nsfw")) return false;
    if (!onMusiquePage()) return false;
    var now = Date.now();
    if (!force && now - lastBubbleAt < 8500) return false;  // a forced bubble (her live reaction) is never swallowed by the throttle
    sfx("reply");
    var shakeGen = "";
    if (!text && button.classList.contains("is-nsfw")) {
      shakeGen = danceGenPeek("shake");
      if (shakeGen) { text = shakeGen; if (!opts) opts = { type: true }; }
    }
    lastBubbleAt = now;
    tailAnim.perk = 1.4;
    mouthSt.talkUntil = performance.now() / 1000 + Math.min(7, 1.0 + String(text || "").length * 0.055);

    var old = dock.querySelector(".hq-musica-chip-bubble");
    if (old) old.remove();
    if (bubbleTimer) window.clearTimeout(bubbleTimer);
    if (bubbleTypeTimer) { window.clearInterval(bubbleTypeTimer); bubbleTypeTimer = 0; }

    var b = document.createElement("div");
    b.className = "hq-musica-chip-bubble" + (button.classList.contains("is-nsfw") ? "" : " is-sfw") + (opts && opts.dance ? " is-dance" : "");
    b.textContent = text || NSFW_SHAKE_LINES[bubbleIdx++ % NSFW_SHAKE_LINES.length];
    if (opts && opts.type && !reduceMotion) {
      var full = b.textContent, typed = document.createTextNode(""), ghost = document.createElement("span"), ci = 0;
      ghost.className = "hq-musica-chip-bubble-ghost";
      ghost.textContent = full;
      b.textContent = "";
      b.append(typed, ghost);
      bubbleTypeTimer = window.setInterval(function () {
        ci += 1;
        if (!b.parentNode || ci >= full.length) {
          typed.nodeValue = full;
          ghost.textContent = "";
          window.clearInterval(bubbleTypeTimer);
          bubbleTypeTimer = 0;
          return;
        }
        var ch = full.charAt(ci - 1);
        mouthSt.talkBurst = /[aeiouy]/i.test(ch) ? 0.95 : (/[,.!?—~\s]/.test(ch) ? 0.14 : 0.55);
        if (/[!?—~]/.test(ch) || ci % 7 === 0) mouthSt.talkAccent = 0.85;
        typed.nodeValue = full.slice(0, ci);
        ghost.textContent = full.slice(ci);
      }, 30);
    }
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      b.remove();
      mouthSt.talkUntil = 0;
      openMusica();
    });
    dock.appendChild(b);
    keepBubbleOnScreen(b, dock);
    var bubbleMs = (force || (opts && opts.dance)) ? Math.max(5500, Math.min(11000, 3500 + String(b.textContent).length * 50)) : 5500;
    bubbleTimer = window.setTimeout(function () {
      if (b.parentNode) b.remove();
    }, bubbleMs);
    if (opts && opts.voice) chipVoice.say(b.textContent);
    if (force && !gesture.kind && !listening && !(opts && opts.quietFace)) startGesture("smile");
    if (shakeGen) danceGenUse("shake");
    traceSpeech(b.textContent, opts);
    return true;
  }

  // The title editor lives in the chip's own bubble, so it reads like the rest of the chip and works on any view.
  function openSongTitleEditor() {
    if (!SongUnit) return;
    var song = currentSong();
    var old = dock.querySelector(".hq-musica-chip-bubble");
    if (old) old.remove();
    if (bubbleTimer) { window.clearTimeout(bubbleTimer); bubbleTimer = 0; }
    if (bubbleTypeTimer) { window.clearInterval(bubbleTypeTimer); bubbleTypeTimer = 0; }

    var b = document.createElement("div");
    b.className = "hq-musica-chip-bubble is-edit" + (button.classList.contains("is-nsfw") ? "" : " is-sfw");
    b.addEventListener("click", function (ev) { ev.stopPropagation(); });

    var label = document.createElement("div");
    label.className = "hq-musica-chip-bubble-label";
    label.textContent = song.title ? "Titre qu'elle utilise pour cette chanson" : "Titre de cette chanson";
    var field = document.createElement("input");
    field.type = "text";
    field.maxLength = 120;
    field.className = "hq-musica-chip-bubble-input";
    field.value = song.title || "";
    field.placeholder = "Automatique (fichier ou LRC)";
    field.setAttribute("aria-label", "Titre utilisé par Musica");

    var row = document.createElement("div");
    row.className = "hq-musica-chip-bubble-actions";
    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "hq-musica-chip-bubble-btn is-primary";
    ok.textContent = "OK";
    var auto = document.createElement("button");
    auto.type = "button";
    auto.className = "hq-musica-chip-bubble-btn";
    auto.textContent = "Auto";
    auto.title = "Revenir au titre détecté";
    var close = document.createElement("button");
    close.type = "button";
    close.className = "hq-musica-chip-bubble-btn is-quiet";
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "Fermer");
    row.append(ok, auto, close);
    b.append(label, field, row);
    dock.appendChild(b);
    keepBubbleOnScreen(b, dock);

    function dismiss() {
      if (bubbleTimer) { window.clearTimeout(bubbleTimer); bubbleTimer = 0; }
      if (b.parentNode) b.remove();
    }

    function feedback(text) {
      b.textContent = text;
      b.classList.remove("is-edit");
      b.classList.add("is-ok");
      b.addEventListener("click", dismiss);
      bubbleTimer = window.setTimeout(function () { if (b.parentNode) b.remove(); }, 4200);
    }

    function save(value) {
      var typed = String(value || "").trim();
      if (song.key) SongUnit.setServerOverride(song.key, typed ? { title: typed, artist: song.artist || "" } : null);
      SongUnit.setOverride(typed ? { key: song.key, title: typed, artist: song.artist || "" } : null);
      var now = currentSong();  // refreshes the visible "elle écoute" label on Lecteur as well
      dancePackFor();
      feedback(typed ? "D'accord, pour toi c'est \u00ab " + (now.title || typed) + " \u00bb \u2661" : "D'accord, je reprends le titre détecté \u2661");
      if (!song.key) return;  // no identified song: nothing to key the server copy on
      postSongTitle(song.key, typed, song.artist || "").catch(function () {
        if (b.isConnected && b.classList.contains("is-ok")) {
          b.textContent = typed ? "Titre gardé pour cet appareil — le serveur ne l'a pas pris." : "Titre détecté rétabli sur cet appareil.";
        }
      });
    }

    ok.addEventListener("click", function () { save(field.value); });
    auto.addEventListener("click", function () { save(""); });
    close.addEventListener("click", dismiss);
    field.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); save(field.value); }
      else if (ev.key === "Escape") { ev.preventDefault(); dismiss(); }
    });
    window.setTimeout(function () { try { field.focus(); field.select(); } catch (_) {} }, 30);
  }

  // Soft spoken voice lines via HQ's /api/musica/speak (only after user interaction, cached, silent fallback).
  var chipVoice = {
    unlocked: false,
    unavailable: false,
    lastAt: 0,
    epoch: 0,        // bumped when the song changes: a synthesis started for the old one must not speak
    audio: null,
    cache: Object.create(null),
    keys: [],
    unlock: function () { this.unlocked = true; },
    stop: function () {
      if (this.audio) {
        try { this.audio.pause(); this.audio.src = ""; } catch (_) {}
        this.audio = null;
      }
    },
    canSpeak: function () {
      return !!(this.unlocked && !this.unavailable && button.classList.contains("is-nsfw") &&
        !reduceMotion && !document.hidden && bodySfx.on());
    },
    playUrl: function (url) {
      if (!url || !this.canSpeak()) return;
      try {
        if (this.audio) { this.audio.pause(); this.audio = null; }
        var a = new Audio(url);
        a.volume = Math.min(0.85, Math.max(0.25, playback.volume * 0.72));
        this.audio = a;
        a.addEventListener("loadedmetadata", function () {
          if (Number.isFinite(a.duration) && a.duration > 0.2) {
            mouthSt.talkUntil = Math.max(mouthSt.talkUntil, performance.now() / 1000 + Math.min(8, a.duration));
          }
        });
        a.addEventListener("timeupdate", function () {
          if (!a.paused && !a.ended) {
            mouthSt.talkBurst = Math.max(mouthSt.talkBurst, 0.45 + 0.45 * Math.abs(Math.sin(a.currentTime * 11)));
          }
        });
        a.play().catch(function () {});
      } catch (_) {}
    },
    say: function (rawText) {
      if (!this.canSpeak() || !rawText) return;
      var now = Date.now();
      if (now - this.lastAt < 14000) return;
      var cleaned = String(rawText).replace(/[♡♪~…]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
      if (cleaned.length < 4) return;
      this.lastAt = now;
      var epoch = this.epoch;
      if (this.cache[cleaned]) { this.playUrl(this.cache[cleaned]); return; }
      var self = this;
      var headers = { "Content-Type": "application/json" };
      if (typeof window.hqCsrfToken === "function") {
        var tok = window.hqCsrfToken();
        if (tok) headers["X-CSRF-Token"] = tok;
      }
      fetch("/api/musica/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: headers,
        body: JSON.stringify({ text: cleaned, language: "en" })
      }).then(function (res) {
        if (self.epoch !== epoch) return null;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) self.unavailable = true;
          return null;
        }
        return res.json();
      }).then(function (data) {
        if (self.epoch !== epoch) return;
        if (!data || !data.ok || typeof data.audio_url !== "string" || !data.audio_url) return;
        if (self.keys.length >= 16) { delete self.cache[self.keys.shift()]; }
        self.keys.push(cleaned);
        self.cache[cleaned] = data.audio_url;
        self.playUrl(data.audio_url);
      }).catch(function () {});
    }
  };

  // Dance commentary: short written remarks next to her while she moves to the music. They follow what she is
  // doing (start, drop, slow rolls, burst, look back, out of breath, end), come every ~10-15 s at most, never while
  // a blind match hides the song, and can be switched off with localStorage["hq-musica-dancetalk"] = "0".
  var DANCE_LINES = {
    start: [
      "Here we go, Master… watch me move ♡",
      "Oh, this beat… my hips are deciding on their own~",
      "Will you let me dance for you? ♡",
      "Come on… follow the tempo with me~",
      "Mmh~ the music starts, and so do I ♡",
      "Just warming up a little… don't look away, Master~",
      "Oh, I can already feel the rhythm in my legs…",
      "You wanted a show? Here it is~ ♡",
      "Hehe, shall we dance? I can never resist this…",
      "My hips have taken over, Master~",
      "Careful, I'm getting carried away ♡",
      "There it is… the music carries me~",
      "Watch closely, I won't do it twice… okay, I will ♡",
      "I'll start slow, let me find the groove~",
      "Mmh, this intro is giving me shivers…",
      "Everyone says I dance well… see for yourself ♡",
      "A little dance just for you, Master~",
      "The tempo is calling me… and so are you, a little ♡",
      "Warming up… are you following me with your eyes?",
      "There, I'm letting it all go, it's for you~ ♡"
    ],
    drop: [
      "Ahn~ here it comes… hold on tight!",
      "The drop~! Now you'll see ♡",
      "Oh… the bass runs right through me~",
      "Haaan~ it hits hard, I love it!",
      "Here it goes, it's exploding~ ♡",
      "The bass… I feel it down to my bones!",
      "Master, don't blink right now~",
      "Ohhh, it's this moment… I can't hold on!",
      "My legs are shaking with the bass~ ♡",
      "It's hitting hard… and I want more!",
      "Boom~! I've lost all control!",
      "Ahh, the drop is making me melt…",
      "There, there, there~! Do you feel it too?",
      "What a slap… I mean the music ♡",
      "I'm letting myself drop with the rhythm~",
      "Oh, it's going down… and so am I, hehe",
      "The whole room is vibrating, Master~ ♡",
      "Impossible to stay good during this part!",
      "Mmh, the bass knows exactly where to press…",
      "Aaah~ this is the best part, don't take your eyes off me!"
    ],
    slow: [
      "Nice and slow… do you feel the groove, Master?",
      "Taking our time… ♡",
      "Mh~ slowly, just how you like it~",
      "Every move, nice and slow… watch~",
      "Mmh, no need to rush, right?",
      "I'm rolling my hips slowly for you~ ♡",
      "Slowly, with all the desire in the world…",
      "Do you like it when I slow down like this?",
      "A little languor feels so good~",
      "Let me savor every beat, Master ♡",
      "There, nice and easy… you're watching me, right?",
      "Mmh, the music slows down, and so do I~",
      "I let the rhythm rock me…",
      "See? You don't need to go fast to be intense~",
      "Gently, deeply… ♡",
      "I'm making it last, Master~",
      "Hmm, these slow waves relax me so much…",
      "Every second counts when you dance slowly ♡",
      "I'm taking my time… and I hope you are too~",
      "Mmh~ like a wave, nice and slow"
    ],
    fast: [
      "It's speeding up~! Are you keeping up?",
      "Hehe, now I'm not holding anything back~",
      "Faster… my amp is going to overheat!",
      "The rhythm is racing, and so am I~ ♡",
      "Hold on, Master, this is getting fast!",
      "I can't stop now~",
      "Wow, it's flying! My hips have no limits!",
      "Shifting up a gear~ ♡",
      "Haha, are you struggling to follow with your eyes?",
      "Faster, even faster~!",
      "My heart is beating in time with the music!",
      "This is a real sprint~ ♡",
      "Oh my, I'm going wild!",
      "Impossible to stay still with this!",
      "I'm going to hurt my hips… and I love it~",
      "Everything is racing! Even I can't keep up~",
      "Come on, even harder, Master!",
      "The tempo is rising, and so are my cheeks ♡",
      "I'm going wild just for you~!",
      "Hehe~ time to let go!"
    ],
    look: [
      "…Are you watching me, Master? ♡",
      "Oh~ you've been watching me all along?",
      "I can feel your eyes from here… hehe",
      "Hey… you're not missing a thing, are you?",
      "I turn around… and catch you red-handed~ ♡",
      "Are you blushing, Master? Or is it me?",
      "Your eyes won't leave me… I like that~",
      "Mmh, you look like you're enjoying the show…",
      "Don't look away, it's for you ♡",
      "I saw you~ Keep watching.",
      "So, what do you think? Tell me everything…",
      "A little glance over my shoulder~ ♡",
      "I just wanted to see if you were still there…",
      "Are you devouring me with your eyes, Master?",
      "Hehe, your gaze has a crazy effect on me…",
      "There, just you and me ♡",
      "Do you want me to keep going? I think you do~",
      "I'll stop for a second… to look at you better.",
      "My cheeks heat up when you look at me like that…",
      "I was wondering what you were thinking, Master~"
    ],
    tired: [
      "Haah… I'm so hot, Master… ♡",
      "Let me catch my breath for a second~",
      "My cheeks are burning… and not only because of the music…",
      "Haa… you made me dance for a long time, didn't you?",
      "My heart is beating so hard… can you hear it?",
      "One moment, Master… I'm all out of breath ♡",
      "Hah, hah… my legs are like jelly~",
      "It's warm in here, isn't it? Or is it just me…",
      "I'm almost sweating… it's your fault~",
      "My hips are begging me to slow down…",
      "Haa… a little more and I won't answer for anything ♡",
      "I'm red as a tomato, aren't I?",
      "Phew… the energy you give me!",
      "I could dance all night… but I'm running out of air~",
      "My hair is sticking to my forehead, hehe…",
      "Haa~ a glass of water, Master?",
      "I'm trembling a little… from tiredness, or something else ♡",
      "A few more seconds and I'll collapse~",
      "I can't take any more… but I want more!",
      "Mmh, I'm all flustered… and all warm."
    ],
    end: [
      "Already over? I wanted more… ♡",
      "The music stops… but not the urge to dance~",
      "Thank you for watching me, Master ♡",
      "Oh, the silence… that was too short~",
      "Bravo to me? Hehe ♡",
      "Catching my breath… let's go again whenever you want~",
      "Did you like the show, Master?",
      "Mmh, I'm still all warm…",
      "What a dance… I'm still trembling ♡",
      "Remind me to dance for you more often~",
      "Already? I was just starting to have fun!",
      "Applaud me a little, Master… ♡",
      "The music is gone, but my heart is still dancing~",
      "End of the show… or intermission?",
      "One more song? Please ♡",
      "I'm so happy I danced for you~",
      "Hehe, I think I've earned a cuddle…",
      "The silence feels so empty now…",
      "It felt so good… shall we do it again?",
      "Thank you for this moment, Master. Stay close to me ♡"
    ]
  };
  // Lines that mention the song; only used when its title / artist is known and no blind match is open.
  var DANCE_TRACK_LINES = {
    start: [
      "\u201c{t}\u201d… I love moving to this ♡",
      "Oh, \u201c{t}\u201d! My hips already know the rhythm~",
      "{a}, here we go… you'll see how I dance to this ♡",
      "\u201c{t}\u201d always makes me want to move~",
      "With {a} playing, there's no way I'm staying good ♡"
    ],
    drop: [
      "The drop in \u201c{t}\u201d… ahn~!",
      "{a} knows exactly when to turn up the pressure ♡"
    ],
    end: [
      "\u201c{t}\u201d is over already? What a shame~ ♡",
      "Thank you {a}… and thank you, Master, for watching me ♡"
    ]
  };
  var danceBag = {};
  var danceTalkAt = 0;
  var danceTalkLast = {};

  // Generated lines: one small request writes a pack of fresh comments for every moment (fast lite model, see
  // hq_musica.dance_lines). They are fetched ahead of time (music start, new track, running low), so the bubble never
  // waits for the model; the lines above are the fallback when nothing has arrived or the request fails.
  var DANCE_KINDS = [
    "start", "drop", "slow", "fast", "look", "tired", "end", "spank", "shake",
    "pet", "pause", "loud", "skip", "dizzy", "thigh", "squeeze", "combo", "afterglow", "needy", "tail", "tease", "idle"
  ];
  var danceGen = { lines: {}, inflight: false, at: 0, for: "" };

  // The song she is actually hearing: the local file playing in Lecteur when there is one, otherwise what the
  // Spotify player reports. Asking about playback.track while a local track plays named the previous song.
  function currentSong() {
    if (!SongUnit) return { key: "", title: "", artist: "", local: false, stableMs: 0 };
    var view = document.body ? document.body.dataset.view : "";
    // The identity survives a pause (the song is still the song); only the speech gate cares about playback.
    var el = view === "lecteur" ? boundAudio[view] : null;
    if (el && (!el.isConnected || el.hidden || !el.currentSrc)) el = null;
    var song = SongUnit.identity({ view: view, src: el ? el.currentSrc : "", playback: playback });
    if (song.local) {
      var lyrics = activeLyricTrack();   // a loaded .lrc knows the real title and artist
      if (lyrics && lyrics.audio === el && lyrics.title) {
        song.title = lyrics.title;
        song.artist = lyrics.artist || "";
      }
      if (!song.title) {
        var label = document.getElementById("player-name");
        if (label && label.textContent) {
          song.title = String(label.textContent).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/\s+/g, " ").trim();
        }
      }
    }
    syncServerTitle(song.key);
    var pinned = SongUnit.overrideFor(song.key);
    if (pinned) { song.title = pinned.title; song.artist = pinned.artist || ""; }
    song = SongUnit.remember(song, Date.now());
    // What she believes she is hearing, visible on hover and in the console (HqNowPlaying.current()).
    try {
      dock.dataset.song = song.title ? song.title + (song.artist ? " \u2014 " + song.artist : "") : "";
      dock.title = song.title ? "Elle \u00e9coute : " + dock.dataset.song : "";
    } catch (_) {}
    return song;
  }

  // A pack written for the previous track must never be spoken over the new one.
  function dancePackFor() {
    var song = currentSong(), key = song.key;
    if (danceGen.for === key) return;
    danceGen.for = key;
    danceGen.lines = {};
    speechPending = null;                       // a queued line was written for the other song
    if (chipVoice) chipVoice.epoch += 1;         // and a synthesis in flight must not speak it
  }

  // She only talks about a song she has actually known for a moment: two seconds of stable identity and a
  // track that has moved off its first frame. A start line after the intro would be wrong even if the song is right.
  function speechReady(song, kind) {
    if (!song || !song.key || concealedNow()) return false;
    if ((song.stableMs || 0) < 2000) return false;
    var el = song.local ? localAudio() : null;
    var at = el ? el.currentTime : (onMusiquePage() && playback.playing ? (playback.progressMs || 0) / 1000 : NaN);
    if (!Number.isFinite(at)) return false;
    if (at < 1) return false;
    if (kind === "start" && Number.isFinite(el && el.duration) && el.duration > 0 && at > Math.min(45, el.duration * 0.2)) return false;
    return true;
  }

  var speechPending = null;
  var songSeenAt = 0;

  // One slot, and it dies with the song: the freshest queued line wins, an older one is simply dropped.
  function flushSpeech() {
    if (!speechPending) return;
    var song = currentSong();
    if (!song.key || song.key !== speechPending.key) { speechPending = null; return; }
    if (!speechReady(song, speechPending.kind)) return;
    var pending = speechPending;
    speechPending = null;
    showNsfwBubble(pending.text, false, false, { type: true, dance: true, kind: pending.kind, model: pending.model || "fallback" });
  }

  // Every spoken line is traced with the song she believed it was about, so a wrong-song report is one grep.
  var speechTracedAt = 0;
  function traceSpeech(text, opts) {
    var now = Date.now();
    if (now - speechTracedAt < 1500) return;
    speechTracedAt = now;
    var song = currentSong();
    var headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var tok = window.hqCsrfToken();
      if (tok) headers["X-CSRF-Token"] = tok;
    }
    fetch("/api/musica/speech", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: headers,
      body: JSON.stringify({
        key: song.key,
        title: song.title,
        artist: song.artist,
        source: song.local ? "local" : "spotify",
        kind: (opts && opts.kind) || "",
        model: (opts && opts.model) || "chip",
        text: String(text || "").slice(0, 240)
      })
    }).catch(function () {});
  }

  function danceGenLeft() {
    var n = 0;
    DANCE_KINDS.forEach(function (k) { n += (danceGen.lines[k] || []).length; });
    return n;
  }

  // Generated lines for the spank / shake / zone reactions: peek, show, then consume (so a throttled bubble loses nothing).
  function danceGenPeek(kind) {
    dancePackFor();
    var a = kind ? danceGen.lines[kind] : null;
    return !concealedNow() && danceTalkOn() && a && a.length ? a[0] : "";
  }
  function danceGenUse(kind) {
    dancePackFor();
    var a = kind ? danceGen.lines[kind] : null;
    if (a && a.length) a.shift();
    if (!a || !a.length) danceGenFetch(false);
  }

  function showReaction(kind, fallbackPool, force, opts, transformFn) {
    var gen = kind ? danceGenPeek(kind) : "";
    var text = gen || pickReactionLine(fallbackPool);
    if (transformFn) text = transformFn(text, !!gen);
    if (showNsfwBubble(text, false, force, Object.assign({}, opts, { kind: kind, model: gen ? "pack" : "fallback" }))) {
      if (gen) danceGenUse(kind);
      return true;
    }
    return false;
  }

  async function danceGenFetch(force) {
    if (danceGen.inflight || document.hidden || !available || !danceTalkOn() || concealedNow()) return;
    var now = Date.now();
    if (!force && now - danceGen.at < 90000) return;
    danceGen.inflight = true;
    danceGen.at = now;
    var song = currentSong(), askTrack = song.title, askArtist = song.artist, askKey = song.key, askAdult = adultOn();
    var localEl = localAudio();
    var nowSong = songTime(localEl);
    var lrcTrack = activeLyricTrack(), lrcHint = "";
    if (lrcTrack && lrcTrack.lines && lrcTrack.lines.length) {
      var lrcCur = lrcTrack.lines.find(function (ln) {
        return Math.abs(ln.time - lrcTrack.audio.currentTime) < 12;
      }) || lrcTrack.lines[0];
      if (lrcCur && lrcCur.text) lrcHint = String(lrcCur.text).slice(0, 120);
    }
    var ctl = window.AbortController ? new AbortController() : null;
    var abortTimer = ctl ? window.setTimeout(function () { ctl.abort(); }, 36000) : 0;
    try {
      var headers = { "Content-Type": "application/json" };
      if (typeof window.hqCsrfToken === "function") {
        var tok = window.hqCsrfToken();
        if (tok) headers["X-CSRF-Token"] = tok;
      }
      var res = await fetch("/api/musica/dance", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: headers,
        signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({
          nsfw: askAdult,
          track: askTrack,
          artist: askArtist,
          album: song.local ? "" : (playback.album || ""),
          // Where the play really came from, so the history never guesses Spotify for a local file.
          source: song.local ? "local" : "spotify",
          intensity: localEl ? hear.intensity : (Number.isFinite(playback.intensity) ? playback.intensity : 0.78),
          // A guessed tempo (0.5 s beat) is worse than saying nothing: the beat engine reports once it is locked.
          bpm: beatClock && beatClock.source !== "guess" && beatClock.bpm >= 40 ? Math.round(beatClock.bpm) : 0,
          lyric_hint: lrcHint,
          song_sec: Number.isFinite(nowSong) ? Math.max(0, Math.round(nowSong)) : 0,
          duration_sec: Math.max(0, Math.round((localEl && Number.isFinite(localEl.duration) ? localEl.duration * 1000 : (playback.durationMs || 0)) / 1000)),
          late_night: lateNightHour(),
          hits: chipMem.hits,
          key: askKey
        })
      });
      if (!res.ok) return;
      var data = await res.json();
      var got = data && data.lines && typeof data.lines === "object" ? data.lines : null;
      // Stale answer (track changed, adult mode flipped, commentary off, blind match started): drop it.
      if (!got || concealedNow() || !danceTalkOn() || adultOn() !== askAdult || currentSong().key !== askKey) return;
      danceGen.for = askKey;
      DANCE_KINDS.forEach(function (k) {
        var arr = Array.isArray(got[k]) ? got[k] : [];
        var clean = (SongUnit ? SongUnit.filterLines(arr, song.title) : arr)
          .filter(function (t) { return typeof t === "string" && t.length <= 200; }).slice(0, 3);
        if (clean.length) danceGen.lines[k] = clean;
      });
    } catch (_) {
    } finally {
      if (abortTimer) window.clearTimeout(abortTimer);
      danceGen.inflight = false;
    }
  }

  function danceTalkOn() {
    try { return window.localStorage.getItem("hq-musica-dancetalk") !== "0"; } catch (e) { return true; }
  }

  function danceSay(kind, chance) {
    if (!danceTalkOn() || !button.classList.contains("is-nsfw") || document.hidden || !available || drag) return;
    var now = Date.now();
    if (now < danceTalkAt || Math.random() > chance) return;
    dancePackFor();
    var song = currentSong();
    var generated = !concealedNow() && danceTalkOn() && danceGen.lines[kind] && danceGen.lines[kind].length ? danceGen.lines[kind] : null;
    var pick;
    if (generated) {
      pick = generated[0];
    } else {
      var pool = (DANCE_LINES[kind] || []).slice();
      if (!concealedNow() && (song.title || song.artist) && DANCE_TRACK_LINES[kind]) {
        var tt = String(song.title || "").slice(0, 40), aa = String(song.artist || "").split(",")[0].slice(0, 40);
        DANCE_TRACK_LINES[kind].forEach(function (tpl) {
          if ((tpl.indexOf("{t}") >= 0 && !tt) || (tpl.indexOf("{a}") >= 0 && !aa)) return;
          pool.push(tpl.replace(/\{t\}/g, tt).replace(/\{a\}/g, aa));
        });
      }
      if (!pool.length) return;
      // Shuffle bag: every line is used once before any comes back, and never the same one twice in a row.
      var bag = danceBag[kind] || (danceBag[kind] = []);
      bag = bag.filter(function (t) { return pool.indexOf(t) >= 0; });
      if (!bag.length) {
        bag = pool.slice();
        for (var bi = bag.length - 1; bi > 0; bi -= 1) {
          var bj = Math.floor(Math.random() * (bi + 1)), tmp = bag[bi];
          bag[bi] = bag[bj];
          bag[bj] = tmp;
        }
        if (bag.length > 1 && bag[bag.length - 1] === danceTalkLast[kind]) bag.unshift(bag.pop());
      }
      pick = bag[bag.length - 1];
      danceBag[kind] = bag;
    }
    danceTalkAt = now + 9000 + Math.random() * 6000;
    var ready = speechReady(song, kind);
    var shown = ready && showNsfwBubble(pick, false, false, { type: true, dance: true, kind: kind, model: generated ? "pack" : "fallback" });
    if (shown) {
      danceTalkLast[kind] = pick;
      if (generated) generated.shift(); else if (danceBag[kind]) danceBag[kind].pop();
      if (danceGenLeft() < 6) danceGenFetch(false);
    } else if (!ready && song.key) {
      // Too early in the song (or the pack is still arriving): hold one line, drop it if the song changes.
      speechPending = { text: pick, kind: kind, key: song.key, model: generated ? "pack" : "fallback" };
      if (generated) generated.shift(); else if (danceBag[kind]) danceBag[kind].pop();
    }
  }

  // Musique (tournaments, duels) asks the chip to say a live reaction: the bubble stays up long enough to read.
  window.addEventListener("hq:musica-say", function (ev) {
    var detail = (ev && ev.detail) || {};
    if (!detail.text || !onMusiquePage() || !available) return;
    showNsfwBubble(String(detail.text).slice(0, 260), true, true, { quietFace: !!detail.quietFace });
  });

  // A blind match / quiz round just started: drop any bubble that could name the song and forget cached packs.
  window.addEventListener("hq:musica-conceal", function () {
    danceGen.lines = {};
    var live = dock.querySelector(".hq-musica-chip-bubble");
    if (live && !live.classList.contains("is-sfw")) {
      live.remove();
      mouthSt.talkUntil = 0;
    }
  });

  function currentMoodTag() {
    var nowM = performance.now() / 1000;
    if (nowM < fxSt.dizzyUntil) return "dizzy";
    if (fxSt.needy > 0.45) return "needy";
    if (fxSt.sulk > 0.35 || fxSt.pout > 0.35) return "sulk";
    if (fxSt.afterglow > 0.35) return "afterglow";
    if (fxSt.pet > 0.25) return "petted";
    return "calm";
  }

  var activeMusicTab = "";
  var ambientInFlight = false;
  async function fetchAmbientWhisper() {
    if (concealedNow()) return;  // blind match: no whisper may name the song that is playing
    if (ambientInFlight || drag || document.hidden || !onMusiquePage() || !available) return;
    ambientInFlight = true;
    try {
      var headers = { "Content-Type": "application/json" };
      if (typeof window.hqCsrfToken === "function") {
        var tok = window.hqCsrfToken();
        if (tok) headers["X-CSRF-Token"] = tok;
      }
      var idleSec = fxSt.lastInteractAt > 0 ? Math.max(0, Math.round(performance.now() / 1000 - fxSt.lastInteractAt)) : 0;
      var song = currentSong();
      var res = await fetch("/api/musica/ambient", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: headers,
        body: JSON.stringify({
          nsfw: adultOn(),
          track: song.title,
          artist: song.artist,
          playing: !!(song.local || playback.playing),
          mood: currentMoodTag(),
          late_night: lateNightHour(),
          idle_sec: idleSec,
          tab: activeMusicTab
        })
      });
      if (!res.ok) return;
      var data = await res.json();
      // The track may have changed while the model wrote its line: drop a whisper about the previous song.
      if (data && data.line && !concealedNow() && currentSong().key === song.key) {
        var whisper = SongUnit ? SongUnit.filterLines([data.line], song.title)[0] : data.line;
        if (whisper && showNsfwBubble(whisper, true, false, { type: true, kind: "ambient", model: "ambient" })) ensureBootyRaf();
      }
    } catch (_) {
    } finally {
      ambientInFlight = false;
    }
  }

  window.setTimeout(fetchAmbientWhisper, 10000);
  window.setInterval(fetchAmbientWhisper, 52000);

  // Traced on the 512 px portrait. The torso and legs overlap at the hip seams;
  // the open gaps below those seams are part of the bed, including the inner thighs.
  var BODY_CONTOURS = [
    [204,179, 205,163, 213,153, 228,136, 254,125, 270,135, 289,123, 309,131, 322,149,
      334,163, 341,182, 334,200, 336,216, 331,234, 328,248, 330,265, 328,283, 322,300,
      318,321, 309,326, 290,316, 258,294, 217,279, 222,269, 231,257, 232,249, 226,233,
      219,221, 214,209, 211,193],
    [65,365, 64,355, 70,339, 71,329, 79,313, 89,293, 98,278, 112,265, 132,252, 144,240,
      164,211, 182,185, 201,164, 213,147, 227,133, 239,125, 249,121, 257,124, 255,139,
      241,163, 226,182, 220,211, 218,222, 210,233, 191,245, 170,259, 152,275, 139,285,
      122,298, 110,312, 101,327, 97,338, 97,353, 99,364, 83,369],
    [284,131, 296,121, 309,118, 323,119, 337,125, 355,135, 373,151, 388,169, 402,190,
      416,219, 427,240, 436,251, 451,266, 460,281, 465,296, 469,321, 471,339, 476,355,
      475,369, 478,383, 475,391, 460,396, 442,395, 438,390, 442,380, 449,368, 449,357,
      443,343, 432,327, 418,309, 407,289, 398,280, 387,268, 378,258, 360,245, 346,233,
      338,223, 332,202, 329,181, 313,163, 298,152],
    [30,391, 42,382, 50,380, 50,373, 64,366, 88,362, 95,362, 103,351, 110,330, 117,310,
      124,301, 134,300, 141,307, 149,318, 164,299, 177,287, 191,279, 205,271, 230,269,
      246,271, 260,276, 277,289, 293,302, 310,318, 315,309, 322,302, 331,303, 340,311,
      350,333, 357,352, 366,370, 378,363, 394,360, 411,363, 431,373, 442,384, 443,393,
      452,400, 435,405, 405,406, 383,403, 367,396, 357,383, 359,403, 345,416, 320,419,
      301,423, 264,429, 232,431, 193,428, 162,424, 136,421, 116,413, 107,404, 107,397,
      93,400, 66,401, 46,398]
  ];
  var BODY_RIG = {
    grid: 64,
    partBlend: 19,      // px in the 512 px artwork; softness where body parts meet
    effectsInset: 9,    // keep small sample offsets inside the silhouette
    crestFalloff: [0.25, 0.60],
    crestTravel: [0.10, 0.15],
    crestJiggle: 1.68,
    crestSquash: 2.10, // vertical compression, with volume carried into width and depth
    cheekRoll: 11.0, // angular response to the difference between the two spring layers
    cheekSplay: 0.20, // outward roll as each cheek compresses and rebounds
    cheekHipShare: 0.38, // part of the hips' lag behind the body that the cheeks carry
    cheekGain: 0.145,    // keeps normal beats supple inside the soft limit
    cheekReach: 0.0205,  // soft limit of the cheek recoil, UVs
    cheekShift: 0.44,    // blend between fast inner mass and trailing crown wave
    cheekLagSec: [0.005, 0.026],
    cheekLoadAngle: 0.050,
    cheekLoadSpeed: 28,
    cheekLanding: [0.004, 0.025], // pelvis height in UVs, positive down
    cheekPressMax: 0.082,
    cheekGlintShift: [15, 25], // artwork pixels per unit of roll tangent
    cheekGlintStrength: 0.21,
    crestMax: 0.029, // soft limit in UVs
    crestLagSpring: [[195, 11.2], [165, 9.8]],
    cheekDetailBlend: [0.228, 0.310],
    cheekDetailFollow: 0.42,
    cheekDetailMax: 0.010, // max texture offset in UVs
    laceFollow: 0.35,
    waist: [0.535, 0.345],
    mid: [0.522, 0.465],
    shoulder: [0.552, 0.565],
    lowerBlend: [0.325, 0.449],
    upperBlend: [0.433, 0.562],
    headBlend: [0.524, 0.641],
    spineTurn: 0.62,    // keep cross-sections from over-rotating in a deep bend
    hipBlend: [0.51, 0.93],  // along the leg, ankle = 0 and hip = 1
    ankleBlend: [0.10, 0.32],
    footContact: [0.057, 0.112], // UV radius around each planted sole
    feet: [[80 / 512, 359 / 512], [456 / 512, 389 / 512]],
    lowerLag: 0.58,
    upperLag: 0.33,
    lowerArch: [0.08, 0.18], // UV displacement per unit of spring arch
    upperArch: [0.05, 0.14],
    lowerSpring: [160, 13], // stiffness, damping
    upperSpring: [60, 7],
    lagSpring: [70, 7.5],
    lagTarget: 0.6,
    dragSpring: [190, 13],
    dragTravel: [0.026, 0.024], // max lag target, UVs
    dragSpeed: [155, 150] // CSS pixels/sec for the lag response
  };
  // Two rows of each affine transform, in pelvis, lower/upper spine, head, left/right thigh order.
  var bodyBones = new Float32Array(36);
  var bodyMesh;

  function skinSmooth(range, value) {
    var t = Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));
    return t * t * (3 - 2 * t);
  }

  function stepCrestLag(channel, target, h, steps) {
    var spring = BODY_RIG.crestLagSpring[channel >> 1];
    var position = bootyPhys.crestLag[channel], speed = bootyPhys.crestLagV[channel];
    for (var i = 0; i < steps; i++) {
      speed += (spring[0] * (target - position) - spring[1] * speed) * h;
      position += speed * h;
    }
    bootyPhys.crestLag[channel] = position;
    bootyPhys.crestLagV[channel] = speed;
  }

  function contourDistance(points, x, y) {
    var inside = false, best = Infinity;
    for (var i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      var ax = points[j], ay = points[j + 1], bx = points[i], by = points[i + 1];
      var dx = bx - ax, dy = by - ay, px = x - ax, py = y - ay;
      if ((ay > y) !== (by > y) && px < dx * py / dy) inside = !inside;
      var t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      px -= t * dx;
      py -= t * dy;
      best = Math.min(best, px * px + py * py);
    }
    return (inside ? 1 : -1) * Math.sqrt(best);
  }

  function weightBodyVertex(vertices, at, x, y) {
    var rig = BODY_RIG;
    vertices[at] = x;
    vertices[at + 1] = y;
    var distances = BODY_CONTOURS.map(function (points) { return contourDistance(points, x * 512, y * 512); });
    var nearest = Math.max.apply(null, distances);
    // Continue the same weights past the painted edge so the mesh can carry
    // antialiased pixels. The matte clips this extension in the fragment shader.
    var shares = distances.map(function (d) { return Math.exp((d - nearest) / rig.partBlend); });
    var total = shares[0] + shares[1] + shares[2] + shares[3];
    var torso = shares[0] / total;
    var lower = skinSmooth(rig.lowerBlend, y);
    var upper = skinSmooth(rig.upperBlend, y);
    var neck = skinSmooth(rig.headBlend, y);
    vertices[at + 2] = torso * (1 - lower);
    vertices[at + 3] = torso * lower * (1 - upper);
    vertices[at + 4] = torso * lower * upper * (1 - neck);
    vertices[at + 5] = torso * lower * upper * neck + shares[3] / total;
    for (var leg = 0; leg < 2; leg++) {
      var foot = rig.feet[leg], hip = leg === 0 ? HIP_LEFT : HIP_RIGHT;
      var dx = hip[0] - foot[0], dy = hip[1] - foot[1];
      var along = ((x - foot[0]) * dx + (y - foot[1]) * dy) / (dx * dx + dy * dy);
      var legWeight = shares[leg + 1] / total;
      var hipWeight = skinSmooth(rig.hipBlend, along);
      vertices[at + 2] += legWeight * hipWeight;
      vertices[at + 6 + leg] = legWeight * (1 - hipWeight) * skinSmooth(rig.ankleBlend, along);
    }
    // The hair next to a planted foot can share its mask seam. Pin that seam
    // with the sole so no secondary bone shifts the foot's contact.
    var contact = Math.min(Math.hypot(x - rig.feet[0][0], y - rig.feet[0][1]),
      Math.hypot(x - rig.feet[1][0], y - rig.feet[1][1]));
    var unpin = skinSmooth(rig.footContact, contact);
    for (var bone = 0; bone < 6; bone++) vertices[at + 2 + bone] *= unpin;
    vertices[at + 8] = 1 + skinSmooth([0, rig.effectsInset], nearest);
  }

  function makeBodyMesh() {
    var cells = BODY_RIG.grid, side = cells + 1;
    // A stationary quad comes first. Zero in its last attribute selects the plate.
    var vertices = new Float32Array((4 + side * side) * 9);
    vertices.set([0, 1], 9);
    vertices.set([1, 0], 18);
    vertices.set([1, 1], 27);
    var indices = new Uint16Array(6 + cells * cells * 6);
    indices.set([0, 1, 2, 2, 1, 3]);
    var n = 6;
    for (var row = 0; row < side; row++) {
      for (var col = 0; col < side; col++) {
        var vertex = 4 + row * side + col;
        weightBodyVertex(vertices, vertex * 9, col / cells, row / cells);
        if (col === cells || row === cells) continue;
        indices[n++] = vertex;
        indices[n++] = vertex + side;
        indices[n++] = vertex + 1;
        indices[n++] = vertex + 1;
        indices[n++] = vertex + side;
        indices[n++] = vertex + side + 1;
      }
    }
    return { vertices: vertices, indices: indices };
  }

  function setBodyBone(bone, root, x, y, a, b, c, d) {
    var at = bone * 6;
    bodyBones[at] = a;
    bodyBones[at + 1] = b;
    bodyBones[at + 2] = x - a * root[0] - b * root[1];
    bodyBones[at + 3] = c;
    bodyBones[at + 4] = d;
    bodyBones[at + 5] = y - c * root[0] - d * root[1];
  }

  function aimBodyBone(bone, root, tip, x, y, targetX, targetY, crossFollow) {
    // Scale along the segment to reach the joint and keep unit width.
    // The spine turns its cross-section less than a straight leg.
    var dx = tip[0] - root[0], dy = tip[1] - root[1];
    var vx = targetX - x, vy = targetY - y;
    var length = Math.hypot(dx, dy), posedLength = Math.hypot(vx, vy);
    var ux = dx / length, uy = dy / length;
    var wx = vx / posedLength, wy = vy / posedLength;
    var stretch = posedLength / length;
    var turn = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy) * crossFollow;
    var c = Math.cos(turn), s = Math.sin(turn);
    var nx = c * uy + s * ux, ny = s * uy - c * ux;
    setBodyBone(bone, root, x, y, wx * ux * stretch + nx * uy, wx * uy * stretch - nx * ux,
      wy * ux * stretch + ny * uy, wy * uy * stretch - ny * ux);
  }

  function boneCoord(at, point) {
    return bodyBones[at] * point[0] + bodyBones[at + 1] * point[1] + bodyBones[at + 2];
  }

  function poseBody(x, y, cos, sin, hx, hy, headAngle, arch) {
    var rig = BODY_RIG;
    setBodyBone(0, PELVIS_PIVOT, PELVIS_PIVOT[0] + x, PELVIS_PIVOT[1] + y, cos, -sin, sin, cos);
    var hc = Math.cos(headAngle), hs = Math.sin(headAngle);
    setBodyBone(3, HEAD_PIVOT, HEAD_PIVOT[0] + hx, HEAD_PIVOT[1] + hy, hc, -hs, hs, hc);
    var waistX = boneCoord(0, rig.waist), waistY = boneCoord(3, rig.waist);
    var midX = rig.mid[0] + (waistX - rig.waist[0]) * (1 - rig.lowerLag) + bootyPhys.spx * rig.lowerLag + arch * rig.lowerArch[0];
    var midY = rig.mid[1] + (waistY - rig.waist[1]) * (1 - rig.lowerLag) + bootyPhys.spy * rig.lowerLag + arch * rig.lowerArch[1];
    var shoulderX = boneCoord(18, rig.shoulder) * (1 - rig.upperLag) +
      (rig.shoulder[0] + bootyPhys.spx) * rig.upperLag + bootyPhys.mAs * rig.upperArch[0];
    var shoulderY = boneCoord(21, rig.shoulder) * (1 - rig.upperLag) +
      (rig.shoulder[1] + bootyPhys.spy) * rig.upperLag + bootyPhys.mAs * rig.upperArch[1];
    aimBodyBone(1, rig.waist, rig.mid, waistX, waistY, midX, midY, rig.spineTurn);
    aimBodyBone(2, rig.mid, rig.shoulder, midX, midY, shoulderX, shoulderY, rig.spineTurn);
    aimBodyBone(4, rig.feet[0], HIP_LEFT, rig.feet[0][0], rig.feet[0][1], boneCoord(0, HIP_LEFT), boneCoord(3, HIP_LEFT), 1);
    aimBodyBone(5, rig.feet[1], HIP_RIGHT, rig.feet[1][0], rig.feet[1][1], boneCoord(0, HIP_RIGHT), boneCoord(3, HIP_RIGHT), 1);
  }

  // Cache the rest triangle for each overlay contact. Its barycentric
  // coordinates are the same ones used to interpolate UVs in the shader.
  function makeBodyAnchor(point) {
    var cells = BODY_RIG.grid, side = cells + 1;
    var tx = point[0] * cells, ty = point[1] * cells;
    var ix = Math.floor(tx), iy = Math.floor(ty);
    var fx = tx - ix, fy = ty - iy;
    var at = (4 + iy * side + ix) * 9;
    var dx = 9, dy = side * 9;
    return {
      point: point,
      corners: fx + fy <= 1 ? [at, at + dx, at + dy] : [at + dy, at + dy + dx, at + dx],
      bary: fx + fy <= 1 ? [1 - fx - fy, fx, fy] : [1 - fx, fx + fy - 1, 1 - fy],
      x: 0, y: 0, angle: 0
    };
  }

  function poseBodyAnchor(anchor) {
    var v = bodyMesh.vertices, leftX, leftY;
    anchor.x = anchor.y = 0;
    for (var corner = 0; corner < 3; corner++) {
      var index = anchor.corners[corner], u = v[index], t = v[index + 1];
      var x = u, y = t;
      for (var bone = 0; bone < 6; bone++) {
        var w = v[index + 2 + bone], a = 6 * bone;
        x += w * (bodyBones[a] * u + bodyBones[a + 1] * t + bodyBones[a + 2] - u);
        y += w * (bodyBones[a + 3] * u + bodyBones[a + 4] * t + bodyBones[a + 5] - t);
      }
      anchor.x += x * anchor.bary[corner];
      anchor.y += y * anchor.bary[corner];
      if (corner === 0) { leftX = x; leftY = y; }
      if (corner === 1) anchor.angle = Math.atan2(y - leftY, x - leftX);
    }
    anchor.x -= anchor.point[0];
    anchor.y -= anchor.point[1];
  }

  function resetBodyAnchor(anchor) {
    anchor.x = anchor.y = anchor.angle = 0;
  }

  var tailAnchor = makeBodyAnchor(TAIL_ROOT);
  var earAnchors = EARS.map(function (ear) { return makeBodyAnchor([ear.piv[0] / 1024, ear.piv[1] / 1024]); });

  var bodyPlate = new Image();
  bodyPlate.decoding = "async";
  var warpState = {
    gl: null,
    failed: false,
    uBones: null,
    uScale: null,
    uBlink: null,
    uJigL: null,
    uJigR: null,
    uCrestLag: null,
    uCheekPress: null,
    uWave: null,
    uMouth: null,
    uMouthB: null,
    plate: null,
    plateReady: false,
    tex: null,
    texReady: false
  };

  function hideWarpCanvas() {
    warpCanvas.style.display = "none";
    button.classList.remove("is-warp-on");
  }

  function sizeWarpCanvas() {
    // Match the drawing buffer to the real on-screen size (device pixels) instead of a flat
    // 1024x1024: a 54px chip on a 3x iPhone needs ~162px, not a megapixel per frame.
    var css = portrait.offsetWidth || 54;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var target = Math.max(192, Math.min(1024, Math.ceil((css * dpr) / 32) * 32));
    if (warpCanvas.width !== target || warpCanvas.height !== target) {
      warpCanvas.width = target;
      warpCanvas.height = target;
    }
  }

  function uploadWarpTexture() {
    var gl = warpState.gl;
    if (!gl || gl.isContextLost() || !warpState.tex || !art.complete || !art.naturalWidth) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, warpState.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art);
    warpState.texReady = true;
    return true;
  }

  function uploadWarpPlate() {
    var gl = warpState.gl;
    if (!bodyPlate.complete || !bodyPlate.naturalWidth) return false;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, warpState.plate);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bodyPlate);
    warpState.plateReady = true;
    return true;
  }

  art.addEventListener("load", function () {
    if (warpState.gl) uploadWarpTexture();
  });

  // iOS Safari drops WebGL contexts when the tab/app is backgrounded: rebuild instead of freezing.
  warpCanvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault();
    warpState.gl = null;
    warpState.tex = null;
    warpState.plate = null;
    warpState.plateReady = false;
    warpState.texReady = false;
    warpState.failed = false;
    hideWarpCanvas();
  });
  warpCanvas.addEventListener("webglcontextrestored", function () {
    warpState.gl = null;
    warpState.texReady = false;
    warpState.plateReady = false;
    warpState.failed = false;
    if (button.classList.contains("is-nsfw")) ensureBootyRaf();
  });
  if (window.ResizeObserver) {
    new ResizeObserver(sizeWarpCanvas).observe(portrait);
  }

  function ensureWarpGl() {
    if (warpState.gl && !warpState.gl.isContextLost()) return warpState.gl;
    if (warpState.failed) return null;
    try {
      var glOpts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
      var gl = warpCanvas.getContext("webgl", glOpts) ||
               warpCanvas.getContext("experimental-webgl", glOpts);
      if (!gl) {
        warpState.failed = true;
        return null;
      }
      if (gl.isContextLost()) return null;
      sizeWarpCanvas();
      var precision =
        "#ifdef GL_FRAGMENT_PRECISION_HIGH\n" +
        "precision highp float;\n" +
        "#else\n" +
        "precision mediump float;\n" +
        "#endif\n";
      var vsSrc = precision +
        "attribute highp vec2 a_uv;" +
        "attribute vec4 a_core;" +
        "attribute vec3 a_legsFx;" +
        "uniform highp vec3 u_bones[12];" +
        "uniform vec2 u_scale;" +
        "uniform vec2 u_jigL;" +
        "uniform vec2 u_jigR;" +
        "uniform vec4 u_crestLag;" +
        "uniform vec2 u_cheekPress;" +
        "uniform float u_depthPush;" +
        "uniform vec4 u_spankDent;" +
        "uniform vec2 u_spankDir;" +
        "uniform vec2 u_wave;" +
        "uniform vec4 u_thighJig;" +
        "varying vec2 v_uv;" +
        "varying float v_effects;" +
        "varying vec4 v_cheekTurn;" +
        "highp vec2 move(highp vec3 p, highp vec3 rowX, highp vec3 rowY){" +
        "  return vec2(dot(rowX, p), dot(rowY, p)) - p.xy;" +
        "}" +
        // Full weight over the whole sphere (core = its rim, squared, in these radii) so the outline travels
        // with the mass; the falloff only blends the skin around it.
        "float s5(float a, float b, float x){" +
        "  float t = clamp((x - a) / (b - a), 0.0, 1.0);" +
        "  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);" +
        "}" +
        "float cheekWeight(vec2 uv, vec2 center, vec2 radius){" +
        "  vec2 q = (uv - center) / radius;" +
        "  float r2 = dot(q, q);" +
        "  return exp(-r2 * 1.25) * (1.0 - s5(1.10, 2.80, r2));" +
        "}" +
        "float cheekLimit(vec2 shift){" +
        "  return inversesqrt(1.0 + dot(shift, shift) / " + (BODY_RIG.crestMax * BODY_RIG.crestMax) + ");" +
        "}" +
        "vec2 cheekFlex(vec2 uv, vec2 center, vec2 radius, vec2 recoil, vec2 tangent, float press){" +
        // Project the front half of an ellipsoid. Compression pushes volume outward from
        // the cleft while tilting smoothly across the upper crown into the thigh.
        "  vec2 q = (uv - center) / radius;" +
        "  float r2 = dot(q, q);" +
        "  float rollWeight = exp(-r2 * 0.85) * (1.0 - s5(0.95, 2.20, r2));" +
        "  float sagCompress = max(0.0, recoil.y) * 2.1 - max(0.0, -recoil.y) * 0.9;" +
        "  float height = clamp(1.0 + (1.0 - u_scale.y) * " + BODY_RIG.crestSquash.toFixed(2) + " - recoil.y * 3.8 - sagCompress * 0.16 - press, 0.74, 1.24);" +
        "  vec2 axes = vec2(inversesqrt(height), height);" +
        "  vec2 surface = q * axes;" +
        "  float depth = sqrt(max(0.0, 1.0 - r2)) * axes.x;" +
        "  vec2 cs = inversesqrt(1.0 + tangent * tangent), sn = tangent * cs;" +
        "  float rollX = surface.x * cs.x + depth * sn.x;" +
        "  float turnedDepth = depth * cs.x - surface.x * sn.x;" +
        "  float rollY = surface.y * cs.y + turnedDepth * sn.y;" +
        "  vec2 roll = (vec2(rollX, rollY) - surface) * radius * rollWeight;" +
        "  float widen = clamp((axes.x - 1.0) * 3.5, 0.0, 1.0);" +
        "  vec2 rel = vec2(uv.x - mix(center.x, 0.548, 0.38 * widen), uv.y - 0.336);" +
        "  vec2 bulge = rel * (axes - 1.0);" +
        "  float crown = 0.88 + 0.20 * (1.0 - s5(0.20, 0.48, uv.y));" +
        "  return recoil * (" + BODY_RIG.crestJiggle + " * crown) + bulge + roll;" +
        "}" +
        "void main(){" +
        "  highp vec3 p = vec3(a_uv, 1.0);" +
        "  highp vec2 posed = a_uv +" +
        "    a_core.x * move(p, u_bones[0], u_bones[1]) +" +
        "    a_core.y * move(p, u_bones[2], u_bones[3]) +" +
        "    a_core.z * move(p, u_bones[4], u_bones[5]) +" +
        "    a_core.w * move(p, u_bones[6], u_bones[7]) +" +
        "    a_legsFx.x * move(p, u_bones[8], u_bones[9]) +" +
        "    a_legsFx.y * move(p, u_bones[10], u_bones[11]);" +
        "  v_cheekTurn = vec4(0.0);" +
        // Each cheek shifts smoothly within its curved lobe; wide core falloff + smooth pelvis mask prevent any horizontal seam across the thigh junction.
        "  if (a_legsFx.z > 0.5) {" +
        "    vec2 centerL = vec2(0.468, 0.268), centerR = vec2(0.622, 0.272);" +
        "    vec2 sphereL = vec2(0.120, 0.132), sphereR = vec2(0.142, 0.140);" +
        "    float left = cheekWeight(a_uv, centerL, vec2(0.151, 0.169));" +
        "    float right = cheekWeight(a_uv, centerR, vec2(0.172, 0.178));" +
        "    float pelvisFollow = s5(0.20, 0.92, a_core.x);" +
        "    float crest = (1.0 - s5(" + BODY_RIG.crestFalloff.join(",") + ", a_uv.y)) * pelvisFollow;" +
        "    vec2 recoilL = mix(u_jigL, u_crestLag.xy, " + BODY_RIG.cheekShift.toFixed(2) + ");" +
        "    vec2 recoilR = mix(u_jigR, u_crestLag.zw, " + BODY_RIG.cheekShift.toFixed(2) + ");" +
        "    vec2 rollL = u_jigL - u_crestLag.xy, rollR = u_jigR - u_crestLag.zw;" +
        "    rollL.x += rollL.y * " + BODY_RIG.cheekSplay.toFixed(2) + ";" +
        "    rollR.x -= rollR.y * " + BODY_RIG.cheekSplay.toFixed(2) + ";" +
        "    vec4 turn = clamp(vec4(rollL, rollR) * " + BODY_RIG.cheekRoll.toFixed(2) + ", -0.24, 0.24);" +
        "    v_cheekTurn = turn;" +
        // One soft limit per cheek, from how far its centre moves, so a big hit
        // scales the whole cheek's travel instead of flattening its middle.
        "    float limL = cheekLimit(cheekFlex(centerL, centerL, sphereL, recoilL, turn.xy, u_cheekPress.x));" +
        "    float limR = cheekLimit(cheekFlex(centerR, centerR, sphereR, recoilR, turn.zw, u_cheekPress.y));" +
        "    vec2 local = (left * limL * cheekFlex(a_uv, centerL, sphereL, recoilL, turn.xy, u_cheekPress.x) +" +
        "      right * limR * cheekFlex(a_uv, centerR, sphereR, recoilR, turn.zw, u_cheekPress.y)) / max(1.0, left + right);" +
        "    local *= crest;" +
        "    float bothCheeks = 1.0 - (1.0 - left) * (1.0 - right);" +
        "    vec2 travel = move(vec3(" + PELVIS_PIVOT.join(",") + ",1.0), u_bones[0], u_bones[1]);" +
        "    vec2 radialPush = (a_uv - vec2(0.548, 0.282)) * (u_depthPush * crest * bothCheeks);" +
        "    vec2 dentVec = a_uv - u_spankDent.xy;" +
        "    vec2 dentQ = dentVec / vec2(0.052, 0.048);" +
        "    float dentR2 = dot(dentQ, dentQ);" +
        "    float dentCore = exp(-dentR2 * 2.10);" +
        "    float dentRim = dentR2 * exp(-dentR2 * 1.15) * (1.0 - s5(1.5, 4.0, dentR2));" +
        "    float legT = clamp((u_spankDent.y - 0.305) / 0.265, 0.0, 1.0);" +
        "    vec2 thighAxis = vec2(u_spankDent.w < 0.0 ? (0.440 - 0.210 * legT) : (0.695 + 0.155 * legT), u_spankDent.y + 0.015);" +
        "    vec2 cheekCore = vec2(u_spankDent.w < 0.0 ? 0.525 : 0.575, 0.345);" +
        "    vec2 dentCoreTarget = mix(cheekCore, thighAxis, s5(0.285, 0.335, u_spankDent.y));" +
        "    vec2 inward = normalize(dentCoreTarget - u_spankDent.xy + u_spankDir * 0.18 + vec2(1e-4));" +
        "    vec2 dentPerp = vec2(-inward.y, inward.x);" +
        "    vec2 rimDir = normalize(dentPerp * dot(dentVec, dentPerp) - inward * (0.45 * length(dentVec)) + vec2(1e-4));" +
        "    float dentMass = a_core.x + a_legsFx.x + a_legsFx.y;" +
        "    float dentMask = (1.0 - s5(0.46, 0.58, a_uv.y)) * s5(0.10, 0.45, dentMass);" +
        "    float dentDepth = u_spankDent.z * mix(1.0, 0.68, s5(0.285, 0.345, u_spankDent.y));" +
        "    vec2 dentDisp = (inward * (dentDepth * 0.068 * dentCore) + rimDir * (dentDepth * 0.030 * dentRim)) * dentMask;" +
        "    vec2 waveVec = a_uv - u_spankDent.xy;" +
        "    float waveR = length(waveVec * vec2(0.95, 1.15));" +
        "    float waveTrain = sin(waveR * 18.0 - u_wave.y * 14.0) * exp(-waveR * waveR * 42.0) * smoothstep(0.015, 0.070, waveR);" +
        "    float waveSide = mix(0.22, 1.0, smoothstep(-0.08, 0.08, (u_spankDent.w < 0.0 ? 0.548 - a_uv.x : a_uv.x - 0.548)));" +
        "    vec2 ripDir = normalize(waveVec + vec2(1e-4));" +
        "    vec2 ripDisp = (inward * (waveTrain * 0.0042) + ripDir * (waveTrain * 0.0028)) * (u_wave.x * waveSide * dentMask);" +
        "    float wThighL = cheekWeight(a_uv, vec2(0.320, 0.430), vec2(0.115, 0.145));" +
        "    float wThighR = cheekWeight(a_uv, vec2(0.750, 0.430), vec2(0.125, 0.150));" +
        "    vec2 thighDisp = (wThighL * u_thighJig.xy + wThighR * u_thighJig.zw) * dentMask;" +
        "    vec2 totalLocal = dentDisp + ripDisp + thighDisp;" +
        "    vec2 dRowX = u_bones[0].xy * a_core.x + u_bones[8].xy * a_legsFx.x + u_bones[10].xy * a_legsFx.y;" +
        "    vec2 dRowY = u_bones[1].xy * a_core.x + u_bones[9].xy * a_legsFx.x + u_bones[11].xy * a_legsFx.y;" +
        "    posed += vec2(dot(u_bones[0].xy, local), dot(u_bones[1].xy, local)) +" +
        "      crest * bothCheeks * travel * vec2(" + BODY_RIG.crestTravel.join(",") + ") + radialPush +" +
        "      vec2(dot(dRowX, totalLocal), dot(dRowY, totalLocal));" +
        "  }" +
        "  v_uv = a_uv;" +
        "  v_effects = a_legsFx.z;" +
        "  gl_Position = vec4(2.0 * posed.x - 1.0, 1.0 - 2.0 * posed.y, 0.0, 1.0);" +
        "}";
      var fsSrc = precision +
        "uniform sampler2D u_tex;" +
        "uniform sampler2D u_plate;" +
        // The left half packs the moving matte (red) and static holdout (green),
        // and the right half supplies the background behind the moving parts.
        "vec2 plateUV(vec2 uv, float right){" +
        "  return vec2(clamp(uv.x, 0.5/512.0, 1.0-0.5/512.0) * 0.5 + right, uv.y);" +
        "}" +
        "uniform vec2 u_scale;" +
        "uniform float u_blink;" +
        "uniform float u_shoulders;" +
        "uniform float u_smirk;" +
        "uniform vec2 u_jigL;" +
        "uniform vec2 u_jigR;" +
        "uniform vec2 u_wave;" +
        "uniform vec4 u_mouth;" +
        "uniform vec3 u_mouthB;" +
        "uniform vec4 u_fx;" +     // flush, thigh tension, sheen amount, sheen phase
        "uniform vec2 u_comboSheen;" +  // center in artwork x, strength
        "uniform vec4 u_eye;" +    // pupil offset xy, pupil scale, toe curl
        "uniform vec4 u_hair;" +
        "uniform vec2 u_lace;" +   // extra hair sway: left xy, right xy
        "uniform float u_depthPush;" +
        "uniform vec2 u_spankHeat;" +
        "uniform vec4 u_spankDent;" +
        "uniform vec2 u_mood;" +
        "uniform vec3 u_life;" +
        "varying vec2 v_uv;" +
        "varying float v_effects;" +
        "varying vec4 v_cheekTurn;" +
        "float lobe(vec2 uv, vec2 c, vec2 r){" +
        "  float d = clamp(length((uv - c) / r), 0.0, 1.0);" +
        "  float t = 1.0 - d;" +
        "  return t * t * (3.0 - 2.0 * t);" +
        "}" +
        "float lobeC(vec2 uv, vec2 c, vec2 r){" +
        "  if (uv.y < c.y) r.y *= 1.18;" +
        "  float d = pow(clamp(length((uv - c) / r), 0.0, 1.0), 1.5);" +
        "  float t = 1.0 - d;" +
        "  return t * t * (3.0 - 2.0 * t);" +
        "}" +
        "vec3 applyLid(vec3 col, vec2 uv, vec2 c, vec2 r, float blink, float inner){" +
        "  if (blink <= 0.005) return col;" +
        "  vec2 p = (uv - c) / r;" +
        "  float side = p.x * inner;" +
        "  float tOut = clamp(0.5 - 0.5 * side, 0.0, 1.0);" +
        "  float ext = 0.62 * tOut;" +
        "  vec2 q = vec2(side < 0.0 ? p.x / 1.16 : p.x, p.y < 0.0 ? p.y / (1.0 + ext) : p.y);" +
        "  float soft = mix(0.90, 0.68, smoothstep(-0.2, 0.6, q.y));" +
        "  float inEye = 1.0 - smoothstep(soft, 1.02, length(q));" +
        "  if (inEye <= 0.001) return col;" +
        "  float curve = 0.22 * (p.x * p.x) - 0.08;" +
        "  float yLid = (-1.08 - ext) + blink * (1.96 + ext) + curve + u_life.y * 0.22 * side;" +
        "  float lidMask = (1.0 - smoothstep(yLid - 0.08, yLid + 0.08, p.y)) * inEye;" +
        "  float lashMask = (1.0 - smoothstep(0.0, 0.20, abs(p.y - yLid))) * (1.0 - smoothstep(0.90, 1.02, length(q)));" +
        "  vec3 grad = mix(vec3(0.95, 0.50, 0.51), vec3(0.94, 0.42, 0.44), clamp((p.y + 1.0) * 0.5, 0.0, 1.0));" +
        "  vec3 patch = texture2D(u_tex, vec2(0.447, 0.786) + vec2(p.x * 0.011, p.y * 0.009)).rgb;" +
        "  vec3 skin = mix(grad, patch, 0.4);" +
        "  skin *= 1.0 - 0.08 * smoothstep(0.8, 0.98, sin((uv.x * 0.8 - uv.y) * 620.0));" +
        "  vec3 lash = vec3(0.10, 0.06, 0.08);" +
        "  vec3 res = mix(col, skin, lidMask);" +
        "  return mix(res, lash, lashMask * smoothstep(0.02, 0.14, blink));" +
        "}" +
        "vec3 applyMouth(vec3 col, vec2 uv, float strength, vec4 m, vec2 mb){" +
        "  if (strength <= 0.003) return col;" +
        "  vec2 p = (uv - vec2(0.446, 0.8135)) / vec2(0.034, 0.0105);" +
        "  float pillow = smoothstep(0.12, 0.30, col.g - col.r);" +
        "  float cover = 1.0 - smoothstep(0.85, 1.25, length(p * vec2(0.92, 0.78)));" +
        "  vec3 mcol = mix(col, vec3(0.975, 0.83, 0.83), cover * (1.0 - pillow));" +
        "  float w = max(m.z, 0.3);" +
        "  float xn = p.x / w;" +
        "  float edge = clamp(1.0 - xn * xn, 0.0, 1.0);" +
        "  float cy = -m.y * 0.55 * xn * xn + m.y * 0.15 + mb.x * sin(p.x * 5.0 + mb.y) - u_smirk * clamp(xn, -1.0, 1.0);" +
        "  float openH = m.x * 2.4;" +
        "  float topY = cy - openH * 0.65 * sqrt(edge);" +
        "  float botY = cy + openH * 0.35 * sqrt(edge);" +
        "  float inX = 1.0 - smoothstep(w - 0.12, w, abs(p.x));" +
        "  float inside = smoothstep(topY - 0.10, topY + 0.06, p.y) * (1.0 - smoothstep(botY - 0.06, botY + 0.10, p.y)) * inX;" +
        "  float thk = 0.10 + 0.20 * pow(edge, 0.35);" +
        "  float stroke = max(1.0 - smoothstep(thk * 0.5, thk, abs(p.y - topY)), 1.0 - smoothstep(thk * 0.5, thk, abs(p.y - botY))) * inX;" +
        "  vec3 lineC = vec3(0.36, 0.14, 0.17);" +
        "  vec3 tongC = vec3(0.98, 0.50, 0.62);" +
        "  float open01 = smoothstep(0.08, 0.30, m.x);" +
        "  mcol = mix(mcol, vec3(0.50, 0.08, 0.14), inside * open01 * (1.0 - pillow));" +
        "  float tin = inside * smoothstep(cy + openH * 0.02 - 0.12, cy + openH * 0.02 + 0.12, p.y) * smoothstep(0.25, 0.6, m.x);" +
        "  mcol = mix(mcol, tongC, tin * (1.0 - pillow));" +
        "  vec2 tp = (p - vec2(0.45 * w, botY + 0.12 + 0.30 * m.w)) / vec2(0.30 + 0.12 * m.w, 0.10 + 0.50 * m.w);" +
        "  float tl = length(tp);" +
        "  float tex = m.w * (1.0 - smoothstep(0.82, 1.0, tl));" +
        "  float tedge = m.w * (1.0 - smoothstep(0.0, 0.16, abs(tl - 0.95)));" +
        "  mcol = mix(mcol, tongC, tex * (1.0 - pillow));" +
        "  mcol = mix(mcol, lineC, max(stroke, tedge * 0.8) * (1.0 - pillow));" +
        "  return mix(col, mcol, strength);" +
        "}" +
        "vec2 eyeWarp(vec2 uv, vec2 c){" +
        "  vec2 p = uv - c;" +
        "  float d = length(p);" +
        "  float w = 1.0 - smoothstep(0.020, 0.034, d);" +
        "  float pupil = (1.0 - smoothstep(0.007, 0.017, d)) * clamp(u_life.x * 0.24, -0.16, 0.24);" +
        "  return c + p / (1.0 + u_eye.z * w + pupil) - u_eye.xy * w;" +
        "}" +
        "float skinM(vec3 c){" +
        "  return smoothstep(0.60, 0.72, c.r) * smoothstep(0.36, 0.46, c.g) * smoothstep(0.26, 0.36, c.b) * (1.0 - smoothstep(0.30, 0.42, c.r - c.g));" +
        "}" +
        // Blend the old tail-removal seams within the green back. Leave the trim and drawn contours intact.
        "vec3 samplePortrait(vec2 uv){" +
        "  vec3 col = texture2D(u_tex, uv).rgb;" +
        "  vec2 px = uv * 1024.0;" +
        "  if (px.y > 382.0 && px.y < 414.0 && px.x > 530.0 && px.x < 552.0) {" +
        "    float mask = (1.0 - smoothstep(6.0, 11.0, abs(px.x - 541.0))) * (1.0 - smoothstep(10.0, 16.0, abs(px.y - 398.0)));" +
        "    vec3 a = texture2D(u_tex, vec2(530.0 / 1024.0, uv.y)).rgb;" +
        "    vec3 b = texture2D(u_tex, vec2(552.0 / 1024.0, uv.y)).rgb;" +
        "    return mix(col, mix(a, b, (px.x - 530.0) / 22.0), mask);" +
        "  }" +
        "  if (px.y > 402.0 && px.y < 503.0 && abs(px.x - 552.0) < 13.0) {" +
        "    float mask = smoothstep(402.0, 420.0, px.y) * (1.0 - smoothstep(484.0, 503.0, px.y));" +
        "    vec3 a = texture2D(u_tex, vec2(539.0 / 1024.0, uv.y)).rgb;" +
        "    vec3 b = texture2D(u_tex, vec2(565.0 / 1024.0, uv.y)).rgb;" +
        "    col = mix(col, mix(a, b, (px.x - 539.0) / 26.0), mask);" +
        "  }" +
        "  if (px.x > 451.0 && px.x < 530.0 && abs(px.y - 387.0) < 13.0) {" +
        "    float mask = smoothstep(451.0, 466.0, px.x) * (1.0 - smoothstep(517.0, 530.0, px.x));" +
        "    vec3 a = texture2D(u_tex, vec2(uv.x, 374.0 / 1024.0)).rgb;" +
        "    vec3 b = texture2D(u_tex, vec2(uv.x, 400.0 / 1024.0)).rgb;" +
        "    col = mix(col, mix(a, b, (px.y - 374.0) / 26.0), mask);" +
        "  }" +
        "  if (px.x > 473.0 && px.x < 532.0 && abs(px.y - 505.0) < 13.0) {" +
        "    float mask = smoothstep(473.0, 485.0, px.x) * (1.0 - smoothstep(520.0, 532.0, px.x));" +
        "    vec3 a = texture2D(u_tex, vec2(uv.x, 492.0 / 1024.0)).rgb;" +
        "    vec3 b = texture2D(u_tex, vec2(uv.x, 518.0 / 1024.0)).rgb;" +
        "    col = mix(col, mix(a, b, (px.y - 492.0) / 26.0), mask);" +
        "  }" +
        "  return col;" +
        "}" +
        "float cheekCrestSheen(vec2 artPx, vec2 center, float halfSpan, vec2 curve, float sweep){" +
        "  float t = clamp((artPx.x - center.x) / halfSpan, -1.0, 1.0);" +
        "  float taper = 1.0 - smoothstep(0.62, 1.0, abs(t));" +
        "  float y = center.y + curve.x * t + curve.y * t * t;" +
        "  float edge = abs(artPx.y - y);" +
        "  float core = 1.0 - smoothstep(3.0, 11.0, edge);" +
        "  float halo = 1.0 - smoothstep(6.0, 17.0, edge);" +
        "  float glint = 1.0 - smoothstep(0.10, 0.54, abs(t - sweep));" +
        "  return taper * (0.35 * halo + (0.15 + 0.50 * glint) * core);" +
        "}" +
        "float hairM(vec3 c){" +
        "  return smoothstep(0.08, 0.25, c.g - c.r) * smoothstep(0.12, 0.32, c.g);" +
        "}" +
        "float cheekShadow(vec2 uv, vec2 lag, float region){" +
        "  if (region < 0.001) return 0.0;" +
        "  float lift = clamp(length(lag) * 92.0, 0.0, 1.0);" +
        "  vec2 light = vec2(0.45, 1.0);" +
        "  float near = hairM(texture2D(u_tex, uv - light * (0.008 + 0.014 * lift)).rgb);" +
        "  float far = hairM(texture2D(u_tex, uv - light * (0.015 + 0.024 * lift)).rgb);" +
        "  return region * mix(near, far, 0.26 + 0.25 * lift) * (1.0 - 0.66 * lift);" +
        "}" +
        "void main(){" +
        "  vec2 matte = texture2D(u_plate, plateUV(v_uv, 0.0)).rg;" +
        "  if (v_effects < 0.5) {" +
        "    vec3 base = texture2D(u_tex, v_uv).rgb;" +
        "    gl_FragColor = vec4(mix(base, texture2D(u_plate, plateUV(v_uv, 0.5)).rgb, matte.g), 1.0);" +
        "    return;" +
        "  }" +
        "  if (matte.r < 0.002) discard;" +
        "  float tissue = v_effects - 1.0;" +
        "  vec2 pivot = vec2(" + PELVIS_PIVOT[0] + "," + PELVIS_PIVOT[1] + ");" +
        "  vec2 cL = vec2(0.468, 0.275);" +
        "  vec2 cR = vec2(0.624, 0.282);" +
        "  float wL = lobeC(v_uv, cL, vec2(0.086, 0.108));" +
        "  float wR = lobeC(v_uv, cR, vec2(0.128, 0.118));" +
        "  float wTL = lobe(v_uv, vec2(0.335, 0.440), vec2(0.145, 0.160));" +
        "  wTL = 1.0 - (1.0 - wTL) * (1.0 - lobe(v_uv, vec2(0.380, 0.350), vec2(0.090, 0.095)));" +
        "  float wTR = lobe(v_uv, vec2(0.735, 0.440), vec2(0.175, 0.175));" +
        "  float wCheeks = 1.0 - (1.0 - wL) * (1.0 - wR);" +
        "  float wThighs = 1.0 - (1.0 - wTL) * (1.0 - wTR);" +
        "  float w = 1.0 - (1.0 - wCheeks) * (1.0 - 0.5 * wThighs);" +
        "  vec2 sc = mix(vec2(1.0), u_scale, 0.35 * w + 0.65 * wCheeks);" +
        "  vec2 squash = (v_uv - pivot) / sc - (v_uv - pivot);" +
        "  float wHead = lobe(v_uv, vec2(0.468, 0.675), vec2(0.220, 0.165));" +
        "  float wChin = lobe(v_uv, vec2(0.468, 0.790), vec2(0.180, 0.085));" +
        "  float wEarL = lobe(v_uv, vec2(0.350, 0.560), vec2(0.095, 0.085));" +
        "  float wEarR = lobe(v_uv, vec2(0.555, 0.560), vec2(0.095, 0.085));" +
        "  float wHairL = lobe(v_uv, vec2(0.265, 0.725), vec2(0.175, 0.125));" +
        "  float wHairR = lobe(v_uv, vec2(0.665, 0.725), vec2(0.175, 0.125));" +
        "  float wh = 1.0 - (1.0 - wHead) * (1.0 - 0.85 * wChin) * (1.0 - 0.75 * wEarL) * (1.0 - 0.75 * wEarR) * (1.0 - 0.90 * wHairL) * (1.0 - 0.90 * wHairR);" +
        "  w *= (1.0 - wh);" +
        "  vec2 jig = u_jigL * (wL * (1.0 - wh)) + u_jigR * (wR * (1.0 - wh));" +
        "  vec2 rv = v_uv - u_spankDent.xy;" +
        "  float rr = length(rv * vec2(0.95, 1.15));" +
        "  vec2 rdir = rv / max(length(rv), 0.001);" +
        "  float rip = sin(rr * 18.0 - u_wave.y * 14.0) * exp(-rr * rr * 34.0) * u_wave.x * 0.0032 * (w + 0.55 * wThighs + 0.55 * wCheeks) * (1.0 - wh);" +
        "  float aL = length(u_jigL), aR = length(u_jigR);" +
        "  vec2 dL = u_jigL / max(aL, 1e-5), dR = u_jigR / max(aR, 1e-5);" +
        "  vec2 rL = v_uv - cL, rR = v_uv - cR;" +
        "  float gL = wL * (1.0 - wh), gR = wR * (1.0 - wh);" +
        "  float alL = dot(rL, dL), alR = dot(rR, dR);" +
        "  vec2 sqz = gL * (-alL * dL * (3.2 * aL) + (rL - alL * dL) * (1.6 * aL)) + gR * (-alR * dR * (3.2 * aR) + (rR - alR * dR) * (1.6 * aR));" +
        "  float wFootL = lobe(v_uv, vec2(0.165, 0.685), vec2(0.055, 0.055));" +
        "  float wFootR = lobe(v_uv, vec2(0.865, 0.755), vec2(0.050, 0.050));" +
        "  vec2 hairD = (u_hair.xy * wHairL + u_hair.zw * wHairR) * (0.5 + 3.0 * abs(v_uv.x - 0.468)) * (1.0 - 0.85 * wHead);" +
        "  float wCupL = lobe(v_uv, vec2(0.257, 0.735), vec2(0.065, 0.075));" +
        "  float wCupR = lobe(v_uv, vec2(0.627, 0.705), vec2(0.060, 0.070));" +
        "  hairD += 1.3 * (u_hair.xy * wCupL + u_hair.zw * wCupR);" +
        "  float wLace = lobe(v_uv, vec2(0.53, 0.35), vec2(0.15, 0.07));" +
        "  vec2 thD = -0.02 * u_fx.y * ((v_uv - vec2(0.335, 0.44)) * wTL + (v_uv - vec2(0.735, 0.44)) * wTR) * (1.0 - wh);" +
        "  vec2 toeD = -0.06 * u_eye.w * ((v_uv - vec2(0.165, 0.685)) * wFootL + (v_uv - vec2(0.865, 0.755)) * wFootR);" +
        "  float shoulders = max(lobe(v_uv, vec2(0.287, 0.675), vec2(0.120, 0.086)), lobe(v_uv, vec2(0.690, 0.666), vec2(0.123, 0.089)));" +
        // Keep UV slide gentle and bound by the rounded cheek lobes so fast beats never shear along a flat y line.
        "  float rimSafe = smoothstep(" + BODY_RIG.cheekDetailBlend.join(",") + ", v_uv.y) * smoothstep(0.28, 0.90, matte.r);" +
        "  float cheekDetail = wCheeks * rimSafe;" +
        "  vec2 cheekOffset = ((squash * (1.0 - wh) - sqz - 0.35 * jig) * " + BODY_RIG.cheekDetailFollow + ") -" +
        "    u_lace * wLace * (1.0 - wh);" +
        "  cheekOffset *= mix(rimSafe, cheekDetail, 0.72) * min(1.0, " + BODY_RIG.cheekDetailMax + " / max(length(cheekOffset), 1e-5));" +
        "  vec2 offset = cheekOffset - rdir * (rip * rimSafe) - hairD - thD - toeD;" +
        "  offset.y += u_shoulders * shoulders * (1.0 - 0.65 * wHead);" +
        // Overlay contacts follow the mesh alone.
        "  float tailPin = lobe(v_uv, vec2(" + TAIL_ROOT[0] + "," + TAIL_ROOT[1] + "), vec2(0.045, 0.052));" +
        "  float earPin = max(lobe(v_uv, vec2(0.331055, 0.600586), vec2(0.038, 0.032)), lobe(v_uv, vec2(0.543945, 0.599609), vec2(0.038, 0.032)));" +
        "  float inside = tissue * (1.0 - max(tailPin, earPin));" +
        "  vec2 suv = clamp(v_uv + offset * inside, 0.0, 1.0);" +
        "  suv = eyeWarp(eyeWarp(suv, vec2(0.381, 0.762)), vec2(0.516, 0.762));" +
        "  vec3 col = samplePortrait(suv);" +
        "  float skm = skinM(col);" +
        "  float warmth = col.r - max(col.g, col.b);" +
        "  vec2 bq1 = (suv - vec2(0.345, 0.812)) / vec2(0.055, 0.026);" +
        "  vec2 bq2 = (suv - vec2(0.552, 0.812)) / vec2(0.055, 0.026);" +
        "  float blushA = clamp(u_fx.x * 0.55 * (exp(-dot(bq1, bq1)) + exp(-dot(bq2, bq2))), 0.0, 0.6) * skm;" +
        "  col = mix(col, col * vec3(1.0, 0.74, 0.80) + vec3(0.10, 0.0, 0.03), blushA);" +
        // Move each highlight in rest UVs against the surface turn, as a fixed
        // light would move across a rolling cheek.
        "  if (suv.y > 0.215 && suv.y < 0.300) {" +
        "    float warmSkin = skm * smoothstep(0.029, 0.072, warmth);" +
        "    float sweep = 0.38 * sin(u_fx.w * 6.2831853);" +
        "    vec2 artPx = suv * 1024.0;" +
        "    vec2 glintShift = vec2(" + BODY_RIG.cheekGlintShift.map(function (n) { return n.toFixed(1); }).join(",") + ");" +
        "    float sheenL = cheekCrestSheen(artPx + v_cheekTurn.xy * glintShift, vec2(460.0, 258.0), 31.0, vec2(-16.0, 9.0), sweep - v_cheekTurn.x * 1.4);" +
        "    float sheenR = cheekCrestSheen(artPx + v_cheekTurn.zw * glintShift, vec2(630.0, 257.0), 49.0, vec2(13.0, 6.0), sweep - v_cheekTurn.z * 1.4);" +
        "    float strength = u_fx.z * (0.82 + 0.18 * smoothstep(0.12, 0.58, u_fx.y)) + 0.14 * u_wave.x * (0.5 + 0.5 * cos(u_wave.y * 46.0)) + max(0.0, u_depthPush) * 2.2;" +
        "    if (u_comboSheen.y > 0.0) {" +
        "      float ripple = (artPx.x - u_comboSheen.x) / 30.0;" +
        "      float focused = mix(strength * 0.42, 1.0, exp(-ripple * ripple));" +
        "      strength = mix(strength, focused, u_comboSheen.y);" +
        "    }" +
        "    vec2 rollSheen = " + BODY_RIG.cheekGlintStrength.toFixed(2) + " * smoothstep(0.015, 0.17, vec2(length(v_cheekTurn.xy), length(v_cheekTurn.zw)));" +
        "    float sheen = dot(vec2(sheenL, sheenR), max(vec2(strength), rollSheen));" +
        "    col = mix(col, vec3(1.0, 0.99, 0.97), warmSkin * sheen);" +
        "  }" +
        "  col *= 1.0 + 0.05 * u_fx.y * (wTL + wTR) * skm * tissue;" +
        "  float gluteTone = smoothstep(0.222, 0.262, v_uv.y);" +
        "  float leadL = clamp(dot(normalize(rL + 1e-4), dL) * aL * 78.0, -1.0, 1.0) * gL;" +
        "  float leadR = clamp(dot(normalize(rR + 1e-4), dR) * aR * 78.0, -1.0, 1.0) * gR;" +
        "  float pushDepth = max(0.0, u_depthPush);" +
        "  float underGlute = max(lobe(suv, vec2(0.472, 0.304), vec2(0.068, 0.022)), lobe(suv, vec2(0.628, 0.310), vec2(0.086, 0.024))) * skm * smoothstep(0.029, 0.072, warmth) * tissue;" +
        "  col *= 1.0 + (0.085 * (leadL + leadR) + pushDepth * 1.15 * wCheeks * (1.0 - wh)) * tissue * gluteTone;" +
        "  col = mix(col, col * vec3(0.88, 0.77, 0.79), clamp(underGlute * (0.06 + pushDepth * 2.1), 0.0, 0.20));" +
        "  float squeeze = clamp((u_jigL.x - u_jigR.x) * 32.0 + (u_jigL.y + u_jigR.y) * 14.0 + pushDepth * 4.2, -0.30, 1.0);" +
        "  vec2 hlq = (suv - vec2(0.464, 0.258)) / vec2(0.088, 0.058);" +
        "  vec2 hrq = (suv - vec2(0.626, 0.264)) / vec2(0.106, 0.062);" +
        "  vec2 hsq = (suv - u_spankDent.xy) / vec2(0.072, 0.062);" +
        "  vec2 f1q = (suv - (u_spankDent.xy + vec2(-0.018 * u_spankDent.w, 0.044))) / vec2(0.022, 0.036);" +
        "  vec2 f2q = (suv - (u_spankDent.xy + vec2(0.014 * u_spankDent.w, 0.048))) / vec2(0.022, 0.038);" +
        "  float palmPrint = max(exp(-dot(hsq, hsq)), 0.78 * max(exp(-dot(f1q, f1q)), exp(-dot(f2q, f2q))));" +
        "  float spotHeat = (u_spankDent.w < 0.0 ? u_spankHeat.x : u_spankHeat.y) * palmPrint;" +
        "  float cheekHeat = clamp(max(u_spankHeat.x * exp(-dot(hlq, hlq)) + u_spankHeat.y * exp(-dot(hrq, hrq)), spotHeat * 0.85), 0.0, 1.0) * skm * smoothstep(0.029, 0.072, warmth) * tissue;" +
        "  col = mix(col, col * vec3(1.03, 0.66, 0.72) + vec3(0.09, 0.0, 0.025), cheekHeat * 0.58);" +
        "  vec2 dq = (suv - u_spankDent.xy) / vec2(0.058, 0.052);" +
        "  float dr2 = dot(dq, dq);" +
        "  float dentShade = exp(-dr2 * 1.8) * max(0.0, u_spankDent.z) * skm * smoothstep(0.029, 0.072, warmth) * tissue;" +
        "  col = mix(col, col * vec3(0.79, 0.67, 0.71), clamp(dentShade * 0.36, 0.0, 0.30));" +
        "  float cq = (v_uv.x - 0.548) / 0.028;" +
        "  float crease = exp(-cq * cq) * wCheeks * (1.0 - wh) * tissue * smoothstep(0.218, 0.256, v_uv.y);" +
        "  col = mix(col, col * vec3(0.84, 0.72, 0.74), clamp(0.22 * squeeze * crease, -0.05, 0.26));" +
        "  col = applyLid(col, suv, vec2(0.381, 0.762), vec2(0.041, 0.034), u_blink, 1.0);" +
        "  col = applyLid(col, suv, vec2(0.516, 0.762), vec2(0.041, 0.034), u_blink, -1.0);" +
        "  col = applyMouth(col, suv, u_mouthB.x, u_mouth, u_mouthB.yz);" +
        "  if (u_mood.x > 0.04) {" +
        "    vec2 eL = (suv - vec2(0.381, 0.762)) / vec2(0.022, 0.020);" +
        "    vec2 eR = (suv - vec2(0.516, 0.762)) / vec2(0.022, 0.020);" +
        "    float iris = max(exp(-dot(eL, eL) * 2.1), exp(-dot(eR, eR) * 2.1)) * (1.0 - smoothstep(0.35, 0.85, u_blink));" +
        "    float pink = smoothstep(0.02, 0.25, col.r - col.g * 0.65) + 0.35 * step(0.55, max(col.r, col.g));" +
        "    col += vec3(0.45, 0.06, 0.28) * (u_mood.x * 0.55 * iris * clamp(pink, 0.25, 1.0));" +
        "    vec2 gL = (suv - vec2(0.376, 0.771)) / vec2(0.008, 0.005);" +
        "    vec2 gR = (suv - vec2(0.511, 0.771)) / vec2(0.008, 0.005);" +
        "    float tear = max(exp(-dot(gL, gL) * 1.9), exp(-dot(gR, gR) * 1.9)) * (1.0 - u_blink);" +
        "    col = mix(col, vec3(1.0, 0.94, 0.98), clamp(u_mood.x * 0.42 * tear, 0.0, 0.45));" +
        "  }" +
        "  if (u_life.z > 0.02 && skm > 0.01) {" +
        "    vec2 pc = (suv - vec2(0.45, 0.80)) / vec2(0.11, 0.06);" +
        "    col += vec3(0.13, 0.02, 0.04) * (u_life.z * exp(-dot(pc, pc)) * skm);" +
        "  }" +
        // Restrict the cast shadow to cheek skin below the two front locks.
        "  if (skm > 0.01 && suv.y > 0.770 && suv.y < 0.874) {" +
        "    float leftCheek = lobe(suv, vec2(0.344, 0.803), vec2(0.076, 0.068));" +
        "    float rightCheek = lobe(suv, vec2(0.554, 0.806), vec2(0.076, 0.068));" +
        "    float shadow = cheekShadow(suv, u_hair.xy, leftCheek) + cheekShadow(suv, u_hair.zw, rightCheek);" +
        "    col *= 1.0 - skm * shadow * vec3(0.44, 0.38, 0.28);" +
        "  }" +
        "  gl_FragColor = vec4(col, matte.r);" +
        "}";
      function compile(type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      }
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        warpState.failed = true;
        return null;
      }
      gl.useProgram(prog);
      if (!bodyMesh) bodyMesh = makeBodyMesh();
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, bodyMesh.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bodyMesh.indices, gl.STATIC_DRAW);
      function bindSkinAttribute(name, size, offset) {
        var loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 9 * 4, offset * 4);
      }
      bindSkinAttribute("a_uv", 2, 0);
      bindSkinAttribute("a_core", 4, 2);
      bindSkinAttribute("a_legsFx", 3, 6);

      function makeWarpTexture(unit) {
        var tex = gl.createTexture();
        gl.activeTexture(unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
      }

      warpState.tex = makeWarpTexture(gl.TEXTURE0);
      warpState.plate = makeWarpTexture(gl.TEXTURE1);
      gl.uniform1i(gl.getUniformLocation(prog, "u_plate"), 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (!bodyPlate.src) bodyPlate.src = BODY_PLATE;
      warpState.gl = gl;
      warpState.uBones = gl.getUniformLocation(prog, "u_bones[0]");
      warpState.uScale = gl.getUniformLocation(prog, "u_scale");
      warpState.uBlink = gl.getUniformLocation(prog, "u_blink");
      warpState.uShoulders = gl.getUniformLocation(prog, "u_shoulders");
      warpState.uSmirk = gl.getUniformLocation(prog, "u_smirk");
      warpState.uJigL = gl.getUniformLocation(prog, "u_jigL");
      warpState.uJigR = gl.getUniformLocation(prog, "u_jigR");
      warpState.uCrestLag = gl.getUniformLocation(prog, "u_crestLag");
      warpState.uCheekPress = gl.getUniformLocation(prog, "u_cheekPress");
      warpState.uWave = gl.getUniformLocation(prog, "u_wave");
      warpState.uMouth = gl.getUniformLocation(prog, "u_mouth");
      warpState.uMouthB = gl.getUniformLocation(prog, "u_mouthB");
      warpState.uFx = gl.getUniformLocation(prog, "u_fx");
      warpState.uComboSheen = gl.getUniformLocation(prog, "u_comboSheen");
      warpState.uEye = gl.getUniformLocation(prog, "u_eye");
      warpState.uHair = gl.getUniformLocation(prog, "u_hair");
      warpState.uLace = gl.getUniformLocation(prog, "u_lace");
      warpState.uDepthPush = gl.getUniformLocation(prog, "u_depthPush");
      warpState.uSpankHeat = gl.getUniformLocation(prog, "u_spankHeat");
      warpState.uSpankDent = gl.getUniformLocation(prog, "u_spankDent");
      warpState.uSpankDir = gl.getUniformLocation(prog, "u_spankDir");
      warpState.uThighJig = gl.getUniformLocation(prog, "u_thighJig");
      warpState.uMood = gl.getUniformLocation(prog, "u_mood");
      warpState.uLife = gl.getUniformLocation(prog, "u_life");
      uploadWarpTexture();
      return gl;
    } catch (_) {
      warpState.failed = true;
      return null;
    }
  }

  function renderWarp(x, y, cos, sin, sx, sy, blink, hx, hy, bArch, jlx, jly, jrx, jry, wa, wt, mo, f, glintX, glintStrength, depthPush) {
    var gl = ensureWarpGl();
    if (!gl) return false;
    if (!warpState.texReady && !uploadWarpTexture()) return false;
    if (!warpState.plateReady && !uploadWarpPlate()) return false;
    gl.viewport(0, 0, warpCanvas.width, warpCanvas.height);
    poseBody(x, y, cos, sin, hx || 0, hy || 0, f.headAngle, bArch);
    gl.uniform3fv(warpState.uBones, bodyBones);
    gl.uniform2f(warpState.uScale, sx, sy);
    gl.uniform1f(warpState.uBlink, blink || 0);
    gl.uniform1f(warpState.uShoulders, f.shoulders);
    gl.uniform1f(warpState.uSmirk, f.smirk);
    gl.uniform2f(warpState.uJigL, jlx || 0, jly || 0);
    gl.uniform2f(warpState.uJigR, jrx || 0, jry || 0);
    gl.uniform4fv(warpState.uCrestLag, bootyPhys.crestLag);
    gl.uniform2fv(warpState.uCheekPress, bootyPhys.cheekPress);
    gl.uniform2f(warpState.uWave, wa || 0, wt || 0);
    gl.uniform4f(warpState.uMouth, mo ? mo.open : 0, mo ? mo.smile : 0, mo ? mo.wide : 0.85, mo ? mo.tongue : 0);
    gl.uniform3f(warpState.uMouthB, mo ? mo.str : 0, mo ? mo.wobAmp : 0, mo ? mo.wobPh : 0);
    gl.uniform4f(warpState.uFx, f ? f.flush : 0, f ? f.tension : 0, f ? f.sheen : 0, f ? f.sheenPh : 0);
    gl.uniform2f(warpState.uComboSheen, glintX, glintStrength);
    gl.uniform4f(warpState.uEye, f ? f.eyeX : 0, f ? f.eyeY : 0, f ? f.eyeS : 0, f ? f.curl : 0);
    gl.uniform2f(warpState.uLace, f ? f.laceX * BODY_RIG.laceFollow : 0, f ? f.laceY * BODY_RIG.laceFollow : 0);
    gl.uniform4f(warpState.uHair, f ? f.oLx : 0, f ? f.oLy : 0, f ? f.oRx : 0, f ? f.oRy : 0);
    gl.uniform1f(warpState.uDepthPush, depthPush || 0);
    gl.uniform2f(warpState.uSpankHeat, bootyPhys.spankHeatL || 0, bootyPhys.spankHeatR || 0);
    gl.uniform4f(warpState.uSpankDent, bootyPhys.dentU || 0.62, bootyPhys.dentVpos || 0.25, bootyPhys.dent || 0, bootyPhys.dentSide || 1);
    gl.uniform2f(warpState.uSpankDir, bootyPhys.dentDirX || 0, bootyPhys.dentDirY || 0);
    gl.uniform4f(warpState.uThighJig, bootyPhys.thLx || 0, bootyPhys.thLy || 0, bootyPhys.thRx || 0, bootyPhys.thRy || 0);
    gl.uniform2f(warpState.uMood, f ? Math.min(1, f.arousal * 0.85 + f.spankT * 0.45 + bootyPhys.dropGain * 0.45) : 0, f ? f.pout : 0);
    if (warpState.uLife) {
      var lifeDilate = f ? clampNum((f.arousal * 0.52 + f.afterglow * 0.25 + (f.bedroomLock || 0) * 0.28) - (f.braceUntil > (performance.now() / 1000) ? 0.28 : 0), -0.35, 0.85) : 0;
      var browTilt = f ? clampNum((f.afterglow * 0.55 + (mouthSt.flustered > 0 ? 0.35 : 0)) - (f.pout * 0.75 + f.sulk * 0.55), -1, 1) : 0;
      gl.uniform3f(warpState.uLife, lifeDilate, browTilt, f ? f.heartPulse : 0);
    }
    gl.drawElements(gl.TRIANGLES, bodyMesh.indices.length, gl.UNSIGNED_SHORT, 0);
    if (warpCanvas.style.display !== "block") {
      warpCanvas.style.display = "block";
      button.classList.add("is-warp-on");
    }
    return true;
  }

  // Expressive mouth: the shader repaints her mouth from these targets (talk while a bubble shows, sing with the
  // beat, gasp then smile on a spank, yawn on a stretch, smile on hover, an occasional tongue-out blep).
  var mouthSt = {
    open: 0, smile: 0.25, wide: 0.85, tongue: 0, str: 0, wobAmp: 0.12, wobPh: 0,
    talkUntil: 0, talkPh: 0, talkBurst: 0, talkAccent: 0, gasp: 0, happy: 0, flustered: 0, blepUntil: 0, nextBlep: 0
  };

  // Life layer: effort-driven breathing, blush build-up, eye behaviour, hair sway, thigh tension, toe curl, skin
  // sheen, tiny synthesised sounds and drifting hearts. Everything here is cheap and decays back to zero.
  var fxSt = {
    effort: 0, breathPh: 0, flush: 0, tension: 0, spankT: 0, sheen: 0, sheenPh: 0, curl: 0,
    eyeX: 0, eyeY: 0, eyeS: 0, eyeTX: 0, eyeTY: 0, nextSacc: 0, glanceFrom: 0, glanceUntil: 0, glanceDir: 1,
    ptrX: 0, ptrY: 0, ptrT: 0, pdx: 0, pnear: 0, nextBreath: 0,
    rect: null, rectT: 0, tiredSaid: false, lookFrom: 0, lookUntil: 0, lookDir: 1, lookX: 0, lookY: 0, lid: 0, lcx: 0, lcy: 0, lvx: 0, lvy: 0, laceX: 0, laceY: 0, nextCurl: 0, curlPulse: 0,
    hLx: 0, hLy: 0, hLvx: 0, hLvy: 0, hRx: 0, hRy: 0, hRvx: 0, hRvy: 0,
    oLx: 0, oLy: 0, oRx: 0, oRy: 0, headAngle: 0, shoulders: 0, chin: 0, smirk: 0,
    arousal: 0, combo: 0, lastStrikeAt: 0, lastZone: "", lastSide: 0,
    pet: 0, lastPurrAt: 0, lastTailAt: 0, lastPetSayAt: 0, lastLoudAt: 0,
    pout: 0, poutUntil: 0, teaseHoverAt: 0, teaseSaidAt: 0, teaseX: 0, teaseY: 0,
    lastInteractAt: 0, nextPostSmileAt: 0,
    squeezeActive: false, squeezeU: 0.62, squeezeV: 0.25, squeezeSide: 1, squeezeZone: "cheek",
    afterglow: 0, needy: 0, needySaidAt: 0, sulk: 0,
    shiver: 0, dizzy: 0, dizzyUntil: 0, carryPull: 0,
    braceUntil: 0, watchControlUntil: 0, watchControlDir: 0,
    heartPh: 0, heartPulse: 0, skipTimes: [], sleepy: 0,
    arcStep: 0, arcLastAt: 0, edgeBiasX: 0, edgeBiasY: 0,
    nextIdleBlink: 0, bedroomLock: 0, cupTiltL: 0, cupTiltR: 0, cupListenUntil: 0,
    nextIdleChoreo: 0, idleHabit: "", idleHabitUntil: 0, idleChoreoIdx: 0
  };
  var GESTURE_LENGTH = { listen: 1.75, surprise: 0.95, smile: 1.55, curl: 3.2, stretch: 2.8 };
  var gesture = { kind: "", at: 0, side: 1, blinked: false };

  function startGesture(kind, nowS) {
    if (!available || !motionReady() || drag || pinching) return false;
    gesture.kind = kind;
    gesture.at = nowS === undefined ? performance.now() / 1000 : nowS;
    gesture.side = -gesture.side;
    gesture.blinked = false;
    if (nowS === undefined) ensureBootyRaf();
    return true;
  }

  function stepGesture(nowS, dt) {
    var age = nowS - gesture.at;
    if (gesture.kind && age >= GESTURE_LENGTH[gesture.kind]) gesture.kind = "";
    if (!gesture.kind && listenPending) {
      applyListen(nowS);
      age = nowS - gesture.at;
    }
    var tilt = 0, chin = 0, shoulders = 0, smirk = 0, curl = 0;
    if (gesture.kind === "listen") {
      tilt = gesture.side * 0.13 * motionHold(age, 0.27, 0.52, 0.96, 1.57);
      chin = 0.017 * motionPulse(age, 0.99, 1.17, 1.54);
    } else if (gesture.kind === "smile") {
      smirk = gesture.side * 0.60 * motionHold(age, 0.19, 0.44, 1.01, 1.49);
      if (age >= 0.76 && !gesture.blinked) {
        gesture.blinked = true;
        triggerBlink(0.43, true);
      }
    } else if (gesture.kind === "stretch") {
      shoulders = 0.025 * motionHold(age, 0, 0.88, 1.13, 1.98);
      chin = 0.022 * motionHold(age, 0.35, 1.13, 1.28, 1.93);
      tilt = gesture.side * 0.05 * motionPulse(age, 0.45, 1.15, 2.02);
    } else if (gesture.kind === "curl") {
      curl = motionHold(age, 0, 1.05, 1.62, 3.12);
    }
    var blend = 1 - Math.exp(-dt * 15);
    fxSt.headAngle += (tilt - fxSt.headAngle) * blend;
    fxSt.chin += (chin - fxSt.chin) * blend;
    fxSt.shoulders += (shoulders - fxSt.shoulders) * blend;
    fxSt.smirk += (smirk - fxSt.smirk) * blend;
    tailLink.curlPose += (curl - tailLink.curlPose) * blend;
  }

  document.addEventListener("pointermove", function (event) {
    var nowPtr = performance.now() / 1000;
    var dtPtr = nowPtr - fxSt.ptrT;
    if (!drag && !pinching && button.classList.contains("is-nsfw") && !reduceMotion && dtPtr > 0.004 && dtPtr < 0.12 && fxSt.rect) {
      var r = fxSt.rect, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var rx = cx - event.clientX, ry = cy - event.clientY;
      var distC = Math.hypot(rx, ry);
      var closeV = ((event.clientX - fxSt.ptrX) * rx + (event.clientY - fxSt.ptrY) * ry) / (Math.max(1, distC) * dtPtr);
      if (distC >= 55 && distC <= 230 && closeV >= 950 && nowPtr > fxSt.braceUntil) {
        fxSt.braceUntil = nowPtr + 0.22;
        ensureBootyRaf();
      }
      var tgt = event.target && event.target.closest ? event.target.closest('[data-act*="pause"],[data-act*="prev"],[data-act*="next"],[data-act*="skip"],[data-act*="mute"],#player-play,#player-next,#player-prev,#player-vol,input[type="range"]') : null;
      if (tgt && !button.contains(tgt)) {
        fxSt.watchControlUntil = nowPtr + 0.9;
        fxSt.watchControlDir = event.clientX < cx ? -1 : 1;
        ensureBootyRaf();
      }
    }
    fxSt.ptrX = event.clientX; fxSt.ptrY = event.clientY; fxSt.ptrT = nowPtr;
  }, { passive: true });

  var stageKey = "";
  function updateStage(dx, dy, music, off) {
    var drift = 1 - bootyPhys.cameraStill;
    var z = 1.016 + 0.003 * drift * (0.5 + 0.5 * Math.sin(fxSt.breathPh * 0.55) +
      music * (0.5 + 0.5 * Math.sin(bootyPhys.twerkPhase)));
    var x = (-dx * 9 * drift).toFixed(2), y = (-dy * 9 * drift).toFixed(2), zoom = z.toFixed(3);
    var key = off ? "" : zoom + "|" + x + "|" + y;
    if (key === stageKey) return;
    stageKey = key;
    stage.style.transform = off ? "" : "translate(" + x + "%, " + y + "%) scale(" + zoom + ")";
  }

  function chipHover() {
    try { return !!(window.matchMedia("(hover: hover)").matches && button.matches(":hover")); } catch (e) { return false; }
  }

  // Synthesised sound (no files). Off with localStorage["hq-musica-sfx"] = "0"; it only starts after a spank gesture.
  var bodySfx = {
    ctx: null, noise: null,
    on: function () {
      try { return window.localStorage.getItem("hq-musica-sfx") !== "0"; } catch (e) { return true; }
    },
    vol: function () { return 0.5 * (Number.isFinite(playback.volume) ? Math.min(1, Math.max(0, playback.volume)) : 1); },
    init: function () {
      if (this.ctx) return this.ctx.state !== "closed";
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC();
        var n = this.ctx.sampleRate * 1, b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = b.getChannelData(0);
        for (var i = 0; i < n; i += 1) d[i] = Math.random() * 2 - 1;
        this.noise = b;
      } catch (e) { this.ctx = null; return false; }
      return true;
    },
    burst: function (t, dur, type, f0, f1, q, gain, pan) {
      var c = this.ctx, src = c.createBufferSource(), flt = c.createBiquadFilter(), g = c.createGain();
      src.buffer = this.noise;
      flt.type = type; flt.Q.value = q;
      flt.frequency.setValueAtTime(f0, t);
      flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.03, dur * 0.25));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      var out = g;
      if (c.createStereoPanner) { var pn = c.createStereoPanner(); pn.pan.value = pan || 0; g.connect(pn); out = pn; }
      src.connect(flt); flt.connect(g); out.connect(c.destination);
      src.start(t, Math.random() * 0.5, dur + 0.05);
    },
    slap: function (force, pan, zone) {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.init()) return;
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }
      var c = this.ctx, t = c.currentTime + 0.005, v = this.vol() * (0.5 + 0.5 * force);
      var isThigh = zone === "thigh";
      this.burst(t, isThigh ? 0.075 : 0.095, "bandpass", isThigh ? 2550 : 1850, isThigh ? 1050 : 760, isThigh ? 1.1 : 0.85, (isThigh ? 0.48 : 0.58) * v, pan);
      var o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(isThigh ? 195 : 122, t); o.frequency.exponentialRampToValueAtTime(isThigh ? 78 : 48, t + (isThigh ? 0.11 : 0.16));
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((isThigh ? 0.42 : 0.56) * v, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      var out = g;
      if (c.createStereoPanner) { var pn = c.createStereoPanner(); pn.pan.value = pan || 0; g.connect(pn); out = pn; }
      o.connect(g); out.connect(c.destination); o.start(t); o.stop(t + 0.21);
    },
    stop: function () {
      // Adult mode off / reduced motion: silence anything scheduled and release the audio device.
      if (!this.ctx) return;
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null; this.noise = null;
    },
    gasp: function (pitchMul) {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.init()) return;
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }
      var c = this.ctx, t = c.currentTime + 0.04, p = pitchMul || 1, v = this.vol();
      this.burst(t, 0.30, "bandpass", 1150 * p, 1950 * p, 1.4, 0.14 * v);
      var o = c.createOscillator(), g = c.createGain();
      o.type = "triangle"; o.frequency.setValueAtTime(480 * p, t); o.frequency.exponentialRampToValueAtTime(340 * p, t + 0.24);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.036 * v, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.28);
    },
    purr: function (level) {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.init()) return;
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }
      var c = this.ctx, t = c.currentTime + 0.01, v = this.vol() * (0.45 + 0.55 * (level || 0.7));
      var o = c.createOscillator(), flt = c.createBiquadFilter(), g = c.createGain();
      o.type = "sawtooth"; o.frequency.setValueAtTime(104, t); o.frequency.linearRampToValueAtTime(92, t + 0.42);
      flt.type = "lowpass"; flt.frequency.setValueAtTime(310, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.042 * v, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
      o.connect(flt); flt.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.46);
    },
    yawn: function () {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.init()) return;
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }
      this.burst(this.ctx.currentTime + 0.04, 0.75, "bandpass", 920, 440, 1.8, 0.085 * this.vol());
    },
    hum: function () {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.ctx || this.ctx.state !== "running") return;
      var c = this.ctx, t = c.currentTime + 0.02, v = this.vol() * 0.026;
      var o = c.createOscillator(), flt = c.createBiquadFilter(), g = c.createGain();
      o.type = "triangle"; o.frequency.setValueAtTime(290, t); o.frequency.linearRampToValueAtTime(330, t + 0.24);
      flt.type = "lowpass"; flt.frequency.setValueAtTime(620, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + 0.07);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(flt); flt.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.44);
    },
    breath: function (effort) {
      if (!this.on() || !this.ctx || this.ctx.state !== "running") return;
      this.burst(this.ctx.currentTime + 0.01, 0.5, "lowpass", 1400, 500, 0.7, 0.09 * effort * this.vol());
    }
  };

  var fxLayer = document.createElement("div");
  fxLayer.className = "hq-musica-chip-fx";
  fxLayer.setAttribute("aria-hidden", "true");
  button.appendChild(fxLayer);

  function spawnFx(glyph, n, x, y, side, effect) {
    if (reduceMotion || !button.classList.contains("is-nsfw")) return;
    for (var i = 0; i < n && fxLayer.childElementCount < 10; i += 1) {
      var el = document.createElement("i");
      el.textContent = glyph;
      if (side) {
        el.className = effect ? "hip-hit " + effect : "hip-hit";
        el.style.setProperty("--x", (x * 100).toFixed(2) + "%");
        el.style.setProperty("--y", (y * 100).toFixed(2) + "%");
        el.style.setProperty("--dx", (side * (effect === "hip-trail" ? 5 : i === 0 ? 12 : 20)) + "px");
        el.style.setProperty("--dy", (effect === "hip-trail" ? -4 : i === 0 ? -13 : -6) + "px");
        el.style.setProperty("--s", i === 0 ? "0.95" : "0.64");
      } else {
        el.style.setProperty("--x", (30 + Math.random() * 40).toFixed(0) + "%");
        el.style.setProperty("--dx", ((Math.random() - 0.5) * 34).toFixed(0) + "px");
        el.style.setProperty("--dy", (-(26 + Math.random() * 26)).toFixed(0) + "px");
        el.style.setProperty("--s", (0.7 + Math.random() * 0.6).toFixed(2));
        el.style.animationDelay = (i * 0.08).toFixed(2) + "s";
      }
      el.addEventListener("animationend", function (ev) { if (ev.target.parentNode) ev.target.parentNode.removeChild(ev.target); });
      fxLayer.appendChild(el);
      (function (node) { window.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1900); })(el);
    }
  }

  function spawnHipHit(hipX, hipY, x, y, cos, sin, side, effect, count) {
    // Place the burst at the hip on the rendered pelvis pose, then let it travel freely.
    var hx = hipX - PELVIS_PIVOT[0], hy = hipY - PELVIS_PIVOT[1];
    spawnFx(effect === "hip-arc" ? "" : effect === "hip-trail" ? "\u2022" : "\u2726", count,
      PELVIS_PIVOT[0] + x + cos * hx - sin * hy,
      PELVIS_PIVOT[1] + y + sin * hx + cos * hy, side, effect);
  }

  function triggerShiver(level) {
    if (!button.classList.contains("is-nsfw") || reduceMotion) return;
    fxSt.shiver = Math.min(1, fxSt.shiver + (level || 0.75));
    bootyPhys.thLvx += (Math.random() - 0.5) * 0.012;
    bootyPhys.thRvx += (Math.random() - 0.5) * 0.012;
    if (fxSt.arousal > 0.45) spawnFx("°", 1);
    ensureBootyRaf();
  }

  function startLook(nowS, until, side) {
    var F = fxSt;
    F.lookFrom = nowS;
    F.lookUntil = until;
    F.lookDir = side || (Math.random() < 0.5 ? -1 : 1);
    var brief = !!side;
    F.glanceFrom = brief ? until : until - 0.18;
    F.glanceUntil = until + (brief ? 0.21 : 0.32);
    F.glanceDir = -F.lookDir;
  }

  function stepFx(dt, nowS, hx, hy, active, intensity, vol, gazeStill) {
    var F = fxSt, kf = function (r) { return 1 - Math.exp(-dt * r); };
    var hover = chipHover();
    var music = active ? Math.min(1, intensity) * vol * bootyPhys.twerkGain * Math.min(1, bootyPhys.phAmp) : 0;
    // Emotional inertia (afterglow, sulk, needy), shiver/dizzy decay & heartbeat
    var highHeat = F.arousal >= 0.58 || F.combo >= 4;
    if (highHeat) F.afterglow = Math.min(1, F.afterglow + dt * 0.30);
    else F.afterglow = F.afterglow > 0.004 ? F.afterglow * Math.exp(-dt * 0.018) : 0;
    F.sulk = F.sulk > 0.004 ? F.sulk * Math.exp(-dt * 0.042) : 0;
    F.shiver = F.shiver > 0.004 ? F.shiver * Math.exp(-dt * 4.5) : 0;
    F.dizzy = (!drag && F.dizzy > 0.004) ? F.dizzy * Math.exp(-dt * 0.45) : (drag ? F.dizzy : 0);
    if (!drag) F.carryPull = F.carryPull > 0.004 ? F.carryPull * Math.exp(-dt * 7.0) : 0;
    F.sleepy = (active && intensity <= 0.52) ? Math.min(1, F.sleepy + dt * 0.16) : Math.max(0, F.sleepy - dt * 0.25);

    var idleSince = F.lastInteractAt > 0 ? (nowS - F.lastInteractAt) : 0;
    if (!hover && !F.squeezeActive && !active && (F.arousal > 0.42 || F.afterglow > 0.38) && idleSince > 16 && idleSince < 55) {
      F.needy = Math.min(1, F.needy + dt * 0.14);
      if (F.needy > 0.58 && (!F.needySaidAt || (nowS - F.needySaidAt) >= 36) && !drag && !document.hidden) {
        F.needySaidAt = nowS;
        bootyPhys.vx += (Math.random() < 0.5 ? -1 : 1) * 16;
        bootyPhys.vy -= 12;
        showReaction("needy", NSFW_NEEDY_LINES, false, { type: true, voice: true });
      }
    } else {
      F.needy = Math.max(0, F.needy - dt * 0.35);
    }

    var bpm = 68 + F.effort * 56 + F.arousal * 44;
    F.heartPh = (F.heartPh + dt * (bpm / 60)) % 1;
    var beatEnv = Math.exp(-Math.pow((F.heartPh - 0.12) / 0.055, 2)) + 0.55 * Math.exp(-Math.pow((F.heartPh - 0.28) / 0.065, 2));
    F.heartPulse = beatEnv * Math.min(1, F.effort * 0.65 + F.arousal * 0.85 + F.afterglow * 0.45);

    // Escalating combo & arousal decay + squeeze buildup
    if (F.squeezeActive) {
      F.arousal = Math.min(1, F.arousal + dt * (F.afterglow > 0.25 ? 0.34 : 0.24));
      F.flush = Math.min(1, F.flush + dt * 0.28);
      F.tension = Math.min(1, F.tension + dt * 0.35);
      mouthSt.flustered = Math.max(mouthSt.flustered, 0.6);
      F.lastInteractAt = nowS;
    } else {
      F.arousal = F.arousal > 0.003 ? F.arousal * Math.exp(-dt * 0.11) : 0;
    }
    if (F.combo > 0 && nowS - F.lastStrikeAt > 8.5) F.combo = 0;
    F.pet = F.pet > 0.005 ? F.pet * Math.exp(-dt * 2.6) : 0;
    var wantPout = (nowS < F.poutUntil && !active) ? 1 : (F.sulk > 0.25 && !active ? F.sulk * 0.72 : 0);
    F.pout += (wantPout - F.pout) * kf(8);
    if (F.nextPostSmileAt && nowS >= F.nextPostSmileAt && mouthSt.gasp <= 0.05) {
      F.nextPostSmileAt = 0;
      if (!gesture.kind && !F.squeezeActive) startGesture("smile", nowS);
    }
    // breathing effort: dancing & arousal build it, afterglow holds gentle chest warmth
    F.effort = Math.max(F.arousal * 0.42, F.afterglow * 0.28, Math.min(1, F.effort + dt * 0.10 * music - F.effort * dt / 7));
    if (F.effort > 0.5 && !F.tiredSaid) { F.tiredSaid = true; danceSay("tired", 1); }
    else if (F.effort < 0.3) F.tiredSaid = false;
    F.breathPh += dt * (1.55 + 2.4 * F.effort + 1.1 * F.arousal);
    if ((F.effort > 0.55 || F.arousal > 0.65) && nowS > F.nextBreath && bodySfx.ctx && !document.hidden) {
      bodySfx.breath(Math.max(F.effort, F.arousal * 0.85));
      F.nextBreath = nowS + Math.max(1.05, 2.6 - 1.2 * Math.max(F.effort, F.arousal * 0.75));
    }
    // thigh tension and toe curl
    F.spankT *= Math.exp(-dt * 1.4);
    F.tension += (Math.max(bootyPhys.dropGain * 0.8, F.spankT, F.arousal * 0.34) - F.tension) * kf(8);
    if (nowS > F.nextCurl) { F.curlPulse = 0.35; F.nextCurl = nowS + 5 + Math.random() * 9; }
    F.curlPulse *= Math.exp(-dt * 2.2);
    var fastTap = (active && intensity >= 0.68 && bootyPhys.twerkGain > 0.2) ? Math.pow(Math.max(0, Math.sin(bootyPhys.twerkPhase)), 3) * 0.48 * intensity : 0;
    var curlT = Math.max(F.spankT * 0.9, F.tension * 0.6, F.curlPulse, fastTap, mouthSt.happy > 0 ? 0.3 : 0, F.pet * 0.45);
    F.curl += (curlT - F.curl) * kf(10);
    // blush builds with teasing, petting, combos, and escalation and fades slowly
    if (hover && F.flush < 0.4) F.flush += dt * 0.11;
    if (music > 0.3 && F.flush < 0.28) F.flush += dt * 0.12;
    if (F.combo > 0 && F.flush < 0.95) F.flush += dt * 0.06 * Math.min(5, F.combo);
    if (F.spankT > 0.2 && F.flush < 0.92) F.flush += dt * 0.18 * F.spankT;
    if (F.arousal > 0.30 && F.flush < F.arousal * 0.96) F.flush += dt * 0.18;
    if (F.afterglow > 0.1 && F.flush < F.afterglow * 0.48) F.flush += dt * 0.12;
    F.flush = Math.max(0, Math.min(1, F.flush - dt / 26));
    // skin sheen: a highlight sweeping across while dancing, plus sweat/glow sheen at peak arousal & afterglow
    var sheenT = Math.min(1, (music > 0 ? Math.sqrt(music) * 0.92 : 0) +
      F.effort * 0.45 + F.arousal * 0.36 + F.afterglow * 0.28 + bootyPhys.dropGain * 0.35);
    F.sheen += (sheenT - F.sheen) * kf(sheenT > F.sheen ? 5 : 2.2);
    if (F.sheen > 0.02) F.sheenPh = (F.sheenPh + dt * (0.28 + 0.22 * music)) % 1;
    // eyes: irregular blinks, saccades, cursor tracking, bedroom-eye lock during tease/needy/afterglow
    var bedroomT = clampNum((hover && F.pnear > 0.38 ? 0.55 : 0) + F.needy * 0.78 + F.afterglow * 0.65 + (F.squeezeActive ? 0.62 : 0), 0, 1);
    F.bedroomLock += (bedroomT - F.bedroomLock) * kf(4.5);
    if (!F.nextIdleBlink) F.nextIdleBlink = nowS + 2.2 + Math.random() * 2.5;
    if (!bootyPhys.blinking && !drag && nowS >= F.nextIdleBlink) {
      var slowBed = F.bedroomLock > 0.35;
      triggerBlink(slowBed ? 0.38 : (0.19 + Math.random() * 0.09), true);
      F.nextIdleBlink = nowS + (Math.random() < 0.16 ? 0.28 : (2.4 + Math.random() * 3.8));
    }
    var tx, ty;
    if (nowS > F.nextSacc) {
      F.eyeTX = (Math.random() - 0.5) * 0.0070; F.eyeTY = (Math.random() - 0.5) * 0.0045;
      F.nextSacc = nowS + 0.8 + Math.random() * 2.6;
    }
    tx = F.eyeTX; ty = F.eyeTY;
    var lookNow = nowS < F.lookUntil;
    var lookAge = nowS - F.lookFrom;
    if (nowS - F.ptrT < 6) {
      if (!F.rect || nowS - F.rectT > 0.25) { F.rect = button.getBoundingClientRect(); F.rectT = nowS; }
      var r = F.rect;
      var px = (F.ptrX - (r.left + r.width / 2)) / 360, py = (F.ptrY - (r.top + r.height / 2)) / 360;
      var plen = Math.hypot(px, py), pk = plen > 1 ? 1 / plen : 1;
      tx = tx * 0.35 + px * pk * 0.0060; ty = ty * 0.35 + py * pk * 0.0045;
      F.pdx = px * pk; F.pnear = Math.max(0, Math.min(1, 1.25 - plen));
    } else { F.pnear = 0; }
    var briefLook = lookNow && bootyPhys.holdSide !== 0;
    if (lookNow) {
      var lead = Math.max(0, Math.min(1, ((briefLook ? 0.21 : 0.38) - lookAge) / (briefLook ? 0.13 : 0.24)));
      tx = F.lookDir * 0.008 * lead; ty = -0.002 * lead;
    }
    if (nowS >= F.glanceFrom && nowS < F.glanceUntil) { tx = F.glanceDir * 0.0070; ty = 0.0035; }
    var gestureAge = nowS - gesture.at;
    if (gesture.kind === "listen" && gestureAge >= 0.14) {
      tx = gesture.side * 0.010 * motionHold(gestureAge, 0.14, 0.25, 0.70, 1.22);
      ty = 0;
    }
    if (nowS < F.dizzyUntil) {
      tx = Math.cos(nowS * 9.5) * 0.0085;
      ty = Math.sin(nowS * 9.5) * 0.0055;
    } else if (nowS < F.watchControlUntil) {
      tx = F.watchControlDir * 0.0075;
      ty = -0.003;
    }
    F.eyeX += (tx * (1 - gazeStill) - F.eyeX) * kf(13);
    F.eyeY += (ty * (1 - gazeStill) - F.eyeY) * kf(13);
    var beat = music > 0.05 ? 0.045 * music * (0.5 + 0.5 * Math.sin(bootyPhys.twerkPhase)) : 0;
    var eyeT = (mouthSt.gasp > 0 || nowS < F.braceUntil ? 0.20 : 0) + beat;
    if (gesture.kind === "surprise") eyeT += 0.17 * motionPulse(gestureAge, 0.08, 0.27, 0.63);
    F.eyeS += (eyeT - F.eyeS) * kf(16);
    // The pupils lead, then the head catches up. Bedroom-eye lock holds cursor contact with half-lidded warmth.
    var turning = lookNow && lookAge >= (briefLook ? 0.08 : 0.13);
    var wantCursorLock = hover || F.bedroomLock > 0.3 || (!active && (nowS - F.lastInteractAt > 14 || F.needy > 0.35) && nowS - F.ptrT < 2.2);
    var lookTX = lookNow ? (turning ? F.lookDir * 0.009 : 0) :
      (wantCursorLock ? F.pdx * F.pnear * (0.0050 + 0.0018 * F.bedroomLock) : 0);
    var lookTY = turning ? -0.004 : (F.pet * -0.0055 + (F.bedroomLock > 0.3 && F.pnear > 0.2 ? 0.0015 * F.bedroomLock : 0));
    F.lookX += (lookTX - F.lookX) * kf(turning ? 7 : 4);
    F.lookY += (lookTY - F.lookY) * kf(turning ? 7 : 4);
    var lidT = (lookNow || nowS < F.braceUntil) ? 0 : (mouthSt.happy > 0 ? 0.22 : 0) + F.effort * 0.16 + (F.flush > 0.5 ? 0.08 : 0) +
      F.pet * 0.48 + F.arousal * 0.14 + F.afterglow * 0.15 + F.sleepy * 0.22 + F.bedroomLock * 0.24;
    if (gesture.kind === "smile") lidT = Math.max(lidT, 0.34 * motionHold(gestureAge, 0, 0.15, 0.52, 1.05));
    F.lid += (lidT - F.lid) * kf(lookNow ? 12 : 3.5);
    // Idle "the Listener" micro-choreography: stretch, humming beat, or impatient cursor peek.
    if (!active && !drag && !F.squeezeActive && !gesture.kind && nowS >= F.idleHabitUntil) {
      F.idleHabit = "";
      if (!F.nextIdleChoreo) F.nextIdleChoreo = nowS + 6 + Math.random() * 6;
      if (nowS >= F.nextIdleChoreo && !document.hidden) {
        var modeIdx = F.idleChoreoIdx % 3;
        F.idleChoreoIdx += 1;
        F.nextIdleChoreo = nowS + 10 + Math.random() * 6;
        if (modeIdx === 0) { startGesture("stretch", nowS); }
        else if (modeIdx === 1) { F.idleHabit = "hum"; F.idleHabitUntil = nowS + 3.4; }
        else { F.idleHabit = "peek"; F.idleHabitUntil = nowS + 2.6; startGesture("listen", nowS); }
      }
    } else if (active || drag || F.squeezeActive) {
      F.idleHabit = ""; F.idleHabitUntil = 0;
    }
    if (nowS >= F.cupListenUntil) {
      F.cupTiltL *= Math.exp(-dt * 6);
      F.cupTiltR *= Math.exp(-dt * 6);
    }
    if (!hover || F.squeezeActive || active) { F.teaseHoverAt = 0; }
    var peekBiasX = (F.idleHabit === "peek" && nowS - F.ptrT < 4) ? F.pdx * 0.0045 : 0;
    var peekBiasY = (F.idleHabit === "peek" && nowS - F.ptrT < 4) ? -0.0025 : 0;
    var tgtTeaseX = (hover && !F.squeezeActive && F.pnear > 0.35) ? F.pdx * (mouthSt.happy > 0.4 || F.arousal > 0.35 ? 0.0055 : -0.0042) :
      (!active ? F.edgeBiasX * 0.0032 + peekBiasX : 0);
    var tgtTeaseY = (hover && !F.squeezeActive && F.pnear > 0.35) ? (F.arousal > 0.4 ? -0.0038 : 0.0025) :
      (!active ? F.edgeBiasY * 0.0022 + peekBiasY : 0);
    F.teaseX += (tgtTeaseX - F.teaseX) * kf(4.5);
    F.teaseY += (tgtTeaseY - F.teaseY) * kf(4.5);
    // The hair follows the turned head with its own lag + gravity dangle while carried.
    hx += F.lookX - F.headAngle * 0.12; hy += F.lookY + F.chin + F.carryPull * 0.007;
    var sw = Math.sin(nowS * 1.1) * 0.0006, sw2 = Math.sin(nowS * 1.3 + 1.7) * 0.0006;
    var vxs = 0.05 * Math.tanh(bootyPhys.vx / 45), vys = 0.04 * Math.tanh(bootyPhys.vy / 60) - F.carryPull * 0.12;
    var aL = -60 * (F.hLx - hx) - 8.0 * F.hLvx - vxs;
    var bL = -60 * (F.hLy - hy) - 8.0 * F.hLvy - vys;
    var aR = -52 * (F.hRx - hx) - 7.5 * F.hRvx - vxs;
    var bR = -52 * (F.hRy - hy) - 7.5 * F.hRvy - vys;
    F.hLvx += aL * dt; F.hLvy += bL * dt; F.hLx += F.hLvx * dt; F.hLy += F.hLvy * dt;
    F.hRvx += aR * dt; F.hRvy += bR * dt; F.hRx += F.hRvx * dt; F.hRy += F.hRvy * dt;
    var cl = function (v) { return Math.max(-0.012, Math.min(0.012, v)); };
    F.oLx = cl((F.hLx - hx) * 0.7 + sw); F.oLy = cl((F.hLy - hy) * 0.7 + sw2 * 0.6);
    F.oRx = cl((F.hRx - hx) * 0.7 + sw2); F.oRy = cl((F.hRy - hy) * 0.7 + sw * 0.6);
    // lace trim: a softer, bouncier spring than the cheeks, so the trim flutters after the hips
    F.lvx += (-40 * (F.lcx - bootyPhys.x) - 3.0 * F.lvx) * dt; F.lcx += F.lvx * dt;
    F.lvy += (-40 * (F.lcy - bootyPhys.y) - 3.0 * F.lvy) * dt; F.lcy += F.lvy * dt;
    F.laceX = Math.tanh((F.lcx - bootyPhys.x) * 0.22) * 0.012;
    F.laceY = Math.tanh((F.lcy - bootyPhys.y) * 0.22) * 0.012;
    tailLink.flush = F.flush;
    tailLink.arousal = F.arousal;
    tailLink.pout = F.pout;
    tailLink.pet = F.pet;
    tailLink.heartPulse = F.heartPulse;
    tailLink.watchDir = nowS < F.watchControlUntil ? F.watchControlDir : 0;
    tailLink.carryPull = F.carryPull;
    return hover;
  }

  function resetFx() {
    var F = fxSt;
    F.effort = F.flush = F.tension = F.spankT = F.sheen = F.curl = F.curlPulse = 0;
    fxSt.braceUntil = fxSt.watchControlUntil = fxSt.watchControlDir = 0;
    fxSt.afterglow = fxSt.needy = fxSt.needySaidAt = fxSt.sulk = fxSt.shiver = fxSt.dizzy = fxSt.dizzyUntil = fxSt.carryPull = fxSt.sleepy = 0;
    fxSt.heartPh = fxSt.heartPulse = fxSt.arcStep = fxSt.arcLastAt = 0;
    fxSt.skipTimes = [];
    F.arousal = F.combo = F.lastStrikeAt = F.pet = F.pout = F.poutUntil = F.teaseHoverAt = F.teaseX = F.teaseY = F.nextPostSmileAt = 0;
    F.lastZone = ""; F.lastSide = 0; F.squeezeActive = false;
    F.sheenPh = 0;
    F.eyeX = F.eyeY = F.eyeS = 0;
    F.lookX = F.lookY = F.lid = 0; F.lcx = F.lcy = F.lvx = F.lvy = F.laceX = F.laceY = 0;
    F.lookFrom = F.lookUntil = F.glanceFrom = F.glanceUntil = 0;
    F.hLx = F.hLy = F.hLvx = F.hLvy = F.hRx = F.hRy = F.hRvx = F.hRvy = 0;
    F.oLx = F.oLy = F.oRx = F.oRy = 0;
    F.headAngle = F.shoulders = F.chin = F.smirk = 0;
    gesture.kind = "";
    gesture.at = 0;
    gesture.blinked = false;
    tailLink.flush = 0;
  }

  var lyricPlayback = { lecteur: null, musique: null };

  // A .lrc may carry the real title and artist ([ti:] / [ar:]); the filename is only the last resort.
  function parseLrcMeta(text) {
    var meta = { title: "", artist: "" };
    var body = String(text || "");
    var ti = body.match(/^\s*\[ti:\s*([^\]\r\n]{1,120})\s*\]/im);
    var ar = body.match(/^\s*\[ar:\s*([^\]\r\n]{1,120})\s*\]/im);
    if (ti) meta.title = ti[1].trim();
    if (ar) meta.artist = ar[1].trim();
    return meta;
  }

  function parseLrc(text) {
    var lines = new Map();
    var offsetTag = text.match(/^\s*\[offset:\s*([+-]?\d{1,7})\s*\]/im);
    var offset = offsetTag ? Number(offsetTag[1]) / 1000 : 0;
    text.split(/\r?\n/).forEach(function (line) {
      var tags = line.match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/);
      if (!tags) return;
      var words = line.slice(tags[0].length).replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "").trim();
      // Vowel groups give line-timed lyrics an approximate sequence of mouth shapes.
      var vowels = words.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .match(/[aeiouyœæ]+/g);
      if (!vowels && /\p{L}/u.test(words)) vowels = ["a"];
      for (var stamp of tags[0].matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
        var time = Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) +
          Number("0." + (stamp[3] || "0")) + offset);
        lines.set(time, vowels || []);
      }
    });
    return Array.from(lines, function (entry) {
      return { at: entry[0], vowels: entry[1] };
    }).sort(function (a, b) { return a.at - b.at; });
  }

  function lyricCue(play, time) {
    var lines = play.lines;
    var low = 0, high = lines.length;
    while (low < high) {
      var mid = (low + high) >>> 1;
      if (lines[mid].at <= time) low = mid + 1;
      else high = mid;
    }
    var line = lines[low - 1];
    if (!line || !line.vowels.length) return null;
    var length = Math.min(line.vowels.length * 0.52 + 0.25, low < lines.length ? lines[low].at - line.at : Infinity);
    var position = (time - line.at) / length * line.vowels.length;
    var vowel = line.vowels[Math.floor(position)];
    if (!vowel) return null;
    var phase = position % 1;
    var envelope = motionHold(phase, 0, 0.22, 0.64, 1);
    var rounded = /[ouœ]/.test(vowel);
    return { open: 0.04 + envelope * (/[aæ]/.test(vowel) ? 0.61 : 0.43), wide: rounded ? 0.52 : 0.91 };
  }

  function activeLyricTrack() {
    var track = lyricPlayback[document.body.dataset.view];
    if (!track || !track.audio) return null;
    var audio = track.audio;
    return audio.isConnected && !audio.hidden && audio.src === track.src ? track : null;
  }

  function bindLyricAudio(audio, studioTitle) {
    var label = document.createElement("label");
    label.textContent = "Paroles synchronisées (.lrc) ";
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".lrc";
    var feedback = document.createElement("span");
    feedback.setAttribute("role", "status");
    label.appendChild(input);
    label.appendChild(feedback);
    audio.after(label);
    var local = audio.id === "player-audio";
    var view = local ? "lecteur" : "musique";
    var track = null, request = 0, observedSource = audio.src;
    boundAudio[view] = audio;
    ["playing", "pause", "ended", "emptied"].forEach(function (name) {
      audio.addEventListener(name, function () { onLocalAudio(audio, name); });
    });
    var lookup = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = "Chercher dans LRCLIB";
    lookup.appendChild(summary);
    function lookupField(name) {
      var caption = document.createElement("label");
      caption.textContent = name + " ";
      var field = document.createElement("input");
      field.type = "text";
      field.maxLength = 200;
      caption.appendChild(field);
      lookup.appendChild(caption);
      return field;
    }
    var title = lookupField("Titre"), artist = lookupField("Artiste");
    var search = document.createElement("button");
    search.type = "button";
    search.textContent = "Charger les paroles";
    lookup.appendChild(search);
    label.after(lookup);
    function fillMetadata() {
      var name = local ? document.getElementById("player-name") : null;
      var parts = (name ? name.textContent.replace(/\.[^.]+$/, "") : studioTitle || "").split(" - ");
      artist.value = parts.length > 1 ? parts.shift() : "";
      title.value = parts.join(" - ");
    }
    fillMetadata();
    function select() {
      lyricPlayback[view] = track && track.src === audio.src ? track : null;
      if (local) syncAvailability();
      if (lyricPlayback[view]) ensureBootyRaf();
    }
    function resetSource() {
      label.hidden = audio.hidden || !audio.hasAttribute("src");
      lookup.hidden = label.hidden;
      if (!label.hidden && observedSource === audio.src) return;
      observedSource = audio.src;
      request += 1;
      var selected = track && lyricPlayback[view] === track;
      track = null;
      input.value = "";
      search.disabled = false;
      fillMetadata();
      feedback.textContent = "";
      if (selected) {
        lyricPlayback[view] = null;
        if (local) syncAvailability();
      }
    }
    audio.addEventListener("playing", select);
    if (local) {
      resetSource();
      new MutationObserver(resetSource).observe(audio, { attributes: true, attributeFilter: ["src", "hidden"] });
    }
    function stillCurrent(source, sequence) {
      return sequence === request && source === audio.src && audio.isConnected && !audio.hidden;
    }
    function useLyrics(lines, source, meta) {
      if (!lines.some(function (line) { return line.vowels.length; })) return false;
      track = { audio: audio, src: source, lines: lines, title: (meta && meta.title) || "", artist: (meta && meta.artist) || "" };
      var active = activeLyricTrack();
      if (!audio.paused || !active || active.audio === audio) select();
      feedback.textContent = " Paroles chargées.";
      return true;
    }
    search.addEventListener("click", async function () {
      var duration = Math.round(audio.duration);
      if (!title.value.trim() || !artist.value.trim()) {
        feedback.textContent = " Indique le titre et l’artiste.";
        return;
      }
      if (!Number.isFinite(duration) || duration < 1) {
        feedback.textContent = " Lance le morceau pour lire sa durée, puis réessaie.";
        return;
      }
      var source = audio.src, sequence = ++request;
      search.disabled = true;
      feedback.textContent = " Recherche dans LRCLIB…";
      try {
        var headers = { "Content-Type": "application/json" };
        if (typeof window.hqCsrfToken === "function") {
          var token = window.hqCsrfToken();
          if (token) headers["X-CSRF-Token"] = token;
        }
        var data = await window.api("/api/musica/lyrics", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ title: title.value.trim(), artist: artist.value.trim(), duration: duration })
        });
        if (stillCurrent(source, sequence) && !useLyrics(parseLrc(data.lrc || ""), source, { title: title.value.trim(), artist: artist.value.trim() })) {
          var message = "Aucune parole horodatée pour cette version.";
          var toast = window.hqToast || window.toast;
          if (typeof toast === "function") {
            feedback.textContent = "";
            toast(message, "tip");
          } else {
            feedback.textContent = " " + message;
          }
        }
      } catch (_) {
        if (stillCurrent(source, sequence)) feedback.textContent = " Recherche LRCLIB indisponible.";
      } finally {
        if (stillCurrent(source, sequence)) search.disabled = false;
      }
    });
    input.addEventListener("change", async function () {
      var file = input.files[0];
      if (!file) return;
      var source = audio.src, sequence = ++request;
      input.value = "";
      search.disabled = false;
      try {
        if (file.size > 256 * 1024) throw new Error();
        var text = await file.text();
        var lines = parseLrc(text);
        if (!stillCurrent(source, sequence)) return;
        if (!useLyrics(lines, source, parseLrcMeta(text))) throw new Error();
      } catch (_) {
        if (sequence === request && source === audio.src) feedback.textContent = " Fichier LRC illisible ou sans paroles horodatées.";
      }
    });
  }

  function stepMouth(dt, nowS, hovered, singing, gain, stretchAmt) {
    var M = mouthSt;
    var track = activeLyricTrack();
    var media = track && track.audio;
    var timed = media && !media.paused && !media.ended;
    var cue = timed && !media.seeking && media.readyState >= 3 ? lyricCue(track, media.currentTime) : null;
    var tOpen = 0, tSmile = 0.25, tWide = 0.85, tTongue = 0, want = 0;
    if (M.gasp > 0) M.gasp = Math.max(0, M.gasp - dt);
    if (M.happy > 0) M.happy = Math.max(0, M.happy - dt);
    if (M.flustered > 0 && M.gasp <= 0) M.flustered = Math.max(0, M.flustered - dt);
    if (!M.nextBlep) M.nextBlep = nowS + 10 + Math.random() * 12;
    if (nowS >= M.nextBlep) {
      M.blepUntil = nowS + 1.4;
      M.nextBlep = nowS + 14 + Math.random() * 16;
    }
    var talking = nowS < M.talkUntil;
    M.talkBurst *= Math.exp(-dt * 14);
    M.talkAccent *= Math.exp(-dt * 10);
    if (talking) {
      M.talkPh += dt * (8 + 3 * Math.sin(nowS * 1.7));
      var syl = Math.abs(Math.sin(M.talkPh)) * (0.55 + 0.45 * Math.abs(Math.sin(M.talkPh * 0.37)));
      var burst = Math.max(syl, M.talkBurst);
      tOpen = 0.14 + 0.58 * burst; tSmile = 0.18 + 0.12 * M.talkAccent; tWide = 0.84 - 0.24 * burst; want = 1;
    } else if (fxSt.idleHabit === "hum") {
      tOpen = 0.11 + 0.09 * (0.5 + 0.5 * Math.sin(nowS * 7.5)); tSmile = 0.42; tWide = 0.68; want = 0.85;
    } else if (singing && !track) {
      var beat = 0.5 + 0.5 * Math.sin(bootyPhys.twerkPhase - 0.4);
      tOpen = 0.10 + 0.50 * beat * gain; tSmile = 0.5; tWide = 0.95 - 0.30 * beat * gain; want = 0.9 * gain;
    }
    if (cue && !talking) {
      tOpen = cue.open; tWide = cue.wide; want = 1;
    } else if (!(timed && talking)) {
      if (hovered) { tSmile = Math.max(tSmile, 0.65); tOpen = Math.max(tOpen, 0.10); want = Math.max(want, 0.8); }
      if (stretchAmt > 0.05) { tOpen = Math.max(tOpen, 0.24 * stretchAmt); tWide = 0.72; want = 1; }
      if (bootyPhys.coil > 0.3 && M.gasp <= 0) { tOpen = Math.max(tOpen, 0.20); tWide = 0.70; want = 1; }
      if (nowS < fxSt.lookUntil && M.gasp <= 0) { tSmile = Math.max(tSmile, 0.6); want = Math.max(want, 0.7); }
      if (M.gasp > 0) { tOpen = 0.9; tWide = 0.5; tSmile = -0.15; want = 1; }
      else if (fxSt.pout > 0.15) { tSmile = -0.35; tOpen = 0.04; tWide = 0.72; want = 0.85; }
      else if (M.flustered > 0 || fxSt.arousal > 0.55) {
        var ar = fxSt.arousal;
        tSmile = 0.42 + 0.16 * ar;
        tOpen = Math.max(0.13 + 0.10 * ar + 0.05 * Math.sin(nowS * 9), 0);
        tWide = 0.60; want = 1;
      }
      else if (fxSt.pet > 0.25) { tSmile = Math.max(tSmile, 0.82); tOpen = Math.max(tOpen, 0.05); want = 1; }
      else if (M.happy > 0) { tSmile = 0.85; tOpen = Math.max(tOpen * 0.5, 0.06); want = 1; }
      if (nowS >= fxSt.lookUntil && nowS < M.blepUntil && M.gasp <= 0) { tTongue = 1; tOpen = Math.max(tOpen, 0.12); tSmile = 0.75; tWide = 0.85; want = 1; }
      if (gesture.kind === "smile" && Math.abs(fxSt.smirk) > 0.02 && M.gasp <= 0) {
        tSmile = Math.max(tSmile, 0.56);
        tOpen *= 0.42; tTongue = 0; want = 1;
      }
    }
    var kf = function (rate) { return 1 - Math.exp(-dt * rate); };
    M.open += (tOpen - M.open) * kf(16);
    M.smile += (tSmile - M.smile) * kf(9);
    M.wide += (tWide - M.wide) * kf(11);
    M.tongue += (tTongue - M.tongue) * kf(12);
    M.str += (want - M.str) * kf(9);
    M.wobPh += dt * 2.2;
    M.wobAmp = 0.12 * (1 - Math.min(1, M.open * 2));
  }

  function motionHold(time, start, peak, release, end) {
    var t = time < peak ? (time - start) / (peak - start) : (end - Math.max(time, release)) / (end - release);
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  }

  function motionPulse(time, start, peak, end) {
    return motionHold(time, start, peak, peak, end);
  }

  var DROP_HITS = {
    single: [{ side: 0, power: 1, impact: 0.115, end: 0.31 }],
    triple: [{ side: 1, power: 0.76, impact: 0.095, end: 0.22 },
      { side: -1, power: 0.76, impact: 0.095, end: 0.22 },
      { side: 0, power: 1.15, impact: 0.115, end: 0.31, effect: "hip-finale" }],
    fakeout: [{ side: 1, power: 0.35, impact: 0.08, end: 0.16, count: 1 },
      { side: -1, power: 1.18, impact: 0.115, end: 0.31, effect: "hip-arc", count: 1 }],
    ripple: [{ side: 1, power: 0.90, impact: 0.115, end: 0.31 }],
    double: [{ side: 1, power: 0.61, impact: 0.065, end: 0.145, count: 1 },
      { side: 1, power: 0.76, impact: 0.065, end: 0.155, count: 1 }]
  };
  var ROLL_TRAIL_START = 0.31, ROLL_TRAIL_END = 0.83;
  var RIPPLE_TIP_DELAY = 0.61;

  var FIG8_CUT = 4, FIG8_LAND = 4.24, FIG8_REVERSE = 5.24, FIG8_END = 9.24;

  // Couple soft glute mass to a moving hip anchor with viscoelastic damping, gentle downward-sag
  // looseness, weak cross-cleft pull from the opposite cheek, and volume-preserving outward flare.
  function stepCheekSpring(st, posX, velX, posY, velY, ax, ay, kBase, damp, otherRelX, otherRelY, h) {
    var dx = st[posX] - ax, dy = st[posY] - ay;
    var r2 = Math.min(140, dx * dx + dy * dy);
    // Downward sag (+dy) stretches slightly looser than upward lift (-dy) for heavy flesh drop.
    var ky = dy > 0 ? kBase * 0.88 : kBase * 1.04;
    var hard = 1 + 0.018 * r2;
    var cross = 16;
    st[velX] += (-kBase * hard * dx + cross * (otherRelX - dx) - damp * st[velX]) * h;
    st[velY] += (-ky * hard * dy + cross * 0.45 * (otherRelY - dy) - damp * 0.94 * st[velY]) * h;
    st[posX] += st[velX] * h;
    st[posY] += st[velY] * h;
  }

  function finishCheekOutput(relX, relY, hipLagX, hipLagY, side, gain, reach) {
    // Downward soft-tissue sag/impact pushes flesh outward away from the midline cleft (-/+ side).
    var flareX = side * (Math.max(0, relY) * 0.34 - Math.max(0, -relY) * 0.14);
    return [
      Math.tanh((relX + hipLagX + flareX) * gain) * reach,
      Math.tanh((relY + hipLagY) * gain) * reach
    ];
  }

  function triggerFleshWave(amp, withRipple) {
    if (amp <= 0) return;
    if (amp > bootyPhys.wave || bootyPhys.waveT > 0.14) {
      bootyPhys.wave = Math.min(1.35, Math.max(bootyPhys.wave * 0.55, amp));
      bootyPhys.waveT = 0;
    }
    if (withRipple && (amp > bootyPhys.ripple || bootyPhys.rippleTime > 0.12)) {
      bootyPhys.ripple = Math.min(1.15, Math.max(bootyPhys.ripple * 0.45, amp));
      bootyPhys.rippleTime = 0;
    }
  }

  function triggerHitFreeze(durationSec, impulse, nowS) {
    if (durationSec <= 0 || bootyPhys.freezeT > 0.02 || (nowS - bootyPhys.lastFreezeAt) < 2.4) return;
    bootyPhys.freezeT = durationSec;
    bootyPhys.lastFreezeAt = nowS;
    // Brief pelvic lock lets the cheeks carry through smoothly on their own spring inertia.
    triggerFleshWave(Math.min(0.85, 0.45 * (impulse || 1)), false);
  }

  function stepBooty(ts) {
    bootyPhys.raf = 0;
    if (!motionReady()) return;
    // Draw the body and its attachments together, at up to 60 fps (30 when calm).
    var elapsed = ts - bootyPhys.lastTs;
    if (bootyPhys.lastTs && elapsed < (bootyPhys.calm ? 1000 / 30 : 1000 / 60) - 0.25) {
      bootyPhys.raf = window.requestAnimationFrame(stepBooty);
      return;
    }
    var dt = bootyPhys.lastTs ? Math.min(0.04, elapsed / 1000) : 0.016;
    bootyPhys.lastTs = ts;
    var nowP = ts / 1000;
    if ((playback.playing || drag || pinching) && (gesture.kind === "curl" || gesture.kind === "stretch")) gesture.kind = "";
    // Keep the identity clock real: stability is measured from when she first saw this song, not from the first
    // time she wanted to talk. One read a second is enough and keeps the visible "elle écoute" label current.
    if (!songSeenAt || ts - songSeenAt >= 1000) { songSeenAt = ts; currentSong(); refreshConceal(); }
    flushSpeech();
    stepGesture(nowP, dt);
    var k = 220;   // snappy jiggle frequency
    var d = 5.2;   // natural multi-bounce wobble without over-stretching
    var ax = 0, ay = 0;   // driving forces; the springs are added per substep below
    var localEl = localAudio();
    var playing = (onMusiquePage() && playback.playing) || !!localEl;
    var activeMusic = playing && available && !drag && !pinching && gesture.kind !== "listen";
    syncBeatKey(localEl);
    var songT = songTime(localEl);
    var heard = activeMusic && localEl ? hearStep(localEl, songT) : false;
    var intensity = localEl ? hear.intensity : (Number.isFinite(playback.intensity) ? playback.intensity : 0.78);
    var vol = localEl ? (localEl.muted ? 0.18 : Math.max(0.18, Math.min(1.18, 0.25 + localEl.volume * 0.93)))
      : (Number.isFinite(playback.volume) ? playback.volume : 1.0);
    var crossed = activeMusic ? Beat.stepClock(beatClock, dt, songT) : 0;
    var beatSec = beatClock.beatSec;
    var beatsNow = beatClock.beats;
    var gridDrops = !!(beatGrid && Array.isArray(beatGrid.drops) && beatGrid.drops.length);
    if (beatClock.snapped) {
      // A seek or a fresh lock moved the count: restart the phrase on the next bar of the new count.
      bootyPhys.phUntil = Beat.nextBar(beatsNow, 4);
      bootyPhys.dropTimer = 0;
      updateBeatCss(true);
    }
    if (crossed) {
      var beatIndex = Math.floor(beatsNow);
      updateBeatCss(beatIndex % 8 === 0);   // re-seat the halo bars on the clock every two bars
      onHaloBeat(beatIndex);
    }
    var dancing = danceWrap.classList.contains("is-dancing");
    var poseAvailable = !dancing && !danceWrap.classList.contains("is-react");
    var twBefore = bootyPhys.twerkGain;
    var wasPlaying = bootyPhys.prevPlaying;
    var targetTwerk = activeMusic ? 1 : 0;
    if (bootyPhys.twerkGain < targetTwerk) {
      bootyPhys.twerkGain = Math.min(targetTwerk, bootyPhys.twerkGain + dt * 2.2);
    } else if (bootyPhys.twerkGain > targetTwerk) {
      bootyPhys.twerkGain = Math.max(targetTwerk, bootyPhys.twerkGain - dt * (playing ? 4 : 5.5));
    }
    // Anticipation: before the dance (or a drop) she coils, then releases; when it stops she overshoots and settles.
    if (playing && !wasPlaying) {
      bootyPhys.settleUntil = 0;
      bootyPhys.freezeT = 0;
      bootyPhys.freezeEnv = 0;
      bootyPhys.lastDoubleBar = -1;
      bootyPhys.nextAccentCombo = "ripple";
      bootyPhys.fig8Beat = 0;
      bootyPhys.fig8Direction = 1;
      if (activeMusic) {
        bootyPhys.coilT = 0.20;
        bootyPhys.coilKind = "start";
      }
      bootyPhys.danceSince = ts / 1000;
      if (danceGenLeft() < 6) danceGenFetch(false);
      bootyPhys.phKind = 0; bootyPhys.phCount = 0; bootyPhys.phUntil = Beat.nextBar(beatsNow, 5);
    }
    bootyPhys.prevPlaying = playing;
    var accent = 0;
    var finishedRoll = false;
    if (!playing && wasPlaying) {
      bootyPhys.settleUntil = ts / 1000 + 0.55;
      bootyPhys.freezeT = 0;
      if (!drag && !pinching && bootyPhys.coilT === 0 && twBefore * bootyPhys.phAmp > 0.45) {
        bootyPhys.vy += 10;
        accent = -0.45;
        if (ts / 1000 - bootyPhys.danceSince > 8) danceSay("end", 0.7);
      }
      bootyPhys.phKind = 0; bootyPhys.phUntil = 0; bootyPhys.beatWraps = 0;
      bootyPhys.holdSide = 0;
      fxSt.lookUntil = fxSt.glanceFrom = fxSt.glanceUntil = 0;
    }
    if (bootyPhys.twerkGain > 0.005) {
      // Normal, slow roll, burst, look-back tease, figure eight, or asymmetric cheek isolations.
      var slow = bootyPhys.phKind === 1;
      var lookDue = bootyPhys.phKind !== 3 && (bootyPhys.phCount + 1) % 3 === 0;
      // Phrases change on bar lines of the shared clock; phUntil is a beat count, not a time.
      if (activeMusic && poseAvailable && beatsNow >= bootyPhys.phUntil && bootyPhys.dropAge < 0 && bootyPhys.coilT === 0) {
        if (slow && !bootyPhys.holdSide) {
          bootyPhys.holdSide = bootyPhys.rollSide;
          bootyPhys.phUntil = beatsNow + 0.5;
          startLook(nowP, nowP + beatSec * 0.5, bootyPhys.holdSide);
        } else {
          var wasLook = bootyPhys.phKind === 3;
          var heldSide = bootyPhys.holdSide;
          bootyPhys.holdSide = 0;
          if (heldSide) {
            bootyPhys.vx -= heldSide * 12 * vol;
            finishedRoll = true;
          } else if (wasLook) {
            bootyPhys.vy -= 14 * vol;
            triggerFleshWave(0.54 * vol, false);
          }
          bootyPhys.rollSide *= -1;
          bootyPhys.phCount += 1;
          var rr = Math.random(), hi = intensity >= 0.76;
          if (heldSide) {
            bootyPhys.phKind = 0; bootyPhys.phUntil = Beat.nextBar(beatsNow, 4 + Math.random() * 4);
          } else if (lookDue && bootyPhys.twerkGain > 0.8) {
            bootyPhys.phKind = 3; bootyPhys.phUntil = Math.ceil(beatsNow / 2 - 1e-6) * 2 + 4;
            startLook(nowP, nowP + (bootyPhys.phUntil - beatsNow) * beatSec);
            danceSay("look", 0.7);
          } else if (bootyPhys.phCount % 4 === 1 && intensity >= 0.58 && intensity < 0.98 &&
              bootyPhys.dropTimer <= 0) {
            bootyPhys.phKind = 4;
            bootyPhys.phUntil = Beat.nextBar(beatsNow, 8);
            bootyPhys.fig8Beat = 0;
          } else if (rr < (hi ? 0.34 : 0.22) && bootyPhys.phKind !== 2) {
            bootyPhys.phKind = 2; bootyPhys.phUntil = Beat.nextBar(beatsNow, 3 + Math.random() * 4);
            danceSay("fast", 0.5);
          } else if (rr < (hi ? 0.62 : 0.46) && bootyPhys.phKind !== 5) {
            bootyPhys.phKind = 5; bootyPhys.phUntil = Beat.nextBar(beatsNow, 4 + Math.random() * 3);
          } else if (rr < 0.80 && bootyPhys.phKind !== 1) {
            bootyPhys.phKind = 1; bootyPhys.phUntil = Beat.nextBar(beatsNow, 4 + Math.random() * 4);
            danceSay("slow", 0.5);
          } else {
            bootyPhys.phKind = 0; bootyPhys.phUntil = Beat.nextBar(beatsNow, 4 + Math.random() * 5);
          }
        }
      }
      // Half time, normal, or double time when the beat is slow enough for it to read: always whole multiples.
      var phRateT = (bootyPhys.phKind === 1 || bootyPhys.phKind === 3) ? 0.5 : (bootyPhys.phKind === 2 && beatSec >= 0.6 ? 2 : 1);
      bootyPhys.phRate += (phRateT - bootyPhys.phRate) * Math.min(1, dt * 4);
      var prevPhase = bootyPhys.twerkPhase;
      if (activeMusic && !bootyPhys.holdSide && bootyPhys.coilT === 0 && bootyPhys.dropAge < 0) {
        bootyPhys.twerkPhase = (prevPhase + dt * ((2 * Math.PI) / beatSec) * bootyPhys.phRate) % (Math.PI * 4);
        if (Math.abs(bootyPhys.phRate - phRateT) < 0.03) {
          // Phase-lock the bounce to the shared clock, never more than a third faster or slower than the beat.
          var perr = Beat.phaseError(bootyPhys.twerkPhase - BOUNCE_LEAD, beatsNow, phRateT);
          var maxCorr = dt * (2 * Math.PI / beatSec) * 0.35;
          bootyPhys.twerkPhase += Math.max(-maxCorr, Math.min(maxCorr, perr * Math.min(1, dt * 5)));
          bootyPhys.twerkPhase = ((bootyPhys.twerkPhase % (Math.PI * 4)) + Math.PI * 4) % (Math.PI * 4);
        }
      }
      if (Math.floor(prevPhase / (Math.PI * 2)) !== Math.floor(bootyPhys.twerkPhase / (Math.PI * 2))) {
        bootyPhys.beatWraps += 1;
        tailLink.beat += 1;
        if (bootyPhys.twerkGain > 0.5) {
          triggerFleshWave((0.24 + intensity * 0.16) * vol, false);
        }
      }
      if (activeMusic) {
        var beatNear = Math.round(beatsNow);
        var beatInBar = ((beatNear % 4) + 4) % 4;
        // Every 8 bars of a lively track with no known drops, arm one; it fires so the hit lands on a bar line.
        if (crossed && !gridDrops && !heard && intensity >= 0.68 && bootyPhys.phKind !== 4 && bootyPhys.dropTimer <= 0 &&
            ((Math.floor(beatsNow) % 32) + 32) % 32 === 28) {
          bootyPhys.dropTimer = beatSec * 4.5;
        }
        // Accents: on the onsets she hears when she can hear them, else weighted to the downbeat and the backbeat.
        var popNow = false;
        if (heard) {
          var nearBeat = Math.abs(beatsNow - beatNear) < 0.15;
          popNow = hear.onset > 0.35 && nearBeat && Math.random() < 0.35 + hear.onset * 0.5;
        } else if (crossed) {
          popNow = Math.random() < (beatInBar === 0 ? 0.5 : (beatInBar === 2 ? 0.35 : 0.12)) * (0.6 + intensity * 0.4);
        }
        if (popNow && beatNear !== bootyPhys.lastPopBeat && bootyPhys.phKind !== 1 && bootyPhys.phKind !== 3 &&
            bootyPhys.phKind !== 4 && intensity >= 0.62 && bootyPhys.dropTimer <= 0 && bootyPhys.dropGain < 0.5) {
          bootyPhys.lastPopBeat = beatNear;
          var pop = (0.75 + intensity * 0.55) * vol * (dancing ? 1.25 : 1.0) * (beatInBar === 0 ? 1.15 : 1);
          bootyPhys.vy -= (30 + Math.random() * 18) * pop;
          bootyPhys.vx += (Math.random() < 0.5 ? 1 : -1) * (16 + Math.random() * 12) * pop;
          triggerFleshWave(0.42 * pop, false);
          if ((beatInBar === 1 || beatInBar === 3) && intensity >= 0.76 && Math.random() < 0.18) {
            triggerHitFreeze(Math.min(0.18, beatSec * 0.34), pop, nowP);
          }
        }
      }
    }

    var hardHold = bootyPhys.holdSide !== 0;
    var lookHold = bootyPhys.phKind === 3;
    if (!activeMusic || hardHold || !poseAvailable || bootyPhys.dropAge >= 0) bootyPhys.freezeT = 0;
    else if (bootyPhys.freezeT > 0) bootyPhys.freezeT = Math.max(0, bootyPhys.freezeT - dt);
    bootyPhys.freezeEnv += ((bootyPhys.freezeT > 0 ? 1 : 0) - bootyPhys.freezeEnv) * Math.min(1, dt * 26);
    var pelvisFreezeMul = 1 - 0.88 * bootyPhys.freezeEnv;
    var phAmpT = hardHold ? 0 : (bootyPhys.phKind === 1 ? 1.12 : (lookHold ? 0.64 : 1));
    if (activeMusic || bootyPhys.twerkGain === 0) {
      bootyPhys.phAmp += (phAmpT - bootyPhys.phAmp) * (1 - Math.exp(-dt * (hardHold ? 12 : 6)));
    }
    var danceGain = bootyPhys.twerkGain * bootyPhys.phAmp;
    // Evaluate two copies of the roll 75 ms apart. Blend the lead when the phrase changes.
    var phase = bootyPhys.twerkPhase;
    var hipLag = (2 * Math.PI / beatSec) * bootyPhys.phRate * 0.075;
    bootyPhys.rollLead += (bootyPhys.rollSide - bootyPhys.rollLead) * (1 - Math.exp(-dt * 14));
    bootyPhys.slowRoll += ((bootyPhys.phKind === 1 ? 1 : (lookHold ? 0.78 : 0)) - bootyPhys.slowRoll) * (1 - Math.exp(-dt * 10));
    bootyPhys.isoWeight += ((bootyPhys.phKind === 5 ? 1 : 0) - bootyPhys.isoWeight) * (1 - Math.exp(-dt * 10));
    var leftLag = hipLag * (0.5 - 0.5 * bootyPhys.rollLead);
    var rightLag = hipLag * (0.5 + 0.5 * bootyPhys.rollLead);
    var isoSide = ((Math.floor(beatsNow / 2) % 2) === 0 ? 1 : -1) * bootyPhys.rollSide;
    var isoPlant = activeMusic && bootyPhys.phKind === 5 ? isoSide * 0.42 * bootyPhys.isoWeight : 0;
    var plant = activeMusic ? (bootyPhys.holdSide || isoPlant) : 0;
    bootyPhys.hipWeight += (plant - bootyPhys.hipWeight) * (1 - Math.exp(-dt * 20));
    // Settle quickly into the hold/freeze and after the stop while keeping cheeks free.
    var settling = hardHold ? 12 : (bootyPhys.freezeEnv > 0.1 ? 10 * bootyPhys.freezeEnv : (ts / 1000 < bootyPhys.settleUntil ? 8 : 0));

    if (bootyPhys.dropTimer > 0 && activeMusic && bootyPhys.phKind !== 1) {
      bootyPhys.dropTimer = Math.max(0, bootyPhys.dropTimer - dt);
    } else if (!activeMusic) {
      bootyPhys.dropTimer = 0;
    }
    // A drop's first hit lands one coil (0.42 beat) plus 0.115 s after it starts: start it that far before the target.
    var dropLead = beatSec * 0.42 + 0.115;
    var toBarSec = Beat.toBar(beatsNow) * beatSec;
    var barDue = toBarSec <= dropLead + 0.02 && toBarSec > dropLead - 0.06;
    // Real drops first: the stored grid's, then the ones she hears; the song-position guess is the last resort.
    var gridDue = false;
    if (activeMusic && gridDrops && Number.isFinite(songT)) {
      for (var gd = 0; gd < beatGrid.drops.length; gd += 1) {
        var dropIn = beatGrid.drops[gd] - songT;
        if (dropIn <= dropLead + 0.02 && dropIn > dropLead - 0.08 && beatGrid.drops[gd] !== bootyPhys.lastGridDrop) {
          gridDue = true;
          bootyPhys.lastGridDropPending = beatGrid.drops[gd];
          break;
        }
      }
    }
    var liveDrop = heard && hear.drop && !gridDrops;
    var progDrop = false, progWin = 0;
    var songMs = localEl ? localEl.duration * 1000 : playback.durationMs;
    if (activeMusic && !gridDrops && !heard && intensity >= 0.70 && songMs > 30000 && Number.isFinite(songT)) {
      var frac = songT * 1000 / songMs;
      progWin = frac >= 0.25 && frac <= 0.32 ? 1 : (frac >= 0.53 && frac <= 0.61 ? 2 : (frac >= 0.79 && frac <= 0.86 ? 3 : 0));
      progDrop = progWin > 0 && progWin !== bootyPhys.progWinDone && barDue;
    }
    var realDrop = gridDue || liveDrop;
    var wantDrop = activeMusic && (finishedRoll || (bootyPhys.dropTimer > 0 && barDue) || progDrop || realDrop);
    if (!wantDrop) bootyPhys.prevDrop = false;
    if (!activeMusic || hardHold) {
      if (bootyPhys.coilT > 0 && bootyPhys.coilKind === "drop") bootyPhys.prevDrop = false;
      bootyPhys.coilT = 0;
    }
    if (wantDrop && poseAvailable && !hardHold && (realDrop || (bootyPhys.phKind !== 1 && bootyPhys.phKind !== 3 && bootyPhys.phKind !== 4)) &&
        (!bootyPhys.prevDrop || finishedRoll) && bootyPhys.coilT === 0 && bootyPhys.dropAge < 0) {
      bootyPhys.coilKind = "drop";
      bootyPhys.coilT = beatSec * 0.42;
      bootyPhys.prevDrop = true;
      bootyPhys.dropTimer = 0;
      if (progDrop) bootyPhys.progWinDone = progWin;
      if (gridDue) bootyPhys.lastGridDrop = bootyPhys.lastGridDropPending;
      bootyPhys.comboSide = finishedRoll ? -bootyPhys.rollSide : bootyPhys.rollSide;
      if (finishedRoll) {
        bootyPhys.comboKind = "fakeout";
        bootyPhys.comboGap = beatSec * 0.5 + 0.08 - 0.115;
      } else if (intensity >= 0.98) {
        bootyPhys.comboKind = "triple";
        bootyPhys.comboGap = Math.max(0.23, Math.min(0.32, beatSec * 0.56));
      } else if (intensity >= 0.84) {
        bootyPhys.comboKind = bootyPhys.nextAccentCombo;
        bootyPhys.nextAccentCombo = bootyPhys.comboKind === "ripple" ? "double" : "ripple";
        bootyPhys.comboGap = bootyPhys.comboKind === "double" ? 0.17 : 0;
      } else {
        bootyPhys.comboKind = "single";
        bootyPhys.comboGap = 0;
      }
    }
    if (bootyPhys.coilT > 0) {
      bootyPhys.coilT = Math.max(0, bootyPhys.coilT - dt);
      if (bootyPhys.coilT === 0) {
        if (bootyPhys.coilKind === "drop") {
          bootyPhys.dropAge = 0;
          bootyPhys.comboCancelAt = -1;
        } else {
          accent = 0.4;
          bootyPhys.vy -= 22;
          if (bodySfx.ctx) bodySfx.breath(0.7);
          danceSay("start", 0.9);
        }
      }
    }
    bootyPhys.coil += ((bootyPhys.coilT > 0 ? 1 : 0) - bootyPhys.coil) * Math.min(1, dt * 16);
    var dropLanding = 0, dropRebound = 0, dropSide = 0, comboHit = null;
    var comboKind = bootyPhys.comboKind, comboSide = bootyPhys.comboSide;
    var crestX = 0, crestStrength = 0, tipFlick = 0, trail = -1;
    if (bootyPhys.dropAge >= 0) {
      var priorAge = bootyPhys.dropAge;
      var age = bootyPhys.dropAge += dt;
      var gap = bootyPhys.comboGap;
      if (comboKind !== "single" && (!activeMusic || !poseAvailable) && bootyPhys.comboCancelAt < 0) bootyPhys.comboCancelAt = priorAge;
      var cancelled = bootyPhys.comboCancelAt >= 0;
      var sampleAge = cancelled ? bootyPhys.comboCancelAt : age;
      var fade = cancelled ? Math.max(0, 1 - (age - sampleAge) / 0.12) : 1;
      var hits = DROP_HITS[comboKind];
      for (var hit = 0; hit < hits.length; hit += 1) {
        var move = hits[hit];
        var offset = hit * gap;
        var elapsedHit = sampleAge - offset;
        var impact = move.impact, power = move.power;
        var landing = motionPulse(elapsedHit, 0, impact, move.end);
        dropLanding += landing * 0.023 * vol * power * fade;
        var rebound = move.end - impact;
        dropRebound -= motionPulse(elapsedHit, impact + rebound * 0.28, impact + rebound * 0.80,
          move.end + rebound * 0.55) * 0.010 * vol * power * fade;
        dropSide += landing * move.side * comboSide * power * fade;
        if (activeMusic && !cancelled && priorAge < offset + impact && age >= offset + impact) {
          accent = Math.min(1, vol * power);
          triggerFleshWave(Math.min(1.1, 0.85 * vol * power), true);
          if (comboKind !== "single") comboHit = move;
          else spawnFx("\u2726", 4);
          if (hit === 0) {
            if (bodySfx.ctx) bodySfx.breath(0.7);
            danceSay("drop", 0.8);
          }
        }
      }
      var dropEnd = (hits.length - 1) * gap + 0.44;
      if (comboKind === "ripple") {
        var travel = Math.max(0, Math.min(1, (sampleAge - 0.17) / 0.39));
        crestX = comboSide > 0 ? 667 - 242 * travel : 425 + 242 * travel;
        crestStrength = motionHold(sampleAge, 0.16, 0.23, 0.5, RIPPLE_TIP_DELAY) * fade;
        if (!cancelled && priorAge < RIPPLE_TIP_DELAY && age >= RIPPLE_TIP_DELAY) tipFlick = -comboSide * 2.7;
        dropEnd = 0.81;
      } else if (comboKind === "double") {
        var roll = Math.max(0, Math.min(1, (sampleAge - ROLL_TRAIL_START) / (ROLL_TRAIL_END - ROLL_TRAIL_START)));
        var rollWeight = motionHold(sampleAge, 0.20, 0.38, 0.68, 0.97);
        dropSide += comboSide * Math.cos(Math.PI * roll) * rollWeight * fade;
        dropLanding += Math.sin(Math.PI * roll) * rollWeight * 0.012 * vol * fade;
        for (var mote = 0; !cancelled && mote < 3; mote += 1) {
          var mark = ROLL_TRAIL_START + (ROLL_TRAIL_END - ROLL_TRAIL_START) * (0.15 + mote * 0.31);
          if (priorAge < mark && age >= mark) trail = roll;
        }
        dropEnd = 0.97;
      }
      if (fade === 0 || age >= dropEnd) bootyPhys.dropAge = -1;
    }
    var targetDrop = bootyPhys.dropAge >= 0 ? 1 : 0;
    if (bootyPhys.dropGain < targetDrop) {
      bootyPhys.dropGain = Math.min(targetDrop, bootyPhys.dropGain + dt * 3.4);
    } else if (bootyPhys.dropGain > targetDrop) {
      bootyPhys.dropGain = Math.max(targetDrop, bootyPhys.dropGain - dt * 2.2);
    }
    var wantFig8 = activeMusic && poseAvailable && !hardHold && !gesture.kind &&
      bootyPhys.coilT === 0 && bootyPhys.dropAge < 0 && bootyPhys.dropGain < 0.1 &&
      (bootyPhys.phKind === 4 || (!lookHold && bootyPhys.phKind !== 1 && bootyPhys.phKind !== 5 && intensity < 0.65));
    var fig8Target = wantFig8 ? 1 : 0;
    bootyPhys.fig8Gain += (fig8Target - bootyPhys.fig8Gain) * (1 - Math.exp(-dt * 11));
    var fig8Gain = bootyPhys.fig8Gain * vol;
    var figBeat = bootyPhys.fig8Beat;
    if (wantFig8) {
      var priorFigBeat = figBeat;
      figBeat += dt / beatSec;
      if (priorFigBeat < 4.56 && figBeat >= 4.56) tipFlick -= bootyPhys.fig8Direction * 0.85;
      if (figBeat >= FIG8_END) {
        figBeat -= FIG8_END;
        bootyPhys.fig8Direction *= -1;
      }
      bootyPhys.fig8Beat = figBeat;
    }
    var figLoop = figBeat < FIG8_CUT ? figBeat : Math.max(0, figBeat - FIG8_REVERSE);
    var figDirection = bootyPhys.fig8Direction * (figBeat < FIG8_REVERSE ? 1 : -1);
    var figAng = figDirection * figLoop * Math.PI / 2;
    var figPlant = motionHold(figBeat, FIG8_CUT, FIG8_LAND, FIG8_REVERSE, FIG8_REVERSE + 0.46);
    var figX = fig8Gain * (0.044 * Math.sin(figAng) + 0.046 * figPlant * bootyPhys.fig8Direction);
    var figY = fig8Gain * (0.021 * Math.sin(figAng * 2) + 0.020 * figPlant);
    if (wantFig8 && figPlant > 0) {
      crestX = bootyPhys.fig8Direction > 0 ? 630 : 460;
      crestStrength = motionPulse(figBeat, FIG8_CUT + 0.10, FIG8_LAND, FIG8_LAND + 0.34) * Math.min(1, fig8Gain);
    }
    // Loudness against the track's own average: what she hears, else the stored curve, else flat.
    var energyRel = heard && hear.tracker.meanN > 60 ? hear.rel :
      (beatGrid && Array.isArray(beatGrid.energy) && Number.isFinite(songT) ? Beat.curveRel(beatGrid.energy, beatGrid.energy_step, songT) : 1);
    var energyT = activeMusic ? Math.max(0.6, Math.min(1.45, 0.55 + 0.45 * energyRel)) : 1;
    bootyPhys.energyMul += (energyT - bootyPhys.energyMul) * (1 - Math.exp(-dt * 3));
    var groove = (0.65 + intensity * 0.65) * vol * bootyPhys.energyMul * (dancing ? 1.25 : 1.0) * danceGain *
      (1 - fxSt.sulk * 0.45) * (1 - 0.94 * bootyPhys.coil) * (1 - 0.9 * bootyPhys.dropGain) * (1 - bootyPhys.fig8Gain);
    // Upward pelvic pop (-y in top-down UV) snaps cleanly; downward drop settles heavier without twitching.
    var sPh = Math.sin(phase);
    var snapWave = sPh < 0 ? -Math.pow(-sPh, 0.85) : Math.pow(sPh, 1.12);
    var bounceWave = snapWave * 0.76 + Math.sin(phase * 2 - 0.35) * 0.28;
    var swayWave = Math.cos(phase * 0.5);
    var barBeat = ((beatsNow % 4) + 4) % 4;
    var barCycle = Math.floor(beatsNow / 4);
    var isoScale = 1 - 0.58 * bootyPhys.isoWeight;
    ay += bounceWave * 520 * groove * pelvisFreezeMul * isoScale * (1 - 0.62 * bootyPhys.slowRoll);
    ax += swayWave * 280 * groove * pelvisFreezeMul;
    ax += 390 * bootyPhys.hipWeight * vol;

    // Intra-bar "liquid grind -> double-pop": lively phrases throw a quick twin pop before bar 1.
    var doublePopDrive = 0;
    if (activeMusic && danceGain > 0.4 && bootyPhys.dropAge < 0 && bootyPhys.coilT === 0 &&
        (bootyPhys.phKind === 0 || bootyPhys.phKind === 5) && intensity >= 0.52 &&
        (barCycle % 2 === 1) && barBeat > 3.25) {
      var dp1 = (barBeat - 3.50) / 0.10, dp2 = (barBeat - 3.85) / 0.095;
      doublePopDrive = (Math.exp(-dp1 * dp1) - 1.15 * Math.exp(-dp2 * dp2)) * vol * (0.75 + 0.45 * intensity);
      ay += doublePopDrive * 460 * pelvisFreezeMul * danceGain;
      if (barBeat >= 3.50 && bootyPhys.lastDoubleBar !== barCycle) {
        bootyPhys.lastDoubleBar = barCycle;
        triggerFleshWave(0.42 * vol, false);
        if (intensity >= 0.78 && Math.random() < 0.22) {
          triggerHitFreeze(Math.min(0.18, beatSec * 0.34), vol * 0.85, nowP);
        }
      }
    }

    var wantOrbit = activeMusic && !hardHold && !wantFig8 && bootyPhys.phKind !== 1 && bootyPhys.dropAge < 0 &&
      (lookHold || intensity >= 0.44);
    var targetOrbit = wantOrbit ? (lookHold ? 0.68 : (intensity >= 0.84 ? 1 : 0.48)) : 0;
    if (bootyPhys.phKind === 0 && barBeat > 3.2 && barCycle % 2 === 1) targetOrbit *= 0.25;
    if (bootyPhys.orbitGain < targetOrbit) {
      bootyPhys.orbitGain = Math.min(targetOrbit, bootyPhys.orbitGain + dt * 2.4);
    } else if (bootyPhys.orbitGain > targetOrbit) {
      bootyPhys.orbitGain = Math.max(targetOrbit, bootyPhys.orbitGain - dt * 2.2);
    }
    if (bootyPhys.orbitGain > 0.005) {
      var orbit = Math.min(1.15, Math.max(0.18, (intensity - 0.38) / 0.62)) * vol;
      var orbitTurn = (lookHold ? 0.5 : 1) * 2 * Math.PI * beatsNow;
      var orbitMul = bootyPhys.orbitGain * pelvisFreezeMul * danceGain * (1 - bootyPhys.coil);
      ax += Math.cos(orbitTurn) * (200 + orbit * 220) * orbitMul;
      ay += Math.sin(orbitTurn) * (185 + orbit * 195) * orbitMul;
    }

    if (bootyPhys.ripple > 0.005) {
      bootyPhys.rippleTime += dt;
      bootyPhys.ripple *= Math.exp(-dt * 4.4);
    } else {
      bootyPhys.ripple = 0;
      bootyPhys.rippleTime = 0;
    }

    // Route kinematic hip moves (figure-8, drops, coils) through the same hip-lag & cheek springs so
    // every phrase carries weighted viscoelastic flesh follow-through instead of moving rigidly.
    var coilOff = -bootyPhys.coil * (bootyPhys.coilKind === "drop" ? 0.012 : -0.008);
    var kinX = dropSide * vol * 0.023 + figX;
    var kinY = coilOff + dropLanding + figY;
    var totX = bootyPhys.x + kinX / 0.00352;
    var totY = bootyPhys.y + kinY / 0.00432;
    var dampMul = 0.82 + 0.48 * (activeMusic ? Math.min(1, intensity) * Math.min(1, bootyPhys.twerkGain) : 0);
    var kl = 215 * bootyPhys.mL, kr = 190 * bootyPhys.mR;
    var dampL = 9.8 * dampMul, dampR = 8.9 * dampMul;
    // Alternating cheek wave + one-cheek isolation snaps (phKind === 5).
    var isoMaskL = 1 - 0.72 * bootyPhys.isoWeight * (isoSide < 0 ? 1 : -0.45);
    var isoMaskR = 1 - 0.72 * bootyPhys.isoWeight * (isoSide > 0 ? 1 : -0.45);
    var isoSnap = bootyPhys.isoWeight * Math.sin(phase) * groove * 1.15;
    var altDriveL = ((-Math.sin(phase - leftLag) + Math.sin(phase - rightLag)) * (1.35 + 0.75 * bootyPhys.slowRoll) * groove +
      doublePopDrive * 0.85 * danceGain) * isoMaskL + (isoSide > 0 ? isoSnap : -0.25 * isoSnap);
    var altDriveR = ((-Math.sin(phase - rightLag) + Math.sin(phase - leftLag)) * (1.35 + 0.75 * bootyPhys.slowRoll) * groove -
      doublePopDrive * 0.85 * danceGain) * isoMaskR + (isoSide < 0 ? isoSnap : -0.25 * isoSnap);
    altDriveL += fig8Gain * (Math.sin(figAng) * 0.95 + figPlant * bootyPhys.fig8Direction * 0.65) + dropSide * vol * 1.05;
    altDriveR -= fig8Gain * (Math.sin(figAng) * 0.95 + figPlant * bootyPhys.fig8Direction * 0.65) + dropSide * vol * 1.05;
    var altLat = Math.sin(phase * 0.5) * 0.42 * groove * (0.4 + 0.6 * Math.abs(bootyPhys.rollLead)) +
      fig8Gain * Math.cos(figAng) * 0.30;
    var subN = Math.max(1, Math.ceil(dt * 60 - 0.01)), h = dt / subN;
    // Use the dock's actual travel, including the last delta of a quick drag
    // that releases before the next animation frame.
    var dragSpring = BODY_RIG.dragSpring;
    var dragTargetX = -BODY_RIG.dragTravel[0] * Math.tanh(bootyPhys.dragDX / (BODY_RIG.dragSpeed[0] * dt));
    var dragTargetY = -BODY_RIG.dragTravel[1] * Math.tanh(bootyPhys.dragDY / (BODY_RIG.dragSpeed[1] * dt));
    bootyPhys.dragDX = bootyPhys.dragDY = 0;
    for (var sub = 0; sub < subN; sub += 1) {
      bootyPhys.dragVX += (dragSpring[0] * (dragTargetX - bootyPhys.dragX) - dragSpring[1] * bootyPhys.dragVX) * h;
      bootyPhys.dragVY += (dragSpring[0] * (dragTargetY - bootyPhys.dragY) - dragSpring[1] * bootyPhys.dragVY) * h;
      bootyPhys.dragX += bootyPhys.dragVX * h;
      bootyPhys.dragY += bootyPhys.dragVY * h;
      bootyPhys.vx += (ax - k * bootyPhys.x - (d + settling) * bootyPhys.vx) * h;
      bootyPhys.vy += (ay - k * bootyPhys.y - (d + settling) * bootyPhys.vy) * h;
      bootyPhys.x += bootyPhys.vx * h;
      bootyPhys.y += bootyPhys.vy * h;
      bootyPhys.hlvx += (-110 * (bootyPhys.hlx - totX) - 10.0 * bootyPhys.hlvx) * h;
      bootyPhys.hlvy += (-110 * (bootyPhys.hly - totY) - 10.0 * bootyPhys.hlvy) * h;
      bootyPhys.hlx += bootyPhys.hlvx * h; bootyPhys.hly += bootyPhys.hlvy * h;
      var anchorLx = bootyPhys.hlx + altLat, anchorLy = bootyPhys.hly + altDriveL;
      var anchorRx = bootyPhys.phx - altLat, anchorRy = bootyPhys.phy + altDriveR;
      var dlx = bootyPhys.jlx - anchorLx, dly = bootyPhys.jly - anchorLy;
      var drx = bootyPhys.jrx - anchorRx, dry = bootyPhys.jry - anchorRy;
      stepCheekSpring(bootyPhys, "jlx", "jlvx", "jly", "jlvy", anchorLx, anchorLy, kl, dampL, drx, dry, h);
      stepCheekSpring(bootyPhys, "jrx", "jrvx", "jry", "jrvy", anchorRx, anchorRy, kr, dampR, dlx, dly, h);
      bootyPhys.phx = bootyPhys.hlx; bootyPhys.phy = bootyPhys.hly;
    }
    bootyPhys.prevX = bootyPhys.x; bootyPhys.prevY = bootyPhys.y;
    // Each cheek's own swing against the hips it hangs from, plus a share of the hips' lag behind the body.
    var cheekHip = BODY_RIG.cheekHipShare, cheekGain = BODY_RIG.cheekGain, cheekReach = BODY_RIG.cheekReach;
    var hipLagX = (bootyPhys.hlx - totX) * cheekHip, hipLagY = (bootyPhys.hly - totY) * cheekHip;
    var outL = finishCheekOutput(bootyPhys.jlx - bootyPhys.hlx, bootyPhys.jly - bootyPhys.hly, hipLagX, hipLagY, -1, cheekGain, cheekReach);
    var outR = finishCheekOutput(bootyPhys.jrx - bootyPhys.hlx, bootyPhys.jry - bootyPhys.hly, hipLagX, hipLagY, 1, cheekGain, cheekReach);
    bootyPhys.jLx = outL[0]; bootyPhys.jLy = outL[1];
    bootyPhys.jRx = outR[0]; bootyPhys.jRy = outR[1];
    if (bootyPhys.wave > 0.01) {
      bootyPhys.waveT += dt;
      bootyPhys.wave *= Math.exp(-dt * 4.2);
    } else {
      bootyPhys.wave = 0;
      bootyPhys.waveT = 0;
    }
    var thDt = Math.min(dt, 0.032);
    var legDrvX = Math.tanh(-bootyPhys.vx * 0.0020) * 0.0025;
    var legDrvY = Math.tanh(-bootyPhys.vy * 0.0020) * 0.0025 + fxSt.carryPull * 0.004;
    var thSides = [["thLx", "thLvx", "thLy", "thLvy"], ["thRx", "thRvx", "thRy", "thRvy"]];
    for (var ti = 0; ti < 2; ti += 1) {
      var kx = thSides[ti][0], kvx = thSides[ti][1], ky = thSides[ti][2], kvy = thSides[ti][3];
      if (Math.abs(bootyPhys[kx]) > 0.0001 || Math.abs(bootyPhys[kvx]) > 0.001 ||
          Math.abs(bootyPhys[ky]) > 0.0001 || Math.abs(bootyPhys[kvy]) > 0.001 ||
          Math.abs(legDrvX) > 0.0002 || Math.abs(legDrvY) > 0.0002) {
        bootyPhys[kvx] += (155 * (legDrvX - bootyPhys[kx]) - 6.4 * bootyPhys[kvx]) * thDt;
        bootyPhys[kvy] += (155 * (legDrvY - bootyPhys[ky]) - 6.4 * bootyPhys[kvy]) * thDt;
        bootyPhys[kx] = clampNum(bootyPhys[kx] + bootyPhys[kvx] * thDt, -0.009, 0.009);
        bootyPhys[ky] = clampNum(bootyPhys[ky] + bootyPhys[kvy] * thDt, -0.009, 0.009);
      } else {
        bootyPhys[kx] = bootyPhys[ky] = bootyPhys[kvx] = bootyPhys[kvy] = 0;
      }
    }

    if (bootyPhys.blinking) {
      bootyPhys.blinkPhase += dt / bootyPhys.blinkDur;
      if (bootyPhys.blinkPhase >= 1) {
        bootyPhys.blinking = false;
        bootyPhys.blinkPhase = 0;
        bootyPhys.blink = 0;
      } else {
        bootyPhys.blink = Math.pow(Math.sin(Math.PI * bootyPhys.blinkPhase), bootyPhys.blinkDur > 0.4 ? 0.42 : 0.72);
      }
    }

    var st = fxSt.shoulders / 0.025;
    var rippleWave = bootyPhys.ripple > 0 ? Math.sin(bootyPhys.rippleTime * 19) * bootyPhys.ripple * 0.008 : 0;
    var shiverWave = fxSt.shiver > 0.02 ? Math.sin(ts * 0.058) * fxSt.shiver * 0.0022 : 0;
    var dx = Math.tanh(bootyPhys.x * 0.16) * 0.022 + kinX + bootyPhys.dragX + fxSt.teaseX + shiverWave;
    var dy = Math.tanh(bootyPhys.y * 0.18) * 0.024 + kinY + bootyPhys.dragY + fxSt.teaseY;
    // Downward hip drop (bootyPhys.y > 0, dropLanding > 0, figY > 0) widens (sx > 1) and squashes (sy < 1).
    var sq = -Math.tanh(bootyPhys.y * 0.14) * 0.044 + rippleWave * 0.55 - dropLanding * 0.85 - figY * 1.35 +
      Math.abs(bootyPhys.spankTilt) * 0.35 - Math.abs(bootyPhys.dent) * 0.025;
    var sx = 1 - sq;
    var sy = 1 + sq;
    var poseGain = danceGain * vol * (1 - 0.85 * bootyPhys.coil) * (1 - 0.85 * bootyPhys.dropGain);
    var rollLift = (0.009 + 0.010 * bootyPhys.slowRoll) * poseGain * (1 - bootyPhys.fig8Gain);
    var weightLift = 0.011 * bootyPhys.hipWeight * vol;
    var liftL = -Math.sin(phase - leftLag) * rollLift - weightLift;
    var liftR = -Math.sin(phase - rightLag) * rollLift + weightLift;
    bootyPhys.spankTilt = Math.abs(bootyPhys.spankTilt) > 0.001 ? bootyPhys.spankTilt * Math.exp(-dt * 12) : 0;
    // The phased lift sets the height and tilt of a single pelvis. The hip span stays constant.
    var angle = Math.asin((HIP_SPAN_Y + liftR - liftL) / HIP_SPAN) - HIP_ANGLE;
    angle += Math.tanh(bootyPhys.vx * 0.014) * 0.018 + dropSide * vol * 0.085 - bootyPhys.dragX * 1.4 +
      bootyPhys.spankTilt + fig8Gain * (0.072 * Math.sin(figAng) + 0.11 * figPlant * bootyPhys.fig8Direction);
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var hx = -(dx - figX) * 0.24 + Math.cos(phase * 0.5 + 0.4) * 0.0045 * danceGain * (1 - bootyPhys.fig8Gain);
    var hy = (dy - figY) * 0.22 + Math.sin(phase - 0.5) * 0.0055 * danceGain * (1 - bootyPhys.fig8Gain);
    var mHover = stepFx(dt, ts / 1000, hx, hy, activeMusic, intensity, vol, figPlant * bootyPhys.fig8Gain);
    var talkNod = (ts / 1000 < mouthSt.talkUntil) ? 0.005 * mouthSt.open * Math.sin(mouthSt.talkPh * 0.5) : 0;
    hx += fxSt.lookX - fxSt.headAngle * 0.12; hy += fxSt.lookY + fxSt.chin + talkNod;
    var breathGain = 1 - 0.7 * Math.min(1, danceGain);
    var breathWave = Math.sin(fxSt.breathPh) * (1 + 0.9 * fxSt.effort) + 0.9 * bootyPhys.coil;
    var pelvisY = dy + (liftL + liftR) * 0.5 + breathWave * 0.0038 * breathGain;
    var bArch = Math.sin(bootyPhys.twerkPhase - 0.50) * 0.055 * poseGain +
      Math.tanh(bootyPhys.vy * 0.02) * 0.018 * Math.min(1, vol) +
      Math.sin(figAng * 2.0 - 0.5) * 0.028 * fig8Gain +
      breathWave * 0.024 * breathGain - bootyPhys.coil * 0.04;
    // Soft-tissue recoil stays active across drops & figure-8 moves, easing only on static hip holds.
    var jiggleGain = 1 - 0.22 * Math.abs(bootyPhys.hipWeight);
    var jigLx = bootyPhys.jLx * jiggleGain, jigRx = bootyPhys.jRx * jiggleGain;
    var jigLy = bootyPhys.jLy * jiggleGain + dropRebound * 0.55;
    var jigRy = bootyPhys.jRy * jiggleGain + dropRebound * 0.48;
    bArch += (jigLy + jigRy) * 1.1;
    // Positive roll lowers the right hip in artwork coordinates. Let that side
    // lead and carry the landing, blending both lag times through center.
    var rig = BODY_RIG;
    var loadTarget = Math.tanh(angle / rig.cheekLoadAngle);
    bootyPhys.cheekLoad += (loadTarget - bootyPhys.cheekLoad) * (1 - Math.exp(-dt * rig.cheekLoadSpeed));
    var load = bootyPhys.cheekLoad, rightLoad = (1 + load) * 0.5;
    var lagMin = rig.cheekLagSec[0], lagSpan = rig.cheekLagSec[1] - lagMin;
    var followL = Math.max(1 - Math.exp(-dt / (lagMin + lagSpan * rightLoad)), Math.min(1, bootyPhys.spankPressL * 24));
    var followR = Math.max(1 - Math.exp(-dt / (lagMin + lagSpan * (1 - rightLoad))), Math.min(1, bootyPhys.spankPressR * 24));
    var drive = bootyPhys.cheekDrive;
    drive[0] += (jigLx - drive[0]) * followL;
    drive[1] += (jigLy - drive[1]) * followL;
    drive[2] += (jigRx - drive[2]) * followR;
    drive[3] += (jigRy - drive[3]) * followR;
    jigLx = drive[0]; jigLy = drive[1]; jigRx = drive[2]; jigRy = drive[3];
    var heatDecay = Math.exp(-dt * 0.095);
    var pressDecay = Math.exp(-dt * 9.0);
    bootyPhys.spankHeatL = bootyPhys.spankHeatL > 0.004 ? bootyPhys.spankHeatL * heatDecay : 0;
    bootyPhys.spankHeatR = bootyPhys.spankHeatR > 0.004 ? bootyPhys.spankHeatR * heatDecay : 0;
    bootyPhys.spankPressL = bootyPhys.spankPressL > 0.0005 ? bootyPhys.spankPressL * pressDecay : 0;
    bootyPhys.spankPressR = bootyPhys.spankPressR > 0.0005 ? bootyPhys.spankPressR * pressDecay : 0;
    if (fxSt.squeezeActive) {
      var sqDt = Math.min(dt, 0.032);
      var sqTarget = 0.78 + 0.14 * Math.sin(fxSt.breathPh * 1.4);
      var sqAccel = -145 * (bootyPhys.dent - sqTarget) - 16 * bootyPhys.dentV;
      bootyPhys.dentV += sqAccel * sqDt;
      bootyPhys.dent = clampNum(bootyPhys.dent + bootyPhys.dentV * sqDt, -0.55, 1.35);
      bootyPhys.dentU = fxSt.squeezeU;
      bootyPhys.dentVpos = fxSt.squeezeV;
      if (fxSt.squeezeSide < 0) bootyPhys.spankHeatL = Math.max(bootyPhys.spankHeatL, 0.45);
      else bootyPhys.spankHeatR = Math.max(bootyPhys.spankHeatR, 0.45);
    } else if (Math.abs(bootyPhys.dent) > 0.002 || Math.abs(bootyPhys.dentV) > 0.02) {
      var dentDt = Math.min(dt, 0.032);
      var dentAccel = -235 * bootyPhys.dent - 10.5 * bootyPhys.dentV;
      bootyPhys.dentV += dentAccel * dentDt;
      bootyPhys.dent = clampNum(bootyPhys.dent + bootyPhys.dentV * dentDt, -0.55, 1.35);
    } else {
      bootyPhys.dent = 0;
      bootyPhys.dentV = 0;
    }
    var landing = rig.cheekPressMax * skinSmooth(rig.cheekLanding, pelvisY);
    bootyPhys.cheekPress[0] = Math.min(0.11, landing * Math.max(0, -load) + bootyPhys.spankPressL);
    bootyPhys.cheekPress[1] = Math.min(0.11, landing * Math.max(0, load) + bootyPhys.spankPressR);
    stepCrestLag(0, jigLx, h, subN);
    stepCrestLag(1, jigLy, h, subN);
    stepCrestLag(2, jigRx, h, subN);
    stepCrestLag(3, jigRy, h, subN);
    stepMouth(dt, ts / 1000, mHover, activeMusic && !hardHold && danceGain > 0.1, Math.min(1, danceGain) * vol, st);
    // Supple back: the lower back chases its target on an underdamped spring (it overshoots and settles after a hit),
    // the mid back chases the lower back on a softer one, and follows the pelvis late, so motion rolls up the spine.
    var lowerSpring = BODY_RIG.lowerSpring, upperSpring = BODY_RIG.upperSpring;
    var lagSpring = BODY_RIG.lagSpring, lagTarget = BODY_RIG.lagTarget;
    bootyPhys.bAv += (-lowerSpring[0] * (bootyPhys.bAs - bArch) - lowerSpring[1] * bootyPhys.bAv) * dt;
    bootyPhys.bAs += bootyPhys.bAv * dt;
    bootyPhys.mAv += (-upperSpring[0] * (bootyPhys.mAs - bootyPhys.bAs) - upperSpring[1] * bootyPhys.mAv) * dt;
    bootyPhys.mAs += bootyPhys.mAv * dt;
    bootyPhys.spvx += (-lagSpring[0] * (bootyPhys.spx - dx * lagTarget) - lagSpring[1] * bootyPhys.spvx) * dt;
    bootyPhys.spvy += (-lagSpring[0] * (bootyPhys.spy - pelvisY * lagTarget) - lagSpring[1] * bootyPhys.spvy) * dt;
    bootyPhys.spx += bootyPhys.spvx * dt;
    bootyPhys.spy += bootyPhys.spvy * dt;
    bArch = bootyPhys.bAs;
    // 2.5D forward/back relief: arching or popping pushes hips toward camera with deeper glute relief.
    var depthTarget = clampNum(-bArch * 0.42 + dropLanding * 1.15 + figY * 0.65 + bootyPhys.freezeEnv * 0.018 * groove, -0.042, 0.062);
    bootyPhys.depthPush += (depthTarget - bootyPhys.depthPush) * Math.min(1, dt * 18);
    var warped = renderWarp(dx, pelvisY, cos, sin, sx, sy, Math.max(bootyPhys.blink, fxSt.lid), hx, hy, bArch,
      jigLx, jigLy, jigRx, jigRy, bootyPhys.wave, bootyPhys.waveT, mouthSt, fxSt, crestX, crestStrength, bootyPhys.depthPush);
    if (comboHit || trail >= 0) {
      var fxX = warped ? dx : 0, fxY = warped ? pelvisY : 0, fxCos = warped ? cos : 1, fxSin = warped ? sin : 0;
      if (comboHit) {
        var hitSide = comboHit.side * comboSide, count = comboHit.count || 2;
        if (hitSide <= 0) spawnHipHit(HIP_LEFT[0], HIP_LEFT[1], fxX, fxY, fxCos, fxSin, -1, comboHit.effect, count);
        if (hitSide >= 0) spawnHipHit(HIP_RIGHT[0], HIP_RIGHT[1], fxX, fxY, fxCos, fxSin, 1, comboHit.effect, count);
      }
      if (trail >= 0) {
        var along = comboSide > 0 ? 1 - trail : trail;
        spawnHipHit(HIP_LEFT[0] + HIP_SPAN_X * along, HIP_LEFT[1] + HIP_SPAN_Y * along - 0.055 * Math.sin(Math.PI * along),
          fxX, fxY, fxCos, fxSin, -comboSide, "hip-trail", 1);
      }
    }
    if (warped) {
      poseBodyAnchor(tailAnchor);
      earAnchors.forEach(poseBodyAnchor);
      tailLink.rx = tailAnchor.x;
      tailLink.ry = tailAnchor.y;
      tailLink.rootAngle = tailAnchor.angle;
    } else {
      tailLink.rx = tailLink.ry = tailLink.rootAngle = 0;
      earAnchors.forEach(resetBodyAnchor);
    }
    tailLink.dx = dx;
    tailLink.dy = dy;
    tailLink.twerk = poseGain;
    tailLink.phase = bootyPhys.twerkPhase;
    tailLink.ripple = bootyPhys.ripple;
    tailLink.stretch = st;
    tailLink.blinking = bootyPhys.blinking;
    tailLink.music = activeMusic ? Math.min(1, intensity) * poseGain : 0;
    tailLink.talk = mouthSt.str > 0.3 ? Math.min(1, mouthSt.open * 1.6) : 0;
    tailLink.effort = fxSt.effort;
    tailLink.strikeSide = fxSt.lastSide * Math.min(1, fxSt.spankT * 1.4);
    tailLink.shy = Math.min(1, mouthSt.flustered / 0.5);
    tailLink.happy = mouthSt.happy > 0 ? 1 : 0;
    tailLink.vx = bootyPhys.vx;
    tailLink.vy = bootyPhys.vy;
    tailLink.pdx = fxSt.pdx;
    tailLink.pnear = fxSt.pnear;
    tailLink.holding = hardHold || gesture.kind === "listen" || tailLink.curlPose > 0.02 || bootyPhys.dropAge >= 0 || bootyPhys.dropGain > 0.05 ||
      (bootyPhys.coilKind === "drop" && bootyPhys.coilT > 0);
    tailLink.tailState = fxSt.squeezeActive ? "squeeze" : (fxSt.spankT > 0.35 || bootyPhys.ripple > 0.35) ? "snap" : (tailAnim.perk > 0.15) ? "perk" : "idle";
    tailLink.talkBurst = mouthSt.talkAccent;
    tailLink.cupTiltL = fxSt.cupTiltL;
    tailLink.cupTiltR = fxSt.cupTiltR;
    tailLink.humBeat = fxSt.idleHabit === "hum" ? 1 : 0;
    tailLink.accent = accent;
    var steady = tailLink.holding || wantFig8 || !!gesture.kind || bootyPhys.phKind === 1;
    bootyPhys.cameraStill += ((steady ? 1 : 0) - bootyPhys.cameraStill) * (1 - Math.exp(-dt * (steady ? 22 : 5)));
    updateStage(dx, dy, tailLink.music);
    tailAnim.vhook += tipFlick;
    paintTail(ts / 1000, dt);

    var glow = Math.min(1, Math.hypot(dx, dy) * 28 + bootyPhys.ripple * 0.85);
    var glowStr = glow > 0.04 ? glow.toFixed(1) : "0";
    if (glowStr !== bootyPhys.glowStr) {
      // Only touch the CSS variable when its value really changes: it forces a repaint on iOS.
      bootyPhys.glowStr = glowStr;
      portrait.style.setProperty("--booty-glow", glowStr);
    }

    var lyricTrack = activeLyricTrack();
    var busy = playing || (lyricTrack && !lyricTrack.audio.paused && !lyricTrack.audio.ended) || drag || pinching || !!gesture.kind ||
        Math.abs(bootyPhys.dragX) > 0.0005 || Math.abs(bootyPhys.dragY) > 0.0005 ||
        Math.abs(bootyPhys.dragVX) > 0.015 || Math.abs(bootyPhys.dragVY) > 0.015 ||
        Math.abs(tailAnim.dragX) > 3 || Math.abs(tailAnim.dragY) > 3 ||
        Math.abs(tailAnim.dragVX) > 25 || Math.abs(tailAnim.dragVY) > 25 ||
        Math.abs(bootyPhys.x) > 0.12 || Math.abs(bootyPhys.y) > 0.12 ||
        Math.abs(bootyPhys.vx) > 1.5 || Math.abs(bootyPhys.vy) > 1.5 ||
        bootyPhys.twerkGain > 0.01 || bootyPhys.orbitGain > 0.01 ||
        bootyPhys.fig8Gain > 0.01 || bootyPhys.dropGain > 0.01 ||
        bootyPhys.ripple > 0.01 || bootyPhys.blinking ||
        bootyPhys.coilT > 0 || bootyPhys.wave > 0.01 || Math.abs(bootyPhys.hlx - bootyPhys.x) > 0.1 ||
        Math.abs(bootyPhys.jlx - bootyPhys.x) > 0.1 || Math.abs(bootyPhys.jly - bootyPhys.y) > 0.1 ||
        Math.abs(bootyPhys.jlvx) > 1 || Math.abs(bootyPhys.jlvy) > 1 ||
        Math.abs(bootyPhys.jrvx) > 1 || Math.abs(bootyPhys.jrvy) > 1 ||
        Math.abs(bootyPhys.spankTilt) > 0.002 ||
        Math.abs(bootyPhys.dent) > 0.004 || Math.abs(bootyPhys.dentV) > 0.04 ||
        Math.abs(bootyPhys.thLx) > 0.0004 || Math.abs(bootyPhys.thRx) > 0.0004 ||
        Math.abs(bootyPhys.thLvx) > 0.002 || Math.abs(bootyPhys.thRvx) > 0.002 ||
        bootyPhys.spankPressL > 0.002 || bootyPhys.spankPressR > 0.002 ||
        fxSt.squeezeActive || fxSt.pet > 0.02 || fxSt.pout > 0.02 || fxSt.shiver > 0.02 ||
        fxSt.dizzyUntil > (ts / 1000) || fxSt.braceUntil > (ts / 1000) ||
        Math.abs(fxSt.teaseX) > 0.0004 || Math.abs(fxSt.teaseY) > 0.0004;
    var crestMoving = bootyPhys.crestLag.some(function (value) { return Math.abs(value) > 0.0005; });
    // Only the slow idle breathing left: 30fps is plenty (saves battery on 120Hz ProMotion).
    bootyPhys.calm = !busy && !crestMoving;

    bootyPhys.raf = window.requestAnimationFrame(stepBooty);
  }

  // Restore the static portrait when the animation stops.
  function resetBootyState() {
    {
      bootyPhys.x = 0;
      bootyPhys.y = 0;
      bootyPhys.vx = 0;
      bootyPhys.vy = 0;
      bootyPhys.dragX = bootyPhys.dragY = bootyPhys.dragVX = bootyPhys.dragVY = 0;
      bootyPhys.dragDX = bootyPhys.dragDY = 0;
      bootyPhys.twerkGain = 0;
      bootyPhys.orbitGain = 0;
      bootyPhys.fig8Gain = 0;
      bootyPhys.fig8Beat = 0;
      bootyPhys.fig8Direction = 1;
      bootyPhys.dropGain = 0;
      bootyPhys.dropTimer = 0;
      bootyPhys.hlx = bootyPhys.hly = bootyPhys.hlvx = bootyPhys.hlvy = bootyPhys.phx = bootyPhys.phy = 0;
      bootyPhys.jlx = bootyPhys.jly = bootyPhys.jlvx = bootyPhys.jlvy = 0;
      bootyPhys.jrx = bootyPhys.jry = bootyPhys.jrvx = bootyPhys.jrvy = 0;
      bootyPhys.crestLag.fill(0);
      bootyPhys.crestLagV.fill(0);
      bootyPhys.cheekDrive.fill(0);
      bootyPhys.cheekPress.fill(0);
      bootyPhys.cheekLoad = 0;
      bootyPhys.prevX = bootyPhys.prevY = 0;
      bootyPhys.jLx = bootyPhys.jLy = bootyPhys.jRx = bootyPhys.jRy = 0;
      bootyPhys.wave = 0;
      bootyPhys.waveT = 0;
      mouthSt.open = 0; mouthSt.smile = 0.25; mouthSt.wide = 0.85; mouthSt.tongue = 0; mouthSt.str = 0;
      mouthSt.gasp = 0; mouthSt.happy = 0; mouthSt.talkUntil = 0; mouthSt.blepUntil = 0;
      tailLink.rx = tailLink.ry = tailLink.rootAngle = tailLink.dx = tailLink.dy = tailLink.twerk = tailLink.ripple = tailLink.stretch = 0;
      tailLink.blinking = false;
      tailLink.music = 0;
      tailLink.talk = tailLink.curlPose = 0;
      earAnchors.forEach(resetBodyAnchor);
      tailLink.effort = tailLink.shy = tailLink.happy = tailLink.vx = tailLink.vy = tailLink.pdx = tailLink.pnear = tailLink.accent = 0;
      tailLink.arousal = tailLink.pout = tailLink.pet = tailLink.strikeSide = tailLink.heartPulse = tailLink.watchDir = tailLink.carryPull = 0;
      tailLink.holding = false;
      bootyPhys.ripple = 0;
      bootyPhys.rippleTime = 0;
      bootyPhys.blink = 0;
      bootyPhys.blinkPhase = 0;
      bootyPhys.blinking = false;
      bootyPhys.lastTs = 0;
      bootyPhys.calm = false;
      bootyPhys.glowStr = "0";
      portrait.style.setProperty("--booty-glow", "0");
      resetFx();
      bootyPhys.coilT = bootyPhys.coil = bootyPhys.bAs = bootyPhys.settleUntil = 0;
      bootyPhys.spankHeatL = bootyPhys.spankHeatR = bootyPhys.spankPressL = bootyPhys.spankPressR = bootyPhys.spankTilt = 0;
      bootyPhys.dent = bootyPhys.dentV = 0;
      bootyPhys.thLx = bootyPhys.thLy = bootyPhys.thLvx = bootyPhys.thLvy = 0;
      bootyPhys.thRx = bootyPhys.thRy = bootyPhys.thRvx = bootyPhys.thRvy = 0;
      bootyPhys.bAv = bootyPhys.mAs = bootyPhys.mAv = bootyPhys.spx = bootyPhys.spy = bootyPhys.spvx = bootyPhys.spvy = 0;
      bootyPhys.prevPlaying = bootyPhys.prevDrop = false;
      bootyPhys.phKind = 0; bootyPhys.phUntil = 0; bootyPhys.phRate = 1; bootyPhys.phAmp = 1;
      bootyPhys.twerkPhase = bootyPhys.beatWraps = 0;
      bootyPhys.dropAge = -1;
      bootyPhys.comboKind = "";
      bootyPhys.comboGap = 0;
      bootyPhys.comboSide = 1;
      bootyPhys.comboCancelAt = -1;
      bootyPhys.nextAccentCombo = "ripple";
      bootyPhys.rollSide = bootyPhys.rollLead = 1;
      bootyPhys.holdSide = bootyPhys.hipWeight = bootyPhys.slowRoll = bootyPhys.cameraStill = 0;
      bootyPhys.energyMul = 1;
      bootyPhys.lastPopBeat = -1;
      updateStage(0, 0, 0, true);
      hideWarpCanvas();
    }
  }

  function ensureBootyRaf() {
    if (!motionReady()) return;
    bootyPhys.calm = false;
    if (!bootyPhys.raf) {
      bootyPhys.lastTs = 0;
      bootyPhys.raf = window.requestAnimationFrame(stepBooty);
    }
  }

  function nudgeBooty(ddx, ddy, dockDX, dockDY) {
    if (!motionReady()) return;
    var spd = Math.hypot(ddx, ddy);
    tailAnim.dragDX += dockDX;
    tailAnim.dragDY += dockDY;
    bootyPhys.dragDX += dockDX;
    bootyPhys.dragDY += dockDY;
    bootyPhys.vx += Math.max(-85, Math.min(85, -ddx * 3.4));
    bootyPhys.vy += Math.max(-85, Math.min(85, -ddy * 3.2));
    fxSt.carryPull = Math.min(1, fxSt.carryPull + Math.min(0.28, spd * 0.015));
    if (spd >= 11) fxSt.dizzy = Math.min(1, fxSt.dizzy + Math.min(0.24, (spd - 9) * 0.014));
    ensureBootyRaf();
    if (spd > 9) {
      showNsfwBubble();
    }
  }

  var blushTimer = 0;
  var blinkTimer = 0;

  function triggerBlink(duration, inFrame) {
    if (!button.classList.contains("is-nsfw") || !available || document.hidden || reduceMotion) return;
    bootyPhys.blinking = true;
    bootyPhys.blinkPhase = 0;
    bootyPhys.blinkDur = duration || ((mouthSt.happy > 0 || fxSt.effort > 0.4 || Math.random() < 0.18) ? 0.5 : 0.28);
    if (!inFrame) ensureBootyRaf();
  }

  function stopBlinkLoop() {
    if (blinkTimer) window.clearTimeout(blinkTimer);
    blinkTimer = 0;
  }

  function scheduleBlinkLoop() {
    if (!button.classList.contains("is-nsfw") || !available || document.hidden || reduceMotion) return;
    ensureBootyRaf();
    if (blinkTimer) return;
    blinkTimer = window.setTimeout(function () {
      blinkTimer = 0;
      if (!gesture.kind && bootyPhys.phKind !== 3 && !bootyPhys.holdSide) triggerBlink();
      scheduleBlinkLoop();
    }, 3000 + Math.round(Math.random() * 3400));
  }

  function cheekStrikeSplit(clientX, clientY) {
    if (!Number.isFinite(clientX)) {
      var fallbackSide = bootyPhys.spankSwipeSide = -bootyPhys.spankSwipeSide;
      return {
        side: fallbackSide,
        hitL: fallbackSide < 0 ? 1 : 0.28,
        hitR: fallbackSide > 0 ? 1 : 0.28,
        uHit: fallbackSide < 0 ? 0.468 : 0.622,
        vHit: 0.27,
        pan: fallbackSide * 0.22
      };
    }
    var spR = button.getBoundingClientRect();
    var uHit = Math.max(0, Math.min(1, (clientX - spR.left) / Math.max(1, spR.width)));
    var vHit = Number.isFinite(clientY) ? Math.max(0, Math.min(1, (clientY - spR.top) / Math.max(1, spR.height))) : 0.27;
    var off = (uHit - 0.548) / 0.075;
    var side = off < 0 ? -1 : 1;
    var th = Math.tanh(off);
    return {
      side: side,
      hitL: Math.max(0.24, Math.min(1.0, 0.72 - 0.48 * th)),
      hitR: Math.max(0.24, Math.min(1.0, 0.72 + 0.48 * th)),
      uHit: uHit,
      vHit: vHit,
      pan: Math.max(-1, Math.min(1, (uHit - 0.5) * 1.6))
    };
  }

  function resolveDentTarget(u, v, side) {
    if (v <= 0.305) {
      var dv = clampNum(v, 0.238, 0.278);
      var cheekEdgeU = side < 0 ? 0.456 - (dv - 0.240) * 1.05 : 0.640 + (dv - 0.236) * 1.35;
      return {
        u: cheekEdgeU * 0.72 + clampNum(u, side < 0 ? 0.40 : 0.60, side < 0 ? 0.48 : 0.72) * 0.28,
        v: dv,
        thigh: false
      };
    }
    var tv = clampNum(v, 0.310, 0.560);
    var t = (tv - 0.305) / 0.265;
    var outerU = side < 0 ? 0.405 - 0.220 * t : 0.730 + 0.165 * t;
    var midU = side < 0 ? 0.440 - 0.210 * t : 0.695 + 0.155 * t;
    var innerU = side < 0 ? 0.465 - 0.160 * t : 0.660 + 0.150 * t;
    var onOuter = side < 0 ? u <= midU : u >= midU;
    var edgeU = onOuter ? outerU : innerU;
    var lo = Math.min(outerU, innerU) - 0.015;
    var hi = Math.max(outerU, innerU) + 0.015;
    return {
      u: edgeU * 0.74 + clampNum(u, lo, hi) * 0.26,
      v: tv,
      thigh: true
    };
  }

  function classifyChipZone(u, v) {
    if (v >= 0.56 && u >= 0.28 && u <= 0.66) return "head";
    if (v <= 0.21 && u >= 0.34 && u <= 0.64) return "tail";
    if (v > 0.305 && v <= 0.60 && u >= 0.14 && u <= 0.90 && !(v > 0.34 && Math.abs(u - 0.545) < 0.09)) {
      return "thigh";
    }
    return "cheek";
  }

  function startSqueeze(clientX, clientY) {
    if (!button.classList.contains("is-nsfw") || reduceMotion) return false;
    var hit = cheekStrikeSplit(clientX, clientY);
    var zone = classifyChipZone(hit.uHit, hit.vHit);
    if (zone !== "cheek" && zone !== "thigh") return false;
    var dentPos = resolveDentTarget(hit.uHit, hit.vHit, hit.side);
    var nowSp = performance.now() / 1000;
    fxSt.squeezeActive = true;
    fxSt.squeezeU = dentPos.u;
    fxSt.squeezeV = dentPos.v;
    fxSt.squeezeSide = hit.side;
    fxSt.squeezeZone = zone;
    fxSt.lastZone = zone;
    fxSt.lastSide = hit.side;
    fxSt.lastInteractAt = nowSp;
    fxSt.arousal = clampNum(fxSt.arousal + 0.12, 0, 1);
    fxSt.flush = Math.min(1, fxSt.flush + 0.28);
    fxSt.effort = Math.min(1, fxSt.effort + 0.18);
    fxSt.glanceFrom = nowSp + 0.12;
    fxSt.glanceUntil = nowSp + 2.4;
    fxSt.glanceDir = hit.side;
    bootyPhys.dentSide = hit.side;
    bootyPhys.dentDirX = -hit.side * 0.45;
    bootyPhys.dentDirY = -0.35;
    bootyPhys.spankTilt = clampNum(bootyPhys.spankTilt + hit.side * 0.036, -0.11, 0.11);
    bootyPhys.spankHeatL = Math.min(1.0, bootyPhys.spankHeatL + 0.24 * hit.hitL);
    bootyPhys.spankHeatR = Math.min(1.0, bootyPhys.spankHeatR + 0.24 * hit.hitR);
    mouthSt.flustered = Math.max(mouthSt.flustered, 1.3);
    mouthSt.happy = Math.max(mouthSt.happy, 1.4);
    bodySfx.gasp(0.95 + fxSt.arousal * 0.12);
    ensureBootyRaf();
    showReaction("squeeze", NSFW_SQUEEZE_LINES, true, { type: true, voice: true });
    return true;
  }

  function releaseSqueeze(withRebound) {
    if (!fxSt.squeezeActive) return;
    var side = fxSt.squeezeSide || 1;
    fxSt.squeezeActive = false;
    if (!withRebound) return;
    var nowSp = performance.now() / 1000;
    bootyPhys.dentV = -22;
    bootyPhys.vy -= 42;
    bootyPhys.vx += side * 26;
    if (side < 0) bootyPhys.jlvx -= 48; else bootyPhys.jrvx += 48;
    bootyPhys.jlvy -= 36;
    bootyPhys.jrvy -= 36;
    triggerFleshWave(0.65, true);
    triggerShiver(0.55);
    mouthSt.gasp = Math.max(mouthSt.gasp, 0.34);
    mouthSt.flustered = Math.max(mouthSt.flustered, 1.2);
    mouthSt.happy = Math.max(mouthSt.happy, 1.8);
    fxSt.nextPostSmileAt = nowSp + 0.48;
    bodySfx.gasp(1.06 + fxSt.arousal * 0.14);
    spawnFx("♥", 2);
    ensureBootyRaf();
  }

  function triggerHeadPet(hit, strong) {
    if (!button.classList.contains("is-nsfw") || reduceMotion) return;
    var nowSp = performance.now() / 1000;
    if (!strong && fxSt.lastPurrAt && nowSp - fxSt.lastPurrAt < 0.42) return;
    fxSt.lastPurrAt = nowSp;
    fxSt.lastZone = "head";
    fxSt.lastInteractAt = nowSp;
    fxSt.pet = clampNum(fxSt.pet + (strong ? 0.55 : 0.28), 0, 1);
    fxSt.arousal = clampNum(fxSt.arousal + (strong ? 0.10 : 0.045), 0, 1);
    fxSt.flush = Math.min(1, fxSt.flush + (strong ? 0.26 : 0.10));
    fxSt.pout = Math.max(0, fxSt.pout - 0.5);
    fxSt.poutUntil = 0;
    fxSt.sulk = Math.max(0, fxSt.sulk - 0.55);
    chipMem.pets += 1;
    if (strong) saveChipMemory();
    mouthSt.happy = Math.max(mouthSt.happy, 2.0);
    mouthSt.flustered = Math.max(mouthSt.flustered, 1.1);
    tailAnim.excite = Math.max(tailAnim.excite, strong ? 0.85 : 0.45);
    bodySfx.purr(strong ? 0.95 : 0.65);
    if (strong) {
      bootyPhys.vy -= 14;
      startGesture("smile", nowSp);
      spawnFx("♥", 2);
    }
    ensureBootyRaf();
    if (strong || !fxSt.lastPetSayAt || nowSp - fxSt.lastPetSayAt >= 7.0) {
      fxSt.lastPetSayAt = nowSp;
      showReaction("pet", NSFW_PET_LINES, true, { type: true });
    }
  }

  function triggerTailTease(hit, strong) {
    if (!button.classList.contains("is-nsfw") || reduceMotion) return;
    var nowSp = performance.now() / 1000;
    if (!strong && fxSt.lastTailAt && nowSp - fxSt.lastTailAt < 0.34) return;
    fxSt.lastTailAt = nowSp;
    fxSt.lastZone = "tail";
    fxSt.lastInteractAt = nowSp;
    fxSt.arousal = clampNum(fxSt.arousal + (strong ? 0.15 : 0.06), 0, 1);
    fxSt.flush = Math.min(1, fxSt.flush + (strong ? 0.35 : 0.14));
    fxSt.effort = Math.min(1, fxSt.effort + 0.18);
    tailAnim.vhook += (strong ? 5.2 : 2.6) * (hit && hit.side ? -hit.side : 1);
    tailAnim.excite = Math.max(tailAnim.excite, strong ? 1.0 : 0.6);
    bootyPhys.vx += (hit ? -hit.side : 1) * (strong ? 28 : 11);
    bootyPhys.vy -= strong ? 26 : 8;
    mouthSt.gasp = Math.max(mouthSt.gasp, strong ? 0.40 : 0.18);
    mouthSt.flustered = Math.max(mouthSt.flustered, 1.3);
    fxSt.glanceFrom = nowSp + 0.09;
    fxSt.glanceUntil = nowSp + 1.8;
    fxSt.glanceDir = hit ? hit.side : 1;
    if (strong) {
      bodySfx.gasp(1.12 + fxSt.arousal * 0.12);
      triggerBlink();
      spawnFx("♪", 2);
    }
    ensureBootyRaf();
    if (strong || !fxSt.lastPetSayAt || nowSp - fxSt.lastPetSayAt >= 6.5) {
      fxSt.lastPetSayAt = nowSp;
      showReaction("tail", NSFW_TAIL_LINES, true, { type: true });
    }
  }

  function spankBooty(event, powerScale) {
    if (!button.classList.contains("is-nsfw")) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var hit = cheekStrikeSplit(event ? event.clientX : NaN, event ? event.clientY : NaN);
    var zone = event && Number.isFinite(event.clientY) ? classifyChipZone(hit.uHit, hit.vHit) : "cheek";
    if (zone === "head") {
      if (hit.vHit >= 0.68 && hit.vHit <= 0.84 && ((hit.uHit >= 0.27 && hit.uHit <= 0.38) || (hit.uHit >= 0.52 && hit.uHit <= 0.63))) {
        var nowCup = performance.now() / 1000;
        if (hit.uHit < 0.45) fxSt.cupTiltL = 1.0; else fxSt.cupTiltR = 1.0;
        fxSt.cupListenUntil = nowCup + 2.2;
        startGesture("listen", nowCup);
        showReaction(playing ? "look" : "pause", NSFW_PET_LINES, true, { type: true, voice: true });
        return;
      }
      triggerHeadPet(hit, true);
      return;
    }
    if (zone === "tail") { triggerTailTease(hit, true); return; }
    var nowSp = performance.now() / 1000;
    var prevZone = fxSt.lastZone;
    var withinCombo = fxSt.lastStrikeAt > 0 && (nowSp - fxSt.lastStrikeAt) < 2.2;
    var alternating = !!(fxSt.lastSide && fxSt.lastSide !== hit.side && withinCombo && (nowSp - fxSt.lastStrikeAt) < 1.6);
    fxSt.combo = withinCombo ? Math.min(8, fxSt.combo + 1) : 1;
    fxSt.lastStrikeAt = nowSp;
    fxSt.lastInteractAt = nowSp;
    fxSt.lastZone = zone;
    fxSt.lastSide = hit.side;
    fxSt.pout = 0;
    fxSt.poutUntil = 0;
    fxSt.sulk = Math.max(0, fxSt.sulk - 0.25);
    fxSt.needy = 0;
    fxSt.arcStep = (fxSt.arcLastAt > 0 && (nowSp - fxSt.arcLastAt) < 3.6) ? (fxSt.arcStep + 1) % 3 : 0;
    fxSt.arcLastAt = nowSp;
    chipMem.hits += 1;
    spankTotal += 1;
    var hitMilestone = 0;
    if (chipMem.hits === 10 || chipMem.hits === 25 || chipMem.hits === 50 || (chipMem.hits > 50 && chipMem.hits % 50 === 0)) {
      if (chipMem.milestone < chipMem.hits) { hitMilestone = chipMem.hits; chipMem.milestone = chipMem.hits; }
    }
    saveChipMemory();
    var afterglowGain = fxSt.afterglow > 0.25 ? 1.35 : 1.0;
    fxSt.arousal = clampNum(fxSt.arousal + (0.13 + Math.min(0.10, fxSt.combo * 0.022)) * afterglowGain, 0, 1);
    var pwr = Math.max(0.65, Math.min(1.55, (powerScale || 1) * (1 + Math.min(0.28, (fxSt.combo - 1) * 0.048))));
    var side = hit.side, hitL = hit.hitL, hitR = hit.hitR, spPan = hit.pan;
    var dentPos = resolveDentTarget(hit.uHit, hit.vHit, side);
    if (zone === "thigh") dentPos.thigh = true;
    var jgScale = dentPos.thigh ? 0.62 : 1.0;
    var hasSwipe = !!(event && Number.isFinite(event.swipeX) && Number.isFinite(event.swipeY));
    var dirX = hasSwipe ? event.swipeX : -side * 0.45;
    var dirY = hasSwipe ? event.swipeY : -0.88;
    // Translate the stroke vector directly into the cheek springs & hip tilt so swipes feel physical.
    var impX = dirX * 118 * pwr, impY = dirY * 118 * pwr;
    bootyPhys.vx += (hasSwipe ? impX * 0.52 - side * 22 * pwr : -side * (36 + Math.random() * 14) * pwr) * jgScale;
    bootyPhys.vy += (hasSwipe ? impY * 0.68 - 28 * pwr : -72 * pwr) * jgScale;
    bootyPhys.jlvx += (impX * 1.15 - 32 * hitL * pwr) * hitL * jgScale;
    bootyPhys.jlvy += (impY * 1.25 - 26 * hitL * pwr) * hitL * jgScale;
    bootyPhys.jrvx += (impX * 1.15 + 32 * hitR * pwr) * hitR * jgScale;
    bootyPhys.jrvy += (impY * 1.25 - 26 * hitR * pwr) * hitR * jgScale;
    bootyPhys.crestLagV[0] += dirX * 0.16 * hitL * pwr * jgScale;
    bootyPhys.crestLagV[1] += dirY * 0.16 * hitL * pwr * jgScale;
    bootyPhys.crestLagV[2] += dirX * 0.16 * hitR * pwr * jgScale;
    bootyPhys.crestLagV[3] += dirY * 0.16 * hitR * pwr * jgScale;
    bootyPhys.spankTilt = clampNum(
      bootyPhys.spankTilt + ((hitR - hitL) * 0.068 + dirY * side * 0.032) * pwr * jgScale,
      -0.11,
      0.11
    );
    bootyPhys.spankPressL = Math.min(0.078, bootyPhys.spankPressL + 0.064 * hitL * pwr * jgScale);
    bootyPhys.spankPressR = Math.min(0.078, bootyPhys.spankPressR + 0.064 * hitR * pwr * jgScale);
    bootyPhys.spankHeatL = Math.min(1.0, bootyPhys.spankHeatL + 0.54 * hitL * pwr);
    bootyPhys.spankHeatR = Math.min(1.0, bootyPhys.spankHeatR + 0.54 * hitR * pwr);
    bootyPhys.dentU = dentPos.u;
    bootyPhys.dentVpos = dentPos.v;
    bootyPhys.dentSide = side;
    bootyPhys.dentDirX = dirX;
    bootyPhys.dentDirY = dirY;
    bootyPhys.dent = clampNum(bootyPhys.dent + 0.48 * pwr, -0.55, 1.35);
    bootyPhys.dentV = Math.max(0, bootyPhys.dentV) + 18.5 * pwr;
    var thKick = dentPos.thigh ? 0.095 * pwr : 0.055 * pwr;
    bootyPhys.thLvx += (dirX * hitL + (side < 0 ? 0.24 : 0.06)) * thKick;
    bootyPhys.thLvy += (dirY * hitL + 0.18 * hitL) * thKick;
    bootyPhys.thRvx += (dirX * hitR + (side > 0 ? -0.24 : -0.06)) * thKick;
    bootyPhys.thRvy += (dirY * hitR + 0.18 * hitR) * thKick;
    triggerFleshWave(Math.min(1.15, pwr * 1.05), true);
    bootyPhys.mL = 0.88 + Math.random() * 0.08 + 0.10 * hitR;
    bootyPhys.mR = 0.88 + Math.random() * 0.08 + 0.10 * hitL;
    mouthSt.gasp = 0.52;
    mouthSt.flustered = 1.6;
    mouthSt.happy = 2.2;
    fxSt.spankT = 1;
    fxSt.effort = Math.min(1, fxSt.effort + 0.35 * pwr);
    fxSt.flush = Math.min(1, fxSt.flush + 0.45 * pwr);
    fxSt.glanceFrom = nowSp + 0.09;
    fxSt.glanceUntil = nowSp + 2.0;
    fxSt.glanceDir = side;
    fxSt.nextPostSmileAt = nowSp + 0.55;
    var gaspPitch = 1 + Math.min(0.24, (fxSt.combo - 1) * 0.032 + fxSt.arousal * 0.12);
    bodySfx.slap((0.55 + Math.random() * 0.35) * Math.min(1.25, pwr), spPan, zone);
    window.setTimeout(function () { bodySfx.gasp(gaspPitch); }, 55);
    spawnFx("", 1, hit.uHit, hit.vHit, side, "hip-arc");
    spawnFx("♥", 3 + Math.round(Math.random() * 2));
    triggerBlink();
    ensureBootyRaf();
    button.classList.add("is-blushing");
    if (blushTimer) window.clearTimeout(blushTimer);
    blushTimer = window.setTimeout(function () {
      blushTimer = 0;
      button.classList.remove("is-blushing");
    }, 850);
    var genKind = "", pool = NSFW_SPANK_LINES;
    if (bootyPhys.dropGain > 0.35 || bootyPhys.dropAge >= 0) {
      genKind = "drop"; pool = NSFW_DROP_SPANK_LINES;
    } else if (hitMilestone) {
      genKind = ""; pool = [pickReactionLine(NSFW_MILESTONE_LINES).replace("{n}", String(hitMilestone))];
    } else if (fxSt.combo >= 4 || fxSt.arousal >= 0.72) {
      genKind = "combo"; pool = NSFW_HIGH_COMBO_LINES;
    } else if (fxSt.afterglow > 0.48 && fxSt.combo === 1) {
      genKind = "afterglow"; pool = NSFW_AFTERGLOW_LINES;
    } else if (zone === "thigh") {
      genKind = "thigh"; pool = NSFW_THIGH_LINES;
    } else if (alternating) {
      genKind = "spank"; pool = NSFW_ALT_CHEEK_LINES;
    } else if (fxSt.arcStep > 0) {
      genKind = "spank"; pool = [NSFW_ARC_CHAINS[fxSt.arcStep]];
    } else {
      genKind = "spank"; pool = NSFW_SPANK_LINES;
    }
    var important = !!(fxSt.combo === 4 || hitMilestone || (prevZone && prevZone !== zone) || bootyPhys.dropGain > 0.35);
    showReaction(genKind, pool, important, { type: true, voice: important });
  }

  button.addEventListener("dblclick", function (event) {
    if (!button.classList.contains("is-nsfw")) return;
    event.preventDefault();
    chipVoice.unlock();
    spankBooty(event);
  });

  function motionReady() {
    return !!(
      button.classList.contains("is-nsfw") &&
      !dock.hidden &&
      !document.hidden &&
      !reduceMotion
    );
  }

  function startMusicTwerk() {
    if (!musicPlaying()) return;
    ensureBootyRaf();
  }

  var idleBootyTimer = 0;
  var idleBootySide = 1;
  var nextIdleGesture = "curl";

  function idleBootyReady() {
    return !!(
      button.classList.contains("is-nsfw") &&
      !musicPlaying() &&
      available &&
      !document.hidden &&
      !reduceMotion
    );
  }

  function stopIdleBooty() {
    if (idleBootyTimer) window.clearTimeout(idleBootyTimer);
    idleBootyTimer = 0;
  }

  function runIdleBooty() {
    idleBootyTimer = 0;
    if (!idleBootyReady()) return;
    if (!gesture.kind && !reactionBusy()) {
      if (nextIdleGesture === "flick") {
        nextIdleGesture = "";
        fxSt.hLvx += 18; fxSt.hRvx -= 14;
        tailAnim.vhook += idleBootySide * 3.2;
        fxSt.curlPulse = 0.85;
        bodySfx.hum();
        ensureBootyRaf();
      } else if (nextIdleGesture) {
        var did = nextIdleGesture;
        if (startGesture(did)) {
          nextIdleGesture = did === "curl" ? "stretch" : "flick";
          if (did === "stretch") {
            bodySfx.yawn();
            mouthSt.happy = Math.max(mouthSt.happy, 1.1);
          } else if (did === "curl") {
            mouthSt.blepUntil = Math.max(mouthSt.blepUntil, performance.now() / 1000 + 2.6);
          }
        }
      } else {
        nextIdleGesture = "curl";
        idleBootySide = -idleBootySide;
        bootyPhys.vy -= 4 + Math.random() * 3;
        bootyPhys.vx += idleBootySide * (10 + Math.random() * 4);
        ensureBootyRaf();
        window.setTimeout(function () {
          if (idleBootyReady() && !drag) {
            bootyPhys.vy -= 3;
            bootyPhys.vx -= idleBootySide * 7;
            ensureBootyRaf();
          }
        }, 180);
      }
      if (!drag && !fxSt.squeezeActive && (Date.now() - lastBubbleAt) >= 34000 && Math.random() < 0.65) {
        showReaction("idle", NSFW_IDLE_TALK_LINES, false, { type: true });
      }
    }
    idleBootyTimer = window.setTimeout(runIdleBooty, 9000 + Math.round(Math.random() * 6000));
  }

  function startIdleBooty() {
    if (idleBootyTimer || !idleBootyReady()) return;
    idleBootyTimer = window.setTimeout(runIdleBooty, 7000 + Math.round(Math.random() * 5000));
  }

  var longPressTimer = 0;
  var titleHoldTimer = 0;
  var spankTotal = 0;

  function clearLongPress(withRebound) {
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = 0;
    if (titleHoldTimer) window.clearTimeout(titleHoldTimer);
    titleHoldTimer = 0;
    if (fxSt.squeezeActive) releaseSqueeze(!!withRebound);
  }

  // True while this pointer is still a hold: chip in use, no drag yet, no pinch.
  function stillHolding(id) {
    return !!(available && drag && drag.id === id && !drag.moved && !pinching);
  }

  var spankSwipe = { x: 0, y: 0, t: 0, lastAt: 0 };

  function resetSwipeTrack() {
    spankSwipe.t = 0;
    fxSt.teaseHoverAt = 0;
  }

  button.addEventListener("pointerleave", resetSwipeTrack);

  button.addEventListener("pointerdown", function (event) {
    resetSwipeTrack();
    chipVoice.unlock();
    if (event.button && event.button !== 0) return;
    stopDance();
    if (!event.isPrimary) {
      clearLongPress(false);
      pinching = true;
      suppressClick = true;
      cancelDrag();
      return;
    }
    if (pinching) return;
    fxSt.lastInteractAt = performance.now() / 1000;
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false
    };
    try { button.setPointerCapture(event.pointerId); } catch (_) {}
    clearLongPress(false);
    var touchHold = event.pointerType === "touch";
    var squeezeHold = false;
    if (button.classList.contains("is-nsfw") && !reduceMotion) {
      var pressId = event.pointerId;
      var pressX = event.clientX, pressY = event.clientY;
      var pressHit = cheekStrikeSplit(pressX, pressY);
      var pressZone = classifyChipZone(pressHit.uHit, pressHit.vHit);
      if (pressZone === "cheek" || pressZone === "thigh") {
        squeezeHold = true;
        longPressTimer = window.setTimeout(function () {
          longPressTimer = 0;
          if (stillHolding(pressId) && startSqueeze(pressX, pressY)) {
            suppressClick = true;
            if (navigator.vibrate) { try { navigator.vibrate(14); } catch (_) {} }
          }
        }, 280);
      }
    }
    // iPhone has no right-click: on head/tail a hold spanks at ~0.55 s; on every zone a longer hold
    // (~1.25 s) opens the title editor. Cheek/thigh squeeze at 280 ms and stay squeezed until the lift.
    var holdId = event.pointerId;
    if (touchHold && !squeezeHold && button.classList.contains("is-nsfw")) {
      longPressTimer = window.setTimeout(function () {
        longPressTimer = 0;
        if (!stillHolding(holdId)) return;
        suppressClick = true;
        spankBooty();
        if (navigator.vibrate) { try { navigator.vibrate(18); } catch (_) {} }
      }, 550);
    }
    if (touchHold && SongUnit) {
      titleHoldTimer = window.setTimeout(function () {
        titleHoldTimer = 0;
        if (!stillHolding(holdId)) return;
        suppressClick = true;
        if (navigator.vibrate) { try { navigator.vibrate([12, 40, 12]); } catch (_) {} }
        openSongTitleEditor();
      }, 1250);
    }
  });

  button.addEventListener("pointermove", function (event) {
    if (!drag && !pinching && event.buttons === 0 && event.pointerType !== "touch" &&
        button.classList.contains("is-nsfw") && !reduceMotion) {
      var nowMs = performance.now();
      var dtMs = nowMs - spankSwipe.t;
      if (spankSwipe.t > 0 && dtMs > 2 && dtMs < 90) {
        var swDx = event.clientX - spankSwipe.x;
        var swDy = event.clientY - spankSwipe.y;
        var dist = Math.hypot(swDx, swDy);
        var speed = dist / (dtMs / 1000);
        var brush = cheekStrikeSplit(event.clientX, event.clientY);
        var hoverZone = classifyChipZone(brush.uHit, brush.vHit);
        if (hoverZone === "head") {
          fxSt.teaseHoverAt = 0;
          if (brush.vHit >= 0.68 && brush.vHit <= 0.84 && ((brush.uHit >= 0.27 && brush.uHit <= 0.38) || (brush.uHit >= 0.52 && brush.uHit <= 0.63))) {
            fxSt.cupListenUntil = Math.max(fxSt.cupListenUntil, performance.now() / 1000 + 0.35);
            if (brush.uHit < 0.45) fxSt.cupTiltL = Math.max(fxSt.cupTiltL, 0.55);
            else fxSt.cupTiltR = Math.max(fxSt.cupTiltR, 0.55);
          }
          if (dist >= 2 && speed < 900) triggerHeadPet(brush, false);
        } else if (hoverZone === "tail") {
          fxSt.teaseHoverAt = 0;
          if (dist >= 2) triggerTailTease(brush, false);
        } else {
          if (!fxSt.teaseHoverAt) fxSt.teaseHoverAt = nowMs;
          if (speed >= 720 && dist >= 12 && (nowMs - spankSwipe.lastAt) >= 220) {
            spankSwipe.lastAt = nowMs;
            spankBooty(
              { clientX: event.clientX, clientY: event.clientY, swipeX: swDx / dist, swipeY: swDy / dist },
              Math.max(0.78, Math.min(1.45, speed / 1350))
            );
          } else if (dist >= 4 && speed >= 220) {
            // Medium cursor slide softly yields and nudges the cheek/thigh beneath the pointer before snapping.
            var dirX = swDx / dist, dirY = swDy / dist;
            var touch = Math.min(1, (speed - 220) / 500) * Math.min(1.4, dist / 14);
            bootyPhys.jlvx += dirX * 14 * touch * brush.hitL;
            bootyPhys.jlvy += dirY * 14 * touch * brush.hitL;
            bootyPhys.jrvx += dirX * 14 * touch * brush.hitR;
            bootyPhys.jrvy += dirY * 14 * touch * brush.hitR;
            bootyPhys.spankPressL = Math.min(0.025, bootyPhys.spankPressL + 0.008 * touch * brush.hitL);
            bootyPhys.spankPressR = Math.min(0.025, bootyPhys.spankPressR + 0.008 * touch * brush.hitR);
            if (Math.abs(bootyPhys.dent) < 0.32) {
              var brushDent = resolveDentTarget(brush.uHit, brush.vHit, brush.side);
              bootyPhys.dentU = brushDent.u;
              bootyPhys.dentVpos = brushDent.v;
              bootyPhys.dentSide = brush.side;
              bootyPhys.dentDirX = dirX;
              bootyPhys.dentDirY = dirY;
              bootyPhys.dent = Math.min(0.32, bootyPhys.dent + 0.08 * touch);
              bootyPhys.dentV = Math.min(7.5, bootyPhys.dentV + 3.4 * touch);
            }
            ensureBootyRaf();
          } else if ((nowMs - fxSt.teaseHoverAt) >= 1800 && (!fxSt.teaseSaidAt || (nowMs - fxSt.teaseSaidAt) >= 11500) && !musicPlaying()) {
            fxSt.teaseSaidAt = nowMs;
            showReaction("tease", NSFW_TEASE_HOVER_LINES, false, { type: true });
          }
        }
      } else if (spankSwipe.t > 0 && dtMs >= 90) {
        var stayHit = cheekStrikeSplit(event.clientX, event.clientY);
        var stayZone = classifyChipZone(stayHit.uHit, stayHit.vHit);
        if (stayZone === "head" || stayZone === "tail") {
          fxSt.teaseHoverAt = 0;
        } else {
          if (!fxSt.teaseHoverAt) fxSt.teaseHoverAt = nowMs;
          else if ((nowMs - fxSt.teaseHoverAt) >= 1800 && (!fxSt.teaseSaidAt || (nowMs - fxSt.teaseSaidAt) >= 11500) && !musicPlaying()) {
            fxSt.teaseSaidAt = nowMs;
            showReaction("tease", NSFW_TEASE_HOVER_LINES, false, { type: true });
          }
        }
      }
      spankSwipe.x = event.clientX;
      spankSwipe.y = event.clientY;
      spankSwipe.t = nowMs;
    }
    if (!drag || event.pointerId !== drag.id) return;
    var dx = event.clientX - drag.startX;
    var dy = event.clientY - drag.startY;
    var ddx = event.clientX - drag.lastX;
    var ddy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      clearLongPress(false);
      suppressClick = true;
      dock.classList.add("is-dragging");
    }
    var prevX = pos.x, prevY = pos.y;
    pos.x = drag.origX + dx;
    pos.y = drag.origY + dy;
    applyPosition();
    nudgeBooty(ddx, ddy, pos.x - prevX, pos.y - prevY);
    if (event.cancelable) event.preventDefault();
  });

  button.addEventListener("pointerup", function () {
    var wasSqueeze = fxSt.squeezeActive;
    clearLongPress(true);
    if (wasSqueeze && !pinching) {
      window.setTimeout(function () { if (!drag) suppressClick = false; }, 120);
    }
  });
  button.addEventListener("pointercancel", function () {
    clearLongPress(false);
    if (!pinching) {
      window.setTimeout(function () { if (!drag) suppressClick = false; }, 0);
    }
  });
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);

  function trackSpeed(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (1.12 + ((hash >>> 0) % 27) / 100).toFixed(2) + "s";
  }

  function computeTrackIntensity(item, track, artist, trackId) {
    if (item && Number.isFinite(Number(item.energy))) {
      return Math.max(0.35, Math.min(1.35, 0.35 + Number(item.energy) * 0.95));
    }
    var hay = (String(track || "") + " " + String(artist || "")).toLowerCase();
    var base = 0.72;
    if (trackId) {
      var hash = 2166136261;
      for (var i = 0; i < trackId.length; i += 1) {
        hash ^= trackId.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      base = 0.64 + ((hash >>> 0) % 30) / 100;
    }
    if (/(phonk|batidao|drift|hardstyle|rave|techno|dubstep|dnb|drum.?n.?bass|metal|punk|hyperpop|rage|sped up|nightcore|ultra|extreme|overload|slxughter|kordhell|dvrst|mick gordon|skrillex)/.test(hay)) {
      base += 0.36;
    }
    if (/(slowed|reverb|lofi|lo-fi|chill|ambient|acoustic|piano|ballad|sleep|rain|soft|jazz|bossa|nocturne|dream)/.test(hay)) {
      base -= 0.28;
    }
    return Math.max(0.38, Math.min(1.32, base));
  }

  function danceReady() {
    return !!(
      musicPlaying() &&
      available &&
      !document.hidden &&
      !reduceMotion &&
      !drag &&
      !pinching &&
      bootyPhys.phKind !== 1 && bootyPhys.phKind !== 3 &&
      bootyPhys.phKind !== 4 && bootyPhys.fig8Gain < 0.15 &&
      bootyPhys.phAmp > 0.7 &&
      bootyPhys.coilT === 0 &&
      bootyPhys.dropAge < 0 &&
      bootyPhys.dropGain < 0.1 &&
      gesture.kind !== "listen" &&
      !danceWrap.classList.contains("is-react")  // a reaction pose owns the wrapper; the beat dance waits
    );
  }

  function stopDance() {
    if (danceStopTimer) window.clearTimeout(danceStopTimer);
    danceStopTimer = 0;
    danceWrap.classList.remove("is-dancing");
  }

  function pointerOverChip() {
    if (!button.matches) return false;
    // iOS keeps :hover "stuck" after a tap, which would block her dance forever.
    var canHover = true;
    try { canHover = !!(window.matchMedia && window.matchMedia("(hover: hover)").matches); } catch (_) {}
    return (canHover && button.matches(":hover")) || button.matches(":focus-visible");
  }

  function playEntrance() {
    if (reduceMotion) return;
    if (entranceTimer) window.clearTimeout(entranceTimer);
    danceWrap.classList.remove("is-entering");
    void danceWrap.offsetWidth;
    danceWrap.classList.add("is-entering");
    if (button.classList.contains("is-nsfw")) {
      window.setTimeout(function () {
        if (button.classList.contains("is-nsfw") && !drag) {
          bootyPhys.vy -= 42;
          ensureBootyRaf();
        }
      }, 280);
    }
    entranceTimer = window.setTimeout(function () {
      entranceTimer = 0;
      danceWrap.classList.remove("is-entering");
      applyListen();
    }, 700);
  }

  function clearExit() {
    if (exitTimer) window.clearTimeout(exitTimer);
    exitTimer = 0;
    danceWrap.classList.remove("is-exiting");
  }

  function playExit() {
    if (dock.hidden || exitTimer) return;
    if (reduceMotion) {
      dock.hidden = true;
      return;
    }
    danceWrap.classList.remove("is-entering");
    danceWrap.classList.add("is-exiting");
    exitTimer = window.setTimeout(function () {
      exitTimer = 0;
      danceWrap.classList.remove("is-exiting");
      if (!available) {
        dock.hidden = true;
        haltMotion();
      }
    }, 300);
  }

  // The remaining full-chip reactions share the dance wrapper.
  var REACTIONS = { shrug: 1100, spin: 1200, droop: 1500, lean: 1100, final: 2900 };
  var reactTimer = 0;
  var listening = false;
  var listenPending = false;

  function reactionBusy() {
    return reduceMotion || !available || document.hidden || drag || pinching ||
      danceWrap.classList.contains("is-entering") || danceWrap.classList.contains("is-exiting");
  }

  function clearReaction() {
    Array.prototype.slice.call(danceWrap.classList).forEach(function (name) {
      if (name === "is-react" || name.indexOf("react-") === 0) danceWrap.classList.remove(name);
    });
  }

  function applyListen(nowS) {
    if (!listenPending || gesture.kind || reactionBusy() || danceWrap.classList.contains("is-react")) return;
    if (startGesture("listen", nowS)) {
      listenPending = false;
      stopDance();
    }
  }

  function stopListening() {
    listening = listenPending = false;
    if (gesture.kind === "listen") gesture.kind = "";
  }

  function playReaction(kind) {
    if (kind === "listen-on") {
      if (!listening) { listening = listenPending = true; applyListen(); }
      return;
    }
    if (kind === "listen-off") {
      stopListening();
      return;
    }
    if (kind === "smile" || kind === "surprise" || kind === "jump" || kind === "start" || kind === "nod") {
      if (startGesture(kind === "smile" || kind === "nod" ? "smile" : "surprise")) {
        stopDance();
        clearReaction();
        window.clearTimeout(reactTimer);
      }
      return;
    }
    if (!REACTIONS[kind] || reactionBusy()) return;
    gesture.kind = "";
    stopDance();
    clearReaction();
    void danceWrap.offsetWidth;  // restart the animation if the same pose repeats
    danceWrap.classList.add("is-react", "react-" + kind);
    window.clearTimeout(reactTimer);
    reactTimer = window.setTimeout(function () { clearReaction(); applyListen(); }, REACTIONS[kind] + 80);
  }

  window.addEventListener("hq:musica-react", function (ev) {
    playReaction(ev && ev.detail && ev.detail.kind);
  });

  function triggerDance() {
    if (!danceReady() || danceWrap.classList.contains("is-dancing")) return;
    if (pointerOverChip()) return;
    danceWrap.classList.add("is-dancing");
    if (button.classList.contains("is-nsfw")) {
      bootyPhys.vy -= 54;
      bootyPhys.vx += (beatCount % 2 === 0 ? 32 : -32);
      ensureBootyRaf();
    }
    danceStopTimer = window.setTimeout(finishDance, 3500);
  }

  function finishDance() {
    if (!danceWrap.classList.contains("is-dancing")) return;
    stopDance();
  }

  // Called once a beat by the shared clock (or twice per halo cycle when the clock is not running, in SFW).
  function onHaloBeat(beatIndex) {
    beatCount += 1;
    if (beatCount < nextDanceBeat) return;
    if ((beatIndex != null ? beatIndex : beatCount) % 4 !== 0) return;   // start on a bar line
    if (!danceReady() || danceWrap.classList.contains("is-dancing") || pointerOverChip()) return;
    nextDanceBeat = beatCount + 48;
    triggerDance();
  }

  function setWaveLive(on) {
    var live = !!(((on && onMusiquePage() && playback.playing) || localAudio()) && available && !document.hidden);
    button.classList.toggle("is-wave-live", live);
    dock.classList.toggle("has-beat-tap", live);
    if (available && !document.hidden && button.classList.contains("is-nsfw")) {
      scheduleBlinkLoop();
    } else {
      stopBlinkLoop();
    }
    if (!live) {
      stopDance();
      startIdleBooty();
    } else {
      stopIdleBooty();
      startMusicTwerk();
    }
  }

  var playbackSyncedOnce = false;

  function applyPlayback(data) {
    if (!data || data.ok === false) return;
    var wasPlaying = playback.playing;
    var prevTrackId = playback.trackId;
    var prevVol = playback.volume;
    var item = data.item || null;
    var nextTrack = item ? String(item.id || item.uri || item.name || "") : "";
    var nextPlaying = !!data.playing && !!item;
    var changed = nextPlaying !== playback.playing || nextTrack !== playback.trackId;
    // Explicit *_percent fields are always 0-100 (so 1 means 1%); only a bare `volume` is unit-guessed.
    var rawVol = null, normVol = 0;
    if (data.device && data.device.volume_percent != null && Number.isFinite(Number(data.device.volume_percent))) {
      rawVol = 1; normVol = Number(data.device.volume_percent) / 100;
    } else if (data.volume_percent != null && Number.isFinite(Number(data.volume_percent))) {
      rawVol = 1; normVol = Number(data.volume_percent) / 100;
    } else if (data.volume != null && Number.isFinite(Number(data.volume))) {
      rawVol = 1; normVol = Number(data.volume) > 1 ? Number(data.volume) / 100 : Number(data.volume);
    }
    if (rawVol !== null) {
      playback.volume = Math.max(0.18, Math.min(1.18, 0.25 + Math.max(0, normVol) * 0.93));
    }
    playback.playing = nextPlaying;
    if (data.progress_ms != null && Number.isFinite(Number(data.progress_ms))) {
      playback.progressMs = Math.max(0, Number(data.progress_ms));
      playback.progressAt = Date.now();
    }
    if (item && item.duration_ms != null && Number.isFinite(Number(item.duration_ms))) {
      playback.durationMs = Math.max(0, Number(item.duration_ms));
    }
    playback.track = item ? String(item.name || "") : "";
    playback.album = (item && item.album && item.album.name) ? String(item.album.name) : "";
    playback.artist = item
      ? (Array.isArray(item.artists)
          ? item.artists.map(function (a) { return typeof a === "string" ? a : (a && a.name ? a.name : ""); }).filter(Boolean).join(", ")
          : String(item.artist || ""))
      : "";
    // One poller for the whole page: Accueil listens instead of asking Spotify again.
    try {
      window.dispatchEvent(new CustomEvent("hq:playback", {
        detail: { playing: playback.playing, track: playback.track, artist: playback.artist },
      }));
    } catch (_) {}
    if (nextTrack !== playback.trackId) {
      playback.trackId = nextTrack;
      playback.intensity = computeTrackIntensity(item, playback.track, playback.artist, nextTrack);
      if (!localAudio()) syncBeatKey(null);   // the clock's guess, the stored grid, the halo and dance tempo
      stopDance();
      if (nextPlaying && playback.track) {
        window.setTimeout(fetchAmbientWhisper, 3500);
        danceGen.lines = {};   // the previous pack may name the previous song
        if (button.classList.contains("is-nsfw")) window.setTimeout(function () { danceGenFetch(true); }, 1500);
      }
    }
    if (playbackSyncedOnce && button.classList.contains("is-nsfw") && !reduceMotion && !document.hidden) {
      var nowPb = performance.now() / 1000;
      var pausedNow = wasPlaying && (!nextPlaying || (rawVol !== null && normVol <= 0.02 && prevVol > 0.28));
      if (pausedNow) {
        fxSt.pout = 1;
        fxSt.poutUntil = nowPb + 4.5;
        fxSt.sulk = Math.min(1, fxSt.sulk + 0.45);
        mouthSt.happy = 0;
        triggerShiver(0.55);
        ensureBootyRaf();
        showReaction("pause", NSFW_PAUSE_LINES, true, { type: true, voice: true });
      } else if (!wasPlaying && nextPlaying) {
        fxSt.pout = 0;
        fxSt.poutUntil = 0;
        fxSt.sulk = 0;
        mouthSt.happy = Math.max(mouthSt.happy, 1.8);
        if (playback.intensity >= 1.0) tailAnim.excite = Math.max(tailAnim.excite, 0.9);
        if (!gesture.kind) startGesture("smile", nowPb);
        ensureBootyRaf();
        if (lateNightHour() && chipMem.greetedDay !== chipMem.dayKey) {
          chipMem.greetedDay = chipMem.dayKey;
          saveChipMemory();
          showReaction("slow", NSFW_LATE_NIGHT_LINES, true, { type: true, voice: true });
        }
      } else if (prevTrackId && nextTrack && nextTrack !== prevTrackId && nextPlaying) {
        fxSt.skipTimes = fxSt.skipTimes.filter(function (t) { return (nowPb - t) < 25; });
        fxSt.skipTimes.push(nowPb);
        triggerBlink();
        if (fxSt.skipTimes.length >= 3) {
          fxSt.skipTimes = [];
          fxSt.pout = Math.max(fxSt.pout, 0.75);
          fxSt.poutUntil = nowPb + 3.0;
          showReaction("skip", NSFW_SKIP_STREAK_LINES, true, { type: true, voice: true });
        } else {
          if (!gesture.kind) startGesture("listen", nowPb);
          if (playback.intensity >= 1.0) tailAnim.excite = Math.max(tailAnim.excite, 0.95);
          if (playback.track && !concealedNow() && playback.intensity >= 0.92 && Math.random() < 0.45) {
            showNsfwBubble(
              pickReactionLine(NSFW_TRACK_VIBE_LINES).replace("{t}", playback.track.slice(0, 32)),
              false, false, { type: true }
            );
          }
        }
        bootyPhys.vy -= 22;
        ensureBootyRaf();
      }
      if (rawVol !== null && normVol >= 0.90 && prevVol < 1.07 && (!fxSt.lastLoudAt || (nowPb - fxSt.lastLoudAt) >= 12)) {
        fxSt.lastLoudAt = nowPb;
        triggerFleshWave(0.85, true);
        triggerShiver(0.75);
        mouthSt.gasp = Math.max(mouthSt.gasp, 0.42);
        fxSt.effort = Math.min(1, fxSt.effort + 0.4);
        tailAnim.excite = 1;
        bodySfx.gasp(1.12);
        ensureBootyRaf();
        showReaction("loud", NSFW_LOUD_LINES, true, { type: true, voice: true });
      }
    }
    playbackSyncedOnce = true;
    pollFailures = 0;
    if (changed) setWaveLive(playback.playing);
  }

  function stopPlaybackPoll() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function schedulePlaybackPoll(delay) {
    stopPlaybackPoll();
    if (!onMusiquePage() || !available || document.hidden) return;
    pollTimer = window.setTimeout(fetchPlayback, delay);
  }

  function nextPlaybackPollDelay() {
    var freshEvent = Date.now() - lastPlaybackEventAt < 6000;
    if (playback.playing) return freshEvent ? 15000 : 8000;
    return 20000;
  }

  function fetchPlayback() {
    if (pollBusy || !onMusiquePage() || !available || document.hidden) return;
    var adapter = typeof window.api === "function" ? window.api : null;
    if (!adapter) {
      schedulePlaybackPoll(15000);
      return;
    }
    stopPlaybackPoll();
    pollBusy = true;
    adapter("/api/spotify/player", { timeoutMs: 8000 }).then(function (data) {
      pollBusy = false;
      if (data && data.ok !== false) applyPlayback(data);
      schedulePlaybackPoll(nextPlaybackPollDelay());
    }).catch(function () {
      pollBusy = false;
      pollFailures += 1;
      if (pollFailures >= 4 && playback.playing) {
        playback.playing = false;
        setWaveLive(false);
      }
      schedulePlaybackPoll(Math.min(60000, 8000 * Math.pow(2, Math.min(3, pollFailures))));
    });
  }

  window.addEventListener("hq:music-playback", function (event) {
    lastPlaybackEventAt = Date.now();
    applyPlayback(event && event.detail);
  });
  window.addEventListener("hq:music-tab", function (event) {
    activeMusicTab = event.detail && event.detail.tab ? String(event.detail.tab).slice(0, 32) : "";
    if (event.detail && event.detail.tab !== "quiz") stopListening();
    syncAvailability();
  });
  window.addEventListener("hashchange", syncAvailability);

  danceWrap.addEventListener("animationend", function (event) {
    if (event.animationName === "hq-musica-chip-dance") finishDance();
  });

  // When the physics loop is not running (SFW), the halo cycle (two beats of the clock's tempo) paces the dance.
  wave.firstElementChild.addEventListener("animationiteration", function (event) {
    if (event.animationName !== "hq-musica-chip-wave-bar" || motionReady()) return;
    onHaloBeat();
    onHaloBeat();
  });

  function adultOn() {
    try {
      return typeof window.hqCompanionNsfwOn === "function" && !!window.hqCompanionNsfwOn();
    } catch (_) {
      return false;
    }
  }

  // Stop everything the adult/animated chip owns: body loop, pending timers, reactions, particles, bubble and sound.
  function haltMotion() {
    stopIdleBooty();
    stopBlinkLoop();
    if (bootyPhys.raf) window.cancelAnimationFrame(bootyPhys.raf);
    bootyPhys.raf = 0;
    resetBootyState();
    stopTailAnim();
    if (blushTimer) { window.clearTimeout(blushTimer); blushTimer = 0; }
    button.classList.remove("is-blushing");
    window.clearTimeout(reactTimer);
    stopListening();
    clearReaction();
    while (fxLayer.firstChild) fxLayer.removeChild(fxLayer.firstChild);
    if (bubbleTimer) { window.clearTimeout(bubbleTimer); bubbleTimer = 0; }
    if (bubbleTypeTimer) { window.clearInterval(bubbleTypeTimer); bubbleTypeTimer = 0; }
    var old = dock.querySelector(".hq-musica-chip-bubble");
    if (old) old.remove();
    clearLongPress(false);
    chipVoice.stop();
    bodySfx.stop();
    stage.style.transform = "";
  }

  var reduceMq = null;
  try { reduceMq = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)"); } catch (_) {}
  if (reduceMq) {
    var onReduceChange = function (ev) {
      reduceMotion = !!ev.matches;
      if (reduceMotion) {
        haltMotion();
      } else {
        applyMode();
        setWaveLive(playback.playing);
      }
    };
    if (reduceMq.addEventListener) reduceMq.addEventListener("change", onReduceChange);
    else if (reduceMq.addListener) reduceMq.addListener(onReduceChange);
  }

  function applyMode() {
    var wasAdult = button.classList.contains("is-nsfw");
    var adult = adultOn();
    button.classList.toggle("is-nsfw", adult);
    button.setAttribute("aria-label", adult
      ? "Musica — adult mode, open the music steward"
      : "Musica — open the music steward");
    button.title = adult
      ? "Musica — adult mode · drag · pinch = size"
      : "Musica — drag · pinch or Ctrl+wheel = size · +/− on the keyboard";
    if (adult) {
      if (art.getAttribute("src") !== ART) {
        art.src = ART;
        art.srcset = ART + " 1x, " + ART_2X + " 2x";
        tailTipArt.src = TAIL_ART;
        tailTipArt.srcset = TAIL_ART + " 1x, " + TAIL_ART_2X + " 2x";
        tailSrc.src = TAIL_ART_2X;
        EARS.forEach(function (ear, k) { ear.src.src = EAR_ART[k]; ear.img.src = EAR_ART[k]; });
        warpState.texReady = false;
      }
      if (!wasAdult) {
        showNsfwBubble(NSFW_MODE_LINES[bubbleIdx++ % NSFW_MODE_LINES.length]);
      }
      startMusicTwerk();
      startIdleBooty();
      scheduleBlinkLoop();
      window.setTimeout(function () { danceGenFetch(false); }, 2500);   // her own spank / shake lines, written ahead
      return;
    }
    haltMotion();
    art.removeAttribute("src");
    art.removeAttribute("srcset");
    tailTipArt.removeAttribute("src");
    tailTipArt.removeAttribute("srcset");
    tailSrc.removeAttribute("src");
    EARS.forEach(function (ear) { ear.src.removeAttribute("src"); ear.img.removeAttribute("src"); });
    warpState.texReady = false;
    hideWarpCanvas();
    var oldBubble = dock.querySelector(".hq-musica-chip-bubble");
    if (oldBubble) oldBubble.remove();
    button.classList.remove("is-art-error");
  }

  function onMusiquePage() {
    return !!(document.body && document.body.dataset.view === "musique");
  }

  function syncAvailability() {
    var local = document.body.dataset.view === "lecteur" && activeLyricTrack();
    var show = onMusiquePage() || (local && local.audio.id === "player-audio");
    if (show) {
      var wasAvailable = available;
      clearExit();
      dock.hidden = false;
      available = true;
      applyPosition(true);
      if (!wasAvailable) { sfx("open"); playEntrance(); refreshConceal(true); }
      setWaveLive(onMusiquePage() && playback.playing);
      if (local) {
        stopPlaybackPoll();
        ensureBootyRaf();
      }
      fetchPlayback();
      return;
    }
    available = false;
    if (entranceTimer) window.clearTimeout(entranceTimer);
    entranceTimer = 0;
    danceWrap.classList.remove("is-entering");
    setWaveLive(false);
    stopPlaybackPoll();
    if (!dock.hidden) playExit();
  }

  function openMusica() {
    var nav = document.getElementById("nav-musique");
    if (nav && !nav.hidden && document.body.dataset.view !== "musique") {
      nav.click();
    } else if (typeof window.setView === "function" && document.body.dataset.view !== "musique") {
      window.setView("musique");
    }
    var attempts = 0;
    var timer = window.setInterval(function () {
      var tab = document.getElementById("hqm-tab-musica");
      if (tab) {
        window.clearInterval(timer);
        tab.click();
      } else if (++attempts > 50) {
        window.clearInterval(timer);
      }
    }, 100);
  }

  var chipScale = null;
  if (window.HqImageChipScale && typeof window.HqImageChipScale.bind === "function") {
    chipScale = window.HqImageChipScale.bind(window, {
      root: dock,
      chip: button,
      storageKey: LS_SCALE,
      setBlocked: setBlocked,
      cancelDrag: cancelDrag
    });
  }

  button.addEventListener("click", function (event) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    openMusica();
  });

  // Right-click: open the chip's own title editor (same control on Lecteur and Musique).
  button.addEventListener("contextmenu", function (event) {
    if (!SongUnit) return;
    event.preventDefault();
    openSongTitleEditor();
  });

  button.addEventListener("keydown", function (event) {
    if ((event.key === "t" || event.key === "T") && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      beatTapNow();
      return;
    }
    if (!chipScale) return;
    var step = chipScale.menuStep || 0.08;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      chipScale.bump(step);
    } else if (event.key === "-") {
      event.preventDefault();
      chipScale.bump(-step);
    } else if (event.key === "0") {
      event.preventDefault();
      chipScale.resetScale();
    }
  });

  window.addEventListener("hq:companion-nsfw", applyMode);
  window.addEventListener("storage", function (event) {
    if (!event.key || event.key === LS_NSFW) applyMode();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      setWaveLive(false);
      stopPlaybackPoll();
      haltMotion();
      return;
    }
    applyMode();
    if (!available) return;
    setWaveLive(playback.playing);
    fetchPlayback();
  });
  window.addEventListener("resize", function () {
    applyPosition(true);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(function () { applyPosition(); }).observe(button);
  }

  window.hqMusicaBindLyricAudio = bindLyricAudio;
  // Read-only snapshot for browser tests and agents (squeeze, hold state, spanks this page life).
  window.hqMusicaChipDebug = function () {
    return {
      squeeze: !!fxSt.squeezeActive, holding: !!drag, moved: !!(drag && drag.moved),
      pinching: pinching, available: available, spanks: spankTotal
    };
  };
  var playerAudio = document.getElementById("player-audio");
  if (playerAudio) bindLyricAudio(playerAudio);
  syncAvailability();
  var nav = document.getElementById("nav-musique");
  if (nav && window.MutationObserver) {
    new MutationObserver(syncAvailability).observe(nav, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }
  if (window.MutationObserver && document.body) {
    new MutationObserver(syncAvailability).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-view"]
    });
  }

  applyPosition();
  applyMode();
  window.setTimeout(applyMode, 1400);
})();
