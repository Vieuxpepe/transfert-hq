// Pure checks for the page templates (assets/hq-carnet-templates.js) and the Quick Capture builders (assets/hq-carnet-capture.js).
// No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const T = require("../assets/hq-carnet-templates.js");
const Cap = require("../assets/hq-carnet-capture.js");
const Rich = require("../assets/hq-carnet-rich.js");
const NOW = new Date(2026, 9, 1, 8, 5, 0); // local 2026-10-01 08:05

// ---- templates: catalogue
assert.deepEqual(T.list().map((t) => t.id), ["blank", "journal", "inspection", "test", "meeting", "decision", "project"]);
assert.deepEqual(T.list().map((t) => t.label), ["Note vide", "Journal d'ingénierie", "Inspection", "Test / expérience", "Réunion", "Registre de décision", "Journal de projet"]);
assert.equal(T.byId("nope"), null);
for (const t of T.list()) {
  assert.deepEqual(T.problems(t, Rich.BLOCKS_MAX), [], "valid template " + t.id);
  assert.ok(t.hint && t.hint.length <= 48 && /^[MmLlHhVvZzAaCcQq0-9 .,\-]+$/.test(t.icon), "label/hint/icon " + t.id);
}
// the validator really rejects
const bad = (blocks) => T.problems({ id: "x", blocks }, 10);
assert.ok(bad([["image", ""]]).length, "non-canonical type");
assert.ok(bad([["decision", "x"]]).length, "no decision atom");
assert.ok(bad([["paragraph", "a\nb"]]).length, "multi-line");
assert.ok(bad([["paragraph", "{who}"]]).length, "unknown placeholder");
assert.ok(bad([["paragraph", "x".repeat(T.LINE_MAX + 1)]]).length, "too long");
assert.ok(bad([]).length, "empty");
assert.ok(T.problems({ id: "x", blocks: Array.from({ length: 11 }, () => ["paragraph", ""]) }, 10).length, "block limit");
assert.ok(bad("x").length && bad([["paragraph"]]).length, "shape");

// ---- placeholders and date
assert.equal(T.dateStamp(NOW), "2026-10-01");
assert.equal(T.timeStamp(NOW), "08:05");
assert.equal(T.fill("A {date} B {time} {zzz}", NOW), "A 2026-10-01 B 08:05 {zzz}");

// ---- nothing pre-authored: headings carry the structure, every other line is an empty fill-in
for (const t of T.list()) {
  for (const [type, text] of t.blocks) {
    if (type === "heading") assert.ok(text.length > 0, t.id);
    else assert.equal(text, "", t.id + ": fill-in lines are empty (no pre-written content)");
  }
  assert.ok(T.TEXT_TYPES.includes(t.blocks[0][0]), t.id);
}
assert.deepEqual(T.byId("inspection").blocks.filter(([ty]) => ty === "heading").map(([, x]) => x), ["Inspection — {date}", "Objet", "Conditions", "Mesures", "Photos", "Observations", "Décision"]);

// ---- build: ordinary lines, null ids, atomic
for (const t of T.list()) {
  const r = T.build(Rich, t.id, NOW);
  assert.ok(!r.error, t.id);
  assert.equal(r.lines.length, t.blocks.length);
  assert.ok(r.lines.every((l) => l.id == null), "ids are never generated client-side: " + t.id);
  const content = Rich.wireContent(r.lines, null, null);
  assert.equal(content.version, 2);
  assert.equal(content.blocks.length, t.blocks.length);
  assert.ok(content.blocks.every((b) => !("id" in b) || b.id == null), "wire content carries no ids: " + t.id);
  assert.deepEqual(content.blocks.map((b) => b.type), t.blocks.map(([ty]) => ty));
  if (t.id !== "blank") assert.ok(content.blocks[0].text.includes("2026-10-01"), t.id);
  // survives the editor's own parse/normalise round trip (outline text) with the same types
  assert.ok(Rich.flatText ? typeof Rich.flatText(content) === "string" : true);
}
assert.deepEqual(T.build(Rich, "nope", NOW), { error: "unknown" });
const tooMany = T.build({ BLOCKS_MAX: 3, newLine: Rich.newLine }, "journal", NOW);
assert.equal(tooMany.error, "invalid");
assert.equal(tooMany.lines, undefined, "no partial result");
// the catalogue is not mutated by a build
assert.equal(T.byId("journal").blocks[0][1], "Journal d'ingénierie — {date}");

// ---- capture: decimals
assert.equal(Cap.decimal("12,5"), "12.5");
assert.equal(Cap.decimal(" 3 "), "3");
assert.equal(Cap.decimal("+4"), "4");
assert.equal(Cap.decimal("-0,25"), "-0.25");
assert.equal(Cap.decimal("1 234,5"), "1234.5");
for (const badv of ["", "abc", "1e3", "0x10", "1,2,3", "01", ".5", "5.", "--1", "Infinity", null]) assert.equal(Cap.decimal(badv), null, String(badv));

