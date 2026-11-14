/* Robotique is mounted only when its HQ view opens. */
(() => {
  'use strict';
  const axes = { base: 'Base', shoulder: 'Épaule', elbow: 'Coude', hand: 'Pince' };
  const coordinates = { x: 'X', y: 'Y', z: 'Z', t: 'Pince' };
  const axisKeys = Object.keys(axes);
  const prefix = '/api/robotics/';
  const format = (value, unit = '') => Number.isFinite(value) ? value.toFixed(1) + unit : '—';
  const field = (name, label, attrs = '') =>
    `<label>${label}<input name="${name}" ${attrs}></label>`;
  const limits = (labels) => Object.entries(labels).map(([key, label]) =>
    `<div class="rb-limit"><span>${label}</span>${field(key + '-min', 'Min', 'type="number" step="any" required')}
    ${field(key + '-max', 'Max', 'type="number" step="any" required')}</div>`).join('');
  const axisRows = (labels, cartesian = false) => Object.entries(labels).map(([key, label]) => `
    <div class="rb-axis">
      <label for="rb-${key}">${label}</label>
      <button type="button" data-step="${key}" data-direction="-1" aria-label="${label} moins" disabled>−</button>
      <div class="rb-axis-input">
        <input id="rb-${key}" name="${key}" type="number" step="any" inputmode="decimal" required>
        <span aria-hidden="true">${cartesian && key !== 't' ? 'mm' : '°'}</span>
      </div>
      <button type="button" data-step="${key}" data-direction="1" aria-label="${label} plus" disabled>+</button>
    </div>`).join('');

  const markup = `
    <header class="rb-head">
      <div><h1>Robotique</h1><p>RoArm-M2-S <span aria-hidden="true">/</span> Tapo C200</p></div>
      <div class="rb-head-actions">
        <button type="button" data-rb="open-assistant" aria-controls="hq-robotics-chat">Kinétia</button>
        <button type="button" data-rb="open-settings" aria-controls="robotics-settings">Réglages</button>
      </div>
    </header>
    <div class="rb-status" aria-label="État du poste">
      <div class="rb-status-device"><span>Mode</span><strong data-rb="mode">Connexion…</strong></div>
      <div class="rb-status-device"><span>Bras</span><strong data-rb="arm-state">—</strong></div>
      <div class="rb-status-device"><span>Caméra</span><strong data-rb="camera-state">—</strong></div>
      <div class="rb-status-safety">
        <strong data-rb="safety" role="status">Désarmé</strong>
        <button type="button" class="rb-stop" data-rb="stop" disabled>STOP logiciel</button>
      </div>
    </div>
    <div class="rb-workspace">
      <section class="rb-card rb-camera" aria-labelledby="rb-monitor-title">
        <div class="rb-card-head rb-monitor-head">
          <h2 id="rb-monitor-title">Moniteur</h2>
          <div class="rb-tabs" role="group" aria-label="Vue du moniteur">
            <button type="button" data-monitor="position" aria-controls="rb-position-pane" aria-pressed="true">Position</button>
            <button type="button" data-monitor="camera" aria-controls="rb-camera-pane" aria-pressed="false">Caméra</button>
          </div>
        </div>
        <div id="rb-position-pane" data-rb="position-pane">
          <div class="rb-viewport rb-plot">
            <div class="rb-plot-caption"><span>Plan XY</span><span data-rb="plot-source">—</span></div>
            <canvas data-rb="plot" aria-hidden="true"></canvas>
            <div class="rb-plot-key"><span class="rb-key-area">Zone XY</span><span>Position</span><span class="rb-key-preview" data-rb="plot-preview" hidden>Aperçu</span></div>
          </div>
          <dl class="rb-coordinates">
            ${['x', 'y', 'z'].map(axis => `<div><dt>${axis.toUpperCase()}</dt><dd><output data-rb="position-${axis}">—</output><span>mm</span></dd></div>`).join('')}
          </dl>
        </div>
        <div id="rb-camera-pane" data-rb="camera-pane" hidden>
          <div class="rb-viewport" data-rb="viewport">
            <video data-rb="video" muted playsinline aria-label="Vidéo en direct du Tapo C200"></video>
            <span class="rb-video-note" data-rb="video-note">Flux arrêté</span>
            <div class="rb-video-idle" data-rb="video-idle">
              <span class="rb-lens" aria-hidden="true"></span>
              <strong>Caméra en veille</strong><span data-rb="video-hint"></span>
              <button type="button" data-rb="camera-setup" hidden>Configurer le Tapo</button>
            </div>
          </div>
          <div class="rb-camera-actions">
            <label class="rb-quality">Qualité <select data-rb="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
            <div class="rb-actions">
              <button type="button" class="rb-primary" data-rb="video-start" disabled>Démarrer le direct</button>
              <button type="button" data-rb="video-stop" disabled hidden>Couper le flux</button>
              <button type="button" data-rb="fullscreen" disabled hidden>Plein écran</button>
            </div>
          </div>
        </div>
      </section>
      <section class="rb-card rb-motion" aria-labelledby="rb-motion-title">
        <div class="rb-card-head"><h2 id="rb-motion-title">Pilotage</h2><span data-rb="motion-state">En attente</span></div>
        <div class="rb-safety">
          <div class="rb-actions"><button type="button" class="rb-primary" data-rb="arm" disabled>Armer</button>
            <button type="button" data-rb="cancel" disabled>Annuler / désarmer</button>
            <button type="button" data-rb="reset" hidden>Réinitialiser</button>
            <button type="button" data-rb="probe" hidden>Lire le RoArm</button></div>
          <p data-rb="interlock">Chargement de l’état…</p>
          <p class="rb-hardware-note" data-rb="hardware-note" hidden>Le STOP demande la coupure du couple. Le bras peut tomber. Si la liaison échoue, utilisez la coupure physique.</p>
        </div>
        <div class="rb-tabs" role="group" aria-label="Mode de pilotage">
          <button type="button" data-mode="joints" aria-pressed="true">Articulations</button>
          <button type="button" data-mode="cartesian" aria-pressed="false">XYZ</button>
        </div>
        <form data-rb="pose" class="rb-pose">
          <div data-rb="joints">${axisRows(axes)}</div>
          <div data-rb="cartesian" hidden>${axisRows(coordinates, true)}</div>
          <div class="rb-tuning">
            <label>Pas · °<select data-rb="angle-step"><option>1</option><option selected>2</option><option>5</option></select></label>
            <label data-rb="linear-step-label" hidden>Pas · mm<select data-rb="linear-step"><option>1</option><option selected>5</option><option>10</option></select></label>
            <label>Vitesse · pas/s<input data-rb="speed" type="number" inputmode="numeric" min="40" max="100" step="1" value="100" required></label>
          </div>
          <div class="rb-actions rb-motion-actions"><button type="button" data-rb="preview" disabled>Aperçu</button>
            <button type="button" data-rb="home" disabled>Retour au neutre</button>
            <button type="submit" class="rb-primary" data-rb="move" disabled>Déplacer</button></div>
          <output data-rb="preview-result" aria-live="polite" hidden></output>
        </form>
      </section>
      <section class="rb-card rb-telemetry" aria-labelledby="rb-telemetry-title">
        <div class="rb-card-head"><h2 id="rb-telemetry-title">Télémétrie</h2><span data-rb="feedback-state">—</span></div>
        <table><thead><tr><th scope="col">Axe</th><th scope="col" data-rb="actual-label">Mesuré</th><th scope="col">Demandé</th><th scope="col">Charge</th></tr></thead>
          <tbody>${Object.entries(axes).map(([key, label]) => `<tr><th scope="row">${label}</th>
          <td data-rb="actual-${key}">—</td><td data-rb="target-${key}">—</td><td data-rb="load-${key}">—</td></tr>`).join('')}</tbody></table>
        <div class="rb-readings" data-rb="electrical" hidden><output data-rb="voltage">Tension —</output></div>
      </section>
      <section class="rb-card rb-presets" aria-labelledby="rb-presets-title">
        <div class="rb-card-head"><h2 id="rb-presets-title">Positions</h2></div>
        <div class="rb-preset-fields"><label>Position enregistrée<select data-rb="presets"><option value="">Choisir…</option></select></label>
          <label>Nom<input data-rb="preset-name" maxlength="64"></label></div>
        <div class="rb-actions"><button type="button" data-rb="preset-preview" disabled>Charger</button>
          <button type="button" data-rb="preset-run" disabled>Exécuter</button>
          <button type="button" data-rb="preset-save" disabled>Enregistrer la cible</button>
          <button type="button" data-rb="preset-rename" disabled>Renommer</button><button type="button" data-rb="preset-delete" disabled>Supprimer</button></div>
        <details class="rb-sequence" data-rb="sequence"><summary>Séquence de simulation</summary>
          <ol data-rb="steps"></ol><div class="rb-actions">
          <button type="button" data-rb="step-add">Ajouter la cible</button><button type="button" data-rb="sequence-clear">Vider</button>
          <button type="button" data-rb="sequence-check">Valider</button><button type="button" data-rb="sequence-run" disabled>Jouer une fois</button></div></details>
      </section>
      <details class="rb-card rb-config" id="robotics-settings"><summary>Réglages et calibration</summary>
        <p data-rb="settings-note"></p>
        <form data-rb="settings" autocomplete="off">
          <fieldset data-rb="settings-fields" disabled>
            <legend>Connexions</legend>
            <div class="rb-settings-grid">
              <label>Mode<select name="mode"><option value="simulation">Simulation</option><option value="hardware">Matériel</option></select></label>
              ${field('arm_ip', 'IPv4 / hôte du RoArm', 'maxlength="253" placeholder="192.168.x.x"')}
              ${field('arm_timeout', 'Délai RoArm · s', 'type="number" min=".2" max="1.5" step=".1" required')}
              ${field('camera_ip', 'IPv4 / hôte du Tapo', 'maxlength="253" placeholder="192.168.x.x"')}
              ${field('camera_user', 'Compte caméra', 'type="password" autocomplete="new-password" maxlength="64"')}
              ${field('camera_password', 'Mot de passe caméra', 'type="password" autocomplete="new-password" maxlength="128"')}
              ${field('camera_timeout', 'Délai vidéo · s', 'type="number" min="2" max="12" step="1" required')}
              <label>Qualité par défaut<select name="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
              <label>Transport<select name="transport"><option value="http">HTTP LAN</option></select></label>
              ${field('serial_port', 'Port série réservé', 'maxlength="32" placeholder="COM… (futur)')}
            </div>
            <details><summary>Limites du profil pince</summary>
              <div class="rb-tuning">${field('speed', 'Vitesse max. · pas/s', 'type="number" min="40" max="200" required')}
              ${field('acceleration', 'Accélération · 100 pas/s²', 'type="number" min="1" max="8" required')}
              ${field('step_limit', 'Amplitude physique max. · °', 'type="number" min="1" max="8" step="any" required')}</div>
              <div class="rb-settings-grid">${limits(axes)}${limits({ x: 'X · mm', y: 'Y · mm', z: 'Z · mm' })}</div>
            </details>
            <div class="rb-actions"><button type="submit" class="rb-primary">Enregistrer les réglages</button>
            <button type="button" data-rb="forget-camera">Effacer le compte caméra</button></div>
          </fieldset>
        </form>
      </details>
      <details class="rb-card rb-history"><summary>Journal des commandes</summary><ol data-rb="history"></ol></details>
    </div>
    <p class="rb-message" data-rb="message" role="status" aria-live="polite"></p>`;

  class Lab {
    constructor(host, api) {
      this.host = host;
      this.api = api;
      this.generation = 0;
      this.active = false;
      this.mode = 'joints';
      this.steps = [];
      this.jog = null;
      this.stream = null;
      this.lease = '';
      this.motionGeneration = 0;
      this.pending = false;
      this.previewVersion = 0;
      this.monitor = 'position';
      host.innerHTML = markup;
      this.nodes = Object.fromEntries([...host.querySelectorAll('[data-rb]')].map(el => [el.dataset.rb, el]));
      this.form = this.nodes.pose.elements;
      this.bind();
      this.selectMode('joints');
    }

    request(path, body, { keepalive = false } = {}) {
      const headers = this.lease ? { 'X-HQ-Robotics-Lease': this.lease } : {};
      if (body === undefined) return this.api(prefix + path, { headers, timeoutMs: 5000 });
      headers['Content-Type'] = 'application/json';
      return this.api(prefix + path, { method: 'POST', headers, keepalive, body: JSON.stringify(body), timeoutMs: 7000 });
    }

    message(text, error = false) {
      this.nodes.message.textContent = text;
      this.nodes.message.classList.toggle('rb-error', error);
    }

    async run(work) {
      const generation = this.generation;
      try { return await work(); }
      catch (error) {
        if (generation !== this.generation) return;
        if ([401, 403, 423].includes(error.status)) this.release();
        this.message(error.message, true);
      }
    }

    show() {
      if (this.active) return;
      this.active = true;
      this.generation++;
      this.telemetryEnabled = false;
      this.monitorChosen = false;
      this.lifecycle = new AbortController();
      const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: this.lifecycle.signal });
      const resize = new ResizeObserver(() => this.drawPosition());
      resize.observe(this.nodes.plot);
      this.lifecycle.signal.addEventListener('abort', () => resize.disconnect(), { once: true });
      listen(window, 'blur', () => this.release());
      listen(window, 'pagehide', () => this.hide());
      listen(window, 'offline', () => { this.release(); this.stopVideo(); });
      listen(document, 'visibilitychange', () => {
        if (document.hidden) {
          clearTimeout(this.pollTimer);
          this.release();
          this.stopVideo();
        } else this.schedule(0);
      });
      listen(window, 'hq:session-role', () => {
        if (!document.body.classList.contains('session-admin')) this.hide();
      });
      this.schedule(0);
      this.run(() => this.loadPresets());
      this.mountAssistant();
    }

    hide() {
      if (!this.active) return;
      this.active = false;
      this.assistant?.hide();
      this.generation++;
      this.lifecycle.abort();
      clearTimeout(this.pollTimer);
      this.release();
      this.stopVideo();
      this.state = null;
      this.clearPreview();
      this.revision = null;
      this.havePoseFeedback = false;
      this.nodes['settings-fields'].disabled = true;
      this.nodes['video-start'].disabled = true;
      this.nodes['video-hint'].textContent = '';
      this.nodes['video-idle'].querySelector('strong').textContent = 'Caméra en veille';
      this.nodes.message.textContent = '';
      this.clearPasswords();
      this.controls();
    }

    schedule(ms) {
      clearTimeout(this.pollTimer);
      if (this.active && !document.hidden) this.pollTimer = setTimeout(() => this.poll(), ms);
    }

    async poll() {
      const generation = this.generation;
      if (!this.active || document.hidden || this.polling === generation) return;
      this.polling = generation;
      let delay = 9000;
      try {
        const action = this.state?.config.mode === 'hardware' && this.telemetryEnabled && !this.pending
          ? 'telemetry' : 'status';
        const state = await this.request(action, action === 'telemetry' ? { lease: this.lease } : undefined);
        if (this.generation !== generation || !this.active) return;
        this.render(state);
        delay = state.moving ? (state.config.mode === 'hardware' ? 650 : 250) :
          (this.lease || state.feedback?.source === 'hardware' || this.stream ? 1000 : 6500);
      } catch (error) {
        if (this.generation !== generation) return;
        if (error.status === 429) { delay = 650; return; }
        this.telemetryEnabled = false;
        this.release();
        if ([401, 403, 423].includes(error.status)) {
          this.stopVideo();
          this.hide();
          this.message('Session administrateur requise.', true);
          return;
        }
        this.message(error.message, true);
        if (this.state) this.render({ ...this.state, feedback: null, armed: false });
      } finally {
        if (this.polling === generation) this.polling = null;
        if (this.generation === generation) this.schedule(delay);
      }
    }

    render(state) {
      if (!this.active) return;
      const previousMode = this.state?.config.mode;
      this.state = state;
      this.assistant?.observe(state);
      const sim = state.config.mode === 'simulation';
      if (!this.monitorChosen && previousMode !== state.config.mode) this.selectMonitor(sim ? 'position' : 'camera');
      if (this.lease && !state.armed && !this.arming) this.release();
      const text = (key, value) => {
        if (this.nodes[key].textContent !== value) this.nodes[key].textContent = value;
      };
      text('mode', sim ? 'Simulation' : 'Matériel');
      text('arm-state', sim ? 'Virtuel' : (state.feedback ? 'Connecté' : 'Sans retour'));
      text('camera-state', state.camera_live ? 'En direct' : (this.stream ? 'Connexion…' :
        (state.config.camera_configured ? 'En veille' : 'À configurer')));
      this.nodes['camera-state'].dataset.state = state.camera_live ? 'live' : '';
      text('safety', state.stop_latched || state.uncertain ? 'Inspection requise' :
        (state.armed ? 'Armé' : (state.occupied ? 'Poste occupé' : 'Désarmé')));
      this.nodes.safety.dataset.state = state.stop_latched || state.uncertain ? 'stop' : (state.armed ? 'armed' : '');
      text('motion-state', state.moving ? (sim ? 'En mouvement' : 'Confirmation en attente') : 'À l’arrêt');
      this.nodes['motion-state'].dataset.state = state.moving ? 'moving' : '';
      const at = state.last_feedback ? new Date(state.last_feedback * 1000).toLocaleTimeString() : '';
      text('feedback-state', sim ? 'Retour simulé' : (at ? [at, state.latency_ms == null ? '' : state.latency_ms + ' ms'].filter(Boolean).join(' · ') : 'Pas de retour'));
      text('actual-label', sim ? 'Simulé' : 'Mesuré');
      for (const key of axisKeys) {
        text('actual-' + key, format(state.feedback?.actual[key], '°'));
        text('target-' + key, format(state.target?.[key], '°'));
        text('load-' + key, format(state.feedback?.load?.[key]));
      }
      for (const axis of ['x', 'y', 'z']) text('position-' + axis, format(state.feedback?.xyz[axis]));
      text('plot-source', sim ? 'Simulation' : (state.feedback ? 'Mesuré' : 'Sans retour'));
      text('voltage', 'Tension ' + format(state.feedback?.voltage, ' V'));
      this.nodes.electrical.hidden = sim || !Number.isFinite(state.feedback?.voltage);
      this.nodes['hardware-note'].hidden = sim;
      text('interlock', state.stop_latched || state.uncertain ? 'Vérifiez le poste avant de réinitialiser.' :
        state.armed ? 'Les commandes de mouvement sont actives.' :
        sim ? 'Armez le simulateur pour déplacer le bras.' :
        (!state.physical_local ? 'Pilotage physique depuis le PC HQ uniquement.' :
        (!state.commissioned ? 'Mise en service physique requise.' :
        (!state.camera_live ? 'Démarrez la vidéo pour armer.' :
        (!state.feedback ? 'Cliquez sur Lire le RoArm pour actualiser son état.' : 'Armez le poste en gardant le bras en vue.')))));
      text('video-hint', !state.camera_local ? 'Accès réseau local direct requis.' : (!state.gateway ?
        'La passerelle vidéo est indisponible sur le PC HQ.' : (!state.config.camera_configured ?
          'Renseignez le compte caméra dans les réglages.' : '')));
      this.nodes['camera-setup'].hidden = !state.physical_local || !state.gateway || state.config.camera_configured;
      if (state.camera_error && !this.stream) text('video-note', state.camera_error);
      this.nodes['settings-fields'].disabled = !state.physical_local;
      text('settings-note', state.physical_local ? 'Les identifiants existants sont conservés si les champs restent vides.' :
        'Ouvrez HQ sur le PC hôte pour modifier les réglages.');
      this.nodes.sequence.hidden = !sim;
      this.nodes.history.replaceChildren(...state.history.map(event => {
        const li = document.createElement('li');
        li.textContent = new Date(event.at * 1000).toLocaleTimeString() + ' · ' + event.label;
        return li;
      }));
      if (this.revision !== state.config.revision) {
        this.clearPreview();
        this.revision = state.config.revision;
        this.fillSettings(state.config);
        this.loadPose(state.feedback?.actual || { base: 0, shoulder: 0, elbow: 90, hand: 180 }, state.feedback?.xyz);
      } else if (state.feedback && !this.havePoseFeedback) {
        this.loadPose(state.feedback.actual, state.feedback.xyz);
      }
      if (state.feedback) this.havePoseFeedback = true;
      this.drawPosition();
      this.controls();
    }

    controls() {
      const state = this.state;
      const hw = state?.config.mode === 'hardware';
      const local = !!state && (!hw || state.physical_local);
      const stop = !!state && (state.stop_latched || state.uncertain);
      const ready = local && !stop && !state.moving && (!hw || (state.commissioned && state.feedback && state.camera_live));
      const armed = ready && !!this.lease && !!state.ticket && state.armed && !this.pending && !this.playingScript;
      this.nodes.arm.disabled = !ready || !!this.lease || state.occupied || this.arming;
      this.nodes.cancel.disabled = !this.lease && !this.arming && !this.pending;
      this.nodes.stop.disabled = !local;
      this.nodes.reset.hidden = !stop || !local;
      this.nodes.probe.hidden = !hw || !state.physical_local || !state.config.arm_ip;
      this.nodes.probe.disabled = this.pending;
      for (const key of ['move', 'home', 'preset-run', 'sequence-run']) this.nodes[key].disabled = !armed;
      this.nodes.preview.disabled = !state;
      this.nodes['preset-run'].disabled = !armed || !this.nodes.presets.value;
      for (const key of ['preset-preview', 'preset-delete']) this.nodes[key].disabled = !state || !this.nodes.presets.value;
      const hasName = !!this.nodes['preset-name'].value.trim();
      this.nodes['preset-save'].disabled = !state || !hasName;
      this.nodes['preset-rename'].disabled = !state || !this.nodes.presets.value || !hasName;
      this.host.querySelectorAll('[data-step]').forEach(el => { el.disabled = !armed; });
      this.nodes['video-start'].disabled = !state?.camera_local || !state.gateway || !state.config.camera_configured || !!this.stream;
      this.nodes['video-start'].hidden = !!this.stream;
      this.nodes['video-stop'].disabled = !this.stream;
      this.nodes['video-stop'].hidden = !this.stream;
      this.nodes.fullscreen.disabled = !this.stream || this.nodes.video.paused;
      this.nodes.fullscreen.hidden = !this.stream;
      this.nodes.quality.disabled = !!this.stream;
    }

    selectMonitor(mode) {
      this.monitor = mode;
      this.nodes['position-pane'].hidden = mode !== 'position';
      this.nodes['camera-pane'].hidden = mode !== 'camera';
      for (const button of this.host.querySelectorAll('[data-monitor]')) {
        button.setAttribute('aria-pressed', String(button.dataset.monitor === mode));
      }
      if (mode === 'position') this.drawPosition();
    }

    drawPosition() {
      if (!this.active || this.monitor !== 'position') return;
      const canvas = this.nodes.plot;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
        [canvas.width, canvas.height] = pixels;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const workspace = this.state?.config.workspace;
      if (!workspace) return;
      const [left, right] = workspace.x;
      const [bottom, top] = workspace.y;
      const xMin = Math.min(0, left);
      const yMin = Math.min(0, bottom);
      const yMax = Math.max(0, top);
      const scale = Math.min((width - 44) / (right - xMin), (height - 44) / (yMax - yMin || 1));
      if (scale <= 0) return;
      const x = value => width / 2 + (value - (xMin + right) / 2) * scale;
      const y = value => height / 2 - (value - (yMin + yMax) / 2) * scale;
      ctx.fillStyle = '#17373e';
      ctx.fillRect(x(left), y(top), (right - left) * scale, (top - bottom) * scale);
      ctx.strokeStyle = '#34656b';
      ctx.strokeRect(x(left), y(top), (right - left) * scale, (top - bottom) * scale);
      ctx.beginPath();
      ctx.moveTo(x(xMin), y(0));
      ctx.lineTo(x(right), y(0));
      ctx.moveTo(x(0), y(yMax));
      ctx.lineTo(x(0), y(yMin));
      ctx.stroke();
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillStyle = '#a2bdbf';
      ctx.fillText('X', x(right) + 5, y(0) + 4);
      ctx.fillText('Y', x(0) - 11, y(yMax) + 3);
      for (const [point, color] of [[this.previewPoint, '#ffc176'], [this.state.feedback?.xyz, '#73edce']]) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
        ctx.beginPath();
        ctx.arc(x(point.x), y(point.y), 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0b171e';
        ctx.stroke();
      }
    }

    clearPreview() {
      this.previewVersion++;
      this.previewPoint = null;
      this.nodes['preview-result'].hidden = true;
      this.nodes['plot-preview'].hidden = true;
      this.drawPosition();
    }

    selectMode(mode) {
      this.jog = null;
      this.clearPreview();
      this.mode = mode;
      for (const key of ['joints', 'cartesian']) {
        this.nodes[key].hidden = key !== mode;
        for (const input of this.nodes[key].querySelectorAll('input')) input.disabled = key !== mode;
        this.host.querySelector(`[data-mode="${key}"]`).setAttribute('aria-pressed', String(key === mode));
      }
      this.nodes['linear-step-label'].hidden = mode !== 'cartesian';
    }

    xyzText(xyz) {
      return ['x', 'y', 'z'].map(key => key.toUpperCase() + ' ' + format(xyz[key], ' mm')).join(' · ');
    }

    loadPose(pose, xyz) {
      for (const key of axisKeys) this.form[key].value = Number(pose[key].toFixed(3));
      const neutral = { x: 310.155, y: 0, z: 236.82 };
      for (const key of ['x', 'y', 'z']) this.form[key].value = Number((xyz?.[key] ?? neutral[key]).toFixed(3));
      this.form.t.value = Number(pose.hand.toFixed(3));
    }

    target() {
      if (!this.nodes.pose.reportValidity()) throw new Error('Complétez les valeurs de la cible.');
      const keys = this.mode === 'joints' ? axisKeys : Object.keys(coordinates);
      const values = Object.fromEntries(keys.map(key => [key, this.form[key].valueAsNumber]));
      return this.mode === 'joints' ? { kind: 'joints', pose: values } : { kind: 'cartesian', xyz: values };
    }

    async arm() {
      if (this.arming || this.nodes.arm.disabled) return;
      const generation = ++this.motionGeneration;
      this.arming = true;
      this.controls();
      try {
        const result = await this.request('arm', {});
        if (!this.active || generation !== this.motionGeneration || document.hidden || !document.hasFocus()) {
          await this.request('cancel', { lease: result.lease }, { keepalive: true });
          return;
        }
        this.lease = result.lease;
        const state = await this.request('status');
        if (generation === this.motionGeneration) this.render(state);
      } finally {
        this.arming = false;
        this.controls();
        this.schedule(0);
      }
    }

    release() {
      this.jog = null;
      this.motionGeneration++;
      const lease = this.lease;
      this.lease = '';
      if (lease) this.request('cancel', { lease }, { keepalive: true }).catch(() => {});
      this.controls();
    }

    async move(target, jogButton, fromScript = false) {
      if (!this.lease || !this.state?.ticket || this.pending || this.state.moving ||
          document.hidden || !document.hasFocus() || (this.playingScript && !fromScript)) return false;
      const generation = this.motionGeneration;
      this.clearPreview();
      this.pending = true;
      this.controls();
      try {
        const next = await this.request('move', { ...target, lease: this.lease,
          ticket: this.state.ticket, speed: this.nodes.speed.valueAsNumber });
        if (generation === this.motionGeneration) this.render(next);
        if (jogButton && next.target && generation === this.motionGeneration) {
          if (this.mode === 'joints') this.loadPose(next.target);
          else for (const [key, value] of Object.entries(target.xyz)) this.form[key].value = value;
        }
        return generation === this.motionGeneration;
      } finally {
        this.pending = false;
        this.controls();
        this.schedule(0);
      }
    }

    jogPress(button, identity) {
      if (this.jog || button.disabled || !this.lease) return;
      this.jog = { button, identity };
    }

    jogRelease(button, identity, accepted) {
      if (this.jog?.button !== button || this.jog.identity !== identity) return;
      this.jog = null;
      if (!accepted || button.disabled) return;
      this.run(async () => {
        const key = button.dataset.step;
        const linear = ['x', 'y', 'z'].includes(key);
        const target = this.target();
        // A jog starts at the measured/simulated pose, never at an arbitrary
        // edited target. Only the selected axis receives a bounded increment.
        const feedback = this.state.feedback;
        if (!feedback) return;
        const source = this.mode === 'joints' ? feedback.actual : { ...feedback.xyz, t: feedback.actual.hand };
        const pose = this.mode === 'joints' ? target.pose : target.xyz;
        Object.assign(pose, source);
        pose[key] += Number(button.dataset.direction) * Number(this.nodes[linear ? 'linear-step' : 'angle-step'].value);
        await this.move(target, button);
      });
    }

    fillSettings(config) {
      const form = this.nodes.settings.elements;
      for (const key of ['mode', 'transport', 'arm_ip', 'arm_timeout', 'camera_ip', 'camera_timeout', 'quality',
        'serial_port', 'speed', 'acceleration', 'step_limit']) form[key].value = config[key];
      for (const [key, pair] of Object.entries({ ...config.joint_limits, ...config.workspace })) {
        form[key + '-min'].value = pair[0];
        form[key + '-max'].value = pair[1];
      }
      for (const [key, pair] of Object.entries(config.joint_limits)) {
        this.form[key].min = pair[0];
        this.form[key].max = pair[1];
      }
      this.form.t.min = config.joint_limits.hand[0];
      this.form.t.max = config.joint_limits.hand[1];
      for (const [key, pair] of Object.entries(config.workspace)) {
        this.form[key].min = pair[0];
        this.form[key].max = pair[1];
      }
      this.nodes.speed.max = config.speed;
      this.nodes.speed.value = config.speed;
      this.nodes.quality.value = config.quality;
    }

    clearPasswords() {
      this.nodes.settings.elements.camera_user.value = '';
      this.nodes.settings.elements.camera_password.value = '';
    }

    async saveSettings(forget = false) {
      if (this.nodes['settings-fields'].disabled) return;
      const form = this.nodes.settings.elements;
      const data = {};
      for (const key of ['mode', 'transport', 'arm_ip', 'camera_ip', 'quality', 'serial_port']) data[key] = form[key].value;
      for (const key of ['arm_timeout', 'camera_timeout', 'speed', 'acceleration', 'step_limit']) data[key] = form[key].valueAsNumber;
      for (const key of ['camera_user', 'camera_password']) {
        if (forget || form[key].value) data[key] = forget ? '' : form[key].value;
      }
      const read = (keys) => Object.fromEntries(keys.map(key => [key, [form[key + '-min'].valueAsNumber, form[key + '-max'].valueAsNumber]]));
      data.joint_limits = read(axisKeys);
      data.workspace = read(['x', 'y', 'z']);
      this.clearPasswords();
      await this.request('settings', data);
      this.stopVideo();
      this.havePoseFeedback = false;
      this.render(await this.request('status'));
      this.message('Réglages enregistrés.');
    }

    async loadPresets() {
      const generation = this.generation;
      const result = await this.request('presets');
      if (!this.active || generation !== this.generation) return;
      this.presets = result.presets;
      const selected = this.nodes.presets.value;
      this.nodes.presets.replaceChildren(new Option('Choisir…', ''),
        ...Object.entries(this.presets).map(([id, item]) => new Option(item.name, id)));
      if (this.presets[selected]) this.nodes.presets.value = selected;
      this.controls();
    }

    preset() {
      const id = this.nodes.presets.value;
      if (!id) throw new Error('Choisissez une position enregistrée.');
      return { kind: 'preset', id };
    }

    async preview(target, load = false) {
      this.clearPreview();
      const version = this.previewVersion;
      const result = await this.request('preview', target);
      if (!this.active || this.previewVersion !== version) return;
      if (load) {
        this.loadPose(result.pose, result.xyz);
        this.selectMode('joints');
      }
      this.previewPoint = result.xyz;
      this.nodes['preview-result'].textContent = this.xyzText(result.xyz);
      this.nodes['preview-result'].hidden = false;
      this.nodes['plot-preview'].hidden = false;
      this.drawPosition();
    }

    showSequence() {
      this.nodes.steps.replaceChildren(...this.steps.map((step) => {
        const li = document.createElement('li');
        li.textContent = step.kind === 'joints' ?
          axisKeys.map(key => axes[key] + ' ' + format(step.pose[key], '°')).join(' · ') : this.xyzText(step.xyz);
        return li;
      }));
    }

    async sequence(play) {
      const generation = this.motionGeneration;
      const { steps } = await this.request('sequence', { steps: this.steps });
      this.message(`${steps.length} trajectoire(s) validée(s) pour la simulation.`);
      if (!play) return;
      for (const step of steps) {
        if (generation !== this.motionGeneration || this.state?.config.mode !== 'simulation') return;
        if (!await this.move({ kind: 'joints', pose: step.pose })) return;
        const deadline = performance.now() + 30000;
        while (this.state?.moving && performance.now() < deadline && generation === this.motionGeneration) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (this.state?.moving || !this.lease) return;
      }
      this.message('Séquence terminée.');
    }

    async playReviewedScript(script) {
      if (this.state?.config.mode !== 'simulation' || !this.lease || this.playingScript) {
        throw new Error('Armez le simulateur depuis Robotique avant de lancer le script.');
      }
      const generation = this.motionGeneration;
      this.playingScript = true;
      this.controls();
      const active = () => this.active && this.lease && generation === this.motionGeneration
        && this.state?.config.mode === 'simulation';
      try {
        for (let index = 0; index < script.steps.length; index++) {
          const deadline = performance.now() + 30000;
          while (active() && (!this.state?.ticket || this.state.moving || this.pending)) {
            if (performance.now() > deadline) throw new Error('Le simulateur n’a pas confirmé le mouvement.');
            await new Promise(resolve => setTimeout(resolve, 125));
          }
          if (!active() || !await this.move({
            kind: 'reviewed_script', id: script.id, digest: script.digest, index,
          }, null, true)) return false;
        }
        const deadline = performance.now() + 30000;
        while (active() && this.state.moving) {
          if (performance.now() > deadline) throw new Error('Le simulateur n’a pas confirmé le mouvement.');
          await new Promise(resolve => setTimeout(resolve, 125));
        }
        return !!active();
      } finally {
        this.playingScript = false;
        this.controls();
      }
    }

    async mountAssistant(open = false) {
      const generation = this.generation;
      if (!this.active || !this.loadAssistant) return;
      if (!await this.loadAssistant() || !window.HqRoboticsAssistant) {
        if (this.active && generation === this.generation) this.message('Kinétia est indisponible.', true);
        return;
      }
      if (!this.active || generation !== this.generation) return;
      if (!this.assistant) this.assistant = window.HqRoboticsAssistant.mount(this);
      this.assistant.show();
      if (open) this.assistant.open();
    }

    async startVideo(retry = 0) {
      if (this.stream || !this.active || document.hidden || this.monitor !== 'camera') return;
      const stream = { controller: new AbortController(), key: '', retry };
      this.stream = stream;
      this.nodes['video-note'].textContent = retry ? 'Reconnexion…' : 'Connexion…';
      this.controls();
      try {
        const result = await this.request('camera/start', { quality: this.nodes.quality.value });
        stream.key = result.stream;
        if (this.stream !== stream) {
          await this.request('camera/stop', { stream: stream.key }, { keepalive: true });
          return;
        }
        await this.playVideo(stream);
        if (this.stream === stream) throw new Error('Flux vidéo interrompu.');
      } catch (error) {
        if (this.stream !== stream) return;
        this.stopVideo();
        this.nodes['video-note'].textContent = 'Flux interrompu';
        this.message(error.message, true);
        if (!retry && stream.key && ![401, 403, 423].includes(error.status)) {
          this.retryTimer = setTimeout(() => this.startVideo(1), 1500);
        }
      }
    }

    async playVideo(stream) {
      const video = this.nodes.video;
      const signal = stream.controller.signal;
      const Source = window.ManagedMediaSource || window.MediaSource;
      if (!Source || !video.requestVideoFrameCallback) throw new Error('Lecture H.264 en direct indisponible dans ce navigateur.');
      stream.startup = setTimeout(() => this.videoFailure(stream), 10000);
      const response = await fetch(prefix + 'camera/video', { credentials: 'same-origin',
        headers: { 'X-HQ-Robotics-Stream': stream.key }, signal });
      if (!response.ok || !response.body) throw new Error('Flux H.264 Tapo inaccessible.');
      const mime = response.headers.get('Content-Type');
      if (!Source.isTypeSupported(mime)) throw new Error('Profil H.264 incompatible avec ce navigateur.');
      const media = new Source();
      stream.media = media;
      stream.url = URL.createObjectURL(media);
      video.disableRemotePlayback = true;
      const opened = this.event(media, 'sourceopen', signal);
      video.src = stream.url;
      video.play().catch(() => {});
      await opened;
      const buffer = media.addSourceBuffer(mime);
      const reader = response.body.getReader();
      let lastPing = -Infinity;
      const frame = (now) => {
        if (this.stream !== stream) return;
        clearTimeout(stream.startup);
        clearTimeout(stream.watch);
        stream.watch = setTimeout(() => this.videoFailure(stream), 2300);
        this.nodes['video-idle'].hidden = true;
        this.nodes['video-note'].textContent = 'En direct';
        this.nodes.fullscreen.disabled = false;
        if (now - lastPing > 1000) {
          lastPing = now;
          this.request('camera/frame', { stream: stream.key }).catch(() => this.videoFailure(stream));
        }
        stream.frame = video.requestVideoFrameCallback(frame);
      };
      stream.frame = video.requestVideoFrameCallback(frame);
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done || signal.aborted) break;
          buffer.appendBuffer(value);
          await this.event(buffer, 'updateend', signal);
          if (!buffer.buffered.length) continue;
          const end = buffer.buffered.end(buffer.buffered.length - 1);
          const start = buffer.buffered.start(0);
          if (end - video.currentTime > 2.5) video.currentTime = Math.max(start, end - .4);
          if (video.currentTime - start > 12) {
            buffer.remove(start, video.currentTime - 5);
            await this.event(buffer, 'updateend', signal);
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }

    event(target, name, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => settle(new Error('Flux arrêté.'));
        const failed = () => settle(new Error('Décodage vidéo interrompu.'));
        const ready = () => settle();
        function settle(error) {
          target.removeEventListener(name, ready);
          target.removeEventListener('error', failed);
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        }
        if (signal.aborted) return abort();
        target.addEventListener(name, ready, { once: true });
        target.addEventListener('error', failed, { once: true });
        signal.addEventListener('abort', abort, { once: true });
      });
    }

    videoFailure(stream) {
      if (this.stream !== stream) return;
      this.stopVideo();
      this.nodes['video-note'].textContent = 'Flux interrompu';
      this.message('Le direct ne fournit plus d’images.', true);
      if (!stream.retry) this.retryTimer = setTimeout(() => this.startVideo(1), 1500);
    }

    stopVideo() {
      clearTimeout(this.retryTimer);
      const stream = this.stream;
      this.stream = null;
      if (!stream) return;
      clearTimeout(stream.startup);
      clearTimeout(stream.watch);
      stream.controller.abort();
      const video = this.nodes.video;
      if (stream.frame !== undefined) video.cancelVideoFrameCallback(stream.frame);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (stream.url) URL.revokeObjectURL(stream.url);
      if (stream.key) this.request('camera/stop', { stream: stream.key }, { keepalive: true }).catch(() => {});
      if (this.state?.config.mode === 'hardware') this.release();
      this.nodes['video-idle'].hidden = false;
      this.nodes['video-note'].textContent = 'Flux arrêté';
      this.controls();
    }

    bind() {
      const on = (name, fn) => this.nodes[name].addEventListener('click', () => this.run(fn));
      on('open-assistant', () => this.mountAssistant(true));
      on('open-settings', () => this.openSettings());
      on('camera-setup', () => this.openSettings());
      this.host.querySelectorAll('[data-monitor]').forEach(button => {
        button.addEventListener('click', () => {
          this.monitorChosen = true;
          const mode = button.dataset.monitor;
          if (mode === 'position') this.stopVideo();
          this.selectMonitor(mode);
        });
      });
      this.host.querySelectorAll('[data-mode]').forEach(button =>
        button.addEventListener('click', () => this.selectMode(button.dataset.mode)));
      this.host.querySelectorAll('[data-step]').forEach(button => {
        button.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !event.isPrimary) return;
          this.jogPress(button, event.pointerId);
          button.setPointerCapture(event.pointerId);
        });
        button.addEventListener('pointerup', event => {
          const rect = button.getBoundingClientRect();
          this.jogRelease(button, event.pointerId, event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom);
        });
        for (const type of ['pointercancel', 'lostpointercapture']) {
          button.addEventListener(type, event => this.jogRelease(button, event.pointerId, false));
        }
        button.addEventListener('keydown', event => {
          if (![' ', 'Enter'].includes(event.key)) return;
          event.preventDefault();
          if (!event.repeat) this.jogPress(button, event.key);
        });
        button.addEventListener('keyup', event => {
          if (![' ', 'Enter'].includes(event.key)) return;
          event.preventDefault();
          this.jogRelease(button, event.key, true);
        });
        button.addEventListener('blur', () => { if (this.jog?.button === button) this.jog = null; });
        // Assistive technology can activate the native button without pointer events.
        button.addEventListener('click', event => {
          if (event.detail !== 0) return;
          this.jogPress(button, 'accessibility');
          this.jogRelease(button, 'accessibility', true);
        });
      });
      this.nodes.pose.addEventListener('submit', event => {
        event.preventDefault();
        this.run(() => this.move(this.target()));
      });
      this.nodes.pose.addEventListener('input', () => this.clearPreview());
      this.nodes.settings.addEventListener('submit', event => { event.preventDefault(); this.run(() => this.saveSettings()); });
      on('forget-camera', () => { if (confirm('Effacer le compte Tapo enregistré ?')) return this.saveSettings(true); });
      on('arm', () => this.arm());
      on('cancel', () => {
        this.release();
        this.message(this.state?.config.mode === 'hardware' ?
          'Autorisation relâchée. Un pas physique déjà parti peut se terminer.' : 'Simulateur désarmé.');
      });
      on('stop', async () => {
        const generation = this.generation;
        this.release();
        const status = await this.request('stop', {});
        if (this.generation === generation) this.render(status);
        this.message(status.config.mode === 'simulation' ? 'Simulation arrêtée.' :
          (status.stop_result === 'torque_release_requested' ?
            'Coupure du couple demandée. Vérifiez le bras sur place.' : 'Pilotage verrouillé.'));
      });
      on('reset', async () => {
        const hw = this.state?.config.mode === 'hardware';
        if (hw && !confirm('Confirmez-vous l’inspection du bras et la sécurisation de la zone ?')) return;
        await this.request('reset', { inspected: hw });
        this.render(await this.request('status'));
        this.message('Poste réinitialisé. Armez de nouveau pour déplacer le bras.');
      });
      on('probe', async () => {
        this.render(await this.request('telemetry', { lease: this.lease }));
        this.telemetryEnabled = true;
        this.schedule(700);
      });
      on('preview', () => this.preview(this.target()));
      on('home', () => this.move({ kind: 'home' }));
      on('preset-save', async () => {
        await this.request('presets', { action: 'save', name: this.nodes['preset-name'].value, ...this.target() });
        await this.loadPresets();
      });
      on('preset-preview', () => this.preview(this.preset(), true));
      on('preset-run', () => this.move(this.preset()));
      on('preset-rename', async () => {
        await this.request('presets', { action: 'rename', id: this.preset().id, name: this.nodes['preset-name'].value });
        await this.loadPresets();
      });
      on('preset-delete', async () => {
        const { id } = this.preset();
        if (!confirm('Supprimer cette position enregistrée ?')) return;
        await this.request('presets', { action: 'delete', id });
        await this.loadPresets();
      });
      this.nodes.presets.addEventListener('change', () => {
        this.nodes['preset-name'].value = this.presets?.[this.nodes.presets.value]?.name || '';
        this.controls();
      });
      this.nodes['preset-name'].addEventListener('input', () => this.controls());
      on('step-add', () => {
        if (this.steps.length >= 16) throw new Error('La séquence contient déjà 16 positions.');
        this.steps.push(this.target());
        this.showSequence();
      });
      on('sequence-clear', () => { this.steps = []; this.showSequence(); });
      on('sequence-check', () => this.sequence(false));
      on('sequence-run', () => this.sequence(true));
      on('video-start', () => this.startVideo());
      on('video-stop', () => this.stopVideo());
      on('fullscreen', () => {
        if (this.nodes.viewport.requestFullscreen) return this.nodes.viewport.requestFullscreen();
        this.nodes.video.webkitEnterFullscreen?.();
      });
    }

    openSettings() {
      const settings = this.host.querySelector('#robotics-settings');
      settings.open = true;
      settings.querySelector('summary').focus({ preventScroll: true });
      settings.scrollIntoView({ block: 'start' });
    }
  }

  let lab;
  window.HqRobotics = {
    show(host, api, openSettings, loadAssistant) {
      if (!lab) lab = new Lab(host, api);
      lab.loadAssistant = loadAssistant;
      lab.show();
      if (openSettings || location.hash === '#robotique/reglages') {
        requestAnimationFrame(() => { if (lab.active) lab.openSettings(); });
      }
    },
    hide() { lab?.hide(); },
  };
})();
