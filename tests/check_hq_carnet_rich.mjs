// Carnet Stage 04 — structured model, find/replace mark integrity, structured draft/concurrency
// (no browser, no server, no live data). Shared vectors: tests/fixtures_carnet_rich.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");
const R = require("../assets/hq-carnet-rich.js");
const vectors = JSON.parse(readFileSync(new URL("./fixtures_carnet_rich.json", import.meta.url), "utf8"));

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) {
  for (let i = 0; i < n; i += 1) await tick();
}
const clone = (x) => JSON.parse(JSON.stringify(x));
let groups = 0;
function ok(name) {
  groups += 1;
  void name;
}

// ---------------------------------------------------------------- helpers
const L = (text, type, marks, checked) => R.newLine(text, type || "paragraph", !!checked, marks || []);
const M = (type, start, end, extra) => Object.assign({ type, start, end }, extra || {});

/** Every invariant a stored/edited structure must keep. */
function assertValidLines(lines, label) {
  assert.ok(Array.isArray(lines) && lines.length >= 1, label + ": at least one line");
  let links = 0;
  for (const [i, l] of lines.entries()) {
    const tag = `${label} line ${i}`;
    assert.ok(R.BLOCK_TYPES.includes(l.type), tag + " type");
    assert.ok(!l.text.includes("\n"), tag + " newline");
    if (l.type !== "check") assert.equal(l.checked, false, tag + " checked only on check");
    for (const m of l.marks) {
      assert.ok(Number.isInteger(m.start) && Number.isInteger(m.end), tag + " int offsets");
      assert.ok(m.start >= 0, tag + " negative start");
      assert.ok(m.start < m.end, tag + " empty/reversed range");
      assert.ok(m.end <= l.text.length, tag + " out of bounds");
      const cp = l.text.charCodeAt(m.start);
      assert.ok(!(cp >= 0xdc00 && cp <= 0xdfff), tag + " splits a surrogate pair (start)");
      if (m.end < l.text.length) {
        const ce = l.text.charCodeAt(m.end);
        assert.ok(!(ce >= 0xdc00 && ce <= 0xdfff), tag + " splits a surrogate pair (end)");
      }
      if (m.type === "link") links += 1;
    }
    assert.deepEqual(l.marks, R.canonicalMarks(l.marks), tag + " canonical");
  }
  void links;
  const text = R.flat(lines);
  const fmt = R.fmtOf(lines);
  const back = R.linesFromTextFmt(text, fmt);
  assert.ok(back, label + ": text+fmt round trip");
  assert.deepEqual(R.flat(back), text);
  assert.equal(R.fmtOf(back), fmt, label + ": fmt is stable");
}

// ---------------------------------------------------------------- shared vectors (Python parity)
for (const c of vectors.canonical) assert.deepEqual(R.canonicalMarks(c.in), c.out, "canonical: " + c.name);
for (const c of vectors.render) {
  const lines = R.linesFromContent({ version: 2, blocks: c.blocks });
  assert.ok(lines, c.name);
  assert.equal(R.renderTxt(lines), c.txt, c.name + " txt");
  assert.equal(R.renderMarkdown(lines), c.md, c.name + " md");
}
for (const c of vectors.filename) assert.equal(R.exportFilename(c.given, c.title, c.fmt), c.out, "filename " + c.name);
ok("shared Python/JS vectors");

// ---------------------------------------------------------------- safe URLs / refs
{
  const good = ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "https://user-less.example:8443/p", "http://[::1]:8080/x", "https://例え.jp/パス"];
  for (const u of good) assert.equal(R.safeHref(u), u, u);
  const bad = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "blob:https://x/uuid",
    "ftp://example.com", "mailto:a@b.c", "//example.com", "example.com", "http:", "https://", "http:///nohost", "https://user:pw@example.com",
    "https://exa mple.com", "https://example.com/\nx", "https://example.com/\\x", "https://example.com/<x>", 'https://example.com/"x', "http://x:99999999/",
    "https://" + "a".repeat(3000), "", null, undefined, 5, ["https://a.b"], {},
  ];
  for (const u of bad) assert.equal(R.safeHref(u), null, String(u));
  const okRefs = [
    { kind: "note", id: "page-shaft" }, { kind: "file", id: "Uni/Cours/notes.pdf" }, { kind: "media", id: "Inbox/Photos/a.jpg" },
    { kind: "model", id: "Print/part.stl" }, { kind: "drawing", id: "shaft-v2" },
  ];
  for (const r of okRefs) assert.deepEqual(R.checkRef(r), r);
  const badRefs = [
    { kind: "note", id: "shaft" }, { kind: "url", id: "x" }, { kind: "file", id: "../secret.txt" }, { kind: "file", id: "Inbox/../../x" },
    { kind: "file", id: "/etc/passwd" }, { kind: "file", id: "C:/Windows/x" }, { kind: "file", id: "Inbox\\x.txt" }, { kind: "file", id: "Elsewhere/x.txt" },
    { kind: "file", id: "Inbox/.hidden" }, { kind: "file", id: "Inbox/%2e%2e/x" }, { kind: "file", id: "Inbox" }, { kind: "model", id: "Print/a.pdf" },
    { kind: "media", id: "Uni/a.pdf" }, { kind: "drawing", id: "../x" }, { kind: "note" }, { kind: "note", id: "page-a", extra: 1 }, "page-a", null,
  ];
  for (const r of badRefs) assert.equal(R.checkRef(r), null, JSON.stringify(r));
  // a stored mark with an unsafe target makes the whole structure unusable (fail closed), never silently plain
  assert.equal(R.linesFromContent({ version: 2, blocks: [{ type: "paragraph", text: "abc", marks: [{ type: "link", start: 0, end: 2, href: "javascript:x" }] }] }), null);
  assert.equal(R.setLink([L("abc")], 0, 2, { href: "javascript:alert(1)" }), null);
  assert.equal(R.setLink([L("abc")], 0, 2, { ref: { kind: "file", id: "../x" } }), null);
  ok("safe links + refs");
}

// ---------------------------------------------------------------- canonical string / equality
{
  const a = [L("hello world", "paragraph", [M("bold", 0, 5), M("italic", 3, 8)])];
  const b = [L("hello world", "paragraph", [M("italic", 3, 8), M("bold", 0, 2), M("bold", 2, 5)])];
  const c = R.linesFromContent({ version: 2, blocks: [{ marks: [{ end: 8, start: 3, type: "italic" }, { end: 5, type: "bold", start: 0 }], text: "hello world", type: "paragraph" }] });
  const na = R.linesFromTextFmt("hello world", R.fmtOf(a));
  assert.equal(R.fmtOf(R.linesFromTextFmt("hello world", R.fmtOf(b))), R.fmtOf(na), "insertion order never matters");
  assert.equal(R.fmtOf(c), R.fmtOf(na), "JSON key order never matters");
  assert.notEqual(R.fmtOf([L("hello world", "paragraph", [M("bold", 0, 5)])]), R.fmtOf([L("hello world", "paragraph", [M("bold", 0, 6)])]), "different ranges differ");
  assert.notEqual(R.fmtOf([L("x", "bullet")]), R.fmtOf([L("x", "number")]));
  assert.notEqual(R.fmtOf([L("x", "check", [], true)]), R.fmtOf([L("x", "check", [], false)]));
  assert.equal(R.fmtOf([L("a"), L("")]), "", "plain paragraphs have the empty structure string");
  // fail closed on a structure that does not fit the text
  for (const [text, fmt] of [
    ["a\nb", '[["p",0,[]]]'], ["a", '[["p",0,[["bold",0,9]]]]'], ["a", "not json"], ["a", '[["x",0,[]]]'], ["a", '[["p",1,[]]]'],
    ["a", '[["p",0,[["bold",-1,1]]]]'], ["a", '[["p",0,[["link",0,1,"h","javascript:x"]]]]'], ["a", '[["p",0,[["bold",0,1,"extra"]]]]'],
    ["ab", '[["p",0,[["link",0,2,"h","https://a.b"],["link",1,2,"h","https://c.d"]]]]'], ["a", '{"a":1}'],
  ]) assert.equal(R.linesFromTextFmt(text, fmt), null, fmt);
  ok("canonical fmt + fail closed");
}

// ---------------------------------------------------------------- editing primitives
{
  const base = [L("hello world", "paragraph", [M("bold", 0, 5)])];
  let r = R.toggleMark(base, 6, 11, "italic");
  assert.deepEqual(r[0].marks, [M("bold", 0, 5), M("italic", 6, 11)]);
  r = R.toggleMark(r, 0, 5, "bold");
  assert.deepEqual(r[0].marks, [M("italic", 6, 11)], "fully covered -> removed");
  r = R.toggleMark(R.toggleMark(base, 3, 8, "bold"), 3, 8, "bold");
  assert.deepEqual(r[0].marks, [M("bold", 0, 3)], "partial then full toggle trims exactly");
  assert.deepEqual(R.setMark(base, 0, 5, "bold", true), base, "setMark on an already-marked range is a no-op");
  assert.deepEqual(R.setMark(base, 0, 5, "bold", false)[0].marks, [], "setMark off removes exactly");
  assert.deepEqual(R.setMark(base, 3, 8, "bold", true)[0].marks, [M("bold", 0, 8)], "setMark on merges with the neighbour");
  assert.equal(R.hasMark(base, 0, 5, "bold"), true);
  assert.equal(R.hasMark(base, 0, 6, "bold"), false);
  // across lines: each line keeps its own text
  const two = [L("ab"), L("cd")];
  r = R.toggleMark(two, 1, 4, "underline");
  assert.deepEqual(r.map((l) => l.marks), [[M("underline", 1, 2)], [M("underline", 0, 1)]]);
  // block types toggle back
  r = R.setBlockType(two, 0, 4, "bullet");
  assert.deepEqual(r.map((l) => l.type), ["bullet", "bullet"]);
  r = R.setBlockType(r, 0, 4, "bullet");
  assert.deepEqual(r.map((l) => l.type), ["paragraph", "paragraph"]);
  r = R.setBlockType([L("x", "check", [], true)], 0, 0, "bullet");
  assert.equal(r[0].checked, false, "leaving check clears checked");
  assert.deepEqual(R.toggleChecked([L("x", "check")], 0)[0].checked, true);
  assert.equal(R.toggleChecked([L("x", "bullet")], 0)[0].checked, false, "only check lines toggle");
  // Enter: lists continue, empty list line exits, heading -> paragraph
  let s = R.splitAt([L("item", "bullet")], 4, 4);
  assert.deepEqual(s.lines.map((l) => [l.type, l.text]), [["bullet", "item"], ["bullet", ""]]);
  assert.equal(s.caret, 5);
  s = R.splitAt(s.lines, 5, 5);
  assert.deepEqual(s.lines.map((l) => l.type), ["bullet", "paragraph"], "Enter on an empty item leaves the list");
  s = R.splitAt([L("Titre", "heading")], 5, 5);
  assert.deepEqual(s.lines.map((l) => l.type), ["heading", "paragraph"]);
  s = R.splitAt([L("todo", "check", [], true)], 4, 4);
  assert.deepEqual(s.lines.map((l) => [l.type, l.checked]), [["check", true], ["check", false]], "new checkbox starts unchecked");
  s = R.splitAt([L("abcdef", "paragraph", [M("bold", 1, 5)])], 3, 3);
  assert.deepEqual(s.lines.map((l) => [l.text, l.marks]), [["abc", [M("bold", 1, 3)]], ["def", [M("bold", 0, 2)]]], "Enter inside a mark splits it exactly");
  // link set/replace/clear without losing other marks
  let lk = R.setLink([L("abcdef", "paragraph", [M("bold", 0, 6)])], 1, 4, { href: "https://a.b" });
  assert.deepEqual(lk[0].marks, [M("bold", 0, 6), M("link", 1, 4, { href: "https://a.b" })]);
  lk = R.setLink(lk, 2, 5, { ref: { kind: "note", id: "page-x" } });
  assert.deepEqual(lk[0].marks, [M("bold", 0, 6), M("link", 1, 2, { href: "https://a.b" }), M("link", 2, 5, { ref: { kind: "note", id: "page-x" } })]);
  lk = R.setLink(lk, 0, 6, null);
  assert.deepEqual(lk[0].marks, [M("bold", 0, 6)]);
  assert.equal(R.linkAt(R.setLink([L("abc")], 0, 2, { href: "https://a.b" }), 1).mark.href, "https://a.b");
  assert.equal(R.linkAt(R.setLink([L("abc")], 0, 2, { href: "https://a.b" }), 2), null, "end is exclusive");
  ok("primitives");
}

