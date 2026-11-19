// A tiny, dependency-free DOM used to run the real chat chips under node.
// It implements only what the HQ chips touch: elements, attributes, classes,
// a conservative innerHTML parser, bubbling events, storage and fetch recording.
import vm from "node:vm";
import { readFileSync } from "node:fs";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
let serial = 0;

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function makeStyle() {
  const style = {
    setProperty(name, value) { style[name] = String(value); },
    removeProperty(name) { delete style[name]; },
    getPropertyValue(name) { return style[name] == null ? "" : String(style[name]); },
  };
  return style;
}

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.parentNode = null;
    this._text = String(text == null ? "" : text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v == null ? "" : v); }
  get childNodes() { return []; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get nextElementSibling() { return null; }
}

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || "").split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(" "); }
  add(...names) { const s = this._set(); names.forEach((n) => s.add(n)); this._write(s); }
  remove(...names) { const s = this._set(); names.forEach((n) => s.delete(n)); this._write(s); }
  contains(name) { return this._set().has(name); }
  toggle(name, force) {
    const s = this._set();
    const want = force === undefined ? !s.has(name) : !!force;
    if (want) s.add(name); else s.delete(name);
    this._write(s);
    return want;
  }
}

export class El {
  constructor(tag, doc) {
    this.ownerDocument = doc;
    this.tagName = String(tag || "div").toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this._uid = ++serial;
    this.id = "";
    this._className = "";
    this._text = "";
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = makeStyle();
    this.classList = new ClassList(this);
    this._listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.type = "";
    this.src = "";
    this.srcset = "";
    this.href = "";
    this.rel = "";
    this.title = "";
    this.placeholder = "";
    this.accept = "";
    this.rows = 0;
    this.maxLength = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }

  get className() { return this._className; }
  set className(v) { this._className = v == null ? "" : String(v); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.children.filter((n) => n.nodeType === 1);
    const at = list.indexOf(this);
    return at >= 0 ? list[at + 1] || null : null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.children.filter((n) => n.nodeType === 1);
    const at = list.indexOf(this);
    return at > 0 ? list[at - 1] : null;
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = v == null ? "" : String(v);
  }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get scrollWidth() { return this.scrollHeight; }
  get innerHTML() { return ""; }
  set innerHTML(v) { this.children = []; this._text = ""; parseHTML(this, String(v == null ? "" : v)); }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  prepend(...nodes) {
    const first = this.children[0] || null;
    nodes.forEach((n) => {
      const node = typeof n === "string" ? this.ownerDocument.createTextNode(n) : n;
      this.insertBefore(node, first);
    });
  }
  before(...nodes) { if (this.parentNode) nodes.forEach((n) => this.parentNode.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, this)); }
  after(...nodes) {
    if (!this.parentNode) return;
    const list = this.parentNode.children.filter((n) => n.nodeType === 1);
    const next = list[list.indexOf(this) + 1] || null;
    nodes.forEach((n) => this.parentNode.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, next));
  }
  replaceWith(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const next = this.nextElementSibling;
    parent.removeChild(this);
    nodes.forEach((n) => parent.insertBefore(typeof n === "string" ? parent.ownerDocument.createTextNode(n) : n, next));
  }
  appendChild(node) {
    if (node == null) return node;
    if (typeof node === "string") node = this.ownerDocument.createTextNode(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = this.children.indexOf(ref);
    node.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    nodes.forEach((n) => this.appendChild(n));
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) {
    let cur = node;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }

  setAttribute(name, value) {
    const v = String(value == null ? "" : value);
    this.attributes[name] = v;
    if (name === "id") this.id = v;
    else if (name === "class") this.className = v;
    else if (name === "hidden") this.hidden = true;
    else if (name === "disabled") this.disabled = true;
    else if (name === "value") this.value = v;
    else if (name === "title") this.title = v;
    else if (name === "type") this.type = v;
    else if (name.startsWith("data-")) this.dataset[camel(name.slice(5))] = v;
  }
  getAttribute(name) { return this.attributes[name] == null ? null : this.attributes[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  dispatchEvent(ev) {
    const e = ev || {};
    e.target = e.target || this;
    e.defaultPrevented = !!e.defaultPrevented;
    if (!e.preventDefault) e.preventDefault = () => { e.defaultPrevented = true; };
    if (!e.stopPropagation) e.stopPropagation = () => { e._stop = true; };
    let node = this;
    while (node) {
      e.currentTarget = node;
      const list = node._listeners && node._listeners.get(e.type);
      if (list) for (const fn of [...list]) fn.call(node, e);
      if (e._stop || e.bubbles === false) break;
      node = node.parentNode || null;
    }
    return !e.defaultPrevented;
  }
  click() { return this.dispatchEvent({ type: "click", bubbles: true }); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollIntoView() {}
  setSelectionRange() {}
  select() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight };
  }
  getClientRects() { return []; }
  // Deep copy of an element and its attributes, text and children (used by the nav to reuse a rail icon).
  cloneNode(deep) {
    const copy = new El(this.tagName, this.ownerDocument);
    copy.id = this.id;
    copy.className = this.className;
    copy.attributes = { ...this.attributes };
    copy.dataset = { ...this.dataset };
    copy._text = this._text;
    copy.hidden = this.hidden;
    copy.disabled = this.disabled;
    if (deep) {
      for (const child of this.children) {
        copy.appendChild(child.nodeType === 1 ? child.cloneNode(true) : this.ownerDocument.createTextNode(child.textContent));
      }
    }
    return copy;
  }
  animate() { return { cancel() {}, finished: Promise.resolve() }; }

  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return descendants(this).find((n) => matchesSelector(n, selector)) || null; }
  querySelectorAll(selector) { return descendants(this).filter((n) => matchesSelector(n, selector)); }
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.nodeType === 1) { out.push(child); walk(child); }
    }
  };
  walk(root);
  return out;
}

