// Offline checks for the Time machine, Carnet constellation, radial menu and second-screen helpers (no browser).
// Run: node tests/check_hq_time_sky_desk.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TM = require("../assets/hq-timemachine.js");
const SKY = require("../assets/hq-constellation.js");
const RAD = require("../assets/hq-radial.js");
const DESK = require("../assets/hq-desk.js");

// ---- Time machine
{
  const ms = [
    { at: 100, lane: "forge" }, { at: 200, lane: "carnet" }, { at: 300, lane: "forge" }, { at: 400, lane: "forge" },
  ];
  const v = TM.visibleAt(ms, 350, "forge", 6);
  assert.deepEqual(v.map((m) => m.at), [300, 100], "newest first, nothing after the cursor");
  assert.equal(v[0].age, 50);
  assert.equal(TM.visibleAt(ms, 1000, "forge", 1).length, 1, "capped");
  assert.deepEqual(TM.countsAt(ms, 250), { forge: 1, carnet: 1 });
  assert.equal(TM.phaseFor(2), "night");
  assert.equal(TM.phaseFor(6.5), "dawn");
  assert.equal(TM.phaseFor(13), "day");
  assert.equal(TM.phaseFor(19), "dusk");
  assert.equal(TM.phaseFor(23), "night");
  assert.equal(TM.stepFor("day", false), 300);
  assert.equal(TM.stepFor("week", true), 6 * 3600);
  assert.equal(TM.nearest(ms, 205, 10), 1);
  assert.equal(TM.nearest(ms, 250, 10), -1);
  const now = Date.UTC(2027, 0, 15, 12) / 1000;
  const day = TM.ticks(now - 86400, now, "day", (d) => d.getHours());
  assert.ok(day.length >= 7 && day.length <= 8, "every 3 h over a day");
  assert.ok(day.every((t) => t.label % 3 === 0));
  assert.ok(day.every((t, i) => i === 0 || t.at > day[i - 1].at));
  const week = TM.ticks(now - 7 * 86400, now, "week", (d) => d.getDay());
  assert.ok(week.length >= 6 && week.length <= 7, "one per midnight over a week");
}

// ---- Constellation
{
  const data = {
    projects: [{ id: "proj-a", name: "Garage" }],
    pages: [
      { id: "page-1", title: "Plan", project_id: "proj-a", updated_at: 0 },
      { id: "page-2", title: "Cible", project_id: null, updated_at: 0 },
      { id: "page-3", title: "Seule", project_id: null, updated_at: 0 },
    ],
    targets: [{ id: "file:Inbox/a.pdf", kind: "file", label: "a.pdf" }],
    edges: [{ from: "page-1", to: "note:page-2", count: 1 }, { from: "page-1", to: "file:Inbox/a.pdf", count: 2 }, { from: "page-x", to: "note:page-2", count: 1 }],
  };
  const g = SKY.buildGraph(data, 1e9);
  assert.equal(g.nodes.length, 5);
  assert.equal(g.links.length, 2, "edges to unknown pages are dropped");
  assert.equal(g.orphans, 1, "a page with no project and no line is an orphan");
  assert.ok(g.byId.get("note:page-3").orphan);
  assert.ok(!g.byId.get("note:page-2").orphan, "a linked page is not an orphan");
  assert.equal(SKY.hueOf("proj-a"), SKY.hueOf("proj-a"), "stable colour");
  const r0 = Math.hypot(g.byId.get("note:page-3").x, g.byId.get("note:page-3").y);
  SKY.settle(g, 200);
  for (const n of g.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), "settles to finite positions");
  const p = g.byId.get("project:proj-a"), page = g.byId.get("note:page-1");
  assert.ok(Math.hypot(p.x - page.x, p.y - page.y) < 200, "a page stays near its project");
  assert.equal(Math.hypot(g.byId.get("note:page-3").x, g.byId.get("note:page-3").y).toFixed(3), r0.toFixed(3), "orphans keep their orbit");
  assert.equal(SKY.hitTest(g, page.x, page.y, 1), page);
  assert.equal(SKY.hitTest(g, 1e6, 1e6, 5), null);
  const b = SKY.bounds(g);
  assert.ok(b.x1 > b.x0 && b.y1 > b.y0);
  // a big sky stays fast enough
  const big = { projects: [], targets: [], edges: [], pages: Array.from({ length: 1500 }, (_, i) => ({ id: "page-" + i, title: "p" + i, project_id: null, updated_at: 0 })) };
  for (let i = 1; i < 1500; i++) big.edges.push({ from: "page-" + i, to: "note:page-" + (i >> 1), count: 1 });
  const t0 = Date.now();
  SKY.settle(SKY.buildGraph(big, 0), 60);
  assert.ok(Date.now() - t0 < 4000, "1500 stars x 60 steps in under 4 s");
}

