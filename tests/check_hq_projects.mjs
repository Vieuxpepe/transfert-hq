// Pure checks for the Projets UI (assets/hq-projects.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const P = require("../assets/hq-projects.js").pure;

assert.equal(P.daysUntil("2026-11-10", "2026-11-03"), 7);
assert.equal(P.ago(1000, 1030), "à l'instant");
assert.equal(P.ago(1000, 1000 + 300), "il y a 5 min");
assert.equal(P.ago(1000, 1000 + 3 * 3600), "il y a 3 h");
assert.equal(P.ago(1000, 1000 + 86400 + 10), "hier");
assert.equal(P.ago(1000, 1000 + 4 * 86400), "il y a 4 j");
assert.equal(P.daysUntil("2026-03-30", "2026-03-28"), 2, "DST does not shift whole days");
assert.equal(P.daysUntil("2027-01-01", "2026-12-31"), 1);
assert.equal(P.dueLabel("2026-11-03", "2026-11-03"), "aujourd'hui");
assert.equal(P.dueLabel("2026-11-04", "2026-11-03"), "demain");
assert.equal(P.dueLabel("2026-10-29", "2026-11-03"), "en retard de 5 j");
assert.equal(P.dueLabel("2026-11-12", "2026-11-03"), "dans 9 j");
assert.equal(P.dueLabel("2026-12-15", "2026-11-03"), "15 déc.");
assert.equal(P.dueLabel("2027-02-01", "2026-11-03"), "1 févr. 2027");
assert.equal(P.dateLabel("2026-10-01", "2026-11-03"), "1 oct.");
assert.equal(P.isoToday(new Date(2026, 0, 5)), "2026-01-05");

const proj = { id: "prj-a", milestones: [{ id: "m1", title: "B", due: "2026-12-01", done: false }, { id: "m2", title: "A", due: "2026-11-01", done: true }, { id: "m3", title: "C", due: null, done: false }],
  bom: [{ item: "itm-1", qty: 4, cost: 899, status: "need" }, { item: "itm-2", qty: 2, cost: null, status: "need" }, { item: null, qty: 1, cost: 1495, status: "ordered" }, { item: null, qty: 1, cost: 100, status: "have" }] };
const tasks = [{ id: "c-1", project: "prj-a", column: "done" }, { id: "c-2", project: "prj-a", column: "todo" }, { id: "c-3", column: "todo" }, { id: "c-4", project: "prj-gone", column: "doing" }];
assert.deepEqual(P.progress(proj, tasks), { done: 2, total: 5, pct: 40 });
assert.equal(P.nextMilestone(proj).title, "B", "next open milestone by date, undated last");
assert.deepEqual(P.bomTotals(proj, new Map([["itm-1", 6], ["itm-2", 1]])), { cost: 899 * 4 + 1495 + 100, missing: 2, priced: 3, lines: 4 });
assert.equal(P.money(759100), "7 591,00 $");
assert.equal(P.parseMoney("12,99"), 1299);
assert.equal(P.parseMoney("12.5 $"), 1250);
assert.equal(P.parseMoney(""), null);
assert.ok(Number.isNaN(P.parseMoney("douze")));
// free tasks: no project, or a project that no longer exists (a deleted project's cards are never lost)
assert.deepEqual(P.tasksOf(tasks, "libres", new Set(["prj-a"])).map((t) => t.id), ["c-3", "c-4"]);
assert.deepEqual(P.tasksOf(tasks, "prj-a", new Set(["prj-a"])).map((t) => t.id), ["c-1", "c-2"]);
// links open only same-origin endpoints, encoded
assert.equal(P.linkHref({ kind: "file", ref: "Uni/GIA 1077/plan#1.pdf" }), "/files/Uni/GIA%201077/plan%231.pdf");
assert.equal(P.linkHref({ kind: "forge", ref: "img_1" }), "/api/forge/gallery/img_1/original");
assert.equal(P.linkHref({ kind: "carnet", ref: "page-1" }), null);
for (const h of ["#projets", "#projets/libres", "#projets/prj-0123456789abcdef", "#projets/prj-0123456789abcdef/bom"]) assert.ok(P.HASH_RE.test(h), h);
for (const h of ["#projets/prj-x", "#projets/prj-0123456789abcdef/evil", "#inventaire"]) assert.ok(!P.HASH_RE.test(h), h);

const src = readFileSync(new URL("../assets/hq-projects.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sendBeacon", "WebSocket"]) assert.ok(!src.includes(bad), "no " + bad);
console.log("check_hq_projects: ok");
