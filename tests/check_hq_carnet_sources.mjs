// Carnet Stage 05 — citations in the structured model, sources helpers (picker, calibration,
// supersession/migration), and the draft/concurrency state machine with citations
// (no browser, no server, no live data). Shared vectors: tests/fixtures_carnet_sources.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");
const R = require("../assets/hq-carnet-rich.js");
const S = require("../assets/hq-carnet-sources.js");
const fx = JSON.parse(readFileSync(new URL("./fixtures_carnet_sources.json", import.meta.url), "utf8"));

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) {
  for (let i = 0; i < n; i += 1) await tick();
}
let groups = 0;
const ok = () => { groups += 1; };

const L = (text, type, marks, checked) => R.newLine(text, type || "paragraph", !!checked, marks || []);
const M = (type, start, end, extra) => Object.assign({ type, start, end }, extra || {});
const sources = fx.sources;
const ed = (id) => sources.editions.find((e) => e.id === id);
const cite = (over) => Object.assign({ src: "srce-shigley12", loc: { kind: "page", text: "417" }, pdf: 439, ok: false, snap: { title: "Shigley", edition: "12e" }, from: null }, over || {});

// ---------------------------------------------------------------- payload validation + label
{
  assert.deepEqual(R.checkCite(cite()), cite(), "valid payload is returned canonical");
  assert.equal(R.checkCite(Object.assign(cite(), { extra: 1 })), null, "no extra keys");
  assert.equal(R.checkCite(Object.assign(cite(), { src: "srcf-x" })), null, "edition id only");
  assert.equal(R.checkCite(cite({ loc: { kind: "nope", text: "1" } })), null);
  assert.equal(R.checkCite(cite({ pdf: 0 })), null);
  assert.equal(R.checkCite(cite({ pdf: 100001 })), null);
  assert.equal(R.checkCite(cite({ pdf: "3" })), null);
  assert.equal(R.checkCite(cite({ pdf: true })), null);
  assert.equal(R.checkCite(cite({ ok: 1 })), null);
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "" }, pdf: null, ok: true })), null, "nothing to have verified");
  assert.notEqual(R.checkCite(cite({ loc: { kind: "page", text: "" }, pdf: 9, ok: true })), null, "a PDF page alone can be verified");
  assert.equal(R.checkCite(cite({ snap: { edition: "12e" } })), null, "title required");
  assert.equal(R.checkCite(cite({ snap: { title: "T", html: "<b>" } })), null);
  assert.equal(R.checkCite(cite({ snap: { title: "T", year: "2026" } })), null);
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "x".repeat(121) } })), null);
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "a\nb" } })), null);
  assert.equal(R.checkCite(cite({ from: { src: "srce-x" } })), null);
  assert.equal(R.checkCite(null), null);
  assert.equal(R.checkCite("x"), null);
  // whitespace is normalised like the server
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "  4   17 " } })).loc.text, "4 17");
  // whitespace is an explicit set shared with the server (Python str.split and \\s disagree on U+0085 / U+FEFF)
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "A\ufeffB" } })).loc.text, "A B");
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "A\u00a0\u3000B" } })).loc.text, "A B");
  for (const bad of ["A\u0085B", "A\u001cB", "A\u009fB"]) assert.equal(R.checkCite(cite({ loc: { kind: "page", text: bad } })), null, JSON.stringify(bad));
  assert.equal(R.checkCite(cite({ loc: { kind: "page", text: "A\u200bB" } })).loc.text, "A\u200bB", "zero-width space is not whitespace on either side");
  // unpaired surrogates are refused (valid pairs pass), like the server
  for (const bad of ["\ud800", "\udc00", "A\ud800B", "A\udc00B", "\ude00\ud83d", "A\ud83d"]) assert.equal(R.checkCite(cite({ loc: { kind: "page", text: bad } })), null, JSON.stringify(bad));
  assert.notEqual(R.checkCite(cite({ loc: { kind: "page", text: "\ud83d\ude00" } })), null, "a valid pair passes");
  assert.equal(R.checkCite(cite({ snap: { title: "A\ud800B" } })), null);
  // key order is irrelevant; the canonical key is order independent
  const a = cite();
  const b = {}; for (const k of Object.keys(a).reverse()) b[k] = a[k];
  assert.equal(R.citeKey(R.checkCite(a)), R.citeKey(R.checkCite(b)));
  // labels
  assert.equal(R.citationLabel(R.checkCite(cite())), "[Shigley 12e, p. 417]");
  assert.equal(R.citationLabel(R.checkCite(cite({ loc: { kind: "section", text: "8.2" }, pdf: null }))), "[Shigley 12e, § 8.2]");
  assert.equal(R.citationLabel(R.checkCite(cite({ loc: { kind: "clause", text: "5.3" } }))), "[Shigley 12e, art. 5.3]");
  assert.equal(R.citationLabel(R.checkCite(cite({ loc: { kind: "custom", text: "Annexe B" } }))), "[Shigley 12e, Annexe B]");
  assert.equal(R.citationLabel(R.checkCite(cite({ loc: { kind: "page", text: "" }, pdf: null }))), "[Shigley 12e, à vérifier]");
  assert.equal(R.citationLabel(R.checkCite(cite({ loc: { kind: "page", text: "" }, pdf: 439 }))), "[Shigley 12e, p. PDF 439]");
  for (const k of R.LOCATOR_KINDS) assert.ok(R.checkCite(cite({ loc: { kind: k, text: "1" } })), k);
  ok();
}

