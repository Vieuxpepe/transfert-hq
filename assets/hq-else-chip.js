/* Transfert HQ — Else image chip + speech bubble (sister of Transferania). No Live2D. */
(function () {
  "use strict";

  const PORTRAIT = "/assets/companion/else-chip.jpg";
  const PORTRAIT_2X = "/assets/companion/else-chip@2x.jpg";
  const LS_OPEN = "hq_else_chip_open_v1";
  const LS_EXPANDED = "hq_else_chip_expanded_v1";
  const LS_FLOAT = "hq_else_chip_float_v1";
  const LS_VISIBLE = "hq_else_chip_visible_v1";
  const LS_TOGGLE_FLOAT = "hq_else_toggle_float_v1";
  const LS_PROACTIVE = "hq_else_proactive_v1";
  const IDLE_LINE = "Else est là — touche pour parler.";
  const AMBIENT_MIN_MS = 7 * 60 * 1000;
  const AMBIENT_SPAN_MS = 8 * 60 * 1000;
  const AMBIENT_FIRST_MS = 75 * 1000;
  const PROACTIVE_MIN_MS = 11 * 60 * 1000;
  const PROACTIVE_SPAN_MS = 10 * 60 * 1000;
  const PROACTIVE_FIRST_MS = 2.5 * 60 * 1000;
  const DRAG_THRESHOLD_PX = 8;
  const LONG_PRESS_RESET_MS = 700;

  function clampNum(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function readXY(win, key) {
    try {
      const raw = win.localStorage.getItem(key);
      if (!raw) return { x: 0, y: 0 };
      const parsed = JSON.parse(raw);
      return {
        x: clampNum(parsed && parsed.x, -1600, 120),
        y: clampNum(parsed && parsed.y, -1600, 120),
      };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function persistXY(win, key, pos) {
    try {
      win.localStorage.setItem(key, JSON.stringify({
        x: Math.round((pos && pos.x) || 0),
        y: Math.round((pos && pos.y) || 0),
      }));
    } catch (_) {}
  }

  function clampFloat(win, x, y, minVisible) {
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 640;
    const pad = Math.max(28, Number(minVisible) || 48);
    // Elements are fixed to bottom-right; keep them mostly on-screen.
    return {
      x: clampNum(x, -(vw - pad), 28),
      y: clampNum(y, -(vh - pad), 48),
    };
  }

  function bindFloatDrag(win, opts) {
    const el = opts.el;
    const host = opts.host || el;
    const key = opts.storageKey;
    const draggingClass = opts.draggingClass || "is-dragging";
    const minVisible = opts.minVisible || 48;
    let pos = readXY(win, key);
    let drag = null;
    let suppressClick = false;

    function apply() {
      const next = clampFloat(win, pos.x, pos.y, minVisible);
      pos.x = next.x;
      pos.y = next.y;
      host.style.transform = "translate3d(" + next.x.toFixed(1) + "px," + next.y.toFixed(1) + "px,0)";
      host.classList.toggle("is-floated", Math.hypot(next.x, next.y) > 2);
    }

    function reset(resetOpts) {
      if (drag && drag.longTimer) {
        win.clearTimeout(drag.longTimer);
        drag.longTimer = null;
      }
      drag = null;
      host.classList.remove(draggingClass);
      pos = { x: 0, y: 0 };
      if (resetOpts && resetOpts.animate === false) {
        const prev = host.style.transition;
        host.style.transition = "none";
        apply();
        persistXY(win, key, pos);
        win.requestAnimationFrame(() => { host.style.transition = prev || ""; });
        return;
      }
      apply();
      persistXY(win, key, pos);
    }

    apply();
    win.addEventListener("resize", apply);

    el.addEventListener("pointerdown", (ev) => {
      if (ev.button && ev.button !== 0) return;
      if (drag) return;
      if (typeof opts.canStart === "function" && opts.canStart(ev) === false) return;
      drag = {
        id: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        origX: pos.x,
        origY: pos.y,
        moved: false,
        longTimer: win.setTimeout(() => {
          if (!drag || drag.moved) return;
          suppressClick = true;
          reset();
          drag = null;
          try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
        }, LONG_PRESS_RESET_MS),
      };
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    });

    el.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        suppressClick = true;
        host.classList.add(draggingClass);
        if (drag.longTimer) {
          win.clearTimeout(drag.longTimer);
          drag.longTimer = null;
        }
      }
      pos.x = drag.origX + dx;
      pos.y = drag.origY + dy;
      apply();
      if (ev.cancelable) ev.preventDefault();
    });

    function endPointer(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      if (drag.longTimer) {
        win.clearTimeout(drag.longTimer);
        drag.longTimer = null;
      }
      const moved = drag.moved;
      drag = null;
      host.classList.remove(draggingClass);
      if (moved) {
        apply();
        persistXY(win, key, pos);
        win.setTimeout(() => { suppressClick = false; }, 0);
      }
    }

    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);

    return {
      apply,
      reset,
      getPos: () => ({ x: pos.x, y: pos.y }),
      consumeClickSuppressed: () => {
        if (!suppressClick) return false;
        suppressClick = false;
        return true;
      },
    };
  }

  function deviceId(win) {
    try {
      if (typeof win.hqDeviceId === "function") return String(win.hqDeviceId() || "");
      return String(win.localStorage.getItem("hq_device_id") || "");
    } catch (_) {
      return "";
    }
  }

  function withDevice(win, payload) {
    const did = deviceId(win);
    return did ? Object.assign({ device_id: did }, payload) : payload;
  }

  async function fetchJson(win, url, body) {
    if (typeof win.fetchJson === "function") return win.fetchJson(url, body);
    const opts = body == null
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
    const res = await win.fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || "Erreur");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function aiUrl(win, extra) {
    const did = deviceId(win);
    const q = [];
    if (did) q.push("device_id=" + encodeURIComponent(did));
    if (extra) q.push(extra);
    return "/api/ai" + (q.length ? "?" + q.join("&") : "");
  }

  function reducedMotion(win) {
    try {
      return !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  function typewriter(win, el, text, done) {
    const full = String(text || "");
    if (!el) {
      if (done) done();
      return;
    }
    if (reducedMotion(win) || full.length < 3) {
      el.textContent = full;
      if (done) done();
      return;
    }
    let i = 0;
    el.textContent = "";
    const tick = () => {
      i += 1;
      el.textContent = full.slice(0, i);
      if (i >= full.length) {
        if (done) done();
        return;
      }
      win.setTimeout(tick, i < 24 ? 18 : 12);
    };
    tick();
  }

  function sisterApi(win) {
    if (win.HqSisterCore && typeof win.HqSisterCore.ensureSister === "function") {
      return win.HqSisterCore.ensureSister(win);
    }
    return (win.HqSister && win.HqSister.__ready) ? win.HqSister : null;
  }

  function mount(win) {
    const doc = win.document;
    if (doc.getElementById("hq-else")) return;
    if (doc.getElementById("hq-else-toggle")) return;
    const sis = sisterApi(win);

    const root = doc.createElement("div");
    root.id = "hq-else";
    root.className = "hq-else";

    const bubble = doc.createElement("div");
    bubble.className = "hq-else-bubble";
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "Else");

    const head = doc.createElement("div");
    head.className = "hq-else-head";
    const title = doc.createElement("span");
    title.className = "hq-else-title";
    title.textContent = "Else";

    const ambientToggle = doc.createElement("button");
    ambientToggle.type = "button";
    ambientToggle.className = "hq-else-head-btn hq-else-ambient-toggle";
    ambientToggle.textContent = "Banter";
    ambientToggle.title = "Banter sœurs (ambiant)";
    ambientToggle.setAttribute("aria-label", "Activer ou couper le banter sœurs");

    const reactToggle = doc.createElement("button");
    reactToggle.type = "button";
    reactToggle.className = "hq-else-head-btn hq-else-react-toggle";
    reactToggle.textContent = "Réact.";
    reactToggle.title = "Réactions sœur (après ambient Transferania)";
    reactToggle.setAttribute("aria-label", "Activer ou couper les réactions sœur");

    const proactiveToggle = doc.createElement("button");
    proactiveToggle.type = "button";
    proactiveToggle.className = "hq-else-head-btn hq-else-proactive-toggle";
    proactiveToggle.textContent = "Pro.";
    proactiveToggle.title = "Else proactive (asides rares)";
    proactiveToggle.setAttribute("aria-label", "Activer ou couper les asides proactifs d'Else");

    const sisterBtn = doc.createElement("button");
    sisterBtn.type = "button";
    sisterBtn.className = "hq-else-head-btn hq-else-sister-btn";
    sisterBtn.textContent = "Sœurs";
    sisterBtn.title = "Sœurs — sujet manuel";
    sisterBtn.setAttribute("aria-label", "Dialogue entre sœurs");
    const expandBtn = doc.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "hq-else-head-btn";
    expandBtn.textContent = "⤢";
    expandBtn.title = "Agrandir le chat";
    expandBtn.setAttribute("aria-label", "Agrandir le chat");
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "hq-else-head-btn";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Fermer");
    head.append(title, ambientToggle, reactToggle, proactiveToggle, sisterBtn, expandBtn, closeBtn);

    const line = doc.createElement("p");
    line.className = "hq-else-line";
    line.textContent = IDLE_LINE;

    const peek = doc.createElement("div");
    peek.className = "hq-else-peek";
    peek.hidden = true;
    peek.setAttribute("aria-live", "polite");

    const sisterStrip = doc.createElement("div");
    sisterStrip.className = "hq-else-sister-strip";
    sisterStrip.hidden = true;
    sisterStrip.setAttribute("aria-label", "Transcript sœurs");

    const log = doc.createElement("div");
    log.className = "hq-else-log";

    const form = doc.createElement("form");
    form.className = "hq-else-compose";
    const input = doc.createElement("input");
    input.type = "text";
    input.maxLength = 1600;
    input.placeholder = "Parler à Else…";
    input.autocomplete = "off";
    const send = doc.createElement("button");
    send.type = "submit";
    send.textContent = "Envoyer";
    form.append(input, send);

    const sisterBar = doc.createElement("div");
    sisterBar.className = "hq-else-sister-bar";
    sisterBar.hidden = true;
    const sisterTopic = doc.createElement("input");
    sisterTopic.type = "text";
    sisterTopic.maxLength = 200;
    sisterTopic.placeholder = "Sujet pour les sœurs (optionnel)…";
    sisterTopic.autocomplete = "off";
    const sisterGo = doc.createElement("button");
    sisterGo.type = "button";
    sisterGo.textContent = "Parler";
    const sisterNudge = doc.createElement("button");
    sisterNudge.type = "button";
    sisterNudge.className = "hq-else-sister-nudge";
    sisterNudge.textContent = "↔";
    sisterNudge.title = "Pousser un peu les sœurs (2× = banter)";
    sisterNudge.setAttribute("aria-label", "Nudge entre sœurs");
    sisterBar.append(sisterTopic, sisterGo, sisterNudge);

    bubble.append(head, line, peek, sisterStrip, sisterBar, log, form);

    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "hq-else-chip";
    chip.title = "Else — glisser pour déplacer · appui long pour réinitialiser · double-tap = nudge";
    chip.setAttribute("aria-label", "Else — glisser ou ouvrir");
    const ring = doc.createElement("span");
    ring.className = "hq-else-chip-ring";
    ring.setAttribute("aria-hidden", "true");
    const img = doc.createElement("img");
    img.className = "hq-else-chip-avatar";
    img.src = PORTRAIT;
    img.srcset = PORTRAIT + " 1x, " + PORTRAIT_2X + " 2x";
    img.alt = "Else";
    img.decoding = "async";
    img.loading = "lazy";
    img.draggable = false;
    chip.append(ring, img);

    root.append(bubble, chip);
    doc.body.appendChild(root);

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.id = "hq-else-toggle";
    toggle.className = "hq-else-toggle";
    toggle.title = "Replier / afficher Else · glisser pour déplacer · appui long = reset";
    toggle.setAttribute("aria-label", "Replier ou afficher Else");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", "hq-else");
    const toggleGrip = doc.createElement("span");
    toggleGrip.className = "hq-else-toggle-grip";
    toggleGrip.setAttribute("aria-hidden", "true");
    toggleGrip.textContent = "⋮⋮";
    const toggleLabel = doc.createElement("span");
    toggleLabel.className = "hq-else-toggle-label";
    toggleLabel.textContent = "Else";
    const toggleChevron = doc.createElement("span");
    toggleChevron.className = "hq-else-toggle-chevron";
    toggleChevron.setAttribute("aria-hidden", "true");
    toggleChevron.textContent = "▾";
    toggle.append(toggleGrip, toggleLabel, toggleChevron);
    doc.body.appendChild(toggle);

    let chatBusy = false;
    let messages = [];
    let open = false;
    let expanded = false;
    let chipVisible = true;
    let proactiveOn = true;
    let listenPulse = null;
    let peekTimer = null;
    let togglePulseTimer = null;

    try {
      const rawPro = win.localStorage.getItem(LS_PROACTIVE);
      if (rawPro === "0") proactiveOn = false;
    } catch (_) {}

    function sisterBusy() {
      return !!(sis && sis.isBusy && sis.isBusy());
    }

    function syncChromeBusy(on) {
      const busy = !!on || sisterBusy() || chatBusy;
      root.classList.toggle("is-busy", busy);
      send.disabled = busy;
      input.disabled = busy;
      sisterGo.disabled = busy;
      sisterNudge.disabled = busy;
      sisterBtn.disabled = busy;
      sisterTopic.disabled = busy;
      ambientToggle.disabled = busy;
      reactToggle.disabled = busy;
      proactiveToggle.disabled = busy;
    }

    function syncPrefToggles() {
      const amb = sis ? sis.ambientEnabled() : true;
      const rea = sis ? sis.reactEnabled() : true;
      ambientToggle.classList.toggle("is-on", amb);
      ambientToggle.setAttribute("aria-pressed", amb ? "true" : "false");
      ambientToggle.title = amb ? "Banter sœurs activé" : "Banter sœurs coupé";
      reactToggle.classList.toggle("is-on", rea);
      reactToggle.setAttribute("aria-pressed", rea ? "true" : "false");
      reactToggle.title = rea ? "Réations sœur activées" : "Réations sœur coupées";
      proactiveToggle.classList.toggle("is-on", proactiveOn);
      proactiveToggle.setAttribute("aria-pressed", proactiveOn ? "true" : "false");
      proactiveToggle.title = proactiveOn ? "Else proactive activée" : "Else proactive coupée";
    }

    function setProactive(on) {
      proactiveOn = on !== false;
      try { win.localStorage.setItem(LS_PROACTIVE, proactiveOn ? "1" : "0"); } catch (_) {}
      syncPrefToggles();
      return proactiveOn;
    }

    function renderSisterStrip() {
      const core = win.HqSisterCore || {};
      const rows = sis
        ? sis.stripRows(6)
        : (core.stripRows ? core.stripRows(messages, 6) : []);
      const label = (sis && sis.labelSpeaker) || core.labelSpeaker || ((s) => s);
      sisterStrip.replaceChildren();
      sisterStrip.hidden = !expanded || !rows.length;
      rows.forEach((m) => {
        const row = doc.createElement("button");
        row.type = "button";
        row.className = "hq-else-sister-row is-" + m.speaker;
        row.textContent = label(m.speaker) + " · " + String(m.text);
        row.title = "Faire réagir l'autre sœur";
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!sis || sis.isBusy() || !sis.reactEnabled()) return;
          const speaker = m.speaker === "else" ? "transferania" : "else";
          sis.runReact(String(m.text || ""), speaker);
        });
        sisterStrip.appendChild(row);
      });
      sisterStrip.scrollTop = sisterStrip.scrollHeight;
    }

    function pulseToggle(ms) {
      toggle.classList.add("is-pulse");
      if (togglePulseTimer) win.clearTimeout(togglePulseTimer);
      togglePulseTimer = win.setTimeout(() => {
        toggle.classList.remove("is-pulse");
        togglePulseTimer = null;
      }, Math.max(600, Number(ms) || 1200));
    }

    function setChipVisible(on, opts) {
      const next = on !== false;
      const force = !!(opts && opts.force);
      if (next === chipVisible && !force) return chipVisible;
      chipVisible = next;
      root.hidden = !chipVisible;
      toggle.classList.toggle("is-collapsed", !chipVisible);
      toggle.setAttribute("aria-expanded", chipVisible ? "true" : "false");
      toggleChevron.textContent = chipVisible ? "▾" : "▸";
      toggle.title = chipVisible
        ? "Replier Else · glisser pour déplacer · appui long = reset"
        : "Afficher Else · glisser pour déplacer · appui long = reset";
      try { win.localStorage.setItem(LS_VISIBLE, chipVisible ? "1" : "0"); } catch (_) {}
      if (!chipVisible) {
        setOpen(false);
      }
      return chipVisible;
    }

    function ensureChipVisible() {
      if (!chipVisible) setChipVisible(true);
    }

    function showPeek(text) {
      const t = String(text || "").trim();
      if (!chipVisible) {
        pulseToggle(1600);
        return;
      }
      root.classList.add("is-peek");
      pulseListening(2200);
      if (t) {
        peek.hidden = false;
        peek.textContent = t.length > 90 ? t.slice(0, 87) + "…" : t;
      }
      if (peekTimer) win.clearTimeout(peekTimer);
      peekTimer = win.setTimeout(() => {
        root.classList.remove("is-peek");
        peek.hidden = true;
      }, 4200);
    }

    function pulseListening(ms) {
      root.classList.add("is-listening");
      if (listenPulse) win.clearTimeout(listenPulse);
      listenPulse = win.setTimeout(() => root.classList.remove("is-listening"), Math.max(900, Number(ms) || 1600));
    }

    function markSpeaking(on) {
      root.classList.toggle("is-speaking", !!on);
      try {
        doc.documentElement.classList.toggle("hq-sister-speaking", !!on);
      } catch (_) {}
    }

    function setLine(text, animate) {
      const t = String(text || "").trim() || IDLE_LINE;
      root.classList.add("is-typing");
      markSpeaking(true);
      const finish = () => {
        root.classList.remove("is-typing");
        win.setTimeout(() => markSpeaking(false), 400);
      };
      if (animate) typewriter(win, line, t, finish);
      else {
        line.textContent = t;
        finish();
      }
    }

    function lastHerLine() {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "assistant" && m.text) return String(m.text);
      }
      return IDLE_LINE;
    }

    function renderLog() {
      log.replaceChildren();
      messages.forEach((m) => {
        if (!m || !m.text) return;
        const row = doc.createElement("div");
        const isUser = m.role === "user";
        row.className = "hq-else-msg " + (isUser ? "is-user" : "is-her");
        const body = doc.createElement("div");
        body.textContent = String(m.text);
        row.appendChild(body);
        if (!isUser && (m.model_label || m.model)) {
          const meta = doc.createElement("span");
          meta.className = "hq-else-msg-model";
          meta.textContent = String(m.model_label || m.model);
          meta.title = String(m.model || m.model_label || "");
          row.appendChild(meta);
        }
        log.appendChild(row);
      });
      log.scrollTop = log.scrollHeight;
    }

    function setExpanded(next) {
      expanded = !!next;
      root.classList.toggle("is-expanded", expanded);
      expandBtn.textContent = expanded ? "⤡" : "⤢";
      expandBtn.title = expanded ? "Réduire" : "Agrandir le chat";
      try { win.localStorage.setItem(LS_EXPANDED, expanded ? "1" : "0"); } catch (_) {}
      if (expanded) {
        renderLog();
        renderSisterStrip();
        if (sis) sis.loadHistory().then(() => renderSisterStrip()).catch(() => {});
        win.setTimeout(() => input.focus(), 30);
      } else {
        sisterStrip.hidden = true;
      }
    }

    function setOpen(next) {
      open = !!next;
      root.classList.toggle("is-open", open);
      try { win.localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
      if (open) {
        loadHistory().catch(() => {});
        if (expanded) {
          if (sis) sis.loadHistory().then(() => renderSisterStrip()).catch(() => {});
          win.setTimeout(() => input.focus(), 30);
        }
      }
    }

    async function loadHistory() {
      const out = await fetchJson(win, aiUrl(win, "else=1"));
      if (Array.isArray(out.messages)) {
        messages = out.messages.filter((m) => m && (m.role === "user" || m.role === "assistant"));
        renderLog();
        setLine(lastHerLine(), false);
      }
    }

    async function runSister(opts) {
      const o = opts || {};
      if (!sis) return { ok: false, error: "no_sister" };
      if (o.ambient) return sis.runAmbient();
      return sis.runExchange({
        topic: o.topic != null ? o.topic : (sisterTopic.value || "").trim(),
        openExpanded: !!o.openExpanded,
      });
    }

    function scheduleAmbientSister() {
      const jitter = () => AMBIENT_MIN_MS + Math.floor(Math.random() * AMBIENT_SPAN_MS);
      let timer = null;
      const arm = (delay) => {
        win.clearTimeout(timer);
        timer = win.setTimeout(tick, delay);
      };
      const tick = async () => {
        if (sis && !sis.ambientEnabled()) {
          arm(jitter());
          return;
        }
        const blocked = win.HqSisterCore && win.HqSisterCore.attentionBlocksBanter
          ? win.HqSisterCore.attentionBlocksBanter(win)
          : false;
        if (!doc.hidden && !blocked && !(sis && sis.isBusy())) {
          await runSister({ ambient: true });
        }
        arm(jitter());
      };
      arm(AMBIENT_FIRST_MS + Math.floor(Math.random() * 45000));
      doc.addEventListener("visibilitychange", () => {
        if (!doc.hidden) arm(45000 + Math.floor(Math.random() * 60000));
      });
    }

    function shortDigest() {
      try {
        if (win.HqCompanion && typeof win.HqCompanion.digest === "function") {
          return String(win.HqCompanion.digest(win) || "").replace(/\s+/g, " ").trim().slice(0, 120);
        }
      } catch (_) {}
      return "";
    }

    function attentionBlocksElse() {
      if (doc.hidden || !chipVisible || chatBusy || sisterBusy()) return true;
      if (win.HqSisterCore && win.HqSisterCore.attentionBlocksBanter
        && win.HqSisterCore.attentionBlocksBanter(win)) return true;
      return false;
    }

    async function runProactiveAside() {
      if (!proactiveOn || attentionBlocksElse()) return { skipped: true };
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "ambient",
          view,
          persona: "warm",
          digest: shortDigest() || undefined,
        }));
        if (out && out.skipped) return out;
        const line = String((out && (out.line || out.reply)) || "").trim();
        if (!line) return out || { ok: false };
        if (Array.isArray(out.messages)) {
          messages = out.messages.filter((m) => m && (m.role === "user" || m.role === "assistant"));
          renderLog();
        }
        // Presence only — peek the chip, don't force the bubble open.
        showPeek(line);
        setLine(line, false);
        if (sis && typeof sis.handleElseLine === "function") {
          const sisterCue = /transferania|transferina|sœur|soeur|sister/i.test(line);
          sis.handleElseLine({ text: line, sister_cue: sisterCue, ambient: true, nsfw: !!(out && out.nsfw) });
        }
        return out;
      } catch (_) {
        return { ok: false };
      }
    }

    function scheduleProactiveElse() {
      const jitter = () => PROACTIVE_MIN_MS + Math.floor(Math.random() * PROACTIVE_SPAN_MS);
      let timer = null;
      const arm = (delay) => {
        win.clearTimeout(timer);
        timer = win.setTimeout(tick, delay);
      };
      const tick = async () => {
        if (proactiveOn && !attentionBlocksElse()) {
          await runProactiveAside();
        }
        arm(jitter());
      };
      arm(PROACTIVE_FIRST_MS + Math.floor(Math.random() * 90000));
      doc.addEventListener("visibilitychange", () => {
        if (!doc.hidden) arm(90000 + Math.floor(Math.random() * 120000));
      });
    }

    async function sendChat(ev) {
      if (ev) ev.preventDefault();
      if (chatBusy || sisterBusy()) return;
      const text = (input.value || "").trim();
      if (!text) return;
      if (!open) setOpen(true);
      if (!expanded) setExpanded(true);
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      chatBusy = true;
      syncChromeBusy(true);
      messages.push({ role: "user", text });
      renderLog();
      input.value = "";
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "send",
          message: text,
          view,
          persona: "warm",
        }));
        if (Array.isArray(out.messages)) messages = out.messages;
        else if (out.reply) messages.push({ role: "assistant", text: out.reply });
        renderLog();
        const reply = out.reply || lastHerLine();
        setLine(reply, true);
        if (reply && sis && typeof sis.handleElseLine === "function") {
          const sisterCue = /transferania|transferina|sœur|soeur|sister/i.test(String(reply));
          sis.handleElseLine({ text: String(reply), sister_cue: sisterCue, nsfw: !!out.nsfw });
        }
      } catch (e) {
        messages.pop();
        renderLog();
        if (typeof win.hqToast === "function") {
          win.hqToast((e && e.message) || "Else indisponible", "err");
        }
      } finally {
        chatBusy = false;
        syncChromeBusy(false);
      }
    }

    let lastChipTap = 0;
    const chipFloat = bindFloatDrag(win, {
      el: chip,
      host: root,
      storageKey: LS_FLOAT,
      minVisible: 72,
    });
    const toggleFloat = bindFloatDrag(win, {
      el: toggle,
      host: toggle,
      storageKey: LS_TOGGLE_FLOAT,
      minVisible: 36,
    });

    chip.addEventListener("click", (ev) => {
      if (chipFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (!open) {
        setOpen(true);
        return;
      }
      const now = Date.now();
      // Double-tap chip: soft sister nudge toward Transferania.
      if (now - lastChipTap < 550 && sis && typeof sis.runNudge === "function" && !sisterBusy()) {
        lastChipTap = 0;
        sis.runNudge({ toward: "transferania" });
        return;
      }
      lastChipTap = now;
      setExpanded(!expanded);
    });

    toggle.addEventListener("click", (ev) => {
      if (toggleFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      setChipVisible(!chipVisible);
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setOpen(false);
    });
    expandBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setExpanded(!expanded);
    });
    ambientToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (sis) sis.setAmbient(!sis.ambientEnabled(), true);
      syncPrefToggles();
    });
    reactToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (sis) sis.setReact(!sis.reactEnabled(), true);
      syncPrefToggles();
    });
    proactiveToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setProactive(!proactiveOn);
    });
    sisterBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      sisterBar.hidden = !sisterBar.hidden;
      if (!sisterBar.hidden) {
        if (!open) setOpen(true);
        sisterTopic.focus();
      }
    });
    sisterGo.addEventListener("click", (ev) => {
      ev.stopPropagation();
      runSister({ ambient: false });
    });
    sisterNudge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!sis || typeof sis.runNudge !== "function" || sisterBusy()) return;
      sis.runNudge({ toward: "else" });
    });
    form.addEventListener("submit", sendChat);

    if (!win.__hqElseBusBound) {
      win.__hqElseBusBound = true;
      win.addEventListener("hq-sister-open", (ev) => {
        const detail = (ev && ev.detail) || {};
        ensureChipVisible();
        setOpen(true);
        if (detail.expanded) setExpanded(true);
      });
      win.addEventListener("hq-sister-line", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (detail.speaker === "else" && detail.text) {
          if (!chipVisible) {
            if (!detail.ambient) ensureChipVisible();
            else pulseToggle(1600);
          }
          if (!open) {
            // Ambient/react: keep bubble closed; chip peek carries presence.
            if (detail.ambient) {
              showPeek(String(detail.text));
              if (chipVisible) setLine(String(detail.text), false);
            } else {
              ensureChipVisible();
              setOpen(true);
              setLine(String(detail.text), true);
            }
          } else if (chipVisible) {
            setLine(String(detail.text), !detail.ambient);
          }
        }
        renderSisterStrip();
      });
      win.addEventListener("hq-sister-peek", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (!detail.text) return;
        showPeek(String(detail.text));
      });
      win.addEventListener("hq-sister-history", () => renderSisterStrip());
      win.addEventListener("hq-sister-prefs", () => syncPrefToggles());
      win.addEventListener("hq-transferania-line", () => pulseListening(1800));
      win.addEventListener("hq-sister-glance", (ev) => {
        const to = ev && ev.detail && ev.detail.to;
        if (to && to !== "else") return;
        if (!chipVisible) {
          pulseToggle(900);
          return;
        }
        root.classList.add("is-glance");
        pulseListening(ev && ev.detail && ev.detail.soft ? 900 : 1400);
        win.setTimeout(() => root.classList.remove("is-glance"), 900);
      });
      win.addEventListener("hq-sister-event", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (!chipVisible) {
          pulseToggle(1600);
        } else {
          root.classList.add("is-event");
          pulseListening(1600);
          win.setTimeout(() => root.classList.remove("is-event"), 1800);
        }
        // Soft glance toward Transferania so both chips feel the beat.
        try {
          win.dispatchEvent(new CustomEvent("hq-sister-glance", {
            detail: { from: "else", to: "transferania", event: true, soft: true, id: detail.id },
          }));
        } catch (_) {}
      });
      win.addEventListener("hq-sister-nudge", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (!chipVisible) {
          pulseToggle(1200);
          return;
        }
        root.classList.add("is-nudge");
        pulseListening(1200);
        if (detail.peek && detail.peek.speaker === "else" && detail.peek.text) {
          showPeek(String(detail.peek.text));
        }
        win.setTimeout(() => root.classList.remove("is-nudge"), 1200);
      });
      win.addEventListener("hq-sister-busy", (ev) => {
        syncChromeBusy(!!(ev && ev.detail && ev.detail.busy));
      });
    }

    win.HqElse = {
      open: (opts) => {
        ensureChipVisible();
        setOpen(true);
        if (opts && opts.expanded) setExpanded(true);
      },
      setLine: (text, animate) => setLine(text, animate !== false),
      runSister: (opts) => runSister(opts || {}),
      nudge: (opts) => (sis && sis.runNudge ? sis.runNudge(opts || {}) : Promise.resolve({ ok: false })),
      setAmbient: (on) => {
        if (sis) sis.setAmbient(on, true);
        syncPrefToggles();
      },
      setReact: (on) => {
        if (sis) sis.setReact(on, true);
        syncPrefToggles();
      },
      setProactive: (on) => setProactive(on),
      proactiveEnabled: () => proactiveOn,
      runProactive: () => runProactiveAside(),
      react: (trigger, speaker) => (sis ? sis.runReact(trigger, speaker) : Promise.resolve({ ok: false })),
      resetFloat: (opts) => chipFloat.reset(opts || {}),
      resetToggleFloat: (opts) => toggleFloat.reset(opts || {}),
      getFloat: () => chipFloat.getPos(),
      getToggleFloat: () => toggleFloat.getPos(),
      setVisible: (on) => setChipVisible(on !== false),
      isVisible: () => chipVisible,
      isOpen: () => open,
      peek: showPeek,
      root,
      toggle,
    };

    try {
      if (win.localStorage.getItem(LS_VISIBLE) === "0") setChipVisible(false, { force: true });
      else setChipVisible(true, { force: true });
      if (chipVisible && win.localStorage.getItem(LS_EXPANDED) === "1") setExpanded(true);
      if (chipVisible && win.localStorage.getItem(LS_OPEN) === "1") setOpen(true);
    } catch (_) {}
    syncPrefToggles();
    scheduleAmbientSister();
    scheduleProactiveElse();
  }

  function boot() {
    const win = window;
    const start = () => mount(win);
    if (win.document.readyState === "loading") {
      win.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  boot();
})();