// ---------------------------------------------------------------- find / replace + mark integrity
{
  const fixture = () => [L("shaft diameter shaft", "paragraph", [M("bold", 0, 3), M("italic", 6, 14), M("underline", 15, 20)])];
  const find = (lines, q, o) => R.findAll(lines, q, o);
  let f = fixture();
  assert.deepEqual(find(f, "shaft"), [{ start: 0, end: 5 }, { start: 15, end: 20 }]);

  // replace FIRST occurrence with a shorter string
  let r = R.replaceMatches(f, [find(f, "shaft")[0]], "ax");
  assert.equal(R.flat(r), "ax diameter shaft");
  assert.deepEqual(r[0].marks, [M("bold", 0, 2), M("italic", 3, 11), M("underline", 12, 17)], "first shorter");
  assertValidLines(r, "first shorter");
  // ... a longer string
  r = R.replaceMatches(f, [find(f, "shaft")[0]], "shaftwork");
  assert.equal(R.flat(r), "shaftwork diameter shaft");
  assert.deepEqual(r[0].marks, [M("bold", 0, 9), M("italic", 10, 18), M("underline", 19, 24)], "first longer");
  assertValidLines(r, "first longer");
  // ... same length
  r = R.replaceMatches(f, [find(f, "shaft")[0]], "SHAFT");
  assert.deepEqual(r[0].marks, [M("bold", 0, 5), M("italic", 6, 14), M("underline", 15, 20)]);

  // replace ALL: shorter / longer / empty
  r = R.replaceMatches(f, find(f, "shaft"), "ax");
  assert.equal(R.flat(r), "ax diameter ax");
  assert.deepEqual(r[0].marks, [M("bold", 0, 2), M("italic", 3, 11), M("underline", 12, 14)], "all shorter");
  assertValidLines(r, "all shorter");
  r = R.replaceMatches(f, find(f, "shaft"), "shaftwork");
  assert.equal(R.flat(r), "shaftwork diameter shaftwork");
  assert.deepEqual(r[0].marks, [M("bold", 0, 9), M("italic", 10, 18), M("underline", 19, 28)], "all longer");
  assertValidLines(r, "all longer");
  r = R.replaceMatches(f, find(f, "shaft"), "");
  assert.equal(R.flat(r), " diameter ", "EMPTY replacement deletes every match");
  assert.deepEqual(r[0].marks, [M("italic", 1, 9)], "marks that only covered deleted text vanish; the middle mark shifts");
  assertValidLines(r, "empty all");
  r = R.replaceMatches(f, [find(f, "shaft")[0]], "");
  assert.equal(R.flat(r), " diameter shaft");
  assert.deepEqual(r[0].marks, [M("italic", 1, 9), M("underline", 10, 15)]);
  assertValidLines(r, "empty first");
  assert.equal(R.replaceMatches(f, find(f, "shaft"), undefined)[0].text, " diameter ", "undefined replacement also deletes");
  // a mark that starts inside a match and extends past it keeps only its outside part
  const partial = [L("shaft diameter", "paragraph", [M("bold", 2, 14)])];
  r = R.replaceMatches(partial, find(partial, "shaft"), "ax");
  assert.equal(R.flat(r), "ax diameter");
  assert.deepEqual(r[0].marks, [M("bold", 2, 11)], "the outside part stays attached to the same characters");
  r = R.replaceMatches(partial, find(partial, "shaft"), "");
  assert.deepEqual(r[0].marks, [M("bold", 0, 9)]);
  // a mark strictly containing the match keeps covering the replacement
  const around = [L("a shaft b", "paragraph", [M("bold", 0, 9)])];
  for (const rep of ["", "xy", "longer text"]) {
    r = R.replaceMatches(around, find(around, "shaft"), rep);
    assert.deepEqual(r[0].marks, [M("bold", 0, r[0].text.length)], "surrounding bold stays whole: " + JSON.stringify(rep));
    assertValidLines(r, "around");
  }
  // unrelated lines / block types / other marks are untouched
  const doc = [L("Title", "heading", [M("bold", 0, 5)]), L("shaft one", "check", [M("code", 0, 5)], true), L("keep me", "bullet", [M("italic", 0, 4)]), L("x shaft", "number")];
  r = R.replaceMatches(doc, find(doc, "shaft"), "rod");
  assert.deepEqual(r.map((l) => l.type), ["heading", "check", "bullet", "number"]);
  assert.equal(r[1].checked, true);
  assert.deepEqual(r[0], doc[0]);
  assert.deepEqual(r[2], doc[2]);
  assert.deepEqual(r[1].marks, [M("code", 0, 3)]);
  assertValidLines(r, "doc");
  assert.notEqual(r[0], doc[0], "inputs are never mutated in place");
  assert.equal(doc[1].text, "shaft one");

  // links survive replacement outside the match; inside they follow the same rules
  const withLink = [L("see shaft doc", "paragraph", [M("link", 4, 9, { href: "https://a.b/x" })])];
  r = R.replaceMatches(withLink, find(withLink, "shaft"), "rod");
  assert.equal(R.flat(r), "see rod doc");
  assert.deepEqual(r[0].marks, [M("link", 4, 7, { href: "https://a.b/x" })]);
  assertValidLines(r, "link");
  // adjacent matches and overlapping candidates are non-overlapping left to right
  assert.deepEqual(find([L("aaaa")], "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  // options: case / whole word / no regex / no cross-line
  const opt = [L("Shaft shaft SHAFT shafts"), L("a.b a+b")];
  assert.equal(find(opt, "shaft").length, 4, "case-insensitive by default");
  assert.equal(find(opt, "shaft", { caseSensitive: true }).length, 2);
  assert.equal(find(opt, "shaft", { wholeWord: true }).length, 3);
  assert.equal(find(opt, "shaft", { wholeWord: true, caseSensitive: true }).length, 1);
  assert.equal(find(opt, "a.b").length, 1, "the query is literal, not a regex");
  assert.equal(find(opt, "a+b").length, 1);
  assert.equal(find(opt, ".*").length, 0);
  assert.equal(find(opt, "").length, 0);
  assert.equal(find([L("ab"), L("cd")], "b\nc").length, 0, "matches never span lines");
  assert.equal(find([L("Été été")], "été").length, 2, "case folding is Unicode aware");
  assert.equal(find([L("İstanbul")], "istanbul").length, 0, "no index drift on length-changing lowercase");
  assert.deepEqual(find([L("😀 shaft 😀")], "shaft"), [{ start: 3, end: 8 }], "offsets are UTF-16 units");
  // newline in the replacement is folded to a space (single-line block)
  assert.equal(R.flat(R.replaceMatches([L("a b")], [{ start: 0, end: 1 }], "x\ny")), "x y b");
  // multi-line document offsets
  const ml = [L("one shaft"), L("two shaft shaft")];
  const ms = find(ml, "shaft");
  assert.deepEqual(ms, [{ start: 4, end: 9 }, { start: 14, end: 19 }, { start: 20, end: 25 }]);
  r = R.replaceMatches(ml, ms, "");
  assert.deepEqual(R.flat(r), "one \ntwo  ");
  assertValidLines(r, "multi-line");

  // randomised structure/edit fuzz: invariants hold after every operation
  let seed = 1234567;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ["a", "b", " ", "shaft", "é", "😀", "x"];
  const types = ["bold", "italic", "underline", "highlight", "code"];
  let lines = [L("start")];
  for (let step = 0; step < 1500; step += 1) {
    const total = R.flat(lines).length;
    const a = rnd(total + 1);
    const b = Math.min(total, a + rnd(6));
    const pick = rnd(9);
    let next;
    if (pick <= 2) next = R.replaceRange(lines, a, b, alphabet[rnd(alphabet.length)].repeat(1 + rnd(3))).lines;
    else if (pick === 3) next = R.replaceRange(lines, a, b, "").lines;
    else if (pick === 4) next = R.splitAt(lines, a, b).lines;
    else if (pick === 5) next = R.toggleMark(lines, a, b, types[rnd(types.length)]);
    else if (pick === 6) next = R.setBlockType(lines, a, b, R.BLOCK_TYPES[rnd(5)]);
    else if (pick === 7) next = R.replaceMatches(lines, R.findAll(lines, alphabet[rnd(alphabet.length)], { caseSensitive: rnd(2) === 0 }), alphabet[rnd(alphabet.length)]);
    else next = R.setLink(lines, a, b, rnd(2) ? { href: "https://x.y/" + rnd(5) } : null) || lines;
    // the model is JS-string based: skip states that would split a surrogate (emoji is inserted whole)
    if (R.flat(next).length > 400) next = [L("reset")];
    assertValidLines(next, "fuzz step " + step);
    lines = next;
  }
  ok("find/replace + mark integrity");
}

// ---------------------------------------------------------------- DOM-free structure of Enter/paste splice
{
  const res = R.replaceRange([L("one"), L("two")], 1, 5, "X\nY\nZ");
  assert.deepEqual(res.lines.map((l) => l.text), ["oX", "Y", "Zwo"]);
  assert.equal(res.caret, 6);
  assert.equal(R.replaceRange([L("abc")], 1, 1, "").lines[0].text, "abc");
  assert.equal(R.replaceRange([L("abc")], 99, 99, "z").lines[0].text, "abcz", "offsets clamp");
  // insertion inside a mark inherits it; at its boundary it does not
  let r = R.replaceRange([L("abcd", "paragraph", [M("bold", 1, 3)])], 2, 2, "ZZ");
  assert.deepEqual(r.lines[0].marks, [M("bold", 1, 5)]);
  r = R.replaceRange([L("abcd", "paragraph", [M("bold", 1, 3)])], 3, 3, "ZZ");
  assert.deepEqual(r.lines[0].marks, [M("bold", 1, 3)]);
  r = R.replaceRange([L("abcd", "paragraph", [M("bold", 1, 3)])], 1, 1, "ZZ");
  assert.deepEqual(r.lines[0].marks, [M("bold", 3, 5)]);
  ok("splice");
}

// ---------------------------------------------------------------- structured state machine
function v2Page(id, rev, blocks, extra) {
  return Object.assign({
    id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1, updated_at: 1,
    content: { version: 2, blocks: blocks.map((b, i) => Object.assign({ id: "block-" + id.slice(5) + i, marks: [] }, b)) },
  }, extra || {});
}
function v1Page(id, rev, text, extra) {
  return Object.assign({
    id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1, updated_at: 1,
    content: { version: 1, blocks: [{ id: "block-" + id.slice(5), type: "text", text, marks: [] }] },
  }, extra || {});
}
function fixture() {
  return {
    version: 1, notebook_rev: 4, projects: [], categories: [],
    pages: [
      v2Page("page-rich", 3, [{ type: "heading", text: "Plan" }, { type: "check", text: "measure", checked: false, marks: [{ type: "bold", start: 0, end: 7 }] }, { type: "bullet", text: "note" }]),
      v1Page("page-old", 1, "legacy plain\nsecond line"),
      v2Page("page-flat", 1, [{ type: "paragraph", text: "legacy plain" }, { type: "paragraph", text: "second line" }]),
    ],
  };
}

function fakeServer() {
  const s = { nb: fixture(), offline: false, hold: false, held: [], calls: [], seq: 0 };
  const err = (status, data) => Object.assign(new Error(data.error || "Erreur " + status), { status, data });
  const find = (id) => s.nb.pages.find((x) => x.id === id);
  function handle(p) {
    if (s.offline) throw new Error("Hors ligne");
    const nb = s.nb;
    if (p.action === "page_save") {
      const pg = find(p.id);
      if (!pg) throw err(404, { error: "Page introuvable", code: "not_found" });
      if (p.expected_rev !== pg.rev) throw err(409, { error: "Page modifiée ailleurs", code: "revision_conflict", page: clone(pg), notebook_rev: nb.notebook_rev });
      if (pg.deleted_at != null) throw err(400, { error: "Page dans la corbeille", code: "validation_error" });
      let changed = false;
      if ("pinned" in p && p.pinned !== pg.pinned) { pg.pinned = p.pinned; changed = true; }
      const incoming = R.linesFromContent(p.content);
      if (!incoming) throw err(400, { error: "Contenu invalide", code: "validation_error" });
      const cur = R.linesFromContent(pg.content);
      // block ids: only ids that belong to this page may be claimed; new blocks get a server id
      const owned = new Set(R.idsOf(cur).filter(Boolean));
      const claimed = new Set();
      for (const l of incoming) {
        if (l.id && (!owned.has(l.id) || claimed.has(l.id))) throw err(400, { error: "Bloc étranger à cette page", code: "validation_error" });
        if (l.id) claimed.add(l.id);
      }
      if (R.flat(incoming) !== R.flat(cur) || R.fmtOf(incoming) !== R.fmtOf(cur)) {
        if (incoming.length > R.BLOCKS_MAX) {
          if (!R.isPlain(incoming)) throw err(400, { error: "Trop de lignes pour la mise en forme", code: "validation_error" });
          pg.content = { version: 1, blocks: [{ id: R.idsOf(cur)[0] || "block-legacy", type: "text", text: R.flat(incoming), marks: [] }] };
        } else {
          pg.content = { version: 2, blocks: incoming.map((l) => Object.assign({ id: l.id || "block-srv" + (++s.seq), type: l.type, text: l.text, marks: clone(l.marks) }, l.type === "check" ? { checked: l.checked } : {})) };
        }
        changed = true;
      }
      if (changed) pg.rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(pg) };
    }
    if (p.action === "page_trash" || p.action === "page_restore") {
      const pg = find(p.id);
      if (p.expected_rev !== pg.rev) throw err(409, { error: "Page modifiée ailleurs", code: "revision_conflict", page: clone(pg), notebook_rev: nb.notebook_rev });
      pg.deleted_at = p.action === "page_trash" ? 99 : null;
      pg.rev += 1;
      nb.notebook_rev += 1;
      return { ok: true, notebook_rev: nb.notebook_rev, page: clone(pg) };
    }
    throw err(400, { error: "action invalide", code: "validation_error" });
  }
  s.request = (payload, o) => {
    s.calls.push({ payload: clone(payload), keepalive: !!(o && o.keepalive) });
    if (s.hold && payload.action === "page_save") {
      return new Promise((resolve, reject) => s.held.push(() => { try { resolve(handle(payload)); } catch (e) { reject(e); } }));
    }
    try { return Promise.resolve(handle(payload)); } catch (e) { return Promise.reject(e); }
  };
  s.release = () => s.held.splice(0).forEach((f) => f());
  s.fetchNotebook = (meta) => {
    if (s.offline) return Promise.reject(new Error("Hors ligne"));
    const out = clone(s.nb);
    if (meta) out.pages = out.pages.map((p) => ({ id: p.id, rev: p.rev, deleted_at: p.deleted_at }));
    return Promise.resolve(out);
  };
  s.saves = () => s.calls.filter((c) => c.payload && c.payload.action === "page_save");
  s.pg = find;
  s.remote = (p) => handle(p);
  return s;
}

function memStorage() {
  const m = new Map();
  const st = { m, fail: false, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (st.fail) throw new Error("quota"); m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  return st;
}
function fakeTimers() {
  const t = { list: new Map(), seq: 0 };
  t.set = (fn, ms) => { t.seq += 1; t.list.set(t.seq, { fn, ms }); return t.seq; };
  t.clear = (h) => { t.list.delete(h); };
  t.runAll = () => { const fns = [...t.list.values()]; t.list.clear(); fns.forEach((x) => x.fn()); };
  return t;
}
function make(server, storage) {
  const timers = fakeTimers();
  const drafts = C.createDraftStore(storage, "admin-test");
  const events = [];
  const core = C.createCore({ request: server.request, fetchNotebook: server.fetchNotebook, drafts, timers, now: () => 1000, onChange: (e) => events.push(e) });
  return { core, drafts, timers, events };
}
const draftsOf = (st) => {
  const raw = st.m.get(C.draftKey("admin-test"));
  return raw ? JSON.parse(raw).pages : {};
};
/** Local editable state helpers: format `text` with a mark over [a,b) of line 0. */
const withBold = (e, a, b) => {
  const lines = R.linesFromTextFmt(e.local.text, e.local.fmt);
  return R.toggleMark(lines, a, b, "bold");
};
const setLines = (core, id, lines) => core.edit(id, { text: R.flat(lines), fmt: R.fmtOf(lines) });

// pages load with structure; V1 legacy pages read as plain paragraphs
{
  const srv = fakeServer();
  const { core } = make(srv, memStorage());
  await core.load();
  const rich = core.entry("page-rich");
  assert.equal(rich.local.text, "Plan\nmeasure\nnote");
  assert.notEqual(rich.local.fmt, "");
  assert.equal(core.entry("page-old").local.fmt, "", "legacy V1 page = plain");
  assert.equal(core.entry("page-old").local.text, "legacy plain\nsecond line");
  assert.equal(core.entry("page-flat").local.fmt, "");
  assert.deepEqual(core.libraryItems().find((x) => x.id === "page-rich").title, "Plan");
  ok("load structured + legacy");
}

// A. formatting change -> save in flight -> newer typing -> old response returns
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-flat");
  setLines(core, "page-flat", withBold(e, 0, 6)); // formatting only: text unchanged
  assert.equal(core.isDirty(e), true, "a formatting-only change is dirty");
  const rec = draftsOf(st)["page-flat"];
  assert.equal(rec.content.version, 2);
  assert.deepEqual(rec.content.blocks[0].marks, [{ type: "bold", start: 0, end: 6 }], "draft written synchronously with the structure");
  assert.equal(rec.content.blocks[0].id, "block-flat0", "drafts carry the real server block id (never a temporary key)");
  srv.hold = true;
  timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 1);
  const sent = srv.saves()[0].payload.content;
  assert.equal(sent.version, 2);
  assert.deepEqual(sent.blocks[0].marks, [{ type: "bold", start: 0, end: 6 }]);
  // user types NEWER text before the response
  const lines = R.linesFromTextFmt(e.local.text, e.local.fmt);
  setLines(core, "page-flat", R.replaceRange(lines, 12, 12, " typed").lines);
  timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 1, "still one in-flight save");
  srv.hold = false;
  srv.release();
  await settle();
  assert.equal(e.local.text, "legacy plain typed\nsecond line", "newer structured state survives");
  assert.deepEqual(R.linesFromTextFmt(e.local.text, e.local.fmt)[0].marks, [M("bold", 0, 6)], "and keeps its formatting");
  assert.equal(srv.saves().length, 2, "newest state saved right after");
  assert.equal(srv.saves()[1].payload.expected_rev, 2, "against the returned rev");
  await settle();
  assert.equal(core.isDirty(e), false);
  assert.equal(draftsOf(st)["page-flat"], undefined);
  assert.equal(R.flat(R.linesFromContent(srv.pg("page-flat").content)), "legacy plain typed\nsecond line");
  ok("A format then type");
}