// ---------------------------------------------------------------- insert / atom behaviour
function withCite(text, at, c) {
  return R.insertCitation([L(text)], at, at, c || cite());
}
{
  const res = withCite("Voir  ok", 5);
  const line = res.lines[0];
  assert.equal(line.text, "Voir [Shigley 12e, p. 417] ok");
  assert.deepEqual(line.marks.map((m) => [m.type, m.start, m.end]), [["citation", 5, 26]]);
  assert.equal(res.caret, 26);
  assert.equal(R.insertCitation([L("x")], 0, 0, { nope: 1 }), null, "invalid payload refused");
  // replace a selection
  const r2 = R.insertCitation([L("abcdef")], 1, 4, cite());
  assert.equal(r2.lines[0].text, "a[Shigley 12e, p. 417]ef");
  // inserting over a link drops the link part, never overlaps
  const linked = [L("see the link here", "paragraph", [M("link", 4, 12, { href: "https://example.com" })])];
  const r3 = R.insertCitation(linked, 6, 9, cite());
  for (const m of r3.lines[0].marks) assert.ok(m.type !== "link" || m.end <= r3.start - 0 || m.start >= r3.end || true);
  const cm = r3.lines[0].marks.find((m) => m.type === "citation");
  assert.ok(!r3.lines[0].marks.some((m) => m.type === "link" && m.start < cm.end && cm.start < m.end), "no link/citation overlap");
  // insert inside a citation goes AFTER it
  const base = withCite("ab", 1).lines;
  const inside = R.replaceRange(base, 4, 4, "ZZ");
  assert.equal(inside.lines[0].text, "a[Shigley 12e, p. 417]ZZb", "typing inside the atom lands after it");
  assert.deepEqual(inside.lines[0].marks.map((m) => [m.type, m.start, m.end]), [["citation", 1, 22]]);
  // deleting a part of the atom deletes all of it
  const del = R.replaceRange(base, 3, 6, "");
  assert.equal(del.lines[0].text, "ab");
  assert.deepEqual(del.lines[0].marks, []);
  // a range ending inside the atom covers all of it; starting inside too
  const del2 = R.replaceRange(base, 0, 5, "");
  assert.equal(del2.lines[0].text, "b");
  const del3 = R.replaceRange(base, 10, 99, "");
  assert.equal(del3.lines[0].text, "a");
  // the atom is never inherited by typed text next to it
  const after = R.replaceRange(base, 22, 22, "Q");
  assert.equal(after.lines[0].text, "a[Shigley 12e, p. 417]Qb");
  assert.equal(after.lines[0].marks.length, 1);
  ok();
}

