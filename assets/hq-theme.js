/* Transfert HQ — the frosted sidebar's gliding highlight, the icon that pops when its page opens, and the soft fade of
 * the page you open (assets/hq-theme.css has the colours and fonts). Watches body[data-view]; changes nothing else.
 * Plain ES2020, no HTML from strings; pure helpers exported for Node tests (tests/check_hq_theme.mjs). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqTheme = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Where the highlight goes: the active button's box inside the nav (scroll included). */
  function inkBox(btn) {
    if (!btn) return null;
    return { x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight };
  }

  /** WCAG contrast of two #rrggbb colours (for the tests and anyone choosing a new page colour). */
  function contrast(a, b) {
    const lum = (hex) => {
      const h = String(hex).replace("#", "");
      const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  const pure = { inkBox, contrast };

  function start(win) {
    const doc = win.document;
    const calm = () => {
      try {
        return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch (_) {
        return false;
      }
    };
    const boot = () => {
      const nav = doc.querySelector(".bottom-nav");
      if (!nav || nav.querySelector(".nav-ink")) return;
      const ink = doc.createElement("span");
      ink.className = "nav-ink is-still";
      ink.setAttribute("aria-hidden", "true");
      nav.insertBefore(ink, nav.firstChild);
      const place = (glide) => {
        const b = inkBox(nav.querySelector("button.active"));
        if (!b || !b.w) {
          nav.classList.remove("has-ink");
          return;
        }
        ink.classList.toggle("is-still", !glide || calm());
        ink.style.width = b.w + "px";
        ink.style.height = b.h + "px";
        ink.style.transform = "translate(" + b.x + "px," + b.y + "px)";
        nav.classList.add("has-ink");
      };
      place(false);
      win.requestAnimationFrame(() => place(false));
      let last = doc.body.dataset.view;
      new win.MutationObserver(() => {
        const v = doc.body.dataset.view;
        if (v === last) return;
        last = v;
        place(true);
        if (calm()) return;
        const btn = nav.querySelector("button.active");
        if (btn) {
          btn.classList.remove("is-pop");
          void btn.offsetWidth;
          btn.classList.add("is-pop");
          win.setTimeout(() => btn.classList.remove("is-pop"), 650);
        }
        // a Web Animation, not a CSS one: it never replaces a page's own entrance animation or its animationend
        for (const panel of doc.querySelectorAll('[data-panel="' + v + '"]')) {
          if (typeof panel.animate !== "function") continue;
          try {
            panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
          } catch (_) {}
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ["data-view"] });
      // the nav changes shape: window size, simple/full mode (buttons appear or hide), fonts arriving
      let t = 0;
      const later = () => {
        win.clearTimeout(t);
        t = win.setTimeout(() => place(false), 120);
      };
      win.addEventListener("resize", later, { passive: true });
      new win.MutationObserver(later).observe(doc.body, { attributes: true, attributeFilter: ["class"] });
      if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => place(false), () => {});
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure };
});
