// Keeps the growth report honest: the series log and the trait proof quoted in
// `docs/hq-playground-growth-report.md` must be what the current scripts print.
//
// `tests/play_hq_playground_series.mjs` is deterministic (fixed depth, a budget the search never reaches, no
// randomness), so a real drift means the reply-family or position rules changed behaviour — the report would then be
// quoting a trajectory the app no longer plays. Diffing catches both a changed engine and a stale report.
//
// `tests/play_hq_playground_growth.mjs` is deterministic in its traits but not in its scoreline: the search stops on a
// wall-clock budget, so a game can end one ply later and the points ladder shifts. Only the deterministic part is
// compared — the learners, the four traits, the born → stored numbers and the delta each row prints — which is exactly
// what the report's trait block claims.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPORT = join(ROOT, "docs", "hq-playground-growth-report.md");
const SERIES = join("tests", "play_hq_playground_series.mjs");
const GROWTH = join("tests", "play_hq_playground_growth.mjs");
const HEADING = /^##\s+Played series\b/;
const TRAIT_HEADING = /^###\s+Preuve hors page\b/;
const SERIES_GROWTH_HEADING = /^##\s+Croissance par séries\b/;

const lines = (text) => text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());

// The quoted block: the first fenced block under a heading, and nothing else.
function fencedBlock(markdown, heading, missing, unclosed) {
  const all = lines(markdown);
  const start = all.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(missing);
  const open = all.indexOf("```", start);
  if (open < 0) throw new Error(unclosed);
  const close = all.indexOf("```", open + 1);
  if (close < 0) throw new Error(unclosed);
  return all.slice(open + 1, close);
}

// The growth playout takes a quarter of an hour; it is run once and its output read three times, so the two blocks it
// feeds can never disagree with each other.
const cache = new Map();

function runScript(script, what) {
  if (cache.has(script)) return cache.get(script);
  try {
    const output = execFileSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", timeout: 5400000, stdio: ["ignore", "pipe", "pipe"] });
    cache.set(script, output);
    return output;
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    throw new Error(what + " a échoué" + (stderr ? " :\n" + stderr : ""));
  }
}

// Blank lines at the edges are layout, not trajectory: drop them on both sides before comparing.
function trimmed(list) {
  let first = 0;
  let last = list.length;
  while (first < last && !list[first].trim()) first += 1;
  while (last > first && !list[last - 1].trim()) last -= 1;
  return list.slice(first, last);
}

function firstDiff(quoted, produced) {
  const shared = Math.min(quoted.length, produced.length);
  for (let index = 0; index < shared; index += 1) {
    if (quoted[index] !== produced[index]) return { at: index, expected: quoted[index], actual: produced[index], length: shared };
  }
  if (quoted.length !== produced.length) {
    const at = shared;
    return {
      at: at,
      expected: at < quoted.length ? quoted[at] : "(fin du bloc du rapport)",
      actual: at < produced.length ? produced[at] : "(fin du script)",
      length: shared,
    };
  }
  return null;
}

// The trait proof, read as numbers rather than as layout: the report writes `(+0.040)`, `( 0.000)` and a French
// policy name, the script writes `(+0.000)` and the engine's own name. What has to match is the deterministic part —
// who learned against whom, and the born → stored value of each of her four traits — plus the delta each side prints,
// which must stay the difference of its own two numbers.
const TRAIT_ROW = /^\s*(bold|material|center|develop)\s+(-?\d+\.\d+)\s*→\s*(-?\d+\.\d+)\s*\(([+\-\s]?\d+\.\d+)\)\s*$/;
const LEARNER_HEAD = /^\s*([a-z]+)\s*\(\s*(\d+)\s+duels contre\s+([a-z]+)[,\s]+([a-zéèê]+)\s*\)\s*$/i;
const fixed = (value) => Number(value).toFixed(3);

function traitRows(list) {
  const rows = [];
  const problems = [];
  let learner = "";
  list.forEach((line) => {
    const head = LEARNER_HEAD.exec(line);
    if (head) {
      learner = head[1].toLowerCase();
      return;
    }
    const match = TRAIT_ROW.exec(line);
    if (!match || !learner) return;
    const [, trait, base, now, delta] = match;
    const gap = Math.abs(Number(delta) - (Number(now) - Number(base)));
    if (gap > 0.0006) problems.push(learner + " · " + trait + " : delta " + fixed(delta) + " ≠ " + fixed(Number(now) - Number(base)));
    rows.push(learner + " · " + trait + " · " + fixed(base) + " → " + fixed(now) + " · " + fixed(delta));
  });
  return { rows, problems };
}

function drifted(label, mismatch, hint) {
  const out = ["check_hq_playground_report: " + label, ""];
  out.push("première différence : ligne " + (mismatch.at + 1) + " du bloc cité dans le rapport");
  if (hint) out.push("  " + hint);
  out.push("");
  out.push("  rapport  : " + JSON.stringify(mismatch.expected));
  out.push("  script   : " + JSON.stringify(mismatch.actual));
  return out.join("\n");
}