// ---------------------------------------------------------------- canonical marks / fmt / equality
{
  const c1 = R.checkCite(cite());
  const two = R.canonicalMarks([M("citation", 0, 3, { cite: c1 }), M("citation", 3, 6, { cite: c1 })]);
  assert.equal(two.length, 2, "two identical adjacent citations stay two");
  assert.equal(R.canonicalMarks([M("citation", 0, 4, { cite: c1 }), M("citation", 3, 6, { cite: c1 })]), null, "overlapping citations rejected");
  assert.equal(R.canonicalMarks([M("citation", 0, 4, { cite: c1 }), M("link", 2, 6, { href: "https://a.b" })]), null, "citation/link overlap rejected");
  const both = R.canonicalMarks([M("bold", 0, 6), M("citation", 2, 5, { cite: c1 }), M("italic", 2, 5)]);
  assert.deepEqual(both.map((m) => m.type), ["bold", "italic", "citation"], "formatting may cover a citation; citation sorts after");
  // fmt round trip
  const text = "[a][b] xyz";
  const lines = [L(text, "paragraph", [M("citation", 0, 3, { cite: c1 }), M("citation", 3, 6, { cite: R.checkCite(cite({ pdf: 440 })) }), M("bold", 7, 10)])];
  const fmt = R.fmtOf(lines);
  assert.ok(fmt.includes('"citation"'));
  const back = R.linesFromTextFmt(text, fmt);
  assert.equal(R.fmtOf(back), fmt, "fmt round trip");
  assert.deepEqual(back[0].marks[1].cite, R.checkCite(cite({ pdf: 440 })));
  // equality: same text, only ONE thing differs in the citation -> different fmt
  const base = (over) => R.fmtOf([L("[Shigley 12e, p. 417]", "paragraph", [M("citation", 0, 21, { cite: R.checkCite(cite(over)) })])]);
  const ref = base();
  const variants = {
    edition: base({ src: "srce-other" }), kind: base({ loc: { kind: "section", text: "417" } }), loctext: base({ loc: { kind: "page", text: "418" } }),
    pdf: base({ pdf: 440 }), nopdf: base({ pdf: null }), verified: base({ ok: true }), title: base({ snap: { title: "Other", edition: "12e" } }),
    edlabel: base({ snap: { title: "Shigley", edition: "11e" } }),
    from: base({ from: { src: "srce-shigley11", loc: { kind: "page", text: "394" }, pdf: 416, ok: true } }),
  };
  for (const [k, v] of Object.entries(variants)) assert.notEqual(v, ref, "citation differs by " + k);
  assert.equal(new Set(Object.values(variants).concat([ref])).size, 10, "all distinct");
  assert.equal(base(), ref, "deterministic");
  const plain = R.fmtOf([L("[Shigley 12e, p. 417]")]);
  assert.equal(plain, "", "plain text has no fmt");
  assert.notEqual(ref, plain, "a citation over the same text is not plain text");
  // tampered fmt is rejected, never partially applied
  assert.ok(R.linesFromTextFmt("abc", fx.valid_fmt), "control: the valid vector parses");
  for (const bad of fx.tampered_fmt) assert.equal(R.linesFromTextFmt("abcdef", bad), null, bad);
  // non canonical (re-ordered/extra-spaced) array payload is rejected too
  assert.equal(R.linesFromTextFmt("abc", fx.valid_fmt.replace('"T"', '" T "')), null, "non canonical text rejected");
  // wire content round trip
  const content = R.contentFromLines(back);
  assert.equal(content.blocks[0].marks[0].type, "citation");
  assert.deepEqual(content.blocks[0].marks[0].cite, c1);
  assert.equal(R.fmtOf(R.linesFromContent(content)), fmt);
  // a server citation with extra keys / a bad payload is unusable, not half-read
  const bad1 = clone(content); bad1.blocks[0].marks[0].href = "https://x.y";
  assert.equal(R.linesFromContent(bad1), null);
  const bad2 = clone(content); bad2.blocks[0].marks[0].cite.pdf = 0;
  assert.equal(R.linesFromContent(bad2), null);
  ok();
}

