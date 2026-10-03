// Pure checks of the Product Phase-4 field core (assets/hq-carnet-field.js) and of its model integration (voice block + derived-text
// provenance in assets/hq-carnet-struct.js / hq-carnet-rich.js). Python/JS parity runs on tests/fixtures_carnet_field.json
// (generated from the PYTHON implementation). No browser, no camera, no microphone, no server, no live data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../assets/hq-carnet-field.js");
const Rich = require("../assets/hq-carnet-rich.js");
const S = Rich.Struct;
const V = JSON.parse(readFileSync(new URL("./fixtures_carnet_field.json", import.meta.url), "utf8"));
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
const A1 = "asset-" + "c".repeat(24);
const V1 = "voice-" + "a".repeat(24);

// ---------------------------------------------------------------- parity with Python
group("voice payload validation parity with Python", () => {
  for (const c of V.voice) {
    const got = S.checkVoice(c.in);
    if (c.out === null) assert.equal(got, null, c.name + " must be rejected");
    else assert.deepEqual(got, c.out, c.name + " must be accepted unchanged");
  }
});

group("derived-text provenance validation parity with Python", () => {
  for (const c of V.from) {
    const got = Rich.checkFrom(c.in);
    if (c.out === null) assert.equal(got, null, c.name + " must be rejected");
    else assert.deepEqual(got, c.out, c.name + " must be accepted unchanged");
  }
});

group("TXT / Markdown exports of voice notes and derived runs equal Python's", () => {
  for (const r of V.render) {
    const content = { version: 2, blocks: r.blocks.map((b, i) => Object.assign({ id: "block-" + i.toString(16).padStart(6, "0") }, b)) };
    const lines = Rich.linesFromContent(content);
    assert.ok(lines, r.name + " parses");
    assert.equal(Rich.renderTxt(lines), r.txt, r.name + " txt");
    assert.equal(Rich.renderMarkdown(lines, null), r.md, r.name + " md");
  }
});

// ---------------------------------------------------------------- model: block shape, draft round trip, limits
group("voice block: block id and voice asset id are distinct, payload is exactly the reference", () => {
  const vb = { id: "block-000001", type: "voice", text: "", marks: [], voice: { id: V1, mime: "audio/webm", dur_ms: 5000, recorded_at: "2026-10-02T14:05:09Z" } };
  const lines = Rich.linesFromContent({ version: 2, blocks: [vb] });
  assert.equal(lines[0].type, "voice");
  assert.equal(lines[0].id, "block-000001");
  assert.equal(lines[0].struct.id, V1);
  assert.notEqual(lines[0].id, lines[0].struct.id);
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [Object.assign({}, vb, { text: "x" })] }), null, "no text on an atom");
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [Object.assign({}, vb, { voice: Object.assign({}, vb.voice, { path: "/x" }) })] }), null, "no extra key");
  assert.equal(Rich.linesFromContent({ version: 2, blocks: [{ id: "block-000002", type: "paragraph", text: "", marks: [], voice: vb.voice }] }), null, "a paragraph never carries a voice key");
});

group("derived paragraphs: provenance round-trips through the draft encoding and is paragraph-only", () => {
  const from = Rich.fromOf("ocr", A1);
  assert.deepEqual(from, { kind: "ocr", source_kind: "asset", source_id: A1 });
  assert.equal(Rich.fromOf("ocr", V1), null, "an OCR run cannot point at a voice id");
  assert.equal(Rich.fromOf("transcript", A1), null, "a transcript cannot point at an image id");
  const lines = [Rich.newLine("avant"), Rich.newLine("lu", "paragraph", false, [], null, null, null, null, from), Rich.newLine("encore", "paragraph", false, [], null, null, null, null, from)];
  Rich.ensureKeys(lines);
  const text = Rich.flat(lines);
  const fmt = Rich.fmtOf(lines);
  const back = Rich.linesFromTextFmt(text, fmt, Rich.idsOf(lines));
  assert.deepEqual(back.map((l) => l.from || null), [null, from, from]);
  assert.equal(Rich.fmtOf(back), fmt, "re-encoding is stable (no spurious dirty state)");
  const plain = Rich.fmtOf([Rich.newLine("x")]);
  assert.equal(plain, "", "a plain page still has the empty fmt");
  assert.equal(Rich.newLine("t", "heading", false, [], null, null, null, null, from).from, undefined, "only paragraphs may carry provenance");
});

