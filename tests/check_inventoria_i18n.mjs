// Inventoria panel language layer: dictionary + server-label patterns + in-place translate / revert. Offline (no browser).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../assets/hq-inventoria-i18n.js", import.meta.url), "utf8");
const win = {};
vm.runInNewContext(source, { window: win, globalThis: win });
const I = win.HqInventoriaI18n;
assert.ok(I && typeof I.translate === "function", "the layer exposes translate()");

const cases = [
  ["Discuter", "Chat"],
  ["  À acheter ", "  To buy "],                                   // surrounding spaces survive (they are layout in this panel)
  ["Réglages", "Settings"],
  ["Ajuster Vis M3 de +16", "Adjust Vis M3 by +16"],
  ["Ajuster Lait de -1 (arrondi)", "Adjust Lait by -1 (arrondi)"],
  ["Acheté : Riz de +2", "Bought: Riz +2"],
  ["Créer Colle (×1) (sans emplacement)", "Create Colle (×1) (no place)"],
  ["Créer Colle (×2 kg) dans Atelier", "Create Colle (×2 kg) in Atelier"],
  ["Déplacer 3 article(s) vers sans emplacement", "Move 3 item(s) to no place"],
  ["Annuler : Ajuster Lait de -1", "Undo: Adjust Lait by -1"],    // nested: the undo label wraps another label
  ["Compter Vis : 4 → 31", "Count Vis: 4 → 31"],
  ["Cuisiné (Riz au lait) : Lait de -1000", "Cooked (Riz au lait): Lait by -1000"],
  ["Brouillon à vérifier — rien n'est appliqué (2 changements)", "Draft to review — nothing is applied (2 changes)"],
  ["Brouillon à vérifier — rien n'est appliqué (1 changement)", "Draft to review — nothing is applied (1 change)"],
  ["Appliqué en partie (1/2) : Brouillon impossible à appliquer", "Partly applied (1/2): The draft could not be applied"],
  ["Surveillances (0)", "Watches (0)"],
  ["Lait — alerte à 5 (actuel 3) ", "Lait — alert at 5 (now 3) "],
  ["Hello world", "Hello world"],                                  // already English: untouched
  ["", ""],
];
for (const [fr, en] of cases) assert.equal(I.translate(fr), en, JSON.stringify(fr));
assert.equal(I.translate(null), null, "non-strings pass through");
assert.ok(I.size() > 90, "the dictionary is not empty");

// ---- in place: text nodes and attributes are rewritten, chat messages are not, and French comes back on revert
class Node_ {
  constructor(type, props = {}) { Object.assign(this, { nodeType: type, children: [], attrs: {}, isConnected: true }, props); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  closest(sel) {
    const parts = sel.split(",").map((x) => x.trim());
    for (let n = this; n; n = n.parent) {
      if (n.nodeType !== 1) continue;
      if ((n.cls || []).some((c) => parts.includes("." + c)) || (n.tag && parts.includes(n.tag))) return n;
    }
    return null;
  }
  matches() { return false; }
  get parentElement() { return this.parent; }
}
const el = (cls = [], attrs = {}) => Object.assign(new Node_(1, { cls }), { attrs });
const text = (v, parent) => { const t = new Node_(3, { nodeValue: v }); t.parent = parent; parent.children.push(t); return t; };
const root = el();
const label = el([], { "aria-label": "Fermer" }); label.parent = root; root.children.push(label);
const tab = el(); tab.parent = root; root.children.push(tab);
const tabText = text("Discuter", tab);
const log = el(["hq-inventoria-thread-log"]); log.parent = root; root.children.push(log);
const chat = text("Discuter", log);                              // a user's own message that happens to match a label
const area = Object.assign(el([], { "aria-label": "Liste de courses à copier" }), { tag: "textarea" });
area.parent = root; root.children.push(area);
const areaText = text("Liste de courses à copier", area);             // the copyable list itself must stay as it is
root.ownerDocument = {
  createTreeWalker: (start) => {
    const flat = [];
    const go = (n) => { for (const c of n.children) { flat.push(c); go(c); } };
    go(start);
    let i = -1;
    return { nextNode: () => (++i < flat.length ? flat[i] : null) };
  },
};
for (const n of [label, tab, log]) n.ownerDocument = root.ownerDocument;
I.apply(root, "en");
assert.equal(tabText.nodeValue, "Chat", "a panel label is translated in place");
assert.equal(label.attrs["aria-label"], "Close", "attributes are translated too");
assert.equal(chat.nodeValue, "Discuter", "chat messages are never rewritten");
assert.equal(area.attrs["aria-label"], "Shopping list to copy", "a textarea's accessible name is translated");
assert.equal(areaText.nodeValue, "Liste de courses à copier", "but its content (the list you copy) is not");
I.apply(root, "fr");
assert.equal(tabText.nodeValue, "Discuter", "French is restored when the language flips back");
assert.equal(label.attrs["aria-label"], "Fermer", "attributes are restored too");
I.apply(root, "en");
I.onMutations([{ type: "characterData", target: tabText }], "fr");
assert.equal(tabText.nodeValue, "Chat", "mutations are ignored when the language is not English");

console.log("check_inventoria_i18n: ok (" + cases.length + " cases)");
