// Behavioural check of the real hq.js tooltip controller with a minimal fake DOM (no jsdom in this repo).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const hqSource = readFileSync(new URL("../assets/hq.js", import.meta.url), "utf8");
const helpStart = hqSource.indexOf("  let helpTicket = 0;");
const helpEnd = hqSource.indexOf("  function jumpToSection(");
assert.ok(helpStart >= 0 && helpEnd > helpStart, "help controller block is present");
const controllerSource = hqSource.slice(helpStart, helpEnd);

class ClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach((name) => this.names.add(name)); }
  remove(...names) { names.forEach((name) => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
}

class El {
  constructor(tag, doc) {
    this.tagName = tag.toLowerCase();
    this.ownerDocument = doc;
    this.attrs = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this._text = "";
    this.hidden = false;
    this.style = {};
    this.classList = new ClassList();
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }
  get offsetWidth() { return 120; }
  get offsetHeight() { return 24; }
  getBoundingClientRect() { return { top: 100, left: 100, right: 160, bottom: 120, width: 60, height: 20 }; }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(selector) {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      if (part === "[data-help]") return this.hasAttribute("data-help");
      const ariaButton = part.match(/^button\[aria-label\](?::not\(\[data-help-skip\]\))?$/);
      if (!ariaButton) return false;
      if (this.tagName !== "button" || !this.hasAttribute("aria-label")) return false;
      return !part.includes(":not([data-help-skip])") || !this.hasAttribute("data-help-skip");
    });
  }
}

class FakeDocument {
  constructor() {
    this.body = new El("body", this);
    this.listeners = Object.create(null);
    this.activeElement = this.body;
  }
  createElement(tag) { return new El(tag, this); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  elementFromPoint() { return null; }
  all() {
    const walk = (node) => [node, ...node.children.flatMap(walk)];
    return walk(this.body);
  }
  getElementById(id) { return this.all().find((node) => node.id === id) || null; }
}

function runtime() {
  const doc = new FakeDocument();
  const timers = new Map();
  let nextTimer = 0;
  const setTimeout = (fn, ms) => {
    const id = String(++nextTimer);
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.fn();
    }
  };
  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
  };
  const sandbox = { window, document: doc, setTimeout, clearTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(`${controllerSource}\nglobalThis.__help = { setupHelp, helpTargetFrom, helpTextFor, hideHelp };`, sandbox);
  sandbox.__help.setupHelp();
  return {
    doc,
    api: sandbox.__help,
    runTimers,
    fire(type, target, extra = {}) {
      for (const handler of doc.listeners[type] || []) {
        handler({ target, relatedTarget: null, clientX: 10, clientY: 10, ...extra });
      }
    },
  };
}

function makeButton(doc, { aria, text = "", dataHelp = null, skip = false }) {
  const button = doc.createElement("button");
  button.setAttribute("type", "button");
  if (aria) button.setAttribute("aria-label", aria);
  if (dataHelp) button.setAttribute("data-help", dataHelp);
  if (skip) button.setAttribute("data-help-skip", "");
  button.textContent = text;
  doc.body.appendChild(button);
  return button;
}

function tooltipFor(doc) { return doc.getElementById("hq-help-tooltip"); }

function expectTooltip(r, target, text) {
  r.fire("pointerover", target);
  r.runTimers();
  const tip = tooltipFor(r.doc);
  assert.ok(tip, "tooltip element exists");
  assert.equal(tip.hidden, false, "tooltip is shown");
  assert.equal(tip.textContent, text, "tooltip carries the control's help text");
  assert.equal(tip.classList.contains("is-on"), true, "tooltip has its visible state");
  assert.equal(target.getAttribute("aria-describedby"), "hq-help-tooltip", "tooltip is described by the control");
  r.api.hideHelp();
}

function expectNoTooltip(r, target) {
  r.fire("pointerover", target);
  r.runTimers();
  const tip = tooltipFor(r.doc);
  assert.ok(!tip || tip.hidden, "no tooltip is shown");
  assert.equal(target.getAttribute("aria-describedby"), null, "control is not described by a hidden tooltip");
}

