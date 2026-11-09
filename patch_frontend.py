from pathlib import Path

bridge_path = Path(r"C:\Transfert\iphone_bridge.py")
content = bridge_path.read_text(encoding="utf-8")
crlf = "\r\n" in content
content = content.replace("\r\n", "\n")

# 1. Update setView to add hqDeferViewRender
old_set_view_anchor = "function setView(name) {\n  let view = VIEW_LABELS[name] ? name : 'accueil';"
defer_helper = """let viewTicket = 0;
function hqDeferViewRender(view, ticket, fn) {
  if (ticket !== viewTicket) return;
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      if (ticket !== viewTicket) return;
      try { fn(); } catch (e) { console.error(e); }
    });
  } else {
    try { fn(); } catch (e) { console.error(e); }
  }
}
"""
if "function hqDeferViewRender" not in content:
    content = content.replace(old_set_view_anchor, defer_helper + old_set_view_anchor)

old_set_view_body = """  if (view === 'fichiers') refreshFiles().catch(() => {});
  if (view === 'carnet' && window.hqCarnetShow) {
    try { window.hqCarnetShow(); } catch (e) { console.error(e); }  // a Carnet failure never aborts HQ
  } else if (view === 'carnet') {
    hqCarnetLoad().then(() => {  // loaded on demand; hqCarnetLoad shows Carnet itself when it lands
      const lazyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - viewT0);
      if (window.hqPerfMark) window.hqPerfMark('nav', { op: 'setView-lazy', target: 'carnet', ms: lazyMs, ok: !!window.hqCarnetShow }, { force: lazyMs > 400 || !window.hqCarnetShow });
      if (document.body.dataset.view === 'carnet' && !window.hqCarnetShow) {
        hqCarnetMissing();
        if (window.hqClientLog) { try { window.hqClientLog({ level: 'warn', kind: 'carnet', message: 'carnet module missing after load', force: true }); } catch (_) {} }
      }
    }).catch(() => {});
  }
  if (view === 'accueil' && window.hqCarnetHome) {
    try { window.hqCarnetHome(); } catch (e) { console.error(e); }  // admin-only summary; never aborts HQ
  }
  if (view === 'calendrier' && window.hqCalendarShow) {
    try { window.hqCalendarShow(); } catch (e) { console.error(e); }  // log as before, never abort startup
  }
  if (view === 'dessiner') hqSketchStart();
  if (view === 'projets' && window.hqProjectsShow) {
    try { window.hqProjectsShow(); } catch (e) { console.error(e); }  // a Projets failure never aborts HQ
  }
  if (view === 'inventaire' && window.hqInventoryShow) {
    try { window.hqInventoryShow(); } catch (e) { console.error(e); }  // an Inventaire failure never aborts HQ
  }"""

new_set_view_body = """  const currentViewTicket = ++viewTicket;
  if (view === 'fichiers') hqDeferViewRender(view, viewTicket, () => refreshFiles().catch(() => {}));
  if (view === 'carnet' && window.hqCarnetShow) {
    hqDeferViewRender(view, viewTicket, () => { try { window.hqCarnetShow(); } catch (e) { console.error(e); } });
  } else if (view === 'carnet') {
    hqDeferViewRender(view, viewTicket, () => {
      hqCarnetLoad().then(() => {
        const lazyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - viewT0);
        if (window.hqPerfMark) window.hqPerfMark('nav', { op: 'setView-lazy', target: 'carnet', ms: lazyMs, ok: !!window.hqCarnetShow }, { force: lazyMs > 400 || !window.hqCarnetShow });
        if (document.body.dataset.view === 'carnet' && !window.hqCarnetShow) {
          hqCarnetMissing();
          if (window.hqClientLog) { try { window.hqClientLog({ level: 'warn', kind: 'carnet', message: 'carnet module missing after load', force: true }); } catch (_) {} }
        }
      }).catch(() => {});
    });
  }
  if (view === 'accueil' && window.hqCarnetHome) {
    hqDeferViewRender(view, viewTicket, () => { try { window.hqCarnetHome(); } catch (e) { console.error(e); } });
  }
  if (view === 'calendrier' && window.hqCalendarShow) {
    hqDeferViewRender(view, viewTicket, () => { try { window.hqCalendarShow(); } catch (e) { console.error(e); } });
  }
  if (view === 'dessiner') hqDeferViewRender(view, viewTicket, () => hqSketchStart());
  if (view === 'projets' && window.hqProjectsShow) {
    hqDeferViewRender(view, viewTicket, () => { try { window.hqProjectsShow(); } catch (e) { console.error(e); } });
  }
  if (view === 'inventaire' && window.hqInventoryShow) {
    hqDeferViewRender(view, viewTicket, () => { try { window.hqInventoryShow(); } catch (e) { console.error(e); } });
  }"""