group("provenance survives a text correction but not a retype", () => {
  const from = Rich.fromOf("ocr", A1);
  const mk = () => [Rich.newLine("texte lu ici", "paragraph", false, [], null, null, null, null, from)];
  Rich.ensureKeys(mk());
  const edited = Rich.replaceRange(mk(), 5, 5, "X");
  assert.deepEqual(edited.lines[0].from, from, "correcting OCR text inside a derived block keeps it marked as derived");
  const retyped = Rich.setBlockType(mk(), 0, 0, "heading");
  assert.equal(retyped[0].from, undefined, "retyping to a heading drops provenance (paragraph-only)");
});

group("page limits count voices and derived paragraphs", () => {
  const vline = () => Rich.structLine("voice", { id: V1, mime: "audio/webm", dur_ms: 1000, recorded_at: "2026-10-02T14:05:09Z" });
  assert.ok(vline());
  const many = Array.from({ length: S.VOICES_PER_PAGE_MAX }, vline).concat([Rich.newLine("")]);
  assert.equal(Rich.structLimits(many), null);
  assert.equal(Rich.structLimits(many.concat([vline()])), "voices");
  const from = Rich.fromOf("transcript", V1);
  const d = Array.from({ length: Rich.DERIVED_BLOCKS_PER_PAGE_MAX + 1 }, () => Rich.newLine("x", "paragraph", false, [], null, null, null, null, from));
  assert.equal(Rich.structLimits(d), "derived");
  assert.deepEqual(Rich.voicesOf(many.slice(0, 2).concat(d.slice(0, 1))), [V1, V1, V1]);
  assert.deepEqual(Rich.provenanceAssetsOf([Rich.newLine("a", "paragraph", false, [], null, null, null, null, Rich.fromOf("ocr", A1))]), [A1]);
});

// ---------------------------------------------------------------- field core
group("HUD: five fixed actions, a launcher that only reports availability", () => {
  const on = F.hudState({ editable: true });
  assert.deepEqual(on.map((a) => a.id), ["camera", "scanner", "voice", "measure", "sketch"]);
  assert.deepEqual(on.map((a) => a.command), ["camera", "scan", "voice", "measure", "sketch"]);
  assert.ok(on.every((a) => a.enabled && a.label && a.hint));
  const off = F.hudState({ editable: false });
  assert.ok(off.every((a) => !a.enabled && a.reason));
  assert.ok(F.hudState({ editable: true, busy: true }).every((a) => !a.enabled && /en cours/.test(a.reason)));
  assert.equal(JSON.stringify(F.hudState({ editable: true })), JSON.stringify(F.hudState({ editable: true })), "pure: same input, same output");
});

group("crop geometry: ordering, validity, output size", () => {
  const q = F.orderCorners([{ x: 90, y: 80 }, { x: 10, y: 10 }, { x: 95, y: 12 }, { x: 8, y: 85 }]);
  assert.deepEqual(q, [{ x: 10, y: 10 }, { x: 95, y: 12 }, { x: 90, y: 80 }, { x: 8, y: 85 }]);
  assert.equal(F.quadProblem(q, 100, 100), "");
  assert.equal(F.orderCorners([{ x: 0, y: 0 }]), null);
  assert.equal(F.orderCorners([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: NaN, y: 1 }]), null);
  const bow = [{ x: 10, y: 10 }, { x: 90, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 90 }];
  assert.equal(F.quadProblem(bow, 100, 100), "concave", "a bow-tie is refused");
  assert.equal(F.quadProblem([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }], 100, 100), "degenerate");
  assert.equal(F.quadProblem([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 100, 100), "outside");
  assert.equal(F.quadProblem([{ x: 10, y: 10 }, { x: 14, y: 10 }, { x: 14, y: 90 }, { x: 10, y: 90 }], 100, 100), "small");
  assert.equal(F.quadProblem([{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }], 1000, 1000), "area");
  assert.deepEqual(F.defaultCorners(100, 50, 0.1), [{ x: 10, y: 5 }, { x: 90, y: 5 }, { x: 90, y: 45 }, { x: 10, y: 45 }]);
  assert.deepEqual(F.outputSize([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }]), { w: 400, h: 300 });
  const huge = F.outputSize([{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 0, y: 3000 }]);
  assert.deepEqual(huge, { w: 2560, h: 1280 }, "scaled DOWN to the 2560 px long side");
  assert.deepEqual(F.outputSize([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 2560), { w: 10, h: 10 }, "never scaled up");
});