function parsePart(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  const part = { tag: null, id: null, classes: [], attrs: [] };
  s = s.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "");
  const attrRe = /\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let m;
  while ((m = attrRe.exec(s))) part.attrs.push([m[1].trim(), m[2]]);
  s = s.replace(attrRe, "");
  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch) part.id = idMatch[1];
  s = s.replace(/#[\w-]+/g, "");
  const classRe = /\.([\w-]+)/g;
  while ((m = classRe.exec(s))) part.classes.push(m[1]);
  s = s.replace(/\.[\w-]+/g, "");
  const tag = s.trim();
  if (tag && tag !== "*") part.tag = tag.toLowerCase();
  return part;
}

function matchesPart(el, part) {
  if (!part) return false;
  if (part.tag && el.tagName.toLowerCase() !== part.tag) return false;
  if (part.id && el.id !== part.id) return false;
  for (const c of part.classes) if (!el.classList.contains(c)) return false;
  for (const [name, value] of part.attrs) {
    if (!el.hasAttribute(name)) return false;
    if (value != null && value !== "" && el.getAttribute(name) !== value) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  const groups = String(selector).split(",");
  for (const group of groups) {
    const parts = group.trim().split(/\s+/).map(parsePart).filter(Boolean);
    if (!parts.length) continue;
    if (!matchesPart(el, parts[parts.length - 1])) continue;
    let at = parts.length - 2;
    let node = el.parentNode;
    while (at >= 0 && node) {
      if (node.nodeType === 1 && matchesPart(node, parts[at])) at--;
      node = node.parentNode;
    }
    if (at < 0) return true;
  }
  return false;
}

function parseHTML(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^<>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const node = doc.createElement(m[2]);
      const attrs = m[3] || "";
      const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let a;
      while ((a = attrRe.exec(attrs))) {
        const value = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : "";
        node.setAttribute(a[1], value);
      }
      stack[stack.length - 1].appendChild(node);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(node);
    } else if (m[5] != null && m[5].trim()) {
      stack[stack.length - 1].appendChild(doc.createTextNode(m[5]));
    }
  }
}