assert old_set_view_body in content, "old_set_view_body not found"
content = content.replace(old_set_view_body, new_set_view_body)

# 2. Update refreshHQ
old_refresh = """async function refreshHQ() {
  try {
    // Critical path first — don't wait on slow health/printers to paint the roster.
    const [st, dev, tr] = await Promise.all([
      api('/api/status', { timeoutMs: 12000 }),
      api('/api/devices', { timeoutMs: 12000 }),
      api('/api/transfers', { timeoutMs: 12000 }),
    ]);
    if ($('#hq-uptime')) $('#hq-uptime').textContent = st.uptime_h || '—';
    const disk = st.disk_transfert || st.disk_d || {};
    if ($('#hq-disk')) $('#hq-disk').textContent = (disk.free_h || '?') + ' libre / ' + (disk.total_h || '?');
    if ($('#hq-host')) $('#hq-host').textContent = st.hostname || '—';
    if ($('#hq-max')) $('#hq-max').textContent = st.max_upload_h || '—';
    const chip = $('#status-chip');
    if (chip) {
      const free = disk.free_h || '';
      chip.textContent = free ? ('● ' + free + ' libres') : '● État';
    }
    renderDevices(dev.devices || []);
    renderTransfers(tr.transfers || []);
    favoritesCache = st.favorites || favoritesCache || [];
    renderFavorites();
    renderCustomActions(st.actions || []);
    renderScenes(st.scenes || []);
    renderLauncher(st.actions || []);
    renderTerminalCmds(st.terminal_commands || []);
    fillShellTargets(st.shell_targets || []);
    fillSendTargets(dev.devices || []);
  } catch (e) {
    if ($('#hq-dev-count')) $('#hq-dev-count').textContent = '!';
    const el = $('#hq-devices');
    if (el && /Chargement/.test(el.textContent || '')) {
      el.innerHTML = `<li class="hint">Erreur HQ: ${escapeHtml(e.message || 'réseau')}</li>`;
    }
  }
  // Secondary — best effort, never blocks first paint
  try {
    const [fav, act, al, med, health, q] = await Promise.all([
      api('/api/favorites', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/activity', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/alerts', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/media/recent', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/health', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/queue', { timeoutMs: 10000 }).catch(() => ({})),
    ]);
    if (fav.favorites) { favoritesCache = fav.favorites; renderFavorites(); }
    if ($('#hq-health') && health && health.hostname) {
      const smb = health.smb_transfert?.ok ? 'SMB OK' : 'SMB off';
      const ts = health.tailscale?.ok ? 'Tailscale OK' : 'Tailscale off';
      $('#hq-health').textContent = ts + ' · ' + smb + (health.backup && health.backup.auto_paused ? ' · Backup auto en pause' : '');
    }
    renderActivity(act.activity || []);
    renderAlerts(al.alerts || []);
    renderMedia(med.items || []);
    renderQueue(q.queue || []);
    if ($('#home-chart')) await renderHomeChart();
    await loadKanban();
    await loadPrinters();
    renderOfflineQueue();
    await pollInbox();
    const me = await api('/api/me', { timeoutMs: 8000 }).catch(() => null);
    if (me && $('#hq-role')) $('#hq-role').textContent = (me.user || '') + ' · ' + (me.role || '');
    hqApplySessionRole(me);
  } catch (_) {}
}"""

