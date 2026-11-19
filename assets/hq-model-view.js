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
    // Signed tetrahedra sum: exact for a closed, consistently wound mesh and a useful upper-bound
    // estimate otherwise (the model detail labels it as such). Units follow the file's coordinates.
    let signedVolume = 0;
    for (let f = 0; f < t; f++) {
      const o = f * 9;
      const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
      const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
      signedVolume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return { format, triangles: t, positions, normals, colors, notices,
      volume_mm3: Math.abs(signedVolume) / 6, bounds: { min: lo, max: hi, center, radius } };
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
    const NUM_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
    const values = [];
    let curFacet = 0, inFacet = false;
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) continue;
      const parts = s.split(/\s+/);
      const kw = parts[0].toLowerCase();
      if (kw === "facet") {
        if (inFacet) fail("Fichier STL ASCII invalide : facette imbriquée.");
        inFacet = true; curFacet = 0;
      } else if (kw === "vertex") {
        if (parts.length !== 4) fail("Fichier STL ASCII invalide : coordonnée illisible.");
        for (let k = 1; k <= 3; k++) {
          const v = NUM_RE.test(parts[k]) ? Number(parts[k]) : NaN;
          if (!Number.isFinite(v)) fail("Fichier STL ASCII invalide : coordonnée illisible.");
          values.push(v);
        }
        curFacet += 1;
        if (curFacet > 3) fail("Fichier STL ASCII invalide : une facette a plus de trois sommets.");
        if (values.length / 9 > limits.maxTriangles) checkTriangles(values.length / 9, limits);
      } else if (kw === "endloop" || kw === "endfacet") {
        if (curFacet > 0 && curFacet !== 3) fail("Fichier STL ASCII invalide : un triangle a moins de trois sommets.");
        if (kw === "endfacet") { inFacet = false; curFacet = 0; }
      }
    }
    if (!values.length) fail(n >= 84 ? "Fichier STL invalide : ni STL ASCII lisible, ni STL binaire de taille cohérente." : "Fichier STL ASCII invalide : aucun sommet.");
    if (values.length % 9 || (inFacet && curFacet !== 0 && curFacet !== 3)) fail("Fichier STL ASCII invalide : un triangle a moins de trois sommets.");
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

  // ---- OBJ (geometry only: v / f, negative indices, polygons fan-triangulated) ----
  function parseOBJ(buffer, opts) {
    const limits = limitsOf(opts);
    checkBytes(buffer.byteLength, limits);
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    const vs = [], out = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {  // "v "
        const p = line.slice(2).trim().split(/\s+/);
        const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) fail("Fichier OBJ invalide : coordonnée illisible.");
        vs.push(x, y, z);
      } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {  // "f "
        const idx = line.slice(2).trim().split(/\s+/).map(tok => {
          const n = parseInt(tok.split("/")[0], 10);
          return n < 0 ? vs.length / 3 + n : n - 1;
        });
        if (idx.length < 3) continue;
        for (let k = 1; k + 1 < idx.length; k++) {
          if (out.length / 9 >= limits.maxTriangles) checkTriangles(out.length / 9 + 1, limits);
          for (const i of [idx[0], idx[k], idx[k + 1]]) {
            if (!(i >= 0) || i * 3 + 2 >= vs.length) fail("Fichier OBJ invalide : une face utilise un sommet inexistant.");
            out.push(vs[i * 3], vs[i * 3 + 1], vs[i * 3 + 2]);
          }
        }
      }
    }
    checkTriangles(out.length / 9, limits);
    return finish("OBJ", Float32Array.from(out), null, null, ["Couleurs et textures ignorées : formes seulement."]);
  }

  // ---- 3MF (ZIP of XML; async because the browser inflates through DecompressionStream) ----
  const U32 = (dv, o) => dv.getUint32(o, true), U16 = (dv, o) => dv.getUint16(o, true);
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") fail("Ce navigateur ne sait pas décompresser les 3MF (DecompressionStream manquant).");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function zipEntries(buffer) {
    const dv = new DataView(buffer), n = buffer.byteLength;
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 65557); i--) if (U32(dv, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) fail("Fichier 3MF invalide : archive ZIP illisible.");
    const count = U16(dv, eocd + 10);
    let pos = U32(dv, eocd + 16);
    const entries = [];
    for (let i = 0; i < count && pos + 46 <= n && U32(dv, pos) === 0x02014b50; i++) {
      const nameLen = U16(dv, pos + 28), extra = U16(dv, pos + 30), comment = U16(dv, pos + 32);
      entries.push({ method: U16(dv, pos + 10), csize: U32(dv, pos + 20), usize: U32(dv, pos + 24), offset: U32(dv, pos + 42),
        name: new TextDecoder().decode(new Uint8Array(buffer, pos + 46, nameLen)).replace(/^\/+/, "") });
      pos += 46 + nameLen + extra + comment;
    }
    return entries;
  }
  async function zipRead(buffer, entry, maxBytes) {
    const dv = new DataView(buffer);
    if (entry.usize > maxBytes) fail(`Fichier 3MF trop volumineux une fois décompressé (${mb(entry.usize)} Mo).`);
    const o = entry.offset;
    if (o + 30 > buffer.byteLength || U32(dv, o) !== 0x04034b50) fail("Fichier 3MF invalide : entrée ZIP corrompue.");
    const start = o + 30 + U16(dv, o + 26) + U16(dv, o + 28);
    const raw = new Uint8Array(buffer, start, entry.csize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    return fail("Fichier 3MF invalide : compression ZIP non prise en charge.");
  }
  const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
  const parseXml = bytes => {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) fail("Fichier 3MF invalide : XML illisible.");
    return doc;
  };
  const matrixOf = s => {
    const m = String(s || "").trim().split(/\s+/).map(Number);
    return m.length === 12 && m.every(Number.isFinite) ? m : null;
  };
  const applyM = (m, x, y, z) => m ? [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]] : [x, y, z];
  const composeM = (a, b) => {  // a then b (row-vector convention)
    if (!a) return b; if (!b) return a;
    const out = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const A = r < 3 ? [a[r * 3], a[r * 3 + 1], a[r * 3 + 2]] : [a[9], a[10], a[11]];
      out.push(A[0] * b[c] + A[1] * b[3 + c] + A[2] * b[6 + c] + (r === 3 ? b[9 + c] : 0));
    }
    return out;
  };
  function readModelObjects(doc) {
    const objects = new Map();
    for (const el of doc.getElementsByTagName("object")) {
      if (el.getAttribute("type") === "support") continue;
      const obj = { mesh: null, comps: [] };
      const mesh = el.getElementsByTagName("mesh")[0];
      if (mesh) {
        const vs = [], ts = [];
        for (const v of mesh.getElementsByTagName("vertex")) vs.push(Number(v.getAttribute("x")), Number(v.getAttribute("y")), Number(v.getAttribute("z")));
        for (const t of mesh.getElementsByTagName("triangle")) ts.push(Number(t.getAttribute("v1")), Number(t.getAttribute("v2")), Number(t.getAttribute("v3")));
        obj.mesh = { vs, ts };
      }
      for (const c of el.getElementsByTagName("component")) {
        obj.comps.push({ id: c.getAttribute("objectid"), path: (c.getAttribute("p:path") || "").replace(/^\/+/, ""), m: matrixOf(c.getAttribute("transform")) });
      }
      objects.set(el.getAttribute("id"), obj);
    }
    return objects;
  }
  async function parse3MF(buffer, opts) {
    const limits = limitsOf(opts);
    checkBytes(buffer.byteLength, limits);
    const entries = zipEntries(buffer).filter(e => /\.model$/i.test(e.name));
    if (!entries.length) fail("Fichier 3MF invalide : aucun modèle 3D dans l'archive.");
    const rootEntry = entries.find(e => /^3D\/3dmodel\.model$/i.test(e.name)) || entries[0];
    const maxXml = Math.min(160 * 1048576, limits.maxBytes * 2);
    const rootDoc = parseXml(await zipRead(buffer, rootEntry, maxXml));
    const unit = UNIT_MM[(rootDoc.getElementsByTagName("model")[0] || { getAttribute: () => "" }).getAttribute("unit") || "millimeter"] || 1;
    const docs = new Map([[rootEntry.name, { objects: readModelObjects(rootDoc) }]]);
    const getDoc = async path => {
      const key = path || rootEntry.name;
      if (!docs.has(key)) {
        const e = entries.find(x => x.name.toLowerCase() === key.toLowerCase());
        if (!e) fail("Fichier 3MF invalide : un objet référence un fichier absent de l'archive.");
        docs.set(key, { objects: readModelObjects(parseXml(await zipRead(buffer, e, maxXml))) });
      }
      return docs.get(key);
    };
    const out = [];
    const emit = async (path, id, m, depth) => {
      if (depth > 8) fail("Fichier 3MF invalide : composants imbriqués trop profondément.");
      const obj = (await getDoc(path)).objects.get(String(id));
      if (!obj) return;
      if (obj.mesh) {
        const { vs, ts } = obj.mesh;
        for (let i = 0; i + 2 < ts.length; i += 3) {
          if (out.length / 9 >= limits.maxTriangles) checkTriangles(out.length / 9 + 1, limits);
          for (let k = 0; k < 3; k++) {
            const vi = ts[i + k];
            if (!(vi >= 0) || vi * 3 + 2 >= vs.length) fail("Fichier 3MF invalide : un triangle utilise un sommet inexistant.");
            const q = applyM(m, vs[vi * 3], vs[vi * 3 + 1], vs[vi * 3 + 2]);
            out.push(q[0] * unit, q[1] * unit, q[2] * unit);
          }
        }
      }
      for (const c of obj.comps) await emit(c.path || path, c.id, composeM(c.m, m), depth + 1);
    };
    const items = [...rootDoc.getElementsByTagName("item")];
    if (items.length) for (const it of items) await emit(rootEntry.name, it.getAttribute("objectid"), matrixOf(it.getAttribute("transform")), 0);
    else for (const id of docs.get(rootEntry.name).objects.keys()) await emit(rootEntry.name, id, null, 0);
    checkTriangles(out.length / 9, limits);
    return finish("3MF", Float32Array.from(out), null, null, ["Couleurs et matériaux ignorés : formes seulement."]);
  }

  function parse(name, buffer, opts) {
    if (!(buffer instanceof ArrayBuffer)) fail("Fichier illisible.");
    const ext = (/\.([a-z0-9]+)$/i.exec(String(name || "")) || [])[1];
    const lower = ext ? ext.toLowerCase() : "";
    if (lower === "glb" || (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === 0x46546c67)) return parseGLB(buffer, opts);
    if (lower === "stl") return parseSTL(buffer, opts);
    if (lower === "obj") return parseOBJ(buffer, opts);
    if (lower === "3mf") fail("Le format 3MF se lit avec parseAsync().");
    fail("Format 3D non pris en charge (STL, GLB, OBJ ou 3MF).");
  }
  // Same as parse() plus 3MF. The Atelier keeps calling the synchronous parse() for STL / GLB.
  const WORKER_PARSE_MIN_BYTES = 200 * 1024;
  let parseWorker = null;
  let parseWorkerSeq = 0;
  const parseWorkerPending = new Map();

  function assetUrl(name) {
    const env = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : root);
    if (env && typeof env.hqAssetUrl === "function") return env.hqAssetUrl(name);
    return "/assets/" + name;
  }

  function ensureParseWorker() {
    if (parseWorker || typeof Worker === "undefined") return parseWorker;
    try {
      parseWorker = new Worker(assetUrl("hq-model-parse.worker.js"));
      parseWorker.onmessage = function (e) {
        const msg = e.data || {};
        const pending = parseWorkerPending.get(msg.id);
        if (!pending) return;
        parseWorkerPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.model);
        else pending.reject(new ModelError(msg.message || "Échec du parseur 3D (worker)."));
      };
      parseWorker.onerror = function (err) {
        const msg = err && err.message ? err.message : "worker";
        parseWorkerPending.forEach(function (p) { p.reject(new ModelError(msg)); });
        parseWorkerPending.clear();
        try { parseWorker.terminate(); } catch (_) {}
        parseWorker = null;
      };
    } catch (_) {
      parseWorker = null;
    }
    return parseWorker;
  }

  function parseInWorker(name, buffer, opts) {
    const worker = ensureParseWorker();
    if (!worker) return Promise.resolve(parse(name, buffer, opts));
    const id = ++parseWorkerSeq;
    const fallback = buffer.slice(0);
    return new Promise(function (resolve, reject) {
      const fallbackOrReject = function (err) {
        try { resolve(parse(name, fallback, opts)); }
        catch (e) { reject(err || e); }
      };
      parseWorkerPending.set(id, { resolve, reject: fallbackOrReject });
      try {
        worker.postMessage({ id, name, buffer, opts }, [buffer]);
      } catch (err) {
        parseWorkerPending.delete(id);
        fallbackOrReject(err);
      }
    });
  }

  async function parseAsync(name, buffer, opts) {
    if (!(buffer instanceof ArrayBuffer)) fail("Fichier illisible.");
    if (/\.3mf$/i.test(String(name || ""))) return parse3MF(buffer, opts);
    if (buffer.byteLength >= WORKER_PARSE_MIN_BYTES) return parseInWorker(name, buffer, opts);
    return parse(name, buffer, opts);
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
    let gl = null, prog = null, model = null, buffers = null, loc = {}, raf = 0, ro = null, disposed = false;
    let wire = false, wireBuf = null, auto = false, lastT = 0;  // Lecteur extras: wireframe + turntable
    const WIRE_MAX = 150000;  // triangles; above this the wireframe toggle refuses (edge buffers triple the memory)
    let view = Object.assign({}, DEFAULT_VIEW);
    try { gl = canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: false }); } catch (_) { gl = null; }
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
      if (disposed) return;
      if (auto && model) {  // turntable: time-based so a slow frame does not change the speed
        const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
        const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
        lastT = now;
        view = Object.assign({}, view, { yaw: view.yaw + dt * 0.6 });
        schedule();
      } else lastT = 0;
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
        let use = buffers, count = model.triangles * 3, mode = gl.TRIANGLES;
        if (wire) {
          if (!wireBuf) wireBuf = buildWire();
          if (wireBuf) { use = wireBuf; count = model.triangles * 6; mode = gl.LINES; }
        }
        for (const [a, buf] of [["p", use.p], ["n", use.n], ["c", use.c]]) {
          if (buf) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc[a]); gl.vertexAttribPointer(loc[a], 3, gl.FLOAT, false, 0, 0); }
          else if (loc[a] >= 0) { gl.disableVertexAttribArray(loc[a]); gl.vertexAttrib3f(loc[a], 0, 0, 0); }
        }
        gl.drawArrays(mode, 0, count);
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
          const css = `rgb(${f.rgb.map(x => Math.round(x * 255)).join(",")})`;
          if (wire) { ctx.strokeStyle = css; ctx.lineWidth = 1; ctx.stroke(); } else { ctx.fillStyle = css; ctx.fill(); }
        }
      }
    }
    const schedule = () => { if (disposed || raf) return; raf = (root.requestAnimationFrame || (fn => setTimeout(fn, 16)))(draw); };
    function freeBuffers() {
      if (gl && buffers) for (const k of ["p", "n", "c"]) if (buffers[k]) gl.deleteBuffer(buffers[k]);
      if (gl && wireBuf) for (const k of ["p", "n", "c"]) if (wireBuf[k]) gl.deleteBuffer(wireBuf[k]);
      buffers = null; wireBuf = null;
    }
    // Edge buffers (3 segments per triangle) for the wireframe; built on first use, dropped with the model.
    function buildWire() {
      if (!gl || !model || model.triangles > WIRE_MAX) return null;
      const t = model.triangles, EDGES = [[0, 1], [1, 2], [2, 0]];
      const expand = src => {
        if (!src) return null;
        const out = new Float32Array(t * 18);
        for (let f = 0; f < t; f++) for (let e = 0; e < 3; e++) {
          const a = f * 9 + EDGES[e][0] * 3, b = f * 9 + EDGES[e][1] * 3, q = f * 18 + e * 6;
          for (let k = 0; k < 3; k++) { out[q + k] = src[a + k]; out[q + 3 + k] = src[b + k]; }
        }
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, out, gl.STATIC_DRAW);
        return buf;
      };
      return { p: expand(model.positions), n: expand(model.normals), c: expand(model.colors) };
    }
    function setWireframe(on) {
      wire = !!on;
      if (wire && gl && model && model.triangles > WIRE_MAX) { wire = false; return false; }
      schedule();
      return wire;
    }
    function setAutoRotate(on) { auto = !!on; lastT = 0; if (auto) schedule(); return auto; }
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
    const onDown = e => {
      if (!model) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.button === 2 || (e.shiftKey && e.pointerType !== "touch") });
      pinch = pinchState();
      if (e.button === 1 || e.button === 2) e.preventDefault();
    };
    const onMove = e => {
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
    };
    const release = e => { pointers.delete(e.pointerId); pinch = pinchState(); };
    const onWheel = e => { if (!model) return; e.preventDefault(); view = zoomBy(view, e.deltaY > 0 ? 0.9 : 1.1); schedule(); };
    const onCtx = e => e.preventDefault();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onCtx);
    if (root.ResizeObserver) { ro = new ResizeObserver(() => schedule()); ro.observe(canvas); }
    // Read-only test hooks.
    canvas.hqModelView = () => Object.assign({}, view, { triangles: model ? model.triangles : 0, webgl: !!gl });
    canvas.hqModelProject = p => { const { w, h } = size(); return model ? project(view, model.bounds, w / h, p) : null; };
    function snapshotPixelData() {
      draw();
      const { w, h } = size();
      const out = new Uint8ClampedArray(w * h * 4);
      if (gl) {
        const raw = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        for (let y = 0; y < h; y += 1) {
          const src = (h - 1 - y) * w * 4;
          out.set(raw.subarray(src, src + w * 4), y * w * 4);
        }
      } else {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const x = c.getContext("2d"); x.drawImage(canvas, 0, 0);
        out.set(x.getImageData(0, 0, w, h).data);
      }
      return { w, h, data: out };
    }
    canvas.hqModelSnapshot = () => {
      const snap = snapshotPixelData();
      const d = snap.data, c = { width: snap.w, height: snap.h }, bg = BG.map(v => Math.round(v * 255));
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) {
          n++; const X = px % c.width, Y = (px / c.width) | 0;
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
      }
      return { width: c.width, height: c.height, nonBackground: n, bbox: n ? [x0, y0, x1, y1] : null };
    };
    function snapshot() {
      return new Promise(function (res) {
        try {
          if (!gl) { draw(); canvas.toBlob(function (b) { res(b || null); }, "image/png"); return; }
          const snap = snapshotPixelData();
          const c = document.createElement("canvas");
          c.width = snap.w; c.height = snap.h;
          const x = c.getContext("2d");
          x.putImageData(new ImageData(snap.data, snap.w, snap.h), 0, 0);
          c.toBlob(function (b) { res(b || null); }, "image/png");
        } catch (_) { res(null); }
      });
    }
    // Release the GL context, its buffers and the observer: the sheet owning this canvas can close
    // and open another model without piling up WebGL contexts.
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (raf && root.cancelAnimationFrame) { try { root.cancelAnimationFrame(raf); } catch (_) {} }
      raf = 0;
      if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
      freeBuffers();
      model = null;
      pointers.clear();
      try {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", release);
        canvas.removeEventListener("pointercancel", release);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onCtx);
      } catch (_) {}
      if (gl) {
        try { if (prog) { gl.deleteProgram(prog); prog = null; } } catch (_) {}
        try { const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } catch (_) {}
        gl = null;
      }
    }
    return { setModel, fit: refit, draw, dispose, setWireframe, setAutoRotate, snapshot, get model() { return model; }, get wireframe() { return wire; }, get autoRotate() { return auto; }, get view() { return Object.assign({}, view); }, get webgl() { return !!gl; } };
  }

  const api = {
    LIMITS, ModelError, parse, parseAsync, parseInWorker, parseSTL, parseGLB, parseOBJ, parse3MF,
    project, orbit, pan, zoomBy, fit, DEFAULT_VIEW, viewer: modelViewer,
  };
  root.HQModel = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