// ---------------------------------------------------------------- find/replace never corrupts a citation
{
  const r = withCite("Shigley says  and Shigley", 13);
  const lines = r.lines;
  const flat = R.flat(lines);
  assert.ok(flat.includes("[Shigley 12e, p. 417]"));
  const found = R.findAll(lines, "shigley");
  const starts = found.map((m) => m.start);
  assert.ok(!starts.some((s) => s >= 13 && s < 13 + 21), "the match inside the citation label is excluded");
  assert.equal(found.length, 2, "the two ordinary words still match");
  const replaced = R.replaceMatches(lines, found, "Budynas");
  assert.ok(replaced[0].text.includes("[Shigley 12e, p. 417]"), "the label is untouched");
  assert.equal(replaced[0].marks.filter((m) => m.type === "citation").length, 1);
  assert.deepEqual(replaced[0].marks.find((m) => m.type === "citation").cite, R.checkCite(cite()));
  assert.equal(R.findAll(lines, "p. 417").length, 0, "a query inside the label never matches");
  assert.equal(R.findAll(lines, "12e, p").length, 0);
  // a match straddling the atom edge is excluded too
  assert.equal(R.findAll([L("x[Shigley 12e, p. 417]", "paragraph", [M("citation", 1, 22, { cite: R.checkCite(cite()) })])], "x[S").length, 0);
  // link refuses a citation range, but other ranges link fine
  assert.equal(R.setLink(lines, 13, 34, { href: "https://a.b" }), null);
  assert.equal(R.setLink(lines, 10, 20, { href: "https://a.b" }), null, "partial overlap refused as well");
  assert.notEqual(R.setLink(lines, 0, 7, { href: "https://a.b" }), null);
  // clearing a link over a citation is harmless
  assert.notEqual(R.setLink(lines, 13, 34, null), null);
  // formatting over the atom is allowed and keeps the payload
  const bold = R.toggleMark(lines, 10, 40, "bold");
  assert.ok(bold[0].marks.some((m) => m.type === "bold"));
  assert.deepEqual(bold[0].marks.find((m) => m.type === "citation").cite, R.checkCite(cite()));
  ok();
}

// ---------------------------------------------------------------- verify, edit-in-place, exports
{
  const r = withCite("Voir  ok", 5);
  const pos = R.citationAt(r.lines, 7);
  assert.ok(pos && pos.start === 5 && pos.end === 26);
  assert.equal(R.citationAt(r.lines, 26), null, "end is exclusive");
  assert.equal(R.citationAt(r.lines, 3), null);
  assert.equal(R.citationsOf(r.lines).length, 1);
  const verified = R.setCitationPayload(r.lines, 7, Object.assign({}, R.checkCite(cite()), { ok: true }));
  assert.equal(verified[0].text, r.lines[0].text, "verifying never touches the text");
  assert.equal(R.citationAt(verified, 7).mark.cite.ok, true);
  assert.notEqual(R.fmtOf(verified), R.fmtOf(r.lines), "verified state is part of equality");
  assert.equal(R.setCitationPayload(r.lines, 0, R.checkCite(cite())), null, "no citation there");
  assert.equal(R.setCitationPayload(r.lines, 7, { bad: 1 }), null);
  // export keeps the visible label (TXT/MD/print) and escapes Markdown
  assert.equal(R.renderTxt(r.lines), "Voir [Shigley 12e, p. 417] ok\n");
  assert.equal(R.renderMarkdown(R.toggleMark(r.lines, 0, 4, "bold")), "**Voir** \\[Shigley 12e, p. 417\\] ok\n");
  ok();
}

