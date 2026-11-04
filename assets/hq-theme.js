/* Transfert HQ — the frosted sidebar's gliding highlight, view transitions, nav comet, page fade
 * (assets/hq-theme.css has the colours, fonts, and motion tokens). Plain ES2020; pure helpers for tests. */
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

  function inkBox(btn) {
    if (!btn) return null;
    return { x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight };
  }

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

  function fadePanel(doc, view, calmNow) {
    if (calmNow) return;
    for (const panel of doc.querySelectorAll('[data-panel="' + view + '"]')) {
      if (typeof panel.animate !== "function") continue;
      try {
        panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
      } catch (_) {}
    }
  }

  function navPop(win, nav, calmNow) {
    if (calmNow || !nav) return;
    const btn = nav.querySelector("button.active");
    if (!btn) return;
    btn.classList.remove("is-pop");
    void btn.offsetWidth;
    btn.classList.add("is-pop");
    win.setTimeout(() => btn.classList.remove("is-pop"), 650);
  }

  function accentWash(win, doc, calmNow) {
    if (calmNow) return;
    doc.body.classList.remove("hq-vt-wash");
    void doc.body.offsetWidth;
    doc.body.classList.add("hq-vt-wash");
    win.setTimeout(() => doc.body.classList.remove("hq-vt-wash"), 650);
  }

  function navComet(win, view) {
    const doc = win.document;
    if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const nav = doc.querySelector(".bottom-nav");
    const btn = nav && nav.querySelector('button[data-nav="' + view + '"]');
    if (!nav || !btn) return;
    let comet = doc.querySelector(".nav-comet");
    if (!comet) {
      comet = doc.createElement("span");
      comet.className = "nav-comet";
      comet.setAttribute("aria-hidden", "true");
      doc.body.appendChild(comet);
    }
    const nb = nav.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    comet.style.setProperty("--cx", Math.round(nb.left + nb.width / 2 - 5) + "px");
    comet.style.setProperty("--cy", Math.round(nb.top + nb.height / 2 - 5) + "px");
    comet.style.setProperty("--tx", Math.round(bb.left + bb.width / 2 - 5) + "px");
    comet.style.setProperty("--ty", Math.round(bb.top + bb.height / 2 - 5) + "px");
    comet.classList.remove("is-go");
    void comet.offsetWidth;
    comet.classList.add("is-go");
  }

  let viewBooted = false;

  function vtBlocked(win, doc) {
    if ((win.hqViewTransitionHold || 0) > 0) return true;
    try {
      if (doc.activeViewTransition) return true;
    } catch (_) {}
    return false;
  }

  function runViewChange(win, view, apply) {
    const doc = win.document;
    const calmNow = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nav = doc.querySelector(".bottom-nav");
    const prev = doc.body.dataset.view;
    const same = prev === view;
    const after = (opts) => {
      const usedVt = opts && opts.vt;
      navPop(win, nav, calmNow);
      if (!usedVt) fadePanel(doc, view, calmNow);
      if (!same) accentWash(win, doc, calmNow);
      if (!same && win.HqPolish && typeof win.HqPolish.onViewChange === "function") {
        win.HqPolish.onViewChange(win, prev, view);
      }
    };
    const finishHandled = () => {
      win.requestAnimationFrame(() => {
        win.__hqViewMotionHandled = false;
      });
    };
    const useVt =
      viewBooted &&
      !same &&
      !calmNow &&
      typeof doc.startViewTransition === "function" &&
      !vtBlocked(win, doc);
    viewBooted = true;
    if (!useVt) {
      win.__hqViewMotionHandled = true;
      apply();
      after({ vt: false });
      finishHandled();
      return;
    }
    doc.body.classList.add("hq-vt-active");
    const vt = doc.startViewTransition(() => {
      win.__hqViewMotionHandled = true;
      apply();
    });
    const done = () => {
      doc.body.classList.remove("hq-vt-active");
      after({ vt: true });
      finishHandled();
    };
    if (vt && vt.finished) vt.finished.then(done, done);
    else done();
  }

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
        if (!win.__hqViewMotionHandled && !calm()) {
          fadePanel(doc, v, false);
          navPop(win, nav, false);
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ["data-view"] });
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

  return { start, runViewChange, navComet, pure };
});
