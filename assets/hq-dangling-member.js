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
    if (!mount || calm(win)) return;
    const swing = mount.querySelector(".hq-dangling-member-swing");
    const img = swing && swing.querySelector(".hq-dangling-member");
    if (!swing || !img) return;

    const dangleAudio = global.HqDangleAudio;
    if (dangleAudio) dangleAudio.bind(win);

    const canvas = doc.createElement("canvas");
    canvas.className = "hq-dangling-member-canvas";
    canvas.setAttribute("aria-hidden", "true");
    swing.appendChild(canvas);

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
      dirty = true;
    }

    function renderFlat() {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bufW, bufH);
      ctx.drawImage(img, 0, 0, texW, texH, padX, padY, cw, ch);
      dirty = false;
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
          const al = srcPx[si + 3];
          if (al < 8) continue;
          const ox = (u - halfCw + 0.5) * bulge;
          const depX = mid + x + nx * ox;
          const depY = y + ny * ox;
          if (oralEngaged && oralChinMaxY > 0 && s >= oralLipRow - 10 && depY > oralChinMaxY) {
            continue;
          }
          deposit(depX, depY, srcPx[si], srcPx[si + 1], srcPx[si + 2], al);
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
    }

    let pokeName = "";
    let pokeClear = 0;
    let contactAim = null;
    let restName = "";
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
    }

    let flickSpent = false;
    let flickBusyUntil = 0;
    let flickLean = 0;
    let flickHand = null;

    function flickBusy() {
      return win.performance.now() < flickBusyUntil;
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

    function jiggleTransferina() {
      const av = doc.querySelector(".hq-companion-avatar");
      const comp = av && (av.closest(".hq-companion") || av);
      if (!comp) return;
      comp.classList.remove("is-flick-jiggle");
      void comp.offsetWidth;
      comp.classList.add("is-flick-jiggle");
      if (comp._flickJiggle) win.clearTimeout(comp._flickJiggle);
      comp._flickJiggle = win.setTimeout(() => {
        comp.classList.remove("is-flick-jiggle");
        comp._flickJiggle = 0;
      }, 740);
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

    function maybeFlick() {
      if (flickSpent) return;
      if (tipNearOralMouth()) return;
      if (oralEngaged) return;
      const near = cockNearAvatar();
      if (!near) return;
      flickSpent = true;
      flickBusyUntil = win.performance.now() + 1560;
      const hand = flickHand || doc.createElement("img");
      hand.src = "/assets/transferina-hand.png";
      if (!flickHand) {
        flickHand = hand;
        hand.className = "hq-flick-hand";
        hand.alt = "";
        hand.draggable = false;
        hand.setAttribute("aria-hidden", "true");
        doc.body.appendChild(hand);
      }
      const av = doc.querySelector(".hq-companion-avatar").getBoundingClientRect();
      const w = 78;
      const h = w * (352 / 976);
      const ox = w * 0.88;
      const oy = h * 0.5;
      const palmLocal = { x: -0.36 * w, y: 0.14 * h };
      const cx = av.left + av.width * 0.5;
      const cy = av.top + av.height * 0.42;
      let ux = near.at.x - cx;
      let uy = near.at.y - cy;
      const span = Math.hypot(ux, uy) || 1;
      ux /= span;
      uy /= span;
      const girth = Math.max(18, mountRectW * 0.42);
      const lean = clamp(ux * 14, -8, 8);
      const slapDeg = 90 + lean;
      const windDeg = slapDeg + 28;
      const skin = {
        x: near.at.x - ux * girth * 0.42,
        y: near.at.y - uy * girth * 0.42,
      };
      const palmOffset = (deg) => {
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const lx = palmLocal.x;
        const ly = palmLocal.y;
        return {
          x: lx * cos - ly * sin,
          y: lx * sin + ly * cos,
        };
      };
      const capFor = (deg) => {
        const p = palmOffset(deg);
        return { x: skin.x - p.x, y: skin.y - p.y };
      };
      const landed = capFor(slapDeg);
      const start = {
        x: cx + ux * Math.min(av.width * 0.2, 28),
        y: cy + uy * Math.min(av.height * 0.12, 16),
      };
      const ctrl = {
        x: (start.x + landed.x) * 0.5 - uy * 22,
        y: (start.y + landed.y) * 0.5 + ux * 22,
      };
      const bez = (t, a, c, e) => {
        const u = 1 - t;
        return u * u * a + 2 * u * t * c + t * t * e;
      };
      hand.style.width = w + "px";
      hand.style.left = start.x - ox + "px";
      hand.style.top = start.y - oy + "px";
      const dirX = ux;
      const dirY = uy;
      let contacted = false;
      let contactU = 1;
      let holdX = start.x;
      let holdY = start.y;
      let holdRot = slapDeg;
      let baseLeft = 0;
      let baseTop = 0;
      const t0 = win.performance.now();
      const dur = 1500;
      let flickTrail = null;
      let flickLastSpawn = 0;
      const flickParticles = calm(win)
        ? null
        : {
            spawn(x, y, vx, vy, strength) {
              const sp = Math.hypot(vx, vy) || 1;
              const nx = vx / sp;
              const ny = vy / sp;
              const px = x - nx * (10 + strength * 8);
              const py = y - ny * (10 + strength * 8);
              const el = doc.createElement("span");
              el.className = "hq-flick-particle";
              el.setAttribute("aria-hidden", "true");
              el.style.left = px + "px";
              el.style.top = py + "px";
              el.style.width = 5 + strength * 16 + "px";
              el.style.setProperty("--hq-flick-rot", (Math.atan2(vy, vx) * 180) / Math.PI + "deg");
              el.style.setProperty("--hq-flick-dx", (-nx * (6 + strength * 5)).toFixed(1) + "px");
              el.style.setProperty("--hq-flick-dy", (-ny * (6 + strength * 5)).toFixed(1) + "px");
              doc.body.appendChild(el);
              win.setTimeout(() => el.remove(), 460);
            },
            follow(capX, capY, rot, now) {
              if (!flickTrail) {
                flickTrail = { x: capX, y: capY, t: now };
                return;
              }
              const dt = Math.max(0.008, (now - flickTrail.t) / 1000);
              const vx = (capX - flickTrail.x) / dt;
              const vy = (capY - flickTrail.y) / dt;
              flickTrail = { x: capX, y: capY, t: now };
              const speed = Math.hypot(vx, vy);
              if (speed < 140 || now - flickLastSpawn < 26) return;
              flickLastSpawn = now;
              const palm = palmOffset(rot);
              const px = capX + palm.x * 0.42;
              const py = capY + palm.y * 0.42;
              const strength = clamp(speed / 820, 0.28, 0.95);
              this.spawn(px, py, vx, vy, strength);
              if (speed > 360 && Math.random() < 0.45) this.spawn(px, py, vx, vy, strength * 0.72);
            },
          };
      const paint = (capX, capY, deg, op) => {
        hand.style.opacity = String(op);
        hand.style.transform =
          "translate(" +
          (capX - start.x).toFixed(1) +
          "px, " +
          (capY - start.y).toFixed(1) +
          "px) rotate(" +
          deg.toFixed(1) +
          "deg)";
      };
      const frame = (now) => {
        const u = Math.min(1, (now - t0) / dur);
        if (!contacted) {
          const raw = u < 0.14 ? 0 : Math.min(1, (u - 0.14) / 0.36);
          const along = 1 - (1 - raw) * (1 - raw);
          const rot = windDeg + along * (slapDeg - windDeg);
          let capX = bez(along, start.x, ctrl.x, landed.x);
          let capY = bez(along, start.y, ctrl.y, landed.y);
          const palm = palmOffset(rot);
          const palmX = capX + palm.x;
          const palmY = capY + palm.y;
          if (along > 0.72 && Math.hypot(palmX - skin.x, palmY - skin.y) < 22) {
            const planted = capFor(rot);
            capX = planted.x;
            capY = planted.y;
            contacted = true;
            contactU = u;
            holdX = capX;
            holdY = capY;
            holdRot = rot;
            const box = mount.getBoundingClientRect();
            baseLeft = box.left;
            baseTop = box.top;
            flickLean = near.at.x < cx ? -1.8 : 1.8;
            jiggle = 1;
            jigglePhase = 0;
            jiggleTransferina();
            playSlap();
            win.setTimeout(playJiggle, 180);
            contactAim = null;
            restName = "";
            restAnchor = null;
            ensureTick();
          }
          paint(capX, capY, rot, u < 0.12 ? u / 0.12 : 1);
          if (flickParticles && raw > 0.05) flickParticles.follow(capX, capY, rot, now);
        } else {
          const k = clamp((u - contactU) / 0.3, 0, 1);
          const ease = 1 - (1 - k) * (1 - k);
          const travel = ease * 52;
          place(baseLeft + dirX * travel, baseTop + dirY * travel);
          const capX = holdX + dirX * travel;
          const capY = holdY + dirY * travel;
          const rot = holdRot;
          const fade = clamp((u - contactU - 0.3) / 0.22, 0, 1);
          paint(capX, capY, rot, 1 - fade);
          if (flickParticles && k < 0.85) flickParticles.follow(capX, capY, rot, now);
        }
        if (u < 1) win.requestAnimationFrame(frame);
      };
      win.requestAnimationFrame(frame);
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

    // Idle shimmer loop. Full frame rate whenever anything is in motion
    // (sim running, pointer/oral engagement, resting on the avatar, throb/nod,
    // warmth/give settling);
    // ~15 fps when only the glisten is left; parked while the tab is hidden
    // or the mount is not on screen, and woken by ensureTick/visibility/IO.
    const GLISTEN_IDLE_MS = 60;
    let glistenOn = false;
    let glistenFrame = false;
    let glistenTimer = 0;
    let glistenLast = 0;
    let glistenSeen = true;
    function glistenBusy() {
      return (
        running ||
        dragging ||
        ptr.active ||
        oralEngaged ||
        oralPhase !== "idle" ||
        oralDepthSm > 0.01 ||
        !!restName ||
        throbStart >= 0 ||
        nodStart >= 0 ||
        warmth > 0 ||
        Math.abs(give) > 0.0005 ||
        Math.abs(giveVel) > 0.0005
      );
    }
    function glistenQueue() {
      if (glistenFrame) return;
      glistenFrame = true;
      win.requestAnimationFrame(glistenLoop);
    }
    function glistenLoop(t) {
      glistenFrame = false;
      if (!glistenOn) return;
      if (doc.hidden) {
        glistenOn = false;
        return;
      }
      if (!glistenBusy()) {
        if (!glistenSeen) {
          glistenOn = false;
          return;
        }
        const throbIn = nextThrobAt ? nextThrobAt - win.performance.now() : Infinity;
        const wait = Math.min(GLISTEN_IDLE_MS - (t - glistenLast), throbIn - 24);
        if (glistenLast && wait > 4) {
          glistenTimer = win.setTimeout(() => {
            glistenTimer = 0;
            glistenQueue();
          }, wait);
          return;
        }
      }
      glistenLast = t;
      updateThrob(t);
      followRest();
      if (!running) updateBodyFeel(t, !!restName, restName ? 14 : 0, restName);
      if (running || doc.hidden || !cw) {
        glistenQueue();
        return;
      }
      if (restName || oralEngaged || throbNow > 0.01 || nodNow > 0.01) renderCurve();
      else renderFlat();
      paintGlisten(t);
      glistenQueue();
    }
    function wakeGlisten() {
      if (!ctx) return;
      if (glistenTimer) {
        win.clearTimeout(glistenTimer);
        glistenTimer = 0;
      }
      glistenOn = true;
      glistenQueue();
    }
    function startGlisten() {
      if (glistenOn || !ctx) return;
      wakeGlisten();
    }
    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden) wakeGlisten();
    });
    if (typeof win.IntersectionObserver === "function") {
      new win.IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        glistenSeen = !last || last.isIntersecting;
        if (glistenSeen) wakeGlisten();
      }).observe(mount);
    }

    function ensureTick() {
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
      canvas.width = bufW;
      canvas.height = bufH;
      canvas.style.setProperty("--dangle-cw", String(cw));
      canvas.style.setProperty("--dangle-pad", String(padX));
      canvas.style.setProperty("--dangle-pad-y", String(padY));
      canvas.style.setProperty("--dangle-buf-w", String(bufW));
      if (!ctx) {
        ctx = canvas.getContext("2d", { alpha: true });
        if (ctx) ctx.imageSmoothingEnabled = true;
      }
      mount.classList.add("is-softbody");
      bakeSource();
      resizePending = false;
      dirty = true;
      if (!running) {
        renderFlat();
        paintGlisten(win.performance.now());
      }
      startGlisten();
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
          vel = clamp(vel, -5.5, 5.5);
          hangLean = 0;
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

  return { initDanglingMember, calm };
});