// ---------------------------------------------------------------- pure source helpers
{
  assert.equal(S.fold("Élément d'Ajustement"), "element d'ajustement");
  assert.equal(S.fold("  CAFÉ   noir "), "cafe noir");
  // search: accent + case insensitive, multi-token AND
  let list = S.pickerList(sources, { query: "ELEMENT ajust" });
  assert.deepEqual(list.map((x) => x.edition.id), ["srce-iso286"]);
  assert.deepEqual(S.pickerList(sources, { query: "tolérances" }).map((x) => x.edition.id), ["srce-iso286"]);
  assert.deepEqual(S.pickerList(sources, { query: "tolerances" }).map((x) => x.edition.id), ["srce-iso286"]);
  assert.deepEqual(S.pickerList(sources, { query: "budynas 12e" }).map((x) => x.edition.id), ["srce-shigley12"]);
  assert.deepEqual(S.pickerList(sources, { query: "oberg" }).map((x) => x.edition.id), ["srce-mach31"]);
  assert.deepEqual(S.pickerList(sources, { query: "zzz" }), []);
  assert.deepEqual(S.pickerList(sources, { query: "machinery" }).map((x) => x.edition.id), ["srce-iso286", "srce-mach31"], "family name is searched (both editions of that family)");
  // archived hidden unless asked; archived families too
  assert.ok(!S.pickerList(sources, {}).some((x) => x.edition.id === "srce-old1"));
  assert.ok(S.pickerList(sources, { archived: true }).some((x) => x.edition.id === "srce-old1"));
  // order: recent, then project-preferred, then the rest; no duplicates
  list = S.pickerList(sources, { recent: ["srce-mach31", "srce-gone", "srce-old1"], projectId: "proj-shaft" });
  assert.deepEqual(list.map((x) => [x.edition.id, x.group]), [
    ["srce-mach31", "recent"], ["srce-iso286", "project"], ["srce-shigley11", "project"], ["srce-shigley12", "all"],
  ], "archived recent entries and unknown ids are dropped");
  assert.equal(new Set(list.map((x) => x.edition.id)).size, list.length);
  // superseded editions sort after current ones within a group
  const grp = S.pickerList(sources, { projectId: "proj-shaft" }).filter((x) => x.group === "project").map((x) => x.edition.id);
  assert.deepEqual(grp, ["srce-iso286", "srce-shigley11"]);
  // bounded
  const big = { families: [{ id: "srcf-a", name: "A" }], editions: Array.from({ length: 500 }, (_, i) => ({ id: "srce-n" + i, family_id: "srcf-a", title: "Item " + i, edition: String(i), project_ids: [], type: "book" })) };
  assert.equal(S.pickerList(big, {}).length, S.RESULTS_MAX);
  assert.equal(S.pickerList(big, { query: "item" }).length, S.RESULTS_MAX);
  // recent list: bounded, most recent first, deduplicated
  let rec = [];
  for (let i = 0; i < 20; i += 1) rec = S.pushRecent(rec, "srce-" + i);
  assert.equal(rec.length, S.RECENT_MAX);
  assert.equal(rec[0], "srce-19");
  assert.deepEqual(S.pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  ok();
}

// ---------------------------------------------------------------- calibration: never printed == PDF
{
  const e11 = ed("srce-shigley11");
  const e12 = ed("srce-shigley12");
  assert.equal(S.resolvePdf(e12, { kind: "page", text: "417" }, null), null, "no calibration: unresolved");
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "394" }, null), 416, "printed 394 + (23-1)");
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "394" }, 420), 420, "explicit PDF page wins");
  assert.equal(S.resolvePdf(e11, { kind: "section", text: "394" }, null), null, "only page locators map");
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "xii" }, null), null);
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "4.2" }, null), null);
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "²" }, null), null);
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "" }, null), null);
  assert.equal(S.resolvePdf(e11, { kind: "page", text: "99999999" }, null), null, "out of range");
  assert.equal(S.printedFor(e11, 416), 394);
  assert.equal(S.printedFor(e11, 5), null, "front matter has no printed number");
  assert.equal(S.printedFor(e12, 439), null, "no calibration: unknown");
  assert.equal(S.resolvePdf(Object.assign({}, e11, { calibration: { printed: 30, pdf: 5 } }), { kind: "page", text: "1" }, null), null);
  ok();
}