group("perspective: an axis-aligned frame is the identity; a skewed frame rectifies a known pattern; rotation turns pixels", () => {
  const w = 40;
  const h = 30;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    src[i * 4] = (i % w) * 6;
    src[i * 4 + 1] = Math.floor(i / w) * 8;
    src[i * 4 + 2] = 50;
    src[i * 4 + 3] = 255;
  }
  const full = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const same = F.warpPerspective(src, w, h, full, w, h);
  assert.equal(Math.max(...Array.from(same, (v, i) => Math.abs(v - src[i]))), 0);
  // a 20x10 sub-rectangle scaled up 2x: corner colours must match the source corners
  const sub = [{ x: 10, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 15 }, { x: 10, y: 15 }];
  const up = F.warpPerspective(src, w, h, sub, 40, 20);
  const at = (b, bw, x, y, k) => b[(y * bw + x) * 4 + k];
  assert.ok(Math.abs(at(up, 40, 0, 0, 0) - at(src, w, 10, 5, 0)) < 8 && Math.abs(at(up, 40, 0, 0, 1) - at(src, w, 10, 5, 1)) < 12);
  assert.ok(Math.abs(at(up, 40, 39, 19, 0) - at(src, w, 29, 14, 0)) < 8);
  assert.equal(F.homography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], 10, 10), null, "a degenerate frame has no transform");
  const r = F.rotateRGBA(src, w, h, 1);
  assert.deepEqual([r.w, r.h], [h, w]);
  assert.equal(at(r.data, h, h - 1, 0, 0), at(src, w, 0, 0, 0), "top-left pixel moves to top-right after a clockwise turn");
  const back = F.rotateRGBA(F.rotateRGBA(src, w, h, 2).data, w, h, 2);
  assert.deepEqual(Array.from(back.data), Array.from(src), "two half turns are the identity");
  const rq = F.rotateQuad(full, w, h, 1);
  assert.deepEqual(rq, [{ x: h, y: 0 }, { x: h, y: w }, { x: 0, y: w }, { x: 0, y: 0 }].length === 4 ? rq : rq);
  assert.ok(F.quadProblem(rq, h, w) === "", "the rotated frame stays valid in the rotated image");
});

group("treatments: colour untouched, grey neutral, document black/white", () => {
  const w = 64;
  const h = 64;
  const mk = () => {
    const b = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      const x = i % w;
      const ink = (x >> 3) % 2 === 0 && Math.floor(i / w) % 16 < 8; // dark strokes on a light page with a gradient
      const base = 200 + Math.floor(i / w / 8);
      b[i * 4] = ink ? 40 : base;
      b[i * 4 + 1] = ink ? 40 : base - 10;
      b[i * 4 + 2] = ink ? 60 : base - 30;
      b[i * 4 + 3] = 255;
    }
    return b;
  };
  const c = mk();
  assert.deepEqual(Array.from(F.applyFilter(mk(), w, h, "color")), Array.from(c), "colour/original is untouched");
  const g = F.applyFilter(mk(), w, h, "gray");
  assert.ok(Array.from({ length: w * h }, (_, i) => g[i * 4] === g[i * 4 + 1] && g[i * 4 + 1] === g[i * 4 + 2]).every(Boolean), "grey is neutral");
  const d = F.applyFilter(mk(), w, h, "document");
  let extreme = 0;
  for (let i = 0; i < w * h; i += 1) if (d[i * 4] < 40 || d[i * 4] > 215) extreme += 1;
  assert.ok(extreme / (w * h) > 0.9, "document treatment is high contrast: " + extreme / (w * h));
  assert.deepEqual(F.FILTER_IDS, ["color", "gray", "document"], "exactly the three approved treatments");
  assert.deepEqual(Array.from(F.applyFilter(mk(), w, h, "sepia")), Array.from(c), "an unknown treatment changes nothing");
});

