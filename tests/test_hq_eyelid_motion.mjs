// Eyelid motion test: extracts oralEyelidShift from hq-dangling-member.js
import fs from "fs";
const path = process.argv[2] || new URL("../assets/hq-dangling-member.js", import.meta.url);
const src = fs.readFileSync(path, "utf8");
const m = src.match(/\/\/ EYELID_SHIFT_BEGIN([\s\S]*?)\/\/ EYELID_SHIFT_END/);
if (!m) throw new Error("oralEyelidShift block missing");
const f = new Function(m[1] + "; return oralEyelidShift;")();
const T = 46, old = (d) => { const p = Math.min(1, Math.max(0, (d - 8) / 67)); return p >= 1 ? 0 : Math.round(-T * (1 - p * p * (3 - 2 * p))); };
const prog = (d) => Math.min(1, Math.max(0, (d - 8) / 67));
let fail = 0; const ok = (c, msg) => { if (!c) { fail++; console.error("FAIL", msg); } };
for (let d = 8.01; d <= 120; d += 0.37) ok(f(prog(d), T, false, 1) === old(d), "off-switch d=" + d);
for (const seed of [0.95, 1, 1.05, 0.5, 2]) {
  ok(f(0, T, true, seed) === -T, "open identity");
  for (let d = 75; d < 200; d += 1) ok(f(prog(d), T, true, seed) === 0, "closed identity/monotonic after lock d=" + d);
  for (let d = 8.01; d < 75; d += 0.05) {
    const v = f(prog(d), T, true, seed);
    ok(v >= -T - 2 && v <= 2, "overshoot bound d=" + d + " v=" + v);
    ok(Math.abs(v - old(d)) <= 6, "close to old curve d=" + d);
  }
}
if (fail) { console.error(fail + " failures"); process.exit(1); }
console.log("eyelid motion OK");