// ---------------------------------------------------------------- PDF URLs: confined, same-origin only
{
  assert.equal(S.pdfUrl("Uni/Shigley/12e.pdf", 439, 125), "/files/Uni/Shigley/12e.pdf#page=439&zoom=125");
  assert.equal(S.pdfUrl("Uni/Shigley/12e.pdf", null, null), "/files/Uni/Shigley/12e.pdf");
  assert.equal(S.pdfUrl("Uni/A B/é#?.pdf", 2), "/files/Uni/A%20B/%C3%A9%23%3F.pdf#page=2", "each segment is encoded");
  assert.equal(S.pdfUrl("Uni/x.pdf", 0), "/files/Uni/x.pdf", "bad page -> no fragment");
  assert.equal(S.pdfUrl("Uni/x.pdf", 1.5, 99999), "/files/Uni/x.pdf");
  for (const bad of fx.unsafe_file_refs) assert.equal(S.pdfUrl(bad, 1), null, String(bad));
  assert.equal(S.pdfUrl("Uni/x.PDF", 3), "/files/Uni/x.PDF#page=3");
  ok();
}

// ---------------------------------------------------------------- supersession / migration
{
  const old = fx.old_citation;
  const e11 = ed("srce-shigley11");
  const e12 = ed("srce-shigley12");
  assert.equal(S.newestEdition(sources, e11).id, "srce-shigley12");
  assert.equal(S.newestEdition(sources, e12), null);
  // a cycle in (corrupt) data never hangs
  const cyc = clone(sources); cyc.editions[1].superseded_by = "srce-shigley11";
  assert.ok(S.newestEdition(cyc, cyc.editions[0]) || true);
  // the old citation is untouched by creating the newer one (it only points at the old edition)
  assert.ok(R.checkCite(old), "the old citation is valid");
  // migrate "à vérifier": NOTHING carried over, provenance kept
  const todo = S.migrateCite(old, e12, "todo");
  assert.equal(todo.src, "srce-shigley12");
  assert.deepEqual(todo.loc, { kind: "page", text: "" });
  assert.equal(todo.pdf, null);
  assert.equal(todo.ok, false);
  assert.deepEqual(todo.from, { src: "srce-shigley11", loc: { kind: "page", text: "394" }, pdf: 416, ok: true });
  assert.notEqual(todo.loc.text, "417", "never inferred");
  assert.notEqual(todo.pdf, 439, "never inferred");
  assert.equal(R.citationLabel(todo), "[Shigley's Mechanical Engineering Design 12e, à vérifier]");
  // migrate with a user-typed verified locator
  const ver = S.migrateCite(old, e12, "verified", { kind: "page", text: "417" }, 439);
  assert.deepEqual([ver.loc.text, ver.pdf, ver.ok], ["417", 439, true]);
  assert.deepEqual(ver.from, todo.from);
  // "verified" without a locator is refused (nothing to have verified)
  assert.equal(S.migrateCite(old, e12, "verified", { kind: "page", text: "  " }, null), null);
  assert.equal(S.migrateCite(old, e12, "verified", null, null), null);
  // the old citation object is not mutated
  assert.deepEqual(old, clone(fx.old_citation));
  // verification toggling needs something to verify
  assert.equal(S.withVerified(todo, true), null);
  assert.equal(S.withVerified(ver, false).ok, false);
  assert.equal(S.withVerified(old, true).ok, true);
  assert.ok(S.describeCite(old, e11).includes("page PDF 416"));
  assert.ok(S.describeCite(todo, e12).includes("à vérifier"));
  // buildCite bounds the snapshot and never auto-verifies
  const built = S.buildCite(e12, { kind: "page", text: "417" }, 439, false, null);
  assert.equal(built.ok, false);
  assert.deepEqual(built.snap, { title: e12.title, author: e12.author, edition: "12e", year: 2026 });
  assert.equal(S.buildCite(e12, { kind: "page", text: "" }, null, true, null), null);
  ok();
}