new_refresh = """async function refreshHQ(scope = 'all') {
  const view = document.body.dataset.view || 'accueil';
  if (scope === 'status' || scope === 'roster' || scope !== 'secondary') {
    try {
      const [st, dev, tr] = await Promise.all([
        api('/api/status', { timeoutMs: 12000 }),
        api('/api/devices', { timeoutMs: 12000 }),
        api('/api/transfers', { timeoutMs: 12000 }),
      ]);
      if ($('#hq-uptime')) $('#hq-uptime').textContent = st.uptime_h || '—';
      const disk = st.disk_transfert || st.disk_d || {};
      if ($('#hq-disk')) $('#hq-disk').textContent = (disk.free_h || '?') + ' libre / ' + (disk.total_h || '?');
      if ($('#hq-host')) $('#hq-host').textContent = st.hostname || '—';
      if ($('#hq-max')) $('#hq-max').textContent = st.max_upload_h || '—';
      const chip = $('#status-chip');
      if (chip) {
        const free = disk.free_h || '';
        chip.textContent = free ? ('● ' + free + ' libres') : '● État';
      }
      renderDevices(dev.devices || []);
      renderTransfers(tr.transfers || []);
      favoritesCache = st.favorites || favoritesCache || [];
      renderFavorites();
      renderCustomActions(st.actions || []);
      renderScenes(st.scenes || []);
      renderLauncher(st.actions || []);
      renderTerminalCmds(st.terminal_commands || []);
      fillShellTargets(st.shell_targets || []);
      fillSendTargets(dev.devices || []);
    } catch (e) {
      if ($('#hq-dev-count')) $('#hq-dev-count').textContent = '!';
      const el = $('#hq-devices');
      if (el && /Chargement/.test(el.textContent || '')) {
        el.innerHTML = `<li class="hint">Erreur HQ: ${escapeHtml(e.message || 'réseau')}</li>`;
      }
    }
  }
  if (scope === 'status' || scope === 'roster') return;
  // Secondary — best effort, never blocks first paint
  try {
    const [fav, act, al, med, health, q] = await Promise.all([
      api('/api/favorites', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/activity', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/alerts', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/media/recent', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/health', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/queue', { timeoutMs: 10000 }).catch(() => ({})),
    ]);
    if (fav.favorites) { favoritesCache = fav.favorites; renderFavorites(); }
    if ($('#hq-health') && health && health.hostname) {
      const smb = health.smb_transfert?.ok ? 'SMB OK' : 'SMB off';
      const ts = health.tailscale?.ok ? 'Tailscale OK' : 'Tailscale off';
      $('#hq-health').textContent = ts + ' · ' + smb + (health.backup && health.backup.auto_paused ? ' · Backup auto en pause' : '');
    }
    renderActivity(act.activity || []);
    renderAlerts(al.alerts || []);
    renderMedia(med.items || []);
    renderQueue(q.queue || []);
    if (view === 'accueil') {
      if ($('#home-chart')) await renderHomeChart();
      await loadKanban();
      await loadPrinters();
      renderOfflineQueue();
    } else if (view === 'fichiers') {
      // scoped files view
    } else if (view === 'ops') {
      renderOfflineQueue();
    }
  } catch (_) {}
}"""

assert old_refresh in content, "old_refresh not found"
content = content.replace(old_refresh, new_refresh)

# 3. Add staggered scheduler and replace hqTimer = setInterval
poll_block = """let hqPollActive = false;
let hqPollTimer = null;
function hqSchedulePoll(ms = 350) {
  if (hqPollTimer) clearTimeout(hqPollTimer);
  hqPollTimer = setTimeout(hqPollTick, ms);
}
const hqPollTasks = [
  { id: 'presence', intervalMs: 8000, nextAt: 0, run: async () => { beatPresence(); } },
  { id: 'status', intervalMs: 8000, views: ['accueil', 'ops'], nextAt: 0, run: async () => { await refreshHQ('status'); } },
  { id: 'roster', intervalMs: 12000, views: ['accueil', 'fichiers', 'ops'], nextAt: 0, run: async () => { await refreshHQ('roster'); } },
  { id: 'secondary', intervalMs: 20000, views: ['accueil', 'ops'], nextAt: 0, run: async () => { await refreshHQ('secondary'); } },
  { id: 'inbox', intervalMs: 15000, nextAt: 0, run: async () => { await pollInbox(); } },
  { id: 'me', intervalMs: 30000, nextAt: 0, run: async () => {
    const me = await api('/api/me', { timeoutMs: 8000 }).catch(() => null);
    if (me && $('#hq-role')) $('#hq-role').textContent = (me.user || '') + ' · ' + (me.role || '');
    hqApplySessionRole(me);
  }},
  { id: 'scratchpad', intervalMs: 10000, views: ['accueil', 'ops'], nextAt: 0, run: async () => { loadScratchpad(); } },
];
async function hqPollTick() {
  if (document.hidden) { hqSchedulePoll(1000); return; }
  if (hqPollActive) { hqSchedulePoll(350); return; }
  hqPollActive = true;
  const now = Date.now();
  const currentView = document.body.dataset.view || 'accueil';
  try {
    for (const task of hqPollTasks) {
      if (task.views && !task.views.includes(currentView)) continue;
      if (now >= (task.nextAt || 0)) {
        task.nextAt = now + task.intervalMs;
        try { await task.run(); } catch (_) {}
        break;
      }
    }
  } finally {
    hqPollActive = false;
    hqSchedulePoll(350);
  }
}
function hqStartPollScheduler() {
  hqSchedulePoll(350);
}
"""

old_timer = """  hqTimer = setInterval(() => {
    if (document.hidden) return;
    beatPresence();
    refreshHQ();
    loadScratchpad();
  }, 8000);"""

new_timer = """  hqStartPollScheduler();"""

assert old_timer in content, "old_timer not found"
content = content.replace(old_timer, new_timer)

# Insert poll_block before setupRecentsFilters
anchor_setup = "function setupRecentsFilters() {"
assert anchor_setup in content, "anchor_setup not found"
content = content.replace(anchor_setup, poll_block + "\n" + anchor_setup)

if crlf:
    content = content.replace("\n", "\r\n")

bridge_path.write_text(content, encoding="utf-8")
print("Frontend dedupe and scheduler patch applied.")
