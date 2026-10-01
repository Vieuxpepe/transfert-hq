// Pure checks of the Product Phase-2 structured-block core (assets/hq-carnet-struct.js + its integration in hq-carnet-rich.js):
// Python/JS validation + export parity on the shared vectors (tests/fixtures_carnet_structured.json, generated from the PYTHON
// implementation), TSV, table / group edit operations, draft encoding, page limits, search text, title semantics, attachment predicate.
// No browser, no server, no live data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Rich = require("../assets/hq-carnet-rich.js");
const S = Rich.Struct;
const V = JSON.parse(readFileSync(new URL("./fixtures_carnet_structured.json", import.meta.url), "utf8"));
let groups = 0;
const group = (name, fn) => {
  try {
    fn();
    groups += 1;
  } catch (e) {
    console.error("FAIL group:", name);
    throw e;
  }
};

const asset = (c, cap = "") => ({ id: "asset-" + c.repeat(24), mime: "image/png", w: 10, h: 8, caption: cap });
const blk = (type, payload, id) => ({ id: id || "block-x", type, text: "", marks: [], [S.KEY[type]]: payload });

group("payload validation parity with Python (valid -> identical clean copy, invalid -> null)", () => {
  assert.ok(V.payload.length >= 70);
  for (const c of V.payload) {
    const got = S.checkPayload(c.type, c.in, Rich.checkAsset);
    if (c.out === null) assert.equal(got, null, c.name + " must be rejected");
    else assert.deepEqual(got, c.out, c.name + " must be accepted unchanged");
  }
});

group("unknown / wrong-type payload rejected at the block level, no payload key on other blocks", () => {
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ type: "table", text: "", marks: [], callout: { kind: "note", title: "", body: "" } }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ type: "paragraph", text: "", marks: [], table: { header: true, rows: [["a"]] } }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ ...blk("table", { header: true, rows: [["a"]] }), text: "x" }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ ...blk("table", { header: true, rows: [["a"]] }), marks: [{ type: "bold", start: 0, end: 1 }] }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ ...blk("table", { header: true, rows: [["a"]] }), checked: false }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ ...blk("table", { header: true, rows: [["a"]] }), asset: {} }] }), null);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [blk("table", { header: 1, rows: [["a"]] })] }), null);
  const ok = Rich.linesFromContent({ version: 2, blocks: [blk("table", { header: true, rows: [["a"]] })] });
  assert.ok(ok && ok[0].type === "table" && ok[0].text === "" && ok[0].marks.length === 0 && Rich.isAtom(ok[0]));
});

group("exports: TXT / Markdown byte-identical to Python (with and without asset paths)", () => {
  for (const r of V.render) {
    const content = { version: 2, blocks: r.blocks.map((b, i) => blk(b.type, b.payload, "block-" + i)) };
    const lines = Rich.linesFromContent(content);
    assert.ok(lines, r.name);
    assert.equal(Rich.renderTxt(lines), r.txt, r.name + " txt");
    assert.equal(Rich.renderMarkdown(lines, r.paths), r.md, r.name + " md");
    assert.equal(Rich.renderMarkdown(lines, null), r.md_nopaths, r.name + " md without paths");
    assert.equal(Rich.structSearchText(Rich.fmtOf(lines)), r.search_struct, r.name + " search text (structured part)");
    assert.equal(lines.reduce((n, l) => n + (S.TYPES.includes(l.type) ? S.bytesOf(l.type, l.struct) : 0), 0), r.bytes, r.name + " structured bytes");
  }
});

group("headerless Markdown table keeps row 0 as data (synthetic empty header)", () => {
  const l = Rich.structLine("table", { header: false, rows: [["A", "B"], ["C", "D"]] });
  assert.equal(Rich.renderMarkdown([l]), "|  |  |\n|---|---|\n| A | B |\n| C | D |\n");
  const h = Rich.structLine("table", { header: true, rows: [["A", "B"], ["C", "D"]] });
  assert.equal(Rich.renderMarkdown([h]), "| A | B |\n|---|---|\n| C | D |\n");
});

