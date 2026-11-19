(() => {
  'use strict';

  // Lazy-loaded Flight Recorder ("Journal noir 3D") helpers for HqRobotics.
  window.HqRoboticsTools = {
    attach(lab, helpers) {
      const { axisKeys, axes, format, loadFullScale } = helpers;

      return {
        async loadFlight() {
          const result = await lab.request('blackbox');
          lab.flightEntries = Array.isArray(result.entries) ? result.entries : [];
          lab.flightIndex = lab.flightEntries.length ? lab.flightEntries.length - 1 : -1;
          const scrub = lab.nodes['flight-scrub'];
          if (scrub) {
            scrub.min = '0';
            scrub.max = String(Math.max(0, lab.flightEntries.length - 1));
            scrub.value = String(Math.max(0, lab.flightIndex));
            scrub.disabled = !lab.flightEntries.length;
          }
          if (lab.nodes['flight-count']) {
            lab.nodes['flight-count'].textContent = lab.flightEntries.length + ' / ' + (result.capacity || 360) + ' éch.';
          }
          this.renderFlight();
        },

        flightEntry() {
          return lab.flightOpen && lab.flightIndex >= 0 ? lab.flightEntries[lab.flightIndex] || null : null;
        },

        renderFlight() {
          if (!lab.flightOpen) return;
          const entry = this.flightEntry();
          const set = (key, val) => { if (lab.nodes[key]) lab.nodes[key].textContent = val; };
          if (!entry) {
            set('flight-meta', 'Aucun échantillon chargé.');
            set('flight-time', 'Aucun échantillon');
            set('flight-pose', '—');
            set('flight-load', '—');
            set('flight-flags', '—');
            if (lab.nodes['flight-apply']) lab.nodes['flight-apply'].disabled = true;
            if (lab.nodes['flight-play']) lab.nodes['flight-play'].disabled = true;
          } else {
            const at = entry.at ? new Date(entry.at * 1000).toLocaleTimeString() : '—';
            const timeText = `${at} · #${lab.flightIndex + 1}/${lab.flightEntries.length}`;
            const pose = entry.actual || entry.target;
            const poseText = pose ? axisKeys.map(k => axes[k][0] + ' ' + format(pose[k], '°')).join(' · ') : '—';
            const loads = Object.values(entry.load || {}).filter(Number.isFinite).map(v => Math.abs(v));
            const maxLoad = loads.length ? Math.round(Math.max(...loads)) : null;
            const extras = [
              maxLoad != null ? `Charge ${maxLoad}` : '',
              Number.isFinite(entry.latency_ms) ? `${Math.round(entry.latency_ms)} ms` : '',
              Number.isFinite(entry.voltage) ? `${entry.voltage.toFixed(1)} V` : '',
            ].filter(Boolean).join(' · ');
            const flags = [
              entry.mode === 'hardware' ? 'Matériel' : 'Simulation',
              entry.armed ? 'Armé' : 'Désarmé',
              entry.moving ? 'En mouvement' : '',
              entry.stop_latched ? 'STOP verrouillé' : '',
              entry.uncertain ? 'Incertain' : '',
              entry.incident ? `Incident : ${entry.incident}` : '',
            ].filter(Boolean).join(' · ');
            set('flight-meta', [timeText, poseText, extras, flags].filter(Boolean).join(' | '));
            set('flight-time', timeText);
            set('flight-pose', poseText);
            set('flight-load', extras || '—');
            set('flight-flags', flags || '—');
            if (lab.nodes['flight-apply']) lab.nodes['flight-apply'].disabled = !pose;
            if (lab.nodes['flight-play']) lab.nodes['flight-play'].disabled = lab.flightEntries.length < 2;
          }
          const canvas = lab.nodes['flight-chart'];
          if (canvas && canvas.offsetParent !== null) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width && rect.height) {
              const ratio = Math.min(2, window.devicePixelRatio || 1);
              const w = Math.round(rect.width * ratio), h = Math.round(rect.height * ratio);
              if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
                ctx.clearRect(0, 0, rect.width, rect.height);
                ctx.fillStyle = 'rgba(7, 17, 22, .65)';
                ctx.fillRect(0, 0, rect.width, rect.height);
                const entries = lab.flightEntries;
                if (entries.length > 1) {
                  const pts = entries.map((item, idx) => {
                    const l = Object.values(item.load || {}).filter(Number.isFinite).map(v => Math.abs(v));
                    const peak = l.length ? Math.max(...l) : 0;
                    return [
                      idx / (entries.length - 1) * rect.width,
                      rect.height - 4 - Math.min(1, peak / loadFullScale) * (rect.height - 8),
                      !!(item.stop_latched || item.uncertain),
                    ];
                  });
                  ctx.fillStyle = 'rgba(115, 237, 206, .18)';
                  ctx.beginPath();
                  ctx.moveTo(pts[0][0], rect.height);
                  pts.forEach(([px, py]) => ctx.lineTo(px, py));
                  ctx.lineTo(pts.at(-1)[0], rect.height);
                  ctx.closePath();
                  ctx.fill();
                  ctx.strokeStyle = '#73edce';
                  ctx.lineWidth = 1.6;
                  ctx.beginPath();
                  pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
                  ctx.stroke();
                  pts.forEach(([px, py, bad]) => {
                    if (!bad) return;
                    ctx.fillStyle = '#ff7891';
                    ctx.fillRect(px - 1, 0, 2, rect.height);
                  });
                  const cur = pts[lab.flightIndex];
                  if (cur) {
                    ctx.strokeStyle = '#ffc176';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(cur[0], 0);
                    ctx.lineTo(cur[0], rect.height);
                    ctx.stroke();
                    ctx.fillStyle = '#ffc176';
                    ctx.beginPath();
                    ctx.arc(cur[0], cur[1], 3.5, 0, Math.PI * 2);
                    ctx.fill();
                  }
                }
              }
            }
          }
          lab.updateSpace();
          if (entry) {
            lab.drawSide(entry.actual || lab.state?.feedback?.actual, entry.target || lab.fieldPose());
          }
        },

        toggleFlightPlay() {
          if (lab.flightPlaying) { this.stopFlightPlay(); return; }
          if (lab.flightEntries.length < 2) return;
          if (lab.flightIndex >= lab.flightEntries.length - 1) lab.flightIndex = 0;
          lab.flightPlaying = true;
          if (lab.nodes['flight-play']) lab.nodes['flight-play'].textContent = 'Pause';
          lab.flightTimer = setInterval(() => {
            if (!lab.active || !lab.flightOpen || lab.flightIndex >= lab.flightEntries.length - 1) {
              this.stopFlightPlay();
              return;
            }
            lab.flightIndex++;
            if (lab.nodes['flight-scrub']) lab.nodes['flight-scrub'].value = String(lab.flightIndex);
            this.renderFlight();
          }, 160);
        },

        stopFlightPlay() {
          clearInterval(lab.flightTimer);
          lab.flightTimer = null;
          lab.flightPlaying = false;
          if (lab.nodes['flight-play']) lab.nodes['flight-play'].textContent = 'Lecture';
        },

        applyFlightPose() {
          const entry = this.flightEntry();
          const pose = entry?.actual || entry?.target;
          if (!pose) return;
          lab.pilotFields(pose, entry?.xyz);
          lab.pilotAids();
          lab.controls();
          lab.message('Pose du journal noir copiée dans les champs de pilotage.');
        },
      };
    },
  };
})();