// B. checklist toggle + text edit before the response (and the reverse: text first, toggle after)
{
  for (const order of ["toggle-then-text", "text-then-toggle"]) {
    const srv = fakeServer();
    const st = memStorage();
    const { core, timers } = make(srv, st);
    await core.load();
    const e = core.entry("page-rich");
    const toggle = () => setLines(core, "page-rich", R.toggleChecked(R.linesFromTextFmt(e.local.text, e.local.fmt), 1));
    const type = () => setLines(core, "page-rich", R.replaceRange(R.linesFromTextFmt(e.local.text, e.local.fmt), 4, 4, "!").lines);
    if (order === "toggle-then-text") toggle(); else type();
    srv.hold = true;
    timers.runAll();
    await settle();
    if (order === "toggle-then-text") type(); else toggle();
    srv.hold = false;
    srv.release();
    await settle(12);
    const final = R.linesFromContent(srv.pg("page-rich").content);
    assert.equal(final[1].checked, true, order + ": checkbox state saved");
    assert.equal(R.flat(final), "Plan!\nmeasure\nnote", order + ": text saved");
    assert.equal(core.isDirty(e), false);
    assert.equal(srv.saves().length, 2);
  }
  ok("B checklist + text race");
}

// C. local structured edit vs remote structured edit -> explicit 409; nothing lost either side
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-rich");
  setLines(core, "page-rich", R.toggleChecked(R.linesFromTextFmt(e.local.text, e.local.fmt), 1));
  srv.remote({ action: "page_save", id: "page-rich", expected_rev: 3, content: { version: 2, blocks: [{ type: "heading", text: "Remote heading", marks: [] }] } });
  timers.runAll();
  await settle();
  assert.ok(e.conflict, "explicit conflict, never last-write-wins");
  assert.equal(R.flat(R.linesFromContent(srv.pg("page-rich").content)), "Remote heading", "remote content untouched");
  assert.equal(e.local.text, "Plan\nmeasure\nnote", "local structured state untouched");
  assert.equal(R.linesFromTextFmt(e.local.text, e.local.fmt)[1].checked, true);
  assert.equal(srv.saves().length, 1, "autosave paused");
  core.loadRemote("page-rich");
  assert.equal(e.local.text, "Remote heading");
  assert.equal(core.isDirty(e), false);
  // and "replace with mine" keeps the structure
  const srv2 = fakeServer();
  const m2 = make(srv2, memStorage());
  await m2.core.load();
  const e2 = m2.core.entry("page-rich");
  setLines(m2.core, "page-rich", R.toggleChecked(R.linesFromTextFmt(e2.local.text, e2.local.fmt), 1));
  srv2.remote({ action: "page_save", id: "page-rich", expected_rev: 3, content: { version: 2, blocks: [{ type: "paragraph", text: "other", marks: [] }] } });
  m2.timers.runAll();
  await settle();
  await m2.core.keepLocal("page-rich");
  await settle();
  const kept = R.linesFromContent(srv2.pg("page-rich").content);
  assert.equal(kept[1].checked, true);
  assert.deepEqual(kept.map((l) => l.type), ["heading", "check", "bullet"]);
  ok("C structured conflict");
}