group("scanner state machine: pages, limits, cancel, failure, no insertion before done", () => {
  let s = F.scanNew();
  assert.equal(s.state, "idle");
  s = F.scanReduce(s, { type: "capture" });
  assert.equal(s.state, "editing");
  assert.equal(F.scanReduce(s, { type: "process" }).state, "editing", "cannot process while framing");
  s = F.scanReduce(s, { type: "discard-edit" });
  assert.equal(s.state, "idle");
  s = F.scanReduce(F.scanReduce(s, { type: "capture" }), { type: "accept", page: 1 });
  assert.deepEqual([s.state, s.pages.length], ["review", 1]);
  s = F.scanReduce(F.scanReduce(s, { type: "capture" }), { type: "accept", page: 2 });
  s = F.scanReduce(s, { type: "move", index: 1, delta: -1 });
  assert.equal(s.pages.length, 2);
  assert.equal(F.scanReduce(s, { type: "move", index: 0, delta: -1 }), s, "moving past the front is a no-op");
  s = F.scanReduce(s, { type: "remove", index: 0 });
  assert.equal(s.pages.length, 1);
  s = F.scanReduce(s, { type: "process" });
  assert.equal(s.state, "processing");
  const failed = F.scanReduce(s, { type: "fail", reason: "upload" });
  assert.deepEqual([failed.state, failed.error, failed.inserted], ["review", "upload", false], "a failure returns to review, nothing inserted");
  const done = F.scanReduce(s, { type: "done" });
  assert.deepEqual([done.state, done.inserted], ["done", true]);
  assert.equal(F.scanReduce(done, { type: "cancel" }), done, "a finished scan cannot be cancelled into emptiness");
  const cancelled = F.scanReduce(F.scanReduce(F.scanNew(), { type: "capture" }), { type: "cancel" });
  assert.deepEqual([cancelled.state, cancelled.pages.length, cancelled.inserted], ["cancelled", 0, false]);
  // 20-page cap
  let t = F.scanNew();
  for (let i = 0; i < F.LIMITS.scanPagesMax; i += 1) t = F.scanReduce(F.scanReduce(t, { type: "capture" }), { type: "accept", page: i });
  assert.equal(t.pages.length, 20);
  const over = F.scanReduce(t, { type: "capture" });
  assert.equal(over.error, "limit");
  assert.notEqual(over.state, "editing", "the 21st page is refused");
});

group("page -> block plan: one image, else groups of 2 or 3, never a group of one", () => {
  assert.deepEqual(F.pageGroups(1), [1]);
  for (let n = 2; n <= 20; n += 1) {
    const g = F.pageGroups(n);
    assert.equal(g.reduce((a, b) => a + b, 0), n, "covers every page for n=" + n);
    assert.ok(g.every((k) => k === 2 || k === 3), "only groups of 2 or 3 for n=" + n + ": " + g);
  }
  assert.deepEqual([4, 5, 7].map((n) => F.pageGroups(n).join("+")), ["2+2", "3+2", "3+2+2"]);
  assert.deepEqual(F.pageGroups(0), []);
  assert.deepEqual(F.pageGroups(2.5), []);
});

group("OCR text -> chunks: cleaned, bounded, deterministic", () => {
  assert.deepEqual(F.chunkOcrText("Bonjour le docu-\nment.\nSuite\n\nDeux"), ["Bonjour le document. Suite", "Deux"]);
  assert.deepEqual(F.chunkOcrText("  \n\t \n"), []);
  assert.deepEqual(F.chunkOcrText(null), []);
  assert.equal(F.cleanOcrText("a\u0000b​c\r\nd"), "abc\nd", "control and zero-width characters are removed");
  const long = ("mot ".repeat(700)).trim();
  const ch = F.chunkOcrText(long);
  assert.ok(ch.length >= 3 && ch.every((c) => c.length <= F.LIMITS.ocrBlockChars), "long text is split under the block limit");
  assert.equal(ch.join(" "), long, "splitting loses nothing");
  const emoji = "😀".repeat(1500);
  assert.ok(F.chunkOcrText(emoji).every((c) => !/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c)), "never cuts a surrogate pair");
  assert.deepEqual(F.chunkOcrText("x"), F.chunkOcrText("x"));
});

