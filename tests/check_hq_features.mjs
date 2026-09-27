import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hq = require("../assets/hq-features.js");

const entry = hq.paletteRecentEntry({
  kind: "terminal",
  id: "ipconfig",
  label: "Adresse IP",
  hint: "Commande",
  cmd: "powershell -EncodedCommand SECRET",
  command: "whoami",
  pin: "135790",
});
assert.deepEqual(Object.keys(entry).sort(), ["hint", "id", "kind", "label"]);
assert.equal(JSON.stringify(entry).includes("SECRET"), false);
assert.equal(JSON.stringify(entry).includes("whoami"), false);
assert.equal(JSON.stringify(entry).includes("135790"), false);

assert.equal(hq.paletteRecentEntry({ kind: "shell", id: "x", label: "x" }), null);
assert.equal(hq.paletteRecentEntry({ kind: "folder", id: "", label: "Inbox" }), null);

const noisy = [];
for (let i = 0; i < 12; i += 1) {
  noisy.push({ kind: "folder", id: "F" + i, label: "Dossier " + i, hint: "Dossier", cmd: "nope" });
}
noisy.push({ kind: "folder", id: "F0", label: "Dossier 0", hint: "Dossier" });
const capped = hq.sanitizeRecents(noisy, 6);
assert.equal(capped.length, 6);
assert.equal(capped[0].id, "F0");
assert.equal(JSON.stringify(capped).includes("nope"), false);
assert.equal(hq.sanitizeRecents([{ kind: "nope" }, null, "x"], 6).length, 0);
assert.equal(hq.sanitizeRecents("bad", 6).length, 0);

const grouped = hq.groupPaletteHits([
  { kind: "terminal", id: "ip", label: "Adresse IP" },
  { kind: "folder", id: "Inbox", label: "Inbox" },
  { kind: "scene", id: "study", label: "Mode étude" },
  { kind: "folder", id: "Uni", label: "Uni" },
  { kind: "unknown", id: "x", label: "x" },
]);
assert.deepEqual(grouped.map((group) => group.label), ["Dossiers", "Scènes", "Commandes"]);
assert.deepEqual(grouped[0].items.map((row) => row.hit.id), ["Inbox", "Uni"]);
assert.equal(grouped[0].items[0].index, 1);

const items = [
  { name: "zeta", type: "file", size: 10, mtime: 30 },
  { name: "alpha", type: "dir", size: 0, mtime: 10 },
  { name: "midi", type: "file", size: 50, mtime: 20 },
  { name: "beta", type: "dir", size: 0, mtime: 40 },
];
assert.deepEqual(hq.sortFolderItems(items, "name").map((item) => item.name), ["alpha", "beta", "midi", "zeta"]);
assert.deepEqual(hq.sortFolderItems(items, "recent").map((item) => item.name), ["beta", "alpha", "zeta", "midi"]);
assert.deepEqual(hq.sortFolderItems(items, "size").map((item) => item.name), ["alpha", "beta", "midi", "zeta"]);
assert.deepEqual(hq.sortFolderItems(items, "nope").map((item) => item.name), ["alpha", "beta", "midi", "zeta"]);
assert.equal(hq.filesSortMode("recent"), "recent");
assert.equal(hq.filesSortMode("evil"), "name");
assert.equal(hq.filesSortMode(null), "name");
for (const row of hq.sortFolderItems(items, "size")) {
  if (row.type !== "dir") break;
  assert.equal(row.type, "dir");
}
assert.ok(hq.sortFolderItems(items, "size").findIndex((item) => item.type !== "dir") > hq.sortFolderItems(items, "size").findIndex((item) => item.type === "dir"));

console.log("hq feature checks ok");
