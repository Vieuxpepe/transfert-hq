/* Robotique is mounted only when its HQ view opens. */
(() => {
  'use strict';
  const axes = { base: 'Base', shoulder: 'Épaule', elbow: 'Coude', hand: 'Pince' };
  const coordinates = { x: 'X', y: 'Y', z: 'Z', t: 'Pince' };
  const axisKeys = Object.keys(axes);
  // RoArm-M2-S geometry, mirrored from hq_robotics_arm.py (display only; the server stays the authority).
  const UPPER = Math.hypot(236.82, 30), LOWER = Math.hypot(280.15, 1.73), OFFSET = Math.atan2(30, 236.82);
  const rad = degrees => degrees * Math.PI / 180;
  const armLinks = pose => {
    const b = rad(pose.base), s = rad(pose.shoulder), e = rad(pose.elbow);
    const re = UPPER * Math.sin(s + OFFSET), ze = UPPER * Math.cos(s + OFFSET);
    const rt = re + LOWER * Math.sin(s + e), zt = ze + LOWER * Math.cos(s + e);
    return { elbow: { r: re, z: ze, x: re * Math.cos(b), y: re * Math.sin(b) },
      tcp: { r: rt, z: zt, x: rt * Math.cos(b), y: rt * Math.sin(b) } };
  };
  const DEG_PER_STEP = 360 / 4096;  // servo step, as the server counts speed (steps/s)
  const decimal = value => value.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  // Inverse kinematics of the gripper point (same branch as hq_robotics_arm.cartesian), for estimates only.
  const ikPose = (x, y, z, hand) => {
    const r = Math.hypot(x, y);
    const c = (r * r + z * z - UPPER * UPPER - LOWER * LOWER) / (2 * UPPER * LOWER);
    if (!(c > -1 && c < 1)) return null;
    const d = Math.acos(c);
    const s = Math.atan2(r, z) - Math.atan2(LOWER * Math.sin(d), UPPER + LOWER * c) - OFFSET;
    const deg = v => v * 180 / Math.PI;
    return { base: deg(Math.atan2(y, x)), shoulder: deg(s), elbow: deg(d + OFFSET), hand };
  };
  const boxDistance = (point, box) => Math.hypot(...['x', 'y', 'z'].map(k =>
    Math.max(box[k][0] - point[k], 0, point[k] - box[k][1])));
  const KEY_JOG = { q: [0, 1], a: [0, -1], w: [1, 1], s: [1, -1], e: [2, 1], d: [2, -1], r: [3, 1], f: [3, -1] };
  const KEY_JOG_STORE = 'hq_robotics_keyjog_v1';
  const PAD_JOG_STORE = 'hq_robotics_padjog_v1';
  const DRAFT_STORE = 'hq_robotics_compose_draft_v1';
  const HOME_POSE = Object.freeze({ base: 0, shoulder: 0, elbow: 90, hand: 180 });
  const prefix = '/api/robotics/';
  // Mirrors hq_robotics.LEASE_SECONDS: the countdown is advisory, the server stays authoritative.
  const LEASE_MS = 20000;
  const DRAG_FOLLOW_MS = 180;
  const MAX_RECORD_STEPS = 64;
  const NOOP_DEGREES = .25;
  // Mirrors hq_robotics_arm.position() for the fixed m2s-gripper profile; the plan only needs XY.
  const ARM_UPPER = Math.hypot(236.82, 30.0);
  const ARM_LOWER = Math.hypot(280.15, 1.73);
  const ARM_OFFSET = Math.atan2(30.0, 236.82);
  // RoArm tor* values are raw; this is the bar's visual full scale, not a safety limit.
  const LOAD_FULL_SCALE = 1000;
  const targetXy = pose => {
    if (!axisKeys.every(key => Number.isFinite(pose?.[key]))) return null;
    const rad = Math.PI / 180;
    const base = pose.base * rad;
    const shoulder = pose.shoulder * rad;
    const elbow = pose.elbow * rad;
    const radius = ARM_UPPER * Math.sin(shoulder + ARM_OFFSET) + ARM_LOWER * Math.sin(shoulder + elbow);
    return { x: radius * Math.cos(base), y: radius * Math.sin(base) };
  };
  const format = (value, unit = '') => Number.isFinite(value) ? value.toFixed(1) + unit : '—';
  // One stroke icon set for every icon button: the Unicode glyphs rendered with a different weight and size
  // in each font. 24 px grid, 2 px stroke, currentColor.
  const ICON_PATHS = {
    up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    down: '<path d="M12 5v14"/><path d="m18 13-6 6-6-6"/>',
    right: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    chat: '<path d="M20 13.5A3.5 3.5 0 0 1 16.5 17H9l-4 3v-3.6A3.5 3.5 0 0 1 4 13.5v-6A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5Z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H7a2 2 0 0 0-2 2v8"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    square: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  };
  const svg = name => `<svg class="rb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
  const GLYPH_ICONS = { '↑': 'up', '↓': 'down', '⧉': 'copy', '→': 'right', '✕': 'x', '×': 'x', '−': 'minus', '+': 'plus' };
  // A glyph label becomes its icon; the button keeps its aria-label and title.
  const setGlyph = (button, glyph) => {
    // An explicit class, not :has(.rb-icon:only-child): that also matches icon + text, and flips when the
    // global ripple inserts its element on press, resizing the button under the pointer.
    if (GLYPH_ICONS[glyph]) { button.innerHTML = svg(GLYPH_ICONS[glyph]); button.classList.add('rb-icon-button'); }
    else button.textContent = glyph;
    if (glyph === '✕') button.classList.add('rb-danger-quiet');
  };
  const field = (name, label, attrs = '') =>
    `<label>${label}<input name="${name}" ${attrs}></label>`;
  const limits = (labels) => Object.entries(labels).map(([key, label]) =>
    `<div class="rb-limit"><span>${label}</span>${field(key + '-min', 'Min', 'type="number" step="any" required')}
    ${field(key + '-max', 'Max', 'type="number" step="any" required')}</div>`).join('');
  const axisRows = (labels, cartesian = false) => Object.entries(labels).map(([key, label]) => `
    <div class="rb-axis" data-axis-row="${key}">
      <label for="rb-${key}">${label}</label>
      <button type="button" class="rb-icon-button" data-step="${key}" data-direction="-1" aria-label="${label} moins" disabled>${svg('minus')}</button>
      <div class="rb-axis-input">
        <input id="rb-${key}" name="${key}" type="number" step="any" inputmode="decimal" required>
        <span aria-hidden="true">${cartesian && key !== 't' ? 'mm' : '°'}</span>
      </div>
      <button type="button" class="rb-icon-button" data-step="${key}" data-direction="1" aria-label="${label} plus" disabled>${svg('plus')}</button>
      ${cartesian ? '' : `<div class="rb-slider-wrap" data-rb="slider-wrap-${key}"><input class="rb-slider" type="range" data-rb="slider-${key}" min="-180" max="270" step="0.1" value="0" aria-label="${label} · curseur"><i class="rb-measured-mark" data-rb="mark-${key}" title="Position mesurée" hidden></i></div>`}
      <small class="rb-axis-reading" data-rb="reading-${key}">—</small>
    </div>`).join('');

  const markup = `
    <header class="rb-head">
      <div class="rb-head-title"><p class="rb-page-kicker">RoArm-M2-S <span aria-hidden="true">/</span> Tapo C200</p></div>
      <div class="rb-head-actions">
        <button type="button" data-rb="audio-hud" aria-pressed="false" data-help="Active ou coupe les retours sonores synthétisés du poste (armement, pas, contact, arrêt).">Audio HUD</button>
        <button type="button" data-rb="open-shortcuts" aria-expanded="false" aria-controls="rb-shortcuts-panel">Raccourcis</button>
        <button type="button" data-rb="open-assistant" aria-controls="hq-robotics-chat">Kinétia</button>
        <button type="button" data-rb="open-settings" aria-controls="robotics-settings">Réglages</button>
      </div>
    </header>
    <div class="rb-section-bar">
      <nav class="rb-section-nav" aria-label="Sections Robotique">
        <button type="button" data-go-section="commission" data-section-nav hidden>Mise en service</button>
        <button type="button" data-go-section="camera" data-section-nav aria-pressed="true">Moniteur</button>
        <button type="button" data-go-section="motion" data-section-nav aria-pressed="false">Pilotage</button>
        <button type="button" data-go-section="telemetry" data-section-nav aria-pressed="false">Télémétrie</button>
        <button type="button" data-go-section="workbench" data-section-nav aria-pressed="false">Atelier</button>
        <button type="button" data-go-section="presets" data-section-nav aria-pressed="false">Positions</button>
        <button type="button" data-go-section="records" data-section-nav aria-pressed="false">Scripts</button>
        <button type="button" data-go-section="advanced" data-section-nav aria-pressed="false">Réglages &amp; journal</button>
      </nav>
      <button type="button" class="rb-section-more" data-rb="section-more" aria-label="Sections suivantes" title="Sections suivantes" hidden>${svg('chevron-right')}</button>
      <button type="button" class="rb-section-ai" data-rb="section-ai" aria-controls="hq-robotics-chat" title="Kinétia · assistante du poste" data-help="Ouvre le dialogue Kinétia.">${svg('chat')}<span class="rb-section-ai-label">Kinétia</span></button>
      <button type="button" data-rb="section-overview" class="rb-section-overview" aria-pressed="false"><span class="rb-wide">Vue complète</span><span class="rb-narrow">Tout</span></button>
    </div>
    <section id="rb-shortcuts-panel" class="rb-card rb-shortcuts" data-rb="shortcuts-panel" aria-labelledby="rb-shortcuts-title" hidden>
      <div class="rb-card-head"><h2 id="rb-shortcuts-title">Raccourcis &amp; gestes rapides</h2><button type="button" data-rb="shortcuts-close">Fermer</button></div>
      <div class="rb-shortcuts-grid">
        <div><strong>Clavier · Pilotage &amp; Sécurité</strong>
          <ul>
            <li><kbd>Échap</kbd> Relâcher l’autorisation d’armement</li>
            <li><kbd>Q</kbd> / <kbd>A</kbd> Base + / − (ou X en XYZ)</li>
            <li><kbd>W</kbd> / <kbd>S</kbd> Épaule + / − (ou Y en XYZ)</li>
            <li><kbd>E</kbd> / <kbd>D</kbd> Coude + / − (ou Z en XYZ)</li>
            <li><kbd>R</kbd> / <kbd>F</kbd> Pince + / − · <kbd>?</kbd> Aide</li>
            <li><kbd>Ctrl+Z</kbd> / <kbd>Suppr</kbd> Annuler / retirer point 3D</li>
          </ul>
        </div>
        <div><strong>Moniteur 2D · 3D · Caméra AR</strong>
          <ul>
            <li><kbd>Clic plan XY</kbd> Viser / prévisualiser une cible</li>
            <li><kbd>Glisser point XY</kbd> Suivi continu du bras</li>
            <li><kbd>Glisser 3D / Molette</kbd> Orbite libre &amp; zoom</li>
            <li><kbd>Double-clic 3D</kbd> Réinitialiser la vue Iso</li>
            <li><kbd>Clic articulation 3D</kbd> Cibler le curseur d’axe</li>
            <li><kbd>Clic vidéo AR</kbd> Viser X / Y sur le direct</li>
          </ul>
        </div>
        <div><strong>Manette Web · Homme-mort</strong>
          <ul>
            <li><kbd>Maintenir L1 / LB</kbd> Gâchette homme-mort requise</li>
            <li><kbd>Relâcher L1 / LB</kbd> Désarmement immédiat</li>
            <li><kbd>Bouton B</kbd> STOP logiciel d’urgence</li>
            <li><kbd>Stick G</kbd> Pas bornés Base &amp; Épaule</li>
            <li><kbd>Stick D</kbd> Pas bornés Coude</li>
            <li><kbd>L2 / R2</kbd> Ouvrir / fermer la pince</li>
          </ul>
        </div>
      </div>
    </section>
    <div class="rb-status" aria-label="État du poste">
      <div class="rb-status-device"><span>Mode</span><strong data-rb="mode">Connexion…</strong></div>
      <div class="rb-status-device"><span>Bras</span><strong data-rb="arm-state">—</strong></div>
      <div class="rb-status-device"><span>Caméra</span><strong data-rb="camera-state">—</strong></div>
      <div class="rb-status-safety">
        <button type="button" class="rb-estop" data-rb="estop" data-help="Ouvre les réglages du moniteur d’arrêt d’urgence matériel (E-stop).">E-stop —</button>
        <strong data-rb="safety" role="status">Désarmé</strong>
        <button type="button" data-rb="status-home" hidden disabled data-help="Ramène le bras à la position neutre par petits pas mesurés.">Neutre</button>
        <button type="button" data-rb="status-disarm" hidden disabled data-help="Relâche immédiatement l’autorisation d’armement (Échap).">Désarmer</button>
        <button type="button" class="rb-stop" data-rb="stop" data-help="Verrouille immédiatement le pilotage et coupe le couple si un mouvement est actif." disabled>STOP logiciel</button>
      </div>
    </div>
    <div class="rb-hover-explain is-dormant" data-rb="hover-explain" role="status" aria-live="polite" hidden>
      <span class="rb-hover-badge">Info</span>
      <span data-rb="hover-explain-text"></span>
    </div>
    <div class="rb-copilot" data-rb="kinetia-copilot" role="region" aria-label="Alerte Kinétia" hidden>
      <span class="rb-copilot-badge">Kinétia</span>
      <span class="rb-copilot-text" data-rb="copilot-text"></span>
      <div class="rb-copilot-actions" data-rb="copilot-actions"></div>
      <button type="button" class="rb-copilot-open" data-rb="copilot-open" data-help="Ouvre le dialogue Kinétia.">Ouvrir Kinétia</button>
    </div>
    <section class="rb-card rb-commission" data-section="commission" data-section-panel="commission" data-rb="commission-card" aria-labelledby="rb-commission-title" hidden>
      <div class="rb-card-head"><h2 id="rb-commission-title">Mise en service du bras</h2><span data-rb="commission-progress">—</span></div>
      <p class="rb-hint">Le pilotage physique reste verrouillé tant que la révision des réglages n’est pas approuvée sur le PC HQ. Cette liste suit l’état réel du poste ; elle n’approuve rien.</p>
      <ol class="rb-commission-live" data-rb="commission-live"></ol>
      <div class="rb-btn-row" data-cols="auto">
        <button type="button" class="rb-primary" data-rb="commission-probe">Lire le RoArm</button>
        <button type="button" data-rb="commission-settings">Ouvrir les réglages</button>
        <button type="button" data-rb="commission-reveal" aria-pressed="false">Afficher le pilotage (verrouillé)</button>
      </div>
      <details class="rb-commission-approve"><summary>Signer les portes 2 &amp; 3 et approuver · PC HQ</summary>
        <p class="rb-hint">Après l’inspection physique (<code>docs/robotics-commissioning-checklist.md</code>), cochez chaque contrôle vérifié sur le banc puis approuvez cette révision depuis le PC HQ.</p>
        <div class="rb-settings-grid">
          <label>Version firmware RoArm<input type="text" data-rb="commission-firmware" maxlength="64" placeholder="Ex. : RoArm-M2-S v1.4"></label>
          <label>Opérateur<input type="text" data-rb="commission-operator" maxlength="64" placeholder="Ex. : Marc-Antoine"></label>
        </div>
        <div class="rb-wb-checks" data-rb="commission-gates">
          <label class="rb-check"><input type="checkbox" data-gate="G2.1"> G2.1 · E-stop NC physique indépendant vérifié (sans chute dangereuse)</label>
          <label class="rb-check"><input type="checkbox" data-gate="G2.2"> G2.2 · Support/capture mécanique couvrant la chute sans couple</label>
          <label class="rb-check"><input type="checkbox" data-gate="G2.3"> G2.3 · Câblage libre et enveloppe XYZ vérifiés à la main</label>
          <label class="rb-check"><input type="checkbox" data-gate="G2.4"> G2.4 · Moniteur /estop testé (contact ouvert/débranché verrouille STOP)</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.1"> G3.1 · Télémétrie couple T:105 (torswitchB/S/E/H) vérifiée</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.2"> G3.2 · T:210 cmd:0 comportement gravité et réarmement inspectés</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.3"> G3.3 · Latence d’arrêt et verrou mesurées</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.4"> G3.4 · Arrêt physique confirmé vs tolérance T:105</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.5"> G3.5 · Synchronisation multi-axes (3°–5°) observée</label>
          <label class="rb-check"><input type="checkbox" data-gate="G3.6"> G3.6 · Timeout PTZ &amp; empreinte TLS Tapo SHA-256 vérifiés</label>
        </div>
        <div class="rb-btn-row" data-cols="auto">
          <button type="button" class="rb-primary" data-rb="commission-approve-btn" disabled>Approuver la mise en service (PC HQ)</button>
        </div>
        <details><summary>Alternative PowerShell · PC HQ</summary>
          <pre><code>Set-Location C:\\Transfert
python -c "from pathlib import Path; from hq_robotics import Robotics, PROFILE; r=Robotics(Path.cwd()); c=r.config(); assert c['mode']=='hardware' and (c['arm_ip'] or c['serial_port']) and c['revision']; r.write(r.commission_path, {'revision':c['revision'],'profile':PROFILE})"</code></pre>
        </details>
        <p class="rb-hint">Chaque enregistrement des réglages retire l’approbation. Supprimez <code>.hq-agent-state\\robotics-commission.json</code> pour la retirer.</p>
      </details>
    </section>
    <div class="rb-workspace">
      <section class="rb-card rb-camera" data-section="camera" aria-labelledby="rb-monitor-title">
        <div class="rb-card-head rb-monitor-head">
          <h2 id="rb-monitor-title">Moniteur</h2>
          <div class="rb-monitor-toolbar">
            <div class="rb-tabs rb-monitor-tabs" role="group" aria-label="Vue du moniteur">
              <button type="button" data-monitor-base="position" data-monitor="position" aria-controls="rb-position-pane" aria-pressed="true" data-help="Affiche le plan XY vu de dessus : cliquer vise une cible sans bouger, glisser le point vert déplace le bras si armé.">Plan XY</button>
              <button type="button" data-monitor-base="camera" data-monitor="camera" aria-controls="rb-camera-pane" aria-pressed="false" data-help="Affiche le direct Tapo C200, le contrôle PTZ, la vision nocturne et le repère AR.">Caméra</button>
              <button type="button" data-monitor-base="space" data-monitor="space" aria-controls="rb-space-pane" aria-pressed="false" data-help="Affiche le jumeau 3D du RoArm-M2-S, l’éditeur de trajectoires et les zones d’exclusion.">3D</button>
            </div>
            <label class="rb-monitor-layout">Disposition<select data-rb="monitor-layout" aria-label="Disposition du moniteur">
              <option value="single" selected>Simple</option>
              <option value="split">2D + 3D</option>
              <option value="cam3d">Caméra + 3D</option>
            </select></label>
          </div>
        </div>
        <details class="rb-help rb-card-guide"><summary>Comprendre le moniteur</summary>
          <p class="rb-help-badges"><span class="is-safe">🟢 Clic sur le plan / 3D = aperçu sans mouvement</span> <span class="is-live">🟠 Glisser le point du bras (armé) = mouvement réel</span></p>
        </details>
        <div id="rb-position-pane" data-rb="position-pane">
          <div class="rb-viewport rb-plot">
            <div class="rb-plot-caption"><span>Plan XY · mm</span><span data-rb="plot-source">—</span></div>
            <canvas data-rb="plot" aria-hidden="true" title="Cliquez pour viser une position XY ; faites glisser le point du bras pour le déplacer"></canvas>
            <div class="rb-plot-key"><span class="rb-key-area">Zone XY</span><span>Position</span><span class="rb-key-preview" data-rb="plot-preview" hidden>Aperçu</span><span class="rb-key-command" data-rb="plot-command" hidden>Cible</span><span class="rb-key-trace" data-rb="plot-trace" hidden>Trace</span><span class="rb-key-ghost" data-rb="plot-ghosts" hidden>Bibliothèque</span></div>
          </div>
          <dl class="rb-coordinates">
            ${['x', 'y', 'z'].map(axis => `<div><dt>${axis.toUpperCase()}</dt><dd><output data-rb="position-${axis}">—</output><span>mm</span></dd></div>`).join('')}
          </dl>
          <figure class="rb-side">
          <figcaption><span>Vue de côté · portée / Z · mm</span>
            <span class="rb-side-key"><i class="is-live"></i>Mesuré <i class="is-target"></i>Champs</span></figcaption>
          <canvas data-rb="side" role="img" aria-label="Vue de côté du bras : pose mesurée et pose des champs"></canvas>
        </figure>
        <figure class="rb-gauges">
          <figcaption><span>Cadrans articulaires &amp; ouverture pince · mm</span><span data-rb="jaw-readout">Pince —</span></figcaption>
          <canvas class="rb-visual-gauges" data-rb="visual-gauges" role="img" aria-label="Cadrans articulaires et ouverture parallèle de la pince" title="Cliquez sur un cadran pour cibler l’axe, ou sur la pince pour régler son ouverture"></canvas>
        </figure>
          <p class="rb-hint">Cliquez pour viser. Faites glisser le point du bras pour le suivre ; relâchez dans le plan pour terminer. Z et la pince viennent du formulaire.</p>
        </div>
        <div id="rb-space-pane" data-rb="space-pane" hidden>
          <div class="rb-viewport rb-space">
            <canvas data-rb="space" role="img" aria-label="Vue 3D du bras, de son espace de travail et des zones d’exclusion"></canvas>
            <div class="rb-space-views" role="group" aria-label="Point de vue">
              <button type="button" data-space-view="iso" aria-pressed="true">Iso</button>
              <button type="button" data-space-view="front" aria-pressed="false">Face</button>
              <button type="button" data-space-view="side" aria-pressed="false">Côté</button>
              <button type="button" data-space-view="top" aria-pressed="false">Dessus</button>
            </div>
            <span class="rb-space-note" data-rb="space-note">Chargement de la vue 3D…</span>
            <button type="button" class="rb-space-clear" data-rb="space-clear" title="Effacer la trace de la pince">Effacer la trace</button>
          </div>
          <div class="rb-plot-key rb-space-key"><span class="rb-key-live">Mesuré</span><span class="rb-key-target">Champs</span><span class="rb-key-trace">Trace de la pince</span><span class="rb-key-zone">Zone d’exclusion</span><span class="rb-key-envelope">Enveloppe XYZ</span></div>
          <div class="rb-btn-row" data-cols="3">
          <button type="button" class="rb-compose-toggle" data-rb="compose-toggle" aria-pressed="false">Composer un mouvement</button>
          <button type="button" class="rb-zones-toggle" data-rb="zones-toggle" aria-pressed="false">Zones d’exclusion</button>
          <button type="button" class="rb-flight-toggle" data-rb="flight-toggle" aria-pressed="false">Journal noir 3D</button>
          </div>
          <section class="rb-zones" data-rb="zones" aria-label="Zones d’exclusion" hidden>
            <div class="rb-compose-head"><strong>Zones d’exclusion</strong><span data-rb="zones-count">—</span></div>
            <p class="rb-hint">Aucune partie du bras ne peut entrer dans ces boîtes. Brouillon jusqu’à l’enregistrement · Suppr efface la zone · Ctrl+Z défait.</p>
            <details class="rb-help"><summary>Aide</summary>
              <p>Chaque mouvement, aperçu, script et lecture fluide est refusé si un segment, la pince ou l’épaule touche une zone. Dans la vue 3D, cliquez le point d’une zone pour la sélectionner, glissez son anneau pour la déplacer, le losange pour la monter ou la descendre, et les carrés de ses faces pour la redimensionner.</p>
              <p>Ces zones guident le logiciel ; elles ne remplacent ni la coupure physique ni une clôture : elles n’empêchent pas une chute à la coupure du couple ni un mouvement du firmware au démarrage.</p>
            </details>
            <div class="rb-btn-row" data-cols="3"><button type="button" data-rb="zones-add">${svg('plus')}Zone</button>
              <button type="button" data-rb="zones-undo" title="Défaire la dernière modification (Ctrl+Z)" disabled>${svg('undo')}Défaire</button>
              <button type="button" class="rb-danger-quiet" data-rb="zones-revert">Tout annuler</button></div>
            <div class="rb-zones-list" data-rb="zones-list"></div>
            <p class="rb-zones-conflict" data-rb="zones-conflict" role="status"></p>
            <p class="rb-zones-warn">Enregistrer crée une nouvelle version des réglages : l’approbation de mise en service est à refaire, et les scripts de la Bibliothèque sont à mettre à jour puis à faire revoir. Disponible sur le PC HQ, poste désarmé.</p>
            <div class="rb-btn-row" data-cols="1"><button type="button" class="rb-primary" data-rb="zones-save" disabled>Enregistrer les zones</button></div>
            <p class="rb-compose-result" data-rb="zones-result" role="status"></p>
          </section>
          <section class="rb-compose" data-rb="compose" aria-label="Éditeur de mouvement" hidden>
            <div class="rb-compose-head"><strong>Éditeur de mouvement</strong><span data-rb="compose-count">Aucun point</span></div>
            <p class="rb-hint">Le point sélectionné suit les champs de Pilotage et la vue 3D. Suppr l’efface · Ctrl+Z défait · le brouillon est gardé. Rien n’est envoyé au bras.</p>
            <details class="rb-help"><summary>Aide</summary>
              <p>Dans la vue 3D, glissez l’anneau du point pour le déplacer à hauteur constante et le losange pour changer sa hauteur ; cliquez un autre point pour le sélectionner.</p>
              <p>Chaque étape a sa trajectoire : articulaire (chaque articulation tourne régulièrement), linéaire (ligne droite de la pince), arc (passe par le carré bleu, à glisser), arc + tour complet, ou lissé (courbe sans angle). HQ vérifie le script à chaque modification.</p>
            </details>
            <div class="rb-btn-row" data-cols="2">
              <button type="button" data-rb="compose-add-fields">${svg('plus')}Pose des champs</button>
              <button type="button" data-rb="compose-add-measured">${svg('plus')}Pose mesurée</button>
            </div>
            <div class="rb-btn-row" data-cols="3">
              <button type="button" data-rb="compose-play">Lecture</button>
              <button type="button" data-rb="compose-undo" title="Défaire la dernière modification (Ctrl+Z)" disabled>${svg('undo')}Défaire</button>
              <button type="button" class="rb-danger-quiet" data-rb="compose-clear">Tout effacer</button>
            </div>
            <div class="rb-compose-scrub" data-rb="compose-scrub-wrap" hidden>
              <label>Aperçu 3D avant exécution<strong data-rb="compose-scrub-label">0 %</strong>
                <input type="range" class="rb-slider" data-rb="compose-scrub" min="0" max="100" step="1" value="0" aria-label="Curseur d’aperçu 3D avant exécution">
              </label>
              <span class="rb-compose-scrub-meta" data-rb="compose-scrub-meta"></span>
            </div>
            <ol class="rb-compose-list" data-rb="compose-list"></ol>
            <div class="rb-compose-tuning" data-rb="compose-tuning" hidden>
              <label>Vitesse étape · %<select data-rb="compose-leg-speed"><option value="100" selected>100 % · nominale</option><option value="75">75 % · approche</option><option value="50">50 % · lente</option><option value="25">25 % · fine</option></select></label>
              <label>Pause à l’arrivée · s<input data-rb="compose-leg-dwell" type="number" min="0" max="10" step="0.5" value="0"></label>
            </div>
            <p class="rb-compose-result" data-rb="compose-result" role="status"></p>
            <div class="rb-compose-save">
              <label>Titre<input data-rb="compose-title" maxlength="96" placeholder="Ex. : balayage du bac"></label>
              <label>Résumé<input data-rb="compose-summary" maxlength="160" placeholder="Ce que fait le mouvement, en une phrase"></label>
              <button type="button" class="rb-primary" data-rb="compose-send" disabled>Envoyer à la revue</button>
            </div>
            <p class="rb-hint">Revue : Kinétia d’abord, puis Gemini, puis votre approbation (ou votre approbation manuelle). Le script arrive dans la Bibliothèque ; la lecture sur le vrai bras garde toutes ses protections.</p>
          </section>
          <section class="rb-flight" data-rb="flight" aria-label="Relecture du journal noir" hidden>
            <div class="rb-compose-head"><strong>Journal noir · boîte noire</strong><span data-rb="flight-count">0 échantillon</span></div>
            <p class="rb-hint">Relecture locale des 360 derniers échantillons (pose mesurée, cible, couple, latence et incidents). Rien n’est envoyé au bras.</p>
            <canvas class="rb-flight-chart" data-rb="flight-chart" aria-label="Chronologie de charge et d’incidents du journal noir"></canvas>
            <input type="range" class="rb-slider rb-flight-scrub" data-rb="flight-scrub" min="0" max="0" step="1" value="0" aria-label="Curseur temporel du journal noir">
            <p class="rb-flight-meta" data-rb="flight-meta" role="status">Aucun échantillon chargé.</p>
            <div class="rb-btn-row" data-cols="3">
              <button type="button" data-rb="flight-play" disabled>Lecture</button>
              <button type="button" data-rb="flight-apply" disabled>Copier vers champs</button>
              <button type="button" data-rb="flight-refresh">Actualiser</button>
            </div>
          </section>
          <p class="rb-hint">Glisser : tourner · molette ou pincement : zoom · double-clic : Iso. Affichage indicatif, le serveur valide chaque mouvement.</p>
        </div>
        <div id="rb-camera-pane" data-rb="camera-pane" hidden>
          <div class="rb-viewport" data-rb="viewport">
            <video data-rb="video" muted playsinline aria-label="Vidéo en direct du Tapo C200"></video>
            <canvas class="rb-video-boost" data-rb="video-boost" aria-hidden="true" hidden></canvas>
            <span class="rb-video-note" data-rb="video-note">Flux arrêté</span>
            <div class="rb-video-idle" data-rb="video-idle">
              <span class="rb-lens" aria-hidden="true"></span>
              <strong>Caméra en veille</strong><span data-rb="video-hint"></span>
              <button type="button" data-rb="camera-setup" hidden>Configurer le Tapo</button>
            </div>
            <canvas class="rb-camera-overlay" data-rb="camera-overlay" aria-hidden="true" hidden></canvas>
            <div class="rb-video-hud" data-rb="video-hud" hidden>
              <span class="rb-hud-live"><span data-rb="hud-live">Flux arrêté</span></span>
              <span class="rb-hud-rate" data-rb="hud-rate">— i/s</span>
              <span class="rb-hud-latency" data-rb="hud-latency">— ms</span>
              <span class="rb-hud-cells">X <span data-rb="hud-x">—</span> · Y <span data-rb="hud-y">—</span> · Z <span data-rb="hud-z">—</span> <i>mm</i></span>
              <button type="button" class="rb-stop rb-hud-stop" data-rb="stop-hud" disabled>STOP logiciel</button>
            </div>
          </div>
          <div class="rb-camera-actions">
            <label class="rb-quality"><span>Qualité</span><select data-rb="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
            <div class="rb-btn-row" data-cols="flow">
              <button type="button" class="rb-primary" data-rb="video-start" disabled data-help="Démarre le flux vidéo en direct H.264 du Tapo C200.">Démarrer le direct</button>
              <button type="button" data-rb="video-stop" disabled hidden data-help="Arrête le flux vidéo en direct.">Couper le flux</button>
              <button type="button" data-rb="fullscreen" disabled hidden data-help="Affiche la caméra en plein écran.">Plein écran</button>
              <button type="button" data-rb="snap-capture" disabled hidden data-help="Capture une photo du direct avec la pose actuelle du bras.">Capturer photo</button>
              <button type="button" data-rb="cam-detect" disabled hidden data-help="Détecte l’objet le plus contrasté dans la zone calibrée et vise ses coordonnées XY.">Viser objet (AR)</button>
              <button type="button" data-rb="video-boost-btn" aria-pressed="false" hidden data-help="Interpole le direct vidéo à 60 Hz côté GPU avec contraste optique renforcé.">Lissage 60 FPS</button>
            </div>
          </div>
          <div class="rb-snap-strip" data-rb="snap-strip" hidden></div>
          <div class="rb-audio" data-rb="audio" role="group" aria-label="Audio de la caméra" hidden>
            <audio data-rb="speaker" playsinline></audio>
            <button type="button" data-rb="listen" aria-pressed="false" disabled>Écouter</button>
            <button type="button" data-rb="talk" aria-pressed="false" disabled>Parler</button>
            <span data-rb="audio-status" role="status"></span>
          </div>
          <div class="rb-ptz" data-rb="ptz" role="group" aria-label="Orientation de la caméra" hidden>
            <button type="button" class="rb-icon-button" data-ptz="up" aria-label="Caméra vers le haut">${svg('chevron-up')}</button>
            <button type="button" class="rb-icon-button" data-ptz="left" aria-label="Caméra vers la gauche">${svg('chevron-left')}</button>
            <button type="button" class="rb-icon-button" data-ptz="stop" aria-label="Arrêter la caméra">${svg('square')}</button>
            <button type="button" class="rb-icon-button" data-ptz="right" aria-label="Caméra vers la droite">${svg('chevron-right')}</button>
            <button type="button" class="rb-icon-button" data-ptz="down" aria-label="Caméra vers le bas">${svg('chevron-down')}</button>
            <label class="rb-ptz-pulse">Impulsion <select data-rb="ptz-pulse">
              <option value="150">Courte · 150 ms</option><option value="300">Moyenne · 300 ms</option>
              <option value="450" selected>Standard · 450 ms</option><option value="700">Longue · 700 ms</option>
            </select></label>
          </div>
          <div class="rb-ptz-presets" data-rb="ptz-presets" hidden>
            <label>Vue absolue<select data-rb="ptz-preset-list"><option value="">Aucune vue</option></select></label>
            <button type="button" data-rb="ptz-preset-goto" disabled>Aller</button>
            <label>Nommer la vue courante<input data-rb="ptz-preset-name" maxlength="64" placeholder="Ex. : vue large"></label>
            <button type="button" data-rb="ptz-preset-save" disabled>Mémoriser</button>
            <button type="button" data-rb="ptz-preset-refresh">Actualiser</button>
            <span data-rb="ptz-preset-state" role="status"></span>
          </div>
          <div class="rb-night" data-rb="night" role="group" aria-label="Vision nocturne" hidden>
            <span>Vision nocturne</span>
            <button type="button" data-night="auto" aria-pressed="false">Auto</button>
            <button type="button" data-night="off" aria-pressed="false">Jour</button>
            <button type="button" data-night="on" aria-pressed="false">Nuit</button>
            <small class="rb-night-note" data-rb="night-note">Mode inconnu tant que le direct n’a pas démarré</small>
          </div>
          <details class="rb-camera-calibration" data-rb="camera-calibration" hidden>
            <summary>Repère caméra · indicatif</summary>
            <p class="rb-hint">Trois points de référence relient le plan XY à l’image. Cliquez « Prendre » puis le point correspondant dans la vidéo, saisissez ses coordonnées robot, et répétez. Le repère est mémorisé dans ce navigateur seulement ; il est indicatif et ne remplace pas une calibration caméra.</p>
            <div class="rb-cal-points">
              <div class="rb-cal-point" data-cal-point="a"><b>A</b><button type="button" data-cal-capture="a">Prendre</button><button type="button" data-cal-auto="a" title="Copier X et Y actuels de la pince du bras">XY pince</button><label>X mm<input data-cal-x="a" type="number" step="1" required></label><label>Y mm<input data-cal-y="a" type="number" step="1" required></label><output data-cal-pixel="a">—</output></div>
              <div class="rb-cal-point" data-cal-point="b"><b>B</b><button type="button" data-cal-capture="b">Prendre</button><button type="button" data-cal-auto="b" title="Copier X et Y actuels de la pince du bras">XY pince</button><label>X mm<input data-cal-x="b" type="number" step="1" required></label><label>Y mm<input data-cal-y="b" type="number" step="1" required></label><output data-cal-pixel="b">—</output></div>
              <div class="rb-cal-point" data-cal-point="c"><b>C</b><button type="button" data-cal-capture="c">Prendre</button><button type="button" data-cal-auto="c" title="Copier X et Y actuels de la pince du bras">XY pince</button><label>X mm<input data-cal-x="c" type="number" step="1" required></label><label>Y mm<input data-cal-y="c" type="number" step="1" required></label><output data-cal-pixel="c">—</output></div>
            </div>
            <div class="rb-actions"><button type="button" data-cal-save>Enregistrer le repère</button>
              <button type="button" data-cal-auto-detect title="Détecte automatiquement les 3 pastilles Rouge / Vert / Bleu sur le direct">Auto-calibrer (3 pastilles)</button>
              <button type="button" data-cal-sheet title="Télécharge une mire SVG imprimable avec les 3 pastilles A/B/C">Mire 3 pastilles (SVG)</button>
              <button type="button" data-cal-clear>Effacer</button>
              <label class="rb-check"><input type="checkbox" data-cal-show checked> Afficher sur le direct</label>
              <label class="rb-check"><input type="checkbox" data-cal-ar checked> Squelette 3D, zones et clic-cible sur la vidéo</label></div>
            <p data-rb="cal-state" role="status">Aucun repère.</p>
          </details>
        </div>
      </section>
      <section class="rb-card rb-motion" data-section="motion" data-rb="motion" aria-labelledby="rb-motion-title">
        <div class="rb-card-head"><h2 id="rb-motion-title">Pilotage</h2><span data-rb="motion-state">En attente</span></div>
        <details class="rb-help rb-card-guide"><summary>Comprendre le pilotage</summary>
          <p class="rb-help-badges"><span class="is-safe">🟢 Champs, curseurs, Ouvrir/Fermer, Aperçu = remplissent seulement la cible</span> <span class="is-live">🟠 Déplacer, +/−, Saisir au contact, Retour au neutre = déplacent le bras (poste armé)</span></p>
        </details>
        <div class="rb-safety">
          <div class="rb-btn-row" data-cols="2">
            <button type="button" class="rb-primary" data-rb="arm" data-help="Active l’autorisation temporaire de mouvement (bail de 20 s). Nécessaire avant tout déplacement." disabled>Armer</button>
            <button type="button" data-rb="cancel" data-help="Relâche immédiatement l’autorisation d’armement (raccourci Échap) et arrête les séquences en cours." disabled>Annuler / désarmer</button>
          </div>
          <div class="rb-btn-row rb-tools" data-cols="flow">
            <button type="button" data-rb="reset" hidden>Réinitialiser</button>
            <button type="button" data-rb="probe" hidden>Lire le RoArm</button>
          </div>
          <div class="rb-lease-row">
            <span class="rb-lease" data-rb="lease" hidden><span data-rb="lease-text">Autorisation · 20 s</span><i class="rb-lease-bar" aria-hidden="true"><b data-rb="lease-fill"></b></i></span>
            <button type="button" class="rb-lease-renew" data-rb="lease-renew" hidden data-help="Prolonge immédiatement l’autorisation d’armement de 20 secondes sans désarmer.">Prolonger +20 s</button>
          </div>
          <div class="rb-interlock-bar">
            <p data-rb="interlock">Chargement de l’état…</p>
            <button type="button" class="rb-interlock-action" data-rb="interlock-action" hidden></button>
            <button type="button" class="rb-link" data-rb="interlock-go" hidden>Voir la mise en service</button>
          </div>
          <p class="rb-hardware-note" data-rb="hardware-note" hidden>Le STOP verrouille le pilotage. Il demande la coupure du couple seulement si un mouvement est en cours ou incertain, et le bras peut alors tomber. Si la liaison échoue, utilisez la coupure physique.</p>
        </div>
        <p class="rb-hint rb-keyjog-hint" data-rb="keyjog-hint" hidden>Clavier (armé) : Q/A base · W/S épaule · E/D coude · R/F pince. En XYZ : X, Y, Z, pince. Un pas par appui.</p>
        <p class="rb-hint rb-pad-hint" data-rb="pad-hint" hidden>Manette (homme-mort L1/LB maintenu) : stick G base/épaule · stick D coude/pince · B STOP. Relâcher L1 désarme.</p>
        <div class="rb-pose-head">
          <div class="rb-tabs" role="group" aria-label="Mode de pilotage">
            <button type="button" data-mode="joints" aria-pressed="true" data-help="Piloter axe par axe en degrés (Base, Épaule, Coude, Pince).">Articulations</button>
            <button type="button" data-mode="cartesian" aria-pressed="false" data-help="Piloter par position spatiale X, Y, Z en millimètres (cinématique inverse).">XYZ</button>
          </div>
          <div class="rb-pose-quick" role="group" aria-label="Outils de saisie rapide">
            <button type="button" data-rb="sync-actual" data-help="Copie la position mesurée du bras dans les champs sans rien envoyer.">Copier le bras</button>
            <button type="button" data-rb="pose-undo" disabled data-help="Annule la dernière modification des champs ou curseurs.">Annuler saisie</button>
          </div>
        </div>
        <div class="rb-preset-chips" data-rb="preset-chips" role="group" aria-label="Accès rapide aux positions enregistrées" hidden></div>
        <form data-rb="pose" class="rb-pose">
          <p class="rb-pose-note" data-rb="pose-note" hidden>Valeurs par défaut (neutre) : aucune position mesurée sur le bras.</p>
          <div data-rb="joints">${axisRows(axes)}</div>
          <div data-rb="cartesian" hidden>${axisRows(coordinates, true)}</div>
          <p class="rb-pose-warn" data-rb="pose-warn" role="status" hidden></p>
          <div class="rb-grip" role="group" aria-label="Pince · remplit le champ, ne déplace rien">
            <span>Pince</span>
            <button type="button" data-grip="open" data-help="Règle le champ Pince sur l’ouverture maximale (ne déplace pas encore le bras).">Ouvrir</button>
            <button type="button" data-grip="half" data-help="Règle le champ Pince à mi-course (ne déplace pas encore le bras).">Mi-course</button>
            <button type="button" data-grip="close" data-help="Règle le champ Pince sur 180° fermé (ne déplace pas encore le bras).">Fermer</button>
          </div>
          <details class="rb-motion-advanced"><summary>Pilotage avancé · vitesse, outil, saisie au couple</summary>
          <div class="rb-grasp" role="group" aria-label="Saisie au couple">
            <label>Seuil pince · couple<input data-rb="grasp-limit" type="number" min="80" max="900" step="10" value="320" data-help="Couple maximal autorisé lors d’une prise au contact (80–900)."></label>
            <button type="button" data-rb="grasp-run" disabled data-help="Ferme la pince par petits pas mesurés et s’arrête dès qu’un objet atteint le seuil de couple.">Saisir au contact</button>
            <small class="rb-grasp-state" data-rb="grasp-state" role="status">Ferme par pas mesurés jusqu’au seuil de couple.</small>
          </div>
          <div class="rb-tuning">
            <label>Pas · °<select data-rb="angle-step"><option>1</option><option selected>2</option><option>5</option></select></label>
            <label data-rb="linear-step-label" hidden>Pas · mm<select data-rb="linear-step"><option>2</option><option selected>5</option><option>10</option></select></label>
            <label>Vitesse · pas/s<input data-rb="speed" type="number" inputmode="numeric" min="40" max="100" step="1" value="100" required><small class="rb-speed-deg" data-rb="speed-deg"></small></label>
            <label>Outil prédéfini<select data-rb="tool-preset" data-help="Profils rapides d’outil : ajuste automatiquement Outil +mm et Plancher Z.">
              <option value="stock">Pince stock · 0 mm</option>
              <option value="pen">Stylo / Traceur · +42 mm</option>
              <option value="probe">Pointe sonde · +55 mm</option>
              <option value="iron">Fer à souder · +85 mm</option>
              <option value="custom">Personnalisé</option>
            </select></label>
            <label>Outil +mm<input data-rb="tool-offset" type="number" min="0" max="120" step="1" value="0" data-help="Longueur supplémentaire d’un outil tenu en pince (ex. stylo, fer) pour surveiller la garde au bureau."></label>
            <label>Plancher Z · mm<input data-rb="floor-z" type="number" min="-80" max="200" step="5" value="0" data-help="Hauteur minimale du plan de travail (garde anti-collision bureau sur les déplacements XY)."></label>
          </div>
          </details>
          <div class="rb-btn-row" data-cols="1-2">
            <button type="button" data-rb="preview" disabled data-help="Calcule la cible sur le plan XY et en 3D sans déplacer le bras.">Aperçu</button>
            <button type="submit" class="rb-primary" data-rb="move" disabled data-help="Envoie le mouvement vers la cible des champs (sous réserve d’armement et de limite de pas).">Déplacer</button>
          </div>
          <button type="button" class="rb-primary rb-move-approach" data-rb="move-approach" hidden disabled data-help="Enchaîne automatiquement plusieurs petits pas mesurés jusqu’à la cible lointaine.">Approcher par pas mesurés</button>
          <div class="rb-btn-row" data-cols="2">
            <button type="button" data-rb="home" disabled data-help="Ramène doucement le bras à la position neutre par petits pas mesurés.">Retour au neutre</button>
            <button type="button" data-rb="home-direct" disabled data-help="Ramène le bras au neutre en un seul mouvement à vitesse réduite (double confirmation requise).">Neutre direct</button>
          </div>
          <p class="rb-move-note" data-rb="move-note" role="status" hidden></p>
          <div class="rb-playback rb-motion-progress" data-rb="motion-progress" role="group" aria-label="Mouvement en cours" hidden>
            <div class="rb-playback-head"><strong>Mouvement en cours</strong><span data-rb="motion-left">—</span></div>
            <div class="rb-playback-bar" role="progressbar" aria-label="Progression du mouvement" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-rb="motion-bar"><i data-rb="motion-fill"></i></div>
            <div class="rb-playback-foot"><span data-rb="motion-elapsed"></span><button type="button" data-rb="motion-cancel">Annuler / désarmer</button></div>
          </div>
          <div class="rb-playback rb-homing" data-rb="homing" role="group" aria-label="Progression du retour au neutre" hidden>
            <div class="rb-playback-head"><strong data-rb="homing-name">Retour au neutre</strong><span data-rb="homing-step">—</span></div>
            <div class="rb-playback-bar" role="progressbar" aria-label="Progression du retour au neutre" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-rb="homing-bar"><i data-rb="homing-fill"></i></div>
            <div class="rb-playback-foot"><span data-rb="homing-elapsed"></span><span data-rb="homing-remaining"></span></div>
          </div>
          <output data-rb="preview-result" aria-live="polite" hidden></output>
          <p class="rb-hint">Un appui suivi d’un relâchement sur +/− envoie un seul pas depuis la position mesurée. Échap relâche l’autorisation d’armement.</p>
        </form>
      </section>
      <section class="rb-card rb-telemetry" data-section="telemetry" aria-labelledby="rb-telemetry-title">
        <div class="rb-card-head"><h2 id="rb-telemetry-title">Télémétrie</h2><span data-rb="feedback-state">—</span></div>
        <div class="rb-telemetry-empty" data-rb="telemetry-empty" hidden><p>Le bras n’a encore rien renvoyé.</p>
          <button type="button" data-rb="telemetry-probe">Lire le RoArm</button></div>
        <table><thead><tr><th scope="col">Axe</th><th scope="col" data-rb="actual-label">Mesuré</th><th scope="col">Demandé</th><th scope="col" title="Demandé − mesuré">Écart</th><th scope="col" title="Couple brut · barre relative 0–1000">Charge</th></tr></thead>
          <tbody>${Object.entries(axes).map(([key, label]) => `<tr><th scope="row">${label}</th>
          <td data-rb="actual-${key}">—</td><td data-rb="target-${key}">—</td><td class="rb-delta" data-rb="delta-${key}">—</td>
          <td data-rb="load-${key}"><div class="rb-load"><span data-rb="load-value-${key}">—</span><span class="rb-load-track" aria-hidden="true"><i data-rb="load-fill-${key}"></i></span></div></td></tr>`).join('')}</tbody></table>
        <div class="rb-readings" data-rb="electrical" hidden><output data-rb="voltage">Tension —</output></div>
        <details class="rb-telemetry-advanced"><summary>Diagnostic avancé · tendance, proprioception, pesée</summary>
        <div class="rb-load-watch" data-rb="load-watch">
          <canvas data-rb="load-trend" aria-label="Tendance de la charge maximale"></canvas>
          <div><strong data-rb="load-alert" role="status">Charge sous surveillance</strong>
          <span data-rb="load-peak">Pic —</span></div>
        </div>
        <div class="rb-proprio" data-rb="proprio">
          <div class="rb-proprio-head">
            <strong data-rb="proprio-state" role="status">Proprioception · flexion gravitaire</strong>
            <span data-rb="proprio-moment">Portée —</span>
          </div>
          <div class="rb-proprio-grid">
            <div><span>Épaule · attendu / réel</span><output data-rb="proprio-shoulder">—</output></div>
            <div><span>Coude · attendu / réel</span><output data-rb="proprio-elbow">—</output></div>
            <div><span>Dérive nette</span><output data-rb="proprio-drift">—</output></div>
          </div>
        </div>
        <div class="rb-scale" data-rb="scale">
          <div class="rb-proprio-head">
            <strong>Pesée gravimétrique &amp; contrôle de prise</strong>
            <span data-rb="scale-state" role="status">Non taré</span>
          </div>
          <div class="rb-proprio-grid">
            <div><span>Masse estimée</span><output data-rb="scale-grams">— g</output></div>
            <div><span>Couple net (Δτ)</span><output data-rb="scale-delta">—</output></div>
            <div><span>Maintien d’objet</span><output data-rb="scale-grip">—</output></div>
          </div>
          <div class="rb-btn-row" data-cols="2">
            <button type="button" data-rb="scale-tare" data-help="Mémorise le couple à vide à cette pose pour estimer la masse en grammes d’un objet saisi.">Tarer à vide</button>
            <button type="button" data-rb="scale-reset" disabled data-help="Efface la tare gravimétrique enregistrée et revient au modèle nominal.">Effacer la tare</button>
          </div>
        </div>
        </details>
      </section>
      <section class="rb-card rb-workbench" data-section="workbench" aria-labelledby="rb-workbench-title">
        <div class="rb-card-head"><h2 id="rb-workbench-title">Atelier &amp; Automatisation</h2><span data-rb="wb-status" role="status">Prêt</span></div>
        <details class="rb-help rb-card-guide"><summary>Comprendre l’atelier</summary>
          <p class="rb-help-badges"><span class="is-safe">🟢 Générer / Charger en 3D = prépare le script sans bouger</span> <span class="is-live">🟠 Saisir, Présenter, Orienter, Exécuter = déplace le bras (armé)</span></p>
        </details>
        <div class="rb-wb-tabs rb-tabs" role="group" aria-label="Onglets atelier">
          <button type="button" data-wb-view="hand" aria-pressed="true">Présentation</button>
          <button type="button" data-wb-view="transfer" aria-pressed="false">Transfert</button>
          <button type="button" data-wb-view="pallet" aria-pressed="false">Palettisation</button>
        </div>
        <div class="rb-wb-block" data-wb-panel="hand">
          <div class="rb-wb-subhead"><strong>Troisième main d’atelier</strong><small>Maintien de pièce, présentation &amp; orientation</small></div>
          <div class="rb-btn-row" data-cols="3">
            <button type="button" class="rb-primary" data-rb="th-hold" disabled data-help="Ferme la pince jusqu’au seuil de couple pour maintenir une pièce sans l’écraser.">Saisir &amp; maintenir</button>
            <button type="button" data-rb="th-present" disabled data-help="Amène la pièce tenue face à l’opérateur pour souder, inspecter ou visser.">Présenter face</button>
            <button type="button" data-rb="th-release" disabled data-help="Ouvre la pince en douceur pour libérer la pièce tenue.">Ouvrir &amp; libérer</button>
          </div>
          <div class="rb-btn-row" data-cols="4">
            <button type="button" data-rb="th-rot-left" disabled data-help="Pivote la base de −25° par pas mesurés pour présenter un autre côté de la pièce.">Tourner −25°</button>
            <button type="button" data-rb="th-rot-right" disabled data-help="Pivote la base de +25° par pas mesurés pour présenter un autre côté de la pièce.">Tourner +25°</button>
            <button type="button" data-rb="th-tilt-up" disabled data-help="Incline le bras de +10° vers le haut en gardant la prise.">Incliner +10°</button>
            <button type="button" data-rb="th-tilt-down" disabled data-help="Incline le bras de −10° vers le bas en gardant la prise.">Incliner −10°</button>
          </div>
          <div class="rb-wb-checks">
            <label class="rb-check"><input type="checkbox" data-rb="th-tug"> Relâcher à la traction (tirer doucement la pièce ouvre la pince)</label>
            <label class="rb-check"><input type="checkbox" data-rb="touch-follow"> Guidage au toucher (pousser le bras déclenche un pas doux)</label>
          </div>
          <div class="rb-btn-row" data-cols="3">
            <button type="button" data-rb="teach-toggle" aria-pressed="false" data-help="Relâche le couple des moteurs (sans arrêt d’urgence) pour guider le bras à la main et capturer des points.">Mode libre (main)</button>
            <button type="button" data-rb="touch-capture" data-help="Ajoute la pose actuelle du bras comme nouveau point dans l’éditeur 3D (sans bouger).">Mémoriser ce point en 3D</button>
            <button type="button" data-rb="inspect-compose" data-help="Génère un balayage multi-angles de 5 points devant la caméra Tapo dans l’éditeur 3D.">Scan Tapo 5 angles (3D)</button>
          </div>
        </div>
        <details class="rb-wb-details" data-wb-panel="transfer" hidden>
          <summary>Transfert automatique Pick A → Place B</summary>
          <p class="rb-hint">Synthétise le cycle complet en 8 étapes : approche haute, descente linéaire, prise au couple, levage, transit lissé, pose et retrait.</p>
          <div class="rb-wb-grid">
            <label>Source (prise)<select data-rb="tx-source"><option value="__default_src">Zone A · X 240 · Y −90 · Z 75 mm</option><option value="__actual">Position actuelle du bras</option></select></label>
            <label>Destination (dépôt)<select data-rb="tx-dest"><option value="__default_dst">Zone B · X 240 · Y +90 · Z 75 mm</option><option value="__fields">Cible des champs</option></select></label>
            <label>Dégagement Z · mm<input data-rb="tx-clear" type="number" min="20" max="150" step="5" value="55"></label>
            <label>Pause prise · s<input data-rb="tx-dwell" type="number" min="0" max="5" step="0.2" value="0.6"></label>
          </div>
          <label class="rb-check rb-debug-toggle"><input type="checkbox" data-rb="debug-step-mode"> Mode pas-à-pas (pause avant chaque étape avec ajustement Z ±1 mm)</label>
          <div class="rb-step-debugger" data-rb="step-debugger" hidden>
            <strong data-rb="debug-label">Pause à l’étape 1</strong>
            <div class="rb-btn-row" data-cols="4">
              <button type="button" class="rb-primary" data-rb="debug-next">Étape suivante ▶</button>
              <button type="button" data-rb="debug-z-down">Z −1 mm</button>
              <button type="button" data-rb="debug-z-up">Z +1 mm</button>
              <button type="button" class="rb-danger-quiet" data-rb="debug-stop">Arrêter</button>
            </div>
          </div>
          <div class="rb-btn-row" data-cols="2">
            <button type="button" data-rb="tx-compose" data-help="Prépare et valide les 8 étapes du transfert A → B dans l’éditeur 3D sans déplacer le bras.">Générer dans l’éditeur 3D</button>
            <button type="button" class="rb-primary" data-rb="tx-run" disabled data-help="Exécute le cycle complet Pick A → Place B avec prise au contact (poste armé requis).">Exécuter Pick → Place</button>
          </div>
        </details>
        <details class="rb-wb-details" data-wb-panel="pallet" hidden>
          <summary>Palettisation en grille R×C &amp; Plateau de tri</summary>
          <p class="rb-hint">Calcule automatiquement chaque alvéole entre le coin A et le coin B en parcours serpentin.</p>
          <div class="rb-wb-grid">
            <label>Lignes (1–4)<input data-rb="pal-rows" type="number" min="1" max="4" step="1" value="2"></label>
            <label>Colonnes (1–4)<input data-rb="pal-cols" type="number" min="1" max="4" step="1" value="3"></label>
            <label>Coin A · X / Y mm<div class="rb-wb-pair"><input data-rb="pal-ax" type="number" step="5" value="200" aria-label="Coin A X"><input data-rb="pal-ay" type="number" step="5" value="-80" aria-label="Coin A Y"></div></label>
            <label>Coin B · X / Y mm<div class="rb-wb-pair"><input data-rb="pal-bx" type="number" step="5" value="290" aria-label="Coin B X"><input data-rb="pal-by" type="number" step="5" value="80" aria-label="Coin B Y"></div></label>
            <label>Hauteur plateau Z · mm<input data-rb="pal-z" type="number" min="30" max="320" step="5" value="70"></label>
            <label>Alvéole active<output data-rb="pal-cell-state">Cellule 1 / 6</output></label>
          </div>
          <div class="rb-pallet-map" data-rb="pal-map" role="group" aria-label="Carte interactive du plateau"></div>
          <div class="rb-btn-row" data-cols="3">
            <button type="button" data-rb="pal-compose" data-help="Génère toute la trajectoire serpentin du plateau R×C dans l’éditeur 3D sans déplacer le bras.">Charger la grille en 3D</button>
            <button type="button" data-rb="pal-next" disabled data-help="Déplace le bras vers la prochaine alvéole du plateau puis avance l’index actif.">Aller cellule suivante</button>
            <button type="button" class="rb-primary" data-rb="pal-fill" disabled data-help="Enchaîne Pick Source A → dépôt dans chaque alvéole restante du plateau R×C (compatible mode pas-à-pas).">Remplir tout le plateau</button>
          </div>
        </details>
      </section>
      <section class="rb-card rb-presets" data-section="presets" aria-labelledby="rb-presets-title">
        <div class="rb-card-head"><h2 id="rb-presets-title">Positions</h2></div>
        <div class="rb-preset-fields"><label>Position enregistrée<select data-rb="presets"><option value="">Choisir…</option></select></label>
          <label>Nom<input data-rb="preset-name" maxlength="64"></label></div>
        <div class="rb-btn-row" data-cols="2">
          <button type="button" data-rb="preset-preview" disabled>Charger</button>
          <button type="button" data-rb="preset-run" disabled>Exécuter</button>
        </div>
        <div class="rb-btn-row" data-cols="4">
          <button type="button" data-rb="preset-save" disabled>Enregistrer la cible</button>
          <button type="button" data-rb="preset-capture-actual" disabled title="Enregistrer directement la position actuelle du bras">Capturer le bras</button>
          <button type="button" data-rb="preset-rename" disabled>Renommer</button>
          <button type="button" class="rb-danger-quiet" data-rb="preset-delete" disabled>Supprimer</button>
        </div>
        <details class="rb-sequence" data-rb="sequence"><summary>Séquence de simulation</summary>
          <p class="rb-hint">Chaque étape est modifiable. Validez de nouveau après une modification.</p>
          <ol class="rb-seq-steps" data-rb="steps"></ol><div class="rb-btn-row" data-cols="4">
          <button type="button" data-rb="step-add">Ajouter la cible</button>
          <button type="button" data-rb="sequence-check">Valider</button>
          <button type="button" data-rb="sequence-run" disabled>Jouer une fois</button>
          <button type="button" class="rb-danger-quiet" data-rb="sequence-clear">Vider</button></div>
          <div class="rb-routine">
            <div class="rb-routine-load">
              <label>Routine enregistrée<select data-rb="routines"><option value="">Choisir…</option></select></label>
              <button type="button" data-rb="routine-load" disabled>Charger</button>
              <button type="button" data-rb="routine-delete" disabled>Supprimer</button>
            </div>
            <div class="rb-routine-save">              <label>Nom de la routine<input data-rb="routine-name" maxlength="64" placeholder="Ex. : balayage simulé"></label>
              <label>Décalage base · °<input data-rb="routine-base-delta" type="number" min="-20" max="20" step="1" value="0"></label>
              <label>Répétitions<input data-rb="routine-repeats" type="number" min="1" max="8" step="1" value="1"></label>
              <button type="button" data-rb="routine-save" disabled>Garder cette séquence</button></div>
            <p class="rb-hint">Routines de simulation : les étapes sont validées à l’enregistrement ; chaque validation ou lecture repasse par les contrôles de trajectoire.</p>
          </div></details>
      </section>
      <section class="rb-card rb-records" data-section="records" aria-labelledby="rb-records-title">
        <div class="rb-card-head"><h2 id="rb-records-title">Scripts enregistrés</h2><span data-rb="record-state" role="status">Aucun script</span></div>
        <div class="rb-record-tools"><label class="rb-record-search">Rechercher<input data-rb="record-search" type="search" placeholder="Nom ou tag" aria-label="Rechercher un script par nom ou tag"></label>
          <button type="button" data-rb="record-export">Exporter les scripts</button></div>
        <div class="rb-playback" data-rb="playback" role="group" aria-label="Progression de la lecture" hidden>
          <div class="rb-playback-head"><strong data-rb="playback-name"></strong><span data-rb="playback-step"></span></div>
          <div class="rb-playback-bar" aria-hidden="true"><i data-rb="playback-fill"></i></div>
          <div class="rb-playback-foot"><span data-rb="playback-elapsed"></span><span data-rb="playback-remaining"></span></div>
        </div>
        <div class="rb-btn-row" data-cols="auto">
          <button type="button" class="rb-primary" data-rb="record-start" disabled>Enregistrer un mouvement</button>
          <button type="button" data-rb="record-stop" hidden>Arrêter l’enregistrement</button>
          <button type="button" class="rb-danger-quiet" data-rb="record-discard" hidden>Effacer les poses</button>
        </div>
        <p class="rb-hint">Cliquez sur le plan XY : X et Y viennent du clic, Z et la pince du formulaire. En Matériel, le bras y va par petits pas mesurés, comme le retour au neutre.</p>
        <div class="rb-record-save" data-rb="record-save" hidden>
          <label>Nom du script<input data-rb="record-name" maxlength="64" placeholder="Ex. : balayage du plan"></label>
          <label>Tags<input data-rb="record-tags" maxlength="96" placeholder="plan, contrôle, démo"></label>
          <button type="button" class="rb-primary" data-rb="record-store" disabled>Garder ce script</button>
        </div>
        <div class="rb-record-list" data-rb="record-list"></div>
      </section>
      <section class="rb-card rb-library" data-section="library" aria-labelledby="rb-library-title" data-rb="library" hidden>
        <div class="rb-card-head"><h2 id="rb-library-title">Bibliothèque de scripts</h2>
          <div class="rb-tabs" role="group" aria-label="Filtrer les scripts">
            <button type="button" data-lib-filter="all" aria-pressed="true">Tous</button>
            <button type="button" data-lib-filter="approved" aria-pressed="false">Approuvés</button>
            <button type="button" data-lib-filter="stale" aria-pressed="false">Périmés</button>
          </div>
          <button type="button" class="rb-ghost-toggle" data-rb="library-ghosts" aria-pressed="false" hidden>Traces sur le plan</button>
          <button type="button" data-rb="library-rebase-all" hidden>Tout mettre à jour</button>
        </div>
        <div class="rb-record-tools">
          <label class="rb-record-search">Rechercher<input data-rb="library-search" type="search" placeholder="Nom ou résumé" aria-label="Rechercher dans la bibliothèque"></label>
          <button type="button" data-rb="library-export">Exporter JSON</button>
        </div>
        <div class="rb-library-list" data-rb="library-list"></div>
      </section>
      <details class="rb-card rb-config" data-section="config" id="robotics-settings"><summary>Réglages et calibration</summary>
        <p data-rb="settings-note"></p>
        <form data-rb="settings" autocomplete="off">
          <fieldset data-rb="settings-fields" disabled>
            <legend>Connexions</legend>
            <div class="rb-settings-grid">
              <label>Mode<select name="mode"><option value="simulation">Simulation</option><option value="hardware">Matériel</option></select></label>
              ${field('arm_ip', 'IPv4 / hôte du RoArm', 'maxlength="253" placeholder="192.168.x.x"')}
              ${field('arm_timeout', 'Délai RoArm · s', 'type="number" min=".2" max="1.5" step=".1" required')}
              ${field('camera_ip', 'IPv4 / hôte du Tapo', 'maxlength="253" placeholder="192.168.x.x"')}
              ${field('camera_user', 'Compte caméra', 'type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64"')}
              ${field('camera_password', 'Mot de passe caméra', 'type="password" autocomplete="new-password" maxlength="128"')}
              ${field('camera_cloud_password', 'Mot de passe Tapo (cloud) · infrarouge et micro', 'type="password" autocomplete="new-password" maxlength="128"')}
              ${field('camera_tls_sha256', 'Empreinte TLS Tapo · SHA-256', 'type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" placeholder="64 caractères hex (optionnel)"')}
              ${field('camera_timeout', 'Délai vidéo · s', 'type="number" min="2" max="12" step="1" required')}
              ${field('estop_ip', 'Moniteur E-stop · IPv4', 'maxlength="15" placeholder="192.168.x.x"')}
              ${field('estop_port', 'Port du moniteur E-stop', 'type="number" min="1" max="65535" step="1" required')}
              ${field('estop_token', 'Jeton du moniteur E-stop', 'type="password" autocomplete="new-password" maxlength="128"')}
              <label>Qualité par défaut<select name="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
              <label>Transport<select name="transport"><option value="http">HTTP LAN</option><option value="serial">USB Série (COM)</option></select></label>
              ${field('serial_port', 'Port série USB', 'maxlength="32" list="rb-serial-ports" placeholder="COM3"')}
              <datalist id="rb-serial-ports" data-rb="serial-ports"></datalist>
              <label class="rb-check"><input type="checkbox" name="camera_required"> Exiger le direct caméra pour armer</label>
              <label class="rb-check"><input type="checkbox" name="estop_required"> Exiger un E-stop surveillé pour armer</label>
              <label class="rb-check"><input type="checkbox" name="estop_require_signed"> Exiger une signature HMAC du moniteur E-stop</label>
              <label class="rb-check"><input type="checkbox" name="torque_telemetry_required"> Exiger la télémétrie de couple (torswitch)</label>
              <p class="rb-hint">Le moniteur doit répondre sur <code>GET /estop</code> par <code>{"closed":true}</code> (contact fermé = sain). HQ ne remplace pas la coupure physique.</p>
            </div>
            <details><summary>Limites du profil pince</summary>
              <div class="rb-tuning">${field('speed', 'Vitesse max. · pas/s', 'type="number" min="40" max="200" required')}
              ${field('acceleration', 'Accélération · 100 pas/s²', 'type="number" min="1" max="8" required')}
              ${field('step_limit', 'Amplitude physique max. · °', 'type="number" min="1" max="8" step="any" required')}
              ${field('load_warn', 'Charge · alerte (0–1000)', 'type="number" min="0" max="999" required')}
              ${field('load_critical', 'Charge · critique (0–1000)', 'type="number" min="1" max="1000" required')}</div>
              <div class="rb-settings-grid">${limits(axes)}${limits({ x: 'X · mm', y: 'Y · mm', z: 'Z · mm' })}</div>
            </details>
            <div class="rb-keepout" data-rb="keepout">
              <p class="rb-hint">Les zones d’exclusion se définissent dans le moniteur <strong>3D</strong> (bouton Zones d’exclusion). La liste ci-dessous reste synchronisée pour l’enregistrement des réglages.</p>
              <div class="rb-btn-row" data-cols="auto">
                <button type="button" data-rb="keepout-edit-3d">Éditer dans le moniteur 3D</button>
                <button type="button" data-rb="keepout-add" hidden aria-hidden="true" tabindex="-1">Ajouter une zone</button>
              </div>
              <div class="rb-keepout-rows" data-rb="keepout-rows" hidden></div>
            </div>
            <div class="rb-btn-row" data-cols="auto"><button type="submit" class="rb-primary">Enregistrer les réglages</button>
            <button type="button" data-rb="forget-camera">Effacer le compte caméra</button></div>
          </fieldset>
        </form>
        <label class="rb-check rb-keyjog"><input type="checkbox" data-rb="keyjog"> Pilotage au clavier sur ce navigateur : un pas par appui, seulement quand le poste est armé (Q/A, W/S, E/D, R/F). Échap désarme toujours.</label>
        <label class="rb-check rb-padjog"><input type="checkbox" data-rb="padjog"> Pilotage manette / SpaceMouse sur ce navigateur : maintien de L1/LB requis (homme-mort) ; relâcher L1 désarme immédiatement.</label>
        <details class="rb-commission-guide" data-rb="commission-guide">
          <summary>Mise en service guidée · simulation</summary>
          <p class="rb-hint">Contrôles logiciels seulement : aucune vérification de direction, de couple, de caméra ou d’arrêt physique n’est possible sans matériel. Utilisez ce guide avant une mise en service réelle, puis refaites les tests sur le bras.</p>
          <ol class="rb-commission-steps">
            <li data-commission-step="limits"><span>Enveloppe, limites articulaires et neutre</span><button type="button" data-commission-check="limits">Vérifier</button><output data-commission-output="limits">—</output></li>
            <li data-commission-step="path"><span>Validation d’une petite trajectoire</span><button type="button" data-commission-check="path">Vérifier</button><output data-commission-output="path">—</output></li>
            <li data-commission-step="camera"><span>Caméra / flux requis</span><button type="button" data-commission-check="camera">Vérifier</button><output data-commission-output="camera">—</output></li>
            <li data-commission-step="estop"><span>Arrêt d’urgence surveillé</span><button type="button" data-commission-check="estop">Vérifier</button><output data-commission-output="estop">—</output></li>
          </ol>
          <div class="rb-btn-row" data-cols="auto">
            <button type="button" class="rb-primary" data-rb="commission-all">Vérifier les contrôles</button>
            <button type="button" data-rb="commission-export">Exporter le rapport (.md)</button>
          </div>
          <p data-rb="commission-status" role="status"></p>
        </details>
      </details>
      <details class="rb-card rb-history" data-section="history"><summary>Journal des commandes</summary><ol data-rb="history"></ol>
        <div class="rb-blackbox"><button type="button" data-rb="blackbox-replay">Rejouer en 3D</button>
        <button type="button" data-rb="blackbox-export">Exporter le journal noir</button>
        <span data-rb="blackbox-state" role="status">Échantillonnage local · 1 s</span></div></details>
    </div>
    <div class="rb-message" data-rb="message-box" hidden><p data-rb="message" role="status" aria-live="polite"></p>
      <button type="button" class="rb-message-close rb-icon-button" data-rb="message-close" aria-label="Fermer le message">${svg('x')}</button></div>`;

  class Lab {
    constructor(host, api) {
      this.host = host;
      this.api = api;
      this.generation = 0;
      this.active = false;
      this.mode = 'joints';
      this.steps = [];
      this.jog = null;
      this.plotDrag = null;
      this.plotClickGuard = 0;
      this.dragTimer = null;
      this.dragStepPromise = null;
      this.dragNextAt = 0;
      this.dragFinish = 0;
      this.stream = null;
      this.audio = null;
      this.lease = '';
      this.leaseDeadline = 0;
      this.recording = null;
      this.recordDraft = null;
      this.recordings = {};
      this.recordFilter = '';
      this.routines = {};
      this.loadTrend = [];
      this.loadPeaks = Object.fromEntries(axisKeys.map(key => [key, 0]));
      this.commission = {};
      this.editing = null;
      this.trace = null;
      this.playback = null;
      this.playingScript = false;
      this.homing = false;
      this.homingView = null;
      this.libraryTraces = [];
      this.ghostLibrary = false;
      this.motionGeneration = 0;
      this.pending = false;
      this.previewVersion = 0;
      this.monitor = 'position';
      this.cameraMap = null;
      this.calPixels = {};
      this.calibrating = null;
      this.flightOpen = false;
      this.flightEntries = [];
      this.flightIndex = -1;
      this.flightPlaying = false;
      this.flightTimer = null;
      this.padJog = false;
      this.padDeadmanHeld = false;
      this.padNextAt = 0;
      this.padTimer = null;
      host.innerHTML = markup;
      this.nodes = Object.fromEntries([...host.querySelectorAll('[data-rb]')].map(el => [el.dataset.rb, el]));
      this.form = this.nodes.pose.elements;
      this.bind();
      const head = host.querySelector('.rb-head');
      const strip = host.querySelector('.rb-status');
      if (head && strip && 'IntersectionObserver' in window) {
        new IntersectionObserver(([entry]) => strip.classList.toggle('rb-compact', !entry.isIntersecting && entry.boundingClientRect.top < 0))
          .observe(head);
      }
      this.loadCameraMap();
      this.selectMode('joints');
      this.monitorBase = 'position';
      this.monitorLayout = 'single';
      this.lastSection = 'camera';
      this.sectionOverview = false;
      try {
        const saved = localStorage.getItem('hq_robotics_section_v1');
        if (saved === 'all') this.selectSection('all', { scroll: false });
        else if (saved) this.selectSection(saved, { scroll: false });
        else this.selectSection('camera', { scroll: false });
      } catch (_) {
        this.selectSection('camera', { scroll: false });
      }
      this.syncMonitorLayoutUi();
    }

    request(path, body, { keepalive = false, headers: extra = null } = {}) {
      const headers = { ...(this.lease ? { 'X-HQ-Robotics-Lease': this.lease } : {}), ...(extra || {}) };
      if (body === undefined) return this.api(prefix + path, { headers, timeoutMs: 5000 });
      headers['Content-Type'] = 'application/json';
      return this.api(prefix + path, { method: 'POST', headers, keepalive, body: JSON.stringify(body), timeoutMs: 7000 });
    }

    message(text, error = false) {
      this.nodes.message.textContent = text;
      this.nodes['message-box'].hidden = !text;
      this.nodes['message-box'].classList.toggle('rb-error', !!text && error);
      // A refused or locked camera account also shows in the status strip until a camera action succeeds.
      if (error && /Compte caméra refusé|caméra suspendue/.test(text)) {
        this.cameraAuthError = text;
        if (this.state) this.render(this.state);
      }
      if (error && text) this.updateCopilot(this.state, text);
    }

    cameraOk() {
      if (!this.cameraAuthError) return;
      if (this.nodes.message.textContent === this.cameraAuthError) this.message('');
      this.cameraAuthError = '';
    }

    async run(work) {
      const generation = this.generation;
      try { return await work(); }
      catch (error) {
        if (generation !== this.generation) return;
        if ([401, 403, 423].includes(error.status)) this.release();
        // A server refusal carries a status and a message written for the operator. Anything else is a
        // page fault (TypeError, missing state): the stack belongs in the console, not in the banner.
        if (!error?.status && !error?.code) {
          console.error('[robotics]', error);
          this.message('Action impossible : une erreur interne de la page est survenue. Réessayez, ou rechargez Robotique.', true);
          return;
        }
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
      const sectionNav = this.host.querySelector('.rb-section-nav');
      if (sectionNav) {
        listen(sectionNav, 'scroll', () => this.syncSectionNav(), { passive: true });
        listen(window, 'resize', () => this.syncSectionNav());
        const more = this.host.querySelector('[data-rb="section-more"]');
        if (more) listen(more, 'click', () => {
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          sectionNav.scrollBy({ left: sectionNav.clientWidth * .8, behavior: reduced ? 'auto' : 'smooth' });
        });
      }
      this.syncSectionNav();
      const scheme = window.matchMedia?.('(prefers-color-scheme: light)');
      if (scheme?.addEventListener) {
        const redraw = () => this.drawPosition();
        scheme.addEventListener('change', redraw);
        this.lifecycle.signal.addEventListener('abort', () => scheme.removeEventListener('change', redraw),
          { once: true });
      }
      // Every move already requires focus (see move()). Losing focus only disarms when a step,
      // a script or a press is under way; otherwise the 20 s lease lapses on its own.
      listen(window, 'blur', () => {
        this.cancelPlotDrag();
        if (this.audio?.microphone) this.stopAudio();
        if (!this.lease) return;
        if (!(this.pending || this.state?.moving || this.playingScript || this.jog)) return;
        this.message('Autorisation relâchée : la fenêtre a perdu le focus pendant un mouvement. Armez de nouveau.');
        this.release();
      });
      // A reload or navigation must not leave the post armed: release the lease before the page
      // goes away, or the next page sees it as driven by another tab until the TTL lapses.
      listen(window, 'pagehide', () => { this.release(); this.hide(); });
      listen(window, 'offline', () => { this.release(); this.stopVideo(); });
      listen(window, 'keydown', event => this.editorKeys(event));
      listen(window, 'keydown', event => this.keyJogEvent(event, true));
      listen(window, 'keyup', event => this.keyJogEvent(event, false));
      // Escape releases the arming without latching: the reversible counterpart of STOP.
      listen(window, 'keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !this.lease) return;
        if (document.fullscreenElement) return;  // Escape leaves fullscreen first.
        if (event.target.closest?.('input, textarea, select')) return;
        if (document.querySelector('.rb-ai-chat:not([hidden])')) return;
        event.preventDefault();
        this.release();
        this.message('Autorisation relâchée. Armez de nouveau pour déplacer le bras.');
      });
      listen(document, 'visibilitychange', () => {
        if (document.hidden) {
          clearTimeout(this.pollTimer);
          if (this.lease) this.message('Autorisation relâchée : la page est passée en arrière-plan. Armez de nouveau.');
          this.release();
          this.stopVideo();
        } else this.schedule(0);
      });
      listen(window, 'hq:session-role', () => {
        if (!document.body.classList.contains('session-admin')) this.hide();
      });
      this.statusSig = '';
      this.run(() => this.bootstrap());
      if (this.padJog && !this.padTimer) this.padTimer = setInterval(() => this.pollGamepad(), 120);
      const bootSecondary = setTimeout(() => {
        if (!this.active) return;
        this.mountAssistant();
      }, 0);
      this.lifecycle.signal.addEventListener('abort', () => clearTimeout(bootSecondary), { once: true });
    }

    hide() {
      if (!this.active) return;
      this.active = false;
      this.assistant?.hide();
      this.generation++;
      this.lifecycle.abort();
      clearTimeout(this.pollTimer);
      clearInterval(this.padTimer);
      this.padTimer = null;
      this.padDeadmanHeld = false;
      this.stopFlightPlay();
      this.flightOpen = false;
      if (this.nodes.flight) this.nodes.flight.hidden = true;
      if (this.nodes['flight-toggle']) {
        this.nodes['flight-toggle'].setAttribute('aria-pressed', 'false');
        this.nodes['flight-toggle'].textContent = 'Journal noir 3D';
      }
      this.toggleShortcuts(false);
      this.poseHistory = [];
      if (this.nodes['pose-undo']) this.nodes['pose-undo'].disabled = true;
      cancelAnimationFrame(this.visualFrame);
      this.visualFrame = 0;
      this.visualPose = null;
      this.visualLastAt = 0;
      this.chaining = false;
      this.stopSpacePlayback?.();
      this.stopSpacePlayback = null;
      clearInterval(this.motionTimer);
      this.motionTimer = null;
      this.motionClock = null;
      this.spacePlaying = false;
      this.zonesOpen = false;
      this.zoneDraft = null;
      this.nodes.zones.hidden = true;
      this.nodes['zones-toggle'].setAttribute('aria-pressed', 'false');
      this.nodes['zones-toggle'].textContent = 'Zones d’exclusion';
      this.clearConfirm();
      this.release();
      this.stopVideo();
      this.state = null;
      this.statusSig = '';
      this._posStatic = null;
      this._sideStatic = null;
      this._historyKey = null;
      this._recPlayDisabled = null;
      this._recDelDisabled = null;
      this.clearPreview();
      this.revision = null;
      this.havePoseFeedback = false;
      this.recording = null;
      this.recordDraft = null;
      this.recordFilter = '';
      this.editing = null;
      this.routines = {};
      this.loadTrend = [];
      this.loadPeaks = Object.fromEntries(axisKeys.map(key => [key, 0]));
      this.commission = {};
      this.trace = null;
      this.playback = null;
      this.homing = false;
      this.homingView = null;
      this.libraryTraces = [];
      this.ghostLibrary = false;
      this.calibrating = null;
      this.nodes['camera-overlay'].hidden = true;
      this.nodes['library-ghosts'].hidden = true;
      this.nodes['plot-ghosts'].hidden = true;
      this.nodes['record-name'].value = '';
      this.nodes['settings-fields'].disabled = true;
      this.nodes['video-start'].disabled = true;
      this.nodes['video-hint'].textContent = '';
      this.nodes['video-idle'].querySelector('strong').textContent = 'Caméra en veille';
      this.message('');
      this.clearPasswords();
      this.controls();
    }

    async bootstrap() {
      const generation = this.generation;
      try {
        const data = await this.request('bootstrap');
        if (this.generation !== generation || !this.active) return;
        if (data.presets) { this.presets = data.presets; this.renderPresets(); }
        if (data.recordings) { this.recordings = data.recordings; this.renderRecordings(); }
        if (data.routines) { this.routines = data.routines; this.renderRoutines(); }
        this.statusSig = data.sig || '';
        this.pollFailures = 0;
        this.render(data);
        const chained = !!(this.playingScript || this.homing || this.chaining || this.plotDrag);
        const delay = data.moving ? (data.config.mode === 'hardware' ? (chained ? 130 : 320) : 140) :
          data.teach_mode ? 280 :
          (this.lease || data.feedback?.source === 'hardware' || this.stream ? 1000 : 6500);
        this.schedule(delay);
      } catch (_) {
        if (this.generation === generation && this.active) this.schedule(0);
      }
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
        const useTelemetry = this.state?.config.mode === 'hardware' && this.telemetryEnabled && !this.pending;
        const reply = await this.request(
          useTelemetry ? 'telemetry' : 'status',
          useTelemetry ? { lease: this.lease } : undefined,
          !useTelemetry && this.statusSig ? { headers: { 'X-HQ-Robotics-Sig': this.statusSig } } : undefined,
        );
        if (this.generation !== generation || !this.active) return;
        this.pollFailures = 0;
        let state = this.state;
        if (reply.unchanged && this.state) {
          this.statusSig = reply.sig || this.statusSig;
        } else {
          state = reply;
          if (!useTelemetry && reply.sig) this.statusSig = reply.sig;
          else if (useTelemetry) this.statusSig = '';
          this.render(state);
        }
        const chained = !!(this.playingScript || this.homing || this.chaining || this.plotDrag);
        delay = state?.moving ? (state.config.mode === 'hardware' ? (chained ? 130 : 320) : 140) :
          state?.teach_mode ? 280 :
          (this.lease || state?.feedback?.source === 'hardware' || this.stream ? 1000 : 6500);
      } catch (error) {
        if (this.generation !== generation) return;
        if (error.status === 429) { delay = 650; return; }
        // A single missed reply on a weak link must not drop the arming. The server
        // applies the same grace to idle telemetry reads.
        this.pollFailures = (this.pollFailures || 0) + 1;
        const fatal = [401, 403, 423].includes(error.status);
        if (!fatal && this.pollFailures < 3) {
          this.message(error.message, true);
          delay = 1000;
          return;
        }
        this.telemetryEnabled = false;
        this.release();
        if (fatal) {
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
      let worstLoad = 0;
      const hasLoad = Object.keys(state.feedback?.load || {}).length > 0;
      this.state = state;
      this.assistant?.observe(state);
      const sim = state.config.mode === 'simulation';
      if (!this.monitorChosen && previousMode !== state.config.mode) this.selectMonitor(sim ? 'position' : 'camera');
      if (this.lease && !state.armed && !this.arming) this.release();
      const text = (key, value) => {
        if (this.nodes[key].textContent !== value) this.nodes[key].textContent = value;
      };
      const estop = state.estop || {};
      const estopMode = estop.mode;
      const estopBlocked = !sim && ((estopMode === 'hardware' && estop.healthy !== true) ||
        (estopMode !== 'hardware' && state.config.estop_required === true));
      text('estop', sim ? 'E-stop simulé' : (estopMode === 'hardware' ?
        (estop.healthy === true ? 'E-stop surveillé' : 'E-stop ouvert') : 'E-stop non surveillé'));
      this.nodes.estop.dataset.state = sim ? 'sim' : (estopMode === 'hardware' && estop.healthy === true ? 'ok' : 'warn');
      text('mode', sim ? 'Simulation' : 'Matériel');
      text('arm-state', sim ? 'Virtuel' : (state.feedback ? 'Connecté' : 'Sans retour'));
      this.motionClock = state.moving && state.motion
        ? { t0: performance.now() - state.motion.elapsed * 1000, seconds: state.motion.seconds } : null;
      this.renderMotionProgress();
      if (state.camera_live) this.cameraOk();
      const cameraAuth = !state.camera_live && this.cameraAuthError;
      text('camera-state', state.camera_live ? 'En direct' : (cameraAuth ? (/suspendue/.test(cameraAuth) ?
        'Connexion suspendue' : 'Compte refusé') : (this.stream ? 'Connexion…' :
        (state.config.camera_configured ? 'En veille' : 'À configurer'))));
      this.nodes['camera-state'].dataset.state = state.camera_live ? 'live' : (cameraAuth ? 'warn' : '');
      this.nodes['camera-state'].title = cameraAuth || '';
      text('safety', state.stop_latched || state.uncertain ? 'Inspection requise' :
        (state.armed ? 'Armé' : (state.occupied ? 'Poste occupé' : 'Désarmé')));
      this.nodes.safety.dataset.state = state.stop_latched || state.uncertain ? 'stop' : (state.armed ? 'armed' : '');
      // The latch is a state, not a failed request, so say why it is set instead of leaving a stale message.
      const latched = !!(state.stop_latched || state.uncertain);
      if (latched && !this.wasLatched) {
        const cause = state.history.find(event => ['uncertain', 'stopped', 'feedback_failed'].includes(event.kind));
        this.message('Inspection requise' + (cause ? ' après « ' + cause.label + ' » à ' +
          new Date(cause.at * 1000).toLocaleTimeString() : '') +
          '. Vérifiez le bras sur place, puis cliquez sur Réinitialiser. L’état est conservé après un redémarrage.', true);
      } else if (!latched && this.wasLatched) {
        this.message('');
      }
      this.wasLatched = latched;
      text('hud-latency', sim ? '— ms' : (state.latency_ms == null ? '— ms' : state.latency_ms + ' ms'));
      const at = state.last_feedback ? new Date(state.last_feedback * 1000).toLocaleTimeString() : '';
      text('feedback-state', sim ? 'Retour simulé' : (at ? [at, state.latency_ms == null ? '' : state.latency_ms + ' ms'].filter(Boolean).join(' · ') : 'Pas de retour'));
      text('actual-label', sim ? 'Simulé' : 'Mesuré');
      for (const key of axisKeys) {
        const actual = state.feedback?.actual?.[key];
        const target = state.target?.[key];
        text('actual-' + key, format(actual, '°'));
        text('target-' + key, format(target, '°'));
        const delta = Number.isFinite(actual) && Number.isFinite(target) ? target - actual : null;
        const deltaNode = this.nodes['delta-' + key];
        text('delta-' + key, Number.isFinite(delta)
          ? (delta > 0 ? '+' : '') + format(delta, '°')
          : '—');
        deltaNode.classList.toggle('is-off', Number.isFinite(delta) && Math.abs(delta) > 1);
        const load = state.feedback?.load?.[key];
        text('load-value-' + key, format(load));
        const fill = this.nodes['load-fill-' + key];
        const magnitude = Number.isFinite(load) ? Math.min(100, Math.abs(load) / LOAD_FULL_SCALE * 100) : 0;
        if (Number.isFinite(load)) {
          this.loadPeaks[key] = Math.max(this.loadPeaks[key] || 0, Math.abs(load));
          worstLoad = Math.max(worstLoad, Math.abs(load));
        }
        const warn = state.config.load_warn ?? 700;
        const critical = state.config.load_critical ?? 900;
        fill.style.width = magnitude.toFixed(1) + '%';
        fill.classList.toggle('is-high', Number.isFinite(load) && Math.abs(load) >= warn);
        fill.classList.toggle('is-critical', Number.isFinite(load) && Math.abs(load) >= critical);
        fill.classList.toggle('is-negative', Number.isFinite(load) && load < 0);
        this.nodes['load-' + key].title = Number.isFinite(load)
          ? 'Charge brute : ' + load + ' · alerte ' + warn + ' · critique ' + critical + ' · pic ' + this.loadPeaks[key]
          : 'Charge indisponible';
      }
      this.renderLoadWatch(hasLoad ? worstLoad : null);
      this.renderProprioception(state);
      this.renderScaleAndWorkbench(state);
      for (const axis of ['x', 'y', 'z']) {
        text('position-' + axis, format(state.feedback?.xyz[axis]));
        text('hud-' + axis, format(state.feedback?.xyz[axis]));
      }
      text('plot-source', sim ? 'Simulation' : (state.feedback ? 'Mesuré' : 'Sans retour'));
      text('voltage', 'Tension ' + format(state.feedback?.voltage, ' V'));
      this.nodes.electrical.hidden = sim || !Number.isFinite(state.feedback?.voltage);
      this.nodes['hardware-note'].hidden = sim;
      let interlock;
      let actionKey = '';
      let actionLabel = '';
      if (state.stop_latched || state.uncertain) {
        interlock = 'Vérifiez le poste avant de réinitialiser.';
        if ( sim || state.physical_local) { actionKey = 'reset'; actionLabel = 'Réinitialiser maintenant'; }
      } else if (state.armed) interlock = 'Les commandes de mouvement sont actives.';
      else if (sim) {
        interlock = 'Armez le simulateur pour déplacer le bras.';
        if (!state.occupied && !this.lease) { actionKey = 'arm'; actionLabel = 'Armer le simulateur'; }
      } else if (!state.physical_local) interlock = 'Pilotage physique : ouvrez HQ sur le PC hôte à l’adresse http://127.0.0.1:8765/#robotique (ni IP du réseau, ni Tailscale, ni proxy).';
      else if (!state.commissioned) interlock = 'Mise en service physique requise.';
      else if (estopBlocked) {
        interlock = estopMode === 'hardware' ? 'E-stop ouvert ou moniteur injoignable.' : 'Configurez un moniteur E-stop pour armer.';
        actionKey = 'estop'; actionLabel = 'Ouvrir E-stop';
      } else if (!state.camera_live && state.config.camera_required !== false) {
        interlock = 'Démarrez la vidéo pour armer.';
        if (state.camera_local && state.gateway && state.config.camera_configured) {
          actionKey = 'camera'; actionLabel = 'Démarrer le direct';
        }
      } else if (!state.feedback) {
        interlock = 'Cliquez sur Lire le RoArm pour actualiser son état.';
        if (state.config.arm_ip) { actionKey = 'probe'; actionLabel = 'Lire le RoArm'; }
      } else {
        interlock = 'Armez le poste en gardant le bras en vue.';
        if (!state.occupied && !this.lease) { actionKey = 'arm'; actionLabel = 'Armer le poste'; }
      }
      text('interlock', interlock);
      this.interlockAction = actionKey;
      if (this.nodes['interlock-action']) {
        this.nodes['interlock-action'].hidden = !actionKey;
        if (actionKey && this.nodes['interlock-action'].textContent !== actionLabel) {
          this.nodes['interlock-action'].textContent = actionLabel;
        }
      }
      this.renderCommission(state, estopMode, estop);
      // No reading yet: one line and a button instead of a table of dashes.
      const noTelemetry = !sim && !state.feedback && !state.last_feedback;
      this.nodes['telemetry-empty'].hidden = !noTelemetry;
      this.host.querySelector('.rb-telemetry').classList.toggle('is-empty', noTelemetry);
      const canProbe = !sim && state.physical_local && !!state.config.arm_ip;
      this.nodes['telemetry-probe'].hidden = !canProbe;
      this.nodes['commission-probe'].hidden = !canProbe;
      text('video-hint', !state.camera_local ? 'Accès réseau local direct requis.' : (!state.gateway ?
        'La passerelle vidéo est indisponible sur le PC HQ.' : (!state.config.camera_configured ?
          'Renseignez le compte caméra dans les réglages.' : '')));
      this.nodes['camera-setup'].hidden = !state.physical_local || !state.gateway || state.config.camera_configured;
      if (state.camera_error && !this.stream) this.videoNote(state.camera_error);
      this.nodes['settings-fields'].disabled = !state.physical_local;
      text('settings-note', state.physical_local ? 'Les identifiants existants sont conservés si les champs restent vides.' :
        'Ouvrez HQ sur le PC hôte pour modifier les réglages.');
      this.nodes.sequence.hidden = !sim;
      const historyKey = state.history.map(event => `${event.at}:${event.label}`).join('|');
      if (this._historyKey !== historyKey) {
        this._historyKey = historyKey;
        this.nodes.history.replaceChildren(...state.history.map(event => {
          const li = document.createElement('li');
          li.textContent = new Date(event.at * 1000).toLocaleTimeString() + ' · ' + event.label;
          return li;
        }));
      }
      if (this.revision !== state.config.revision) {
        this.clearPreview();
        this.revision = state.config.revision;
        this.fillSettings(state.config);
        this.pilotFields(state.feedback?.actual || { base: 0, shoulder: 0, elbow: 90, hand: 180 }, state.feedback?.xyz);
      } else if (state.feedback && !this.havePoseFeedback) {
        this.pilotFields(state.feedback.actual, state.feedback.xyz);
      }
      if (state.feedback) this.havePoseFeedback = true;
      this.syncVisualSmooth(state);
      this.pilotAids();
      // Without a reading the fields hold the neutral defaults, not the arm's pose: say so.
      this.nodes['pose-note'].hidden = state.config.mode !== 'hardware' || this.havePoseFeedback;
      this.drawPosition();
      this.drawCameraOverlay();
      this.controls();
      this.updateCopilot(state);
    }

    controls() {
      const state = this.state;
      const motion = this.motionLabel();
      if (this.nodes['motion-state'].textContent !== motion) this.nodes['motion-state'].textContent = motion;
      this.nodes['motion-state'].dataset.state = state?.moving ? 'moving' : '';
      this.nodes.motion.setAttribute('aria-busy', String(!!(this.pending || state?.moving)));
      const hw = state?.config.mode === 'hardware';
      const local = !!state && (!hw || state.physical_local);
      const stop = !!state && (state.stop_latched || state.uncertain);
      const estopReady = !hw || ((state.estop?.mode === 'hardware' && state.estop.healthy === true) ||
        (state.estop?.mode === 'unmonitored' && state.config.estop_required !== true));
      const ready = local && !stop && !state.moving && estopReady &&
        (!hw || (state.commissioned && state.feedback && (state.camera_live || state.config.camera_required === false)));
      const armed = ready && !!this.lease && !!state.ticket && state.armed && !this.pending && !this.playingScript;
      this.nodes.arm.disabled = !ready || !!this.lease || state.occupied || this.arming;
      this.nodes.cancel.disabled = !this.lease && !this.arming && !this.pending;
      this.nodes.stop.disabled = !local;
      this.nodes['stop-hud'].disabled = this.nodes.stop.disabled;
      this.nodes['video-hud'].hidden = !this.stream;
      const lease = this.lease && state?.armed && this.leaseDeadline
        ? Math.max(0, Math.ceil((this.leaseDeadline - performance.now()) / 1000)) : 0;
      this.nodes.lease.hidden = !lease;
      if (this.nodes['lease-renew']) {
        this.nodes['lease-renew'].hidden = !lease;
        this.nodes['lease-renew'].disabled = !lease || this.pending;
      }
      if (lease) {
        this.syncLeaseBar();
        if (!this.leaseTimer) {
          this.leaseTimer = setInterval(() => {
            if (!this.active || !this.lease || !this.state?.armed || !this.leaseDeadline) {
              clearInterval(this.leaseTimer);
              this.leaseTimer = null;
              return;
            }
            this.syncLeaseBar();
          }, 1000);
        }
      } else if (this.leaseTimer) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
      }
      const record = this.recording
        ? 'Enregistrement · ' + this.recording.steps.length + ' pose(s)'
        : (this.recordDraft ? 'Prêt à garder'
          : (Object.keys(this.recordings || {}).length ? Object.keys(this.recordings).length + ' script(s)' : 'Aucun script'));
      if (this.nodes['record-state'].textContent !== record) this.nodes['record-state'].textContent = record;
      this.nodes['record-start'].disabled = !armed || !!this.recording || !!this.editing;
      this.nodes['record-start'].hidden = !!this.recording;
      this.nodes['record-stop'].hidden = !this.recording;
      this.nodes['record-discard'].hidden = !this.recording || !this.recording.steps.length;
      this.nodes['record-save'].hidden = !this.recordDraft;
      this.nodes['record-store'].disabled = !this.recordDraft || !this.nodes['record-name'].value.trim();
      this.nodes.plot.classList.toggle('is-aim', !!state);
      const recPlayDisabled = !armed || this.playingScript || !!this.editing;
      if (this._recPlayDisabled !== recPlayDisabled) {
        this._recPlayDisabled = recPlayDisabled;
        this.host.querySelectorAll('[data-record-play]').forEach(button => {
          button.disabled = recPlayDisabled;
        });
      }
      const recDelDisabled = !state || this.playingScript || !!this.editing;
      if (this._recDelDisabled !== recDelDisabled) {
        this._recDelDisabled = recDelDisabled;
        this.host.querySelectorAll('[data-record-delete]').forEach(button => {
          button.disabled = recDelDisabled;
        });
      }
      this.host.querySelectorAll('[data-record-edit]').forEach(button => {
        button.disabled = !state || this.playingScript || !!this.editing;
      });
      this.host.querySelectorAll('[data-record-trace]').forEach(button => {
        button.disabled = !state || this.playingScript || !!this.editing;
      });
      this.renderPlayback();
      this.renderHoming();
      const routineId = this.nodes.routines?.value;
      this.nodes['routine-load'].disabled = !routineId;
      this.nodes['routine-delete'].disabled = !routineId;
      const routineName = this.nodes['routine-name']?.value.trim();
      this.nodes['routine-save'].disabled = !state || !this.steps.length || !routineName;
      this.nodes.reset.hidden = !stop || !local;
      this.nodes.probe.hidden = !hw || !state.physical_local || !state.config.arm_ip;
      this.nodes.probe.disabled = this.pending;
      const setLockHint = (node, locked, reason) => {
        if (!node) return;
        if (!node.dataset.baseHelp && node.dataset.help) node.dataset.baseHelp = node.dataset.help;
        if (locked && reason) {
          node.dataset.help = reason;
          if (node.title !== reason) node.title = reason;
        } else {
          if (node.dataset.baseHelp) node.dataset.help = node.dataset.baseHelp;
          if (node.title && node.title.startsWith('Verrouillé')) node.title = '';
        }
      };
      const armReason = !state ? 'Verrouillé : chargement de l’état du poste…'
        : stop ? 'Verrouillé : inspection physique requise — cliquez sur Réinitialiser après vérification.'
        : !local ? 'Verrouillé : ouvrez HQ sur le PC hôte (http://127.0.0.1:8765/#robotique).'
        : !estopReady ? 'Verrouillé : E-stop ouvert ou non configuré — vérifiez l’arrêt d’urgence.'
        : (hw && !state.commissioned) ? 'Verrouillé : mise en service physique requise.'
        : (hw && !state.feedback) ? 'Verrouillé : cliquez d’abord sur « Lire le RoArm ».'
        : (hw && !state.camera_live && state.config.camera_required !== false) ? 'Verrouillé : démarrez le direct caméra pour armer.'
        : state.moving ? 'Verrouillé : un mouvement est déjà en cours.'
        : 'Verrouillé : armez d’abord le poste (bouton Armer) pour autoriser un mouvement.';
      for (const key of ['move', 'home', 'home-direct', 'preset-run', 'sequence-run', 'grasp-run',
        'th-hold', 'th-present', 'th-release', 'th-rot-left', 'th-rot-right', 'th-tilt-up', 'th-tilt-down',
        'tx-run', 'pal-next', 'pal-fill']) {
        if (this.nodes[key]) {
          this.nodes[key].disabled = !armed;
          setLockHint(this.nodes[key], !armed, armed ? '' : (this.pending ? 'Verrouillé : commande en cours d’envoi…' : this.playingScript ? 'Verrouillé : lecture d’un script en cours…' : armReason));
        }
      }
      setLockHint(this.nodes.arm, this.nodes.arm.disabled, this.lease ? 'Déjà armé (bail actif).' : state?.occupied ? 'Verrouillé : un autre onglet pilote déjà le poste.' : armReason);
      setLockHint(this.nodes.cancel, this.nodes.cancel.disabled, 'Inactif : aucun bail d’armement ou mouvement en cours.');
      if (this.nodes['scale-tare']) {
        this.nodes['scale-tare'].disabled = !state?.feedback?.actual;
        setLockHint(this.nodes['scale-tare'], this.nodes['scale-tare'].disabled, 'Verrouillé : aucune lecture du bras disponible pour tarer.');
      }
      if (this.nodes['scale-reset']) {
        this.nodes['scale-reset'].disabled = !this.scaleTare;
        setLockHint(this.nodes['scale-reset'], this.nodes['scale-reset'].disabled, 'Inactif : aucune tare gravimétrique enregistrée.');
      }
      this.nodes.preview.disabled = !state;
      this.nodes['preset-run'].disabled = !armed || !this.nodes.presets.value;
      if (this.nodes['status-disarm']) {
        this.nodes['status-disarm'].hidden = !this.lease;
        this.nodes['status-disarm'].disabled = !this.lease;
      }
      if (this.nodes['status-home']) {
        this.nodes['status-home'].hidden = !this.lease;
        this.nodes['status-home'].disabled = !armed;
      }
      setLockHint(this.nodes['preset-run'], this.nodes['preset-run'].disabled, !this.nodes.presets.value ? 'Verrouillé : choisissez d’abord une position enregistrée.' : armReason);
      for (const key of ['preset-preview', 'preset-delete']) this.nodes[key].disabled = !state || !this.nodes.presets.value;
      const hasName = !!this.nodes['preset-name'].value.trim();
      this.nodes['preset-save'].disabled = !state || !hasName;
      setLockHint(this.nodes['preset-save'], this.nodes['preset-save'].disabled, 'Verrouillé : saisissez un nom de position ci-dessus.');
      if (this.nodes['preset-capture-actual']) {
        this.nodes['preset-capture-actual'].disabled = !state?.feedback?.actual || !hasName;
        setLockHint(this.nodes['preset-capture-actual'], this.nodes['preset-capture-actual'].disabled, !hasName ? 'Verrouillé : saisissez un nom de position ci-dessus.' : 'Verrouillé : aucune mesure du bras disponible.');
      }
      this.nodes['preset-rename'].disabled = !state || !this.nodes.presets.value || !hasName;
      if (this.nodes['sync-actual']) this.nodes['sync-actual'].disabled = !state?.feedback?.actual;
      this.host.querySelectorAll('[data-preset-chip-go]').forEach(btn => {
        btn.disabled = !armed;
        setLockHint(btn, !armed, armReason);
      });
      this.armedNow = armed;
      this.renderMoveCost();
      // A jog that would cross a joint (or XYZ) limit is greyed out, with the reason on hover.
      const actual = state?.feedback?.actual;
      const xyz = state?.feedback?.xyz;
      this.host.querySelectorAll('[data-step]').forEach(el => {
        let blocked = '';
        if (armed && actual) {
          const key = el.dataset.step;
          const direction = Number(el.dataset.direction);
          const linear = ['x', 'y', 'z'].includes(key);
          const step = Number(this.nodes[linear ? 'linear-step' : 'angle-step'].value);
          const value = linear ? xyz?.[key] : actual[key === 't' ? 'hand' : key];
          const [low, high] = linear ? state.config.workspace[key] : state.config.joint_limits[key === 't' ? 'hand' : key];
          const unit = linear ? ' mm' : '°';
          if (Number.isFinite(value) && direction > 0 && value + step > high + 1e-6) blocked = `Limite haute atteinte (${high}${unit})`;
          if (Number.isFinite(value) && direction < 0 && value - step < low - 1e-6) blocked = `Limite basse atteinte (${low}${unit})`;
        }
        el.disabled = !armed || !!blocked;
        if (el.title !== blocked) el.title = blocked;
      });
      this.host.querySelectorAll('[data-compose-goto]').forEach(el => { el.disabled = !armed; });
      this.nodes['video-start'].disabled = !state?.camera_local || !state.gateway || !state.config.camera_configured || !!this.stream;
      this.nodes['video-start'].hidden = !!this.stream;
      this.nodes['video-stop'].disabled = !this.stream;
      this.nodes['video-stop'].hidden = !this.stream;
      this.nodes.fullscreen.disabled = !this.stream || this.nodes.video.paused;
      this.nodes.fullscreen.hidden = !this.stream;
      if (this.nodes['snap-capture']) {
        this.nodes['snap-capture'].disabled = !this.stream || this.nodes.video.paused;
        this.nodes['snap-capture'].hidden = !this.stream;
      }
      if (this.nodes['cam-detect']) {
        this.nodes['cam-detect'].disabled = !this.stream || this.nodes.video.paused || !this.cameraMap;
        this.nodes['cam-detect'].hidden = !this.stream;
      }
      if (this.nodes['teach-toggle']) {
        const teaching = !!state?.teach_mode;
        this.nodes['teach-toggle'].setAttribute('aria-pressed', String(teaching));
        this.nodes['teach-toggle'].textContent = teaching ? 'Quitter mode libre' : 'Mode libre (main)';
        this.nodes['teach-toggle'].disabled = !state || !!this.lease || !!state.moving || !!stop || (hw && (!local || !state.commissioned));
      }
      this.nodes.quality.disabled = !!this.stream;
      if (this.nodes['video-boost-btn']) {
        this.nodes['video-boost-btn'].hidden = !this.stream;
        this.nodes['video-boost-btn'].setAttribute('aria-pressed', String(!!this.videoBoost));
      }
      this.audioControls();
      this.nodes.ptz.hidden = !(state?.config.camera_configured && state.camera_local);
      this.nodes['ptz-presets'].hidden = !(state?.config.camera_configured && state.camera_local);
      this.nodes['ptz-preset-goto'].disabled = !state || !this.nodes['ptz-preset-list'].value;
      this.nodes['ptz-preset-save'].disabled = !state || !this.nodes['ptz-preset-name'].value.trim();
      this.nodes['camera-calibration'].hidden = !(state?.config.camera_configured && state.camera_local);
      const calMeta = this.cameraMap?.meta;
      if (calMeta && state?.config && ((calMeta.camera_ip && calMeta.camera_ip !== state.config.camera_ip) ||
          (calMeta.quality && calMeta.quality !== state.config.quality))) {
        this.invalidateCameraMap('Caméra ou profil vidéo modifié — recalibration requise.');
      }
      this.drawCameraOverlay();
      const nightOk = !!(state?.config.camera_cloud_configured && state.camera_local);
      this.nodes.night.hidden = !nightOk;
      // Read the mode only once the live view runs: each read is a camera login, and failed logins
      // count toward the Tapo's lockout, so merely opening the tab must not attempt one.
      if (nightOk && this.monitor === 'camera' && this.stream && state.camera_live
          && !this.nightLoaded && !this.nightLoading) this.nightGet();
    }

    motionLabel() {
      if (this.pending) return 'Envoi…';
      if (this.state?.stop_state === 'unconfirmed' || this.state?.uncertain) return 'Arrêt non confirmé';
      if (!this.state?.moving) return 'À l’arrêt';
      return this.state.config.mode === 'simulation' ? 'En mouvement' : 'Confirmation en attente';
    }

    // One note for the overlay and the HUD pill, so the two never disagree.
    videoNote(value) {
      if (this.nodes['video-note'].textContent !== value) this.nodes['video-note'].textContent = value;
      const live = this.nodes['hud-live'];
      if (live.textContent !== value) live.textContent = value;
      const state = value === 'En direct' ? 'live' : '';
      if (live.dataset.state !== state) live.dataset.state = state;
    }

    hudRate(value) {
      const node = this.nodes['hud-rate'];
      const label = Number.isFinite(value) ? value + ' i/s' : '— i/s';
      if (node.textContent !== label) node.textContent = label;
    }

    // A native confirm() blocks the page while the 20 s lease keeps running, so a
    // destructive action asks for a second click in the page and forgets it after 8 s.
    askConfirm(key, button, pendingLabel, note) {
      clearTimeout(this.confirmTimer);
      if (this.confirmKey === key) {
        this.clearConfirm();
        return true;
      }
      this.clearConfirm();
      this.confirmKey = key;
      this.confirmButton = button;
      this.confirmLabel = button.textContent;
      button.textContent = pendingLabel;
      this.message(note);
      this.confirmTimer = setTimeout(() => this.clearConfirm(), 8000);
      return false;
    }

    clearConfirm() {
      clearTimeout(this.confirmTimer);
      if (this.confirmButton) this.confirmButton.textContent = this.confirmLabel;
      this.confirmKey = null;
      this.confirmButton = null;
      this.confirmLabel = '';
    }

    // The XY plan doubles as an aiming surface. A click resolves to X/Y in the firmware frame.
    plotPoint(event) {
      const workspace = this.state?.config.workspace;
      const rect = this.nodes.plot.getBoundingClientRect();
      if (!workspace || !rect.width || !rect.height) return null;
      const [left, right] = workspace.x;
      const [bottom, top] = workspace.y;
      const xMin = Math.min(0, left);
      const yMin = Math.min(0, bottom);
      const yMax = Math.max(0, top);
      const scale = Math.min((rect.width - 44) / (right - xMin), (rect.height - 44) / (yMax - yMin || 1));
      if (scale <= 0) return null;
      return {
        x: Math.min(right, Math.max(left, (event.clientX - rect.left - rect.width / 2) / scale + (xMin + right) / 2)),
        y: Math.min(top, Math.max(bottom, (rect.height / 2 - (event.clientY - rect.top)) / scale + (yMin + yMax) / 2)),
      };
    }

    plotScreen(point) {
      const workspace = this.state?.config.workspace;
      const rect = this.nodes.plot.getBoundingClientRect();
      if (!workspace || !rect.width || !rect.height ||
          !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
      const [left, right] = workspace.x;
      const [bottom, top] = workspace.y;
      const xMin = Math.min(0, left);
      const yMin = Math.min(0, bottom);
      const yMax = Math.max(0, top);
      const scale = Math.min((rect.width - 44) / (right - xMin), (rect.height - 44) / (yMax - yMin || 1));
      if (scale <= 0) return null;
      return {
        x: rect.left + rect.width / 2 + (point.x - (xMin + right) / 2) * scale,
        y: rect.top + rect.height / 2 - (point.y - (yMin + yMax) / 2) * scale,
      };
    }

    async plotAim(event) {
      if (!this.active || this.pending || this.playingScript || this.state?.moving) return;
      const point = this.plotPoint(event);
      const z = this.form.z.valueAsNumber;
      const t = this.form.t.valueAsNumber;
      if (!point) return;
      if (!Number.isFinite(z) || !Number.isFinite(t)) {
        throw new Error('Renseignez Z et l’angle de pince avant de viser.');
      }
      this.form.x.value = Number(point.x.toFixed(1));
      this.form.y.value = Number(point.y.toFixed(1));
      const result = await this.preview({ kind: 'cartesian', xyz: { x: point.x, y: point.y, z, t } });
      if (!result) return;
      if (!this.recording || !this.lease) {
        this.message(!this.lease ? 'Cible prévisualisée. Armez le poste pour déplacer le bras.' :
          'Cible prévisualisée. Démarrez l’enregistrement pour déplacer le bras au clic.');
        return;
      }
      if (!await this.approachPose(result.pose)) return;
      this.pilotFields(result.pose, result.xyz);
      if (this.addRecordStep(result.pose)) this.message('Pose ' + this.recording.steps.length + ' enregistrée.');
    }

    // The live dot is the drag handle. The orange ghost follows the pointer at frame
    // rate, while one throttled measured step at a time follows the latest target.
    plotDragStart(event) {
      if (event.button !== 0 || !event.isPrimary) return;
      if (!this.active || (this.monitor !== 'position' && this.monitor !== 'split') || this.pending || this.playingScript || this.state?.moving) return;
      if (!this.lease || !this.state?.armed || this.state.stop_latched || this.state.uncertain) return;
      const screen = this.plotScreen(this.state.feedback?.xyz);
      if (!screen) return;
      const radius = event.pointerType === 'touch' ? 26 : 16;
      if (Math.hypot(event.clientX - screen.x, event.clientY - screen.y) > radius) return;
      this.dragFinish++;
      clearTimeout(this.dragTimer);
      this.dragTimer = null;
      this.clearPreview();
      this.plotDrag = {
        pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        moved: false, target: null, version: 0,
      };
      this.nodes.plot.classList.add('is-drag');
      try { this.nodes.plot.setPointerCapture(event.pointerId); } catch (error) { /* capture is optional */ }
    }

    plotDragMove(event) {
      const drag = this.plotDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true;
      const point = this.plotPoint(event);
      if (!point) return;
      drag.target = point;
      drag.version++;
      this.previewPoint = point;
      this.nodes['plot-preview'].hidden = false;
      this.drawPosition();
      this.scheduleDragStep();
    }

    scheduleDragStep() {
      const drag = this.plotDrag;
      if (!drag || !drag.moved || !drag.target || this.dragStepPromise || this.dragTimer) return;
      const wait = Math.max(0, this.dragNextAt - performance.now());
      if (wait > 0) {
        this.dragTimer = setTimeout(() => {
          this.dragTimer = null;
          this.scheduleDragStep();
        }, wait);
        return;
      }
      const version = drag.version;
      this.dragNextAt = performance.now() + DRAG_FOLLOW_MS;
      this.dragStepPromise = this.run(async () => {
        let stepped = false;
        try {
          stepped = await this.dragFollowStep(drag);
        } finally {
          this.dragStepPromise = null;
          if (this.plotDrag === drag) {
            if (drag.moved && (drag.version !== version || stepped)) this.scheduleDragStep();
          } else if (this.plotDrag) this.scheduleDragStep();
        }
      });
    }

    async dragFollowStep(drag) {
      if (!this.active || this.plotDrag !== drag || !this.lease || !this.state?.armed) return false;
      const z = this.form.z.valueAsNumber;
      const t = this.form.t.valueAsNumber;
      if (!Number.isFinite(z) || !Number.isFinite(t)) return false;
      const target = drag.target;
      if (!target) return false;
      const result = await this.request('preview', { kind: 'cartesian', xyz: { x: target.x, y: target.y, z, t } });
      if (!result || this.plotDrag !== drag || !this.lease || !this.state?.armed) return false;
      return this.stepToward(result.pose, () => this.plotDrag === drag);
    }

    async stepToward(goal, guard = null) {
      if (this.state?.config.mode === 'hardware') {
        this.telemetryEnabled = true;
        this.schedule(0);
      }
      if (!await this.settleIdle()) return false;
      if (guard && !guard()) return false;
      const from = this.state?.feedback?.actual;
      if (!from) return false;
      let delta = 0;
      for (const key of axisKeys) delta = Math.max(delta, Math.abs(goal[key] - from[key]));
      if (delta <= NOOP_DEGREES) return false;
      const limit = Math.max(1, Number(this.state?.config.step_limit || 5) - .5);
      const ratio = Math.min(1, limit / delta);
      const pose = Object.fromEntries(axisKeys.map(key => [key, from[key] + (goal[key] - from[key]) * ratio]));
      return this.move({ kind: 'joints', pose });
    }

    plotDragEnd(event) {
      const drag = this.plotDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.plotDrag = null;
      clearTimeout(this.dragTimer);
      this.dragTimer = null;
      this.nodes.plot.classList.remove('is-drag');
      if (this.nodes.plot.hasPointerCapture?.(drag.pointerId)) {
        try { this.nodes.plot.releasePointerCapture(drag.pointerId); } catch (error) { /* already released */ }
      }
      if (!drag.moved) {
        this.clearPreview();
        return;
      }
      // The browser emits a click after the pointerup; this drag must not also run plotAim,
      // even when the release is outside and the movement is cancelled below.
      this.plotClickGuard = performance.now() + 250;
      const rect = this.nodes.plot.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      const point = inside ? this.plotPoint(event) : null;
      if (!point) {
        this.clearPreview();
        this.message('Déplacement annulé : relâchez le point dans le plan XY.');
        return;
      }
      const finish = ++this.dragFinish;
      const pending = this.dragStepPromise;
      this.run(async () => {
        if (pending) await pending;
        if (finish !== this.dragFinish) return;
        await this.plotDrop(point, finish);
      });
    }

    plotDragCancel(event) {
      const drag = this.plotDrag;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      this.cancelPlotDrag();
    }

    cancelPlotDrag() {
      const drag = this.plotDrag;
      this.dragFinish++;
      clearTimeout(this.dragTimer);
      this.dragTimer = null;
      if (!drag) return;
      if (drag.moved) this.plotClickGuard = performance.now() + 250;
      this.plotDrag = null;
      this.nodes.plot.classList.remove('is-drag');
      if (this.nodes.plot.hasPointerCapture?.(drag.pointerId)) {
        try { this.nodes.plot.releasePointerCapture(drag.pointerId); } catch (error) { /* already released */ }
      }
      this.clearPreview();
    }

    async plotDrop(point, finish = null) {
      if (!this.active || this.pending || this.playingScript) return;
      if (finish != null && finish !== this.dragFinish) return;
      const z = this.form.z.valueAsNumber;
      const t = this.form.t.valueAsNumber;
      if (!Number.isFinite(z) || !Number.isFinite(t)) {
        throw new Error('Renseignez Z et l’angle de pince avant de viser.');
      }
      this.form.x.value = Number(point.x.toFixed(1));
      this.form.y.value = Number(point.y.toFixed(1));
      const result = await this.preview({ kind: 'cartesian', xyz: { x: point.x, y: point.y, z, t } });
      if (!result || (finish != null && finish !== this.dragFinish)) return;
      if (!this.lease || !this.state?.armed) {
        this.message('Cible prévisualisée. Armez le poste pour déplacer le bras.');
        return;
      }
      if (!await this.settleIdle()) return;
      if (finish != null && finish !== this.dragFinish) return;
      const actual = this.state?.feedback?.actual;
      const atTarget = actual && axisKeys.every(key => Math.abs(actual[key] - result.pose[key]) <= NOOP_DEGREES);
      if (!atTarget && !await this.approachPose(result.pose, false,
        finish == null ? null : () => finish === this.dragFinish)) return;
      if (finish != null && finish !== this.dragFinish) return;
      this.pilotFields(result.pose, result.xyz);
      if (this.recording) {
        if (this.addRecordStep(result.pose)) this.message('Pose ' + this.recording.steps.length + ' enregistrée.');
      } else this.message('Bras déplacé à la cible.');
    }

    // A waypoint: the simulator takes it in one move; the real arm approaches it in measured
    // sub-steps bounded by the configured amplitude, exactly like the stepped return home.
    async approachPose(goal, fromScript = false, guard = null) {
      if (this.state?.config.mode !== 'hardware') {
        if (guard && !guard()) return false;
        if (!await this.move({ kind: 'joints', pose: goal }, null, fromScript)) return false;
        return this.settleIdle();
      }
      this.telemetryEnabled = true;
      this.chaining = true;
      this.schedule(0);
      const limit = Math.max(1, Number(this.state?.config.step_limit || 5) - .5);
      try {
        for (let index = 0; index < 120; index++) {
          if (!await this.settleIdle()) return false;
          if (guard && !guard()) return false;
          const from = this.state?.feedback?.actual;
          if (!from) throw new Error('Retour du bras indisponible.');
          const delta = Math.max(...axisKeys.map(key => Math.abs(goal[key] - from[key])));
          if (delta <= NOOP_DEGREES) return true;
          const ratio = Math.min(1, limit / delta);
          const pose = Object.fromEntries(axisKeys.map(key => [key, from[key] + (goal[key] - from[key]) * ratio]));
          if (!await this.move({ kind: 'joints', pose }, null, fromScript)) return false;
          this.schedule(80);
        }
        throw new Error('Le bras n’a pas atteint la pose demandée.');
      } finally {
        this.chaining = false;
      }
    }

    async settleIdle(ms = 20000) {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        if (!this.active || !this.lease || (this.state && !this.state.armed)) return false;
        if (!this.pending && !(this.state?.moving && !this.state?.blend) && this.state?.ticket) return true;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return false;
    }

    addRecordStep(pose) {
      if (!this.recording) return false;
      if (this.recording.steps.length >= MAX_RECORD_STEPS) {
        this.message('Le script contient déjà ' + MAX_RECORD_STEPS + ' poses. Arrêtez-le et gardez-le.', true);
        return false;
      }
      this.recording.steps.push({ ...pose });
      this.controls();
      return true;
    }

    async loadRecordings() {
      const generation = this.generation;
      const result = await this.request('recordings');
      if (!this.active || generation !== this.generation) return;
      this.recordings = result.recordings;
      this.renderRecordings();
    }

    // Same pacing as the simulator (hq_robotics_assistant.step_seconds): the card estimate
    // uses the current speed control, which is the speed sent with every playback step.
    recordingSeconds(item) {
      const poses = [item.start, ...(item.steps || [])];
      const speed = Number(this.nodes.speed?.valueAsNumber);
      const rate = Math.max(1, Number.isFinite(speed) ? speed : 100) * 360 / 4096;
      let seconds = 0;
      for (let index = 1; index < poses.length; index++) {
        let delta = 0;
        for (const key of axisKeys) {
          const step = Math.abs(Number(poses[index]?.[key]) - Number(poses[index - 1]?.[key]));
          if (!Number.isFinite(step)) return 0;
          delta = Math.max(delta, step);
        }
        seconds += Math.max(.25, delta / rate);
      }
      return seconds;
    }

    recordingDuration(item) {
      const seconds = this.recordingSeconds(item);
      if (!(seconds > 0)) return '';
      const rounded = Math.max(1, Math.round(seconds));
      return rounded < 60 ? rounded + ' s'
        : Math.floor(rounded / 60) + ':' + String(rounded % 60).padStart(2, '0');
    }

    renderRecordings() {
      this._recPlayDisabled = null;
      this._recDelDisabled = null;
      const list = this.nodes['record-list'];
      const query = this.recordFilter.trim().toLowerCase();
      const items = Object.entries(this.recordings || {}).filter(([, item]) => {
        if (!query) return true;
        return String(item.name || '').toLowerCase().includes(query)
          || (item.tags || []).some(tag => String(tag).toLowerCase().includes(query));
      });
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'rb-record-empty';
        empty.textContent = query ? 'Aucun script ne correspond à « ' + this.recordFilter + ' ».' : 'Aucun script enregistré.';
        list.replaceChildren(empty);
        return;
      }
      list.replaceChildren(...items.map(([id, item]) => {
        const card = document.createElement('article');
        card.className = 'rb-record';
        const head = document.createElement('div');
        head.className = 'rb-record-head';
        const title = document.createElement('strong');
        title.textContent = item.name;
        const count = document.createElement('span');
        const poses = item.steps.length;
        const duration = this.recordingDuration(item);
        count.textContent = poses + ' pose' + (poses > 1 ? 's' : '') + (duration ? ' · ≈ ' + duration : '');
        if (duration) count.title = 'Durée estimée en simulation à la vitesse réglée ; le matériel peut être plus lent.';
        head.append(title, count);
        card.append(head);
        if (item.tags?.length) {
          const tags = document.createElement('p');
          tags.className = 'rb-record-tags';
          tags.textContent = item.tags.join(' · ');
          card.append(tags);
        }
        if (this.editing?.id === id) {
          card.append(this.renderRecordingEditor());
          return card;
        }
        const actions = document.createElement('div');
        actions.className = 'rb-actions';
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = 'Jouer';
        play.dataset.recordPlay = id;
        const trace = document.createElement('button');
        trace.type = 'button';
        trace.textContent = this.trace?.id === id ? 'Masquer la trace' : 'Tracer';
        trace.dataset.recordTrace = id;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Modifier';
        edit.dataset.recordEdit = id;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Supprimer';
        remove.dataset.recordDelete = id;
        actions.append(play, trace, edit, remove);
        card.append(actions);
        return card;
      }));
      this.controls();
    }

    renderPlayback() {
      const playback = this.playback;
      const strip = this.nodes['playback'];
      strip.hidden = !playback;
      if (!playback) return;
      const total = playback.total || 1;
      this.nodes['playback-name'].textContent = playback.name;
      this.nodes['playback-step'].textContent = 'Étape ' + (playback.index + 1) + ' / ' + playback.total;
      const elapsed = Math.max(0, Math.floor((performance.now() - playback.started) / 1000));
      this.nodes['playback-elapsed'].textContent =
        'Écoulé · ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
      const remaining = Math.max(0, playback.total - playback.index - 1);
      this.nodes['playback-remaining'].textContent = remaining + ' restante' + (remaining <= 1 ? '' : 's');
      this.nodes['playback-fill'].style.width =
        Math.min(100, ((playback.index + 1) / total) * 100) + '%';
    }

    // Homing is driven by measured telemetry on the real arm, so the percentage is a
    // measurement against the captured start, never a timer pretending to be progress.
    beginHoming(label = 'Retour au neutre', goal = HOME_POSE) {
      this.homingView = {
        label,
        goal,
        started: performance.now(),
        start: this.state?.feedback?.actual ? { ...this.state.feedback.actual } : null,
      };
      this.renderHoming();
    }

    finishHoming() {
      this.homingView = null;
      this.renderHoming();
    }

    renderHoming() {
      const view = this.homingView;
      const strip = this.nodes.homing;
      strip.hidden = !view;
      if (!view) return;
      const actual = this.state?.feedback?.actual;
      let percent = null;
      if (view.start && actual) {
        const total = Math.max(...axisKeys.map(key => Math.abs(view.start[key] - view.goal[key])));
        const left = Math.max(...axisKeys.map(key => Math.abs(actual[key] - view.goal[key])));
        percent = total > .1
          ? Math.round(Math.max(0, Math.min(1, 1 - left / total)) * 100)
          : (this.state?.moving ? 0 : 100);
      }
      this.nodes['homing-name'].textContent = view.label;
      this.nodes['homing-step'].textContent = percent == null ? 'Mesure en cours' : percent + ' %';
      this.nodes['homing-fill'].style.width = (percent ?? 0) + '%';
      const elapsed = Math.max(0, Math.floor((performance.now() - view.started) / 1000));
      this.nodes['homing-elapsed'].textContent =
        'Écoulé · ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
      this.nodes['homing-remaining'].textContent = percent == null
        ? 'En attente du retour' : (this.state?.moving ? 'Approche mesurée' : 'Confirmation');
      this.nodes['homing-bar'].setAttribute('aria-valuenow', String(percent ?? 0));
    }

    // Saved assistant scripts are only ghosted; they never change the goal or the trace.
    setLibraryTraces(scripts) {
      this.libraryTraces = (Array.isArray(scripts) ? scripts : []).slice(0, 16).map(script => ({
        id: String(script?.id || ''),
        label: String(script?.label || ''),
        points: (Array.isArray(script?.trace) ? script.trace : []).slice(0, 320).map(point =>
          Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) }
            : { x: Number(point?.x), y: Number(point?.y) })
          .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
      })).filter(script => script.id && script.points.length > 1);
      if (!this.libraryTraces.length) this.ghostLibrary = false;
      const button = this.nodes['library-ghosts'];
      button.hidden = !this.libraryTraces.length;
      button.textContent = this.ghostLibrary ? 'Masquer les traces' : 'Traces sur le plan';
      button.setAttribute('aria-pressed', String(this.ghostLibrary));
      this.drawPosition();
    }

    renderRecordingEditor() {
      const editor = document.createElement('div');
      editor.className = 'rb-record-edit';
      const steps = this.editing?.steps || [];
      if (!steps.length) {
        const empty = document.createElement('p');
        empty.className = 'rb-record-empty';
        empty.textContent = 'Au moins une pose est requise.';
        editor.append(empty);
      } else {
        const list = document.createElement('ol');
        list.className = 'rb-record-steps';
        steps.forEach((pose, index) => {
          const row = document.createElement('li');
          row.className = 'rb-record-step';
          const number = document.createElement('b');
          number.textContent = String(index + 1);
          const text = document.createElement('span');
          text.textContent = axisKeys.map(key => axes[key] + ' ' + format(pose[key], '°')).join(' · ');
          const tools = document.createElement('div');
          for (const [label, title, attribute, value] of [
            ['↑', 'Monter cette pose', 'recordStepUp', index],
            ['↓', 'Descendre cette pose', 'recordStepDown', index],
            ['✕', 'Retirer cette pose', 'recordStepDrop', index],
          ]) {
            const button = document.createElement('button');
            button.type = 'button';
            setGlyph(button, label);
            button.title = title;
            button.setAttribute('aria-label', title);
            button.dataset[attribute] = String(value);
            if ((attribute === 'recordStepUp' && index === 0)
                || (attribute === 'recordStepDown' && index === steps.length - 1)) button.disabled = true;
            tools.append(button);
          }
          row.append(number, text, tools);
          list.append(row);
        });
        editor.append(list);
      }
      const actions = document.createElement('div');
      actions.className = 'rb-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'rb-primary';
      save.textContent = 'Enregistrer les poses';
      save.dataset.recordStepsSave = '';
      save.disabled = !steps.length;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Annuler';
      cancel.dataset.recordCancel = '';
      actions.append(save, cancel);
      editor.append(actions);
      return editor;
    }

    showTrace(id) {
      const item = this.recordings?.[id];
      if (!item) throw new Error('Script introuvable.');
      if (this.trace?.id === id) {
        this.trace = null;
        this.drawPosition();
        this.renderRecordings();
        this.message('Trace masquée.');
        return;
      }
      this.trace = { id, points: (item.trace || []).map(point => ({ ...point })) };
      this.drawPosition();
      this.renderRecordings();
      this.message('Trace du script affichée sur le plan XY.');
    }

    refreshDraftTrace() {
      if (!this.editing) return;
      const start = this.recordings?.[this.editing.id]?.trace?.[0];
      this.trace = {
        id: this.editing.id,
        points: [start, ...this.editing.points]
          .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
          .map(point => ({ ...point })),
      };
      this.drawPosition();
    }

    beginEdit(id) {
      const item = this.recordings?.[id];
      if (!item) throw new Error('Script introuvable.');
      this.editing = {
        id,
        steps: item.steps.map(step => ({ ...step })),
        points: (item.trace || []).slice(1).map(point => ({ ...point })),
      };
      this.refreshDraftTrace();
      this.renderRecordings();
    }

    reorderRecordingStep(index, delta) {
      if (!this.editing) return;
      const target = index + delta;
      const steps = this.editing.steps;
      if (target < 0 || target >= steps.length) return;
      [steps[index], steps[target]] = [steps[target], steps[index]];
      if (this.editing.points.length === steps.length) {
        [this.editing.points[index], this.editing.points[target]] =
          [this.editing.points[target], this.editing.points[index]];
      }
      this.refreshDraftTrace();
      this.renderRecordings();
    }

    dropRecordingStep(index) {
      if (!this.editing) return;
      this.editing.steps.splice(index, 1);
      if (this.editing.points.length > index) this.editing.points.splice(index, 1);
      this.refreshDraftTrace();
      this.renderRecordings();
    }

    cancelRecordingEdit() {
      const id = this.editing?.id;
      this.editing = null;
      this.trace = id && this.recordings?.[id]
        ? { id, points: (this.recordings[id].trace || []).map(point => ({ ...point })) }
        : null;
      this.renderRecordings();
      this.drawPosition();
    }

    async saveRecordingSteps() {
      const editing = this.editing;
      if (!editing) return;
      if (!editing.steps.length) throw new Error('Gardez au moins une pose.');
      const result = await this.request('recordings', {
        action: 'update', id: editing.id, steps: editing.steps,
      });
      this.recordings = result.recordings;
      this.editing = null;
      this.trace = { id: editing.id,
        points: (this.recordings[editing.id]?.trace || []).map(point => ({ ...point })) };
      this.renderRecordings();
      this.drawPosition();
      this.message('Poses enregistrées.');
    }

    parseTags(value) {
      const tags = String(value || '').split(',').map(tag => tag.trim()).filter(Boolean);
      return [...new Map(tags.map(tag => [tag.toLowerCase(), tag])).values()].slice(0, 6);
    }

    async storeRecording() {
      const draft = this.recordDraft;
      if (!draft) throw new Error('Enregistrez d’abord un mouvement.');
      const name = this.nodes['record-name'].value.trim();
      if (!name) throw new Error('Donnez un nom au script.');
      const result = await this.request('recordings', {
        action: 'save', name, start: draft.start, steps: draft.steps,
        tags: this.parseTags(this.nodes['record-tags'].value),
      });
      this.recordings = result.recordings;
      this.recordDraft = null;
      this.nodes['record-name'].value = '';
      this.nodes['record-tags'].value = '';
      this.renderRecordings();
      this.message('Script enregistré.');
      this.controls();
    }

    async exportRecordings() {
      const result = await this.request('recordings');
      const payload = JSON.stringify({ exported_at: new Date().toISOString(),
        recordings: result.recordings }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'robotique-scripts-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.message('Scripts exportés.');
    }

    async exportBlackbox() {
      const result = await this.request('blackbox');
      const payload = JSON.stringify({ exported_at: new Date().toISOString(),
        capacity: result.capacity, entries: result.entries }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'robotique-journal-noir-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.nodes['blackbox-state'].textContent = (result.entries?.length || 0) + ' échantillon(s) exporté(s)';
      this.message('Journal noir exporté.');
    }

    async deleteRecording(id, button) {
      if (!this.recordings?.[id]) throw new Error('Script introuvable.');
      if (!this.askConfirm('recording-' + id, button, 'Confirmer : supprimer',
        'Cliquez de nouveau pour supprimer ce script enregistré.')) return;
      const result = await this.request('recordings', { action: 'delete', id });
      this.recordings = result.recordings;
      if (this.trace?.id === id) this.trace = null;
      this.renderRecordings();
      this.drawPosition();
      this.message('Script supprimé.');
      this.controls();
    }

    async playRecording(id) {
      const item = this.recordings?.[id];
      if (!item) throw new Error('Script introuvable.');
      this.trace = { id, points: (item.trace || []).map(point => ({ ...point })) };
      this.renderRecordings();
      this.drawPosition();
      if (!this.lease) throw new Error('Armez le poste avant de jouer le script.');
      if (this.playingScript) return;
      const actual = this.state?.feedback?.actual;
      if (!actual) throw new Error('Retour du bras indisponible.');
      const miss = Math.max(...axisKeys.map(key => Math.abs(actual[key] - item.start[key])));
      if (miss > 2) throw new Error('Replacez le bras sur la pose de départ du script (Retour au neutre) avant de jouer.');
      this.playback = { name: item.name, total: item.steps.length, index: 0,
        started: performance.now() };
      this.playingScript = true;
      this.controls();
      try {
        const baseline = this.loadRecTorque(id);
        const tol = 180;
        for (const [index, step] of item.steps.entries()) {
          if (!this.active || !this.lease) return;
          if (this.playback) {
            this.playback.index = index;
            this.renderPlayback();
          }
          if (this.trace) this.trace.active = index;
          this.nodes['plot-trace'].textContent = 'Trace · ' + (index + 1) + '/' + item.steps.length;
          this.drawPosition();
          if (!await this.approachPose(step, true)) return;
          if (this.state?.config?.mode === 'hardware' && baseline?.[index]) {
            await this.checkTorqueDelta(baseline[index], tol);
          }
        }
        if (this.state?.config?.mode === 'hardware' && !baseline) {
          const snap = this.captureLoadSnap();
          if (Object.keys(snap).length) {
            this.saveRecTorque(id, item.steps.map(() => snap));
          }
        }
        this.message('Script terminé.');
      } finally {
        this.playingScript = false;
        this.playback = null;
        if (this.trace) this.trace.active = null;
        this.nodes['plot-trace'].textContent = 'Trace';
        this.controls();
        this.drawPosition();
      }
    }

    monitorModeFromUi() {
      const base = this.monitorBase || 'position';
      const layout = this.monitorLayout || 'single';
      if (layout === 'split' && base === 'position') return 'split';
      if (layout === 'cam3d' && base === 'camera') return 'cam3d';
      return base;
    }

    syncMonitorLayoutUi() {
      const sel = this.nodes['monitor-layout'];
      if (!sel) return;
      for (const opt of sel.options) {
        opt.disabled = (opt.value === 'split' && this.monitorBase !== 'position')
          || (opt.value === 'cam3d' && this.monitorBase !== 'camera');
      }
      if (sel.options[sel.selectedIndex]?.disabled) {
        sel.value = 'single';
        this.monitorLayout = 'single';
      }
    }

    applyMonitorView() {
      this.selectMonitor(this.monitorModeFromUi());
    }

    selectMonitor(mode) {
      this.monitor = mode;
      if (mode === 'split') {
        this.monitorBase = 'position';
        this.monitorLayout = 'split';
      } else if (mode === 'cam3d') {
        this.monitorBase = 'camera';
        this.monitorLayout = 'cam3d';
      } else if (mode === 'position' || mode === 'camera' || mode === 'space') {
        this.monitorBase = mode;
        this.monitorLayout = 'single';
      }
      if (this.nodes['monitor-layout'] && this.nodes['monitor-layout'].value !== this.monitorLayout) {
        this.nodes['monitor-layout'].value = this.monitorLayout;
      }
      this.syncMonitorLayoutUi();
      const showPos = mode === 'position' || mode === 'split';
      const showCam = mode === 'camera' || mode === 'cam3d';
      const showSpace = mode === 'space' || mode === 'split' || mode === 'cam3d';
      this.nodes['position-pane'].hidden = !showPos;
      this.nodes['camera-pane'].hidden = !showCam;
      this.nodes['space-pane'].hidden = !showSpace;
      this.host.querySelector('.rb-camera')?.classList.toggle('is-split-monitor', mode === 'split' || mode === 'cam3d');
      if (showSpace) this.mountSpace();
      for (const button of this.host.querySelectorAll('[data-monitor-base]')) {
        button.setAttribute('aria-pressed', String(button.dataset.monitorBase === this.monitorBase));
      }
      if (showPos) this.drawPosition();
      if (showSpace) this.updateSpace();
      this.drawCameraOverlay();
    }

    selectSection(id, { scroll = true } = {}) {
      const overview = id === 'all';
      this.sectionOverview = overview;
      if (!overview) this.lastSection = id;
      this.host.classList.toggle('rb-section-focus', !overview);
      this.host.classList.toggle('rb-section-overview', overview);
      this.host.dataset.activeSection = overview ? '' : id;
      if (this.nodes['section-overview']) {
        const toggle = this.nodes['section-overview'];
        toggle.setAttribute('aria-pressed', String(overview));
        toggle.setAttribute('aria-label', overview ? 'Revenir à la vue par section' : 'Afficher toutes les sections');
        toggle.querySelector('.rb-wide').textContent = overview ? 'Vue par section' : 'Vue complète';
        toggle.querySelector('.rb-narrow').textContent = overview ? 'Section' : 'Tout';
      }
      this.host.querySelectorAll('[data-section-nav]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(!overview && btn.dataset.goSection === id));
      });
      // Keep the chosen chip in view: on a phone the row scrolls and most chips start off-screen.
      const nav = this.host.querySelector('.rb-section-nav');
      const chip = nav?.querySelector('[data-section-nav][aria-pressed="true"]');
      if (nav && chip) {
        const chipBox = chip.getBoundingClientRect();
        const navBox = nav.getBoundingClientRect();
        if (chipBox.left < navBox.left + 4) nav.scrollLeft += chipBox.left - navBox.left - 4;
        else if (chipBox.right > navBox.right - 4) nav.scrollLeft += chipBox.right - navBox.right + 4;
      }
      let target;
      if (id === 'commission') target = this.nodes['commission-card'];
      else if (id === 'advanced') target = this.host.querySelector('[data-section="config"]');
      else if (!overview) target = this.host.querySelector(`[data-section="${id}"]`);
      if (scroll && target) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      }
      try { localStorage.setItem('hq_robotics_section_v1', overview ? 'all' : id); } catch (_) {}
      this.syncSectionNav();
    }

    // Edge fades on the chip row are the only cue that it scrolls: the scrollbar is hidden by design.
    syncSectionNav() {
      const nav = this.host.querySelector('.rb-section-nav');
      if (!nav) return;
      const max = nav.scrollWidth - nav.clientWidth;
      nav.classList.toggle('is-overflow', max > 2);
      nav.classList.toggle('is-start', max > 2 && nav.scrollLeft > 2);
      nav.classList.toggle('is-end', max > 2 && nav.scrollLeft < max - 2);
      const more = this.host.querySelector('[data-rb="section-more"]');
      if (more) more.hidden = !(max > 2 && nav.scrollLeft < max - 2);
      // A chip half-hidden under an edge fade reads as a truncated label. Hide the chip that
      // straddles a fade so the rail always ends on a whole chip; it returns once scrolled in.
      const atStart = nav.scrollLeft <= 2;
      const atEnd = nav.scrollLeft >= max - 2;
      const box = nav.getBoundingClientRect();
      const cut = (button) => {
        const rect = button.getBoundingClientRect();
        if (!rect.width) return false;
        // Each fade only exists while there is something beyond that edge.
        if (!atStart && rect.left < box.left + 12) return true;
        return !atEnd && rect.right > box.right - 12;
      };
      nav.querySelectorAll(':scope > button').forEach(button => {
        button.classList.toggle('is-edge-cut', max > 2 && cut(button));
      });
    }

    openZonesInMonitor() {
      this.selectSection('camera', { scroll: true });
      this.monitorChosen = true;
      this.monitorBase = 'space';
      if (this.nodes['monitor-layout']) {
        this.nodes['monitor-layout'].value = 'single';
        this.monitorLayout = 'single';
      }
      this.syncMonitorLayoutUi();
      this.applyMonitorView();
      this.zonesToggle(true);
    }

    drawPosition() {
      if (!this.active || (this.monitor !== 'position' && this.monitor !== 'split')) return;
      const canvas = this.nodes.plot;
      if (!canvas || canvas.offsetParent === null) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
        [canvas.width, canvas.height] = pixels;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight')
        && !document.body.classList.contains('theme-oled');
      const palette = light ? {
        area: '#eaf4f3', areaGlow: 'rgba(8, 114, 79, .07)', border: '#87aba9', subGrid: 'rgba(71, 100, 102, .1)',
        axis: 'rgba(54, 88, 90, .65)', ring: 'rgba(8, 114, 79, .22)',
        tick: '#476466', tickLine: 'rgba(71, 100, 102, .5)', label: '#2f4d4f',
        traceLine: 'rgba(90, 64, 175, .92)', traceGlow: 'rgba(90, 64, 175, .2)', traceDot: '#5a40af', hole: '#ffffff',
        command: '#2b63c7', commandFill: 'rgba(43, 99, 199, .14)',
        preview: '#a35a00', previewLine: 'rgba(163, 90, 0, .82)', live: '#08724f', liveGlow: 'rgba(8, 114, 79, .22)',
        armBeam: 'rgba(8, 114, 79, .32)', armCore: '#08724f',
        ghost: 'rgba(8, 114, 79, .3)', activeFill: '#ffffff', activeHalo: 'rgba(90, 64, 175, .5)',
        zone: 'rgba(180, 35, 61, .11)', zoneHatch: 'rgba(180, 35, 61, .18)', zoneBorder: 'rgba(180, 35, 61, .75)', zoneLabel: '#8e2035',
      } : {
        area: '#122b32', areaGlow: 'rgba(115, 237, 206, .09)', border: '#2f5f66', subGrid: 'rgba(134, 225, 205, .07)',
        axis: 'rgba(115, 237, 206, .42)', ring: 'rgba(115, 237, 206, .18)',
        tick: '#8fabad', tickLine: 'rgba(162, 189, 191, .55)', label: '#b4d2d4',
        traceLine: 'rgba(201, 184, 255, .95)', traceGlow: 'rgba(201, 184, 255, .25)', traceDot: '#c9b8ff', hole: '#0b171e',
        command: '#9fc5ff', commandFill: 'rgba(159, 197, 255, .16)',
        preview: '#ffc176', previewLine: 'rgba(255, 193, 118, .85)', live: '#73edce', liveGlow: 'rgba(115, 237, 206, .28)',
        armBeam: 'rgba(115, 237, 206, .24)', armCore: '#73edce',
        ghost: 'rgba(115, 237, 206, .28)', activeFill: '#f4efff', activeHalo: 'rgba(201, 184, 255, .55)',
        zone: 'rgba(255, 120, 145, .11)', zoneHatch: 'rgba(255, 120, 145, .18)', zoneBorder: 'rgba(255, 140, 160, .82)', zoneLabel: '#ffb3c0',
      };
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
      const wx = x(left), wy = y(top), ww = (right - left) * scale, wh = (top - bottom) * scale;
      const ox = x(0), oy = y(0);
      const zSlice = Number.isFinite(this.form.z?.valueAsNumber) ? this.form.z.valueAsNumber : (this.displayXyz()?.z ?? 120);
      const posKey = `${pixels[0]}x${pixels[1]}|${ratio}|${light}|${this.state?.config?.revision}|${Math.round(zSlice / 5) * 5}`;
      if (!this._posStatic || this._posStatic.key !== posKey) {
        const bgCanvas = this._posStatic?.canvas || document.createElement('canvas');
        bgCanvas.width = pixels[0];
        bgCanvas.height = pixels[1];
        const bctx = bgCanvas.getContext('2d');
        if (bctx) {
          bctx.setTransform(ratio, 0, 0, ratio, 0, 0);
          bctx.clearRect(0, 0, width, height);
          bctx.fillStyle = palette.area;
          bctx.fillRect(wx, wy, ww, wh);
          bctx.save();
          bctx.beginPath();
          bctx.rect(wx, wy, ww, wh);
          bctx.clip();
          const grad = bctx.createRadialGradient(ox, oy, 4, ox, oy, Math.max(ww, wh) * .85);
          grad.addColorStop(0, palette.areaGlow);
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          bctx.fillStyle = grad;
          bctx.fillRect(wx, wy, ww, wh);
          bctx.strokeStyle = palette.subGrid;
          bctx.lineWidth = 1;
          bctx.beginPath();
          for (let gx = Math.ceil(left / 50) * 50; gx <= right; gx += 50) {
            if (gx === 0) continue;
            bctx.moveTo(x(gx), wy);
            bctx.lineTo(x(gx), wy + wh);
          }
          for (let gy = Math.ceil(bottom / 50) * 50; gy <= top; gy += 50) {
            if (gy === 0) continue;
            bctx.moveTo(wx, y(gy));
            bctx.lineTo(wx + ww, y(gy));
          }
          bctx.stroke();
          const baseLimits = this.state?.config?.joint_limits?.base || [-180, 180];
          const bMin = -rad(baseLimits[1]), bMax = -rad(baseLimits[0]);
          const maxSpan = UPPER + LOWER - 2;
          const minSpan = Math.abs(UPPER - LOWER) + 4;
          const rOuter = Math.sqrt(Math.max(0, maxSpan * maxSpan - zSlice * zSlice));
          const rInner = Math.sqrt(Math.max(0, minSpan * minSpan - zSlice * zSlice));
          if (rOuter > rInner + 2) {
            bctx.fillStyle = light ? 'rgba(8, 114, 79, .055)' : 'rgba(115, 237, 206, .055)';
            bctx.beginPath();
            bctx.arc(ox, oy, rOuter * scale, bMin, bMax, false);
            bctx.arc(ox, oy, Math.max(2, rInner * scale), bMax, bMin, true);
            bctx.closePath();
            bctx.fill();
            bctx.strokeStyle = light ? 'rgba(8, 114, 79, .38)' : 'rgba(115, 237, 206, .35)';
            bctx.lineWidth = 1.2;
            bctx.beginPath();
            bctx.arc(ox, oy, rOuter * scale, bMin, bMax);
            bctx.stroke();
          }
          bctx.strokeStyle = palette.ring;
          bctx.setLineDash([4, 4]);
          for (const rMm of [150, 300, 450]) {
            bctx.beginPath();
            bctx.arc(ox, oy, rMm * scale, bMin, bMax);
            bctx.stroke();
          }
          bctx.setLineDash([]);
          bctx.restore();
          bctx.strokeStyle = palette.border;
          bctx.lineWidth = 1.2;
          bctx.strokeRect(wx, wy, ww, wh);
          bctx.strokeStyle = palette.axis;
          bctx.lineWidth = 1.2;
          bctx.beginPath();
          bctx.moveTo(x(xMin), oy);
          bctx.lineTo(x(right), oy);
          bctx.moveTo(ox, y(yMax));
          bctx.lineTo(ox, y(yMin));
          bctx.stroke();
          bctx.fillStyle = palette.hole;
          bctx.strokeStyle = palette.border;
          bctx.lineWidth = 1.5;
          bctx.beginPath();
          bctx.arc(ox, oy, 6, 0, Math.PI * 2);
          bctx.fill();
          bctx.stroke();
          bctx.fillStyle = palette.tick;
          bctx.beginPath();
          bctx.arc(ox, oy, 2, 0, Math.PI * 2);
          bctx.fill();
          const niceStep = (span, px) => {
            const rough = span / Math.max(3, Math.floor(px / 44));
            const power = 10 ** Math.floor(Math.log10(rough || 1));
            const r = rough / power;
            return (r <= 1.5 ? 1 : r <= 3 ? 2 : r <= 7 ? 5 : 10) * power;
          };
          const xStep = niceStep(right - xMin, Math.max(40, (right - xMin) * scale));
          const yStep = niceStep(yMax - yMin, Math.max(40, (yMax - yMin) * scale));
          bctx.save();
          bctx.font = '10px ui-monospace, monospace';
          bctx.fillStyle = palette.tick;
          bctx.strokeStyle = palette.tickLine;
          bctx.lineWidth = 1;
          bctx.textAlign = 'center';
          bctx.textBaseline = 'top';
          for (let value = Math.ceil(xMin / xStep) * xStep; value <= right + .001; value += xStep) {
            const px = x(value);
            bctx.beginPath();
            bctx.moveTo(px, oy);
            bctx.lineTo(px, oy + 3);
            bctx.stroke();
            bctx.fillText(String(Math.round(value)), px, oy + 5);
          }
          bctx.textAlign = 'right';
          bctx.textBaseline = 'middle';
          for (let value = Math.ceil(yMin / yStep) * yStep; value <= yMax + .001; value += yStep) {
            const py = y(value);
            bctx.beginPath();
            bctx.moveTo(ox - 3, py);
            bctx.lineTo(ox, py);
            bctx.stroke();
            bctx.fillText(String(Math.round(value)), ox - 5, py);
          }
          bctx.restore();
          bctx.font = '600 11px ui-monospace, monospace';
          bctx.fillStyle = palette.label;
          bctx.fillText('X', x(right) + 5, oy + 4);
          bctx.fillText('Y', ox - 11, y(yMax) + 3);
          this._posStatic = { canvas: bgCanvas, key: posKey };
        }
      }
      if (this._posStatic?.canvas) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this._posStatic.canvas, 0, 0);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      for (const zone of this.state?.config.keepout || []) {
        const zx = x(zone.x[0]), zy = y(zone.y[1]);
        const zw = (zone.x[1] - zone.x[0]) * scale, zh = (zone.y[1] - zone.y[0]) * scale;
        ctx.fillStyle = palette.zone;
        ctx.fillRect(zx, zy, zw, zh);
        ctx.save();
        ctx.beginPath();
        ctx.rect(zx, zy, zw, zh);
        ctx.clip();
        ctx.strokeStyle = palette.zoneHatch;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let d = -zh; d < zw + zh; d += 9) {
          ctx.moveTo(zx + d, zy);
          ctx.lineTo(zx + d - zh, zy + zh);
        }
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = palette.zoneBorder;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeRect(zx, zy, zw, zh);
        ctx.setLineDash([]);
        ctx.fillStyle = palette.zoneLabel;
        ctx.font = '600 9px ui-monospace, monospace';
        ctx.fillText(zone.name, zx + 4, zy + 11);
      }
      // Workbench 2D Overlays: R×C Palletizer tray matrix & Pick A → Place B beacons
      const wb = this.workbenchOverlay();
      if (wb?.pallet) {
        const { rows, cols, x0, y0, dx, dy, active } = wb.pallet;
        const hw = Math.max(8, Math.abs(dx) * .36) * scale;
        const hh = Math.max(8, Math.abs(dy) * .36) * scale;
        ctx.save();
        let slotIdx = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const colIdx = r % 2 === 1 ? (cols - 1 - c) : c;
            const cx = x(x0 + r * dx);
            const cy = y(y0 + colIdx * dy);
            const isAct = slotIdx === active;
            ctx.fillStyle = isAct ? 'rgba(255, 193, 118, .22)' : 'rgba(159, 197, 255, .07)';
            ctx.strokeStyle = isAct ? palette.preview : 'rgba(159, 197, 255, .35)';
            ctx.lineWidth = isAct ? 1.5 : 1;
            ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
            ctx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
            slotIdx++;
          }
        }
        ctx.restore();
      }
      if (wb?.transfer) {
        const { ax, ay, bx, by } = wb.transfer;
        if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)) {
          ctx.save();
          ctx.strokeStyle = palette.command;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x(ax), y(ay));
          ctx.lineTo(x(bx), y(by));
          ctx.stroke();
          ctx.setLineDash([]);
          for (const [tag, px, py, col] of [['A', ax, ay, palette.live], ['B', bx, by, palette.preview]]) {
            const sx = x(px), sy = y(py);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, 6.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = col;
            ctx.font = '700 9px ui-monospace, monospace';
            ctx.fillText(tag, sx + 8, sy + 3);
          }
          ctx.restore();
        }
      }
      const ghosts = this.ghostLibrary ? this.libraryTraces : [];
      this.nodes['plot-ghosts'].hidden = !ghosts.length;
      if (ghosts.length) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = palette.ghost;
        for (const item of ghosts) {
          if (item.points.length < 2) continue;
          ctx.beginPath();
          item.points.forEach((point, index) => index
            ? ctx.lineTo(x(point.x), y(point.y)) : ctx.moveTo(x(point.x), y(point.y)));
          ctx.stroke();
        }
        ctx.restore();
      }
      const trace = (this.trace?.points || []).filter(point =>
        Number.isFinite(point?.x) && Number.isFinite(point?.y));
      if (trace.length) {
        if (trace.length > 1) {
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          trace.forEach((point, index) => index
            ? ctx.lineTo(x(point.x), y(point.y)) : ctx.moveTo(x(point.x), y(point.y)));
          ctx.strokeStyle = palette.traceGlow;
          ctx.lineWidth = 5.5;
          ctx.stroke();
          ctx.strokeStyle = palette.traceLine;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
        trace.forEach((point, index) => {
          ctx.beginPath();
          ctx.arc(x(point.x), y(point.y), index ? 3.2 : 4.6, 0, Math.PI * 2);
          ctx.fillStyle = index ? palette.traceDot : palette.hole;
          ctx.strokeStyle = palette.traceDot;
          ctx.lineWidth = 1.6;
          ctx.fill();
          ctx.stroke();
        });
      }
      this.nodes['plot-trace'].hidden = !trace.length;

      // Projected 2D kinematic chain (Shoulder -> Elbow -> TCP) for live pose
      const liveActual = this.displayActual();
      if (liveActual && axisKeys.every(k => Number.isFinite(liveActual[k]))) {
        const { elbow, tcp } = armLinks(liveActual);
        const ex = x(elbow.x), ey = y(elbow.y), tx = x(tcp.x), ty = y(tcp.y);
        const loads = Object.values(this.state?.feedback?.load || {}).filter(Number.isFinite).map(Math.abs);
        const peakLoad = loads.length ? Math.max(...loads) : 0;
        const warnLoad = this.state?.config?.load_warn ?? 700;
        const critLoad = this.state?.config?.load_critical ?? 900;
        const thermalBeam = peakLoad >= critLoad ? 'rgba(255, 120, 145, .36)'
          : peakLoad >= warnLoad ? 'rgba(255, 193, 118, .36)' : palette.armBeam;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = thermalBeam;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ex, ey);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.strokeStyle = palette.armCore;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ex, ey);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // Elbow joint pivot ring
        ctx.fillStyle = palette.hole;
        ctx.strokeStyle = palette.armCore;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(ex, ey, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // The last commanded joint pose, projected to XY. It remains visible while the arm moves.
      const commanded = targetXy(this.state?.target);
      this.nodes['plot-command'].hidden = !commanded;
      if (commanded) {
        const cx = x(commanded.x), cy = y(commanded.y);
        ctx.save();
        ctx.strokeStyle = palette.command;
        ctx.fillStyle = palette.commandFill;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx + 8, cy);
        ctx.lineTo(cx, cy + 8);
        ctx.lineTo(cx - 8, cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 11, cy);
        ctx.lineTo(cx + 11, cy);
        ctx.moveTo(cx, cy - 11);
        ctx.lineTo(cx, cy + 11);
        ctx.stroke();
        ctx.restore();
      }
      for (const [point, color, isLive] of [[this.previewPoint, palette.preview, false], [this.displayXyz(), palette.live, true]]) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
        const px = x(point.x), py = y(point.y);
        if (isLive) {
          ctx.beginPath();
          ctx.arc(px, py, 9.5, 0, Math.PI * 2);
          ctx.fillStyle = palette.liveGlow;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(px, py, 5.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = palette.hole;
        ctx.stroke();
      }
      if (this.plotDrag?.moved && Number.isFinite(this.previewPoint?.x) && Number.isFinite(this.previewPoint?.y)) {
        const from = this.state.feedback?.xyz;
        ctx.save();
        if (Number.isFinite(from?.x) && Number.isFinite(from?.y)) {
          ctx.beginPath();
          ctx.setLineDash([5, 4]);
          ctx.moveTo(x(from.x), y(from.y));
          ctx.lineTo(x(this.previewPoint.x), y(this.previewPoint.y));
          ctx.strokeStyle = palette.previewLine;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x(this.previewPoint.x), y(this.previewPoint.y), 9, 0, Math.PI * 2);
        ctx.strokeStyle = palette.previewLine;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
      // The waypoint currently being approached stays legible over the live dot.
      const active = this.trace?.active != null ? trace[this.trace.active + 1] : null;
      if (active) {
        ctx.beginPath();
        ctx.arc(x(active.x), y(active.y), 7, 0, Math.PI * 2);
        ctx.fillStyle = palette.activeFill;
        ctx.strokeStyle = palette.traceDot;
        ctx.lineWidth = 2.5;
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x(active.x), y(active.y), 11.5, 0, Math.PI * 2);
        ctx.strokeStyle = palette.activeHalo;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // Live hover crosshair + coordinate / zone callout
      const hov = this.plotHover;
      if (hov && !this.plotDrag) {
        const hx = x(hov.x), hy = y(hov.y);
        ctx.save();
        ctx.strokeStyle = palette.previewLine;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, wy); ctx.lineTo(hx, wy + wh);
        ctx.moveTo(wx, hy); ctx.lineTo(wx + ww, hy);
        ctx.stroke();
        ctx.setLineDash([]);
        const tag = hov.overDot ? 'Glisser pour déplacer le bras'
          : hov.overZone ? `Zone « ${hov.overZone} » (interdite)`
          : `X ${Math.round(hov.x)} · Y ${Math.round(hov.y)} mm · Clic : aperçu`;
        ctx.font = '600 9.5px ui-monospace, monospace';
        const tw = ctx.measureText(tag).width + 12;
        const bx = Math.min(width - tw - 6, Math.max(6, hx + 10));
        const by = Math.max(6, hy - 22);
        ctx.fillStyle = light ? 'rgba(255, 255, 255, .94)' : 'rgba(9, 19, 25, .92)';
        ctx.strokeStyle = hov.overZone ? palette.zoneBorder : palette.preview;
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, tw, 16);
        ctx.strokeRect(bx, by, tw, 16);
        ctx.fillStyle = hov.overZone ? palette.zoneLabel : palette.preview;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, bx + 6, by + 8.5);
        ctx.restore();
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
      this.pilotAids();
    }

    xyzText(xyz) {
      return ['x', 'y', 'z'].map(key => key.toUpperCase() + ' ' + format(xyz[key], ' mm')).join(' · ');
    }

    loadPose(pose, xyz) {
      for (const key of axisKeys) this.form[key].value = Number(pose[key].toFixed(3));
      const neutral = { x: 310.155, y: 0, z: 236.82 };
      for (const key of ['x', 'y', 'z']) this.form[key].value = Number((xyz?.[key] ?? neutral[key]).toFixed(3));
      this.form.t.value = Number(pose.hand.toFixed(3));
      for (const key of axisKeys) {
        const slider = this.nodes['slider-' + key];
        if (slider) slider.value = this.form[key].value;
      }
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
        this.leaseDeadline = performance.now() + LEASE_MS;
        this.playHudSound('arm');
        this.haptic(12);
        const state = await this.request('status');
        if (generation === this.motionGeneration) this.render(state);
      } finally {
        this.arming = false;
        this.controls();
        this.schedule(0);
      }
    }

    async renewLease() {
      if (!this.lease || this.pending) return;
      const result = await this.request('renew', { lease: this.lease });
      if (result?.ok) {
        this.leaseDeadline = performance.now() + LEASE_MS;
        this.playHudSound('arm');
        this.controls();
        this.message('Autorisation d’armement prolongée de 20 s.');
      }
    }

    syncLeaseBar() {
      if (!this.lease || !this.leaseDeadline) return;
      const remMs = Math.max(0, this.leaseDeadline - performance.now());
      const sec = Math.ceil(remMs / 1000);
      const label = 'Autorisation · ' + sec + ' s';
      const txtNode = this.nodes['lease-text'];
      if (txtNode) {
        if (txtNode.textContent !== label) txtNode.textContent = label;
      } else if (this.nodes.lease.textContent !== label) {
        this.nodes.lease.textContent = label;
      }
      if (this.nodes['lease-fill']) {
        this.nodes['lease-fill'].style.width = Math.min(100, Math.max(0, remMs / LEASE_MS * 100)).toFixed(1) + '%';
      }
      this.nodes.lease.classList.toggle('is-expiring', sec <= 6);
    }

    release() {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
      this.cancelPlotDrag();
      this.debugAbort?.();
      clearTimeout(this.jog?.timer);
      this.jog?.button?.classList.remove('is-pressed');
      this.jog = null;
      this.motionGeneration++;
      const lease = this.lease;
      this.lease = '';
      this.leaseDeadline = 0;
      if (lease) this.request('cancel', { lease }, { keepalive: true }).catch(() => {});
      this.controls();
    }

    // Shared by the sticky STOP and the fullscreen HUD button.
    async stopStation() {
      const generation = this.generation;
      this.playHudSound('stop');
      this.haptic([25, 45, 25]);
      this.release();
      const status = await this.request('stop', {});
      if (this.generation === generation) this.render(status);
      this.message(status.config.mode === 'simulation' ? 'Simulation arrêtée.' :
        (status.stop_result === 'torque_release_requested' ?
          'Coupure du couple demandée. Vérifiez le bras sur place.' :
          (status.stop_state === 'unconfirmed' ?
            'Pilotage verrouillé — arrêt physique non confirmé, vérifiez le bras sur place.' :
            'Pilotage verrouillé.')));
    }

    floorGuardArgs() {
      const args = {};
      const floorZ = this.nodes['floor-z']?.valueAsNumber;
      const toolMm = this.nodes['tool-offset']?.valueAsNumber;
      if (Number.isFinite(floorZ) && floorZ > -80) args.floor_z = floorZ;
      if (Number.isFinite(toolMm) && toolMm > 0) args.tool_offset = toolMm;
      return args;
    }

    async move(target, jogButton, fromScript = false) {
      if (!this.lease || !this.state?.ticket || this.pending || (this.state.moving && !this.state.blend) ||
          document.hidden || !document.hasFocus() || (this.playingScript && !fromScript)) return false;
      const generation = this.motionGeneration;
      // A drag step keeps its orange waypoint while the live dot advances.
      if (!this.plotDrag?.moved) this.clearPreview();
      this.pending = true;
      this.controls();
      try {
        const next = await this.request('move', { ...target, ...this.floorGuardArgs(), lease: this.lease,
          ticket: this.state.ticket, speed: this.nodes.speed.valueAsNumber });
        this.leaseDeadline = performance.now() + LEASE_MS + (next.script?.seconds || 0) * 1000;
        if (generation === this.motionGeneration) this.render(next);
        if (jogButton && next.target && generation === this.motionGeneration) {
          if (this.mode === 'joints') this.pilotFields(next.target);
          else {
            this.releaseComposePoint();
            for (const [key, value] of Object.entries(target.xyz)) this.form[key].value = value;
          }
        }
        return generation === this.motionGeneration;
      } finally {
        this.pending = false;
        this.controls();
        this.schedule(0);
      }
    }

    // A physical move is bounded by step_limit, so the neutral pose is reached in
    // several measured steps, each re-validated by the server.
    // Night vision (infrared) of the Tapo: Auto, Jour (infrared off) or Nuit (infrared on).
    showNight(mode) {
      this.nightMode = mode;
      this.host.querySelectorAll('[data-night]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.night === mode)));
    }

    async nightGet() {
      this.nightLoading = true;
      try {
        this.showNight((await this.request('camera/night', { mode: 'read' })).mode);
        this.nightLoaded = true;
        this.nodes['night-note'].hidden = true;
        this.cameraOk();
      } catch (error) {
        this.nightLoaded = true;  // Do not retry in a loop; the buttons still work.
        this.nodes['night-note'].textContent = 'Mode illisible';
        this.message(error.message, true);
      } finally { this.nightLoading = false; }
    }

    async nightSet(mode) {
      if (this.nightLoading) return;
      this.nightLoading = true;
      try {
        this.showNight((await this.request('camera/night', { mode })).mode);
        this.nodes['night-note'].hidden = true;
        this.cameraOk();
      } catch (error) { this.message(error.message, true); }
      finally { this.nightLoading = false; }
    }

    // Pan/tilt of the Tapo. Independent of the arm and of arming; the server ends every pulse with a stop.
    ptzPulse() {
      const value = Number(this.nodes['ptz-pulse']?.value);
      return Number.isFinite(value) ? Math.min(800, Math.max(100, value)) : 450;
    }

    async loadPtzPresets() {
      const result = await this.request('camera/ptz-preset', { op: 'list' });
      const select = this.nodes['ptz-preset-list'];
      const current = select.value;
      select.replaceChildren(new Option('Aucune vue', ''),
        ...(result.presets || []).map(item => new Option(item.name || item.token, item.token)));
      if ((result.presets || []).some(item => item.token === current)) select.value = current;
      this.nodes['ptz-preset-state'].textContent = (result.presets || []).length + ' vue(s) sur la caméra';
      this.controls();
    }

    async savePtzPreset() {
      const name = this.nodes['ptz-preset-name'].value.trim();
      if (!name) throw new Error('Donnez un nom à la vue.');
      await this.request('camera/ptz-preset', { op: 'save', name });
      this.nodes['ptz-preset-name'].value = '';
      await this.loadPtzPresets();
      this.message('Vue caméra mémorisée dans le Tapo.');
    }

    async gotoPtzPreset() {
      const token = this.nodes['ptz-preset-list'].value;
      if (!token) throw new Error('Choisissez une vue caméra.');
      try {
        await this.request('camera/ptz-preset', { op: 'goto', token });
      } finally {
        this.invalidateCameraMap('Vue PTZ modifiée — recalibration requise.');
      }
      this.message('Caméra positionnée sur la vue mémorisée.');
    }

    async ptzSend(direction, force = false) {
      if (this.ptzBusy && !force) return;
      this.ptzBusy = true;
      try {
        await this.request('camera/ptz', { direction, ms: this.ptzPulse() });
      }
      catch (error) { if (error.status !== 429) this.message(error.message, true); }
      finally {
        this.invalidateCameraMap('Mouvement PTZ — recalibration requise.');
        this.ptzBusy = false;
      }
    }

    // A telemetry read can hold the arm for a moment; a chained sub-step that meets it just retries.
    async moveSteady(target) {
      for (let attempt = 0; attempt < 8; attempt++) {
        try { return await this.move(target, null, true); }
        catch (error) {
          if (error.status !== 429) throw error;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
      }
      throw new Error('Le bras reste occupé.');
    }

    async goHome() {
      return this.stepTo({ kind: 'home' }, 'Retour au neutre', HOME_POSE, 'Position neutre atteinte.', true);
    }

    // "Aller à ce point" from the editor: the same measured approach as the return home, toward any valid pose.
    async goToPose(pose, label) {
      return this.stepTo({ kind: 'goto', pose: { ...pose } }, label, pose, label + ' : point atteint.', false);
    }

    async stepTo(body, label, goal, done, refreshFields) {
      if (this.state?.config.mode !== 'hardware') {
        this.homing = true;
        this.beginHoming(label, goal);
        try { return await this.move(body); }
        finally { this.homing = false; this.finishHoming(); }
      }
      const generation = this.motionGeneration;
      this.telemetryEnabled = true;  // arrival is confirmed from measured telemetry
      this.schedule(0);
      const alive = () => generation === this.motionGeneration && !!this.lease && this.active;
      this.homing = true;
      this.beginHoming(label, goal);
      const settle = async () => {
        const deadline = performance.now() + 15000;
        while (alive() && (this.pending || (this.state?.moving && !this.state?.blend) || !this.state?.ticket)) {
          if (performance.now() > deadline) throw new Error('Le bras n’a pas confirmé le mouvement.');
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        return alive();
      };
      // HQ picks each sub-step: bounded by the step limit and shrunk near the workspace edge,
      // so a far-out pose needs many small steps. The page just repeats until the gap closes.
      try {
        for (let step = 0; step < 120; step++) {
          if (!await settle()) return;
          if (!this.state.feedback?.actual) throw new Error('Retour du bras indisponible.');
          if (!await this.moveSteady(body)) return;
          this.schedule(80);
          if (!await settle()) return;
          const progress = this.state?.script;
          if (progress?.index === body.kind && progress.gap <= 0.25) break;
          if (step === 119) throw new Error(body.kind === 'home'
            ? 'Le bras n’atteint pas le neutre. Utilisez la page du bras ou la coupure physique.'
            : 'Le bras n’atteint pas ce point. Rapprochez-le, ou utilisez Retour au neutre.');
        }
        if (await settle()) {
          if (refreshFields) this.pilotFields(this.state.feedback?.actual || goal, this.state.feedback?.xyz);
          if (body.kind === 'home') this.celebrateCompletion();
          this.message(done);
        }
      } finally {
        this.homing = false;
        this.finishHoming();
      }
    }

    // What Déplacer would do from the measured pose: the largest joint change and the time it takes.
    moveCost() {
      const state = this.state;
      const from = state?.feedback?.actual;
      const to = this.mode === 'joints' ? this.fieldPose()
        : ikPose(this.form.x.valueAsNumber, this.form.y.valueAsNumber, this.form.z.valueAsNumber, this.form.t.valueAsNumber);
      if (!state || !from || !to || axisKeys.some(key => !Number.isFinite(to[key]))) return null;
      const delta = Math.max(...axisKeys.map(key => Math.abs(to[key] - from[key])));
      const speed = Math.min(state.config.speed, Math.max(1, this.nodes.speed.valueAsNumber || state.config.speed));
      return { delta, seconds: Math.max(.25, delta / (speed * DEG_PER_STEP)),
        tooFar: state.config.mode === 'hardware' && delta > state.config.step_limit, limit: state.config.step_limit };
    }

    renderMoveCost() {
      const speed = this.nodes.speed.valueAsNumber;
      const degrees = Number.isFinite(speed) ? `≈ ${decimal(speed * DEG_PER_STEP)} °/s` : '';
      if (this.nodes['speed-deg'].textContent !== degrees) this.nodes['speed-deg'].textContent = degrees;
      const cost = this.moveCost();
      const label = !cost ? 'Déplacer' : (cost.delta < .25 ? 'Déplacer · déjà sur la cible'
        : `Déplacer · ${decimal(cost.delta)}° · ≈ ${decimal(cost.seconds)} s`);
      if (this.nodes.move.textContent !== label) this.nodes.move.textContent = label;
      const note = this.nodes['move-note'];
      note.hidden = !cost?.tooFar;
      const approachBtn = this.nodes['move-approach'];
      if (approachBtn) {
        approachBtn.hidden = !cost?.tooFar;
        approachBtn.disabled = !this.armedNow || !cost?.tooFar;
        if (cost?.tooFar) {
          const stepsEst = Math.max(2, Math.ceil(cost.delta / Math.max(1, (cost.limit || 5) - .5)));
          const btnLabel = `Approcher en ≈ ${stepsEst} pas mesurés (${decimal(cost.delta)}°)`;
          if (approachBtn.textContent !== btnLabel) approachBtn.textContent = btnLabel;
        }
      }
      if (cost?.tooFar) {
        this.nodes.move.disabled = true;
        const text = `Écart de ${decimal(cost.delta)}° : au-delà d’un pas physique (${cost.limit}°), utilisez « Approcher en pas mesurés » ci-dessus ou rapprochez la cible.`;
        if (note.textContent !== text) note.textContent = text;
      }
    }

    // Progress of the move under way, from the server's elapsed and planned seconds, also shown in the status strip.
    renderMotionProgress() {
      const clock = this.motionClock;
      const strip = this.nodes['motion-progress'];
      strip.hidden = !clock || clock.seconds < .6 || !!this.homingView;
      if (!clock) {
        clearInterval(this.motionTimer);
        this.motionTimer = null;
        return;
      }
      this.motionTimer ||= setInterval(() => this.renderMotionProgress(), 200);
      const elapsed = (performance.now() - clock.t0) / 1000;
      const share = clock.seconds > 0 ? Math.min(1, elapsed / clock.seconds) : 1;
      const left = Math.max(0, clock.seconds - elapsed);
      const leftText = left > .5 ? `≈ ${Math.ceil(left)} s` : 'confirmation…';
      this.nodes['motion-fill'].style.width = (share * 100).toFixed(1) + '%';
      this.nodes['motion-bar'].setAttribute('aria-valuenow', String(Math.round(share * 100)));
      const leftLabel = left > .5 ? leftText + ' restantes' : 'Confirmation…';
      if (this.nodes['motion-left'].textContent !== leftLabel) this.nodes['motion-left'].textContent = leftLabel;
      const done = `Écoulé · ${decimal(Math.min(elapsed, clock.seconds))} s sur ${decimal(clock.seconds)} s`;
      if (this.nodes['motion-elapsed'].textContent !== done) this.nodes['motion-elapsed'].textContent = done;
      const status = 'En mouvement · ' + leftText;
      if (this.nodes['arm-state'].textContent !== status) this.nodes['arm-state'].textContent = status;
    }

    // One move straight to neutral, for a pose too far out for the stepped return. Needs a second
    // click inside the page (a native dialog would blur the window and disarm).
    async goHomeDirect() {
      const button = this.nodes['home-direct'];
      const hardware = this.state?.config.mode === 'hardware';
      if (hardware && !this.homeConfirm) {
        this.homeConfirm = true;
        button.textContent = 'Confirmer : neutre direct';
        this.message('Dégagez la zone et gardez la coupure physique à portée. Un seul mouvement ramène le bras au neutre à vitesse réduite. Cliquez de nouveau pour confirmer.');
        clearTimeout(this.homeTimer);
        this.homeTimer = setTimeout(() => this.resetHomeDirect(), 8000);
        return;
      }
      this.resetHomeDirect();
      if (hardware) { this.telemetryEnabled = true; this.schedule(0); }
      const generation = this.motionGeneration;
      this.homing = true;
      this.beginHoming('Retour direct au neutre');
      try {
        if (!await this.move({ kind: 'home_direct', confirmed: true })) return;
        if (!hardware) return;
        const deadline = performance.now() + 45000;
        while (generation === this.motionGeneration && this.lease && this.state?.moving) {
          if (performance.now() > deadline) throw new Error('Le bras n’a pas confirmé le retour au neutre.');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (generation === this.motionGeneration && this.state?.feedback?.actual) {
          this.pilotFields(this.state.feedback.actual, this.state.feedback.xyz);
          this.celebrateCompletion();
          this.message('Neutre atteint.');
        }
      } finally {
        this.homing = false;
        this.finishHoming();
      }
    }

    resetHomeDirect() {
      clearTimeout(this.homeTimer);
      this.homeConfirm = false;
      this.nodes['home-direct'].textContent = 'Neutre direct';
    }

    jogStepOnce(button) {
      return this.run(async () => {
        const key = button.dataset.step;
        const linear = ['x', 'y', 'z'].includes(key);
        // A jog starts at the measured/simulated pose and ignores the edited fields:
        // only the selected axis receives a bounded increment.
        const feedback = this.state?.feedback;
        if (!feedback) throw new Error('Retour du bras indisponible.');
        const target = this.mode === 'joints'
          ? { kind: 'joints', pose: { ...feedback.actual } }
          : { kind: 'cartesian', xyz: { ...feedback.xyz, t: feedback.actual.hand } };
        const values = this.mode === 'joints' ? target.pose : target.xyz;
        values[key] += Number(button.dataset.direction) * Number(this.nodes[linear ? 'linear-step' : 'angle-step'].value);
        this.playHudSound('jog');
        this.haptic(12);
        await this.move(target, button);
      });
    }

    jogPress(button, identity) {
      if (this.jog || button.disabled || !this.lease) return;
      button.classList.add('is-pressed');
      const jog = { button, identity, repeated: false, timer: null, busy: false };
      this.jog = jog;
      const tick = async () => {
        if (this.jog !== jog || !this.active || !this.lease || button.disabled) return;
        if (!this.pending && !this.state?.moving && !jog.busy) {
          jog.repeated = true;
          jog.busy = true;
          try { await this.jogStepOnce(button); } finally { jog.busy = false; }
        }
        if (this.jog === jog && this.active && this.lease && !button.disabled) {
          jog.timer = setTimeout(tick, 190);
        }
      };
      jog.timer = setTimeout(tick, 420);
    }

    jogRelease(button, identity, accepted) {
      button.classList.remove('is-pressed');
      if (this.jog?.button !== button || this.jog.identity !== identity) return;
      const wasRepeated = this.jog.repeated;
      clearTimeout(this.jog.timer);
      this.jog = null;
      if (!accepted || button.disabled || wasRepeated) return;
      this.jogStepOnce(button);
    }

    fillSettings(config) {
      const form = this.nodes.settings.elements;
      for (const key of ['mode', 'transport', 'arm_ip', 'arm_timeout', 'camera_ip', 'camera_tls_sha256', 'camera_timeout', 'quality',
        'serial_port', 'speed', 'acceleration', 'step_limit', 'load_warn', 'load_critical', 'estop_ip', 'estop_port']) form[key].value = config[key] ?? '';
      form.camera_required.checked = config.camera_required !== false;
      form.estop_required.checked = config.estop_required === true;
      form.estop_require_signed.checked = config.estop_require_signed === true;
      form.torque_telemetry_required.checked = config.torque_telemetry_required !== false;
      for (const [key, pair] of Object.entries({ ...config.joint_limits, ...config.workspace })) {
        form[key + '-min'].value = pair[0];
        form[key + '-max'].value = pair[1];
      }
      for (const [key, pair] of Object.entries(config.joint_limits)) {
        this.form[key].min = pair[0];
        this.form[key].max = pair[1];
        const slider = this.nodes['slider-' + key];
        if (slider) {
          slider.min = pair[0];
          slider.max = pair[1];
          slider.step = .1;
        }
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
      if (this.nodes['serial-ports'] && Array.isArray(this.state?.serial_ports)) {
        this.nodes['serial-ports'].replaceChildren(...this.state.serial_ports.map(p => {
          const opt = document.createElement('option');
          opt.value = p;
          return opt;
        }));
      }
      this.fillKeepout(config.keepout || []);
    }

    clearPasswords() {
      this.nodes.settings.elements.camera_user.value = '';
      this.nodes.settings.elements.camera_password.value = '';
      this.nodes.settings.elements.camera_cloud_password.value = '';
      this.nodes.settings.elements.estop_token.value = '';
    }

    async saveSettings(forget = false) {
      if (this.nodes['settings-fields'].disabled) return;
      const form = this.nodes.settings.elements;
      const data = {};
      for (const key of ['mode', 'transport', 'arm_ip', 'camera_ip', 'camera_tls_sha256', 'quality', 'serial_port', 'estop_ip']) data[key] = form[key].value.trim();
      for (const key of ['arm_timeout', 'camera_timeout', 'speed', 'acceleration', 'step_limit', 'load_warn', 'load_critical', 'estop_port']) data[key] = form[key].valueAsNumber;
      data.keepout = this.readKeepout();
      data.camera_required = form.camera_required.checked;
      data.estop_required = form.estop_required.checked;
      data.estop_require_signed = form.estop_require_signed.checked;
      data.torque_telemetry_required = form.torque_telemetry_required.checked;
      for (const key of ['camera_user', 'camera_password', 'camera_cloud_password']) {
        if (forget || form[key].value) data[key] = forget ? '' : form[key].value;
      }
      if (form.estop_token.value) data.estop_token = form.estop_token.value;
      const read = (keys) => Object.fromEntries(keys.map(key => [key, [form[key + '-min'].valueAsNumber, form[key + '-max'].valueAsNumber]]));
      data.joint_limits = read(axisKeys);
      data.workspace = read(['x', 'y', 'z']);
      this.clearPasswords();
      await this.request('settings', data);
      this.stopVideo();
      this.havePoseFeedback = false;
      this.nightLoaded = false;
      this.render(await this.request('status'));
      this.message('Réglages enregistrés.');
    }

    setCommission(name, ok, text) {
      this.commission[name] = { ok, text };
      const output = this.host.querySelector(`[data-commission-output="${name}"]`);
      if (output) {
        output.textContent = text;
        output.dataset.state = ok ? 'ok' : 'warn';
      }
      const step = this.host.querySelector(`[data-commission-step="${name}"]`);
      step?.classList.toggle('is-ok', ok);
      step?.classList.toggle('is-warn', !ok);
    }

    async commissionCheck(name) {
      const state = this.state;
      if (!state) throw new Error('État Robotique indisponible.');
      try {
        if (name === 'limits') {
          await this.request('preview', { kind: 'home' });
          this.setCommission(name, true, 'Neutre résolu dans les limites');
        } else if (name === 'path') {
          if (state.config.mode !== 'simulation') {
            this.setCommission(name, false, 'Réservé à la simulation');
          } else {
            const pose = { ...HOME_POSE, base: 2 };
            await this.request('sequence', { steps: [{ kind: 'joints', pose }] });
            this.setCommission(name, true, 'Trajectoire simulée valide');
          }
        } else if (name === 'camera') {
          if (state.config.mode === 'simulation') this.setCommission(name, true, 'Non requis en simulation');
          else if (state.camera_live) this.setCommission(name, true, 'Flux actif');
          else this.setCommission(name, false, 'Démarrez le flux caméra');
        } else if (name === 'estop') {
          if (state.config.mode === 'simulation') this.setCommission(name, true, 'Simulé · sain');
          else if (state.estop?.mode === 'hardware' && state.estop.healthy === true) {
            this.setCommission(name, true, 'Contact fermé · surveillé');
          } else if (state.estop?.mode === 'hardware') {
            this.setCommission(name, false, 'Contact ouvert ou moniteur injoignable');
          } else this.setCommission(name, false, 'Moniteur E-stop non configuré');
        } else throw new Error('Contrôle de mise en service inconnu.');
      } catch (error) {
        this.setCommission(name, false, error.message);
      }
      const values = Object.values(this.commission);
      const all = values.length === 4 && values.every(item => item.ok);
      this.nodes['commission-status'].textContent = all
        ? 'Contrôles logiciels complets. Refaites les vérifications physiques avant de déplacer le bras.'
        : 'Certains contrôles sont incomplets ou non vérifiables sans matériel.';
    }

    async commissionAll() {
      for (const name of ['limits', 'path', 'camera', 'estop']) await this.commissionCheck(name);
      this.message('Contrôles de mise en service terminés.');
    }

    async loadRoutines() {
      const generation = this.generation;
      const result = await this.request('routines');
      if (!this.active || generation !== this.generation) return;
      this.routines = result.routines || {};
      this.renderRoutines();
    }

    renderRoutines() {
      const select = this.nodes.routines;
      const selected = select.value;
      select.replaceChildren(new Option('Choisir…', ''),
        ...Object.entries(this.routines).map(([id, item]) => new Option(item.name, id)));
      if (this.routines[selected]) select.value = selected;
      this.controls();
    }

    async storeRoutine() {
      if (!this.steps.length) throw new Error('Ajoutez au moins une étape à la séquence.');
      const name = this.nodes['routine-name'].value.trim();
      if (!name) throw new Error('Donnez un nom à la routine.');
      await this.request('routines', { action: 'save', name, steps: this.steps,
        parameters: { base_delta: this.nodes['routine-base-delta'].valueAsNumber || 0,
          repeats: this.nodes['routine-repeats'].valueAsNumber || 1 } });
      this.nodes['routine-name'].value = '';
      await this.loadRoutines();
      this.message('Routine enregistrée. Ses étapes seront revalidées quand la séquence sera validée ou jouée.');
    }

    loadRoutine() {
      const id = this.nodes.routines.value;
      const item = this.routines?.[id];
      if (!item) throw new Error('Choisissez une routine enregistrée.');
      const parameters = item.parameters || {};
      const delta = Number(parameters.base_delta) || 0;
      const repeats = Math.max(1, Math.min(8, Number(parameters.repeats) || 1));
      const base = item.steps.map(step => ({ kind: 'joints',
        pose: { ...step.pose, base: step.pose.base + delta } }));
      const fits = Math.max(1, Math.min(repeats, Math.floor(16 / base.length)));
      this.steps = Array.from({ length: fits }, () => base.map(step => ({
        kind: 'joints', pose: { ...step.pose },
      }))).flat();
      this.showSequence();
      this.controls();
      this.message('Routine chargée dans la séquence. Validez-la avant de la jouer.');
    }

    async deleteRoutine(button) {
      const id = this.nodes.routines.value;
      if (!this.routines?.[id]) throw new Error('Choisissez une routine enregistrée.');
      if (!this.askConfirm('routine-' + id, button, 'Confirmer : supprimer',
        'Cliquez de nouveau pour supprimer cette routine.')) return;
      await this.request('routines', { action: 'delete', id });
      await this.loadRoutines();
      this.message('Routine supprimée.');
    }

    fillKeepout(zones) {
      this.keepoutZones = (Array.isArray(zones) ? zones : []).map(zone => ({
        name: String(zone?.name || ''),
        x: [Number(zone?.x?.[0]), Number(zone?.x?.[1])],
        y: [Number(zone?.y?.[0]), Number(zone?.y?.[1])],
        z: [Number(zone?.z?.[0]), Number(zone?.z?.[1])],
      }));
      this.renderKeepout();
    }

    renderKeepout() {
      const rows = this.nodes['keepout-rows'];
      if (!this.keepoutZones?.length) {
        const empty = document.createElement('p');
        empty.className = 'rb-keepout-empty';
        empty.textContent = 'Aucune zone. Le point terminal peut parcourir toute l’enveloppe.';
        rows.replaceChildren(empty);
        return;
      }
      rows.replaceChildren(...this.keepoutZones.map((zone, index) => {
        const row = document.createElement('div');
        row.className = 'rb-keepout-row';
        const name = document.createElement('label');
        name.textContent = 'Nom';
        const nameInput = document.createElement('input');
        nameInput.value = zone.name;
        nameInput.maxLength = 40;
        nameInput.dataset.koName = String(index);
        name.append(nameInput);
        row.append(name);
        for (const axis of ['x', 'y', 'z']) {
          for (const [bound, label] of [[0, 'Min'], [1, 'Max']]) {
            const cell = document.createElement('label');
            cell.textContent = axis.toUpperCase() + ' ' + label;
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '1';
            input.value = zone[axis][bound];
            input.dataset.koIndex = String(index);
            input.dataset.koAxis = axis;
            input.dataset.koBound = String(bound);
            cell.append(input);
            row.append(cell);
          }
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        setGlyph(remove, '✕');
        remove.title = 'Retirer cette zone';
        remove.setAttribute('aria-label', 'Retirer ' + (zone.name || 'cette zone'));
        remove.dataset.koRemove = String(index);
        row.append(remove);
        return row;
      }));
    }

    readKeepout() {
      const rows = [...this.nodes['keepout-rows'].querySelectorAll('.rb-keepout-row')];
      return rows.map((row, index) => {
        const name = row.querySelector(`[data-ko-name="${index}"]`)?.value.trim();
        if (!name) throw new Error('Chaque zone doit avoir un nom.');
        const zone = { name };
        for (const axis of ['x', 'y', 'z']) {
          const pair = [0, 1].map(bound => row.querySelector(
            `[data-ko-index="${index}"][data-ko-axis="${axis}"][data-ko-bound="${bound}"]`)?.valueAsNumber);
          if (!pair.every(Number.isFinite) || pair[0] >= pair[1]) {
            throw new Error('Bornes de zone invalides pour ' + name + ' · ' + axis.toUpperCase() + '.');
          }
          zone[axis] = pair;
        }
        return zone;
      });
    }

    addKeepout() {
      if ((this.keepoutZones?.length || 0) >= 12) throw new Error('Douze zones au maximum.');
      this.keepoutZones = this.readKeepout();
      this.keepoutZones.push({ name: 'Zone ' + (this.keepoutZones.length + 1),
        x: [100, 200], y: [-100, 100], z: [25, 100] });
      this.renderKeepout();
    }

    removeKeepout(index) {
      this.keepoutZones = this.readKeepout();
      this.keepoutZones.splice(index, 1);
      this.renderKeepout();
    }

    renderLoadWatch(value) {
      const canvas = this.nodes['load-trend'];
      if (!canvas) return;
      const has = Number.isFinite(value);
      if (has) {
        this.loadTrend.push(value);
        if (this.loadTrend.length > 90) this.loadTrend.shift();
      }
      const config = this.state?.config || {};
      const warn = Number(config.load_warn ?? 700);
      const critical = Number(config.load_critical ?? 900);
      const worst = has ? value : 0;
      const alert = this.nodes['load-alert'];
      alert.textContent = !has ? 'Charge indisponible'
        : worst >= critical ? 'Charge critique · ' + Math.round(worst)
        : worst >= warn ? 'Charge élevée · ' + Math.round(worst)
        : 'Charge sous surveillance';
      alert.dataset.state = worst >= critical ? 'critical' : worst >= warn ? 'warn' : '';
      const peakKey = axisKeys.reduce((best, key) =>
        (this.loadPeaks[key] || 0) > (this.loadPeaks[best] || 0) ? key : best, axisKeys[0]);
      const peak = this.loadPeaks[peakKey] || 0;
      this.nodes['load-peak'].textContent = peak ? 'Pic · ' + axes[peakKey] + ' ' + Math.round(peak) : 'Pic —';
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(rect.width * ratio);
      const height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight')
        && !document.body.classList.contains('theme-oled');
      const palette = light ? {
        line: '#08724f', fillTop: 'rgba(8, 114, 79, .24)', fillBot: 'rgba(8, 114, 79, 0)',
        warn: '#a35a00', critical: '#b4233d', grid: '#c9dcdb',
      } : {
        line: '#73edce', fillTop: 'rgba(115, 237, 206, .3)', fillBot: 'rgba(115, 237, 206, 0)',
        warn: '#ffc176', critical: '#ff8ca0', grid: 'rgba(52, 101, 107, .45)',
      };
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1;
      for (let index = 1; index < 4; index++) {
        const y = rect.height * index / 4;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
      }
      for (const [level, color] of [[warn, palette.warn], [critical, palette.critical]]) {
        const y = rect.height - Math.min(1, Math.max(0, level / LOAD_FULL_SCALE)) * rect.height;
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (this.loadTrend.length > 1) {
        const pts = this.loadTrend.map((sample, index) => [
          index / Math.max(1, this.loadTrend.length - 1) * rect.width,
          rect.height - Math.min(1, sample / LOAD_FULL_SCALE) * rect.height,
        ]);
        const grad = ctx.createLinearGradient(0, 0, 0, rect.height);
        grad.addColorStop(0, palette.fillTop);
        grad.addColorStop(1, palette.fillBot);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], rect.height);
        pts.forEach(([px, py]) => ctx.lineTo(px, py));
        ctx.lineTo(pts.at(-1)[0], rect.height);
        ctx.closePath();
        ctx.fill();

        const latest = this.loadTrend.at(-1) || 0;
        const strokeColor = latest >= critical ? palette.critical : latest >= warn ? palette.warn : palette.line;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        pts.forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
        ctx.stroke();
        const [lx, ly] = pts.at(-1);
        ctx.fillStyle = strokeColor;
        ctx.beginPath();
        ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    renderProprioception(state) {
      if (!this.nodes.proprio) return;
      const actual = state?.feedback?.actual;
      const target = state?.target;
      const sim = state?.config?.mode === 'simulation';
      const set = (key, value) => {
        if (this.nodes[key] && this.nodes[key].textContent !== value) this.nodes[key].textContent = value;
      };
      if (!actual || axisKeys.some(key => !Number.isFinite(actual[key]))) {
        set('proprio-state', 'En attente de mesure');
        if (this.nodes['proprio-state']) this.nodes['proprio-state'].dataset.state = '';
        for (const key of ['proprio-moment', 'proprio-shoulder', 'proprio-elbow', 'proprio-drift']) set(key, '—');
        return;
      }
      const sRad = rad(actual.shoulder);
      const seRad = rad(actual.shoulder + actual.elbow);
      const rMoment = Math.abs(UPPER * Math.sin(sRad + OFFSET) + LOWER * Math.sin(seRad));
      const expShoulder = 0.55 * Math.sin(sRad + OFFSET) + 0.65 * Math.sin(seRad);
      const expElbow = 1.25 * Math.sin(seRad);
      const resShoulder = Number.isFinite(target?.shoulder) ? target.shoulder - actual.shoulder : 0;
      const resElbow = Number.isFinite(target?.elbow) ? target.elbow - actual.elbow : 0;
      const driftShoulder = resShoulder - (sim ? 0 : expShoulder);
      const driftElbow = resElbow - (sim ? 0 : expElbow);
      const netDrift = Math.max(Math.abs(driftShoulder), Math.abs(driftElbow));
      const sign = v => (v >= 0 ? '+' : '') + format(v, '°');
      set('proprio-moment', Math.round(rMoment) + ' mm');
      set('proprio-shoulder', 'Flexion ' + sign(expShoulder) + ' · résiduel ' + sign(resShoulder));
      set('proprio-elbow', 'Flexion ' + sign(expElbow) + ' · résiduel ' + sign(resElbow));
      set('proprio-drift', format(netDrift, '°') + (netDrift < 0.8 ? ' · nominal' : netDrift < 2.0 ? ' · jeu léger' : ' · dérive'));
      set('proprio-state', sim ? 'Modèle statique (simulation)' : (netDrift < 0.8 ? 'Nominal' : netDrift < 2.0 ? 'Jeu sous charge' : 'Dérive à contrôler'));
      if (this.nodes['proprio-state']) this.nodes['proprio-state'].dataset.state = netDrift >= 2.0 ? 'warn' : 'ok';
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
      this.renderPresetChips();
      this.renderTransferSelects();
      this.controls();
    }

    renderTransferSelects() {
      const entries = Object.entries(this.presets || {});
      if (this.nodes['tx-source']) {
        const cur = this.nodes['tx-source'].value;
        this.nodes['tx-source'].replaceChildren(
          new Option('Zone A · X 240 · Y −90 · Z 75 mm', '__default_src'),
          new Option('Position actuelle du bras', '__actual'),
          ...entries.map(([id, item]) => new Option('Position · ' + item.name, id)),
        );
        if ([...this.nodes['tx-source'].options].some(o => o.value === cur)) this.nodes['tx-source'].value = cur;
      }
      if (this.nodes['tx-dest']) {
        const cur = this.nodes['tx-dest'].value;
        this.nodes['tx-dest'].replaceChildren(
          new Option('Zone B · X 240 · Y +90 · Z 75 mm', '__default_dst'),
          new Option('Cible des champs', '__fields'),
          ...entries.map(([id, item]) => new Option('Position · ' + item.name, id)),
        );
        if ([...this.nodes['tx-dest'].options].some(o => o.value === cur)) this.nodes['tx-dest'].value = cur;
      }
    }

    renderPresetChips() {
      const wrap = this.nodes['preset-chips'];
      if (!wrap) return;
      const entries = Object.entries(this.presets || {});
      wrap.hidden = !entries.length;
      if (!entries.length) { wrap.replaceChildren(); return; }
      wrap.replaceChildren(...entries.slice(0, 8).map(([id, item]) => {
        const chip = document.createElement('div');
        chip.className = 'rb-preset-chip';
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'rb-preset-chip-load';
        loadBtn.textContent = item.name;
        loadBtn.title = 'Charger et prévisualiser « ' + item.name + ' »';
        loadBtn.addEventListener('click', () => {
          this.nodes.presets.value = id;
          this.nodes['preset-name'].value = item.name || '';
          this.controls();
          this.run(() => this.preview({ kind: 'preset', id }, true));
        });
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        setGlyph(goBtn, '→');
        goBtn.dataset.presetChipGo = id;
        goBtn.disabled = !this.armedNow;
        goBtn.title = 'Exécuter « ' + item.name + ' »';
        goBtn.setAttribute('aria-label', 'Exécuter ' + item.name);
        goBtn.addEventListener('click', () => {
          this.nodes.presets.value = id;
          this.controls();
          this.run(() => this.move({ kind: 'preset', id }));
        });
        chip.append(loadBtn, goBtn);
        return chip;
      }));
    }

    preset() {
      const id = this.nodes.presets.value;
      if (!id) throw new Error('Choisissez une position enregistrée.');
      return { kind: 'preset', id };
    }

    async preview(target, load = false) {
      this.clearPreview();
      const version = this.previewVersion;
      const result = await this.request('preview', { ...target, ...this.floorGuardArgs() });
      if (!this.active || this.previewVersion !== version) return;
      if (load) {
        this.pilotFields(result.pose, result.xyz);
        this.selectMode('joints');
      }
      this.previewPoint = result.xyz;
      this.nodes['preview-result'].textContent = this.xyzText(result.xyz);
      this.nodes['preview-result'].hidden = false;
      this.nodes['plot-preview'].hidden = false;
      this.drawPosition();
      return result;
    }

    showSequence() {
      if (!this.steps.length) {
        const empty = document.createElement('li');
        empty.className = 'rb-seq-empty';
        empty.textContent = 'Aucune étape. Ajoutez la cible courante pour commencer.';
        this.nodes.steps.replaceChildren(empty);
        return;
      }
      this.nodes.steps.replaceChildren(...this.steps.map((step, index) => {
        const li = document.createElement('li');
        li.className = 'rb-seq-step';
        const number = document.createElement('b');
        number.textContent = String(index + 1);
        const fields = document.createElement('div');
        fields.className = 'rb-seq-fields';
        const labels = step.kind === 'joints' ? axes : coordinates;
        const values = step.kind === 'joints' ? step.pose : step.xyz;
        for (const [key, label] of Object.entries(labels)) {
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'rb-seq-input';
          input.step = '.1';
          input.inputMode = 'decimal';
          const value = values?.[key];
          input.value = Number.isFinite(Number(value)) ? String(value) : '';
          input.dataset.seqIndex = String(index);
          input.dataset.seqKey = key;
          input.title = label;
          input.setAttribute('aria-label', 'Étape ' + (index + 1) + ' · ' + label);
          fields.append(input);
        }
        const tools = document.createElement('div');
        tools.className = 'rb-seq-tools';
        for (const [glyph, title, attribute, disabled] of [
          ['↑', 'Monter cette étape', 'seqUp', index === 0],
          ['↓', 'Descendre cette étape', 'seqDown', index === this.steps.length - 1],
          ['✕', 'Retirer cette étape', 'seqDrop', false],
        ]) {
          const button = document.createElement('button');
          button.type = 'button';
          setGlyph(button, glyph);
          button.title = title;
          button.setAttribute('aria-label', title);
          button.dataset[attribute] = String(index);
          button.disabled = disabled;
          tools.append(button);
        }
        li.append(number, fields, tools);
        return li;
      }));
    }

    moveSequenceStep(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= this.steps.length) return;
      [this.steps[index], this.steps[target]] = [this.steps[target], this.steps[index]];
      this.showSequence();
    }

    dropSequenceStep(index) {
      if (index < 0 || index >= this.steps.length) return;
      this.steps.splice(index, 1);
      this.showSequence();
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

    captureLoadSnap() {
      const loadSnap = this.state?.feedback?.load || {};
      return Object.fromEntries(
        axisKeys.filter(k => Number.isFinite(loadSnap[k])).map(k => [k, Math.round(loadSnap[k] * 10) / 10])
      );
    }

    async checkTorqueDelta(expected, tol = 180) {
      const liveLoad = this.state?.feedback?.load;
      if (!liveLoad || !expected) return;
      for (const k of axisKeys) {
        if (Number.isFinite(liveLoad[k]) && Number.isFinite(expected[k])) {
          const delta = Math.abs(liveLoad[k] - expected[k]);
          if (delta > tol) {
            await this.cancel().catch(() => {});
            throw new Error(`Choc / obstacle détecté sur ${axes[k]} (Δτ = ${Math.round(delta)} > ${tol}) — lecture interrompue.`);
          }
        }
      }
    }

    loadRecTorque(id) {
      try {
        const store = JSON.parse(localStorage.getItem('hq_robotics_rec_torque_v1') || '{}');
        return Array.isArray(store[id]) ? store[id] : null;
      } catch (_) { return null; }
    }

    saveRecTorque(id, steps) {
      try {
        const store = JSON.parse(localStorage.getItem('hq_robotics_rec_torque_v1') || '{}');
        store[id] = steps;
        localStorage.setItem('hq_robotics_rec_torque_v1', JSON.stringify(store));
      } catch (_) {}
    }

    async playReviewedScript(script) {
      const mode = this.state?.config.mode;
      const hardware = mode === 'hardware';
      if (!['simulation', 'hardware'].includes(mode) || !this.lease || this.playingScript) {
        throw new Error('Armez le poste depuis Robotique avant de lancer le script.');
      }
      const generation = this.motionGeneration;
      this.playingScript = true;
      // Arrival is confirmed from measured telemetry, so the polling must read the arm.
      if (hardware) { this.telemetryEnabled = true; this.schedule(0); }
      this.controls();
      const active = () => this.active && this.lease && generation === this.motionGeneration
        && this.state?.config.mode === mode;
      const unconfirmed = hardware ? 'Le bras n’a pas confirmé le mouvement.' : 'Le simulateur n’a pas confirmé le mouvement.';
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const idle = async (needTicket) => {
        const started = performance.now();
        // A shaped leg streamed in fluid mode is one step that can outlast the usual wait: the server
        // reports its planned duration, and the wait follows it with a margin.
        const limit = () => Math.max(hardware ? 20000 : 30000, ((this.state?.script?.seconds || 0) + 10) * 1000);
        while (active() && ((needTicket && !this.state?.ticket) || (this.state?.moving && !this.state?.blend) || this.pending)) {
          if (performance.now() - started > limit()) throw new Error(unconfirmed);
          await wait(60);
        }
        return !!active();
      };
      try {
        const recordedTorque = [];
        const baseline = script.torque_baseline;
        const tol = Number(baseline?.tolerance) || 180;
        const legEnds = script.plan && Array.isArray(script.plan.points) && Array.isArray(script.plan.legs) && window.HqRobotics3D?.planPath
          ? window.HqRobotics3D.planPath([script.start, ...script.plan.points], [null, ...script.plan.legs]).ends : null;
        for (let index = 0; index < script.steps.length; index++) {
          // On the real arm HQ approaches each approved step in measured sub-steps (step limit),
          // re-reading the arm before every one. The simulator takes the step in one move.
          for (let sub = 0; sub < (hardware ? 60 : 1); sub++) {
            if (!await idle(true)) return false;
            if (!await this.moveSteady({
              kind: 'reviewed_script', id: script.id, digest: script.digest, index,
            })) return false;
            if (!hardware) break;
            if (!await idle(false)) return false;
            const liveLoad = this.state?.feedback?.load;
            if (liveLoad && baseline?.steps?.[index]) {
              const expected = baseline.steps[index];
              for (const k of axisKeys) {
                if (Number.isFinite(liveLoad[k]) && Number.isFinite(expected[k])) {
                  const delta = Math.abs(liveLoad[k] - expected[k]);
                  if (delta > tol) {
                    await this.cancel().catch(() => {});
                    throw new Error(`Choc / obstacle détecté sur ${axes[k]} (Δτ = ${Math.round(delta)} > ${tol}) — lecture interrompue.`);
                  }
                }
              }
            }
            const progress = this.state?.script;
            // A shaped leg streamed in fluid mode reports its last step: skip the steps it covered.
            if (progress && progress.index >= index && progress.index < script.steps.length && progress.gap <= 0.25) {
              index = progress.index;
              break;
            }
            if (sub === 59) throw new Error('Le bras n’atteint pas l’étape du script.');
          }
          if (script.learnTorque && hardware) {
            const loadSnap = this.state?.feedback?.load || {};
            recordedTorque[index] = Object.fromEntries(
              axisKeys.filter(k => Number.isFinite(loadSnap[k])).map(k => [k, Math.round(loadSnap[k] * 10) / 10])
            );
          }
          const legIdx = legEnds ? legEnds.indexOf(index + 1) - 1 : index;
          const dwell = Number(script.plan?.legs?.[legIdx]?.dwell || 0);
          if (dwell > 0) {
            if (!await idle(false)) return false;
            if (this.stream && this.nodes.video?.videoWidth > 0) {
              try { this.captureVideoFrame((script.title || 'Scan') + ' #' + (index + 1)); } catch (_) {}
            }
            const until = performance.now() + dwell * 1000;
            while (active() && performance.now() < until) await wait(Math.min(100, until - performance.now()));
          }
        }
        if (!await idle(false)) return false;
        const ok = !!active();
        return script.learnTorque ? { completed: ok, recordedTorque } : ok;
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

    loadCameraMap() {
      try {
        const value = JSON.parse(localStorage.getItem('hq-robotics-camera-map') || 'null');
        if (!value || !Array.isArray(value.points) || value.points.length !== 3) return;
        const cfg = this.state?.config;
        if (cfg && ((value.camera_ip && value.camera_ip !== cfg.camera_ip) ||
            (value.quality && value.quality !== cfg.quality))) {
          this.invalidateCameraMap('Caméra ou profil vidéo modifié — recalibration requise.');
          return;
        }
        const points = value.points.map(point => ({
          u: Number(point.u), v: Number(point.v), x: Number(point.x), y: Number(point.y),
        }));
        if (!points.every(point => ['u', 'v', 'x', 'y'].every(key => Number.isFinite(point[key])))) return;
        this.cameraMap = {
          points,
          map: this.cameraAffine(points),
          meta: {
            camera_ip: value.camera_ip || '',
            quality: value.quality || '',
            ptz_preset: value.ptz_preset || '',
            width: Number(value.width) || 0,
            height: Number(value.height) || 0,
          },
        };
        this.calPixels = Object.fromEntries(points.map((point, index) =>
          [['a', 'b', 'c'][index], { u: point.u, v: point.v }]));
        this.fillCameraCalibration();
      } catch (error) {
        this.cameraMap = null;
      }
    }

    cameraAffine(points) {
      const [p1, p2, p3] = points;
      const det = p1.x * (p2.y - p3.y) - p1.y * (p2.x - p3.x) + (p2.x * p3.y - p3.x * p2.y);
      if (Math.abs(det) < 1e-6) throw new Error('Les trois points robot sont alignés.');
      const solve = (values) => {
        const [u1, u2, u3] = values;
        return {
          a: (u1 * (p2.y - p3.y) - p1.y * (u2 - u3) + (u2 * p3.y - u3 * p2.y)) / det,
          b: (p1.x * (u2 - u3) - u1 * (p2.x - p3.x) + (p2.x * u3 - p3.x * u2)) / det,
          c: (p1.x * (p2.y * u3 - p3.y * u2) - p1.y * (p2.x * u3 - p3.x * u2)
              + u1 * (p2.x * p3.y - p3.x * p2.y)) / det,
        };
      };
      const horizontal = solve(points.map(point => point.u));
      const vertical = solve(points.map(point => point.v));
      return { a: horizontal.a, b: horizontal.b, c: horizontal.c,
        d: vertical.a, e: vertical.b, f: vertical.c };
    }

    fillCameraCalibration(reason = '') {
      const points = this.cameraMap?.points || [];
      for (const [index, key] of ['a', 'b', 'c'].entries()) {
        const point = points[index];
        const x = this.host.querySelector(`[data-cal-x="${key}"]`);
        const y = this.host.querySelector(`[data-cal-y="${key}"]`);
        const pixel = this.host.querySelector(`[data-cal-pixel="${key}"]`);
        if (x) x.value = Number.isFinite(point?.x) ? point.x : '';
        if (y) y.value = Number.isFinite(point?.y) ? point.y : '';
        if (pixel) pixel.textContent = Number.isFinite(point?.u) ? Math.round(point.u) + ', ' + Math.round(point.v) : '—';
      }
      const state = this.nodes['cal-state'];
      if (state) state.textContent = reason || (this.cameraMap
        ? 'Repère consultatif mémorisé. Invalidé automatiquement sur PTZ ou changement vidéo.'
        : 'Aucun repère. Trois points non alignés sont requis.');
      const show = this.host.querySelector('[data-cal-show]');
      if (show) show.checked = this.cameraMap ? show.checked : true;
      this.selectMonitor(this.monitor);
    }

    captureCalPoint(key) {
      if (!this.stream) throw new Error('Démarrez le direct avant de prendre un point.');
      this.calibrating = key;
      this.message('Cliquez le point ' + key.toUpperCase() + ' dans la vidéo.');
    }

    readCalibration() {
      const points = ['a', 'b', 'c'].map(key => {
        const pixel = this.calPixels[key];
        const x = Number(this.host.querySelector(`[data-cal-x="${key}"]`)?.valueAsNumber);
        const y = Number(this.host.querySelector(`[data-cal-y="${key}"]`)?.valueAsNumber);
        if (!pixel || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Complétez le point ' + key.toUpperCase() + ' et prenez-le dans la vidéo.');
        }
        return { u: pixel.u, v: pixel.v, x, y };
      });
      return points;
    }

    saveCameraMap() {
      const points = this.readCalibration();
      const meta = {
        camera_ip: this.state?.config?.camera_ip || '',
        quality: this.state?.config?.quality || '',
        ptz_preset: this.nodes['ptz-preset-list']?.value || '',
        width: this.nodes.video?.videoWidth || 0,
        height: this.nodes.video?.videoHeight || 0,
        saved_at: Date.now(),
      };
      this.cameraMap = { points, map: this.cameraAffine(points), meta };
      try { localStorage.setItem('hq-robotics-camera-map', JSON.stringify({ points, ...meta })); } catch (error) { /* private mode */ }
      this.fillCameraCalibration();
      this.drawCameraOverlay();
      this.message('Repère caméra mémorisé localement.');
    }

    setArGhost(script) {
      this.arGhostScript = script || null;
      this.drawCameraOverlay();
      this.assistant?.renderLibrary?.();
      if (script) {
        this.message(this.cameraMap && this.stream
          ? `Fantôme AR « ${script.label || script.title} » projeté sur le direct.`
          : 'Fantôme AR prêt — démarrez le direct et calibrez le repère caméra pour le voir sur la vidéo.');
      }
    }

    downloadCalibrationMat() {
      const svgText = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">
  <rect width="900" height="600" fill="#ffffff"/>
  <rect x="20" y="20" width="860" height="560" fill="none" stroke="#111" stroke-width="2" stroke-dasharray="8 6"/>
  <text x="450" y="55" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="bold" fill="#111">Transfert HQ · Mire Auto-Calibrage 3 Pastilles</text>
  <g transform="translate(150,180)">
    <circle r="44" fill="#ff1e1e"/><circle r="6" fill="#fff"/>
    <text y="74" text-anchor="middle" font-family="monospace" font-size="18" fill="#111">A (Rouge) · X 180 / Y -120 mm</text>
  </g>
  <g transform="translate(150,460)">
    <circle r="44" fill="#00d832"/><circle r="6" fill="#fff"/>
    <text y="74" text-anchor="middle" font-family="monospace" font-size="18" fill="#111">B (Vert) · X 320 / Y -120 mm</text>
  </g>
  <g transform="translate(720,320)">
    <circle r="44" fill="#1864ff"/><circle r="6" fill="#fff"/>
    <text y="74" text-anchor="middle" font-family="monospace" font-size="18" fill="#111">C (Bleu) · X 250 / Y 120 mm</text>
  </g>
</svg>`;
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'robotics-calibration-mat.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message('Mire 3 pastilles téléchargée (robotics-calibration-mat.svg).');
    }

    autoDetectCameraMarkers() {
      const video = this.nodes.video;
      if (!this.stream || !video?.videoWidth || !video?.videoHeight) {
        throw new Error('Démarrez le direct vidéo avant l’auto-calibrage.');
      }
      const w = 320, h = Math.max(180, Math.round(320 * video.videoHeight / video.videoWidth));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const rect = video.getBoundingClientRect();
      const acc = {
        a: { sx: 0, sy: 0, sw: 0 },
        b: { sx: 0, sy: 0, sw: 0 },
        c: { sx: 0, sy: 0, sw: 0 },
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          const dr = r - Math.max(g, b);
          const dg = g - Math.max(r, b);
          const db = b - Math.max(r, g);
          if (dr > 65) { acc.a.sx += x * dr; acc.a.sy += y * dr; acc.a.sw += dr; }
          if (dg > 55) { acc.b.sx += x * dg; acc.b.sy += y * dg; acc.b.sw += dg; }
          if (db > 65) { acc.c.sx += x * db; acc.c.sy += y * db; acc.c.sw += db; }
        }
      }
      const missing = ['a', 'b', 'c'].filter(k => acc[k].sw < 400);
      if (missing.length) {
        throw new Error(`Pastille(s) non détectée(s) : ${missing.map(k => k.toUpperCase()).join(', ')}. Vérifiez l’éclairage et la mire Rouge/Vert/Bleu.`);
      }
      const defaults = { a: [180, -120], b: [320, -120], c: [250, 120] };
      for (const k of ['a', 'b', 'c']) {
        const u = (acc[k].sx / acc[k].sw) / w * rect.width;
        const v = (acc[k].sy / acc[k].sw) / h * rect.height;
        this.calPixels[k] = { u, v };
        const xInput = this.host.querySelector(`[data-cal-x="${k}"]`);
        const yInput = this.host.querySelector(`[data-cal-y="${k}"]`);
        if (xInput && !xInput.value) xInput.value = String(defaults[k][0]);
        if (yInput && !yInput.value) yInput.value = String(defaults[k][1]);
      }
      this.saveCameraMap();
      this.message('Auto-calibrage 3 pastilles réussi et mémorisé.');
    }

    async exportCommissionReport() {
      const state = this.state || await this.request('status');
      let bb = { entries: [] };
      try { bb = await this.request('blackbox'); } catch (_) {}
      const entries = Array.isArray(bb.entries) ? bb.entries : [];
      const peakLoad = entries.reduce((m, e) => {
        const vals = Object.values(e.load || {}).filter(Number.isFinite).map(Math.abs);
        return vals.length ? Math.max(m, ...vals) : m;
      }, 0);
      const incidents = entries.filter(e => e.stop_latched || e.uncertain || e.incident).length;
      const cfg = state.config || {};
      const info = state.commissioned_info || {};
      const nowIso = new Date().toISOString();
      const lines = [
        '# Rapport de mise en service Robotique · Transfert HQ',
        '',
        `- **Date UTC :** ${nowIso}`,
        `- **Mode :** ${cfg.mode || '—'} · **Transport :** ${cfg.transport || 'http'}`,
        `- **Adresse / Port :** ${cfg.transport === 'serial' ? (cfg.serial_port || '—') : (cfg.arm_ip || '—')}`,
        `- **Profil :** ${cfg.profile || 'm2s-gripper-v1'} · **Révision :** \`${cfg.revision || '—'}\``,
        `- **Approuvé :** ${state.commissioned ? 'OUI' : 'NON'}`,
        `- **Firmware :** ${info.firmware_version || '—'} · **Opérateur :** ${info.operator || '—'}`,
        `- **Portes 2 & 3 signées :** ${info.gates_signed ? 'G2.1–G2.4 & G3.1–G3.6 PASS' : 'Non signées'}`,
        '',
        '## Sécurité & Télémétrie',
        `- **E-stop :** ${state.estop?.mode || '—'} · sain=${String(state.estop?.healthy)} · signé=${String(!!cfg.estop_require_signed)}`,
        `- **Couple (T:105) :** ${state.torque_state || '—'} · **Exigé :** ${cfg.torque_telemetry_required !== false}`,
        `- **Caméra requise :** ${cfg.camera_required !== false} · **TLS SHA-256 :** \`${cfg.camera_tls_sha256 || 'non épinglé'}\``,
        `- **Zones d’exclusion :** ${(cfg.keepout || []).length}`,
        `- **Journal noir :** ${entries.length} échantillons · pic charge ${Math.round(peakLoad)} · incidents ${incidents}`,
        '',
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `robotics-commissioning-report-${nowIso.slice(0, 10)}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message('Rapport de mise en service téléchargé.');
    }

    invalidateCameraMap(reason = 'Repère caméra invalidé — recalibration requise.') {
      if (!this.cameraMap && !Object.keys(this.calPixels || {}).length) return;
      this.cameraMap = null;
      this.calPixels = {};
      try { localStorage.removeItem('hq-robotics-camera-map'); } catch (error) { /* private mode */ }
      this.fillCameraCalibration(reason);
      this.drawCameraOverlay();
    }

    clearCameraMap() {
      this.cameraMap = null;
      this.calPixels = {};
      try { localStorage.removeItem('hq-robotics-camera-map'); } catch (error) { /* private mode */ }
      this.fillCameraCalibration();
      this.drawCameraOverlay();
      this.message('Repère caméra effacé.');
    }

    drawCameraOverlay() {
      const canvas = this.nodes['camera-overlay'];
      const meta = this.cameraMap?.meta;
      const vw = this.nodes.video?.videoWidth || 0;
      const vh = this.nodes.video?.videoHeight || 0;
      if (meta && vw && vh && ((meta.width && meta.width !== vw) || (meta.height && meta.height !== vh))) {
        this.invalidateCameraMap('Résolution vidéo modifiée — recalibration requise.');
        return;
      }
      const show = this.host.querySelector('[data-cal-show]');
      const visible = !!(this.cameraMap && this.stream && show?.checked);
      canvas.hidden = !visible;
      if (!visible || canvas.offsetParent === null) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(rect.width * ratio);
      const height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const map = this.cameraMap.map;
      const zScale = Math.hypot(map.a, map.d) * 0.48;
      const project = (x, y, z = 0) => ({ x: map.a * x + map.b * y + map.c,
        y: map.d * x + map.e * y + map.f - z * zScale });
      const arFull = this.host.querySelector('[data-cal-ar]')?.checked !== false;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const workspace = this.state?.config.workspace;
      if (workspace) {
        const corners = [[workspace.x[0], workspace.y[0]], [workspace.x[1], workspace.y[0]],
          [workspace.x[1], workspace.y[1]], [workspace.x[0], workspace.y[1]]].map(([x, y]) => project(x, y));
        ctx.strokeStyle = 'rgba(115, 237, 206, .65)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      }
      if (arFull) {
        // 3D Keep-out exclusion volumes projected onto the live camera feed
        for (const zone of this.state?.config.keepout || []) {
          const [x0, x1] = zone.x, [y0, y1] = zone.y, [z0, z1] = zone.z;
          const bot = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]].map(p => project(...p));
          const top = [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(p => project(...p));
          ctx.save();
          ctx.fillStyle = 'rgba(255, 110, 136, .14)';
          ctx.strokeStyle = 'rgba(255, 140, 160, .82)';
          ctx.lineWidth = 1.3;
          for (const face of [bot, top]) {
            ctx.beginPath();
            face.forEach((p, idx) => idx ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            ctx.moveTo(bot[i].x, bot[i].y);
            ctx.lineTo(top[i].x, top[i].y);
          }
          ctx.stroke();
          ctx.fillStyle = '#ffb3c0';
          ctx.font = '600 10px ui-monospace, monospace';
          ctx.fillText(zone.name, top[0].x + 4, top[0].y - 4);
          ctx.restore();
        }
        // Projected trajectory trace
        const trace = (this.trace?.points || []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
        if (trace.length > 1) {
          ctx.save();
          ctx.strokeStyle = 'rgba(201, 184, 255, .9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          trace.forEach((p, idx) => {
            const pt = project(p.x, p.y, Number.isFinite(p.z) ? p.z : 0);
            if (idx) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y);
          });
          ctx.stroke();
          ctx.restore();
        }
        // AR Ghost corridor for a selected library script (pre-flight desk clearance check)
        const ghost = this.arGhostScript;
        if (ghost?.trace?.length > 1) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 193, 118, .28)';
          ctx.lineWidth = 14;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ghost.trace.forEach(([gx, gy, gz], idx) => {
            const pt = project(gx, gy, Number.isFinite(gz) ? gz : 0);
            if (idx) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y);
          });
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255, 193, 118, .92)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#ffdca8';
          ctx.font = '600 10px ui-monospace, monospace';
          ghost.trace.forEach(([gx, gy, gz], idx) => {
            const pt = project(gx, gy, Number.isFinite(gz) ? gz : 0);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, idx === 0 ? 4 : 2.8, 0, Math.PI * 2);
            ctx.fill();
            if (idx > 0) ctx.fillText(String(idx), pt.x + 5, pt.y - 4);
          });
          const headPt = project(ghost.trace[0][0], ghost.trace[0][1], ghost.trace[0][2] || 0);
          ctx.fillText(`Fantôme AR · ${ghost.label || ghost.title || ''}`, headPt.x + 6, headPt.y + 12);
          ctx.restore();
        }
        // 3D articulated skeleton for commanded target and live measured pose
        const drawSkeleton = (angles, color, beam, dashed) => {
          if (!angles || axisKeys.some(k => !Number.isFinite(angles[k]))) return;
          const { elbow, tcp } = armLinks(angles);
          const p0 = project(0, 0, 0);
          const p1 = project(elbow.x, elbow.y, elbow.z);
          const p2 = project(tcp.x, tcp.y, tcp.z);
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = beam;
          ctx.lineWidth = dashed ? 5 : 8;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.strokeStyle = color;
          ctx.lineWidth = dashed ? 1.6 : 2.2;
          if (dashed) ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.setLineDash([]);
          for (const pt of [p0, p1, p2]) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, dashed ? 3.2 : 4.2, 0, Math.PI * 2);
            ctx.fillStyle = '#071116';
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
          ctx.restore();
        };
        drawSkeleton(this.state?.target, '#9fc5ff', 'rgba(159, 197, 255, .18)', true);
        drawSkeleton(this.displayActual(), '#73edce', 'rgba(115, 237, 206, .24)', false);
      }
      const points = [
        { point: targetXy(this.state?.target), color: '#9fc5ff', label: 'Cible' },
        { point: this.previewPoint, color: '#ffc176', label: 'Aperçu' },
        { point: this.displayXyz(), color: '#73edce', label: 'Bras' },
      ];
      for (const item of points) {
        if (!Number.isFinite(item.point?.x) || !Number.isFinite(item.point?.y)) continue;
        const pixel = project(item.point.x, item.point.y, Number.isFinite(item.point?.z) && arFull ? item.point.z : 0);
        if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) continue;
        ctx.beginPath(); ctx.arc(pixel.x, pixel.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = item.color; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#071116'; ctx.stroke();
        ctx.fillStyle = '#eaf0f5'; ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(item.label, pixel.x + 8, pixel.y - 7);
      }
    }

    async startVideo(retry = 0) {
      if (this.stream || !this.active || document.hidden || this.monitor !== 'camera') return;
      const stream = { controller: new AbortController(), key: '', retry };
      this.stream = stream;
      this.hudRate(NaN);
      this.videoNote(retry ? 'Reconnexion…' : 'Connexion…');
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
        this.videoNote('Flux interrompu');
        this.message(error.message, true);
        if (!retry && stream.key && ![401, 403, 423].includes(error.status)) {
          this.retryTimer = setTimeout(() => this.startVideo(1), 1500);
        }
      }
    }

    audioControls() {
      this.nodes.audio.hidden = !this.stream;
      this.nodes.listen.disabled = !this.stream?.ready;
      this.nodes.talk.disabled = !this.stream?.ready || !this.state?.config.camera_cloud_configured;
      this.nodes.listen.setAttribute('aria-pressed', String(!!this.audio?.listen));
      this.nodes.talk.setAttribute('aria-pressed', String(!!this.audio?.talk));
    }

    audioOutput(audio) {
      const speaker = this.nodes.speaker;
      speaker.muted = !audio.listen;
      if (audio.listen) speaker.play().catch(() => {
        if (this.audio === audio && audio.listen) {
          this.nodes['audio-status'].textContent = 'Activez le son dans le navigateur.';
        }
      });
      else speaker.pause();
    }

    async toggleAudio(control) {
      const stream = this.stream;
      if (!stream?.ready || !this.active || document.hidden) return;
      const listen = control === 'listen' ? !this.audio?.listen : !!this.audio?.listen;
      const talk = control === 'talk' ? !this.audio?.talk : !!this.audio?.talk;
      if (talk && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
        this.nodes['audio-status'].textContent = 'Pour parler, ouvrez HQ sur le PC hôte via localhost ou utilisez HTTPS.';
        return;
      }
      if (this.audio && this.audio.talk === talk && (listen || talk)) {
        this.audio.listen = listen;
        this.audioOutput(this.audio);
        this.audioControls();
        return;
      }
      this.stopAudio();
      if (!listen && !talk) return;
      const audio = { listen, talk, peer: null, microphone: null };
      this.audio = audio;
      this.audioControls();
      this.nodes['audio-status'].textContent = talk ? 'Autorisation du micro…' : 'Connexion audio…';
      try {
        if (!window.RTCPeerConnection) throw new Error('Audio WebRTC indisponible dans ce navigateur.');
        const peer = audio.peer = new RTCPeerConnection({ iceServers: [] });
        const track = peer.addTransceiver('audio', { direction: talk ? 'sendrecv' : 'recvonly' });
        const codecs = RTCRtpSender.getCapabilities('audio')?.codecs.filter(codec =>
          codec.mimeType.toLowerCase() === 'audio/pcma') || [];
        if (!codecs.length || !track.setCodecPreferences) throw new Error('Codec audio Tapo indisponible.');
        track.setCodecPreferences(codecs);
        this.nodes.speaker.srcObject = new MediaStream([track.receiver.track]);
        this.audioOutput(audio);
        if (talk) {
          const microphone = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }, video: false,
          });
          if (this.audio !== audio) {
            microphone.getTracks().forEach(track => track.stop());
            return;
          }
          audio.microphone = microphone;
          await track.sender.replaceTrack(microphone.getAudioTracks()[0]);
        }
        if (this.audio !== audio) return;
        this.nodes['audio-status'].textContent = 'Connexion audio…';
        const fail = () => {
          if (this.audio !== audio) return;
          this.stopAudio();
          this.nodes['audio-status'].textContent = 'Connexion audio interrompue.';
        };
        audio.timer = setTimeout(fail, 10000);
        peer.onconnectionstatechange = () => {
          if (this.audio !== audio) return;
          if (peer.connectionState === 'connected') {
            clearTimeout(audio.timer);
            this.nodes['audio-status'].textContent = talk ? 'Micro actif' : '';
          } else if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) fail();
        };
        await peer.setLocalDescription(await peer.createOffer());
        if (this.audio !== audio) return;
        const result = await this.request('camera/audio', {
          stream: stream.key, mode: talk ? 'talk' : 'listen', offer: peer.localDescription.sdp,
        });
        if (this.audio === audio) await peer.setRemoteDescription({ type: 'answer', sdp: result.answer });
      } catch (error) {
        if (this.audio !== audio) return;
        this.stopAudio();
        this.nodes['audio-status'].textContent = error.name === 'NotAllowedError' ?
          'Accès au microphone refusé.' : (error.message || 'Audio Tapo indisponible.');
      }
    }

    stopAudio() {
      const audio = this.audio;
      this.audio = null;
      if (audio) {
        clearTimeout(audio.timer);
        audio.microphone?.getTracks().forEach(track => track.stop());
        audio.peer?.close();
      }
      this.nodes.speaker.pause();
      this.nodes.speaker.srcObject = null;
      this.nodes.speaker.muted = true;
      this.nodes['audio-status'].textContent = '';
      this.audioControls();
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
      video.playsInline = true;
      const opened = this.event(media, 'sourceopen', signal);
      video.src = stream.url;
      video.play().catch(() => {});
      await opened;
      const buffer = media.addSourceBuffer(mime);
      const reader = response.body.getReader();
      let lastPing = -Infinity;
      const frame = (now) => {
        if (this.stream !== stream) return;
        if (!stream.ready) {
          stream.ready = true;
          this.audioControls();
        }
        clearTimeout(stream.startup);
        clearTimeout(stream.watch);
        stream.watch = setTimeout(() => this.videoFailure(stream), 2300);
        this.nodes['video-idle'].hidden = true;
        this.videoNote('En direct');
        this.nodes.fullscreen.disabled = false;
        if (this.videoBoost) this.captureBoostFrame(stream, now);
        if (!stream.fpsSince) stream.fpsSince = now;
        stream.frames = (stream.frames || 0) + 1;
        if (now - stream.fpsSince >= 1000) {
          this.hudRate(Math.round(stream.frames * 1000 / (now - stream.fpsSince)));
          stream.frames = 0;
          stream.fpsSince = now;
        }
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
          const lag = end - video.currentTime;
          if (lag > 0.7) {
            video.playbackRate = 1.0;
            video.currentTime = Math.max(start, end - 0.15);
          } else if (lag > 0.25) {
            if (video.playbackRate !== 1.08) video.playbackRate = 1.08;
          } else if (lag < 0.14 && video.playbackRate !== 1.0) {
            video.playbackRate = 1.0;
          }
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
      this.videoNote('Flux interrompu');
      this.message('Le direct ne fournit plus d’images.', true);
      if (!stream.retry) this.retryTimer = setTimeout(() => this.startVideo(1), 1500);
    }

    stopVideo() {
      clearTimeout(this.retryTimer);
      cancelAnimationFrame(this.boostFrame);
      this.boostFrame = 0;
      if (this.nodes['video-boost']) this.nodes['video-boost'].hidden = true;
      const stream = this.stream;
      this.stream = null;
      this.stopAudio();
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
      this.hudRate(NaN);
      this.videoNote('Flux arrêté');
      this.controls();
    }

    toggleVideoBoost(force = !this.videoBoost) {
      this.videoBoost = !!force;
      try { localStorage.setItem('hq_robotics_video_boost_v1', this.videoBoost ? '1' : '0'); } catch (_) {}
      if (this.nodes['video-boost-btn']) {
        this.nodes['video-boost-btn'].setAttribute('aria-pressed', String(this.videoBoost));
      }
      if (!this.videoBoost) {
        cancelAnimationFrame(this.boostFrame);
        this.boostFrame = 0;
        if (this.nodes['video-boost']) this.nodes['video-boost'].hidden = true;
      } else if (this.stream) {
        this.captureBoostFrame(this.stream, performance.now());
        this.tickVideoBoost();
      }
    }

    captureBoostFrame(stream, now) {
      const video = this.nodes.video;
      const out = this.nodes['video-boost'];
      if (!video?.videoWidth || !video?.videoHeight || !out) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (!stream.boost) {
        const prev = document.createElement('canvas');
        const curr = document.createElement('canvas');
        prev.width = curr.width = w;
        prev.height = curr.height = h;
        stream.boost = { prev, curr, lastAt: now, frameAt: performance.now(), interval: 34, hasPrev: false };
      }
      const b = stream.boost;
      if (b.curr.width !== w || b.curr.height !== h) {
        b.prev.width = b.curr.width = w;
        b.prev.height = b.curr.height = h;
        b.hasPrev = false;
      }
      if (b.hasPrev) b.prev.getContext('2d')?.drawImage(b.curr, 0, 0);
      else { b.prev.getContext('2d')?.drawImage(video, 0, 0, w, h); b.hasPrev = true; }
      b.curr.getContext('2d')?.drawImage(video, 0, 0, w, h);
      const dt = now - b.lastAt;
      if (dt > 8 && dt < 120) b.interval = dt;
      b.lastAt = now;
      b.frameAt = performance.now();
      out.hidden = false;
      if (!this.boostFrame) this.tickVideoBoost();
    }

    tickVideoBoost() {
      this.boostFrame = 0;
      if (!this.videoBoost || !this.stream || document.hidden) return;
      const out = this.nodes['video-boost'];
      const b = this.stream.boost;
      if (out && b && !out.hidden && out.offsetParent !== null) {
        const w = b.curr.width, h = b.curr.height;
        if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
        const ctx = out.getContext('2d');
        if (ctx) {
          const t = Math.max(0, Math.min(1, (performance.now() - b.frameAt) / (b.interval || 34)));
          ctx.globalAlpha = 1;
          ctx.drawImage(b.prev, 0, 0, w, h);
          if (t > 0.02) {
            ctx.globalAlpha = t;
            ctx.drawImage(b.curr, 0, 0, w, h);
            ctx.globalAlpha = 1;
          }
        }
      }
      this.boostFrame = requestAnimationFrame(() => this.tickVideoBoost());
    }

    bind() {
      const on = (name, fn) => this.nodes[name].addEventListener('click', () => this.run(fn));
      if (this.nodes['audio-hud']) {
        let storedAudioHud = false;
        try { storedAudioHud = localStorage.getItem('hq_robotics_audio_hud_v1') === '1'; } catch (_) {}
        this.audioHud = storedAudioHud;
        this.nodes['audio-hud'].setAttribute('aria-pressed', String(storedAudioHud));
        on('audio-hud', () => this.toggleAudioHud());
      }
      if (this.nodes['open-shortcuts']) on('open-shortcuts', () => this.toggleShortcuts());
      if (this.nodes['shortcuts-close']) on('shortcuts-close', () => this.toggleShortcuts(false));
      on('open-assistant', () => this.mountAssistant(true));
      // Same entry as the header button, but pinned in the sticky bar where a phone can always reach it.
      if (this.nodes['section-ai']) on('section-ai', () => this.mountAssistant(true));
      if (this.nodes['copilot-open']) on('copilot-open', () => this.mountAssistant(true));
      on('open-settings', () => this.openSettings());
      on('camera-setup', () => this.openSettings());
      this.host.querySelectorAll('[data-monitor-base]').forEach(button => {
        button.addEventListener('click', () => {
          this.monitorChosen = true;
          this.monitorBase = button.dataset.monitorBase;
          const mode = this.monitorModeFromUi();
          // A hardware post that is armed keeps its live feed when the plot is shown: the camera
          // is required to move, and recording needs the plan while the stream stays up.
          if (mode !== 'camera' && mode !== 'cam3d' && !(this.state?.config.mode === 'hardware' && this.lease)) this.stopVideo();
          this.syncMonitorLayoutUi();
          this.applyMonitorView();
        });
      });
      if (this.nodes['monitor-layout']) {
        this.nodes['monitor-layout'].addEventListener('change', () => {
          this.monitorLayout = this.nodes['monitor-layout'].value;
          this.monitorChosen = true;
          const mode = this.monitorModeFromUi();
          if (mode !== 'camera' && mode !== 'cam3d' && !(this.state?.config.mode === 'hardware' && this.lease)) this.stopVideo();
          this.applyMonitorView();
        });
      }
      this.host.querySelectorAll('[data-mode]').forEach(button =>
        button.addEventListener('click', () => this.selectMode(button.dataset.mode)));
      this.host.querySelectorAll('[data-go-section]').forEach(button =>
        button.addEventListener('click', () => this.selectSection(button.dataset.goSection)));
      if (this.nodes['section-overview']) {
        this.nodes['section-overview'].addEventListener('click', () => {
          this.selectSection(this.sectionOverview ? (this.lastSection || 'camera') : 'all');
        });
      }
      this.host.querySelectorAll('[data-wb-view]').forEach(button => {
        button.addEventListener('click', () => {
          const view = button.dataset.wbView;
          this.host.querySelectorAll('[data-wb-view]').forEach(b =>
            b.setAttribute('aria-pressed', String(b.dataset.wbView === view)));
          this.host.querySelectorAll('[data-wb-panel]').forEach(panel => {
            const on = panel.dataset.wbPanel === view;
            if (panel.tagName === 'DETAILS') {
              panel.hidden = !on;
              panel.open = on;
            } else panel.hidden = !on;
          });
        });
      });
      on('keepout-edit-3d', () => this.openZonesInMonitor());
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
        button.addEventListener('blur', () => {
          button.classList.remove('is-pressed');
          if (this.jog?.button === button) {
            clearTimeout(this.jog.timer);
            this.jog = null;
          }
        });
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
      // Sliders are another way to type a joint value; they never send a move by themselves.
      for (const key of axisKeys) {
        const slider = this.nodes['slider-' + key];
        const input = this.form[key];
        if (!slider || !input) continue;
        slider.addEventListener('pointerdown', () => this.pushPoseUndo());
        input.addEventListener('focus', () => this.pushPoseUndo());
        slider.addEventListener('input', () => { input.value = slider.value; this.clearPreview(); this.pilotAids(); });
        input.addEventListener('input', () => {
          if (Number.isFinite(input.valueAsNumber)) slider.value = input.value;
        });
      }
      for (const key of ['x', 'y', 'z', 't']) {
        this.form[key]?.addEventListener('focus', () => this.pushPoseUndo());
      }
      this.nodes.settings.addEventListener('submit', event => { event.preventDefault(); this.run(() => this.saveSettings()); });
      on('forget-camera', async () => {
        if (!this.askConfirm('forget-camera', this.nodes['forget-camera'], 'Confirmer : effacer le compte',
          'Cliquez de nouveau pour effacer le compte Tapo enregistré.')) return;
        return this.saveSettings(true);
      });
      on('arm', () => this.arm());
      this.nodes['library-search']?.addEventListener('input', () => this.assistant?.renderLibrary());
      if (this.nodes['library-export']) on('library-export', () => this.assistant?.exportLibrary());
      if (this.nodes['commission-approve-btn']) on('commission-approve-btn', () => this.approveCommission());
      this.nodes['commission-gates']?.addEventListener('change', () => this.updateCommissionApproveBtn());
      this.nodes['commission-firmware']?.addEventListener('input', () => this.updateCommissionApproveBtn());
      this.nodes['commission-operator']?.addEventListener('input', () => this.updateCommissionApproveBtn());
      if (this.nodes['lease-renew']) on('lease-renew', () => this.renewLease());
      if (this.nodes['teach-toggle']) on('teach-toggle', () => this.toggleTeachMode());
      if (this.nodes['status-disarm']) on('status-disarm', () => this.nodes.cancel.click());
      if (this.nodes['status-home']) on('status-home', () => this.nodes.home.click());
      const TOOL_PRESETS = { stock: [0, 0], pen: [42, 5], probe: [55, 10], iron: [85, 15] };
      const syncToolPreset = () => {
        const sel = this.nodes['tool-preset'];
        const t = Number(this.nodes['tool-offset']?.valueAsNumber);
        const f = Number(this.nodes['floor-z']?.valueAsNumber);
        if (!sel) return;
        const hit = Object.entries(TOOL_PRESETS).find(([, [pt, pf]]) => pt === t && pf === f);
        sel.value = hit ? hit[0] : 'custom';
      };
      this.nodes['tool-preset']?.addEventListener('change', () => {
        const pair = TOOL_PRESETS[this.nodes['tool-preset'].value];
        if (!pair) return;
        if (this.nodes['tool-offset']) {
          this.nodes['tool-offset'].value = String(pair[0]);
          try { localStorage.setItem('hq_robotics_tool_offset_v1', String(pair[0])); } catch (_) {}
        }
        if (this.nodes['floor-z']) {
          this.nodes['floor-z'].value = String(pair[1]);
          try { localStorage.setItem('hq_robotics_floor_z_v1', String(pair[1])); } catch (_) {}
        }
        this.drawSide(this.displayActual(), this.fieldPose());
        this.pilotAids();
      });
      for (const [k, storeKey] of [['tool-offset', 'hq_robotics_tool_offset_v1'], ['floor-z', 'hq_robotics_floor_z_v1']]) {
        const node = this.nodes[k];
        if (!node) continue;
        try {
          const saved = localStorage.getItem(storeKey);
          if (saved !== null && Number.isFinite(Number(saved))) node.value = saved;
        } catch (_) {}
        node.addEventListener('input', () => {
          try { localStorage.setItem(storeKey, node.value); } catch (_) {}
          syncToolPreset();
          this.drawSide(this.displayActual(), this.fieldPose());
          this.pilotAids();
        });
      }
      syncToolPreset();
      on('cancel', () => {
        this.release();
        this.message(this.state?.config.mode === 'hardware' ?
          'Autorisation relâchée. Un pas physique déjà parti peut se terminer.' : 'Simulateur désarmé.');
      });
      on('stop', () => this.stopStation());
      on('stop-hud', () => this.stopStation());
      on('reset', async () => {
        const hw = this.state?.config.mode === 'hardware';
        if (hw && !this.askConfirm('reset', this.nodes.reset, 'Confirmer : réinitialiser',
          'Vérifiez le bras sur place et sécurisez la zone. Cliquez de nouveau pour réinitialiser le poste.')) return;
        await this.request('reset', { inspected: hw });
        this.render(await this.request('status'));
        this.message('Poste réinitialisé. Armez de nouveau pour déplacer le bras.');
      });
      on('probe', () => this.probeArm());
      on('telemetry-probe', () => this.probeArm());
      on('commission-probe', () => this.probeArm());
      on('commission-settings', () => this.openSettings());
      on('commission-reveal', () => {
        this.revealPilot = !this.revealPilot;
        this.nodes['commission-reveal'].setAttribute('aria-pressed', String(this.revealPilot));
        this.nodes['commission-reveal'].textContent = this.revealPilot ? 'Replier le pilotage' : 'Afficher le pilotage (verrouillé)';
        if (this.state) this.render(this.state);
      });
      on('interlock-go', () => this.nodes['commission-card'].scrollIntoView({ block: 'start' }));
      if (this.nodes['interlock-action']) on('interlock-action', () => this.runInterlockAction());
      if (this.nodes['sync-actual']) on('sync-actual', () => this.syncActualToFields());
      if (this.nodes['pose-undo']) on('pose-undo', () => this.undoPoseFields());
      if (this.nodes['move-approach']) on('move-approach', () => this.approachFieldTarget());
      on('estop', () => this.openSettings('estop_ip'));
      on('message-close', () => this.message(''));
      this.host.querySelectorAll('[data-space-view]').forEach(button =>
        button.addEventListener('click', () => this.space?.setView(button.dataset.spaceView)));
      on('space-clear', () => this.space?.clearTrail());
      on('compose-toggle', () => this.composeToggle());
      on('flight-toggle', () => this.flightToggle());
      on('blackbox-replay', () => {
        this.flightToggle(true);
        this.host.querySelector('[data-section="camera"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      on('flight-refresh', () => this.loadFlight());
      on('flight-play', () => this.toggleFlightPlay());
      on('flight-apply', () => this.applyFlightPose());
      this.nodes['flight-scrub']?.addEventListener('input', () => {
        this.stopFlightPlay();
        this.flightIndex = Math.round(this.nodes['flight-scrub'].valueAsNumber || 0);
        this.renderFlight();
      });
      this.nodes['compose-leg-speed']?.addEventListener('input', () => this.composeLegTuning());
      this.nodes['compose-leg-dwell']?.addEventListener('change', () => this.composeLegTuning());
      on('grasp-run', () => this.graspToContact());
      if (this.nodes['scale-tare']) on('scale-tare', () => this.tareScale());
      if (this.nodes['scale-reset']) on('scale-reset', () => this.resetScale());
      if (this.nodes['th-hold']) on('th-hold', () => this.thirdHandHold());
      if (this.nodes['th-present']) on('th-present', () => this.thirdHandPresent());
      if (this.nodes['th-release']) on('th-release', () => this.thirdHandRelease());
      if (this.nodes['th-rot-left']) on('th-rot-left', () => this.thirdHandOrient(-25, 0));
      if (this.nodes['th-rot-right']) on('th-rot-right', () => this.thirdHandOrient(25, 0));
      if (this.nodes['th-tilt-up']) on('th-tilt-up', () => this.thirdHandOrient(0, -10));
      if (this.nodes['th-tilt-down']) on('th-tilt-down', () => this.thirdHandOrient(0, 10));
      if (this.nodes['touch-capture']) on('touch-capture', () => this.touchCaptureTo3D());
      if (this.nodes['inspect-compose']) on('inspect-compose', () => this.composeSynthesized({ synthesize: 'inspect' }));
      if (this.nodes['tx-compose']) on('tx-compose', () => this.composeSynthesized(this.buildTransferPayload()));
      if (this.nodes['tx-run']) on('tx-run', () => this.runTransferCycle());
      if (this.nodes['pal-compose']) on('pal-compose', () => this.composeSynthesized(this.buildPalletPayload()));
      if (this.nodes['pal-next']) on('pal-next', () => this.stepNextPalletCell());
      if (this.nodes['pal-fill']) on('pal-fill', () => this.fillPalletFromSource());
      this.nodes['compose-scrub']?.addEventListener('input', () => this.scrubComposePreview());
      for (const k of ['pal-rows', 'pal-cols', 'pal-ax', 'pal-ay', 'pal-bx', 'pal-by', 'pal-z']) {
        this.nodes[k]?.addEventListener('input', () => {
          if (k === 'pal-rows' || k === 'pal-cols') this.palletCellIndex = 0;
          this.updatePalletBadge();
          this.drawPosition();
          this.updateSpace();
        });
      }
      for (const k of ['tx-source', 'tx-dest', 'tx-clear']) {
        this.nodes[k]?.addEventListener('input', () => {
          this.drawPosition();
          this.updateSpace();
        });
      }
      this.nodes['visual-gauges']?.addEventListener('click', event => this.onVisualGaugeClick(event));
      this.nodes['visual-gauges']?.addEventListener('pointermove', event => this.onVisualGaugeHover(event));
      this.nodes['visual-gauges']?.addEventListener('pointerleave', () => this.onVisualGaugeLeave());
      this.nodes.plot?.addEventListener('pointermove', event => this.plotHoverMove(event));
      this.nodes.plot?.addEventListener('pointerleave', () => this.plotHoverLeave());
      this.bindHoverInspector();
      on('motion-cancel', () => this.nodes.cancel.click());
      on('zones-toggle', () => this.zonesToggle());
      on('zones-add', () => this.zoneAdd());
      on('zones-undo', () => this.undo('zones'));
      on('compose-undo', () => this.undo('compose'));
      on('zones-revert', () => {
        this.pushUndo('zones');
        this.zoneDraft = JSON.parse(JSON.stringify(this.state?.config.keepout || []));
        this.zoneSelected = this.zoneDraft.length ? 0 : null;
        this.renderZones();
        this.updateSpace();
      });
      on('zones-save', () => this.zonesSave());
      on('compose-add-fields', () => this.composeAdd(this.fieldPose()));
      on('compose-add-measured', () => this.composeAdd(this.state?.feedback?.actual));
      on('compose-clear', () => {
        if (!this.askConfirm('compose-clear', this.nodes['compose-clear'], 'Confirmer : tout effacer',
          'Cliquez de nouveau pour effacer tous les points.')) return;
        this.pushUndo('compose');
        this.compose = { points: [], legs: [], selected: null, bad: null, checked: false };
        this.composeChanged();
      });
      on('compose-send', () => this.composeSend());
      on('compose-play', () => {
        const [start] = this.compose.points;
        const { poses } = window.HqRobotics3D.planPath(this.compose.points, this.compose.legs);
        this.play3d({ start, steps: poses, title: this.nodes['compose-title'].value.trim() || 'Brouillon' });
      });
      this.nodes['compose-title'].addEventListener('input', () => this.renderCompose());
      this.host.querySelectorAll('[data-grip]').forEach(button =>
        button.addEventListener('click', () => this.setGrip(button.dataset.grip)));
      this.nodes.keyjog.addEventListener('change', () => this.setKeyJog(this.nodes.keyjog.checked));
      let storedKeyJog = false;
      try { storedKeyJog = localStorage.getItem(KEY_JOG_STORE) === '1'; } catch (_) {}
      this.setKeyJog(storedKeyJog);
      if (this.nodes.padjog) {
        this.nodes.padjog.addEventListener('change', () => this.setPadJog(this.nodes.padjog.checked));
        let storedPadJog = false;
        try { storedPadJog = localStorage.getItem(PAD_JOG_STORE) === '1'; } catch (_) {}
        this.setPadJog(storedPadJog);
      }
      this.nodes.pose.addEventListener('input', event => {
        if (!event.target.closest?.('.rb-tuning')) this.composeFromFields();
        this.pilotAids();
        this.controls();
      });
      on('preview', () => this.preview(this.target()));
      on('home', () => this.goHome());
      on('home-direct', () => this.goHomeDirect());
      on('preset-save', async () => {
        await this.request('presets', { action: 'save', name: this.nodes['preset-name'].value, ...this.target() });
        await this.loadPresets();
      });
      if (this.nodes['preset-capture-actual']) {
        on('preset-capture-actual', async () => {
          const actual = this.state?.feedback?.actual;
          if (!actual) throw new Error('Aucune position mesurée à capturer.');
          await this.request('presets', {
            action: 'save', name: this.nodes['preset-name'].value, kind: 'joints', pose: { ...actual },
          });
          await this.loadPresets();
          this.message('Position actuelle du bras enregistrée.');
        });
      }
      on('preset-preview', () => this.preview(this.preset(), true));
      on('preset-run', () => this.move(this.preset()));
      on('preset-rename', async () => {
        await this.request('presets', { action: 'rename', id: this.preset().id, name: this.nodes['preset-name'].value });
        await this.loadPresets();
      });
      on('preset-delete', async () => {
        const { id } = this.preset();
        if (!this.askConfirm('preset-delete', this.nodes['preset-delete'], 'Confirmer : supprimer',
          'Cliquez de nouveau pour supprimer cette position enregistrée.')) return;
        await this.request('presets', { action: 'delete', id });
        await this.loadPresets();
      });
      on('routine-save', () => this.storeRoutine());
      on('routine-load', () => this.loadRoutine());
      on('routine-delete', () => this.deleteRoutine(this.nodes['routine-delete']));
      this.nodes.routines.addEventListener('change', () => this.controls());
      this.nodes['routine-name'].addEventListener('input', () => this.controls());
      on('keepout-add', () => this.addKeepout());
      this.nodes['keepout-rows'].addEventListener('click', event => {
        const remove = event.target.closest?.('[data-ko-remove]');
        if (!remove) return;
        this.run(() => this.removeKeepout(Number(remove.dataset.koRemove)));
      });
      on('blackbox-export', () => this.exportBlackbox());
      on('commission-all', () => this.commissionAll());
      this.host.querySelectorAll('[data-commission-check]').forEach(button =>
        button.addEventListener('click', () => this.run(() => this.commissionCheck(button.dataset.commissionCheck))));
      this.nodes.presets.addEventListener('change', () => {
        this.nodes['preset-name'].value = this.presets?.[this.nodes.presets.value]?.name || '';
        this.controls();
      });
      this.nodes['preset-name'].addEventListener('input', () => this.controls());
      on('record-start', () => {
        if (!this.lease) throw new Error('Armez le poste avant d’enregistrer.');
        const actual = this.state?.feedback?.actual;
        if (!actual) throw new Error('Retour du bras indisponible.');
        this.recordDraft = null;
        this.recording = { start: { ...actual }, steps: [] };
        this.trace = null;
        this.controls();
        this.nodes.plot.scrollIntoView({ block: 'center' });
        this.message('Enregistrement en cours depuis la pose actuelle. Cliquez sur le plan XY pour ajouter une pose.');
      });
      on('record-stop', () => {
        if (!this.recording) return;
        if (!this.recording.steps.length) {
          this.recording = null;
          this.controls();
          this.message('Aucune pose enregistrée.');
          return;
        }
        this.recordDraft = this.recording;
        this.recording = null;
        this.controls();
        this.nodes['record-name'].focus();
        this.message('Script prêt : nommez-le puis gardez-le.');
      });
      on('record-discard', () => {
        this.recording = null;
        this.controls();
        this.message('Enregistrement effacé.');
      });
      on('record-store', () => this.storeRecording());
      on('record-export', () => this.exportRecordings());
      this.nodes['record-name'].addEventListener('input', () => this.controls());
      this.nodes['record-search'].addEventListener('input', () => {
        this.recordFilter = this.nodes['record-search'].value;
        this.renderRecordings();
      });
      this.nodes['record-list'].addEventListener('click', event => {
        const play = event.target.closest?.('[data-record-play]');
        const remove = event.target.closest?.('[data-record-delete]');
        const edit = event.target.closest?.('[data-record-edit]');
        const trace = event.target.closest?.('[data-record-trace]');
        const up = event.target.closest?.('[data-record-step-up]');
        const down = event.target.closest?.('[data-record-step-down]');
        const drop = event.target.closest?.('[data-record-step-drop]');
        const save = event.target.closest?.('[data-record-steps-save]');
        const cancel = event.target.closest?.('[data-record-cancel]');
        if (play) this.run(() => this.playRecording(play.dataset.recordPlay));
        if (remove) this.run(() => this.deleteRecording(remove.dataset.recordDelete, remove));
        if (edit) this.run(() => this.beginEdit(edit.dataset.recordEdit));
        if (trace) this.run(() => this.showTrace(trace.dataset.recordTrace));
        if (up) this.reorderRecordingStep(Number(up.dataset.recordStepUp), -1);
        if (down) this.reorderRecordingStep(Number(down.dataset.recordStepDown), 1);
        if (drop) this.dropRecordingStep(Number(drop.dataset.recordStepDrop));
        if (save) this.run(() => this.saveRecordingSteps());
        if (cancel) this.cancelRecordingEdit();
      });
      this.nodes.plot.addEventListener('click', event => {
        if (performance.now() < this.plotClickGuard) return;
        this.run(() => this.plotAim(event));
      });
      this.nodes.plot.addEventListener('pointerdown', event => this.plotDragStart(event));
      this.nodes.plot.addEventListener('pointermove', event => this.plotDragMove(event));
      this.nodes.plot.addEventListener('pointerup', event => this.plotDragEnd(event));
      this.nodes.plot.addEventListener('pointercancel', event => this.plotDragCancel(event));
      this.nodes.plot.addEventListener('lostpointercapture', event => this.plotDragCancel(event));
      on('step-add', () => {
        if (this.steps.length >= 16) throw new Error('La séquence contient déjà 16 positions.');
        this.steps.push(this.target());
        this.showSequence();
      });
      on('sequence-clear', () => { this.steps = []; this.showSequence(); });
      on('sequence-check', () => this.sequence(false));
      on('sequence-run', () => this.sequence(true));
      this.nodes.steps.addEventListener('click', event => {
        const up = event.target.closest?.('[data-seq-up]');
        const down = event.target.closest?.('[data-seq-down]');
        const drop = event.target.closest?.('[data-seq-drop]');
        if (up) this.moveSequenceStep(Number(up.dataset.seqUp), -1);
        if (down) this.moveSequenceStep(Number(down.dataset.seqDown), 1);
        if (drop) this.dropSequenceStep(Number(drop.dataset.seqDrop));
      });
      this.nodes.steps.addEventListener('input', event => {
        const input = event.target.closest?.('[data-seq-key]');
        if (!input) return;
        const step = this.steps[Number(input.dataset.seqIndex)];
        const value = input.valueAsNumber;
        if (!step || !Number.isFinite(value)) return;
        const values = step.kind === 'joints' ? step.pose : step.xyz;
        if (values && Object.hasOwn(values, input.dataset.seqKey)) values[input.dataset.seqKey] = value;
      });
      on('library-ghosts', () => {
        this.ghostLibrary = !this.ghostLibrary;
        const button = this.nodes['library-ghosts'];
        button.textContent = this.ghostLibrary ? 'Masquer les traces' : 'Traces sur le plan';
        button.setAttribute('aria-pressed', String(this.ghostLibrary));
        this.drawPosition();
        this.message(this.ghostLibrary
          ? 'Traces de la bibliothèque affichées sur le plan XY.'
          : 'Traces de la bibliothèque masquées.');
      });
      this.host.querySelectorAll('[data-ptz]').forEach(button => {
        const direction = button.dataset.ptz;
        const stopHold = () => { clearInterval(this.ptzHold); this.ptzHold = null; };
        button.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !event.isPrimary) return;
          button.setPointerCapture(event.pointerId);
          stopHold();
          this.ptzSend(direction);
          if (direction !== 'stop') this.ptzHold = setInterval(() => this.ptzSend(direction), Math.max(450, this.ptzPulse() + 80));
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
          button.addEventListener(type, () => { if (this.ptzHold) { stopHold(); this.ptzSend('stop', true); } });
        }
        // Keyboard and assistive technology: one pulse per activation.
        button.addEventListener('click', event => { if (event.detail === 0) this.ptzSend(direction); });
      });
      this.nodes.video.addEventListener('click', event => {
        const rect = this.nodes.video.getBoundingClientRect();
        const u = event.clientX - rect.left;
        const v = event.clientY - rect.top;
        if (!this.calibrating) {
          if (!this.cameraMap || !this.host.querySelector('[data-cal-show]')?.checked ||
              this.host.querySelector('[data-cal-ar]')?.checked === false) return;
          const map = this.cameraMap.map;
          const det = map.a * map.e - map.b * map.d;
          if (Math.abs(det) < 1e-6) return;
          const ws = this.state?.config.workspace;
          const z = Number.isFinite(this.form.z.valueAsNumber) ? this.form.z.valueAsNumber : 120;
          const t = Number.isFinite(this.form.t.valueAsNumber) ? this.form.t.valueAsNumber : 180;
          const du = u - map.c;
          const dv = v - map.f;
          let rx = (map.e * du - map.b * dv) / det;
          let ry = (-map.d * du + map.a * dv) / det;
          if (ws) {
            rx = Math.min(ws.x[1], Math.max(ws.x[0], rx));
            ry = Math.min(ws.y[1], Math.max(ws.y[0], ry));
          }
          this.form.x.value = Number(rx.toFixed(1));
          this.form.y.value = Number(ry.toFixed(1));
          this.run(async () => {
            const res = await this.preview({ kind: 'cartesian', xyz: { x: rx, y: ry, z, t } });
            if (res) this.message(`Visée vidéo AR : X ${Math.round(rx)} · Y ${Math.round(ry)} · Z ${Math.round(z)} mm.`);
          });
          return;
        }
        const key = this.calibrating;
        this.calPixels[key] = { u, v };
        this.calibrating = null;
        const output = this.host.querySelector(`[data-cal-pixel="${key}"]`);
        if (output) output.textContent = Math.round(this.calPixels[key].u) + ', ' + Math.round(this.calPixels[key].v);
        const xInput = this.host.querySelector(`[data-cal-x="${key}"]`);
        const yInput = this.host.querySelector(`[data-cal-y="${key}"]`);
        const liveXyz = this.state?.feedback?.xyz;
        if (xInput && yInput && !xInput.value && !yInput.value && Number.isFinite(liveXyz?.x) && Number.isFinite(liveXyz?.y)) {
          xInput.value = String(Math.round(liveXyz.x));
          yInput.value = String(Math.round(liveXyz.y));
          this.message(`Point ${key.toUpperCase()} pris et pré-rempli avec la pince (X ${xInput.value} · Y ${yInput.value} mm).`);
        } else {
          this.message('Point ' + key.toUpperCase() + ' pris. Saisissez ses coordonnées robot.');
        }
      });
      this.host.querySelectorAll('[data-cal-capture]').forEach(button =>
        button.addEventListener('click', () => this.run(() => this.captureCalPoint(button.dataset.calCapture))));
      this.host.querySelectorAll('[data-cal-auto]').forEach(button =>
        button.addEventListener('click', () => this.autoFillCalXy(button.dataset.calAuto)));
      this.host.querySelector('[data-cal-save]').addEventListener('click', () => this.run(() => this.saveCameraMap()));
      this.host.querySelector('[data-cal-auto-detect]')?.addEventListener('click', () => this.run(() => this.autoDetectCameraMarkers()));
      this.host.querySelector('[data-cal-sheet]')?.addEventListener('click', () => this.downloadCalibrationMat());
      this.host.querySelector('[data-cal-clear]').addEventListener('click', () => this.clearCameraMap());
      if (this.nodes['commission-export']) on('commission-export', () => this.run(() => this.exportCommissionReport()));
      this.host.querySelector('[data-cal-show]').addEventListener('change', () => this.drawCameraOverlay());
      this.host.querySelector('[data-cal-ar]')?.addEventListener('change', () => this.drawCameraOverlay());
      on('ptz-preset-refresh', () => this.loadPtzPresets());
      on('ptz-preset-goto', () => this.gotoPtzPreset());
      on('ptz-preset-save', () => this.savePtzPreset());
      this.nodes['ptz-preset-list'].addEventListener('change', () => this.controls());
      this.nodes['ptz-preset-name'].addEventListener('input', () => this.controls());
      this.host.querySelectorAll('[data-night]').forEach(button =>
        button.addEventListener('click', () => this.nightSet(button.dataset.night)));
      on('video-start', () => this.startVideo());
      on('video-boost-btn', () => this.toggleVideoBoost());
      on('video-stop', () => this.stopVideo());
      on('listen', () => this.toggleAudio('listen'));
      on('talk', () => this.toggleAudio('talk'));
      on('fullscreen', () => {
        if (this.nodes.viewport.requestFullscreen) return this.nodes.viewport.requestFullscreen();
        this.nodes.video.webkitEnterFullscreen?.();
      });
      if (this.nodes['snap-capture']) on('snap-capture', () => this.captureVideoFrame());
      if (this.nodes['cam-detect']) on('cam-detect', () => this.detectCameraObject());
      if (this.nodes['debug-next']) this.nodes['debug-next'].addEventListener('click', () => this.debugResolve?.(true));
      if (this.nodes['debug-stop']) this.nodes['debug-stop'].addEventListener('click', () => this.debugAbort?.());
      if (this.nodes['debug-z-down']) this.nodes['debug-z-down'].addEventListener('click', () => { this.debugZTrim = (this.debugZTrim || 0) - 1; this.updateDebugLabel(); });
      if (this.nodes['debug-z-up']) this.nodes['debug-z-up'].addEventListener('click', () => { this.debugZTrim = (this.debugZTrim || 0) + 1; this.updateDebugLabel(); });
    }

    fieldPose() {
      const pose = {};
      for (const key of axisKeys) {
        pose[key] = this.form[key].valueAsNumber;
        if (!Number.isFinite(pose[key])) return null;
      }
      return pose;
    }

    // Measured value and gap on each row, near-limit warnings, keep-out proximity and the side view.
    // Display only: every move is still validated by the server.
    pilotAids() {
      const state = this.state;
      if (!state) return;
      const sim = state.config.mode === 'simulation';
      const actual = state.feedback?.actual;
      const xyz = state.feedback?.xyz;
      const sign = value => (value > 0 ? '+' : '') + format(value, '');
      const setRow = (key, measured, field, [min, max], margin, unit) => {
        const row = this.host.querySelector(`[data-axis-row="${key}"]`);
        const reading = this.nodes['reading-' + key];
        if (!row || !reading) return;
        let text = (sim ? 'Simulé ' : 'Mesuré ') + (Number.isFinite(measured) ? format(measured, unit) : '—');
        if (Number.isFinite(measured) && Number.isFinite(field)) text += ' · écart ' + sign(field - measured) + unit;
        const out = Number.isFinite(field) && (field < min || field > max);
        const near = [field, measured].some(value => Number.isFinite(value) && (value < min + margin || value > max - margin));
        if (out) text += ' · hors limites';
        else if (near) text += ' · proche de la limite';
        if (reading.textContent !== text) reading.textContent = text;
        row.classList.toggle('is-near', near && !out);
        row.classList.toggle('is-out', out);
        const mark = this.nodes['mark-' + key];
        const wrap = this.nodes['slider-wrap-' + key];
        if (wrap) {
          const span = max - min || 1;
          wrap.style.setProperty('--rb-lo', (margin / span * 100).toFixed(2) + '%');
          wrap.style.setProperty('--rb-hi', (100 - margin / span * 100).toFixed(2) + '%');
        }
        if (mark) {
          mark.hidden = !Number.isFinite(measured);
          if (Number.isFinite(measured)) {
            const share = Math.min(1, Math.max(0, (measured - min) / (max - min || 1)));
            mark.style.setProperty('--rb-at-n', share.toFixed(4));
          }
        }
      };
      const limits = state.config.joint_limits;
      for (const key of axisKeys) {
        const [min, max] = limits[key];
        setRow(key, actual?.[key], this.form[key].valueAsNumber, [min, max], Math.min(5, (max - min) * .05), '°');
      }
      for (const key of ['x', 'y', 'z']) {
        setRow(key, xyz?.[key], this.form[key].valueAsNumber, state.config.workspace[key], 10, ' mm');
      }
      setRow('t', actual?.hand, this.form.t.valueAsNumber, limits.hand, Math.min(5, (limits.hand[1] - limits.hand[0]) * .05), '°');
      // Keep-out proximity of the target in the fields (TCP and elbow, like the server's capsule check).
      const pose = this.fieldPose();
      const links = pose ? armLinks(pose) : null;
      const points = this.mode === 'cartesian'
        ? [{ x: this.form.x.valueAsNumber, y: this.form.y.valueAsNumber, z: this.form.z.valueAsNumber }]
        : (links ? [links.tcp, links.elbow] : []);
      let warning = '';
      let inside = false;
      for (const zone of state.config.keepout || []) {
        const gap = Math.min(...points.filter(point => ['x', 'y', 'z'].every(k => Number.isFinite(point[k])))
          .map(point => boxDistance(point, zone)));
        if (!Number.isFinite(gap)) continue;
        if (gap <= 22) { warning = `Cible dans la zone d’exclusion « ${zone.name} » : le serveur refusera ce mouvement.`; inside = true; break; }
        if (gap < 60 && !warning) warning = `Cible à ${Math.round(gap)} mm de la zone d’exclusion « ${zone.name} ».`;
      }
      if (!warning && actual && (state.config.keepout || []).length) {
        const liveLinks = armLinks(actual);
        const livePts = [liveLinks.tcp, liveLinks.elbow].filter(p => ['x', 'y', 'z'].every(k => Number.isFinite(p[k])));
        let closest = Infinity;
        let closestName = '';
        for (const zone of state.config.keepout) {
          const gap = Math.min(...livePts.map(pt => boxDistance(pt, zone)));
          if (gap < closest) { closest = gap; closestName = zone.name; }
        }
        if (closest <= 25) {
          warning = `Proximité zone « ${closestName} » · ${Math.round(closest)} mm`;
          if (this.lastKeepoutWarnZone !== closestName) {
            this.lastKeepoutWarnZone = closestName;
            this.playHudSound('warn');
          }
        } else {
          this.lastKeepoutWarnZone = '';
        }
      }
      const toolMm = Math.max(0, Number(this.nodes['tool-offset']?.valueAsNumber) || 0);
      const floorZ = Number(this.nodes['floor-z']?.valueAsNumber);
      const targetZ = this.mode === 'cartesian' ? this.form.z.valueAsNumber : links?.tcp?.z;
      if (!warning && Number.isFinite(floorZ) && Number.isFinite(targetZ) && (targetZ - toolMm) < floorZ) {
        warning = `Garde plancher : pointe outil (${Math.round(targetZ - toolMm)} mm) sous le plancher Z ${Math.round(floorZ)} mm.`;
        inside = true;
      }
      const note = this.nodes['pose-warn'];
      if (note.textContent !== warning) note.textContent = warning;
      note.hidden = !warning;
      note.classList.toggle('is-inside', inside);
      this.drawSide(this.displayActual(), pose);
      this.drawVisualGauges(this.displayActual(), pose);
      this.updateSpace();
    }

    // The 3D view lives in its own file, loaded the first time the tab is opened.
    mountSpace() {
      if (this.space || this.spaceLoading) { this.updateSpace(); return; }
      const url = typeof window.hqAssetUrl === 'function' ? window.hqAssetUrl('hq-robotics-3d.js') : '/assets/hq-robotics-3d.js';
      this.spaceLoading = new Promise((resolve, reject) => {
        if (window.HqRobotics3D) { resolve(); return; }
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error('Vue 3D indisponible')); };
        document.head.append(script);
      }).then(() => {
        this.space = window.HqRobotics3D.create(this.nodes.space);
        this.space.onview = name => this.host.querySelectorAll('[data-space-view]').forEach(button =>
          button.setAttribute('aria-pressed', String(button.dataset.spaceView === name)));
        this.space.onpick = index => this.composeSelect(index);
        this.space.onjoint = key => this.focusJointControl(key);
        this.space.onhover = hint => this.setHoverExplain(hint);
        if (this.zonesOpen) this.renderZones(false);
        this.space.ondragstart = () => this.pushUndo(this.zonesOpen ? 'zones' : 'compose');
        this.space.onpickzone = index => { this.zoneSelected = index; this.renderZones(); this.updateSpace(); };
        this.space.ondragzone = (handle, delta) => this.zoneDrag(handle, delta);
        this.space.ondrag = (index, xyz, kind) => kind === 'via' ? this.composeVia(index, xyz) : this.composeDrag(index, xyz);
        this.updateSpace();
      }).catch(error => {
        this.nodes['space-note'].textContent = error.message;
      }).finally(() => { this.spaceLoading = null; });
    }

    workbenchOverlay() {
      const rows = Math.min(4, Math.max(1, Math.round(this.nodes['pal-rows']?.valueAsNumber || 2)));
      const cols = Math.min(4, Math.max(1, Math.round(this.nodes['pal-cols']?.valueAsNumber || 3)));
      const x0 = Number(this.nodes['pal-ax']?.valueAsNumber || 200);
      const y0 = Number(this.nodes['pal-ay']?.valueAsNumber || -80);
      const bx = Number(this.nodes['pal-bx']?.valueAsNumber || 290);
      const by = Number(this.nodes['pal-by']?.valueAsNumber || 80);
      const z = Number(this.nodes['pal-z']?.valueAsNumber || 70);
      const dx = rows > 1 ? (bx - x0) / (rows - 1) : 0;
      const dy = cols > 1 ? (by - y0) / (cols - 1) : 0;
      const active = (this.palletCellIndex || 0) % (rows * cols);
      const resolveXy = ep => {
        if (!ep) return null;
        if (typeof ep === 'string') {
          const p = this.presets?.[ep];
          if (!p) return null;
          if (p.xyz) return p.xyz;
          if (p.pose) return armLinks(p.pose).tcp;
          return null;
        }
        if (Number.isFinite(ep.x) && Number.isFinite(ep.y)) return ep;
        if (Number.isFinite(ep.base)) return armLinks(ep).tcp;
        return null;
      };
      const srcXy = resolveXy(this.resolveTxEndpoint('tx-source'));
      const dstXy = resolveXy(this.resolveTxEndpoint('tx-dest'));
      return {
        pallet: { rows, cols, x0, y0, dx, dy, z, active },
        transfer: srcXy && dstXy ? {
          ax: srcXy.x, ay: srcXy.y, bx: dstXy.x, by: dstXy.y,
          z: Math.min(srcXy.z ?? 75, dstXy.z ?? 75),
          safeZ: Math.max(srcXy.z ?? 75, dstXy.z ?? 75) + Number(this.nodes['tx-clear']?.valueAsNumber || 55),
        } : null,
      };
    }

    spaceScene() {
      const compose = this.composeOpen ? this.compose : null;
      const zoneEdit = this.zonesOpen && this.zoneDraft ? { zones: this.zoneDraft, selected: this.zoneSelected } : null;
      const flight = this.flightEntry();
      const target = flight?.target ? flight.target : (compose && compose.selected != null ? compose.points[compose.selected] : this.fieldPose());
      const measured = flight?.actual ? flight.actual : (this.displayActual() || null);
      const load = flight?.load ? flight.load : (this.state.feedback?.load || null);
      const holding = Boolean(this.holdingObject || (measured?.hand >= 125 && Math.abs(load?.hand || 0) >= 130));
      return { config: this.state.config, measured, target, load,
        holding, payloadGrams: this.lastEstimatedGrams,
        workbench: this.workbenchOverlay(),
        compose: compose ? { points: compose.points, legs: compose.legs, selected: compose.selected, bad: compose.bad } : null,
        zoneEdit };
    }

    updateSpace() {
      if (!this.space || !this.state || this.spacePlaying) return;
      const scene = this.spaceScene();
      this.space.update(scene);
      const flight = this.flightEntry();
      if (flight) {
        const label = `Journal noir · éch. ${this.flightIndex + 1} / ${this.flightEntries.length}`;
        if (this.nodes['space-note'].textContent !== label) this.nodes['space-note'].textContent = label;
        return;
      }
      const sim = this.state.config.mode === 'simulation';
      const note = scene.measured ? (sim ? 'Pose simulée' : 'Pose mesurée') + (scene.target ? ' · fantôme : champs' : '')
        : 'Aucune mesure du bras · pose des champs';
      if (this.nodes['space-note'].textContent !== note) this.nodes['space-note'].textContent = note;
    }

    // ---- Movement editor (3D). Points are full poses; the first one is the start.
    // ---- Exclusion zones drawn in 3D. A draft until saved through the settings endpoint.
    zonesToggle(open = !this.zonesOpen) {
      if (open && !this.state) { this.message('État du poste en cours de chargement. Réessayez dans un instant.'); return; }
      this.zonesOpen = open;
      if (open && this.composeOpen) this.composeToggle(false);
      if (open && this.flightOpen) this.flightToggle(false);
      if (open) {
        this.undoStacks = { ...(this.undoStacks || {}), zones: [] };
        this.zoneDraft = JSON.parse(JSON.stringify(this.state?.config.keepout || []));
        this.zoneSelected = this.zoneDraft.length ? 0 : null;
        if (this.monitor !== 'space') this.selectMonitor('space');
      }
      this.nodes.zones.hidden = !open;
      this.nodes['zones-toggle'].setAttribute('aria-pressed', String(open));
      this.nodes['zones-toggle'].textContent = open ? 'Fermer les zones' : 'Zones d’exclusion';
      this.nodes['zones-result'].textContent = '';
      this.renderZones();
      this.updateSpace();
    }

    zonesDirty() {
      return JSON.stringify(this.zoneDraft || []) !== JSON.stringify(this.state?.config.keepout || []);
    }

    // Keep a box inside the XYZ limits. A moved box keeps its size; a resized face stops at the limit.
    clampZone(zone, keepSize = false) {
      const ws = this.state.config.workspace;
      for (const axis of ['x', 'y', 'z']) {
        let [lo, hi] = zone[axis].map(value => Math.round(value));
        const [min, max] = ws[axis];
        if (keepSize) {
          if (lo < min) { hi += min - lo; lo = min; }
          if (hi > max) { lo -= hi - max; hi = max; }
        }
        lo = Math.min(Math.max(min, lo), max - 10);
        hi = Math.max(Math.min(max, hi), lo + 10);
        zone[axis] = [lo, hi];
      }
      return zone;
    }

    zoneAdd() {
      const draft = this.zoneDraft;
      if (!draft || !this.state) return;
      if (draft.length >= 12) { this.message('Douze zones au plus.', true); return; }
      let n = draft.length + 1;
      while (draft.some(zone => zone.name.toLowerCase() === ('zone ' + n).toLowerCase())) n++;
      this.pushUndo('zones');
      draft.push(this.clampZone({ name: 'Zone ' + n, x: [210, 290], y: [-40, 40], z: [60, 140] }));
      this.zoneSelected = draft.length - 1;
      this.renderZones();
      this.updateSpace();
    }

    zoneDrag(handle, delta) {
      const zone = this.zoneDraft?.[handle.index];
      if (!zone) return;
      const box = handle.box;
      const next = { name: zone.name, x: [...box.x], y: [...box.y], z: [...box.z] };
      if (handle.kind === 'zone-face') {
        next[handle.axis][handle.side] += delta[handle.axis];
        if (next[handle.axis][1] - next[handle.axis][0] < 10) return;
      } else {
        for (const axis of ['x', 'y', 'z']) next[axis] = next[axis].map(value => value + delta[axis]);
      }
      this.zoneDraft[handle.index] = this.clampZone(next, handle.kind !== 'zone-face');
      this.zoneSelected = handle.index;
      this.renderZones(false);
      this.updateSpace();
    }

    renderZones(rebuild = true) {
      if (!this.zoneDraft) return;
      const dirty = this.zonesDirty();
      this.nodes['zones-count'].textContent = this.zoneDraft.length + ' / 12' + (dirty ? ' · brouillon' : '');
      this.nodes['zones-save'].disabled = !dirty || !this.state?.physical_local || !!this.lease || this.zonesBusy;
      this.nodes['zones-revert'].disabled = !dirty;
      // A box that touches the arm where it stands refuses every move starting from that pose.
      const poses = [['à la pose neutre', { base: 0, shoulder: 0, elbow: 90, hand: 180 }]];
      if (this.state?.feedback) poses.push(['à la pose mesurée', this.state.feedback.actual]);
      const hits = [];
      for (const zone of this.zoneDraft) {
        for (const [label, pose] of poses) {
          if (window.HqRobotics3D?.touches(pose, zone)) hits.push(`« ${zone.name.trim() || 'sans nom'} » touche le bras ${label}`);
        }
      }
      this.nodes['zones-conflict'].textContent = hits.length
        ? hits.join(' · ') + ' : tout mouvement partant de cette pose serait refusé. Écartez la zone du bras.' : '';
      const list = this.nodes['zones-list'];
      if (!rebuild) {
        // Keep focus while dragging: only refresh the numbers.
        this.zoneDraft.forEach((zone, index) => {
          for (const axis of ['x', 'y', 'z']) [0, 1].forEach(side => {
            const input = list.querySelector(`[data-zone="${index}"][data-axis="${axis}"][data-side="${side}"]`);
            if (input && document.activeElement !== input) input.value = zone[axis][side];
          });
        });
        list.querySelectorAll('.rb-zone').forEach(row => row.classList.toggle('is-selected', Number(row.dataset.index) === this.zoneSelected));
        return;
      }
      list.replaceChildren(...this.zoneDraft.map((zone, index) => {
        const row = document.createElement('div');
        row.className = 'rb-zone' + (index === this.zoneSelected ? ' is-selected' : '');
        row.dataset.index = index;
        const name = document.createElement('input');
        name.maxLength = 40;
        name.value = zone.name;
        name.setAttribute('aria-label', 'Nom de la zone');
        name.addEventListener('focus', () => { this.zoneSelected = index; this.renderZones(false); this.updateSpace(); });
        name.addEventListener('input', () => { this.pushUndo('zones', { coalesce: true }); zone.name = name.value; this.renderZones(false); this.updateSpace(); });
        row.append(name);
        for (const axis of ['x', 'y', 'z']) {
          const group = document.createElement('label');
          const title = document.createElement('span');
          title.className = 'rb-zone-axis';
          title.textContent = axis.toUpperCase() + ' mm';
          group.append(title);
          for (const side of [0, 1]) {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '1';
            input.value = zone[axis][side];
            Object.assign(input.dataset, { zone: index, axis, side });
            input.setAttribute('aria-label', `${zone.name} · ${axis.toUpperCase()} ${side ? 'max' : 'min'}`);
            input.addEventListener('change', () => {
              if (!Number.isFinite(input.valueAsNumber)) return;
              this.pushUndo('zones');
              zone[axis][side] = input.valueAsNumber;
              this.clampZone(zone);
              this.zoneSelected = index;
              this.renderZones(false);
              this.updateSpace();
            });
            group.append(input);
          }
          row.append(group);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        setGlyph(remove, '✕');
        remove.title = 'Supprimer cette zone (Suppr)';
        remove.setAttribute('aria-label', 'Supprimer ' + zone.name);
        remove.addEventListener('click', () => this.zoneRemove(index));
        row.append(remove);
        return row;
      }));
    }

    async zonesSave() {
      if (!this.askConfirm('zones-save', this.nodes['zones-save'], 'Confirmer : enregistrer les zones',
        'Cliquez de nouveau : l’approbation de mise en service et les scripts approuvés seront à refaire.')) return;
      this.zonesBusy = true;
      this.renderZones(false);
      try {
        const keepout = this.zoneDraft.map(zone => ({ name: zone.name.trim(), x: zone.x, y: zone.y, z: zone.z }));
        await this.request('settings', { keepout });
        this.stopVideo();
        this.havePoseFeedback = false;
        this.nightLoaded = false;
        this.render(await this.request('status'));
        this.zoneDraft = JSON.parse(JSON.stringify(this.state.config.keepout || []));
        this.nodes['zones-result'].dataset.state = 'ok';
        this.nodes['zones-result'].textContent = 'Zones enregistrées : ' + this.zoneDraft.length + '.';
        this.message('Zones d’exclusion enregistrées. Pensez à mettre à jour les scripts de la Bibliothèque.');
      } catch (error) {
        this.nodes['zones-result'].dataset.state = 'bad';
        this.nodes['zones-result'].textContent = error.message;
      } finally {
        this.zonesBusy = false;
        this.renderZones();
        this.updateSpace();
      }
    }

    // ---- Undo for the two editors. Snapshots of the draft, one per action: a slider drag or a 3D drag is a single step.
    snapshot(kind) {
      return JSON.stringify(kind === 'zones' ? { zones: this.zoneDraft, selected: this.zoneSelected }
        : { points: this.compose.points, legs: this.compose.legs, selected: this.compose.selected });
    }

    pushUndo(kind, { coalesce = false } = {}) {
      const stacks = this.undoStacks ||= { compose: [], zones: [] };
      const now = performance.now();
      if (coalesce && this.lastUndoKind === kind && now - (this.lastUndoAt || 0) < 800) { this.lastUndoAt = now; return; }
      const shot = this.snapshot(kind);
      const stack = stacks[kind];
      if (stack.at(-1) !== shot) {
        stack.push(shot);
        if (stack.length > 50) stack.shift();
      }
      this.lastUndoAt = now;
      this.lastUndoKind = kind;
      this.renderUndo();
    }

    renderUndo() {
      for (const kind of ['compose', 'zones']) {
        const button = this.nodes[kind + '-undo'];
        if (button) button.disabled = !this.undoStacks?.[kind]?.length;
      }
    }

    undo(kind) {
      const stack = this.undoStacks?.[kind];
      if (!stack?.length) return;
      const data = JSON.parse(stack.pop());
      this.lastUndoAt = 0;
      if (kind === 'zones') {
        this.zoneDraft = data.zones;
        this.zoneSelected = data.selected;
        this.renderZones();
      } else {
        Object.assign(this.compose, data);
        if (data.selected != null && this.compose.points[data.selected]) this.loadPose(this.compose.points[data.selected]);
        this.composeChanged();
      }
      this.renderUndo();
      this.updateSpace();
    }

    editorKeys(event) {
      if (!this.active || event.altKey) return;
      const typing = event.target.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]');
      if (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.toggleShortcuts();
        return;
      }
      const kind = this.zonesOpen ? 'zones' : (this.composeOpen ? 'compose' : null);
      if (!kind) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (typing) return;  // a text field undoes its own typing
        event.preventDefault();
        this.undo(kind);
      } else if (event.key === 'Delete' && !typing && !event.ctrlKey && !event.metaKey) {
        const index = kind === 'zones' ? this.zoneSelected : this.compose.selected;
        if (index == null) return;
        event.preventDefault();
        if (kind === 'zones') this.zoneRemove(index); else this.composeRemove(index);
      }
    }

    composeDraftSave() {
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => {
        try {
          if (!this.compose?.points.length) { localStorage.removeItem(DRAFT_STORE); return; }
          localStorage.setItem(DRAFT_STORE, JSON.stringify({ points: this.compose.points, legs: this.compose.legs,
            title: this.nodes['compose-title'].value, summary: this.nodes['compose-summary'].value }));
        } catch (_) {}
      }, 400);
    }

    composeDraftRestore() {
      try {
        const draft = JSON.parse(localStorage.getItem(DRAFT_STORE) || 'null');
        const poseOk = pose => pose && axisKeys.every(key => Number.isFinite(pose[key]));
        if (!draft || !Array.isArray(draft.points) || !draft.points.length || draft.points.length > 17
            || !draft.points.every(poseOk) || !Array.isArray(draft.legs) || draft.legs.length !== draft.points.length) return null;
        return { points: draft.points.map(pose => this.roundPose(pose)),
          legs: draft.legs.map((spec, index) => {
            if (index === 0) return null;
            if (!spec || !['joint', 'linear', 'arc', 'smooth'].includes(spec.type)) return { type: 'joint' };
            const clean = { type: spec.type };
            if (spec.type === 'arc') { clean.via = spec.via; clean.turns = spec.turns ? 1 : 0; }
            if (Number.isFinite(Number(spec.speed_pct)) && Number(spec.speed_pct) !== 100) {
              clean.speed_pct = Math.min(100, Math.max(25, Math.round(Number(spec.speed_pct))));
            }
            if (Number.isFinite(Number(spec.dwell)) && Number(spec.dwell) > 0) {
              clean.dwell = Math.min(10, Math.max(0, Math.round(Number(spec.dwell) * 10) / 10));
            }
            return clean;
          }),
          title: String(draft.title || '').slice(0, 96), summary: String(draft.summary || '').slice(0, 160) };
      } catch (_) { return null; }
    }

    composeRemove(index) {
      const compose = this.compose;
      if (!compose?.points[index]) return;
      this.pushUndo('compose');
      compose.points.splice(index, 1);
      compose.legs.splice(index, 1);
      compose.legs[0] = null;
      compose.selected = compose.points.length ? Math.min(index, compose.points.length - 1) : null;
      if (compose.selected != null) this.loadPose(compose.points[compose.selected]);
      this.composeChanged();
    }

    zoneRemove(index) {
      if (!this.zoneDraft?.[index]) return;
      this.pushUndo('zones');
      this.zoneDraft.splice(index, 1);
      this.zoneSelected = this.zoneDraft.length ? Math.min(index, this.zoneDraft.length - 1) : null;
      this.renderZones();
      this.updateSpace();
    }

    composeToggle(open = !this.composeOpen) {
      if (open && this.zonesOpen) this.zonesToggle(false);
      if (open && this.flightOpen) this.flightToggle(false);
      this.composeOpen = open;
      this.compose ||= { points: [], legs: [], selected: null, bad: null, checked: false };
      if (open && !this.compose.points.length) {
        const draft = this.composeDraftRestore();
        if (draft) {
          this.compose = { ...this.compose, points: draft.points, legs: draft.legs, selected: 0 };
          this.nodes['compose-title'].value = draft.title;
          this.nodes['compose-summary'].value = draft.summary;
          this.loadPose(draft.points[0]);
          this.message(`Brouillon retrouvé : ${draft.points.length} point${draft.points.length > 1 ? 's' : ''}.`);
        }
      }
      this.nodes.compose.hidden = !open;
      this.nodes['compose-toggle'].setAttribute('aria-pressed', String(open));
      this.nodes['compose-toggle'].textContent = open ? 'Fermer l’éditeur' : 'Composer un mouvement';
      if (open) {
        if (this.monitor !== 'space') this.selectMonitor('space');
        this.selectMode('joints');
      }
      this.renderCompose();
      this.updateSpace();
      if (open) this.composeAutoCheck();
    }

    composeChanged() {
      this.compose.bad = null;
      this.compose.checked = false;
      this.compose.failed = false;
      this.nodes['compose-result'].textContent = '';
      this.nodes['compose-result'].dataset.state = '';
      this.renderCompose();
      this.updateSpace();
      this.composeDraftSave();
      this.composeAutoCheck();
    }

    // HQ checks the script as it is edited, after a short pause, so a failing step shows at once.
    composeAutoCheck() {
      clearTimeout(this.autoCheckTimer);
      this.autoCheckToken = (this.autoCheckToken || 0) + 1;
      if (!this.composeOpen || this.compose.points.length < 2) return;
      const out = this.nodes['compose-result'];
      out.dataset.state = 'pending';
      out.textContent = 'Vérification…';
      const token = this.autoCheckToken;
      this.autoCheckTimer = setTimeout(() => this.composeCheck(token), 600);
    }

    composeAdd(pose) {
      if (!pose) { this.message('Pose incomplète : vérifiez les quatre angles.', true); return; }
      if (this.compose.points.length >= 17) { this.message('Seize étapes au plus après le départ.', true); return; }
      this.pushUndo('compose');
      const title = this.nodes['compose-title'];
      if (!title.value.trim()) {
        title.value = 'Mouvement du ' + new Date().toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', ' à');
      }
      const at = this.compose.selected == null ? this.compose.points.length : this.compose.selected + 1;
      this.compose.points.splice(at, 0, this.roundPose(pose));
      this.compose.legs.splice(at, 0, { type: 'joint' });
      this.compose.legs[0] = null;
      this.compose.selected = at;
      this.loadPose(this.compose.points[at]);
      this.composeChanged();
    }

    // The Pilotage fields serve both the arm and the editor's selected point. When Pilotage code rewrites them
    // (a reading, a jog, a preset, the return home), the point is let go first: otherwise the next slider
    // nudge would copy those values into it.
    releaseComposePoint() {
      if (!this.composeOpen || this.compose?.selected == null) return;
      this.compose.selected = null;
      this.renderCompose();
      this.updateSpace();
      this.message('Point de l’éditeur désélectionné : les champs suivent maintenant le bras.');
    }

    pilotFields(pose, xyz) {
      this.releaseComposePoint();
      this.loadPose(pose, xyz);
    }

    roundPose(pose) {
      return Object.fromEntries(axisKeys.map(key => [key, Math.round(pose[key] * 10) / 10]));
    }

    composeSelect(index) {
      if (!this.compose || index == null || !this.compose.points[index]) return;
      this.compose.selected = index;
      if (this.mode !== 'joints') this.selectMode('joints');
      this.loadPose(this.compose.points[index]);
      this.clearPreview();
      this.pilotAids();
      this.renderCompose();
    }

    // Field edits (typing, sliders, gripper buttons) reshape the selected point.
    composeFromFields() {
      const compose = this.composeOpen && this.compose;
      if (!compose || compose.selected == null) return;
      let pose = this.fieldPose();
      if (this.mode === 'cartesian' && window.HqRobotics3D) {
        pose = window.HqRobotics3D.ik(this.form.x.valueAsNumber, this.form.y.valueAsNumber,
          this.form.z.valueAsNumber, this.form.t.valueAsNumber);
      }
      if (!pose || axisKeys.some(key => !Number.isFinite(pose[key]))) return;
      this.pushUndo('compose', { coalesce: true });
      compose.points[compose.selected] = this.roundPose(pose);
      if (this.mode === 'cartesian') {
        for (const key of axisKeys) {
          this.form[key].value = compose.points[compose.selected][key];
          if (this.nodes['slider-' + key]) this.nodes['slider-' + key].value = this.form[key].value;
        }
      }
      this.composeChanged();
    }

    composeDrag(index, xyz) {
      const point = this.compose?.points[index];
      if (!point) return;
      const pose = window.HqRobotics3D.ik(xyz.x, xyz.y, xyz.z, point.hand);
      if (!pose) return;  // out of reach: the point stays where it was
      this.compose.points[index] = this.roundPose(pose);
      if (index === this.compose.selected) this.loadPose(this.compose.points[index]);
      this.pilotAids();
      this.composeChanged();
    }

    composeMove(index, delta) {
      const points = this.compose.points;
      const to = index + delta;
      if (to < 0 || to >= points.length) return;
      this.pushUndo('compose');
      const legs = this.compose.legs;
      [points[index], points[to]] = [points[to], points[index]];
      [legs[index], legs[to]] = [legs[to], legs[index]];
      legs[0] = null;
      for (let i = 1; i < legs.length; i++) legs[i] ||= { type: 'joint' };
      this.compose.selected = to;
      this.composeChanged();
    }

    // Arc legs pass through a via point you drag in 3D (blue square).
    composeVia(index, xyz) {
      const spec = this.compose?.legs[index];
      if (!spec || spec.type !== 'arc') return;
      spec.via = { x: Math.round(xyz.x * 10) / 10, y: Math.round(xyz.y * 10) / 10, z: Math.round(xyz.z * 10) / 10 };
      this.composeChanged();
    }

    composeLeg(index, value) {
      this.pushUndo('compose');
      const [type, turn] = value.split(':');
      const previous = this.compose.legs[index];
      const spec = { type };
      if (type === 'arc') {
        spec.via = previous?.via || this.defaultVia(index);
        spec.turns = turn === 'turn' ? 1 : 0;
      }
      if (previous?.speed_pct && previous.speed_pct !== 100) spec.speed_pct = previous.speed_pct;
      if (previous?.dwell && previous.dwell > 0) spec.dwell = previous.dwell;
      this.compose.legs[index] = spec;
      this.composeChanged();
    }

    composeLegTuning() {
      const index = this.compose?.selected;
      if (!index || index < 1 || !this.compose?.legs[index]) return;
      this.pushUndo('compose', { coalesce: true });
      const spec = this.compose.legs[index];
      const speedPct = Math.min(100, Math.max(25, Math.round(this.nodes['compose-leg-speed']?.valueAsNumber || 100)));
      const dwell = Math.min(10, Math.max(0, Math.round((this.nodes['compose-leg-dwell']?.valueAsNumber || 0) * 10) / 10));
      if (speedPct !== 100) spec.speed_pct = speedPct; else delete spec.speed_pct;
      if (dwell > 0) spec.dwell = dwell; else delete spec.dwell;
      if (this.nodes['compose-leg-speed-val']) this.nodes['compose-leg-speed-val'].textContent = speedPct + ' %';
      this.composeChanged();
    }

    // An arc passes 60 mm above the middle of its leg until the via point is dragged elsewhere.
    defaultVia(index) {
      const [a, b] = [this.compose.points[index - 1], this.compose.points[index]].map(pose => armLinks(pose).tcp);
      return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), z: Math.round((a.z + b.z) / 2 + 60) };
    }

    composeLegs() {
      return this.compose.legs.slice(1, this.compose.points.length).map((spec, offset) => {
        const base = !spec || spec.type === 'joint' ? { type: 'joint' } :
          spec.type === 'arc' ? { type: 'arc', via: spec.via || this.defaultVia(offset + 1), turns: spec.turns ? 1 : 0 } : { type: spec.type };
        if (spec?.speed_pct && spec.speed_pct !== 100) base.speed_pct = spec.speed_pct;
        if (spec?.dwell && spec.dwell > 0) base.dwell = spec.dwell;
        return base;
      });
    }

    composeScript() {
      const [start, ...steps] = this.compose.points;
      return { start, steps, legs: this.composeLegs(), title: this.nodes['compose-title'].value.trim(),
        summary: this.nodes['compose-summary'].value.trim(), speed: Number(this.nodes.speed.value) || undefined };
    }

    renderCompose() {
      if (!this.compose) return;
      const { points, selected, bad } = this.compose;
      const count = points.length;
      this.nodes['compose-count'].textContent = count ? (count === 1 ? 'Départ seul' : `Départ + ${count - 1} étape${count > 2 ? 's' : ''}`) : 'Aucun point';
      const rows = points.map((pose, index) => {
        const li = document.createElement('li');
        li.dataset.state = index === bad ? 'bad' : '';
        li.setAttribute('aria-selected', String(index === selected));
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'rb-compose-pick';
        const still = index > 0 && axisKeys.every(key => Math.abs(pose[key] - points[index - 1][key]) < .25);
        li.dataset.warn = still ? 'still' : '';
        const main = document.createElement('span');
        main.textContent = (index === 0 ? 'Départ' : 'Étape ' + index) + ' · ' +
          axisKeys.map(key => format(pose[key], '°')).join(' / ') + (still ? ' · aucun mouvement' : '');
        const tip = armLinks(pose).tcp;
        const legInfo = index > 0 ? this.compose.legs[index] : null;
        const legTuning = (legInfo?.speed_pct && legInfo.speed_pct !== 100 ? ` · ${legInfo.speed_pct}%` : '') +
          (legInfo?.dwell > 0 ? ` · pause ${legInfo.dwell}s` : '');
        const where = document.createElement('span');
        where.className = 'rb-compose-xyz';
        where.textContent = `X ${Math.round(tip.x)} · Y ${Math.round(tip.y)} · Z ${Math.round(tip.z)} mm` + legTuning;
        pick.append(main, where);
        pick.addEventListener('click', () => this.composeSelect(index));
        li.append(pick);
        if (index > 0) {
          const select = document.createElement('select');
          select.className = 'rb-compose-leg';
          select.setAttribute('aria-label', 'Trajectoire vers l’étape ' + index);
          for (const [value, label] of [['joint', 'Articulaire'], ['linear', 'Linéaire'], ['arc', 'Arc'],
            ['arc:turn', 'Arc + tour complet'], ['smooth', 'Lissé']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
          }
          const spec = this.compose.legs[index] || { type: 'joint' };
          select.value = spec.type === 'arc' && spec.turns ? 'arc:turn' : spec.type;
          select.addEventListener('change', () => this.composeLeg(index, select.value));
          li.append(select);
        } else {
          const spacer = document.createElement('span');
          spacer.className = 'rb-compose-leg';
          spacer.setAttribute('aria-hidden', 'true');
          li.append(spacer);
        }
        for (const [label, title, action] of [['↑', 'Monter', () => this.composeMove(index, -1)],
          ['↓', 'Descendre', () => this.composeMove(index, 1)],
          ['⧉', 'Dupliquer', () => { this.compose.selected = index; this.composeAdd(pose); }],
          ['→', 'Aller à ce point', () => this.run(() => this.goToPose(pose, index === 0 ? 'Aller au départ' : 'Aller à l’étape ' + index))],
          ['✕', 'Supprimer', () => this.composeRemove(index)]]) {
          const button = document.createElement('button');
          button.type = 'button';
          setGlyph(button, label);
          button.title = title;
          button.setAttribute('aria-label', title + ' · ' + (index === 0 ? 'départ' : 'étape ' + index));
          button.addEventListener('click', action);
          if (label === '→') {
            button.dataset.composeGoto = String(index);
            button.disabled = !this.armedNow;
            button.title = 'Aller à ce point (poste armé ; pas mesurés sur le vrai bras)';
          }
          li.append(button);
        }
        return li;
      });
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'rb-compose-empty';
        empty.textContent = 'Aucun point. Ajoutez un départ avec « Pose des champs » ou « Pose mesurée », puis les étapes du mouvement.';
        rows.push(empty);
      }
      this.nodes['compose-list'].replaceChildren(...rows);
      const hasLeg = selected != null && selected > 0 && !!this.compose.legs[selected];
      if (this.nodes['compose-tuning']) {
        this.nodes['compose-tuning'].hidden = !hasLeg;
        if (hasLeg) {
          const legSpec = this.compose.legs[selected] || { type: 'joint' };
          const sp = legSpec.speed_pct || 100;
          const dw = legSpec.dwell || 0;
          if (document.activeElement !== this.nodes['compose-leg-speed']) this.nodes['compose-leg-speed'].value = String(sp);
          if (this.nodes['compose-leg-speed-val']) this.nodes['compose-leg-speed-val'].textContent = sp + ' %';
          if (document.activeElement !== this.nodes['compose-leg-dwell']) this.nodes['compose-leg-dwell'].value = String(dw);
        }
      }
      const ready = count >= 2 && !!this.nodes['compose-title'].value.trim();
      this.nodes['compose-send'].disabled = !ready || this.composeBusy || !!this.compose.failed;
      this.nodes['compose-play'].disabled = count < 2;
      this.nodes['compose-add-measured'].disabled = !this.state?.feedback;
      if (this.nodes['compose-scrub-wrap']) this.nodes['compose-scrub-wrap'].hidden = count < 2;
      if (count < 2) this.composeScrubPose = null;
      else if (this.nodes['compose-scrub']) this.scrubComposePreview(Number(this.nodes['compose-scrub'].value) || 0, false);
    }

    scrubComposePreview(pct = Number(this.nodes['compose-scrub']?.value || 0), push3d = true) {
      const pts = this.compose?.points || [];
      const wrap = this.nodes['compose-scrub-wrap'];
      if (!wrap || pts.length < 2) { this.composeScrubPose = null; return; }
      const k = Math.max(0, Math.min(1, pct / 100));
      const f = k * (pts.length - 1);
      const idx = Math.min(pts.length - 2, Math.floor(f));
      const local = f - idx;
      // compose.points holds full poses (the first one is the start), not { pose } wrappers.
      const a = pts[idx], b = pts[idx + 1];
      const pose = Object.fromEntries(axisKeys.map(key => [key, a[key] + (b[key] - a[key]) * local]));
      this.composeScrubPose = pose;
      if (this.nodes['compose-scrub-label']) this.nodes['compose-scrub-label'].textContent = `${Math.round(pct)} %`;
      const lib = window.HqRobotics3D;
      const lks = lib?.links ? lib.links(pose) : armLinks(pose);
      const raw = lks?.tcp;
      // HqRobotics3D.links() returns [x, y, z]; armLinks() returns { x, y, z }. Everything below reads a point.
      const tcp = Array.isArray(raw) ? { x: raw[0], y: raw[1], z: raw[2] } : raw;
      let clearance = null;
      for (const z of this.state?.config?.keepout || []) {
        const d = tcp ? boxDistance(tcp, z) : null;
        if (d != null) clearance = clearance == null ? d : Math.min(clearance, d);
      }
      if (this.nodes['compose-scrub-meta']) {
        const zStr = tcp ? `Z ${Math.round(tcp.z)} mm` : '';
        const cStr = clearance != null ? ` · marge zones ${Math.round(clearance)} mm` : '';
        const note = clearance != null
          ? (clearance < 25 ? ' · Kinétia: ⚠ Tight keepout' : ' · Kinétia: Clearance OK')
          : ' · Kinétia: Path nominal';
        this.nodes['compose-scrub-meta'].textContent = `Étape ${idx + 1}→${idx + 2}${zStr ? ' · ' + zStr : ''}${cStr}${note}`;
      }
      if (push3d) {
        this.drawSide(this.displayActual(), pose);
        if (this.space) {
          this.space.update({ ...this.spaceScene(), preview: pose });
        }
      }
    }

    async composeCheck(token) {
      const body = { ...this.composeScript(), dry_run: true, title: this.nodes['compose-title'].value.trim() || 'Vérification' };
      try {
        const result = await this.request('assistant/import', body);
        if (token !== this.autoCheckToken) return;  // the script changed again meanwhile
        const out = this.nodes['compose-result'];
        if (result.valid) {
          this.compose.bad = null;
          this.compose.checked = true;
          out.dataset.state = 'ok';
          out.textContent = `Vérifié par HQ : ${result.authored_steps ?? result.step_count} étape(s)` +
            (result.step_count !== result.authored_steps ? ` · ${result.step_count} poses générées` : '') +
            ` · ≈ ${result.estimated_seconds} s` +
            (result.min_clearance_mm != null ? ` · marge aux zones ${Math.round(result.min_clearance_mm)} mm` : '') +
            (result.warnings?.length ? ' · ⚠ ' + result.warnings.join(' ') : '');
        } else {
          this.compose.bad = result.leg || null;
          this.compose.failed = true;
          out.dataset.state = 'bad';
          out.textContent = result.reason;
        }
      } catch (error) {
        if (token !== this.autoCheckToken) return;
        this.nodes['compose-result'].dataset.state = 'bad';
        this.nodes['compose-result'].textContent = error.message;
      }
      this.renderCompose();
      this.updateSpace();
    }

    async composeSend() {
      this.composeBusy = true;
      this.renderCompose();
      try {
        const result = await this.request('assistant/import', this.composeScript());
        if (result.valid === false) {
          this.compose.bad = result.leg || null;
          this.nodes['compose-result'].dataset.state = 'bad';
          this.nodes['compose-result'].textContent = result.reason;
          return;
        }
        if (this.assistant) {
          this.assistant.thread = result;
          this.assistant.render(false);
        }
        this.nodes['compose-result'].dataset.state = 'ok';
        this.nodes['compose-result'].textContent = 'Envoyé. La carte est dans la Bibliothèque : lancez la revue de Kinétia.';
        this.message('Script envoyé à la revue. Kinétia passe en premier.');
        this.host.querySelector('[data-section="library"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } finally {
        this.composeBusy = false;
        this.renderCompose();
      }
    }

    // A library script back in the editor: sending it again creates a new version to review.
    composeLoad(script) {
      const plan = script.plan;
      const points = plan ? [script.start, ...plan.points] : [script.start, ...script.steps];
      if (points.length > 17) {
        this.message(`Ce script compte ${points.length - 1} poses (modifié en JSON) : l’éditeur en accepte 16. Utilisez « Voir en 3D » ou modifiez le JSON.`, true);
        return;
      }
      this.compose = { points: points.map(pose => this.roundPose(pose)),
        legs: [null, ...(plan ? plan.legs.map(spec => ({ ...spec })) : script.steps.map(() => ({ type: 'joint' })))],
        selected: 0, bad: null, checked: false };
      this.undoStacks = { ...(this.undoStacks || {}), compose: [] };
      this.nodes['compose-title'].value = (script.label || script.title || '').slice(0, 96);
      this.nodes['compose-summary'].value = (script.summary || '').slice(0, 160);
      this.monitorChosen = true;
      if (!(this.state?.config.mode === 'hardware' && this.lease)) this.stopVideo();
      this.selectMonitor('space');
      this.composeToggle(true);
      this.composeSelect(0);
      this.host.querySelector('[data-section="camera"]').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    // Library scripts: animate the steps in the 3D view without sending anything.
    play3d(script) {
      this.monitorChosen = true;
      if (!(this.state?.config.mode === 'hardware' && this.lease)) this.stopVideo();
      this.selectMonitor('space');
      if (!this.composeOpen) this.host.querySelector('[data-section="camera"]').scrollIntoView({ block: 'start', behavior: 'smooth' });
      const start = () => {
        this.stopSpacePlayback?.();
        this.spacePlaying = true;
        this.nodes['space-note'].textContent = 'Visualisation « ' + (script.label || script.title) + ' » · rien n’est envoyé au bras';
        this.stopSpacePlayback = window.HqRobotics3D.playback(this.space, script, () => this.spaceScene(), () => {
          this.spacePlaying = false;
          this.stopSpacePlayback = null;
          setTimeout(() => this.updateSpace(), 900);
        });
      };
      if (this.space) start();
      else (this.spaceLoading || Promise.resolve()).then(() => { if (this.space) start(); });
    }

    drawSide(actual, pose) {
      const canvas = this.nodes.side;
      if (!canvas || !this.state || canvas.offsetParent === null) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) [canvas.width, canvas.height] = pixels;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight') && !document.body.classList.contains('theme-oled');
      const c = light
        ? {
          area: '#eaf4f3', subGrid: 'rgba(71, 100, 102, .11)', line: '#87aba9', tick: '#476466',
          live: '#08724f', liveBeam: 'rgba(8, 114, 79, .24)', target: '#2b63c7', targetBeam: 'rgba(43, 99, 199, .14)',
          base: '#6f9292', baseDark: '#4d6f70', hole: '#ffffff',
        }
        : {
          area: '#122b32', subGrid: 'rgba(134, 225, 205, .07)', line: '#2f5f66', tick: '#8fabad',
          live: '#73edce', liveBeam: 'rgba(115, 237, 206, .24)', target: '#9fc5ff', targetBeam: 'rgba(159, 197, 255, .14)',
          base: '#466c72', baseDark: '#274248', hole: '#0b171e',
        };
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const ws = this.state.config.workspace;
      const reach = Math.max(Math.abs(ws.x[0]), Math.abs(ws.x[1]), Math.abs(ws.y[0]), Math.abs(ws.y[1]), UPPER + LOWER * .6);
      const zLow = Math.min(-60, ws.z[0] - 30);
      const zHigh = Math.max(ws.z[1], UPPER + 20) + 20;
      const rLow = -70;
      const pad = 22;
      const scale = Math.min((width - pad * 2) / (reach - rLow), (height - pad * 2) / (zHigh - zLow));
      const offset = (width - (reach - rLow) * scale) / 2;
      const X = r => offset + (r - rLow) * scale;
      const Y = z => height - pad - (z - zLow) * scale;
      const wx = X(0), wy = Y(ws.z[1]), ww = reach * scale, wh = (ws.z[1] - ws.z[0]) * scale;
      const floorZ = Number(this.nodes['floor-z']?.valueAsNumber);
      const toolMm = Math.max(0, Number(this.nodes['tool-offset']?.valueAsNumber) || 0);
      const sideKey = `${pixels[0]}x${pixels[1]}|${ratio}|${light}|${this.state?.config?.revision}|${floorZ}|${toolMm}`;
      if (!this._sideStatic || this._sideStatic.key !== sideKey) {
        const bgCanvas = this._sideStatic?.canvas || document.createElement('canvas');
        bgCanvas.width = pixels[0];
        bgCanvas.height = pixels[1];
        const bctx = bgCanvas.getContext('2d');
        if (bctx) {
          bctx.setTransform(ratio, 0, 0, ratio, 0, 0);
          bctx.clearRect(0, 0, width, height);
          bctx.fillStyle = c.area;
          bctx.fillRect(wx, wy, ww, wh);
          bctx.save();
          bctx.beginPath();
          bctx.rect(wx, wy, ww, wh);
          bctx.clip();
          bctx.strokeStyle = c.subGrid;
          bctx.lineWidth = 1;
          bctx.beginPath();
          for (let r = 50; r <= reach; r += 50) {
            bctx.moveTo(X(r), wy);
            bctx.lineTo(X(r), wy + wh);
          }
          for (let z = Math.ceil(ws.z[0] / 50) * 50; z <= ws.z[1]; z += 50) {
            if (z === 0) continue;
            bctx.moveTo(wx, Y(z));
            bctx.lineTo(wx + ww, Y(z));
          }
          bctx.stroke();
          bctx.restore();
          bctx.strokeStyle = c.line;
          bctx.lineWidth = 1.1;
          bctx.setLineDash([4, 3]);
          bctx.strokeRect(wx, wy, ww, wh);
          bctx.setLineDash([]);
          bctx.beginPath();
          bctx.moveTo(X(rLow), Y(0));
          bctx.lineTo(X(reach), Y(0));
          bctx.stroke();
          bctx.font = '10px ui-monospace, monospace';
          bctx.fillStyle = c.tick;
          bctx.textBaseline = 'top';
          bctx.textAlign = 'center';
          for (let r = 0; r <= reach; r += 100) bctx.fillText(String(r), X(r), Y(0) + 3);
          bctx.textAlign = 'left';
          bctx.textBaseline = 'middle';
          bctx.fillText('Z ' + ws.z[1], X(0) + 4, Y(ws.z[1]) + 8);
          if (Number.isFinite(floorZ) && (floorZ > ws.z[0] || toolMm > 0)) {
            const effFloor = floorZ + toolMm;
            const fy = Y(effFloor);
            bctx.save();
            bctx.strokeStyle = light ? '#a35a00' : '#ffc176';
            bctx.lineWidth = 1.4;
            bctx.setLineDash([5, 3]);
            bctx.beginPath();
            bctx.moveTo(X(0), fy);
            bctx.lineTo(X(reach), fy);
            bctx.stroke();
            bctx.setLineDash([]);
            bctx.fillStyle = light ? '#a35a00' : '#ffc176';
            bctx.font = '600 9px ui-monospace, monospace';
            bctx.fillText(`Plancher ${Math.round(effFloor)} mm`, X(reach) - 96, fy - 7);
            bctx.restore();
          }
          const pedH = Math.max(6, (0 - zLow) * scale - 4);
          bctx.fillStyle = c.baseDark;
          bctx.fillRect(X(-32), Y(0) + pedH - 5, 64 * scale, 5);
          bctx.fillStyle = c.base;
          bctx.fillRect(X(-22), Y(0), 44 * scale, Math.max(2, pedH - 5));
          bctx.strokeStyle = c.line;
          bctx.lineWidth = 1;
          bctx.strokeRect(X(-22), Y(0), 44 * scale, Math.max(2, pedH - 5));
          this._sideStatic = { canvas: bgCanvas, key: sideKey };
        }
      }
      if (this._sideStatic?.canvas) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this._sideStatic.canvas, 0, 0);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      }

      const drawArm = (angles, color, beamColor, dashed) => {
        if (!angles || axisKeys.some(key => !Number.isFinite(angles[key]))) return;
        const { elbow, tcp } = armLinks(angles);
        // Signed reach in the arm's plane: negative when the base points backwards.
        const sideOf = point => Math.hypot(point.x, point.y) * (point.x < -1e-6 ? -1 : 1);
        const p0 = [X(0), Y(0)];
        const p1 = [X(sideOf(elbow)), Y(elbow.z)];
        const p2 = [X(sideOf(tcp)), Y(tcp.z)];
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Outer structural link silhouette
        ctx.strokeStyle = beamColor;
        ctx.lineWidth = dashed ? 6 : 10;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
        // Crisp kinematic centerline
        ctx.strokeStyle = color;
        ctx.lineWidth = dashed ? 1.8 : 2.6;
        if (dashed) ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        // Gripper jaws aligned with the forearm vector
        const fx = p2[0] - p1[0], fy = p2[1] - p1[1];
        const fl = Math.hypot(fx, fy) || 1;
        const ux = fx / fl, uy = fy / fl;
        const nx = -uy, ny = ux;
        const openRatio = Math.min(1, Math.max(0, (180 - angles.hand) / 110));
        const jawSpread = 2.5 + openRatio * 5.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = dashed ? 1.4 : 2;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(p2[0] - ux * 4 + nx * s * jawSpread, p2[1] - uy * 4 + ny * s * jawSpread);
          ctx.lineTo(p2[0] + ux * 6 + nx * s * jawSpread, p2[1] + uy * 6 + ny * s * jawSpread);
          ctx.stroke();
        }
        // Servo joint hubs at Shoulder, Elbow, and TCP
        for (const [idx, [px, py]] of [p0, p1, p2].entries()) {
          ctx.beginPath();
          ctx.arc(px, py, idx === 2 ? (dashed ? 2.8 : 3.6) : (dashed ? 3.5 : 4.8), 0, Math.PI * 2);
          ctx.fillStyle = idx === 2 ? color : c.hole;
          ctx.fill();
          ctx.lineWidth = dashed ? 1.5 : 2;
          ctx.strokeStyle = color;
          ctx.stroke();
        }
        ctx.restore();
      };
      drawArm(pose, c.target, c.targetBeam, true);
      const sideLoads = Object.values(this.state?.feedback?.load || {}).filter(Number.isFinite).map(Math.abs);
      const sidePeak = sideLoads.length ? Math.max(...sideLoads) : 0;
      const sideWarn = this.state?.config?.load_warn ?? 700;
      const sideCrit = this.state?.config?.load_critical ?? 900;
      const liveBeam = sidePeak >= sideCrit ? 'rgba(255, 120, 145, .36)'
        : sidePeak >= sideWarn ? 'rgba(255, 193, 118, .36)' : c.liveBeam;
      drawArm(actual, c.live, liveBeam, false);
    }

    setGrip(kind) {
      const [min, max] = this.state?.config.joint_limits.hand || [70, 260];
      const closed = Math.min(max, Math.max(min, 180));
      const value = kind === 'open' ? min : kind === 'close' ? closed : (min + closed) / 2;
      const field = this.mode === 'joints' ? this.form.hand : this.form.t;
      field.value = Number(value.toFixed(1));
      if (this.mode === 'joints' && this.nodes['slider-hand']) this.nodes['slider-hand'].value = field.value;
      this.clearPreview();
      this.composeFromFields();
      this.pilotAids();
      this.controls();
      this.message(this.composeOpen && this.compose?.selected != null ? 'Pince du point réglée à ' + field.value + '°.' :
        'Angle de pince réglé à ' + field.value + '°. Cliquez sur Déplacer pour l’appliquer.');
    }

    setKeyJog(on) {
      this.keyJog = !!on;
      this.nodes.keyjog.checked = this.keyJog;
      this.nodes['keyjog-hint'].hidden = !this.keyJog;
      try { localStorage.setItem(KEY_JOG_STORE, this.keyJog ? '1' : '0'); } catch (_) {}
    }

    // One bounded step per key press, through the same path as the +/− buttons; never auto-repeat.
    keyJogEvent(event, down) {
      if (!this.keyJog || !this.active || event.altKey || event.ctrlKey || event.metaKey) return;
      const entry = KEY_JOG[event.key?.toLowerCase()];
      if (!entry) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.rb-ai-chat:not([hidden])')) return;
      const keys = this.mode === 'joints' ? axisKeys : ['x', 'y', 'z', 't'];
      const panel = this.nodes[this.mode === 'joints' ? 'joints' : 'cartesian'];
      const button = panel.querySelector(`[data-step="${keys[entry[0]]}"][data-direction="${entry[1]}"]`);
      if (!button || (down && !this.lease)) return;  // Disarmed: the keys keep their normal meaning.
      event.preventDefault();
      if (down) {
        if (!event.repeat) this.jogPress(button, 'key:' + event.key.toLowerCase());
      } else {
        this.jogRelease(button, 'key:' + event.key.toLowerCase(), true);
      }
    }

    // The checklist mirrors what the station reports. Sign-off and approval stay local to the PC HQ.
    updateCommissionApproveBtn() {
      const btn = this.nodes['commission-approve-btn'];
      if (!btn) return;
      const state = this.state;
      const endpointOk = state?.config?.transport === 'serial' ? !!state?.config?.serial_port : !!state?.config?.arm_ip;
      const fw = (this.nodes['commission-firmware']?.value || '').trim();
      const op = (this.nodes['commission-operator']?.value || '').trim();
      const gates = Array.from(this.nodes['commission-gates']?.querySelectorAll('input[data-gate]') || []);
      const allGates = gates.length === 10 && gates.every(cb => cb.checked);
      const estopBlocked = state?.estop?.mode === 'hardware' && state?.estop?.healthy !== true;
      btn.disabled = !(state?.config?.mode === 'hardware' && endpointOk && state?.physical_local
        && !!state?.feedback && !state?.stop_latched && !state?.uncertain && !estopBlocked
        && fw && op && allGates);
    }

    async approveCommission() {
      const btn = this.nodes['commission-approve-btn'];
      if (!btn || btn.disabled) return;
      const fw = (this.nodes['commission-firmware']?.value || '').trim();
      const op = (this.nodes['commission-operator']?.value || '').trim();
      const gates = Object.fromEntries(
        Array.from(this.nodes['commission-gates']?.querySelectorAll('input[data-gate]') || [])
          .map(cb => [cb.dataset.gate, cb.checked])
      );
      if (!this.askConfirm('commission-approve', btn, 'Confirmer l’approbation (PC HQ)',
        'Cliquez de nouveau pour signer les portes 2 & 3 et déverrouiller le pilotage physique.')) return;
      const result = await this.request('commission', {
        confirmed: true,
        firmware_version: fw,
        operator: op,
        gates,
      });
      this.render(await this.request('status'));
      this.message(result?.commissioned ? 'Mise en service approuvée sur le PC HQ.' : 'Mise en service enregistrée.');
    }

    renderCommission(state, estopMode, estop) {
      const hw = state.config.mode === 'hardware';
      const pending = hw && !state.commissioned;
      this.nodes['commission-card'].hidden = !pending;
      this.nodes['interlock-go'].hidden = !pending;
      const commissionNav = this.host.querySelector('[data-go-section="commission"]');
      if (commissionNav) commissionNav.hidden = !pending;
      if (pending && !this.revealPilot && !this.sectionOverview && !this._commissionNavOnce) {
        this._commissionNavOnce = true;
        this.selectSection('commission', { scroll: false });
      }
      this.host.classList.toggle('rb-precommission', pending && !this.revealPilot);
      this.host.classList.toggle('rb-commissioning', pending);
      if (!pending) return;
      const isSerial = state.config.transport === 'serial';
      const endpointOk = isSerial ? !!state.config.serial_port : !!state.config.arm_ip;
      const rows = [
        ['Mode Matériel et adresse/port du bras', endpointOk,
          endpointOk ? (isSerial ? `Port ${state.config.serial_port}` : 'Configurés')
            : (isSerial ? 'Renseignez le port série (COM3…)' : 'Renseignez l’IPv4 du RoArm')],
        ['HQ ouvert sur le PC hôte', !!state.physical_local, state.physical_local ? 'Oui' : 'Ouvrez http://127.0.0.1:8765/#robotique sur le PC HQ'],
        ['Retour du RoArm', !!state.feedback, state.feedback ? 'Reçu' :
          (state.last_feedback ? 'Ancien retour · relisez' : 'Cliquez sur Lire le RoArm')],
        ['Caméra', state.config.camera_required === false || !!state.config.camera_configured,
          state.config.camera_required === false ? 'Facultative' : (state.config.camera_configured ? 'Configurée' : 'Compte caméra à renseigner')],
        ['Arrêt d’urgence surveillé', estopMode === 'hardware' && estop.healthy === true,
          estopMode === 'hardware' ? (estop.healthy === true ? 'Contact fermé' : 'Contact ouvert ou injoignable') :
            'Non surveillé · gardez la coupure physique à portée', !state.config.estop_required],
        ['Test couple T:105 / mode libre T:210', !!state.feedback && state.torque_state !== 'unknown',
          state.feedback ? `Couple : ${state.torque_state || 'reçu'} · prêt pour le banc` : 'En attente de lecture RoArm'],
        ['Portes 2 & 3 + approbation PC HQ', !!state.commissioned, 'Cochez G2.1–G3.6 et approuvez ci-dessous'],
      ];
      this.updateCommissionApproveBtn();
      const done = rows.filter(([, ok]) => ok === true).length;
      const progress = done + ' / ' + rows.length;
      if (this.nodes['commission-progress'].textContent !== progress) this.nodes['commission-progress'].textContent = progress;
      const signature = JSON.stringify(rows);
      if (signature === this.commissionSignature) return;
      this.commissionSignature = signature;
      this.nodes['commission-live'].replaceChildren(...rows.map(([label, ok, note, optional]) => {
        const li = document.createElement('li');
        li.dataset.state = ok === true ? 'ok' : (ok === null || optional ? 'info' : 'todo');
        const name = document.createElement('span');
        name.textContent = label;
        const out = document.createElement('output');
        out.textContent = note;
        li.append(name, out);
        return li;
      }));
    }

    async probeArm() {
      this.render(await this.request('telemetry', { lease: this.lease }));
      this.telemetryEnabled = true;
      this.schedule(700);
    }

    openSettings(field) {
      if (!this.sectionOverview) this.selectSection('advanced', { scroll: false });
      const settings = this.host.querySelector('#robotics-settings');
      settings.open = true;
      const target = typeof field === 'string' ? this.nodes.settings.elements[field] : null;
      (target && !target.disabled ? target : settings.querySelector('summary')).focus({ preventScroll: true });
      (target || settings).scrollIntoView({ block: target ? 'center' : 'start' });
    }

    // ---- Compliant Torque-Bounded Grasp (kind: 'grasp')
    async graspToContact() {
      const limit = Math.min(950, Math.max(80, Math.round(this.nodes['grasp-limit']?.valueAsNumber || 320)));
      const [min, max] = this.state?.config.joint_limits.hand || [70, 260];
      const closed = Math.min(max, Math.max(min, 180));
      const jawMm = hand => Math.max(0, Math.round((4 + Math.max(0, (180 - hand) / 110) * 52) * 10) / 10);
      const body = { kind: 'grasp', hand: closed, load_limit: limit };
      if (this.state?.config.mode !== 'hardware') {
        if (!await this.move(body)) return;
        const hand = this.state?.feedback?.actual?.hand ?? closed;
        const contact = !!this.state?.script?.contact;
        if (this.nodes['grasp-state']) {
          this.nodes['grasp-state'].textContent = (contact ? 'Contact couple · ' : 'Fermeture · ') +
            format(hand, '°') + ' (≈ ' + jawMm(hand) + ' mm)';
        }
        if (this.state?.feedback?.actual) this.pilotFields(this.state.feedback.actual, this.state.feedback.xyz);
        if (contact) { this.playHudSound('grasp'); this.haptic(12); }
        this.message(contact
          ? `Prise arrêtée au seuil de couple (${limit}) à ${format(hand, '°')} (≈ ${jawMm(hand)} mm).`
          : `Pince fermée à ${format(hand, '°')} (simulation sans résistance).`);
        return;
      }
      const generation = this.motionGeneration;
      this.telemetryEnabled = true;
      this.schedule(0);
      const alive = () => generation === this.motionGeneration && !!this.lease && this.active;
      const settle = async () => {
        const deadline = performance.now() + 12000;
        while (alive() && (this.pending || (this.state?.moving && !this.state?.blend) || !this.state?.ticket)) {
          if (performance.now() > deadline) throw new Error('Le bras n’a pas confirmé le pas de pince.');
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        return alive();
      };
      for (let step = 0; step < 48; step++) {
        if (!await settle()) return;
        if (!this.state.feedback?.actual) throw new Error('Retour du bras indisponible.');
        if (!await this.moveSteady(body)) return;
        if (!await settle()) return;
        const progress = this.state?.script;
        const load = Math.abs(this.state?.feedback?.load?.hand || 0);
        if (progress?.contact || load >= limit || (progress?.index === 'grasp' && progress.gap <= 0.25)) break;
      }
      if (await settle() && this.state?.feedback?.actual) {
        const hand = this.state.feedback.actual.hand;
        const contact = !!(this.state.script?.contact || Math.abs(this.state.feedback?.load?.hand || 0) >= limit);
        if (this.nodes['grasp-state']) {
          this.nodes['grasp-state'].textContent = (contact ? 'Contact couple · ' : 'Fermeture · ') +
            format(hand, '°') + ' (≈ ' + jawMm(hand) + ' mm)';
        }
        this.pilotFields(this.state.feedback.actual, this.state.feedback.xyz);
        if (contact) { this.playHudSound('grasp'); this.haptic(12); }
        this.message(contact
          ? `Objet saisi au contact (${format(hand, '°')} · ≈ ${jawMm(hand)} mm).`
          : `Fermeture complète atteinte (${format(hand, '°')}).`);
      }
    }

    // ---- In-Cockpit Black-Box Flight Recorder & 3D Timeline Scrubber
    flightToggle(open = !this.flightOpen) {
      if (open && this.composeOpen) this.composeToggle(false);
      if (open && this.zonesOpen) this.zonesToggle(false);
      this.flightOpen = open;
      if (!open) this.stopFlightPlay();
      if (this.nodes.flight) this.nodes.flight.hidden = !open;
      if (this.nodes['flight-toggle']) {
        this.nodes['flight-toggle'].setAttribute('aria-pressed', String(open));
        this.nodes['flight-toggle'].textContent = open ? 'Fermer le journal noir' : 'Journal noir 3D';
      }
      if (open) {
        if (this.monitor !== 'space') this.selectMonitor('space');
        this.run(() => this.loadFlight());
      } else {
        this.updateSpace();
        this.drawPosition();
        if (this.state) this.pilotAids();
      }
    }

    mountTools() {
      if (this.tools) return Promise.resolve(this.tools);
      if (this.toolsLoading) return this.toolsLoading;
      const url = typeof window.hqAssetUrl === 'function' ? window.hqAssetUrl('hq-robotics-tools.js') : '/assets/hq-robotics-tools.js';
      this.toolsLoading = new Promise((resolve, reject) => {
        if (window.HqRoboticsTools) { resolve(); return; }
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Impossible de charger les outils robotique.'));
        document.head.append(script);
      }).then(() => {
        this.tools = window.HqRoboticsTools?.attach(this, {
          axisKeys, axes, format, loadFullScale: LOAD_FULL_SCALE,
        }) || null;
        return this.tools;
      }).catch(err => {
        this.toolsLoading = null;
        throw err;
      });
      return this.toolsLoading;
    }

    async loadFlight() {
      const tools = await this.mountTools();
      return tools?.loadFlight();
    }

    flightEntry() { return this.tools ? this.tools.flightEntry() : null; }
    renderFlight() { this.tools?.renderFlight(); }
    toggleFlightPlay() { this.tools?.toggleFlightPlay(); }
    stopFlightPlay() { this.tools?.stopFlightPlay(); }
    applyFlightPose() { this.tools?.applyFlightPose(); }

    // ---- Deadman-Gated Web Gamepad / SpaceMouse Jogging
    setPadJog(on) {
      this.padJog = !!on;
      if (this.nodes.padjog) this.nodes.padjog.checked = this.padJog;
      if (this.nodes['pad-hint']) this.nodes['pad-hint'].hidden = !this.padJog;
      try { localStorage.setItem(PAD_JOG_STORE, this.padJog ? '1' : '0'); } catch (_) {}
      clearInterval(this.padTimer);
      this.padTimer = null;
      this.padDeadmanHeld = false;
      if (this.padJog && this.active) {
        this.padTimer = setInterval(() => this.pollGamepad(), 120);
      }
    }

    pollGamepad() {
      if (!this.active || !this.padJog || typeof navigator.getGamepads !== 'function') return;
      const pads = navigator.getGamepads() || [];
      const pad = [...pads].find(item => item && item.connected);
      const statusNode = this.nodes['pad-status'];
      if (!pad) {
        if (this.padDeadmanHeld && this.lease) {
          this.padDeadmanHeld = false;
          this.release();
          this.message('Manette déconnectée : autorisation relâchée.');
        }
        if (statusNode && statusNode.textContent !== 'Aucune manette détectée') {
          statusNode.textContent = 'Aucune manette détectée';
        }
        return;
      }
      if (pad.buttons?.[1]?.pressed) {
        this.padDeadmanHeld = false;
        this.run(() => this.stopStation());
        return;
      }
      const deadman = !!(pad.buttons?.[4]?.pressed || pad.buttons?.[5]?.pressed);
      if (this.padDeadmanHeld && !deadman) {
        this.padDeadmanHeld = false;
        if (this.lease) {
          this.release();
          this.message('Autorisation relâchée (gâchette homme-mort L1/LB relâchée).');
        }
      }
      this.padDeadmanHeld = deadman;
      const label = (pad.id ? pad.id.slice(0, 26) : 'Manette active') +
        (deadman ? ' · Homme-mort maintenu' : ' · Maintenez L1/LB');
      if (statusNode && statusNode.textContent !== label) statusNode.textContent = label;
      if (!deadman || !this.lease || !this.armedNow || this.pending || this.state?.moving ||
          performance.now() < this.padNextAt) return;
      const raw = [
        pad.axes?.[0] || 0,
        -(pad.axes?.[1] || 0),
        -(pad.axes?.[3] ?? pad.axes?.[2] ?? 0),
        (pad.buttons?.[7]?.pressed ? 1 : 0) - (pad.buttons?.[6]?.pressed ? 1 : 0),
      ];
      let bestIdx = -1;
      let bestMag = 0.38;
      raw.forEach((val, idx) => {
        if (Math.abs(val) > bestMag) { bestMag = Math.abs(val); bestIdx = idx; }
      });
      if (bestIdx < 0) return;
      const keys = this.mode === 'joints' ? axisKeys : ['x', 'y', 'z', 't'];
      const panel = this.nodes[this.mode === 'joints' ? 'joints' : 'cartesian'];
      const dir = raw[bestIdx] > 0 ? 1 : -1;
      const button = panel?.querySelector(`[data-step="${keys[bestIdx]}"][data-direction="${dir}"]`);
      if (!button || button.disabled) return;
      this.padNextAt = performance.now() + 420;
      this.jogPress(button, 'gamepad');
      this.jogRelease(button, 'gamepad', true);
    }

    // ---- User-Friendliness & Ergonomics Helpers
    toggleShortcuts(open) {
      const panel = this.nodes['shortcuts-panel'];
      const btn = this.nodes['open-shortcuts'];
      if (!panel) return;
      const next = typeof open === 'boolean' ? open : panel.hidden;
      panel.hidden = !next;
      if (btn) {
        btn.setAttribute('aria-expanded', String(next));
        btn.setAttribute('aria-pressed', String(next));
      }
      if (next) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    async runInterlockAction() {
      const act = this.interlockAction;
      if (!act) return;
      if (act === 'arm') return this.arm();
      if (act === 'probe') return this.probeArm();
      if (act === 'estop') return this.openSettings('estop_ip');
      if (act === 'camera') {
        this.monitorChosen = true;
        this.selectMonitor('camera');
        return this.startVideo();
      }
      if (act === 'reset') {
        this.nodes.reset?.click();
      }
    }

    pushPoseUndo() {
      const pose = this.fieldPose();
      if (!pose) return;
      const now = performance.now();
      if (now - (this.lastPoseUndoAt || 0) < 600) return;
      this.poseHistory ||= [];
      const snap = JSON.stringify({
        pose,
        xyz: { x: this.form.x.valueAsNumber, y: this.form.y.valueAsNumber, z: this.form.z.valueAsNumber },
      });
      if (this.poseHistory.at(-1) !== snap) {
        this.poseHistory.push(snap);
        if (this.poseHistory.length > 20) this.poseHistory.shift();
        if (this.nodes['pose-undo']) this.nodes['pose-undo'].disabled = false;
      }
      this.lastPoseUndoAt = now;
    }

    undoPoseFields() {
      if (!this.poseHistory?.length) return;
      const prev = JSON.parse(this.poseHistory.pop());
      if (this.nodes['pose-undo']) this.nodes['pose-undo'].disabled = !this.poseHistory.length;
      this.loadPose(prev.pose, prev.xyz);
      this.clearPreview();
      this.composeFromFields();
      this.pilotAids();
      this.controls();
      this.message('Saisie précédente restaurée dans les champs.');
    }

    syncActualToFields() {
      const actual = this.state?.feedback?.actual;
      if (!actual) return;
      this.pushPoseUndo();
      this.pilotFields(actual, this.state.feedback?.xyz);
      this.clearPreview();
      this.pilotAids();
      this.controls();
      this.message('Champs synchronisés sur la position actuelle du bras.');
    }

    async approachFieldTarget() {
      let pose = this.mode === 'joints' ? this.fieldPose() : null;
      if (!pose) {
        const res = await this.request('preview', this.target());
        pose = res?.pose;
      }
      if (!pose) throw new Error('Cible incomplète ou hors d’atteinte.');
      await this.goToPose(pose, 'Approche vers la cible');
    }

    autoFillCalXy(key) {
      const xyz = this.state?.feedback?.xyz || (this.fieldPose() ? armLinks(this.fieldPose()).tcp : null);
      if (!xyz || !Number.isFinite(xyz.x) || !Number.isFinite(xyz.y)) {
        this.message('Position XY du bras indisponible.', true);
        return;
      }
      const xIn = this.host.querySelector(`[data-cal-x="${key}"]`);
      const yIn = this.host.querySelector(`[data-cal-y="${key}"]`);
      if (xIn) xIn.value = String(Math.round(xyz.x));
      if (yIn) yIn.value = String(Math.round(xyz.y));
      this.message(`Point ${key.toUpperCase()} rempli avec la pince : X ${Math.round(xyz.x)} · Y ${Math.round(xyz.y)} mm.`);
    }

    focusJointControl(key) {
      if (!axisKeys.includes(key)) return;
      if (this.mode !== 'joints') this.selectMode('joints');
      const row = this.host.querySelector(`[data-axis-row="${key}"]`);
      const input = this.form[key];
      if (row) {
        row.classList.remove('is-flash');
        void row.offsetWidth;
        row.classList.add('is-flash');
        setTimeout(() => row.classList.remove('is-flash'), 1200);
      }
      if (input && !input.disabled) {
        input.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    // ---- 60 FPS Visual Pose Smooth-Interpolator (bridges telemetry polls without altering authoritative numbers)
    displayActual() {
      return (this.state?.moving && this.visualPose) ? this.visualPose : this.state?.feedback?.actual;
    }

    displayXyz() {
      if (this.state?.moving && this.visualPose && axisKeys.every(k => Number.isFinite(this.visualPose[k]))) {
        return armLinks(this.visualPose).tcp;
      }
      return this.state?.feedback?.xyz;
    }

    syncVisualSmooth(state) {
      const actual = state?.feedback?.actual;
      if (!this.active || document.hidden || !state?.moving || !actual || !state.target ||
          state.stop_latched || state.uncertain) {
        cancelAnimationFrame(this.visualFrame);
        this.visualFrame = 0;
        this.visualPose = actual ? { ...actual } : null;
        this.visualLastAt = 0;
        return;
      }
      if (!this.visualPose) this.visualPose = { ...actual };
      this.visualServerActual = { ...actual };
      this.visualTarget = { ...state.target };
      const spd = Math.min(state.config?.speed || 100, Math.max(40, this.nodes.speed?.valueAsNumber || 100));
      this.visualRate = Math.max(1.8, spd * DEG_PER_STEP);
      if (!this.visualFrame && typeof requestAnimationFrame === 'function') {
        this.visualFrame = requestAnimationFrame(now => this.tickVisualSmooth(now));
      }
    }

    tickVisualSmooth(now) {
      this.visualFrame = 0;
      if (!this.active || document.hidden || !this.state?.moving || !this.visualPose || !this.visualTarget ||
          this.state.stop_latched || this.state.uncertain) {
        this.visualPose = this.state?.feedback?.actual ? { ...this.state.feedback.actual } : null;
        this.visualLastAt = 0;
        return;
      }
      const dt = Math.min(0.08, Math.max(0.004, this.visualLastAt ? (now - this.visualLastAt) / 1000 : 0.016));
      this.visualLastAt = now;
      const span = Math.max(...axisKeys.map(k => Math.abs(this.visualTarget[k] - this.visualPose[k])));
      if (span > 0.04) {
        const damp = Math.min(1, span / 2.0) * (0.45 + 0.55 * Math.min(1, span / 4.5));
        const stepDeg = Math.min(span, (this.visualRate || 6) * damp * dt);
        const ratio = stepDeg / span;
        const pull = 1 - Math.exp(-dt / 0.12);
        for (const k of axisKeys) {
          let next = this.visualPose[k] + (this.visualTarget[k] - this.visualPose[k]) * ratio;
          if (this.visualServerActual && Number.isFinite(this.visualServerActual[k])) {
            next += (this.visualServerActual[k] - next) * pull * 0.35;
          }
          this.visualPose[k] = next;
        }
        this.drawPosition();
        this.drawSide(this.displayActual(), this.fieldPose());
        this.drawVisualGauges(this.displayActual(), this.fieldPose());
        this.updateSpace();
        this.drawCameraOverlay();
      }
      if (this.active && this.state?.moving && typeof requestAnimationFrame === 'function') {
        this.visualFrame = requestAnimationFrame(t => this.tickVisualSmooth(t));
      }
    }

    // ---- Radial Joint Protractors & Interactive Parallel-Jaw Gripper Gauge
    drawVisualGauges(actual, target) {
      const canvas = this.nodes['visual-gauges'];
      if (!canvas || !this.state || canvas.offsetParent === null) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) [canvas.width, canvas.height] = pixels;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight') && !document.body.classList.contains('theme-oled');
      const c = light ? {
        bg: '#eaf4f3', ring: 'rgba(71, 100, 102, .22)', sector: 'rgba(8, 114, 79, .14)',
        live: '#08724f', target: '#2b63c7', warn: '#a35a00', crit: '#b4233d',
        text: '#22383a', muted: '#527173', jaw: '#3d585a', pad: '#08724f', obj: '#d97706',
      } : {
        bg: '#10242b', ring: 'rgba(134, 225, 205, .16)', sector: 'rgba(115, 237, 206, .13)',
        live: '#73edce', target: '#9fc5ff', warn: '#ffc176', crit: '#ff6b81',
        text: '#dff5f2', muted: '#8fabad', jaw: '#587882', pad: '#73edce', obj: '#ffc176',
      };
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, width, height);

      const limits = this.state.config.joint_limits;
      const loads = this.state.feedback?.load || {};
      const dials = [
        ['base', 'Base'],
        ['shoulder', 'Épaule'],
        ['elbow', 'Coude'],
        ['hand', 'Pince'],
      ];
      const dialZoneW = width * 0.64;
      const cellW = dialZoneW / 4;
      const r = Math.max(14, Math.min(cellW * 0.37, height * 0.31));
      const cy = height * 0.44;
      this.gaugeHitZones = [];

      dials.forEach(([key, label], idx) => {
        const cx = cellW * (idx + 0.5);
        this.gaugeHitZones.push({ kind: 'joint', key, label, x0: cellW * idx, x1: cellW * (idx + 1) });
        const [lo, hi] = limits[key] || [-180, 180];
        const toAngle = deg => -Math.PI * 0.5 + ((deg - (lo + hi) / 2) / Math.max(1, hi - lo)) * Math.PI * 1.45;
        const aMin = toAngle(lo), aMax = toAngle(hi);

        if (this.gaugeHover?.key === key) {
          ctx.fillStyle = c.sector;
          ctx.beginPath();
          ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
          ctx.fill();
        }
        // Background track & allowed sector
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = c.ring;
        ctx.lineWidth = 3.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, r, aMin, aMax);
        ctx.strokeStyle = c.sector;
        ctx.lineWidth = 5;
        ctx.stroke();

        // Target needle
        const tVal = target?.[key];
        if (Number.isFinite(tVal)) {
          const ta = toAngle(Math.min(hi, Math.max(lo, tVal)));
          ctx.strokeStyle = c.target;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(ta) * (r + 2), cy + Math.sin(ta) * (r + 2));
          ctx.stroke();
        }
        // Live needle + torque color
        const aVal = actual?.[key];
        const ld = Math.abs(Number(loads[key]) || 0);
        const col = ld >= 750 ? c.crit : ld >= 420 ? c.warn : c.live;
        if (Number.isFinite(aVal)) {
          const aa = toAngle(Math.min(hi, Math.max(lo, aVal)));
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(aa) * (r - 1), cy + Math.sin(aa) * (r - 1));
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = c.muted;
        ctx.font = '600 9.5px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, cx, height - 16);
        ctx.fillStyle = c.text;
        ctx.font = '700 10px ui-monospace, monospace';
        const valShow = Number.isFinite(aVal) ? `${Math.round(aVal)}°` : (Number.isFinite(tVal) ? `${Math.round(tVal)}°` : '—');
        ctx.fillText(valShow, cx, height - 4);
      });

      // Right 36%: Animated Parallel-Jaw Gripper Diagram (4-56 mm)
      const gx0 = dialZoneW + 8;
      const gw = Math.max(54, width - gx0 - 8);
      const gcx = gx0 + gw / 2;
      this.gaugeHitZones.push({ kind: 'gripper', x0: gx0, x1: width - 4, cx: gcx, halfSpan: gw * 0.38 });

      const handAngle = Number.isFinite(actual?.hand) ? actual.hand : (Number.isFinite(target?.hand) ? target.hand : 180);
      const openRatio = Math.min(1, Math.max(0, (180 - handAngle) / 110));
      const jawMm = Math.round((4 + openRatio * 52) * 10) / 10;
      const maxHalfPx = Math.min(gw * 0.36, 36);
      const halfGapPx = 3 + openRatio * (maxHalfPx - 3);

      if (this.nodes['jaw-readout']) {
        const readTxt = `Ouverture ≈ ${jawMm.toFixed(1)} mm (${Math.round(handAngle)}°)`;
        if (this.nodes['jaw-readout'].textContent !== readTxt) this.nodes['jaw-readout'].textContent = readTxt;
      }

      // Guide rail
      ctx.strokeStyle = c.ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gcx - maxHalfPx - 6, cy);
      ctx.lineTo(gcx + maxHalfPx + 6, cy);
      ctx.stroke();

      // Held object indicator between jaws
      const handLoad = Math.abs(Number(loads.hand) || 0);
      if (this.holdingObject || (handAngle >= 122 && handLoad >= 130)) {
        ctx.fillStyle = c.obj;
        const objW = Math.max(4, (halfGapPx - 2) * 1.6);
        ctx.fillRect(gcx - objW / 2, cy - 9, objW, 18);
      }

      // Left and right parallel jaws
      for (const s of [-1, 1]) {
        const jx = gcx + s * halfGapPx;
        ctx.fillStyle = c.jaw;
        ctx.fillRect(jx + (s < 0 ? -6 : 0), cy - 13, 6, 26);
        ctx.fillStyle = c.pad;
        ctx.fillRect(jx + (s < 0 ? -1.8 : 0), cy - 10, 1.8, 20);
      }
      ctx.fillStyle = c.muted;
      ctx.font = '600 9.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Mâchoires (clic)', gcx, height - 16);
      ctx.fillStyle = c.text;
      ctx.font = '700 10px ui-monospace, monospace';
      ctx.fillText(`≈ ${jawMm.toFixed(0)} mm`, gcx, height - 4);
    }

    onVisualGaugeClick(event) {
      const canvas = this.nodes['visual-gauges'];
      if (!canvas || !this.gaugeHitZones?.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const hit = this.gaugeHitZones.find(z => x >= z.x0 && x <= z.x1);
      if (!hit) return;
      if (hit.kind === 'joint') {
        this.focusJointControl(hit.key);
      } else if (hit.kind === 'gripper') {
        const ratio = Math.min(1, Math.max(0, Math.abs(x - hit.cx) / Math.max(12, hit.halfSpan)));
        const [min, max] = this.state?.config.joint_limits.hand || [70, 260];
        const angle = Math.min(max, Math.max(min, 180 - ratio * 110));
        this.pushPoseUndo();
        const field = this.mode === 'joints' ? this.form.hand : this.form.t;
        field.value = Number(angle.toFixed(1));
        if (this.mode === 'joints' && this.nodes['slider-hand']) this.nodes['slider-hand'].value = field.value;
        this.clearPreview();
        this.composeFromFields();
        this.pilotAids();
        this.controls();
        const mm = Math.round(4 + ratio * 52);
        this.message(`Ouverture de pince réglée à ≈ ${mm} mm (${field.value}°).`);
      }
    }

    onVisualGaugeHover(event) {
      const canvas = this.nodes['visual-gauges'];
      if (!canvas || !this.gaugeHitZones?.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const hit = this.gaugeHitZones.find(z => x >= z.x0 && x <= z.x1);
      if (!hit) { this.onVisualGaugeLeave(); return; }
      if (hit.kind === 'joint') {
        canvas.style.cursor = 'pointer';
        if (this.gaugeHover?.key !== hit.key) {
          this.gaugeHover = { key: hit.key };
          this.drawVisualGauges(this.displayActual(), this.fieldPose());
        }
        this.setHoverExplain(`Cadran ${hit.label} : cliquer pour cibler et surligner le curseur ${hit.label} dans Pilotage.`);
      } else {
        canvas.style.cursor = 'ew-resize';
        if (this.gaugeHover) {
          this.gaugeHover = null;
          this.drawVisualGauges(this.displayActual(), this.fieldPose());
        }
        const ratio = Math.min(1, Math.max(0, Math.abs(x - hit.cx) / Math.max(12, hit.halfSpan)));
        const mm = Math.round(4 + ratio * 52);
        this.setHoverExplain(`Mâchoires parallèles : cliquer ici règle le champ Pince à ≈ ${mm} mm (ne déplace pas encore le bras).`);
      }
    }

    onVisualGaugeLeave() {
      if (this.nodes['visual-gauges']) this.nodes['visual-gauges'].style.cursor = '';
      if (this.gaugeHover) {
        this.gaugeHover = null;
        this.drawVisualGauges(this.displayActual(), this.fieldPose());
      }
    }

    plotHoverMove(event) {
      if (!this.active || (this.monitor !== 'position' && this.monitor !== 'split')) return;
      if (this.plotDrag) {
        this.nodes.plot.style.cursor = 'grabbing';
        return;
      }
      const pt = this.plotPoint(event);
      if (!pt) { this.plotHoverLeave(); return; }
      const screen = this.plotScreen(this.displayXyz());
      const overDot = !!(screen && this.armedNow && Math.hypot(event.clientX - screen.x, event.clientY - screen.y) <= 16);
      const hitZone = (this.state?.config?.keepout || []).find(z =>
        pt.x >= z.x[0] && pt.x <= z.x[1] && pt.y >= z.y[0] && pt.y <= z.y[1]);
      this.plotHover = { x: pt.x, y: pt.y, overDot, overZone: hitZone?.name || '' };
      this.nodes.plot.style.cursor = overDot ? 'grab' : 'crosshair';
      this.setHoverExplain(overDot
        ? 'Point du bras (armé) : maintenir et glisser pour piloter le bras en continu sur le plan XY.'
        : hitZone ? `Zone d’exclusion « ${hitZone.name} » : tout mouvement qui y entre sera refusé par sécurité.`
        : `Plan XY (X ${Math.round(pt.x)} · Y ${Math.round(pt.y)} mm) : cliquer pour prévisualiser la cible sans bouger.`);
      this.drawPosition();
    }

    plotHoverLeave() {
      this.plotHover = null;
      if (this.nodes.plot) this.nodes.plot.style.cursor = '';
      this.drawPosition();
    }

    setHoverExplain(text) {
      const box = this.nodes['hover-explain'];
      const out = this.nodes['hover-explain-text'];
      if (!out || !box) return;
      if (!text) {
        box.hidden = true;
        box.classList.add('is-dormant');
        out.textContent = '';
        return;
      }
      box.hidden = false;
      box.classList.remove('is-dormant');
      if (out.textContent !== text) out.textContent = text;
    }

    bindHoverInspector() {
      const inspect = target => {
        if (!target || !this.host.contains(target)) return;
        const el = target.closest?.('[data-help], button, input, select, summary');
        if (!el) return;
        const text = el.dataset?.help || el.getAttribute?.('title') || el.getAttribute?.('aria-label');
        if (text) this.setHoverExplain(text);
      };
      this.host.addEventListener('pointermove', event => {
        // Fallback through elementsFromPoint so disabled buttons also report why they are locked.
        let target = event.target;
        if (target === this.host || target.tagName === 'DIV' || target.tagName === 'FORM') {
          const hit = document.elementsFromPoint?.(event.clientX, event.clientY)?.find(n =>
            n !== this.host && (n.dataset?.help || (n.tagName === 'BUTTON' && n.disabled)));
          if (hit) target = hit;
        }
        inspect(target);
      });
      this.host.addEventListener('focusin', event => inspect(event.target));
    }

    // ---- Practical Workbench Assistant, Gravimetric Scale, Touch Guidance, Pick->Place & Grid Palletizer
    tareScale() {
      const actual = this.state?.feedback?.actual;
      const load = this.state?.feedback?.load || {};
      if (!actual) return;
      const sRad = rad(actual.shoulder);
      const seRad = rad(actual.shoulder + actual.elbow);
      this.scaleTare = {
        shoulder: (Number(load.shoulder) || 0) - 42 * Math.sin(sRad + OFFSET) - 35 * Math.sin(seRad),
        elbow: (Number(load.elbow) || 0) - 48 * Math.sin(seRad),
        base: Number(load.base) || 0,
        hand: Number(load.hand) || 0,
        atPose: { ...actual },
      };
      if (this.state) this.renderScaleAndWorkbench(this.state);
      this.controls();
      this.message('Tare gravimétrique enregistrée à la pose actuelle.');
    }

    resetScale() {
      this.scaleTare = null;
      this.holdingObject = null;
      if (this.state) this.renderScaleAndWorkbench(this.state);
      this.controls();
      this.message('Tare gravimétrique effacée.');
    }

    renderScaleAndWorkbench(state) {
      if (!this.nodes.scale) return;
      const actual = state?.feedback?.actual;
      const load = state?.feedback?.load || {};
      const set = (key, val) => {
        if (this.nodes[key] && this.nodes[key].textContent !== val) this.nodes[key].textContent = val;
      };
      if (!actual) {
        set('scale-state', 'Sans mesure');
        set('scale-grams', '— g');
        set('scale-delta', '—');
        set('scale-grip', '—');
        return;
      }
      const sRad = rad(actual.shoulder);
      const seRad = rad(actual.shoulder + actual.elbow);
      const rMoment = Math.max(85, Math.abs(UPPER * Math.sin(sRad + OFFSET) + LOWER * Math.sin(seRad)));
      const expS = 42 * Math.sin(sRad + OFFSET) + 35 * Math.sin(seRad);
      const expE = 48 * Math.sin(seRad);
      const tareS = this.scaleTare ? this.scaleTare.shoulder : 0;
      const tareE = this.scaleTare ? this.scaleTare.elbow : 0;
      const rawS = Number.isFinite(load.shoulder) ? load.shoulder - expS - tareS : 0;
      const rawE = Number.isFinite(load.elbow) ? load.elbow - expE - tareE : 0;
      const netTorque = Math.round(Math.hypot(rawS, rawE * 0.75));
      const grams = this.scaleTare ? Math.max(0, Math.round(netTorque * (240 / rMoment) * 1.15)) : null;
      this.lastEstimatedGrams = grams != null ? grams : Math.max(0, Math.round(netTorque * 0.9));
      set('scale-state', this.scaleTare ? 'Taré · actif' : 'Modèle nominal (non taré)');
      if (this.nodes['scale-state']) this.nodes['scale-state'].dataset.state = this.scaleTare ? 'ok' : '';
      set('scale-grams', grams != null ? `≈ ${grams} g` : `≈ ${Math.max(0, Math.round(netTorque * 0.9))} g (indicatif)`);
      set('scale-delta', `${netTorque} u · bras ${Math.round(rMoment)} mm`);

      const handLoad = Math.abs(Number(load.hand) || 0);
      const closedEnough = actual.hand >= 122;
      let gripLabel = closedEnough ? (handLoad >= 140 ? `Objet maintenu (couple ${Math.round(handLoad)})` : 'Pince fermée (sans charge)') : 'Pince ouverte';
      if (this.holdingObject && state.config.mode === 'hardware' && handLoad < this.holdingObject.minLoad) {
        gripLabel = '⚠ Prise perdue (chute de couple)';
      }
      set('scale-grip', gripLabel);

      // Tug-to-release: when enabled, armed, idle, and holding/closed, a tug spike opens the jaws.
      if (this.nodes['th-tug']?.checked && this.lease && this.armedNow && !this.pending && !state.moving && actual.hand > 115) {
        const dS = Math.abs((Number(load.shoulder) || 0) - (this.lastIdleLoad?.shoulder ?? (Number(load.shoulder) || 0)));
        const dE = Math.abs((Number(load.elbow) || 0) - (this.lastIdleLoad?.elbow ?? (Number(load.elbow) || 0)));
        if ((dS >= 145 || dE >= 145) && performance.now() > (this.nextAutoActionAt || 0)) {
          this.nextAutoActionAt = performance.now() + 1800;
          this.holdingObject = null;
          this.run(async () => {
            await this.thirdHandRelease();
            this.message('Traction détectée sur la pièce : pince ouverte automatiquement.');
          });
        }
      }
      // Compliant Touch-Follow (Guidage au toucher): pushing an axis nudges it by one smooth step.
      if (this.nodes['touch-follow']?.checked && this.lease && this.armedNow && !this.pending && !state.moving &&
          performance.now() > (this.nextAutoActionAt || 0)) {
        const baseIdle = this.lastIdleLoad || load;
        const diffs = [
          ['base', (Number(load.base) || 0) - (Number(baseIdle.base) || 0)],
          ['shoulder', (Number(load.shoulder) || 0) - (Number(baseIdle.shoulder) || 0)],
          ['elbow', (Number(load.elbow) || 0) - (Number(baseIdle.elbow) || 0)],
        ];
        diffs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        const [topAxis, topDelta] = diffs[0];
        if (Math.abs(topDelta) >= 115) {
          this.nextAutoActionAt = performance.now() + 650;
          const step = Number(this.nodes['angle-step']?.value || 2);
          const dir = topDelta > 0 ? -1 : 1;
          const [lo, hi] = state.config.joint_limits[topAxis];
          const nextVal = Math.min(hi, Math.max(lo, actual[topAxis] + dir * step));
          if (Math.abs(nextVal - actual[topAxis]) > NOOP_DEGREES) {
            this.run(() => this.move({ kind: 'joints', pose: { ...actual, [topAxis]: nextVal } }));
          }
        }
      }
      if (!state.moving) {
        this.lastIdleLoad = {
          base: Number(load.base) || 0,
          shoulder: Number(load.shoulder) || 0,
          elbow: Number(load.elbow) || 0,
          hand: Number(load.hand) || 0,
        };
      }
      this.updatePalletBadge();
    }

    async thirdHandHold() {
      await this.graspToContact();
      const handLoad = Math.abs(this.state?.feedback?.load?.hand || 0);
      this.holdingObject = { minLoad: Math.max(70, handLoad * 0.4) };
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Pièce maintenue';
    }

    async thirdHandPresent() {
      const actual = this.state?.feedback?.actual || HOME_POSE;
      const pose = { base: 0, shoulder: 12, elbow: 72, hand: actual.hand };
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Présentation…';
      await this.goToPose(pose, 'Présentation atelier');
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Face opérateur';
    }

    async thirdHandRelease() {
      const actual = this.state?.feedback?.actual;
      if (!actual) return;
      const [min] = this.state?.config.joint_limits.hand || [70, 260];
      const openAngle = Math.max(min, 100);
      this.holdingObject = null;
      await this.goToPose({ ...actual, hand: openAngle }, 'Ouverture pince');
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Pince ouverte';
    }

    async thirdHandOrient(dBase, dTilt) {
      const actual = this.state?.feedback?.actual;
      if (!actual) return;
      const limits = this.state.config.joint_limits;
      const clamp = (k, v) => Math.min(limits[k][1], Math.max(limits[k][0], v));
      const pose = {
        base: clamp('base', actual.base + dBase),
        shoulder: clamp('shoulder', actual.shoulder - dTilt * 0.4),
        elbow: clamp('elbow', actual.elbow + dTilt),
        hand: actual.hand,
      };
      await this.goToPose(pose, 'Orientation pièce');
    }

    touchCaptureTo3D() {
      const pose = this.state?.feedback?.actual || this.fieldPose();
      if (!pose) return;
      if (!this.composeOpen) this.composeToggle(true);
      this.composeAdd(pose);
      this.message(`Point capturé dans l’éditeur 3D (${this.compose.points.length} point(s)).`);
    }

    resolveTxEndpoint(selectKey) {
      const val = this.nodes[selectKey]?.value;
      if (val === '__default_src') return { x: 240, y: -90, z: 75 };
      if (val === '__default_dst') return { x: 240, y: 90, z: 75 };
      if (val === '__actual') return this.state?.feedback?.actual || HOME_POSE;
      if (val === '__fields') {
        return this.mode === 'joints' ? (this.fieldPose() || HOME_POSE)
          : { x: this.form.x.valueAsNumber, y: this.form.y.valueAsNumber, z: this.form.z.valueAsNumber, t: this.form.t.valueAsNumber };
      }
      return val;
    }

    buildTransferPayload() {
      return {
        synthesize: 'transfer',
        source: this.resolveTxEndpoint('tx-source'),
        dest: this.resolveTxEndpoint('tx-dest'),
        clearance_z: Number(this.nodes['tx-clear']?.valueAsNumber || 55),
        dwell: Number(this.nodes['tx-dwell']?.valueAsNumber ?? 0.6),
      };
    }

    buildPalletPayload() {
      const z = Number(this.nodes['pal-z']?.valueAsNumber || 70);
      return {
        synthesize: 'pallet',
        rows: Number(this.nodes['pal-rows']?.valueAsNumber || 2),
        cols: Number(this.nodes['pal-cols']?.valueAsNumber || 3),
        corner_a: {
          x: Number(this.nodes['pal-ax']?.valueAsNumber || 200),
          y: Number(this.nodes['pal-ay']?.valueAsNumber || -80),
          z,
        },
        corner_b: {
          x: Number(this.nodes['pal-bx']?.valueAsNumber || 290),
          y: Number(this.nodes['pal-by']?.valueAsNumber || 80),
          z,
        },
      };
    }

    updatePalletBadge() {
      if (!this.nodes['pal-cell-state']) return;
      const rows = Math.min(4, Math.max(1, Math.round(this.nodes['pal-rows']?.valueAsNumber || 2)));
      const cols = Math.min(4, Math.max(1, Math.round(this.nodes['pal-cols']?.valueAsNumber || 3)));
      const total = rows * cols;
      const activeIdx = (this.palletCellIndex || 0) % total;
      const idx = activeIdx + 1;
      const txt = `Cellule ${idx} / ${total}`;
      if (this.nodes['pal-cell-state'].textContent !== txt) this.nodes['pal-cell-state'].textContent = txt;
      const mapNode = this.nodes['pal-map'];
      if (!mapNode) return;
      const x0 = Number(this.nodes['pal-ax']?.valueAsNumber || 200);
      const y0 = Number(this.nodes['pal-ay']?.valueAsNumber || -80);
      const bx = Number(this.nodes['pal-bx']?.valueAsNumber || 290);
      const by = Number(this.nodes['pal-by']?.valueAsNumber || 80);
      const z = Number(this.nodes['pal-z']?.valueAsNumber || 70);
      const dx = rows > 1 ? (bx - x0) / (rows - 1) : 0;
      const dy = cols > 1 ? (by - y0) / (cols - 1) : 0;
      const sig = `${rows}:${cols}:${x0}:${y0}:${bx}:${by}:${z}:${activeIdx}`;
      if (this.palletMapSig === sig) return;
      this.palletMapSig = sig;
      mapNode.style.setProperty('--pal-cols', String(cols));
      const buttons = [];
      let slot = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const colIdx = r % 2 === 1 ? (cols - 1 - c) : c;
          const cx = Math.round(x0 + r * dx);
          const cy = Math.round(y0 + colIdx * dy);
          const mySlot = slot++;
          const btn = document.createElement('button');
          btn.type = 'button';
          const isDone = mySlot < activeIdx;
          btn.className = 'rb-pallet-slot' + (mySlot === activeIdx ? ' is-active' : isDone ? ' is-done' : '');
          btn.innerHTML = `<strong>${isDone ? '✓ ' : ''}L${r + 1}·C${colIdx + 1}</strong><small>${cx},${cy}</small>`;
          btn.title = `Alvéole L${r + 1}·C${colIdx + 1} · X ${cx} · Y ${cy} · Z ${z} mm (cliquer pour viser)`;
          btn.addEventListener('click', () => {
            this.palletCellIndex = mySlot;
            this.updatePalletBadge();
            this.drawPosition();
            this.updateSpace();
            const hand = Number.isFinite(this.form.hand?.valueAsNumber) ? this.form.hand.valueAsNumber : 180;
            this.form.x.value = String(cx);
            this.form.y.value = String(cy);
            this.form.z.value = String(z);
            this.run(async () => {
              const res = await this.preview({ kind: 'cartesian', xyz: { x: cx, y: cy, z, t: hand } }, true);
              if (res) this.message(`Alvéole L${r + 1}·C${colIdx + 1} sélectionnée (X ${cx} · Y ${cy} · Z ${z} mm).`);
            });
          });
          buttons.push(btn);
        }
      }
      mapNode.replaceChildren(...buttons);
    }

    async composeSynthesized(payload) {
      const result = await this.request('assistant/import', { ...payload, dry_run: true });
      if (!result.valid || !result.synthesized) {
        throw new Error(result.reason || 'Impossible de synthétiser cette trajectoire.');
      }
      this.composeLoad(result.synthesized);
      this.message(`Trajectoire « ${result.synthesized.title} » générée dans l’éditeur 3D (${result.step_count} poses · ≈ ${result.estimated_seconds} s).`);
    }

    async runTransferCycle() {
      if (!this.lease || !this.armedNow) throw new Error('Armez le poste avant de lancer un transfert.');
      const result = await this.request('assistant/import', { ...this.buildTransferPayload(), dry_run: true });
      if (!result.valid || !result.synthesized) {
        throw new Error(result.reason || 'Trajectoire de transfert refusée par les gardes de sécurité.');
      }
      const steps = result.synthesized.plan?.points || result.synthesized.steps;
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Transfert A → B…';
      this.debugZTrim = 0;
      try {
        let transitRef = null;
        for (const [idx, pose] of steps.entries()) {
          if (!this.active || !this.lease) return;
          if (!await this.debugPauseIfNeeded(idx + 1, steps.length)) return;
          let stepPose = pose;
          if (this.debugZTrim) {
            const curXyz = armLinks(pose).tcp;
            const trimmed = ikPose(curXyz.x, curXyz.y, curXyz.z + this.debugZTrim, pose.hand);
            if (trimmed) stepPose = trimmed;
          }
          if (idx === 2) {
            await this.graspToContact();
          } else {
            if (!await this.approachPose(stepPose, true)) return;
            if (this.state?.config?.mode === 'hardware' && idx !== 3 && idx !== 5) {
              const snap = this.captureLoadSnap();
              if (transitRef) await this.checkTorqueDelta(transitRef, 260);
              else if (Object.keys(snap).length) transitRef = snap;
            }
          }
        }
        this.celebrateCompletion();
        this.message('Transfert Pick A → Place B terminé.');
      } finally {
        if (this.nodes['step-debugger']) this.nodes['step-debugger'].hidden = true;
        if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Prêt';
      }
    }

    updateDebugLabel() {
      const lbl = this.nodes['debug-label'];
      if (!lbl || !this.debugStepInfo) return;
      const trim = this.debugZTrim || 0;
      lbl.textContent = `${this.debugStepInfo} · Z ${trim >= 0 ? '+' : ''}${trim} mm`;
    }

    debugPauseIfNeeded(stepNum, totalSteps) {
      if (!this.nodes['debug-step-mode']?.checked) return Promise.resolve(true);
      const bar = this.nodes['step-debugger'];
      if (!bar) return Promise.resolve(true);
      this.debugStepInfo = `Pause avant étape ${stepNum} / ${totalSteps}`;
      this.updateDebugLabel();
      bar.hidden = false;
      return new Promise(resolve => {
        let settled = false;
        const finish = ok => {
          if (settled) return;
          settled = true;
          this.debugResolve = null;
          this.debugAbort = null;
          bar.hidden = true;
          resolve(ok);
        };
        this.debugResolve = () => finish(true);
        this.debugAbort = () => finish(false);
      });
    }

    async toggleTeachMode() {
      const next = !this.state?.teach_mode;
      const status = await this.request('teach', { enable: next });
      this.render(status);
      this.schedule(next ? 250 : 700);
      this.message(next
        ? 'Mode libre actif : guidez le bras à la main puis cliquez « Mémoriser ce point en 3D ».'
        : 'Couple moteur réengagé et position synchronisée.');
    }

    captureVideoFrame(label = '') {
      const video = this.nodes.video;
      if (!this.stream || !video || !video.videoWidth || !video.videoHeight) {
        throw new Error('Flux vidéo inactif : démarrez le direct pour capturer une photo.');
      }
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const xyz = this.displayXyz();
      const stamp = new Date().toLocaleTimeString();
      const caption = (label || stamp) + (xyz ? ` · X${Math.round(xyz.x)} Y${Math.round(xyz.y)} Z${Math.round(xyz.z)}` : '');
      const url = c.toDataURL('image/jpeg', 0.88);
      this.snapshots = [{ url, caption }, ...(this.snapshots || [])].slice(0, 6);
      const strip = this.nodes['snap-strip'];
      if (strip) {
        strip.hidden = false;
        strip.replaceChildren(...this.snapshots.map((item, idx) => {
          const card = document.createElement('div');
          card.className = 'rb-snap-thumb';
          const link = document.createElement('a');
          link.href = item.url;
          link.download = `roarm-tapo-${idx + 1}.jpg`;
          link.title = `Télécharger (${item.caption})`;
          const img = document.createElement('img');
          img.src = item.url;
          img.alt = item.caption;
          const cap = document.createElement('span');
          cap.textContent = item.caption;
          link.append(img, cap);
          const ask = document.createElement('button');
          ask.type = 'button';
          ask.className = 'rb-snap-ask';
          ask.textContent = 'Analyser (Kinétia)';
          ask.addEventListener('click', () => this.run(() => this.inspectSnapshotWithKinetia(item)));
          card.append(link, ask);
          return card;
        }));
      }
      this.message(`Photo capturée (${caption}).`);
      this.playHudSound('capture');
      if (this.state) this.updateCopilot(this.state);
    }

    async detectCameraObject() {
      const video = this.nodes.video;
      if (!this.stream || !video?.videoWidth || !this.cameraMap?.map) {
        throw new Error('Démarrez le direct et calibrez le repère caméra (3 points) d’abord.');
      }
      const w = 160, h = 90;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let sumW = 0, sumU = 0, sumV = 0;
      for (let py = 6; py < h - 6; py++) {
        for (let px = 6; px < w - 6; px++) {
          const i = (py * w + px) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
          const sat = maxC > 25 ? (maxC - minC) / maxC : 0;
          if (sat > 0.38) {
            const wt = sat * sat;
            sumW += wt;
            sumU += px * wt;
            sumV += py * wt;
          }
        }
      }
      if (sumW < 4) throw new Error('Aucun objet coloré/contrasté distinct détecté dans le champ.');
      const rect = video.getBoundingClientRect();
      const u = (sumU / sumW) * (rect.width / w);
      const v = (sumV / sumW) * (rect.height / h);
      const map = this.cameraMap.map;
      const det = map.a * map.e - map.b * map.d;
      if (Math.abs(det) < 1e-6) throw new Error('Repère caméra invalide.');
      const ws = this.state?.config.workspace;
      let rx = (map.e * (u - map.c) - map.b * (v - map.f)) / det;
      let ry = (-map.d * (u - map.c) + map.a * (v - map.f)) / det;
      if (ws) {
        rx = Math.min(ws.x[1], Math.max(ws.x[0], rx));
        ry = Math.min(ws.y[1], Math.max(ws.y[0], ry));
      }
      const z = Number.isFinite(this.form.z.valueAsNumber) ? this.form.z.valueAsNumber : 100;
      const t = Number.isFinite(this.form.t.valueAsNumber) ? this.form.t.valueAsNumber : 180;
      this.form.x.value = Number(rx.toFixed(1));
      this.form.y.value = Number(ry.toFixed(1));
      const res = await this.preview({ kind: 'cartesian', xyz: { x: rx, y: ry, z, t } });
      if (res) {
        this.playHudSound('capture');
        this.message(`Objet détecté sur le direct → X ${Math.round(rx)} · Y ${Math.round(ry)} mm prévisualisés.`);
      }
    }

    toggleAudioHud() {
      this.audioHud = !this.audioHud;
      try { localStorage.setItem('hq_robotics_audio_hud_v1', this.audioHud ? '1' : '0'); } catch (_) {}
      if (this.nodes['audio-hud']) this.nodes['audio-hud'].setAttribute('aria-pressed', String(this.audioHud));
      if (this.audioHud) this.playHudSound('arm');
      this.message(this.audioHud ? 'Retours sonores HUD activés.' : 'Retours sonores HUD coupés.');
    }

    playHudSound(kind) {
      if (!this.audioHud) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        this.audioCtx ||= new Ctx();
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
        const now = this.audioCtx.currentTime;
        const tone = (freq, start, dur, vol = 0.045, type = 'sine') => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, now + start);
          gain.gain.setValueAtTime(0.0001, now + start);
          gain.gain.exponentialRampToValueAtTime(vol, now + start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
          osc.connect(gain).connect(this.audioCtx.destination);
          osc.start(now + start);
          osc.stop(now + start + dur + 0.02);
        };
        if (kind === 'arm') { tone(523.25, 0, 0.09, 0.045); tone(783.99, 0.07, 0.14, 0.045); }
        else if (kind === 'jog') { tone(880, 0, 0.032, 0.025, 'triangle'); }
        else if (kind === 'grasp') { tone(440, 0, 0.08, 0.045); tone(659.25, 0.06, 0.15, 0.045); }
        else if (kind === 'capture') { tone(1046.5, 0, 0.07, 0.035); }
        else if (kind === 'complete') { tone(587.33, 0, 0.11, 0.045); tone(880, 0.08, 0.22, 0.045); }
        else if (kind === 'stop') { tone(310, 0, 0.11, 0.055, 'sawtooth'); tone(220, 0.1, 0.16, 0.055, 'sawtooth'); }
      } catch (_) {}
    }

    haptic(pattern) {
      try { navigator.vibrate?.(pattern); } catch (_) {}
    }

    celebrateCompletion() {
      this.playHudSound('complete');
      this.haptic([12, 35, 18]);
      this.assistant?.onMissionComplete?.(this.state);
      const bar = this.host.querySelector('.rb-status');
      if (!bar) return;
      bar.classList.remove('is-complete');
      void bar.offsetWidth;
      bar.classList.add('is-complete');
      clearTimeout(this.completeTimer);
      this.completeTimer = setTimeout(() => bar.classList.remove('is-complete'), 1100);
    }

    async stepNextPalletCell() {
      if (!this.lease || !this.armedNow) throw new Error('Armez le poste avant de parcourir la grille.');
      const result = await this.request('assistant/import', { ...this.buildPalletPayload(), dry_run: true });
      const cells = result.synthesized?.cells;
      if (!result.valid || !Array.isArray(cells) || !cells.length) {
        throw new Error(result.reason || 'Grille hors d’atteinte ou dans une zone d’exclusion.');
      }
      const idx = (this.palletCellIndex || 0) % cells.length;
      const cell = cells[idx];
      this.palletCellIndex = (idx + 1) % cells.length;
      this.updatePalletBadge();
      if (cell.hover && !await this.approachPose(cell.hover, true)) return;
      if (await this.approachPose(cell.pose, true)) {
        this.pilotFields(cell.pose, cell.xyz);
        this.celebrateCompletion();
        this.message(`Alvéole ${idx + 1}/${cells.length} atteinte (L${cell.row}·C${cell.col} : X ${cell.xyz.x} · Y ${cell.xyz.y} mm).`);
      }
    }

    async fillPalletFromSource() {
      if (!this.lease || !this.armedNow) throw new Error('Armez le poste avant de remplir le plateau.');
      const palRes = await this.request('assistant/import', { ...this.buildPalletPayload(), dry_run: true });
      const cells = palRes.synthesized?.cells;
      if (!palRes.valid || !Array.isArray(cells) || !cells.length) {
        throw new Error(palRes.reason || 'Grille hors d’atteinte ou dans une zone d’exclusion.');
      }
      const startIdx = (this.palletCellIndex || 0) % cells.length;
      const clearance = Number(this.nodes['tx-clear']?.valueAsNumber || 55);
      const srcEp = this.resolveTxEndpoint('tx-source');
      const srcPre = await this.request('preview', typeof srcEp === 'string' ? { kind: 'preset', id: srcEp }
        : Number.isFinite(srcEp?.base) ? { kind: 'joints', pose: srcEp } : { kind: 'cartesian', xyz: { ...srcEp, t: 105 } });
      const srcHoverPre = await this.request('preview', { kind: 'cartesian', xyz: { x: srcPre.xyz.x, y: srcPre.xyz.y, z: srcPre.xyz.z + clearance, t: 105 } });
      if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Remplissage plateau…';
      try {
        for (let i = startIdx; i < cells.length; i++) {
          if (!this.active || !this.lease) return;
          const cell = cells[i];
          if (!await this.debugPauseIfNeeded(i - startIdx + 1, cells.length - startIdx)) return;
          if (!await this.approachPose(srcHoverPre.pose, true)) return;
          if (!await this.approachPose(srcPre.pose, true)) return;
          await this.graspToContact();
          if (!await this.approachPose(srcHoverPre.pose, true)) return;
          if (cell.hover && !await this.approachPose(cell.hover, true)) return;
          if (!await this.approachPose(cell.pose, true)) return;
          const [minHand] = this.state?.config.joint_limits.hand || [70, 260];
          if (!await this.approachPose({ ...cell.pose, hand: Math.max(minHand, 105) }, true)) return;
          if (cell.hover && !await this.approachPose(cell.hover, true)) return;
          this.palletCellIndex = (i + 1) % cells.length;
          this.updatePalletBadge();
        }
        this.celebrateCompletion();
        this.message(`Plateau rempli (${cells.length - startIdx} alvéole(s) traitée(s)).`);
      } finally {
        if (this.nodes['step-debugger']) this.nodes['step-debugger'].hidden = true;
        if (this.nodes['wb-status']) this.nodes['wb-status'].textContent = 'Prêt';
      }
    }

    async inspectSnapshotWithKinetia(snap) {
      if (!snap?.url) return;
      await this.mountAssistant(true);
      if (!this.assistant) return;
      this.assistant.nodes.status.textContent = 'Kinétia analyse la photo Tapo…';
      await this.assistant.perform('inspect-image', { image: snap.url, caption: snap.caption || '' }, 'Analyse visuelle…');
    }

    updateCopilot(state, errorText = '') {
      const box = this.nodes['kinetia-copilot'];
      const out = this.nodes['copilot-text'];
      const actionsWrap = this.nodes['copilot-actions'];
      if (!box || !out || !actionsWrap) return;
      const urgent = !!errorText || !!(state?.stop_latched || state?.uncertain);
      if (!urgent) {
        box.hidden = true;
        this.copilotSig = '';
        return;
      }
      box.hidden = false;
      let text = '';
      const actions = [];
      const addAct = (label, fn) => actions.push({ label, fn });

      if (errorText) {
        if (/zone d’exclusion/i.test(errorText)) {
          text = 'Trajectoire bloquée par une zone d’exclusion : je peux préparer un contournement en arc 3D ou ouvrir les zones.';
          addAct('Ouvrir éditeur 3D', () => this.composeToggle(true));
        } else if (/pas physique|step_limit|approcher/i.test(errorText)) {
          text = 'Cible trop lointaine pour un seul pas physique : utilisez Approcher en pas mesurés.';
          if (!this.nodes['move-approach']?.hidden) addAct('Approcher maintenant', () => this.approachFieldTarget());
        } else if (/plancher/i.test(errorText)) {
          text = 'La pointe de l’outil descend sous Plancher Z : relevez Z ou ajustez Plancher Z / Outil +mm.';
        } else if (/hors d’atteinte|atteinte/i.test(errorText)) {
          text = 'Point hors de la sphère d’atteinte à cette hauteur Z (voir l’anneau vert sur le plan XY).';
        } else {
          text = `Incident détecté : « ${errorText} ». Besoin d’aide pour diagnostiquer ?`;
          addAct('Demander à Kinétia', () => this.mountAssistant(true));
        }
      } else if (state?.stop_latched || state?.uncertain) {
        text = 'Poste verrouillé pour inspection : vérifiez le bras sur place puis réinitialisez.';
        if (!this.nodes.reset?.hidden) addAct('Réinitialiser', () => this.nodes.reset.click());
      } else if (state?.teach_mode) {
        text = 'Mode libre actif : guidez le bras à la main puis capturez chaque point dans l’éditeur 3D.';
        addAct('Capturer point 3D', () => this.touchCaptureTo3D());
        addAct('Quitter mode libre', () => this.run(() => this.toggleTeachMode()));
      } else if (this.assistant?.liveBannerText && Date.now() < (this.assistant.liveBannerUntil || 0)) {
        text = this.assistant.liveBannerText;
      } else if (this.snapshots?.length) {
        text = `Photo Tapo prête (${this.snapshots[0].caption}) : je peux l’analyser pour vérifier l’alignement ou les composants.`;
        addAct('Analyser dernière photo', () => this.run(() => this.inspectSnapshotWithKinetia(this.snapshots[0])));
        addAct('Transfert A→B', () => this.run(() => this.composeSynthesized(this.buildTransferPayload())));
      } else if (state?.armed) {
        const loads = Object.entries(state.feedback?.load || {}).filter(([, v]) => Number.isFinite(v));
        const peak = loads.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
        if (peak && Math.abs(peak[1]) >= (state.config?.load_warn ?? 700)) {
          text = `Charge élevée sur ${axes[peak[0]] || peak[0]} (${Math.round(Math.abs(peak[1]))}) : réduisez la vitesse ou vérifiez l’obstacle.`;
        } else {
          text = 'Poste armé : vous pouvez piloter, saisir au couple ou lancer une macro d’atelier.';
          addAct('Présenter face', () => this.run(() => this.thirdHandPresent()));
          addAct('Saisir au couple', () => this.run(() => this.thirdHandHold()));
        }
      } else if (state?.config?.mode === 'hardware' && !state?.armed && !state?.teach_mode) {
        const checks = [];
        if (!state.physical_local) checks.push('ouvrir http://127.0.0.1:8765/#robotique sur le PC hôte');
        if (!state.commissioned) checks.push('terminer la mise en service');
        const estopMode = state.estop?.mode || 'unmonitored';
        const estopOk = (estopMode === 'hardware' && state.estop?.healthy === true) ||
          (estopMode === 'unmonitored' && state.config?.estop_required !== true);
        if (!estopOk) {
          checks.push('rétablir le moniteur E-stop');
          addAct('Ouvrir E-stop', () => this.openSettings());
        }
        if (!state.camera_live && state.config?.camera_required !== false) {
          checks.push('démarrer le flux caméra');
          if (state.camera_local && state.gateway && state.config?.camera_configured) {
            addAct('Démarrer le direct', () => this.run(() => this.startVideo()));
          }
        }
        if (!state.feedback) {
          checks.push('lire le retour du RoArm');
          if (state.config?.arm_ip && state.physical_local) addAct('Lire le RoArm', () => this.run(() => this.probe()));
        }
        if (!checks.length && !state.occupied && !this.lease) {
          text = 'Pré-requis matériel validés : prêt à armer le poste ou à lancer une macro.';
          addAct('Armer le poste', () => this.nodes.arm?.click());
          addAct('Mode libre', () => this.run(() => this.toggleTeachMode()));
        } else {
          text = `Déverrouillage matériel requis : ${checks.join(' → ')}.`;
        }
      } else {
        text = errorText ? `Incident : ${errorText}` : 'Poste à vérifier avant de continuer.';
        addAct('Demander à Kinétia', () => this.mountAssistant(true));
      }

      const sig = text + '|' + actions.map(a => a.label).join(',');
      if (this.copilotSig === sig) return;
      this.copilotSig = sig;
      out.textContent = text;
      box.classList.toggle('is-alert', !!errorText || !!(state?.stop_latched || state?.uncertain));
      actionsWrap.replaceChildren(...actions.map(act => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = act.label;
        b.addEventListener('click', act.fn);
        return b;
      }));
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
