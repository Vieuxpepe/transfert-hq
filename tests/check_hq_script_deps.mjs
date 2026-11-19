// Load-time script dependencies between the page's own scripts. No browser, no server.
// hq-musica-chip.js does `var Beat = window.HqMusicaBeat;` while it loads: if the page never
// loads hq-musica-beat.js, the chip throws on the next line and the whole script is dead, with
// nothing to say why. Every module that reads another module's global at load time must find
// that script on the page, loaded before itself.
//
// The read must be a statement at the top of the file's IIFE (up to two spaces of indent, which is
// where a module body sits). Reads inside a function run later and do not need the provider first,
// so they are deliberately out of scope. `node tests/check_hq_script_deps.mjs --write-doc` rewrites
// docs/script-order.md from what it found.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const docFlag = "--write-doc";
const pageArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const pagePath = pageArg ? resolve(pageArg) : fileURLToPath(new URL("../iphone_bridge.py", import.meta.url));
const page = readFileSync(pagePath, "utf8");
const ASSETS = new URL("../assets/", import.meta.url);

// The browser provides these itself; no asset script has to define them.
const BROWSER_GLOBALS = new Set([
  "AbortController", "AbortSignal", "Audio", "AudioContext", "BroadcastChannel", "CustomEvent",
  "EventSource", "File", "FileReader", "Image", "IntersectionObserver", "MutationObserver",
  "Notification", "Option", "ReadableStream", "ResizeObserver", "SharedWorker", "SpeechSynthesisUtterance",
  "TextDecoder", "TextEncoder", "WebSocket", "Worker",
]);

// The page itself defines some globals in inline scripts (HQ_ASSET_BUILD, HQ_BOOT_REVISION, the lazy
// maps). Those are not an asset's to provide, so they are not a load-order constraint here.
const pageGlobals = new Set([...page.matchAll(/(?:window|self|globalThis)\.([A-Z]\w*)\s*=[^=]/g)].map((m) => m[1]));

const files = readdirSync(ASSETS).filter((name) => name.endsWith(".js"));
const sources = new Map(files.map((name) => [name, readFileSync(new URL(name, ASSETS), "utf8")]));

// A statement at the top of a file's IIFE: its `window.X` read runs as the script is evaluated.
// Covers `var|let|const name = window.X`, `window.X || {…}`, `window.X.method(…)` and a bare read.
const LOAD_TIME = /^ {0,2}(?:(?:var|let|const)\s+[\w$]+\s*=\s*)?window\.([A-Z][\w$]*)\s*(?:[;,=]|\|\||\?\?|\.|\(|$)/;
function loadTimeReads(text) {
  const names = new Set();
  for (const line of text.split("\n")) {
    const m = LOAD_TIME.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

const defines = (text, name) => new RegExp(`(?:root|window|self|globalThis)\\.${name}\\s*=[^=]`).test(text);

const seen = new Set();
const pairs = [];
for (const [consumer, text] of sources) {
  for (const name of loadTimeReads(text)) {
    if (BROWSER_GLOBALS.has(name) || pageGlobals.has(name)) continue;
    for (const [provider, providerText] of sources) {
      if (provider === consumer || !defines(providerText, name)) continue;
      const key = name + "|" + consumer + "|" + provider;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ name, consumer, provider });
    }
  }
}

// The incident this check exists for: keep the scan honest if its pattern ever stops matching.
const musica = pairs.find((p) => p.name === "HqMusicaBeat");
assert.ok(musica, "hq-musica-chip.js is expected to read window.HqMusicaBeat at load time");
assert.equal(musica.consumer, "hq-musica-chip.js");
assert.equal(musica.provider, "hq-musica-beat.js");

// Load order is: every static <script src> in document order, then the lazy loader's own list in its
// order (a lazy module only runs after the page has loaded). The provider must come earlier in that
// sequence; two lazy modules are ordered by the list, not by where their names appear in the page.
const staticTags = [...page.matchAll(/<script src="\/assets\/([^"?]+\.js)"/g)].map((m) => m[1]);
const lazyTags = [...page.matchAll(/\['([\w.-]+\.js)'\s*,/g)].map((m) => m[1]);
const sequence = [...staticTags, ...lazyTags.filter((n) => !staticTags.includes(n))];

for (const { name, consumer, provider } of pairs) {
  assert.notEqual(page.indexOf(consumer), -1, `${consumer} is not loaded by the page at all`);
  const providerAt = sequence.indexOf(provider);
  const consumerAt = sequence.indexOf(consumer);
  assert.notEqual(providerAt, -1, `${consumer} reads window.${name} at load time, but the page never loads ${provider}`);
  assert.notEqual(consumerAt, -1, `${consumer} is not loaded by the page at all (not in a <script src> tag nor the lazy list)`);
  assert.ok(providerAt < consumerAt, `${provider} must load before ${consumer}, which reads window.${name} as it loads`);
}

pairs.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
if (process.argv.includes("--list")) {
  for (const { name, consumer, provider } of pairs) console.log(`  window.${name}: ${provider} -> ${consumer}`);
}

if (process.argv.includes(docFlag)) {
  const rows = pairs.map(({ name, consumer, provider }) => `| \`window.${name}\` | \`${provider}\` | \`${consumer}\` | provider earlier in the page |`);
  const doc = [
    "# Script load order",
    "",
    "Generated by `node tests/check_hq_script_deps.mjs --write-doc` — do not edit by hand.",
    "",
    "These are the globals a page script reads **while it loads** (a statement at the top of its IIFE),",
    "so the page must load the provider earlier. A read inside a function runs later and is not listed.",
    "Adding a script that reads another module's global at load time means adding its tag after the",
    "provider and rerunning the generator.",
    "",
    "| Global | Defined by | Read at load time by | Constraint |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "Verification: `node tests/check_hq_script_deps.mjs`.",
    "",
  ].join("\n");
  writeFileSync(fileURLToPath(new URL("../docs/script-order.md", import.meta.url)), doc, "utf8");
  console.log(`check_hq_script_deps: docs/script-order.md written (${pairs.length} row${pairs.length === 1 ? "" : "s"})`);
} else {
  const lazy = pairs.filter((p) => !staticTags.includes(p.consumer)).length;
  console.log(`check_hq_script_deps: ok (${pairs.length} load-time dependenc${pairs.length === 1 ? "y" : "ies"}, ${lazy} from lazy modules)`);
}