// C2. equivalence: same text but different structure is a conflict; identical text+structure adopts
{
  const srv = fakeServer();
  const { core, timers } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-flat");
  setLines(core, "page-flat", R.setBlockType(R.linesFromTextFmt(e.local.text, e.local.fmt), 0, 0, "heading"));
  // remote applies the SAME text but a different structure
  srv.remote({ action: "page_save", id: "page-flat", expected_rev: 1, content: { version: 2, blocks: [{ type: "bullet", text: "legacy plain", marks: [] }, { type: "paragraph", text: "second line", marks: [] }] } });
  timers.runAll();
  await settle();
  assert.ok(e.conflict, "same text, different structure is NOT equivalent");
  const srv2 = fakeServer();
  const m2 = make(srv2, memStorage());
  await m2.core.load();
  const e2 = m2.core.entry("page-flat");
  setLines(m2.core, "page-flat", R.setBlockType(R.linesFromTextFmt(e2.local.text, e2.local.fmt), 0, 0, "heading"));
  srv2.remote({ action: "page_save", id: "page-flat", expected_rev: 1, content: { version: 2, blocks: [{ type: "heading", text: "legacy plain", marks: [] }, { type: "paragraph", text: "second line", marks: [] }] } });
  m2.timers.runAll();
  await settle();
  assert.equal(e2.conflict, null, "identical text+structure is adopted like a success");
  assert.equal(m2.core.isDirty(e2), false);
  ok("C2 equivalence");
}

// D. poll while a structured page is dirty never overwrites it
{
  const srv = fakeServer();
  const { core } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-rich");
  setLines(core, "page-rich", R.toggleChecked(R.linesFromTextFmt(e.local.text, e.local.fmt), 1));
  const before = { text: e.local.text, fmt: e.local.fmt };
  srv.remote({ action: "page_save", id: "page-rich", expected_rev: 3, content: { version: 2, blocks: [{ type: "paragraph", text: "remote", marks: [] }] } });
  await core.poll();
  await settle();
  assert.deepEqual({ text: e.local.text, fmt: e.local.fmt }, before, "dirty structured state protected from polling");
  // a CLEAN structured page adopts remote structure
  const clean = core.entry("page-flat");
  srv.remote({ action: "page_save", id: "page-flat", expected_rev: 1, content: { version: 2, blocks: [{ type: "check", text: "remote todo", checked: true, marks: [] }] } });
  await core.poll();
  await settle();
  assert.equal(clean.local.text, "remote todo");
  assert.equal(R.linesFromTextFmt(clean.local.text, clean.local.fmt)[0].checked, true);
  ok("D poll");
}

// E. remote trash while structured dirty: read-only, draft preserved, restore resumes
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-rich");
  setLines(core, "page-rich", R.toggleChecked(R.linesFromTextFmt(e.local.text, e.local.fmt), 1));
  srv.remote({ action: "page_trash", id: "page-rich", expected_rev: 3 });
  await core.poll();
  await settle();
  assert.equal(core.isTrashed(e), true);
  assert.equal(core.edit("page-rich", { text: "x", fmt: "" }), false, "read-only while trashed");
  timers.runAll();
  await settle();
  assert.equal(srv.saves().length, 0, "no autosave while trashed");
  const rec = draftsOf(st)["page-rich"];
  assert.ok(rec, "draft preserved");
  assert.equal(rec.content.blocks[1].checked, true, "structured draft intact");
  srv.remote({ action: "page_restore", id: "page-rich", expected_rev: 4 });
  await core.poll();
  await settle();
  timers.runAll();
  await settle();
  const final = R.linesFromContent(srv.pg("page-rich").content);
  assert.equal(final[1].checked, true, "draft resumed after restore (content unchanged elsewhere: exact rebase)");
  ok("E trash/restore");
}

// F/G. recovered structured draft after reload; base persisted as version 2
{
  const srv = fakeServer();
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  const e = A.core.entry("page-rich");
  setLines(A.core, "page-rich", R.toggleMark(R.linesFromTextFmt(e.local.text, e.local.fmt), 0, 4, "italic"));
  const rec = draftsOf(st)["page-rich"];
  assert.equal(rec.base.version, 3, "a V2 base is the exact version-3 shape: text + fmt + pin + the authoritative block-id vector");
  assert.equal(rec.base.text, "Plan\nmeasure\nnote");
  assert.equal(typeof rec.base.fmt, "string");
  assert.deepEqual(rec.base.ids, ["block-rich0", "block-rich1", "block-rich2"], "real server ids only, in order");
  assert.ok(!("base_sig" in rec));
  const B = make(srv, st); // reload
  await B.core.load();
  const b = B.core.entry("page-rich");
  assert.equal(b.local.text, e.local.text);
  assert.equal(b.local.fmt, e.local.fmt, "structure recovered exactly");
  assert.equal(B.core.isDirty(b), true);
  B.timers.runAll();
  await settle();
  assert.equal(B.core.isDirty(b), false);
  assert.deepEqual(R.linesFromContent(srv.pg("page-rich").content)[0].marks, [M("italic", 0, 4)]);
  ok("F/G recovered draft");
}

// H/I. legacy drafts and exact base after migration
{
  const legacy = (over) => Object.assign({
    server_rev: 1, generation: 3, saved_generation: 1, updated_local_at: 1,
    pinned: false, content: { version: 1, blocks: [{ id: "block-old", type: "text", text: "unsaved legacy edit", marks: [] }] },
    base: { version: 1, text: "legacy plain\nsecond line", pinned: false },
  }, over || {});
  const put = (st, id, rec) => st.m.set(C.draftKey("admin-test"), JSON.stringify({ version: 1, pages: { [id]: rec } }));

  // H. the server migrated page-old to V2 (plain) while a V1 draft was unsaved: draft recovered, saved as V2
  {
    const srv = fakeServer();
    srv.nb.pages.find((p) => p.id === "page-old").content = clone(srv.nb.pages.find((p) => p.id === "page-flat").content); // migrated shape, same rev
    const st = memStorage();
    put(st, "page-old", legacy());
    const A = make(srv, st);
    await A.core.load();
    const e = A.core.entry("page-old");
    assert.equal(e.local.text, "unsaved legacy edit");
    assert.equal(e.local.fmt, "");
    assert.equal(A.core.isDirty(e), true);
    A.timers.runAll();
    await settle();
    assert.equal(R.flat(R.linesFromContent(srv.pg("page-old").content)), "unsaved legacy edit");
    assert.equal(srv.saves()[0].payload.content.version, 2, "a legacy draft is saved in the new format");
    ok("H legacy draft on migrated page");
  }

  // I. exact base after migration: legacy base == plain migrated page -> rebase; structured page with same text -> conflict
  const remoteRestore = async (mutate) => {
    const srv = fakeServer();
    srv.nb.pages.find((p) => p.id === "page-old").content = clone(srv.nb.pages.find((p) => p.id === "page-flat").content);
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    const a = A.core.entry("page-old");
    A.core.edit("page-old", { text: "local draft edit" });
    srv.remote({ action: "page_trash", id: "page-old", expected_rev: 1 }); // rev 2
    await A.core.poll();
    await settle();
    // reload as a fresh tab: base must survive persistence
    const B = make(srv, st);
    await B.core.load();
    const b = B.core.entry("page-old");
    if (mutate) mutate(srv);
    srv.remote({ action: "page_restore", id: "page-old", expected_rev: srv.pg("page-old").rev });
    await B.core.poll();
    await settle();
    B.timers.runAll();
    await settle();
    void a;
    return { srv, b, B, st };
  };
  {
    const r = await remoteRestore();
    assert.equal(r.b.conflict, null, "identical base content -> exact rebase");
    assert.equal(R.flat(R.linesFromContent(r.srv.pg("page-old").content)), "local draft edit");
    ok("I exact base rebase");
  }
  {
    // remote changed only STRUCTURE (same text) while trashed: not the base any more -> ordinary conflict
    const r = await remoteRestore((srv) => {
      const pg = srv.pg("page-old");
      pg.content.blocks[0].type = "heading";
    });
    assert.ok(r.b.conflict, "text equal but structure differs -> no rebase, conflict protection");
    assert.equal(R.linesFromContent(r.srv.pg("page-old").content)[0].type, "heading", "remote structure untouched");
    ok("I exact base structure differs");
  }
  {
    // an old legacy-shaped base (text + pin) can only ever equal a PLAIN page: on a structured
    // page with the very same text it must NOT rebase (ordinary 409 protection instead)
    const srv = fakeServer();
    srv.remote({ action: "page_trash", id: "page-rich", expected_rev: 3 }); // trashed while the draft was closed
    const st = memStorage();
    put(st, "page-rich", legacy({ base: { version: 1, text: "Plan\nmeasure\nnote", pinned: false }, server_rev: 3 }));
    const A = make(srv, st);
    await A.core.load();
    const e = A.core.entry("page-rich");
    assert.deepEqual(e.draftBase, { text: "Plan\nmeasure\nnote", fmt: "", pinned: false, ids: null, legacy: true }, "a version-1 base reads as text + plain structure, without an id vector");
    assert.equal(A.core.isTrashed(e), true);
    srv.remote({ action: "page_restore", id: "page-rich", expected_rev: 4 });
    await A.core.poll();
    await settle();
    A.timers.runAll();
    await settle();
    assert.ok(e.conflict, "no rebase onto a structured page: normal conflict protection");
    assert.equal(R.flat(R.linesFromContent(srv.pg("page-rich").content)), "Plan\nmeasure\nnote", "the structured remote is never overwritten");
    assert.equal(e.local.text, "unsaved legacy edit", "the local draft stays protected");
    ok("I legacy base vs structured page");
  }
  // malformed / impossible structured bases fail CLOSED
  const badBases = [
    ["missing fmt", { version: 2, text: "a", pinned: false }],
    ["fmt not a string", { version: 2, text: "a", fmt: 5, pinned: false }],
    ["fmt does not fit text", { version: 2, text: "a\nb", fmt: '[["p",0,[]]]', pinned: false }],
    ["fmt malformed", { version: 2, text: "a", fmt: "{", pinned: false }],
    ["fmt mark out of range", { version: 2, text: "a", fmt: '[["p",0,[["bold",0,9]]]]', pinned: false }],
    ["unsafe link in fmt", { version: 2, text: "a", fmt: '[["p",0,[["link",0,1,"h","javascript:x"]]]]', pinned: false }],
    ["extra key", { version: 2, text: "a", fmt: "", pinned: false, rev: 1 }],
    ["version 3", { version: 3, text: "a", fmt: "", pinned: false }],
    ["oversized fmt", { version: 2, text: "a", fmt: "x".repeat(1024 * 1024 + 1), pinned: false }],
    ["version-1 with fmt", { version: 1, text: "a", fmt: "", pinned: false }],
    ["pinned not boolean", { version: 2, text: "a", fmt: "", pinned: "no" }],
  ];
  for (const [label, base] of badBases) {
    const srv = fakeServer();
    const st = memStorage();
    put(st, "page-old", legacy({ base }));
    const A = make(srv, st);
    await A.core.load();
    assert.equal(A.core.entry("page-old").draftBase, null, "fails closed: " + label);
  }
  ok("I malformed bases fail closed");
}

