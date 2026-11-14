/**
 * Transfert HQ — Sécurité, Télémétrie Réseau & Assistant Securia (assets/hq-security.js)
 * Standalone, lightweight, pure standard-library client module.
 */
(function () {
  'use strict';

  var win = window;
  var doc = document;
  var PANEL_ID = 'hq-security-panel';
  var POLL_INTERVAL_MS = 3000;

  var state = {
    active: false,
    timer: null,
    data: null,
    currentTab: 'traffic', // 'traffic' | 'events' | 'sessions'
    inFlight: false,
  };

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function notify(msg, isErr) {
    if (typeof win.toast === 'function') {
      win.toast(msg, isErr ? 'err' : 'ok');
    } else {
      alert(msg);
    }
  }

  async function api(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.cache = 'no-store';
    var res = await fetch(url, opts);
    var body = {};
    try {
      body = await res.json();
    } catch (_) {}
    if (!res.ok) {
      throw new Error(body.error || 'Erreur HTTP ' + res.status);
    }
    return body;
  }

  function getPanel() {
    return doc.getElementById(PANEL_ID);
  }

  // --- Securia Analytical Diagnostics Engine ---
  function computeSecuriaAssessment(data) {
    if (!data || !data.traffic) {
      return {
        badge: 'SYNCHRONISATION',
        cls: 'hq-sec-prov-localhost',
        text: 'Securia établit la télémétrie des flux réseau…',
      };
    }

    var traffic = data.traffic;
    var events = data.security_events || [];
    var s4xx = (traffic.status_counts && traffic.status_counts['4xx']) || 0;
    var s5xx = (traffic.status_counts && traffic.status_counts['5xx']) || 0;
    var total = traffic.total_requests || 0;
    var rate = traffic.requests_last_minute || 0;

    // Check for recent login failures in events
    var recentFailures = events.filter(function (e) {
      return e.event === 'auth.login.failure' || e.event === 'auth.rate_limited';
    });

    if (recentFailures.length > 0) {
      return {
        badge: 'ATTENTION REQUISE',
        cls: 'hq-sec-prov-lan',
        text: 'Securia signale ' + recentFailures.length + ' rejet(s) d\'authentification récents. Surveillez les tentatives sur le port d\'accès.',
      };
    }

    if (rate > 120) {
      return {
        badge: 'TRAFIC INTENSE',
        cls: 'hq-sec-prov-localhost',
        text: 'Débit élevé détecté (' + rate + ' req/min). Des agents automatisés ou sous-systèmes sollicitent activement les routes du pont.',
      };
    }

    if (s5xx > 0) {
      return {
        badge: 'ANOMALIE SYSTÈME',
        cls: 'hq-sec-prov-unknown',
        text: 'Securia a relevé ' + s5xx + ' erreur(s) interne(s) (5xx). Vérifiez les journaux d\'exécution des modules.',
      };
    }

    return {
      badge: 'PÉRIMÈTRE SAIN',
      cls: 'hq-sec-prov-tailscale',
      text: 'Tous les indicateurs sont au vert. Télémétrie nominale, sessions chiffrées valides et zéro anomalie d\'accès sur le pont.',
    };
  }

  // --- Rendering Functions ---

  function renderSkeleton(container) {
    container.innerHTML = '';
    var wrap = el('div', 'hq-security-container');

    // Header
    var header = el('div', 'hq-sec-header');
    var h2 = el('h2', '', '');
    h2.innerHTML = '<svg style="width:24px;height:24px;color:var(--accent,#38bdf8)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s7 3 7 9c0 5-7 9-7 9s-7-4-7-9c0-6 7-9 7-9z"/><path d="m9.5 12 1.8 1.8 3.7-3.6"/></svg> Sécurité &amp; Trafic Réseau';
    var live = el('div', 'hq-sec-live-indicator');
    live.innerHTML = '<span class="hq-sec-pulse-dot"></span> Surveillance en direct';
    header.appendChild(h2);
    header.appendChild(live);
    wrap.appendChild(header);

    // Securia Card
    var securiaCard = el('div', 'hq-securia-card');
    securiaCard.id = 'hq-securia-box';
    securiaCard.innerHTML =
      '<div class="hq-securia-avatar">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 6 4 6-4 6-4-6z"/></svg>' +
      '</div>' +
      '<div class="hq-securia-info">' +
      '<div class="hq-securia-title-row">' +
      '<span class="hq-securia-name">Securia</span>' +
      '<span class="hq-securia-chip-badge" id="hq-securia-badge">SENTINELLE IA</span>' +
      '</div>' +
      '<p class="hq-securia-status" id="hq-securia-status">Chargement de la télémétrie de sécurité…</p>' +
      '<div class="hq-securia-actions">' +
      '<button type="button" class="hq-securia-btn" id="hq-sec-btn-chat">Parler à Securia</button>' +
      '<button type="button" class="hq-securia-btn" id="hq-sec-btn-diag">Audit de cohérence</button>' +
      '<button type="button" class="hq-securia-btn" id="hq-sec-btn-flush">Purger sessions inactives</button>' +
      '</div>' +
      '</div>';
    wrap.appendChild(securiaCard);

    // KPI Grid
    var kpis = el('div', 'hq-sec-kpis');
    kpis.id = 'hq-sec-kpi-grid';
    kpis.innerHTML =
      '<div class="hq-sec-kpi"><span class="hq-sec-kpi-label">Débit Actuel</span><span class="hq-sec-kpi-val" id="kpi-rate">-</span><span class="hq-sec-kpi-sub">requêtes / minute</span></div>' +
      '<div class="hq-sec-kpi"><span class="hq-sec-kpi-label">Total Requêtes</span><span class="hq-sec-kpi-val" id="kpi-total">-</span><span class="hq-sec-kpi-sub">session active</span></div>' +
      '<div class="hq-sec-kpi"><span class="hq-sec-kpi-label">Erreurs / Rejets</span><span class="hq-sec-kpi-val" id="kpi-errors">-</span><span class="hq-sec-kpi-sub">4xx / 5xx relevés</span></div>' +
      '<div class="hq-sec-kpi"><span class="hq-sec-kpi-label">Sessions &amp; Connexions</span><span class="hq-sec-kpi-val" id="kpi-sessions">-</span><span class="hq-sec-kpi-sub">utilisateurs authentifiés</span></div>';
    wrap.appendChild(kpis);

    // Interactive Tripwire Card
    var twCard = el('div', 'hq-sec-tripwire-card');
    twCard.id = 'hq-sec-tripwire-card';
    twCard.innerHTML =
      '<div class="hq-sec-tw-top">' +
        '<div class="hq-sec-tw-left">' +
          '<div class="hq-sec-tw-title-row">' +
            '<span class="hq-sec-tw-title">⚡ Tripwire Périmètre</span>' +
            '<span class="hq-sec-tw-pill" id="hq-tw-pill">CHARGEMENT</span>' +
          '</div>' +
          '<div class="hq-sec-tw-meta" id="hq-tw-meta">Synchronisation du capteur d\'intrusion…</div>' +
        '</div>' +
        '<div class="hq-sec-tw-actions">' +
          '<label class="hq-sec-tw-thresh">Seuil <input type="number" id="hq-tw-threshold" min="1" max="20" value="2"/></label>' +
          '<button type="button" class="hq-securia-btn hq-securia-btn-primary" id="hq-tw-rearm">Réarmer</button>' +
          '<button type="button" class="hq-securia-btn hq-securia-btn-secondary" id="hq-tw-toggle">Désarmer</button>' +
          '<button type="button" class="hq-securia-btn hq-sec-tw-lockbtn" id="hq-tw-lockdown">Lockdown</button>' +
        '</div>' +
      '</div>' +
      '<div class="hq-sec-tw-stage" id="hq-tw-stage" title="Glisser la poignée vers le loquet pour réarmer/armer, ou cliquer pour basculer">' +
        '<svg class="hq-sec-tw-svg" id="hq-tw-svg" viewBox="0 0 600 64" preserveAspectRatio="none">' +
          '<circle class="hq-tw-post" cx="22" cy="32" r="7"/>' +
          '<circle class="hq-tw-post" cx="578" cy="32" r="7"/>' +
          '<path class="hq-tw-wire-glow" id="hq-tw-wire-glow" d="M 22 32 Q 300 32 578 32"/>' +
          '<path class="hq-tw-wire" id="hq-tw-wire" d="M 22 32 Q 300 32 578 32"/>' +
          '<path class="hq-tw-wire-broken" id="hq-tw-wire-b1" d="M 22 32 Q 130 48 210 52" style="display:none"/>' +
          '<path class="hq-tw-wire-broken" id="hq-tw-wire-b2" d="M 578 32 Q 470 48 390 52" style="display:none"/>' +
          '<circle class="hq-tw-latch" id="hq-tw-latch" cx="578" cy="32" r="11" style="display:none"/>' +
          '<circle class="hq-tw-handle" id="hq-tw-handle" cx="210" cy="52" r="9" style="display:none"/>' +
        '</svg>' +
        '<div class="hq-sec-tw-hint" id="hq-tw-hint">Fil tendu · Périmètre sous tension</div>' +
      '</div>';
    wrap.appendChild(twCard);

    // Chart Card
    var chartCard = el('div', 'hq-sec-chart-card');
    var chartHead = el('div', 'hq-sec-chart-head');
    var chartTitle = el('h3', 'hq-sec-chart-title', 'Débit du trafic réseau (30 dernières minutes)');
    var legend = el('div', 'hq-sec-legend');
    legend.innerHTML =
      '<div class="hq-sec-legend-item"><span class="hq-sec-legend-dot c-tot"></span> Total</div>' +
      '<div class="hq-sec-legend-item"><span class="hq-sec-legend-dot c-2xx"></span> 2xx Succès</div>' +
      '<div class="hq-sec-legend-item"><span class="hq-sec-legend-dot c-4xx"></span> 4xx Rejets</div>' +
      '<div class="hq-sec-legend-item"><span class="hq-sec-legend-dot c-5xx"></span> 5xx Erreurs</div>';
    chartHead.appendChild(chartTitle);
    chartHead.appendChild(legend);
    chartCard.appendChild(chartHead);

    var canvasWrap = el('div', 'hq-sec-canvas-wrap');
    var canvas = el('canvas', 'hq-sec-canvas');
    canvas.id = 'hq-sec-chart-canvas';
    canvasWrap.appendChild(canvas);
    chartCard.appendChild(canvasWrap);
    wrap.appendChild(chartCard);

    // Feed / Tables Card
    var feedCard = el('div', 'hq-sec-feed-card');
    var tabNav = el('div', 'hq-sec-tab-nav');
    tabNav.innerHTML =
      '<button type="button" class="hq-sec-tab-btn active" data-sec-tab="traffic">Trafic HTTP en direct</button>' +
      '<button type="button" class="hq-sec-tab-btn" data-sec-tab="events">Événements de Sécurité</button>' +
      '<button type="button" class="hq-sec-tab-btn" data-sec-tab="sessions">Sessions Actives</button>';
    feedCard.appendChild(tabNav);

    var tableWrap = el('div', 'hq-sec-table-wrap');
    tableWrap.id = 'hq-sec-table-content';
    feedCard.appendChild(tableWrap);
    wrap.appendChild(feedCard);

    container.appendChild(wrap);

    // Wire tab clicks
    tabNav.querySelectorAll('button[data-sec-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tabNav.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.currentTab = btn.dataset.secTab;
        updateFeedTable();
      });
    });

    // Wire Securia buttons
    var chatBtn = doc.getElementById('hq-sec-btn-chat');
    if (chatBtn) {
      chatBtn.addEventListener('click', function () {
        if (typeof win.hqSecuriaOpen === 'function') {
          win.hqSecuriaOpen();
        } else {
          notify('Le module flottant Securia n\'est pas encore chargé.', true);
        }
      });
    }

    var diagBtn = doc.getElementById('hq-sec-btn-diag');
    if (diagBtn) {
      diagBtn.addEventListener('click', async function () {
        diagBtn.textContent = 'Analyse en cours…';
        try {
          var rep = await api('/api/diag/live');
          notify('Securia : Pont actif (PID ' + (rep.pid || '?') + ') · Télémétrie opérationnelle.', false);
        } catch (e) {
          notify('Erreur audit Securia : ' + e.message, true);
        } finally {
          diagBtn.textContent = 'Audit de cohérence';
        }
      });
    }

    var flushBtn = doc.getElementById('hq-sec-btn-flush');
    if (flushBtn) {
      flushBtn.addEventListener('click', function () {
        notify('Securia : Vérification des baux de sessions…', false);
      });
    }

    async function sendTripwireAction(action, extra) {
      var headers = { 'Content-Type': 'application/json' };
      if (typeof win.hqCsrfToken === 'function') {
        var tok = win.hqCsrfToken();
        if (tok) headers['X-CSRF-Token'] = tok;
      }
      var thrEl = doc.getElementById('hq-tw-threshold');
      var thr = thrEl ? Math.max(1, Math.min(20, parseInt(thrEl.value || '2', 10) || 2)) : 2;
      var payload = Object.assign({ action: action, threshold: thr }, extra || {});
      try {
        var res = await api('/api/security/tripwire', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
        });
        if (res.tripwire) {
          if (!state.data) state.data = {};
          state.data.tripwire = res.tripwire;
          updateTripwireUI(res.tripwire);
        }
        notify(res.message || 'Tripwire mis à jour.', false);
      } catch (e) {
        notify('Tripwire : ' + e.message, true);
      }
    }

    var twRearm = doc.getElementById('hq-tw-rearm');
    if (twRearm) {
      twRearm.addEventListener('click', function () {
        var tw = (state.data && state.data.tripwire) || {};
        sendTripwireAction('rearm', { release_lockdown: !!tw.locked_down });
      });
    }
    var twToggle = doc.getElementById('hq-tw-toggle');
    if (twToggle) {
      twToggle.addEventListener('click', function () {
        var tw = (state.data && state.data.tripwire) || {};
        sendTripwireAction(tw.enabled ? 'disarm' : 'arm');
      });
    }
    var twLock = doc.getElementById('hq-tw-lockdown');
    if (twLock) {
      twLock.addEventListener('click', function () {
        var tw = (state.data && state.data.tripwire) || {};
        if (tw.locked_down) {
          sendTripwireAction('unlock_lockdown', { release_lockdown: true });
        } else if (win.confirm('Activer le Lockdown d\'urgence sur Transfert HQ ?')) {
          sendTripwireAction('lockdown');
        }
      });
    }

    // Interactive physical-style SVG Tripwire stage
    var stage = doc.getElementById('hq-tw-stage');
    var svgEl = doc.getElementById('hq-tw-svg');
    var wireEl = doc.getElementById('hq-tw-wire');
    var wireGlow = doc.getElementById('hq-tw-wire-glow');
    var broken1 = doc.getElementById('hq-tw-wire-b1');
    var broken2 = doc.getElementById('hq-tw-wire-b2');
    var handleEl = doc.getElementById('hq-tw-handle');
    var latchEl = doc.getElementById('hq-tw-latch');
    var twDragging = false;
    var twMoved = false;

    function svgCoords(ev) {
      if (!svgEl) return { x: 300, y: 32 };
      var r = svgEl.getBoundingClientRect();
      var x = ((ev.clientX - r.left) / Math.max(1, r.width)) * 600;
      var y = ((ev.clientY - r.top) / Math.max(1, r.height)) * 64;
      return { x: Math.max(22, Math.min(578, x)), y: Math.max(8, Math.min(58, y)) };
    }

    if (stage && svgEl) {
      stage.addEventListener('pointerdown', function (ev) {
        var tw = (state.data && state.data.tripwire) || {};
        var st = tw.state || (tw.enabled ? 'armed' : 'disarmed');
        twDragging = true;
        twMoved = false;
        stage.setPointerCapture(ev.pointerId);
        if (st === 'armed') {
          var pt = svgCoords(ev);
          var d = 'M 22 32 Q ' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ' 578 32';
          if (wireEl) wireEl.setAttribute('d', d);
          if (wireGlow) wireGlow.setAttribute('d', d);
        }
      });

      stage.addEventListener('pointermove', function (ev) {
        var tw = (state.data && state.data.tripwire) || {};
        var st = tw.state || (tw.enabled ? 'armed' : 'disarmed');
        var pt = svgCoords(ev);
        if (twDragging) {
          twMoved = true;
          if (st === 'armed') {
            var d = 'M 22 32 Q ' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ' 578 32';
            if (wireEl) wireEl.setAttribute('d', d);
            if (wireGlow) wireGlow.setAttribute('d', d);
          } else {
            // Dragging broken handle toward right latch (578, 32)
            if (handleEl) {
              handleEl.setAttribute('cx', pt.x.toFixed(1));
              handleEl.setAttribute('cy', pt.y.toFixed(1));
            }
            if (broken1) {
              var mx = (22 + pt.x) / 2;
              var my = Math.min(56, (32 + pt.y) / 2 + 6);
              broken1.setAttribute('d', 'M 22 32 Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1));
            }
            if (latchEl) {
              latchEl.classList.toggle('is-near', Math.hypot(578 - pt.x, 32 - pt.y) < 42);
            }
          }
        } else if (st === 'armed') {
          // Subtle elastic hover flex
          var bendY = 32 + (pt.y - 32) * 0.25;
          var dh = 'M 22 32 Q ' + pt.x.toFixed(1) + ' ' + bendY.toFixed(1) + ' 578 32';
          if (wireEl) wireEl.setAttribute('d', dh);
          if (wireGlow) wireGlow.setAttribute('d', dh);
        }
      });

      stage.addEventListener('pointerleave', function () {
        var tw = (state.data && state.data.tripwire) || {};
        if (!twDragging && (tw.state || 'armed') === 'armed') {
          if (wireEl) wireEl.setAttribute('d', 'M 22 32 Q 300 32 578 32');
          if (wireGlow) wireGlow.setAttribute('d', 'M 22 32 Q 300 32 578 32');
        }
      });

      function endWireDrag(ev) {
        if (!twDragging) return;
        twDragging = false;
        var tw = (state.data && state.data.tripwire) || {};
        var st = tw.state || (tw.enabled ? 'armed' : 'disarmed');
        var pt = svgCoords(ev);
        if (latchEl) latchEl.classList.remove('is-near');

        if (!twMoved) {
          // Simple click toggles or rearms
          if (st === 'tripped' || st === 'lockdown' || st === 'disarmed') {
            sendTripwireAction('rearm', { release_lockdown: !!tw.locked_down });
          } else {
            sendTripwireAction('disarm');
          }
          return;
        }

        if (st === 'armed') {
          // Pulling the armed wire past the snap zone disarms or snaps it
          if (Math.abs(pt.y - 32) > 20) {
            sendTripwireAction('disarm');
          } else {
            if (wireEl) wireEl.setAttribute('d', 'M 22 32 Q 300 32 578 32');
            if (wireGlow) wireGlow.setAttribute('d', 'M 22 32 Q 300 32 578 32');
          }
        } else {
          // If dragged near the right latch (578, 32), snap & rearm!
          if (Math.hypot(578 - pt.x, 32 - pt.y) < 55) {
            sendTripwireAction('rearm', { release_lockdown: !!tw.locked_down });
          } else {
            updateTripwireUI(tw);
          }
        }
      }
      stage.addEventListener('pointerup', endWireDrag);
      stage.addEventListener('pointercancel', endWireDrag);
    }
  }

  function updateTripwireUI(tw) {
    if (!tw) return;
    var pill = doc.getElementById('hq-tw-pill');
    var meta = doc.getElementById('hq-tw-meta');
    var thrEl = doc.getElementById('hq-tw-threshold');
    var toggleBtn = doc.getElementById('hq-tw-toggle');
    var lockBtn = doc.getElementById('hq-tw-lockdown');
    var rearmBtn = doc.getElementById('hq-tw-rearm');
    var stage = doc.getElementById('hq-tw-stage');
    var wireEl = doc.getElementById('hq-tw-wire');
    var wireGlow = doc.getElementById('hq-tw-wire-glow');
    var broken1 = doc.getElementById('hq-tw-wire-b1');
    var broken2 = doc.getElementById('hq-tw-wire-b2');
    var handleEl = doc.getElementById('hq-tw-handle');
    var latchEl = doc.getElementById('hq-tw-latch');
    var hintEl = doc.getElementById('hq-tw-hint');

    var st = tw.state || (tw.enabled ? 'armed' : 'disarmed');
    var labels = {
      armed: 'ARMÉ',
      tripped: 'DÉCLENCHÉ',
      lockdown: 'LOCKDOWN',
      disarmed: 'DÉSARMÉ',
    };
    if (pill) {
      pill.textContent = labels[st] || st.toUpperCase();
      pill.className = 'hq-sec-tw-pill is-' + st;
    }
    if (stage) {
      stage.className = 'hq-sec-tw-stage is-' + st;
    }
    var isBroken = (st === 'tripped' || st === 'lockdown' || st === 'disarmed');
    if (wireEl) {
      wireEl.style.display = isBroken ? 'none' : '';
      wireEl.setAttribute('d', 'M 22 32 Q 300 32 578 32');
    }
    if (wireGlow) {
      wireGlow.style.display = isBroken ? 'none' : '';
      wireGlow.setAttribute('d', 'M 22 32 Q 300 32 578 32');
    }
    if (broken1) {
      broken1.style.display = isBroken ? '' : 'none';
      broken1.setAttribute('d', st === 'disarmed' ? 'M 22 32 Q 160 52 290 50' : 'M 22 32 Q 130 48 210 52');
    }
    if (broken2) {
      broken2.style.display = (st === 'tripped' || st === 'lockdown') ? '' : 'none';
      broken2.setAttribute('d', 'M 578 32 Q 470 48 390 52');
    }
    if (handleEl) {
      handleEl.style.display = isBroken ? '' : 'none';
      handleEl.setAttribute('cx', st === 'disarmed' ? '290' : '210');
      handleEl.setAttribute('cy', st === 'disarmed' ? '50' : '52');
    }
    if (latchEl) {
      latchEl.style.display = isBroken ? '' : 'none';
    }
    if (hintEl) {
      if (st === 'armed') hintEl.textContent = 'Fil laser tendu · Tire vers le bas ou clique pour désarmer';
      else if (st === 'tripped') hintEl.textContent = 'Fil rompu ! Glisse la poignée vers le loquet droit (ou clique) pour réarmer';
      else if (st === 'lockdown') hintEl.textContent = 'LOCKDOWN ACTIF ! Glisse la poignée vers le loquet pour réarmer + débloquer';
      else hintEl.textContent = 'Fil détendu · Glisse la poignée vers le loquet droit (ou clique) pour armer';
    }
    if (meta) {
      var fails = tw.recent_failures || 0;
      var thr = tw.failed_threshold || 2;
      var cd = tw.cooldown_remaining_sec || 0;
      meta.textContent =
        'Échecs fenêtre : ' + fails + ' / ' + thr +
        (cd > 0 ? ' · Cooldown : ' + cd + 's' : ' · Prêt') +
        (tw.recipient_email ? ' · Alerte : ' + tw.recipient_email : '');
    }
    if (thrEl && doc.activeElement !== thrEl && tw.failed_threshold) {
      thrEl.value = String(tw.failed_threshold);
    }
    if (toggleBtn) {
      toggleBtn.textContent = tw.enabled ? 'Désarmer' : 'Armer';
    }
    if (rearmBtn) {
      rearmBtn.textContent = tw.locked_down ? 'Réarmer + Débloquer' : 'Réarmer';
    }
    if (lockBtn) {
      lockBtn.textContent = tw.locked_down ? 'Lever Lockdown' : 'Lockdown';
      lockBtn.classList.toggle('is-active', !!tw.locked_down);
    }
  }

  function updateKPIs(data) {
    var traffic = data.traffic || {};
    var rate = traffic.requests_last_minute || 0;
    var total = traffic.total_requests || 0;
    var status = traffic.status_counts || {};
    var errs = (status['4xx'] || 0) + (status['5xx'] || 0);
    var sessions = data.active_sessions ? data.active_sessions.length : 0;

    var elRate = doc.getElementById('kpi-rate');
    var elTotal = doc.getElementById('kpi-total');
    var elErrors = doc.getElementById('kpi-errors');
    var elSessions = doc.getElementById('kpi-sessions');

    if (elRate) elRate.textContent = rate;
    if (elTotal) elTotal.textContent = total.toLocaleString();
    if (elErrors) elErrors.textContent = errs;
    if (elSessions) elSessions.textContent = sessions;

    // Securia Card update
    var secInfo = computeSecuriaAssessment(data);
    var elBadge = doc.getElementById('hq-securia-badge');
    var elStatus = doc.getElementById('hq-securia-status');
    if (elBadge) {
      elBadge.textContent = secInfo.badge;
      elBadge.className = 'hq-securia-chip-badge ' + secInfo.cls;
    }
    if (elStatus) elStatus.textContent = secInfo.text;
    if (data.tripwire) updateTripwireUI(data.tripwire);
  }

  function drawTrafficChart(timeline) {
    var canvas = doc.getElementById('hq-sec-chart-canvas');
    if (!canvas || !timeline || !timeline.length) return;

    var rect = canvas.getBoundingClientRect();
    var dpr = win.devicePixelRatio || 1;
    var w = rect.width;
    var h = rect.height || 140;

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    var padLeft = 30, padRight = 10, padTop = 15, padBottom = 25;
    var plotW = w - padLeft - padRight;
    var plotH = h - padTop - padBottom;

    // Max calculation
    var maxVal = 5;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].total > maxVal) maxVal = timeline[i].total;
    }
    maxVal = Math.ceil(maxVal * 1.15);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';

    for (var step = 0; step <= 3; step++) {
      var yVal = Math.round((maxVal / 3) * step);
      var y = padTop + plotH - (plotH * (yVal / maxVal));
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      ctx.fillText(String(yVal), 4, y + 3);
    }

    var n = timeline.length;
    var colW = Math.max(2, (plotW / n) - 2);

    // Draw bars
    for (var idx = 0; idx < n; idx++) {
      var pt = timeline[idx];
      var x = padLeft + (idx * (plotW / n)) + 1;

      var totH = (pt.total / maxVal) * plotH;
      var s2xxH = (pt['2xx'] / maxVal) * plotH;
      var s4xxH = (pt['4xx'] / maxVal) * plotH;
      var s5xxH = (pt['5xx'] / maxVal) * plotH;

      var curY = padTop + plotH;

      // Draw 2xx (emerald)
      if (s2xxH > 0) {
        ctx.fillStyle = '#10b981';
        curY -= s2xxH;
        ctx.fillRect(x, curY, colW, s2xxH);
      }
      // Draw 4xx (amber)
      if (s4xxH > 0) {
        ctx.fillStyle = '#f59e0b';
        curY -= s4xxH;
        ctx.fillRect(x, curY, colW, s4xxH);
      }
      // Draw 5xx (red)
      if (s5xxH > 0) {
        ctx.fillStyle = '#ef4444';
        curY -= s5xxH;
        ctx.fillRect(x, curY, colW, s5xxH);
      }

      // X-axis label every 5 items
      if (idx % 6 === 0) {
        ctx.fillStyle = '#64748b';
        ctx.fillText(pt.time || '', x - 6, h - 8);
      }
    }

    // Connect tops with sleek cyan line
    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    for (var j = 0; j < n; j++) {
      var pX = padLeft + (j * (plotW / n)) + (colW / 2);
      var pY = padTop + plotH - ((timeline[j].total / maxVal) * plotH);
      if (j === 0) ctx.moveTo(pX, pY);
      else ctx.lineTo(pX, pY);
    }
    ctx.stroke();
  }

  function getProvBadge(prov) {
    var p = String(prov || 'unknown').toLowerCase();
    var label = p === 'tailscale' ? 'Tailscale' : p === 'localhost' ? 'Localhost' : p === 'lan' ? 'LAN' : 'Externe';
    return '<span class="hq-sec-badge hq-sec-prov-' + esc(p) + '">' + esc(label) + '</span>';
  }

  function getStatusBadge(code) {
    var c = parseInt(code, 10) || 200;
    var group = Math.floor(c / 100) + 'xx';
    return '<span class="hq-sec-status-' + esc(group) + '">' + esc(code) + '</span>';
  }

  function updateFeedTable() {
    var container = doc.getElementById('hq-sec-table-content');
    if (!container || !state.data) return;

    var tab = state.currentTab;

    if (tab === 'traffic') {
      var reqs = (state.data.traffic && state.data.traffic.recent_requests) || [];
      if (!reqs.length) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b">Aucun trafic HTTP enregistré récemment.</div>';
        return;
      }

      var html = '<table class="hq-sec-table"><thead><tr>' +
        '<th>Heure</th><th>Provenance</th><th>IP</th><th>Méthode</th><th>Route</th><th>Statut</th><th>Latence</th><th>Détails</th>' +
        '</tr></thead><tbody>';

      for (var i = reqs.length - 1; i >= 0; i--) {
        var r = reqs[i];
        var timeStr = (r.timestamp || '').split('T')[1] || r.timestamp || '';
        var detail = r.pin_hint ? '<span style="color:#f59e0b">Tentative PIN: ' + esc(r.pin_hint) + '</span>' : esc(r.role || 'anonyme');
        html += '<tr>' +
          '<td style="font-family:monospace;font-size:0.75rem">' + esc(timeStr) + '</td>' +
          '<td>' + getProvBadge(r.provenance) + '</td>' +
          '<td style="font-family:monospace">' + esc(r.ip) + '</td>' +
          '<td><strong style="color:var(--text)">' + esc(r.method) + '</strong></td>' +
          '<td style="font-family:monospace;color:#94a3b8">' + esc(r.path) + '</td>' +
          '<td>' + getStatusBadge(r.status) + '</td>' +
          '<td style="font-family:monospace;color:#64748b">' + esc(r.duration_ms) + ' ms</td>' +
          '<td>' + detail + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      container.innerHTML = html;

    } else if (tab === 'events') {
      var events = state.data.security_events || [];
      if (!events.length) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b">Aucun événement de sécurité critique dans l\'historique.</div>';
        return;
      }

      var html = '<table class="hq-sec-table"><thead><tr>' +
        '<th>Heure</th><th>Événement</th><th>Gravité</th><th>Provenance</th><th>Rôle</th><th>Résultat</th><th>Motif</th>' +
        '</tr></thead><tbody>';

      for (var j = events.length - 1; j >= 0; j--) {
        var e = events[j];
        var timeStr = (e.timestamp || '').split('T')[1] || e.timestamp || '';
        var sevColor = e.severity === 'critical' ? '#ef4444' : e.severity === 'warning' ? '#f59e0b' : '#38bdf8';
        html += '<tr>' +
          '<td style="font-family:monospace;font-size:0.75rem">' + esc(timeStr) + '</td>' +
          '<td><strong style="color:#f0f6fc">' + esc(e.event) + '</strong></td>' +
          '<td><span style="color:' + sevColor + ';font-weight:700;text-transform:uppercase;font-size:0.7rem">' + esc(e.severity) + '</span></td>' +
          '<td>' + getProvBadge(e.source_class) + '</td>' +
          '<td>' + esc(e.actor_role) + '</td>' +
          '<td>' + esc(e.result) + '</td>' +
          '<td style="color:#94a3b8">' + esc(e.reason || '-') + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      container.innerHTML = html;

    } else if (tab === 'sessions') {
      var sessions = state.data.active_sessions || [];
      if (!sessions.length) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b">Aucune session active enregistrée.</div>';
        return;
      }

      var html = '<table class="hq-sec-table"><thead><tr>' +
        '<th>ID Session</th><th>Utilisateur</th><th>Rôle</th><th>Créée</th><th>Dernière activité</th><th>Inactivité</th><th>Action</th>' +
        '</tr></thead><tbody>';

      for (var k = 0; k < sessions.length; k++) {
        var s = sessions[k];
        html += '<tr>' +
          '<td style="font-family:monospace">' + esc(s.id) + '</td>' +
          '<td><strong style="color:#f0f6fc">' + esc(s.user) + '</strong></td>' +
          '<td><span class="hq-sec-badge" style="background:rgba(56,189,248,0.15);color:#38bdf8">' + esc(s.role) + '</span></td>' +
          '<td>' + esc(s.created_h) + '</td>' +
          '<td>' + esc(s.last_seen_h) + '</td>' +
          '<td style="color:#64748b">' + Math.round(s.idle_sec / 60) + ' min</td>' +
          '<td><button type="button" class="hq-sec-btn-revoke" data-revoke-token="' + esc(s.token) + '">Révoquer</button></td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      container.innerHTML = html;

      // Wire revoke buttons
      container.querySelectorAll('button[data-revoke-token]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var tok = btn.dataset.revokeToken;
          if (!confirm('Voulez-vous vraiment révoquer immédiatement cette session ?')) return;
          try {
            await api('/api/security/sessions/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: tok }),
            });
            notify('Session révoquée avec succès.', false);
            fetchTelemetry();
          } catch (err) {
            notify('Erreur révocation : ' + err.message, true);
          }
        });
      });
    }
  }

  async function fetchTelemetry() {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      var data = await api('/api/security/traffic');
      state.data = data;
      updateKPIs(data);
      if (data.traffic && data.traffic.timeline) {
        drawTrafficChart(data.traffic.timeline);
      }
      updateFeedTable();
    } catch (err) {
      // If unauthorized, user isn't admin
      console.warn('[HQ-Security] Telemetry error:', err.message);
    } finally {
      state.inFlight = false;
    }
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    fetchTelemetry();
    state.timer = setInterval(fetchTelemetry, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function checkView() {
    var isSecView = doc.body.getAttribute('data-view') === 'securite';
    if (isSecView && !state.active) {
      state.active = true;
      var panel = getPanel();
      if (panel && !panel.querySelector('.hq-security-container')) {
        renderSkeleton(panel);
      }
      startPolling();
    } else if (!isSecView && state.active) {
      state.active = false;
      stopPolling();
    }
  }

  // --- Initialization ---
  function init() {
    var observer = new MutationObserver(checkView);
    observer.observe(doc.body, { attributes: true, attributeFilter: ['data-view'] });

    // Initial check
    checkView();

    // Listen to resize to redraw chart smoothly
    win.addEventListener('resize', function () {
      if (state.active && state.data && state.data.traffic && state.data.traffic.timeline) {
        drawTrafficChart(state.data.traffic.timeline);
      }
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
