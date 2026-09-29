/* Dessiner 3D preview: local WebGL depth buffer, canvas fallback. No CDN. */
(function (root) {
  "use strict";
  function viewer(canvas) {
    let gl = null, program = null, buffer = null, pos = null, col = null;
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
        gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec3 p; attribute vec3 c; varying vec3 v; void main(){gl_Position=vec4(p,1.0);v=c;}"));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 v; void main(){gl_FragColor=vec4(v,1.0);}"));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        buffer = gl.createBuffer(); pos = gl.getAttribLocation(program, "p"); col = gl.getAttribLocation(program, "c");
      } catch (_) { gl = null; }
    }
    const ctx = gl ? null : canvas.getContext("2d");
    const edgeCanvas = document.createElement("canvas");
    edgeCanvas.className = "sk-3d-edge-overlay";
    edgeCanvas.setAttribute("aria-hidden", "true");
    canvas.parentNode.appendChild(edgeCanvas);
    const edgeCtx = edgeCanvas.getContext("2d");
    let pointers = new Map(), lastDistance = 0;
    function bounds() {
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
        const data = new Float32Array(faces.length * 3 * 6);
        let at = 0;
        for (const face of faces) for (const p of face.points) { data.set(p, at); at += 3; data.set(face.color, at); at += 3; }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(pos); gl.enableVertexAttribArray(col);
        gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(col, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.TRIANGLES, 0, faces.length * 3);
      } else if (ctx) {
        ctx.fillStyle = "#edf4f8"; ctx.fillRect(0, 0, w, h);
        faces.sort((a, b) => b.points.reduce((s, p) => s + p[2], 0) - a.points.reduce((s, p) => s + p[2], 0));
        for (const face of faces) {
          const pts = face.points.map(p => [(p[0] + 1) * w / 2, (1 - p[1]) * h / 2]);
          ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.lineTo(...pts[2]); ctx.closePath();
          ctx.fillStyle = `rgb(${face.color.map(v => Math.round(v * 255)).join(",")})`; ctx.fill();
        }
      }
      edgeCanvas.width = w; edgeCanvas.height = h;
      if (state.edgeMode && state.selectedEdge >= 0 && state.edges[state.selectedEdge]) {
        const edge = state.edges[state.selectedEdge], q = viewParams(), a = projectPoint(edge.a, q), b = projectPoint(edge.b, q);
        edgeCtx.beginPath(); edgeCtx.moveTo((a[0] + 1) * w / 2, (1 - a[1]) * h / 2);
        edgeCtx.lineTo((b[0] + 1) * w / 2, (1 - b[1]) * h / 2);
        edgeCtx.strokeStyle = "#f97316"; edgeCtx.lineWidth = Math.max(4, 4 * dpr); edgeCtx.lineCap = "round"; edgeCtx.stroke();
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
        if (!hit || z < hit.z) hit = { index: f.index, z };
      }
      if (!hit) return null;
      const tri = state.triangles[hit.index], origin = tri[0];
      const normal = unit(cross(sub(tri[1], origin), sub(tri[2], origin)));
      if (!normal) return null;
      const ref = Math.abs(normal[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
      const u = unit(cross(ref, normal)), v = cross(normal, u);
      const plane = { origin: origin.slice(), u, v, normal };
      const tol = bounds().span * 1e-5;
      const triangles = state.triangles.filter(t => {
        const n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
        return n && dot(n, normal) > 0.99999 && t.every(p => Math.abs(dot(sub(p, origin), normal)) < tol);
      }).map(t => t.map(p => [dot(sub(p, origin), u), dot(sub(p, origin), v)]));
      return { index: hit.index, depth: hit.z, plane, triangles };
    }
    function edgeAt(clientX, clientY, pointerType) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      const front = faceAt(clientX, clientY);
      const threshold = pointerType === "touch" ? 22 : 13;
      const q = viewParams();
      let best = null;
      state.edges.forEach((edge, index) => {
        const a = projectPoint(edge.a, q), b = projectPoint(edge.b, q);
        const ax = (a[0] + 1) * rect.width / 2, ay = (1 - a[1]) * rect.height / 2;
        const bx = (b[0] + 1) * rect.width / 2, by = (1 - b[1]) * rect.height / 2;
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        if (len2 < 1) return;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
        const dist = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
        const depth = a[2] + t * (b[2] - a[2]);
        if (dist > threshold || (front && depth > front.depth + 0.005)) return;
        if (!best || dist < best.dist) best = { index, dist, edge };
      });
      return best;
    }
    function setTriangles(triangles) { state.triangles = triangles || []; state.selectedIndex = -1; state.selectedEdge = -1; draw(); }
    function setEdges(edges) { state.edges = edges || []; state.selectedEdge = -1; draw(); }
    function setEdgeMode(on) { state.edgeMode = !!on; state.selectedIndex = -1; state.selectedEdge = -1; draw(); }
    function reset() { state.yaw = -0.72; state.pitch = 0.62; state.zoom = 1; state.panX = 0; state.panY = 0; draw(); }
    canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY, e.clientX, e.clientY]); });
    canvas.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId)) return;
      const old = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY, old[2], old[3]]);
      if (pointers.size === 1) { state.yaw -= (e.clientX - old[0]) * 0.012; state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch + (e.clientY - old[1]) * 0.012)); draw(); }
      else if (pointers.size === 2) {
        const p = [...pointers.values()], distance = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
        if (lastDistance) state.zoom = Math.max(0.15, Math.min(10, state.zoom * distance / lastDistance));
        lastDistance = distance; draw();
      }
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, e => {
      const start = pointers.get(e.pointerId), single = pointers.size === 1;
      pointers.delete(e.pointerId); if (pointers.size < 2) lastDistance = 0;
      if (name === "pointerup" && single && start && Math.hypot(e.clientX - start[2], e.clientY - start[3]) < 6) {
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
    canvas.addEventListener("wheel", e => { e.preventDefault(); state.zoom = Math.max(0.15, Math.min(10, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1))); draw(); }, { passive: false });
    if (root.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    canvas.hqSolidProject = p => projectPoint(p); // read-only test hook: [x, y, depth] in clip space, smaller depth is nearer
    return { setTriangles, setEdges, setEdgeMode, reset, draw, state, faceAt, edgeAt,
      onFaceSelect(callback) { onFace = callback; }, onEdgeSelect(callback) { onEdge = callback; } };
  }
  root.HQSolidView = viewer;
})(window);