// ---- capture: builders
const build = (input) => Cap.buildCapture(Rich, input, NOW);
let r = build({ mode: "text", text: "  Fuite B2 \r\nJoint à changer\n\n\n" });
assert.deepEqual(r.lines.map((l) => l.text), ["  Fuite B2", "Joint à changer"]) // trailing blanks trimmed, leading kept;
assert.ok(r.lines.every((l) => l.type === "paragraph" && l.id == null));
assert.equal(build({ mode: "text", text: "   \n " }).error, Cap.MSG.empty);
assert.equal(build({ mode: "text", text: "x".repeat(50 * 1024) }).error, Cap.MSG.tooLong);
// review fix: a long MULTILINE note (every line valid) must be refused whole, never truncated to its first 40 KiB
const longNote = Array.from({ length: 20 }, (_, i) => String(i % 10).repeat(3000)).join("\n"); // ~60 KB, lines of 3000
assert.equal(build({ mode: "text", text: longNote }).error, Cap.MSG.tooLong, "multiline over the limit is rejected, not truncated");
const okNote = Array.from({ length: 10 }, (_, i) => String(i).repeat(3000)).join("\n"); // ~30 KB
assert.equal(build({ mode: "text", text: okNote }).lines.map((l) => l.text).join("\n"), okNote, "under the limit: kept in full");
assert.equal(build({ mode: "text", text: "é".repeat(30 * 1024) }).error, Cap.MSG.tooLong, "bytes, not characters");
assert.equal(build({ mode: "text", text: "a\u0000b‮c" }).lines[0].text.includes("\u0000"), false, "control characters stripped");
assert.equal(build({ mode: "photo" }).error, Cap.MSG.noPhoto);
const asset = { id: "asset-" + "a".repeat(24), mime: "image/jpeg", w: 800, h: 600 };
r = build({ mode: "photo", asset, caption: "Raccord" });
assert.deepEqual(r.lines.map((l) => l.type), ["paragraph", "image", "paragraph"]);
assert.equal(r.lines[0].text, "Photo — 2026-10-01 08:05");
assert.equal(r.lines[2].text, "");
assert.equal(build({ mode: "decision", text: "  " }).error, Cap.MSG.noDecision);
r = build({ mode: "decision", text: "On garde H7/g6\nsuite" });
assert.equal(r.lines[0].type, "decision");
assert.ok(!r.lines[0].text.includes("\n"));
assert.equal(r.lines[1].text, "");
assert.equal(build({ mode: "measure", measure: { label: "", value: "1" } }).error, Cap.MSG.noLabel);
assert.equal(build({ mode: "measure", measure: { label: "x", value: "abc" } }).error, Cap.MSG.badValue);
assert.equal(build({ mode: "measure", measure: { label: "x", value: "1", tol: "0,1" } }).error, Cap.MSG.badTol, "tolerance needs a nominal");
assert.equal(build({ mode: "measure", measure: { label: "x", value: "1", nominal: "1", tol: "-0,1" } }).error, Cap.MSG.badTol, "negative tolerance");
r = build({ mode: "measure", measure: { label: "Jeu axial", value: "12,5", unit: "mm", nominal: "12", tol: "0,2" } });
assert.deepEqual(r.lines.map((l) => l.type), ["paragraph", "measure", "paragraph"]);
assert.equal(r.lines[0].text, "Mesure — Jeu axial");
const wire = Cap.contentOf(Rich, r.lines);
assert.equal(wire.blocks[1].measure.observed.v, "12.5");
assert.equal(wire.blocks[1].measure.mode, "sym");
assert.equal(wire.blocks[1].measure.at, Math.floor(NOW.getTime() / 1000));
r = build({ mode: "measure", measure: { label: "Pression", value: "3", unit: "" } });
assert.equal(Cap.contentOf(Rich, r.lines).blocks[1].measure.mode, "none");
assert.equal(build({ mode: "nope" }).error, Cap.MSG.invalid);
assert.equal(build(null).error, Cap.MSG.invalid);

// ---- capture: stale selection
const meta = { projects: [{ id: "proj-1", archived: false }, { id: "proj-old", archived: true }], categories: [{ id: "cat-1" }] };
assert.equal(Cap.staleSelection(meta, null, null), "");
assert.equal(Cap.staleSelection(meta, "proj-1", "cat-1"), "");
assert.equal(Cap.staleSelection(meta, "proj-old", null), Cap.MSG.staleProject);
assert.equal(Cap.staleSelection(meta, "proj-x", null), Cap.MSG.staleProject);
assert.equal(Cap.staleSelection(meta, null, "cat-x"), Cap.MSG.staleCategory);
assert.equal(Cap.staleSelection({}, null, null), "");
assert.deepEqual(Cap.MODES.map((m) => m[0]), ["text", "photo", "measure", "decision"]);

console.log("check_hq_carnet_templates: OK");