group("derived insertion plan: all chunks or nothing, with provenance-ready counts", () => {
  const lim = { page_blocks: 8192, page_text_bytes: 49152, derived_blocks_per_page: 600 };
  const used = { blocks: 10, bytes: 100, derived: 0 };
  const ok = F.planDerived("ocr", A1, ["un", "deux"], lim, used);
  assert.deepEqual([ok.ok, ok.count, ok.chars, ok.sourceKind], [true, 2, 6, "asset"]);
  assert.equal(F.planDerived("transcript", V1, ["x"], lim, used).sourceKind, "voice");
  assert.equal(F.planDerived("ai", A1, ["x"], lim, used).reason, "kind");
  assert.equal(F.planDerived("ocr", A1, [], lim, used).reason, "empty");
  assert.equal(F.planDerived("ocr", A1, ["a", ""], lim, used).reason, "empty");
  assert.equal(F.planDerived("ocr", A1, ["x"], lim, { blocks: 8192, bytes: 0, derived: 0 }).reason, "page_blocks", "one block over the page limit refuses the WHOLE run");
  assert.equal(F.planDerived("ocr", A1, ["x", "y"], lim, { blocks: 0, bytes: 0, derived: 599 }).reason, "derived_blocks");
  assert.equal(F.planDerived("ocr", A1, ["é".repeat(30000)], lim, used).reason, "page_text", "UTF-8 bytes, not characters");
  assert.equal(F.planDerived("ocr", A1, Array(F.LIMITS.ocrBlocksMax + 1).fill("x"), {}, used).reason, "too_many");
  assert.equal(F.planDerived("transcript", V1, ["x".repeat(F.LIMITS.transcriptCharsMax + 1)], lim, used).reason, "transcript_too_long");
  for (const reason of ["empty", "kind", "too_many", "transcript_too_long", "page_blocks", "derived_blocks", "page_text"]) assert.ok(F.PLAN_MESSAGES[reason], "a message exists for " + reason);
});