// J. draft store: same-generation drafts with different structure are different content
{
  const st = memStorage();
  const store = C.createDraftStore(st, "admin-test");
  const rec = (fmt) => ({
    server_rev: 1, generation: 5, saved_generation: 1, updated_local_at: 1, pinned: false,
    content: R.contentFromTextFmt("ab", fmt),
  });
  const fmtBold = R.fmtOf([L("ab", "paragraph", [M("bold", 0, 1)])]);
  store.put("page-x", rec(fmtBold));
  store.drop("page-x", 5, { text: "ab", fmt: "", pinned: false });
  assert.ok(draftsOf(st)["page-x"], "a draft with different structure is NOT dropped as 'already saved'");
  store.drop("page-x", 5, { text: "ab", fmt: fmtBold, pinned: false });
  assert.equal(draftsOf(st)["page-x"], undefined);
  ok("J draft drop equality");
}

// K. edit() refuses a text/structure pair that does not fit (never stores a torn state)
{
  const srv = fakeServer();
  const { core } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-rich");
  const before = { text: e.local.text, fmt: e.local.fmt, gen: e.generation };
  assert.equal(core.edit("page-rich", { text: "single line" }), false, "structured fmt no longer fits the new line count");
  assert.equal(core.edit("page-rich", { fmt: "garbage" }), false);
  assert.deepEqual({ text: e.local.text, fmt: e.local.fmt, gen: e.generation }, before);
  assert.equal(core.edit("page-old", { text: "plain still works" }), true, "plain edits keep the accepted text-only API");
  ok("K torn state refused");
}

// L. bounds: an over-long structure never becomes editable state
{
  const many = Array.from({ length: R.BLOCKS_MAX + 1 }, () => L("x"));
  const text = R.flat(many);
  assert.equal(R.linesFromTextFmt(text, "").length, R.BLOCKS_MAX + 1, "plain text has no structure bound (server keeps legacy pages editable)");
  const fmtMany = JSON.stringify(many.map(() => ["b", 0, []]));
  assert.equal(R.linesFromTextFmt(text, fmtMany), null, "more than BLOCKS_MAX structured blocks is refused");
  const lots = Array.from({ length: R.MARKS_PER_BLOCK_MAX + 1 }, (_, i) => ["bold", i * 2, i * 2 + 1]);
  assert.equal(R.linesFromTextFmt("x".repeat(400), JSON.stringify([["p", 0, lots]])), null, "too many marks in one block is refused");
  ok("L limits");
}

// ================================================================ logical block ids (model)
{
  const A = "block-AAAA";
  const B = "block-BBBB";
  const doc = () => [R.newLine("one", "paragraph", false, [], A), R.newLine("two", "paragraph", false, [], B)];
  const idList = (lines) => lines.map((l) => l.id);
  // insert a NEW line before them (Enter at the start of "one", then type)
  let r = R.splitAt(doc(), 0, 0);
  assert.deepEqual(idList(r.lines), [null, A, B], "Enter at the start of a non-empty line creates the new block ABOVE; ids stay with their text");
  assert.deepEqual(r.lines.map((l) => l.text), ["", "one", "two"]);
  r = R.replaceRange(r.lines.map((l) => Object.assign({}, l, { marks: [] })), 0, 0, "NEW");
  assert.deepEqual(idList(r.lines), [null, A, B]);
  assert.deepEqual(r.lines.map((l) => l.text), ["NEW", "one", "two"]);
  // split in the middle: the first part keeps the id, the tail is new, the next block is untouched
  r = R.splitAt(doc(), 1, 1);
  assert.deepEqual(idList(r.lines), [A, null, B]);
  assert.deepEqual(r.lines.map((l) => l.text), ["o", "ne", "two"]);
  // split at the END of a line: the original keeps its id, the new empty line is new
  r = R.splitAt(doc(), 3, 3);
  assert.deepEqual(idList(r.lines), [A, null, B]);
  // deleting a line's text / merging lines: the survivor keeps its id
  r = R.replaceRange(doc(), 3, 7, ""); // from end of "one" through the newline and "two"
  assert.deepEqual(idList(r.lines), [A]);
  r = R.replaceRange(doc(), 0, 4, "");
  assert.deepEqual(idList(r.lines), [B], "deleting the first line removes only its id");
  // formatting / block types / checkbox / find-replace keep ids
  assert.deepEqual(idList(R.toggleMark(doc(), 0, 7, "bold")), [A, B]);
  assert.deepEqual(idList(R.setBlockType(doc(), 0, 7, "bullet")), [A, B]);
  assert.deepEqual(idList(R.setBlockType(doc(), 0, 7, "check")), [A, B]);
  assert.deepEqual(idList(R.setLink(doc(), 0, 3, { href: "https://a.b" })), [A, B]);
  assert.deepEqual(idList(R.replaceMatches(doc(), R.findAll(doc(), "o"), "0")), [A, B]);
  assert.deepEqual(idList(R.replaceMatches(doc(), R.findAll(doc(), "o"), "")), [A, B]);
  // a checked item keeps its state with the original block when a line is inserted above
  const chk = [R.newLine("todo", "check", true, [], A)];
  r = R.splitAt(chk, 0, 0);
  assert.deepEqual(r.lines.map((l) => [l.id, l.checked, l.type]), [[null, false, "check"], [A, true, "check"]]);
  // heading: the new empty line above becomes a paragraph
  r = R.splitAt([R.newLine("Title", "heading", false, [], A)], 0, 0);
  assert.deepEqual(r.lines.map((l) => [l.id, l.type]), [[null, "paragraph"], [A, "heading"]]);
  // keys, uniqueness, wire content
  const lines = R.ensureKeys([R.newLine("x", "paragraph", false, [], A), R.newLine("y", "paragraph", false, [], A), R.newLine("z")]);
  assert.equal(lines[0].id, A);
  assert.ok(R.isTmpId(lines[1].id) && R.isTmpId(lines[2].id) && lines[1].id !== lines[2].id, "duplicates and missing ids get distinct temporary keys");
  const wire = R.contentFromLines([R.newLine("a", "paragraph", false, [], A), R.newLine("b", "paragraph", false, [], "tmp-9"), R.newLine("c", "paragraph", false, [], B), R.newLine("d", "paragraph", false, [], "block-GONE")], new Set([A, B]));
  assert.deepEqual(wire.blocks.map((b) => b.id), [A, undefined, B, undefined], "temporary keys and ids outside the page never go on the wire");
  assert.deepEqual(R.contentFromLines([R.newLine("a", "paragraph", false, [], A), R.newLine("b", "paragraph", false, [], A)], new Set([A])).blocks.map((b) => b.id), [A, undefined], "an id is sent once");
  // reading: ids come from the page; repeated ids only count once
  const read = R.linesFromContent({ version: 2, blocks: [{ id: A, type: "paragraph", text: "a", marks: [] }, { id: A, type: "paragraph", text: "b", marks: [] }, { id: "evil id", type: "paragraph", text: "c", marks: [] }] });
  assert.deepEqual(idList(read), [A, null, null]);
  assert.equal(R.linesFromContent({ version: 1, blocks: [{ id: A, type: "text", text: "p\nq", marks: [] }] })[0].id, A, "a V1 page's block id belongs to its first line");
  ok("block ids: model");
}

