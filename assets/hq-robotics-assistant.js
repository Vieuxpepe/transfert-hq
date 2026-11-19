/* Robotique assistant. Uses HQ's shared portrait mode and chip scaling. */
(() => {
  'use strict';
  const POS = 'hq_robotics_assistant_pos_v1';
  const SCALE = 'hq_robotics_assistant_scale_v1';
  // The companion chips are fixed on the same rail as this one; a visible one must never be cut into.
  const COMPANION_DOCKS = '.hq-securia-chip-dock, .hq-culinia-chip-dock, .hq-forgia-chip-dock, '
    + '.hq-static-chip-dock, .hq-musica-chip-dock, .hq-elsea-chip-dock';
  const PORTRAIT = '/api/robotics/assistant/portrait';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const readPosition = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(POS));
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return saved;
    } catch (_) {}
    return { x: 1, y: .72 };
  };
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const modelLabel = model => ({
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  })[model] || model;

  const SAFE_AUTO_TOOLS = new Set([
    'open_blackbox', 'apply_preset', 'load_routine',
    'synthesize_transfer', 'synthesize_pallet', 'synthesize_inspect',
  ]);

  const BENCH_MACROS = {
    present: { label: 'Présenter face à la caméra', armed: true },
    hold: { label: 'Saisir & maintenir au couple', armed: true },
    release: { label: 'Ouvrir & libérer la pince', armed: true },
    teach_on: { label: 'Passer en mode libre (main)', armed: false },
    teach_off: { label: 'Quitter le mode libre', armed: false },
    home: { label: 'Retour au neutre', armed: true },
    transfer_compose: { label: 'Préparer Pick A → Place B (3D)', armed: false, safePrep: true },
    pallet_compose: { label: 'Charger la grille R×C (3D)', armed: false, safePrep: true },
    inspect_compose: { label: 'Préparer Scan Tapo 5 angles (3D)', armed: false, safePrep: true },
    snapshot: { label: 'Capturer une photo Tapo', armed: false, safePrep: true },
  };

  const matchBenchMacro = raw => {
    const src = String(raw || '').trim();
    if (!src || src.length > 72 || src.includes('?')) return null;
    const t = src.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/(^|\b)(ne|n'|pas|non|jamais|aucun|sans|evite|si|quand|comment|pourquoi|explique|est-ce que)(\b|$)/.test(t)) return null;
    if (/(mode libre|free.?drive|relache.?couple|guider?.?a.?la.?main)/.test(t)) {
      return /(quitt|sort|desactiv|stop|reengag)/.test(t) ? 'teach_off' : 'teach_on';
    }
    if (/(present|montre).*(cam|face|moi|piece)/.test(t)) return 'present';
    if (/(saisis|attrap|maintien|tiens).*(piece|objet|douce|couple)/.test(t)) return 'hold';
    if (/(ouvr|liber|lach).*(pince|piece|objet)/.test(t)) return 'release';
    if (/(transfert|pick.?a|place.?b)/.test(t)) return 'transfer_compose';
    if (/(plateau|grille|palett)/.test(t)) return 'pallet_compose';
    if (/(scan|inspect).*(5|angle|tapo)/.test(t)) return 'inspect_compose';
    if (/(prend|captur).*(photo|image|snap)/.test(t)) return 'snapshot';
    if (/(retour.*neutre|va au neutre|home)/.test(t)) return 'home';
    return null;
  };

  const markup = `
    <button class="rb-ai-chip" type="button" aria-label="Ouvrir Kinétia" title="Kinétia · Robotique"
      aria-controls="hq-robotics-chat" aria-expanded="false" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight">
      <span class="rb-ai-icon" aria-hidden="true"></span><img alt="" draggable="false" hidden>
      <span class="rb-ai-alert-dot" data-chat="alert-dot" aria-hidden="true" hidden></span>
    </button>
    <section class="rb-ai-chat" id="hq-robotics-chat" role="dialog" aria-labelledby="rb-ai-title" hidden>
      <header><h2 id="rb-ai-title">Kinétia</h2>
        <button type="button" data-chat="options" aria-expanded="false" aria-controls="rb-ai-options">Puce</button>
        <button type="button" data-chat="close" aria-label="Fermer la conversation">×</button>
      </header>
      <div id="rb-ai-options" class="rb-ai-options" hidden>
        <button type="button" data-chat="smaller">Réduire</button>
        <button type="button" data-chat="larger">Agrandir</button>
        <button type="button" data-chat="reset-chip">Réinitialiser la puce</button>
        <label><input type="checkbox" data-chat="voice"> Voix</label>
        <label><input type="checkbox" data-chat="alerts" checked> Alertes Robotique</label>
        <div data-chat="memory"></div>
      </div>
      <div class="rb-ai-log" data-chat="log" aria-live="polite"></div>
      <div class="rb-ai-chips" data-chat="chips" role="group" aria-label="Suggestions contextuelles"></div>
      <div class="rb-ai-macros" data-chat="macros" role="group" aria-label="Macros rapides d’atelier">
        <button type="button" data-macro="present">Présenter</button>
        <button type="button" data-macro="teach_on">Mode libre</button>
        <button type="button" data-macro="transfer_compose">Transfert A→B</button>
        <button type="button" data-macro="inspect_compose">Scan 5 angles</button>
        <button type="button" data-macro="snapshot">Photo Tapo</button>
      </div>
      <form data-chat="form">
        <label class="visually-hidden" for="rb-ai-prompt">Votre message</label>
        <textarea id="rb-ai-prompt" data-chat="prompt" rows="2" maxlength="2000" required
          placeholder="Décrivez le mouvement à préparer…"></textarea>
        <button type="submit" data-chat="send">Envoyer</button>
      </form>
      <p class="rb-ai-status" data-chat="status" role="status"></p>
    </section>`;

  class Assistant {
    constructor(lab) {
      this.lab = lab;
      this.root = node('aside', '', 'rb-ai');
      this.root.innerHTML = markup;
      this.root.hidden = true;
      document.body.append(this.root);
      this.chip = this.root.querySelector('.rb-ai-chip');
      this.image = this.chip.querySelector('img');
      this.chat = this.root.querySelector('.rb-ai-chat');
      this.options = this.root.querySelector('.rb-ai-options');
      this.nodes = Object.fromEntries([...this.root.querySelectorAll('[data-chat]')].map(el => [el.dataset.chat, el]));
      this.position = readPosition();
      this.generation = 0;
      this.filter = 'all';
      this.scale = window.HqImageChipScale.bind(window, {
        root: this.root, chip: this.chip, storageKey: SCALE,
        cancelDrag: () => { this.drag = null; this.suppressClick = true; },
        setBlocked: blocked => { this.pinch = blocked; },
      });
      window.HqImageChipScale.bindPortraitMode(window, {
        root: this.root, onRefresh: adult => this.portrait(adult),
      });
      this.bind();
      window.addEventListener('hq:securia-dock', () => this.place());
    }

    bind() {
      const on = (key, fn) => this.nodes[key].addEventListener('click', fn);
      on('options', () => this.toggleOptions());
      for (const key of ['voice', 'alerts']) {
        this.nodes[key].addEventListener('change', () =>
          this.perform('settings', { [key]: this.nodes[key].checked }, 'Enregistrement…'));
      }
      this.lab.host.querySelectorAll('[data-lib-filter]').forEach(button => button.addEventListener('click', () => {
        this.filter = button.dataset.libFilter;
        this.renderLibrary();
      }));
      this.lab.nodes['library-rebase-all']?.addEventListener('click', () => this.rebaseAll());
      on('close', () => this.close(true));
      on('smaller', () => this.resize(-.25));
      on('larger', () => this.resize(.25));
      on('reset-chip', () => {
        this.scale.resetScale();
        this.position = { x: 1, y: .72 };
        this.persist();
        this.place();
      });
      this.chip.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (this.chat.hidden) this.open();
        this.toggleOptions(true);
      });
      this.chip.addEventListener('click', () => {
        if (this.suppressClick) return;
        if (this.chat.hidden) this.open();
        else this.close();
      });
      this.chip.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || this.pinch) return;
        this.suppressClick = false;
        const rect = this.chip.getBoundingClientRect();
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        this.chip.setPointerCapture(event.pointerId);
      });
      this.chip.addEventListener('pointermove', event => {
        const drag = this.drag;
        if (!drag || drag.id !== event.pointerId) return;
        const x = event.clientX - drag.x;
        const y = event.clientY - drag.y;
        if (!this.suppressClick && Math.hypot(x, y) < 6) return;
        this.suppressClick = true;
        this.move(drag.left + x, drag.top + y);
      });
      const release = event => {
        if (this.drag?.id !== event.pointerId) return;
        if (this.suppressClick) this.persist();
        this.drag = null;
      };
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) this.chip.addEventListener(event, release);
      this.chip.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') this.suppressClick = false;
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!event.altKey || !direction) return;
        event.preventDefault();
        const rect = this.chip.getBoundingClientRect();
        this.move(rect.left + direction[0] * 16, rect.top + direction[1] * 16);
        this.persist();
      });
      // Both chip rows scroll horizontally; the edge fade (added on a phone) is their only cue.
      for (const box of [this.nodes.chips, this.nodes.macros]) {
        box?.addEventListener('scroll', () => this.syncChips(), { passive: true });
      }
      window.addEventListener('resize', () => this.syncChips(), { passive: true });
      this.nodes.form.addEventListener('submit', event => {
        event.preventDefault();
        const text = this.nodes.prompt.value.trim();
        if (!text) return;
        const macroId = matchBenchMacro(text);
        if (macroId) {
          this.nodes.prompt.value = '';
          this.handleLocalMacro(text, macroId);
          return;
        }
        const ptzOpts = [...(this.lab.nodes['ptz-preset']?.options || [])]
          .filter(o => o.value)
          .map(o => ({ token: o.value, name: o.textContent.trim() }));
        this.perform('message', ptzOpts.length ? { text, ptz_presets: ptzOpts } : { text }, 'Rédaction…');
      });
      this.nodes.prompt.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.nodes.form.requestSubmit();
        }
      });
      this.nodes.macros?.querySelectorAll('[data-macro]').forEach(btn => {
        btn.addEventListener('click', () => this.runBenchMacro(btn.dataset.macro));
      });
      this.root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !this.chat.hidden) {
          event.stopPropagation();
          this.close(true);
        }
      });
    }

    show() {
      if (!this.root.hidden) return;
      this.generation++;
      this.root.hidden = false;
      this.lifecycle = new AbortController();
      const signal = this.lifecycle.signal;
      window.addEventListener('resize', () => this.place(), { signal });
      window.visualViewport?.addEventListener('resize', () => this.place(), { signal });
      window.visualViewport?.addEventListener('scroll', () => this.place(), { signal });
      const observer = new ResizeObserver(() => this.place());
      observer.observe(this.chip);
      signal.addEventListener('abort', () => observer.disconnect(), { once: true });
      this.portrait(window.HqImageChipScale.adultChipPortraits(window));
      this.place();
      if (!this.thread && !this.busy) this.perform('thread', undefined, 'Chargement…');
    }

    hide() {
      this.generation++;
      this.lifecycle?.abort();
      this.root.hidden = true;
      this.drag = null;
      this.close();
      this.observed = null;
      this.libraryRevision = null;
      if (this.lab.nodes.library) this.lab.nodes.library.hidden = true;
    }

    portrait(adult) {
      if (!adult || this.root.hidden) {
        this.image.removeAttribute('src');
        this.image.hidden = true;
        return;
      }
      const generation = this.generation;
      const image = new Image();
      image.onload = () => {
        if (generation === this.generation && !this.root.hidden && window.HqImageChipScale.adultChipPortraits(window)) {
          this.image.src = image.src;
          this.image.hidden = false;
        }
      };
      image.src = PORTRAIT;
    }

    area() {
      const rect = this.chip.getBoundingClientRect();
      const viewport = window.visualViewport;
      const margin = 12;
      const x = (viewport?.offsetLeft || 0) + margin;
      const y = (viewport?.offsetTop || 0) + margin;
      const width = Math.max(1, (viewport?.width || innerWidth) - rect.width - margin * 2);
      const height = Math.max(1, (viewport?.height || innerHeight) - rect.height - margin - 68);
      return { x, y, width, height };
    }

    place() {
      if (this.root.hidden) return;
      const area = this.area();
      const rect = this.chip.getBoundingClientRect();
      const gap = 8;
      const left = area.x + clamp(this.position.x, 0, 1) * area.width;
      let top = area.y + clamp(this.position.y, 0, 1) * area.height;
      // A companion that has just raised an alert can land on the same spot. Step above it when the
      // area allows, otherwise below, so neither portrait is clipped by the other.
      for (const dock of document.querySelectorAll(COMPANION_DOCKS)) {
        if (dock.hidden) continue;
        const box = dock.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        if (left >= box.right || left + rect.width <= box.left) continue;
        if (top >= box.bottom || top + rect.height <= box.top) continue;
        const above = box.top - rect.height - gap;
        const below = box.bottom + gap;
        top = above >= area.y ? above
          : (below + rect.height <= area.y + area.height ? below : top);
      }
      this.chip.style.left = left + 'px';
      this.chip.style.top = top + 'px';
      const viewport = window.visualViewport;
      const keyboard = Math.max(0, innerHeight - (viewport?.height || innerHeight) - (viewport?.offsetTop || 0));
      const bottom = keyboard > 80 ? keyboard + 12 : (innerWidth < 900 ? 76 : 16);
      this.chat.style.bottom = bottom + 'px';
      this.chat.style.maxHeight = Math.min(640, Math.max(170, innerHeight - bottom - 24)) + 'px';
    }

    move(left, top) {
      const area = this.area();
      this.position = { x: clamp((left - area.x) / area.width, 0, 1), y: clamp((top - area.y) / area.height, 0, 1) };
      this.place();
    }

    persist() {
      try { localStorage.setItem(POS, JSON.stringify(this.position)); } catch (_) {}
    }

    resize(delta) {
      this.scale.bump(delta);
      this.place();
    }

    toggleOptions(force = this.options.hidden) {
      this.options.hidden = !force;
      this.nodes.options.setAttribute('aria-expanded', String(force));
    }

    async open() {
      if (this.root.hidden || !this.chat.hidden) return;
      this.chat.hidden = false;
      this.chip.setAttribute('aria-expanded', 'true');
      this.nodes['alert-dot'].hidden = true;
      this.nodes.close.focus({ preventScroll: true });
      if (!this.busy) await this.perform('thread', undefined, 'Chargement…');
      this.syncChips();  // the rows only have a width once the panel is shown
    }

    close(focus = false) {
      this.voiceRequest = null;
      this.audio?.pause();
      this.audio = null;
      this.chat.hidden = true;
      this.toggleOptions(false);
      this.chip.setAttribute('aria-expanded', 'false');
      if (focus && !this.root.hidden) this.chip.focus({ preventScroll: true });
    }

    async perform(action, body, pending) {
      if (this.busy) {
        // A contextual suggestion can be tapped while the opening check-in still runs. The send
        // button is disabled then, but the suggestion submits the form directly, so honour it:
        // show the message now and send it as soon as the panel is free.
        if (action === 'message' && body?.text) {
          this.queuedMessage = body;
          this.nodes.prompt.value = '';
          this.showLocalUserMessage(body.text);
        }
        return;
      }
      this.busy = true;
      this.root.classList.add('is-busy');
      this.nodes.status.textContent = pending;
      this.nodes.send.disabled = true;
      this.nodes.log.querySelectorAll('button').forEach(el => { el.disabled = true; });
      this.lab.nodes['library-list']?.querySelectorAll('button').forEach(el => { el.disabled = true; });
      if (action === 'message' && body?.text && !this.chat.hidden) {
        this.nodes.prompt.value = '';
        // Render through the log model so the message survives a later re-render.
        this.showLocalUserMessage(body.text);
      }
      try {
        const options = body === undefined ? { timeoutMs: 5000 } : {
          method: 'POST', timeoutMs: action === 'review' ? 115000 : 43000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        };
        this.thread = await this.lab.api('/api/robotics/assistant/' + action, options);
        if (action === 'message') {
          const reply = this.thread.messages.at(-1);
          if (!this.chat.hidden) this.speak(reply?.text, reply?.language);
          if (reply?.tool?.name && SAFE_AUTO_TOOLS.has(reply.tool.name)) {
            this.runBenchTool(reply.tool);
          }
        }
        if (action === 'message' && this.nodes.prompt.value.trim() === body.text) this.nodes.prompt.value = '';
        // The same text succeeded: the thread now carries it, so the local copy is no longer needed.
        if (action === 'message' && this.localMessages?.length) {
          this.localMessages = this.localMessages.filter(m => !(m.role === 'user' && m.text === body.text));
        }
        this.nodes.status.textContent = '';
      } catch (err) {
        // A message the operator sent stays in the log even when the assistant is unavailable:
        // render() rebuilds from the thread, so keep the local copy instead of erasing it.
        if (action === 'message' && body?.text) {
          this.localMessages ||= [];
          const row = this.localMessages.find(m => m.role === 'user' && m.text === body.text);
          if (row) row.failed = true;
          else this.localMessages.push({ role: 'user', text: body.text, failed: true });
        }
        this.nodes.status.textContent = err.message;
        this.lab.message(err.message, true);  // the library cards live outside the chat panel
      } finally {
        this.busy = false;
        this.root.classList.remove('is-busy');
        this.nodes.send.disabled = false;
        this.render(action === 'message' || action === 'thread');
        // Flush a message that was tapped while this operation held the panel.
        const queued = this.queuedMessage;
        this.queuedMessage = null;
        if (queued) this.perform('message', queued, 'Rédaction…');
      }
    }

    // Shows the message the operator just sent immediately, before (or without) a reply. The
    // thread reconciles it on success; on failure the copy stays so nothing is silently lost.
    showLocalUserMessage(text) {
      if (!text) return;
      this.localMessages ||= [];
      const known = [...(this.thread?.messages || []), ...this.localMessages]
        .some(m => m.role === 'user' && m.text === text);
      if (!known) this.localMessages.push({ role: 'user', text });
      this.render(true);
      if (this.busy) this.nodes.log.querySelectorAll('button').forEach(el => { el.disabled = true; });
    }

    render(scroll) {
      const log = this.nodes.log;
      const top = log.scrollTop;
      const messages = [...(this.thread?.messages || []), ...(this.localMessages || [])];
      log.replaceChildren();
      this.nodes.voice.checked = this.thread?.settings?.voice === true;
      this.nodes.alerts.checked = this.thread?.settings?.alerts !== false;
      if (!this.nodes.alerts.checked) this.nodes['alert-dot'].hidden = true;
      this.nodes.memory.replaceChildren(node('strong', 'Mémoire'));
      for (const note of this.thread?.memory || []) {
        const row = node('p', note.text + ' ');
        const forget = node('button', 'Oublier');
        forget.type = 'button';
        forget.addEventListener('click', () => this.perform('memory/delete', { id: note.id }, 'Suppression…'));
        row.append(forget);
        this.nodes.memory.append(row);
      }
      if (this.notice && this.nodes.alerts.checked) log.append(node('p', this.notice, 'rb-ai-empty'));
      if (!messages.length) log.append(node('p', 'Décrivez une trajectoire ou utilisez une macro d’atelier ci-dessous.', 'rb-ai-empty'));
      for (const message of messages) {
        const isUser = message.role === 'user';
        const block = node('div', '', 'rb-ai-message' + (isUser ? ' is-user' : ''));
        block.append(node('strong', isUser ? 'Vous' : 'Kinétia'), node('p', message.text));
        const script = this.thread?.scripts?.[message.script_id];
        if (script) block.append(this.scriptCard(message.script_id, script));
        if (message.macro && BENCH_MACROS[message.macro]) {
          const m = BENCH_MACROS[message.macro];
          const macroBtn = node('button', '⚡ ' + m.label, 'rb-ai-macro-btn');
          macroBtn.type = 'button';
          macroBtn.addEventListener('click', () => this.runBenchMacro(message.macro));
          block.append(macroBtn);
        }
        if (message.tool?.name) {
          const toolBtn = node('button', '🔧 ' + this.toolLabel(message.tool), 'rb-ai-tool-btn');
          toolBtn.type = 'button';
          toolBtn.addEventListener('click', () => this.runBenchTool(message.tool));
          block.append(toolBtn);
        }
        log.append(block);
      }
      log.scrollTop = scroll ? log.scrollHeight : top;
      this.renderContextChips(this.lab.state);
      this.renderLibrary();
      this.syncChips();
    }

    syncChips() {
      // Same treatment as the section bar: is-overflow says the row scrolls, is-end says more waits
      // off-screen, is-start says earlier chips are hidden behind the left fade.
      for (const box of [this.nodes.chips, this.nodes.macros]) {
        if (!box) continue;
        const max = box.scrollWidth - box.clientWidth;
        box.classList.toggle('is-overflow', max > 2);
        box.classList.toggle('is-start', max > 2 && box.scrollLeft > 2);
        box.classList.toggle('is-end', max > 2 && box.scrollLeft < max - 2);
      }
    }

    renderContextChips(state) {
      const box = this.nodes.chips;
      if (!box) return;
      const prompts = state?.stop_latched || state?.uncertain
        ? ['Why did it stop?', 'Inspect recent servo loads', 'Open Blackbox']
        : state?.camera_live
          ? ['Inspect the bench photo', 'Aim at target on mat', 'Prepare a 5-angle Tapo scan']
          : ['Prepare a symmetric 2x3 pallet', 'Move forward 25 mm', 'Prepare a 5-angle Tapo scan'];
      const sig = prompts.join('|');
      if (this._chipsSig === sig) return;
      this._chipsSig = sig;
      box.replaceChildren(...prompts.map(text => {
        const b = node('button', text);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.nodes.prompt.value = text;
          this.nodes.form.requestSubmit();
        });
        return b;
      }));
    }

    renderLibrary() {
      const section = this.lab.nodes.library;
      const list = this.lab.nodes['library-list'];
      if (!section || !list) return;
      section.hidden = this.root.hidden;
      const revision = this.lab.state?.config.revision ?? this.thread?.revision;
      const search = (this.lab.nodes['library-search']?.value || '').trim().toLowerCase();
      const wanted = ([, script]) => {
        const stale = script.revision !== revision;
        const tabOk = this.filter === 'all' || (this.filter === 'stale' && stale) ||
          (this.filter === 'approved' && !stale && !!script.approval);
        if (!tabOk) return false;
        if (!search) return true;
        return [script.label, script.title, script.summary, script.summary_auto]
          .some(v => typeof v === 'string' && v.toLowerCase().includes(search));
      };
      const saved = Object.entries(this.thread?.scripts || {}).filter(([, script]) => script.saved)
        .sort((a, b) => (b[1].saved_at || 0) - (a[1].saved_at || 0));
      const staleCount = saved.filter(([, script]) => script.revision !== revision).length;
      const rebaseAll = this.lab.nodes['library-rebase-all'];
      if (rebaseAll) {
        rebaseAll.hidden = staleCount < 2;
        rebaseAll.disabled = this.busy;
        rebaseAll.textContent = `Tout mettre à jour (${staleCount})`;
      }
      const entries = saved.filter(wanted);
      list.replaceChildren(...(entries.length ? entries.map(([id, script]) => this.scriptCard(id, script, true)) :
        [node('p', 'Aucun script ici. Étoilez un script de la conversation de Kinétia pour le garder.', 'rb-library-empty')]));
      section.querySelectorAll('[data-lib-filter]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.libFilter === this.filter)));
      this.lab.setLibraryTraces?.(saved.map(([id, script]) => ({
        id, label: script.label || script.title, trace: script.trace,
      })));
    }

    exportLibrary() {
      const saved = Object.entries(this.thread?.scripts || {})
        .filter(([, script]) => script.saved)
        .map(([id, script]) => ({
          id,
          title: script.label || script.title,
          summary: script.summary || script.summary_auto || '',
          speed: script.speed,
          start: script.start,
          steps: script.steps,
          origin: script.origin || 'assistant',
        }));
      if (!saved.length) {
        this.lab.message('Aucun script enregistré à exporter.', true);
        return;
      }
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), scripts: saved }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'robotics-library.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.lab.message(`${saved.length} script(s) exporté(s) en JSON.`);
    }

    // Rebuild every saved script made for older settings, one after the other. Each one still needs
    // its own review and approval afterwards, exactly as with the per-script button.
    async rebaseAll() {
      if (this.busy) return;
      const revision = () => this.lab.state?.config.revision ?? this.thread?.revision;
      const stale = () => Object.entries(this.thread?.scripts || {})
        .filter(([, script]) => script.saved && script.revision !== revision());
      const count = stale().length;
      if (!count) return;
      const btn = this.lab.nodes['library-rebase-all'];
      this.confirmInPage('rebase-all', btn,
        `Cliquez de nouveau pour recréer ${count} script(s) pour les réglages actuels (revue et approbation à refaire).`,
        async () => {
          const tried = new Set();
          for (;;) {
            const next = stale().find(([id]) => !tried.has(id));
            if (!next) break;
            const [id, script] = next;
            tried.add(id);
            await this.perform('library/rebase', { id, digest: script.digest }, `Mise à jour des scripts… (${tried.size}/${count})`);
          }
        });
    }

    // Side-effect-free preview: only an SVG dot moves, nothing is sent to the arm or the simulator.
    traceSvg(points, timeline = []) {
      const ns = 'http://www.w3.org/2000/svg';
      const spread = index => Math.max(...points.map(point => point[index])) - Math.min(...points.map(point => point[index]));
      const axes = [0, 1, 2].sort((a, b) => spread(b) - spread(a)).slice(0, 2).sort();
      const names = ['X', 'Y', 'Z'];
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'rb-lib-trace');
      svg.setAttribute('viewBox', '0 0 100 60');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Trajectoire dans le plan ${names[axes[0]]}${names[axes[1]]}`);
      const [a, b] = axes;
      const lo = index => Math.min(...points.map(point => point[index]));
      const hi = index => Math.max(...points.map(point => point[index]));
      const ca = (lo(a) + hi(a)) / 2;
      const cb = (lo(b) + hi(b)) / 2;
      const scale = Math.min(84 / Math.max(1, hi(a) - lo(a)), 40 / Math.max(1, hi(b) - lo(b)));
      const at = point => [50 + (point[a] - ca) * scale, 31 - (point[b] - cb) * scale];
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', points.map(point => at(point).map(value => value.toFixed(1)).join(',')).join(' '));
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '2.6');
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', '3');
      label.setAttribute('y', '9');
      label.setAttribute('class', 'rb-lib-axes');
      label.textContent = `Plan ${names[a]}${names[b]} · ${names[a]} →, ${names[b]} ↑`;
      const place = ([x, y]) => { dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1)); };
      place(at(points[0]));
      svg.append(line, dot, label);
      const play = () => {
        cancelAnimationFrame(svg.frame);
        const raw = timeline.length === points.length - 1 ? timeline : points.slice(1).map(() => 1);
        const total = raw.reduce((sum, value) => sum + value, 0) || 1;
        const factor = Math.max(2.5, Math.min(14, total)) / total;
        const started = performance.now();
        const frame = now => {
          if (!svg.isConnected) return;
          let t = (now - started) / 1000;
          let index = 0;
          while (index < raw.length && t > raw[index] * factor) { t -= raw[index] * factor; index++; }
          if (index >= raw.length) { place(at(points.at(-1))); return; }
          const u = t / (raw[index] * factor);
          const e = u * u * (3 - 2 * u);
          const [x0, y0] = at(points[index]);
          const [x1, y1] = at(points[index + 1]);
          place([x0 + (x1 - x0) * e, y0 + (y1 - y0) * e]);
          svg.frame = requestAnimationFrame(frame);
        };
        svg.frame = requestAnimationFrame(frame);
      };
      return { svg, play };
    }

    observe(state) {
      const loads = Object.values(state.feedback?.load || {}).filter(Number.isFinite).map(Math.abs);
      const peakLoad = loads.length ? Math.round(Math.max(...loads)) : null;
      const warnLoad = peakLoad != null && peakLoad >= (state.config?.load_warn ?? 700);
      const current = {
        uncertain: !!state.uncertain, stopped: !!state.stop_latched,
        moving: !!state.moving, teach: !!state.teach_mode,
        camera: !!state.camera_live, feedback: !!state.feedback, hardware: state.config.mode === 'hardware',
        warnLoad,
      };
      const previous = this.observed;
      this.observed = current;
      this.renderContextChips(state);
      if (current.stopped || current.uncertain) {
        this.setMood('alert', 0);
      } else if (current.moving) {
        this.setMood('focused', 0);
      } else if (current.teach) {
        this.setMood('curious', 0);
      } else if (previous?.stopped || previous?.uncertain || previous?.moving || previous?.teach) {
        this.setMood('happy', 3200);
      }
      if ((current.stopped || current.uncertain) && (!previous || (!previous.stopped && !previous.uncertain))) {
        if (!this.busy) {
          this.liveCheckin(current.uncertain ? 'uncertain' : 'stop_reassurance', {
            stop_latched: current.stopped,
            uncertain: current.uncertain,
            voltage: state.feedback?.voltage ?? null,
          }, { allowCollapsed: true });
        }
      } else if (current.warnLoad && !previous?.warnLoad && !this.busy) {
        const now = Date.now();
        if (!this.lastLoadCheckinAt || now - this.lastLoadCheckinAt > 45000) {
          this.lastLoadCheckinAt = now;
          this.liveCheckin('heavy_load_rest', {
            peak_load: peakLoad,
            voltage: state.feedback?.voltage ?? null,
          }, { allowCollapsed: true });
        }
      } else if (!this.greetedSession && this.thread && !this.busy) {
        this.greetedSession = true;
        const lastSeen = this.thread.continuity?.last_seen_at;
        const idleSec = typeof lastSeen === 'number' ? Math.max(0, Date.now() / 1000 - lastSeen) : Infinity;
        if (idleSec >= 900 || !(this.thread.messages || []).length) {
          this.liveCheckin('greeting', {
            idle_seconds: Number.isFinite(idleSec) ? Math.round(idleSec) : null,
            mode: state.config?.mode,
          }, { allowCollapsed: false });
        }
      }
      if (this.libraryRevision !== state.config.revision) {
        this.libraryRevision = state.config.revision;
        this.renderLibrary();
      }
      const notice = current.uncertain ? 'Kinétia · Mouvement incertain. Vérifiez le bras sur place.' :
        current.stopped ? 'Kinétia · STOP enclenché. Le poste attend votre réinitialisation.' :
        previous?.camera && !current.camera && current.hardware ? 'Kinétia · Retour vidéo perdu. Vérifiez la caméra avant de réarmer.' :
        previous?.hardware && previous.feedback && !current.feedback && current.hardware ?
          'Kinétia · Le RoArm ne renvoie plus de télémétrie.' :
        previous?.uncertain || previous?.stopped ? 'Kinétia · Le poste est de nouveau prêt pour vos vérifications.' : '';
      if (notice && notice !== this.notice && this.thread?.settings?.alerts !== false) {
        this.notice = notice;
        this.nodes['alert-dot'].hidden = !this.chat.hidden;
        if (!this.busy) {
          if (!this.chat.hidden) this.render(false);
          this.speak(notice.replace(/^Kinétia · /, ''), 'fr', { allowCollapsed: true });
        }
      }
    }

    async speak(text, language = 'fr', { allowCollapsed = false } = {}) {
      if (!text || this.thread?.settings?.voice !== true) return;
      if (this.chat.hidden && !(allowCollapsed && this.thread?.settings?.alerts !== false)) return;
      const marker = this.voiceRequest = {};
      try {
        const result = await this.lab.api('/api/robotics/assistant/voice', {
          method: 'POST', timeoutMs: 35000, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 600), language }),
        });
        if (marker !== this.voiceRequest) return;
        if (this.chat.hidden && !(allowCollapsed && this.thread?.settings?.alerts !== false)) return;
        this.audio?.pause();
        this.audio = new Audio(result.audio_url);
        this.root.classList.add('is-speaking');
        this.audio.addEventListener('ended', () => this.root.classList.remove('is-speaking'), { once: true });
        await this.audio.play();
      } catch (_) { this.root.classList.remove('is-speaking'); }
    }

    // The script as text. Edits create a new version that must be reviewed and approved again.
    scriptEditor(id, script, stale) {
      const wrap = node('details', '', 'rb-lib-code');
      wrap.append(node('summary', 'Script (JSON, modifiable)'));
      const original = JSON.stringify({ title: script.title, summary: script.summary || '', speed: script.speed,
        start: script.start, steps: script.steps }, null, 2);
      const area = node('textarea', '', 'rb-lib-json');
      area.value = original;
      area.rows = Math.min(18, original.split('\n').length + 1);
      area.spellcheck = false;
      area.readOnly = stale;
      area.setAttribute('aria-label', 'Script au format JSON');
      const tell = (text, error = false) => { this.nodes.status.textContent = text; this.lab.message(text, error); };
      const copy = node('button', 'Copier');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(area.value); tell('Script copié.'); }
        catch (_) { area.select(); tell('Texte sélectionné : copiez-le avec Ctrl+C.'); }
      });
      const check = node('button', 'Vérifier');
      check.type = 'button';
      check.disabled = stale;
      const checkOut = node('p', script.plan ? 'Attention : enregistrer ce JSON retire le plan de trajectoire fluide.' : '', 'rb-lib-meta');
      const parseEdit = () => {
        let edited;
        try { edited = JSON.parse(area.value); } catch (error) { tell('JSON invalide : ' + error.message, true); return null; }
        if (!edited || typeof edited !== 'object' || JSON.stringify(edited.start) !== JSON.stringify(script.start)) {
          tell('Le départ est fixe et doit rester identique.', true);
          return null;
        }
        const { start, ...changes } = edited;
        return changes;
      };
      check.addEventListener('click', async () => {
        const changes = parseEdit();
        if (!changes) return;
        try {
          const res = await this.lab.api('/api/robotics/assistant/library/check', {
            method: 'POST', timeoutMs: 12000, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, digest: script.digest, script: changes }),
          });
          const clr = Number.isFinite(res.min_clearance_mm) ? ` · Keepout ${Math.round(res.min_clearance_mm)} mm` : '';
          const msg = `Valide · ${res.steps_count} étape(s) · Δmax ${res.max_delta_deg}°${clr}${res.drops_plan ? ' (plan fluide retiré à la sauvegarde)' : ''}`;
          checkOut.textContent = msg;
          tell(msg);
        } catch (err) {
          checkOut.textContent = err.message;
          tell(err.message, true);
        }
      });
      const save = node('button', 'Enregistrer comme nouvelle version');
      save.type = 'button';
      save.disabled = true;
      area.addEventListener('input', () => { save.disabled = stale || area.value === original; });
      save.addEventListener('click', () => {
        const changes = parseEdit();
        if (!changes) return;
        this.confirmInPage(`edit:${id}`, save,
          'Cliquez de nouveau pour enregistrer : la revue et l’approbation seront à refaire.',
          () => this.perform('library/edit', { id, digest: script.digest, script: changes }, 'Enregistrement de la nouvelle version…'));
      });
      const actions = node('div', '', 'rb-lib-actions');
      actions.append(copy, check, save);
      wrap.append(area, node('p', stale ? 'Mettez le script à jour pour les réglages actuels avant de le modifier.' :
        'Le départ est fixe. Toute modification annule la revue et votre approbation.', 'rb-lib-meta'), checkOut, actions);
      return wrap;
    }

    scriptCard(id, script, inLibrary = false) {
      const card = node('section', '', 'rb-ai-script');
      const request = { id, digest: script.digest };
      const stale = script.revision !== (this.lab.state?.config.revision ?? this.thread.revision);
      const verdict = script.review?.verdict;
      const editor = script.origin === 'editor';
      const kinetia = script.kinetia_review?.digest === script.digest ? script.kinetia_review.verdict : null;
      const status = stale ? 'Réglages modifiés' : script.approval ? (script.approval.manual ? 'Approuvé manuellement (sans avis du modèle)' : 'Approuvé') :
        editor && !kinetia ? 'Éditeur 3D · revue de Kinétia requise' : editor && kinetia === 'revise' ? 'Kinétia demande une révision' :
        verdict === 'pass' ? 'Votre approbation est requise' : verdict === 'revise' ? 'À réviser' :
        editor ? 'Kinétia : favorable · revue de ' + modelLabel(this.thread.review_model) + ' requise' : 'Brouillon';
      const star = node('button', script.saved ? '★' : '☆', 'rb-lib-star');
      star.type = 'button';
      star.setAttribute('aria-pressed', String(!!script.saved));
      star.setAttribute('aria-label', script.saved ? 'Retirer de la bibliothèque' : 'Enregistrer dans la bibliothèque');
      star.addEventListener('click', () => this.perform(script.saved ? 'library/remove' : 'library/save',
        request, 'Enregistrement…'));
      const head = node('div', '', 'rb-lib-head');
      head.append(node('strong', script.label || script.title), star);
      card.append(head, node('p', status, 'rb-ai-stage'));
      if (script.summary || script.summary_auto) card.append(node('p', script.summary || script.summary_auto, 'rb-lib-summary'));
      if (script.summary && script.summary_auto) card.append(node('p', script.summary_auto, 'rb-lib-meta'));
      if (Number.isFinite(script.min_clearance_mm)) {
        card.append(node('p', `Marge aux zones d’exclusion : ${Math.round(script.min_clearance_mm)} mm`, 'rb-lib-meta'));
      }
      if (script.parent_diff) {
        const d = script.parent_diff;
        const spd = d.speed_delta ? ` · vitesse ${d.speed_delta > 0 ? '+' : ''}${d.speed_delta}` : '';
        card.append(node('p', `Diff vs parent : Δmax ${d.max_step_change_deg}° · ${d.steps_before} → ${d.steps_after} étapes${spd}`, 'rb-lib-meta'));
      }
      const preview = script.trace?.length > 1 ? this.traceSvg(script.trace, script.timeline) : null;
      if (preview) card.append(preview.svg);
      const details = node('details');
      details.open = verdict === 'pass' && !script.approval;
      details.append(node('summary', `${script.steps.length} étape(s) · angles en degrés`));
      const list = node('ol');
      const pose = angles => [angles.base, angles.shoulder, angles.elbow, angles.hand].map(value => String(value)).join(' / ');
      details.append(node('p', 'Base / épaule / coude / pince'), node('p', 'Départ · ' + pose(script.start)),
        node('p', `Vitesse · ${script.speed} pas/s`));
      script.steps.forEach(angles => list.append(node('li', pose(angles))));
      details.append(list);
      card.append(details);
      card.append(this.scriptEditor(id, script, stale));
      if (script.kinetia_review) {
        card.append(node('strong', 'Kinétia · ' + (script.kinetia_review.verdict === 'pass' ? 'favorable' : 'à réviser')),
          node('p', script.kinetia_review.notes));
      }
      if (script.review) {
        card.append(node('strong', modelLabel(script.review.model)), node('p', script.review.notes));
      }
      if (script.last_played_at) {
        card.append(node('p', `Dernière lecture · ${new Date(script.last_played_at * 1000).toLocaleString()} · ${script.play_count || 1} fois`,
          'rb-lib-meta'));
      }
      const actions = node('div', '', 'rb-lib-actions');
      const add = (label, handler, disabled = false) => {
        const button = node('button', label);
        button.type = 'button';
        button.disabled = disabled;
        button.addEventListener('click', handler);
        actions.append(button);
      };
      if (preview) add('Visualiser', preview.play);
      if (script.start && script.steps?.length && this.lab.play3d) add('Voir en 3D', () => this.lab.play3d(script));
      if (script.trace?.length > 1 && this.lab.setArGhost) {
        const arActive = this.lab.arGhostScript?.id === id;
        add(arActive ? 'Masquer fantôme AR' : 'Aperçu AR', () => this.lab.setArGhost(arActive ? null : { ...script, id }));
      }
      const hardware = this.lab.state?.config.mode === 'hardware';
      if (!stale && script.steps?.length) {
        const seq = [script.start, ...(script.steps || [])];
        let maxDelta = 0;
        for (let i = 1; i < seq.length; i++) {
          for (const k of ['base', 'shoulder', 'elbow', 'hand']) {
            if (Number.isFinite(seq[i]?.[k]) && Number.isFinite(seq[i - 1]?.[k])) {
              maxDelta = Math.max(maxDelta, Math.abs(seq[i][k] - seq[i - 1][k]));
            }
          }
        }
        const st = this.lab.state;
        const volt = Number.isFinite(st?.feedback?.voltage) ? `${st.feedback.voltage.toFixed(1)} V` : (hardware ? 'V ?' : 'Sim');
        const cam = hardware ? (st?.camera_live ? 'Cam live' : 'Cam offline') : 'No interlock';
        const clr = Number.isFinite(script.min_clearance_mm) ? `Keepout ${Math.round(script.min_clearance_mm)} mm` : 'Keepout OK';
        const modeTag = script.plan ? 'Fluide' : 'Pas-à-pas';
        const warn = hardware && (!st?.camera_live && st?.config?.camera_required !== false);
        card.append(node('p', `Pre-Flight · ${modeTag} · Δmax ${maxDelta.toFixed(1)}° · ${clr} · ${volt} · ${cam}`,
          'rb-ai-preflight' + (warn ? ' is-warn' : '')));
      }
      if (script.approval && !stale && hardware) {
        const tb = script.torque_baseline;
        const armedLearn = this.learnTorqueId === id;
        const tbText = armedLearn ? 'Apprentissage empreinte Δτ armé pour la prochaine lecture.'
          : tb ? `Collision Δτ protégée (±${tb.tolerance || 180} · ${tb.steps?.length || 0} étapes)`
          : 'Collision Δτ : empreinte à vide non apprise';
        card.append(node('p', tbText, 'rb-lib-meta'));
        add(armedLearn ? 'Annuler apprentissage Δτ' : (tb ? 'Réapprendre empreinte Δτ' : 'Apprendre empreinte à vide'), () => {
          this.learnTorqueId = armedLearn ? null : id;
          this.render(false);
        });
        if (tb && !armedLearn) {
          add('Effacer Δτ', () => this.perform('library/torque-baseline', { ...request, baseline: null }, 'Suppression de l’empreinte…'));
        }
        card.append(node('p', 'Lecture réelle : petits pas mesurés, confirmation à chaque lancement. Visualiser ne bouge pas le bras.',
          'rb-lib-meta'));
      }
      if (script.start && script.steps?.length && this.lab.composeLoad) add('Modifier dans l’éditeur 3D', () => this.lab.composeLoad(script));
      if (!stale && editor && !script.approval && kinetia !== 'pass') {
        add(kinetia === 'revise' ? 'Redemander l’avis de Kinétia' : 'Faire revoir par Kinétia',
          () => this.perform('review-kinetia', request, 'Kinétia relit le script…'));
        add('Revue complète', () => this.fullReview(id, script));
      } else if (stale) {
        add('Mettre à jour pour les réglages actuels', (ev) => {
          this.confirmInPage(`rebase:${id}`, ev.currentTarget,
            'Cliquez de nouveau pour recréer ce script pour les réglages actuels (revue à refaire).',
            () => this.perform('library/rebase', request, 'Mise à jour du script…'));
        });
      } else if (verdict === 'revise') {
        add('Redemander la revue', () => this.perform('review', { ...request, again: true }, 'Nouvelle revue du script…'));
      } else if (verdict !== 'revise') {
        const live = hardware && this.liveConfirm === id;
        add(script.approval ? (live ? 'Confirmer : jouer sur le VRAI bras' : hardware ? 'Jouer sur le bras' : 'Jouer en simulation') :
          verdict === 'pass' ? 'Approuver cette version' : 'Faire revoir par ' + modelLabel(this.thread.review_model), (ev) => {
          if (script.approval) {
            if (hardware) this.liveClick(id, () => this.play(id, script));
            else this.play(id, script);
          } else if (verdict === 'pass') {
            this.confirmInPage(`approve:${id}`, ev.currentTarget,
              'Cliquez de nouveau pour approuver cette version (une confirmation restera requise sur le vrai bras).',
              () => this.perform('approve', { ...request, confirmed: true }, 'Enregistrement de votre approbation…')
                .then(() => { this.nodes.status.textContent = 'Script ajouté à la Bibliothèque, en bas de la page Robotique.'; }));
          } else this.perform('review', request, 'Revue du script…');
        });
        if (script.approval && hardware) {
          const key = id + ':fluid';
          add(this.liveConfirm === key ? 'Confirmer : jouer en fluide sur le VRAI bras' : 'Jouer en fluide',
            () => this.liveClick(key, () => this.play(id, script, true)));
        }
        if (script.approval?.manual) {
          add('Re-vérifier par le modèle', () => this.perform('review', { ...request, upgrade: true },
            'Revue par ' + modelLabel(this.thread.review_model) + '…'));
        }
      }
      if (!stale && !script.approval && (verdict === 'revise' || kinetia === 'revise')) {
        const notes = verdict === 'revise' ? script.review?.notes : script.kinetia_review?.notes;
        add('Corriger avec Kinétia', () => {
          const text = `Please propose a corrected version of "${script.label || script.title}" addressing this review note: ${notes || 'fix trajectory issues'}`;
          this.open();
          this.perform('message', { text, ptz_presets: this.lab.ptzPresets || [] }, 'Kinétia prépare une correction…');
        });
      }
      if (!stale && !script.approval && (!verdict || verdict === 'revise')) {
        add('Approuver sans avis du modèle', (ev) => {
          this.confirmInPage(`manual:${id}`, ev.currentTarget,
            'Aucun avis favorable du modèle : cliquez de nouveau pour approuver manuellement sous votre responsabilité.',
            () => this.perform('approve', { ...request, confirmed: true, manual: true }, 'Enregistrement de votre approbation…'));
        });
      }
      if (inLibrary) {
        add('Dupliquer', () => this.perform('library/duplicate', request, 'Duplication du script…'));
        add('Renommer', () => {
          if (card.querySelector('.rb-lib-rename')) return;
          const row = node('div', '', 'rb-lib-rename');
          const input = document.createElement('input');
          input.type = 'text';
          input.maxLength = 64;
          input.value = script.label || script.title || '';
          input.setAttribute('aria-label', 'Nouveau nom du script');
          const ok = node('button', 'Enregistrer');
          ok.type = 'button';
          const cancel = node('button', 'Annuler');
          cancel.type = 'button';
          ok.addEventListener('click', () => {
            const label = input.value.trim().slice(0, 64);
            if (label) this.perform('library/rename', { ...request, label }, 'Enregistrement…');
          });
          cancel.addEventListener('click', () => row.remove());
          row.append(input, ok, cancel);
          actions.after(row);
          input.focus();
        });
        add('Supprimer', (ev) => {
          this.confirmInPage(`delete:${id}`, ev.currentTarget,
            'Cliquez de nouveau pour supprimer définitivement ce script de la bibliothèque.',
            () => this.perform('library/delete', request, 'Suppression…'));
        });
      }
      if (actions.children.length) card.append(actions);
      return card;
    }

    confirmInPage(key, button, promptText, run) {
      if (this.inPageConfirm !== key) {
        this.inPageConfirm = key;
        clearTimeout(this.inPageConfirmTimer);
        if (button && !button.dataset.origLabel) button.dataset.origLabel = button.textContent;
        if (button) button.textContent = 'Confirmer';
        this.inPageConfirmTimer = setTimeout(() => {
          this.inPageConfirm = null;
          if (button && button.dataset.origLabel) button.textContent = button.dataset.origLabel;
        }, 8000);
        this.nodes.status.textContent = promptText;
        this.lab.message(promptText);
        return;
      }
      this.inPageConfirm = null;
      clearTimeout(this.inPageConfirmTimer);
      if (button && button.dataset.origLabel) button.textContent = button.dataset.origLabel;
      run();
    }

    async fullReview(id, script) {
      const request = { id, digest: script.digest };
      await this.perform('review-kinetia', request, 'Revue complète (1/2 · Kinétia)…');
      const updated = this.thread?.scripts?.[id];
      if (updated?.kinetia_review?.digest === updated?.digest && updated?.kinetia_review?.verdict === 'pass') {
        await this.perform('review', { id, digest: updated.digest }, 'Revue complète (2/2 · ' + modelLabel(this.thread.review_model) + ')…');
      }
    }

    // An in-page second click, not confirm(): a native dialog blurs the window and would disarm.
    liveClick(key, run) {
      if (this.liveConfirm !== key) {
        this.liveConfirm = key;
        clearTimeout(this.liveTimer);
        this.liveTimer = setTimeout(() => { this.liveConfirm = null; this.render(false); }, 8000);
        const warning = 'Dégagez la zone, gardez la coupure physique à portée et cette fenêtre au premier plan. Cliquez de nouveau pour jouer sur le vrai bras.';
        this.nodes.status.textContent = warning;
        this.lab.message(warning);
        this.render(false);
        return;
      }
      clearTimeout(this.liveTimer);
      this.liveConfirm = null;
      run();
    }

    async play(id, script, fluid = false) {
      const hardware = this.lab.state?.config.mode === 'hardware';
      if (!['simulation', 'hardware'].includes(this.lab.state?.config.mode) || !this.lab.lease) {
        const text = 'Armez le poste depuis Robotique avant de lancer le script.';
        this.nodes.status.textContent = text;
        this.lab.message(text, true);
        return;
      }
      if (this.lab.playingScript) return;
      if (hardware) {
        try {
          this.thread = await this.lab.api('/api/robotics/assistant/live', {
            method: 'POST', timeoutMs: 8000, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, digest: script.digest, lease: this.lab.lease, confirmed: true, fluid }),
          });
        } catch (error) {
          this.nodes.status.textContent = error.message;
          this.lab.message(error.message, true);
          return;
        }
      }
      const learnTorque = this.learnTorqueId === id;
      this.close();
      this.lab.message(learnTorque ? 'Lecture avec apprentissage de l’empreinte Δτ…' : 'Lecture du script…');
      try {
        const outcome = await this.lab.playReviewedScript({ ...script, id, learnTorque });
        const completed = typeof outcome === 'object' ? outcome.completed : !!outcome;
        const recorded = typeof outcome === 'object' ? outcome.recordedTorque : null;
        if (learnTorque && completed && Array.isArray(recorded) && recorded.length) {
          this.learnTorqueId = null;
          await this.perform('library/torque-baseline', {
            id, digest: script.digest, baseline: { steps: recorded, tolerance: 180 },
          }, 'Enregistrement de l’empreinte Δτ…');
          if (this.lab.active) this.lab.message('Empreinte collision Δτ enregistrée.');
        } else {
          if (this.lab.active) this.lab.message(completed ? 'Script terminé.' : 'Lecture interrompue.');
          if (this.lab.active) this.perform('thread', undefined, 'Actualisation…');
        }
      } catch (error) {
        if (this.lab.active) this.lab.message(error.message, true);
      }
    }

    handleLocalMacro(text, macroId) {
      const m = BENCH_MACROS[macroId];
      if (!m) return;
      this.localMessages ||= [];
      this.localMessages.push({ role: 'user', text });
      const needsArm = m.armed && !this.lab.armedNow;
      const reply = m.safePrep
        ? `Macro prête : « ${m.label} ». Je l’exécute sans déplacer le bras.`
        : needsArm
          ? `Macro « ${m.label} » prête. Armez d’abord le poste dans Pilotage, puis cliquez sur le bouton ci-dessous.`
          : `Macro « ${m.label} » prête. Cliquez ci-dessous pour l’exécuter sous votre bail de sécurité.`;
      this.localMessages.push({ role: 'assistant', text: reply, macro: macroId });
      this.render(true);
      if (m.safePrep) this.runBenchMacro(macroId);
    }

    async runBenchMacro(macroId) {
      const m = BENCH_MACROS[macroId];
      if (!m) return;
      if (m.armed && (!this.lab.lease || !this.lab.armedNow)) {
        const msg = 'Armez le poste depuis Pilotage avant d’exécuter « ' + m.label + ' ».';
        this.nodes.status.textContent = msg;
        this.lab.message(msg, true);
        return;
      }
      this.nodes.status.textContent = 'Exécution : ' + m.label + '…';
      try {
        await this.lab.run(async () => {
          if (macroId === 'present') await this.lab.thirdHandPresent();
          else if (macroId === 'hold') await this.lab.thirdHandHold();
          else if (macroId === 'release') await this.lab.thirdHandRelease();
          else if (macroId === 'home') await this.lab.goHome();
          else if (macroId === 'teach_on') {
            if (!this.lab.state?.teach_mode) await this.lab.toggleTeachMode();
          } else if (macroId === 'teach_off') {
            if (this.lab.state?.teach_mode) await this.lab.toggleTeachMode();
          } else if (macroId === 'transfer_compose') await this.lab.composeSynthesized(this.lab.buildTransferPayload());
          else if (macroId === 'pallet_compose') await this.lab.composeSynthesized(this.lab.buildPalletPayload());
          else if (macroId === 'inspect_compose') await this.lab.composeSynthesized({ synthesize: 'inspect' });
          else if (macroId === 'snapshot') this.lab.captureVideoFrame('Kinétia');
        });
        this.nodes.status.textContent = m.label + ' · terminé.';
      } catch (error) {
        this.nodes.status.textContent = error.message;
      }
    }

    toolLabel(tool) {
      const n = tool?.name;
      if (n === 'apply_preset') return `Prévisualiser position « ${tool.preset || 'Preset'} »`;
      if (n === 'load_routine') return `Charger routine « ${tool.routine || 'Routine'} »`;
      if (n === 'synthesize_transfer') return 'Préparer transfert paramétré (3D)';
      if (n === 'synthesize_pallet') return `Préparer grille ${tool.params?.rows || 2}×${tool.params?.cols || 3} (3D)`;
      if (n === 'synthesize_inspect') return `Préparer scan ${tool.params?.stops || 5} angles (3D)`;
      if (n === 'open_blackbox') return 'Ouvrir le Journal noir 3D';
      if (n === 'vision_aim') return 'Pointer objet sur direct Tapo';
      if (n === 'ptz_preset') return `Cadrer caméra « ${tool.preset || 'Vue'} »`;
      if (n === 'set_tool_guard') {
        const parts = [];
        if (Number.isFinite(tool.tool_offset_mm)) parts.push(`Outil +${Math.round(tool.tool_offset_mm)} mm`);
        if (Number.isFinite(tool.floor_z_mm)) parts.push(`Plancher ${Math.round(tool.floor_z_mm)} mm`);
        return `Appliquer garde (${parts.join(' · ') || 'outil'})`;
      }
      return n || 'Outil atelier';
    }

    async runBenchTool(tool) {
      if (!tool?.name) return;
      const n = tool.name;
      const label = this.toolLabel(tool);
      this.nodes.status.textContent = label + '…';
      try {
        await this.lab.run(async () => {
          if (n === 'apply_preset') {
            const sel = this.lab.nodes.presets;
            const q = String(tool.preset || '').toLowerCase();
            const opt = [...(sel?.options || [])].find(o => o.value === tool.preset || o.textContent.toLowerCase().includes(q));
            if (!opt?.value) throw new Error(`Position « ${tool.preset || ''} » introuvable.`);
            sel.value = opt.value;
            this.lab.controls();
            this.lab.nodes['preset-preview']?.click();
          } else if (n === 'load_routine') {
            const sel = this.lab.nodes.routines;
            const q = String(tool.routine || '').toLowerCase();
            const opt = [...(sel?.options || [])].find(o => o.value === tool.routine || o.textContent.toLowerCase().includes(q));
            if (!opt?.value) throw new Error(`Routine « ${tool.routine || ''} » introuvable.`);
            sel.value = opt.value;
            this.lab.controls();
          } else if (n === 'synthesize_transfer') {
            await this.lab.composeSynthesized({ ...this.lab.buildTransferPayload(), ...(tool.params || {}), synthesize: 'transfer' });
          } else if (n === 'synthesize_pallet') {
            await this.lab.composeSynthesized({ ...this.lab.buildPalletPayload(), ...(tool.params || {}), synthesize: 'pallet' });
          } else if (n === 'synthesize_inspect') {
            await this.lab.composeSynthesized({ synthesize: 'inspect', ...(tool.params || {}) });
          } else if (n === 'open_blackbox') {
            this.lab.flightToggle(true);
          } else if (n === 'vision_aim') {
            await this.lab.detectCameraObject();
            const tx = Number(this.lab.form.x?.valueAsNumber);
            const ty = Number(this.lab.form.y?.valueAsNumber);
            const tz = Number(this.lab.form.z?.valueAsNumber) || 90;
            if (Number.isFinite(tx) && Number.isFinite(ty)) {
              this.localMessages = [...(this.localMessages || []), {
                role: 'assistant',
                text: `Target locked at X ${Math.round(tx)} · Y ${Math.round(ty)} mm. Hover +45 mm staged in 3D preview.`,
                tool: { name: 'synthesize_transfer', params: { source: { x: tx, y: ty, z: Math.max(35, tz + 45) }, clearance_z: 60 } },
              }].slice(-8);
              this.render(true);
            }
          } else if (n === 'ptz_preset') {
            const sel = this.lab.nodes['ptz-preset'];
            const q = String(tool.preset || '').toLowerCase();
            const opt = [...(sel?.options || [])].find(o => o.value === tool.preset || o.textContent.toLowerCase().includes(q));
            if (opt?.value) sel.value = opt.value;
            await this.lab.gotoPtzPreset();
          } else if (n === 'set_tool_guard') {
            if (Number.isFinite(tool.tool_offset_mm) && this.lab.nodes['tool-offset']) {
              this.lab.nodes['tool-offset'].value = String(tool.tool_offset_mm);
            }
            if (Number.isFinite(tool.floor_z_mm) && this.lab.nodes['floor-z']) {
              this.lab.nodes['floor-z'].value = String(tool.floor_z_mm);
            }
            this.lab._sideStatic = null;
            this.lab.pilotAids();
            this.lab.drawSide(this.lab.displayActual(), this.lab.fieldPose());
            this.lab.drawPosition();
          }
        });
        this.nodes.status.textContent = label + ' · prêt.';
      } catch (error) {
        this.nodes.status.textContent = error.message;
      }
    }

    setMood(mood, ms = 3600) {
      clearTimeout(this.moodTimer);
      this.root.classList.remove('is-happy', 'is-caring', 'is-focused', 'is-alert', 'is-curious');
      if (mood === 'happy' || mood === 'caring' || mood === 'focused' || mood === 'alert' || mood === 'curious') {
        this.root.classList.add('is-' + mood);
        if (ms > 0) this.moodTimer = setTimeout(() => this.root.classList.remove('is-' + mood), ms);
      }
    }

    async liveCheckin(kind, telemetry, { allowCollapsed = false } = {}) {
      if (this.busy) return false;
      try {
        const res = await this.lab.api('/api/robotics/assistant/checkin', {
          method: 'POST', timeoutMs: 16000, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, telemetry }),
        });
        if (res?.ok && !this.busy) {
          this.thread = res;
          const reply = this.thread.messages.at(-1);
          if (reply?.text) {
            this.liveBannerText = reply.text;
            this.liveBannerUntil = Date.now() + 45000;
            this.lab.updateCopilot?.(this.lab.state);
          }
          if (reply?.mood) this.setMood(reply.mood, 5000);
          if (!this.chat.hidden || (allowCollapsed && this.thread?.settings?.alerts !== false)) {
            this.speak(reply?.text, reply?.language, { allowCollapsed });
          }
          this.render(true);
          return true;
        }
      } catch (_) {}
      return false;
    }

    onMissionComplete(state) {
      if (!state) return;
      const loads = Object.values(state.feedback?.load || {}).filter(Number.isFinite).map(Math.abs);
      const peak = loads.length ? Math.round(Math.max(...loads)) : null;
      const volt = Number.isFinite(state.feedback?.voltage) ? Number(state.feedback.voltage.toFixed(1)) : null;
      const err = Number.isFinite(state.shadow?.tracking_error_deg) ? Number(state.shadow.tracking_error_deg.toFixed(1)) : null;
      const warnLoad = peak != null && peak >= (state.config?.load_warn ?? 700);
      const warnVolt = volt != null && volt < 10.8;
      this.setMood(warnLoad || warnVolt ? 'caring' : 'happy');
      if (!this.busy) {
        this.liveCheckin(warnLoad ? 'heavy_load_rest' : 'debrief', {
          peak_load: peak, voltage: volt, tracking_error_deg: err, warn_load: warnLoad, warn_voltage: warnVolt,
        }, { allowCollapsed: true }).then(ok => {
          if (ok) return;
          const facts = [peak != null ? `peak load ${peak}` : '', volt != null ? `${volt} V` : '', err != null ? `track err ${err}°` : ''].filter(Boolean).join(' · ');
          if (facts) {
            this.localMessages = [...(this.localMessages || []), { role: 'assistant', text: facts }].slice(-8);
            if (!this.chat.hidden) this.render(true);
          }
        });
      }
    }
  }

  window.HqRoboticsAssistant = { mount: lab => new Assistant(lab) };
})();