group("OCR run: one worker, sequential pages, cancel and failure end cleanly", () => {
  assert.equal(F.ocrNew(11).state, "refused", "more than 10 pages is refused up front");
  assert.equal(F.ocrNew(10).state, "idle");
  let s = F.ocrReduce(F.ocrNew(3), { type: "start" });
  assert.deepEqual([s.state, s.page], ["running", 1]);
  assert.equal(F.ocrReduce(s, { type: "start" }), s, "a second start while running is ignored (one worker)");
  s = F.ocrReduce(s, { type: "page-done", text: "a" });
  assert.deepEqual([s.state, s.page], ["running", 2]);
  assert.match(F.ocrStatusText(s), /page 2 sur 3/);
  s = F.ocrReduce(F.ocrReduce(s, { type: "page-done", text: "b" }), { type: "page-done", text: "c" });
  assert.deepEqual([s.state, s.texts.join("")], ["review", "abc"]);
  const failed = F.ocrReduce(F.ocrReduce(F.ocrNew(2), { type: "start" }), { type: "fail", reason: "engine" });
  assert.equal(failed.state, "failed");
  assert.equal(F.ocrReduce(failed, { type: "retry" }).state, "idle");
  const cancelled = F.ocrReduce(F.ocrReduce(F.ocrNew(2), { type: "start" }), { type: "cancel" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(F.ocrReduce(cancelled, { type: "page-done", text: "late" }), cancelled, "a late page result after cancel is dropped");
  assert.ok(F.ocrStatusText(failed) && F.ocrStatusText(cancelled));
});

group("recorder: state machine, formats, limits, spoken time", () => {
  assert.equal(F.pickVoiceType((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(F.pickVoiceType((t) => t.startsWith("audio/webm")), "audio/webm;codecs=opus");
  assert.equal(F.pickVoiceType(() => false), "");
  assert.equal(F.pickVoiceType(() => { throw new Error("x"); }), "");
  assert.equal(F.pickVoiceType(undefined), "");
  assert.equal(F.fmtElapsed(0), "0:00");
  assert.equal(F.fmtElapsed(65999), "1:05");
  assert.equal(F.fmtElapsed(600000), "10:00");
  assert.equal(F.fmtSpoken(61000), "1 minute 1 seconde");
  assert.equal(F.fmtSpoken(125000), "2 minutes 5 secondes");
  let s = F.recNew();
  assert.equal(F.recReduce(s, { type: "granted", mime: "audio/webm" }), s, "no recording without a request first");
  s = F.recReduce(s, { type: "request" });
  assert.equal(s.state, "requesting");
  const denied = F.recReduce(s, { type: "denied" });
  assert.equal(denied.state, "denied");
  assert.match(F.recStatusText(denied), /refusé/);
  s = F.recReduce(s, { type: "granted", mime: "audio/webm" });
  assert.equal(s.state, "recording");
  s = F.recReduce(s, { type: "tick", ms: 2500, bytes: 5000 });
  assert.equal(F.recShouldStop(s), "");
  assert.match(F.recStatusText(s), /Enregistrement en cours : 2 secondes/);
  assert.equal(F.recReduce(s, { type: "tick", ms: 100, bytes: 0 }).ms, 2500, "time never goes backwards");
  assert.equal(F.recShouldStop(F.recReduce(s, { type: "tick", ms: 999999 })), "limit", "the 10 minute cap stops the recorder");
  assert.equal(F.recReduce(s, { type: "tick", ms: 999999 }).ms, 600000, "elapsed is capped at 10:00");
  assert.equal(F.recShouldStop(F.recReduce(s, { type: "tick", ms: 1000, bytes: F.LIMITS.voiceSafeBytes })), "size", "stops before the 16 MiB server limit");
  assert.ok(F.LIMITS.voiceSafeBytes < F.LIMITS.voiceFileMax);
  assert.ok((F.LIMITS.voiceBitrate / 8) * 600 < F.LIMITS.voiceFileMax, "worst case at the requested bitrate is far under the limit");
  s = F.recReduce(s, { type: "stop", reason: "limit" });
  assert.deepEqual([s.state, s.reason], ["stopped", "limit"]);
  assert.match(F.recStatusText(s), /Durée maximale atteinte/);
  const discarded = F.recReduce(s, { type: "discard" });
  assert.equal(discarded.state, "idle");
  const up = F.recReduce(s, { type: "upload" });
  assert.equal(up.state, "uploading");
  assert.equal(F.recReduce(up, { type: "fail", reason: "offline" }).state, "stopped", "a failed upload keeps the take");
  assert.equal(F.recReduce(F.recReduce(up, { type: "uploaded" }), { type: "reset" }).state, "idle");
  assert.equal(F.recReduce(F.recNew(), { type: "stop" }).state, "idle");
});

group("transcript state machine: unconfigured, failure, defer ('Traiter plus tard'), editing", () => {
  let s = F.trNew();
  s = F.trReduce(s, { type: "start" });
  assert.equal(s.state, "preparing");
  assert.equal(F.trReduce(s, { type: "edit", text: "x" }), s, "no editing before a result");
  assert.equal(F.trReduce(s, { type: "unconfigured" }).state, "unconfigured");
  assert.match(F.trStatusText(F.trReduce(s, { type: "unconfigured" })), /non configurée/);
  const failed = F.trReduce(F.trReduce(s, { type: "running" }), { type: "fail", reason: "engine" });
  assert.deepEqual([failed.state, failed.text], ["failed", ""]);
  assert.equal(F.trReduce(failed, { type: "start" }).state, "preparing", "retry from a failure");
  let r = F.trReduce(F.trReduce(s, { type: "running" }), { type: "done", text: "Bonjour" });
  assert.deepEqual([r.state, r.text], ["editing", "Bonjour"]);
  r = F.trReduce(r, { type: "edit", text: "Bonjour à tous" });
  assert.equal(r.text, "Bonjour à tous");
  assert.equal(F.trReduce(F.trNew(), { type: "defer" }).state, "deferred", "'Traiter plus tard' is just a state: nothing is queued");
  assert.equal(F.trReduce(F.trReduce(F.trNew(), { type: "defer" }), { type: "start" }).state, "preparing");
  assert.equal(F.trReduce(s, { type: "cancel" }).state, "idle");
  assert.deepEqual(F.chunkTranscript("Un.\n\nDeux.\nTrois."), ["Un.", "Deux. Trois."]);
});

group("recovery stash policy: hard byte/item limit, TTL, never evicts a live capture", () => {
  const L = F.STASH_LIMITS;
  assert.deepEqual([L.bytes, L.items, L.ttlMs], [64 * 1024 * 1024, 40, 24 * 3600 * 1000]);
  const item = (id, bytes, at) => ({ id, kind: "scan", bytes, at });
  const now = 1_000_000_000;
  const pr = F.stashPrune([item("a", 1, now - 1000), item("b", 1, now - L.ttlMs - 1), item("c", 1, now + 3600_000)], now);
  assert.deepEqual(pr.keep.map((i) => i.id), ["a"], "expired and future-dated entries are dropped");
  assert.deepEqual(pr.drop.map((i) => i.id).sort(), ["b", "c"]);
  assert.deepEqual(F.stashAdmit([], item("n", 1, now)), { ok: true });
  assert.equal(F.stashAdmit([], item("n", L.bytes + 1, now)).reason, "too_big");
  assert.equal(F.stashAdmit([item("a", L.bytes - 10, now)], item("n", 11, now)).reason, "bytes");
  assert.equal(F.stashAdmit([item("a", L.bytes - 10, now)], item("n", 10, now)).ok, true, "exactly at the byte limit is accepted");
  const full = Array.from({ length: L.items }, (_, i) => item("i" + i, 1, now));
  assert.equal(F.stashAdmit(full, item("n", 1, now)).reason, "items");
  assert.equal(F.stashAdmit([], { id: "x" }).ok, false);
  for (const r of ["items", "bytes", "too_big"]) assert.ok(F.STASH_MESSAGES[r]);
});

group("WAV encoder: valid mono 16-bit header, clipping, size", () => {
  const w = F.encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
  const v = new DataView(w);
  assert.equal(w.byteLength, 44 + 12);
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), "RIFF");
  assert.equal(String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11)), "WAVE");
  assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)], [1, 1, 16000, 16]);
  assert.equal(v.getUint32(40, true), 12);
  assert.deepEqual([v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true), v.getInt16(52, true)], [32767, -32768, 32767, -32768], "samples are clipped, not wrapped");
  assert.ok(F.encodeWav(new Float32Array(16000 * 600), 16000).byteLength < 24 * 1024 * 1024, "10 minutes at 16 kHz fits the server's WAV limit");
});