// ================================================================ oversized legacy pages, block ids and structure limits (core)
function bigV1Page(id, rev, n) {
  const text = Array.from({ length: n }, (_, i) => "l" + i).join("\n");
  return { text, page: v1Page(id, rev, text) };
}
{
  // 1. a valid V1 page with BLOCKS_MAX + 1 lines: server GET -> core.load() -> exact, editable
  const n = R.BLOCKS_MAX + 1;
  const { text, page } = bigV1Page("page-big", 1, n);
  const srv = fakeServer();
  srv.nb.pages.push(page);
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-big");
  assert.ok(e, "the oversized legacy page exists after load");
  assert.equal(e.local.text, text, "text exact");
  assert.equal(e.local.fmt, "");
  assert.equal(e.local.ids[0], "block-big", "the V1 block id belongs to the first line");
  assert.equal(core.libraryItems().some((x) => x.id === "page-big"), true);
  core.select("page-big");
  // editable: an ordinary edit is sent as ONE legacy block and stored compactly, nothing lost
  const lines = R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
  const next = R.replaceRange(lines, text.length, text.length, "!").lines;
  assert.equal(core.edit("page-big", { text: R.flat(next), fmt: R.fmtOf(next), ids: R.idsOf(R.ensureKeys(next)) }), true);
  timers.runAll();
  await settle();
  const sent = srv.saves().at(-1).payload.content;
  assert.equal(sent.version, 1, "an oversized plain page is sent as a legacy block, not exploded into thousands of blocks");
  assert.equal(sent.blocks.length, 1);
  assert.equal(sent.blocks[0].id, "block-big");
  const stored = srv.pg("page-big").content;
  assert.equal(stored.version, 1);
  assert.equal(stored.blocks[0].text, text + "!", "no content lost");
  assert.equal(core.isDirty(e), false);
  // 4. shrinking it below the limit lets the server migrate it to V2 normally
  const small = Array.from({ length: 50 }, (_, i) => "kept " + i).join("\n");
  assert.equal(core.edit("page-big", { text: small, fmt: "", ids: new Array(50).fill(null) }), true);
  timers.runAll();
  await settle();
  assert.equal(srv.saves().at(-1).payload.content.version, 2, "under the limit the page is sent (and stored) as V2");
  assert.equal(srv.pg("page-big").content.version, 2);
  assert.equal(R.flat(R.linesFromContent(srv.pg("page-big").content)), small);
  ok("oversized V1: load, edit compactly, shrink to V2");
}
{
  // 2. maximum-size, newline-heavy V1 page (PAGE_TEXT_BYTES newlines): readable, no amplification
  const text = "\n".repeat(49152);
  const srv = fakeServer();
  srv.nb.pages.push(v1Page("page-max", 1, text));
  const { core } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-max");
  assert.equal(e.local.text, text);
  assert.equal(e.local.ids.length, 49153);
  assert.equal(srv.pg("page-max").content.blocks.length, 1, "the server copy stays one block");
  ok("max newline-heavy V1 page readable");
}
{
  // 5. structured formatting while over the structured limit fails visibly and changes nothing
  const n = R.BLOCKS_MAX + 1;
  const { text, page } = bigV1Page("page-big", 1, n);
  const srv = fakeServer();
  srv.nb.pages.push(page);
  const { core } = make(srv, memStorage());
  await core.load();
  const e = core.entry("page-big");
  const lines = R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
  const bold = R.toggleMark(lines, 0, 2, "bold");
  assert.equal(core.edit("page-big", { text: R.flat(bold), fmt: R.fmtOf(bold), ids: R.idsOf(bold) }), false, "structure over the limit is refused by the state machine");
  assert.equal(e.local.text, text);
  assert.equal(e.local.fmt, "");
  assert.equal(core.isDirty(e), false, "nothing became dirty");
  assert.equal(srv.saves().length, 0);
  assert.equal(R.linesFromTextFmt(text, R.fmtOf(bold)), null);
  ok("structured over limit refused");
}
{
  // a V2 page above the limit (however it got there) is still readable
  const blocks = Array.from({ length: R.BLOCKS_MAX + 5 }, (_, i) => ({ id: "block-v" + i, type: "paragraph", text: "t" + i, marks: [] }));
  const srv = fakeServer();
  srv.nb.pages.push(v2Page("page-v2big", 1, blocks.map(({ id, ...rest }) => rest)));
  srv.nb.pages.at(-1).content.blocks.forEach((b, i) => { b.id = "block-v" + i; });
  const { core } = make(srv, memStorage());
  await core.load();
  assert.equal(core.entry("page-v2big").local.ids.length, R.BLOCKS_MAX + 5);
  ok("V2 above the limit is readable");
}
{
  // ids through the whole state machine: insert a NEW block before A and B, save, reload, draft reload
  const srv = fakeServer();
  srv.nb.pages = [v2Page("page-ids", 1, [{ type: "paragraph", text: "one" }, { type: "paragraph", text: "two" }])];
  srv.nb.pages[0].content.blocks[0].id = "block-A";
  srv.nb.pages[0].content.blocks[1].id = "block-B";
  const st = memStorage();
  const A = make(srv, st);
  await A.core.load();
  const e = A.core.entry("page-ids");
  assert.deepEqual(e.local.ids, ["block-A", "block-B"]);
  let lines = R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
  lines = R.replaceRange(R.splitAt(lines, 0, 0).lines, 0, 0, "NEW").lines; // new line above, typed into
  R.ensureKeys(lines);
  const tmp = lines[0].id;
  assert.ok(R.isTmpId(tmp));
  assert.equal(A.core.edit("page-ids", { text: R.flat(lines), fmt: R.fmtOf(lines), ids: R.idsOf(lines) }), true);
  // unsaved-draft reload: the draft keeps the real ids of A and B (the new block has none yet)
  const rec = draftsOf(st)["page-ids"];
  assert.deepEqual(rec.content.blocks.map((b) => b.id), [undefined, "block-A", "block-B"]);
  const D = make(srv, st); // reload with the unsaved draft
  await D.core.load();
  D.core.select("page-ids");
  const de = D.core.entry("page-ids");
  assert.equal(de.local.text, "NEW\none\ntwo");
  assert.deepEqual(de.local.ids.slice(1), ["block-A", "block-B"], "draft reload keeps block identity");
  // save (from the reloaded client)
  D.timers.runAll();
  await settle();
  const payload = srv.saves().at(-1).payload.content.blocks;
  assert.deepEqual(payload.map((b) => [b.id, b.text]), [[undefined, "NEW"], ["block-A", "one"], ["block-B", "two"]], "only the NEW block omits its id");
  const stored = srv.pg("page-ids").content.blocks;
  assert.deepEqual(stored.slice(1).map((b) => [b.id, b.text]), [["block-A", "one"], ["block-B", "two"]], "A and B keep their identity");
  assert.match(stored[0].id, /^block-srv/);
  assert.deepEqual(de.local.ids, stored.map((b) => b.id), "the server-generated id is adopted");
  assert.equal(D.core.isDirty(de), false);
  // reload again: same ids
  const F = make(srv, memStorage());
  await F.core.load();
  assert.deepEqual(F.core.entry("page-ids").local.ids, stored.map((b) => b.id));
  ok("ids: insert before, reload, draft reload");

  // split in the middle of an existing sequence, save: only the tail is new
  const G = make(srv, memStorage());
  await G.core.load();
  const ge = G.core.entry("page-ids");
  let gl = R.linesFromTextFmt(ge.local.text, ge.local.fmt, ge.local.ids);
  gl = R.splitAt(gl, 5, 5).lines; // "NEW\no|ne\ntwo"
  R.ensureKeys(gl);
  G.core.edit("page-ids", { text: R.flat(gl), fmt: R.fmtOf(gl), ids: R.idsOf(gl) });
  G.timers.runAll();
  await settle();
  const after = srv.pg("page-ids").content.blocks;
  assert.deepEqual(after.map((b) => b.text), ["NEW", "o", "ne", "two"]);
  assert.equal(after[0].id, stored[0].id);
  assert.equal(after[1].id, "block-A", "the first part of a split keeps the id");
  assert.notEqual(after[2].id, "block-A");
  assert.equal(after[3].id, "block-B");
  ok("ids: split in the middle");

  // late success: a block created before the response gets its id adopted, later edits keep it
  const H = make(srv, memStorage());
  await H.core.load();
  const he = H.core.entry("page-ids");
  let hl = R.linesFromTextFmt(he.local.text, he.local.fmt, he.local.ids);
  hl = R.splitAt(hl, 0, 0).lines; // new empty block above
  R.ensureKeys(hl);
  const keyed = hl[0].id;
  H.core.edit("page-ids", { text: R.flat(hl), fmt: R.fmtOf(hl), ids: R.idsOf(hl) });
  srv.hold = true;
  H.timers.runAll();
  await settle();
  hl = R.replaceRange(hl, 0, 0, "typed").lines; // newer typing while the save is in flight
  H.core.edit("page-ids", { text: R.flat(hl), fmt: R.fmtOf(hl), ids: R.idsOf(hl) });
  srv.hold = false;
  srv.release();
  await settle(12);
  const finalBlocks = srv.pg("page-ids").content.blocks;
  assert.equal(finalBlocks[0].text, "typed");
  const secondPayload = srv.saves().at(-1).payload.content.blocks;
  assert.match(secondPayload[0].id, /^block-srv/, "the late-success save re-sends the id the server generated for that block (no churn)");
  assert.equal(finalBlocks[0].id, secondPayload[0].id);
  assert.ok(R.isTmpId(keyed) && keyed !== secondPayload[0].id, "the temporary key was replaced by the server id");
  ok("ids: late success adoption");

  // conflict "keep mine" after the remote deleted a block: its id is not claimed again
  const I = make(srv, memStorage());
  await I.core.load();
  const ie = I.core.entry("page-ids");
  const il = R.linesFromTextFmt(ie.local.text, ie.local.fmt, ie.local.ids);
  const edited = R.replaceRange(il, 0, 0, "mine ").lines;
  I.core.edit("page-ids", { text: R.flat(edited), fmt: R.fmtOf(edited), ids: R.idsOf(R.ensureKeys(edited)) });
  const remote = srv.pg("page-ids");
  srv.remote({ action: "page_save", id: "page-ids", expected_rev: remote.rev, content: { version: 2, blocks: [{ id: "block-B", type: "paragraph", text: "two", marks: [] }] } }); // A, o/ne... deleted remotely
  I.timers.runAll();
  await settle();
  assert.ok(ie.conflict);
  await I.core.keepLocal("page-ids");
  await settle();
  const kept = srv.saves().at(-1).payload.content.blocks;
  assert.ok(kept.every((b) => b.id === undefined || b.id === "block-B"), "ids of blocks that no longer exist are never claimed: " + JSON.stringify(kept.map((b) => b.id)));
  assert.equal(I.core.isDirty(ie), false, "the save succeeds");
  ok("ids: conflict keep-local after remote deletion");
}

// ================================================================ compact local drafts for oversized plain pages
{
  const bigText = "\n".repeat(49152); // exactly PAGE_TEXT_BYTES: 49153 logical lines
  const editBig = (core, id, at, ch) => {
    const e = core.entry(id);
    const lines = R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
    const next = R.replaceRange(lines, at, at + 1, ch).lines; // replace a newline by a letter: same size
    R.ensureKeys(next);
    return core.edit(id, { text: R.flat(next), fmt: R.fmtOf(next), ids: R.idsOf(next) });
  };
  const blocksIn = (rec) => rec.content.blocks.length;

  // 1. edit offline: the draft stays compact and reload recovers the exact text
  {
    const srv = fakeServer();
    srv.nb.pages.push(v1Page("page-max", 1, bigText));
    srv.offline = true;
    const st = memStorage();
    const A = make(srv, st);
    srv.offline = false;
    await A.core.load();
    srv.offline = true;
    assert.equal(editBig(A.core, "page-max", 0, "a"), true);
    const rec = draftsOf(st)["page-max"];
    assert.equal(rec.content.version, 1, "an oversized plain draft is persisted as one legacy block");
    assert.equal(blocksIn(rec), 1);
    assert.equal(rec.content.blocks[0].text, "a" + bigText.slice(1));
    assert.equal(rec.content.blocks[0].id, "block-max", "the legacy block id is kept");
    const bytes = st.m.get(C.draftKey("admin-test")).length;
    assert.ok(bytes < 200 * 1024, "draft JSON stays small (" + bytes + " bytes), it does not scale with the line count");
    assert.deepEqual(rec.base, { version: 1, text: bigText, pinned: false }, "exact base is the compact V1 shape");
    srv.offline = false;
    const B = make(srv, st); // reload
    await B.core.load();
    const b = B.core.entry("page-max");
    assert.equal(b.local.text, "a" + bigText.slice(1), "exact text recovered");
    assert.equal(b.local.fmt, "");
    assert.equal(B.core.isDirty(b), true, "recovered draft is dirty");
    assert.equal(b.draftBase && b.draftBase.text, bigText, "exact recovery base");
    ok("compact draft: recover exact text");
  }

  // 2. several oversized dirty pages offline: independent, no draft-map loss
  {
    const srv = fakeServer();
    const texts = { "page-o1": "\n".repeat(20000), "page-o2": "x\n".repeat(15000), "page-o3": "\n".repeat(30000) };
    for (const [id, t] of Object.entries(texts)) srv.nb.pages.push(v1Page(id, 1, t));
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    srv.offline = true;
    for (const id of Object.keys(texts)) assert.equal(editBig(A.core, id, 0, "E" + id.slice(-1)), true);
    const all = draftsOf(st);
    for (const id of Object.keys(texts)) {
      assert.equal(blocksIn(all[id]), 1, id + " compact");
      assert.equal(all[id].content.blocks[0].text.length, texts[id].length - 1 + 2, id + " exact text stored");
    }
    assert.ok(st.m.get(C.draftKey("admin-test")).length < 400 * 1024, "three oversized drafts together stay small");
    srv.offline = false;
    const B = make(srv, st);
    await B.core.load();
    for (const id of Object.keys(texts)) assert.ok(B.core.entry(id).local.text.startsWith("E" + id.slice(-1)), id + " independently recovered");
    // a small clean page edited later never drops the others
    B.core.edit("page-rich", { text: "Plan\nmeasure\nnote!", fmt: B.core.entry("page-rich").local.fmt });
    const still = draftsOf(st);
    assert.ok(still["page-o1"] && still["page-o2"] && still["page-o3"], "no accidental draft-map loss");
    ok("compact drafts: multiple pages");
  }

  // 3. compact recovered draft + remote trash/restore: exact-base rules unchanged
  {
    const scenario = async (mutateRemote) => {
      const srv = fakeServer();
      srv.nb.pages.push(v1Page("page-max", 1, bigText));
      const st = memStorage();
      const A = make(srv, st);
      await A.core.load();
      assert.equal(editBig(A.core, "page-max", 0, "L"), true);
      srv.remote({ action: "page_trash", id: "page-max", expected_rev: 1 }); // rev 2 (before any save)
      await A.core.poll();
      await settle();
      const B = make(srv, st); // fresh tab: base must survive persistence
      await B.core.load();
      const b = B.core.entry("page-max");
      if (mutateRemote) mutateRemote(srv.pg("page-max"));
      srv.remote({ action: "page_restore", id: "page-max", expected_rev: srv.pg("page-max").rev });
      await B.core.poll();
      await settle();
      B.timers.runAll();
      await settle();
      return { srv, b, B };
    };
    const same = await scenario(null);
    assert.equal(same.b.conflict, null, "identical base content rebases safely");
    assert.equal(same.srv.pg("page-max").content.blocks[0].text.startsWith("L"), true, "the compact draft resumed");
    assert.equal(same.srv.saves().at(-1).payload.content.version, 1, "and is saved compactly");
    const text = await scenario((pg) => { pg.content.blocks[0].text = "changed elsewhere"; });
    assert.ok(text.b.conflict, "changed remote text -> the normal conflict path");
    assert.equal(text.srv.pg("page-max").content.blocks[0].text, "changed elsewhere", "remote never overwritten");
    const pin = await scenario((pg) => { pg.pinned = true; });
    assert.ok(pin.b.conflict, "changed remote pin -> the normal conflict path");
    ok("compact draft + remote restore: exact base");
  }

  // 4. localStorage write failure stays truthful
  {
    const srv = fakeServer();
    srv.nb.pages.push(v1Page("page-max", 1, bigText));
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    srv.offline = true;
    st.fail = true;
    assert.equal(editBig(A.core, "page-max", 0, "Q"), true);
    const e = A.core.entry("page-max");
    assert.equal(A.drafts.failed, true, "the local-durability warning is raised");
    assert.equal(A.core.isDirty(e), true, "the memory edit stays dirty (never reported saved)");
    assert.equal(draftsOf(st)["page-max"], undefined, "nothing was persisted");
    assert.equal(e.local.text.startsWith("Q"), true);
    st.fail = false;
    assert.equal(editBig(A.core, "page-max", 1, "R"), true);
    assert.equal(A.drafts.failed, false, "the warning clears only when the page is really stored");
    assert.equal(draftsOf(st)["page-max"].content.blocks[0].text.slice(0, 2), "QR");
    ok("compact draft: storage failure truthful");
  }
}

