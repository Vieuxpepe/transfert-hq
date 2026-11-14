/* Robotique assistant. Uses HQ's shared portrait mode and chip scaling. */
(() => {
  'use strict';
  const POS = 'hq_robotics_assistant_pos_v1';
  const SCALE = 'hq_robotics_assistant_scale_v1';
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
      this.scale = window.HqImageChipScale.bind(window, {
        root: this.root, chip: this.chip, storageKey: SCALE,
        cancelDrag: () => { this.drag = null; this.suppressClick = true; },
        setBlocked: blocked => { this.pinch = blocked; },
      });
      window.HqImageChipScale.bindPortraitMode(window, {
        root: this.root, onRefresh: adult => this.portrait(adult),
      });
      this.bind();
    }

    bind() {
      const on = (key, fn) => this.nodes[key].addEventListener('click', fn);
      on('options', () => this.toggleOptions());
      for (const key of ['voice', 'alerts']) {
        this.nodes[key].addEventListener('change', () =>
          this.perform('settings', { [key]: this.nodes[key].checked }, 'Enregistrement…'));
      }
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
      this.nodes.form.addEventListener('submit', event => {
        event.preventDefault();
        const text = this.nodes.prompt.value.trim();
        if (text) this.perform('message', { text }, 'Rédaction…');
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
      this.chip.style.left = (area.x + clamp(this.position.x, 0, 1) * area.width) + 'px';
      this.chip.style.top = (area.y + clamp(this.position.y, 0, 1) * area.height) + 'px';
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
      if (this.busy) return;
      this.busy = true;
      this.nodes.status.textContent = pending;
      this.nodes.send.disabled = true;
      this.nodes.log.querySelectorAll('button').forEach(el => { el.disabled = true; });
      try {
        const options = body === undefined ? { timeoutMs: 5000 } : {
          method: 'POST', timeoutMs: 43000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        };
        this.thread = await this.lab.api('/api/robotics/assistant/' + action, options);
        if (action === 'message' && !this.chat.hidden) {
          const reply = this.thread.messages.at(-1);
          this.speak(reply?.text, reply?.language);
        }
        if (action === 'message' && this.nodes.prompt.value.trim() === body.text) this.nodes.prompt.value = '';
        this.nodes.status.textContent = '';
      } catch (err) {
        this.nodes.status.textContent = err.message;
      } finally {
        this.busy = false;
        this.nodes.send.disabled = false;
        this.render(action === 'message' || action === 'thread');
      }
    }

    render(scroll) {
      const log = this.nodes.log;
      const top = log.scrollTop;
      const messages = this.thread?.messages || [];
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
      if (!messages.length) log.append(node('p', 'Décrivez une trajectoire. Le modèle de revue et vous devrez approuver le script avant de le jouer.', 'rb-ai-empty'));
      for (const message of messages) {
        const isUser = message.role === 'user';
        const block = node('div', '', 'rb-ai-message' + (isUser ? ' is-user' : ''));
        block.append(node('strong', isUser ? 'Vous' : 'Kinétia'), node('p', message.text));
        const script = this.thread.scripts[message.script_id];
        if (script) block.append(this.scriptCard(message.script_id, script));
        log.append(block);
      }
      log.scrollTop = scroll ? log.scrollHeight : top;
    }

    observe(state) {
      const current = {
        uncertain: !!state.uncertain, stopped: !!state.stop_latched,
        camera: !!state.camera_live, feedback: !!state.feedback, hardware: state.config.mode === 'hardware',
      };
      const previous = this.observed;
      this.observed = current;
      const notice = current.uncertain ? 'Kinétia · Mouvement incertain. Vérifiez le bras sur place.' :
        current.stopped ? 'Kinétia · STOP enclenché. Le poste attend votre réinitialisation.' :
        previous?.camera && !current.camera && current.hardware ? 'Kinétia · Retour vidéo perdu. Vérifiez la caméra avant de réarmer.' :
        previous?.hardware && previous.feedback && !current.feedback && current.hardware ?
          'Kinétia · Le RoArm ne renvoie plus de télémétrie.' :
        previous?.uncertain || previous?.stopped ? 'Kinétia · Le poste est de nouveau prêt pour vos vérifications.' : '';
      if (notice && notice !== this.notice && this.thread?.settings?.alerts !== false) {
        this.notice = notice;
        this.nodes['alert-dot'].hidden = !this.chat.hidden;
        if (!this.chat.hidden && !this.busy) {
          this.render(false);
          this.speak(notice.replace(/^Kinétia · /, ''));
        }
      }
    }

    async speak(text, language = 'fr') {
      if (!text || this.thread?.settings?.voice !== true || this.chat.hidden) return;
      const marker = this.voiceRequest = {};
      try {
        const result = await this.lab.api('/api/robotics/assistant/voice', {
          method: 'POST', timeoutMs: 35000, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 600), language }),
        });
        if (this.chat.hidden || marker !== this.voiceRequest) return;
        this.audio?.pause();
        this.audio = new Audio(result.audio_url);
        await this.audio.play();
      } catch (_) {}
    }

    scriptCard(id, script) {
      const card = node('section', '', 'rb-ai-script');
      const request = { id, digest: script.digest };
      const stale = script.revision !== (this.lab.state?.config.revision ?? this.thread.revision);
      const verdict = script.review?.verdict;
      const status = stale ? 'Réglages modifiés' : script.approval ? 'Approuvé' :
        verdict === 'pass' ? 'Votre approbation est requise' : verdict === 'revise' ? 'À réviser' : 'Brouillon';
      card.append(node('strong', script.title), node('p', status, 'rb-ai-stage'));
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
      if (script.review) {
        card.append(node('strong', modelLabel(script.review.model)), node('p', script.review.notes));
      }
      if (stale || verdict === 'revise') return card;
      const button = node('button', script.approval ? 'Jouer en simulation' :
        verdict === 'pass' ? 'Approuver cette version' : 'Faire revoir par ' + modelLabel(this.thread.review_model));
      button.type = 'button';
      button.disabled = !!script.approval && this.lab.state?.config.mode !== 'simulation';
      button.addEventListener('click', () => {
        if (script.approval) this.play(id, script);
        else if (verdict === 'pass') {
          if (confirm('Approuver ces étapes pour le simulateur ?')) {
            this.perform('approve', { ...request, confirmed: true }, 'Enregistrement de votre approbation…');
          }
        } else this.perform('review', request, 'Revue du script…');
      });
      card.append(button);
      return card;
    }

    async play(id, script) {
      if (this.lab.state?.config.mode !== 'simulation' || !this.lab.lease) {
        this.nodes.status.textContent = 'Armez le simulateur depuis Robotique avant de lancer le script.';
        return;
      }
      if (this.lab.playingScript) return;
      this.close();
      this.lab.message('Lecture du script…');
      try {
        const completed = await this.lab.playReviewedScript({ ...script, id });
        if (this.lab.active) this.lab.message(completed ? 'Script terminé.' : 'Lecture interrompue.');
      } catch (error) {
        if (this.lab.active) this.lab.message(error.message, true);
      }
    }
  }

  window.HqRoboticsAssistant = { mount: lab => new Assistant(lab) };
})();