group("draft encoding round trip is exact, strict, and old drafts keep their bytes", () => {
  const lines = [
    Rich.newLine("Titre"),
    Rich.structLine("table", { header: true, rows: [["a", "b"], ["c", "d"]] }),
    Rich.structLine("callout", { kind: "info", title: "t", body: "x\ny" }),
    Rich.structLine("toggle", { summary: "s", body: "b" }),
    Rich.structLine("imagegroup", { layout: "compare", items: [asset("a", "av"), asset("b")] }),
  ];
  const text = Rich.flat(lines);
  const fmt = Rich.fmtOf(lines);
  const back = Rich.linesFromTextFmt(text, fmt, null);
  assert.ok(back);
  assert.equal(Rich.fmtOf(back), fmt);
  assert.deepEqual(back.map((l) => l.struct), lines.map((l) => l.struct));
  assert.equal(Rich.fmtOf([Rich.newLine("x")]), "", "a plain page still has the empty fmt");
  // a malformed struct row never loads
  const rows = JSON.parse(fmt);
  const bad = (mut) => {
    const r = JSON.parse(fmt);
    mut(r);
    return Rich.linesFromTextFmt(text, JSON.stringify(r), null);
  };
  assert.equal(bad((r) => (r[1][3][1][0][0] = 5)), null, "non-string cell");
  assert.equal(bad((r) => r[1].pop()), null, "struct row without payload");
  assert.equal(bad((r) => (r[0][3] = [1])), null, "payload on a text row");
  assert.equal(bad((r) => (r[1][2] = [["bold", 0, 1]])), null, "marks on an atom");
  assert.equal(bad((r) => (r[4][3][1][1][0] = r[4][3][1][0][0])), null, "duplicate child asset");
  assert.ok(rows.length === 5);
});

group("page limits (tables 20, notes 100, groups 16, images 32 incl. children, 96 KiB structured text)", () => {
  const t = () => Rich.structLine("table", { header: true, rows: [["a"]] });
  const c = () => Rich.structLine("callout", { kind: "note", title: "", body: "x" });
  assert.equal(Rich.structLimits(Array.from({ length: 20 }, t)), null);
  assert.equal(Rich.structLimits(Array.from({ length: 21 }, t)), "tables");
  assert.equal(Rich.structLimits(Array.from({ length: 100 }, c)), null);
  assert.equal(Rich.structLimits(Array.from({ length: 101 }, c)), "notes");
  const g = () => Rich.structLine("imagegroup", { layout: "two", items: [asset("a"), asset("b")] });
  assert.equal(Rich.structLimits(Array.from({ length: 16 }, g)), null);
  assert.equal(Rich.structLimits(Array.from({ length: 17 }, g)), "groups");
  const img = Rich.imageLine({ ...asset("c"), width: 100, layout: "inline" });
  assert.equal(Rich.structLimits(Array.from({ length: 16 }, g).concat([img])), "images");
  const big = () => Rich.structLine("callout", { kind: "note", title: "", body: "x".repeat(2000) });
  assert.equal(Rich.structLimits(Array.from({ length: 48 }, big)), null);
  assert.equal(Rich.structLimits(Array.from({ length: 50 }, big)), "bytes");
  assert.equal(Rich.structLimits([Rich.newLine("p")]), null);
});

group("client assetsOf covers single images and group children, in document order", () => {
  const lines = [Rich.imageLine({ ...asset("a"), width: 100, layout: "inline" }), Rich.structLine("imagegroup", { layout: "three", items: [asset("b"), asset("c"), asset("d")] })];
  assert.deepEqual(Rich.assetsOf(lines).map((a) => a.id[6]), ["a", "b", "c", "d"]);
});