// ================================================================ id adoption: obsolete real ids never re-sent
{
  const srv = fakeServer();
  srv.nb.pages = [v2Page("page-al", 1, [{ type: "paragraph", text: "one" }])];
  srv.nb.pages[0].content.blocks[0].id = "block-A";
  const A = make(srv, memStorage());
  await A.core.load();
  const e = A.core.entry("page-al");
  const local = (fn) => {
    const lines = R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
    const next = fn(lines);
    R.ensureKeys(next);
    return A.core.edit("page-al", { text: R.flat(next), fmt: R.fmtOf(next), ids: R.idsOf(next) });
  };
  local((l) => R.replaceRange(l, 3, 3, " mine").lines);
  srv.remote({ action: "page_save", id: "page-al", expected_rev: 1, content: { version: 2, blocks: [{ type: "paragraph", text: "remote", marks: [] }] } }); // A is gone, X arrives
  A.timers.runAll();
  await settle();
  assert.ok(e.conflict);
  await A.core.keepLocal("page-al");
  await settle();
  const C1 = srv.pg("page-al").content.blocks[0].id;
  assert.notEqual(C1, "block-A");
  assert.equal(srv.saves().at(-1).payload.content.blocks[0].id, undefined, "the obsolete id was sent as a NEW block");
  assert.equal(e.local.ids[0], C1, "the core adopted the server id");
  assert.equal(e.alias["block-A"], C1);
  // a stale live DOM still reports block-A: the next edit must NOT re-send it
  assert.equal(local((l) => R.replaceRange(l.map((x) => Object.assign(x, { id: "block-A" })), 0, 0, "again ").lines), true);
  assert.equal(e.local.ids[0], C1, "a stale id is aliased to the adopted one on the way in");
  A.timers.runAll();
  await settle();
  assert.equal(srv.saves().at(-1).payload.content.blocks[0].id, C1, "the adopted id is claimed");
  assert.equal(srv.pg("page-al").content.blocks[0].id, C1, "no new id was generated: identity is stable");
  ok("id adoption: alias");
}

