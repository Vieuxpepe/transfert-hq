/* Dessiner 3D preview: local WebGL depth buffer, canvas fallback. No CDN. */
(function (root) {
  "use strict";
  function viewer(canvas) {
    let gl = null, program = null, buffer = null, pos = null, col = null, wLoc = -1, clipLoc = null;
    const state = { triangles: [], edges: [], edgeMode: false, selectedEdge: -1, yaw: -0.72, pitch: 0.62, zoom: 1, panX: 0, panY: 0, selectedIndex: -1 };
    let onFace = null, onEdge = null;
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    const sub = (a, b) => a.map((x, i) => x - b[i]);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const unit = a => { const l = Math.hypot(...a); return l ? a.map(x => x / l) : null; };
    try { gl = canvas.getContext("webgl", { antialias: true, alpha: false }); } catch (_) {}
    if (gl) {
      const shader = (kind, source) => {
        const s = gl.createShader(kind); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      try {
        program = gl.createProgram();
        // w carries the model Z through to the fragment shader: the section plane cuts on it, in millimetres.
        gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec3 p; attribute vec3 c; attribute float w; varying vec3 v; varying float vw; void main(){gl_Position=vec4(p,1.0);v=c;vw=w;}"));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 v; varying float vw; uniform float uClip; void main(){if(vw>uClip) discard; gl_FragColor=vec4(v,1.0);}"));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        buffer = gl.createBuffer(); pos = gl.getAttribLocation(program, "p"); col = gl.getAttribLocation(program, "c");
        wLoc = gl.getAttribLocation(program, "w"); clipLoc = gl.getUniformLocation(program, "uClip");
      } catch (_) { gl = null; }
    }
    const ctx = gl ? null : canvas.getContext("2d");
    const edgeCanvas = document.createElement("canvas");
    edgeCanvas.className = "sk-3d-edge-overlay";
    edgeCanvas.setAttribute("aria-hidden", "true");
    canvas.parentNode.appendChild(edgeCanvas);
    const edgeCtx = edgeCanvas.getContext("2d");
    let pointers = new Map();
    function bounds() {
      if (state.frame) return state.frame; // a locked framing: the model can grow without the camera following
      const b = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (const tri of state.triangles) for (const p of tri) for (let i = 0; i < 3; i++) { b[0][i] = Math.min(b[0][i], p[i]); b[1][i] = Math.max(b[1][i], p[i]); }
      if (!state.triangles.length) return { center: [0, 0, 0], span: 1 };
      return { center: b[0].map((v, i) => (v + b[1][i]) / 2), span: Math.max(...b[0].map((v, i) => b[1][i] - v), 1e-6) };
    }
    function viewParams() {
      const { center, span } = bounds();
      const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw), cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
      const aspect = canvas.width / Math.max(1, canvas.height), scale = 1.42 * state.zoom / span;
      return { center, cy, sy, cp, sp, aspect, scale };
    }
    function projectPoint(p, q) {
      const { center, cy, sy, cp, sp, aspect, scale } = q || viewParams();
      const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
      const rx = cy * x - sy * y, ry = sy * x + cy * y;
      return [(rx * scale + state.panX) / Math.max(1, aspect), (cp * z - sp * ry) * scale + state.panY, -(cp * ry + sp * z) * scale / 3];
    }
    function geometry() {
      const { center, span } = bounds();
      const q = viewParams();
      const selected = state.triangles[state.selectedIndex];
      const selectedNormal = selected && unit(cross(sub(selected[1], selected[0]), sub(selected[2], selected[0])));
      return state.triangles.map((tri, index) => {
        const a = tri[0], b = tri[1], c = tri[2];
        const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const length = Math.hypot(...n) || 1;
        const light = Math.max(0.25, Math.min(0.95, 0.55 + (n[0] * 0.4 - n[1] * 0.3 + n[2] * 0.7) / length * 0.35));
        const samePlane = selectedNormal && dot(n.map(x => x / length), selectedNormal) > 0.99999 &&
          tri.every(p => Math.abs(dot(sub(p, selected[0]), selectedNormal)) < span * 1e-5);
        return { index, points: tri.map(p => projectPoint(p, q)), color: samePlane ? [0.05, 0.72, 0.40] : [0.06 + 0.18 * light, 0.23 + 0.55 * light, 0.31 + 0.55 * light] };
      });
    }
    function draw() {
      const rect = canvas.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const faces = geometry();
      if (gl) {
        gl.viewport(0, 0, w, h); gl.clearColor(0.93, 0.96, 0.98, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.useProgram(program);
        const data = new Float32Array(faces.length * 3 * 7);
        let at = 0;
        for (const face of faces) {
          const tri = state.triangles[face.index];
          for (let i = 0; i < 3; i++) { data.set(face.points[i], at); at += 3; data.set(face.color, at); at += 3; data[at++] = tri[i][2]; }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(pos); gl.enableVertexAttribArray(col);
        gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(col, 3, gl.FLOAT, false, 28, 12);
        if (wLoc >= 0) { gl.enableVertexAttribArray(wLoc); gl.vertexAttribPointer(wLoc, 1, gl.FLOAT, false, 28, 24); }
        if (clipLoc) gl.uniform1f(clipLoc, state.clip == null ? 1e9 : state.clip);
        gl.drawArrays(gl.TRIANGLES, 0, faces.length * 3);
      } else if (ctx) {
        ctx.fillStyle = "#edf4f8"; ctx.fillRect(0, 0, w, h);
        faces.sort((a, b) => b.points.reduce((s, p) => s + p[2], 0) - a.points.reduce((s, p) => s + p[2], 0));
        for (const face of faces) {
          const tri = state.triangles[face.index];
          if (state.clip != null && (tri[0][2] + tri[1][2] + tri[2][2]) / 3 > state.clip) continue;
          const pts = face.points.map(p => [(p[0] + 1) * w / 2, (1 - p[1]) * h / 2]);
          ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.lineTo(...pts[2]); ctx.closePath();
          ctx.fillStyle = `rgb(${face.color.map(v => Math.round(v * 255)).join(",")})`; ctx.fill();
        }
      }
      edgeCanvas.width = w; edgeCanvas.height = h;
      const q = viewParams();
      const stroke = (edge, color, width) => {
        const world = edgePoints(edge), clip = state.clip;
        edgeCtx.beginPath();
        let started = false;
        for (const p of world) {
          if (clip != null && p[2] > clip + 1e-9) { started = false; continue; }
          const pp = projectPoint(p, q), X = (pp[0] + 1) * w / 2, Y = (1 - pp[1]) * h / 2;
          if (started) edgeCtx.lineTo(X, Y); else { edgeCtx.moveTo(X, Y); started = true; }
        }
        edgeCtx.strokeStyle = color; edgeCtx.lineWidth = width; edgeCtx.lineCap = "round"; edgeCtx.lineJoin = "round"; edgeCtx.stroke();
      };
      if (state.edgeMode && state.showAll) state.edges.forEach(edge => stroke(edge, "rgba(15,40,50,.45)", Math.max(1, dpr)));
      if (state.edgeMode) (state.marked || []).forEach(i => { if (state.edges[i]) stroke(state.edges[i], "#f97316", Math.max(4, 4 * dpr)); });
      if (state.edgeMode && state.selectedEdge >= 0 && state.edges[state.selectedEdge]) stroke(state.edges[state.selectedEdge], "#f97316", Math.max(4, 4 * dpr));
      // a pending operation's shape: translucent, dashed, never part of the model
      for (const poly of state.ghost || []) {
        if (!poly || poly.length < 2) continue;
        edgeCtx.beginPath();
        poly.forEach((p, i) => { const pp = projectPoint(p, q), X = (pp[0] + 1) * w / 2, Y = (1 - pp[1]) * h / 2; if (i) edgeCtx.lineTo(X, Y); else edgeCtx.moveTo(X, Y); });
        edgeCtx.closePath();
        edgeCtx.fillStyle = "rgba(14,116,144,.13)"; edgeCtx.fill();
        edgeCtx.setLineDash([5 * dpr, 4 * dpr]);
        edgeCtx.strokeStyle = "rgba(14,116,144,.85)"; edgeCtx.lineWidth = Math.max(1, dpr); edgeCtx.stroke();
        edgeCtx.setLineDash([]);
      }
    }
    function faceAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = 2 * (clientX - rect.left) / rect.width - 1, y = 1 - 2 * (clientY - rect.top) / rect.height;
      let hit = null;
      for (const f of geometry()) {
        const [a, b, c] = f.points;
        const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(den) < 1e-12) continue;
        const w0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
        const w1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
        const w2 = 1 - w0 - w1;
        if (Math.min(w0, w1, w2) < -1e-6) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        if (!hit || z < hit.z) hit = { index: f.index, z, w: [w0, w1, w2] };
      }
      if (!hit) return null;
      const tri = state.triangles[hit.index], origin = tri[0];
      const normal = unit(cross(sub(tri[1], origin), sub(tri[2], origin)));
      if (!normal) return null;
      const point = [0, 1, 2].map(k => hit.w[0] * tri[0][k] + hit.w[1] * tri[1][k] + hit.w[2] * tri[2][k]);
      const ref = Math.abs(normal[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
      const u = unit(cross(ref, normal)), v = cross(normal, u);
      const plane = { origin: origin.slice(), u, v, normal };
      const tol = bounds().span * 1e-5;
      const triangles = state.triangles.filter(t => {
        const n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
        return n && dot(n, normal) > 0.99999 && t.every(p => Math.abs(dot(sub(p, origin), normal)) < tol);
      }).map(t => t.map(p => [dot(sub(p, origin), u), dot(sub(p, origin), v)]));
      return { index: hit.index, depth: hit.z, point: point, plane, triangles };
    }
    function edgeAt(clientX, clientY, pointerType) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      const front = faceAt(clientX, clientY);
      const threshold = pointerType === "touch" ? 22 : 13;
      const q = viewParams();
      let best = null;
      state.edges.forEach((edge, index) => {
        const pts = edgePoints(edge);  // a straight edge, or a curved one as a short polyline
        for (let s = 1; s < pts.length; s++) {
          const a = projectPoint(pts[s - 1], q), b = projectPoint(pts[s], q);
          const ax = (a[0] + 1) * rect.width / 2, ay = (1 - a[1]) * rect.height / 2;
          const bx = (b[0] + 1) * rect.width / 2, by = (1 - b[1]) * rect.height / 2;
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          if (len2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
          const dist = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
          const depth = a[2] + t * (b[2] - a[2]);
          if (dist > threshold || (front && depth > front.depth + 0.005)) continue;
          if (!best || dist < best.dist) best = { index, dist, edge };
        }
      });
      return best;
    }
    function edgePoints(edge) { return Array.isArray(edge.pts) && edge.pts.length > 1 ? edge.pts : [edge.a, edge.b]; }
    /** Several picked edges highlighted at once (fillet / chamfer on many edges); showAll draws every edge faintly. */
    function setMarked(indices, showAll) { state.marked = (indices || []).slice(); state.showAll = !!showAll; draw(); }
    function setTriangles(triangles) { state.triangles = triangles || []; state.selectedIndex = -1; state.selectedEdge = -1; draw(); }
    function setEdges(edges) { state.edges = edges || []; state.selectedEdge = -1; draw(); }
    function setEdgeMode(on) { state.edgeMode = !!on; state.selectedIndex = -1; state.selectedEdge = -1; draw(); }
    /** A pending operation's outline: closed loops of world points, drawn translucent under the edges. */
    function setGhost(polys) { state.ghost = polys || []; draw(); }
    /** Section plane: hide everything above `z` millimetres (null shows the whole part). */
    function setClip(z) { state.clip = Number.isFinite(z) ? z : null; draw(); }
    /** Standard views. Any face can then be squared with a double click (alignTo). */
    /** Where a world point sits on screen: lets a caller (tests, measuring) aim at a real edge or face. */
    function project(world) {
      const rect = canvas.getBoundingClientRect(), q = viewParams(), p = projectPoint(world, q);
      return { x: rect.left + (p[0] + 1) * rect.width / 2, y: rect.top + (1 - p[1]) * rect.height / 2 };
    }
    function setView(name) {
      const views = { iso: [-0.72, 0.62], face: [0, 0], back: [Math.PI, 0], right: [Math.PI / 2, 0], left: [-Math.PI / 2, 0], top: [0, Math.PI / 2 - 0.001] };
      const v = views[name] || views.iso;
      state.yaw = v[0]; state.pitch = v[1]; state.panX = 0; state.panY = 0; draw();
    }
    function fit() { state.zoom = 1; state.panX = 0; state.panY = 0; state.frame = null; draw(); }
    function zoomBy(factor) { const rect = canvas.getBoundingClientRect(); zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor); draw(); }
    /** Turn the camera to look squarely at a face (its normal points at the viewer). */
    function alignTo(normal) {
      const n = unit(normal || []);
      if (!n) return false;
      state.yaw = Math.atan2(n[0], n[1]);
      state.pitch = Math.max(-1.48, Math.min(1.48, Math.asin(Math.max(-1, Math.min(1, n[2])))));
      state.panX = 0; state.panY = 0; draw();
      return true;
    }
    /** Freeze the framing on the bounds of `triangles` (or release it with null), e.g. while an extrusion grows live. */
    function lockFrame(triangles) {
      state.frame = null;
      if (triangles && triangles.length) {
        const keep = state.triangles; state.triangles = triangles;
        state.frame = bounds();
        state.triangles = keep;
      }
      draw();
    }
    function reset() { state.yaw = -0.72; state.pitch = 0.62; state.zoom = 1; state.panX = 0; state.panY = 0; draw(); }
    // Pan is in screen space: a drag of (dx, dy) CSS px moves the projected model by exactly (dx, dy),
    // whatever the orbit or zoom. projectPoint divides x (pan included) by max(1, aspect) and maps clip
    // space to CSS px with the canvas rect, so the deltas are converted back the same way.
    function panBy(dx, dy) {
      const rect = canvas.getBoundingClientRect(), aspect = Math.max(1, canvas.width / Math.max(1, canvas.height));
      state.panX += aspect * 2 * dx / Math.max(1, rect.width);
      state.panY -= 2 * dy / Math.max(1, rect.height);
    }
    // A screen point in the units of panX / panY (x before the aspect divide). Missing coordinates: the centre.
    function clip(clientX, clientY) {
      const rect = canvas.getBoundingClientRect(), aspect = Math.max(1, canvas.width / Math.max(1, canvas.height));
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) { clientX = rect.left + rect.width / 2; clientY = rect.top + rect.height / 2; }
      return [aspect * (2 * (clientX - rect.left) / Math.max(1, rect.width) - 1), 1 - 2 * (clientY - rect.top) / Math.max(1, rect.height)];
    }
    const clampZoom = z => Math.max(0.15, Math.min(10, z));
    // Zoom around a screen point (the cursor): the model point under it stays under it.
    function zoomAt(clientX, clientY, factor) {
      const next = clampZoom(state.zoom * factor), k = next / state.zoom, [ax, ay] = clip(clientX, clientY);
      state.panX = ax - k * (ax - state.panX); state.panY = ay - k * (ay - state.panY); state.zoom = next;
    }
    // A pointer record: [x, y, startX, startY, mode]. mode "orbit", "pan" (right or middle button,
    // Shift + left drag) or "multi" (was part of a two-finger gesture: it never orbits or selects after).
    // Two fingers are solved from where the gesture started, not step by step: finger moves arrive one
    // at a time, and chaining small zooms around moving centres would drift.
    let pinch = null;
    const centre = () => { const p = [...pointers.values()]; return [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; };
    const spread = () => { const p = [...pointers.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); };
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    // A face drag (push / pull): the owner may take a one-finger / left-button drag that starts on a face instead of orbiting.
    // handler: { start(face, event) → true to take it, move(dx, dy, event), end(moved, event), cancel() }.
    let faceDrag = null, onDblFace = null;
    canvas.addEventListener("pointerdown", e => {
      canvas.setPointerCapture(e.pointerId);
      const pan = e.pointerType === "mouse" && (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey));
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      let mode = pan ? "pan" : "orbit";
      if (mode === "orbit" && faceDrag && pointers.size === 0 && !state.edgeMode) {
        const face = faceAt(e.clientX, e.clientY);
        if (face && faceDrag.start(face, e)) mode = "face";
      }
      pointers.set(e.pointerId, [e.clientX, e.clientY, e.clientX, e.clientY, mode]);
      if (pointers.size === 2) {
        for (const rec of pointers.values()) { if (rec[4] === "face" && faceDrag) faceDrag.cancel(); rec[4] = "multi"; }
        pinch = { zoom: state.zoom, panX: state.panX, panY: state.panY, at: clip(...centre()), spread: Math.max(1, spread()) };
      }
    });
    canvas.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId)) return;
      const old = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY, old[2], old[3], old[4]]);
      if (pointers.size === 1) {
        if (old[4] === "face") faceDrag.move(e.clientX - old[2], e.clientY - old[3], e);
        else if (old[4] === "pan") { panBy(e.clientX - old[0], e.clientY - old[1]); draw(); }
        else if (old[4] === "orbit") { state.yaw -= (e.clientX - old[0]) * 0.012; state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch + (e.clientY - old[1]) * 0.012)); draw(); }
      } else if (pointers.size === 2 && pinch) {
        // The model point under the starting centre follows the current centre; the spread sets the zoom.
        const zoom = clampZoom(pinch.zoom * spread() / pinch.spread), k = zoom / pinch.zoom, [ax, ay] = clip(...centre());
        state.zoom = zoom;
        state.panX = ax - k * (pinch.at[0] - pinch.panX); state.panY = ay - k * (pinch.at[1] - pinch.panY);
        draw();
      }
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, e => {
      const start = pointers.get(e.pointerId), single = pointers.size === 1;
      pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
      let tap = start && start[4] === "orbit";
      if (start && start[4] === "face") { // end of a face drag; a tap on the face is still a normal click
        const moved = name === "pointerup" && Math.hypot(e.clientX - start[2], e.clientY - start[3]) >= 6;
        if (name !== "pointerup") faceDrag.cancel(); else faceDrag.end(moved, e);
        tap = !moved;
      }
      if (name === "pointerup" && single && start && tap && Math.hypot(e.clientX - start[2], e.clientY - start[3]) < 6) {
        if (state.edgeMode) {
          const hit = edgeAt(e.clientX, e.clientY, e.pointerType);
          state.selectedEdge = hit ? hit.index : -1; draw();
          if (onEdge) onEdge(hit ? hit.edge : null);
        } else {
          const face = faceAt(e.clientX, e.clientY);
          state.selectedIndex = face ? face.index : -1; draw();
          if (onFace) onFace(face);
        }
      }
    });
    canvas.addEventListener("dblclick", e => {
      if (state.edgeMode) return;
      const face = faceAt(e.clientX, e.clientY);
      if (face && onDblFace) onDblFace(face);
    });
    canvas.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1); draw(); }, { passive: false });
    if (root.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    canvas.hqSolidProject = p => projectPoint(p); // read-only test hook: [x, y, depth] in clip space, smaller depth is nearer
    return { setTriangles, setEdges, setEdgeMode, setMarked, lockFrame, reset, draw, state, faceAt, edgeAt, project,
      setGhost, setClip, setView, fit, zoomBy, alignTo,
      onFaceSelect(callback) { onFace = callback; }, onEdgeSelect(callback) { onEdge = callback; },
      onFaceDrag(handler) { faceDrag = handler; }, onFaceDblClick(callback) { onDblFace = callback; } };
  }
  root.HQSolidView = viewer;
})(window);
