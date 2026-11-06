import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = JSON.parse(
  readFileSync(new URL("../assets/dangling-member-vein-paths.json", import.meta.url), "utf8")
);
const js = readFileSync(new URL("../assets/dangling-member-vein-paths.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");

assert.equal(json.version, 3);
assert.ok(json.method === "multi_ridge" || json.method === "red_annotation", "known method");
assert.ok(Array.isArray(json.paths) && json.paths.length >= (json.method === "red_annotation" ? 10 : 8), "multiple vein paths");
for (const rec of json.paths) {
  assert.ok(rec.tier === "primary" || rec.tier === "secondary", rec.id + " tier");
  for (const key of ["sparse", "dense"]) {
    assert.ok(Array.isArray(rec[key]) && rec[key].length >= 2, rec.id + " " + key);
    for (const knot of rec[key]) {
      assert.equal(knot.length, 2);
      assert.ok(knot[0] >= 0.05 && knot[0] <= 0.98, rec.id + " t in shaft span");
    }
  }
}
for (const side of ["left", "right"]) {
  assert.ok(Array.isArray(json[side]) && json[side].length >= 10, side + " legacy path knots");
  for (const knot of json[side]) {
    assert.equal(knot.length, 2);
    const t = knot[0];
    const lane = knot[1];
    assert.ok(t >= 0.08 && t <= 0.96, "t in shaft span");
    if (side === "left") assert.ok(lane < -0.05, "left lane negative");
    else assert.ok(lane > 0.05, "right lane positive");
  }
}
for (const dense of ["left_dense", "right_dense"]) {
  assert.ok(Array.isArray(json[dense]) && json[dense].length >= 20, dense + " knots");
}
assert.ok(js.includes("DanglingVeinPaths"));
assert.ok(js.includes("DanglingVeinPathApi"));
assert.ok(js.includes("getPolyline"));
assert.ok(js.includes("listPaths"));
assert.ok(js.includes("getAllPolylines"));
assert.ok(js.includes("getPathById"));
assert.ok(bridge.indexOf("dangling-member-vein-paths.js") < bridge.indexOf("hq-palm-hand.js"));
console.log("check_dangling_vein_paths: ok (" + json.paths.length + " paths)");
