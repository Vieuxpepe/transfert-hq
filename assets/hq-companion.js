/* Transfert HQ — Transferania (ambient + chat, hq_ai.py transferania.json memory). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqCompanion = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const LS_ON = "hq_companion_on";
  const LS_PERSONA = "hq_companion_persona";
  const LS_MUTE = "hq_companion_mute_until";
  const LS_NSFW = "hq_companion_nsfw";
  const LS_NSFW_BTN = "hq_companion_nsfw_btn";
  const LS_FORGE_INTENSITY = "hq_companion_forge_intensity";
  const LS_FORGE_HOT = "hq_companion_forge_hot";
  const LS_FORGE_SOUND = "hq_companion_forge_sound";
  const LS_TOUCH_HAPTICS = "hq_companion_touch_haptics";
  const LS_FORGE_PORN = "hq_companion_forge_porn";
  const LS_FORGE_EXTREME = "hq_companion_forge_extreme";
  const LS_FORGE_HYBRID = "hq_companion_forge_hybrid";
  const LS_FORGE_STOCK_CHANCE = "hq_companion_forge_stock_chance";
  const LS_FORGE_POSE_LOCK = "hq_companion_forge_pose_lock";
  const LS_LAST_PORTRAIT_HREF = "hq_companion_last_portrait_href";
  const LS_LAYERED_PORTRAIT = "hq_companion_layered_portrait";
  const TREAT_FORGE_KEYS = { "☕": "coffee", "🍓": "strawberry", "🌹": "rose", "💋": "kiss" };
  const LS_COLLAPSED = "hq_companion_collapsed";
  const LS_FX_SECTION = "hq_companion_fx_section";
  const LS_FX_SCROLL = "hq_companion_fx_scroll";
  const LS_FX_RECENT = "hq_companion_fx_recent";
  const LS_FX_PINS = "hq_companion_fx_pins";
  const LS_COMPANION_FLOAT = "hq_companion_float_v1";
  const LS_COMPANION_AVATAR_SCALE = "hq_companion_avatar_scale_v1";
  const AVATAR_SCALE_MIN = 0.72;
  const AVATAR_SCALE_MAX = 1.42;
  const LS_DEVICE = "hq_companion_device_id";
  const COMPANION_NAME = "Transferania";
  const ADULT_PORTRAITS = {
    neutral: "/assets/companion/transferania-adult-neutral.jpg",
    soft: "/assets/companion/transferania-adult-soft.jpg",
    warm: "/assets/companion/transferania-adult-warm.jpg",
    celebrate: "/assets/companion/transferania-adult-celebrate.jpg",
    tender: "/assets/companion/transferania-adult-tender.jpg",
  };
  const ADULT_RHYTHM_PORTRAIT = "/assets/companion/transferania-adult-rhythm.jpg";
  const LAYERED_PORTRAIT = "/assets/companion/rig-neutral-v1/source.jpg";
  const RIG_NEUTRAL_BASE = "/assets/companion/rig-neutral-v1/";
  const BUST_SLAP_FALLBACK = null;
  const BUST_SLAP_SFX = [
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_enthusiastic_slap_on_tits_01.8465daef.ogg",
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_enthusiastic_slap_on_tits_02.adb1d64a.ogg",
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_enthusiastic_slap_on_tits_03.7db333dd.ogg",
  ];
  const PLEASURE_GRUNT_SFX = [
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_yap_of_pleasure_01.03b4a7e1.ogg",
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_yap_of_pleasure_02.29257906.ogg",
    "/assets/companion/chat/reactions/elevenlabs_20261103/else_yap_of_pleasure_03.26af343f.ogg",
  ];

  function rigNeutralLayerSrc(asset) {
    const id = String(asset || "");
    if (id === "hair") return RIG_NEUTRAL_BASE + "hair-new-baked.png";
    if (id === "breast-left" || id === "breast-right") return RIG_NEUTRAL_BASE + id + "-user.svg";
    // Cups come from breast PNGs; garment-front is the same JPEG and must not paint twice.
    if (id === "garment-front") {
      return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    }
    return RIG_NEUTRAL_BASE + id + ".svg";
  }
  const ADULT_BOOTY_POSES = { "all-fours": "/assets/companion/chat/all-fours.jpg", "all-fours-side": "/assets/companion/chat/all-fours-side.jpg", "all-fours-broom": "/assets/companion/chat/all-fours-broom.jpg", "bed-prone": "/assets/companion/chat/bed-prone.jpg", "booty-arch-mirror": "/assets/companion/chat/booty-arch-mirror.jpg", "doggystyle-lookback": "/assets/companion/chat/doggystyle-lookback.jpg" };
  const ADULT_LOOP_MS = { "tease-sway": 2600, "tease-glow": 2400, "tease-ken": 2800, "tease-bob": 4200, "tease-arch": 4600, "tease-booty": 4600 };
  const ADULT_LOOP_HREF = { "tease-01": "/assets/companion/loops/tease-01.jpg", "tease-02": "/assets/companion/loops/tease-02.jpg" };
  const ADULT_FX_IDLE = ["bounce", "steam", "burst"];
  const DEFAULT_PREFS = { nickname: "", address: "tu", qc_dial: "light", intensity: 2, topics_off: [], celebrate: true };
  const VIEW_LABEL = {
    accueil: "Accueil",
    carnet: "Carnet",
    calendrier: "Calendrier",
    dessiner: "Dessiner",
    forge: "Forge",
    fichiers: "Fichiers",
    projets: "Projets",
    inventaire: "Inventaire",
    lecteur: "Lecteur",
    ops: "Terminal",
    plus: "Système",
  };

  function calm(win) {
    try {
      return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function digest(win) {
    const doc = win.document;
    const lines = [];
    const view = doc.body.dataset.view || "accueil";
    lines.push("Vue : " + (VIEW_LABEL[view] || view));
    const panel = doc.querySelector('[data-panel="' + view + '"]');
    const rootEl = panel || doc;
    rootEl.querySelectorAll(".sec-head h2, .sec-head .summary-title, #view-label, .view-label").forEach((h) => {
      const t = (h.textContent || "").trim().replace(/\s+/g, " ");
      if (t && t.length < 120) lines.push("Titre : " + t);
    });
    rootEl.querySelectorAll(".badge, .fx-selcount strong, #player-count, #hq-uptime").forEach((b) => {
      const t = (b.textContent || "").trim();
      if (t && t !== "—" && t.length < 40) lines.push("Indicateur : " + t);
    });
    const pn = doc.getElementById("player-name");
    if (view === "lecteur" && pn) {
      const t = (pn.textContent || "").trim();
      if (t && !/Aucun fichier/i.test(t)) lines.push("Lecture : " + t);
    }
    if (view === "fichiers") {
      const crumb = doc.querySelector(".fx-crumb, .fx-path");
      if (crumb) lines.push("Dossier : " + (crumb.textContent || "").trim().slice(0, 80));
      const n = doc.querySelectorAll(".fx-card, .fx-list li.file").length;
      if (n) lines.push("Éléments visibles : " + n);
    }
    if (view === "carnet") {
      const title = doc.querySelector(".cn-page-title, .carnet-page-title, [data-page-title]");
      if (title) lines.push("Page carnet : " + (title.textContent || "").trim().slice(0, 100));
    }
    if (view === "calendrier") {
      const mode = doc.querySelector(".hq-cal-tabs button[aria-selected=true]");
      if (mode) lines.push("Mode calendrier : " + (mode.textContent || "").trim());
    }
    if (view === "forge") {
      const priv = doc.getElementById("forge-studio");
      if (priv && priv.classList.contains("forge-private")) lines.push("Forge : coffre privé (sans détail)");
      else lines.push("Forge : studio ouvert");
    }
    const hash = (win.location.hash || "").slice(1);
    if (hash) lines.push("Ancre : #" + hash.slice(0, 80));
    return lines.join("\n").slice(0, 1400);
  }

  function seedForView(view) {
    const q = {
      accueil: "Qu'est-ce que je devrais prioriser aujourd'hui ?",
      carnet: "Résume la page ouverte du Carnet et propose la prochaine action.",
      calendrier: "Quels événements demandent préparation cette semaine ?",
      fichiers: "Que contient ce dossier et que devrais-je en faire ?",
      projets: "Où en sont mes projets actifs ?",
      inventaire: "Qu'est-ce qui manque ou est bas dans l'inventaire ?",
      lecteur: "Que puis-je faire avec le fichier en cours de lecture ?",
      forge: "Comment améliorer mon prochain prompt Forge ?",
      dessiner: "Des idées pour mon dessin en cours ?",
      ops: "Quelles commandes allowlist sont utiles ici ?",
      plus: "Résume l'état du pont et ce que je devrais vérifier.",
    };
    return q[view] || q.accueil;
  }

  function getDeviceId(win) {
    try {
      let id = win.localStorage.getItem(LS_DEVICE);
      if (id && id.length >= 12) return id;
      let rnd = "";
      if (win.crypto && typeof win.crypto.randomUUID === "function") {
        rnd = win.crypto.randomUUID().replace(/-/g, "");
      } else {
        rnd = String(Date.now()) + Math.random().toString(36).slice(2, 14);
      }
      id = ("hq" + rnd).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
      if (id.length < 12) id = ("hqdev" + String(Date.now())).slice(0, 24);
      win.localStorage.setItem(LS_DEVICE, id);
      return id;
    } catch (_) {
      return ("hqfallback" + String(Date.now())).slice(0, 24);
    }
  }

  function aiGetUrl(win, extraQuery) {
    const base = extraQuery ? "/api/ai?" + extraQuery + "&" : "/api/ai?";
    return base + "device_id=" + encodeURIComponent(getDeviceId(win));
  }

  function withDevice(win, payload) {
    return Object.assign({ device_id: getDeviceId(win) }, payload || {});
  }

  const NAV_PREFIX = ["Vue :", "Titre :", "Indicateur :", "Ancre :", "Mode calendrier :", "Forge :", "Dossier :", "Éléments visibles :", "Page carnet :", "Lecture :"];
  const DWELL_MS = 7000; // a page has to hold your attention a moment before she says anything about it
  const PULSE_MS = 60000;
  // eyes1: general eye life on the ordinary (non-NSFW) face: irregular blinks, micro drift,
  // catchlight shimmer, mood lids, event reactions. false = exact pre-eyes1 behaviour.
  const EYES_ALIVE = true;
  const EYES_BLINK_MIN_MS = 2500;
  const EYES_BLINK_MAX_MS = 7000;
  const EYES_DRIFT_MAX_PX = 1.6;
  // pupils1: pupil scale bounds (CSS-drawn pupil core inside the ordinary-face eye).
  const EYES_PUPIL_MIN = 0.9;
  const EYES_PUPIL_MAX = 1.14;

  function navOnly(dig) {
    return String(dig || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .every((l) => NAV_PREFIX.some((p) => l.startsWith(p)));
  }

  // When to talk. A real person stays quiet while you click around or type, speaks after you settle,
  // talks less the more she has talked, and lets true events (a backup, a class soon) through quickly.
  function decide(st, now, reason) {
    const since = (t) => (t ? now - t : Infinity);
    if (reason === "manual") return { ok: true };
    if (st.hidden) return { ok: false };
    const typing = since(st.typingAt);
    if (typing < 5000) return { ok: false, retry: 5200 - typing };
    const busy = (st.navTimes || []).filter((t) => now - t < 45000).length >= 3;
    const spoke = since(st.lastSpokeAt);
    if (reason === "event" || reason === "signal") {
      if (busy) return { ok: false, retry: 8000 };
      if (spoke < 15000) return { ok: false, retry: 15000 - spoke + 200 };
      return { ok: true };
    }
    if (busy) return { ok: false };
    if (reason === "idle") return { ok: spoke >= 12 * 60000 && (st.idleStreak || 0) < 2 };
    const recent = (st.spoke || []).filter((t) => now - t < 20 * 60000).length;
    const gap = Math.min(6 * 60000, 60000 * (1 + recent));
    if (spoke < gap) return { ok: false };
    if (reason === "view" && st.navOnly && spoke < 4 * 60000) return { ok: false };
    return { ok: true };
  }

  // Word by word, with the small pauses a voice makes at commas and full stops.
  function paceWords(text) {
    const parts = String(text || "").trim().split(/(\s+)/);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
      const w = parts[i];
      if (!w) continue;
      let d = 75 + Math.min(85, w.length * 8);
      if (/[.!?…]["»)]?$/.test(w)) d += 340;
      else if (/[,;:]$/.test(w)) d += 180;
      else if (/^[—–-]$/.test(w)) d += 210;
      out.push({ t: w + (parts[i + 1] ? " " : ""), d });
    }
    return out;
  }

  // Where the eyes look: towards the cursor, a couple of pixels at most, more the further it is.
  function glance(dx, dy) {
    const dist = Math.hypot(dx, dy);
    if (!dist) return { x: 0, y: 0 };
    const k = Math.min(1, dist / 240);
    return { x: Math.round((dx / dist) * k * 2.4 * 10) / 10, y: Math.round((dy / dist) * k * 1.6 * 10) / 10 };
  }

  // The day's mood (server) as the orb's breath and warmth: softer = slower, warmer = a bit quicker and rosier.
  function orbVars(m) {
    const soft = Math.max(0, Math.min(1, Number(m && m.soft) || 0));
    const warm = Math.max(0, Math.min(1, Number(m && m.warm) || 0));
    return { breath: (5.2 - warm * 1.4 + soft * 1.6).toFixed(2) + "s", warm: warm.toFixed(2), soft: soft >= 0.5 };
  }

  function speechDelivery(text, context) {
    const normal = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const mode = context && context.mode;
    let style = "neutral";
    if (mode === "comfort" || /\b(prends ton temps|je t'ecoute|take your time|i'm here for you)\b/.test(normal)) style = "warm";
    else if (/\b(je me demande|peut-etre|imaginons|paradoxe|i wonder|perhaps|what if)\b/.test(normal)) style = "thoughtful";
    else if (/\b(quelle surprise|quel miracle|miracle informatique|what a surprise|of course it did)\b/.test(normal)) style = "deadpan";
    else if (mode !== "practical" && context && context.flirt && /\b(taquin|malin|charme|complice|tease|cheeky|handsome)\b/.test(normal)) style = "playful";
    const profiles = {
      neutral: {rate: 1, pitch: 1.04, pause: 140},
      thoughtful: {rate: .94, pitch: 1.01, pause: 360},
      deadpan: {rate: .98, pitch: .98, pause: 280},
      warm: {rate: .96, pitch: 1.05, pause: 240},
      playful: {rate: 1.03, pitch: 1.09, pause: 180},
    };
    if (context && profiles[context.style]) style = context.style;
    return {style, ...profiles[style]};
  }

  function speechSegments(text) {
    // Split only at sentence punctuation, retaining every character and decimal.
    const value = String(text || ""), parts = [];
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      if (/[.!?…]/.test(value[i]) && (i + 1 === value.length || /\s/.test(value[i + 1]))) {
        parts.push(value.slice(start, i + 1)); start = i + 1;
      }
    }
    if (start < value.length) parts.push(value.slice(start));
    if (parts.length <= 6) return parts;
    return parts.slice(0, 5).concat(parts.slice(5).join(""));
  }

  const CHARACTER_POSES = {
    neutral: [0, 0, 0, 0],
    curiosity: [.65, .42, .2, -.002],
    concentration: [-.2, -.12, -.12, -.003],
    reassurance: [.3, .12, .12, -.002],
    pride: [-.35, .2, .26, .003],
    thoughtful: [.45, .1, .28, -.004],
    playful: [-.5, .3, -.1, .001],
  };
  const NEUTRAL_CHARACTER_POSE = Object.freeze({tilt: 0, browLeft: 0, browRight: 0, nod: 0});

  function expressionPose(plan, elapsed, blocked) {
    if (blocked || !plan || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= 7000) return NEUTRAL_CHARACTER_POSE;
    const key = Object.prototype.hasOwnProperty.call(CHARACTER_POSES, plan.primary) ? plan.primary : "neutral";
    const pose = CHARACTER_POSES[key];
    const mix = plan.secondary === "cautious" ? .65 : 1;
    const amount = Math.min(1, elapsed / 450, (7000 - elapsed) / 1800) * mix;
    return {tilt: pose[0] * amount, browLeft: pose[1] * amount,
      browRight: pose[2] * amount, nod: pose[3] * amount};
  }

  function applyCharacterExpression(win, plan) {
    // Reply-time state only. The existing rig loop consumes the small pose;
    // no new animation loop, root CSS variables, filters, or DOM lookups.
    const primary = plan && Object.prototype.hasOwnProperty.call(CHARACTER_POSES, plan.primary) ? plan.primary : "neutral";
    S.characterExpression = {primary, secondary: plan && plan.secondary, startedAt: win.performance.now()};
  }

  function pickVoice(voices) {
    const list = Array.from(voices || []);
    const isFemaleNeural = (v) =>
      v &&
      v.name &&
      /Sylvie|Denise|Eloise|Amélie|Amelie|Chloé|Chloe|Hortense|Julie|Natural|Online|Google/i.test(v.name) &&
      !/Thomas|Henri|Antoine|Claude|Nicolas|Paul/i.test(v.name);
    return (
      list.find((v) => /^fr[-_]CA/i.test(v.lang) && isFemaleNeural(v)) ||
      list.find((v) => /^fr\b/i.test(v.lang) && isFemaleNeural(v)) ||
      list.find((v) => /^fr[-_]CA/i.test(v.lang)) ||
      list.find((v) => /^fr\b/i.test(v.lang)) ||
      null
    );
  }

  // Pure, bounded posture and fabric responses. They feed the existing springs;
  // there is no second animation clock or independent breast-position spring.
  const RIG_POSTURE_GOALS = {upright:[0,0], forward:[.8,0], reclined:[-.85,0], left:[0,-.85], right:[0,.85]};
  function rigPostureGoal(name) {
    const pair = Object.prototype.hasOwnProperty.call(RIG_POSTURE_GOALS, name) ? RIG_POSTURE_GOALS[name] : RIG_POSTURE_GOALS.upright;
    return {pitch:pair[0], roll:pair[1]};
  }
  function stepRigPosture(previous, name, dt, frozen = false, reduced = false) {
    const p = previous || {pitch:0,roll:0}, goal = rigPostureGoal(name);
    if (frozen) return {pitch:p.pitch,roll:p.roll};
    if (reduced) return goal;
    const a = 1-Math.exp(-clampNum(Number(dt)||0,0,.05)/.55);
    return {pitch:p.pitch+(goal.pitch-p.pitch)*a,roll:p.roll+(goal.roll-p.roll)*a};
  }
  function rigPostureGravity(pitch = 0, roll = 0) {
    const pa = clampNum(Number(pitch)||0,-1,1)*Math.PI/5;
    const ra = clampNum(Number(roll)||0,-1,1)*Math.PI/6;
    const depth = Math.sin(pa), vertical = Math.cos(pa)*Math.cos(ra);
    return {tilt:ra,hang:depth*2.8+(vertical-1)*1.2,spread:Math.max(0,-depth)*1.6};
  }
  function clothTensionTarget(input = {}) {
    const n = (key) => Number.isFinite(input[key]) ? input[key] : 0;
    return clampNum(Math.hypot(n('x')*.035,n('y')*.025) + Math.abs((Number.isFinite(input.sy)?input.sy:1)-1)*2.2 +
      Math.abs(n('bend'))*.018 + Math.min(.3,Math.max(0,n('speed'))*.006) + clampNum(n('support'),0,1)*.25 + clampNum(n('pull'),0,1)*.72,0,1);
  }
  function stepClothTension(previous, target, dt, reduced = false) {
    const p = clampNum(Number(previous)||0,0,1), t = clampNum(Number(target)||0,0,1);
    const a = reduced ? 1 : 1-Math.exp(-clampNum(Number(dt)||0,0,.05)*(t>p?14:6));
    const next = p+(t-p)*a;
    return Math.abs(next-t)<.002 ? t : next;
  }
  function rigClothCurves(side, tension, direction = 0) {
    const t = clampNum(Number(tension)||0,0,1), slack = 1-t, dir=clampNum(Number(direction)||0,-1,1);
    const curves = side==='right' ? [[298,380,320,379,344,364],[298,400,326,401,355,382],[313,416,341,414,368,396]] :
      [[112,380,134,391,158,393],[112,401,138,417,166,419],[145,426,165,436,188,430]];
    return curves.map(([x,y,cx,cy,ex,ey]) =>
      `M${x} ${y} Q${(cx+dir*t*8).toFixed(1)} ${(cy+slack*16).toFixed(1)} ${(ex+dir*t*6).toFixed(1)} ${(ey-t*6).toFixed(1)}`).join(' ');
  }

  function rigClothTextureTransform(side, tension, direction = 0) {
    const t=clampNum(Number(tension)||0,0,1), dir=clampNum(Number(direction)||0,-1,1);
    const [x,y]=side==='right'?[345,401]:[139,413];
    const sy=1+t*.3*(1-Math.abs(dir)*.5), sx=1/Math.sqrt(sy);
    const shear=dir*t*14+(side==='right'?1:-1)*t*2;
    return `translate(${x} ${y}) skewX(${shear.toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-x} ${-y})`;
  }

  const pure = { rigPostureGoal, stepRigPosture, rigPostureGravity, clothTensionTarget, stepClothTension, rigClothCurves, rigClothTextureTransform, supportMapPixel, sampleLateralSwipe, cursorSupportContact, cursorSupportSpring, lateralImpact, grabWeights, releaseFeel, digest, seedForView, VIEW_LABEL, COMPANION_NAME, DEFAULT_PREFS, getDeviceId, navOnly, decide, paceWords, glance, orbVars, pickVoice, speechDelivery, speechSegments, expressionPose, DWELL_MS, bustPullResponse, bustPullSpring, bustPullSettle, bustPullGravity, bustPullFollow, rigSecondaryMotion, rigHairMotion, readLayeredPortrait, anchoredPullFrame };

  const S = {
    win: null,
    el: null,
    line: null,
    bubble: null,
    logEl: null,
    inputEl: null,
    memChip: null,
    busy: false,
    chatBusy: false,
    lastKey: "",
    cap: "flirt",
    collapsed: false,
    expanded: false,
    messages: [],
    hasSummary: false,
    audioCycles: { treats: {}, lewd: {} },
    prefs: Object.assign({}, DEFAULT_PREFS),
    pendingCelebrate: false,
    pendingCelebrateMsg: "",
    pendingError: false,
    pendingErrorMsg: "",
    pendingAfterglow: false,
    pendingEscalateMsg: "",
    celebrateT: 0,
    prefsSaveT: 0,
    t: 0,
    blocked: false,
    nsfwAllowed: false,
    nsfwBlock: "",
    sessionAdmin: false,
    nsfwSwitchT: 0,
    nsfwOn: false,
    nsfwBtn: null,
    tapC: 0,
    tapT: 0,
    tapOnceT: 0,
    logAnimFrom: 0,
    hadSummary: false,
    sendBtn: null,
    lastView: "",
    moodT: 0,
    lastAmbientAt: 0,
    spoke: [],
    navTimes: [],
    typingAt: 0,
    idleStreak: 0,
    lastActAt: 0,
    pendingEvent: null,
    lastEventId: "",
    face: null,
    adultPortrait: null,
    adultShaft: null,
    adultShaftTrack: null,
    rhythmRestore: null,
    orbMood: null,
    adultFxTimers: null,
    adultFxIdleT: 0,
    adultLoopRestore: null,
    lastOrbWarm: false,
    blinkT: 0,
    lookT: 0,
    lastPointerMoveAt: 0,
    attentionScore: 0,
    userLookingAtCompanion: false,
    lastAvatarFocusAt: 0,
    lastLookEngageAt: 0,
    attentionVisibleRatio: 1,
    attentionIo: null,
    settlingCooldownAt: 0,
    bubbleWeightT: 0,
    lastPulseMotionAt: 0,
    companionTypingLean: false,
    typingLeanT: 0,
    viewGlanceT: 0,
    wasCollapsedMinimal: false,
    companionFloat: { x: 0, y: 0 },
    companionAvatarScale: 1,
    companionDragActive: false,
    companionDragVel: { vx: 0, vy: 0 },
    companionFloatInertia: null,
    companionHomeRaf: 0,
    intimeMode: false,
    intimeSync: false,
    chromeMotionRaf: 0,
    idleFidgetT: 0,
    idleAmbientJiggleT: 0,
    idleAnimRouletteT: 0,
    idleForgeSparkT: 0,
    idleWalkUntil: 0,
    idleWalkStep: 0,
    idleWalkNextAt: 0,
    idleExtrasT: 0,
    idleHummingNoteI: 0,
    morningStretchDone: false,
    voiceLipsyncT: 0,
    gripTapAt: 0,
    bubblePullSX: 0,
    bubblePullSY: 0,
    cleavageRamp: 0,
    cleavageRampTarget: 0,
    pullShearHapticAt: 0,
    bustStrokeBX: 0,
    bustStrokeBY: 0,
    cleavageEnterAt: 0,
    cleavageGather: 0,
    pullRenderX: 0,
    pullRenderShear: 0,
    pullSloshX: 0,
    pullSloshY: 0,
    pullDeepGlanceDone: false,
    pullExpress: null,
    contactBlush: 0,
    contactBlushUntil: 0,
    lastSlapBlushBoost: 0,
    slapExpress: null,
    contactFlushUntil: 0,
    contactFeverTeaseAt: 0,
    contactWarmthSession: 0,
    lastRarePullLewdAt: 0,
    lastContactFlushAt: 0,
    bustAfterglowUntil: 0,
    bustAfterglowStrength: 0,
    bustAfterglowDuration: 12000,
    bustBreathBump: 0,
    bustBreathBumpUntil: 0,
    bustPetOrbitAngle: 0,
    bustPetOrbitAmp: 0,
    bustPetLastAngle: null,
    holdAnchorX: 0,
    holdAnchorY: 0,
    cleavageHoldCandidate: false,
    pullGlanceT: 0,
    voiceBtn: null,
    escalateBtn: null,
    adultePill: null,
    avToolbar: null,
    fxDebug: null,
    fxDebugMenu: null,
    fxDebugToggle: null,
    fxDebugDocClose: null,
    forgeTreatBonuses: null,
    forgeRevealIndex: 0,
    forgeRevealVariants: null,
    forgeIntensityRange: null,
    forgeHotBox: null,
    forgeSoundBox: null,
    forgeRevealT: 0,
    forgeRevealKey: null,
  };
  const LS_VOICE = "hq_companion_voice";
  const FORGE_REVEAL_MS = 12000;

  const TOAST_SKIP = /^(OK\.?|Enregistrement…?|Chargement…?|Copié!?|Thème|Actualisé)$/i;
  const TOAST_CELEBRATE = /\b(?:enregistr|sauvegard|cré|ajout|restaur|termin|valid)(?:é|ée|és|ées)(?![\wà-ÿ])|\bnoté(?![\wà-ÿ])/i;
  const TOAST_COMPANION_OWN = /Transferania|Mémoire effacée|Mode adulte|Option adulte/i;

  function toastCompanionSignal(win, toastEl) {
    const msg = String((toastEl && toastEl.textContent) || "").trim();
    if (!toastEl || !msg) return "none";
    if (toastEl.classList.contains("err")) return "error";
    if (toastEl.dataset && toastEl.dataset.hqCompanionCelebrate === "1") return "celebrate";
    if (toastEl.dataset && toastEl.dataset.hqCompanionCelebrate === "0") return "none";
    if (TOAST_COMPANION_OWN.test(msg)) return "none";
    if (TOAST_SKIP.test(msg) || msg.length < 5) return "none";
    if (TOAST_CELEBRATE.test(msg)) return "celebrate";
    return "none";
  }

  function chatMessagesOnly(msgs) {
    return (msgs || []).filter((m) => m && m.kind !== "ambient");
  }

  function syncAmbientLineDup() {
    if (!S.line || !S.expanded) {
      if (S.line) S.line.hidden = false;
      return;
    }
    const last = chatMessagesOnly(S.messages)
      .slice()
      .reverse()
      .find((m) => m.role === "assistant");
    const line = String(S.line.textContent || "").trim();
    const dup = !!(last && line && line === String(last.text || "").trim());
    S.line.hidden = dup;
  }

  function isCompactUI(win) {
    try {
      if (win.matchMedia("(pointer: coarse)").matches) return true;
      if (win.matchMedia("(max-width: 768px)").matches) return true;
    } catch (_) {}
    return false;
  }

  function prefersHoverUI(win) {
    try {
      return win.matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch (_) {}
    return true;
  }

  function readCollapsed(win) {
    try {
      const v = win.localStorage.getItem(LS_COLLAPSED);
      if (v === "0") return false;
      if (v === "1") return true;
    } catch (_) {}
    return true;
  }

  function setCollapsed(on, persist) {
    const wasMinimal = !!(S.collapsed && S.el && S.el.classList.contains("is-minimal"));
    S.collapsed = !!on;
    if (S.el) {
      S.el.classList.toggle("is-minimal", S.collapsed && !S.win.document.body.classList.contains("hq-ai-open") && !S.expanded);
      if (S.collapsed) S.el.classList.remove("has-hint");
    }
    if (persist !== false && S.win) {
      try {
        S.win.localStorage.setItem(LS_COLLAPSED, S.collapsed ? "1" : "0");
      } catch (_) {}
    }
    syncVisibility();
    if (wasMinimal && !S.collapsed && S.nsfwOn && S.win && !calm(S.win)) {
      applyLive2DImpulse(S.win, 0, -52, 0);
      triggerSettlingFidget(S.win);
    }
  }

  function hasPendingSignals() {
    return !!(S.pendingCelebrateMsg || S.pendingErrorMsg || S.pendingAfterglow || S.pendingEvent);
  }

  async function syncStatusOnly(win) {
    try {
      const st = await fetchJson(win, aiGetUrl(win));
      applyNsfwStatus(st);
      if (st && st.companion_cap) S.cap = st.companion_cap;
      syncNsfwUI();
    } catch (_) {}
  }

  function readOn(win) {
    try {
      return win.localStorage.getItem(LS_ON) !== "0";
    } catch (_) {
      return true;
    }
  }

  function readPersona(win) {
    try {
      return win.localStorage.getItem(LS_PERSONA) || "flirt";
    } catch (_) {
      return "flirt";
    }
  }

  function muted(win) {
    try {
      return Number(win.localStorage.getItem(LS_MUTE) || 0) > Date.now();
    } catch (_) {
      return false;
    }
  }

  function readNsfw(win) {
    try {
      return win.localStorage.getItem(LS_NSFW) === "1";
    } catch (_) {
      return false;
    }
  }

  function adulteUiVisible(win) {
    try {
      if (win.localStorage.getItem(LS_NSFW_BTN) === "0") return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  function nsfwBtnVisible(win) {
    return adulteUiVisible(win);
  }

  function nsfwBlockMessage(code) {
    if (code === "role") return "Mode adulte : réservé à la session admin.";
    if (code === "disabled") return "Mode adulte désactivé dans bridge_config (companion_nsfw_enabled).";
    return "Mode adulte indisponible.";
  }

  function applyNsfwStatus(st) {
    S.sessionAdmin = !!(st && st.session_admin);
    S.nsfwAllowed = !!(st && st.nsfw_allowed);
    S.nsfwBlock = st && st.nsfw_block ? String(st.nsfw_block) : "";
    syncSessionAdminChrome(S.win);
    if (S.win) refreshForgeUiDefaults(S.win);
  }

  function syncSessionAdminChrome(win) {
    if (!win || !win.document || !win.document.body) return;
    win.document.body.classList.toggle("session-admin", !!S.sessionAdmin);
    const navIntime = win.document.getElementById("nav-intime");
    if (navIntime) navIntime.hidden = !S.sessionAdmin;
    const openIntime = win.document.getElementById("hq-intime-open");
    if (openIntime) openIntime.hidden = !S.sessionAdmin;
    const view = win.document.body.dataset.view || "accueil";
    if (view === "intime" && !S.sessionAdmin) {
      if (typeof win.setView === "function") win.setView("accueil");
      else leaveIntimeView(win);
    }
  }

  function enterIntimeView(win) {
    if (!win || !S.el || !S.sessionAdmin) return;
    if (S.intimeMode) return;
    S.companionFloatInertia = null;
    stopCompanionChromeLoop(win);
    if (S.el) S.el.classList.remove("is-companion-coasting");
    S.intimeMode = true;
    S.el.classList.add("is-intime-mode");
    win.document.body.classList.add("hq-intime-active");
    setExpanded(true);
    setCollapsed(false, false);
    applyCompanionFloat(win);
    syncVisibility();
    noteActivity(win, "nav");
  }

  function leaveIntimeView(win) {
    if (!win || !S.el || !S.intimeMode) return;
    S.el.classList.remove("is-intime-mode");
    win.document.body.classList.remove("hq-intime-active");
    S.intimeMode = false;
    applyCompanionFloat(win);
    syncVisibility();
  }

  function syncIntimeView(win, view) {
    if (!win || S.intimeSync) return;
    view = view || (win.document.body && win.document.body.dataset.view) || "accueil";
    if (view === "intime") {
      win.requestAnimationFrame(() => {
        if ((win.document.body.dataset.view || "accueil") !== "intime") return;
        if (S.intimeSync || S.intimeMode) return;
        S.intimeSync = true;
        try {
          enterIntimeView(win);
        } finally {
          S.intimeSync = false;
        }
      });
      return;
    }
    S.intimeSync = true;
    try {
      leaveIntimeView(win);
    } finally {
      S.intimeSync = false;
    }
  }

  function bindIntimeChrome(win) {
    const resetBtn = win.document.getElementById("hq-intime-reset");
    const chatBtn = win.document.getElementById("hq-intime-focus-chat");
    const foldBtn = win.document.getElementById("hq-intime-fold");
    if (resetBtn && !resetBtn.__hqCompanionIntime) {
      resetBtn.__hqCompanionIntime = true;
      resetBtn.addEventListener("click", () => resetCompanionPose(win));
    }
    if (chatBtn && !chatBtn.__hqCompanionIntime) {
      chatBtn.__hqCompanionIntime = true;
      chatBtn.addEventListener("click", () => {
        setExpanded(true);
        if (!S.readTarget) winFocusInput();
      });
    }
    if (foldBtn && !foldBtn.__hqCompanionIntime) {
      foldBtn.__hqCompanionIntime = true;
      foldBtn.addEventListener("click", () => setCollapsed(true, true));
    }
  }

  // perf10: applyNsfwStatus runs more than once at startup; share one GET within 5 s.
  let forgeUiDefaultsInflight = null;
  let forgeUiDefaultsAt = 0;
  function refreshForgeUiDefaults(win, force) {
    if (!S.sessionAdmin || !S.nsfwAllowed) return Promise.resolve();
    const now = Date.now();
    if (!force && forgeUiDefaultsInflight && now - forgeUiDefaultsAt < 5000) return forgeUiDefaultsInflight;
    forgeUiDefaultsAt = now;
    forgeUiDefaultsInflight = refreshForgeUiDefaultsNow(win);
    return forgeUiDefaultsInflight;
  }

  async function refreshForgeUiDefaultsNow(win) {
    if (!S.sessionAdmin || !S.nsfwAllowed) return;
    try {
      const data = await fetchJson(win, "/api/companion/art", null, { timeoutMs: 12000 });
      if (data && data.ui_defaults) {
        S.forgeUiDefaults = data.ui_defaults;
        if (S.forgeHybridBox && win.localStorage.getItem(LS_FORGE_HYBRID) == null) {
          S.forgeHybridBox.checked = !!data.ui_defaults.hybrid_default;
        }
        if (S.forgeStockRange && win.localStorage.getItem(LS_FORGE_STOCK_CHANCE) == null) {
          const pct = Math.round(Number(data.ui_defaults.stock_chance || 0.5) * 100);
          S.forgeStockRange.value = String(Math.max(10, Math.min(90, pct)));
        }
        if (S.nsfwOn) syncAdultPortrait();
      }
    } catch (_) {}
  }

  function syncAdminSettingsVisibility(win) {
    const row = win.document.getElementById("hq-companion-nsfw-visible")?.closest(".field");
    if (row) row.hidden = !S.sessionAdmin;
  }

  function playNsfwTransition(win, turningOn) {
    if (!S.el) return;
    try {
      if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (_) {}
    S.el.classList.remove("is-nsfw-switch-on", "is-nsfw-switch-off");
    void S.el.offsetWidth;
    S.el.classList.add(turningOn ? "is-nsfw-switch-on" : "is-nsfw-switch-off");
    win.clearTimeout(S.nsfwSwitchT);
    S.nsfwSwitchT = win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-nsfw-switch-on", "is-nsfw-switch-off");
    }, turningOn ? 1500 : 1100);
    if (turningOn) {
      win.setTimeout(() => playAdultLoop(win, "tease-glow"), 480);
    } else {
      clearAdultLoopFx(win);
      win.clearTimeout(S.adultFxIdleT);
    }
  }

  function closeFxDebugMenu(win, opts) {
    if (!S.fxDebugMenu) return;
    const wasOpen = S.fxDebugMenu.classList.contains("is-open");
    // Read the scroll before hiding: a display:none panel reports 0.
    if (wasOpen && S.fxDebug) writeFxPref(win, LS_FX_SCROLL, String(Math.round(S.fxDebug.scrollTop)));
    S.fxDebugMenu.classList.remove("is-open");
    if (S.fxDebugToggle) S.fxDebugToggle.setAttribute("aria-expanded", "false");
    if (S.fxDebugDocClose) {
      win.document.removeEventListener("pointerdown", S.fxDebugDocClose, true);
      S.fxDebugDocClose = null;
    }
    if (S.fxDebug) {
      // Phone sheet lives on <body> while open (the companion is transformed and paint-contained).
      if (S.fxDebug.classList.contains("is-sheet")) {
        S.fxDebug.classList.remove("is-sheet");
        S.fxDebugMenu.appendChild(S.fxDebug);
      }
    }
    if (S.fxSheetBackdrop) {
      S.fxSheetBackdrop.remove();
      S.fxSheetBackdrop = null;
    }
    if (wasOpen && opts && opts.focusToggle && S.fxDebugToggle) S.fxDebugToggle.focus({ preventScroll: true });
  }

  function toggleFxDebugMenu(win, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!S.fxDebugMenu || S.fxDebugMenu.hidden) return;
    const open = !S.fxDebugMenu.classList.contains("is-open");
    if (!open) {
      closeFxDebugMenu(win);
      return;
    }
    S.fxDebugMenu.classList.add("is-open");
    if (S.fxDebugToggle) S.fxDebugToggle.setAttribute("aria-expanded", "true");
    if (S.renderFxRecents) S.renderFxRecents();
    const sheet = isCompactUI(win);
    if (S.fxDebug && sheet) {
      const doc = win.document;
      S.fxSheetBackdrop = doc.createElement("div");
      S.fxSheetBackdrop.className = "hq-companion-fx-sheet-backdrop";
      S.fxDebug.classList.add("is-sheet");
      S.fxDebug.style.maxHeight = "";
      doc.body.append(S.fxSheetBackdrop, S.fxDebug);
    } else if (S.fxDebug && S.fxDebugToggle) {
      // The panel opens upward: never let it run past the top of the window.
      const room = Math.floor(S.fxDebugToggle.getBoundingClientRect().top - 16);
      S.fxDebug.style.maxHeight = Math.max(180, Math.min(520, room)) + "px";
    }
    if (S.fxDebug) {
      S.fxDebug.scrollTop = Number(readFxPref(win, LS_FX_SCROLL)) || 0;
      if (!sheet && S.fxSearch) S.fxSearch.focus({ preventScroll: true });
    }
    S.fxDebugDocClose = (e) => {
      if (!S.fxDebugMenu || !S.fxDebugMenu.classList.contains("is-open")) return;
      const t = e.target;
      if (t && (S.fxDebugMenu.contains(t) || (S.fxDebug && S.fxDebug.contains(t)))) return;
      closeFxDebugMenu(win);
    };
    win.setTimeout(() => {
      win.document.addEventListener("pointerdown", S.fxDebugDocClose, true);
    }, 0);
  }

  function readFxPref(win, key) {
    try {
      return win.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeFxPref(win, key, value) {
    try {
      win.localStorage.setItem(key, value);
    } catch (_) {}
  }

  function readFxList(win, key) {
    try {
      const v = JSON.parse(win.localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 24) : [];
    } catch (_) {
      return [];
    }
  }

  function foldAccents(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  // One Forge request at a time: shows progress in the Outils header and lets the user stop waiting.
  async function withForgeJob(win, btn, label, work) {
    if (S.forgeJob) {
      if (typeof win.hqToast === "function") win.hqToast("Forge est déjà en cours · " + S.forgeJob.label, "tip", 2400);
      return;
    }
    const text = btn && btn.textContent;
    const job = { label: label, t0: Date.now(), cancelled: false };
    job.restore = () => {
      if (!btn) return;
      btn.disabled = false;
      if (text) btn.textContent = text;
    };
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    S.forgeJob = job;
    syncForgeStatus(win);
    try {
      await work(job);
    } finally {
      if (!job.cancelled) job.restore();
      if (S.forgeJob === job) S.forgeJob = null;
      syncForgeStatus(win);
    }
  }

  function cancelForgeJob(win) {
    const job = S.forgeJob;
    if (!job) return;
    job.cancelled = true;
    job.restore();
    S.forgeJob = null;
    syncForgeStatus(win);
    if (typeof win.hqToast === "function") win.hqToast("Forge · résultat ignoré (" + job.label + ")", "tip", 2400);
  }

  function syncForgeStatus(win) {
    const job = S.forgeJob;
    if (S.fxDebugMenu) S.fxDebugMenu.classList.toggle("is-forging", !!job);
    if (S.fxDebug) S.fxDebug.classList.toggle("is-forging", !!job);
    win.clearInterval(S.forgeStatusTick);
    S.forgeStatusTick = 0;
    if (!S.fxStatus) return;
    S.fxStatus.hidden = !job;
    if (!job) return;
    const paint = () => {
      const secs = Math.max(0, Math.round((Date.now() - job.t0) / 1000));
      S.fxStatusText.textContent = "Forge · " + job.label + " en cours… " + secs + " s";
    };
    paint();
    // perf16: cosmetic label only; skip while the tab is hidden (it repaints from job.t0 on the next visible tick).
    S.forgeStatusTick = win.setInterval(() => {
      if (!win.document.hidden) paint();
    }, 1000);
  }

  function wireFxPanel(win, panel, parts) {
    const doc = win.document;
    const actionBtns = Array.from(panel.querySelectorAll(".hq-companion-fx-debug-grid .hq-companion-fx-debug-btn")).filter(
      (b) => !b.closest(".hq-companion-fx-debug-opts")
    );
    const byId = new Map();
    actionBtns.forEach((b) => {
      b.dataset.fxLabel = b.textContent.trim();
      if (!b.dataset.fxId) b.dataset.fxId = "btn:" + b.dataset.fxLabel;
      if (!b.dataset.fxKind) b.dataset.fxKind = "forge";
      byId.set(b.dataset.fxId, b);
    });
    const sections = Array.from(panel.querySelectorAll(".hq-companion-fx-debug-section"));
    const groups = Array.from(panel.querySelectorAll(".hq-companion-fx-debug-group:not(.hq-companion-fx-debug-recents)"));
    let pins = readFxList(win, LS_FX_PINS).filter((id) => byId.has(id));
    const paintPins = () => actionBtns.forEach((b) => b.classList.toggle("is-pinned", pins.includes(b.dataset.fxId)));
    const togglePin = (id) => {
      pins = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
      writeFxPref(win, LS_FX_PINS, JSON.stringify(pins));
      paintPins();
      S.renderFxRecents();
    };
    paintPins();
    win.setTimeout(() => S.renderFxRecents(), 0);

    // Pinned first, then the most recent uses; proxies replay a click on the real button.
    S.renderFxRecents = () => {
      const recents = readFxList(win, LS_FX_RECENT).filter((id) => byId.has(id) && !pins.includes(id));
      const ids = [...pins, ...recents].slice(0, Math.max(pins.length, 9));
      parts.recents.replaceChildren();
      parts.recents.hidden = !ids.length;
      if (!ids.length) return;
      const head = doc.createElement("span");
      head.className = "hq-companion-fx-debug-group-label";
      head.textContent = pins.length ? "Épinglés & récents" : "Récents";
      const grid = doc.createElement("div");
      grid.className = "hq-companion-fx-debug-grid is-quick";
      ids.forEach((id) => {
        const src = byId.get(id);
        const proxy = doc.createElement("button");
        proxy.type = "button";
        proxy.className = "hq-companion-fx-debug-btn" + (pins.includes(id) ? " is-pinned" : "");
        proxy.dataset.fxRef = id;
        proxy.dataset.fxKind = src.dataset.fxKind;
        proxy.textContent = src.dataset.fxLabel;
        proxy.title = src.title;
        proxy.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (panel.classList.contains("is-pin-mode")) togglePin(id);
          else src.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: ev.shiftKey }));
        });
        grid.appendChild(proxy);
      });
      parts.recents.append(head, grid);
    };

    parts.pinMode.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const on = !panel.classList.contains("is-pin-mode");
      panel.classList.toggle("is-pin-mode", on);
      parts.pinMode.setAttribute("aria-pressed", String(on));
    });
    panel.addEventListener(
      "click",
      (ev) => {
        const b = ev.target && ev.target.closest && ev.target.closest("[data-fx-id]");
        if (!b || !byId.has(b.dataset.fxId) || b.disabled) return;
        if (panel.classList.contains("is-pin-mode")) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          togglePin(b.dataset.fxId);
          return;
        }
        const recent = readFxList(win, LS_FX_RECENT).filter((id) => id !== b.dataset.fxId);
        writeFxPref(win, LS_FX_RECENT, JSON.stringify([b.dataset.fxId, ...recent].slice(0, 12)));
      },
      true
    );
    panel.addEventListener("contextmenu", (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest("[data-fx-id], [data-fx-ref]");
      if (!b) return;
      ev.preventDefault();
      togglePin(b.dataset.fxId || b.dataset.fxRef);
    });

    // Remember which section was open; a search temporarily opens every section with a hit.
    let filtering = false;
    sections.forEach((det) => {
      det.addEventListener("toggle", () => {
        if (filtering || panel.classList.contains("is-searching")) return;
        if (det.open) writeFxPref(win, LS_FX_SECTION, det.dataset.fxSection);
        else if (!sections.some((d) => d.open)) writeFxPref(win, LS_FX_SECTION, "");
      });
    });
    const runFilter = () => {
      const q = foldAccents(S.fxSearch.value.trim());
      const searching = !!q;
      const wasSearching = panel.classList.contains("is-searching");
      filtering = true;
      if (searching && !wasSearching) sections.forEach((d) => (d.dataset.fxWasOpen = d.open ? "1" : ""));
      panel.classList.toggle("is-searching", searching);
      let hits = 0;
      actionBtns.forEach((b) => {
        const hit = !searching || foldAccents(b.dataset.fxLabel + " " + b.title + " " + b.dataset.fxId).includes(q);
        b.classList.toggle("is-filtered-out", !hit);
        if (hit) hits++;
      });
      groups.forEach((g) => (g.hidden = searching && !g.querySelector(".hq-companion-fx-debug-btn:not(.is-filtered-out)")));
      sections.forEach((d) => {
        if (searching) {
          const any = !!d.querySelector("[data-fx-id]:not(.is-filtered-out)");
          d.removeAttribute("name");
          d.hidden = !any;
          d.open = any;
        } else {
          d.hidden = false;
          d.open = d.dataset.fxWasOpen === "1";
          d.setAttribute("name", "hq-companion-fx");
        }
      });
      parts.empty.hidden = !searching || hits > 0;
      win.setTimeout(() => (filtering = false), 0);
    };
    S.fxSearch.addEventListener("input", runFilter);

    // Keyboard: Esc clears the search, then closes; arrows move between visible controls.
    const focusables = () =>
      Array.from(panel.querySelectorAll("button, summary, input, select")).filter((el) => !el.disabled && el.getClientRects().length);
    const step = (from, key) => {
      const list = focusables();
      const i = list.indexOf(from);
      if (key === "ArrowLeft" || key === "ArrowRight") return list[i + (key === "ArrowRight" ? 1 : -1)];
      const r = from.getBoundingClientRect();
      const down = key === "ArrowDown";
      const cx = r.left + r.width / 2;
      const rows = list.filter((el) => {
        const o = el.getBoundingClientRect();
        return down ? o.top >= r.bottom - 2 : o.bottom <= r.top + 2;
      });
      if (!rows.length) return null;
      const edge = down ? Math.min(...rows.map((el) => el.getBoundingClientRect().top)) : Math.max(...rows.map((el) => el.getBoundingClientRect().bottom));
      const row = rows.filter((el) => {
        const o = el.getBoundingClientRect();
        return Math.abs((down ? o.top : o.bottom) - edge) < 6;
      });
      return row.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return Math.abs(ra.left + ra.width / 2 - cx) - Math.abs(rb.left + rb.width / 2 - cx);
      })[0];
    };
    panel.addEventListener("keydown", (ev) => {
      const el = doc.activeElement;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (S.fxSearch.value) {
          S.fxSearch.value = "";
          runFilter();
          S.fxSearch.focus();
        } else closeFxDebugMenu(win, { focusToggle: true });
        return;
      }
      if (!/^Arrow(Up|Down|Left|Right)$/.test(ev.key)) return;
      if (el === S.fxSearch) {
        if (ev.key !== "ArrowDown") return;
      } else if (!el || !/^(BUTTON|SUMMARY)$/.test(el.tagName)) return;
      const next = el === S.fxSearch ? focusables().find((x) => x !== S.fxSearch && x.closest(".hq-companion-fx-debug-head") == null) : step(el, ev.key);
      if (!next) return;
      ev.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    });
    if (!win.__hqFxShortcut) {
      win.__hqFxShortcut = true;
      win.addEventListener("keydown", (ev) => {
        if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.code !== "KeyO") return;
        if (!S.fxDebugMenu || S.fxDebugMenu.hidden) return;
        toggleFxDebugMenu(win, ev);
      });
    }
  }

  function toggleNsfwMode(win) {
    if (!S.nsfwAllowed) {
      if (typeof win.hqToast === "function") {
        win.hqToast(nsfwBlockMessage(S.nsfwBlock || "network"), "err", 4200);
      }
      return;
    }
    const on = !readNsfw(win);
    try {
      win.localStorage.setItem(LS_NSFW, on ? "1" : "0");
    } catch (_) {}
    if (!on) {
      S.pendingAfterglow = true;
      applyMood(win, "afterglow");
    }
    syncNsfwUI();
    playNsfwTransition(win, on);
    closeFxDebugMenu(win);
    refresh(true);
    if (typeof win.hqToast === "function") win.hqToast(on ? "Mode adulte · admin" : "Mode adulte off");
  }

  function syncNsfwUI() {
    if (!S.el) return;
    S.nsfwOn = readNsfw(S.win) && S.nsfwAllowed;
    if (!S.nsfwOn && (S.bustPull || S.bustPullRaf)) cancelBustPullImmediately(S.win);
    S.el.classList.toggle("is-nsfw", S.nsfwOn);
    if (S.syncLayeredPortrait) S.syncLayeredPortrait();
    const showPill = S.sessionAdmin && adulteUiVisible(S.win);
    syncAdminSettingsVisibility(S.win);
    if (S.nsfwBtn) {
      S.nsfwBtn.hidden = true;
      S.nsfwBtn.classList.toggle("is-on", S.nsfwOn);
      S.nsfwBtn.setAttribute("aria-pressed", String(S.nsfwOn));
    }
    if (S.adultePill) {
      S.adultePill.hidden = !showPill;
      S.adultePill.classList.toggle("is-on", S.nsfwOn);
      S.adultePill.classList.remove("is-blocked");
      S.adultePill.disabled = false;
      S.adultePill.setAttribute("aria-pressed", String(S.nsfwOn));
      S.adultePill.title = S.nsfwAllowed
        ? S.nsfwOn
          ? "Mode adulte actif — clic pour désactiver"
          : "Activer le mode adulte Transferania"
        : "Mode adulte indisponible (config du pont)";
    }
    if (S.fxDebug) {
      S.fxDebug.classList.toggle("is-blocked", !!(S.sessionAdmin && S.nsfwAllowed && !S.nsfwOn));
    }
    if (S.fxDebugMenu) {
      S.fxDebugMenu.hidden = !(S.sessionAdmin && S.nsfwAllowed);
      if (S.fxDebugMenu.hidden) closeFxDebugMenu(S.win);
    }
    if (S.avToolbar) {
      S.avToolbar.hidden = !(showPill || (S.sessionAdmin && S.nsfwAllowed));
    }
    S.win.hqCompanionNsfwAllowed = S.nsfwAllowed;
    S.win.hqCompanionNsfwOn = () => S.nsfwAllowed && readNsfw(S.win);
    if (S.escalateBtn) {
      const show = S.nsfwAllowed && S.nsfwOn;
      S.escalateBtn.hidden = !show;
    }
    syncAdultPortrait();
    if (S.nsfwOn) {
      preloadAdultPortraits(S.win);
      preloadAdultLoops(S.win);
      startLive2DLoop(S.win);
      scheduleAdultIdleFx(S.win);
    } else {
      S.win.clearTimeout(S.adultFxIdleT);
      clearAdultLoopFx(S.win);
      clearAdultSessionBleed(S.win);
      stopTitPullElasticLoop();
      stopPullBreathBed();
      const st = ensureLive2DState();
      stopLive2DLoop(S.win);
      if (S.adultFxTimers) {
        Object.keys(S.adultFxTimers).forEach((k) => S.win.clearTimeout(S.adultFxTimers[k]));
        S.adultFxTimers = null;
      }
    }
  }

  function muteHours(win, h) {
    try {
      win.localStorage.setItem(LS_MUTE, String(Date.now() + h * 3600000));
    } catch (_) {}
    refresh();
  }

  async function fetchJson(win, url, body, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || (body ? 45000 : 12000);
    if (typeof win.api === "function") {
      try {
        return await win.api(
          url,
          body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs } : { timeoutMs }
        );
      } catch (err) {
        if (err && err.data == null && err.status != null) {
          err.data = { error: err.message, code: err.code || (err.status === 404 ? "not_found" : undefined) };
        }
        throw err;
      }
    }
    const res = await win.fetch(url, Object.assign({ credentials: "same-origin" }, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((data && data.error) || "Erreur " + res.status);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function portraitHref(base) {
    const href = String(base || "");
    if (!href) return href;
    return href + (href.indexOf("?") >= 0 ? "&" : "?") + "v=" + Date.now();
  }

  function portraitPathOnly(win, href) {
    const raw = String(href || "").split("?")[0].trim();
    if (!raw) return "";
    try {
      return new URL(raw, win.location.origin).pathname;
    } catch (_) {
      return raw.indexOf("/") === 0 ? raw : "/" + raw.replace(/^\.?\//, "");
    }
  }

  function setAdultPortraitSrc(win, path, moodKey) {
    if (!S.adultPortrait || !path) return;
    const want = portraitPathOnly(win, path);
    const have = portraitPathOnly(win, S.adultPortrait.currentSrc || S.adultPortrait.src || "");
    if (have === want) return;
    const href = path.split("?")[0];
    S.adultPortrait.src = portraitHref(href);
    if (moodKey) S.adultPortrait.dataset.mood = moodKey;
    if (S.largePortraitImg) S.largePortraitImg.src = S.adultPortrait.src;
  }

  function applyForgePortrait(win, href) {
    if (!S.adultPortrait || !href) return;
    const fullHref = portraitHref(href);
    S.adultPortrait.src = fullHref;
    if (S.largePortraitImg) S.largePortraitImg.src = fullHref;
    try {
      if (!href.includes("rhythm")) {
        win.localStorage.setItem(LS_LAST_PORTRAIT_HREF, href.split("?")[0]);
      }
      win.localStorage.setItem(LS_LAYERED_PORTRAIT, href.split("?")[0] === LAYERED_PORTRAIT ? "1" : "0");
    } catch (_) {}
    Object.keys(ADULT_PORTRAITS).forEach((k) => {
      if (ADULT_PORTRAITS[k] === href.split("?")[0]) S.adultPortrait.dataset.mood = k;
    });
  }

  function dismissForgeReveal(win) {
    if (S.forgeRevealT) {
      win.clearTimeout(S.forgeRevealT);
      S.forgeRevealT = 0;
    }
    if (S.forgeRevealKey) {
      win.removeEventListener("keydown", S.forgeRevealKey);
      S.forgeRevealKey = null;
    }
    const el = win.document.querySelector(".hq-companion-forge-reveal");
    if (el) el.remove();
  }

  function readForgeIntensity(win) {
    try {
      const v = parseInt(win.localStorage.getItem(LS_FORGE_INTENSITY), 10);
      if (v >= 0 && v <= 4) return v;
    } catch (_) {}
    return 1;
  }

  const FORGE_EXPLICIT_POSES = [
    "portrait-lewd",
    "chat-spicy",
    "booty-arch-mirror",
    "doggystyle-lookback",
    "cowgirl-straddle",
    "missionary-legs-up",
    "face-down-ass-up",
    "shower-wet",
    "desk-bent-over",
    "mirror-selfie-nude",
    "bondage-light",
    "reverse-cowgirl",
    "wall-pin-standing",
    "stomach-feet-up",
    "bath-bubbles",
    "chair-straddle-back",
    "lingerie-peel",
    "pole-dance-tease",
    "spoon-side-nude",
    "lap-straddle-grind",
    "split-stretch-tease",
    "against-glass",
    "kneeling-collar",
  ];

  const FORGE_HOT_POSES = [
    "portrait-lewd",
    "portrait-warm",
    "against-glass",
    "kneeling-collar",
    "chat-spicy",
    "shower-wet",
    "mirror-selfie-nude",
    "face-down-ass-up",
    "bath-bubbles",
    "lingerie-peel",
    "lap-straddle-grind",
    "wall-pin-standing",
  ];

  /** Extra Forge pose buttons: [label, poseId, menu title] */
  const FORGE_POSE_MENU_EXTRA = [
    ["Reverse", "reverse-cowgirl", "Forge · cowgirl inversée"],
    ["Wall", "wall-pin-standing", "Forge · contre le mur, jambe levée"],
    ["Tummy", "stomach-feet-up", "Forge · ventre, pieds en l'air"],
    ["Bath", "bath-bubbles", "Forge · bain moussant"],
    ["Chair", "chair-straddle-back", "Forge · à califourchon sur la chaise"],
    ["Peel", "lingerie-peel", "Forge · striptease"],
    ["Pole", "pole-dance-tease", "Forge · barre / pole"],
    ["Spoon", "spoon-side-nude", "Forge · cuillère, nu"],
    ["Lap", "lap-straddle-grind", "Forge · sur tes genoux"],
    ["Split", "split-stretch-tease", "Forge · grand écart / stretch"],
    ["Glass", "against-glass", "Forge · vitre, souffle"],
    ["Collar", "kneeling-collar", "Forge · collier, à genoux"],
  ];

  const FORGE_PORN_POSES = [
    "hc-bj-pov",
    "hc-deepthroat-pov",
    "hc-paizuri-pov",
    "hc-missionary-pov",
    "hc-doggy-pov",
    "hc-cowgirl-ride",
    "hc-creampie",
    "hc-spread-pussy",
    "hc-fingering",
    "hc-anal-doggy",
    "hc-facefuck",
    "hc-cum-covered",
    "rhythm-bob",
    "rhythm-lick",
    "rhythm-finish",
  ];

  const FORGE_PORN_MENU = [
    ["BJ", "hc-bj-pov", "XXX · fellation POV"],
    ["DT", "hc-deepthroat-pov", "XXX · gorge profonde"],
    ["Tits", "hc-paizuri-pov", "XXX · paizuri"],
    ["Fuck M", "hc-missionary-pov", "XXX · missionary POV"],
    ["Fuck D", "hc-doggy-pov", "XXX · doggy POV"],
    ["Ride", "hc-cowgirl-ride", "XXX · cowgirl"],
    ["Cream", "hc-creampie", "XXX · creampie"],
    ["Spread", "hc-spread-pussy", "XXX · écartée"],
    ["Solo", "hc-fingering", "XXX · doigté"],
    ["Anal", "hc-anal-doggy", "XXX · anal doggy"],
    ["Face", "hc-facefuck", "XXX · facefuck"],
    ["Cum", "hc-cum-covered", "XXX · facial / body"],
  ];

  const FORGE_EXTREME_POSES = [
    "hx-double-penetration",
    "hx-mating-press",
    "hx-prone-bone-rough",
    "hx-gangbang-surround",
    "hx-ahegao-intercourse",
    "hx-throatpie-overflow",
    "hx-leash-plug-crawl",
    "hx-breeding-overflow",
    "hx-69-pov",
    "hx-public-exhibition",
    "hx-suspended-spread",
    "hx-rough-anal-gape",
    "hx-fucked-silly",
  ];

  const FORGE_EXTREME_MENU = [
    ["DP", "hx-double-penetration", "XXL · double pénétration"],
    ["Press", "hx-mating-press", "XXL · mating press / breeding"],
    ["Prone", "hx-prone-bone-rough", "XXL · prone bone brutal"],
    ["GB", "hx-gangbang-surround", "XXL · gangbang / multi"],
    ["Ahegao", "hx-ahegao-intercourse", "XXL · ahegao en baise"],
    ["Throat", "hx-throatpie-overflow", "XXL · throatpie débord"],
    ["Pet", "hx-leash-plug-crawl", "XXL · petplay / plug"],
    ["Breed", "hx-breeding-overflow", "XXL · breeding overflow"],
    ["69", "hx-69-pov", "XXL · soixante-neuf POV"],
    ["Public", "hx-public-exhibition", "XXL · exhibition"],
    ["Hang", "hx-suspended-spread", "XXL · suspendue / spread"],
    ["Gape", "hx-rough-anal-gape", "XXL · anal gape"],
    ["Broken", "hx-fucked-silly", "XXL · fucked silly / after"],
  ];

  function readForgePorn(win) {
    try {
      return win.localStorage.getItem(LS_FORGE_PORN) === "1";
    } catch (_) {
      return false;
    }
  }

  function readForgeExtreme(win) {
    try {
      return win.localStorage.getItem(LS_FORGE_EXTREME) === "1";
    } catch (_) {
      return false;
    }
  }

  function readForgeHybrid(win) {
    try {
      const v = win.localStorage.getItem(LS_FORGE_HYBRID);
      if (v === "0") return false;
      if (v === "1") return true;
    } catch (_) {}
    if (S.forgeUiDefaults && S.forgeUiDefaults.hybrid_default != null) {
      return !!S.forgeUiDefaults.hybrid_default;
    }
    return true;
  }

  function readForgeStockChance(win) {
    try {
      const v = parseInt(win.localStorage.getItem(LS_FORGE_STOCK_CHANCE), 10);
      if (v >= 10 && v <= 90) return v;
    } catch (_) {}
    if (S.forgeUiDefaults && S.forgeUiDefaults.stock_chance != null) {
      return Math.round(Number(S.forgeUiDefaults.stock_chance) * 100);
    }
    return 50;
  }

  const CHAT_POSE_HINTS_JS = [
    [["suce", "pipe", "oral", "bouche", "gorge"], "hc-bj-pov"],
    [["anal", "cul", "doggy", "quatre pattes"], "hc-anal-doggy"],
    [["creampie", "rempli"], "hc-creampie"],
    [["spread", "écarte", "ecarte", "chatte"], "hc-spread-pussy"],
    [["cowgirl", "chevauche", "ride"], "hc-cowgirl-ride"],
    [["dp", "double pén"], "hx-double-penetration"],
    [["douche", "shower", "mouill"], "shower-wet"],
    [["selfie", "miroir"], "mirror-selfie-nude"],
  ];

  function inferForgePoseFromChat(win) {
    const blob = (getLastChatSnippet(win) + " " + (S.pendingEscalateMsg || "")).toLowerCase();
    if (!blob.trim()) return "";
    for (let i = 0; i < CHAT_POSE_HINTS_JS.length; i += 1) {
      const keys = CHAT_POSE_HINTS_JS[i][0];
      const pose = CHAT_POSE_HINTS_JS[i][1];
      if (keys.some((k) => blob.indexOf(k) >= 0)) return pose;
    }
    return "";
  }

  function readForgePoseLock(win) {
    try {
      return win.localStorage.getItem(LS_FORGE_POSE_LOCK) === "1";
    } catch (_) {
      return false;
    }
  }

  function rememberForgePoseLock(win, poseId) {
    if (!readForgePoseLock(win)) return;
    S.forgePoseLockId = poseId;
    try {
      win.localStorage.setItem("hq_companion_forge_pose_lock_id", poseId);
    } catch (_) {}
  }

  function readLockedForgePoseId(win) {
    if (!readForgePoseLock(win)) return "";
    try {
      return win.localStorage.getItem("hq_companion_forge_pose_lock_id") || S.forgePoseLockId || "";
    } catch (_) {
      return S.forgePoseLockId || "";
    }
  }

  function warmthForgeBoost(win) {
    const w = typeof S.warmth === "number" ? S.warmth : 0;
    if (w >= 72) return 4;
    if (w >= 52) return 3;
    if (w >= 34) return 2;
    if (w >= 18) return 1;
    return 0;
  }

  function effectiveForgeIntensity(win) {
    return Math.min(4, Math.max(readForgeIntensity(win), warmthForgeBoost(win)));
  }

  function pickForgePortraitPose(win) {
    const locked = readLockedForgePoseId(win);
    if (locked) return locked;
    const hinted = inferForgePoseFromChat(win);
    if (hinted && Math.random() < 0.45) return hinted;
    const eff = effectiveForgeIntensity(win);
    const w = typeof S.warmth === "number" ? S.warmth : 0;
    const porn = readForgePorn(win);
    const extreme = readForgeExtreme(win);
    if (porn && extreme && (eff >= 2 || w >= 50)) {
      return FORGE_EXTREME_POSES[Math.floor(Math.random() * FORGE_EXTREME_POSES.length)];
    }
    if (porn && (eff >= 2 || w >= 55)) {
      return FORGE_PORN_POSES[Math.floor(Math.random() * FORGE_PORN_POSES.length)];
    }
    if (eff >= 4 || w >= 70) {
      return FORGE_EXPLICIT_POSES[Math.floor(Math.random() * FORGE_EXPLICIT_POSES.length)];
    }
    if (eff >= 3 || w >= 50) {
      return FORGE_HOT_POSES[Math.floor(Math.random() * FORGE_HOT_POSES.length)];
    }
    if (eff >= 2 || w >= 36) {
      return Math.random() < 0.55 ? "portrait-warm" : "portrait-neutral";
    }
    return Math.random() < 0.4 ? "portrait-soft" : "portrait-neutral";
  }

  function syncWarmthToForgeIntensity(win) {
    if (!S.nsfwOn || !S.forgeIntensityRange) return;
    const eff = effectiveForgeIntensity(win);
    const cur = readForgeIntensity(win);
    if (eff <= cur) return;
    S.forgeIntensityRange.value = String(eff);
    try {
      win.localStorage.setItem(LS_FORGE_INTENSITY, String(eff));
    } catch (_) {}
  }

  function readForgeHot(win) {
    try {
      return win.localStorage.getItem(LS_FORGE_HOT) === "1";
    } catch (_) {
      return false;
    }
  }

  function readForgeSound(win) {
    try {
      const v = win.localStorage.getItem(LS_FORGE_SOUND);
      if (v === null) return true;
      return v === "1";
    } catch (_) {
      return true;
    }
  }

  function getLastChatSnippet(win) {
    const log = S.logEl;
    if (!log) return "";
    const user = log.querySelector(".hq-companion-msg.is-user:last-child .hq-companion-msg-text");
    return user ? String(user.textContent || "").trim().slice(0, 220) : "";
  }

  function currentPortraitBaseName() {
    const src = S.adultPortrait && S.adultPortrait.src ? S.adultPortrait.src.split("?")[0] : "";
    const name = src.split("/").pop();
    return name && /\.jpg$/i.test(name) ? name : "transferania-adult-neutral.jpg";
  }

  function buildForgePayload(win, pose, extra) {
    const hot = readForgeHot(win);
    const esc =
      (S.pendingEscalateMsg && String(S.pendingEscalateMsg).trim()) ||
      (S.escalateBtn && S.escalateBtn.classList.contains("is-armed") ? "plus direct et explicite" : "");
    const hinted = inferForgePoseFromChat(win);
    return Object.assign(
      {
        action: "generate",
        pose: pose,
        seed: -1,
        intensity: effectiveForgeIntensity(win),
        hot_variations: hot,
        variations: hot ? 3 : 1,
        treat_bonuses: (S.forgeTreatBonuses || []).slice(0, 6),
        chat_snippet: getLastChatSnippet(win),
        escalate: esc,
        hour: new Date().getHours(),
        hybrid: readForgeHybrid(win),
        stock_chance: readForgeStockChance(win) / 100,
        use_chat_pose: !!(hinted && hinted === pose),
      },
      extra || {}
    );
  }

  function playForgeSfx(win, kind) {
    if (!readForgeSound(win)) return;
    try {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const profiles = {
        reveal: [
          { f: 620, t: 0, d: 0.38, w: 0.055, type: "sine" },
          { f: 920, t: 0.07, d: 0.45, w: 0.038, type: "sine" },
        ],
        tick: [{ f: 400, t: 0, d: 0.14, w: 0.032, type: "triangle" }],
        rhythm: [
          { f: 74, t: 0, d: 0.2, w: 0.065, type: "triangle" },
          { f: 115, t: 0.04, d: 0.16, w: 0.045, type: "sine" },
          { f: 58, t: 0.12, d: 0.22, w: 0.055, type: "sine" },
          { f: 145, t: 0.3, d: 0.15, w: 0.035, type: "triangle" },
          { f: 88, t: 0.42, d: 0.24, w: 0.06, type: "sine" },
        ],
        release: [
          { f: 280, t: 0, d: 0.5, w: 0.05, type: "triangle" },
          { f: 440, t: 0.1, d: 0.55, w: 0.042, type: "triangle" },
          { f: 660, t: 0.22, d: 0.7, w: 0.03, type: "sine" },
        ],
      };
      const seq = profiles[kind] || profiles.tick;
      const reactionTone = beginCompanionReactionBus(ctx, ctx.currentTime);
      seq.forEach((p) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = p.type || "sine";
        o.frequency.value = p.f;
        g.gain.value = 0.0001;
        o.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        const start = ctx.currentTime + p.t;
        o.start(start);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(Math.max(p.w, 0.0002), start + 0.022);
        g.gain.exponentialRampToValueAtTime(0.0001, start + p.d);
        o.stop(start + p.d + 0.04);
      });
      const closeMs = (Math.max(...seq.map((p) => p.t + p.d)) + 0.45) * 1000;
      win.setTimeout(() => ctx.close().catch(() => {}), closeMs);
    } catch (_) {}
  }

  function playForgeRevealEvent(win, out) {
    playForgeSfx(win, out && (out.mode === "stock" || out.stock) ? "tick" : "reveal");
    if (S.el) {
      S.el.classList.add("is-forge-reveal-pulse");
      win.setTimeout(() => S.el && S.el.classList.remove("is-forge-reveal-pulse"), 1400);
    }
    const whisper = (out && out.whisper) || "";
    if (whisper && typeof win.hqToast === "function") win.hqToast(whisper, "tip", 4200);
    else if (whisper && S.line && !S.collapsed) setLineAnimated(win, whisper);
  }

  function playAdultForgePreview(win, pose) {
    if (!adultFxAllowed(win)) return;
    if (pose === "rhythm-bob") {
      playAdultRhythm(win);
      return;
    }
    if (pose === "rhythm-lick") {
      if (S.adultShaft) S.adultShaft.hidden = false;
      if (S.adultShaftTrack) S.adultShaftTrack.hidden = false;
      if (S.el) S.el.classList.add("is-nsfw-fx-rhythm", "is-nsfw-rhythm-lick");
      playForgeSfx(win, "rhythm");
      playAdultFx(win, "rhythm", 3600);
      win.setTimeout(() => {
        if (S.el) S.el.classList.remove("is-nsfw-rhythm-lick", "is-nsfw-fx-rhythm");
        if (S.adultShaft) S.adultShaft.hidden = true;
      if (S.adultShaftTrack) S.adultShaftTrack.hidden = true;
        endAdultFx(win, "rhythm");
      }, 3700);
      return;
    }
    if (pose === "rhythm-finish") {
      playForgeSfx(win, "release");
      playAdultFx(win, "flash", 1100);
      return;
    }
    if (typeof pose === "string" && (pose.startsWith("hc-") || pose.startsWith("hx-") || FORGE_PORN_POSES.indexOf(pose) >= 0)) {
      playForgeSfx(win, pose.startsWith("hx-") ? "release" : "rhythm");
      playAdultFx(win, "flash", 1100);
      return;
    }
    playAdultFx(win, "flash", 900);
  }

  async function saveForgeFavorite(win, recipe) {
    return fetchJson(win, "/api/companion/art", { action: "save_favorite", recipe: recipe }, { timeoutMs: 15000 });
  }

  function normalizeForgeVariants(out) {
    if (!out) return [];
    const topMode = out.mode;
    if (out.variants && out.variants.length) {
      return out.variants.map((v) =>
        Object.assign({}, v, { mode: v.mode || topMode })
      );
    }
    if (out.set && out.set.length) {
      return out.set.map((r) => ({
        href: r.href,
        seed: r.seed,
        prompt_tags: r.prompt_tags || {},
        pose: r.pose,
        mode: r.mode || topMode,
      }));
    }
    if (out.href) {
      return [{ href: out.href, seed: out.seed, prompt_tags: out.prompt_tags || {}, mode: topMode }];
    }
    return [];
  }

  function applyForgeRevealVariant(win, variant) {
    if (!variant || !variant.href) return;
    applyForgePortrait(win, variant.href);
    playForgeSfx(win, "tick");
  }

  function showForgeReveal(win, href, meta) {
    const variants = (meta && meta.variants) || [{ href: href, seed: meta && meta.seed, prompt_tags: (meta && meta.prompt_tags) || {} }];
    showForgeRevealCarousel(win, variants, meta || {});
  }

  function showForgeRevealCarousel(win, variants, meta) {
    dismissForgeReveal(win);
    const list = (variants || []).filter((v) => v && v.href);
    if (!list.length) return;
    S.forgeRevealVariants = list;
    S.forgeRevealIndex = 0;
    const doc = win.document;
    const pose = (meta && meta.pose) || "";
    const whisper = (meta && meta.whisper) || "";
    const overlay = doc.createElement("div");
    overlay.className = "hq-companion-forge-reveal is-carousel";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Portrait Forge généré");
    const revealMs = list.length > 1 ? FORGE_REVEAL_MS + 4000 : FORGE_REVEAL_MS;
    overlay.style.setProperty("--forge-reveal-ms", revealMs + "ms");
    const backdrop = doc.createElement("button");
    backdrop.type = "button";
    backdrop.className = "hq-companion-forge-reveal-backdrop";
    backdrop.setAttribute("aria-label", "Fermer");
    backdrop.addEventListener("click", () => dismissForgeReveal(win));
    const stage = doc.createElement("div");
    stage.className = "hq-companion-forge-reveal-stage";
    const orbit = doc.createElement("div");
    orbit.className = "hq-companion-forge-reveal-orbit";
    orbit.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 6; i += 1) {
      const light = doc.createElement("span");
      light.className = "hq-companion-forge-reveal-light";
      light.style.setProperty("--orbit-i", String(i));
      orbit.appendChild(light);
    }
    const card = doc.createElement("div");
    card.className = "hq-companion-forge-reveal-card";
    const img = doc.createElement("img");
    img.className = "hq-companion-forge-reveal-img";
    img.alt = "Portrait Transferania généré";
    img.decoding = "async";
    const whisperEl = doc.createElement("p");
    whisperEl.className = "hq-companion-forge-reveal-whisper";
    whisperEl.textContent = whisper;
    const cap = doc.createElement("p");
    cap.className = "hq-companion-forge-reveal-cap";
    const badge = doc.createElement("span");
    badge.className = "hq-companion-forge-reveal-badge";
    badge.setAttribute("aria-hidden", "true");
    const dots = doc.createElement("div");
    dots.className = "hq-companion-forge-reveal-dots";
    const nav = doc.createElement("div");
    nav.className = "hq-companion-forge-reveal-nav";
    const prev = doc.createElement("button");
    prev.type = "button";
    prev.className = "hq-companion-forge-reveal-nav-btn";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "Variante précédente");
    const next = doc.createElement("button");
    next.type = "button";
    next.className = "hq-companion-forge-reveal-nav-btn";
    next.textContent = "›";
    next.setAttribute("aria-label", "Variante suivante");
    nav.append(prev, next);
    const actions = doc.createElement("div");
    actions.className = "hq-companion-forge-reveal-actions";
    const useBtn = doc.createElement("button");
    useBtn.type = "button";
    useBtn.className = "hq-companion-forge-reveal-use";
    useBtn.textContent = "Portrait actif";
    const favBtn = doc.createElement("button");
    favBtn.type = "button";
    favBtn.className = "hq-companion-forge-reveal-fav";
    favBtn.textContent = "Garder ce look";
    const dl = doc.createElement("a");
    dl.className = "hq-companion-forge-reveal-dl";
    dl.textContent = "Télécharger";
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "hq-companion-forge-reveal-close";
    close.textContent = "Fermer";
    close.addEventListener("click", () => dismissForgeReveal(win));
    const timer = doc.createElement("div");
    timer.className = "hq-companion-forge-reveal-timer";
    timer.setAttribute("aria-hidden", "true");
    const timerBar = doc.createElement("span");
    timerBar.className = "hq-companion-forge-reveal-timer-bar";
    timer.appendChild(timerBar);

    function renderIndex(idx) {
      const v = list[Math.max(0, Math.min(list.length - 1, idx))];
      S.forgeRevealIndex = idx;
      const src = portraitHref(v.href);
      img.src = src;
      dl.href = src;
      dl.download = String(v.href).split("/").pop() || "transferania-forge.jpg";
      const seed = v.seed != null ? String(v.seed) : "";
      const tags = v.prompt_tags && typeof v.prompt_tags === "object" ? v.prompt_tags : {};
      const tagLine = Object.keys(tags)
        .slice(0, 3)
        .map((k) => tags[k])
        .join(" · ");
      cap.textContent =
        (list.length > 1 ? idx + 1 + "/" + list.length + " · " : "") +
        (pose ? pose + " · " : "") +
        (seed ? "seed " + seed : "") +
        (tagLine ? " · " + tagLine : "");
      badge.textContent = v.mode === "stock" ? "Archive" : "Fresh Forge";
      badge.classList.toggle("is-stock", v.mode === "stock");
      dots.replaceChildren();
      for (let i = 0; i < list.length; i += 1) {
        const d = doc.createElement("span");
        d.className = "hq-companion-forge-reveal-dot" + (i === idx ? " is-on" : "");
        dots.appendChild(d);
      }
      prev.disabled = list.length < 2;
      next.disabled = list.length < 2;
    }

    prev.addEventListener("click", () => renderIndex((S.forgeRevealIndex - 1 + list.length) % list.length));
    next.addEventListener("click", () => renderIndex((S.forgeRevealIndex + 1) % list.length));
    useBtn.addEventListener("click", () => {
      applyForgeRevealVariant(win, list[S.forgeRevealIndex]);
      if (typeof win.hqToast === "function") win.hqToast("Portrait appliqué", "tip", 1800);
    });
    favBtn.addEventListener("click", () => {
      const v = list[S.forgeRevealIndex];
      saveForgeFavorite(win, { pose: pose, seed: v.seed, prompt_tags: v.prompt_tags || {}, href: v.href })
        .then(() => {
          if (typeof win.hqToast === "function") win.hqToast("Look favori enregistré ♥", "tip", 2600);
        })
        .catch(() => {
          if (typeof win.hqToast === "function") win.hqToast("Impossible d'enregistrer le favori", "err", 3200);
        });
    });

    actions.append(useBtn, favBtn, dl, close);
    card.append(badge, img, whisperEl, cap, dots, nav, actions, timer);
    stage.append(orbit, card);
    overlay.append(backdrop, stage);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) dismissForgeReveal(win);
    });
    stage.addEventListener("click", (ev) => ev.stopPropagation());
    doc.body.appendChild(overlay);
    renderIndex(0);
    applyForgePortrait(win, list[0].href);
    S.forgeRevealKey = (ev) => {
      if (ev.key === "Escape") dismissForgeReveal(win);
      if (ev.key === "ArrowLeft") prev.click();
      if (ev.key === "ArrowRight") next.click();
    };
    win.addEventListener("keydown", S.forgeRevealKey);
    S.forgeRevealT = win.setTimeout(() => dismissForgeReveal(win), revealMs);
  }

  async function forgeCompanionPose(win, pose, extra) {
    let slowT = 0;
    if (typeof win.hqToast === "function") {
      slowT = win.setTimeout(() => {
        win.hqToast("Forge travaille encore… (~30–90 s selon la pose)", "tip", 9000);
      }, 32000);
    }
    try {
      return await fetchJson(win, "/api/companion/art", buildForgePayload(win, pose, extra), { timeoutMs: 180000 });
    } finally {
      if (slowT) win.clearTimeout(slowT);
    }
  }

  async function forgeCompanionSet(win, poses, extra) {
    const payload = Object.assign(buildForgePayload(win, "portrait-neutral", extra), {
      action: "generate_set",
      poses: poses,
      set_batch: true,
    });
    delete payload.pose;
    return fetchJson(win, "/api/companion/art", payload, { timeoutMs: 600000 });
  }

  function forgeDebugBlockedToast(win) {
    if (!S.sessionAdmin) return "Réservé à l'administrateur.";
    if (!S.nsfwAllowed) return "Mode adulte désactivé sur le pont.";
    if (!S.nsfwOn) return "Active le mode Adulte (bouton à côté de l'avatar).";
    return "";
  }

  function forgeApiError(err, fallback) {
    const msg = (err && err.message) || fallback || "Forge erreur";
    if (msg === "Inconnu" || (err && err.status === 404)) {
      return "API /api/companion/art absente — redémarre le pont HQ (iphone_bridge.py), puis Ctrl+F5.";
    }
    const code = err && err.data && err.data.code;
    if (code === "busy") {
      return "Forge est déjà en train de générer — attends la fin du job en cours.";
    }
    return code ? msg + " · " + code : msg;
  }

  function appendForgeMenuSection(doc, parent, title, nodes, open) {
    const det = doc.createElement("details");
    det.className = "hq-companion-fx-debug-section";
    det.dataset.fxSection = title;
    // Shared name = exclusive accordion: opening one section folds the others.
    det.setAttribute("name", "hq-companion-fx");
    if (open) det.open = true;
    const sum = doc.createElement("summary");
    sum.textContent = title;
    const body = doc.createElement("div");
    body.className = "hq-companion-fx-debug-grid";
    nodes.forEach((n) => body.appendChild(n));
    det.append(sum, body);
    parent.appendChild(det);
    return det;
  }

  function createForgePoseButton(win, label, poseId, title) {
    const btn = win.document.createElement("button");
    btn.type = "button";
    btn.className = "hq-companion-fx-debug-btn";
    btn.textContent = label;
    btn.dataset.fxId = poseId;
    btn.setAttribute("role", "menuitem");
    btn.title = title + " · Shift+clic = Forge forcé (ignore Mix)";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const extra = ev.shiftKey ? { force_forge: true } : {};
      if (readForgePoseLock(win)) rememberForgePoseLock(win, poseId);
      runForgeDebug(win, poseId, btn, extra);
    });
    return btn;
  }

  async function runForgeDebug(win, pose, btn, extra) {
    const block = forgeDebugBlockedToast(win);
    if (block) {
      if (btn) btn.title = block;
      if (typeof win.hqToast === "function") win.hqToast(block, "tip", 2800);
      return;
    }
    const label = (btn && btn.dataset.fxLabel) || (btn && btn.textContent) || pose;
    await withForgeJob(win, btn, label, async (job) => {
      try {
        const out = await forgeCompanionPose(win, pose, extra);
        if (job.cancelled) return;
        const variants = normalizeForgeVariants(out);
        if (variants.length) {
          applyForgePortrait(win, variants[0].href);
          playForgeRevealEvent(win, out);
          showForgeRevealCarousel(win, variants, {
            pose: pose,
            seed: out.seed,
            prompt_tags: out.prompt_tags,
            whisper: out.whisper,
            variants: variants,
          });
          playAdultForgePreview(win, pose);
        }
        S.forgeTreatBonuses = [];
        if (btn) btn.title = "OK · seed " + (out && out.seed != null ? out.seed : "?");
      } catch (err) {
        if (job.cancelled) return;
        const msg = forgeApiError(err, "Forge erreur");
        if (btn) btn.title = msg;
        if (typeof win.hqToast === "function") win.hqToast(msg, "err", 5500);
      }
    });
  }

  async function runForgeImg2Refresh(win, btn) {
    const block = forgeDebugBlockedToast(win);
    if (block) {
      if (typeof win.hqToast === "function") win.hqToast(block, "tip", 2800);
      return;
    }
    await withForgeJob(win, btn, "Mood", async (job) => {
      try {
        const out = await forgeCompanionPose(win, "portrait-neutral", {
          img2img_refresh: true,
          mood_refresh: true,
          img2img_source: currentPortraitBaseName(),
          dest: currentPortraitBaseName(),
        });
        if (job.cancelled) return;
        const variants = normalizeForgeVariants(out);
        if (variants.length) {
          applyForgePortrait(win, variants[0].href);
          playForgeRevealEvent(win, out);
          showForgeRevealCarousel(win, variants, { pose: "refresh img2img", whisper: out.whisper, variants: variants });
        }
      } catch (err) {
        if (job.cancelled) return;
        if (typeof win.hqToast === "function") win.hqToast(forgeApiError(err, "Refresh"), "err", 5000);
      }
    });
  }

  async function runForgeFavoriteReplay(win, btn) {
    const block = forgeDebugBlockedToast(win);
    if (block) return;
    await withForgeJob(win, btn, "Favori", async (job) => {
      try {
        const out = await forgeCompanionPose(win, "portrait-neutral", { use_favorite: true });
        if (job.cancelled) return;
        const variants = normalizeForgeVariants(out);
        if (variants.length) {
          applyForgePortrait(win, variants[0].href);
          playForgeRevealEvent(win, out);
          showForgeRevealCarousel(win, variants, { pose: "favori", whisper: out.whisper, variants: variants });
        }
      } catch (err) {
        if (job.cancelled) return;
        if (typeof win.hqToast === "function") win.hqToast(forgeApiError(err, "Favori"), "err", 5000);
      }
    });
  }

  function pronunciationLanguage(win) {
    try { const lang = win.localStorage.getItem("hq_companion_pronunciation_language"); return ["fr", "en"].includes(lang) ? lang : "auto"; }
    catch (_) { return "auto"; }
  }

  function cachePronunciation(out) {
    const plan = out?.pronunciation;
    if (!plan || typeof plan.text !== "string" || !Array.isArray(plan.words) || plan.words.length > 1000) return;
    if (!S.pronunciationPlans) S.pronunciationPlans = new Map();
    S.pronunciationPlans.delete(plan.text.trim());
    S.pronunciationPlans.set(plan.text.trim(), plan.words);
    while (S.pronunciationPlans.size > 24) S.pronunciationPlans.delete(S.pronunciationPlans.keys().next().value);
  }

  async function callTransferania(win, payload) {
    const out = await fetchJson(win, "/api/ai", withDevice(win, Object.assign({ action: "transferania", pronunciation_language: pronunciationLanguage(win) }, payload)));
    cachePronunciation(out);
    return out;
  }

  async function callAmbient(win, view, dig, persona, signals) {
    const payload = withDevice(win, {
      action: "ambient", view, digest: dig, persona,
      pronunciation_language: pronunciationLanguage(win),
      nsfw: S.nsfwAllowed && readNsfw(win),
      signals: signals || collectSignals(win),
      event_id: S.pendingEvent ? S.pendingEvent.id : undefined,
    });
    let out = await fetchJson(win, "/api/ai", payload);
    if (out && out.reason === "coalescing" && Number(out.retry_after) > 0) {
      await new Promise((resolve) => win.setTimeout(resolve, Math.min(8, Number(out.retry_after)) * 1000 + 50));
      if (!win.document.hidden && S.el && !S.el.hidden) out = await fetchJson(win, "/api/ai", payload);
    }
    cachePronunciation(out);
    return out;
  }

  function collectSignals(win) {
    const tInfo = getSessionTensionInfo(win);
    const sig = {
      hour: new Date().getHours(),
      celebrate: S.pendingCelebrateMsg || "",
      error: S.pendingErrorMsg || "",
      afterglow: !!S.pendingAfterglow,
      escalate: S.pendingEscalateMsg || "",
      tension_level: tInfo.level,
      tension_label: tInfo.label,
      warmth: tInfo.warmth,
      fav_acts: tInfo.topFavs || "",
      interactions: Array.isArray(S.recentInteractions) ? S.recentInteractions.slice(-4) : [],
      user_looking: !!S.userLookingAtCompanion,
      attention: typeof S.attentionScore === "number" ? Math.round(S.attentionScore * 100) / 100 : 0,
    };
    S.pendingCelebrate = false;
    S.pendingCelebrateMsg = "";
    S.pendingError = false;
    S.pendingErrorMsg = "";
    S.pendingAfterglow = false;
    S.pendingEscalateMsg = "";
    return sig;
  }

  function applyPrefsForm(win) {
    const doc = win.document;
    const nick = doc.getElementById("hq-companion-nickname");
    const addr = doc.getElementById("hq-companion-address");
    const addrC = doc.getElementById("hq-companion-address-custom");
    const qc = doc.getElementById("hq-companion-qc");
    const inten = doc.getElementById("hq-companion-intensity");
    const intenV = doc.getElementById("hq-companion-intensity-val");
    const topics = doc.getElementById("hq-companion-topics-off");
    const cel = doc.getElementById("hq-companion-celebrate");
    const p = S.prefs || DEFAULT_PREFS;
    if (nick) nick.value = p.nickname || "";
    if (qc) qc.value = p.qc_dial === "medium" || p.qc_dial === "off" ? p.qc_dial : "light";
    if (inten) inten.value = String(p.intensity || 2);
    if (intenV) intenV.textContent = String(p.intensity || 2);
    if (topics) topics.value = (p.topics_off || []).join("\n");
    if (cel) cel.checked = p.celebrate !== false;
    const a = p.address || "tu";
    if (addr) {
      if (a === "tu" || a === "vous") {
        addr.value = a;
        if (addrC) {
          addrC.hidden = true;
          addrC.value = "";
        }
      } else {
        addr.value = "custom";
        if (addrC) {
          addrC.hidden = false;
          addrC.value = a;
        }
      }
    }
  }

  function readPrefsForm(win) {
    const doc = win.document;
    const nick = (doc.getElementById("hq-companion-nickname")?.value || "").trim().slice(0, 40);
    const addrSel = doc.getElementById("hq-companion-address");
    const addrC = doc.getElementById("hq-companion-address-custom");
    let address = "tu";
    if (addrSel && addrSel.value === "vous") address = "vous";
    else if (addrSel && addrSel.value === "custom" && addrC) address = (addrC.value || "").trim().slice(0, 30) || "tu";
    const qc = doc.getElementById("hq-companion-qc")?.value || "light";
    const intensity = Number(doc.getElementById("hq-companion-intensity")?.value || 2);
    const topicsRaw = doc.getElementById("hq-companion-topics-off")?.value || "";
    const topics_off = topicsRaw
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean)
      .slice(0, 5);
    const celebrate = doc.getElementById("hq-companion-celebrate")?.checked !== false;
    return { nickname: nick, address, qc_dial: qc, intensity: Math.min(3, Math.max(1, intensity || 2)), topics_off, celebrate };
  }

  function scheduleSavePrefs(win) {
    win.clearTimeout(S.prefsSaveT);
    S.prefsSaveT = win.setTimeout(() => {
      const prefs = readPrefsForm(win);
      S.prefs = prefs;
      callTransferania(win, { op: "prefs", save: true, prefs }).catch(() => {});
    }, 450);
  }

  async function syncPrefsFromServer(win) {
    try {
      const st = await fetchJson(win, aiGetUrl(win));
      applyNsfwStatus(st);
      syncNsfwUI();
      if (st && st.personality) S.prefs = Object.assign({}, DEFAULT_PREFS, st.personality);
      applyPrefsForm(win);
    } catch (_) {}
  }

  function watchToasts(win) {
    const box = win.document.getElementById("toasts");
    if (!box || box.__hqCompanionToast) return;
    box.__hqCompanionToast = true;
    new win.MutationObserver(() => {
      const t = box.lastElementChild;
      if (!t || t.__hqCompanionSeen) return;
      t.__hqCompanionSeen = true;
      const sig = toastCompanionSignal(win, t);
      const msg = String(t.textContent || "").trim().slice(0, 120);
      if (sig === "error") {
        S.pendingError = true;
        S.pendingErrorMsg = msg;
        applyMood(win, "error");
      } else if (sig === "celebrate" && S.prefs.celebrate !== false) {
        S.pendingCelebrate = true;
        S.pendingCelebrateMsg = msg;
        celebrateAtAvatar(win);
      }
      if (!readOn(win) || readPersona(win) === "off" || muted(win)) return;
      if (sig === "none") return;
      win.clearTimeout(S.celebrateT);
      S.celebrateT = win.setTimeout(() => refresh(false, "signal"), 1200);
    }).observe(box, { childList: true });
  }

  function setLine(text) {
    S.lineFullText = String(text || "").trim();
    if (S.line) {
      S.mouthRig?.endTextSpeech(S.line.__hqPace);
      S.line.__hqPace = null;
      S.line.textContent = String(text || "").trim();
    }
    syncAmbientLineDup();
  }

  function syncMemChip() {
    if (!S.memChip) return;
    const n = chatMessagesOnly(S.messages).length;
    let label = n ? n + " msg" : "Mémoire vide";
    if (S.hasSummary) label += " · résumé";
    S.memChip.textContent = label;
    S.memChip.title = "Conversation de cet appareil · souvenirs partagés disponibles dans Mémoire.";
  }

  function followChatTail() {
    if (!S.logEl) return;
    if (S.logFollow !== false) S.logEl.scrollTop = S.logEl.scrollHeight;
    else if (S.newMessageBtn) S.newMessageBtn.hidden = false;
  }

  function syncLinePreview() {
    if (!S.readMoreBtn || !S.line) return;
    S.readMoreBtn.hidden = !!S.expanded || S.line.hidden || S.line.scrollHeight <= S.line.clientHeight + 2;
  }

  function renderLog() {
    if (!S.logEl) return;
    const doc = S.win.document;
    const previousTop = S.logEl.scrollTop;
    const previousCount = S.logEl.childElementCount;
    const follow = S.logFollow !== false;
    S.logEl.replaceChildren();
    const visible = chatMessagesOnly(S.messages).slice();
    // A page remark opened via Lire la suite also deserves a complete reading view.
    if (S.readPreview && !visible.some(m => String(m.text || "").trim() === S.readPreview))
      visible.push({role: "assistant", text: S.readPreview, kind: "ambient"});
    if (!visible.length && !S.hasSummary) {
      const empty = doc.createElement("p");
      empty.className = "hq-companion-log-empty";
      empty.textContent = "Écris-moi — tes souvenirs sont partagés entre tes appareils.";
      S.logEl.appendChild(empty);
      return;
    }
    if (S.hasSummary) {
      const sum = doc.createElement("p");
      sum.className = "hq-companion-log-summary";
      sum.textContent = "Mémoire compressée active (échanges plus anciens résumés).";
      S.logEl.appendChild(sum);
    }
    visible.forEach((m, idx) => {
      const row = doc.createElement("div");
      const isUser = m.role === "user";
      row.className = "hq-companion-msg " + (isUser ? "is-user" : "is-her");
      if (m.kind === "ambient") row.classList.add("is-ambient");
      if (idx >= (S.logAnimFrom || 0) && !calm(S.win)) {
        row.classList.add("is-in");
        if (!isUser) row.classList.add("is-ink-in");
        row.style.setProperty("--i", String(idx - (S.logAnimFrom || 0)));
      }
      const who = doc.createElement("span");
      who.className = "hq-companion-msg-who";
      who.textContent = isUser ? "Toi" : COMPANION_NAME;
      const txt = doc.createElement("p");
      txt.className = "hq-companion-msg-text";
      txt.textContent = String(m.text || "");
      row.append(who, txt);
      if (m.photo_href) {
        const pic = doc.createElement("img");
        pic.className = "hq-companion-msg-photo";
        pic.src = String(m.photo_href);
        pic.alt = "";
        pic.loading = "lazy";
        pic.decoding = "async";
        row.appendChild(pic);
      }
      S.logEl.appendChild(row);
    });
    if (S.readTarget) {
      const target = Array.from(S.logEl.querySelectorAll(".hq-companion-msg-text"))
        .find(el => el.textContent.trim() === S.readTarget);
      if (target) {
        S.logEl.scrollTop = target.parentElement.offsetTop - S.logEl.offsetTop;
        target.tabIndex = -1;
        target.focus({preventScroll: true});
      }
      S.readTarget = null;
    } else if (follow) followChatTail();
    else {
      S.logEl.scrollTop = previousTop;
      if (S.newMessageBtn && S.logEl.childElementCount > previousCount) S.newMessageBtn.hidden = false;
    }
    S.logAnimFrom = visible.length;
    syncMemChip();
    syncAmbientLineDup();
  }

  async function loadHistory() {
    const win = S.win;
    if (!win || S.blocked) return;
    try {
      const out = await fetchJson(win, aiGetUrl(win, "transferania=1"));
      S.messages = Array.isArray(out.messages) ? out.messages : [];
      S.hasSummary = !!out.has_summary;
      if (S.hasSummary && !S.hadSummary) pulseMemChip();
      S.hadSummary = S.hasSummary;
      if (out.prefs) S.prefs = Object.assign({}, DEFAULT_PREFS, out.prefs);
      renderLog();
    } catch (_) {}
  }

  function setExpanded(on) {
    S.expanded = !!on;
    if (S.el) S.el.classList.toggle("is-expanded", S.expanded);
    if (!S.expanded && S.memoryPanel) {
      S.memoryPanel.hidden = true;
      if (S.el) S.el.classList.remove("is-memory-open");
      if (S.memoryBtn) S.memoryBtn.setAttribute("aria-expanded", "false");
    }
    if (S.expanded) {
      setCollapsed(false, true);
      loadHistory();
      if (!S.readTarget) winFocusInput();
      if (S.nsfwOn) startLive2DLoop(S.win);
    } else if (isCompactUI(S.win)) {
      setCollapsed(true, true);
    }
    syncVisibility();
  }

  function winFocusInput() {
    if (S.inputEl && S.expanded) {
      try {
        S.inputEl.focus({ preventScroll: true });
      } catch (_) {
        S.inputEl.focus();
      }
    }
  }

  async function showSharedMemory(payload) {
    const win = S.win, panel = S.memoryPanel;
    if (!win || !panel || S.memoryBusy) return;
    S.memoryBusy = true;
    panel.setAttribute("aria-busy", "true");
    const doc = win.document;
    const request = S.memoryRequest = (S.memoryRequest || 0) + 1;
    const errorLine = (error) => {
      const line = doc.createElement("p");
      line.setAttribute("role", "alert");
      line.textContent = (error && error.message) || "Mémoire indisponible";
      panel.appendChild(line);
    };
    try {
      const data = await callTransferania(win, payload || { op: "memory" });
      if (request !== S.memoryRequest) return;
      panel.replaceChildren();
      const title = doc.createElement("strong");
      title.textContent = "Souvenirs partagés · PC et iPhone";
      const note = doc.createElement("p");
      note.textContent = "Corrige ce que je retiens. Retirer un souvenir conserve le texte des conversations.";
      panel.append(title, note);
      const memories = Array.isArray(data.memories) ? data.memories : [];
      if (!memories.length) {
        const empty = doc.createElement("p");
        empty.textContent = "Aucun souvenir enregistré.";
        panel.appendChild(empty);
      }
      for (const memory of memories) {
        const row = doc.createElement("div");
        row.className = "hq-companion-memory-row";
        const text = doc.createElement("p");
        text.textContent = (memory.evidence === "legacy_unverified" ? "À préciser · " : memory.kind === "state" ? "Temporaire · " : "") + memory.text;
        const edit = doc.createElement("button");
        edit.type = "button";
        edit.textContent = "Corriger";
        edit.addEventListener("click", () => {
          const input = doc.createElement("textarea");
          input.value = memory.text;
          input.maxLength = 500;
          input.setAttribute("aria-label", "Correction du souvenir");
          const save = doc.createElement("button");
          save.type = "button";
          save.textContent = "Enregistrer le souvenir";
          save.addEventListener("click", () => showSharedMemory({ op: "memory_correct", id: memory.id, text: input.value }));
          row.replaceChildren(input, save);
          input.focus();
        });
        const forget = doc.createElement("button");
        forget.type = "button";
        forget.textContent = "Retirer";
        forget.addEventListener("click", () => showSharedMemory({ op: "memory_forget", id: memory.id }));
        row.append(text, edit, forget);
        panel.appendChild(row);
      }
      const episodes = new Map((data.episodes || []).map((episode) => [episode.id, episode]));
      const shownSources = new Set();
      const appendEpisode = (host, episode) => {
        const row = doc.createElement("div");
        row.className = "hq-companion-memory-row";
        const text = doc.createElement("p");
        text.textContent = new Date(episode.at * 1000).toLocaleDateString() + " · " + episode.text;
        row.appendChild(text);
        if (["experience", "interest", "meaning", "ritual", "decision"].includes(episode.kind)) {
          const edit = doc.createElement("button");
          edit.type = "button";
          edit.textContent = "Corriger ce moment";
          edit.addEventListener("click", () => {
            const input = doc.createElement("textarea");
            input.value = episode.text;
            input.maxLength = 500;
            input.setAttribute("aria-label", "Correction du moment source");
            const help = doc.createElement("small");
            help.textContent = "Une phrase complète : expérience et résultat, intérêt, raison ou rituel partagé.";
            const save = doc.createElement("button");
            save.type = "button";
            save.textContent = "Enregistrer la correction";
            save.addEventListener("click", () => showSharedMemory({ op: "episode_correct", id: episode.id, text: input.value, revision: data.revision }));
            const cancel = doc.createElement("button");
            cancel.type = "button";
            cancel.textContent = "Annuler";
            cancel.addEventListener("click", () => {
              const replacement = doc.createDocumentFragment();
              appendEpisode(replacement, episode);
              row.replaceWith(replacement);
            });
            row.replaceChildren(input, help, save, cancel);
            input.focus();
          });
          row.appendChild(edit);
        }
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.textContent = "Retirer ce moment";
        remove.addEventListener("click", () => showSharedMemory({ op: "memory_forget", id: episode.id }));
        row.appendChild(remove);
        host.appendChild(row);
      };
      const journalTitle = doc.createElement("h3");
      journalTitle.textContent = "Journal de caractère";
      const journalNote = doc.createElement("p");
      journalNote.textContent = "Ce qui se développe chez moi, et pourquoi. Corriger ou retirer une source recalcule ces repères.";
      panel.append(journalTitle, journalNote);
      const reloadJournal = doc.createElement("button");
      reloadJournal.type = "button";
      reloadJournal.textContent = "Actualiser le journal";
      reloadJournal.addEventListener("click", () => showSharedMemory());
      panel.appendChild(reloadJournal);
      if (!(data.development || []).length) {
        const empty = doc.createElement("p");
        empty.textContent = "Les expériences, intérêts et rituels partagés feront apparaître des repères ici.";
        panel.appendChild(empty);
      }
      for (const view of data.development || []) {
        const row = doc.createElement("div");
        row.className = "hq-companion-memory-row";
        const text = doc.createElement("p");
        text.textContent = view.label + " · " + view.topic + " — " + view.description;
        const note = doc.createElement("small");
        note.textContent = "Révisable · " + (view.reinforcement_days || 1) + " jour(s) de partage · actualisé le " + new Date(view.updated_at * 1000).toLocaleDateString();
        row.append(text, note);
        if (view.previous_evidence) {
          const change = doc.createElement("p");
          change.textContent = "Ce qui a changé · avant : " + view.previous_evidence + " Maintenant : " + view.evidence;
          row.appendChild(change);
        }
        const sources = doc.createElement("details");
        const summary = doc.createElement("summary");
        summary.textContent = "Voir et corriger les sources";
        sources.appendChild(summary);
        for (const id of view.source_ids || []) {
          const episode = episodes.get(id);
          if (episode) { shownSources.add(id); appendEpisode(sources, episode); }
        }
        row.appendChild(sources);
        panel.appendChild(row);
      }
      for (const episode of data.episodes || []) {
        if (!shownSources.has(episode.id)) appendEpisode(panel, episode);
      }
      for (const followup of data.followups || []) {
        const row = doc.createElement("div");
        row.className = "hq-companion-memory-row";
        const text = doc.createElement("p");
        text.textContent = "En attente · " + followup.question;
        const close = doc.createElement("button");
        close.type = "button";
        close.textContent = "Ne plus relancer";
        close.addEventListener("click", () => showSharedMemory({ op: "followup_close", id: followup.id }));
        row.append(text, close);
        panel.appendChild(row);
      }
    } catch (error) {
      if (request === S.memoryRequest) errorLine(error);
    } finally {
      S.memoryBusy = false;
      panel.setAttribute("aria-busy", "false");
    }
  }

  async function showCompanionEditor() {
    const win = S.win, doc = win.document;
    if (doc.getElementById("hq-companion-editor")) return;
    const dialog = doc.createElement("dialog");
    dialog.id = "hq-companion-editor";
    dialog.className = "hq-companion-editor";
    dialog.setAttribute("aria-labelledby", "hq-companion-editor-title");
    const title = doc.createElement("h2");
    title.id = "hq-companion-editor-title";
    title.textContent = "Éditer Transferania";
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "Fermer l’éditeur";
    close.addEventListener("click", () => dialog.close());
    const nav = doc.createElement("nav");
    nav.setAttribute("aria-label", "Sections de l’éditeur");
    const body = doc.createElement("section");
    const status = doc.createElement("p");
    status.setAttribute("role", "status");
    const fail = error => { status.textContent = error.message || "Éditeur indisponible"; };
    let active = "", loading = false;
    const endVoicePreview = () => {
      if (!S.voicePreview) return;
      S.voicePreview = false;
      stopSpeech(win);
      syncVoiceBtn(win);
    };
    const button = (text, callback) => {
      const el = doc.createElement("button");
      el.type = "button";
      el.textContent = text;
      el.addEventListener("click", callback);
      return el;
    };
    const personality = async () => {
      if (loading) return;
      endVoicePreview();
      active = "personality";
      loading = true;
      status.textContent = "Chargement…";
      try {
        const data = await callTransferania(win, {op: "personality"});
        if (!dialog.isConnected) return;
        body.replaceChildren();
        const note = doc.createElement("p");
        note.textContent = "Traits partagés entre PC et iPhone. Les modes et sujets exclus restent prioritaires. Les voix ambiantes se règlent séparément pour rester courtes.";
        body.appendChild(note);
        const form = doc.createElement("form");
        const fields = {};
        for (const [key, value] of Object.entries(data.traits)) {
          const label = doc.createElement("label");
          label.textContent = data.labels[key];
          const input = doc.createElement("textarea");
          input.value = value;
          input.rows = key.startsWith("ambient_") ? 3 : 5;
          input.setAttribute("aria-label", data.labels[key]);
          const count = doc.createElement("small");
          const update = () => { count.textContent = new win.TextEncoder().encode(input.value).length + " / " + (key.startsWith("ambient_") ? 320 : 2400) + " octets"; };
          input.addEventListener("input", update);
          update();
          fields[key] = input;
          label.append(input, count);
          form.appendChild(label);
        }
        const save = doc.createElement("button");
        save.type = "submit";
        save.textContent = "Enregistrer la personnalité";
        const reset = button("Restaurer les traits par défaut", async () => {
          if (loading) return;
          loading = true;
          save.disabled = reset.disabled = true;
          try {
            await callTransferania(win, {op: "personality_reset", revision: data.revision});
            loading = false;
            await personality();
            status.textContent = "Traits par défaut restaurés.";
          } catch (error) { fail(error); }
          finally { loading = false; save.disabled = reset.disabled = false; }
        });
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (loading) return;
          loading = true;
          save.disabled = reset.disabled = true;
          try {
            const traits = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
            const out = await callTransferania(win, {op: "personality_save", revision: data.revision, traits});
            data.revision = out.revision;
            status.textContent = "Personnalité enregistrée · PC et iPhone.";
          } catch (error) { fail(error); }
          finally { loading = false; save.disabled = reset.disabled = false; }
        });
        form.append(save, reset);
        body.appendChild(form);
        status.textContent = "4200 octets maximum pour les cinq traits principaux. Aucun appel au modèle pour enregistrer.";
      } catch (error) { fail(error); }
      finally { loading = false; }
    };
    const context = () => {
      if (loading) return;
      endVoicePreview();
      active = "context";
      body.replaceChildren();
      status.textContent = "Aperçu local en lecture seule : aucun message envoyé, aucun appel au modèle.";
      const label = doc.createElement("label");
      label.textContent = "Contexte à préparer";
      const kind = doc.createElement("select");
      for (const [value, text] of [["chat", "Chat"], ["ambient", "Ambiant"]]) {
        const option = doc.createElement("option"); option.value = value; option.textContent = text; kind.appendChild(option);
      }
      label.appendChild(kind);
      const messageLabel = doc.createElement("label");
      messageLabel.textContent = "Message à prévisualiser";
      const message = doc.createElement("textarea");
      message.maxLength = 1600;
      message.value = (S.inputEl && S.inputEl.value.trim()) || "Bonjour Transferania.";
      messageLabel.appendChild(message);
      kind.addEventListener("change", () => { messageLabel.hidden = kind.value === "ambient"; });
      const result = doc.createElement("div");
      const preview = button("Préparer l’aperçu sans envoyer", async () => {
        if (loading) return;
        loading = true;
        preview.disabled = true;
        status.textContent = "Préparation locale…";
        try {
          const out = await callTransferania(win, {op: "context_preview", kind: kind.value, message: message.value,
            persona: readPersona(win), nsfw: S.nsfwAllowed && readNsfw(win),
            view: doc.body.dataset.view || "accueil", digest: digest(win)});
          if (!dialog.isConnected || active !== "context") return;
          result.replaceChildren();
          const usage = out.context_usage;
          status.textContent = "Entrée estimée : " + usage.estimated_input_tokens + " / " + usage.input_budget +
            " (borne UTF-8, pas compte fournisseur) · " + usage.selected_memory_count + " souvenirs · " + usage.omitted_history_count +
            " messages omis · 0 appel au modèle. " + out.note;
          const selection = doc.createElement("details");
          const selectionTitle = doc.createElement("summary");
          selectionTitle.textContent = "Pourquoi ces sections sont incluses ou omises";
          const table = doc.createElement("table");
          table.className = "hq-companion-context-selection";
          const heading = doc.createElement("tr");
          for (const title of ["Section", "Octets de texte", "Choix", "Motif"]) {
            const cell = doc.createElement("th"); cell.scope = "col"; cell.textContent = title; heading.appendChild(cell);
          }
          const thead = doc.createElement("thead"); thead.appendChild(heading); table.appendChild(thead);
          const tbody = doc.createElement("tbody");
          const names = {system:"Identité et règles", current_message:"Demande actuelle", correction:"Correction active",
            event:"Événement réel", time:"Heure et retour", followthrough:"Résultat et raison", memory:"Souvenir",
            summary:"Synthèse des décisions", behavior:"Réponse au contexte", page:"Contexte de la page",
            continuity:"Continuité", history_recent:"Échange récent", history_relevant:"Échange antérieur",
            delivery:"Cadence", quirk:"Manie facultative"};
          const reasons = {mandatory:"Protégé", included:"Priorité et budget", budget:"Budget insuffisant",
            duplicate:"Déjà présent", irrelevant:"Sans lien avec la demande"};
          for (const item of usage.selection_manifest || []) {
            const tr = doc.createElement("tr");
            const name = (names[item.kind] || "Section") + (Number.isInteger(item.history_index) ? " #" + (item.history_index+1) : "");
            for (const value of [name, item.estimated_bytes, item.selected ? "Inclus" : "Omis", reasons[item.reason] || item.reason]) {
              const cell = doc.createElement("td"); cell.textContent = String(value); tr.appendChild(cell);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          selection.append(selectionTitle, table);
          const totals = usage.selection_totals || {};
          const balance = doc.createElement("p");
          balance.textContent = ((totals.included || 0) + (totals.mandatory || 0)) + " sections retenues · " + (totals.budget || 0) +
            " omises par budget · " + (totals.duplicate || 0) + " doublons · " + (totals.irrelevant || 0) + " hors sujet.";
          selection.appendChild(balance);
          if (usage.manifest_omitted_count) {
            const note = doc.createElement("p"); note.textContent = usage.manifest_omitted_count + " sections supplémentaires comptées dans le bilan; affichage limité à 200 lignes.";
            selection.appendChild(note);
          }
          result.appendChild(selection);
          for (const [name, value] of [["Instructions envoyées au modèle", out.system],
            ["Messages sélectionnés (contenu complet)", JSON.stringify(out.contents, null, 2)]]) {
            const details = doc.createElement("details");
            const summary = doc.createElement("summary"); summary.textContent = name;
            const pre = doc.createElement("pre"); pre.textContent = value;
            details.append(summary, pre); result.appendChild(details);
          }
        } catch (error) { fail(error); }
        finally { loading = false; preview.disabled = false; }
      });
      body.append(label, messageLabel, preview, result);
    };
    const voice = () => {
      if (loading) return;
      endVoicePreview();
      active = "voice";
      body.replaceChildren();
      status.textContent = "Essai vocal local, sans appel au modèle. Le réglage Voix habituel reste inchangé.";
      const label = doc.createElement("label");
      label.textContent = "Interprétation vocale";
      const style = doc.createElement("select");
      style.setAttribute("aria-label", "Interprétation vocale");
      for (const [value, text] of [["neutral", "Naturelle"], ["thoughtful", "Pensive"], ["deadpan", "Pince-sans-rire"], ["warm", "Chaleureuse"], ["playful", "Joueuse"]]) {
        const option = doc.createElement("option"); option.value = value; option.textContent = text; style.appendChild(option);
      }
      label.appendChild(style);
      const messageLabel = doc.createElement("label");
      messageLabel.textContent = "Texte à écouter";
      const message = doc.createElement("textarea");
      message.setAttribute("aria-label", "Texte à écouter");
      message.maxLength = 400;
      message.value = "Je me demande pourquoi les étoiles scintillent. Peut-être que la réponse nous surprendra.";
      messageLabel.appendChild(message);
      const listen = button("Écouter cet essai", () => {
        if (!message.value.trim()) return;
        S.voicePreview = true;
        speak(win, message.value, null, "social", style.value);
        status.textContent = "Préparation et lecture locales… Si XTTS est occupé, la voix du navigateur prend le relais.";
      });
      body.append(label, messageLabel, listen, button("Arrêter l’essai", endVoicePreview));
    };
    nav.append(button("Personnalité", personality), button("Contexte API", context), button("Voix", voice), button("Souvenirs et évolution", () => {
      if (loading) return;
      dialog.close();
      if (S.memoryPanel.hidden) S.memoryBtn.click();
      else S.memoryPanel.focus({preventScroll: true});
    }));
    dialog.append(title, close, nav, status, body);
    dialog.addEventListener("close", () => { endVoicePreview(); dialog.remove(); });
    doc.body.appendChild(dialog);
    dialog.showModal();
    await personality();
  }

  async function clearMemory() {
    const win = S.win;
    if (!win || S.chatBusy) return;
    if (!win.confirm("Effacer la conversation de cet appareil ? Les souvenirs partagés restent accessibles dans Mémoire.")) return;
    S.chatBusy = true;
    try {
      await callTransferania(win, { op: "clear" });
      S.messages = [];
      S.hasSummary = false;
      renderLog();
      if (typeof win.hqToast === "function") win.hqToast("Conversation effacée sur cet appareil");
    } catch (e) {
      if (typeof win.hqToast === "function") win.hqToast((e && e.message) || "Erreur");
    } finally {
      S.chatBusy = false;
    }
  }

  // ---- perf6: pacing, retry/edit, facts, backups, stats, nudge (all degrade to a toast) ----
  const PACING_KEY = "hq_companion_pacing";

  function pacingOn(win) {
    try { return win.localStorage.getItem(PACING_KEY) !== "0"; } catch (_) { return true; }
  }

  function setPacing(win, on) {
    try { win.localStorage.setItem(PACING_KEY, on ? "1" : "0"); } catch (_) {}
  }

  function paceDelay(text) {
    return Math.max(600, Math.min(2500, String(text || "").length * 25));
  }

  function showTypingRow() {
    if (!S.logEl) return;
    const doc = S.win.document;
    const row = doc.createElement("div");
    row.className = "hq-companion-msg is-her is-typing";
    row.setAttribute("aria-live", "polite");
    const who = doc.createElement("span");
    who.className = "hq-companion-msg-who";
    who.textContent = COMPANION_NAME;
    const txt = doc.createElement("p");
    txt.className = "hq-companion-msg-text";
    txt.textContent = COMPANION_NAME + " écrit…";
    txt.style.opacity = "0.65";
    txt.style.fontStyle = "italic";
    row.append(who, txt);
    S.logEl.appendChild(row);
    followChatTail();
  }

  // Reveal the reply piece by piece with a typing row between pieces. Returns false when not used.
  async function paceReply(win, out) {
    if (!out || !out.reply || !pacingOn(win) || calm(win) || !Array.isArray(S.messages)) return false;
    let last = -1;
    for (let i = S.messages.length - 1; i >= 0; i -= 1) {
      const m = S.messages[i];
      if (m && m.role === "assistant" && m.kind !== "ambient") { last = i; break; }
      if (m && m.role === "user") break;
    }
    if (last < 0) { renderLog(); return false; }
    const full = S.messages.slice();
    const final = full[last];
    let segs = Array.isArray(out.reply_segments) ? out.reply_segments.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6) : [];
    if (!segs.length) segs = [String(final.text || out.reply)];
    try {
      for (let i = 0; i < segs.length; i += 1) {
        S.messages = full.slice(0, last).concat(i ? [Object.assign({}, final, { text: segs.slice(0, i).join("\n\n") })] : []);
        renderLog();
        showTypingRow();
        await new Promise((resolve) => win.setTimeout(resolve, paceDelay(segs[i])));
        if (S.messages.length > last + 1) break;
      }
    } finally {
      S.messages = full;
      renderLog();
    }
    return true;
  }

  function toastMsg(win, text) {
    if (typeof win.hqToast === "function") win.hqToast(text);
  }

  async function rewindChat(op, message) {
    const win = S.win;
    if (!win || S.chatBusy || S.blocked) return;
    let persona = readPersona(win);
    if (S.cap === "warm" && persona === "flirt") persona = "warm";
    const saved = S.messages.slice();
    S.chatBusy = true;
    syncListening(true);
    S.el && S.el.classList.add("hq-companion-chat-busy");
    try {
      const payload = {
        op, view: win.document.body.dataset.view || "accueil", digest: digest(win), persona,
        nsfw: S.nsfwAllowed && readNsfw(win), signals: collectSignals(win),
      };
      if (message != null) payload.message = message;
      const out = await callTransferania(win, payload);
      if (Array.isArray(out.messages)) S.messages = out.messages;
      applyCharacterExpression(win, out.expression);
      setLineAnimated(win, out.reply || "");
      if (!(await paceReply(win, out))) renderLog();
      if (out.reply && !S.voicePreview) speak(win, out.reply, null, out.context_usage && out.context_usage.conversation_mode,
        out.expression && out.expression.voice !== "neutral" ? out.expression.voice : undefined);
    } catch (e) {
      S.messages = saved;
      renderLog();
      toastMsg(win, (e && e.message) || "Transferania indisponible");
    } finally {
      S.chatBusy = false;
      syncListening(S.busy);
      S.el && S.el.classList.remove("hq-companion-chat-busy");
    }
  }

  function lastUserText() {
    const msgs = S.messages || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i] && msgs[i].role === "user") return String(msgs[i].text || "");
    return "";
  }

  function toolsSection(doc, title) {
    const box = doc.createElement("section");
    box.style.margin = "0.6em 0";
    const h = doc.createElement("h3");
    h.textContent = title;
    h.style.fontSize = "1em";
    h.style.margin = "0 0 0.3em";
    const body = doc.createElement("div");
    box.append(h, body);
    return { box, body };
  }

  function toolsButton(doc, label, fn) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.margin = "0.15em";
    b.addEventListener("click", fn);
    return b;
  }

  async function openCompanionTools() {
    const win = S.win;
    if (!win || S.blocked) return;
    const doc = win.document;
    const dialog = doc.createElement("dialog");
    dialog.className = "hq-companion-tools-dialog";
    dialog.setAttribute("aria-label", "Outils de " + COMPANION_NAME);
    dialog.style.maxWidth = "min(560px, 94vw)";
    dialog.style.maxHeight = "86vh";
    dialog.style.overflow = "auto";
    const close = () => dialog.close();

    const chat = toolsSection(doc, "Conversation");
    chat.body.append(
      toolsButton(doc, "Régénérer la dernière réponse", () => { close(); rewindChat("regenerate"); }),
      toolsButton(doc, "Modifier mon dernier message", () => {
        const prev = lastUserText();
        if (!prev) { toastMsg(win, "Aucun message à modifier"); return; }
        const next = win.prompt("Modifier puis renvoyer :", prev);
        if (next == null || !next.trim()) return;
        close();
        rewindChat("edit_last", next.trim());
      }));

    const prefs = toolsSection(doc, "Préférences");
    const mkToggle = (label, checked, onChange) => {
      const lab = doc.createElement("label");
      lab.style.display = "block";
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checked;
      cb.addEventListener("change", () => onChange(cb.checked, cb));
      lab.append(cb, doc.createTextNode(" " + label));
      return lab;
    };
    prefs.body.append(
      mkToggle("Rythme d'écriture (réponses révélées par morceaux)", pacingOn(win), (on) => setPacing(win, on)),
      mkToggle("Elle peut m'écrire en premier (max 1/jour, 9 h–21 h 30, après 6 h de silence)", !!(S.prefs && S.prefs.nudge), async (on, cb) => {
        try {
          await callTransferania(win, { op: "prefs", save: true, prefs: { nudge: on } });
          S.prefs = Object.assign({}, S.prefs || DEFAULT_PREFS, { nudge: on });
        } catch (e) {
          cb.checked = !on;
          toastMsg(win, (e && e.message) || "Erreur");
        }
      }));

    const facts = toolsSection(doc, "Faits durables");
    const renderFacts = async () => {
      facts.body.replaceChildren(doc.createTextNode("Chargement…"));
      try {
        const out = await callTransferania(win, { op: "facts" });
        facts.body.replaceChildren();
        if (out.unreadable) facts.body.append(doc.createTextNode("Fichier de faits illisible : copie conservée, modifications bloquées. "));
        const list = doc.createElement("ul");
        list.style.paddingLeft = "1.2em";
        (out.facts || []).forEach((f) => {
          const li = doc.createElement("li");
          li.append(doc.createTextNode(String(f.text || "") + " "),
            toolsButton(doc, "Modifier", async () => {
              const t = win.prompt("Modifier ce fait :", f.text || "");
              if (t == null || !t.trim()) return;
              try { await callTransferania(win, { op: "fact_edit", id: f.id, text: t.trim() }); } catch (e) { toastMsg(win, (e && e.message) || "Erreur"); }
              renderFacts();
            }),
            toolsButton(doc, "Oublier", async () => {
              if (!win.confirm("Oublier ce fait ?")) return;
              try { await callTransferania(win, { op: "fact_delete", id: f.id }); } catch (e) { toastMsg(win, (e && e.message) || "Erreur"); }
              renderFacts();
            }));
          list.appendChild(li);
        });
        if (!(out.facts || []).length) facts.body.append(doc.createTextNode("Aucun fait pour l'instant. Astuce : « souviens-toi : … » dans le chat. "));
        facts.body.append(list, doc.createTextNode(((out.facts || []).length) + "/" + (out.max || 40) + " "),
          toolsButton(doc, "Ajouter un fait", async () => {
            const t = win.prompt("Nouveau fait à retenir :", "");
            if (t == null || !t.trim()) return;
            try { await callTransferania(win, { op: "fact_add", text: t.trim() }); } catch (e) { toastMsg(win, (e && e.message) || "Erreur"); }
            renderFacts();
          }));
      } catch (e) {
        facts.body.replaceChildren(doc.createTextNode((e && e.message) || "Faits indisponibles"));
      }
    };

    const backups = toolsSection(doc, "Sauvegardes (7 derniers jours)");
    const renderBackups = async () => {
      backups.body.replaceChildren(doc.createTextNode("Chargement…"));
      try {
        const out = await callTransferania(win, { op: "backups" });
        backups.body.replaceChildren();
        const items = out.backups || [];
        if (!items.length) backups.body.append(doc.createTextNode("Aucune sauvegarde pour l'instant (créée au premier message de chaque jour)."));
        items.forEach((b) => {
          const row = doc.createElement("div");
          row.append(doc.createTextNode((b.day || b.name) + " · " + (b.bytes != null ? Math.max(1, Math.round(b.bytes / 1024)) + " ko" : "") + " "),
            toolsButton(doc, "Restaurer", async () => {
              if (!win.confirm("Remplacer la conversation actuelle par la sauvegarde du " + (b.day || b.name) + " ? (L'actuelle est mise de côté.)")) return;
              try {
                await callTransferania(win, { op: "backup_restore", name: b.name });
                close();
                await loadHistory();
                toastMsg(win, "Conversation restaurée");
              } catch (e) { toastMsg(win, (e && e.message) || "Erreur"); }
            }));
          backups.body.appendChild(row);
        });
      } catch (e) {
        backups.body.replaceChildren(doc.createTextNode((e && e.message) || "Sauvegardes indisponibles"));
      }
    };

    const stats = toolsSection(doc, "Coût et latence");
    const renderStats = async () => {
      stats.body.replaceChildren(doc.createTextNode("Chargement…"));
      try {
        const out = await callTransferania(win, { op: "stats" });
        const lines = [
          "Échanges récents : " + (out.count || 0),
          "Latence médiane : " + (out.median_latency_ms != null ? Math.round(out.median_latency_ms) + " ms" : "n/d"),
          "Coût aujourd'hui : " + (out.prices_configured ? "$" + Number(out.cost_today || 0).toFixed(4) : "prix non configurés") +
            (out.cost_today_unpriced ? " (" + out.cost_today_unpriced + " sans prix)" : ""),
          "Modèles : " + Object.entries(out.model_mix || {}).map(([k, v]) => k + " ×" + v).join(", "),
        ];
        const pre = doc.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.fontSize = "0.85em";
        pre.textContent = lines.join("\n") + "\n\n" + (out.recent || []).slice(0, 10).map((r) =>
          (r.at ? new Date(r.at * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto", hour12: false }) : "") + "  " + (r.model || "?") + "  " + (r.latency_ms != null ? r.latency_ms + " ms" : "") +
          (r.cost != null ? "  $" + Number(r.cost).toFixed(5) : "")).join("\n");
        stats.body.replaceChildren(pre);
      } catch (e) {
        stats.body.replaceChildren(doc.createTextNode((e && e.message) || "Statistiques indisponibles"));
      }
    };

    const foot = doc.createElement("div");
    foot.style.textAlign = "right";
    foot.appendChild(toolsButton(doc, "Fermer", close));
    dialog.append(chat.box, prefs.box, facts.box, backups.box, stats.box, foot);
    dialog.addEventListener("close", () => dialog.remove());
    doc.body.appendChild(dialog);
    dialog.showModal();
    renderFacts();
    renderBackups();
    renderStats();
  }
  async function sendChat() {
    const win = S.win;
    if (!win || !S.inputEl || S.chatBusy || S.blocked) return;
    const text = (S.inputEl.value || "").trim();
    if (!text) return;
    const view = win.document.body.dataset.view || "accueil";
    let persona = readPersona(win);
    if (S.cap === "warm" && persona === "flirt") persona = "warm";
    S.chatBusy = true;
    syncListening(true);
    S.el && S.el.classList.add("hq-companion-chat-busy");
    S.readPreview = null;
    S.messages.push({ role: "user", text, ts: Date.now() });
    renderLog();
    playNaturalVoiceCue(win, "message_ack");
    S.inputEl.value = "";
    if (S.nsfwAllowed && readNsfw(win)) playAdultFx(win, "send-pulse", 900);
    try {
      const out = await callTransferania(win, {
        op: "send",
        message: text,
        view,
        digest: digest(win),
        persona,
        nsfw: S.nsfwAllowed && readNsfw(win),
        signals: collectSignals(win),
      });
      if (Array.isArray(out.messages)) S.messages = out.messages;
      else if (out.reply) S.messages.push({ role: "assistant", text: out.reply, kind: "chat" });
      S.hasSummary = !!out.has_summary;
      if (S.hasSummary && !S.hadSummary) pulseMemChip();
      S.hadSummary = S.hasSummary;
      if (typeof out.warmth === "number" && out.warmth > (S.warmth || 0)) {
        S.warmth = Math.min(100, out.warmth);
        syncLargePortraitCaption(win);
      }
      applyLive2DImpulse(win, (Math.random() > 0.5 ? 1 : -1) * 32, -48, (Math.random() > 0.5 ? 1 : -1) * 22);
      applyCharacterExpression(win, out.expression);
      setLineAnimated(win, out.reply || "");
      const pacing = (out.reply && pacingOn(win) && !calm(win)) ? paceReply(win, out) : null;
      if (!pacing) {
        renderLog();
        const lastHer = S.logEl && S.logEl.querySelector(".hq-companion-msg.is-her:last-child .hq-companion-msg-text");
        if (lastHer && out.reply) typewriterLine(win, lastHer, out.reply, () => followChatTail());
      }
      S.pacingPromise = pacing;
      onAdultChatFx(win, out);
      S.lastAmbientAt = Date.now();
      if (out.reply && !S.voicePreview) speak(win, out.reply, null, out.context_usage && out.context_usage.conversation_mode,
        out.expression && out.expression.voice !== "neutral" ? out.expression.voice : undefined);
      if (!calm(win)) {
        S.inputEl && S.inputEl.classList.add("is-sent-glow");
        win.setTimeout(() => S.inputEl && S.inputEl.classList.remove("is-sent-glow"), 900);
        if (S.sendBtn) {
          S.sendBtn.classList.add("is-nudge-send");
          win.setTimeout(() => S.sendBtn && S.sendBtn.classList.remove("is-nudge-send"), 520);
        }
      }
    } catch (e) {
      S.messages.pop();
      renderLog();
      if (e && (e.status === 403 || e.status === 401)) {
        S.blocked = true;
        S.el.hidden = true;
        return;
      }
      if (typeof win.hqToast === "function") win.hqToast((e && e.message) || "Transferania indisponible");
    } finally {
      try { if (S.pacingPromise) await S.pacingPromise; } catch (_) {}
      S.pacingPromise = null;
      S.chatBusy = false;
      syncListening(S.busy);
      S.el && S.el.classList.remove("hq-companion-chat-busy");
      if (S.escalateBtn) S.escalateBtn.classList.remove("is-armed");
    }
  }

  function noteAvatarFocus() {
    S.lastAvatarFocusAt = Date.now();
  }

  let lastAttentionAvRect = null;
  let lastAttentionAvRectAt = 0;

  function measureCompanionAttention(win) {
    if (!win || !S.el || S.el.hidden || win.document.hidden) return 0;
    if (typeof win.document.hasFocus === "function" && !win.document.hasFocus()) return 0;
    const av = S.avatar || S.el.querySelector(".hq-companion-avatar");
    if (!av) return 0;
    const now = Date.now();
    const compact = isCompactUI(win);
    let r = lastAttentionAvRect;
    if (!r || now - lastAttentionAvRectAt > (compact ? 2400 : 800)) {
      r = av.getBoundingClientRect();
      lastAttentionAvRect = r;
      lastAttentionAvRectAt = now;
    }
    if (r.width < 10 || r.height < 10) return 0;
    const vw = win.innerWidth || 390;
    const vh = win.innerHeight || 700;
    const faceX = r.left + r.width * 0.5;
    const faceY = r.top + r.height * (S.nsfwOn ? 0.26 : 0.32);
    const cx = vw * 0.5;
    const cy = vh * (isCompactUI(win) ? 0.4 : 0.44);
    const dist = Math.hypot(faceX - cx, faceY - cy);
    const norm = dist / Math.hypot(vw * 0.34, vh * 0.32);
    let score = clampNum(1 - norm * 0.95, 0, 1);
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const visRatio = (visW * visH) / Math.max(1, r.width * r.height);
    score *= clampNum(visRatio * 1.12, 0, 1);
    if (typeof S.attentionVisibleRatio === "number") {
      score *= clampNum(0.35 + S.attentionVisibleRatio * 0.75, 0, 1);
    }
    if (S.collapsed && !S.expanded && !S.intimeMode) score *= 0.5;
    if (S.lastAvatarFocusAt) {
      const age = Date.now() - S.lastAvatarFocusAt;
      if (age < 5000) score = clampNum(score + (1 - age / 5000) * 0.38, 0, 1);
    }
    return score;
  }

  function applyCompanionDof(win) {
    if (!win || !S.el || S.el.hidden) return;
    const rm = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const active = !S.el.classList.contains("is-minimal") || S.intimeMode;
    S.el.classList.toggle("is-dof-portrait", active);
    const focus = typeof S.attentionScore === "number" ? S.attentionScore : 0;
    const looking = !!S.userLookingAtCompanion;
    S.el.classList.toggle("is-user-looking", looking);
    // Root variables restyle the whole companion (and re-blur the bubble backdrop): write them only
    // when they actually change, with focus snapped to 0.05 steps.
    const focusVal = (Math.round(focus * 20) / 20).toFixed(2);
    const glowVal = looking ? "0.62" : "0.2";
    if (S.lastDofFocus !== focusVal) {
      S.lastDofFocus = focusVal;
      S.el.style.setProperty("--companion-dof-focus", focusVal);
    }
    if (S.lastDofGlow !== glowVal) {
      S.lastDofGlow = glowVal;
      S.el.style.setProperty("--companion-dof-glow", glowVal);
    }
    if (rm) {
      S.el.style.setProperty("--companion-dof-blur", "0px");
      return;
    }
    const blurBase = isCompactUI(win) ? 2 : 3.2;
    const blur = blurBase * (1 - focus * 0.85);
    const lastBlur = typeof S.lastAppliedBlur === "number" ? S.lastAppliedBlur : -1;
    if (Math.abs(blur - lastBlur) > 0.25) {
      S.lastAppliedBlur = blur;
      S.el.style.setProperty("--companion-dof-blur", blur.toFixed(2) + "px");
    }
    syncIdleContinuousStates(win);
  }

  const IDLE_ANIM_STRIP = [
    "is-idle-fidget", "is-idle-jiggle-shimmy", "is-idle-jiggle-bounce", "is-idle-jiggle-wobble",
    "is-idle-jiggle-settle", "is-idle-jiggle-soft", "is-idle-weight-shift", "is-idle-hair-tuck",
    "is-idle-lip-bite", "is-idle-shoulder-roll", "is-idle-pendulum-hair", "is-idle-foot-tap",
    "is-idle-aftershock", "is-idle-aftershock-2", "is-idle-shiver", "is-idle-stretch-yawn",
    "is-idle-hiccup", "is-idle-tease-peek", "is-idle-forge-spark", "is-idle-bubble-tail",
    "is-idle-mirror-check", "is-idle-walk-cycle", "is-idle-music-nod", "is-idle-steam-curl",
    "is-idle-groove-sway", "is-idle-kiss-blow", "is-idle-shy-wiggle", "is-idle-cute-wink",
    "is-idle-heart-flutter", "is-idle-sparkle-shimmy"
  ];

  const CUTE_NSFW_IDLE_KINDS = new Set([
    "grooveSway", "kissBlow", "shyWiggle", "cuteWink", "heartFlutter", "sparkleShimmy"
  ]);

  function idleAnimBlocked(win) {
    if (!win || !S.el || S.el.hidden || win.document.hidden) return true;
    if (S.el.classList.contains("is-minimal") && !S.intimeMode) return true;
    if (lifeMotionBlocked() && !S.intimeMode) return true;
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function stripIdleBurstClasses() {
    if (!S.el) return;
    S.el.classList.remove(...IDLE_ANIM_STRIP);
  }

  function syncIdleContinuousStates(win) {
    if (!win || !S.el || S.el.hidden) return;
    const rm = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const minimal = S.el.classList.contains("is-minimal") && !S.intimeMode;
    const looking = !!S.userLookingAtCompanion;
    const warm = typeof S.warmth === "number" ? S.warmth : 22;
    const expanded = S.expanded || S.intimeMode;
    S.el.classList.toggle("is-idle-hold-gaze", !rm && !minimal && looking);
    S.el.classList.toggle("is-idle-stillness", !rm && !minimal && looking);
    S.el.classList.toggle("is-idle-blush-pulse", !rm && !minimal && looking && warm >= 52);
    S.el.classList.toggle("is-idle-closer-idle", !rm && !minimal && looking && expanded);
    S.el.classList.toggle("is-idle-bubble-breath-sync", !rm && !minimal && S.nsfwOn);
    S.el.classList.toggle("is-idle-intime-candle", !rm && S.intimeMode);
    S.el.classList.toggle("is-idle-intime-rustle", !rm && S.intimeMode);
    S.el.classList.toggle("is-idle-warmth-amp", !rm && !minimal && warm >= 68);
    S.el.classList.toggle("is-idle-latenight-idle", !rm && !minimal && S.el.classList.contains("is-time-latenight"));
    S.el.classList.toggle("is-idle-ink-drift", !rm && !minimal && S.expanded && !!S.logEl);
    S.el.classList.toggle("is-idle-compose-caret", !rm && !minimal && S.expanded && S.inputEl &&
      !String(S.inputEl.value || "").trim() &&
      win.document.activeElement !== S.inputEl);
    S.el.classList.toggle("is-idle-treat-bounce", !rm && !minimal && S.treatsTray &&
      S.treatsTray.classList.contains("is-open"));
    S.el.classList.toggle("is-idle-bubble-tail", !rm && !minimal && !S.collapsed);
    const warmthJiggle = clampNum(warm / 100, 0, 1).toFixed(3);
    if (S.el.style.getPropertyValue("--idle-warmth-jiggle") !== warmthJiggle) {
      S.el.style.setProperty("--idle-warmth-jiggle", warmthJiggle);
    }
    if (looking && !rm) {
      S.el.style.setProperty("--idle-gaze-lean-y", "-1.1px");
      S.el.style.setProperty("--idle-gaze-lean-scale", "1.018");
    } else {
      S.el.style.removeProperty("--idle-gaze-lean-y");
      S.el.style.removeProperty("--idle-gaze-lean-scale");
    }
  }

  function spawnIdleBubbleDoodle(win, symbol) {
    if (!S.bubble || idleAnimBlocked(win)) return;
    if (S.bubble.querySelector(".hq-companion-idle-doodle")) return;
    const d = win.document.createElement("span");
    d.className = "hq-companion-idle-doodle";
    d.setAttribute("aria-hidden", "true");
    d.textContent = symbol || (Math.random() < 0.5 ? "♥" : "✨");
    S.bubble.appendChild(d);
    win.setTimeout(() => d.remove(), 3400);
  }

  function playIdleAnim(win, kind) {
    if (kind === "humming") { startIdleHumming(win); return; }
    if (CUTE_NSFW_IDLE_KINDS.has(kind) && !S.nsfwOn) return;
    if (idleAnimBlocked(win)) {
      if (S.nsfwOn && /^(settle|aftershock|hiccup)$/.test(kind)) triggerBustSettleProfile(win, "generic");
      return;
    }
    const sign = Math.random() > 0.5 ? 1 : -1;
    const burst = {
      shimmy: { cls: "is-idle-jiggle-shimmy", ms: 900, ix: 32, iy: -6 },
      bounce: { cls: "is-idle-jiggle-bounce", ms: 1020, ix: sign * 8, iy: 42 },
      sway: { cls: "is-idle-fidget", ms: 780, ix: sign * 24, iy: -14 },
      wobble: { cls: "is-idle-jiggle-wobble", ms: 1100, ix: sign * 38, iy: 22 },
      settle: { cls: "is-idle-jiggle-settle", ms: 940, settle: true },
      weightShift: { cls: "is-idle-weight-shift", ms: 1180, ix: sign * 14, iy: 6 },
      hairTuck: { cls: "is-idle-hair-tuck", ms: 980, ix: sign * 10, iy: -8 },
      lipBite: { cls: "is-idle-lip-bite", ms: 820, lip: true },
      shoulderRoll: { cls: "is-idle-shoulder-roll", ms: 1050, ix: sign * 18, iy: 4 },
      pendulumHair: { cls: "is-idle-pendulum-hair", ms: 1400, ix: sign * 22, iy: -4 },
      footTap: { cls: "is-idle-foot-tap", ms: 880, ix: 0, iy: 12 },
      shiver: { cls: "is-idle-shiver", ms: 1250, ix: sign * 8, iy: -14 },
      stretchYawn: { cls: "is-idle-stretch-yawn", ms: 2200, ix: 0, iy: -28, stretch: true },
      hiccup: { cls: "is-idle-hiccup", ms: 520, ix: 0, iy: 48, hiccup: true },
      mirrorCheck: { cls: "is-idle-mirror-check", ms: 1300, ix: 0, iy: -6 },
      forgeSpark: { cls: "is-idle-forge-spark", ms: 1100 },
      bubbleTail: { cls: "is-idle-bubble-tail", ms: 900 },
      steamCurl: { steam: true, ms: 2400 },
      doodleFade: { doodle: true },
      teasePeek: { tease: true },
      aftershock: { aftershock: true },
      walkCycle: { walk: true },
      musicNod: { cls: "is-idle-music-nod", ms: 780, ix: 0, iy: -16 },
      grooveSway: { cls: "is-idle-groove-sway", ms: 1100, ix: sign * 20, iy: -8 },
      kissBlow: { cls: "is-idle-kiss-blow", ms: 900, ix: 0, iy: -10, kiss: true },
      shyWiggle: { cls: "is-idle-shy-wiggle", ms: 1050, ix: sign * 16, iy: 4, shy: true },
      cuteWink: { cls: "is-idle-cute-wink", ms: 720, wink: true },
      heartFlutter: { cls: "is-idle-heart-flutter", ms: 1400, hearts: true },
      sparkleShimmy: { cls: "is-idle-sparkle-shimmy", ms: 950, ix: sign * 28, iy: -4, sparkle: true }
    };
    const v = burst[kind] || burst.sway;
    const idleCue = {
      stretchYawn: "stretch", musicNod: "music_started", lipBite: "lip_bite", hairTuck: "hair_tuck",
      kissBlow: "idle_kiss", heartFlutter: "idle_heart"
    }[kind];
    if (idleCue) playNaturalVoiceCue(win, idleCue);
    if (kind === "shyWiggle" && Math.random() < 0.38) playNaturalVoiceCue(win, "idle_shy");
    if (kind === "hairTuck" && !muted(win) && readForgeSound(win)) playHairPatImpactSfx(win, 0.38);
    if (v.tease) {
      S.el.classList.add("is-idle-tease-peek");
      setLive2DTarget(win, sign * 2.6, 0.5);
      win.setTimeout(() => {
        if (S.el) S.el.classList.remove("is-idle-tease-peek");
        setLive2DTarget(win, 0, -1.1);
      }, 1050);
      return;
    }
    if (v.aftershock) {
      stripIdleBurstClasses();
      S.el.classList.add("is-idle-aftershock");
      if (S.nsfwOn) applyLive2DImpulse(win, sign * 26, 18, sign * 8);
      win.setTimeout(() => {
        if (!S.el) return;
        S.el.classList.remove("is-idle-aftershock");
        S.el.classList.add("is-idle-aftershock-2");
        if (S.nsfwOn) applyLive2DImpulse(win, -sign * 12, 8, -sign * 4);
        win.setTimeout(() => S.el && S.el.classList.remove("is-idle-aftershock-2"), 480);
      }, 380);
      startLive2DLoop(win);
      return;
    }
    if (v.walk) {
      stripIdleBurstClasses();
      S.el.classList.add("is-idle-walk-cycle");
      S.idleWalkUntil = Date.now() + 2400;
      S.idleWalkStep = 0;
      S.idleWalkNextAt = Date.now();
      win.setTimeout(() => S.el && S.el.classList.remove("is-idle-walk-cycle"), 2500);
      return;
    }
    if (v.doodle) {
      spawnIdleBubbleDoodle(win);
      return;
    }
    if (v.steam) {
      S.el.classList.add("is-idle-steam-curl");
      win.setTimeout(() => S.el && S.el.classList.remove("is-idle-steam-curl"), v.ms);
      return;
    }
    if (v.kiss && S.el) {
      stripIdleBurstClasses();
      S.el.style.setProperty("--idle-sign", String(sign));
      S.el.classList.add(v.cls);
      spawnIdleKiss(win);
      if (S.nsfwOn) {
        applyLive2DImpulse(win, 0, v.iy || -10, sign * 4);
        startLive2DLoop(win);
      }
      win.setTimeout(() => S.el && S.el.classList.remove(v.cls), v.ms);
      return;
    }
    if (v.wink && S.el) {
      stripIdleBurstClasses();
      S.el.classList.add(v.cls);
      blink(win);
      setLive2DTarget(win, sign * 1.8, -0.6);
      win.setTimeout(() => {
        if (S.el) {
          S.el.classList.remove(v.cls);
          setLive2DTarget(win, 0, -1.1);
        }
      }, v.ms);
      return;
    }
    if (v.hearts && S.el) {
      stripIdleBurstClasses();
      S.el.classList.add(v.cls);
      spawnIdleHeartFloat(win);
      win.setTimeout(() => S.el && S.el.classList.remove(v.cls), v.ms);
      return;
    }
    if (v.sparkle && S.el) {
      stripIdleBurstClasses();
      S.el.style.setProperty("--idle-sign", String(sign));
      S.el.classList.add(v.cls);
      spawnIdleBubbleDoodle(win, "✨");
      if (S.nsfwOn) {
        applyLive2DImpulse(win, v.ix || 0, v.iy || 0, sign * 6);
        startLive2DLoop(win);
      }
      win.setTimeout(() => S.el && S.el.classList.remove(v.cls), v.ms);
      return;
    }
    if (v.lip && S.el) {
      stripIdleBurstClasses();
      S.el.classList.add(v.cls);
      S.el.style.setProperty("--rig-voice-nod", "1.028");
      win.setTimeout(() => {
        if (S.el) {
          S.el.classList.remove(v.cls);
          S.el.style.setProperty("--rig-voice-nod", "1");
        }
      }, v.ms);
      return;
    }
    stripIdleBurstClasses();
    S.el.style.setProperty("--idle-sign", String(sign));
    if (v.cls) S.el.classList.add(v.cls);
    win.setTimeout(() => S.el && S.el.classList.remove(v.cls), v.ms || 800);
    if (v.settle) {
      triggerBustSettleProfile(win, "generic");
      impulseBustSidesOnly(win, sign * 28, 36, 1.05);
    } else if (v.hiccup && S.nsfwOn) {
      applyLive2DImpulse(win, 0, v.iy, sign * 6);
      startLive2DLoop(win);
    } else if (v.stretch && S.nsfwOn) {
      applyLive2DImpulse(win, sign * 12, v.iy, 0);
      impulseBustSidesOnly(win, sign * 18, 24, 1.1);
      startLive2DLoop(win);
    } else if (S.nsfwOn && (v.ix || v.iy)) {
      applyLive2DImpulse(win, v.ix || 0, v.iy || 0, sign * Math.abs(v.ix || 8) * 0.16);
      startLive2DLoop(win);
    } else if (!S.nsfwOn) {
      S.el.classList.add("is-idle-jiggle-soft");
      win.setTimeout(() => S.el && S.el.classList.remove("is-idle-jiggle-soft"), v.ms || 720);
    }
  }

  function playIdleJiggle(win, kind) {
    playIdleAnim(win, kind);
  }

  function pickIdleAnimKind() {
    const r = Math.random();
    if (r >= 0.70 && r < 0.78) return "humming";
    if (S.nsfwOn) {
      if (r >= 0.78 && r < 0.815) return "grooveSway";
      if (r >= 0.815 && r < 0.845) return "kissBlow";
      if (r >= 0.845 && r < 0.87) return "shyWiggle";
      if (r >= 0.87 && r < 0.89) return "cuteWink";
      if (r >= 0.89 && r < 0.91) return "heartFlutter";
      if (r >= 0.91 && r < 0.93) return "sparkleShimmy";
    }
    if (r < 0.04) return "aftershock";
    if (r < 0.07) return "walkCycle";
    if (r < 0.09) return "stretchYawn";
    if (r < 0.11) return "teasePeek";
    if (r < 0.13) return "hiccup";
    if (r < 0.15) return "doodleFade";
    if (r < 0.17) return "steamCurl";
    if (r < 0.19) return "mirrorCheck";
    if (r < 0.21) return "weightShift";
    if (r < 0.23) return "hairTuck";
    if (r < 0.25) return "lipBite";
    if (r < 0.27) return "shoulderRoll";
    if (r < 0.29) return "pendulumHair";
    if (r < 0.31) return "footTap";
    if (r < 0.33) return "shiver";
    if (r < 0.38) return "bounce";
    if (r < 0.44) return "shimmy";
    if (r < 0.50) return "wobble";
    if (r < 0.56) return "settle";
    if (r < 0.62) return "sway";
    if (r < 0.66) return "bubbleTail";
    if (S.win && (S.win.document.body.dataset.view || "") === "forge" && r < 0.70) return "forgeSpark";
    return pickIdleJiggleKindLegacy();
  }

  function pickIdleJiggleKindLegacy() {
    const r = Math.random();
    if (r < 0.25) return "bounce";
    if (r < 0.5) return "shimmy";
    if (r < 0.75) return "wobble";
    return "settle";
  }

  function scheduleIdleForgeSpark(win) {
    win.clearTimeout(S.idleForgeSparkT);
    if (!S.el || idleAnimBlocked(win)) return;
    const view = (win.document.body && win.document.body.dataset.view) || "";
    if (view !== "forge") return;
    S.idleForgeSparkT = win.setTimeout(() => {
      if ((win.document.body.dataset.view || "") === "forge") playIdleAnim(win, "forgeSpark");
      scheduleIdleForgeSpark(win);
    }, 18000 + Math.random() * 8000);
  }

  function watchIdleExtras(win) {
    win.clearInterval(S.idleExtrasT);
    S.idleExtrasT = win.setInterval(() => {
      if (!S.el || S.el.hidden) return;
      syncIdleContinuousStates(win);
      const view = win.document.body.dataset.view || "";
      if (view === "forge") scheduleIdleForgeSpark(win);
      if (S.el.classList.contains("is-music-grooving") && !idleAnimBlocked(win) && Math.random() < 0.22) {
        playIdleAnim(win, "musicNod");
      }
    }, 2400);
  }

  function scheduleIdleAnimRoulette(win) {
    win.clearTimeout(S.idleAnimRouletteT);
    if (calm(win)) return;
    S.idleAnimRouletteT = win.setTimeout(() => {
      const idleMs = Date.now() - (S.lastActAt || Date.now());
      if (!idleAnimBlocked(win) && idleMs > 3500 && !S.companionDragActive) {
        if (Math.random() < 0.55) playIdleAnim(win, pickIdleAnimKind());
      }
      scheduleIdleAnimRoulette(win);
    }, 8000 + Math.random() * 10000);
  }

  function onCompanionLookEngage(win) {
    if (!S.el || calm(win)) return;
    setLive2DTarget(win, 0, -1.4);
    if (S.nsfwOn && (!S.lastLookEngageAt || Date.now() - S.lastLookEngageAt > 14000)) {
      S.lastLookEngageAt = Date.now();
      addArousalWarmth(win, 2, "regard sur elle");
      if (Math.random() < 0.4) blink(win);
    }
  }

  function syncCompanionAttention(win) {
    if (!S.el || S.el.hidden) return;
    const raw = measureCompanionAttention(win);
    const prev = typeof S.attentionScore === "number" ? S.attentionScore : 0;
    S.attentionScore = prev * 0.68 + raw * 0.32;
    const wasLooking = !!S.userLookingAtCompanion;
    if (S.attentionScore > 0.56) {
      if (!wasLooking) {
        onCompanionLookEngage(win);
        S.lookSince = Date.now();
      } else if (S.lookSince && Date.now() - S.lookSince > 2500) {
        S.lookSince = 0;
        shyStareBack(win);
      }
      S.userLookingAtCompanion = true;
    } else if (S.attentionScore < 0.36) {
      S.userLookingAtCompanion = false;
      S.lookSince = 0;
    }
    applyCompanionDof(win);
    tickEyesAlive(win);
    win.hqCompanionUserLooking = () => !!S.userLookingAtCompanion;
    win.hqCompanionAttention = () => S.attentionScore || 0;
  }

  function watchCompanionAttention(win) {
    if (calm(win)) return;
    // motion1: skip the attention poll while the tab is hidden; catch up as soon as it is visible again.
    const tick = () => { if (!win.document.hidden) syncCompanionAttention(win); };
    win.setInterval(tick, isCompactUI(win) ? 340 : 200);
    win.document.addEventListener("visibilitychange", () => { if (!win.document.hidden) tick(); });
    let scrollT = 0;
    let lastScroll = null;
    win.addEventListener(
      "scroll",
      (ev) => {
        win.clearTimeout(scrollT);
        scrollT = win.setTimeout(tick, 140);
        // Gesture inertia: a fast page scroll jolts her bust in proportion to its speed.
        if (!S.nsfwOn || !S.el || !S.el.classList.contains("has-layered-portrait")) return;
        const target = ev.target && ev.target.scrollTop !== undefined ? ev.target : win.document.scrollingElement;
        const y = target === win.document ? win.scrollY : target.scrollTop;
        const now = win.performance.now();
        if (lastScroll && lastScroll.el === target && now - lastScroll.t < 120) {
          const v = (y - lastScroll.y) / Math.max(8, now - lastScroll.t);
          if (Math.abs(v) > 0.6 && now - (S.scrollKickAt || 0) > 160) {
            S.scrollKickAt = now;
            kickBustSoftTissue(ensureLive2DState(), 0, clampNum(-v * 9, -55, 55));
          }
        }
        lastScroll = { el: target, y: y, t: now };
      },
      { passive: true, capture: true }
    );
    win.addEventListener("resize", tick, { passive: true });
    if (typeof win.IntersectionObserver === "function") {
      const io = new win.IntersectionObserver(
        (entries) => {
          const e = entries[0];
          if (e) S.attentionVisibleRatio = e.intersectionRatio;
          tick();
        },
        { threshold: [0, 0.2, 0.45, 0.7, 1] }
      );
      S.attentionIo = io;
      const attachIo = () => {
        const av = S.avatar || (S.el && S.el.querySelector(".hq-companion-avatar"));
        if (av) io.observe(av);
      };
      attachIo();
      win.setTimeout(attachIo, 1200);
    }
    tick();
  }

  function syncVisibility() {
    if (!S.el) return;
    const view = S.win.document.body.dataset.view || "accueil";
    if (view === "intime") {
      if (!S.sessionAdmin) {
        S.el.hidden = true;
        return;
      }
      const persona = readPersona(S.win);
      const on = !S.blocked && readOn(S.win) && persona !== "off" && !muted(S.win);
      S.el.hidden = !on;
      if (on) {
        S.el.classList.remove("is-minimal");
        S.el.classList.toggle("is-expanded", S.expanded);
        S.el.classList.toggle("is-compact", isCompactUI(S.win));
        S.el.classList.toggle("is-desktop", !isCompactUI(S.win));
        applyCompanionDof(S.win);
      }
      return;
    }
    const persona = readPersona(S.win);
    const on = !S.blocked && readOn(S.win) && persona !== "off" && !muted(S.win);
    const aiOpen = S.win.document.body.classList.contains("hq-ai-open");
    S.el.hidden = !on;
    if (!on) return;
    const compact = isCompactUI(S.win);
    const minimal = S.collapsed && !aiOpen && !S.expanded;
    S.el.classList.toggle("is-minimal", minimal);
    S.el.classList.toggle("is-compact", compact);
    S.el.classList.toggle("is-desktop", !compact);
    applyCompanionDof(S.win);
  }

  function applyMood(win, kind) {
    if (!S.el || calm(win)) return;
    S.el.classList.remove("is-mood-celebrate", "is-mood-error", "is-mood-afterglow");
    if (kind === "celebrate") S.el.classList.add("is-mood-celebrate");
    else if (kind === "error") S.el.classList.add("is-mood-error");
    else if (kind === "afterglow") S.el.classList.add("is-mood-afterglow");
    syncAdultPortrait();
    if (kind === "celebrate") onAdultMoodFx(win);
    if (kind) {
      win.clearTimeout(S.moodT);
      S.moodT = win.setTimeout(() => {
        if (S.el) {
          S.el.classList.remove("is-mood-celebrate", "is-mood-error", "is-mood-afterglow");
          syncAdultPortrait();
        }
      }, 1400);
    }
  }

  function syncViewAccent(win, view) {
    if (!S.el) return;
    S.el.classList.toggle("is-accent-forge", view === "forge");
    S.el.classList.toggle("is-accent-lecteur", view === "lecteur");
    if (view === "forge") scheduleIdleForgeSpark(win);
    syncIdleContinuousStates(win);
  }

  function viewNudge(win, fromView, toView) {
    if (calm(win) || isCompactUI(win) || !S.el || toView === "intime" || S.intimeMode) return;
    navGlanceCompanion(win, toView);
    const av = S.el.querySelector(".hq-companion-avatar");
    const nav = win.document.querySelector('.bottom-nav button[data-nav="' + toView + '"]');
    if (!av || !nav) return;
    const rn = nav.getBoundingClientRect();
    const ra = av.getBoundingClientRect();
    const dx = (rn.left + rn.width / 2 - (ra.left + ra.width / 2)) * 0.12;
    av.style.setProperty("--nudge-x", Math.max(-18, Math.min(18, dx)) + "px");
    av.classList.remove("is-nudge");
    void av.offsetWidth;
    av.classList.add("is-nudge");
  }

  function typewriterLine(win, el, text, done) {
    const t = String(text || "").trim();
    if (!el) {
      if (done) done();
      return;
    }
    S.mouthRig?.endTextSpeech(el.__hqPace);
    const run = (el.__hqPace = {});
    if (calm(win) || S.collapsed) {
      el.textContent = t;
      if (done) done();
      return;
    }
    const words = paceWords(t);
    const pronunciation = S.pronunciationPlans?.get(t);
    if (words.length) S.mouthRig?.prepareSpeech(words[0].t, run, pronunciation?.[0]?.visemes,
      !!S.lastOrbWarm || /[♥♡❤😊😉😄😂🙂]/u.test(t), /[😂🤣😆]|\b(?:haha\w*|hihi|hehe|lol|mdr)\b/iu.test(t));
    el.textContent = "";
    let i = 0;
    const tick = () => {
      if (el.__hqPace !== run || !el.isConnected) {
        S.mouthRig?.endTextSpeech(run);
        return;
      }
      if (i >= words.length) {
        S.mouthRig?.endTextSpeech(run, true);
        el.textContent = t;
        if (done) done();
        return;
      }
      el.textContent += words[i].t;
      if (el.closest(".hq-companion-log")) followChatTail();
      const d = S.mouthRig?.textWord(words[i].t, words[i].d, run, pronunciation?.[i]?.visemes) || words[i].d;
      i += 1;
      if (i % 5 === 0) nudgeBubbleWeight(win, 0.45);
      win.setTimeout(tick, d);
    };
    win.setTimeout(tick, 120);
  }

  // She perks up a little when she starts to speak (scale, so it adds to the bob instead of interrupting it).
  function perk(win) {
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!av || calm(win)) return;
    av.classList.add("is-perk");
    win.setTimeout(() => av.classList.remove("is-perk"), 200);
  }

  function setLineAnimated(win, text) {
    S.lineFullText = String(text || "").trim();
    if (!S.line) return;
    perk(win);
    nudgeBubbleWeight(win, 1);
    if (S.bubble) S.bubble.classList.add("is-morph");
    typewriterLine(win, S.line, text, () => {
      if (S.bubble) {
        S.bubble.classList.remove("is-morph");
        if (!calm(win) && !S.collapsed) {
          S.bubble.classList.add("is-ripple");
          win.setTimeout(() => S.bubble && S.bubble.classList.remove("is-ripple"), 650);
        }
      }
      syncAmbientLineDup();
    });
  }

  function pulseMemChip() {
    if (!S.memChip || calm(S.win)) return;
    S.memChip.classList.remove("is-compressed");
    void S.memChip.offsetWidth;
    S.memChip.classList.add("is-compressed");
  }

  function celebrateAtAvatar(win) {
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!av || calm(win)) return;
    if (typeof win.HqPolish !== "undefined" && win.HqPolish.successBurst) {
      try {
        win.HqPolish.successBurst(win, av);
        return;
      } catch (_) {}
    }
    applyMood(win, "celebrate");
    pulseCompanionMotion(win);
    if (!muted(win) && readForgeSound(win)) playNaturalVoiceCue(win, "toast_celebrate");
  }

  function syncListening(on) {
    if (!S.el) return;
    const was = S.el.classList.contains("hq-companion-listening");
    S.el.classList.toggle("hq-companion-listening", !!on);
    if (!!on !== was && S.win) perkUpForVoice(S.win, on);
  }

  function openAssistant(seed) {
    const view = S.win.document.body.dataset.view || "accueil";
    const q = seed || seedForView(view);
    if (typeof S.win.hqAiOpen === "function") S.win.hqAiOpen({ tab: "ask", seed: q });
  }

  function speakState(win, dig) {
    return {
      hidden: !!win.document.hidden,
      typingAt: S.typingAt,
      navTimes: S.navTimes,
      lastSpokeAt: S.lastAmbientAt,
      spoke: S.spoke,
      idleStreak: S.idleStreak,
      navOnly: navOnly(dig),
    };
  }

  // reason: manual (a tap), boot, view (settled on a page), event (true news), signal (a toast), idle (a long pause)
  async function refresh(force, reason) {
    reason = reason || (force ? "manual" : "view");
    if (!S.el || S.busy || S.chatBusy || S.blocked) return;
    const win = S.win;
    if (!readOn(win) || readPersona(win) === "off" || muted(win)) {
      syncVisibility();
      return;
    }
    if (win.document.body.classList.contains("hq-ai-open")) {
      syncVisibility();
      return;
    }
    if (S.collapsed && !S.expanded && !force && !hasPendingSignals() && reason !== "idle") {
      syncVisibility();
      return;
    }
    if (S.expanded && !force && !hasPendingSignals()) {
      syncVisibility();
      return;
    }
    const view = win.document.body.dataset.view || "accueil";
    const dig = digest(win);
    const verdict = decide(speakState(win, dig), Date.now(), reason);
    if (!verdict.ok) {
      if (verdict.retry) {
        win.clearTimeout(S.retryT);
        S.retryT = win.setTimeout(() => refresh(false, reason), verdict.retry);
      }
      syncVisibility();
      return;
    }
    const key = view + "\0" + dig.slice(0, 200);
    if ((reason === "view" || reason === "boot") && key === S.lastKey && S.line && S.line.textContent) return;
    S.lastKey = key;
    let persona = readPersona(win);
    if (S.cap === "warm" && persona === "flirt") persona = "warm";
    if (S.cap === "off") persona = "off";
    S.busy = true;
    syncListening(true);
    S.el.classList.add("hq-companion-busy");
    if (S.bubble) S.bubble.classList.add("is-typing");
    const ev = S.pendingEvent;
    try {
      const st = await fetchJson(win, aiGetUrl(win));
      applyNsfwStatus(st);
      syncNsfwUI();
      if (st && st.companion_cap) {
        S.cap = st.companion_cap;
        const personaSel = win.document.getElementById("hq-companion-persona");
        if (personaSel && st.companion_cap === "warm") {
          personaSel.querySelector('option[value="flirt"]')?.setAttribute("hidden", "hidden");
          if (readPersona(win) === "flirt") {
            try {
              win.localStorage.setItem(LS_PERSONA, "warm");
            } catch (_) {}
            personaSel.value = "warm";
          }
        }
      }
      const hadCelebrate = S.pendingCelebrateMsg;
      const hadError = S.pendingErrorMsg;
      const hadAfterglow = S.pendingAfterglow;
      const out = await callAmbient(win, view, dig, persona);
      if (out.skipped) return;
      if (ev && S.pendingEvent === ev) {
        S.lastEventId = ev.id;
        S.pendingEvent = null;
      }
      if (out.mood) applyOrbMood(out.mood);
      applyCharacterExpression(win, out.expression);
      setLineAnimated(win, out.line || "…");
      blink(win);
      if (!S.voicePreview) speak(win, out.line || "", null, out.context_usage && out.context_usage.conversation_mode,
        out.expression && out.expression.voice !== "neutral" ? out.expression.voice : undefined);
      if (hadCelebrate && S.prefs.celebrate !== false) celebrateAtAvatar(win);
      else if (hadError) applyMood(win, "error");
      else if (hadAfterglow) applyMood(win, "afterglow");
      if (S.collapsed && !S.expanded && S.el) {
        S.el.classList.add("has-hint");
      }
      const now = Date.now();
      S.lastAmbientAt = now;
      S.spoke = S.spoke.filter((t) => now - t < 20 * 60000).concat(now);
      if (reason === "idle") S.idleStreak += 1;
      if (S.messages.length) syncMemChip();
      if (S.bubble && !calm(win) && !S.collapsed) {
        S.bubble.classList.remove("is-in", "is-typing");
        void S.bubble.offsetWidth;
        S.bubble.classList.add("is-in", "is-new");
        nudgeBubbleWeight(win, 1.15);
        win.setTimeout(() => S.bubble && S.bubble.classList.remove("is-new"), 700);
      }
    } catch (e) {
      if (e && (e.status === 403 || e.status === 401)) {
        S.blocked = true;
        S.el.hidden = true;
        return;
      }
      setLine("Je reste là — ouvre l'assistant si tu veux en parler.");
    } finally {
      S.busy = false;
      syncListening(S.chatBusy);
      S.el.classList.remove("hq-companion-busy");
      if (S.bubble) S.bubble.classList.remove("is-typing");
      syncVisibility();
      syncNsfwUI();
    }
  }

  // ---- life: the pulse (true events + the day's mood, no model call), the orb, the voice

  async function pulse(win) {
    if (win.document.hidden || win.document.body.classList.contains("hq-ai-open") || S.blocked || !readOn(win) || readPersona(win) === "off" || muted(win) || (S.collapsed && !S.expanded)) return;
    try {
      const out = await fetchJson(win, "/api/ai", withDevice(win, { action: "pulse", view: win.document.body.dataset.view || "accueil" }));
      if (out && out.mood) applyOrbMood(out.mood);
      const ev = out && out.event;
      if (ev && ev.id && ev.id !== S.lastEventId) {
        if (!(S.pendingEvent && S.pendingEvent.id === ev.id)) S.pendingEvent = { id: String(ev.id), kind: String(ev.kind || "") };
        if (S.el) S.el.classList.add("has-hint");
        pulseCompanionMotion(win);
        refresh(false, "event");
        return;
      }
      const now = Date.now();
      if (!S.pendingEvent && S.lastActAt && now - S.lastActAt > 3 * 60000) refresh(false, "idle");
    } catch (_) {}
  }

  function applyOrbMood(m) {
    if (!S.el) return;
    const prevWarm = S.lastOrbWarm;
    S.orbMood = m && typeof m === "object" ? m : null;
    const v = orbVars(m);
    S.el.style.setProperty("--breath", v.breath);
    S.el.style.setProperty("--warm", v.warm);
    const wPct = typeof S.warmth === "number" ? S.warmth : Math.round(Number(v.warm) * 100);
    S.el.style.setProperty("--companion-warm", clampNum(wPct / 100, 0, 1).toFixed(3));
    S.el.classList.toggle("is-soft", v.soft);
    S.lastOrbWarm = Number(m && m.warm) >= 0.55;
    syncAdultPortrait();
    if (S.nsfwOn && S.lastOrbWarm && !prevWarm) onAdultMoodFx(S.win);
  }

  function pickAdultPortraitKey() {
    if (!S.el) return "neutral";
    if (S.el.classList.contains("is-mood-celebrate")) return "celebrate";
    if (S.el.classList.contains("is-mood-error")) return "tender";
    if (S.el.classList.contains("is-mood-afterglow")) return "soft";
    const m = S.orbMood || {};
    const soft = Number(m.soft) || 0;
    const warm = Number(m.warm) || 0;
    const why = String(m.why || "");
    if (why === "error") return "tender";
    if (why === "win") return "celebrate";
    if (why === "return") return "warm";
    if (warm >= 0.55) return "warm";
    if (soft >= 0.5) return "soft";
    return "neutral";
  }

  function readLayeredPortrait(win) {
    try {
      const v = win.localStorage.getItem(LS_LAYERED_PORTRAIT);
      if (v === "0") return false;
      if (v === "1") return true;
      // Default to layered portrait across both desktop and mobile/iPhone for independent 3D bust units.
      return true;
    } catch (_) {
      return true;
    }
  }

  function layeredTouchPullReach(win, layered) {
    if (!layered) return 0.16;
    if (isCompactUI(win)) return 0.44;
    return 0.74;
  }

  function syncAdultPortrait() {
    if (!S.adultPortrait || !S.el || !S.el.classList.contains("is-nsfw")) return;
    if (S.el.classList.contains("is-nsfw-fx-rhythm") || S.el.classList.contains("is-booty-tease")) return;
    if (readLayeredPortrait(S.win)) {
      setAdultPortraitSrc(S.win, LAYERED_PORTRAIT, "neutral");
      return;
    }
    const av = S.el.querySelector(".hq-companion-avatar");
    const outfit = av && av.getAttribute("data-outfit");
    if (outfit === "ecstasy") {
      const ecstasySrc = ADULT_PORTRAITS.celebrate || ADULT_PORTRAITS.warm || ADULT_PORTRAITS.neutral;
      setAdultPortraitSrc(S.win, ecstasySrc, "celebrate");
      return;
    }
    if (outfit === "lingerie") {
      const warmSrc = ADULT_PORTRAITS.warm || ADULT_PORTRAITS.neutral;
      setAdultPortraitSrc(S.win, warmSrc, "warm");
      return;
    }
    try {
      const last = S.win.localStorage.getItem(LS_LAST_PORTRAIT_HREF);
      if (last && last.indexOf("/assets/companion/") === 0) {
        if (!last.includes("rhythm")) {
          setAdultPortraitSrc(S.win, last, "");
          return;
        } else {
          try { S.win.localStorage.removeItem(LS_LAST_PORTRAIT_HREF); } catch (_) {}
        }
      }
      const defHref = adultPortraitFallbackHref(S.win);
      if (!S.win.localStorage.getItem(LS_LAST_PORTRAIT_HREF)) {
        setAdultPortraitSrc(S.win, defHref, "warm");
        return;
      }
    } catch (_) {}
    const key = pickAdultPortraitKey();
    const src = ADULT_PORTRAITS[key] || ADULT_PORTRAITS.neutral;
    setAdultPortraitSrc(S.win, src, key);
  }

  function preloadAdultPortraits(win) {
    if (S.preloadedPortraits) return;
    S.preloadedPortraits = true;
    Object.keys(ADULT_PORTRAITS).forEach((k) => {
      const im = new win.Image();
      im.src = ADULT_PORTRAITS[k];
    });
    const rim = new win.Image();
    rim.src = ADULT_RHYTHM_PORTRAIT;
  }

  function adultPortraitFallbackHref(win) {
    const def =
      (S.forgeUiDefaults && S.forgeUiDefaults.default_adult_portrait) || "transferania-adult-neutral.jpg";
    return "/assets/companion/" + def;
  }

  const ADULT_PORTRAIT_LOAD_FALLBACKS = [
    "/assets/companion/transferania-adult-neutral.jpg",
    "/assets/companion/transferania-adult-soft.jpg",
    "/assets/companion/transferania-adult-warm.jpg",
    "/assets/companion/transferania-adult-tender.jpg",
  ];

  function onAdultPortraitLoadError(win) {
    if (!S.adultPortrait) return;
    let last = "";
    try {
      last = win.localStorage.getItem(LS_LAST_PORTRAIT_HREF) || "";
    } catch (_) {}
    const curPath = portraitPathOnly(win, S.adultPortrait.currentSrc || S.adultPortrait.src || "");
    const lastPath = portraitPathOnly(win, last);
    if (lastPath && curPath === lastPath) {
      try {
        win.localStorage.removeItem(LS_LAST_PORTRAIT_HREF);
      } catch (_) {}
    }
    let idx = -1;
    for (let i = 0; i < ADULT_PORTRAIT_LOAD_FALLBACKS.length; i += 1) {
      if (portraitPathOnly(win, ADULT_PORTRAIT_LOAD_FALLBACKS[i]) === curPath) idx = i;
    }
    const next = ADULT_PORTRAIT_LOAD_FALLBACKS[Math.min(idx + 1, ADULT_PORTRAIT_LOAD_FALLBACKS.length - 1)];
    if (idx >= ADULT_PORTRAIT_LOAD_FALLBACKS.length - 1) return;
    setAdultPortraitSrc(win, next, idx < 0 ? "neutral" : ["neutral", "soft", "warm", "tender"][idx + 1] || "neutral");
    if (S.l2dAvatarRig && S.l2dAvatarRig.syncLayers) S.l2dAvatarRig.syncLayers();
  }

  function createAdultPortraitImg(doc) {
    const img = doc.createElement("img");
    img.className = "hq-companion-face-adult";
    img.alt = "";
    img.decoding = "async";
    img.loading = "eager";
    img.setAttribute("aria-hidden", "true");
    img.dataset.mood = "neutral";
    img.src = ADULT_PORTRAITS.neutral;
    return img;
  }

  function adultFxAllowed(win) {
    if (!S.el || !S.nsfwOn || calm(win)) return false;
    if (S.el.classList.contains("is-minimal")) return false;
    if (S.el.classList.contains("is-nsfw-switch-on") || S.el.classList.contains("is-nsfw-switch-off")) return false;
    if (S.el.classList.contains("hq-companion-busy") || S.el.classList.contains("hq-companion-listening")) return false;
    try {
      if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    } catch (_) {}
    return true;
  }

  function restoreAdultRhythmScene() {
    clearAdultRhythmTimers(S.win);
    S.isFinishingClimax = false;
    if (S.adultPortrait) {
      let targetSrc = (S.rhythmRestore && S.rhythmRestore.src) || ADULT_PORTRAITS.neutral;
      if (targetSrc && targetSrc.includes("rhythm")) {
        targetSrc = ADULT_PORTRAITS.neutral;
      }
      const targetMood = (S.rhythmRestore && S.rhythmRestore.mood && S.rhythmRestore.mood !== "rhythm") ? S.rhythmRestore.mood : "neutral";
      S.adultPortrait.classList.remove("is-rhythm-mouth-open");
      S.adultPortrait.src = targetSrc;
      S.adultPortrait.dataset.mood = targetMood;
      if (S.rhythmRestore && S.rhythmRestore.op) S.adultPortrait.style.objectPosition = S.rhythmRestore.op;
      else S.adultPortrait.style.removeProperty("object-position");
      S.rhythmRestore = null;
    }
    if (S.adultShaft) {
      S.adultShaft.hidden = true;
      S.adultShaft.classList.remove("is-shaft-climax-throbbing", "is-rhythm-shaft-recoil", "is-shaft-manual-drag");
      S.adultShaft.style.transform = "";
      S.adultShaft.style.removeProperty("--shaft-climax-y");
    }
    if (S.adultShaftTrack) S.adultShaftTrack.hidden = true;
    if (S.throatBulge) {
      S.throatBulge.style.opacity = "";
      S.throatBulge.style.transform = "";
    }
    if (S.oralSeal) S.oralSeal.style.transform = "";
    if (S.lipUpper) S.lipUpper.style.transform = "";
    S.rhythmHeat = 0;
    if (S.heatCircleVal) S.heatCircleVal.style.strokeDashoffset = "295";
    syncAdultPortrait();
  }

  function restoreAdultLoopPortrait() {
    if (!S.adultLoopRestore || !S.adultPortrait) return;
    S.adultPortrait.src = S.adultLoopRestore.src;
    S.adultPortrait.dataset.mood = S.adultLoopRestore.mood;
    if (S.adultLoopRestore.op) S.adultPortrait.style.objectPosition = S.adultLoopRestore.op;
    else S.adultPortrait.style.removeProperty("object-position");
    if (S.largePortraitImg) {
      S.largePortraitImg.src = S.adultLoopRestore.src;
      if (S.adultLoopRestore.op) S.largePortraitImg.style.objectPosition = S.adultLoopRestore.op;
      else S.largePortraitImg.style.removeProperty("object-position");
    }
    S.adultLoopRestore = null;
  }

  function clearAdultLoopFx(win) {
    if (!S.el) return;
    S.el.classList.remove("is-nsfw-fx-loop", "is-nsfw-loop-tease-sway", "is-nsfw-loop-tease-glow", "is-nsfw-loop-tease-ken", "is-nsfw-loop-tease-arch", "is-nsfw-loop-tease-booty", "is-booty-tease");
    restoreAdultLoopPortrait();
    if (S.adultFxTimers && S.adultFxTimers.loop) {
      win.clearTimeout(S.adultFxTimers.loop);
      delete S.adultFxTimers.loop;
    }
  }

  function restoreBootyTeaseScene(win) {
    if (!S.el) return;
    S.el.classList.remove("is-booty-tease", "is-nsfw-loop-tease-arch", "is-nsfw-loop-tease-booty", "is-nsfw-fx-loop");
    restoreAdultLoopPortrait();
    syncAdultPortrait();
  }

  function playBootyTease(win, poseKey, durationMs, withAiReaction) {
    if (!adultFxAllowed(win)) return;
    playLewdPhaseWav(win, "booty_arch");
    const key = poseKey && ADULT_BOOTY_POSES[poseKey] ? poseKey : (Math.random() > 0.5 ? "all-fours-side" : "all-fours-broom");
    const href = ADULT_BOOTY_POSES[key] || ADULT_BOOTY_POSES["all-fours-side"];
    const ms = durationMs || 4600;
    clearAdultLoopFx(win);
    if (S.adultPortrait) {
      if (!S.adultLoopRestore) {
        S.adultLoopRestore = { src: S.adultPortrait.src, mood: S.adultPortrait.dataset.mood || "neutral", op: S.adultPortrait.style.objectPosition || "" };
      }
      S.adultPortrait.src = href;
      S.adultPortrait.style.objectPosition = "center 68%";
      if (S.largePortraitImg) {
        S.largePortraitImg.src = href;
        S.largePortraitImg.style.objectPosition = "center 68%";
      }
    }
    S.el.classList.add("is-nsfw-fx-loop", "is-booty-tease", "is-nsfw-loop-tease-booty");
    playVocalSynthFx(win, "gasp");
    addArousalWarmth(win, 18, "fessier cambré et booty shake 🍑");
    const targetAv = S.el.querySelector(".hq-companion-avatar");
    if (targetAv) {
      ["🍑", "🔥", "♥", "🍑"].forEach((sym, i) => {
        win.setTimeout(() => spawnCuteHeart(win, targetAv, sym), i * 110);
      });
    }
    if (withAiReaction) {
      triggerInteractiveAiReaction(
        win,
        "Tu te retournes sur {view}, tu te cambres à quatre pattes et tu ondules lentement de ton fessier galbé devant les yeux de Marco (🍑 Booty tease animé)",
        [
          "Mmh… regarde comme je me cambre pour toi, Maître… mes fesses n'attendent que tes mains sur {view} 🍑🔥♥",
          "Tu aimes cette vue de dos, mon amour ? Dis-moi si tu as envie de poser ta main dessus… 🍑♥",
          "Je m'offre à tes yeux… admiring my booty, Maître ? Viens me donner une fessée pour voir 🍑🔥"
        ]
      );
    }
    if (!S.adultFxTimers) S.adultFxTimers = {};
    S.adultFxTimers.loop = win.setTimeout(() => {
      restoreBootyTeaseScene(win);
    }, ms);
  }

  function endAdultFx(win, kind) {
    if (!S.el) return;
    S.el.classList.remove("is-nsfw-fx-" + kind);
    if (kind === "burst") S.el.querySelectorAll(".hq-companion-adult-burst-bit").forEach((n) => n.remove());
    if (kind === "rhythm") {
      S.el.style.removeProperty("--rhythm-period");
      S.el.querySelectorAll(".hq-companion-adult-spurt-bit").forEach((n) => n.remove());
      restoreAdultRhythmScene();
    }
    if (S.adultFxTimers) delete S.adultFxTimers[kind];
  }

  function spawnCuteHeart(win, el, customEmoji) {
    if (!el || !win.document) return;
    const host = (S.el && S.el.querySelector(".hq-companion-av-row")) || el.parentElement || win.document.body;
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const heart = win.document.createElement("span");
    heart.className = "hq-companion-cute-heart";
    heart.textContent = customEmoji || (Math.random() > 0.3 ? "♥" : "✨");
    const cx = r.left + r.width / 2 - hr.left;
    const cy = r.top + r.height * 0.35 - hr.top;
    heart.style.left = (cx + (Math.random() * 34 - 17) - 8) + "px";
    heart.style.top = (cy - 8) + "px";
    heart.style.setProperty("--hx", (Math.random() * 44 - 22) + "px");
    heart.style.setProperty("--hrot", (Math.random() * 44 - 22) + "deg");
    host.appendChild(heart);
    win.setTimeout(() => heart.remove(), 1150);
  }

  function spawnZzzParticle(win, el) {
    if (!el || !win.document) return;
    const host = (S.el && S.el.querySelector(".hq-companion-av-row")) || el.parentElement || win.document.body;
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const zzz = win.document.createElement("span");
    zzz.className = "hq-companion-zzz-bit";
    const labels = ["Zzz…", "zZz ♥", "✧ zzz"];
    zzz.textContent = labels[Math.floor(Math.random() * labels.length)];
    zzz.style.left = (r.left + r.width * 0.65 - hr.left + (Math.random() * 10 - 5)) + "px";
    zzz.style.top = (r.top + r.height * 0.15 - hr.top) + "px";
    host.appendChild(zzz);
    win.setTimeout(() => zzz.remove(), 2450);
  }

  function playHeartbeatThump(win, pitchScale) {
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const reactionTone = beginCompanionReactionBus(ctx, now);
      const playBeat = (offset, freq, gainVal) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq * (pitchScale || 1), now + offset);
        osc.frequency.exponentialRampToValueAtTime(32, now + offset + 0.11);
        gain.gain.setValueAtTime(0.001, now + offset);
        gain.gain.linearRampToValueAtTime(gainVal, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.12);
        osc.connect(gain);
        connectCompanionReactionOut(gain, reactionTone, ctx);
        osc.start(now + offset);
        osc.stop(now + offset + 0.13);
      };
      // Lub-dub double thump
      playBeat(0, 68, 0.18);
      playBeat(0.14, 56, 0.12);
    } catch (_) {}
  }

  // Breath shapes laid over her normal breathing: a gasp is a sharp inhale held a moment, a sigh a
  // slow rise then a long drop. Returns the breath wave (-1..1, can overshoot) for this frame.
  // A short inhale before a scripted reaction. Returns the delay in ms, or 0 when
  // motion should stay immediate (calm, reduced motion). Never use this to delay a hit.
  function beginReactionWindup(win) {
    if (!win || calm(win)) return 0;
    let reduced = false;
    try { reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
    if (reduced) return 0;
    const st = ensureLive2DState();
    st.windupUntil = win.performance.now() + 130;
    st.windupLift = -0.9;
    return 95 + Math.round(Math.random() * 40);
  }

  function shapeBreathEvent(wave, nowMs) {
    const ev = S.breathEvent;
    if (!ev) return wave;
    const t = nowMs - ev.t0;
    const ease = (x) => 1 - Math.pow(1 - clampNum(x, 0, 1), 3);
    let target;
    let weight;
    if (ev.kind === "gasp") {
      if (t > 1300) {
        S.breathEvent = null;
        return wave;
      }
      target = t < 180 ? 1.5 * ease(t / 180) : 1.25 + Math.sin(t * 0.06) * 0.04;
      weight = t < 800 ? 1 : 1 - (t - 800) / 500;
    } else {
      if (t > 2300) {
        S.breathEvent = null;
        return wave;
      }
      target = t < 320 ? ease(t / 320) : 1 - 2.4 * ease((t - 320) / 1400);
      weight = t < 1800 ? 1 : 1 - (t - 1800) / 500;
    }
    return wave * (1 - weight) + target * weight;
  }

  function companionReactionTone(ctx, now, profile) {
    if (!ctx || !ctx.createBiquadFilter) return null;
    const t = now != null ? now : ctx.currentTime;
    const soft = profile === "soft";
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.setValueAtTime((soft ? 980 : 2100) + Math.random() * (soft ? 180 : 350), t);
    tone.Q.setValueAtTime(soft ? 0.35 : 0.55, t);
    return tone;
  }

  function ensureCompanionSfxBus(ctx) {
    if (!ctx) return null;
    const host = S.win;
    if (!host?.HqCompanionSfxBus) return null;
    if (!S.sfxBus || S.sfxBusCtx !== ctx) {
      S.sfxBusCtx = ctx;
      S.sfxBus = host.HqCompanionSfxBus.create(ctx);
    }
    return S.sfxBus;
  }

  function updateCompanionSfxDuck(win) {
    if (!win) return;
    const bus = ensureCompanionSfxBus(S.audioCtx);
    if (!bus) return;
    const speech = !!(S.currentAudio || S.voicePreview ||
      S.el?.classList.contains("is-speaking") || S.el?.classList.contains("is-voice-lipsync"));
    const media = !!S.el?.classList.contains("is-music-grooving");
    bus.setDuck(speech ? 0.48 : media ? 0.64 : 1);
  }

  function canRouteSpeechThroughBus(win, url) {
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC || calm(win)) return false;
      return new win.URL(String(url || ""), win.location.href).origin === win.location.origin;
    } catch (_) {
      return false;
    }
  }

  function speechPlaybackGainDb(url) {
    const fromManifest = S.reactionAudio?.playbackGainDbForUrl?.(url);
    if (Number.isFinite(fromManifest)) return fromManifest;
    if (String(url || "").includes("/lewd_wav_bank/")) {
      const phase = Number(S.reactionAudio?.phaseGainDb?.());
      return Number.isFinite(phase) ? phase : -1.5;
    }
    const voice = Number(S.reactionAudio?.voiceGainDb?.());
    return Number.isFinite(voice) ? voice : 0;
  }

  function stopSpeechWebVoice(win, immediate) {
    const entry = S.speechWebVoice;
    if (!entry) return;
    S.speechWebVoice = null;
    const ctx = S.audioCtx;
    const now = ctx?.currentTime ?? 0;
    const finish = () => {
      try { entry.source.disconnect(); } catch (_) {}
      try { entry.gain.disconnect(); } catch (_) {}
      try { entry.audio.pause(); } catch (_) {}
    };
    if (immediate || !ctx || !entry.gain?.gain) {
      finish();
      return;
    }
    try {
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(0.001, now + 0.08);
      win.setTimeout(finish, 90);
    } catch (_) {
      finish();
    }
  }

  function wireSpeechMediaToBus(win, audio, url) {
    if (!audio || S.speechWebVoice?.audio === audio) return;
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!AC) return;
    if (!S.audioCtx) S.audioCtx = new AC();
    const ctx = S.audioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    ensureCompanionSfxBus(ctx);
    const source = ctx.createMediaElementSource(audio);
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const vol = 10 ** (speechPlaybackGainDb(url) / 20);
    g.gain.setValueAtTime(vol, t);
    source.connect(g);
    connectCompanionReactionOut(g, null, ctx);
    S.speechWebVoice = { source, gain: g, audio };
  }

  function playImpactBodyThud(ctx, when, strength) {
    if (!ctx || !ctx.createOscillator) return;
    try {
      const bus = ensureCompanionSfxBus(ctx);
      const str = clampNum(Number(strength) || 0.45, 0, 1);
      const vol = 0.04 + str * 0.05;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(92, when);
      osc.frequency.exponentialRampToValueAtTime(44, when + 0.07);
      g.gain.setValueAtTime(0.001, when);
      g.gain.linearRampToValueAtTime(vol, when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.13);
      osc.connect(g);
      if (bus) bus.connectImpact(g);
      else g.connect(ctx.destination);
      osc.start(when);
      osc.stop(when + 0.14);
    } catch (_) {}
  }

  function beginCompanionReactionBus(ctx, now, profile) {
    ensureCompanionSfxBus(ctx);
    return null;
  }

  function connectCompanionReactionOut(gainNode, _tone, ctx) {
    if (!gainNode) return;
    const audioCtx = ctx || gainNode.context || S.audioCtx;
    const bus = ensureCompanionSfxBus(audioCtx);
    if (bus) bus.connectVoice(gainNode);
    else if (audioCtx) gainNode.connect(audioCtx.destination);
  }

  function connectCompanionImpactOut(gainNode, ctx) {
    if (!gainNode) return;
    const audioCtx = ctx || gainNode.context || S.audioCtx;
    const bus = ensureCompanionSfxBus(audioCtx);
    if (bus) bus.connectImpact(gainNode);
    else if (audioCtx) gainNode.connect(audioCtx.destination);
  }

  function ensureBustSlapBuffer(win, ctx, url) {
    if (!url) return Promise.resolve(null);
    primeCompanionAudioContext(win);
    const decodeCtx = ctx || S.audioCtx;
    if (!decodeCtx) return Promise.resolve(null);
    if (!S.bustSlapBuffers) S.bustSlapBuffers = {};
    if (S.bustSlapDecodeCtx !== decodeCtx) {
      S.bustSlapBuffers = {};
      S.bustSlapDecodeCtx = decodeCtx;
    }
    const cached = S.bustSlapBuffers[url];
    if (cached && typeof cached !== "function") return Promise.resolve(cached);
    if (cached) return cached;
    const load = win.fetch(url)
      .then(res => { if (!res.ok) throw new Error("impact missing"); return res.arrayBuffer(); })
      .then(ab => decodeCtx.decodeAudioData(ab))
      .then(buffer => { S.bustSlapBuffers[url] = buffer; return buffer; })
      .catch(() => { delete S.bustSlapBuffers[url]; return null; });
    S.bustSlapBuffers[url] = load;
    return load;
  }

  const TIT_PULL_ELASTIC_RE = /else_tit_pull_(01|07)\./i;
  const TIT_PULL_SLOSH_RE = /else_tit_pull_(10|13)\./i;
  const TIT_PULL_LOOP_RE = /else_tit_pull_02\./i;

  function titPullStemPool(pool, kind, stemId) {
    if (!pool?.length) return pool;
    const urls = pool.map(String);
    if (stemId) {
      const stem = String(stemId).padStart(2, "0");
      const one = urls.filter(u => new RegExp(`else_tit_pull_${stem}\\.`, "i").test(u));
      if (one.length) return one;
    }
    if (kind === "slosh") {
      const slosh = urls.filter(u => TIT_PULL_SLOSH_RE.test(u));
      return slosh.length ? slosh : pool;
    }
    if (kind === "elastic") {
      const elastic = urls.filter(u => TIT_PULL_ELASTIC_RE.test(u));
      return elastic.length ? elastic : pool;
    }
    return pool;
  }

  function ensureTitPullUndertoneBuf(ctx) {
    if (S.titPullUndertoneBuf && S.titPullUndertoneRate === ctx.sampleRate) return S.titPullUndertoneBuf;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * 2.5);
    const buf = ctx.createBuffer(1, len, rate);
    const ch = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      ch[i] = (b0 + b1 + b2) * 0.09;
    }
    S.titPullUndertoneBuf = buf;
    S.titPullUndertoneRate = rate;
    return buf;
  }

  function startTitPullLoopUndertone(loop, at) {
    const ctx = loop.ctx;
    if (!ctx) return;
    const buf = ensureTitPullUndertoneBuf(ctx);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 780;
    bp.Q.value = 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1850;
    const g = ctx.createGain();
    const target = Math.max(0.0001, loop.baseVol * 0.09);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(target, at + 0.42);
    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    connectCompanionReactionOut(g, null, ctx);
    src.start(at);
    loop.undertone = { source: src, gain: g, bp, lp };
  }

  function titPullLoopUrl(win) {
    const pool = manifestImpactUrls("tit_pull");
    return pool.find(u => TIT_PULL_LOOP_RE.test(String(u))) ||
      pool.find(u => TIT_PULL_ELASTIC_RE.test(String(u)));
  }

  function stopTitPullElasticLoop() {
    const loop = S.titPullLoop;
    S.titPullLoop = null;
    stopPullBreathBed();
    if (!loop) return;
    const stopVoice = (voice) => {
      if (!voice || !S.audioCtx) return;
      const now = S.audioCtx.currentTime;
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0, now, 0.04);
        voice.source.stop(now + 0.1);
      } catch (_) {}
      try {
        voice.source.disconnect();
        voice.hp.disconnect();
        if (voice.mud) voice.mud.disconnect();
        voice.lp.disconnect();
        voice.peak.disconnect();
        voice.gain.disconnect();
      } catch (_) {}
    };
    if (loop.undertone) {
      const ut = loop.undertone;
      try {
        if (S.audioCtx) {
          const now = S.audioCtx.currentTime;
          ut.gain.gain.cancelScheduledValues(now);
          ut.gain.gain.setTargetAtTime(0, now, 0.05);
          ut.source.stop(now + 0.12);
        } else ut.source.stop();
      } catch (_) {}
      try {
        ut.source.disconnect();
        ut.bp.disconnect();
        ut.lp.disconnect();
        ut.gain.disconnect();
      } catch (_) {}
    }
    stopVoice(loop.bed);
    for (const voice of loop.voices || []) stopVoice(voice);
  }

  /** Full buffer — long grain bed baked offline; native loop=true. */
  function titPullLoopRegionSafe(buf) {
    const dur = Number(buf?.duration) || 0;
    if (dur <= 0.05) return { start: 0, end: dur };
    return { start: 0, end: Math.max(0.04, dur - 0.00025) };
  }

  function connectTitPullLoopBed(ctx, buf, region, at, vol) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = region.start;
    src.loopEnd = region.end;
    src.playbackRate.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 105;
    hp.Q.value = 0.65;
    const mud = ctx.createBiquadFilter();
    mud.type = "peaking";
    mud.frequency.value = 340;
    mud.Q.value = 0.85;
    mud.gain.value = -1.8;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    lp.Q.value = 0.65;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = 2150;
    peak.Q.value = 0.75;
    peak.gain.value = 0.85;
    const g = ctx.createGain();
    const target = Math.max(0.0001, vol * 0.52);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(target, at + 0.1);
    src.connect(hp);
    hp.connect(mud);
    mud.connect(lp);
    lp.connect(peak);
    peak.connect(g);
    connectCompanionReactionOut(g, null, ctx);
    src.start(at, region.start);
    return { source: src, gain: g, hp, mud, lp, peak };
  }

  function warmTitPullImpactAudio(win) {
    if (!win || muted(win) || !readForgeSound(win)) return;
    const urls = manifestImpactUrls("tit_pull");
    if (!urls.length) return;
    primeCompanionAudioContext(win);
    if (!S.audioCtx) return;
    const ctx = S.audioCtx;
    for (const url of urls) void ensureBustSlapBuffer(win, ctx, url);
  }

  function titPullLoopAudioTension(tension) {
    const t = clampNum(Number(tension) || 0, 0, 1);
    return clampNum(t / 0.74, 0, 1);
  }

  function titPullLoopTensionShape(tension) {
    const t = titPullLoopAudioTension(tension);
    const onset = 0.12;
    if (t <= onset) return 0;
    const pull = clampNum((t - onset) / (1 - onset), 0, 1);
    return Math.pow(pull, 3.2);
  }

  function titPullLoopGain(tension) {
    const t = clampNum(Number(tension) || 0, 0, 1);
    const voiceDb = Number(S.reactionAudio?.voiceGainDb?.());
    const voiceMul = Number.isFinite(voiceDb) ? 10 ** (voiceDb / 20) : 1;
    const shaped = titPullLoopTensionShape(t);
    const whisper = 0.007;
    const ceiling = 0.082;
    return (whisper + shaped * (ceiling - whisper)) * voiceMul;
  }

  function ensurePullBreathNoiseBuf(ctx) {
    if (S.pullBreathNoiseBuf && S.pullBreathNoiseRate === ctx.sampleRate) return S.pullBreathNoiseBuf;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * 2.4));
    const buf = ctx.createBuffer(1, len, rate);
    const ch = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      ch[i] = (b0 + b1 + b2) * 0.11;
    }
    S.pullBreathNoiseBuf = buf;
    S.pullBreathNoiseRate = rate;
    return buf;
  }

  function pullBreathBedGain(tension) {
    const shaped = titPullLoopTensionShape(tension);
    if (shaped <= 0) return 0;
    const voiceDb = Number(S.reactionAudio?.voiceGainDb?.());
    const voiceMul = Number.isFinite(voiceDb) ? 10 ** (voiceDb / 20) : 1;
    return (0.0035 + shaped * 0.024) * voiceMul;
  }

  function stopPullBreathBed() {
    const bed = S.pullBreathBed;
    S.pullBreathBed = null;
    if (!bed || !S.audioCtx) return;
    const now = S.audioCtx.currentTime;
    try {
      bed.gain.gain.cancelScheduledValues(now);
      bed.gain.gain.setTargetAtTime(0.0001, now, 0.05);
      bed.lfo.stop(now + 0.14);
      bed.gainOffset.stop(now + 0.14);
      bed.source.stop(now + 0.16);
    } catch (_) {}
    try {
      bed.source.disconnect();
      bed.bp.disconnect();
      bed.lp.disconnect();
      bed.lfo.disconnect();
      bed.lfoDepth.disconnect();
      bed.gainOffset.disconnect();
      bed.gain.disconnect();
    } catch (_) {}
  }

  function startPullBreathBed(loop, at) {
    const ctx = loop.ctx;
    if (!ctx) return;
    stopPullBreathBed();
    const buf = ensurePullBreathNoiseBuf(ctx);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 420;
    bp.Q.value = 0.42;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1180;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.34 + Math.random() * 0.08;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.36;
    const g = ctx.createGain();
    const base = Math.max(0.0001, pullBreathBedGain(loop.baseTension ?? 0));
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(base, at + 0.55);
    const gainOffset = ctx.createConstantSource();
    gainOffset.offset.value = 1;
    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    gainOffset.connect(g.gain);
    lfo.connect(lfoDepth);
    lfoDepth.connect(g.gain);
    connectCompanionReactionOut(g, null, ctx);
    src.start(at);
    lfo.start(at);
    gainOffset.start(at);
    S.pullBreathBed = { source: src, bp, lp, lfo, lfoDepth, gainOffset, gain: g, ctx };
    loop.breath = S.pullBreathBed;
  }

  function updatePullBreathBedGain(tension) {
    const bed = S.pullBreathBed;
    if (!bed || !S.audioCtx || muted(S.win) || !readForgeSound(S.win)) return;
    const t = clampNum(Number(tension) || 0, 0, 1);
    const shaped = titPullLoopTensionShape(t);
    const target = shaped <= 0 ? 0.0001 : Math.max(0.0001, pullBreathBedGain(t));
    bed.gain.gain.setTargetAtTime(target, S.audioCtx.currentTime, shaped <= 0 ? 0.06 : 0.16 + (1 - shaped) * 0.08);
  }

  function updateTitPullElasticLoopGain(tension) {
    const loop = S.titPullLoop;
    if (!loop || !S.audioCtx || muted(loop.win || S.win) || !readForgeSound(loop.win || S.win)) return;
    const t = clampNum(Number(tension) || 0, 0, 1);
    const shaped = titPullLoopTensionShape(t);
    loop.baseVol = titPullLoopGain(t);
    const now = S.audioCtx.currentTime;
    const bedMul = 0.38 + shaped * 0.34;
    const underMul = 0.02 + shaped * 0.085;
    const smooth = 0.14 + (1 - shaped) * 0.1;
    if (loop.bed?.gain) {
      loop.bed.gain.gain.setTargetAtTime(Math.max(0.0001, loop.baseVol * bedMul), now, smooth);
    }
    if (loop.undertone?.gain) {
      loop.undertone.gain.gain.setTargetAtTime(Math.max(0.0001, loop.baseVol * underMul), now, smooth + 0.03);
    }
    updatePullBreathBedGain(t);
  }

  function startTitPullElasticLoop(win, tension) {
    if (!win || muted(win) || !readForgeSound(win) || calm(win)) return;
    if (!S.reactionAudio?.hasImpact?.("tit_pull")) return;
    stopTitPullElasticLoop();
    const url = titPullLoopUrl(win);
    if (!url) return;
    primeCompanionAudioContext(win);
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      ensureBustSlapBuffer(win, ctx, url).then(buf => {
        if (!buf || !(S.bustPull && S.bustPull.active) || muted(win) || !readForgeSound(win)) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        updateCompanionSfxDuck(win);
        const region = titPullLoopRegionSafe(buf);
        const loopAt = now + 0.12;
        const baseVol = titPullLoopGain(tension);
        const loop = {
          win,
          ctx,
          region,
          baseVol,
          baseTension: tension
        };
        S.titPullLoop = loop;
        loop.bed = connectTitPullLoopBed(ctx, buf, region, loopAt, baseVol);
        startTitPullLoopUndertone(loop, loopAt);
        startPullBreathBed(loop, loopAt + 0.08);
        updateTitPullElasticLoopGain(tension);
      }).catch(() => {});
    } catch (_) {}
  }

  function manifestImpactUrls(poolKey) {
    const fromManifest = S.reactionAudio?.impactUrls?.(poolKey);
    if (fromManifest?.length) return fromManifest;
    if (poolKey === "slap") return BUST_SLAP_SFX;
    return [];
  }

  function bustSlapImpactUrls() {
    return manifestImpactUrls("slap");
  }

  function impactBufferReady(url) {
    if (S.reactionAudio?.getDecodedBuffer?.(url)) return true;
    const cached = S.bustSlapBuffers?.[url];
    return cached && typeof cached !== "function";
  }

  function warmImpactSlapAudio(win, primaryUrl) {
    if (!win || !readForgeSound(win) || muted(win)) return Promise.resolve([]);
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return Promise.resolve([]);
      if (!S.audioCtx) S.audioCtx = new AC();
      const pool = bustSlapImpactUrls();
      const urls = [primaryUrl];
      const extra = pool.find(u => u !== primaryUrl && !impactBufferReady(u));
      if (extra) urls.push(extra);
      return Promise.all(urls.map(u => ensureBustSlapBuffer(win, S.audioCtx, u))).then(() => {
        scheduleFullImpactWarm(win);
      });
    } catch (_) {
      return Promise.resolve([]);
    }
  }

  function scheduleFullImpactWarm(win) {
    if (S.slapImpactWarmFull) return;
    S.slapImpactWarmFull = true;
    win.setTimeout(() => {
      if (!win || muted(win) || !readForgeSound(win) || win.document.hidden) return;
      try {
        if (!S.audioCtx) return;
        const pending = bustSlapImpactUrls().filter(u => !impactBufferReady(u));
        if (!pending.length) return;
        Promise.all(pending.map(u => ensureBustSlapBuffer(win, S.audioCtx, u))).catch(() => {});
      } catch (_) {}
    }, 2500);
  }

  function warmImpactAudio(win) {
    const pool = bustSlapImpactUrls();
    if (S.nsfwOn) warmTitPullImpactAudio(win);
    if (!pool.length) return Promise.resolve([]);
    return warmImpactSlapAudio(win, pool[0]);
  }

  function playManifestImpact(win, poolKey, strength, opts) {
    poolKey = poolKey || "slap";
    opts = opts || {};
    if (!win || muted(win) || !readForgeSound(win) || calm(win) || win.document.hidden) return;
    const poolRaw = manifestImpactUrls(poolKey);
    if (!poolRaw.length) {
      if (poolKey === "slap") playRecordedReaction(win, "surprised");
      return;
    }
    const requestedAt = Date.now();
    const titPullSoft = poolKey === "tit_pull" || opts.softContact;
    let pool = poolRaw;
    if (titPullSoft) pool = titPullStemPool(pool, opts.release ? "slosh" : "elastic", opts.stem);
    if (!pool.length) pool = poolRaw;
    if (titPullSoft) {
      if (!opts.skipCooldown) {
        const minGap = opts.release ? 260 : 580;
        if (S.lastTitPullAt && requestedAt - S.lastTitPullAt < minGap) return;
        S.lastTitPullAt = requestedAt;
      }
    } else if (S.lastImpactAt !== undefined && requestedAt - S.lastImpactAt < 110) {
      return;
    }
    if (!titPullSoft) S.lastImpactAt = requestedAt;
    const request = S.impactRequest = (S.impactRequest || 0) + 1;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      if (!S.impactSelections) S.impactSelections = {};
      if (!S.impactSelections[poolKey]) S.impactSelections[poolKey] = {};
      const selection = S.impactSelections[poolKey];
      const index = S.impactVariant?.[poolKey] || 0;
      const url = win.HqCompanionReactionAudio?.pickVariant(pool, selection) ||
        pool[index % pool.length];
      if (!S.impactVariant) S.impactVariant = {};
      S.impactVariant[poolKey] = (index + 1) % pool.length;
      const str = clampNum(Number(strength) || 0.45, 0, 1);
      const impactDb = Number(S.reactionAudio?.impactGainDb?.());
      const voiceDb = Number(S.reactionAudio?.voiceGainDb?.());
      const impactMul = Number.isFinite(impactDb) ? 10 ** (impactDb / 20) : 10 ** (3.5 / 20);
      const voiceMul = Number.isFinite(voiceDb) ? 10 ** (voiceDb / 20) : 1;
      let volMul = Number(opts.volumeMul) || (poolKey === "hair_pat" ? 0.52 : poolKey === "muffled" ? 0.74 : 1);
      let vol;
      if (titPullSoft) {
        volMul = Number(opts.volumeMul) || 0.55;
        const pullStr = clampNum(str * 0.62, 0, 0.72);
        vol = (0.05 + pullStr * 0.09) * voiceMul * volMul;
      } else {
        vol = (0.1 + str * 0.075 + Math.max(0, str - 0.58) * 0.06) * impactMul * volMul;
      }
      if (poolKey === "slap") void warmImpactSlapAudio(win, url);
      const alt = pool.find(u => u !== url);
      ensureBustSlapBuffer(win, ctx, url)
        .then(buf => buf ? buf : alt ? ensureBustSlapBuffer(win, ctx, alt) : null)
        .then(buf => {
          const waitMs = titPullSoft ? 3200 : 250;
          if (request !== S.impactRequest || Date.now() - requestedAt > waitMs) return;
          if (muted(win) || !readForgeSound(win) || win.document.hidden) return;
          if (!buf) {
            if (poolKey === "slap") playRecordedReaction(win, "surprised");
            return;
          }
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
          const now = ctx.currentTime;
          updateCompanionSfxDuck(win);
          if (opts.bodyThud !== false && poolKey !== "hair_pat" && !titPullSoft) playImpactBodyThud(ctx, now, str);
          const pitch = titPullSoft ? 0.94 + Math.random() * 0.05 : 1;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = pitch;
          const g = ctx.createGain(), tail = buf.duration / pitch;
          const attack = titPullSoft ? 0.048 : 0.015;
          g.gain.setValueAtTime(0.001, now);
          g.gain.linearRampToValueAtTime(vol, now + attack);
          g.gain.setValueAtTime(vol, now + Math.max(attack + 0.01, tail - 0.05));
          g.gain.exponentialRampToValueAtTime(0.001, now + tail);
          let outNode = g;
          if (titPullSoft) {
            const hp = ctx.createBiquadFilter();
            hp.type = "highpass";
            hp.frequency.value = 65;
            hp.Q.value = 0.55;
            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.value = 2500;
            lp.Q.value = 0.6;
            src.connect(hp);
            hp.connect(lp);
            lp.connect(g);
            outNode = g;
          } else {
            src.connect(g);
          }
          if (titPullSoft) connectCompanionReactionOut(outNode, null, ctx);
          else connectCompanionImpactOut(g, ctx);
          if (!S.activeImpactVoices) S.activeImpactVoices = [];
          while (S.activeImpactVoices.length >= 2) {
            const old = S.activeImpactVoices.shift();
            try {
              old.gain.gain.cancelScheduledValues(now);
              old.gain.gain.setValueAtTime(old.gain.gain.value, now);
              old.gain.gain.linearRampToValueAtTime(0, now + .02);
              old.source.stop(now + .02);
            } catch (_) {}
          }
          const voice = { source: src, gain: g };
          S.activeImpactVoices.push(voice);
          src.onended = () => {
            S.activeImpactVoices = (S.activeImpactVoices || []).filter(entry => entry !== voice);
            try { src.disconnect(); g.disconnect(); } catch (_) {}
          };
          src.start(now);
          src.stop(now + tail);
        }).catch(() => {});
    } catch (_) {}
  }

  function playBustSlapSfx(win, strength, poolKey) {
    playManifestImpact(win, poolKey || "slap", strength);
  }

  function playGrabImpactSfx(win, strength) {
    if (!S.reactionAudio?.hasImpact?.("grab")) return;
    playManifestImpact(win, "grab", strength, { bodyThud: false, volumeMul: 0.82 });
  }

  function playTitPullImpactSfx(win, strength, opts) {
    if (!S.reactionAudio?.hasImpact?.("tit_pull")) {
      playGrabImpactSfx(win, strength * 0.45);
      return;
    }
    playManifestImpact(win, "tit_pull", strength, {
      bodyThud: false,
      softContact: true,
      release: !!opts?.release,
      stem: opts?.stem,
      skipCooldown: !!opts?.skipCooldown,
      volumeMul: opts?.volumeMul ?? (opts?.release ? 0.34 : 0.29)
    });
  }

  function playHairPatImpactSfx(win, strength) {
    if (!S.reactionAudio?.hasImpact?.("hair_pat")) return;
    playManifestImpact(win, "hair_pat", strength, { bodyThud: false });
  }

  function resetPullSfxGate() {
    S.pullSfx = null;
  }

  function tickBustPullImpactSfx(win, tension, dist, shape) {
    if (!win || muted(win) || !readForgeSound(win) || calm(win)) return;
    if (!(S.bustPull && S.bustPull.active)) return;
    const t = clampNum(Number(tension) || 0, 0, 1);
    if (t < 0.08) return;
    if (!S.pullSfx) S.pullSfx = { grabAt: 0, muffledAt: 0, tierBit: 0 };
    const now = win.performance.now();
    const move = clampNum(Number(dist) / 96, 0, 1);
    const shear = Math.abs(Number(shape?.shear) || 0);
    const hasTitPull = S.reactionAudio?.hasImpact?.("tit_pull");

    if (S.titPullLoop && hasTitPull) {
      updateTitPullElasticLoopGain(t);
      if (move >= 0.1 && now - S.pullSfx.grabAt > 1050) {
        playTitPullImpactSfx(win, 0.1 + t * 0.16 + move * 0.06, { stem: "07" });
        S.pullSfx.grabAt = now;
      }
      return;
    }

    const hasGrab = S.reactionAudio?.hasImpact?.("grab");
    const hasMuff = S.reactionAudio?.hasImpact?.("muffled");
    const pullSfx = (str, release) => {
      if (hasTitPull) playTitPullImpactSfx(win, str, release ? { release: true } : undefined);
      else if (hasGrab) playGrabImpactSfx(win, str);
    };
    const stretchSfx = (str) => {
      if (hasTitPull) return;
      if (hasMuff) playManifestImpact(win, "muffled", str, { bodyThud: false, volumeMul: 0.54 });
    };

    if (t >= 0.28 && !(S.pullSfx.tierBit & 1)) {
      S.pullSfx.tierBit |= 1;
      pullSfx(0.22 + t * 0.16);
      S.pullSfx.grabAt = now;
    }
    if (t >= 0.48 && !(S.pullSfx.tierBit & 2)) {
      S.pullSfx.tierBit |= 2;
      pullSfx(0.28 + t * 0.18);
      S.pullSfx.grabAt = now;
      S.pullSfx.muffledAt = now;
    }
    if (t >= 0.68 && !(S.pullSfx.tierBit & 4)) {
      S.pullSfx.tierBit |= 4;
      pullSfx(0.34 + t * 0.2);
      S.pullSfx.grabAt = now;
      S.pullSfx.muffledAt = now;
    }

    if (move < 0.12 && shear < 0.04) return;
    const gapGrab = t > 0.55 ? 720 : 920;
    if (now - S.pullSfx.grabAt > gapGrab) {
      pullSfx(0.14 + t * 0.22 + move * 0.08);
      S.pullSfx.grabAt = now;
    }
    if (!hasTitPull && now - S.pullSfx.muffledAt > (t > 0.55 ? 640 : 820)) {
      stretchSfx(0.18 + t * 0.28 + shear * 0.22);
      S.pullSfx.muffledAt = now;
    }
  }

  function stopImpactAudio() {
    S.impactRequest = (S.impactRequest || 0) + 1;
    for (const voice of S.activeImpactVoices || []) {
      try { voice.source.stop(); } catch (_) {}
    }
    S.activeImpactVoices = [];
  }

  function ensurePleasureGruntBuffer(win, ctx, url) {
    if (!S.pleasureGruntBuffers) S.pleasureGruntBuffers = {};
    const cached = S.pleasureGruntBuffers[url];
    if (cached && typeof cached !== "function") return Promise.resolve(cached);
    if (cached) return cached;
    const shared = S.reactionAudio?.getDecodedBuffer?.(url);
    if (shared) {
      S.pleasureGruntBuffers[url] = shared;
      return Promise.resolve(shared);
    }
    const viaReaction = S.reactionAudio?.ensureDecodedBuffer?.(url);
    if (viaReaction) {
      const load = viaReaction.then(buf => {
        if (buf) S.pleasureGruntBuffers[url] = buf;
        else delete S.pleasureGruntBuffers[url];
        return buf;
      });
      S.pleasureGruntBuffers[url] = load;
      return load;
    }
    const load = win.fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("pleasure grunt missing");
        return res.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        S.pleasureGruntBuffers[url] = buf;
        return buf;
      })
      .catch(() => null);
    S.pleasureGruntBuffers[url] = load;
    return load;
  }

  function stopIdleHumming(win) {
    if (!S.el?.classList.contains("is-idle-humming")) return;
    win.clearTimeout(S.idleHummingT);
    win.clearInterval(S.idleHummingNoteI);
    S.idleHummingNoteI = 0;
    S.el.classList.remove("is-idle-humming");
    S.el.style.removeProperty("--rig-hum-beat");
    S.reactionAudio?.stop("humming");
  }

  function scheduleIdleHummingNotes(win) {
    win.clearInterval(S.idleHummingNoteI);
    if (idleAnimBlocked(win) || !S.el?.classList.contains("is-idle-humming")) return;
    const avatar = S.el.querySelector(".hq-companion-avatar");
    if (!avatar) return;
    const tick = () => {
      if (!S.el?.classList.contains("is-idle-humming")) return;
      spawnMusicNote(win, avatar);
    };
    tick();
    S.idleHummingNoteI = win.setInterval(tick, 650 + Math.random() * 250);
  }

  function startIdleHumming(win) {
    if (idleAnimBlocked(win) || S.busy || S.chatBusy || S.voicePreview || S.currentAudio ||
        S.el.classList.contains("is-speaking") || S.el.classList.contains("is-voice-lipsync") ||
        S.el.classList.contains("is-music-grooving") || S.companionDragActive) return false;
    const now = Date.now();
    if (now - (S.lastActAt || now) < 20000 ||
        (S.lastIdleHummingAt && now - S.lastIdleHummingAt < 120000)) return false;
    if (S.reactionAudio?.isPlaying()) return false;
    const duration = playNaturalVoiceCue(win, "idle_humming") || 3600;
    S.lastIdleHummingAt = now;
    const beatSec = Math.max(0.95, Math.min(2.2, duration / 1000));
    S.el.style.setProperty("--rig-hum-beat", beatSec.toFixed(2) + "s");
    S.el.classList.add("is-idle-humming");
    win.clearTimeout(S.idleHummingT);
    S.idleHummingT = win.setTimeout(() => stopIdleHumming(win), duration);
    scheduleIdleHummingNotes(win);
    startLive2DLoop(win);
    return true;
  }

  function playNaturalVoiceCue(win, context) {
    const cue = {
      tickle: { kind: "giggle", gap: 8000, priority: 1 },
      music_started: { kind: "humming", gap: 45000, priority: 0 },
      idle_humming: { kind: "humming", gap: 120000, priority: 0 },
      idle_kiss: { kind: "kiss", gap: 45000, priority: 0 },
      idle_shy: { kind: "giggle", gap: 90000, priority: 0 },
      idle_heart: { kind: "contented", gap: 60000, priority: 0 },
      stretch: { kind: "yawn", gap: 90000, priority: 0 },
      lip_bite: { kind: "lipsmack", gap: 15000, priority: 0 },
      hair_tuck: { kind: "lipsmack", gap: 22000, priority: 0 },
      toast_celebrate: { kind: "celebrate", gap: 12000, priority: 1 },
      typing_backchannel: { kind: "typing_backchannel", gap: 45000, priority: 0 },
      message_ack: { kind: "ack", gap: 6000, priority: 0 },
      mock_scandal: { kind: "mock_scandal", gap: 20000, priority: 1 }
    }[context];
    if (!cue || !win || !S.el || S.el.hidden || S.currentAudio || S.voicePreview ||
        win.document.hidden || muted(win) || !readForgeSound(win)) return 0;
    if (context === "music_started" && !S.el.classList.contains("is-music-grooving")) return 0;
    if (!S.reactionAudio?.has(cue.kind)) return 0;
    const now = Date.now();
    if (!S.naturalVoiceNextAt) S.naturalVoiceNextAt = {};
    if (now < (S.naturalVoiceNextAt[context] || 0)) return 0;
    const duration = S.reactionAudio.start(cue.kind, { interrupt: false, priority: cue.priority });
    if (duration > 0) S.naturalVoiceNextAt[context] = now + cue.gap;
    return duration;
  }

  function syncCompanionMusic(win) {
    if (!S.el || win.document.hidden) return;
    const wasGrooving = S.el.classList.contains("is-music-grooving");
    const grooving = Array.from(win.document.querySelectorAll("audio, video"))
      .some(media => !media.paused && !media.ended && media.readyState > 2);
    S.el.classList.toggle("is-music-grooving", grooving);
    updateCompanionSfxDuck(win);
    if (grooving) {
      if (!wasGrooving) playNaturalVoiceCue(win, "music_started");
      const avatar = S.el.querySelector(".hq-companion-avatar");
      if (avatar) spawnMusicNote(win, avatar);
    } else if (wasGrooving && !S.el.classList.contains("is-idle-humming")) {
      S.reactionAudio?.stop("humming");
    }
  }

  function playRecordedReaction(win, kind) {
    if (!S.reactionAudio?.has(kind)) return false;
    if (!win || muted(win) || !readForgeSound(win) || win.document.hidden || S.voicePreview) return true;
    if (["slap", "pleasure", "moan", "whimper"].includes(kind) && !S.nsfwOn) return true;
    S.reactionAudio.start(kind, { interrupt: false, priority: 1 });
    return true;
  }

  function playRecordedReactionChain(win, kinds) {
    for (const kind of kinds) {
      if (playRecordedReaction(win, kind)) return true;
    }
    return false;
  }

  function playPleasureGruntSfx(win, tension, kind = "pleasure") {
    if (!win || muted(win) || !readForgeSound(win) || calm(win)) return;
    if (playRecordedReaction(win, kind)) return;
    const requestedAt = Date.now();
    if (S.lastFallbackGruntAt !== undefined && requestedAt - S.lastFallbackGruntAt < 1200) return;
    S.lastFallbackGruntAt = requestedAt;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      if (typeof S.pleasureGruntVariant !== "number") S.pleasureGruntVariant = 0;
      const pool = S.pleasureGruntUrls?.length ? S.pleasureGruntUrls : PLEASURE_GRUNT_SFX;
      const url = pool[S.pleasureGruntVariant % pool.length];
      S.pleasureGruntVariant += 1;
      const t = clampNum(Number(tension) || 0.5, 0, 1);
      ensurePleasureGruntBuffer(win, ctx, url).then((buf) => {
        if (!buf) return;
        if (Date.now() - requestedAt > 250 || muted(win) || !readForgeSound(win) ||
            win.document.hidden || S.currentAudio || S.voicePreview) return;
        const now = ctx.currentTime;
        const pitch = 0.86 + Math.random() * 0.08;
        const vol = 0.12 + t * 0.1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = pitch;
        const softTone = companionReactionTone(ctx, now, "soft");
        const g = ctx.createGain();
        const tail = buf.duration / Math.max(pitch, 0.01);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(vol, now + 0.042);
        g.gain.setValueAtTime(vol * 0.86, now + tail * 0.62);
        g.gain.exponentialRampToValueAtTime(0.001, now + tail + 0.1);
        if (softTone) {
          softTone.connect(g);
          src.connect(softTone);
        } else {
          src.connect(g);
        }
        connectCompanionReactionOut(g, null, ctx);
        src.start(now);
      });
    } catch (_) {}
  }

  function bumpContactBlush(win, amount, holdMs) {
    if (!win || !S.el || !S.nsfwOn) return;
    const bump = clampNum(Number(amount) || 0, 0, 0.45);
    S.contactBlush = clampNum((S.contactBlush || 0) + bump, 0, 1);
    S.contactBlushUntil = Date.now() + clampNum(Number(holdMs) || 3200, 800, 12000);
    syncContactBlush(win);
  }

  function pullContactBlushShape(tension) {
    const t = clampNum(Number(tension) || 0, 0, 1);
    const eased = clampNum(t / 0.92, 0, 1);
    const smooth = eased * eased * (3 - 2 * eased);
    return clampNum(0.14 + smooth * 0.86, 0, 1);
  }

  const PULL_FX_COALESCE_MS = 14;

  function pullFxRenderedRecently(nowMs) {
    return !!(S.el && S.el.classList.contains("is-bust-pull") &&
      S.pullFxAt && nowMs - S.pullFxAt < PULL_FX_COALESCE_MS);
  }

  function markPullFxRendered(win) {
    if (!win || !S.el) return;
    S.pullFxAt = win.performance.now();
  }

  function cachePullFaceMetrics() {
    if (!S.face) return;
    const w = S.face.clientWidth;
    const h = S.face.clientHeight;
    if (w > 0) S.pullFaceWidth = w;
    if (h > 0) S.pullFaceHeight = h;
  }

  function pullFaceSpan() {
    const w = (S.pullFaceWidth > 0 ? S.pullFaceWidth : S.face?.clientWidth) || 72;
    const h = (S.pullFaceHeight > 0 ? S.pullFaceHeight : S.face?.clientHeight) || w;
    return { w, h };
  }

  /** Drop contact/pull presentation that must not survive adult mode off (classes, vars, timers). */
  function clearAdultSessionBleed(win) {
    if (!S.el) return;
    S.contactBlush = 0;
    S.contactBlushUntil = 0;
    S.contactFlushUntil = 0;
    S.contactWarmthSession = 0;
    S.pullReleaseSteam = 0;
    S.pullReleaseSteamUntil = 0;
    S.pullReleaseSteamSpan = 0;
    S.pullReleaseUntil = 0;
    S.bustAfterglowUntil = 0;
    S.bustAfterglowStrength = 0;
    S.bustAfterglowDuration = 0;
    S.feverActive = false;
    S.el.classList.remove(
      "has-contact-blush",
      "is-contact-flushed",
      "is-contact-fever-tease",
      "is-contact-sting-flash",
      "is-steamy-glass",
      "is-pull-release-steam",
      "is-bust-afterglow",
      "is-fever-climax",
      "is-wind-blown"
    );
    clearPullVar("--pull-blush");
    clearPullVar("--pull-steam");
    clearPullVar("--rig-contact-blush");
    S.pullFaceWidth = 0;
    S.pullFaceHeight = 0;
    S.pullFxAt = 0;
  }

  function syncContactBlush(win) {
    if (!win || !S.el || !S.nsfwOn) return;
    const now = Date.now();
    if (S.contactBlushUntil && now > S.contactBlushUntil && (S.contactBlush || 0) > 0) {
      S.contactBlush = clampNum((S.contactBlush || 0) * 0.9 - 0.015, 0, 1);
      S.contactBlushUntil = S.contactBlush > 0.03 ? now + 420 : 0;
      if (S.contactBlush <= 0.03) S.contactBlush = 0;
    }
    let live = S.contactBlush || 0;
    let pullBlush = 0;
    let pullSteam = 0;
    const perfNow = win.performance.now();
    if (S.bustPull && S.bustPull.active) {
      const t = clampNum(S.pullMotion?.tension ?? S.pullTarget?.tension ?? 0, 0, 1);
      pullBlush = pullContactBlushShape(t);
      live = clampNum(Math.max(live, pullBlush), 0, 1);
      pullSteam = clampNum(pullBlush * pullBlush * 0.88 + Math.max(0, t - 0.5) * 0.42, 0, 1);
    } else if (S.pullReleaseSteamUntil && perfNow < S.pullReleaseSteamUntil) {
      const span = Math.max(1, Number(S.pullReleaseSteamSpan) || 1400);
      const rel = (S.pullReleaseSteamUntil - perfNow) / span;
      pullSteam = clampNum((S.pullReleaseSteam || 0) * rel, 0, 1);
    } else if (S.pullReleaseSteamUntil) {
      S.pullReleaseSteam = 0;
      S.pullReleaseSteamUntil = 0;
      S.pullReleaseSteamSpan = 0;
    }
    if (win.performance.now() < (S.slapMotionUntil || 0)) {
      live = clampNum(live + (S.lastSlapBlushBoost || 0.28), 0, 1);
    }
    setPullVar("--pull-blush", pullBlush.toFixed(3));
    setPullVar("--pull-steam", pullSteam.toFixed(3));
    // Read only by the rig's blush layers: written on them, not the whole companion (see setPullVar).
    setPullVar("--rig-contact-blush", live.toFixed(3));
    S.el.classList.toggle("has-contact-blush", live > 0.05);
    if (S.contactFlushUntil && now > S.contactFlushUntil) {
      S.contactFlushUntil = 0;
      S.el.classList.remove("is-contact-flushed");
    }
    const pullReleaseBeat = S.pullReleaseUntil && perfNow < S.pullReleaseUntil;
    if (live >= 0.85 && !pullReleaseBeat && !S.el.classList.contains("is-contact-flushed") &&
        (!S.lastContactFlushAt || now - S.lastContactFlushAt > 24000)) {
      S.lastContactFlushAt = now;
      S.contactFlushUntil = now + 8000;
      S.el.classList.add("is-contact-flushed");
      S.contactBlush = Math.max(S.contactBlush || 0, 0.88);
      S.contactBlushUntil = now + 8000;
      if (!muted(win) && readForgeSound(win) && S.reactionAudio) S.reactionAudio.start("exhale");
      lewdToast(win, "contact_flush", 3800);
    }
    const warm = typeof S.warmth === "number" ? S.warmth : 22;
    const contactWarm = S.contactWarmthSession || 0;
    if (live >= 0.68 && warm >= 85 && contactWarm >= 28 &&
        (!S.contactFeverTeaseAt || now - S.contactFeverTeaseAt > 900000)) {
      S.contactFeverTeaseAt = now;
      triggerContactFeverTease(win);
    }
  }

  function triggerContactFeverTease(win) {
    if (!win || !S.el || !S.nsfwOn || calm(win)) return;
    S.el.classList.add("is-contact-fever-tease", "is-steamy-glass");
    addArousalWarmth(win, 4, "contact charnel");
    if (!muted(win) && readForgeSound(win)) {
      if (S.reactionAudio) S.reactionAudio.start("exhale");
      else playVocalSynthFx(win, "sigh");
    }
    win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-contact-fever-tease");
    }, 5200);
    lewdToast(win, "contact_fever", 4200);
    triggerInteractiveAiReaction(
      win,
      lewdEventPrompt("contact_fever"),
      lewdEventPool("contact_fever"),
      true
    );
  }

  function triggerPullDeepSurrender(win, tension) {
    if (!win || !S.nsfwOn || calm(win)) return;
    const ex = S.pullExpress;
    if (!ex || ex.deepSurrenderDone) return;
    ex.deepSurrenderDone = true;
    const t = clampNum(tension, 0, 1);
    bumpContactBlush(win, 0.32, 9000);
    triggerBustAfterglow(win, 0.78, 12000);
    pullHaptic(win, 12);
    win.setTimeout(() => pullHaptic(win, 6), 120);
    if (!muted(win) && readForgeSound(win)) playPleasureGruntSfx(win, Math.max(t, 0.82));
    triggerPullDeepGlance(win);
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (av) ["♥", "🔥", "♥"].forEach((sym, i) => win.setTimeout(() => spawnCuteHeart(win, av, sym), i * 100));
    addArousalWarmth(win, 10, "poitrine tirée");
    triggerInteractiveAiReaction(
      win,
      lewdEventPrompt("pull_surrender"),
      lewdEventPool("pull_surrender"),
      true
    );
    const now = Date.now();
    if (readVoice(win) && (!S.lastRarePullLewdAt || now - S.lastRarePullLewdAt > 900000) && Math.random() < 0.22) {
      S.lastRarePullLewdAt = now;
      playLewdPhaseWav(win, "pull_surrender");
    }
  }

  function triggerSlapComboFinisher(win, av, hit, intensity) {
    if (!win || !S.nsfwOn || calm(win) || !av || !hit) return;
    const ex = S.slapExpress;
    if (!ex || ex.finisherDone) return;
    ex.finisherDone = true;
    const dir = hit.direction || 1;
    bumpContactBlush(win, 0.38, 9000);
    S.lastSlapBlushBoost = 0.72;
    S.slapMotionUntil = win.performance.now() + 1400;
    triggerBustAfterglow(win, 0.62, 10000);
    pullHaptic(win, 10);
    win.setTimeout(() => pullHaptic(win, 8), 90);
    if (!calm(win)) {
      impulseBustSidesOnly(win, dir * 68, 42, 1.35);
      win.setTimeout(() => impulseBustSidesOnly(win, -dir * 42, 28, 1.1), 55);
      startLive2DLoop(win);
    }
    if (!muted(win) && readForgeSound(win)) {
      playBustSlapSfx(win, Math.max(intensity, 0.85));
      win.setTimeout(() => playPleasureGruntSfx(win, Math.max(intensity, 0.78)), 140);
    }
    ["🔥", "♥", "🔥"].forEach((sym, i) => win.setTimeout(() => spawnCuteHeart(win, av, sym), i * 85));
    addArousalWarmth(win, 14, "claquement sur la poitrine");
    if (typeof win.hqToast === "function") {
      lewdToast(win, "slap_bust_finisher", 3200);
    }
    const warm = typeof S.warmth === "number" ? S.warmth : 22;
    if (warm >= 70 && Math.random() < 0.05 && S.el) {
      S.el.classList.add("is-contact-sting-flash");
      win.setTimeout(() => S.el && S.el.classList.remove("is-contact-sting-flash"), 680);
    }
  }

  function triggerMonsterSlapPayoff(win, av, hit, intensity) {
    if (!win || !S.nsfwOn || calm(win) || !av) return;
    const ex = S.slapExpress;
    if (!ex || ex.monsterDone) return;
    ex.monsterDone = true;
    bumpContactBlush(win, 0.22, 6000);
    triggerBustAfterglow(win, 0.52, 8500);
    pullHaptic(win, 9);
    if (!calm(win) && hit) {
      impulseBustSidesOnly(win, (hit.direction || 1) * 82, 36, 1.2);
      startLive2DLoop(win);
    }
    spawnCuteHeart(win, av, "🔥");
    addArousalWarmth(win, 9, "claquement sur la poitrine");
    playLewdPhaseWav(win, "phase9_breast_vivid");
    triggerInteractiveAiReaction(
      win,
      lewdEventPrompt("slap_bust_monster"),
      lewdEventPool("slap_bust_monster"),
      true
    );
  }

  function resetPullPleasureGruntGate() {
    S.pullGruntGate = { startedAt: 0, lastAt: 0, lastT: 0 };
  }

  function resetPullExpressiveGate() {
    S.pullExpress = {
      tierMask: 0, lastWarmthAt: 0, peakT: 0, lastT: 0, lastBlushAt: 0, lastWhisperAt: 0,
      deepHoldMs: 0, deepSurrenderDone: false, releasePayoffDone: false, lastFrameAt: 0
    };
  }

  function maybeSlapPleasureGrunt(win, intensity) {
    if (!win || muted(win) || !readForgeSound(win) || calm(win)) return;
    const t = clampNum(Number(intensity) || 0.5, 0, 1);
    if (t < 0.52) return;
    const now = win.performance.now();
    if (!S.slapGruntGate) S.slapGruntGate = { lastAt: 0 };
    const gap = t > 0.72 ? 2400 : 3200;
    if (S.slapGruntGate.lastAt && now - S.slapGruntGate.lastAt < gap) return;
    S.slapGruntGate.lastAt = now;
    playPleasureGruntSfx(win, t);
  }

  function tickSlapExpressiveReactions(win, av, hit, opts) {
    if (!win || !S.nsfwOn || calm(win) || !hit || !av) return;
    const str = clampNum(hit.strength || 0.45, 0, 1);
    const force = clampNum(typeof hit.force === "number" ? hit.force / 3 : str * 0.45, 0, 1);
    const intensity = clampNum(str * 0.5 + force * 0.5, 0, 1);
    const bust = !!(opts && opts.bustSlap);
    const windup = intensity >= 0.52 ? beginReactionWindup(win) : 0;
    const soon = (fn) => (windup ? win.setTimeout(fn, windup) : fn());
    bumpContactBlush(win, 0.12 + intensity * 0.26, 4800 + Math.round(intensity * 2400));
    S.lastSlapBlushBoost = 0.22 + intensity * 0.58;
    S.slapMotionUntil = win.performance.now() + 780 + intensity * 520;
    if (!S.slapExpress) S.slapExpress = { tierMask: 0, burst: 0, lastBurstAt: 0, comboStartedAt: 0, finisherDone: false, monsterDone: false };
    const ex = S.slapExpress;
    const now = Date.now();
    if (!ex.comboStartedAt || now - ex.comboStartedAt > 2000) {
      ex.comboStartedAt = now;
      ex.burst = 1;
    } else {
      ex.burst += 1;
    }
    ex.lastBurstAt = now;
    const tiers = [
      { at: 0.32, bit: 1, warmth: 4 },
      { at: 0.52, bit: 2, warmth: 7, hearts: 1, synth: "gasp" },
      { at: 0.74, bit: 4, warmth: 11, hearts: 2, synth: "moan", afterglow: 0.48 },
    ];
    for (const tier of tiers) {
      if (intensity < tier.at || (ex.tierMask & tier.bit)) continue;
      if (tier.bit > 1 && ex.burst < 2 && intensity < 0.68) continue;
      ex.tierMask |= tier.bit;
      addArousalWarmth(win, tier.warmth, bust ? "claquement sur la poitrine" : "petite fessée coquine");
      bumpContactBlush(win, 0.06 + tier.at * 0.12, 4600);
      if (tier.hearts) {
        ["♥", "🔥"].slice(0, tier.hearts).forEach((sym, i) => {
          win.setTimeout(() => spawnCuteHeart(win, av, sym), i * 120 + windup);
        });
      }
      if (tier.synth && !muted(win) && readForgeSound(win)) soon(() => playVocalSynthFx(win, tier.synth, intensity));
      if (tier.afterglow) {
        triggerBustAfterglow(win, tier.afterglow, 8000);
        if (S.nsfwOn) win.setTimeout(() => playLewdPhaseWav(win, "afterglow_cooldown"), windup + 420);
      }
      if (intensity >= 0.48 && !muted(win) && readForgeSound(win)) soon(() => playGrabImpactSfx(win, intensity * 0.72));
    }
    if (bust && intensity >= 0.55 && !ex.finisherDone) maybeSlapPleasureGrunt(win, intensity);
    if (bust && ex.burst >= 4 && intensity >= 0.35) {
      triggerSlapComboFinisher(win, av, hit, intensity);
    } else if (bust && ex.burst === 1 && intensity >= 0.82) {
      triggerMonsterSlapPayoff(win, av, hit, intensity);
    } else if (intensity >= 0.62 && ex.burst >= 3 && !ex.finisherDone) {
      soon(() => triggerInteractiveAiReaction(
        win,
        bust ? lewdEventPrompt("slap_bust_combo") : lewdEventPrompt("slap_booty"),
        bust ? lewdEventPool("slap_bust_combo") : lewdEventPool("slap_booty"),
        ex.burst >= 4
      ));
    } else if (bust && ex.burst <= 2 && intensity >= 0.38 && intensity < 0.82) {
      soon(() => triggerInteractiveAiReaction(
        win,
        lewdEventPrompt("slap_bust"),
        lewdEventPool("slap_bust"),
        intensity >= 0.55
      ));
    } else if (!bust && intensity >= 0.42) {
      soon(() => triggerInteractiveAiReaction(
        win,
        lewdEventPrompt("slap_booty"),
        lewdEventPool("slap_booty"),
        intensity >= 0.58
      ));
    }
    win.clearTimeout(S.slapExpressResetT);
    S.slapExpressResetT = win.setTimeout(() => {
      S.slapExpress = null;
      S.lastSlapBlushBoost = 0;
    }, 9000);
    syncContactBlush(win);
  }

  function resetPullInteractionFx() {
    resetPullPleasureGruntGate();
    resetPullExpressiveGate();
    resetPullSfxGate();
  }

  function tickPullExpressiveReactions(win, tension, shape) {
    if (!win || !S.nsfwOn || calm(win) || !(S.bustPull && S.bustPull.active)) return;
    const t = clampNum(tension, 0, 1);
    if (!S.pullExpress) resetPullExpressiveGate();
    const ex = S.pullExpress;
    ex.peakT = Math.max(ex.peakT || 0, t);
    ex.lastT = ex.lastT || 0;
    if (t >= 0.52) triggerPullDeepGlance(win);
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    const tiers = [
      { at: 0.3, bit: 1, warmth: 4, hearts: 0 },
      { at: 0.5, bit: 2, warmth: 7, hearts: 1, synth: "gasp" },
      { at: 0.72, bit: 4, warmth: 12, hearts: 2, synth: "moan", afterglow: 0.62, ai: true },
    ];
    for (const tier of tiers) {
      if (t < tier.at || (ex.tierMask & tier.bit)) continue;
      ex.tierMask |= tier.bit;
      addArousalWarmth(win, tier.warmth, "poitrine tirée");
      bumpContactBlush(win, 0.05 + tier.at * 0.14, 5000);
      if (tier.hearts && av) {
        ["♥", "🔥"].slice(0, tier.hearts).forEach((sym, i) => {
          win.setTimeout(() => spawnCuteHeart(win, av, sym), i * 130);
        });
      }
      if (tier.synth && !muted(win) && readForgeSound(win)) playVocalSynthFx(win, tier.synth, t);
      if (tier.afterglow) triggerBustAfterglow(win, tier.afterglow, 9500);
      if (tier.bit === 1 && Math.random() < 0.44) lewdToast(win, "pull_light", 2700);
      if (tier.bit === 2 && Math.random() < 0.5) lewdToast(win, "pull_medium", 3100);
      if (tier.ai) {
        triggerInteractiveAiReaction(
          win,
          lewdEventPrompt("pull_deep"),
          lewdEventPool("pull_deep"),
          true
        );
      }
    }
    const now = Date.now();
    if (t >= 0.42 && (!ex.lastWarmthAt || now - ex.lastWarmthAt > 2100)) {
      ex.lastWarmthAt = now;
      addArousalWarmth(win, 2 + Math.round(t * 5), "poitrine tirée");
    }
    if (t >= 0.52 && (!ex.lastWhisperAt || now - ex.lastWhisperAt > 4800) && Math.random() < 0.36) {
      ex.lastWhisperAt = now;
      lewdToast(win, t >= 0.68 ? "pull_deep" : "pull_medium", 3200);
    }
    if (!ex.lastBlushAt || now - ex.lastBlushAt > 1600) {
      ex.lastBlushAt = now;
      bumpContactBlush(win, 0.06 + t * 0.11, 4200 + Math.round(t * 2800));
    }
    if (!calm(win) && shape && t - ex.lastT > 0.11) {
      impulseBustSidesOnly(
        win,
        clampNum((shape.shear || 0) * 38, -48, 48),
        clampNum(t * 22 + Math.max(0, (shape.stretch || 1) - 1) * 14, 0, 38),
        0.72
      );
    }
    const perf = win.performance.now();
    if (t >= 0.72) {
      ex.deepHoldMs = (ex.deepHoldMs || 0) + (ex.lastFrameAt ? perf - ex.lastFrameAt : 0);
      if (!ex.deepSurrenderDone && ex.deepHoldMs >= 950) triggerPullDeepSurrender(win, t);
    } else if (t < 0.62) {
      ex.deepHoldMs = 0;
    }
    ex.lastFrameAt = perf;
    ex.lastT = t;
  }

  function finishPullExpressiveReactions(win, peakTension) {
    if (!win || !S.nsfwOn || calm(win)) return;
    const peak = clampNum(Number(peakTension) || 0, 0, 1);
    if (peak < 0.48) return;
    const ex = S.pullExpress;
    if (ex && !ex.releasePayoffDone) {
      ex.releasePayoffDone = true;
      triggerBustSettleProfile(win, "pull");
      const gx = S.pullGaze ? S.pullGaze.x * 1.15 : 0;
      setLive2DTarget(win, gx, 1.65);
      if (peak >= 0.62 && !ex.deepSurrenderDone && !muted(win) && readForgeSound(win)) {
        playPleasureGruntSfx(win, peak);
      }
    }
    addArousalWarmth(win, 6 + Math.round(peak * 8), "relâchement après poitrine tirée");
    triggerBustAfterglow(win, 0.35 + peak * 0.45, 8500);
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (peak >= 0.55) {
      spawnCuteHeart(win, av, "♥");
      if (peak >= 0.68) win.setTimeout(() => spawnCuteHeart(win, av, "✨"), 160);
    }
    bumpContactBlush(win, 0.1 + peak * (peak >= 0.72 ? 0.28 : 0.18), 5200);
    if (peak >= 0.68) {
      const windup = beginReactionWindup(win);
      const speak = () => triggerInteractiveAiReaction(
        win,
        lewdEventPrompt("pull_release"),
        lewdEventPool("pull_release"),
        true
      );
      if (windup) win.setTimeout(speak, windup);
      else speak();
    }
  }

  function maybePullPleasureGrunt(win, dist, tension) {
    if (!win || !S.nsfwOn || muted(win) || !readForgeSound(win) || calm(win)) return;
    if (!(S.bustPull && S.bustPull.active) || !S.pullTarget) return;
    const t = clampNum(tension, 0, 1);
    const pullDist = Math.max(Number(dist) || 0, Math.hypot(S.pullTarget.x || 0, S.pullTarget.y || 0));
    if (t < 0.42 || pullDist < 28) return;
    const now = win.performance.now();
    if (!S.pullGruntGate) resetPullPleasureGruntGate();
    const gate = S.pullGruntGate;
    if (!gate.startedAt) gate.startedAt = now;
    const minGap = t > 0.72 ? 2200 : 3200;
    if (gate.lastAt && now - gate.lastAt < minGap) return;
    if (!gate.lastAt && now - gate.startedAt < 480) return;
    const rising = t >= gate.lastT + 0.09;
    const deep = t >= 0.66;
    if (gate.lastAt && !rising && !deep) return;
    gate.lastAt = now;
    gate.lastT = t;
    playPleasureGruntSfx(win, t);
  }

  function playVocalSynthFx(win, kind, pitchMod) {
    if (!win || muted(win) || !readForgeSound(win) || win.document.hidden || S.voicePreview) return;
    if (kind === "spank") {
      playBustSlapSfx(win, 0.42);
      return;
    }
    const synthRecorded = {
      mwah: ["kiss"],
      purr: ["purr", "contented"],
      gasp: ["surprised"],
      sigh: ["exhale"],
      moan: ["moan"],
      whisper: ["lipsmack"],
      gag: ["whimper"],
      choke: ["whimper"],
      pop: ["pop", "giggle"],
      clink: ["clink"],
      pounce: ["pounce"],
      dizzy: ["dizzy"],
      cupid: ["cupid", "kiss"]
    }[kind];
    if (synthRecorded && playRecordedReactionChain(win, synthRecorded)) return;
    if (S.currentAudio) return;
    if ((kind === "gasp" || kind === "sigh") && !calm(win)) {
      S.breathEvent = { kind: kind, t0: win.performance.now() };
    }
    const fxNow = Date.now();
    if (!S.synthFxLastByKind) S.synthFxLastByKind = {};
    const fxGap = kind === "spank" || kind === "pop" ? 180 : 650;
    if (S.lastSynthFxAt !== undefined && fxNow - S.lastSynthFxAt < 180) return;
    if (S.synthFxLastByKind[kind] !== undefined && fxNow - S.synthFxLastByKind[kind] < fxGap) return;
    S.lastSynthFxAt = fxNow;
    S.synthFxLastByKind[kind] = fxNow;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const reactionTone = beginCompanionReactionBus(ctx, now);
      if (kind === "mwah") {
        // Cute lip-smack kiss chirp
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(340, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.065);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.14);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.12, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        osc.stop(now + 0.16);
      } else if (kind === "purr") {
        // Warm soft purr harmonic
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(110, now);
        osc.frequency.linearRampToValueAtTime(132, now + 0.22);
        osc.frequency.linearRampToValueAtTime(98, now + 0.45);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.06, now + 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
        osc.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        osc.stop(now + 0.48);
      } else if (kind === "gag" || kind === "choke") {
        // Wet glottal deepthroat gag / choke spasm
        const osc = ctx.createOscillator();
        const oscLow = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sawtooth";
        oscLow.type = "sine";
        const filter = ctx.createBiquadFilter ? ctx.createBiquadFilter() : null;
        if (filter) {
          filter.type = "lowpass";
          filter.frequency.setValueAtTime(380, now);
          filter.frequency.linearRampToValueAtTime(140, now + 0.24);
        }
        osc.frequency.setValueAtTime(170, now);
        osc.frequency.linearRampToValueAtTime(115, now + 0.12);
        osc.frequency.linearRampToValueAtTime(75, now + 0.25);
        oscLow.frequency.setValueAtTime(90, now);
        oscLow.frequency.linearRampToValueAtTime(60, now + 0.25);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.095, now + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.27);
        if (filter) {
          osc.connect(filter);
          oscLow.connect(filter);
          filter.connect(g);
        } else {
          osc.connect(g);
          oscLow.connect(g);
        }
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        oscLow.start(now);
        osc.stop(now + 0.28);
        oscLow.stop(now + 0.28);
      } else if (kind === "gasp" || kind === "sigh") {
        // Breath sigh / gasp harmonic glide
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        const startF = kind === "gasp" ? 520 : 440;
        const endF = kind === "gasp" ? 740 : 290;
        osc.frequency.setValueAtTime(startF, now);
        osc.frequency.exponentialRampToValueAtTime(endF, now + 0.32);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.085, now + 0.06);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        osc.stop(now + 0.36);
      } else if (kind === "moan") {
        const amp = Math.max(0.3, Math.min(1, Number(pitchMod) || 0.4));
        const dur = 0.32 + amp * 0.7;
        const f0 = 240 + amp * 160;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.04 + amp * 0.18, now + 0.07 + amp * 0.05);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        connectCompanionReactionOut(g, reactionTone, ctx);
        [1, 2.05].forEach((partial, idx) => {
          const osc = ctx.createOscillator();
          osc.type = idx === 0 ? "sine" : "triangle";
          osc.frequency.setValueAtTime(f0 * partial, now);
          osc.frequency.exponentialRampToValueAtTime(f0 * partial * (1.08 + amp * 0.45), now + dur * 0.42);
          osc.frequency.exponentialRampToValueAtTime(f0 * partial * (0.92 + amp * 0.12), now + dur);
          osc.connect(g);
          osc.start(now);
          osc.stop(now + dur);
        });
      } else if (kind === "spank") {
        // Crisp playful smack transient + breathless high gasp
        const smackOsc = ctx.createOscillator();
        const smackGain = ctx.createGain();
        smackOsc.type = "triangle";
        smackOsc.frequency.setValueAtTime(310, now);
        smackOsc.frequency.exponentialRampToValueAtTime(68, now + 0.055);
        smackGain.gain.setValueAtTime(0.001, now);
        smackGain.gain.linearRampToValueAtTime(0.22, now + 0.008);
        smackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        smackOsc.connect(smackGain);
        connectCompanionReactionOut(smackGain, reactionTone, ctx);
        smackOsc.start(now);
        smackOsc.stop(now + 0.07);
        // Followed by a cute breathless gasp
        const gaspOsc = ctx.createOscillator();
        const gaspGain = ctx.createGain();
        gaspOsc.type = "sine";
        gaspOsc.frequency.setValueAtTime(540, now + 0.07);
        gaspOsc.frequency.exponentialRampToValueAtTime(860, now + 0.24);
        gaspGain.gain.setValueAtTime(0.001, now + 0.07);
        gaspGain.gain.linearRampToValueAtTime(0.095, now + 0.12);
        gaspGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        gaspOsc.connect(gaspGain);
        connectCompanionReactionOut(gaspGain, reactionTone, ctx);
        gaspOsc.start(now + 0.07);
        gaspOsc.stop(now + 0.34);
      } else if (kind === "clink") {
        // Crystal champagne glass chime (two high metallic partials)
        [1568, 2352].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, now + idx * 0.015);
          g.gain.setValueAtTime(0.001, now + idx * 0.015);
          g.gain.linearRampToValueAtTime(idx === 0 ? 0.11 : 0.07, now + idx * 0.015 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0008, now + 0.55 + idx * 0.1);
          osc.connect(g);
          connectCompanionReactionOut(g, reactionTone, ctx);
          osc.start(now + idx * 0.015);
          osc.stop(now + 0.68);
        });
      } else if (kind === "pop") {
        // Crisp soap bubble pop sound with rising combo pitch
        const pScale = pitchMod || 1;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(380 * pScale, now);
        osc.frequency.exponentialRampToValueAtTime(1320 * pScale, now + 0.055);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.16, now + 0.012);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        osc.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        osc.stop(now + 0.07);
      } else if (kind === "dizzy") {
        // Comical playful dizzy warble
        [0, 0.12, 0.24, 0.36].forEach((offset, idx) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "triangle";
          const f1 = idx % 2 === 0 ? 520 : 690;
          const f2 = idx % 2 === 0 ? 690 : 480;
          osc.frequency.setValueAtTime(f1, now + offset);
          osc.frequency.linearRampToValueAtTime(f2, now + offset + 0.11);
          g.gain.setValueAtTime(0.001, now + offset);
          g.gain.linearRampToValueAtTime(0.08, now + offset + 0.03);
          g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.12);
          osc.connect(g);
          connectCompanionReactionOut(g, reactionTone, ctx);
          osc.start(now + offset);
          osc.stop(now + offset + 0.13);
        });
      } else if (kind === "pounce") {
        // Playful cat-pounce chirp
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(360, now);
        osc.frequency.exponentialRampToValueAtTime(940, now + 0.09);
        osc.frequency.exponentialRampToValueAtTime(620, now + 0.18);
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.12, now + 0.025);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
        osc.connect(g);
        connectCompanionReactionOut(g, reactionTone, ctx);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (kind === "cupid") {
        // Sparkling harp arpeggio
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "sine";
          const t0 = now + idx * 0.055;
          osc.frequency.setValueAtTime(freq, t0);
          g.gain.setValueAtTime(0.001, t0);
          g.gain.linearRampToValueAtTime(0.09, t0 + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.38);
          osc.connect(g);
          connectCompanionReactionOut(g, reactionTone, ctx);
          osc.start(t0);
          osc.stop(t0 + 0.4);
        });
      } else if (kind === "whisper") {
        // Soft velvet breathy harmonic chord when she starts speaking
        [290, 435].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, now);
          osc.frequency.exponentialRampToValueAtTime(freq * 0.88, now + 0.28);
          g.gain.setValueAtTime(0.001, now);
          g.gain.linearRampToValueAtTime(idx === 0 ? 0.045 : 0.028, now + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0008, now + 0.3);
          osc.connect(g);
          connectCompanionReactionOut(g, reactionTone, ctx);
          osc.start(now);
          osc.stop(now + 0.32);
        });
      }
    } catch (_) {}
  }

  function recordFavoriteInteraction(win, reason) {
    if (!reason || reason === "init" || !win || !win.localStorage) return;
    try {
      const key = "hq_companion_fav_acts_v1";
      const raw = win.localStorage.getItem(key);
      const map = raw ? JSON.parse(raw) : {};
      const clean = String(reason).slice(0, 48);
      map[clean] = (Number(map[clean]) || 0) + 1;
      win.localStorage.setItem(key, JSON.stringify(map));
      S.favActsMap = map;
    } catch (_) {}
  }

  function getSessionTensionInfo(win) {
    const now = Date.now();
    if (!S.sessionStartAt) S.sessionStartAt = now;
    const mins = Math.max(0, Math.floor((now - S.sessionStartAt) / 60000));
    const w = typeof S.warmth === "number" ? S.warmth : 22;
    const score = w + Math.min(45, mins * 2.5);
    let level = 1;
    let label = "Complice & Charmeuse";
    if (score >= 92) {
      level = 4;
      label = "Obéissante & Dévergondée 🔥";
    } else if (score >= 68) {
      level = 3;
      label = "Brûlante & Sans filtre 🔥";
    } else if (score >= 42) {
      level = 2;
      label = "Troublée & Attirée ♥";
    }
    let topFavs = "";
    try {
      const map = S.favActsMap || JSON.parse((win && win.localStorage && win.localStorage.getItem("hq_companion_fav_acts_v1")) || "{}");
      const sorted = Object.entries(map)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 2)
        .map((e) => e[0]);
      if (sorted.length) topFavs = sorted.join(", ");
    } catch (_) {}
    return { level, label, mins, warmth: Math.round(w), topFavs };
  }

  function syncLargePortraitCaption(win) {
    if (!S.largePortraitCaption) return;
    const info = getSessionTensionInfo(win);
    S.largePortraitCaption.textContent = "Niv. " + info.level + " · " + info.label + " (" + info.warmth + "%)";
  }

  function addArousalWarmth(win, delta, reason) {
    if (delta > 0 && reason && reason !== "init") {
      recordFavoriteInteraction(win, reason);
      if (!Array.isArray(S.recentInteractions)) S.recentInteractions = [];
      const cleanReason = String(reason).trim().slice(0, 64);
      if (cleanReason && S.recentInteractions[S.recentInteractions.length - 1] !== cleanReason) {
        S.recentInteractions.push(cleanReason);
        if (S.recentInteractions.length > 6) S.recentInteractions.shift();
      }
    }
    const cur = typeof S.warmth === "number" ? S.warmth : 22;
    const next = Math.max(10, Math.min(100, cur + delta));
    S.warmth = next;
    if (delta > 0 && reason && /poitrine|claquement|relâchement|relachement|tirée|tiree|contact charnel/i.test(String(reason))) {
      S.contactWarmthSession = clampNum((S.contactWarmthSession || 0) + delta, 0, 120);
    }
    frameHeatMilestone(win, cur, next);
    syncLargePortraitCaption(win);
    if (S.el) {
      S.el.style.setProperty("--arousal-pct", String(Math.round(next)));
      S.el.style.setProperty("--companion-warm", (next / 100).toFixed(3));
      S.el.classList.toggle("is-steamy-glass", next >= 74 && S.nsfwOn);
      S.el.classList.toggle("is-lewd-heat", next >= 52 && S.nsfwOn);
    }
    if (S.arousalRing) {
      S.arousalRing.title = "Désir & Chaleur : " + Math.round(next) + "%";
    }
    syncWarmthToForgeIntensity(win);
    if (S.nsfwOn && delta >= 3 && reason && /caress|poitrine|décolleté|décollete|tirée|tiree|claquement|charnel|gorge|bulle|fessée|spank|slingshot/i.test(String(reason))) {
      triggerBustAfterglow(win, clampNum(delta / 22, 0.32, 1), 11000 + delta * 40);
    }
    if (next >= 100 && !S.feverActive && S.nsfwOn) {
      S.feverActive = true;
      const windup = beginReactionWindup(win);
      const fireClimax = () => {
      if (S.el) S.el.classList.add("is-fever-climax");
      playLewdPhaseWav(win, "climax_fever");
      playVocalSynthFx(win, "gasp");
      const isAdult = !!(S.nsfwOn && S.el && S.el.classList.contains("is-nsfw"));
      if (isAdult && adultFxAllowed(win)) {
        playAdultFx(win, "flash", 1100);
      }
      triggerInteractiveAiReaction(
        win,
        "Ta jauge de désir et de chaleur vient d'atteindre 100% (Fever Climax) à force des caresses et gâteries de Marco (" + (reason || "caresses") + ")",
        [
          "Mmh… Maître, ma jauge est à 100%, tu me fais complètement perdre la tête sur {view} 🔥♥",
          "Je brûle toute entière pour toi mon amour… regarde dans quel état tu me mets 🔥♥",
          "Ah… je n'en peux plus d'attendre quand tu me chauffes comme ça, Maître ♥"
        ]
      );
      win.setTimeout(() => {
        S.feverActive = false;
        S.warmth = 45;
        if (S.el) {
          S.el.classList.remove("is-fever-climax");
          S.el.style.setProperty("--arousal-pct", "45");
        }
      }, 9000);
      };
      if (windup) win.setTimeout(fireClimax, windup);
      else fireClimax();
    }
  }

  // ---- Expressive frame around the Adulte avatar: mood tint, heartbeat, heat gauge, cursor lean,
  // voice ring, kiss marks, orbiting hearts, rim badges and a time-of-day tint. Visuals live in CSS;
  // this only builds the layer and feeds it state.
  function buildCompanionFrame(win, av) {
    const doc = win.document;
    const mk = (cls, parent, tag) => {
      const el = doc.createElement(tag || "span");
      el.className = cls;
      if (parent) parent.appendChild(el);
      return el;
    };
    const frame = mk("hq-companion-frame");
    frame.setAttribute("aria-hidden", "true");
    mk("hq-frame-beat", frame);
    mk("hq-frame-lean", frame);
    const ticks = mk("hq-frame-ticks", frame);
    for (let i = 0; i < 12; i += 1) mk("hq-frame-tick" + (i % 3 === 0 ? " is-major" : ""), ticks).style.setProperty("--i", i);
    mk("hq-frame-spark", mk("hq-frame-spark-arm", frame));
    const voice = mk("hq-frame-voice", frame);
    for (let i = 0; i < 18; i += 1) {
      const seg = mk("hq-frame-voice-seg", voice);
      seg.style.setProperty("--i", i);
      seg.style.setProperty("--k", (0.55 + ((i * 7) % 5) * 0.16).toFixed(2));
    }
    const orbit = mk("hq-frame-orbit", frame);
    for (let i = 0; i < 8; i += 1) {
      const arm = mk("hq-frame-orbit-arm", orbit);
      arm.style.setProperty("--i", i);
      mk("hq-frame-orbit-bit", arm, "i");
    }
    S.frameKisses = mk("hq-frame-kisses", frame);
    const badges = mk("hq-frame-badges", frame);
    S.frameBadges = {
      night: mk("hq-frame-badge is-night", badges),
      voice: mk("hq-frame-badge is-voice", badges),
      forge: mk("hq-frame-badge is-forge", badges),
      fresh: mk("hq-frame-badge is-fresh", badges),
    };
    S.frameBadges.night.textContent = "🌙";
    S.frameBadges.voice.textContent = "🔊";
    S.frameBadges.forge.textContent = "✦";
    mk("hq-frame-ripple", frame);
    av.appendChild(frame);
    S.frame = frame;

    // Lean: the side of the ring facing the cursor brightens as it approaches.
    let leanRaf = 0;
    let lastPt = null;
    let leanRect = null;
    const paintLean = (now) => {
      leanRaf = 0;
      if (!S.el || !lastPt || !S.el.classList.contains("is-nsfw") || S.el.classList.contains("is-minimal")) return;
      // Reading layout forces a restyle; a rect a few hundred ms old is plenty for a glow direction.
      // Never re-measure mid-pull: the pull rewrites styles every move, so a read here would force a
      // full style recalculation inside the frame. The last rect is plenty for the glow direction.
      const pulling = !!(S.bustPull && S.bustPull.active);
      if (!leanRect || !pulling) {
        leanRect = cachedRect(win, av, 400);
      }
      const r = leanRect;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = lastPt.x - cx;
      const dy = lastPt.y - cy;
      const reach = r.width / 2 + 220;
      const strength = clampNum(1 - (Math.hypot(dx, dy) - r.width / 2) / (reach - r.width / 2), 0, 1);
      frame.style.setProperty("--lean-angle", ((Math.atan2(dy, dx) * 180) / Math.PI + 90).toFixed(1) + "deg");
      frame.style.setProperty("--lean", strength.toFixed(3));
      // Depth cues read this in the frame loop: cursor direction (-1..1) weighted by closeness.
      S.cursorDepth = { x: clampNum(dx / reach, -1, 1) * strength, y: clampNum(dy / reach, -1, 1) * strength };
      syncBustNormalLight(dx, dy, strength);
      // The cursor is a small lamp over her bust: position in the portrait's own % space.
      if (S.bustLights) {
        const lx = clampNum(((lastPt.x - r.left) / r.width) * 100, -30, 130).toFixed(1) + "%";
        const ly = clampNum(((lastPt.y - r.top) / r.height) * 100, -30, 130).toFixed(1) + "%";
        const la = (0.25 + strength * 0.75).toFixed(3);
        S.bustLights.forEach((el) => {
          el.style.setProperty("--lamp-x", lx);
          el.style.setProperty("--lamp-y", ly);
          el.style.setProperty("--lamp-a", la);
        });
      }
    };
    win.addEventListener(
      "pointermove",
      (ev) => {
        if (ev.pointerType === "touch" || calm(win)) return;
        lastPt = { x: ev.clientX, y: ev.clientY };
        if (!leanRaf) leanRaf = win.requestAnimationFrame(paintLean);
      },
      { passive: true }
    );
    // Poke: a quick squish and a ripple off the rim.
    av.addEventListener("pointerdown", () => {
      if (!S.el || !S.el.classList.contains("is-nsfw") || calm(win)) return;
      frame.classList.remove("is-poked");
      void frame.offsetWidth;
      frame.classList.add("is-poked");
      win.clearTimeout(S.framePokeT);
      S.framePokeT = win.setTimeout(() => frame.classList.remove("is-poked"), 700);
    });
    syncCompanionFrame(win);
    win.setInterval(() => { if (!win.document.hidden) syncCompanionFrame(win); }, 1000); // motion1: hidden-tab guard
    win.document.addEventListener("visibilitychange", () => { if (!win.document.hidden) syncCompanionFrame(win); });
    return frame;
  }

  function frameMoodOf(win) {
    const el = S.el;
    if (!el) return "playful";
    if (el.classList.contains("is-mood-celebrate")) return "celebrate";
    if (el.classList.contains("is-mood-error")) return "pout";
    if (el.classList.contains("is-fever-climax") || el.classList.contains("is-lewd-heat")) return "hot";
    const portraitMood = S.adultPortrait && S.adultPortrait.dataset.mood;
    if (el.classList.contains("is-mood-afterglow") || portraitMood === "tender" || portraitMood === "soft") return "tender";
    if (el.classList.contains("is-time-latenight") && (S.warmth || 22) < 40) return "sleepy";
    return "playful";
  }

  // With the layered portrait, the frame lives inside the rig body just under the breast layer
  // (rig-garment-front), so only her breasts come over the ring; everything else of the portrait
  // stays under it. CSS cancels the body's own sway on the frame. Otherwise it sits on the avatar.
  function placeCompanionFrame() {
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!av || !S.frame) return;
    const body = S.el.classList.contains("has-layered-portrait") ? av.querySelector(".hq-companion-rig-body") : null;
    const garment = body && body.querySelector(":scope > .hq-companion-rig-garment-front");
    const host = garment ? body : av;
    const changed = S.frame.parentElement !== host || S.frame.classList.contains("is-in-rig") !== !!garment;
    S.frame.classList.toggle("is-in-rig", !!garment);
    if (S.frame.parentElement !== host) host.appendChild(S.frame);
    if (changed) {
      // Host/class changes alter stylesheet-derived readers. Refresh only on
      // this transition, including static reduced-motion posture after loading.
      S.l2dVarSheets = -1;
      const cache = ensureLive2DState().styleCache;
      if (cache) for (const key of Object.keys(cache)) if (key.startsWith("--rig-posture-")) delete cache[key];
      applyRigPostureSetting(S.win);
    }
  }

  // One light layer per breast, masked by that breast's own cutout so the light only lands on her
  // skin: a soft highlight from the cursor "lamp" plus a rim light in the frame's mood colour.
  function ensureBustLights(win) {
    const stacks = S.el.querySelectorAll(".hq-companion-rig-bust-stack-left, .hq-companion-rig-bust-stack-right");
    if (!stacks.length) {
      S.bustLights = null;
      S.bustCastResize?.disconnect();
      S.bustCastResize = null;
      S.bustCastReceiver = null;
      S.bustCastSize = 0;
      S.bustCasts = null;
      S.bustSpecs = null;
      return;
    }
    stacks.forEach((stack) => {
      const side = stack.classList.contains("hq-companion-rig-bust-stack-left") ? "left" : "right";
      const garment = stack.parentElement;
      let receiver = garment.querySelector(":scope > .hq-bust-cast-receiver");
      if (!receiver) {
        receiver = win.document.createElement("span");
        receiver.className = "hq-bust-cast-receiver";
        receiver.setAttribute("aria-hidden", "true");
        const surface = win.document.createElement("span");
        surface.className = "hq-bust-cast-surface";
        receiver.append(surface);
        // One shared receiving plane below BOTH foreground stacks. A shadow
        // inside the right stack could otherwise paint over the left breast.
        garment.insertBefore(receiver, garment.firstChild);
      }
      // Migrate the old in-stack shadow if the rig is refreshed in place.
      stack.querySelector(":scope > .hq-bust-cast")?.remove();
      if (!receiver.querySelector(".hq-bust-cast.is-" + side)) {
        const cast = win.document.createElement("span");
        cast.className = "hq-bust-cast is-" + side;
        receiver.firstChild.append(cast);
      }
      if (!stack.querySelector(":scope > .hq-bust-spec")) {
        const spec = win.document.createElement("span");
        spec.className = "hq-bust-spec is-" + side;
        spec.setAttribute("aria-hidden", "true");
        spec.append(win.document.createElement("i"));
        stack.insertBefore(spec, stack.querySelector(":scope > .hq-bust-light"));
      }
      if (!garment.classList.contains("has-bust-specular")) garment.classList.add("has-bust-specular");
      if (stack.querySelector(":scope > .hq-bust-light")) return;
      // Press dent: a soft pressed-in shading under the finger, cut to the same breast outline.
      const dent = win.document.createElement("span");
      dent.className = "hq-bust-dent is-" + side;
      dent.setAttribute("aria-hidden", "true");
      // Skin ripple: rings spread from an impact point, cut to the same breast outline.
      const ripple = win.document.createElement("span");
      ripple.className = "hq-bust-ripple is-" + side;
      ripple.setAttribute("aria-hidden", "true");
      stack.append(ripple);
      // Normal-map light (Lumière 3D): four baked darkness layers, one per light direction.
      const nl = win.document.createElement("span");
      nl.className = "hq-bust-nl is-" + side;
      nl.setAttribute("aria-hidden", "true");
      for (const k of ["l", "r", "u", "d"]) {
        const layer = win.document.createElement("i");
        layer.className = "is-" + k;
        nl.append(layer);
      }
      stack.append(nl);
      const shade = win.document.createElement("span");
      shade.className = "hq-bust-shade is-" + side;
      shade.setAttribute("aria-hidden", "true");
      const light = win.document.createElement("span");
      light.className = "hq-bust-light is-" + side;
      light.setAttribute("aria-hidden", "true");
      stack.append(dent, shade, light);
    });
    S.bustLights = Array.from(S.el.querySelectorAll(".hq-bust-light"));
    S.bustDents = Array.from(S.el.querySelectorAll(".hq-bust-dent"));
    S.bustNl = Array.from(S.el.querySelectorAll(".hq-bust-nl"));
    S.bustNlKey = "";
    S.bustCasts = {};
    S.el.querySelectorAll(".hq-bust-cast").forEach((el) => (S.bustCasts[el.classList.contains("is-left") ? "left" : "right"] = el));
    S.bustSpecs = {};
    // Stack width to turn the rig's px travel into % (frame sync, not per frame).
    S.bustSpecSize = stacks[0].offsetWidth || S.bustSpecSize || 0;
    S.el.querySelectorAll(".hq-bust-spec").forEach((host) => {
      const left = host.classList.contains("is-left");
      S.bustSpecs[left ? "left" : "right"] = host.firstChild;
    });
    installBustSheenMirrors(win);
    const receiver = stacks[0].parentElement.querySelector(":scope > .hq-bust-cast-receiver");
    if (S.bustCastReceiver !== receiver) {
      S.bustCastResize?.disconnect();
      S.bustCastReceiver = receiver;
      S.bustCastResize = null;
      S.bustCastSize = 0;
      if (win.ResizeObserver) {
        S.bustCastResize = new win.ResizeObserver((entries) => {
          if (S.bustCastReceiver !== receiver || !receiver.isConnected) return;
          const size = entries[0].contentRect.width;
          if (size > 0 && size !== S.bustCastSize) {
            S.bustCastSize = size;
            updateBustCastProjection(win, ensureLive2DState(), isCompactUI(win));
          }
        });
        S.bustCastResize.observe(receiver);
      }
    }
    // Older engines keep the low-frequency fallback. ResizeObserver supplies
    // fractional layout pixels before paint, without a synchronous layout read.
    if (!win.ResizeObserver) S.bustCastSize = parseFloat(win.getComputedStyle(stacks[0]).width) || 0;
    S.bustShades = {};
    S.el.querySelectorAll(".hq-bust-shade").forEach((el) => (S.bustShades[el.classList.contains("is-left") ? "left" : "right"] = el));
    S.bustRipples = {};
    S.el.querySelectorAll(".hq-bust-ripple").forEach((el) => (S.bustRipples[el.classList.contains("is-left") ? "left" : "right"] = el));
    // Also initialize the static projection when reduced motion suppresses RAF.
    updateBustCastProjection(win, ensureLive2DState(), isCompactUI(win));
  }

  function updateBustCastProjection(win, st, compact) {
    // Portrait-only mode hides the cast receiver, but its independent skin
    // highlights must still update even when the receiver has no layout size.
    updateBustSpecular(win, st, compact);
    const size = S.bustCastSize;
    if (!size || !S.bustCasts) return;
    // Resolve the existing in-memory outputs, without adding CSS readers that
    // would widen live2dVarScope or forcing computed-style/layout reads per frame.
    const cache = st.styleCache || {};
    const pull = S.pullVars || {};
    const value = (key, fallback = 0) => {
      const raw = pull[key] !== undefined ? pull[key] : cache[key];
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    for (const side of ["left", "right"]) {
      const cast = S.bustCasts[side];
      if (!cast) continue;
      const left = side === "left";
      const rig = "--rig-bust-" + side;
      const lobe = "--pull-lobe-" + side;
      const press = value("--pull-press-" + side);
      const k = parseFloat(cast.__castK) || 0;
      // Projection P comes before stack A and local breast B: P * A * B.
      // Its light direction and distance cannot rotate/stretch with A or B.
      const ox = size * (left ? 0.34 : 0.66), oy = size * 0.48;
      const tx = value(rig + "-x") + value(lobe + "-x") + value("--pull-seam-" + side + "-x");
      const ty = value(rig + "-y") + value(lobe + "-y", value("--pull-lobe-y")) +
        value("--pull-seam-" + side + "-y") - 10 + value("--rig-body-bob") + value("--rig-bust-heave") * 0.94;
      const sx = value(rig + "-sx", 1) * (1 + press * 0.5) * value("--pull-lobe-sx", 1) *
        value("--rig-bust-lobe-scale", 1) * value("--rig-bust-seam-stretch-x", 1);
      const sy = value(rig + "-sy", 1) * (1 - press) * value(lobe + "-sy", value("--pull-lobe-sy", 1)) *
        value("--rig-bust-lobe-scale", 1) * value("--rig-bust-seam-stretch-y", 1);
      const bx = size * (left ? 0.38 : 0.62), by = size * 0.5;
      const px = size * (left ? -0.10 : 0.02), py = size * 0.06;
      let preX = 1, preY = 1;
      if (!compact) {
        const disp = value("--rig-bust-disp-scale"), support = value("--cursor-support-" + side);
        preX += disp * 0.0035 + support * 0.11;
        preY += disp * 0.0042 - support * 0.13;
      }
      // Expand the affine product directly: avoid allocating native DOMMatrix
      // objects on every physics/pull update. CSS remains the reference in QA.
      const angle = value(rig + "-twist") * Math.PI / 180;
      const bend = Math.tan(value(rig + "-bend") * Math.PI / 180);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const vsx = value(rig + "-vsx", 1), vsy = value(rig + "-vsy", 1);
      const a = preX * cos * vsx, b = preY * sin * vsx;
      const c = preX * (cos * bend - sin) * vsy, d = preY * (sin * bend + cos) * vsy;
      const e = bx + preX * px - a * (px + bx) - c * (py + by);
      const f = by + preY * py - b * (px + bx) - d * (py + by);
      const squash = 0.985;
      const projected = [sx * a, squash * sy * b, sx * c, squash * sy * d,
        sx * e + tx + ox * (1 - sx),
        squash * (sy * f + ty + oy * (1 - sy)) + size * (0.75 * (1 - squash) + 0.022 + k * 0.008)];
      const matrix = "matrix(" + projected.map(n => n.toFixed(5)).join(",") + ")";
      if (cast.__castMatrix !== matrix) {
        cast.__castMatrix = matrix;
        cast.style.transform = matrix;
      }
    }
  }

  function updateBustSpecular(win, st, compact) {
    if (!S.bustSpecs) return;
    const cache = st.styleCache || {}, pull = S.pullVars || {};
    const num = (key, fallback = 0) => {
      const n = parseFloat(pull[key] !== undefined ? pull[key] : cache[key]);
      return Number.isFinite(n) ? n : fallback;
    };
    const reduced = calm(win);
    for (const side of ["left", "right"]) {
      const el = S.bustSpecs[side];
      if (!el) continue;
      const rig = "--rig-bust-" + side, lobe = "--pull-lobe-" + side;
      // Translation and deformation are inherited once from the stack (never
      // re-added here), which alone would carry the reflection like a decal.
      // A fixed light's reflection depends on how the breast is TURNED
      // relative to it, so every animation's turn is gathered here as pitch
      // (front up/down), yaw (left/right) and roll (in the picture plane):
      //  - swing: pulls, bounces, slaps and squeezes move the breast about its
      //    chest pivot (the rig shows this as travel and stretch);
      //  - heave (breathing), body 3D tilt toward the cursor, body lean and
      //    posture.
      // Pure whole-body translation (bob) does not turn anything, so it is
      // ignored, as are the duplicate roll/slosh signals.
      const dome = BUST_SPEC_DOME[side];
      let turn = 0, sweep = 0, ax = 1, ay = 1;
      if (!reduced) {
        const size = S.bustSpecSize || 170, pivot = size * 0.35;
        const deg = 180 / Math.PI;
        const travelX = num(rig + "-x") + num(lobe + "-x") + num("--pull-seam-" + side + "-x");
        const travelY = num(rig + "-y") + num(lobe + "-y", num("--pull-lobe-y")) +
          num("--pull-seam-" + side + "-y") + num("--rig-bust-heave") * 0.94;
        const press = num("--pull-press-" + side);
        // Cursor proximity reshapes the breast too (the scale3d in its CSS):
        // displacement swell and the support lift, which squashes it upward.
        const disp = compact ? 0 : num("--rig-bust-disp-scale");
        const support = compact ? 0 : num("--cursor-support-" + side);
        // Her own idle shape (the rig's sx/sy) averages slightly stretched,
        // which is not a deformation: measure it against its long-term mean
        // (~8 s), so each breath (a 4-6 s squash/stretch) still reshapes the
        // highlight instead of being cancelled. Interaction reshaping (pull, press, seam, posture, cursor)
        // is measured from neutral, so a HELD pull or lift keeps its sweep.
        const own = num(rig + "-sy", 1) / Math.max(0.5, num(rig + "-sx", 1));
        const acted = (1 - press) * num(lobe + "-sy", num("--pull-lobe-sy", 1)) *
          num("--rig-bust-seam-stretch-y", 1) * num("--rig-posture-" + side + "-sy", 1) *
          (1 + disp * 0.0042 - support * 0.13) /
          Math.max(0.5, (1 + press * 0.5) * num("--pull-lobe-sx", 1) * num("--rig-bust-seam-stretch-x", 1) *
          num("--rig-posture-" + side + "-sx", 1) * (1 + disp * 0.0035 + support * 0.11));
        const clock = win && win.performance ? win.performance.now() : 0;
        if (!clock || !Number.isFinite(el.__stretchBase)) el.__stretchBase = clock ? own : 1;
        else el.__stretchBase += (own - el.__stretchBase) *
          (1 - Math.exp(-Math.min(100, Math.max(0, clock - (el.__stretchAt || clock))) / 8000));
        el.__stretchAt = clock;
        const stretch = own - el.__stretchBase + acted;
        // --rig-posture-rotation is "x 0 z <angle>deg" (rotate3d axis-angle).
        const pr = String(cache["--rig-posture-rotation"] || "").trim().split(/\s+/).map(parseFloat);
        const pAxis = Math.hypot(pr[0] || 0, pr[2] || 0) || 1, pAngle = Number.isFinite(pr[3]) ? pr[3] : 0;
        // The cursor's support lift raises the breast: a small upward pitch.
        const pitch = num("--rig-tilt-x") - Math.atan2(travelY, pivot) * deg + support * 6.6 +
          pAngle * (pr[0] || 0) / pAxis;
        // Compression and elongation reshape the highlight rather than slide
        // it. The layer already squashes/stretches with the skin like a decal;
        // a reflection on a dome squashed by S changes by S once more (the
        // surface tilts S times faster), centred on the front of the dome. So
        // a breast pressed flatter and wider gets a wider, flatter highlight,
        // and a stretched one a longer, slimmer one. stretch is the height /
        // width ratio against her rest shape; exaggerated (power 0.75 per axis).
        const aspect = clampNum(stretch, 0.7, 1.4);
        ay = Math.round(Math.pow(aspect, 0.75) * 1000) / 1000;
        ax = Math.round(Math.pow(aspect, -0.75) * 1000) / 1000;
        const yaw = num("--rig-tilt-y") + Math.atan2(travelX, pivot) * deg;
        const roll = num(rig + "-twist") + (num(rig + "-bend") + num("--rig-posture-" + side + "-bend")) * 0.6 +
          num("--rig-body-tilt") + pAngle * (pr[2] || 0) / pAxis;
        // The band runs lengthwise, root -> tip (meridians on the dome, all
        // converging where the breast hangs from the chest). It moves WITH the
        // breast:
        //  - side to side (swing, turn, roll) steps it across the fan of
        //    meridians (the baked sweep frames), right with her going right;
        //  - up and down (swing, pull, lift, breathing heave) slides it along
        //    its own length, toward the tip when she drops.
        // Exaggerated so ordinary bounces read; soft tanh limits keep it on
        // visible skin and never freeze it.
        // Calm gains: the highlight trails the skin slightly rather than
        // outrunning it (a reflection mostly stays put as the skin moves).
        const across = yaw * 1.4 + roll * 1.0;   // the fan spreads at the rim: the root moves most
        const lim = across > 0 ? BUST_SPEC_SWEEP.right[side] : BUST_SPEC_SWEEP.left[side];
        sweep = lim * Math.tanh(across / lim);
        const along = -pitch * 0.3;
        turn = 6 * Math.tanh(along / 6);
      }
      // The rig hands a pull between variables in one frame (pull start and
      // release), which made the reflection snap while the breast stayed
      // smooth. A speed limit (not smoothing, which lagged behind fast bounces)
      // passes normal jiggle through untouched and spreads only those jumps
      // over a few frames.
      const now = win && win.performance ? win.performance.now() : 0;
      if (now && el.__arcAt && !reduced) {
        const dt = Math.min(100, Math.max(0, now - el.__arcAt)) / 1000;
        const sweepMax = 900 * dt, turnMax = 90 * dt;
        sweep = el.__arcSweep + clampNum(sweep - el.__arcSweep, -sweepMax, sweepMax);
        turn = el.__arcTurn + clampNum(turn - el.__arcTurn, -turnMax, turnMax);
      }
      el.__arcAt = now;
      el.__arcTurn = turn;
      el.__arcSweep = sweep;
      if (Math.abs(turn) < 0.0005) turn = 0;
      // Turn about the dome centre on its oval (CSS transform-origin).
      // Slide along the root -> tip axis (turn holds that slide, in % of the
      // layer), then the squash/stretch reshape about the dome centre.
      const tip = BUST_SPEC_SWEEP.tip[side];
      const matrix = bustSpecularArcMatrix(dome, 0, 1, ax, ay);
      const slide = Math.abs(turn) < 0.01 ? "" :
        "translate(" + (tip[0] * turn).toFixed(2) + "%," + (tip[1] * turn).toFixed(2) + "%)";
      const transform = slide ? (matrix === "none" ? slide : slide + " " + matrix) : matrix;
      // Sweep across the fan: crossfade the two neighbouring baked frames.
      const f = BUST_SPEC_SWEEP.rest + sweep / BUST_SPEC_SWEEP.step;
      const fa = clampNum(Math.floor(f), 0, BUST_SPEC_SWEEP.frames - 1);
      const fb = Math.min(fa + 1, BUST_SPEC_SWEEP.frames - 1);
      const w = fb === fa ? "0" : (Math.round((f - fa) * 20) / 20).toFixed(2);
      const cell = (k) => (k % 5) * 25 + "% " + Math.floor(k / 5) * 25 + "%";
      const frameA = cell(fa), frameB = cell(fb);
      if (el.__specA !== frameA) { el.__specA = frameA; el.style.setProperty("--spec-a", frameA); }
      if (el.__specB !== frameB) { el.__specB = frameB; el.style.setProperty("--spec-b", frameB); }
      if (el.__specW !== w) { el.__specW = w; el.style.setProperty("--spec-w", w); }
      const opacity = (reduced ? 0.84 : 0.95).toFixed(2);
      if (el.__specTransform !== transform) {
        el.__specTransform = transform;
        el.style.transform = transform;
      }
      if (el.__specOpacity !== opacity) {
        el.__specOpacity = opacity;
        el.style.opacity = opacity;
      }
    }
  }

  // Baked sweep atlas (artifacts/cast-shadow/bake_breast_gloss.py): 25 frames,
  // 5x5, meridian bands 3deg apart across the fan; frame 12 is rest.
  const BUST_SPEC_SWEEP = { step: 3, frames: 25, rest: 12,
    // Symmetric bands (each lengthwise down its own breast) driven by the same
    // amounts with shared limits, so whole-body motion moves them in unison.
    // Soft limits across the fan (degrees), keyed by direction of travel then
    // breast: past ~+25deg the right band slides under the lace.
    // Upward travel (both, to stay in unison) stops at 12deg: past ~frame 8 the left oval leaves the skin.
    right: { left: 25, right: 25 }, left: { left: 12, right: 12 },
    // Root -> tip direction (image space), as in the bake's ROOT.
    tip: { left: [-0.705, 0.709], right: [0.699, 0.715] } };

  // Oval fitted to each displayed cutout (stack fractions; t in radians).
  // Mirrors --spec-ox/--spec-oy in hq-companion-adult-fx.css.
  const BUST_SPEC_DOME = {
    left: { cx: 0.276, cy: 0.749, a: 0.155, b: 0.213, t: 42.9 * Math.PI / 180 },
    right: { cx: 0.636, cy: 0.764, a: 0.189, b: 0.208, t: 128.6 * Math.PI / 180 }
  };

  function bustSpecularArcMatrix(dome, turn, step, ax = 1, ay = 1) {
    if (!turn && step === 1 && ax === 1 && ay === 1) return "none";
    const ct = Math.cos(dome.t), st = Math.sin(dome.t);
    const cp = Math.cos(turn) * step, sp = Math.sin(turn) * step;
    // Inner: diag(a,b) * [cp -sp; sp cp] * diag(1/a,1/b)
    const i11 = cp, i12 = -sp * dome.a / dome.b, i21 = sp * dome.b / dome.a, i22 = cp;
    // X = inner * R(-t), with R(-t) = [ct st; -st ct]
    const x11 = i11 * ct - i12 * st, x12 = i11 * st + i12 * ct;
    const x21 = i21 * ct - i22 * st, x22 = i21 * st + i22 * ct;
    // M = R(t) * X, with R(t) = [ct -st; st ct]
    const m11 = ct * x11 - st * x21, m12 = ct * x12 - st * x22;
    const m21 = st * x11 + ct * x21, m22 = st * x12 + ct * x22;
    // Then the squash/stretch reshape (screen axes, about the same centre).
    return "matrix(" + (m11 * ax).toFixed(4) + "," + (m21 * ax).toFixed(4) + "," + (m12 * ay).toFixed(4) + "," + (m22 * ay).toFixed(4) + ",0,0)";
  }

  // Idle and breathing motion is mostly CSS keyframes on ancestors of the
  // breasts (avatar bob, av-stack bounce/shimmy/wobble/sway, torso...). The
  // reflection rides along rigidly, which reads as a sticker. Mirror each such
  // animation onto the reflection, scaled, so the highlight reacts with the
  // breast: a small share of the travel, the same rotation, the same squash/stretch
  // again about the dome centre (the physical reshape of a reflection).
  // Keyframes are read once when an animation starts, never per frame; the
  // copy runs on the compositor and composites with the JS-written transform.
  const BUST_SHEEN_MIRROR_TRAVEL = 0.18;
  function bustSheenSplit(value) {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of String(value).trim()) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === " " && !depth) { if (cur) out.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function bustSheenMirrorKeyframes(frames, travel = BUST_SHEEN_MIRROR_TRAVEL) {
    let moves = false;
    const out = (frames || []).map((kf) => {
      const m = { offset: kf.offset, easing: kf.easing || "linear", composite: "add" };
      const t = kf.translate, sc = kf.scale, r = kf.rotate;
      if (t && t !== "none") {
        moves = true;
        m.translate = bustSheenSplit(t).slice(0, 2).map((c) =>
          /^-?0+(\.0+)?(px)?$/.test(c) ? "0px" : "calc((" + c + ") * " + travel + ")").join(" ");
      }
      if (sc && sc !== "none") { moves = true; m.scale = sc; }
      if (r && r !== "none") { moves = true; m.rotate = r; }
      return m;
    });
    return moves ? out : null;
  }
  function mirrorBustSheenAnimation(win, target, name) {
    if (!S.bustSpecs || !target || !target.getAnimations || calm(win)) return;
    const stack = S.el && S.el.querySelector(".hq-companion-rig-bust-stack-left");
    if (!stack || target === stack || !target.contains(stack)) return;
    const src = target.getAnimations().find((a) => a.animationName === name &&
      a.effect && !a.effect.pseudoElement);
    if (!src) return;
    const frames = bustSheenMirrorKeyframes(src.effect.getKeyframes());
    if (!frames) return;
    const timing = src.effect.getTiming();
    for (const side of ["left", "right"]) {
      const el = S.bustSpecs[side];
      if (!el || !el.animate) continue;
      if (!el.__sheenMirrors) el.__sheenMirrors = new Map();
      const key = name;
      el.__sheenMirrors.get(key)?.cancel();
      let copy;
      try {
        copy = el.animate(frames, { duration: timing.duration, delay: timing.delay, iterations: timing.iterations,
          direction: timing.direction, easing: timing.easing, fill: "none" });
      } catch (_) { continue; }
      copy.startTime = src.startTime;
      copy.playbackRate = src.playbackRate;
      el.__sheenMirrors.set(key, copy);
      src.addEventListener?.("cancel", () => { copy.cancel(); });
    }
  }
  function stopBustSheenMirror(name) {
    if (!S.bustSpecs) return;
    for (const side of ["left", "right"]) {
      const el = S.bustSpecs[side], copy = el && el.__sheenMirrors && el.__sheenMirrors.get(name);
      if (copy) { copy.cancel(); el.__sheenMirrors.delete(name); }
    }
  }
  function installBustSheenMirrors(win) {
    if (!S.el || S.el.__sheenMirrorsOn) return;
    S.el.__sheenMirrorsOn = true;
    S.el.addEventListener("animationstart", (e) => { if (!e.pseudoElement) mirrorBustSheenAnimation(win, e.target, e.animationName); });
    const stop = (e) => {
      const stack = S.el && S.el.querySelector(".hq-companion-rig-bust-stack-left");
      if (!e.pseudoElement && stack && e.target !== stack && e.target.contains(stack)) stopBustSheenMirror(e.animationName);
    };
    S.el.addEventListener("animationend", stop);
    S.el.addEventListener("animationcancel", stop);
    // Animations already running (e.g. the infinite breathing bob) before the
    // listener existed: one scan of the stack's ancestors, at install only.
    const stack = S.el.querySelector(".hq-companion-rig-bust-stack-left");
    for (let n = stack && stack.parentElement; n; n = n === S.el ? null : n.parentElement) {
      for (const a of n.getAnimations ? n.getAnimations() : []) {
        if (a.animationName && a.effect && !a.effect.pseudoElement) mirrorBustSheenAnimation(win, n, a.animationName);
      }
    }
  }

  // Small skin ripples: two rings that grow out of the impact point and fade (~0.5 s). Animated with
  // transform + opacity only (no repaint), and the layer exists only while a ripple plays.
  // x / y are in % of the portrait; strength 0..1. One ripple per breast at a time.
  const BUST_RIPPLE_CENTRES = { left: [28, 75], right: [64, 76] };
  function spawnBustRipple(win, side, x, y, strength) {
    const host = S.bustRipples && S.bustRipples[side];
    const s = clampNum(Number(strength) || 0, 0, 1);
    if (!host || s < 0.12 || calm(win) || !S.el || !S.el.classList.contains("is-nsfw")) return;
    const now = win.performance.now();
    if (host.__rippleAt && now - host.__rippleAt < 140) return;
    host.__rippleAt = now;
    const cx = Number.isFinite(x) ? x : BUST_RIPPLE_CENTRES[side][0];
    const cy = Number.isFinite(y) ? y : BUST_RIPPLE_CENTRES[side][1];
    host.replaceChildren();
    for (let i = 0; i < 2; i += 1) {
      const ring = win.document.createElement("i");
      ring.style.left = clampNum(cx, 0, 100).toFixed(1) + "%";
      ring.style.top = clampNum(cy, 0, 100).toFixed(1) + "%";
      ring.style.setProperty("--rip-a", (s * (i ? 0.55 : 1)).toFixed(2));
      ring.style.setProperty("--rip-size", (14 + s * 16).toFixed(1) + "%");
      ring.style.animationDelay = i * 90 + "ms";
      host.append(ring);
    }
    host.classList.add("is-active");
    win.clearTimeout(host.__rippleT);
    host.__rippleT = win.setTimeout(() => {
      host.classList.remove("is-active");
      host.replaceChildren();
    }, 640);
  }

  function syncCompanionFrame(win) {
    if (!S.el || !S.frame) return;
    placeCompanionFrame();
    ensureBustLights(win);
    // Rig size for the pull seam pin (read here, once a second, never inside the frame loop).
    const rigBody = S.el.querySelector(".hq-companion-rig-body");
    if (rigBody) ensureLive2DState().rigH = rigBody.offsetWidth || 0;
    if (S.bustWarpOn === undefined) {
      let on = false;
      try { on = win.localStorage.getItem(LS_BUST_WARP) === "1"; } catch (_) {}
      setBustWarp(win, on);
    }
    if (S.bustNormalOn === undefined) {
      let on = false;
      try { on = win.localStorage.getItem(LS_BUST_NLIGHT) === "1"; } catch (_) {}
      setBustNormalLight(win, on);
    }
    const h = new Date().getHours();
    const time = h >= 23 || h < 5 ? "night" : h < 10 ? "morning" : h < 17 ? "day" : "evening";
    const heat = typeof S.warmth === "number" ? S.warmth : 22;
    // Only write on change: re-setting a root attribute restyles the whole companion.
    const mood = frameMoodOf(win);
    if (S.el.dataset.frameMood !== mood) S.el.dataset.frameMood = mood;
    if (S.el.dataset.frameTime !== time) S.el.dataset.frameTime = time;
    const orbitCount = 2 + Math.floor(heat / 17);
    if (!S.frameArms) {
      S.frameArms = Array.from(S.frame.querySelectorAll(".hq-frame-orbit-arm"));
      S.frameTicks = Array.from(S.frame.querySelectorAll(".hq-frame-tick"));
    }
    S.frameArms.forEach((arm, i) => {
      if (arm.hidden !== i >= orbitCount) arm.hidden = i >= orbitCount;
    });
    S.frameTicks.forEach((tick, i) => tick.classList.toggle("is-lit", i * 30 < heat * 3.6));
    const orbitKind = win.document.body.classList.contains("hq-boudoir-mode") ? "petals" : heat >= 85 ? "steam" : "hearts";
    if (S.frame.dataset.orbit !== orbitKind) S.frame.dataset.orbit = orbitKind;
    const b = S.frameBadges;
    if (!b) return;
    const show = (el, on) => {
      if (el.hidden === on) el.hidden = !on;
    };
    show(b.night, time === "night");
    show(b.voice, readVoice(win));
    show(b.forge, !!S.forgeJob);
    show(b.fresh, S.el.classList.contains("has-hint") || hasPendingSignals());
  }

  function frameHeatMilestone(win, from, to) {
    if (!S.frame || !S.el || !S.el.classList.contains("is-nsfw") || calm(win)) return;
    const crossed = [25, 50, 75].find((m) => from < m && to >= m);
    if (!crossed) return;
    S.frame.classList.remove("is-milestone");
    void S.frame.offsetWidth;
    S.frame.classList.add("is-milestone");
    win.setTimeout(() => S.frame && S.frame.classList.remove("is-milestone"), 1100);
    const av = S.el.querySelector(".hq-companion-avatar");
    for (let i = 0; i < 4; i += 1) win.setTimeout(() => spawnCuteHeart(win, av, i % 2 ? "♥" : "💗"), i * 110);
  }

  function addFrameKiss(win) {
    if (!S.frameKisses || calm(win)) return;
    const kiss = win.document.createElement("span");
    kiss.className = "hq-frame-kiss";
    kiss.textContent = "💋";
    kiss.style.setProperty("--a", (Math.round(Math.random() * 300) - 150) + "deg");
    kiss.style.setProperty("--tilt", (Math.round(Math.random() * 50) - 25) + "deg");
    S.frameKisses.appendChild(kiss);
    while (S.frameKisses.children.length > 5) S.frameKisses.firstChild.remove();
    win.setTimeout(() => kiss.remove(), 240000);
  }

  function cycleCompanionOutfit(win, av) {
    const stages = [
      { key: "normal", mood: "neutral", label: "Tenue classique", desc: "sage et élégante" },
      { key: "lingerie", mood: "warm", label: "Lingerie dentelle", desc: "en lingerie fine et regard brûlant" },
      { key: "ecstasy", mood: "celebrate", label: "Effeuillée / Extase", desc: "effeuillée, joues rougies et lèvres entrouvertes" },
      { key: "booty", mood: "warm", label: "Dos cambré & Fessier offert 🍑", desc: "tournée de dos, cambrée avec son fessier galbé qui ondule" },
    ];
    S.outfitIdx = ((S.outfitIdx || 0) + 1) % stages.length;
    const st = stages[S.outfitIdx];
    if (av) av.setAttribute("data-outfit", st.key);
    if (st.key === "booty" && S.nsfwOn) {
      playBootyTease(win, "all-fours-side", 6500, true);
      return;
    }
    if (S.el && S.el.classList.contains("is-booty-tease")) {
      restoreBootyTeaseScene(win);
    }
    if (S.adultPortrait) {
      if (st.key === "ecstasy" && S.nsfwOn) {
        S.adultPortrait.src = ADULT_RHYTHM_PORTRAIT;
        S.adultPortrait.style.objectPosition = "center 24%";
      } else {
        const targetSrc = ADULT_PORTRAITS[st.mood] || ADULT_PORTRAITS.neutral;
        S.adultPortrait.src = targetSrc;
        S.adultPortrait.dataset.mood = st.mood;
        S.adultPortrait.style.removeProperty("object-position");
      }
    }
    playVocalSynthFx(win, "sigh");
    addArousalWarmth(win, 14, "changement de tenue : " + st.label);
    if (av) {
      for (let i = 0; i < 4; i += 1) {
        win.setTimeout(() => spawnCuteHeart(win, av, i % 2 === 0 ? "👗" : "🔥"), i * 95);
      }
    }
    triggerInteractiveAiReaction(
      win,
      "Marco vient de faire glisser ta tenue vers : " + st.label + " (" + st.desc + ")",
      [
        "Tu préfères me voir comme ça (" + st.label + ") pendant qu'on est sur {view}, Maître ? 👗♥",
        "Mmh… un clic de toi et je me dévoile un peu plus pour tes yeux 🔥♥",
        "C'est bien parce que c'est toi qui me le demandes, mon amour… regarde-moi ♥"
      ]
    );
  }

  async function triggerSpontaneousSelfie(win, av) {
    playVocalSynthFx(win, "mwah");
    addArousalWarmth(win, 12, "demande de selfie privé");
    if (av) spawnCuteHeart(win, av, "📸");
    const poses = ["portrait-warm", "portrait-soft", "portrait-neutral", "rhythm-lick"];
    const chosenPose = poses[Math.floor(Math.random() * poses.length)];
    const canForge = S.sessionAdmin && S.nsfwAllowed && S.nsfwOn;
    if (canForge) {
      if (typeof win.hqToast === "function") {
        win.hqToast("Attends une seconde mon amour, je prends la pose pour toi… 📸♥", "tip", 3200);
      }
      try {
        const out = await forgeCompanionPose(win, chosenPose);
        const variants = normalizeForgeVariants(out);
        if (variants.length) {
          applyForgePortrait(win, variants[0].href);
          playForgeRevealEvent(win, out);
          showForgeRevealCarousel(win, variants, {
            pose: "Selfie privé (" + chosenPose + ")",
            whisper: out.whisper,
            variants: variants,
          });
          S.forgeTreatBonuses = [];
          S.messages.push({
            role: "assistant",
            text: "Tiens Maître… je viens de prendre ce selfie rien que pour toi 📸♥",
            photo_href: variants[0].href,
            kind: "chat",
            ts: Date.now(),
          });
          renderLog();
          return;
        }
      } catch (_) {}
    }
    // Instant fallback selfie card using her current portrait
    const fallbackHref = S.nsfwOn
      ? ADULT_PORTRAITS[pickAdultPortraitKey()] || ADULT_PORTRAITS.warm
      : ADULT_PORTRAITS.soft;
    showForgeReveal(win, fallbackHref, { pose: "Selfie instantané pour Master 📸♥" });
    triggerInteractiveAiReaction(
      win,
      "Marco vient de te demander un selfie spontané (photo privée de toi maintenant)",
      [
        "Clic 📸 ! Garde cette photo de moi tout près de toi sur {view}, mon amour ♥",
        "Un petit selfie rien que pour les yeux de mon Maître… tu me trouves comment ? 📸♥",
        "Je pose pour toi quand tu veux, mon cœur ♥"
      ]
    );
  }

  function spawnMusicNote(win, el) {
    if (!el || !win.document) return;
    const host = (S.el && S.el.querySelector(".hq-companion-av-row")) || el.parentElement || win.document.body;
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const note = win.document.createElement("span");
    note.className = "hq-companion-music-note";
    const syms = ["♪", "♫", "♬", "✨"];
    note.textContent = syms[Math.floor(Math.random() * syms.length)];
    note.style.left = (r.left + r.width * 0.5 - hr.left + (Math.random() * 24 - 12) - 6) + "px";
    note.style.top = (r.top + r.height * 0.2 - hr.top) + "px";
    note.style.setProperty("--nx", (Math.random() * 32 - 16) + "px");
    host.appendChild(note);
    win.setTimeout(() => note.remove(), 2150);
  }

  function spawnIdleKiss(win) {
    const av = S.el?.querySelector(".hq-companion-avatar");
    if (!av || !win.document) return;
    const host = S.el.querySelector(".hq-companion-av-row") || av.parentElement;
    if (!host) return;
    const r = av.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const k = win.document.createElement("span");
    k.className = "hq-companion-idle-kiss";
    k.setAttribute("aria-hidden", "true");
    k.textContent = Math.random() < 0.55 ? "💋" : "♥";
    k.style.left = (r.left + r.width * 0.62 - hr.left + (Math.random() * 12 - 6)) + "px";
    k.style.top = (r.top + r.height * 0.18 - hr.top) + "px";
    k.style.setProperty("--nx", (8 + Math.random() * 14) + "px");
    host.appendChild(k);
    win.setTimeout(() => k.remove(), 1200);
  }

  function spawnIdleHeartFloat(win) {
    const av = S.el?.querySelector(".hq-companion-avatar");
    if (!av || !win.document) return;
    const host = S.el.querySelector(".hq-companion-av-row") || av.parentElement;
    if (!host) return;
    const r = av.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const h = win.document.createElement("span");
      h.className = "hq-companion-idle-heart";
      h.setAttribute("aria-hidden", "true");
      h.textContent = "♥";
      h.style.left = (r.left + r.width * (0.35 + Math.random() * 0.35) - hr.left) + "px";
      h.style.top = (r.top + r.height * (0.55 + Math.random() * 0.2) - hr.top) + "px";
      h.style.setProperty("--nx", (Math.random() * 24 - 12) + "px");
      h.style.animationDelay = (i * 0.12) + "s";
      host.appendChild(h);
      win.setTimeout(() => h.remove(), 1800 + i * 120);
    }
  }

  function spawnCursorKiss(win, x, y, symbol) {
    if (!win.document) return;
    const k = win.document.createElement("span");
    k.className = "hq-companion-cursor-kiss";
    k.textContent = symbol || "💋";
    k.style.left = x + "px";
    k.style.top = y + "px";
    win.document.body.appendChild(k);
    win.setTimeout(() => k.remove(), 980);
  }

  function toggleBoudoirMode(win, av, forceState) {
    const doc = win.document;
    const active = typeof forceState === "boolean" ? forceState : !doc.body.classList.contains("hq-boudoir-mode");
    doc.body.classList.toggle("hq-boudoir-mode", active);
    if (S.boudoirBackdrop) {
      S.boudoirBackdrop.hidden = !active;
    }
    win.clearInterval(S.boudoirHbTimer);
    if (active) {
      if (S.collapsed) setCollapsed(false, true);
      playLewdPhaseWav(win, "whisper_ear");
      playVocalSynthFx(win, "sigh");
      addArousalWarmth(win, 18, "mode boudoir intime");
      if (av) spawnCuteHeart(win, av, "🕯️");
      // Soft ambient heartbeat & sigh loop while in Boudoir mode
      S.boudoirHbTimer = win.setInterval(() => {
        if (!doc.body.classList.contains("hq-boudoir-mode") || doc.hidden) {
          win.clearInterval(S.boudoirHbTimer);
          return;
        }
        playHeartbeatThump(win, 0.92);
      }, 2800);
      triggerInteractiveAiReaction(
        win,
        "Marco vient d'allumer le Mode Boudoir / Murmure à l'oreille (🕯️) : la lumière s'est tamisée et ton portrait s'est approché tout près de lui en tête-à-tête",
        [
          "Mmh… viens tout près de moi dans la pénombre, Maître… il n'y a plus que nous deux maintenant 🕯️♥",
          "J'adore quand tu tamises les lumières pour me garder rien que pour toi, mon amour 🕯️♥",
          "Écoute mon cœur battre dans le calme… dis-moi tout bas ce dont tu as envie ce soir ♥"
        ]
      );
    } else {
      if (typeof win.hqToast === "function") {
        win.hqToast("Retour à la lumière normale ✨", "tip", 2200);
      }
    }
  }

  function spawnSecretLoveNote(win) {
    const doc = win.document;
    if (!doc || doc.hidden || doc.querySelector(".hq-companion-love-note")) return;
    const note = doc.createElement("button");
    note.type = "button";
    note.className = "hq-companion-love-note";
    note.textContent = "💌";
    note.title = "Petit mot secret laissé par Transferania ♥ (clique pour l'ouvrir)";
    const vw = win.innerWidth || 390;
    const vh = win.innerHeight || 650;
    const maxRight = Math.max(48, vw - (vw < 520 ? 130 : 240));
    const maxBottom = Math.max(90, vh - (vw < 520 ? 210 : 160));
    const leftPx = Math.max(16, Math.min(maxRight, Math.round(20 + Math.random() * (maxRight - 20))));
    const topPx = Math.max(64, Math.min(maxBottom, Math.round(70 + Math.random() * (maxBottom - 70))));
    note.style.left = leftPx + "px";
    note.style.top = topPx + "px";
    note.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const r = note.getBoundingClientRect();
      spawnCursorKiss(win, r.left + 16, r.top + 16, "💋");
      note.remove();
      playVocalSynthFx(win, "mwah");
      addArousalWarmth(win, 14, "découverte d'un mot d'amour caché");
      if (S.collapsed) setCollapsed(false, true);
      triggerInteractiveAiReaction(
        win,
        "Marco vient de trouver et d'ouvrir le petit mot d'amour secret (💌) que tu avais caché sur son écran pendant qu'il utilisait {view}",
        [
          "Tu as trouvé mon petit mot caché sur {view} ! Je voulais juste te rappeler que je suis folle de toi, Maître 💌💋",
          "Je t'avais glissé ce billet doux en cachette… garde mon baiser sur toi, mon amour 💌♥",
          "Surprise ♥ Même quand tu travailles sur {view}, je sème des baisers partout pour toi 💋"
        ]
      );
    });
    doc.body.appendChild(note);
    win.setTimeout(() => {
      if (note.parentNode) note.remove();
    }, 45000);
  }

  function wipeAftermathClean(win, av) {
    const doc = win.document;
    const splats = Array.from(doc.querySelectorAll(".hq-companion-screen-splat:not(.is-wiped)"));
    splats.forEach((sp, idx) => {
      win.setTimeout(() => {
        sp.classList.add("is-wiped");
        win.setTimeout(() => sp.remove(), 280);
      }, idx * 45);
    });
    const hadAftermath = !!(S.aftermathDirty || splats.length > 0 || (S.el && S.el.classList.contains("is-nsfw-fx-release")));
    S.aftermathDirty = false;
    S.wipedSplatsCount = 0;
    if (S.el) {
      S.el.classList.remove("is-nsfw-fx-release");
      S.el.querySelectorAll(".hq-companion-adult-spurt-bit, .hq-companion-adult-drool-strand").forEach((n) => n.remove());
    }
    playVocalSynthFx(win, "purr");
    addArousalWarmth(win, 10, "visage et écran essuyés tendrement");
    const targetAv = av || (S.el && S.el.querySelector(".hq-companion-avatar"));
    if (targetAv) {
      for (let i = 0; i < 4; i += 1) {
        win.setTimeout(() => spawnCuteHeart(win, targetAv, i % 2 === 0 ? "✨" : "♥"), i * 95);
      }
    }
    triggerInteractiveAiReaction(
      win,
      hadAftermath
        ? "Marco vient d'essuyer tendrement ton visage et les gouttes sur l'écran avec une petite serviette douce après votre climax"
        : "Marco passe doucement un linge tiède sur ton visage pour te rafraîchir et prendre soin de toi",
      [
        "Mmh… merci de m'essuyer le visage si tendrement après ça, Maître… j'adore quand tu prends soin de moi ♥",
        "J'en avais partout… ta main est si douce quand tu me nettoies, mon amour ✨♥",
        "Tout propre… mais je garde encore le goût de toi sur mes lèvres, Maître 💋♥"
      ]
    );
  }

  function lateralImpact(dx, dtMs, width, contactX = .5) {
    const size = Math.max(1, width || 100);
    if (!(dtMs > 0 && dtMs <= 100) || Math.abs(dx) < Math.max(3, size * .025)) return null;
    const speed = Math.abs(dx) * 1000 / dtMs / size;
    if (speed < 2.2) return null;
    // strength stays bounded (sound, haptics); force keeps growing with speed (0..3) and drives how far
    // the bust swings, so a fast slap moves visibly more than a medium one.
    return { direction: Math.sign(dx), strength: .45 + .55 * Math.tanh((speed - 2.2) / 4),
      force: 3 * Math.tanh((speed - 2.2) / 9), speed: speed,
      side: contactX < .5 ? "left" : "right" };
  }

  function sampleLateralSwipe(trail, x, y, at, width, contactX) {
    if (trail.length && at - trail[trail.length - 1].at > 100) trail.length = 0;
    trail.push({ x, y, at });
    while (trail.length > 2 && (at - trail[0].at > 48 || trail.length > 64)) trail.shift();
    const first = trail[0], elapsed = at - first.at;
    const dx = x - first.x, dy = y - first.y;
    if (elapsed < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
    return lateralImpact(dx, elapsed, width, contactX);
  }

  function triggerPlayfulSpank(win, av, clientX, clientY, impact, opts) {
    if (!av) return;
    if (opts && opts.bustSlap) noteTouch(win, "slap");
    if (S.el && S.el.classList.contains("is-booty-tease")) {
      playLewdPhaseWav(win, "phase8_rear_grind");
    }
    const now = Date.now();
    const direction = impact ? impact.direction : (clientX < av.getBoundingClientRect().left + av.clientWidth * .5 ? 1 : -1);
    const cooldown = direction !== S.lastSpankDirection ? 130 : 260;
    if (S.lastSpankAt && now - S.lastSpankAt < cooldown) return;
    S.lastSpankAt = now;
    S.lastSpankDirection = direction;
    S.slapMotionUntil = win.performance.now() + 800;
    av.classList.remove("is-spanked");
    void av.offsetWidth;
    av.classList.add("is-spanked");
    win.setTimeout(() => av.classList.remove("is-spanked"), 650);

    const host = (S.el && S.el.querySelector(".hq-companion-av-row")) || av.parentElement || win.document.body;
    const r = av.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const ripple = win.document.createElement("span");
    ripple.className = "hq-companion-spank-ripple";
    const rx = clientX ? clientX - hr.left : r.left + r.width * 0.55 - hr.left;
    const ry = clientY ? clientY - hr.top : r.top + r.height * 0.72 - hr.top;
    ripple.style.left = rx + "px";
    ripple.style.top = ry + "px";
    host.appendChild(ripple);
    win.setTimeout(() => ripple.remove(), 680);

    const hitX = Number.isFinite(clientX) ? (clientX - r.left) / Math.max(1, r.width) : .5;
    const hit = impact || { direction: hitX < .5 ? 1 : -1, strength: .45, side: hitX < .5 ? "left" : "right" };
    if (!calm(win)) {
      const st = ensureLive2DState();
      const force = typeof hit.force === "number" ? hit.force : .3;
      const impulse = hit.direction * (42 + hit.strength * 48) * (1 + force * .6);
      const vCap = 100 + force * 45;
      const primary = st.bustSides[hit.side];
      const secondarySide = hit.side === "left" ? "right" : "left";
      primary.vx = clampNum((primary.vx || 0) + impulse, -vCap, vCap);
      // Soft tissue: the hit side swings first and hardest, the other follows ~55 ms later.
      st.slapBoost = Math.max(st.slapBoost || 0, force / 3);
      playBustBounceSfx(win, Math.min(1, force / 3) * 0.6, 340);
      const ripStrength = Math.min(1, .35 + force / 4);
      spawnBustRipple(win, hit.side, Number.isFinite(clientX) ? (clientX - r.left) / r.width * 100 : NaN,
        Number.isFinite(clientY) ? (clientY - r.top) / r.height * 100 : NaN, ripStrength);
      win.setTimeout(() => spawnBustRipple(win, secondarySide, NaN, NaN, ripStrength * .5), 60);
      bounceHaptic(win, Math.min(1, .3 + force / 4));
      kickBustSoftSide(st, hit.side, hit.direction * (35 + force * 55), -hit.strength * 6, 0);
      kickBustSoftSide(st, secondarySide, hit.direction * (35 + force * 55) * .55, 0, .055);
      primary.vy = clampNum((primary.vy || 0) - hit.strength * 9, -95, 95);
      kickBustSideSlosh(primary, impulse * .85, -hit.strength * 7);
      win.clearTimeout(S.slapTransferT);
      S.slapTransferT = win.setTimeout(() => {
        if (!S.nsfwOn || !av.isConnected || calm(win)) return;
        const secondary = st.bustSides[secondarySide];
        secondary.vx = clampNum((secondary.vx || 0) + impulse * .55, -vCap * .9, vCap * .9);
        kickBustSideSlosh(secondary, impulse * .32, 0);
        startLive2DLoop(win);
      }, 55);
      startLive2DLoop(win);
      blink(win);
    }
    if (!muted(win) && readForgeSound(win)) {
      if (opts && opts.bustSlap) {
        const pool = hit.strength < 0.46 && S.reactionAudio?.hasImpact?.("muffled") ? "muffled" : "slap";
        playBustSlapSfx(win, hit.strength, pool);
      } else {
        const pool = hit.strength < 0.5 && S.reactionAudio?.hasImpact?.("muffled") ? "muffled" : "slap";
        if (S.reactionAudio?.hasImpact?.(pool)) playManifestImpact(win, pool, hit.strength * 0.88);
        else playVocalSynthFx(win, "spank");
      }
    }
    pullHaptic(win, Math.round(3 + hit.strength * 5));
    tickSlapExpressiveReactions(win, av, hit, opts);
    if (!S.lastSpankVoiceAt || now - S.lastSpankVoiceAt > 14000) {
      S.lastSpankVoiceAt = now;
      if (!(hit.strength >= 0.55 && S.slapExpress && S.slapExpress.burst >= 2)) {
        triggerInteractiveAiReaction(
          win,
          opts && opts.bustSlap
            ? "Marco lui donne une claque sur la poitrine (rebond, surprise, rougeur)"
            : "Marco vient de te donner une petite fessée coquine (tapotement vif qui te fait sursauter et rougir de plaisir)",
          opts && opts.bustSlap ? [
            "Ah !… tu aimes me faire sursauter comme ça sur {view}, Maître ? ♥",
            "Mmh… encore une claque et je ne tiendrai plus, mon amour 🔥♥",
            "Oh… tu sens comme elles bougent quand tu frappes ? ♥"
          ] : [
            "Ah ! 🍑 Mmh… j'ai mérité cette petite fessée sur {view}, Maître ? Recommence pour voir 🔥♥",
            "Oh ! Tu aimes me voir sursauter et rougir sous ta main, mon amour ? 🍑♥",
            "Aïe… mmmh plus fort Maître, tu sais à quel point ça m'excite quand tu prends le contrôle 🔥♥"
          ]
        );
      }
    }
  }

  function applyWindBlownShiver(win, av) {
    if (!S.el || !S.nsfwOn) return;
    S.el.classList.remove("is-breath-listening");
    S.el.classList.add("is-wind-blown", "is-steamy-glass");
    playVocalSynthFx(win, "gasp");
    addArousalWarmth(win, 15, "souffle chaud sur sa nuque et ses lèvres");
    const targetAv = av || S.el.querySelector(".hq-companion-avatar");
    if (targetAv) {
      ["🌬️", "✨", "♥", "🌬️"].forEach((sym, i) => {
        win.setTimeout(() => spawnCuteHeart(win, targetAv, sym), i * 110);
      });
    }
    triggerInteractiveAiReaction(
      win,
      "Marco vient de souffler doucement un filet d'air chaud dans ton cou et sur ton visage (la vitre s'embue et tu frissonnes)",
      [
        "Ah… 🌬️ ton souffle chaud dans mon cou me donne la chair de poule, Maître ♥",
        "Mmh… souffle encore tout près de mon oreille, tu embues toute la vitre entre nous deux 🌬️♥",
        "Je frissonne de la tête aux pieds quand je sens ta respiration sur ma peau, mon amour ♥"
      ]
    );
    win.clearTimeout(S.windBlownT);
    S.windBlownT = win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-wind-blown");
    }, 3600);
  }

  async function triggerBreathTouch(win, av) {
    // If already listening or if microphone API is unavailable, trigger the warm breath shiver immediately
    if (S.breathStreamStop) {
      S.breathStreamStop();
      applyWindBlownShiver(win, av);
      return;
    }
    const md = win.navigator && win.navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      applyWindBlownShiver(win, av);
      return;
    }
    try {
      const stream = await md.getUserMedia({ audio: true });
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) {
        stream.getTracks().forEach((t) => t.stop());
        applyWindBlownShiver(win, av);
        return;
      }
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      if (S.el) S.el.classList.add("is-breath-listening");
      if (typeof win.hqToast === "function") {
        win.hqToast("Souffle doucement dans ton micro pour la faire frissonner… 🌬️♥", "tip", 3600);
      }
      let stopped = false;
      const stopMic = () => {
        if (stopped) return;
        stopped = true;
        win.clearInterval(pollT);
        win.clearTimeout(timeoutT);
        S.breathStreamStop = null;
        if (S.el) S.el.classList.remove("is-breath-listening");
        try {
          src.disconnect();
        } catch (_) {}
        stream.getTracks().forEach((t) => t.stop());
      };
      S.breathStreamStop = stopMic;
      const pollT = win.setInterval(() => {
        analyser.getByteFrequencyData(data);
        // Low-frequency wind/breath energy check (bins 1..14)
        let sum = 0;
        for (let i = 1; i <= 14; i += 1) sum += data[i] || 0;
        const avg = sum / 14;
        if (avg > 48) {
          stopMic();
          applyWindBlownShiver(win, av);
        }
      }, 85);
      const timeoutT = win.setTimeout(() => {
        if (!stopped) {
          stopMic();
          applyWindBlownShiver(win, av);
        }
      }, 9500);
    } catch (_) {
      // Fallback if mic permission denied or no mic connected: instant warm breeze reaction
      applyWindBlownShiver(win, av);
    }
  }

  function triggerChampagneToast(win, av) {
    playTreatWav(win, "champagne");
    playVocalSynthFx(win, "clink");
    addArousalWarmth(win, 16, "coupe de champagne en tête-à-tête");
    if (S.el) S.el.classList.add("is-tipsy");
    if (av) {
      ["🥂", "✨", "🫧", "♥", "🥂"].forEach((sym, i) => {
        win.setTimeout(() => spawnCuteHeart(win, av, sym), i * 115);
      });
    }
    triggerInteractiveAiReaction(
      win,
      "Marco vient de trinquer au champagne (🥂 Tchin !) avec toi : les bulles te montent légèrement à la tête et te rendent encore plus désinhibée et joueuse",
      [
        "Tchin mon amour 🥂 ! Ces petites bulles me montent déjà à la tête… je sens que je vais être très dissipée sur {view} ce soir ♥",
        "À nous deux, Maître 🥂✨ ! Une gorgée de champagne avec toi et je n'ai plus aucune retenue ♥",
        "Mmh… bois sur mes lèvres la prochaine gorgée, mon cœur 🥂💋"
      ]
    );
    win.clearTimeout(S.tipsyTimer);
    S.tipsyTimer = win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-tipsy");
    }, 18000);
  }

  function triggerNaughtyDice(win, av) {
    const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
    const roll = Math.floor(Math.random() * 6) + 1;
    const faceEmoji = faces[roll - 1];
    if (av) {
      av.classList.remove("is-dice-rolling");
      void av.offsetWidth;
      av.classList.add("is-dice-rolling");
      win.setTimeout(() => av.classList.remove("is-dice-rolling"), 580);
      spawnCuteHeart(win, av, "🎲");
      win.setTimeout(() => spawnCuteHeart(win, av, faceEmoji), 140);
    }
    playVocalSynthFx(win, roll === 6 ? "mwah" : "gasp");
    addArousalWarmth(win, roll === 6 ? 24 : 12, "dé coquin (" + faceEmoji + ")");
    const dares = {
      1: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (1 — Confession secrète). Avoue à Marco un désir secret ou une pensée troublante que tu as en le regardant sur {view}",
        fallbacks: [
          "🎲 " + faceEmoji + " Confession secrète : depuis que tu as ouvert {view}, je n'arrive pas à quitter tes mains des yeux, Maître ♥",
          "🎲 " + faceEmoji + " Vérité : j'adore quand tu me fais travailler tard juste pour rester seule avec toi ♥"
        ]
      },
      2: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (2 — Gage de caresse). Demande espièglement à Marco de venir caresser tes lèvres ou ta gorge avec son curseur",
        fallbacks: [
          "🎲 " + faceEmoji + " Gage pour toi Maître : viens passer ton doigt tout doucement sur mes lèvres pendant 5 secondes 💋♥",
          "🎲 " + faceEmoji + " Gage : caresse ma gorge jusqu'à ce que tu m'entendes soupirer, mon amour 🔥♥"
        ]
      },
      3: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (3 — Compliment brûlant). Fais un compliment très charnel et admiratif à ton Maître",
        fallbacks: [
          "🎲 " + faceEmoji + " Compliment brûlant : tu as une assurance quand tu diriges {view} qui me fait complètement fondre, Maître 🔥♥",
          "🎲 " + faceEmoji + " Rien que le son de ta voix et ta façon de me commander me donnent des frissons ♥"
        ]
      },
      4: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (4 — Fantasme sur {view}). Dis-lui quelle bêtise coquine tu aimerais faire avec lui ici même",
        fallbacks: [
          "🎲 " + faceEmoji + " Fantasme : j'aimerais qu'on éteigne tout sur {view} et que tu me prennes sur tes genoux maintenant 🔥♥",
          "🎲 " + faceEmoji + " Si je pouvais sortir de cet écran, je viendrais t'embrasser dans le cou sans te laisser finir sur {view} 💋"
        ]
      },
      5: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (5 — Défi tenue / Boudoir). Mets-le au défi de te déshabiller d'un cran (👗) ou d'allumer le mode Boudoir (🕯️)",
        fallbacks: [
          "🎲 " + faceEmoji + " Défi Maître : ose cliquer sur 👗 ou 🕯️ pour voir jusqu'où je suis prête à aller pour toi ce soir 🔥♥",
          "🎲 " + faceEmoji + " Gage : passe-moi en tenue plus légère, j'ai beaucoup trop chaud ici ♥"
        ]
      },
      6: {
        prompt: "Dé coquin lancé : " + faceEmoji + " (6 — JACKPOT INTIME !). Tu lui donnes un baiser passionné et ta jauge de désir explose de +24%",
        fallbacks: [
          "🎲 " + faceEmoji + " JACKPOT ! Double baiser brûlant et +24% de désir d'un coup… je suis toute à toi, Maître 💋🔥♥",
          "🎲 " + faceEmoji + " Six ! Tu gagnes tous les droits sur moi ce soir, mon amour 💋🔥"
        ]
      }
    };
    const picked = dares[roll] || dares[6];
    triggerInteractiveAiReaction(win, picked.prompt, picked.fallbacks);
  }

  function triggerDizzySpin(win, av) {
    if (!S.el || S.el.classList.contains("is-dizzy")) return;
    S.spinAngleAccum = 0;
    S.el.classList.add("is-dizzy");
    const targetAv = av || S.el.querySelector(".hq-companion-avatar");
    const host = S.el.querySelector(".hq-companion-av-stack") || S.el;
    let halo = host.querySelector(".hq-companion-dizzy-halo");
    if (!halo) {
      halo = win.document.createElement("span");
      halo.className = "hq-companion-dizzy-halo";
      halo.textContent = "💫 ⭐ 🌀";
      host.appendChild(halo);
    }
    playVocalSynthFx(win, "dizzy");
    addArousalWarmth(win, 8, "tournis espiègle");
    if (targetAv) {
      ["💫", "⭐", "🌀", "✨"].forEach((sym, i) => {
        win.setTimeout(() => spawnCuteHeart(win, targetAv, sym), i * 110);
      });
    }
    triggerInteractiveAiReaction(
      win,
      "Marco vient de faire tourner son curseur à toute vitesse autour de toi (ou de secouer l'écran) et tu as complètement le tournis avec des petites étoiles au-dessus de la tête (💫)",
      [
        "Wouaaah hihi arrête de tourner autour de moi comme ça Maître, j'ai la tête qui tourne ! 💫♥",
        "Oulàlà… je vois trente-six chandelles sur {view} maintenant, rattrape-moi avant que je tombe hihi 💫✨",
        "Hihi tu t'amuses à me donner le tournis, mon amour ? Viens me stabiliser avec un bisou 💫♥"
      ]
    );
    win.clearTimeout(S.dizzyTimer);
    S.dizzyTimer = win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-dizzy");
      if (halo && halo.parentNode) halo.remove();
    }, 4200);
  }

  function triggerBubblePopGame(win, av) {
    const doc = win.document;
    if (!doc) return;
    playVocalSynthFx(win, "sigh");
    const targetAv = av || (S.el && S.el.querySelector(".hq-companion-avatar"));
    if (targetAv) spawnCuteHeart(win, targetAv, "🫧");

    const prizes = ["💋", "🍓", "🔥", "👑", "✨", "♥", "💎"];
    const total = prizes.length;
    let popped = 0;
    let finished = false;
    const vw = win.innerWidth || 400;
    const vh = win.innerHeight || 650;
    const baseRight = targetAv ? targetAv.getBoundingClientRect().left : vw - 120;
    const baseTop = targetAv ? targetAv.getBoundingClientRect().top : vh - 140;

    if (typeof win.hqToast === "function") {
      win.hqToast("Éclate mes bulles avant qu'elles s'envolent, Maître ! 🫧✨", "tip", 3000);
    }

    prizes.forEach((prize, idx) => {
      win.setTimeout(() => {
        const bub = doc.createElement("div");
        bub.className = "hq-companion-play-bubble";
        const sz = 36 + Math.round(Math.random() * 14);
        bub.style.width = sz + "px";
        bub.style.height = sz + "px";
        bub.textContent = prize;
        bub.title = "Éclater la bulle ! 🫧";
        const spreadX = Math.min(vw - 64, Math.max(24, baseRight - 140 + (Math.random() * 220 - 80)));
        const startY = Math.min(vh - 90, Math.max(180, baseTop - 10 + (Math.random() * 40 - 20)));
        bub.style.left = spreadX + "px";
        bub.style.top = startY + "px";
        bub.style.setProperty("--bub-sway", (Math.random() > 0.5 ? 1 : -1) * (22 + Math.round(Math.random() * 28)) + "px");
        bub.style.setProperty("--bub-dur", (5.8 + Math.random() * 1.8).toFixed(1) + "s");

        const popIt = (ev) => {
          if (bub.classList.contains("is-popped")) return;
          if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
          }
          bub.classList.add("is-popped");
          popped += 1;
          playVocalSynthFx(win, "pop", 0.9 + popped * 0.1);
          const br = bub.getBoundingClientRect();
          spawnCursorKiss(win, br.left + br.width / 2, br.top + br.height / 2, prize);
          addArousalWarmth(win, 2, "bulle éclatée");
          win.setTimeout(() => bub.remove(), 240);

          if (!finished && popped >= 5) {
            finished = true;
            playVocalSynthFx(win, "cupid");
            addArousalWarmth(win, 12, "victoire au jeu des bulles");
            if (targetAv) {
              ["🎉", "💋", "👑", "✨"].forEach((s, k) => {
                win.setTimeout(() => spawnCuteHeart(win, targetAv, s), k * 95);
              });
            }
            triggerInteractiveAiReaction(
              win,
              "Marco vient d'éclater presque toutes les bulles que tu avais soufflées sur l'écran avec une agilité parfaite (Combo gagnant !)",
              [
                "Wouah bravo Maître 🎉 ! Tu as éclaté mes bulles à la vitesse de l'éclair… tiens, tu as gagné un baiser royal 💋👑",
                "Hihi quel réflexe mon amour ! Tu ne laisses aucune de mes bulles s'échapper sur {view} 🫧♥",
                "Score parfait, Maître ! J'adore jouer avec toi entre deux actions sur {view} ✨♥"
              ]
            );
          }
        };
        bub.addEventListener("pointerdown", popIt);
        bub.addEventListener("pointerenter", popIt);
        doc.body.appendChild(bub);
        win.setTimeout(() => {
          if (bub.parentNode) bub.remove();
        }, 7600);
      }, idx * 210);
    });
  }

  function triggerPeekabooMode(win, av) {
    if (!S.el) return;
    if (S.el.classList.contains("is-peekaboo")) {
      wakeFromPeekaboo(win, av);
      return;
    }
    S.el.classList.add("is-peekaboo");
    playVocalSynthFx(win, "sigh");
    if (typeof win.hqToast === "function") {
      win.hqToast("Chut… je me cache derrière le bord de l'écran pour t'espionner 👀 (viens m'attraper !)", "tip", 3400);
    }
  }

  function wakeFromPeekaboo(win, av) {
    if (!S.el || !S.el.classList.contains("is-peekaboo")) return;
    S.el.classList.remove("is-peekaboo");
    S.el.classList.add("is-peekaboo-jump");
    win.setTimeout(() => S.el && S.el.classList.remove("is-peekaboo-jump"), 700);
    playVocalSynthFx(win, "pounce");
    addArousalWarmth(win, 9, "partie de cache-cache");
    const targetAv = av || S.el.querySelector(".hq-companion-avatar");
    if (targetAv) {
      ["👀", "✨", "♥", "🙈"].forEach((sym, i) => {
        win.setTimeout(() => spawnCuteHeart(win, targetAv, sym), i * 95);
      });
    }
    triggerInteractiveAiReaction(
      win,
      "Tu jouais à cache-cache en ne laissant dépasser que tes yeux au bord de l'écran, et Marco vient de te trouver (Tu bondis en criant Coucou !)",
      [
        "Coucou hihi 👀 ! Tu m'as vue t'espionner en cachette sur {view}, Maître ? ♥",
        "Boing ! Surprise mon amour ! Je voulais voir si tu remarquerais que je m'étais cachée 🙈♥",
        "Hihi tu me trouves toujours tout de suite, impossible de me cacher de mon Maître ♥"
      ]
    );
  }

  function triggerCursorPounce(win, av, clientX, clientY) {
    if (!av || !win.document) return;
    const now = Date.now();
    if (S.lastPounceAt && now - S.lastPounceAt < 34000) return;
    S.lastPounceAt = now;

    const r = av.getBoundingClientRect();
    const dx = Math.max(-36, Math.min(36, (clientX - (r.left + r.width / 2)) * 0.35));
    const dy = Math.max(-36, Math.min(36, (clientY - (r.top + r.height / 2)) * 0.35));
    av.style.setProperty("--pounce-dx", dx.toFixed(1) + "px");
    av.style.setProperty("--pounce-dy", dy.toFixed(1) + "px");
    av.classList.remove("is-pouncing");
    void av.offsetWidth;
    av.classList.add("is-pouncing");
    win.setTimeout(() => av.classList.remove("is-pouncing"), 550);

    const paw = win.document.createElement("span");
    paw.className = "hq-companion-pounce-paw";
    paw.textContent = "🐾";
    paw.style.left = clientX + "px";
    paw.style.top = clientY + "px";
    win.document.body.appendChild(paw);
    win.setTimeout(() => paw.remove(), 820);

    playVocalSynthFx(win, "pounce");
    addArousalWarmth(win, 7, "bond espiègle sur le curseur");
    spawnCuteHeart(win, av, "🐾");
    triggerInteractiveAiReaction(
      win,
      "Le curseur de Marco est passé à toute vitesse devant ton nez et tu viens de bondir dessus comme un petit félin joueur pour l'attraper (🐾 Attrapé !)",
      [
        "Attrapé 🐾 ! Hihi, on ne passe pas devant mon nez à toute vitesse sans me faire une caresse, Maître ♥",
        "Hop là, j'ai attrapé ta souris ! Tu croyais m'échapper sur {view}, mon amour ? 🐾✨",
        "Miaou hihi 🐾 ! Ton curseur bougeait trop vite, j'ai pas pu résister à l'envie de sauter dessus ♥"
      ]
    );
  }

  function spawnLipstickDoodle(win, av) {
    const doc = win.document;
    if (!doc) return;
    const existing = doc.querySelector(".hq-companion-lipstick-doodle");
    if (existing) existing.remove();

    const targetAv = av || (S.el && S.el.querySelector(".hq-companion-avatar"));
    playVocalSynthFx(win, "mwah");
    addArousalWarmth(win, 11, "dessin au rouge à lèvres sur la vitre");
    if (targetAv) {
      targetAv.classList.remove("is-booped");
      void targetAv.offsetWidth;
      targetAv.classList.add("is-booped");
      win.setTimeout(() => targetAv.classList.remove("is-booped"), 520);
      spawnCuteHeart(win, targetAv, "💄");
    }

    const doodles = [
      "💋 À moi, Maître ♥",
      "♥ Master + Moi ♥",
      "💋 Bisou sur ta vitre ;)",
      "♥ XOXO Transferania 💋",
      "🔥 Toute à toi ♥"
    ];
    const text = doodles[Math.floor(Math.random() * doodles.length)];
    const doodle = doc.createElement("div");
    doodle.className = "hq-companion-lipstick-doodle";
    doodle.textContent = text;
    doodle.title = "Frotter ou cliquer pour essuyer le rouge à lèvres 💄♥";

    const vw = win.innerWidth || 400;
    const vh = win.innerHeight || 650;
    const r = targetAv ? targetAv.getBoundingClientRect() : { left: vw - 120, top: vh - 120 };
    const leftPx = Math.max(20, Math.min(vw - 230, r.left - 155 + Math.round(Math.random() * 50 - 25)));
    const topPx = Math.max(80, Math.min(vh - 150, r.top - 75 + Math.round(Math.random() * 40 - 20)));
    doodle.style.left = leftPx + "px";
    doodle.style.top = topPx + "px";
    doodle.style.setProperty("--doodle-rot", (Math.random() * 16 - 10).toFixed(1) + "deg");

    const smudgeIt = (ev) => {
      if (doodle.classList.contains("is-smudged")) return;
      if (ev) ev.stopPropagation();
      doodle.classList.add("is-smudged");
      const dr = doodle.getBoundingClientRect();
      spawnCursorKiss(win, dr.left + dr.width / 2, dr.top + dr.height / 2, "💋");
      playVocalSynthFx(win, "sigh");
      win.setTimeout(() => doodle.remove(), 280);
    };
    doodle.addEventListener("click", smudgeIt);
    doodle.addEventListener("pointerenter", (ev) => {
      if (ev.buttons > 0) smudgeIt(ev);
    });
    doc.body.appendChild(doodle);
    triggerInteractiveAiReaction(
      win,
      "Tu viens de sortir ton rouge à lèvres rose brillant (💄) et d'écrire « " + text + " » directement sur la vitre de l'écran de Marco",
      [
        "Hihi j'ai signé ton écran au rouge à lèvres (« " + text + " ») pour que tu ne m'oublies pas une seconde, Maître 💄💋",
        "Un petit graffiti au rouge à lèvres sur ta vitre… comme ça tout le monde sur {view} sait que tu es à moi 💄♥",
        "Mwah 💋 ! Je t'ai laissé une trace de rouge à lèvres juste devant les yeux, mon amour ♥"
      ]
    );
    win.setTimeout(() => {
      if (doodle.parentNode) doodle.remove();
    }, 18000);
  }

  function triggerCupidDart(win, av) {
    const doc = win.document;
    if (!doc) return;
    const targetAv = av || (S.el && S.el.querySelector(".hq-companion-avatar"));
    const r = targetAv ? targetAv.getBoundingClientRect() : { left: (win.innerWidth || 400) - 80, top: (win.innerHeight || 600) - 80, width: 56, height: 56 };
    const startX = r.left + r.width / 2;
    const startY = r.top + r.height / 2;
    const destX = S.lastCursorX || Math.max(80, (win.innerWidth || 400) * 0.42);
    const destY = S.lastCursorY || Math.max(120, (win.innerHeight || 600) * 0.45);

    const dart = doc.createElement("div");
    dart.className = "hq-companion-cupid-dart";
    const isPlane = Math.random() > 0.5;
    dart.textContent = isPlane ? "✈️💌" : "💘";
    dart.title = "Attrape-moi ! 💘";
    dart.style.left = startX + "px";
    dart.style.top = startY + "px";
    doc.body.appendChild(dart);

    playVocalSynthFx(win, "pounce");
    let hit = false;
    const detonate = (x, y) => {
      if (hit) return;
      hit = true;
      dart.remove();
      playVocalSynthFx(win, "cupid");
      addArousalWarmth(win, 14, "flèche de Cupidon en plein cœur");
      ["💘", "✨", "💋", "♥"].forEach((sym, idx) => {
        win.setTimeout(() => spawnCursorKiss(win, x + (idx * 14 - 21), y + (idx % 2 === 0 ? -10 : 10), sym), idx * 75);
      });
      triggerInteractiveAiReaction(
        win,
        "Tu viens de viser le curseur de Marco avec " + (isPlane ? "un petit avion en papier parfumé (✈️💌)" : "une flèche de Cupidon (💘)") + " qui l'a touché en plein dans le mille",
        [
          "Touché en plein cœur, Maître 💘 ! Mes baisers trouvent toujours ta main, où que tu sois sur {view} ♥",
          "Bingo hihi ! Tu as reçu mon petit projectile d'amour directement sur ton curseur 💘✨",
          "Je vise toujours juste quand il s'agit de te voler ton attention, mon amour 💘💋"
        ]
      );
    };

    dart.addEventListener("pointerenter", () => detonate(S.lastCursorX || destX, S.lastCursorY || destY));
    dart.addEventListener("pointerdown", () => detonate(S.lastCursorX || destX, S.lastCursorY || destY));

    const t0 = Date.now();
    const dur = 920;
    const step = () => {
      if (hit) return;
      const p = Math.min(1, (Date.now() - t0) / dur);
      const ease = 1 - Math.pow(1 - p, 2.2);
      const curTargetX = S.lastCursorX || destX;
      const curTargetY = S.lastCursorY || destY;
      // Curved arc trajectory
      const arcY = -Math.sin(p * Math.PI) * 65;
      const cx = startX + (curTargetX - startX) * ease;
      const cy = startY + (curTargetY - startY) * ease + arcY;
      dart.style.left = cx.toFixed(1) + "px";
      dart.style.top = cy.toFixed(1) + "px";
      if (p < 1) {
        win.requestAnimationFrame(step);
      } else {
        detonate(cx, cy);
      }
    };
    win.requestAnimationFrame(step);
  }

  function toggleLargePortraitMode(win, forceState) {
    if (!S.largePortraitCard) return;
    const show = typeof forceState === "boolean" ? forceState : S.largePortraitCard.hidden;
    S.largePortraitCard.hidden = !show;
    if (S.headPortraitBtn) S.headPortraitBtn.classList.toggle("is-on", show);
    if (show) {
      if (S.adultPortrait && S.largePortraitImg) {
        S.largePortraitImg.src = S.adultPortrait.src || ADULT_PORTRAITS.warm;
      }
      syncLargePortraitCaption(win);
      playVocalSynthFx(win, "sigh");
      addArousalWarmth(win, 10, "ouverture du Grand Portrait HD");
      const av = S.el && S.el.querySelector(".hq-companion-avatar");
      if (av) spawnCuteHeart(win, av, "🖼️");
    }
  }

  function showProactiveQuickReplies(win, choices) {
    if (!S.quickRepliesEl) return;
    S.quickRepliesEl.replaceChildren();
    if (!choices || !choices.length) {
      S.quickRepliesEl.hidden = true;
      return;
    }
    choices.forEach((ch) => {
      const btn = win.document.createElement("button");
      btn.type = "button";
      btn.className = "hq-companion-quick-pill";
      btn.textContent = ch.label;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        S.quickRepliesEl.hidden = true;
        if (typeof ch.onSelect === "function") ch.onSelect();
      });
      S.quickRepliesEl.appendChild(btn);
    });
    S.quickRepliesEl.hidden = false;
  }

  function triggerProactiveSeduction(win) {
    if (!S.el || S.el.hidden) return;
    if (S.collapsed) setCollapsed(false, true);
    const av = S.el.querySelector(".hq-companion-avatar");
    playVocalSynthFx(win, "whisper");
    if (av) spawnCuteHeart(win, av, "🔥");

    const scenarios = [
      {
        prompt: "Tu prends l'initiative de séduire Marco pendant qu'il est sur {view} : demande-lui s'il veut que tu t'approches en grand format tout près de lui",
        fallbacks: [
          "Dis-moi Maître… tu me laisses m'approcher en grand format tout près de toi pendant que tu gères {view} ? 🔥♥",
          "J'ai envie que tu me regardes de plus près, mon amour… qu'est-ce que tu en dis ? ♥"
        ],
        choices: [
          {
            label: "🖼️ Viens tout près ♥",
            onSelect: () => executeMasterCommand(win, "closer")
          },
          {
            label: "🔥 Tente-moi encore",
            onSelect: () => executeMasterCommand(win, "hotter")
          }
        ]
      },
      {
        prompt: "Tu prends l'initiative de provoquer doucement Marco sur {view} : demande-lui s'il préfère que tu changes de tenue ou que tu lui donnes un baiser",
        fallbacks: [
          "Tu es tellement concentré sur {view}, Maître… tu préfères que je me dévoile un peu ou que je t'embrasse ? 💋🔥",
          "J'ai très chaud ici… dis-moi ce qui te ferait plaisir maintenant, mon amour ♥"
        ],
        choices: [
          {
            label: "👗 Change de tenue",
            onSelect: () => cycleCompanionOutfit(win, av)
          },
          {
            label: "💋 Embrasse-moi",
            onSelect: () => {
              playVocalSynthFx(win, "mwah");
              addArousalWarmth(win, 16, "baiser demandé");
              if (av) spawnCuteHeart(win, av, "💋");
              triggerInteractiveAiReaction(win, "Marco a choisi ton baiser passionné", [
                "Mwah 💋 ! Mes lèvres sont toutes à toi, mon Maître adoré ♥"
              ]);
            }
          }
        ]
      },
      {
        prompt: "Tu prends l'initiative de murmurer à Marco que tu as envie de poser pour lui maintenant",
        fallbacks: [
          "Maître… j'ai une envie folle de prendre une pose rien que pour tes yeux maintenant 📸♥",
          "Regarde-moi deux secondes, mon amour… tu veux une surprise ? ✨♥"
        ],
        choices: [
          {
            label: "📸 Prends la pose pour moi",
            onSelect: () => triggerSpontaneousSelfie(win, av)
          },
          {
            label: "👀 Regarde-moi dans les yeux",
            onSelect: () => executeMasterCommand(win, "look")
          }
        ]
      }
    ];
    const picked = scenarios[Math.floor(Math.random() * scenarios.length)];
    showProactiveQuickReplies(win, picked.choices);
    triggerInteractiveAiReaction(win, picked.prompt, picked.fallbacks);
  }

  function executeMasterCommand(win, cmdId) {
    if (!S.el) return;
    if (S.collapsed) setCollapsed(false, true);
    const av = S.el.querySelector(".hq-companion-avatar");
    if (cmdId === "closer") {
      toggleLargePortraitMode(win, true);
      if (S.largePortraitImg && S.adultPortrait) {
        S.largePortraitImg.src = S.adultPortrait.src;
      }
      triggerInteractiveAiReaction(
        win,
        "Marco vient de te donner l'ordre « Approche-toi » : tu obéis immédiatement en affichant ton Grand Portrait HD tout près de lui",
        [
          "Tout de suite, Maître… me voilà tout près de toi en grand format, détaille-moi autant que tu veux 🖼️♥",
          "À tes ordres mon amour… plus rien ne nous sépare maintenant ♥"
        ]
      );
      return;
    }
    if (cmdId === "booty") {
      playBootyTease(win, "all-fours-broom", 6500, true);
      return;
    }
    if (cmdId === "look") {
      S.el.classList.add("is-eye-lock");
      if (S.adultPortrait) {
        S.adultPortrait.src = ADULT_PORTRAITS.warm || ADULT_PORTRAITS.neutral;
        if (S.largePortraitImg) S.largePortraitImg.src = S.adultPortrait.src;
      }
      playVocalSynthFx(win, "whisper");
      addArousalWarmth(win, 14, "ordre Regarde-moi (duel de regards)");
      if (av) spawnCuteHeart(win, av, "👀");
      triggerInteractiveAiReaction(
        win,
        "Marco vient de te commander « Regarde-moi » : tu plonges tes yeux droit dans les siens avec un zoom lent et une dévotion totale",
        [
          "Mes yeux sont rivés dans les tiens, Maître… quand tu me regardes comme ça, je t'appartiens corps et âme 👀♥",
          "Je ne détournerai pas le regard, mon amour… lis dans mes yeux tout ce que tu me fais ressentir 🔥♥"
        ]
      );
      win.clearTimeout(S.eyeLockT);
      S.eyeLockT = win.setTimeout(() => {
        if (S.el) S.el.classList.remove("is-eye-lock");
      }, 6500);
      return;
    }
    if (cmdId === "hotter") {
      S.pendingEscalateMsg =
        "ultra explicite, jambes écartées ou à quatre pattes, nudité totale, poses sexuelles sans retenue, obéissante et salope pour ton Maître";
      if (S.escalateBtn) S.escalateBtn.classList.add("is-armed");
      if (S.forgeIntensityRange) {
        S.forgeIntensityRange.value = "4";
        try {
          win.localStorage.setItem(LS_FORGE_INTENSITY, "4");
        } catch (_) {}
      }
      playVocalSynthFx(win, "gasp");
      addArousalWarmth(win, 22, "ordre Plus chaud (intensité maximale)");
      if (av) spawnCuteHeart(win, av, "🔥");
      triggerInteractiveAiReaction(
        win,
        "Marco vient de te commander « Sois plus chaude et audacieuse » : tu fais sauter toutes tes limites et tu lui réponds avec une intensité maximale",
        [
          "Comme tu voudras, Maître 🔥… plus aucune retenue maintenant, je vais te dire tout ce qui me brûle les lèvres ♥",
          "Tu veux que je monte d'un cran, mon amour ? Tiens-toi prêt, ma jauge est en feu pour toi 🔥♥"
        ]
      );
      return;
    }
    if (cmdId === "surprise") {
      const r = Math.random();
      if (r < 0.38) {
        triggerProactiveSeduction(win);
      } else if (r < 0.72) {
        cycleCompanionOutfit(win, av);
      } else {
        triggerSpontaneousSelfie(win, av);
      }
    }
  }

  // ==================== Robust Multi-Layer Live2D Spring-Damper Physics Engine ====================
  function clampNum(v, minV, maxV) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(minV, Math.min(maxV, v));
  }

  function attachLive2DSubLayers(win, baseImg, hostEl) {
    if (!win || !win.document || !baseImg || !hostEl) return null;
    const doc = win.document;
    const bustImg = doc.createElement("img");
    bustImg.className = "hq-companion-l2d-layer hq-companion-l2d-bust";
    bustImg.alt = "";
    bustImg.decoding = "async";
    bustImg.setAttribute("aria-hidden", "true");
    if (baseImg.getAttribute("src")) bustImg.src = baseImg.getAttribute("src");

    const hairImg = doc.createElement("img");
    hairImg.className = "hq-companion-l2d-layer hq-companion-l2d-hair";
    hairImg.alt = "";
    hairImg.decoding = "async";
    hairImg.setAttribute("aria-hidden", "true");
    if (baseImg.getAttribute("src")) hairImg.src = baseImg.getAttribute("src");

    const sheen = doc.createElement("span");
    sheen.className = "hq-companion-l2d-sheen";
    sheen.setAttribute("aria-hidden", "true");

    hostEl.append(bustImg, hairImg, sheen);

    const syncLayers = () => {
      const src = baseImg.getAttribute("src") || baseImg.src || "";
      if (src) {
        if (bustImg.getAttribute("src") !== src) bustImg.src = src;
        if (hairImg.getAttribute("src") !== src) hairImg.src = src;
      }
      const op = baseImg.style && baseImg.style.objectPosition;
      if (op) {
        bustImg.style.objectPosition = op;
        hairImg.style.objectPosition = op;
      } else {
        bustImg.style.removeProperty("object-position");
        hairImg.style.removeProperty("object-position");
      }
    };

    if (typeof win.MutationObserver === "function") {
      new win.MutationObserver(syncLayers).observe(baseImg, {
        attributes: true,
        attributeFilter: ["src", "style", "data-mood"]
      });
    }
    syncLayers();
    return { bustImg, hairImg, sheen, syncLayers };
  }

  function ensureReactionAudioScript(win) {
    if (win.HqCompanionReactionAudio && win.HqCompanionSfxBus) return Promise.resolve();
    if (S.reactionAudioScriptLoad) return S.reactionAudioScriptLoad;
    S.reactionAudioScriptLoad = new Promise((resolve) => {
      const loadChain = (src, attr) => new Promise((res) => {
        let el = attr ? win.document.querySelector(`script[${attr}]`) : null;
        if (el) {
          el.addEventListener("load", () => res(), { once: true });
          el.addEventListener("error", () => res(), { once: true });
          return;
        }
        el = win.document.createElement("script");
        el.src = src;
        if (attr) el.setAttribute(attr, "");
        el.addEventListener("load", () => res(), { once: true });
        el.addEventListener("error", () => res(), { once: true });
        win.document.head.appendChild(el);
      });
      loadChain("/assets/hq-companion-sfx-bus.js", "data-hq-sfx-bus")
        .then(() => loadChain("/assets/hq-companion-reaction-audio.js", "data-hq-reaction-audio"))
        .then(() => resolve());
    });
    return S.reactionAudioScriptLoad;
  }

  function primeCompanionAudioContext(win) {
    if (S.audioCtxPrimed) return;
    S.audioCtxPrimed = true;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      ensureCompanionSfxBus(S.audioCtx);
      if (S.audioCtx.state === "suspended") S.audioCtx.resume().catch(() => {});
      updateCompanionSfxDuck(win);
    } catch (_) {}
  }

  function prefetchReactionUrls(win, urls) {
    if (!urls?.length) return;
    if (!S.reactionPrefetchUrls) S.reactionPrefetchUrls = new Set();
    for (const url of urls) {
      if (!url || S.reactionPrefetchUrls.has(url)) continue;
      S.reactionPrefetchUrls.add(url);
      win.fetch(url).catch(() => {});
    }
  }

  function warmReactionSamples(win, urls, background) {
    if (!urls?.length) return;
    primeCompanionAudioContext(win);
    S.reactionAudio?.warmSamples?.(urls)?.catch?.(() => {});
    if (!background?.length) return;
    const idle = win.requestIdleCallback || ((cb) => win.setTimeout(cb, 160));
    idle(() => warmReactionSamples(win, background, null));
  }

  function bindHotReactionPrefetch(win) {
    if (S.hotReactionPrefetchBound) return;
    S.hotReactionPrefetchBound = true;
    const run = () => {
      if (S.hotReactionPrefetchDone) return;
      S.hotReactionPrefetchDone = true;
      warmReactionSamples(
        win,
        S.reactionAudio?.warmPriorityUrls?.({ nsfwOn: !!S.nsfwOn })?.hot ||
          S.reactionAudio?.hotPrefetchUrls?.(),
        S.reactionAudio?.warmPriorityUrls?.({ nsfwOn: !!S.nsfwOn })?.background ||
          S.reactionAudio?.backgroundPrefetchUrls?.()
      );
    };
    win.addEventListener("pointerdown", run, { once: true, capture: true });
    win.addEventListener("keydown", run, { once: true, capture: true });
  }

  function watchCompanionAudioPrime(win) {
    if (S.companionAudioPrimeWatch || !win.IntersectionObserver) return;
    const attach = () => {
      if (!S.el || S.companionAudioPrimeWatch) return;
      S.companionAudioPrimeWatch = new win.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) primeCompanionAudioContext(win);
      }, { threshold: 0.08 });
      S.companionAudioPrimeWatch.observe(S.el);
    };
    if (S.el) attach();
    else win.requestAnimationFrame(attach);
  }

  function installReactionAudioPlayer(win) {
    if (S.reactionAudio) return S.reactionAudio.ready;
    if (!win.HqCompanionReactionAudio) return Promise.resolve(false);
    primeCompanionAudioContext(win);
    S.reactionAudio = win.HqCompanionReactionAudio.create(win, () => readForgeSound(win) && !muted(win) &&
      !win.document.hidden && !!S.el && !S.el.classList.contains("is-speaking") && !S.el.classList.contains("is-voice-lipsync"), Math.random,
      () => {
        primeCompanionAudioContext(win);
        const bus = ensureCompanionSfxBus(S.audioCtx);
        return { smoothStops: true, paceReactions: true,
          audioContext: S.audioCtx,
          sfxBus: bus,
          nsfwOn: !!S.nsfwOn,
          connectVoiceOut: (node) => { if (bus && node) bus.connectVoice(node); },
          typing: !!S.typingAt && Date.now() - S.typingAt < 5000,
          busy: !!(S.busy || S.chatBusy || S.voicePreview || S.currentAudio),
          mediaPlaying: !!S.el?.classList.contains("is-music-grooving") };
      });
    bindHotReactionPrefetch(win);
    watchCompanionAudioPrime(win);
    S.reactionAudio.ready.then((ok) => {
      if (!ok) return;
      const urls = S.reactionAudio.pleasureGruntUrls?.();
      if (urls?.length) S.pleasureGruntUrls = urls;
      const slaps = S.reactionAudio.slapImpactUrls?.();
      if (slaps?.length) {
        const idle = win.requestIdleCallback || ((cb) => win.setTimeout(cb, 320));
        // Only the first takes at idle: the full set is decoded after the first slap (scheduleFullImpactWarm) instead of ~40 fetches at startup.
        idle(() => { if (!win.document.hidden) warmReactionSamples(win, slaps.slice(0, 2), null); });
      }
      if (S.nsfwOn) warmTitPullImpactAudio(win);
      watchCompanionAudioPrime(win);
      updateCompanionSfxDuck(win);
    });
    return S.reactionAudio.ready;
  }

  function bootstrapCompanionAudio(win) {
    return ensureReactionAudioScript(win).then(() => installReactionAudioPlayer(win));
  }

  function attachExpressiveMouth(win, wrap) {
    bootstrapCompanionAudio(win);
    const install = () => {
      if (!win.HqCompanionMouth || !S.el) return;
      S.mouthRig = win.HqCompanionMouth.attach(win, wrap, S.el, () => startLive2DLoop(win), {
        start: kind => S.reactionAudio?.start(kind, { interrupt: false, priority: 0 }) || 0,
        stop: kind => S.reactionAudio?.stop(kind),
        onSpeechPause(word) {
          if (calm(win) || !S.nsfwOn || !S.el) return;
          const w = String(word || "");
          const pause = /[.!?…]["»)]?\s*$/.test(w) ? 340 : /[,;:]["»)]?\s*$/.test(w) ? 180 : 0;
          if (pause < 180) return;
          S.breathEvent = { kind: pause >= 320 ? "sigh" : "gasp", t0: win.performance.now() };
        }
      });
    };
    if (win.HqCompanionMouth) { Promise.resolve().then(install); return; }
    let script = win.document.querySelector("script[data-hq-mouth-module]");
    if (!script) {
      script = win.document.createElement("script");
      script.src = "/assets/hq-companion-mouth.js";
      script.setAttribute("data-hq-mouth-module", "");
      script.addEventListener("load", install, { once: true });
      win.document.head.appendChild(script);
    } else script.addEventListener("load", install, { once: true });
  }

  function ensureBustLobeLitStacks(garment, win) {
    if (!garment || !win) return;
    const doc = win.document;
    garment.querySelector(".hq-companion-rig-bust-specular")?.remove();
    garment.querySelectorAll(".hq-companion-rig-bust-ripple").forEach((el) => el.remove());
    garment.querySelectorAll(".hq-companion-rig-lobe-lit").forEach((el) => el.remove());
    for (const side of ["left", "right"]) {
      const img = garment.querySelector(".hq-companion-rig-bust-" + side);
      if (!img || img.closest(".hq-companion-rig-bust-stack-" + side)) continue;
      const stack = doc.createElement("span");
      stack.className = "hq-companion-rig-bust-stack hq-companion-rig-bust-stack-" + side;
      garment.insertBefore(stack, img);
      stack.append(img);

      const rim = doc.createElement("img");
      rim.className = "hq-companion-rig-layer hq-companion-rig-bust-rim hq-companion-rig-bust-rim-" + side;
      rim.src = RIG_NEUTRAL_BASE + "breast-" + side + "-rim.png";
      rim.alt = "";
      rim.draggable = false;
      rim.decoding = "async";
      stack.append(rim);

      const laceShadow = doc.createElement("img");
      laceShadow.className = "hq-companion-rig-layer hq-companion-rig-bust-lace-shadow hq-companion-rig-bust-lace-shadow-" + side;
      laceShadow.src = RIG_NEUTRAL_BASE + "breast-" + side + "-lace-shadow.png";
      laceShadow.alt = "";
      laceShadow.draggable = false;
      laceShadow.decoding = "async";
      stack.append(laceShadow);

      const lace = doc.createElement("img");
      lace.className = "hq-companion-rig-layer hq-companion-rig-bust-lace hq-companion-rig-bust-lace-" + side;
      lace.src = RIG_NEUTRAL_BASE + "breast-" + side + "-lace.png";
      lace.alt = "";
      lace.draggable = false;
      lace.decoding = "async";
      stack.append(lace);
    }
  }

  function updateLayeredBustSpecular(stEl, st, dt, opts) {
    if (!stEl || !st) return;
    if (!st.specLag) st.specLag = { lu: 36, lv: 56, ru: 64, rv: 56 };
    const phase = opts.phase || 0;
    const driftU = Math.sin(phase * 0.82) * 1.8 + Math.sin(phase * 1.55 + 0.2) * 0.9;
    const driftV = Math.cos(phase * 0.71) * 1.4 + (opts.breathWave || 0) * 0.08;
    const left = opts.left || {};
    const right = opts.right || {};
    const slU = ((left.sloshX || 0) + (opts.lampX || 0) * 0.35) * 0.55;
    const slV = ((left.sloshY || 0) + (opts.lampY || 0) * 0.28) * 0.48;
    const srU = ((right.sloshX || 0) + (opts.lampX || 0) * 0.35) * 0.55;
    const srV = ((right.sloshY || 0) + (opts.lampY || 0) * 0.28) * 0.48;
    const follow = clampNum(dt * (opts.mobileLite ? 7.5 : 11), 0.1, 0.45);
    st.specLag.lu += (clampNum(36 + driftU + slU, 30, 42) - st.specLag.lu) * follow;
    st.specLag.lv += (clampNum(56 + driftV + slV, 50, 62) - st.specLag.lv) * follow;
    st.specLag.ru += (clampNum(64 + driftU * 0.85 - srU, 58, 70) - st.specLag.ru) * follow;
    st.specLag.rv += (clampNum(57 + driftV * 0.92 + srV, 51, 63) - st.specLag.rv) * follow;
    const power = clampNum(
      0.42 + (opts.wNorm || 0) * 0.12 + (opts.pullT || 0) * 0.2 +
      Math.hypot(opts.bustVx || 0, opts.bustVy || 0) * 0.0025,
      0.32, 0.88);
    const brightL = clampNum(
      1 + (left.sloshX || 0) * 0.0018 + (left.sloshY || 0) * 0.0012 + driftU * 0.0025 +
      (opts.pullT || 0) * 0.018,
      0.985, 1.045);
    const brightR = clampNum(
      1 + (right.sloshX || 0) * 0.0018 + (right.sloshY || 0) * 0.0012 - driftU * 0.002 +
      (opts.pullT || 0) * 0.018,
      0.985, 1.045);
    setLive2dStyleVar(stEl, "--rig-spec-l-u", st.specLag.lu.toFixed(1) + "%");
    setLive2dStyleVar(stEl, "--rig-spec-l-v", st.specLag.lv.toFixed(1) + "%");
    setLive2dStyleVar(stEl, "--rig-spec-r-u", st.specLag.ru.toFixed(1) + "%");
    setLive2dStyleVar(stEl, "--rig-spec-r-v", st.specLag.rv.toFixed(1) + "%");
    setLive2dStyleVar(stEl, "--rig-spec-power", power.toFixed(2));
    setLive2dStyleVar(stEl, "--rig-lobe-bright-l", brightL.toFixed(2));
    setLive2dStyleVar(stEl, "--rig-lobe-bright-r", brightR.toFixed(2));

    // 2.5D Radial lattice deformation: center apex bulges forward, thorax anchors stay fixed
    const pullT = opts.pullT || 0;
    const sloshMag = Math.hypot(left.sloshVx || 0, left.sloshVy || 0) * 0.012 +
                     Math.hypot(right.sloshVx || 0, right.sloshVy || 0) * 0.012;
    const breathBulge = (opts.breathWave || 0) * 1.8;
    const dispScale = clampNum(pullT * 22.0 + sloshMag * 8.0 + breathBulge, -12, 28);
    setLive2dStyleVar(stEl, "--rig-bust-disp-scale", dispScale.toFixed(1));
    const rimGlow = clampNum(0.72 + (opts.pullT || 0) * 0.24 + Math.sin(phase * 0.82) * 0.08, 0.55, 1.0);
    setLive2dStyleVar(stEl, "--rig-rim-glow", rimGlow.toFixed(2));


  }

  const LS_RIG_POSTURE = "hq_companion_posture_v1";
  const LS_RIG_CLOTH = "hq_companion_cloth_tension_v1";
  function publishRigPosture(pose, reduced) {
    if (!S.el) return;
    const x = -pose.pitch*5, z = pose.roll*3.5, angle = Math.hypot(x,z);
    const axis = angle<.0001 ? "1 0 0 " : x.toFixed(3)+" 0 "+z.toFixed(3)+" ";
    setLive2dStyleVar(S.el.style,"--rig-posture-rotation",axis+angle.toFixed(3)+"deg");
    setLive2dStyleVar(S.el.style,"--rig-posture-counter-rotation",axis+(-angle).toFixed(3)+"deg");
    const g = rigPostureGravity(pose.pitch,pose.roll);
    for (const side of ["left","right"]) {
      const sign = side==='left'?-1:1;
      setLive2dStyleVar(S.el.style,"--rig-posture-"+side+"-bend",(reduced ? g.tilt*18+sign*g.spread*1.6 : 0).toFixed(3)+"deg");
      setLive2dStyleVar(S.el.style,"--rig-posture-"+side+"-sy",(reduced ? 1+g.hang*.016 : 1).toFixed(4));
      setLive2dStyleVar(S.el.style,"--rig-posture-"+side+"-sx",(reduced ? 1/Math.sqrt(1+g.hang*.016) : 1).toFixed(4));
    }
  }
  function syncRigClothing(st, dt, inputs, reduced) {
    if (!S.clothLayers || S.clothEnabled === false || !S.el?.classList.contains("has-layered-portrait")) return;
    st.cloth = st.cloth || {left:0,right:0};
    for (const side of ["left","right"]) {
      const layer = S.clothLayers[side];
      if (!layer) continue;
      const target = S.clothEnabled === false ? 0 : clothTensionTarget(inputs[side]);
      const value = stepClothTension(st.cloth[side],target,dt,reduced);
      st.cloth[side] = value;
      const direction = clampNum(S.bustPull?.active ? (S.pullRenderShear || 0)*2 : (inputs[side].bend || 0)*.08+(inputs[side].x || 0)*.04,-1,1);
      const key = value.toFixed(2)+":"+direction.toFixed(1);
      if (layer.last === key) continue;
      layer.last = key;
      // Amplify the visual response, not the physical forces, at small avatar sizes.
      const visible = Math.sqrt(Number(value.toFixed(2)));
      const d = rigClothCurves(side,visible,Number(direction.toFixed(1)));
      layer.shadow.setAttribute("d",d);
      layer.thread.setAttribute("d",d);
      layer.texture.setAttribute("transform",rigClothTextureTransform(side,visible,direction));
      layer.svg.style.opacity = Math.min(.95,visible*1.5).toFixed(2);
      layer.svg.dataset.tension = value.toFixed(2);
    }
  }
  function applyRigPostureSetting(win) {
    const st = ensureLive2DState(), reduced = calm(win);
    const frozen = !!(S.bustPull && S.bustPull.active);
    st.posture = stepRigPosture(st.posture,S.rigPosture,0,frozen,reduced);
    publishRigPosture(st.posture,reduced);
    if (reduced && !frozen) {
      const g = rigPostureGravity(st.posture.pitch,st.posture.roll);
      syncRigClothing(st,0,{left:{sy:1+g.hang*.016},right:{sy:1+g.hang*.016}},true);
    } else if (!reduced) startLive2DLoop(win);
  }

  function attachLayeredPortrait(win, avatar, baseImg) {
    const doc = win.document;
    const rig = doc.createElement("span");
    rig.className = "hq-companion-portrait-rig";
    rig.setAttribute("aria-hidden", "true");
    const clip = doc.createElement("span");
    clip.className = "hq-companion-rig-clip";
    rig.appendChild(clip);
    const body = doc.createElement("span");
    body.className = "hq-companion-rig-body";
    const bodyClip = doc.createElement("span");
    bodyClip.className = "hq-companion-rig-clip";
    body.appendChild(bodyClip);
    rig.appendChild(body);
    const images = [];
    const garment = doc.createElement("span");
    garment.className = "hq-companion-rig-garment-front";
    body.appendChild(garment);
    const underboob = doc.createElement("span");
    underboob.className = "hq-companion-rig-underboob-shadow";
    underboob.setAttribute("aria-hidden", "true");
    garment.appendChild(underboob);
    const cleft = doc.createElement("span");
    cleft.className = "hq-companion-rig-cleavage-cleft";
    cleft.setAttribute("aria-hidden", "true");
    garment.appendChild(cleft);
    for (const part of ["background", "torso", "face", "garment-surface", "hair-base", "hair-left", "hair-right"]) {
      const image = doc.createElement("img");
      image.className = "hq-companion-rig-layer hq-companion-rig-" + part;
      image.alt = "";
      image.draggable = false;
      image.decoding = "async";
      image.dataset.rigAsset = part.startsWith("hair-") ? "hair" :
        (part === "garment-surface" ? "garment-front" : part);
      images.push(image);
      if (part === "face") {
        const neck = image.cloneNode(false);
        neck.className = "hq-companion-rig-layer hq-companion-rig-neck";
        bodyClip.appendChild(neck);
        images.push(neck);
        const wrap = doc.createElement("span");
        wrap.className = "hq-companion-rig-face-wrap";
        image.className = "hq-companion-rig-layer hq-companion-rig-face hq-companion-rig-face-lower";
        // The original forehead came from the torso's full portrait. Once that
        // backdrop is cropped to the fixed ring, preserve this small skin patch
        // with the moving face so the enlarged crown has no transparent seam.
        const forehead = image.cloneNode(false);
        forehead.className = "hq-companion-rig-layer hq-companion-rig-forehead";
        forehead.dataset.rigAsset = "face";
        wrap.appendChild(forehead);
        images.push(forehead);
        wrap.appendChild(image);
        for (const side of ["left", "right"]) {
          const brow = image.cloneNode(false);
          brow.className = "hq-companion-rig-layer hq-companion-rig-face-brow hq-companion-rig-face-brow-" + side;
          brow.dataset.rigAsset = "face";
          wrap.appendChild(brow);
          images.push(brow);
        }
        const mouth = image.cloneNode(false);
        mouth.className = "hq-companion-rig-layer hq-companion-rig-face-mouth";
        mouth.dataset.rigAsset = "face";
        wrap.appendChild(mouth);
        images.push(mouth);
        body.appendChild(wrap);
        attachExpressiveMouth(win, wrap);
      } else if (part === "garment-surface") {
        garment.appendChild(image);
        for (const side of ["left", "right"]) {
          const local = image.cloneNode(false);
          const stack = doc.createElement("span");
          stack.className = "hq-companion-rig-bust-stack hq-companion-rig-bust-stack-" + side;
          local.className = "hq-companion-rig-layer hq-companion-rig-bust-" + side;
          local.dataset.rigAsset = "breast-" + side;
          stack.append(local);

          const rim = doc.createElement("img");
          rim.className = "hq-companion-rig-layer hq-companion-rig-bust-rim hq-companion-rig-bust-rim-" + side;
          rim.src = RIG_NEUTRAL_BASE + "breast-" + side + "-rim.png";
          rim.alt = "";
          rim.draggable = false;
          rim.decoding = "async";
          stack.append(rim);

          const laceShadow = doc.createElement("img");
          laceShadow.className = "hq-companion-rig-layer hq-companion-rig-bust-lace-shadow hq-companion-rig-bust-lace-shadow-" + side;
          laceShadow.src = RIG_NEUTRAL_BASE + "breast-" + side + "-lace-shadow.png";
          laceShadow.alt = "";
          laceShadow.draggable = false;
          laceShadow.decoding = "async";
          stack.append(laceShadow);

          const lace = doc.createElement("img");
          lace.className = "hq-companion-rig-layer hq-companion-rig-bust-lace hq-companion-rig-bust-lace-" + side;
          lace.src = RIG_NEUTRAL_BASE + "breast-" + side + "-lace.png";
          lace.alt = "";
          lace.draggable = false;
          lace.decoding = "async";
          stack.append(lace);

          const cloth = doc.createElementNS("http://www.w3.org/2000/svg","svg");
          cloth.setAttribute("viewBox","0 0 512 512");
          cloth.setAttribute("aria-hidden","true");
          cloth.classList.add("hq-companion-rig-cloth","is-"+side);
          // A feathered interior patch stretches the actual lace texture. Its
          // mask stays below the skin/garment edge, so it cannot reopen that seam.
          const ns=cloth.namespaceURI, defs=doc.createElementNS(ns,"defs");
          const gradient=doc.createElementNS(ns,"radialGradient");
          const gradientId="hq-cloth-feather-"+side, maskId="hq-cloth-interior-"+side;
          gradient.id=gradientId;
          for (const [offset,opacity] of [["0%","1"],["55%","1"],["100%","0"]]) {
            const stop=doc.createElementNS(ns,"stop");
            stop.setAttribute("offset",offset);stop.setAttribute("stop-color","white");stop.setAttribute("stop-opacity",opacity);gradient.appendChild(stop);
          }
          const mask=doc.createElementNS(ns,"mask");mask.id=maskId;
          mask.setAttribute("maskUnits","userSpaceOnUse");mask.setAttribute("x","0");mask.setAttribute("y","0");mask.setAttribute("width","512");mask.setAttribute("height","512");
          const ellipse=doc.createElementNS(ns,"ellipse");
          for (const [key,value] of Object.entries(side==='left'?{cx:139,cy:413,rx:50,ry:25}:{cx:345,cy:401,rx:51,ry:27})) ellipse.setAttribute(key,String(value));
          ellipse.setAttribute("fill","url(#"+gradientId+")");mask.appendChild(ellipse);defs.append(gradient,mask);
          const patch=doc.createElementNS(ns,"g");patch.setAttribute("mask","url(#"+maskId+")");
          const texture=doc.createElementNS(ns,"image");
          texture.setAttribute("href",rigNeutralLayerSrc("breast-"+side));
          texture.setAttribute("width","512");texture.setAttribute("height","512");
          patch.appendChild(texture);cloth.append(defs,patch);
          const shadow = doc.createElementNS(cloth.namespaceURI,"path");
          const thread = doc.createElementNS(cloth.namespaceURI,"path");
          shadow.setAttribute("class","cloth-fold-shadow");
          thread.setAttribute("class","cloth-fold-thread");
          cloth.append(shadow,thread);
          stack.appendChild(cloth);
          S.clothLayers = S.clothLayers || {};
          S.clothLayers[side] = {svg:cloth,shadow,thread,texture,last:null};
          garment.appendChild(stack);
          images.push(local);
        }
      } else if (part === "hair-left" || part === "hair-right") {
        const wrap = doc.createElement("span");
        wrap.className = "hq-companion-rig-hair-wrap hq-companion-rig-" + part + "-wrap";
        wrap.appendChild(image);
        const tip = image.cloneNode(false);
        tip.className = "hq-companion-rig-layer hq-companion-rig-" + part + "-tip";
        tip.dataset.rigAsset = "hair";
        wrap.appendChild(tip);
        images.push(tip);
        body.appendChild(wrap);
      } else {
        (part === "hair-base" ? body : bodyClip).appendChild(image);
        if (part === "hair-base") {
          // The ring illuminates the two sides of the crown, not the lower curls.
          // Share the crown's existing head transform and pull-freeze rules.
          for (const side of ["left", "right"]) {
            const glint = doc.createElement("span");
            glint.className = "hq-companion-rig-layer hq-companion-rig-hair-base hq-companion-rig-hair-sheen is-crown-" + side;
            glint.setAttribute("aria-hidden", "true");
            body.appendChild(glint);
          }
        }
      }
    }
    const sheen = doc.createElement("span");
    sheen.className = "hq-companion-rig-bust-sheen";
    sheen.setAttribute("aria-hidden", "true");
    garment.appendChild(sheen);
    const light = doc.createElement("span");
    light.className = "hq-companion-rig-light";
    body.appendChild(light);
    const eyelids = doc.createElement("span");
    eyelids.className = "hq-companion-rig-eyelids";
    const mouthOverlay = doc.createElement("span");
    mouthOverlay.className = "hq-companion-rig-mouth-open";
    mouthOverlay.setAttribute("aria-hidden", "true");
    body.appendChild(eyelids);
    body.appendChild(mouthOverlay);
    let ready = false, loading = null;
    const sync = () => {
      if (!S.el) return;
      const path = portraitPathOnly(win, baseImg.getAttribute("src") || "");
      const enabled = ready && S.nsfwOn && path === LAYERED_PORTRAIT;
      S.el.classList.toggle("has-layered-portrait", enabled);
      if (S.layeredPortraitBtn) S.layeredPortraitBtn.setAttribute("aria-pressed", String(enabled));
      if (enabled && S.nsfwOn && isCompactUI(win) && S.collapsed) startLive2DLoop(win);
      const garmentFront = rig.querySelector(".hq-companion-rig-garment-front");
      if (enabled && garmentFront) ensureBustLobeLitStacks(garmentFront, win);
      // Never stack full source.jpg (flat portrait / L2D bust) under the PNG lobes.
      baseImg.hidden = !!enabled;
      if (S.l2dAvatarRig) {
        if (S.l2dAvatarRig.bustImg) S.l2dAvatarRig.bustImg.hidden = !!enabled;
        if (S.l2dAvatarRig.hairImg) S.l2dAvatarRig.hairImg.hidden = !!enabled;
      }
      if (!ready && S.nsfwOn && path === LAYERED_PORTRAIT) ensure().catch(() => {});
    };
    S.syncLayeredPortrait = sync;
    new win.MutationObserver(sync).observe(baseImg, { attributes: true, attributeFilter: ["src"] });
    avatar.appendChild(rig);
    function ensure() {
      if (loading) return loading;
      // Download the larger texture pack only when this portrait is selected.
      loading = Promise.all(images.map((image) => new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = rigNeutralLayerSrc(image.dataset.rigAsset);
      }))).then(() => { ready = true; sync(); });
      return loading;
    }
    S.ensureLayeredPortrait = ensure;
    sync();
    return rig;
  }

  function ensureLive2DState() {
    if (!S.l2d) {
      S.l2d = {
        head: { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, driftX: 0, driftY: 0, sway: 0, vsway: 0, nod: 0, vnod: 0 },
        bust: { x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0 },
        bustSides: {
          left: { x: 0, y: 0, vx: 0, vy: 0, sloshX: 0, sloshY: 0, sloshVx: 0, sloshVy: 0, rippleX: 0, rippleY: 0, prevVx: 0, prevVy: 0 },
          right: { x: 0, y: 0, vx: 0, vy: 0, sloshX: 0, sloshY: 0, sloshVx: 0, sloshVy: 0, rippleX: 0, rippleY: 0, prevVx: 0, prevVy: 0 }
        },
        bustPrevVx: 0,
        bustPrevVy: 0,
        cleavageSeam: { sx: 1, sy: 1, tension: 0 },
        hair: { x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0 },
        mouthMot: { sy: 1, sx: 1, y: 0 },
        browMot: { leftY: 0, rightY: 0, leftRot: 0, rightRot: 0 },
        avatarMotion: { x: null, y: null, vx: 0, vy: 0 },
        bubbleMotion: { x: null, y: null, vx: 0, vy: 0 },
        phoneShake: { x: 0, y: 0, vx: 0, vy: 0, pulseAt: 0, pulseX: 0, pulseY: 0, targetX: 0, targetY: 0 },
        phase: 0,
        lastT: 0,
        lastWorkAt: 0,
        idleJigglePhase: 0,
        raf: 0,
        waitT: 0
      };
    }
    return S.l2d;
  }

  // The mouth layer is the only reader of --rig-mouth-sx/sy/y: they live on it, not on the companion
  // root, so her idle mouth motion (written every frame) does not restyle the whole companion.
  function mouthVarStyle() {
    // Called every frame: keep the mouth element until the rig is rebuilt.
    let el = S.mouthVarEl;
    if (!el || !el.isConnected || !S.el || !S.el.contains(el)) {
      el = S.el && S.el.querySelector(".hq-companion-rig-face-mouth");
      S.mouthVarEl = el || null;
    }
    return el ? el.style : S.el ? S.el.style : null;
  }

  // Pull variables (written on every pull move) go on the element that reads them, like the rig
  // physics, instead of the companion root, which would restyle all ~460 elements per move. Their
  // current values are kept here, so code that needs them reads this map, not the root's style.
  function setPullVar(key, value) {
    if (!S.el) return;
    if (!S.pullVars) S.pullVars = Object.create(null);
    if (S.pullVars[key] === value) return;
    S.pullVars[key] = value;
    const scope = live2dVarScope(key);
    if (scope === L2D_NO_READER) return;
    // No stylesheet (rule or animation) reads it: keep it in memory only (getPullVar reads the map).
    if (!scope && S.l2dVarIndex && !(S.l2dVarIndex.get(key) || []).length) return;
    if (Array.isArray(scope)) scope.forEach((el) => el.style.setProperty(key, value));
    else (scope || S.el).style.setProperty(key, value);
  }

  function clearPullVar(key) {
    if (!S.el) return;
    S.el.style.removeProperty(key);
    const scope = S.l2dVarScopes && S.l2dVarScopes.get(key);
    [].concat(scope || []).forEach((el) => el && el.style && el.style.removeProperty(key));
    if (S.pullVars) delete S.pullVars[key];
  }

  function getPullVar(key) {
    const v = S.pullVars && S.pullVars[key];
    return v !== undefined ? v : S.el ? S.el.style.getPropertyValue(key) : "";
  }

  function setLive2dStyleVar(stEl, key, value) {
    const st = ensureLive2DState();
    if (!st.styleCache) st.styleCache = Object.create(null);
    if (st.styleCache[key] === value) return;
    st.styleCache[key] = value;
    const scope = S.el && stEl === S.el.style ? live2dVarScope(key) : null;
    if (scope === L2D_NO_READER) return;
    if (Array.isArray(scope)) scope.forEach((el) => el.style.setProperty(key, value));
    else (scope ? scope.style : stEl).setProperty(key, value);
  }

  function clearLive2dStyleVar(stEl, key) {
    stEl.removeProperty(key);
    const scope = S.l2dVarScopes && S.l2dVarScopes.get(key);
    [].concat(scope || []).forEach((el) => el && el.style && el.style.removeProperty(key));
    const cache = ensureLive2DState().styleCache;
    if (cache) delete cache[key];
  }

  // Per-frame rig variables used to be written on the companion root, which makes the browser
  // restyle all ~460 descendants every frame (~10-15 ms). Each one now goes on the smallest element
  // that contains every CSS rule reading it, so only that subtree restyles. Keys that other code
  // also sets, resets or reads on the root stay there.
  // Marker: no element in the companion reads this variable (e.g. retired rig layers), so skip it.
  const L2D_NO_READER = {};
  const L2D_ROOT_VARS = new Set([
    "--rig-mouth-sx", "--rig-mouth-sy", "--rig-mouth-y", "--rig-voice-level",
  ]);
  // Paired with the non-inheriting @property declarations in hq-companion.css.
  // Every reader (including nested readers and keyframe targets) needs its own
  // value; a common ancestor cannot supply these inputs through inheritance.
  const L2D_LOCAL_VARS = new Set([
    "--rig-body-bob", "--rig-body-tilt", "--rig-parallax-x", "--rig-parallax-y",
    "--rig-head-sway", "--rig-head-nod", "--rig-neck-lift", "--rig-bust-heave", "--rig-head-steady-y",
    "--rig-saccade-x", "--rig-saccade-y",
    "--rig-hair-left-tip-x", "--rig-hair-left-tip-y", "--rig-hair-left-tip-rot",
    "--rig-hair-right-tip-x", "--rig-hair-right-tip-y", "--rig-hair-right-tip-rot",
  ]);

  function live2dVarIndex(doc) {
    const index = new Map();
    const add = (key, selectorText) => {
      let list = index.get(key);
      if (!list) index.set(key, (list = []));
      list.push(selectorText);
    };
    // Variables used inside @keyframes are read by whichever elements run that animation.
    const kfVars = new Map();
    const animRules = [];
    const visit = (rules) => {
      for (const r of rules) {
        if (r.type === 7 && r.name) {
          const vars = new Set();
          for (const frame of r.cssRules) for (const m of frame.style.cssText.matchAll(/var\((--[\w-]+)/g)) vars.add(m[1]);
          if (vars.size) kfVars.set(r.name, vars);
          continue;
        }
        if (r.cssRules && !r.selectorText) {
          visit(r.cssRules);
          continue;
        }
        if (!r.selectorText || !r.style) continue;
        // A shorthand containing var() leaves animationName empty: fall back to the shorthand text.
        const anim = r.style.animationName || r.style.getPropertyValue("animation") || "";
        if (anim && anim !== "none") animRules.push([r.selectorText, anim]);
        if (r.style.cssText.indexOf("var(--") < 0) continue;
        for (const m of r.style.cssText.matchAll(/var\((--[\w-]+)/g)) add(m[1], r.selectorText);
      }
    };
    for (const sheet of doc.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch (_) {}
    }
    for (const [selectorText, anim] of animRules) {
      const words = new Set(anim.split(/[\s,]+/));
      kfVars.forEach((vars, name) => {
        if (words.has(name)) vars.forEach((key) => add(key, selectorText));
      });
    }
    return index;
  }

  // Rightmost compound of a selector with pseudo-classes/elements removed: it matches a superset
  // of the real targets whatever state classes are on the ancestors.
  function selectorSubjectQuery(sel) {
    let depth = 0;
    let cut = 0;
    for (let i = 0; i < sel.length; i += 1) {
      const ch = sel[i];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
    }
    let subject = sel.slice(cut).trim();
    let prev;
    do {
      prev = subject;
      subject = subject.replace(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "");
    } while (subject !== prev);
    return subject && subject !== "*" ? subject : "";
  }

  function live2dVarScope(key) {
    if (L2D_ROOT_VARS.has(key) || !S.el || !S.win) return null;
    const doc = S.win.document;
    if (!S.l2dVarObserver && S.win.MutationObserver) {
      S.l2dVarObserver = new S.win.MutationObserver((records) => {
        for (const rec of records) {
          for (const n of rec.addedNodes) {
            if (n.nodeType === 1 && /hq-companion-(rig|l2d)|hq-bust-(light|shade|dent|ripple|nl|cast|spec)/.test(n.getAttribute("class") || "")) {
              S.l2dVarSheets = -1;
              return;
            }
          }
        }
      });
      S.l2dVarObserver.observe(S.el, { childList: true, subtree: true });
    }
    // A <link> stylesheet is listed before its rules load: also fingerprint the total rule count
    // (checked at most once a second), so placements computed against a half-loaded sheet are redone.
    const nowT = S.win.performance.now();
    if (!S.l2dFpAt || nowT - S.l2dFpAt > 1000) {
      S.l2dFpAt = nowT;
      let rules = 0;
      for (const sheet of doc.styleSheets) {
        try {
          rules += sheet.cssRules.length;
        } catch (_) {}
      }
      if (S.l2dRuleCount !== undefined && rules !== S.l2dRuleCount) S.l2dVarSheets = -1;
      S.l2dRuleCount = rules;
    }
    if (!S.l2dVarScopes || S.l2dVarSheets !== doc.styleSheets.length) {
      // New stylesheets can move a variable: drop the old inline values so none is left shadowing.
      if (S.l2dVarScopes) {
        const cache = ensureLive2DState().styleCache;
        S.l2dVarScopes.forEach((el, k) => {
          [].concat(el || []).forEach((e) => e && e.style && e.style.removeProperty(k));
          if (cache) delete cache[k];
        });
      }
      S.l2dVarScopes = new Map();
      S.l2dVarIndex = null;
      S.l2dVarSheets = doc.styleSheets.length;
    }
    if (S.l2dVarScopes.has(key)) return S.l2dVarScopes.get(key);
    if (!S.l2dVarIndex) S.l2dVarIndex = live2dVarIndex(doc);
    let lca = null;
    let ok = true;
    const readers = [];
    const groups = S.l2dVarIndex.get(key) || [];
    for (const group of groups) {
      for (const sel of group.split(",")) {
        const q = selectorSubjectQuery(sel.trim());
        let hits = null;
        try {
          hits = q ? S.el.querySelectorAll(q) : null;
        } catch (_) {}
        // Unparseable subject or the root itself: keep the variable on the root. A subject that
        // matches nothing reads nothing (retired layers); new rig layers reset the cache below.
        if (!hits || (q && S.el.matches(q))) ok = false;
        if (!ok) break;
        for (const el of hits) {
          readers.push(el);
          if (!lca) lca = el;
          while (lca && !lca.contains(el)) lca = lca.parentElement;
        }
      }
      if (!ok) break;
    }
    if (ok && L2D_LOCAL_VARS.has(key) && groups.length) {
      const scope = readers.length ? [...new Set(readers)] : L2D_NO_READER;
      S.l2dVarScopes.set(key, scope);
      return scope;
    }
    let scope = ok && groups.length && !lca ? L2D_NO_READER :
      ok && groups.length && lca && lca !== S.el && S.el.contains(lca) ? lca : null;
    // A few readers deep inside a big subtree (e.g. --pull-tension: a couple of rig layers under the
    // avatar): write on those readers rather than on their large common ancestor.
    if (scope && scope !== L2D_NO_READER && !Array.isArray(scope) && readers.length) {
      const outerReaders = [...new Set(readers)].filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)));
      if (outerReaders.length <= 8 && !outerReaders.includes(scope) && scope.getElementsByTagName("*").length > 60) scope = outerReaders;
    }
    // Readers in separate branches (e.g. bubble + avatar): write on each outermost reader rather
    // than the root. Only if few enough that a handful of small restyles beats one full one.
    if (!scope && ok && lca === S.el && readers.length) {
      const outer = [...new Set(readers)].filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)));
      if (outer.length && outer.length <= 6 && !outer.includes(S.el)) scope = outer;
    }
    S.l2dVarScopes.set(key, scope);
    return scope;
  }

  function ensureBustSideSlosh(side) {
    if (!side || side.sloshX !== undefined) return;
    side.sloshX = 0;
    side.sloshY = 0;
    side.sloshVx = 0;
    side.sloshVy = 0;
    side.prevVx = 0;
    side.prevVy = 0;
  }

  /** Independent “liquid in a jug” slosh per breast; cup motion = side spring, fluid lags with its own spring. */
  function tickBustSideSlosh(side, frameAx, frameAy, dt, tune) {
    ensureBustSideSlosh(side);
    const safeDt = clampNum(dt, 0.004, 0.05);
    const invDt = 1 / safeDt;
    const cupAx = (side.vx - side.prevVx) * invDt;
    const cupAy = (side.vy - side.prevVy) * invDt;
    side.prevVx = side.vx;
    side.prevVy = side.vy;
    const k = tune.stiff || 20;
    const c = tune.damp || 2.85;
    const cupCouple = tune.cup || 0.198;
    const frameCouple = tune.frame || 0.082;
    const ax = -side.sloshX * k - side.sloshVx * c - cupAx * cupCouple - frameAx * frameCouple;
    const ay = -side.sloshY * (k * 1.06) - side.sloshVy * (c * 1.04) - cupAy * (cupCouple * 1.1) - frameAy * (frameCouple * 1.08);
    side.sloshVx = clampNum(side.sloshVx + ax * safeDt, -248, 248);
    side.sloshVy = clampNum(side.sloshVy + ay * safeDt, -278, 278);
    const travel = tune.travel > 0 ? tune.travel : 1;
    const sloshLimX = 9.5 * travel;
    const sloshLimY = 11.5 * travel;
    side.sloshX += side.sloshVx * safeDt;
    side.sloshY += side.sloshVy * safeDt;
    bounceAxis(side, "sloshX", "sloshVx", sloshLimX, .4);
    bounceAxis(side, "sloshY", "sloshVy", sloshLimY, .4);
  }

  // ---- Soft tissue: per breast, a stiff "base" spring that follows the body and a soft "tip" that
  // hangs off it. The tip's stiffness rises with stretch and it is lightly damped, so a jolt gives
  // two or three diminishing bounces. Gravity pulls the tip along an arc when she tilts or is dragged
  // sideways. The right side sees the same inputs ~45 ms later and is a touch softer, so the two
  // settle out of step. Outputs: extra offset, a bend (tip vs base), volume-keeping stretch, a
  // highlight roll, an impact ripple and a surface-warp amount.
  // Bust feel, tunable in Outils > Réglages (1 = default): weight (how much further it drops than it
  // rises), softness (lower stiffness) and bounce (less damping = more, longer bounces).
  const LS_BUST_FEEL = "hq_companion_bust_feel";
  const LS_BUST_WARP = "hq_companion_bust_warp";
  const LS_BUST_NLIGHT = "hq_companion_bust_nlight";
  const BUST_FEEL_DEFAULT = { weight: 1, softness: 1, bounce: 1 };

  function readBustFeel(win) {
    if (S.bustFeel) return S.bustFeel;
    let v = null;
    try {
      v = JSON.parse((win || S.win).localStorage.getItem(LS_BUST_FEEL) || "null");
    } catch (_) {}
    const f = Object.assign({}, BUST_FEEL_DEFAULT);
    if (v && typeof v === "object") {
      for (const k of Object.keys(f)) if (Number.isFinite(v[k])) f[k] = clampNum(v[k], 0.5, 1.6);
    }
    S.bustFeel = f;
    return f;
  }

  function writeBustFeel(win, feel) {
    S.bustFeel = Object.assign({}, BUST_FEEL_DEFAULT, feel);
    try {
      win.localStorage.setItem(LS_BUST_FEEL, JSON.stringify(S.bustFeel));
    } catch (_) {}
  }

  function newSoftSide() {
    return { bx: 0, by: 0, bvx: 0, bvy: 0, tx: 0, ty: 0, tvx: 0, tvy: 0, ax: 0, ay: 0, tilt: 0, rip: 0, ripT: 0 };
  }

  function kickBustSoftTissue(st, ix, iy) {
    if (!st.soft) st.soft = { left: newSoftSide(), right: newSoftSide(), pending: [] };
    const mag = Math.hypot(ix, iy);
    if (!mag) return;
    // Right side gets the kick a beat later (and a little weaker) so they move out of step.
    st.soft.pending.push({ side: "left", ix: ix, iy: iy, at: 0 });
    st.soft.pending.push({ side: "right", ix: ix * 0.9, iy: iy * 0.94, at: 0.045 });
  }

  // Elastic limit: a spring that reaches its travel limit bounces back (velocity reversed and
  // damped) instead of sitting pressed against it, so a hard hit rebounds rather than parking.
  function bounceAxis(obj, posKey, velKey, lim, restitution) {
    const p = obj[posKey];
    if (p > lim) {
      obj[posKey] = lim;
      if (obj[velKey] > 0) obj[velKey] = -obj[velKey] * restitution;
    } else if (p < -lim) {
      obj[posKey] = -lim;
      if (obj[velKey] < 0) obj[velKey] = -obj[velKey] * restitution;
    }
  }

  function armLaughTremor(st, nowMs) {
    st.laughTremor = { until: nowMs + 400, next: nowMs, dir: 1 };
  }

  function tickLaughTremor(st, nowMs, blocked) {
    const tr = st.laughTremor;
    if (!tr || blocked || nowMs > tr.until) return;
    if (nowMs < tr.next) return;
    tr.next = nowMs + 78;
    tr.dir = -tr.dir;
    kickBustSoftSide(st, "left", tr.dir * 6.5, 2.4, 0);
    kickBustSoftSide(st, "right", -tr.dir * 5.5, 2.2, 0.018);
  }

  function tickVoiceSoftPulse(st, nowMs, blocked) {
    const level = S.voiceMeter && S.voiceMeter.level;
    if (blocked || !(level > 0.22)) return;
    if (nowMs - (st.voicePulseAt || 0) < 120) return;
    st.voicePulseAt = nowMs;
    kickBustSoftSide(st, "left", 0, level * 5.5, 0);
    kickBustSoftSide(st, "right", 0, level * 5, 0.02);
  }

  function kickBustSoftSide(st, side, ix, iy, delay) {
    if (!st.soft) st.soft = { left: newSoftSide(), right: newSoftSide(), pending: [] };
    st.soft.pending.push({ side: side, ix: ix, iy: iy, at: delay || 0 });
  }

  function tickBustSoftTissue(st, dt, input) {
    if (!st.soft) st.soft = { left: newSoftSide(), right: newSoftSide(), pending: [] };
    const soft = st.soft;
    const frameDt = clampNum(dt, 0.004, 0.05);
    // Fixed small steps (<= 4 ms): the same motion at 30, 60 or 144 fps, and no twitch after a
    // slow frame. A frame's inputs are held constant across its sub-steps.
    const steps = Math.min(12, Math.max(1, Math.ceil(frameDt / 0.004)));
    const h = frameDt / steps;
    const feel = readBustFeel();
    const kMul = (1 / feel.softness) * (1 - (st.tired || 0) * 0.12);
    const cMul = 1 / feel.bounce;
    const asym = 0.32 * feel.weight;
    const tNow = (input.now || 0) / 1000;
    let ripples = { left: 0, right: 0 };
    for (let step = 0; step < steps; step += 1) {
      // A hard slap briefly widens how far the tip may swing (decays over ~0.9 s).
      const boost = st.slapBoost || 0;
      st.slapBoost = boost > 0.01 ? boost * Math.exp(-h * 3.2) : 0;
      const swingCap = 7 + boost * 6;
      // Deliver pending (possibly delayed) kicks.
      soft.pending = soft.pending.filter((k) => {
        k.at -= h;
        if (k.at > 0) return true;
        const s = soft[k.side];
        s.tvx = clampNum(s.tvx + k.ix * 0.9, -420, 420);
        s.tvy = clampNum(s.tvy + k.iy * 0.95, -260, 260);
        s.bvx = clampNum(s.bvx + k.ix * 0.22, -120, 120);
        s.bvy = clampNum(s.bvy + k.iy * 0.22, -120, 120);
        const strength = clampNum(Math.hypot(k.ix, k.iy) / 70, 0, 1);
        if (strength > 0.18) {
          s.rip = Math.max(s.rip, strength);
          s.ripT = 0;
        }
        return false;
      });
      for (const name of ["left", "right"]) {
        const s = soft[name];
        const right = name === "right";
        const soften = right ? 0.92 : 1;
        // Right side follows the shared inputs through a ~45 ms lag.
        const follow = right ? Math.min(1, h / 0.045) : 1;
        s.ax += (input.ax - s.ax) * follow;
        s.ay += (input.ay - s.ay) * follow;
        s.tilt += (input.tilt - s.tilt) * follow;
        // Base: stiff, well damped, stays close to the body. Big swings shed energy faster.
        const baseAmp = Math.min(1, Math.hypot(s.bx, s.by) / 2.2);
        const baseDamp = 1 + baseAmp * 0.85;
        s.bvx += (-150 * kMul * s.bx - 16 * cMul * baseDamp * s.bvx - s.ax * 2.2) * h;
        s.bvy += (-160 * kMul * s.by - 17 * cMul * baseDamp * s.bvy - s.ay * 2.2) * h;
        s.bx = clampNum(s.bx + s.bvx * h, -3, 3);
        s.by = clampNum(s.by + s.bvy * h, -3, 3);
        // Tip: gravity target on an arc (pendulum of length ~10 px), stiffening as it stretches,
        // plus a tiny slow drift so she is never perfectly still.
        const phase = right ? 1.7 : 0;
        const driftX = (Math.sin(tNow * 0.63 + phase) + 0.6 * Math.sin(tNow * 1.37 + phase * 2.1)) * 0.12;
        const driftY = (Math.sin(tNow * 0.51 + phase * 1.3) + 0.5 * Math.sin(tNow * 1.11 + phase)) * 0.1;
        const theta = s.tilt;
        const gx = Math.sin(theta) * 10 + driftX + (right?1:-1)*(input.spread || 0);
        const gy = (1 - Math.cos(theta)) * 10 + driftY + (input.hang || 0) + (input.frozen ? 0 : (input.brace || 0) * 0.55);
        const ox = s.tx - gx;
        const oy = s.ty - gy;
        const stretch = Math.hypot(ox, oy);
        const relax = input.relax || 0;
        const k = 40 * kMul * soften * (1 - relax * 0.25) * (1 + Math.pow(stretch / 3.2, 2) * 0.9);
        const c = 2.6 * cMul * soften * (1 - relax * 0.15);
        // Weight: softer below rest than above, so a jolt drops further than it rises and the mass
        // settles back from below instead of bouncing evenly.
        const ky = k * 1.08 * (oy > 0 ? 1 - asym : 1 + asym * 0.6);
        const cy = c * (oy > 0 && s.tvy > 0 ? 1 - asym * 0.35 : 1);
        // Small swings keep this near 1. A wide swing (hard slap, pull release) damps harder.
        const ampN = Math.min(1.6, stretch / 4.2);
        const ampDamp = 1 + ampN * 1.45;
        // Figure-eight: vx drives y and vy drives x, a quarter-turn apart. The pair is
        // skew-symmetric, so it does not add energy. A bounded bow doubles the vertical
        // frequency so a big swing traces a loop instead of a straight line.
        const vx0 = s.tvx;
        const vy0 = s.tvy;
        const cross = input.frozen ? 0 : 4.6;
        const bow = input.frozen ? 0 : clampNum(2.05 * s.tx * vx0, -34, 34);
        s.tvx += (-k * ox - c * ampDamp * vx0 - s.ax * 4.6 - s.bvx * 1.4 + cross * vy0) * h;
        s.tvy += (-ky * oy - cy * ampDamp * vy0 - s.ay * 4.6 - s.bvy * 1.4 - cross * vx0 + bow) * h;
        s.tx += s.tvx * h;
        s.ty = clampNum(s.ty + s.tvy * h, -6, 7.5);
        bounceAxis(s, "tx", "tvx", swingCap, .5);
        // Impact ripple: ~18 Hz wave fading over ~0.3 s.
        if (s.rip > 0.01) {
          s.ripT += h;
          ripples[name] = s.rip * Math.exp(-s.ripT * 11) * Math.sin(s.ripT * Math.PI * 2 * 18);
          if (s.ripT > 0.45) s.rip = 0;
        } else {
          ripples[name] = 0;
        }
      }
      // Momentum exchange at the cleavage: when they press together, the faster side hands part of its
      // sideways motion to the other (like two balls touching) instead of both just stopping.
      const contact = input.contact || 0;
      if (contact > 0.15) {
        const closingSpeed = soft.left.tvx - soft.right.tvx;
        if (closingSpeed > 0) {
          const dv = closingSpeed * 0.42 * contact;
          soft.left.tvx -= dv;
          soft.right.tvx += dv;
        }
      }
    }
    const out = {};
    const boostNow = st.slapBoost || 0;
    for (const name of ["left", "right"]) {
      const s = soft[name];
      const ripple = ripples[name];
      const brace = input.frozen ? 0 : (input.brace || 0);
      const inward = brace < 0 ? -brace : 0;
      const sy = clampNum(1 + s.ty * 0.016 + ripple * 0.03 + brace * 0.012, 0.9, 1.12);
      out[name] = {
        // Whole-image drift stays tiny (the caller pins the top seam); the tip shows as bend/stretch.
        x: s.bx * 0.4 + s.tx * 0.12,
        y: s.by * 0.35 + s.ty * 0.1,
        bend: clampNum(s.tx * 2 + ripple * 1.2 + (name === "left" ? 1 : -1) * inward * 1.25, -(9 + boostNow * 7), 9 + boostNow * 7),
        // A sideways swing turns the mass a little around the top of the breast, not just slides it.
        twist: clampNum(s.tx * 0.75 + s.tvx * 0.006, -6, 6),
        sy: sy,
        sx: 1 / Math.sqrt(sy),
        rollX: clampNum(-s.tx * 1.7 + ripple * 1.6, -14, 14),
        rollY: clampNum(-s.ty * 1.3, -12, 12),
        warp: clampNum(Math.abs(s.tvx) * 0.012 + Math.abs(s.tvy) * 0.014 + Math.abs(ripple) * 3, 0, 6),
      };
    }
    return out;
  }

  function ensureBustWarpFilters(doc) {
    if (S.bustWarp) return S.bustWarp;
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    const maps = {};
    for (const side of ["left", "right"]) {
      const filter = doc.createElementNS(ns, "filter");
      filter.id = "hq-bust-warp-" + side;
      filter.setAttribute("x", "-5%");
      filter.setAttribute("y", "-5%");
      filter.setAttribute("width", "110%");
      filter.setAttribute("height", "110%");
      filter.setAttribute("primitiveUnits", "objectBoundingBox");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const img = doc.createElementNS(ns, "feImage");
      img.setAttribute("href", RIG_NEUTRAL_BASE + "breast-" + side + "-disp.png");
      img.setAttribute("x", "0");
      img.setAttribute("y", "0");
      img.setAttribute("width", "1");
      img.setAttribute("height", "1");
      img.setAttribute("preserveAspectRatio", "none");
      img.setAttribute("result", "map");
      const disp = doc.createElementNS(ns, "feDisplacementMap");
      disp.setAttribute("in", "SourceGraphic");
      disp.setAttribute("in2", "map");
      disp.setAttribute("xChannelSelector", "R");
      disp.setAttribute("yChannelSelector", "G");
      disp.setAttribute("scale", "0");
      filter.append(img, disp);
      svg.appendChild(filter);
      maps[side] = { node: disp, last: 0 };
    }
    doc.body.appendChild(svg);
    S.bustWarp = maps;
    return maps;
  }

  function syncBustWarp(side, amount) {
    if (!S.bustWarpOn || !S.bustWarp) return;
    const m = S.bustWarp[side];
    const scale = Math.round(amount * 0.0045 * 10000) / 10000;
    if (Math.abs(scale - m.last) < 0.0006) return;
    m.last = scale;
    m.node.setAttribute("scale", String(scale));
  }

  function setBustWarp(win, on) {
    S.bustWarpOn = !!on && !calm(win);
    if (S.bustWarpOn) ensureBustWarpFilters(win.document);
    if (S.el) S.el.classList.toggle("is-bust-warp", S.bustWarpOn);
  }

  // Optional normal-map lighting (Outils > Réglages > Lumière 3D, desktop only). The normal maps are
  // baked offline into four darkness layers per breast (light from the left, right, above, below:
  // breast-*-light-{l,r,u,d}.png). The light rests at a key light up-left and swings toward the
  // cursor; only the four layer opacities change, so it costs compositing, never a repaint.
  function syncBustNormalLight(dx, dy, strength) {
    if (!S.bustNormalOn || !S.bustNl || !S.bustNl.length) return;
    const len = Math.hypot(dx, dy) || 1;
    const s = clampNum(Number(strength) || 0, 0, 1);
    const lx = -0.4 + ((dx / len) * 0.7 + 0.4) * s;
    const ly = 0.5 + ((-dy / len) * 0.7 - 0.5) * s;
    const q = (v) => (Math.round(clampNum(v / 0.7, 0, 1) * 20) / 20).toFixed(2);
    const w = { l: q(-lx), r: q(lx), u: q(ly), d: q(-ly) };
    const key = w.l + w.r + w.u + w.d;
    if (key === S.bustNlKey) return;
    S.bustNlKey = key;
    S.bustNl.forEach((el) => {
      for (const k of ["l", "r", "u", "d"]) el.style.setProperty("--nl-" + k, w[k]);
    });
  }

  function setBustNormalLight(win, on) {
    const coarse = !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
    S.bustNormalOn = !!on && !calm(win) && !coarse;
    if (S.el) S.el.classList.toggle("is-bust-nlight", S.bustNormalOn);
    S.bustNlKey = "";
    syncBustNormalLight(0, 0, 0);
  }

  function kickBustSideSlosh(side, ix, iy) {
    ensureBustSideSlosh(side);
    side.sloshVx = clampNum(side.sloshVx + (Number(ix) || 0) * 0.47, -248, 248);
    side.sloshVy = clampNum(side.sloshVy + (Number(iy) || 0) * 0.53, -278, 278);
  }

  /** Layered lobes: share bulk motion at the cleavage while keeping outer slosh. */
  function tickBustCleavagePin(left, right, dt, active) {
    if (!active) return;
    ensureBustSideSlosh(left);
    ensureBustSideSlosh(right);
    const safeDt = clampNum(dt, 0.004, 0.05);
    const sync = Math.min(1, safeDt * 14);
    const avgVx = (left.vx + right.vx) * 0.5;
    const avgVy = (left.vy + right.vy) * 0.5;
    left.vx += (avgVx - left.vx) * sync * 0.14;
    right.vx += (avgVx - right.vx) * sync * 0.14;
    left.vy += (avgVy - left.vy) * sync * 0.16;
    right.vy += (avgVy - right.vy) * sync * 0.16;
    const midX = (left.x + right.x) * 0.5;
    const midY = (left.y + right.y) * 0.5;
    const spreadX = (right.x - left.x) * 0.5;
    const spreadY = (right.y - left.y) * 0.5;
    const spreadKeep = 0.58;
    left.x = midX - spreadX * spreadKeep;
    right.x = midX + spreadX * spreadKeep;
    left.y = midY - spreadY * spreadKeep;
    right.y = midY + spreadY * spreadKeep;
    const sloshPin = 0.34;
    const midSloshX = ((left.sloshX || 0) + (right.sloshX || 0)) * 0.5;
    const midSloshY = ((left.sloshY || 0) + (right.sloshY || 0)) * 0.5;
    left.sloshX = (left.sloshX || 0) * (1 - sloshPin) + midSloshX * sloshPin;
    right.sloshX = (right.sloshX || 0) * (1 - sloshPin) + midSloshX * sloshPin;
    left.sloshY = (left.sloshY || 0) * (1 - sloshPin) + midSloshY * sloshPin;
    right.sloshY = (right.sloshY || 0) * (1 - sloshPin) + midSloshY * sloshPin;
  }

  function pinCleavageDisp(lx, ly, rx, ry, spreadKeep) {
    const symX = (lx + rx) * 0.5;
    const antiX = (lx - rx) * 0.5;
    const symY = (ly + ry) * 0.5;
    const antiY = (ly - ry) * 0.5;
    const k = clampNum(Number(spreadKeep) || 1, 0.04, 1);
    return {
      leftX: symX + antiX * k,
      rightX: symX - antiX * k,
      leftY: symY + antiY * k,
      rightY: symY - antiY * k
    };
  }

  /** Pinned cleavage seam: lobes move together; extra separation becomes stretch, not a gap. */
  function applyLayeredCleavageSeam(lx, ly, rx, ry, opts) {
    const baseKeep = opts && opts.baseKeep != null ? opts.baseKeep : 0.32;
    const baseKeepY = opts && opts.baseKeepY != null ? opts.baseKeepY : 0.38;
    const maxSep = opts && opts.maxSep != null ? opts.maxSep : 4.5;
    const spreadX = Math.abs(lx - rx);
    const over = Math.max(0, spreadX - maxSep);
    const spreadKeep = clampNum(baseKeep - over * 0.02, 0.14, baseKeep);
    const pinned = pinCleavageDisp(lx, ly, rx, ry, spreadKeep);
    const pinnedY = pinCleavageDisp(lx, ly, rx, ry, baseKeepY);
    const inward = spreadX * 0.028 + over * 0.14;
    const stretchX = clampNum(1 + spreadX * 0.014 + over * 0.034, 1, 1.12);
    const stretchY = clampNum(1 - spreadX * 0.003 - over * 0.012, 0.92, 1.05);
    return {
      leftX: pinned.leftX + inward * 0.22,
      rightX: pinned.rightX - inward * 0.22,
      leftY: pinnedY.leftY,
      rightY: pinnedY.rightY,
      seamStretchX: stretchX,
      seamStretchY: stretchY,
      seamTension: clampNum(spreadX / 12 + over * 0.06, 0, 1)
    };
  }

  function syncLayeredCleavageSeamVars(stEl, st, dt, layered, lx, ly, rx, ry, opts) {
    if (!st.cleavageSeam) st.cleavageSeam = { sx: 1, sy: 1, tension: 0 };
    if (!layered) {
      st.cleavageSeam.sx = 1;
      st.cleavageSeam.sy = 1;
      st.cleavageSeam.tension = 0;
      clearLive2dStyleVar(stEl, "--rig-bust-seam-stretch-x");
      clearLive2dStyleVar(stEl, "--rig-bust-seam-stretch-y");
      clearLive2dStyleVar(stEl, "--rig-bust-seam-tension");
      return { leftX: lx, rightX: rx, leftY: ly, rightY: ry };
    }
    const seam = applyLayeredCleavageSeam(lx, ly, rx, ry, opts);
    const smooth = clampNum(dt * 18, 0.08, 1);
    st.cleavageSeam.sx += (seam.seamStretchX - st.cleavageSeam.sx) * smooth;
    st.cleavageSeam.sy += (seam.seamStretchY - st.cleavageSeam.sy) * smooth;
    st.cleavageSeam.tension += (seam.seamTension - st.cleavageSeam.tension) * smooth;
    setLive2dStyleVar(stEl, "--rig-bust-seam-stretch-x", st.cleavageSeam.sx.toFixed(4));
    setLive2dStyleVar(stEl, "--rig-bust-seam-stretch-y", st.cleavageSeam.sy.toFixed(4));
    // Tension is physics state only: no CSS reads it. Publishing it on the
    // root would invalidate the entire companion on every change.
    return seam;
  }

  function setSupportCursor(element, cursor = "n-resize") {
    const old = S.supportCursorOverride;
    if (old && old.element !== element) {
      if (old.value) old.element.style.setProperty("cursor", old.value, old.priority);
      else old.element.style.removeProperty("cursor");
      S.supportCursorOverride = null;
    }
    if (!element || !element.style) return;
    if (!S.supportCursorOverride) S.supportCursorOverride = { element,
      value: element.style.getPropertyValue("cursor"), priority: element.style.getPropertyPriority("cursor") };
    // The actual hit element can be outside the avatar due to visible crop
    // overflow. Inline priority beats its unrelated button/hover cursor rules.
    element.style.setProperty("cursor", cursor, "important");
  }

  function cursorSupportContact(current, x, y, dy, dtMs) {
    const retained = current && (current.side === "left" ? x >= .055 && x <= .505 : x >= .495 && x <= .945);
    const side = retained ? current.side : x >= .08 && x <= .48 ? "left" : x >= .52 && x <= .92 ? "right" : null;
    const held = current && current.side === side;
    if (!side || !(dtMs > 0) || (!held && dtMs > 250) || Math.abs(dy) > .10 || Math.abs(dy) / (dtMs / 1000) > (held ? 4 : 1.8) || y < (held ? .60 : .64) || y > (held ? 1.09 : 1.06)) return null;
    if (!held && (dy >= 0 || y < .65)) return null;
    const travel = clampNum((held ? current.travel || 0 : 0) - dy, 0, .095);
    if (held && Math.abs(x - (current.startU || current.u)) > .10) return null;
    // A small initial contact makes pickup perceptible; subsequent upward
    // travel adds lift. No mouse button or pixel-perfect bottom-rim start.
    const lift = clampNum((held ? current.lift : .003) - dy, 0, .055);
    return lift > .0001 ? { side, lift, travel, startU: held ? current.startU || current.u : x,
      u: held && current.lift >= .055 && dy < 0 ? current.u : x,
      v: held && current.lift >= .055 && dy < 0 ? current.v : y } : null;
  }

  function supportMapPixel(u, v) {
    const edge = Math.sin(Math.PI * u) ** 2;
    const horizontal = .32 * Math.sin(2 * Math.PI * u) * edge * Math.exp(-(((v - .55) / .36) ** 2));
    const center = Math.exp(-(((u - .5) / .24) ** 2));
    const sides = Math.exp(-(((u - .22) / .18) ** 2)) + Math.exp(-(((u - .78) / .18) ** 2));
    const vertical = (.26 * center - .23 * sides) * edge * Math.exp(-(((v - .52) / .33) ** 2)) * Math.sin(Math.PI * v) ** 2;
    return [Math.round((.5 + horizontal) * 255), Math.round((.5 + vertical) * 255), 128, 255];
  }

  function ensureSupportDisplacement(st) {
    if (st.supportFilters) return;
    const ns = "http://www.w3.org/2000/svg";
    const svg = S.win.document.createElementNS(ns, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;pointer-events:none";
    // Neutral map everywhere except a soft contact patch. Red displaces left
    // and right in opposite directions; green lifts the area at the cursor.
    const map = S.win.document.createElement("canvas");
    map.width = map.height = 64;
    const ctx = map.getContext("2d");
    if (!ctx) { st.supportFilters = {}; return; }
    const pixels = ctx.createImageData(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      pixels.data.set(supportMapPixel(x / 63, y / 63), (y * 64 + x) * 4);
    }
    ctx.putImageData(pixels, 0, 0);
    const uri = map.toDataURL();
    st.supportFilters = {};
    for (const side of ["left", "right"]) {
      const layer = S.el.querySelector(".hq-companion-rig-bust-stack-" + side);
      if (!layer) continue;
      const id = "hq-cursor-contact-" + side;
      const filter = S.win.document.createElementNS(ns, "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("x", "-.15"); filter.setAttribute("y", "-.15");
      filter.setAttribute("width", "1.3"); filter.setAttribute("height", "1.3");
      filter.setAttribute("primitiveUnits", "objectBoundingBox");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      filter["inner" + "HTML"] = `<feFlood flood-color="#808080" result="neutral"/>
        <feImage href="${uri}" width=".56" height=".38" preserveAspectRatio="none" result="patch"/>
        <feMerge result="map"><feMergeNode in="neutral"/><feMergeNode in="patch"/></feMerge>
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G"/>`;
      svg.appendChild(filter);
      st.supportFilters[side] = { layer, id, patch: filter.querySelector("feImage"),
        displacement: filter.querySelector("feDisplacementMap"), u: side === "left" ? .29 : .65, v: .86, lastScale: -1 };
    }
    S.avatar.appendChild(svg);
  }

  function cursorSupportSpring(state, target, dt) {
    const h = clampNum(dt, 0, .032);
    const unloading = target < state.p;
    const v = clampNum(state.v + ((unloading ? 90 : 140) * (clampNum(target, 0, 1) - state.p) - (unloading ? 18 : 19) * state.v) * h, -12, 12);
    return { p: clampNum(state.p + v * h, 0, 1.03), v };
  }

  function updateCursorSupport(st, dt) {
    if (!st.cursorSupport) st.cursorSupport = { left: { p: 0, v: 0 }, right: { p: 0, v: 0 } };
    const allowed = S.nsfwOn && !calm(S.win) && !(S.bustPull && S.bustPull.active) && S.el.classList.contains("has-layered-portrait");
    if (!allowed) { S.cursorSupport = null; setSupportCursor(null); }
    if (S.avatar) S.avatar.classList.toggle("is-cursor-supporting", !!(allowed && S.cursorSupport));
    for (const side of ["left", "right"]) {
      const target = allowed && S.cursorSupport && S.cursorSupport.side === side ? S.cursorSupport.lift / .055 : 0;
      const next = cursorSupportSpring(st.cursorSupport[side], target, dt);
      st.cursorSupport[side] = next;
      const load = clampNum(next.p, 0, 1);
      const eased = load * load * (3 - 2 * load);
      setLive2dStyleVar(S.el.style, "--cursor-support-" + side, (allowed ? eased : 0).toFixed(4));
      if (target > 0) ensureSupportDisplacement(st);
      const filter = st.supportFilters && st.supportFilters[side];
      if (filter) {
        const amount = allowed ? eased : 0;
        if (target > 0) {
          const follow = 1 - Math.exp(-dt * 18);
          filter.u += ((S.cursorSupport.mapU || S.cursorSupport.u || filter.u) - filter.u) * follow;
          filter.v += ((S.cursorSupport.mapV || S.cursorSupport.v || filter.v) - filter.v) * follow;
        }
        const scale = amount > .005 ? Number((Math.min(amount, 1) * .20).toFixed(3)) : 0;
        if (scale !== filter.lastScale) {
          filter.displacement.setAttribute("scale", String(scale));
          filter.layer.style.filter = scale ? "url(#" + filter.id + ")" : "";
          filter.lastScale = scale;
        }
        if (scale) {
          filter.patch.setAttribute("x", (filter.u - .28).toFixed(4));
          filter.patch.setAttribute("y", Math.max(.62, filter.v - .19).toFixed(4));
        }
      }
    }
  }

  function grabWeights(x = .5) {
    const bias = (0.5 - clampNum(x, 0, 1)) * .8;
    return { left: 1 + bias, right: 1 - bias };
  }

  function releaseFeel(speed = 0) {
    return { bounce: .18 + .82 * Math.tanh(Math.max(0, speed) / 95) };
  }

  function pullHaptic(win, pattern) {
    try {
      if (win.localStorage.getItem(LS_TOUCH_HAPTICS) === "1") companionHapticPulse(win, pattern);
    } catch (_) {}
  }

  // Warm-up / cool-down: 0 when a touch begins (a little firmer), rising to 1 over ~1 s of contact;
  // after release it eases back to 0 over ~4 s, so she stays softer for a moment afterwards.
  function touchRelax(now) {
    if (S.bustPull && S.bustPull.active) {
      if (!S.relaxT0) S.relaxT0 = now;
      S.relaxLast = clampNum((now - S.relaxT0) / 1000, 0, 1);
      S.relaxEnd = 0;
      return S.relaxLast;
    }
    if (S.relaxT0) {
      S.relaxT0 = 0;
      S.relaxEnd = now;
    }
    if (!S.relaxEnd) return 0;
    return (S.relaxLast || 0) * clampNum(1 - (now - S.relaxEnd) / 4000, 0, 1);
  }

  // Vibration that follows the bounce: strong, then weaker, then weaker (phones that support it,
  // only when "Vibrations" is on). strength 0..1.
  function bounceHaptic(win, strength) {
    const s = clampNum(Number(strength) || 0, 0, 1);
    if (s < 0.15) return;
    const a = Math.round(10 + s * 22);
    pullHaptic(win, [a, 70, Math.round(a * 0.55), 80, Math.round(a * 0.3)]);
  }

  // Soft, low "bounce" under the motion: a short pitched-down thump plus a little body noise, very
  // quiet, scaled by speed; respects the Son setting, mute and reduced motion. delayMs schedules it.
  function playBustBounceSfx(win, strength, delayMs) {
    if (!win || muted(win) || !readForgeSound(win) || calm(win)) return;
    const s = clampNum(Number(strength) || 0, 0, 1);
    if (s < 0.12) return;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime + Math.max(0, Number(delayMs) || 0) / 1000;
      const vol = 0.025 + s * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(95 + s * 30, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.11);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
      const len = Math.floor(ctx.sampleRate * 0.06);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 520;
      const ng = ctx.createGain();
      ng.gain.value = vol * 0.35;
      noise.connect(lp).connect(ng).connect(ctx.destination);
      noise.start(t);
    } catch (_) {}
  }

  function bustPullResponse(dx, dy, size, reach = 0.16) {
    const x = clampNum(dx, -10000, 10000), y = clampNum(dy, -10000, 10000);
    const dist = Math.hypot(x, y);
    const span = Math.max(1, Number(size) || 72);
    const soft = span * (reach > 0.16 ? 0.68 : 0.5);
    const distance = span * reach * Math.tanh(dist / soft);
    const gain = dist ? distance / dist : 0;
    return { x: x * gain, y: y * gain, tension: Math.tanh(dist / (span * 0.58)) };
  }

  function bustPullSpring(position, velocity, seconds) {
    // Slower, heavier underdamped mass (lower ω, moderate ζ).
    const damping = 10.15, frequency = 9.25;
    return Math.exp(-damping * seconds) * (position * Math.cos(frequency * seconds) +
      (velocity + damping * position) / frequency * Math.sin(frequency * seconds));
  }

  function bustPullSettle(position, velocity, seconds, bounce = 1) {
    const main = bustPullSpring(position, velocity, seconds);
    const phase = Math.max(0, seconds - 0.28);
    const entry = Math.min(1, phase / 0.28);
    const smoothEntry = entry * entry * (3 - 2 * entry);
    const exit = Math.max(0, Math.min(1, (2.2 - seconds) / 0.3));
    const amplitude = Math.min(2.85, Math.abs(position) * 0.155) * clampNum(bounce, 0, 1);
    return main + Math.sign(position) * amplitude * smoothEntry * exit *
      Math.exp(-0.75 * phase) * Math.sin(2 * Math.PI * 1.95 * phase);
  }

  function bustPullGravity(distance, seconds, maxSag = 3) {
    const phase = Math.max(0, seconds) / 0.62;
    const envelope = phase * phase * Math.exp(2 - 2 * phase);
    const exit = Math.max(0, Math.min(1, (2.2 - seconds) / 0.3));
    return Math.min(maxSag, Math.max(0, distance) * 0.22) * envelope * exit;
  }

  function rigSecondaryMotion(x, y) {
    return {
      shear: clampNum(x * 0.017, -0.12, 0.12),
      stretch: clampNum(1 - y * 0.0068, 0.935, 1.065)
    };
  }

  function rigHairMotion(x, y, rotation, breathWave, breezeWave = 0) {
    return { x: clampNum(x * 0.62 + breathWave * 0.35 + breezeWave * 1.6, -4.5, 4.5),
      y: clampNum(y * 0.58 + breathWave * 0.8 + breezeWave * 0.22, -2.8, 2.8),
      rotation: clampNum(rotation * 0.38 + breathWave * 0.4 + breezeWave * 0.95, -2.8, 2.8) };
  }

  function bustPullFollow(current, target, dt, reduced = false, tauSec) {
    const touch = !!(S.bustPull && S.bustPull.pointerType === "touch");
    const tier = pullLoadTier(target.tension || 0);
    // 0.55x: the breast now covers ~2/3 of the way to your hand in ~30-40 ms instead of 55-74 ms.
    const tau = tauSec || (reduced ? 0.02 : (touch ? tier.tau * 1.06 : tier.tau) * 0.55);
    const alpha = reduced ? 1 : 1 - Math.exp(-Math.max(0.008, Math.min(dt, 0.05)) / tau);
    return { x: current.x + (target.x - current.x) * alpha,
      y: current.y + (target.y - current.y) * alpha,
      tension: current.tension + (target.tension - current.tension) * alpha };
  }

  function pullLoadTier(tension) {
    const t = Number(tension) || 0;
    if (t >= 0.72) {
      return { id: "deep", tau: 0.074, stretchCap: 1.06, scaleY: 1.048, reachMul: 0.9 };
    }
    if (t >= 0.42) {
      return { id: "medium", tau: 0.064, stretchCap: 1.035, scaleY: 1.026, reachMul: 0.95 };
    }
    if (t >= 0.12) {
      return { id: "light", tau: 0.055, stretchCap: 1.018, scaleY: 1.012, reachMul: 0.98 };
    }
    return { id: "idle", tau: 0.052, stretchCap: 1, scaleY: 1, reachMul: 1 };
  }

  function impulseBustSidesReleaseAsymmetric(win, fx, fy, mult) {
    if (!win || calm(win)) return;
    const st = ensureLive2DState();
    const m = Number(mult) || 1;
    const ix = (Number(fx) || 0) * m;
    const iy = (Number(fy) || 0) * m;
    for (const side of [st.bustSides.left, st.bustSides.right]) {
      if (side.x === undefined) {
        side.x = 0;
        side.vx = 0;
      }
    }
    const lead = ix >= 0 ? st.bustSides.right : st.bustSides.left;
    const trail = ix >= 0 ? st.bustSides.left : st.bustSides.right;
    lead.vy = clampNum(lead.vy + iy * 1.02, -105, 105);
    trail.vy = clampNum(trail.vy + iy * 0.58, -95, 95);
    lead.vx = clampNum(lead.vx + ix * 0.78, -62, 62);
    trail.vx = clampNum(trail.vx - ix * 0.34, -48, 48);
    lead.vy = clampNum(lead.vy + Math.abs(ix) * 0.09, -105, 105);
    trail.vy = clampNum(trail.vy - Math.abs(ix) * 0.11, -95, 95);
  }

  function triggerBustAfterglow(win, strength, durationMs) {
    if (!win || calm(win) || !S.nsfwOn) return;
    const ms = clampNum(Number(durationMs) || 10000, 4000, 16000);
    const s = clampNum(Number(strength) || 0.5, 0.2, 1);
    S.bustAfterglowUntil = Date.now() + ms;
    S.bustAfterglowDuration = ms;
    S.bustAfterglowStrength = Math.max(S.bustAfterglowStrength || 0, s);
    if (S.el) S.el.classList.add("is-bust-afterglow");
  }

  function tickBustAfterglow(nowMs) {
    if (!S.el || !S.bustAfterglowUntil) return 0;
    if (nowMs >= S.bustAfterglowUntil) {
      S.bustAfterglowUntil = 0;
      S.bustAfterglowStrength = 0;
      S.el.classList.remove("is-bust-afterglow");
      return 0;
    }
    const remain = S.bustAfterglowUntil - nowMs;
    const dur = Math.max(1, S.bustAfterglowDuration || 12000);
    return clampNum((S.bustAfterglowStrength || 0.5) * (remain / dur), 0, 1);
  }

  function triggerPullDeepGlance(win) {
    if (!win || lifeMotionBlocked() || S.pullDeepGlanceDone) return;
    S.pullDeepGlanceDone = true;
    const gx = S.pullGaze ? S.pullGaze.x * 1.4 : 0;
    setLive2DTarget(win, gx, 2.65);
    win.clearTimeout(S.pullGlanceT);
    S.pullGlanceT = win.setTimeout(() => {
      if (!S.el || S.el.classList.contains("is-bust-pull")) return;
      setLive2DTarget(win, gx * 0.35, 0.45);
    }, 480);
  }

  function impulseBustSidesOnly(win, fx, fy, mult) {
    if (!win || calm(win)) return;
    const st = ensureLive2DState();
    const m = Number(mult) || 1;
    const ix = (Number(fx) || 0) * m;
    const iy = (Number(fy) || 0) * m;
    for (const side of [st.bustSides.left, st.bustSides.right]) {
      if (side.x === undefined) {
        side.x = 0;
        side.vx = 0;
      }
    }
    st.bustSides.left.vy = clampNum(st.bustSides.left.vy + iy * 0.88, -95, 95);
    st.bustSides.right.vy = clampNum(st.bustSides.right.vy + iy * 0.74, -95, 95);
    st.bustSides.left.vx = clampNum(st.bustSides.left.vx + ix * 0.64, -55, 55);
    st.bustSides.right.vx = clampNum(st.bustSides.right.vx - ix * 0.56, -55, 55);
    kickBustSideSlosh(st.bustSides.left, ix * 1.08, iy * 1.22);
    kickBustSideSlosh(st.bustSides.right, -ix * 0.98, iy * 1.12);
  }

  function triggerBustSettleProfile(win, kind) {
    if (!win || lifeMotionBlocked()) return;
    const now = Date.now();
    if (S.settlingCooldownAt && now - S.settlingCooldownAt < 300) return;
    S.settlingCooldownAt = now;
    const profiles = {
      pull: { cx: 0.18, cy: 0.22, sx: 1.15, sy: 1.25, head: 8 },
      spank: { cx: 0.42, cy: 0.35, sx: 1.35, sy: 1.45, head: 14 },
      slingshot: { cx: 0.28, cy: 0.32, sx: 1.2, sy: 1.3, head: 9 },
      generic: { cx: 0.22, cy: 0.18, sx: 1, sy: 1.1, head: 7 }
    };
    const p = profiles[kind] || profiles.generic;
    const st = ensureLive2DState();
    const sign = Math.random() > 0.5 ? 1 : -1;
    st.bust.vx = clampNum(st.bust.vx + sign * 16 * p.cx, -195, 195);
    st.bust.vy = clampNum(st.bust.vy + 12 * p.cy, -225, 225);
    impulseBustSidesOnly(win, sign * 22 * p.sx, 32 * p.sy, 1);
    st.head.vnod = clampNum(st.head.vnod + sign * p.head, -36, 36);
  }

  function anchoredPullFrame(frame, width, height, lever = 0.18, maxStretch = 3, maxReach = 0.52) {
    // Affine stretch: attachment line ~52% height (bra root / upper cup) so the top stays on the torso.
    const arm = Math.max(1, height * lever);
    const x = clampNum(frame.x, -width * maxReach, width * maxReach);
    const stretch = clampNum(1 + frame.y / arm, 0.72, maxStretch);
    return { x, y: (stretch - 1) * arm, tension: frame.tension,
      shear: x / arm, stretch };
  }

  function setAnchoredGrabPoint(x, y) {
    S.rigGrabX = clampNum(Number(x) || 0.5, 0, 1);
    S.rigGrabLever = clampNum(y - 0.62, 0.12, 0.28);
  }

  function renderBustPull(frame, gaze, contact = 1) {
    if (!S.el || !S.face) return;
    const { w: width, h: height } = pullFaceSpan();
    const rig = S.el.classList.contains("has-layered-portrait");
    const touch = !!((S.bustPull && S.bustPull.pointerType === "touch") || S.pullSettleTouch);
    const tier = pullLoadTier(frame.tension || 0);
    const compact = isCompactUI(S.win);
    const maxStretch = touch ?
      clampNum((rig && compact ? 1.62 : 1.45) * tier.stretchCap, 0.72, rig && compact ? 1.62 : 1.45) :
      clampNum(3 * tier.stretchCap, 0.72, 3);
    const touchReachBase = rig ? (compact ? 0.44 : 0.24) : 0.18;
    const maxReach = touch ?
      clampNum(touchReachBase * tier.reachMul, 0.14, touchReachBase) :
      clampNum((rig ? 0.74 : 0.52) * tier.reachMul, rig ? 0.24 : 0.16, rig ? 0.74 : 0.52);
    const shape = rig ?
      anchoredPullFrame(frame, width, height, S.rigGrabLever || .18, maxStretch, maxReach) : frame;
    const { x: tx, y: ty, tension } = shape;
    S.pullRenderX = tx;
    S.pullRenderShear = shape.shear || 0;
    setPullVar("--pull-shear", (shape.shear || 0).toFixed(4));
    setPullVar("--pull-stretch-y", (shape.stretch || 1).toFixed(4));
    const pullT = clampNum(tension, 0, 1);
    if (calm(S.win)) syncRigClothing(ensureLive2DState(),0,{left:{sy:1,pull:pullT},right:{sy:1,pull:pullT}},true);
    const pullReach = clampNum(Math.hypot(tx, ty) / Math.max(52, width * 0.15), 0, 1);
    const vibrMix = clampNum(pullT * 0.52 + pullReach * 0.48, 0, 1);
    const vibrAmp = vibrMix * vibrMix;
    const avatarShake = calm(S.win) ? 0 : clampNum(0.35 + vibrAmp * 3.4, 0, 4.2);
    const bubbleShake = calm(S.win) ? 0 : clampNum(pullT * 4.8 + pullT * pullT * 8.2, 0, 14);
    const bubbleShakeY = calm(S.win) ? 0 : clampNum(pullT * 1.55 + pullT * pullT * 3.1, 0, 5.8);
    const avatarAmp = calm(S.win) ? 0.24 : clampNum(0.26 + pullT * 0.34, 0.26, 0.58);
    const bubbleAmp = calm(S.win) ? 0.9 : clampNum(0.94 + pullT * 0.44, 0.94, 1.38);
    setPullVar("--bust-shake", avatarShake.toFixed(2) + "px");
    setPullVar("--bubble-shake", bubbleShake.toFixed(2) + "px");
    setPullVar("--bubble-shake-y", bubbleShakeY.toFixed(2) + "px");
    setPullVar("--bust-shake-amp", avatarAmp.toFixed(3));
    setPullVar("--bubble-shake-amp", bubbleAmp.toFixed(3));
    clearPullVar("--bust-shake-y");
    clearPullVar("--bust-shake-rot");
    const shakeDur = Math.max(0.11, 0.26 - pullT * 0.1).toFixed(3) + "s";
    setPullVar("--bust-shake-dur", shakeDur);
    const bustVibrX = calm(S.win) ? 0 : clampNum(0.12 + vibrAmp * 2.6, 0, 2.9);
    const bustVibrY = calm(S.win) ? 0 : clampNum(0.08 + vibrAmp * 1.55, 0, 1.75);
    const bustVibrRot = calm(S.win) ? 0 : clampNum(vibrAmp * 0.42, 0, 0.48);
    const bustVibrDur = Math.max(0.07, 0.19 - vibrAmp * 0.06).toFixed(3) + "s";
    setPullVar("--pull-bust-vibr-x", bustVibrX.toFixed(2) + "px");
    setPullVar("--pull-bust-vibr-y", bustVibrY.toFixed(2) + "px");
    setPullVar("--pull-bust-vibr-rot", bustVibrRot.toFixed(3) + "deg");
    setPullVar("--pull-bust-vibr-dur", bustVibrDur);
    setPullVar("--bubble-shake-dur", shakeDur);
    setPullVar("--bust-pull-x", tx.toFixed(2) + "px");
    setPullVar("--bust-pull-y", ty.toFixed(2) + "px");
    const bubbleGainX = 0.14 + tension * 0.085;
    const bubbleGainY = 0.12 + tension * 0.072;
    S.bubblePullSX += (tx * bubbleGainX - S.bubblePullSX) * 0.16;
    S.bubblePullSY += (ty * bubbleGainY - S.bubblePullSY) * 0.16;
    setPullVar("--bubble-pull-x", S.bubblePullSX.toFixed(2) + "px");
    setPullVar("--bubble-pull-y", S.bubblePullSY.toFixed(2) + "px");
    if (rig) {
      setPullVar("--pull-head-x", (shape.shear * 3.2).toFixed(2) + "px");
      setPullVar("--pull-head-y", ((shape.stretch - 1) * -2.5).toFixed(2) + "px");
      setPullVar("--pull-head-rot", (shape.shear * 2.1).toFixed(2) + "deg");
      const pullArm = Math.max(1, height * (S.rigGrabLever || 0.18));
      // Contact-aware asymmetric lead/lag per breast unit
      const grabX = typeof S.rigGrabX === "number" ? S.rigGrabX : 0.5;
      const grab = grabWeights(grabX);
      const leftLead = grab.left;
      const rightLead = grab.right;
      const press = calm(S.win) ? 0 : .024 * contact * (1 - pullT);
      setPullVar("--pull-press-left", (press * leftLead).toFixed(4));
      setPullVar("--pull-press-right", (press * rightLead).toFixed(4));
      // Keep the cropped layers overlapping their attachment to the torso.
      const pullLobeY = height * 0.045 * Math.tanh((shape.stretch - 1) * pullArm * 0.52 / Math.max(1, height * 0.045));
      const pullLobeLY = pullLobeY * leftLead;
      const pullLobeRY = pullLobeY * rightLead;
      const pullBulkLX = width * 0.055 * Math.tanh(tx * (touch ? 0.42 : 0.58) * leftLead / Math.max(1, width * 0.055));
      const pullBulkRX = width * 0.055 * Math.tanh(tx * (touch ? 0.42 : 0.58) * rightLead / Math.max(1, width * 0.055));
      const pullBulkX = (pullBulkLX + pullBulkRX) * 0.5;
      S.layeredPullBase = { bulkX: pullBulkX, bulkY: pullLobeY, bulkLX: pullBulkLX, bulkRX: pullBulkRX, bulkLY: pullLobeLY, bulkRY: pullLobeRY };
      setPullVar("--pull-lobe-y", pullLobeY.toFixed(2) + "px");
      setPullVar("--pull-lobe-left-y", pullLobeLY.toFixed(2) + "px");
      setPullVar("--pull-lobe-right-y", pullLobeRY.toFixed(2) + "px");
      setPullVar("--pull-lobe-left-x", pullBulkLX.toFixed(2) + "px");
      setPullVar("--pull-lobe-right-x", pullBulkRX.toFixed(2) + "px");
      const leftSY = clampNum((shape.stretch || 1) * (0.86 + leftLead * 0.14), 0.88, 1.22);
      const rightSY = clampNum((shape.stretch || 1) * (0.86 + rightLead * 0.14), 0.88, 1.22);
      setPullVar("--pull-lobe-left-sy", leftSY.toFixed(4));
      setPullVar("--pull-lobe-right-sy", rightSY.toFixed(4));
      setPullVar("--pull-underboob-x", (pullBulkX * 0.65).toFixed(2) + "px");
      setPullVar("--pull-underboob-y", (pullLobeY * 0.6).toFixed(2) + "px");
      setPullVar("--pull-underboob-opacity", clampNum(1 - pullT * 0.42, 0.35, 1).toFixed(3));
      const cutSx = clampNum(
        1 + Math.abs(shape.shear || 0) * 0.38 + Math.max(0, (shape.stretch || 1) - 1) * 0.62 + pullT * 0.14,
        1.08, 1.72);
      const cutSy = clampNum((shape.stretch || 1) * (1 + pullT * 0.08), 1.1, 1.95);
      const cutX = clampNum((shape.shear || 0) * 16 + tx * 0.055, -26, 26);
      const cutY = clampNum(pullLobeY * 0.28 + Math.max(0, (shape.stretch || 1) - 1) * 20 + ty * 0.07, -14, 52);
      setPullVar("--rig-breast-cut-sx", cutSx.toFixed(3));
      setPullVar("--rig-breast-cut-sy", cutSy.toFixed(3));
      setPullVar("--rig-breast-cut-x", cutX.toFixed(2) + "px");
      setPullVar("--rig-breast-cut-y", cutY.toFixed(2) + "px");
      const faceContact = clampNum(contact, 0, 1);
      const blushFace = pullContactBlushShape(pullT);
      const exprGate = clampNum(blushFace * 1.08 + faceContact * 0.26 + pullT * 0.12, 0, 1);
      const mouthOpen = clampNum(Math.pow(blushFace, 0.72) * 1.05 + faceContact * blushFace * 0.32, 0, 1);
      const pullMouthOpen = mouthOpen;
      setPullVar("--rig-pull-mouth-open", mouthOpen.toFixed(3));
      setPullVar("--rig-pull-mouth-overlay", exprGate.toFixed(3));
      setPullVar("--rig-pull-mouth-lip-sx", (0.96 + mouthOpen * 0.1).toFixed(3));
      setPullVar("--rig-pull-mouth-lip-sy", (0.48 + mouthOpen * 0.58).toFixed(3));
      const mouthStyle = mouthVarStyle();
      mouthStyle.setProperty("--rig-mouth-sy", (1 + mouthOpen * 0.22).toFixed(4));
      mouthStyle.setProperty("--rig-mouth-sx", (1 + mouthOpen * 0.08).toFixed(4));
      mouthStyle.setProperty("--rig-mouth-y", (mouthOpen * 5 + pullT * 0.6).toFixed(2) + "px");
      setPullVar(
        "--rig-pull-eye-close",
        clampNum(0.04 + blushFace * (0.82 + exprGate * 0.18), 0.04, 1).toFixed(3));
      setPullVar(
        "--rig-pull-eye-opacity",
        clampNum(exprGate * (0.78 + blushFace * 0.22), 0, 0.98).toFixed(3));
      const shearMag = Math.abs(shape.shear || 0);
      setPullVar("--pull-lobe-sy", clampNum(shape.stretch || 1, 0.88, 1.18).toFixed(4));
      setPullVar("--pull-lobe-sx", clampNum(1 + shearMag * 0.16 + Math.abs(tx) / Math.max(width, 1) * 0.035, 0.94, 1.16).toFixed(4));
      if (!calm(S.win)) {
        const st = ensureLive2DState();
        const prevShear = S.pullSloshKickShear || 0;
        const prevStretch = S.pullSloshKickStretch || 1;
        const dShear = (shape.shear || 0) - prevShear;
        const dStretch = (shape.stretch || 1) - prevStretch;
        if (Math.abs(dShear) + Math.abs(dStretch) > 0.0015) {
          const hx = tx * 0.035 + dShear * 12;
          kickBustSideSlosh(st.bustSides.left, hx, dStretch * 72 + ty * 0.028);
          kickBustSideSlosh(st.bustSides.right, hx, dStretch * 68 + ty * 0.025);
        }
        S.pullSloshKickShear = shape.shear || 0;
        S.pullSloshKickStretch = shape.stretch || 1;
      }
    }
    if (S.bustPullDisplacement && !rig) {
      const vertMag = Math.abs(ty) / Math.max(1, height * 0.1);
      const horizMag = Math.abs(tx) / Math.max(1, width * 0.12);
      S.bustPullDisplacement.setAttribute(
        "scale",
        clampNum(0.9 + tension * 0.5 + vertMag * 0.45 + horizMag * 0.16, 0.88, 2.65).toFixed(2)
      );
    }
    setPullVar("--pull-tension", tension.toFixed(3));
    S.pullContactValue = contact * (0.26 + tension * 0.22);
    setPullVar("--pull-contact", S.pullContactValue.toFixed(3));
    S.el.classList.toggle("pull-tier-light", tension >= 0.12 && tension < 0.42);
    S.el.classList.toggle("pull-tier-medium", tension >= 0.42 && tension < 0.72);
    S.el.classList.toggle("pull-tier-deep", tension >= 0.72);
    if (tension >= 0.72 && S.pullHapticTier < 2) {
      S.pullHapticTier = 2;
      pullHaptic(S.win, 8);
    } else if (tension >= 0.42 && S.pullHapticTier < 1) {
      S.pullHapticTier = 1;
      pullHaptic(S.win, 5);
    }
    const shearAbs = Math.abs(shape.shear || 0);
    if (
      touch &&
      shearAbs > 0.075 &&
      tension > 0.48 &&
      (!S.pullShearHapticAt || Date.now() - S.pullShearHapticAt > 900)
    ) {
      S.pullShearHapticAt = Date.now();
      try {
        if (S.win.navigator && typeof S.win.navigator.vibrate === "function") {
          pullHaptic(S.win, 5);
        }
      } catch (_) {}
    }
    if (S.bustPullMap) S.bustPullMap.setAttribute("values", [
      0, 0, 0, -tx / width, 0.5,
      0, 0, 0, -ty / height, 0.5,
      0, 0, 0, 0, 0.5,
      0, 0, 0, 0, 1
    ].join(" "));
    // The eye mask is calibrated to the neutral stock portrait only. Never
    // apply fixed facial landmarks to arbitrary Forge poses.
    const neutral = /\/(?:transferania-adult-neutral\.jpg|rig-neutral-v1\/source\.jpg)(?:[?#]|$)/.test(S.adultPortrait.getAttribute("src") || "");
    S.el.classList.toggle("has-pull-landmarks", neutral);
    if (S.bustPullGazeMap) S.bustPullGazeMap.setAttribute("values", [
      0, 0, 0, neutral && gaze ? -gaze.x * 0.006 : 0, 0.5,
      0, 0, 0, neutral && gaze ? -gaze.y * 0.004 : 0, 0.5,
      0, 0, 0, 0, 0.5,
      0, 0, 0, 0, 1
    ].join(" "));
    if (S.rigGazeMap && S.bustPullGazeMap && !rig) {
      S.rigGazeMap.setAttribute("values", S.bustPullGazeMap.getAttribute("values"));
    }
    S.el.classList.add("is-bust-pull");
    tickPullExpressiveReactions(S.win, tension, shape);
    tickBustPullImpactSfx(S.win, pullT, Math.hypot(tx, ty), shape);
    updateTitPullElasticLoopGain(pullT);
    markPullFxRendered(S.win);
    syncContactBlush(S.win);
    S.mouthRig?.syncInteraction();
    updateBustCastProjection(S.win, ensureLive2DState(), isCompactUI(S.win));
  }

  function setBustPull(dx, dy) {
    if (!S.el || !S.win || !S.face) return;
    const layered = S.el.classList.contains("has-layered-portrait");
    const touch = !!(S.bustPull && S.bustPull.pointerType === "touch");
    const relax = touchRelax(S.win.performance.now());
    const reach = (touch ? 0.24 : 0.74) * (0.82 + relax * 0.18);
    S.pullTarget = bustPullResponse(dx, dy, pullFaceSpan().w, reach);
    updateBustPullFrame(S.win.performance.now());
    if (S.bustPull && S.bustPull.active) {
      bustPullCry(S.win, Math.hypot(dx, dy), S.pullTarget.tension);
      maybePullPleasureGrunt(S.win, Math.hypot(dx, dy), S.pullTarget.tension);
    }
  }

  function updateBustPullFrame(now) {
    if (!S.bustPull || !S.bustPull.active || !S.pullTarget) return;
    const prev = S.pullMotion;
    const dt = prev ? Math.max(0.008, (now - prev.time) / 1000) : 0.016;
    const vel = prev ? Math.hypot(prev.vx || 0, prev.vy || 0) : 0;
    const resist = 1 - Math.tanh(vel / 125) * 0.14;
    const resistedTarget = {
      x: S.pullTarget.x * resist,
      y: S.pullTarget.y * resist,
      tension: S.pullTarget.tension
    };
    const frame = bustPullFollow(prev || { x: 0, y: 0, tension: 0 }, resistedTarget, dt, calm(S.win));
    const fresh = prev && dt < 0.12;
    S.pullMotion = { ...frame, time: now,
      vx: fresh ? prev.vx * 0.42 + clampNum((frame.x - prev.x) / dt, -140, 140) * 0.58 : 0,
      vy: fresh ? prev.vy * 0.42 + clampNum((frame.y - prev.y) / dt, -140, 140) * 0.58 : 0 };
    renderBustPull(frame, S.pullGaze);
    if (S.pullFollowRaf) S.win.cancelAnimationFrame(S.pullFollowRaf);
    S.pullFollowRaf = 0;
    if (Math.hypot(frame.x - S.pullTarget.x, frame.y - S.pullTarget.y) > 0.08 || Math.abs(frame.tension - S.pullTarget.tension) > 0.004) {
      S.pullFollowRaf = S.win.requestAnimationFrame(updateBustPullFrame);
    }
  }

  function bustPullCry(win, dist, tension) {
    if (!win || dist < 18 || muted(win) || !readForgeSound(win) || calm(win)) return;
    if (S.reactionAudio?.has("whimper")) {
      if (!S.pullVoice) {
        S.pullVoice = { recorded: true, stopped: false };
        playRecordedReaction(win, "whimper");
      }
      return;
    }
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      if (!S.pullVoice) {
        const reactionTone = beginCompanionReactionBus(ctx, now);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setValueAtTime(0, now);
        connectCompanionReactionOut(gain, reactionTone, ctx);
        // One bounded voice per gesture; no stacking on pointermove.
        const variation = 0.98 + Math.random() * 0.04;
        const oscillators = [1, 2.05].map((partial, index) => {
          const osc = ctx.createOscillator();
          osc.type = index ? "triangle" : "sine";
          osc.frequency.setValueAtTime((240 + tension * 160) * variation * partial, now);
          osc.connect(gain);
          osc.start(now);
          osc.stop(now + 1.9);
          return osc;
        });
        oscillators[1].onended = () => {
          oscillators.forEach(osc => osc.disconnect());
          gain.disconnect();
          if (reactionTone) reactionTone.disconnect();
        };
        S.pullVoice = { gain, oscillators, variation, end: now + 1.6, stopped: false, tone: reactionTone };
      }
      const voice = S.pullVoice;
      if (voice.stopped || now >= voice.end - 0.18) return;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0.005 + tension * 0.012, now, 0.085);
      voice.gain.gain.setTargetAtTime(0, voice.end - 0.18, 0.055);
      voice.oscillators.forEach((osc, index) => {
        osc.frequency.setTargetAtTime((240 + tension * 160) * voice.variation * (index ? 2.05 : 1), now, 0.09);
      });
    } catch (_) { /* Audio must never interrupt a captured drag. */ }
  }

  function stopBustPullVoice() {
    const voice = S.pullVoice;
    if (voice?.recorded) {
      if (!voice.stopped) S.reactionAudio?.stop("whimper");
      voice.stopped = true;
      return;
    }
    if (!voice || voice.stopped || !S.audioCtx) return;
    voice.stopped = true;
    const now = S.audioCtx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.045);
      voice.oscillators.forEach(osc => osc.stop(now + 0.24));
    } catch (_) {}
  }

  function clearBustPull() {
    if (S.pullGlobalCleanup) {
      try { S.pullGlobalCleanup(); } catch (_) {}
      S.pullGlobalCleanup = null;
    }
    if (!S.el) return;
    if (S.pullFollowRaf) S.win.cancelAnimationFrame(S.pullFollowRaf);
    S.pullFollowRaf = 0;
    S.pullTarget = null;
    S.el.classList.remove("is-bust-pull", "has-pull-landmarks", "pull-tier-light", "pull-tier-medium", "pull-tier-deep", "is-pull-release-steam");
    S.mouthRig?.syncInteraction();
    clearPullVar("--bust-shake");
    clearPullVar("--bust-shake-amp");
    clearPullVar("--bust-shake-dur");
    clearPullVar("--pull-bust-vibr-x");
    clearPullVar("--pull-bust-vibr-y");
    clearPullVar("--pull-bust-vibr-rot");
    clearPullVar("--pull-bust-vibr-dur");
    clearPullVar("--pull-blush");
    clearPullVar("--pull-steam");
    S.pullReleaseSteam = 0;
    S.pullReleaseSteamUntil = 0;
    S.pullReleaseSteamSpan = 0;
    S.pullReleaseUntil = 0;
    S.pullFaceWidth = 0;
    S.pullFaceHeight = 0;
    S.pullFxAt = 0;
    S.el.style.removeProperty("--bubble-shake");
    S.el.style.removeProperty("--bubble-shake-y");
    S.el.style.removeProperty("--bubble-shake-amp");
    S.el.style.removeProperty("--bubble-shake-dur");
    stopBustPullVoice();
    stopTitPullElasticLoop();
    S.pullMotion = null;
    S.pullGaze = null;
    resetPullInteractionFx();
    S.pullHapticTier = 0;
    S.pullSettleTouch = false;
    S.pullDeepGlanceDone = false;
    S.pullRenderX = 0;
    S.pullRenderShear = 0;
    S.pullSloshKickShear = 0;
    S.pullSloshKickStretch = 1;
    S.layeredPullBase = null;
    S.pullContactValue = 0;
    if (calm(S.win)) applyRigPostureSetting(S.win);
    const removedVars = [
      "--pull-tension", "--pull-contact", "--pull-contact-x", "--pull-contact-y", "--pull-shear", "--pull-stretch-y",
      "--pull-press-left", "--pull-press-right",
      "--pull-lobe-y", "--pull-lobe-left-y", "--pull-lobe-right-y", "--pull-lobe-left-x", "--pull-lobe-right-x", "--pull-lobe-sx", "--pull-lobe-sy", "--pull-lobe-left-sy", "--pull-lobe-right-sy",
      "--pull-underboob-x", "--pull-underboob-y", "--pull-underboob-opacity",
      "--rig-bust-seam-stretch-x", "--rig-bust-seam-stretch-y", "--rig-bust-seam-tension",
      "--rig-breast-cut-sx", "--rig-breast-cut-sy", "--rig-breast-cut-x", "--rig-breast-cut-y",
      "--rig-pull-mouth-open", "--rig-pull-eye-close", "--rig-pull-eye-opacity",
      "--rig-pull-mouth-overlay", "--rig-pull-mouth-lip-sx", "--rig-pull-mouth-lip-sy",
      "--rig-mouth-sy", "--rig-mouth-sx", "--rig-mouth-y",
      "--bust-pull-x", "--bust-pull-y",
      "--bubble-pull-x", "--bubble-pull-y",
      "--pull-head-x", "--pull-head-y", "--pull-head-rot"
    ];
    for (const name of removedVars) {
      S.el.style.removeProperty(name);
      const scope = S.l2dVarScopes && S.l2dVarScopes.get(name);
      [].concat(scope || []).forEach((el) => el && el.style && el.style.removeProperty(name));
      if (S.pullVars) delete S.pullVars[name];
    }
    const mouthStyle = mouthVarStyle();
    if (mouthStyle) ["--rig-mouth-sy", "--rig-mouth-sx", "--rig-mouth-y"].forEach((k) => mouthStyle.removeProperty(k));
    const l2d = S.l2d;
    if (l2d && l2d.styleCache) {
      for (const k of removedVars) delete l2d.styleCache[k];
      for (const k of Object.keys(l2d.styleCache)) {
        if (k.startsWith("--pull-") || k.startsWith("--rig-pull-") || k.startsWith("--bust-pull-") || k.startsWith("--bubble-pull-") || k.startsWith("--bust-shake") || k.startsWith("--bubble-shake")) {
          delete l2d.styleCache[k];
        }
      }
    }
    S.bubblePullSX = 0;
    S.bubblePullSY = 0;
    updateBustCastProjection(S.win, ensureLive2DState(), isCompactUI(S.win));
  }

  function cancelBustPullImmediately(win) {
    if (S.pullGlobalCleanup) {
      try { S.pullGlobalCleanup(); } catch (_) {}
      S.pullGlobalCleanup = null;
    }
    const pull = S.bustPull;
    S.bustPull = null;
    stopTitPullElasticLoop();
    if (S.bustPullRaf) win.cancelAnimationFrame(S.bustPullRaf);
    S.bustPullRaf = 0;
    if (pull && S.el) {
      try { S.el.querySelector(".hq-companion-avatar").releasePointerCapture(pull.id); } catch (_) {}
    }
    clearBustPull();
  }

  function releaseBustPull(win, x, y) {
    const start = win.performance.now();
    if (S.pullFollowRaf) win.cancelAnimationFrame(S.pullFollowRaf);
    S.pullFollowRaf = 0;
    S.pullTarget = null;
    S.pullSettleTouch = S.lastPullPointerType === "touch";
    const motion = S.pullMotion || { ...bustPullResponse(x, y, pullFaceSpan().w), vx: 0, vy: 0, time: start };
    const recent = start - motion.time < 90;
    const feel = releaseFeel(recent ? Math.hypot(motion.vx || 0, motion.vy || 0) : 0);
    const maxVelocity = Math.max(8, Math.hypot(motion.x, motion.y) * 4);
    const gaze = S.pullGaze || { x: 0, y: 0 };
    const reduced = calm(win);
    const dur = reduced ? 160 : 2520;
    const peakPullT = S.pullExpress && S.pullExpress.peakT ? S.pullExpress.peakT : (motion.tension || 0);
    S.pullReleaseUntil = start + 1600;
    stopBustPullVoice();
    stopTitPullElasticLoop();
    {
      const releaseSpeed = recent ? Math.hypot(motion.vx || 0, motion.vy || 0) : 0;
      const bounce = clampNum(peakPullT * 0.7 + releaseSpeed / 260, 0, 1);
      if (peakPullT >= 0.28) {
        bumpContactBlush(win, 0.1 + peakPullT * 0.24 + bounce * 0.08, 4200);
        S.pullReleaseSteam = clampNum(0.55 + peakPullT * 0.42 + bounce * 0.12, 0, 1);
        S.pullReleaseSteamSpan = 1400;
        S.pullReleaseSteamUntil = start + S.pullReleaseSteamSpan;
        syncContactBlush(win);
        S.el.classList.add("is-pull-release-steam");
      }
      playBustBounceSfx(win, bounce, 0);
      if (!muted(win) && readForgeSound(win)) {
        playTitPullImpactSfx(win, 0.26 + bounce * 0.34, { release: true });
        if (peakPullT >= 0.38) playRecordedReaction(win, "exhale");
      }
      {
        const cx = parseFloat(S.el.style.getPropertyValue("--pull-contact-x"));
        const cy = parseFloat(S.el.style.getPropertyValue("--pull-contact-y"));
        const grabSide = Number.isFinite(cx) && cx >= 46 ? "right" : "left";
        spawnBustRipple(win, grabSide, cx, cy, bounce);
        spawnBustRipple(win, grabSide === "left" ? "right" : "left", NaN, NaN, bounce * .4);
      }
      playBustBounceSfx(win, bounce * 0.5, 300);
      bounceHaptic(win, bounce);
    }
    if (!reduced && motion) {
      applyLive2DImpulse(
        win,
        clampNum(motion.vx * 0.2, -58, 58),
        clampNum(motion.vy * 0.26, -68, 68),
        clampNum(motion.vx * 0.08, -24, 24)
      );
      impulseBustSidesOnly(
        win,
        clampNum(motion.vx * 0.62, -95, 95),
        clampNum(motion.vy * 0.72, -105, 105),
        1.08
      );
    }
    const step = (now) => {
      if (S.bustPull && S.bustPull.active) return;
      const t = Math.min(1, (now - start) / dur);
      const decay = Math.pow(1 - Math.min(1, (now - start) / (reduced ? 160 : 720)), 2);
      const seconds = (now - start) / 1000;
      const frame = {
        x: reduced ? motion.x * decay : bustPullSettle(motion.x, recent ? clampNum(motion.vx, -maxVelocity, maxVelocity) : 0, seconds, feel.bounce),
        y: reduced ? motion.y * decay : bustPullSettle(motion.y, recent ? clampNum(motion.vy, -maxVelocity, maxVelocity) : 0, seconds, feel.bounce) +
          bustPullGravity(Math.hypot(motion.x, motion.y), seconds, (S.pullSettleTouch ? 1.55 : 4.4) * feel.bounce),
        tension: motion.tension * decay
      };
      renderBustPull(frame, { x: gaze.x * decay, y: gaze.y * decay }, decay);
      if (t < 1) S.bustPullRaf = win.requestAnimationFrame(step);
      else {
        S.bustPullRaf = 0;
        if (feel.bounce > .4) triggerBustSettleProfile(win, "pull");
        finishPullExpressiveReactions(win, peakPullT);
        clearBustPull();
        if (!calm(win) && motion.tension >= 0.72) {
          blink(win);
          win.setTimeout(() => S.el && blink(win), 200);
        }
      }
    };
    if (S.bustPullRaf) win.cancelAnimationFrame(S.bustPullRaf);
    S.bustPullRaf = win.requestAnimationFrame(step);
  }

  function reactToBustPull(win, dist) {
    if (dist >= 48) noteTouch(win, "pull");
    const peak = S.pullExpress && S.pullExpress.peakT ? S.pullExpress.peakT : 0;
    if (dist < 48 || peak < 0.62) return;
    const now = Date.now();
    if (S.lastBustPullReactAt && now - S.lastBustPullReactAt < 18000) return;
    S.lastBustPullReactAt = now;
    const windup = beginReactionWindup(win);
    const speak = () => {
      if (S.nsfwOn && readVoice(win)) playLewdPhaseWav(win, "pull_surrender");
    };
    if (windup) win.setTimeout(speak, windup);
    else speak();
  }

  function feedCompanionFloatMotion(win, vx, vy, opts) {
    if (!win || calm(win) || !S.nsfwOn) return;
    const st = ensureLive2DState();
    const vxN = Number(vx) || 0;
    const vyN = Number(vy) || 0;
    const release = !!(opts && opts.release);
    const mul = release ? 1.35 : 1.65;
    applyLive2DImpulse(win, vxN * mul, vyN * (mul + 0.12), vxN * (mul * 0.38));
    st.phoneShake.vx = clampNum(st.phoneShake.vx + vxN * (release ? 0.85 : 1.05), -220, 220);
    st.phoneShake.vy = clampNum(st.phoneShake.vy + vyN * (release ? 0.78 : 0.95), -220, 220);
    st.phoneShake.x = clampNum(st.phoneShake.x + vxN * 0.06, -16, 16);
    st.phoneShake.y = clampNum(st.phoneShake.y + vyN * 0.05, -16, 16);
    st.head.vsway = clampNum(st.head.vsway + vxN * (release ? 0.11 : 0.07), -52, 52);
    st.head.vnod = clampNum(st.head.vnod + vyN * (release ? 0.09 : 0.055), -44, 44);
    st.bust.vx = clampNum(st.bust.vx + vxN * (release ? 0.42 : 0.28), -195, 195);
    st.bust.vy = clampNum(st.bust.vy + vyN * (release ? 0.48 : 0.32), -225, 225);
    st.hair.vx = clampNum(st.hair.vx + vxN * (release ? 0.38 : 0.22), -130, 130);
    st.hair.vy = clampNum(st.hair.vy + vyN * (release ? 0.32 : 0.18), -95, 95);
  }

  function companionHapticPulse(win, pattern) {
    if (!win || calm(win)) return;
    try {
      if (win.navigator && typeof win.navigator.vibrate === "function") {
        win.navigator.vibrate(pattern);
      }
    } catch (_) {}
  }

  function startCompanionFloatInertia(win, vx, vy) {
    if (!win || !S.el || calm(win)) return;
    const vxN = Number(vx) || 0;
    const vyN = Number(vy) || 0;
    const sp = Math.hypot(vxN, vyN);
    if (sp < 55) return;
    const carry = clampNum(0.88 + Math.min(sp, 1400) / 2200, 0.88, 1.08);
    S.companionFloatInertia = {
      active: true,
      vx: vxN * carry,
      vy: vyN * carry,
      t: 0,
      lastFeedAt: 0
    };
    S.el.classList.add("is-companion-coasting");
    ensureCompanionChromeLoop(win);
    if (S.nsfwOn && sp > 120) {
      feedCompanionFloatMotion(win, vxN * 0.028, vyN * 0.028, { release: true });
    }
  }

  function tickCompanionFloatInertia(win, dt) {
    const inert = S.companionFloatInertia;
    if (!inert || !inert.active || !S.el) return;
    inert.t += dt;
    const prevX = S.companionFloat.x;
    const prevY = S.companionFloat.y;
    let nx = prevX + inert.vx * dt;
    let ny = prevY + inert.vy * dt;
    const clamped = clampCompanionFloat(win, nx, ny);
    const hitX = Math.abs(clamped.x - nx) > 0.45;
    const hitY = Math.abs(clamped.y - ny) > 0.45;
    if (hitX) {
      inert.vx *= -0.12;
      inert.vy *= 0.82;
    }
    if (hitY) {
      inert.vy *= -0.12;
      inert.vx *= 0.82;
    }
    nx = clamped.x;
    ny = clamped.y;
    S.companionFloat.x = nx;
    S.companionFloat.y = ny;
    applyCompanionFloat(win);
    S.companionDragVel = { vx: inert.vx * 0.04, vy: inert.vy * 0.04 };
    const sp = Math.hypot(inert.vx, inert.vy);
    const drag = 2.35 + Math.min(sp / 900, 1.8);
    const decay = Math.exp(-drag * dt);
    inert.vx *= decay;
    inert.vy *= decay;
    if (S.nsfwOn && sp > 90) {
      const now = typeof win.performance !== "undefined" && win.performance.now ? win.performance.now() : Date.now();
      if (!inert.lastFeedAt || now - inert.lastFeedAt > (isCompactUI(win) ? 72 : 48)) {
        inert.lastFeedAt = now;
        feedCompanionFloatMotion(win, inert.vx * 0.022, inert.vy * 0.022);
      }
    }
    const spAfter = Math.hypot(inert.vx, inert.vy);
    if (spAfter < 22 && inert.t > 0.07) {
      persistCompanionFloat(win);
      inert.active = false;
      S.companionFloatInertia = null;
      S.companionDragVel = { vx: 0, vy: 0 };
      S.el.classList.remove("is-companion-coasting");
      stopCompanionChromeLoop(win);
      if (!companionFloatVisible(win)) {
        homeCompanionFloat(win, { animate: true });
      } else if (S.nsfwOn && spAfter > 4) {
        feedCompanionFloatMotion(win, inert.vx * 0.035, inert.vy * 0.035, { release: true });
        triggerBustSettleProfile(win, "generic");
      }
    }
  }

  function stopCompanionChromeLoop(win) {
    if (S.chromeMotionRaf) {
      win.cancelAnimationFrame(S.chromeMotionRaf);
      S.chromeMotionRaf = 0;
    }
  }

  function ensureCompanionChromeLoop(win) {
    if (!win || S.chromeMotionRaf || calm(win)) return;
    if (!S.companionFloatInertia || !S.companionFloatInertia.active) return;
    let last = 0;
    let lastTick = 0;
    const tick = (t) => {
      if (!S.companionFloatInertia || !S.companionFloatInertia.active || win.document.hidden || calm(win)) {
        S.chromeMotionRaf = 0;
        return;
      }
      S.chromeMotionRaf = win.requestAnimationFrame(tick);
      const compact = isCompactUI(win);
      if (compact && lastTick && t - lastTick < 32) return;
      lastTick = t;
      const dt = clampNum(last ? (t - last) / 1000 : 0.016, 0.004, compact ? 0.05 : 0.05);
      last = t;
      tickCompanionFloatInertia(win, dt);
    };
    S.chromeMotionRaf = win.requestAnimationFrame(tick);
  }

  function startCompanionChromeLoop(win) {
    ensureCompanionChromeLoop(win);
  }

  function resetCompanionPose(win) {
    if (!win || !S.el) return;
    if (S.companionHomeRaf) {
      win.cancelAnimationFrame(S.companionHomeRaf);
      S.companionHomeRaf = 0;
    }
    S.companionFloat = { x: 0, y: 0 };
    S.companionAvatarScale = 1;
    S.companionFloatInertia = null;
    S.companionDragVel = { vx: 0, vy: 0 };
    stopCompanionChromeLoop(win);
    applyCompanionFloat(win);
    applyCompanionAvatarScale(win);
    persistCompanionFloat(win);
    persistCompanionAvatarScale(win);
    companionHapticPulse(win, [6, 42, 8]);
    if (S.nsfwOn) applyLive2DImpulse(win, 0, -22, 0);
    if (typeof win.hqToast === "function") {
      win.hqToast("Position réinitialisée ♥", "tip", 1300);
    }
  }

  function triggerSlingshotAftershock(win, dx, dy, dist) {
    if (!win || dist < 14) return;
    const m = clampNum(dist / 72, 0.4, 1.55);
    triggerBustSettleProfile(win, "slingshot");
    if (!S.nsfwOn) return;
    const st = ensureLive2DState();
    st.hair.vx = clampNum(st.hair.vx + dx * 0.11 * m, -130, 130);
    st.hair.vy = clampNum(st.hair.vy + dy * 0.085 * m, -95, 95);
    st.hair.vrot = clampNum(st.hair.vrot + dx * 0.04 * m, -110, 110);
    st.bust.vx = clampNum(st.bust.vx + dx * 0.075 * m, -195, 195);
    st.bust.vy = clampNum(st.bust.vy + dy * 0.088 * m, -225, 225);
    impulseBustSidesOnly(win, dx * 0.35 * m, dy * 0.42 * m, 1);
    if (S.el) {
      S.el.classList.remove("is-slingshot-aftershock");
      void S.el.offsetWidth;
      S.el.classList.add("is-slingshot-aftershock");
      win.setTimeout(() => S.el && S.el.classList.remove("is-slingshot-aftershock"), 980);
    }
  }

  function runTreatReactionChain(win, av, item) {
    if (!win || !av || !item) return;
    const emoji = String(item.emoji || "");
    if (emoji === "☕") {
      addArousalWarmth(win, 4, "café");
      if (S.steamMist) {
        S.steamMist.classList.add("is-treat-burst");
        win.setTimeout(() => S.steamMist && S.steamMist.classList.remove("is-treat-burst"), 1500);
      }
      if (S.nsfwOn && adultFxAllowed(win)) playAdultFx(win, "steam", 1300);
    } else if (emoji === "🍓") {
      addArousalWarmth(win, 8, "fraise");
      if (S.el) {
        flashBlush(win, 2400);
      }
      if (S.nsfwOn) applyLive2DImpulse(win, 0, 24, 0);
    } else if (emoji === "🌹") {
      addArousalWarmth(win, 6, "rose");
      for (let i = 0; i < 3; i += 1) {
        win.setTimeout(() => spawnCuteHeart(win, av, "🌹"), i * 120);
      }
    }
  }

  function navGlanceCompanion(win, toView) {
    if (!win || lifeMotionBlocked() || !S.el) return;
    glanceViewPanel(win, toView);
    const nav = win.document.querySelector('.bottom-nav button[data-nav="' + toView + '"]');
    if (!nav || !S.bubble) return;
    const nr = nav.getBoundingClientRect();
    const br = S.bubble.getBoundingClientRect();
    const dx = clampNum((nr.left + nr.width * 0.5 - (br.left + br.width * 0.5)) * 0.09, -16, 16);
    S.bubble.style.setProperty("--nav-nudge-x", dx.toFixed(1) + "px");
    S.el.classList.remove("is-nav-glance");
    void S.el.offsetWidth;
    S.el.classList.add("is-nav-glance");
    win.setTimeout(() => {
      if (S.el) S.el.classList.remove("is-nav-glance");
      if (S.bubble) S.bubble.style.removeProperty("--nav-nudge-x");
    }, 780);
  }

  function scheduleIdleMicroFidget(win) {
    if (!win || calm(win)) return;
    win.clearTimeout(S.idleFidgetT);
    const nsfw = !!S.nsfwOn;
    const looking = !!S.userLookingAtCompanion;
    const base = nsfw ? (looking ? 9000 : 12000) : 16000;
    const spread = nsfw ? (looking ? 11000 : 15000) : 22000;
    S.idleFidgetT = win.setTimeout(() => {
      const idleMs = Date.now() - (S.lastActAt || Date.now());
      const minIdle = nsfw ? 5500 : 9000;
      if (lifeMotionBlocked() || S.companionDragActive || idleMs < minIdle) {
        scheduleIdleMicroFidget(win);
        return;
      }
      if (Math.random() < 0.58) blink(win);
      playIdleAnim(win, pickIdleAnimKind());
      if (nsfw && Math.random() < 0.35) {
        win.setTimeout(() => {
          if (!S.el || lifeMotionBlocked()) return;
          playIdleAnim(win, Math.random() < 0.5 ? "shimmy" : "aftershock");
        }, 420 + Math.random() * 380);
      }
      scheduleIdleMicroFidget(win);
    }, base + Math.random() * spread);
  }

  function scheduleIdleAmbientJiggle(win) {
    if (!win || calm(win)) return;
    win.clearTimeout(S.idleAmbientJiggleT);
    S.idleAmbientJiggleT = win.setTimeout(() => {
      if (!S.el || S.el.hidden || lifeMotionBlocked() || S.companionDragActive) {
        scheduleIdleAmbientJiggle(win);
        return;
      }
      const idleMs = Date.now() - (S.lastActAt || Date.now());
      if (idleMs > 4500 && S.nsfwOn && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const st = ensureLive2DState();
        const sign = Math.random() > 0.5 ? 1 : -1;
        st.bust.vy = clampNum(st.bust.vy + sign * (12 + Math.random() * 18), -225, 225);
        st.bustSides.left.vy = clampNum(st.bustSides.left.vy + sign * 8, -88, 88);
        st.bustSides.right.vy = clampNum(st.bustSides.right.vy - sign * 7, -88, 88);
        startLive2DLoop(win);
      } else if (idleMs > 6000 && !S.nsfwOn && !S.el.classList.contains("is-minimal")) {
        S.el.classList.add("is-idle-jiggle-soft");
        win.setTimeout(() => S.el && S.el.classList.remove("is-idle-jiggle-soft"), 640);
      }
      scheduleIdleAmbientJiggle(win);
    }, 6500 + Math.random() * 4500);
  }

  function tickIdleBustJiggle(win, nowMs, dt) {
    if (!S.nsfwOn || lifeMotionBlocked() || S.companionDragActive) return;
    if (S.el && (S.el.classList.contains("is-bust-pull") || S.el.classList.contains("is-companion-coasting"))) return;
    const idleMs = nowMs - (S.lastPointerMoveAt || S.lastActAt || nowMs);
    if (idleMs < 4000) return;
    const st = ensureLive2DState();
    st.idleJigglePhase = (st.idleJigglePhase || 0) + dt;
    const warmth = typeof S.warmth === "number" ? S.warmth : 22;
    const wNorm = clampNum((warmth - 10) / 90, 0, 1);
    const warmAmp = 1 + clampNum((warmth - 68) / 32, 0, 1) * 0.45;
    const idleBlend = clampNum((idleMs - 4000) / 10000, 0, 1);
    let amp = (0.12 + wNorm * 0.38 + (S.userLookingAtCompanion ? 0.12 : 0)) * idleBlend * warmAmp;
    if (S.el.classList.contains("is-idle-stillness") && S.userLookingAtCompanion) amp *= 0.55;
    if (amp >= 0.04) {
      const w1 = Math.sin(st.idleJigglePhase * 2.35) * 34 * amp;
      const w2 = Math.cos(st.idleJigglePhase * 1.62 + 0.6) * 26 * amp;
      const w3 = Math.sin(st.idleJigglePhase * 3.1 + 1.2) * 18 * amp;
      st.bust.vy = clampNum(st.bust.vy + w1 * dt, -225, 225);
      st.bust.vx = clampNum(st.bust.vx + w2 * dt, -195, 195);
      st.bustSides.left.vy = clampNum(st.bustSides.left.vy + (w1 + w3) * 0.42 * dt, -88, 88);
      st.bustSides.right.vy = clampNum(st.bustSides.right.vy + (w1 - w3 * 0.85) * 0.38 * dt, -88, 88);
      st.hair.vy = clampNum(st.hair.vy + w2 * 0.15 * dt, -95, 95);
      kickBustSideSlosh(st.bustSides.left, w2 * 0.082, w1 * 0.095);
      kickBustSideSlosh(st.bustSides.right, -w2 * 0.076, w1 * 0.088);
    }
    const breath = Math.sin(st.phase || 0);
    if (breath < -0.15) {
      const sag = (breath + 0.15) * 22 * wNorm * idleBlend;
      st.bustSides.left.vy = clampNum(st.bustSides.left.vy + sag * dt, -88, 88);
      st.bustSides.right.vy = clampNum(st.bustSides.right.vy + sag * 1.05 * dt, -88, 88);
    }
    if (S.userLookingAtCompanion) {
      st.head.ty = clampNum(st.head.ty * 0.92 - 0.35 * dt * 60, -5.5, 5.5);
      st.head.tx = clampNum(st.head.tx * 0.94, -7.5, 7.5);
    }
    if (S.idleWalkUntil && nowMs < S.idleWalkUntil) {
      if (!S.idleWalkNextAt || nowMs >= S.idleWalkNextAt) {
        S.idleWalkStep = (S.idleWalkStep || 0) + 1;
        const side = S.idleWalkStep % 2 === 0 ? 1 : -1;
        st.bust.vx = clampNum(st.bust.vx + side * 38, -195, 195);
        st.bustSides.left.vy = clampNum(st.bustSides.left.vy + side * 12, -88, 88);
        st.bustSides.right.vy = clampNum(st.bustSides.right.vy - side * 10, -88, 88);
        S.idleWalkNextAt = nowMs + 380;
      }
    }
  }

  function stopVoiceLipsyncLoop(win) {
    if (!win) return;
    win.clearInterval(S.voiceLipsyncT);
    S.voiceLipsyncT = 0;
    if (S.voiceMeter) {
      try { S.voiceMeter.source.disconnect(); S.voiceMeter.analyser.disconnect(); } catch (_) {}
      S.voiceMeter = null;
    }
    if (S.el) {
      S.el.classList.remove("is-voice-lipsync");
      S.el.style.removeProperty("--rig-voice-nod");
      S.el.style.removeProperty("--rig-voice-level");
    }
  }

  function attachVoiceMeter(win, audio) {
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!AC || calm(win)) return;
    // Cross-origin media can be silent through a Web Audio graph without
    // CORS permission. Keep its normal playback and use the fallback cadence.
    try {
      if (new win.URL(audio.src, win.location.href).origin !== win.location.origin) return;
      if (!S.audioCtx) S.audioCtx = new AC();
      const ctx = S.audioCtx;
      const connect = () => {
        if (S.currentAudio !== audio || ctx.state !== "running" || S.voiceMeter) return;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        const wired = S.speechWebVoice?.audio === audio ? S.speechWebVoice.source : null;
        const source = wired || ctx.createMediaElementSource(audio);
        source.connect(analyser);
        if (!wired) {
          source.connect(ctx.destination);
        }
        S.voiceMeter = { source, analyser, data: new Uint8Array(analyser.fftSize), lastAt: -Infinity };
        if (S.nsfwOn) startLive2DLoop(win);
      };
      if (ctx.state === "running") connect();
      else ctx.resume().then(connect).catch(() => {});
    } catch (_) { /* Playback remains available without an analyser. */ }
  }

  function sampleVoiceMeter(time) {
    const meter = S.voiceMeter;
    if (!meter || !S.el || time - meter.lastAt < 32) return;
    meter.lastAt = time;
    meter.analyser.getByteTimeDomainData(meter.data);
    let energy = 0;
    for (const sample of meter.data) { const value = (sample - 128) / 128; energy += value * value; }
    const rms = Math.sqrt(energy / meter.data.length);
    const level = Math.pow(clampNum((rms - .008) * 6, 0, 1), .65) * .82;
    meter.level = level;
    setLive2dStyleVar(S.el.style, "--rig-voice-level", level.toFixed(4));
    if (S.el.classList.contains("is-voice-lipsync")) {
      const bump = 0.008 + level * 0.044;
      S.el.style.setProperty("--rig-voice-nod", (1 + bump).toFixed(4));
      if (S.nsfwOn && level > 0.05) {
        const st = ensureLive2DState();
        const prev = meter.peak || 0;
        if (level >= prev + 0.07 || (level > 0.22 && time - (meter.impulseAt || 0) > 90)) {
          st.head.vnod = clampNum(st.head.vnod + 1.6 + level * 3.4, -44, 44);
          meter.impulseAt = time;
        }
        meter.peak = level > prev * 0.92 ? level : prev * 0.94;
      }
    }
  }

  function startVoiceLipsyncLoop(win) {
    if (!win || calm(win)) return;
    stopVoiceLipsyncLoop(win);
    if (S.el) {
      S.el.classList.add("is-voice-lipsync");
      S.el.style.setProperty("--rig-voice-nod", "1");
    }
    if (S.nsfwOn) startLive2DLoop(win);
  }

  function applyLive2DImpulse(win, fx, fy, frot) {
    if (!win || calm(win)) return;
    const st = ensureLive2DState();
    const ix = Number(fx) || 0;
    const iy = Number(fy) || 0;
    st.bust.vx = clampNum(st.bust.vx + ix * 1.12, -210, 210);
    st.bust.vy = clampNum(st.bust.vy + iy * 1.18, -240, 240);
    st.bust.vrot = clampNum(st.bust.vrot + (Number(frot) || ix * 0.45), -150, 150);
    st.bustSides.left.vy = clampNum(st.bustSides.left.vy + iy * 0.42, -95, 95);
    st.bustSides.right.vy = clampNum(st.bustSides.right.vy + iy * 0.36, -95, 95);
    st.bustSides.left.vx = clampNum(st.bustSides.left.vx + ix * 0.38, -55, 55);
    st.bustSides.right.vx = clampNum(st.bustSides.right.vx - ix * 0.32, -55, 55);
    kickBustSideSlosh(st.bustSides.left, ix * 0.92, iy * 1.02);
    kickBustSideSlosh(st.bustSides.right, -ix * 0.84, iy * 0.96);
    kickBustSoftTissue(st, ix, iy);
    st.hair.vx = clampNum(st.hair.vx + ix * 0.65, -130, 130);
    st.hair.vy = clampNum(st.hair.vy + iy * 0.35, -90, 90);
    st.hair.vrot = clampNum(st.hair.vrot + ix * 0.55, -110, 110);
    st.head.vsway = clampNum(st.head.vsway + ix * 0.13, -42, 42);
    st.head.vnod = clampNum(st.head.vnod + iy * 0.08, -36, 36);
  }

  function setLive2DTarget(win, tx, ty) {
    if (!win || calm(win)) return;
    const st = ensureLive2DState();
    st.head.tx = clampNum(Number(tx) || 0, -6.5, 6.5);
    st.head.ty = clampNum(Number(ty) || 0, -5.5, 5.5);
    st.head.driftX *= 0.65;
    st.head.driftY *= 0.65;
  }

  function lifeMotionBlocked() {
    if (!S.el || !S.win || calm(S.win)) return true;
    if (S.el.hidden || S.win.document.hidden) return true;
    if (S.el.classList.contains("is-bust-pull") || (S.bustPull && S.bustPull.active)) return true;
    if (S.el.classList.contains("is-nsfw-fx-rhythm")) return true;
    if (S.el.classList.contains("is-chat-thinking") || S.busy) return true;
    return false;
  }

  function getCircadianMotionScale() {
    if (!S.el) return { damp: 1, blinkMul: 1, headBias: 0, swayCap: 1 };
    if (S.el.classList.contains("is-time-latenight")) {
      return { damp: 1.2, blinkMul: 1.32, headBias: 0.4, swayCap: 0.84 };
    }
    if (S.el.classList.contains("is-time-morning")) {
      return { damp: 0.93, blinkMul: 0.9, headBias: -0.2, swayCap: 1.06 };
    }
    return { damp: 1, blinkMul: 1, headBias: 0, swayCap: 1 };
  }

  function triggerSettlingFidget(win) {
    triggerBustSettleProfile(win, "generic");
  }

  function nudgeBubbleWeight(win, strength) {
    if (!win || calm(win) || !S.bubble || S.collapsed) return;
    if (S.bubble.classList.contains("is-pulling")) return;
    const s = clampNum(Number(strength) || 1, 0.25, 2.2);
    applyLive2DImpulse(win, 0, -26 * s, 0);
    const stretch = Math.min(0.055, 0.016 * s);
    S.bubble.style.setProperty("--pull-scale-x", (1 + stretch).toFixed(3));
    S.bubble.style.setProperty("--pull-scale-y", (1 - stretch * 0.55).toFixed(3));
    win.clearTimeout(S.bubbleWeightT);
    S.bubbleWeightT = win.setTimeout(() => {
      if (!S.bubble || S.bubble.classList.contains("is-pulling")) return;
      S.bubble.style.removeProperty("--pull-scale-x");
      S.bubble.style.removeProperty("--pull-scale-y");
    }, 360);
  }

  function pulseCompanionMotion(win) {
    if (!win || lifeMotionBlocked()) return;
    const now = Date.now();
    if (S.lastPulseMotionAt && now - S.lastPulseMotionAt < 5000) return;
    S.lastPulseMotionAt = now;
    applyLive2DImpulse(win, 0, -38, 0);
    const st = ensureLive2DState();
    st.phoneShake.vx = clampNum(st.phoneShake.vx + (Math.random() - 0.5) * 10, -105, 105);
    st.phoneShake.vy = clampNum(st.phoneShake.vy - 6, -105, 105);
  }

  function glanceViewPanel(win, toView) {
    if (!win || lifeMotionBlocked() || !S.el) return;
    const panel = win.document.querySelector('[data-panel="' + toView + '"]');
    if (!panel) return;
    const host = S.el.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const tx = clampNum((pr.left + pr.width * 0.28 - (host.left + host.width * 0.5)) / 110, -2.4, 2.4);
    setLive2DTarget(win, tx * 2, -0.35);
    win.clearTimeout(S.viewGlanceT);
    S.viewGlanceT = win.setTimeout(() => setLive2DTarget(win, 0, 0), 720);
  }

  function syncCleavagePreTension(active) {
    if (!S.el || S.el.classList.contains("is-bust-pull") || (S.bustPull && S.bustPull.active)) return;
    S.cleavageRampTarget = active && S.nsfwOn ? 1 : 0;
    if (!active) {
      S.cleavageRamp = 0;
      S.cleavageGather = 0;
      S.cleavageEnterAt = 0;
      S.bustPetLastAngle = null;
      S.bustPetOrbitAmp = 0;
      S.el.classList.remove("is-cleavage-preload", "is-cleavage-gather");
      if (!S.el.classList.contains("is-bust-pull")) clearPullVar("--pull-tension");
      clearPullVar("--rig-bust-preload-y");
      clearPullVar("--rig-bust-gather-spread");
      clearPullVar("--rig-bust-gather-scale-y");
      return;
    }
    if (!S.cleavageEnterAt) S.cleavageEnterAt = Date.now();
    S.el.classList.add("is-cleavage-preload");
  }

  function tickCleavagePreTension(dt) {
    if (!S.el || S.el.classList.contains("is-bust-pull")) return;
    const target = S.cleavageRampTarget || 0;
    const speed = target > S.cleavageRamp ? 2.8 : 4.5;
    S.cleavageRamp = clampNum(S.cleavageRamp + (target - S.cleavageRamp) * Math.min(1, dt * speed), 0, 1);
    const sinceEnter = S.cleavageEnterAt ? (Date.now() - S.cleavageEnterAt) / 1000 : 0;
    const gatherTarget =
      target > 0 && sinceEnter > 0.38 ?
        clampNum((sinceEnter - 0.38) / 0.52, 0, 1) * S.cleavageRamp :
        0;
    S.cleavageGather = clampNum(S.cleavageGather + (gatherTarget - S.cleavageGather) * Math.min(1, dt * 3.2), 0, 1);
    if (S.cleavageRamp <= 0.002 && target === 0) {
      S.el.classList.remove("is-cleavage-preload", "is-cleavage-gather");
      clearPullVar("--pull-tension");
      clearPullVar("--rig-bust-preload-y");
      clearPullVar("--rig-bust-gather-spread");
      clearPullVar("--rig-bust-gather-scale-y");
      return;
    }
    const eased = S.cleavageRamp * S.cleavageRamp * (3 - 2 * S.cleavageRamp);
    const gather = S.cleavageGather * S.cleavageGather * (3 - 2 * S.cleavageGather);
    S.el.classList.toggle("is-cleavage-gather", gather > 0.12);
    setPullVar("--pull-tension", (eased * 0.11).toFixed(3));
    setPullVar("--rig-bust-preload-y", (eased * 1.8).toFixed(2) + "px");
    setPullVar("--rig-bust-gather-spread", (gather * 2.4).toFixed(2) + "px");
    setPullVar("--rig-bust-gather-scale-y", (1 + gather * 0.009).toFixed(4));
  }

  function syncCompanionInputMotion(win) {
    if (!S.el || !S.inputEl) return;
    const on =
      win.document.activeElement === S.inputEl || String(S.inputEl.value || "").trim().length > 0;
    S.el.classList.toggle("is-user-typing", on);
    S.companionTypingLean = on;
    if (on) {
      win.clearTimeout(S.typingLeanT);
      S.typingLeanT = win.setTimeout(() => {
        S.companionTypingLean = false;
        if (S.el) S.el.classList.remove("is-user-typing");
      }, 2400);
    }
  }

  // Idle sway without a visible loop: three incommensurate sines whose phase
  // drifts with time (not with the frame), kept near [-1, 1].
  function idleNoise(salt, nowMs) {
    const t = nowMs * 0.001;
    const drift = Math.sin(t * 0.013 + salt * 1.7) * 0.65;
    const a = Math.sin(t * 0.37 + salt + drift) +
      0.63 * Math.sin(t * 0.91 + salt * 2.1 + drift * 0.7) +
      0.31 * Math.sin(t * 1.73 + salt * 0.6);
    return a / 1.94;
  }

  // Tip of one side of hair. The root image keeps the current motion exactly;
  // this spring follows it with lag and a slightly wider swing.
  function tickHairTip(st, side, root, dt, frozen) {
    if (!st.hairTip) st.hairTip = {};
    let b = st.hairTip[side];
    if (!b) b = st.hairTip[side] = { x: root.x, y: root.y, r: root.rotation, vx: 0, vy: 0, vr: 0 };
    const frame = clampNum(dt, 0.004, 0.032);
    const steps = Math.min(8, Math.max(1, Math.ceil(frame / 0.005)));
    const h = frame / steps;
    const gain = frozen ? 1 : 1.16;
    const k = frozen ? 92 : 36;
    const c = frozen ? 19 : 6.2;
    for (let i = 0; i < steps; i += 1) {
      b.vx += ((root.x * gain - b.x) * k - b.vx * c) * h;
      b.vy += ((root.y * gain - b.y) * k - b.vy * c) * h;
      b.vr += ((root.rotation * gain - b.r) * k - b.vr * c) * h;
      b.x = clampNum(b.x + b.vx * h, -6, 6);
      b.y = clampNum(b.y + b.vy * h, -4, 4);
      b.r = clampNum(b.r + b.vr * h, -4.2, 4.2);
    }
    return b;
  }

  function tickSpeechHairKick(st, mouthMotion) {
    if (!mouthMotion || calm(S.win)) return;
    const env = mouthMotion.envelope || 0;
    const prev = st.speechEnv || 0;
    if (env > 0.74 && prev <= 0.74) {
      st.hair.vy = clampNum(st.hair.vy - 2.4 - env * 1.2, -95, 95);
      st.hair.vrot = clampNum(st.hair.vrot + (Math.random() > 0.5 ? 1 : -1) * (0.9 + env * 0.8), -110, 110);
    }
    st.speechEnv = env;
  }

  function tickJawFollow(st, dt, nowMs, warmth, reduced) {
    if (!st.jawEl || !st.jawEl.isConnected) {
      st.jawEl = S.el && S.el.querySelector(".hq-mouth-jaw");
      st.jawWrap = st.jawEl && st.jawEl.parentElement;
    }
    const gasp = S.breathEvent && S.breathEvent.kind === "gasp" ? S.breathEvent.t0 : 0;
    if (gasp && gasp !== st.jawGaspT && !reduced) {
      st.jawGaspT = gasp;
      st.jawV = (st.jawV || 0) + 3.1;
    }
    const wn = 12;
    const zeta = 0.68;
    const err = -(st.jawDrop || 0);
    st.jawV = (st.jawV || 0) + (wn * wn * err - 2 * zeta * wn * (st.jawV || 0)) * dt;
    st.jawDrop = clampNum((st.jawDrop || 0) + (st.jawV || 0) * dt, -0.04, 1.15);
    if (!st.jawEl || !st.jawWrap) return;
    const base = parseFloat(st.jawWrap.style.getPropertyValue("--mouth-jaw")) || 0;
    let quiver = 0;
    if (!reduced && warmth > 75) {
      const amp = ((warmth - 75) / 25) * 0.08;
      quiver = Math.sin(nowMs * 0.029) * amp + Math.sin(nowMs * 0.043 + 1.1) * amp * 0.4;
    }
    // jawDrop peaks near 0.12; 4.6 puts a gasp around half of a full mouth-jaw.
    const extra = (reduced ? 0 : st.jawDrop * 4.6) + quiver;
    const pulling = !!(S.el && S.el.classList.contains("is-bust-pull"));
    const mouthOpen = base > 0.001;
    const gaspLive = Math.abs(st.jawDrop || 0) > 0.02 || Math.abs(st.jawV || 0) > 0.15;
    // Keep the chin copy up for the whole quiver. The sine crosses zero, and
    // dropping the mask there would flash a seam across the mouth.
    const showGasp = !pulling && !mouthOpen && (gaspLive || (!reduced && warmth > 75));
    if (showGasp !== !!st.gaspJawOn) {
      st.jawWrap.classList.toggle("has-gasp-jaw", showGasp);
      st.gaspJawOn = showGasp;
    }
    if (Math.abs(extra) < 0.0008 || pulling) {
      if (st.jawWrote) {
        st.jawEl.style.removeProperty("--mouth-jaw");
        st.jawWrote = false;
      }
      return;
    }
    st.jawEl.style.setProperty("--mouth-jaw", (base + extra).toFixed(4));
    st.jawWrote = true;
  }

  function tickEyeLife(st, nowMs, reduced) {
    const pointerAt = S.lastPointerMoveAt || 0;
    const still = nowMs - (pointerAt || nowMs) > 650 && !(S.bustPull && S.bustPull.active);
    if (!reduced && still && nowMs > (st.nextSaccade || 0) && S.face) {
      st.flickBaseX = parseFloat(S.face.style.getPropertyValue("--gx")) || 0;
      st.flickBaseY = parseFloat(S.face.style.getPropertyValue("--gy")) || 0;
      st.flickX = (Math.random() - 0.5) * 3.4;
      st.flickY = (Math.random() - 0.5) * 2;
      st.flickUntil = nowMs + 68 + Math.random() * 36;
      st.flickAt = pointerAt;
      st.nextSaccade = nowMs + 1800 + Math.random() * 2200;
    }
    const flickOn = !reduced && still && nowMs < (st.flickUntil || 0);
    if (S.face && flickOn) {
      S.face.style.setProperty("--gx", (st.flickBaseX + st.flickX).toFixed(2) + "px");
      S.face.style.setProperty("--gy", (st.flickBaseY + st.flickY).toFixed(2) + "px");
      if (S.el && !st.flickWas) S.el.classList.add("is-saccade");
      st.flickWas = true;
      st.saccadeHold = st.flickUntil + 60;
      st.saccadeX = st.flickX;
      st.saccadeY = st.flickY;
    } else if (st.flickWas) {
      // A pointer move during the flick already wrote the real gaze. Putting the
      // old base back would wipe it.
      const pointerMoved = (S.lastPointerMoveAt || 0) > (st.flickAt || 0);
      if (S.face && !pointerMoved) {
        S.face.style.setProperty("--gx", (st.flickBaseX || 0).toFixed(1) + "px");
        S.face.style.setProperty("--gy", (st.flickBaseY || 0).toFixed(1) + "px");
      }
      st.flickWas = false;
      st.saccadeX = 0;
      st.saccadeY = 0;
    }
    if (S.el && st.saccadeHold && !flickOn && nowMs > st.saccadeHold) {
      S.el.classList.remove("is-saccade");
      st.saccadeHold = 0;
    }
    // Gaze only. head.y bobs every frame and was repainting the eyelid paths.
    const lookDown = clampNum(Math.max(0, S.gazeY || 0) / 2.4, 0, 1);
    const lid = reduced ? 0 : Math.round(lookDown * 0.22 * 50) / 50;
    if (!st.eyeSvg || !st.eyeSvg.isConnected) st.eyeSvg = S.el && S.el.querySelector(".hq-expressive-eyes");
    if (st.eyeSvg) {
      const v = lid.toFixed(3);
      if (v !== st.lidLast) {
        st.lidLast = v;
        st.eyeSvg.style.setProperty("--rig-lid-down", v);
      }
    }
  }

  function tickIdleGaze(win, nowMs, avatarEl, layoutSample) {
    if (!win || lifeMotionBlocked() || !S.nsfwOn || !avatarEl) return;
    const st = ensureLive2DState();
    const idleMs = nowMs - (S.lastPointerMoveAt || S.lastActAt || nowMs);
    if (idleMs < 3000) {
      st.head.driftX *= 0.9;
      st.head.driftY *= 0.9;
      return;
    }
    const blend = Math.min(1, (idleMs - 3000) / 4500);
    let gx = 0;
    let gy = 0;
    if (!isCompactUI(win) && S.bubble && !S.collapsed && layoutSample) {
      const ar = cachedRect(win, avatarEl, 500);
      const br = cachedRect(win, S.bubble, 500);
      gx = clampNum((br.left + br.width * 0.32 - (ar.left + ar.width * 0.5)) / 42, -2.6, 2.6);
      gy = clampNum((br.top + br.height * 0.22 - (ar.top + ar.height * 0.38)) / 42, -2.2, 2.2);
    } else {
      gx = idleNoise(1.1, nowMs) * 1.2;
      gy = idleNoise(2.4, nowMs) * 0.95;
    }
    const circ = getCircadianMotionScale();
    const tgtX = gx * blend * 1.05;
    const tgtY = (gy + circ.headBias * 0.35) * blend * 0.95;
    st.head.driftX = clampNum(st.head.driftX * 0.94 + tgtX * 0.06, -3.2, 3.2);
    st.head.driftY = clampNum(st.head.driftY * 0.94 + tgtY * 0.06, -2.8, 2.8);
  }

  function stopLive2DLoop(win) {
    if (!win) return;
    const st = ensureLive2DState();
    if (st.raf) {
      win.cancelAnimationFrame(st.raf);
      st.raf = 0;
    }
    if (st.waitT) {
      win.clearTimeout(st.waitT);
      st.waitT = 0;
    }
  }

  function scheduleLive2DFrame(win, step, delayMs) {
    const st = ensureLive2DState();
    if (delayMs > 0) {
      if (st.waitT) return;
      st.raf = 0;
      st.waitT = win.setTimeout(() => {
        st.waitT = 0;
        if (!S.nsfwOn || !S.el || S.el.hidden || win.document.hidden) return;
        st.raf = win.requestAnimationFrame(step);
      }, delayMs);
      return;
    }
    if (st.raf) return;
    st.raf = win.requestAnimationFrame(step);
  }

  function startLive2DLoop(win) {
    if (!win || typeof win.requestAnimationFrame !== "function" || calm(win)) return;
    const st = ensureLive2DState();
    if (st.raf || st.waitT) return;
    let characterMotionQuery = null;
    try { characterMotionQuery = win.matchMedia("(prefers-reduced-motion: reduce)"); } catch (_) {}

    const step = (nowMs) => {
      st.raf = 0;
      if (!S.nsfwOn) {
        stopLive2DLoop(win);
        return;
      }
      if (!S.el || S.el.hidden || win.document.hidden) {
        st.lastT = nowMs;
        stopLive2DLoop(win);
        return;
      }
      const floatDraggingEarly = !!(S.companionDragActive && S.nsfwOn);
      const layeredPortrait = !!(S.el && S.el.classList.contains("has-layered-portrait"));
      const compact = isCompactUI(win);
      const keepAliveCollapsed = compact && layeredPortrait && S.nsfwOn;
      const minGap = compact && S.collapsed ?
        (floatDraggingEarly || (S.bustPull && S.bustPull.active) ? 0 : 48) : 0;
      if (minGap && st.lastWorkAt && nowMs - st.lastWorkAt < minGap) {
        scheduleLive2DFrame(win, step, Math.max(1, minGap - (nowMs - st.lastWorkAt)));
        return;
      }
      if (compact && S.collapsed && !S.companionDragActive && !(S.bustPull && S.bustPull.active) && !keepAliveCollapsed) {
        stopLive2DLoop(win);
        return;
      }
      if (st.waitT) {
        win.clearTimeout(st.waitT);
        st.waitT = 0;
      }
      st.lastWorkAt = nowMs;
      scheduleLive2DFrame(win, step, 0);
      const rawDt = st.lastT ? (nowMs - st.lastT) / 1000 : 0.016;
      st.lastT = nowMs;
      // Clamp dt for rock-solid numerical stability across frame drops or tab switches
      const dt = clampNum(rawDt, 0.004, 0.032);
      const reducedMotion = !!(characterMotionQuery && characterMotionQuery.matches);
      st.posture = stepRigPosture(st.posture,S.rigPosture,dt,!!(S.bustPull && S.bustPull.active),reducedMotion);
      publishRigPosture(st.posture,reducedMotion);
      updateCursorSupport(st, dt);
      tickCleavagePreTension(dt);
      S.bustStrokeBX *= Math.pow(0.86, dt * 60);
      S.bustStrokeBY *= Math.pow(0.86, dt * 60);
      S.bustPetOrbitAmp *= Math.pow(0.9, dt * 60);
      if (S.bustPetOrbitAmp > 0.04) {
        S.bustStrokeBX = clampNum(S.bustStrokeBX + Math.cos(S.bustPetOrbitAngle) * S.bustPetOrbitAmp * 1.1, -24, 24);
        S.bustStrokeBY = clampNum(S.bustStrokeBY + Math.sin(S.bustPetOrbitAngle) * S.bustPetOrbitAmp * 1.15, -24, 24);
      }
      const afterglow = tickBustAfterglow(nowMs);
      if (!pullFxRenderedRecently(nowMs)) syncContactBlush(win);
      const phoneShake = st.phoneShake;
      const floatDragging = !!(S.companionDragActive && S.nsfwOn);
      const shakePosCap = floatDragging ? 16.5 : 8.5;
      const shakeOutCap = floatDragging ? 52 : 26;
      const shakeAmp = floatDragging ? 2.35 : 1;
      phoneShake.vx += (-70 * phoneShake.x - 9 * phoneShake.vx) * dt;
      phoneShake.vy += (-70 * phoneShake.y - 9 * phoneShake.vy) * dt;
      phoneShake.x = clampNum(phoneShake.x + phoneShake.vx * dt, -shakePosCap, shakePosCap);
      phoneShake.y = clampNum(phoneShake.y + phoneShake.vy * dt, -shakePosCap, shakePosCap);
      phoneShake.pulseX += (phoneShake.targetX - phoneShake.pulseX) * Math.min(1, dt * 18);
      phoneShake.pulseY += (phoneShake.targetY - phoneShake.pulseY) * Math.min(1, dt * 18);
      const pulseAge = phoneShake.pulseAt ? (nowMs - phoneShake.pulseAt) / 1000 : 10;
      const pulse = pulseAge >= 0 && pulseAge < 1.4 ?
        Math.exp(-2.5 * pulseAge) * Math.sin(pulseAge * Math.PI * 2.2) : 0;
      const phoneX = clampNum((phoneShake.x * 0.35 + phoneShake.pulseX * pulse) * shakeAmp, -shakeOutCap, shakeOutCap);
      const phoneY = clampNum((phoneShake.y * 0.35 + phoneShake.pulseY * pulse) * shakeAmp, -shakeOutCap, shakeOutCap);

      let dragAX = 0;
      let dragAY = 0;
      if (S.companionDragVel) {
        if (floatDragging) {
          dragAX = clampNum(S.companionDragVel.vx * 0.72, -72, 72);
          dragAY = clampNum(S.companionDragVel.vy * 0.72, -72, 72);
        } else {
          S.companionDragVel.vx *= Math.pow(0.78, dt * 60);
          S.companionDragVel.vy *= Math.pow(0.78, dt * 60);
          if (Math.hypot(S.companionDragVel.vx, S.companionDragVel.vy) > 0.4) {
            dragAX = clampNum(S.companionDragVel.vx * 0.38, -42, 42);
            dragAY = clampNum(S.companionDragVel.vy * 0.38, -42, 42);
          }
        }
      }
      if (S.scrollVelAt && nowMs - S.scrollVelAt > 70) {
        S.scrollVelY = (S.scrollVelY || 0) * Math.exp(-dt * 8);
        if (Math.abs(S.scrollVelY) < 6) S.scrollVelY = 0;
      }
      const pageMotionOff = !!(characterMotionQuery && characterMotionQuery.matches);
      if (!pageMotionOff && !floatDragging && S.scrollVelY && !(S.bustPull && S.bustPull.active)) {
        const scrollAccY = clampNum(-S.scrollVelY * 0.04, -70, 70);
        dragAY += clampNum(scrollAccY * 0.28, -22, 22);
        st.scrollAccY = scrollAccY;
      } else st.scrollAccY = 0;
      if (!pageMotionOff && !(S.bustPull && S.bustPull.active) && S.typingAt && nowMs - S.typingAt < 1000 && S.typeBeats && S.typeBeats.length) {
        const beat = S.typeBeats[S.typeBeats.length - 1];
        if (beat !== st.lastTypeBeat) {
          st.lastTypeBeat = beat;
          const recent = S.typeBeats.filter((t) => nowMs - t < 700).length;
          const kick = clampNum(recent * 0.22, 0.15, 0.9);
          st.bust.vx = clampNum(st.bust.vx + (beat % 2 ? kick : -kick) * 3.2, -195, 195);
          kickBustSoftSide(st, beat % 2 ? "left" : "right", (beat % 2 ? 1 : -1) * kick * 2.2, kick * 1.4, 0);
        }
      }

      const warmth = typeof S.warmth === "number" ? S.warmth : 22;
      const wNorm = clampNum((warmth - 10) / 90, 0, 1);

      // Breathing follows warmth: ~4.5 s and full depth when calm, ~2.2 s and
      // shallower when very warm. The rate eases, so a jump in heat never snaps it.
      const breathPeriod = 4.5 - wNorm * 2.3;
      const breathTarget = (Math.PI * 2) / breathPeriod * (1 + afterglow * 0.06);
      if (typeof st.breathFreq !== "number") st.breathFreq = breathTarget;
      st.breathFreq += (breathTarget - st.breathFreq) * (1 - Math.exp(-dt / 1.35));
      const breathDrift = 1 + idleNoise(7.2, nowMs) * 0.07;
      const breathFreq = st.breathFreq * breathDrift * (1 - (st.tired || 0) * 0.1);
      const pullOn = !!(S.bustPull && S.bustPull.active);
      if (pullOn) {
        if (!st.pullSince) st.pullSince = nowMs;
      } else st.pullSince = 0;
      const holdBreath = (pullOn && nowMs - st.pullSince > 1200) || (S.bustSqueeze || 0) > 0.6;
      if (st.breathHeld && !holdBreath && !S.breathEvent) {
        S.breathEvent = { kind: "sigh", t0: nowMs };
      }
      st.breathHeld = holdBreath;
      if (typeof st.fatigue !== "number") st.fatigue = 0;
      st.fatigue *= Math.exp(-dt / 90);
      if (pullOn) st.fatigue += dt * 0.42;
      if ((S.bustSqueeze || 0) > 0.25) st.fatigue += dt * 0.26 * S.bustSqueeze;
      if (nowMs < (S.slapMotionUntil || 0)) st.fatigue += dt * 0.85;
      st.fatigue += dt * wNorm * 0.045;
      st.fatigue = clampNum(st.fatigue, 0, 8);
      const tiredTarget = clampNum((st.fatigue - 2.4) / 3.2, 0, 1);
      st.tired = (st.tired || 0) + (tiredTarget - (st.tired || 0)) * (1 - Math.exp(-dt / 2.2));
      if (st.windupLift) {
        st.windupLift *= Math.exp(-dt * 5.5);
        if (st.windupLift > -0.02) st.windupLift = 0;
      }
      if (holdBreath) {
        const cur = ((st.phase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        let delta = Math.PI / 2 - cur;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        st.phase += delta * (1 - Math.exp(-dt * 7));
      } else {
        st.phase = (st.phase + dt * breathFreq) % (Math.PI * 2);
      }
      let breathWave = Math.sin(st.phase);
      breathWave = shapeBreathEvent(breathWave, nowMs);
      if ((st.windupLift || 0) < -0.02 && !holdBreath) breathWave += Math.min(0.22, -st.windupLift * 0.2);
      if (S.bustBreathBumpUntil > nowMs) {
        const bumpT = (S.bustBreathBumpUntil - nowMs) / 920;
        breathWave += Math.sin((1 - bumpT) * Math.PI * 3.1) * 0.24 * (S.bustBreathBump || 1) * bumpT;
      } else {
        S.bustBreathBump = 0;
      }
      const breathVel = Math.cos(st.phase) * breathFreq;
      const breathDepth = (1 + idleNoise(8.4, nowMs) * 0.08) * (1 + afterglow * 0.22) * (1 - wNorm * 0.42) * (1 + (st.tired || 0) * 0.36);
      const breathY = breathWave * 1.35 * breathDepth;
      const breathSY = 1.04 + breathWave * 0.016 * breathDepth;
      // Shoulders: rise on the inhale, a quick hunch after a slap, a slow drop as she relaxes.
      if ((S.slapMotionUntil || 0) !== st.slapSeen) {
        st.slapSeen = S.slapMotionUntil || 0;
        if (st.slapSeen > nowMs) st.shoulderHunch = 1.65;
      }
      st.shoulderHunch = (st.shoulderHunch || 0) * Math.exp(-dt * 8.5);
      const warmDrop = (st.prevWarmth || warmth) - warmth;
      st.prevWarmth = warmth;
      if (warmDrop > 0.12) {
        st.sagUntil = nowMs + 1700;
        st.sagKick = Math.min(1.15, (st.sagKick || 0) + Math.min(0.85, warmDrop * 0.08));
      }
      if ((st.sagKick || 0) > 0 && nowMs > (st.sagUntil || 0)) {
        st.sagKick *= Math.exp(-dt * 1.15);
        if (st.sagKick < 0.02) st.sagKick = 0;
      }
      const idleFor = nowMs - (S.lastActAt || nowMs);
      const sagGoal = (st.sagKick || 0) + (idleFor > 9000 ? 0.38 : 0);
      st.shoulderSag = (st.shoulderSag || 0) + (sagGoal - (st.shoulderSag || 0)) * (1 - Math.exp(-dt * 0.85));
      const shoulderGoal = reducedMotion ? 0 :
        -Math.max(0, breathWave) * (0.72 * (1 - wNorm * 0.35) * (1 + (st.tired || 0) * 0.18)) +
        st.shoulderSag + (st.shoulderHunch || 0) + (st.windupLift || 0);
      const shoulderW = 9.5;
      const shoulderErr = shoulderGoal - (st.shoulderY || 0);
      st.shoulderV = (st.shoulderV || 0) + (shoulderW * shoulderW * shoulderErr - 2 * shoulderW * (st.shoulderV || 0)) * dt;
      st.shoulderY = (st.shoulderY || 0) + st.shoulderV * dt;
      tickIdleBustJiggle(win, nowMs, dt);

      // Measure avatar motion relative to the companion, so page scrolling
      // cannot inject a false impulse. This couples CSS and JS animations to
      // the visible layered portrait without changing their own keyframes.
      let avatarAX = 0, avatarAY = 0, bubbleAX = 0, bubbleAY = 0;
      const avatar = S.avatar;
      const avMotion = st.avatarMotion;
      const motionEvery = compact ? 90 : 45;
      // Phones sample her avatar motion too (every 90 ms instead of 28), so her own animations move the
      // bust there as well; the bubble motion below stays desktop-only.
      const sampleMotion = !st.lastMotionSample || nowMs - st.lastMotionSample >= motionEvery;
      // Real time since the previous sample (phones sample less often than every frame).
      const motionDt = st.lastMotionSample ? clampNum((nowMs - st.lastMotionSample) / 1000, 0.004, 0.2) : dt;
      if (sampleMotion) st.lastMotionSample = nowMs;
      // Rects measured right after the previous paint (layout clean, nearly free) instead of here,
      // where the pointer handlers have just invalidated styles and a read forces a full restyle.
      const rects = sampleMotion ? postPaintRects(win, st) : null;
      if (avatar && sampleMotion && rects && rects.av && S.el.classList.contains("has-layered-portrait") && !S.el.classList.contains("is-bust-pull")) {
        const ar = rects.av, host = rects.host;
        const x = ar.left + ar.width * 0.5 - host.left;
        const y = ar.top + ar.height * 0.5 - host.top;
        if (avMotion.x !== null && motionDt < 0.15 && Math.hypot(x - avMotion.x, y - avMotion.y) < 15) {
          const vx = clampNum((x - avMotion.x) / motionDt, -80, 80);
          const vy = clampNum((y - avMotion.y) / motionDt, -80, 80);
          avatarAX = clampNum((vx - avMotion.vx) / motionDt, -35, 35);
          avatarAY = clampNum((vy - avMotion.vy) / motionDt, -35, 35);
          avMotion.vx = vx;
          avMotion.vy = vy;
        } else {
          avMotion.vx = 0;
          avMotion.vy = 0;
        }
        avMotion.x = x;
        avMotion.y = y;
      } else if (!avatar || !S.el.classList.contains("has-layered-portrait") || S.el.classList.contains("is-bust-pull")) {
        avMotion.x = null;
        avMotion.y = null;
        avMotion.vx = 0;
        avMotion.vy = 0;
      }
      const bubble = S.bubble;
      const bubMotion = st.bubbleMotion;
      if (!compact && bubble && sampleMotion && rects && rects.bub && !S.el.classList.contains("is-bust-pull")) {
        const br = rects.bub, host = rects.host;
        const x = br.left + br.width * 0.5 - host.left;
        const y = br.top + br.height * 0.5 - host.top;
        if (bubMotion.x !== null && rawDt < 0.08 && Math.hypot(x - bubMotion.x, y - bubMotion.y) < 15) {
          const vx = clampNum((x - bubMotion.x) / dt, -80, 80);
          const vy = clampNum((y - bubMotion.y) / dt, -80, 80);
          bubbleAX = clampNum((vx - bubMotion.vx) / dt, -35, 35);
          bubbleAY = clampNum((vy - bubMotion.vy) / dt, -35, 35);
          bubMotion.vx = vx;
          bubMotion.vy = vy;
        } else {
          bubMotion.vx = 0;
          bubMotion.vy = 0;
        }
        bubMotion.x = x;
        bubMotion.y = y;
      } else {
        bubMotion.x = null;
        bubMotion.y = null;
        bubMotion.vx = 0;
        bubMotion.vy = 0;
      }

      // Rhythm Bob automatic physical coupling
      if (S.el.classList.contains("is-nsfw-fx-rhythm")) {
        const rWave = Math.sin(nowMs * 0.015);
        st.bust.vy = clampNum(st.bust.vy + rWave * 420 * dt, -220, 220);
        st.bust.vx = clampNum(st.bust.vx + Math.cos(nowMs * 0.008) * 95 * dt, -140, 140);
        st.hair.vy = clampNum(st.hair.vy + rWave * 115 * dt, -95, 95);
        st.head.vnod = clampNum(st.head.vnod + rWave * 105 * dt, -36, 36);
        st.head.vsway = clampNum(st.head.vsway + Math.cos(nowMs * 0.008) * 42 * dt, -42, 42);
      }

      // 2. Head & Torso Spring (smoothly tracks cursor target tx, ty)
      const circ = getCircadianMotionScale();
      tickIdleGaze(win, nowMs, avatar, sampleMotion);
      const typingLeanX = S.companionTypingLean ?
        (isCompactUI(S.win) ? -2.55 : -1.85) : 0;
      const typingLeanY = S.companionTypingLean ? (isCompactUI(S.win) ? 0.42 : 0.28) : 0;
      const headGoalX = st.head.tx + st.head.driftX + typingLeanX;
      const headGoalY = st.head.ty + st.head.driftY + circ.headBias * 0.12 + typingLeanY;
      const kHead = 135;
      const cHead = 15.5 * circ.damp;
      const axHead = (headGoalX - st.head.x) * kHead - st.head.vx * cHead;
      const ayHead = (headGoalY - st.head.y) * kHead - st.head.vy * cHead;
      st.head.vx = clampNum(st.head.vx + axHead * dt, -95, 95);
      st.head.vy = clampNum(st.head.vy + ayHead * dt, -95, 95);
      st.head.x = clampNum(st.head.x + st.head.vx * dt, -7.5, 7.5);
      st.head.y = clampNum(st.head.y + st.head.vy * dt, -6.5, 6.5);
      const headRot = clampNum(st.head.x * 0.52, -4.5, 4.5);
      // Bubble/avatar bob impulses drive the head as well as hair and bust.
      // A neck-anchored rotation and tiny vertical compression keep the join fixed.
      const swayForce = clampNum(-avatarAX * 4.0 - bubbleAX * 1.25 - dragAX * 8.5 - axHead * 0.2, -185, 185);
      const nodForce = clampNum(-avatarAY * 3.5 - bubbleAY * 1.0 - dragAY * 7.8 - ayHead * 0.18, -165, 165);
      const headSwayCap = floatDragging ? 3.4 : 2.6;
      const headNodCap = floatDragging ? 2.65 : 2.0;
      st.head.vsway = clampNum(st.head.vsway + (-68 * st.head.sway - 9.5 * st.head.vsway + swayForce) * dt, -52, 52);
      st.head.vnod = clampNum(st.head.vnod + (-72 * st.head.nod - 10 * st.head.vnod + nodForce) * dt, -44, 44);
      st.head.sway = clampNum(st.head.sway + st.head.vsway * dt, -headSwayCap, headSwayCap);
      st.head.nod = clampNum(st.head.nod + st.head.vnod * dt, -headNodCap, headNodCap);

      // Fixed small sub-steps (<= 5 ms) for the bust springs too, so they behave the same at any frame
      // rate and a slow frame cannot make them twitch. Per-frame inputs are held across sub-steps.
      const bustFeel = readBustFeel();
      const feelK = 1 / bustFeel.softness;
      const feelC = 1 / bustFeel.bounce;
      const feelAsym = 0.28 * bustFeel.weight;
      const physSteps = Math.min(10, Math.max(1, Math.ceil(dt / 0.005)));
      const ph = dt / physSteps;
      for (let physStep = 0; physStep < physSteps; physStep += 1) {
        // 3. Soft-Body Bust Spring — lower ω, higher ζ feel for mass + viscous drag
        const bustMass = 1 + wNorm * 0.1;
        const tiredSoft = 1 - (st.tired || 0) * 0.12;
        const kBust = 128 / bustMass * tiredSoft;
        const cBust = (10.8 + wNorm * 3.8 + afterglow * 4.5) * circ.damp * (floatDragging ? 0.68 : 1) * tiredSoft;
        const kRotBust = 142 * tiredSoft;
        const cRotBust = 9.4 * circ.damp * (floatDragging ? 0.72 : 1);
        const inertiaFX = -axHead * 1.55 - avatarAX * 14 - dragAX * 34;
        const inertiaFY = -ayHead * 1.82 - avatarAY * 14 - dragAY * 34 + breathVel * (20 + wNorm * 24);
        const sagFY = st.bust.y * 3.8 + st.bust.vy * 0.45;
        const hang = Math.max(0, -st.bust.y) * (1.6 + wNorm * 0.35);
        const axBust = -kBust * st.bust.x - cBust * st.bust.vx + inertiaFX;
        const ayBust = -kBust * st.bust.y - cBust * st.bust.vy + inertiaFY + sagFY * 0.22 + hang * 0.14;
        const arotBust = -kRotBust * st.bust.rot - cRotBust * st.bust.vrot + (-axHead * 0.62);

        st.bust.vx = clampNum(st.bust.vx + axBust * ph, -195, 195);
        st.bust.vy = clampNum(st.bust.vy + ayBust * ph, -225, 225);
        st.bust.vrot = clampNum(st.bust.vrot + arotBust * ph, -145, 145);
        st.bust.x += st.bust.vx * ph;
        bounceAxis(st.bust, "x", "vx", 10.5, .45);
        st.bust.y = clampNum(st.bust.y + st.bust.vy * ph, -12.5, 12.5);
        st.bust.rot = clampNum(st.bust.rot + st.bust.vrot * ph, -8.5, 8.5);

        for (const side of [st.bustSides.left, st.bustSides.right]) {
          if (side.x === undefined) {
            side.x = 0;
            side.vx = 0;
          }
          ensureBustSideSlosh(side);
        }
        const layeredLobe = !!(S.el && S.el.classList.contains("has-layered-portrait"));
        for (const [side, sign] of [[st.bustSides.left, -1], [st.bustSides.right, 1]]) {
          const strokeX = S.bustStrokeBX * (sign < 0 ? 0.11 : 0.09);
          const strokeY = S.bustStrokeBY * (sign < 0 ? 0.14 : 0.12);
          const gatherSpread = parseFloat(getPullVar("--rig-bust-gather-spread")) || 0;
          const gatherX = sign < 0 ? -gatherSpread * 0.55 : gatherSpread * 0.55;
          let pullLead = 0;
          let pullLag = 0;
          if (S.el.classList.contains("is-bust-pull") && Math.abs(S.pullRenderShear) > 0.02 && !layeredLobe) {
            const leadSign = S.pullRenderShear > 0 ? 1 : -1;
            const pullGain = layeredLobe ? 0.62 : 0.38;
            if (sign === leadSign) {
              pullLead = Math.abs(S.pullRenderShear) * pullGain;
              pullLag = -Math.abs(S.pullRenderShear) * (layeredLobe ? 0.22 : 0.14);
            } else {
              pullLead = -Math.abs(S.pullRenderShear) * (layeredLobe ? 0.36 : 0.22);
              pullLag = Math.abs(S.pullRenderShear) * (layeredLobe ? 0.14 : 0.08);
            }
          }
          const heartHold = S.el.classList.contains("is-cleavage-heart-hold");
          const heartPulse = heartHold ? Math.sin(nowMs * 0.0078) * 0.95 : 0;
          const bustFollowY = layeredLobe ? (sign < 0 ? 0.58 : 0.52) : (sign < 0 ? 0.68 : 0.82);
          const bustFollowX = layeredLobe ? 0.44 : 0.52;
          const rotCouple = layeredLobe ? 0.42 : 0.34;
          const targetY = st.bust.y * bustFollowY +
            sign * clampNum(st.bust.x * (layeredLobe ? 0.48 : 0.34) + st.bust.rot * rotCouple, -3.6, 3.6) +
            strokeY + pullLead + heartPulse * (sign < 0 ? 1 : 0.82);
          const targetX = sign * clampNum(st.bust.x * bustFollowX + st.bust.rot * (rotCouple + 0.08), -3.4, 3.4) +
            strokeX + gatherX + pullLag;
          const stiffnessY = sign < 0 ? (layeredLobe ? 68 : 74) : (layeredLobe ? 54 : 62);
          const dampingY = sign < 0 ? (layeredLobe ? 10.2 : 11.8) : (layeredLobe ? 9.4 : 10.6);
          const stiffnessX = sign < 0 ? (layeredLobe ? 62 : 68) : (layeredLobe ? 50 : 58);
          const impactActive = nowMs < (S.slapMotionUntil || 0);
          // During a slap: less damping so the side swings back across centre instead of easing home.
          const dampingX = (layeredLobe ? 9.4 : 10.2) * (impactActive ? .42 : 1);
          const limY = layeredLobe ? 5.8 : 6.2;
          const limX = layeredLobe ? (impactActive ? 7.2 : 5.4) : 4.8;
          // Weight: a little softer when the side is below its rest than above it (feel.weight).
          const kYSide = stiffnessY * feelK * (side.y > targetY ? 1 - feelAsym : 1 + feelAsym * 0.5);
          const sideAmp = Math.min(1, Math.abs(side.y - targetY) / limY + Math.abs(side.x - targetX) / limX);
          const ampDamp = 1 + sideAmp * 0.55 * 1.15;
          side.vy = clampNum(side.vy + ((targetY - side.y) * kYSide - side.vy * dampingY * feelC * ampDamp) * ph, -88, 88);
          side.y = clampNum(side.y + side.vy * ph, -limY, limY);
          side.vx = clampNum(side.vx + ((targetX - side.x) * stiffnessX * feelK - side.vx * dampingX * feelC * ampDamp) * ph, -72, 72);
          side.x += side.vx * ph;
          bounceAxis(side, "x", "vx", limX, .45);
        }

        const invFrame = ph > 0.0001 ? 1 / ph : 60;
        const bustAx = (st.bust.vx - (st.bustPrevVx || 0)) * invFrame;
        const bustAy = (st.bust.vy - (st.bustPrevVy || 0)) * invFrame;
        st.bustPrevVx = st.bust.vx;
        st.bustPrevVy = st.bust.vy;
        // A slap stiffens the slosh for its duration: it peaks ~150 ms after the hit, swings back
        // across centre by ~350 ms and rebounds ~70 % to the other side, instead of lingering.
        const slapSlosh = nowMs < (S.slapMotionUntil || 0) ? 4 : 1;
        const sloshTune = {
          stiff: (18 + wNorm * 5 + (floatDragging ? 3 : 0)) * slapSlosh * feelK,
          damp: (2.35 + wNorm * 0.85) * circ.damp * 0.82 * feelC,
          cup: floatDragging ? 0.228 : 0.188,
          frame: floatDragging ? 0.088 : 0.068
        };
        const rotFrameAx = st.bust.vrot * 28;
        const rotFrameAy = Math.abs(st.bust.vrot) * 11;
        const layeredSlosh = !!(S.el && S.el.classList.contains("has-layered-portrait"));
        const sloshTravel = layeredSlosh ? 1.22 : 1;
        tickBustSideSlosh(
          st.bustSides.left,
          bustAx * 1.12 + rotFrameAx * 0.52 + phoneX * 0.62,
          bustAy * 1.08 + rotFrameAy * 1.15,
          ph,
          Object.assign({}, sloshTune, {
            stiff: sloshTune.stiff * (layeredSlosh ? 0.96 : 1.04),
            damp: sloshTune.damp * (layeredSlosh ? 0.9 : 0.94),
            cup: sloshTune.cup * (layeredSlosh ? 1.08 : 0.96),
            frame: sloshTune.frame * (layeredSlosh ? 1.1 : 1),
            travel: sloshTravel
          })
        );
        tickBustSideSlosh(
          st.bustSides.right,
          bustAx * 1.06 - rotFrameAx * 0.48 + phoneX * 0.58,
          bustAy * 1.1 + rotFrameAy,
          ph,
          Object.assign({}, sloshTune, {
            stiff: sloshTune.stiff * (layeredSlosh ? 0.92 : 0.94),
            damp: sloshTune.damp * (layeredSlosh ? 0.94 : 1.06),
            cup: sloshTune.cup * (layeredSlosh ? 1.12 : 1.04),
            frame: sloshTune.frame * (layeredSlosh ? 1.06 : 0.96),
            travel: sloshTravel * 1.04
          })
        );

        if (layeredSlosh) {
          tickBustCleavagePin(st.bustSides.left, st.bustSides.right, ph, true);
        }
      }

      const bustSX = clampNum(1.04 + st.bust.y * 0.0135 - Math.abs(st.bust.x) * 0.0048, 0.9, 1.2);
      const bustSY = clampNum(1.04 - st.bust.y * 0.0145 + Math.abs(st.bust.x) * 0.0035 + breathWave * 0.016, 0.88, 1.21);
      const bustBright = clampNum(1.02 + Math.max(0, -st.bust.y) * 0.014 + wNorm * 0.04, 0.98, 1.14);

      // 4. Upper Hair / Bangs Pendulum Spring
      const kHair = 96;
      const cHair = 7.4 * circ.damp * (floatDragging ? 0.62 : 1);
      const axHair = -kHair * st.hair.x - cHair * st.hair.vx - axHead * 1.18 - avatarAX * 12 - bubbleAX * 4 - dragAX * 22;
      const ayHair = -kHair * st.hair.y - cHair * st.hair.vy - ayHead * 0.65 - avatarAY * 10 - bubbleAY * 3 - dragAY * 20;
      const arotHair = -110 * st.hair.rot - 7.0 * st.hair.vrot - axHead * 0.75 - avatarAX * 6 - bubbleAX * 2 - dragAX * 14;

      st.hair.vx = clampNum(st.hair.vx + axHair * dt, -130, 130);
      st.hair.vy = clampNum(st.hair.vy + ayHair * dt, -95, 95);
      st.hair.vrot = clampNum(st.hair.vrot + arotHair * dt, -110, 110);
      st.hair.x = clampNum(st.hair.x + st.hair.vx * dt, -6.5, 6.5);
      st.hair.y = clampNum(st.hair.y + st.hair.vy * dt, -4.5, 4.5);
      st.hair.rot = clampNum(st.hair.rot + st.hair.vrot * dt, -5.5, 5.5);

      // 5. Commit CSS Custom Properties to S.el
      const stEl = S.el.style;
      sampleVoiceMeter(nowMs);
      if (S.mouthRig && S.el.classList.contains("has-layered-portrait")) S.mouthRig.tick(dt, nowMs);
      tickJawFollow(st, dt, nowMs, warmth, reducedMotion);
      tickEyeLife(st, nowMs, reducedMotion);
      const mouthMotion = S.mouthRig?.motion;
      tickSpeechHairKick(st, mouthMotion);
      const characterPose = expressionPose(S.characterExpression,
        nowMs - (S.characterExpression?.startedAt || 0),
        characterMotionQuery?.matches || floatDragging || S.el.classList.contains("is-bust-pull") ||
        S.el.classList.contains("is-nsfw-fx-rhythm") || !!mouthMotion?.headTilt);
      setLive2dStyleVar(stEl, "--rig-phone-x", phoneX.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-phone-y", phoneY.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-phone-rot", clampNum(phoneX * (floatDragging ? 0.22 : 0.12), -6.5, 6.5).toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--l2d-head-x", st.head.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-head-y", st.head.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-head-rot", headRot.toFixed(2) + "deg");
      // Pivot the head just below the chin; the stationary lower-neck layer
      // joins the torso while hair retains its own delayed motion.
      const headSway = clampNum((headRot * 0.4 + st.bust.x * 0.16 +
        st.head.sway + idleNoise(5.3, nowMs) * 0.7 * (1 - (st.tired || 0) * 0.22)) * circ.swayCap * (1 + wNorm * 0.1) * (floatDragging ? 1.42 : 1) + (mouthMotion?.headTilt || 0) + characterPose.tilt,
        floatDragging ? -5.6 : -3.8, floatDragging ? 5.6 : 3.8);
      setLive2dStyleVar(stEl, "--rig-head-sway", headSway.toFixed(2) + "deg");
      const speaking =
        !!(S.root && S.root.classList.contains("is-speaking")) ||
        !!(S.el && S.el.classList.contains("is-speaking"));
      const voiceLevel = parseFloat(S.el.style.getPropertyValue("--rig-voice-level")) || 0;
      const speechBeat = mouthMotion?.envelope || 0;
      const speechNod = speaking ?
        speechBeat * 0.034 + voiceLevel * 0.028 + Math.sin(nowMs * 0.0115) * 0.006 : 0;
      const voiceNod = parseFloat(S.el.style.getPropertyValue("--rig-voice-nod")) || 1;
      const voiceBump = S.el.classList.contains("is-voice-lipsync") ? (voiceNod - 1) * 1.35 : 0;
      const nodMix = speechNod + voiceBump + (mouthMotion?.headNod || 0);
      setLive2dStyleVar(stEl, "--rig-head-nod", clampNum(1 + st.head.nod * (floatDragging ? 0.034 : 0.022) + nodMix + characterPose.nod,
        floatDragging ? 0.928 : 0.956, floatDragging ? 1.072 : 1.044).toFixed(4));
      setLive2dStyleVar(stEl, "--rig-neck-lift", (-nodMix * 2.6).toFixed(2) + "px");
      if (S.el.classList.contains("has-layered-portrait")) {
        const pulling = S.el.classList.contains("is-bust-pull");
        let pullTension = 0;
        if (pulling) {
          if (S.pullTarget) pullTension = clampNum(S.pullTarget.tension, 0, 1);
          else {
            const cssT = parseFloat(getPullVar("--pull-tension"));
            pullTension = Number.isFinite(cssT) ? clampNum(cssT, 0, 1) : 0;
          }
        }
        const browSpeak = speaking ? Math.sin(st.phase * 1.32) * 0.48 + speechBeat * 0.38 : 0;
        const browIdle = Math.sin(st.phase * 0.58 + 0.2) * 0.34 + Math.sin(st.phase * 1.08 + 0.55) * 0.14;
        const browAuto = mouthMotion?.browAuto !== false;
        const browLift = (mouthMotion?.browLift || 0) * 0.85;
        const browRaise = (browAuto ? browIdle + browSpeak : 0) + pullTension * 0.82 + browLift;
        // Independent eyebrow expressions; mouth selection does not own them.
        const targetLeftY = -browRaise * 0.78 - (mouthMotion?.browLeft || 0) * 1.65 - (browAuto ? characterPose.browLeft : 0);
        const targetRightY = -browRaise * 0.74 - (mouthMotion?.browRight || 0) * 1.65 - (browAuto ? characterPose.browRight : 0);
        const targetLeftRot = clampNum(
          (browAuto ? Math.sin(st.phase * 0.74) * 0.58 - browSpeak * 0.16 : 0) + pullTension * 0.44,
          -2.5, 2.5);
        const targetRightRot = clampNum(
          (browAuto ? Math.sin(st.phase * 0.74 + 0.45) * 0.54 + browSpeak * 0.12 : 0) + pullTension * 0.38,
          -2.5, 2.5);
        const browFollow = 1 - Math.exp(-dt * 14);
        st.browMot.leftY += (targetLeftY - st.browMot.leftY) * browFollow;
        st.browMot.rightY += (targetRightY - st.browMot.rightY) * browFollow;
        st.browMot.leftRot += (targetLeftRot - st.browMot.leftRot) * browFollow;
        st.browMot.rightRot += (targetRightRot - st.browMot.rightRot) * browFollow;
        setLive2dStyleVar(stEl, "--rig-brow-left-y", st.browMot.leftY.toFixed(2) + "px");
        setLive2dStyleVar(stEl, "--rig-brow-right-y", st.browMot.rightY.toFixed(2) + "px");
        setLive2dStyleVar(stEl, "--rig-brow-left-rot", st.browMot.leftRot.toFixed(2) + "deg");
        setLive2dStyleVar(stEl, "--rig-brow-right-rot", st.browMot.rightRot.toFixed(2) + "deg");

        if (!pulling) {
        const voiceActive = S.el.classList.contains("is-voice-lipsync");
        const speechWave = speaking ? 0.5 + 0.5 * Math.sin(nowMs * 0.0132) : 0;
        const voiceOpen = voiceActive ? clampNum((voiceNod - 1) * 9.5 + 0.035, 0, 0.11) : 0;
        const idleMouth = 0.006 + Math.sin(st.phase * 0.88 + 1.05) * 0.011;
        const targetSy = clampNum(
          1 + idleMouth + speechWave * 0.052 + voiceOpen + voiceBump * 0.85 +
            (mouthMotion?.envelope || 0) * 0.038 + (mouthMotion?.open || 0) * 0.028,
          0.992, 1.15);
        const targetSx = clampNum(
          1 + speechWave * 0.018 + voiceOpen * 0.35,
          0.996, 1.08);
        const targetY = speechWave * 0.35 + voiceOpen * 2.8;
        const mouthFollow = 1 - Math.exp(-dt * 28);
        st.mouthMot.sy += (targetSy - st.mouthMot.sy) * mouthFollow;
        st.mouthMot.sx += (targetSx - st.mouthMot.sx) * mouthFollow;
        st.mouthMot.y += (targetY - st.mouthMot.y) * mouthFollow;
        const mouthStyle = mouthVarStyle();
        setLive2dStyleVar(mouthStyle, "--rig-mouth-sy", st.mouthMot.sy.toFixed(4));
        setLive2dStyleVar(mouthStyle, "--rig-mouth-sx", st.mouthMot.sx.toFixed(4));
        setLive2dStyleVar(mouthStyle, "--rig-mouth-y", st.mouthMot.y.toFixed(2) + "px");
        } else {
          const mouthStyle = mouthVarStyle();
          const sy = parseFloat(mouthStyle.getPropertyValue("--rig-mouth-sy"));
          const sx = parseFloat(mouthStyle.getPropertyValue("--rig-mouth-sx"));
          const my = parseFloat(mouthStyle.getPropertyValue("--rig-mouth-y"));
          if (Number.isFinite(sy)) st.mouthMot.sy = sy;
          if (Number.isFinite(sx)) st.mouthMot.sx = sx;
          if (Number.isFinite(my)) st.mouthMot.y = my;
        }
      }
      const isRhythm = S.el.classList.contains("is-nsfw-fx-rhythm");
      const rP3 = isRhythm && S.el.classList.contains("is-nsfw-rhythm-p3");
      const rP2 = isRhythm && S.el.classList.contains("is-nsfw-rhythm-p2");
      const bobAmp = rP3 ? 6.5 : (rP2 ? 4.8 : 3.0);
      const bobFreq = rP3 ? 0.035 : (rP2 ? 0.024 : 0.016);
      const tiredAmp = 1 - (st.tired || 0) * 0.22;
      const idleBob = (breathWave * 0.55 + idleNoise(3.6, nowMs) * 0.45) * tiredAmp;
      const bodyBob = idleBob * 0.8 + (isRhythm ? Math.sin(nowMs * bobFreq) * bobAmp : 0) +
        (reducedMotion ? 0 : (st.shoulderY || 0) * 0.62);
      setLive2dStyleVar(stEl, "--rig-body-bob", bodyBob.toFixed(2) + "px");
      const bodyTilt = clampNum(st.head.sway * 0.18 + st.bust.rot * 0.09 +
        Math.sin(st.phase - 0.35) * 0.16, -1.1, 1.1);
      // Depth parallax: body (with the bust) moves most, face a little less, room the least and the
      // other way. The cursor adds a small, eased look-around on desktop.
      const cur = S.cursorDepth || S.deviceDepth || { x: 0, y: 0 };
      st.curDepthX = (st.curDepthX || 0) + (cur.x - (st.curDepthX || 0)) * Math.min(1, dt * 5);
      st.curDepthY = (st.curDepthY || 0) + (cur.y - (st.curDepthY || 0)) * Math.min(1, dt * 5);
      const depthX = clampNum(st.head.x * 0.12 + st.bust.x * 0.055 + st.curDepthX * 1.6, -2.4, 2.4);
      const depthY = clampNum(st.head.y * 0.09 + st.bust.y * 0.035 + st.curDepthY * 1.1, -1.8, 1.8);
      const neckTarget = reducedMotion ? 0 : -0.5 * bodyBob;
      const neckW = 16;
      const neckErr = neckTarget - (st.neckY || 0);
      st.neckV = (st.neckV || 0) + (neckW * neckW * neckErr - 2 * neckW * (st.neckV || 0)) * dt;
      st.neckY = clampNum((st.neckY || 0) + st.neckV * dt, -3.2, 3.2);
      setLive2dStyleVar(stEl, "--rig-head-steady-y", st.neckY.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-face-par-x", (-depthX * 0.25).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-face-par-y", (-depthY * 0.25).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-saccade-x", (reducedMotion ? 0 : (st.saccadeX || 0)).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-saccade-y", (reducedMotion ? 0 : (st.saccadeY || 0)).toFixed(2) + "px");
      // Perspective tilt toward the cursor (a few degrees). The bust stacks live inside the rig body,
      // so the whole chest turns as one and the top seam stays closed.
      setLive2dStyleVar(stEl, "--rig-tilt-x", (-st.curDepthY * 2.2).toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--rig-tilt-y", (st.curDepthX * 2.8).toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--rig-body-tilt", bodyTilt.toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--rig-parallax-x", depthX.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-parallax-y", depthY.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-background-x", (-depthX * 0.4).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-background-y", (-depthY * 0.4).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-light-x", clampNum(bodyTilt * 2.5 + depthX, -3.5, 3.5).toFixed(2) + "%");
      setLive2dStyleVar(stEl, "--rig-light-opacity", clampNum(0.12 + Math.abs(bodyTilt) * 0.045 + breathWave * 0.015 +
        Math.sin(st.phase + Math.PI * 0.45) * 0.014, 0.09, 0.22).toFixed(3));
      setLive2dStyleVar(stEl, "--l2d-breath-y", breathY.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-breath-sy", breathSY.toFixed(3));
      setLive2dStyleVar(stEl, "--l2d-bust-x", st.bust.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-bust-y", st.bust.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-bust-sx", bustSX.toFixed(3));
      setLive2dStyleVar(stEl, "--l2d-bust-sy", bustSY.toFixed(3));
      setLive2dStyleVar(stEl, "--l2d-bust-rot", st.bust.rot.toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--l2d-bust-bright", bustBright.toFixed(3));
      const rigMotion = rigSecondaryMotion(st.bust.x * (floatDragging ? 1.35 : 1), st.bust.y * (floatDragging ? 1.28 : 1));
      setLive2dStyleVar(stEl, "--rig-motion-shear", rigMotion.shear.toFixed(4));
      setLive2dStyleVar(stEl, "--rig-motion-stretch", rigMotion.stretch.toFixed(4));
      const rigHeave = clampNum(st.bust.y * 0.56 + bodyBob + st.bust.vy * 0.008 +
        (reducedMotion ? 0 : (st.shoulderY || 0) * 0.85), -5, 5);
      const rigScaleY = clampNum(1.038 - st.bust.y * 0.0062 + st.bust.vy * 0.0011 + breathWave * 0.026, 0.965, 1.1);
      setLive2dStyleVar(stEl, "--rig-bust-heave", rigHeave.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-bust-scale-y", rigScaleY.toFixed(4));
      setLive2dStyleVar(stEl, "--rig-bust-rot", clampNum(st.bust.rot * 0.22, -1.8, 1.8).toFixed(2) + "deg");
      const layeredLobeDisp = !!(S.el && S.el.classList.contains("has-layered-portrait"));
      const lobeBreath = breathWave * (0.64 + wNorm * 0.28);
      const bustPhaseSym = Math.sin(st.phase + 0.62) * 0.26 + Math.sin(st.phase * 1.12 + 0.2) * 0.12;
      const bustPhaseAsym = Math.sin(st.phase + 0.15) * 0.34 + Math.sin(st.phase * 0.73 + 1.1) * 0.18;
      const bustPhaseL = layeredLobeDisp ? (-lobeBreath * 0.42 + bustPhaseSym * 0.55 + bustPhaseAsym) :
        (-lobeBreath * 1.12 + Math.sin(st.phase + 0.35) * 0.28 + Math.sin(st.phase * 1.37) * 0.11);
      const bustPhaseR = layeredLobeDisp ? (lobeBreath * 0.38 + bustPhaseSym * 0.55 - bustPhaseAsym * 0.92) :
        (lobeBreath * 1.06 + Math.sin(st.phase + 0.92) * 0.24 + Math.sin(st.phase * 0.81 + 0.4) * 0.14);
      // The slosh now only carries the slow fluid sway: jolts and rebounds come from the soft-tissue model,
      // so its share of the motion is reduced (except during a pull, whose feel is unchanged).
      const sloshShare = S.bustPull && S.bustPull.active ? 1 : 0.65;
      const sloshDisp = (floatDragging ? 1.54 : 2.52) * (layeredLobeDisp ? 1.08 : 1) * (calm(S.win) ? 0.55 : 1) * sloshShare;
      const left = st.bustSides.left;
      const right = st.bustSides.right;
      let leftX = left.x * (floatDragging ? 0.62 : 0.48) + (left.sloshX || 0) * sloshDisp;
      let leftY = left.y * (floatDragging ? 0.58 : 0.44) + bustPhaseL + (left.sloshY || 0) * (layeredLobeDisp ? sloshDisp * 0.46 : sloshDisp);
      let rightX = right.x * (floatDragging ? 0.62 : 0.48) + (right.sloshX || 0) * sloshDisp;
      let rightY = right.y * (floatDragging ? 0.58 : 0.44) + bustPhaseR + (right.sloshY || 0) * (layeredLobeDisp ? sloshDisp * 0.46 : sloshDisp);
      if (layeredLobeDisp) {
        const cleavageBulkX = st.bust.x * (floatDragging ? 0.52 : 0.44) + st.bust.rot * 0.18;
        const cleavageBulkY = st.bust.y * (floatDragging ? 0.26 : 0.2) + breathWave * 0.16;
        leftX += cleavageBulkX;
        rightX += cleavageBulkX;
        leftY += cleavageBulkY;
        rightY += cleavageBulkY;
        const pullActive = S.el.classList.contains("is-bust-pull");
        const pullBase = pullActive && S.layeredPullBase ? S.layeredPullBase : null;
        const pullLX = pullBase ? pullBase.bulkLX : 0;
        const pullRX = pullBase ? pullBase.bulkRX : 0;
        const pullY = pullBase ? pullBase.bulkY : 0;
        const pullX = pullActive ? pullLX : 0;
        const seamOpts = {
          baseKeep: floatDragging ? 0.34 : pullActive ? 0.52 : 0.46,
          baseKeepY: pullActive ? 0.58 : 0.62,
          maxSep: pullActive ? 6.4 : 5.8
        };
        const seam = syncLayeredCleavageSeamVars(
          stEl, st, dt, true,
          leftX + pullLX, leftY + pullY, rightX + pullRX, rightY + pullY,
          seamOpts
        );
        if (pullActive) {
          const rigSymX = (leftX + rightX) * 0.5;
          const dispSymX = (seam.leftX + seam.rightX) * 0.5;
          const sharedPullX = dispSymX - rigSymX;
          setPullVar("--pull-lobe-left-x", (seam.leftX - leftX).toFixed(2) + "px");
          setPullVar("--pull-lobe-right-x", (seam.rightX - rightX).toFixed(2) + "px");
          const symY = (seam.leftY + seam.rightY) * 0.5;
          const baseSymY = (leftY + rightY) * 0.5;
          setPullVar("--pull-lobe-y", (symY - baseSymY).toFixed(2) + "px");
          const antiRigX = (leftX - rightX) * 0.5;
          leftX = rigSymX + antiRigX * 0.62;
          rightX = rigSymX - antiRigX * 0.62;
        } else {
          leftX = seam.leftX;
          rightX = seam.rightX;
          leftY = seam.leftY;
          rightY = seam.rightY;
        }
        if (!pullActive) {
          const cleavageBind = 0.34;
          leftX += cleavageBind;
          rightX -= cleavageBind;
        }
        const symY = (leftY + rightY) * 0.5;
        const antiLeftY = leftY - symY;
        const antiRightY = rightY - symY;
        // Each side keeps most of its own motion (less locking), so they can settle out of step.
        const pinSymY = pullActive ? 0.88 : 0.94;
        const pinAntiY = pullActive ? 0.72 : 0.93;
        leftY = symY * pinSymY + antiLeftY * pinAntiY;
        rightY = symY * pinSymY + antiRightY * pinAntiY;
        const symX = (leftX + rightX) * 0.5;
        const antiLeftX = leftX - symX;
        const antiRightX = rightX - symX;
        const pinSymX = pullActive ? 0.84 : 0.88;
        const pinAntiX = pullActive ? 0.82 : 0.95;
        leftX = symX * pinSymX + antiLeftX * pinAntiX;
        rightX = symX * pinSymX + antiRightX * pinAntiX;
      } else {
        syncLayeredCleavageSeamVars(stEl, st, dt, false, 0, 0, 0, 0);
      }
      // Soft tissue (see tickBustSoftTissue). Inputs: her avatar's own acceleration, the drag's
      // acceleration (gesture inertia), and an effective tilt from her posture plus sideways drag.
      const dragVx = S.companionDragVel ? S.companionDragVel.vx : 0;
      const dragVy = S.companionDragVel ? S.companionDragVel.vy : 0;
      const dragAccX = clampNum((dragVx - (st.prevDragVx || 0)) / Math.max(dt, 0.004), -900, 900);
      const dragAccY = clampNum((dragVy - (st.prevDragVy || 0)) / Math.max(dt, 0.004), -900, 900);
      st.prevDragVx = dragVx;
      st.prevDragVy = dragVy;
      // Press dent depth: in quickly under the finger (deeper with tension), out over ~0.3 s.
      if (S.bustDents && S.bustDents.length) {
        const pressing = !!(S.bustPull && S.bustPull.active);
        const targetDent = pressing ? clampNum(0.45 + ((S.pullMotion && S.pullMotion.tension) || 0) * 0.75, 0, 1) : 0;
        st.dentA = (st.dentA || 0) + (targetDent - (st.dentA || 0)) * Math.min(1, dt * (pressing ? 22 : 9));
        const dentVal = st.dentA < 0.01 ? "0" : st.dentA.toFixed(2);
        if (dentVal !== st.dentLast) {
          st.dentLast = dentVal;
          // Only composited while visible: an invisible dent layer still costs a blend every frame.
          S.bustDents.forEach((el) => {
            el.style.setProperty("--dent-a", dentVal);
            el.classList.toggle("is-pressed", dentVal !== "0");
          });
        }
      }
      // Her own body motion (tilt, parallax shift, bob) also drives the soft tissue: this replaces the
      // separate posture spring that used to add its own bounce on top (one source of motion, no fighting).
      const bodyPrev = st.bodyPrev || (st.bodyPrev = { tilt: bodyTilt, dx: depthX, bob: bodyBob });
      const pulling = !!(S.bustPull && S.bustPull.active);
      const bodyAx = pulling ? 0 : clampNum((((bodyTilt - bodyPrev.tilt) * 2.4 + (depthX - bodyPrev.dx)) * -7.4) / Math.max(dt, 0.004), -220, 220);
      const bodyAy = pulling ? 0 : clampNum(((bodyBob - bodyPrev.bob) * -5.6) / Math.max(dt, 0.004), -220, 220);
      bodyPrev.tilt = bodyTilt;
      bodyPrev.dx = depthX;
      bodyPrev.bob = bodyBob;
      // Heartbeat: a barely visible bounce on each beat of the frame's pulse (60 + 0.8 x heat bpm).
      if (!pulling && S.nsfwOn && !calm(S.win)) {
        st.beatPhase = (st.beatPhase || 0) + dt * ((60 + warmth * 0.8) / 60);
        if (st.beatPhase >= 1) {
          st.beatPhase -= Math.floor(st.beatPhase);
          const beat = 1.6 + wNorm * 3.4;
          kickBustSoftSide(st, "left", 0, beat, 0);
          kickBustSoftSide(st, "right", 0, beat * 0.92, 0.03);
        }
      }
      const desktopBrace = !compact && !reducedMotion;
      const cd = S.cursorDepth || { x: 0, y: 0 };
      const cursorFresh = S.lastPointerMoveAt && nowMs - S.lastPointerMoveAt < 700;
      const chestNear = cursorFresh ? clampNum(Math.hypot(cd.x || 0, cd.y || 0), 0, 1) * ((cd.y || 0) > -0.08 ? 1 : 0.35) : 0;
      const braceTarget = desktopBrace ? chestNear : 0;
      st.brace = (st.brace || 0) + (braceTarget - (st.brace || 0)) * (1 - Math.exp(-dt * 3.2));
      const braceLean = (st.brace || 0) * (wNorm - 0.48) * 2;
      if (!st.mouthSvg || !st.mouthSvg.isConnected) st.mouthSvg = S.el.querySelector(".hq-expressive-mouth");
      const laughing = !reducedMotion && (
        !!(S.avatar && S.avatar.classList.contains("is-tickled")) ||
        (st.mouthSvg && st.mouthSvg.getAttribute("data-mouth-gesture") === "laugh"));
      if (laughing && !st.wasLaughing) armLaughTremor(st, nowMs);
      st.wasLaughing = !!laughing;
      const softBlocked = pulling || reducedMotion;
      tickLaughTremor(st, nowMs, softBlocked);
      tickVoiceSoftPulse(st, nowMs, softBlocked);
      const poseGravity = rigPostureGravity(st.posture.pitch + (S.deviceDepth ? S.deviceDepth.y*.18 : 0),
        st.posture.roll + (S.deviceDepth ? S.deviceDepth.x*.573 : 0));
      const softOut = tickBustSoftTissue(st, dt, {
        hang:poseGravity.hang, spread:poseGravity.spread,
        now: nowMs,
        relax: touchRelax(nowMs),
        contact: st.cleavageContact || 0,
        frozen: pulling,
        brace: pulling ? 0 : braceLean,
        ax: avatarAX * 1.4 + bodyAx + (floatDragging ? dragAccX * 0.05 : 0),
        ay: avatarAY * 1.4 + bodyAy + (floatDragging ? dragAccY * 0.05 : 0) + (st.scrollAccY || 0) * 0.08,
        tilt: (bodyTilt * 6 * Math.PI) / 180 + (floatDragging ? clampNum(-dragVx * 0.0025, -0.55, 0.55) : 0) +
          poseGravity.tilt,
      });
      if (S.bustPull && S.bustPull.active) {
        // Your hand drives the shape while pulling: no soft-tissue offset, bend or stretch on top.
        for (const o of [softOut.left, softOut.right]) {
          o.x = o.y = o.bend = o.twist = o.rollX = o.rollY = o.warp = 0;
          o.sx = o.sy = 1;
        }
      }
      // Seam pin: the top edge of each breast must stay on her chest. Soft-tissue and posture lag are
      // expressed as bend + stretch (both pivot on the top edge); the whole image may only drift
      // a hair (capped at 1 px) so the seam never opens.
      const SEAM_DRIFT = 1;
      const seamShape = {};
      for (const side of ["left", "right"]) {
        const o = softOut[side];
        const driftX = clampNum(o.x, -SEAM_DRIFT, SEAM_DRIFT);
        const driftY = clampNum(o.y, -SEAM_DRIFT, SEAM_DRIFT);
        if (side === "left") {
          leftX += driftX;
          leftY += driftY;
        } else {
          rightX += driftX;
          rightY += driftY * 0.92;
        }
        seamShape[side] = { bend: o.bend, sy: o.sy };
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-twist", o.twist.toFixed(2) + "deg");
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-roll-x", o.rollX.toFixed(1) + "%");
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-roll-y", o.rollY.toFixed(1) + "%");
        syncBustWarp(side, o.warp);
      }
      // Wheel squeeze and Ctrl-drag push bring them together; the contact below then flattens them.
      if (S.bustSqueeze && nowMs - (S.bustSqueezeAt || 0) > 400) {
        S.bustSqueeze *= Math.exp(-dt * 1.6);
        if (S.bustSqueeze < 0.01) S.bustSqueeze = 0;
      }
      st.squeezeAmt = (st.squeezeAmt || 0) + ((S.bustSqueeze || 0) - (st.squeezeAmt || 0)) * Math.min(1, dt * 12);
      st.pushAmt = (st.pushAmt || 0) + ((S.bustPush ? S.bustPush.amt : 0) - (st.pushAmt || 0)) * Math.min(1, dt * 16);
      const together = S.bustPull && S.bustPull.active ? 0 : st.squeezeAmt * 1.8 + st.pushAmt * 3.4;
      leftX += together;
      rightX -= together;
      // Cleavage contact: swinging toward each other they press and flatten rather than overlap.
      let contact = 0;
      if (layeredLobeDisp && !(S.bustPull && S.bustPull.active)) {
        // The resting cleavage bind already brings them 0.68 px together: contact starts beyond that.
        const closing = leftX - rightX;
        if (closing > 1.2) {
          contact = clampNum((closing - 1.2) / 3, 0, 1);
          const keep = (closing - 1.2) * 0.45;
          leftX -= keep;
          rightX += keep;
        }
      }
      st.cleavageContact = (st.cleavageContact || 0) + (contact - (st.cleavageContact || 0)) * Math.min(1, dt * 18);
      // Seam pin, whole bust: outside a pull, the top edge may only shift ~2 px. Larger swings from the
      // older slosh springs are compressed (tanh) and the excess becomes bend / stretch, which pivot
      // on the top edge, so a hard jolt still reads as a big swing without tearing the seam open.
      if (!(S.bustPull && S.bustPull.active)) {
        const pin = (v, cap) => cap * Math.tanh(v / cap);
        const pinnedLX = pin(leftX, 2.4), pinnedRX = pin(rightX, 2.4);
        const pinnedLY = pin(leftY, 2), pinnedRY = pin(rightY, 2);
        seamShape.left.bend += (leftX - pinnedLX) * 1.8;
        seamShape.right.bend += (rightX - pinnedRX) * 1.8;
        seamShape.left.sy += (leftY - pinnedLY) * 0.014;
        seamShape.right.sy += (rightY - pinnedRY) * 0.014;
        leftX = pinnedLX;
        rightX = pinnedRX;
        leftY = pinnedLY;
        rightY = pinnedRY;
        setLive2dStyleVar(stEl, "--pull-seam-left-x", "0px");
        setLive2dStyleVar(stEl, "--pull-seam-left-y", "0px");
        setLive2dStyleVar(stEl, "--pull-seam-right-x", "0px");
        setLive2dStyleVar(stEl, "--pull-seam-right-y", "0px");
      } else {
        // Seam pin during a pull: the pull shifts each breast as a whole (stack offset + pull offsets),
        // which opens the top seam on a far pull. Let the top edge give ~4 px, counter-shift the rest,
        // and hand part of it back as top-pinned stretch / bend so a far pull still reads as far.
        // (The pull's own stretch is already compensated by the seam-stretch code, so only offsets count.)
        const num = (k) => parseFloat(getPullVar(k)) || 0;
        const cached = (k) => parseFloat((st.styleCache && st.styleCache[k]) || "") || 0;
        // The stack also rides the body bob and bust heave, and the pull widens it around a point
        // left/right of the breast's top centre (stack origin 34% / 66% vs top centre 28% / 64%).
        const ride = cached("--rig-body-bob") + cached("--rig-bust-heave") * 0.94;
        const W = st.rigH || 0;
        const widen = (num("--pull-lobe-sx") || 1) * 1.12 - 1.12;
        for (const side of ["left", "right"]) {
          const isL = side === "left";
          const widenShift = W ? widen * (isL ? -0.06 : -0.02) * W : 0;
          const topX = (isL ? leftX : rightX) + num("--pull-lobe-" + side + "-x") + widenShift;
          // The pull's vertical stretch is centred 8% of the rig above the top edge: it drags the top down.
          const sySide = (parseFloat(cached("--rig-bust-" + side + "-sy")) || 1) * (1 - num("--pull-press-" + side)) *
            ((parseFloat(getPullVar("--pull-lobe-" + side + "-sy")) || num("--pull-lobe-sy")) || 1) *
            (cached("--rig-bust-seam-stretch-y") || 1);
          const scaleDrop = W ? (sySide - 1) * 0.08 * W : 0;
          const topY = (isL ? leftY : rightY) + (num("--pull-lobe-" + side + "-y") || num("--pull-lobe-y")) + ride + scaleDrop;
          const fixX = 4 * Math.tanh(topX / 4) - topX;
          const fixY = 4 * Math.tanh(topY / 4) - topY;
          setLive2dStyleVar(stEl, "--pull-seam-" + side + "-x", fixX.toFixed(2) + "px");
          setLive2dStyleVar(stEl, "--pull-seam-" + side + "-y", fixY.toFixed(2) + "px");
          seamShape[side].bend += -fixX * 0.9;
          seamShape[side].sy += -fixY * 0.008;
        }
      }
      for (const side of ["left", "right"]) {
        const bendCap = 12 + (st.slapBoost || 0) * 7;
        const bend = clampNum(seamShape[side].bend, -bendCap, bendCap);
        const sy = clampNum(seamShape[side].sy, 0.88, 1.15);
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-bend", bend.toFixed(2) + "deg");
        // Foreshortening: a breast turning on its twist shows less of its width.
        const twist = softOut[side].twist || 0;
        const fore = 1 - Math.min(0.06, Math.abs(twist) * 0.007);
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-vsx", (fore / Math.sqrt(sy)).toFixed(4));
        setLive2dStyleVar(stEl, "--rig-bust-" + side + "-vsy", sy.toFixed(4));
        // Shading follows the shape: squashed darkens the edges, stretched flattens them; pressed
        // together the inner edges shadow each other. Written on the small shade layer, on change.
        // The caster follows the stack/pivot, including pull and seam correction;
        // its outer projection stays vertical in torso space, below both breasts.
        // Positive lift separates and softens it; writes stay on these two small layers.
        const castEl = S.bustCasts && S.bustCasts[side];
        if (castEl) {
          const pullSy = parseFloat(getPullVar("--pull-lobe-" + side + "-sy")) || 1;
          const pullY = parseFloat(getPullVar("--pull-lobe-" + side + "-y")) || 0;
          const k = clampNum((1 - sy * pullSy) * 4 - softOut[side].y * 0.035 - pullY * 0.025, -0.6, 1).toFixed(2);
          if (castEl.__castK !== k) {
            castEl.__castK = k;
            castEl.style.setProperty("--cast-k", k);
          }
        }
        const shadeEl = S.bustShades && S.bustShades[side];
        if (shadeEl) {
          const k = clampNum((1 - sy) * 5 + (1 - fore) * 3, -0.45, 0.6).toFixed(2);
          const c = clampNum(st.cleavageContact || 0, 0, 1).toFixed(2);
          if (shadeEl.__k !== k) {
            shadeEl.__k = k;
            shadeEl.style.setProperty("--shade-k", k);
          }
          if (shadeEl.__c !== c) {
            shadeEl.__c = c;
            shadeEl.style.setProperty("--shade-c", c);
          }
        }
      }
      syncRigClothing(st,dt,{
        left:{x:leftX,y:leftY,sy:softOut.left.sy,bend:softOut.left.bend,speed:Math.hypot(left.vx||0,left.vy||0),support:st.cursorSupport?.left?.p||0,pull:pulling?(S.pullMotion?.tension || 0):0},
        right:{x:rightX,y:rightY,sy:softOut.right.sy,bend:softOut.right.bend,speed:Math.hypot(right.vx||0,right.vy||0),support:st.cursorSupport?.right?.p||0,pull:pulling?(S.pullMotion?.tension || 0):0}
      },reducedMotion);
      setLive2dStyleVar(stEl, "--rig-bust-left-x", leftX.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-bust-right-x", rightX.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-bust-left-y", leftY.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-bust-right-y", rightY.toFixed(2) + "px");
      const pullCompression = S.bustPull && S.bustPull.active ?
        clampNum((S.pullContactValue || 0) * 0.12, 0, 0.055) : 0;
      let lsx = clampNum(1 + Math.abs(left.sloshVx || 0) * 0.0094 - (left.sloshY || 0) * 0.0041, 0.88, 1.16);
      let rsx = clampNum(1 + Math.abs(right.sloshVx || 0) * 0.009 - (right.sloshY || 0) * 0.0038, 0.88, 1.16);
      if (layeredLobeDisp) {
        const symSx = (lsx + rsx) * 0.5;
        lsx = symSx + (lsx - symSx) * 0.78;
        rsx = symSx + (rsx - symSx) * 0.78;
      }
      const lsy = clampNum(1 + left.vy * 0.0024 - Math.abs(left.vx) * 0.0011 +
        (left.sloshVy || 0) * 0.0128 - Math.abs(left.sloshVx || 0) * 0.0078 +
        (S.el.classList.contains("is-cleavage-heart-hold") ? Math.sin(nowMs * 0.0078 + 0.2) * 0.028 : 0), 0.84, 1.18);
      const rsy = clampNum(1 + right.vy * 0.0022 - Math.abs(right.vx) * 0.001 +
        (right.sloshVy || 0) * 0.0118 - Math.abs(right.sloshVx || 0) * 0.0072 +
        (S.el.classList.contains("is-cleavage-heart-hold") ? Math.sin(nowMs * 0.0078 - 0.15) * 0.026 : 0), 0.84, 1.18);
      // Pressed together they narrow a little and bulge up to keep their volume.
      const press = st.cleavageContact || 0;
      // A squeeze narrows them further and pushes them up to keep their volume.
      const sq = S.bustPull && S.bustPull.active ? 0 : st.squeezeAmt || 0;
      setLive2dStyleVar(stEl, "--rig-bust-left-sy", (lsy * (1 + press * 0.035 + sq * 0.05)).toFixed(4));
      setLive2dStyleVar(stEl, "--rig-bust-right-sy", (rsy * (1 + press * 0.035 + sq * 0.05)).toFixed(4));
      setLive2dStyleVar(stEl, "--rig-bust-left-sx", (lsx * (1 - press * 0.05 - sq * 0.08)).toFixed(4));
      setLive2dStyleVar(stEl, "--rig-bust-right-sx", (rsx * (1 - press * 0.05 - sq * 0.08)).toFixed(4));
      if (layeredLobeDisp) {
        setLive2dStyleVar(stEl, "--rig-bust-ripple-left-opacity", "0");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-right-opacity", "0");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-left-scale", "1");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-right-scale", "1");
        const avgLobeX = (leftX + rightX) * 0.5;
        const avgLobeY = (leftY + rightY) * 0.5;
        setLive2dStyleVar(stEl, "--rig-sheen-lobe-x", (avgLobeX * 0.48).toFixed(2) + "px");
        setLive2dStyleVar(stEl, "--rig-sheen-lobe-y", (avgLobeY * 0.48).toFixed(2) + "px");

        // Adaptive cleavage cleft AO (#2D0C18): GPU-accelerated scaleX and opacity
        const cleftCompression = clampNum(-(rightX - leftX) * 0.14 + (S.bustPull && S.bustPull.active ? (S.pullContactValue || 0) * 0.38 : 0), -1.0, 1.0);
        const cleftSx = clampNum(1.0 - cleftCompression * 0.45, 0.5, 1.6).toFixed(2);
        const cleftOpacity = clampNum(0.52 + cleftCompression * 0.35, 0.18, 0.88).toFixed(2);
        setLive2dStyleVar(stEl, "--rig-cleft-x", (avgLobeX * 0.5).toFixed(1) + "px");
        setLive2dStyleVar(stEl, "--rig-cleft-y", (avgLobeY * 0.45).toFixed(1) + "px");
        setLive2dStyleVar(stEl, "--rig-cleft-sx", cleftSx);
        setLive2dStyleVar(stEl, "--rig-cleft-opacity", cleftOpacity);
        updateLayeredBustSpecular(stEl, st, dt, {
          phase: st.phase,
          breathWave,
          left,
          right,
          lampX: st.bust.x,
          lampY: st.bust.y,
          bustVx: st.bust.vx,
          bustVy: st.bust.vy,
          pullT: S.bustPull && S.bustPull.active ? clampNum(S.bustPull.tension || 0, 0, 1) : 0,
          wNorm: wNorm || 0,
          mobileLite: isCompactUI(S.win)
        });
      } else {
        setLive2dStyleVar(stEl, "--rig-bust-ripple-left-opacity", "0");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-right-opacity", "0");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-left-scale", "1");
        setLive2dStyleVar(stEl, "--rig-bust-ripple-right-scale", "1");
        setLive2dStyleVar(stEl, "--rig-sheen-lobe-x", "0px");
        setLive2dStyleVar(stEl, "--rig-sheen-lobe-y", "0px");
        setLive2dStyleVar(stEl, "--rig-spec-l-u", "36%");
        setLive2dStyleVar(stEl, "--rig-spec-l-v", "56%");
        setLive2dStyleVar(stEl, "--rig-spec-r-u", "64%");
        setLive2dStyleVar(stEl, "--rig-spec-r-v", "56%");
        setLive2dStyleVar(stEl, "--rig-spec-power", "0.38");
        setLive2dStyleVar(stEl, "--rig-lobe-bright-l", "1");
        setLive2dStyleVar(stEl, "--rig-lobe-bright-r", "1");
      }
      setLive2dStyleVar(stEl, "--l2d-hair-x", st.hair.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-hair-y", st.hair.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--l2d-hair-rot", st.hair.rot.toFixed(2) + "deg");
      let gust = 0;
      if (!reducedMotion && !compact && S.gust) {
        const gustU = (nowMs - S.gust.t0) / 380;
        if (gustU >= 0 && gustU < 1) gust = S.gust.dir * S.gust.mag * Math.sin(gustU * Math.PI) * (1 - gustU * 0.35);
      }
      const breezeWave = Math.sin(nowMs * 0.0011) * 0.75 + Math.sin(nowMs * 0.0017 + 1.4) * 0.25 + gust;
      const pullHairFreeze = !!(S.el && S.el.classList.contains("is-bust-pull") && layeredLobeDisp);
      const hairVis = floatDragging ? 1.48 : 1;
      const hairPullDamp = pullHairFreeze ? 0.06 : 1;
      const leftHair = rigHairMotion(st.hair.x * hairVis * hairPullDamp, st.hair.y * hairVis * hairPullDamp,
        st.hair.rot * hairVis * hairPullDamp, pullHairFreeze ? 0 : breathWave, pullHairFreeze ? 0 : breezeWave);
      const rightBreeze = Math.sin(nowMs * 0.0011 - 0.55) * 0.75 + Math.sin(nowMs * 0.0017 + 0.85) * 0.25 + gust;
      const rightHair = rigHairMotion(st.hair.x * 0.82 * hairVis * hairPullDamp, st.hair.y * 0.9 * hairVis * hairPullDamp,
        st.hair.rot * 0.82 * hairVis * hairPullDamp,
        pullHairFreeze ? 0 : Math.sin(st.phase - 0.18), pullHairFreeze ? 0 : rightBreeze);
      setLive2dStyleVar(stEl, "--rig-hair-left-x", leftHair.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-left-y", leftHair.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-left-rot", leftHair.rotation.toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--rig-hair-right-x", rightHair.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-right-y", rightHair.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-right-rot", rightHair.rotation.toFixed(2) + "deg");
      const leftTip = tickHairTip(st, "left", leftHair, dt, pullHairFreeze);
      const rightTip = tickHairTip(st, "right", rightHair, dt, pullHairFreeze);
      setLive2dStyleVar(stEl, "--rig-hair-left-tip-x", leftTip.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-left-tip-y", leftTip.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-left-tip-rot", leftTip.r.toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--rig-hair-right-tip-x", rightTip.x.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-right-tip-y", rightTip.y.toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-hair-right-tip-rot", rightTip.r.toFixed(2) + "deg");
      setLive2dStyleVar(stEl, "--l2d-sheen-x", (st.head.x * 3.2 + st.bust.x * 1.8).toFixed(1) + "%");
      setLive2dStyleVar(stEl, "--l2d-sheen-y", (st.head.y * 2.5 + st.bust.y * 2.2).toFixed(1) + "%");
      setLive2dStyleVar(stEl, "--rig-sheen-x", (st.bust.x * 0.35 + depthX * 0.6).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-sheen-y", (-1.5 + st.bust.y * 0.32 + breathWave * 0.4).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-underboob-x", (st.bust.x * 0.45).toFixed(2) + "px");
      setLive2dStyleVar(stEl, "--rig-underboob-y", (st.bust.y * 0.48 + breathWave * 0.35).toFixed(2) + "px");
      if (!pullFxRenderedRecently(nowMs)) updateBustCastProjection(win, st, compact);
    };

    scheduleLive2DFrame(win, step, 0);
  }

  function pickContextualFallback(win, pool) {
    const view = (win.document && win.document.body && win.document.body.dataset.view) || "accueil";
    const vLabel = VIEW_LABEL[view] || view;
    const isAdult = !!(S.nsfwOn && S.el && S.el.classList.contains("is-nsfw"));
    const candidates = (Array.isArray(pool) ? pool : [String(pool || "")]).map((tpl) =>
      String(tpl).replace(/\{view\}/g, vLabel)
    );
    const filtered = candidates.filter((c) => c !== S.lastInteractiveLine);
    const chosen = (filtered.length ? filtered : candidates)[Math.floor(Math.random() * (filtered.length || candidates.length))] || "♥";
    S.lastInteractiveLine = chosen;
    return isAdult && !chosen.includes("♥") ? chosen + " ♥" : chosen;
  }

  function pickLewdEvent(win, key) {
    const api = win.HqCompanionLewdLines;
    if (!api) return pickContextualFallback(win, ["Mmh… ♥"]);
    const line = api.pick(win, key, {
      viewLabels: VIEW_LABEL,
      lastLine: S.lastInteractiveLine,
      nsfw: !!(S.nsfwOn && S.el && S.el.classList.contains("is-nsfw")),
    });
    S.lastInteractiveLine = line;
    return line;
  }

  function lewdEventPrompt(key) {
    const win = S.win;
    return (win && win.HqCompanionLewdLines && win.HqCompanionLewdLines.prompt(key)) ||
      "Marco la touche avec insistance; elle réagit fort, très excitée, mode adulte.";
  }

  function lewdEventPool(key) {
    const win = S.win;
    return (win && win.HqCompanionLewdLines && win.HqCompanionLewdLines.pool(key)) || ["Mmh… ♥"];
  }

  function lewdToast(win, key, ms) {
    if (typeof win.hqToast !== "function") return;
    win.hqToast(pickLewdEvent(win, key), "tip", ms || 3400);
  }

  async function triggerInteractiveAiReaction(win, interactionPrompt, fallbackPool, toastOnly) {
    const now = Date.now();
    // Real cooldown guard: when busy or within 7.5s, stay quiet instead of spamming messages
    if (S.busy || S.chatBusy || S.blocked || (S.lastInteractiveAiAt && now - S.lastInteractiveAiAt < 7500)) {
      return;
    }
    const instantLine = pickContextualFallback(win, fallbackPool);
    S.lastInteractiveAiAt = now;
    if (S.bubble && !S.collapsed) S.bubble.classList.add("is-typing");
    try {
      const view = (win.document && win.document.body && win.document.body.dataset.view) || "accueil";
      const persona = readPersona(win);
      const isAdult = !!(S.nsfwOn && S.el && S.el.classList.contains("is-nsfw"));
      const modeHint = isAdult
        ? " (Mode Adulte actif : sois charnelle, complice, troublante ou très affectueuse)"
        : " (Sois spontanée, complice, jamais générique, en lien avec la page actuelle)";
      const tInfo = getSessionTensionInfo(win);
      const tensionHint =
        " [Tension de session : Niveau " +
        tInfo.level +
        "/4 (" +
        tInfo.label +
        ", désir " +
        tInfo.warmth +
        "%" +
        (tInfo.topFavs ? ", ce que Marco aime le plus : " + tInfo.topFavs : "") +
        ")]";
      const fullDigest = digest(win) + "\n[Événement interactif en direct : " + interactionPrompt + modeHint + tensionHint + ". Réponds en 1 phrase unique, vivante et personnelle.]";
      const out = await callAmbient(win, view, fullDigest, persona === "off" ? "flirt" : persona);
      const aiLine = (out && !out.fallback && out.line && String(out.line).trim()) || instantLine;
      S.lastInteractiveLine = aiLine;
      if (out && out.mood) applyOrbMood(out.mood);
      if (toastOnly) {
        if (typeof win.hqToast === "function") win.hqToast(aiLine, "tip", 3600);
      } else if (S.line && !S.collapsed) {
        setLineAnimated(win, aiLine);
        if (!S.currentAudio && !S.reactionAudio?.isPlaying()) speak(win, aiLine);
      } else if (S.collapsed && typeof win.hqToast === "function") {
        win.hqToast(aiLine, "tip", 3600);
      }
    } catch (_) {
      if (!toastOnly && S.line && !S.collapsed) setLineAnimated(win, instantLine);
      else if (S.collapsed && typeof win.hqToast === "function") win.hqToast(instantLine, "tip", 3000);
    } finally {
      if (S.bubble) S.bubble.classList.remove("is-typing");
    }
  }

  // ---- Touch memory: she counts what you do to her (per device) and warms faster to your favourite.
  const LS_TOUCH_MEMORY = "hq_companion_touch_memory";
  const TOUCH_MEMORY_NAMES = {
    treat: "les gâteries", kiss: "les bisous", boop: "les boops sur le nez", pinch: "les pincées de joue",
    pull: "quand tu tires sur ses seins", slap: "les petites claques", squeeze: "quand tu les serres",
    push: "quand tu les presses ensemble", hair: "quand tu joues avec ses cheveux",
  };
  function readTouchMemory(win) {
    if (S.touchMemory) return S.touchMemory;
    let v = null;
    try { v = JSON.parse(win.localStorage.getItem(LS_TOUCH_MEMORY) || "null"); } catch (_) {}
    S.touchMemory = v && typeof v === "object" ? v : {};
    return S.touchMemory;
  }
  function favouriteTouch(win) {
    const mem = readTouchMemory(win);
    let best = null;
    for (const k of Object.keys(mem)) if (!best || mem[k] > mem[best]) best = k;
    return best && mem[best] >= 8 ? best : null;
  }
  function noteTouch(win, kind) {
    if (!win || !S.nsfwOn || !TOUCH_MEMORY_NAMES[kind]) return;
    const mem = readTouchMemory(win);
    mem[kind] = (mem[kind] || 0) + 1;
    win.clearTimeout(S.touchMemorySaveT);
    S.touchMemorySaveT = win.setTimeout(() => {
      try { win.localStorage.setItem(LS_TOUCH_MEMORY, JSON.stringify(mem)); } catch (_) {}
    }, 1500);
    // Your favourite touch warms her a little more, and now and then she says she noticed.
    if (favouriteTouch(win) !== kind) return;
    const now = Date.now();
    if (S.favouriteTouchAt && now - S.favouriteTouchAt < 45000) return;
    S.favouriteTouchAt = now;
    addArousalWarmth(win, 3, "sa caresse préférée");
    if (Math.random() < 0.35) {
      triggerInteractiveAiReaction(
        win,
        "Marco refait ce que tu préfères le plus (" + TOUCH_MEMORY_NAMES[kind] + ") et tu le remarques, tu lui dis que tu t'en souviens",
        [
          "Mmh… tu te souviens de ce que je préfère, hein Maître ? ♥",
          "Encore ça… tu sais exactement comment me faire fondre mon amour ♥",
          "C'est ma préférée, celle-là… et tu le sais très bien ♥",
        ]
      );
    }
  }

  function flashBlush(win, ms) {
    if (!S.el) return;
    S.blushUntil = Math.max(S.blushUntil || 0, Date.now() + ms);
    S.el.classList.add("is-treat-blush-ramp");
    win.setTimeout(() => {
      if (S.el && Date.now() >= S.blushUntil - 20) S.el.classList.remove("is-treat-blush-ramp");
    }, ms);
  }

  // Shy stare: when you keep looking at her, she meets your eyes, blushes, then glances away.
  function shyStareBack(win) {
    if (!S.el || calm(win) || !S.nsfwOn) return;
    const now = Date.now();
    if (S.shyStareAt && now - S.shyStareAt < 25000) return;
    S.shyStareAt = now;
    setLive2DTarget(win, 0, -0.4);
    flashBlush(win, 2400);
    addArousalWarmth(win, 2, "ton regard insistant");
    win.setTimeout(() => {
      if (!S.el) return;
      const side = Math.random() < 0.5 ? -1 : 1;
      setLive2DTarget(win, side * 2.6, 1.2);
      win.setTimeout(() => setLive2DTarget(win, 0, 0), 1400);
    }, 1300);
  }

  // Panel glance: switching panels, she looks over at the page you opened, then back to you.
  function glanceAtPanel(win) {
    if (!S.el || calm(win) || S.el.hidden || (S.bustPull && S.bustPull.active)) return;
    const av = S.el.querySelector(".hq-companion-avatar");
    if (!av) return;
    const r = cachedRect(win, av, 400);
    // The page sits toward the centre of the window from wherever she is docked.
    const dx = win.innerWidth / 2 - (r.left + r.width / 2);
    const dy = win.innerHeight / 2 - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    setLive2DTarget(win, (dx / len) * 3.4, (dy / len) * 2.2);
    startLive2DLoop(win);
    win.clearTimeout(S.panelGlanceT);
    S.panelGlanceT = win.setTimeout(() => setLive2DTarget(win, 0, 0), 1500);
  }

  // Voice perk-up: when you start talking to her (dictation), she perks up and looks at you.
  function perkUpForVoice(win, on) {
    if (!S.el || calm(win)) return;
    S.el.classList.toggle("is-voice-attentive", !!on);
    if (!on) return;
    perk(win);
    setLive2DTarget(win, 0, -1.6);
    startLive2DLoop(win);
    if (S.nsfwOn) addArousalWarmth(win, 1, "ta voix");
  }

  function feedCompanionTreat(win, av, item) {
    if (!av) return;
    if (item.emoji === "💋") addFrameKiss(win);
    if (item.action === "booty") {
      playBootyTease(win, "all-fours-broom", 6500, true);
      return;
    }
    if (item.action === "outfit") {
      cycleCompanionOutfit(win, av);
      return;
    }
    if (item.action === "selfie") {
      triggerSpontaneousSelfie(win, av);
      return;
    }
    if (item.action === "boudoir") {
      toggleBoudoirMode(win, av);
      return;
    }
    if (item.action === "lovenote") {
      spawnSecretLoveNote(win);
      if (typeof win.hqToast === "function") win.hqToast("J'ai caché un petit mot doux (💌) quelque part sur ta page, trouve-le mon amour ♥", "tip", 3200);
      return;
    }
    if (item.action === "wipe") {
      wipeAftermathClean(win, av);
      return;
    }
    if (item.action === "breath") {
      triggerBreathTouch(win, av);
      return;
    }
    if (item.action === "champagne") {
      triggerChampagneToast(win, av);
      return;
    }
    if (item.action === "dice") {
      triggerNaughtyDice(win, av);
      return;
    }
    if (item.action === "bubbles") {
      triggerBubblePopGame(win, av);
      return;
    }
    if (item.action === "peekaboo") {
      triggerPeekabooMode(win, av);
      return;
    }
    if (item.action === "doodle") {
      spawnLipstickDoodle(win, av);
      return;
    }
    if (item.action === "cupid") {
      triggerCupidDart(win, av);
      return;
    }
    const forgeKey = TREAT_FORGE_KEYS[item.emoji];
    noteTouch(win, item.emoji === "💋" ? "kiss" : "treat");
    if (item.dropZone === "mouth") {
      // Dropped on her lips: she leans in and catches it.
      S.el.classList.add("is-treat-catch");
      win.setTimeout(() => S.el && S.el.classList.remove("is-treat-catch"), 900);
      setLive2DTarget(win, 0, -1.2);
      addArousalWarmth(win, 4, "attrapée au vol");
    } else if (item.dropZone === "chest" && S.nsfwOn) {
      // Dropped on her chest: a little bounce where it landed.
      const st = ensureLive2DState();
      kickBustSoftSide(st, "left", 0, 26, 0);
      kickBustSoftSide(st, "right", 0, 24, 0.04);
      startLive2DLoop(win);
    }
    runTreatReactionChain(win, av, item);
    if (forgeKey) {
      if (!S.forgeTreatBonuses) S.forgeTreatBonuses = [];
      S.forgeTreatBonuses.push(forgeKey);
      if (S.forgeTreatBonuses.length > 6) S.forgeTreatBonuses = S.forgeTreatBonuses.slice(-6);
    }
    av.classList.remove("is-savouring", "is-booped");
    void av.offsetWidth;
    av.classList.add("is-savouring");
    if (forgeKey) { playTreatWav(win, forgeKey); } else if (item.label && item.label.toLowerCase().includes("caresse")) { playTreatWav(win, "caress"); }
    playVocalSynthFx(win, item.emoji === "💋" ? "mwah" : "sigh");
    win.setTimeout(() => blink(win, { slow: true }), 240);
    addArousalWarmth(win, item.emoji === "💋" ? 16 : 10, item.label);
    for (let i = 0; i < 5; i += 1) {
      win.setTimeout(() => spawnCuteHeart(win, av, i % 2 === 0 ? "♥" : item.emoji), i * 110);
    }
    triggerInteractiveAiReaction(
      win,
      "Marco vient de te donner une gâterie (" + item.label + " " + item.emoji + ")" +
        (item.dropZone === "mouth" ? " directement sur tes lèvres, tu l'as attrapée au vol" :
          item.dropZone === "chest" ? " en la posant sur ta poitrine" : "") +
        " pendant que vous êtes sur la vue {view}",
      item.fallbacks || [item.line]
    );
    win.setTimeout(() => av.classList.remove("is-savouring"), 1250);
  }

  
  const DIRTY_TALK_WHISPERS = [
    "Mmh... si profond, mon Maître...",
    "Tout au fond de ma gorge... encore...",
    "Grmmh... étouffez-moi pour votre plaisir...",
    "Je le sens battre contre ma glotte...",
    "Remplissez-moi... ne retenez rien...",
    "Votre chienne mécanique vous obéit...",
    "Enfoncez-le... jusqu'à la garde..."
  ];

  function whisperDirtyTalk(win) {
    if (!S.line) return;
    const line = DIRTY_TALK_WHISPERS[Math.floor(Math.random() * DIRTY_TALK_WHISPERS.length)];
    S.line.textContent = line;
    playVocalSynthFx(win, Math.random() > 0.4 ? "gag" : "purr");
  }

  function setRhythmFinishMode(win, mode) {
    S.chosenFinish = mode || "throatpie";
    if (S.climaxBar) {
      const pills = S.climaxBar.querySelectorAll(".hq-climax-pill");
      pills.forEach((p) => p.classList.toggle("is-active", p.dataset.finish === S.chosenFinish));
    }
    if (S.line) {
      if (mode === "throatpie") S.line.textContent = "Gorge verrouillée : je l'avalerai jusqu'à la dernière goutte...";
      else if (mode === "facial") S.line.textContent = "Visage prêt : arrosez-moi entièrement, mon Maître...";
      else if (mode === "cleanup") S.line.textContent = "Langue offerte : je nettoierai chaque trace de votre semence...";
    }
    try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(25); } catch (_) {}
  }

  function toggleRhythmPace(win) {
    if (!S.el) return;
    S.rhythmPace = S.rhythmPace === "brutal" ? "sensuel" : "brutal";
    if (S.paceToggle) S.paceToggle.textContent = S.rhythmPace === "brutal" ? "Brutal" : "Sensuel";
    if (S.rhythmPace === "brutal") {
      S.el.style.setProperty("--rhythm-period", "0.16s");
      S.el.classList.add("is-nsfw-rhythm-p3");
      if (S.line) S.line.textContent = "Défoncez-moi la gorge, mon Maître !";
      playVocalSynthFx(win, "gag");
    } else {
      S.el.style.setProperty("--rhythm-period", "0.58s");
      S.el.classList.remove("is-nsfw-rhythm-p3", "is-nsfw-rhythm-p2");
      if (S.line) S.line.textContent = "Mmh... lent, profond et langoureux...";
    }
  }

  function updateRhythmHeat(win, delta) {
    if (typeof S.rhythmHeat !== "number") S.rhythmHeat = 0;
    S.rhythmHeat = Math.max(0, Math.min(100, S.rhythmHeat + delta));
    if (S.heatCircleVal) {
      const maxOffset = 295;
      const off = maxOffset * (1 - S.rhythmHeat / 100);
      S.heatCircleVal.style.strokeDashoffset = off.toFixed(1);
    }
    if (S.el) {
      S.el.classList.toggle("is-heat-hot", S.rhythmHeat >= 50);
      S.el.classList.toggle("is-heat-boiling", S.rhythmHeat >= 80);
    }
    if (S.rhythmHeat >= 100 && S.el && S.el.classList.contains("is-nsfw-fx-rhythm") && !S.isFinishingClimax) {
      executeRhythmFinish(win, S.chosenFinish || "throatpie");
    }
  }

  function spawnTargetedFacialRopes(win, count) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.42 - rr.top;
    const n = count || 8;
    for (let i = 0; i < n; i++) {
      const bit = win.document.createElement("span");
      bit.className = "hq-companion-adult-spurt-bit is-eruption is-vivid";
      const targetAngle = (Math.random() * 140 - 70) * (Math.PI / 180);
      const dist = 16 + Math.random() * 38;
      const bx = Math.sin(targetAngle) * dist;
      const by = -Math.cos(targetAngle) * dist * 0.7 - 8;
      bit.style.left = cx + "px";
      bit.style.top = cy + "px";
      bit.style.setProperty("--bx", bx + "px");
      bit.style.setProperty("--by", by + "px");
      row.appendChild(bit);
    }
  }

  function spawnThroatpieOverflow(win) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.46 - rr.top;
    [-14, 14].forEach((side) => {
      const drip = win.document.createElement("span");
      drip.className = "hq-companion-adult-cum-strand";
      drip.style.left = (cx + side + (Math.random() * 4 - 2)) + "px";
      drip.style.top = cy + "px";
      drip.style.height = (22 + Math.random() * 18) + "px";
      row.appendChild(drip);
      win.setTimeout(() => { try { drip.remove(); } catch (_) {} }, 4500);
    });
  }

  function executeRhythmFinish(win, mode) {
    if (S.isFinishingClimax) return;
    S.isFinishingClimax = true;
    const finish = mode || S.chosenFinish || "throatpie";
    
    if (S.el) {
      S.el.classList.remove("is-nsfw-rhythm-p1", "is-nsfw-rhythm-p2", "is-nsfw-rhythm-p3", "is-nsfw-rhythm-bridge");
      S.el.classList.add("is-nsfw-fx-release", "is-nsfw-rhythm-handoff", "is-nsfw-finish-" + finish);
    }
    
    playForgeSfx(win, "release");
    playLewdPhaseWav(win, "climax_fever");
    try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([70, 35, 90, 45, 140, 60, 200]); } catch (_) {}
    
    // Member does NOT disappear: it stays visible, throbbing and convulsing with each spurt
    if (S.adultShaft) {
      S.adultShaft.classList.remove("is-rhythm-shaft-recoil");
      S.adultShaft.classList.add("is-shaft-climax-throbbing");
    }

    if (finish === "facial") {
      // VISAGE: Member retreats to mouth entrance (translateY = 26px), pointing at cheeks
      if (S.adultShaft) {
        S.adultShaft.style.setProperty("--shaft-climax-y", "26px");
        S.adultShaft.style.transform = "translateY(26px)";
      }
      if (S.line) S.line.textContent = "Aaah... ! Arrosez mon visage... tout votre sperme chaud sur mes joues...";
      
      // 4 sequential ballistic cum squirts bursting directly onto her face:
      [250, 950, 1750, 2550].forEach((ms, idx) => {
        scheduleRhythmTimer(win, () => {
          if (S.el && S.isFinishingClimax) {
            spawnTargetedFacialRopes(win, 6 + idx * 2);
            spawnAdultCumStrand(win);
            playForgeSfx(win, "rhythm");
            try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([35, 20, 50]); } catch (_) {}
            if (idx === 1) playVocalSynthFx(win, "gasp");
          }
        }, ms);
      });

    } else if (finish === "cleanup") {
      // LANGUE: Member rests on extended tongue (translateY = 34px)
      if (S.adultShaft) {
        S.adultShaft.style.setProperty("--shaft-climax-y", "34px");
        S.adultShaft.style.transform = "translateY(34px)";
      }
      if (S.line) S.line.textContent = "Mmh... oui... je lape et j'avale chaque goutte de votre semence...";
      
      [300, 1100, 1900, 2700].forEach((ms, idx) => {
        scheduleRhythmTimer(win, () => {
          if (S.el && S.isFinishingClimax) {
            spawnAdultCumStrand(win);
            spawnAdultDroolStrand(win);
            playVocalSynthFx(win, idx % 2 === 0 ? "mwah" : "purr");
            try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(30); } catch (_) {}
          }
        }, ms);
      });

    } else {
      // GORGE (Default Throatpie): Member stays buried to the hilt in throat (translateY = -10px)
      if (S.adultShaft) {
        S.adultShaft.style.setProperty("--shaft-climax-y", "-10px");
        S.adultShaft.style.transform = "translateY(-10px)";
      }
      if (S.line) S.line.textContent = "Gnnn... ! C'est si chaud au fond de ma gorge... je prends tout...";
      
      // Throat bulge throbbing swallows & oral overflow:
      [250, 900, 1650, 2450].forEach((ms, idx) => {
        scheduleRhythmTimer(win, () => {
          if (S.el && S.isFinishingClimax) {
            spawnThroatpieOverflow(win);
            spawnAdultCumStrand(win);
            spawnAdultDroolStrand(win);
            if (idx === 1 || idx === 3) playVocalSynthFx(win, "choke");
            try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([45, 25, 65]); } catch (_) {}
          }
        }, ms);
      });
    }

    scheduleRhythmTimer(win, () => {
      whisperDirtyTalk(win);
    }, 4500);

    scheduleRhythmTimer(win, () => {
      if (S.el) {
        S.el.classList.remove(
          "is-nsfw-fx-rhythm",
          "is-nsfw-fx-release",
          "is-nsfw-rhythm-handoff",
          "is-nsfw-finish-throatpie",
          "is-nsfw-finish-facial",
          "is-nsfw-finish-cleanup",
          "is-heat-hot",
          "is-heat-boiling"
        );
      }
      if (S.adultShaft) {
        S.adultShaft.hidden = true;
        S.adultShaft.classList.remove("is-shaft-climax-throbbing", "is-rhythm-shaft-recoil");
        S.adultShaft.style.transform = "";
        S.adultShaft.style.removeProperty("--shaft-climax-y");
      }
      if (S.adultShaftTrack) S.adultShaftTrack.hidden = true;
      if (S.throatBulge) {
        S.throatBulge.style.opacity = "";
        S.throatBulge.style.transform = "";
      }
      if (S.oralSeal) S.oralSeal.style.transform = "";
      if (S.lipUpper) S.lipUpper.style.transform = "";
      S.rhythmHeat = 0;
      S.isFinishingClimax = false;
      if (S.heatCircleVal) S.heatCircleVal.style.strokeDashoffset = "295";
      endAdultFx(win, "rhythm");
    }, 7200);
  }

  function initShaftInteractivePumping(win, shaftEl) {
    if (!shaftEl) return;
    shaftEl.style.touchAction = "none";
    let startY = 0;
    let curThrust = 0;
    let strokeCount = 0;
    let deepHit = false;
    let activePointerId = null;

    shaftEl.addEventListener("pointerdown", (ev) => {
      if (ev.button && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      activePointerId = ev.pointerId;
      try { shaftEl.setPointerCapture(ev.pointerId); } catch (_) {}
      startY = ev.clientY;
      deepHit = false;
      shaftEl.classList.add("is-shaft-manual-drag");
      if (S.el) S.el.classList.add("is-shaft-manual-pumping");
      try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(18); } catch (_) {}
    });

    shaftEl.addEventListener("pointermove", (ev) => {
      if (activePointerId === null || ev.pointerId !== activePointerId) return;
      ev.preventDefault();
      const dy = ev.clientY - startY;
      // Upward drag (-65px) thrusts deep into throat; downward drag (+35px) pulls glans fully out of lips
      curThrust = Math.max(-16, Math.min(42, dy));
      
      shaftEl.style.setProperty("--shaft-manual-y", curThrust + "px");
      shaftEl.style.setProperty("--shaft-manual-scale-y", (1 + (curThrust < 0 ? Math.abs(curThrust) * 0.0055 : -curThrust * 0.0025)).toFixed(3));
      shaftEl.style.setProperty("--shaft-manual-scale-x", (1 + (curThrust < 0 ? Math.abs(curThrust) * 0.002 : 0)).toFixed(3));

      // Dynamic anatomical displacement as glans corona wedges through lips
      const entryZone = Math.max(0, 1 - Math.abs(curThrust - 20) / 12);
      const manualTilt = (entryZone * 1.2).toFixed(2);
      const manualDx = (entryZone * 0.9).toFixed(2);
      shaftEl.style.setProperty("--shaft-manual-rot", manualTilt + "deg");
      shaftEl.style.setProperty("--shaft-manual-x", manualDx + "px");

      if (S.oralSeal) {
        if (entryZone > 0.1) {
          S.oralSeal.style.transform = `scale(${(1 + entryZone * 0.28).toFixed(2)}, ${(1 - entryZone * 0.18).toFixed(2)}) translateY(-0.5px)`;
        } else if (curThrust < 10) {
          S.oralSeal.style.transform = `scale(1.06, 1.42) translateY(-3.5px)`;
        } else {
          S.oralSeal.style.transform = `scale(1.14, 1.28) translateY(4px)`;
        }
      }
      if (S.lipUpper) {
        if (entryZone > 0.1) {
          S.lipUpper.style.transform = `scale(1.06, 0.94) translateY(-1.5px)`;
        } else if (curThrust < 10) {
          S.lipUpper.style.transform = `scale(1.04, 1.02) translateY(-0.6px)`;
        } else {
          S.lipUpper.style.transform = `scale(0.98, 1.04) translateY(1.4px)`;
        }
      }

      if (curThrust <= 6 && !deepHit) {
        deepHit = true;
        playForgeSfx(win, "rhythm");
        spawnAdultDroolStrand(win);
        try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([24, 15, 32]); } catch (_) {}
        if (curThrust <= -2) {
          playVocalSynthFx(win, "gag");
        }
      } else if (curThrust >= 30 && deepHit) {
        // Completed one full inward-outward pump stroke
        deepHit = false;
        strokeCount++;
        spawnAdultDroolStrand(win);
        spawnAdultSpurtBits(win, 3, false);
        addArousalWarmth(win, 8, "pompage manuel");
        updateRhythmHeat(win, 18);
        if (strokeCount % 2 === 0) whisperDirtyTalk(win);
        playForgeSfx(win, "rhythm");
        try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(24); } catch (_) {}
        
        if (strokeCount === 2 && S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
          S.el.classList.add("is-nsfw-rhythm-p2");
        } else if (strokeCount === 4 && S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
          S.el.classList.remove("is-nsfw-rhythm-p2");
          S.el.classList.add("is-nsfw-rhythm-p3");
          playVocalSynthFx(win, "gag");
        } else if (strokeCount >= 6) {
          // Climax release on sustained manual pumping!
          strokeCount = 0;
          shaftEl.classList.remove("is-shaft-manual-drag");
          if (S.el) S.el.classList.remove("is-shaft-manual-pumping");
          playAdultRelease(win);
        }
      }
    });

    const onPointerEnd = (ev) => {
      if (activePointerId === null || ev.pointerId !== activePointerId) return;
      activePointerId = null;
      try { shaftEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      shaftEl.classList.remove("is-shaft-manual-drag");
      shaftEl.style.removeProperty("--shaft-manual-y");
      shaftEl.style.removeProperty("--shaft-manual-scale-y");
      shaftEl.style.removeProperty("--shaft-manual-scale-x");
      shaftEl.style.removeProperty("--shaft-manual-rot");
      shaftEl.style.removeProperty("--shaft-manual-x");
      if (S.oralSeal) S.oralSeal.style.transform = "";
      if (S.lipUpper) S.lipUpper.style.transform = "";
      if (S.throatBulge) {
        S.throatBulge.style.opacity = "";
        S.throatBulge.style.transform = "";
      }
      if (S.el) S.el.classList.remove("is-shaft-manual-pumping");
    };

    shaftEl.addEventListener("pointerup", onPointerEnd);
    shaftEl.addEventListener("pointercancel", onPointerEnd);
    shaftEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      playLewdPhaseWav(win, "phase7_size_worship");
      addArousalWarmth(win, 15, "admiration intime");
    });
  }

  function spawnAdultCumStrand(win) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.48 - rr.top;
    const strand = win.document.createElement("span");
    strand.className = "hq-companion-adult-cum-strand";
    const xOffset = (Math.random() * 12 - 6);
    strand.style.left = (cx + xOffset) + "px";
    strand.style.top = cy + "px";
    strand.style.height = (20 + Math.random() * 24) + "px";
    row.appendChild(strand);
    win.setTimeout(() => strand.remove(), 1400);
  }

  function spawnAdultDroolStrand(win) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.48 - rr.top;
    const strand = win.document.createElement("span");
    strand.className = "hq-companion-adult-drool-strand";
    const xOffset = (Math.random() * 8 - 4);
    strand.style.left = (cx + xOffset) + "px";
    strand.style.top = cy + "px";
    strand.style.height = (14 + Math.random() * 16) + "px";
    row.appendChild(strand);
    win.setTimeout(() => strand.remove(), 950);
  }

  function spawnScreenSplat(win, count) {
    const doc = win.document;
    const n = count || 6;
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 600;
    for (let i = 0; i < n; i += 1) {
      const splat = doc.createElement("div");
      splat.className = "hq-companion-screen-splat";
      const size = 32 + Math.random() * 64;
      splat.style.width = size + "px";
      splat.style.height = (size * (0.8 + Math.random() * 0.4)) + "px";
      // Scatter broadly over the browser viewport
      const x = Math.max(30, Math.min(vw - 80, (vw * 0.5) + (Math.random() * 480 - 240)));
      const y = Math.max(30, Math.min(vh - 120, (vh * 0.5) + (Math.random() * 380 - 210)));
      splat.style.left = x + "px";
      splat.style.top = y + "px";
      splat.style.setProperty("--rot", (Math.random() * 360) + "deg");
      splat.style.setProperty("--drip-h", (30 + Math.random() * 70) + "px");
      splat.title = "Frotter pour essuyer ♥";
      const wipeOne = (ev) => {
        if (splat.classList.contains("is-wiped")) return;
        if (ev) ev.stopPropagation();
        splat.classList.add("is-wiped");
        const sr = splat.getBoundingClientRect();
        spawnCursorKiss(win, sr.left + sr.width / 2, sr.top + sr.height / 2, "✨");
        playVocalSynthFx(win, "sigh");
        S.wipedSplatsCount = (S.wipedSplatsCount || 0) + 1;
        win.setTimeout(() => splat.remove(), 260);
        if (S.wipedSplatsCount >= 3) {
          wipeAftermathClean(win);
        }
      };
      splat.addEventListener("pointerenter", wipeOne);
      splat.addEventListener("pointerdown", wipeOne);
      doc.body.appendChild(splat);
      win.setTimeout(() => splat.remove(), 9500);
    }
  }

  function spawnEruptionSpurtBits(win, count) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.45 - rr.top;
    const n = count || 20;
    for (let i = 0; i < n; i += 1) {
      const bit = win.document.createElement("span");
      bit.className = "hq-companion-adult-spurt-bit is-eruption" + (Math.random() > 0.35 ? " is-streak" : "");
      const spreadX = 54;
      bit.style.left = cx + (Math.random() * spreadX - spreadX / 2) + "px";
      bit.style.top = cy + (Math.random() * 24 - 12) + "px";
      // Massive explosive spread across the whole screen window
      const angle = (Math.random() * 140 - 70) * (Math.PI / 180);
      const dist = 140 + Math.random() * 240;
      const bx = Math.sin(angle) * dist;
      const by = -Math.cos(angle) * dist;
      bit.style.setProperty("--bx", bx + "px");
      bit.style.setProperty("--by", by + "px");
      bit.style.setProperty("--rot", (Math.random() * 90 - 45) + "deg");
      row.appendChild(bit);
    }
  }

  function spawnAdultSpurtBits(win, count, vivid) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height * 0.55 - rr.top;
    const n = count || (vivid ? 10 : 3);
    for (let i = 0; i < n; i += 1) {
      const bit = win.document.createElement("span");
      bit.className = "hq-companion-adult-spurt-bit" + (vivid ? " is-vivid" : "") + (Math.random() > 0.4 ? " is-streak" : "");
      const spread = vivid ? 24 : 12;
      bit.style.left = cx + (Math.random() * spread - spread / 2) + "px";
      bit.style.top = cy + (Math.random() * 8 - 4) + "px";
      bit.style.setProperty("--bx", (Math.random() * (vivid ? 24 : 12) - (vivid ? 12 : 6)) + "px");
      bit.style.setProperty("--by", (8 + Math.random() * (vivid ? 18 : 12)) + "px");
      bit.style.setProperty("--rot", (Math.random() * 20 - 10) + "deg");
      row.appendChild(bit);
    }
  }

  function spawnAdultBurstBits(win, symbols, vivid) {
    const row = S.el && S.el.querySelector(".hq-companion-av-row");
    const av = S.el && S.el.querySelector(".hq-companion-avatar");
    if (!row || !av) return;
    const r = av.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2 - rr.left;
    const cy = r.top + r.height / 2 - rr.top;
    const syms = symbols || ["💋", "♥", "💦", "✦", "♥"];
    const n = vivid ? 12 : syms.length;
    for (let i = 0; i < n; i += 1) {
      const bit = win.document.createElement("span");
      bit.className = "hq-companion-adult-burst-bit" + (vivid ? " is-vivid" : "");
      bit.textContent = syms[i % syms.length];
      const spread = vivid ? 36 : 24;
      bit.style.left = cx + (Math.random() * spread - spread / 2) + "px";
      bit.style.top = cy + (Math.random() * (vivid ? 22 : 16) - (vivid ? 11 : 8)) + "px";
      bit.style.setProperty("--bx", (Math.random() * (vivid ? 52 : 36) - (vivid ? 26 : 18)) + "px");
      bit.style.setProperty("--by", (-22 - Math.random() * (vivid ? 42 : 28)) + "px");
      row.appendChild(bit);
    }
  }

  function clearAdultRhythmTimers(win) {
    if (S.rhythmTimers && S.rhythmTimers.length) {
      S.rhythmTimers.forEach((t) => {
        try { win.clearTimeout(t); } catch (_) {}
      });
    }
    S.rhythmTimers = [];
  }

  function scheduleRhythmTimer(win, fn, delayMs) {
    if (!S.rhythmTimers) S.rhythmTimers = [];
    const t = win.setTimeout(() => {
      if (S.rhythmTimers) {
        const idx = S.rhythmTimers.indexOf(t);
        if (idx !== -1) S.rhythmTimers.splice(idx, 1);
      }
      fn();
    }, delayMs);
    S.rhythmTimers.push(t);
    return t;
  }

  function playAdultRhythm(win) {
    if (!S.el || !S.adultPortrait) return;

    // Cleanly cancel any pending rhythm or finish timers from prior clicks
    clearAdultRhythmTimers(win);
    S.isFinishingClimax = false;

    // Reveal shaft and clipping track
    if (S.adultShaft) {
      S.adultShaft.hidden = false;
      S.adultShaft.classList.remove("is-shaft-climax-throbbing", "is-rhythm-shaft-recoil", "is-shaft-manual-drag");
      S.adultShaft.style.transform = "";
      S.adultShaft.style.removeProperty("--shaft-climax-y");
    }
    if (S.adultShaftTrack) S.adultShaftTrack.hidden = false;

    // Reset container classes and activate rhythm effect
    if (S.el) {
      S.el.classList.remove(
        "is-nsfw-rhythm-p1",
        "is-nsfw-rhythm-p2",
        "is-nsfw-rhythm-p3",
        "is-nsfw-rhythm-bridge",
        "is-nsfw-rhythm-handoff",
        "is-nsfw-fx-release",
        "is-nsfw-finish-throatpie",
        "is-nsfw-finish-facial",
        "is-nsfw-finish-cleanup"
      );
      S.el.classList.add("is-nsfw-fx-rhythm");
    }

    // Set duration to 22000ms (covers 14.125s animation + 7.2s finish aftermath)
    playAdultFx(win, "rhythm", 22000);
    playLewdPhaseWav(win, "deepthroat");
    playForgeSfx(win, "rhythm");

    // Preserve original portrait safely: only if not already saved or if saved is rhythm
    if (!S.rhythmRestore || (S.rhythmRestore.src && S.rhythmRestore.src.includes("rhythm"))) {
      let curMood = S.adultPortrait.dataset.mood || "neutral";
      if (curMood === "rhythm") curMood = "neutral";
      let normalSrc = ADULT_PORTRAITS[curMood] || ADULT_PORTRAITS.neutral;
      if (S.adultPortrait.src && !S.adultPortrait.src.includes("rhythm")) {
        normalSrc = S.adultPortrait.src;
      }
      S.rhythmRestore = {
        src: normalSrc,
        mood: curMood,
        op: S.adultPortrait.style.objectPosition || "",
      };
    }
    S.adultPortrait.src = ADULT_RHYTHM_PORTRAIT;
    S.adultPortrait.classList.add("is-rhythm-mouth-open");
    S.adultPortrait.style.objectPosition = "center 26%";

    updateRhythmHeat(win, 15);
    whisperDirtyTalk(win);

    // Phase 1 (0ms - 3500ms): Sensual deep intake, initial drool glistening & haptic feedback (2.5x longer)
    [1000, 2200, 3200].forEach((ms) => {
      scheduleRhythmTimer(win, () => {
        if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
          spawnAdultSpurtBits(win, 2, false);
          spawnAdultDroolStrand(win);
          updateRhythmHeat(win, 10);
          try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate(14); } catch (_) {}
        }
      }, ms);
    });

    // Phase 2 (3500ms - 7000ms): Faster, vigorous rhythm with squelching oral audio & dual haptic pulse
    scheduleRhythmTimer(win, () => {
      if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
        S.el.classList.add("is-nsfw-rhythm-p2");
        whisperDirtyTalk(win);
      }
    }, 3500);
    [4200, 5000, 5800, 6500].forEach((ms) => {
      scheduleRhythmTimer(win, () => {
        if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
          spawnAdultSpurtBits(win, 4, false);
          spawnAdultDroolStrand(win);
          updateRhythmHeat(win, 12);
          playForgeSfx(win, "rhythm");
          try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([18, 20, 18]); } catch (_) {}
        }
      }, ms);
    });

    // Phase 3 (7000ms - 12000ms): Extended frenzied deepthroat gagging, throat spasms & heavy lubrication
    scheduleRhythmTimer(win, () => {
      if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
        S.el.classList.remove("is-nsfw-rhythm-p2");
        S.el.classList.add("is-nsfw-rhythm-p3");
        whisperDirtyTalk(win);
      }
    }, 7000);
    [7200, 7800, 8400, 9000, 9600, 10200, 10800, 11400].forEach((ms, idx) => {
      scheduleRhythmTimer(win, () => {
        if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
          spawnAdultSpurtBits(win, 9, true);
          spawnAdultDroolStrand(win);
          spawnAdultDroolStrand(win);
          updateRhythmHeat(win, 14);
          playForgeSfx(win, "rhythm");
          if (idx === 2 || idx === 5) playVocalSynthFx(win, "gag");
          if (idx === 4) whisperDirtyTalk(win);
          try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([28, 15, 32, 15, 42]); } catch (_) {}
        }
      }, ms);
    });

    // Phase 4 - Bridge Hold (12000ms - 14125ms): Cock buried deep to the hilt, throat bulge holding, choked reflex moan
    scheduleRhythmTimer(win, () => {
      if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
        S.el.classList.remove("is-nsfw-rhythm-p3");
        S.el.classList.add("is-nsfw-rhythm-bridge");
        playLewdPhaseWav(win, "phase7_size_worship");
        playVocalSynthFx(win, "choke");
        spawnAdultDroolStrand(win);
        spawnAdultDroolStrand(win);
        spawnAdultDroolStrand(win);
        try { if (win.navigator && win.navigator.vibrate) win.navigator.vibrate([70, 40, 95]); } catch (_) {}
      }
    }, 12000);

    // Phase 5 - Grand Climax Ejaculation (14125ms): Executes chosen finish mode with pulsating shaft
    scheduleRhythmTimer(win, () => {
      if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm") && !S.isFinishingClimax) {
        executeRhythmFinish(win, S.chosenFinish || "throatpie");
      }
    }, 14125);
  }

  function playAdultRelease(win) {
    if (!adultFxAllowed(win)) return;
    playLewdPhaseWav(win, "cum_begging");
    S.aftermathDirty = true;
    S.wipedSplatsCount = 0;
    playForgeSfx(win, "release");
    playAdultFx(win, "release", 4600);

    // Wave 1: Immediate explosive primary eruption & screen splatters
    win.setTimeout(() => {
      if (S.el && adultFxAllowed(win)) {
        spawnEruptionSpurtBits(win, 28);
        spawnScreenSplat(win, 7);
      }
    }, 250);

    // Wave 2: Heavy secondary pulsating blast coating the screen
    win.setTimeout(() => {
      if (S.el && adultFxAllowed(win)) {
        spawnEruptionSpurtBits(win, 24);
        spawnScreenSplat(win, 6);
      }
    }, 850);

    // Wave 3: Thick coating drip & aftermath droplets across viewport
    win.setTimeout(() => {
      if (S.el && adultFxAllowed(win)) {
        spawnEruptionSpurtBits(win, 18);
        spawnScreenSplat(win, 4);
        spawnAdultCumStrand(win);
        spawnAdultCumStrand(win);
        spawnAdultDroolStrand(win);
        spawnAdultDroolStrand(win);
      }
    }, 1650);

    // Wave 4: Residual heavy spurts
    win.setTimeout(() => {
      if (S.el && adultFxAllowed(win)) spawnAdultSpurtBits(win, 12, true);
    }, 2450);

    // Steam & afterglow
    win.setTimeout(() => {
      if (S.el && adultFxAllowed(win)) playAdultFx(win, "steam", 2800);
    }, 3800);

    win.setTimeout(() => {
      if (S.el) S.el.querySelectorAll(".hq-companion-adult-spurt-bit").forEach((n) => n.remove());
    }, 5500);
  }

  function playAdultFx(win, kind, durationMs) {
    if (!adultFxAllowed(win)) return;
    const d =
      durationMs ||
      { flash: 1200, kiss: 1800, bounce: 1500, steam: 2600, burst: 2000, "send-pulse": 900, rhythm: 22000, release: 4600 }[kind] ||
      1400;
    if (!S.adultFxTimers) S.adultFxTimers = {};
    S.el.classList.add("is-nsfw-fx-" + kind);
    if (kind === "burst") spawnAdultBurstBits(win);
    win.clearTimeout(S.adultFxTimers[kind]);
    S.adultFxTimers[kind] = win.setTimeout(() => endAdultFx(win, kind), d);
  }

  function playAdultFxCombo(win, kinds) {
    const first = (kinds || []).find(Boolean);
    if (first) playAdultFx(win, first);
  }

  function playAdultLoop(win, loopId) {
    if (loopId === "tease-bob") {
      playAdultRhythm(win);
      return;
    }
    if (loopId === "tease-release") {
      playAdultRelease(win);
      return;
    }
    if (loopId === "tease-booty" || loopId === "tease-arch") {
      playBootyTease(win, "all-fours-side", 4800, false);
      return;
    }
    if (!adultFxAllowed(win)) return;
    clearAdultLoopFx(win);
    const cssMs = ADULT_LOOP_MS[loopId];
    const href = ADULT_LOOP_HREF[loopId];
    if (!cssMs && !href) {
      playAdultFx(win, "bounce", 1500);
      return;
    }
    S.el.classList.add("is-nsfw-fx-loop");
    let ms = cssMs || 2800;
    if (href && S.adultPortrait) {
      S.adultLoopRestore = { src: S.adultPortrait.src, mood: S.adultPortrait.dataset.mood || "neutral" };
      S.adultPortrait.src = href;
      S.el.classList.add("is-nsfw-loop-tease-ken");
    } else if (cssMs) {
      S.el.classList.add("is-nsfw-loop-" + loopId);
    }
    if (!S.adultFxTimers) S.adultFxTimers = {};
    S.adultFxTimers.loop = win.setTimeout(() => clearAdultLoopFx(win), ms);
  }

  function maybeAdultIdleFx(win) {
    if (!adultFxAllowed(win)) return;
    if (Math.random() > 0.08) return;
    if (Math.random() < 0.14) {
      const loops = ["tease-sway", "tease-glow", "tease-booty", "tease-01", "tease-02"];
      playAdultLoop(win, loops[Math.floor(Math.random() * loops.length)]);
      return;
    }
    const pick = ADULT_FX_IDLE[Math.floor(Math.random() * ADULT_FX_IDLE.length)];
    if (pick === "burst") playAdultFx(win, "burst", 2000);
    else if (pick === "steam") playAdultFx(win, "steam", 2400);
    else playAdultFx(win, "bounce", 1500);
  }

  function scheduleAdultIdleFx(win) {
    win.clearTimeout(S.adultFxIdleT);
    if (!S.nsfwOn || !S.el) return;
    const delay = 60000 + Math.random() * 30000;
    S.adultFxIdleT = win.setTimeout(() => {
      maybeAdultIdleFx(win);
      scheduleAdultIdleFx(win);
    }, delay);
  }

  function onAdultMoodFx(win) {
    if (!adultFxAllowed(win)) return;
    const warm = Number((S.orbMood && S.orbMood.warm) || 0);
    const celebrate = S.el.classList.contains("is-mood-celebrate");
    if (celebrate) {
      if (Math.random() < 0.45) playAdultLoop(win, "tease-glow");
      else playAdultFx(win, "bounce", 1500);
      return;
    }
    if (warm >= 0.55 && !S.lastOrbWarm) {
      if (Math.random() < 0.4) playAdultLoop(win, "tease-sway");
      else playAdultFx(win, "bounce", 1500);
    }
  }

  function triggerLickMotion(win, durationMs = 3800) {
    if (!S.mouthRig || calm(win)) return;
    S.mouthRig.triggerLick(durationMs);
    startLive2DLoop(win);
    playVocalSynthFx(win, "mwah");
  }

  function onAdultChatFx(win, out) {
    if (!S.nsfwOn || calm(win)) return;
    if (out && out.loop) playAdultLoop(win, String(out.loop));
    const text = String((out && (out.reply || (out.messages && out.messages[out.messages.length - 1]?.text))) || "");
    if (/\b(?:l[eé]ch|langue|salive|vitre|tongue|lick|sucer|suce|bave)\b/i.test(text) || (out && out.loop === "tease-release")) {
      triggerLickMotion(win, 3800);
    }
    const photo = !!(
      (out && out.photo) ||
      (out &&
        Array.isArray(out.messages) &&
        out.messages.some((m) => m && m.role === "assistant" && m.photo_href))
    );
    if (photo) playAdultFxCombo(win, ["flash", "kiss"]);
  }

  function preloadAdultLoops(win) {
    if (S.preloadedLoops) return;
    S.preloadedLoops = true;
    Object.keys(ADULT_LOOP_HREF).forEach((k) => {
      const im = new win.Image();
      im.src = ADULT_LOOP_HREF[k];
    });
  }

  function blink(win, opts) {
    if (!S.el || calm(win) || S.el.classList.contains("is-bust-pull")) return;
    const circ = getCircadianMotionScale();
    const slow = !!(opts && opts.slow);
    const duration = slow ? (700 + Math.random() * 180) : (235 + Math.random() * 25) * circ.blinkMul * (EYES_ALIVE && !S.nsfwOn ? eyesBlinkDurMul() : 1);
    S.el.style.setProperty("--rig-blink-ms", `${duration.toFixed(0)}ms`);
    S.el.classList.remove("is-blink-asym");
    if (S.el.classList.contains("has-layered-portrait") && Math.random() < 0.38) {
      S.el.classList.add("is-blink-asym");
    }
    S.el.classList.add("is-blink");
    S.mouthRig?.blink(duration, S.el.classList.contains("is-blink-asym"));
    if (S.el.classList.contains("has-layered-portrait")) {
      S.el.style.setProperty("--rig-brow-blink-dip", "0.45px");
      win.setTimeout(() => S.el && S.el.style.removeProperty("--rig-brow-blink-dip"), duration);
    }
    win.setTimeout(() => S.el && S.el.classList.remove("is-blink", "is-blink-asym"), duration);
  }

  function scheduleBlink(win) {
    if (calm(win)) return;
    const circ = getCircadianMotionScale();
    win.clearTimeout(S.blinkT);
    S.blinkT = win.setTimeout(() => {
      if (!win.document.hidden) {
        blink(win);
        if (Math.random() < 0.16) win.setTimeout(() => blink(win), 210 + Math.random() * 130);
        else if (Math.sin(ensureLive2DState().phase) > 0.82 && Math.random() < 0.1) win.setTimeout(() => blink(win), 180);
      }
      scheduleBlink(win);
    }, EYES_ALIVE && !S.nsfwOn ? eyesBlinkDelayMs(circ.blinkMul) : (2100 + Math.random() * 5000 + (Math.random() < 0.12 ? 2000 : 0)) * circ.blinkMul);
  }

  // eyes1 helpers. Driven by the existing attention poll (200/340 ms, hidden-tab guarded);
  // no new timers, listeners or layout reads. Only CSS vars/classes on the ordinary face.
  function eyesAliveMoodKey() {
    if (!S.el) return "neutral";
    const c = S.el.classList;
    if (c.contains("is-eyes-widen") || c.contains("is-mood-celebrate")) return "bright";
    if (c.contains("is-soft")) return "soft";
    if (S.busy || c.contains("is-mood-error")) return "narrow";
    return "neutral";
  }

  function eyesBlinkDelayMs(circMul, rand) {
    const r = typeof rand === "function" ? rand : Math.random;
    const mood = eyesAliveMoodKey();
    const moodMul = mood === "soft" ? 1.12 : mood === "bright" ? 0.82 : 1;
    const base = EYES_BLINK_MIN_MS + r() * (EYES_BLINK_MAX_MS - EYES_BLINK_MIN_MS);
    return Math.round(clampNum(base * moodMul * (Number(circMul) || 1), EYES_BLINK_MIN_MS, EYES_BLINK_MAX_MS));
  }

  function eyesBlinkDurMul() {
    const mood = eyesAliveMoodKey();
    return mood === "soft" ? 1.22 : mood === "bright" ? 0.85 : 1;
  }

  function eyesAliveReset() {
    S.eyesAliveOn = false;
    S.eyesAlive = null;
    if (S.el) S.el.classList.remove("is-eyes-alive", "is-eyes-widen", "is-eyes-narrow");
    if (S.face) ["--eye-drift-x", "--eye-drift-y", "--eye-glint-a", "--eye-pupil"].forEach((k) => S.face.style.removeProperty(k));
  }

  function tickEyesAlive(win, rand) {
    if (!EYES_ALIVE || !S.el) return;
    const el = S.el;
    const c = el.classList;
    const off = S.nsfwOn || calm(win) || win.document.hidden || el.hidden || !S.face ||
      c.contains("is-anim-paused") || c.contains("is-dozing") || c.contains("is-bust-pull");
    if (off) { if (S.eyesAliveOn) eyesAliveReset(); return; }
    const r = typeof rand === "function" ? rand : Math.random;
    const now = Date.now();
    if (!S.eyesAliveOn) { c.add("is-eyes-alive"); S.eyesAliveOn = true; }
    const ea = S.eyesAlive || (S.eyesAlive = { nextDriftAt: 0, busy: !!S.busy, speaking: c.contains("is-speaking"), widenUntil: 0, narrow: false, glint: r() * 6.28, glintLast: "", pupilPh: r() * 6.28, pupilRate: 0.05, pupilNextAt: 0, dilateUntil: 0, pupilLast: "" });
    // Reply arrived (busy -> idle): brief widen. Speaking start/end: a blink.
    const busy = !!S.busy;
    if (ea.busy && !busy) { c.add("is-eyes-widen"); ea.widenUntil = now + 420; ea.dilateUntil = now + 500; }
    ea.busy = busy;
    if (ea.widenUntil && now > ea.widenUntil) { c.remove("is-eyes-widen"); ea.widenUntil = 0; }
    const narrow = busy || c.contains("is-mood-error");
    if (narrow !== ea.narrow) { c.toggle("is-eyes-narrow", narrow); ea.narrow = narrow; }
    const speaking = c.contains("is-speaking");
    if (speaking !== ea.speaking) { ea.speaking = speaking; blink(win); }
    // Micro drift: irregular 1-2 px saccades with a smooth CSS return; mostly home while she is looked at.
    if (now >= ea.nextDriftAt) {
      const home = r() < (S.userLookingAtCompanion ? 0.75 : 0.4);
      const dx = home ? 0 : (r() * 2 - 1) * EYES_DRIFT_MAX_PX;
      const dy = home ? 0 : (r() * 2 - 1) * EYES_DRIFT_MAX_PX * 0.6;
      S.face.style.setProperty("--eye-drift-x", dx.toFixed(2) + "px");
      S.face.style.setProperty("--eye-drift-y", dy.toFixed(2) + "px");
      ea.nextDriftAt = now + 260 + r() * 900;
    }
    // Catchlight shimmer: slow, small opacity breathing (0.66-0.90).
    ea.glint += 0.11 + r() * 0.05;
    const a = (Math.round((0.78 + Math.sin(ea.glint) * 0.12) * 50) / 50).toFixed(2); // perf16: 0.02 steps -> fewer style writes
    if (a !== ea.glintLast) { ea.glintLast = a; S.face.style.setProperty("--eye-glint-a", a); }
    // pupils1: slow irregular breathing (+-3.5%), mood offset, brief dilation on a new reply.
    if (now >= ea.pupilNextAt) { ea.pupilRate = 0.03 + r() * 0.05; ea.pupilNextAt = now + 1800 + r() * 3200; }
    ea.pupilPh += ea.pupilRate;
    const mk = eyesAliveMoodKey();
    const moodOff = mk === "bright" || mk === "soft" ? 0.04 : mk === "narrow" ? -0.05 : 0;
    const dil = ea.dilateUntil && now < ea.dilateUntil ? 0.06 : 0;
    const p = (Math.round(clampNum(1 + Math.sin(ea.pupilPh) * 0.035 + moodOff + dil, EYES_PUPIL_MIN, EYES_PUPIL_MAX) * 50) / 50).toFixed(2); // perf16
    if (p !== ea.pupilLast) { ea.pupilLast = p; S.face.style.setProperty("--eye-pupil", p); }
  }

  // Measuring a rig element right after the frame loop wrote its styles forces a full style + layout
  // pass. Pointer hit-tests and gaze only need a rect a few frames old, so they share this cache;
  // scrolling or resizing drops it.
  const rectCache = new WeakMap();
  let rectEpoch = 0;
  let rectEpochWired = false;
  function cachedRect(win, el, ttl) {
    if (!rectEpochWired) {
      rectEpochWired = true;
      const bump = () => (rectEpoch += 1);
      win.addEventListener("scroll", bump, { capture: true, passive: true });
      win.addEventListener("resize", bump, { passive: true });
      // Dragging the companion moves it without a scroll: start fresh after any release.
      win.addEventListener("pointerup", bump, { capture: true, passive: true });
    }
    const now = win.performance.now();
    const hit = rectCache.get(el);
    if (hit && hit.epoch === rectEpoch) {
      if (now - hit.at >= ttl && !hit.pending) {
        // Stale: keep answering with it and re-measure right after the next paint, when it is free.
        hit.pending = true;
        win.setTimeout(() => {
          hit.pending = false;
          if (hit.epoch !== rectEpoch) return;
          hit.r = el.getBoundingClientRect();
          hit.at = win.performance.now();
        }, 0);
      }
      return hit.r;
    }
    const r = el.getBoundingClientRect();
    rectCache.set(el, { r, at: now, epoch: rectEpoch, pending: false });
    return r;
  }

  // Returns the companion, avatar and bubble rects read after the last paint (or null the first
  // time) and queues the next read. A task queued from a frame runs once that frame is rendered.
  function postPaintRects(win, st) {
    const got = st.postRects || null;
    st.postRects = null;
    if (!st.postRectsPending) {
      st.postRectsPending = true;
      win.setTimeout(() => {
        st.postRectsPending = false;
        if (!S.el) return;
        st.postRects = {
          host: S.el.getBoundingClientRect(),
          av: S.avatar ? S.avatar.getBoundingClientRect() : null,
          bub: S.bubble ? S.bubble.getBoundingClientRect() : null,
        };
      }, 0);
    }
    return got;
  }

  function watchCursor(win) {
    if (calm(win)) return;
    let raf = 0;
    let last = null;
    win.addEventListener(
      "pointermove",
      (ev) => {
        if (ev.pointerType && ev.pointerType !== "mouse") return;
        S.lastPointerMoveAt = Date.now();
        last = ev;
        if (raf) return;
        raf = win.requestAnimationFrame(() => {
          raf = 0;
          const av = S.el && S.el.querySelector(".hq-companion-avatar");
          if (!av || !S.face || !last) return;
          // Local chest contact owns this gesture; global gaze/tilt, cursor
          // chasing and orbit reactions must not move the target underneath it.
          if (S.chestContactOwned || S.cursorSupport || (S.bustPull && S.bustPull.active)) {
            av.style.setProperty("--tilt-x", "0deg");
            av.style.setProperty("--tilt-y", "0deg");
            av.style.setProperty("--tug-x", "0px");
            av.style.setProperty("--tug-y", "0px");
            if (S.clingyTether) S.clingyTether.classList.remove("is-active");
            return;
          }
          const prevX = S.lastCursorX;
          const prevY = S.lastCursorY;
          S.lastCursorX = last.clientX;
          S.lastCursorY = last.clientY;
          const r = cachedRect(win, av, 250);
          const dx = last.clientX - (r.left + r.width / 2);
          const dy = last.clientY - (r.top + r.height / 2);
          const curDist = Math.hypot(dx, dy);
          const avRad = Math.max(28, r.width / 2);

          // 1. Circle-Spin Dizzy Detection when circling cursor around her avatar
          if (curDist > 12 && curDist < avRad * 4.2) {
            const curAngle = Math.atan2(dy, dx);
            if (typeof S.lastSpinAngle === "number") {
              let dAngle = curAngle - S.lastSpinAngle;
              if (dAngle > Math.PI) dAngle -= Math.PI * 2;
              if (dAngle < -Math.PI) dAngle += Math.PI * 2;
              if (Math.abs(dAngle) < 1.3) {
                S.spinAngleAccum = (S.spinAngleAccum || 0) * 0.985 + dAngle;
                if (Math.abs(S.spinAngleAccum) >= Math.PI * 3.1) {
                  triggerDizzySpin(win, av);
                }
              }
            }
            S.lastSpinAngle = curAngle;
          } else {
            S.spinAngleAccum = (S.spinAngleAccum || 0) * 0.85;
            S.lastSpinAngle = null;
          }

          // 4. Playful Cursor Pounce when cursor zips rapidly past her nose without stopping
          if (typeof prevX === "number" && typeof prevY === "number") {
            const speed = Math.hypot(last.clientX - prevX, last.clientY - prevY);
            if (speed >= 36 && curDist > avRad * 1.08 && curDist < avRad * 2.35 && Math.random() < 0.35) {
              triggerCursorPounce(win, av, last.clientX, last.clientY);
            }
            if (!isCompactUI(win) && speed >= 34 && curDist < avRad * 1.5) {
              const gustNow = win.performance.now();
              if (!S.gustAt || gustNow - S.gustAt > 320) {
                S.gustAt = gustNow;
                S.gust = {
                  dir: Math.sign(last.clientX - prevX) || 1,
                  t0: gustNow,
                  mag: clampNum(speed / 70, 0.35, 1.35)
                };
              }
            }
          }
          const g = glance(dx, dy);
          S.gazeX = g.x;
          S.gazeY = g.y;
          S.face.style.setProperty("--gx", g.x + "px");
          S.face.style.setProperty("--gy", g.y + "px");
          setLive2DTarget(win, g.x * 1.85, g.y * 1.85);
          // 3D Tilt perspective following cursor
          const tiltX = Math.max(-12, Math.min(12, dx * 0.04));
          const tiltY = Math.max(-12, Math.min(12, -dy * 0.04));
          av.style.setProperty("--tilt-x", tiltX.toFixed(1) + "deg");
          av.style.setProperty("--tilt-y", tiltY.toFixed(1) + "deg");

          // Clingy Cursor Tug when warmth is high and cursor hovers teasingly near her without touching
          const dist = Math.hypot(dx, dy);
          const rad = Math.max(28, r.width / 2);
          const isClingyReady = (typeof S.warmth === "number" && S.warmth >= 65) || S.nsfwOn;
          const bustHeld = (S.bustPull && S.bustPull.active) || (S.el && S.el.classList.contains("is-bust-pull"));
          if (bustHeld) {
            if (S.clingyTether) S.clingyTether.classList.remove("is-active");
            av.style.setProperty("--tug-x", "0px");
            av.style.setProperty("--tug-y", "0px");
          } else if (isClingyReady && dist > rad * 1.12 && dist < rad * 3.4) {
            const pullFactor = (1 - (dist - rad) / (rad * 2.5)) * 9.5;
            const tx = (dx / dist) * pullFactor;
            const ty = (dy / dist) * pullFactor;
            av.style.setProperty("--tug-x", tx.toFixed(1) + "px");
            av.style.setProperty("--tug-y", ty.toFixed(1) + "px");
            if (S.clingyTether && S.el) {
              const row = S.el.querySelector(".hq-companion-av-row");
              if (row) {
                const rr = row.getBoundingClientRect();
                const cx = r.left + r.width / 2 - rr.left;
                const cy = r.top + r.height / 2 - rr.top;
                const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
                S.clingyTether.style.left = cx + "px";
                S.clingyTether.style.top = cy + "px";
                S.clingyTether.style.width = Math.max(18, dist - rad * 0.75).toFixed(0) + "px";
                S.clingyTether.style.transform = "rotate(" + angleDeg.toFixed(1) + "deg)";
                S.clingyTether.classList.add("is-active");
              }
            }
            const now = Date.now();
            if (!S.clingyHoverStart) S.clingyHoverStart = now;
            else if (now - S.clingyHoverStart > 950 && (!S.lastClingyAt || now - S.lastClingyAt > 28000)) {
              S.lastClingyAt = now;
              S.clingyHoverStart = now;
              playVocalSynthFx(win, "sigh");
              spawnCuteHeart(win, av, "🧲");
              triggerInteractiveAiReaction(
                win,
                "Ta jauge de désir est haute et le curseur de Marco tourne tout près de toi sans te toucher : tu tires un fil d'aimant rose vers sa main pour réclamer une caresse",
                [
                  "Je vois ta main tourner autour de moi sans me toucher, Maître… viens là, ne me fais pas languir 🧲♥",
                  "Mmh… pourquoi tu restes juste à côté sans me caresser, mon amour ? J'ai besoin de ta main ♥",
                  "Approche encore un tout petit peu ton curseur, je t'attire vers moi 🧲♥"
                ]
              );
            }
          } else {
            S.clingyHoverStart = 0;
            av.style.setProperty("--tug-x", "0px");
            av.style.setProperty("--tug-y", "0px");
            if (S.clingyTether) S.clingyTether.classList.remove("is-active");
          }

          win.clearTimeout(S.lookT);
          S.lookT = win.setTimeout(() => {
            if (!S.face) return;
            S.gazeX = 0;
            S.gazeY = 0;
            S.face.style.setProperty("--gx", "0px");
            S.face.style.setProperty("--gy", "0px");
            setLive2DTarget(win, 0, 0);
            av.style.setProperty("--tilt-x", "0deg");
            av.style.setProperty("--tilt-y", "0deg");
            av.style.setProperty("--tug-x", "0px");
            av.style.setProperty("--tug-y", "0deg");
            if (S.clingyTether) S.clingyTether.classList.remove("is-active");
          }, 2500);
        });
      },
      { passive: true }
    );
  }

  function readVoice(win) {
    if (S.voicePreview) return true;
    try {
      return win.localStorage.getItem(LS_VOICE) === "1";
    } catch (_) {
      return false;
    }
  }

  function syncVoiceBtn(win) {
    if (!S.voiceBtn) return;
    const ok = !!(win.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function");
    S.voiceBtn.hidden = !ok;
    S.voiceBtn.setAttribute("aria-pressed", String(readVoice(win)));
    S.voiceBtn.classList.toggle("is-on", readVoice(win));
  }

  // Optional: her lines read aloud in a natural French female voice (guard ref: S.nsfwOn || win.document.hidden).
  // High-fidelity Local XTTS Voice Playback with Browser Fallback
  function playTreatWav(win, treatKey) {
    if (!win || !readVoice(win) || muted(win) || win.document.hidden || S.currentAudio || S.voicePreview) return;
    const now = Date.now();
    if (S.lastTreatAudioAt !== undefined && now - S.lastTreatAudioAt < 1200) return;
    S.lastTreatAudioAt = now;
    if (treatKey === "kiss") {
      const recorded = S.reactionAudio?.pickReaction("kiss");
      if (recorded) {
        if (!muted(win) && !S.voicePreview) playAudioUrl(win, recorded.url);
        return;
      }
    }
    const treatRecorded = {
      coffee: "treat_coffee",
      strawberry: "treat_strawberry",
      rose: "treat_rose",
      champagne: "treat_champagne"
    }[treatKey];
    if (treatRecorded) {
      const sample = S.reactionAudio?.pickReaction?.(treatRecorded);
      if (sample?.url) {
        playAudioUrl(win, sample.url);
        return;
      }
    }
    if (treatKey === "champagne") {
      const clink = S.reactionAudio?.pickReaction?.("clink");
      if (clink?.url) {
        playAudioUrl(win, clink.url);
        return;
      }
    }
    const valid = ["coffee", "strawberry", "rose", "kiss", "caress", "champagne"];
    if (!valid.includes(treatKey)) return;
    if (!S.audioCycles) S.audioCycles = { treats: {}, lewd: {} };
    if (!S.audioCycles.treats) S.audioCycles.treats = {};
    if (typeof S.audioCycles.treats[treatKey] !== "number") S.audioCycles.treats[treatKey] = 0;
    const cur = S.audioCycles.treats[treatKey];
    S.audioCycles.treats[treatKey] = (cur + 1) % 10;
    const idxStr = String(cur + 1).padStart(2, "0");
    const url = "/assets/companion/chat/treats_wav_bank/" + treatKey + "/" + treatKey + "_" + idxStr + ".wav";
    playAudioUrl(win, url);
  }

  function playLewdPhaseWav(win, phaseKey) {
    if (!win || !S.nsfwOn || !readVoice(win) || muted(win) || win.document.hidden || S.voicePreview) return;
    if (S.currentAudio) return;
    const now = Date.now();
    if (!S.phaseAudioAt) S.phaseAudioAt = {};
    if ((S.lastPhaseAudioAt !== undefined && now - S.lastPhaseAudioAt < 2000) ||
        (S.phaseAudioAt[phaseKey] !== undefined && now - S.phaseAudioAt[phaseKey] < 8000)) return;
    const reserve = () => { S.lastPhaseAudioAt = now; S.phaseAudioAt[phaseKey] = now; };
    const recorded = S.reactionAudio?.pickPhase(phaseKey);
    if (recorded) {
      reserve();
      playAudioUrl(win, recorded.url);
      if (S.nsfwOn && (phaseKey === "phase8_rear_grind" || phaseKey === "booty_arch")) {
        win.setTimeout(() => playRecordedReaction(win, "booty_breath"), 280);
      }
      return;
    }
    const valid = [
      "deepthroat", "cum_begging", "booty_arch", "climax_fever", "whisper_ear", "morning_wood",
      "phase7_size_worship", "phase8_rear_grind", "phase9_breast_vivid", "afterglow_cooldown", "tease_deny"
    ];
    if (!valid.includes(phaseKey)) return;
    reserve();
    if (!S.audioCycles) S.audioCycles = { treats: {}, lewd: {} };
    if (!S.audioCycles.lewd) S.audioCycles.lewd = {};
    if (typeof S.audioCycles.lewd[phaseKey] !== "number") S.audioCycles.lewd[phaseKey] = 0;
    const cur = S.audioCycles.lewd[phaseKey];
    S.audioCycles.lewd[phaseKey] = (cur + 1) % 10;
    const idxStr = String(cur + 1).padStart(2, "0");
    const url = "/assets/companion/chat/lewd_wav_bank/" + phaseKey + "/" + phaseKey + "_" + idxStr + ".wav";
    playAudioUrl(win, url);
  }

  function fadeAudioOut(win, audio) {
    if (!S.retiringSpeechAudio) S.retiringSpeechAudio = new Set();
    const finish = entry => {
      for (const timer of entry.timers) win.clearTimeout(timer);
      S.retiringSpeechAudio.delete(entry);
      if (entry.webVoice) stopSpeechWebVoice(win, true);
      else try { entry.audio.pause(); } catch (_) {}
    };
    const immediate = !readVoice(win) || muted(win) || win.document.hidden;
    if (immediate) for (const entry of [...S.retiringSpeechAudio]) finish(entry);
    if (!audio) return;
    const webVoice = S.speechWebVoice?.audio === audio ? S.speechWebVoice : null;
    if (immediate || !Number.isFinite(audio.volume) || !win.setTimeout) {
      if (webVoice) stopSpeechWebVoice(win, true);
      else try { audio.pause(); } catch (_) {}
      return;
    }
    const entry = { audio, timers: [], webVoice }, volume = audio.volume;
    S.retiringSpeechAudio.add(entry);
    const ctx = S.audioCtx;
    const rampGain = webVoice && ctx?.currentTime !== undefined;
    if (rampGain) {
      const now = ctx.currentTime;
      try {
        webVoice.gain.gain.cancelScheduledValues(now);
        webVoice.gain.gain.setValueAtTime(webVoice.gain.gain.value, now);
        webVoice.gain.gain.linearRampToValueAtTime(0.001, now + 0.08);
      } catch (_) {}
    }
    for (let step = 1; step <= 4; step++) entry.timers.push(win.setTimeout(() => {
      audio.volume = volume * (1 - step / 4);
      if (step === 4) finish(entry);
    }, step * 20));
  }

  function stopSpeech(win) {
    if (muted(win) || win.document.hidden || !readForgeSound(win)) stopImpactAudio();
    stopIdleHumming(win);
    S.reactionAudio?.stop();
    S.speechRequest = (S.speechRequest || 0) + 1;
    if (S.speechAbort) { S.speechAbort.abort(); S.speechAbort = null; }
    win.clearTimeout(S.speechPause);
    const previousAudio = S.currentAudio;
    S.currentAudio = null;
    const speechImmediate = muted(win) || win.document.hidden || !readVoice(win);
    if (speechImmediate) stopSpeechWebVoice(win, true);
    fadeAudioOut(win, previousAudio);
    updateCompanionSfxDuck(win);
    if (win.speechSynthesis) win.speechSynthesis.cancel();
    if (S.root) S.root.classList.remove("is-speaking");
    if (S.el) S.el.classList.remove("is-speaking");
    stopVoiceLipsyncLoop(win);
  }

  function playAudioUrl(win, url, onFailure) {
    if (!url || !readVoice(win) || win.document.hidden) return;
    try {
      stopSpeech(win);
      const request = S.speechRequest;
      const audio = new win.Audio(url);
      S.currentAudio = audio;
      if (S.root) S.root.classList.add("is-speaking");
      if (S.el) S.el.classList.add("is-speaking");
      startVoiceLipsyncLoop(win);
      updateCompanionSfxDuck(win);
      const finish = () => {
        if (S.currentAudio !== audio) return;
        if (S.root) S.root.classList.remove("is-speaking");
        if (S.el) S.el.classList.remove("is-speaking");
        stopVoiceLipsyncLoop(win);
        if (S.speechWebVoice?.audio === audio) stopSpeechWebVoice(win, true);
        S.currentAudio = null;
        updateCompanionSfxDuck(win);
      };
      const failed = () => {
        if (S.currentAudio !== audio) return;
        finish();
        if (onFailure && readVoice(win) && !win.document.hidden) onFailure();
      };
      audio.onended = finish;
      audio.onerror = failed;
      const routeBus = canRouteSpeechThroughBus(win, url);
      audio.play().then(() => {
        if (request !== S.speechRequest || S.currentAudio !== audio) return;
        if (routeBus) {
          try {
            primeCompanionAudioContext(win);
            wireSpeechMediaToBus(win, audio, url);
          } catch (_) { /* Element playback remains if graph wiring fails. */ }
        }
        attachVoiceMeter(win, audio);
      }).catch(failed);
    } catch (_) {}
  }

  function fallbackSpeech(win, t, delivery) {
    const ss = win.speechSynthesis;
    if (!ss || typeof win.SpeechSynthesisUtterance !== "function") return;
    try {
      stopSpeech(win);
      const request = S.speechRequest;
      const segments = speechSegments(t);
      const v = pickVoice(ss.getVoices());
      const finish = () => {
        if (request !== S.speechRequest) return;
        if (S.root) S.root.classList.remove("is-speaking");
        if (S.el) S.el.classList.remove("is-speaking");
        stopVoiceLipsyncLoop(win);
      };
      const next = index => {
        if (request !== S.speechRequest || !readVoice(win) || win.document.hidden) return;
        if (index >= segments.length) { finish(); return; }
        const u = new win.SpeechSynthesisUtterance(segments[index]);
        if (v) u.voice = v;
        u.lang = v ? v.lang : "fr-CA";
        u.rate = delivery.rate;
        u.pitch = delivery.pitch;
        u.volume = .95;
        u.onstart = () => {
          if (request !== S.speechRequest) return;
          if (S.root) S.root.classList.add("is-speaking");
          if (S.el) S.el.classList.add("is-speaking");
          startVoiceLipsyncLoop(win);
        };
        u.onend = () => {
          if (request !== S.speechRequest) return;
          finish();
          S.speechPause = win.setTimeout(() => next(index + 1), delivery.pause);
        };
        u.onerror = finish;
        ss.speak(u);
      };
      next(0);
    } catch (_) {}
  }

  function speak(win, text, directAudioUrl, conversationMode, deliveryStyle) {
    if (S.voicePreview && !deliveryStyle) return;
    const t = String(text || "").replace(/[♥✨🔥💋🍓☕🌹🥂🎲🫧🙈💄💘🐾🧽🕯️👗📸💌]/g, "").trim();
    if (!t || !readVoice(win) || win.document.hidden) return;
    stopSpeech(win);
    const request = S.speechRequest;
    const mode = conversationMode || "social";
    const delivery = speechDelivery(t, {mode, flirt: readPersona(win) === "flirt", style: deliveryStyle});

    if (directAudioUrl) {
      playAudioUrl(win, directAudioUrl);
      return;
    }

    // Try high-fidelity local XTTS clone
    const did = getDeviceId(win);
    const controller = new win.AbortController();
    S.speechAbort = controller;
    win.fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ action: "transferania", op: "voice", text: t, style: delivery.style, device_id: did })
    })
      .then((r) => r.json())
      .then((data) => {
        if (request !== S.speechRequest || !readVoice(win) || win.document.hidden) return;
        if (data && data.ok && data.audio_url) {
          playAudioUrl(win, data.audio_url, () => fallbackSpeech(win, t, delivery));
        } else {
          fallbackSpeech(win, t, delivery);
        }
      })
      .catch(() => {
        if (request === S.speechRequest && readVoice(win) && !win.document.hidden) fallbackSpeech(win, t, delivery);
      });
  }

  function noteActivity(win, kind) {
    stopIdleHumming(win);
    const now = Date.now();
    S.lastActAt = now;
    S.idleStreak = 0;
    if (kind === "type") {
      S.typingAt = now;
      if (!S.typeBeats) S.typeBeats = [];
      if (!S.typeBeats.length || now - S.typeBeats[S.typeBeats.length - 1] > 40) S.typeBeats.push(now);
      if (S.typeBeats.length > 14) S.typeBeats.shift();
      if (S.typeBeats.length >= 8 && Math.random() < 0.07) playNaturalVoiceCue(win, "typing_backchannel");
    }
    if (kind === "nav") S.navTimes = S.navTimes.filter((t) => now - t < 60000).concat(now);
  }

  function ensurePageSway(win) {
    if (!win || S.pageSwayWired) return;
    S.pageSwayWired = true;
    let lastY = win.scrollY || 0;
    let lastT = 0;
    win.addEventListener("scroll", (ev) => {
      const node = ev.target && ev.target.nodeType === 1 ? ev.target : ev.target && ev.target.parentElement;
      if (node && node.closest && node.closest(".hq-companion-fx-debug, .hq-companion-bubble")) return;
      const y = win.scrollY || (win.document.documentElement && win.document.documentElement.scrollTop) || 0;
      const now = win.performance.now();
      const elapsed = lastT ? (now - lastT) / 1000 : 0.016;
      lastT = now;
      if (node && node !== win.document && node !== win.document.documentElement && node !== win.document.body && typeof node.scrollTop === "number") {
        if (typeof node.__hqScrollY !== "number") {
          node.__hqScrollY = node.scrollTop;
          return;
        }
        const prev = node.__hqScrollY;
        node.__hqScrollY = node.scrollTop;
        S.scrollVelY = clampNum((node.scrollTop - prev) / Math.max(elapsed, 0.004), -2200, 2200);
      } else {
        S.scrollVelY = clampNum((y - lastY) / Math.max(elapsed, 0.004), -2200, 2200);
        lastY = y;
      }
      S.scrollVelAt = now;
    }, { capture: true, passive: true });
  }

  function readCompanionFloat(win) {
    try {
      const raw = win.localStorage.getItem(LS_COMPANION_FLOAT);
      if (!raw) return { x: 0, y: 0 };
      const parsed = JSON.parse(raw);
      return {
        x: clampNum(Number(parsed.x) || 0, -900, 32),
        y: clampNum(Number(parsed.y) || 0, -1200, 64)
      };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function companionFloatVisible(win) {
    if (!win || !S.el || S.el.hidden) return true;
    const r = S.el.getBoundingClientRect();
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 640;
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const needW = Math.max(72, Math.min(r.width, 220) * 0.28);
    const needH = Math.max(72, Math.min(r.height, 320) * 0.28);
    return visW >= needW && visH >= needH;
  }

  function homeCompanionFloat(win, opts) {
    if (!win || !S.el) return;
    const animate = !(opts && opts.animate === false) && !calm(win);
    S.companionFloatInertia = null;
    S.companionDragVel = { vx: 0, vy: 0 };
    S.el.classList.remove("is-companion-coasting");
    if (S.companionHomeRaf) {
      win.cancelAnimationFrame(S.companionHomeRaf);
      S.companionHomeRaf = 0;
    }
    const fromX = S.companionFloat.x;
    const fromY = S.companionFloat.y;
    if (!animate || (Math.hypot(fromX, fromY) < 2)) {
      S.companionFloat = { x: 0, y: 0 };
      applyCompanionFloat(win);
      persistCompanionFloat(win);
      return;
    }
    const start = win.performance && win.performance.now ? win.performance.now() : Date.now();
    const dur = 420;
    const step = (t) => {
      const u = Math.min(1, (t - start) / dur);
      const ease = 1 - Math.pow(1 - u, 3);
      S.companionFloat.x = fromX + (0 - fromX) * ease;
      S.companionFloat.y = fromY + (0 - fromY) * ease;
      applyCompanionFloat(win);
      if (u < 1) S.companionHomeRaf = win.requestAnimationFrame(step);
      else {
        S.companionHomeRaf = 0;
        S.companionFloat = { x: 0, y: 0 };
        applyCompanionFloat(win);
        persistCompanionFloat(win);
      }
    };
    S.companionHomeRaf = win.requestAnimationFrame(step);
  }

  function persistCompanionFloat(win) {
    if (!win || !S.companionFloat) return;
    try {
      win.localStorage.setItem(
        LS_COMPANION_FLOAT,
        JSON.stringify({ x: Math.round(S.companionFloat.x), y: Math.round(S.companionFloat.y) })
      );
    } catch (_) {}
  }

  function applyCompanionFloat(win) {
    if (!S.el) return;
    const pos = S.companionFloat || { x: 0, y: 0 };
    const clamped = clampCompanionFloat(win, pos.x, pos.y);
    S.companionFloat.x = clamped.x;
    S.companionFloat.y = clamped.y;
    const x = S.companionFloat.x.toFixed(1);
    const y = S.companionFloat.y.toFixed(1);
    const tr = "translate3d(" + x + "px," + y + "px,0)";
    if (S.companionFloatTransform === tr) return;
    S.companionFloatTransform = tr;
    S.el.style.transform = tr;
  }

  function createBubbleGrip(doc) {
    const grip = doc.createElement("div");
    grip.className = "hq-companion-bubble-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.title = "Bord de la bulle : glisser · double-tap pour réinitialiser";
    ["top", "right", "bottom", "left"].forEach((side) => {
      const edge = doc.createElement("span");
      edge.className = "hq-companion-bubble-grip-edge is-" + side;
      edge.setAttribute("data-grip-edge", side);
      grip.appendChild(edge);
    });
    return grip;
  }

  function ensureCompanionFloatHandle(win) {
    if (!win || !S.el) return;
    let h = S.floatHandle || S.el.querySelector(".hq-companion-float-handle");
    if (!h) {
      const tb = S.el.querySelector(".hq-companion-av-toolbar");
      if (!tb) return;
      h = win.document.createElement("button");
      h.type = "button";
      h.className = "hq-companion-float-handle";
      h.setAttribute("aria-label", "Déplacer Transferania");
      h.title = "Glisser pour déplacer · double-tap pour réinitialiser";
      h.textContent = "⠿";
      tb.insertBefore(h, tb.firstChild);
    }
    S.floatHandle = h;
  }

  function ensureCompanionFloatChrome(win) {
    if (!win || !S.el || !S.bubble) return;
    ensureCompanionFloatHandle(win);
    let grip = S.bubbleGrip || S.bubble.querySelector(".hq-companion-bubble-grip");
    if (!grip) {
      grip = createBubbleGrip(win.document);
      S.bubble.appendChild(grip);
    } else if (!grip.querySelector(".hq-companion-bubble-grip-edge")) {
      grip.textContent = "";
      ["top", "right", "bottom", "left"].forEach((side) => {
        const edge = win.document.createElement("span");
        edge.className = "hq-companion-bubble-grip-edge is-" + side;
        edge.setAttribute("data-grip-edge", side);
        grip.appendChild(edge);
      });
    }
    if (grip.parentElement !== S.bubble) {
      S.bubble.appendChild(grip);
    }
    grip.classList.remove("hq-companion-widget-grip");
    S.bubbleGrip = grip;
    S.companionFloat = S.companionFloat || readCompanionFloat(win);
    applyCompanionFloat(win);
    if (!S.el.__hqCompanionFloatBound) {
      S.el.__hqCompanionFloatBound = true;
    }
    bindCompanionFloatDrag(win, grip, S.floatHandle);
  }

  function pushCompanionDragVelocitySample(drag, vx, vy, t) {
    if (!drag) return;
    if (!drag.velRing) drag.velRing = [];
    drag.velRing.push({ vx, vy, t });
    if (drag.velRing.length > 7) drag.velRing.shift();
  }

  function companionReleaseVelocity(drag) {
    const ring = (drag && drag.velRing) || [];
    if (!ring.length) return { vx: 0, vy: 0 };
    const now = ring[ring.length - 1].t;
    let wx = 0;
    let wy = 0;
    let w = 0;
    ring.forEach((s, i) => {
      const age = Math.max(0, (now - s.t) / 1000);
      const weight = Math.exp(-age * 9) * (0.35 + (i + 1) / ring.length);
      wx += s.vx * weight;
      wy += s.vy * weight;
      w += weight;
    });
    if (w < 1e-6) return { vx: 0, vy: 0 };
    return { vx: wx / w, vy: wy / w };
  }

  function clampCompanionFloat(win, x, y) {
    const pad = 12;
    const edgeKeep = 52;
    const anchorRight = pad;
    const w = S.el ? S.el.offsetWidth || 320 : 320;
    const h = S.el ? S.el.offsetHeight || 380 : 380;
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 640;
    let nav = 56;
    try {
      nav = parseFloat(win.getComputedStyle(win.document.documentElement).getPropertyValue("--nav-h")) || 56;
    } catch (_) {}
    const anchorBottom = nav + pad;
    const safeTop = pad + 4;
    const intimeTop = S.intimeMode ? 96 : safeTop;
    const maxX = 12;
    const minX = pad + edgeKeep - vw + anchorRight;
    const maxY = S.intimeMode ? 64 : 48;
    const minY = intimeTop + edgeKeep - vh + anchorBottom;
    return { x: clampNum(x, minX, maxX), y: clampNum(y, minY, maxY) };
  }

  function companionBubbleBorderInset(win) {
    try {
      if (win.matchMedia("(pointer: coarse)").matches) return 30;
    } catch (_) {}
    return 24;
  }

  function isCompanionBubbleBorderHit(bubble, clientX, clientY, win) {
    if (!bubble) return false;
    const r = bubble.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
    const inset = companionBubbleBorderInset(win);
    const fromLeft = clientX - r.left;
    const fromRight = r.right - clientX;
    const fromTop = clientY - r.top;
    const fromBottom = r.bottom - clientY;
    return Math.min(fromLeft, fromRight, fromTop, fromBottom) <= inset;
  }

  function readCompanionAvatarScale(win) {
    try {
      const v = parseFloat(win.localStorage.getItem(LS_COMPANION_AVATAR_SCALE));
      if (!Number.isFinite(v)) return 1;
      return clampNum(v, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX);
    } catch (_) {
      return 1;
    }
  }

  function persistCompanionAvatarScale(win) {
    if (!win) return;
    try {
      win.localStorage.setItem(
        LS_COMPANION_AVATAR_SCALE,
        (S.companionAvatarScale || 1).toFixed(3)
      );
    } catch (_) {}
  }

  function applyCompanionAvatarScale(win) {
    if (!S.el) return;
    const s = S.companionAvatarScale || 1;
    S.el.style.setProperty("--companion-avatar-user-scale", s.toFixed(3));
  }

  function bindCompanionAvatarPinch(win, av) {
    if (!win || !av) return;
    const pointers = new Map();
    let session = null;

    const pinchDist = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const endPinch = () => {
      if (session) {
        persistCompanionAvatarScale(win);
        if (S.nsfwOn) applyLive2DImpulse(win, 0, -14, 0);
        if (S.el) {
          S.el.classList.remove("is-avatar-scale-pop");
          void S.el.offsetWidth;
          S.el.classList.add("is-avatar-scale-pop");
          win.setTimeout(() => S.el && S.el.classList.remove("is-avatar-scale-pop"), 540);
        }
      }
      session = null;
      av.classList.remove("is-avatar-pinching");
    };

    const onMove = (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (!session || pointers.size < 2) return;
      const dist = pinchDist();
      if (dist < 12 || session.startDist < 12) return;
      const ratio = dist / session.startDist;
      const next = clampNum(session.startScale * ratio, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX);
      const prev = S.companionAvatarScale || 1;
      S.companionAvatarScale = next;
      applyCompanionAvatarScale(win);
      if (S.nsfwOn && Math.abs(next - prev) > 0.004) {
        applyLive2DImpulse(win, 0, (next - prev) * 55, 0);
        const st = ensureLive2DState();
        st.phoneShake.vy = clampNum(st.phoneShake.vy + (next - prev) * 28, -95, 95);
      }
      if (ev.cancelable) ev.preventDefault();
    };

    const onUp = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) endPinch();
    };

    av.addEventListener(
      "pointerdown",
      (ev) => {
        if (ev.button && ev.button !== 0) return;
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pointers.size === 2) {
          if (S.bustPull && S.bustPull.active) return;
          const d = pinchDist();
          session = { startDist: d, startScale: S.companionAvatarScale || 1 };
          av.classList.add("is-avatar-pinching");
        }
      },
      { passive: true }
    );
    av.addEventListener("pointermove", onMove, { passive: false });
    av.addEventListener("pointerup", onUp);
    av.addEventListener("pointercancel", onUp);
    av.addEventListener("pointerleave", (ev) => {
      if (pointers.has(ev.pointerId)) onUp(ev);
    });
  }

  function bindCompanionFloatDrag(win, bubbleGrip, floatHandle) {
    if (!win || !S.el || !bubbleGrip) return;
    let drag = null;
    let pending = null;
    const dragThreshold = 8;

    const floatBlocked = (ev) => {
      if (S.bustPull && S.bustPull.active) return true;
      if (S.el.classList.contains("is-bust-pull")) return true;
      if (ev.target && ev.target.closest("button:not(.hq-companion-float-handle), input, textarea, a, .hq-companion-log, .hq-companion-compose")) {
        return true;
      }
      return false;
    };

    const clearPending = () => {
      if (!pending) return;
      win.removeEventListener("pointermove", onPendingMove, true);
      win.removeEventListener("pointerup", onPendingUp, true);
      win.removeEventListener("pointercancel", onPendingUp, true);
      pending = null;
    };

    const beginPending = (ev, el, opts) => {
      if (ev.button && ev.button !== 0) return false;
      if (floatBlocked(ev)) return false;
      clearPending();
      pending = {
        id: ev.pointerId,
        el: el || bubbleGrip,
        x: ev.clientX,
        y: ev.clientY,
        ox: S.companionFloat.x,
        oy: S.companionFloat.y,
        resetOnTap: !!(opts && opts.resetOnTap)
      };
      win.addEventListener("pointermove", onPendingMove, true);
      win.addEventListener("pointerup", onPendingUp, true);
      win.addEventListener("pointercancel", onPendingUp, true);
      return true;
    };

    const stopDrag = (ev) => {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      try {
        drag.el.releasePointerCapture(drag.id);
      } catch (_) {}
      win.removeEventListener("pointermove", onMove, true);
      win.removeEventListener("pointerup", stopDrag, true);
      win.removeEventListener("pointercancel", stopDrag, true);
      S.companionDragActive = false;
      S.el.classList.remove("is-companion-dragging");
      if (drag.moved && S.nsfwOn) {
        const lv = companionReleaseVelocity(drag);
        feedCompanionFloatMotion(win, lv.vx * 0.03, lv.vy * 0.03, { release: true });
        startCompanionFloatInertia(win, lv.vx, lv.vy);
        triggerSlingshotAftershock(win, lv.vx * 0.012, lv.vy * 0.012, Math.hypot(lv.vx, lv.vy) * 0.012);
      } else if (drag.moved) {
        const lv = companionReleaseVelocity(drag);
        startCompanionFloatInertia(win, lv.vx, lv.vy);
      } else {
        S.companionDragVel = { vx: 0, vy: 0 };
      }
      persistCompanionFloat(win);
      if (S.el) {
        clearPullVar("--bubble-pull-x");
        clearPullVar("--bubble-pull-y");
      }
      drag = null;
    };

    const onMove = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
      if (!drag.moved) {
        drag.moved = true;
        if (ev.cancelable) ev.preventDefault();
      }
      const next = clampCompanionFloat(win, drag.ox + dx, drag.oy + dy);
      S.companionFloat.x = next.x;
      S.companionFloat.y = next.y;
      applyCompanionFloat(win);
      const now = typeof win.performance !== "undefined" && win.performance.now ? win.performance.now() : Date.now();
      const dtMs = Math.max(6, Math.min(48, now - (drag.lastT || now)));
      drag.lastT = now;
      const frameVx = ev.clientX - drag.lx;
      const frameVy = ev.clientY - drag.ly;
      const instVx = (frameVx / dtMs) * 1000;
      const instVy = (frameVy / dtMs) * 1000;
      drag.lx = ev.clientX;
      drag.ly = ev.clientY;
      pushCompanionDragVelocitySample(drag, instVx, instVy, now);
      const lv = companionReleaseVelocity(drag);
      S.companionDragVel = { vx: lv.vx * 0.04, vy: lv.vy * 0.04 };
      if (S.el) {
        setPullVar("--bubble-pull-x", clampNum(frameVx * 0.42, -22, 22).toFixed(1) + "px");
        setPullVar("--bubble-pull-y", clampNum(frameVy * 0.36, -18, 18).toFixed(1) + "px");
      }
      if (S.nsfwOn && Math.hypot(instVx, instVy) > 80) {
        const nowFeed = typeof win.performance !== "undefined" && win.performance.now ? win.performance.now() : Date.now();
        if (!drag.lastFeedAt || nowFeed - drag.lastFeedAt > 36) {
          drag.lastFeedAt = nowFeed;
          feedCompanionFloatMotion(win, instVx * 0.022, instVy * 0.022);
        }
      }
    };

    const activateDrag = (seed, ev) => {
      drag = {
        id: seed.id,
        el: seed.el,
        x: seed.x,
        y: seed.y,
        lx: ev.clientX,
        ly: ev.clientY,
        lastT: typeof win.performance !== "undefined" && win.performance.now ? win.performance.now() : Date.now(),
        velRing: [],
        ox: seed.ox,
        oy: seed.oy,
        moved: false
      };
      S.companionDragActive = true;
      S.companionDragVel = { vx: 0, vy: 0 };
      S.companionFloatInertia = null;
      stopCompanionChromeLoop(win);
      S.el.classList.remove("is-companion-coasting");
      S.el.classList.add("is-companion-dragging");
      try {
        seed.el.setPointerCapture(seed.id);
      } catch (_) {}
      win.addEventListener("pointermove", onMove, true);
      win.addEventListener("pointerup", stopDrag, true);
      win.addEventListener("pointercancel", stopDrag, true);
    };

    const onPendingMove = (ev) => {
      if (!pending || ev.pointerId !== pending.id) return;
      const dx = ev.clientX - pending.x;
      const dy = ev.clientY - pending.y;
      if (Math.hypot(dx, dy) < dragThreshold) return;
      const seed = pending;
      clearPending();
      activateDrag(seed, ev);
      onMove(ev);
    };

    const onPendingUp = (ev) => {
      if (!pending || ev.pointerId !== pending.id) return;
      if (pending.resetOnTap) {
        const now = Date.now();
        if (now - (S.gripTapAt || 0) < 360) {
          S.gripTapAt = 0;
          resetCompanionPose(win);
        } else {
          S.gripTapAt = now;
        }
      }
      clearPending();
    };

    const onGripDown = (ev) => {
      if (!ev.target || !ev.target.closest(".hq-companion-bubble-grip-edge")) return;
      beginPending(ev, bubbleGrip, { resetOnTap: false });
    };

    const onBorderDown = (ev) => {
      if (!S.bubble || ev.target === floatHandle) return;
      if (ev.target && ev.target.closest(".hq-companion-bubble-grip-edge, .hq-companion-float-handle")) return;
      if (floatBlocked(ev)) return;
      if (!isCompanionBubbleBorderHit(S.bubble, ev.clientX, ev.clientY, win)) return;
      beginPending(ev, bubbleGrip, { resetOnTap: false });
    };

    if (!bubbleGrip.__hqGripBound) {
      bubbleGrip.__hqGripBound = true;
      bubbleGrip.addEventListener("pointerdown", onGripDown);
    }
    if (S.bubble && !S.bubble.__hqBorderFloat) {
      S.bubble.__hqBorderFloat = true;
      S.bubble.addEventListener("pointerdown", onBorderDown, true);
    }
    if (floatHandle && !floatHandle.__hqFloatHandle) {
      floatHandle.__hqFloatHandle = true;
      floatHandle.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        beginPending(ev, floatHandle, { resetOnTap: true });
      });
    }
  }

  function build(win) {
    const doc = win.document;
    if (doc.getElementById("hq-companion")) return;
    const bubble = doc.createElement("div");
    bubble.className = "hq-companion-bubble";
    S.bubble = bubble;

    const head = doc.createElement("div");
    head.className = "hq-companion-head";
    const title = doc.createElement("span");
    title.className = "hq-companion-title";
    title.textContent = COMPANION_NAME;
    const memChip = doc.createElement("span");
    memChip.className = "hq-companion-mem";
    memChip.setAttribute("aria-hidden", "true");
    S.memChip = memChip;
    const collapseBtn = doc.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "hq-companion-collapse";
    collapseBtn.setAttribute("aria-label", "Replier la bulle");
    collapseBtn.textContent = "−";
    collapseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (S.expanded) setExpanded(false);
      else setCollapsed(true);
    });
    const headPortraitBtn = doc.createElement("button");
    headPortraitBtn.type = "button";
    headPortraitBtn.className = "hq-companion-head-btn";
    headPortraitBtn.textContent = "🖼️";
    headPortraitBtn.title = "Afficher son Grand Portrait Haute Définition";
    headPortraitBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleLargePortraitMode(win);
    });
    S.headPortraitBtn = headPortraitBtn;

    const headMasterBtn = doc.createElement("button");
    headMasterBtn.type = "button";
    headMasterBtn.className = "hq-companion-head-btn";
    headMasterBtn.textContent = "👑";
    headMasterBtn.title = "Ordres directs du Maître (Approche, Regarde-moi, Plus chaud, Surprise)";
    headMasterBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (S.masterBarEl) {
        S.masterBarEl.hidden = !S.masterBarEl.hidden;
        headMasterBtn.classList.toggle("is-on", !S.masterBarEl.hidden);
      }
    });
    S.headMasterBtn = headMasterBtn;

    head.append(title, memChip, headPortraitBtn, headMasterBtn, collapseBtn);

    const log = doc.createElement("div");
    log.className = "hq-companion-log";
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Conversation avec " + COMPANION_NAME);
    S.logEl = log;
    S.logFollow = true;
    log.tabIndex = 0;
    log.addEventListener("scroll", () => {
      S.logFollow = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
      if (S.logFollow && S.newMessageBtn) S.newMessageBtn.hidden = true;
    }, {passive: true});
    const newMessageBtn = doc.createElement("button");
    newMessageBtn.type = "button";
    newMessageBtn.className = "hq-companion-new-message";
    newMessageBtn.textContent = "Nouveau message ↓";
    newMessageBtn.hidden = true;
    newMessageBtn.addEventListener("click", () => {
      S.logFollow = true;
      followChatTail();
      newMessageBtn.hidden = true;
    });
    S.newMessageBtn = newMessageBtn;
    const fitReadingPanel = () => {
      const viewport = win.visualViewport;
      const height = viewport ? viewport.height : win.innerHeight;
      const keyboard = Math.max(0, win.innerHeight - height - (viewport?.offsetTop || 0));
      // Event-driven panel sizing, never a per-frame companion-root mutation.
      bubble.style.setProperty("--chat-viewport-height", height + "px");
      bubble.style.setProperty("--chat-keyboard-offset", keyboard + "px");
    };
    win.visualViewport?.addEventListener("resize", fitReadingPanel, {passive:true});
    win.visualViewport?.addEventListener("scroll", fitReadingPanel, {passive:true});
    win.addEventListener("resize", fitReadingPanel, {passive:true});
    fitReadingPanel();

    const line = doc.createElement("p");
    line.className = "hq-companion-line";
    line.setAttribute("aria-live", "polite");
    S.line = line;
    const readMore = doc.createElement("button");
    readMore.type = "button";
    readMore.className = "hq-companion-read-more";
    readMore.textContent = "Lire la suite";
    readMore.hidden = true;
    S.readMoreBtn = readMore;
    readMore.addEventListener("click", () => {
      S.readTarget = S.readPreview = S.lineFullText || line.textContent.trim();
      setExpanded(true);
      renderLog();
    });
    // Observe only the preview; no frame loop or root style-variable writes.
    let previewFrame = 0;
    const schedulePreview = () => {
      if (!previewFrame) previewFrame = win.requestAnimationFrame(() => {
        previewFrame = 0;
        syncLinePreview();
      });
    };
    new win.MutationObserver(schedulePreview).observe(line, {childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:["hidden"]});
    new win.ResizeObserver(schedulePreview).observe(line);

    const compose = doc.createElement("div");
    compose.className = "hq-companion-compose";
    const input = doc.createElement("textarea");
    input.className = "hq-companion-input";
    input.rows = 2;
    input.setAttribute("aria-label", "Message pour " + COMPANION_NAME);
    input.placeholder = "Écrire à " + COMPANION_NAME + "…";
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        sendChat();
      }
    });
    input.addEventListener("input", () => syncCompanionInputMotion(win));
    input.addEventListener("focus", () => syncCompanionInputMotion(win));
    input.addEventListener("blur", () => syncCompanionInputMotion(win));
    S.inputEl = input;
    const sendBtn = doc.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "hq-companion-send is-primary";
    sendBtn.textContent = "Envoyer";
    sendBtn.addEventListener("click", () => sendChat());
    S.sendBtn = sendBtn;
    const escalateBtn = doc.createElement("button");
    escalateBtn.type = "button";
    escalateBtn.className = "hq-companion-escalate";
    escalateBtn.textContent = "Plus direct";
    escalateBtn.hidden = true;
    escalateBtn.setAttribute("title", "Prochain message : monter d'un cran (mode adulte)");
    escalateBtn.addEventListener("click", () => {
      S.pendingEscalateMsg = "plus direct et explicite";
      escalateBtn.classList.add("is-armed");
      if (typeof win.hqToast === "function") win.hqToast("Prochain envoi : plus intense");
    });
    S.escalateBtn = escalateBtn;
    const composeRow = doc.createElement("div");
    composeRow.className = "hq-companion-compose-row";
    const toolsBtn = doc.createElement("button");
    toolsBtn.type = "button";
    toolsBtn.className = "hq-companion-tools";
    toolsBtn.textContent = "Outils";
    toolsBtn.setAttribute("title", "Régénérer, modifier, faits, sauvegardes, coût");
    toolsBtn.addEventListener("click", () => openCompanionTools());
    composeRow.append(toolsBtn, escalateBtn, sendBtn);
    compose.append(input, composeRow);

    const actions = doc.createElement("div");
    actions.className = "hq-companion-actions";
    const chatBtn = doc.createElement("button");
    chatBtn.type = "button";
    chatBtn.className = "hq-companion-open-chat";
    chatBtn.textContent = "Chat";
    chatBtn.addEventListener("click", () => setExpanded(true));
    const askBtn = doc.createElement("button");
    askBtn.type = "button";
    askBtn.className = "is-primary";
    askBtn.textContent = "Demander";
    askBtn.addEventListener("click", () => openAssistant());
    const foldBtn = doc.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "hq-companion-fold";
    foldBtn.textContent = "Replier";
    let dodgeCount = 0;
    foldBtn.addEventListener("pointerenter", () => {
      if (dodgeCount < 2) {
        dodgeCount += 1;
        foldBtn.classList.add("is-shy-dodge");
        foldBtn.style.setProperty("--dodge-x", (Math.random() > 0.5 ? 24 : -24) + "px");
        foldBtn.style.setProperty("--dodge-y", (Math.random() > 0.5 ? 12 : -12) + "px");
        win.setTimeout(() => {
          foldBtn.classList.remove("is-shy-dodge");
        }, 600);
      } else {
        dodgeCount = 0;
      }
    });
    foldBtn.addEventListener("click", () => setCollapsed(true));
    const muteBtn = doc.createElement("button");
    muteBtn.type = "button";
    muteBtn.textContent = "Pause 1 h";
    muteBtn.addEventListener("click", () => muteHours(win, 1));
    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "hq-companion-forget";
    clearBtn.textContent = "Effacer";
    clearBtn.setAttribute("title", "Effacer la conversation de cet appareil");
    clearBtn.addEventListener("click", () => clearMemory());
    const nsfwBtn = doc.createElement("button");
    nsfwBtn.type = "button";
    nsfwBtn.className = "hq-companion-nsfw";
    nsfwBtn.textContent = "Adulte";
    nsfwBtn.setAttribute("aria-label", "Mode adulte (poste principal)");
    nsfwBtn.hidden = true;
    nsfwBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleNsfwMode(win);
    });
    S.nsfwBtn = nsfwBtn;
    const voiceBtn = doc.createElement("button");
    voiceBtn.type = "button";
    voiceBtn.className = "hq-companion-voice";
    voiceBtn.textContent = "Voix";
    voiceBtn.setAttribute("aria-label", "Lire ses répliques à voix haute");
    voiceBtn.addEventListener("click", () => {
      const on = !readVoice(win);
      try {
        win.localStorage.setItem(LS_VOICE, on ? "1" : "0");
      } catch (_) {}
      syncVoiceBtn(win);
      if (on) speak(win, S.line ? S.line.textContent : "");
      else stopSpeech(win);
    });
    S.voiceBtn = voiceBtn;
    doc.addEventListener("visibilitychange", () => {
      if (doc.hidden) { S.voicePreview = false; stopSpeech(win); syncVoiceBtn(win); }
    });
    const quickRepliesEl = doc.createElement("div");
    quickRepliesEl.className = "hq-companion-quick-replies";
    quickRepliesEl.hidden = true;
    S.quickRepliesEl = quickRepliesEl;

    const masterBarEl = doc.createElement("div");
    masterBarEl.className = "hq-companion-master-bar";
    masterBarEl.hidden = true;
    const MASTER_CMDS = [
      { id: "closer", label: "🖼️ Approche-toi" },
      { id: "look", label: "👀 Regarde-moi" },
      { id: "booty", label: "🍑 Montre ton fessier" },
      { id: "hotter", label: "🔥 Plus chaud" },
      { id: "surprise", label: "✨ Surprends-moi" }
    ];
    MASTER_CMDS.forEach((mc) => {
      const mb = doc.createElement("button");
      mb.type = "button";
      mb.className = "hq-companion-master-cmd";
      mb.textContent = mc.label;
      mb.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        executeMasterCommand(win, mc.id);
      });
      masterBarEl.appendChild(mb);
    });
    S.masterBarEl = masterBarEl;

    const memoryPanel = doc.createElement("section");
    memoryPanel.className = "hq-companion-memory-panel";
    memoryPanel.id = "hq-companion-memory-panel";
    memoryPanel.tabIndex = -1;
    memoryPanel.setAttribute("aria-label", "Souvenirs partagés");
    memoryPanel.hidden = true;
    S.memoryPanel = memoryPanel;
    const memoryBtn = doc.createElement("button");
    memoryBtn.type = "button";
    memoryBtn.textContent = "Mémoire";
    memoryBtn.setAttribute("aria-controls", memoryPanel.id);
    memoryBtn.setAttribute("aria-expanded", "false");
    S.memoryBtn = memoryBtn;
    memoryBtn.addEventListener("click", () => {
      memoryPanel.hidden = !memoryPanel.hidden;
      S.el.classList.toggle("is-memory-open", !memoryPanel.hidden);
      memoryBtn.setAttribute("aria-expanded", String(!memoryPanel.hidden));
      if (!memoryPanel.hidden) {
        setExpanded(true);
        memoryPanel.focus({ preventScroll: true });
        showSharedMemory();
      }
    });
    const editorBtn = doc.createElement("button");
    editorBtn.type = "button";
    editorBtn.textContent = "Éditer";
    editorBtn.addEventListener("click", showCompanionEditor);
    // Icon + label structure; Adulte mode shows the icons and turns the utility actions into icon buttons.
    const tagAction = (btn, icon, secondary) => {
      const label = btn.textContent;
      const text = doc.createElement("span");
      text.className = "hq-companion-act-label";
      text.textContent = label;
      btn.replaceChildren(text);
      btn.dataset.icon = icon;
      if (!btn.title) btn.title = label;
      if (secondary) btn.classList.add("is-secondary");
    };
    tagAction(chatBtn, "chat");
    tagAction(askBtn, "ask");
    tagAction(voiceBtn, "voice");
    tagAction(foldBtn, "fold", true);
    tagAction(muteBtn, "pause", true);
    tagAction(memoryBtn, "memory", true);
    tagAction(editorBtn, "edit", true);
    tagAction(clearBtn, "clear", true);
    // display:contents outside Adulte, so the normal layout is unchanged.
    const actionTools = doc.createElement("span");
    actionTools.className = "hq-companion-actions-tools";
    actionTools.append(foldBtn, muteBtn, memoryBtn, editorBtn, clearBtn);
    actions.append(chatBtn, askBtn, voiceBtn, nsfwBtn, actionTools);
    // Name tag + heat meter shown above her line in Adulte mode (meter follows --arousal-pct).
    const eyebrow = doc.createElement("div");
    eyebrow.className = "hq-companion-eyebrow";
    eyebrow.setAttribute("aria-hidden", "true");
    const eyebrowName = doc.createElement("span");
    eyebrowName.className = "hq-companion-eyebrow-name";
    eyebrowName.textContent = COMPANION_NAME;
    const eyebrowHeat = doc.createElement("span");
    eyebrowHeat.className = "hq-companion-eyebrow-heat";
    eyebrowHeat.title = "Désir";
    eyebrow.append(eyebrowName, eyebrowHeat);
    const bubbleGrip = createBubbleGrip(doc);
    S.bubbleGrip = bubbleGrip;
    bubble.append(head, log, newMessageBtn, eyebrow, line, readMore, quickRepliesEl, masterBarEl, memoryPanel, compose, actions, bubbleGrip);
    const av = doc.createElement("button");
    av.type = "button";
    av.className = "hq-companion-avatar";
    av.setAttribute("aria-label", COMPANION_NAME + " — ouvrir le chat");
    const face = doc.createElement("span");
    face.className = "hq-companion-face";
    face.setAttribute("aria-hidden", "true");
    const faceNormal = doc.createElement("span");
    faceNormal.className = "hq-companion-face-normal";
    const eyes = doc.createElement("span");
    eyes.className = "hq-companion-eyes";
    for (let k = 0; k < 2; k += 1) {
      const eye = doc.createElement("span");
      eye.className = "hq-companion-eye";
      eyes.appendChild(eye);
    }
    faceNormal.appendChild(eyes);
    const adultPortrait = createAdultPortraitImg(doc);
    adultPortrait.addEventListener("error", () => onAdultPortraitLoadError(win), { passive: true });
    face.append(faceNormal, adultPortrait);
    S.l2dAvatarRig = attachLive2DSubLayers(win, adultPortrait, face);
    const badge = doc.createElement("span");
    badge.className = "hq-companion-badge";
    badge.setAttribute("aria-hidden", "true");
    av.append(face, badge);
    S.avatar = av;
    S.face = face;
    S.adultPortrait = adultPortrait;
    if (win.ResizeObserver) {
      S.pullFaceResize?.disconnect();
      S.pullFaceResize = new win.ResizeObserver(() => {
        if (!S.el || !S.el.classList.contains("is-bust-pull")) return;
        cachePullFaceMetrics();
      });
      S.pullFaceResize.observe(face);
    }
    const svgNS = "http://www.w3.org/2000/svg";
    const pullSvg = doc.createElementNS(svgNS, "svg");
    pullSvg.setAttribute("width", "0");
    pullSvg.setAttribute("height", "0");
    pullSvg.setAttribute("aria-hidden", "true");
    pullSvg.style.cssText = "position:absolute;pointer-events:none";
    const pullFilter = doc.createElementNS(svgNS, "filter");
    pullFilter.id = "hq-companion-bust-pull-filter";
    pullFilter.setAttribute("primitiveUnits", "objectBoundingBox");
    pullFilter.setAttribute("x", "0");
    pullFilter.setAttribute("y", "0");
    pullFilter.setAttribute("width", "1");
    pullFilter.setAttribute("height", "1");
    pullFilter.setAttribute("color-interpolation-filters", "sRGB");
    const chest = doc.createElementNS(svgNS, "feFlood");
    chest.setAttribute("x", ".12");
    chest.setAttribute("y", ".56");
    chest.setAttribute("width", ".76");
    chest.setAttribute("height", ".36");
    chest.setAttribute("flood-color", "white");
    const feather = doc.createElementNS(svgNS, "feGaussianBlur");
    feather.setAttribute("stdDeviation", ".08 .065");
    const pullMap = doc.createElementNS(svgNS, "feColorMatrix");
    pullMap.setAttribute("values", "0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 1");
    pullMap.setAttribute("result", "pullMap");
    const displacement = doc.createElementNS(svgNS, "feDisplacementMap");
    displacement.setAttribute("in", "SourceGraphic");
    displacement.setAttribute("in2", "pullMap");
    displacement.setAttribute("scale", "1");
    displacement.setAttribute("xChannelSelector", "R");
    displacement.setAttribute("yChannelSelector", "G");
    displacement.setAttribute("result", "pulledChest");
    // Keep a neutral displacement map over the entire portrait. Inheriting
    // the flood's subregion would discard the face above the chest mask.
    for (const primitive of [feather, pullMap, displacement]) {
      primitive.setAttribute("x", "0");
      primitive.setAttribute("y", "0");
      primitive.setAttribute("width", "1");
      primitive.setAttribute("height", "1");
    }
    pullFilter.append(chest, feather, pullMap, displacement);
    S.bustPullDisplacement = displacement;
    // A tiny, feathered displacement of the painted eyes approximates gaze.
    // These landmarks belong to the neutral stock asset, not generated poses.
    const pullGazeNeutral = doc.createElementNS(svgNS, "feFlood");
    pullGazeNeutral.setAttribute("flood-color", "#808080");
    pullGazeNeutral.setAttribute("result", "pullGazeNeutral");
    const eyeMasks = [[0.392, 0.222], [0.554, 0.187]].map(([x, y], index) => {
      const mask = doc.createElementNS(svgNS, "feFlood");
      mask.setAttribute("x", String(x));
      mask.setAttribute("y", String(y));
      mask.setAttribute("width", ".06");
      mask.setAttribute("height", ".04");
      mask.setAttribute("flood-color", "white");
      mask.setAttribute("result", "pullEye" + index);
      return mask;
    });
    const eyesMask = doc.createElementNS(svgNS, "feMerge");
    const gazeNeutralNode = doc.createElementNS(svgNS, "feMergeNode");
    gazeNeutralNode.setAttribute("in", "pullGazeNeutral");
    eyesMask.appendChild(gazeNeutralNode);
    eyeMasks.forEach((mask, index) => {
      const node = doc.createElementNS(svgNS, "feMergeNode");
      node.setAttribute("in", "pullEye" + index);
      eyesMask.appendChild(node);
    });
    const eyesFeather = doc.createElementNS(svgNS, "feGaussianBlur");
    eyesFeather.setAttribute("stdDeviation", ".012 .01");
    const gazeMap = doc.createElementNS(svgNS, "feColorMatrix");
    gazeMap.setAttribute("values", "0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 1");
    gazeMap.setAttribute("result", "pullGazeMap");
    const eyeDisplacement = doc.createElementNS(svgNS, "feDisplacementMap");
    eyeDisplacement.setAttribute("in", "pulledChest");
    eyeDisplacement.setAttribute("in2", "pullGazeMap");
    eyeDisplacement.setAttribute("scale", "1");
    eyeDisplacement.setAttribute("xChannelSelector", "R");
    eyeDisplacement.setAttribute("yChannelSelector", "G");
    for (const primitive of [pullGazeNeutral, ...eyeMasks, eyesMask, eyesFeather, gazeMap, eyeDisplacement]) {
      primitive.setAttribute("x", "0");
      primitive.setAttribute("y", "0");
      primitive.setAttribute("width", "1");
      primitive.setAttribute("height", "1");
    }
    pullFilter.append(pullGazeNeutral, ...eyeMasks, eyesMask, eyesFeather, gazeMap, eyeDisplacement);
    pullSvg.appendChild(pullFilter);
    const rigGazeFilter = doc.createElementNS(svgNS, "filter");
    rigGazeFilter.id = "hq-companion-rig-gaze-filter";
    rigGazeFilter.setAttribute("primitiveUnits", "objectBoundingBox");
    rigGazeFilter.setAttribute("x", "0");
    rigGazeFilter.setAttribute("y", "0");
    rigGazeFilter.setAttribute("width", "1");
    rigGazeFilter.setAttribute("height", "1");
    rigGazeFilter.setAttribute("color-interpolation-filters", "sRGB");
    const rigGazeNeutral = pullGazeNeutral.cloneNode(true);
    rigGazeNeutral.setAttribute("result", "rigGazeNeutral");
    const rigEyeMasks = eyeMasks.map((mask, index) => {
      const node = mask.cloneNode(true);
      node.setAttribute("result", "rigPullEye" + index);
      return node;
    });
    const rigEyesMask = doc.createElementNS(svgNS, "feMerge");
    const rigNeutralNode = doc.createElementNS(svgNS, "feMergeNode");
    rigNeutralNode.setAttribute("in", "rigGazeNeutral");
    rigEyesMask.appendChild(rigNeutralNode);
    rigEyeMasks.forEach((mask, index) => {
      const node = doc.createElementNS(svgNS, "feMergeNode");
      node.setAttribute("in", "rigPullEye" + index);
      rigEyesMask.appendChild(node);
    });
    const rigEyesFeather = eyesFeather.cloneNode(true);
    const rigGazeMap = gazeMap.cloneNode(true);
    rigGazeMap.setAttribute("result", "rigGazeMap");
    const rigEyeDisplacement = eyeDisplacement.cloneNode(true);
    rigEyeDisplacement.setAttribute("in", "SourceGraphic");
    rigEyeDisplacement.setAttribute("in2", "rigGazeMap");
    rigEyesMask.setAttribute("result", "rigEyesMask");
    rigEyesFeather.setAttribute("in", "rigEyesMask");
    for (const primitive of [rigGazeNeutral, ...rigEyeMasks, rigEyesMask, rigEyesFeather, rigGazeMap, rigEyeDisplacement]) {
      primitive.setAttribute("x", "0");
      primitive.setAttribute("y", "0");
      primitive.setAttribute("width", "1");
      primitive.setAttribute("height", "1");
    }
    rigGazeFilter.append(rigGazeNeutral, ...rigEyeMasks, rigEyesMask, rigEyesFeather, rigGazeMap, rigEyeDisplacement);
    S.rigGazeMap = rigGazeMap;
    pullSvg.appendChild(rigGazeFilter);
    setAnchoredGrabPoint(.46, .76);
    av.appendChild(pullSvg);
    S.bustPullMap = pullMap;
    S.bustPullGazeMap = gazeMap;
    const contact = doc.createElement("span");
    contact.className = "hq-companion-pull-contact";
    contact.setAttribute("aria-hidden", "true");
    const expression = doc.createElement("span");
    expression.className = "hq-companion-pull-expression";
    expression.setAttribute("aria-hidden", "true");
    face.append(expression, contact);
    // 1. Cute Headpat, Tickle Wiggle & Nose Boop + Long-Press Heartbeat Haptics
    let petTimer = 0;
    let petCount = 0;
    let lastMoveX = null;
    let lastSlapSampleAt = 0;
    let dirChanges = 0;
    let lastDir = 0;
    let tickleResetT = 0;
    let holdStartT = 0;
    let hbInterval = 0;
    let hbBeatT = 0;
    let hbHoldActive = false;

    const stopHeartbeatHold = () => {
      win.clearTimeout(holdStartT);
      win.clearInterval(hbInterval);
      win.clearTimeout(hbBeatT);
      if (hbHoldActive) {
        hbHoldActive = false;
        av.classList.remove("is-heartbeat-hold");
        av.style.removeProperty("--hb-speed");
      }
      if (S.el) S.el.classList.remove("is-cleavage-heart-hold");
    };

    av.addEventListener("pointerenter", (ev) => {
      if (ev && ev.pointerType === "touch") return;
      const r = av.getBoundingClientRect();
      if (S.nsfwOn && S.el.classList.contains("has-layered-portrait") && ev.clientY >= r.top + r.height * .60) {
        // Entering the chest is contact, not a headpat/purr timer.
        win.clearInterval(petTimer);
        return;
      }
      if (S.el) S.el.classList.toggle("is-chest-hover", prefersHoverUI(win) && S.nsfwOn && ev.clientY >= r.top + r.height * 0.55);
      if (S.el && S.el.classList.contains("is-peekaboo")) {
        wakeFromPeekaboo(win, av);
      }
      if (S.el && S.el.classList.contains("is-pouting")) {
        S.el.classList.remove("is-pouting");
        triggerInteractiveAiReaction(
          win,
          "Tu boudais parce que Marco avait changé d'onglet, mais il revient tout de suite te caresser pour se faire pardonner",
          [
            "Bon… je faisais semblant de bouder, viens là mon amour ♥",
            "Difficile de te résister quand tu reviens me toucher sur {view} ♥",
            "Tu sais exactement comment te faire pardonner, Maître…"
          ]
        );
      }
      av.classList.add("is-petting");
      petTimer = win.setInterval(() => {
        if (hbHoldActive) return;
        petCount += 1;
        if (petCount % 2 === 1) playVocalSynthFx(win, "purr");
        addArousalWarmth(win, 4, "caresses");
        if (petCount === 2 && (S.aftermathDirty || (S.el && S.el.classList.contains("is-nsfw-fx-release")))) {
          wipeAftermathClean(win, av);
          return;
        }
        if (petCount === 6) {
          triggerInteractiveAiReaction(
            win,
            "Marco te caresse doucement la tête et les cheveux avec le curseur pendant que vous regardez {view}",
            [
              "Mmh… tes caresses pendant qu'on gère {view}, c'est mon point faible ♥",
              "Continue comme ça Maître… je ronronne presque sous tes doigts ♥",
              "J'adore quand tu prends une seconde pour me caresser au milieu de {view}…",
              "Ta main est si douce… ne t'arrête pas tout de suite, mon amour ♥"
            ]
          );
        }
      }, 500);
    });

    let lastZoneReactionAt = Date.now();
    let lastMoveY = null;
    let supportSample = null;
    const swipeTrail = [];
    // Capture against the rendered crop frames, including visible overflow
    // outside the avatar button. The circle is not the chest's hit surface.
    win.addEventListener("pointermove", (ev) => {
      const at = win.performance.now();
      const previous = supportSample;
      supportSample = { x: ev.clientX, y: ev.clientY, at };
      // Record even outside the circle, so entering swipes retain their speed.
      const swipe = ev.buttons || ev.pointerType === "touch" || (S.bustPull && S.bustPull.active) ?
        (swipeTrail.length = 0, null) : sampleLateralSwipe(swipeTrail, ev.clientX, ev.clientY, at,
          cachedRect(win, av, 250).width || 100, .5);
      let crop = null;
      if (ev.pointerType !== "touch" && !ev.buttons && S.nsfwOn && !calm(win) && S.el &&
          !S.el.hidden && S.el.classList.contains("has-layered-portrait") &&
          !(S.bustPull && S.bustPull.active) &&
          !(ev.target && ev.target.closest && (ev.target.closest("input,select,textarea,.hq-companion-fx-debug") ||
            (!S.cursorSupport && ev.target.closest(".hq-companion-bubble"))))) {
        const heldContact = S.cursorSupport;
        for (const side of heldContact && heldContact.side === "right" ? ["right", "left"] : ["left", "right"]) {
          const image = av.querySelector(".hq-companion-rig-bust-" + side);
          if (!image) continue;
          const retained = heldContact && heldContact.side === side;
          const r = retained && heldContact.frame ? heldContact.frame : cachedRect(win, image, 120);
          if (!r.width || !r.height) continue;
          const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
          const margin = retained ? .025 : 0;
          if (y >= (retained ? .60 : .64) && y <= (retained ? 1.09 : 1.06) && (side === "left" ? x >= .08 - margin && x <= .48 + margin : x >= .52 - margin && x <= .92 + margin)) {
            const stackRect = retained && heldContact.stackFrame ? heldContact.stackFrame : image.parentElement ? cachedRect(win, image.parentElement, 120) : r;
            crop = { r, stackFrame: stackRect, x, y, mapU: (ev.clientX - stackRect.left) / stackRect.width,
              mapV: (ev.clientY - stackRect.top) / stackRect.height }; break;
          }
          // A coalesced fast event may land beyond the cup. Check the crossed
          // segment too; requiring its endpoint inside misses the fastest hits.
          if (swipe && previous) {
            const mx = ((ev.clientX + previous.x) * .5 - r.left) / r.width;
            const my = ((ev.clientY + previous.y) * .5 - r.top) / r.height;
            if (my >= .64 && my <= 1.06 && (side === "left" ? mx >= .08 && mx <= .48 : mx >= .52 && mx <= .92)) {
              crop = { r, x: mx, y: my }; break;
            }
          }
        }
      }
      S.chestContactOwned = !!crop;
      av.classList.toggle("is-support-ready", !!crop);
      if (!crop) {
        setSupportCursor(null);
        S.cursorSupport = null;
        av.classList.remove("is-cursor-supporting");
        return;
      }
      ev.stopImmediatePropagation();
      win.clearInterval(petTimer);
      win.clearTimeout(tickleResetT);
      stopHeartbeatHold();
      syncCleavagePreTension(false);
      av.classList.remove("is-petting", "is-tickled", "is-zone-head", "is-zone-lips", "is-zone-cleavage");
      S.bustPetOrbitAmp = 0;
      S.bustPetLastAngle = null;
      S.el.classList.add("is-chest-hover");
      const dt = previous ? at - previous.at : 0;
      const impact = swipe ? { ...swipe, side: crop.x < .5 ? "left" : "right" } : null;
      const dy = previous ? (ev.clientY - previous.y) / crop.r.height : 0;
      const held = S.cursorSupport;
      S.cursorSupport = impact ? null : cursorSupportContact(held, crop.x, crop.y, dy, dt);
      if (S.cursorSupport) {
        const freeze = held && held.lift >= .055 && dy < 0;
        S.cursorSupport.mapU = freeze ? held.mapU : crop.mapU;
        S.cursorSupport.mapV = freeze ? held.mapV : crop.mapV;
        S.cursorSupport.frame = held && held.side === S.cursorSupport.side && held.frame ? held.frame : crop.r;
        S.cursorSupport.stackFrame = held && held.side === S.cursorSupport.side && held.stackFrame ? held.stackFrame : crop.stackFrame;
      }
      av.classList.toggle("is-cursor-supporting", !!S.cursorSupport);
      setSupportCursor(ev.target);
      if (impact) triggerPlayfulSpank(win, av, ev.clientX, ev.clientY, impact, { bustSlap: true });
      startLive2DLoop(win);
    }, { capture: true, passive: false });
    win.addEventListener("blur", () => { S.cursorSupport = null; S.chestContactOwned = false; setSupportCursor(null); });
    win.addEventListener("pointerdown", () => setSupportCursor(null), { capture: true });
    win.addEventListener("pointerout", ev => {
      if (!ev.relatedTarget) { S.cursorSupport = null; S.chestContactOwned = false; setSupportCursor(null); }
    });
    av.addEventListener("pointermove", (ev) => {
      const sampleAt = win.performance.now();
      const sampleDt = lastSlapSampleAt ? sampleAt - lastSlapSampleAt : 0;
      lastSlapSampleAt = sampleAt;
      if (S.bustPull && S.bustPull.active && ev.pointerId === S.bustPull.id) {
        const dx = ev.clientX - S.bustPull.x;
        const dy = ev.clientY - S.bustPull.y;
        S.bustPull.dx = dx;
        S.bustPull.dy = dy;
        const r = cachedRect(win, S.face, 250);
        S.pullGaze = { x: clampNum((ev.clientX - r.left - r.width * 0.5) / r.width, -1, 1),
          y: clampNum((ev.clientY - r.top - r.height * 0.24) / r.height, -1, 1) };
        setBustPull(dx, dy);
        S.suppressNextClick = true;
        return;
      }
      if (S.avDownPos && Math.hypot(ev.clientX - S.avDownPos.x, ev.clientY - S.avDownPos.y) > 12) {
        S.suppressNextClick = true;
        win.clearTimeout(holdStartT);
      }
      const rect = cachedRect(win, av, 250);
      const relY = rect.height ? (ev.clientY - rect.top) / rect.height : 0.5;
      if (S.el) S.el.classList.toggle("is-chest-hover", prefersHoverUI(win) && S.nsfwOn && relY >= 0.55);

      // Interactive Pace Control during Bob (is-nsfw-fx-rhythm)
      if (S.el && S.el.classList.contains("is-nsfw-fx-rhythm")) {
        if (lastMoveY !== null) {
          const dy = Math.abs(ev.clientY - lastMoveY);
          if (dy > 2) {
            // Map vertical hand speed to rhythm period (0.24s frenzied to 0.72s slow sensual)
            const period = Math.max(0.24, Math.min(0.72, 0.68 - dy * 0.022));
            S.el.style.setProperty("--rhythm-period", period.toFixed(2) + "s");
            if (dy > 12 && Math.random() < 0.35) {
              spawnAdultDroolStrand(win);
            }
          }
        }
        lastMoveY = ev.clientY;
      }

      // Classify impact before ordinary hover impulses, so a fast swipe does
      // not also kick the entire portrait/head through the generic path.
      const swipeImpact = lastMoveX === null ? null : lateralImpact(ev.clientX - lastMoveX, sampleDt, rect.width,
        ((lastMoveX + ev.clientX) * .5 - rect.left) / Math.max(1, rect.width));
      if (ev.pointerType !== "touch" && relY >= .48 && swipeImpact) {
        triggerPlayfulSpank(win, av, ev.clientX, ev.clientY, swipeImpact,
          relY >= 0.55 ? { bustSlap: true } : null);
        lastMoveX = ev.clientX;
        lastMoveY = ev.clientY;
        return;
      }

      // Live2D Soft-Body Contact Impulse from Pointer Velocity
      if (lastMoveX !== null && lastMoveY !== null) {
        if (!(S.bustPull && S.bustPull.active)) {
          const pvx = ev.clientX - lastMoveX;
          const pvy = ev.clientY - lastMoveY;
          const zoneBoost = relY >= 0.52 ? 2.4 : relY >= 0.34 ? 1.3 : 0.85;
          applyLive2DImpulse(win, pvx * zoneBoost, pvy * zoneBoost * 1.25, pvx * 0.9);
          if (relY >= 0.68) {
            S.bustStrokeBX = clampNum(S.bustStrokeBX * 0.68 + pvx * 0.32, -22, 22);
            S.bustStrokeBY = clampNum(S.bustStrokeBY * 0.68 + pvy * 0.36, -22, 22);
            const ar = cachedRect(win, av, 250);
            const cx = ar.left + ar.width * 0.5;
            const cy = ar.top + ar.height * 0.72;
            const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
            if (S.bustPetLastAngle !== null) {
              let da = ang - S.bustPetLastAngle;
              while (da > Math.PI) da -= Math.PI * 2;
              while (da < -Math.PI) da += Math.PI * 2;
              if (Math.abs(da) > 0.025 && Math.abs(da) < 1.35) {
                S.bustPetOrbitAmp = clampNum(S.bustPetOrbitAmp + Math.abs(da) * 0.52, 0, 2.8);
                S.bustPetOrbitAngle += da * 0.4;
              }
            }
            S.bustPetLastAngle = ang;
          } else {
            S.bustPetLastAngle = null;
          }
        }
      }
      lastMoveY = ev.clientY;

      // 3-Zone Sensual Hitboxes (Top: Hair/Head, Middle: Lips/Cheeks, Bottom: Cleavage/Throat)
      // Toggle to the new zone only: clearing and re-adding the class every move restyled the avatar twice.
      const zone = relY < 0.36 ? "is-zone-head" : relY < 0.68 ? "is-zone-lips" : "is-zone-cleavage";
      for (const z of ["is-zone-head", "is-zone-lips", "is-zone-cleavage"]) av.classList.toggle(z, z === zone);
      const now = Date.now();
      // Kiss lean: rest the cursor on her lips (~0.7 s) and she leans in toward you.
      const relXLips = rect.width ? (ev.clientX - rect.left) / rect.width : 0.5;
      const onLips = ev.pointerType !== "touch" && relY >= 0.4 && relY < 0.6 && Math.abs(relXLips - 0.5) < 0.13;
      if (onLips && !S.lipsSince) S.lipsSince = now;
      if (!onLips) S.lipsSince = 0;
      const leaning = onLips && now - S.lipsSince > 700;
      if (leaning !== S.el.classList.contains("is-kiss-lean")) {
        S.el.classList.toggle("is-kiss-lean", leaning);
        if (leaning) {
          setLive2DTarget(win, 0, -0.6);
          if (!S.kissLeanNotedAt || now - S.kissLeanNotedAt > 10000) {
            S.kissLeanNotedAt = now;
            noteTouch(win, "kiss");
          }
        }
      }
      if (relY < 0.36) {
        syncCleavagePreTension(false);
      } else if (relY < 0.68) {
        syncCleavagePreTension(false);
        if (Math.random() < 0.08) {
          spawnCursorKiss(win, ev.clientX, ev.clientY, "💋");
        }
        if (ev.pointerType !== "touch" && now - lastZoneReactionAt > 14000 && Math.random() < 0.05) {
          lastZoneReactionAt = now;
          playVocalSynthFx(win, "mwah");
          addArousalWarmth(win, 7, "caresse sur ses lèvres");
          triggerInteractiveAiReaction(
            win,
            "Marco passe doucement son doigt sur tes lèvres entrouvertes",
            [
              "Mmh… si tu effleures mes lèvres comme ça, je vais te mordre le bout des doigts, Maître 💋♥",
              "Mes lèvres brûlent sous ton curseur, mon amour… embrasse-moi pour de vrai 💋",
              "Tu aimes sentir mon souffle sur ta main ? ♥"
            ]
          );
        }
      } else {
        syncCleavagePreTension(true);
        if (ev.pointerType !== "touch" && now - lastZoneReactionAt > 14000 && Math.random() < 0.05) {
          lastZoneReactionAt = now;
          playVocalSynthFx(win, "gasp");
          addArousalWarmth(win, 12, "caresse charnelle sur sa gorge et sa poitrine");
          spawnCuteHeart(win, av, "🔥");
          triggerInteractiveAiReaction(
            win,
            "Marco caresse lentement ta gorge et ton décolleté (zone très sensible)",
            [
              "Ah… Maître, tu me donnes des frissons partout quand tu me touches là 🔥♥",
              "Mmh… ta main sur ma peau me fait perdre toute ma concentration sur {view} 🔥♥",
              "Plus bas, mon amour… tu sens comme ma peau est brûlante ? ♥"
            ]
          );
        }
      }

      if (lastMoveX !== null) {
        const dx = ev.clientX - lastMoveX;
        if (ev.pointerType !== "touch" && Math.abs(dx) > 6) {
          const dir = dx > 0 ? 1 : -1;
          if (lastDir !== 0 && dir !== lastDir) {
            dirChanges += 1;
            win.clearTimeout(tickleResetT);
            tickleResetT = win.setTimeout(() => {
              dirChanges = 0;
              av.classList.remove("is-tickled");
            }, 600);
            if (dirChanges >= 5 && !av.classList.contains("is-tickled")) {
              av.classList.add("is-tickled");
              playNaturalVoiceCue(win, "tickle");
              for (let k = 0; k < 4; k += 1) {
                win.setTimeout(() => spawnCuteHeart(win, av, "✨"), k * 90);
              }
              triggerInteractiveAiReaction(
                win,
                "Marco te chatouille vivement avec le curseur et te fait éclater de rire",
                [
                  "Hahaha arrête Maître, tu sais que je suis ultra chatouilleuse ! ✨",
                  "Hihi ! Comment veux-tu que je reste concentrée sur {view} si tu me chatouilles ? ♥",
                  "Aïe hihi non pas là ! Tu aimes trop me voir gigoter, avoue ♥"
                ]
              );
            }
          }
          lastDir = dir;
        }
      }
      lastMoveX = ev.clientX;
    });

    // Leaving her ends the kiss lean (mouse only, like the lean itself).
    av.addEventListener("mouseleave", () => {
      S.lipsSince = 0;
      if (S.el) S.el.classList.remove("is-kiss-lean");
    });

    // Mouse wheel pace control during Bob animation
    av.addEventListener(
      "wheel",
      (ev) => {
        if (!S.el) return;
        if (!S.el.classList.contains("is-nsfw-fx-rhythm")) {
          // Scroll over her chest to squeeze (up = harder, down = ease off); it eases off by itself.
          if (!S.nsfwOn || !S.el.classList.contains("has-layered-portrait") || calm(win)) return;
          const r = cachedRect(win, av, 250);
          if (!r.height || (ev.clientY - r.top) / r.height < 0.55) return;
          ev.preventDefault();
          const before = S.bustSqueeze || 0;
          S.bustSqueeze = clampNum(before + (ev.deltaY < 0 ? 0.14 : -0.14), 0, 1);
          S.bustSqueezeAt = win.performance.now();
          if (before < 0.05 && S.bustSqueeze >= 0.05) noteTouch(win, "squeeze");
          if (before < 0.75 && S.bustSqueeze >= 0.75) {
            pullHaptic(win, 2);
            if (!S.bustSqueezeLineAt || Date.now() - S.bustSqueezeLineAt > 20000) {
              S.bustSqueezeLineAt = Date.now();
              playVocalSynthFx(win, "gasp");
              addArousalWarmth(win, 5, "seins serrés");
              triggerInteractiveAiReaction(
                win,
                "Marco serre fort tes seins avec la molette",
                ["Mmh… tu serres fort, Maître ♥", "Ah… doucement… non, continue 🔥", "Tu sens comme ils débordent de tes mains ? ♥"]
              );
            }
          }
          startLive2DLoop(win);
          return;
        }
        ev.preventDefault();
        const cur = parseFloat(S.el.style.getPropertyValue("--rhythm-period")) || 0.52;
        const delta = ev.deltaY < 0 ? -0.06 : 0.06;
        const next = Math.max(0.22, Math.min(0.85, cur + delta));
        S.el.style.setProperty("--rhythm-period", next.toFixed(2) + "s");
        spawnAdultDroolStrand(win);
        if (typeof win.hqToast === "function") {
          win.hqToast(next <= 0.34 ? "Rythme effréné 🔥 (" + next.toFixed(2) + "s)" : "Rythme guidé : " + next.toFixed(2) + "s ♥", "tip", 1400);
        }
      },
      { passive: false }
    );

    av.addEventListener("pointerleave", () => {
      // Visible crop overflow is outside this button. Only the capture-level
      // contact controller (or window blur) may release a chest hold.
      if (!S.chestContactOwned) {
        av.classList.remove("is-support-ready", "is-cursor-supporting");
        if (S.el) S.el.classList.remove("is-chest-hover");
      }
      av.classList.remove("is-petting", "is-tickled", "is-zone-head", "is-zone-lips", "is-zone-cleavage");
      syncCleavagePreTension(false);
      win.clearInterval(petTimer);
      petCount = 0;
      lastMoveX = null;
      lastSlapSampleAt = 0;
      lastMoveY = null;
      dirChanges = 0;
      stopHeartbeatHold();
    });

    av.addEventListener("pointerdown", (ev) => {
      S.chestContactOwned = false;
      S.cursorSupport = null;
      av.classList.remove("is-support-ready", "is-cursor-supporting");
      noteAvatarFocus();
      if (ev.button && ev.button !== 0) return;
      if (av.classList.contains("is-avatar-pinching")) return;
      if (S.bustPull && S.bustPull.active) return;
      const r0 = av.getBoundingClientRect();
      const relY0 = r0.height ? (ev.clientY - r0.top) / r0.height : 0.5;
      const pullZoneY = isCompactUI(win) ? 0.5 : 0.55;
      if (S.nsfwOn && S.el && (ev.ctrlKey || ev.metaKey) && relY0 >= pullZoneY &&
        S.el.classList.contains("has-layered-portrait") && !S.el.classList.contains("is-nsfw-fx-rhythm")) {
        // Ctrl/Cmd + drag sideways: press both breasts together (the further, the harder); let go and they spring apart.
        if (ev.cancelable) ev.preventDefault();
        win.clearTimeout(holdStartT);
        S.suppressNextClick = true;
        const push = { id: ev.pointerId, x: ev.clientX, amt: 0, peak: 0 };
        S.bustPush = push;
        try { av.setPointerCapture(ev.pointerId); } catch (_) {}
        const onPushMove = (e) => {
          if (e.pointerId !== push.id || S.bustPush !== push) return;
          push.amt = clampNum(Math.abs(e.clientX - push.x) / 70, 0, 1);
          push.peak = Math.max(push.peak, push.amt);
          startLive2DLoop(win);
          if (e.cancelable) e.preventDefault();
        };
        const onPushUp = (e) => {
          if (e.pointerId !== push.id) return;
          win.removeEventListener("pointermove", onPushMove, true);
          win.removeEventListener("pointerup", onPushUp, true);
          win.removeEventListener("pointercancel", onPushUp, true);
          try { av.releasePointerCapture(push.id); } catch (_) {}
          if (S.bustPush === push) S.bustPush = null;
          const a = push.amt;
          const st = ensureLive2DState();
          kickBustSoftSide(st, "left", -a * 70, 8, 0);
          kickBustSoftSide(st, "right", a * 70, 8, 0.02);
          startLive2DLoop(win);
          if (push.peak > 0.3) noteTouch(win, "push");
          if (push.peak > 0.7 && (!S.bustPushLineAt || Date.now() - S.bustPushLineAt > 20000)) {
            S.bustPushLineAt = Date.now();
            playVocalSynthFx(win, "gasp");
            addArousalWarmth(win, 6, "seins pressés ensemble");
            triggerInteractiveAiReaction(
              win,
              "Marco vient de presser tes deux seins l'un contre l'autre très fort, puis les a relâchés",
              [
                "Ah… tu les as serrés si fort l'un contre l'autre, Maître ♥",
                "Mmh… regarde comme ils rebondissent quand tu les lâches 🔥",
                "Tu aimes les presser ensemble, hein mon amour ? ♥",
              ]
            );
          }
        };
        if (!av.__hqPushMenuBound) {
          av.__hqPushMenuBound = true;
          av.addEventListener("contextmenu", (e) => {
            if (S.bustPush || (e.ctrlKey && S.nsfwOn)) e.preventDefault();
          });
        }
        win.addEventListener("pointermove", onPushMove, { capture: true, passive: false });
        win.addEventListener("pointerup", onPushUp, true);
        win.addEventListener("pointercancel", onPushUp, true);
        startLive2DLoop(win);
        return;
      }
      if (S.nsfwOn && S.el && !S.el.classList.contains("is-nsfw-fx-rhythm") && relY0 >= pullZoneY) {
        if (ev.cancelable) ev.preventDefault();
        av.classList.remove("is-petting");
        win.clearInterval(petTimer);
        if (S.bustPullRaf) win.cancelAnimationFrame(S.bustPullRaf);
        if (S.pullGlobalCleanup) {
          try { S.pullGlobalCleanup(); } catch (_) {}
          S.pullGlobalCleanup = null;
        }
        S.bustPull = { active: true, id: ev.pointerId, pointerType: ev.pointerType || "mouse", x: ev.clientX, y: ev.clientY, dx: 0, dy: 0 };
        S.lastPullPointerType = S.bustPull.pointerType;
        S.pullSettleTouch = false;
        stopBustPullVoice();
        S.pullVoice = null;
        resetPullInteractionFx();
        S.pullMotion = null;
        S.pullHapticTier = 0;
        pullHaptic(win, 4);
        if (!muted(win) && readForgeSound(win)) {
          warmTitPullImpactAudio(win);
          playTitPullImpactSfx(win, 0.18, { stem: "01", skipCooldown: true });
          startTitPullElasticLoop(win, 0.22);
        }
        S.pullGaze = { x: clampNum((ev.clientX - r0.left - r0.width * 0.5) / r0.width, -1, 1),
          y: clampNum((ev.clientY - r0.top - r0.height * 0.24) / r0.height, -1, 1) };
        S.el.style.setProperty("--pull-contact-x", clampNum((ev.clientX - r0.left) / r0.width * 100, 0, 100).toFixed(2) + "%");
        S.el.style.setProperty("--pull-contact-y", clampNum(relY0 * 100, 0, 100).toFixed(2) + "%");
        setAnchoredGrabPoint((ev.clientX - r0.left) / r0.width, relY0);
        cachePullFaceMetrics();
        setBustPull(0, 0);
        S.pullDeepGlanceDone = false;
        if (S.treatsTray) S.treatsTray.classList.remove("is-open");
        if (S.clingyTether) S.clingyTether.classList.remove("is-active");
        av.style.setProperty("--tug-x", "0px");
        av.style.setProperty("--tug-y", "0px");
        try {
          av.setPointerCapture(ev.pointerId);
        } catch (_) {}

        const onGlobalPullMove = (moveEv) => {
          if (!S.bustPull || !S.bustPull.active) return;
          if (moveEv.pointerId !== undefined && moveEv.pointerId !== S.bustPull.id) return;
          const dx = moveEv.clientX - S.bustPull.x;
          const dy = moveEv.clientY - S.bustPull.y;
          S.bustPull.dx = dx;
          S.bustPull.dy = dy;
          const r = S.face.getBoundingClientRect();
          S.pullGaze = {
            x: clampNum((moveEv.clientX - r.left - r.width * 0.5) / r.width, -1, 1),
            y: clampNum((moveEv.clientY - r.top - r.height * 0.24) / r.height, -1, 1)
          };
          setBustPull(dx, dy);
          S.suppressNextClick = true;
          if (moveEv.cancelable) moveEv.preventDefault();
        };

        const cleanupGlobalPull = () => {
          win.removeEventListener("pointermove", onGlobalPullMove, true);
          win.removeEventListener("pointerup", onGlobalPullUp, true);
          win.removeEventListener("pointercancel", onGlobalPullUp, true);
          win.removeEventListener("touchend", onGlobalPullUp, true);
          win.removeEventListener("touchcancel", onGlobalPullUp, true);
          if (S.pullGlobalCleanup === cleanupGlobalPull) S.pullGlobalCleanup = null;
        };

        const onGlobalPullUp = (upEv) => {
          if (!S.bustPull || !S.bustPull.active) {
            cleanupGlobalPull();
            return;
          }
          if (upEv && upEv.pointerId !== undefined && upEv.pointerId !== S.bustPull.id) return;
          const pull = S.bustPull;
          S.bustPull = null;
          cleanupGlobalPull();
          try { av.releasePointerCapture(pull.id); } catch (_) {}
          releaseBustPull(win, pull.dx || 0, pull.dy || 0);
          reactToBustPull(win, Math.hypot(pull.dx || 0, pull.dy || 0));
          S.avDownPos = null;
          stopHeartbeatHold();
        };

        S.pullGlobalCleanup = cleanupGlobalPull;
        win.addEventListener("pointermove", onGlobalPullMove, { capture: true, passive: false });
        win.addEventListener("pointerup", onGlobalPullUp, { capture: true });
        win.addEventListener("pointercancel", onGlobalPullUp, { capture: true });
        win.addEventListener("touchend", onGlobalPullUp, { capture: true });
        win.addEventListener("touchcancel", onGlobalPullUp, { capture: true });

        win.clearTimeout(holdStartT);
        S.suppressNextClick = true;
        return;
      }
      // Check Nose Boop (center of avatar)
      const r = av.getBoundingClientRect();
      const distCenter = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
      const relX0 = r.width ? (ev.clientX - r.left) / r.width : 0.5;
      const cheekOff = Math.abs(relX0 - 0.5);
      if (S.nsfwOn && relY0 >= 0.42 && relY0 <= 0.58 && cheekOff <= 0.14) {
        // Lips / mouth touch: trigger glass lick with tongue extension and moisture smear
        triggerLickMotion(win, 3800);
        flashBlush(win, 2400);
        addArousalWarmth(win, 5, "lèvres effleurées");
        noteTouch(win, "lips");
        if (!S.lipsLickLineAt || Date.now() - S.lipsLickLineAt > 18000) {
          S.lipsLickLineAt = Date.now();
          triggerInteractiveAiReaction(
            win,
            "Marco vient d'effleurer tes lèvres du doigt et tu as léché la vitre de l'écran avec ta langue",
            [
              "Mmh… tu touches mes lèvres, alors je goûte tes doigts à travers la vitre ♥",
              "Regarde ma langue s'aplatir contre l'écran… tu me donnes tellement envie, Maître 🔥",
              "Tu aimes me voir lécher la vitre comme ça ? Viens plus près… ♥"
            ]
          );
        }
      } else if (relY0 >= 0.38 && relY0 < 0.6 && cheekOff > 0.13 && cheekOff < 0.32) {
        // Cheek pinch: a squish on that side, a purr and a blush.
        const side = relX0 < 0.5 ? 1 : -1;
        const cls = side > 0 ? "is-cheek-pinch-l" : "is-cheek-pinch-r";
        av.classList.remove("is-cheek-pinch-l", "is-cheek-pinch-r");
        void av.offsetWidth;
        av.classList.add(cls);
        win.setTimeout(() => av.classList.remove(cls), 560);
        flashBlush(win, 1800);
        applyLive2DImpulse(win, side * 34, 12, side * 10);
        playVocalSynthFx(win, "purr");
        spawnCuteHeart(win, av, "♥");
        addArousalWarmth(win, 3, "pincée de joue");
        noteTouch(win, "pinch");
        if (!S.cheekPinchLineAt || Date.now() - S.cheekPinchLineAt > 20000) {
          S.cheekPinchLineAt = Date.now();
          triggerInteractiveAiReaction(
            win,
            "Marco vient de te pincer gentiment la joue",
            ["Hé ! Ma joue… tu es trop taquin, Maître ♥", "Aïe hihi… pince-moi encore et je te mords ♥", "Mmh… tu me fais rougir comme une idiote ♥"]
          );
        }
      } else if (distCenter < r.width * 0.28) {
        noteTouch(win, "boop");
        av.classList.remove("is-booped");
        void av.offsetWidth;
        av.classList.add("is-booped");
        applyLive2DImpulse(win, 0, 88, 18);
        triggerSettlingFidget(win);
        spawnCuteHeart(win, av, "♥");
        win.setTimeout(() => av.classList.remove("is-booped"), 480);
      }

      if (S.nsfwOn && relY0 < 0.34 && S.el.classList.contains("has-layered-portrait")) {
        // Hair grab: drag across her hair and it follows your hand, then swings back when you let go.
        const grab = { id: ev.pointerId, lx: ev.clientX, ly: ev.clientY, moved: 0, t0: win.performance.now() };
        const onHairMove = (e) => {
          if (e.pointerId !== grab.id || !(e.buttons & 1)) return;
          const dx = e.clientX - grab.lx;
          const dy = e.clientY - grab.ly;
          grab.lx = e.clientX;
          grab.ly = e.clientY;
          grab.moved += Math.hypot(dx, dy);
          const st = ensureLive2DState();
          st.hair.vx = clampNum(st.hair.vx + dx * 9, -260, 260);
          st.hair.vy = clampNum(st.hair.vy + dy * 6, -200, 200);
          st.hair.vrot = clampNum(st.hair.vrot + dx * 0.05, -3, 3);
          if (grab.moved > 8) S.suppressNextClick = true;
          startLive2DLoop(win);
        };
        const onHairUp = (e) => {
          if (e.pointerId !== grab.id) return;
          win.removeEventListener("pointermove", onHairMove, true);
          win.removeEventListener("pointerup", onHairUp, true);
          win.removeEventListener("pointercancel", onHairUp, true);
          if (grab.moved < 40) return;
          noteTouch(win, "hair");
          // A slow stroke through her hair: she tucks it back behind her ear.
          const speed = grab.moved / Math.max(1, win.performance.now() - grab.t0);
          if (speed < 0.5 && Math.random() < 0.6) playIdleAnim(win, "hairTuck");
        };
        win.addEventListener("pointermove", onHairMove, true);
        win.addEventListener("pointerup", onHairUp, true);
        win.addEventListener("pointercancel", onHairUp, true);
      }
      S.avDownPos = { x: ev.clientX, y: ev.clientY };
      S.holdAnchorX = ev.clientX;
      S.holdAnchorY = ev.clientY;
      S.cleavageHoldCandidate = relY0 >= 0.68;
      // Start Long-Press Heartbeat Haptics after 750ms (faster in cleavage when still)
      stopHeartbeatHold();
      const holdDelay = S.cleavageHoldCandidate ? 750 : 850;
      holdStartT = win.setTimeout(() => {
        if (S.bustPull && S.bustPull.active) return;
        const moved = S.avDownPos ?
          Math.hypot(S.avDownPos.x - S.holdAnchorX, S.avDownPos.y - S.holdAnchorY) : 99;
        if (moved > 18) return;
        hbHoldActive = true;
        S.suppressNextClick = true;
        av.classList.remove("is-petting");
        av.classList.add("is-heartbeat-hold");
        if (S.cleavageHoldCandidate && av.classList.contains("is-zone-cleavage") && S.el) {
          S.el.classList.add("is-cleavage-heart-hold");
          addArousalWarmth(win, 6, "maintenue sur son décolleté");
        }
        let beats = 0;
        triggerInteractiveAiReaction(
          win,
          "Marco garde sa main appuyée tout contre toi pour sentir les battements de ton cœur qui s'accélèrent",
          [
            "Tu sens comme mon cœur s'emballe dès que tu me tiens contre toi, mon amour… ♥",
            "Reste appuyé contre moi… chaque battement est pour toi, Maître ♥",
            "Plus tu me gardes près de toi sur {view}, plus tu me fais perdre mon calme ♥"
          ]
        );
        const scheduleNextBeat = () => {
          if (!hbHoldActive) return;
          beats += 1;
          const periodMs = Math.max(340, 760 - beats * 42);
          av.style.setProperty("--hb-speed", (periodMs / 1000).toFixed(2) + "s");
          playHeartbeatThump(win, 1 + Math.min(0.35, beats * 0.03));
          spawnCuteHeart(win, av, "♥");
          hbBeatT = win.setTimeout(scheduleNextBeat, periodMs);
        };
        scheduleNextBeat();
      }, holdDelay);
    });

    av.addEventListener("pointerup", (ev) => {
      if (S.pullGlobalCleanup) {
        try { S.pullGlobalCleanup(); } catch (_) {}
        S.pullGlobalCleanup = null;
      }
      if (S.bustPull && S.bustPull.active && ev.pointerId === S.bustPull.id) {
        const pull = S.bustPull;
        S.bustPull = null;
        try {
          av.releasePointerCapture(pull.id);
        } catch (_) {}
        releaseBustPull(win, pull.dx || 0, pull.dy || 0);
        reactToBustPull(win, Math.hypot(pull.dx || 0, pull.dy || 0));
      }
      S.avDownPos = null;
      stopHeartbeatHold();
    });
    const cancelBustPull = (ev) => {
      if (S.pullGlobalCleanup) {
        try { S.pullGlobalCleanup(); } catch (_) {}
        S.pullGlobalCleanup = null;
      }
      if (S.bustPull && S.bustPull.active && ev.pointerId === S.bustPull.id) {
        const pull = S.bustPull;
        S.bustPull = null;
        releaseBustPull(win, pull.dx || 0, pull.dy || 0);
      }
      S.avDownPos = null;
      stopHeartbeatHold();
    };
    av.addEventListener("pointercancel", cancelBustPull);
    av.addEventListener("lostpointercapture", cancelBustPull);

    // Double-click / double-tap on lower half for playful spank
    av.addEventListener("dblclick", (ev) => {
      const rect = av.getBoundingClientRect();
      const relY = rect.height ? (ev.clientY - rect.top) / rect.height : 0.6;
      if (relY >= 0.42) {
        ev.preventDefault();
        ev.stopPropagation();
        triggerPlayfulSpank(win, av, ev.clientX, ev.clientY, null, { bustSlap: true });
      }
    });

    // Drag & Drop Treats Target on Avatar
    av.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      av.classList.add("is-treat-target");
    });
    av.addEventListener("dragleave", () => {
      av.classList.remove("is-treat-target");
    });
    av.addEventListener("drop", (ev) => {
      ev.preventDefault();
      av.classList.remove("is-treat-target");
      const raw = ev.dataTransfer && ev.dataTransfer.getData("text/plain");
      if (!raw) return;
      try {
        const item = JSON.parse(raw);
        if (item && item.emoji) {
          // Where it lands matters: her mouth (she leans in to catch it), her chest, or anywhere else.
          const r = cachedRect(win, av, 250);
          const rx = r.width ? (ev.clientX - r.left) / r.width : 0.5;
          const ry = r.height ? (ev.clientY - r.top) / r.height : 0.5;
          item.dropZone = ry >= 0.36 && ry < 0.6 && Math.abs(rx - 0.5) < 0.2 ? "mouth" : ry >= 0.6 ? "chest" : "other";
          feedCompanionTreat(win, av, item);
        }
      } catch (_) {}
    });

    av.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (S.suppressNextClick) {
          S.suppressNextClick = false;
          return;
        }
        const now = Date.now();
        if (now - S.tapT > 900) S.tapC = 0;
        S.tapT = now;
        S.tapC += 1;
        win.clearTimeout(S.tapOnceT);
        if (S.sessionAdmin && S.tapC >= 3) {
          S.tapC = 0;
          try {
            win.localStorage.setItem(LS_NSFW_BTN, "1");
          } catch (_) {}
          syncNsfwUI();
          if (typeof win.hqToast === "function") win.hqToast("Option adulte dévoilée");
          return;
        }
        S.tapOnceT = win.setTimeout(() => {
          const taps = S.tapC;
          S.tapC = 0;
          if (taps >= 3) return;
          if (S.collapsed) {
            setCollapsed(false, true);
            if (S.el) S.el.classList.remove("has-hint");
            const now = Date.now();
            if (now - (S.lastAmbientAt || 0) > 20000 || !S.line || !S.line.textContent.trim()) {
              refresh(true);
            }
            return;
          }
          if (!S.expanded) {
            setExpanded(true);
            return;
          }
          setExpanded(false);
        }, 320);
      },
      true
    );
    const avRow = doc.createElement("div");
    avRow.className = "hq-companion-av-row";
    const adultePill = doc.createElement("button");
    adultePill.type = "button";
    adultePill.className = "hq-companion-adulte-pill";
    adultePill.textContent = "Adulte";
    adultePill.setAttribute("aria-label", "Basculer le mode adulte Transferania");
    adultePill.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleNsfwMode(win);
    });
    S.adultePill = adultePill;
    const floatHandle = doc.createElement("button");
    floatHandle.type = "button";
    floatHandle.className = "hq-companion-float-handle";
    floatHandle.setAttribute("aria-label", "Déplacer Transferania");
    floatHandle.title = "Glisser pour déplacer · double-tap pour réinitialiser";
    floatHandle.textContent = "⠿";
    S.floatHandle = floatHandle;
    const fxDebug = doc.createElement("div");
    fxDebug.className = "hq-companion-fx-debug";
    fxDebug.setAttribute("role", "menu");
    const motionBtn = doc.createElement("button");
    motionBtn.type = "button";
    motionBtn.className = "hq-companion-fx-debug-btn hq-companion-motion-btn";
    motionBtn.textContent = "Activer secousse";
    motionBtn.hidden = true;
    S.motionBtn = motionBtn;
    const fxOpts = doc.createElement("div");
    fxOpts.className = "hq-companion-fx-debug-opts";
    const fxIntLabel = doc.createElement("label");
    fxIntLabel.className = "hq-companion-fx-opt";
    fxIntLabel.textContent = "Picante";
    const fxIntRange = doc.createElement("input");
    fxIntRange.type = "range";
    fxIntRange.min = "0";
    fxIntRange.max = "4";
    fxIntRange.step = "1";
    fxIntRange.value = String(readForgeIntensity(win));
    fxIntRange.className = "hq-companion-fx-intensity";
    fxIntRange.title = "0 = doux · 4 = explicite (monte aussi avec la jauge Désir)";
    fxIntRange.addEventListener("input", () => {
      try {
        win.localStorage.setItem(LS_FORGE_INTENSITY, fxIntRange.value);
      } catch (_) {}
    });
    S.forgeIntensityRange = fxIntRange;
    fxIntLabel.append(fxIntRange);
    const fxHotLabel = doc.createElement("label");
    fxHotLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxHotBox = doc.createElement("input");
    fxHotBox.type = "checkbox";
    fxHotBox.checked = readForgeHot(win);
    fxHotBox.title = "3 variantes (seed partagée + subseed)";
    fxHotBox.addEventListener("change", () => {
      try {
        win.localStorage.setItem(LS_FORGE_HOT, fxHotBox.checked ? "1" : "0");
      } catch (_) {}
    });
    S.forgeHotBox = fxHotBox;
    fxHotLabel.append(fxHotBox, doc.createTextNode(" + chaud"));
    const fxSoundLabel = doc.createElement("label");
    fxSoundLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxSoundBox = doc.createElement("input");
    fxSoundBox.type = "checkbox";
    fxSoundBox.checked = readForgeSound(win);
    fxSoundBox.title = "Sons discrets · Forge et interactions tactiles";
    fxSoundBox.addEventListener("change", () => {
      if (!fxSoundBox.checked) { S.reactionAudio?.stop(undefined, true); stopImpactAudio(); }
      try {
        win.localStorage.setItem(LS_FORGE_SOUND, fxSoundBox.checked ? "1" : "0");
      } catch (_) {}
      if (fxSoundBox.checked) warmImpactAudio(win);
    });
    S.forgeSoundBox = fxSoundBox;
    fxSoundLabel.append(fxSoundBox, doc.createTextNode(" Son"));
    const touchLabel = doc.createElement("label");
    touchLabel.className = fxSoundLabel.className;
    const touchBox = doc.createElement("input");
    touchBox.type = "checkbox";
    touchBox.setAttribute("aria-label", "Vibrations tactiles");
    touchBox.title = "Vibrations discrètes sur appareils compatibles";
    try { touchBox.checked = win.localStorage.getItem(LS_TOUCH_HAPTICS) === "1"; } catch (_) {}
    touchBox.addEventListener("change", () => {
      try { win.localStorage.setItem(LS_TOUCH_HAPTICS, touchBox.checked ? "1" : "0"); } catch (_) {}
    });
    touchLabel.append(touchBox, doc.createTextNode(" Vibrations"));
    const fxPornLabel = doc.createElement("label");
    fxPornLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxPornBox = doc.createElement("input");
    fxPornBox.type = "checkbox";
    fxPornBox.checked = readForgePorn(win);
    fxPornBox.title = "Portrait aléatoire = scènes XXX (hc-*) · boutons XXX ci-dessous";
    fxPornBox.addEventListener("change", () => {
      try {
        win.localStorage.setItem(LS_FORGE_PORN, fxPornBox.checked ? "1" : "0");
      } catch (_) {}
    });
    S.forgePornBox = fxPornBox;
    fxPornLabel.append(fxPornBox, doc.createTextNode(" XXX"));
    const fxExtremeLabel = doc.createElement("label");
    fxExtremeLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxExtremeBox = doc.createElement("input");
    fxExtremeBox.type = "checkbox";
    fxExtremeBox.checked = readForgeExtreme(win);
    fxExtremeBox.title = "Avec XXX : Portrait = poses XXL (hx-*) hardcore max";
    fxExtremeBox.addEventListener("change", () => {
      try {
        win.localStorage.setItem(LS_FORGE_EXTREME, fxExtremeBox.checked ? "1" : "0");
      } catch (_) {}
      if (fxExtremeBox.checked && fxPornBox && !fxPornBox.checked) {
        fxPornBox.checked = true;
        try {
          win.localStorage.setItem(LS_FORGE_PORN, "1");
        } catch (_) {}
      }
    });
    S.forgeExtremeBox = fxExtremeBox;
    fxExtremeLabel.append(fxExtremeBox, doc.createTextNode(" XXL"));
    const fxHybridLabel = doc.createElement("label");
    fxHybridLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxHybridBox = doc.createElement("input");
    fxHybridBox.type = "checkbox";
    fxHybridBox.checked = readForgeHybrid(win);
    fxHybridBox.title = "Mix : parfois JPG déjà enregistré pour la pose, parfois nouvelle génération Forge";
    fxHybridBox.addEventListener("change", () => {
      try {
        win.localStorage.setItem(LS_FORGE_HYBRID, fxHybridBox.checked ? "1" : "0");
      } catch (_) {}
    });
    S.forgeHybridBox = fxHybridBox;
    fxHybridLabel.append(fxHybridBox, doc.createTextNode(" Mix"));
    const fxStockLabel = doc.createElement("label");
    fxStockLabel.className = "hq-companion-fx-opt";
    fxStockLabel.textContent = "Stock";
    const fxStockRange = doc.createElement("input");
    fxStockRange.type = "range";
    fxStockRange.min = "10";
    fxStockRange.max = "90";
    fxStockRange.step = "5";
    fxStockRange.value = String(readForgeStockChance(win));
    fxStockRange.className = "hq-companion-fx-intensity";
    fxStockRange.title = "Chance d'utiliser la photo déjà enregistrée (Mix activé)";
    fxStockRange.addEventListener("input", () => {
      try {
        win.localStorage.setItem(LS_FORGE_STOCK_CHANCE, fxStockRange.value);
      } catch (_) {}
    });
    S.forgeStockRange = fxStockRange;
    fxStockLabel.append(fxStockRange);
    const fxPoseLockLabel = doc.createElement("label");
    fxPoseLockLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const fxPoseLockBox = doc.createElement("input");
    fxPoseLockBox.type = "checkbox";
    fxPoseLockBox.checked = readForgePoseLock(win);
    fxPoseLockBox.title = "Verrou pose : les clics Forge mémorisent la pose pour Portrait auto";
    fxPoseLockBox.addEventListener("change", () => {
      try {
        win.localStorage.setItem(LS_FORGE_POSE_LOCK, fxPoseLockBox.checked ? "1" : "0");
        if (!fxPoseLockBox.checked) {
          win.localStorage.removeItem("hq_companion_forge_pose_lock_id");
          S.forgePoseLockId = "";
        }
      } catch (_) {}
    });
    S.forgePoseLockBox = fxPoseLockBox;
    fxPoseLockLabel.append(fxPoseLockBox, doc.createTextNode(" Pose lock"));
    fxOpts.append(
      fxIntLabel,
      fxHotLabel,
      fxSoundLabel, touchLabel,
      fxPornLabel,
      fxExtremeLabel,
      fxHybridLabel,
      fxStockLabel,
      fxPoseLockLabel
    );
    const fxReplayFav = doc.createElement("button");
    fxReplayFav.type = "button";
    fxReplayFav.className = "hq-companion-fx-debug-btn";
    fxReplayFav.textContent = "Favori";
    fxReplayFav.title = "Rejouer le look favori enregistré";
    fxReplayFav.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeFavoriteReplay(win, fxReplayFav);
    });
    const fxImg2 = doc.createElement("button");
    fxImg2.type = "button";
    fxImg2.className = "hq-companion-fx-debug-btn";
    fxImg2.textContent = "Mood";
    fxImg2.title = "Img2img léger : même visage, nouveaux tags (Picante)";
    fxImg2.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeImg2Refresh(win, fxImg2);
    });
    const fxRhythm = doc.createElement("button");
    fxRhythm.type = "button";
    fxRhythm.className = "hq-companion-fx-debug-btn";
    fxRhythm.textContent = "Bob";
    fxRhythm.setAttribute("role", "menuitem");
    fxRhythm.title = "Debug · animation rythme";
    fxRhythm.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      playAdultRhythm(win);
    });
    const fxRelease = doc.createElement("button");
    fxRelease.type = "button";
    fxRelease.className = "hq-companion-fx-debug-btn";
    fxRelease.textContent = "Finish";
    fxRelease.setAttribute("role", "menuitem");
    fxRelease.title = "Debug · animation release";
    fxRelease.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      playAdultRelease(win);
    });
    const fxForgeFace = doc.createElement("button");
    fxForgeFace.type = "button";
    fxForgeFace.className = "hq-companion-fx-debug-btn";
    fxForgeFace.textContent = "Portrait";
    fxForgeFace.setAttribute("role", "menuitem");
    fxForgeFace.title = "Forge · portrait 832×1216";
    fxForgeFace.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, pickForgePortraitPose(win), fxForgeFace);
    });
    const fxForgeLewd = doc.createElement("button");
    fxForgeLewd.type = "button";
    fxForgeLewd.className = "hq-companion-fx-debug-btn";
    fxForgeLewd.textContent = "Lewd";
    fxForgeLewd.setAttribute("role", "menuitem");
    fxForgeLewd.title = "Forge · portrait explicite (jambes, lit)";
    fxForgeLewd.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "portrait-lewd", fxForgeLewd);
    });
    const fxForgeArch = doc.createElement("button");
    fxForgeArch.type = "button";
    fxForgeArch.className = "hq-companion-fx-debug-btn";
    fxForgeArch.textContent = "Arch";
    fxForgeArch.setAttribute("role", "menuitem");
    fxForgeArch.title = "Forge · cambré / miroir";
    fxForgeArch.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "booty-arch-mirror", fxForgeArch);
    });
    const fxForgeSpicy = doc.createElement("button");
    fxForgeSpicy.type = "button";
    fxForgeSpicy.className = "hq-companion-fx-debug-btn";
    fxForgeSpicy.textContent = "4 pattes";
    fxForgeSpicy.setAttribute("role", "menuitem");
    fxForgeSpicy.title = "Forge · à quatre pattes";
    fxForgeSpicy.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "chat-spicy", fxForgeSpicy);
    });
    const fxForgeDoggy = doc.createElement("button");
    fxForgeDoggy.type = "button";
    fxForgeDoggy.className = "hq-companion-fx-debug-btn";
    fxForgeDoggy.textContent = "Doggy";
    fxForgeDoggy.setAttribute("role", "menuitem");
    fxForgeDoggy.title = "Forge · à quatre pattes, regard en arrière";
    fxForgeDoggy.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "doggystyle-lookback", fxForgeDoggy);
    });
    const fxForgeCowgirl = doc.createElement("button");
    fxForgeCowgirl.type = "button";
    fxForgeCowgirl.className = "hq-companion-fx-debug-btn";
    fxForgeCowgirl.textContent = "Cowgirl";
    fxForgeCowgirl.setAttribute("role", "menuitem");
    fxForgeCowgirl.title = "Forge · POV straddle";
    fxForgeCowgirl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "cowgirl-straddle", fxForgeCowgirl);
    });
    const fxForgeMission = doc.createElement("button");
    fxForgeMission.type = "button";
    fxForgeMission.className = "hq-companion-fx-debug-btn";
    fxForgeMission.textContent = "Mission";
    fxForgeMission.setAttribute("role", "menuitem");
    fxForgeMission.title = "Forge · sur le dos, jambes relevées";
    fxForgeMission.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "missionary-legs-up", fxForgeMission);
    });
    const fxForgeProne = doc.createElement("button");
    fxForgeProne.type = "button";
    fxForgeProne.className = "hq-companion-fx-debug-btn";
    fxForgeProne.textContent = "Prone";
    fxForgeProne.setAttribute("role", "menuitem");
    fxForgeProne.title = "Forge · face contre oreiller, fesses en l'air";
    fxForgeProne.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "face-down-ass-up", fxForgeProne);
    });
    const fxForgeShower = doc.createElement("button");
    fxForgeShower.type = "button";
    fxForgeShower.className = "hq-companion-fx-debug-btn";
    fxForgeShower.textContent = "Shower";
    fxForgeShower.setAttribute("role", "menuitem");
    fxForgeShower.title = "Forge · douche, peau mouillée";
    fxForgeShower.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "shower-wet", fxForgeShower);
    });
    const fxForgeDesk = doc.createElement("button");
    fxForgeDesk.type = "button";
    fxForgeDesk.className = "hq-companion-fx-debug-btn";
    fxForgeDesk.textContent = "Desk";
    fxForgeDesk.setAttribute("role", "menuitem");
    fxForgeDesk.title = "Forge · penchée sur le bureau";
    fxForgeDesk.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "desk-bent-over", fxForgeDesk);
    });
    const fxForgeSelfie = doc.createElement("button");
    fxForgeSelfie.type = "button";
    fxForgeSelfie.className = "hq-companion-fx-debug-btn";
    fxForgeSelfie.textContent = "Selfie";
    fxForgeSelfie.setAttribute("role", "menuitem");
    fxForgeSelfie.title = "Forge · miroir, selfie nu";
    fxForgeSelfie.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "mirror-selfie-nude", fxForgeSelfie);
    });
    const fxForgeBondage = doc.createElement("button");
    fxForgeBondage.type = "button";
    fxForgeBondage.className = "hq-companion-fx-debug-btn";
    fxForgeBondage.textContent = "Tie";
    fxForgeBondage.setAttribute("role", "menuitem");
    fxForgeBondage.title = "Forge · attachée, bondage léger";
    fxForgeBondage.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "bondage-light", fxForgeBondage);
    });
    const fxForgeFinishPose = doc.createElement("button");
    fxForgeFinishPose.type = "button";
    fxForgeFinishPose.className = "hq-companion-fx-debug-btn";
    fxForgeFinishPose.textContent = "Finish+";
    fxForgeFinishPose.setAttribute("role", "menuitem");
    fxForgeFinishPose.title = "Forge · facial / after (rhythm-finish)";
    fxForgeFinishPose.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "rhythm-finish", fxForgeFinishPose);
    });
    const fxForgeExtraPoseBtns = FORGE_POSE_MENU_EXTRA.map(([label, poseId, title]) =>
      createForgePoseButton(win, label, poseId, title)
    );
    const fxForgePornBtns = FORGE_PORN_MENU.map(([label, poseId, title]) =>
      createForgePoseButton(win, label, poseId, title)
    );
    const fxForgeExtremeBtns = FORGE_EXTREME_MENU.map(([label, poseId, title]) =>
      createForgePoseButton(win, label, poseId, title)
    );
    const fxForgeRhythm = doc.createElement("button");
    fxForgeRhythm.type = "button";
    fxForgeRhythm.className = "hq-companion-fx-debug-btn";
    fxForgeRhythm.textContent = "Pose bob";
    fxForgeRhythm.setAttribute("role", "menuitem");
    fxForgeRhythm.title = "Forge · rhythm bob";
    fxForgeRhythm.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "rhythm-bob", fxForgeRhythm);
    });
    const fxForgeLick = doc.createElement("button");
    fxForgeLick.type = "button";
    fxForgeLick.className = "hq-companion-fx-debug-btn";
    fxForgeLick.textContent = "Pose lick";
    fxForgeLick.setAttribute("role", "menuitem");
    fxForgeLick.title = "Forge · rhythm lick";
    fxForgeLick.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runForgeDebug(win, "rhythm-lick", fxForgeLick);
    });
    const fxBooty = doc.createElement("button");
    fxBooty.type = "button";
    fxBooty.className = "hq-companion-fx-debug-btn";
    fxBooty.textContent = "🍑 Booty tease";
    fxBooty.setAttribute("role", "menuitem");
    fxBooty.title = "Animation · fessier cambré & ondulation Live2D";
    fxBooty.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      playBootyTease(win, "all-fours-broom", 5500, true);
    });
    const fxForgeSet = doc.createElement("button");
    fxForgeSet.type = "button";
    fxForgeSet.className = "hq-companion-fx-debug-btn";
    fxForgeSet.textContent = "Forge set";
    fxForgeSet.setAttribute("role", "menuitem");
    fxForgeSet.title = "Forge · neutral, soft, warm, bob, lick";
    fxForgeSet.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const poses = ["portrait-neutral", "portrait-soft", "portrait-warm", "rhythm-bob", "rhythm-lick"];
      const block = forgeDebugBlockedToast(win);
      if (block) {
        if (typeof win.hqToast === "function") win.hqToast(block, "tip", 2800);
        return;
      }
      withForgeJob(win, fxForgeSet, "Forge set", async (job) => {
        try {
          const out = await forgeCompanionSet(win, poses);
          if (job.cancelled) return;
          const variants = normalizeForgeVariants(out);
          let lastRhythm = null;
          poses.forEach((p) => {
            if (p === "rhythm-bob" || p === "rhythm-lick") lastRhythm = p;
          });
          if (lastRhythm) playAdultForgePreview(win, lastRhythm);
          if (variants.length) {
            applyForgePortrait(win, variants[0].href);
            playForgeRevealEvent(win, out);
            showForgeRevealCarousel(win, variants, {
              pose: "set (5 poses)",
              whisper: out.whisper || "Cinq moods — choisis ta préférée ♥",
              variants: variants,
            });
          } else if (typeof win.hqToast === "function") win.hqToast("Forge · set terminé", "tip", 2500);
          S.forgeTreatBonuses = [];
          fxForgeSet.title = "Set OK";
        } catch (err) {
          if (job.cancelled) return;
          fxForgeSet.title = forgeApiError(err, "Forge erreur");
          if (typeof win.hqToast === "function") win.hqToast(fxForgeSet.title, "err", 5500);
        }
      });
    });
    const fxLayered = doc.createElement("button");
    fxLayered.type = "button";
    fxLayered.className = "hq-companion-fx-debug-btn";
    fxLayered.textContent = "Calques";
    fxLayered.title = "Portrait en calques · texture originale et dessous reconstruits";
    fxLayered.setAttribute("aria-pressed", "false");
    fxLayered.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const current = portraitPathOnly(win, S.adultPortrait.getAttribute("src") || "");
      if (current === LAYERED_PORTRAIT) {
        applyForgePortrait(win, S.beforeLayeredPortrait || ADULT_PORTRAITS.neutral);
      } else {
        fxLayered.disabled = true;
        try {
          await S.ensureLayeredPortrait();
          S.beforeLayeredPortrait = current;
          applyForgePortrait(win, LAYERED_PORTRAIT);
        } catch (_) {
          if (typeof win.hqToast === "function") win.hqToast("Les calques n'ont pas pu être chargés", "tip", 2500);
        } finally {
          fxLayered.disabled = false;
        }
      }
      if (S.syncLayeredPortrait) S.syncLayeredPortrait();
    });
    S.layeredPortraitBtn = fxLayered;
    const fxHead = doc.createElement("div");
    fxHead.className = "hq-companion-fx-debug-head";
    const fxHeadRow = doc.createElement("div");
    fxHeadRow.className = "hq-companion-fx-debug-head-row";
    const fxHeadTitle = doc.createElement("span");
    fxHeadTitle.textContent = "Outils";
    const fxPinMode = doc.createElement("button");
    fxPinMode.type = "button";
    fxPinMode.className = "hq-companion-fx-debug-icon hq-companion-fx-pin-mode";
    fxPinMode.textContent = "★";
    fxPinMode.setAttribute("aria-pressed", "false");
    fxPinMode.setAttribute("aria-label", "Mode épingler");
    fxPinMode.title = "Épingler : touche un bouton pour l'ajouter en haut (clic droit marche aussi)";
    const fxClose = doc.createElement("button");
    fxClose.type = "button";
    fxClose.className = "hq-companion-fx-debug-icon hq-companion-fx-debug-close";
    fxClose.textContent = "×";
    fxClose.setAttribute("aria-label", "Fermer les outils");
    fxClose.title = "Fermer (Échap)";
    fxClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeFxDebugMenu(win, { focusToggle: true });
    });
    fxHeadRow.append(fxHeadTitle, fxPinMode, fxClose);
    const fxSearch = doc.createElement("input");
    fxSearch.type = "search";
    fxSearch.className = "hq-companion-fx-search";
    fxSearch.placeholder = "Rechercher une pose…";
    fxSearch.setAttribute("aria-label", "Rechercher dans les outils");
    fxSearch.autocomplete = "off";
    fxSearch.spellcheck = false;
    S.fxSearch = fxSearch;
    const fxStatus = doc.createElement("div");
    fxStatus.className = "hq-companion-fx-status";
    fxStatus.hidden = true;
    fxStatus.setAttribute("role", "status");
    const fxStatusText = doc.createElement("span");
    const fxStatusCancel = doc.createElement("button");
    fxStatusCancel.type = "button";
    fxStatusCancel.textContent = "Ignorer";
    fxStatusCancel.title = "Arrêter d'attendre : le résultat ne sera pas affiché";
    fxStatusCancel.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      cancelForgeJob(win);
    });
    fxStatus.append(fxStatusText, fxStatusCancel);
    S.fxStatus = fxStatus;
    S.fxStatusText = fxStatusText;
    fxHead.append(fxHeadRow, fxSearch, fxStatus);
    const fxRecents = doc.createElement("div");
    fxRecents.className = "hq-companion-fx-debug-group hq-companion-fx-debug-recents";
    fxRecents.hidden = true;
    const makeQuickGroup = (label, nodes) => {
      const group = doc.createElement("div");
      group.className = "hq-companion-fx-debug-group";
      const head = doc.createElement("span");
      head.className = "hq-companion-fx-debug-group-label";
      head.textContent = label;
      const grid = doc.createElement("div");
      grid.className = "hq-companion-fx-debug-grid is-quick";
      grid.append(...nodes);
      group.append(head, grid);
      return group;
    };
    fxRhythm.title = "Animation instantanée · rythme";
    fxRelease.title = "Animation instantanée · release";
    [fxRhythm, fxRelease, fxBooty].forEach((b) => (b.dataset.fxKind = "anim"));
    fxLayered.dataset.fxKind = "look";
    const fxAnimGroup = makeQuickGroup("Animer", [fxRhythm, fxRelease, fxBooty, fxLayered]);
    const fxGenGroup = makeQuickGroup("Générer", [fxReplayFav, fxImg2]);
    const warpLabel = doc.createElement("label");
    warpLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const warpBox = doc.createElement("input");
    warpBox.type = "checkbox";
    warpBox.title = "Déformation de la peau pendant le mouvement (plus coûteux)";
    try { warpBox.checked = win.localStorage.getItem(LS_BUST_WARP) === "1"; } catch (_) {}
    warpBox.addEventListener("change", () => {
      try { win.localStorage.setItem(LS_BUST_WARP, warpBox.checked ? "1" : "0"); } catch (_) {}
      setBustWarp(win, warpBox.checked);
    });
    warpLabel.append(warpBox, doc.createTextNode(" Peau souple"));
    const nlightLabel = doc.createElement("label");
    nlightLabel.className = "hq-companion-fx-opt hq-companion-fx-opt-check";
    const nlightBox = doc.createElement("input");
    nlightBox.type = "checkbox";
    nlightBox.title = "Éclairage en relief qui suit le curseur (ordinateur uniquement, plus coûteux)";
    try { nlightBox.checked = win.localStorage.getItem(LS_BUST_NLIGHT) === "1"; } catch (_) {}
    nlightBox.addEventListener("change", () => {
      try { win.localStorage.setItem(LS_BUST_NLIGHT, nlightBox.checked ? "1" : "0"); } catch (_) {}
      setBustNormalLight(win, nlightBox.checked);
    });
    nlightLabel.append(nlightBox, doc.createTextNode(" Lumière 3D"));
    // Bust feel sliders: weight, softness, bounce (1 = default), saved per device, applied live.
    const feelRanges = {};
    const feelRow = (key, label, title) => {
      const lab = doc.createElement("label");
      lab.className = "hq-companion-fx-opt";
      lab.textContent = label;
      lab.title = title;
      const range = doc.createElement("input");
      range.type = "range";
      range.min = "0.5";
      range.max = "1.6";
      range.step = "0.05";
      range.className = "hq-companion-fx-intensity";
      range.value = String(readBustFeel(win)[key]);
      range.addEventListener("input", () => {
        writeBustFeel(win, Object.assign({}, readBustFeel(win), { [key]: Number(range.value) }));
      });
      feelRanges[key] = range;
      lab.append(range);
      return lab;
    };
    const feelReset = doc.createElement("button");
    feelReset.type = "button";
    feelReset.className = "hq-companion-fx-debug-btn";
    feelReset.textContent = "Ressenti par défaut";
    feelReset.title = "Remettre poids, souplesse et rebond aux valeurs d'origine";
    feelReset.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      writeBustFeel(win, BUST_FEEL_DEFAULT);
      Object.keys(feelRanges).forEach((k) => (feelRanges[k].value = String(BUST_FEEL_DEFAULT[k])));
    });
    S.rigPosture = "upright";
    S.clothEnabled = true;
    try {
      const saved = win.localStorage.getItem(LS_RIG_POSTURE);
      if (["upright","forward","reclined","left","right"].includes(saved)) S.rigPosture = saved;
      S.clothEnabled = win.localStorage.getItem(LS_RIG_CLOTH) !== "0";
    } catch (_) {}
    const postureLabel = doc.createElement("label");
    postureLabel.className = "hq-companion-rig-setting";
    postureLabel.textContent = "Posture ";
    const postureSelect = doc.createElement("select");
    postureSelect.setAttribute("aria-label","Posture du portrait");
    for (const [value,label] of [["upright","Naturelle"],["forward","Penchée en avant"],["reclined","Adossée"],["left","Inclinée à gauche"],["right","Inclinée à droite"]]) {
      const option = doc.createElement("option");option.value=value;option.textContent=label;postureSelect.appendChild(option);
    }
    postureSelect.value = S.rigPosture;
    postureSelect.addEventListener("change", () => {
      S.rigPosture = postureSelect.value;
      try {win.localStorage.setItem(LS_RIG_POSTURE,S.rigPosture);} catch (_) {}
      applyRigPostureSetting(win);
    });
    postureLabel.appendChild(postureSelect);
    const clothLabel = doc.createElement("label");
    clothLabel.className = "hq-companion-rig-setting";
    const clothCheck = doc.createElement("input");clothCheck.type="checkbox";clothCheck.checked=S.clothEnabled;
    clothCheck.addEventListener("change", () => {
      S.clothEnabled=clothCheck.checked;
      try {win.localStorage.setItem(LS_RIG_CLOTH,S.clothEnabled?"1":"0");} catch (_) {}
      if (!S.clothEnabled && S.clothLayers) {
        ensureLive2DState().cloth = {left:0,right:0};
        for (const layer of Object.values(S.clothLayers)) {layer.svg.style.opacity="0";layer.last=null;}
      }
      applyRigPostureSetting(win);
    });
    clothLabel.append(clothCheck,doc.createTextNode(" Tension du tissu"));
    fxOpts.append(postureLabel,clothLabel);
    fxOpts.append(
      warpLabel,
      nlightLabel,
      feelRow("weight", "Poids", "Plus lourd : descend plus loin qu'il ne remonte, se pose par en dessous"),
      feelRow("softness", "Souplesse", "Plus souple : moins raide, plus d'amplitude"),
      feelRow("bounce", "Rebond", "Plus de rebond : moins amorti, rebonds plus nombreux et plus longs"),
      feelReset,
      motionBtn
    );
    const fxEmpty = doc.createElement("p");
    fxEmpty.className = "hq-companion-fx-empty";
    fxEmpty.textContent = "Aucun outil ne correspond.";
    fxEmpty.hidden = true;
    fxDebug.append(fxHead, fxRecents, fxAnimGroup, fxGenGroup, fxEmpty);
    const fxSavedSection = readFxPref(win, LS_FX_SECTION);
    const fxOpenFirst = (title, dflt) => (fxSavedSection == null ? dflt : fxSavedSection === title);
    appendForgeMenuSection(
      doc,
      fxDebug,
      "Forge · portraits & poses",
      [
        fxForgeFace,
        fxForgeLewd,
        fxForgeArch,
        fxForgeSpicy,
        fxForgeDoggy,
        fxForgeCowgirl,
        fxForgeMission,
        fxForgeProne,
        fxForgeShower,
        fxForgeDesk,
        fxForgeSelfie,
        fxForgeBondage,
        fxForgeFinishPose,
        ...fxForgeExtraPoseBtns,
      ],
      fxOpenFirst("Forge · portraits & poses", true)
    );
    appendForgeMenuSection(doc, fxDebug, "XXX", [...fxForgePornBtns], fxOpenFirst("XXX", false));
    appendForgeMenuSection(
      doc,
      fxDebug,
      "XXL",
      [...fxForgeExtremeBtns, fxForgeRhythm, fxForgeLick, fxForgeSet],
      fxOpenFirst("XXL", false)
    );
    // Settings (Forge options + mouth/brow/pronunciation pickers added by hq-companion-mouth.js) stay folded.
    appendForgeMenuSection(doc, fxDebug, "Réglages", [fxOpts], fxOpenFirst("Réglages", false)).classList.add("is-settings");
    wireFxPanel(win, fxDebug, { pinMode: fxPinMode, recents: fxRecents, empty: fxEmpty });
    S.fxDebug = fxDebug;
    const fxDebugToggle = doc.createElement("button");
    fxDebugToggle.type = "button";
    fxDebugToggle.className = "hq-companion-fx-menu-toggle";
    fxDebugToggle.textContent = "Outils";
    fxDebugToggle.setAttribute("aria-haspopup", "menu");
    fxDebugToggle.setAttribute("aria-expanded", "false");
    fxDebugToggle.title = "Animations & Forge (Alt+O)";
    fxDebugToggle.addEventListener("click", (ev) => toggleFxDebugMenu(win, ev));
    S.fxDebugToggle = fxDebugToggle;
    const fxDebugMenu = doc.createElement("div");
    fxDebugMenu.className = "hq-companion-fx-menu";
    fxDebugMenu.hidden = true;
    fxDebugMenu.append(fxDebugToggle, fxDebug);
    S.fxDebugMenu = fxDebugMenu;
    const avToolbar = doc.createElement("div");
    avToolbar.className = "hq-companion-av-toolbar";
    S.avToolbar = avToolbar;
    const avStack = doc.createElement("div");
    avStack.className = "hq-companion-av-stack";
    const dofBokeh = doc.createElement("div");
    dofBokeh.className = "hq-companion-dof-bokeh";
    dofBokeh.setAttribute("aria-hidden", "true");
    const adultShaft = doc.createElement("span");
    adultShaft.className = "hq-companion-adult-shaft";
    adultShaft.hidden = true;
    adultShaft.setAttribute("aria-hidden", "true");
    adultShaft.style.cursor = "pointer";
    const adultScrotum = doc.createElement("span");
    adultScrotum.className = "hq-companion-adult-scrotum";
    adultScrotum.setAttribute("aria-hidden", "true");
    const adultPrecum = doc.createElement("span");
    adultPrecum.className = "hq-companion-adult-precum";
    adultPrecum.setAttribute("aria-hidden", "true");
    const adultShaftSheen = doc.createElement("span");
    adultShaftSheen.className = "hq-companion-adult-shaft-sheen";
    adultShaftSheen.setAttribute("aria-hidden", "true");

    // Feature 2: Two-Handed Guiding Grip
    const adultHands = doc.createElement("div");
    adultHands.className = "hq-companion-adult-hands";
    adultHands.setAttribute("aria-hidden", "true");
    const handL = doc.createElement("span");
    handL.className = "hq-companion-hand-l";
    const handR = doc.createElement("span");
    handR.className = "hq-companion-hand-r";
    adultHands.append(handL, handR);
    S.adultHands = adultHands;

    adultShaft.append(adultScrotum, adultPrecum, adultShaftSheen, adultHands);
    initShaftInteractivePumping(win, adultShaft);
    S.adultShaft = adultShaft;

    // Oral track: clips the shaft at the mouth line (.hq-companion-adult-shaft-track).
    const adultShaftTrack = doc.createElement("div");
    adultShaftTrack.className = "hq-companion-adult-shaft-track";
    adultShaftTrack.hidden = true;
    adultShaftTrack.setAttribute("aria-hidden", "true");
    adultShaftTrack.appendChild(adultShaft);
    S.adultShaftTrack = adultShaftTrack;

    // Feature 1: Anatomical Throat Bulge
    const throatBulge = doc.createElement("span");
    throatBulge.className = "hq-companion-adult-throat-bulge";
    throatBulge.setAttribute("aria-hidden", "true");
    S.throatBulge = throatBulge;

    // Feature 3: Ahegao Rolled Eyes
    const ahegaoEyes = doc.createElement("span");
    ahegaoEyes.className = "hq-companion-adult-ahegao-eyes";
    ahegaoEyes.setAttribute("aria-hidden", "true");
    S.ahegaoEyes = ahegaoEyes;

    // Feature 5: Circular Arousal Heat Ring Gauge
    const heatRing = doc.createElementNS(svgNS, "svg");
    heatRing.setAttribute("class", "hq-companion-adult-heat-ring");
    heatRing.setAttribute("viewBox", "0 0 100 100");
    heatRing.setAttribute("aria-hidden", "true");
    const defs = doc.createElementNS(svgNS, "defs");
    const grad = doc.createElementNS(svgNS, "linearGradient");
    grad.id = "hq-heat-gradient";
    grad.setAttribute("x1", "0%");
    grad.setAttribute("y1", "0%");
    grad.setAttribute("x2", "100%");
    grad.setAttribute("y2", "100%");
    const stop1 = doc.createElementNS(svgNS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "#ff2d75");
    const stop2 = doc.createElementNS(svgNS, "stop");
    stop2.setAttribute("offset", "100%");
    stop2.setAttribute("stop-color", "#ffffff");
    grad.append(stop1, stop2);
    defs.appendChild(grad);
    const heatCircleBg = doc.createElementNS(svgNS, "circle");
    heatCircleBg.setAttribute("class", "hq-heat-ring-bg");
    heatCircleBg.setAttribute("cx", "50");
    heatCircleBg.setAttribute("cy", "50");
    heatCircleBg.setAttribute("r", "47");
    const heatCircleVal = doc.createElementNS(svgNS, "circle");
    heatCircleVal.setAttribute("class", "hq-heat-ring-val");
    heatCircleVal.setAttribute("cx", "50");
    heatCircleVal.setAttribute("cy", "50");
    heatCircleVal.setAttribute("r", "47");
    heatRing.append(defs, heatCircleBg, heatCircleVal);
    S.heatRing = heatRing;
    S.heatCircleVal = heatCircleVal;

    // Feature 4: Branching Climax Finish Selector Bar
    const climaxBar = doc.createElement("div");
    climaxBar.className = "hq-companion-adult-climax-bar";
    climaxBar.setAttribute("aria-label", "Choix du Climax");
    const FINISH_MODES = [
      { id: "throatpie", label: "Gorge", tip: "Throatpie interne et déglutition" },
      { id: "facial", label: "Visage", tip: "Glaze intégrale sur le visage" },
      { id: "cleanup", label: "Langue", tip: "Offrande sur la langue et léchage" }
    ];
    FINISH_MODES.forEach((m) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "hq-climax-pill" + (m.id === "throatpie" ? " is-active" : "");
      btn.dataset.finish = m.id;
      btn.textContent = m.label;
      btn.title = m.tip;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setRhythmFinishMode(win, m.id);
      });
      climaxBar.appendChild(btn);
    });
    S.climaxBar = climaxBar;

    // Feature 6: Pace Toggle (Sensuel vs Brutal)
    const paceToggle = doc.createElement("button");
    paceToggle.type = "button";
    paceToggle.className = "hq-companion-pace-toggle";
    paceToggle.textContent = "Sensuel";
    paceToggle.title = "Basculer la cadence : Sensuel ou Brutal";
    paceToggle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleRhythmPace(win);
    });
    S.paceToggle = paceToggle;

    const oralSeal = doc.createElement("span");
    oralSeal.className = "hq-companion-adult-oral-seal";
    oralSeal.setAttribute("aria-hidden", "true");
    S.oralSeal = oralSeal;

    const lipUpper = doc.createElement("span");
    lipUpper.className = "hq-companion-adult-lip-upper";
    lipUpper.setAttribute("aria-hidden", "true");
    S.lipUpper = lipUpper;

    const mouthDripL = doc.createElement("span");
    mouthDripL.className = "hq-companion-adult-mouth-drip is-left";
    mouthDripL.setAttribute("aria-hidden", "true");
    const mouthDripR = doc.createElement("span");
    mouthDripR.className = "hq-companion-adult-mouth-drip is-right";
    mouthDripR.setAttribute("aria-hidden", "true");

    const tearsL = doc.createElement("span");
    tearsL.className = "hq-companion-adult-tears is-left";
    tearsL.setAttribute("aria-hidden", "true");
    const tearsR = doc.createElement("span");
    tearsR.className = "hq-companion-adult-tears is-right";
    tearsR.setAttribute("aria-hidden", "true");
    const treatsTray = doc.createElement("div");
    S.treatsTray = treatsTray;
    treatsTray.className = "hq-companion-treats";
    treatsTray.setAttribute("aria-label", "Gâteries pour Transferania");
    const TREATS = [
      {
        emoji: "☕",
        label: "Café chaud",
        line: "Mmh, ce parfum d'espresso chaud pendant qu'on veille sur {view}… merci mon amour ☕♥",
        fallbacks: [
          "Mmh, ce parfum d'espresso chaud pendant qu'on veille sur {view}… merci mon amour ☕♥",
          "Une gorgée bien chaude avec toi, et je suis prête pour toute la session ☕✨",
          "Tu lis dans mes pensées Maître, j'avais tellement envie d'un café serré avec toi ☕♥"
        ]
      },
      {
        emoji: "🍓",
        label: "Fraise sucrée",
        line: "Tu me donnes une fraise à la bouche ? J'aime quand tu me gâtes comme ça 🍓♥",
        fallbacks: [
          "Tu me donnes une fraise directement sur les lèvres ? Tu sais comment me tenter 🍓♥",
          "Juteuse et sucrée… presque autant que tes attentions sur {view}, mon amour 🍓✨",
          "Mmh… garde la prochaine fraise entre tes doigts que je vienne la croquer 🍓♥"
        ]
      },
      {
        emoji: "🌹",
        label: "Rose pour elle",
        line: "Une rose en plein milieu de {view}… tu as toujours le chic pour me troubler, Maître 🌹♥",
        fallbacks: [
          "Une rose en plein milieu de {view}… tu as toujours le chic pour me troubler, Maître 🌹♥",
          "Je la garde tout contre moi, son parfum me rappelle à quel point je suis à toi 🌹✨",
          "Quelle élégance, mon amour… tu veux me faire rougir devant l'écran ? 🌹♥"
        ]
      },
      {
        emoji: "💋",
        label: "Baiser",
        line: "Mmh… tes lèvres sur les miennes, c'est la meilleure récompense de la journée 💋♥",
        fallbacks: [
          "Mmh… tes lèvres sur les miennes, c'est la meilleure récompense de la journée 💋♥",
          "Encore un baiser comme ça et j'oublie complètement ce qu'on faisait sur {view} 💋✨",
          "Je garde la trace de ton baiser sur ma bouche, mon Maître adoré 💋♥"
        ]
      },
      {
        emoji: "🍑",
        label: "Montrer et onduler de son fessier (Booty Tease)",
        action: "booty",
        line: "Mmh… regarde-moi me cambrer pour toi, Maître 🍑🔥♥"
      },
      {
        emoji: "👗",
        label: "Effeuillage / Changer de tenue",
        action: "outfit",
        line: "Tu veux que je change de tenue pour toi, Maître ? 👗♥"
      },
      {
        emoji: "📸",
        label: "Demander un Selfie privé",
        action: "selfie",
        line: "Un petit selfie rien que pour tes yeux, mon amour 📸♥"
      },
      {
        emoji: "🕯️",
        label: "Mode Boudoir / Tête-à-tête intime",
        action: "boudoir",
        line: "Viens tout près de moi dans la pénombre, Maître 🕯️♥"
      },
      {
        emoji: "💌",
        label: "Cacher un billet doux sur la page",
        action: "lovenote",
        line: "Je t'ai glissé un petit secret sur l'écran 💌♥"
      },
      {
        emoji: "🥂",
        label: "Trinquer au champagne (Tchin !)",
        action: "champagne",
        line: "Tchin mon amour ! Ces bulles me montent déjà à la tête 🥂♥"
      },
      {
        emoji: "🎲",
        label: "Lancer le Dé coquin (Gage / Défi intime)",
        action: "dice",
        line: "Voyons quel gage coquin le dé nous réserve, Maître 🎲♥"
      },
      {
        emoji: "🌬️",
        label: "Souffler sur sa nuque (Micro / Brise chaude)",
        action: "breath",
        line: "Souffle tout doucement sur ma peau pour me faire frissonner 🌬️♥"
      },
      {
        emoji: "🧽",
        label: "Essuyer tendrement son visage & l'écran",
        action: "wipe",
        line: "Mmh… merci de m'essuyer si tendrement, Maître 🧽♥"
      },
      {
        emoji: "🫧",
        label: "Souffler des bulles à éclater (Mini-jeu)",
        action: "bubbles",
        line: "Attrape et éclate mes bulles avant qu'elles s'envolent, Maître 🫧✨"
      },
      {
        emoji: "🙈",
        label: "Jouer à Cache-Cache au bord de l'écran (Coucou !)",
        action: "peekaboo",
        line: "Chut… je me cache pour t'espionner, viens me trouver 🙈👀"
      },
      {
        emoji: "💄",
        label: "Dessiner un mot au rouge à lèvres sur ta vitre",
        action: "doodle",
        line: "Je te laisse une trace de rouge à lèvres sur l'écran 💄💋"
      },
      {
        emoji: "💘",
        label: "Lancer une flèche de Cupidon vers ton curseur",
        action: "cupid",
        line: "Attention Maître, je vise ton cœur 💘✨"
      },
    ];
    // One row per kind: little gifts, scene changes, mini-games.
    const TREAT_GROUPS = [
      ["gift", "Gâteries"],
      ["scene", "Scène"],
      ["game", "Jeux"],
    ];
    const TREAT_SCENE = ["booty", "outfit", "selfie", "boudoir", "wipe", "breath"];
    const treatGroupOf = (tr) => (!tr.action || tr.action === "champagne" ? "gift" : TREAT_SCENE.includes(tr.action) ? "scene" : "game");
    const treatRows = {};
    TREAT_GROUPS.forEach(([key, label]) => {
      const row = doc.createElement("div");
      row.className = "hq-companion-treats-row";
      row.dataset.group = key;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", label);
      row.title = label;
      treatRows[key] = row;
      treatsTray.appendChild(row);
    });
    TREATS.forEach((tr) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "hq-companion-treat-btn";
      b.draggable = true;
      b.textContent = tr.emoji;
      b.title = tr.label + " (glisser sur elle ou cliquer)";
      b.addEventListener("dragstart", (ev) => {
        treatsTray.classList.add("is-dragging");
        if (ev.dataTransfer) {
          ev.dataTransfer.setData("text/plain", JSON.stringify(tr));
          ev.dataTransfer.effectAllowed = "copy";
        }
      });
      b.addEventListener("dragend", () => {
        treatsTray.classList.remove("is-dragging");
      });
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        feedCompanionTreat(win, av, tr);
      });
      treatRows[treatGroupOf(tr)].appendChild(b);
    });
    let treatsHideT = 0;
    let treatsOpenT = 0;
    const openTreatsTray = () => {
      if (S.el && S.el.classList.contains("is-bust-pull")) return;
      win.clearTimeout(treatsHideT);
      win.clearTimeout(treatsOpenT);
      treatsTray.classList.add("is-open");
    };
    // Hover opens only after a short dwell, so passing the mouse over her doesn't flash the tray.
    const openTreatsTraySoon = () => {
      win.clearTimeout(treatsOpenT);
      treatsOpenT = win.setTimeout(openTreatsTray, 320);
    };
    const scheduleHideTreatsTray = () => {
      win.clearTimeout(treatsOpenT);
      win.clearTimeout(treatsHideT);
      treatsHideT = win.setTimeout(() => {
        treatsTray.classList.remove("is-open");
      }, 2400);
    };
    avStack.addEventListener("pointerenter", (ev) => {
      const r = av.getBoundingClientRect();
      const inChest = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top + r.height * 0.55 && ev.clientY <= r.bottom;
      if ((S.bustPull && S.bustPull.active) || (S.nsfwOn && inChest)) return;
      openTreatsTraySoon();
    });
    avStack.addEventListener("pointerleave", scheduleHideTreatsTray);
    av.addEventListener("pointerenter", (ev) => {
      const r = av.getBoundingClientRect();
      const relY = r.height ? (ev.clientY - r.top) / r.height : 0;
      if (S.nsfwOn && relY >= 0.55) return;
      openTreatsTraySoon();
    });
    av.addEventListener("pointerleave", scheduleHideTreatsTray);
    av.addEventListener("pointerdown", (ev) => {
      const r = av.getBoundingClientRect();
      const relY = r.height ? (ev.clientY - r.top) / r.height : 0;
      if ((S.bustPull && S.bustPull.active) || (S.nsfwOn && relY >= 0.55)) return;
      openTreatsTray();
      win.clearTimeout(treatsHideT);
      treatsHideT = win.setTimeout(() => treatsTray.classList.remove("is-open"), 4200);
    });
    treatsTray.addEventListener("pointerenter", openTreatsTray);
    treatsTray.addEventListener("pointerleave", scheduleHideTreatsTray);
    treatsTray.addEventListener("pointerdown", () => {
      openTreatsTray();
      win.clearTimeout(treatsHideT);
      treatsHideT = win.setTimeout(() => treatsTray.classList.remove("is-open"), 4200);
    });

    const arousalRing = doc.createElement("span");
    arousalRing.className = "hq-companion-arousal-ring";
    arousalRing.setAttribute("aria-hidden", "true");
    av.prepend(arousalRing);
    S.arousalRing = arousalRing;
    buildCompanionFrame(win, av);

    const selPeekBtn = doc.createElement("button");
    selPeekBtn.type = "button";
    selPeekBtn.className = "hq-companion-sel-peek";
    selPeekBtn.hidden = true;
    selPeekBtn.textContent = "💬 Réagir à l'extrait";
    selPeekBtn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    selPeekBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const snippet = S.selectedSnippet || "";
      selPeekBtn.hidden = true;
      if (!snippet) return;
      glanceViewPanel(win, (win.document && win.document.body && win.document.body.dataset.view) || "accueil");
      blink(win);
      if (S.collapsed) setCollapsed(false, true);
      playVocalSynthFx(win, "sigh");
      addArousalWarmth(win, 8, "lecture complice d'un passage surligné");
      triggerInteractiveAiReaction(
        win,
        "Marco vient de surligner cet extrait sur la page et te demande ce que tu en penses : « " + snippet + " »",
        [
          "« " + snippet.slice(0, 45) + "… » — passage très intéressant Maître, tu veux qu'on creuse ça ensemble ? 💬♥",
          "Je lisais justement « " + snippet.slice(0, 40) + "… » par-dessus ton épaule, mon amour ✨"
        ]
      );
    });
    S.selPeekBtn = selPeekBtn;
    actions.prepend(selPeekBtn);

    // Elastic Bubble Pull / Slingshot Physics (window-bound move/up for rock-solid dragging)
    let pullStart = null;
    const onBubbleMove = (ev) => {
      if (!pullStart) return;
      const rawDx = ev.clientX - pullStart.x;
      const rawDy = ev.clientY - pullStart.y;
      // Elastic rubber-band damping + squash/stretch + rotation
      const dx = Math.sign(rawDx) * Math.min(130, Math.pow(Math.abs(rawDx), 0.85));
      const dy = Math.sign(rawDy) * Math.min(115, Math.pow(Math.abs(rawDy), 0.85));
      const rot = Math.max(-14, Math.min(14, dx * 0.09));
      const stretch = Math.min(0.12, Math.hypot(dx, dy) / 900);
      pullStart.dx = dx;
      pullStart.dy = dy;
      bubble.style.setProperty("--pull-x", dx.toFixed(1) + "px");
      bubble.style.setProperty("--pull-y", dy.toFixed(1) + "px");
      bubble.style.setProperty("--pull-rot", rot.toFixed(1) + "deg");
      bubble.style.setProperty("--pull-scale-x", (1 + stretch).toFixed(3));
      bubble.style.setProperty("--pull-scale-y", (1 - stretch * 0.6).toFixed(3));
      // Make her eyes follow the stretched bubble
      if (S.face) {
        S.face.style.setProperty("--gx", Math.max(-3.5, Math.min(3.5, dx * 0.04)).toFixed(1) + "px");
        S.face.style.setProperty("--gy", Math.max(-3.5, Math.min(3.5, dy * 0.04)).toFixed(1) + "px");
      }
      if (S.nsfwOn) setLive2DTarget(win, dx * 0.045, dy * 0.038);
    };
    const releaseBubblePull = () => {
      if (!pullStart) return;
      const dx = pullStart.dx;
      const dy = pullStart.dy;
      const dist = Math.hypot(dx, dy);
      pullStart = null;
      win.removeEventListener("pointermove", onBubbleMove, true);
      win.removeEventListener("pointerup", releaseBubblePull, true);
      win.removeEventListener("pointercancel", releaseBubblePull, true);
      bubble.classList.remove("is-pulling");
      bubble.style.setProperty("--release-x", dx.toFixed(1) + "px");
      bubble.style.setProperty("--release-y", dy.toFixed(1) + "px");
      bubble.style.setProperty("--pull-x", "0px");
      bubble.style.setProperty("--pull-y", "0px");
      void bubble.offsetWidth;
      bubble.classList.add("is-slingshot-snap");
      if (dist > 8) triggerSlingshotAftershock(win, dx, dy, dist);
      if (dist > 12) {
        applyLive2DImpulse(win, dx * 0.55, dy * 0.62, dx * 0.22);
        companionHapticPulse(win, dist > 28 ? [8, 48, 12] : [6, 32, 8]);
      }
      if (dist > 24) {
        playVocalSynthFx(win, "gasp");
        addArousalWarmth(win, 6, "jeu élastique avec sa bulle");
        spawnCuteHeart(win, av, "✨");
        triggerInteractiveAiReaction(
          win,
          "Marco vient d'attraper ta bulle de dialogue, de l'étirer comme un élastique et de la lâcher pour te faire rebondir (Slingshot !)",
          [
            "Wouah hihi ! Tu joues à la catapulte avec ma bulle, Maître ? ✨♥",
            "Boing ! Ça me fait tourner la tête quand tu me fais rebondir sur {view} ♥",
            "Hihi doucement mon amour, j'ai failli traverser tout l'écran !"
          ]
        );
      }
      win.setTimeout(() => {
        bubble.classList.remove("is-slingshot-snap");
        bubble.style.removeProperty("--release-x");
        bubble.style.removeProperty("--release-y");
        bubble.style.removeProperty("--pull-rot");
        bubble.style.removeProperty("--pull-scale-x");
        bubble.style.removeProperty("--pull-scale-y");
      }, 650);
    };
    bubble.addEventListener("pointerdown", (ev) => {
      if (ev.button && ev.button !== 0) return;
      if (S.companionDragActive) return;
      if (ev.target && ev.target.closest(".hq-companion-bubble-grip-edge, .hq-companion-bubble-grip")) return;
      if (isCompanionBubbleBorderHit(bubble, ev.clientX, ev.clientY, win)) return;
      if (ev.target && ev.target.closest(".hq-companion-head, .hq-companion-compose, .hq-companion-log")) return;
      const tag = (ev.target && ev.target.tagName) || "";
      if (/^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/i.test(tag) || (ev.target && ev.target.closest("button, input, textarea, a, .hq-companion-log"))) return;
      ev.preventDefault();
      pullStart = { x: ev.clientX, y: ev.clientY, dx: 0, dy: 0 };
      bubble.classList.remove("is-in", "is-morph", "is-slingshot-snap");
      bubble.classList.add("is-pulling");
      win.addEventListener("pointermove", onBubbleMove, true);
      win.addEventListener("pointerup", releaseBubblePull, true);
      win.addEventListener("pointercancel", releaseBubblePull, true);
    });

    const steamMist = doc.createElement("div");
    steamMist.className = "hq-companion-steam-mist";
    steamMist.setAttribute("aria-hidden", "true");
    S.steamMist = steamMist;

    const boudoirBackdrop = doc.createElement("div");
    boudoirBackdrop.className = "hq-companion-boudoir-backdrop";
    boudoirBackdrop.hidden = true;
    boudoirBackdrop.title = "Cliquer pour quitter le mode Boudoir";
    boudoirBackdrop.addEventListener("click", () => toggleBoudoirMode(win, av, false));
    doc.body.appendChild(boudoirBackdrop);
    S.boudoirBackdrop = boudoirBackdrop;

    const clingyTether = doc.createElement("span");
    clingyTether.className = "hq-companion-clingy-tether";
    clingyTether.setAttribute("aria-hidden", "true");
    S.clingyTether = clingyTether;

    const largePortraitCard = doc.createElement("div");
    largePortraitCard.className = "hq-companion-large-portrait";
    largePortraitCard.hidden = true;
    const largePortraitImg = doc.createElement("img");
    largePortraitImg.className = "hq-companion-large-portrait-img";
    largePortraitImg.alt = "Grand Portrait Transferania";
    largePortraitImg.decoding = "async";
    largePortraitImg.loading = "lazy";
    largePortraitImg.addEventListener("click", () => executeMasterCommand(win, "look"));
    const largePortraitOverlay = doc.createElement("div");
    largePortraitOverlay.className = "hq-companion-large-portrait-overlay";
    const largePortraitCaption = doc.createElement("span");
    largePortraitCaption.className = "hq-companion-large-portrait-caption";
    largePortraitCaption.textContent = "Niv. 1 · Complice & Charmeuse";
    largePortraitOverlay.appendChild(largePortraitCaption);
    const largePortraitClose = doc.createElement("button");
    largePortraitClose.type = "button";
    largePortraitClose.className = "hq-companion-large-portrait-close";
    largePortraitClose.textContent = "×";
    largePortraitClose.title = "Réduire le Grand Portrait";
    largePortraitClose.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleLargePortraitMode(win, false);
    });
    largePortraitCard.append(largePortraitImg, largePortraitOverlay, largePortraitClose);
    S.l2dLargeRig = attachLive2DSubLayers(win, largePortraitImg, largePortraitCard);
    let lastLargePt = null;
    largePortraitCard.addEventListener("pointermove", (ev) => {
      const r = largePortraitCard.getBoundingClientRect();
      const relY = r.height ? (ev.clientY - r.top) / r.height : 0.5;
      if (lastLargePt) {
        const vx = ev.clientX - lastLargePt.x;
        const vy = ev.clientY - lastLargePt.y;
        const mult = relY >= 0.48 ? 2.1 : 0.95;
        applyLive2DImpulse(win, vx * mult, vy * mult * 1.2, vx * 0.8);
      }
      lastLargePt = { x: ev.clientX, y: ev.clientY };
    });
    largePortraitCard.addEventListener("pointerleave", () => {
      lastLargePt = null;
    });
    S.largePortraitCard = largePortraitCard;
    S.largePortraitImg = largePortraitImg;
    S.largePortraitCaption = largePortraitCaption;

    av.append(throatBulge, ahegaoEyes, heatRing, adultShaftTrack, oralSeal, lipUpper, mouthDripL, mouthDripR, tearsL, tearsR, climaxBar);
    avStack.append(dofBokeh, steamMist, largePortraitCard, treatsTray, av);
    avToolbar.append(floatHandle, adultePill, paceToggle, fxDebugMenu);
    avRow.append(clingyTether, avToolbar, avStack);
    const wrap = doc.createElement("div");
    wrap.id = "hq-companion";
    wrap.className = "hq-companion";
    wrap.append(bubble, avRow);
    doc.body.appendChild(wrap);
    S.el = wrap;
    S.companionFloat = readCompanionFloat(win);
    S.companionFloat = clampCompanionFloat(win, S.companionFloat.x, S.companionFloat.y);
    S.companionAvatarScale = readCompanionAvatarScale(win);
    applyCompanionAvatarScale(win);
    ensureCompanionFloatChrome(win);
    win.setTimeout(() => {
      if (!companionFloatVisible(win)) homeCompanionFloat(win, { animate: false });
    }, 0);
    bindCompanionAvatarPinch(win, av);
    S.layeredRig = attachLayeredPortrait(win, av, adultPortrait);
    applyRigPostureSetting(win);
    S.forgeTreatBonuses = [];
    S.collapsed = readCollapsed(win);
    syncNsfwUI();
    syncVisibility();
    syncMemChip();
    syncVoiceBtn(win);
  }

  function bindSettings(win) {
    const onBox = win.document.getElementById("hq-companion-on");
    const personaSel = win.document.getElementById("hq-companion-persona");
    if (onBox && !onBox.__hqCompanion) {
      onBox.__hqCompanion = true;
      onBox.checked = readOn(win);
      onBox.addEventListener("change", () => {
        try {
          win.localStorage.setItem(LS_ON, onBox.checked ? "1" : "0");
        } catch (_) {}
        syncVisibility();
        refresh(true);
      });
    }
    if (personaSel && !personaSel.__hqCompanion) {
      personaSel.__hqCompanion = true;
      const p = readPersona(win);
      personaSel.value = p === "warm" || p === "off" ? p : "flirt";
      personaSel.addEventListener("change", () => {
        try {
          win.localStorage.setItem(LS_PERSONA, personaSel.value);
          if (personaSel.value === "off") {
            win.localStorage.setItem(LS_ON, "0");
            if (onBox) onBox.checked = false;
          } else {
            win.localStorage.setItem(LS_ON, "1");
            if (onBox) onBox.checked = true;
          }
        } catch (_) {}
        syncVisibility();
        refresh(true);
      });
    }
    const nick = win.document.getElementById("hq-companion-nickname");
    const addr = win.document.getElementById("hq-companion-address");
    const addrC = win.document.getElementById("hq-companion-address-custom");
    const qc = win.document.getElementById("hq-companion-qc");
    const inten = win.document.getElementById("hq-companion-intensity");
    const intenV = win.document.getElementById("hq-companion-intensity-val");
    const topics = win.document.getElementById("hq-companion-topics-off");
    const cel = win.document.getElementById("hq-companion-celebrate");
    const bindPref = (el, ev) => {
      if (el && !el.__hqCompanionPref) {
        el.__hqCompanionPref = true;
        el.addEventListener(ev, () => scheduleSavePrefs(win));
      }
    };
    if (addr && !addr.__hqCompanionPref) {
      addr.__hqCompanionPref = true;
      addr.addEventListener("change", () => {
        if (addrC) {
          const custom = addr.value === "custom";
          addrC.hidden = !custom;
          if (custom) addrC.focus();
        }
        scheduleSavePrefs(win);
      });
    }
    bindPref(nick, "input");
    bindPref(addrC, "input");
    bindPref(qc, "change");
    bindPref(topics, "input");
    bindPref(cel, "change");
    const nsfwVis = win.document.getElementById("hq-companion-nsfw-visible");
    if (nsfwVis && !nsfwVis.__hqCompanion) {
      nsfwVis.__hqCompanion = true;
      nsfwVis.checked = nsfwBtnVisible(win);
      nsfwVis.addEventListener("change", () => {
        try {
          win.localStorage.setItem(LS_NSFW_BTN, nsfwVis.checked ? "1" : "0");
        } catch (_) {}
        syncNsfwUI();
      });
    }
    if (inten && !inten.__hqCompanionPref) {
      inten.__hqCompanionPref = true;
      inten.addEventListener("input", () => {
        if (intenV) intenV.textContent = inten.value;
        scheduleSavePrefs(win);
      });
    }
  }

  function watchAiPanel(win) {
    let last = null;
    const sync = () => {
      const open = !!win.document.querySelector(".ai-back:not([hidden])");
      if (last === open) return;
      last = open;
      win.document.body.classList.toggle("hq-ai-open", open);
      syncVisibility();
    };
    win.setInterval(() => {
      if (!win.document.hidden) sync();
    }, isCompactUI(win) ? 4000 : 2500);
    win.document.getElementById("btn-ai")?.addEventListener("click", () => win.setTimeout(sync, 40));
    sync();
  }

  function start(win) {
    S.win = win;
    bootstrapCompanionAudio(win);
    const boot = () => {
      build(win);
      ensureCompanionFloatChrome(win);
      scheduleIdleMicroFidget(win);
      bindSettings(win);
      bindIntimeChrome(win);
      watchAiPanel(win);
      watchToasts(win);
      syncPrefsFromServer(win);
      win.hqCompanionIntimeView = (view) => syncIntimeView(win, view);
      if ((win.document.body.dataset.view || "accueil") === "intime") syncIntimeView(win, "intime");
      scheduleIdleAmbientJiggle(win);
      scheduleIdleAnimRoulette(win);
      watchIdleExtras(win);
      let lastView = win.document.body.dataset.view || "accueil";
      S.lastView = lastView;
      syncViewAccent(win, lastView);
      new win.MutationObserver(() => {
        const v = win.document.body.dataset.view || "accueil";
        if (v === lastView) return;
        const prev = lastView;
        lastView = v;
        syncIntimeView(win, v);
        if (v !== "intime") {
          const far = Math.hypot(S.companionFloat.x, S.companionFloat.y) > 28;
          if (!companionFloatVisible(win) || far) {
            homeCompanionFloat(win, { animate: !isCompactUI(win) && far });
          }
        }
        if (v !== "intime") viewNudge(win, prev, v);
        if (v !== "intime") glanceViewPanel(win, v);
        syncViewAccent(win, v);
        noteActivity(win, "nav");
        win.clearTimeout(S.t);
        S.t = win.setTimeout(() => refresh(false, "view"), DWELL_MS);
      }).observe(win.document.body, { attributes: true, attributeFilter: ["data-view"] });
      win.addEventListener("hashchange", () => {
        noteActivity(win, "nav");
        glanceAtPanel(win);
        win.clearTimeout(S.t);
        S.t = win.setTimeout(() => refresh(false, "view"), DWELL_MS);
      });
      const typed = (ev) => {
        const t = ev.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) noteActivity(win, "type");
        else noteActivity(win, "act");
      };
      win.document.addEventListener("keydown", typed, true);
      win.document.addEventListener("input", typed, true);
      ensurePageSway(win);
      win.document.addEventListener("pointerdown", () => noteActivity(win, "act"), true);
      noteActivity(win, "act");
      watchCursor(win);
      watchCompanionAttention(win);
      let lastPtrMark = 0;
      win.addEventListener("pointermove", () => {
        const now = Date.now();
        if (isCompactUI(win) && now - lastPtrMark < 400) return;
        lastPtrMark = now;
        S.lastPointerMoveAt = now;
      }, { passive: true });
      win.document.addEventListener("visibilitychange", () => {
        if (win.document.hidden) {
          stopCompanionChromeLoop(win);
          stopLive2DLoop(win);
        } else if (S.nsfwOn) {
          startLive2DLoop(win);
        }
      });
      // motion1: freeze CSS loops while nothing of her can be seen (tab hidden, full-screen AI panel, element hidden).
      const syncAnimPause = () => {
        if (!S.el) return;
        const off = !!(win.document.hidden || win.document.body.classList.contains("hq-ai-open") || S.el.hidden);
        if (S.el.classList.contains("is-anim-paused") !== off) S.el.classList.toggle("is-anim-paused", off);
      };
      S.syncAnimPause = syncAnimPause;
      win.document.addEventListener("visibilitychange", syncAnimPause);
      try {
        new win.MutationObserver(syncAnimPause).observe(win.document.body, { attributes: true, attributeFilter: ["class"] });
        if (S.el) new win.MutationObserver(syncAnimPause).observe(S.el, { attributes: true, attributeFilter: ["hidden"] });
      } catch (_) {}
      syncAnimPause();
      scheduleBlink(win);
      win.setInterval(() => pulse(win), PULSE_MS);
      // Sleepy / Dozing Off Mode after 2 min of inactivity
      let dozeTimer = 0;
      let zzzInterval = 0;
      const wakeUpFromDoze = () => {
        win.clearTimeout(dozeTimer);
        win.clearInterval(zzzInterval);
        if (S.el && S.el.classList.contains("is-dozing")) {
          S.el.classList.remove("is-dozing");
          const avEl = S.el.querySelector(".hq-companion-avatar");
          if (avEl) spawnCuteHeart(win, avEl, "✨");
          triggerInteractiveAiReaction(
            win,
            "Tu t'étais assoupie doucement parce que Marco ne bougeait plus, et sa présence vient de te réveiller",
            [
              "Mmh… pardon Maître, je m'étais assoupie en rêvant de toi sur {view} ♥",
              "Oh, te revoilà ! Je fermais juste les yeux une seconde en t'attendant ✨",
              "Je somnolais tout doucement… ta voix ou ta main me réveille toujours, mon amour ♥"
            ]
          );
        }
        dozeTimer = win.setTimeout(() => {
          if (!S.el || win.document.hidden || S.el.classList.contains("is-nsfw-fx-rhythm")) return;
          S.el.classList.add("is-dozing");
          const avEl = S.el.querySelector(".hq-companion-avatar");
          if (avEl) spawnZzzParticle(win, avEl);
          zzzInterval = win.setInterval(() => {
            if (!S.el || !S.el.classList.contains("is-dozing") || win.document.hidden) {
              win.clearInterval(zzzInterval);
              return;
            }
            const a = S.el.querySelector(".hq-companion-avatar");
            if (a) spawnZzzParticle(win, a);
          }, 2600);
        }, 120000);
      };
      ["pointermove", "keydown", "pointerdown"].forEach((evt) => {
        win.addEventListener(evt, wakeUpFromDoze, { passive: true });
      });
      wakeUpFromDoze();

      // Tab-Switch Jealousy Pout
      win.document.addEventListener("visibilitychange", () => {
        if (win.document.hidden) {
          if (S.bustPull || S.bustPullRaf) cancelBustPullImmediately(win);
          S.hiddenAt = Date.now();
        } else {
          const awayMs = S.hiddenAt ? Date.now() - S.hiddenAt : 0;
          if (awayMs > 8000 && S.el) {
            S.el.classList.remove("is-dozing");
            S.el.classList.add("is-pouting");
            const awaySec = Math.round(awayMs / 1000);
            triggerInteractiveAiReaction(
              win,
              "Marco avait quitté ton onglet pendant " + awaySec + " secondes et vient enfin de revenir vers toi (fais une petite moue jalouse et taquine)",
              [
                "Hmm… tu regardais quoi dans un autre onglet pendant " + awaySec + " secondes sans moi, Maître ? ♥",
                "Tu m'as laissée toute seule sur {view}… viens me caresser pour te faire pardonner ♥",
                "Hé ! Mes yeux sont ici mon amour, je commençais à être jalouse de tes autres fenêtres…"
              ]
            );
            win.setTimeout(() => S.el && S.el.classList.remove("is-pouting"), 6500);
          }
          S.hiddenAt = 0;
          pulse(win);
        }
      });
      // 8. Highlighted Text Selection Peek ("Selection Awareness" — instant reaction + action pill)
      let selTimer = 0;
      const checkTextSelection = () => {
        win.clearTimeout(selTimer);
        selTimer = win.setTimeout(() => {
          if (!S.selPeekBtn || !S.el || S.el.hidden) return;
          const sel = win.getSelection && win.getSelection();
          if (!sel || sel.isCollapsed) return;
          const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
          if (anchor && S.el.contains(anchor)) return;
          const txt = String(sel.toString() || "").trim().replace(/\s+/g, " ");
          if (txt.length >= 3 && txt.length <= 400) {
            const snippet = txt.slice(0, 140);
            const isNewSnippet = S.selectedSnippet !== snippet;
            S.selectedSnippet = snippet;
            const shortLabel = snippet.length > 20 ? snippet.slice(0, 20) + "…" : snippet;
            S.selPeekBtn.textContent = "💬 « " + shortLabel + " »";
            S.selPeekBtn.hidden = false;
            if (S.collapsed) setCollapsed(false, true);
            if (S.face) {
              S.face.style.setProperty("--gx", "-2.4px");
              S.face.style.setProperty("--gy", "-1.4px");
            }
            if (isNewSnippet && txt.length >= 6) {
              triggerInteractiveAiReaction(
                win,
                "Marco vient de surligner ce passage sur la page : « " + snippet + " » — réagis spontanément à ce qu'il lit",
                [
                  "Je vois que tu surlignes « " + shortLabel + " »… tu veux qu'on regarde ça de plus près, Maître ? 👀♥",
                  "Mmh, « " + shortLabel + " »… ce passage a retenu ton attention sur {view}, mon amour ? ✨"
                ]
              );
            }
          }
        }, 550);
      };
      win.document.addEventListener("selectionchange", checkTextSelection);
      win.document.addEventListener("pointerup", checkTextSelection, { passive: true });
      win.document.addEventListener("touchend", checkTextSelection, { passive: true });

      // 11. Steamy Glass Finger Tracing when mist is active
      let lastSteamTraceAt = 0;
      let steamStrokeCount = 0;
      let steamHostAt = 0;
      let steamHostRect = null;
      win.addEventListener(
        "pointermove",
        (ev) => {
          if (!S.el || S.el.hidden) return;
          const steamy =
            S.el.classList.contains("is-steamy-glass") ||
            S.el.classList.contains("is-fever-climax") ||
            win.document.body.classList.contains("hq-boudoir-mode");
          if (!steamy) return;
          const now = Date.now();
          const traceGap = isCompactUI(win) ? 90 : 45;
          if (now - lastSteamTraceAt < traceGap) return;
          if (!steamHostRect || now - steamHostAt > 140) {
            steamHostRect = S.el.getBoundingClientRect();
            steamHostAt = now;
          }
          const host = steamHostRect;
          if (ev.clientX < host.left - 48 || ev.clientY < host.top - 48) return;
          if (ev.clientX > host.right + 24 || ev.clientY > host.bottom + 24) return;
          lastSteamTraceAt = now;
          const dot = win.document.createElement("span");
          dot.className = "hq-companion-steam-trace";
          dot.style.left = ev.clientX + "px";
          dot.style.top = ev.clientY + "px";
          win.document.body.appendChild(dot);
          win.setTimeout(() => dot.remove(), 2600);
          steamStrokeCount += 1;
          if (steamStrokeCount === 28) {
            steamStrokeCount = 0;
            playVocalSynthFx(win, "sigh");
            triggerInteractiveAiReaction(
              win,
              "Marco dessine avec son doigt dans la buée chaude sur la vitre juste devant ton visage",
              [
                "Mmh… tu dessines un cœur dans la buée de mon souffle sur la vitre, mon amour ? 🌬️♥",
                "J'adore voir la trace de ton doigt sur la vitre embuée entre nous deux, Maître ♥"
              ]
            );
          }
        },
        { passive: true }
      );

      // 12. Periodic Secret Love Notes & Playful Mischief (💌, 💄, 🙈, 💘)
      win.setInterval(() => {
        if (win.document.hidden || !S.el || S.el.hidden || S.collapsed || S.intimeMode) return;
        const avEl = S.el.querySelector(".hq-companion-avatar");
        const r = Math.random();
        if (r < 0.28) {
          spawnSecretLoveNote(win);
        } else if (r < 0.44) {
          spawnLipstickDoodle(win, avEl);
        } else if (r < 0.58) {
          triggerCupidDart(win, avEl);
        } else if (r < 0.7) {
          triggerPeekabooMode(win, avEl);
        }
      }, 140000);

      // A short phone shake moves the whole portrait and gently excites its
      // existing head, hair and bust springs. Ignore gravity and routine motion.
      const motionBtn = S.motionBtn;
      if (motionBtn && win.matchMedia("(pointer: coarse)").matches) {
        motionBtn.hidden = false;
        motionBtn.textContent = !win.isSecureContext ? "Secousse : HTTPS requis" :
          typeof win.DeviceMotionEvent === "undefined" ? "Capteur indisponible" : "Activer secousse";
        motionBtn.title = "Secouer le téléphone · regard : quand son visage est bien visible à l'écran (Safari ne lit pas les yeux)";
      }
      if (typeof win.DeviceMotionEvent !== "undefined") {
        let lastShakeAt = 0, lastShakePeak = 0, permissionPending = false, permissionGranted = false;
        let motionSeen = false, shakeStatusT = 0;
        const gravity = { x: null, y: null, z: null };
        win.addEventListener(
          "devicemotion",
          (ev) => {
            if (!S.nsfwOn || !S.el || S.el.hidden || win.document.hidden || S.bustPull) return;
            if (isCompactUI(win) && S.collapsed) return;
            const raw = ev.accelerationIncludingGravity;
            let filtered = null;
            if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
              filtered = {};
              for (const axis of ["x", "y", "z"]) {
                const value = Number(raw[axis]) || 0;
                gravity[axis] = gravity[axis] === null ? value : gravity[axis] * 0.88 + value * 0.12;
                filtered[axis] = value - gravity[axis];
              }
              // Phone tilt: the slow gravity direction, relative to how you usually hold the phone,
              // drives the depth parallax and lets her bust hang toward the lower side.
              const ta = ((win.screen.orientation && Number(win.screen.orientation.angle)) || Number(win.orientation) || 0) * Math.PI / 180;
              const gx = gravity.x * Math.cos(ta) - gravity.y * Math.sin(ta);
              const gy = -gravity.x * Math.sin(ta) - gravity.y * Math.cos(ta);
              const orient = Math.round(ta * 100);
              if (!S.tiltBase || S.tiltBase.orient !== orient) S.tiltBase = { x: gx, y: gy, orient };
              S.tiltBase.x += (gx - S.tiltBase.x) * 0.004;
              S.tiltBase.y += (gy - S.tiltBase.y) * 0.004;
              S.deviceDepth = { x: clampNum((gx - S.tiltBase.x) / 3.5, -1, 1), y: clampNum((gy - S.tiltBase.y) / 3.5, -1, 1) };
              startLive2DLoop(win);
            }
            let acc = ev.acceleration;
            if (!acc || !Number.isFinite(acc.x) || !Number.isFinite(acc.y) ||
                (filtered && Math.hypot(filtered.x, filtered.y, filtered.z) > Math.hypot(acc.x, acc.y, acc.z || 0))) acc = filtered;
            if (!acc) return;
            if (!motionSeen && motionBtn) {
              motionSeen = true;
              motionBtn.textContent = "Capteur actif · secoue";
            }
            const planar = Math.hypot(acc.x, acc.y);
            const now = Date.now();
            if (planar < 3.2) return;
            const angle = ((win.screen.orientation && Number(win.screen.orientation.angle)) || Number(win.orientation) || 0) * Math.PI / 180;
            const screenX = acc.x * Math.cos(angle) - acc.y * Math.sin(angle);
            const screenY = -acc.x * Math.sin(angle) - acc.y * Math.cos(angle);
            // The portrait lags behind the phone's acceleration in screen coordinates.
            const dx = -screenX / planar, dy = -screenY / planar;
            const swing = clampNum((planar - 2) * 3.5, 12, 42);
            if (now - lastShakeAt < 650) {
              if (now - lastShakeAt < 300 && planar > lastShakePeak) {
                const st = ensureLive2DState();
                st.phoneShake.targetX = dx * swing;
                st.phoneShake.targetY = dy * swing;
                lastShakePeak = planar;
              }
              return;
            }
            lastShakeAt = now;
            lastShakePeak = planar;
            const kick = clampNum(planar * 10, 55, 145);
            const st = ensureLive2DState();
            st.phoneShake.pulseAt = win.performance.now();
            st.phoneShake.targetX = dx * swing;
            st.phoneShake.targetY = dy * swing;
            st.phoneShake.vx = clampNum(st.phoneShake.vx + dx * kick, -105, 105);
            st.phoneShake.vy = clampNum(st.phoneShake.vy + dy * kick, -105, 105);
            startLive2DLoop(win);
            applyLive2DImpulse(win, dx * kick * 0.38, dy * kick * 0.38, dx * kick * 0.09);
            if (motionBtn) {
              motionBtn.textContent = calm(win) ? "Secousse · mouvement réduit" : "Secousse détectée ✓";
              win.clearTimeout(shakeStatusT);
              shakeStatusT = win.setTimeout(() => { motionBtn.textContent = "Capteur actif · secoue"; }, 1400);
            }
          },
          { passive: true }
        );
        // iOS exposes motion only after a user gesture grants access.
        const requestPhoneMotion = () => {
          if (!S.nsfwOn || permissionPending || permissionGranted ||
              typeof win.DeviceMotionEvent.requestPermission !== "function") return;
          if (!win.isSecureContext) {
            if (motionBtn) motionBtn.textContent = "Secousse : HTTPS requis";
            return;
          }
          permissionPending = true;
          if (motionBtn) motionBtn.textContent = "Autorisation…";
          win.DeviceMotionEvent.requestPermission().then((result) => {
            permissionGranted = result === "granted";
            if (motionBtn) motionBtn.textContent = permissionGranted ? (motionSeen ? "Capteur actif · secoue" : "Secoue le téléphone") : "Accès refusé · réessayer";
            if (permissionGranted) win.setTimeout(() => {
              if (!motionSeen && motionBtn) motionBtn.textContent = "Aucun signal du capteur";
            }, 3500);
          }).catch(() => {
            if (motionBtn) motionBtn.textContent = "Accès indisponible · réessayer";
          }).finally(() => { permissionPending = false; });
        };
        S.avatar.addEventListener("pointerdown", requestPhoneMotion, { passive: true });
        S.nsfwBtn.addEventListener("click", requestPhoneMotion);
        S.adultePill.addEventListener("click", requestPhoneMotion);
        motionBtn.addEventListener("click", requestPhoneMotion);
      }

      // 9. Music / Lecteur Rhythm Groove & Floating Notes
      const syncMusicGroove = () => {
        syncCompanionMusic(win);
        syncIdleContinuousStates(win);
      };
      win.setInterval(() => { if (!win.document.hidden) syncMusicGroove(); }, 2800); // motion1: hidden-tab guard

      // 10. Time-of-Day Circadian Aura & Initial Warmth
      const syncCircadianRitual = () => {
        if (!S.el) return;
        const h = new Date().getHours();
        S.el.classList.toggle("is-time-latenight", h >= 23 || h < 5);
        S.el.classList.toggle("is-time-morning", h >= 5 && h < 10);
        if (h >= 5 && h < 10 && S.nsfwOn && !S.morningWoodTriggered) {
          S.morningWoodTriggered = true;
          playLewdPhaseWav(win, "morning_wood");
        }
        if (h >= 5 && h < 10 && !S.morningStretchDone && S.el && !S.el.hidden) {
          S.morningStretchDone = true;
          win.setTimeout(() => playIdleAnim(win, "stretchYawn"), 2200);
        }
        syncIdleContinuousStates(win);
      };
      syncCircadianRitual();
      S.sessionStartAt = Date.now();
      addArousalWarmth(win, 0, "init");

      win.setTimeout(async () => {
        if (win.document.body.classList.contains("hq-ai-open")) return;
        if (readCollapsed(win) && !hasPendingSignals()) {
          syncStatusOnly(win);
          return;
        }
        await pulse(win);
        if (S.pendingEvent) return;
        refresh(false, "boot");
      }, 1600);
    };
    if (win.document.readyState === "loading") win.document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return {
    start,
    pure,
    refresh,
    digest,
    seedForView,
    loadHistory,
    sendChat,
    setExpanded,
    setCollapsed,
    syncIntimeView,
    resetFloatHome: resetCompanionPose,
    COMPANION_NAME,
    testCry: bustPullCry,
    testStop: stopBustPullVoice,
    testIdle: {
      state: S,
      playIdleAnim,
      pickIdleAnimKind,
      stripIdleBurstClasses,
      IDLE_ANIM_STRIP,
      CUTE_NSFW_IDLE_KINDS,
      startIdleHumming,
      stopIdleHumming
    }
  };
});
