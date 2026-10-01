// Carnet Stage 07 — engineering model in pure JS: safe calculator grammar + adversarial corpus, unit conversion,
// calc / measure / decision payload validation and exact-decimal tolerance verdicts (parity with Python through the
// shared vectors in tests/fixtures_carnet_eng.json), line model, draft encoding, exports.
// No browser, no server, no live data. The DOM, panels, stale-tool guards and task/link flows are covered by
// tests/visual_carnet_eng_playwright.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Eng = require("../assets/hq-carnet-eng.js");
const R = require("../assets/hq-carnet-rich.js");
const vectors = JSON.parse(readFileSync(new URL("./fixtures_carnet_eng.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
let groups = 0;
const ok = () => { groups += 1; };

// ---------------------------------------------------------------- calculator: accepted expressions
{
  const table = [
    ["1+2*3", "7"], ["(1+2)*3", "9"], ["2^3^2", "512"], ["-2^2", "-4"], ["2^-1", "0.5"], ["(-8)^2", "64"], ["--2", "2"], ["+5", "5"], ["-(-3)", "3"],
    ["1/3", "0.333333333333"], ["100/3", "33.3333333333"], ["10/4", "2.5"], ["0,5+0,25", "0.75"], ["0.1+0.2", "0.3"], ["0.1+0.2-0.3", "0"], ["0.1*3-0.3", "0"],
    ["12.5*(3+4)^2", "612.5"], ["2*(3+4)", "14"], ["1e3", "1000"], ["1E3", "1000"], ["1e+3", "1000"], ["1e-100", "1e-100"], ["10^100", "1e+100"],
    ["2^0.5", "1.41421356237"], ["0^0", "1"], ["5-5", "0"], ["((((1))))", "1"], [" 1 +  2 ", "3"], ["123456789*987654321", "1.21932631113e+17"],
    ["0.0000001*0.0000001", "1e-14"], ["2^3^-1", "1.25992104989"],
  ];
  for (const [input, want] of table) {
    const r = Eng.calculate(input);
    assert.ok(r.ok, input + " -> " + JSON.stringify(r));
    assert.equal(r.result, want, input);
    assert.ok(!/^-0($|\.)/.test(r.result), "never negative zero: " + input);
  }
  // the stored expression is normalised, never the raw text
  assert.equal(Eng.calculate("0,5  +\t0,25").expr, "0.5 + 0.25");
  assert.equal(Eng.calculate(" 1+1 ").expr, "1+1");
  // deterministic
  for (let i = 0; i < 5; i += 1) assert.equal(Eng.calculate("1/3").result, "0.333333333333");
  ok();
}

// ---------------------------------------------------------------- calculator: rejected expressions (code + visible message)
{
  const table = [
    ["", "empty"], ["   ", "empty"], ["1/0", "div0"], ["0^-1", "div0"], ["1/(2-2)", "div0"], ["2^1001", "exponent"], ["2^-1001", "exponent"], ["1e400", "range"], ["1e1000000", "range"],
    ["1e100*10", "range"], ["10^101", "range"], ["1e-101*1", "range"], ["1e-101", "range"], ["0.1^400", "range"], ["1e-50*1e-60", "range"], ["1e-60/1e60", "range"], ["2^1000", "range"],
    ["(-8)^0.5", "undefined"], ["(-8)^(1/3)", "undefined"],
    ["alert(1)", "bad_char"], ["a.b", "bad_char"], ["2×3", "bad_char"], ["１+１", "bad_char"], ["١٢", "bad_char"], ["0x10", "bad_char"], ["1__2", "bad_char"], ["sqrt(4)", "bad_char"], ["pi", "bad_char"],
    ["constructor", "bad_char"], ["__proto__", "bad_char"], ["this", "bad_char"], ["`1`", "bad_char"], ["1;2", "bad_char"], ["1\n+1", "bad_char"], ["1\u00002", "bad_char"], ["'1'", "bad_char"],
    ["{}", "bad_char"], ["[1]", "bad_char"], ["1=1", "bad_char"], ["1%2", "bad_char"], ["1!", "bad_char"], ["#1", "bad_char"], ["‮1", "bad_char"],
    ["2 3", "trailing"], ["2)", "trailing"], ["1 000", "trailing"], ["(1)(2)", "trailing"], ["2(3)", "trailing"],
    ["5.", "bad_number"], [".5", "bad_number"], ["1e", "bad_number"], ["1e3.5", "bad_number"], ["1.5.2", "bad_number"], ["9".repeat(31), "bad_number"], ["1,2,3", "bad_number"],
    ["3-", "syntax"], ["(2", "syntax"], ["1+", "syntax"], ["*2", "syntax"], ["2**3", "syntax"], ["2//3", "syntax"], ["2^^3", "syntax"], ["()", "syntax"], ["(", "syntax"], [")", "syntax"],
  ];
  for (const [input, code] of table) {
    const r = Eng.calculate(input);
    assert.equal(r.ok, false, "must be refused: " + JSON.stringify(input));
    assert.equal(r.code, code, JSON.stringify(input) + " -> " + r.code);
    assert.ok(typeof r.message === "string" && r.message.length > 0, "visible message for " + code);
  }
  assert.equal(Eng.calculate("1+".repeat(101) + "1").code, "too_long");
  assert.equal(Eng.calculate("(".repeat(40) + "1" + ")".repeat(40)).code, "depth");
  assert.equal(Eng.calculate("-".repeat(40) + "1").code, "depth");
  assert.equal(Eng.calculate("2^".repeat(40) + "1").code, "depth");
  assert.equal(Eng.calculate("1" + "*1".repeat(99)).ok, true, "a long but flat product is fine");
  assert.equal(Eng.calculate(5).code, "bad_char", "non-string input");
  assert.equal(Eng.calculate(null).ok, false);
  assert.equal(Eng.calculate({ toString: () => "1" }).ok, false);
  ok();
}

// ---------------------------------------------------------------- calculator: nothing is ever evaluated, nothing throws (fuzz)
{
  globalThis.__pwned = 0;
  const hostile = ["constructor.constructor('__pwned=1')()", "globalThis.__pwned=1", "1);__pwned=1;(1", "eval('1')", "Function('1')()", "({}).x", "`${1}`", "1//", "/*1*/1", "import('x')"];
  for (const h of hostile) assert.equal(Eng.calculate(h).ok, false, h);
  assert.equal(globalThis.__pwned, 0);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = "0123456789+-*/^().,eE \t xX_aé١１‮ \ud800";
  for (let i = 0; i < 4000; i += 1) {
    let s = "";
    const n = Math.floor(rnd() * 40);
    for (let j = 0; j < n; j += 1) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = Eng.calculate(s);
    assert.equal(typeof r.ok, "boolean");
    if (r.ok) {
      assert.ok(Number.isFinite(r.value), s);
      assert.ok(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-][0-9]{1,3})?$/.test(r.result), s + " -> " + r.result);
      assert.ok(/^[0-9+\-*/^().eE ]+$/.test(r.expr), "stored expression stays inside the ASCII alphabet: " + r.expr);
    }
  }
  ok();
}

// ---------------------------------------------------------------- conversions (curated set, exact rational constants)
{
  const table = [
    ["25.4", "mm", "in", "1.00"], ["1", "in", "mm", "30"], ["100", "N", "lbf", "20"], ["1", "lbf", "N", "4"], ["10", "N·m", "lb·ft", "7"], ["1", "lb·ft", "N·m", "1"],
    ["1", "bar", "psi", "10"], ["14.5", "psi", "bar", "1.00"], ["100", "°C", "°F", "212"], ["-40", "°F", "°C", "-40"], ["37", "°C", "°F", "99"], ["0", "°C", "°F", "32"],
    ["-273.15", "°C", "°F", "-459.67"], ["1", "kg", "lb", "2"], ["2.2046", "lb", "kg", "0.99999"], ["1234.5678", "mm", "in", "48.6050"], ["0.001", "mm", "in", "0.00004"],
  ];
  for (const [v, from, to, want] of table) {
    const r = Eng.convert(v, from, to);
    assert.ok(r.ok, v + from + " " + JSON.stringify(r));
    assert.equal(r.value, want, `${v} ${from} -> ${to}`);
  }
  for (const [v, from, to, code] of [["12", "mm", "N", "bad_pair"], ["12", "mm", "mm", "bad_pair"], ["12", "mm", "km", "bad_unit"], ["1e3", "mm", "in", "bad_value"], ["abc", "mm", "in", "bad_value"], ["", "mm", "in", "bad_value"], ["1,5", "mm", "in", "ok"]]) {
    const r = Eng.convert(v, from, to);
    if (code === "ok") assert.ok(r.ok, "comma is the decimal separator");
    else assert.equal(r.code, code, `${v} ${from}->${to}`);
  }
  for (const [text, unit, value] of [["25,4 mm", "mm", "25.4"], ["1 lb·ft", "lb·ft", "1"], ["10 N.m", "N·m", "10"], ["10 Nm", "N·m", "10"], ["3lbft", "lb·ft", "3"], ["-5 °C", "°C", "-5"]]) {
    const q = Eng.parseQuantity(text);
    assert.ok(q, text);
    assert.equal(q.unit, unit);
    assert.equal(q.value, value);
  }
  for (const bad of ["", "mm", "25", "25 furlongs", "1e3 mm", "25 mm extra", "2 5 mm"]) assert.equal(Eng.parseQuantity(bad), null, bad);
  // round trip within the printed precision
  const there = Eng.convert("12.3456", "mm", "in").value;
  assert.ok(Math.abs(Number(Eng.convert(there, "in", "mm").value) - 12.3456) < 0.01);
  ok();
}

// ---------------------------------------------------------------- conversions never manufacture precision
{
  const digits = (v) => v.replace(/^-/, "").replace(".", "").replace(/^0+/, "").length;
  // significance as the policy reads it: whole numbers' trailing zeros are placeholders, zeros after a decimal point count
  const sigOf = (t) => (t.includes(".") ? digits(t) : digits(t.replace(/0+$/, "")));
  const decimalsOf = (v) => (v.split(".")[1] || "").length;
  for (const [v, from, to, want] of [["1", "mm", "in", "0.04"], ["1", "lbf", "N", "4"], ["1.5", "mm", "in", "0.059"], ["25", "mm", "in", "0.98"], ["1.000", "in", "mm", "25.40"]]) {
    const r = Eng.convert(v, from, to);
    assert.equal(r.value, want, `${v} ${from}`);
    assert.ok(digits(r.value) <= Math.max(1, digits(v)) + 1, "at most the input's significant digits (+1 for a rounding carry)");
  }
  for (const [v, want] of [["0", "32"], ["37", "99"], ["37.5", "99.5"], ["36.85", "98.33"]]) {
    const r = Eng.convert(v, "°C", "°F");
    assert.equal(r.value, want, `°C ${v}`);
    assert.equal(decimalsOf(r.value), decimalsOf(v), "decimal places follow the input");
  }
  assert.equal(Eng.convert("98.6", "°F", "°C").value, "37.0");
  // whole-number trailing zeros are placeholders; zeros after an explicit decimal point are expressed precision
  for (const [v, want] of [["10", "0.4"], ["100", "4"], ["1200", "47"], ["1000", "40"], ["10.0", "0.394"], ["100.0", "3.937"], ["0.10", "0.0039"], ["105", "4.13"]]) {
    assert.equal(Eng.convert(v, "mm", "in").value, want, `${v} mm->in`);
  }
  assert.notEqual(Eng.convert("10", "mm", "in").value, Eng.convert("10.0", "mm", "in").value, "10 and 10.0 differ in expressed precision");
  assert.equal(Eng.convert("100", "N", "lbf").value, "20");
  // rounding across a power of ten must not add a digit
  for (const [v, from, to, want] of [["14.5", "psi", "bar", "1.00"], ["14.50", "psi", "bar", "0.9997"], ["9.99", "mm", "in", "0.393"], ["0.0999", "bar", "psi", "1.45"], ["99.96", "mm", "in", "3.935"], ["9.6", "mm", "in", "0.38"], ["0.396", "in", "mm", "10.1"], ["0.3937", "in", "mm", "10.00"], ["0.39", "in", "mm", "9.9"]]) {
    assert.equal(Eng.convert(v, from, to).value, want, `${v} ${from}->${to}`);
  }
  for (const v of ["0.5", "0.95", "0.995", "0.9995", "9.5", "99.5", "999.5", "1.98", "19.8", "198"]) {
    for (const [from, to] of [["mm", "in"], ["in", "mm"], ["N", "lbf"], ["lbf", "N"], ["bar", "psi"], ["psi", "bar"], ["kg", "lb"], ["lb", "kg"], ["N·m", "lb·ft"], ["lb·ft", "N·m"]]) {
      const r = Eng.convert(v, from, to);
      assert.ok(r.ok && sigOf(r.value) <= Math.max(1, Math.min(6, sigOf(v))), `${v} ${from}->${to}: ${r.value}`);
    }
  }
  ok();
}

// ---------------------------------------------------------------- shared vectors: payload validation
{
  for (const p of vectors.calc_ok) assert.deepEqual(Eng.checkPayload("calc", p), p);
  for (const c of vectors.calc_bad) assert.equal(Eng.checkPayload("calc", c.payload), null, "calc: " + c.label);
  for (const p of vectors.measure_ok) assert.deepEqual(R.engPayload("measure", p), p, JSON.stringify(p));
  for (const c of vectors.measure_bad) assert.equal(R.engPayload("measure", c.payload), null, "measure: " + c.label);
  for (const c of vectors.measure_bad_link) assert.equal(R.engPayload("measure", c.payload), null, "measure link: " + c.label);
  for (const p of vectors.decision_ok) assert.deepEqual(Eng.checkPayload("decision", p), p);
  for (const p of vectors.decision_bad) assert.equal(Eng.checkPayload("decision", p), null, JSON.stringify(p));
  // the clean copy never aliases the input
  const src = clone(vectors.measure_ok[0]);
  const out = R.engPayload("measure", src);
  out.observed.v = "999";
  assert.equal(src.observed.v, vectors.measure_ok[0].observed.v);
  ok();
}

// ---------------------------------------------------------------- shared vectors: exact-decimal verdicts + descriptions
{
  for (const c of vectors.evaluate) {
    const got = Eng.evaluate(c.measure);
    assert.deepEqual({ status: got.status, deviation: got.deviation, lo: got.lo, hi: got.hi }, c.expect, c.label);
  }
  for (const c of vectors.describe) {
    const text = c.kind === "calc" ? Eng.describeCalc(c.payload) : c.kind === "measure" ? Eng.describeMeasure(c.payload) : Eng.decisionLabel(c.payload);
    assert.equal(text, c.text, c.kind);
  }
  assert.equal(Eng.fmtTime(vectors.at), "2026-09-21 14:13 UTC");
  ok();
}

// ---------------------------------------------------------------- line model, draft encoding, content shape
{
  const calc = R.engLine("calc", vectors.calc_ok[1]);
  const meas = R.engLine("measure", vectors.measure_ok[0]);
  const dec = R.decisionLine("Choisir 316L", vectors.at);
  assert.ok(calc && meas && dec);
  assert.equal(R.engLine("calc", { expr: "x" }), null);
  assert.equal(R.decisionLine("a\nb", vectors.at), null);
  assert.equal(R.engLine("paragraph", {}), null);
  const lines = [R.newLine("avant", "paragraph", false, []), calc, meas, dec, R.newLine("", "paragraph", false, [])];
  R.ensureKeys(lines);
  const text = R.flat(lines);
  const fmt = R.fmtOf(lines);
  const ids = R.idsOf(lines);
  assert.equal(text, "avant\n\n\nChoisir 316L\n");
  const back = R.linesFromTextFmt(text, fmt, ids);
  assert.ok(back, "draft decodes");
  assert.deepEqual(back.map((l) => l.type), ["paragraph", "calc", "measure", "decision", "paragraph"]);
  assert.deepEqual(back[1].eng, vectors.calc_ok[1]);
  assert.deepEqual(back[2].eng, vectors.measure_ok[0]);
  assert.deepEqual(back[3].eng, { at: vectors.at });
  assert.equal(R.fmtOf(back), fmt, "fmt round trip is canonical");
  // tampered drafts are refused, never partially loaded
  const tampered = fmt.replace('"1 + 2"', '"alert(1)"');
  assert.notEqual(tampered, fmt, "the tamper pattern must hit the encoded calculation");
  assert.equal(R.linesFromTextFmt(text, tampered, ids), null);
  const withText = text.split("\n");
  withText[1] = "x";
  assert.equal(R.linesFromTextFmt(withText.join("\n"), fmt, ids), null, "an atom line must be empty");
  const content = R.contentFromLines(back);
  assert.equal(content.version, 2);
  assert.deepEqual(content.blocks[1].calc, vectors.calc_ok[1]);
  assert.equal(content.blocks[1].text, "");
  assert.deepEqual(content.blocks[1].marks, []);
  assert.deepEqual(content.blocks[3].decision, { at: vectors.at });
  const again = R.linesFromContent(content);
  assert.deepEqual(again.map((l) => l.eng), back.map((l) => l.eng));
  // caps: a draft over the per-page limits is refused as a whole (the server refuses the same content)
  const mkMany = (n, make) => {
    const l = [];
    for (let i = 0; i < n; i += 1) l.push(make());
    R.ensureKeys(l);
    return l;
  };
  const atoms50 = mkMany(50, () => R.engLine("calc", vectors.calc_ok[0]));
  const atoms51 = mkMany(51, () => R.engLine("calc", vectors.calc_ok[0]));
  assert.ok(R.linesFromTextFmt(R.flat(atoms50), R.fmtOf(atoms50), R.idsOf(atoms50)), "50 atoms fit");
  assert.equal(R.linesFromTextFmt(R.flat(atoms51), R.fmtOf(atoms51), R.idsOf(atoms51)), null, "51 atoms refused");
  const dec100 = mkMany(100, () => R.decisionLine("d", vectors.at));
  const dec101 = mkMany(101, () => R.decisionLine("d", vectors.at));
  assert.ok(R.linesFromTextFmt(R.flat(dec100), R.fmtOf(dec100), R.idsOf(dec100)), "100 decisions fit");
  assert.equal(R.linesFromTextFmt(R.flat(dec101), R.fmtOf(dec101), R.idsOf(dec101)), null, "101 decisions refused");
  ok();
}

// ---------------------------------------------------------------- editing primitives around atoms / decisions
{
  const mk = () => {
    const l = [R.newLine("one", "paragraph", false, []), R.engLine("calc", vectors.calc_ok[0]), R.newLine("two", "paragraph", false, []), R.decisionLine("Go", vectors.at)];
    R.ensureKeys(l);
    return l;
  };
  // typing at the very start of the atom line goes above it: the atom keeps its payload and id
  const lines = mk();
  const atomStart = R.lineStarts(lines)[1];
  const r = R.replaceRange(lines, atomStart, atomStart, "x");
  assert.equal(r.lines.filter((l) => l.type === "calc").length, 1);
  assert.deepEqual(r.lines.find((l) => l.type === "calc").eng, vectors.calc_ok[0]);
  assert.equal(r.lines.find((l) => l.type === "calc").text, "");
  // a selection covering the atom removes it with the range
  const del = R.replaceRange(lines, 0, R.lineStarts(lines)[2], "");
  assert.ok(!del.lines.some((l) => l.type === "calc"));
  // Enter at the end of a decision makes a plain paragraph, never a second decision
  const d = mk();
  const endOfDecision = R.flat(d).length;
  const split = R.splitAt(d, endOfDecision);
  const last = split.lines[split.lines.length - 1];
  assert.equal(last.type, "paragraph");
  assert.equal(last.eng, null);
  assert.equal(split.lines[split.lines.length - 2].type, "decision");
  // removing the decision status keeps the text
  const plain = R.setBlockType(d, endOfDecision, endOfDecision, "paragraph");
  assert.equal(plain[3].type, "paragraph");
  assert.equal(plain[3].text, "Go");
  assert.equal(plain[3].eng, null);
  // editing the text of a decision keeps its payload (time of decision)
  const edit = R.replaceRange(d, endOfDecision, endOfDecision, "!");
  assert.equal(edit.lines[3].text, "Go!");
  assert.deepEqual(edit.lines[3].eng, { at: vectors.at });
  // an atom can never become another block type or receive text
  const asHeading = R.setBlockType(lines, atomStart, atomStart, "heading");
  assert.equal(asHeading[1].type, "calc");
  ok();
}

// ---------------------------------------------------------------- exports (TXT / Markdown)
{
  const lines = [R.newLine("avant", "paragraph", false, []), R.engLine("calc", { expr: "12.5*(3+4)^2", result: "612.5", unit: "mm", at: vectors.at, v: 1 }), R.engLine("measure", vectors.measure_ok[0]), R.decisionLine("Go", vectors.at)];
  R.ensureKeys(lines);
  const txt = R.renderTxt(lines);
  assert.ok(txt.includes("[Calcul : 12.5*(3+4)^2 = 612.5 mm — 2026-09-21 14:13 UTC]"), txt);
  assert.ok(txt.includes("non certifié"));
  assert.ok(txt.includes("DÉCISION · 2026-09-21 14:13 UTC — Go"));
  const md = R.renderMarkdown(lines);
  assert.ok(md.includes("**DÉCISION · 2026-09-21 14:13 UTC** — Go"), md);
  assert.equal(R.renderTxt(lines), txt, "deterministic");
  ok();
}

// ---------------------------------------------------------------- HQ references (project kind added in Stage 07)
{
  assert.deepEqual(R.checkRef({ kind: "project", id: "proj-abc123" }), { kind: "project", id: "proj-abc123" });
  for (const bad of ["proj-", "proj-../x", "page-a", "proj-" + "a".repeat(65), "Proj-abc", ""]) assert.equal(R.checkRef({ kind: "project", id: bad }), null, bad);
  assert.equal(R.checkRef({ kind: "project", id: "proj-a", extra: 1 }), null);
  for (const bad of ["Uni/../x.pdf", "/etc/passwd", "Uni\\a.pdf", "Secret/a.pdf", "Uni/.hidden", "Uni/a:b.pdf", "Uni/a%2e.pdf"]) assert.equal(R.checkRef({ kind: "file", id: bad }), null, bad);
  ok();
}

// ---------------------------------------------------------------- the UI module loads headless and exposes only its entry points
{
  const Ui = require("../assets/hq-carnet-eng-ui.js");
  assert.equal(typeof Ui.mount, "function");
  assert.deepEqual(Ui.MENU.map((m) => m[0]), ["calc", "measure", "decision", "convert", "task", "link"]);
  for (const src of ["hq-carnet-eng-ui.js", "hq-carnet-eng.js"]) {
    const code = readFileSync(new URL("../assets/" + src, import.meta.url), "utf8");
    assert.ok(!/\binnerHTML\b|\binsertAdjacentHTML\b|\beval\s*\(|new\s+Function\s*\(|document\.write/.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), src + ": no HTML injection / eval");
  }
  ok();
}

// ---------------------------------------------------------------- the named adversarial probes of the spec, one by one
{
  for (const probe of ["globalThis", "process", "process.env", "require('fs')", "import", "import('x')", "fetch('/x')", "document", "document.cookie", "window", "window.location", "a[b]", "a['b']", "[]", "{}", "NaN", "Infinity", "-Infinity", "nan", "inf", "1e", "1e+", "1e-", "e5", "1ee5", "1e5e5", "0b101", "0o7", "1_000", "/*c*/1", "1//c", "1#c", "--", "1,,2", "1, 2", "1;", "1 ; 2", "\"1\"", "`1`", "'1'", "٠", "１", "1−"+"1", "1×2", "1÷2", "√4", "①", "1⁄" + "2", "1e٣"]) {
    const r = Eng.calculate(probe);
    assert.equal(r.ok, false, "must be refused: " + JSON.stringify(probe) + " -> " + JSON.stringify(r));
    assert.ok(["empty", "bad_char", "bad_number", "syntax", "trailing"].includes(r.code), probe + " -> " + r.code);
  }
  assert.equal(Eng.calculate("1," + "5").ok, true, "a single comma is a decimal separator (documented), never a sequence operator");
  assert.equal(Eng.calculate("1e" + "9".repeat(30)).ok, false);
  assert.equal(Eng.calculate("9".repeat(25)).code, "bad_number", "numeric token bound");
  assert.equal(Eng.calculate("9".repeat(24)).ok, true, "24 digits is exactly the token bound");
  assert.equal(Eng.calculate("0." + "0".repeat(30) + "1").code, "bad_number");
  assert.equal(Eng.calculate("2^1000").code, "range");
  assert.equal(Eng.calculate("2^1001").code, "exponent");
  assert.equal(Eng.calculate("1^1000").ok, true, "a huge-but-allowed exponent of 1 is cheap and exact");
  ok();
}

// ---------------------------------------------------------------- conversions: zero, very large, whitespace, case
{
  for (const [from, to] of [["mm", "in"], ["N", "lbf"], ["N·m", "lb·ft"], ["bar", "psi"], ["kg", "lb"]]) {
    assert.equal(Eng.convert("0", from, to).value, "0", `0 ${from} -> ${to}`);
    assert.ok(!/^-/.test(Eng.convert("-0", from, to).value), "never a negative zero");
    const neg = Eng.convert("-2.5", from, to);
    assert.ok(neg.ok && neg.value.charAt(0) === "-", `negative stays negative (${from})`);
    const back = Eng.convert(Eng.convert("100.000", from, to).value, to, from);
    assert.ok(back.ok && Math.abs(Number(back.value) - 100) < 0.5, `round trip ${from}: ${back.value}`);
  }
  assert.equal(Eng.convert("123456789", "mm", "in").value, "4860500");
  assert.equal(Eng.convert("0.00000001", "mm", "in").value, "0.0000000004");
  assert.equal(Eng.convert("0", "°F", "°C").value, "-18");
  assert.equal(Eng.convert("0", "°C", "°F").value, "32");
  assert.deepEqual(Eng.parseQuantity("  25,4   mm  "), { value: "25.4", unit: "mm" });
  assert.deepEqual(Eng.parseQuantity("25.4mm"), { value: "25.4", unit: "mm" });
  assert.deepEqual(Eng.parseQuantity("25.4 mm"), { value: "25.4", unit: "mm" });
  assert.equal(Eng.parseQuantity("25.4 MM"), null, "units are case-sensitive: no guessing");
  assert.equal(Eng.parseQuantity("1 N*m"), null);
  ok();
}

// ---------------------------------------------------------------- find/replace, title and the time one-tap around structured blocks
{
  const C = require("../assets/hq-carnet.js");
  const lines = [R.newLine("Go calcul", "paragraph", false, []), R.engLine("calc", vectors.calc_ok[1]), R.engLine("measure", vectors.measure_ok[0]), R.decisionLine("Go vite", vectors.at)];
  R.ensureKeys(lines);
  const before = clone(lines.map((l) => l.eng));
  const matches = R.findAll(lines, "go");
  assert.equal(matches.length, 2, "text of a paragraph and of a decision is searchable; atoms hold no searchable text");
  const replaced = R.replaceMatches(lines, matches, "Stop");
  assert.deepEqual(replaced.map((l) => l.text), ["Stop calcul", "", "", "Stop vite"]);
  assert.deepEqual(replaced.map((l) => l.eng), before, "find/replace never touches structured payloads");
  assert.deepEqual(replaced.map((l) => l.type), ["paragraph", "calc", "measure", "decision"]);
  assert.equal(R.findAll(lines, "612.5").length, 0, "payload values are not searchable text (no accidental rewrite)");
  assert.equal(R.findAll(lines, "alésage").length, 0);
  // title/preview come from text lines only (an atom line is empty)
  const flat = R.flat([R.engLine("calc", vectors.calc_ok[0]), R.decisionLine("Choisir 316L", vectors.at)]);
  assert.equal(C.deriveTitle(flat), "Choisir 316L");
  assert.equal(C.deriveTitle(R.flat([R.engLine("calc", vectors.calc_ok[0])])), C.UNTITLED);
  // the one-tap is deterministic for a fixed clock and uses the local time source
  assert.equal(C.timeMarker(new Date(2026, 8, 21, 7, 5)), "07:05 — ");
  assert.equal(C.timeMarker(new Date(2026, 0, 1, 0, 0)), "00:00 — ");
  assert.equal(C.timeMarker(new Date(2026, 11, 31, 23, 59)), "23:59 — ");
  ok();
}

// ---------------------------------------------------------------- HQ link exports never carry a URL or a path
{
  const l = R.newLine("projet fichier", "paragraph", false, [
    { type: "link", start: 0, end: 6, ref: { kind: "project", id: "proj-abc" } },
    { type: "link", start: 7, end: 14, ref: { kind: "file", id: "Inbox/sub/plan.pdf" } },
  ]);
  for (const out of [R.renderTxt([l]), R.renderMarkdown([l])]) {
    assert.equal(out, "projet fichier\n");
    assert.ok(!/Inbox|proj-|\/files\/|[A-Za-z]:\\|http/i.test(out), "export shows the link text only");
  }
  ok();
}

console.log(`check_hq_carnet_eng: ${groups} groups OK`);
