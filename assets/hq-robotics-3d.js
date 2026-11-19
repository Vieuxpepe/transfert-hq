/* Robotique · 3D view. A small orthographic renderer on a 2D canvas: no library, no WebGL.
   Display only. The geometry mirrors hq_robotics_arm.py (position / link_positions); the server
   remains the authority for every move. Shapes are simple solids sized like the RoArm-M2-S and
   sorted back to front (painter's algorithm), which is exact enough for a handful of convex parts. */
(() => {
  'use strict';

  const UPPER = Math.hypot(236.82, 30), LOWER = Math.hypot(280.15, 1.73), OFFSET = Math.atan2(30, 236.82);
  // Height of the shoulder axis above the table. Indicative only: the firmware frame starts at the shoulder.
  const BASE_HEIGHT = 115;
  const rad = degrees => degrees * Math.PI / 180;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  const deg = radians => radians * 180 / Math.PI;
  // Inverse kinematics of the gripper reference point, same branch as hq_robotics_arm.cartesian.
  // Returns null when the point is out of reach; the server still validates limits and the envelope.
  function ik(x, y, z, hand) {
    const r = Math.hypot(x, y);
    const c = (r * r + z * z - UPPER * UPPER - LOWER * LOWER) / (2 * UPPER * LOWER);
    if (!(c > -1 && c < 1)) return null;
    const delta = Math.acos(c);
    const shoulder = Math.atan2(r, z) - Math.atan2(LOWER * Math.sin(delta), UPPER + LOWER * c) - OFFSET;
    return { base: deg(Math.atan2(y, x)), shoulder: deg(shoulder), elbow: deg(delta + OFFSET), hand };
  }

  // Leg shapes, mirrored from hq_robotics_assistant.leg_curve (display; the server generates the real poses).
  const SAMPLE_MM = 12, MAX_SAMPLES = 40;
  function legCurve(kind, a, b, { via, before, after, turns = 0 } = {}) {
    if (kind === 'linear') return { curve: t => add(a, mul(sub(b, a), t)), length: Math.hypot(...sub(b, a)) };
    if (kind === 'arc') {
      if (!via) return null;
      const u = sub(b, a), w = sub(via, a);
      const normal = cross(u, w);
      const area = dot(normal, normal);
      const chord = Math.hypot(...u);
      if (chord < 1 || Math.sqrt(area) / chord < 2) return null;
      const center = add(a, mul(cross(sub(mul(w, dot(u, u)), mul(u, dot(w, w))), normal), 1 / (2 * area)));
      const radius = Math.hypot(...sub(a, center));
      const e1 = mul(sub(a, center), 1 / radius);
      const e2 = cross(mul(normal, 1 / Math.sqrt(area)), e1);
      const tau = Math.PI * 2;
      const angle = p => ((Math.atan2(dot(sub(p, center), e2), dot(sub(p, center), e1)) % tau) + tau) % tau;
      const through = angle(via), end = angle(b);
      let sweep = through <= end ? end : end - tau;
      sweep += Math.sign(sweep) * tau * (turns ? 1 : 0);
      return { curve: t => add(center, add(mul(e1, radius * Math.cos(sweep * t)), mul(e2, radius * Math.sin(sweep * t)))),
        length: Math.abs(sweep) * radius, center };
    }
    if (kind === 'smooth') {
      const p0 = before || a, p3 = after || b;
      const curve = t => [0, 1, 2].map(k => .5 * (2 * a[k] + (-p0[k] + b[k]) * t + (2 * p0[k] - 5 * a[k] + 4 * b[k] - p3[k]) * t * t
        + (-p0[k] + 3 * a[k] - 3 * b[k] + p3[k]) * t ** 3));
      let length = 0;
      for (let i = 0; i < 24; i++) length += Math.hypot(...sub(curve((i + 1) / 24), curve(i / 24)));
      return { curve, length };
    }
    return null;
  }

  // Gripper path and poses of an editor plan: points (poses) and legs ({type, via, turns}; legs[0] unused).
  // A joint leg's path is sampled from the joint interpolation, which is what the arm really does.
  function planPath(points, legs) {
    const tips = points.map(pose => links(pose).tcp);
    const segments = [], poses = [];
    for (let i = 1; i < points.length; i++) {
      const spec = legs?.[i] || { type: 'joint' };
      const a = points[i - 1], b = points[i];
      const path = [tips[i - 1]];
      let ok = true;
      if (spec.type === 'joint') {
        for (let k = 1; k <= 12; k++) {
          const t = k / 12;
          path.push(links(Object.fromEntries(['base', 'shoulder', 'elbow', 'hand'].map(key => [key, a[key] + (b[key] - a[key]) * t]))).tcp);
        }
        poses.push(b);
      } else {
        const shape = legCurve(spec.type, tips[i - 1], tips[i], {
          via: spec.via ? [spec.via.x, spec.via.y, spec.via.z] : null,
          before: i >= 2 ? tips[i - 2] : null, after: i + 1 < tips.length ? tips[i + 1] : null, turns: spec.turns,
        });
        if (!shape) { ok = false; path.push(tips[i]); poses.push(b); }
        else {
          const samples = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(shape.length / SAMPLE_MM)));
          for (let k = 1; k < samples; k++) {
            const t = k / samples;
            const p = shape.curve(t);
            path.push(p);
            const pose = ik(p[0], p[1], p[2], a.hand + (b.hand - a.hand) * t);
            if (pose) poses.push(pose); else ok = false;
          }
          path.push(tips[i]);
          poses.push(b);
        }
      }
      segments.push({ index: i, path, ok, via: spec.type === 'arc' && spec.via ? [spec.via.x, spec.via.y, spec.via.z] : null });
    }
    return { segments, poses };
  }

  // Indicative whole-arm overlap test with the same shapes and radii as hq_robotics_arm._pose_link_clearance:
  // 22 mm tubes, a 34 mm gripper over the last 62 mm of the forearm, a 50 mm shoulder. Used to warn that a
  // zone touches the arm where it stands; the server's swept-volume check stays the authority.
  const TUBE = 22, GRIP = 34, GRIP_LEN = 62, SHOULDER_R = 50;
  const boxGap = (p, zone) => Math.hypot(...[0, 1, 2].map(k => {
    const [lo, hi] = zone['xyz'[k]];
    return Math.max(lo - p[k], 0, p[k] - hi);
  }));
  function touches(pose, zone) {
    const L = links(pose);
    const origin = [0, 0, 0];
    const along = (a, b, radius) => {
      for (let i = 0; i <= 24; i++) if (boxGap(add(a, mul(sub(b, a), i / 24)), zone) <= radius) return true;
      return false;
    };
    const fore = sub(L.tcp, L.elbow);
    const length = Math.hypot(...fore) || 1;
    const wrist = sub(L.tcp, mul(fore, Math.min(GRIP_LEN, length) / length));
    return boxGap(origin, zone) <= SHOULDER_R || along(origin, L.elbow, TUBE) || along(L.elbow, L.tcp, TUBE)
      || along(wrist, L.tcp, GRIP);
  }

  // Exact closest clearance vector between the arm's 3D capsules and any keep-out box.
  function closestClearance(pose, zones) {
    if (!pose || !Array.isArray(zones) || !zones.length) return null;
    const L = links(pose);
    const origin = [0, 0, 0];
    const fore = sub(L.tcp, L.elbow);
    const length = Math.hypot(...fore) || 1;
    const wrist = sub(L.tcp, mul(fore, Math.min(GRIP_LEN, length) / length));
    const clampBox = (p, z) => [0, 1, 2].map(k => {
      const [lo, hi] = z['xyz'[k]];
      return Math.min(hi, Math.max(lo, p[k]));
    });
    let best = null;
    const checkPoint = (pt, radius, part) => {
      for (const z of zones) {
        const boxPt = clampBox(pt, z);
        const dist = Math.hypot(...sub(pt, boxPt));
        const gap = dist - radius;
        if (!best || gap < best.gap) {
          const dir = dist > 1e-4 ? mul(sub(boxPt, pt), 1 / dist) : [0, 0, 1];
          best = {
            gap,
            armPt: add(pt, mul(dir, Math.min(radius, dist))),
            zonePt: boxPt,
            zoneName: z.name || 'Zone',
            part,
          };
        }
      }
    };
    checkPoint(origin, SHOULDER_R, 'Épaule');
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      checkPoint(add(origin, mul(sub(L.elbow, origin), t)), TUBE, 'Bras');
      checkPoint(add(L.elbow, mul(sub(L.tcp, L.elbow), t)), TUBE, 'Avant-bras');
      checkPoint(add(wrist, mul(sub(L.tcp, wrist), t)), GRIP, 'Pince');
    }
    return best;
  }

  const VIEWS = {
    iso: { yaw: rad(-45), pitch: rad(35.264) },
    front: { yaw: 0, pitch: 0 },
    side: { yaw: rad(-90), pitch: 0 },
    top: { yaw: rad(-90), pitch: rad(89.9) },
  };

  function links(pose) {
    const b = rad(pose.base), s = rad(pose.shoulder), e = rad(pose.elbow);
    const re = UPPER * Math.sin(s + OFFSET), ze = UPPER * Math.cos(s + OFFSET);
    const rt = re + LOWER * Math.sin(s + e), zt = ze + LOWER * Math.cos(s + e);
    const dir = [Math.cos(b), Math.sin(b), 0];
    return { base: b, dir, elbow: [re * dir[0], re * dir[1], ze], tcp: [rt * dir[0], rt * dir[1], zt] };
  }

  // ---- primitives: each returns faces {pts:[[x,y,z]...], n:[nx,ny,nz]}
  function box(center, ax, ay, az) {
    const c = (sx, sy, sz) => add(add(add(center, mul(ax, sx)), mul(ay, sy)), mul(az, sz));
    const faces = [];
    const side = (axis, sign, a, b) => {
      const corner = (i, j) => {
        const k = { x: 0, y: 0, z: 0 };
        k[axis] = sign; k[a] = i; k[b] = j;
        return c(k.x, k.y, k.z);
      };
      const vec = { x: ax, y: ay, z: az }[axis];
      faces.push({ pts: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], n: norm(mul(vec, sign)) });
    };
    side('x', 1, 'y', 'z'); side('x', -1, 'y', 'z');
    side('y', 1, 'x', 'z'); side('y', -1, 'x', 'z');
    side('z', 1, 'x', 'y'); side('z', -1, 'x', 'y');
    return faces;
  }

  // A segment from a to b as a box: `lateral` is the hinge axis, the other side follows.
  function beam(a, b, lateral, width, thickness) {
    const along = sub(b, a);
    const length = Math.hypot(...along);
    if (length < 1e-6) return [];
    const u = norm(along);
    const w = norm(lateral);
    const v = norm(cross(u, w));
    return box(mul(add(a, b), .5), mul(u, length / 2), mul(w, width / 2), mul(v, thickness / 2));
  }

  function prism(center, axis, radius, length, sides = 18) {
    const w = norm(axis);
    const helper = Math.abs(w[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(w, helper));
    const v = cross(w, u);
    const top = add(center, mul(w, length / 2));
    const bottom = add(center, mul(w, -length / 2));
    const ring = (origin, i) => {
      const t = i / sides * Math.PI * 2;
      return add(origin, add(mul(u, Math.cos(t) * radius), mul(v, Math.sin(t) * radius)));
    };
    const faces = [];
    const capTop = [], capBottom = [];
    for (let i = 0; i < sides; i++) {
      const t = (i + .5) / sides * Math.PI * 2;
      faces.push({ pts: [ring(bottom, i), ring(bottom, i + 1), ring(top, i + 1), ring(top, i)],
        n: norm(add(mul(u, Math.cos(t)), mul(v, Math.sin(t)))) });
      capTop.push(ring(top, i));
      capBottom.push(ring(bottom, sides - i));
    }
    faces.push({ pts: capTop, n: w }, { pts: capBottom, n: mul(w, -1) });
    return faces;
  }

  // The full assembly for one pose, as tagged faces.
  function armFaces(pose, { holding = false } = {}) {
    const L = links(pose);
    const lateral = [-L.dir[1], L.dir[0], 0];
    const parts = [];
    const push = (faces, tone, joint = null) => faces.forEach(face => parts.push({ ...face, tone, joint }));
    // Stepped base pedestal + mounting flange + rotary turret
    push(prism([0, 0, -BASE_HEIGHT + 7], [0, 0, 1], 84, 14, 24), 'base', 'base');
    push(prism([0, 0, -BASE_HEIGHT + 18], [0, 0, 1], 66, 10, 24), 'joint', 'base');
    push(prism([0, 0, -BASE_HEIGHT / 2 + 6], [0, 0, 1], 52, BASE_HEIGHT - 30, 22), 'turret', 'base');
    push(prism([0, 0, -18], [0, 0, 1], 56, 8, 22), 'accent', 'base');
    // Turret directional nose & status fin
    push(box(add(mul(L.dir, 50), [0, 0, -BASE_HEIGHT / 2 + 10]), mul(L.dir, 12), mul(lateral, 16), [0, 0, 24]), 'accent', 'base');
    // Twin-cheek shoulder yoke & servo motor drum
    push(box([0, 0, 0], mul(L.dir, 30), mul(lateral, 40), [0, 0, 32]), 'joint', 'shoulder');
    push(prism([0, 0, 0], lateral, 28, 86, 20), 'joint', 'shoulder');
    push(prism([0, 0, 0], lateral, 18, 92, 16), 'accent', 'shoulder');
    // Upper arm: structural side rails + central anodized web
    const upVec = sub(L.elbow, [0, 0, 0]);
    const upDir = norm(upVec);
    push(beam([0, 0, 0], L.elbow, lateral, 48, 28), 'link', 'shoulder');
    push(beam(add(mul(upDir, 28), mul(lateral, 25)), add(sub(L.elbow, mul(upDir, 24)), mul(lateral, 25)), lateral, 4, 16), 'rib', 'shoulder');
    push(beam(add(mul(upDir, 28), mul(lateral, -25)), add(sub(L.elbow, mul(upDir, 24)), mul(lateral, -25)), lateral, 4, 16), 'rib', 'shoulder');
    // Elbow servo drum & hub cap
    push(prism(L.elbow, lateral, 22, 64, 20), 'joint', 'elbow');
    push(prism(L.elbow, lateral, 13, 70, 16), 'accent', 'elbow');
    // Forearm stops short of the gripper housing.
    const fore = norm(sub(L.tcp, L.elbow));
    const wrist = sub(L.tcp, mul(fore, 62));
    push(beam(L.elbow, wrist, lateral, 36, 25), 'link', 'elbow');
    push(beam(add(L.elbow, mul(fore, 22)), sub(wrist, mul(fore, 14)), lateral, 40, 11), 'rib', 'elbow');
    // Wrist servo housing & collar
    push(box(add(wrist, mul(fore, 10)), mul(fore, 13), mul(lateral, 31), mul(norm(cross(fore, lateral)), 18)), 'joint', 'hand');
    push(box(add(wrist, mul(fore, 21)), mul(fore, 4), mul(lateral, 34), mul(norm(cross(fore, lateral)), 14)), 'accent', 'hand');
    // Gripper: 180° is closed (Waveshare convention); lower angles open the fingers.
    const opening = Math.min(1, Math.max(0, (180 - pose.hand) / 110));
    const gap = 4 + opening * 52;
    const normal = norm(cross(fore, lateral));
    for (const sign of [-1, 1]) {
      const finger = add(add(wrist, mul(fore, 36)), mul(lateral, sign * (gap / 2 + 4)));
      push(box(finger, mul(fore, 26), mul(lateral, 4.2), mul(normal, 11)), 'finger', 'hand');
      const pad = add(add(wrist, mul(fore, 52)), mul(lateral, sign * (gap / 2 + 1.8)));
      push(box(pad, mul(fore, 9), mul(lateral, 2), mul(normal, 9)), 'accent', 'hand');
    }
    // Held workpiece solid between the parallel jaws when holding an object or gripping tight
    if (holding) {
      const objCenter = add(wrist, mul(fore, 47));
      const halfWidth = Math.max(4, Math.min(24, gap * .44));
      push(box(objCenter, mul(fore, 11), mul(lateral, halfWidth), mul(normal, 12)), 'payload', 'hand');
    }
    return { parts, links: L };
  }

  class Space {
    constructor(canvas) {
      this.canvas = canvas;
      this.view = { ...VIEWS.iso };
      this.zoom = 1;
      this.scene = null;
      this.trail = [];
      this.pointers = new Map();
      this.jointNodes = [];
      this.hoveredJoint = null;
      this.downAt = null;
      this.frame = 0;
      const signal = (this.controller = new AbortController()).signal;
      const on = (type, fn, options = {}) => canvas.addEventListener(type, fn, { signal, ...options });
      on('pointerdown', event => {
        canvas.setPointerCapture(event.pointerId);
        const hit = this.pointers.size ? null : this.hitTest(event);
        if (hit?.kind === 'pick') { this.onpick?.(hit.index); return; }
        if (hit?.kind === 'zone-pick') { this.onpickzone?.(hit.index); return; }
        if (hit) {
          this.drag = { ...hit, id: event.pointerId, x0: event.clientX, y0: event.clientY };
          this.ondragstart?.(hit);
          return;
        }
        this.downAt = [event.clientX, event.clientY];
        this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
        canvas.style.cursor = 'grabbing';
      });
      on('pointermove', event => {
        if (this.drag && this.drag.id === event.pointerId) { this.dragMove(event); return; }
        const last = this.pointers.get(event.pointerId);
        if (!last) {
          const hit = this.hitTest(event);
          const rect = canvas.getBoundingClientRect();
          const mx = event.clientX - rect.left, my = event.clientY - rect.top;
          let found = null, bestD = 22;
          for (const jn of this.jointNodes || []) {
            const d = Math.hypot(jn.pt[0] - mx, jn.pt[1] - my);
            if (d < bestD) { bestD = d; found = jn; }
          }
          let cursor = 'grab';
          let hoverHint = 'Vue 3D : glisser pour orbiter · molette pour zoomer · double-clic pour Iso.';
          if (hit) {
            if (hit.kind === 'z' || hit.kind === 'zone-z') {
              cursor = 'ns-resize';
              hoverHint = 'Poignée verticale Z : glisser vers le haut ou le bas pour ajuster la hauteur (mm).';
            } else if (['plane', 'via', 'zone-move', 'zone-face'].includes(hit.kind)) {
              cursor = 'move';
              hoverHint = hit.kind === 'via'
                ? 'Point intermédiaire d’arc : glisser pour courber la trajectoire.'
                : 'Poignée 3D : glisser pour déplacer ou redimensionner dans le plan.';
            } else {
              cursor = 'pointer';
              hoverHint = hit.kind === 'pick'
                ? 'Point de trajectoire : cliquer pour le sélectionner et l’éditer.'
                : 'Zone d’exclusion : cliquer pour sélectionner cette boîte.';
            }
          } else if (found) {
            cursor = 'pointer';
            hoverHint = `${found.label} (${found.angle.toFixed(1)}°) : cliquer pour cibler directement son curseur dans Pilotage.`;
          }
          if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
          if (this.lastHoverHint !== hoverHint) {
            this.lastHoverHint = hoverHint;
            this.onhover?.(hoverHint);
          }
          if (found?.key !== this.hoveredJoint?.key) {
            this.hoveredJoint = found;
            this.request();
          }
          return;
        }
        const now = [event.clientX, event.clientY];
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const before = Math.hypot(a[0] - b[0], a[1] - b[1]);
          this.pointers.set(event.pointerId, now);
          const [c, d] = [...this.pointers.values()];
          const after = Math.hypot(c[0] - d[0], c[1] - d[1]);
          if (before > 0) this.setZoom(this.zoom * after / before);
          return;
        }
        this.pointers.set(event.pointerId, now);
        this.view.yaw -= (now[0] - last[0]) * .01;
        this.view.pitch = Math.min(rad(89.9), Math.max(rad(-10), this.view.pitch + (now[1] - last[1]) * .01));
        this.named = '';
        this.request();
        this.onview?.('');
      });
      on('pointerleave', () => {
        canvas.style.cursor = '';
        this.lastHoverHint = '';
        if (this.hoveredJoint) {
          this.hoveredJoint = null;
          this.request();
        }
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        on(type, event => {
          canvas.style.cursor = 'grab';
          if (type === 'pointerup' && this.downAt && Math.hypot(event.clientX - this.downAt[0], event.clientY - this.downAt[1]) < 6) {
            const rect = canvas.getBoundingClientRect();
            const mx = event.clientX - rect.left, my = event.clientY - rect.top;
            let clicked = null, bestD = 22;
            for (const jn of this.jointNodes || []) {
              const d = Math.hypot(jn.pt[0] - mx, jn.pt[1] - my);
              if (d < bestD) { bestD = d; clicked = jn; }
            }
            if (clicked) this.onjoint?.(clicked.key);
          }
          this.downAt = null;
          this.pointers.delete(event.pointerId);
          if (this.drag?.id === event.pointerId) { this.drag = null; this.ondragend?.(); }
        });
      }
      on('wheel', event => {
        event.preventDefault();
        this.setZoom(this.zoom * Math.exp(-event.deltaY * .0015));
      }, { passive: false });
      on('dblclick', () => this.setView('iso'));
      this.resize = new ResizeObserver(() => this.request());
      this.resize.observe(canvas);
    }

    destroy() {
      this.controller.abort();
      this.resize.disconnect();
      clearTimeout(this.pulseTimer);
      cancelAnimationFrame(this.frame);
    }

    // Editor: the selected point's ring moves it at constant height, its diamond moves it vertically,
    // and a click on another point selects it.
    hitTest(event) {
      if (!(this.scene?.compose || this.scene?.zoneEdit) || !this.basis) return null;
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const near = (pt, radius) => pt && Math.hypot(pt[0] - x, pt[1] - y) <= radius;
      let best = null, bestDistance = 14;
      for (const handle of this.handles || []) {
        const distance = Math.hypot(handle.pt[0] - x, handle.pt[1] - y);
        if (distance < bestDistance) { best = handle; bestDistance = distance; }
      }
      if (best) return best.kind === 'zone-pick' ? { kind: 'zone-pick', index: best.index } : best;
      for (const dot of this.dots || []) {
        if (near(dot.pt, 11)) return { kind: 'pick', index: dot.index };
      }
      return null;
    }

    dragMove(event) {
      const { right, up, scale } = this.basis;
      const dx = event.clientX - this.drag.x0, dy = event.clientY - this.drag.y0;
      const origin = this.drag.origin;
      let target;
      if (this.drag.kind.startsWith('zone')) {
        let delta = [0, 0, 0];
        if (this.drag.kind === 'zone-face') {
          const axis = [0, 0, 0];
          axis['xyz'.indexOf(this.drag.axis)] = 1;
          const sx = dot(axis, right) * scale, sy = -dot(axis, up) * scale;
          const per = sx * sx + sy * sy;
          if (per < (.2 * scale) ** 2) return;  // this axis points at the viewer
          delta = mul(axis, (dx * sx + dy * sy) / per);
        } else if (this.drag.kind === 'zone-z') {
          if (up[2] < .15) return;
          delta = [0, 0, -dy / (up[2] * scale)];
        } else {
          const flat = [up[0], up[1], 0];
          const length = Math.hypot(...flat);
          delta = mul(right, dx / scale);
          if (length > .15) delta = add(delta, mul(norm(flat), -dy / (length * scale)));
        }
        this.ondragzone?.(this.drag, { x: delta[0], y: delta[1], z: delta[2] });
        return;
      }
      if (this.drag.kind === 'via') {
        target = add(add(origin, mul(right, dx / scale)), mul(up, -dy / scale));
        this.ondrag?.(this.drag.index, { x: target[0], y: target[1], z: target[2] }, 'via');
        return;
      }
      if (this.drag.kind === 'z') {
        if (up[2] < .15) return;  // seen from above, height cannot be dragged
        target = [origin[0], origin[1], origin[2] - dy / (up[2] * scale)];
      } else {
        const flat = [up[0], up[1], 0];
        const length = Math.hypot(...flat);
        let move = mul(right, dx / scale);
        if (length > .15) move = add(move, mul(norm(flat), -dy / (length * scale)));
        target = add(origin, move);
      }
      this.ondrag?.(this.drag.index, { x: target[0], y: target[1], z: target[2] });
    }

    setZoom(value) {
      this.zoom = Math.min(4, Math.max(.4, value));
      this.lastActiveAt = performance.now();
      this.request();
    }

    setView(name) {
      if (!VIEWS[name]) return;
      this.view = { ...VIEWS[name] };
      this.zoom = 1;
      this.named = name;
      this.lastActiveAt = performance.now();
      this.request();
      this.onview?.(name);
    }

    // scene: { config, measured, target, playing, label }
    update(scene) {
      this.scene = scene;
      this.lastActiveAt = performance.now();
      const tip = scene.measured && !scene.playing ? links(scene.measured).tcp : null;
      if (tip) {
        const last = this.trail.at(-1);
        if (!last || Math.hypot(...sub(tip, last)) > 2) this.trail = [...this.trail.slice(-239), tip];
      }
      this.request();
    }

    clearTrail() {
      this.trail = [];
      this.lastActiveAt = performance.now();
      this.request();
    }

    request() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.draw());
    }

    draw() {
      const canvas = this.canvas;
      if (!canvas || canvas.offsetParent === null || !this.scene) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) [canvas.width, canvas.height] = pixels;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight') && !document.body.classList.contains('theme-oled');
      const P = light ? {
        grid: 'rgba(71, 100, 102, .2)', gridMinor: 'rgba(71, 100, 102, .08)', gridAxis: 'rgba(8, 114, 79, .45)',
        label: '#3c5b5d', envelope: 'rgba(43, 99, 199, .5)', arc: 'rgba(8, 114, 79, .6)',
        sector: 'rgba(8, 114, 79, .05)', shadow: 'rgba(15, 35, 42, .12)',
        trail: '#5a40af', trailGlow: 'rgba(90, 64, 175, .24)',
        zone: [200, 50, 75], tones: { base: [108, 124, 130], turret: [142, 158, 164], joint: [64, 78, 86],
          link: [218, 226, 230], rib: [164, 178, 184], accent: [10, 148, 118], finger: [54, 64, 72],
          payload: [245, 166, 35] },
        ghost: [43, 99, 199],
      } : {
        grid: 'rgba(134, 225, 205, .15)', gridMinor: 'rgba(134, 225, 205, .05)', gridAxis: 'rgba(115, 237, 206, .45)',
        label: '#99b8bc', envelope: 'rgba(159, 197, 255, .45)', arc: 'rgba(115, 237, 206, .58)',
        sector: 'rgba(115, 237, 206, .045)', shadow: 'rgba(0, 0, 0, .38)',
        trail: '#c9b8ff', trailGlow: 'rgba(201, 184, 255, .28)',
        zone: [255, 120, 145], tones: { base: [58, 74, 84], turret: [84, 102, 112], joint: [40, 50, 58],
          link: [198, 212, 220], rib: [112, 132, 144], accent: [115, 237, 206], finger: [122, 136, 146],
          payload: [255, 193, 118] },
        ghost: [159, 197, 255],
      };
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const { yaw, pitch } = this.view;
      const d = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
      const right = norm(cross([0, 0, 1], d));
      const up = cross(d, right);
      const lightDir = norm(add(add(d, mul(up, .85)), mul(right, -.4)));
      const rimDir = norm(add(mul(up, .55), mul(right, .7)));
      const config = this.scene.config;
      const ws = config.workspace;
      const floor = -BASE_HEIGHT;
      const center = [(ws.x[0] + ws.x[1]) / 2 * .55, 0, (floor + ws.z[1]) / 2];
      const radius = Math.max(ws.x[1], Math.abs(ws.y[0]), ws.y[1], ws.z[1] - floor) * .78;
      const scale = Math.min(width, height) / 2 / radius * this.zoom;
      const project = p => {
        const q = sub(p, center);
        return [width / 2 + dot(q, right) * scale, height / 2 - dot(q, up) * scale, dot(q, d)];
      };
      this.basis = { right, up, d, scale };
      this.handles = [];
      this.dots = [];

      // Subtle atmospheric spotlight centered on the pedestal floor
      const [bx0, by0] = project([0, 0, floor]);
      const spot = ctx.createRadialGradient(bx0, by0, 8, bx0, by0, Math.max(width, height) * .62);
      if (light) {
        spot.addColorStop(0, 'rgba(115, 237, 206, .12)');
        spot.addColorStop(.55, 'rgba(43, 99, 199, .03)');
        spot.addColorStop(1, 'rgba(238, 246, 245, 0)');
      } else {
        spot.addColorStop(0, 'rgba(17, 127, 108, .22)');
        spot.addColorStop(.5, 'rgba(15, 36, 48, .12)');
        spot.addColorStop(1, 'rgba(7, 17, 22, 0)');
      }
      ctx.fillStyle = spot;
      ctx.fillRect(0, 0, width, height);

      const line = (a, b, color, widthPx = 1, dash = []) => {
        const [ax, ay] = project(a), [bx, by] = project(b);
        ctx.strokeStyle = color;
        ctx.lineWidth = widthPx;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // Allowed base rotation sector & concentric reach rings on the floor
      const [bMin, bMax] = config.joint_limits.base.map(rad);
      ctx.fillStyle = P.sector;
      ctx.beginPath();
      ctx.moveTo(bx0, by0);
      for (let i = 0; i <= 48; i++) {
        const t = bMin + (bMax - bMin) * i / 48;
        const [x, y] = project([Math.cos(t) * 330, Math.sin(t) * 330, floor]);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();

      for (const ringR of [165, 330]) {
        ctx.strokeStyle = ringR === 330 ? P.arc : P.grid;
        ctx.lineWidth = ringR === 330 ? 1.8 : 1;
        if (ringR !== 330) ctx.setLineDash([3, 4]);
        ctx.beginPath();
        for (let i = 0; i <= 48; i++) {
          const t = bMin + (bMax - bMin) * i / 48;
          const [x, y] = project([Math.cos(t) * ringR, Math.sin(t) * ringR, floor]);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const t of [bMin, bMax]) line([0, 0, floor], [Math.cos(t) * 330, Math.sin(t) * 330, floor], P.arc, 1.1, [4, 4]);

      // Floor grid every 50 mm (minor) and 100 mm (major), with X/Y axes through the base.
      const extent = Math.ceil(Math.max(ws.x[1], Math.abs(ws.y[0]), ws.y[1]) / 100) * 100;
      for (let k = -extent; k <= extent; k += 50) {
        if (k % 100 === 0) continue;
        line([k, -extent, floor], [k, extent, floor], P.gridMinor, .7);
        line([-extent, k, floor], [extent, k, floor], P.gridMinor, .7);
      }
      for (let k = -extent; k <= extent; k += 100) {
        const isAxis = k === 0;
        line([k, -extent, floor], [k, extent, floor], isAxis ? P.gridAxis : P.grid, isAxis ? 1.4 : 1);
        line([-extent, k, floor], [extent, k, floor], isAxis ? P.gridAxis : P.grid, isAxis ? 1.4 : 1);
      }
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillStyle = P.label;
      for (const [text, p] of [['X', [extent + 30, 0, floor]], ['Y', [0, extent + 30, floor]], ['Z', [0, 0, ws.z[1] + 40]]]) {
        const [x, y] = project(p);
        ctx.fillText(text, x - 3, y + 3);
      }
      line([0, 0, floor], [0, 0, ws.z[1] + 25], P.gridAxis, 1, [3, 4]);

      // Ground shadow under the active pose (projected onto the floor plane)
      const shadowPose = this.scene.measured || this.scene.target;
      if (shadowPose) {
        const sLinks = links(shadowPose);
        const sPts = [[0, 0, floor], [sLinks.elbow[0], sLinks.elbow[1], floor], [sLinks.tcp[0], sLinks.tcp[1], floor]];
        ctx.save();
        ctx.strokeStyle = P.shadow;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(8, 28 * scale);
        ctx.beginPath();
        sPts.forEach((pt, idx) => { const [sx, sy] = project(pt); idx ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.stroke();
        // TCP drop plumb line to the floor
        const [tx, ty] = project(sLinks.tcp);
        const [fx, fy] = project([sLinks.tcp[0], sLinks.tcp[1], floor]);
        ctx.strokeStyle = P.arc;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(fx, fy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = P.arc;
        ctx.beginPath();
        ctx.arc(fx, fy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Workbench Floor Overlays: R×C Palletizer tray matrix & Pick A → Place B beacons
      const wb = this.scene.workbench;
      if (wb?.pallet) {
        const { rows = 2, cols = 3, x0 = 150, y0 = -60, dx = 35, dy = 45, z = 25, active = 0 } = wb.pallet;
        const hw = Math.max(10, Math.abs(dx) * .38);
        const hh = Math.max(10, Math.abs(dy) * .38);
        ctx.save();
        let slotIdx = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const colIdx = r % 2 === 1 ? (cols - 1 - c) : c;
            const cx = x0 + r * dx;
            const cy = y0 + colIdx * dy;
            const isAct = slotIdx === active;
            const isDone = slotIdx < active;
            const cornersSlot = [
              project([cx - hw, cy - hh, z]),
              project([cx + hw, cy - hh, z]),
              project([cx + hw, cy + hh, z]),
              project([cx - hw, cy + hh, z]),
            ];
            ctx.beginPath();
            cornersSlot.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
            ctx.closePath();
            ctx.fillStyle = isAct ? 'rgba(255, 193, 118, .26)' : isDone ? 'rgba(115, 237, 206, .14)' : 'rgba(159, 197, 255, .07)';
            ctx.fill();
            ctx.strokeStyle = isAct ? '#ffc176' : isDone ? 'rgba(115, 237, 206, .6)' : 'rgba(159, 197, 255, .32)';
            ctx.lineWidth = isAct ? 1.8 : 1;
            ctx.stroke();
            const [lx, ly] = project([cx, cy, z]);
            ctx.fillStyle = isAct ? '#ffc176' : (light ? '#3c5b5d' : '#99b8bc');
            ctx.font = `${isAct ? '700' : '600'} 8.5px ui-monospace, monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(`${r + 1}·${colIdx + 1}`, lx, ly + 3);
            slotIdx++;
          }
        }
        ctx.restore();
      }
      if (wb?.transfer) {
        const { ax, ay, bx, by, z = 20, safeZ = 125 } = wb.transfer;
        if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)) {
          ctx.save();
          for (const [tag, px, py, col] of [['A', ax, ay, '#73edce'], ['B', bx, by, '#ffc176']]) {
            const [sx, sy] = project([px, py, z]);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(sx, sy, 8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = col;
            ctx.font = '700 9.5px ui-monospace, monospace';
            ctx.fillText(tag, sx + 10, sy + 3);
          }
          // Parabolic safe-transit bridge between A and B
          ctx.strokeStyle = light ? 'rgba(43, 99, 199, .45)' : 'rgba(159, 197, 255, .45)';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          for (let i = 0; i <= 16; i++) {
            const u = i / 16;
            const ix = ax + (bx - ax) * u;
            const iy = ay + (by - ay) * u;
            const iz = z + (safeZ - z) * Math.sin(u * Math.PI);
            const [qx, qy] = project([ix, iy, iz]);
            i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }

      // Solids: the arm(s) and the no-go boxes, sorted back to front.
      const faces = [];
      const holdingObj = Boolean(this.scene.holding);
      const pushArm = (pose, mode, hold = false) => {
        if (!pose) return;
        for (const face of armFaces(pose, { holding: hold }).parts) faces.push({ ...face, mode });
      };
      const measured = this.scene.measured;
      const target = this.scene.target;
      const differs = measured && target && ['base', 'shoulder', 'elbow', 'hand']
        .some(key => Math.abs(measured[key] - target[key]) > .5);
      pushArm(measured, 'solid', holdingObj);
      if (!measured || differs) pushArm(target, measured ? 'ghost' : 'ghost-only', holdingObj);
      // Translucent ghost silhouette at the selected editor waypoint when composing a script
      const composeSelPose = this.scene.compose?.points?.[this.scene.compose?.selected];
      if (composeSelPose && (!target || ['base', 'shoulder', 'elbow', 'hand'].some(k => Math.abs(composeSelPose[k] - target[k]) > 1.5))) {
        pushArm(composeSelPose, 'ghost', composeSelPose.hand >= 122);
      }
      const zoneEdit = this.scene.zoneEdit;
      const zoneList = zoneEdit ? zoneEdit.zones : (config.keepout || []);
      for (const zone of zoneList) {
        const c = [(zone.x[0] + zone.x[1]) / 2, (zone.y[0] + zone.y[1]) / 2, (zone.z[0] + zone.z[1]) / 2];
        for (const face of box(c, [(zone.x[1] - zone.x[0]) / 2, 0, 0], [0, (zone.y[1] - zone.y[0]) / 2, 0],
          [0, 0, (zone.z[1] - zone.z[0]) / 2])) faces.push({ ...face, mode: 'zone', name: zone.name });
      }
      const drawn = [];
      for (const face of faces) {
        const facing = dot(face.n, d);
        if (face.mode === 'solid' && facing <= 0) continue;  // back faces of opaque parts
        const pts = face.pts.map(project);
        drawn.push({ face, pts, depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length, facing });
      }
      drawn.sort((a, b) => a.depth - b.depth);
      const loadsMap = this.scene.load || {};
      for (const { face, pts } of drawn) {
        const diffuse = Math.max(0, dot(face.n, lightDir));
        const rim = Math.max(0, dot(face.n, rimDir)) * .18;
        const spec = Math.pow(diffuse, 12) * (face.tone === 'accent' || face.tone === 'joint' || face.tone === 'payload' ? 32 : 16);
        const shade = .44 + .52 * diffuse + rim;
        let fill, stroke;
        if (face.mode === 'zone') {
          fill = `rgba(${P.zone.join(',')}, .13)`;
          stroke = `rgba(${P.zone.join(',')}, .62)`;
        } else if (face.mode === 'solid') {
          let [r, g, b] = P.tones[face.tone] || P.tones.link;
          // Live Servo Torque Heatmap on joint drums & collars
          if ((face.tone === 'joint' || face.tone === 'accent') && face.joint && Number.isFinite(loadsMap[face.joint])) {
            const ld = Math.abs(loadsMap[face.joint]);
            if (ld > 260) {
              const heat = Math.min(1, (ld - 260) / 540);
              const hr = ld > 620 ? 255 : 255;
              const hg = ld > 620 ? 96 : 188;
              const hb = ld > 620 ? 122 : 92;
              r = r * (1 - heat * .68) + hr * (heat * .68);
              g = g * (1 - heat * .68) + hg * (heat * .68);
              b = b * (1 - heat * .68) + hb * (heat * .68);
            }
          }
          const clamp = v => Math.min(255, Math.max(0, Math.round(v)));
          fill = `rgb(${clamp(r * shade + spec)}, ${clamp(g * shade + spec)}, ${clamp(b * shade + spec)})`;
          stroke = face.tone === 'payload' ? 'rgba(255, 215, 130, .82)'
            : face.tone === 'accent' ? 'rgba(115, 237, 206, .45)' : 'rgba(6, 14, 20, .34)';
        } else {
          fill = `rgba(${P.ghost.join(',')}, ${face.mode === 'ghost-only' ? .22 : .11})`;
          stroke = `rgba(${P.ghost.join(',')}, .45)`;
        }
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = face.mode === 'zone' ? 1 : .75;
        ctx.stroke();
      }
      // Floating mass badge & velocity vector on the active gripper TCP
      if (measured || target) {
        const actPose = measured || target;
        const actL = links(actPose);
        const [tx, ty] = project(actL.tcp);
        if (holdingObj || Number.isFinite(this.scene.payloadGrams) && this.scene.payloadGrams > 5) {
          const grams = Number.isFinite(this.scene.payloadGrams) && this.scene.payloadGrams > 0
            ? `≈ ${Math.round(this.scene.payloadGrams)} g` : 'Objet saisi';
          ctx.save();
          ctx.font = '700 9.5px ui-monospace, monospace';
          const bw = ctx.measureText(grams).width + 10;
          ctx.fillStyle = light ? 'rgba(255, 248, 235, .92)' : 'rgba(24, 18, 10, .88)';
          ctx.strokeStyle = '#ffc176';
          ctx.lineWidth = 1.2;
          ctx.fillRect(tx + 10, ty + 6, bw, 15);
          ctx.strokeRect(tx + 10, ty + 6, bw, 15);
          ctx.fillStyle = light ? '#a35a00' : '#ffc176';
          ctx.fillText(grams, tx + 15, ty + 16.5);
          ctx.restore();
        }
        if (this.trail.length >= 2) {
          const prevPt = this.trail[this.trail.length - 2];
          const curPt = this.trail[this.trail.length - 1];
          const v = sub(curPt, prevPt);
          const vLen = Math.hypot(v[0], v[1], v[2]);
          if (vLen > 1.5) {
            const vTip = add(actL.tcp, mul(norm(v), Math.min(65, 18 + vLen * 2.2)));
            const [vx, vy] = project(vTip);
            ctx.save();
            ctx.strokeStyle = '#73edce';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(vx, vy);
            ctx.stroke();
            ctx.fillStyle = '#73edce';
            ctx.beginPath();
            ctx.arc(vx, vy, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
      for (const zone of zoneList) {
        const [x, y] = project([zone.x[0], zone.y[1], zone.z[1]]);
        ctx.fillStyle = `rgb(${P.zone.join(',')})`;
        ctx.font = '600 9.5px ui-monospace, monospace';
        ctx.fillText(zone.name, x + 4, y - 5);
      }

      // Live minimum-clearance vector between the active pose and the nearest keep-out box.
      const clearancePose = target || measured;
      const cl = zoneList.length && clearancePose ? closestClearance(clearancePose, zoneList) : null;
      if (cl && cl.gap < 160) {
        const [ax, ay] = project(cl.armPt);
        const [zx, zy] = project(cl.zonePt);
        const bad = cl.gap <= 0;
        const warn = cl.gap < 45;
        const col = bad ? '#ff6b81' : warn ? (light ? '#a35a00' : '#ffc176') : (light ? '#08724f' : '#73edce');
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = bad ? 2.4 : 1.7;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(zx, zy);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const [px, py] of [[ax, ay], [zx, zy]]) {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(px, py, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        const mx = (ax + zx) / 2, my = (ay + zy) / 2 - 7;
        const tag = `${cl.part} ↔ ${cl.zoneName} · ${cl.gap <= 0 ? 'COLLISION' : Math.round(cl.gap) + ' mm'}`;
        ctx.font = '600 9px ui-monospace, monospace';
        const tw = ctx.measureText(tag).width + 8;
        ctx.fillStyle = light ? 'rgba(255, 255, 255, .88)' : 'rgba(9, 19, 25, .86)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.fillRect(mx - tw / 2, my - 9, tw, 13);
        ctx.strokeRect(mx - tw / 2, my - 9, tw, 13);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.fillText(tag, mx, my + .5);
        ctx.restore();
      }

      // XYZ envelope of the gripper point, as a dashed wireframe drawn over everything.
      const corners = [];
      for (const x of ws.x) for (const y of ws.y) for (const z of ws.z) corners.push([x, y, z]);
      for (let i = 0; i < 8; i++) {
        for (let j = i + 1; j < 8; j++) {
          const diff = [0, 1, 2].filter(k => corners[i][k] !== corners[j][k]).length;
          if (diff === 1) line(corners[i], corners[j], P.envelope, 1, [5, 4]);
        }
      }
      // Recent path of the gripper point with soft outer glow.
      const path = this.scene.playing ? this.scene.playTrail || [] : this.trail;
      if (path.length > 1) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = P.trailGlow;
        ctx.lineWidth = 6;
        ctx.beginPath();
        path.forEach((p, i) => { const [x, y] = project(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
        ctx.strokeStyle = P.trail;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.restore();
      }
      // Editor overlay: path through the gripper points, numbered dots, handles on the selected point.
      const compose = this.scene.compose;
      if (compose && compose.points.length) {
        const tips = compose.points.map(pose => links(pose).tcp);
        for (const segment of planPath(compose.points, compose.legs).segments) {
          const bad = compose.bad === segment.index || !segment.ok;
          const isShaped = compose.legs?.[segment.index]?.type && compose.legs[segment.index].type !== 'joint';
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if (!bad) {
            ctx.strokeStyle = light ? 'rgba(163, 90, 0, .18)' : 'rgba(255, 193, 118, .22)';
            ctx.lineWidth = 5.5;
            ctx.beginPath();
            segment.path.forEach((p, k) => { const [x, y] = project(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.stroke();
          }
          ctx.strokeStyle = bad ? '#ff6b81' : (light ? '#a35a00' : '#ffc176');
          ctx.lineWidth = bad ? 3 : 2.2;
          ctx.setLineDash(isShaped ? [] : [6, 4]);
          ctx.beginPath();
          segment.path.forEach((p, k) => { const [x, y] = project(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.stroke();
          ctx.setLineDash([]);
          // Directional flow chevron at segment midpoint
          if (segment.path.length >= 2) {
            const midIdx = Math.floor(segment.path.length / 2);
            const pA = project(segment.path[Math.max(0, midIdx - 1)]);
            const pB = project(segment.path[Math.min(segment.path.length - 1, midIdx)]);
            const dx = pB[0] - pA[0], dy = pB[1] - pA[1];
            const dLen = Math.hypot(dx, dy);
            if (dLen > 8) {
              const mx = (pA[0] + pB[0]) / 2, my = (pA[1] + pB[1]) / 2;
              const ang = Math.atan2(dy, dx);
              ctx.fillStyle = bad ? '#ff6b81' : (light ? '#a35a00' : '#ffc176');
              ctx.beginPath();
              ctx.moveTo(mx + Math.cos(ang) * 5, my + Math.sin(ang) * 5);
              ctx.lineTo(mx + Math.cos(ang + 2.45) * 5.5, my + Math.sin(ang + 2.45) * 5.5);
              ctx.lineTo(mx + Math.cos(ang - 2.45) * 5.5, my + Math.sin(ang - 2.45) * 5.5);
              ctx.closePath();
              ctx.fill();
            }
          }
          // Traveling holographic energy beads along valid planned 3D segments
          if (!bad && segment.path.length >= 2) {
            const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const phase = reduce ? .5 : ((performance.now() * .00065) % 1);
            for (const offset of [0, .5]) {
              const u = (phase + offset) % 1;
              const fIdx = u * (segment.path.length - 1);
              const i0 = Math.floor(fIdx);
              const i1 = Math.min(segment.path.length - 1, i0 + 1);
              const frac = fIdx - i0;
              const pt3 = [
                segment.path[i0][0] + (segment.path[i1][0] - segment.path[i0][0]) * frac,
                segment.path[i0][1] + (segment.path[i1][1] - segment.path[i0][1]) * frac,
                segment.path[i0][2] + (segment.path[i1][2] - segment.path[i0][2]) * frac,
              ];
              const [bx, by] = project(pt3);
              const glow = ctx.createRadialGradient(bx, by, .5, bx, by, 7.5);
              glow.addColorStop(0, light ? 'rgba(8, 114, 79, .95)' : 'rgba(115, 237, 206, .95)');
              glow.addColorStop(.5, light ? 'rgba(8, 114, 79, .35)' : 'rgba(115, 237, 206, .35)');
              glow.addColorStop(1, 'rgba(115, 237, 206, 0)');
              ctx.fillStyle = glow;
              ctx.beginPath();
              ctx.arc(bx, by, 7.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.restore();
          if (segment.via) {
            const [vx, vy] = project(segment.via);
            ctx.fillStyle = light ? '#2b63c7' : '#9fc5ff';
            ctx.strokeStyle = light ? '#ffffff' : '#0b171e';
            ctx.lineWidth = 1.5;
            ctx.fillRect(vx - 5, vy - 5, 10, 10);
            ctx.strokeRect(vx - 5, vy - 5, 10, 10);
            this.handles.push({ kind: 'via', index: segment.index, pt: [vx, vy], origin: segment.via });
          }
        }
        tips.forEach((tip, index) => {
          const [x, y] = project(tip);
          const selected = index === compose.selected;
          const legSpec = index > 0 ? compose.legs?.[index] : null;
          const dwellSec = Number(legSpec?.dwell) || 0;
          if (dwellSec > 0) {
            ctx.save();
            ctx.strokeStyle = light ? '#08724f' : '#73edce';
            ctx.lineWidth = 1.6;
            ctx.setLineDash([3, 2]);
            ctx.beginPath();
            ctx.arc(x, y, 10.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = light ? '#08724f' : '#73edce';
            ctx.font = '700 8.5px ui-monospace, monospace';
            ctx.fillText(`⏱${dwellSec.toFixed(1)}s`, x + 9, y + 11);
            ctx.restore();
          }
          ctx.fillStyle = selected ? '#ffc176' : (light ? '#5a4100' : '#ffe2b8');
          ctx.strokeStyle = light ? '#ffffff' : '#0b171e';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, selected ? 6.5 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = light ? '#3c2c00' : '#ffe2b8';
          ctx.font = '700 10px ui-monospace, monospace';
          ctx.fillText(index === 0 ? 'D' : String(index), x + 9, y - 6);
          this.dots.push({ index, pt: [x, y] });
          if (selected) {
            ctx.strokeStyle = '#ffc176';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 13, 0, Math.PI * 2);
            ctx.stroke();
            this.handles.push({ kind: 'plane', index, pt: [x, y], origin: tip });
            if (up[2] > .15) {
              const top = add(tip, [0, 0, 70]);
              line(tip, top, '#ffc176', 2);
              const [hx, hy] = project(top);
              ctx.fillStyle = '#ffc176';
              ctx.beginPath();
              ctx.moveTo(hx, hy - 7); ctx.lineTo(hx + 6, hy); ctx.lineTo(hx, hy + 7); ctx.lineTo(hx - 6, hy);
              ctx.closePath();
              ctx.fill();
              this.handles.push({ kind: 'z', index, pt: [hx, hy], origin: tip });
            }
          }
        });
      }
      // Zone editor: centre dots to pick, and on the selected box a move ring, a height diamond
      // and one square per face to resize it.
      if (zoneEdit) {
        zoneEdit.zones.forEach((zone, index) => {
          const center = ['x', 'y', 'z'].map(k => (zone[k][0] + zone[k][1]) / 2);
          const box = JSON.parse(JSON.stringify(zone));
          const [cx, cy] = project(center);
          const selected = index === zoneEdit.selected;
          ctx.fillStyle = selected ? '#ffc176' : `rgb(${P.zone.join(',')})`;
          ctx.beginPath();
          ctx.arc(cx, cy, selected ? 6 : 5, 0, Math.PI * 2);
          ctx.fill();
          if (!selected) { this.handles.push({ kind: 'zone-pick', index, pt: [cx, cy] }); return; }
          ctx.strokeStyle = '#ffc176';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 12, 0, Math.PI * 2);
          ctx.stroke();
          this.handles.push({ kind: 'zone-move', index, pt: [cx, cy], box });
          if (up[2] > .15) {
            const [tx, ty] = project([center[0], center[1], zone.z[1]]);
            const hx = tx, hy = Math.min(ty - 30, cy - 34);
            ctx.strokeStyle = '#ffc176';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
            ctx.fillStyle = '#ffc176';
            ctx.beginPath();
            ctx.moveTo(hx, hy - 7); ctx.lineTo(hx + 6, hy); ctx.lineTo(hx, hy + 7); ctx.lineTo(hx - 6, hy);
            ctx.closePath();
            ctx.fill();
            this.handles.push({ kind: 'zone-z', index, pt: [hx, hy], box });
          }
          ['x', 'y', 'z'].forEach((axis, k) => [0, 1].forEach(side => {
            const p = [...center];
            p[k] = zone[axis][side];
            const unit = [0, 0, 0];
            unit[k] = side ? 1 : -1;
            const sx = dot(unit, right), sy = -dot(unit, up);
            const length = Math.hypot(sx, sy);
            if (length < .2) return;  // this face points at the viewer: resize it from another view
            const [px, py] = project(p);
            const fx = px + sx / length * 18, fy = py + sy / length * 18;
            ctx.strokeStyle = light ? '#8e2035' : '#ffb3c0';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(fx, fy); ctx.stroke();
            ctx.fillStyle = light ? '#8e2035' : '#ffb3c0';
            ctx.fillRect(fx - 4, fy - 4, 8, 8);
            this.handles.push({ kind: 'zone-face', index, axis, side, pt: [fx, fy], box });
          }));
        });
      }
      // Small axis triad gizmo, bottom right, with subtle HUD disc.
      const gx = width - 36, gy = height - 32;
      ctx.fillStyle = light ? 'rgba(255, 255, 255, .68)' : 'rgba(11, 23, 30, .72)';
      ctx.strokeStyle = light ? 'rgba(71, 100, 102, .25)' : 'rgba(115, 237, 206, .22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(gx, gy, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const [vec, color, text] of [[[1, 0, 0], '#ff7a7a', 'X'], [[0, 1, 0], '#7adf8a', 'Y'], [[0, 0, 1], '#7aaeff', 'Z']]) {
        const ex = gx + dot(vec, right) * 16, ey = gy - dot(vec, up) * 16;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '700 8.5px ui-monospace, monospace';
        ctx.fillText(text, ex + 3, ey + 3);
      }
      // Interactive joint nodes & hover HUD callout (click a joint in 3D to jump to its axis slider).
      this.jointNodes = [];
      const inspectPose = this.scene.measured || this.scene.target;
      if (inspectPose) {
        const L = links(inspectPose);
        const loads = this.scene.load || {};
        this.jointNodes = [
          { key: 'base', label: 'Base', angle: inspectPose.base, load: loads.base, pt: project([0, 0, -BASE_HEIGHT * .45]) },
          { key: 'shoulder', label: 'Épaule', angle: inspectPose.shoulder, load: loads.shoulder, pt: project([0, 0, 0]) },
          { key: 'elbow', label: 'Coude', angle: inspectPose.elbow, load: loads.elbow, pt: project(L.elbow) },
          { key: 'hand', label: 'Pince', angle: inspectPose.hand, load: loads.hand, xyz: L.tcp, pt: project(L.tcp) },
        ];
        const hov = this.hoveredJoint && this.jointNodes.find(j => j.key === this.hoveredJoint.key);
        if (hov) {
          const [jx, jy] = hov.pt;
          ctx.save();
          ctx.strokeStyle = '#73edce';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(jx, jy, 12, 0, Math.PI * 2);
          ctx.stroke();
          const loadTxt = Number.isFinite(hov.load) ? ` · Charge ${Math.round(hov.load)}` : '';
          const xyzTxt = hov.xyz ? ` · X ${Math.round(hov.xyz[0])} Y ${Math.round(hov.xyz[1])} Z ${Math.round(hov.xyz[2])} mm` : '';
          const tag = `${hov.label} · ${hov.angle.toFixed(1)}°${loadTxt}${xyzTxt}`;
          ctx.font = '700 10.5px ui-monospace, monospace';
          const tw = ctx.measureText(tag).width + 14;
          const bx = Math.min(width - tw - 8, Math.max(8, jx - tw / 2));
          const by = Math.max(8, jy - 34);
          ctx.fillStyle = light ? 'rgba(255, 255, 255, .94)' : 'rgba(7, 17, 22, .92)';
          ctx.strokeStyle = '#73edce';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.roundRect(bx, by, tw, 20, 5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = light ? '#08724f' : '#73edce';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, bx + 7, by + 10.5);
          ctx.restore();
        }
      }
      clearTimeout(this.pulseTimer);
      if (canvas.offsetParent !== null && compose && compose.points.length >= 2 && !this.scene.playing &&
          !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        const hot = !!(this.scene.moving || this.drag || (performance.now() - (this.lastActiveAt || 0) < 4000));
        this.pulseTimer = setTimeout(() => this.request(), hot ? 34 : 220);
      }
    }
  }

  // Replays approved/visualised steps as joint interpolation. Nothing is sent anywhere.
  function playback(space, script, sceneBase, done) {
    const poses = [script.start, ...script.steps].filter(Boolean);
    if (poses.length < 2) { done?.(); return () => {}; }
    const baseSpeed = 45;  // degrees per second, for the picture only
    const planOwners = script.plan?.owners;
    const planLegs = script.plan?.legs;
    const legs = poses.slice(1).map((pose, i) => {
      const from = poses[i];
      const span = Math.max(...['base', 'shoulder', 'elbow', 'hand'].map(k => Math.abs(pose[k] - from[k])));
      const owner = Array.isArray(planOwners) ? planOwners[i] : (i + 1);
      const spec = (Array.isArray(planLegs) && owner >= 1 ? planLegs[owner - 1] : script.legs?.[i + 1]) || {};
      const pct = Math.max(25, Math.min(100, Number(spec.speed_pct) || 100));
      const isLastOfLeg = !Array.isArray(planOwners) || planOwners[i + 1] !== owner;
      const dwellMs = isLastOfLeg ? Math.max(0, Math.min(10000, (Number(spec.dwell) || 0) * 1000)) : 0;
      const moveMs = Math.max(250, span / (baseSpeed * pct / 100) * 1000);
      return { from, to: pose, moveMs, dwellMs, ms: moveMs + dwellMs };
    });
    const total = legs.reduce((sum, leg) => sum + leg.ms, 0);
    const trail = [];
    let start = 0, frame = 0, stopped = false;
    const tick = now => {
      if (stopped) return;
      if (!start) start = now;
      let t = now - start;
      let pose = poses.at(-1);
      for (const leg of legs) {
        if (t <= leg.ms) {
          const k = Math.min(1, t / leg.moveMs);
          const ease = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          pose = Object.fromEntries(['base', 'shoulder', 'elbow', 'hand'].map(key =>
            [key, leg.from[key] + (leg.to[key] - leg.from[key]) * ease]));
          break;
        }
        t -= leg.ms;
      }
      trail.push(links(pose).tcp);
      space.update({ ...sceneBase(), measured: pose, target: null, playing: true, playTrail: trail });
      if (now - start < total) frame = requestAnimationFrame(tick);
      else done?.();
    };
    frame = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }

  window.HqRobotics3D = { create: canvas => new Space(canvas), playback, links, ik, planPath, touches, closestClearance };
})();
