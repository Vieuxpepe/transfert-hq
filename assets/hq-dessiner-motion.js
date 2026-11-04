/* Transfert HQ — Dessiner presentation motion (listens to hq-sk-motion on #hq-sk-app). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqDessinerMotion = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  function calm() {
    try {
      return global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function flash(el, cls, ms) {
    if (!el || calm()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    global.setTimeout(() => el.classList.remove(cls), ms || 600);
  }

  function ripple(el, x, y) {
    if (!el || calm()) return;
    const r = global.document.createElement("span");
    r.className = "sk-motion-ripple";
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, 48) * 1.1;
    r.style.setProperty("--sr", size + "px");
    r.style.left = (x != null ? x : rect.left + rect.width / 2) - rect.left + "px";
    r.style.top = (y != null ? y : rect.top + rect.height / 2) - rect.top + "px";
    el.style.position = el.style.position || "relative";
    el.appendChild(r);
    if (typeof r.animate === "function") {
      r.animate([{ transform: "scale(0)", opacity: 0.3 }, { transform: "scale(2.2)", opacity: 0 }], {
        duration: 480,
        easing: "cubic-bezier(.2,.8,.2,1)",
      }).onfinish = () => r.remove();
    } else global.setTimeout(() => r.remove(), 500);
  }

  function onMotion(ev) {
    const d = ev.detail || {};
    const app = ev.currentTarget;
    if (!app || calm()) return;
    if (d.kind === "tool") {
      const t = app.querySelector('.sk-tool[data-tool="' + d.tool + '"]');
      flash(t, "sk-motion-pop");
      if (t) ripple(t);
    }
    if (d.kind === "mode") flash($(".sk-bar", app), "sk-motion-enter");
    if (d.kind === "view") {
      const on = d.tab3d ? $(".sk-3d-stage", app) : $(".sk-stage", app);
      flash(on, "sk-motion-flip");
    }
    if (d.kind === "save") {
      const btn = app.querySelector('[data-act="save"]');
      flash(btn, "sk-motion-stamp");
      const stage = d.tab3d ? $(".sk-3d-stage", app) : $(".sk-stage", app);
      if (stage) {
        let g = stage.querySelector(".sk-stamp-ghost");
        if (!g) {
          g = global.document.createElement("span");
          g.className = "sk-stamp-ghost";
          g.textContent = "Enregistré";
          stage.appendChild(g);
        }
        g.classList.remove("is-go");
        void g.offsetWidth;
        g.classList.add("is-go");
        global.setTimeout(() => g.classList.remove("is-go"), 900);
      }
      if (typeof global.hqPolishHaptic === "function") global.hqPolishHaptic("done");
    }
  }

  function $(s, el) {
    return (el || global.document).querySelector(s);
  }

  function start(win) {
    const hook = () => {
      const app = win.document.getElementById("hq-sk-app");
      if (!app || app.__skMotion) return;
      app.__skMotion = true;
      app.addEventListener("hq-sk-motion", onMotion);
    };
    if (win.document.readyState === "loading") win.document.addEventListener("DOMContentLoaded", hook, { once: true });
    else hook();
  }

  return { start, calm, flash };
});
