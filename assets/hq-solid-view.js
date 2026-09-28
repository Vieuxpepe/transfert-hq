/* Dessiner 3D preview: local WebGL depth buffer, canvas fallback. No CDN. */
(function (root) {
  "use strict";
  function viewer(canvas) {
    let gl = null, program = null, buffer = null, pos = null, col = null;
    const state = { triangles: [], yaw: -0.72, pitch: 0.62, zoom: 1, panX: 0, panY: 0 };
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
    let pointers = new Map(), lastDistance = 0;
    function bounds() {
      const b = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (const tri of state.triangles) for (const p of tri) for (let i = 0; i < 3; i++) { b[0][i] = Math.min(b[0][i], p[i]); b[1][i] = Math.max(b[1][i], p[i]); }
      if (!state.triangles.length) return { center: [0, 0, 0], span: 1 };
      return { center: b[0].map((v, i) => (v + b[1][i]) / 2), span: Math.max(...b[0].map((v, i) => b[1][i] - v), 1e-6) };
    }
    function geometry() {
      const { center, span } = bounds();
      const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw), cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
      const aspect = canvas.width / Math.max(1, canvas.height);
      const scale = 1.42 * state.zoom / span;
      const projection = p => {
        const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
        const rx = cy * x - sy * y, ry = sy * x + cy * y;
        return [(rx * scale + state.panX) / Math.max(1, aspect), (cp * z - sp * ry) * scale + state.panY, -(cp * ry + sp * z) * scale / 3];
      };
      return state.triangles.map(tri => {
        const a = tri[0], b = tri[1], c = tri[2];
        const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const length = Math.hypot(...n) || 1;
        const light = Math.max(0.25, Math.min(0.95, 0.55 + (n[0] * 0.4 - n[1] * 0.3 + n[2] * 0.7) / length * 0.35));
        return { points: tri.map(projection), color: [0.06 + 0.18 * light, 0.23 + 0.55 * light, 0.31 + 0.55 * light] };
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
    }
    function setTriangles(triangles) { state.triangles = triangles || []; draw(); }
    function reset() { state.yaw = -0.72; state.pitch = 0.62; state.zoom = 1; state.panX = 0; state.panY = 0; draw(); }
    canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); });
    canvas.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId)) return;
      const old = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) { state.yaw += (e.clientX - old[0]) * 0.012; state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch + (e.clientY - old[1]) * 0.012)); draw(); }
      else if (pointers.size === 2) {
        const p = [...pointers.values()], distance = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
        if (lastDistance) state.zoom = Math.max(0.15, Math.min(10, state.zoom * distance / lastDistance));
        lastDistance = distance; draw();
      }
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, e => { pointers.delete(e.pointerId); if (pointers.size < 2) lastDistance = 0; });
    canvas.addEventListener("wheel", e => { e.preventDefault(); state.zoom = Math.max(0.15, Math.min(10, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1))); draw(); }, { passive: false });
    if (root.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    return { setTriangles, reset, draw, state };
  }
  root.HQSolidView = viewer;
})(window);
