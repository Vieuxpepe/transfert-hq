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
      this.lab.nodes['library-list']?.querySelectorAll('button').forEach(el => { el.disabled = true; });
      try {
        const options = body === undefined ? { timeoutMs: 5000 } : {
          method: 'POST', timeoutMs: action === 'review' ? 115000 : 43000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
        this.lab.message(err.message, true);  // the library cards live outside the chat panel
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
      this.renderLibrary();
    }

    renderLibrary() {
      const section = this.lab.nodes.library;
      const list = this.lab.nodes['library-list'];
      if (!section || !list) return;
      section.hidden = this.root.hidden;
      const revision = this.lab.state?.config.revision ?? this.thread?.revision;
      const wanted = ([, script]) => {
        const stale = script.revision !== revision;
        return this.filter === 'all' || (this.filter === 'stale' && stale) ||
          (this.filter === 'approved' && !stale && !!script.approval);
      };
      const saved = Object.entries(this.thread?.scripts || {}).filter(([, script]) => script.saved)
        .sort((a, b) => (b[1].saved_at || 0) - (a[1].saved_at || 0));
      const entries = saved.filter(wanted);
      list.replaceChildren(...(entries.length ? entries.map(([id, script]) => this.scriptCard(id, script, true)) :
        [node('p', 'Aucun script ici. Étoilez un script de la conversation de Kinétia pour le garder.', 'rb-library-empty')]));
      section.querySelectorAll('[data-lib-filter]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.libFilter === this.filter)));
      this.lab.setLibraryTraces?.(saved.map(([id, script]) => ({
        id, label: script.label || script.title, trace: script.trace,
      })));
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
      const current = {
        uncertain: !!state.uncertain, stopped: !!state.stop_latched,
        camera: !!state.camera_live, feedback: !!state.feedback, hardware: state.config.mode === 'hardware',
      };
      const previous = this.observed;
      this.observed = current;
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
      const save = node('button', 'Enregistrer comme nouvelle version');
      save.type = 'button';
      save.disabled = true;
      area.addEventListener('input', () => { save.disabled = stale || area.value === original; });
      save.addEventListener('click', () => {
        let edited;
        try { edited = JSON.parse(area.value); } catch (error) { tell('JSON invalide : ' + error.message, true); return; }
        if (!edited || typeof edited !== 'object' || JSON.stringify(edited.start) !== JSON.stringify(script.start)) {
          tell('Le départ est fixe et doit rester identique.', true);
          return;
        }
        const { start, ...changes } = edited;
        if (confirm('Enregistrer comme nouvelle version ? La revue et votre approbation seront à refaire.')) {
          this.perform('library/edit', { id, digest: script.digest, script: changes }, 'Enregistrement de la nouvelle version…');
        }
      });
      const actions = node('div', '', 'rb-lib-actions');
      actions.append(copy, save);
      wrap.append(area, node('p', stale ? 'Mettez le script à jour pour les réglages actuels avant de le modifier.' :
        'Le départ est fixe. Toute modification annule la revue et votre approbation.', 'rb-lib-meta'), actions);
      return wrap;
    }

    scriptCard(id, script, inLibrary = false) {
      const card = node('section', '', 'rb-ai-script');
      const request = { id, digest: script.digest };
      const stale = script.revision !== (this.lab.state?.config.revision ?? this.thread.revision);
      const verdict = script.review?.verdict;
      const status = stale ? 'Réglages modifiés' : script.approval ? (script.approval.manual ? 'Approuvé manuellement (sans avis du modèle)' : 'Approuvé') :
        verdict === 'pass' ? 'Votre approbation est requise' : verdict === 'revise' ? 'À réviser' : 'Brouillon';
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
      const hardware = this.lab.state?.config.mode === 'hardware';
      if (script.approval && !stale && hardware) {
        card.append(node('p', 'Lecture réelle : petits pas mesurés, confirmation à chaque lancement. Visualiser ne bouge pas le bras.',
          'rb-lib-meta'));
      }
      if (stale) {
        add('Mettre à jour pour les réglages actuels', () => {
          if (confirm('Recréer ce script pour les réglages actuels ? La revue et votre approbation seront à refaire.')) {
            this.perform('library/rebase', request, 'Mise à jour du script…');
          }
        });
      } else if (verdict === 'revise') {
        add('Redemander la revue', () => this.perform('review', { ...request, again: true }, 'Nouvelle revue du script…'));
      } else if (verdict !== 'revise') {
        const live = hardware && this.liveConfirm === id;
        add(script.approval ? (live ? 'Confirmer : jouer sur le VRAI bras' : hardware ? 'Jouer sur le bras' : 'Jouer en simulation') :
          verdict === 'pass' ? 'Approuver cette version' : 'Faire revoir par ' + modelLabel(this.thread.review_model), () => {
          if (script.approval) {
            if (hardware) this.liveClick(id, () => this.play(id, script));
            else this.play(id, script);
          } else if (verdict === 'pass') {
            if (confirm('Approuver ces étapes ? Une confirmation supplémentaire sera demandée avant toute lecture sur le vrai bras.')) {
              this.perform('approve', { ...request, confirmed: true }, 'Enregistrement de votre approbation…')
                .then(() => { this.nodes.status.textContent = 'Script ajouté à la Bibliothèque, en bas de la page Robotique.'; });
            }
          } else this.perform('review', request, 'Revue du script…');
        });
        if (script.approval && hardware) {
          const key = id + ':fluid';
          add(this.liveConfirm === key ? 'Confirmer : jouer en fluide sur le VRAI bras' : 'Jouer en fluide',
            () => this.liveClick(key, () => this.play(id, script, true)));
        }
      }
      if (!stale && !script.approval && (!verdict || verdict === 'revise')) {
        add('Approuver sans avis du modèle', () => {
          if (confirm('Aucun avis favorable du modèle. Vous approuvez ces étapes sous votre seule responsabilité. Chaque lecture sur le vrai bras demandera encore sa propre confirmation. Approuver manuellement ?')) {
            this.perform('approve', { ...request, confirmed: true, manual: true }, 'Enregistrement de votre approbation…');
          }
        });
      }
      if (inLibrary) {
        add('Renommer', () => {
          const label = prompt('Nom du script', script.label || script.title);
          if (label?.trim()) this.perform('library/rename', { ...request, label: label.trim().slice(0, 64) }, 'Enregistrement…');
        });
        add('Supprimer', () => {
          if (confirm('Supprimer ce script de la bibliothèque ?')) this.perform('library/delete', request, 'Suppression…');
        });
      }
      if (actions.children.length) card.append(actions);
      return card;
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
      this.close();
      this.lab.message('Lecture du script…');
      try {
        const completed = await this.lab.playReviewedScript({ ...script, id });
        if (this.lab.active) this.lab.message(completed ? 'Script terminé.' : 'Lecture interrompue.');
        if (this.lab.active) this.perform('thread', undefined, 'Actualisation…');
      } catch (error) {
        if (this.lab.active) this.lab.message(error.message, true);
      }
    }
  }

  window.HqRoboticsAssistant = { mount: lab => new Assistant(lab) };
})();
