/* Robotique is mounted only when its HQ view opens. */
(() => {
  'use strict';
  const axes = { base: 'Base', shoulder: 'Épaule', elbow: 'Coude', hand: 'Pince' };
  const coordinates = { x: 'X', y: 'Y', z: 'Z', t: 'Pince' };
  const axisKeys = Object.keys(axes);
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
      ${cartesian ? '' : `<input class="rb-slider" type="range" data-rb="slider-${key}" min="-180" max="270" step="0.1" value="0" aria-label="${label} · curseur">`}
    </div>`).join('');

  const markup = `
    <header class="rb-head">
      <div><h1>Robotique</h1><p>RoArm-M2-S <span aria-hidden="true">/</span> Tapo C200</p></div>
      <div class="rb-head-actions">
        <button type="button" data-rb="open-assistant" aria-controls="hq-robotics-chat">Kinétia</button>
        <button type="button" data-rb="open-settings" aria-controls="robotics-settings">Réglages</button>
      </div>
    </header>
    <nav class="rb-section-nav" aria-label="Sections Robotique">
      <button type="button" data-go-section="camera">Moniteur</button>
      <button type="button" data-go-section="motion">Pilotage</button>
      <button type="button" data-go-section="telemetry">Télémétrie</button>
      <button type="button" data-go-section="presets">Positions</button>
      <button type="button" data-go-section="records">Scripts</button>
      <button type="button" data-go-section="config">Réglages</button>
    </nav>
    <div class="rb-status" aria-label="État du poste">
      <div class="rb-status-device"><span>Mode</span><strong data-rb="mode">Connexion…</strong></div>
      <div class="rb-status-device"><span>Bras</span><strong data-rb="arm-state">—</strong></div>
      <div class="rb-status-device"><span>Caméra</span><strong data-rb="camera-state">—</strong></div>
      <div class="rb-status-safety">
        <small class="rb-estop" data-rb="estop">E-stop —</small>
        <strong data-rb="safety" role="status">Désarmé</strong>
        <button type="button" class="rb-stop" data-rb="stop" disabled>STOP logiciel</button>
      </div>
    </div>
    <div class="rb-workspace">
      <section class="rb-card rb-camera" data-section="camera" aria-labelledby="rb-monitor-title">
        <div class="rb-card-head rb-monitor-head">
          <h2 id="rb-monitor-title">Moniteur</h2>
          <div class="rb-tabs" role="group" aria-label="Vue du moniteur">
            <button type="button" data-monitor="position" aria-controls="rb-position-pane" aria-pressed="true">Position</button>
            <button type="button" data-monitor="camera" aria-controls="rb-camera-pane" aria-pressed="false">Caméra</button>
          </div>
        </div>
        <div id="rb-position-pane" data-rb="position-pane">
          <div class="rb-viewport rb-plot">
            <div class="rb-plot-caption"><span>Plan XY · mm</span><span data-rb="plot-source">—</span></div>
            <canvas data-rb="plot" aria-hidden="true" title="Cliquez pour viser une position XY ; faites glisser le point du bras pour le déplacer"></canvas>
            <div class="rb-plot-key"><span class="rb-key-area">Zone XY</span><span>Position</span><span class="rb-key-preview" data-rb="plot-preview" hidden>Aperçu</span><span class="rb-key-command" data-rb="plot-command" hidden>Cible</span><span class="rb-key-trace" data-rb="plot-trace" hidden>Trace</span><span class="rb-key-ghost" data-rb="plot-ghosts" hidden>Bibliothèque</span></div>
          </div>
          <dl class="rb-coordinates">
            ${['x', 'y', 'z'].map(axis => `<div><dt>${axis.toUpperCase()}</dt><dd><output data-rb="position-${axis}">—</output><span>mm</span></dd></div>`).join('')}
          </dl>
          <p class="rb-hint">Cliquez pour viser. Faites glisser le point du bras pour le suivre ; relâchez dans le plan pour terminer. Z et la pince viennent du formulaire.</p>
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
            <label class="rb-quality">Qualité <select data-rb="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
            <div class="rb-actions">
              <button type="button" class="rb-primary" data-rb="video-start" disabled>Démarrer le direct</button>
              <button type="button" data-rb="video-stop" disabled hidden>Couper le flux</button>
              <button type="button" data-rb="fullscreen" disabled hidden>Plein écran</button>
            </div>
          </div>
          <div class="rb-audio" data-rb="audio" role="group" aria-label="Audio de la caméra" hidden>
            <audio data-rb="speaker" playsinline></audio>
            <button type="button" data-rb="listen" aria-pressed="false" disabled>Écouter</button>
            <button type="button" data-rb="talk" aria-pressed="false" disabled>Parler</button>
            <span data-rb="audio-status" role="status"></span>
          </div>
          <div class="rb-ptz" data-rb="ptz" role="group" aria-label="Orientation de la caméra" hidden>
            <button type="button" data-ptz="up" aria-label="Caméra vers le haut">▲</button>
            <button type="button" data-ptz="left" aria-label="Caméra vers la gauche">◀</button>
            <button type="button" data-ptz="stop" aria-label="Arrêter la caméra">■</button>
            <button type="button" data-ptz="right" aria-label="Caméra vers la droite">▶</button>
            <button type="button" data-ptz="down" aria-label="Caméra vers le bas">▼</button>
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
          </div>
          <details class="rb-camera-calibration" data-rb="camera-calibration" hidden>
            <summary>Repère caméra · indicatif</summary>
            <p class="rb-hint">Trois points de référence relient le plan XY à l’image. Cliquez « Prendre » puis le point correspondant dans la vidéo, saisissez ses coordonnées robot, et répétez. Le repère est mémorisé dans ce navigateur seulement ; il est indicatif et ne remplace pas une calibration caméra.</p>
            <div class="rb-cal-points">
              <div class="rb-cal-point" data-cal-point="a"><b>A</b><button type="button" data-cal-capture="a">Prendre</button><label>X mm<input data-cal-x="a" type="number" step="1" required></label><label>Y mm<input data-cal-y="a" type="number" step="1" required></label><output data-cal-pixel="a">—</output></div>
              <div class="rb-cal-point" data-cal-point="b"><b>B</b><button type="button" data-cal-capture="b">Prendre</button><label>X mm<input data-cal-x="b" type="number" step="1" required></label><label>Y mm<input data-cal-y="b" type="number" step="1" required></label><output data-cal-pixel="b">—</output></div>
              <div class="rb-cal-point" data-cal-point="c"><b>C</b><button type="button" data-cal-capture="c">Prendre</button><label>X mm<input data-cal-x="c" type="number" step="1" required></label><label>Y mm<input data-cal-y="c" type="number" step="1" required></label><output data-cal-pixel="c">—</output></div>
            </div>
            <div class="rb-actions"><button type="button" data-cal-save>Enregistrer le repère</button>
              <button type="button" data-cal-clear>Effacer</button>
              <label class="rb-check"><input type="checkbox" data-cal-show checked> Afficher sur le direct</label></div>
            <p data-rb="cal-state" role="status">Aucun repère.</p>
          </details>
        </div>
      </section>
      <section class="rb-card rb-motion" data-section="motion" data-rb="motion" aria-labelledby="rb-motion-title">
        <div class="rb-card-head"><h2 id="rb-motion-title">Pilotage</h2><span data-rb="motion-state">En attente</span></div>
        <div class="rb-safety">
          <div class="rb-actions"><button type="button" class="rb-primary" data-rb="arm" disabled>Armer</button>
            <span class="rb-lease" data-rb="lease" hidden></span>
            <button type="button" data-rb="cancel" disabled>Annuler / désarmer</button>
            <button type="button" data-rb="reset" hidden>Réinitialiser</button>
            <button type="button" data-rb="probe" hidden>Lire le RoArm</button></div>
          <p data-rb="interlock">Chargement de l’état…</p>
          <p class="rb-hardware-note" data-rb="hardware-note" hidden>Le STOP verrouille le pilotage. Il demande la coupure du couple seulement si un mouvement est en cours ou incertain, et le bras peut alors tomber. Si la liaison échoue, utilisez la coupure physique.</p>
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
            <label data-rb="linear-step-label" hidden>Pas · mm<select data-rb="linear-step"><option>2</option><option selected>5</option><option>10</option></select></label>
            <label>Vitesse · pas/s<input data-rb="speed" type="number" inputmode="numeric" min="40" max="100" step="1" value="100" required></label>
          </div>
          <div class="rb-actions rb-motion-actions"><button type="button" data-rb="preview" disabled>Aperçu</button>
            <button type="button" data-rb="home" disabled>Retour au neutre</button>
            <button type="button" data-rb="home-direct" disabled>Neutre direct</button>
            <button type="submit" class="rb-primary" data-rb="move" disabled>Déplacer</button></div>
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
        <table><thead><tr><th scope="col">Axe</th><th scope="col" data-rb="actual-label">Mesuré</th><th scope="col">Demandé</th><th scope="col" title="Demandé − mesuré">Écart</th><th scope="col" title="Couple brut · barre relative 0–1000">Charge</th></tr></thead>
          <tbody>${Object.entries(axes).map(([key, label]) => `<tr><th scope="row">${label}</th>
          <td data-rb="actual-${key}">—</td><td data-rb="target-${key}">—</td><td class="rb-delta" data-rb="delta-${key}">—</td>
          <td data-rb="load-${key}"><div class="rb-load"><span data-rb="load-value-${key}">—</span><span class="rb-load-track" aria-hidden="true"><i data-rb="load-fill-${key}"></i></span></div></td></tr>`).join('')}</tbody></table>
        <div class="rb-readings" data-rb="electrical" hidden><output data-rb="voltage">Tension —</output></div>
        <div class="rb-load-watch" data-rb="load-watch">
          <canvas data-rb="load-trend" aria-label="Tendance de la charge maximale"></canvas>
          <div><strong data-rb="load-alert" role="status">Charge sous surveillance</strong>
          <span data-rb="load-peak">Pic —</span></div>
        </div>
      </section>
      <section class="rb-card rb-presets" data-section="presets" aria-labelledby="rb-presets-title">
        <div class="rb-card-head"><h2 id="rb-presets-title">Positions</h2></div>
        <div class="rb-preset-fields"><label>Position enregistrée<select data-rb="presets"><option value="">Choisir…</option></select></label>
          <label>Nom<input data-rb="preset-name" maxlength="64"></label></div>
        <div class="rb-actions"><button type="button" data-rb="preset-preview" disabled>Charger</button>
          <button type="button" data-rb="preset-run" disabled>Exécuter</button>
          <button type="button" data-rb="preset-save" disabled>Enregistrer la cible</button>
          <button type="button" data-rb="preset-rename" disabled>Renommer</button><button type="button" data-rb="preset-delete" disabled>Supprimer</button></div>
        <details class="rb-sequence" data-rb="sequence"><summary>Séquence de simulation</summary>
          <p class="rb-hint">Chaque étape est modifiable. Validez de nouveau après une modification.</p>
          <ol class="rb-seq-steps" data-rb="steps"></ol><div class="rb-actions">
          <button type="button" data-rb="step-add">Ajouter la cible</button><button type="button" data-rb="sequence-clear">Vider</button>
                      <button type="button" data-rb="sequence-check">Valider</button><button type="button" data-rb="sequence-run" disabled>Jouer une fois</button></div>
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
        <div class="rb-actions">
          <button type="button" class="rb-primary" data-rb="record-start" disabled>Enregistrer un mouvement</button>
          <button type="button" data-rb="record-stop" hidden>Arrêter l’enregistrement</button>
          <button type="button" data-rb="record-discard" hidden>Effacer les poses</button>
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
              ${field('camera_timeout', 'Délai vidéo · s', 'type="number" min="2" max="12" step="1" required')}
              ${field('estop_ip', 'Moniteur E-stop · IPv4', 'maxlength="15" placeholder="192.168.x.x"')}
              ${field('estop_port', 'Port du moniteur E-stop', 'type="number" min="1" max="65535" step="1" required')}
              ${field('estop_token', 'Jeton du moniteur E-stop', 'type="password" autocomplete="new-password" maxlength="128"')}
              <label>Qualité par défaut<select name="quality"><option value="standard">Standard</option><option value="high">Haute</option></select></label>
              <label>Transport<select name="transport"><option value="http">HTTP LAN</option></select></label>
              ${field('serial_port', 'Port série réservé', 'maxlength="32" placeholder="COM… (futur)"')}
              <label class="rb-check"><input type="checkbox" name="camera_required"> Exiger le direct caméra pour armer</label>
              <label class="rb-check"><input type="checkbox" name="estop_required"> Exiger un E-stop surveillé pour armer</label>
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
              <div class="rb-keepout-head"><strong>Zones d’exclusion TCP</strong>
                <button type="button" data-rb="keepout-add">Ajouter une zone</button></div>
              <p class="rb-hint">Le point terminal ne peut ni viser ni traverser ces boîtes XYZ. Garde logicielle indicative ; elle ne remplace pas une clôture ou un arrêt certifié.</p>
              <div class="rb-keepout-rows" data-rb="keepout-rows"></div>
            </div>
            <div class="rb-actions"><button type="submit" class="rb-primary">Enregistrer les réglages</button>
            <button type="button" data-rb="forget-camera">Effacer le compte caméra</button></div>
          </fieldset>
        </form>
        <details class="rb-commission-guide" data-rb="commission-guide">
          <summary>Mise en service guidée · simulation</summary>
          <p class="rb-hint">Contrôles logiciels seulement : aucune vérification de direction, de couple, de caméra ou d’arrêt physique n’est possible sans matériel. Utilisez ce guide avant une mise en service réelle, puis refaites les tests sur le bras.</p>
          <ol class="rb-commission-steps">
            <li data-commission-step="limits"><span>Enveloppe, limites articulaires et neutre</span><button type="button" data-commission-check="limits">Vérifier</button><output data-commission-output="limits">—</output></li>
            <li data-commission-step="path"><span>Validation d’une petite trajectoire</span><button type="button" data-commission-check="path">Vérifier</button><output data-commission-output="path">—</output></li>
            <li data-commission-step="camera"><span>Caméra / flux requis</span><button type="button" data-commission-check="camera">Vérifier</button><output data-commission-output="camera">—</output></li>
            <li data-commission-step="estop"><span>Arrêt d’urgence surveillé</span><button type="button" data-commission-check="estop">Vérifier</button><output data-commission-output="estop">—</output></li>
          </ol>
          <div class="rb-actions"><button type="button" class="rb-primary" data-rb="commission-all">Vérifier les contrôles</button></div>
          <p data-rb="commission-status" role="status"></p>
        </details>
      </details>
      <details class="rb-card rb-history" data-section="history"><summary>Journal des commandes</summary><ol data-rb="history"></ol>
        <div class="rb-blackbox"><button type="button" data-rb="blackbox-export">Exporter le journal noir</button>
        <span data-rb="blackbox-state" role="status">Échantillonnage local · 1 s</span></div></details>
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
      host.innerHTML = markup;
      this.nodes = Object.fromEntries([...host.querySelectorAll('[data-rb]')].map(el => [el.dataset.rb, el]));
      this.form = this.nodes.pose.elements;
      this.bind();
      this.loadCameraMap();
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
      listen(window, 'pagehide', () => this.hide());
      listen(window, 'offline', () => { this.release(); this.stopVideo(); });
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
      this.schedule(0);
      this.run(() => this.loadPresets());
      this.run(() => this.loadRecordings());
      this.run(() => this.loadRoutines());
      this.mountAssistant();
    }

    hide() {
      if (!this.active) return;
      this.active = false;
      this.assistant?.hide();
      this.generation++;
      this.lifecycle.abort();
      clearTimeout(this.pollTimer);
      this.clearConfirm();
      this.release();
      this.stopVideo();
      this.state = null;
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
        this.pollFailures = 0;
        this.render(state);
        delay = state.moving ? (state.config.mode === 'hardware' ? (this.playingScript || this.homing ? 220 : 550) : 250) :
          (this.lease || state.feedback?.source === 'hardware' || this.stream ? 1000 : 6500);
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
      text('camera-state', state.camera_live ? 'En direct' : (this.stream ? 'Connexion…' :
        (state.config.camera_configured ? 'En veille' : 'À configurer')));
      this.nodes['camera-state'].dataset.state = state.camera_live ? 'live' : '';
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
      for (const axis of ['x', 'y', 'z']) {
        text('position-' + axis, format(state.feedback?.xyz[axis]));
        text('hud-' + axis, format(state.feedback?.xyz[axis]));
      }
      text('plot-source', sim ? 'Simulation' : (state.feedback ? 'Mesuré' : 'Sans retour'));
      text('voltage', 'Tension ' + format(state.feedback?.voltage, ' V'));
      this.nodes.electrical.hidden = sim || !Number.isFinite(state.feedback?.voltage);
      this.nodes['hardware-note'].hidden = sim;
      let interlock;
      if (state.stop_latched || state.uncertain) interlock = 'Vérifiez le poste avant de réinitialiser.';
      else if (state.armed) interlock = 'Les commandes de mouvement sont actives.';
      else if (sim) interlock = 'Armez le simulateur pour déplacer le bras.';
      else if (!state.physical_local) interlock = 'Pilotage physique : ouvrez HQ sur le PC hôte à l’adresse http://127.0.0.1:8765/#robotique (ni IP du réseau, ni Tailscale, ni proxy).';
      else if (!state.commissioned) interlock = 'Mise en service physique requise.';
      else if (estopBlocked) interlock = estopMode === 'hardware' ? 'E-stop ouvert ou moniteur injoignable.' : 'Configurez un moniteur E-stop pour armer.';
      else if (!state.camera_live && state.config.camera_required !== false) interlock = 'Démarrez la vidéo pour armer.';
      else if (!state.feedback) interlock = 'Cliquez sur Lire le RoArm pour actualiser son état.';
      else interlock = 'Armez le poste en gardant le bras en vue.';
      text('interlock', interlock);
      text('video-hint', !state.camera_local ? 'Accès réseau local direct requis.' : (!state.gateway ?
        'La passerelle vidéo est indisponible sur le PC HQ.' : (!state.config.camera_configured ?
          'Renseignez le compte caméra dans les réglages.' : '')));
      this.nodes['camera-setup'].hidden = !state.physical_local || !state.gateway || state.config.camera_configured;
      if (state.camera_error && !this.stream) this.videoNote(state.camera_error);
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
      this.drawCameraOverlay();
      this.controls();
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
      if (lease) {
        const label = 'Autorisation · ' + lease + ' s';
        if (this.nodes.lease.textContent !== label) this.nodes.lease.textContent = label;
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
      this.host.querySelectorAll('[data-record-play]').forEach(button => {
        button.disabled = !armed || this.playingScript || !!this.editing;
      });
      this.host.querySelectorAll('[data-record-delete]').forEach(button => {
        button.disabled = !state || this.playingScript || !!this.editing;
      });
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
      for (const key of ['move', 'home', 'home-direct', 'preset-run', 'sequence-run']) this.nodes[key].disabled = !armed;
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
      if (nightOk && this.monitor === 'camera' && !this.nightLoaded && !this.nightLoading) this.nightGet();
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
      this.loadPose(result.pose, result.xyz);
      if (this.addRecordStep(result.pose)) this.message('Pose ' + this.recording.steps.length + ' enregistrée.');
    }

    // The live dot is the drag handle. The orange ghost follows the pointer at frame
    // rate, while one throttled measured step at a time follows the latest target.
    plotDragStart(event) {
      if (event.button !== 0 || !event.isPrimary) return;
      if (!this.active || this.monitor !== 'position' || this.pending || this.playingScript || this.state?.moving) return;
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
      this.loadPose(result.pose, result.xyz);
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
      this.schedule(0);
      const limit = Math.max(1, Number(this.state?.config.step_limit || 5) - .5);
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
      }
      throw new Error('Le bras n’a pas atteint la pose demandée.');
    }

    async settleIdle(ms = 20000) {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        if (!this.active || !this.lease || (this.state && !this.state.armed)) return false;
        if (!this.pending && !(this.state?.moving && !this.state?.blend) && this.state?.ticket) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
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
    beginHoming(label = 'Retour au neutre') {
      this.homingView = {
        label,
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
        const total = Math.max(...axisKeys.map(key => Math.abs(view.start[key] - HOME_POSE[key])));
        const left = Math.max(...axisKeys.map(key => Math.abs(actual[key] - HOME_POSE[key])));
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
            button.textContent = label;
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

    selectMonitor(mode) {
      this.monitor = mode;
      this.nodes['position-pane'].hidden = mode !== 'position';
      this.nodes['camera-pane'].hidden = mode !== 'camera';
      for (const button of this.host.querySelectorAll('[data-monitor]')) {
        button.setAttribute('aria-pressed', String(button.dataset.monitor === mode));
      }
      if (mode === 'position') this.drawPosition();
      this.drawCameraOverlay();
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
      const light = window.matchMedia?.('(prefers-color-scheme: light)').matches
        && !document.body.classList.contains('theme-midnight')
        && !document.body.classList.contains('theme-oled');
      const palette = light ? {
        area: '#eef6f5', border: '#9bb8b7', axis: '#6f9292',
        tick: '#476466', tickLine: 'rgba(71, 100, 102, .5)', label: '#3c5b5d',
        traceLine: 'rgba(90, 64, 175, .9)', traceDot: '#5a40af', hole: '#ffffff',
        command: '#2b63c7', commandFill: 'rgba(43, 99, 199, .12)',
        preview: '#a35a00', previewLine: 'rgba(163, 90, 0, .8)', live: '#08724f',
        ghost: 'rgba(8, 114, 79, .3)', activeFill: '#ffffff', activeHalo: 'rgba(90, 64, 175, .5)',
        zone: 'rgba(180, 35, 61, .13)', zoneBorder: 'rgba(180, 35, 61, .7)', zoneLabel: '#8e2035',
      } : {
        area: '#17373e', border: '#34656b', axis: '#34656b',
        tick: '#8fabad', tickLine: 'rgba(162, 189, 191, .55)', label: '#a2bdbf',
        traceLine: 'rgba(201, 184, 255, .9)', traceDot: '#c9b8ff', hole: '#0b171e',
        command: '#9fc5ff', commandFill: 'rgba(159, 197, 255, .14)',
        preview: '#ffc176', previewLine: 'rgba(255, 193, 118, .8)', live: '#73edce',
        ghost: 'rgba(115, 237, 206, .28)', activeFill: '#f4efff', activeHalo: 'rgba(201, 184, 255, .55)',
        zone: 'rgba(255, 140, 160, .13)', zoneBorder: 'rgba(255, 140, 160, .8)', zoneLabel: '#ffb3c0',
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
      ctx.fillStyle = palette.area;
      ctx.fillRect(x(left), y(top), (right - left) * scale, (top - bottom) * scale);
      ctx.strokeStyle = palette.border;
      ctx.strokeRect(x(left), y(top), (right - left) * scale, (top - bottom) * scale);
      ctx.strokeStyle = palette.axis;
      ctx.beginPath();
      ctx.moveTo(x(xMin), y(0));
      ctx.lineTo(x(right), y(0));
      ctx.moveTo(x(0), y(yMax));
      ctx.lineTo(x(0), y(yMin));
      ctx.stroke();
      // Millimetre graduations on the zero axes: X below, Y to the left.
      const niceStep = (span, pixels) => {
        const rough = span / Math.max(3, Math.floor(pixels / 44));
        const power = 10 ** Math.floor(Math.log10(rough || 1));
        const ratio = rough / power;
        return (ratio <= 1.5 ? 1 : ratio <= 3 ? 2 : ratio <= 7 ? 5 : 10) * power;
      };
      const xStep = niceStep(right - xMin, Math.max(40, (right - xMin) * scale));
      const yStep = niceStep(yMax - yMin, Math.max(40, (yMax - yMin) * scale));
      ctx.save();
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = palette.tick;
      ctx.strokeStyle = palette.tickLine;
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let value = Math.ceil(xMin / xStep) * xStep; value <= right + .001; value += xStep) {
        const px = x(value);
        ctx.beginPath();
        ctx.moveTo(px, y(0));
        ctx.lineTo(px, y(0) + 3);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), px, y(0) + 5);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let value = Math.ceil(yMin / yStep) * yStep; value <= yMax + .001; value += yStep) {
        const py = y(value);
        ctx.beginPath();
        ctx.moveTo(x(0) - 3, py);
        ctx.lineTo(x(0), py);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), x(0) - 5, py);
      }
      ctx.restore();
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillStyle = palette.label;
      ctx.fillText('X', x(right) + 5, y(0) + 4);
      ctx.fillText('Y', x(0) - 11, y(yMax) + 3);
      for (const zone of this.state?.config.keepout || []) {
        const zx = x(zone.x[0]), zy = y(zone.y[1]);
        const zw = (zone.x[1] - zone.x[0]) * scale, zh = (zone.y[1] - zone.y[0]) * scale;
        ctx.fillStyle = palette.zone;
        ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = palette.zoneBorder;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(zx, zy, zw, zh);
        ctx.setLineDash([]);
        ctx.fillStyle = palette.zoneLabel;
        ctx.font = '600 9px ui-monospace, monospace';
        ctx.fillText(zone.name, zx + 3, zy + 10);
      }
      const ghosts = this.ghostLibrary ? this.libraryTraces : [];
      this.nodes['plot-ghosts'].hidden = !ghosts.length;
      if (ghosts.length) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.2;
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
          ctx.beginPath();
          trace.forEach((point, index) => index
            ? ctx.lineTo(x(point.x), y(point.y)) : ctx.moveTo(x(point.x), y(point.y)));
          ctx.strokeStyle = palette.traceLine;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        trace.forEach((point, index) => {
          ctx.beginPath();
          ctx.arc(x(point.x), y(point.y), index ? 3 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = index ? palette.traceDot : palette.hole;
          ctx.strokeStyle = palette.traceDot;
          ctx.lineWidth = 1.6;
          ctx.fill();
          ctx.stroke();
        });
      }
      this.nodes['plot-trace'].hidden = !trace.length;
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
      for (const [point, color] of [[this.previewPoint, palette.preview], [this.state.feedback?.xyz, palette.live]]) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
        ctx.beginPath();
        ctx.arc(x(point.x), y(point.y), 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
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
        const state = await this.request('status');
        if (generation === this.motionGeneration) this.render(state);
      } finally {
        this.arming = false;
        this.controls();
        this.schedule(0);
      }
    }

    release() {
      this.cancelPlotDrag();
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

    async move(target, jogButton, fromScript = false) {
      if (!this.lease || !this.state?.ticket || this.pending || (this.state.moving && !this.state.blend) ||
          document.hidden || !document.hasFocus() || (this.playingScript && !fromScript)) return false;
      const generation = this.motionGeneration;
      // A drag step keeps its orange waypoint while the live dot advances.
      if (!this.plotDrag?.moved) this.clearPreview();
      this.pending = true;
      this.controls();
      try {
        const next = await this.request('move', { ...target, lease: this.lease,
          ticket: this.state.ticket, speed: this.nodes.speed.valueAsNumber });
        this.leaseDeadline = performance.now() + LEASE_MS;
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
      } catch (error) {
        this.nightLoaded = true;  // Do not retry in a loop; the buttons still work.
        this.message(error.message, true);
      } finally { this.nightLoading = false; }
    }

    async nightSet(mode) {
      if (this.nightLoading) return;
      this.nightLoading = true;
      try { this.showNight((await this.request('camera/night', { mode })).mode); }
      catch (error) { this.message(error.message, true); }
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
      const home = HOME_POSE;
      if (this.state?.config.mode !== 'hardware') {
        this.homing = true;
        this.beginHoming('Retour au neutre');
        try { return await this.move({ kind: 'home' }); }
        finally { this.homing = false; this.finishHoming(); }
      }
      const generation = this.motionGeneration;
      this.telemetryEnabled = true;  // arrival is confirmed from measured telemetry
      this.schedule(0);
      const alive = () => generation === this.motionGeneration && !!this.lease && this.active;
      this.homing = true;
      this.beginHoming('Retour au neutre');
      const settle = async () => {
        const deadline = performance.now() + 15000;
        while (alive() && (this.pending || (this.state?.moving && !this.state?.blend) || !this.state?.ticket)) {
          if (performance.now() > deadline) throw new Error('Le bras n’a pas confirmé le mouvement.');
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        return alive();
      };
      // HQ picks each sub-step: bounded by the step limit and shrunk near the workspace edge,
      // so a far-out pose needs many small steps. The page just repeats until the gap closes.
      try {
        for (let step = 0; step < 120; step++) {
          if (!await settle()) return;
          if (!this.state.feedback?.actual) throw new Error('Retour du bras indisponible.');
          if (!await this.moveSteady({ kind: 'home' })) return;
          if (!await settle()) return;
          const progress = this.state?.script;
          if (progress?.index === 'home' && progress.gap <= 0.25) break;
          if (step === 119) throw new Error('Le bras n’atteint pas le neutre. Utilisez la page du bras ou la coupure physique.');
        }
        if (await settle()) {
          this.loadPose(this.state.feedback?.actual || home, this.state.feedback?.xyz);
          this.message('Position neutre atteinte.');
        }
      } finally {
        this.homing = false;
        this.finishHoming();
      }
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
          this.loadPose(this.state.feedback.actual, this.state.feedback.xyz);
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

    jogPress(button, identity) {
      if (this.jog || button.disabled || !this.lease) return;
      button.classList.add('is-pressed');
      this.jog = { button, identity };
    }

    jogRelease(button, identity, accepted) {
      button.classList.remove('is-pressed');
      if (this.jog?.button !== button || this.jog.identity !== identity) return;
      this.jog = null;
      if (!accepted || button.disabled) return;
      this.run(async () => {
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
        await this.move(target, button);
      });
    }

    fillSettings(config) {
      const form = this.nodes.settings.elements;
      for (const key of ['mode', 'transport', 'arm_ip', 'arm_timeout', 'camera_ip', 'camera_timeout', 'quality',
        'serial_port', 'speed', 'acceleration', 'step_limit', 'load_warn', 'load_critical', 'estop_ip', 'estop_port']) form[key].value = config[key];
      form.camera_required.checked = config.camera_required !== false;
      form.estop_required.checked = config.estop_required === true;
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
      for (const key of ['mode', 'transport', 'arm_ip', 'camera_ip', 'quality', 'serial_port', 'estop_ip']) data[key] = form[key].value;
      for (const key of ['arm_timeout', 'camera_timeout', 'speed', 'acceleration', 'step_limit', 'load_warn', 'load_critical', 'estop_port']) data[key] = form[key].valueAsNumber;
      data.keepout = this.readKeepout();
      data.camera_required = form.camera_required.checked;
      data.estop_required = form.estop_required.checked;
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
        remove.textContent = '✕';
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
      const palette = light ? { line: '#2b63c7', warn: '#a35a00', critical: '#b4233d', grid: '#c9dcdb' }
        : { line: '#73edce', warn: '#ffc176', critical: '#ff8ca0', grid: '#24454d' };
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
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        this.loadTrend.forEach((sample, index) => {
          const x = index / Math.max(1, this.loadTrend.length - 1) * rect.width;
          const y = rect.height - Math.min(1, sample / LOAD_FULL_SCALE) * rect.height;
          index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
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
          button.textContent = glyph;
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
        const deadline = performance.now() + (hardware ? 20000 : 30000);
        while (active() && ((needTicket && !this.state?.ticket) || (this.state?.moving && !this.state?.blend) || this.pending)) {
          if (performance.now() > deadline) throw new Error(unconfirmed);
          await wait(60);
        }
        return !!active();
      };
      try {
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
            const progress = this.state?.script;
            if (progress?.index === index && progress.gap <= 0.25) break;
            if (sub === 59) throw new Error('Le bras n’atteint pas l’étape du script.');
          }
        }
        if (!await idle(false)) return false;
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
      if (!visible) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(rect.width * ratio);
      const height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const map = this.cameraMap.map;
      const project = (x, y) => ({ x: map.a * x + map.b * y + map.c,
        y: map.d * x + map.e * y + map.f });
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
      const points = [
        { point: targetXy(this.state?.target), color: '#9fc5ff', label: 'Cible' },
        { point: this.previewPoint, color: '#ffc176', label: 'Aperçu' },
        { point: this.state?.feedback?.xyz, color: '#73edce', label: 'Bras' },
      ];
      for (const item of points) {
        if (!Number.isFinite(item.point?.x) || !Number.isFinite(item.point?.y)) continue;
        const pixel = project(item.point.x, item.point.y);
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
      this.videoNote('Flux interrompu');
      this.message('Le direct ne fournit plus d’images.', true);
      if (!stream.retry) this.retryTimer = setTimeout(() => this.startVideo(1), 1500);
    }

    stopVideo() {
      clearTimeout(this.retryTimer);
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

    bind() {
      const on = (name, fn) => this.nodes[name].addEventListener('click', () => this.run(fn));
      on('open-assistant', () => this.mountAssistant(true));
      on('open-settings', () => this.openSettings());
      on('camera-setup', () => this.openSettings());
      this.host.querySelectorAll('[data-monitor]').forEach(button => {
        button.addEventListener('click', () => {
          this.monitorChosen = true;
          const mode = button.dataset.monitor;
          // A hardware post that is armed keeps its live feed when the plot is shown: the camera
          // is required to move, and recording needs the plan while the stream stays up.
          if (mode === 'position' && !(this.state?.config.mode === 'hardware' && this.lease)) this.stopVideo();
          this.selectMonitor(mode);
        });
      });
      this.host.querySelectorAll('[data-mode]').forEach(button =>
        button.addEventListener('click', () => this.selectMode(button.dataset.mode)));
      this.host.querySelectorAll('[data-go-section]').forEach(button =>
        button.addEventListener('click', () => {
          const section = this.host.querySelector(`[data-section="${button.dataset.goSection}"]`);
          const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          section?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
        }));
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
          if (this.jog?.button === button) this.jog = null;
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
        slider.addEventListener('input', () => { input.value = slider.value; this.clearPreview(); });
        input.addEventListener('input', () => {
          if (Number.isFinite(input.valueAsNumber)) slider.value = input.value;
        });
      }
      this.nodes.settings.addEventListener('submit', event => { event.preventDefault(); this.run(() => this.saveSettings()); });
      on('forget-camera', async () => {
        if (!this.askConfirm('forget-camera', this.nodes['forget-camera'], 'Confirmer : effacer le compte',
          'Cliquez de nouveau pour effacer le compte Tapo enregistré.')) return;
        return this.saveSettings(true);
      });
      on('arm', () => this.arm());
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
      on('probe', async () => {
        this.render(await this.request('telemetry', { lease: this.lease }));
        this.telemetryEnabled = true;
        this.schedule(700);
      });
      on('preview', () => this.preview(this.target()));
      on('home', () => this.goHome());
      on('home-direct', () => this.goHomeDirect());
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
        if (!this.calibrating) return;
        const rect = this.nodes.video.getBoundingClientRect();
        const key = this.calibrating;
        this.calPixels[key] = { u: event.clientX - rect.left, v: event.clientY - rect.top };
        this.calibrating = null;
        const output = this.host.querySelector(`[data-cal-pixel="${key}"]`);
        if (output) output.textContent = Math.round(this.calPixels[key].u) + ', ' + Math.round(this.calPixels[key].v);
        this.message('Point ' + key.toUpperCase() + ' pris. Saisissez ses coordonnées robot.');
      });
      this.host.querySelectorAll('[data-cal-capture]').forEach(button =>
        button.addEventListener('click', () => this.run(() => this.captureCalPoint(button.dataset.calCapture))));
      this.host.querySelector('[data-cal-save]').addEventListener('click', () => this.run(() => this.saveCameraMap()));
      this.host.querySelector('[data-cal-clear]').addEventListener('click', () => this.clearCameraMap());
      this.host.querySelector('[data-cal-show]').addEventListener('change', () => this.drawCameraOverlay());
      on('ptz-preset-refresh', () => this.loadPtzPresets());
      on('ptz-preset-goto', () => this.gotoPtzPreset());
      on('ptz-preset-save', () => this.savePtzPreset());
      this.nodes['ptz-preset-list'].addEventListener('change', () => this.controls());
      this.nodes['ptz-preset-name'].addEventListener('input', () => this.controls());
      this.host.querySelectorAll('[data-night]').forEach(button =>
        button.addEventListener('click', () => this.nightSet(button.dataset.night)));
      on('video-start', () => this.startVideo());
      on('video-stop', () => this.stopVideo());
      on('listen', () => this.toggleAudio('listen'));
      on('talk', () => this.toggleAudio('talk'));
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