export class Document extends El {
  constructor() {
    super("#document", null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.readyState = "complete";
    this.hidden = false;
    this.activeElement = null;
    this.documentElement = new El("html", this);
    this.head = new El("head", this);
    this.body = new El("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.documentElement.clientWidth = 390;
    this.documentElement.clientHeight = 844;
  }
  createElement(tag) { return new El(tag, this); }
  createElementNS(ns, tag) { const node = new El(tag, this); node.namespaceURI = ns; return node; }
  createTextNode(text) { return new TextNode(text); }
  createDocumentFragment() {
    const frag = new El("#fragment", this);
    frag.nodeType = 11;
    const appendChild = frag.appendChild.bind(frag);
    frag.appendChild = (node) => {
      if (node && node.nodeType === 1) { for (const child of [...node.children]) appendChild(child); return node; }
      return appendChild(node);
    };
    return frag;
  }
  getElementById(id) {
    const found = descendants(this).find((n) => n.id === String(id));
    return found || null;
  }
  getElementsByTagName(tag) {
    const t = String(tag).toUpperCase();
    return descendants(this).filter((n) => t === "*" || n.tagName === t);
  }
}

export function makeFetch() {
  const calls = [];
  const routes = new Map();
  const fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: String(opts.method || "GET").toUpperCase(),
      // JSON bodies are decoded for assertions; a binary chunk (upload) is recorded as sent.
      body: typeof opts.body === "string" ? JSON.parse(opts.body) : (opts.body || null),
      headers: opts.headers || null,
    };
    calls.push(call);
    const handler = routes.get(call.url) || routes.get("*");
    if (!handler) throw new Error("unexpected fetch: " + call.method + " " + call.url);
    const reply = await handler(call);
    const status = reply && reply.status != null ? reply.status : 200;
    const body = reply && reply.body !== undefined ? reply.body : (reply && reply.ok !== undefined ? reply : { ok: true });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return {
    fetch,
    calls,
    on(url, handler) { routes.set(url, handler); return this; },
    callsTo(url) { return calls.filter((c) => c.url === url); },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    key(i) { return [...map.keys()][i] ?? null; },
    get length() { return map.size; },
  };
}

export function makeWindow(doc, opts = {}) {
  const timers = new Map();
  let timerId = 0;
  const winListeners = new Map();
  const toasts = [];
  const win = {
    document: doc,
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 2,
    location: { hash: "", href: "http://localhost/", origin: "http://localhost", pathname: "/" },
    navigator: { userAgent: "node-hq-test", language: "fr-CA", languages: ["fr-CA"], maxTouchPoints: 1 },
    localStorage: storage(opts.localStorage),
    sessionStorage: storage(opts.sessionStorage),
    crypto: {
      randomUUID() {
        const hex = (serial++).toString(16).padStart(12, "0");
        return "00000000-0000-4000-8000-" + hex;
      },
      getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = (serial + i) % 256; return arr; },
    },
    visualViewport: { height: 844, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } },
    AbortController: class {
      constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} }; }
      abort() { this.signal.aborted = true; }
    },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(fn) { return win.setTimeout(fn, 16); },
    cancelAnimationFrame(id) { timers.delete(id); },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent(ev) {
      const e = ev || {};
      e.target = e.target || win;
      e.preventDefault = e.preventDefault || (() => {});
      for (const fn of [...(winListeners.get(e.type) || [])]) fn.call(win, e);
      return true;
    },
    fetch: opts.fetch,
    scrollTo() {},
    scrollBy() {},
    getComputedStyle() { return { position: "static", top: "0px", left: "0px", getPropertyValue() { return ""; } }; },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    Image: class {
      constructor() { this.onload = null; this.onerror = null; this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
      addEventListener(type, fn) { this["on" + type] = fn; }
      removeEventListener() {}
    },
    Audio: class {
      constructor(src) { this.src = src; this.volume = 1; this.paused = true; this.onended = null; this.onerror = null; }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
      load() {}
      addEventListener() {}
      removeEventListener() {}
    },
    URL: globalThis.URL,
    Blob: class {},
    FormData: class { constructor() { this._data = []; } append(k, v) { this._data.push([k, v]); } },
    FileReader: class { readAsDataURL() { if (this.onload) this.onload({ target: { result: "data:image/png;base64," } }); } },
    matchKeys: null,
    toast(message, kind) { toasts.push({ message: String(message), kind: kind || "ok" }); },
    toasts,
    timers,
    __listeners: winListeners,
    hqCsrfToken: () => "csrf-test-token",
    hqCompanionNsfwOn: () => false,
    hqSessionIsAdmin: () => (opts.admin === false ? false : true),
    HqImageChipScale: { bind: () => ({ menuStep: 0.08 }), bindPortraitMode: () => ({ apply() {} }) },
    Option: function (text, value, defaultSelected, selected) {
      const option = doc.createElement("option");
      option.textContent = text;
      if (value !== undefined) option.value = value;
      option.defaultSelected = !!defaultSelected;
      option.selected = !!selected;
      return option;
    },
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    speechSynthesis: null,
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;
  doc.defaultView = win;
  return win;
}

export function loadChip(file, opts = {}) {
  const doc = new Document();
  doc.body.dataset.view = opts.view || "forge";
  doc.body.className = opts.bodyClass == null ? "session-admin" : opts.bodyClass;
  const net = makeFetch();
  if (typeof opts.setup === "function") opts.setup(net);
  const win = makeWindow(doc, { fetch: net.fetch, ...(opts.win || {}) });
  const sandbox = {
    window: win,
    self: win,
    globalThis: win,
    document: doc,
    console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: win.dispatchEvent,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    fetch: win.fetch,
    crypto: win.crypto,
    navigator: win.navigator,
    location: win.location,
    MutationObserver: win.MutationObserver,
    AbortController: win.AbortController,
    CustomEvent: win.CustomEvent,
    Event: win.Event,
    Image: win.Image,
    Audio: win.Audio,
    URL: win.URL,
    Blob: win.Blob,
    FormData: win.FormData,
    FileReader: win.FileReader,
    Option: win.Option,
    visualViewport: win.visualViewport,
    getComputedStyle: win.getComputedStyle,
    matchMedia: win.matchMedia,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
    toasts: win.toasts,
  };
  const ctx = vm.createContext(sandbox);
  // `before` scripts load first and `also` scripts after the main one (e.g. the language file and an extension), all in one context.
  for (const f of [...(opts.before || []), file, ...(opts.also || [])]) {
    const source = readFileSync(new URL("../assets/" + f, import.meta.url), "utf8");
    vm.runInContext(opts.mutate ? opts.mutate(source, f) : source, ctx, { filename: f });
  }
  return { doc, win, net, ctx, sandbox };
}

export function all(root) {
  return descendants(root);
}

export function byId(doc, id) {
  return doc.getElementById(id);
}

export function byText(root, text, tag) {
  return all(root).find((n) => (!tag || n.tagName === tag.toUpperCase()) && n.textContent.trim() === text) || null;
}

export function textOf(node) {
  return node ? node.textContent : "";
}

export function tick(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}