group("TSV: deterministic copy, bounded atomic paste", () => {
  assert.equal(S.formatTsv([["a", "b"], ["", "d"]]), "a\tb\n\td", "no trailing newline, no header marker, no metadata");
  assert.deepEqual(S.parseTsv("a\tb\r\nc\td\r\n"), { rows: [["a", "b"], ["c", "d"]] });
  assert.deepEqual(S.parseTsv("a\tb\nc"), { rows: [["a", "b"], ["c", ""]] }, "short rows are padded");
  assert.deepEqual(S.parseTsv("x"), { rows: [["x"]] });
  assert.deepEqual(S.parseTsv("a\u0001b c"), { rows: [["a b c"]] }, "controls become spaces");
  assert.deepEqual(S.parseTsv("a\r\r"), { rows: [["a"], [""]] }, "only ONE trailing empty line is dropped");
  assert.equal(S.parseTsv("").error, "empty");
  assert.equal(S.parseTsv("x\n".repeat(21)).error, "rows");
  assert.deepEqual(S.parseTsv("x\n".repeat(20)).rows.length, 20);
  assert.equal(S.parseTsv(Array(11).fill("x").join("\t")).error, "cols");
  assert.equal(S.parseTsv("x".repeat(201)).error, "cell");
  assert.equal(S.parseTsv(Array.from({ length: 20 }, () => Array(10).fill("é".repeat(100)).join("\t")).join("\n")).error, "size");
  const round = [["a", "b"], ["c", ""]];
  assert.deepEqual(S.parseTsv(S.formatTsv(round)).rows, round, "copy then paste is lossless");
  // pasteGrid: fills from the cell, grows within bounds, rejects ATOMICALLY otherwise
  const base = [["1", "2"], ["3", "4"]];
  assert.deepEqual(S.pasteGrid(base, 1, 1, [["x", "y"], ["z", "w"]]), [["1", "2", ""], ["3", "x", "y"], ["", "z", "w"]]);
  assert.equal(S.pasteGrid(Array.from({ length: 20 }, () => ["a"]), 19, 0, [["x"], ["y"]]), null, "would need row 21");
  assert.equal(S.pasteGrid([Array(10).fill("a")], 0, 9, [["x", "y"]]), null, "would need column 11");
  assert.deepEqual(base, [["1", "2"], ["3", "4"]], "the input is never mutated");
});

group("table edit operations keep rectangles and bounds", () => {
  const t = [["a", "b"], ["c", "d"]];
  assert.deepEqual(S.addRow(t, 1), [["a", "b"], ["", ""], ["c", "d"]]);
  assert.deepEqual(S.addCol(t, 1), [["a", "", "b"], ["c", "", "d"]]);
  assert.deepEqual(S.removeRow(t, 0), [["c", "d"]]);
  assert.deepEqual(S.removeCol(t, 1), [["a"], ["c"]]);
  assert.equal(S.removeRow([["a"]], 0), null, "the last row stays");
  assert.equal(S.removeCol([["a"], ["b"]], 0), null, "the last column stays");
  assert.equal(S.addRow(Array.from({ length: 20 }, () => ["a"]), 3), null);
  assert.equal(S.addCol([Array(10).fill("a")], 3), null);
  assert.deepEqual(t, [["a", "b"], ["c", "d"]]);
  for (const rows of [S.addRow(t, 0), S.addCol(t, 0), S.removeRow(t, 1), S.removeCol(t, 0)]) assert.ok(S.checkTable({ header: true, rows }));
});

group("image group operations: never a 1-image or duplicate group; ungroup keeps asset identity", () => {
  const g2 = { layout: "two", items: [asset("a", "x"), asset("b")] };
  const g3 = S.groupAdd(g2, asset("c"));
  assert.equal(g3.layout, "three");
  assert.equal(S.groupAdd(g3, asset("d")), null);
  assert.equal(S.groupAdd(g2, asset("a")), null, "duplicate");
  assert.equal(S.groupRemove(g2, 0), null, "would leave one image");
  assert.deepEqual(S.groupRemove(g3, 1).items.map((a) => a.id[6]), ["a", "c"]);
  assert.equal(S.groupRemove(g3, 1).layout, "two");
  assert.deepEqual(S.groupMove(g3, 0, 1).items.map((a) => a.id[6]), ["b", "a", "c"]);
  assert.equal(S.groupMove(g3, 0, -1), null);
  assert.equal(S.groupMove(g3, 2, 1), null);
  assert.equal(S.groupReplace(g2, 1, asset("a")), null, "replacing with a sibling");
  assert.equal(S.groupReplace(g2, 0, asset("f")).items[0].caption, "x", "the caption stays");
  assert.equal(S.groupSetLayout(g2, "compare").layout, "compare");
  assert.equal(S.groupSetLayout(g2, "three"), null);
  assert.equal(S.groupFrom([asset("a")], null), null);
  assert.equal(S.groupFrom([asset("a"), asset("a")], null), null);
  assert.equal(S.groupFrom([asset("a", "k"), asset("b")], null).items[0].caption, "k");
  for (const g of [g2, g3, S.groupMove(g3, 0, 1), S.groupReplace(g2, 0, asset("f"))]) assert.ok(S.checkGroup(g, Rich.checkAsset));
});