// ---- Radial menu
{
  assert.equal(RAD.pickIndex(7, 100, 100, 100, 10, 30), 0, "straight up is the first item");
  assert.equal(RAD.pickIndex(4, 100, 100, 190, 100, 30), 1, "right is a quarter turn clockwise");
  assert.equal(RAD.pickIndex(4, 100, 100, 110, 105, 30), -1, "inside the dead zone picks nothing");
  const L = RAD.layout(7, 4, 4, 375, 812, 96, 8);
  assert.ok(L.items.every((p) => p.x >= 0 && p.y >= 0 && p.x <= 375 && p.y <= 812), "a ring near a corner stays on screen");
  const fake = (sel) => ({ closest: (q) => (q.split(",").some((s) => s.trim() === sel) ? {} : null) });
  assert.equal(RAD.eligible(fake("div"), "accueil"), true);
  assert.equal(RAD.eligible(fake("button"), "accueil"), false);
  assert.equal(RAD.eligible(fake(".fx-item"), "fichiers"), false, "Fichiers tiles keep their own long press");
  assert.equal(RAD.eligible(fake("div"), "dessiner"), false, "Dessiner owns every touch");
  assert.equal(RAD.eligible(null, "accueil"), false);
}

// ---- Second screen
{
  assert.deepEqual(DESK.norm(50, 25, 100, 100), [0.5, 0.25]);
  assert.deepEqual(DESK.norm(-5, 500, 100, 100), [0, 1], "clamped to the pad");
  const q = [{ type: "pad", data: { op: "move", s: 1, pts: [[0, 0]] } }];
  assert.equal(DESK.mergeMove(q, { type: "pad", data: { op: "move", s: 1, pts: [[1, 1]] } }), true);
  assert.equal(q[0].data.pts.length, 2);
  assert.equal(DESK.mergeMove(q, { type: "pad", data: { op: "move", s: 2, pts: [[1, 1]] } }), false, "another stroke is not merged");
  assert.equal(DESK.mergeMove(q, { type: "pad", data: { op: "end", s: 1, pts: [] } }), false, "the end of a stroke stays its own message");
  assert.equal(DESK.flickOk(-200, 0), true);
  assert.equal(DESK.flickOk(-40, -0.9), true);
  assert.equal(DESK.flickOk(-40, -0.1), false);
  assert.equal(DESK.flickOk(80, -2), false, "down is never a flick");
  const win = (coarse, w, h) => ({ matchMedia: () => ({ matches: coarse }), screen: { width: w, height: h } });
  assert.equal(DESK.isPhoneLike(win(true, 390, 844)), true);
  assert.equal(DESK.isPhoneLike(win(false, 390, 844)), false);
  assert.equal(DESK.isPhoneLike(win(true, 1024, 1366)), true, "an iPad (primary pointer: finger) drives, Pencil or not");
  assert.equal(DESK.isPhoneLike(win(false, 1920, 1080)), false, "a touch laptop (primary pointer: trackpad) hosts");
  // Apple Pencil palm rejection
  assert.equal(DESK.penGate("touch", false, false, ""), "start", "before any Pencil, a finger draws");
  assert.equal(DESK.penGate("touch", true, false, ""), "ignore", "once a Pencil is seen, the palm does not draw");
  assert.equal(DESK.penGate("touch", true, true, ""), "start", "unless « Pencil + doigt » is on");
  assert.equal(DESK.penGate("pen", true, false, "touch"), "takeover", "a Pencil landing after the palm wins");
  assert.equal(DESK.penGate("pen", true, false, "pen"), "ignore", "one stroke at a time");
  const hq = [{ type: "pad", data: { op: "hover", pts: [[0, 0]] } }];
  assert.equal(DESK.mergeMove(hq, { type: "pad", data: { op: "hover", pts: [[0.5, 0.5]] } }), true);
  assert.deepEqual(hq[0].data.pts, [[0.5, 0.5]], "queued hovers collapse to the latest position");
  const view = [{ type: "pad", data: { op: "view", dx: 0.1, dy: 0, z: 1.1, cx: 0.5, cy: 0.5 } }];
  assert.equal(DESK.mergeMove(view, { type: "pad", data: { op: "view", dx: 0.02, dy: -0.01, z: 1.2, cx: 0.4, cy: 0.6 } }), true);
  assert.equal(view.length, 1);
  assert.ok(Math.abs(view[0].data.z - 1.32) < 1e-6, "coalesced zooms multiply");
  assert.deepEqual(DESK.pinchStep([[0, 0], [0, 0.2]], [[0.1, 0], [0.1, 0.4]]), { cx: 0.1, cy: 0.2, dx: 0.1, dy: 0.1, z: 2 });
  assert.equal(DESK.fingerTap(2, 200, 4), "undo");
  assert.equal(DESK.fingerTap(3, 100, 0), "redo");
  assert.equal(DESK.fingerTap(2, 400, 0), null);
  assert.equal(DESK.fingerTap(2, 100, 12), null);
  assert.equal(DESK.pointWidth("bold", "pen", 1), DESK.THICK.bold);
  assert.ok(DESK.pointWidth("med", "pen", 0.2) < DESK.THICK.med);
}

console.log("check_hq_time_sky_desk: ok");