// ================================================================ lifecycle rebase must never regenerate block ids
{
  const idPage = () => {
    const pg = v2Page("page-idr", 1, [{ type: "paragraph", text: "one" }, { type: "paragraph", text: "two" }, { type: "paragraph", text: "three" }]);
    pg.content.blocks.forEach((b, i) => { b.id = "block-" + "ABC"[i]; });
    return pg;
  };
  const rename = (srv, ids) => srv.pg("page-idr").content.blocks.forEach((b, i) => { b.id = ids[i]; });
  const editLocal = (core, fn) => {
    const e = core.entry("page-idr");
    const next = fn(R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids));
    R.ensureKeys(next);
    return core.edit("page-idr", { text: R.flat(next), fmt: R.fmtOf(next), ids: R.idsOf(next) });
  };
  const trash = async (srv, core) => {
    srv.remote({ action: "page_trash", id: "page-idr", expected_rev: srv.pg("page-idr").rev });
    await core.poll();
    await settle();
  };

  // 1. dirty in-memory: remote returns text/fmt/pin EXACTLY to the base but with brand-new block ids
  {
    const srv = fakeServer();
    srv.nb.pages = [idPage()];
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    const e = A.core.entry("page-idr");
    assert.equal(editLocal(A.core, (l) => R.replaceRange(l, 3, 3, " LOCAL").lines), true);
    await trash(srv, A.core); // rev 2
    assert.equal(A.core.isTrashed(e), true);
    srv.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 }); // rev 3
    rename(srv, ["block-X", "block-Y", "block-Z"]); // the blocks were re-created elsewhere; text/fmt/pin identical to the base
    await A.core.poll();
    await settle();
    A.timers.runAll();
    await settle();
    assert.equal(e.serverRev, 1, "the fast rebase was refused: serverRev did not advance");
    assert.ok(e.conflict, "the save meets the ordinary 409 conflict");
    const last = srv.saves().at(-1).payload;
    assert.equal(last.expected_rev, 1, "the optimistic revision is the old base");
    assert.deepEqual(srv.pg("page-idr").content.blocks.map((b) => b.id), ["block-X", "block-Y", "block-Z"], "remote ids untouched");
    assert.equal(R.flat(R.linesFromContent(srv.pg("page-idr").content)), "one\ntwo\nthree", "remote content untouched");
    assert.ok(e.local.text.includes("LOCAL"), "local edit protected");
    assert.ok(draftsOf(st)["page-idr"], "local draft protected");
    assert.ok(srv.saves().every((c) => c.payload.expected_rev === 1), "no save was ever sent against the newer revision");
    ok("rebase fail-closed: in-memory id change");
  }

  // 2. recovered-draft version: only the exact persisted base is available after reload
  {
    const srv = fakeServer();
    srv.nb.pages = [idPage()];
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    assert.equal(editLocal(A.core, (l) => R.replaceRange(l, 3, 3, " LOCAL").lines), true);
    srv.offline = true; // the tab closes without saving
    srv.offline = false;
    srv.remote({ action: "page_trash", id: "page-idr", expected_rev: 1 });
    srv.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 });
    rename(srv, ["block-X", "block-Y", "block-Z"]);
    const B = make(srv, st); // reload
    await B.core.load();
    const b = B.core.entry("page-idr");
    assert.equal(b.draftBase && b.draftBase.text, "one\ntwo\nthree", "the exact base was recovered");
    assert.equal(b.serverRev, 1, "identity not provable: no fast rebase at load");
    B.timers.runAll();
    await settle();
    assert.ok(b.conflict, "ordinary conflict");
    assert.deepEqual(srv.pg("page-idr").content.blocks.map((x) => x.id), ["block-X", "block-Y", "block-Z"]);
    assert.ok(b.local.text.includes("LOCAL"));
    assert.ok(draftsOf(st)["page-idr"]);
    ok("rebase fail-closed: recovered draft");
  }

  // 3. control: trash/restore with unchanged ids keeps the automatic safe rebase (in memory and recovered)
  {
    const srv = fakeServer();
    srv.nb.pages = [idPage()];
    const st = memStorage();
    const A = make(srv, st);
    await A.core.load();
    const e = A.core.entry("page-idr");
    assert.equal(editLocal(A.core, (l) => R.replaceRange(l, 3, 3, " LOCAL").lines), true);
    await trash(srv, A.core);
    srv.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 });
    await A.core.poll();
    await settle();
    A.timers.runAll();
    await settle();
    assert.equal(e.conflict, null, "unchanged ids: safe rebase");
    assert.deepEqual(srv.pg("page-idr").content.blocks.map((b) => b.id), ["block-A", "block-B", "block-C"], "ids retained");
    assert.equal(srv.pg("page-idr").content.blocks[0].text, "one LOCAL");
    assert.equal(srv.saves().at(-1).payload.expected_rev, 3, "rebased onto the restored revision");
    assert.deepEqual(srv.saves().at(-1).payload.content.blocks.map((b) => b.id), ["block-A", "block-B", "block-C"], "the resumed save claims A/B/C");
    // recovered-draft control
    const srv2 = fakeServer();
    srv2.nb.pages = [idPage()];
    const st2 = memStorage();
    const A2 = make(srv2, st2);
    await A2.core.load();
    editLocal(A2.core, (l) => R.replaceRange(l, 3, 3, " LOCAL").lines);
    srv2.remote({ action: "page_trash", id: "page-idr", expected_rev: 1 });
    srv2.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 });
    const B2 = make(srv2, st2);
    await B2.core.load();
    B2.timers.runAll();
    await settle();
    assert.equal(B2.core.entry("page-idr").conflict, null, "recovered draft with unchanged ids rebases");
    assert.deepEqual(srv2.pg("page-idr").content.blocks.map((b) => b.id), ["block-A", "block-B", "block-C"]);
    ok("rebase control: unchanged ids");
  }

  // 5. same ids, different logical lines: id ORDER must be proved, not just membership
  {
    const setBlocks = (srv, list) => {
      const pg = srv.pg("page-idr");
      pg.content.blocks = list.map(([id, text]) => ({ id, type: "paragraph", text, marks: [] }));
      pg.rev += 1;
    };
    const rebased = async (localFn, finalList) => {
      const srv = fakeServer();
      srv.nb.pages = [idPage()];
      const st = memStorage();
      const A = make(srv, st);
      await A.core.load();
      const e = A.core.entry("page-idr");
      assert.equal(editLocal(A.core, localFn), true);
      await trash(srv, A.core); // rev 2
      srv.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 }); // rev 3
      if (finalList) {
        // a REAL two-save remote sequence ending on the base text/fmt/pin with re-associated ids
        setBlocks(srv, [["block-B", "ONE-REMOTE"], ["block-A", "two"], ["block-C", "three"]]);
        setBlocks(srv, [["block-B", "one"], ["block-A", "two"], ["block-C", "three"]]);
        if (finalList !== "swap") setBlocks(srv, finalList);
      }
      await A.core.poll();
      await settle();
      A.timers.runAll();
      await settle();
      return { srv, e, st, A };
    };
    // the reported sequence: remote ids [B, A, C] with identical text/fmt/pin
    const bad = await rebased((l) => R.replaceRange(l, 3, 3, " LOCAL").lines, "swap");
    assert.equal(bad.srv.pg("page-idr").content.blocks.map((b) => b.text).join("|"), "one|two|three", "remote text is exactly the base");
    assert.equal(bad.e.serverRev, 1, "fast rebase refused: serverRev stays the old base");
    assert.ok(bad.e.conflict, "the save meets the ordinary 409");
    assert.ok(bad.srv.saves().length >= 1 && bad.srv.saves().every((c) => c.payload.expected_rev === 1), "no save was issued against the newer revision");
    assert.deepEqual(bad.srv.pg("page-idr").content.blocks.map((b) => b.id), ["block-B", "block-A", "block-C"], "remote ids remain [B, A, C]");
    assert.ok(bad.e.local.text.includes("LOCAL") && draftsOf(bad.st)["page-idr"], "local edit and draft protected");
    // the other unsafe order: [A, C, B]
    const bad2 = await rebased((l) => R.replaceRange(l, 3, 3, " LOCAL").lines, [["block-A", "one"], ["block-C", "two"], ["block-B", "three"]]);
    assert.equal(bad2.e.serverRev, 1);
    assert.ok(bad2.e.conflict, "[A,C,B] is refused too");
    assert.ok(bad2.srv.saves().every((c) => c.payload.expected_rev === 1));
    // controls
    const same = await rebased((l) => R.replaceRange(l, 3, 3, " LOCAL").lines, null);
    assert.equal(same.e.conflict, null, "unchanged [A,B,C] still rebases");
    assert.deepEqual(same.srv.pg("page-idr").content.blocks.map((b) => b.id), ["block-A", "block-B", "block-C"]);
    const withTmp = await rebased((l) => R.replaceRange(R.splitAt(l, 0, 0).lines, 0, 0, "NEW").lines, null);
    assert.ok(withTmp.e.conflict === null, "[tmp, A, B, C] vs [A, B, C] still rebases");
    assert.deepEqual(withTmp.srv.pg("page-idr").content.blocks.slice(1).map((b) => b.id), ["block-A", "block-B", "block-C"]);
    const deleted = await rebased((l) => R.replaceRange(l, 3, 8, "").lines, null); // delete the whole "two" line -> local ids [A, C]
    assert.equal(deleted.e.conflict, null, "[A, C] vs [A, B, C] still rebases (ordered subsequence)");
    assert.deepEqual(deleted.srv.pg("page-idr").content.blocks.map((b) => b.id).slice(0, 1), ["block-A"]);
    assert.ok(deleted.srv.saves().at(-1).payload.content.blocks.every((b) => b.id === undefined || ["block-A", "block-C"].includes(b.id)));
    ok("rebase: id order proved, not just membership");
  }

  // 6. the proof is against the OLD AUTHORITATIVE BASE id vector, never against the dirty local ids
  {
    const mkPage = (blocks) => {
      const pg = v2Page("page-idr", 1, blocks.map(([, text]) => ({ type: "paragraph", text })));
      pg.content.blocks.forEach((b, i) => { b.id = blocks[i][0]; });
      return pg;
    };
    const BASE3 = [["block-A", "one"], ["block-B", "two"], ["block-C", "three"]];
    const scenario = async ({ base = BASE3, localFn, final, reload = false, mutateDraft = null }) => {
      const srv = fakeServer();
      srv.nb.pages = [mkPage(base)];
      const st = memStorage();
      const A = make(srv, st);
      await A.core.load();
      assert.equal(editLocal(A.core, localFn), true);
      const draftBefore = JSON.parse(JSON.stringify(draftsOf(st)["page-idr"]));
      if (!reload) await trash(srv, A.core);
      else srv.remote({ action: "page_trash", id: "page-idr", expected_rev: 1 });
      srv.remote({ action: "page_restore", id: "page-idr", expected_rev: srv.pg("page-idr").rev });
      const pg = srv.pg("page-idr");
      if (final) {
        pg.content.blocks = final.map(([id, text]) => ({ id, type: "paragraph", text, marks: [] }));
        pg.rev += 1;
      }
      let core = A.core;
      let timers = A.timers;
      if (reload) {
        if (mutateDraft) mutateDraft(st);
        const B = make(srv, st);
        await B.core.load();
        core = B.core;
        timers = B.timers;
      } else {
        await A.core.poll();
        await settle();
      }
      timers.runAll();
      await settle();
      return { srv, e: core.entry("page-idr"), st, core, draftBefore };
    };
    const del = (l) => R.replaceRange(l, 3, 7, "").lines; // remove the whole "two" line -> local ids [A, C]
    const ins = (l) => R.replaceRange(R.splitAt(l, 0, 0).lines, 0, 0, "NEW").lines; // local ids [tmp, A, B, C]
    const edit = (l) => R.replaceRange(l, 3, 3, " LOCAL").lines;
    const untouched = (r, ids) => assert.deepEqual(r.srv.pg("page-idr").content.blocks.map((b) => b.id), ids, "remote ids untouched");
    const refused = (r, msg) => {
      assert.equal(r.e.serverRev, 1, msg + ": fast rebase refused, old serverRev kept");
      assert.ok(r.e.conflict, msg + ": ordinary 409 conflict");
      assert.ok(r.srv.saves().every((c) => c.payload.expected_rev === 1), msg + ": nothing sent against the newer revision");
      assert.ok(draftsOf(r.st)["page-idr"], msg + ": local draft protected");
    };
    const rebased = (r, msg) => {
      assert.equal(r.e.conflict, null, msg + ": safe rebase");
      assert.ok(r.e.serverRev > 1, msg + ": serverRev advanced");
    };

    for (const reload of [false, true]) {
      const tag = reload ? " [recovered draft]" : " [in memory]";
      // 1. local deletion + remote re-association [A, C, B] with text/fmt/pin identical to the base
      const remap = await scenario({ localFn: del, final: [["block-A", "one"], ["block-C", "two"], ["block-B", "three"]], reload });
      refused(remap, "local deletion + remote remap" + tag);
      untouched(remap, ["block-A", "block-C", "block-B"]);
      // 4. remote order change [B, A, C]
      const order = await scenario({ localFn: edit, final: [["block-B", "one"], ["block-A", "two"], ["block-C", "three"]], reload });
      refused(order, "remote order change" + tag);
      untouched(order, ["block-B", "block-A", "block-C"]);
      // 6. duplicate text: flattened text identical, identity swapped
      const dup = await scenario({ base: [["block-A", "same"], ["block-B", "same"]], localFn: (l) => R.replaceRange(l, 0, 0, "x").lines, final: [["block-B", "same"], ["block-A", "same"]], reload });
      refused(dup, "duplicate-text identity swap" + tag);
      untouched(dup, ["block-B", "block-A"]);
      // 2/3. controls: lifecycle-only remote keeps [A, B, C]
      rebased(await scenario({ localFn: ins, final: null, reload }), "insertion control" + tag);
      const delOk = await scenario({ localFn: del, final: null, reload });
      rebased(delOk, "deletion control" + tag);
      assert.deepEqual(delOk.srv.pg("page-idr").content.blocks.map((b) => b.id).slice(0, 1), ["block-A"]);
      rebased(await scenario({ localFn: edit, final: null, reload }), "unchanged control" + tag);
    }

    // 5. recovered drafts can only fast-rebase when the OLD id vector is known and matches
    const loaded = await scenario({ localFn: edit, final: null, reload: true });
    assert.equal(loaded.draftBefore.base.version, 3);
    assert.deepEqual(loaded.draftBefore.base.ids, ["block-A", "block-B", "block-C"], "the persisted base carries the exact authoritative id vector");
    const rewrite = (fn) => (st) => {
      const all = JSON.parse(st.m.get(C.draftKey("admin-test")));
      fn(all.pages["page-idr"]);
      st.m.set(C.draftKey("admin-test"), JSON.stringify(all));
    };
    // a pre-id base (no vector) on a multi-block page cannot be proven -> fail closed
    const noVec = await scenario({ localFn: edit, final: null, reload: true, mutateDraft: rewrite((d) => { d.base = { version: 2, text: d.base.text, fmt: d.base.fmt, pinned: d.base.pinned }; }) });
    refused(noVec, "pre-id base without a vector");
    const legacyShape = await scenario({ localFn: edit, final: null, reload: true, mutateDraft: rewrite((d) => { d.base = { version: 1, text: d.base.text, pinned: d.base.pinned }; }) });
    refused(legacyShape, "legacy text+pin base on a multi-block page");
    // malformed vectors fail closed (no base at all -> ordinary conflict protection)
    const bads = {
      "wrong length": (d) => { d.base.ids = ["block-A", "block-B"]; },
      "duplicate ids": (d) => { d.base.ids = ["block-A", "block-A", "block-C"]; },
      "temporary id": (d) => { d.base.ids = ["block-A", "tmp-1", "block-C"]; },
      "not an array": (d) => { d.base.ids = "block-A"; },
      "extra key": (d) => { d.base.rev = 1; },
      "wrong version": (d) => { d.base.version = 4; },
    };
    for (const [label, fn] of Object.entries(bads)) {
      const r = await scenario({ localFn: edit, final: null, reload: true, mutateDraft: rewrite(fn) });
      assert.equal(r.e.draftBase, null, "malformed base fails closed: " + label);
      refused(r, "malformed base " + label);
    }
    // a legacy single-block V1 page keeps the accepted text+pin base and still rebases
    {
      const srv = fakeServer();
      srv.nb.pages = [v1Page("page-leg", 1, "legacy text")];
      const st = memStorage();
      const A = make(srv, st);
      await A.core.load();
      A.core.edit("page-leg", { text: "legacy text!" });
      assert.deepEqual(draftsOf(st)["page-leg"].base, { version: 1, text: "legacy text", pinned: false }, "V1 pages keep the accepted base shape");
      srv.remote({ action: "page_trash", id: "page-leg", expected_rev: 1 });
      srv.remote({ action: "page_restore", id: "page-leg", expected_rev: 2 });
      const B = make(srv, st);
      await B.core.load();
      B.timers.runAll();
      await settle();
      assert.equal(B.core.entry("page-leg").conflict, null, "recovered legacy V1 draft still rebases (single block: nothing to re-associate)");
    }
    ok("rebase: proof against the old authoritative id vector");
  }

  // 4. a local insertion (temporary id) must not prevent a safe rebase while every real id still belongs to the page
  {
    const srv = fakeServer();
    srv.nb.pages = [idPage()];
    const A = make(srv, memStorage());
    await A.core.load();
    const e = A.core.entry("page-idr");
    assert.equal(editLocal(A.core, (l) => R.replaceRange(R.splitAt(l, 0, 0).lines, 0, 0, "NEW").lines), true);
    assert.ok(e.local.ids.some((x) => R.isTmpId(x)), "a temporary id is present");
    await trash(srv, A.core);
    srv.remote({ action: "page_restore", id: "page-idr", expected_rev: 2 });
    await A.core.poll();
    await settle();
    A.timers.runAll();
    await settle();
    assert.equal(e.conflict, null, "safe rebase despite the temporary id");
    const sent = srv.saves().at(-1).payload.content.blocks;
    assert.deepEqual(sent.map((b) => b.id), [undefined, "block-A", "block-B", "block-C"], "only the new block omits its id");
    assert.deepEqual(srv.pg("page-idr").content.blocks.slice(1).map((b) => b.id), ["block-A", "block-B", "block-C"]);
    ok("rebase: temporary ids never block it");
  }
}

console.log(`hq carnet rich checks ok (${groups} groups)`);
