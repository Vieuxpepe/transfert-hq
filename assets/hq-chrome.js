/* Transfert HQ — toasts, palette, ripples, terminal + disclosure polish (assets/hq-chrome.css). */
(function (root, factory) {
  "use strict";
  const api = { paletteOpened: null, paletteRendered: null };
  const factoryApi = factory(root, api);
  Object.assign(api, factoryApi);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqChrome = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global, api) {
  "use strict";

  function calm(win) {
    try {
      return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function rippleAt(el, x, y, win) {
    if (!el || calm(win)) return;
    el.classList.add("hq-ripple-host");
    const r = win.document.createElement("span");
    r.className = "hq-ripple";
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height, 44) * 1.2;
    r.style.setProperty("--r", size + "px");
    r.style.left = x - rect.left + "px";
    r.style.top = y - rect.top + "px";
    el.appendChild(r);
    if (typeof r.animate === "function") {
      r.animate([{ transform: "scale(0)", opacity: 0.35 }, { transform: "scale(2.4)", opacity: 0 }], {
        duration: 520,
        easing: "cubic-bezier(.2,.8,.2,1)",
      }).onfinish = () => r.remove();
    } else win.setTimeout(() => r.remove(), 520);
  }

  function rippleTarget(el) {
    if (!el) return null;
    if (el.closest("#hq-sk-app")) return null;
    if (el.closest(".hq-carnet, [class*='carnet-'], .c16-root")) return null;
    return el;
  }

  function staggerPaletteItems(list, win) {
    if (!list || calm(win)) return;
    let i = 0;
    list.querySelectorAll("li[data-i]").forEach((li) => {
      li.style.setProperty("--pli", String(i));
      i += 1;
    });
  }

  function wrapToast(win) {
    const doc = win.document;
    const native = win.toast;
    if (typeof native !== "function" || native.__hqChrome) return;
    function toast(msg, kind, ms) {
      kind = kind || "ok";
      ms = ms === undefined ? 3200 : ms;
      native(msg, kind, ms);
      const box = doc.querySelector("#toasts");
      const t = box && box.lastElementChild;
      if (!t || calm(win)) return;
      t.classList.remove("is-leaving");
      void t.offsetWidth;
    }
    toast.__hqChrome = true;
    win.toast = toast;
    win.hqToast = toast;
  }

  function revealDisclosure(win, btn) {
    const doc = win.document;
    const panelId = btn.getAttribute("aria-controls");
    const panel = panelId ? doc.getElementById(panelId) : btn.nextElementSibling;
    if (!panel || !panel.classList.contains("hq-disclosure-panel")) return;
    if (btn.getAttribute("aria-expanded") !== "true" && !btn.classList.contains("is-open")) return;
    panel.classList.remove("is-reveal");
    void panel.offsetWidth;
    panel.classList.add("is-reveal");
  }

  api.paletteOpened = function (win) {
    win = win || global;
    const box = win.document.getElementById("hq-palette");
    if (!box || box.hidden) return;
    box.classList.remove("is-opening");
    void box.offsetWidth;
    box.classList.add("is-opening");
    staggerPaletteItems(win.document.getElementById("hq-palette-list"), win);
  };

  api.paletteRendered = function (win) {
    win = win || global;
    staggerPaletteItems(win.document.getElementById("hq-palette-list"), win);
  };

  function start(win) {
    const doc = win.document;
    wrapToast(win);

    doc.addEventListener(
      "pointerdown",
      (ev) => {
        if (ev.button !== 0 || calm(win)) return;
        const raw = ev.target && ev.target.closest ? ev.target.closest("button, .launch, .home-act, .chip, .player-pick, .sk-btn, .sk-tool") : null;
        const t = rippleTarget(raw);
        if (!t || t.disabled) return;
        rippleAt(t, ev.clientX, ev.clientY, win);
      },
      { passive: true }
    );

    doc.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button.hq-disclosure") : null;
      if (!btn) return;
      win.setTimeout(() => revealDisclosure(win, btn), 0);
    });

    const watchShell = () => {
      const out = doc.getElementById("shell-out");
      if (!out || out.__hqShell) return;
      out.__hqShell = true;
      new win.MutationObserver(() => {
        if (!out.textContent || out.textContent === "…") return;
        out.classList.remove("is-fresh");
        void out.offsetWidth;
        out.classList.add("is-fresh");
        win.setTimeout(() => out.classList.remove("is-fresh"), 400);
      }).observe(out, { characterData: true, childList: true, subtree: true });
    };

    const boot = () => {
      watchShell();
      const dm = global.HqDanglingMember;
      if (dm && typeof dm.initDanglingMember === "function") dm.initDanglingMember(win);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, calm, rippleAt, rippleTarget, revealDisclosure };
});
