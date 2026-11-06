/* Transfert HQ — dangling member: one pendulum curve, pinned at the top. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqDanglingMember = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const FIXED_DT = 1 / 60;
  const MAX_SUBSTEPS = 4;
  const MAX_ANGLE = 1.15;
  const GRAVITY = 16;
  const DAMP = 1.65;
  const FOLLOW = 0.22;
  const ENERGY_STOP = 0.0008;
  const PULL_SCREEN = 2.8;

  function calm(win) {
    try {
      return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function initDanglingMember(win) {
    const doc = win.document;
    const mount = doc.querySelector(".hq-dangling-member-mount");
    if (!mount) return;
    if (mount.__hqDangleInited) return;
    mount.__hqDangleInited = true;
    const motionReduced = calm(win);
    const swing = mount.querySelector(".hq-dangling-member-swing");
    const img = swing && swing.querySelector(".hq-dangling-member");
    if (!swing || !img) return;

    const dangleAudio = global.HqDangleAudio;
    if (dangleAudio) dangleAudio.bind(win);

    const canvas = doc.createElement("canvas");
    canvas.className = "hq-dangling-member-canvas";
    canvas.setAttribute("aria-hidden", "true");
    swing.appendChild(canvas);
    const veinCanvas = doc.createElement("canvas");
    veinCanvas.className = "hq-dangling-member-vein-canvas";
    veinCanvas.setAttribute("aria-hidden", "true");
    swing.appendChild(veinCanvas);

    let texW = 0;
    let texH = 0;
    let cw = 0;
    let ch = 0;
    let padX = 0;
    let padY = 0;
    let bufW = 0;
    let bufH = 0;
    let maxTravel = 180;
    let pxPerScreen = 1;
    let ctx = null;
    let veinCtx = null;
    let danglePaintArmed = false;
    let dangleArmTimer = 0;
    let danglePaintOn = false;
    let danglePaintFrame = false;
    let danglePaintTimer = 0;
    let danglePaintLast = 0;
    let srcPx = null;
    let dstImg = null;
    let accR = null;
    let accG = null;
    let accB = null;
    let accA = null;
    let accW = null;
    let stamp = null;
    let touched = null;
    let touchN = 0;
    let frameId = 1;
    let rowL = null;
    let rowR = null;
    let boxL = 0;
    let boxT = 0;
    let boxR = 0;
    let boxB = 0;
    let running = false;
    let dragging = false;
    let accum = 0;
    let lastFrameT = 0;
    let dirty = true;
    let angle = 0;
    let vel = 0;
    let tip = 0;
    let tipVel = 0;
    let hangLean = 0;
    let ripple = 0;
    let rippleVel = 0;
    let jiggle = 0;
    let jigglePhase = 0;
    let slack = 0;
    let slackVel = 0;
    let stretch = 0;
    let stretchVel = 0;
    let phase = 0;
    let throbStart = -1;
    let throbNow = 0;
    let veinSwellBaked = false;
    let veinWasHot = false;
    let memberBake = null;
    let memberBakeCtx = null;
    let memberBakeKey = "";
    let swellIdleScheduled = false;
    let veinPulseLastStrength = -1;
    let throbEnv = 0;
    let throbEnvTip = 0;
    let throbPhase = 0;
    let throbAmp = 1;
    let throbNextAmp = 1;
    let nextThrobAt = 0;
    let nodStart = -1;
    let nodNow = 0;
    let nodAmp = 0;
    let nodLatched = false;
    let grazeArmed = true;
    let grazeX = 0;
    let grazeT = 0;
    let mountRectW = 68;
    let resizePending = false;
    const ptr = {
      active: false,
      lastX: 0,
      lastY: 0,
      lastT: 0,
      smVx: 0,
      smVy: 0,
      downX: 0,
      downY: 0,
      hitT: 0.65,
      dragPx: 0,
      dragPy: 0,
      moving: false,
      grabOffX: 0,
      grabOffY: 0,
      carryAx: 0,
    };

    function place(left, top) {
      const box = mount.getBoundingClientRect();
      const w = mountRectW || 68;
      const anchorH = 48;
      const maxL = Math.max(0, win.innerWidth - w);
      const maxT = Math.max(0, win.innerHeight - anchorH);
      mount.style.left = clamp(left, 0, maxL) + "px";
      mount.style.top = clamp(top, 0, maxT) + "px";
      mount.style.right = "auto";
    }

    function readMount() {
      const r = mount.getBoundingClientRect();
      mountRectW = Math.max(1, r.width);
      return r;
    }

    function relY(clientY) {
      const r = mount.getBoundingClientRect();
      return clamp((clientY - r.top) / Math.max(1, r.height), 0.08, 0.96);
    }

    function dragGoal(raw) {
      const lim = maxTravel;
      if (Math.abs(raw) <= lim) return raw;
      const sign = raw < 0 ? -1 : 1;
      return sign * lim * Math.tanh(Math.abs(raw) / lim);
    }

    function aimAngle() {
      const y = Math.max(ch * 0.22, ch * ptr.hitT);
      return clamp(Math.atan2(dragGoal(ptr.dragPx), y), -MAX_ANGLE, MAX_ANGLE);
    }

    function throbBump(along) {
      if (throbEnv <= 0.001) return 0;
      const crest = 0.08 + 0.9 * throbPhase;
      const dist = along - crest;
      return throbEnv * throbAmp * Math.exp(-(dist * dist) / 0.11);
    }

    function stepLen(along) {
      const shorten = slack * Math.pow(along, 1.08);
      const lengthen = stretch * (0.55 + 0.45 * Math.pow(along, 0.85));
      return clamp(1 - shorten + lengthen, 0.55, 1.32) * (1 + throbBump(along) * 0.02);
    }

    function dir(t) {
      if (oralEngaged && oralAngTable) {
        const s = clamp(Math.round(t * (ch - 1)), 0, ch - 1);
        return oralAngTable[s];
      }
      if (oralEngaged) {
        return clamp(angle * 0.2 + 1.52 * 0.8, -MAX_ANGLE * 1.35, MAX_ANGLE * 1.35);
      }
      const along = Math.pow(t, 1.2);
      const lag = clamp(tip - angle, -1.15, 1.15);
      let hang = angle * (0.4 + 0.6 * along) + lag * along * along + nodNow * Math.pow(t, 5);
      const wave = ripple * Math.sin(t * Math.PI * 2.15 - phase) * Math.sin(t * Math.PI);
      const wobble =
        jiggle * Math.sin(jigglePhase) * Math.sin(t * Math.PI) * (0.35 + 0.65 * t) * 0.34;
      return clamp(hang + wave + wobble, -MAX_ANGLE * 1.35, MAX_ANGLE * 1.35);
    }

    function springRipple(dt, amp) {
      rippleVel += (amp - ripple) * 8 * dt - rippleVel * 3.2 * dt;
      ripple += rippleVel * dt;
    }

    function step(dt) {
      const prev = angle;
      if (dragging) {
        const target = aimAngle();
        const up = clamp(-ptr.dragPy / (ch * 0.16) + Math.max(0, -ptr.smVy) / 520, 0, 1);
        const down = clamp(ptr.dragPy / (ch * 0.16), 0, 1);
        angle += (target * (1 - down * 0.95) - angle) * FOLLOW;
        vel = (angle - prev) / dt;
        const side = Math.abs(angle) > 0.05 ? Math.sign(angle) : Math.abs(ptr.smVx) > 20 ? Math.sign(ptr.smVx) : Math.sign(tip || 1);
        const buckle = up * side * (1.05 + ptr.hitT * 0.85);
        tipVel += (angle * 1.5 * (1 - down * 0.9) + buckle - tip) * (8 - up * 3) * dt;
        tipVel -= tipVel * (2.4 - up * 0.8) * dt;
        tip += tipVel * dt;
        const slackTarget = up * (0.42 + ptr.hitT * 0.2) * (1 - down);
        slackVel += (slackTarget - slack) * 12 * dt - slackVel * 2.4 * dt;
        slack += slackVel * dt;
        springRipple(dt, Math.min(0.1, Math.abs(vel) * 0.018 + up * 0.06));
      } else if (ptr.moving) {
        const idle = (win.performance.now() - ptr.lastT) * 0.001;
        if (idle > 0.04) {
          ptr.smVx *= Math.exp(-18 * dt);
          ptr.smVy *= Math.exp(-18 * dt);
        }
        if (Math.abs(ptr.smVx) < 12) ptr.smVx = 0;
        if (Math.abs(ptr.smVy) < 12) ptr.smVy = 0;
        const riseSpeed = Math.max(0, -ptr.smVy);
        const dropSpeed = Math.max(0, ptr.smVy);
        const rising = clamp((riseSpeed - 180) / 700, 0, 1);
        const dropping = clamp((dropSpeed - 180) / 700, 0, 1);
        const oralLean = oralCarryLean();
        let targetLean;
        let leanStep;
        if (oralLean != null) {
          const snap = oralPhase === "active" ? 18 : 10;
          const k = Math.min(1, snap * dt);
          angle += (oralLean.base - angle) * k;
          hangLean = angle;
          tip += (oralLean.tip - tip) * k;
          vel = 0;
          tipVel = 0;
          ripple = 0;
          rippleVel = 0;
          jiggle = 0;
          slack = 0;
          slackVel = 0;
          stretch = 0;
          stretchVel = 0;
        } else {
          const along = clamp(-ptr.smVx / 460, -0.92, 0.92);
          if (contactAim == null) {
            targetLean = along;
            leanStep = 2.4;
          } else {
            targetLean = clamp(contactAim + clamp(-ptr.smVx / 1400, -0.22, 0.22), -MAX_ANGLE, MAX_ANGLE);
            leanStep = 7;
          }
          hangLean += clamp(targetLean - hangLean, -leanStep * dt, leanStep * dt);
          const err = clamp(hangLean - angle, -0.9, 0.9);
          const acc = err * 12 - vel * 2.05;
          vel = clamp(vel + acc * dt, -8, 8);
          angle = clamp(angle + vel * dt, -MAX_ANGLE, MAX_ANGLE);
          tipVel += (angle * 1.38 - tip) * 7.2 * dt - tipVel * 2.05 * dt;
          tip += tipVel * dt;
          const slackTarget = dropping * 0.32;
          slackVel += (slackTarget - slack) * 16 * dt - slackVel * 3.4 * dt;
          slack += slackVel * dt;
          const stretchTarget = rising * 0.22;
          stretchVel += (stretchTarget - stretch) * 18 * dt - stretchVel * 3.6 * dt;
          stretch += stretchVel * dt;
          springRipple(dt, Math.min(0.07, Math.abs(vel) * 0.014));
        }
      } else if (restName) {
        const acc = (restAngle - angle) * 9 - vel * 4.4;
        vel += acc * dt;
        angle = clamp(angle + vel * dt, -MAX_ANGLE, MAX_ANGLE);
        tipVel += (angle * 1.12 - tip) * 8 * dt - tipVel * 3.1 * dt;
        tip += tipVel * dt;
        const slackTarget = restName ? clamp(0.16 + give * 0.12, 0.04, 0.3) : 0;
        slackVel += (slackTarget - slack) * 8 * dt - slackVel * 3.2 * dt;
        slack += slackVel * dt;
        stretchVel += -stretch * 10 * dt - stretchVel * 3 * dt;
        stretch += stretchVel * dt;
        springRipple(dt, 0.02);
      } else {
        const acc = -Math.sin(angle) * GRAVITY - vel * DAMP;
        vel += acc * dt;
        angle += vel * dt;
        angle = clamp(angle, -MAX_ANGLE, MAX_ANGLE);
        tipVel += (angle * 1.62 - tip) * 6.2 * dt - tipVel * 1.45 * dt;
        tip += tipVel * dt;
        slackVel += -slack * 16 * dt - slackVel * 3.4 * dt;
        slack += slackVel * dt;
        stretchVel += -stretch * 18 * dt - stretchVel * 3.6 * dt;
        stretch += stretchVel * dt;
        springRipple(dt, Math.min(0.08, Math.abs(vel) * 0.012));
      }
      if (jiggle > 0) {
        jigglePhase += dt * 28;
        jiggle *= Math.exp(-4.4 * dt);
        if (jiggle < 0.02) jiggle = 0;
      }
      if (flickLean) {
        hangLean = clamp(hangLean + flickLean * 2.8 * dt, -MAX_ANGLE, MAX_ANGLE);
        angle = clamp(angle + flickLean * 4.2 * dt, -MAX_ANGLE, MAX_ANGLE);
        tip += flickLean * 6 * dt;
        vel += flickLean * 8 * dt;
        flickLean *= Math.exp(-5 * dt);
        if (Math.abs(flickLean) < 0.02) flickLean = 0;
      }
      if (oralBob !== 0) {
        oralBob *= Math.exp(-8 * dt);
        if (Math.abs(oralBob) < 0.05) oralBob = 0;
        dirty = true;
      }
      tip = clamp(tip, -MAX_ANGLE * 1.45, MAX_ANGLE * 1.45);
      slack = clamp(slack, 0, 0.4);
      stretch = clamp(stretch, 0, 0.3);
      ripple = clamp(ripple, -0.2, 0.2);
      phase += dt * 8.5;
      tickVeinTrace(dt);
      stepVeinPulse(dt);
      dirty = true;
    }

    function renderFlat() {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bufW, bufH);
      ctx.drawImage(img, 0, 0, texW, texH, padX, padY, cw, ch);
      dirty = false;
    }

    function memberBakeKeyNow() {
      return cw + "x" + ch + "x" + padX + "x" + padY + "x" + veinSwellMode;
    }

    function invalidateMemberBake() {
      memberBakeKey = "";
    }

    function drawFlatTo(targetCtx) {
      if (!targetCtx || !cw || !ch) return;
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.clearRect(0, 0, bufW, bufH);
      targetCtx.drawImage(img, 0, 0, texW, texH, padX, padY, cw, ch);
    }

    function rebuildMemberBake(nowMs, withSwell) {
      if (!cw || !bufW || !bufH) return false;
      if (!memberBake) {
        memberBake = doc.createElement("canvas");
        memberBakeCtx = memberBake.getContext("2d", { alpha: true });
      }
      if (!memberBakeCtx) return false;
      memberBake.width = bufW;
      memberBake.height = bufH;
      drawFlatTo(memberBakeCtx);
      if (withSwell && ensureVeinSwellField()) {
        const saved = ctx;
        ctx = memberBakeCtx;
        paintVeinSwell(nowMs || win.performance.now(), true);
        ctx = saved;
      }
      memberBakeKey = memberBakeKeyNow() + (withSwell ? ":s" : ":f");
      return true;
    }

    function blitMemberBake(nowMs) {
      if (!ctx) return;
      const key = memberBakeKeyNow();
      const wantSwell = veinSwellBaked;
      const bakeKey = key + (wantSwell ? ":s" : ":f");
      if (!memberBake || memberBakeKey !== bakeKey) {
        if (!rebuildMemberBake(nowMs, wantSwell && !!swellW)) {
          renderFlat();
          return;
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bufW, bufH);
      ctx.drawImage(memberBake, 0, 0);
      dirty = false;
    }

    function scheduleSwellIdleBake() {
      if (motionReduced || swellIdleScheduled || veinSwellBaked || veinRenderHot()) return;
      swellIdleScheduled = true;
      const run = () => {
        swellIdleScheduled = false;
        if (!ctx || doc.hidden || veinRenderHot()) return;
        if (!ensureVeinSwellField()) return;
        rebuildMemberBake(win.performance.now(), true);
        veinSwellBaked = true;
        scheduleDanglePaint(0);
      };
      if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(run, { timeout: 900 });
      else win.setTimeout(run, 450);
    }

    function ensureVeinSwellField() {
      if (!cw || !ch) return false;
      const key = cw + "x" + ch + "x" + padX + "x" + padY + "x" + veinSwellMode;
      if (swellW && swellKey === key) return true;
      const paths = ensureVeinBufPaths();
      if (!paths.length) return false;
      swellKey = key;
      const n = cw * ch;
      swellDx = new Float32Array(n);
      swellDy = new Float32Array(n);
      swellW = new Float32Array(n);
      swellDist = new Float32Array(n);
      swellDist2 = new Float32Array(n);
      swellPath = new Uint16Array(n);
      swellPath2 = new Uint16Array(n);
      swellTx = new Float32Array(n);
      swellTx2 = new Float32Array(n);
      swellNx = new Float32Array(n);
      swellNy = new Float32Array(n);
      swellTier = new Float32Array(n);
      const tune = veinSwellTune();
      swellRad = Math.max(tune.radMin, cw * tune.radScale);
      const rad = swellRad;
      const rad2 = rad * rad;
      for (let p = 0; p < paths.length; p += 1) {
        const pts = paths[p].pts;
        const tier = paths[p].tier === "secondary" ? 0.72 : 1;
        for (let i = 0; i < pts.length - 1; i += 1) {
          const ax = pts[i].x - padX;
          const ay = pts[i].y - padY;
          const bx = pts[i + 1].x - padX;
          const by = pts[i + 1].y - padY;
          const sdx = bx - ax;
          const sdy = by - ay;
          const len2 = sdx * sdx + sdy * sdy || 1;
          const minX = Math.max(0, Math.floor(Math.min(ax, bx) - rad));
          const maxX = Math.min(cw - 1, Math.ceil(Math.max(ax, bx) + rad));
          const minY = Math.max(0, Math.floor(Math.min(ay, by) - rad));
          const maxY = Math.min(ch - 1, Math.ceil(Math.max(ay, by) + rad));
          const sl = Math.sqrt(len2);
          const tx = sdx / sl;
          const pathId = p + 1;
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              let t = ((x - ax) * sdx + (y - ay) * sdy) / len2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const px = ax + sdx * t;
              const py = ay + sdy * t;
              const ox = x - px;
              const oy = y - py;
              const d2 = ox * ox + oy * oy;
              if (d2 > rad2 || d2 < 0.2) continue;
              const d = Math.sqrt(d2);
              const dome = Math.sin((d / rad) * Math.PI) * tier;
              const idx = y * cw + x;
              swellW[idx] += dome;
              swellDx[idx] += (ox / d) * dome;
              swellDy[idx] += (oy / d) * dome;
              if (swellDist[idx] === 0 || d < swellDist[idx]) {
                if (swellPath[idx] && swellPath[idx] !== pathId) {
                  swellDist2[idx] = swellDist[idx];
                  swellPath2[idx] = swellPath[idx];
                  swellTx2[idx] = swellTx[idx];
                }
                swellDist[idx] = d;
                swellNx[idx] = ox / d;
                swellNy[idx] = oy / d;
                swellTier[idx] = tier;
                swellPath[idx] = pathId;
                swellTx[idx] = tx;
              } else if (swellPath[idx] !== pathId && (swellPath2[idx] === 0 || d < swellDist2[idx])) {
                swellDist2[idx] = d;
                swellPath2[idx] = pathId;
                swellTx2[idx] = tx;
              }
            }
          }
        }
      }
      const blurVec = (src, radius) => {
        const nPix = cw * ch;
        const horiz = new Float32Array(nPix);
        const vert = new Float32Array(nPix);
        const r = radius;
        const span = r * 2 + 1;
        for (let y = 0; y < ch; y += 1) {
          for (let x = 0; x < cw; x += 1) {
            let s = 0;
            for (let k = -r; k <= r; k += 1) {
              const xx = x + k < 0 ? 0 : x + k >= cw ? cw - 1 : x + k;
              s += src[y * cw + xx];
            }
            horiz[y * cw + x] = s / span;
          }
        }
        for (let y = 0; y < ch; y += 1) {
          for (let x = 0; x < cw; x += 1) {
            let s = 0;
            for (let k = -r; k <= r; k += 1) {
              const yy = y + k < 0 ? 0 : y + k >= ch ? ch - 1 : y + k;
              s += horiz[yy * cw + x];
            }
            vert[y * cw + x] = s / span;
          }
        }
        return vert;
      };
      const fieldPeak = (dx, dy) => {
        let peak = 0;
        const nPix = cw * ch;
        for (let i = 0; i < nPix; i += 1) {
          const mag = Math.hypot(dx[i], dy[i]);
          if (mag > peak) peak = mag;
        }
        return peak;
      };
      const peakBefore = fieldPeak(swellDx, swellDy);
      swellDx = blurVec(blurVec(swellDx, 4), 3);
      swellDy = blurVec(blurVec(swellDy, 4), 3);
      if (veinSwellMode === "extreme") {
        swellDx = blurVec(blurVec(swellDx, 6), 5);
        swellDy = blurVec(blurVec(swellDy, 6), 5);
      }
      const peakAfter = fieldPeak(swellDx, swellDy);
      if (peakBefore > 0.01 && peakAfter > 0.01) {
        const gain = peakBefore / peakAfter;
        const nPix = cw * ch;
        for (let i = 0; i < nPix; i += 1) {
          swellDx[i] *= gain;
          swellDy[i] *= gain;
        }
      }
      swellNxRaw = new Float32Array(swellNx);
      swellNyRaw = new Float32Array(swellNy);
      swellNx = blurVec(blurVec(swellNx, 3), 2);
      swellNy = blurVec(blurVec(swellNy, 3), 2);
      swellImg = ctx.createImageData(cw, ch);
      return true;
    }

    function spreadVeinInk() {
      inkPx = null;
      if (!srcPx || !swellW || !cw || !ch) return;
      const n = cw * ch;
      const ink = new Uint8Array(n);
      const lumaAt = (i) => {
        const o = i * 4;
        if (srcPx[o + 3] < 40) return 255;
        return srcPx[o] * 0.3 + srcPx[o + 1] * 0.59 + srcPx[o + 2] * 0.11;
      };
      for (let y = 3; y < ch - 3; y += 1) {
        for (let x = 3; x < cw - 3; x += 1) {
          const i = y * cw + x;
          if (swellW[i] < 0.18) continue;
          const lum = lumaAt(i);
          if (lum > 48) continue;
          let hi = lum;
          for (let oy = -3; oy <= 3; oy += 1) {
            for (let ox = -3; ox <= 3; ox += 1) {
              const l = lumaAt((y + oy) * cw + (x + ox));
              if (l > hi) hi = l;
            }
          }
          if (hi - lum > 34) ink[i] = 1;
        }
      }
      inkPx = new Uint8ClampedArray(srcPx);
      for (let y = 2; y < ch - 2; y += 1) {
        for (let x = 2; x < cw - 2; x += 1) {
          const i = y * cw + x;
          if (ink[i] || swellW[i] < 0.12) continue;
          let bd = 9;
          let br = 0;
          let bg = 0;
          let bb = 0;
          for (let oy = -2; oy <= 2; oy += 1) {
            for (let ox = -2; ox <= 2; ox += 1) {
              const d = Math.abs(ox) + Math.abs(oy);
              if (d === 0 || d > 2) continue;
              const k = (y + oy) * cw + (x + ox);
              if (!ink[k] || d >= bd) continue;
              bd = d;
              const j = k * 4;
              br = srcPx[j];
              bg = srcPx[j + 1];
              bb = srcPx[j + 2];
            }
          }
          if (bd > 2) continue;
          const mix = bd === 1 ? 0.62 : 0.28;
          const o = i * 4;
          inkPx[o] = srcPx[o] + (br - srcPx[o]) * mix;
          inkPx[o + 1] = srcPx[o + 1] + (bg - srcPx[o + 1]) * mix;
          inkPx[o + 2] = srcPx[o + 2] + (bb - srcPx[o + 2]) * mix;
        }
      }
    }

    function sampleShaft(sx, sy, buf) {
      const data = buf || srcPx;
      if (!data || sx < 0 || sy < 0 || sx > cw - 1.001 || sy > ch - 1.001) return null;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 < cw ? x0 + 1 : x0;
      const y1 = y0 + 1 < ch ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * cw + x0) * 4;
      const i10 = (y0 * cw + x1) * 4;
      const i01 = (y1 * cw + x0) * 4;
      const i11 = (y1 * cw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      return [
        data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11,
        data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11,
        data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11,
        data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11
      ];
    }

    function veinFieldAt(x, y) {
      const x0 = x <= 0 ? 0 : x >= cw - 1 ? cw - 1 : x | 0;
      const y0 = y <= 0 ? 0 : y >= ch - 1 ? ch - 1 : y | 0;
      const x1 = x0 + 1 < cw ? x0 + 1 : x0;
      const y1 = y0 + 1 < ch ? y0 + 1 : y0;
      const fx = x <= x0 ? 0 : x >= x1 ? 1 : x - x0;
      const fy = y <= y0 ? 0 : y >= y1 ? 1 : y - y0;
      const i00 = y0 * cw + x0;
      const i10 = y0 * cw + x1;
      const i01 = y1 * cw + x0;
      const i11 = y1 * cw + x1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      return [
        swellDx[i00] * w00 + swellDx[i10] * w10 + swellDx[i01] * w01 + swellDx[i11] * w11,
        swellDy[i00] * w00 + swellDy[i10] * w10 + swellDy[i01] * w01 + swellDy[i11] * w11,
        swellDist[i00] * w00 + swellDist[i10] * w10 + swellDist[i01] * w01 + swellDist[i11] * w11
      ];
    }

    function veinSwellTune() {
      if (veinSwellMode === "extreme") {
        return { ampExcited: 4.4, cap: 0.4, radScale: 0.24, radMin: 13, soft: 0.62, fat: 4.73, fadePow: 1.12 };
      }
      return { ampExcited: 4.4, cap: 0.4, radScale: 0.14, radMin: 8, soft: 0.62, fat: 0, fadePow: 2 };
    }

    function setVeinSwellMode(mode) {
      const next = mode === "extreme" ? "extreme" : "epic";
      if (next === veinSwellMode && mount.dataset.veinSwell === next) return next;
      veinSwellMode = next;
      mount.dataset.veinSwell = next;
      swellKey = "";
      try {
        win.localStorage.setItem("hq-vein-swell", next);
      } catch (_) {}
      return next;
    }

    function veinSwellWiden(x, y, pulse) {
      const x0 = x <= 0 ? 0 : x >= cw - 1 ? cw - 1 : x | 0;
      const y0 = y <= 0 ? 0 : y >= ch - 1 ? ch - 1 : y | 0;
      const x1 = x0 + 1 < cw ? x0 + 1 : x0;
      const y1 = y0 + 1 < ch ? y0 + 1 : y0;
      let dist = 0;
      let nx = 0;
      let ny = 0;
      let tier = 1;
      const cells = [y0 * cw + x0, y0 * cw + x1, y1 * cw + x0, y1 * cw + x1];
      for (let c = 0; c < 4; c += 1) {
        const i = cells[c];
        const d = swellDist[i];
        if (d > 0.2 && (dist === 0 || d < dist)) {
          dist = d;
          nx = swellNx[i];
          ny = swellNy[i];
          tier = swellTier[i] || 1;
        }
      }
      if (!(dist > 0.2) || !swellRad) return [x, y];
      const mag = Math.hypot(nx, ny);
      if (mag < 0.22) return [x, y];
      nx /= mag;
      ny /= mag;
      const u = dist / swellRad;
      if (u >= 1) return [x, y];
      const excited = clamp((pulse - 0.55) / 0.25, 0, 1);
      let agree = 1;
      for (let c = 0; c < 4; c += 1) {
        const i = cells[c];
        if (!(swellDist[i] > 0.2)) continue;
        const nmag = Math.hypot(swellNx[i], swellNy[i]);
        if (nmag < 0.05) continue;
        const dot = nx * (swellNx[i] / nmag) + ny * (swellNy[i] / nmag);
        if (dot < agree) agree = dot;
      }
      const calm = clamp((agree - 0.15) / 0.85, 0.12, 1) * clamp((mag - 0.22) / 0.55, 0, 1);
      const tune = veinSwellTune();
      const fade = Math.pow(1 - u, tune.fadePow);
      const fat = excited * tune.fat * tier * fade * calm;
      let srcDist = dist / (1 + fat);
      const floor = dist * 0.2;
      if (srcDist < floor) srcDist = floor;
      const push = dist - srcDist;
      return [x - nx * push, y - ny * push];
    }

    function veinSwellSample(x, y, pulse) {
      if (veinSwellMode === "extreme") return veinSwellWiden(x, y, pulse);
      const field = veinFieldAt(x, y);
      const dx = field[0];
      const dy = field[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 0.04)) return [x, y];
      const excited = clamp((pulse - 0.55) / 0.25, 0, 1);
      const tune = veinSwellTune();
      const amp = 0.25 + pulse * 0.12 + excited * tune.ampExcited;
      let push = Math.min(1, len) * amp;
      const dist = field[2];
      if (dist > 0.4) {
        const cap = dist * tune.cap;
        push = cap * (1 - Math.exp(-push / (cap * tune.soft)));
      }
      return [x - (dx / len) * push, y - (dy / len) * push];
    }

    function sampleRaster(data, w, h, sx, sy) {
      if (sx < 0) sx = 0;
      else if (sx > w - 1.001) sx = w - 1.001;
      if (sy < 0) sy = 0;
      else if (sy > h - 1.001) sy = h - 1.001;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0;
      const y1 = y0 + 1 < h ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      return [
        data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11,
        data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11,
        data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11,
        data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11
      ];
    }

    function warpVeinOverlay(pulse) {
      if (!veinCtx || !swellDx || !cw || !ch) return;
      const src = veinCtx.getImageData(padX, padY, cw, ch);
      const dst = veinCtx.createImageData(cw, ch);
      const d = dst.data;
      const coarse = !veinRenderHot();
      const stride = coarse ? 2 : 1;
      for (let y = 0; y < ch; y += stride) {
        for (let x = 0; x < cw; x += stride) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          const steps = coarse ? 1 : (veinSwellMode === "extreme" ? 3 : 2);
          const inv = 1 / (steps * steps);
          for (let oy = 0; oy < steps; oy += 1) {
            for (let ox = 0; ox < steps; ox += 1) {
              const at = veinSwellSample(x + ox / steps, y + oy / steps, pulse);
              const pix = sampleRaster(src.data, cw, ch, at[0], at[1]);
              r += pix[0];
              g += pix[1];
              b += pix[2];
              a += pix[3];
            }
          }
          const rv = r * inv;
          const gv = g * inv;
          const bv = b * inv;
          const av = a * inv;
          const write = (px, py) => {
            const di = (py * cw + px) * 4;
            d[di] = rv;
            d[di + 1] = gv;
            d[di + 2] = bv;
            d[di + 3] = av;
          };
          write(x, y);
          if (stride === 2) {
            if (x + 1 < cw) write(x + 1, y);
            if (y + 1 < ch) write(x, y + 1);
            if (x + 1 < cw && y + 1 < ch) write(x + 1, y + 1);
          }
        }
      }
      veinCtx.putImageData(dst, padX, padY);
    }

    function swellRenderScale() {
      return veinSwellMode === "extreme" ? 3 : 2;
    }

    function blurRaster(data, w, h) {
      const n = data.length;
      if (!swellBlur || swellBlur.length !== n) swellBlur = new Float32Array(n);
      const tmp = swellBlur;
      for (let y = 0; y < h; y += 1) {
        const row = y * w;
        for (let x = 0; x < w; x += 1) {
          const xl = x > 0 ? x - 1 : x;
          const xr = x + 1 < w ? x + 1 : x;
          const i = (row + x) * 4;
          const il = (row + xl) * 4;
          const ir = (row + xr) * 4;
          tmp[i] = data[il] * 0.25 + data[i] * 0.5 + data[ir] * 0.25;
          tmp[i + 1] = data[il + 1] * 0.25 + data[i + 1] * 0.5 + data[ir + 1] * 0.25;
          tmp[i + 2] = data[il + 2] * 0.25 + data[i + 2] * 0.5 + data[ir + 2] * 0.25;
          tmp[i + 3] = data[il + 3] * 0.25 + data[i + 3] * 0.5 + data[ir + 3] * 0.25;
        }
      }
      for (let y = 0; y < h; y += 1) {
        const yu = y > 0 ? y - 1 : y;
        const yd = y + 1 < h ? y + 1 : y;
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const iu = (yu * w + x) * 4;
          const id = (yd * w + x) * 4;
          data[i] = tmp[iu] * 0.25 + tmp[i] * 0.5 + tmp[id] * 0.25;
          data[i + 1] = tmp[iu + 1] * 0.25 + tmp[i + 1] * 0.5 + tmp[id + 1] * 0.25;
          data[i + 2] = tmp[iu + 2] * 0.25 + tmp[i + 2] * 0.5 + tmp[id + 2] * 0.25;
          data[i + 3] = tmp[iu + 3] * 0.25 + tmp[i + 3] * 0.5 + tmp[id + 3] * 0.25;
        }
      }
    }

    function ensureSwellHi() {
      if (!cw || !ch || !img || !texW || !texH) return false;
      const scale = swellRenderScale();
      const w = cw * scale;
      const h = ch * scale;
      const key = w + "x" + h;
      if (!swellHi) {
        swellHi = doc.createElement("canvas");
        swellHiCtx = swellHi.getContext("2d", { willReadFrequently: true });
      }
      if (!swellHiCtx) return false;
      if (swellHi.width !== w || swellHi.height !== h || swellHiKey !== key) {
        swellHi.width = w;
        swellHi.height = h;
        swellHiKey = key;
        swellHiCtx.imageSmoothingEnabled = true;
        swellHiCtx.imageSmoothingQuality = "high";
        swellHiCtx.clearRect(0, 0, w, h);
        swellHiCtx.drawImage(img, 0, 0, texW, texH, 0, 0, w, h);
        swellHiPx = swellHiCtx.getImageData(0, 0, w, h).data;
        swellHiImg = swellHiCtx.createImageData(w, h);
      }
      return !!swellHiPx && !!swellHiImg;
    }

    function swellDistAt(px, py) {
      if (!swellDist || !cw || !ch) return 0;
      const ix = px <= 0 ? 0 : px >= cw - 1 ? cw - 1 : px | 0;
      const iy = py <= 0 ? 0 : py >= ch - 1 ? ch - 1 : py | 0;
      return swellDist[iy * cw + ix];
    }

    function shadeVeinRelief(r, g, b, x, y, pulse) {
      if (!swellDist || !swellRad) return [r, g, b];
      const ix = x <= 0 ? 0 : x >= cw - 1 ? cw - 1 : x | 0;
      const iy = y <= 0 ? 0 : y >= ch - 1 ? ch - 1 : y | 0;
      const idx = iy * cw + ix;
      const dist = swellDist[idx];
      if (!(dist > 0.3)) return [r, g, b];
      const u = dist / swellRad;
      if (u >= 1) return [r, g, b];
      let nx0 = swellNx[idx];
      let ny0 = swellNy[idx];
      if (swellNxRaw && swellNyRaw) {
        const rx = swellNxRaw[idx];
        const ry = swellNyRaw[idx];
        if (rx * rx + ry * ry > 0.04) {
          nx0 = rx;
          ny0 = ry;
        }
      }
      const mag = Math.hypot(nx0, ny0);
      if (mag < 0.2) return [r, g, b];
      const nx = nx0 / mag;
      const ny = ny0 / mag;
      const ndot = nx * -0.62 + ny * -0.78;
      const excited = clamp((pulse - 0.55) / 0.25, 0, 1);
      const lit = 0.55 + excited * 0.4;
      const crestBand = clamp(1 - u / 0.2, 0, 1);
      const crestFace = clamp((ndot - 0.18) / 0.62, 0, 1);
      const crest = crestBand * crestBand * crestFace * lit;
      const lift = crest * 14;
      const rimIn = clamp((u - 0.4) / 0.22, 0, 1);
      const rimOut = clamp((1.02 - u) / 0.3, 0, 1);
      const underside = 0.45 + clamp(-ndot, 0, 1) * 0.55;
      const crease = rimIn * rimOut * underside * (0.07 + excited * 0.09);
      const valley = clamp((u - 0.74) / 0.26, 0, 1) * (0.035 + excited * 0.03);
      const castAt = swellDistAt(x - (2.2 + excited * 1.1), y - (2.8 + excited * 1.4));
      let cast = 0;
      if (castAt > 0.3 && swellRad) {
        const cu = castAt / swellRad;
        if (cu < 0.4 && u > 0.3) {
          const near = 1 - cu / 0.4;
          const offVein = clamp((u - 0.3) / 0.34, 0, 1);
          cast = near * offVein * (0.07 + excited * 0.06);
        }
      }
      let under = 0;
      if (swellPath && swellPath2 && swellDist2) {
        const mine = swellPath[idx];
        const other = swellPath2[idx];
        const otherD = swellDist2[idx];
        const reach = swellRad * 0.3;
        if (mine && other && mine !== other && otherD > 0 && otherD < reach && u < 0.38) {
          const front = Math.abs(swellTx[idx]) >= Math.abs(swellTx2[idx]) ? mine : other;
          if (mine !== front) {
            const pinch = (1 - u / 0.38) * (1 - otherD / reach);
            under = pinch * (0.18 + excited * 0.08);
          }
        }
      }
      const mul = Math.max(0.72, 1 - crease - valley - cast - under);
      return [
        clamp(r * mul + lift, 0, 255),
        clamp(g * mul + lift * 0.9, 0, 255),
        clamp(b * mul + lift * 0.8, 0, 255)
      ];
    }

    function tintSwellPurple(r, g, b, a, pulse, x, y) {
      if (a < 8) return [r, g, b];
      const k = clamp((pulse - 0.4) / 0.6, 0, 1);
      const along = y / Math.max(1, ch - 1);
      const head = clamp((along - 0.28) / 0.52, 0, 1);
      const side = cw > 1 ? x / cw : 0.5;
      const under = clamp((side - 0.42) / 0.46, 0, 1);
      const lift = k * (12 + head * 40 + under * 18);
      return [
        clamp(r + lift * 0.1, 0, 255),
        clamp(g - lift * 0.5, 0, 255),
        clamp(b + lift * (0.85 + head * 0.35), 0, 255)
      ];
    }

    function paintVeinSwell(nowMs, blit) {
      if (!ctx || !srcPx || !cw || !ch) return;
      if (!ensureVeinSwellField() || !ensureSwellHi()) return;
      const pulse = veinPulseStrength(nowMs || win.performance.now());
      const scale = swellRenderScale();
      const hw = cw * scale;
      const hh = ch * scale;
      const hd = swellHiImg.data;
      const step = 1 / scale;
      const stride = veinRenderHot() ? 1 : 2;
      for (let y = 0; y < hh; y += stride) {
        const ly = y * step;
        for (let x = 0; x < hw; x += stride) {
          const at = veinSwellSample(x * step, ly, pulse);
          const pix = sampleRaster(swellHiPx, hw, hh, at[0] * scale, at[1] * scale);
          const shade = shadeVeinRelief(pix[0], pix[1], pix[2], x * step, ly, pulse);
          const tint = tintSwellPurple(shade[0], shade[1], shade[2], pix[3], pulse, x * step, ly);
          const di = (y * hw + x) * 4;
          hd[di] = tint[0];
          hd[di + 1] = tint[1];
          hd[di + 2] = tint[2];
          hd[di + 3] = pix[3];
          if (stride === 2) {
            const xr = x + 1 < hw;
            const yr = y + 1 < hh;
            if (xr) {
              const d2 = (y * hw + x + 1) * 4;
              hd[d2] = tint[0];
              hd[d2 + 1] = tint[1];
              hd[d2 + 2] = tint[2];
              hd[d2 + 3] = pix[3];
            }
            if (yr) {
              const d3 = ((y + 1) * hw + x) * 4;
              hd[d3] = tint[0];
              hd[d3 + 1] = tint[1];
              hd[d3 + 2] = tint[2];
              hd[d3 + 3] = pix[3];
            }
            if (xr && yr) {
              const d4 = ((y + 1) * hw + x + 1) * 4;
              hd[d4] = tint[0];
              hd[d4 + 1] = tint[1];
              hd[d4 + 2] = tint[2];
              hd[d4 + 3] = pix[3];
            }
          }
        }
      }
      if (veinSwellMode === "extreme") {
        blurRaster(hd, hw, hh);
        blurRaster(hd, hw, hh);
      }
      swellHiCtx.putImageData(swellHiImg, 0, 0);
      const dst = swellImg.data;
      const area = scale * scale;
      for (let y = 0; y < ch; y += 1) {
        for (let x = 0; x < cw; x += 1) {
          const di = (y * cw + x) * 4;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let oy = 0; oy < scale; oy += 1) {
            for (let ox = 0; ox < scale; ox += 1) {
              const si = ((y * scale + oy) * hw + (x * scale + ox)) * 4;
              r += hd[si];
              g += hd[si + 1];
              b += hd[si + 2];
              a += hd[si + 3];
            }
          }
          dst[di] = r / area;
          dst[di + 1] = g / area;
          dst[di + 2] = b / area;
          dst[di + 3] = a / area;
        }
      }
      if (blit !== false) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(swellHi, padX, padY, cw, ch);
      }
    }

    function bodyIsFlat() {
      return (
        !running &&
        !restName &&
        !oralEngaged &&
        !dragging &&
        throbNow < 0.01 &&
        nodNow < 0.01 &&
        jiggle < 0.02
      );
    }

    function bakeSource() {
      if (!ctx || !cw || !ch) return;
      const bake = doc.createElement("canvas");
      bake.width = cw;
      bake.height = ch;
      const bctx = bake.getContext("2d", { willReadFrequently: true });
      if (!bctx) return;
      bctx.drawImage(img, 0, 0, texW, texH, 0, 0, cw, ch);
      srcPx = bctx.getImageData(0, 0, cw, ch).data;
      dstImg = ctx.createImageData(bufW, bufH);
      const n = bufW * bufH;
      accR = new Float32Array(n);
      accG = new Float32Array(n);
      accB = new Float32Array(n);
      accA = new Float32Array(n);
      accW = new Float32Array(n);
      stamp = new Uint16Array(n);
      touched = new Int32Array(n);
      touchN = 0;
      frameId = 1;
      rowL = new Uint16Array(ch);
      rowR = new Uint16Array(ch);
      for (let s = 0; s < ch; s += 1) {
        let left = 0;
        let right = cw - 1;
        const row = s * cw;
        while (left < cw && srcPx[(row + left) * 4 + 3] < 8) left += 1;
        while (right > left && srcPx[(row + right) * 4 + 3] < 8) right -= 1;
        rowL[s] = left;
        rowR[s] = right;
      }
    }

    function deposit(dx, dy, r, g, b, a) {
      const x0 = dx | 0;
      const y0 = dy | 0;
      const fx = dx - x0;
      const fy = dy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const add = (x, y, w) => {
        if (w < 0.02 || x < 0 || y < 0 || x >= bufW || y >= bufH) return;
        const i = y * bufW + x;
        if (stamp[i] !== frameId) {
          stamp[i] = frameId;
          accR[i] = 0;
          accG[i] = 0;
          accB[i] = 0;
          accA[i] = 0;
          accW[i] = 0;
          touched[touchN] = i;
          touchN += 1;
          if (x < boxL) boxL = x;
          if (y < boxT) boxT = y;
          if (x > boxR) boxR = x;
          if (y > boxB) boxB = y;
        }
        const na = a * w;
        accR[i] += r * na;
        accG[i] += g * na;
        accB[i] += b * na;
        accA[i] += na;
        accW[i] += w;
      };
      add(x0, y0, w00);
      add(x0 + 1, y0, w10);
      add(x0, y0 + 1, w01);
      add(x0 + 1, y0 + 1, w11);
    }

    function renderCurve() {
      if (!ctx || !srcPx || !dstImg || !accR || dstImg.width !== bufW || dstImg.height !== bufH) {
        renderFlat();
        return;
      }
      if (frameId === 65535) {
        stamp.fill(0);
        frameId = 1;
      } else frameId += 1;
      touchN = 0;
      boxL = bufW;
      boxT = bufH;
      boxR = 0;
      boxB = 0;
      findOralLipT();
      if (veinRenderHot() || !veinSwellBaked) {
        paintVeinSwell(win.performance.now(), false);
        veinSwellBaked = true;
      }
      const skin = swellImg && swellImg.data.length === srcPx.length ? swellImg.data : srcPx;
      const mid = padX + cw * 0.5;
      let x = 0;
      let y = padY;
      for (let s = 0; s < ch; s += 1) {
        const left = rowL[s];
        const right = rowR[s];
        if (left > right) {
          if (s > 0) {
            const ap = dir((s - 0.5) / ch);
            const along = s / Math.max(1, ch - 1);
            const stepLenNow = stepLen(along);
            x += Math.sin(ap) * stepLenNow;
            y += Math.cos(ap) * stepLenNow;
          }
          continue;
        }
        const t = (s + 0.5) / ch;
        const ang = dir(t > 1 ? 1 : t);
        const nx = Math.cos(ang);
        const ny = -Math.sin(ang);
        const along = s / Math.max(1, ch - 1);
        const stepNow = stepLen(along);
        if (s > 0) {
          const ap = dir((s - 0.5) / ch);
          x += Math.sin(ap) * stepNow;
          y += Math.cos(ap) * stepNow;
        }
        const row = s * cw;
        // perf15: bulge depends only on the row (s); computed once per row with
        // the exact same expression, so every deposit is bit-identical.
        const bulgeBase =
          1 +
          throbBump(along) * 0.18 * (0.62 + 0.38 * Math.sin(along * Math.PI)) +
          jiggle * Math.sin(jigglePhase * 1.15) * 0.07 * Math.sin(along * Math.PI);
        const bulge = bulgeBase * oralBulgeScale(t);
        const halfCw = cw * 0.5;
        if (oralEngaged && oralLipT > 0 && s > Math.round(oralLipT * ch) + ORAL_TUBE_DEPTH + 10) {
          continue;
        }
        for (let u = left; u <= right; u += 1) {
          const si = (row + u) * 4;
          const al = skin[si + 3];
          if (al < 8) continue;
          const ox = (u - halfCw + 0.5) * bulge;
          const depX = mid + x + nx * ox;
          const depY = y + ny * ox;
          if (oralEngaged && oralChinMaxY > 0 && s >= oralLipRow - 10 && depY > oralChinMaxY) {
            continue;
          }
          deposit(depX, depY, skin[si], skin[si + 1], skin[si + 2], al);
        }
      }
      const dst = dstImg.data;
      let minX = boxL;
      let minY = boxT;
      let maxX = boxR;
      let maxY = boxB;
      if (touchN === 0) {
        renderFlat();
        return;
      }
      minX = Math.max(0, minX);
      minY = Math.max(0, minY);
      maxX = Math.min(bufW - 1, maxX);
      maxY = Math.min(bufH - 1, maxY);
      for (let y = minY; y <= maxY; y += 1) {
        dst.fill(0, (y * bufW + minX) * 4, (y * bufW + maxX + 1) * 4);
      }
      for (let n = 0; n < touchN; n += 1) {
        const i = touched[n];
        const di = i * 4;
        const aw = accA[i];
        const inv = 1 / aw;
        dst[di] = accR[i] * inv;
        dst[di + 1] = accG[i] * inv;
        dst[di + 2] = accB[i] * inv;
        dst[di + 3] = Math.min(255, aw / Math.max(0.001, accW[i]));
      }
      ctx.clearRect(0, 0, bufW, bufH);
      ctx.putImageData(dstImg, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
      dirty = false;
    }

    function paintGlisten(t) {
      if (!ctx || !cw || !ch || !rowL) return;
      const time = (t || win.performance.now()) * 0.001;
      const spots = [0.2, 0.4, 0.62, 0.82];
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (let g = 0; g < spots.length; g += 1) {
        const u = clamp(spots[g] + Math.sin(time * 0.4 + g * 1.3) * 0.03, 0.06, 0.94);
        let x = padX + cw * 0.5;
        let y = padY;
        let ang = 0;
        const n = Math.max(1, Math.round(ch * u));
        for (let s = 1; s <= n; s += 1) {
          const uu = (s - 0.5) / ch;
          ang = dir(uu);
          const len = stepLen(uu);
          x += Math.sin(ang) * len;
          y += Math.cos(ang) * len;
        }
        const row = clamp(Math.round(u * (ch - 1)), 0, ch - 1);
        const half = Math.max(5, (rowR[row] - rowL[row]) * 0.5);
        const inset = half * 0.28;
        const pulse = 0.62 + 0.38 * Math.sin(time * 0.85 + g * 1.6);
        ctx.save();
        ctx.translate(x + Math.cos(ang) * inset, y - Math.sin(ang) * inset);
        ctx.rotate(Math.atan2(Math.cos(ang), Math.sin(ang)));
        ctx.scale(2.1, 0.38);
        const rad = half * 0.62;
        const shine = ctx.createRadialGradient(0, 0, rad * 0.08, 0, 0, rad);
        shine.addColorStop(0, "rgba(255,255,252," + (0.72 * pulse * (1 + warmth * 0.9)).toFixed(3) + ")");
        shine.addColorStop(0.4, "rgba(255,240,226," + (0.28 * pulse * (1 + warmth * 0.9)).toFixed(3) + ")");
        shine.addColorStop(1, "rgba(255,240,226,0)");
        ctx.fillStyle = shine;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    function pulseEnv(elapsed) {
      if (elapsed < 0) return 0;
      const dur = 410;
      const u = elapsed / dur;
      if (u >= 1) return 0;
      const rise = 90 / dur;
      if (u < rise) return Math.sin((u / rise) * Math.PI * 0.5);
      return Math.cos(((u - rise) / (1 - rise)) * Math.PI * 0.5);
    }

    function updateThrob(nowMs) {
      const now = nowMs || win.performance.now();
      if (ptr.active) {
        throbStart = -1;
        throbEnv = 0;
        throbEnvTip = 0;
        throbPhase = 0;
        throbNow = 0;
        nodStart = -1;
        nodNow = 0;
        nodLatched = false;
        return;
      }
      if (!nextThrobAt) nextThrobAt = now + 2400 + Math.random() * 2000;
      if (throbStart < 0 && now >= nextThrobAt) {
        throbStart = now;
        throbAmp = throbNextAmp;
        nodLatched = false;
        if (dangleAudio && throbAmp > 0.62) dangleAudio.playThrob(win);
        if (throbAmp > 0.75 && Math.random() < 0.34) {
          throbNextAmp = 0.55;
          nextThrobAt = now + 480;
        } else {
          throbNextAmp = 1;
          const cool = 1 - warmth * 0.62;
          nextThrobAt = now + (4000 + Math.random() * 5000) * cool;
        }
      }
      if (throbStart < 0) {
        throbEnv = 0;
        throbEnvTip = 0;
        throbPhase = 0;
        throbNow = 0;
      } else {
        const elapsed = now - throbStart;
        if (elapsed >= 410) {
          throbStart = -1;
          throbEnv = 0;
          throbEnvTip = 0;
          throbPhase = 0;
          throbNow = 0;
        } else {
          throbPhase = elapsed / 410;
          throbEnv = pulseEnv(elapsed);
          throbEnvTip = pulseEnv(elapsed - 50);
          throbNow = Math.max(throbEnv, throbEnvTip) * throbAmp;
          if (!nodLatched && throbPhase > 0.84) {
            nodLatched = true;
            nodStart = now;
            nodAmp = 0.18 * throbAmp;
          }
        }
      }
      if (nodStart < 0) nodNow = 0;
      else {
        const u = (now - nodStart) / 160;
        if (u >= 1) {
          nodStart = -1;
          nodNow = 0;
        } else nodNow = Math.sin(u * Math.PI) * nodAmp;
      }
    }

    function render(t) {
      updateThrob(t || win.performance.now());
      if (!ctx || !cw) return;
      if (!restName && !oralEngaged && throbNow < 0.01 && nodNow < 0.01 && jiggle < 0.02 && !dragging && Math.abs(angle) < 0.012 && Math.abs(vel) < 0.04 && Math.abs(tip) < 0.02 && Math.abs(ripple) < 0.015 && slack < 0.012 && stretch < 0.01) renderFlat();
      else renderCurve();
      paintGlisten(t);
    }

    function alive() {
      return (
        oralEngaged ||
        dragging ||
        ptr.active ||
        Math.abs(angle) > 0.012 ||
        Math.abs(vel) > ENERGY_STOP ||
        Math.abs(tip) > 0.02 ||
        Math.abs(tipVel) > 0.02 ||
        Math.abs(ripple) > 0.015 ||
        Math.abs(rippleVel) > 0.02 ||
        slack > 0.012 ||
        Math.abs(slackVel) > 0.012 ||
        stretch > 0.01 ||
        Math.abs(stretchVel) > 0.01 ||
        throbNow > 0.01 ||
        nodNow > 0.01 ||
        jiggle > 0.02 ||
        (restName && (Math.abs(vel) > 0.04 || Math.abs(angle - restAngle) > 0.02 || Math.abs(slack - 0.16) > 0.02))
      );
    }

    function stopSim() {
      if (dragging || ptr.active) return;
      running = false;
      accum = 0;
      if (restName) {
        mount.classList.add("is-wobbling");
        render(win.performance.now());
        return;
      }
      angle = 0;
      vel = 0;
      tip = 0;
      tipVel = 0;
      hangLean = 0;
      ripple = 0;
      rippleVel = 0;
      jiggle = 0;
      slack = 0;
      slackVel = 0;
      stretch = 0;
      stretchVel = 0;
      swing.classList.remove("is-dangle-active");
      mount.classList.remove("is-wobbling");
      renderFlat();
      scheduleDanglePaint(VEIN_IDLE_MS);
    }

    let pokeName = "";
    let pokeClear = 0;
    let contactAim = null;
    let restName = "";
    let palmPatSpentForRest = false;
    let pushSoftOralSpent = false;
    const STILL_VEIN_MS = 3000;
    let veinStillMs = 0;
    let veinTraceSpent = false;
    let veinTraceU = -1;
    let veinPathSide = 1;
    let veinTracePath = null;
    let veinTracePathId = "";
    let veinPulseSm = 0;
    let veinBufPaths = null;
    let veinMask = null;
    let veinMaskCtx = null;
    let veinStamp = null;
    let veinStampCtx = null;
    let veinStampImg = null;
    let veinBufKey = "";
    let swellKey = "";
    let veinSwellMode = "epic";
    let veinSwellTapAt = 0;
    try {
      const savedSwell = win.localStorage.getItem("hq-vein-swell");
      if (savedSwell === "extreme") veinSwellMode = "extreme";
    } catch (_) {}
    mount.dataset.veinSwell = veinSwellMode;
    let swellDx = null;
    let swellDy = null;
    let swellW = null;
    let swellDist = null;
    let swellDist2 = null;
    let swellPath = null;
    let swellPath2 = null;
    let swellTx = null;
    let swellTx2 = null;
    let swellNx = null;
    let swellNy = null;
    let swellNxRaw = null;
    let swellNyRaw = null;
    let swellTier = null;
    let swellRad = 0;
    let swellImg = null;
    let swellHi = null;
    let swellHiCtx = null;
    let swellHiPx = null;
    let swellHiImg = null;
    let swellHiKey = "";
    let swellBlur = null;
    let inkPx = null;
    let restAngle = 0;
    let restAnchor = null;
    let warmth = 0;
    let warmthT = 0;
    let give = 0;
    let giveVel = 0;
    let giveName = "";
    let contactSide = 1;
    let oralTubeUx = -0.94;
    let oralTubeUy = -0.08;
    let oralTubeEntry = 0;
    let oralTubeBlend = 0;
    let oralLipT = -1;
    let oralLipMinBulge = 1;
    let oralLipTSm = -1;
    let oralBulgeK = 0;
    let oralBob = 0;
    let oralAngTable = null;
    let oralChinMaxY = 0;
    let oralLipRow = 0;

    function tipClient() {
      return shaftClient(0.96);
    }

    function shaftClient(t01) {
      if (!canvas || !cw || !ch || !bufW || !bufH) return null;
      let x = padX + cw * 0.5;
      let y = padY;
      const n = Math.max(1, Math.round(ch * clamp(t01, 0.05, 1)));
      for (let s = 1; s <= n; s += 1) {
        const u = (s - 0.5) / ch;
        const ang = dir(u);
        x += Math.sin(ang) * stepLen(u);
        y += Math.cos(ang) * stepLen(u);
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      return {
        x: rect.left + (x / bufW) * rect.width,
        y: rect.top + (y / bufH) * rect.height,
      };
    }

    function avatarZones() {
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return null;
      const r = av.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      const box = (name, x0, y0, x1, y1) => ({
        name: name,
        l: r.left + r.width * x0,
        t: r.top + r.height * y0,
        r: r.left + r.width * x1,
        b: r.top + r.height * y1,
        cx: r.left + r.width * ((x0 + x1) * 0.5),
        cy: r.top + r.height * ((y0 + y1) * 0.5),
      });
      return {
        el: av,
        zones: [
          box("head", 0.26, 0.0, 0.74, 0.24),
          box("face", 0.2, 0.18, 0.8, 0.5),
          box("tit", 0.08, 0.58, 0.48, 1.02),
          box("tit", 0.52, 0.58, 0.92, 1.02),
        ],
      };
    }

    function aimAtPoint(x, y) {
      const box = mount.getBoundingClientRect();
      const dx = x - (box.left + box.width * 0.5);
      const dy = Math.max(28, y - box.top);
      return clamp(Math.atan2(dx, dy), -MAX_ANGLE, MAX_ANGLE);
    }

    function aimAt(zone) {
      return aimAtPoint(zone.cx, zone.cy);
    }

    function findContact() {
      const pack = avatarZones();
      if (!pack) return null;
      const ts = [0.22, 0.36, 0.5, 0.64, 0.78, 0.92];
      const span = mount.getBoundingClientRect();
      const pad = Math.max(20, span.width * 0.46);
      const scores = pack.zones.map(() => 0);
      const touch = pack.zones.map(() => null);
      for (let i = 0; i < ts.length; i += 1) {
        const p = shaftClient(ts[i]);
        if (!p) continue;
        const weight = ts[i] < 0.9 ? 1.6 : 1;
        for (let z = 0; z < pack.zones.length; z += 1) {
          const zone = pack.zones[z];
          if (p.x >= zone.l - pad && p.x <= zone.r + pad && p.y >= zone.t - pad && p.y <= zone.b + pad) {
            scores[z] += weight;
            touch[z] = p;
          }
        }
      }
      let best = -1;
      for (let z = 0; z < scores.length; z += 1) if (scores[z] > (best < 0 ? 0 : scores[best])) best = z;
      if (best < 0) return null;
      return { pack: pack, zone: pack.zones[best], at: touch[best] };
    }

    function shaftDepth(pack) {
      const ts = [0.22, 0.38, 0.54, 0.7, 0.86, 0.96];
      let worst = 0;
      for (let i = 0; i < ts.length; i += 1) {
        const p = shaftClient(ts[i]);
        if (!p) continue;
        for (let z = 0; z < pack.zones.length; z += 1) {
          const zone = pack.zones[z];
          if (p.x < zone.l || p.x > zone.r || p.y < zone.t || p.y > zone.b) continue;
          const depth = Math.min(p.x - zone.l, zone.r - p.x, p.y - zone.t, zone.b - p.y);
          if (depth > worst) worst = depth;
        }
      }
      return worst;
    }

    function setCockLayer(on) {
      mount.style.zIndex = on ? "360" : "";
    }

    const ORAL_HEAD_SRC = "/assets/transferina-head-open-profile-mouth.png?v=2";
    const ORAL_HEAD_ASPECT = 1022 / 772;
    const ORAL_MOUTH_U = 0.088;
    const ORAL_MOUTH_V = 0.490;
    const ORAL_SCALE = 0.82;
    const ORAL_FLOAT_GAP = 0.58;
    const ORAL_FLOAT_Y = 0.46;
    const ORAL_NEAR_PAD = 100;
    const ORAL_GATE_PAD = 82;
    const ORAL_EXIT_PAD = 128;
    const ORAL_CONTACT_DIST = 96;
    const ORAL_MAX_DEPTH = 84;
    const ORAL_MAGNET_PAD = 112;
    const ORAL_MAGNET_INSET = 16;
    const ORAL_TUBE_DEPTH = 136;
    let oralHead = null;
    let oralPhase = "idle";
    let oralEngaged = false;
    let oralDepth = 0;
    let oralEx = 1;
    let oralEy = 0;
    let oralDepthZeroT = 0;
    let oralDepthSm = 0;
    let oralPortraitCalm = false;
    let oralMouthCache = null;

    function oralMouthAnchorFresh() {
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return null;
      const r = av.getBoundingClientRect();
      if (r.width < 8) return null;
      return {
        x: r.left - r.width * ORAL_FLOAT_GAP,
        y: r.top + r.height * ORAL_FLOAT_Y,
        av: r,
      };
    }

    function oralMouthAnchor() {
      if (oralEngaged && oralMouthCache) {
        const headPushX = clamp((oralDepthSm - 20) * 0.1, 0, 12);
        return {
          x: oralMouthCache.x + headPushX,
          y: oralMouthCache.y + oralBob,
          av: oralMouthCache.av,
        };
      }
      const fresh = oralMouthAnchorFresh();
      if (fresh && oralEngaged) oralMouthCache = fresh;
      return fresh;
    }

    function tipOralProximity() {
      const tip = tipClient();
      const mouth = oralMouthAnchor();
      if (!tip || !mouth) return null;
      return {
        tip: tip,
        mouth: mouth,
        dist: Math.hypot(tip.x - mouth.x, tip.y - mouth.y),
      };
    }

    function tipInFaceGate() {
      const prox = tipOralProximity();
      return !!(prox && prox.dist <= ORAL_GATE_PAD);
    }

    function oralCarryLean() {
      if (!oralEngaged) return null;
      const mouth = oralMouthAnchor();
      if (!mouth) return null;
      const box = mount.getBoundingClientRect();
      const px = box.left + box.width * 0.5;
      const py = box.top;
      const dx = mouth.x - px;
      const dy = mouth.y - py;
      const phi = Math.atan2(dx, dy);
      const throatAngle = 1.52 + oralBob * 0.005;
      const baseAim = clamp(phi * 0.70, -MAX_ANGLE, MAX_ANGLE);
      return { base: baseAim, tip: throatAngle };
    }

    const ORAL_TEX_W = 772;
    const ORAL_TEX_H = 1022;
    const ORAL_EYELID_PATCH_SRC = "/assets/transferina_eyelid_closed_patch.png?v=1";
    let oralHeadImg = null;
    let oralHeadImgLoaded = false;
    let oralEyelidPatchImg = null;
    let oralEyelidPatchLoaded = false;
    let oralLastGirth = -1;
    let oralLastDepth = -1;

    function loadOralHeadImg() {
      if (!oralHeadImg) {
        oralHeadImg = new win.Image();
        oralHeadImg.onload = () => {
          oralHeadImgLoaded = true;
          if (oralHead) drawOralHeadCanvas(oralLastGirth >= 0 ? oralLastGirth : 0, oralLastDepth >= 0 ? oralLastDepth : 0);
        };
        oralHeadImg.src = ORAL_HEAD_SRC;
        if (oralHeadImg.complete) oralHeadImgLoaded = true;
      }
      if (!oralEyelidPatchImg) {
        oralEyelidPatchImg = new win.Image();
        oralEyelidPatchImg.onload = () => {
          oralEyelidPatchLoaded = true;
          if (oralHead) drawOralHeadCanvas(oralLastGirth >= 0 ? oralLastGirth : 0, oralLastDepth >= 0 ? oralLastDepth : 0);
        };
        oralEyelidPatchImg.src = ORAL_EYELID_PATCH_SRC;
        if (oralEyelidPatchImg.complete) oralEyelidPatchLoaded = true;
      }
    }

    // Eyelid organic refinement (eyelid only). false -> exact previous smoothstep motion.
    const ORAL_EYELID_ORGANIC = true;
    // EYELID_SHIFT_BEGIN
    function oralEyelidShift(prog, travel, refine, seed) {
      if (prog >= 1) return 0;
      if (prog <= 0) return -travel;
      if (!refine) {
        const e = prog * prog * (3 - 2 * prog);
        return Math.round(-travel * (1 - e));
      }
      const k = Math.min(1.05, Math.max(0.95, seed || 1));
      const p = Math.pow(prog, k); // +-5% timing, endpoints fixed
      const e = p * p * (3 - 2 * p);
      let off = 0;
      if (p < 0.08) off -= 1.5 * Math.sin(Math.PI * p / 0.08); // anticipation tick up
      if (p > 0.9) off += 1.5 * Math.sin(Math.PI * (p - 0.9) / 0.1); // soft settle, returns to 0
      return Math.round(-travel * (1 - e) + off);
    }
    // EYELID_SHIFT_END
    // perf16: canvas gradients are pure values; reuse one per slot while its inputs (key) are unchanged.
    function oralCachedGrad(ctx, slot, key, make) {
      let c = drawOralHeadCanvas._grads;
      if (!c || c.ctx !== ctx) c = drawOralHeadCanvas._grads = { ctx, slots: Object.create(null) };
      const hit = c.slots[slot];
      if (hit && hit.key === key) return hit.g;
      const g = make();
      c.slots[slot] = { key, g };
      return g;
    }
    function drawOralHeadCanvas(girthK, depth) {
      if (!oralHead || !oralHeadImgLoaded) return;
      const ctx = oralHead.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, ORAL_TEX_W, ORAL_TEX_H);

      const d = depth || 0;
      if (girthK <= 0.01 && d <= 5) {
        ctx.drawImage(oralHeadImg, 0, 0);
        oralLastGirth = 0;
        oralLastDepth = 0;
        return;
      }
      oralLastGirth = girthK;
      oralLastDepth = d;

      // 1. Rigid skull, hair & eyes (y: 0 .. 430) is 100% untouched
      const ySplitUpper = 430;
      ctx.drawImage(oralHeadImg, 0, 0, ORAL_TEX_W, ySplitUpper, 0, 0, ORAL_TEX_W, ySplitUpper);

      // 2. Lips & natural jaw opening (y: 430 .. 740)
      const ySplitLower = 740;
      const N = 48;
      const sliceH = (ySplitLower - ySplitUpper) / N;

      function jawDy(y) {
        if (y < 430) return 0;
        if (y <= 490) {
          // Upper lip lifts over girth
          return -4.5 * Math.sin((y - 430) / 60 * Math.PI) * girthK;
        }
        if (y <= 620) {
          // Lower lip & jaw open downward to accommodate thick girth
          const u = (y - 490) / 130;
          return 28.0 * Math.sin(u * Math.PI * 0.75) * girthK;
        }
        if (y <= 720) {
          // Smooth taper back to stationary lower neck
          const u = (720 - y) / 100;
          return 28.0 * Math.sin(Math.PI * 0.75) * (u * u) * girthK;
        }
        return 0;
      }

      function upperDx(y) {
        if (y >= 430 && y <= 490) {
          // Upper lip retracts backwards (+3.8px) over girth
          return 3.8 * Math.sin((y - 430) / 60 * Math.PI) * girthK;
        }
        return 0;
      }

      // Draw all facial slices seamlessly across full width - NO vertical cutting on the face!
      for (let i = 0; i < N; i += 1) {
        const sy0 = Math.round(ySplitUpper + i * sliceH);
        const sy1 = Math.round(ySplitUpper + (i + 1) * sliceH);
        if (sy1 <= sy0) continue;
        const dy0 = Math.round(sy0 + jawDy(sy0));
        const dy1 = Math.round(sy1 + jawDy(sy1));
        const targetH = Math.max(1, dy1 - dy0);
        const dx0 = Math.round(upperDx(sy0));
        ctx.drawImage(oralHeadImg, 0, sy0, ORAL_TEX_W, sy1 - sy0, dx0, dy0, ORAL_TEX_W, targetH);
      }

      // 3. Continuous shaft throat dilation (drawn BEFORE lower neck & shoulders so original torso/dress sits cleanly on top!)
      let throatPts = null;
      let throatChokerPts = null;
      if (d > 42) {
        const throatDepth = d - 42;
        // Smooth gradual ease-in over 26px of penetration (soft natural entry)
        const entry_u = clamp(throatDepth / 26, 0, 1);
        const entryT = entry_u * entry_u * (3 - 2 * entry_u);
        const maxAmp = 60.0 * entryT;

        const yStart = 630;
        // Corona rim travels all the way down past the neck into upper chest
        const yCorona = 636 + (throatDepth / 74) * 174;
        // As the mushroom head sinks into the torso cavity (Y=810 to 860),
        // the head flare and dome taper smoothly dissolve, leaving the shaft intact
        const rawFade = clamp((860 - yCorona) / 50, 0, 1);
        const headFade = rawFade * rawFade * (3 - 2 * rawFade);

        // Smooth entry starting below jawline (y0 = 622)
        const y0 = 622;
        const domeLen = 44;
        const yMaxBound = 865;
        const y1 = Math.min(yMaxBound, yCorona + domeLen);

        if (y1 > y0 + 4) {
          const steps = Math.round(Math.max(30, (y1 - y0) / 2.0));
          const pts = [];
          const chokerPts = [];

          function neckBaseX(curY) {
            if (curY <= 760) return 194 + ((curY - 630) / 130) * 33;
            if (curY <= 850) return 227 - ((curY - 760) / 90) * 44;
            return 183 + ((curY - 850) / 15) * 17;
          }

          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps;
            const curY = y0 + t * (y1 - y0);

            // Smooth cubic ease-in curving down naturally under the jawline (no angular horizontal ledge)
            const top_u = clamp((curY - y0) / 22, 0, 1);
            const topT = top_u * top_u * (3 - 2 * top_u);

            // True un-squished anatomical mushroom profile matching full 70-80px glans asset length:
            // 1. Continuous trailing shaft column (shape = 1.0)
            // 2. Coronal sulcus transition over 32px (subtle dip to 0.93 then flaring to 1.48 at rim)
            // 3. Proud elongated mushroom dome curving smoothly into rounded apex
            // When pushed way deep, headFade smoothly transitions the head profile into uniform 1.0 shaft
            let shape = 0;
            if (curY < yCorona - 32) {
              shape = 1.0;
            } else if (curY < yCorona) {
              const u = clamp((curY - (yCorona - 32)) / 32, 0, 1);
              const flare = 1.0 - 0.07 * Math.sin(u * Math.PI) + 0.48 * (u * u * u);
              shape = 1.0 + (flare - 1.0) * headFade;
            } else if (curY <= yCorona + domeLen) {
              const u = clamp((curY - yCorona) / domeLen, 0, 1);
              const dome = 1.48 * Math.sqrt(Math.max(0, 1 - u * u));
              shape = 1.0 * (1 - headFade) + dome * headFade;
            } else {
              shape = 1.0 * (1 - headFade);
            }

            // Smooth rounded bottom transition at base of neck / chest
            const cu = clamp((yMaxBound - curY) / 24, 0, 1);
            const collarT = cu * cu * (3 - 2 * cu);

            // Vascular pulsation (140 BPM pulse) + involuntary swallowing micro-tremor when deep
            let pulseAmp = 1.0;
            let spasmDisp = 0;
            if (d > 42) {
              const now = win.performance.now();
              const pulsePhase = (now * 0.0147); // ~140 BPM
              pulseAmp = 1.0 + 0.055 * Math.sin(pulsePhase) * Math.min(1.0, (d - 42) / 60);
              if (d > 65) {
                const struggleT = Math.min(1.0, (d - 65) / 55);
                spasmDisp = Math.sin(now * 0.175 + curY * 0.12) * (1.8 * struggleT);
              }
            }

            const disp = maxAmp * pulseAmp * shape * topT * collarT + spasmDisp * shape * collarT;
            const px = neckBaseX(curY) - disp;

            pts.push({ x: px, y: curY });
            if (curY >= 718 && curY <= 742) {
              chokerPts.push({ x: px, y: curY });
            }
          }

          throatPts = pts;
          throatChokerPts = chokerPts;

          ctx.save();

          // 3a. Fill full neck distension polygon with skin gradient
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i += 1) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.lineTo(280, y1);
          ctx.lineTo(280, y0);
          ctx.closePath();

          const grad = oralCachedGrad(ctx, "neck", (194 - maxAmp * 1.50) + "|" + yStart, () => {
            const g = ctx.createLinearGradient(194 - maxAmp * 1.50, yStart, 280, yStart);
            g.addColorStop(0, "rgba(228, 150, 130, 1)");
            g.addColorStop(0.35, "rgba(224, 144, 124, 1)");
            g.addColorStop(1, "rgba(216, 136, 116, 1)");
            return g;
          });
          ctx.fillStyle = grad;
          ctx.fill();

          // 3b. Stretch choker band over the bulge across to X=280
          if (chokerPts.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(chokerPts[0].x, chokerPts[0].y);
            for (let i = 1; i < chokerPts.length; i += 1) {
              ctx.lineTo(chokerPts[i].x, chokerPts[i].y);
            }
            ctx.lineTo(280, chokerPts[chokerPts.length - 1].y);
            ctx.lineTo(280, chokerPts[0].y);
            ctx.closePath();
            ctx.fillStyle = "rgba(58, 21, 38, 1)";
            ctx.fill();
          }

          ctx.restore();
        }
      }

      // 4. Stationary lower neck & shoulders drawn ON TOP of the right half!
      // This preserves 100% of the original torso, chest, dress, shading and textures without altering any torso colors or shapes!
      ctx.drawImage(oralHeadImg, 0, ySplitLower, ORAL_TEX_W, ORAL_TEX_H - ySplitLower, 0, ySplitLower, ORAL_TEX_W, ORAL_TEX_H - ySplitLower);

      // 5. Stroke skin contours and choker front border (crisp on top of the character silhouette)
      if (throatPts && throatPts.length >= 2) {
        ctx.save();

        if (throatChokerPts && throatChokerPts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(throatChokerPts[0].x, throatChokerPts[0].y);
          for (let i = 1; i < throatChokerPts.length; i += 1) {
            ctx.lineTo(throatChokerPts[i].x, throatChokerPts[i].y);
          }
          ctx.strokeStyle = "rgba(35, 12, 22, 0.95)";
          ctx.lineWidth = 3.6;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        ctx.beginPath();
        for (let i = 0; i < throatPts.length - 1; i += 1) {
          const p0 = throatPts[i];
          const p1 = throatPts[i + 1];
          if (p0.y >= 718 && p1.y <= 742 && throatChokerPts && throatChokerPts.length >= 2) continue;
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
        }
        ctx.strokeStyle = "rgba(196, 112, 96, 0.95)";
        ctx.lineWidth = 3.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();

        ctx.restore();
      }

      // 6. Deep penetration cheek & nose flush (escalates to extreme red the deeper it is pushed down)
      if (d > 14) {
        const flushNorm = clamp((d - 14) / (ORAL_TUBE_DEPTH - 14), 0, 1);
        const flushK = Math.pow(flushNorm, 0.82);

        ctx.save();

        // 6a. Ambient facial heat glow
        ctx.save();
        ctx.translate(200, 362);
        ctx.scale(1, 62 / 88);
        const ambGrad = oralCachedGrad(ctx, "amb", (0.32 * flushK).toFixed(3) + "|" + (0.14 * flushK).toFixed(3), () => {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 88);
          g.addColorStop(0, `rgba(225, 12, 28, ${(0.32 * flushK).toFixed(3)})`);
          g.addColorStop(0.65, `rgba(220, 15, 30, ${(0.14 * flushK).toFixed(3)})`);
          g.addColorStop(1, "rgba(220, 15, 30, 0)");
          return g;
        });
        ctx.fillStyle = ambGrad;
        ctx.beginPath();
        ctx.arc(0, 0, 88, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 6b. Deep core cheek flush (extreme saturated crimson)
        ctx.save();
        ctx.translate(205, 356);
        ctx.scale(1, 38 / 58);
        const cheekGrad = oralCachedGrad(ctx, "cheek", (0.82 * flushK).toFixed(3) + "|" + (0.52 * flushK).toFixed(3), () => {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 58);
          g.addColorStop(0, `rgba(242, 6, 18, ${(0.82 * flushK).toFixed(3)})`);
          g.addColorStop(0.55, `rgba(235, 12, 26, ${(0.52 * flushK).toFixed(3)})`);
          g.addColorStop(1, "rgba(225, 16, 32, 0)");
          return g;
        });
        ctx.fillStyle = cheekGrad;
        ctx.beginPath();
        ctx.arc(0, 0, 58, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 6c. Nose bridge heat flush
        ctx.save();
        ctx.translate(166, 346);
        ctx.scale(1, 19 / 28);
        const noseGrad = oralCachedGrad(ctx, "nose", (0.62 * flushK).toFixed(3) + "|" + (0.32 * flushK).toFixed(3), () => {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 28);
          g.addColorStop(0, `rgba(240, 10, 22, ${(0.62 * flushK).toFixed(3)})`);
          g.addColorStop(0.6, `rgba(232, 14, 28, ${(0.32 * flushK).toFixed(3)})`);
          g.addColorStop(1, "rgba(225, 18, 32, 0)");
          return g;
        });
        ctx.fillStyle = noseGrad;
        ctx.beginPath();
        ctx.arc(0, 0, 28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.restore();
      }

      // 6b. Eyelid descent (progresses with oral entry, d = 8 -> 75, then LOCKS)
      if (oralEyelidPatchLoaded && d > 8) {
        // Model: half-lidded "droop". The closed-lid patch slides down from above but is
        // masked to its own final footprint, so the LASH LINE is always the leading edge
        // (no flat skin band revealed by a hard wipe). Smoothstep timing: gentle start,
        // half-lidded around mid depth, soft settle. Monotonic; at prog = 1 the exact
        // original closed-state draw path is used -> pixel-identical closed frame.
        const CLOSE_COMPLETE_DEPTH = 75;
        const LID_TRAVEL = 46; // px the lash line travels (open upper lash -> closed lash)
        const prog = clamp((d - 8) / (CLOSE_COMPLETE_DEPTH - 8), 0, 1);
        const easeProg = prog * prog * (3 - 2 * prog);
        const targetOx = 96;
        const targetOy = 244;
        if (d <= 8.5 || drawOralHeadCanvas._lidSeed == null) {
          // new closing cycle -> fresh bounded timing variation (+-5%)
          drawOralHeadCanvas._lidSeed = 0.95 + 0.1 * Math.random();
        }
        const lidRefine = ORAL_EYELID_ORGANIC && !calm(win);
        const shift = oralEyelidShift(prog, LID_TRAVEL, lidRefine, drawOralHeadCanvas._lidSeed);
        // Retouch region (covers the open lashes) stays above the moving lash line
        const retouchEdge = prog >= 1 ? 1e4 : targetOy + shift + 50;

        if (prog > 0.05) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, 772, retouchEdge);
          ctx.clip();
          ctx.globalAlpha = Math.min(1.0, (prog - 0.05) / 0.25);
          const lashGrad = oralCachedGrad(ctx, "lash", "const", () => {
            const g = ctx.createRadialGradient(148, 268, 8, 148, 268, 46);
            g.addColorStop(0, "rgba(244, 172, 152, 1.0)");
            g.addColorStop(0.72, "rgba(235, 155, 136, 0.98)");
            g.addColorStop(1, "rgba(225, 142, 124, 0)");
            return g;
          });
          ctx.fillStyle = lashGrad;
          ctx.beginPath();
          ctx.moveTo(108, 274);
          ctx.lineTo(116, 246);
          ctx.lineTo(142, 238);
          ctx.lineTo(192, 246);
          ctx.lineTo(188, 298);
          ctx.lineTo(130, 304);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        if (prog >= 1) {
          ctx.drawImage(oralEyelidPatchImg, targetOx, targetOy, 155, 100);
        } else {
          if (!drawOralHeadCanvas._lidOff) {
            const lc = ctx.canvas.ownerDocument.createElement("canvas");
            lc.width = 155;
            lc.height = 100;
            drawOralHeadCanvas._lidOff = lc;
          }
          const lc = drawOralHeadCanvas._lidOff;
          const lctx = lc.getContext("2d");
          lctx.globalCompositeOperation = "source-over";
          lctx.clearRect(0, 0, 155, 100);
          lctx.drawImage(oralEyelidPatchImg, 0, shift, 155, 100);
          lctx.globalCompositeOperation = "destination-in";
          lctx.drawImage(oralEyelidPatchImg, 0, 0, 155, 100);
          lctx.globalCompositeOperation = "source-over";
          ctx.save();
          ctx.globalAlpha = Math.min(1.0, prog / 0.15);
          ctx.drawImage(lc, targetOx, targetOy, 155, 100);
          ctx.restore();
        }
      }

      // 7. Reflex tears at outer eye corner streaming down flushed cheek (locked directly to face canvas)
      if (d > 45) {
        const tearProg = clamp((d - 45) / (ORAL_TUBE_DEPTH - 45), 0, 1);
        const tearAlpha = Math.min(1.0, tearProg * 1.25);
        ctx.save();

        const eyeCornerX = 227;
        const eyeCornerY = 316;

        // Glassy wet pooling in corner of the eye
        const poolGrad = oralCachedGrad(ctx, "pool", (0.95 * tearAlpha).toFixed(3) + "|" + (0.85 * tearAlpha).toFixed(3), () => {
          const g = ctx.createRadialGradient(eyeCornerX, eyeCornerY, 0, eyeCornerX, eyeCornerY, 6);
          g.addColorStop(0, `rgba(255, 255, 255, ${(0.95 * tearAlpha).toFixed(3)})`);
          g.addColorStop(0.4, `rgba(215, 240, 255, ${(0.85 * tearAlpha).toFixed(3)})`);
          g.addColorStop(1, "rgba(180, 220, 255, 0)");
          return g;
        });
        ctx.fillStyle = poolGrad;
        ctx.beginPath();
        ctx.arc(eyeCornerX, eyeCornerY, 5.5, 0, Math.PI * 2);
        ctx.fill();

        // Bright glint highlight
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.98 * tearAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(eyeCornerX - 1.2, eyeCornerY - 1.2, 1.8, 0, Math.PI * 2);
        ctx.fill();

        // Tear trail dripping down across flushed cheekbone as penetration deepens
        if (d > 60) {
          const streamProg = clamp((d - 60) / 65, 0, 1);
          const maxTrailLen = 65 * streamProg;
          const trailPts = [
            { x: eyeCornerX, y: eyeCornerY + 2 },
            { x: eyeCornerX - 3.5, y: eyeCornerY + 18 },
            { x: eyeCornerX - 6.5, y: eyeCornerY + 38 },
            { x: eyeCornerX - 7.5, y: eyeCornerY + maxTrailLen }
          ];

          // Soft translucent watery sheen
          ctx.beginPath();
          ctx.moveTo(trailPts[0].x, trailPts[0].y);
          for (let p = 1; p < trailPts.length; p += 1) {
            ctx.lineTo(trailPts[p].x, trailPts[p].y);
          }
          ctx.strokeStyle = `rgba(210, 242, 255, ${(0.65 * tearAlpha).toFixed(3)})`;
          ctx.lineWidth = 3.2;
          ctx.lineCap = "round";
          ctx.stroke();

          // Intense specular light reflection along center of tear trail
          ctx.beginPath();
          ctx.moveTo(trailPts[0].x, trailPts[0].y);
          for (let p = 1; p < trailPts.length; p += 1) {
            ctx.lineTo(trailPts[p].x, trailPts[p].y);
          }
          ctx.strokeStyle = `rgba(255, 255, 255, ${(0.88 * tearAlpha).toFixed(3)})`;
          ctx.lineWidth = 1.3;
          ctx.stroke();

          // Droplet bulb gathering at tear tip
          if (streamProg > 0.4) {
            const dropTip = trailPts[trailPts.length - 1];
            const dropAlpha = (streamProg - 0.4) / 0.6;
            ctx.fillStyle = `rgba(220, 245, 255, ${(0.85 * dropAlpha).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(dropTip.x, dropTip.y + 1.5, 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * dropAlpha).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(dropTip.x - 0.8, dropTip.y + 0.8, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 8. Drool / Saliva stretch at corner of mouth & lower lip
      if (d > 48) {
        const droolT = clamp((d - 48) / (ORAL_TUBE_DEPTH - 48), 0, 1);
        const droolAlpha = Math.min(1.0, droolT * 1.3);
        const now = win.performance.now();
        const droolWobble = Math.sin(now * 0.012) * 1.5;

        ctx.save();
        const lipX = 64;
        const lipY = 512 + (d > 55 ? jawDy(512) : 0);
        const droolLen = 16 + droolT * 38;

        // Drool string
        ctx.beginPath();
        ctx.moveTo(lipX, lipY);
        ctx.quadraticCurveTo(lipX - 4 + droolWobble, lipY + droolLen * 0.5, lipX - 2, lipY + droolLen);
        ctx.strokeStyle = `rgba(220, 245, 255, ${(0.68 * droolAlpha).toFixed(3)})`;
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(lipX, lipY);
        ctx.quadraticCurveTo(lipX - 4 + droolWobble, lipY + droolLen * 0.5, lipX - 2, lipY + droolLen);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.92 * droolAlpha).toFixed(3)})`;
        ctx.lineWidth = 1.0;
        ctx.stroke();

        // Droplet at bottom
        ctx.fillStyle = `rgba(235, 250, 255, ${(0.85 * droolAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(lipX - 2, lipY + droolLen + 2, 2.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * droolAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(lipX - 2.8, lipY + droolLen + 1.2, 1.0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }
    }

    function ensureOralHead() {
      if (calm(win)) return null;
      if (!oralHead) {
        oralHead = doc.createElement("canvas");
        oralHead.width = ORAL_TEX_W;
        oralHead.height = ORAL_TEX_H;
        oralHead.className = "hq-oral-head";
        oralHead.setAttribute("aria-hidden", "true");
        doc.body.appendChild(oralHead);
        loadOralHeadImg();
      }
      return oralHead;
    }

    function paintOralHead(mouth, depth) {
      const head = ensureOralHead();
      if (!head || !mouth) return;
      const live = oralMouthAnchorFresh();
      const av = (live && live.av) || mouth.av;
      const w = av.width * ORAL_SCALE;
      const h = w * ORAL_HEAD_ASPECT;
      head.style.width = w + "px";
      head.style.height = h + "px";
      const ox = w * ORAL_MOUTH_U;
      const oy = h * ORAL_MOUTH_V;
      const left = Math.round(mouth.x - ox);
      const top = Math.round(mouth.y - oy);
      head.style.left = left + "px";
      head.style.top = top + "px";

      // Animate lips, jaw opening and traveling throat skin bulge
      const girthK = clamp((depth - 8) / 34, 0, 0.82);
      if (Math.abs(girthK - oralLastGirth) > 0.005 || Math.abs(depth - oralLastDepth) > 0.4) {
        drawOralHeadCanvas(girthK, depth);
      }

      const girthTilt = 4.8 * girthK;
      const headBobRot = oralBob * 0.26;
      let shakeRot = 0;
      let shakeX = 0;
      let shakeY = 0;
      if (!calm(win) && depth > 16) {
        const struggleNorm = Math.max(0, (depth - 16) / (ORAL_TUBE_DEPTH - 16));
        const struggle = Math.min(1.4, Math.pow(struggleNorm, 1.35));
        const now = win.performance.now();
        const t1 = now * 0.044;
        const t2 = now * 0.081;
        const t3 = now * 0.126;
        const rotJitter = Math.sin(t1) * 0.62 + Math.sin(t2) * 0.28 + Math.sin(t3) * 0.10;
        shakeRot = rotJitter * 2.8 * struggle;

        const xJitter = Math.cos(t2 * 0.95) * 0.6 + Math.sin(t1 * 1.3) * 0.4;
        const yJitter = Math.sin(t1 * 1.15) * 0.65 + Math.cos(t2 * 1.1) * 0.35;
        shakeX = xJitter * (0.9 * struggle);
        shakeY = yJitter * (1.3 * struggle);
      }
      const rot = (headBobRot + shakeRot + girthTilt).toFixed(2);
      const sx = shakeX.toFixed(2);
      const sy = shakeY.toFixed(2);
      head.style.transform = `translate(${sx}px, ${sy}px) rotate(${rot}deg)`;
      head.classList.add("is-active");
    }

    function clearOral() {
      const wasActive = oralPhase === "active";
      const depthSnap = oralDepthSm;
      if (dangleAudio && wasActive && depthSnap > 3) {
        dangleAudio.playOralRelease(win, depthSnap);
      }
      oralPhase = "idle";
      oralEngaged = false;
      oralDepth = 0;
      oralDepthSm = 0;
      oralDepthZeroT = 0;
      oralPortraitCalm = false;
      oralMouthCache = null;
      oralTubeBlend = 0;
      oralLipT = -1;
      oralLipTSm = -1;
      oralLipMinBulge = 1;
      oralBulgeK = 0;
      oralBob = 0;
      oralAngTable = null;
      if (oralHead) {
        oralHead.classList.remove("is-active");
        oralHead.style.transform = "";
      }
      if (dangleAudio) dangleAudio.clearOralAudio({ release: false });
      oralLastGirth = -1;
      oralLastDepth = -1;
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (comp) comp.classList.remove("is-oral-session");
    }

    function ensureOralPortraitCalm() {
      if (oralPortraitCalm) return;
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (!comp) return;
      comp.classList.add("is-oral-session");
      comp.classList.remove("is-cock-on-tit", "is-cock-on-face", "is-flick-jiggle");
      comp.style.setProperty("--cock-give", "0");
      oralPortraitCalm = true;
    }

    function captureOralTube(mouth) {
      if (!mouth) return;
      const throatAngle = 1.52;
      oralTubeUx = Math.sin(throatAngle);
      oralTubeUy = Math.cos(throatAngle);
      oralTubeEntry = throatAngle;
    }

    function oralTubeAlong(tip, mouth) {
      return (tip.x - mouth.x) * oralTubeUx + (tip.y - mouth.y) * oralTubeUy;
    }

    function findOralLipT() {
      if (!oralEngaged || !canvas || !ch) {
        oralLipT = -1;
        oralLipTSm = -1;
        oralAngTable = null;
        return;
      }
      const mouth = oralMouthAnchor();
      if (!mouth) return;
      const box = mount.getBoundingClientRect();
      const px = box.left + box.width * 0.5;
      const py = box.top;
      const dx = mouth.x - px;
      const dy = mouth.y - py;
      const dist = Math.hypot(dx, dy);
      const phi = Math.atan2(dx, dy);
      const throatAngle = 1.52 + oralBob * 0.005;
      const baseAngle = clamp(phi * 0.70, -MAX_ANGLE, MAX_ANGLE);

      const h0 = dist * 0.38;
      const h1 = dist * 0.38;
      const p0x = 0;
      const p0y = 0;
      const p1x = h0 * Math.sin(baseAngle);
      const p1y = h0 * Math.cos(baseAngle);
      const p3x = dx;
      const p3y = dy;
      const p2x = dx - h1 * Math.sin(throatAngle);
      const p2y = dy - h1 * Math.cos(throatAngle);

      const M = 64;
      const lens = new Float32Array(M + 1);
      let totalL = 0;
      let prevX = p0x;
      let prevY = p0y;
      for (let i = 1; i <= M; i += 1) {
        const w = i / M;
        const c0 = (1 - w) * (1 - w) * (1 - w);
        const c1 = 3 * (1 - w) * (1 - w) * w;
        const c2 = 3 * (1 - w) * w * w;
        const c3 = w * w * w;
        const bx = c0 * p0x + c1 * p1x + c2 * p2x + c3 * p3x;
        const by = c0 * p0y + c1 * p1y + c2 * p2y + c3 * p3y;
        totalL += Math.hypot(bx - prevX, by - prevY);
        lens[i] = totalL;
        prevX = bx;
        prevY = by;
      }

      const s_lip = clamp(Math.round(totalL), 10, ch - 2);
      oralLipT = s_lip / ch;
      oralLipTSm = oralLipT;

      if (!oralAngTable || oralAngTable.length !== ch) {
        oralAngTable = new Float32Array(ch);
      }

      for (let s = 0; s < ch; s += 1) {
        if (s >= s_lip) {
          oralAngTable[s] = throatAngle;
        } else {
          const targetL = (s / s_lip) * totalL;
          let lo = 0;
          let hi = M;
          while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (lens[mid] <= targetL) lo = mid;
            else hi = mid;
          }
          const span = lens[lo + 1] - lens[lo];
          const f = span > 0.001 ? (targetL - lens[lo]) / span : 0;
          const w = (lo + f) / M;
          const d0 = 3 * (1 - w) * (1 - w);
          const d1 = 6 * (1 - w) * w;
          const d2 = 3 * w * w;
          const vx = d0 * (p1x - p0x) + d1 * (p2x - p1x) + d2 * (p3x - p2x);
          const vy = d0 * (p1y - p0y) + d1 * (p2y - p1y) + d2 * (p3y - p2y);
          oralAngTable[s] = Math.atan2(vx, vy);
        }
      }

      const tipPt = tipClient() || { x: mouth.x, y: mouth.y };
      const along = oralTubeAlong(tipPt, mouth);
      const targetDepth = clamp(Math.max(0, along), 0, ORAL_TUBE_DEPTH);
      oralDepthSm = targetDepth;
      oralDepth = targetDepth;
      oralBulgeK = targetDepth;
      oralLipRow = s_lip;

      const lipOpenPx = Math.max(8, mouth.av.width * 0.12);
      const rect = canvas.getBoundingClientRect();
      const shaftWidePx = Math.max(mountRectW, (rect.width * cw) / Math.max(1, bufW)) * 0.44;
      oralLipMinBulge = clamp(lipOpenPx / shaftWidePx, 0.38, 0.58);
      const headW = mouth.av.width * ORAL_SCALE;
      const jawShiftPx = (28 * (headW / ORAL_TEX_W)) * clamp((oralDepthSm - 6) / 28, 0, 1);
      oralChinMaxY = padY + dy + headW * 0.125 + jawShiftPx;
    }

    function oralBulgeScale(t) {
      if (oralLipT < 0 || !oralEngaged) return 1;
      const depthK = clamp(oralDepthSm / 20, 0.15, 1);
      const minB = 1 - (1 - oralLipMinBulge) * depthK;
      const lip = oralLipT;
      if (t < lip - 0.12) return 1;
      if (t < lip) {
        const u = (t - (lip - 0.12)) / 0.12;
        const ease = u * u * (3 - 2 * u);
        return 1 + (minB - 1) * ease;
      }
      return minB;
    }

    function oralInsertAssist(dtSec) {
      if (!oralEngaged || !canUseOral() || !ptr.active || !ptr.moving) return;
      const step = clamp(dtSec * 60, 0.18, 1.15);
      const targetBlend = oralPhase === "active" ? 0.75 : 0.35;
      oralTubeBlend += (targetBlend - oralTubeBlend) * Math.min(1, 0.08 * step);
    }

    function updateOralHead() {
      if (calm(win)) return;
      const prox = tipOralProximity();
      if (!prox || !canUseOral()) {
        if (!oralEngaged) clearOral();
        return;
      }
      const mouth = prox.mouth;
      if (!oralEngaged) {
        if (ptr.active && ptr.moving && prox.dist <= ORAL_NEAR_PAD && canUseOral()) {
          oralEngaged = true;
          oralPhase = "near";
          oralMouthCache = oralMouthAnchorFresh();
          captureOralTube(oralMouthCache);
          ensureOralPortraitCalm();
          if (dangleAudio) dangleAudio.playOralPhase(win, "near", 0);
        } else {
          clearOral();
          return;
        }
      }
      const along = oralTubeAlong(prox.tip, mouth);
      const perpDist = Math.abs((prox.tip.x - mouth.x) * oralTubeUy - (prox.tip.y - mouth.y) * oralTubeUx);
      const isPulledOut = (along < -32) || (along <= 4 && (prox.dist > ORAL_EXIT_PAD || perpDist > 85));
      if (oralEngaged && (!ptr.active || isPulledOut)) {
        if (oralPhase === "active" && oralDepthSm > 2) {
          const now = win.performance.now();
          if (!oralDepthZeroT) oralDepthZeroT = now;
          if (now - oralDepthZeroT < 280) {
            paintOralHead(mouth, oralDepthSm);
            setCockLayer(true);
            return;
          }
        }
        clearOral();
        return;
      }
      oralDepthZeroT = 0;
      ensureOralPortraitCalm();
      if (along > 0 && ptr.active) {
        oralPhase = "active";
      } else if (prox.dist <= ORAL_GATE_PAD && ptr.active) {
        oralPhase = "active";
      } else {
        oralPhase = "near";
      }
      if (dangleAudio && oralEngaged) dangleAudio.playOralPhase(win, oralPhase, oralDepthSm);
      if (oralPhase === "active" || oralPhase === "near") {
        const targetDepth = clamp(Math.max(0, along), 0, ORAL_TUBE_DEPTH);
        oralDepth = targetDepth;
        oralDepthSm = targetDepth;
        oralBulgeK = targetDepth;
        setCockLayer(true);
        if (Math.abs(oralBob) > 0.1 || oralDepth > 16) dirty = true;
        paintOralHead(mouth, oralDepth);
      }
    }

    function keepOut() {
      if (oralEngaged) {
        setCockLayer(oralDepthSm > 0.5);
        return;
      }
      const pack = avatarZones();
      if (!pack) return;
      const ts = [0.22, 0.4, 0.58, 0.76, 0.94];
      let pushL = 0;
      let pushR = 0;
      let pushU = 0;
      let pushD = 0;
      const limit = Math.hypot(ptr.smVx, ptr.smVy) > 280 ? 4 : 14;
      for (let i = 0; i < ts.length; i += 1) {
        const p = shaftClient(ts[i]);
        if (!p) continue;
        for (let z = 0; z < pack.zones.length; z += 1) {
          const zone = pack.zones[z];
          if (p.x < zone.l || p.x > zone.r || p.y < zone.t || p.y > zone.b) continue;
          const dl = p.x - zone.l;
          const dr = zone.r - p.x;
          const dt = p.y - zone.t;
          const db = zone.b - p.y;
          const m = Math.min(dl, dr, dt, db);
          if (m <= limit) continue;
          const extra = m - limit;
          if (m === dl) pushL = Math.max(pushL, extra);
          else if (m === dr) pushR = Math.max(pushR, extra);
          else if (m === dt) pushU = Math.max(pushU, extra);
          else pushD = Math.max(pushD, extra);
        }
      }
      const corrX = pushR - pushL;
      const corrY = pushD - pushU;
      if (corrX || corrY) {
        const box = mount.getBoundingClientRect();
        place(box.left + corrX, box.top + corrY);
      }
      setCockLayer(shaftDepth(pack) > 0 || !!restName || (oralPhase === "active" && oralDepth > 0.5));
    }
    function beginRest(hit) {
      restName = hit.zone.name;
      restAngle = aimAt(hit.zone);
      vel *= 0.15;
      hangLean = restAngle;
      setCockLayer(true);
      const av = hit.pack.el.getBoundingClientRect();
      const here = mount.getBoundingClientRect();
      restAnchor = { dx: here.left - av.left, dy: here.top - av.top };
      hit.pack.el.classList.add("is-cock-bump");
      if (pokeClear) win.clearTimeout(pokeClear);
      pokeClear = win.setTimeout(() => {
        hit.pack.el.classList.remove("is-cock-bump");
        pokeClear = 0;
      }, 280);
      if (palmHand && (hit.zone.name === "tit" || hit.zone.name === "face") && !palmPatSpentForRest) {
        const near = cockNearAvatar();
        if (near && palmHand.play("grip_pole", { near })) palmPatSpentForRest = true;
        else if (near && hit.zone.name === "tit" && palmHand.play("pat", { near })) palmPatSpentForRest = true;
      }
    }

    function followRest() {
      if (!restName || ptr.moving || !restAnchor) return;
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return;
      const r = av.getBoundingClientRect();
      const left = r.left + restAnchor.dx;
      const top = r.top + restAnchor.dy;
      const box = mount.getBoundingClientRect();
      if (Math.abs(box.left - left) < 0.4 && Math.abs(box.top - top) < 0.4) return;
      place(left, top);
    }

    function updateBodyFeel(now, touching, depth, name) {
      const dt = warmthT ? Math.min(0.05, (now - warmthT) / 1000) : 0.016;
      warmthT = now;
      warmth = clamp(warmth + (touching ? 0.09 : -0.045) * dt, 0, 1);
      const target = touching ? clamp(depth / 36, 0.18, 1) : 0;
      giveVel += (target - give) * 18 * dt - giveVel * (touching ? 6.2 : 3.1) * dt;
      give += giveVel * dt;
      give = clamp(give, -0.4, 1);
      if (touching && name) giveName = name;
      if (!touching && give < 0.04 && Math.abs(giveVel) < 0.2) giveName = "";
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (!comp) return;
      const giveStr = give.toFixed(3);
      const turnStr = (contactSide * 2.6).toFixed(2) + "deg";
      if (comp.style.getPropertyValue("--cock-give") !== giveStr) comp.style.setProperty("--cock-give", giveStr);
      if (comp.style.getPropertyValue("--cock-turn") !== turnStr) comp.style.setProperty("--cock-turn", turnStr);
      const onTit = giveName === "tit";
      const onFace = giveName === "face" || giveName === "head";
      if (comp.classList.contains("is-cock-on-tit") !== onTit) comp.classList.toggle("is-cock-on-tit", onTit);
      if (comp.classList.contains("is-cock-on-face") !== onFace) comp.classList.toggle("is-cock-on-face", onFace);
      if (name === "tit" && touching && give > 0.22 && dangleAudio) dangleAudio.playTitPull(win, give);
    }

    function pokeAvatar() {
      if (oralEngaged) {
        pokeName = "";
        restName = "";
        endRestPalm();
        restAnchor = null;
        contactAim = null;
        return;
      }
      let hit = findContact();
      const depth = hit ? shaftDepth(hit.pack) : 0;
      if (hit && hit.at) contactSide = hit.at.x < hit.zone.cx ? -1 : 1;
      contactAim = !(hit && ptr.moving && hit.at) ? null : aimAtPoint(hit.at.x, hit.at.y);
      const name = hit ? hit.zone.name : "";
      updateBodyFeel(
        win.performance.now(),
        !!(hit || restName),
        hit ? depth : restName ? 14 : 0,
        hit ? name : restName
      );
      if (hit && ptr.moving) {
        pokeName = name;
        return;
      }
      if (hit && !restName && Math.abs(vel) < 1.15 && !ptr.active) beginRest(hit);
      if (name && name !== pokeName && !restName) {
        const push = hit.at.x < hit.zone.cx ? -1 : 1;
        const mag = name === "tit" ? 1.05 : 1.45;
        vel += push * mag;
        tipVel += push * (name === "face" || name === "head" ? 1.6 : 0.9);
        if (name === "face" || name === "head") {
          nodStart = win.performance.now();
          nodAmp = 0.16;
        }
        if (dangleAudio) dangleAudio.playZoneTouch(win, name, depth);
        ensureTick();
      }
      pokeName = name;
      maybeFlick();
      maybePalmNotYet();
    }

    let flickSpent = false;
    let flickBusyUntil = 0;
    let flickLean = 0;

    function flickBusy() {
      return win.performance.now() < flickBusyUntil || !!(palmHand && palmHand.busy());
    }

    function tipNearOralMouth() {
      const prox = tipOralProximity();
      if (prox && prox.dist <= ORAL_NEAR_PAD) return true;
      return tipInFaceGate();
    }

    function canUseOral() {
      if (flickBusy()) return false;
      if (oralEngaged) return true;
      if (flickSpent) return true;
      const prox = tipOralProximity();
      return !!(prox && prox.dist <= ORAL_NEAR_PAD);
    }

    function companionFaceClient() {
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return null;
      const comp = av.closest(".hq-companion");
      if (!comp || !comp.classList.contains("is-nsfw")) return null;
      const r = av.getBoundingClientRect();
      if (r.width < 8) return null;
      return {
        x: r.left + r.width * 0.5,
        y: r.top + r.height * 0.36,
        mouthY: r.top + r.height * 0.42
      };
    }

    function shaftNearCompanionFace() {
      const face = companionFaceClient();
      if (!face) return null;
      const ts = [0.92, 0.82, 0.72, 0.6, 0.48];
      let bestD = 1e9;
      let bestP = null;
      let bestT = 0.5;
      for (let i = 0; i < ts.length; i += 1) {
        const p = shaftClient(ts[i]);
        if (!p) continue;
        const d = Math.hypot(p.x - face.x, p.y - face.mouthY);
        if (d < bestD) {
          bestD = d;
          bestP = p;
          bestT = ts[i];
        }
      }
      const limit = clamp(mountRectW * 0.14, 38, 58);
      if (!bestP || bestD > limit) return null;
      return { face, at: bestP, dist: bestD, along: bestT };
    }

    function cockNearAvatar() {
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return null;
      const r = av.getBoundingClientRect();
      if (r.width < 8) return null;
      const ts = [0.45, 0.62, 0.78, 0.92];
      let best = null;
      let bestD = 1e9;
      for (let i = 0; i < ts.length; i += 1) {
        const p = shaftClient(ts[i]);
        if (!p) continue;
        const x = clamp(p.x, r.left, r.right);
        const y = clamp(p.y, r.top, r.bottom);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best || bestD > 28) return null;
      const hit = shaftClient(0.58) || best;
      return { at: hit, near: best };
    }

    function bulgeAlongRow(s, along) {
      const bulgeBase =
        1 +
        throbBump(along) * 0.18 * (0.62 + 0.38 * Math.sin(along * Math.PI)) +
        jiggle * Math.sin(jigglePhase * 1.15) * 0.07 * Math.sin(along * Math.PI);
      return bulgeBase * oralBulgeScale((s + 0.5) / ch);
    }

    function artVeinKnotToBufTex(rowT, laneNorm) {
      if (!rowL || !rowR || !cw || !ch) return null;
      const s = clamp(Math.round(rowT * (ch - 1)), 0, ch - 1);
      const left = rowL[s];
      const right = rowR[s];
      if (left > right) return null;
      const cx = (left + right) * 0.5;
      const half = Math.max(1, (right - left) * 0.5);
      const u = cx + laneNorm * half;
      return { x: padX + u, y: padY + s };
    }

    function artVeinKnotToBuf(rowT, laneNorm) {
      if (!cw || !ch || !rowL || !rowR) return null;
      const S = clamp(Math.round(rowT * (ch - 1)), 0, ch - 1);
      const left = rowL[S];
      const right = rowR[S];
      if (left > right) return null;
      const centerCol = (left + right) * 0.5;
      const halfCol = Math.max(1, (right - left) * 0.5);
      const uCol = centerCol + laneNorm * halfCol * 0.94;
      const mid = padX + cw * 0.5;
      let x = 0;
      let y = padY;
      for (let s = 1; s <= S; s += 1) {
        const ap = dir((s - 0.5) / ch);
        const alongStep = (s - 1) / Math.max(1, ch - 1);
        x += Math.sin(ap) * stepLen(alongStep);
        y += Math.cos(ap) * stepLen(alongStep);
      }
      const along = S / Math.max(1, ch - 1);
      const ang = dir((S + 0.5) / ch);
      const nx = Math.cos(ang);
      const ny = -Math.sin(ang);
      const bulge = bulgeAlongRow(S, along);
      const ox = (uCol - cw * 0.5 + 0.5) * bulge;
      return { x: mid + x + nx * ox, y: y + ny * ox };
    }

    function clientFromArtVein(rowT, laneNorm) {
      if (!canvas) return null;
      const dep = artVeinKnotToBuf(rowT, laneNorm);
      if (!dep) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2) return null;
      return {
        x: rect.left + (dep.x / bufW) * rect.width,
        y: rect.top + (dep.y / bufH) * rect.height
      };
    }

    function buildVeinPathClientProcedural(sideSign) {
      const samples = [0.14, 0.24, 0.36, 0.46, 0.56, 0.66, 0.76, 0.86];
      const pts = [];
      for (let i = 0; i < samples.length; i += 1) {
        const p = shaftClient(samples[i]);
        if (!p) return null;
        const j = Math.min(samples.length - 1, i + 1);
        const p1 = shaftClient(samples[j]) || p;
        const dx = p1.x - p.x;
        const dy = p1.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * sideSign;
        const ny = (dx / len) * sideSign;
        const inset = 5 + i * 1.1;
        pts.push({ x: p.x + nx * inset, y: p.y + ny * inset });
      }
      return orientVeinTracePath(pts);
    }

    function orientVeinTracePath(path) {
      if (!path || path.length < 2) return path;
      if (path[0].y > path[path.length - 1].y) return path.slice().reverse();
      return path;
    }

    function knotsToClientPath(knots) {
      if (!knots || knots.length < 2 || !rowL) return null;
      const sorted = knots.slice().sort(function (a, b) {
        return a[0] - b[0];
      });
      const pts = [];
      for (let i = 0; i < sorted.length; i += 1) {
        const p = clientFromArtVein(sorted[i][0], sorted[i][1]);
        if (p) pts.push(p);
      }
      if (pts.length < 2) return null;
      return orientVeinTracePath(pts);
    }

    function distPointToPolyline(px, py, path) {
      let best = 1e9;
      for (let i = 0; i < path.length - 1; i += 1) {
        const ax = path[i].x;
        const ay = path[i].y;
        const bx = path[i + 1].x;
        const by = path[i + 1].y;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1e-6;
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = clamp(t, 0, 1);
        const qx = ax + dx * t;
        const qy = ay + dy * t;
        best = Math.min(best, Math.hypot(px - qx, py - qy));
      }
      return best;
    }

    function buildVeinPathClientFromId(id) {
      const api = global.DanglingVeinPathApi;
      const art = global.DanglingVeinPaths;
      let knots = null;
      if (api && typeof api.getPathById === "function") knots = api.getPathById(id, "auto");
      if (!knots && art && art.paths) {
        const rec = art.paths.find(function (p) {
          return p.id === id;
        });
        if (rec) knots = rec.dense && rec.dense.length >= 2 ? rec.dense : rec.sparse;
      }
      return knotsToClientPath(knots);
    }

    function pickVeinPathForContact(nearPoint) {
      const api = global.DanglingVeinPathApi;
      const list =
        api && typeof api.listPaths === "function"
          ? api.listPaths()
          : global.DanglingVeinPaths && global.DanglingVeinPaths.paths
            ? global.DanglingVeinPaths.paths.map(function (p) {
                return { id: p.id, tier: p.tier, side: p.side };
              })
            : [];
      let bestPath = null;
      let bestId = "";
      let bestTier = "primary";
      let bestD = 1e9;
      for (let i = 0; i < list.length; i += 1) {
        const meta = list[i];
        const path = buildVeinPathClientFromId(meta.id);
        if (!path) continue;
        const d = distPointToPolyline(nearPoint.x, nearPoint.y, path);
        if (d < bestD) {
          bestD = d;
          bestPath = path;
          bestId = meta.id;
          bestTier = meta.tier || "primary";
        }
      }
      if (bestPath) {
        return {
          path: orientVeinTracePath(bestPath),
          id: bestId,
          tier: bestTier,
          dist: bestD
        };
      }
      const sideSign = contactSide || 1;
      const fallback = buildVeinPathClient(sideSign);
      return fallback
        ? {
            path: orientVeinTracePath(fallback),
            id: sideSign < 0 ? "left" : "right",
            tier: "primary",
            dist: 1e9
          }
        : null;
    }

    function buildVeinPathClient(sideSign) {
      const art = global.DanglingVeinPaths;
      const side = sideSign < 0 ? "left" : "right";
      const api = global.DanglingVeinPathApi;
      const knots =
        api && typeof api.getPolyline === "function"
          ? api.getPolyline(side, "auto")
          : art && art[side + "_dense"] && art[side + "_dense"].length >= 2
            ? art[side + "_dense"]
            : art && art[side]
              ? art[side]
              : null;
      if (knots && knots.length >= 2 && rowL) {
        return knotsToClientPath(knots);
      }
      return buildVeinPathClientProcedural(sideSign);
    }

    function clientToBuf(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return { x: 0, y: 0 };
      return {
        x: ((cx - rect.left) / rect.width) * bufW,
        y: ((cy - rect.top) / rect.height) * bufH
      };
    }

    function veinPathPhaseSeed(id) {
      let h = 0;
      const s = String(id || "");
      for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) | 0;
      return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
    }

    function veinPathsReady() {
      const art = global.DanglingVeinPaths;
      return !!(
        mount.classList.contains("is-softbody") &&
        rowL &&
        art &&
        Array.isArray(art.paths) &&
        art.paths.length
      );
    }

    function veinIdlePulseFloor(nowMs) {
      if (!veinPathsReady()) return 0;
      const t = (nowMs || win.performance.now()) * 0.001;
      const idleBreath = 0.5 + 0.5 * Math.sin(t * 4.15);
      return 0.11 + idleBreath * 0.09;
    }

    function veinPulseNeedsFrame() {
      return veinPulseSm > 0.022 || throbNow > 0.008 || veinTraceU >= 0;
    }

    function veinStimLevel(nowMs) {
      let s = veinIdlePulseFloor(nowMs);
      if (throbNow > 0.008) s = Math.max(s, throbNow);
      if (oralEngaged) s = Math.max(s, 0.74);
      if (veinTraceU >= 0) s = Math.max(s, 0.42 + veinTraceU * 0.58);
      if (give > 0.1) s = Math.max(s, give * 0.78);
      if (warmth > 0.16) s = Math.max(s, warmth * 0.58);
      if (restName) s = Math.max(s, 0.26 + give * 0.2);
      if (ptr.active) s = Math.max(s, 0.72);
      if (pokeName === "face" || pokeName === "head" || giveName === "face") s = Math.max(s, 0.55);
      if (pokeName === "tit" || giveName === "tit") s = Math.max(s, 0.38);
      return clamp(s, 0, 1);
    }

    function stepVeinPulse(dt) {
      const target = veinStimLevel(win.performance.now());
      const k = target > veinPulseSm ? 10 : 3.2;
      veinPulseSm += (target - veinPulseSm) * k * dt;
      if (target < 0.05 && veinPulseSm < 0.04) veinPulseSm = 0;
    }

    function veinPulseStrength(nowMs) {
      const t = (nowMs || win.performance.now()) * 0.001;
      const wave = 0.5 + 0.5 * Math.sin(t * 4.15);
      const idle = 0.42 + 0.2 * wave;
      const stim = clamp((veinPulseSm - 0.22) / 0.78, 0, 1);
      let s = idle + stim * (1 - idle);
      if (throbNow > 0.015) s = 1;
      return clamp(s, 0, 1);
    }

    let veinBoxKey = "";
    function syncVeinOverlayBox() {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w < 2 || h < 2) return false;
      const left = canvas.offsetLeft;
      const top = canvas.offsetTop;
      const key = left + "," + top + "," + w + "," + h;
      if (key !== veinBoxKey) {
        veinBoxKey = key;
        veinCanvas.style.position = "absolute";
        veinCanvas.style.margin = "0";
        veinCanvas.style.left = left + "px";
        veinCanvas.style.top = top + "px";
        veinCanvas.style.width = w + "px";
        veinCanvas.style.height = h + "px";
        veinCanvas.style.zIndex = "2";
      }
      return true;
    }

    function veinBufPerCss() {
      const cssW = canvas.clientWidth;
      if (cssW < 2 || !bufW) return cw > 0 && mountRectW > 0 ? cw / mountRectW : 1;
      return bufW / cssW;
    }

    function ensureVeinBufPaths() {
      const key = bufW + "x" + bufH + "x" + cw;
      if (veinBufPaths && veinBufKey === key) return veinBufPaths;
      veinBufKey = key;
      veinBufPaths = [];
      const art = global.DanglingVeinPaths;
      const api = global.DanglingVeinPathApi;
      if (!art || !Array.isArray(art.paths) || !rowL) return veinBufPaths;
      for (let i = 0; i < art.paths.length; i += 1) {
        const rec = art.paths[i];
        let knots =
          api && typeof api.getPathById === "function" ? api.getPathById(rec.id, "auto") : null;
        if (!knots && rec.dense && rec.dense.length >= 2) knots = rec.dense;
        else if (!knots && rec.sparse && rec.sparse.length >= 2) knots = rec.sparse;
        if (!knots || knots.length < 2) continue;
        const pts = [];
        for (let j = 0; j < knots.length; j += 1) {
          const p = artVeinKnotToBufTex(knots[j][0], knots[j][1]);
          if (p) pts.push(p);
        }
        if (pts.length < 2) continue;
        veinBufPaths.push({ id: rec.id, tier: rec.tier || "primary", pts: shapeVeinPts(pts, rec.id) });
      }
      return veinBufPaths;
    }

    function shapeVeinPts(pts, id) {
      if (pts.length < 3) return pts;
      const next = [pts[0]];
      for (let i = 1; i < pts.length - 1; i += 1) {
        next.push({
          x: pts[i - 1].x * 0.18 + pts[i].x * 0.64 + pts[i + 1].x * 0.18,
          y: pts[i - 1].y * 0.12 + pts[i].y * 0.76 + pts[i + 1].y * 0.12
        });
      }
      next.push(pts[pts.length - 1]);
      const phase = veinPathPhaseSeed(id);
      const amp = veinBufPerCss() * (1.55 + ((phase * 17) % 1) * 1.1);
      return next.map(function (p, i) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(next.length - 1, i + 1);
        let dx = next[i1].x - next[i0].x;
        let dy = next[i1].y - next[i0].y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const u = i / (next.length - 1);
        const wander =
          Math.sin(u * 9.4 + phase) * 0.62 + Math.sin(u * 21.7 + phase * 1.7) * 0.38;
        const off = amp * wander;
        return { x: p.x + nx * off, y: p.y + ny * off };
      });
    }

    function traceVeinPts(draw, pts) {
      draw.beginPath();
      draw.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 2) {
        draw.lineTo(pts[1].x, pts[1].y);
        return;
      }
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        draw.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      draw.lineTo(last.x, last.y);
    }

    function veinPulseStrokeWidths(tier, pulseA) {
      const scale = veinBufPerCss();
      const boost = pulseA >= 0.75 ? 1.16 : 1;
      const swell = (0.9 + 0.26 * clamp(pulseA, 0, 1)) * boost;
      const css = (tier === "secondary" ? 1.6 : 2.2) * swell;
      const diam = Math.max(1.5, css * scale);
      const blur = Math.max(1.6, 2.35 * scale);
      return {
        feather: diam * 2.45,
        body: diam * 1.35,
        core: diam,
        blur: blur
      };
    }

    function veinDrawIsOverlay(vctx) {
      return !!(vctx && veinCtx && vctx === veinCtx);
    }

    function strokeVeinPulsePath(pts, tier, pulseA, vctx) {
      const draw = vctx || veinCtx || ctx;
      if (!draw || pts.length < 2) return;
      const a = clamp(pulseA, 0, 1);
      const w = veinPulseStrokeWidths(tier, a);
      const secondary = tier === "secondary";
      const featherA = (secondary ? 0.26 : 0.32) + a * (secondary ? 0.06 : 0.08);
      const coreA = (secondary ? 0.7 : 0.84) + a * (secondary ? 0.08 : 0.1);
      draw.shadowOffsetX = 0;
      draw.shadowOffsetY = 0;
      const softRun = (width, blur, alpha) => {
        const grain = (i) => {
          const x = Math.sin(i * 12.9898 + pts.length * 78.233) * 43758.5453;
          return x - Math.floor(x);
        };
        const step = Math.max(3, Math.round(pts.length / 9));
        for (let i = 0; i < pts.length - 1; i += step) {
          const end = Math.min(pts.length - 1, i + step + 1);
          const slice = pts.slice(Math.max(0, i - 1), end + 1);
          if (slice.length < 2) continue;
          const u = i / Math.max(1, pts.length - 1);
          const bulge = 0.3 + grain(i + 3) * 1.15;
          const taper = 0.55 + 0.45 * Math.sin(Math.PI * u);
          const fade = 0.55 + grain(i + 9) * 0.5;
          const g = Math.round(clamp(alpha * fade, 0, 1) * 255);
          const ink = "rgb(" + g + "," + g + "," + g + ")";
          draw.beginPath();
          draw.moveTo(slice[0].x, slice[0].y);
          for (let k = 1; k < slice.length; k += 1) draw.lineTo(slice[k].x, slice[k].y);
          draw.lineWidth = width * bulge * taper;
          draw.strokeStyle = ink;
          draw.stroke();
        }
      };
      softRun(w.feather, 0, featherA);
      softRun(w.core, 0, coreA);
      draw.shadowBlur = 0;
      draw.shadowColor = "rgba(0,0,0,0)";
    }

    function strokeVeinPulseMaroon(pts, tier, pulseA, draw) {
      const vdraw = draw || veinCtx || ctx;
      if (!vdraw || pts.length < 2) return;
      const a = clamp(pulseA, 0, 1);
      const w = veinPulseStrokeWidths(tier, a);
      const secondary = tier === "secondary";
      const featherA = ((secondary ? 0.26 : 0.32) + a * (secondary ? 0.06 : 0.08)) * 0.55;
      const coreA = ((secondary ? 0.7 : 0.84) + a * (secondary ? 0.08 : 0.1)) * 0.72;
      const blurPx = Math.max(1.4, veinBufPerCss() * 1.35);
      vdraw.save();
      vdraw.lineJoin = "round";
      vdraw.lineCap = "round";
      vdraw.shadowBlur = blurPx;
      vdraw.shadowColor = "rgba(148,46,58,0.45)";
      const run = (width, alpha) => {
        const grain = (i) => {
          const x = Math.sin(i * 12.9898 + pts.length * 78.233) * 43758.5453;
          return x - Math.floor(x);
        };
        const step = Math.max(3, Math.round(pts.length / 9));
        for (let i = 0; i < pts.length - 1; i += step) {
          const end = Math.min(pts.length - 1, i + step + 1);
          const slice = pts.slice(Math.max(0, i - 1), end + 1);
          if (slice.length < 2) continue;
          const u = i / Math.max(1, pts.length - 1);
          const bulge = 0.3 + grain(i + 3) * 1.15;
          const taper = 0.55 + 0.45 * Math.sin(Math.PI * u);
          const fade = 0.55 + grain(i + 9) * 0.5;
          const inkA = clamp(alpha * fade, 0, 1);
          vdraw.beginPath();
          vdraw.moveTo(slice[0].x, slice[0].y);
          for (let k = 1; k < slice.length; k += 1) vdraw.lineTo(slice[k].x, slice[k].y);
          vdraw.lineWidth = width * bulge * taper;
          vdraw.strokeStyle = "rgba(148,46,58," + inkA.toFixed(3) + ")";
          vdraw.stroke();
        }
      };
      run(w.feather, featherA);
      run(w.core, coreA);
      vdraw.shadowBlur = 0;
      vdraw.restore();
    }

    function paintVeinPulseCold(nowMs, vctx, strength) {
      const draw = vctx || veinCtx;
      if (!draw || !cw) return;
      const paths = ensureVeinBufPaths();
      if (!paths.length) return;
      const syncPhase =
        throbNow > 0.02 ? throbPhase * Math.PI * 2 : (nowMs * 0.001) * 4.15;
      draw.save();
      draw.globalCompositeOperation = "source-over";
      for (let i = 0; i < paths.length; i += 1) {
        const vp = paths[i];
        if (vp.pts.length < 2) continue;
        const wobble = 0.88 + 0.12 * Math.sin(veinPathPhaseSeed(vp.id) + syncPhase);
        const a = strength * wobble * (vp.tier === "secondary" ? 0.84 : 1);
        strokeVeinPulseMaroon(vp.pts, vp.tier || "primary", a, draw);
      }
      draw.restore();
    }

    function ensureVeinMerge() {
      if (!bufW || !bufH) return false;
      if (!veinMask) {
        veinMask = doc.createElement("canvas");
        veinMaskCtx = veinMask.getContext("2d", { willReadFrequently: true });
        veinStamp = doc.createElement("canvas");
        veinStampCtx = veinStamp.getContext("2d", { willReadFrequently: true });
      }
      if (!veinMaskCtx || !veinStampCtx) return false;
      if (veinMask.width !== bufW || veinMask.height !== bufH) {
        veinMask.width = bufW;
        veinMask.height = bufH;
        veinStamp.width = bufW;
        veinStamp.height = bufH;
        veinStampImg = veinMaskCtx.createImageData(bufW, bufH);
      }
      return !!veinStampImg;
    }

    function paintVeinPulse(nowMs, vctx) {
      const draw = vctx || veinCtx;
      if (!draw || !cw) return;
      const paths = ensureVeinBufPaths();
      mount.dataset.veinOverlay = String(paths.length);
      if (!paths.length) return;
      const strength = veinPulseStrength(nowMs);
      if (strength < 0.012) return;
      const hot = veinRenderHot();
      if (!hot && veinSwellBaked) {
        if (
          Math.abs(strength - veinPulseLastStrength) < 0.006 &&
          throbNow < 0.015 &&
          veinTraceU < 0
        ) {
          return;
        }
        veinPulseLastStrength = strength;
        paintVeinPulseCold(nowMs, draw, strength);
        return;
      }
      if (!ensureVeinMerge()) return;
      const syncPhase =
        throbNow > 0.02 ? throbPhase * Math.PI * 2 : (nowMs * 0.001) * 4.15;
      const g = veinMaskCtx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.shadowBlur = 0;
      g.fillStyle = "#000";
      g.fillRect(0, 0, bufW, bufH);
      g.globalCompositeOperation = "lighten";
      g.globalAlpha = 1;
      g.lineJoin = "round";
      g.lineCap = "round";
      for (let i = 0; i < paths.length; i += 1) {
        const vp = paths[i];
        if (vp.pts.length < 2) continue;
        const wobble = 0.88 + 0.12 * Math.sin(veinPathPhaseSeed(vp.id) + syncPhase);
        const a = strength * wobble * (vp.tier === "secondary" ? 0.84 : 1);
        strokeVeinPulsePath(vp.pts, vp.tier || "primary", a, g);
      }
      g.shadowBlur = 0;
      const src = g.getImageData(0, 0, bufW, bufH).data;
      const dst = veinStampImg.data;
      for (let i = 0; i < src.length; i += 4) {
        const cov = src[i];
        const alpha = cov < 8 ? 0 : Math.min(196, Math.round(255 * Math.pow(cov / 255, 1.35)));
        dst[i] = 148;
        dst[i + 1] = 46;
        dst[i + 2] = 58;
        dst[i + 3] = alpha;
      }
      veinStampCtx.setTransform(1, 0, 0, 1, 0, 0);
      veinStampCtx.putImageData(veinStampImg, 0, 0);
      const blurPx = Math.max(2.1, veinBufPerCss() * 2.05);
      draw.save();
      draw.globalCompositeOperation = "source-over";
      draw.globalAlpha = 1;
      draw.filter = "blur(" + blurPx.toFixed(2) + "px)";
      draw.drawImage(veinStamp, 0, 0);
      draw.filter = "none";
      draw.restore();
    }

    function paintVeinHighlight(vctx) {
      const draw = vctx || veinCtx;
      if (veinTraceU < 0 || !draw || !cw) return;
      const path = veinTracePath || buildVeinPathClient(veinPathSide);
      if (!path || path.length < 2) return;
      const veinPointAt = (u) => {
        const t = clamp(u, 0, 1) * (path.length - 1);
        const i0 = Math.floor(t);
        const i1 = Math.min(path.length - 1, i0 + 1);
        const k = t - i0;
        return {
          x: path[i0].x + (path[i1].x - path[i0].x) * k,
          y: path[i0].y + (path[i1].y - path[i0].y) * k
        };
      };
      draw.save();
      draw.globalCompositeOperation = "source-over";
      draw.lineJoin = "round";
      draw.lineCap = "round";
      const traceW = clamp(cw * 0.046, 2.8, 8);
      draw.lineWidth = traceW;
      draw.strokeStyle = "rgba(196,88,108," + (0.18 + veinTraceU * 0.36).toFixed(3) + ")";
      draw.beginPath();
      const s0 = clientToBuf(path[0].x, path[0].y);
      draw.moveTo(s0.x, s0.y);
      for (let i = 1; i < path.length; i += 1) {
        const u = i / (path.length - 1);
        if (u >= veinTraceU) {
          const mid = veinPointAt(veinTraceU);
          const bm = clientToBuf(mid.x, mid.y);
          draw.lineTo(bm.x, bm.y);
          break;
        }
        const b = clientToBuf(path[i].x, path[i].y);
        draw.lineTo(b.x, b.y);
      }
      draw.stroke();
      if (!veinDrawIsOverlay(draw)) {
        draw.globalCompositeOperation = "multiply";
        draw.lineWidth = Math.max(1.2, traceW * 0.55);
        draw.strokeStyle = "rgba(138, 6, 24, " + (0.28 + veinTraceU * 0.42).toFixed(3) + ")";
        draw.beginPath();
        draw.moveTo(s0.x, s0.y);
        for (let i = 1; i < path.length; i += 1) {
          const u = i / (path.length - 1);
          if (u >= veinTraceU) {
            const mid = veinPointAt(veinTraceU);
            const bm = clientToBuf(mid.x, mid.y);
            draw.lineTo(bm.x, bm.y);
            break;
          }
          const b = clientToBuf(path[i].x, path[i].y);
          draw.lineTo(b.x, b.y);
        }
        draw.stroke();
      } else {
        draw.globalCompositeOperation = "source-over";
        draw.lineWidth = Math.max(1.2, traceW * 0.55);
        draw.strokeStyle = "rgba(150, 8, 28, " + (0.4 + veinTraceU * 0.45).toFixed(3) + ")";
        draw.beginPath();
        draw.moveTo(s0.x, s0.y);
        for (let i = 1; i < path.length; i += 1) {
          const u = i / (path.length - 1);
          if (u >= veinTraceU) {
            const mid = veinPointAt(veinTraceU);
            const bm = clientToBuf(mid.x, mid.y);
            draw.lineTo(bm.x, bm.y);
            break;
          }
          const b = clientToBuf(path[i].x, path[i].y);
          draw.lineTo(b.x, b.y);
        }
        draw.stroke();
      }
      draw.restore();
    }

    function shaftNearlyStillForVein(nearFace) {
      if (
        ptr.active ||
        dragging ||
        oralEngaged
      ) {
        return false;
      }
      const velOk = Math.abs(vel) < (nearFace ? 0.075 : 0.052);
      const tipOk = Math.abs(tipVel) < (nearFace ? 0.05 : 0.035) && Math.abs(tip) < (nearFace ? 0.04 : 0.028);
      const motionOk = throbNow < 0.03 && nodNow < 0.03 && jiggle < (nearFace ? 0.05 : 0.03);
      return velOk && tipOk && motionOk;
    }

    function shaftNearlyStill() {
      return shaftNearlyStillForVein(false);
    }

    function tickVeinTrace(dt) {
      if (!palmHand || flickBusy() || oralEngaged) {
        veinStillMs = 0;
        return;
      }
      const nearFace = shaftNearCompanionFace();
      if (!nearFace) {
        veinStillMs = 0;
        veinTraceSpent = false;
        return;
      }
      if (!shaftNearlyStillForVein(true)) {
        veinStillMs = 0;
        return;
      }
      veinStillMs += dt * 1000;
      if (veinTraceSpent || veinStillMs < STILL_VEIN_MS) return;
      const picked = pickVeinPathForContact(nearFace.at);
      if (!picked || !picked.path) return;
      veinTracePath = picked.path;
      veinTracePathId = picked.id;
      veinPathSide = contactSide || 1;
      const top = picked.path[0];
      const fingerStart = {
        x: top.x,
        y: top.y - clamp(mountRectW * 0.035, 6, 14)
      };
      if (
        palmHand.play("trace_vein", {
          path: picked.path,
          start: fingerStart
        })
      ) {
        veinTraceSpent = true;
        veinStillMs = 0;
        ensureTick();
      }
    }

    function jiggleTransferina() {
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (!comp) return;
      comp.classList.remove("is-flick-jiggle", "is-palm-soft-jiggle");
      void comp.offsetWidth;
      comp.classList.add("is-flick-jiggle");
      if (comp._flickJiggle) win.clearTimeout(comp._flickJiggle);
      comp._flickJiggle = win.setTimeout(() => {
        comp.classList.remove("is-flick-jiggle");
        comp._flickJiggle = 0;
      }, 740);
    }

    function jiggleTransferinaSoft() {
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (!comp) return;
      comp.classList.remove("is-flick-jiggle", "is-palm-soft-jiggle");
      void comp.offsetWidth;
      comp.classList.add("is-palm-soft-jiggle");
      if (comp._palmJiggle) win.clearTimeout(comp._palmJiggle);
      comp._palmJiggle = win.setTimeout(() => {
        comp.classList.remove("is-palm-soft-jiggle");
        comp._palmJiggle = 0;
      }, 820);
    }

    const jiggleLines = [1, 2, 3, 4, 5].map(
      (n) => "/assets/companion/jiggle/Else_cute_jiggling_0" + n + ".mp3"
    );
    let jiggleVoice = null;
    let slapVoice = null;
    const slapLine = "/assets/companion/jiggle/Else_enthusiastic_slap_on_tits_03.mp3";

    function ensureJiggleVoice() {
      if (jiggleVoice) return jiggleVoice;
      jiggleVoice = new Audio();
      jiggleVoice.preload = "auto";
      return jiggleVoice;
    }

    function playJiggle() {
      if (dangleAudio?.playFlickJiggle(win)) return;
      const voice = ensureJiggleVoice();
      voice.pause();
      voice.src = jiggleLines[Math.floor(Math.random() * jiggleLines.length)];
      voice.volume = 0.9;
      voice.currentTime = 0;
      voice.play().catch(() => {});
    }

    function playSlap() {
      if (dangleAudio?.playFlickSlap(win, 0.85)) return;
      if (!slapVoice) {
        slapVoice = new Audio(slapLine);
        slapVoice.preload = "auto";
      }
      slapVoice.pause();
      slapVoice.volume = 0.95;
      slapVoice.currentTime = 0;
      slapVoice.play().catch(() => {});
    }

    let palmHand = null;
    if (global.HqPalmHand) {
      palmHand = global.HqPalmHand.create(win, {
        calm,
        cockNear: cockNearAvatar,
        mountRectW: () => mountRectW,
        mountBox: () => mount.getBoundingClientRect(),
        place,
        jiggle: jiggleTransferina,
        jiggleSoft: jiggleTransferinaSoft,
        playSlap,
        playJiggle,
        onVeinTrace(active, u) {
          veinTraceU = active ? u : -1;
          if (active) {
            dirty = true;
            ensureTick();
          }
        }
      });
      win.HqPalmHand = palmHand;
    }

    function endRestPalm() {
      if (palmHand && typeof palmHand.releaseHold === "function") palmHand.releaseHold();
      palmPatSpentForRest = false;
    }

    function maybePalmNotYet() {
      if (!palmHand || oralEngaged || flickBusy()) return;
      if (!tipNearOralMouth()) {
        pushSoftOralSpent = false;
        return;
      }
      if (canUseOral()) return;
      if (pushSoftOralSpent) return;
      const near = cockNearAvatar();
      if (!near) return;
      if (palmHand.play("push_soft", { near })) pushSoftOralSpent = true;
    }

    function maybeFlick() {
      if (flickSpent || !palmHand) return;
      if (tipNearOralMouth()) return;
      if (oralEngaged) return;
      const near = cockNearAvatar();
      if (!near) return;
      const av = doc.querySelector(".hq-companion-avatar");
      if (!av) return;
      const r = av.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      flickSpent = true;
      flickBusyUntil = win.performance.now() + 1560;
      palmHand.play("slap", {
        onSlapContact: () => {
          flickLean = near.at.x < cx ? -1.8 : 1.8;
          jiggle = 1;
          jigglePhase = 0;
          contactAim = null;
          restName = "";
        endRestPalm();
          restAnchor = null;
          if (win.HqKinetic) {
            const side = near.at.x < cx ? -1 : 1;
            win.HqKinetic.emit({
              kind: "contact",
              source: "member",
              intensity: 0.86,
              direction: { x: side, y: -0.12 },
              delayMs: 55,
              durationMs: 760,
              replace: true,
            });
          }
          ensureTick();
        }
      });
    }

    function tick(t) {
      if (doc.hidden) {
        win.addEventListener(
          "visibilitychange",
          function resume() {
            if (!doc.hidden && running) {
              lastFrameT = 0;
              win.requestAnimationFrame(tick);
            }
          },
          { once: true }
        );
        return;
      }
      if (!lastFrameT) lastFrameT = t;
      const frameDt = Math.min(0.05, (t - lastFrameT) / 1000);
      lastFrameT = t;
      accum += frameDt;
      let steps = 0;
      while (accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
        step(FIXED_DT);
        accum -= FIXED_DT;
        steps += 1;
      }
      if (dirty || oralEngaged) render(t);
      followRest();
      if (ptr.active && ptr.moving) oralInsertAssist(frameDt);
      pokeAvatar();
      if (ptr.active || oralEngaged) updateOralHead();
      if (alive()) win.requestAnimationFrame(tick);
      else stopSim();
    }

    const GLISTEN_IDLE_MS = 60;
    const VEIN_IDLE_MS = 80;
    let glistenSeen = true;

    function veinRenderHot() {
      return !!(
        dragging || ptr.active || oralEngaged || oralDepthSm > 0.01 ||
        throbNow > 0.02 || veinTraceU >= 0
      );
    }

    function simBusy() {
      return (
        running ||
        dragging ||
        ptr.active ||
        oralEngaged ||
        oralPhase !== "idle" ||
        oralDepthSm > 0.01
      );
    }

    function glistenBusy() {
      return (
        simBusy() ||
        !!restName ||
        throbStart >= 0 ||
        nodStart >= 0 ||
        warmth > 0.008 ||
        Math.abs(give) > 0.0005 ||
        Math.abs(giveVel) > 0.0005
      );
    }

    function danglePaintDeepSleep() {
      if (!danglePaintArmed) return true;
      const motion = win.HqMotion;
      if (motion && !motion.dangleShouldRun()) return true;
      return doc.hidden || !glistenSeen || motionReduced;
    }

    function armDanglePaint() {
      if (danglePaintArmed) {
        if (!mount.classList.contains("is-softbody") && img.complete) resizeCanvas();
        scheduleDanglePaint(0);
        return;
      }
      danglePaintArmed = true;
      if (dangleArmTimer) {
        win.clearTimeout(dangleArmTimer);
        dangleArmTimer = 0;
      }
      if (img.complete) resizeCanvas();
      scheduleDanglePaint(0);
    }

    function danglePaintColdFlat() {
      return bodyIsFlat() && veinSwellBaked && !veinRenderHot() && !simBusy() && !glistenBusy();
    }

    function clearDanglePaintTimer() {
      if (danglePaintTimer) {
        win.clearTimeout(danglePaintTimer);
        danglePaintTimer = 0;
      }
    }

    function scheduleDanglePaint(delayMs) {
      if (motionReduced || !ctx) {
        danglePaintOn = false;
        return;
      }
      if (danglePaintDeepSleep()) {
        danglePaintOn = false;
        return;
      }
      danglePaintOn = true;
      if (danglePaintFrame) return;
      if (delayMs > 4) {
        clearDanglePaintTimer();
        danglePaintTimer = win.setTimeout(() => {
          danglePaintTimer = 0;
          danglePaintQueue();
        }, delayMs);
        return;
      }
      danglePaintQueue();
    }

    function danglePaintQueue() {
      if (danglePaintFrame || !danglePaintOn || danglePaintDeepSleep()) return;
      danglePaintFrame = true;
      win.requestAnimationFrame(danglePaintLoop);
    }

    function paintFlatOrCurve(t) {
      if (restName || oralEngaged || throbNow > 0.01 || nodNow > 0.01) renderCurve();
      else renderFlat();
    }

    function paintVeinOverlayFrame(t, hot, paintRaster) {
      if (!syncVeinOverlayBox()) {
        if (running) return;
        if (paintRaster) {
          if (hot) {
            renderFlat();
            if (ensureVeinSwellField()) paintVeinSwell(t);
          } else blitMemberBake(t);
          paintGlisten(t);
        } else {
          blitMemberBake(t);
          paintGlisten(t);
        }
        paintVeinPulse(t, ctx);
        paintVeinHighlight(ctx);
        return;
      }
      veinCtx.setTransform(1, 0, 0, 1, 0, 0);
      veinCtx.clearRect(0, 0, veinCanvas.width, veinCanvas.height);
      paintVeinPulse(t, veinCtx);
      paintVeinHighlight(veinCtx);
      if (hot && ensureVeinSwellField()) warpVeinOverlay(veinPulseStrength(t));
    }

    function danglePaintLoop(t) {
      danglePaintFrame = false;
      if (!danglePaintOn || danglePaintDeepSleep()) {
        danglePaintOn = false;
        return;
      }
      if (!veinCtx || !bufW || !bufH) {
        scheduleDanglePaint(120);
        return;
      }
      if (!veinPathsReady()) {
        scheduleDanglePaint(120);
        return;
      }
      const hot = veinRenderHot();
      const coldFlat = danglePaintColdFlat();
      const minGap = hot ? 0 : coldFlat ? VEIN_IDLE_MS : GLISTEN_IDLE_MS;
      const prev = danglePaintLast;
      if (!hot && prev && t - prev < minGap) {
        scheduleDanglePaint(Math.max(8, minGap - (t - prev)));
        return;
      }
      danglePaintLast = t;
      const dt = prev ? Math.min(0.05, (t - prev) / 1000) : 0.016;
      const paintStart = win.performance.now();
      updateThrob(t);
      stepVeinPulse(dt);
      if (veinWasHot && !hot) {
        veinSwellBaked = false;
        invalidateMemberBake();
        veinPulseLastStrength = -1;
      }
      veinWasHot = hot;
      const paintRaster = hot || !veinSwellBaked;

      if (running) {
        paintVeinOverlayFrame(t, hot, paintRaster);
        if (paintRaster) veinSwellBaked = true;
        scheduleDanglePaint(hot ? 0 : VEIN_IDLE_MS);
        return;
      }

      followRest();
      if (!running) updateBodyFeel(t, !!restName, restName ? 14 : 0, restName);

      if (bodyIsFlat()) {
        if (paintRaster) {
          if (hot) {
            renderFlat();
            if (ensureVeinSwellField()) paintVeinSwell(t);
            paintGlisten(t);
            rebuildMemberBake(t, true);
          } else {
            rebuildMemberBake(t, false);
            blitMemberBake(t);
            paintGlisten(t);
            scheduleSwellIdleBake();
          }
        } else {
          blitMemberBake(t);
          paintGlisten(t);
        }
      } else {
        paintFlatOrCurve(t);
        paintGlisten(t);
      }

      paintVeinOverlayFrame(t, hot, paintRaster);
      if (paintRaster) veinSwellBaked = true;

      const paintCost = win.performance.now() - paintStart;
      if (win.HqMotion) win.HqMotion.noteCost("dangle", paintCost);

      if (coldFlat) {
        const throbIn = nextThrobAt ? nextThrobAt - win.performance.now() : Infinity;
        scheduleDanglePaint(Math.min(VEIN_IDLE_MS * 2, Math.max(VEIN_IDLE_MS, throbIn - 24)));
      } else if (hot || glistenBusy()) {
        danglePaintQueue();
      } else {
        const throbIn = nextThrobAt ? nextThrobAt - win.performance.now() : Infinity;
        scheduleDanglePaint(Math.min(GLISTEN_IDLE_MS * 2, Math.max(GLISTEN_IDLE_MS, throbIn - 24)));
      }
    }

    function wakeGlisten() {
      if (!ctx || motionReduced) return;
      clearDanglePaintTimer();
      danglePaintOn = true;
      scheduleDanglePaint(0);
    }

    function wakeVeinPulse() {
      wakeGlisten();
    }

    function startGlisten() {
      if (danglePaintOn || !ctx || motionReduced) return;
      wakeGlisten();
    }
    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden) wakeGlisten();
      else if (veinCtx) veinCtx.clearRect(0, 0, bufW, bufH);
    });
    if (typeof win.IntersectionObserver === "function") {
      new win.IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        glistenSeen = !last || last.isIntersecting;
        if (win.HqMotion) win.HqMotion.setDangleSeen(glistenSeen);
        if (glistenSeen) {
          if (!danglePaintArmed && !dangleArmTimer) {
            dangleArmTimer = win.setTimeout(() => {
              dangleArmTimer = 0;
              armDanglePaint();
            }, 900);
          }
          wakeGlisten();
        }
      }).observe(mount);
    }
    mount.addEventListener(
      "pointerenter",
      () => {
        armDanglePaint();
      },
      { passive: true }
    );

    function ensureTick() {
      armDanglePaint();
      mount.classList.add("is-wobbling");
      swing.classList.add("is-dangle-active");
      wakeGlisten();
      if (running) return;
      running = true;
      lastFrameT = 0;
      accum = 0;
      dirty = true;
      win.requestAnimationFrame(tick);
    }

    function applyLayout() {
      maxTravel = Math.max(cw * 2.2, mountRectW * pxPerScreen * PULL_SCREEN);
      padX = Math.ceil(ch * 0.92 + cw);
      padY = Math.ceil(cw * 1.5 + 40);
      bufW = cw + padX * 2;
      bufH = ch + padY + Math.ceil(ch * 0.34);
    }

    function resizeCanvas() {
      texW = img.naturalWidth || img.width;
      texH = img.naturalHeight || img.height;
      if (!texW || !texH) return;
      readMount();
      const dpr = Math.min(win.devicePixelRatio || 1, 1.25);
      const scale = Math.min(1, (mountRectW * dpr) / texW);
      const nextCw = Math.max(1, Math.round(texW * scale));
      const nextCh = Math.max(1, Math.round(texH * scale));
      if (running && Math.abs(nextCw - cw) < 2 && Math.abs(nextCh - ch) < 2) {
        resizePending = false;
        return;
      }
      cw = nextCw;
      ch = nextCh;
      pxPerScreen = cw / mountRectW;
      applyLayout();
      veinBufKey = "";
      veinBufPaths = null;
      veinBoxKey = "";
      swellKey = "";
      invalidateMemberBake();
      canvas.width = bufW;
      canvas.height = bufH;
      veinCanvas.width = bufW;
      veinCanvas.height = bufH;
      canvas.style.setProperty("--dangle-cw", String(cw));
      canvas.style.setProperty("--dangle-pad", String(padX));
      canvas.style.setProperty("--dangle-pad-y", String(padY));
      canvas.style.setProperty("--dangle-buf-w", String(bufW));
      veinCanvas.style.setProperty("--dangle-cw", String(cw));
      veinCanvas.style.setProperty("--dangle-pad", String(padX));
      veinCanvas.style.setProperty("--dangle-pad-y", String(padY));
      veinCanvas.style.setProperty("--dangle-buf-w", String(bufW));
      if (!ctx) {
        ctx = canvas.getContext("2d", { alpha: true });
        if (ctx) ctx.imageSmoothingEnabled = true;
      }
      if (!veinCtx) {
        veinCtx = veinCanvas.getContext("2d", { alpha: true });
        if (veinCtx) veinCtx.imageSmoothingEnabled = true;
      }
      if (!danglePaintArmed) {
        mount.classList.remove("is-softbody");
        resizePending = false;
        dirty = true;
        return;
      }
      mount.classList.add("is-softbody");
      bakeSource();
      resizePending = false;
      dirty = true;
      if (!running) {
        renderFlat();
        if (!motionReduced) paintGlisten(win.performance.now());
      }
      if (motionReduced) return;
      startGlisten();
      stepVeinPulse(0.05);
      veinPulseSm = Math.max(veinPulseSm, veinIdlePulseFloor(win.performance.now()));
    }

    function queueResize() {
      if (resizePending || running) return;
      resizePending = true;
      win.requestAnimationFrame(resizeCanvas);
    }

    if (img.complete) resizeCanvas();
    else img.addEventListener("load", resizeCanvas, { once: true });
    if (typeof win.ResizeObserver === "function") new win.ResizeObserver(queueResize).observe(mount);

    function swayAngle() {
      const tr = win.getComputedStyle(swing).transform;
      if (!tr || tr === "none") return 0;
      const m = tr.match(/matrix\(([^)]+)\)/);
      if (!m) return 0;
      const p = m[1].split(",");
      const a = parseFloat(p[0]);
      const b = parseFloat(p[1]);
      if (!isFinite(a) || !isFinite(b)) return 0;
      return clamp(Math.atan2(b, a), -0.2, 0.2);
    }

    mount.addEventListener("pointerleave", () => {
      grazeArmed = true;
      grazeT = 0;
    });
    mount.addEventListener(
      "pointermove",
      (ev) => {
        if (ptr.active || ev.buttons) return;
        const now = win.performance.now();
        if (!grazeT) {
          grazeX = ev.clientX;
          grazeT = now;
          return;
        }
        const dx = ev.clientX - grazeX;
        const dtMs = Math.max(1, now - grazeT);
        grazeX = ev.clientX;
        grazeT = now;
        if (!grazeArmed) return;
        if (relY(ev.clientY) < 0.22) return;
        const speed = (Math.abs(dx) / dtMs) * 1000;
        if (speed < 140) return;
        grazeArmed = false;
        if (dangleAudio) dangleAudio.playDragSnap(win, speed);
        if (!running) angle = swayAngle();
        const impulse = clamp(Math.sign(dx) * (0.55 + Math.min(1.3, speed / 1100)), -1.9, 1.9);
        vel += impulse;
        tipVel += impulse * 0.8;
        ensureTick();
      },
      { passive: true }
    );

    mount.addEventListener(
      "pointerdown",
      (ev) => {
        if (ev.button !== 0) return;
        if (dangleAudio) dangleAudio.prime(win);
        else {
          if (!slapVoice) slapVoice = new Audio(slapLine);
          if (!slapVoice._unlocked) {
            slapVoice.volume = 0;
            const slapUnlock = slapVoice.play();
            if (slapUnlock && slapUnlock.then) {
              slapUnlock.then(() => {
                slapVoice.pause();
                slapVoice.currentTime = 0;
                slapVoice.volume = 0.95;
                slapVoice._unlocked = true;
              }).catch(() => {});
            }
          }
          const voice = ensureJiggleVoice();
          if (!voice._unlocked) {
            voice.src = jiggleLines[0];
            voice.volume = 0;
            const unlocked = voice.play();
            if (unlocked && unlocked.then) {
              unlocked.then(() => {
                voice.pause();
                voice.volume = 0.9;
                voice._unlocked = true;
              }).catch(() => {});
            }
          }
        }
        mount.setPointerCapture(ev.pointerId);
        ptr.active = true;
        dragging = true;
        if (win.HqKinetic) win.HqKinetic.setManipulating(true);
        readMount();
        pxPerScreen = cw / mountRectW;
        ptr.downX = ev.clientX;
        ptr.downY = ev.clientY;
        ptr.lastX = ev.clientX;
        ptr.lastY = ev.clientY;
        ptr.lastT = win.performance.now();
        ptr.smVx = 0;
        ptr.smVy = 0;
        throbStart = -1;
        throbNow = 0;
        throbEnv = 0;
        throbEnvTip = 0;
        throbPhase = 0;
        restName = "";
        endRestPalm();
        restAnchor = null;
        contactAim = null;
        if (!oralEngaged) {
          clearOral();
          setCockLayer(false);
        }
        ptr.dragPx = 0;
        ptr.dragPy = 0;
        ptr.hitT = relY(ev.clientY);
        ptr.moving = ptr.hitT < 0.38 || oralEngaged;
        dragging = !ptr.moving;
        hangLean = ptr.moving ? angle : 0;
        if (ptr.moving) {
          const box = mount.getBoundingClientRect();
          ptr.grabOffX = ev.clientX - box.left;
          ptr.grabOffY = ev.clientY - box.top;
        }
        ensureTick();
      },
      { passive: true }
    );

    mount.addEventListener(
      "pointermove",
      (ev) => {
        if (!ptr.active) return;
        const now = win.performance.now();
        const dtMs = Math.max(1, now - ptr.lastT);
        const dx = ev.clientX - ptr.lastX;
        const dy = ev.clientY - ptr.lastY;
        const instX = (dx / dtMs) * 1000;
        const instY = (dy / dtMs) * 1000;
        if (Math.abs(dx) >= 0.35) ptr.smVx += (instX - ptr.smVx) * (ptr.moving ? 0.4 : 0.62);
        if (Math.abs(dy) >= 0.35) ptr.smVy += (instY - ptr.smVy) * (ptr.moving ? 0.4 : 0.62);
        if (ptr.moving) {
          if (oralEngaged && oralPhase === "active") {
            const dAlong = dx * oralTubeUx + dy * oralTubeUy;
            const dPerp = -dx * oralTubeUy + dy * oralTubeUx;
            let effAlong = dAlong;
            // Progressive viscous resistance as the thick member packs deep into the throat
            if (oralDepthSm > 75 && dAlong > 0) {
              const resNorm = clamp((oralDepthSm - 75) / (ORAL_TUBE_DEPTH - 75), 0, 1);
              // Resistance stiffens up to 72% pushback at the hilt
              const resistK = 1.0 - 0.72 * (resNorm * resNorm);
              effAlong *= resistK;
            }
            if (oralDepthSm >= ORAL_TUBE_DEPTH && dAlong > 0) {
              effAlong *= 0.20;
            }
            const effPerp = dPerp;
            oralBob = clamp(oralBob + dPerp * 0.25, -24, 24);
            if (dangleAudio) dangleAudio.playOralMotion(win, oralDepthSm, effAlong, effPerp);
            const effDx = effAlong * oralTubeUx - effPerp * oralTubeUy;
            const effDy = effAlong * oralTubeUy + effPerp * oralTubeUx;
            const box = mount.getBoundingClientRect();
            const curL = parseFloat(mount.style.left) || box.left;
            const curT = parseFloat(mount.style.top) || box.top;
            const nxtL = curL + effDx;
            const nxtT = curT + effDy;
            place(nxtL, nxtT);
            ptr.grabOffX = ev.clientX - nxtL;
            ptr.grabOffY = ev.clientY - nxtT;
          } else {
            place(ev.clientX - ptr.grabOffX, ev.clientY - ptr.grabOffY);
            if (!oralEngaged) keepOut();
          }
          ptr.lastX = ev.clientX;
          ptr.lastY = ev.clientY;
          ptr.lastT = now;
          dirty = true;
          ensureTick();
          return;
        }
        ptr.dragPx = (ev.clientX - ptr.downX) * pxPerScreen;
        ptr.dragPy = (ev.clientY - ptr.downY) * pxPerScreen;
        ptr.lastX = ev.clientX;
        ptr.lastY = ev.clientY;
        ptr.lastT = now;
        dirty = true;
        ensureTick();
      },
      { passive: true }
    );

    function endPointer(ev) {
      if (!ptr.active) return;
      if (win.HqKinetic) win.HqKinetic.setManipulating(false);
      const tapMoved = Math.hypot((ev.clientX || 0) - ptr.downX, (ev.clientY || 0) - ptr.downY);
      if (tapMoved < 12) {
        const nowTap = win.performance.now();
        if (nowTap - veinSwellTapAt < 360) {
          veinSwellTapAt = 0;
          setVeinSwellMode(veinSwellMode === "extreme" ? "epic" : "extreme");
        } else veinSwellTapAt = nowTap;
      }
      ptr.active = false;
      dragging = false;
      const wasMoving = ptr.moving;
      ptr.moving = false;
      try {
        mount.releasePointerCapture(ev.pointerId);
      } catch (_) {}
      if (wasMoving) {
        const wasOral = oralPhase === "active" && oralDepth > 4;
        const releaseDepth = oralDepthSm;
        clearOral();
        if (wasOral) {
          // If released while deeply packed in the throat, elastic recoil ejects back slightly
          if (releaseDepth > 85) {
            vel = clamp(-2.8 * (releaseDepth / ORAL_TUBE_DEPTH), -4.5, -1.2);
            tipVel = vel * 1.5;
            jiggle = 0.45;
            jigglePhase = 0;
          }
          ensureTick();
          return;
        }
        const hit = findContact();
        if (hit) {
          beginRest(hit);
          angle = restAngle;
          tip = restAngle;
          vel = 0;
          tipVel = 0;
        } else {
          restName = "";
        endRestPalm();
          vel = clamp(vel, -5.5, 5.5);
          hangLean = 0;
        }
        if (win.HqKinetic) {
          const spd = Math.hypot(ptr.smVx, ptr.smVy);
          if (spd > 140) {
            win.HqKinetic.emit({
              kind: "release",
              source: "member",
              intensity: clamp(spd / 720, 0.28, 0.92),
              direction: { x: ptr.smVx, y: ptr.smVy },
              delayMs: 35,
              durationMs: 620,
            });
          }
        }
        ensureTick();
        return;
      }
      const y = Math.max(ch * 0.22, ch * ptr.hitT);
      vel = (ptr.smVx * pxPerScreen) / y;
      vel = clamp(vel, -8, 8);
      tipVel += vel * 2.6;
      if (dangleAudio) dangleAudio.playDragSnap(win, Math.hypot(ptr.smVx, ptr.smVy));
      if (slack > 0.04) vel += Math.sign(tip || 1) * slack * 4;
      ripple = clamp(ripple + Math.min(0.16, Math.abs(vel) * 0.045), -0.2, 0.2);
      ensureTick();
    }

    win.__hqVeinSwell = function (mode) {
      if (mode) setVeinSwellMode(mode);
      return veinSwellMode;
    };

    win.__hqVeinDebug = function () {
      let paths = 0;
      try {
        paths = ensureVeinBufPaths().length;
      } catch (_) {
        paths = 0;
      }
      const box = veinCanvas.getBoundingClientRect();
      return {
        ready: veinPathsReady(),
        paths: paths,
        sm: veinPulseSm,
        strength: veinPulseStrength(win.performance.now()),
        overlay: mount.dataset.veinOverlay || "",
        box: Math.round(box.width),
        softbody: mount.classList.contains("is-softbody"),
        swell: veinSwellMode
      };
    };

    mount.addEventListener("pointerup", endPointer);
    mount.addEventListener("pointercancel", endPointer);
    win.addEventListener("resize", () => {
      if (oralEngaged) {
        oralMouthCache = oralMouthAnchorFresh();
        if (oralMouthCache) captureOralTube(oralMouthCache);
      }
      if (!mount.style.left) return;
      const box = mount.getBoundingClientRect();
      place(box.left, box.top);
    });
  }

  if (typeof document !== "undefined") {
    const boot = () => {
      try {
        initDanglingMember(global);
      } catch (err) {
        console.error("HqDanglingMember init failed:", err);
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { initDanglingMember, calm };
});
