// Pure checks for the Fichiers UI (assets/hq-files.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const F = require("../assets/hq-files.js").pure;

assert.equal(F.extOf("Rapport.Final.PDF"), "pdf");
assert.equal(F.extOf("sans-extension"), "");
assert.equal(F.extOf(".bashrc"), "bashrc");
assert.equal(F.kindOf("photo.HEIC").family, "image");
assert.equal(F.kindOf("plan.pdf").family, "pdf");
assert.equal(F.kindOf("support.stl").family, "model");
assert.equal(F.kindOf("Devoir 3.xlsx").label, "Tableur");
assert.equal(F.kindOf("inconnu.xyz").family, "file");
assert.equal(F.rootHue("Uni/GIA1077"), 262);
assert.equal(F.rootHue("Inbox"), 168);
assert.equal(F.rootHue("Print/a.pdf"), 34);
assert.equal(F.rootHue(""), 210);

assert.equal(F.parentOf("Uni/A/b.pdf"), "Uni/A");
assert.equal(F.parentOf("Uni"), "");
assert.equal(F.joinRel("", "Uni"), "Uni");
assert.equal(F.joinRel("Uni", "A"), "Uni/A");
assert.ok(F.within("Uni/A/b", "Uni/A"));
assert.ok(F.within("Uni/A", "Uni/A"));
assert.ok(!F.within("Uni/AB", "Uni/A"), "a sibling with a longer name is not inside");

const items = [
  { name: "b10.txt", type: "file", size: 5, mtime: 30 },
  { name: "b2.txt", type: "file", size: 50, mtime: 10 },
  { name: "Zeta", type: "dir", mtime: 1 },
  { name: "élan.md", type: "file", size: 1, mtime: 20 },
  { name: "alpha", type: "dir", mtime: 99 },
];
assert.deepEqual(F.sortItems(items, "name").map((i) => i.name), ["alpha", "Zeta", "b2.txt", "b10.txt", "élan.md"], "folders first, natural, accents folded");
assert.deepEqual(F.sortItems(items, "recent").map((i) => i.name), ["alpha", "Zeta", "b10.txt", "élan.md", "b2.txt"]);
assert.deepEqual(F.sortItems(items, "size").map((i) => i.name).slice(2), ["b2.txt", "b10.txt", "élan.md"]);
assert.equal(items[0].name, "b10.txt", "sorting never mutates the input");
assert.deepEqual(F.filterItems(items, "ELAN").map((i) => i.name), ["élan.md"]);
assert.deepEqual(F.filterItems(items, "b txt").map((i) => i.name), ["b10.txt", "b2.txt"]);
assert.equal(F.filterItems(items, "  ").length, 5);

const order = ["a", "b", "c", "d", "e"];
assert.deepEqual(F.rangeSelect(order, "b", "d"), ["b", "c", "d"]);
assert.deepEqual(F.rangeSelect(order, "e", "c"), ["c", "d", "e"]);
assert.deepEqual(F.rangeSelect(order, "gone", "c"), ["c"]);

for (const ok of ["notes.txt", "Cours 1 (copie)", "é à ç"]) assert.ok(F.validName(ok), ok);
for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "x:y", "q?", "<x>", "a\u0001", "x".repeat(201)]) assert.ok(!F.validName(bad), JSON.stringify(bad));

assert.equal(F.fmtBytes(0), "0 o");
assert.equal(F.fmtBytes(23900), "23,3 Ko");
assert.equal(F.fmtBytes(5 * 1048576), "5,0 Mo");
assert.equal(F.fmtBytes(3 * 1073741824), "3,00 Go");
assert.equal(F.when(1000, 1030), "à l'instant");
assert.equal(F.when(1000, 1000 + 7200), "il y a 2 h");
assert.equal(F.when(1000, 1000 + 86400), "hier");

assert.equal(F.uploadTarget(""), "Inbox", "uploading from the top level lands in Inbox");
assert.equal(F.uploadTarget(F.TRASH), "Inbox", "never into the Corbeille view");
assert.equal(F.uploadTarget("Uni/A"), "Uni/A");
assert.equal(F.fileUrl("Uni/GIA 1077/plan#1.pdf"), "/files/Uni/GIA%201077/plan%231.pdf");
assert.equal(F.dlUrl("Inbox/a?b.txt"), "/download/Inbox/a%3Fb.txt");
assert.equal(F.mediaUrl("Inbox/v.mp4"), "/media/Inbox/v.mp4");
assert.ok(F.TRASH.startsWith("\u0000"), "the Corbeille view can never collide with a real path");

// automatic backups: one line of status
assert.equal(F.untilText(20), "dans un instant");
assert.equal(F.untilText(45 * 60), "dans 45 min");
assert.equal(F.untilText(23 * 3600), "dans 23 h");
assert.equal(F.untilText(6 * 86400), "dans 6 j");
assert.equal(F.bkStatus(null, 0).tone, "none");
const job = { enabled: true, keep: 10, snapshots: [{ id: "20261031_164900" }], last_backup_at: 1000, next_at: 1000 + 86400 };
assert.deepEqual(F.bkStatus(job, 1000 + 7200), { tone: "ok", text: "Dernière copie il y a 2 h · prochaine dans 22 h" });
assert.equal(F.bkStatus({ ...job, running: { kind: "backup", done: 1, total: 4 } }, 0).text, "Copie en cours… 25 %");
assert.equal(F.bkStatus({ ...job, running: { kind: "queued" } }, 0).tone, "run");
assert.equal(F.bkStatus({ ...job, missing: true }, 0).tone, "bad", "a folder that is gone is a problem…");
assert.equal(F.bkStatus({ ...job, last_error: "Lecteur D: introuvable" }, 0).text, "Lecteur D: introuvable");
assert.equal(F.bkStatus({ ...job, enabled: false }, 0).tone, "paused");
assert.equal(F.bkStatus({ ...job, snapshots: [], last_backup_at: null, next_at: null }, 0).text, "Aucune copie encore");
assert.deepEqual(Object.keys(F.EVERY_LABEL), ["hour", "day", "week"]);
const t0 = new Date(2026, 9, 31, 21, 45).getTime() / 1000; // Saturday
assert.deepEqual(F.nextTimes("hour", t0, 3), ["maintenant", "22 h 45", "23 h 45"]);
assert.deepEqual(F.nextTimes("day", t0, 3), ["maintenant", "demain 21 h 45", "lun. 21 h 45"]);
assert.deepEqual(F.nextTimes("week", t0, 3), ["maintenant", "7 nov.", "14 nov."]);
assert.equal(F.ringFrac({ every: "hour", last_run_at: 1000 }, 1000 + 900), 0.25);
assert.equal(F.ringFrac({ every: "day", last_run_at: 1000 }, 1000 + 3 * 86400), 1, "capped when overdue");
assert.equal(F.ringFrac({ every: "day" }, 5), 0, "never ran: empty ring");

// house rules
const src = readFileSync(new URL("../assets/hq-files.js", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), "no HTML from strings");
assert.ok(/prefers-reduced-motion/.test(src), "motion respects reduced-motion");
const css = readFileSync(new URL("../assets/hq-files.css", import.meta.url), "utf8");
assert.ok(/prefers-reduced-motion/.test(css));
assert.ok(/prefers-color-scheme:\s*light|\[data-theme="light"\]|\.light/.test(css), "light theme handled");
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
assert.ok(bridge.includes('<script src="/assets/hq-files.js"></script>'));
assert.ok(bridge.indexOf("hq-projects.js") < bridge.indexOf("hq-files.js"));
console.log("check_hq_files: ok");