group("title semantics: structured blocks are atoms with empty text (no title, no preview, no offsets)", () => {
  const lines = [Rich.structLine("table", { header: true, rows: [["Tableau"]] }), Rich.structLine("callout", { kind: "info", title: "Titre", body: "corps" }), Rich.newLine("Vrai titre")];
  assert.equal(Rich.flat(lines), "\n\nVrai titre");
  assert.equal(Rich.flat(lines).split("\n").find((x) => x.trim()), "Vrai titre");
  const C = require("../assets/hq-carnet-commands.js");
  assert.equal(C.titleIndex(lines), 2, "the visual title is the first real text line");
  assert.equal(C.titleIndex([Rich.structLine("toggle", { summary: "S", body: "" }), Rich.newLine("")]), -1, "a structured block is never the visual title");
});

group("library search text: visible strings only (never keys, kinds, ids, mime)", () => {
  const lines = [Rich.newLine("p"), Rich.structLine("table", { header: true, rows: [["cellA", "cellB"]] }), Rich.structLine("callout", { kind: "warning", title: "titreC", body: "corpsC" }),
    Rich.structLine("toggle", { summary: "sumT", body: "bodyT" }), Rich.structLine("imagegroup", { layout: "compare", items: [asset("a", "capG"), asset("b")] })];
  const text = Rich.structSearchText(Rich.fmtOf(lines));
  for (const w of ["cellA", "cellB", "titreC", "corpsC", "sumT", "bodyT", "capG"]) assert.ok(text.includes(w), w);
  for (const w of ["warning", "compare", "asset-", "image/", "header"]) assert.ok(!text.includes(w), w);
  assert.equal(Rich.structSearchText(Rich.fmtOf([Rich.newLine("seul")])), "");
  assert.equal(Rich.structSearchText("not json ['t',0,"), "");
});

group("attachment card predicate: exactly one whole-line file link, nothing else", () => {
  const ref = { kind: "file", id: "Inbox/Dir/plan.pdf" };
  const line = (text, marks, type = "paragraph") => ({ type, checked: false, text, marks, id: null, asset: null, eng: null, struct: null });
  const link = (s, e, r = ref) => ({ type: "link", start: s, end: e, ref: r });
  assert.deepEqual(Rich.attachmentOf(line("plan.pdf", [link(0, 8)])), ref);
  assert.equal(Rich.attachmentOf(line("Download plan.pdf please", [link(9, 17)])), null, "partial link");
  assert.equal(Rich.attachmentOf(line("plan.pdf ", [link(0, 8)])), null, "trailing whitespace");
  assert.equal(Rich.attachmentOf(line(" plan.pdf", [link(1, 9)])), null, "leading whitespace");
  assert.equal(Rich.attachmentOf(line(" plan.pdf ", [link(0, 10)])), null, "whitespace inside the link");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [link(0, 8), { type: "bold", start: 0, end: 8 }])), null, "other marks");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [{ type: "link", start: 0, end: 8, href: "https://example.com/plan.pdf" }])), null, "an http link is not a file");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [link(0, 8, { kind: "note", id: "page-abc" })])), null, "other ref kinds");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [link(0, 8, { kind: "media", id: "Inbox/a.png" })])), null, "media is not an attachment");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [link(0, 4), link(4, 8)])), null, "two links");
  assert.equal(Rich.attachmentOf(line("plan.pdf", [link(0, 8)], "bullet")), null, "only a paragraph");
  assert.equal(Rich.attachmentOf(line("", [])), null);
  assert.equal(Rich.attachmentOf(line("x", [link(0, 1, { kind: "file", id: "/etc/passwd" })])), null, "an unsafe id never validates");
});

group("the editor model is untouched for old pages (no struct key appears, no row grows)", () => {
  const old = [Rich.newLine("a"), Rich.imageLine({ ...asset("a"), width: 100, layout: "inline" }), Rich.newLine("b", "heading")];
  const fmt = Rich.fmtOf(old);
  assert.ok(!/"[togj]",0,/.test(fmt));
  const c = Rich.contentFromLines(old);
  assert.deepEqual(c.blocks.map((b) => Object.keys(b).sort().join(",")), ["marks,text,type", "asset,marks,text,type", "marks,text,type"]);
  assert.equal(Rich.linesFromContent(c).length, 3);
});

console.log("hq carnet structured checks ok (" + groups + " groups)");