let source;
try {
  source = readFileSync(REPORT, "utf8");
} catch (error) {
  console.error("check_hq_playground_report: rapport illisible : " + error.message);
  process.exit(1);
}

// 1. The played series: the whole log, line by line.
let quotedSeries;
try {
  quotedSeries = trimmed(fencedBlock(source, HEADING, "le rapport n'a plus sa section « Played series »", "la section « Played series » n'a plus de bloc de log refermé"));
} catch (error) {
  console.error("check_hq_playground_report: " + error.message);
  process.exit(1);
}
let producedSeries;
try {
  producedSeries = trimmed(lines(runScript(SERIES, "la série de parties")));
} catch (error) {
  console.error("check_hq_playground_report: " + error.message);
  process.exit(1);
}
if (!quotedSeries.length || !producedSeries.length) {
  console.error("check_hq_playground_report: la section « Played series » est vide");
  process.exit(1);
}
const seriesDiff = firstDiff(quotedSeries, producedSeries);
if (seriesDiff) {
  const context = [];
  for (let around = Math.max(0, seriesDiff.at - 2); around <= Math.min(seriesDiff.length - 1, seriesDiff.at + 1); around += 1) {
    context.push((around === seriesDiff.at ? "> " : "  ") + String(around + 1).padStart(3) + "  " + producedSeries[around]);
  }
  console.error(drifted("le log du rapport ne correspond plus à la série", seriesDiff, context.length ? context.join("\n") : ""));
  process.exit(1);
}

// 2. The trait proof: only its deterministic rows, the scoreline it also prints is allowed to move.
let quotedTraits;
try {
  quotedTraits = fencedBlock(source, TRAIT_HEADING, "le rapport n'a plus sa section « Preuve hors page »", "la section « Preuve hors page » n'a plus de bloc de traits refermé");
} catch (error) {
  console.error("check_hq_playground_report: " + error.message);
  process.exit(1);
}
let producedTraits;
try {
  producedTraits = lines(runScript(GROWTH, "la preuve de traits"));
} catch (error) {
  console.error("check_hq_playground_report: " + error.message);
  process.exit(1);
}
const reportTraits = traitRows(quotedTraits);
const scriptTraits = traitRows(producedTraits);
if (reportTraits.rows.length < 8 || scriptTraits.rows.length < 8) {
  console.error("check_hq_playground_report: la preuve de traits ne contient plus les huit lignes attendues (rapport "
    + reportTraits.rows.length + ", script " + scriptTraits.rows.length + ")");
  process.exit(1);
}
const traitProblems = reportTraits.problems.concat(scriptTraits.problems.map((row) => "script · " + row));
if (traitProblems.length) {
  console.error("check_hq_playground_report: une ligne de traits affiche un delta qui n'est pas sa propre différence\n\n  "
    + traitProblems.join("\n  "));
  process.exit(1);
}
const traitDiff = firstDiff(reportTraits.rows, scriptTraits.rows);
if (traitDiff) {
  console.error(drifted("la preuve de traits du rapport ne correspond plus à play_hq_playground_growth.mjs", traitDiff,
    "seuls les apprenants, les traits et leurs nombres sont comparés, pas la ligne de score"));
  process.exit(1);
}

// 3. The series growth: what the repeated pairing and the fixed yardstick print, line by line.
let quotedGrowth;
try {
  quotedGrowth = trimmed(fencedBlock(source, SERIES_GROWTH_HEADING, "le rapport n'a plus sa section « Croissance par séries »", "la section « Croissance par séries » n'a plus de bloc refermé"));
} catch (error) {
  console.error("check_hq_playground_report: " + error.message);
  process.exit(1);
}
// The script prints that block contiguously: the growth summary, then the yardstick after the series.
const producedAll = lines(runScript(GROWTH, "la croissance par séries"));
const growthStart = producedAll.findIndex((line) => line.startsWith("Croissance sur les séries"));
const growthEnd = producedAll.findIndex((line, index) => index > growthStart && line.startsWith("Après la série"));
const producedGrowth = growthStart < 0 ? [] : trimmed(producedAll.slice(growthStart, growthEnd < 0 ? producedAll.length : growthEnd));
if (!quotedGrowth.length || !producedGrowth.length) {
  console.error("check_hq_playground_report: la section « Croissance par séries » est vide");
  process.exit(1);
}
const growthDiff = firstDiff(quotedGrowth, producedGrowth);
if (growthDiff) {
  console.error(drifted("la croissance citée dans le rapport ne correspond plus au playout", growthDiff));
  process.exit(1);
}

console.log("check_hq_playground_report: ok (" + producedSeries.length + " lignes de série, "
  + scriptTraits.rows.length + " traits identiques au rapport, " + producedGrowth.length + " lignes de croissance)");