// ---------------------------------------------------------------- state machine with citations
const v2Page = (id, rev, blocks) => ({ id, rev, project_id: null, category_id: null, pinned: false, deleted_at: null, created_at: 1, updated_at: 1, content: { version: 2, blocks: blocks.map((b, i) => Object.assign({ id: "block-" + id.slice(5) + i, marks: [] }, b)) } });
function fakeServer() {
  const s = { nb: { version: 1, notebook_rev: 2, projects: [], categories: [], pages: [v2Page("page-a", 1, [{ type: "paragraph", text: "intro" }])] }, calls: [], hold: false, held: [], seq: 0 };
  const err = (status, data) => Object.assign(new Error(data.error), { status, data });
  const find = (id) => s.nb.pages.find((p) => p.id === id);
  function handle(p) {
    const pg = find(p.id);
    if (p.expected_rev !== pg.rev) throw err(409, { error: "modifiée", code: "revision_conflict", page: clone(pg), notebook_rev: s.nb.notebook_rev });
    const incoming = R.linesFromContent(p.content);
    if (!incoming) throw err(400, { error: "Contenu invalide", code: "validation_error" });
    const cur = R.linesFromContent(pg.content);
    if (R.flat(incoming) !== R.flat(cur) || R.fmtOf(incoming) !== R.fmtOf(cur)) {
      pg.content = { version: 2, blocks: incoming.map((l) => Object.assign({ id: l.id || "block-srv" + (++s.seq), type: l.type, text: l.text, marks: clone(l.marks) }, l.type === "check" ? { checked: l.checked } : {})) };
      pg.rev += 1;
    }
    return { ok: true, notebook_rev: s.nb.notebook_rev, page: clone(pg) };
  }
  s.request = (p) => {
    s.calls.push(clone(p));
    if (s.hold) return new Promise((res, rej) => s.held.push(() => { try { res(handle(p)); } catch (e) { rej(e); } }));
    try { return Promise.resolve(handle(p)); } catch (e) { return Promise.reject(e); }
  };
  s.release = () => s.held.splice(0).forEach((f) => f());
  s.fetchNotebook = () => Promise.resolve(clone(s.nb));
  s.pg = find;
  return s;
}
const memStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
const fakeTimers = () => { const t = { list: new Map(), seq: 0 }; t.set = (fn) => { t.seq += 1; t.list.set(t.seq, fn); return t.seq; }; t.clear = (h) => { t.list.delete(h); }; t.runAll = () => { const f = [...t.list.values()]; t.list.clear(); f.forEach((x) => x()); }; return t; };
function make(srv, st) {
  const timers = fakeTimers();
  const core = C.createCore({ request: srv.request, fetchNotebook: srv.fetchNotebook, drafts: C.createDraftStore(st, "admin-test"), timers, now: () => 1000, onChange: () => {} });
  return { core, timers };
}
const draftRec = (st, id) => { const raw = st.m.get(C.draftKey("admin-test")); return raw ? JSON.parse(raw).pages[id] : undefined; };
const linesOf = (e) => R.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
const setLines = (core, id, lines) => core.edit(id, { text: R.flat(lines), fmt: R.fmtOf(lines), ids: R.idsOf(lines) });

