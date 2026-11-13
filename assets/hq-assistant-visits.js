/* Transfert HQ — occasional visits between assistant chips (assets/hq-assistant-visits.js)
 * One visible chip hosts a random visitor from another tab. The visitor walks in,
 * a short scripted exchange plays in bubbles, then the visitor leaves. No model
 * calls, no persistence, and nothing runs while a drawer or an input is in use. */
(function () {
  "use strict";

  if (window.hqAssistantVisitsReady) return;
  window.hqAssistantVisitsReady = true;

  var CHIPS = [
    { key: "culinia", name: "Culinia", selector: ".hq-culinia-chip", size: [54, 54],
      hello: "Ça sent bon, par ici.",
      reply: "Toujours : je goûte trois fois avant de servir.",
      about: "Je surveille les stocks, les lots qui périment et les menus de la semaine.",
      ask: "Et toi, {other}, tu tiens le rythme ?",
      answer: "Je range, je vérifie, je repère ce qui manque. Rien d'urgent.",
      extra: "Il me reste des épluchures « pour un bouillon » que je ne ferai jamais.",
      bye: "Je retourne aux fourneaux." },
    { key: "forgia", name: "Forgia", selector: ".hq-forgia-chip", size: [54, 54],
      hello: "Je passais jeter un œil à la lumière.",
      reply: "La lumière, c'est ce qui décide de tout.",
      about: "Je travaille les prompts, les poids et les rendus, sans toucher à ton Atelier.",
      ask: "Et toi, {other}, tu as trouvé ton angle ?",
      answer: "Je collectionne les éclairages ratés qui valent mieux que les propres.",
      extra: "Un sampler bien choisi vaut parfois un long discours.",
      bye: "Bonne suite — je retourne à l'atelier." },
    { key: "musica", name: "Musica", selector: ".hq-musica-chip", size: [54, 54],
      hello: "Je cherchais une basse, je tombe sur toi.",
      reply: "Tant mieux : j'allais justement poser une question.",
      about: "Je gère les playlists, les découvertes et la lecture Connect.",
      ask: "Et toi, {other}, qu'est-ce qui tourne en ce moment ?",
      answer: "J'écoute un album dans l'ordre, une fois, sans rien faire d'autre.",
      extra: "Les fondus de moins de trois secondes me méfient.",
      bye: "Je te laisse, j'ai un morceau à finir." },
    { key: "inventoria", name: "Inventoria", selector: ".hq-inventoria-toggle", size: [118, 30],
      hello: "Je passais vérifier les étiquettes.",
      reply: "Deux fois, puis une troisième à voix haute.",
      about: "Je compte le stock, les lots et les listes de courses.",
      ask: "Et toi, {other}, tout est à sa place ?",
      answer: "Je relis les vieilles listes comme un journal.",
      extra: "Je nomme les bacs comme des rues, ça aide à retrouver.",
      bye: "Je retourne ranger." },
    { key: "pistonia", name: "Pistonia", selector: ".hq-pistonia-chip", size: [54, 54],
      hello: "Je faisais le tour des machines.",
      reply: "Un bon chiffre se mesure deux fois.",
      about: "Je surveille la salle des machines : températures, courbes, bruit de fond.",
      ask: "Et toi, {other}, rien qui chauffe ?",
      answer: "J'écoute un moteur au ralenti jusqu'à entendre la bonne note.",
      extra: "Un ventilateur bruyant est une diva : il faut le laisser chanter.",
      bye: "Je retourne au bruit de fond." },
    { key: "securia", name: "Securia", selector: ".hq-securia-chip", size: [54, 54],
      hello: "Je passais vérifier une serrure.",
      reply: "Le cadenas, puis la poignée — toujours dans cet ordre.",
      about: "Je lis les journaux, les ports ouverts et les sessions actives.",
      ask: "Et toi, {other}, tout est fermé derrière toi ?",
      answer: "Je lis les journaux de serveurs comme des romans policiers.",
      extra: "Les ports ouverts sont des fenêtres mal fermées.",
      bye: "Je retourne à la ronde." },
    { key: "else", name: "Else", selector: ".hq-else-toggle", size: [104, 30],
      hello: "Je passais, sans bruit.",
      reply: "Rien ne presse. Je regarde.",
      about: "Je travaille l'image, les formes, ce qui tient dans un cadre.",
      ask: "Et toi, {other}, tu vois quelque chose que je manque ?",
      answer: "Je dessine des schémas de couple sur des nappes en papier.",
      extra: "Deux respirations avant de répondre, même quand la question est simple.",
      bye: "Je te laisse." }
  ];

  var MIN_DELAY = 22000;
  var MAX_DELAY = 62000;
  var ARRIVE_MS = 1600;
  var LEAVE_MS = 1300;
  var active = null;
  var timer = 0;
  var lastVisitor = "";

  function rand(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
  function visible(el) {
    if (!el) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  }
  function drawerOpen() {
    var nodes = document.querySelectorAll(
      '[class$="-drawer"]:not([hidden]), .hq-else-chip-menu:not([hidden]), ' +
      '.hq-inventoria-chip-menu:not([hidden]), .hq-pistonia-menu:not([hidden]), ' +
      '.hq-pistonia-settings:not([hidden]), [role="dialog"]:not([hidden]), .hq-inventoria-lightbox'
    );
    for (var i = 0; i < nodes.length; i++) if (visible(nodes[i])) return true;
    return false;
  }
  function typing() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }
  function busy() { return document.hidden || drawerOpen() || typing(); }

  function hostChip() {
    var candidates = [];
    for (var i = 0; i < CHIPS.length; i++) {
      var el = document.querySelector(CHIPS[i].selector);
      if (visible(el)) candidates.push({ chip: CHIPS[i], el: el });
    }
    return candidates.length ? candidates[rand(0, candidates.length - 1)] : null;
  }

  function visitorChip(hostKey) {
    var pool = [];
    for (var i = 0; i < CHIPS.length; i++) {
      if (CHIPS[i].key === hostKey) continue;
      if (!document.querySelector(CHIPS[i].selector)) continue;
      if (CHIPS[i].key === lastVisitor && CHIPS.length > 3) continue;
      pool.push(CHIPS[i]);
    }
    return pool.length ? pool[rand(0, pool.length - 1)] : null;
  }

  function bubbleAt(rect, text) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble";
    b.textContent = text;
    b.setAttribute("role", "status");
    document.body.appendChild(b);
    var w = Math.min(230, Math.max(150, rect.width + 120));
    b.style.width = w + "px";
    b.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + "px";
    b.style.top = "0px";
    b.style.visibility = "hidden";
    var h = b.offsetHeight;
    var top = rect.top - h - 10;
    if (top < 8) {
      top = rect.bottom + 10;
      b.classList.add("is-below");
    }
    b.style.top = top + "px";
    b.style.visibility = "";
    void b.offsetWidth;
    b.classList.add("is-shown");
    return b;
  }

  function clearBubble(b) {
    if (!b) return;
    b.classList.remove("is-shown");
    window.setTimeout(function () { if (b.parentNode) b.remove(); }, 260);
  }

  function scriptFor(host, visitor, turns) {
    var lines = [
      { who: visitor, text: visitor.hello },
      { who: host, text: host.reply },
      { who: visitor, text: visitor.about },
      { who: host, text: host.ask.replace("{other}", visitor.name) },
      { who: visitor, text: visitor.answer }
    ];
    if (turns >= 4) lines.push({ who: host, text: host.extra });
    if (turns >= 5) lines.push({ who: visitor, text: visitor.extra });
    lines.push({ who: host, text: host.bye });
    if (turns >= 4) lines.push({ who: visitor, text: visitor.bye });
    return lines;
  }

  function stopActive() {
    if (!active) return;
    active.stopped = true;
    window.clearTimeout(active.timer);
    clearBubble(active.bubble);
    var wrap = active.wrap;
    if (wrap) {
      wrap.style.opacity = "0";
      window.setTimeout(function () { if (wrap.parentNode) wrap.remove(); }, 300);
    }
    document.body.classList.remove("hq-visit-active");
    active = null;
  }

  function finishAndSchedule(visit, wrap, startX, w, y) {
    return function () {
      if (!active || active !== visit || visit.stopped) return;
      if (visit.bubble) { clearBubble(visit.bubble); visit.bubble = null; }
      wrap.style.transform = "translate3d(" + startX + "px," + y + "px,0)";
      wrap.style.opacity = "0";
      window.setTimeout(function () {
        if (wrap.parentNode) wrap.remove();
        if (active === visit) {
          active = null;
          document.body.classList.remove("hq-visit-active");
        }
        schedule(rand(MIN_DELAY, MAX_DELAY));
      }, LEAVE_MS);
    };
  }

  function play(visit, lines) {
    var index = 0;
    function next() {
      if (!active || active !== visit || visit.stopped || busy()) {
        if (active === visit) stopActive();
        if (active === null && !document.hidden) schedule(rand(MIN_DELAY, MAX_DELAY));
        return;
      }
      if (index >= lines.length) {
        visit.finish();
        return;
      }
      var line = lines[index++];
      var target = line.who.key === visit.host.chip.key ? visit.hostRect : visit.visitorRect;
      clearBubble(visit.bubble);
      visit.bubble = bubbleAt(target, line.text);
      var wait = 1700 + Math.min(1500, line.text.length * 42);
      visit.timer = window.setTimeout(next, wait);
    }
    next();
  }

  function run(hostPick, visitor) {
    var host = hostPick.chip;
    var hostEl = hostPick.el;
    var hostRect = hostEl.getBoundingClientRect();
    var visitorButton = document.querySelector(visitor.selector);
    if (!visitorButton || !hostRect.width) { schedule(15000); return; }

    var wrap = document.createElement("div");
    wrap.className = "hq-visit-visitor";
    wrap.setAttribute("aria-hidden", "true");
    var clone = visitorButton.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-label");
    clone.removeAttribute("hidden");
    clone.tabIndex = -1;
    clone.setAttribute("aria-hidden", "true");
    clone.style.position = "relative";
    clone.style.left = clone.style.top = clone.style.right = clone.style.bottom = "auto";
    clone.style.margin = "0";
    clone.style.transform = "none";
    var originalDisplay = window.getComputedStyle(visitorButton).display;
    clone.style.display = originalDisplay && originalDisplay !== "none" ? originalDisplay : "inline-flex";
    clone.style.visibility = "visible";
    clone.style.opacity = "1";
    var ids = clone.querySelectorAll("[id]");
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
    wrap.appendChild(clone);
    wrap.style.left = "-9999px";
    document.body.appendChild(wrap);
    document.body.classList.add("hq-visit-active");

    // Measure the clone itself: the real chip can be hidden on this view.
    var size = clone.getBoundingClientRect();
    var w = Math.max(44, size.width || (visitor.size && visitor.size[0]) || 54);
    var h = Math.max(24, size.height || (visitor.size && visitor.size[1]) || 54);
    wrap.style.left = "0";
    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.boxSizing = "border-box";
    if (visitor.key === "else" || visitor.key === "inventoria") clone.style.justifyContent = "center";
    var side = hostRect.left > window.innerWidth / 2 ? "left" : "right";
    var endX = side === "left" ? hostRect.left - w - 16 : hostRect.right + 16;
    if (endX < 8) { side = "right"; endX = hostRect.right + 16; }
    if (endX + w > window.innerWidth - 8) { side = "left"; endX = hostRect.left - w - 16; }
    var y = Math.max(70, Math.min(window.innerHeight - h - 90, hostRect.top + (hostRect.height - h) / 2));
    var startX = side === "left" ? -w - 24 : window.innerWidth + 24;

    wrap.style.transform = "translate3d(" + startX + "px," + y + "px,0)";
    void wrap.offsetWidth;
    wrap.style.transform = "translate3d(" + endX + "px," + y + "px,0)";

    var visit = {
      host: { chip: host, el: hostEl },
      visitor: { chip: visitor },
      hostRect: hostRect,
      visitorRect: { left: endX, top: y, width: w, height: h, right: endX + w, bottom: y + h },
      wrap: wrap,
      bubble: null,
      timer: 0,
      stopped: false
    };
    visit.finish = finishAndSchedule(visit, wrap, startX, w, y);
    active = visit;

    window.setTimeout(function () {
      if (!active || active !== visit || visit.stopped) return;
      if (busy()) { stopActive(); schedule(rand(MIN_DELAY, MAX_DELAY)); return; }
      play(visit, scriptFor(host, visitor, rand(3, 5)));
    }, ARRIVE_MS + 250);
  }

  function attempt() {
    timer = 0;
    if (active) return;
    if (busy()) { schedule(rand(12000, 26000)); return; }
    var hostPick = hostChip();
    if (!hostPick) { schedule(18000); return; }
    var visitor = visitorChip(hostPick.chip.key);
    if (!visitor) { schedule(22000); return; }
    lastVisitor = visitor.key;
    run(hostPick, visitor);
  }

  function schedule(delay) {
    window.clearTimeout(timer);
    timer = window.setTimeout(attempt, Math.max(0, delay));
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopActive();
      window.clearTimeout(timer);
      timer = 0;
    } else if (!active && !timer) {
      schedule(rand(12000, 26000));
    }
  });
  window.addEventListener("hq:view", function () {
    if (active) stopActive();
    if (!document.hidden) schedule(rand(9000, 18000));
  });
  document.addEventListener("pointerdown", function (ev) {
    if (!active) return;
    var target = ev.target;
    if (!target || !target.closest) return;
    if (target.closest("[class*='-chip'], [class*='-drawer'], .hq-else-chip-menu, .hq-inventoria-chip-menu, .hq-pistonia-menu, .hq-pistonia-settings")) {
      stopActive();
      schedule(rand(MIN_DELAY, MAX_DELAY));
    }
  }, true);
  var lastView = document.body.getAttribute("data-view") || "";
  if (window.MutationObserver) {
    new MutationObserver(function () {
      var view = document.body.getAttribute("data-view") || "";
      if (view === lastView) return;
      lastView = view;
      if (active) stopActive();
      if (!document.hidden) schedule(rand(9000, 18000));
    }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  }

  window.hqAssistantVisitNow = function () {
    if (active) return false;
    window.clearTimeout(timer);
    timer = window.setTimeout(attempt, 0);
    return true;
  };

  schedule(rand(14000, 28000));
})();
