/* Transfert HQ — compact floating Musica chip.
   SFW: neutral music note. Adult mode: the full-body Musica portrait.
   Draggable; pinch / Ctrl+wheel resizes; position and scale persist locally. */
(function () {
  "use strict";

  var ID = "hq-musica-chip";
  if (document.getElementById(ID)) return;

  var ART = "/assets/companion/musica-chip-nsfw-notail-noears.webp?v=3";
  var ART_2X = "/assets/companion/musica-chip-nsfw-notail-noears@2x.webp?v=3";
  var TAIL_ART = "/assets/companion/musica-tail-overlay.webp?v=2";
  var TAIL_ART_2X = "/assets/companion/musica-tail-overlay@2x.webp?v=2";
  var LS_NSFW = "hq_companion_nsfw";
  var LS_POS = "hq_musica_chip_pos_v1";
  var LS_SCALE = "hq_musica_chip_scale_v1";
  var DRAG_THRESHOLD = 7;

  var dock = document.createElement("div");
  dock.id = "hq-musica-chip-dock";
  dock.className = "hq-musica-chip-dock";
  dock.hidden = true;

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  button.className = "hq-musica-chip";
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
  var tailLink = { rx: 0, ry: 0, rootAngle: 0, dx: 0, dy: 0, twerk: 0, phase: 0, ripple: 0, stretch: 0, blinking: false, beat: 0, music: 0, hx: 0, hy: 0, talk: 0, flush: 0,
    effort: 0, shy: 0, happy: 0, vx: 0, vy: 0, pdx: 0, pnear: 0, accent: 0, holding: false,
    headAngle: 0, curlPose: 0 };

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

    // Mood curl: tightens when excited / spanked, relaxes and straightens on a stretch or when she perks up.
    var moodDrift = L.holding ? 0 : 0.10 * Math.sin(T * 0.05 + 1.0) + 0.06 * Math.sin(T * 0.13);
    if (lively && T >= A.nextTwirl) {   // a playful curl-uncurl of the tip
      A.vcurl += (Math.random() < 0.5 ? -1 : 1) * 3.2;
      A.nextTwirl = T + 6 + Math.random() * 8;
    }
    var curlT = moodDrift + L.twerk * 0.2 + Math.min(1, L.ripple) * 0.8 - L.stretch * 0.55 -
      0.45 * Math.min(1, A.perk / 0.5) - (hovered ? 0.35 : 0) + 0.65 * A.shy - 0.15 * A.droop - 0.25 * L.happy;
    A.vcurl += (-9 * (A.curl - curlT) - 4.2 * A.vcurl) * dt;
    A.curl += A.vcurl * dt;
    // Loose hook at the tip (spank / stretch / shy) and a gentle S through the body of the tail.
    var hookT = 0.55 * Math.min(1, L.ripple) + 0.45 * A.shy + 0.30 * L.stretch;
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
    if (L.ripple - E.prevRipple > 0.3) {   // spank: ears flatten back, flash, small outward kick
      E.flat = 1; E.flash = 1;
      EARS.forEach(function (ear, k) { E.v[k] += ear.side * 1.2; });
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
    var flatAmt = E.flat * 0.16 + L.stretch * 0.08;
    var sway = -L.dx * 1.0;
    var age = T - gesture.at;
    for (i = 0; i < 2; i++) {
      var side = EARS[i].side;
      var target = side * flatAmt - side * (0.05 * perk + (hovered ? 0.04 : 0)) + sway;
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
    g = Math.max(g, L.talk * 0.7, E.flash);
    if (gesture.kind === "listen") g = Math.max(g, 0.32 * motionHold(age, 0, 0.18, 0.95, 1.6));
    E.glow += (g - E.glow) * Math.min(1, dt * 10);
  }

  function earDraw(ctx, s) {
    var E = earAnim;
    var offX = tailLink.hx * 1024 * s, offY = tailLink.hy * 1024 * s;
    var c = Math.cos(tailLink.headAngle), sn = Math.sin(tailLink.headAngle);
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
      var px = ear.piv[0] - HEAD_PIVOT[0] * 1024, py = ear.piv[1] - HEAD_PIVOT[1] * 1024;
      ctx.translate((ear.piv[0] + (c - 1) * px - sn * py) * s + offX,
        (ear.piv[1] + sn * px + (c - 1) * py) * s + offY);
      ctx.rotate(tailLink.headAngle + E.th[i]);
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
  var nextDanceBeat = 8;
  var danceStopTimer = 0;
  var entranceTimer = 0;
  var exitTimer = 0;

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
      pos.x = clampNum(pos.x, pad - baseLeft, vw - pad - dock.offsetWidth - baseLeft);
      pos.y = clampNum(pos.y, pad - baseTop, vh - pad - dock.offsetHeight - baseTop);
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
    if (!moved) return;
    applyPosition(true);
    suppressClick = true;
    window.setTimeout(function () { suppressClick = false; }, 0);
  }

  var bootyPhys = {
    x: 0, y: 0, vx: 0, vy: 0,
    twerkGain: 0, twerkPhase: 0,
    orbitGain: 0, fig8Gain: 0, fig8Beat: 0, fig8Direction: 1,
    dropGain: 0, dropTimer: 0, dropAge: -1, comboKind: "", comboGap: 0, comboSide: 1,
    comboCancelAt: -1, nextAccentCombo: "ripple", beatWraps: 0,
    ripple: 0, rippleTime: 0,
    blink: 0, blinkPhase: 0, blinking: false,
    // Soft-tissue jiggle: each cheek chases the body spring with its own stiffer, lightly damped spring.
    jlx: 0, jly: 0, jlvx: 0, jlvy: 0, jrx: 0, jry: 0, jrvx: 0, jrvy: 0, prevX: 0, prevY: 0,
    jLx: 0, jLy: 0, jRx: 0, jRy: 0,
    // Hips lag the body a little; the cheeks chase the hips (travelling wave). mL/mR: per-spank mass drift.
    hlx: 0, hly: 0, hlvx: 0, hlvy: 0, phx: 0, phy: 0, mL: 1, mR: 1,
    // Outward ripple from the cheeks to the thighs (amplitude + time since the hit).
    wave: 0, waveT: 0,
    // Choreography: anticipation coil, idle weight shifts, dance phrases (normal / half / double time / pause).
    coilT: 0, coil: 0, prevPlaying: false, prevDrop: false, settleUntil: 0,
    phKind: 0, phUntil: 0, phRate: 1, phAmp: 1, phCount: 0, blinkDur: 0.28, bAs: 0, coilKind: "start", danceSince: 0,
    rollSide: 1, rollLead: 1, slowRoll: 0, holdSide: 0, hipWeight: 0, cameraStill: 0,
    raf: 0, lastTs: 0
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
      if (dr.left - 12 - w >= 8) return;
      if (dr.right + 10 + w <= vw - 8) {
        b.style.right = "auto";
        b.style.left = "calc(100% + 10px)";
        b.classList.add("is-right");
        return;
      }
      b.style.maxWidth = Math.max(180, vw - 24) + "px";
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
    var bubbleMs = force ? Math.max(4500, Math.min(11000, 3500 + String(b.textContent).length * 55)) : 5500;
    bubbleTimer = window.setTimeout(function () {
      if (b.parentNode) b.remove();
    }, bubbleMs);
    if (force && !gesture.kind && !listening && !(opts && opts.quietFace)) startGesture("smile");
    if (shakeGen) danceGenUse("shake");
    return true;
  }

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
  var DANCE_KINDS = ["start", "drop", "slow", "fast", "look", "tired", "end", "spank", "shake"];
  var danceGen = { lines: {}, inflight: false, at: 0 };

  function danceGenLeft() {
    var n = 0;
    DANCE_KINDS.forEach(function (k) { n += (danceGen.lines[k] || []).length; });
    return n;
  }

  // Generated lines for the spank / shake reactions: peek, show, then consume (so a throttled bubble loses nothing).
  function danceGenPeek(kind) {
    var a = danceGen.lines[kind];
    return !window.__hqBlindMatch && danceTalkOn() && a && a.length ? a[0] : "";
  }
  function danceGenUse(kind) {
    var a = danceGen.lines[kind];
    if (a && a.length) a.shift();
    if (!a || !a.length) danceGenFetch(false);
  }

  async function danceGenFetch(force) {
    if (danceGen.inflight || document.hidden || !available || !danceTalkOn() || window.__hqBlindMatch) return;
    var now = Date.now();
    if (!force && now - danceGen.at < 90000) return;
    danceGen.inflight = true;
    danceGen.at = now;
    var askTrack = playback.track || "", askAdult = adultOn();
    var ctl =window.AbortController ? new AbortController() : null;
    var abortTimer = ctl ? window.setTimeout(function () { ctl.abort(); }, 22000) : 0;
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
          artist: playback.artist || "",
          intensity: playback.intensity
        })
      });
      if (!res.ok) return;
      var data = await res.json();
      var got = data && data.lines && typeof data.lines === "object" ? data.lines : null;
      // Stale answer (track changed, adult mode flipped, commentary off, blind match started): drop it.
      if (!got || window.__hqBlindMatch || !danceTalkOn() || adultOn() !== askAdult || (playback.track || "") !== askTrack) return;
      var next = {};
      DANCE_KINDS.forEach(function (k) {
        var arr = Array.isArray(got[k]) ? got[k] : [];
        next[k] = arr.filter(function (t) { return typeof t === "string" && t.length >= 6 && t.length <= 120; }).slice(0, 3);
      });
      var total = 0;
      DANCE_KINDS.forEach(function (k) { total += next[k].length; });
      if (total) danceGen.lines = next;   // an empty answer (cooldown, failure) keeps what we have
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
    var generated = !window.__hqBlindMatch && danceTalkOn() && danceGen.lines[kind] && danceGen.lines[kind].length ? danceGen.lines[kind] : null;
    var pick;
    if (generated) {
      pick = generated[0];
    } else {
      var pool = (DANCE_LINES[kind] || []).slice();
      if (!window.__hqBlindMatch && (playback.track || playback.artist) && DANCE_TRACK_LINES[kind]) {
        var tt = String(playback.track || "").slice(0, 40), aa = String(playback.artist || "").split(",")[0].slice(0, 40);
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
    if (showNsfwBubble(pick, false, false, { type: true, dance: true })) {
      danceTalkLast[kind] = pick;
      danceTalkAt = now + 9000 + Math.random() * 6000;
      if (generated) generated.shift(); else if (danceBag[kind]) danceBag[kind].pop();
      if (danceGenLeft() < 6) danceGenFetch(false);
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

  var ambientInFlight = false;
  async function fetchAmbientWhisper() {
    if (window.__hqBlindMatch) return;  // blind match: no whisper may name the song that is playing
    if (ambientInFlight || drag || document.hidden || !onMusiquePage() || !available) return;
    ambientInFlight = true;
    try {
      var headers = { "Content-Type": "application/json" };
      if (typeof window.hqCsrfToken === "function") {
        var tok = window.hqCsrfToken();
        if (tok) headers["X-CSRF-Token"] = tok;
      }
      var res = await fetch("/api/musica/ambient", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: headers,
        body: JSON.stringify({
          nsfw: adultOn(),
          track: playback.track || "",
          artist: playback.artist || "",
          playing: !!playback.playing
        })
      });
      if (!res.ok) return;
      var data = await res.json();
      if (data && data.line && !window.__hqBlindMatch) {
        showNsfwBubble(data.line, true);
      }
    } catch (_) {
    } finally {
      ambientInFlight = false;
    }
  }

  window.setTimeout(fetchAmbientWhisper, 18000);
  window.setInterval(fetchAmbientWhisper, 65000);

  var warpState = {
    gl: null,
    failed: false,
    uPelvis: null,
    uScale: null,
    uBlink: null,
    uHead: null,
    uBackFlex: null,
    uJigL: null,
    uJigR: null,
    uWave: null,
    uMouth: null,
    uMouthB: null,
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
    gl.bindTexture(gl.TEXTURE_2D, warpState.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art);
    warpState.texReady = true;
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
    warpState.texReady = false;
    warpState.failed = false;
    hideWarpCanvas();
  });
  warpCanvas.addEventListener("webglcontextrestored", function () {
    warpState.gl = null;
    warpState.texReady = false;
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
      var vsSrc =
        "attribute vec2 a_pos;" +
        "varying vec2 v_uv;" +
        "void main(){" +
        "  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);" +
        "  gl_Position = vec4(a_pos, 0.0, 1.0);" +
        "}";
      var fsSrc =
        "#ifdef GL_FRAGMENT_PRECISION_HIGH\n" +
        "precision highp float;\n" +
        "#else\n" +
        "precision mediump float;\n" +
        "#endif\n" +
        "uniform sampler2D u_tex;" +
        "uniform vec4 u_pelvis;" +  // translation xy, cos and sin of the forward rotation
        "uniform vec2 u_scale;" +
        "uniform float u_blink;" +
        "uniform vec4 u_head;" +  // translation xy, cos and sin of the head tilt
        "uniform float u_shoulders;" +
        "uniform float u_smirk;" +
        "uniform float u_backFlex;" +
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
        "varying vec2 v_uv;" +
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
        "  float yLid = (-1.08 - ext) + blink * (1.96 + ext) + curve;" +
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
        "  float w = 1.0 - smoothstep(0.020, 0.034, length(p));" +
        "  return c + p / (1.0 + u_eye.z * w) - u_eye.xy * w;" +
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
        "  vec2 pivot = vec2(" + PELVIS_PIVOT[0] + "," + PELVIS_PIVOT[1] + ");" +
        "  vec2 local = v_uv - pivot - u_pelvis.xy;" +
        "  vec2 rest = pivot + vec2(dot(local, u_pelvis.zw), dot(local, vec2(-u_pelvis.w, u_pelvis.z)));" +
        "  vec2 cL = vec2(" + HIP_LEFT[0] + "," + HIP_LEFT[1] + ");" +
        "  vec2 cR = vec2(" + HIP_RIGHT[0] + "," + HIP_RIGHT[1] + ");" +
        "  float wL = lobeC(rest, cL, vec2(0.088, 0.125));" +
        "  float wR = lobeC(rest, cR, vec2(0.165, 0.155));" +
        "  float wTL = lobe(rest, vec2(0.335, 0.440), vec2(0.145, 0.160));" +
        "  wTL = 1.0 - (1.0 - wTL) * (1.0 - lobe(rest, vec2(0.380, 0.350), vec2(0.090, 0.095)));" +
        "  float wTR = lobe(rest, vec2(0.735, 0.440), vec2(0.175, 0.175));" +
        "  vec2 cBack = vec2(0.510, 0.430);" +
        "  float wBack = lobe(rest, cBack, vec2(0.088, 0.095));" +
        "  float wCheeks = 1.0 - (1.0 - wL) * (1.0 - wR);" +
        "  float wThighs = 1.0 - (1.0 - wTL) * (1.0 - wTR);" +
        "  float w = 1.0 - (1.0 - wCheeks) * (1.0 - 0.5 * wThighs);" +
        "  vec2 sc = mix(vec2(1.0), u_scale, 0.35 * w + 0.65 * wCheeks);" +
        "  vec2 squash = (rest - pivot) / sc - (rest - pivot);" +
        "  float wHead = lobe(v_uv, vec2(0.468, 0.675), vec2(0.220, 0.165));" +
        "  float wChin = lobe(v_uv, vec2(0.468, 0.790), vec2(0.180, 0.085));" +
        "  float wEarL = lobe(v_uv, vec2(0.350, 0.560), vec2(0.095, 0.085));" +
        "  float wEarR = lobe(v_uv, vec2(0.555, 0.560), vec2(0.095, 0.085));" +
        "  float wHairL = lobe(v_uv, vec2(0.265, 0.725), vec2(0.175, 0.125));" +
        "  float wHairR = lobe(v_uv, vec2(0.665, 0.725), vec2(0.175, 0.125));" +
        "  float wh = 1.0 - (1.0 - wHead) * (1.0 - 0.85 * wChin) * (1.0 - 0.75 * wEarL) * (1.0 - 0.75 * wEarR) * (1.0 - 0.90 * wHairL) * (1.0 - 0.90 * wHairR);" +
        "  w *= (1.0 - wh);" +
        "  float wb = wBack * (1.0 - wh) * (1.0 - 0.65 * wCheeks);" +
        "  vec2 backRel = rest - cBack;" +
        "  vec2 backFlex = vec2(backRel.x, -backRel.y * 0.55) * (u_backFlex * wb);" +
        "  float crest = 1.0 - smoothstep(0.22, 0.33, v_uv.y);" +
        "  vec2 jig = u_jigL * (wL * (1.0 - wh)) + u_jigR * (wR * (1.0 - wh));" +
        "  jig.y *= 1.0 + 0.8 * crest;" +
        "  vec2 rv = v_uv - vec2(0.55, 0.29);" +
        "  float rr = length(rv * vec2(1.0, 1.3));" +
        "  vec2 rdir = rv / max(length(rv), 0.001);" +
        "  float rip = sin(rr * 34.0 - u_wave.y * 26.0) * exp(-rr * 3.2) * u_wave.x * 0.0045 * (w + 0.5 * wCheeks) * (1.0 - wh);" +
        "  float aL = length(u_jigL), aR = length(u_jigR);" +
        "  vec2 dL = u_jigL / max(aL, 1e-5), dR = u_jigR / max(aR, 1e-5);" +
        "  vec2 rL = rest - cL, rR = rest - cR;" +
        "  float gL = wL * (1.0 - wh), gR = wR * (1.0 - wh);" +
        "  float alL = dot(rL, dL), alR = dot(rR, dR);" +
        "  vec2 sqz = gL * (-alL * dL * (3.2 * aL) + (rL - alL * dL) * (1.6 * aL)) + gR * (-alR * dR * (3.2 * aR) + (rR - alR * dR) * (1.6 * aR));" +
        "  float wFootL = lobe(v_uv, vec2(0.165, 0.685), vec2(0.055, 0.055));" +
        "  float wFootR = lobe(v_uv, vec2(0.865, 0.755), vec2(0.050, 0.050));" +
        "  vec2 hairD = (u_hair.xy * wHairL + u_hair.zw * wHairR) * (0.5 + 3.0 * abs(v_uv.x - 0.468)) * (1.0 - 0.85 * wHead);" +
        "  float wCupL = lobe(v_uv, vec2(0.257, 0.735), vec2(0.065, 0.075));" +
        "  float wCupR = lobe(v_uv, vec2(0.627, 0.705), vec2(0.060, 0.070));" +
        "  hairD += 1.3 * (u_hair.xy * wCupL + u_hair.zw * wCupR);" +
        "  float wLace = lobe(rest, vec2(0.53, 0.35), vec2(0.15, 0.07));" +
        "  vec2 thD = -0.02 * u_fx.y * ((v_uv - vec2(0.335, 0.44)) * wTL + (v_uv - vec2(0.735, 0.44)) * wTR) * (1.0 - wh);" +
        "  vec2 toeD = -0.06 * u_eye.w * ((v_uv - vec2(0.165, 0.685)) * wFootL + (v_uv - vec2(0.865, 0.755)) * wFootR);" +
        // Both hips and the upper trim share a rigid core. Thighs feather it into the rest of the picture.
        "  vec2 core = (rest - pivot) / vec2(0.248, 0.194);" +
        "  float wCore = 1.0 - smoothstep(0.44, 1.0, dot(core, core));" +
        "  float wPelvis = (1.0 - (1.0 - wCore) * (1.0 - wBack) * (1.0 - 0.88 * wLace) * (1.0 - 0.58 * wThighs)) * (1.0 - wh);" +
        "  float shoulders = max(lobe(v_uv, vec2(0.287, 0.675), vec2(0.120, 0.086)), lobe(v_uv, vec2(0.690, 0.666), vec2(0.123, 0.089)));" +
        "  vec2 headPivot = vec2(" + HEAD_PIVOT[0] + "," + HEAD_PIVOT[1] + ");" +
        "  vec2 headLocal = v_uv - headPivot - u_head.xy;" +
        "  vec2 headRest = headPivot + vec2(dot(headLocal, u_head.zw), dot(headLocal, vec2(-u_head.w, u_head.z)));" +
        "  vec2 disp = hairD + u_lace * wLace * (1.0 - wh) + thD + toeD + sqz - backFlex + jig + rdir * rip;" +
        "  vec2 suv = mix(v_uv, rest, wPelvis) + squash * (1.0 - wh) + (headRest - v_uv) * wh - disp;" +
        "  suv.y += u_shoulders * shoulders * (1.0 - 0.65 * wHead);" +
        // The contact patch samples the same inverse pose as the canvas tail root.
        "  float tailPin = lobe(rest, vec2(" + TAIL_ROOT[0] + "," + TAIL_ROOT[1] + "), vec2(0.045, 0.052));" +
        "  float earPin = max(lobe(headRest, vec2(0.331055, 0.600586), vec2(0.038, 0.032)), lobe(headRest, vec2(0.543945, 0.599609), vec2(0.038, 0.032)));" +
        "  suv = clamp(mix(mix(suv, rest, tailPin), headRest, earPin), 0.0, 1.0);" +
        "  suv = eyeWarp(eyeWarp(suv, vec2(0.381, 0.762)), vec2(0.516, 0.762));" +
        "  vec3 col = samplePortrait(suv);" +
        "  float skm = skinM(col);" +
        "  float warmth = col.r - max(col.g, col.b);" +
        "  vec2 bq1 = (suv - vec2(0.345, 0.812)) / vec2(0.055, 0.026);" +
        "  vec2 bq2 = (suv - vec2(0.552, 0.812)) / vec2(0.055, 0.026);" +
        "  float blushA = clamp(u_fx.x * 0.55 * (exp(-dot(bq1, bq1)) + exp(-dot(bq2, bq2))), 0.0, 0.6) * skm;" +
        "  col = mix(col, col * vec3(1.0, 0.74, 0.80) + vec3(0.10, 0.0, 0.03), blushA);" +
        // Trace the exposed crests in artwork coordinates. The glint travels along the skin band.
        "  if ((u_fx.z > 0.0 || u_comboSheen.y > 0.0) && suv.y > 0.215 && suv.y < 0.300) {" +
        "    float warmSkin = skm * smoothstep(0.029, 0.072, warmth);" +
        "    float sweep = 0.52 * sin(u_fx.w * 6.2831853);" +
        "    vec2 artPx = suv * 1024.0;" +
        "    float sheen = cheekCrestSheen(artPx, vec2(460.0, 258.0), 31.0, vec2(-16.0, 9.0), sweep) +" +
        "                  cheekCrestSheen(artPx, vec2(630.0, 257.0), 49.0, vec2(13.0, 6.0), sweep);" +
        "    float strength = u_fx.z * (0.82 + 0.18 * smoothstep(0.12, 0.58, u_fx.y));" +
        "    if (u_comboSheen.y > 0.0) {" +
        "      float ripple = (artPx.x - u_comboSheen.x) / 30.0;" +
        "      float focused = mix(strength * 0.42, 1.0, exp(-ripple * ripple));" +
        "      strength = mix(strength, focused, u_comboSheen.y);" +
        "    }" +
        "    col = mix(col, vec3(1.0, 0.99, 0.97), warmSkin * sheen * strength);" +
        "  }" +
        "  col *= 1.0 + 0.05 * u_fx.y * (wTL + wTR) * skm;" +
        "  float leadL = clamp(dot(normalize(rL + 1e-4), dL) * aL * 70.0, -1.0, 1.0) * gL;" +
        "  float leadR = clamp(dot(normalize(rR + 1e-4), dR) * aR * 70.0, -1.0, 1.0) * gR;" +
        "  col *= 1.0 + 0.10 * (leadL + leadR);" +
        "  float squeeze = clamp((u_jigL.x - u_jigR.x) * 38.0, 0.0, 1.0);" +
        "  float cq = (v_uv.x - 0.552) / 0.026;" +
        "  float crease = exp(-cq * cq) * wCheeks * (1.0 - wh);" +
        "  col *= 1.0 - 0.18 * squeeze * crease;" +
        "  col = applyLid(col, suv, vec2(0.381, 0.762), vec2(0.041, 0.034), u_blink, 1.0);" +
        "  col = applyLid(col, suv, vec2(0.516, 0.762), vec2(0.041, 0.034), u_blink, -1.0);" +
        "  col = applyMouth(col, suv, u_mouthB.x, u_mouth, u_mouthB.yz);" +
        // Restrict the cast shadow to cheek skin below the two front locks.
        "  if (skm > 0.01 && suv.y > 0.770 && suv.y < 0.874) {" +
        "    float leftCheek = lobe(suv, vec2(0.344, 0.803), vec2(0.076, 0.068));" +
        "    float rightCheek = lobe(suv, vec2(0.554, 0.806), vec2(0.076, 0.068));" +
        "    float shadow = cheekShadow(suv, u_hair.xy, leftCheek) + cheekShadow(suv, u_hair.zw, rightCheek);" +
        "    col *= 1.0 - skm * shadow * vec3(0.44, 0.38, 0.28);" +
        "  }" +
        "  gl_FragColor = vec4(col, 1.0);" +
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
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      warpState.gl = gl;
      warpState.tex = tex;
      warpState.uPelvis = gl.getUniformLocation(prog, "u_pelvis");
      warpState.uScale = gl.getUniformLocation(prog, "u_scale");
      warpState.uBlink = gl.getUniformLocation(prog, "u_blink");
      warpState.uHead = gl.getUniformLocation(prog, "u_head");
      warpState.uShoulders = gl.getUniformLocation(prog, "u_shoulders");
      warpState.uSmirk = gl.getUniformLocation(prog, "u_smirk");
      warpState.uBackFlex = gl.getUniformLocation(prog, "u_backFlex");
      warpState.uJigL = gl.getUniformLocation(prog, "u_jigL");
      warpState.uJigR = gl.getUniformLocation(prog, "u_jigR");
      warpState.uWave = gl.getUniformLocation(prog, "u_wave");
      warpState.uMouth = gl.getUniformLocation(prog, "u_mouth");
      warpState.uMouthB = gl.getUniformLocation(prog, "u_mouthB");
      warpState.uFx = gl.getUniformLocation(prog, "u_fx");
      warpState.uComboSheen = gl.getUniformLocation(prog, "u_comboSheen");
      warpState.uEye = gl.getUniformLocation(prog, "u_eye");
      warpState.uHair = gl.getUniformLocation(prog, "u_hair");
      warpState.uLace = gl.getUniformLocation(prog, "u_lace");
      uploadWarpTexture();
      return gl;
    } catch (_) {
      warpState.failed = true;
      return null;
    }
  }

  function renderWarp(x, y, cos, sin, sx, sy, blink, hx, hy, bArch, jlx, jly, jrx, jry, wa, wt, mo, f, glintX, glintStrength) {
    var gl = ensureWarpGl();
    if (!gl) return false;
    if (!warpState.texReady && !uploadWarpTexture()) return false;
    gl.viewport(0, 0, warpCanvas.width, warpCanvas.height);
    gl.uniform4f(warpState.uPelvis, x, y, cos, sin);
    gl.uniform2f(warpState.uScale, sx, sy);
    gl.uniform1f(warpState.uBlink, blink || 0);
    gl.uniform4f(warpState.uHead, hx || 0, hy || 0, Math.cos(f.headAngle), Math.sin(f.headAngle));
    gl.uniform1f(warpState.uShoulders, f.shoulders);
    gl.uniform1f(warpState.uSmirk, f.smirk);
    gl.uniform1f(warpState.uBackFlex, bArch);
    gl.uniform2f(warpState.uJigL, jlx || 0, jly || 0);
    gl.uniform2f(warpState.uJigR, jrx || 0, jry || 0);
    gl.uniform2f(warpState.uWave, wa || 0, wt || 0);
    gl.uniform4f(warpState.uMouth, mo ? mo.open : 0, mo ? mo.smile : 0, mo ? mo.wide : 0.85, mo ? mo.tongue : 0);
    gl.uniform3f(warpState.uMouthB, mo ? mo.str : 0, mo ? mo.wobAmp : 0, mo ? mo.wobPh : 0);
    gl.uniform4f(warpState.uFx, f ? f.flush : 0, f ? f.tension : 0, f ? f.sheen : 0, f ? f.sheenPh : 0);
    gl.uniform2f(warpState.uComboSheen, glintX, glintStrength);
    gl.uniform4f(warpState.uEye, f ? f.eyeX : 0, f ? f.eyeY : 0, f ? f.eyeS : 0, f ? f.curl : 0);
    gl.uniform2f(warpState.uLace, f ? f.laceX : 0, f ? f.laceY : 0);
    gl.uniform4f(warpState.uHair, f ? f.oLx : 0, f ? f.oLy : 0, f ? f.oRx : 0, f ? f.oRy : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    talkUntil: 0, talkPh: 0, gasp: 0, happy: 0, flustered: 0, blepUntil: 0, nextBlep: 0
  };

  // Life layer: effort-driven breathing, blush build-up, eye behaviour, hair sway, thigh tension, toe curl, skin
  // sheen, tiny synthesised sounds and drifting hearts. Everything here is cheap and decays back to zero.
  var fxSt = {
    effort: 0, breathPh: 0, flush: 0, tension: 0, spankT: 0, sheen: 0, sheenPh: 0, curl: 0,
    eyeX: 0, eyeY: 0, eyeS: 0, eyeTX: 0, eyeTY: 0, nextSacc: 0, glanceFrom: 0, glanceUntil: 0, glanceDir: 1,
    ptrX: 0, ptrY: 0, ptrT: 0, pdx: 0, pnear: 0, nextBreath: 0,
    rect: null, rectT: 0, tiredSaid: false, lookFrom: 0, lookUntil: 0, lookDir: 1, lookX: 0, lookY: 0, lid: 0, lcx: 0, lcy: 0, lvx: 0, lvy: 0, laceX: 0, laceY: 0, nextCurl: 0, curlPulse: 0,
    hLx: 0, hLy: 0, hLvx: 0, hLvy: 0, hRx: 0, hRy: 0, hRvx: 0, hRvy: 0,
    oLx: 0, oLy: 0, oRx: 0, oRy: 0, headAngle: 0, shoulders: 0, chin: 0, smirk: 0
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
    fxSt.ptrX = event.clientX; fxSt.ptrY = event.clientY; fxSt.ptrT = performance.now() / 1000;
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
  var sfx = {
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
    slap: function (force, pan) {
      if (!button.classList.contains("is-nsfw") || reduceMotion || !this.on() || !this.init()) return;
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }
      var c = this.ctx, t = c.currentTime + 0.005, v = this.vol() * (0.5 + 0.5 * force);
      this.burst(t, 0.09, "bandpass", 2200, 900, 0.9, 0.55 * v, pan);
      var o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.14);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.2);
    },
    stop: function () {
      // Adult mode off / reduced motion: silence anything scheduled and release the audio device.
      if (!this.ctx) return;
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null; this.noise = null;
    },
    gasp: function () {
      if (!button.classList.contains("is-nsfw") || !this.on() || !this.ctx || this.ctx.state !== "running") return;
      this.burst(this.ctx.currentTime + 0.08, 0.32, "bandpass", 1100, 1900, 1.4, 0.16 * this.vol());
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
    // breathing effort: dancing builds it, rest drains it over ~7 s
    F.effort = Math.max(0, Math.min(1, F.effort + dt * 0.10 * music - F.effort * dt / 7));
    if (F.effort > 0.5 && !F.tiredSaid) { F.tiredSaid = true; danceSay("tired", 1); }
    else if (F.effort < 0.3) F.tiredSaid = false;
    F.breathPh += dt * (1.55 + 2.4 * F.effort);
    if (F.effort > 0.55 && nowS > F.nextBreath && sfx.ctx && !document.hidden) {
      sfx.breath(F.effort);
      F.nextBreath = nowS + 2.6 - 1.2 * F.effort;
    }
    // thigh tension and toe curl
    F.spankT *= Math.exp(-dt * 1.4);
    F.tension += (Math.max(bootyPhys.dropGain * 0.8, F.spankT) - F.tension) * kf(8);
    if (nowS > F.nextCurl) { F.curlPulse = 0.35; F.nextCurl = nowS + 5 + Math.random() * 9; }
    F.curlPulse *= Math.exp(-dt * 2.2);
    var curlT = Math.max(F.spankT * 0.9, F.tension * 0.6, F.curlPulse, mouthSt.happy > 0 ? 0.3 : 0);
    F.curl += (curlT - F.curl) * kf(10);
    // blush builds with teasing and fades slowly
    if (hover && F.flush < 0.4) F.flush += dt * 0.09;
    if (music > 0.3 && F.flush < 0.25) F.flush += dt * 0.10;
    F.flush = Math.max(0, Math.min(1, F.flush - dt / 16));
    // skin sheen: a highlight sweeping across while dancing, a glossier skin after effort
    var sheenT = Math.min(1, (music > 0 ? Math.sqrt(music) * 0.95 : 0) +
      F.effort * 0.45 + bootyPhys.dropGain * 0.35);
    F.sheen += (sheenT - F.sheen) * kf(sheenT > F.sheen ? 5 : 2.4);
    if (F.sheen > 0.02) F.sheenPh = (F.sheenPh + dt * (0.28 + 0.22 * music)) % 1;
    // eyes: saccades, cursor tracking, a shy glance after a spank, wider pupils on surprise, beating hearts
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
    F.eyeX += (tx * (1 - gazeStill) - F.eyeX) * kf(13);
    F.eyeY += (ty * (1 - gazeStill) - F.eyeY) * kf(13);
    var beat = music > 0.05 ? 0.045 * music * (0.5 + 0.5 * Math.sin(bootyPhys.twerkPhase)) : 0;
    var eyeT = (mouthSt.gasp > 0 ? 0.20 : 0) + beat;
    if (gesture.kind === "surprise") eyeT += 0.17 * motionPulse(gestureAge, 0.08, 0.27, 0.63);
    F.eyeS += (eyeT - F.eyeS) * kf(16);
    // The pupils lead, then the head catches up. Centered pupils hold contact before the glance away.
    var turning = lookNow && lookAge >= (briefLook ? 0.08 : 0.13);
    var lookTX = lookNow ? (turning ? F.lookDir * 0.009 : 0) : (hover ? F.pdx * F.pnear * 0.0045 : 0);
    var lookTY = turning ? -0.004 : 0;
    F.lookX += (lookTX - F.lookX) * kf(turning ? 7 : 4);
    F.lookY += (lookTY - F.lookY) * kf(turning ? 7 : 4);
    var lidT = lookNow ? 0 : (mouthSt.happy > 0 ? 0.22 : 0) + F.effort * 0.16 + (F.flush > 0.5 ? 0.08 : 0);
    if (gesture.kind === "smile") lidT = Math.max(lidT, 0.34 * motionHold(gestureAge, 0, 0.15, 0.52, 1.05));
    F.lid += (lidT - F.lid) * kf(lookNow ? 12 : 3);
    // The hair follows the turned head with its own lag.
    hx += F.lookX - F.headAngle * 0.12; hy += F.lookY + F.chin;
    var sw = Math.sin(nowS * 1.1) * 0.0006, sw2 = Math.sin(nowS * 1.3 + 1.7) * 0.0006;
    var vxs = 0.05 * Math.tanh(bootyPhys.vx / 45), vys = 0.04 * Math.tanh(bootyPhys.vy / 60);
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
    return hover;
  }

  function resetFx() {
    var F = fxSt;
    F.effort = F.flush = F.tension = F.spankT = F.sheen = F.curl = F.curlPulse = 0;
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
    function useLyrics(lines, source) {
      if (!lines.some(function (line) { return line.vowels.length; })) return false;
      track = { audio: audio, src: source, lines: lines };
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
        if (stillCurrent(source, sequence) && !useLyrics(parseLrc(data.lrc || ""), source)) {
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
        var lines = parseLrc(await file.text());
        if (!stillCurrent(source, sequence)) return;
        if (!useLyrics(lines, source)) throw new Error();
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
    if (talking) {
      M.talkPh += dt * (8 + 3 * Math.sin(nowS * 1.7));
      var syl = Math.abs(Math.sin(M.talkPh)) * (0.6 + 0.4 * Math.abs(Math.sin(M.talkPh * 0.37)));
      tOpen = 0.16 + 0.55 * syl; tSmile = 0.18; tWide = 0.82 - 0.22 * syl; want = 1;
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
      else if (M.flustered > 0) { tSmile = 0.40; tOpen = 0.13 + 0.05 * Math.sin(nowS * 9); tWide = 0.60; want = 1; }
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
    stepGesture(nowP, dt);
    var k = 220;   // snappy jiggle frequency
    var d = 5.2;   // natural multi-bounce wobble without over-stretching
    var ax = -k * bootyPhys.x - d * bootyPhys.vx;
    var ay = -k * bootyPhys.y - d * bootyPhys.vy;
    var intensity = Number.isFinite(playback.intensity) ? playback.intensity : 0.78;
    var vol = Number.isFinite(playback.volume) ? playback.volume : 1.0;
    var playing = onMusiquePage() && playback.playing;
    var activeMusic = playing && available && !drag && !pinching && gesture.kind !== "listen";
    var speed = parseFloat(wave.style.getPropertyValue("--wave-speed")) || 1.25;
    var tempoScale = intensity >= 0.95 ? 0.72 : (intensity < 0.60 ? 1.25 : 1.0);
    var beatSec = Math.max(0.32, Math.min(0.82, speed * 0.5 * tempoScale));
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
      bootyPhys.nextAccentCombo = "ripple";
      bootyPhys.fig8Beat = 0;
      bootyPhys.fig8Direction = 1;
      if (activeMusic) {
        bootyPhys.coilT = 0.20;
        bootyPhys.coilKind = "start";
      }
      bootyPhys.danceSince = ts / 1000;
      if (danceGenLeft() < 6) danceGenFetch(false);
      bootyPhys.phKind = 0; bootyPhys.phCount = 0; bootyPhys.phUntil = ts / 1000 + 3 + Math.random() * 2;
    }
    bootyPhys.prevPlaying = playing;
    var accent = 0;
    var finishedRoll = false;
    if (!playing && wasPlaying) {
      bootyPhys.settleUntil = ts / 1000 + 0.55;
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
      // Normal, slow roll, burst, look-back, or a figure eight with a direction change.
      var slow = bootyPhys.phKind === 1;
      var lookDue = bootyPhys.phKind !== 3 && (bootyPhys.phCount + 1) % 3 === 0;
      if (activeMusic && poseAvailable && nowP >= bootyPhys.phUntil && bootyPhys.dropAge < 0 && bootyPhys.coilT === 0) {
        if (slow && !bootyPhys.holdSide) {
          bootyPhys.holdSide = bootyPhys.rollSide;
          bootyPhys.phUntil = nowP + beatSec * 0.5;
          startLook(nowP, bootyPhys.phUntil, bootyPhys.holdSide);
        } else {
          var heldSide = bootyPhys.holdSide;
          bootyPhys.holdSide = 0;
          if (heldSide) {
            bootyPhys.vx -= heldSide * 12 * vol;
            finishedRoll = true;
          }
          bootyPhys.rollSide *= -1;
          bootyPhys.phCount += 1;
          var rr = Math.random(), hi = intensity >= 0.8;
          if (heldSide) {
            bootyPhys.phKind = 0; bootyPhys.phUntil = nowP + 4 + Math.random() * 3;
          } else if (lookDue && bootyPhys.twerkGain > 0.8) {
            bootyPhys.phKind = 3; bootyPhys.phUntil = nowP + 1.4 + Math.random() * 0.4;
            startLook(nowP, bootyPhys.phUntil);
            danceSay("look", 0.7);
          } else if (bootyPhys.phCount % 4 === 1 && intensity >= 0.65 && intensity < 0.98 &&
              bootyPhys.dropTimer <= 0) {
            bootyPhys.phKind = 4;
            bootyPhys.phUntil = nowP + 10 * beatSec;
            bootyPhys.fig8Beat = 0;
          } else if (rr < (hi ? 0.4 : 0.25) && bootyPhys.phKind !== 2) {
            bootyPhys.phKind = 2; bootyPhys.phUntil = nowP + 2.5 + Math.random() * 2.5;
            danceSay("fast", 0.5);
          } else if (rr < 0.6 && bootyPhys.phKind !== 1) {
            bootyPhys.phKind = 1; bootyPhys.phUntil = nowP + 3 + Math.random() * 3;
            danceSay("slow", 0.5);
          } else {
            bootyPhys.phKind = 0; bootyPhys.phUntil = nowP + 4 + Math.random() * 4;
          }
        }
      }
      var phRateT = bootyPhys.phKind === 1 ? 0.5 : (bootyPhys.phKind === 2 ? 1.5 : 1);
      bootyPhys.phRate += (phRateT - bootyPhys.phRate) * Math.min(1, dt * 4);
      var prevPhase = bootyPhys.twerkPhase;
      if (activeMusic && bootyPhys.phKind !== 3 && !bootyPhys.holdSide && bootyPhys.coilT === 0 && bootyPhys.dropAge < 0) {
        bootyPhys.twerkPhase = (prevPhase + dt * ((2 * Math.PI) / beatSec) * bootyPhys.phRate) % (Math.PI * 4);
      }
      if (Math.floor(prevPhase / (Math.PI * 2)) !== Math.floor(bootyPhys.twerkPhase / (Math.PI * 2))) {
        bootyPhys.beatWraps += 1;
        tailLink.beat += 1;
        if (bootyPhys.twerkGain > 0.5) {
          // A twerk peak sends a (smaller) ripple out through the cheeks toward the thighs.
          bootyPhys.wave = Math.max(bootyPhys.wave, (0.35 + intensity * 0.25) * vol);
          bootyPhys.waveT = 0;
        }
        if (intensity >= 0.68 && bootyPhys.phKind !== 4 && bootyPhys.dropTimer <= 0 && (bootyPhys.beatWraps % 14) === 0) {
          bootyPhys.dropTimer = 3.2;
        }
        if (bootyPhys.phKind !== 1 && bootyPhys.phKind !== 4 && intensity >= 0.65 &&
            bootyPhys.dropTimer <= 0 && bootyPhys.dropGain < 0.5 && Math.random() < (0.28 + intensity * 0.14)) {
          var pop = (0.75 + intensity * 0.55) * vol * (dancing ? 1.25 : 1.0);
          bootyPhys.vy -= (30 + Math.random() * 18) * pop;
          bootyPhys.vx += (Math.random() < 0.5 ? 1 : -1) * (16 + Math.random() * 12) * pop;
        }
      }
    }

    var holding = bootyPhys.phKind === 3 || bootyPhys.holdSide !== 0;
    var phAmpT = holding ? 0 : (bootyPhys.phKind === 1 ? 1.12 : 1);
    if (activeMusic || bootyPhys.twerkGain === 0) {
      bootyPhys.phAmp += (phAmpT - bootyPhys.phAmp) * (1 - Math.exp(-dt * (holding ? 12 : 6)));
    }
    var danceGain = bootyPhys.twerkGain * bootyPhys.phAmp;
    // Evaluate two copies of the roll 75 ms apart. Blend the lead when the phrase changes.
    var phase = bootyPhys.twerkPhase;
    var hipLag = (2 * Math.PI / beatSec) * bootyPhys.phRate * 0.075;
    bootyPhys.rollLead += (bootyPhys.rollSide - bootyPhys.rollLead) * (1 - Math.exp(-dt * 14));
    bootyPhys.slowRoll += ((bootyPhys.phKind === 1 ? 1 : 0) - bootyPhys.slowRoll) * (1 - Math.exp(-dt * 10));
    var leftLag = hipLag * (0.5 - 0.5 * bootyPhys.rollLead);
    var rightLag = hipLag * (0.5 + 0.5 * bootyPhys.rollLead);
    var plant = activeMusic ? bootyPhys.holdSide : 0;
    bootyPhys.hipWeight += (plant - bootyPhys.hipWeight) * (1 - Math.exp(-dt * 22));
    // Settle quickly into the hold and after the stop. Leave the tail springs free to follow through.
    var settling = holding ? 12 : (ts / 1000 < bootyPhys.settleUntil ? 8 : 0);
    ax -= settling * bootyPhys.vx;
    ay -= settling * bootyPhys.vy;

    if (bootyPhys.dropTimer > 0 && activeMusic && bootyPhys.phKind !== 1) {
      bootyPhys.dropTimer = Math.max(0, bootyPhys.dropTimer - dt);
    } else if (!activeMusic) {
      bootyPhys.dropTimer = 0;
    }
    var progDrop = false;
    if (activeMusic && intensity >= 0.70 && playback.durationMs > 30000) {
      var frac = (playback.progressMs + (Date.now() - playback.progressAt)) / playback.durationMs;
      progDrop = (frac >= 0.25 && frac <= 0.32) || (frac >= 0.53 && frac <= 0.61) || (frac >= 0.79 && frac <= 0.86);
    }
    var wantDrop = activeMusic && (finishedRoll || bootyPhys.dropTimer > 0 || progDrop);
    if (!wantDrop) bootyPhys.prevDrop = false;
    if (!activeMusic || holding) {
      if (bootyPhys.coilT > 0 && bootyPhys.coilKind === "drop") bootyPhys.prevDrop = false;
      bootyPhys.coilT = 0;
    }
    if (wantDrop && poseAvailable && !holding && bootyPhys.phKind !== 1 && bootyPhys.phKind !== 4 &&
        (!bootyPhys.prevDrop || finishedRoll) && bootyPhys.coilT === 0 && bootyPhys.dropAge < 0) {
      bootyPhys.coilKind = "drop";
      bootyPhys.coilT = beatSec * 0.42;
      bootyPhys.prevDrop = true;
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
          if (sfx.ctx) sfx.breath(0.7);
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
          if (comboKind !== "single") comboHit = move;
          else spawnFx("\u2726", 4);
          if (hit === 0) {
            if (sfx.ctx) sfx.breath(0.7);
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
    var wantFig8 = activeMusic && poseAvailable && !holding && !gesture.kind &&
      bootyPhys.coilT === 0 && bootyPhys.dropAge < 0 && bootyPhys.dropGain < 0.1 &&
      (bootyPhys.phKind === 4 || (bootyPhys.phKind !== 1 && intensity < 0.65));
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
    var groove = (0.65 + intensity * 0.65) * vol * (dancing ? 1.25 : 1.0) * danceGain *
      (1 - 0.94 * bootyPhys.coil) * (1 - 0.9 * bootyPhys.dropGain) * (1 - bootyPhys.fig8Gain);
    var bounceWave = Math.sin(phase) * 0.72 + Math.sin(phase * 2 - 0.5) * 0.34;
    var swayWave = Math.cos(phase * 0.5);
    ay += bounceWave * 520 * groove * (1 - 0.62 * bootyPhys.slowRoll);
    ax += swayWave * 280 * groove;
    ax += 390 * bootyPhys.hipWeight * vol;

    var wantOrbit = activeMusic && !holding && !wantFig8 && bootyPhys.phKind !== 1 && bootyPhys.dropAge < 0 &&
      (intensity >= 0.95 || (intensity >= 0.84 && vol >= 0.96));
    var targetOrbit = wantOrbit ? 1 : 0;
    if (bootyPhys.orbitGain < targetOrbit) {
      bootyPhys.orbitGain = Math.min(targetOrbit, bootyPhys.orbitGain + dt * 2.4);
    } else if (bootyPhys.orbitGain > targetOrbit) {
      bootyPhys.orbitGain = Math.max(targetOrbit, bootyPhys.orbitGain - dt * 2.2);
    }
    if (bootyPhys.orbitGain > 0.005) {
      var orbit = Math.min(1.15, Math.max(0, (intensity - 0.84) / 0.38)) * vol;
      var ang = (ts * 0.001) * (12.5 + orbit * 4.5);
      ax += Math.cos(ang) * (240 + orbit * 220) * bootyPhys.orbitGain * danceGain * (1 - bootyPhys.coil);
      ay += Math.sin(ang) * (220 + orbit * 200) * bootyPhys.orbitGain * danceGain * (1 - bootyPhys.coil);
    }

    if (bootyPhys.ripple > 0.005) {
      bootyPhys.rippleTime += dt;
      bootyPhys.ripple *= Math.exp(-dt * 4.4);
    } else {
      bootyPhys.ripple = 0;
      bootyPhys.rippleTime = 0;
    }

    bootyPhys.vx += ax * dt;
    bootyPhys.vy += ay * dt;
    bootyPhys.x += bootyPhys.vx * dt;
    bootyPhys.y += bootyPhys.vy * dt;

    // Hip lag: a soft spring behind the body; the cheeks chase it, so a push travels hips -> cheeks as a wave.
    bootyPhys.hlvx += (-110 * (bootyPhys.hlx - bootyPhys.x) - 10.0 * bootyPhys.hlvx) * dt;
    bootyPhys.hlvy += (-110 * (bootyPhys.hly - bootyPhys.y) - 10.0 * bootyPhys.hlvy) * dt;
    bootyPhys.hlx += bootyPhys.hlvx * dt; bootyPhys.hly += bootyPhys.hlvy * dt;
    // Cheek jiggle: each cheek chases the (lagged) hips with its own spring. Stiffness grows with strain (soft for
    // small pushes, firm at the limit), damping rises with dance intensity, and the right cheek chases a frame late.
    var dampMul = 0.8 + 0.7 * (activeMusic ? Math.min(1, intensity) * Math.min(1, bootyPhys.twerkGain) : 0);
    var dlx = bootyPhys.jlx - bootyPhys.hlx, dly = bootyPhys.jly - bootyPhys.hly;
    var drx = bootyPhys.jrx - bootyPhys.phx, dry = bootyPhys.jry - bootyPhys.phy;
    var kl = 300 * bootyPhys.mL, kr = 250 * bootyPhys.mR;
    bootyPhys.jlvx += (-kl * (1 + 0.02 * Math.min(150, dlx * dlx)) * dlx - 11.0 * dampMul * bootyPhys.jlvx) * dt;
    bootyPhys.jlvy += (-kl * (1 + 0.02 * Math.min(150, dly * dly)) * dly - 11.0 * dampMul * bootyPhys.jlvy) * dt;
    bootyPhys.jlx += bootyPhys.jlvx * dt; bootyPhys.jly += bootyPhys.jlvy * dt;
    bootyPhys.jrvx += (-kr * (1 + 0.02 * Math.min(150, drx * drx)) * drx - 10.0 * dampMul * bootyPhys.jrvx) * dt;
    bootyPhys.jrvy += (-kr * (1 + 0.02 * Math.min(150, dry * dry)) * dry - 10.0 * dampMul * bootyPhys.jrvy) * dt;
    bootyPhys.jrx += bootyPhys.jrvx * dt; bootyPhys.jry += bootyPhys.jrvy * dt;
    bootyPhys.prevX = bootyPhys.x; bootyPhys.prevY = bootyPhys.y;
    bootyPhys.phx = bootyPhys.hlx; bootyPhys.phy = bootyPhys.hly;
    bootyPhys.jLx = Math.tanh((bootyPhys.jlx - bootyPhys.x) * 0.22) * 0.013;
    bootyPhys.jLy = Math.tanh((bootyPhys.jly - bootyPhys.y) * 0.22) * 0.013;
    bootyPhys.jRx = Math.tanh((bootyPhys.jrx - bootyPhys.x) * 0.22) * 0.013;
    bootyPhys.jRy = Math.tanh((bootyPhys.jry - bootyPhys.y) * 0.22) * 0.013;
    if (bootyPhys.wave > 0.01) {
      bootyPhys.waveT += dt;
      bootyPhys.wave *= Math.exp(-dt * 4.0);
    } else {
      bootyPhys.wave = 0;
      bootyPhys.waveT = 0;
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
    var rippleWave = bootyPhys.ripple > 0 ? Math.sin(bootyPhys.rippleTime * 38) * bootyPhys.ripple * 0.011 : 0;
    var dx = Math.tanh(bootyPhys.x * 0.16) * 0.022 + dropSide * vol * 0.023 + figX;
    var dy = Math.tanh(bootyPhys.y * 0.18) * 0.024 + rippleWave * 0.6 -
      bootyPhys.coil * (bootyPhys.coilKind === "drop" ? 0.012 : -0.008) + dropLanding + figY;
    var sq = Math.tanh(bootyPhys.y * 0.14) * 0.045 + rippleWave * 1.2 - dropLanding * 0.85;
    var sx = 1 - sq;
    var sy = 1 + sq;
    var poseGain = danceGain * vol * (1 - 0.85 * bootyPhys.coil) * (1 - 0.85 * bootyPhys.dropGain);
    var rollLift = (0.009 + 0.010 * bootyPhys.slowRoll) * poseGain * (1 - bootyPhys.fig8Gain);
    var weightLift = 0.011 * bootyPhys.hipWeight * vol;
    var liftL = -Math.sin(phase - leftLag) * rollLift - weightLift;
    var liftR = -Math.sin(phase - rightLag) * rollLift + weightLift;
    // The phased lift sets the height and tilt of a single pelvis. The hip span stays constant.
    var angle = Math.asin((HIP_SPAN_Y + liftR - liftL) / HIP_SPAN) - HIP_ANGLE;
    angle += Math.tanh(bootyPhys.vx * 0.014) * 0.018 + dropSide * vol * 0.085 +
      fig8Gain * (0.072 * Math.sin(figAng) + 0.11 * figPlant * bootyPhys.fig8Direction);
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var hx = -(dx - figX) * 0.24 + Math.cos(phase * 0.5 + 0.4) * 0.0045 * danceGain * (1 - bootyPhys.fig8Gain);
    var hy = (dy - figY) * 0.22 + Math.sin(phase - 0.5) * 0.0055 * danceGain * (1 - bootyPhys.fig8Gain);
    var mHover = stepFx(dt, ts / 1000, hx, hy, activeMusic, intensity, vol, figPlant * bootyPhys.fig8Gain);
    hx += fxSt.lookX - fxSt.headAngle * 0.12; hy += fxSt.lookY + fxSt.chin;
    var breathGain = 1 - 0.7 * Math.min(1, danceGain);
    var breathWave = Math.sin(fxSt.breathPh) * (1 + 0.9 * fxSt.effort) + 0.9 * bootyPhys.coil;
    var pelvisY = dy + (liftL + liftR) * 0.5 + breathWave * 0.0038 * breathGain;
    var bArch = Math.sin(bootyPhys.twerkPhase - 0.50) * 0.040 * poseGain +
      Math.sin(figAng * 2.0 - 0.5) * 0.028 * fig8Gain +
      breathWave * 0.024 * breathGain - bootyPhys.coil * 0.04;
    // Soft-tissue recoil flexes the back around the shared pose.
    var jiggleGain = 1 - 0.85 * Math.max(bootyPhys.dropGain, Math.abs(bootyPhys.hipWeight));
    var jigLx = bootyPhys.jLx * jiggleGain, jigRx = bootyPhys.jRx * jiggleGain;
    var jigLy = bootyPhys.jLy * jiggleGain + dropRebound;
    var jigRy = bootyPhys.jRy * jiggleGain + dropRebound * 0.85;
    bArch += (jigLy + jigRy) * 1.1;
    stepMouth(dt, ts / 1000, mHover, activeMusic && !holding && danceGain > 0.1, Math.min(1, danceGain) * vol, st);
    bootyPhys.bAs += (bArch - bootyPhys.bAs) * Math.min(1, dt * 14);
    bArch = bootyPhys.bAs;
    var warped = renderWarp(dx, pelvisY, cos, sin, sx, sy, Math.max(bootyPhys.blink, fxSt.lid), hx, hy, bArch,
      jigLx, jigLy, jigRx, jigRy, bootyPhys.wave, bootyPhys.waveT, mouthSt, fxSt, crestX, crestStrength);
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
    // Forward-transform the tail root using the same pose the shader samples in reverse.
    var rootX = TAIL_ROOT[0] - PELVIS_PIVOT[0], rootY = TAIL_ROOT[1] - PELVIS_PIVOT[1];
    tailLink.rx = warped ? dx + (cos - 1) * rootX - sin * rootY : 0;
    tailLink.ry = warped ? pelvisY + sin * rootX + (cos - 1) * rootY : 0;
    tailLink.rootAngle = warped ? angle : 0;
    tailLink.dx = dx;
    tailLink.dy = dy;
    tailLink.twerk = poseGain;
    tailLink.phase = bootyPhys.twerkPhase;
    tailLink.ripple = bootyPhys.ripple;
    tailLink.stretch = st;
    tailLink.blinking = bootyPhys.blinking;
    tailLink.music = activeMusic ? Math.min(1, intensity) * poseGain : 0;
    tailLink.hx = warped ? hx : 0;
    tailLink.hy = warped ? hy : 0;
    tailLink.headAngle = warped ? fxSt.headAngle : 0;
    tailLink.talk = mouthSt.str > 0.3 ? Math.min(1, mouthSt.open * 1.6) : 0;
    tailLink.effort = fxSt.effort;
    tailLink.shy = Math.min(1, mouthSt.flustered / 0.5);
    tailLink.happy = mouthSt.happy > 0 ? 1 : 0;
    tailLink.vx = bootyPhys.vx;
    tailLink.vy = bootyPhys.vy;
    tailLink.pdx = fxSt.pdx;
    tailLink.pnear = fxSt.pnear;
    tailLink.holding = holding || gesture.kind === "listen" || tailLink.curlPose > 0.02 || bootyPhys.dropAge >= 0 || bootyPhys.dropGain > 0.05 ||
      (bootyPhys.coilKind === "drop" && bootyPhys.coilT > 0);
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
        Math.abs(bootyPhys.jrvx) > 1 || Math.abs(bootyPhys.jrvy) > 1;
    // Only the slow idle breathing left: 30fps is plenty (saves battery on 120Hz ProMotion).
    bootyPhys.calm = !busy;

    bootyPhys.raf = window.requestAnimationFrame(stepBooty);
  }

  // Restore the static portrait when the animation stops.
  function resetBootyState() {
    {
      bootyPhys.x = 0;
      bootyPhys.y = 0;
      bootyPhys.vx = 0;
      bootyPhys.vy = 0;
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
      bootyPhys.prevX = bootyPhys.prevY = 0;
      bootyPhys.jLx = bootyPhys.jLy = bootyPhys.jRx = bootyPhys.jRy = 0;
      bootyPhys.wave = 0;
      bootyPhys.waveT = 0;
      mouthSt.open = 0; mouthSt.smile = 0.25; mouthSt.wide = 0.85; mouthSt.tongue = 0; mouthSt.str = 0;
      mouthSt.gasp = 0; mouthSt.happy = 0; mouthSt.talkUntil = 0; mouthSt.blepUntil = 0;
      tailLink.rx = tailLink.ry = tailLink.rootAngle = tailLink.dx = tailLink.dy = tailLink.twerk = tailLink.ripple = tailLink.stretch = 0;
      tailLink.blinking = false;
      tailLink.music = 0;
      tailLink.hx = tailLink.hy = tailLink.talk = 0;
      tailLink.headAngle = tailLink.curlPose = 0;
      tailLink.effort = tailLink.shy = tailLink.happy = tailLink.vx = tailLink.vy = tailLink.pdx = tailLink.pnear = tailLink.accent = 0;
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
    tailAnim.dragDX += dockDX;
    tailAnim.dragDY += dockDY;
    bootyPhys.vx += Math.max(-85, Math.min(85, -ddx * 3.4));
    bootyPhys.vy += Math.max(-85, Math.min(85, -ddy * 3.2));
    ensureBootyRaf();
    if (Math.hypot(ddx, ddy) > 9) {
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

  function spankBooty(event) {
    if (!button.classList.contains("is-nsfw")) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    bootyPhys.vy -= 74;
    bootyPhys.vx += (Math.random() < 0.5 ? 1 : -1) * (36 + Math.random() * 18);
    bootyPhys.ripple = 1.0;
    bootyPhys.rippleTime = 0;
    bootyPhys.wave = 1.0;
    bootyPhys.waveT = 0;
    bootyPhys.mL = 0.95 + Math.random() * 0.10;
    bootyPhys.mR = 0.95 + Math.random() * 0.10;
    mouthSt.gasp = 0.5;
    mouthSt.flustered = 1.5;
    mouthSt.happy = 2.2;
    var nowSp = performance.now() / 1000;
    fxSt.spankT = 1;
    fxSt.effort = Math.min(1, fxSt.effort + 0.35);
    fxSt.flush = Math.min(1, fxSt.flush + 0.45);
    fxSt.glanceFrom = nowSp + 0.45;
    fxSt.glanceUntil = nowSp + 2.0;
    fxSt.glanceDir = Math.random() < 0.5 ? -1 : 1;
    var spPan = 0;
    if (event && Number.isFinite(event.clientX)) {
      var spR = button.getBoundingClientRect();
      spPan = Math.max(-1, Math.min(1, ((event.clientX - spR.left) / Math.max(1, spR.width) - 0.5) * 1.6));
    }
    sfx.slap(0.6 + Math.random() * 0.4, spPan);
    window.setTimeout(function () { sfx.gasp(); }, 60);
    spawnFx("♥", 3 + Math.round(Math.random() * 2));
    triggerBlink();
    ensureBootyRaf();
    button.classList.add("is-blushing");
    if (blushTimer) window.clearTimeout(blushTimer);
    blushTimer = window.setTimeout(function () {
      blushTimer = 0;
      button.classList.remove("is-blushing");
    }, 850);
    var spankGen = danceGenPeek("spank");
    if (showNsfwBubble(spankGen || NSFW_SPANK_LINES[bubbleIdx++ % NSFW_SPANK_LINES.length], false, false, { type: true }) && spankGen) {
      danceGenUse("spank");
    }
  }

  button.addEventListener("contextmenu", function (event) {
    if (!button.classList.contains("is-nsfw")) return;
    event.preventDefault();
    spankBooty(event);
  });

  button.addEventListener("dblclick", function (event) {
    if (!button.classList.contains("is-nsfw")) return;
    event.preventDefault();
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
    if (!playback.playing) return;
    ensureBootyRaf();
  }

  var idleBootyTimer = 0;
  var idleBootySide = 1;
  var nextIdleGesture = "curl";

  function idleBootyReady() {
    return !!(
      button.classList.contains("is-nsfw") &&
      !playback.playing &&
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
      if (nextIdleGesture) {
        if (startGesture(nextIdleGesture)) nextIdleGesture = nextIdleGesture === "curl" ? "stretch" : "";
      } else {
        nextIdleGesture = "curl";
        idleBootySide = -idleBootySide;
        bootyPhys.vy -= 3 + Math.random() * 3;
        bootyPhys.vx += idleBootySide * (9 + Math.random() * 4);
        ensureBootyRaf();
      }
    }
    idleBootyTimer = window.setTimeout(runIdleBooty, 9000 + Math.round(Math.random() * 6000));
  }

  function startIdleBooty() {
    if (idleBootyTimer || !idleBootyReady()) return;
    idleBootyTimer = window.setTimeout(runIdleBooty, 7000 + Math.round(Math.random() * 5000));
  }

  var longPressTimer = 0;

  function clearLongPress() {
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  }

  button.addEventListener("pointerdown", function (event) {
    if (event.button && event.button !== 0) return;
    stopDance();
    if (!event.isPrimary) {
      clearLongPress();
      pinching = true;
      suppressClick = true;
      cancelDrag();
      return;
    }
    if (pinching) return;
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
    // iPhone has no right-click / reliable double-click: a long press (~0.55s) = spank.
    clearLongPress();
    if (event.pointerType === "touch" && button.classList.contains("is-nsfw")) {
      var pressId = event.pointerId;
      longPressTimer = window.setTimeout(function () {
        longPressTimer = 0;
        if (drag && drag.id === pressId && !drag.moved && !pinching) {
          suppressClick = true;
          spankBooty();
          if (navigator.vibrate) { try { navigator.vibrate(18); } catch (_) {} }
        }
      }, 550);
    }
  });

  button.addEventListener("pointermove", function (event) {
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
      clearLongPress();
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

  button.addEventListener("pointerup", clearLongPress);
  button.addEventListener("pointercancel", clearLongPress);
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
      playback.playing &&
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

  function onHaloBeat() {
    beatCount += 1;
    if (beatCount < nextDanceBeat) return;
    if (!danceReady() || danceWrap.classList.contains("is-dancing") || pointerOverChip()) return;
    nextDanceBeat = beatCount + 24;
    triggerDance();
  }

  function setWaveLive(on) {
    var live = !!(on && onMusiquePage() && playback.playing && available && !document.hidden);
    button.classList.toggle("is-wave-live", live);
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

  function applyPlayback(data) {
    if (!data || data.ok === false) return;
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
      var speed = nextTrack ? trackSpeed(nextTrack) : "1.25s";
      wave.style.setProperty("--wave-speed", speed);
      danceWrap.style.setProperty("--dance-duration", (parseFloat(speed) * 2).toFixed(2) + "s");
      beatCount = 0;
      nextDanceBeat = 8;
      stopDance();
      if (nextPlaying && playback.track) {
        window.setTimeout(fetchAmbientWhisper, 3500);
        danceGen.lines = {};   // the previous pack may name the previous song
        if (button.classList.contains("is-nsfw")) window.setTimeout(function () { danceGenFetch(true); }, 1500);
      }
    }
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
    if (event.detail && event.detail.tab !== "quiz") stopListening();
    syncAvailability();
  });
  window.addEventListener("hashchange", syncAvailability);

  danceWrap.addEventListener("animationend", function (event) {
    if (event.animationName === "hq-musica-chip-dance") finishDance();
  });

  wave.firstElementChild.addEventListener("animationiteration", function (event) {
    if (event.animationName === "hq-musica-chip-wave-bar") onHaloBeat();
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
    sfx.stop();
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
      if (!wasAvailable) playEntrance();
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

  button.addEventListener("keydown", function (event) {
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
