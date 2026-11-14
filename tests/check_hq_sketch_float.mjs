// Dessiner's floating action bubble placement (hq-sketch-float.js). Run: node tests/check_hq_sketch_float.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../assets/hq-sketch-float.js");
const stage = { w: 1000, h: 600 }, size = { w: 300, h: 90 };
const overlaps = (p, a) => !(p.left + size.w <= a.x0 || p.left >= a.x1 || p.top + size.h <= a.y0 || p.top >= a.y1);

{ // room above: above, centred on the selection
  const a = { x0: 400, y0: 300, x1: 600, y1: 340 };
  const p = F.place(a, size, stage);
  assert.equal(p.side, "above");
  assert.equal(p.left, 350);
  assert.equal(p.top, 300 - F.GAP - 90);
  assert.ok(!overlaps(p, a));
}
{ // selection near the top: below it
  const a = { x0: 400, y0: 20, x1: 600, y1: 60 };
  const p = F.place(a, size, stage);
  assert.equal(p.side, "below");
  assert.ok(!overlaps(p, a));
}
{ // tall selection filling the height: beside it
  const a = { x0: 100, y0: 30, x1: 300, y1: 570 };
  const p = F.place(a, size, stage);
  assert.equal(p.side, "right");
  assert.ok(!overlaps(p, a));
}
{ // near the left edge: clamped inside the stage
  const a = { x0: 0, y0: 300, x1: 20, y1: 320 };
  const p = F.place(a, size, stage);
  assert.equal(p.left, F.MARGIN);
}
{ // near the right edge
  const a = { x0: 980, y0: 300, x1: 1000, y1: 320 };
  const p = F.place(a, size, stage);
  assert.equal(p.left, stage.w - size.w - F.MARGIN);
}
{ // no anchor (3D edge picking): top-right corner
  const p = F.place(null, size, stage);
  assert.deepEqual([p.side, p.left, p.top], ["corner", stage.w - size.w - F.MARGIN, F.MARGIN]);
}
{ // phones: docked away from the selection
  assert.equal(F.dockSide({ x0: 0, y0: 400, x1: 10, y1: 420 }, 600), "top", "selection low: bubble on top");
  assert.equal(F.dockSide({ x0: 0, y0: 100, x1: 10, y1: 120 }, 600), "bottom", "selection high: bubble at the bottom");
  assert.ok(F.ARM_MS >= 300, "the tap that opens the bubble cannot press its buttons");
}
{ // the action ring: labels never overlap and stay inside the stage, even from a corner
  const labels = ["Appliquer", "H", "V", "Fixer", "Extruder", "Supprimer", "Tout afficher"];
  for (let n = 2; n <= labels.length; n++) {
    const lens = labels.slice(0, n).map(l => l.length);
    for (const at of [{ x: 5, y: 5 }, { x: 900, y: 590 }, { x: 500, y: 300 }]) {
      const L = F.ringLayout(lens, at, stage);
      const boxes = L.items.map((p, i) => ({ x0: p.x - 8 - 4.2 * lens[i], x1: p.x + 8 + 4.2 * lens[i], y0: p.y - 19, y1: p.y + 19 }));
      boxes.forEach((b, i) => {
        assert.ok(b.x0 >= 0 && b.x1 <= stage.w && b.y0 >= 0 && b.y1 <= stage.h, `ring label ${i} inside the stage (n=${n})`);
        boxes.slice(i + 1).forEach((c, j) => assert.ok(b.x1 <= c.x0 || c.x1 <= b.x0 || b.y1 <= c.y0 || c.y1 <= b.y0, `labels ${i} and ${i + j + 1} apart (n=${n})`));
      });
    }
  }
}
console.log("check_hq_sketch_float: ok");
