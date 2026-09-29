// Offline checks for the Lecteur 3D parsers (STL binary/ASCII, GLB) and view math. Fixtures are generated here.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../assets/hq-model-view.js");

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearV = (a, b, eps = 1e-5) => b.forEach((x, i) => near(a[i], x, eps));
const throwsFr = (fn, re) => assert.throws(fn, e => e instanceof M.ModelError && re.test(e.message), String(re));
const vert = (m, t, j) => Array.from(m.positions.slice(t * 9 + j * 3, t * 9 + j * 3 + 3));

// ---- STL fixtures ----
const CUBE = (() => {
  const v = [[0,0,0],[10,0,0],[10,20,0],[0,20,0],[0,0,30],[10,0,30],[10,20,30],[0,20,30]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return f.map(t => t.map(i => v[i]));
})();
function binarySTL(tris, header = "binary stl") {
  const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
  new TextEncoder().encodeInto(header, new Uint8Array(buf, 0, 80));
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.forEach((p, j) => p.forEach((x, k) => dv.setFloat32(84 + i * 50 + 12 + j * 12 + k * 4, x, true))));
  return buf;
}
const enc = s => { const u = new TextEncoder().encode(s); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
function asciiSTL(tris) {
  return enc("solid demo\n" + tris.map(t => "  facet normal 0 0 0\n    outer loop\n" + t.map(p => `      vertex ${p.map(x => x.toExponential(6)).join(" ")}\n`).join("") + "    endloop\n  endfacet\n").join("") + "endsolid demo\n");
}

{
  const m = M.parse("pièce.stl", binarySTL(CUBE));
  assert.equal(m.format, "STL binaire"); assert.equal(m.triangles, 12); assert.equal(m.colors, null);
  nearV(m.bounds.min, [0, 0, 0]); nearV(m.bounds.max, [10, 20, 30]); nearV(m.bounds.center, [5, 10, 15]);
  near(m.bounds.radius, Math.hypot(10, 20, 30) / 2);
  // Normals computed from the geometry (the fixture stores zero normals): bottom face points down, top up.
  nearV(Array.from(m.normals.slice(0, 3)), [0, 0, -1]); nearV(Array.from(m.normals.slice(18, 21)), [0, 0, 1]);
  for (let i = 0; i < m.normals.length; i += 3) near(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]), 1);
  // A binary STL whose 80-byte header starts with "solid" is still binary (size check first).
  assert.equal(M.parse("x.stl", binarySTL(CUBE, "solid but actually binary")).format, "STL binaire");
}
{
  const m = M.parse("tetra.STL", asciiSTL(CUBE.slice(0, 4)));
  assert.equal(m.format, "STL ASCII"); assert.equal(m.triangles, 4);
  nearV(vert(m, 0, 1), CUBE[0][1]);
  nearV(Array.from(m.normals.slice(0, 3)), [0, 0, -1]);
}
// Degenerate triangle: falls back to the stored facet normal, else +Z.
{
  const buf = binarySTL([[[0,0,0],[1,1,1],[2,2,2]]]); new DataView(buf).setFloat32(84, 1, true);
  nearV(Array.from(M.parse("d.stl", buf).normals.slice(0, 3)), [1, 0, 0]);
}
throwsFr(() => M.parse("x.stl", new ArrayBuffer(10)), /STL trop court/);
throwsFr(() => M.parse("x.stl", binarySTL(CUBE).slice(0, 84 + 50 * 5 + 7)), /tronqué/);
throwsFr(() => M.parse("x.stl", enc("solid x\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n endloop\nendsolid")), /moins de trois sommets/);
throwsFr(() => M.parse("x.stl", enc("solid x\n vertex 0 0 zz\n vertex 1 0 0\n vertex 0 1 0\nendsolid")), /coordonnée illisible/);
throwsFr(() => M.parse("x.stl", enc("solid empty\nendsolid empty\n")), /aucun sommet/);
throwsFr(() => M.parse("x.stl", binarySTL([])), /Aucun triangle/);
throwsFr(() => M.parse("x.stl", binarySTL(CUBE), { maxTriangles: 5 }), /trop détaillé pour le lecteur 3D : 12 triangles \(maximum 5/);
throwsFr(() => M.parse("x.stl", asciiSTL(CUBE), { maxTriangles: 5 }), /trop détaillé/);
throwsFr(() => M.parse("x.stl", binarySTL(CUBE), { maxBytes: 100 }), /trop volumineux/);
{  // NaN coordinates in a binary STL
  const buf = binarySTL(CUBE); new DataView(buf).setFloat32(84 + 12, NaN, true);
  throwsFr(() => M.parse("x.stl", buf), /non numériques/);
}

// ---- GLB builder ----
function glb(json, binParts) {
  const views = []; let o = 0;
  for (const part of binParts) { views.push({ buffer: 0, byteOffset: o, byteLength: part.byteLength }); o = (o + part.byteLength + 3) & ~3; }
  const binPadded = new Uint8Array(o);
  binParts.forEach((part, i) => binPadded.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), views[i].byteOffset));
  json = Object.assign({ asset: { version: "2.0" }, bufferViews: views, buffers: [{ byteLength: binPadded.length }] }, json);
  let js = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - js.length % 4) % 4; const jsp = new Uint8Array(js.length + pad).fill(0x20); jsp.set(js);
  const total = 12 + 8 + jsp.length + 8 + binPadded.length, out = new ArrayBuffer(total), dv = new DataView(out), u = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsp.length, true); dv.setUint32(16, 0x4e4f534a, true); u.set(jsp, 20);
  const b = 20 + jsp.length; dv.setUint32(b, binPadded.length, true); dv.setUint32(b + 4, 0x004e4942, true); u.set(binPadded, b + 8);
  return out;
}
// Unit quad in the glTF XY plane (normal +Z in glTF = -Y... after Y-up -> Z-up conversion it's +Y? see below).
const quadPos = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
const quadNor = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
const idx16 = new Uint16Array([0,1,2, 0,2,3]);
const idx8 = new Uint8Array([0,1,2, 0,2,3]);
const idx32 = new Uint32Array([0,1,2, 0,2,3]);
const baseJSON = {
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0,0,0], max: [1,1,0] },
    { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    { bufferView: 3, componentType: 5121, count: 6, type: "SCALAR" },
    { bufferView: 4, componentType: 5125, count: 6, type: "SCALAR" },
  ],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } }, {}],
  meshes: [
    { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] },
    { primitives: [{ attributes: { POSITION: 0 }, indices: 3, material: 1 }, { attributes: { POSITION: 0 }, indices: 4 }] },
  ],
  // Scene: root (translate +10 x) -> child A (mesh 0, scale 2) and child B (matrix: rotate 90° about glTF Y, mesh 1).
  // Node 3 is not in the scene and must be ignored. Mesh 0 is also used by node 4 (instancing), a child of B.
  nodes: [
    { translation: [10, 0, 0], children: [1, 2] },
    { mesh: 0, scale: [2, 2, 2] },
    { mesh: 1, matrix: [0,0,-1,0, 0,1,0,0, 1,0,0,0, 0,0,0,1], children: [4] },
    { mesh: 0, translation: [100, 100, 100] },
    { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  ],
  scenes: [{ nodes: [0] }], scene: 0,
};
const parts = [quadPos, quadNor, idx16, idx8, idx32];
const toZup = p => [p[0], -p[2], p[1]];
{
  const m = M.parse("scene.glb", glb(baseJSON, parts));
  assert.equal(m.format, "GLB");
  // node1 (2 tris) + node2 (2 prims x 2 tris) + node4 (2 tris) = 8
  assert.equal(m.triangles, 8);
  assert.deepEqual(m.notices, []);
  // Node 1: world = T(10,0,0) * S(2): vertex (1,1,0) -> (12,2,0) glTF -> Z-up (12,0,2)
  nearV(vert(m, 0, 2), toZup([12, 2, 0]));
  // Its NORMAL (0,0,1) glTF stays unit after the uniform scale -> Z-up (0,-1,0); red material.
  nearV(Array.from(m.normals.slice(0, 3)), toZup([0, 0, 1]));
  nearV(Array.from(m.colors.slice(0, 3)), [1, 0, 0]);
  // Node 2: matrix rotates +90° about Y: (x,y,z) -> (z,y,-x); then T(10,0,0). Vertex (1,0,0) -> (10,0,-1).
  // Triangles 2..3 are its first primitive (uint8 indices, blue), 4..5 the second (uint32 indices, no material -> grey).
  nearV(vert(m, 2, 1), toZup([10, 0, -1]));
  nearV(Array.from(m.colors.slice(2 * 9, 2 * 9 + 3)), [0, 0, 1]);
  nearV(Array.from(m.colors.slice(4 * 9, 4 * 9 + 3)), [0.8, 0.8, 0.8]);
  nearV(vert(m, 5, 1), vert(m, 3, 1));  // uint8 and uint32 index paths agree
  // No NORMAL on mesh 1: flat normals from the transformed triangle. The quad lies in glTF plane x=10 after rotation,
  // facing +/-X; flat normal must be unit and along X.
  near(Math.abs(m.normals[2 * 9]), 1);
  // Node 4 (child of node 2): world = T(10) * R_y(90) * R_z(90). Vertex (1,0,0) -R_z-> (0,1,0) -R_y-> (0,1,0) -T-> (10,1,0).
  nearV(vert(m, 6, 1), toZup([10, 1, 0]));
  // Node 3 (outside the scene) was ignored: nothing near 100.
  assert.ok(m.bounds.max.every(v => v < 50));
}
// Triangle strip + fan, no indices.
{
  const j = JSON.parse(JSON.stringify(baseJSON));
  j.meshes = [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }, { attributes: { POSITION: 0 }, mode: 6 }, { attributes: { POSITION: 0 }, mode: 1 }] }];
  j.nodes = [{ mesh: 0 }]; j.scenes = [{ nodes: [0] }];
  const m = M.parse("s.glb", glb(j, parts));
  assert.equal(m.triangles, 4);
  assert.ok(m.notices.some(n => /Points et lignes ignorés/.test(n)));
}
// Notices for ignored features; extensionsRequired is a clear error.
{
  const j = Object.assign(JSON.parse(JSON.stringify(baseJSON)), { extensionsUsed: ["KHR_materials_clearcoat"], textures: [{ source: 0 }], images: [{ uri: "x.png" }], animations: [{ channels: [], samplers: [] }] });
  const m = M.parse("n.glb", glb(j, parts));
  assert.ok(m.notices.some(n => /Extensions ignorées : KHR_materials_clearcoat/.test(n)));
  assert.ok(m.notices.some(n => /Textures non affichées/.test(n)));
  assert.ok(m.notices.some(n => /Animations et squelettes ignorés/.test(n)));
  const d = Object.assign(JSON.parse(JSON.stringify(baseJSON)), { extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] });
  throwsFr(() => M.parse("draco.glb", glb(d, parts)), /extensions non prises en charge : KHR_draco_mesh_compression/);
}
// Limits and malformed GLBs.
throwsFr(() => M.parse("big.glb", glb(baseJSON, parts), { maxTriangles: 7 }), /: 8 triangles \(maximum 7/);
throwsFr(() => M.parse("x.glb", new ArrayBuffer(8)), /GLB trop court/);
throwsFr(() => M.parse("x.glb", enc("not a glb file at all, just text")), /signature glTF absente/);
{
  const g = glb(baseJSON, parts);
  throwsFr(() => M.parse("x.glb", g.slice(0, g.byteLength - 16)), /tronqué/);
  const v1 = g.slice(0); new DataView(v1).setUint32(4, 1, true); throwsFr(() => M.parse("x.glb", v1), /Version glTF 1/);
  const badJson = g.slice(0); new Uint8Array(badJson)[20] = 0x7b + 1; throwsFr(() => M.parse("x.glb", badJson), /JSON illisible/);
}
for (const [mutate, re] of [
  [j => { j.accessors[2].count = 600; }, /hors limites/],
  [j => { j.accessors[0].sparse = { count: 1 }; }, /sparse/],
  [j => { j.buffers[0].uri = "scene.bin"; }, /données externes/],
  [j => { j.nodes[1].children = [0]; }, /cyclique/],
  [j => { j.meshes[0].primitives[0].indices = 1; }, /accesseur incorrect/],
  [j => { j.nodes[0].matrix = [1, 2, 3]; }, /matrice/],
  [j => { j.meshes[0].primitives[0].attributes = {}; }, /sans POSITION/],
]) {
  const j = JSON.parse(JSON.stringify(baseJSON));
  // Pre-fill bufferViews/buffers exactly as the builder would, so mutations can target them.
  const probe = glb(j, parts); const dv = new DataView(probe); const jl = dv.getUint32(12, true);
  const full = JSON.parse(new TextDecoder().decode(new Uint8Array(probe, 20, jl)));
  mutate(full);
  const bin = new Uint8Array(probe, 20 + jl + 8, dv.getUint32(20 + jl, true));
  let js = new TextEncoder().encode(JSON.stringify(full)); const pad = (4 - js.length % 4) % 4; const jsp = new Uint8Array(js.length + pad).fill(0x20); jsp.set(js);
  const total = 20 + jsp.length + 8 + bin.length, out = new ArrayBuffer(total), o = new DataView(out), u = new Uint8Array(out);
  o.setUint32(0, 0x46546c67, true); o.setUint32(4, 2, true); o.setUint32(8, total, true); o.setUint32(12, jsp.length, true); o.setUint32(16, 0x4e4f534a, true); u.set(jsp, 20);
  o.setUint32(20 + jsp.length, bin.length, true); o.setUint32(24 + jsp.length, 0x004e4942, true); u.set(bin, 28 + jsp.length);
  throwsFr(() => M.parse("m.glb", out), re);
}
{  // index out of range
  const bad = new Uint16Array([0, 1, 9, 0, 2, 3]);
  throwsFr(() => M.parse("x.glb", glb(baseJSON, [quadPos, quadNor, bad, idx8, idx32])), /indice de sommet hors limites/);
}
throwsFr(() => M.parse("x.obj", binarySTL(CUBE)), /STL ou GLB seulement/);

// ---- view math ----
{
  const m = M.parse("c.stl", binarySTL(CUBE)), V = M.DEFAULT_VIEW;
  // Fit: every vertex stays inside [-0.8, 0.8] for any orientation and aspect (bounding-sphere fit).
  for (const aspect of [0.5, 1, 2.4]) for (let i = 0; i < 40; i++) {
    const view = Object.assign({}, V, { yaw: i * 0.7, pitch: -1.48 + (i % 13) * 0.24 });
    for (let t = 0; t < m.triangles; t++) for (let j = 0; j < 3; j++) {
      const q = M.project(view, m.bounds, aspect, vert(m, t, j));
      assert.ok(Math.abs(q[0]) <= 0.8 + 1e-9 && Math.abs(q[1]) <= 0.8 + 1e-9 && Math.abs(q[2]) < 1, `fit ${q}`);
    }
  }
  const front = view => { let best = null; for (let t = 0; t < m.triangles; t++) for (let j = 0; j < 3; j++) { const p = vert(m, t, j), q = M.project(view, m.bounds, 1, p); if (!best || q[2] < best[1][2]) best = [p, q]; } return best[0]; };
  // Orbit: same convention as the Dessiner 3D view — the front of the model follows the drag.
  for (const [dx, dy, axis, sign] of [[20, 0, 0, 1], [-20, 0, 0, -1], [0, 20, 1, -1], [0, -20, 1, 1]]) {
    const p = front(V), a = M.project(V, m.bounds, 1, p), b = M.project(M.orbit(V, dx, dy), m.bounds, 1, p);
    assert.ok(Math.sign(b[axis] - a[axis]) === sign, `orbit ${dx},${dy}`);
  }
  assert.equal(M.orbit(V, 0, 1e6).pitch, 1.48); assert.equal(M.orbit(V, 0, -1e6).pitch, -1.48);
  // Pan: a drag of (dx, dy) CSS px moves every point by exactly that on a (w x h) canvas, at any aspect.
  for (const [w, h] of [[400, 300], [300, 600]]) {
    const aspect = w / h, p = [3, 4, 5], a = M.project(V, m.bounds, aspect, p), b = M.project(M.pan(V, 30, -12, w, h, aspect), m.bounds, aspect, p);
    near((b[0] - a[0]) * w / 2, 30); near(-(b[1] - a[1]) * h / 2, -12);
  }
  // Zoom limits and Recadrer.
  assert.equal(M.zoomBy(V, 1e9).zoom, 10); assert.equal(M.zoomBy(V, 1e-9).zoom, 0.15);
  const moved = M.pan(M.zoomBy(M.orbit(V, 50, 10), 3), 40, 40, 400, 300, 4 / 3), refit = M.fit(moved);
  assert.deepEqual([refit.zoom, refit.panX, refit.panY], [1, 0, 0]); assert.equal(refit.yaw, moved.yaw);
}

// ---- viewer with a stub canvas (no WebGL -> canvas 2D fallback): gestures drive the same math ----
{
  const noop = () => {}, handlers = {};
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 0, height: 0, handlers, getContext: k => (k === "2d" ? ctx : null), addEventListener: (k, f) => { handlers[k] = f; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }), setPointerCapture: noop };
  globalThis.requestAnimationFrame = f => { f(); return 1; };
  const v = M.viewer(canvas);
  assert.equal(v.webgl, false);
  v.setModel(M.parse("c.stl", binarySTL(CUBE)));
  const ev = (id, x, y, extra = {}) => Object.assign({ pointerId: id, clientX: x, clientY: y, button: 0, pointerType: "touch", preventDefault: noop }, extra);
  handlers.pointerdown(ev(1, 100, 100)); handlers.pointermove(ev(1, 150, 100)); handlers.pointerup(ev(1, 150, 100));
  near(v.view.yaw, M.DEFAULT_VIEW.yaw - 50 * 0.012);
  handlers.pointerdown(ev(2, 100, 100, { pointerType: "mouse", button: 2 })); handlers.pointermove(ev(2, 140, 70, { pointerType: "mouse" })); handlers.pointerup(ev(2, 140, 70));
  near(v.view.panX, 2 * 40 / 400 * (400 / 300)); near(v.view.panY, 60 / 300);
  handlers.pointerdown(ev(3, 100, 150)); handlers.pointerdown(ev(4, 200, 150));
  handlers.pointermove(ev(4, 250, 150)); handlers.pointermove(ev(4, 300, 150));
  assert.ok(v.view.zoom > 1.9, "pinch zoom"); const yaw = v.view.yaw;
  handlers.pointerup(ev(3, 100, 150)); handlers.pointerup(ev(4, 300, 150));
  assert.equal(v.view.yaw, yaw, "pinch does not orbit");
  handlers.wheel({ deltaY: -100, preventDefault: noop }); assert.ok(v.view.zoom > 2);
  v.fit(); assert.deepEqual([v.view.zoom, v.view.panX, v.view.panY], [1, 0, 0]);
  // Without WebGL, heavy models get a clear message instead of freezing.
  const big = { triangles: M.LIMITS.maxTriangles2D + 1 };
  assert.throws(() => v.setModel(big), e => e instanceof M.ModelError && /n'a pas WebGL/.test(e.message));
}
console.log("hq model (STL/GLB) checks ok");
