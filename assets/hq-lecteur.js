/* Transfert HQ — Lecteur stage + list motion; FLIP from Fichiers (assets/hq-lecteur.css). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqLecteur = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  let fly = null;

  function calm() {
    try {
      return global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function stage() {
    return global.document.querySelector(".player-stage");
  }

  function pulseStage(mode) {
    const s = stage();
    if (!s || calm()) return;
    s.classList.remove("is-curtain", "is-enter", "is-cinema");
    void s.offsetWidth;
    s.classList.add("is-curtain", "is-enter", "is-cinema");
    global.setTimeout(() => s.classList.remove("is-curtain", "is-enter"), 700);
  }

  function flyFrom(rect, src) {
    if (!rect || calm()) return;
    fly = { rect, src, t: Date.now() };
  }

  function consumeFly() {
    const pending = fly;
    fly = null;
    if (!pending || calm()) return;
    const s = stage();
    if (!s) return;
    const target = s.getBoundingClientRect();
    const ghost = global.document.createElement(pending.src ? "img" : "div");
    ghost.className = "pl-fly-clone";
    if (pending.src) {
      ghost.src = pending.src;
      ghost.alt = "";
    } else {
      ghost.style.background = "color-mix(in srgb,var(--accent) 30%,var(--panel))";
    }
    const w = pending.rect.width;
    const h = pending.rect.height;
    ghost.style.width = w + "px";
    ghost.style.height = h + "px";
    ghost.style.left = pending.rect.left + "px";
    ghost.style.top = pending.rect.top + "px";
    global.document.body.appendChild(ghost);
    const tx = target.left + target.width / 2 - pending.rect.left - w / 2;
    const ty = target.top + target.height / 2 - pending.rect.top - h / 2;
    const sc = Math.min(target.width / w, target.height / h, 1.2);
    ghost.style.setProperty("--fly-to", "translate(" + tx + "px," + ty + "px) scale(" + sc + ")");
    if (typeof ghost.animate === "function") {
      ghost.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: "translate(" + tx + "px," + ty + "px) scale(" + sc + ")", opacity: 0.15 },
        ],
        { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
      ).onfinish = () => ghost.remove();
    } else global.setTimeout(() => ghost.remove(), 500);
  }

  function staggerList(force) {
    if (calm()) return;
    const items = global.document.querySelectorAll("#player-list .player-item");
    let i = 0;
    items.forEach((li) => {
      li.style.setProperty("--pli", String(i));
      if (force) {
        li.classList.remove("pl-in");
        void li.offsetWidth;
        li.classList.add("pl-in");
      } else if (!li.classList.contains("pl-in")) li.classList.add("pl-in");
      i += 1;
    });
  }

  function syncPlayChrome(kind) {
    const primary = global.document.querySelector(".player-primary");
    if (!primary) return;
    const video = global.document.getElementById("player-video");
    const audio = global.document.getElementById("player-audio");
    const media = kind === "video" ? video : kind === "audio" ? audio : null;
    primary.classList.toggle("is-audio-tint", kind === "audio");
    const sync = () => {
      const playing = !!(media && !media.hidden && !media.paused && !media.ended);
      primary.classList.toggle("is-playing", playing);
    };
    if (primary.__hqPlaySync) {
      ["play", "pause", "ended", "emptied"].forEach((ev) => {
        video.removeEventListener(ev, primary.__hqPlaySync);
        audio.removeEventListener(ev, primary.__hqPlaySync);
      });
    }
    primary.__hqPlaySync = sync;
    ["play", "pause", "ended", "emptied"].forEach((ev) => {
      video.addEventListener(ev, sync);
      audio.addEventListener(ev, sync);
    });
    sync();
    if (kind === "audio" || kind === "video") {
      primary.style.setProperty("--pl-tint", kind === "audio" ? "var(--accent)" : "transparent");
    }
  }

  function onMediaLoad(kind) {
    consumeFly();
    pulseStage(kind);
    syncPlayChrome(kind);
    const name = global.document.getElementById("player-name");
    if (name && !calm() && typeof name.animate === "function") {
      name.animate([{ opacity: 0.4, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
        duration: 320,
        easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
  }

  function start(win) {
    win.hqPlayerFlyFrom = flyFrom;
    win.hqPlayerStageFx = onMediaLoad;
    const wrapList = () => {
      if (typeof win.hqPlayerRenderList === "function" && !win.hqPlayerRenderList.__lecteur) {
        const orig = win.hqPlayerRenderList;
        let first = true;
        win.hqPlayerRenderList = function () {
          orig();
          staggerList(first);
          first = false;
        };
        win.hqPlayerRenderList.__lecteur = true;
      }
    };
    if (win.document.readyState === "loading") win.document.addEventListener("DOMContentLoaded", wrapList, { once: true });
    else wrapList();
  }

  return { start, flyFrom, onMediaLoad, staggerList, calm };
});
