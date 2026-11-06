/* Open-palm + slap hand gestures (fixed overlay, capped particles, single active anim). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqPalmHand = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const HAND_SLAP = "/assets/transferina-hand.png";
  const HAND_OPEN = "/assets/transferina-hand-open.png";
  const HAND_POINT = "/assets/transferina-hand-point.png";
  const HAND_GRIP = "/assets/transferina-hand-grip.png";
  const PARTICLE_CAP = 4;
  const GLOBAL_GAP = 3000;
  const PUSH_SOFT_GLOBAL = 1500;
  const WAVE_ANY_PALM_GAP = 45000;
  const GAPS = {
    slap: 0,
    push_soft: 6000,
    pat: 5000,
    celebrate: 5200,
    hush: 12000,
    shield: 5000,
    wave: 6500,
    catch_cursor: 9000,
    trace_vein: 12000,
    grip_pole: 9000
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function create(win, ctx) {
    const doc = win.document;
    let hand = null;
    let handAlt = null;
    let busyUntil = 0;
    let active = false;
    let particleLive = 0;
    const lastAt = Object.create(null);
    let lastAnyAt = null;
    let gripRelease = false;

    function releaseHold() {
      gripRelease = true;
    }

    function calm() {
      return ctx.calm ? ctx.calm(win) : false;
    }

    function busy() {
      return active || win.performance.now() < busyUntil;
    }

    function ready(kind) {
      if (calm() || active) return false;
      const now = win.performance.now();
      if (now < busyUntil && kind !== "slap") return false;
      if (kind !== "slap" && lastAnyAt != null) {
        const globalNeed = kind === "push_soft" ? PUSH_SOFT_GLOBAL : GLOBAL_GAP;
        if (now - lastAnyAt < globalNeed) return false;
      }
      if (kind === "wave" && lastAnyAt != null && now - lastAnyAt < WAVE_ANY_PALM_GAP) return false;
      const gap = GAPS[kind] ?? 3000;
      const last = lastAt[kind];
      if (kind !== "slap" && last != null && now - last < gap) return false;
      return true;
    }

    function mark(kind, ms) {
      const t = win.performance.now();
      lastAt[kind] = t;
      busyUntil = Math.max(busyUntil, t + ms);
      lastAnyAt = t;
    }

    function hideAltHand() {
      if (handAlt) handAlt.style.opacity = "0";
    }

    function ensureHand(src, alt) {
      let el = alt ? handAlt : hand;
      if (!el) {
        el = doc.createElement("img");
        el.className = "hq-flick-hand is-open-palm" + (alt ? " is-palm-mirror" : "");
        el.alt = "";
        el.draggable = false;
        el.setAttribute("aria-hidden", "true");
        doc.body.appendChild(el);
        if (alt) handAlt = el;
        else hand = el;
      }
      el.src = src;
      el.classList.toggle("is-open-palm", src === HAND_OPEN);
      el.classList.toggle("is-point-hand", src === HAND_POINT);
      el.classList.toggle("is-grip-hand", src === HAND_GRIP);
      return el;
    }

    function pathArcTable(path) {
      const seg = [0];
      let total = 0;
      for (let i = 1; i < path.length; i += 1) {
        total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        seg.push(total);
      }
      return { seg, total: total || 1 };
    }

    function samplePath(path, arc, u) {
      const t = clamp(u, 0, 1) * arc.total;
      let i = 1;
      while (i < arc.seg.length && arc.seg[i] < t) i += 1;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(path.length - 1, i);
      const span = Math.max(0.001, arc.seg[i1] - arc.seg[i0]);
      const k = (t - arc.seg[i0]) / span;
      const x = path[i0].x + (path[i1].x - path[i0].x) * k;
      const y = path[i0].y + (path[i1].y - path[i0].y) * k;
      const dx = path[i1].x - path[i0].x;
      const dy = path[i1].y - path[i0].y;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 112;
      return { x, y, deg };
    }

    function runTraceVein(path, opts) {
      opts = opts || {};
      if (!ready("trace_vein") || !path || path.length < 2) return false;
      active = true;
      mark("trace_vein", 2800);
      hideAltHand();
      const handEl = ensureHand(HAND_POINT);
      const w = 58;
      const oy = w * (352 / 976) * 0.42;
      const ox = w * 0.18;
      const arc = pathArcTable(path);
      const av = avatarBox();
      const start =
        opts.start && opts.start.x != null
          ? { x: opts.start.x, y: opts.start.y }
          : av
            ? { x: av.left + av.width * 0.62, y: av.top + av.height * 0.62 }
            : { x: path[0].x - 40, y: path[0].y };
      handEl.style.width = w + "px";
      handEl.style.left = start.x - ox + "px";
      handEl.style.top = start.y - oy + "px";
      handEl.style.opacity = "0";
      const t0 = win.performance.now();
      const introMs = 420;
      const traceMs = 2200;
      const outroMs = 380;
      const total = introMs + traceMs + outroMs;
      const finish = () => {
        active = false;
        handEl.style.opacity = "0";
        if (ctx.onVeinTrace) ctx.onVeinTrace(false, 0);
      };
      const frame = (now) => {
        if (doc.hidden) {
          finish();
          return;
        }
        const elapsed = now - t0;
        if (elapsed >= total) {
          finish();
          return;
        }
        let px = start.x;
        let py = start.y;
        let deg = samplePath(path, arc, 0).deg;
        let op = 1;
        let traceU = 0;
        if (elapsed < introMs) {
          const k = elapsed / introMs;
          const ease = 1 - (1 - k) * (1 - k);
          const s0 = samplePath(path, arc, 0);
          px = start.x + (s0.x - start.x) * ease;
          py = start.y + (s0.y - start.y) * ease;
          deg = s0.deg;
          op = ease;
        } else if (elapsed < introMs + traceMs) {
          traceU = (elapsed - introMs) / traceMs;
          const ease = traceU * traceU * (3 - 2 * traceU);
          const s = samplePath(path, arc, ease);
          px = s.x;
          py = s.y;
          deg = s.deg;
          op = 1;
        } else {
          const k = (elapsed - introMs - traceMs) / outroMs;
          const s = samplePath(path, arc, 1);
          px = s.x;
          py = s.y;
          deg = s.deg;
          op = 1 - k;
          traceU = 1;
        }
        handEl.style.opacity = String(clamp(op, 0, 1));
        handEl.style.left = px - ox + "px";
        handEl.style.top = py - oy + "px";
        handEl.style.transform = "rotate(" + deg.toFixed(1) + "deg)";
        if (ctx.onVeinTrace) ctx.onVeinTrace(true, traceU);
        win.requestAnimationFrame(frame);
      };
      win.requestAnimationFrame(frame);
      return true;
    }

    function aimDeg(from, to, mirror) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + (mirror ? -98 : 98);
      return deg;
    }

    function runCatchCursor(target) {
      if (!ready("catch_cursor")) return false;
      const av = avatarBox();
      if (!av || !target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return false;
      active = true;
      mark("catch_cursor", 1180);
      const w = 62;
      const h = w * (352 / 976);
      const ox = w * 0.8;
      const oy = h * 0.48;
      const ty = clamp(target.y, av.top + av.height * 0.12, av.top + av.height * 0.88);
      const tx = clamp(target.x, av.left - 8, av.right + 8);
      const bracket = clamp(av.width * 0.08, 10, 18);
      const leftTarget = { x: tx - bracket, y: ty + 4 };
      const rightTarget = { x: tx + bracket, y: ty + 4 };
      const leftStart = {
        x: av.left - w * 0.42,
        y: av.top + av.height * 0.5
      };
      const rightStart = {
        x: av.right + w * 0.42 - w,
        y: av.top + av.height * 0.5
      };
      const handL = ensureHand(HAND_OPEN, false);
      const handR = ensureHand(HAND_OPEN, true);
      handL.style.width = w + "px";
      handR.style.width = w + "px";
      handL.style.left = leftStart.x - ox + "px";
      handL.style.top = leftStart.y - oy + "px";
      handR.style.left = rightStart.x - ox + "px";
      handR.style.top = rightStart.y - oy + "px";
      const degL = aimDeg(leftStart, leftTarget, false);
      const degR = aimDeg(rightStart, rightTarget, true);
      const bez = (t, a, c, e) => {
        const u = 1 - t;
        return u * u * a + 2 * u * t * c + t * t * e;
      };
      const ctrlL = {
        x: (leftStart.x + leftTarget.x) * 0.5,
        y: Math.min(leftStart.y, leftTarget.y) - 24
      };
      const ctrlR = {
        x: (rightStart.x + rightTarget.x) * 0.5,
        y: Math.min(rightStart.y, rightTarget.y) - 24
      };
      let clasped = false;
      const t0 = win.performance.now();
      const reachMs = 640;
      const holdMs = 260;
      const fadeMs = 280;
      const total = reachMs + holdMs + fadeMs;
      const finish = () => {
        active = false;
        handL.style.opacity = "0";
        handR.style.opacity = "0";
        hideAltHand();
      };
      const paintPair = (uReach, uFade) => {
        const along = 1 - (1 - uReach) * (1 - uReach);
        const lx = bez(along, leftStart.x, ctrlL.x, leftTarget.x);
        const ly = bez(along, leftStart.y, ctrlL.y, leftTarget.y);
        const rx = bez(along, rightStart.x, ctrlR.x, rightTarget.x);
        const ry = bez(along, rightStart.y, ctrlR.y, rightTarget.y);
        const op = uFade > 0 ? Math.max(0, 1 - uFade) : 1;
        const wob = clasped ? Math.sin((win.performance.now() - t0) * 0.018) * 2.5 : 0;
        handL.style.opacity = String(op);
        handR.style.opacity = String(op);
        handL.style.transform =
          "translate(" + (lx - leftStart.x + wob).toFixed(1) + "px, " + (ly - leftStart.y).toFixed(1) +
          "px) rotate(" + (degL + wob * 0.12).toFixed(1) + "deg)";
        handR.style.transform =
          "translate(" + (rx - rightStart.x - wob).toFixed(1) + "px, " + (ry - rightStart.y).toFixed(1) +
          "px) rotate(" + (degR - wob * 0.12).toFixed(1) + "deg) scaleX(-1)";
      };
      const frame = (now) => {
        if (doc.hidden) {
          finish();
          return;
        }
        const elapsed = now - t0;
        if (elapsed < reachMs) {
          const u = elapsed / reachMs;
          if (!clasped && u > 0.82) {
            clasped = true;
            jiggleSoft();
          }
          paintPair(u, 0);
          win.requestAnimationFrame(frame);
          return;
        }
        if (elapsed < reachMs + holdMs) {
          paintPair(1, 0);
          win.requestAnimationFrame(frame);
          return;
        }
        const fadeU = (elapsed - reachMs - holdMs) / fadeMs;
        if (fadeU < 1) {
          paintPair(1, fadeU);
          win.requestAnimationFrame(frame);
        } else finish();
      };
      win.requestAnimationFrame(frame);
      return true;
    }

    function avatarBox() {
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return null;
      const r = av.getBoundingClientRect();
      if (r.width < 8) return null;
      return r;
    }

    function bubblePoint() {
      const b = doc.querySelector(".hq-companion-bubble");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width < 4) return null;
      return { x: r.left + r.width * 0.18, y: r.top + r.height * 0.52 };
    }

    function composePoint() {
      const input = doc.querySelector(".hq-companion-compose input");
      if (input) {
        const r = input.getBoundingClientRect();
        return { x: r.left - 12, y: r.top + r.height * 0.45 };
      }
      return bubblePoint();
    }

    function jiggleSoft() {
      if (ctx.jiggleSoft) ctx.jiggleSoft();
      else if (ctx.jiggle) ctx.jiggle();
    }

    function runShaftGesture(kind, profile, near) {
      const av = avatarBox();
      if (!av || !near || !near.at) return false;
      const w = profile.w || 72;
      const h = w * (352 / 976);
      const ox = w * (profile.oxMul || 0.82);
      const oy = h * (profile.oyMul || 0.48);
      const pl = profile.palmLocalMul;
      const palmLocal = pl
        ? { x: pl.x * w, y: pl.y * h }
        : { x: -0.32 * w, y: 0.12 * h };
      const cx = av.left + av.width * 0.5;
      const cy = av.top + av.height * 0.42;
      let ux = near.at.x - cx;
      let uy = near.at.y - cy;
      const span = Math.hypot(ux, uy) || 1;
      ux /= span;
      uy /= span;
      const girth = Math.max(16, (ctx.mountRectW && ctx.mountRectW()) || 18);
      const lean = clamp(ux * 14, -8, 8);
      const slapDeg =
        profile.landDeg != null
          ? profile.landDeg + lean * (profile.landLean ?? 1)
          : 90 + lean;
      const windDeg =
        profile.windDeg != null
          ? profile.windDeg + lean * (profile.landLean ?? 1)
          : slapDeg + (profile.windExtra || 20);
      const skin = {
        x: near.at.x - ux * girth * 0.38,
        y: near.at.y - uy * girth * 0.38
      };
      const palmOffset = (deg) => {
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
          x: palmLocal.x * cos - palmLocal.y * sin,
          y: palmLocal.x * sin + palmLocal.y * cos
        };
      };
      const capFor = (deg) => {
        const p = palmOffset(deg);
        return { x: skin.x - p.x, y: skin.y - p.y };
      };
      const landed = capFor(slapDeg);
      const start = {
        x: cx + ux * Math.min(av.width * 0.18, 24),
        y: cy + uy * Math.min(av.height * 0.1, 14)
      };
      const ctrl = {
        x: (start.x + landed.x) * 0.5 - uy * (profile.ctrl || 18),
        y: (start.y + landed.y) * 0.5 + ux * (profile.ctrl || 18)
      };
      return runLoop(kind, profile, {
        handSrc: profile.src || HAND_OPEN,
        w, ox, oy, start, ctrl, landed, skin, slapDeg, windDeg,
        palmOffset, capFor, ux, uy, cx, contactDist: profile.contactDist ?? 22,
        dirTravel: profile.travelHold ?? 36, mountFollow: !!profile.mountFollow
      });
    }

    function runScreenGesture(kind, profile, target) {
      const av = avatarBox();
      if (!av || !target) return false;
      const w = profile.w || 70;
      const h = w * (352 / 976);
      const ox = w * 0.8;
      const oy = h * 0.48;
      const palmLocal = { x: -0.3 * w, y: 0.1 * h };
      const palmOffset = (deg) => {
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
          x: palmLocal.x * cos - palmLocal.y * sin,
          y: palmLocal.x * sin + palmLocal.y * cos
        };
      };
      const deg = profile.baseDeg ?? -18;
      const start = {
        x: av.left + av.width * (profile.startX ?? 1.08),
        y: av.top + av.height * (profile.startY ?? 0.38)
      };
      const landed = { x: target.x, y: target.y };
      const ctrl = {
        x: (start.x + landed.x) * 0.5,
        y: Math.min(start.y, landed.y) - 28
      };
      const capFor = (d) => {
        const p = palmOffset(d);
        return { x: landed.x - p.x, y: landed.y - p.y };
      };
      return runLoop(kind, profile, {
        handSrc: HAND_OPEN,
        w, ox, oy, start, ctrl, landed, skin: landed, slapDeg: deg, windDeg: deg + 16,
        palmOffset, capFor, ux: 0, uy: -1, cx: av.left + av.width * 0.5,
        contactDist: 999, dirTravel: profile.travelHold ?? 0, mountFollow: false,
        screenMode: true, wave: profile.wave
      });
    }

    function runLoop(kind, profile, g) {
      if (!ready(kind)) return false;
      active = true;
      mark(kind, profile.busyMs || 900);
      hideAltHand();
      const handEl = ensureHand(g.handSrc);
      handEl.style.width = g.w + "px";
      handEl.style.left = g.start.x - g.ox + "px";
      handEl.style.top = g.start.y - g.oy + "px";
      const bez = (t, a, c, e) => {
        const u = 1 - t;
        return u * u * a + 2 * u * t * c + t * t * e;
      };
      const mul = profile.particleMul ?? 0.35;
      let trail = null;
      let lastSpawn = 0;
      const particles = calm() || mul <= 0 ? null : {
        spawn(x, y, vx, vy, strength) {
          if (particleLive >= PARTICLE_CAP) return;
          particleLive += 1;
          const sp = Math.hypot(vx, vy) || 1;
          const nx = vx / sp;
          const ny = vy / sp;
          const el = doc.createElement("span");
          el.className = "hq-flick-particle";
          el.setAttribute("aria-hidden", "true");
          el.style.left = x - nx * 8 + "px";
          el.style.top = y - ny * 8 + "px";
          el.style.width = 4 + strength * 10 + "px";
          el.style.setProperty("--hq-flick-rot", (Math.atan2(vy, vx) * 180) / Math.PI + "deg");
          el.style.setProperty("--hq-flick-dx", (-nx * 4).toFixed(1) + "px");
          el.style.setProperty("--hq-flick-dy", (-ny * 4).toFixed(1) + "px");
          doc.body.appendChild(el);
          win.setTimeout(() => {
            el.remove();
            particleLive = Math.max(0, particleLive - 1);
          }, 440);
        },
        follow(capX, capY, rot, now) {
          if (!trail) {
            trail = { x: capX, y: capY, t: now };
            return;
          }
          const dt = Math.max(0.008, (now - trail.t) / 1000);
          const vx = (capX - trail.x) / dt;
          const vy = (capY - trail.y) / dt;
          trail = { x: capX, y: capY, t: now };
          const speed = Math.hypot(vx, vy);
          if (speed < 160 || now - lastSpawn < 32) return;
          lastSpawn = now;
          const palm = g.palmOffset(rot);
          this.spawn(capX + palm.x * 0.35, capY + palm.y * 0.35, vx, vy, clamp(speed / 900, 0.15, 0.75) * mul);
        }
      };
      let contacted = false;
      let contactU = 1;
      let holdX = g.start.x;
      let holdY = g.start.y;
      let holdRot = g.slapDeg;
      let baseLeft = 0;
      let baseTop = 0;
      const t0 = win.performance.now();
      const dur = profile.dur || 900;
      const paint = (capX, capY, deg, op) => {
        handEl.style.opacity = String(op);
        handEl.style.transform =
          "translate(" + (capX - g.start.x).toFixed(1) + "px, " + (capY - g.start.y).toFixed(1) +
          "px) rotate(" + deg.toFixed(1) + "deg)";
      };
      const finish = () => {
        active = false;
        handEl.style.opacity = "0";
        gripRelease = false;
      };
      const onContact = () => {
        if (profile.slap && ctx.playSlap) ctx.playSlap();
        if (profile.jiggle) {
          if (profile.softJiggle) jiggleSoft();
          else if (ctx.jiggle) ctx.jiggle();
        }
        if (profile.jiggleDelay && ctx.playJiggle) win.setTimeout(() => ctx.playJiggle(), profile.jiggleDelay);
        if (profile.onContact) profile.onContact();
      };
      const frame = (now) => {
        const u = Math.min(1, (now - t0) / dur);
        if (g.wave && contacted) {
          const wob = Math.sin((now - t0) * 0.012) * 8;
          paint(holdX + wob, holdY, holdRot + wob * 0.15, 1 - u * 0.35);
          if (u < 1) win.requestAnimationFrame(frame);
          else finish();
          return;
        }
        if (!contacted) {
          const raw = u < 0.12 ? 0 : Math.min(1, (u - 0.12) / (g.screenMode ? 0.42 : 0.36));
          const along = 1 - (1 - raw) * (1 - raw);
          const rot = g.windDeg + along * (g.slapDeg - g.windDeg);
          let capX = bez(along, g.start.x, g.ctrl.x, g.landed.x);
          let capY = bez(along, g.start.y, g.ctrl.y, g.landed.y);
          if (!g.screenMode) {
            const palm = g.palmOffset(rot);
            if (along > 0.68 && Math.hypot(capX + palm.x - g.skin.x, capY + palm.y - g.skin.y) < g.contactDist) {
              const planted = g.capFor(rot);
              capX = planted.x;
              capY = planted.y;
              contacted = true;
              contactU = u;
              holdX = capX;
              holdY = capY;
              holdRot = rot;
              if (g.mountFollow && ctx.mountBox) {
                const box = ctx.mountBox();
                baseLeft = box.left;
                baseTop = box.top;
              }
              onContact();
            }
          } else if (along > 0.88) {
            contacted = true;
            contactU = u;
            holdX = capX;
            holdY = capY;
            holdRot = rot;
            onContact();
          }
          paint(capX, capY, rot, u < 0.1 ? u / 0.1 : 1);
          if (particles && raw > 0.04) particles.follow(capX, capY, rot, now);
        } else if (profile.holdUntilRelease) {
          if (gripRelease || doc.hidden) {
            finish();
            return;
          }
          const pulse = 0.9 + 0.1 * Math.sin((now - t0) * 0.0055);
          paint(holdX, holdY, holdRot, pulse);
          win.requestAnimationFrame(frame);
          return;
        } else {
          const k = clamp((u - contactU) / 0.28, 0, 1);
          const ease = 1 - (1 - k) * (1 - k);
          const travel = ease * g.dirTravel;
          if (g.mountFollow && ctx.place && g.dirTravel > 0) {
            ctx.place(baseLeft + g.ux * travel, baseTop + g.uy * travel);
          }
          const capX = holdX + g.ux * travel;
          const capY = holdY + g.uy * travel;
          const fade = clamp((u - contactU - 0.26) / 0.2, 0, 1);
          paint(g.screenMode ? holdX : capX, g.screenMode ? holdY : capY, holdRot, 1 - fade);
        }
        if (profile.holdUntilRelease && contacted) {
          win.requestAnimationFrame(frame);
        } else if (u < 1) win.requestAnimationFrame(frame);
        else finish();
      };
      win.requestAnimationFrame(frame);
      return true;
    }

    function play(kind, opts) {
      opts = opts || {};
      if (doc.hidden) return false;
      switch (kind) {
        case "slap": {
          if (!ctx.cockNear) return false;
          const near = ctx.cockNear();
          if (!near) return false;
          if (opts.markSpent && ctx.markFlickSpent) ctx.markFlickSpent();
          return runShaftGesture("slap", {
            src: HAND_SLAP,
            w: 78,
            oxMul: 0.88,
            oyMul: 0.5,
            windExtra: 28,
            dur: 1500,
            busyMs: 1560,
            contactDist: 22,
            travelHold: 52,
            mountFollow: true,
            particleMul: 1,
            slap: true,
            jiggle: true,
            jiggleDelay: 180,
            onContact: opts.onSlapContact || ctx.onSlapContact
          }, near);
        }
        case "push_soft": {
          const near = opts.near || (ctx.cockNear && ctx.cockNear());
          if (!near) return false;
          return runShaftGesture("push_soft", {
            src: HAND_OPEN,
            w: 70,
            windExtra: 14,
            dur: 820,
            busyMs: 860,
            contactDist: 26,
            travelHold: 22,
            mountFollow: true,
            particleMul: 0.2,
            softJiggle: true
          }, near);
        }
        case "pat": {
          const near = opts.near || (ctx.cockNear && ctx.cockNear());
          if (!near) return false;
          return runShaftGesture("pat", {
            src: HAND_OPEN,
            w: 72,
            windExtra: 16,
            dur: 960,
            busyMs: 1000,
            contactDist: 24,
            travelHold: 30,
            mountFollow: true,
            particleMul: 0.28,
            jiggle: true,
            softJiggle: true
          }, near);
        }
        case "grip_pole": {
          const near = opts.near || (ctx.cockNear && ctx.cockNear());
          if (!near) return false;
          gripRelease = false;
          return runShaftGesture("grip_pole", {
            src: HAND_GRIP,
            w: 82,
            oxMul: 0.33,
            oyMul: 0.48,
            palmLocalMul: { x: -0.33, y: 0.02 },
            landDeg: 6,
            landLean: 0.55,
            windDeg: -24,
            dur: 680,
            busyMs: 120000,
            contactDist: 34,
            travelHold: 0,
            mountFollow: true,
            particleMul: 0,
            holdUntilRelease: true,
            softJiggle: true
          }, near);
        }
        case "celebrate": {
          const av = avatarBox();
          const t = bubblePoint() || (av ? { x: av.left + av.width * 0.72, y: av.top + av.height * 0.22 } : null);
          return runScreenGesture("celebrate", {
            dur: 780,
            busyMs: 820,
            startX: 0.92,
            startY: 0.28,
            baseDeg: -24,
            particleMul: 0.35,
            jiggle: true,
            softJiggle: true
          }, t);
        }
        case "hush": {
          const t = composePoint() || bubblePoint();
          return runScreenGesture("hush", {
            dur: 680,
            busyMs: 720,
            startX: 1.05,
            startY: 0.48,
            baseDeg: 8,
            particleMul: 0
          }, t);
        }
        case "shield": {
          const av = avatarBox();
          if (!av) return false;
          return runScreenGesture("shield", {
            dur: 760,
            busyMs: 800,
            startX: 0.5,
            startY: 0.55,
            baseDeg: -6,
            particleMul: 0.15,
            softJiggle: true
          }, { x: av.left + av.width * 0.52, y: av.top + av.height * 0.38 });
        }
        case "wave": {
          const av = avatarBox();
          if (!av) return false;
          return runScreenGesture("wave", {
            dur: 1100,
            busyMs: 1150,
            startX: 0.88,
            startY: 0.32,
            baseDeg: -12,
            particleMul: 0.25,
            wave: true,
            softJiggle: true
          }, { x: av.left + av.width * 0.78, y: av.top + av.height * 0.34 });
        }
        case "catch_cursor": {
          const t = opts.x != null ? { x: opts.x, y: opts.y } : null;
          return runCatchCursor(t);
        }
        case "trace_vein": {
          const path = opts.path;
          return runTraceVein(path, opts);
        }
        default:
          return false;
      }
    }

    return { play, busy, ready, releaseHold };
  }

  return { create };
});
