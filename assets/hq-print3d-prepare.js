/* Atelier 3D — Phase 3 Interactive 3D Prepare Viewport & Canonical Transform Engine.
 * Zero external CDN dependencies, ES2020. Matches hq_print3d_models.py transform_stl_triangles()
 * bit-for-bit in coordinate convention (Z-up, bed [0..bed.x] x [0..bed.y] x [0..bed.z]).
 *
 * Exposes window.HQPrepare (and module.exports for Node unit checks). */
(function (root) {
  "use strict";

  var WORKER_MIN_BYTES = 128 * 1024;
  var CHUNK_TRIS = 64;
  var MAX_CACHE_ENTRIES = 24;
  var MAX_CACHE_TRIANGLES = 1200000;
  var DEG2RAD = Math.PI / 180;
  var RAD2DEG = 180 / Math.PI;

  function clampScale(s) {
    var v = Number(s == null ? 1.0 : s);
    return Number.isFinite(v) ? Math.max(0.1, Math.min(10.0, v)) : 1.0;
  }

  function finiteOr(v, d) {
    var n = Number(v == null ? d : v);
    return Number.isFinite(n) ? n : d;
  }

  // ---- Canonical 3D Geometry Math (1:1 mirror of hq_print3d_models.py) ----

  function computeRawBounds(positions) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 3) {
      var x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
      if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    }
    var center = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5];
    var dims = [Math.max(0, hi[0] - lo[0]), Math.max(0, hi[1] - lo[1]), Math.max(0, hi[2] - lo[2])];
    return { min: lo, max: hi, center: center, dims: dims };
  }

  function computeTiltedStats(positions, rawBounds, scale, rotXDeg, rotYDeg, cacheHost) {
    var sc = clampScale(scale);
    var rxDeg = finiteOr(rotXDeg, 0), ryDeg = finiteOr(rotYDeg, 0);
    var cKey = null;
    if (cacheHost && typeof cacheHost === "object") {
      if (!cacheHost._tiltedCache) cacheHost._tiltedCache = Object.create(null);
      cKey = sc.toFixed(5) + "|" + rxDeg.toFixed(4) + "|" + ryDeg.toFixed(4);
      if (cacheHost._tiltedCache[cKey]) return cacheHost._tiltedCache[cKey];
    }
    var rb = (rawBounds && Array.isArray(rawBounds.min) && Array.isArray(rawBounds.max) && Array.isArray(rawBounds.center))
      ? rawBounds
      : computeRawBounds(positions);
    var rbDims = Array.isArray(rb.dims) ? rb.dims : [
      Math.max(0, rb.max[0] - rb.min[0]),
      Math.max(0, rb.max[1] - rb.min[1]),
      Math.max(0, rb.max[2] - rb.min[2]),
    ];
    var rx = rxDeg * DEG2RAD;
    var ry = ryDeg * DEG2RAD;
    var rcx = rb.center[0], rcy = rb.center[1], rcz = rb.center[2];
    var crx = Math.cos(rx), srx = Math.sin(rx);
    var cry = Math.cos(ry), sry = Math.sin(ry);

    var resStats;
    if (Math.abs(rx) <= 1e-7 && Math.abs(ry) <= 1e-7) {
      var hx = rbDims[0] * sc * 0.5, hy = rbDims[1] * sc * 0.5, hz = rbDims[2] * sc * 0.5;
      resStats = {
        rawCenter: rb.center.slice(),
        tiltedCenterXY: [0, 0],
        tiltedMinZ: -hz,
        dims: [rbDims[0] * sc, rbDims[1] * sc, rbDims[2] * sc],
        dimsUnscaled: rbDims.slice(),
        scale: sc,
        rotX: 0,
        rotY: 0,
        bounds: { min: [-hx, -hy, -hz], max: [hx, hy, hz] },
      };
    } else {
      var minX = Infinity, minY = Infinity, minZ = Infinity;
      var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (var i = 0; i < positions.length; i += 3) {
        var px = (positions[i] - rcx) * sc;
        var py = (positions[i + 1] - rcy) * sc;
        var pz = (positions[i + 2] - rcz) * sc;
        var x1 = px;
        var y1 = py * crx - pz * srx;
        var z1 = py * srx + pz * crx;
        var x2 = x1 * cry + z1 * sry;
        var y2 = y1;
        var z2 = -x1 * sry + z1 * cry;
        if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
        if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
        if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;
      }
      var tdx = Math.max(0, maxX - minX), tdy = Math.max(0, maxY - minY), tdz = Math.max(0, maxZ - minZ);
      resStats = {
        rawCenter: rb.center.slice(),
        tiltedCenterXY: [(minX + maxX) * 0.5, (minY + maxY) * 0.5],
        tiltedMinZ: minZ,
        dims: [tdx, tdy, tdz],
        dimsUnscaled: [tdx / sc, tdy / sc, tdz / sc],
        scale: sc,
        rotX: rxDeg,
        rotY: ryDeg,
        bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      };
    }
    if (cacheHost && cKey) {
      var ks = Object.keys(cacheHost._tiltedCache);
      if (ks.length >= 16) delete cacheHost._tiltedCache[ks[0]];
      cacheHost._tiltedCache[cKey] = resStats;
    }
    return resStats;
  }

  // Exact vertex-by-vertex canonical transform (mirrors hq_print3d_models.transform_stl_triangles)
  function transformVertices(positions, params, rawBounds) {
    var p = params || {};
    var rb = rawBounds || computeRawBounds(positions);
    var scale = clampScale(p.scale);
    var rotX = finiteOr(p.rot_x, 0), rotY = finiteOr(p.rot_y, 0), rotZ = finiteOr(p.rot_z, 0);
    var pxOff = finiteOr(p.x, 0) + finiteOr(p.ox, 0);
    var pyOff = finiteOr(p.y, 0) + finiteOr(p.oy, 0);
    var rawZ = finiteOr(p.z, 0);
    var pzOff = Math.abs(rawZ) <= 0.01 ? 0 : Math.max(0, rawZ);
    var stats = computeTiltedStats(positions, rb, scale, rotX, rotY);
    var rcx = rb.center[0], rcy = rb.center[1], rcz = rb.center[2];
    var tcx = stats.tiltedCenterXY[0], tcy = stats.tiltedCenterXY[1], tminZ = stats.tiltedMinZ;
    var rx = rotX * DEG2RAD, ry = rotY * DEG2RAD, rz = rotZ * DEG2RAD;
    var crx = Math.cos(rx), srx = Math.sin(rx);
    var cry = Math.cos(ry), sry = Math.sin(ry);
    var crz = Math.cos(rz), srz = Math.sin(rz);

    var out = new Float32Array(positions.length);
    var wmin = [Infinity, Infinity, Infinity], wmax = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 3) {
      var qx = (positions[i] - rcx) * scale;
      var qy = (positions[i + 1] - rcy) * scale;
      var qz = (positions[i + 2] - rcz) * scale;
      var y1 = qy * crx - qz * srx, z1 = qy * srx + qz * crx;
      var x2 = qx * cry + z1 * sry, y2 = y1, z2 = -qx * sry + z1 * cry;
      var lx = x2 - tcx, ly = y2 - tcy, lz = z2 - tminZ;
      var wx = lx * crz - ly * srz + pxOff;
      var wy = lx * srz + ly * crz + pyOff;
      var wz = lz + pzOff;
      out[i] = wx; out[i + 1] = wy; out[i + 2] = wz;
      if (wx < wmin[0]) wmin[0] = wx; if (wx > wmax[0]) wmax[0] = wx;
      if (wy < wmin[1]) wmin[1] = wy; if (wy > wmax[1]) wmax[1] = wy;
      if (wz < wmin[2]) wmin[2] = wz; if (wz > wmax[2]) wmax[2] = wz;
    }
    return { positions: out, worldBounds: { min: wmin, max: wmax }, stats: stats };
  }

  // Build column-major 4x4 matrix matching transformVertices() exactly
  function buildItemMatrix(stats, it, outMat) {
    var m = outMat || new Float32Array(16);
    var sc = stats ? stats.scale : clampScale(it.scale);
    var rcx = stats ? stats.rawCenter[0] : 0, rcy = stats ? stats.rawCenter[1] : 0, rcz = stats ? stats.rawCenter[2] : 0;
    var tcx = stats ? stats.tiltedCenterXY[0] : 0, tcy = stats ? stats.tiltedCenterXY[1] : 0, tminZ = stats ? stats.tiltedMinZ : 0;
    var rx = finiteOr(it.rot_x, 0) * DEG2RAD, ry = finiteOr(it.rot_y, 0) * DEG2RAD, rz = finiteOr(it.rot_z, 0) * DEG2RAD;
    var cx = Math.cos(rx), sx = Math.sin(rx);
    var cy = Math.cos(ry), sy = Math.sin(ry);
    var cz = Math.cos(rz), sz = Math.sin(rz);

    // R_tilt = Ry * Rx
    var r00 = cy, r01 = sy * sx, r02 = sy * cx;
    var r10 = 0,  r11 = cx,      r12 = -sx;
    var r20 = -sy, r21 = cy * sx, r22 = cy * cx;

    // R = Rz * R_tilt
    var a00 = (cz * r00 - sz * r10) * sc, a01 = (cz * r01 - sz * r11) * sc, a02 = (cz * r02 - sz * r12) * sc;
    var a10 = (sz * r00 + cz * r10) * sc, a11 = (sz * r01 + cz * r11) * sc, a12 = (sz * r02 + cz * r12) * sc;
    var a20 = r20 * sc,                   a21 = r21 * sc,                   a22 = r22 * sc;

    // P2_shift = (-tcx, -tcy, -tminZ); after Rz and final + (x, y, max(0, z))
    var tx0 = -tcx, ty0 = -tcy, tz0 = -tminZ;
    var shiftX = tx0 * cz - ty0 * sz + finiteOr(it.x, 0);
    var shiftY = tx0 * sz + ty0 * cz + finiteOr(it.y, 0);
    var shiftZ = tz0 + Math.max(0, finiteOr(it.z, 0));

    var px = -(a00 * rcx + a01 * rcy + a02 * rcz) + shiftX;
    var py = -(a10 * rcx + a11 * rcy + a12 * rcz) + shiftY;
    var pz = -(a20 * rcx + a21 * rcy + a22 * rcz) + shiftZ;

    m[0] = a00; m[1] = a10; m[2] = a20;  m[3] = 0;
    m[4] = a01; m[5] = a11; m[6] = a21;  m[7] = 0;
    m[8] = a02; m[9] = a12; m[10] = a22; m[11] = 0;
    m[12] = px; m[13] = py; m[14] = pz;  m[15] = 1;
    return m;
  }

  function layFlatAnglesForNormal(nx, ny, nz) {
    var l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-9)) throw new Error("Face dégénérée impossible à poser à plat");
    var ux = nx / l, uy = ny / l, uz = nz / l;
    var h = Math.hypot(uy, uz);
    var rx = 0, nz1 = 0;
    if (h > 1e-9) {
      rx = Math.atan2(-uy, -uz);
      nz1 = -h;
    }
    var ry = Math.atan2(ux, -nz1);
    return [+(rx * RAD2DEG).toFixed(4), +(ry * RAD2DEG).toFixed(4)];
  }

  function bestLayFlatAngles(positions) {
    var buckets = Object.create(null);
    for (var i = 0; i < positions.length; i += 9) {
      var ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
      var bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
      var cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      var l = Math.hypot(cx, cy, cz);
      if (!(l > 1e-8)) continue;
      var nx = cx / l, ny = cy / l, nz = cz / l;
      var key = Math.round(nx * 20) + "," + Math.round(ny * 20) + "," + Math.round(nz * 20);
      var area = 0.5 * l;
      var e = buckets[key];
      if (!e) buckets[key] = [area, nx * area, ny * area, nz * area];
      else { e[0] += area; e[1] += nx * area; e[2] += ny * area; e[3] += nz * area; }
    }
    var best = null;
    var keys = Object.keys(buckets);
    for (var k = 0; k < keys.length; k++) {
      var cur = buckets[keys[k]];
      if (!best || cur[0] > best[0]) best = cur;
    }
    if (!best) return [0, 0];
    return layFlatAnglesForNormal(best[1], best[2], best[3]);
  }

  // ---- OBB & SAT Collision Helpers (shared semantics with Phase 2 backend) ----

  function itemFootprintCorners(it) {
    var hw = (finiteOr(it.dx, 20) * clampScale(it.scale)) * 0.5;
    var hd = (finiteOr(it.dy, 20) * clampScale(it.scale)) * 0.5;
    var rad = finiteOr(it.rot_z, 0) * DEG2RAD;
    var cs = Math.cos(rad), sn = Math.sin(rad);
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(function (pt) {
      return [finiteOr(it.x, 0) + pt[0] * cs - pt[1] * sn, finiteOr(it.y, 0) + pt[0] * sn + pt[1] * cs];
    });
  }

  function itemRotatedSpan(it) {
    var rad = finiteOr(it.rot_z, 0) * DEG2RAD;
    var ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    var w = finiteOr(it.dx, 20) * clampScale(it.scale);
    var d = finiteOr(it.dy, 20) * clampScale(it.scale);
    return [w * ca + d * sa, w * sa + d * ca];
  }

  function itemBelowPlate(it) {
    return finiteOr(it.z, 0) < -0.01;
  }

  function itemElevated(it) {
    return finiteOr(it.z, 0) > 0.01;
  }

  function itemOutOfBounds(it, bed) {
    var corners = itemFootprintCorners(it);
    var z0 = Math.max(0, finiteOr(it.z, 0));
    var topZ = z0 + finiteOr(it.dz, 20) * clampScale(it.scale);
    if (topZ > finiteOr(bed && bed.z, 256) + 0.25) return true;
    for (var i = 0; i < corners.length; i++) {
      if (corners[i][0] < -0.25 || corners[i][0] > bed.x + 0.25 || corners[i][1] < -0.25 || corners[i][1] > bed.y + 0.25) {
        return true;
      }
    }
    return false;
  }

  function itemsCollide(a, b) {
    var az0 = Math.max(0, finiteOr(a.z, 0)), az1 = az0 + finiteOr(a.dz, 20) * clampScale(a.scale);
    var bz0 = Math.max(0, finiteOr(b.z, 0)), bz1 = bz0 + finiteOr(b.dz, 20) * clampScale(b.scale);
    if (az1 <= bz0 + 0.05 || bz1 <= az0 + 0.05) {
      // Conservative 2D OBB check matches backend _sat_obb_collide when Z overlaps or co-planar
    }
    var c1 = itemFootprintCorners(a), c2 = itemFootprintCorners(b);
    var polys = [c1, c2];
    for (var p = 0; p < 2; p++) {
      var poly = polys[p];
      for (var i = 0; i < 4; i++) {
        var q0 = poly[i], q1 = poly[(i + 1) % 4];
        var ex = q1[0] - q0[0], ey = q1[1] - q0[1];
        var el = Math.hypot(ex, ey);
        if (el <= 1e-6) continue;
        var nx = -ey / el, ny = ex / el;
        var min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
        for (var k = 0; k < 4; k++) {
          var v1 = c1[k][0] * nx + c1[k][1] * ny;
          if (v1 < min1) min1 = v1; if (v1 > max1) max1 = v1;
          var v2 = c2[k][0] * nx + c2[k][1] * ny;
          if (v2 < min2) min2 = v2; if (v2 > max2) max2 = v2;
        }
        if (Math.min(max1, max2) - Math.max(min1, min2) <= 0.5) return false;
      }
    }
    return true;
  }

  // ---- Ray-Mesh Picking Utilities ----

  function buildChunkBoxes(positions) {
    var triCount = Math.floor(positions.length / 9);
    var nChunks = Math.ceil(triCount / CHUNK_TRIS);
    var boxes = new Float32Array(nChunks * 6);
    for (var c = 0; c < nChunks; c++) {
      var tStart = c * CHUNK_TRIS, tEnd = Math.min(triCount, tStart + CHUNK_TRIS);
      var x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (var t = tStart; t < tEnd; t++) {
        var o = t * 9;
        for (var v = 0; v < 3; v++) {
          var vx = positions[o + v * 3], vy = positions[o + v * 3 + 1], vz = positions[o + v * 3 + 2];
          if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
          if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
          if (vz < z0) z0 = vz; if (vz > z1) z1 = vz;
        }
      }
      var b = c * 6;
      boxes[b] = x0; boxes[b + 1] = y0; boxes[b + 2] = z0;
      boxes[b + 3] = x1; boxes[b + 4] = y1; boxes[b + 5] = z1;
    }
    return boxes;
  }

  function invert4x4(m) {
    var inv = new Float32Array(16);
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    var b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    var b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    var b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) <= 1e-18) return null;
    det = 1.0 / det;
    inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return inv;
  }

  function rayHitsAABB(ox, oy, oz, dx, dy, dz, bx0, by0, bz0, bx1, by1, bz1) {
    var invX = Math.abs(dx) > 1e-12 ? 1 / dx : 1e12;
    var invY = Math.abs(dy) > 1e-12 ? 1 / dy : 1e12;
    var invZ = Math.abs(dz) > 1e-12 ? 1 / dz : 1e12;
    var tx0 = (bx0 - ox) * invX, tx1 = (bx1 - ox) * invX;
    var tmin = Math.min(tx0, tx1), tmax = Math.max(tx0, tx1);
    var ty0 = (by0 - oy) * invY, ty1 = (by1 - oy) * invY;
    tmin = Math.max(tmin, Math.min(ty0, ty1)); tmax = Math.min(tmax, Math.max(ty0, ty1));
    var tz0 = (bz0 - oz) * invZ, tz1 = (bz1 - oz) * invZ;
    tmin = Math.max(tmin, Math.min(tz0, tz1)); tmax = Math.min(tmax, Math.max(tz0, tz1));
    return tmax >= Math.max(0, tmin);
  }

  function intersectRayMeshLocal(mesh, invMat, roWorld, rdWorld) {
    var positions = mesh.positions;
    if (!positions || positions.length < 9 || !invMat) return null;
    // Transform world ray into local space
    var ox = invMat[0] * roWorld[0] + invMat[4] * roWorld[1] + invMat[8] * roWorld[2] + invMat[12];
    var oy = invMat[1] * roWorld[0] + invMat[5] * roWorld[1] + invMat[9] * roWorld[2] + invMat[13];
    var oz = invMat[2] * roWorld[0] + invMat[6] * roWorld[1] + invMat[10] * roWorld[2] + invMat[14];
    var dx = invMat[0] * rdWorld[0] + invMat[4] * rdWorld[1] + invMat[8] * rdWorld[2];
    var dy = invMat[1] * rdWorld[0] + invMat[5] * rdWorld[1] + invMat[9] * rdWorld[2];
    var dz = invMat[2] * rdWorld[0] + invMat[6] * rdWorld[1] + invMat[10] * rdWorld[2];

    var rb = mesh.rawBounds;
    if (!rayHitsAABB(ox, oy, oz, dx, dy, dz, rb.min[0], rb.min[1], rb.min[2], rb.max[0], rb.max[1], rb.max[2])) {
      return null;
    }

    var triCount = Math.floor(positions.length / 9);
    var boxes = mesh.chunkBoxes;
    if (!boxes) { boxes = buildChunkBoxes(positions); mesh.chunkBoxes = boxes; }
    var nChunks = boxes.length / 6;
    var bestT = Infinity, bestFace = -1;
    var bestNx = 0, bestNy = 0, bestNz = 1;

    for (var c = 0; c < nChunks; c++) {
      var bi = c * 6;
      if (!rayHitsAABB(ox, oy, oz, dx, dy, dz, boxes[bi], boxes[bi + 1], boxes[bi + 2], boxes[bi + 3], boxes[bi + 4], boxes[bi + 5])) {
        continue;
      }
      var tStart = c * CHUNK_TRIS, tEnd = Math.min(triCount, tStart + CHUNK_TRIS);
      for (var t = tStart; t < tEnd; t++) {
        var o = t * 9;
        var v0x = positions[o], v0y = positions[o + 1], v0z = positions[o + 2];
        var e1x = positions[o + 3] - v0x, e1y = positions[o + 4] - v0y, e1z = positions[o + 5] - v0z;
        var e2x = positions[o + 6] - v0x, e2y = positions[o + 7] - v0y, e2z = positions[o + 8] - v0z;
        var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        var det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-10) continue;
        var invDet = 1 / det;
        var sx = ox - v0x, sy = oy - v0y, sz = oz - v0z;
        var u = (sx * px + sy * py + sz * pz) * invDet;
        if (u < 0 || u > 1) continue;
        var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        var v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < 0 || u + v > 1) continue;
        var hitT = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (hitT > 1e-4 && hitT < bestT) {
          var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          var nl = Math.hypot(nx, ny, nz);
          if (nl > 1e-9) {
            bestT = hitT; bestFace = t;
            bestNx = nx / nl; bestNy = ny / nl; bestNz = nz / nl;
          }
        }
      }
    }
    if (bestFace < 0) return null;
    return { t: bestT, faceIndex: bestFace, localNormal: [bestNx, bestNy, bestNz] };
  }

  // ---- Shared Mesh Loading & Reference-Counted Cache ----

  function createMeshStore(opts) {
    var options = opts || {};
    var fetchStlFn = options.fetchStl;
    var parseImpl = options.parseStl;
    var entries = Object.create(null); // modelId -> { status, refCount, version, meshRev, data, error, promise, abort, lastUsed }
    var totalTriangles = 0;
    var revSeq = 0;

    function resolveRequestedVersion(m, optArg) {
      var optObj = (optArg && typeof optArg === "object") ? optArg : null;
      var v = (optObj && optObj.version) || (m && (m.source_sha256 || m.version)) || "";
      if (!v && m && (m.size != null || m.mtime != null)) {
        v = String(m.size != null ? m.size : "") + ":" + String(m.mtime != null ? m.mtime : "");
      }
      return String(v || "");
    }

    function evictEntry(id) {
      var e = entries[id];
      if (!e) return;
      if (e.abort && e.status === "loading") { try { e.abort.abort(); } catch (_) {} }
      if (e.data && e.data.triangles) totalTriangles = Math.max(0, totalTriangles - e.data.triangles);
      delete entries[id];
    }

    function evictIfNeeded(protectedId) {
      var ids = Object.keys(entries);
      if (ids.length <= MAX_CACHE_ENTRIES && totalTriangles <= MAX_CACHE_TRIANGLES) return;
      ids.sort(function (a, b) { return (entries[a].lastUsed || 0) - (entries[b].lastUsed || 0); });
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var e = entries[id];
        if (id === protectedId || !e || e.refCount > 0 || e.status === "loading") continue;
        evictEntry(id);
        if (Object.keys(entries).length <= MAX_CACHE_ENTRIES && totalTriangles <= MAX_CACHE_TRIANGLES) break;
      }
    }

    function retain(modelId) {
      var e = entries[modelId];
      if (e) { e.refCount += 1; e.lastUsed = Date.now(); }
    }

    function release(modelId) {
      var e = entries[modelId];
      if (!e) return;
      e.refCount = Math.max(0, e.refCount - 1);
      if (e.refCount === 0 && e.status === "loading" && e.abort) {
        try { e.abort.abort(); } catch (_) {}
      }
    }

    function invalidate(modelId) {
      if (!modelId) return;
      evictEntry(String(modelId));
    }

    function cancel(modelId) {
      var e = entries[modelId];
      if (!e || e.status !== "loading") return;
      if (e.abort) { try { e.abort.abort(); } catch (_) {} }
      delete entries[modelId];
    }

    function getCached(modelId, expectedVersion) {
      var e = entries[modelId];
      if (!e || e.status !== "ready" || !e.data) return null;
      if (expectedVersion && e.version && String(expectedVersion) !== e.version) return null;
      return e.data;
    }

    function getEntry(modelId) {
      return entries[modelId] || null;
    }

    function acquire(model, optOrProgress) {
      var m = model || {};
      var id = String(m.id || "");
      var name = String(m.name || "modele.stl");
      var ext = String(m.ext || ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || "")).toLowerCase();
      if (!id) return Promise.reject(new Error("Identifiant de modèle manquant"));

      var optObj = (optOrProgress && typeof optOrProgress === "object") ? optOrProgress : null;
      var onProgress = typeof optOrProgress === "function" ? optOrProgress : (optObj && typeof optObj.onProgress === "function" ? optObj.onProgress : null);
      var forceReload = !!(optObj && optObj.force);
      var reqVersion = resolveRequestedVersion(m, optObj);

      if (ext !== "stl") {
        var unsup = {
          supported: false, format: ext || "inconnu",
          message: "Format ." + (ext || "?") + " non éditable dans Préparer 3D (utilise .stl pour la préparation multi-objets).",
        };
        entries[id] = { status: "unsupported", refCount: 1, version: reqVersion, meshRev: ++revSeq, data: null, error: unsup.message, lastUsed: Date.now() };
        return Promise.resolve(unsup);
      }

      var cur = entries[id];
      var versionMatch = !reqVersion || (cur && cur.version === reqVersion);
      if (!forceReload && cur && cur.status === "ready" && cur.data && versionMatch) {
        cur.refCount += 1;
        cur.lastUsed = Date.now();
        return Promise.resolve(cur.data);
      }
      if (!forceReload && cur && cur.status === "loading" && cur.promise && versionMatch) {
        cur.refCount += 1;
        return cur.promise;
      }
      if (cur && (forceReload || !versionMatch)) {
        evictEntry(id);
      }

      var abort = typeof AbortController === "function" ? new AbortController() : null;
      var t0 = Date.now();
      var entry = {
        status: "loading", refCount: 1, version: reqVersion, meshRev: ++revSeq,
        data: null, error: "", abort: abort, promise: null, lastUsed: t0,
      };
      entries[id] = entry;

      var parseBuffer = function (buf) {
        var HQM = root.HQModel;
        if (typeof parseImpl === "function") return Promise.resolve(parseImpl(name, buf));
        if (!HQM) throw new Error("Module HQModel indisponible.");
        if (buf.byteLength >= WORKER_MIN_BYTES && typeof Worker === "function" && typeof HQM.parseInWorker === "function") {
          entry.workerUsed = true;
          return HQM.parseInWorker(name, buf);
        }
        entry.workerUsed = false;
        return Promise.resolve(HQM.parse(name, buf));
      };

      var url = "/api/print3d/models/file?id=" + encodeURIComponent(id);
      var p = (typeof fetchStlFn === "function"
        ? fetchStlFn(url, { signal: abort ? abort.signal : undefined, onProgress: onProgress, version: reqVersion })
        : fetch(url, { credentials: "same-origin", signal: abort ? abort.signal : undefined, cache: "no-store" }).then(function (r) {
            if (!r.ok) throw new Error("Fichier STL illisible");
            var hdrSha = (r.headers && (r.headers.get("X-Model-Sha256") || r.headers.get("ETag"))) || "";
            return r.arrayBuffer().then(function (ab) {
              var cleanSha = String(hdrSha).replace(/^["']|["']$/g, "").trim();
              if (cleanSha) try { Object.defineProperty(ab, "_hqVersion", { value: cleanSha }); } catch (_) {}
              return ab;
            });
          }))
        .then(function (buf) {
          if (entries[id] !== entry || (abort && abort.signal && abort.signal.aborted)) {
            var abErr = new Error("Chargement annulé"); abErr.name = "AbortError"; throw abErr;
          }
          if (buf && buf._hqVersion) {
            entry.version = String(buf._hqVersion);
          }
          return parseBuffer(buf);
        })
        .then(function (parsed) {
          if (entries[id] !== entry) return null;
          var rb = parsed.bounds || computeRawBounds(parsed.positions);
          var rawDims = [
            Math.max(0, rb.max[0] - rb.min[0]),
            Math.max(0, rb.max[1] - rb.min[1]),
            Math.max(0, rb.max[2] - rb.min[2]),
          ];
          var data = {
            supported: true,
            modelId: id,
            sourceVersion: entry.version,
            meshRev: entry.meshRev,
            format: parsed.format || "STL",
            triangles: parsed.triangles,
            positions: parsed.positions,
            normals: parsed.normals,
            volume_mm3: parsed.volume_mm3,
            rawBounds: { min: rb.min.slice(), max: rb.max.slice(), center: rb.center.slice(), dims: rawDims },
            chunkBoxes: null,
            parseMs: Date.now() - t0,
            workerUsed: !!entry.workerUsed,
          };
          entry.status = "ready";
          entry.data = data;
          entry.lastUsed = Date.now();
          totalTriangles += data.triangles;
          evictIfNeeded(id);
          return data;
        })
        .catch(function (err) {
          if (entries[id] === entry) {
            entry.status = (err && err.name === "AbortError") ? "cancelled" : "error";
            entry.error = (err && err.message) || "Erreur STL";
          }
          throw err;
        });
      entry.promise = p;
      return p;
    }

    function dispose() {
      Object.keys(entries).forEach(function (id) {
        var e = entries[id];
        if (e && e.abort) { try { e.abort.abort(); } catch (_) {} }
      });
      entries = Object.create(null);
      totalTriangles = 0;
    }

    return {
      acquire: acquire,
      retain: retain,
      release: release,
      invalidate: invalidate,
      cancel: cancel,
      getCached: getCached,
      getEntry: getEntry,
      dispose: dispose,
      get size() { return Object.keys(entries).length; },
      get totalTriangles() { return totalTriangles; },
    };
  }

  // ---- Interactive 3D WebGL Viewport (with 2D Software Fallback) ----

  function parseHexRgb01(hex) {
    if (typeof hex !== "string") return [0.22, 0.74, 0.97];
    var h = hex.trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0.22, 0.74, 0.97];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  function mat4Mul(a, b) {
    var out = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function mat4Perspective(fovDeg, aspect, near, far) {
    var f = 1.0 / Math.tan((fovDeg * DEG2RAD) * 0.5), nf = 1 / (near - far);
    var out = new Float32Array(16);
    out[0] = f / Math.max(0.1, aspect);
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = (2 * far * near) * nf;
    return out;
  }

  function mat4LookAt(eye, target) {
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    // Z-up right = normalize(up x z)
    var ux = 0, uy = 0, uz = 1;
    var rx = uy * zz - uz * zy, ry = uz * zx - ux * zz, rz = ux * zy - uy * zx;
    var rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; } else { rx /= rl; ry /= rl; rz /= rl; }
    var vux = zy * rz - zz * ry, vuy = zz * rx - zx * rz, vuz = zx * ry - zy * rx;
    var out = new Float32Array(16);
    out[0] = rx;  out[4] = ry;  out[8] = rz;   out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    out[1] = vux; out[5] = vuy; out[9] = vuz;  out[13] = -(vux * eye[0] + vuy * eye[1] + vuz * eye[2]);
    out[2] = zx;  out[6] = zy;  out[10] = zz;  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function createViewport(canvas, opts) {
    var cfg = opts || {};
    var onSelect = typeof cfg.onSelect === "function" ? cfg.onSelect : null;
    var onDragStart = typeof cfg.onDragStart === "function" ? cfg.onDragStart : null;
    var onDragMove = typeof cfg.onDragMove === "function" ? cfg.onDragMove : null;
    var onDragEnd = typeof cfg.onDragEnd === "function" ? cfg.onDragEnd : null;
    var onFacePick = typeof cfg.onFacePick === "function" ? cfg.onFacePick : null;
    var onFocusRequest = typeof cfg.onFocusRequest === "function" ? cfg.onFocusRequest : null;
    var onCameraChange = typeof cfg.onCameraChange === "function" ? cfg.onCameraChange : null;
    var onContextChange = typeof cfg.onContextChange === "function" ? cfg.onContextChange : null;

    var state = {
      bed: { x: 256, y: 256, z: 256 },
      items: [],
      selected: -1,
      tools: [{ color: "#38bdf8" }, { color: "#f97316" }, { color: "#22c55e" }, { color: "#a855f7" }],
      issues: { oob: [], belowPlate: [], collideSet: {}, pairs: [] },
      meshes: Object.create(null), // model_id -> cached mesh data
      statsMap: Object.create(null), // itemIndex -> tiltedStats
      interactionMode: "auto", // "auto" | "camera" | "move" | "layflat"
    };

    var cam = cfg.initialCamera ? Object.assign({}, cfg.initialCamera) : {
      yaw: 0.72, pitch: 0.56, dist: 380, target: [128, 128, 22],
    };

    var gl = null;
    try {
      var glOpts = { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" };
      gl = canvas.getContext("webgl2", glOpts) || canvas.getContext("webgl", glOpts) || canvas.getContext("experimental-webgl", glOpts);
    } catch (_) { gl = null; }
    var ctx2d = gl ? null : (typeof canvas.getContext === "function" ? canvas.getContext("2d") : null);

    var meshProg = null, lineProg = null;
    var vbos = Object.create(null); // model_id -> { posBuf, normBuf, triCount, meshRev, glGen }
    var boxVbo = null; // shared 1x1x1 centered-XY, Z[0..1] unit cube fallback triangles + wireframe
    var boxWireVbo = null;
    var bedKey = "";
    var bedVbos = null;
    var disposed = false;
    var contextLost = false;
    var glGen = 1;
    var rafId = 0;
    var ro = null;
    var drawCount = 0;
    var lastFrameMs = 0;
    var lastVP = new Float32Array(16), lastInvVP = new Float32Array(16), lastEye = [0, 0, 0];

    function compileProgram(vSrc, fSrc, attribs, uniforms) {
      if (!gl) return null;
      var sh = function (type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
        return s;
      };
      var prog = gl.createProgram();
      var vs = sh(gl.VERTEX_SHADER, vSrc), fs = sh(gl.FRAGMENT_SHADER, fSrc);
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link error");
      var loc = { prog: prog, a: {}, u: {} };
      attribs.forEach(function (k) { loc.a[k] = gl.getAttribLocation(prog, k); });
      uniforms.forEach(function (k) { loc.u[k] = gl.getUniformLocation(prog, k); });
      return loc;
    }

    function initGLResources() {
      if (!gl || contextLost) return;
      try {
        meshProg = compileProgram(
          [
            "attribute vec3 aPos; attribute vec3 aNorm;",
            "uniform mat4 uVP; uniform mat4 uModel;",
            "varying vec3 vNorm; varying vec3 vWorld;",
            "void main(){",
            "  vec4 wp = uModel * vec4(aPos, 1.0);",
            "  vWorld = wp.xyz;",
            "  vNorm = normalize(mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNorm);",
            "  gl_Position = uVP * wp;",
            "}"
          ].join("\n"),
          [
            "precision mediump float;",
            "varying vec3 vNorm; varying vec3 vWorld;",
            "uniform vec3 uColor; uniform vec3 uTint; uniform float uTintMix;",
            "uniform vec3 uEye;",
            "void main(){",
            "  vec3 n = normalize(vNorm);",
            "  vec3 v = normalize(uEye - vWorld);",
            "  if (dot(n, v) < 0.0) n = -n;",
            "  vec3 l1 = normalize(vec3(0.45, -0.55, 0.78));",
            "  vec3 l2 = normalize(vec3(-0.65, 0.40, 0.35));",
            "  float diff = 0.24 + 0.56 * max(dot(n, l1), 0.0) + 0.24 * max(dot(n, l2), 0.0);",
            "  float hemi = 0.08 * (0.5 + 0.5 * n.z);",
            "  vec3 h = normalize(l1 + v);",
            "  float spec = 0.14 * pow(max(dot(n, h), 0.0), 28.0);",
            "  vec3 base = mix(uColor, uTint, uTintMix);",
            "  vec3 col = base * (diff + hemi) + vec3(spec);",
            "  gl_FragColor = vec4(col, 1.0);",
            "}"
          ].join("\n"),
          ["aPos", "aNorm"], ["uVP", "uModel", "uColor", "uTint", "uTintMix", "uEye"]
        );
        lineProg = compileProgram(
          "attribute vec3 aPos; attribute vec4 aCol; uniform mat4 uMVP; varying vec4 vCol; void main(){ vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }",
          "precision mediump float; varying vec4 vCol; void main(){ gl_FragColor = vCol; }",
          ["aPos", "aCol"], ["uMVP"]
        );
        // Unit fallback box triangles [-0.5..0.5, -0.5..0.5, 0..1]
        var pts = [], norms = [];
        var addTri = function (a, b, c, n) { pts.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); for (var k = 0; k < 3; k++) norms.push(n[0], n[1], n[2]); };
        var faces = [
          [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0, -1]],
          [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1], [0, 0, 1]],
          [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, -0.5, 1], [0, -1, 0]],
          [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [-0.5, 0.5, 1], [0, 1, 0]],
          [[-0.5, -0.5, 0], [-0.5, 0.5, 0], [-0.5, 0.5, 1], [-0.5, -0.5, 1], [-1, 0, 0]],
          [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [0.5, -0.5, 1], [1, 0, 0]],
        ];
        faces.forEach(function (f) { addTri(f[0], f[1], f[2], f[4]); addTri(f[0], f[2], f[3], f[4]); });
        boxVbo = { posBuf: gl.createBuffer(), normBuf: gl.createBuffer(), triCount: 12 };
        gl.bindBuffer(gl.ARRAY_BUFFER, boxVbo.posBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, boxVbo.normBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(norms), gl.STATIC_DRAW);
        boxWireVbo = gl.createBuffer();
      } catch (_) {
        gl = null;
        if (!ctx2d && typeof canvas.getContext === "function") ctx2d = canvas.getContext("2d");
      }
    }

    function freeGLResources(contextDead) {
      if (!gl) return;
      var canDelete = !contextDead && !(typeof gl.isContextLost === "function" && gl.isContextLost());
      if (canDelete) {
        Object.keys(vbos).forEach(function (id) {
          var b = vbos[id];
          if (b.posBuf) gl.deleteBuffer(b.posBuf);
          if (b.normBuf) gl.deleteBuffer(b.normBuf);
        });
        if (boxVbo) { gl.deleteBuffer(boxVbo.posBuf); gl.deleteBuffer(boxVbo.normBuf); }
        if (boxWireVbo) gl.deleteBuffer(boxWireVbo);
        if (bedVbos) {
          gl.deleteBuffer(bedVbos.platePos); gl.deleteBuffer(bedVbos.plateCol);
          gl.deleteBuffer(bedVbos.linesPos); gl.deleteBuffer(bedVbos.linesCol);
        }
        if (meshProg) gl.deleteProgram(meshProg.prog);
        if (lineProg) gl.deleteProgram(lineProg.prog);
      }
      vbos = Object.create(null);
      boxVbo = null;
      boxWireVbo = null;
      bedVbos = null;
      bedKey = "";
      meshProg = null;
      lineProg = null;
    }

    function ensureBedBuffers() {
      if (!gl) return;
      var bx = state.bed.x, by = state.bed.y, bz = state.bed.z;
      var key = bx + "," + by + "," + bz;
      if (bedVbos && bedKey === key) return;
      if (bedVbos) {
        gl.deleteBuffer(bedVbos.platePos); gl.deleteBuffer(bedVbos.plateCol);
        gl.deleteBuffer(bedVbos.linesPos); gl.deleteBuffer(bedVbos.linesCol);
      }
      bedKey = key;
      var platePos = new Float32Array([0, 0, -0.05, bx, 0, -0.05, bx, by, -0.05, 0, 0, -0.05, bx, by, -0.05, 0, by, -0.05]);
      var plateCol = new Float32Array(6 * 4);
      for (var i = 0; i < 6; i++) { plateCol[i * 4] = 0.085; plateCol[i * 4 + 1] = 0.105; plateCol[i * 4 + 2] = 0.155; plateCol[i * 4 + 3] = 1.0; }

      var lPos = [], lCol = [];
      var pushSeg = function (ax, ay, az, x2, y2, z2, r, g, b, a) {
        lPos.push(ax, ay, az, x2, y2, z2);
        lCol.push(r, g, b, a, r, g, b, a);
      };
      // Minor 10mm & Major 50mm grid
      for (var gx = 0; gx <= bx + 0.01; gx += 10) {
        var maj = (Math.round(gx) % 50 === 0);
        pushSeg(gx, 0, 0.01, gx, by, 0.01, 0.65, 0.72, 0.85, maj ? 0.22 : 0.07);
      }
      for (var gy = 0; gy <= by + 0.01; gy += 10) {
        var majY = (Math.round(gy) % 50 === 0);
        pushSeg(0, gy, 0.01, bx, gy, 0.01, 0.65, 0.72, 0.85, majY ? 0.22 : 0.07);
      }
      // Build plate perimeter & build volume cage
      var br = 0.55, bg = 0.36, bb = 0.96;
      pushSeg(0, 0, 0.02, bx, 0, 0.02, br, bg, bb, 0.8);
      pushSeg(bx, 0, 0.02, bx, by, 0.02, br, bg, bb, 0.8);
      pushSeg(bx, by, 0.02, 0, by, 0.02, br, bg, bb, 0.8);
      pushSeg(0, by, 0.02, 0, 0, 0.02, br, bg, bb, 0.8);
      // Volume corners & top frame
      [[0, 0], [bx, 0], [bx, by], [0, by]].forEach(function (c) { pushSeg(c[0], c[1], 0, c[0], c[1], bz, br, bg, bb, 0.24); });
      pushSeg(0, 0, bz, bx, 0, bz, br, bg, bb, 0.18);
      pushSeg(bx, 0, bz, bx, by, bz, br, bg, bb, 0.18);
      pushSeg(bx, by, bz, 0, by, bz, br, bg, bb, 0.18);
      pushSeg(0, by, bz, 0, 0, bz, br, bg, bb, 0.18);
      // XYZ triad axes at origin corner
      pushSeg(0, 0, 0.2, 28, 0, 0.2, 0.94, 0.27, 0.27, 0.95);
      pushSeg(0, 0, 0.2, 0, 28, 0.2, 0.13, 0.77, 0.37, 0.95);
      pushSeg(0, 0, 0.2, 0, 0, 28, 0.22, 0.74, 0.97, 0.95);

      bedVbos = {
        platePos: gl.createBuffer(), plateCol: gl.createBuffer(),
        linesPos: gl.createBuffer(), linesCol: gl.createBuffer(),
        lineVertCount: lPos.length / 3,
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.platePos); gl.bufferData(gl.ARRAY_BUFFER, platePos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.plateCol); gl.bufferData(gl.ARRAY_BUFFER, plateCol, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.linesPos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lPos), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.linesCol); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lCol), gl.STATIC_DRAW);
    }

    function ensureMeshVBO(modelId) {
      var mesh = state.meshes[modelId];
      if (!gl || contextLost || !mesh || !mesh.positions) return null;
      if (typeof gl.isContextLost === "function" && gl.isContextLost()) return null;
      var rev = Number(mesh.meshRev || 0);
      var existing = vbos[modelId];
      if (existing && existing.glGen === glGen && existing.meshRev === rev && existing.triCount === mesh.triangles) {
        return existing;
      }
      if (existing && existing.glGen === glGen) {
        if (existing.posBuf) gl.deleteBuffer(existing.posBuf);
        if (existing.normBuf) gl.deleteBuffer(existing.normBuf);
      }
      var posBuf = gl.createBuffer(), normBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf); gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      vbos[modelId] = { posBuf: posBuf, normBuf: normBuf, triCount: mesh.triangles, meshRev: rev, glGen: glGen };
      return vbos[modelId];
    }

    function pruneUnusedVBOs() {
      if (!gl) return;
      var active = Object.create(null);
      state.items.forEach(function (it) { active[it.model_id] = true; });
      Object.keys(vbos).forEach(function (id) {
        if (!active[id]) {
          gl.deleteBuffer(vbos[id].posBuf);
          gl.deleteBuffer(vbos[id].normBuf);
          delete vbos[id];
        }
      });
    }

    function computeCameraMatrices(width, height) {
      var bx = state.bed.x, by = state.bed.y;
      var maxDim = Math.max(bx, by, state.bed.z || 256);
      var dist = Math.max(maxDim * 0.08, Math.min(maxDim * 5.0, cam.dist));
      cam.dist = dist;
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      var eye = [
        cam.target[0] + dist * cp * Math.cos(cam.yaw - Math.PI * 0.5),
        cam.target[1] + dist * cp * Math.sin(cam.yaw - Math.PI * 0.5),
        cam.target[2] + dist * sp,
      ];
      lastEye = eye;
      var near = Math.max(0.5, dist * 0.01);
      var far = Math.max(3000, dist * 16);
      var proj = mat4Perspective(38, width / Math.max(1, height), near, far);
      var view = mat4LookAt(eye, cam.target);
      lastVP = mat4Mul(proj, view);
      lastInvVP = invert4x4(lastVP) || lastVP;
      return { eye: eye, vp: lastVP, cy: cy, sy: sy, cp: cp, sp: sp };
    }

    function sizeCanvas() {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: canvas.width || 640, height: canvas.height || 460 };
      var dpr = Math.min(2, (typeof root !== "undefined" && root.devicePixelRatio) || 1);
      var w = Math.max(1, Math.round((rect.width || canvas.width || 640) * dpr));
      var h = Math.max(1, Math.round((rect.height || canvas.height || 460) * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return { w: w, h: h, dpr: dpr, cssW: Math.max(1, rect.width || canvas.width), cssH: Math.max(1, rect.height || canvas.height) };
    }

    function drawSelectionOverlays(vp) {
      if (!gl || !lineProg || !boxWireVbo) return;
      var segPos = [], segCol = [];
      var pushSeg = function (x0, y0, z0, x1, y1, z1, r, g, b, a) {
        segPos.push(x0, y0, z0, x1, y1, z1);
        segCol.push(r, g, b, a, r, g, b, a);
      };
      state.items.forEach(function (it, idx) {
        if (it.visible === false) return;
        var isSel = idx === state.selected;
        var isOOB = state.issues.oob.indexOf(idx) >= 0;
        var isBelow = state.issues.belowPlate.indexOf(idx) >= 0;
        var isCol = !!state.issues.collideSet[idx];
        if (!isSel && !isOOB && !isBelow && !isCol) return;
        var c = isOOB || isBelow ? [0.94, 0.27, 0.27, 0.95] : (isCol ? [0.96, 0.62, 0.04, 0.95] : [1.0, 1.0, 1.0, 0.95]);
        var corners = itemFootprintCorners(it);
        var zBase = Math.max(0.08, finiteOr(it.z, 0) + 0.08);
        for (var k = 0; k < 4; k++) {
          var n = (k + 1) % 4;
          pushSeg(corners[k][0], corners[k][1], zBase, corners[n][0], corners[n][1], zBase, c[0], c[1], c[2], c[3]);
        }
        if (isSel) {
          var hz = zBase + finiteOr(it.dz, 20) * clampScale(it.scale);
          // Selected top footprint + subtle Z vertical axis gizmo
          for (var k2 = 0; k2 < 4; k2++) {
            var n2 = (k2 + 1) % 4;
            pushSeg(corners[k2][0], corners[k2][1], hz, corners[n2][0], corners[n2][1], hz, 0.72, 0.60, 0.98, 0.45);
          }
          var cx = finiteOr(it.x, 0), cy = finiteOr(it.y, 0);
          pushSeg(cx, cy, hz, cx, cy, hz + 18, 0.22, 0.74, 0.97, 0.95);
          pushSeg(cx, cy, zBase, cx + 18, cy, zBase, 0.94, 0.27, 0.27, 0.9);
          pushSeg(cx, cy, zBase, cx, cy + 18, zBase, 0.13, 0.77, 0.37, 0.9);
        }
      });
      if (!segPos.length) return;
      var pBuf = gl.createBuffer(), cBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segPos), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, cBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segCol), gl.STREAM_DRAW);
      gl.useProgram(lineProg.prog);
      gl.uniformMatrix4fv(lineProg.u.uMVP, false, vp);
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
      gl.enableVertexAttribArray(lineProg.a.aPos);
      gl.vertexAttribPointer(lineProg.a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, cBuf);
      gl.enableVertexAttribArray(lineProg.a.aCol);
      gl.vertexAttribPointer(lineProg.a.aCol, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, segPos.length / 3);
      gl.deleteBuffer(pBuf); gl.deleteBuffer(cBuf);
    }

    function draw2DFallback(w, h) {
      if (!ctx2d) return;
      ctx2d.fillStyle = "#0d1017";
      ctx2d.fillRect(0, 0, w, h);
      var bx = state.bed.x, by = state.bed.y;
      var proj2d = function (px, py, pz) {
        var cx = px - cam.target[0], cy = py - cam.target[1], cz = pz - cam.target[2];
        var yaw = cam.yaw - Math.PI * 0.5;
        var ca = Math.cos(yaw), sa = Math.sin(yaw);
        var rx = cx * ca - cy * sa, ry = cx * sa + cy * ca;
        var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
        var sc = (Math.min(w, h) * 0.75) / Math.max(60, cam.dist * 0.75);
        return [w * 0.5 + rx * sc, h * 0.54 - (cp * cz - sp * ry) * sc, -(cp * ry + sp * cz)];
      };
      var c00 = proj2d(0, 0, 0), c10 = proj2d(bx, 0, 0), c11 = proj2d(bx, by, 0), c01 = proj2d(0, by, 0);
      ctx2d.fillStyle = "#161b28";
      ctx2d.beginPath(); ctx2d.moveTo(c00[0], c00[1]); ctx2d.lineTo(c10[0], c10[1]); ctx2d.lineTo(c11[0], c11[1]); ctx2d.lineTo(c01[0], c01[1]); ctx2d.closePath();
      ctx2d.fill();
      ctx2d.strokeStyle = "rgba(139,92,246,0.75)"; ctx2d.lineWidth = 1.5; ctx2d.stroke();

      state.items.forEach(function (it, idx) {
        if (it.visible === false) return;
        var mesh = state.meshes[it.model_id];
        var toolCol = (state.tools[it.tool || 0] && state.tools[it.tool || 0].color) || "#38bdf8";
        var isOOB = state.issues.oob.indexOf(idx) >= 0 || state.issues.belowPlate.indexOf(idx) >= 0 || (Array.isArray(state.issues.elevated) && state.issues.elevated.indexOf(idx) >= 0);
        var isCol = !!state.issues.collideSet[idx];
        var fillCol = isOOB ? "#ef4444" : (isCol ? "#f59e0b" : toolCol);
        if (mesh && mesh.positions && mesh.triangles > 0) {
          var stats = state.statsMap[idx] || computeTiltedStats(mesh.positions, mesh.rawBounds, it.scale, it.rot_x, it.rot_y);
          var m = buildItemMatrix(stats, it);
          var P = mesh.positions;
          var step = Math.max(1, Math.floor(mesh.triangles / 2500));
          var faces = [];
          for (var t = 0; t < mesh.triangles; t += step) {
            var o = t * 9, pts = [], depth = 0;
            for (var k = 0; k < 3; k++) {
              var lx = P[o + k * 3], ly = P[o + k * 3 + 1], lz = P[o + k * 3 + 2];
              var wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
              var wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
              var wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
              var pr = proj2d(wx, wy, wz);
              pts.push(pr); depth += pr[2];
            }
            faces.push({ pts: pts, depth: depth });
          }
          faces.sort(function (a, b) { return a.depth - b.depth; });
          ctx2d.fillStyle = fillCol + "88";
          ctx2d.strokeStyle = idx === state.selected ? "#ffffff" : fillCol;
          ctx2d.lineWidth = idx === state.selected ? 1.3 : 0.7;
          for (var f = 0; f < faces.length; f++) {
            var fp = faces[f].pts;
            ctx2d.beginPath(); ctx2d.moveTo(fp[0][0], fp[0][1]); ctx2d.lineTo(fp[1][0], fp[1][1]); ctx2d.lineTo(fp[2][0], fp[2][1]); ctx2d.closePath();
            ctx2d.fill(); ctx2d.stroke();
          }
        } else {
          var cs = itemFootprintCorners(it), z0 = Math.max(0, finiteOr(it.z, 0)), z1 = z0 + finiteOr(it.dz, 20) * clampScale(it.scale);
          var bPts = cs.map(function (c) { return proj2d(c[0], c[1], z0); }), tPts = cs.map(function (c) { return proj2d(c[0], c[1], z1); });
          ctx2d.strokeStyle = fillCol; ctx2d.lineWidth = idx === state.selected ? 2.2 : 1.3;
          [bPts, tPts].forEach(function (loop) {
            ctx2d.beginPath(); ctx2d.moveTo(loop[0][0], loop[0][1]);
            for (var q = 1; q < 4; q++) ctx2d.lineTo(loop[q][0], loop[q][1]);
            ctx2d.closePath(); ctx2d.stroke();
          });
        }
      });
    }

    function drawNow() {
      rafId = 0;
      if (disposed || contextLost) return;
      if (gl && typeof gl.isContextLost === "function" && gl.isContextLost()) { contextLost = true; return; }
      if (typeof document !== "undefined" && document.hidden) return;
      var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      var sz = sizeCanvas();
      var camInfo = computeCameraMatrices(sz.w, sz.h);

      if (!gl || !meshProg || !lineProg) {
        draw2DFallback(sz.w, sz.h);
        drawCount += 1;
        lastFrameMs = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
        return;
      }

      ensureBedBuffers();
      gl.viewport(0, 0, sz.w, sz.h);
      gl.clearColor(0.055, 0.067, 0.095, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // Draw build plate surface + grid + volume box
      if (bedVbos) {
        gl.useProgram(lineProg.prog);
        gl.uniformMatrix4fv(lineProg.u.uMVP, false, camInfo.vp);
        gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.platePos);
        gl.enableVertexAttribArray(lineProg.a.aPos); gl.vertexAttribPointer(lineProg.a.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.plateCol);
        gl.enableVertexAttribArray(lineProg.a.aCol); gl.vertexAttribPointer(lineProg.a.aCol, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.linesPos);
        gl.vertexAttribPointer(lineProg.a.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bedVbos.linesCol);
        gl.vertexAttribPointer(lineProg.a.aCol, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, bedVbos.lineVertCount);
      }

      // Draw each visible STL model (or fallback box while streaming/unsupported)
      gl.useProgram(meshProg.prog);
      gl.uniformMatrix4fv(meshProg.u.uVP, false, camInfo.vp);
      gl.uniform3f(meshProg.u.uEye, camInfo.eye[0], camInfo.eye[1], camInfo.eye[2]);

      state.items.forEach(function (it, idx) {
        if (it.visible === false) return;
        var toolObj = state.tools[it.tool || 0];
        var baseCol = parseHexRgb01(toolObj && toolObj.color);
        var isSel = idx === state.selected;
        var isOOB = state.issues.oob.indexOf(idx) >= 0 || state.issues.belowPlate.indexOf(idx) >= 0 || (Array.isArray(state.issues.elevated) && state.issues.elevated.indexOf(idx) >= 0);
        var isCol = !!state.issues.collideSet[idx];
        var tint = isOOB ? [0.95, 0.25, 0.25] : (isCol ? [0.96, 0.62, 0.04] : [1.0, 1.0, 1.0]);
        var tintMix = isOOB ? 0.55 : (isCol ? 0.45 : (isSel ? 0.22 : 0.0));

        var vbo = ensureMeshVBO(it.model_id);
        var modelMat;
        if (vbo) {
          var stats = state.statsMap[idx];
          if (!stats) {
            var mesh = state.meshes[it.model_id];
            stats = computeTiltedStats(mesh.positions, mesh.rawBounds, it.scale, it.rot_x, it.rot_y, mesh);
            state.statsMap[idx] = stats;
          }
          modelMat = buildItemMatrix(stats, it);
        } else if (boxVbo) {
          // Placeholder box ONLY while STL is still downloading or unsupported
          var bx = finiteOr(it.dx, 20) * clampScale(it.scale);
          var by = finiteOr(it.dy, 20) * clampScale(it.scale);
          var bz = finiteOr(it.dz, 20) * clampScale(it.scale);
          var rz = finiteOr(it.rot_z, 0) * DEG2RAD, cz = Math.cos(rz), sz2 = Math.sin(rz);
          modelMat = new Float32Array([
            bx * cz, bx * sz2, 0, 0,
            -by * sz2, by * cz, 0, 0,
            0, 0, bz, 0,
            finiteOr(it.x, 0), finiteOr(it.y, 0), Math.max(0, finiteOr(it.z, 0)), 1,
          ]);
          vbo = boxVbo;
          tintMix = Math.max(tintMix, 0.35);
        } else {
          return;
        }
        gl.uniformMatrix4fv(meshProg.u.uModel, false, modelMat);
        gl.uniform3f(meshProg.u.uColor, baseCol[0], baseCol[1], baseCol[2]);
        gl.uniform3f(meshProg.u.uTint, tint[0], tint[1], tint[2]);
        gl.uniform1f(meshProg.u.uTintMix, tintMix);

        gl.bindBuffer(gl.ARRAY_BUFFER, vbo.posBuf);
        gl.enableVertexAttribArray(meshProg.a.aPos); gl.vertexAttribPointer(meshProg.a.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo.normBuf);
        gl.enableVertexAttribArray(meshProg.a.aNorm); gl.vertexAttribPointer(meshProg.a.aNorm, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, vbo.triCount * 3);
      });

      drawSelectionOverlays(camInfo.vp);
      drawCount += 1;
      lastFrameMs = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
    }

    function schedule() {
      if (disposed || contextLost || rafId) return;
      if (typeof root !== "undefined" && typeof root.requestAnimationFrame === "function") {
        rafId = root.requestAnimationFrame(drawNow);
      } else {
        drawNow();
      }
    }

    // ---- Unprojection, Picking & Drag Plane ----

    function worldRayFromClient(clientX, clientY) {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 640, height: 460 };
      var nx = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      var ny = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
      computeCameraMatrices(rect.width || 640, rect.height || 460);
      var unproj = function (zNdc) {
        var m = lastInvVP;
        var w = m[3] * nx + m[7] * ny + m[11] * zNdc + m[15];
        if (Math.abs(w) < 1e-9) w = 1e-9;
        return [
          (m[0] * nx + m[4] * ny + m[8] * zNdc + m[12]) / w,
          (m[1] * nx + m[5] * ny + m[9] * zNdc + m[13]) / w,
          (m[2] * nx + m[6] * ny + m[10] * zNdc + m[14]) / w,
        ];
      };
      var pNear = unproj(-1), pFar = unproj(1);
      var dx = pFar[0] - pNear[0], dy = pFar[1] - pNear[1], dz = pFar[2] - pNear[2];
      var l = Math.hypot(dx, dy, dz) || 1;
      return { origin: pNear, dir: [dx / l, dy / l, dz / l] };
    }

    function rayZPlane(ray, planeZ) {
      if (Math.abs(ray.dir[2]) < 1e-5) return null;
      var t = (planeZ - ray.origin[2]) / ray.dir[2];
      if (t <= 0) return null;
      return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t];
    }

    function pickObject(clientX, clientY) {
      var ray = worldRayFromClient(clientX, clientY);
      var best = null;
      state.items.forEach(function (it, idx) {
        if (it.visible === false) return;
        var mesh = state.meshes[it.model_id];
        if (mesh && mesh.positions) {
          var stats = state.statsMap[idx] || computeTiltedStats(mesh.positions, mesh.rawBounds, it.scale, it.rot_x, it.rot_y);
          var m = buildItemMatrix(stats, it);
          var inv = invert4x4(m);
          var hit = intersectRayMeshLocal(mesh, inv, ray.origin, ray.dir);
          if (hit && (!best || hit.t < best.t)) {
            best = { itemIndex: idx, faceIndex: hit.faceIndex, localNormal: hit.localNormal, t: hit.t, exactMesh: true };
          }
        } else {
          // Proxy AABB hit only while mesh is loading
          var hw = (finiteOr(it.dx, 20) * clampScale(it.scale)) * 0.5;
          var hd = (finiteOr(it.dy, 20) * clampScale(it.scale)) * 0.5;
          var hz = finiteOr(it.dz, 20) * clampScale(it.scale);
          var x0 = finiteOr(it.x, 0) - hw, x1 = finiteOr(it.x, 0) + hw;
          var y0 = finiteOr(it.y, 0) - hd, y1 = finiteOr(it.y, 0) + hd;
          var z0 = Math.max(0, finiteOr(it.z, 0)), z1 = z0 + hz;
          if (rayHitsAABB(ray.origin[0], ray.origin[1], ray.origin[2], ray.dir[0], ray.dir[1], ray.dir[2], x0, y0, z0, x1, y1, z1)) {
            var approxT = Math.hypot(ray.origin[0] - it.x, ray.origin[1] - it.y, ray.origin[2] - z0);
            if (!best || approxT < best.t) {
              best = { itemIndex: idx, faceIndex: -1, localNormal: null, t: approxT, exactMesh: false };
            }
          }
        }
      });
      return best;
    }

    // ---- Pointer & Gesture Interaction (Desktop + Mobile Touch) ----
    var pointers = new Map();
    var activeGesture = null; // { kind: "orbit" | "pan" | "move" | "pending_pick", ... }
    var pinch = null;
    var pinchBaseline = function () {
      if (pointers.size !== 2) return null;
      var vals = Array.from(pointers.values());
      return {
        mid: [(vals[0].x + vals[1].x) * 0.5, (vals[0].y + vals[1].y) * 0.5],
        d: Math.max(1, Math.hypot(vals[0].x - vals[1].x, vals[0].y - vals[1].y)),
      };
    };

    function panCamera(dxPx, dyPx) {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 640, height: 460 };
      var scale = cam.dist / Math.max(120, rect.height || 460) * 0.85;
      var forwardYaw = cam.yaw - Math.PI * 0.5;
      var rx = -Math.sin(forwardYaw), ry = Math.cos(forwardYaw);
      var fx = Math.cos(forwardYaw), fy = Math.sin(forwardYaw);
      var sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      cam.target[0] += (-dxPx * rx + dyPx * fx * sp) * scale;
      cam.target[1] += (-dxPx * ry + dyPx * fy * sp) * scale;
      cam.target[2] += (dyPx * cp) * scale;
    }

    function onPointerDown(e) {
      if (disposed) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (pointers.size === 2) {
        // Switching to two-finger pinch+pan cancels any single-finger drag cleanly
        if (activeGesture && activeGesture.kind === "move" && activeGesture.moved && onDragEnd) {
          onDragEnd(activeGesture.itemIndex, true);
        }
        activeGesture = { kind: "pinch" };
        pinch = pinchBaseline();
        return;
      }
      if (pointers.size > 1) return;

      var isPanBtn = e.button === 1 || (e.shiftKey && e.button === 0);
      var isRightOrbit = e.button === 2;
      if (isPanBtn) {
        activeGesture = { kind: "pan", startX: e.clientX, startY: e.clientY, moved: false };
        return;
      }
      if (isRightOrbit || state.interactionMode === "camera") {
        activeGesture = { kind: "orbit", startX: e.clientX, startY: e.clientY, moved: false };
        return;
      }

      var hit = pickObject(e.clientX, e.clientY);
      if (state.interactionMode === "layflat") {
        if (hit && hit.exactMesh && hit.localNormal && onFacePick) {
          onFacePick(hit.itemIndex, hit.localNormal, hit.faceIndex);
        } else if (hit && onSelect) {
          onSelect(hit.itemIndex);
        }
        activeGesture = null;
        return;
      }

      if (hit) {
        var idx = hit.itemIndex;
        var it = state.items[idx];
        var ray = worldRayFromClient(e.clientX, e.clientY);
        var grabPt = rayZPlane(ray, Math.max(0, finiteOr(it && it.z, 0)));
        if (state.interactionMode === "move" || (e.pointerType !== "touch" && idx === state.selected)) {
          if (onSelect && state.selected !== idx) onSelect(idx);
          activeGesture = {
            kind: "move",
            itemIndex: idx,
            startX: e.clientX,
            startY: e.clientY,
            grabPt: grabPt,
            origX: finiteOr(it && it.x, 0),
            origY: finiteOr(it && it.y, 0),
            moved: false,
            startedHistory: false,
          };
          return;
        }
        // Touch/auto on unselected mesh: tap selects; drag orbits unless user chose "move" mode
        activeGesture = { kind: "orbit_or_tap", hitIndex: idx, startX: e.clientX, startY: e.clientY, moved: false };
      } else {
        activeGesture = { kind: "orbit_or_deselect", startX: e.clientX, startY: e.clientY, moved: false };
      }
    }

    function onPointerMove(e) {
      var p = pointers.get(e.pointerId);
      if (!p || disposed) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 2) {
        var vals = Array.from(pointers.values());
        var mid = [(vals[0].x + vals[1].x) * 0.5, (vals[0].y + vals[1].y) * 0.5];
        var d = Math.max(1, Math.hypot(vals[0].x - vals[1].x, vals[0].y - vals[1].y));
        if (pinch) {
          panCamera(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
          var maxDim = Math.max(state.bed.x, state.bed.y, state.bed.z || 256);
          cam.dist = Math.max(maxDim * 0.08, Math.min(maxDim * 5.0, cam.dist * (pinch.d / d)));
        }
        pinch = { mid: mid, d: d };
        schedule();
        return;
      }
      if (!activeGesture) return;
      var totalMove = Math.hypot(e.clientX - activeGesture.startX, e.clientY - activeGesture.startY);
      if (totalMove > 4) activeGesture.moved = true;

      if (activeGesture.kind === "orbit" || activeGesture.kind === "orbit_or_tap" || activeGesture.kind === "orbit_or_deselect") {
        if (activeGesture.moved || activeGesture.kind === "orbit") {
          cam.yaw -= dx * 0.009;
          cam.pitch = Math.max(0.06, Math.min(1.52, cam.pitch + dy * 0.009));
          schedule();
        }
      } else if (activeGesture.kind === "pan") {
        panCamera(dx, dy);
        schedule();
      } else if (activeGesture.kind === "move") {
        var it = state.items[activeGesture.itemIndex];
        if (!it) return;
        if (!activeGesture.startedHistory && activeGesture.moved) {
          activeGesture.startedHistory = true;
          if (onDragStart) onDragStart(activeGesture.itemIndex);
        }
        var ray = worldRayFromClient(e.clientX, e.clientY);
        var pt = rayZPlane(ray, Math.max(0, finiteOr(it.z, 0)));
        if (pt && activeGesture.grabPt) {
          var nx = +(activeGesture.origX + (pt[0] - activeGesture.grabPt[0])).toFixed(1);
          var ny = +(activeGesture.origY + (pt[1] - activeGesture.grabPt[1])).toFixed(1);
          if (onDragMove) onDragMove(activeGesture.itemIndex, nx, ny);
          else { it.x = nx; it.y = ny; schedule(); }
        }
      }
    }

    function onPointerEnd(e, cancelled) {
      pointers.delete(e.pointerId);
      try { if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      pinch = pinchBaseline();
      if (!activeGesture) return;
      var g = activeGesture;
      if (pointers.size === 0) activeGesture = null;

      if (cancelled) {
        if (g.kind === "move" && g.startedHistory && onDragEnd) onDragEnd(g.itemIndex, true);
        return;
      }
      if (g.kind === "move") {
        if (g.startedHistory && onDragEnd) onDragEnd(g.itemIndex, false);
        else if (!g.moved && onSelect) onSelect(g.itemIndex);
      } else if (g.kind === "orbit_or_tap" && !g.moved) {
        if (onSelect) onSelect(g.hitIndex);
      } else if (g.kind === "orbit_or_deselect" && !g.moved) {
        if (onSelect) onSelect(-1);
      } else if ((g.kind === "orbit" || g.kind === "pan" || g.kind === "orbit_or_tap" || g.kind === "orbit_or_deselect") && g.moved && onCameraChange) {
        onCameraChange(Object.assign({}, cam, { target: cam.target.slice() }));
      }
    }

    function onDblClick(e) {
      if (disposed) return;
      var hit = pickObject(e.clientX, e.clientY);
      if (hit) {
        if (onSelect) onSelect(hit.itemIndex);
        focusItem(state.items[hit.itemIndex]);
        if (onFocusRequest) onFocusRequest(hit.itemIndex);
      }
    }

    function onWheel(e) {
      if (disposed) return;
      e.preventDefault();
      var maxDim = Math.max(state.bed.x, state.bed.y, state.bed.z || 256);
      var factor = e.deltaY > 0 ? 1.12 : 0.89;
      cam.dist = Math.max(maxDim * 0.08, Math.min(maxDim * 5.0, cam.dist * factor));
      schedule();
      if (onCameraChange) onCameraChange(Object.assign({}, cam, { target: cam.target.slice() }));
    }

    function onCtxMenu(e) { e.preventDefault(); }
    function onLost(e) {
      e.preventDefault();
      contextLost = true;
      glGen += 1;
      freeGLResources(true);
      if (onContextChange) onContextChange(true);
    }
    function onRestored() {
      contextLost = false;
      glGen += 1;
      freeGLResources(true);
      initGLResources();
      ensureBedBuffers();
      if (onContextChange) onContextChange(false);
      drawNow();
    }
    function onVisChange() { if (typeof document !== "undefined" && !document.hidden) schedule(); }
    function onUp(e) { onPointerEnd(e, false); }
    function onCancel(e) { onPointerEnd(e, true); }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onCtxMenu);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisChange);
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(function () { schedule(); });
      ro.observe(canvas);
    }

    initGLResources();

    function setCameraPreset(preset) {
      var bx = state.bed.x, by = state.bed.y;
      var maxDim = Math.max(bx, by, state.bed.z || 256);
      cam.target = [bx * 0.5, by * 0.5, 22];
      cam.dist = maxDim * 1.48;
      if (preset === "top") { cam.yaw = 0; cam.pitch = 1.52; }
      else if (preset === "front") { cam.yaw = 0; cam.pitch = 0.08; }
      else if (preset === "side") { cam.yaw = Math.PI * 0.5; cam.pitch = 0.08; }
      else { cam.yaw = 0.72; cam.pitch = 0.56; } // "iso" or "reset"
      schedule();
      if (onCameraChange) onCameraChange(Object.assign({}, cam, { target: cam.target.slice() }));
    }

    function focusItem(it) {
      if (!it) return;
      var w = finiteOr(it.dx, 20) * clampScale(it.scale);
      var d = finiteOr(it.dy, 20) * clampScale(it.scale);
      var h = finiteOr(it.dz, 20) * clampScale(it.scale);
      var diag = Math.max(18, Math.hypot(w, d, h));
      cam.target = [finiteOr(it.x, state.bed.x * 0.5), finiteOr(it.y, state.bed.y * 0.5), Math.max(0, finiteOr(it.z, 0)) + h * 0.5];
      cam.dist = Math.max(36, diag * 2.1);
      schedule();
      if (onCameraChange) onCameraChange(Object.assign({}, cam, { target: cam.target.slice() }));
    }

    function setState(next) {
      if (disposed) return;
      if (next.bed) state.bed = { x: Number(next.bed.x || 256), y: Number(next.bed.y || 256), z: Number(next.bed.z || 256) };
      if (Array.isArray(next.items)) state.items = next.items;
      if (typeof next.selected === "number") state.selected = next.selected;
      if (Array.isArray(next.tools)) state.tools = next.tools;
      if (next.issues) state.issues = next.issues;
      if (next.meshes) state.meshes = next.meshes;
      if (next.statsMap) state.statsMap = next.statsMap;
      if (next.interactionMode) state.interactionMode = next.interactionMode;
      pruneUnusedVBOs();
      schedule();
    }

    function getMetrics() {
      return {
        webgl: !!gl,
        contextLost: contextLost,
        glGen: glGen,
        bedReady: !!bedVbos,
        drawCount: drawCount,
        lastFrameMs: lastFrameMs,
        vboCount: Object.keys(vbos).length,
        camera: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.slice() },
        rafPending: !!rafId,
      };
    }

    function projectWorldPoint(pt) {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 640, height: 460 };
      computeCameraMatrices(rect.width || 640, rect.height || 460);
      var m = lastVP, x = pt[0], y = pt[1], z = pt[2];
      var w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (Math.abs(w) < 1e-9) return null;
      var nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      var ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      return [rect.left + (nx + 1) * 0.5 * rect.width, rect.top + (1 - ny) * 0.5 * rect.height];
    }

    canvas.hqPrepareMetrics = getMetrics;
    canvas.hqPreparePick = pickObject;
    canvas.hqPrepareProject = projectWorldPoint;

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId && typeof root !== "undefined" && typeof root.cancelAnimationFrame === "function") {
        try { root.cancelAnimationFrame(rafId); } catch (_) {}
      }
      rafId = 0;
      if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
      pointers.clear();
      try {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onCancel);
        canvas.removeEventListener("dblclick", onDblClick);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onCtxMenu);
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisChange);
      } catch (_) {}
      freeGLResources();
      if (gl) {
        try { var ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } catch (_) {}
        gl = null;
      }
    }

    return {
      setState: setState,
      setCameraPreset: setCameraPreset,
      focusItem: focusItem,
      pickObject: pickObject,
      drawNow: drawNow,
      schedule: schedule,
      dispose: dispose,
      getMetrics: getMetrics,
      getCamera: function () { return Object.assign({}, cam, { target: cam.target.slice() }); },
    };
  }

  var api = {
    computeRawBounds: computeRawBounds,
    computeTiltedStats: computeTiltedStats,
    transformVertices: transformVertices,
    buildItemMatrix: buildItemMatrix,
    layFlatAnglesForNormal: layFlatAnglesForNormal,
    bestLayFlatAngles: bestLayFlatAngles,
    itemFootprintCorners: itemFootprintCorners,
    itemRotatedSpan: itemRotatedSpan,
    itemBelowPlate: itemBelowPlate,
    itemElevated: itemElevated,
    itemOutOfBounds: itemOutOfBounds,
    itemsCollide: itemsCollide,
    buildChunkBoxes: buildChunkBoxes,
    invert4x4: invert4x4,
    intersectRayMeshLocal: intersectRayMeshLocal,
    createMeshStore: createMeshStore,
    createViewport: createViewport,
  };
  root.HQPrepare = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