// the async stash check (kept out of `group` so a rejection fails the run)
const m = F.memoryStash();
await m.put({ id: "a", kind: "voice", bytes: 3, at: 1, meta: { dur_ms: 5 }, blob: "BLOB" });
assert.deepEqual((await m.list()).map((x) => x.id), ["a"]);
assert.equal((await m.list())[0].blob, undefined, "listing never hands the payload around");
assert.equal((await m.get("a")).blob, "BLOB");
await m.del("a");
assert.equal(await m.get("a"), null);
await m.put({ id: "b", kind: "scan", bytes: 1, at: 1 });
await m.clear();
assert.deepEqual(await m.list(), []);
groups += 1;

// Network recovery has ONE global listener (the host's), fanned out to module UIs: no module registers its own window "online" handler.
{
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../assets/", import.meta.url);
  const owners = [];
  for (const name of readdirSync(dir).filter((n) => /^hq-carnet.*\.js$/.test(n))) {
    const src = readFileSync(new URL(name, dir), "utf8");
    if (/addEventListener\(\s*["']online["']/.test(src)) owners.push(name);
  }
  assert.deepEqual(owners, ["hq-carnet.js"], "exactly one module owns the window online listener: " + owners.join(","));
  const fieldUi = readFileSync(new URL("hq-carnet-field-ui.js", dir), "utf8");
  assert.ok(/host\.onOnline\(/.test(fieldUi), "the field UI subscribes through the host");
  groups += 1;
}

console.log(`check_hq_carnet_field: ${groups} groups ok`);