// The three Studio image controls are now labelled in the real template.
const studioSource = readFileSync(new URL("../assets/hq-forge-studio.js", import.meta.url), "utf8");
for (const marker of [
  'class="forge-storyboard-frame" data-sopen="${esc(image.id)}" aria-label="Ouvrir la prise ${index + 1}"',
  'class="forge-seance-image" data-sopen="${esc(image.id)}" aria-label="Ouvrir l\'image"',
  'class="forge-library-image" data-lopen="${esc(item.id)}" aria-label="Ouvrir l\'image : ${esc(clip(settings.prompt || "sans prompt", 60))}"',
]) {
  assert.ok(studioSource.includes(marker), "Studio image control keeps its accessible label: " + marker);
}

// Vault cards whose visible name/state already states the accessible name opt out explicitly.
const vaultSource = readFileSync(new URL("../assets/hq-forge-vault.js", import.meta.url), "utf8");
assert.ok(vaultSource.includes('button.setAttribute("data-help-skip", "")'), "vault card opts out of a duplicate tooltip");

const positive = [
  ["Forge gallery card", "Image générée · 1 024 × 1 024 · réf. abcd1234", "prompt du jour"],
  ["Forge seed tile", "Choisir la graine 42", "42"],
  ["Forge lineage node", "Dérivée, ouvrir", "Dérivée"],
  ["Forge brick action", "Ajouter la brique lumière au prompt", "lumière"],
  ["Forge vault move", "Monter Coffre perso", "Monter"],
  ["Robotique axis", "Base moins", "−"],
  ["Robotique PTZ", "Caméra vers le haut", "▲"],
  ["Robotique record step", "Monter cette pose", "↑"],
  ["Studio storyboard", "Ouvrir la prise 1", "01"],
  ["Studio séance image", "Ouvrir l'image", ""],
  ["Studio library image", "Ouvrir l'image : visage au chapeau", ""],
];

let r = runtime();
for (const [name, aria, text] of positive) {
  const target = makeButton(r.doc, { aria, text });
  assert.equal(r.api.helpTargetFrom(target), target, name + " is selected by the controller");
  assert.equal(r.api.helpTextFor(target), aria, name + " resolves its accessible name");
  expectTooltip(r, target, aria);
}

// A child span is the real hover target for symbol controls; closest() must find the button.
const ptz = makeButton(r.doc, { aria: "Caméra vers le bas" });
const ptzGlyph = r.doc.createElement("span");
ptzGlyph.textContent = "▼";
ptz.appendChild(ptzGlyph);
r.fire("pointerover", ptzGlyph);
r.runTimers();
assert.equal(tooltipFor(r.doc).textContent, "Caméra vers le bas", "a child span resolves to its labelled button");
r.api.hideHelp();

// Exact duplicate: the accessible name adds nothing to the visible label.
const exact = makeButton(r.doc, { aria: "Enregistrer", text: "Enregistrer" });
assert.equal(r.api.helpTargetFrom(exact), exact);
assert.equal(r.api.helpTextFor(exact), "", "exact duplicate has no tooltip text");
expectNoTooltip(r, exact);

// Two-character labels are not automatically symbols when the name is identical.
const twoChars = makeButton(r.doc, { aria: "OK", text: "OK" });
assert.equal(r.api.helpTextFor(twoChars), "", "identical two-character label has no tooltip text");
expectNoTooltip(r, twoChars);

// Punctuation/case only: still the same label, so no noise.
const nearDuplicate = makeButton(r.doc, { aria: "Coffre perso, ouvert", text: "Coffre perso Ouvert" });
assert.equal(r.api.helpTextFor(nearDuplicate), "", "punctuation/case duplicate has no tooltip text");
expectNoTooltip(r, nearDuplicate);

// Explicit opt-out wins even when the visible label is a symbol.
const skipped = makeButton(r.doc, { aria: "Fermer", text: "×", skip: true });
assert.equal(r.api.helpTargetFrom(skipped), null, "data-help-skip removes the control from tooltip lookup");
expectNoTooltip(r, skipped);

// Visible-only controls were never tooltip candidates.
const visibleOnly = makeButton(r.doc, { text: "Enregistrer" });
assert.equal(r.api.helpTargetFrom(visibleOnly), null, "visible-only control is not selected");

// An explicit data-help still wins over the accessible name.
const explicit = makeButton(r.doc, { aria: "Ouvrir", text: "Ouvrir", dataHelp: "Ouvrir le coffre affiché." });
assert.equal(r.api.helpTextFor(explicit), "Ouvrir le coffre affiché.");
expectTooltip(r, explicit, "Ouvrir le coffre affiché.");

console.log(`check_hq_dynamic_help: ok (${positive.length} dynamic labels; exact, two-character, near-duplicate and opt-out cases suppressed)`);
