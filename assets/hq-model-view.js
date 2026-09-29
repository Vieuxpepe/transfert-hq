/* Lecteur 3D: small in-house STL / GLB parsers and a WebGL model viewer (canvas 2D fallback).
   No CDN, no network loads, ES2020. Same orbit conventions as the Dessiner 3D view
   (yaw -= dx so the model follows the pointer, pitch clamped, Z up). */
(function (root) {
  "use strict";
  const LIMITS = { maxBytes: 64 * 1024 * 1024, maxTriangles: 300000, maxTriangles2D: 30000 };

  class ModelError extends Error { constructor(message) { super(message); this.name = "ModelError"; } }
  function fail(message) { throw new ModelError(message); }
  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const mb = n => (n / 1048576).toFixed(1).replace(".", ",");
  function limitsOf(opts) { return Object.assign({}, LIMITS, opts || {}); }
  function checkBytes(n, limits) {
    if (n > limits.maxBytes) fail(`Fichier trop volumineux pour le lecteur 3D : ${mb(n)} Mo (maximum ${mb(limits.maxBytes)} Mo, pour rester fluide sur téléphone).`);
  }
  function checkTriangles(n, limits) {
    if (!(n > 0)) fail("Aucun triangle à afficher dans ce fichier.");
    if (n > limits.maxTriangles) fail(`Modèle trop détaillé pour le lecteur 3D : ${fmt(n)} triangles (maximum ${fmt(limits.maxTriangles)}, pour rester fluide sur téléphone).`);
  }

  // ---- shared geometry -------------------------------------------------------
  function flatNormal(p, i, out, j) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) return false;
    out[j] = nx / l; out[j + 1] = ny / l; out[j + 2] = nz / l;
    return true;
  }
  // positions: 9 floats per triangle; normals: per-vertex (9 per triangle) or null to compute flat normals;
  // fallbackNormals: 3 per triangle (STL facet normals) used only for degenerate triangles.
  function finish(format, positions, normals, colors, notices, fallbackNormals) {
    const t = positions.length / 9, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (!Number.isFinite(v)) fail("Fichier invalide : coordonnées non numériques.");
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
    if (!normals) {
      normals = new Float32Array(positions.length);
      const n = [0, 0, 1];
      for (let f = 0; f < t; f++) {
        if (!flatNormal(positions, f * 9, n, 0)) {
          const fb = fallbackNormals, l = fb ? Math.hypot(fb[f * 3], fb[f * 3 + 1], fb[f * 3 + 2]) : 0;
          if (l > 0) { n[0] = fb[f * 3] / l; n[1] = fb[f * 3 + 1] / l; n[2] = fb[f * 3 + 2] / l; } else { n[0] = 0; n[1] = 0; n[2] = 1; }
        }
        for (let v = 0; v < 3; v++) normals.set(n, f * 9 + v * 3);
      }
    }
    const center = lo.map((v, i) => (v + hi[i]) / 2);
    const radius = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 1e-9);
    return { format, triangles: t, positions, normals, colors, notices, bounds: { min: lo, max: hi, center, radius } };
  }

  // ---- STL (binary or ASCII, auto-detected) ----------------------------------
  function parseSTL(buffer, opts) {
    const limits = limitsOf(opts), n = buffer.byteLength;
    checkBytes(n, limits);
    if (n >= 84) {
      const dv = new DataView(buffer), count = dv.getUint32(80, true);
      if (84 + count * 50 === n) {  // binary size matches: binary even if the header starts with "solid"
        checkTriangles(count, limits);
        const positions = new Float32Array(count * 9), facet = new Float32Array(count * 3);
        for (let f = 0, o = 84; f < count; f++, o += 50) {
          for (let k = 0; k < 3; k++) facet[f * 3 + k] = dv.getFloat32(o + k * 4, true);
          for (let k = 0; k < 9; k++) positions[f * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
        }
        return finish("STL binaire", positions, null, null, [], facet);
      }
    }
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(n, 256))).replace(/^\uFEFF/, "").trimStart();
    if (!/^solid\b/i.test(head)) {
      fail(n < 84 ? "Fichier STL trop court ou invalide." : "Fichier STL binaire invalide ou tronqué (taille incohérente avec le nombre de triangles).");
    }
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi, values = [];
    let m;
    while ((m = re.exec(text))) {
      if (values.length / 9 >= limits.maxTriangles) checkTriangles(values.length / 9 + 1, limits);
      for (let k = 1; k <= 3; k++) {
        const v = Number(m[k]);
        if (!Number.isFinite(v)) fail("Fichier STL ASCII invalide : coordonnée illisible.");
        values.push(v);
      }
    }
    if (!values.length) fail(n >= 84 ? "Fichier STL invalide : ni STL ASCII lisible, ni STL binaire de taille cohérente." : "Fichier STL ASCII invalide : aucun sommet.");
    if (values.length % 9) fail("Fichier STL ASCII invalide : un triangle a moins de trois sommets.");
    checkTriangles(values.length / 9, limits);
    return finish("STL ASCII", Float32Array.from(values), null, null, []);
  }

  // ---- GLB (binary glTF 2.0) -------------------------------------------------
  const COMPONENT = { 5120: [1, "getInt8", 127], 5121: [1, "getUint8", 255], 5122: [2, "getInt16", 32767], 5123: [2, "getUint16", 65535], 5125: [4, "getUint32", 0], 5126: [4, "getFloat32", 0] };
  const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const MAX_NODES_VISITED = 20000;
  const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) {  // column-major 4x4
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function trs(t, q, s) {
    const [x, y, z, w] = q, [sx, sy, sz] = s;
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      t[0], t[1], t[2], 1];
  }
  const nums = (v, n, d) => Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? v : d;
  function localMatrix(node) {
    if (node.matrix !== undefined) {
      const m = nums(node.matrix, 16, null);
      if (!m) fail("Fichier GLB invalide : matrice de nœud incorrecte.");
      return m.slice();
    }
    return trs(nums(node.translation, 3, [0, 0, 0]), nums(node.rotation, 4, [0, 0, 0, 1]), nums(node.scale, 3, [1, 1, 1]));
  }
  function normalMatrix(m) {  // inverse-transpose of the upper 3x3, row-major result
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-20)) return null;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g), G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
  }
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === "string").map(x => x.slice(0, 60)).slice(0, 8) : []);

  function parseGLB(buffer, opts) {
    const limits = limitsOf(opts), size = buffer.byteLength;
    checkBytes(size, limits);
    if (size < 20) fail("Fichier GLB trop court ou invalide.");
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) fail("Ce fichier n'est pas un GLB (signature glTF absente).");
    const version = dv.getUint32(4, true);
    if (version !== 2) fail(`Version glTF ${version} non prise en charge (glTF 2.0 uniquement).`);
    const length = dv.getUint32(8, true);
    if (length > size || length < 20) fail("Fichier GLB tronqué.");
    let json = null, bin = null, off = 12;
    while (off + 8 <= length) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      off += 8;
      if (off + len > length) fail("Fichier GLB tronqué (bloc incomplet).");
      if (type === 0x4e4f534a && !json) {
        try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, len))); } catch (_) { fail("Fichier GLB invalide : description JSON illisible."); }
      } else if (type === 0x004e4942 && !bin) bin = new DataView(buffer, off, len);
      off += len;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) fail("Fichier GLB invalide : description JSON absente.");
    const required = list(json.extensionsRequired);
    if (required.length) fail(`Ce modèle utilise des extensions non prises en charge : ${required.join(", ")}. Réexporte-le sans compression (Draco, meshopt) ni extension obligatoire pour l'afficher ici.`);
    const arr = k => (Array.isArray(json[k]) ? json[k] : []);
    const accessors = arr("accessors"), views = arr("bufferViews"), buffers = arr("buffers"), meshes = arr("meshes"), nodes = arr("nodes"), materials = arr("materials");
    const notices = [];
    const used = list(json.extensionsUsed);
    if (used.length) notices.push("Extensions ignorées : " + used.join(", ") + ".");
    if (arr("textures").length || arr("images").length) notices.push("Textures non affichées : couleur de base des matériaux seulement.");
    if (arr("animations").length || arr("skins").length) notices.push("Animations et squelettes ignorés : pose de repos affichée.");

    function accessor(index, width) {
      const a = accessors[index];
      if (!a || typeof a !== "object") fail("Fichier GLB invalide : accesseur manquant.");
      if (a.sparse) fail("Ce GLB utilise des accesseurs « sparse » : non pris en charge.");
      const comp = COMPONENT[a.componentType], w = WIDTH[a.type], count = a.count;
      if (!comp || !w || (width && w !== width) || !Number.isInteger(count) || count < 0) fail("Fichier GLB invalide : accesseur incorrect.");
      const out = new Float64Array(count * w);
      if (a.bufferView === undefined) return out;  // spec: all zeros
      const view = views[a.bufferView];
      if (!view || typeof view !== "object") fail("Fichier GLB invalide : bufferView manquante.");
      const buf = buffers[view.buffer];
      if (!buf || view.buffer !== 0 || buf.uri !== undefined || !bin) fail("Ce GLB référence des données externes (fichier .bin séparé ou URI) : non pris en charge, exporte un .glb autonome.");
      const [bytes, getter, norm] = comp, stride = view.byteStride || bytes * w;
      const viewStart = view.byteOffset || 0, viewLength = view.byteLength, start = viewStart + (a.byteOffset || 0);
      if (!Number.isInteger(viewLength) || !Number.isInteger(start) || stride < bytes * w) fail("Fichier GLB invalide : bufferView incorrecte.");
      const end = count ? start + (count - 1) * stride + bytes * w : start;
      if (end > viewStart + viewLength || viewStart + viewLength > bin.byteLength) fail("Fichier GLB invalide : données hors limites.");
      const normalized = a.normalized && norm;
      for (let i = 0; i < count; i++) for (let k = 0; k < w; k++) {
        const v = bin[getter](start + i * stride + k * bytes, true);
        out[i * w + k] = normalized ? Math.max(v / norm, -1) : v;
      }
      return out;
    }
    const countOf = index => { const a = accessors[index]; return a && Number.isInteger(a.count) ? a.count : 0; };

    // Walk the scene hierarchy once to collect (mesh, world matrix) instances.
    let roots;
    const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0, scenes = arr("scenes");
    if (scenes[sceneIndex] && Array.isArray(scenes[sceneIndex].nodes)) roots = scenes[sceneIndex].nodes;
    else {
      const child = new Set();
      nodes.forEach(n => (n && Array.isArray(n.children) ? n.children : []).forEach(c => child.add(c)));
      roots = nodes.map((_, i) => i).filter(i => !child.has(i));
    }
    const instances = [];
    let visited = 0;
    const walk = (index, parent, path) => {
      const node = nodes[index];
      if (!node || typeof node !== "object") fail("Fichier GLB invalide : nœud manquant.");
      if (path.has(index)) fail("Fichier GLB invalide : hiérarchie de nœuds cyclique.");
      if (++visited > MAX_NODES_VISITED) fail("Fichier GLB trop complexe : trop de nœuds.");
      const world = mul(parent, localMatrix(node));
      if (Number.isInteger(node.mesh)) {
        if (!meshes[node.mesh]) fail("Fichier GLB invalide : maillage manquant.");
        instances.push([node.mesh, world]);
      }
      path.add(index);
      for (const c of Array.isArray(node.children) ? node.children : []) walk(c, world, path);
      path.delete(index);
    };
    for (const r of roots) walk(r, identity(), new Set());

    // Triangle budget before reading any vertex data.
    let total = 0, skipped = 0;
    for (const [mi] of instances) for (const p of Array.isArray(meshes[mi].primitives) ? meshes[mi].primitives : []) {
      const mode = p.mode === undefined ? 4 : p.mode;
      const n = p.indices !== undefined ? countOf(p.indices) : countOf(p.attributes && p.attributes.POSITION);
      if (mode === 4) total += Math.floor(n / 3);
      else if (mode === 5 || mode === 6) total += Math.max(0, n - 2);
      else skipped++;
    }
    if (skipped) notices.push("Points et lignes ignorés : seules les surfaces sont affichées.");
    checkTriangles(total, limits);

    const positions = new Float32Array(total * 9), normals = new Float32Array(total * 9), colors = new Float32Array(total * 9);
    let t = 0;
    const cache = new Map();
    for (const [mi, world] of instances) {
      const nm = normalMatrix(world);
      for (const p of Array.isArray(meshes[mi].primitives) ? meshes[mi].primitives : []) {
        const mode = p.mode === undefined ? 4 : p.mode;
        if (mode !== 4 && mode !== 5 && mode !== 6) continue;
        const attrs = p.attributes || {};
        if (attrs.POSITION === undefined) fail("Fichier GLB invalide : primitive sans POSITION.");
        // One read per (role, accessor): an accessor read as VEC3 is never reused as SCALAR indices.
        const read = (role, index, width) => { const k = role + index; if (!cache.has(k)) cache.set(k, accessor(index, width)); return cache.get(k); };
        const P = read("p", attrs.POSITION, 3);
        const N = attrs.NORMAL !== undefined ? read("n", attrs.NORMAL, 3) : null;
        const vcount = P.length / 3;
        if (N && N.length !== P.length) fail("Fichier GLB invalide : NORMAL et POSITION de tailles différentes.");
        const I = p.indices !== undefined ? read("i", p.indices, 1) : null;
        const n = I ? I.length : vcount, at = i => { const v = I ? I[i] : i; if (!(v >= 0 && v < vcount) || !Number.isInteger(v)) fail("Fichier GLB invalide : indice de sommet hors limites."); return v; };
        const mat = Number.isInteger(p.material) ? materials[p.material] : null;
        const f = mat && mat.pbrMetallicRoughness && nums(mat.pbrMetallicRoughness.baseColorFactor, 4, null);
        const base = mat ? (f ? f.slice(0, 3).map(v => Math.min(1, Math.max(0, v))) : [1, 1, 1]) : [0.8, 0.8, 0.8];
        const tris = mode === 4 ? Math.floor(n / 3) : Math.max(0, n - 2);
        for (let k = 0; k < tris; k++) {
          let a, b, c;
          if (mode === 4) { a = at(3 * k); b = at(3 * k + 1); c = at(3 * k + 2); }
          else if (mode === 5) { a = at(k); b = at(k + 1); c = at(k + 2); if (k % 2) { const s = a; a = b; b = s; } }
          else { a = at(0); b = at(k + 1); c = at(k + 2); }
          [a, b, c].forEach((v, j) => {
            const o = (t * 3 + j) * 3, x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
            const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
            const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
            positions[o] = wx; positions[o + 1] = -wz; positions[o + 2] = wy;  // glTF Y-up -> viewer Z-up
            colors.set(base, o);
            if (N && nm) {
              const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
              const tx = nm[0] * nx + nm[1] * ny + nm[2] * nz, ty = nm[3] * nx + nm[4] * ny + nm[5] * nz, tz = nm[6] * nx + nm[7] * ny + nm[8] * nz;
              const l = Math.hypot(tx, ty, tz) || 1;
              normals[o] = tx / l; normals[o + 1] = -tz / l; normals[o + 2] = ty / l;
            } else normals[o] = NaN;  // marker: flat normal below
          });
          if (Number.isNaN(normals[t * 9]) || Number.isNaN(normals[t * 9 + 3]) || Number.isNaN(normals[t * 9 + 6])) {
            const nn = [0, 0, 1];
            flatNormal(positions, t * 9, nn, 0);
            for (let j = 0; j < 3; j++) normals.set(nn, t * 9 + j * 3);
          }
          t++;
        }
      }
    }
    return finish("GLB", positions, normals, colors, notices);
  }

  function parse(name, buffer, opts) {
    if (!(buffer instanceof ArrayBuffer)) fail("Fichier illisible.");
    const ext = (/\.([a-z0-9]+)$/i.exec(String(name || "")) || [])[1];
    const lower = ext ? ext.toLowerCase() : "";
    if (lower === "glb" || (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === 0x46546c67)) return parseGLB(buffer, opts);
    if (lower === "stl") return parseSTL(buffer, opts);
    fail("Format 3D non pris en charge (STL ou GLB seulement).");
  }

  // ---- view math (pure; shared with tests) ------------------------------------
  const DEFAULT_VIEW = { yaw: -0.72, pitch: 0.62, zoom: 1, panX: 0, panY: 0 };
  function project(view, bounds, aspect, p) {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const x = p[0] - bounds.center[0], y = p[1] - bounds.center[1], z = p[2] - bounds.center[2];
    const rx = cy * x - sy * y, ry = sy * x + cy * y, scale = 0.8 * view.zoom / bounds.radius;
    return [(rx * scale + view.panX) / Math.max(1, aspect), (cp * z - sp * ry) * scale + view.panY, -(cp * ry + sp * z) / (bounds.radius * 1.05)];
  }
  function orbit(view, dx, dy) {
    return Object.assign({}, view, { yaw: view.yaw - dx * 0.012, pitch: Math.max(-1.48, Math.min(1.48, view.pitch + dy * 0.012)) });
  }
  function pan(view, dx, dy, width, height, aspect) {  // CSS px drag -> the model follows the pointer
    return Object.assign({}, view, { panX: view.panX + 2 * dx / Math.max(1, width) * Math.max(1, aspect), panY: view.panY - 2 * dy / Math.max(1, height) });
  }
  function zoomBy(view, factor) { return Object.assign({}, view, { zoom: Math.max(0.15, Math.min(10, view.zoom * factor)) }); }
  function fit(view) { return Object.assign({}, view, { zoom: 1, panX: 0, panY: 0 }); }

  // ---- viewer ------------------------------------------------------------------
  const BG = [0.93, 0.96, 0.98];
  function modelViewer(canvas) {
    let gl = null, prog = null, model = null, buffers = null, loc = {}, raf = 0;
    let view = Object.assign({}, DEFAULT_VIEW);
    try { gl = canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true }); } catch (_) { gl = null; }
    if (gl) {
      try {
        const sh = (kind, src) => { const s = gl.createShader(kind); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, [
          "attribute vec3 p; attribute vec3 n; attribute vec3 c;",
          "uniform vec3 center; uniform vec4 rot; uniform vec4 v; uniform float depth; uniform float useColor; varying vec3 col;",
          "void main(){ vec3 q=p-center; float rx=rot.x*q.x-rot.y*q.y; float ry=rot.y*q.x+rot.x*q.y;",
          " gl_Position=vec4((rx*v.x+v.z)*v.y,(rot.z*q.z-rot.w*ry)*v.x+v.w,-(rot.z*ry+rot.w*q.z)*depth,1.0);",
          " float nry=rot.y*n.x+rot.x*n.y; float facing=abs(rot.z*nry+rot.w*n.z);",
          " float l=clamp(0.3+0.7*facing,0.25,1.0);",
          " col = useColor > 0.5 ? c*(0.2+0.8*l) : vec3(0.06,0.23,0.31)+vec3(0.18,0.55,0.55)*l; }"].join("\n")));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 col; void main(){gl_FragColor=vec4(col,1.0);}"));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        for (const a of ["p", "n", "c"]) loc[a] = gl.getAttribLocation(prog, a);
        for (const u of ["center", "rot", "v", "depth", "useColor"]) loc[u] = gl.getUniformLocation(prog, u);
      } catch (_) { gl = null; prog = null; }
    }
    const ctx = gl ? null : canvas.getContext("2d");
    function size() {
      const rect = canvas.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return { w, h, rect };
    }
    function draw() {
      raf = 0;
      const { w, h } = size();
      if (gl) {
        gl.viewport(0, 0, w, h); gl.clearColor(BG[0], BG[1], BG[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!model || !buffers) return;
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.useProgram(prog);
        const b = model.bounds, aspect = w / h;
        gl.uniform3f(loc.center, b.center[0], b.center[1], b.center[2]);
        gl.uniform4f(loc.rot, Math.cos(view.yaw), Math.sin(view.yaw), Math.cos(view.pitch), Math.sin(view.pitch));
        gl.uniform4f(loc.v, 0.8 * view.zoom / b.radius, 1 / Math.max(1, aspect), view.panX, view.panY);
        gl.uniform1f(loc.depth, 1 / (b.radius * 1.05));
        gl.uniform1f(loc.useColor, model.colors ? 1 : 0);
        for (const [a, buf] of [["p", buffers.p], ["n", buffers.n], ["c", buffers.c]]) {
          if (buf) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc[a]); gl.vertexAttribPointer(loc[a], 3, gl.FLOAT, false, 0, 0); }
          else if (loc[a] >= 0) { gl.disableVertexAttribArray(loc[a]); gl.vertexAttrib3f(loc[a], 0, 0, 0); }
        }
        gl.drawArrays(gl.TRIANGLES, 0, model.triangles * 3);
      } else if (ctx) {
        ctx.fillStyle = "rgb(237,245,250)"; ctx.fillRect(0, 0, w, h);
        if (!model) return;
        const b = model.bounds, aspect = w / h, P = model.positions, N = model.normals, C = model.colors, faces = [];
        const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
        for (let f = 0; f < model.triangles; f++) {
          const pts = [], o = f * 9;
          let depth = 0;
          for (let j = 0; j < 3; j++) { const q = project(view, b, aspect, [P[o + j * 3], P[o + j * 3 + 1], P[o + j * 3 + 2]]); pts.push([(q[0] + 1) * w / 2, (1 - q[1]) * h / 2]); depth += q[2]; }
          const facing = Math.abs(cp * (sy * N[o] + cy * N[o + 1]) + sp * N[o + 2]), l = Math.max(0.25, Math.min(1, 0.3 + 0.7 * facing));
          const rgb = C ? [C[o] * (0.2 + 0.8 * l), C[o + 1] * (0.2 + 0.8 * l), C[o + 2] * (0.2 + 0.8 * l)] : [0.06 + 0.18 * l, 0.23 + 0.55 * l, 0.31 + 0.55 * l];
          faces.push({ pts, depth, rgb });
        }
        faces.sort((a, c) => c.depth - a.depth);
        for (const f of faces) {
          ctx.beginPath(); ctx.moveTo(f.pts[0][0], f.pts[0][1]); ctx.lineTo(f.pts[1][0], f.pts[1][1]); ctx.lineTo(f.pts[2][0], f.pts[2][1]); ctx.closePath();
          ctx.fillStyle = `rgb(${f.rgb.map(x => Math.round(x * 255)).join(",")})`; ctx.fill();
        }
      }
    }
    const schedule = () => { if (!raf) raf = (root.requestAnimationFrame || (fn => setTimeout(fn, 16)))(draw); };
    function freeBuffers() { if (gl && buffers) for (const k of ["p", "n", "c"]) if (buffers[k]) gl.deleteBuffer(buffers[k]); buffers = null; }
    function setModel(m) {
      freeBuffers();
      if (m && !gl && m.triangles > LIMITS.maxTriangles2D) { model = null; draw(); fail(`Ce navigateur n'a pas WebGL : modèle limité à ${fmt(LIMITS.maxTriangles2D)} triangles ici (${fmt(m.triangles)}).`); }
      model = m || null;
      view = Object.assign({}, DEFAULT_VIEW);
      if (gl && model) {
        const up = arr => { if (!arr) return null; const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b; };
        buffers = { p: up(model.positions), n: up(model.normals), c: up(model.colors) };
      }
      draw();
    }
    function refit() { view = fit(view); draw(); }
    // Gestures: one finger / left drag orbits; two fingers pan + pinch-zoom; right, middle or Shift drag pans; wheel zooms.
    const pointers = new Map();
    let pinch = null;
    const pinchState = () => {  // baseline as soon as two fingers are down, so the first movement is not lost
      if (pointers.size !== 2) return null;
      const [a, b] = [...pointers.values()];
      return { mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    };
    canvas.addEventListener("pointerdown", e => {
      if (!model) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.button === 2 || (e.shiftKey && e.pointerType !== "touch") });
      pinch = pinchState();
      if (e.button === 1 || e.button === 2) e.preventDefault();
    });
    canvas.addEventListener("pointermove", e => {
      const p = pointers.get(e.pointerId);
      if (!p || !model) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      const rect = canvas.getBoundingClientRect(), aspect = rect.width / Math.max(1, rect.height);
      if (pointers.size === 1) view = p.pan ? pan(view, dx, dy, rect.width, rect.height, aspect) : orbit(view, dx, dy);
      else {
        const [a, b] = [...pointers.values()], mid = [(a.x + b.x) / 2, (a.y + b.y) / 2], d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        if (pinch) { view = zoomBy(pan(view, mid[0] - pinch.mid[0], mid[1] - pinch.mid[1], rect.width, rect.height, aspect), d / pinch.d); }
        pinch = { mid, d };
      }
      schedule();
    });
    const release = e => { pointers.delete(e.pointerId); pinch = pinchState(); };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("wheel", e => { if (!model) return; e.preventDefault(); view = zoomBy(view, e.deltaY > 0 ? 0.9 : 1.1); schedule(); }, { passive: false });
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    if (root.ResizeObserver) new ResizeObserver(() => schedule()).observe(canvas);
    // Read-only test hooks.
    canvas.hqModelView = () => Object.assign({}, view, { triangles: model ? model.triangles : 0, webgl: !!gl });
    canvas.hqModelProject = p => { const { w, h } = size(); return model ? project(view, model.bounds, w / h, p) : null; };
    canvas.hqModelSnapshot = () => {
      draw();
      const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext("2d"); x.drawImage(canvas, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, bg = BG.map(v => Math.round(v * 255));
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) {
          n++; const X = px % c.width, Y = (px / c.width) | 0;
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
      }
      return { width: c.width, height: c.height, nonBackground: n, bbox: n ? [x0, y0, x1, y1] : null };
    };
    return { setModel, fit: refit, draw, get view() { return Object.assign({}, view); }, get webgl() { return !!gl; } };
  }

  const api = { LIMITS, ModelError, parse, parseSTL, parseGLB, project, orbit, pan, zoomBy, fit, DEFAULT_VIEW, viewer: modelViewer };
  root.HQModel = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
