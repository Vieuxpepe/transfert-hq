/* Companion gaze policy: one attention target, a short saccade, a hold, then a
 * deliberate aversion while a reply is composed, and a return when she speaks.
 * Pure: no timer, no rAF, no DOM. The existing rig loop samples `step` with the
 * cursor, the turn classes and the last message anchor, and writes the result. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqCompanionGaze = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_X = 2.4, MAX_Y = 1.6;        // the amplitude the old glance() already used
  const SPEED = 2.6;                      // px per 16 ms: a saccade, not a spring
  const HOLD_MS = 700;                    // stillness after the eyes land
  const IDLE_MIN_MS = 2400, IDLE_MAX_MS = 5200;
  const AVERSION_X = 1.35, AVERSION_Y = 1.5, AVERSION_FLIP_MS = 1900;
  const POINTER_FRESH_MS = 4000, SPEAK_POINTER_MS = 2500;
  const HEAD_CAP = 1.45;                  // deg: one composed lateral head drive
  const LOOK_FULL_DEG = 0.9;              // a settled look this deep owns the head
  const NOD_CAP = 0.05;                   // the rig's own nod range, shared by both
  const HEAD_PX_X = 7.5, HEAD_PX_Y = 5.5; // the look's translation, the rig's own clamp
  const ROT_PER_PX = 0.208;               // deg of head rotation per px of look (0.52 * 0.4)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const round = v => Math.round(v * 10) / 10;
  const precise = v => Math.round(v * 1000) / 1000;

  // Cursor → bounded offset. Same math as the original glance, moved here so the
  // policy owns one vocabulary of amplitudes.
  function glance(dx, dy) {
    const d = Math.hypot(Number(dx) || 0, Number(dy) || 0);
    if (!d) return { x: 0, y: 0 };
    const k = Math.min(1, d / 240);
    return { x: round((dx / d) * k * MAX_X), y: round((dy / d) * k * MAX_Y) };
  }

  function create() {
    return { mode: "idle", x: 0, y: 0, tx: 0, ty: 0, holdUntil: 0, nextIdleAt: 0,
      idleStep: 0, aversionAt: 0, aversionSide: 1 };
  }

  // Deterministic small saccades: no per-frame Math.random while she idles.
  function idleOffset(step) {
    const n = Number(step) || 0;
    return { x: round(Math.sin(n * 2.399963) * 0.9), y: round(Math.cos(n * 3.121593) * 0.8) };
  }

  // One head, two intents: the look says where it points, a gesture shapes how it
  // gets there. The look keeps direction; the gesture loses amplitude as the look
  // deepens, and the sum passes one shared cap so simultaneous drives decay
  // instead of stacking. Pointwise, so the 90 ms counter-move survives intact.
  function arbitrateHead(input = {}) {
    // Translation and rotation come from the same look, so one intent cannot
    // land on the portrait twice with two different answers.
    const x = clamp(input.lookX, -HEAD_PX_X, HEAD_PX_X);
    const y = clamp(input.lookY, -HEAD_PX_Y, HEAD_PX_Y);
    const scale = Number.isFinite(input.scale) ? input.scale : 1;
    const look = clamp(Number.isFinite(input.look) ? input.look : x * ROT_PER_PX * scale, -HEAD_CAP, HEAD_CAP);
    const gesture = clamp(input.gesture, -HEAD_CAP, HEAD_CAP);
    const authority = Math.min(1, Math.abs(look) / LOOK_FULL_DEG);
    const shaped = gesture * (1 - .78 * authority);
    let total = HEAD_CAP * Math.tanh((look + shaped) / HEAD_CAP);
    // A look-away stays a look-away: while it owns the head the gesture shapes
    // the move but cannot turn it against where she is looking.
    if (Math.abs(look) > .03 && total * look < 0) total = look * .25;
    const nodSum = clamp(input.nod, -NOD_CAP, NOD_CAP) + clamp(input.speechNod, -NOD_CAP, NOD_CAP);
    const nod = NOD_CAP * Math.tanh(nodSum / NOD_CAP);
    return { x: precise(x), y: precise(y), sway: precise(total), gesture: precise(shaped),
      nod: precise(nod), authority: precise(authority), total: precise(total) };
  }

  function step(state, input) {
    const st = state && typeof state === "object" ? state : create();
    const inp = input || {};
    const now = Number(inp.now) || 0;
    const dt = clamp(inp.dt == null ? 16 : inp.dt, 0, 48);
    if (inp.reduced) {
      st.mode = "off"; st.x = 0; st.y = 0; st.tx = 0; st.ty = 0;
      return { mode: "off", x: 0, y: 0, targetX: 0, targetY: 0, landed: true };
    }
    const pointer = inp.pointer && Number.isFinite(Number(inp.pointer.dx)) ? inp.pointer : null;
    const pointerAt = pointer ? Number(pointer.at) || 0 : 0;
    const anchor = inp.anchor && now < (Number(inp.anchor.until) || 0) ? inp.anchor : null;
    let tx = st.tx, ty = st.ty, mode = st.mode;
    if (inp.composing) {
      // Thinking: look away and slightly down, flipping side now and then, and
      // hold there until the sentence starts.
      if (st.mode !== "aversion" || now >= st.aversionAt) {
        st.aversionSide = st.aversionSide === 1 ? -1 : 1;
        st.aversionAt = now + AVERSION_FLIP_MS;
      }
      tx = AVERSION_X * st.aversionSide; ty = AVERSION_Y; mode = "aversion";
    } else if (inp.speaking) {
      // Back to him the moment she starts talking; centre if he has moved on.
      const g = pointer && now - pointerAt <= SPEAK_POINTER_MS
        ? glance(pointer.dx, pointer.dy) : { x: 0, y: 0 };
      tx = g.x; ty = g.y; mode = "speak";
    } else if (anchor) {
      // A message just arrived: one short look at it, then back.
      tx = clamp(anchor.x, -MAX_X, MAX_X); ty = clamp(anchor.y, -MAX_Y, MAX_Y); mode = "bubble";
    } else if (pointer && now - pointerAt <= POINTER_FRESH_MS) {
      const g = glance(pointer.dx, pointer.dy); tx = g.x; ty = g.y; mode = "cursor";
    } else {
      mode = "idle";
      if (now >= Math.max(st.nextIdleAt || 0, st.holdUntil || 0)) {
        st.idleStep = (st.idleStep || 0) + 1;
        const off = idleOffset(st.idleStep);
        tx = off.x; ty = off.y;
        st.nextIdleAt = now + IDLE_MIN_MS + (IDLE_MAX_MS - IDLE_MIN_MS) * ((st.idleStep % 5) / 4);
      }
    }
    st.tx = round(tx); st.ty = round(ty);
    const maxStep = SPEED * (dt / 16);
    const dx = st.tx - st.x, dy = st.ty - st.y;
    const dist = Math.hypot(dx, dy);
    const landed = dist <= Math.max(0.06, maxStep * 0.5);
    if (landed) { st.x = st.tx; st.y = st.ty; }
    else {
      const s = Math.min(dist, maxStep);
      st.x = round(st.x + dx / dist * s); st.y = round(st.y + dy / dist * s);
    }
    if (mode !== st.mode) st.holdUntil = now + HOLD_MS;
    st.mode = mode;
    return { mode, x: st.x, y: st.y, targetX: st.tx, targetY: st.ty, landed };
  }

  return { create, step, glance, idleOffset, arbitrateHead, MAX_X, MAX_Y, SPEED, HOLD_MS,
    AVERSION_X, AVERSION_Y, IDLE_MIN_MS, IDLE_MAX_MS, HEAD_CAP, LOOK_FULL_DEG, ROT_PER_PX };
});
