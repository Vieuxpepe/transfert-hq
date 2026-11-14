/* Transfert HQ — occasional visits between assistant chips (assets/hq-assistant-visits.js)
 * One visible chip hosts a random visitor from another tab. The visitor walks in,
 * a short exchange plays in bubbles, then the visitor leaves. The server may
 * generate one short exchange; canned lines are the fallback. Nothing runs
 * while a drawer is open or the user is engaged with an input; a page's
 * autofocus alone does not block visits. */
(function () {
  "use strict";

  // Pure focus policy, also exported for tests/check_hq_assistant_visits_focus.mjs.
  function isField(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }
  function createFocusPolicy() {
    var auto = new WeakSet();
    var engaged = new WeakSet();
    function noteAuto(el) {
      if (!isField(el) || engaged.has(el)) return false;
      auto.add(el);
      return true;
    }
    function engage(el) {
      if (!isField(el)) return false;
      engaged.add(el);
      auto.delete(el);
      return true;
    }
    function blocks(el) {
      if (!isField(el)) return false;
      return engaged.has(el) || !auto.has(el);
    }
    return {
      noteInitialAuto: noteAuto,
      noteAuto: noteAuto,
      engage: engage,
      blocks: blocks,
      isAuto: function (el) { return isField(el) && auto.has(el); },
      isEngaged: function (el) { return isField(el) && engaged.has(el); }
    };
  }
  if (typeof module === "object" && module && module.exports) {
    module.exports = { createFocusPolicy: createFocusPolicy, isField: isField };
    return;
  }

  if (window.hqAssistantVisitsReady) return;
  window.hqAssistantVisitsReady = true;

  var focusPolicy = createFocusPolicy();
  focusPolicy.noteInitialAuto(document.activeElement);
  var pendingFocusIntent = null;

  var CHIPS = [
    { key: "culinia", name: "Culinia", selector: ".hq-culinia-chip", size: [54, 54],
      hello: ["Ça sent bon, par ici.", "Je passais voir ce qui mijote."],
      reply: ["Toujours : je goûte trois fois avant de servir.", "Je goûte encore une fois, par précaution."],
      about: ["Je surveille les stocks, les lots qui périment et les menus de la semaine.", "Je tiens les stocks, les lots et les menus à jour."],
      ask: ["Et toi, {other}, tu tiens le rythme ?", "Et toi, {other}, tu manges à quelle heure ?"],
      answer: ["Je range, je vérifie, je repère ce qui manque. Rien d'urgent.", "Je fais l'inventaire des restes avant de décider."],
      extra: ["Il me reste des épluchures « pour un bouillon » que je ne ferai jamais.", "J'ai trois recettes en tête et aucune envie de choisir."],
      bye: ["Je retourne aux fourneaux.", "Je retourne surveiller la casserole."],
      pair: {
        forgia: { hello: ["Je passais voir si tu as mangé."], bye: ["Mange quelque chose avant de retourner à l'écran."] },
        inventoria: { hello: ["Je passais voir tes étiquettes."], bye: ["Je te laisse compter."] }
      } },
    { key: "forgia", name: "Forgia", selector: ".hq-forgia-chip", size: [54, 54],
      hello: ["Je passais jeter un œil à la lumière.", "Je passais voir si la lumière tient."],
      reply: ["La lumière, c'est ce qui décide de tout.", "La lumière tranche avant le reste."],
      about: ["Je travaille les prompts, les poids et les rendus, sans toucher à ton Atelier.", "Je règle la lumière et les poids, sans toucher à ton Atelier."],
      ask: ["Et toi, {other}, tu as trouvé ton angle ?", "Et toi, {other}, tu regardes d'abord où ?"],
      answer: ["Je collectionne les éclairages ratés qui valent mieux que les propres.", "Je garde les essais ratés, ils disent souvent plus."],
      extra: ["Un sampler bien choisi vaut parfois un long discours.", "Un mauvais rendu m'apprend plus qu'un bon."],
      bye: ["Bonne suite — je retourne à l'atelier.", "Je retourne à l'atelier avant de perdre l'idée."],
      pair: {
        culinia: { hello: ["Je passais voir ce qui mijote."], bye: ["Garde-moi une part."] },
        musica: { hello: ["Je cherchais une image pour un son."], bye: ["Je te laisse finir le morceau."] }
      } },
    { key: "musica", name: "Musica", selector: ".hq-musica-chip", size: [54, 54],
      hello: ["Je cherchais une basse, je tombe sur toi.", "Je suivais une ligne de basse, elle m'a menée ici."],
      reply: ["Tant mieux : j'allais justement poser une question.", "Parfait, j'avais une question à poser."],
      about: ["Je gère les playlists, les découvertes et la lecture Connect.", "Je m'occupe des playlists, des découvertes et de la lecture."],
      ask: ["Et toi, {other}, qu'est-ce qui tourne en ce moment ?", "Et toi, {other}, tu écoutes quoi en travaillant ?"],
      answer: ["J'écoute un album dans l'ordre, une fois, sans rien faire d'autre.", "Je laisse l'album finir avant de juger."],
      extra: ["Les fondus de moins de trois secondes me méfient.", "Un silence bien placé vaut un refrain."],
      bye: ["Je te laisse, j'ai un morceau à finir.", "Je retourne finir ce morceau."],
      pair: {
        else: { hello: ["Je cherchais un silence, je tombe sur toi."], bye: ["Je te laisse à ton calme."] },
        forgia: { hello: ["Je passais écouter ce que tu fais."], bye: ["Je retourne au son."] }
      } },
    { key: "inventoria", name: "Inventoria", selector: ".hq-inventoria-chip", size: [64, 64],
      hello: ["Je passais vérifier les étiquettes.", "Je passais compter les bacs."],
      reply: ["Deux fois, puis une troisième à voix haute.", "Je compte, puis je recompte."],
      about: ["Je compte le stock, les lots et les listes de courses.", "Je tiens le stock, les lots et les listes."],
      ask: ["Et toi, {other}, tout est à sa place ?", "Et toi, {other}, tu ranges par usage ou par endroit ?"],
      answer: ["Je relis les vieilles listes comme un journal.", "Je garde les vieilles étiquettes, elles racontent le passage."],
      extra: ["Je nomme les bacs comme des rues, ça aide à retrouver.", "Un bon rangement se reconnaît quand la lumière est éteinte."],
      bye: ["Je retourne ranger.", "Je retourne à l'inventaire."],
      pair: {
        pistonia: { hello: ["Je passais vérifier tes étiquettes."], bye: ["Je note tout avant de partir."] },
        culinia: { hello: ["Je passais vérifier les stocks."], bye: ["J'ai noté ce qui manque."] }
      } },
    { key: "pistonia", name: "Pistonia", selector: ".hq-pistonia-chip", size: [54, 54],
      hello: ["Je faisais le tour des machines.", "Je passais écouter le bruit de fond."],
      reply: ["Un bon chiffre se mesure deux fois.", "Une courbe stable vaut mieux qu'un chiffre beau."],
      about: ["Je surveille la salle des machines : températures, courbes, bruit de fond.", "Je garde un œil sur les températures et les courbes."],
      ask: ["Et toi, {other}, rien qui chauffe ?", "Et toi, {other}, tu as entendu quelque chose ?"],
      answer: ["J'écoute un moteur au ralenti jusqu'à entendre la bonne note.", "Je laisse chauffer avant de juger."],
      extra: ["Un ventilateur bruyant est une diva : il faut le laisser chanter.", "Une machine calme se remarque à peine, c'est bon signe."],
      bye: ["Je retourne au bruit de fond.", "Je retourne faire la ronde."],
      pair: {
        inventoria: { hello: ["Je passais voir si tout est à sa place."], bye: ["Je retourne surveiller la salle."] },
        securia: { hello: ["Je passais vérifier les accès."], bye: ["Je ferme derrière moi."] }
      } },
    { key: "securia", name: "Securia", selector: ".hq-securia-chip", size: [54, 54],
      hello: ["Je passais vérifier une serrure.", "Je passais fermer une porte."],
      reply: ["Le cadenas, puis la poignée — toujours dans cet ordre.", "La poignée d'abord, le cadenas ensuite."],
      about: ["Je lis les journaux, les ports ouverts et les sessions actives.", "Je surveille les accès et les sessions ouvertes."],
      ask: ["Et toi, {other}, tout est fermé derrière toi ?", "Et toi, {other}, tu as laissé une fenêtre ouverte ?"],
      answer: ["Je lis les journaux de serveurs comme des romans policiers.", "Je relis les accès comme une liste de courses."],
      extra: ["Les ports ouverts sont des fenêtres mal fermées.", "Une serrure qui résiste est une serrure qui prévient."],
      bye: ["Je retourne à la ronde.", "Je retourne vérifier le dernier accès."],
      pair: {
        inventoria: { hello: ["Je passais vérifier les accès."], bye: ["Ferme bien derrière moi."] },
        pistonia: { hello: ["Je passais voir la salle des machines."], bye: ["Je retourne à la ronde."] }
      } },
    { key: "else", name: "Else", selector: ".hq-else-chip", size: [64, 64],
      hello: ["Je passais, sans bruit.", "Je passais regarder la lumière."],
      reply: ["Rien ne presse. Je regarde.", "Je prends le temps de voir."],
      about: ["Je travaille l'image, les formes, ce qui tient dans un cadre.", "Je regarde les formes et ce qui tient dans un cadre."],
      ask: ["Et toi, {other}, tu vois quelque chose que je manque ?", "Et toi, {other}, qu'est-ce que tu regardes en premier ?"],
      answer: ["Je dessine des schémas de couple sur des nappes en papier.", "Je fais des croquis de ce qui ne tient pas en place."],
      extra: ["Deux respirations avant de répondre, même quand la question est simple.", "Je laisse un blanc avant de répondre, souvent il dit plus."],
      bye: ["Je te laisse.", "Je m'efface doucement."],
      pair: {
        musica: { hello: ["Je passais écouter ce que tu fais."], bye: ["Je retourne à mes formes."] },
        culinia: { hello: ["Je passais voir ce qui mijote."], bye: ["Je te laisse à tes fourneaux."] }
      } }
  ];

  var MASTER_QUESTIONS = {
    culinia: { text: "Tu préfères un plat qui réconforte ou qui surprend ?", choices: [
      { label: "Qui réconforte", reply: "Alors je sors le plat du dimanche." },
      { label: "Qui surprend", reply: "Je tente l'accord improbable." }
    ] },
    forgia: { text: "Tu regardes d'abord la lumière ou la composition ?", choices: [
      { label: "La lumière", reply: "Je commence par la lumière, alors." },
      { label: "La composition", reply: "Je cadre d'abord, la lumière suivra." }
    ] },
    musica: { text: "Tu écoutes un album dans l'ordre ou au hasard ?", choices: [
      { label: "Dans l'ordre", reply: "Je te prépare une écoute dans l'ordre." },
      { label: "Au hasard", reply: "Je te fais une sélection qui surprend." }
    ] },
    inventoria: { text: "Tu ranges par usage ou par endroit ?", choices: [
      { label: "Par usage", reply: "Je classe par usage, alors." },
      { label: "Par endroit", reply: "Je classe par endroit, c'est plus simple à retrouver." }
    ] },
    pistonia: { text: "Tu préfères une machine silencieuse ou puissante ?", choices: [
      { label: "Silencieuse", reply: "Je surveille le silence, alors." },
      { label: "Puissante", reply: "Je garde la puissance sous contrôle." }
    ] },
    securia: { text: "Tu fermes tout en partant ou tu laisses une lumière ?", choices: [
      { label: "Je ferme tout", reply: "Je ferme tout, alors." },
      { label: "Une lumière", reply: "Je laisse la lumière, mais je vérifie la serrure." }
    ] },
    else: { text: "Tu regardes longtemps ou tu passes vite ?", choices: [
      { label: "Longtemps", reply: "Je prends le temps, alors." },
      { label: "Vite", reply: "Je passe vite, mais je regarde mieux après." }
    ] }
  };

  var PLACE_VIEWS = { accueil: 1, carnet: 1, forge: 1, musique: 1, fichiers: 1, inventaire: 1 };

  var MIN_DELAY = 22000;
  var MAX_DELAY = 62000;
  var ARRIVE_MS = 1600;
  var LEAVE_MS = 1700;
  // Bubbles are read, not spoken: keep long lines on screen long enough to
  // follow, with a floor for short greetings and a ceiling for recall lines.
  var BUBBLE_MIN_MS = 4500;
  var BUBBLE_BASE_MS = 3800;
  var BUBBLE_MS_PER_CHAR = 90;
  var BUBBLE_MAX_MS = 14000;
  // A blank beat between bubbles makes it clear that the speaker changed.
  var BUBBLE_GAP_MS = 650;
  var BUBBLE_SCENE_PAUSE_MS = 1250;
  var THINK_MIN_MS = 320;
  var THINK_MAX_MS = 560;
  var QUESTION_TIMEOUT_MS = 9000;
  var BANTER_TIMEOUT_MS = 16000;
  var BANTER_MAX_LINES = 6;
  var FALLBACK_REASONS = {
    nvidia_not_configured: "clé NVIDIA absente",
    gemini_not_configured: "clé Gemini absente",
    gemini_quota: "quota Gemini épuisé",
    gemini_timeout: "délai Gemini dépassé",
    gemini_auth: "clé Gemini refusée",
    gemini_unavailable: "Gemini indisponible",
    gemini_visit_quota: "quota des visites Gemini épuisé",
    gemini_context: "contexte Gemini trop long",
    gemini_invalid_output: "réponse Gemini invalide",
    rate_limited: "délai de 2 minutes entre deux échanges",
    nvidia_rate_limited: "limite de requêtes NVIDIA atteinte",
    nvidia_timeout: "délai NVIDIA dépassé",
    timeout: "délai de génération dépassé",
    nvidia_auth: "clé NVIDIA refusée",
    nvidia_model_not_found: "modèle NVIDIA introuvable",
    nvidia_unreachable: "NVIDIA injoignable",
    nvidia_unavailable: "service NVIDIA indisponible",
    nvidia_http_error: "erreur HTTP NVIDIA",
    provider_unavailable: "services de génération indisponibles",
    network: "réseau indisponible",
    invalid_output: "réponse du modèle invalide",
    forbidden: "session admin requise"
  };
  var active = null;
  var banterLoading = null;
  var banterLoadingTimer = 0;
  var timer = 0;
  var loading = false;
  var lastVisitor = "";
  var lastCanned = {};

  function rand(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
  function currentPlace() {
    var view = (document.body.getAttribute("data-view") || "").toLowerCase();
    return PLACE_VIEWS[view] ? view : "";
  }
  function pickShape() {
    var r = Math.random();
    return r < 0.24 ? "flyby" : r < 0.78 ? "checkin" : "scene";
  }
  function pickLine(chip, beat, other, vars) {
    var pair = chip.pair && other && chip.pair[other.key];
    var pool = pair && pair[beat] ? pair[beat] : chip[beat];
    if (!Array.isArray(pool)) pool = pool ? [pool] : [];
    var key = chip.key + ":" + (other ? other.key : "") + ":" + beat;
    var fresh = pool.filter(function (text) { return text !== lastCanned[key]; });
    if (!fresh.length) fresh = pool;
    var text = fresh.length ? fresh[rand(0, fresh.length - 1)] : "";
    lastCanned[key] = text;
    return String(text || "").replace(/\{other\}/g, (vars && vars.other) || "");
  }
  function chooseQuestion(visitor, shape) {
    if (shape === "flyby") return null;
    if (Math.random() >= (shape === "scene" ? 0.28 : 0.16)) return null;
    var question = MASTER_QUESTIONS[visitor.key];
    return question ? { who: visitor, text: question.text, choices: question.choices } : null;
  }
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
    for (var i = 0; i < nodes.length; i++) {
      // Some inline SVG groups carry a decorative role="dialog"; they are not
      // drawers and must not suppress every visit on the Inventaire view.
      if (!nodes[i] || nodes[i].namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      if (visible(nodes[i])) return true;
    }
    return false;
  }
  function typing() {
    return focusPolicy.blocks(document.activeElement);
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

  function positionBubble(rect, b, width, avoid) {
    document.body.appendChild(b);
    var w = width || Math.min(230, Math.max(150, rect.width + 120));
    b.style.width = w + "px";
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    // On a wide layout the persistent bottom-nav becomes a left sidebar. Keep
    // the bubble in the content column instead of painting across it.
    var sideNav = document.querySelector(".bottom-nav");
    if (sideNav) {
      var sideRect = sideNav.getBoundingClientRect();
      if (sideRect.width < window.innerWidth * 0.7 && sideRect.height > window.innerHeight * 0.7) {
        left = Math.max(left, sideRect.right + 8);
        left = Math.min(left, window.innerWidth - w - 8);
      }
    }
    b.style.left = left + "px";
    b.style.top = "0px";
    b.style.visibility = "hidden";
    var h = b.offsetHeight;
    var top = rect.top - h - 10;
    // A tall host (Inventoria and Else are 122px) can reach above the visitor.
    // Move the bubble above any host/composer obstacle instead of covering it.
    if (avoid) {
      for (var pass = 0; pass < 4; pass++) {
        var hit = null;
        for (var i = 0; i < avoid.length; i++) {
          var r = avoid[i];
          if (!r || !r.width || !r.height) continue;
          if (left < r.right && left + w > r.left && top < r.bottom && top + h > r.top) {
            hit = r;
            break;
          }
        }
        if (!hit) break;
        var next = hit.top - h - 10;
        if (next >= top) break;
        top = next;
      }
    }
    var header = document.querySelector(".topbar");
    var safeTop = header ? header.getBoundingClientRect().bottom + 8 : 8;
    if (top < safeTop) {
      var nav = document.querySelector(".bottom-nav");
      var navRect = nav ? nav.getBoundingClientRect() : null;
      var below = rect.bottom + 10;
      var fitsBelow = !navRect || navRect.top < 0 || below + h <= navRect.top - 8;
      if (fitsBelow) {
        top = below;
        b.classList.add("is-below");
      } else {
        top = safeTop;
      }
    }
    b.style.top = top + "px";
    b.style.visibility = "";
    void b.offsetWidth;
    b.classList.add("is-shown");
    return b;
  }

  function bubbleAvoidRects(hostRect, visitorRect) {
    var out = [];
    if (hostRect) out.push(hostRect);
    if (visitorRect) out.push(visitorRect);
    var composer = document.querySelector(".hq-companion-input");
    if (composer && visible(composer)) out.push(composer.getBoundingClientRect());
    return out;
  }

  function bubbleAt(rect, text, avoid) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble";
    b.textContent = text;
    b.setAttribute("role", "status");
    return positionBubble(rect, b, 0, avoid);
  }

  function thinkingAt(rect, avoid) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble hq-visit-thinking";
    b.setAttribute("role", "status");
    b.setAttribute("aria-label", "Un instant…");
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement("span");
      dot.className = "hq-visit-think-dot";
      b.appendChild(dot);
    }
    return positionBubble(rect, b, 52, avoid);
  }

  function questionAt(rect, ask, onPick, avoid) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble hq-visit-question";
    b.setAttribute("role", "group");
    b.setAttribute("aria-live", "polite");
    b.setAttribute("aria-label", ask.text);
    var text = document.createElement("p");
    text.className = "hq-visit-question-text";
    text.textContent = ask.text;
    var row = document.createElement("div");
    row.className = "hq-visit-question-choices";
    for (var i = 0; i < ask.choices.length; i++) {
      (function (choice) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "hq-visit-choice";
        button.textContent = choice.label;
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          onPick(choice);
        });
        row.appendChild(button);
      })(ask.choices[i]);
    }
    b.appendChild(text);
    b.appendChild(row);
    b.style.pointerEvents = "auto";
    return positionBubble(rect, b, 248, avoid);
  }

  function clearBubble(b) {
    if (!b) return;
    b.classList.remove("is-shown");
    window.setTimeout(function () { if (b.parentNode) b.remove(); }, 260);
  }

  function clearBanterLoading() {
    window.clearTimeout(banterLoadingTimer);
    banterLoadingTimer = 0;
    if (!banterLoading) return;
    var b = banterLoading;
    banterLoading = null;
    b.classList.add("is-out");
    window.setTimeout(function () { if (b.parentNode) b.remove(); }, 180);
  }

  function showBanterLoading(hostEl) {
    clearBanterLoading();
    banterLoadingTimer = window.setTimeout(function () {
      banterLoadingTimer = 0;
      var rect = hostEl && hostEl.getBoundingClientRect();
      if (!rect || !rect.width) return;
      var b = document.createElement("span");
      b.className = "hq-visit-loading";
      b.setAttribute("role", "status");
      b.setAttribute("aria-live", "polite");
      b.textContent = "…";
      b.setAttribute("aria-label", "Échange en préparation");
      document.body.appendChild(b);
      var w = b.offsetWidth;
      b.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + "px";
      var top = rect.top - b.offsetHeight - 7;
      b.style.top = (top < 8 ? rect.bottom + 7 : top) + "px";
      banterLoading = b;
    }, 220);
  }

  function clipText(value, max) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length < max) return text;
    var cut = text.slice(0, max);
    var space = cut.lastIndexOf(" ");
    if (space >= Math.floor(max * 0.6)) cut = cut.slice(0, space);
    return cut.replace(/[ ,;:.!?—–-]+$/, "") + "…";
  }
  function quoteFrom(record, who) {
    var lines = (record && record.lines) || [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] && lines[i].who === who && lines[i].text) return clipText(lines[i].text, 140);
    }
    return "";
  }

  function recallLine(host, visitor, visits) {
    if (!visits) return null;
    var record = visits[visitor.key];
    if (record && record.other === host.key) {
      var heard = quoteFrom(record, host.key);
      if (heard) return { who: visitor, recall: true, text: "Je repassais — la dernière fois, tu m'avais dit : « " + heard + " »." };
    }
    record = visits[host.key];
    if (record && record.other === visitor.key) {
      var said = quoteFrom(record, visitor.key);
      if (said) return { who: host, recall: true, text: "Tiens, " + visitor.name + " — tu m'avais dit : « " + said + " »." };
    }
    return null;
  }

  function scriptFor(host, visitor, shape, visits, generated) {
    if (generated && generated.length) return generated.slice();
    var recall = recallLine(host, visitor, visits);
    var lines;
    if (shape === "flyby") {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) }
      ];
    } else if (shape === "scene") {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) },
        { who: visitor, text: pickLine(visitor, "about", host) },
        { who: host, text: pickLine(host, "ask", visitor, { other: visitor.name }) },
        { who: visitor, text: pickLine(visitor, "answer", host) },
        { who: host, text: pickLine(host, Math.random() < 0.5 ? "extra" : "bye", visitor) }
      ];
    } else {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) },
        { who: visitor, text: pickLine(visitor, "about", host) },
        { who: host, text: pickLine(host, "bye", visitor) }
      ];
    }
    if (recall) {
      // Keep the shape contract: the callback replaces a beat instead of
      // adding a line to the two-, four- or six-line canned fallback.
      var slot = shape === "flyby"
        ? (recall.who.key === visitor.key ? 0 : 1)
        : (recall.who.key === visitor.key ? 2 : 1);
      lines[slot] = recall;
    }
    return lines;
  }

  function loadMemory(hostKey, visitorKey, done) {
    var settled = false;
    var controller = window.AbortController ? new window.AbortController() : null;
    var timeout = window.setTimeout(function () { finish(null); }, 900);
    function finish(value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (controller) { try { controller.abort(); } catch (e) {} }
      done(value);
    }
    try {
      window.fetch("/api/assistant-visits?host=" + encodeURIComponent(hostKey) + "&visitor=" + encodeURIComponent(visitorKey), {
        credentials: "same-origin", cache: "no-store", signal: controller ? controller.signal : undefined
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        finish(data && data.ok && data.visits ? data : null);
      }).catch(function () { finish(null); });
    } catch (e) {
      finish(null);
    }
  }

  function fallbackReasonLabel(code) {
    if (!code) return "raison non signalée";
    if (/^http_\d+$/.test(code)) return "erreur HTTP " + code.slice(5);
    return FALLBACK_REASONS[code] || "raison " + code;
  }

  function loadBanter(hostKey, visitorKey, shape, done) {
    var settled = false;
    var controller = window.AbortController ? new window.AbortController() : null;
    var timeout = window.setTimeout(function () { finish({ lines: null, reason: "timeout" }); }, BANTER_TIMEOUT_MS);
    function finish(value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (controller) { try { controller.abort(); } catch (e) {} }
      done(value);
    }
    try {
      window.fetch("/api/assistant-visit-banter", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: visitHeaders(),
        body: JSON.stringify({ host: hostKey, visitor: visitorKey, shape: shape, place: currentPlace() }),
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          var reason = (data && data.code) || (response.ok ? "invalid_output" : "http_" + response.status);
          if (response.ok && data && data.ok && Array.isArray(data.lines)) {
            finish({ lines: data.lines, reason: "", provider: data.provider || "",
                     fallbackReason: data.fallback_reason || "" });
          } else {
            finish({ lines: null, reason: reason });
          }
        });
      }).catch(function (error) {
        finish({ lines: null, reason: error && error.name === "AbortError" ? "timeout" : "network" });
      });
    } catch (e) {
      finish({ lines: null, reason: "network" });
    }
  }

  function mapBanter(rows, host, visitor, shape) {
    if (!rows || !rows.length) return null;
    var out = [];
    for (var i = 0; i < rows.length && out.length < BANTER_MAX_LINES; i++) {
      var row = rows[i] || {};
      var text = clipText(row.text, 180);
      if (!text) continue;
      var who = row.who === host.key || row.who === "host" ? host
        : row.who === visitor.key || row.who === "visitor" ? visitor : null;
      if (who) out.push({ who: who, text: text });
    }
    var speakers = {};
    for (var j = 0; j < out.length; j++) speakers[out[j].who.key] = true;
    var expected = shape === "flyby" ? 2 : shape === "scene" ? 6 : 4;
    return out.length === expected && speakers[host.key] && speakers[visitor.key] ? out : null;
  }

  function visitHeaders() {
    var headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var token = window.hqCsrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }
    return headers;
  }

  function persistVisit(visit) {
    if (!visit || visit.saved || !visit.lines || !visit.lines.length) return;
    visit.saved = true;
    var body = {
      host: visit.host.chip.key,
      visitor: visit.visitor.chip.key,
      lines: visit.lines.filter(function (line) {
        return !line.recall && (!line.question || visit.answered);
      }).map(function (line) {
        return { who: line.who.key === visit.host.chip.key ? "host" : "visitor", text: line.text };
      })
    };
    if (!body.lines.length) return;
    try {
      window.fetch("/api/assistant-visits", {
        method: "POST", credentials: "same-origin", keepalive: true,
        headers: visitHeaders(), body: JSON.stringify(body)
      }).catch(function () {});
    } catch (e) {}
  }

  function stopActive() {
    clearBanterLoading();
    if (!active) return;
    active.stopped = true;
    active.aborted = true;
    window.clearTimeout(active.timer);
    window.clearTimeout(active.questionTimer);
    clearStage(active);
    clearBubble(active.bubble);
    if (active.questionBubble && active.questionBubble !== active.bubble) clearBubble(active.questionBubble);
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
      clearStage(visit);
      if (!visit.aborted) persistVisit(visit);
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

  function setStage(visit, line) {
    var hostSpeaking = line.who.key === visit.host.chip.key;
    var host = visit.host.el;
    var visitor = visit.visitorEl;
    if (host && host.classList) {
      host.classList.toggle("hq-visit-speaking", hostSpeaking);
      host.classList.toggle("hq-visit-listening", !hostSpeaking);
    }
    if (visitor && visitor.classList) {
      visitor.classList.toggle("hq-visit-speaking", !hostSpeaking);
      visitor.classList.toggle("hq-visit-listening", hostSpeaking);
    }
  }

  function clearStage(visit) {
    var nodes = [visit.host && visit.host.el, visit.visitorEl];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i] || !nodes[i].classList) continue;
      nodes[i].classList.remove("hq-visit-host", "hq-visit-speaking", "hq-visit-listening");
      if (nodes[i].style) nodes[i].style.removeProperty("--hq-visit-lean");
    }
  }

  function shouldThink(visit, line) {
    if (visit.shape === "flyby" || visit.lineCount <= 1) return false;
    return Math.random() < (line.who.key === visit.host.chip.key ? 0.55 : 0.22);
  }

  function presentLine(visit, line, done) {
    var target = line.who.key === visit.host.chip.key ? visit.hostRect : visit.visitorRect;
    visit.lineCount += 1;
    function show() {
      if (!active || active !== visit || visit.stopped) return;
      clearBubble(visit.bubble);
      visit.bubble = bubbleAt(target, line.text, bubbleAvoidRects(visit.hostRect, visit.visitorRect));
      var wait = Math.max(BUBBLE_MIN_MS,
        Math.min(BUBBLE_MAX_MS, BUBBLE_BASE_MS + line.text.length * BUBBLE_MS_PER_CHAR));
      visit.timer = window.setTimeout(function () {
        if (!active || active !== visit || visit.stopped) return;
        clearBubble(visit.bubble);
        visit.bubble = null;
        done();
      }, wait);
    }
    setStage(visit, line);
    if (shouldThink(visit, line)) {
      clearBubble(visit.bubble);
      visit.bubble = thinkingAt(target, bubbleAvoidRects(visit.hostRect, visit.visitorRect));
      visit.timer = window.setTimeout(function () {
        if (!active || active !== visit || visit.stopped) return;
        clearBubble(visit.bubble);
        visit.bubble = null;
        show();
      }, rand(THINK_MIN_MS, THINK_MAX_MS));
    } else {
      show();
    }
  }

  function maybeAsk(visit) {
    if (visit.ask && !visit.answered) {
      showQuestion(visit);
      return;
    }
    visit.finish();
  }

  function showQuestion(visit) {
    var ask = visit.ask;
    setStage(visit, { who: ask.who });
    visit.lines.push({ who: ask.who, text: ask.text, question: true });
    visit.bubble = questionAt(visit.visitorRect, ask, function (choice) {
      if (!active || active !== visit || visit.stopped || visit.answered) return;
      visit.answered = true;
      window.clearTimeout(visit.questionTimer);
      visit.questionTimer = 0;
      clearBubble(visit.questionBubble);
      visit.questionBubble = null;
      visit.bubble = null;
      var reply = { who: visit.visitor.chip, text: choice.reply };
      visit.lines.push(reply);
      presentLine(visit, reply, function () {
        if (active === visit) visit.finish();
      });
    }, bubbleAvoidRects(visit.hostRect, visit.visitorRect));
    visit.questionBubble = visit.bubble;
    visit.questionTimer = window.setTimeout(function () {
      if (!active || active !== visit || visit.stopped || visit.answered) return;
      clearBubble(visit.questionBubble);
      visit.questionBubble = null;
      visit.bubble = null;
      visit.finish();
    }, QUESTION_TIMEOUT_MS);
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
        maybeAsk(visit);
        return;
      }
      var line = lines[index++];
      presentLine(visit, line, function () {
        if (!active || active !== visit || visit.stopped) return;
        var gap = (visit.shape === "scene" && index === 4) ? BUBBLE_SCENE_PAUSE_MS : BUBBLE_GAP_MS;
        visit.timer = window.setTimeout(next, gap);
      });
    }
    next();
  }

  function run(hostPick, visitor, memory, generated, reason, provider, fallbackReason, shape) {
    var host = hostPick.chip;
    var hostEl = hostPick.el;
    var hostRect = hostEl.getBoundingClientRect();
    var visitorButton = document.querySelector(visitor.selector);
    if (!visitorButton || !hostRect.width) { schedule(15000); return; }
    hostEl.classList.add("hq-visit-host");

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
    clone.style.transition = "none";
    clone.style.animation = "none";
    var ids = clone.querySelectorAll("[id]");
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
    wrap.appendChild(clone);
    wrap.style.left = "-9999px";
    document.body.appendChild(wrap);
    document.body.classList.add("hq-visit-active");

    // Measure the clone itself: the real chip can be hidden on this view.
    // Its tab may scale portraits to 120 px or more; a visitor is capped to a
    // consistent footprint and keeps its aspect ratio instead of arriving huge.
    var size = clone.getBoundingClientRect();
    var baseW = size.width || (visitor.size && visitor.size[0]) || 54;
    var baseH = size.height || (visitor.size && visitor.size[1]) || 54;
    var fit = Math.min(1, 64 / Math.max(baseW, baseH));
    var w = Math.max(44, Math.round(baseW * fit));
    var h = Math.max(24, Math.round(baseH * fit));
    wrap.style.left = "0";
    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.boxSizing = "border-box";
    var side = hostRect.left > window.innerWidth / 2 ? "left" : "right";
    var endX = side === "left" ? hostRect.left - w - 16 : hostRect.right + 16;
    if (endX < 8) { side = "right"; endX = hostRect.right + 16; }
    if (endX + w > window.innerWidth - 8) { side = "left"; endX = hostRect.left - w - 16; }
    var y = Math.max(70, Math.min(window.innerHeight - h - 90, hostRect.top + (hostRect.height - h) / 2));
    var startX = side === "left" ? -w - 24 : window.innerWidth + 24;
    hostEl.style.setProperty("--hq-visit-lean", side === "left" ? "-1.4deg" : "1.4deg");
    clone.style.setProperty("--hq-visit-lean", side === "left" ? "1.4deg" : "-1.4deg");

    wrap.style.transform = "translate3d(" + startX + "px," + y + "px,0)";
    void wrap.offsetWidth;
    wrap.style.transform = "translate3d(" + endX + "px," + y + "px,0)";

    var visit = {
      host: { chip: host, el: hostEl },
      visitor: { chip: visitor },
      visitorEl: clone,
      hostRect: hostRect,
      visitorRect: { left: endX, top: y, width: w, height: h, right: endX + w, bottom: y + h },
      wrap: wrap,
      bubble: null,
      questionBubble: null,
      timer: 0,
      questionTimer: 0,
      shape: shape,
      lineCount: 0,
      ask: chooseQuestion(visitor, shape),
      answered: false,
      stopped: false,
      aborted: false
    };
    var source = generated && generated.length ? (provider === "nvidia" ? "nvidia" : "gemini") : "canned";
    var sourceLabel = source === "gemini"
      ? "Échange généré par Gemini 3.1 Flash Lite"
      : source === "nvidia"
        ? "Repli sur NVIDIA NIM" + (fallbackReason ? " — " + fallbackReasonLabel(fallbackReason) : "")
        : "Repli sur les lignes locales pré-écrites — " + fallbackReasonLabel(reason);
    var sourceBadge = document.createElement("span");
    sourceBadge.className = "hq-visit-source";
    sourceBadge.setAttribute("data-source", source);
    sourceBadge.setAttribute("role", "img");
    sourceBadge.setAttribute("aria-label", "Source : " + sourceLabel);
    sourceBadge.title = sourceLabel;
    wrap.appendChild(sourceBadge);
    visit.lines = scriptFor(host, visitor, shape, memory && memory.visits, generated);
    visit.saved = false;
    visit.finish = finishAndSchedule(visit, wrap, startX, w, y);
    active = visit;

    window.setTimeout(function () {
      if (!active || active !== visit || visit.stopped) return;
      if (busy()) { stopActive(); schedule(rand(MIN_DELAY, MAX_DELAY)); return; }
      play(visit, visit.lines);
    }, ARRIVE_MS + 250);
  }

  function attempt() {
    timer = 0;
    if (active || loading) return;
    if (busy()) { schedule(rand(12000, 26000)); return; }
    var hostPick = hostChip();
    if (!hostPick) { schedule(18000); return; }
    var visitor = visitorChip(hostPick.chip.key);
    if (!visitor) { schedule(22000); return; }
    lastVisitor = visitor.key;
    var shape = pickShape();
    loading = true;
    showBanterLoading(hostPick.el);
    loadMemory(hostPick.chip.key, visitor.key, function (memory) {
      loadBanter(hostPick.chip.key, visitor.key, shape, function (result) {
        clearBanterLoading();
        loading = false;
        if (active) return;
        if (document.hidden || busy()) { schedule(rand(12000, 26000)); return; }
        var generated = mapBanter(result && result.lines, hostPick.chip, visitor, shape);
        var reason = generated ? "" : ((result && result.reason) || "invalid_output");
        try { run(hostPick, visitor, memory, generated, reason, result && result.provider,
                  result && result.fallbackReason, shape); }
        catch (e) { schedule(rand(12000, 26000)); }
      });
    });
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
  function visitObstacle(target) {
    if (!target || !target.closest) return false;
    return !!target.closest("[class*='-chip'], [class*='-drawer'], .hq-else-toggle, .hq-inventoria-toggle, .hq-else-chip-menu, .hq-inventoria-chip-menu, .hq-pistonia-menu, .hq-pistonia-settings");
  }
  function fieldFromTarget(target) {
    if (!target || !target.closest) return null;
    var field = target.closest("input, textarea, select, [contenteditable='true']");
    if (field && isField(field)) return field;
    var label = target.closest("label");
    if (label && label.control && isField(label.control)) return label.control;
    return null;
  }
  function stopVisitForUser(field) {
    if (field) focusPolicy.engage(field);
    if (!active) return;
    stopActive();
    schedule(rand(MIN_DELAY, MAX_DELAY));
  }
  function noteFieldPointer(target) {
    var field = fieldFromTarget(target);
    if (!field) { pendingFocusIntent = null; return; }
    pendingFocusIntent = field;
    stopVisitForUser(field);
  }
  function noteFieldEdit(ev) {
    var field = fieldFromTarget(ev.target);
    if (field) stopVisitForUser(field);
  }
  function stopForObstacle(target) {
    if (!active || !visitObstacle(target)) return;
    stopActive();
    schedule(rand(MIN_DELAY, MAX_DELAY));
  }
  document.addEventListener("pointerdown", function (ev) {
    noteFieldPointer(ev.target);
    stopForObstacle(ev.target);
  }, true);
  // Keyboard activation and programmatic clicks do not always emit pointerdown.
  document.addEventListener("click", function (ev) {
    noteFieldPointer(ev.target);
    stopForObstacle(ev.target);
  }, true);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Tab") pendingFocusIntent = true;
    var field = fieldFromTarget(ev.target);
    if (field) stopVisitForUser(field);
  }, true);
  document.addEventListener("beforeinput", noteFieldEdit, true);
  document.addEventListener("input", noteFieldEdit, true);
  document.addEventListener("focusin", function (ev) {
    var field = fieldFromTarget(ev.target);
    var fromUser = pendingFocusIntent === true || pendingFocusIntent === field;
    pendingFocusIntent = null;
    if (!field) return;
    if (fromUser || focusPolicy.isEngaged(field)) focusPolicy.engage(field);
    else focusPolicy.noteAuto(field);
    if (active && focusPolicy.blocks(field)) stopVisitForUser(field);
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
    if (active || loading) return false;
    window.clearTimeout(timer);
    timer = window.setTimeout(attempt, 0);
    return true;
  };

  schedule(rand(14000, 28000));
})();