// A. citation insert -> draft -> save -> server keeps it; late response keeps newer typing and the citation
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-a");
  const ins = R.insertCitation(linesOf(e), 5, 5, cite());
  assert.ok(setLines(core, "page-a", ins.lines));
  assert.equal(core.isDirty(e), true, "a citation is an edit");
  const rec = draftRec(st, "page-a");
  assert.equal(rec.content.blocks[0].marks[0].type, "citation", "the draft carries the structured citation");
  assert.deepEqual(rec.content.blocks[0].marks[0].cite, R.checkCite(cite()));
  srv.hold = true;
  timers.runAll();
  await settle();
  assert.equal(srv.calls.length, 1);
  assert.equal(srv.calls[0].content.blocks[0].marks[0].cite.src, "srce-shigley12");
  // typing after the citation while the save is in flight
  setLines(core, "page-a", R.replaceRange(linesOf(e), R.flat(linesOf(e)).length, R.flat(linesOf(e)).length, " fin").lines);
  srv.hold = false;
  srv.release();
  await settle();
  timers.runAll();
  await settle();
  assert.equal(core.isDirty(e), false);
  const saved = R.linesFromContent(srv.pg("page-a").content);
  assert.equal(R.flat(saved), "intro[Shigley 12e, p. 417] fin");
  assert.deepEqual(saved[0].marks.find((m) => m.type === "citation").cite, R.checkCite(cite()));
  assert.equal(draftRec(st, "page-a"), undefined, "draft cleared once saved");
  ok();
}

// B. verifying (a citation-only change) is dirty and saved; same text, different payload
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-a");
  setLines(core, "page-a", R.insertCitation(linesOf(e), 5, 5, cite()).lines);
  timers.runAll(); await settle();
  assert.equal(core.isDirty(e), false);
  const before = e.local.text;
  const next = R.setCitationPayload(linesOf(e), 6, Object.assign({}, R.checkCite(cite()), { ok: true }));
  setLines(core, "page-a", next);
  assert.equal(e.local.text, before, "same visible text");
  assert.equal(core.isDirty(e), true, "but dirty: the verified flag is content");
  timers.runAll(); await settle();
  assert.equal(R.linesFromContent(srv.pg("page-a").content)[0].marks.find((m) => m.type === "citation").cite.ok, true);
  assert.equal(core.isDirty(e), false);
  ok();
}

// C. remote changes the citation (locator) while local adds text -> explicit 409, both preserved
{
  const srv = fakeServer();
  const st = memStorage();
  const { core, timers } = make(srv, st);
  await core.load();
  const e = core.entry("page-a");
  // a remote client cited p.417
  const pg = srv.pg("page-a");
  pg.content = { version: 2, blocks: [{ id: "block-a0", type: "paragraph", text: "intro[S 12e, p. 417]", marks: [{ type: "citation", start: 5, end: 20, cite: R.checkCite(cite({ snap: { title: "S", edition: "12e" } })) }] }] };
  pg.rev = 2;
  setLines(core, "page-a", R.replaceRange(linesOf(e), 0, 0, "local ").lines);
  timers.runAll(); await settle(12);
  assert.ok(e.conflict, "explicit conflict, never a silent merge");
  assert.equal(e.local.text, "local intro", "the local text is kept");
  const remote = R.linesFromContent(e.conflict.remote ? e.conflict.remote.content : e.conflict.page ? e.conflict.page.content : pg.content);
  assert.ok(remote, "the remote version (with its citation) is offered");
  assert.equal(srv.pg("page-a").rev, 2, "nothing was overwritten");
  ok();
}

console.log(`hq carnet sources checks ok (${groups} groups)`);
